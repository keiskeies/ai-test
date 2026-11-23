"""用例评审域 schemas（D194）。"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.modules.review.models import PASS_RULES, RESULT_ACTIONS

_PASS_RULE_PATTERN = "^(" + "|".join(PASS_RULES) + ")$"
_ACTION_PATTERN = "^(" + "|".join(RESULT_ACTIONS) + ")$"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


# ══════════ 评审模块树 ══════════
class ReviewModuleNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int = 0
    status: str = "normal"
    review_count: int = 0
    children: list[ReviewModuleNode] = []


class ReviewModuleTreeIn(BaseModel):
    project_id: str
    include_recycled: bool = False


class ReviewModuleTreeOut(BaseModel):
    tree: list[ReviewModuleNode] = []
    recycled: list[ReviewModuleNode] = []


class ReviewModuleCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class ReviewModuleUpdateIn(BaseModel):
    project_id: str
    module_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None
    parent_set: bool = False


class ReviewModuleGetIn(BaseModel):
    project_id: str
    module_id: str


class ReviewModulePurgeIn(BaseModel):
    project_id: str
    module_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class ReviewModulePurgeOut(BaseModel):
    ok: bool = True
    purged_modules: int = 0


# ══════════ 评审 ══════════
class ReviewListIn(BaseModel):
    project_id: str
    module_id: str | None = None
    unfiled_only: bool = False
    keyword: str | None = Field(default=None, max_length=255)
    status: Literal["not_started", "in_review", "completed"] | None = None
    created_by_me: bool = False
    reviewing_me: bool = False
    my_todo: bool = False
    # D221：高级搜索条件组（JSON 串，形状见 shared/filter_registry）。与 module_id /
    # unfiled_only / keyword / status / 我相关三开关这些顶层轴并行 AND；None 或空串 = 没筛选。
    filter: str | None = None
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)


class ReviewCreateIn(BaseModel):
    project_id: str
    module_id: str | None = None
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    pass_rule: str = Field(default="single", pattern=_PASS_RULE_PATTERN)
    start_at: datetime | None = None
    end_at: datetime | None = None
    case_ids: list[str] = Field(default_factory=list, max_length=500)
    reviewer_ids: list[str] = Field(default_factory=list, max_length=200)


class ReviewUpdateIn(BaseModel):
    project_id: str
    review_id: str
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    module_id: str | None = None
    module_set: bool = False
    start_at: datetime | None = None
    start_at_set: bool = False
    end_at: datetime | None = None
    end_at_set: bool = False
    # 显式拒收：通过规则创建后不可改（MS 同语义），传了不同值 → 422
    pass_rule: str | None = Field(default=None, pattern=_PASS_RULE_PATTERN)


class ReviewGetIn(BaseModel):
    project_id: str
    review_id: str


class ReviewDeleteIn(BaseModel):
    project_id: str
    review_id: str
    confirm_name: str = Field(min_length=1, max_length=255)


class ReviewerOut(BaseModel):
    user_id: str
    name: str | None = None


class ReviewOut(BaseModel):
    id: str
    num: int
    project_id: str
    module_id: str | None = None
    name: str
    description: str | None = None
    pass_rule: str
    start_at: str | None = None
    end_at: str | None = None
    started: bool = False
    status: str = "not_started"
    case_count: int = 0
    pass_count: int = 0
    resolved_count: int = 0
    pass_rate: float = 0
    reviewer_count: int = 0
    created_by: str | None = None
    created_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class ReviewListOut(BaseModel):
    items: list[ReviewOut] = []


# ══════════ 评审内的用例 ══════════
class ReviewCaseListIn(BaseModel):
    project_id: str
    review_id: str
    result: Literal["pending", "pass", "fail"] | None = None
    reviewer_id: str | None = None
    todo_only: bool = False
    keyword: str | None = Field(default=None, max_length=255)
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)


class ReviewCaseOut(BaseModel):
    id: str
    review_id: str
    case_id: str
    case_name: str | None = None
    case_exists: bool = True
    result: str = "pending"
    re_review: bool = False
    reviewers: list[ReviewerOut] = []
    updated_at: str | None = None


class ReviewCaseListOut(BaseModel):
    items: list[ReviewCaseOut] = []
    total: int = 0


class ReviewCaseAssociateIn(BaseModel):
    project_id: str
    review_id: str
    case_ids: list[str] = Field(min_length=1, max_length=500)
    reviewer_ids: list[str] | None = None


class ReviewCaseAssociateOut(BaseModel):
    created: int = 0
    skipped: int = 0


class ReviewCaseDisassociateIn(BaseModel):
    project_id: str
    review_id: str
    case_id: str


class ReviewCaseBatchDisassociateIn(BaseModel):
    project_id: str
    review_id: str
    case_ids: list[str] = Field(min_length=1, max_length=500)


class ReviewCaseReviewersIn(BaseModel):
    project_id: str
    review_id: str
    case_ids: list[str] = Field(min_length=1, max_length=500)
    reviewer_ids: list[str] = Field(default_factory=list, max_length=200)
    mode: Literal["replace", "append"] = "replace"


class ReviewCaseReviewersOut(BaseModel):
    affected: int = 0


class ReviewSubmitIn(BaseModel):
    project_id: str
    review_id: str
    case_id: str
    action: str = Field(pattern=_ACTION_PATTERN)
    comment: str | None = Field(default=None, max_length=5000)


class ReviewBatchSubmitIn(BaseModel):
    project_id: str
    review_id: str
    case_ids: list[str] = Field(min_length=1, max_length=500)
    action: str = Field(pattern=_ACTION_PATTERN)
    comment: str | None = Field(default=None, max_length=5000)


class ReviewBatchSubmitOut(BaseModel):
    affected: int = 0
    skipped: list[str] = []


class ReviewCaseReReviewIn(BaseModel):
    project_id: str
    review_id: str
    case_id: str


class ReviewCaseBatchReReviewIn(BaseModel):
    project_id: str
    review_id: str
    case_ids: list[str] = Field(min_length=1, max_length=500)


class ReviewResultOut(BaseModel):
    id: str
    user_id: str
    user_name: str | None = None
    action: str
    comment: str | None = None
    active: bool = False
    created_at: str | None = None


class ReviewResultHistoryOut(BaseModel):
    items: list[ReviewResultOut] = []


class ReviewCaseReviewsIn(BaseModel):
    project_id: str
    case_id: str


class CaseReviewLinkOut(BaseModel):
    review_id: str
    review_num: int
    review_name: str
    status: str
    result: str
    re_review: bool = False
    case_count: int = 0
    pass_rate: float = 0


class ReviewCaseReviewsOut(BaseModel):
    items: list[CaseReviewLinkOut] = []


class AutoReReviewIn(BaseModel):
    project_id: str
    case_id: str


class AutoReReviewOut(BaseModel):
    affected: int = 0
