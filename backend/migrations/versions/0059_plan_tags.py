"""D285：测试计划补「标签」（对齐 MS 计划列表的标签列）。

`plan_record.tags` 用逗号串（与 functional_case/scenario/api_definition 同一存法，
`shared/tags.py` 统一读写）：去重保序、空 = 无标签。写入方 = 新建/编辑/复制；
读方 = 列表/详情/顶层 `tag` 精确筛选（FIND_IN_SET，不用 LIKE——bug1 不命中 bug10）。

Revision ID: 0059
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0059"
down_revision: str | None = "0058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("plan_record", sa.Column("tags", sa.String(1000), nullable=True))


def downgrade() -> None:
    op.drop_column("plan_record", "tags")
