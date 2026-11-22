"""项目级成员候选：项目管理员必须能在不持有平台权限的前提下把账号变成 user_id。

`PUT /projects/{pid}/members/{user_id}` 要的是 UUID，而 UUID 只能从 /system/users 拿，
那个口是 system:user:read（项目角色一律被 -system:* 拒绝）。少了这个口子，「添加成员」
在 UI 上就是一条走不通的路——只能让管理员去库里抄 ID。
"""
from __future__ import annotations


async def _mk(client, h, name):
    r = await client.post("/api/v1/projects", json={"name": name, "description": "d"}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_member_candidates_found_by_account(client, make_user) -> None:
    _, h = await make_user("boss_c1")
    pid = await _mk(client, h, "候选A")
    other, _ = await make_user("zhangsan_c")

    r = await client.get("/api/v1/project-member-candidates",
                         params={"project_id": pid, "q": "zhangsan"}, headers=h)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [x["account"] for x in items] == ["zhangsan_c"], items
    row = items[0]
    assert row["id"] == other.id and row["name"] and row["is_member"] is False, row
    # 只给路由需要的三样：不给 email / 状态 / 任何平台字段
    assert set(row) == {"id", "account", "name", "is_member"}, sorted(row)


async def test_member_candidates_marks_existing_member(client, make_user) -> None:
    _, h = await make_user("boss_c3")
    pid = await _mk(client, h, "候选B")
    w, _ = await make_user("wangwu_c")
    await client.put(f"/api/v1/projects/{pid}/members/{w.id}", json={"role_code": "MEMBER"}, headers=h)
    r = await client.get("/api/v1/project-member-candidates",
                         params={"project_id": pid, "q": "wangwu"}, headers=h)
    assert [x["is_member"] for x in r.json()["items"]] == [True]


async def test_member_candidates_requires_project_admin(client, make_user) -> None:
    _, h = await make_user("boss_c4")
    pid = await _mk(client, h, "候选C")
    ro, h_ro = await make_user("ro_c")
    await client.put(f"/api/v1/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"}, headers=h)
    r = await client.get("/api/v1/project-member-candidates",
                         params={"project_id": pid, "q": "boss"}, headers=h_ro)
    assert r.status_code == 403 and r.json()["code"] == "insufficient_permission", r.text


async def test_member_candidates_requires_membership(client, make_user) -> None:
    _, h = await make_user("boss_c5")
    pid = await _mk(client, h, "候选D")
    _, h_out = await make_user("outsider_c")
    r = await client.get("/api/v1/project-member-candidates",
                         params={"project_id": pid, "q": "boss"}, headers=h_out)
    assert r.status_code == 403 and r.json()["code"] == "forbidden", r.text


async def test_member_candidates_size_bounded(client, make_user) -> None:
    """候选集有界：不给项目管理员一次性拖走全平台账号的能力。"""
    _, h = await make_user("boss_c6")
    pid = await _mk(client, h, "候选E")
    for i in range(3):
        await make_user("bulk" + str(i) + "_c")
    r = await client.get("/api/v1/project-member-candidates",
                         params={"project_id": pid, "q": "bulk", "size": 2}, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) <= 2
    assert all("email" not in x and "status" not in x for x in r.json()["items"])
