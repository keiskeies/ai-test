"""D270：组织级用户组（org_user_group / org_user_group_member）。

口径（对齐 D269 的单租户约束）：用户组只是「组织管理动作的细分授权」，作用域是组织，
不参与 `perms_for_user`，因此不改变任何项目数据权限（项目可见性仍按 project_member）。

- `org_user_group.perms` 只装 `iam.models.ORG_GROUP_PERMS` 的四个位（应用层校验）；
  这里用 JSON 存快照，与 custom_role.perms 同一形态（不在迁移里建权限点表）。
- 组名在组织内唯一；`(group_id,user_id)` 唯一，防重复加人。
- 不建外键：本仓既有表（org_member / project_member）也不建，删除走应用层显式清理。

Revision ID: 0051
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0051"
down_revision: str | None = "0050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "org_user_group",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("perms", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("org_id", "name", name="uq_org_user_group_name"),
    )
    op.create_table(
        "org_user_group_member",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("group_id", sa.String(36), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("group_id", "user_id", name="uq_org_user_group_member"),
    )


def downgrade() -> None:
    op.drop_table("org_user_group_member")
    op.drop_table("org_user_group")
