"""D195：文件库 / 附件（内容寻址 + 仓库目录/条目 + 链接）。

替代 MS 的三套附件模型；表结构不绑 MinIO（storage_key 抽象键，本地磁盘实现）。
无 DML。

Revision ID: 0032
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("file_blob", "file_folder", "file_entry", "file_link")


def upgrade() -> None:
    op.create_table(
        "file_blob",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("mime", sa.String(255), nullable=False),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "sha256", name="uq_file_blob_project_sha"),
    )
    op.create_table(
        "file_folder",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "parent_id", "name", name="uq_file_folder_parent_name"),
    )
    op.create_table(
        "file_entry",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("folder_id", sa.String(36), nullable=True, index=True),
        sa.Column("blob_id", sa.String(36), nullable=False, index=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("tags", sa.String(500), nullable=True),
        sa.Column("root_id", sa.String(36), nullable=False, index=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_latest", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(16), nullable=False, server_default="normal", index=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "file_link",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("target_type", sa.String(24), nullable=False, index=True),
        sa.Column("target_id", sa.String(36), nullable=False, index=True),
        sa.Column("blob_id", sa.String(36), nullable=False, index=True),
        sa.Column("role", sa.String(16), nullable=False, server_default="attachment"),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("target_type", "target_id", "blob_id", "role",
                            name="uq_file_link_target_blob_role"),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
