"""文件库 / 附件域（D195）。

**一张内容表 + 一张仓库条目表 + 一张链接表**，替代 MS 的三套附件模型
（file_association / bug_local_attachment / functional_case_attachment，取证 §6 第 1 条）：

- `file_blob`：内容寻址（project + sha256 唯一），同一份字节在同一项目只落一次盘。
  仓库文件、缺陷/用例附件、富文本贴图都指向它。
- `file_folder` + `file_entry`：项目文件库的目录树与条目（可有多版本，v1 即 root）。
- `file_link`：附件/富文本链接（target_type + target_id + blob + role），硬删。

删除语义：仓库条目软删（回收站），附件链接硬删；两者删除后都做 blob 引用计数，
零引用才删盘上字节（不留下 MS 的死链 200 空体，取证 §6 第 4 条）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, UtcDateTime, new_id

STATUS_NORMAL = "normal"
STATUS_RECYCLED = "recycled"
TARGET_TYPES: tuple[str, ...] = ("bug", "functional_case")
LINK_ROLES: tuple[str, ...] = ("attachment", "richtext")


class FileBlob(Base):
    __tablename__ = "file_blob"
    __table_args__ = (
        UniqueConstraint("project_id", "sha256", name="uq_file_blob_project_sha"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    mime: Mapped[str] = mapped_column(String(255), nullable=False)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)


class FileFolder(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "file_folder"
    __table_args__ = (
        UniqueConstraint("project_id", "parent_id", "name", name="uq_file_folder_parent_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)


class FileEntry(ProjectScopedMixin, TimestampMixin, Base):
    """项目文件库条目（仓库文件）。`root_id/version/is_latest` 给将来的重传版本留位。"""

    __tablename__ = "file_entry"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    folder_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    blob_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[str | None] = mapped_column(String(500), nullable=True)
    root_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_latest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL, index=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class FileLink(Base):
    """附件/富文本链接。硬删；同一 target+blob+role 只一条。"""

    __tablename__ = "file_link"
    __table_args__ = (
        UniqueConstraint("target_type", "target_id", "blob_id", "role",
                         name="uq_file_link_target_blob_role"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    target_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    blob_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="attachment")
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)
