"""用例评审域（D194）：评审、评审模块树、评审↔用例、评审人、结论历史。

**与 MS 的主动差异**（D194 计划，逐条对应取证 §C）：
- 不建 `ARCHIVED` 状态、不建零写入的快照归档表、不复制 `PREPARE/PREPARED` 拼写。
- 不在四处存状态：`case_review` 不存 status/pass_rate/case_count；评审状态与通过率
  **读时聚合**。每条用例的当前结论存 `case_review_case.result`（pending/pass/fail），
  由提交结论的同一事务重算——不是 MS 的 @Async 吞异常增量。
- 评审人只有一张表（per-case），没有 MS 的 review-level 复制表；编辑评审人 = 显式
  对受影响用例 replace/append。
- 结论历史 append-only；重新提审把旧结论置 `active=False` 并打 `re_review` 标，
  不建 `deleted/abandoned` 两个 BIT 墓碑。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, UtcDateTime, new_id

PASS_RULES: tuple[str, ...] = ("single", "multiple")
CASE_RESULTS: tuple[str, ...] = ("pending", "pass", "fail")
RESULT_ACTIONS: tuple[str, ...] = ("suggestion", "pass", "fail")
REVIEW_STATUSES: tuple[str, ...] = ("not_started", "in_review", "completed")
STATUS_NORMAL = "normal"
STATUS_RECYCLED = "recycled"


class CaseReviewModule(ProjectScopedMixin, TimestampMixin, Base):
    """评审专用模块树（与功能用例树是两棵；删除非空拒绝，不级联删评审）。"""

    __tablename__ = "case_review_module"
    __table_args__ = (
        UniqueConstraint("project_id", "parent_id", "name", name="uq_case_review_module_parent_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)


class CaseReview(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "case_review"
    __table_args__ = (
        UniqueConstraint("project_id", "num", name="uq_case_review_project_num"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    num: Mapped[int] = mapped_column(Integer, nullable=False)
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    pass_rule: Mapped[str] = mapped_column(String(8), nullable=False, default="single")
    start_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    end_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    # 是否已有人提交过结论（只为状态筛选/展示；结论本身的真相在关联行与历史里）
    started: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class CaseReviewCase(ProjectScopedMixin, TimestampMixin, Base):
    """评审↔用例。`result` 是该用例在当前评审里的**当前结论**（唯一写入口 = 提交/重审）。"""

    __tablename__ = "case_review_case"
    __table_args__ = (
        UniqueConstraint("review_id", "case_id", name="uq_case_review_case_pair"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    review_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    result: Mapped[str] = mapped_column(String(8), nullable=False, default="pending")
    re_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class CaseReviewReviewer(Base):
    """(评审, 用例, 评审人) —— 唯一一张评审人表，不复制 review-level 版本。"""

    __tablename__ = "case_review_reviewer"

    review_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    case_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)


class CaseReviewResult(Base):
    """结论历史（append-only）。同一用户的新结论会把旧结论 active=False（不删行）。"""

    __tablename__ = "case_review_result"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    review_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)
