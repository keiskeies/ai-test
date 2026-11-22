"""API 接口定义模型（§4.4 S0 子集）。"""
from __future__ import annotations

from sqlalchemy import JSON, Boolean, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id


class ApiDefinition(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "api_definition"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_apidef_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    request: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")  # draft/complete
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class ApiModule(ProjectScopedMixin, TimestampMixin, Base):
    """接口模块树节点（无限级；软删=回收站）。"""

    __tablename__ = "api_module"
    __table_args__ = (UniqueConstraint("project_id", "parent_id", "name", name="uq_module_parent_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="normal")  # normal/recycled


class ApiCase(ProjectScopedMixin, TimestampMixin, Base):
    """接口用例：request=null 完全继承定义；否则按键浅覆盖（§7.5 分层）。"""

    __tablename__ = "api_case"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    definition_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    priority: Mapped[str] = mapped_column(String(4), nullable=False, default="P2")
    request: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # 覆盖层（§7.1 键子集）
    assertions: Mapped[list | None] = mapped_column(JSON, nullable=True)  # 追加在定义断言之后
    dataset_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="normal")  # normal/recycled


class DataSet(ProjectScopedMixin, TimestampMixin, Base):
    """数据集：结构化表格（columns + rows），行即变量层。"""

    __tablename__ = "data_set"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_dataset_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    columns: Mapped[list] = mapped_column(JSON, nullable=False)
    rows: Mapped[list] = mapped_column(JSON, nullable=False)
