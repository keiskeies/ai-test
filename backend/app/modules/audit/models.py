"""审计日志模型（§4.9 S0 子集）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UtcDateTime, new_id


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    ts: Mapped[datetime] = mapped_column(UtcDateTime(), index=True, nullable=False)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    entry: Mapped[str] = mapped_column(String(16), nullable=False)  # http / agent / schedule
    action: Mapped[str] = mapped_column(String(128), nullable=False)  # service 名或 REST 动作
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    diff: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
