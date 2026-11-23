"""Agent REST/SSE API（§12.3）。

产品决策（ledger R18）：会话与消息仅要求项目成员（不另设权限位）——
Agent 的写能力完全由工具门把守，READONLY 成员只能触发只读工具（§9.4 可见性过滤）。
D102 修正这条口径对 FULL 的适用面：FULL 是全仓唯一「什么都不拦」的档（PLAN 在
dispatcher 挡写，ASK 抛 NeedApproval 而无 approve 端点 = 永远挂起，第二十八轮更正 ②/D166），
所以选 FULL == 要写能力，必须过角色位 agent:full:use，不能再按「仅项目成员」放行。
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.permissions import match_perm
from app.core.service import ServiceCtx, resolve_project_perms
from app.core.sse import sse_response
from app.modules.agent import store, tasks
from app.modules.agent.deps import get_agent_ctx
from app.modules.agent.models import AgentRun, AgentSession

router = APIRouter(tags=["agent"])

# D102 角色级模式门（§11.4.35）：FULL 位的注册与 metatools 的 META_READ_PERM 同法——
# 位常量住本模块（agent 域自己拥有它），进 REGISTRY.perm_points() 后由 iam 的
# registry_sync 在 bootstrap 幂等同步入 perm_point 表（零迁移）。
FULL_MODE_PERM = "agent:full:use"


def _register_full_mode_perm() -> None:
    """把 agent:full:use 挂进 REGISTRY，只吃它的「权限点」那一路（§15 纪律 7）。

    全仓权限位进注册表只有 ToolSpec 这一张票（perm_points() 从注册表投影），所以这一位
    也是注册出来的：http=None（无 HTTP 面，build_router 天然挡掉）+ tool=False（不是
    Agent 工具，list_tools 不收，模型永远看不到它）——两路都不要，剩下的正是它唯一要的
    那一路：perm_point 入库 + role_perm_tree 出树（角色编辑页从此能勾它）。
    形状先例是 metatools/spec.py 的手写注册（1F 取证 ④「五路中要几路注册几路」）。
    名字唯一性靠 REGISTRY.register 查重兜底（撞名红在启动）。
    """
    from app.core.registry import REGISTRY, ToolSpec

    class _FullModePermIn(BaseModel):
        """占位输入模型：本注册只投影权限位，永不按此模型派发（http=None + tool=False）。"""

    async def _never_called(payload: BaseModel, ctx: ServiceCtx) -> dict:  # pragma: no cover
        raise NotImplementedError("agent:full:use 的注册只投影权限位，没有可执行体")

    REGISTRY.register(ToolSpec(
        name="agent_full_mode_perm", description="FULL 模式角色位（注册即入库，无可执行体）",
        json_schema=_FullModePermIn.model_json_schema(), perm=FULL_MODE_PERM, effect="read",
        handler=_never_called, model=_FullModePermIn, tool=False, resident=False, http=None,
    ))


_register_full_mode_perm()


class SessionIn(BaseModel):
    project_id: str
    model_id: str | None = None
    thinking: Literal["off", "low", "medium", "high"] = "medium"
    mode: Literal["PLAN", "ASK", "FULL"] = "ASK"


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=20000)


class InterruptIn(BaseModel):
    run_id: str


class ApprovalIn(BaseModel):
    """D263 审批回传（§12.2 `:1571`）：只决定放不放行，不代替执行者扩权。

    decision 三档：once=仅本次 / session=本会话该工具免再批 / deny=拒绝。
    """

    tool_call_id: str = Field(min_length=1, max_length=64)
    decision: Literal["once", "session", "deny"]
    comment: str | None = Field(default=None, max_length=500)


def _sess_out(s: AgentSession) -> dict:
    return {"id": s.id, "project_id": s.project_id, "user_id": s.user_id, "title": s.title,
            "mode": s.mode, "model_id": s.model_id, "thinking": s.thinking,
            "status": s.status, "created_at": s.created_at.isoformat() if s.created_at else None}


async def _load_session(db: AsyncSession, ctx: ServiceCtx, session_id: str) -> AgentSession:
    """不存在与无权限同响应（403 forbidden，不泄露存在性）。"""
    s = await _fetch(db, session_id)
    if s is None or not await _visible(ctx, s.project_id):
        raise ApiError("forbidden", "无此项目权限", 403)
    return s


async def _fetch(db: AsyncSession, session_id: str) -> AgentSession | None:
    from sqlalchemy import select

    return (await db.execute(select(AgentSession).where(AgentSession.id == session_id))).scalar_one_or_none()


async def _visible(ctx: ServiceCtx, project_id: str) -> bool:
    perms = await resolve_project_perms(ctx.db, ctx.user_id, ctx.is_system_admin, project_id)
    return perms is not None


@router.get("/agent/tools")
async def list_agent_tools(project_id: str = Query(...), ctx: ServiceCtx = Depends(get_agent_ctx)) -> dict:
    """工具元数据（§12.3 试验台）：与 Agent 可见性同一过滤器，READONLY 成员不见写工具。"""
    from app.core.registry import REGISTRY

    perms = await resolve_project_perms(ctx.db, ctx.user_id, ctx.is_system_admin, project_id)
    if perms is None:
        raise ApiError("forbidden", "无此项目权限", 403)
    items = [{"name": t.name, "description": t.description, "effect": t.effect, "perm": t.perm}
             for t in REGISTRY.list_tools(perms)]
    # D265：MCP 工具同样是「Agent 可见工具」的一部分；没有治理位时该函数返回 []。
    from app.modules.mcp import client as mcp_client

    items += await mcp_client.tool_declarations(ctx.db, perms)
    return {"items": items}


@router.post("/agent/sessions", status_code=201)
async def create_session(body: SessionIn, ctx: ServiceCtx = Depends(get_agent_ctx)) -> dict:
    from sqlalchemy import select

    from app.modules.model_cfg.models import ModelConfig

    # 建会话是项目动作：此前唯一没把门的路线（其余端点全走 _load_session）。
    # resolver 对「项目不存在」与「非成员」一律 None → 同 403，不泄露存在性。
    perms = await resolve_project_perms(ctx.db, ctx.user_id, ctx.is_system_admin, body.project_id)
    if perms is None:
        raise ApiError("forbidden", "无此项目权限", 403)

    # D102 角色级模式门：FULL 是全仓唯一能干活的档（见模块 docstring），要它先过位。
    # 与既有手写 403 同形（code=forbidden，不泄露位名以外的信息）；位名进 details.perm，
    # 与 ServiceCtx.require 的 D38 契约字段同款。PLAN/ASK 不设位——门只拦 FULL。
    if body.mode == "FULL" and not match_perm(perms, FULL_MODE_PERM):
        raise ApiError("forbidden", "无此项目权限", 403, {"perm": FULL_MODE_PERM})

    model_id = body.model_id
    if model_id is None:
        cfg = (await ctx.db.execute(
            select(ModelConfig).where(ModelConfig.model_type == "CHAT",
                                       ModelConfig.is_default.is_(True), ModelConfig.enabled.is_(True))
        )).scalar_one_or_none()
        if cfg is None:
            raise ApiError("validation_failed", "尚未配置默认对话模型，请先在模型配置中心添加", 422)
        model_id = cfg.id
    s = AgentSession(project_id=body.project_id, user_id=ctx.user_id, model_id=model_id,
                     thinking=body.thinking, mode=body.mode)
    ctx.db.add(s)
    await ctx.db.commit()
    return _sess_out(s)


@router.post("/agent/sessions/{session_id}/messages", status_code=202)
async def post_message(session_id: str, body: MessageIn, ctx: ServiceCtx = Depends(get_agent_ctx)) -> dict:
    await _load_session(ctx.db, ctx, session_id)
    try:
        run_id = await tasks.accept_message(ctx.db, session_id, body.content)
    except tasks.Busy:
        raise ApiError("session_busy", "该会话有正在进行的任务，请等待完成或先中断", 409,
                       {"session_id": session_id}) from None
    return {"run_id": run_id}


@router.post("/agent/sessions/{session_id}/interrupt")
async def interrupt(session_id: str, body: InterruptIn, ctx: ServiceCtx = Depends(get_agent_ctx)) -> dict:
    from sqlalchemy import select

    sess = await _load_session(ctx.db, ctx, session_id)
    run = (await ctx.db.execute(
        select(AgentRun).where(AgentRun.id == body.run_id, AgentRun.session_id == session_id)
    )).scalar_one_or_none()
    if run is None:
        raise ApiError("not_found", "运行不存在", 404, {"run_id": body.run_id})
    if run.status in ("RUNNING", "WAIT_APPROVAL"):
        run.status = "CANCELLED"
        await ctx.db.commit()
        await store.append_event(ctx.db, sess.id, run.id, "ERROR", {"reason": "interrupted"})
        await store.append_event(ctx.db, sess.id, run.id, "RUN_END", {"status": "CANCELLED"})
        tasks.cancel_task(session_id)
    return {"ok": True, "run_id": run.id, "status": run.status}


@router.post("/agent/runs/{run_id}/approval", status_code=202)
async def decide_run_approval(run_id: str, body: ApprovalIn,
                              ctx: ServiceCtx = Depends(get_agent_ctx)) -> dict:
    """审批回传 → 落决策 + 异步续推（§12.3/§12.2 `:1571`）。

    鉴权分两层，缺一不可：
    1) 能看见会话（项目成员，`_load_session`，与其余端点字节一致）；
    2) 能代表这条会话做决定——会话是私有工作区，只有所有者或系统管理员能点。
       审批**不放宽**工具自身的权限位：续推仍以会话所有者的 perms 走 dispatcher，
       换个人来点「批准」不会让本该 403 的写工具变得能执行。
    """
    from sqlalchemy import select

    run = (await ctx.db.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one_or_none()
    if run is None:
        raise ApiError("not_found", "运行不存在", 404, {"run_id": run_id})
    sess = await _load_session(ctx.db, ctx, run.session_id)
    if sess.user_id != ctx.user_id and not ctx.is_system_admin:
        raise ApiError("forbidden", "无此项目权限", 403)
    try:
        await tasks.decide_approval(
            ctx.db, session_id=sess.id, run_id=run.id, tool_call_id=body.tool_call_id,
            decision=body.decision, comment=body.comment,
        )
    except tasks.Busy:
        raise ApiError("session_busy", "该会话有正在进行的任务，请等待完成或先中断", 409,
                       {"session_id": sess.id}) from None
    except tasks.ApprovalConflict as e:
        raise ApiError(e.code, str(e), e.status, e.details) from None
    return {"ok": True, "run_id": run.id, "decision": body.decision}


@router.get("/agent/sessions/{session_id}/messages")
async def get_messages(session_id: str, cursor: int = Query(default=0, ge=0),
                       size: int = Query(default=200, ge=1, le=500),
                       ctx: ServiceCtx = Depends(get_agent_ctx)) -> dict:
    await _load_session(ctx.db, ctx, session_id)
    envs = await store.replay(ctx.db, session_id, cursor)
    items = envs[:size]
    nxt = str(items[-1]["seq"]) if len(envs) > size and items else None
    return {"items": items, "next_cursor": nxt}


async def build_agent_sse(db: AsyncSession, request: Request, session_id: str,
                          cursor: int | None) -> StreamingResponse:
    # 建流前换读快照（D11，与 scenario 的 build_run_sse 同一条理由）：_load_session 的 SELECT
    # 已在 REPEATABLE-READ 下钉住旧快照，重放沿用就看不见其后 commit 的消息。放这里而非
    # store.replay 里：那条函数也服务 REST 路，回滚会丢掉调用方未提交的写。
    await db.rollback()
    return sse_response(request, "agent." + session_id,
                        lambda cur: store.replay(db, session_id, cur), cursor)


@router.get("/events/agent/{session_id}")
async def events(session_id: str, request: Request, cursor: int | None = Query(default=None),
                 ctx: ServiceCtx = Depends(get_agent_ctx)):
    await _load_session(ctx.db, ctx, session_id)
    return await build_agent_sse(ctx.db, request, session_id, cursor)
