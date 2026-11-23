"""缺陷域 schemas（D191 服务接线，契约来源 = D190 逐帧对账）。

词表唯一来源是 `models`（`DEFECT_CASE_TYPES` / `PRIORITIES`），这里只生成 pattern，
不抄字面量——与 ui_test/schemas.py 的同一条纪律。
`status` 自 D267 起是**项目级可配置 key**（slug pattern），是否存在由服务层按项目状态图
校验（非法 422 `invalid_status`）；不再在这里写死五态。

**与 MS 的形状差异**（D190 §5，逐条有意不跟）：
- 写操作不用 GET（MS 的 follow/unfollow 是 GET），也不借用 read 位。
- 页码分页保留本仓 `ge=1, le=200`（MS 是 `@Min(5) @Max(500)`）。
- `title` 上限 255（与 MS 前端 maxLength 对齐；MS 后端 `@Size(1,255)` 同值）。
- 不建 `platform` / `platform_bug_id`（不做第三方同步就没人写）；`template_id`/`num`
  已在 D192 交付，不再属于「差异」。
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.modules.defect.models import (
    DEFECT_CASE_TYPES,
    PRIORITIES,
)

_KEY_PATTERN = "^[a-z][a-z0-9_]{0,31}$"
_PRIORITY_PATTERN = "^(" + "|".join(PRIORITIES) + ")$"
_CASE_TYPE_PATTERN = "^(" + "|".join(DEFECT_CASE_TYPES) + ")$"

MAX_TAGS = 20
MAX_TAG_LEN = 32


def iso(dt: datetime | None) -> str | None:
    """datetime → 带时区偏移的 ISO；None 透传（第四处同款，合并留给后续重构）。"""
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


def _check_tags(tags: list[str] | None) -> list[str] | None:
    if tags is None:
        return None
    if len(tags) > MAX_TAGS:
        raise ValueError("标签最多 " + str(MAX_TAGS) + " 个")
    out: list[str] = []
    for t in tags:
        if not isinstance(t, str):
            raise ValueError("标签必须是字符串")
        v = t.strip()
        if not v:
            continue
        if len(v) > MAX_TAG_LEN:
            raise ValueError("单个标签最长 " + str(MAX_TAG_LEN) + " 字符")
        out.append(v)
    return out


# ══════════════════════════════ 缺陷本体 ══════════════════════════════
class DefectListIn(BaseModel):
    project_id: str
    # 页码制（D47-b）：缺陷列表是 MS 的 {current,pageSize,total} 形状。
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)
    status: str | None = Field(default=None, pattern=_KEY_PATTERN)
    priority: str | None = Field(default=None, pattern=_PRIORITY_PATTERN)
    handle_user_id: str | None = None
    keyword: str | None = Field(default=None, max_length=255)
    tag: str | None = Field(default=None, max_length=MAX_TAG_LEN)
    template_id: str | None = None
    recycled: bool = False
    followed_by_me: bool = False
    # D216：高级搜索条件组（JSON 串，形状见 shared/filters.py）。与上面各快捷筛选
    # 并行 AND；空串=没筛选，坏条件 400 且带本页可筛清单。
    filter: str | None = None


class DefectCreateIn(BaseModel):
    project_id: str
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    priority: str = Field(default="P2", pattern=_PRIORITY_PATTERN)
    handle_user_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    # None = 用场景默认模板；显式 id 必须属于本项目且 scene=bug。
    template_id: str | None = Field(default=None, min_length=1)
    # {field_id: 值}；值按字段类型校验（shared.custom_fields）。
    custom_fields: dict[str, Any] = Field(default_factory=dict)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return _check_tags(v) or []


class DefectUpdateIn(BaseModel):
    """PATCH 语义：None = 不改。

    `handle_user_set` / `description_set` 是「显式传了空值」的声明位（照 ui_test 的
    `module_set` 手法）：`handle_user_id: null` 必须能把处理人清空，而缺省字段不能
    顺手把处理人抹掉。`tags: null` 同样表示不改；清空标签请传 `[]`。
    """

    project_id: str
    defect_id: str
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    description_set: bool = False
    priority: str | None = Field(default=None, pattern=_PRIORITY_PATTERN)
    handle_user_id: str | None = None
    handle_user_set: bool = False
    status: str | None = Field(default=None, pattern=_KEY_PATTERN)
    tags: list[str] | None = None
    # None = 不改模板；换了模板则新模板的必填字段必须有值（旧值按 field_id 自动带过去）。
    template_id: str | None = Field(default=None, min_length=1)
    # None = 不改自定义值；{} = 清空（会按新模板的必填规则校验）。
    custom_fields: dict[str, Any] | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str] | None) -> list[str] | None:
        return _check_tags(v)


class DefectGetIn(BaseModel):
    project_id: str
    defect_id: str


class DefectDeleteIn(BaseModel):
    project_id: str
    defect_id: str


class DefectPurgeIn(BaseModel):
    project_id: str
    defect_id: str
    # 彻底删除不可回退：逐字确认标题（照 ui_case_purge）。
    confirm_title: str = Field(min_length=1, max_length=255)


class DefectBatchIn(BaseModel):
    project_id: str
    defect_ids: list[str] = Field(min_length=1, max_length=200)


class DefectBatchUpdateIn(BaseModel):
    """批量编辑 = 标签三态（MS 批量弹窗当前只有「标签」一项，D190 §3）。

    add_tags：追加并去重；clear_tags：清空（忽略 tags）；replace_tags：以 tags 覆盖。
    """

    project_id: str
    defect_ids: list[str] = Field(min_length=1, max_length=200)
    action: Literal["add_tags", "clear_tags", "replace_tags"]
    tags: list[str] = Field(default_factory=list)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return _check_tags(v) or []


class DefectOut(BaseModel):
    id: str
    num: int
    project_id: str
    template_id: str
    title: str
    description: str | None = None
    status: str
    priority: str
    handle_user_id: str | None = None
    handle_user_name: str | None = None
    tags: list[str] = []
    # {field_id: 值}；列表与详情同形（列表批量查，不 N+1）
    custom_fields: dict[str, Any] = {}
    recycled: bool = False
    created_by: str | None = None
    created_by_name: str | None = None
    updated_by: str | None = None
    updated_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    delete_user: str | None = None
    delete_user_name: str | None = None
    delete_time: str | None = None
    link_count: int = 0
    comment_count: int = 0
    follower_count: int = 0
    followed: bool = False


class DefectExistsOut(BaseModel):
    exists: bool


class DefectBatchOut(BaseModel):
    ok: bool = True
    affected: int = 0


# ══════════════════════════════ 关联用例 ══════════════════════════════
class DefectLinkListIn(BaseModel):
    project_id: str
    defect_id: str


class DefectLinkAddIn(BaseModel):
    project_id: str
    defect_id: str
    case_type: str = Field(pattern=_CASE_TYPE_PATTERN)
    case_ids: list[str] = Field(min_length=1, max_length=200)


class DefectLinkRemoveIn(BaseModel):
    project_id: str
    defect_id: str
    link_id: str


class DefectLinkCandidateIn(BaseModel):
    project_id: str
    defect_id: str
    case_type: str = Field(pattern=_CASE_TYPE_PATTERN)
    keyword: str | None = Field(default=None, max_length=200)
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)


class DefectLinkOut(BaseModel):
    id: str
    defect_id: str
    case_type: str
    case_id: str
    # 用例名与存在性由读侧按类型解析；对象被删后不隐藏关联行，而是诚实标 missing。
    case_name: str | None = None
    case_exists: bool = True
    created_by: str | None = None
    created_at: str | None = None


class DefectLinkListOut(BaseModel):
    items: list[DefectLinkOut] = []
    total: int = 0


class DefectLinkAddOut(BaseModel):
    created: int = 0
    skipped: int = 0


class DefectCaseOption(BaseModel):
    id: str
    name: str
    status: str | None = None


class DefectCaseOptionOut(BaseModel):
    items: list[DefectCaseOption] = []
    total: int = 0


# ══════════════════════════════ 评论 ══════════════════════════════
class DefectCommentListIn(BaseModel):
    project_id: str
    defect_id: str


class DefectCommentAddIn(BaseModel):
    project_id: str
    defect_id: str
    content: str = Field(min_length=1, max_length=5000)
    parent_id: str | None = None


class DefectCommentGetIn(BaseModel):
    project_id: str
    comment_id: str


class DefectCommentUpdateIn(BaseModel):
    project_id: str
    comment_id: str
    content: str = Field(min_length=1, max_length=5000)


class DefectCommentDeleteIn(BaseModel):
    project_id: str
    comment_id: str


class DefectCommentOut(BaseModel):
    id: str
    defect_id: str
    parent_id: str | None = None
    content: str
    reply_user_id: str | None = None
    reply_user_name: str | None = None
    created_by: str
    created_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    children: list[DefectCommentOut] = []


class DefectCommentListOut(BaseModel):
    items: list[DefectCommentOut] = []
    total: int = 0


# ══════════════════════════════ 关注 ══════════════════════════════
class DefectFollowIn(BaseModel):
    project_id: str
    defect_id: str


class DefectFollowOut(BaseModel):
    following: bool
    follower_count: int = 0


# ══════════════════════════════ 导出 ══════════════════════════════
class DefectExportIn(BaseModel):
    project_id: str
    defect_ids: list[str] | None = Field(default=None, max_length=500)


class DefectExportColumnsIn(BaseModel):
    project_id: str


class DefectExportColumn(BaseModel):
    key: str
    label: str


class DefectExportColumnsOut(BaseModel):
    columns: list[DefectExportColumn] = []


class DefectExportOut(BaseModel):
    """CSV 文本由前端落地为文件；`notes` 如实报未导出项（沿用 api_export 形状）。"""

    filename: str
    content: str
    exported: int = 0
    notes: list[str] = []


# ══════════════════════════════ 状态流转（D267）══════════════════════════
class DefectFlowGetIn(BaseModel):
    project_id: str


class DefectFlowStatusIn(BaseModel):
    key: str = Field(pattern=_KEY_PATTERN)
    name: str = Field(min_length=1, max_length=32)
    is_start: bool = False
    is_end: bool = False


class DefectFlowEdgeIn(BaseModel):
    from_key: str = Field(pattern=_KEY_PATTERN)
    to_key: str = Field(pattern=_KEY_PATTERN)


class DefectFlowIn(BaseModel):
    """整份替换项目的缺陷状态图；空表保存即回到默认图（请用 reset）。"""

    project_id: str
    statuses: list[DefectFlowStatusIn] = Field(min_length=1, max_length=20)
    transitions: list[DefectFlowEdgeIn] = Field(default_factory=list, max_length=200)


class DefectFlowResetIn(BaseModel):
    project_id: str


class DefectFlowStatusOut(BaseModel):
    key: str
    name: str
    is_start: bool
    is_end: bool


class DefectFlowEdgeOut(BaseModel):
    from_key: str
    to_key: str


class DefectFlowOut(BaseModel):
    project_id: str
    customized: bool
    # D271：图从哪来——project / org / default（界面据此提示「继承组织模板」）。
    source: str = "default"
    start_key: str
    statuses: list[DefectFlowStatusOut] = []
    transitions: list[DefectFlowEdgeOut] = []


# ── D271 组织级状态流模板（MS: OrganizationStatusFlowSetting）────────────────
class OrgDefectFlowGetIn(BaseModel):
    org_id: str


class OrgDefectFlowIn(BaseModel):
    org_id: str
    statuses: list[DefectFlowStatusIn] = Field(min_length=1, max_length=20)
    transitions: list[DefectFlowEdgeIn] = Field(default_factory=list, max_length=200)


class OrgDefectFlowResetIn(BaseModel):
    org_id: str


class OrgDefectFlowOut(BaseModel):
    org_id: str
    customized: bool
    start_key: str
    statuses: list[DefectFlowStatusOut] = []
    transitions: list[DefectFlowEdgeOut] = []
