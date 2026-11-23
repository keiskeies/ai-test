"""项目设置模型（D199）：应用开关与误报规则。

应用开关是一张 (project_id, key) 覆盖表：没有行 = 用代码里的默认值；有行 = 项目显式开关。
误报规则用于把已知失败标成误报（消费者后续接执行/报告）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, UtcDateTime, new_id

APPLICATIONS: tuple[dict, ...] = (
    {"key": "functional.re_review", "group": "测试跟踪", "label": "用例编辑后自动重审",
     "default": True, "description": "名称/描述实际变化时，把该用例在所有评审里置为重新提审"},
    {"key": "bug.sync", "group": "测试跟踪", "label": "缺陷三方同步",
     "default": False, "description": "从 Jira/禅道等同步缺陷（依赖服务集成）"},
    {"key": "api.test", "group": "接口测试", "label": "接口测试",
     "default": True, "description": "项目菜单显示接口定义/用例/场景"},
    {"key": "ui.test", "group": "UI 测试", "label": "UI 测试",
     "default": True, "description": "项目菜单显示元素库/UI 用例"},
    {"key": "testplan.enable", "group": "测试跟踪", "label": "测试计划",
     "default": True, "description": "项目菜单显示测试计划/报告"},
    {"key": "mock.enable", "group": "接口测试", "label": "API Mock",
     "default": False, "description": "项目菜单显示 Mock 服务"},
    {"key": "share.enable", "group": "协作", "label": "分享链接",
     "default": False, "description": "允许生成报告/文档分享链接"},
    {"key": "minder.enable", "group": "测试跟踪", "label": "用例脑图",
     "default": False, "description": "用例库脑图入口"},
)
APP_BY_KEY = {a["key"]: a for a in APPLICATIONS}


class ProjectApplication(Base):
    __tablename__ = "project_application"

    project_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)


class FakeError(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "fake_error"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_fake_error_project_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    pattern: Mapped[str] = mapped_column(String(500), nullable=False)
    match_type: Mapped[str] = mapped_column(String(16), nullable=False, default="contains")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


SCRIPT_LANGUAGES: tuple[str, ...] = ("python", "javascript", "groovy", "shell")


class PublicScript(ProjectScopedMixin, TimestampMixin, Base):
    """公共脚本（C2）：可复用脚本库；内容更新时 version+1。"""

    __tablename__ = "public_script"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_public_script_project_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    language: Mapped[str] = mapped_column(String(24), nullable=False, default="python")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
