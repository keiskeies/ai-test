"""D203：服务集成 / 资源池 / 插件登记（三张项目级表）。无 DML。

Revision ID: 0039
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("service_integration", "resource_pool", "plugin")


def upgrade() -> None:
    op.create_table(
        "service_integration",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("base_url", sa.String(500), nullable=False),
        sa.Column("token_enc", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_service_integration_project_name"),
    )
    op.create_table(
        "resource_pool",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False, server_default="local"),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("capacity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_resource_pool_project_name"),
    )
    op.create_table(
        "plugin",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False, server_default="protocol"),
        sa.Column("version", sa.String(32), nullable=False, server_default="1.0.0"),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("config", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_plugin_project_name"),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
