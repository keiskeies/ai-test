"""D212 判据刀：计划列表高级搜索（§11.5.1 / D47-a 从「接口」页铺到「测试计划」页）。

钉的契约：

1. **字段来自注册表，不来自前端**：`/filter-meta?view_type=plan` 的 fields 就是
   `PLAN_LIST_FILTER.meta()`；白名单外的字段 400 且 message 说清本页可筛什么。
2. **条件是 WHERE，不是事后过滤**：LIMIT 之前生效（这里用带子串的名字钉住筛选结果）。
3. **可空列的否定谓词保留 NULL 行**：`module_id NOT_IN [m1]` 必须把「未分组」的计划留下
   （`filters._neg` 的三值逻辑口径；少了它，最不属于 m1 的那批会被藏掉）。
4. **与左树模块过滤并行**：`module_id`（整棵子树）与 `filter` 同时生效 = AND，
   两个入口互不覆盖。
5. **project_id 不可筛**：即便 filter 里写 project_id 也 400（越权正门只归
   ensure_project_access）。
6. **READONLY 可筛**（:read 面），坏条件仍是 400——权限与参数校验是两件事。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _plan(client, h, pid: str, name: str, module_id: str | None = None) -> dict:
    body = {"project_id": pid, "name": name}
    if module_id is not None:
        body["module_id"] = module_id
    r = await client.post(_BASE + "/plans", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _module(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/plans", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_lists_plan_fields(client, make_user) -> None:
    _, h = await make_user("d212a", admin=True)
    pid = await _proj(client, h, "D212元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "plan"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "plan" in body["supported_view_types"]
    assert body["view_label"] == "测试计划"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"name", "description", "archived", "module_id",
                      "created_by", "updated_by", "created_at", "updated_at"}
    assert "project_id" not in fields, "取数机制参数不是业务字段（越权正门）"
    archived = next(f for f in body["fields"] if f["field"] == "archived")
    assert archived["kind"] == "bool"
    assert set(archived["ops"]) == {"EQUALS", "NOT_EQUALS"}, "非空列不给 EMPTY 假选项"


async def test_conditions_are_where_clauses(client, make_user) -> None:
    _, h = await make_user("d212b", admin=True)
    pid = await _proj(client, h, "D212条件")
    a = await _plan(client, h, pid, "结算-甲")
    await _plan(client, h, pid, "结算-乙")
    await _plan(client, h, pid, "无关-丙")
    r = await client.post(_BASE + f"/plans/{a['id']}/archive", json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "结算"})) == {"结算-甲", "结算-乙"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "archived", "operator": "EQUALS", "value": True})) == {"结算-甲"}
    # OR 模式：两个条件任一满足
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "甲"},
        {"field": "name", "operator": "CONTAINS", "value": "丙"}, mode="OR")) == {
        "结算-甲", "无关-丙"}


async def test_negation_on_nullable_module_keeps_unassigned(client, make_user) -> None:
    _, h = await make_user("d212c", admin=True)
    pid = await _proj(client, h, "D212空值")
    m1 = await _module(client, h, pid, "一号模块")
    await _plan(client, h, pid, "在模块里", m1["id"])
    await _plan(client, h, pid, "未分组")

    got = await _names(client, h, pid, filter=_f(
        {"field": "module_id", "operator": "NOT_IN", "value": [m1["id"]]}))
    assert got == {"未分组"}, "可空列的 NOT_IN 必须保留 NULL 行（三值逻辑）"
    got = await _names(client, h, pid, filter=_f(
        {"field": "module_id", "operator": "EMPTY", "value": None}))
    assert got == {"未分组"}


async def test_filter_combines_with_tree_module_scope(client, make_user) -> None:
    _, h = await make_user("d212d", admin=True)
    pid = await _proj(client, h, "D212并行")
    parent = await _module(client, h, pid, "父")
    child = await _module(client, h, pid, "子")
    # 造一棵父→子（用 update 的 parent_set）
    r = await client.patch(_BASE + f"/plan-modules/{child['id']}",
                           json={"project_id": pid, "parent_set": True, "parent_id": parent["id"]},
                           headers=h)
    assert r.status_code == 200, r.text
    await _plan(client, h, pid, "子树-结算", child["id"])
    await _plan(client, h, pid, "子树-别的", child["id"])
    await _plan(client, h, pid, "根下-结算", parent["id"])

    # 左树点父（整棵子树） + 高级搜索「名称含结算」→ 交集
    assert await _names(client, h, pid, module_id=parent["id"], filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "结算"})) == {
        "子树-结算", "根下-结算"}
    # unassigned 与 filter 也并行：未分组里再筛名字
    await _plan(client, h, pid, "游离-结算")
    await _plan(client, h, pid, "游离-别的")
    assert await _names(client, h, pid, unassigned=True, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "结算"})) == {"游离-结算"}


async def test_bad_conditions_are_400_with_page_list(client, make_user) -> None:
    _, h = await make_user("d212e", admin=True)
    pid = await _proj(client, h, "D212坏条件")

    async def bad(raw: str) -> dict:
        r = await client.get(_BASE + "/plans", params={"project_id": pid, "filter": raw}, headers=h)
        assert r.status_code == 400, r.text
        body = r.json()
        assert body["code"] == "bad_filter"
        assert body["details"]["view_type"] == "plan"
        return body

    body = await bad(_f({"field": "project_id", "operator": "EQUALS", "value": "别的项目"}))
    assert "本页可筛" in body["message"], "400 要说清这页能筛什么，不让用户猜字段名"
    await bad(_f({"field": "name", "operator": "GT", "value": 1}))       # 操作符与控件型不符
    await bad("{not json")                                              # 不是 JSON


async def test_readonly_can_filter_but_bad_filter_still_400(client, make_user) -> None:
    boss, h = await make_user("d212f", admin=True)
    pid = await _proj(client, h, "D212只读")
    await _plan(client, h, pid, "只读-甲")
    await _plan(client, h, pid, "只读-乙")

    ro, roh = await make_user("d212ro")
    await _member(client, h, pid, ro.id, "READONLY")
    assert await _names(client, roh, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "甲"})) == {"只读-甲"}
    r = await client.get(_BASE + "/plans",
                         params={"project_id": pid,
                                 "filter": _f({"field": "nope", "operator": "EQUALS", "value": 1})},
                         headers=roh)
    assert r.status_code == 400
