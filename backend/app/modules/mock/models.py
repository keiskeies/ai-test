"""Mock 模型（D201）。

- `mock_service`：一个可公开访问的 Mock 入口（`/mock/{service_id}/...`）。
- `mock_rule`：方法 + 路径匹配（exact/prefix/regex），返回状态码/头/体/延迟。
公开路由不鉴权（Mock 的用途就是被外部调用），服务关闭或没有匹配规则时 404。
"""
from __future__ import annotations

from sqlalchemy import JSON, Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id

METHODS: tuple[str, ...] = ("GET", "POST", "PUT", "PATCH", "DELETE", "ANY")
MATCH_TYPES: tuple[str, ...] = ("exact", "prefix", "regex")


class MockService(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "mock_service"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_mock_service_project_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class MockRule(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "mock_rule"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    service_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    method: Mapped[str] = mapped_column(String(8), nullable=False, default="GET")
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    match_type: Mapped[str] = mapped_column(String(8), nullable=False, default="exact")
    status_code: Mapped[int] = mapped_column(Integer, nullable=False, default=200)
    headers: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    delay_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
