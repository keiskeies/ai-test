"""D269：组织层落地（org 扩列 / org_member / project.organization_id + 默认组织回填）。

口径（设计文档 §4.1 的单租户约束不变）：组织是管理与分组层，不是租户边界；
项目数据权限仍由 project_member 决定。回填只为让存量项目在「组织」页里有归属：

- 建一个 `code='default'` 的组织（名为「默认组织」）；
- 存量 project.organization_id 为空的全部挂到它下面；
- 新项目由 create_project 解析默认组织（代码路径，不在迁移里）。

downgrade 只脱 schema（新增列/表），不删除 default 组织行——它是数据不是结构，
删掉会让「降级再升级」把用户的组织归属弄丢；`org` 表本身在 0050 之前就存在。

Revision ID: 0050
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0050"
down_revision: str | None = "0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("org", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("org", sa.Column("status", sa.String(16), nullable=False, server_default="normal"))

    op.create_table(
        "org_member",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), nullable=False, index=True),
        sa.Column("role_code", sa.String(32), nullable=False, server_default="ORG_MEMBER"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("org_id", "user_id", name="uq_org_member"),
    )

    op.add_column("project", sa.Column("organization_id", sa.String(36), nullable=True))
    op.create_index("ix_project_organization_id", "project", ["organization_id"])

    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT id FROM org WHERE code = :code"), {"code": "default"}
    ).first()
    if row is None:
        org_id = str(uuid.uuid4())
        bind.execute(
            sa.text(
                "INSERT INTO org (id, name, code, description, status, created_at, updated_at)"
                " VALUES (:id, :name, :code, :description, :status, :now, :now)"
            ),
            {
                "id": org_id,
                "name": "默认组织",
                "code": "default",
                "description": "升级时自动创建；存量项目在这里归档，可在「系统设置 → 组织」改名。",
                "status": "normal",
                "now": datetime.now(UTC).replace(tzinfo=None),
            },
        )
    else:
        org_id = row[0]
    bind.execute(
        sa.text("UPDATE project SET organization_id = :org_id WHERE organization_id IS NULL"),
        {"org_id": org_id},
    )


def downgrade() -> None:
    op.drop_index("ix_project_organization_id", table_name="project")
    op.drop_column("project", "organization_id")
    op.drop_table("org_member")
    op.drop_column("org", "status")
    op.drop_column("org", "description")
