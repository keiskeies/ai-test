"""后台任务编排：SETNX 锁 → 建 run → 落 USER → create_task(runner)。"""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.eventbus import get_bus
from app.core.security import dec_key
from app.modules.agent import store
from app.modules.agent.dispatcher import ToolDispatcher
from app.modules.agent.gateway import FakeGateway, build_gateway
from app.modules.agent.models import AgentApproval, AgentRun, AgentSession
from app.modules.model_cfg.models import ModelConfig

_tasks: dict[str, asyncio.Task] = {}
_gateway_factory: Any = None

LOCK_TTL = 900


def set_gateway_factory(fn: Any) -> None:
    """测试注入口：fn(cfg) -> gateway；None 还原 build_gateway。"""
    global _gateway_factory
    _gateway_factory = fn


def lock_key(session_id: str) -> str:
    return "agent.lock." + session_id


async def has_active_run(db: AsyncSession, session_id: str) -> bool:
    n = (
        await db.execute(
            select(func.count()).select_from(AgentRun).where(
                AgentRun.session_id == session_id, AgentRun.status.in_(["RUNNING", "WAIT_APPROVAL"]))
        )
    ).scalar_one()
    return n > 0


async def accept_message(db: AsyncSession, session_id: str, content: str) -> str:
    """POST messages 的原子序：锁 → 忙查 → 建 run → 落 USER → 起任务。返回 run_id。"""
    if not await get_bus().lock(lock_key(session_id), ttl=LOCK_TTL):
        raise Busy()
    try:
        if await has_active_run(db, session_id):
            raise Busy()
        cur = (await db.execute(
            select(func.max(AgentRun.seq)).where(AgentRun.session_id == session_id))).scalar_one_or_none()
        run = AgentRun(session_id=session_id, seq=int(cur or 0) + 1, status="RUNNING")
        db.add(run)
        await db.commit()
        await store.append_event(db, session_id, run.id, "USER", {"text": content})
        task = asyncio.create_task(_execute(session_id, run.id))
        _tasks[session_id] = task
        return run.id
    except BaseException:
        await get_bus().unlock(lock_key(session_id))
        raise


class Busy(Exception):
    pass


class ApprovalConflict(Exception):
    """审批回传的冲突（D263）：带上 HTTP 状态与稳定 code，由路由原样翻译成 ApiError。"""

    def __init__(self, code: str, message: str, status: int = 409,
                 details: dict[str, Any] | None = None) -> None:
        self.code = code
        self.status = status
        self.details = details or {}
        super().__init__(message)


class RunSetupError(Exception):
    """本 run 不具备起跑条件（无可用模型 / 模型不支持工具）。"""


async def _prepare_runner(s: AsyncSession, sess: AgentSession) -> Any:
    """模型与工具能力检查 → 建 runner。_execute 与 _resume 共用同一条起跑线。"""
    cfg = await resolve_model(s, sess)
    if cfg is None:
        raise RunSetupError("未配置可用的对话模型")
    # §9.6 `:588`「tools 不支持 → 该模型禁用于操作类会话」：此前 gateway 静默
    # 丢工具（`gateway.py:110` `if tools and model.supports_tools`）继续跑，
    # 用户以为在用工具、模型其实一个都没拿到。宁可不跑，也不演「能操作」。
    if not cfg.supports_tools:
        raise RunSetupError(f"模型「{cfg.name}」未开启工具能力，不能用于会话")
    gw = _gateway_factory(cfg) if _gateway_factory else build_gateway(cfg)
    if type(gw) is FakeGateway:  # 测试子类（捕获 tools 等）原样保留
        gw = FakeGateway(cfg.base_url, project_id=sess.project_id)
    from app.modules.agent.runner import AgentRunner

    return AgentRunner(gateway=gw, dispatcher=ToolDispatcher(s), model=cfg,
                       api_key=dec_key(cfg.api_key_enc) if cfg.api_key_enc else "")


async def _fail_run(s: AsyncSession, session_id: str, run_id: str, message: str) -> None:
    run = (await s.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one()
    run.status = "ERROR"
    run.error = message
    await store.append_event(s, session_id, run_id, "ERROR", {"message": message})
    await store.append_event(s, session_id, run_id, "RUN_END", {"status": "ERROR"})
    await s.commit()


async def _execute(session_id: str, run_id: str) -> None:
    try:
        async with get_sessionmaker()() as s:
            sess = (await s.execute(select(AgentSession).where(AgentSession.id == session_id))).scalar_one()
            try:
                runner = await _prepare_runner(s, sess)
            except RunSetupError as e:
                await _fail_run(s, session_id, run_id, str(e))
                return
            await runner.run_turn(session_id, run_id=run_id)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        logging.getLogger("testpilot.agent").exception("agent run crashed session=%s run=%s", session_id, run_id)
    finally:
        _tasks.pop(session_id, None)
        try:
            await get_bus().unlock(lock_key(session_id))
        except Exception:  # pragma: no cover
            pass


async def decide_approval(
    db: AsyncSession, *, session_id: str, run_id: str, tool_call_id: str,
    decision: str, comment: str | None,
) -> str:
    """落审批决策并异步续推（D263）。返回 run_id。

    决策与 APPROVAL_DECISION 事件同一次 commit 落库：前端回放时「批准过」与
    「审批卡变只读」必须同时成立，不能出现「已批准但事件流里查无此事」。
    检查在 SETNX 锁内做第二遍——两个标签页同时点「批准」时，只有先到的那个能写。
    """
    if not await get_bus().lock(lock_key(session_id), ttl=LOCK_TTL):
        raise Busy()
    try:
        run = (await db.execute(
            select(AgentRun).where(AgentRun.id == run_id, AgentRun.session_id == session_id)
        )).scalar_one_or_none()
        if run is None:
            raise ApprovalConflict("not_found", "运行不存在", 404, {"run_id": run_id})
        ap = (await db.execute(
            select(AgentApproval).where(AgentApproval.run_id == run_id,
                                        AgentApproval.tool_call_id == tool_call_id)
            .order_by(AgentApproval.id.desc())
        )).scalars().first()
        if ap is None:
            raise ApprovalConflict("not_found", "审批请求不存在", 404,
                                   {"tool_call_id": tool_call_id})
        if ap.decision is not None:
            raise ApprovalConflict("already_decided", "该审批已处理", 409,
                                   {"decision": ap.decision})
        if run.status != "WAIT_APPROVAL":
            raise ApprovalConflict("run_not_waiting", "本轮不在等待审批", 409,
                                   {"status": run.status})
        ap.decision = decision
        ap.comment = comment
        ap.decided_at = datetime.now(UTC)
        # 续推前先把 run 拉回 RUNNING：此时起 accept_message 的忙判定照常生效，
        # 不会有人在续推途中又塞进一条新消息。
        run.status = "RUNNING"
        await store.append_event(db, session_id, run.id, "APPROVAL_DECISION", {
            "run_id": run.id, "tool_call_id": ap.tool_call_id, "tool_name": ap.tool_name,
            "decision": decision, "comment": comment,
        })
        await db.commit()
        task = asyncio.create_task(_resume(session_id, run.id, ap.id))
        _tasks[session_id] = task
        return run.id
    except BaseException:
        await get_bus().unlock(lock_key(session_id))
        raise


async def _resume(session_id: str, run_id: str, approval_id: str) -> None:
    try:
        async with get_sessionmaker()() as s:
            sess = (await s.execute(select(AgentSession).where(AgentSession.id == session_id))).scalar_one()
            approval = await s.get(AgentApproval, approval_id)
            if approval is None:  # pragma: no cover —— 刚提交的行不会被并发删掉
                await _fail_run(s, session_id, run_id, "审批记录不见了，无法续推")
                return
            try:
                runner = await _prepare_runner(s, sess)
            except RunSetupError as e:
                await _fail_run(s, session_id, run_id, str(e))
                return
            await runner.resume_turn(session_id, run_id=run_id, approval=approval)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        logging.getLogger("testpilot.agent").exception(
            "agent resume crashed session=%s run=%s", session_id, run_id)
    finally:
        _tasks.pop(session_id, None)
        try:
            await get_bus().unlock(lock_key(session_id))
        except Exception:  # pragma: no cover
            pass


async def resolve_model(db: AsyncSession, sess: AgentSession) -> ModelConfig | None:
    if sess.model_id:
        cfg = await db.get(ModelConfig, sess.model_id)
        if cfg is not None and cfg.enabled:
            return cfg
    return (
        await db.execute(select(ModelConfig).where(ModelConfig.model_type == "CHAT",
                                                    ModelConfig.is_default.is_(True),
                                                    ModelConfig.enabled.is_(True)))
    ).scalar_one_or_none()


def cancel_task(session_id: str) -> bool:
    t = _tasks.get(session_id)
    if t is not None and not t.done():
        t.cancel()
        return True
    return False
