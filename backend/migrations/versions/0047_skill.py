"""D266：Skills 登记（skill 表）。无 DML。

Revision ID: 0047
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0047"
down_revision: str | None = "0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "skill",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("source", sa.String(16), nullable=False, server_default="builtin"),
        sa.Column("dir_path", sa.String(1000), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("allowed_tools", sa.JSON(), nullable=True),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("synced_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("skill")
