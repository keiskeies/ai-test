"""模型配置 model_config。

Revision ID: 0008
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "model_config",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("model_type", sa.String(16), nullable=False, server_default="CHAT"),
        sa.Column("protocol", sa.String(24), nullable=False, server_default="OPENAI_COMPAT"),
        sa.Column("base_url", sa.String(500), nullable=False),
        sa.Column("model_name", sa.String(200), nullable=False),
        sa.Column("api_key_enc", sa.String(1000), nullable=True),
        sa.Column("context_window", sa.Integer(), nullable=False, server_default="32768"),
        sa.Column("max_output", sa.Integer(), nullable=False, server_default="4096"),
        sa.Column("supports_thinking", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("thinking_levels", sa.JSON(), nullable=True),
        sa.Column("supports_vision", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("supports_tools", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("temperature_default", sa.Float(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("embed_dimensions", sa.Integer(), nullable=True),
        sa.Column("probe_result", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )


def downgrade() -> None:
    op.drop_table("model_config")
