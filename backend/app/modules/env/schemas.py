"""环境 schemas。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class EnvCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    position: int = 0
    config: dict[str, Any] | None = None


class EnvListIn(BaseModel):
    project_id: str
    cursor: str | None = None
    size: int = Field(default=50, ge=1, le=200)


class EnvUpdateIn(BaseModel):
    project_id: str
    env_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    position: int | None = None
    config: dict[str, Any] | None = None


class EnvDeleteIn(BaseModel):
    project_id: str
    env_id: str


class OkOut(BaseModel):
    ok: bool = True


class GlobalConfigGetIn(BaseModel):
    project_id: str


class GlobalConfigUpdateIn(BaseModel):
    project_id: str
    scope_type: str = Field(pattern="^(VAR|HEADER|ASSERT|EXTRACT)$")
    items: list[list[str]] = []


class GlobalConfigOut(BaseModel):
    scopes: dict[str, list] = {}


class EnvResolveIn(BaseModel):
    project_id: str
    env_id: str | None = None


class EnvResolveOut(BaseModel):
    vars: list[list[str]] = []
    headers: list[list[str]] = []
    timeout_ms: int | None = None
    env_name: str | None = None


class EnvOut(BaseModel):
    id: str
    project_id: str
    name: str
    position: int = 0
    config: dict[str, Any] | None = None
