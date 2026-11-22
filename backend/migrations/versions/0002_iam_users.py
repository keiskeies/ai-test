"""IAM：app_user / project / project_member / role_template / perm_point。

Revision ID: 0002
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "app_user",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("account", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column("password_hash", sa.String(128), nullable=False),
        sa.Column("is_system_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("prefs", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "role_template",
        sa.Column("code", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("perms", sa.JSON(), nullable=False),
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "perm_point",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("module", sa.String(32), nullable=False),
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("perm_point")
    op.drop_table("role_template")
    op.drop_table("app_user")
