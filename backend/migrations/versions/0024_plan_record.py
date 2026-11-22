"""D183 步 1：plan_record 表（测试计划本体）。

命名：本仓自拟表名，走 run_record 命名族；上游产品的 `test_plan` 是禁区（license 边界，
见 docs/2026-11-20-ms-testplan-forensics.md 开头的边界声明）。列口径逐条写在
app/modules/testplan/models.py 的 docstring——这一张表的每一列都有写入方与读取方
（计划 §六 1），没有 owner_id/project_public（可见性 = project_id 显式过滤，
schedule_task 一族，models docstring 有完整理由）。

时刻列走 DateTime（模型侧 UtcDateTime 存 UTC naive），与 0020/0021/0022/0023 同型。
down 与 0021/0022/0023 同法在临时库真跑 upgrade → downgrade -1 → upgrade
（`scripts/check_migration_down.py 0024`，真去真回）；demo 库禁跑（禁令）。

Revision ID: 0024
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("plan_record",)


def upgrade() -> None:
    op.create_table(
        "plan_record",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        # 库级默认与全仓惯例一致（0014 注：非空列一律带库级默认）；模型侧另有 Python default。
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_plan_record_project_name"),
    )


def downgrade() -> None:
    # 无外键（全库纪律），drop 即回退：步 1 没有任何别的表指向 plan_record，
    # down 不会留下悬空引用；步 2 加 plan_case_link 后这条 down 要不要先清关联行，
    # 由那一刀的迁移回头处理（§四 的级联债在这里也如实挂账）。
    for t in reversed(_NEW):
        op.drop_table(t)
