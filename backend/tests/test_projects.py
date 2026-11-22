"""T4 项目 / 成员 / 角色模板与数据权限（Review Focus 3+4）。"""
from __future__ import annotations


async def _mk_project(client, headers, name="交易中心"):
    r = await client.post("/api/v1/projects", json={"name": name, "description": "d"}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


async def test_create_project_creator_is_admin(client, make_user) -> None:
    u, h = await make_user("boss")
    pid = (await _mk_project(client, h))["id"]
    r = await client.get(f"/api/v1/projects/{pid}", headers=h)
    assert r.status_code == 200
    assert r.json()["my_role"] == "PROJECT_ADMIN"
    # 列表只见自己参与的项目
    r2 = await client.get("/api/v1/projects", headers=h)
    assert r2.status_code == 200
    assert [x["id"] for x in r2.json()["items"]] == [pid]


async def test_member_add_and_list(client, make_user) -> None:
    _, h_boss = await make_user("boss2")
    worker, h_worker = await make_user("worker")
    pid = (await _mk_project(client, h_boss))["id"]

    r = await client.put(f"/api/v1/projects/{pid}/members/{worker.id}", json={"role_code": "MEMBER"}, headers=h_boss)
    assert r.status_code == 200, r.text
    r2 = await client.get(f"/api/v1/projects/{pid}/members", headers=h_boss)
    codes = {m["user_id"]: m["role_code"] for m in r2.json()["items"]}
    assert codes[worker.id] == "MEMBER"

    # 成员可见项目，但改成员需项目管理权限
    r3 = await client.get(f"/api/v1/projects/{pid}", headers=h_worker)
    assert r3.status_code == 200 and r3.json()["my_role"] == "MEMBER"


async def test_nonmember_forbidden_same_as_not_found(client, make_user) -> None:
    """Review Focus 4：非成员 403 与不存在项目 403 响应体逐字段相等（不泄露存在性）。"""
    _, h_boss = await make_user("boss3")
    _, h_outsider = await make_user("outsider")
    pid = (await _mk_project(client, h_boss))["id"]
    ghost = "00000000-0000-0000-0000-000000000000"

    r1 = await client.get(f"/api/v1/projects/{pid}", headers=h_outsider)
    r2 = await client.get(f"/api/v1/projects/{ghost}", headers=h_outsider)
    assert r1.status_code == 403 and r2.status_code == 403
    assert r1.json() == r2.json()
    assert r1.json()["code"] == "forbidden"

    # 系统管理员不是成员也可见（系统级）
    _, h_root = await make_user("root1", admin=True)
    r3 = await client.get(f"/api/v1/projects/{pid}", headers=h_root)
    assert r3.status_code == 200


async def test_member_cannot_remove_members(client, make_user) -> None:
    _, h_boss = await make_user("boss4")
    worker, h_worker = await make_user("worker4")
    other, _ = await make_user("other4")
    pid = (await _mk_project(client, h_boss))["id"]
    await client.put(f"/api/v1/projects/{pid}/members/{worker.id}", json={"role_code": "MEMBER"}, headers=h_boss)
    await client.put(f"/api/v1/projects/{pid}/members/{other.id}", json={"role_code": "READONLY"}, headers=h_boss)

    r = await client.delete(f"/api/v1/projects/{pid}/members/{other.id}", headers=h_worker)
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "insufficient_permission"
    # 但可以移除自己（退出项目）
    r2 = await client.delete(f"/api/v1/projects/{pid}/members/{worker.id}", headers=h_worker)
    assert r2.status_code == 200, r2.text


async def test_roles_endpoint(client, make_user, session) -> None:
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)
    _, h = await make_user("root3", admin=True)
    r = await client.get("/api/v1/roles", headers=h)
    assert r.status_code == 200
    codes = {x["code"] for x in r.json()["items"]}
    assert {"SYSTEM_ADMIN", "PROJECT_ADMIN", "MEMBER", "READONLY"} <= codes


async def test_project_list_cursor_pagination(client, make_user) -> None:
    _, h = await make_user("boss5")
    for i in range(5):
        await _mk_project(client, h, f"p{i}")
    r = await client.get("/api/v1/projects?size=2", headers=h)
    body = r.json()
    assert len(body["items"]) == 2 and body["next_cursor"]
    r2 = await client.get(f"/api/v1/projects?size=2&cursor={body['next_cursor']}", headers=h)
    b2 = r2.json()
    assert len(b2["items"]) == 2
    assert {x["id"] for x in b2["items"]}.isdisjoint({x["id"] for x in body["items"]})
    r3 = await client.get("/api/v1/projects?cursor=%%%bad", headers=h)
    assert r3.status_code == 400 and r3.json()["code"] == "bad_cursor"


async def test_project_list_newest_first(client, make_user, session) -> None:
    """项目列表必须最新在前——这不是审美问题，是「刚建的项目根本看不见」的修法。

    来历：工作台一次拉 `size=200` 且**不翻页**（`workbench.tsx`），而后端按 UUID 主键
    升序返回。e2e 库攒到 337 个项目后，新建项目的 UUID 有约四成概率落在那 200 名之外，
    于是「建完项目 → 列表里找不到它」，bench.spec 就此随机红。`paginate` 的 size 硬上限
    也是 200，前端加不动——只能让最新那一页真的包含最新项目。

    时间戳是 MySQL DATETIME(0)（秒级），同一个测试里连建的项目 created_at 全都相同、
    只能靠 id 兜底，所以这里**显式写开时间**来验排序契约，而不是赌创建速度。
    """
    from datetime import UTC, datetime, timedelta

    from app.modules.iam.models import Project, ProjectMember

    u, h = await make_user("bossNew")
    base = datetime.now(UTC).replace(tzinfo=None)
    for i, nm in enumerate(["最旧", "中间", "最新"]):
        pid = "ord-" + str(i)
        session.add(Project(id=pid, name=nm, description="d", status="active",
                            created_at=base + timedelta(minutes=i),
                            updated_at=base + timedelta(minutes=i)))
        session.add(ProjectMember(project_id=pid, user_id=u.id, role_code="PROJECT_ADMIN"))
    await session.commit()

    items = (await client.get("/api/v1/projects?size=50", headers=h)).json()["items"]
    assert [x["name"] for x in items] == ["最新", "中间", "最旧"], items

    # 改成倒序复合游标后，翻页最容易悄悄坏：不重、不漏、坏游标照旧 400
    p1 = (await client.get("/api/v1/projects?size=2", headers=h)).json()
    assert [x["name"] for x in p1["items"]] == ["最新", "中间"]
    p2 = (await client.get("/api/v1/projects?size=2&cursor=" + p1["next_cursor"], headers=h)).json()
    assert [x["name"] for x in p2["items"]] == ["最旧"] and p2["next_cursor"] is None
    assert (await client.get("/api/v1/projects?cursor=%%%bad", headers=h)).json()["code"] == "bad_cursor"


async def test_duplicate_project_name_rejected(client, make_user) -> None:
    _, h = await make_user("boss6")
    await _mk_project(client, h, "同名")
    r = await client.post("/api/v1/projects", json={"name": "同名"}, headers=h)
    assert r.status_code == 409


async def test_update_project_requires_admin(client, make_user) -> None:
    _, h_boss = await make_user("boss7")
    worker, h_worker = await make_user("worker7")
    pid = (await _mk_project(client, h_boss))["id"]
    await client.put(f"/api/v1/projects/{pid}/members/{worker.id}", json={"role_code": "READONLY"}, headers=h_boss)
    r = await client.patch(f"/api/v1/projects/{pid}", json={"name": "改名"}, headers=h_worker)
    assert r.status_code == 403 and r.json()["code"] == "insufficient_permission"
    # D38 还债：缺的位名是契约字段（details.perm），不是埋在中文 message 里的正则靶子。
    # 两个抛错点各钉一条真 HTTP：require_perm（手写 iam 路由）与 ServiceCtx.require（注册表路由）。
    assert r.json()["details"] == {"perm": "project:update"}, r.text
    r2 = await client.patch(f"/api/v1/projects/{pid}", json={"name": "改名"}, headers=h_boss)
    assert r2.status_code == 200 and r2.json()["name"] == "改名"

    # ServiceCtx.require 抛错点：READONLY 建环境缺 env:config:create
    r3 = await client.post("/api/v1/envs", json={"project_id": pid, "name": "越权环境"}, headers=h_worker)
    assert r3.status_code == 403 and r3.json()["code"] == "insufficient_permission", r3.text
    assert r3.json()["details"] == {"perm": "env:config:create"}, r3.text


async def test_forbidden_403_stays_bare(client, make_user) -> None:
    """成员制门（forbidden）不指名任何位：与「项目不存在」同体的契约不许被 details.perm 污染。"""
    _, h_boss = await make_user("boss_perm1")
    _, h_out = await make_user("outsider_perm1")
    pid = (await _mk_project(client, h_boss))["id"]
    r = await client.get(f"/api/v1/projects/{pid}", headers=h_out)
    assert r.status_code == 403 and r.json()["code"] == "forbidden"
    assert r.json()["details"] == {}, r.text

async def test_project_out_carries_effective_perms(client, make_user) -> None:
    """§10.1 按钮级渲染的服务端事实源：my_perms 与后端 match_perm 同源。

    角色模板可编辑，前端按内置角色表硬编码会让自定义角色「一个按钮都不显示」却没有任何
    解释；把生效模式串随项目一起下发，前端只解释不猜测。
    """
    from app.core.db import get_sessionmaker
    from app.modules.iam.models import RoleTemplate

    _, h = await make_user("bossperm")
    proj = await _mk_project(client, h, "权限下发")
    assert proj["my_perms"] == sorted({"*", "-system:*"}), "创建者拿到的是解析后的模式串"
    pid = proj["id"]

    ro, h_ro = await make_user("roperm")
    await client.put(f"/api/v1/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"}, headers=h)
    mine = (await client.get(f"/api/v1/projects/{pid}", headers=h_ro)).json()["my_perms"]
    assert "*:read" in mine and "-system:*" in mine, mine
    listed = (await client.get("/api/v1/projects", headers=h_ro)).json()["items"]
    assert [x["my_perms"] for x in listed if x["id"] == pid] == [mine], "列表与详情必须同源"

    # 自定义角色：改模板 → 下发跟着变（前端内置角色表根本不知道它的存在）
    intern, h_it = await make_user("internperm")
    async with get_sessionmaker()() as s:
        s.add(RoleTemplate(code="QA_JUNIOR", name="测试实习", perms=["api:def:read", "api:run:read"], builtin=False))
        await s.commit()
    await client.put(f"/api/v1/projects/{pid}/members/{intern.id}", json={"role_code": "QA_JUNIOR"}, headers=h)
    got = (await client.get(f"/api/v1/projects/{pid}", headers=h_it)).json()["my_perms"]
    assert "api:def:read" in got and "api:run:read" in got, got
    assert "-system:*" in got, "平台级拒绝与内置角色同样施加在自定义角色上"
    # 最小权限：模板没给的读位一个都不给（env:read 不在模板里 → 403，不继承任何默认读）
    r_env = await client.get("/api/v1/envs", params={"project_id": pid}, headers=h_it)
    assert r_env.status_code == 403 and r_env.json()["code"] == "insufficient_permission", r_env.text


async def test_last_project_admin_guard(client, make_user) -> None:
    """唯一的项目管理员不能被降级或移出，否则项目再没人能改成员、清回收站。

    平台管理员豁免是刻意的：他权限是全局 *，卸掉项目角色项目也不会失管；
    若连他都拦，就变成「想退出必须先找个陌生人背锅」的死锁。
    """
    root, h_root = await make_user("root16", admin=True)
    keeper, h_keeper = await make_user("keeper16")
    taker, h_taker = await make_user("taker16")
    pid = (await _mk_project(client, h_root))["id"]

    # 平台管理员卸掉自己的项目角色：豁免放行
    r = await client.put(f"/api/v1/projects/{pid}/members/{root.id}",
                         json={"role_code": "READONLY"}, headers=h_root)
    assert r.status_code == 200, r.text

    # keeper 升为唯一的项目管理员，taker 做普通成员
    for u, code in ((keeper, "PROJECT_ADMIN"), (taker, "MEMBER")):
        rr = await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                              json={"role_code": code}, headers=h_root)
        assert rr.status_code == 200, rr.text

    # 唯一管理员想降级自己 → 409，且解释里给出下一步怎么走
    r2 = await client.put(f"/api/v1/projects/{pid}/members/{keeper.id}",
                          json={"role_code": "READONLY"}, headers=h_keeper)
    assert r2.status_code == 409, r2.text
    assert r2.json()["code"] == "last_project_admin"
    assert "项目管理员" in r2.json()["message"]

    # 直接把自己移出项目同样拦住：本人退出虽不受权限限制，但不能让项目失管
    r3 = await client.delete(f"/api/v1/projects/{pid}/members/{keeper.id}", headers=h_keeper)
    assert r3.status_code == 409, r3.text
    assert r3.json()["code"] == "last_project_admin"

    # 先移交、再退位：这条路必须是通的
    r4 = await client.put(f"/api/v1/projects/{pid}/members/{taker.id}",
                          json={"role_code": "PROJECT_ADMIN"}, headers=h_keeper)
    assert r4.status_code == 200, r4.text
    r5 = await client.delete(f"/api/v1/projects/{pid}/members/{keeper.id}", headers=h_keeper)
    assert r5.status_code == 200, r5.text

    # 项目没变成孤儿：仍有管理员，且新管理员真的能管成员
    ms = await client.get(f"/api/v1/projects/{pid}/members", headers=h_taker)
    assert ms.status_code == 200
    codes = {m["account"]: m["role_code"] for m in ms.json()["items"]}
    assert codes == {"root16": "READONLY", "taker16": "PROJECT_ADMIN"}
    r6 = await client.put(f"/api/v1/projects/{pid}/members/{keeper.id}",
                          json={"role_code": "MEMBER"}, headers=h_taker)
    assert r6.status_code == 200, r6.text

