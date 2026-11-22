"""D183 步 4：plan_report + plan_report_item（报告 = 生成时刻的一次性快照）。

命名：本仓自拟，走 run_record / plan_record 命名族；上游产品的活表名（`test_plan_report`
一族）是禁区（license 边界，docs/2026-11-20-ms-testplan-forensics.md 开头边界声明）。
逐列「谁写/谁读」在 app/modules/testplan/models.py 的 PlanReport / PlanReportItem
docstring；本文件只钉形状。两列口径在本文件额外点名：

- **没有 pass_threshold 列**（§四 表格那句「抄通过阈值」落不了地：plan_record 没有可抄的
  源列，凭空造 = 判据 1 禁的「有 schema 没写入方」；偏差记录在模型 docstring）。
- **没有 run_id / last_run_id 指针列**：run_record 同秒无确定全序（DATETIME 精度 0 +
  uuid 主键，步 3 判断 1 实测）——定义不出「选哪条」的指针不建；存的是与顺序无关的
  结论与计数（§三 3 的环由 plan_report_create 同刀闭合）。

无外键（全库纪律）。级联两条链在应用层同事务兑现：plan_delete 按 plan_id 删净关联与
报告头、并按「本计划报告 id」删净明细；plan_report_delete 按 report_id 删净自己的明细。
alembic down 序列从链尾往回（0025 先例）：本条 down 先 drop 明细、再 drop 头，
plan_case_link / plan_record 后走——顺序天然无悬空引用。
时刻列走 DateTime（模型侧 UtcDateTime 存 UTC naive），与 0020–0025 同型。
计数列带库级默认 0（非空列一律带库级默认的全仓惯例，0014 注）——写入方永远显式给值，
库级默认只是形状约束。
down 在临时库真跑 upgrade → downgrade -1 → upgrade（`scripts/check_migration_down.py 0026`，
真去真回）；demo 库禁跑（禁令）。

Revision ID: 0026
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("plan_report", "plan_report_item")


def upgrade() -> None:
    op.create_table(
        "plan_report",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("plan_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        # 生成时刻展示态的定格（四态词表；「通过/未通过」轴不做——没有阈值源列，见文件头）
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("passed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("executed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("executing", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "plan_report_item",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("report_id", sa.String(36), nullable=False, index=True),
        # 证据链指针：无外键，摘挂不动已生成明细由用例钉（报告要能自证当时的结论）
        sa.Column("link_id", sa.String(36), nullable=False, index=True),
        sa.Column("subject_type", sa.String(24), nullable=False),
        sa.Column("subject_id", sa.String(36), nullable=False, index=True),
        sa.Column("subject_name", sa.String(200), nullable=False),
        sa.Column("env_id", sa.String(36), nullable=True),
        sa.Column("executed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("executing", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("result", sa.String(16), nullable=False, server_default="none"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("report_id", "link_id", name="uq_plan_report_item_report_link"),
    )


def downgrade() -> None:
    # 无外键（全库纪律），drop 即回退。先脱明细再脱头（链尾顺序），互不悬空。
    for t in reversed(_NEW):
        op.drop_table(t)
