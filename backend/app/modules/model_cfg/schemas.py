"""模型配置 schema（§4.8）：api_key 只进不回，恒以打码串出。"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CfgCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    model_type: Literal["CHAT", "EMBEDDING"] = "CHAT"
    protocol: Literal["OPENAI_COMPAT", "ANTHROPIC"] = "OPENAI_COMPAT"
    base_url: str = Field(min_length=1, max_length=500)
    model_name: str = Field(min_length=1, max_length=200)
    api_key: str = ""
    context_window: int = Field(default=32768, ge=1024, le=10_000_000)
    max_output: int = Field(default=4096, ge=1, le=1_000_000)
    supports_thinking: bool = False
    thinking_levels: list[str] | None = None
    supports_vision: bool = False
    supports_tools: bool = True
    temperature_default: float | None = Field(default=None, ge=0, le=2)
    enabled: bool = True
    is_default: bool = False


class CfgUpdateIn(BaseModel):
    cfg_id: str
    name: str | None = Field(default=None, min_length=1, max_length=100)
    base_url: str | None = Field(default=None, min_length=1, max_length=500)
    model_name: str | None = Field(default=None, min_length=1, max_length=200)
    api_key: str | None = None  # None/"" 均视为不变更（§4.8：留空保留旧值）
    context_window: int | None = Field(default=None, ge=1024, le=10_000_000)
    max_output: int | None = Field(default=None, ge=1, le=1_000_000)
    supports_thinking: bool | None = None
    thinking_levels: list[str] | None = None
    supports_vision: bool | None = None
    supports_tools: bool | None = None
    temperature_default: float | None = Field(default=None, ge=0, le=2)
    enabled: bool | None = None
    is_default: bool | None = None


class CfgOut(BaseModel):
    id: str
    name: str
    model_type: str
    protocol: str
    base_url: str
    model_name: str
    api_key_masked: str
    context_window: int
    max_output: int
    supports_thinking: bool
    thinking_levels: list[str] | None = None
    supports_vision: bool
    supports_tools: bool
    temperature_default: float | None = None
    enabled: bool
    is_default: bool
    embed_dimensions: int | None = None
    # §6.8「默认思考档 medium」唯一落点：由 thinking_levels 含 medium 推导的只读派生位
    thinking_default: str | None = None
    probe_result: dict | None = None


class CfgListIn(BaseModel):
    model_type: Literal["CHAT", "EMBEDDING"] | None = None
    cursor: str | None = None
    size: int = Field(default=50, ge=1, le=200)


class CfgIdIn(BaseModel):
    cfg_id: str


class ProbeOut(BaseModel):
    ok: bool
    latency_ms: int = 0
    capabilities: dict = {}
    error: str | None = None
    embed_dimensions: int | None = None
    probe_result: dict | None = None
