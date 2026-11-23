"""D221 判据刀：用例评审列表高级搜索（D47-a 三件套铺到评审页）。

钉的契约：

1. **字段白名单 = CASE_REVIEW_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 `module_id`/`unfiled_only`（左树）、`keyword`、`status`（读时聚合）、
   `created_by_me` 等顶层轴并行 AND；OR 组自带括号。
3. **聚合列不进白名单**：`status`/`pass_rate`/`case_count` 是读时算出来的，不是列——
   点它们必须 400，不许装作能筛。
4. **可空列**：`description EMPTY/NOT_EMPTY`；`start_at`/`end_at` 可空可查。
5. **条件进 COUNT 同一份**：页码模式的 total 必须也吃 filter。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, hb, pid: str, uid: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": "MEMBER"}, headers=hb)
    assert r.status_code == 200, r.text


async def _case(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/functional-cases",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _review(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/case-reviews",
                          json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _module(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/case-review-modules",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/case-reviews",
                         params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_registers_case_review(client, make_user) -> None:
    _, h = await make_user("d221a", admin=True)
    pid = await _proj(client, h, "D221元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "case_review"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "case_review" in body["supported_view_types"]
    assert body["view_label"] == "用例评审"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {
        "num", "name", "description", "pass_rule", "started", "start_at", "end_at",
        "created_by", "updated_by", "created_at", "updated_at",
    }
    # 左树轴 / 快捷搜索 / 读时聚合列 / 个人视图开关 / 取数参数都不是业务字段
    assert not ({"project_id", "module_id", "unfiled_only", "keyword", "status",
                 "pass_rate", "case_count", "reviewer_count", "created_by_me",
                 "reviewing_me", "my_todo", "current", "size"} & fields), \
        "视图轴与聚合列不是可筛字段，不许进条件组"
    rule = next(f for f in body["fields"] if f["field"] == "pass_rule")
    assert rule["kind"] == "enum" and "GT" not in rule["ops"]
    started = next(f for f in body["fields"] if f["field"] == "started")
    assert started["kind"] == "bool" and started["ops"] == ["EQUALS", "NOT_EQUALS"]
    name = next(f for f in body["fields"] if f["field"] == "name")
    assert "EMPTY" not in name["ops"], "非空列不给「为空」假筛选项"
    desc = next(f for f in body["fields"] if f["field"] == "description")
    assert {"EMPTY", "NOT_EMPTY"} <= set(desc["ops"])


async def test_conditions_apply_as_where(client, make_user) -> None:
    rev, _ = await make_user("d221r")
    _, h = await make_user("d221b", admin=True)
    pid = await _proj(client, h, "D221条件")
    await _member(client, h, pid, rev.id)
    c = await _case(client, h, pid, "登录成功")
    await _review(client, h, pid, "登录评审", description="主流程",
                  case_ids=[c["id"]], reviewer_ids=[rev.id])
    await _review(client, h, pid, "支付评审", pass_rule="multiple",
                  case_ids=[c["id"]], reviewer_ids=[rev.id])
    await _review(client, h, pid, "对账评审", case_ids=[c["id"]], reviewer_ids=[rev.id])

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "评审"})) == {
        "登录评审", "支付评审", "对账评审"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录评审"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "pass_rule", "operator": "EQUALS", "value": "multiple"})) == {"支付评审"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "CONTAINS", "value": "主流程"})) == {"登录评审"}
    # 没人提交过结论 → started 全 False；bool 列可筛
    assert len(await _names(client, h, pid, filter=_f(
        {"field": "started", "operator": "EQUALS", "value": False}))) == 3
    assert await _names(client, h, pid, filter=_f(
        {"field": "started", "operator": "EQUALS", "value": True})) == set()
    # num 是 number 列
    first = (await client.get(_BASE + "/case-reviews",
                              params={"project_id": pid, "size": 1}, headers=h)).json()["items"]
    assert len(first) == 1
    assert await _names(client, h, pid, filter=_f(
        {"field": "num", "operator": "EQUALS", "value": first[0]["num"]})) == {first[0]["name"]}
    # OR：名字含「登录」或通过规则是多人 → 两行
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"},
        {"field": "pass_rule", "operator": "EQUALS", "value": "multiple"}, mode="OR")) == {
        "登录评审", "支付评审"}
    # 谓词在 LIMIT 之前：size=1 只回一行，total 是 3（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/case-reviews", params={
        "project_id": pid, "current": 1, "size": 1,
        "filter": _f({"field": "name", "operator": "CONTAINS", "value": "评审"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 3


async def test_filters_parallel_with_module_and_keyword_axes(client, make_user) -> None:
    rev, _ = await make_user("d221r2")
    _, h = await make_user("d221c", admin=True)
    pid = await _proj(client, h, "D221并行轴")
    await _member(client, h, pid, rev.id)
    m1 = await _module(client, h, pid, "登录评审模块")
    c = await _case(client, h, pid, "登录成功")
    await _review(client, h, pid, "登录评审", module_id=m1["id"],
                  case_ids=[c["id"]], reviewer_ids=[rev.id])
    await _review(client, h, pid, "登录评审-未分类", case_ids=[c["id"]], reviewer_ids=[rev.id])

    # 左树 module_id 与条件组并行 AND
    assert await _names(client, h, pid, module_id=m1["id"], filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录评审"}
    assert await _names(client, h, pid, unfiled_only="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录评审-未分类"}
    # 快捷搜索 keyword 与条件组并行 AND（两边都很窄时就为空）
    assert await _names(client, h, pid, keyword="登录", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "评审"})) == {
        "登录评审", "登录评审-未分类"}
    assert await _names(client, h, pid, keyword="登录", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "支付"})) == set()
    # 模块归属不是可筛字段：条件里点 module_id 必须 400，而不是悄悄按模块筛
    r = await client.get(_BASE + "/case-reviews", params={
        "project_id": pid,
        "filter": _f({"field": "module_id", "operator": "EQUALS", "value": m1["id"]}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "case_review"


async def test_nullable_description_and_aggregate_not_filterable(client, make_user) -> None:
    rev, _ = await make_user("d221r3")
    _, h = await make_user("d221d", admin=True)
    pid = await _proj(client, h, "D221空值与聚合")
    await _member(client, h, pid, rev.id)
    c = await _case(client, h, pid, "登录成功")
    await _review(client, h, pid, "有描述", description="主流程",
                  case_ids=[c["id"]], reviewer_ids=[rev.id])
    await _review(client, h, pid, "无描述", case_ids=[c["id"]], reviewer_ids=[rev.id])

    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "EMPTY", "value": None})) == {"无描述"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "NOT_EMPTY", "value": None})) == {"有描述"}
    # status/pass_rate/case_count 是读时聚合，不是列：点它们必须 400
    for field in ("status", "pass_rate", "case_count"):
        r = await client.get(_BASE + "/case-reviews", params={
            "project_id": pid,
            "filter": _f({"field": field, "operator": "EQUALS", "value": "x"}),
        }, headers=h)
        assert r.status_code == 400, (field, r.text)
        assert r.json()["code"] == "bad_filter"
        assert r.json()["details"]["view_type"] == "case_review"
    assert "本页可筛" in r.json()["message"]
    assert "评审名称" in r.json()["message"], "400 要告诉用户这一页到底能按什么筛"
