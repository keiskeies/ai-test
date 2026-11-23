"""D256：场景回收站批量彻底删除（物理删除 + 服务端短语确认）。

钉的契约：
1. `confirm_word` 不是「彻底删除」→ 409，零删除（客户端 disabled 不是唯一防线）。
2. 全有或全无：任一不在回收站 → 404 + ids，整批不动。
3. 成功后行真的没了（不是置状态）：详情/列表/回收站都查不到。
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


async def _recycle(client, h, pid, ids) -> None:
    r = await client.post("/api/v1/scenario-batch-delete",
                          json={"project_id": pid, "scenario_ids": ids}, headers=h)
    assert r.status_code == 200, r.text


async def _purge(client, h, pid, ids, word="彻底删除"):
    return await client.post("/api/v1/scenario-batch-purge",
                             json={"project_id": pid, "scenario_ids": ids,
                                   "confirm_word": word}, headers=h)


async def _names(client, h, pid, recycled: bool = False) -> set[str]:
    params = {"project_id": pid}
    if recycled:
        params["recycled"] = "true"
    r = await client.get("/api/v1/scenarios", params=params, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


# ══════════ 1. 短语确认（服务端） ══════════
async def test_confirm_word_is_enforced_server_side(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d256a")
    a = await _scene(client, h, pid, "甲")
    await _recycle(client, h, pid, [a["id"]])

    for word in ("", "彻底删除 ", "删除", "彻底 删除"):
        r = await _purge(client, h, pid, [a["id"]], word=word)
        assert r.status_code == 409, (word, r.text)
        assert r.json()["code"] == "confirm_word_mismatch"
    # 短语错时一行都不许少
    assert await _names(client, h, pid, recycled=True) == {"甲"}

    assert (await _purge(client, h, pid, [a["id"]], word="彻底删除")).status_code == 200
    assert await _names(client, h, pid, recycled=True) == set()


# ══════════ 2. 全有或全无 ══════════
async def test_batch_purge_is_all_or_nothing(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d256b")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    await _recycle(client, h, pid, [a["id"]])

    # 混入正常状态的乙 → 404 列乙，甲仍在回收站
    r = await _purge(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 404, r.text
    assert r.json()["details"]["scenario_ids"] == [b["id"]]
    assert await _names(client, h, pid, recycled=True) == {"甲"}
    assert await _names(client, h, pid) == {"乙"}

    # 重复 id → 422
    assert (await _purge(client, h, pid, [a["id"], a["id"]])).status_code == 422
    assert await _names(client, h, pid, recycled=True) == {"甲"}


# ══════════ 3. 真物理删除 ══════════
async def test_purge_physically_removes_rows(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d256c")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    await _scene(client, h, pid, "丙")
    await _recycle(client, h, pid, [a["id"], b["id"]])

    assert (await _purge(client, h, pid, [a["id"], b["id"]])).status_code == 200
    for sid in (a["id"], b["id"]):
        detail = await client.get("/api/v1/scenarios/" + sid, params={"project_id": pid}, headers=h)
        assert detail.status_code == 404, detail.text
    assert await _names(client, h, pid) == {"丙"}
    assert await _names(client, h, pid, recycled=True) == set()
