"""D193：功能用例本体 + 第 5 份模块树 + 自定义值表。

模板/取号已在 0029 建好；本迁移**无 DML**（没有存量用例要回填）。`template_id` NOT NULL
靠写入路径保证（create 必过 project_template_resolve）。

Revision ID: 0030
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("functional_module", "functional_case", "functional_case_custom_field")


def upgrade() -> None:
    op.create_table(
        "functional_module",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "parent_id", "name", name="uq_functional_module_parent_name"),
    )
    op.create_table(
        "functional_case",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("num", sa.Integer(), nullable=False),
        sa.Column("module_id", sa.String(36), nullable=True, index=True),
        sa.Column("template_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("priority", sa.String(4), nullable=False, server_default="P2"),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal", index=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "num", name="uq_functional_case_project_num"),
    )
    op.create_table(
        "functional_case_custom_field",
        sa.Column("case_id", sa.String(36), primary_key=True),
        sa.Column("field_id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("value", sa.Text(), nullable=False),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
