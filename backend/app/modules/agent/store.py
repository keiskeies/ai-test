"""append-only 事件存储：seq 分配（锁会话行）+ 即时发布（§9.9）。"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.eventbus import get_bus
from app.modules.agent.models import AgentMessage, AgentSession


def _now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


async def append_event(
    db: AsyncSession, session_id: str, run_id: str | None, type_: str, payload: dict
) -> AgentMessage:
    """seq = 会话内 max+1；SELECT ... FOR UPDATE 锁会话行防并发；提交后发布同信封。"""
    locked = (
        await db.execute(select(AgentSession.id).where(AgentSession.id == session_id).with_for_update())
    ).scalar_one_or_none()
    if locked is None:
        raise ValueError("agent_session 不存在: " + session_id)
    cur = (
        await db.execute(select(func.max(AgentMessage.seq)).where(AgentMessage.session_id == session_id))
    ).scalar_one_or_none()
    seq = int(cur or 0) + 1
    msg = AgentMessage(session_id=session_id, run_id=run_id, seq=seq, type=type_, payload=payload or {})
    db.add(msg)
    await db.commit()
    envelope = {"seq": seq, "ts": _now_iso(), "type": type_, "payload": payload or {}}
    await get_bus().publish("agent." + session_id, envelope)
    return msg


async def replay(db: AsyncSession, session_id: str, cursor: int) -> list[dict]:
    # 不在这里 rollback：本函数也服务 REST 路（get_messages 拿的是请求级 session），
    # 替调用方回滚会丢掉它尚未提交的写。SSE 侧要开新快照由 build_agent_sse 负责。
    rows = (
        await db.execute(
            select(AgentMessage)
            .where(AgentMessage.session_id == session_id, AgentMessage.seq > cursor)
            .order_by(AgentMessage.seq)
        )
    ).scalars().all()
    return [{"seq": m.seq, "ts": m.created_at.isoformat() if m.created_at else _now_iso(),
             "type": m.type, "payload": m.payload} for m in rows]
