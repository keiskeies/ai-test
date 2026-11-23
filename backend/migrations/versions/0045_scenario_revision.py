"""D262：场景变更历史（scenario_revision）。无 DML。

Revision ID: 0045
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0045"
down_revision: str | None = "0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scenario_revision",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("scenario_id", sa.String(36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.String(36), nullable=True),
        # 变更摘要（[{field, before, after}]）：只存非敏感值，variables 仅键名、
        # step_graph 仅步骤数（见 models.ScenarioRevision）。
        sa.Column("changed", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_scenario_revision_project_id", "scenario_revision", ["project_id"])
    op.create_index("ix_scenario_revision_scenario_version", "scenario_revision",
                    ["scenario_id", "version"])


def downgrade() -> None:
    op.drop_index("ix_scenario_revision_scenario_version", table_name="scenario_revision")
    op.drop_index("ix_scenario_revision_project_id", table_name="scenario_revision")
    op.drop_table("scenario_revision")
