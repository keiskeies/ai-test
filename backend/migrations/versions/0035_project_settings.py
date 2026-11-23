"""D199：项目应用开关 + 误报库。无 DML。

Revision ID: 0035
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("project_application", "fake_error")


def upgrade() -> None:
    op.create_table(
        "project_application",
        sa.Column("project_id", sa.String(36), primary_key=True),
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "fake_error",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("pattern", sa.String(500), nullable=False),
        sa.Column("match_type", sa.String(16), nullable=False, server_default="contains"),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_fake_error_project_name"),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
