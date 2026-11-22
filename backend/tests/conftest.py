"""测试夹具：远端 MySQL 测试库（ledger R1/R2）+ fakeredis。

pytest-asyncio 1.x 每用例独立事件循环 ⇒ 引擎按用例创建（NullPool），
建库与 alembic 迁移放同步夹具（pymysql），不跨循环持有连接。
"""
from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest
import pytest_asyncio

# 连接串**只**从进程环境或 backend/.env 读（口径见 app/shared/localenv.py）。
# 这里以前是 `os.environ.get("TP_DB_URL", "<内网库的真口令>")` —— 一套把真口令写进
# 公开仓库的默认值。`.env` 一直是 gitignore 的、`.env.example` 一直写 CHANGE_ME，
# 所以规矩本来就有，只有这几行默认值没执行它。
# **不给假默认值**是有意的：本机 3306 确实在听，但它的口令不是任何人能猜中的那个，
# 写个看着能连的默认值只会把「你没配」变成一屏 Access denied，比当场报错难查得多。
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.shared.localenv import require_env  # noqa: E402

_BASE = require_env("TP_DB_URL")
_SCHEMA = os.environ.get("TP_TEST_SCHEMA", "testpilot_t" + datetime.now(UTC).strftime("%H%M%S"))
_u = urlsplit(_BASE)
os.environ["TP_DB_URL"] = urlunsplit(_u._replace(path="/" + _SCHEMA))
os.environ.setdefault("TP_REDIS_URL", require_env("TP_REDIS_URL"))
os.environ.setdefault("TP_SECRET_KEY", "test-secret-key-0123456789abcdef")
os.environ.setdefault("TP_FERNET_KEY", "")
os.environ.setdefault("TP_ENV", "test")
os.environ.setdefault("TP_BOOTSTRAP_ACCOUNT", "admin")
# 测试专用口令：只给一次性临时 schema（_SCHEMA 带时分秒）用，不是任何环境的凭据。
# 与业主机 admin 口令**刻意不同**，抄错也不会拿它去连真库（守卫见 test_no_hardcoded_credentials.py）。
ADMIN_PASSWORD = "Test@LocalOnly"
os.environ.setdefault("TP_BOOTSTRAP_PASSWORD", ADMIN_PASSWORD)
# 默认 inline（R72）：pytest 没有 Celery worker，默认 celery 会让每条 enqueue 测试 503。
# setdefault 不覆盖显式声明——想跑 celery 端到端的测试（T24）自己 setenv/monkeypatch。
# inline 不是假执行：跑的是与 worker 同一份 run_graph（R42），差别只在谁起协程。
os.environ.setdefault("TP_EXEC_MODE", "inline")


def _sync_url(url: str) -> str:
    return url.replace("+asyncmy", "+pymysql")


@pytest.fixture(scope="session")
def db_url() -> str:
    """建库 + alembic upgrade head；会话结束删库。"""
    import pymysql
    from alembic import command
    from alembic.config import Config

    url = os.environ["TP_DB_URL"]
    u = urlsplit(url)
    schema = u.path.lstrip("/")
    conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username, password=u.password, autocommit=True)
    with conn.cursor() as cur:
        cur.execute(
            "CREATE DATABASE IF NOT EXISTS " + chr(96) + schema + chr(96) +
            " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
        )
    conn.close()

    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    cfg.set_main_option("sqlalchemy.url", _sync_url(url))
    command.upgrade(cfg, "head")
    yield url
    conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username, password=u.password, autocommit=True)
    with conn.cursor() as cur:
        cur.execute("DROP DATABASE IF EXISTS " + chr(96) + schema + chr(96))
    conn.close()


@pytest.fixture(scope="session")
def sync_url(db_url: str) -> str:
    return _sync_url(db_url)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest_asyncio.fixture()
async def engine(db_url: str):
    """每用例独立引擎（NullPool），避免跨事件循环复用连接。"""
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    eng = create_async_engine(db_url, poolclass=NullPool)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture()
async def conn(engine):
    """每用例独占连接 + TRUNCATE 全表（干净起点）。"""
    from sqlalchemy import text

    async with engine.connect() as c:
        await c.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        res = await c.execute(
            text("SELECT table_name FROM information_schema.tables "
                 "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")
        )
        for (tbl,) in res.fetchall():
            await c.execute(text("TRUNCATE TABLE " + chr(96) + tbl + chr(96)))
        await c.execute(text("SET FOREIGN_KEY_CHECKS=1"))
        await c.commit()
        yield c


@pytest_asyncio.fixture()
async def session(conn) -> AsyncIterator:
    """绑定在已 TRUNCATE 的连接上的 AsyncSession。"""
    from sqlalchemy.ext.asyncio import AsyncSession

    s = AsyncSession(bind=conn, expire_on_commit=False, autoflush=False)
    yield s
    await s.rollback()


@pytest_asyncio.fixture()
async def app(session):
    """应用实例，get_db 覆盖到测试会话。"""
    from app.core.db import get_db
    from app.main import create_app

    a = create_app()

    async def _override():
        yield session

    a.dependency_overrides[get_db] = _override
    yield a


@pytest_asyncio.fixture()
async def client(app):
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c2:
        yield c2


@pytest_asyncio.fixture()
async def make_user(session):
    """造用户工具：make_user("a1", admin=False) -> (User, headers)。"""
    from app.core.security import create_access_token, hash_password
    from app.modules.iam.models import User

    async def _make(account: str, *, admin: bool = False, name: str | None = None, password: str = "Passw0rd!"):
        u = User(account=account, name=name or account, password_hash=hash_password(password),
                 is_system_admin=admin, status="active")
        session.add(u)
        await session.commit()
        return u, {"Authorization": "Bearer " + create_access_token(u.id)}

    return _make
