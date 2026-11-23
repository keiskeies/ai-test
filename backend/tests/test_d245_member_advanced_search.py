"""D245 判据刀：项目成员页高级搜索（D47-a 三件套铺到设置页「成员」Tab）。

钉的契约（对应 iam/project_services.py MEMBER_LIST_FILTER 的注释）：

1. **字段白名单 = 表格里看得见的标量列**：账号 / 姓名 / 角色。`user_id` / `id` 是
   定位键，`project_id` 是作用域参数（由 ensure_member 管），都不进；点名即 400。
2. **条件只做收窄、不做扩权**：filter 的 WHERE 追加在 `project_id == ...` 之后，
   别的项目的成员一行都不许露头。
3. **空 filter = 没传**；坏 JSON 400 且 code=bad_filter，message 点名本页可筛清单。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _user(client, h, account: str) -> str:
    r = await client.post(_BASE + "/system/users", json={
        "account": account, "name": "成员" + account,
        "password": "Passw0rd!demo", "email": None, "is_system_admin": False}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _add(client, h, pid: str, uid: str, role: str = "MEMBER") -> None:
    r = await client.put(_BASE + "/projects/" + pid + "/members/" + uid,
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _accounts(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/projects/" + pid + "/members", params=params, headers=h)
    assert r.status_code == 200, r.text
    return {x["account"] for x in r.json()["items"]}


async def test_filter_meta_registers_member(client, make_user) -> None:
    _, h = await make_user("d245a", admin=True)
    pid = await _proj(client, h, "D245元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "member"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "member" in body["supported_view_types"]
    assert body["view_label"] == "项目成员"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"account", "name", "role_code"}
    assert not ({"project_id", "user_id", "id"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["role_code"]["kind"] == "enum" and "CONTAINS" not in by_field["role_code"]["ops"]
    assert "EMPTY" not in by_field["account"]["ops"]


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d245b", admin=True)
    pid = await _proj(client, h, "D245条件")
    u1 = await _user(client, h, "d245b_alpha")
    u2 = await _user(client, h, "d245b_beta")
    u3 = await _user(client, h, "d245b_gamma")
    await _add(client, h, pid, u1, "MEMBER")
    await _add(client, h, pid, u2, "READONLY")
    await _add(client, h, pid, u3, "MEMBER")

    assert await _accounts(client, h, pid, filter=_f(
        {"field": "account", "operator": "CONTAINS", "value": "d245b_"})) == {
        "d245b_alpha", "d245b_beta", "d245b_gamma"}
    assert await _accounts(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "beta"})) == {"d245b_beta"}
    assert await _accounts(client, h, pid, filter=_f(
        {"field": "role_code", "operator": "EQUALS", "value": "READONLY"})) == {"d245b_beta"}
    # OR：账号含 alpha 或角色是 READONLY
    assert await _accounts(client, h, pid, filter=_f(
        {"field": "account", "operator": "CONTAINS", "value": "alpha"},
        {"field": "role_code", "operator": "EQUALS", "value": "READONLY"}, mode="OR")) == {
        "d245b_alpha", "d245b_beta"}


async def test_filter_never_leaks_other_project(client, make_user) -> None:
    _, h = await make_user("d245c", admin=True)
    pid_a = await _proj(client, h, "D245项目A")
    pid_b = await _proj(client, h, "D245项目B")
    ua = await _user(client, h, "d245c_a")
    ub = await _user(client, h, "d245c_b")
    await _add(client, h, pid_a, ua)
    await _add(client, h, pid_b, ub)
    cond = _f({"field": "account", "operator": "CONTAINS", "value": "d245c_"})
    assert await _accounts(client, h, pid_a, filter=cond) == {"d245c_a"}
    assert await _accounts(client, h, pid_b, filter=cond) == {"d245c_b"}


async def test_bad_filter_is_400_with_page_field_list(client, make_user) -> None:
    _, h = await make_user("d245d", admin=True)
    pid = await _proj(client, h, "D245坏条件")

    r = await client.get(_BASE + "/projects/" + pid + "/members", params={
        "filter": _f({"field": "project_id", "operator": "EQUALS", "value": pid})}, headers=h)
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter"
    assert body["details"]["view_type"] == "member"
    assert "本页可筛" in body["message"] and "账号" in body["message"]

    # 角色是枚举列，没有「包含」
    r2 = await client.get(_BASE + "/projects/" + pid + "/members", params={
        "filter": _f({"field": "role_code", "operator": "CONTAINS", "value": "MEMBER"})},
        headers=h)
    assert r2.status_code == 400 and r2.json()["code"] == "bad_filter"

    r3 = await client.get(_BASE + "/projects/" + pid + "/members",
                          params=[("filter", "{not json")], headers=h)
    assert r3.status_code == 400 and r3.json()["code"] == "bad_filter"


async def test_empty_filter_returns_all(client, make_user) -> None:
    _, h = await make_user("d245e", admin=True)
    pid = await _proj(client, h, "D245空条件")
    await _add(client, h, pid, await _user(client, h, "d245e_one"))
    await _add(client, h, pid, await _user(client, h, "d245e_two"))
    accounts = await _accounts(client, h, pid, filter="")
    assert {"d245e_one", "d245e_two"} <= accounts
