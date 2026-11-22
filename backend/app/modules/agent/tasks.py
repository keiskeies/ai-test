"""后台任务编排：SETNX 锁 → 建 run → 落 USER → create_task(runner)。"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.eventbus import get_bus
from app.core.security import dec_key
from app.modules.agent import store
from app.modules.agent.dispatcher import ToolDispatcher
from app.modules.agent.gateway import FakeGateway, build_gateway
from app.modules.agent.models import AgentRun, AgentSession
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


async def _execute(session_id: str, run_id: str) -> None:
    try:
        async with get_sessionmaker()() as s:
            sess = (await s.execute(select(AgentSession).where(AgentSession.id == session_id))).scalar_one()
            cfg = await resolve_model(s, sess)
            if cfg is None:
                run = (await s.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one()
                run.status = "ERROR"
                run.error = "未配置可用的对话模型"
                await store.append_event(s, session_id, run_id, "ERROR", {"message": "未配置可用的对话模型"})
                await store.append_event(s, session_id, run_id, "RUN_END", {"status": "ERROR"})
                await s.commit()
                return
            # §9.6 `:588`「tools 不支持 → 该模型禁用于操作类会话」：此前 gateway 静默
            # 丢工具（`gateway.py:110` `if tools and model.supports_tools`）继续跑，
            # 用户以为在用工具、模型其实一个都没拿到。宁可不跑，也不演「能操作」。
            if not cfg.supports_tools:
                run = (await s.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one()
                run.status = "ERROR"
                run.error = f"模型「{cfg.name}」未开启工具能力，不能用于会话"
                await store.append_event(s, session_id, run_id, "ERROR", {"message": run.error})
                await store.append_event(s, session_id, run_id, "RUN_END", {"status": "ERROR"})
                await s.commit()
                return
            gw = _gateway_factory(cfg) if _gateway_factory else build_gateway(cfg)
            if type(gw) is FakeGateway:  # 测试子类（捕获 tools 等）原样保留
                gw = FakeGateway(cfg.base_url, project_id=sess.project_id)
            from app.modules.agent.runner import AgentRunner

            runner = AgentRunner(gateway=gw, dispatcher=ToolDispatcher(s), model=cfg,
                                 api_key=dec_key(cfg.api_key_enc) if cfg.api_key_enc else "")
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
