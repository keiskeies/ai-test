"""IAM 模型（S0 子集）：用户 / 项目 / 成员 / 角色模板 / 权限点 + org/workspace（§4.1）。

D269：组织从「仅建表」升为可管理的分组层——补 description/status、org_member、
project.organization_id。口径仍是单租户：组织只做分组与管理，不做租户隔离，
项目数据权限继续由 project_member 决定（设计文档 §4.1）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UtcDateTime, new_id

# 组织成员的角色（D269）：ORG_ADMIN 可管理本组织成员与项目归属；ORG_MEMBER 只读。
# 组织角色不参与项目数据权限解析——项目可见性仍按 project_member（单租户口径）。
ORG_ROLES: tuple[str, ...] = ("ORG_ADMIN", "ORG_MEMBER")

# D270 组织级用户组可承载的管理动作（与 org_services 的 _require_cap 一一对应）。
# 用户组只细化「谁能在组织层做什么」，不碰项目数据权限（仍是 project_member 的事）。
ORG_GROUP_PERMS: tuple[str, ...] = (
    "system:org:update",              # 改组织资料（名称/说明/状态）
    "system:org:member:manage",       # 管组织成员（加人/调角色/移出）
    "system:org:project:manage",      # 管项目归属（归档/移出）
    "system:org:group:manage",        # 管用户组本身（建/改/删组与组成员）
    "system:org:defect:manage",       # D271：管组织级缺陷状态流模板
)

# 升级迁移 0050 建出的默认组织；create_project 未指定组织时落到它（不存在则留空）。
DEFAULT_ORG_CODE = "default"


class Org(TimestampMixin, Base):
    """§4.1 组织：D269 起是真实的管理/分组层（仍是单租户，不做隔离）。"""

    __tablename__ = "org"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)  # 对齐 project.name 的 200
    # code 是代码，必须全局唯一（同 app_user.account 的理由）；索引随 unique 自动建
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="normal")  # normal/disabled


class OrgMember(TimestampMixin, Base):
    """组织成员（D269）。一个用户在一个组织里只有一条成员行（role_code 二选一）。"""

    __tablename__ = "org_member"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_org_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    role_code: Mapped[str] = mapped_column(String(32), nullable=False, default="ORG_MEMBER")


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
    # D269：项目归属组织（可空=尚未归档）。只做分组，不参与数据权限。
    organization_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)


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


class UserApiKey(Base):
    """用户自助 API Key（D198）：只存 sha256，明文只在创建响应里出现一次。"""

    __tablename__ = "user_api_key"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)


class OrgUserGroup(TimestampMixin, Base):
    """组织级用户组（D270 / 对齐 MS 的 OrganizationUserRole：一组 = 一份组织管理权限集）。

    - 作用域是**组织**（不是项目）：`perms` 只装 `ORG_GROUP_PERMS` 里的组织管理位，
      不参与 `perms_for_user`，因此不会给组员带来任何项目数据访问。
    - 名称在组织内唯一；同一用户可进多个组，能力取并集。
    - ORG_ADMIN 与系统管理员不需要进组（他们本来就持有全部组织管理位）。
    """

    __tablename__ = "org_user_group"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_org_user_group_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 组织管理位的字符串数组快照（白名单见 ORG_GROUP_PERMS）。
    perms: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class OrgUserGroupMember(TimestampMixin, Base):
    """用户组成员（D270）。只允许组织成员进组——组不制造「组织外的隐形成员」。"""

    __tablename__ = "org_user_group_member"
    __table_args__ = (UniqueConstraint("group_id", "user_id", name="uq_org_user_group_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
