"""D244 判据刀：平台用户页高级搜索（D47-a 三件套铺到 /system/users）。

钉的契约（对应 iam/user_services.py USER_LIST_FILTER 的注释）：

1. **字段白名单 = 页面上看得见的标量列**：账号 / 姓名 / 邮箱 / 类型（是否平台管理员）/
   状态 / 创建时间。`password_hash`（凭据材料，连「按哈希子串筛」都不该存在）、
   `prefs`（JSON）、`id`（定位键）都不进；点名即 400。
2. **条件是 WHERE 且在游标分页之前**：筛出的两行 size=1 只回一行且 next_cursor 非空，
   下一页接着回另一行——不是「先取一页再在页内过滤」。
3. **布尔列收真布尔**：is_system_admin 只收 EQUALS/NOT_EQUALS 且 value 必须是 JSON
   true/false；字符串 "true" 400（否则同一条件两套写法、必有一边撒谎）。
4. **空 filter = 没传**；非法字段/坏 JSON 400 且 code=bad_filter，message 点名本页可筛清单。
5. **平台级作用域**：用户表没有 project_id，两个项目的 filter-meta 都能用、列表集合相同。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _user(client, h, account: str, **over) -> dict:
    body = {"account": account, "name": "用户" + account,
            "password": "Passw0rd!demo", "email": None, "is_system_admin": False, **over}
    r = await client.post(_BASE + "/system/users", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _accounts(client, h, **params) -> set[str]:
    r = await client.get(_BASE + "/system/users", params=params, headers=h)
    assert r.status_code == 200, r.text
    return {x["account"] for x in r.json()["items"]}


async def test_filter_meta_registers_user(client, make_user) -> None:
    _, h = await make_user("d244a", admin=True)
    pid = await _proj(client, h, "D244元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "user"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "user" in body["supported_view_types"]
    assert body["view_label"] == "平台用户"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"account", "name", "email", "is_system_admin", "status", "created_at"}
    assert not ({"password_hash", "prefs", "id"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["is_system_admin"]["kind"] == "bool"
    assert set(by_field["is_system_admin"]["ops"]) == {"EQUALS", "NOT_EQUALS"}
    assert "EMPTY" in by_field["email"]["ops"]
    assert "EMPTY" not in by_field["account"]["ops"]


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d244b", admin=True)
    await _user(client, h, "d244b_alpha", email="alpha@example.com")
    await _user(client, h, "d244b_beta", is_system_admin=True)
    other = await _user(client, h, "d244b_gamma")
    r = await client.post(_BASE + "/system/users/" + other["id"] + "/status",
                          json={"user_id": other["id"], "status": "disabled"}, headers=h)
    assert r.status_code == 200, r.text

    assert await _accounts(client, h, filter=_f(
        {"field": "account", "operator": "CONTAINS", "value": "d244b_"})) == {
        "d244b_alpha", "d244b_beta", "d244b_gamma"}
    assert await _accounts(client, h, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "alpha"})) == {"d244b_alpha"}
    # 邮箱非空 + 账号前缀（AND）：只看本用例造的行，不把夹具管理员算进来
    assert await _accounts(client, h, filter=_f(
        {"field": "account", "operator": "CONTAINS", "value": "d244b_"},
        {"field": "email", "operator": "NOT_EMPTY", "value": None})) == {"d244b_alpha"}
    assert await _accounts(client, h, filter=_f(
        {"field": "status", "operator": "EQUALS", "value": "disabled"})) == {"d244b_gamma"}
    assert await _accounts(client, h, filter=_f(
        {"field": "is_system_admin", "operator": "EQUALS", "value": True})) >= {
        "d244b_beta", "d244b"}
    # OR：账号含 beta 或邮箱以 alpha@ 开头
    assert await _accounts(client, h, filter=_f(
        {"field": "account", "operator": "CONTAINS", "value": "beta"},
        {"field": "email", "operator": "CONTAINS", "value": "alpha@"}, mode="OR")) == {
        "d244b_alpha", "d244b_beta"}


async def test_filter_runs_before_cursor_pagination(client, make_user) -> None:
    _, h = await make_user("d244c", admin=True)
    await _user(client, h, "d244c_one")
    await _user(client, h, "d244c_two")
    cond = _f({"field": "account", "operator": "CONTAINS", "value": "d244c_"})
    first = await client.get(_BASE + "/system/users",
                             params={"filter": cond, "size": 1}, headers=h)
    assert first.status_code == 200, first.text
    body = first.json()
    assert len(body["items"]) == 1
    assert body["next_cursor"], "筛出两行、size=1 时必须还有下一页（过滤发生在 LIMIT 之前）"
    second = await client.get(_BASE + "/system/users",
                              params={"filter": cond, "size": 1,
                                      "cursor": body["next_cursor"]}, headers=h)
    assert second.status_code == 200, second.text
    got = {body["items"][0]["account"], second.json()["items"][0]["account"]}
    assert got == {"d244c_one", "d244c_two"}


async def test_bool_value_must_be_real_boolean(client, make_user) -> None:
    _, h = await make_user("d244d", admin=True)
    r = await client.get(_BASE + "/system/users", params={
        "filter": _f({"field": "is_system_admin", "operator": "EQUALS", "value": "true"})},
        headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"


async def test_bad_filter_is_400_with_page_field_list(client, make_user) -> None:
    _, h = await make_user("d244e", admin=True)
    pid = await _proj(client, h, "D244坏条件")

    r = await client.get(_BASE + "/system/users", params={
        "filter": _f({"field": "password_hash", "operator": "CONTAINS", "value": "abc"}),
    }, headers=h)
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter"
    assert body["details"]["view_type"] == "user"
    assert "本页可筛" in body["message"] and "账号" in body["message"]

    # 坏 JSON 不许降级成「没筛」
    r2 = await client.get(_BASE + "/system/users",
                          params=[("filter", "{not json")], headers=h)
    assert r2.status_code == 400 and r2.json()["code"] == "bad_filter"
    assert pid


async def test_empty_filter_returns_all(client, make_user) -> None:
    _, h = await make_user("d244f", admin=True)
    await _user(client, h, "d244f_one")
    await _user(client, h, "d244f_two")
    accounts = await _accounts(client, h, filter="")
    assert {"d244f_one", "d244f_two"} <= accounts


async def test_platform_level_scope_is_shared_across_projects(client, make_user) -> None:
    _, h = await make_user("d244g", admin=True)
    pid_a = await _proj(client, h, "D244项目A")
    pid_b = await _proj(client, h, "D244项目B")
    await _user(client, h, "d244g_shared")
    cond = _f({"field": "account", "operator": "EQUALS", "value": "d244g_shared"})
    for pid in (pid_a, pid_b):
        meta = await client.get(_BASE + "/filter-meta",
                                params={"project_id": pid, "view_type": "user"}, headers=h)
        assert meta.status_code == 200, meta.text
        assert await _accounts(client, h, filter=cond) == {"d244g_shared"}
