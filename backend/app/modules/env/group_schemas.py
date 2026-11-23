"""环境组 schemas（D200 / C1）。"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class EnvBrief(BaseModel):
    id: str
    name: str


class EnvGroupOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None = None
    envs: list[EnvBrief] = []
    created_at: str | None = None
    updated_at: str | None = None


class EnvGroupListIn(BaseModel):
    project_id: str
    # D249：高级搜索条件（JSON 串）；与 project_id 取数轴并行 AND，空/缺省 = 原样全量。
    filter: str | None = None


class EnvGroupListOut(BaseModel):
    items: list[EnvGroupOut] = []


class EnvGroupCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    env_ids: list[str] = Field(default_factory=list, max_length=200)


class EnvGroupUpdateIn(BaseModel):
    project_id: str
    group_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    env_ids: list[str] | None = None


class EnvGroupGetIn(BaseModel):
    project_id: str
    group_id: str


class EnvGroupEnvsIn(BaseModel):
    project_id: str
    group_id: str
    env_ids: list[str] = Field(min_length=1, max_length=200)
    mode: Literal["replace", "append"] = "replace"


class EnvGroupEnvRemoveIn(BaseModel):
    project_id: str
    group_id: str
    env_id: str


class EnvGroupEnvsOut(BaseModel):
    affected: int = 0
