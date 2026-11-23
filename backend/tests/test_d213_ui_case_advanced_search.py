"""D213 判据刀：UI 用例列表高级搜索（D47-a 三件套从 api/plan 铺到 ui_case 页）。

钉的契约：

1. **字段白名单 = UI_CASE_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 `recycled`/`module_id`/`unfiled_only` 这些顶层轴**并行 AND**，
   不是二选一；OR 组自带括号，不吃掉 project 与 visibility 谓词。
3. **带可见性的列表不因 filter 漏行/多行**：别人的私有用例在 READONLY 的高级搜索结果里
   依旧不可见（visible_clause 与 filter 同一条 SELECT，顺序不改变语义）。
4. **可空列**：`last_run_status EMPTY` 把从没跑过的行留下；`NOT_EMPTY` 一行不给。
5. **enum/bool 的操作符集合来自控件型**：priority 没有 GT；enabled 没有 EMPTY 假选项。
"""
from __future__ import annotations

import json
from typing import Any

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _element(client, h, pid: str, name: str) -> dict[str, Any]:
    r = await client.post(_BASE + "/ui-elements",
                          json={"project_id": pid, "name": name,
                                "locator_type": "css", "locator": "#submit"}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _case(client, h, pid: str, name: str, el_id: str, **kw) -> dict[str, Any]:
    body = {"project_id": pid, "name": name,
            "steps": [{"id": "open1", "type": "open", "input": "/ui/login"},
                      {"id": "clk1", "type": "click", "element_id": el_id}], **kw}
    r = await client.post(_BASE + "/ui-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _module(client, h, pid: str, name: str) -> dict[str, Any]:
    r = await client.post(_BASE + "/ui-modules", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/ui-cases", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_registers_ui_case(client, make_user) -> None:
    _, h = await make_user("d213a", admin=True)
    pid = await _proj(client, h, "D213元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "ui_case"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "ui_case" in body["supported_view_types"]
    assert body["view_label"] == "UI 用例"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"name", "priority", "enabled", "module_id", "env_id", "owner_id",
                      "step_count", "last_run_at", "last_run_status", "updated_by",
                      "created_at", "updated_at"}
    assert not ({"project_id", "status", "project_public", "recycled"} & fields), \
        "可见性/视图轴不是业务字段，不许进条件组"
    prio = next(f for f in body["fields"] if f["field"] == "priority")
    assert prio["kind"] == "enum" and "GT" not in prio["ops"]
    enabled = next(f for f in body["fields"] if f["field"] == "enabled")
    assert set(enabled["ops"]) == {"EQUALS", "NOT_EQUALS"}, "非空 bool 不给 EMPTY 假选项"
    last = next(f for f in body["fields"] if f["field"] == "last_run_status")
    assert {"EMPTY", "NOT_EMPTY"} <= set(last["ops"])


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d213b", admin=True)
    pid = await _proj(client, h, "D213条件")
    el = await _element(client, h, pid, "登录按钮")
    await _case(client, h, pid, "冒烟-登录", el["id"], priority="P0")
    await _case(client, h, pid, "冒烟-下单", el["id"], priority="P1")
    await _case(client, h, pid, "回归-登录", el["id"], priority="P0", enabled=False)

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "冒烟"})) == {"冒烟-登录", "冒烟-下单"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "priority", "operator": "EQUALS", "value": "P0"})) == {"冒烟-登录", "回归-登录"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "enabled", "operator": "EQUALS", "value": False})) == {"回归-登录"}
    # OR：名字含「下单」或优先级是 P1 → 同一行/两行都算
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "下单"},
        {"field": "priority", "operator": "EQUALS", "value": "P1"}, mode="OR")) == {
        "冒烟-下单"}
    # 谓词写在 LIMIT 之前：两行都匹配，size=1 只回一行但 total 是 2
    r = await client.get(_BASE + "/ui-cases",
                         params={"project_id": pid, "size": 1,
                                 "filter": _f({"field": "name", "operator": "CONTAINS", "value": "冒烟"})},
                         headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json().get("total") in (None, 2), "total 若在就必须吃同一份条件"


async def test_nullable_last_run_status(client, make_user) -> None:
    _, h = await make_user("d213c", admin=True)
    pid = await _proj(client, h, "D213空值")
    el = await _element(client, h, pid, "按钮")
    await _case(client, h, pid, "没跑过一号", el["id"])
    await _case(client, h, pid, "没跑过二号", el["id"])
    # 从未执行 → last_run_status 为 NULL：EMPTY 全给、NOT_EMPTY 一行不给
    assert await _names(client, h, pid, filter=_f(
        {"field": "last_run_status", "operator": "EMPTY", "value": None})) == {
        "没跑过一号", "没跑过二号"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "last_run_status", "operator": "NOT_EMPTY", "value": None})) == set()


async def test_filter_combines_with_recycled_and_module_axes(client, make_user) -> None:
    _, h = await make_user("d213d", admin=True)
    pid = await _proj(client, h, "D213并行")
    el = await _element(client, h, pid, "按钮")
    mod = await _module(client, h, pid, "结算模块")
    await _case(client, h, pid, "模块内-结算", el["id"], module_id=mod["id"])
    await _case(client, h, pid, "未分组-结算", el["id"])
    await _case(client, h, pid, "模块内-别的", el["id"], module_id=mod["id"])

    # module_id 顶层轴 + filter 并行
    assert await _names(client, h, pid, module_id=mod["id"], filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "结算"})) == {"模块内-结算"}
    # unfiled_only 轴 + filter 并行
    assert await _names(client, h, pid, unfiled_only=True, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "结算"})) == {"未分组-结算"}
    # recycled 轴 + filter：软删后只该在回收站视图里被筛到
    target = next(x for x in (await client.get(_BASE + "/ui-cases",
                                               params={"project_id": pid}, headers=h)).json()["items"]
                  if x["name"] == "未分组-结算")
    r = await client.post(_BASE + f"/ui-cases/{target['id']}/delete", json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "结算"})) == {"模块内-结算"}
    assert await _names(client, h, pid, recycled=True, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "结算"})) == {"未分组-结算"}


async def test_filter_does_not_leak_private_rows(client, make_user) -> None:
    boss, h = await make_user("d213e", admin=True)
    pid = await _proj(client, h, "D213可见性")
    el = await _element(client, h, pid, "按钮")
    await _case(client, h, pid, "公开-冒烟", el["id"])
    mem, mh = await make_user("d213mem")
    await _member(client, h, pid, mem.id, "MEMBER")
    el2 = await _element(client, mh, pid, "成员按钮")
    await _case(client, mh, pid, "私密-冒烟", el2["id"], project_public=False)

    ro, roh = await make_user("d213ro")
    await _member(client, h, pid, ro.id, "READONLY")
    # 成员自己看得见两条
    assert await _names(client, mh, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "冒烟"})) == {"公开-冒烟", "私密-冒烟"}
    # 只读者用同一条件只看得见公开那条（filter 不绕过 visible_clause）
    assert await _names(client, roh, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "冒烟"})) == {"公开-冒烟"}
    # OR 恒真式也不放大可见集（EMPTY/NOT_EMPTY 一条恒真）
    assert await _names(client, roh, pid, filter=_f(
        {"field": "name", "operator": "NOT_EMPTY", "value": None})) == {"公开-冒烟"}


async def test_bad_filter_is_400(client, make_user) -> None:
    _, h = await make_user("d213f", admin=True)
    pid = await _proj(client, h, "D213坏条件")
    r = await client.get(_BASE + "/ui-cases",
                         params={"project_id": pid,
                                 "filter": _f({"field": "project_public", "operator": "EQUALS", "value": True})},
                         headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "ui_case"
    assert "本页可筛" in r.json()["message"]
