"""场景资产：scenario + scenario_module（§4.6 场景 / §11.4.8，计划 Task 10）。

scenario 是场景编排的资产表：step_graph 协议快照（§7.4）、variables 场景变量层、
fail_fast / max_runtime_ms 执行策略、version 乐观锁、step_count 冗余计数（列表不 N+1）、
last_run_at/last_run_status 最近结果（T9/T11 终态回写，列表「最近结果」不查 run_record）。
updated_by 记录最近一次修改人；status 只在 normal/recycled 两态之间走软删三件套（R53）。

scenario_module 镜像 api_module 的树语义（R45）：无限级、软删自身+后代、根层重名由
服务层自查——MySQL 唯一键不判等 NULL，uq_scenario_module_parent_name 对根层（parent_id
为 NULL）不生效。

Revision ID: 0016
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("scenario", "scenario_module")


def upgrade() -> None:
    op.create_table(
        "scenario",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("module_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("priority", sa.String(4), nullable=False, server_default="P2"),
        sa.Column("step_graph", sa.JSON(), nullable=False),
        sa.Column("variables", sa.JSON(), nullable=True),
        sa.Column("fail_fast", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("max_runtime_ms", sa.Integer(), nullable=True),
        sa.Column("env_id", sa.String(36), nullable=True, index=True),
        sa.Column("owner_id", sa.String(36), nullable=True, index=True),
        sa.Column("project_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("step_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_status", sa.String(16), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_scenario_project_name"),
    )
    op.create_table(
        "scenario_module",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "parent_id", "name", name="uq_scenario_module_parent_name"),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
