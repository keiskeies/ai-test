"""D255：场景批量回收 / 批量恢复（替代前端 N 次单删循环）。

钉的契约：
1. 全有或全无——任一不存在或状态不对 → 404 + 具体 ids，整批一行不动。
2. 重复 id → 422。
3. 删除写「删除人」，恢复不留回收站尾巴。
"""
from __future__ import annotations


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)).json()["id"]
    return h, pid


async def _scene(client, h, pid, name: str) -> dict:
    r = await client.post("/api/v1/scenarios", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _names(client, h, pid, recycled: bool = False) -> set[str]:
    params = {"project_id": pid}
    if recycled:
        params["recycled"] = "true"
    r = await client.get("/api/v1/scenarios", params=params, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def _batch_delete(client, h, pid, ids):
    return await client.post("/api/v1/scenario-batch-delete",
                             json={"project_id": pid, "scenario_ids": ids}, headers=h)


async def _batch_restore(client, h, pid, ids):
    return await client.post("/api/v1/scenario-batch-restore",
                             json={"project_id": pid, "scenario_ids": ids}, headers=h)


# ══════════ 1. 正常批删 / 批恢复 ══════════
async def test_batch_delete_and_restore_roundtrip(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d255a")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    c = await _scene(client, h, pid, "丙")

    r = await _batch_delete(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 200 and r.json()["ok"] is True
    assert await _names(client, h, pid) == {"丙"}
    assert await _names(client, h, pid, recycled=True) == {"甲", "乙"}
    # 删除人落库（回收站「删除人」列的数据源）
    tr = await client.get("/api/v1/scenarios", params={"project_id": pid, "recycled": "true"},
                          headers=h)
    assert all(x["updated_by"] for x in tr.json()["items"])

    rr = await _batch_restore(client, h, pid, [a["id"], b["id"]])
    assert rr.status_code == 200 and rr.json()["ok"] is True
    assert await _names(client, h, pid) == {"甲", "乙", "丙"}
    assert await _names(client, h, pid, recycled=True) == set()
    # 单条语义未被改写
    assert (await client.get("/api/v1/scenarios/" + c["id"],
                             params={"project_id": pid}, headers=h)).status_code == 200


# ══════════ 2. 全有或全无 ══════════
async def test_batch_delete_is_all_or_nothing(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d255b")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    assert (await _batch_delete(client, h, pid, [a["id"]])).status_code == 200

    # 混入已在回收站的甲：404 列出甲，乙一行不动
    r = await _batch_delete(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 404, r.text
    assert r.json()["details"]["scenario_ids"] == [a["id"]]
    assert await _names(client, h, pid) == {"乙"}

    # 不存在的 id 同样 404
    r2 = await _batch_delete(client, h, pid, [b["id"], "no-such-id"])
    assert r2.status_code == 404
    assert r2.json()["details"]["scenario_ids"] == ["no-such-id"]
    assert await _names(client, h, pid) == {"乙"}

    # 重复 id → 422，零写入
    r3 = await _batch_delete(client, h, pid, [b["id"], b["id"]])
    assert r3.status_code == 422 and r3.json()["code"] == "validation_failed"
    assert await _names(client, h, pid) == {"乙"}


async def test_batch_restore_happy_and_guards(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d255c")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    assert (await _batch_delete(client, h, pid, [a["id"]])).status_code == 200

    # 混入正常状态的乙 → 404 列乙，甲仍留在回收站（整批不动）
    r = await _batch_restore(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 404, r.text
    assert r.json()["details"]["scenario_ids"] == [b["id"]]
    assert await _names(client, h, pid, recycled=True) == {"甲"}
    assert await _names(client, h, pid) == {"乙"}

    # 重复 / 不存在
    assert (await _batch_restore(client, h, pid, [a["id"], a["id"]])).status_code == 422
    r2 = await _batch_restore(client, h, pid, [a["id"], "no-such-id"])
    assert r2.status_code == 404 and r2.json()["details"]["scenario_ids"] == ["no-such-id"]

    # 只带真正在回收站的 → 成功
    assert (await _batch_restore(client, h, pid, [a["id"]])).status_code == 200
    assert await _names(client, h, pid) == {"甲", "乙"}
