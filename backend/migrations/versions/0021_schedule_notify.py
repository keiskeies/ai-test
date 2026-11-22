"""1E 定时与通知：schedule_task + notify_channel + kv_setting（§4.6/§4.10，计划 T0）。

列取舍照搬模型模块 docstring 的账（§4:210/§4:211/§4:237 清单 + 计划点名的最小补充；
next_fire_at 在 D22 裁决前不建；notify_channel 是平台级配置，无 project_id）。

时刻列走 DateTime（模型侧 UtcDateTime 存 UTC naive），与 0018/0020 同型。
这条 down 与 0020 同法在临时库真跑 upgrade → downgrade -1 → upgrade
（`scripts/check_migration_down.py 0021`，真去真回），不是写了 drop_table 就算；
demo 库禁跑（禁令）。

Revision ID: 0021
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("kv_setting", "notify_channel", "schedule_task")


def upgrade() -> None:
    op.create_table(
        "schedule_task",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("subject_type", sa.String(24), nullable=False),
        sa.Column("subject_id", sa.String(36), nullable=False, index=True),
        sa.Column("cron", sa.String(64), nullable=False),
        sa.Column("env_id", sa.String(36), nullable=True),
        sa.Column("enabled", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("notify_channel_ids", sa.JSON(), nullable=False),
        sa.Column("last_run", sa.JSON(), nullable=True),
        sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "notify_channel",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("last_send", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "kv_setting",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("key", name="uq_kv_setting_key"),
    )


def downgrade() -> None:
    # 逆序 drop：_NEW 写的是引用方向（schedule_task → notify_channel/kv_setting 被引用者
    # 在后），全库无外键（级联显式编码），顺序只是纪律不是约束。0020 同款真跑验证。
    for t in reversed(_NEW):
        op.drop_table(t)
