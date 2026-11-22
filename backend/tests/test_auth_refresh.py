"""refresh 令牌半区（蓝图 §3.4：JWT access(2h) + refresh(7d, HttpOnly Cookie)）。

核心安全性质：access 与 refresh 是两种 typ 的 JWT，互不通用——
access 过不了 /auth/refresh，refresh 过不了 Bearer 认证。这两条各钉一个测试。
"""
from __future__ import annotations

import time

from tests.conftest import ADMIN_PASSWORD


async def _login(client, session) -> dict:
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()


def _set_cookie_headers(res) -> list[str]:
    return [v for k, v in res.headers.items() if k.lower() == "set-cookie"]


async def test_login_sets_httponly_refresh_cookie(client, session) -> None:
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    cookies = _set_cookie_headers(r)
    refresh = [c for c in cookies if c.startswith("tp_refresh=")]
    assert len(refresh) == 1, f"登录应恰好下发一枚 refresh Cookie，实得 {cookies}"
    c = refresh[0].lower()
    assert "httponly" in c, c
    assert "samesite=lax" in c, c
    assert "path=/api/v1/auth" in c, c
    # conftest 里 TP_ENV=test → 明文 http 演示环境，Secure 必须关（否则 Cookie 根本存不进浏览器）
    assert "secure" not in c, c
    # HttpOnly 前提下令牌绝不进 JSON body（否则前端脚本可读，HttpOnly 白设）
    assert "tp_refresh" not in r.text


async def test_refresh_returns_working_access_token(client, session) -> None:
    await _login(client, session)
    r = await client.post("/api/v1/auth/refresh")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"]
    # 新 access 必须真的能用
    r2 = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + body["token"]})
    assert r2.status_code == 200 and r2.json()["account"] == "admin"
    # 轮换：refresh 同时重发 Set-Cookie，且不带出 refresh 本体
    cookies = _set_cookie_headers(r)
    assert any(c.startswith("tp_refresh=") for c in cookies), cookies
    assert "tp_refresh" not in r.text


async def test_access_token_rejected_at_refresh(client, session) -> None:
    """主安全性质①：access 令牌冒充 refresh → 401，绝不换发新令牌。"""
    out = await _login(client, session)
    # 用 access 覆盖 refresh Cookie 位，模拟持 token 者攻击刷新端点
    client.cookies.clear()
    client.cookies.set("tp_refresh", out["token"], path="/api/v1/auth")
    r = await client.post("/api/v1/auth/refresh")
    assert r.status_code == 401, r.text
    assert r.json()["code"] == "unauthorized"


async def test_refresh_token_rejected_as_bearer(client, session) -> None:
    """主安全性质②：refresh 令牌冒充 Bearer access → 401。"""
    await _login(client, session)
    r = await client.post("/api/v1/auth/refresh")
    assert r.status_code == 200
    # 从轮换响应里取新 refresh（Cookie 已同步进 httpx cookiejar）
    refresh_tok = next(c.value for c in client.cookies.jar if c.name == "tp_refresh" and c.path == "/api/v1/auth")
    r2 = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + refresh_tok})
    assert r2.status_code == 401, r2.text
    assert r2.json()["code"] == "unauthorized"


async def test_refresh_for_disabled_user_is_401(client, session) -> None:
    """禁用账号后，手里那枚 refresh 换不出新 access。

    这条测的是无状态设计里**唯一还活着的那道闸**：令牌不落库、没有拒绝名单，logout 也只是
    清 Cookie，所以「停用一个人」能真正生效的机制就只剩每次请求回表查 status（见
    security.create_refresh_token 的限制说明）。Bearer 那侧同样查（iam/deps.py:31），两条
    路径必须一起封——否则管理员在控制台点了停用，对方仍能靠 7 天有效的 refresh 每两小时
    续一次命，「停用」就成了只挡住一半的开关。
    """
    from sqlalchemy import select, update

    from app.modules.iam.models import User

    await _login(client, session)
    # 登录时签发的 refresh 已在 httpx cookiejar 里；先在停用前证明它能用（否则这条测试
    # 可能一直测的是「refresh 本来就不行」，那正是最容易假绿的形状）。
    assert (await client.post("/api/v1/auth/refresh")).status_code == 200

    await session.execute(update(User).where(User.account == "admin").values(status="disabled"))
    await session.commit()

    r = await client.post("/api/v1/auth/refresh")
    assert r.status_code == 401, r.text
    assert r.json()["code"] == "unauthorized"
    assert r.json()["message"] == "账号不可用"  # 与「令牌无效」区分开：不是过期，是人被停用

    # 停用前签发的 access（2h 内还没过期）也必须立刻失效——同一次停用应当两边都断
    from app.core.security import create_access_token

    uid = (await session.execute(select(User.id).where(User.account == "admin"))).scalar_one()
    r2 = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + create_access_token(uid)})
    assert r2.status_code == 401, r2.text
    assert r2.json()["message"] == "账号不可用"

    # 还原：这个 session 里的 admin 是全局引导账号，留着 disabled 会毒化同 session 的后续测试
    await session.execute(update(User).where(User.account == "admin").values(status="active"))
    await session.commit()


async def test_refresh_without_cookie_is_401(client, session) -> None:
    await _login(client, session)
    client.cookies.clear()
    r = await client.post("/api/v1/auth/refresh")
    assert r.status_code == 401 and r.json()["code"] == "unauthorized"


async def test_expired_refresh_is_401(client, session) -> None:
    """过期 refresh → 401：不睡觉，直接用测试密钥签一枚 exp 已过的 typ=refresh。"""
    import jwt

    await _login(client, session)
    expired = jwt.encode(
        {"sub": "00000000-0000-0000-0000-000000000000", "typ": "refresh",
         "iat": int(time.time()) - 7200, "exp": int(time.time()) - 3600},
        "test-secret-key-0123456789abcdef",
        algorithm="HS256",
    )
    client.cookies.clear()
    client.cookies.set("tp_refresh", expired, path="/api/v1/auth")
    r = await client.post("/api/v1/auth/refresh")
    assert r.status_code == 401 and r.json()["code"] == "unauthorized"


async def test_logout_clears_cookie(client, session) -> None:
    await _login(client, session)
    assert client.cookies.get("tp_refresh")
    r = await client.post("/api/v1/auth/logout")
    assert r.status_code == 200 and r.json() == {"ok": True}
    cookies = _set_cookie_headers(r)
    cleared = [c for c in cookies if c.startswith("tp_refresh=")]
    assert len(cleared) == 1, cookies
    # delete_cookie 的形态：值为空 + 过期时间在过去（1970）
    assert "tp_refresh=;" in cleared[0] or "tp_refresh=\"\";" in cleared[0], cleared[0]
    assert "expires=thu, 01 jan 1970" in cleared[0].lower() or "max-age=0" in cleared[0].lower(), cleared[0]
    assert "path=/api/v1/auth" in cleared[0].lower(), cleared[0]


def test_secure_flag_follows_env(monkeypatch) -> None:
    """dev/test 明文 http 演示 → Secure 关；其余环境 → Secure 开。"""
    from app.modules.iam import routes

    class _S:
        env = "prod"

    monkeypatch.setattr(routes, "get_settings", lambda: _S())
    assert routes._refresh_cookie_secure() is True  # noqa: SLF001
    _S.env = "dev"
    assert routes._refresh_cookie_secure() is False  # noqa: SLF001


def test_token_ttl_defaults_match_blueprint() -> None:
    """§3.4 口径：access 2h、refresh 7d，钉进配置默认值。"""
    from app.core.config import Settings

    s = Settings(_env_file=None)
    assert s.jwt_ttl_hours == 2
    assert s.refresh_ttl_days == 7
