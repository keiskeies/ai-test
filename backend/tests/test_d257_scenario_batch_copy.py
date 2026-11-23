"""D257：场景批量复制（替代前端 N 次 single duplicate 循环）。

与单条 duplicate 的差异是刻意设计，不是遗漏：
1. 撞名不 409，自动「 - 副本 2/3/…」——批量里一个重名不该让整批失败；
2. 回包带最终名清单；
3. 全有或全无的前置校验同 D255（重复 id → 422；任一不在正常态 → 404 零写入）。
"""
from __future__ import annotations


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)).json()["id"]
    return h, pid


async def _scene(client, h, pid, name: str, **kw) -> dict:
    r = await client.post("/api/v1/scenarios", json={"project_id": pid, "name": name, **kw},
                          headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _copy(client, h, pid, ids, module_id=None):
    body = {"project_id": pid, "scenario_ids": ids}
    if module_id is not None:
        body["module_id"] = module_id
    return await client.post("/api/v1/scenario-batch-copy", json=body, headers=h)


async def _names(client, h, pid) -> set[str]:
    r = await client.get("/api/v1/scenarios", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


# ══════════ 1. 名称后缀策略 ══════════
async def test_batch_copy_names_avoid_conflicts(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d257a")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    # 先手工占掉「甲 - 副本」
    await _scene(client, h, pid, "甲 - 副本")

    r = await _copy(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 2
    assert set(body["names"]) == {"甲 - 副本 2", "乙 - 副本"}
    assert await _names(client, h, pid) == {"甲", "乙", "甲 - 副本", "甲 - 副本 2", "乙 - 副本"}

    # 再复制一次甲：避开两个已占名
    r2 = await _copy(client, h, pid, [a["id"]])
    assert r2.json()["names"] == ["甲 - 副本 3"]
    # 同批里两条同名源也互不撞
    x1 = await _scene(client, h, pid, "同名")
    r3 = await _copy(client, h, pid, [x1["id"], x1["id"]])
    assert r3.status_code == 422  # 重复 id 先被前置校验拦住，不会产生两条同名副本


# ══════════ 2. 前置校验：整批不动 ══════════
async def test_batch_copy_validates_before_writing(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d257b")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    assert (await client.post("/api/v1/scenario-batch-delete",
                              json={"project_id": pid, "scenario_ids": [b["id"]]},
                              headers=h)).status_code == 200

    r = await _copy(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 404, r.text
    assert r.json()["details"]["scenario_ids"] == [b["id"]]
    # 一个副本都不许建
    assert await _names(client, h, pid) == {"甲"}

    r2 = await _copy(client, h, pid, [a["id"], "no-such-id"])
    assert r2.status_code == 404 and r2.json()["details"]["scenario_ids"] == ["no-such-id"]
    assert await _names(client, h, pid) == {"甲"}


# ══════════ 3. 目标模块 ══════════
async def test_batch_copy_into_module(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d257c")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    mod = (await client.post("/api/v1/scenario-modules",
                             json={"project_id": pid, "name": "副本区"}, headers=h)).json()

    r = await _copy(client, h, pid, [a["id"], b["id"]], module_id=mod["id"])
    assert r.status_code == 200, r.text
    listed = await client.get("/api/v1/scenarios",
                              params={"project_id": pid, "module_id": mod["id"]}, headers=h)
    assert {x["name"] for x in listed.json()["items"]} == {"甲 - 副本", "乙 - 副本"}
    # 源场景模块不变
    src = await client.get("/api/v1/scenarios/" + a["id"], params={"project_id": pid}, headers=h)
    assert src.json()["module_id"] in (None, "")
