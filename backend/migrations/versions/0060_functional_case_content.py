"""D289：功能用例补 MS v2 表单四项内容列（前置条件 / 步骤 / 备注 / 用例状态）。

`steps` 存 JSON 文本（`[{"desc": "...", "expected": "..."}]`），只由 functional 服务
读写；`case_status` 是内置三态（prepare/underway/completed），存量行回填默认
prepare——旧用例没有填过状态，默认「准备中」是实机表单的默认值，不伪造「已完成」。

Revision ID: 0060
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0060"
down_revision: str | None = "0059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("functional_case", sa.Column("precondition", sa.Text(), nullable=True))
    op.add_column("functional_case", sa.Column("steps", sa.Text(), nullable=True))
    op.add_column("functional_case", sa.Column("remark", sa.Text(), nullable=True))
    op.add_column("functional_case", sa.Column(
        "case_status", sa.String(24), nullable=False, server_default="prepare"))


def downgrade() -> None:
    op.drop_column("functional_case", "case_status")
    op.drop_column("functional_case", "remark")
    op.drop_column("functional_case", "steps")
    op.drop_column("functional_case", "precondition")
