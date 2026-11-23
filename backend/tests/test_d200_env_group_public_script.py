"""D200：环境组（C1）+ 公共脚本（C2）。"""
from __future__ import annotations

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, hb, pid: str, uid: str, role: str = "MEMBER") -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=hb)
    assert r.status_code == 200, r.text


async def _env(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/envs", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_env_group_crud_and_envs(client, make_user) -> None:
    _, h = await make_user("d200e", admin=True)
    pid = await _proj(client, h, "D200环境组")
    e1 = await _env(client, h, pid, "测试")
    e2 = await _env(client, h, pid, "预发")
    g = await client.post(_BASE + "/env-groups", json={
        "project_id": pid, "name": "回归组", "description": "回归用", "env_ids": [e1["id"]],
    }, headers=h)
    assert g.status_code == 201, g.text
    gid = g.json()["id"]
    assert [x["name"] for x in g.json()["envs"]] == ["测试"]

    dup = await client.post(_BASE + "/env-groups", json={"project_id": pid, "name": "回归组"}, headers=h)
    assert dup.status_code == 409
    bad = await client.post(_BASE + "/env-groups", json={
        "project_id": pid, "name": "坏组", "env_ids": ["nope"],
    }, headers=h)
    assert bad.status_code == 422 and bad.json()["code"] == "unknown_env"

    add = await client.post(_BASE + f"/env-groups/{gid}/envs", json={
        "project_id": pid, "group_id": gid, "env_ids": [e2["id"]], "mode": "append",
    }, headers=h)
    assert add.status_code == 200
    lst = await client.get(_BASE + "/env-groups", params={"project_id": pid}, headers=h)
    assert [x["name"] for x in lst.json()["items"][0]["envs"]] == ["测试", "预发"]

    rm = await client.post(_BASE + f"/env-groups/{gid}/envs/{e1['id']}/delete",
                           json={"project_id": pid, "group_id": gid, "env_id": e1["id"]}, headers=h)
    assert rm.status_code == 200
    assert [x["name"] for x in (await client.get(
        _BASE + f"/env-groups/{gid}", params={"project_id": pid}, headers=h)).json()["envs"]] == ["预发"]

    d = await client.post(_BASE + f"/env-groups/{gid}/delete",
                          json={"project_id": pid, "group_id": gid}, headers=h)
    assert d.status_code == 200
    # 环境本体还在
    envs = await client.get(_BASE + "/envs", params={"project_id": pid}, headers=h)
    assert {x["name"] for x in envs.json()["items"]} == {"测试", "预发"}


async def test_public_script_crud_version_status(client, make_user) -> None:
    _, h = await make_user("d200s", admin=True)
    pid = await _proj(client, h, "D200脚本")
    c = await client.post(_BASE + "/public-scripts", json={
        "project_id": pid, "name": "登录函数", "language": "python",
        "content": "def login():\n    pass\n",
    }, headers=h)
    assert c.status_code == 201, c.text
    sid = c.json()["id"]
    assert c.json()["version"] == 1 and c.json()["enabled"] is True

    dup = await client.post(_BASE + "/public-scripts", json={
        "project_id": pid, "name": "登录函数", "content": "x",
    }, headers=h)
    assert dup.status_code == 409
    u = await client.patch(_BASE + f"/public-scripts/{sid}", json={
        "project_id": pid, "script_id": sid, "content": "def login():\n    return 1\n",
    }, headers=h)
    assert u.status_code == 200 and u.json()["version"] == 2
    same = await client.patch(_BASE + f"/public-scripts/{sid}", json={
        "project_id": pid, "script_id": sid, "description": "只改说明",
    }, headers=h)
    assert same.json()["version"] == 2, "内容没变不涨版本"
    st = await client.post(_BASE + f"/public-scripts/{sid}/status",
                           json={"project_id": pid, "script_id": sid, "enabled": False}, headers=h)
    assert st.status_code == 200 and st.json()["enabled"] is False
    lst = await client.get(_BASE + "/public-scripts", params={"project_id": pid, "enabled_only": True},
                           headers=h)
    assert lst.json()["items"] == []
    assert (await client.post(_BASE + f"/public-scripts/{sid}/delete",
                              json={"project_id": pid, "script_id": sid}, headers=h)).status_code == 200


async def test_permissions(client, make_user) -> None:
    boss, hb = await make_user("d200p", admin=True)
    ro, hr = await make_user("d200p2")
    pid = await _proj(client, hb, "D200权限")
    await _member(client, hb, pid, ro.id, "READONLY")
    assert (await client.get(_BASE + "/env-groups", params={"project_id": pid}, headers=hr)).status_code == 200
    deny_g = await client.post(_BASE + "/env-groups", json={"project_id": pid, "name": "只读组"}, headers=hr)
    assert deny_g.status_code == 403 and deny_g.json()["details"]["perm"] == "env:group:create"
    assert (await client.get(_BASE + "/public-scripts", params={"project_id": pid},
                             headers=hr)).status_code == 200
    deny_s = await client.post(_BASE + "/public-scripts", json={
        "project_id": pid, "name": "只读脚本", "content": "x",
    }, headers=hr)
    assert deny_s.status_code == 403 and deny_s.json()["details"]["perm"] == "project:script:create"
