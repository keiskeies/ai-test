"""D241 判据刀：Mock 规则页高级搜索（D47-a 三件套铺到 Mock 规则列表）。

钉的契约（对应 services.py MOCK_RULE_LIST_FILTER 的注释）：

1. **字段白名单 = mock_rule 的真实标量列**：规则名/请求方法/匹配路径/匹配方式/
   状态码/延迟/优先级/启用（1/0）/创建人/更新人/两个时刻列。`service_id`/`project_id`
   是取数作用域、`headers`/`body` 是 JSON/长文本、`id` 无按 id 找的需求，都不进，
   点名即 400。
2. **条件是 WHERE 且在服务作用域之内**：与 project+service 的 where 并行 AND；
   另一个服务的规则一行都不出现。
3. **空 filter = 没传**；非法字段/非法操作符/坏 JSON 400 且 `code=bad_filter`，
   message 点名本页可筛清单。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _service(client, h, pid: str, name: str) -> str:
    r = await client.post(_BASE + "/mock-services",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _rule(client, h, pid: str, sid: str, *, name: str, method: str = "GET",
                path: str = "/users", match_type: str = "exact", status_code: int = 200,
                delay_ms: int = 0, priority: int = 0, enabled: bool = True) -> str:
    r = await client.post(_BASE + "/mock-rules", json={
        "project_id": pid, "service_id": sid, "name": name, "method": method,
        "path": path, "match_type": match_type, "status_code": status_code,
        "delay_ms": delay_ms, "priority": priority, "enabled": enabled,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _rules(client, h, pid: str, sid: str, **params):
    qs: list[tuple[str, str]] = [("project_id", pid)]
    for k, v in params.items():
        qs.append((k, str(v)))
    return await client.get(_BASE + f"/mock-services/{sid}/rules", params=qs, headers=h)


def _ids(body: dict) -> set[str]:
    return {x["id"] for x in body["items"]}


async def _seed(client, h, uid: str, name: str = "D241规则") -> tuple[str, str, dict[str, str]]:
    pid = await _proj(client, h, name)
    sid = await _service(client, h, pid, "订单 Mock")
    ids = {
        "users": await _rule(client, h, pid, sid, name="用户查询"),
        "pay": await _rule(client, h, pid, sid, name="支付下单", method="POST",
                           path="/pay/[0-9]+", match_type="regex", status_code=500,
                           delay_ms=300, priority=5, enabled=False),
        "static": await _rule(client, h, pid, sid, name="静态前缀", method="ANY",
                              path="/static", match_type="prefix", priority=1),
    }
    return pid, sid, ids


async def test_filter_meta_registers_mock_rule(client, make_user) -> None:
    _, h = await make_user("d241a", admin=True)
    pid = await _proj(client, h, "D241元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "mock_rule"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "mock_rule" in body["supported_view_types"]
    assert body["view_label"] == "Mock 规则"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"name", "method", "path", "match_type", "status_code", "delay_ms",
                      "priority", "enabled", "created_by", "updated_by",
                      "created_at", "updated_at"}
    assert not ({"service_id", "project_id", "id", "headers", "body"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["method"]["kind"] == "enum"
    assert by_field["enabled"]["kind"] == "number"
    assert by_field["created_at"]["kind"] == "time"
    # 非空列没有「为空」，可空的创建人/更新人有
    assert "EMPTY" not in by_field["name"]["ops"]
    assert "EMPTY" in by_field["created_by"]["ops"]


async def test_conditions_apply_as_where(client, make_user) -> None:
    u, h = await make_user("d241b", admin=True)
    pid, sid, ids = await _seed(client, h, u.id)

    async def got(cond: str) -> set[str]:
        r = await _rules(client, h, pid, sid, filter=cond)
        assert r.status_code == 200, r.text
        return _ids(r.json())

    assert await got(_f({"field": "name", "operator": "CONTAINS", "value": "支付"})) \
        == {ids["pay"]}
    assert await got(_f({"field": "method", "operator": "EQUALS", "value": "POST"})) \
        == {ids["pay"]}
    assert await got(_f({"field": "path", "operator": "CONTAINS", "value": "/static"})) \
        == {ids["static"]}
    assert await got(_f({"field": "match_type", "operator": "EQUALS", "value": "regex"})) \
        == {ids["pay"]}
    assert await got(_f({"field": "status_code", "operator": "GT", "value": 200})) \
        == {ids["pay"]}
    assert await got(_f({"field": "delay_ms", "operator": "GT", "value": 0})) == {ids["pay"]}
    assert await got(_f({"field": "priority", "operator": "EQUALS", "value": 1})) \
        == {ids["static"]}
    # enabled 是 Boolean 列，按 1/0 筛（number 语义）
    assert await got(_f({"field": "enabled", "operator": "EQUALS", "value": 0})) == {ids["pay"]}
    assert await got(_f({"field": "enabled", "operator": "EQUALS", "value": 1})) \
        == {ids["users"], ids["static"]}
    assert await got(_f({"field": "created_by", "operator": "EQUALS", "value": u.id})) \
        == {ids["users"], ids["pay"], ids["static"]}
    assert await got(_f({"field": "updated_by", "operator": "EMPTY"})) == set()
    assert await got(_f({"field": "created_at", "operator": "BETWEEN",
                         "value": ["2020-01-01T00:00:00", "2099-01-01T00:00:00"]})) \
        == {ids["users"], ids["pay"], ids["static"]}
    # OR 组：DELETE 一条都没有，或「停用」→ 只有支付
    assert await got(_f({"field": "method", "operator": "EQUALS", "value": "DELETE"},
                        {"field": "enabled", "operator": "EQUALS", "value": 0},
                        mode="OR")) == {ids["pay"]}


async def test_filter_stays_inside_selected_service(client, make_user) -> None:
    u, h = await make_user("d241c", admin=True)
    pid, sid, ids = await _seed(client, h, u.id, "D241作用域")
    other = await _service(client, h, pid, "另一个 Mock")
    other_rule = await _rule(client, h, pid, other, name="支付下单（另一个服务）", method="POST")

    r = await _rules(client, h, pid, sid, filter=_f({"field": "name", "operator": "CONTAINS",
                                                     "value": "支付"}))
    assert r.status_code == 200, r.text
    assert _ids(r.json()) == {ids["pay"]}
    assert other_rule not in _ids(r.json())


async def test_bad_filter_is_400_with_page_field_list(client, make_user) -> None:
    u, h = await make_user("d241d", admin=True)
    pid, sid, _ = await _seed(client, h, u.id, "D241非法")

    r = await _rules(client, h, pid, sid,
                     filter=_f({"field": "service_id", "operator": "EQUALS", "value": "x"}))
    assert r.status_code == 400, r.text
    detail = r.json()
    assert detail["code"] == "bad_filter"
    assert "规则名（name）" in detail["message"]
    assert detail["details"]["view_type"] == "mock_rule"

    # 枚举列没有「包含」
    r = await _rules(client, h, pid, sid,
                     filter=_f({"field": "method", "operator": "CONTAINS", "value": "GET"}))
    assert r.status_code == 400
    assert r.json()["code"] == "bad_filter"

    # 坏 JSON 不许降级成「没筛」
    r = await client.get(_BASE + f"/mock-services/{sid}/rules",
                         params=[("project_id", pid), ("filter", "{not json")], headers=h)
    assert r.status_code == 400
    assert r.json()["code"] == "bad_filter"


async def test_empty_filter_is_all_rules(client, make_user) -> None:
    u, h = await make_user("d241e", admin=True)
    pid, sid, ids = await _seed(client, h, u.id, "D241空条件")
    r = await _rules(client, h, pid, sid, filter="")
    assert r.status_code == 200
    assert _ids(r.json()) == set(ids.values())
