"""D267：缺陷状态流转（defect_status + defect_status_transition）。无 DML。

空表 = 使用 models.py 的内置默认图；首次保存才落行（全仓迁移不 INSERT）。

Revision ID: 0048
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0048"
down_revision: str | None = "0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "defect_status",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("key", sa.String(32), nullable=False),
        sa.Column("name", sa.String(32), nullable=False),
        sa.Column("is_start", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_end", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "key", name="uq_defect_status_project_key"),
    )
    op.create_table(
        "defect_status_transition",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("from_key", sa.String(32), nullable=False),
        sa.Column("to_key", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "project_id", "from_key", "to_key", name="uq_defect_transition_project_edge"
        ),
    )


def downgrade() -> None:
    op.drop_table("defect_status_transition")
    op.drop_table("defect_status")
