"""D198：个人中心 + API Key（资料/最近项目/我的资产/密钥签发与鉴权）。"""
from __future__ import annotations

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_profile_recent_projects_and_assets(client, make_user) -> None:
    boss, h = await make_user("d198p", admin=True)
    pid = await _proj(client, h, "D198个人")
    p = await client.get(_BASE + "/personal/profile", headers=h)
    assert p.status_code == 200, p.text
    assert p.json()["account"] == "d198p" and p.json()["prefs"] == {}

    u = await client.patch(_BASE + "/personal/profile", json={
        "name": "新名字", "email": "new@example.com",
        "prefs": {"language": "zh-CN", "theme": "dark"},
    }, headers=h)
    assert u.status_code == 200
    assert u.json()["name"] == "新名字" and u.json()["email"] == "new@example.com"
    # prefs 合并而不是整包覆盖
    u2 = await client.patch(_BASE + "/personal/profile", json={"prefs": {"timezone": "Asia/Shanghai"}},
                            headers=h)
    assert u2.json()["prefs"] == {"language": "zh-CN", "theme": "dark", "timezone": "Asia/Shanghai"}

    recent = await client.get(_BASE + "/personal/recent-projects", headers=h)
    assert recent.status_code == 200
    assert any(x["id"] == pid for x in recent.json()["items"])

    assets = await client.get(_BASE + "/personal/my-assets", headers=h)
    assert assets.status_code == 200
    assert set(assets.json()["counts"]) == {
        "api_definitions", "api_cases", "scenarios", "ui_cases", "adb_cases",
        "functional_cases", "defects",
    }


async def test_api_key_create_auth_and_revoke(client, make_user) -> None:
    boss, h = await make_user("d198k", admin=True)
    other, ho = await make_user("d198k2")
    created = await client.post(_BASE + "/personal/api-keys", json={"name": "CI"}, headers=h)
    assert created.status_code == 201, created.text
    body = created.json()
    key = body["key"]
    assert key.startswith("tp_") and body["prefix"] == key[:12]

    # 明文不进列表
    lst = await client.get(_BASE + "/personal/api-keys", headers=h)
    assert [x["name"] for x in lst.json()["items"]] == ["CI"]
    assert "key" not in lst.json()["items"][0] and "key_hash" not in lst.json()["items"][0]

    # API Key 当 Bearer 用：/personal/profile 认得出同一个人
    me = await client.get(_BASE + "/personal/profile", headers={"Authorization": "Bearer " + key})
    assert me.status_code == 200 and me.json()["account"] == "d198k"
    # 别人不能吊销
    deny = await client.post(_BASE + f"/personal/api-keys/{body['id']}/revoke",
                             json={"key_id": body["id"]}, headers=ho)
    assert deny.status_code == 404
    ok = await client.post(_BASE + f"/personal/api-keys/{body['id']}/revoke",
                           json={"key_id": body["id"]}, headers=h)
    assert ok.status_code == 200
    gone = await client.get(_BASE + "/personal/profile", headers={"Authorization": "Bearer " + key})
    assert gone.status_code == 401


async def test_readonly_can_manage_own_keys(client, make_user) -> None:
    boss, hb = await make_user("d198r", admin=True)
    ro, hr = await make_user("d198r2")
    pid = await _proj(client, hb, "D198只读")
    r = await client.put(_BASE + f"/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"},
                         headers=hb)
    assert r.status_code == 200
    # 个人面不按项目角色门控
    assert (await client.get(_BASE + "/personal/profile", headers=hr)).status_code == 200
    created = await client.post(_BASE + "/personal/api-keys", json={"name": "RO"}, headers=hr)
    assert created.status_code == 201
