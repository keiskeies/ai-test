"""平台运维 schemas（D203）。"""
from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


# ══════════ 服务集成 ══════════
class IntegrationMetaIn(BaseModel):
    project_id: str


class IntegrationMetaOut(BaseModel):
    kinds: list[str]


class IntegrationListIn(BaseModel):
    project_id: str
    keyword: str | None = Field(default=None, max_length=200)
    enabled_only: bool = False


class IntegrationGetIn(BaseModel):
    project_id: str
    integration_id: str


class IntegrationCreateIn(BaseModel):
    project_id: str
    kind: str = Field(pattern="^(github|gitlab|gitee)$")
    name: str = Field(min_length=1, max_length=200)
    base_url: str = Field(min_length=1, max_length=500)
    token: str | None = Field(default=None, max_length=500)
    description: str | None = None
    enabled: bool = True


class IntegrationUpdateIn(BaseModel):
    project_id: str
    integration_id: str
    # 空串 = 清除 token；None = 保留原值（与 model_cfg 的「留空=保留」同口径，
    # 区别只是这里没有 separate clear 开关：想清就传 ""）。
    token: str | None = Field(default=None, max_length=500)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_url: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = None
    enabled: bool | None = None


class IntegrationDeleteIn(BaseModel):
    project_id: str
    integration_id: str


class IntegrationStatusIn(BaseModel):
    project_id: str
    integration_id: str
    enabled: bool


class IntegrationOut(BaseModel):
    id: str
    project_id: str
    kind: str
    name: str
    base_url: str
    has_token: bool = False
    token_hint: str | None = None
    description: str | None = None
    enabled: bool = True
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class IntegrationListOut(BaseModel):
    items: list[IntegrationOut] = []


# ══════════ 资源池 ══════════
class PoolListIn(BaseModel):
    project_id: str
    keyword: str | None = Field(default=None, max_length=200)
    enabled_only: bool = False


class PoolGetIn(BaseModel):
    project_id: str
    pool_id: str


class PoolCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(default="local", pattern="^(api|ui|adb|local)$")
    description: str | None = None
    capacity: int = Field(default=1, ge=1, le=1000)
    enabled: bool = True


class PoolUpdateIn(BaseModel):
    project_id: str
    pool_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    kind: str | None = Field(default=None, pattern="^(api|ui|adb|local)$")
    description: str | None = None
    capacity: int | None = Field(default=None, ge=1, le=1000)
    enabled: bool | None = None


class PoolDeleteIn(BaseModel):
    project_id: str
    pool_id: str


class PoolOut(BaseModel):
    id: str
    project_id: str
    name: str
    kind: str
    description: str | None = None
    capacity: int = 1
    enabled: bool = True
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class PoolListOut(BaseModel):
    items: list[PoolOut] = []


# ══════════ 插件 ══════════
class PluginMetaIn(BaseModel):
    project_id: str


class PluginMetaOut(BaseModel):
    kinds: list[str]
    note: str


class PluginListIn(BaseModel):
    project_id: str
    keyword: str | None = Field(default=None, max_length=200)
    enabled_only: bool = False


class PluginGetIn(BaseModel):
    project_id: str
    plugin_id: str


class PluginCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(default="protocol", pattern="^(protocol|assertion)$")
    version: str = Field(default="1.0.0", min_length=1, max_length=32)
    description: str | None = None
    config: str = Field(default="{}", max_length=20_000)
    enabled: bool = True


class PluginUpdateIn(BaseModel):
    project_id: str
    plugin_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    kind: str | None = Field(default=None, pattern="^(protocol|assertion)$")
    version: str | None = Field(default=None, min_length=1, max_length=32)
    description: str | None = None
    config: str | None = Field(default=None, max_length=20_000)
    enabled: bool | None = None


class PluginDeleteIn(BaseModel):
    project_id: str
    plugin_id: str


class PluginStatusIn(BaseModel):
    project_id: str
    plugin_id: str
    enabled: bool


class PluginOut(BaseModel):
    id: str
    project_id: str
    name: str
    kind: str
    version: str
    description: str | None = None
    config: str
    enabled: bool = True
    # 运行时是否可装载：恒 False 是**这版的事实**（models.plugin 的边界），
    # 前端据此把「已启用」与「已装载」分开说，不拿开关冒充能力。
    loadable: bool = False
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class PluginListOut(BaseModel):
    items: list[PluginOut] = []


# ══════════ 系统信息 ══════════
class SystemInfoIn(BaseModel):
    pass


class SystemInfoOut(BaseModel):
    version: str
    migration_head: str | None = None
    edition: str
    licensed: bool
    license_enforced: bool
    note: str


class LicenseIn(BaseModel):
    pass


class LicenseOut(BaseModel):
    edition: str
    licensed: bool
    enforced: bool
    expires_at: str | None = None
    features: dict[str, bool] = {}
    note: str
