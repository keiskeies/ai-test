"""D281 判据刀：功能用例「责任人」（对齐 MS 功能用例列表的责任人列）。

钉的契约（每条都能在 services.py 的 `functional_case_create/update` 指到实现）：

1. **创建可指定责任人**：回执与列表/详情都带 `owner_id` + `owner_name`（不画裸 UUID）；
   高级搜索 `owner_id EQUALS` 能筛到它。
2. **必须是本项目成员**：项目外的用户 422 `invalid_owner`（创建与更新两条路都拦）。
3. **`owner_set` 三态**：不带 = 不改、带 null = 清空、带值 = 改。
4. **复制随抄**：批量复制的副本带源用例的责任人（复制 = 新建，内容全抄）。
5. **统计 owner 轴**：`group_by=owner` 按责任人分组，未指派归「—」。
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


async def _case(client, h, pid: str, name: str, **kw):
    return await client.post(_BASE + "/functional-cases",
                             json={"project_id": pid, "name": name, **kw}, headers=h)


async def _list(client, h, pid: str, **params):
    return await client.get(_BASE + "/functional-cases",
                            params={"project_id": pid, "current": 1, "size": 50, **params},
                            headers=h)


def _filter(field: str, value: str) -> str:
    """D47-a 条件组：字段白名单来自 FUNCTIONAL_CASE_LIST_FILTER。"""
    return json.dumps({"search_mode": "AND", "conditions": [
        {"field": field, "operator": "EQUALS", "value": value},
    ]})


async def test_owner_roundtrip_list_detail_and_filter(client, make_user) -> None:
    _, h = await make_user("d281a", admin=True)
    owner, _ = await make_user("d281a_o")
    owner_id = owner.id  # 先取 id：后续 HTTP 请求 commit 会让 ORM 实例过期
    owner_name = owner.name
    pid = await _proj(client, h, "D281责任人")
    await _member(client, h, pid, owner_id, "MEMBER")

    r = await _case(client, h, pid, "登录成功", owner_id=owner_id)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["owner_id"] == owner_id and body["owner_name"] == owner_name

    listed = await _list(client, h, pid)
    assert listed.status_code == 200, listed.text
    row = next(x for x in listed.json()["items"] if x["id"] == body["id"])
    assert row["owner_id"] == owner_id and row["owner_name"] == owner_name

    detail = await client.get(_BASE + f"/functional-cases/{body['id']}",
                              params={"project_id": pid}, headers=h)
    assert detail.status_code == 200, detail.text
    assert detail.json()["owner_name"] == owner_name

    # 高级搜索：owner_id 是真实列，EQUALS 能筛到；筛别人不会误中
    hit = await _list(client, h, pid, filter=_filter("owner_id", owner_id))
    assert hit.status_code == 200, hit.text
    assert [x["id"] for x in hit.json()["items"]] == [body["id"]]
    miss = await _list(client, h, pid, filter=_filter("owner_id", "no-such-user"))
    assert miss.status_code == 200 and miss.json()["items"] == []


async def test_owner_must_be_project_member(client, make_user) -> None:
    _, h = await make_user("d281b", admin=True)
    outsider, _ = await make_user("d281b_out")
    outsider_id = outsider.id
    pid = await _proj(client, h, "D281越界")

    bad = await _case(client, h, pid, "越界指派", owner_id=outsider_id)
    assert bad.status_code == 422 and bad.json()["code"] == "invalid_owner"

    ok = await _case(client, h, pid, "先不指派")
    assert ok.status_code == 201 and ok.json()["owner_id"] is None
    upd = await client.patch(_BASE + f"/functional-cases/{ok.json()['id']}", json={
        "project_id": pid, "owner_id": outsider_id, "owner_set": True,
    }, headers=h)
    assert upd.status_code == 422 and upd.json()["code"] == "invalid_owner"


async def test_owner_three_state_and_copy(client, make_user) -> None:
    _, h = await make_user("d281c", admin=True)
    owner, _ = await make_user("d281c_o")
    owner_id = owner.id
    pid = await _proj(client, h, "D281三态")
    await _member(client, h, pid, owner_id, "MEMBER")

    created = await _case(client, h, pid, "带责任人", owner_id=owner_id)
    case_id = created.json()["id"]

    # 不带 owner_set = 不改（即使 owner_id 给了也不动）
    keep = await client.patch(_BASE + f"/functional-cases/{case_id}", json={
        "project_id": pid, "owner_id": None,
    }, headers=h)
    assert keep.status_code == 200 and keep.json()["owner_id"] == owner_id

    # 带 null = 清空
    cleared = await client.patch(_BASE + f"/functional-cases/{case_id}", json={
        "project_id": pid, "owner_id": None, "owner_set": True,
    }, headers=h)
    assert cleared.status_code == 200 and cleared.json()["owner_id"] is None
    assert cleared.json()["owner_name"] is None

    # 带值 = 改
    again = await client.patch(_BASE + f"/functional-cases/{case_id}", json={
        "project_id": pid, "owner_id": owner_id, "owner_set": True,
    }, headers=h)
    assert again.status_code == 200 and again.json()["owner_id"] == owner_id

    # 复制随抄责任人
    cp = await client.post(_BASE + "/functional-cases/batch-copy", json={
        "project_id": pid, "case_ids": [case_id],
    }, headers=h)
    assert cp.status_code == 200, cp.text
    copy_id = cp.json()["case_ids"][0]
    got = await client.get(_BASE + f"/functional-cases/{copy_id}",
                           params={"project_id": pid}, headers=h)
    assert got.status_code == 200 and got.json()["owner_id"] == owner_id


async def test_stats_owner_axis(client, make_user) -> None:
    _, h = await make_user("d281d", admin=True)
    owner, _ = await make_user("d281d_o")
    owner_id = owner.id
    owner_name = owner.name
    pid = await _proj(client, h, "D281统计")
    await _member(client, h, pid, owner_id, "MEMBER")

    await _case(client, h, pid, "甲", owner_id=owner_id)
    await _case(client, h, pid, "乙", owner_id=owner_id)
    await _case(client, h, pid, "丙")

    r = await client.post(_BASE + "/functional-cases/stats",
                          json={"project_id": pid, "group_by": "owner"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["group_by"] == "owner"
    groups = {g["key"]: g for g in body["groups"]}
    assert groups[owner_id]["label"] == owner_name and groups[owner_id]["count"] == 2
    assert groups[""]["label"] == "—" and groups[""]["count"] == 1
    assert sum(g["count"] for g in body["groups"]) == body["total"] == 3
