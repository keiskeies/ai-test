"""D279：计划补测试阶段/计划与实际起止/责任人（plan_record 六列）。

对齐 MS 测试计划列表的「测试阶段 / 计划开始 / 计划结束 / 实际开始 / 实际结束 / 责任人」
六列。每一列都有写入口（计划表单）与读方（列表、详情、高级搜索），不是「有 schema
没写入方」的死列。owner_id 只做展示/筛选，**不参与可见性**（可见性仍是 project_id
显式过滤，plan_record 没有 project_public）。

Revision ID: 0053
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0053"
down_revision: str | None = "0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("plan_record", sa.Column("stage", sa.String(32), nullable=True))
    op.add_column("plan_record", sa.Column("planned_start", sa.DateTime(), nullable=True))
    op.add_column("plan_record", sa.Column("planned_end", sa.DateTime(), nullable=True))
    op.add_column("plan_record", sa.Column("actual_start", sa.DateTime(), nullable=True))
    op.add_column("plan_record", sa.Column("actual_end", sa.DateTime(), nullable=True))
    op.add_column("plan_record", sa.Column("owner_id", sa.String(36), nullable=True, index=True))


def downgrade() -> None:
    op.drop_index("ix_plan_record_owner_id", table_name="plan_record")
    op.drop_column("plan_record", "owner_id")
    op.drop_column("plan_record", "actual_end")
    op.drop_column("plan_record", "actual_start")
    op.drop_column("plan_record", "planned_end")
    op.drop_column("plan_record", "planned_start")
    op.drop_column("plan_record", "stage")
