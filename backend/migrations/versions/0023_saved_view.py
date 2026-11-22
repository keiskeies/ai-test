"""D47-a §11.5.1 视图选择器：saved_view 表（1G 计划第五十九轮）。

形状照搬 MeterSphere v3 的 `user_view` 语义（读语义不抄码，见
docs/2026-11-20-metersphere-parity-audit.md §2.1.1）：project_id 作用域 + view_type
（每个列表页一枚）+ owner_id（个人视图按主人隔离，**不是** §4.1 私有资源那套可见性）
+ name 同页面内唯一 + conditions JSON 原样存 + pos 排序位。

内置视图不落本表：系统的默认视图 = 「一条条件都没存」，落库反而造出一行用户删不掉的记录，
而「内置视图不可删」是 MS 的行为，应该在读侧表达而不是靠一行删不掉的数据表达。

时刻列走 DateTime（模型侧 UtcDateTime 存 UTC naive），与 0020/0021/0022 同型。
down 与 0021/0022 同法在临时库真跑 upgrade → downgrade -1 → upgrade
（`scripts/check_migration_down.py 0023`，真去真回）；demo 库禁跑（禁令）。

Revision ID: 0023
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("saved_view",)


def upgrade() -> None:
    op.create_table(
        "saved_view",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("view_type", sa.String(32), nullable=False, index=True),
        sa.Column("owner_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("conditions", sa.JSON(), nullable=False),
        sa.Column("pos", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "view_type", "owner_id", "name",
                            name="uq_saved_view_scope_name"),
    )


def downgrade() -> None:
    # 无外键（全库纪律），drop 即回退：视图是个人偏好，没有任何行外键指向它，
    # 删表不会留下悬空引用，down 不需要清数据。
    for t in reversed(_NEW):
        op.drop_table(t)
