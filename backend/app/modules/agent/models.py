"""Agent 域模型（§4.10）：session / run / message(append-only) / approval。"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, BigInteger, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UtcDateTime, new_id


def _now() -> datetime:
    return datetime.now(UTC)


class AgentSession(Base):
    __tablename__ = "agent_session"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="新会话")
    mode: Mapped[str] = mapped_column(String(8), nullable=False, default="ASK")  # PLAN/ASK/FULL
    model_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    thinking: Mapped[str] = mapped_column(String(8), nullable=False, default="medium")  # off/low/medium/high
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")  # active/archived
    # UtcDateTime 而非裸 DateTime：列存 UTC naive，读回必须 attach tzinfo，
    # 否则 isoformat() 出不带偏移的裸串（全平台只有这四列这样）。前端 timefmt
    # 靠「无偏移按 UTC」的兜底才没显示成早 8 小时——正确性不该压在一个前端正则上。
    # 与 TimestampMixin（core/db.py）同一口径；impl 就是 DateTime，**DB 类型不变**。
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False, default=_now,
                                                 server_default=func.now())


class AgentRun(Base):
    __tablename__ = "agent_run"
    __table_args__ = (UniqueConstraint("session_id", "seq", name="uq_agent_run_seq"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)  # 会话内第几轮
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="RUNNING")
    # RUNNING/WAIT_APPROVAL/DONE/CANCELLED/ERROR
    lease_owner: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False, default=_now,
                                                 server_default=func.now())


class AgentMessage(Base):
    """append-only 事件流：永不 UPDATE/DELETE（§9.9b）。seq 会话内单调，是续传真相。"""

    __tablename__ = "agent_message"
    __table_args__ = (UniqueConstraint("session_id", "seq", name="uq_agent_message_seq"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    type: Mapped[str] = mapped_column(String(24), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False, default=_now,
                                                 server_default=func.now())


class AgentApproval(Base):
    __tablename__ = "agent_approval"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    tool_call_id: Mapped[str] = mapped_column(String(64), nullable=False)
    tool_name: Mapped[str] = mapped_column(String(100), nullable=False)
    args: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # once=仅放行本次 / session=本会话该工具免再批 / deny=拒绝 / NULL=待批（D263 审批门）
    decision: Mapped[str | None] = mapped_column(String(16), nullable=True)
    comment: Mapped[str | None] = mapped_column(String(500), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
