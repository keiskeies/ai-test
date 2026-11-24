"""D219 判据刀：功能用例列表高级搜索（D47-a 三件套铺到功能用例页）。

钉的契约：

1. **字段白名单 = FUNCTIONAL_CASE_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 `recycled`、`module_id`/`unfiled_only` 这些顶层轴并行 AND；
   OR 组自带括号，不吃掉 project/recycled 谓词。
3. **回收站轴不可被 filter 绕过**：正常视图 + `name CONTAINS` 不会把墓碑带回来。
4. **模块树轴与条件组是两个入口**：左树 `module_id` 仍按子树筛；`module_id` 不是可筛字段。
5. **可空列**：`description EMPTY` 留下没写描述的用例；`NOT_EMPTY` 只留写过的。
6. **条件进 COUNT 同一份**：页码模式的 total 必须也吃 filter。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _module(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/functional-modules",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _case(client, h, pid: str, name: str, **kw) -> dict:
    body = {"project_id": pid, "name": name, **kw}
    r = await client.post(_BASE + "/functional-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/functional-cases",
                         params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_registers_functional_case(client, make_user) -> None:
    _, h = await make_user("d219a", admin=True)
    pid = await _proj(client, h, "D219元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "functional_case"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "functional_case" in body["supported_view_types"]
    assert body["view_label"] == "功能用例"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {
        "num", "name", "description", "priority", "template_id",
        "owner_id",
        "created_by", "updated_by", "created_at", "updated_at",
    }
    # 视图轴 / 模块树轴不是业务字段
    assert not ({"project_id", "recycled", "module_id", "unfiled_only", "status",
                 "current", "size", "keyword"} & fields), \
        "视图/模块树/取数轴不是业务字段，不许进条件组"
    prio = next(f for f in body["fields"] if f["field"] == "priority")
    assert prio["kind"] == "enum" and "GT" not in prio["ops"]
    name = next(f for f in body["fields"] if f["field"] == "name")
    assert "CONTAINS" in name["ops"] and "BETWEEN" not in name["ops"]
    assert "EMPTY" not in name["ops"], "非空列不给「为空」假筛选项"
    desc = next(f for f in body["fields"] if f["field"] == "description")
    assert {"EMPTY", "NOT_EMPTY"} <= set(desc["ops"])


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d219b", admin=True)
    pid = await _proj(client, h, "D219条件")
    c1 = await _case(client, h, pid, "登录成功", priority="P0", description="主流程")
    await _case(client, h, pid, "登录失败", priority="P1")
    await _case(client, h, pid, "支付成功", priority="P1")

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录成功", "登录失败"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "priority", "operator": "EQUALS", "value": "P0"})) == {"登录成功"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "CONTAINS", "value": "主流程"})) == {"登录成功"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "num", "operator": "EQUALS", "value": c1["num"]})) == {"登录成功"}
    # OR：名字含「支付」或优先级 P0 → 两行
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "支付"},
        {"field": "priority", "operator": "EQUALS", "value": "P0"}, mode="OR")) == {
        "支付成功", "登录成功"}
    # 谓词写在 LIMIT 之前：两行都匹配，size=1 只回一行但 total 是 2（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/functional-cases", params={
        "project_id": pid, "size": 1, "current": 1,
        "filter": _f({"field": "name", "operator": "CONTAINS", "value": "登录"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 2


async def test_filter_cannot_bypass_recycled_axis(client, make_user) -> None:
    _, h = await make_user("d219c", admin=True)
    pid = await _proj(client, h, "D219回收轴")
    await _case(client, h, pid, "登录-正常")
    dead = await _case(client, h, pid, "登录-已回收")
    rm = await client.post(_BASE + f"/functional-cases/{dead['id']}/delete",
                           json={"project_id": pid, "case_id": dead["id"]}, headers=h)
    assert rm.status_code == 200, rm.text

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-正常"}
    assert await _names(client, h, pid, recycled="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-已回收"}
    # 条件里点名墓碑也不行：正常视图里它不存在（轴先于条件）
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "EQUALS", "value": "登录-已回收"})) == set()


async def test_module_tree_axis_parallel_with_conditions(client, make_user) -> None:
    _, h = await make_user("d219d", admin=True)
    pid = await _proj(client, h, "D219模块轴")
    m1 = await _module(client, h, pid, "登录模块")
    await _case(client, h, pid, "登录-模块内", module_id=m1["id"])
    await _case(client, h, pid, "登录-未分类")

    # 左树 module_id 是取数轴，与条件组并行 AND（不是替代）
    assert await _names(client, h, pid, module_id=m1["id"], filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-模块内"}
    assert await _names(client, h, pid, unfiled_only="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-未分类"}
    # module_id 不是可筛字段：条件里点它必须 400，而不是悄悄按模块筛
    r = await client.get(_BASE + "/functional-cases", params={
        "project_id": pid,
        "filter": _f({"field": "module_id", "operator": "EQUALS", "value": m1["id"]}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"


async def test_nullable_description_and_bad_filter(client, make_user) -> None:
    _, h = await make_user("d219e", admin=True)
    pid = await _proj(client, h, "D219空值")
    await _case(client, h, pid, "有描述", description="写清了步骤")
    await _case(client, h, pid, "没描述")

    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "EMPTY", "value": None})) == {"没描述"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "NOT_EMPTY", "value": None})) == {"有描述"}

    r = await client.get(_BASE + "/functional-cases", params={
        "project_id": pid,
        "filter": _f({"field": "recycled", "operator": "EQUALS", "value": True}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "functional_case"
    assert "本页可筛" in r.json()["message"]
    assert "用例名称" in r.json()["message"], "400 要告诉用户这一页到底能按什么筛"
