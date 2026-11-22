"""readyz 依赖探针（§6.10）：逐依赖状态、非 2xx 语义、超时兜底、Qdrant 诚实 skipped。

形状约定（与 errors.py 全局信封同形，不发明第二套错误体）：
- 全绿 → 200 {status:"ok", deps:{mysql,redis,qdrant}}；
- 任一 fail → 503 {code:"not_ready", message, details:{deps:...}}，探针免鉴权；
- qdrant 一期零客户端（D34），固定 skipped——最后一条用例钉死它，
  防止将来有人不改探测实现顺手写个假 ok。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker


def _bus_stub(ping):
    """假总线：只满足 readyz 用到的 get_bus().client.ping()，其余一概不给——
    探测实现若偷用别的原语，测试直接 AttributeError 响，而不是默默演成健康。"""
    return SimpleNamespace(client=SimpleNamespace(ping=ping))


def _client_for(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t")


@pytest_asyncio.fixture()
async def readyz_app(engine, monkeypatch):
    """裸 create_app（与 test_health.py 同形：探针不走 @service，不需要登录态）。

    get_sessionmaker 打到本用例的 NullPool engine：真实发 SELECT 1（真探测），但不
    建/不污染 app.core.db 的全局 engine——pytest-asyncio 每用例一个事件循环，
    默认池的全局连接跨循环复用会炸（conftest 同款理由）。
    """
    from app.main import create_app

    maker = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    monkeypatch.setattr("app.core.db.get_sessionmaker", lambda: maker)
    return create_app()


async def test_readyz_all_green(readyz_app, monkeypatch) -> None:
    import fakeredis.aioredis

    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.eventbus.get_bus", lambda: _bus_stub(fake.ping))
    async with _client_for(readyz_app) as c:
        r = await c.get("/api/v1/readyz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["deps"]["mysql"] == "ok"
    assert body["deps"]["redis"] == "ok"


async def test_readyz_redis_down_is_503(readyz_app, monkeypatch) -> None:
    async def _dead_ping():
        raise ConnectionError("Connection refused")

    monkeypatch.setattr("app.core.eventbus.get_bus", lambda: _bus_stub(_dead_ping))
    async with _client_for(readyz_app) as c:
        r = await c.get("/api/v1/readyz")
    assert r.status_code == 503
    # 错误体走全局 ApiError 信封：{code,message,details}，逐依赖状态在 details.deps。
    body = r.json()
    assert body["code"] == "not_ready"
    assert body["details"]["deps"]["redis"] == "fail"
    assert body["details"]["deps"]["mysql"] == "ok"


async def test_readyz_timeout_fails_fast(readyz_app, monkeypatch) -> None:
    """依赖挂死 → wait_for 到点掐断判 fail，而不是把探针演成无限挂起。

    超时线打到 0.05s：测的是「超时路径本身」，不是等满产品默认 2s。
    """
    async def _hang_ping():
        await asyncio.sleep(30)

    monkeypatch.setattr("app.core.eventbus.get_bus", lambda: _bus_stub(_hang_ping))
    monkeypatch.setattr("app.main.READY_PROBE_TIMEOUT_S", 0.05)
    async with _client_for(readyz_app) as c:
        r = await c.get("/api/v1/readyz")
    assert r.status_code == 503
    assert r.json()["details"]["deps"]["redis"] == "fail"


async def test_readyz_qdrant_is_honest_skipped(readyz_app, monkeypatch) -> None:
    """一期后端零 Qdrant 客户端/配置（core/config.py 无该项，grep 全仓仅剩 compose
    基建名与文档字样）——探测不存在的东西只能造假 ok，所以钉死 skipped。
    1F（D34）真接入向量路时，连探测实现带这条用例一起改，不许只改成 ok。"""
    import fakeredis.aioredis

    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.core.eventbus.get_bus", lambda: _bus_stub(fake.ping))
    async with _client_for(readyz_app) as c:
        r = await c.get("/api/v1/readyz")
    assert r.status_code == 200
    assert r.json()["deps"]["qdrant"] == "skipped"

    # 全仓配置面也不许悄悄长出 qdrant：长出了说明探测该补实现，这条先红提醒。
    from app.core.config import get_settings

    assert not any("qdrant" in f for f in get_settings().model_fields)
