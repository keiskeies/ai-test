"""D281：功能用例补「责任人」（对齐 MS 功能用例列表的责任人列）。

`functional_case.owner_id` 可空（新建时还没定人是真实状态），加索引（列表筛选与
统计 owner 轴都要按它查）。写入方 = functional_case_create / functional_case_update
（`owner_set` 三态）/ functional_case_batch_copy（随源抄）；读方 = 列表/详情/统计。

MS 的「用例状态」不是本表的列：MS v3 的 `functional_case` 没有业务状态列，它是
模板自定义字段（本仓 D192 起已具备），所以这一刀只补责任人，不造第二个 status。

Revision ID: 0055
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0055"
down_revision: str | None = "0054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("functional_case", sa.Column("owner_id", sa.String(36), nullable=True))
    op.create_index("ix_functional_case_owner_id", "functional_case", ["owner_id"])


def downgrade() -> None:
    op.drop_index("ix_functional_case_owner_id", table_name="functional_case")
    op.drop_column("functional_case", "owner_id")
