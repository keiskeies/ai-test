"""D251：接口定义批量放入回收站（MS `/api/definition/delete/batch` 等价面）。

钉的契约：
1. 全有或全无——任一 id 不存在/已回收 → 404 且整批一行不动。
2. 重复 id → 422（拼错列表，不是「删两次」）。
3. 引用检查先全查完再写：任一被未回收场景引用 → 409 + blocked 清单，仍是零写入；
   批量不提供 force（强删必须逐个确认）。
4. 软回收语义与单删一致：正常列表消失、回收站可见、restore 可回来。
"""
from __future__ import annotations

REQ = {"method": "GET", "url": "http://127.0.0.1:9999/order/1", "body": {"type": "none"},
       "assertions": [{"type": "status_code", "expected": 200}]}


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)).json()["id"]
    return h, pid


async def _def(client, h, pid, name: str, path: str = "/order/1") -> dict:
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": path, "request": REQ,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _batch(client, h, pid, ids):
    return await client.post("/api/v1/api-definitions/batch-delete",
                             json={"project_id": pid, "definition_ids": ids}, headers=h)


async def _normal_names(client, h, pid) -> set[str]:
    r = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def _recycled_names(client, h, pid) -> set[str]:
    r = await client.get("/api/v1/api-definitions",
                         params={"project_id": pid, "recycled": "true"}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


# ══════════ 1. 正常批删 ══════════
async def test_batch_delete_recycles_all_and_is_visible_in_trash(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d251a")
    a = await _def(client, h, pid, "接口A", "/a")
    b = await _def(client, h, pid, "接口B", "/b")
    c = await _def(client, h, pid, "接口C", "/c")

    r = await _batch(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    assert await _normal_names(client, h, pid) == {"接口C"}
    assert await _recycled_names(client, h, pid) == {"接口A", "接口B"}
    # 单删语义没被批量改写：recycle 后单读 404、restore 能回来
    assert (await client.get("/api/v1/api-definitions/" + c["id"],
                             params={"project_id": pid}, headers=h)).status_code == 200
    rs = await client.post("/api/v1/api-definitions/" + a["id"] + "/restore",
                           json={"project_id": pid}, headers=h)
    assert rs.status_code == 200, rs.text
    assert await _normal_names(client, h, pid) == {"接口A", "接口C"}


# ══════════ 2. 全有或全无 ══════════
async def test_batch_delete_is_all_or_nothing(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d251b")
    a = await _def(client, h, pid, "接口A", "/a")
    b = await _def(client, h, pid, "接口B", "/b")

    r = await _batch(client, h, pid, [a["id"], "no-such-id"])
    assert r.status_code == 404, r.text
    assert r.json()["code"] == "not_found"
    assert r.json()["details"]["definition_ids"] == ["no-such-id"]
    # 一行都不许动
    assert await _normal_names(client, h, pid) == {"接口A", "接口B"}
    assert await _recycled_names(client, h, pid) == set()

    # 已回收的 id 也算「不存在」（与单删同码），整批仍不动
    assert (await _batch(client, h, pid, [a["id"]])).status_code == 200
    r2 = await _batch(client, h, pid, [a["id"], b["id"]])
    assert r2.status_code == 404, r2.text
    assert r2.json()["details"]["definition_ids"] == [a["id"]]
    assert await _normal_names(client, h, pid) == {"接口B"}

    # 重复 id → 422，同样零写入
    r3 = await _batch(client, h, pid, [b["id"], b["id"]])
    assert r3.status_code == 422, r3.text
    assert r3.json()["code"] == "validation_failed"
    assert await _normal_names(client, h, pid) == {"接口B"}


# ══════════ 3. 被场景引用 → 409 整批不动 ══════════
async def test_batch_delete_blocked_by_scenario_refs(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d251c")
    a = await _def(client, h, pid, "被引用", "/a")
    b = await _def(client, h, pid, "可删除", "/b")
    case = (await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": a["id"], "name": "用例A"}, headers=h)).json()
    graph = {"version": 1, "nodes": [{"key": "s0.step", "kind": "api_case", "ref": case["id"]}]}
    sc = await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": "下单场景", "step_graph": graph}, headers=h)
    assert sc.status_code == 201, sc.text

    r = await _batch(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "referenced_by_scenario"
    assert "整批一行未动" in body["message"] and "逐个回收" in body["message"]
    blocked = body["details"]["blocked"]
    assert [x["definition_id"] for x in blocked] == [a["id"]]
    assert blocked[0]["name"] == "被引用" and blocked[0]["count"] == 1
    assert blocked[0]["scenarios"][0]["scenario_name"] == "下单场景"
    # 即便另一个接口本来可删，也一样不许动
    assert await _normal_names(client, h, pid) == {"被引用", "可删除"}

    # 解除引用后同一批能过（证明刚才拦的确实是引用而不是别的）
    assert (await client.post("/api/v1/scenarios/" + sc.json()["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await _batch(client, h, pid, [a["id"], b["id"]])).status_code == 200
    assert await _normal_names(client, h, pid) == set()
