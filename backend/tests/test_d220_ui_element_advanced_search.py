"""D220 判据刀：元素库列表高级搜索（D47-a 三件套铺到元素库页）。

钉的契约：

1. **字段白名单 = UI_ELEMENT_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 `recycled`、`module_ids`/`unfiled_only` 这些顶层轴并行 AND；
   OR 组自带括号，不吃掉 project/visible/recycled 谓词。
3. **回收站轴不可被 filter 绕过**：正常视图 + `name CONTAINS` 不会把墓碑带回来。
4. **模块树轴与条件组是两个入口**：左树 `module_ids` 仍按直属筛；`module_id` 不是可筛字段。
5. **可空列**：`comment EMPTY` 留下没写备注的元素；`NOT_EMPTY` 只留写过的。
6. **非列字段不装进白名单**：`used_by`（现算的引用计数）与取数机制参数都不可筛。
7. **条件进 COUNT 同一份**：页码模式的 total 必须也吃 filter。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _module(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/ui-modules",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _el(client, h, pid: str, name: str, **kw) -> dict:
    body = {"project_id": pid, "name": name, "locator_type": "css",
            "locator": "#submit", **kw}
    r = await client.post(_BASE + "/ui-elements", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/ui-elements",
                         params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_registers_ui_element(client, make_user) -> None:
    _, h = await make_user("d220a", admin=True)
    pid = await _proj(client, h, "D220元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "ui_element"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "ui_element" in body["supported_view_types"]
    assert body["view_label"] == "元素库"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {
        "name", "locator_type", "locator", "comment", "owner_id",
        "project_public", "updated_by", "created_at", "updated_at",
    }
    # 视图轴 / 模块树轴 / 取数机制参数 / 现算列都不是业务字段
    assert not ({"project_id", "recycled", "module_id", "module_ids", "unfiled_only",
                 "status", "current", "size", "cursor", "keyword", "used_by"} & fields), \
        "视图/模块树/取数轴与现算列不是可筛字段，不许进条件组"
    loc = next(f for f in body["fields"] if f["field"] == "locator_type")
    assert loc["kind"] == "enum" and "GT" not in loc["ops"]
    name = next(f for f in body["fields"] if f["field"] == "name")
    assert "CONTAINS" in name["ops"] and "BETWEEN" not in name["ops"]
    assert "EMPTY" not in name["ops"], "非空列不给「为空」假筛选项"
    comment = next(f for f in body["fields"] if f["field"] == "comment")
    assert {"EMPTY", "NOT_EMPTY"} <= set(comment["ops"])
    pub = next(f for f in body["fields"] if f["field"] == "project_public")
    assert pub["kind"] == "bool" and pub["ops"] == ["EQUALS", "NOT_EQUALS"]


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d220b", admin=True)
    pid = await _proj(client, h, "D220条件")
    await _el(client, h, pid, "登录按钮", locator_type="css", locator="#submit",
              comment="主按钮")
    await _el(client, h, pid, "登录输入框", locator_type="xpath", locator="//input")
    await _el(client, h, pid, "支付按钮", locator_type="css", locator=".pay",
              project_public=False)

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录按钮", "登录输入框"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "locator_type", "operator": "EQUALS", "value": "css"})) == {"登录按钮", "支付按钮"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "locator", "operator": "CONTAINS", "value": "submit"})) == {"登录按钮"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "comment", "operator": "CONTAINS", "value": "主按钮"})) == {"登录按钮"}
    # bool 列：项目内公开 = false 只剩那条私有元素（owner 自己是创建人，可见性不挡）
    assert await _names(client, h, pid, filter=_f(
        {"field": "project_public", "operator": "EQUALS", "value": False})) == {"支付按钮"}
    # OR：名字含「支付」或定位方式是 xpath → 两行
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "支付"},
        {"field": "locator_type", "operator": "EQUALS", "value": "xpath"}, mode="OR")) == {
        "支付按钮", "登录输入框"}
    # 谓词写在 LIMIT 之前：两行都匹配，size=1 只回一行但 total 是 2（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/ui-elements", params={
        "project_id": pid, "size": 1, "current": 1,
        "filter": _f({"field": "name", "operator": "CONTAINS", "value": "登录"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 2


async def test_filter_cannot_bypass_recycled_axis(client, make_user) -> None:
    _, h = await make_user("d220c", admin=True)
    pid = await _proj(client, h, "D220回收轴")
    await _el(client, h, pid, "登录-正常")
    dead = await _el(client, h, pid, "登录-已回收")
    rm = await client.post(_BASE + f"/ui-elements/{dead['id']}/delete",
                           json={"project_id": pid, "element_id": dead["id"]}, headers=h)
    assert rm.status_code == 200, rm.text

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-正常"}
    assert await _names(client, h, pid, recycled="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-已回收"}
    # 条件里点名墓碑也不行：正常视图里它不存在（轴先于条件）
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "EQUALS", "value": "登录-已回收"})) == set()


async def test_module_tree_axis_parallel_with_conditions(client, make_user) -> None:
    _, h = await make_user("d220d", admin=True)
    pid = await _proj(client, h, "D220模块轴")
    m1 = await _module(client, h, pid, "登录模块")
    await _el(client, h, pid, "登录-模块内", module_id=m1["id"])
    await _el(client, h, pid, "登录-未分类")

    # 左树 module_ids 是取数轴，与条件组并行 AND（不是替代）
    assert await _names(client, h, pid, module_ids=[m1["id"]], filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-模块内"}
    assert await _names(client, h, pid, unfiled_only="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-未分类"}
    # 模块归属不是可筛字段：条件里点 module_id 必须 400，而不是悄悄按模块筛
    r = await client.get(_BASE + "/ui-elements", params={
        "project_id": pid,
        "filter": _f({"field": "module_id", "operator": "EQUALS", "value": m1["id"]}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "ui_element"


async def test_nullable_comment_and_bad_filter(client, make_user) -> None:
    _, h = await make_user("d220e", admin=True)
    pid = await _proj(client, h, "D220空值")
    await _el(client, h, pid, "有备注", comment="主按钮")
    await _el(client, h, pid, "没备注")

    assert await _names(client, h, pid, filter=_f(
        {"field": "comment", "operator": "EMPTY", "value": None})) == {"没备注"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "comment", "operator": "NOT_EMPTY", "value": None})) == {"有备注"}

    # used_by 是现算的引用计数、不是列：点它必须 400，不许装作能筛
    r = await client.get(_BASE + "/ui-elements", params={
        "project_id": pid,
        "filter": _f({"field": "used_by", "operator": "EQUALS", "value": 0}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "ui_element"
    assert "本页可筛" in r.json()["message"]
    assert "元素名" in r.json()["message"], "400 要告诉用户这一页到底能按什么筛"
