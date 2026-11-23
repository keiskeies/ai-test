"""D202：分享链接（报告/计划报告/接口文档）。无 DML。

Revision ID: 0038
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("share_link",)


def upgrade() -> None:
    op.create_table(
        "share_link",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("token", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("target_type", sa.String(24), nullable=False),
        sa.Column("target_id", sa.String(36), nullable=False, index=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("password_hash", sa.String(128), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_viewed_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
