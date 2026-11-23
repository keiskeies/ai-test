"""MCP 服务 schema（§9.8/§11.4.24）：env/headers 只进不回，回显键名。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

Transport = Literal["stdio", "sse", "http"]
Effect = Literal["read", "write"]


class ServerCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    transport: Transport = "stdio"
    command: str = Field(default="", max_length=500)
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = Field(default="", max_length=1000)
    headers: dict[str, str] = {}
    tool_effects: dict[str, Effect] = {}
    enabled: bool = True

    @model_validator(mode="after")
    def _check(self) -> ServerCreateIn:
        if self.transport == "stdio" and not self.command.strip():
            raise ValueError("stdio 型 MCP 必须填写启动命令")
        if self.transport in ("sse", "http") and not self.url.strip():
            raise ValueError("sse/http 型 MCP 必须填写 URL")
        return self


class ServerUpdateIn(BaseModel):
    server_id: str
    name: str | None = Field(default=None, min_length=1, max_length=100)
    transport: Transport | None = None
    command: str | None = Field(default=None, max_length=500)
    args: list[str] | None = None
    # None = 保留旧值；{} = 显式清空（与模型 api_key 的「留空保留」同一口径）
    env: dict[str, str] | None = None
    url: str | None = Field(default=None, max_length=1000)
    headers: dict[str, str] | None = None
    tool_effects: dict[str, Effect] | None = None
    enabled: bool | None = None


class ServerIdIn(BaseModel):
    server_id: str


class ToggleIn(BaseModel):
    server_id: str
    enabled: bool


class ToolItem(BaseModel):
    name: str
    description: str = ""
    input_schema: dict = {}


class ServerOut(BaseModel):
    id: str
    name: str
    transport: str
    command: str
    args: list[str] = []
    url: str
    env_keys: list[str] = []
    has_headers: bool = False
    enabled: bool
    status: str
    tool_count: int = 0
    tool_effects: dict = {}
    last_error: str | None = None
    last_checked_at: str | None = None
    last_latency_ms: int | None = None


class ServerListIn(BaseModel):
    cursor: str | None = None
    size: int = Field(default=50, ge=1, le=200)


class TestOut(BaseModel):
    ok: bool
    latency_ms: int = 0
    tool_count: int = 0
    tools: list[ToolItem] = []
    status: str = "offline"
    error: str | None = None
    last_checked_at: str | None = None


class ToolsOut(BaseModel):
    items: list[ToolItem] = []
    cached_at: str | None = None
