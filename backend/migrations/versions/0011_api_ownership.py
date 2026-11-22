"""api_definition 私有资源两列：owner_id / project_public。

Revision ID: 0011
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_definition", sa.Column("owner_id", sa.String(36), nullable=True))
    op.add_column("api_definition", sa.Column("project_public", sa.Boolean(), nullable=False,
                  server_default=sa.true()))
    op.create_index("ix_api_definition_owner_id", "api_definition", ["owner_id"])


def downgrade() -> None:
    op.drop_index("ix_api_definition_owner_id", table_name="api_definition")
    op.drop_column("api_definition", "project_public")
    op.drop_column("api_definition", "owner_id")