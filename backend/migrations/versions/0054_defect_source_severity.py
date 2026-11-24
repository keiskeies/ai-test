"""D280：缺陷补「缺陷来源 / 严重程度」（对齐 MS 缺陷列表两列）。

- `source` 自由文本（MS 侧是项目可配字典，本仓没有字典表；收自由文本比造词表诚实）。
- `severity` 四值词表 critical/major/minor/trivial（空 = 未评估，不拿「一般」冒充评估）。
两者写入方 = defect_create / defect_update（`*_set` 三态），读方 = 列表/详情/高级搜索
（`DEFECT_LIST_FILTER` 加 text/enum 两项）。

Revision ID: 0054
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0054"
down_revision: str | None = "0053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("defect", sa.Column("source", sa.String(64), nullable=True))
    op.add_column("defect", sa.Column("severity", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("defect", "severity")
    op.drop_column("defect", "source")
