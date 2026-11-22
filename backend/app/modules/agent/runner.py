"""ReAct Runner：假模型/真模型同一循环（§9.2/§9.3）。

要点：
- delta 段聚合：连续 thinking/text 各合并为一条 THINKING/TEXT 事件（防洪）；
- 同轮多 tool_call 顺序执行；校验失败 ok=False 回注模型自纠【RF3】；
- NeedApproval → APPROVAL_REQ + run=WAIT_APPROVAL 挂起返回；
- 无 tool_call 的流 → DONE；每轮 USAGE。
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.registry import REGISTRY
from app.core.service import ServiceCtx, resolve_project_perms
from app.modules.agent import store
from app.modules.agent.dispatcher import NeedApproval, ToolDispatcher, norm_mode
from app.modules.agent.gateway import FakeGateway  # noqa: F401  (类型提示用)
from app.modules.agent.models import AgentApproval, AgentMessage, AgentRun, AgentSession

SYSTEM_PROMPT = (
    "你是 TestPilot 的测试工程师助手。你可以调用注册的工具来查询、创建与维护测试资产。"
    "调用工具前先用一句话说明你要做什么；参数不确定时先用只读工具确认，不要臆造。"
    "全部回复使用中文。"
)


class AgentRunner:
    def __init__(self, *, gateway: Any, dispatcher: ToolDispatcher, max_iterations: int = 12,
                 model: Any = None, api_key: str = "") -> None:
        self.gateway = gateway
        self.dispatcher = dispatcher
        self.max_iterations = max_iterations
        self.model = model
        self.api_key = api_key

    async def run_turn(self, session_id: str, run_id: str | None = None) -> None:
        db = self.dispatcher.db
        sess = (await db.execute(select(AgentSession).where(AgentSession.id == session_id))).scalar_one()
        if run_id is not None:  # 复用 accept_message 已建的 run
            run = (await db.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one()
        else:
            cur_seq = (await db.execute(
                select(func.max(AgentRun.seq)).where(AgentRun.session_id == session_id))).scalar_one_or_none()
            run = AgentRun(session_id=session_id, seq=int(cur_seq or 0) + 1, status="RUNNING")
            db.add(run)
            await db.commit()
        try:
            suspended = await self._loop(db, sess, run)
            run.status = "WAIT_APPROVAL" if suspended else "DONE"
        except Exception as e:  # noqa: BLE001
            run.status = "ERROR"
            run.error = str(e)[:500]
            await store.append_event(db, session_id, run.id, "ERROR", {"message": str(e)[:500]})
        # 轮次必须有终态事件：前端据此停止"进行中"指示（RUNNING→DONE/ERROR/WAIT_APPROVAL 均落）
        await store.append_event(db, session_id, run.id, "RUN_END", {"status": run.status})
        await db.commit()

    async def _loop(self, db: AsyncSession, sess: AgentSession, run: AgentRun) -> bool:
        """返回 True 表示因等待审批而挂起。"""
        ctx = await build_agent_ctx(db, sess)
        grants = await approved_grants(db, sess.id)
        tools = tool_schemas(ctx.perms)
        msgs = await build_messages(db, sess.id)
        mode = norm_mode(sess.mode)

        for _ in range(self.max_iterations):
            had_tool = False
            think: list[str] = []
            text: list[str] = []

            async def flush_think(buf: list[str]) -> None:
                if buf:
                    await store.append_event(db, sess.id, run.id, "THINKING", {"text": "".join(buf)})
                    buf.clear()

            async def flush_text(buf: list[str]) -> None:
                if buf:
                    joined = "".join(buf)
                    await store.append_event(db, sess.id, run.id, "TEXT", {"text": joined})
                    msgs.append({"role": "assistant", "content": joined})
                    buf.clear()

            async for ev in self.gateway.stream(messages=msgs, tools=tools, model=self.model,
                                                thinking=sess.thinking, api_key=self.api_key):
                t = ev.get("type")
                if t == "thinking_delta":
                    if text:
                        await flush_text(text)
                    think.append(str(ev.get("text", "")))
                elif t == "text_delta":
                    if think:
                        await flush_think(think)
                    text.append(str(ev.get("text", "")))
                elif t == "tool_call":
                    if think:
                        await flush_think(think)
                    await flush_text(text)
                    tc_id = str(ev.get("id") or ("call_" + str(len(msgs))))
                    name = str(ev.get("name") or "")
                    args = ev.get("args") or {}
                    await store.append_event(db, sess.id, run.id, "TOOL_CALL",
                                             {"tool_call_id": tc_id, "tool_name": name, "args": args})
                    msgs.append({"role": "assistant", "content": None, "tool_calls": [{
                        "id": tc_id, "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]})
                    try:
                        res = await self.dispatcher.call(name, args, ctx, mode=mode, grants=grants, tool_call_id=tc_id)
                    except NeedApproval as na:
                        # tool_args（不是 args）：args 是 BaseException 的保留属性，
                        # 详见 dispatcher.NeedApproval 的注释——用 args 会把「等待审批」
                        # 这句话当成工具参数落库，审批卡上看不见真正要执行的内容。
                        await store.append_event(db, sess.id, run.id, "APPROVAL_REQ", {
                            "tool_call_id": na.tool_call_id, "tool_name": na.tool_name, "args": na.tool_args})
                        db.add(AgentApproval(run_id=run.id, tool_call_id=na.tool_call_id,
                                             tool_name=na.tool_name, args=na.tool_args))
                        await db.commit()
                        return True
                    payload: dict[str, Any] = {"tool_call_id": tc_id, "tool_name": name, "ok": res.ok}
                    # R148：ui 随事件载荷原样走（§12.2 :1570 信封 payload.ui ∈
                    # {null,"card","approval","diff"}）——REST 重放与 SSE 读同一事件，
                    # 卡片透传免费覆盖断线重连/历史回放，不另开第二条通道。
                    payload["ui"] = res.ui
                    if res.ok:
                        payload["content"] = _json_safe(res.content)
                        if res.produced:
                            payload["produced"] = res.produced
                    else:
                        payload["error"] = res.error
                    await store.append_event(db, sess.id, run.id, "TOOL_RESULT", payload)
                    msgs.append({"role": "tool", "tool_call_id": tc_id,
                                 "content": json.dumps(_json_safe(payload), ensure_ascii=False)})
                    had_tool = True
                elif t == "usage":
                    if think:
                        await flush_think(think)
                    await flush_text(text)
                    await store.append_event(db, sess.id, run.id, "USAGE", {
                        "input_tokens": ev.get("input_tokens", 0), "output_tokens": ev.get("output_tokens", 0)})
                # done：仅收尾
            if think:
                await flush_think(think)
            await flush_text(text)
            if not had_tool:
                return False
        raise RuntimeError("超过最大迭代次数（" + str(self.max_iterations) + "），已停止以防失控")


async def build_agent_ctx(db: AsyncSession, sess: AgentSession) -> ServiceCtx:
    from app.modules.iam.models import User  # agent 是编排层：可读 IAM（不属五业务模块独立性契约）

    user = await db.get(User, sess.user_id)
    is_admin = bool(user and user.is_system_admin)
    perms = await resolve_project_perms(db, sess.user_id, is_admin, sess.project_id) or set()
    return ServiceCtx(entry="agent", user_id=sess.user_id, user_name=(user.name if user else ""),
                      is_system_admin=is_admin, perms=perms, db=db, session_id=sess.id)


async def approved_grants(db: AsyncSession, session_id: str) -> set[str]:
    """本会话历史已批准的写工具名（ASK 模式免再批）。"""
    rows = (
        await db.execute(
            select(AgentApproval.tool_name)
            .join(AgentRun, AgentRun.id == AgentApproval.run_id)
            .where(AgentRun.session_id == session_id, AgentApproval.decision == "approve")
            .distinct()
        )
    ).scalars().all()
    return set(rows)


def tool_schemas(perms: set[str]) -> list[dict]:
    return [{"name": t.name, "description": t.description, "parameters": t.json_schema}
            for t in REGISTRY.list_tools(perms)]


def _json_safe(v: Any) -> Any:
    try:
        json.dumps(v, ensure_ascii=False, default=str)
        return v
    except (TypeError, ValueError):
        return str(v)


async def build_messages(db: AsyncSession, session_id: str) -> list[dict]:
    """历史 = 库内事件重放（append-only 真相）；S0 固定 system 段。"""
    rows = (await db.execute(
        select(AgentMessage).where(AgentMessage.session_id == session_id).order_by(AgentMessage.seq)
    )).scalars().all()
    msgs: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in rows:
        p = m.payload or {}
        if m.type == "USER":
            msgs.append({"role": "user", "content": str(p.get("text", ""))})
        elif m.type == "TEXT":
            msgs.append({"role": "assistant", "content": str(p.get("text", ""))})
        elif m.type == "TOOL_CALL":
            msgs.append({"role": "assistant", "content": None, "tool_calls": [{
                "id": p.get("tool_call_id", ""), "type": "function",
                "function": {"name": p.get("tool_name", ""),
                             "arguments": json.dumps(p.get("args") or {}, ensure_ascii=False)}}]})
        elif m.type == "TOOL_RESULT":
            msgs.append({"role": "tool", "tool_call_id": p.get("tool_call_id", ""),
                         "content": json.dumps(_json_safe(p), ensure_ascii=False)})
    return msgs
