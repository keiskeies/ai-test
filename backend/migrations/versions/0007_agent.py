"""Agent：agent_session / agent_run / agent_message / agent_approval。

Revision ID: 0007
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_session",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), nullable=False, index=True),
        sa.Column("title", sa.String(200), nullable=False, server_default="新会话"),
        sa.Column("mode", sa.String(8), nullable=False, server_default="ASK"),
        sa.Column("model_id", sa.String(36), nullable=True),
        sa.Column("thinking", sa.String(8), nullable=False, server_default="medium"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_table(
        "agent_run",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), nullable=False, index=True),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="RUNNING"),
        sa.Column("lease_owner", sa.String(64), nullable=True),
        sa.Column("error", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("session_id", "seq", name="uq_agent_run_seq"),
    )
    op.create_table(
        "agent_message",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_id", sa.String(36), nullable=False, index=True),
        sa.Column("run_id", sa.String(36), nullable=True),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("session_id", "seq", name="uq_agent_message_seq"),
    )
    op.create_table(
        "agent_approval",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False, index=True),
        sa.Column("tool_call_id", sa.String(64), nullable=False),
        sa.Column("tool_name", sa.String(100), nullable=False),
        sa.Column("args", sa.JSON(), nullable=False),
        sa.Column("decision", sa.String(16), nullable=True),
        sa.Column("comment", sa.String(500), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("agent_approval")
    op.drop_table("agent_message")
    op.drop_table("agent_run")
    op.drop_table("agent_session")
