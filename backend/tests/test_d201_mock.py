"""D201：API Mock（服务/规则 CRUD + 公开路由匹配）。"""
from __future__ import annotations

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _service(client, h, pid: str, name: str = "Mock服务") -> dict:
    r = await client.post(_BASE + "/mock-services", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _rule(client, h, pid: str, sid: str, **kw) -> dict:
    body = {"project_id": pid, "service_id": sid, "name": "规则", "method": "GET",
            "path": "/users", "match_type": "exact", "status_code": 200, **kw}
    r = await client.post(_BASE + "/mock-rules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_mock_public_routing_and_priority(client, make_user) -> None:
    _, h = await make_user("d201a", admin=True)
    pid = await _proj(client, h, "D201 Mock")
    s = await _service(client, h, pid)
    await _rule(client, h, pid, s["id"], name="用户", path="/users",
                headers={"X-Test": "1", "Content-Type": "application/json"},
                body='{"name":"alice"}', status_code=201)
    await _rule(client, h, pid, s["id"], name="前缀", path="/api", match_type="prefix",
                body="prefix-hit")
    await _rule(client, h, pid, s["id"], name="数字", path=r"^/items/\d+$", match_type="regex",
                body="regex-hit")
    await _rule(client, h, pid, s["id"], name="任意方法", path="/any", method="ANY", body="any")

    r = await client.get(f"/mock/{s['id']}/users")
    assert r.status_code == 201, r.text
    assert r.json() == {"name": "alice"} and r.headers["x-test"] == "1"
    assert (await client.get(f"/mock/{s['id']}/api/v1/x")).text == "prefix-hit"
    assert (await client.get(f"/mock/{s['id']}/items/42")).text == "regex-hit"
    assert (await client.post(f"/mock/{s['id']}/any")).text == "any"
    assert (await client.get(f"/mock/{s['id']}/nope")).status_code == 404
    assert (await client.post(f"/mock/{s['id']}/users")).status_code == 404

    # 关闭服务 → 公开入口 404
    up = await client.patch(_BASE + f"/mock-services/{s['id']}",
                            json={"project_id": pid, "service_id": s["id"], "enabled": False}, headers=h)
    assert up.status_code == 200
    assert (await client.get(f"/mock/{s['id']}/users")).status_code == 404


async def test_mock_rule_priority_and_test_endpoint(client, make_user) -> None:
    _, h = await make_user("d201p", admin=True)
    pid = await _proj(client, h, "D201优先级")
    s = await _service(client, h, pid)
    await _rule(client, h, pid, s["id"], name="低", path="/x", body="low", priority=0)
    hi = await _rule(client, h, pid, s["id"], name="高", path="/x", body="high", priority=10)
    assert (await client.get(f"/mock/{s['id']}/x")).text == "high"
    t = await client.post(_BASE + "/mock-rules/test",
                          json={"project_id": pid, "service_id": s["id"], "method": "GET", "path": "/x"},
                          headers=h)
    assert t.status_code == 200 and t.json()["matched"] is True
    assert t.json()["rule"]["id"] == hi["id"]
    bad = await client.post(_BASE + "/mock-rules", json={
        "project_id": pid, "service_id": s["id"], "name": "坏正则", "path": "(", "match_type": "regex",
    }, headers=h)
    assert bad.status_code == 422 and bad.json()["code"] == "bad_regex"


async def test_mock_crud_delete_cascade_and_permissions(client, make_user) -> None:
    boss, hb = await make_user("d201c", admin=True)
    ro, hr = await make_user("d201c2")
    pid = await _proj(client, hb, "D201权限")
    r = await client.put(_BASE + f"/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"},
                         headers=hb)
    assert r.status_code == 200
    s = await _service(client, hb, pid)
    await _rule(client, hb, pid, s["id"])
    assert (await client.get(_BASE + "/mock-services", params={"project_id": pid},
                             headers=hr)).status_code == 200
    deny = await client.post(_BASE + "/mock-services", json={"project_id": pid, "name": "只读"},
                             headers=hr)
    assert deny.status_code == 403 and deny.json()["details"]["perm"] == "mock:mock:create"
    d = await client.post(_BASE + f"/mock-services/{s['id']}/delete",
                          json={"project_id": pid, "service_id": s["id"]}, headers=hb)
    assert d.status_code == 200
    assert (await client.get(_BASE + "/mock-services", params={"project_id": pid},
                             headers=hb)).json()["items"] == []
