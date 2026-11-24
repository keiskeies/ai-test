"""D282 判据刀：接口定义的「描述 / 标签」（对齐 MS 接口列表两列）。

钉的契约（每条都能在 services.py 的 `api_definition_create/update` 指到实现）：

1. **创建可写两列**：回执 tags 是去重保序后的列表（库里存逗号串），description 原样；
   列表/单查同形。
2. **关键字搜索覆盖标签**：`keyword=` 是 name/path/tags 三路 OR，搜标签能命中。
3. **高级搜索可筛描述**：`description CONTAINS` 走 API_LIST_FILTER 白名单。
4. **更新三态**：description 不带 `description_set` = 不改、带 null = 清空；
   tags 不带 = 不改、`[]` = 清空。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _setup(client, make_user, name="d282"):
    _, h = await make_user(name)
    r = await client.post(_BASE + "/projects", json={"name": name + "_proj"}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _create(client, h, pid, name="查询订单", **kw):
    return await client.post(_BASE + "/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": "/order/{id}", **kw,
    }, headers=h)


def _filter(field: str, operator: str, value: str) -> str:
    return json.dumps({"search_mode": "AND", "conditions": [
        {"field": field, "operator": operator, "value": value},
    ]})


async def _list(client, h, pid, **params):
    return await client.get(_BASE + "/api-definitions",
                            params={"project_id": pid, **params}, headers=h)


async def test_description_and_tags_roundtrip(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    r = await _create(client, h, pid, description="下单主链路，幂等键取订单号",
                      tags=[" 回归 ", "核心", "回归", ""])
    assert r.status_code == 201, r.text
    body = r.json()
    did = body["id"]
    # 去重保序 + 去两端空白 + 丢掉空标签；库里是逗号串，出参必须是列表
    assert body["description"] == "下单主链路，幂等键取订单号"
    assert body["tags"] == ["回归", "核心"]

    listed = await _list(client, h, pid)
    assert listed.status_code == 200, listed.text
    row = next(x for x in listed.json()["items"] if x["id"] == did)
    assert row["description"] == body["description"] and row["tags"] == ["回归", "核心"]

    detail = await client.get(_BASE + "/api-definitions/" + did,
                              params={"project_id": pid}, headers=h)
    assert detail.status_code == 200
    assert detail.json()["tags"] == ["回归", "核心"]

    # 关键字搜索覆盖标签（name/path 都不含「核心」）
    hit = await _list(client, h, pid, keyword="核心")
    assert hit.status_code == 200 and [x["id"] for x in hit.json()["items"]] == [did]

    # 高级搜索可筛描述
    hit2 = await _list(client, h, pid, filter=_filter("description", "CONTAINS", "幂等键"))
    assert hit2.status_code == 200 and [x["id"] for x in hit2.json()["items"]] == [did]
    miss = await _list(client, h, pid, filter=_filter("description", "CONTAINS", "不存在"))
    assert miss.status_code == 200 and miss.json()["items"] == []


async def test_update_three_state(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d282b")
    created = await _create(client, h, pid, description="旧说明", tags=["旧标签"])
    did = created.json()["id"]
    ver = created.json()["version"]

    # 不带 description_set / tags = 两列都不动（tags=null 也是「不改」）
    keep = await client.patch(_BASE + "/api-definitions/" + did, json={
        "project_id": pid, "version": ver, "name": "改名",
    }, headers=h)
    assert keep.status_code == 200, keep.text
    assert keep.json()["description"] == "旧说明" and keep.json()["tags"] == ["旧标签"]
    ver = keep.json()["version"]

    # description_set + null = 清空；tags=[] = 清空
    cleared = await client.patch(_BASE + "/api-definitions/" + did, json={
        "project_id": pid, "version": ver, "description": None, "description_set": True, "tags": [],
    }, headers=h)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["description"] is None and cleared.json()["tags"] == []


async def test_tags_too_long_is_422(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d282c")
    r = await _create(client, h, pid, tags=["x" * 600, "y" * 600])
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_failed"
