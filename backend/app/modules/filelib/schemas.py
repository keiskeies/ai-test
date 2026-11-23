"""文件库 / 附件 schemas（D195）。"""
from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field

from app.modules.filelib.models import LINK_ROLES, TARGET_TYPES

_TARGET_PATTERN = "^(" + "|".join(TARGET_TYPES) + ")$"
_ROLE_PATTERN = "^(" + "|".join(LINK_ROLES) + ")$"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


# ══════════ 目录树 ══════════
class FolderNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int = 0
    status: str = "normal"
    file_count: int = 0
    children: list[FolderNode] = []


class FolderTreeIn(BaseModel):
    project_id: str
    include_recycled: bool = False


class FolderTreeOut(BaseModel):
    tree: list[FolderNode] = []
    recycled: list[FolderNode] = []


class FolderCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class FolderUpdateIn(BaseModel):
    project_id: str
    folder_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None
    parent_set: bool = False


class FolderGetIn(BaseModel):
    project_id: str
    folder_id: str


class FolderPurgeIn(BaseModel):
    project_id: str
    folder_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class FolderPurgeOut(BaseModel):
    ok: bool = True
    purged_folders: int = 0


# ══════════ 仓库文件 ══════════
class FileBlobOut(BaseModel):
    id: str
    sha256: str
    size: int
    mime: str
    original_name: str
    created_at: str | None = None


class FileEntryOut(BaseModel):
    id: str
    project_id: str
    folder_id: str | None = None
    name: str
    description: str | None = None
    tags: list[str] = []
    version: int = 1
    is_latest: bool = True
    recycled: bool = False
    blob: FileBlobOut
    created_by: str | None = None
    created_by_name: str | None = None
    updated_at: str | None = None


class FileListIn(BaseModel):
    project_id: str
    folder_id: str | None = None
    unfiled_only: bool = False
    keyword: str | None = Field(default=None, max_length=255)
    recycled: bool = False
    # D222：高级搜索条件组（JSON 串，形状见 shared/filter_registry）。与 folder_id /
    # unfiled_only / keyword / recycled 这些顶层轴并行 AND；None 或空串 = 没筛选。
    filter: str | None = None
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)


class FileGetIn(BaseModel):
    project_id: str
    file_id: str


class FileUpdateIn(BaseModel):
    project_id: str
    file_id: str
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    tags: list[str] | None = None
    folder_id: str | None = None
    folder_set: bool = False


class FilePurgeIn(BaseModel):
    project_id: str
    file_id: str
    confirm_name: str = Field(min_length=1, max_length=255)


# ══════════ 附件链接 ══════════
class AttachmentLinkIn(BaseModel):
    project_id: str
    target_type: str = Field(pattern=_TARGET_PATTERN)
    target_id: str
    blob_ids: list[str] = Field(min_length=1, max_length=200)
    role: str = Field(default="attachment", pattern=_ROLE_PATTERN)
    display_names: dict[str, str] | None = None


class AttachmentLinkOut(BaseModel):
    created: int = 0
    skipped: int = 0


class AttachmentListIn(BaseModel):
    project_id: str
    target_type: str = Field(pattern=_TARGET_PATTERN)
    target_id: str
    role: str = Field(default="attachment", pattern=_ROLE_PATTERN)


class AttachmentOut(BaseModel):
    id: str
    target_type: str
    target_id: str
    role: str
    display_name: str | None = None
    blob: FileBlobOut
    created_by: str | None = None
    created_by_name: str | None = None
    created_at: str | None = None


class AttachmentListOut(BaseModel):
    items: list[AttachmentOut] = []


class TargetPurgeIn(BaseModel):
    project_id: str
    target_type: str = Field(pattern=_TARGET_PATTERN)
    target_id: str


class TargetPurgeOut(BaseModel):
    ok: bool = True
    removed_links: int = 0


class AttachmentDeleteIn(BaseModel):
    project_id: str
    link_id: str

