"""IAM schemas。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    account: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: str
    account: str
    name: str
    email: str | None = None
    is_system_admin: bool = False
    status: str = "active"
    # D171：模型经 TimestampMixin（core/db.py:57）一直带着 created_at，出参此前没吐。
    # 本文件用 model_validate 直读 ORM 行，所以这里声明 datetime（读回即 tz-aware UTC，
    # JSON 层序列化成带偏移的 ISO）——与他模块 `str | None` + 构造点 iso() 同口径。
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class LoginOut(BaseModel):
    # token 字段是历史契约（全端在读），只增不改名。
    token: str
    user: UserOut


class RefreshOut(BaseModel):
    """/auth/refresh 响应：只回新 access；新 refresh 走 Set-Cookie，不进 JSON body
    （body 里出现 refresh 等于把它递给任何能读响应的脚本，Cookie 的 HttpOnly 就白设了）。"""

    token: str


class UserCreateIn(BaseModel):
    account: str = Field(min_length=2, max_length=64, pattern="^[a-zA-Z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=8, max_length=128)
    email: str | None = None
    is_system_admin: bool = False


class UserListIn(BaseModel):
    cursor: str | None = None
    size: int = Field(default=50, ge=1, le=200)


class UserStatusIn(BaseModel):
    user_id: str
    status: str = Field(pattern="^(active|disabled)$")


class UserUpdateIn(BaseModel):
    user_id: str
    name: str | None = Field(default=None, min_length=1, max_length=128)
    email: str | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)


class PasswordChangeIn(BaseModel):
    old_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class RoleTemplateListIn(BaseModel):
    pass


class RoleTemplateOut(BaseModel):
    code: str
    name: str
    perms: list[str] = []


# —— D37 §11.4.21 自定义角色（服务面见 role_services） ——
class CustomRoleOut(BaseModel):
    code: str
    project_id: str
    name: str
    perms: list[str] = []
    template_code: str


class CustomRoleListIn(BaseModel):
    project_id: str
    cursor: str | None = None
    size: int = Field(default=50, ge=1, le=200)


class RoleCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=128)
    template_code: str = Field(min_length=1, max_length=32)
    # 省略 = 模板位原样快照；传了 = 权限树裁剪后的完整位集（任意裁剪 + 任意勾选，D37 假设 4）
    perms: list[str] | None = None
    code: str | None = Field(default=None, max_length=64)


class RoleUpdateIn(BaseModel):
    project_id: str
    code: str
    name: str | None = Field(default=None, min_length=1, max_length=128)
    perms: list[str] | None = None


class RoleDeleteIn(BaseModel):
    project_id: str
    code: str


class RolePermTreeIn(BaseModel):
    project_id: str


class PermTreeNode(BaseModel):
    key: str
    title: str
    children: list[PermTreeNode] = []


class RolePermTreeOut(BaseModel):
    nodes: list[PermTreeNode] = []
    templates: list[RoleTemplateOut] = []


# 自引用模型（children: list[PermTreeNode]）必须显式 rebuild，否则 pydantic v2 留前向引用未解析。
PermTreeNode.model_rebuild()


# —— D40 §11.4.22 用户批量导入（服务面见 user_services；解析在 user_importers） ——
# 口径：复用 1E T4 的「冲突逐条跳过 + 报告」形状。行级问题不收 422——
# 「第几行为什么被跳过」必须是能对上粘贴原文的人话，所以约束放宽到这里、
# 逐条规则在 commit 里做（UserImportCommitIn 只管信封级：条数与初始密码强度）。
class UserImportPreviewIn(BaseModel):
    text: str = Field(default="", max_length=2_000_000)


class UserImportPreviewItem(BaseModel):
    line: int  # 粘贴原文的物理行号：回执与错误报告逐行可追溯的锚
    account: str
    name: str
    email: str | None = None
    exists: bool  # 库里已有同账号 = 冲突


class UserImportPreviewOut(BaseModel):
    new_count: int
    conflict_count: int
    items: list[UserImportPreviewItem] = []
    errors: list[str] = []  # 格式不合法行的人话（含行号）：这些行没进列表


class UserImportCommitItem(BaseModel):
    line: int = Field(ge=1)
    account: str = Field(default="", max_length=64)
    name: str = Field(default="", max_length=200)  # >128 走逐条人话失败，不在这里 422
    email: str | None = Field(default=None, max_length=300)
    strategy: str = Field(default="create", pattern="^(skip|create)$")  # 界面勾的「跳过」必须真被后端认


class UserImportCommitIn(BaseModel):
    items: list[UserImportCommitItem] = Field(min_length=1, max_length=500)
    # 整批共用初始密码（CSV 不带密码列；与单建「线下转交」同口径）。
    # R30 同自助改密：本服务 tool=False——密码不许从 agent 工具面进出。
    initial_password: str = Field(min_length=8, max_length=128)
    # 「导入为平台管理员」勾选框的后端参数（假门禁令：前端控件后端必须真认）。
    is_system_admin: bool = False


class UserImportRowOutcome(BaseModel):
    line: int
    account: str
    reason: str


class UserImportCommitOut(BaseModel):
    ok: bool  # False = 落库层炸、整批回滚（一条没写）；True 时 created/skipped/failed 就是全部事实
    created: int
    skipped: int
    failed: int
    failures: list[UserImportRowOutcome] = []  # 逐条失败（含行号人话），有效行照建
    skipped_detail: list[UserImportRowOutcome] = []  # 每条跳过为什么（勾了跳过 / 账号已存在）——「成3跳2」的账
    # 复用 T4 的 produced 形状：路由层的写入口全审计把它原样收进 diff——
    # 只含行号/账号/user_id，初始密码零踪迹。
    produced: list[dict[str, str]] = []


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)


class ProjectUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    status: str = "normal"
    my_role: str | None = None
    # 服务端权威权限模式串（§10.1 按钮级渲染）：角色模板可编辑，
    # 前端只按内置角色表猜会让自定义角色既看不见也说不清为什么看不见。
    my_perms: list[str] = []


class MemberIn(BaseModel):
    role_code: str = Field(min_length=1, max_length=32)


class MemberOut(BaseModel):
    id: str
    project_id: str
    user_id: str
    role_code: str
    account: str | None = None
    name: str | None = None


class RoleOut(BaseModel):
    code: str
    name: str
    builtin: bool = True
    perms: list[str] = []

    model_config = {"from_attributes": True}

class MemberCandidateIn(BaseModel):
    """项目内「按账号/姓名找人」：把 UUID 的查找权限降到项目范围（见 project_services）。"""

    project_id: str
    q: str = Field(default="", max_length=64)
    size: int = Field(default=20, ge=1, le=50)


class MemberCandidateOut(BaseModel):
    id: str
    account: str
    name: str
    is_member: bool = False
