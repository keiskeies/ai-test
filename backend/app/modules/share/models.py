"""分享链接模型（D202）。

token 是唯一公开凭据；密码可选（bcrypt 哈希）；过期/吊销即失效。
公开读取不鉴权，只读目标快照/当前内容，不暴露项目其他数据。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, UtcDateTime, new_id

TARGET_TYPES: tuple[str, ...] = ("report", "plan_report", "api_doc")


class ShareLink(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "share_link"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    target_type: Mapped[str] = mapped_column(String(24), nullable=False)
    target_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_viewed_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
