"""D200：环境组（C1）+ 公共脚本（C2）。无 DML。

Revision ID: 0036
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("environment_group", "environment_group_item", "public_script")


def upgrade() -> None:
    op.create_table(
        "environment_group",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_env_group_project_name"),
    )
    op.create_table(
        "environment_group_item",
        sa.Column("group_id", sa.String(36), primary_key=True),
        sa.Column("env_id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "public_script",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("language", sa.String(24), nullable=False, server_default="python"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_public_script_project_name"),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
