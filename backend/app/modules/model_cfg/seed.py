"""演示/开发种子：幂等地保证存在一个默认 CHAT 模型（env 驱动）。

首启探测（1E T8，§6.8「首次启动跑能力探测」）：seed 之后异步跑一次逐能力探测回填
能力位/维度。网关不可达 = 静默跳过（一次性 warning，同心跳哲学：第一次提醒，之后
静默）；幂等 = 跑两次不多行，且只回填 unknown 之外的空位——已探测出的确定值与人
工值不被第二次探测覆盖（merge only_missing 语义）。
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.security import dec_key, enc_key
from app.modules.model_cfg import probe
from app.modules.model_cfg.models import ModelConfig
from app.shared.fakeuri import is_fake
from app.shared.utcnow import utc_now_iso

logger = logging.getLogger(__name__)
_warned_unreachable = False


def reset_warning_flags() -> None:
    """测试夹具用：把「已 warning」旗标拨回初值（同进程多次跑首启探测互不污染）。"""
    global _warned_unreachable
    _warned_unreachable = False


async def seed_default_model(db: AsyncSession) -> ModelConfig | None:
    # D130：配置只从 get_settings() 读。pydantic 把 .env / 环境变量装进 Settings，
    # 但**永不回填 os.environ**——以前 os.environ.get("TP_MODEL_SEED_*") 读的是死源：
    # backend/.env 里写了三个键也到不了这里，手册的 .env 指引从来没生效过。
    s = get_settings()
    base_url = s.model_seed_base_url
    model_name = s.model_seed_name
    if not base_url or not model_name:
        return None
    existing = (
        await db.execute(select(ModelConfig).where(ModelConfig.model_name == model_name,
                                                    ModelConfig.base_url == base_url))
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    has_default = (
        await db.execute(select(ModelConfig).where(ModelConfig.model_type == "CHAT",
                                                    ModelConfig.is_default.is_(True)))
    ).scalar_one_or_none()
    cfg = ModelConfig(name="seed-" + model_name, model_type="CHAT", protocol="OPENAI_COMPAT",
                      base_url=base_url, model_name=model_name,
                      api_key_enc=(lambda k: enc_key(k) if k else None)(s.model_seed_api_key or ""),
                      # §6.8 默认思考档 medium：出厂即带三档集合，thinking_default（唯一落点
                      # services.thinking_default）据此认 medium；探测出 supports_thinking 时也有档可显
                      thinking_levels=["low", "medium", "high"],
                      is_default=has_default is None, enabled=True)
    db.add(cfg)
    await db.commit()
    return cfg


async def probe_backfill(db: AsyncSession) -> int:
    """首启能力探测：对全部启用模型各跑一次，只回填 unknown 空位（幂等，§6.8）。

    - 网关不可达 → 静默跳过该行；同心跳哲学只 warning 一次（旗标复位靠 reset）；
    - 幂等：二次运行——行不新增（本函数不建行）；已有确定值（人工勾选或上次
      探测成功）不被覆盖（merge only_missing=True）；上次 unknown 的空位这次测出来
      才补上；
    - 假 URL（fake://）与非 OAI 协议跳过：探测形状是真 HTTP，不拿脚本喂自己。
    返回回填（实际写库）的行数，仅测试/日志用；本函数永不向外抛。
    """
    global _warned_unreachable
    try:
        rows = (await db.execute(select(ModelConfig).where(
            ModelConfig.enabled.is_(True), ModelConfig.protocol == "OPENAI_COMPAT"))).scalars().all()
    except Exception:  # noqa: BLE001  首启探测不许把 lifespan 带崩
        logger.warning("首启探测跳过：模型表读取异常", exc_info=True)
        return 0
    wrote = 0
    for cfg in rows:
        if is_fake(cfg.base_url):
            continue
        try:
            key = dec_key(cfg.api_key_enc) if cfg.api_key_enc else ""
        except ApiError:  # 主密钥变更：不带 key 照样能探连通
            key = ""
        target = probe.ProbeTarget(base_url=cfg.base_url, api_key=key,
                                   model_name=cfg.model_name, model_type=cfg.model_type)
        out = await probe.run_probe(target)
        if not out.ok:
            if not _warned_unreachable:
                logger.warning("首启探测：网关 %s 不可达（%s），跳过回填（首次提醒，之后静默）",
                               cfg.base_url, out.error)
                _warned_unreachable = True
            continue
        _warned_unreachable = False  # 网关回来了，下次再断要重新提醒
        caps = probe.merge_caps(probe.stored_caps(cfg.probe_result), out.caps, only_missing=True)
        touched = False
        for k in probe.CAPS:
            cur = getattr(cfg, "supports_" + k)
            if caps[k] is not None and caps[k] != cur:
                setattr(cfg, "supports_" + k, caps[k])
                touched = True
        if out.dimensions is not None and cfg.embed_dimensions != out.dimensions:
            cfg.embed_dimensions = out.dimensions
            touched = True
        tri = {k: (caps[k] if caps[k] is not None else None) for k in probe.CAPS}
        result = {"ok": True, "latency_ms": out.latency_ms, "capabilities": tri,
                  "dimensions": cfg.embed_dimensions, "checked_at": _now()}
        # probe_result 只在能力位有变或首次落账时改写——第二次同果运行 = 零写入（幂等钉）
        if touched or (cfg.probe_result or {}).get("capabilities") != tri:
            cfg.probe_result = result
            wrote += 1
    if wrote:
        await db.commit()
    return wrote


def _now() -> str:
    # D135：此处曾是 time.strftime("%Y-%m-%dT%H:%M:%S") —— 那是**本地**墙钟的裸串，
    # 而前端 parseUtc 把无偏移串按 UTC 读（timefmt.ts + timefmt.test.ts 钉住），
    # 东八区偏 +8h。口径统一在 app/shared/utcnow.py，理由见那份文件头。
    return utc_now_iso()


_startup_tasks: set = set()


def schedule_startup_probe() -> None:
    """lifespan 入口：后台任务跑一次首启探测，不阻塞启动（§6.8「首次启动跑能力探测」）。

    自持会话（全局 maker）——lifespan 的 db 在 yield 后就关了，后台任务不许借用。
    引用挂在模块级 set 防 GC；异常全吸收（探测坏了 ≠ 平台起不来）。
    """
    import asyncio

    from app.core.db import get_sessionmaker

    async def _run() -> None:
        try:
            async with get_sessionmaker()() as s:
                await probe_backfill(s)
        except Exception:  # noqa: BLE001
            logger.warning("首启探测后台任务异常（忽略，能力位保持原值）", exc_info=True)

    t = asyncio.get_running_loop().create_task(_run())
    _startup_tasks.add(t)
    t.add_done_callback(_startup_tasks.discard)
