"""D259：环境组按「组内环境名」筛选（D249 明确留白的那一格）。

`envs` 不是一列，而是跨 environment_group_item + environment 的打包结果。D249 时
只说「需要 EXISTS 子查询，本次不做」；本轮用**相关标量子查询**把组内环境名拼成
GROUP_CONCAT 串接进白名单，并**收窄操作符**到四个有诚实语义的：

- CONTAINS：至少一个组内环境名含关键词；
- NOT_CONTAINS：没有任何组内环境名含关键词（空组也留下——NULL 不算「含」）；
- EMPTY / NOT_EMPTY：组里有没有环境。

EQUALS / IN 对拼接串在多个环境时必然漏判，**刻意不开放**（假筛选项禁令）——
从 filter-meta 与 400 文案两条路一起钉住。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _env(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/envs", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _group(client, h, pid: str, name: str, env_ids: list[str]) -> dict:
    r = await client.post(_BASE + "/env-groups", json={
        "project_id": pid, "name": name, "env_ids": env_ids}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(field: str, op: str, value=None, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode,
                       "conditions": [{"field": field, "operator": op, "value": value}]})


async def _names(client, h, pid: str, flt: str) -> set[str]:
    r = await client.get(_BASE + "/env-groups",
                         params={"project_id": pid, "filter": flt}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def _seed(client, h, pid: str) -> None:
    """四组：甲带预发+生产、乙只带测试、丙带联调、丁空组。"""
    pre = await _env(client, h, pid, "预发环境")
    prod = await _env(client, h, pid, "生产环境")
    test = await _env(client, h, pid, "测试环境")
    staging = await _env(client, h, pid, "联调环境")
    await _group(client, h, pid, "甲组", [pre["id"], prod["id"]])
    await _group(client, h, pid, "乙组", [test["id"]])
    await _group(client, h, pid, "丙组", [staging["id"]])
    await _group(client, h, pid, "丁组空", [])


# ══════════ 1. CONTAINS / NOT_CONTAINS：命中组内任一环境 ══════════
async def test_envs_contains_matches_any_env(client, make_user) -> None:
    _, h = await make_user("d259a")
    pid = await _proj(client, h, "D259环境名")
    await _seed(client, h, pid)

    assert await _names(client, h, pid, _f("envs", "CONTAINS", "预发")) == {"甲组"}
    assert await _names(client, h, pid, _f("envs", "CONTAINS", "环境")) == {
        "甲组", "乙组", "丙组"}
    # 不存在于任何组的环境名 → 空集（不是报错、不是全量）
    assert await _names(client, h, pid, _f("envs", "CONTAINS", "压测")) == set()
    # 否定：不含「预发」的组；空组（NULL）必须留下（三值逻辑口径同其它可空列）
    assert await _names(client, h, pid, _f("envs", "NOT_CONTAINS", "预发")) == {
        "乙组", "丙组", "丁组空"}


# ══════════ 2. EMPTY / NOT_EMPTY：组里有没有环境 ══════════
async def test_envs_empty_means_group_has_no_env(client, make_user) -> None:
    _, h = await make_user("d259b")
    pid = await _proj(client, h, "D259空组")
    await _seed(client, h, pid)

    assert await _names(client, h, pid, _f("envs", "EMPTY")) == {"丁组空"}
    assert await _names(client, h, pid, _f("envs", "NOT_EMPTY")) == {"甲组", "乙组", "丙组"}


# ══════════ 3. 条件与其它轴 AND/OR 共存，且不越项目 ══════════
async def test_envs_filter_composes_with_other_fields(client, make_user) -> None:
    _, h = await make_user("d259c")
    pid = await _proj(client, h, "D259组合")
    other = await _proj(client, h, "D259别的项目")
    await _seed(client, h, pid)
    foreign_env = await _env(client, h, other, "预发环境")
    await _group(client, h, other, "别项目组", [foreign_env["id"]])

    both = json.dumps({"search_mode": "AND", "conditions": [
        {"field": "envs", "operator": "CONTAINS", "value": "环境"},
        {"field": "name", "operator": "CONTAINS", "value": "甲"},
    ]})
    assert await _names(client, h, pid, both) == {"甲组"}

    either = json.dumps({"search_mode": "OR", "conditions": [
        {"field": "envs", "operator": "CONTAINS", "value": "联调"},
        {"field": "name", "operator": "EQUALS", "value": "乙组"},
    ]})
    assert await _names(client, h, pid, either) == {"乙组", "丙组"}

    # filter 只收窄既有 project_id 轴：别项目里同名的「预发环境」不许被捞出来
    r = await client.get(_BASE + "/env-groups", params={
        "project_id": pid, "filter": _f("envs", "CONTAINS", "预发")}, headers=h)
    assert {x["project_id"] for x in r.json()["items"]} == {pid}


# ══════════ 4. 收窄操作符：EQUALS/IN 对拼接串无诚实语义 → 400 且可筛清单含新字段 ══════════
async def test_envs_rejects_unlisted_operators(client, make_user) -> None:
    _, h = await make_user("d259d")
    pid = await _proj(client, h, "D259坏操作符")

    for op, val in (("EQUALS", "预发环境"), ("IN", ["预发环境"])):
        r = await client.get(_BASE + "/env-groups", params={
            "project_id": pid, "filter": _f("envs", op, val)}, headers=h)
        assert r.status_code == 400, r.text
        body = r.json()
        assert body["code"] == "bad_filter"
        # 400 文案必须点明这个字段能怎么筛，用户不用猜
        assert "本页可筛" in body["message"] and "组内环境名" in body["message"]
        assert "envs 是 text 列" in body["message"]
