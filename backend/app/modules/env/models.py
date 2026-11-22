"""环境模型（§4.3 S0 子集）。"""
from __future__ import annotations

from sqlalchemy import JSON, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id


class Environment(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "environment"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_env_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    config: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class GlobalConfig(ProjectScopedMixin, TimestampMixin, Base):
    """项目级全局配置（§4.2）：VAR/HEADER 参与执行渲染；ASSERT/EXTRACT 存而不用（1B 消费）。"""

    __tablename__ = "global_config"
    __table_args__ = (UniqueConstraint("project_id", "scope_type", name="uq_gcfg_scope"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False)  # VAR/HEADER/ASSERT/EXTRACT
    items: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # [[k,v],...] 或 [obj,...]
