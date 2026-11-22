"""审计日志 audit_log。

Revision ID: 0004
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_log",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("ts", sa.DateTime(), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), nullable=True, index=True),
        sa.Column("entry", sa.String(16), nullable=False),
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("target", sa.String(255), nullable=True),
        sa.Column("ok", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("diff", sa.JSON(), nullable=True),
        sa.Column("ip", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("audit_log")
