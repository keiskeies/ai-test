"""运行记录 run_record。

Revision ID: 0009
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "run_record",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("subject_type", sa.String(24), nullable=False),
        sa.Column("subject_id", sa.String(36), nullable=False, index=True),
        sa.Column("subject_name", sa.String(200), nullable=False),
        sa.Column("env_id", sa.String(36), nullable=True),
        sa.Column("env_name", sa.String(100), nullable=True),
        sa.Column("trigger", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("elapsed_ms", sa.Integer(), nullable=True),
        sa.Column("request_snapshot", sa.JSON(), nullable=True),
        sa.Column("response_snapshot", sa.JSON(), nullable=True),
        sa.Column("assertions", sa.JSON(), nullable=True),
        sa.Column("error", sa.String(300), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("run_record")