"""个人中心 / API Key schemas（D198）。"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class ProfileGetIn(BaseModel):
    """个人中心只认当前登录人，不接受 user_id 入参——路径空模型也要有字段。"""

    pass


class ProfileOut(BaseModel):
    id: str
    account: str
    name: str
    email: str | None = None
    is_system_admin: bool = False
    prefs: dict[str, Any] = {}
    created_at: str | None = None


class ProfileUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    email: str | None = Field(default=None, max_length=255)
    prefs: dict[str, Any] | None = None


class RecentProjectOut(BaseModel):
    id: str
    name: str
    role_code: str
    updated_at: str | None = None


class RecentProjectsOut(BaseModel):
    items: list[RecentProjectOut] = []


class MyAssetsIn(BaseModel):
    pass


class MyAssetsOut(BaseModel):
    counts: dict[str, int] = {}


class ApiKeyListIn(BaseModel):
    pass


class ApiKeyOut(BaseModel):
    id: str
    name: str
    prefix: str
    created_at: str | None = None
    last_used_at: str | None = None
    expires_at: str | None = None
    revoked_at: str | None = None


class ApiKeyListOut(BaseModel):
    items: list[ApiKeyOut] = []


class ApiKeyCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    expires_at: datetime | None = None


class ApiKeyCreateOut(ApiKeyOut):
    # 明文只在这里出现一次；之后列表只有 prefix。
    key: str


class ApiKeyRevokeIn(BaseModel):
    key_id: str


class ApiKeyRevokeOut(BaseModel):
    ok: bool = True
