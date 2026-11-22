"""UI 测试资产：ui_element + ui_case + ui_module（§4.4，计划 T2）。

ui_case 存 §7.2 的命令数组（扁平 JSON，无树）+ env_id / priority / enabled /
step_count 冗余计数（列表不 N+1）/ last_run_at+last_run_status 最近结果（T9 终态回写）。
**没有 version**：R104 决定 UI 用例不做乐观锁，与 ApiCase 对齐（多人同编一条命令列表的
概率远低于场景画布，而多一列 version 就多一处「前端忘了带」的静默覆盖）。

ui_element 是**扁平命名空间**：uq_ui_element_project_name 不含 module_id——§11.5.4 的
列表没有「同模块可同名」的迹象，而删除时的引用检测要按名字找人，同名跨模块会让那份
引用清单变成谜题（R106）。

ui_module 镜像 api_module / scenario_module 的树语义（R99 第三棵树）：无限级、软删
自身+后代、**根层重名 DB 管不住**——MySQL 唯一键不判等 NULL，
uq_ui_module_parent_name 对根层（parent_id 为 NULL）不生效，由服务层自查（照 0016 原话）。

owner_id + project_public 两列必须建：shared/visibility.py 读的是
getattr(row, "project_public", True)，漏建不报错而等于「每一行都公开」。

Revision ID: 0018
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("ui_module", "ui_element", "ui_case")


def upgrade() -> None:
    op.create_table(
        "ui_module",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "parent_id", "name", name="uq_ui_module_parent_name"),
    )
    op.create_table(
        "ui_element",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("module_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("locator_type", sa.String(16), nullable=False),
        sa.Column("locator", sa.String(500), nullable=False),
        sa.Column("comment", sa.String(500), nullable=True),
        sa.Column("owner_id", sa.String(36), nullable=True, index=True),
        sa.Column("project_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_ui_element_project_name"),
    )
    op.create_table(
        "ui_case",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("module_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("priority", sa.String(4), nullable=False, server_default="P2"),
        sa.Column("enabled", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("steps", sa.JSON(), nullable=False),
        sa.Column("env_id", sa.String(36), nullable=True, index=True),
        sa.Column("owner_id", sa.String(36), nullable=True, index=True),
        sa.Column("project_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("step_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_status", sa.String(16), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_ui_case_project_name"),
    )


def downgrade() -> None:
    # 逆序 drop：_NEW 写的是依赖顺序（module → element → case），删要反着来。
    # 这条 down 在计划 T2 Step 4 真跑过（upgrade → downgrade -1 → upgrade，三表真消失真回来），
    # 不是「写了 drop_table 就算」——§13 纪律 3 要的是能跑的 down。
    for t in reversed(_NEW):
        op.drop_table(t)
