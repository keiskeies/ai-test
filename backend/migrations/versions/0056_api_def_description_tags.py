"""D282：接口定义补「描述 / 标签」（对齐 MS 接口列表两列）。

`api_definition.description` 可空自由文本；`api_definition.tags` 用逗号串存储
（与 `defect.tags` 同一存法：去重保序、空 = 无标签），不另建标签关联表——
跨域标签体系是 P1-4 的独立一刀，这里只把接口这两列补到「有写入口、有读方」。

写入方 = api_definition_create / api_definition_update；读方 = 列表列 / 详情抽屉 /
关键字搜索（name/path/tags 三路 OR）。

Revision ID: 0056
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0056"
down_revision: str | None = "0055"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_definition", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("api_definition", sa.Column("tags", sa.String(1000), nullable=True))


def downgrade() -> None:
    op.drop_column("api_definition", "tags")
    op.drop_column("api_definition", "description")
