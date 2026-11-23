"""D201：API Mock（服务 + 规则）。无 DML。

Revision ID: 0037
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("mock_service", "mock_rule")


def upgrade() -> None:
    op.create_table(
        "mock_service",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_mock_service_project_name"),
    )
    op.create_table(
        "mock_rule",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("service_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("method", sa.String(8), nullable=False, server_default="GET"),
        sa.Column("path", sa.String(500), nullable=False),
        sa.Column("match_type", sa.String(8), nullable=False, server_default="exact"),
        sa.Column("status_code", sa.Integer(), nullable=False, server_default="200"),
        sa.Column("headers", sa.JSON(), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("delay_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
