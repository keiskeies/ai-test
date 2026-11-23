"""D204：计划内功能用例的人工执行结论 + 变更流水（两张表）。无 DML。

Revision ID: 0040
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("plan_functional_exec_history", "plan_functional_exec")


def upgrade() -> None:
    op.create_table(
        "plan_functional_exec",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("plan_id", sa.String(36), nullable=False, index=True),
        sa.Column("link_id", sa.String(36), nullable=False, index=True),
        sa.Column("case_id", sa.String(36), nullable=False, index=True),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("executed_by", sa.String(36), nullable=True),
        sa.Column("executed_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("link_id", name="uq_plan_functional_exec_link"),
    )
    op.create_table(
        "plan_functional_exec_history",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("plan_id", sa.String(36), nullable=False, index=True),
        sa.Column("link_id", sa.String(36), nullable=False, index=True),
        sa.Column("case_id", sa.String(36), nullable=False, index=True),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("executed_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "ix_plan_functional_exec_history_link_seq", "plan_functional_exec_history", ["link_id", "seq"]
    )


def downgrade() -> None:
    for t in _NEW:
        op.drop_table(t)
