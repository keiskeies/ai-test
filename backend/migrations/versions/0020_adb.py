"""ADB 测试资产：adb_device + adb_module + adb_case（§4.5，计划 T2）。

列取舍沿用 model 模块的注释（§4.5 两个字段清单，一列不多；visibility 的
owner_id+project_public 两列照 0018 的教训必须建——漏建不报错而等于「全公开」）。
connect_type 存小写 "wifi"/"usb"（D14：USB 写入口一期 422，枚举先留两值）。

时刻列走 UtcDateTime（模型侧存 UTC naive），与 0018 的 DateTime 列同型。这条 down 按
计划 T2 手法真跑过（upgrade → downgrade -1 → upgrade，三张表真去真回），不是写了
drop_table 就算。

Revision ID: 0020
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("adb_module", "adb_device", "adb_case")


def upgrade() -> None:
    op.create_table(
        "adb_module",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "parent_id", "name", name="uq_adb_module_parent_name"),
    )
    op.create_table(
        "adb_device",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("serial", sa.String(64), nullable=False, index=True),
        sa.Column("connect_type", sa.String(16), nullable=False, server_default="wifi"),
        sa.Column("wifi_addr", sa.String(64), nullable=True),
        sa.Column("enabled", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("last_state", sa.JSON(), nullable=True),
        sa.Column("owner_id", sa.String(36), nullable=True, index=True),
        sa.Column("project_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_adb_device_project_name"),
    )
    op.create_table(
        "adb_case",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("module_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("priority", sa.String(4), nullable=False, server_default="P2"),
        sa.Column("enabled", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("steps", sa.JSON(), nullable=False),
        sa.Column("default_device", sa.String(64), nullable=True),
        sa.Column("owner_id", sa.String(36), nullable=True, index=True),
        sa.Column("project_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("step_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_status", sa.String(16), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_adb_case_project_name"),
    )


def downgrade() -> None:
    # 逆序 drop：_NEW 写的是依赖顺序（module → device → case），删要反着来。
    # 这条 down 在计划 T2 真跑过（upgrade → downgrade -1 → upgrade，三表真消失真回来）。
    for t in reversed(_NEW):
        op.drop_table(t)
