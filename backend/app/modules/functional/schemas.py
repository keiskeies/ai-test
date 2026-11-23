"""功能用例域 schemas（D193）。"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.modules.functional.models import PRIORITIES

_PRIORITY_PATTERN = "^(" + "|".join(PRIORITIES) + ")$"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class ModuleNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int = 0
    status: str = "normal"
    case_count: int = 0
    children: list[ModuleNode] = []


class ModuleTreeIn(BaseModel):
    project_id: str
    include_recycled: bool = False


class ModuleTreeOut(BaseModel):
    tree: list[ModuleNode] = []
    recycled: list[ModuleNode] = []


class ModuleCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class ModuleUpdateIn(BaseModel):
    project_id: str
    module_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None
    parent_set: bool = False


class ModuleGetIn(BaseModel):
    project_id: str
    module_id: str


class ModulePurgeIn(BaseModel):
    project_id: str
    module_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class ModulePurgeOut(BaseModel):
    ok: bool = True
    purged_modules: int = 0


class CaseListIn(BaseModel):
    project_id: str
    module_id: str | None = None
    unfiled_only: bool = False
    priority: str | None = Field(default=None, pattern=_PRIORITY_PATTERN)
    keyword: str | None = Field(default=None, max_length=255)
    recycled: bool = False
    # D234：「我关注的」视图轴（与模块/未分组/关键词/高级搜索并行 AND）。
    followed_by_me: bool = False
    # D219：高级搜索条件组（JSON 串，字段白名单见 services.FUNCTIONAL_CASE_LIST_FILTER）。
    filter: str | None = None
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)


class CaseCreateIn(BaseModel):
    project_id: str
    module_id: str | None = None
    name: str = Field(min_length=1, max_length=255)
    priority: str = Field(default="P2", pattern=_PRIORITY_PATTERN)
    description: str | None = None
    template_id: str | None = Field(default=None, min_length=1)
    custom_fields: dict[str, Any] = Field(default_factory=dict)


class CaseUpdateIn(BaseModel):
    project_id: str
    case_id: str
    name: str | None = Field(default=None, min_length=1, max_length=255)
    priority: str | None = Field(default=None, pattern=_PRIORITY_PATTERN)
    description: str | None = None
    description_set: bool = False
    module_id: str | None = None
    module_set: bool = False
    template_id: str | None = Field(default=None, min_length=1)
    custom_fields: dict[str, Any] | None = None


class CaseGetIn(BaseModel):
    project_id: str
    case_id: str


class CasePurgeIn(BaseModel):
    project_id: str
    case_id: str
    confirm_name: str = Field(min_length=1, max_length=255)


class CaseBatchIn(BaseModel):
    project_id: str
    case_ids: list[str] = Field(min_length=1, max_length=200)


class CaseBatchUpdateIn(BaseModel):
    """D232：批量编辑（只开放两个真实列：优先级 / 模块）。

    模块用 `module_set` 哨兵区分「不改」与「移到未分组（module_id=null）」：JSON 里
    `null` 与「字段缺省」在 Pydantic 里都是 None，没有哨兵就分不清（CaseUpdateIn 同款）。
    模板/自定义值不进批量：它们是「整份用例内容」的替换，批量改会把 N 条用例的值设成
    同一份，语义上不是「编辑」而是「覆盖」——不做。
    """

    project_id: str
    case_ids: list[str] = Field(min_length=1, max_length=200)
    priority: str | None = Field(default=None, pattern=_PRIORITY_PATTERN)
    module_id: str | None = None
    module_set: bool = False


class CaseOut(BaseModel):
    id: str
    num: int
    project_id: str
    module_id: str | None = None
    template_id: str
    name: str
    priority: str
    description: str | None = None
    recycled: bool = False
    custom_fields: dict[str, Any] = {}
    created_by: str | None = None
    created_by_name: str | None = None
    updated_by: str | None = None
    updated_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class CaseListRowOut(CaseOut):
    """D234：列表行带「我关注了没」。只在读路径出现，创建/更新回执仍是 CaseOut。"""

    followed: bool = False


class CaseDetailOut(CaseOut):
    """D234：详情现查关注态与人数（不存冗余列）。"""

    followed: bool = False
    follower_count: int = 0


class CaseFollowIn(BaseModel):
    project_id: str
    case_id: str


class CaseFollowOut(BaseModel):
    following: bool
    follower_count: int = 0



class CaseBatchOut(BaseModel):
    ok: bool = True
    affected: int = 0


class CaseBatchCopyIn(BaseModel):
    """D233：批量复制（副本进同一项目；可选目标模块与名称后缀）。

    模块同 `CaseBatchUpdateIn` 用 `module_set` 哨兵：缺省 = 各副本留在源用例自己的
    模块；`module_set=True` 时目标模块以 `module_id` 为准（null = 未分类）。
    评论与前后置关系刻意不复制——它们说的是「那一条用例」的事，不是副本的内容。
    """

    project_id: str
    case_ids: list[str] = Field(min_length=1, max_length=200)
    module_id: str | None = None
    module_set: bool = False
    name_suffix: str = Field(default="（副本）", max_length=32)


class CaseBatchCopyOut(BaseModel):
    ok: bool = True
    affected: int = 0
    case_ids: list[str] = []


# ══════════ 统计 ══════════
class CaseStatsIn(BaseModel):
    """D236：用例统计（对齐 MS `/report/test/case/count/getReport` 的 X 轴子集）。

    只开放三个真实存在的分组轴：优先级（MS caselevel）、模块（MS 没有、但本仓
    模块树是基础视图）、创建人（MS creator）。MS 的 casetype/casestatus/maintainer
    没有等价列（本仓没有用例类型、状态只有 normal/recycled 一个视图轴、无维护人），
    不硬造——统计轴必须是真列，否则就是假报表。

    `recycled` 是**视图开关**（与列表同口径），不是分组轴：正常/回收站各算一份，
    回收站总数额外单列（`recycled_total`），供页头一眼看清「多少在用、多少被删」。
    """

    project_id: str
    group_by: Literal["priority", "module", "creator"] = "priority"
    recycled: bool = False


class CaseStatGroup(BaseModel):
    key: str
    label: str
    count: int = 0


class CaseStatsOut(BaseModel):
    total: int = 0
    recycled_total: int = 0
    group_by: str = "priority"
    groups: list[CaseStatGroup] = []


# ══════════ 评论 ══════════
class CaseCommentListIn(BaseModel):
    project_id: str
    case_id: str


class CaseCommentAddIn(BaseModel):
    project_id: str
    case_id: str
    content: str = Field(min_length=1, max_length=5000)
    parent_id: str | None = None


class CaseCommentGetIn(BaseModel):
    project_id: str
    comment_id: str


class CaseCommentUpdateIn(BaseModel):
    project_id: str
    comment_id: str
    content: str = Field(min_length=1, max_length=5000)


class CaseCommentDeleteIn(BaseModel):
    project_id: str
    comment_id: str


class CaseCommentOut(BaseModel):
    id: str
    case_id: str
    parent_id: str | None = None
    content: str
    reply_user_id: str | None = None
    reply_user_name: str | None = None
    created_by: str
    created_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    children: list[CaseCommentOut] = []


class CaseCommentListOut(BaseModel):
    items: list[CaseCommentOut] = []
    total: int = 0


# ══════════ 前后置关系 ══════════
class CaseBrief(BaseModel):
    id: str
    num: int
    name: str


class CaseRelationListIn(BaseModel):
    project_id: str
    case_id: str


class CaseRelationAddIn(BaseModel):
    project_id: str
    case_id: str
    target_case_id: str
    relation_type: Literal["predecessor", "successor"]


class CaseRelationDeleteIn(BaseModel):
    project_id: str
    relation_id: str


class CaseRelationOut(BaseModel):
    relation_id: str
    case: CaseBrief
    relation_type: str


class CaseRelationListOut(BaseModel):
    predecessors: list[CaseRelationOut] = []
    successors: list[CaseRelationOut] = []


# ══════════════════════════════ 脑图（D268）══════════════════════════════
class MinderCaseOut(BaseModel):
    """脑图里的用例叶：只带画节点要用的列（详情/编辑走用例本体的接口）。"""

    id: str
    num: int
    name: str
    priority: str


class MinderNodeOut(BaseModel):
    """脑图的树节点。`kind` 只有两种：module（真实模块）/ note（便签）。

    便签不承载用例（`cases` 永远为空），用例只挂在模块下——与 MS 同边界。
    """

    id: str
    kind: Literal["module", "note"]
    name: str
    parent_id: str | None = None
    sort: int = 0
    case_count: int = 0
    cases: list[MinderCaseOut] = []
    children: list[MinderNodeOut] = []


class MinderTreeIn(BaseModel):
    project_id: str


class MinderTreeOut(BaseModel):
    project_id: str
    nodes: list[MinderNodeOut] = []
    unfiled_cases: list[MinderCaseOut] = []
    total_cases: int = 0


class MinderNoteCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class MinderNoteUpdateIn(BaseModel):
    """PATCH 语义：None = 不改；`parent_set` 是「显式传了空值」的声明位（同模块口径）。"""

    project_id: str
    note_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None
    parent_set: bool = False


class MinderNoteGetIn(BaseModel):
    project_id: str
    note_id: str
