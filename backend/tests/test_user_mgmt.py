"""T5 IAM 收尾：用户管理 / 自助改密 / 角色目录。

R30：改密与角色目录 = 认证即可（auth 类路由先于权限体系，与 login/me 同类）；
     用户 CRUD = system:user:* 权限位（非系统管理员恒 403）。
"""
from __future__ import annotations

from tests.conftest import ADMIN_PASSWORD


async def _admin_h(client, session):
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


async def test_user_create_list_disable(client, session, make_user) -> None:
    h = await _admin_h(client, session)
    r = await client.post("/api/v1/system/users", json={"account": "newbie", "name": "新员工",
                                                    "password": "NewPass@123"}, headers=h)
    assert r.status_code == 201, r.text
    uid = r.json()["id"]
    assert r.json()["status"] == "active" and "password" not in r.text
    # D171：UserOut 必须把 TimestampMixin 的 created_at 吐出来——非空、且是带时区偏移的
    # ISO 串（前端 UsersTab「创建时间」列吃这条；裸 naive 串会被按本地时区解析差 8 小时）。
    from datetime import datetime

    created = r.json()["created_at"]
    assert created is not None and isinstance(created, str), r.text
    parsed = datetime.fromisoformat(created)
    assert parsed.tzinfo is not None, f"created_at 必须带时区偏移: {created!r}"
    # 撞库 409
    r2 = await client.post("/api/v1/system/users", json={"account": "newbie", "name": "x",
                                                     "password": "NewPass@123"}, headers=h)
    assert r2.status_code == 409 and r2.json()["code"] == "conflict"
    # 列表可见且不吐密码学材料
    r3 = await client.get("/api/v1/system/users", headers=h)
    assert r3.status_code == 200
    row = next(x for x in r3.json()["items"] if x["account"] == "newbie")
    assert row["created_at"] is not None, "列表行必须带 created_at（D171）"
    assert datetime.fromisoformat(row["created_at"]).tzinfo is not None, row["created_at"]
    assert "newbie" in [x["account"] for x in r3.json()["items"]]
    assert "password_hash" not in r3.text and "NewPass@123" not in r3.text
    # 禁用：登录 401 + 旧 token 401
    _, hh = await make_user("newbie_login_probe")  # 占位避免账号名冲突理解，忽略
    r4 = await client.post("/api/v1/system/users/" + uid + "/status",
                           json={"user_id": uid, "status": "disabled"}, headers=h)
    assert r4.status_code == 200, r4.text
    r5 = await client.post("/api/v1/auth/login", json={"account": "newbie", "password": "NewPass@123"})
    assert r5.status_code == 401


async def test_disabled_user_old_token_dead(client, session, make_user) -> None:
    h = await _admin_h(client, session)
    victim, hv = await make_user("victim")
    assert (await client.get("/api/v1/auth/me", headers=hv)).status_code == 200
    r = await client.post("/api/v1/system/users/" + victim.id + "/status",
                          json={"user_id": victim.id, "status": "disabled"}, headers=h)
    assert r.status_code == 200
    assert (await client.get("/api/v1/auth/me", headers=hv)).status_code == 401


async def test_non_admin_cannot_manage_users(client, session, make_user) -> None:
    await _admin_h(client, session)
    _, hp = await make_user("plain")
    r = await client.get("/api/v1/system/users", headers=hp)
    assert r.status_code == 403
    r2 = await client.post("/api/v1/system/users", json={"account": "sneaky", "name": "x",
                             "password": "NewPass@123"}, headers=hp)
    assert r2.status_code == 403


async def test_admin_cannot_disable_self(client, session) -> None:
    h = await _admin_h(client, session)
    me = (await client.get("/api/v1/auth/me", headers=h)).json()
    r = await client.post("/api/v1/system/users/" + me["id"] + "/status",
                          json={"user_id": me["id"], "status": "disabled"}, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "invalid_input"


async def test_self_password_change_flow(client, session, make_user) -> None:
    await _admin_h(client, session)
    u, hu = await make_user("rotator")
    # 旧密不对 → 403（与登录同码族，不叫 validation）
    r = await client.post("/api/v1/auth/password",
                          json={"old_password": "WrongPass@9", "new_password": "FreshPass@9"}, headers=hu)
    assert r.status_code == 403 and r.json()["code"] == "bad_credentials"
    # 正确旧密 → 200；新密可登录、旧密不可
    r2 = await client.post("/api/v1/auth/password",
                           json={"old_password": "Passw0rd!", "new_password": "FreshPass@9"}, headers=hu)
    assert r2.status_code == 200, r2.text
    r3 = await client.post("/api/v1/auth/login", json={"account": "rotator", "password": "FreshPass@9"})
    assert r3.status_code == 200
    r4 = await client.post("/api/v1/auth/login", json={"account": "rotator", "password": "Passw0rd!"})
    assert r4.status_code == 401


async def test_role_catalog_visible_to_any_member(client, session, make_user) -> None:
    await _admin_h(client, session)
    _, hp = await make_user("catalogue")
    r = await client.get("/api/v1/role-templates", headers=hp)
    assert r.status_code == 200
    codes = {x["code"] for x in r.json()["items"]}
    assert codes == {"SYSTEM_ADMIN", "PROJECT_ADMIN", "MEMBER", "READONLY"}
    # 无 token 不可见
    r2 = await client.get("/api/v1/role-templates")
    assert r2.status_code == 401