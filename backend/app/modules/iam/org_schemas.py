"""组织层 schemas（D269/D270）。口径：组织是管理与分组层，不是租户边界（设计文档 §4.1）。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

_ORG_CODE = r"^[a-z0-9][a-z0-9_-]*$"
_STATUS = r"^(normal|disabled)$"
_ROLE = r"^(ORG_ADMIN|ORG_MEMBER)$"

# 组织级用户组可承载的管理位（逐字等于 iam.models.ORG_GROUP_PERMS；测试钉死两边一致）。
# 用 Literal 让非法位在 schema 层 422，而不是落库后才发现。
OrgCap = Literal[
    "system:org:update",
    "system:org:member:manage",
    "system:org:project:manage",
    "system:org:group:manage",
    "system:org:defect:manage",
]


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=2, max_length=64, pattern=_ORG_CODE)
    description: str | None = Field(default=None, max_length=2000)


class OrgListIn(BaseModel):
    q: str = Field(default="", max_length=100)
    status: str | None = Field(default=None, pattern=_STATUS)


class OrgOut(BaseModel):
    id: str
    name: str
    code: str
    description: str | None = None
    status: str = "normal"
    member_count: int = 0
    project_count: int = 0
    # 系统管理员 = SYSTEM_ADMIN；组织管理员/成员 = ORG_ADMIN/ORG_MEMBER。
    my_role: str | None = None
    # D270：我在本组织实际持有的管理位（系统管理员/ORG_ADMIN 为全部四枚；普通成员取
    # 所在用户组的并集）。界面按它逐个显隐按钮，服务端仍逐请求复核。
    my_perms: list[str] = Field(default_factory=list)
    created_at: datetime | None = None


class OrgGetIn(BaseModel):
    org_id: str


class OrgUpdateIn(BaseModel):
    org_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    status: str | None = Field(default=None, pattern=_STATUS)


class OrgDeleteIn(BaseModel):
    org_id: str


class OrgMemberListIn(BaseModel):
    org_id: str


class OrgMemberOut(BaseModel):
    id: str
    org_id: str
    user_id: str
    role_code: str
    account: str | None = None
    name: str | None = None


class OrgMemberSetIn(BaseModel):
    # 按账号定位用户：组织成员管理是平台级操作，回显 id 对界面没有意义，
    # 也避免前端为了拿 UUID 去拖 /system/users 的整份名单。
    org_id: str
    account: str = Field(min_length=1, max_length=64)
    role_code: str = Field(pattern=_ROLE)


class OrgMemberRemoveIn(BaseModel):
    org_id: str
    user_id: str


class OrgProjectListIn(BaseModel):
    org_id: str


class OrgProjectOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    status: str = "normal"


class OrgProjectAssignIn(BaseModel):
    org_id: str
    # 故意不叫 project_id：这不是「当前项目作用域」入参（R157 的口径），
    # 而是「要被归档进组织」的目标项目；调用者的授权来自组织角色，不是项目成员制。
    target_project_id: str


class OrgMineIn(BaseModel):
    pass


class OrgMineOut(BaseModel):
    org_id: str
    name: str
    code: str
    role_code: str


# ── D270 组织级用户组：一组 = 一份组织管理权限集 ─────────────────────────────


class OrgGroupListIn(BaseModel):
    org_id: str


class OrgGroupIn(BaseModel):
    org_id: str
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    perms: list[OrgCap] = Field(default_factory=list)


class OrgGroupOut(BaseModel):
    id: str
    org_id: str
    name: str
    description: str | None = None
    perms: list[str] = Field(default_factory=list)
    member_count: int = 0
    created_at: datetime | None = None


class OrgGroupGetIn(BaseModel):
    group_id: str


class OrgGroupUpdateIn(BaseModel):
    group_id: str
    name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2000)
    perms: list[OrgCap] | None = None


class OrgGroupDeleteIn(BaseModel):
    group_id: str


class OrgGroupMemberListIn(BaseModel):
    group_id: str


class OrgGroupMemberOut(BaseModel):
    id: str
    group_id: str
    user_id: str
    account: str | None = None
    name: str | None = None


class OrgGroupMemberSetIn(BaseModel):
    group_id: str
    # 与 org_member_set 同口径：按账号定位，组员必须是该组织成员。
    account: str = Field(min_length=1, max_length=64)


class OrgGroupMemberRemoveIn(BaseModel):
    group_id: str
    user_id: str


class OrgCapCheckIn(BaseModel):
    """跨模块内部口（D271）：缺陷模块核验「我在这个组织能不能管状态流」。"""

    org_id: str
    cap: OrgCap


class OrgCapCheckOut(BaseModel):
    ok: bool = True
    role: str | None = None
    perms: list[str] = Field(default_factory=list)
