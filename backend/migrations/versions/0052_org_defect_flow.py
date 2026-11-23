"""D271：组织级缺陷状态流模板（org_defect_status / org_defect_status_transition）。

口径（对齐 MS 的 OrganizationStatusFlowSetting；D269 的单租户约束不变）：
- 优先级：**项目自定义行 > 所属组织模板行 > 内置默认图**；
- 组织模板不复制到项目（改模板对所有「未自定义」的项目立即生效）；
- 两张表都为空 = 本组织没建模板（不是「空图」），项目继续回落内置默认；
- 不建外键（本仓既有表同款），组织删除时由 iam 侧显式清理（见 0052 的口径说明）。
  注意：跨模块清理走 iam 的 org_delete（raw SQL 删这两张表），迁移本身不掺业务逻辑。

Revision ID: 0052
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0052"
down_revision: str | None = "0051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "org_defect_status",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), nullable=False, index=True),
        sa.Column("key", sa.String(32), nullable=False),
        sa.Column("name", sa.String(32), nullable=False),
        sa.Column("is_start", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_end", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("org_id", "key", name="uq_org_defect_status_org_key"),
    )
    op.create_table(
        "org_defect_status_transition",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), nullable=False, index=True),
        sa.Column("from_key", sa.String(32), nullable=False),
        sa.Column("to_key", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("org_id", "from_key", "to_key", name="uq_org_defect_transition_org_edge"),
    )


def downgrade() -> None:
    op.drop_table("org_defect_status_transition")
    op.drop_table("org_defect_status")
