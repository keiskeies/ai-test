"""D194：用例评审（评审 / 评审模块树 / 评审内用例 / 评审人 / 结论历史）。

不建 MS 的 ARCHIVED 状态表、快照归档表与 review-level 评审人复制表。
无 DML（没有存量评审）。

Revision ID: 0031
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: str | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("case_review_module", "case_review", "case_review_case",
        "case_review_reviewer", "case_review_result")


def upgrade() -> None:
    op.create_table(
        "case_review_module",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "parent_id", "name", name="uq_case_review_module_parent_name"),
    )
    op.create_table(
        "case_review",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("num", sa.Integer(), nullable=False),
        sa.Column("module_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("pass_rule", sa.String(8), nullable=False, server_default="single"),
        sa.Column("start_at", sa.DateTime(), nullable=True),
        sa.Column("end_at", sa.DateTime(), nullable=True),
        sa.Column("started", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "num", name="uq_case_review_project_num"),
    )
    op.create_table(
        "case_review_case",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("review_id", sa.String(36), nullable=False, index=True),
        sa.Column("case_id", sa.String(36), nullable=False, index=True),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("result", sa.String(8), nullable=False, server_default="pending"),
        sa.Column("re_review", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("review_id", "case_id", name="uq_case_review_case_pair"),
    )
    op.create_table(
        "case_review_reviewer",
        sa.Column("review_id", sa.String(36), primary_key=True),
        sa.Column("case_id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
    )
    op.create_table(
        "case_review_result",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("review_id", sa.String(36), nullable=False, index=True),
        sa.Column("case_id", sa.String(36), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
