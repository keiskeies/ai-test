"""D249 判据刀：设置页「环境组」高级搜索（D47-a 三件套铺到 env_group）。

钉的契约（对应 app/modules/env/group_services.py 白名单注释）：

1. 一枚 view_type `env_group`，页面名「环境组」，字段面 = 组名 / 说明 / 组内环境名 /
   创建 / 更新。`envs` 在 D259 起可筛（相关子查询 + 收窄的四个文本操作符，
   见 test_d259_env_group_envs_filter.py），`project_id` 仍是取数轴，不是可筛字段。
2. `project_id` 是取数轴，点名即 400。
3. 条件真的进 SQL：文本 CONTAINS / 可空列 EMPTY / 否定留 NULL 行 / time BETWEEN。
4. 不越项目：filter 只收窄既有 project_id 轴；空串 = 没筛选。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _group(client, h, pid: str, name: str, description: str | None = None) -> dict:
    r = await client.post(_BASE + "/env-groups", json={
        "project_id": pid, "name": name, "description": description, "env_ids": [],
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _list(client, h, pid: str, flt: str | None = None):
    params: dict[str, str] = {"project_id": pid}
    if flt is not None:
        params["filter"] = flt
    return await client.get(_BASE + "/env-groups", params=params, headers=h)


async def _names(client, h, pid: str, flt: str | None = None) -> set[str]:
    r = await _list(client, h, pid, flt)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


# ══════════ 1. filter_meta ══════════
async def test_env_group_filter_meta(client, make_user) -> None:
    _, h = await make_user("d249a", admin=True)
    pid = await _proj(client, h, "D249元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "env_group"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["view_label"] == "环境组"
    assert "env_group" in body["supported_view_types"]
    fields = {f["field"]: f for f in body["fields"]}
    assert set(fields) == {"name", "description", "envs", "created_at", "updated_at"}
    assert set(fields["name"]["ops"]) == {"CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS",
                                          "IN", "NOT_IN"}
    assert "EMPTY" in fields["description"]["ops"]
    assert "BETWEEN" in fields["created_at"]["ops"]
    # D259：组内环境名是拼接表达式，只给有诚实语义的四个操作符（EQUALS/IN 对多环境必漏判）
    assert set(fields["envs"]["ops"]) == {"CONTAINS", "NOT_CONTAINS", "EMPTY", "NOT_EMPTY"}
    # 取数轴不能出现在筛选面
    assert "project_id" not in fields


# ══════════ 2. 真能筛 ══════════
async def test_env_group_filter_actually_filters(client, make_user) -> None:
    _, h = await make_user("d249b", admin=True)
    pid = await _proj(client, h, "D249筛选")
    await _group(client, h, pid, "预发全套", "上线前回归")
    await _group(client, h, pid, "测试全套", "日常冒烟")
    await _group(client, h, pid, "本地调试")

    assert await _names(client, h, pid, _f(
        {"field": "name", "operator": "CONTAINS", "value": "全套"})) == {"预发全套", "测试全套"}
    assert await _names(client, h, pid, _f(
        {"field": "name", "operator": "EQUALS", "value": "本地调试"})) == {"本地调试"}
    assert await _names(client, h, pid, _f(
        {"field": "description", "operator": "CONTAINS", "value": "回归"})) == {"预发全套"}
    # 可空列：没写说明的「本地调试」
    assert await _names(client, h, pid, _f(
        {"field": "description", "operator": "EMPTY", "value": None})) == {"本地调试"}
    # 否定筛选留 NULL 行：说明不含「冒烟」的，本地调试（NULL）必须还在
    assert await _names(client, h, pid, _f(
        {"field": "description", "operator": "NOT_CONTAINS", "value": "冒烟"})) == {
        "预发全套", "本地调试"}
    # OR：名称含预发 或 说明含冒烟
    assert await _names(client, h, pid, _f(
        {"field": "name", "operator": "CONTAINS", "value": "预发"},
        {"field": "description", "operator": "CONTAINS", "value": "冒烟"}, mode="OR")) == {
        "预发全套", "测试全套"}
    assert len(await _names(client, h, pid, _f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]}))) == 3
    assert await _names(client, h, pid, _f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["1990-01-01T00:00:00Z", "1991-01-01T00:00:00Z"]})) == set()


# ══════════ 3. 不越项目 / 空 filter ══════════
async def test_env_group_filter_scope_and_empty(client, make_user) -> None:
    _, h = await make_user("d249c", admin=True)
    pid = await _proj(client, h, "D249本项目")
    other = await _proj(client, h, "D249别的项目")
    await _group(client, h, pid, "同名组")
    await _group(client, h, other, "同名组")

    hit = _f({"field": "name", "operator": "CONTAINS", "value": "同名"})
    r = await _list(client, h, pid, hit)
    assert r.status_code == 200, r.text
    assert [x["project_id"] for x in r.json()["items"]] == [pid]

    # 空串 = 没筛选（前端清空条件时发空串），不是 400 也不是空结果
    assert "同名组" in await _names(client, h, pid, "")


# ══════════ 4. 坏条件 ══════════
async def test_env_group_bad_filter(client, make_user) -> None:
    _, h = await make_user("d249d", admin=True)
    pid = await _proj(client, h, "D249坏条件")

    for bad in ("project_id",):
        r = await _list(client, h, pid, _f({"field": bad, "operator": "EQUALS", "value": "x"}))
        assert r.status_code == 400, r.text
        body = r.json()
        assert body["code"] == "bad_filter"
        assert body["details"]["view_type"] == "env_group"
        assert "本页可筛" in body["message"] and "组名" in body["message"]

    # 时间列不吃 CONTAINS（kind 白名单守门）
    r_op = await _list(client, h, pid, _f(
        {"field": "created_at", "operator": "CONTAINS", "value": "2026"}))
    assert r_op.status_code == 400 and r_op.json()["code"] == "bad_filter"

    # 坏 JSON 不许降级成「没筛」
    r_json = await client.get(_BASE + "/env-groups",
                              params={"project_id": pid, "filter": "{oops"}, headers=h)
    assert r_json.status_code == 400 and r_json.json()["code"] == "bad_filter"
