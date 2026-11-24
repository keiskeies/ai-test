"""D284：场景补「标签」（对齐 MS 场景列表的标签列）。

`scenario.tags` 用逗号串（与 functional_case/api_definition 同一存法，`shared/tags.py`
统一读写）：去重保序、空 = 无标签。写入方 = 创建/编辑/复制（单条与批量）随抄/导入；
读方 = 列表/详情/顶层 `tag` 精确筛选（FIND_IN_SET，不用 LIKE——那会把 bug1 命中 bug10）。

Revision ID: 0058
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0058"
down_revision: str | None = "0057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("scenario", sa.Column("tags", sa.String(1000), nullable=True))


def downgrade() -> None:
    op.drop_column("scenario", "tags")
