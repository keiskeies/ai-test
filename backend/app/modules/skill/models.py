"""Skill 登记（§9.8）：目录 skills/<name>/SKILL.md 的数据库镜像（sync 时刷新）。

body 落库是有意的：read_skill 必须在一轮对话里稳定可读，不能因为运维改了工作区
文件就答非所问；文件仍是真相源，sync 显式把差异搬进来并报告新增/变更/移除。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UtcDateTime, new_id


class Skill(TimestampMixin, Base):
    __tablename__ = "skill"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    # builtin（目录同步）/ upload（zip 上传，三期）
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="builtin")
    dir_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # frontmatter 的可选 allowed-tools：读取后限缩本轮工具集（空 = 不限制）
    allowed_tools: Mapped[list | None] = mapped_column(JSON, nullable=True)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    synced_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
