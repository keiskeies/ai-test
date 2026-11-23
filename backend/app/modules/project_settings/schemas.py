"""项目设置 schemas（D199）。"""
from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class ApplicationListIn(BaseModel):
    project_id: str


class ApplicationItem(BaseModel):
    key: str
    group: str
    label: str
    description: str
    default: bool
    enabled: bool


class ApplicationListOut(BaseModel):
    items: list[ApplicationItem] = []


class ApplicationUpdateIn(BaseModel):
    project_id: str
    key: str = Field(min_length=1, max_length=64)
    enabled: bool


class ApplicationEnabledIn(BaseModel):
    project_id: str
    key: str = Field(min_length=1, max_length=64)


class ApplicationEnabledOut(BaseModel):
    key: str
    enabled: bool


class FakeErrorListIn(BaseModel):
    project_id: str
    keyword: str | None = Field(default=None, max_length=200)
    enabled_only: bool = False


class FakeErrorGetIn(BaseModel):
    project_id: str
    rule_id: str


class FakeErrorCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    pattern: str = Field(min_length=1, max_length=500)
    match_type: str = Field(default="contains", pattern="^(contains|regex|exact)$")
    description: str | None = None
    enabled: bool = True


class FakeErrorUpdateIn(BaseModel):
    project_id: str
    rule_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    pattern: str | None = Field(default=None, min_length=1, max_length=500)
    match_type: str | None = Field(default=None, pattern="^(contains|regex|exact)$")
    description: str | None = None
    enabled: bool | None = None


class FakeErrorDeleteIn(BaseModel):
    project_id: str
    rule_id: str


class FakeErrorOut(BaseModel):
    id: str
    project_id: str
    name: str
    pattern: str
    match_type: str
    description: str | None = None
    enabled: bool = True
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class FakeErrorListOut(BaseModel):
    items: list[FakeErrorOut] = []


# ══════════ 公共脚本 ══════════
class ScriptListIn(BaseModel):
    project_id: str
    keyword: str | None = Field(default=None, max_length=200)
    enabled_only: bool = False
    # D250：高级搜索条件（JSON 串）；与关键词/只看启用两条快捷轴并行 AND。
    filter: str | None = None


class ScriptGetIn(BaseModel):
    project_id: str
    script_id: str


class ScriptCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    language: str = Field(default="python", pattern="^(python|javascript|groovy|shell)$")
    content: str = Field(min_length=1, max_length=200_000)
    enabled: bool = True


class ScriptUpdateIn(BaseModel):
    project_id: str
    script_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    language: str | None = Field(default=None, pattern="^(python|javascript|groovy|shell)$")
    content: str | None = Field(default=None, min_length=1, max_length=200_000)
    enabled: bool | None = None


class ScriptDeleteIn(BaseModel):
    project_id: str
    script_id: str


class ScriptStatusIn(BaseModel):
    project_id: str
    script_id: str
    enabled: bool


class ScriptOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None = None
    language: str
    content: str
    enabled: bool = True
    version: int = 1
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class ScriptListOut(BaseModel):
    items: list[ScriptOut] = []
