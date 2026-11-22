"""T20b：scenario.common_assertions —— 场景级公共断言。

R85 落地修正：公共断言是 T20 交付里唯一的静默缺口（表无列、schema 无字段、引擎不求值、
UI 无入口）。「计划里有、代码里没有、台账里也没记」是 §13 纪律 1 禁的那类，补交付为 T20b。
列可空：NULL 与 [] 等价 = 不启用（老场景零行为变化）。

**求值语义以 R88 为准**（本迁移落地时写的是「对最后一步响应判一次」，业主随后裁定应为
「每个发出请求的步骤各判一次」）：改的是引擎求值点，**列的形状与本次 DDL 无关**，
所以不回改本迁移、也不加新迁移——迁移记录的是「当时改了什么表结构」，不是运行期语义。

Revision ID: 0017
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("scenario", sa.Column("common_assertions", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("scenario", "common_assertions")
