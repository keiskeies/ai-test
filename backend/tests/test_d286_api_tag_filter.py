"""D286 判据刀：接口定义列表的顶层「标签精确筛选」（P1-4 收口的最后一格）。

D282 的 keyword 搜标签是**包含**语义（「找一找」）；本刀补 `tag=` 的**精确**语义
（「就这一档」，FIND_IN_SET），与 keyword/模块/回收站并行 AND。两者并存不互替。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _setup(client, make_user, name="d286"):
    _, h = await make_user(name)
    r = await client.post(_BASE + "/projects", json={"name": name + "_proj"}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _create(client, h, pid, name, **kw):
    return await client.post(_BASE + "/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": "/" + name, **kw,
    }, headers=h)


async def _list(client, h, pid, **params):
    return await client.get(_BASE + "/api-definitions",
                            params={"project_id": pid, **params}, headers=h)


async def test_tag_filter_is_exact_and_parallel_with_keyword(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    a = (await _create(client, h, pid, "order", tags=["回归", "核心"])).json()
    b = (await _create(client, h, pid, "refund", tags=["bug1"])).json()
    await _create(client, h, pid, "profile")

    hit = await _list(client, h, pid, tag="回归")
    assert hit.status_code == 200
    assert [x["id"] for x in hit.json()["items"]] == [a["id"]]

    # 精确：bug1 不被 bug 命中（FIND_IN_SET，不是 LIKE）
    assert (await _list(client, h, pid, tag="bug")).json()["items"] == []
    assert [x["id"] for x in (await _list(client, h, pid, tag="bug1")).json()["items"]] == [b["id"]]

    # 全空白 = 不过滤
    assert len((await _list(client, h, pid, tag="   ")).json()["items"]) == 3

    # keyword 仍是包含语义（搜 "回归" 也能命中标签），与 tag 并存：
    # keyword=refund + tag=回归 的交集为空（refund 没有「回归」标签）
    assert [x["id"] for x in (await _list(client, h, pid, keyword="回归")).json()["items"]] == [a["id"]]
    assert (await _list(client, h, pid, keyword="refund", tag="回归")).json()["items"] == []
