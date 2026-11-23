"""D231 判据刀：计划关注人（MS TestPlan 关注人端点的等价面）。

钉的契约（每一条都能在 services.py 指到实现）：

1. **幂等**：重复关注仍 following=True 且库里只有一行；重复取关仍 following=False、
   库零行；follower_count 是操作后**现查**的行数，不是「本次影响了多少」。
2. **两问都现查**：详情 PlanDetailOut 的 followed / follower_count 来自 plan_follower，
   不是存列；换一个用户看同一计划，followed 翻成 False 而 count 不变（正向对照）。
3. **列表行 followed 如实**：一页里关注/未关注各一行，标志位与库逐行一致；
   `followed_by_me=True` 只筛出「我」的行，`total` 吃同一份条件（不是筛后本地截断）。
4. **跨项目与不存在同码同文案**：follow/unfollow/get 三处 404 文案一致，不泄露存在性。
5. **级联**：删计划（单删与批量删）同事务删净关注行——不留孤儿（零外键纪律的应用层级联）。
6. **归档计划仍可关注**：归档是执行编排的终态，不是「话题关闭」（后端没有这道闸，
   测试钉住「没有」这件事，防止有人后来顺手加一个没需求的 409）。
7. **权限**：READONLY 能读详情（followed/count）但不能关注（:update 位，写副作用不借 read）；
   MEMBER 有 `*` 能关注；跨项目非成员 403「无此项目权限」。
8. **复制不抄关注**：复制件是全新计划，关注关系不跟着走（与「不抄执行结论与报告」同尺）。
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


async def _plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _follow(client, h, pid: str, plan_id: str):
    return await client.post(_BASE + f"/plans/{plan_id}/follow",
                             json={"project_id": pid}, headers=h)


async def _unfollow(client, h, pid: str, plan_id: str):
    return await client.post(_BASE + f"/plans/{plan_id}/unfollow",
                             json={"project_id": pid}, headers=h)


async def _detail(client, h, pid: str, plan_id: str):
    return await client.get(_BASE + f"/plans/{plan_id}", params={"project_id": pid}, headers=h)


async def _list(client, h, pid: str, **extra):
    return await client.get(_BASE + "/plans", params={"project_id": pid, **extra}, headers=h)


async def _count(conn, sql: str, **params) -> int:
    return int((await conn.execute(text(sql), params)).scalar_one())


async def test_follow_unfollow_are_idempotent_and_count_is_live(client, conn, make_user) -> None:
    _, h = await make_user("d231a", admin=True)
    pid = await _proj(client, h, "D231幂等")
    plan = await _plan(client, h, pid, "结算回归")

    r = await _follow(client, h, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"following": True, "follower_count": 1}

    # 重复关注：仍 True、计数不涨（幂等不是「再插一行」）。
    r = await _follow(client, h, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"following": True, "follower_count": 1}
    assert await _count(
        conn, "SELECT COUNT(*) FROM plan_follower WHERE plan_id=:p", p=plan["id"]
    ) == 1

    r = await _unfollow(client, h, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"following": False, "follower_count": 0}

    # 重复取关：仍 False、不报错（未关注不是错误状态）。
    r = await _unfollow(client, h, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"following": False, "follower_count": 0}
    assert await _count(
        conn, "SELECT COUNT(*) FROM plan_follower WHERE plan_id=:p", p=plan["id"]
    ) == 0


async def test_detail_reads_both_answers_live(client, make_user) -> None:
    _, h = await make_user("d231b", admin=True)
    pid = await _proj(client, h, "D231详情")
    plan = await _plan(client, h, pid, "登录回归")

    r = await _follow(client, h, pid, plan["id"])
    assert r.json()["follower_count"] == 1

    r = await _detail(client, h, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json()["followed"] is True
    assert r.json()["follower_count"] == 1

    # 另一个成员看同一计划：followed 翻成 False，count 不跟着翻（两问各自现查的正向对照）。
    mem, mh = await make_user("d231b2")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await _detail(client, mh, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json()["followed"] is False
    assert r.json()["follower_count"] == 1


async def test_list_flags_and_followed_by_me_filter(client, make_user) -> None:
    _, h = await make_user("d231c", admin=True)
    pid = await _proj(client, h, "D231列表")
    p1 = await _plan(client, h, pid, "甲计划")
    p2 = await _plan(client, h, pid, "乙计划")
    assert (await _follow(client, h, pid, p2["id"])).status_code == 200

    r = await _list(client, h, pid)
    assert r.status_code == 200, r.text
    rows = {x["id"]: x for x in r.json()["items"]}
    assert rows[p1["id"]]["followed"] is False
    assert rows[p2["id"]]["followed"] is True
    assert r.json()["total"] == 2

    r = await _list(client, h, pid, followed_by_me=True)
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["items"]] == [p2["id"]]
    # total 吃同一份条件：筛出来 1 条就说 1 条（不是全集的 2）。
    assert r.json()["total"] == 1

    # 没关注任何计划的人：空页 total=0（空列表是合法答案，不是 404）。
    other, oh = await make_user("d231c2")
    await _member(client, h, pid, other.id, "READONLY")
    r = await _list(client, oh, pid, followed_by_me=True)
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []
    assert r.json()["total"] == 0


async def test_cross_project_same_as_missing(client, make_user) -> None:
    _, h = await make_user("d231d", admin=True)
    pid_a = await _proj(client, h, "D231甲项目")
    pid_b = await _proj(client, h, "D231乙项目")
    plan_b = await _plan(client, h, pid_b, "别项目的计划")

    r = await _follow(client, h, pid_a, plan_b["id"])
    assert r.status_code == 404, r.text
    msg_follow = r.json()["message"]

    r = await _unfollow(client, h, pid_a, plan_b["id"])
    assert r.status_code == 404, r.text
    assert r.json()["message"] == msg_follow

    r = await _detail(client, h, pid_a, plan_b["id"])
    assert r.status_code == 404, r.text
    assert r.json()["message"] == msg_follow


async def test_plan_delete_cascades_followers(client, conn, make_user) -> None:
    _, h = await make_user("d231e", admin=True)
    pid = await _proj(client, h, "D231级联")
    p1 = await _plan(client, h, pid, "要删的")
    p2 = await _plan(client, h, pid, "批量删的")
    assert (await _follow(client, h, pid, p1["id"])).status_code == 200
    assert (await _follow(client, h, pid, p2["id"])).status_code == 200

    assert await _count(
        conn, "SELECT COUNT(*) FROM plan_follower WHERE project_id=:p", p=pid
    ) == 2

    r = await client.request("DELETE", _BASE + f"/plans/{p1['id']}",
                             json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert await _count(
        conn, "SELECT COUNT(*) FROM plan_follower WHERE plan_id=:p", p=p1["id"]
    ) == 0
    # 别的计划的关注行一根毫毛不动。
    assert await _count(
        conn, "SELECT COUNT(*) FROM plan_follower WHERE plan_id=:p", p=p2["id"]
    ) == 1

    r = await client.post(_BASE + "/plans/batch-delete",
                          json={"project_id": pid, "plan_ids": [p2["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    assert await _count(
        conn, "SELECT COUNT(*) FROM plan_follower WHERE project_id=:p", p=pid
    ) == 0


async def test_archived_plan_is_still_followable(client, make_user) -> None:
    _, h = await make_user("d231f", admin=True)
    pid = await _proj(client, h, "D231归档")
    plan = await _plan(client, h, pid, "归档计划")
    r = await client.post(_BASE + f"/plans/{plan['id']}/archive",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text

    r = await _follow(client, h, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json()["follower_count"] == 1
    r = await _detail(client, h, pid, plan["id"])
    assert r.json()["followed"] is True


async def test_permission_gates(client, conn, make_user) -> None:
    _, h = await make_user("d231g", admin=True)
    pid = await _proj(client, h, "D231门")
    plan = await _plan(client, h, pid, "门计划")

    ro, roh = await make_user("d231g_ro")
    await _member(client, h, pid, ro.id, "READONLY")
    # 读得到（含 followed/count 的两问），但关注是写副作用 → 走 :update 位 → 403。
    r = await _detail(client, roh, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json()["followed"] is False
    r = await _follow(client, roh, pid, plan["id"])
    assert r.status_code == 403, r.text
    assert r.json()["details"]["perm"] == "testplan:plan:update"
    assert await _count(
        conn, "SELECT COUNT(*) FROM plan_follower WHERE plan_id=:p", p=plan["id"]
    ) == 0

    mem, mh = await make_user("d231g_me")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await _follow(client, mh, pid, plan["id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"following": True, "follower_count": 1}

    # 跨项目非成员：连项目门都过不去（403 无此项目权限），不是 404 计划不存在。
    outsider, oh = await make_user("d231g_out")
    r = await _follow(client, oh, pid, plan["id"])
    assert r.status_code == 403, r.text


async def test_copy_does_not_carry_followers(client, make_user) -> None:
    _, h = await make_user("d231h", admin=True)
    pid = await _proj(client, h, "D231复制")
    plan = await _plan(client, h, pid, "源计划")
    assert (await _follow(client, h, pid, plan["id"])).status_code == 200

    r = await client.post(_BASE + f"/plans/{plan['id']}/copy",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 201, r.text
    copied = r.json()

    r = await _detail(client, h, pid, copied["id"])
    assert r.status_code == 200, r.text
    # 复制件是全新计划：关注关系不跟着走（与「不抄执行结论/报告」同尺）。
    assert r.json()["followed"] is False
    assert r.json()["follower_count"] == 0
    # 源计划的关注行仍在（复制不搬走源数据）。
    r = await _detail(client, h, pid, plan["id"])
    assert r.json()["followed"] is True
    assert r.json()["follower_count"] == 1
