"""D199：项目应用开关 + 误报库 + 用例编辑自动重审联动。"""
from __future__ import annotations

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, hb, pid: str, uid: str, role: str = "MEMBER") -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=hb)
    assert r.status_code == 200, r.text


async def _case(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/functional-cases", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_application_switch_list_and_update(client, make_user) -> None:
    _, h = await make_user("d199a", admin=True)
    pid = await _proj(client, h, "D199开关")
    lst = await client.get(_BASE + "/project-applications", params={"project_id": pid}, headers=h)
    assert lst.status_code == 200
    items = {x["key"]: x for x in lst.json()["items"]}
    assert items["functional.re_review"]["enabled"] is True  # 代码默认
    assert items["mock.enable"]["enabled"] is False

    up = await client.patch(_BASE + "/project-applications/mock.enable",
                            json={"project_id": pid, "key": "mock.enable", "enabled": True}, headers=h)
    assert up.status_code == 200 and up.json()["enabled"] is True
    again = await client.get(_BASE + "/project-applications", params={"project_id": pid}, headers=h)
    assert {x["key"]: x for x in again.json()["items"]}["mock.enable"]["enabled"] is True
    bad = await client.patch(_BASE + "/project-applications/nope",
                             json={"project_id": pid, "key": "nope", "enabled": True}, headers=h)
    assert bad.status_code == 422


async def test_fake_error_crud_and_validation(client, make_user) -> None:
    _, h = await make_user("d199f", admin=True)
    pid = await _proj(client, h, "D199误报")
    c = await client.post(_BASE + "/fake-errors", json={
        "project_id": pid, "name": "登录限流", "pattern": "429 Too Many",
        "match_type": "contains", "enabled": True,
    }, headers=h)
    assert c.status_code == 201, c.text
    rid = c.json()["id"]
    dup = await client.post(_BASE + "/fake-errors", json={
        "project_id": pid, "name": "登录限流", "pattern": "x", "match_type": "contains",
    }, headers=h)
    assert dup.status_code == 409
    bad_re = await client.post(_BASE + "/fake-errors", json={
        "project_id": pid, "name": "坏正则", "pattern": "(", "match_type": "regex",
    }, headers=h)
    assert bad_re.status_code == 422 and bad_re.json()["code"] == "bad_regex"
    u = await client.patch(_BASE + f"/fake-errors/{rid}",
                           json={"project_id": pid, "rule_id": rid, "pattern": "429", "enabled": False},
                           headers=h)
    assert u.status_code == 200 and u.json()["enabled"] is False and u.json()["pattern"] == "429"
    lst = await client.get(_BASE + "/fake-errors", params={"project_id": pid, "enabled_only": True}, headers=h)
    assert lst.json()["items"] == []
    assert (await client.post(_BASE + f"/fake-errors/{rid}/delete",
                              json={"project_id": pid, "rule_id": rid}, headers=h)).status_code == 200
    assert (await client.get(_BASE + "/fake-errors", params={"project_id": pid},
                             headers=h)).json()["items"] == []


async def test_case_edit_auto_rereview_respects_switch(client, make_user) -> None:
    boss, h = await make_user("d199r", admin=True)
    pid = await _proj(client, h, "D199重审")
    c = await _case(client, h, pid, "重审用例")
    r = await client.post(_BASE + "/case-reviews", json={
        "project_id": pid, "name": "自动重审评审", "case_ids": [c["id"]], "reviewer_ids": [boss.id],
    }, headers=h)
    rid = r.json()["id"]
    await client.post(_BASE + f"/case-reviews/{rid}/cases/{c['id']}/results", json={
        "project_id": pid, "review_id": rid, "case_id": c["id"], "action": "pass",
    }, headers=h)
    row = (await client.get(_BASE + f"/case-reviews/{rid}/cases",
                            params={"project_id": pid}, headers=h)).json()["items"][0]
    assert row["result"] == "pass"

    # 默认开关 on：改名称 → 自动重审
    await client.patch(_BASE + f"/functional-cases/{c['id']}",
                       json={"project_id": pid, "name": "重审用例（改）"}, headers=h)
    row = (await client.get(_BASE + f"/case-reviews/{rid}/cases",
                            params={"project_id": pid}, headers=h)).json()["items"][0]
    assert row["result"] == "pending" and row["re_review"] is True

    # 关掉开关：重新通过后改描述，不再触发重审
    await client.patch(_BASE + "/project-applications/functional.re_review",
                       json={"project_id": pid, "key": "functional.re_review", "enabled": False}, headers=h)
    await client.post(_BASE + f"/case-reviews/{rid}/cases/{c['id']}/results", json={
        "project_id": pid, "review_id": rid, "case_id": c["id"], "action": "pass",
    }, headers=h)
    await client.patch(_BASE + f"/functional-cases/{c['id']}",
                       json={"project_id": pid, "description": "新描述", "description_set": True}, headers=h)
    row = (await client.get(_BASE + f"/case-reviews/{rid}/cases",
                            params={"project_id": pid}, headers=h)).json()["items"][0]
    assert row["result"] == "pass" and row["re_review"] is False


async def test_permissions(client, make_user) -> None:
    boss, hb = await make_user("d199p", admin=True)
    ro, hr = await make_user("d199p2")
    pid = await _proj(client, hb, "D199权限")
    await _member(client, hb, pid, ro.id, "READONLY")
    assert (await client.get(_BASE + "/project-applications", params={"project_id": pid},
                             headers=hr)).status_code == 200
    deny = await client.patch(_BASE + "/project-applications/api.test",
                              json={"project_id": pid, "key": "api.test", "enabled": False}, headers=hr)
    assert deny.status_code == 403 and deny.json()["details"]["perm"] == "project:application:update"
