"""模型配置 CRUD + 探活（§6.8/§9.10）。

治理决策（ledger R19）：模型池全局共享；读/建/改走权限位（PROJECT_ADMIN 亦可接入模型，
避免每加一个 key 都求超管），**删除仅限系统管理员**（destructive，403 forbidden 不泄露存在性）。
api_key 入参 Fernet 加密落库，回显恒打码；update 留空=保留旧值。
"""
from __future__ import annotations

import time

from sqlalchemy import select, update

from app.core.errors import ApiError, OkOut, Page, paginate
from app.core.security import dec_key, enc_key, mask_key
from app.core.service import ServiceResult, service
from app.modules.model_cfg import probe, schemas
from app.modules.model_cfg.models import ModelConfig
from app.shared.fakeuri import fixture_path, is_fake
from app.shared.utcnow import utc_now_iso


def _mask(cfg: ModelConfig) -> str:
    if not cfg.api_key_enc:
        return ""
    try:
        return mask_key(dec_key(cfg.api_key_enc))
    except ApiError:  # 主密钥变更：宁可显示占位，不让列表页 500
        return "****(无法解密)"


def thinking_default(levels: list | None) -> str | None:
    """§6.8「默认思考档 medium」的唯一落点：thinking_levels 含 medium 才认 medium。

    放在 temperature_default 旁边的派生位（不改表、不加列——0008 里没这列，
    也不该有：默认档由档位集合推导，存成列就是第二个口径）。
    集合里没有 medium（或没勾思考）→ None，由调用方回落，不硬造。
    """
    if levels and "medium" in levels:
        return "medium"
    return None


def _out(cfg: ModelConfig) -> schemas.CfgOut:
    return schemas.CfgOut(
        id=cfg.id, name=cfg.name, model_type=cfg.model_type, protocol=cfg.protocol,
        base_url=cfg.base_url, model_name=cfg.model_name, api_key_masked=_mask(cfg),
        context_window=cfg.context_window, max_output=cfg.max_output,
        supports_thinking=cfg.supports_thinking, thinking_levels=cfg.thinking_levels,
        supports_vision=cfg.supports_vision, supports_tools=cfg.supports_tools,
        temperature_default=float(cfg.temperature_default) if cfg.temperature_default is not None else None,
        enabled=cfg.enabled, is_default=cfg.is_default,
        embed_dimensions=cfg.embed_dimensions, probe_result=cfg.probe_result,
        thinking_default=thinking_default(cfg.thinking_levels if cfg.supports_thinking else None),
    )


async def _clear_defaults(db, model_type: str, keep_id: str | None = None) -> None:
    stmt = (update(ModelConfig).where(ModelConfig.model_type == model_type,
                                       ModelConfig.is_default.is_(True)).values(is_default=False))
    if keep_id:
        stmt = stmt.where(ModelConfig.id != keep_id)
    await db.execute(stmt)


async def _get(db, cfg_id: str) -> ModelConfig:
    cfg = (await db.execute(select(ModelConfig).where(ModelConfig.id == cfg_id))).scalar_one_or_none()
    if cfg is None:
        raise ApiError("not_found", "模型不存在", 404, {"cfg_id": cfg_id})
    return cfg


@service(
    perm="model:cfg:create", effect="write", name="model_cfg_create",
    description="登记一个模型服务（OpenAI 兼容/Anthropic），api_key 将加密保存",
    http={"method": "POST", "path": "/model-cfgs", "tags": ["model"], "status": 201},
    tool=False, resident=False,
)
async def model_cfg_create(payload: schemas.CfgCreateIn, ctx) -> schemas.CfgOut:
    ctx.require("model:cfg:create")
    assert ctx.db is not None
    dup = (await ctx.db.execute(select(ModelConfig).where(ModelConfig.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "模型名称已存在", 409, {"name": payload.name})
    cfg = ModelConfig(
        name=payload.name, model_type=payload.model_type, protocol=payload.protocol,
        base_url=payload.base_url, model_name=payload.model_name,
        api_key_enc=enc_key(payload.api_key) if payload.api_key else None,
        context_window=payload.context_window, max_output=payload.max_output,
        supports_thinking=payload.supports_thinking, thinking_levels=payload.thinking_levels,
        supports_vision=payload.supports_vision, supports_tools=payload.supports_tools,
        temperature_default=payload.temperature_default,
        enabled=payload.enabled, is_default=False,
    )
    ctx.db.add(cfg)
    await ctx.db.flush()
    if payload.is_default:
        await _clear_defaults(ctx.db, cfg.model_type, keep_id=cfg.id)
        cfg.is_default = True
    await ctx.db.commit()
    return _out(cfg)


@service(
    perm="model:cfg:read", effect="read", name="model_cfg_list",
    description="列出已登记的模型（api_key 打码回显；全局共享池）",
    http={"method": "GET", "path": "/model-cfgs", "tags": ["model"], "status": 200},
    tool=False, resident=False,
)
async def model_cfg_list(payload: schemas.CfgListIn, ctx) -> ServiceResult:
    ctx.require("model:cfg:read")
    assert ctx.db is not None
    stmt = select(ModelConfig).order_by(ModelConfig.id)
    if payload.model_type:
        stmt = stmt.where(ModelConfig.model_type == payload.model_type)
    page = await paginate(ctx.db, stmt, cursor_col=ModelConfig.id, row_key=lambda r: r.id,
                          cursor=payload.cursor, size=payload.size)
    return Page(items=[_out(c) for c in page.items], next_cursor=page.next_cursor)


@service(
    perm="model:cfg:update", effect="write", name="model_cfg_update",
    description="修改模型配置；api_key 留空表示保留原密钥",
    http={"method": "PATCH", "path": "/model-cfgs/{cfg_id}", "tags": ["model"], "status": 200},
    tool=False, resident=False,
)
async def model_cfg_update(payload: schemas.CfgUpdateIn, ctx) -> schemas.CfgOut:
    ctx.require("model:cfg:update")
    assert ctx.db is not None
    cfg = await _get(ctx.db, payload.cfg_id)
    data = payload.model_dump(exclude_unset=True)
    new_key = data.pop("api_key", None)
    if new_key:  # 空串/None 均不覆盖（§4.8）
        cfg.api_key_enc = enc_key(new_key)
    for k, v in data.items():
        if k != "cfg_id" and v is not None:
            setattr(cfg, k, v)
    # 人工勾选 = 确定值：同步进 probe_result.capabilities，让首启回填（only_missing）
    # 认得「这是人工值别覆盖」。不记这一步，人工位只活在列上，重启探测就会把它冲掉。
    manual = {k: getattr(cfg, "supports_" + k) for k in probe.CAPS
              if ("supports_" + k) in data}
    if manual:
        prev = dict(cfg.probe_result or {})
        tri = probe.stored_caps(prev)
        tri.update(manual)
        prev["capabilities"] = tri
        cfg.probe_result = prev
    if data.get("is_default"):
        await _clear_defaults(ctx.db, cfg.model_type, keep_id=cfg.id)
    await ctx.db.commit()
    return _out(cfg)


@service(
    perm="model:cfg:delete", effect="destructive", name="model_cfg_delete",
    description="删除模型（仅系统管理员）",
    http={"method": "DELETE", "path": "/model-cfgs/{cfg_id}", "tags": ["model"], "status": 200},
    tool=False, resident=False,
)
async def model_cfg_delete(payload: schemas.CfgIdIn, ctx) -> OkOut:
    if not ctx.is_system_admin:  # 先门后查：不泄露存在性
        raise ApiError("forbidden", "仅系统管理员可删除模型", 403)
    assert ctx.db is not None
    cfg = (await ctx.db.execute(select(ModelConfig).where(ModelConfig.id == payload.cfg_id))).scalar_one_or_none()
    if cfg is None:
        raise ApiError("not_found", "模型不存在", 404, {"cfg_id": payload.cfg_id})
    was_default = cfg.is_default
    await ctx.db.delete(cfg)
    await ctx.db.commit()
    if was_default:  # 默认位不空置：补位给最早启用中的同型模型
        nxt = (await ctx.db.execute(
            select(ModelConfig).where(ModelConfig.model_type == cfg.model_type,
                                       ModelConfig.enabled.is_(True)).order_by(ModelConfig.id)
        )).scalars().first()
        if nxt is not None:
            nxt.is_default = True
            await ctx.db.commit()
    return OkOut(ok=True)


async def _apply_probe(ctx, cfg: ModelConfig, out: probe.ProbeOutcome) -> schemas.ProbeOut:
    """探测结果落库。假阴性红线（计划原话）：含糊/超时 → 能力位**不改存储值**，
    probe_result 的 capabilities 原样存三态（None=unknown，前端渲染 ?? 而非 ✗）。

    存储位基表取 supports_* 列本身（人工勾选值也在列上）：merge 后含糊档 = 列原值，
    「不改」由构造保证而非事后补救。
    """
    stored = {k: getattr(cfg, "supports_" + k) for k in probe.CAPS}
    caps = probe.merge_caps(stored, out.caps, only_missing=False)
    for k in probe.CAPS:
        # 含糊档 merge 回来就是列原值——「不改存储值」由构造保证（变异红线测试的靶点）
        setattr(cfg, "supports_" + k, bool(caps[k]))
    if out.dimensions is not None:
        cfg.embed_dimensions = out.dimensions  # §6.8：embed("ping") 回填维度
    result = {"ok": out.ok, "latency_ms": out.latency_ms, "capabilities": dict(out.caps),
              "dimensions": out.dimensions, "error": out.error,
              "checked_at": utc_now_iso()}
    cfg.probe_result = result
    await ctx.db.commit()
    return schemas.ProbeOut(ok=out.ok, latency_ms=out.latency_ms, capabilities=dict(caps),
                            error=out.error, embed_dimensions=cfg.embed_dimensions,
                            probe_result=result)


@service(
    perm="model:cfg:read", effect="read", name="model_cfg_probe",
    description="逐能力真探（§6.8）：连通 + tools/thinking/vision 逐项探测回填能力位；"
                "EMBEDDING 走 embed(ping) 回填 embed_dimensions；含糊态标 unknown 不改存储值",
    http={"method": "POST", "path": "/model-cfgs/{cfg_id}/probe", "tags": ["model"], "status": 200},
    tool=False, resident=False,
)
async def model_cfg_probe(payload: schemas.CfgIdIn, ctx) -> schemas.ProbeOut:
    ctx.require("model:cfg:read")
    assert ctx.db is not None
    cfg = await _get(ctx.db, payload.cfg_id)
    caps = {"tools": cfg.supports_tools, "thinking": cfg.supports_thinking, "vision": cfg.supports_vision}
    if is_fake(cfg.base_url):  # 演示/测试模型：脚本逐行可读即算通（不依赖 agent 网关，shared 约定）
        t0 = time.perf_counter()
        n = len([ln for ln in fixture_path(cfg.base_url).read_text(encoding="utf-8").splitlines() if ln.strip()])
        latency = int((time.perf_counter() - t0) * 1000)
        result = {"ok": True, "latency_ms": latency, "events": n, "capabilities": caps,
                  "checked_at": utc_now_iso()}
        cfg.probe_result = result
        await ctx.db.commit()
        return schemas.ProbeOut(ok=True, latency_ms=latency, capabilities=caps, probe_result=result)
    if cfg.protocol != "OPENAI_COMPAT":  # 探测形状只按 OAI 兼容设计；没测过就不假装测过
        return await _apply_probe(ctx, cfg, probe.ProbeOutcome(
            False, 0, {k: None for k in probe.CAPS} if cfg.model_type == "CHAT" else {},
            None, "探测未实现该协议（ANTHROPIC 未实测，能力位保持 unknown）"))
    try:
        key = dec_key(cfg.api_key_enc) if cfg.api_key_enc else ""
    except ApiError:  # 主密钥变更：不带 key 照样探连通，探测不许 500
        key = ""
    target = probe.ProbeTarget(base_url=cfg.base_url, api_key=key,
                               model_name=cfg.model_name, model_type=cfg.model_type)
    return await _apply_probe(ctx, cfg, await probe.run_probe(target))
