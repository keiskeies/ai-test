"""D211：计划模块树（plan_module + plan_record.module_id）。无 DML。

Revision ID: 0042
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0042"
down_revision: str | None = "0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plan_module",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "parent_id", "name", name="uq_plan_module_parent_name"),
    )
    op.add_column("plan_record", sa.Column("module_id", sa.String(36), nullable=True))
    op.create_index("ix_plan_record_module_id", "plan_record", ["module_id"])


def downgrade() -> None:
    op.drop_index("ix_plan_record_module_id", table_name="plan_record")
    op.drop_column("plan_record", "module_id")
    op.drop_table("plan_module")
