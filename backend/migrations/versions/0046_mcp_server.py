"""D265：MCP 服务登记（mcp_server）。无 DML。

Revision ID: 0046
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0046"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mcp_server",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("transport", sa.String(16), nullable=False),
        sa.Column("command", sa.String(500), nullable=True),
        sa.Column("args", sa.JSON(), nullable=True),
        # env/headers 整串 Fernet 加密：含值，列表页只回键名
        sa.Column("env_enc", sa.String(4000), nullable=True),
        sa.Column("url", sa.String(1000), nullable=True),
        sa.Column("headers_enc", sa.String(4000), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("status", sa.String(16), nullable=False, server_default="offline"),
        sa.Column("tool_cache", sa.JSON(), nullable=True),
        sa.Column("tool_effects", sa.JSON(), nullable=True),
        sa.Column("last_error", sa.String(500), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(), nullable=True),
        sa.Column("last_latency_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("mcp_server")
