"""Mock schemas（D201）。"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field, model_validator

_METHOD_PATTERN = "^(GET|POST|PUT|PATCH|DELETE|ANY)$"
_MATCH_PATTERN = "^(exact|prefix|regex)$"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class ServiceListIn(BaseModel):
    project_id: str


class ServiceGetIn(BaseModel):
    project_id: str
    service_id: str


class ServiceCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    enabled: bool = True


class ServiceUpdateIn(BaseModel):
    project_id: str
    service_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    enabled: bool | None = None


class ServiceDeleteIn(BaseModel):
    project_id: str
    service_id: str


class ServiceOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None = None
    enabled: bool = True
    rule_count: int = 0
    mock_base: str = ""
    created_at: str | None = None
    updated_at: str | None = None


class ServiceListOut(BaseModel):
    items: list[ServiceOut] = []


class RuleListIn(BaseModel):
    project_id: str
    service_id: str
    # D241：规则列表高级搜索条件组（JSON 串，形状见 shared/filters.py）；与
    # project+service 作用域并行 AND，条件只在本服务的规则里筛。
    filter: str | None = None


class RuleGetIn(BaseModel):
    project_id: str
    rule_id: str


class RuleCreateIn(BaseModel):
    project_id: str
    service_id: str
    name: str = Field(min_length=1, max_length=200)
    method: str = Field(default="GET", pattern=_METHOD_PATTERN)
    path: str = Field(min_length=1, max_length=500)
    match_type: str = Field(default="exact", pattern=_MATCH_PATTERN)
    status_code: int = Field(default=200, ge=100, le=599)
    headers: dict[str, str] | None = None
    body: str | None = Field(default=None, max_length=200_000)
    delay_ms: int = Field(default=0, ge=0, le=5000)
    priority: int = 0
    enabled: bool = True

    @model_validator(mode="after")
    def _path(self) -> RuleCreateIn:
        if self.match_type != "regex" and not self.path.startswith("/"):
            raise ValueError("路径必须以 / 开头")
        return self


class RuleUpdateIn(BaseModel):
    project_id: str
    rule_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    method: str | None = Field(default=None, pattern=_METHOD_PATTERN)
    path: str | None = Field(default=None, min_length=1, max_length=500)
    match_type: str | None = Field(default=None, pattern=_MATCH_PATTERN)
    status_code: int | None = Field(default=None, ge=100, le=599)
    headers: dict[str, str] | None = None
    body: str | None = Field(default=None, max_length=200_000)
    delay_ms: int | None = Field(default=None, ge=0, le=5000)
    priority: int | None = None
    enabled: bool | None = None

    @model_validator(mode="after")
    def _path(self) -> RuleUpdateIn:
        if self.path is not None and self.match_type != "regex" and not self.path.startswith("/"):
            raise ValueError("路径必须以 / 开头")
        return self


class RuleDeleteIn(BaseModel):
    project_id: str
    rule_id: str


class RuleOut(BaseModel):
    id: str
    project_id: str
    service_id: str
    name: str
    method: str
    path: str
    match_type: str
    status_code: int
    headers: dict[str, Any] | None = None
    body: str | None = None
    delay_ms: int = 0
    priority: int = 0
    enabled: bool = True
    created_at: str | None = None
    updated_at: str | None = None


class RuleListOut(BaseModel):
    items: list[RuleOut] = []


class RuleTestIn(BaseModel):
    project_id: str
    service_id: str
    method: str = Field(pattern=_METHOD_PATTERN)
    path: str = Field(min_length=1, max_length=500)


class RuleTestOut(BaseModel):
    matched: bool
    rule: RuleOut | None = None
