"""D130：seed_default_model 的配置源必须唯一是 get_settings()，os.environ 不再是入口。

来历：seed 以前用 os.environ.get("TP_MODEL_SEED_*") 读配置，但 pydantic 的 env_file
机制把 .env 装进 Settings 后**永不回填 os.environ**——手册（README-1a-demo.md §6）
教人在 backend/.env 里设这三个键，从来没生效过；Settings 里声明的同名三键是死代码。

钉的形状（对变异逐一敏感）：
- (a) Settings 有值 → 建行；跑两次仍一行，第二次命中既有行（幂等钉保留）；
- (b) D130 命门对：os.environ 有值而 Settings 为空 → 必须 no-op（env 不再是源）；
  同值搬进 Settings → 建行，且落库的 base_url/model_name 取自 Settings 而非 env
  （两腿各钉一次：只改 name 或只改 base_url 的半吊子修复都会被 (b) 拍红）；
- (c) Settings 里 base_url 为空 → None、零写入（no-op 语义原样保留）。

夹具口径：monkeypatch.setattr(get_settings(), ...) 与 test_adb_core.py 等既有
settings 注入同款；os.environ 三个键每个用例先 delenv，杜绝开发机真实环境串测。
"""
from __future__ import annotations

ENV_KEYS = ("TP_MODEL_SEED_BASE_URL", "TP_MODEL_SEED_NAME", "TP_MODEL_SEED_API_KEY")


def _clean_env(monkeypatch) -> None:
    for k in ENV_KEYS:
        monkeypatch.delenv(k, raising=False)


def _seed_settings(monkeypatch, *, base_url: str, name: str, api_key: str = ""):
    from app.core.config import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "model_seed_base_url", base_url)
    monkeypatch.setattr(s, "model_seed_name", name)
    monkeypatch.setattr(s, "model_seed_api_key", api_key)
    return s


async def test_seed_from_settings_idempotent(session, monkeypatch) -> None:
    """(a) Settings 有值 → 建行；两次调用仍一行，第二次返回既有行。"""
    from sqlalchemy import func, select

    from app.modules.model_cfg import seed
    from app.modules.model_cfg.models import ModelConfig

    _clean_env(monkeypatch)
    _seed_settings(monkeypatch, base_url="http://d130-gw:1/v1", name="d130-a")

    cfg = await seed.seed_default_model(session)
    assert cfg is not None and cfg.model_name == "d130-a" and cfg.base_url == "http://d130-gw:1/v1"
    again = await seed.seed_default_model(session)
    assert again is not None and again.id == cfg.id, "第二次调用没命中既有行（幂等钉）"
    n = await session.scalar(select(func.count()).select_from(ModelConfig))
    assert n == 1, "seed 跑两次多出了行"


async def test_d130_os_environ_is_not_a_source(session, monkeypatch) -> None:
    """(b) D130 命门：env 有值 + Settings 空 → no-op；同值进 Settings → 建行且取自 Settings。"""
    from sqlalchemy import func, select

    from app.modules.model_cfg import seed
    from app.modules.model_cfg.models import ModelConfig

    _clean_env(monkeypatch)
    monkeypatch.setenv("TP_MODEL_SEED_BASE_URL", "http://env-should-not-win/v1")
    monkeypatch.setenv("TP_MODEL_SEED_NAME", "env-should-not-win")
    # 死源腿：Settings 全空，env 全有 → 必须看不见 env（os.environ 回潮的变异在这里红）
    _seed_settings(monkeypatch, base_url="", name="")
    assert await seed.seed_default_model(session) is None, "os.environ 仍被当成配置源（D130 未修）"
    assert await session.scalar(select(func.count()).select_from(ModelConfig)) == 0

    # 活源腿：同位键搬进 Settings → 建行；字段必须取自 Settings 而不是 env
    # （「name 走 Settings、base_url 仍走 os.environ」的半吊子变异在这里红：
    #   那样落库的 base_url 会是 env-should-not-win，或 base_url 空直接 no-op）
    _seed_settings(monkeypatch, base_url="http://settings-wins/v1", name="settings-wins")
    cfg = await seed.seed_default_model(session)
    assert cfg is not None, "Settings 有值却没建行"
    assert cfg.base_url == "http://settings-wins/v1", "base_url 取的不是 Settings 值：" + cfg.base_url
    assert cfg.model_name == "settings-wins"
    assert await session.scalar(select(func.count()).select_from(ModelConfig)) == 1


async def test_seed_empty_base_url_noop(session, monkeypatch) -> None:
    """(c) Settings 里 base_url 为空 → None、零写入（去掉空判、建垃圾行的变异在这里红）。"""
    from sqlalchemy import func, select

    from app.modules.model_cfg import seed
    from app.modules.model_cfg.models import ModelConfig

    _clean_env(monkeypatch)
    _seed_settings(monkeypatch, base_url="", name="name-without-url")
    assert await seed.seed_default_model(session) is None
    assert await session.scalar(select(func.count()).select_from(ModelConfig)) == 0
