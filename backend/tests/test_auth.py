"""T3 认证与首次启动引导（Review Focus 1：伪造/过期 token → 401 unauthorized）。"""
from __future__ import annotations

import time

from tests.conftest import ADMIN_PASSWORD


async def _mk_admin(session) -> None:
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)


async def test_login_success_and_me(client, session) -> None:
    await _mk_admin(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"]
    assert body["user"]["account"] == "admin"
    assert body["user"]["is_system_admin"] is True
    assert "password_hash" not in body["user"]

    r2 = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + body["token"]})
    assert r2.status_code == 200
    assert r2.json()["account"] == "admin"


async def test_login_bad_credentials(client, session) -> None:
    await _mk_admin(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": "wrong-pass"})
    assert r.status_code == 401
    assert r.json()["code"] == "bad_credentials"
    r2 = await client.post("/api/v1/auth/login", json={"account": "ghost", "password": "whatever"})
    assert r2.status_code == 401
    assert r2.json() == r.json()


def _expired_token() -> str:
    import jwt

    return jwt.encode(
        {"sub": "00000000-0000-0000-0000-000000000000", "exp": int(time.time()) - 10},
        "test-secret-key-0123456789abcdef",
        algorithm="HS256",
    )


async def test_tampered_and_missing_token(client, session) -> None:
    await _mk_admin(session)
    r = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer not.a.jwt"})
    assert r.status_code == 401
    assert r.json()["code"] == "unauthorized"

    r2 = await client.get("/api/v1/auth/me")
    assert r2.status_code == 401 and r2.json()["code"] == "unauthorized"

    r3 = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + _expired_token()})
    assert r3.status_code == 401 and r3.json()["code"] == "unauthorized"


async def test_login_disabled_user(client, session) -> None:
    from app.core.security import hash_password
    from app.modules.iam.models import User

    session.add(
        User(account="u2", name="二", password_hash=hash_password("Passw0rd!"), is_system_admin=False, status="disabled")
    )
    await session.commit()
    r = await client.post("/api/v1/auth/login", json={"account": "u2", "password": "Passw0rd!"})
    assert r.status_code == 401
    assert r.json()["code"] == "bad_credentials"


async def test_bootstrap_idempotent(session) -> None:
    from sqlalchemy import func, select

    from app.modules.iam.bootstrap import run_bootstrap
    from app.modules.iam.models import User

    await run_bootstrap(session)
    await run_bootstrap(session)
    n = (await session.execute(select(func.count()).select_from(User))).scalar_one()
    assert n == 1, "bootstrap 必须幂等"


async def test_password_hash_roundtrip() -> None:
    from app.core.security import hash_password, verify_password

    h = hash_password("S3cret!pw")
    assert h.startswith("$2") and h != "S3cret!pw"
    assert verify_password("S3cret!pw", h) is True
    assert verify_password("nope", h) is False


async def test_fernet_key_helpers() -> None:
    from app.core.security import dec_key, enc_key

    token = enc_key("sk-abcdef123456")
    assert token != "sk-abcdef123456" and "sk-abcdef" not in token
    assert dec_key(token) == "sk-abcdef123456"
