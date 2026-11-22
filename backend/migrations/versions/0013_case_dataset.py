"""接口用例 api_case + 数据集 data_set。

Revision ID: 0013
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "api_case",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("definition_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("priority", sa.String(4), nullable=False, server_default="P2"),
        sa.Column("request", sa.JSON(), nullable=True),
        sa.Column("assertions", sa.JSON(), nullable=True),
        sa.Column("dataset_id", sa.String(36), nullable=True, index=True),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("owner_id", sa.String(36), nullable=True, index=True),
        sa.Column("project_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "data_set",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("columns", sa.JSON(), nullable=False),
        sa.Column("rows", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_dataset_project_name"),
    )


def downgrade() -> None:
    op.drop_table("data_set")
    op.drop_table("api_case")
