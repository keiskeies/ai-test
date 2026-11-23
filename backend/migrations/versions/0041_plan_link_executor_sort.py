"""D206：计划关联行加执行人指派与拖拽排序（两列 + 一条组合索引）。无 DML。

Revision ID: 0041
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("plan_case_link", sa.Column("executor_id", sa.String(36), nullable=True))
    op.add_column(
        "plan_case_link",
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_plan_case_link_plan_sort", "plan_case_link", ["plan_id", "sort_order"])


def downgrade() -> None:
    op.drop_index("ix_plan_case_link_plan_sort", table_name="plan_case_link")
    op.drop_column("plan_case_link", "sort_order")
    op.drop_column("plan_case_link", "executor_id")
