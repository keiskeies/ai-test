"""D252：接口定义批量从回收站恢复（与 D251 批量回收对称）。

钉的契约：
1. 全有或全无——任一不存在或不在回收站 → 404 + 列 ids，整批一行不动。
2. 重复 id / 空列表 → 422。
3. 恢复状态逐行定：有 request → complete，无 request → draft（不是一律 complete）。
4. 恢复后回到正常列表，回收站清空。
"""
from __future__ import annotations

REQ = {"method": "GET", "url": "http://127.0.0.1:9999/order/1", "body": {"type": "none"},
       "assertions": [{"type": "status_code", "expected": 200}]}


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)).json()["id"]
    return h, pid


async def _def(client, h, pid, name: str, path: str = "/order/1", draft: bool = False) -> dict:
    body = {"project_id": pid, "name": name, "method": "GET", "path": path}
    if not draft:
        body["request"] = REQ
    r = await client.post("/api/v1/api-definitions", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _recycle(client, h, pid, ids):
    for i in ids:
        r = await client.post("/api/v1/api-definitions/" + i + "/delete",
                              json={"project_id": pid}, headers=h)
        assert r.status_code == 200, r.text


async def _batch_restore(client, h, pid, ids):
    return await client.post("/api/v1/api-definitions/batch-restore",
                             json={"project_id": pid, "definition_ids": ids}, headers=h)


async def _status(client, h, pid, did) -> str:
    r = await client.get("/api/v1/api-definitions/" + did, params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["status"]


# ══════════ 1. 正常批量恢复 ══════════
async def test_batch_restore_revives_both_states(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d252a")
    a = await _def(client, h, pid, "完整接口", "/a")
    b = await _def(client, h, pid, "草稿接口", "/b", draft=True)
    assert a["status"] == "complete" and b["status"] == "draft"
    await _recycle(client, h, pid, [a["id"], b["id"]])
    live = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)
    assert live.json()["items"] == []

    r = await _batch_restore(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    # 状态按 request 逐行定，不是一律 complete
    assert await _status(client, h, pid, a["id"]) == "complete"
    assert await _status(client, h, pid, b["id"]) == "draft"
    assert {x["name"] for x in (await client.get(
        "/api/v1/api-definitions", params={"project_id": pid}, headers=h)).json()["items"]} == {
        "完整接口", "草稿接口"}
    tr = await client.get("/api/v1/api-definitions",
                          params={"project_id": pid, "recycled": "true"}, headers=h)
    assert tr.json()["items"] == []


# ══════════ 2. 全有或全无 ══════════
async def test_batch_restore_is_all_or_nothing(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d252b")
    a = await _def(client, h, pid, "已回收", "/a")
    b = await _def(client, h, pid, "还在用", "/b")
    await _recycle(client, h, pid, [a["id"]])

    # 混入一个不在回收站的活行 → 404，且已回收的那个也不许复活
    r = await _batch_restore(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 404, r.text
    assert r.json()["code"] == "not_found"
    assert r.json()["details"]["definition_ids"] == [b["id"]]
    assert await _status(client, h, pid, b["id"]) == "complete"
    tr = await client.get("/api/v1/api-definitions",
                          params={"project_id": pid, "recycled": "true"}, headers=h)
    assert [x["id"] for x in tr.json()["items"]] == [a["id"]]

    # 不存在的 id 同样 404
    r2 = await _batch_restore(client, h, pid, [a["id"], "no-such-id"])
    assert r2.status_code == 404
    assert r2.json()["details"]["definition_ids"] == ["no-such-id"]

    # 重复 id / 空列表 → 422，仍是零写入
    r3 = await _batch_restore(client, h, pid, [a["id"], a["id"]])
    assert r3.status_code == 422 and r3.json()["code"] == "validation_failed"
    r4 = await _batch_restore(client, h, pid, [])
    assert r4.status_code == 422
    tr2 = await client.get("/api/v1/api-definitions",
                           params={"project_id": pid, "recycled": "true"}, headers=h)
    assert [x["id"] for x in tr2.json()["items"]] == [a["id"]]

    # 只带真正在回收站的行 → 成功
    assert (await _batch_restore(client, h, pid, [a["id"]])).status_code == 200
    assert await _status(client, h, pid, a["id"]) == "complete"
