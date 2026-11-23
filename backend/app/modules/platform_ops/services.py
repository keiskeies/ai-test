"""平台运维 @service（D203）：服务集成 7 / 资源池 5 / 插件 7 / 系统信息 2。

三条「不发请求、不装载、不调度」的边界见 models 模块 docstring；这里的接口
只做**登记面的增删改查**与启停，不制造任何「已接通」的假象。
"""
from __future__ import annotations

import json
from urllib.parse import urlparse

from sqlalchemy import or_, select, text

from app.core.errors import ApiError, OkOut
from app.core.security import dec_key, enc_key, mask_key
from app.core.service import ensure_project_access, service
from app.modules.platform_ops import schemas
from app.modules.platform_ops.models import (
    INTEGRATION_KINDS,
    PLUGIN_KINDS,
    Plugin,
    ResourcePool,
    ServiceIntegration,
)

APP_VERSION = "0.1.0"  # 与 app/main.py 的 FastAPI(version=...) 同值；两处改动同一次提交


def _check_base_url(url: str) -> None:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise ApiError("bad_url", "base_url 必须是 http(s) 且带主机名", 422, {"base_url": url})


def _check_json(name: str, raw: str) -> None:
    try:
        json.loads(raw)
    except (TypeError, ValueError) as e:
        raise ApiError("bad_json", name + " 不是合法 JSON：" + str(e), 422, {}) from e


# ══════════ 服务集成 ══════════
def _int_out(r: ServiceIntegration) -> schemas.IntegrationOut:
    hint = None
    if r.token_enc:
        try:
            hint = mask_key(dec_key(r.token_enc))
        except ApiError:
            hint = "[解密失败]"
    return schemas.IntegrationOut(
        id=r.id, project_id=r.project_id, kind=r.kind, name=r.name, base_url=r.base_url,
        has_token=bool(r.token_enc), token_hint=hint, description=r.description,
        enabled=r.enabled, created_by=r.created_by,
        created_at=schemas.iso(r.created_at), updated_at=schemas.iso(r.updated_at))


async def _integration(db, project_id: str, iid: str) -> ServiceIntegration:
    row = (await db.execute(select(ServiceIntegration).where(
        ServiceIntegration.id == iid,
        ServiceIntegration.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "服务集成不存在", 404, {"integration_id": iid})
    return row


async def _int_name_taken(db, project_id: str, name: str, exclude: str | None = None) -> bool:
    stmt = select(ServiceIntegration.id).where(
        ServiceIntegration.project_id == project_id, ServiceIntegration.name == name)
    if exclude:
        stmt = stmt.where(ServiceIntegration.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="integration:integration:read", effect="read", name="integration_meta",
    description="服务集成支持的平台类型（github/gitlab/gitee）",
    http={"method": "GET", "path": "/service-integrations/meta", "tags": ["platform_ops"]},
)
async def integration_meta(payload: schemas.IntegrationMetaIn,
                           ctx) -> schemas.IntegrationMetaOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("integration:integration:read")
    return schemas.IntegrationMetaOut(kinds=list(INTEGRATION_KINDS))


@service(
    perm="integration:integration:read", effect="read", name="integration_list",
    description="服务集成列表（关键词/只看启用；token 只回末 4 位）",
    http={"method": "GET", "path": "/service-integrations", "tags": ["platform_ops"]},
)
async def integration_list(payload: schemas.IntegrationListIn, ctx) -> schemas.IntegrationListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("integration:integration:read")
    assert ctx.db is not None
    stmt = select(ServiceIntegration).where(
        ServiceIntegration.project_id == payload.project_id)
    if payload.enabled_only:
        stmt = stmt.where(ServiceIntegration.enabled.is_(True))
    if payload.keyword:
        stmt = stmt.where(or_(
            ServiceIntegration.name.contains(payload.keyword, autoescape=True),
            ServiceIntegration.base_url.contains(payload.keyword, autoescape=True),
        ))
    rows = (await ctx.db.execute(stmt.order_by(
        ServiceIntegration.created_at, ServiceIntegration.id))).scalars().all()
    return schemas.IntegrationListOut(items=[_int_out(r) for r in rows])


@service(
    perm="integration:integration:read", effect="read", name="integration_get",
    description="服务集成详情",
    http={"method": "GET", "path": "/service-integrations/{integration_id}",
          "tags": ["platform_ops"]},
)
async def integration_get(payload: schemas.IntegrationGetIn,
                          ctx) -> schemas.IntegrationOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("integration:integration:read")
    assert ctx.db is not None
    return _int_out(await _integration(ctx.db, payload.project_id, payload.integration_id))


@service(
    perm="integration:integration:create", effect="write", name="integration_create",
    description="新建服务集成（名称项目内唯一；token Fernet 加密）",
    http={"method": "POST", "path": "/service-integrations", "tags": ["platform_ops"],
          "status": 201},
)
async def integration_create(payload: schemas.IntegrationCreateIn,
                             ctx) -> schemas.IntegrationOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("integration:integration:create")
    assert ctx.db is not None
    if await _int_name_taken(ctx.db, payload.project_id, payload.name):
        raise ApiError("conflict", "服务集成名已存在", 409, {"name": payload.name})
    _check_base_url(payload.base_url)
    row = ServiceIntegration(
        project_id=payload.project_id, kind=payload.kind, name=payload.name,
        base_url=payload.base_url, token_enc=enc_key(payload.token) if payload.token else None,
        description=payload.description, enabled=payload.enabled,
        created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.commit()
    return _int_out(row)


@service(
    perm="integration:integration:update", effect="write", name="integration_update",
    description="更新服务集成（token=None 保留、空串清除）",
    http={"method": "PATCH", "path": "/service-integrations/{integration_id}",
          "tags": ["platform_ops"]},
)
async def integration_update(payload: schemas.IntegrationUpdateIn,
                             ctx) -> schemas.IntegrationOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("integration:integration:update")
    assert ctx.db is not None
    row = await _integration(ctx.db, payload.project_id, payload.integration_id)
    if payload.name is not None and payload.name != row.name:
        if await _int_name_taken(ctx.db, payload.project_id, payload.name, exclude=row.id):
            raise ApiError("conflict", "服务集成名已存在", 409, {"name": payload.name})
        row.name = payload.name
    if payload.base_url is not None:
        _check_base_url(payload.base_url)
        row.base_url = payload.base_url
    if payload.token is not None:
        row.token_enc = enc_key(payload.token) if payload.token else None
    if payload.description is not None:
        row.description = payload.description
    if payload.enabled is not None:
        row.enabled = payload.enabled
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _int_out(row)


@service(
    perm="integration:integration:delete", effect="destructive", name="integration_delete",
    description="删除服务集成",
    http={"method": "POST", "path": "/service-integrations/{integration_id}/delete",
          "tags": ["platform_ops"]},
)
async def integration_delete(payload: schemas.IntegrationDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("integration:integration:delete")
    assert ctx.db is not None
    row = await _integration(ctx.db, payload.project_id, payload.integration_id)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="integration:integration:update", effect="write", name="integration_status",
    description="启用/停用服务集成",
    http={"method": "POST", "path": "/service-integrations/{integration_id}/status",
          "tags": ["platform_ops"]},
)
async def integration_status(payload: schemas.IntegrationStatusIn,
                             ctx) -> schemas.IntegrationOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("integration:integration:update")
    assert ctx.db is not None
    row = await _integration(ctx.db, payload.project_id, payload.integration_id)
    row.enabled = payload.enabled
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _int_out(row)


# ══════════ 资源池 ══════════
def _pool_out(r: ResourcePool) -> schemas.PoolOut:
    return schemas.PoolOut(
        id=r.id, project_id=r.project_id, name=r.name, kind=r.kind,
        description=r.description, capacity=r.capacity, enabled=r.enabled,
        created_by=r.created_by, created_at=schemas.iso(r.created_at),
        updated_at=schemas.iso(r.updated_at))


async def _pool(db, project_id: str, pid: str) -> ResourcePool:
    row = (await db.execute(select(ResourcePool).where(
        ResourcePool.id == pid, ResourcePool.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "资源池不存在", 404, {"pool_id": pid})
    return row


async def _pool_name_taken(db, project_id: str, name: str, exclude: str | None = None) -> bool:
    stmt = select(ResourcePool.id).where(
        ResourcePool.project_id == project_id, ResourcePool.name == name)
    if exclude:
        stmt = stmt.where(ResourcePool.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="resource:pool:read", effect="read", name="resource_pool_list",
    description="资源池列表（关键词/只看启用）",
    http={"method": "GET", "path": "/resource-pools", "tags": ["platform_ops"]},
)
async def resource_pool_list(payload: schemas.PoolListIn, ctx) -> schemas.PoolListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("resource:pool:read")
    assert ctx.db is not None
    stmt = select(ResourcePool).where(ResourcePool.project_id == payload.project_id)
    if payload.enabled_only:
        stmt = stmt.where(ResourcePool.enabled.is_(True))
    if payload.keyword:
        stmt = stmt.where(ResourcePool.name.contains(payload.keyword, autoescape=True))
    rows = (await ctx.db.execute(stmt.order_by(
        ResourcePool.created_at, ResourcePool.id))).scalars().all()
    return schemas.PoolListOut(items=[_pool_out(r) for r in rows])


@service(
    perm="resource:pool:read", effect="read", name="resource_pool_get",
    description="资源池详情",
    http={"method": "GET", "path": "/resource-pools/{pool_id}", "tags": ["platform_ops"]},
)
async def resource_pool_get(payload: schemas.PoolGetIn, ctx) -> schemas.PoolOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("resource:pool:read")
    assert ctx.db is not None
    return _pool_out(await _pool(ctx.db, payload.project_id, payload.pool_id))


@service(
    perm="resource:pool:create", effect="write", name="resource_pool_create",
    description="新建资源池（名称项目内唯一；容量仅登记）",
    http={"method": "POST", "path": "/resource-pools", "tags": ["platform_ops"],
          "status": 201},
)
async def resource_pool_create(payload: schemas.PoolCreateIn, ctx) -> schemas.PoolOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("resource:pool:create")
    assert ctx.db is not None
    if await _pool_name_taken(ctx.db, payload.project_id, payload.name):
        raise ApiError("conflict", "资源池名已存在", 409, {"name": payload.name})
    row = ResourcePool(project_id=payload.project_id, name=payload.name, kind=payload.kind,
                       description=payload.description, capacity=payload.capacity,
                       enabled=payload.enabled, created_by=ctx.user_id,
                       updated_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.commit()
    return _pool_out(row)


@service(
    perm="resource:pool:update", effect="write", name="resource_pool_update",
    description="更新资源池（含启停）",
    http={"method": "PATCH", "path": "/resource-pools/{pool_id}", "tags": ["platform_ops"]},
)
async def resource_pool_update(payload: schemas.PoolUpdateIn, ctx) -> schemas.PoolOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("resource:pool:update")
    assert ctx.db is not None
    row = await _pool(ctx.db, payload.project_id, payload.pool_id)
    if payload.name is not None and payload.name != row.name:
        if await _pool_name_taken(ctx.db, payload.project_id, payload.name, exclude=row.id):
            raise ApiError("conflict", "资源池名已存在", 409, {"name": payload.name})
        row.name = payload.name
    if payload.kind is not None:
        row.kind = payload.kind
    if payload.description is not None:
        row.description = payload.description
    if payload.capacity is not None:
        row.capacity = payload.capacity
    if payload.enabled is not None:
        row.enabled = payload.enabled
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _pool_out(row)


@service(
    perm="resource:pool:delete", effect="destructive", name="resource_pool_delete",
    description="删除资源池",
    http={"method": "POST", "path": "/resource-pools/{pool_id}/delete",
          "tags": ["platform_ops"]},
)
async def resource_pool_delete(payload: schemas.PoolDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("resource:pool:delete")
    assert ctx.db is not None
    row = await _pool(ctx.db, payload.project_id, payload.pool_id)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


# ══════════ 插件 ══════════
def _plugin_out(r: Plugin) -> schemas.PluginOut:
    return schemas.PluginOut(
        id=r.id, project_id=r.project_id, name=r.name, kind=r.kind, version=r.version,
        description=r.description, config=r.config, enabled=r.enabled, loadable=False,
        created_by=r.created_by, created_at=schemas.iso(r.created_at),
        updated_at=schemas.iso(r.updated_at))


async def _plugin(db, project_id: str, pid: str) -> Plugin:
    row = (await db.execute(select(Plugin).where(
        Plugin.id == pid, Plugin.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "插件不存在", 404, {"plugin_id": pid})
    return row


async def _plugin_name_taken(db, project_id: str, name: str, exclude: str | None = None) -> bool:
    stmt = select(Plugin.id).where(Plugin.project_id == project_id, Plugin.name == name)
    if exclude:
        stmt = stmt.where(Plugin.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="plugin:plugin:read", effect="read", name="plugin_meta",
    description="插件类型词表与装载状态说明（当前版本无装载点）",
    http={"method": "GET", "path": "/plugins/meta", "tags": ["platform_ops"]},
)
async def plugin_meta(payload: schemas.PluginMetaIn, ctx) -> schemas.PluginMetaOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("plugin:plugin:read")
    return schemas.PluginMetaOut(
        kinds=list(PLUGIN_KINDS),
        note="插件清单只做登记：当前版本没有动态装载点，协议与断言仍走内置实现。")


@service(
    perm="plugin:plugin:read", effect="read", name="plugin_list",
    description="插件列表（关键词/只看启用）",
    http={"method": "GET", "path": "/plugins", "tags": ["platform_ops"]},
)
async def plugin_list(payload: schemas.PluginListIn, ctx) -> schemas.PluginListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("plugin:plugin:read")
    assert ctx.db is not None
    stmt = select(Plugin).where(Plugin.project_id == payload.project_id)
    if payload.enabled_only:
        stmt = stmt.where(Plugin.enabled.is_(True))
    if payload.keyword:
        stmt = stmt.where(or_(
            Plugin.name.contains(payload.keyword, autoescape=True),
            Plugin.description.contains(payload.keyword, autoescape=True),
        ))
    rows = (await ctx.db.execute(stmt.order_by(Plugin.created_at, Plugin.id))).scalars().all()
    return schemas.PluginListOut(items=[_plugin_out(r) for r in rows])


@service(
    perm="plugin:plugin:read", effect="read", name="plugin_get",
    description="插件详情",
    http={"method": "GET", "path": "/plugins/{plugin_id}", "tags": ["platform_ops"]},
)
async def plugin_get(payload: schemas.PluginGetIn, ctx) -> schemas.PluginOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("plugin:plugin:read")
    assert ctx.db is not None
    return _plugin_out(await _plugin(ctx.db, payload.project_id, payload.plugin_id))


@service(
    perm="plugin:plugin:create", effect="write", name="plugin_create",
    description="登记插件（名称项目内唯一；config 必须是合法 JSON）",
    http={"method": "POST", "path": "/plugins", "tags": ["platform_ops"], "status": 201},
)
async def plugin_create(payload: schemas.PluginCreateIn, ctx) -> schemas.PluginOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("plugin:plugin:create")
    assert ctx.db is not None
    if await _plugin_name_taken(ctx.db, payload.project_id, payload.name):
        raise ApiError("conflict", "插件名已存在", 409, {"name": payload.name})
    _check_json("config", payload.config)
    row = Plugin(project_id=payload.project_id, name=payload.name, kind=payload.kind,
                 version=payload.version, description=payload.description,
                 config=payload.config, enabled=payload.enabled,
                 created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.commit()
    return _plugin_out(row)


@service(
    perm="plugin:plugin:update", effect="write", name="plugin_update",
    description="更新插件登记（config 合法性校验）",
    http={"method": "PATCH", "path": "/plugins/{plugin_id}", "tags": ["platform_ops"]},
)
async def plugin_update(payload: schemas.PluginUpdateIn, ctx) -> schemas.PluginOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("plugin:plugin:update")
    assert ctx.db is not None
    row = await _plugin(ctx.db, payload.project_id, payload.plugin_id)
    if payload.name is not None and payload.name != row.name:
        if await _plugin_name_taken(ctx.db, payload.project_id, payload.name, exclude=row.id):
            raise ApiError("conflict", "插件名已存在", 409, {"name": payload.name})
        row.name = payload.name
    if payload.kind is not None:
        row.kind = payload.kind
    if payload.version is not None:
        row.version = payload.version
    if payload.description is not None:
        row.description = payload.description
    if payload.config is not None:
        _check_json("config", payload.config)
        row.config = payload.config
    if payload.enabled is not None:
        row.enabled = payload.enabled
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _plugin_out(row)


@service(
    perm="plugin:plugin:delete", effect="destructive", name="plugin_delete",
    description="删除插件登记",
    http={"method": "POST", "path": "/plugins/{plugin_id}/delete", "tags": ["platform_ops"]},
)
async def plugin_delete(payload: schemas.PluginDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("plugin:plugin:delete")
    assert ctx.db is not None
    row = await _plugin(ctx.db, payload.project_id, payload.plugin_id)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="plugin:plugin:update", effect="write", name="plugin_status",
    description="启用/停用插件登记（不代表已装载）",
    http={"method": "POST", "path": "/plugins/{plugin_id}/status", "tags": ["platform_ops"]},
)
async def plugin_status(payload: schemas.PluginStatusIn, ctx) -> schemas.PluginOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("plugin:plugin:update")
    assert ctx.db is not None
    row = await _plugin(ctx.db, payload.project_id, payload.plugin_id)
    row.enabled = payload.enabled
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _plugin_out(row)


# ══════════ 系统信息 / 许可证 ══════════
@service(
    perm="system:info:read", effect="read", name="system_info",
    description="系统信息（版本、迁移头、版本类型）",
    http={"method": "GET", "path": "/system/info", "tags": ["platform_ops"]},
)
async def system_info(payload: schemas.SystemInfoIn, ctx) -> schemas.SystemInfoOut:
    ctx.require("system:info:read")
    assert ctx.db is not None
    row = (await ctx.db.execute(text("SELECT version_num FROM alembic_version"))).first()
    return schemas.SystemInfoOut(
        version=APP_VERSION, migration_head=row[0] if row else None,
        edition="community", licensed=True, license_enforced=False,
        note="社区版：不设功能门。MS 的 License 是商业门，复刻口径里主动排除。")


@service(
    perm="system:info:read", effect="read", name="system_license",
    description="许可证状态（社区版：不强制、无到期、无功能限制）",
    http={"method": "GET", "path": "/system/license", "tags": ["platform_ops"]},
)
async def system_license(payload: schemas.LicenseIn, ctx) -> schemas.LicenseOut:
    ctx.require("system:info:read")
    return schemas.LicenseOut(
        edition="community", licensed=True, enforced=False, expires_at=None,
        features={"mock": True, "share": True, "reviews": True, "functional_cases": True},
        note="不校验许可证、不因许可证拒绝任何功能；字段保留给将来的商业发行版。")
