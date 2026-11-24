"""D283 判据刀：功能用例「标签」。

钉的契约：
1. 创建可写标签：去空白/去重保序，回执/列表/详情都是数组（库里是逗号串）。
2. 顶层 `tag` 是**精确**匹配（FIND_IN_SET）：存在「bug1」时按「bug」筛不到它
   （LIKE 会误中，D190 明令避免）。
3. 更新三态：不带 tags = 不改、[] = 清空、带值 = 改。
4. 批量复制随抄标签。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _setup(client, make_user, name="d283"):
    _, h = await make_user(name)
    r = await client.post(_BASE + "/projects", json={"name": name + "_proj"}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _case(client, h, pid, name, **kw):
    return await client.post(_BASE + "/functional-cases",
                            json={"project_id": pid, "name": name, **kw}, headers=h)


async def _list(client, h, pid, **params):
    return await client.get(_BASE + "/functional-cases",
                            params={"project_id": pid, "current": 1, "size": 50, **params},
                            headers=h)


async def test_tags_roundtrip_and_exact_filter(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    r = await _case(client, h, pid, "带标签", tags=[" 回归 ", "核心", "回归", ""])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["tags"] == ["回归", "核心"]

    listed = await _list(client, h, pid)
    row = next(x for x in listed.json()["items"] if x["id"] == body["id"])
    assert row["tags"] == ["回归", "核心"]

    hit = await _list(client, h, pid, tag="回归")
    assert [x["id"] for x in hit.json()["items"]] == [body["id"]]
    miss = await _list(client, h, pid, tag="回")
    assert miss.status_code == 200 and miss.json()["items"] == [], "标签筛选必须是精确匹配，不是包含"

    # 前缀陷阱：存在 bug1 时按 bug 筛不到（LIKE 会误中）
    await _case(client, h, pid, "带 bug 标签", tags=["bug1"])
    assert (await _list(client, h, pid, tag="bug")).json()["items"] == []
    got = await _list(client, h, pid, tag="bug1")
    assert [x["name"] for x in got.json()["items"]] == ["带 bug 标签"]


async def test_update_three_state_and_copy(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d283b")
    created = await _case(client, h, pid, "三态", tags=["旧标签"])
    cid = created.json()["id"]

    keep = await client.patch(_BASE + f"/functional-cases/{cid}", json={
        "project_id": pid, "name": "改名",
    }, headers=h)
    assert keep.status_code == 200 and keep.json()["tags"] == ["旧标签"]

    cleared = await client.patch(_BASE + f"/functional-cases/{cid}", json={
        "project_id": pid, "tags": [],
    }, headers=h)
    assert cleared.status_code == 200 and cleared.json()["tags"] == []

    again = await client.patch(_BASE + f"/functional-cases/{cid}", json={
        "project_id": pid, "tags": ["新标签", "新标签"],
    }, headers=h)
    assert again.status_code == 200 and again.json()["tags"] == ["新标签"]

    cp = await client.post(_BASE + "/functional-cases/batch-copy", json={
        "project_id": pid, "case_ids": [cid],
    }, headers=h)
    assert cp.status_code == 200, cp.text
    got = await client.get(_BASE + "/functional-cases/" + cp.json()["case_ids"][0],
                           params={"project_id": pid}, headers=h)
    assert got.status_code == 200 and got.json()["tags"] == ["新标签"]


async def test_tags_too_long_is_422(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d283c")
    r = await _case(client, h, pid, "超长", tags=["x" * 600, "y" * 600])
    assert r.status_code == 422 and r.json()["code"] == "validation_failed"
