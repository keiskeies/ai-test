"""D234：功能用例关注人（functional_case_follower）。无 DML。

Revision ID: 0044
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "functional_case_follower",
        sa.Column("case_id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("functional_case_follower")
