"""D217 判据刀：ADB 用例列表高级搜索（D47-a 三件套铺到 ADB 页）。

钉的契约：

1. **字段白名单 = ADB_CASE_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 `recycled`、`module_id`/`unfiled_only` 这些顶层轴并行 AND；
   OR 组自带括号，不吃掉 project/visibility/recycled 谓词。
3. **回收站轴不可被 filter 绕过**：正常视图 + `name CONTAINS` 不会把墓碑带回来。
4. **可空列**：`last_run_status EMPTY` 留下从没跑过的行；`NOT_EMPTY` 一行不给。
5. **bool 只有真假两端**：enabled 的操作符是 {EQUALS, NOT_EQUALS}，没有 GT/EMPTY 假选项。
6. **条件进 COUNT 同一份**：页码模式的 total 必须也吃 filter。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _steps() -> list[dict]:
    return [{"id": "s1", "type": "home"}]


async def _case(client, h, pid: str, name: str, **kw) -> dict:
    body = {"project_id": pid, "name": name, "steps": _steps(), **kw}
    r = await client.post(_BASE + "/adb-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/adb-cases", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_registers_adb_case(client, make_user) -> None:
    _, h = await make_user("d217a", admin=True)
    pid = await _proj(client, h, "D217元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "adb_case"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "adb_case" in body["supported_view_types"]
    assert body["view_label"] == "ADB 用例"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {
        "name", "priority", "enabled", "default_device", "owner_id", "project_public",
        "step_count", "last_run_at", "last_run_status", "updated_by",
        "created_at", "updated_at",
    }
    # 视图轴/模块树轴不是业务字段：recycled 进条件组会造出自我矛盾的视图
    assert not ({"project_id", "recycled", "module_id", "unfiled_only",
                 "status", "cursor", "current", "size"} & fields), \
        "视图/模块树/取数轴不是业务字段，不许进条件组"
    enabled = next(f for f in body["fields"] if f["field"] == "enabled")
    assert set(enabled["ops"]) == {"EQUALS", "NOT_EQUALS"}, "bool 只有真假两端"
    prio = next(f for f in body["fields"] if f["field"] == "priority")
    assert prio["kind"] == "enum" and "GT" not in prio["ops"]
    name = next(f for f in body["fields"] if f["field"] == "name")
    assert "CONTAINS" in name["ops"] and "BETWEEN" not in name["ops"]
    last = next(f for f in body["fields"] if f["field"] == "last_run_status")
    assert {"EMPTY", "NOT_EMPTY"} <= set(last["ops"])


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d217b", admin=True)
    pid = await _proj(client, h, "D217条件")
    await _case(client, h, pid, "登录冒烟", priority="P0", default_device="10.0.0.9:5555")
    await _case(client, h, pid, "登录回归", priority="P1")
    await _case(client, h, pid, "支付冒烟", priority="P1", enabled=False)

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录冒烟", "登录回归"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "priority", "operator": "EQUALS", "value": "P0"})) == {"登录冒烟"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "enabled", "operator": "EQUALS", "value": False})) == {"支付冒烟"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "default_device", "operator": "CONTAINS", "value": "10.0.0.9"})) == {"登录冒烟"}
    # OR：名字含「支付」或优先级 P0 → 两行
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "支付"},
        {"field": "priority", "operator": "EQUALS", "value": "P0"}, mode="OR")) == {
        "支付冒烟", "登录冒烟"}
    # 谓词写在 LIMIT 之前：两行都匹配，size=1 只回一行但 total 是 2（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/adb-cases", params={
        "project_id": pid, "size": 1, "current": 1,
        "filter": _f({"field": "name", "operator": "CONTAINS", "value": "登录"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 2


async def test_filter_cannot_bypass_recycled_axis(client, make_user) -> None:
    _, h = await make_user("d217c", admin=True)
    pid = await _proj(client, h, "D217回收轴")
    await _case(client, h, pid, "登录-正常")
    dead = await _case(client, h, pid, "登录-已回收")
    rm = await client.post(_BASE + f"/adb-cases/{dead['id']}/delete",
                           json={"project_id": pid}, headers=h)
    assert rm.status_code == 200, rm.text

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-正常"}
    assert await _names(client, h, pid, recycled="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-已回收"}
    # 条件里点名墓碑也不行：正常视图里它不存在（轴先于条件）
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "EQUALS", "value": "登录-已回收"})) == set()


async def test_nullable_last_run_columns(client, make_user) -> None:
    _, h = await make_user("d217d", admin=True)
    pid = await _proj(client, h, "D217空值")
    await _case(client, h, pid, "没跑过")

    assert await _names(client, h, pid, filter=_f(
        {"field": "last_run_status", "operator": "EMPTY", "value": None})) == {"没跑过"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "last_run_at", "operator": "EMPTY", "value": None})) == {"没跑过"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "last_run_status", "operator": "NOT_EMPTY", "value": None})) == set()


async def test_bad_filter_is_400(client, make_user) -> None:
    _, h = await make_user("d217e", admin=True)
    pid = await _proj(client, h, "D217坏条件")
    r = await client.get(_BASE + "/adb-cases", params={
        "project_id": pid,
        "filter": _f({"field": "recycled", "operator": "EQUALS", "value": True}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "adb_case"
    assert "本页可筛" in r.json()["message"]
    assert "名称" in r.json()["message"], "400 要告诉用户这一页到底能按什么筛"
