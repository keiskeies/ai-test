"""D197：功能用例评论 + 前后置关系。无 DML。

Revision ID: 0033
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("functional_case_comment", "functional_case_relation")


def upgrade() -> None:
    op.create_table(
        "functional_case_comment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("case_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("reply_user_id", sa.String(36), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "functional_case_relation",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("from_case_id", sa.String(36), nullable=False, index=True),
        sa.Column("to_case_id", sa.String(36), nullable=False, index=True),
        sa.Column("relation_type", sa.String(16), nullable=False),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "from_case_id", "to_case_id",
                            name="uq_functional_case_relation"),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
