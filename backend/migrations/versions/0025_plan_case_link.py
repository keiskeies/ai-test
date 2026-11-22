"""D183 步 2：plan_case_link 表（计划关联行）。

命名：本仓自拟，走 run_record / plan_record 命名族；上游产品的 `test_plan_*` 是禁区
（license 边界，见 docs/2026-11-20-ms-testplan-forensics.md 开头的边界声明）。
一张表装四种 subject（api_case/scenario/ui_case/adb_case，词表与拒收理由写在
app/modules/testplan/models.py 的 PlanCaseLink docstring），**不存**任何执行结论摘要
（取证 §三 2：MS 的三件套没有写入方——最近结果每次查询 join run_record 现算，归步 3）。
逐列的「谁写/谁读」在 models.py；本文件只钉形状。

无外键（全库纪律）：plan_id 的级联在应用层由 plan_delete 与删计划同事务兑现（§四 的债，
0024 down 注释里挂的那笔账在这里还——0024 的 downgrade 因此**不需要**补清关联：alembic
down 序列从链尾往回走，0025 的 down 先 drop plan_case_link，0024 的 down 再 drop
plan_record，顺序天然无悬空引用；且 down 场景本来就是整链回退，库要清空）。
时刻列走 DateTime（模型侧 UtcDateTime 存 UTC naive），与 0020–0024 同型。
down 在临时库真跑 upgrade → downgrade -1 → upgrade（`scripts/check_migration_down.py 0025`，
真去真回）；demo 库禁跑（禁令）。

Revision ID: 0025
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("plan_case_link",)


def upgrade() -> None:
    op.create_table(
        "plan_case_link",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        # 指向 plan_record.id，无外键：级联在应用层（plan_delete 同事务），见文件头。
        sa.Column("plan_id", sa.String(36), nullable=False, index=True),
        sa.Column("subject_type", sa.String(24), nullable=False),
        sa.Column("subject_id", sa.String(36), nullable=False, index=True),
        sa.Column("subject_name", sa.String(200), nullable=False),
        sa.Column("env_id", sa.String(36), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("plan_id", "subject_type", "subject_id", name="uq_plan_case_link_plan_subject"),
    )


def downgrade() -> None:
    # 无外键（全库纪律），drop 即回退。0024 的 down 注释里那笔「步 2 要不要先清关联行」的
    # 悬账在这里销：down 序列从链尾往回（-1 先脱 0025），plan_case_link 先消失，
    # 0024 后走时已无人引用它——两边都不留悬空引用。
    for t in reversed(_NEW):
        op.drop_table(t)
