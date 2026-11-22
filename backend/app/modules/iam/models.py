"""IAM 模型（S0 子集）：用户 / 项目 / 成员 / 角色模板 / 权限点 + org/workspace 建表（§4.1，一期仅建表）。"""
from __future__ import annotations

from sqlalchemy import JSON, Boolean, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, new_id


class Org(TimestampMixin, Base):
    """§4.1「[三期] 启用,一期仅建表」：表在 schema 里，一期没有任何服务读它。"""

    __tablename__ = "org"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)  # 对齐 project.name 的 200
    # code 是代码，必须全局唯一（同 app_user.account 的理由）；索引随 unique 自动建
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)


class Workspace(TimestampMixin, Base):
    """§4.1「[三期] 启用,一期仅建表」。不建 (org_id, name) 唯一：蓝图未承诺 org 内禁重名。"""

    __tablename__ = "workspace"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    # 无主的 workspace 在 §4.1 里不存在（org_id 是该行的第一个字段）；索引留给三期按 org 列举
    org_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)


class User(TimestampMixin, Base):
    __tablename__ = "app_user"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    is_system_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")  # active/disabled
    prefs: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class Project(TimestampMixin, Base):
    __tablename__ = "project"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="normal")
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)


class ProjectMember(TimestampMixin, Base):
    __tablename__ = "project_member"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    role_code: Mapped[str] = mapped_column(String(32), nullable=False)


class RoleTemplate(TimestampMixin, Base):
    __tablename__ = "role_template"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    perms: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CustomRole(TimestampMixin, Base):
    """自定义角色（§11.4.21 / D37 假设 1）：从内置模板复制后在权限树上裁剪的落库形态。

    - code 是 project_member.role_code 指向的键，全局唯一 UUID：四枚内置角色继续留在
      roles.BUILTIN_ROLES 常量（搬进表就要重裁 116 格权限矩阵，那是另一笔账），
      role_template 表仍是 bootstrap 播种的内置快照目录。
    - project_id = 「项目内一条自定义角色」的作用域（D37 原文）；名目在项目内唯一。
    - perms 是完整权限位/模式的字符串数组快照（复制来的模板位 + 裁剪后的结果），
      template_code 记「从哪个模板复制来」（审计与界面回显用；裁剪口径见计划假设 4）。
    """

    __tablename__ = "custom_role"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_custom_role_project_name"),)

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    perms: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    template_code: Mapped[str] = mapped_column(String(32), nullable=False)


class PermPoint(Base):
    __tablename__ = "perm_point"

    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    module: Mapped[str] = mapped_column(String(32), nullable=False, default="")
