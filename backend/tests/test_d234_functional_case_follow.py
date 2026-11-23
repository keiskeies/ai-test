"""D234 判据刀：功能用例关注人（MS `/test/case/follow` 的等价面）。

钉的契约（每一条都能在 services.py 指到实现）：

1. **幂等**：重复关注仍 following=True 且库里只有一行；重复取关仍 False、零行；
   follower_count 是操作后**现查**的行数，不是「本次影响了多少」。
2. **两问都现查**：详情 CaseDetailOut 的 followed / follower_count 来自
   `functional_case_follower`，不是存列；换一个用户看同一条用例，followed 翻成 False
   而 count 不变（正向对照）。
3. **列表行 followed 如实**：一页里关注/未关注各一行，标志位与库逐行一致；
   `followed_by_me=True` 只筛出「我」的行，`total` 吃同一份条件（不是筛后本地截断）。
4. **跨项目与不存在同码同文案**：follow/unfollow/get 三处 404 文案一致，不泄露存在性。
5. **级联**：彻底删除用例（单删与批量删）同事务删净关注行——零外键纪律的应用层级联。
6. **回收站用例仍可关注**：删除进回收站后关注行还在、仍可关注/取关（后端没有这道闸，
   测试钉住「没有」这件事）。
7. **权限**：READONLY 能读详情（followed/count）但不能关注（`:update` 位，写副作用
   不借 read）；MEMBER 有 `*` 能关注；跨项目非成员 403「无此项目权限」。
8. **复制不抄关注**（D233 交叉）：副本是全新用例，关注关系不跟着走。
"""
from __future__ import annotations

from sqlalchemy import text

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _case(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/functional-cases",
                          json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _follow(client, h, pid: str, case_id: str):
    return await client.post(_BASE + f"/functional-cases/{case_id}/follow",
                             json={"project_id": pid, "case_id": case_id}, headers=h)


async def _unfollow(client, h, pid: str, case_id: str):
    return await client.post(_BASE + f"/functional-cases/{case_id}/unfollow",
                             json={"project_id": pid, "case_id": case_id}, headers=h)


async def _detail(client, h, pid: str, case_id: str):
    return await client.get(_BASE + f"/functional-cases/{case_id}",
                            params={"project_id": pid}, headers=h)


async def _list(client, h, pid: str, **extra):
    return await client.get(_BASE + "/functional-cases",
                            params={"project_id": pid, **extra}, headers=h)


async def _count(conn, sql: str, **params) -> int:
    return int((await conn.execute(text(sql), params)).scalar_one())


async def test_follow_unfollow_are_idempotent_and_count_is_live(client, conn, make_user) -> None:
    _, h = await make_user("d234a", admin=True)
    pid = await _proj(client, h, "D234幂等")
    c = await _case(client, h, pid, "登录成功")

    r = await _follow(client, h, pid, c["id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"following": True, "follower_count": 1}

    r = await _follow(client, h, pid, c["id"])  # 幂等不是「再插一行」
    assert r.status_code == 200 and r.json() == {"following": True, "follower_count": 1}
    assert await _count(
        conn, "SELECT COUNT(*) FROM functional_case_follower WHERE case_id=:c", c=c["id"]
    ) == 1

    r = await _unfollow(client, h, pid, c["id"])
    assert r.status_code == 200 and r.json() == {"following": False, "follower_count": 0}

    r = await _unfollow(client, h, pid, c["id"])  # 未关注不是错误状态
    assert r.status_code == 200 and r.json() == {"following": False, "follower_count": 0}


async def test_detail_followed_and_count_are_live(client, make_user) -> None:
    _, h = await make_user("d234b", admin=True)
    other, oh = await make_user("d234b2")
    pid = await _proj(client, h, "D234现查")
    await _member(client, h, pid, other.id, "MEMBER")
    c = await _case(client, h, pid, "登录成功")
    assert (await _follow(client, h, pid, c["id"])).status_code == 200

    mine = (await _detail(client, h, pid, c["id"])).json()
    assert mine["followed"] is True and mine["follower_count"] == 1
    theirs = (await _detail(client, oh, pid, c["id"])).json()
    assert theirs["followed"] is False and theirs["follower_count"] == 1  # count 不因人而异


async def test_list_flags_and_followed_by_me_view(client, make_user) -> None:
    _, h = await make_user("d234c", admin=True)
    pid = await _proj(client, h, "D234列表")
    c1 = await _case(client, h, pid, "甲")
    await _case(client, h, pid, "乙")
    c3 = await _case(client, h, pid, "丙")
    for cid in (c1["id"], c3["id"]):
        assert (await _follow(client, h, pid, cid)).status_code == 200

    body = (await _list(client, h, pid, size=50)).json()
    flags = {i["name"]: i["followed"] for i in body["items"]}
    assert flags == {"甲": True, "乙": False, "丙": True}

    view = (await _list(client, h, pid, followed_by_me="true", size=50)).json()
    assert sorted(i["name"] for i in view["items"]) == ["丙", "甲"]
    assert view["total"] == 2  # total 吃同一份条件，不是筛后本地截断

    page = (await _list(client, h, pid, followed_by_me="true", size=1)).json()
    assert len(page["items"]) == 1 and page["total"] == 2

    bad = await _list(client, h, pid, followed_by_me="maybe")
    assert bad.status_code == 422  # 布尔参数写错格式时由框架拒，不静默当 False

    await _unfollow(client, h, pid, c1["id"])
    body = (await _list(client, h, pid, followed_by_me="true")).json()
    assert [i["id"] for i in body["items"]] == [c3["id"]] and body["total"] == 1


async def test_cross_project_and_missing_share_404(client, make_user) -> None:
    _, h = await make_user("d234d", admin=True)
    pid = await _proj(client, h, "D234甲")
    pid_b = await _proj(client, h, "D234乙")
    foreign = await _case(client, h, pid_b, "别项目用例")

    r = await _follow(client, h, pid, foreign["id"])
    assert r.status_code == 404 and r.json()["message"] == "用例不存在"
    r = await _unfollow(client, h, pid, foreign["id"])
    assert r.status_code == 404 and r.json()["message"] == "用例不存在"
    r = await _detail(client, h, pid, foreign["id"])
    assert r.status_code == 404 and r.json()["message"] == "用例不存在"

    r = await _follow(client, h, pid, "no-such-case")
    assert r.status_code == 404 and r.json()["message"] == "用例不存在"


async def test_purge_cascades_followers(client, conn, make_user) -> None:
    _, h = await make_user("d234e", admin=True)
    pid = await _proj(client, h, "D234级联")
    c1 = await _case(client, h, pid, "甲")
    c2 = await _case(client, h, pid, "乙")
    for cid in (c1["id"], c2["id"]):
        assert (await _follow(client, h, pid, cid)).status_code == 200
    for c in (c1, c2):
        r = await client.post(_BASE + f"/functional-cases/{c['id']}/delete",
                              json={"project_id": pid, "case_id": c["id"]}, headers=h)
        assert r.status_code == 200, r.text
    r = await client.post(_BASE + f"/functional-cases/{c1['id']}/purge",
                          json={"project_id": pid, "case_id": c1["id"],
                                "confirm_name": c1["name"]}, headers=h)
    assert r.status_code == 200, r.text
    assert await _count(
        conn, "SELECT COUNT(*) FROM functional_case_follower WHERE case_id=:c", c=c1["id"]
    ) == 0
    r = await client.post(_BASE + "/functional-cases/batch-purge",
                          json={"project_id": pid, "case_ids": [c2["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    assert await _count(
        conn, "SELECT COUNT(*) FROM functional_case_follower WHERE case_id=:c", c=c2["id"]
    ) == 0


async def test_recycled_still_followable(client, make_user) -> None:
    _, h = await make_user("d234f", admin=True)
    pid = await _proj(client, h, "D234回收站")
    c = await _case(client, h, pid, "甲")
    assert (await _follow(client, h, pid, c["id"])).status_code == 200
    r = await client.post(_BASE + f"/functional-cases/{c['id']}/delete",
                          json={"project_id": pid, "case_id": c["id"]}, headers=h)
    assert r.status_code == 200, r.text

    r = await _follow(client, h, pid, c["id"])  # 删进回收站不自动取关，也不设闸
    assert r.status_code == 200 and r.json()["follower_count"] == 1
    r = await _unfollow(client, h, pid, c["id"])
    assert r.status_code == 200 and r.json() == {"following": False, "follower_count": 0}


async def test_permissions(client, make_user) -> None:
    _, h = await make_user("d234g", admin=True)
    pid = await _proj(client, h, "D234权限")
    c = await _case(client, h, pid, "甲")

    ro, roh = await make_user("d234g_ro")
    await _member(client, h, pid, ro.id, "READONLY")
    assert (await _follow(client, h, pid, c["id"])).status_code == 200
    d = await _detail(client, roh, pid, c["id"])
    assert d.status_code == 200 and d.json()["followed"] is False
    r = await _follow(client, roh, pid, c["id"])
    assert r.status_code == 403, r.text
    assert r.json()["details"]["perm"] == "functional:case:update"
    r = await _unfollow(client, roh, pid, c["id"])
    assert r.status_code == 403, r.text

    mem, memh = await make_user("d234g_mem")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await _follow(client, memh, pid, c["id"])
    assert r.status_code == 200 and r.json()["follower_count"] == 2

    _, stranger_h = await make_user("d234g_out")
    r = await _follow(client, stranger_h, pid, c["id"])
    assert r.status_code == 403, r.text


async def test_copy_does_not_copy_followers(client, make_user) -> None:
    _, h = await make_user("d234h", admin=True)
    pid = await _proj(client, h, "D234复制")
    c = await _case(client, h, pid, "甲")
    assert (await _follow(client, h, pid, c["id"])).status_code == 200
    r = await client.post(_BASE + "/functional-cases/batch-copy",
                          json={"project_id": pid, "case_ids": [c["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    copy = (await _detail(client, h, pid, r.json()["case_ids"][0])).json()
    assert copy["followed"] is False and copy["follower_count"] == 0
