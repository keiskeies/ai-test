"""组织与工作空间**建表**：org + workspace（§4.1，一期仅建表）。

为什么要现在建：§4.1 对这两行的原话是「[三期] 启用,一期仅建表」——建表是为了
三期启用时不背一次数据迁移（project 那时才补 workspace_id 并回填）。表先躺在
schema 里，任何业务代码都不读它；读它是三期的事，一期写了才是假功能（§13 纪律 1）。

**没有 project.workspace_id**：§4.1 的 project 行写明「[三期]补 workspace_id 并回填」，
一期连列都不该有——现在加了就是一棵只有一半的功能树，且回填语义（哪个项目属于
哪个 workspace）一期根本无从判定。tests/test_org_workspace_tables.py 把「project 没有
workspace_id」钉成断言，将来谁要加必须连同那条测试一起改，逼他先看一眼 §4.1。

列的取舍（全部只来自 §4.1 的两个字段清单，一列不多）：
- org.code 唯一：code 是「代码」，不唯一就不是代码（对照 app_user.account 同法）；
- workspace.org_id NOT NULL + 索引：§4.1 把 org_id 列为 workspace 的第一个字段，
  无主的 workspace 在蓝图里不存在；索引是三期的必然查询（列某 org 下的 workspace），
  现在建比三期在线加便宜。不建 (org_id, name) 唯一——蓝图没承诺 org 内 workspace
  重名要禁，提前禁会替三期做它没做过的语义决定；
- 不建外键：与全体兄弟表一致（project_member 对 project 也没有 FK），引用完整性
  历来在服务层管，这里连服务层都还没有；
- 不加 status/owner 之类：蓝图没列。org 的启停是三期启用时才有的问题。

时刻列走 TimestampMixin（模型侧 UtcDateTime 存 UTC naive），与 0002/0003 的
DATETIME 列同型；字符集/排序依赖库默认 utf8mb4_0900_ai_ci，近邻迁移（0016 起）
不再逐个写 mysql_charset，这里跟上。

Revision ID: 0019
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("org", "workspace")


def upgrade() -> None:
    op.create_table(
        "org",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("code", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "workspace",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    # 逆序 drop（workspace 依赖 org 的语义在前）；两表一期无人读写，down 必然干净。
    for t in reversed(_NEW):
        op.drop_table(t)
