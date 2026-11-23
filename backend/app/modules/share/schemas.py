"""分享链接 schemas（D202）。"""
from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field

_TARGET_PATTERN = "^(report|plan_report|api_doc)$"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class ShareCreateIn(BaseModel):
    project_id: str
    target_type: str = Field(pattern=_TARGET_PATTERN)
    target_id: str
    title: str | None = Field(default=None, max_length=255)
    password: str | None = Field(default=None, min_length=1, max_length=128)
    expires_at: datetime | None = None


class ShareListIn(BaseModel):
    project_id: str
    target_type: str | None = Field(default=None, pattern=_TARGET_PATTERN)
    target_id: str | None = None


class ShareGetIn(BaseModel):
    project_id: str
    share_id: str


class ShareRevokeIn(BaseModel):
    project_id: str
    share_id: str


class ShareOut(BaseModel):
    id: str
    token: str
    share_path: str
    target_type: str
    target_id: str
    title: str
    has_password: bool = False
    expires_at: str | None = None
    revoked_at: str | None = None
    view_count: int = 0
    last_viewed_at: str | None = None
    created_at: str | None = None


class ShareListOut(BaseModel):
    items: list[ShareOut] = []
