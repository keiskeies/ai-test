"""D288 判据刀：接口参数补「必填 / 描述」（四元键值对）。

钉的契约：
1. 四元参数 `["名","值","1|0","描述"]` 能存能取（列表/详情同形），两元旧数据/导入不受影响；
2. 形状校验：三元、必填位不是 "1"/"0"、描述超 500 字 → 422；
3. 执行层只取前两位（必填/描述是文档信息，不进查询串、不改请求头）。
"""
from __future__ import annotations

from app.modules.execution.core import _build_kwargs

_BASE = "/api/v1"

_PARAMS = [
    ["page", "1", "1", "页码，从 1 开始"],
    ["size", "20"],
]


async def _setup(client, make_user, name="d288"):
    _, h = await make_user(name)
    r = await client.post(_BASE + "/projects", json={"name": name + "_proj"}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _create(client, h, pid, params, name="查询订单"):
    return await client.post(_BASE + "/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": "/order",
        "request": {"method": "GET", "url": "https://api.x.test/order", "params": params},
    }, headers=h)


async def test_param_meta_roundtrip(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    r = await _create(client, h, pid, _PARAMS)
    assert r.status_code == 201, r.text
    did = r.json()["id"]

    detail = await client.get(_BASE + "/api-definitions/" + did,
                              params={"project_id": pid}, headers=h)
    assert detail.status_code == 200, detail.text
    # 四元原样回，两元仍是两元（不强行补齐，旧数据/导出的形状不变）
    assert detail.json()["request"]["params"] == _PARAMS

    listed = await client.get(_BASE + "/api-definitions",
                              params={"project_id": pid}, headers=h)
    assert listed.status_code == 200, listed.text
    row = next(x for x in listed.json()["items"] if x["id"] == did)
    assert row["request"]["params"] == _PARAMS


async def test_bad_meta_shape_is_422(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d288b")
    for bad in (
        [["page", "1", "1"]],            # 三元：缺描述
        [["page", "1", "yes", "说明"]],  # 必填位不是 1/0
        [["page", "1", "0", "x" * 501]], # 描述超长
    ):
        r = await _create(client, h, pid, bad)
        assert r.status_code == 422, (bad, r.text)
        assert r.json()["code"] == "validation_failed"


def test_execution_ignores_meta() -> None:
    kw = _build_kwargs({
        "method": "GET", "url": "https://api.x.test/order",
        "params": [["page", "1", "1", "页码"], ["size", "20"]],
        "headers": [["X-Trace", "t-1"]],
        "body": {"type": "none"},
    })
    # 查询串只有名/值；必填与描述是给人和导出看的，不参与执行
    assert kw["params"] == [("page", "1"), ("size", "20")]
    assert kw["headers"] == [("X-Trace", "t-1")]
