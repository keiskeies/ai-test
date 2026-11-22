"""D37 §11.4.21 自定义角色：custom_role 表（1G 计划）。

形状照搬 iam/models.py CustomRole 的账：code 全局唯一（project_member.role_code 的指向键，
四枚内置角色不进表——BUILTIN_ROLES 常量与 role_template 快照目录原样保留）；
project_id 作用域 + (project_id, name) 项目内唯一；perms 是权限位字符串数组快照；
template_code 记从哪枚内置模板复制来。

时刻列走 DateTime（模型侧 UtcDateTime 存 UTC naive），与 0020/0021 同型。
down 与 0021 同法在临时库真跑 upgrade → downgrade -1 → upgrade
（`scripts/check_migration_down.py 0022`，真去真回）；demo 库禁跑（禁令）。

Revision ID: 0022
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("custom_role",)


def upgrade() -> None:
    op.create_table(
        "custom_role",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("perms", sa.JSON(), nullable=False),
        sa.Column("template_code", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "name", name="uq_custom_role_project_name"),
    )


def downgrade() -> None:
    # 无外键（全库纪律），drop 即回退；引用它的 project_member 行按 409 引用检测
    # 保证删除时已归零，down 不需要清数据。
    for t in reversed(_NEW):
        op.drop_table(t)
