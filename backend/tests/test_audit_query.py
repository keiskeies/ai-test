"""T16 审计查询：谁/何时/入口/动作/对象/结果，Web 与 Pilot 同表（§4.10、§11.4.27、§11.4.37）。

三条治理红线钉在这里：
1) 权限位 system:audit:read 只有系统管理员有。项目管理员是 `-*:manage` 且角色不含
   system:* → 必须 403，否则每个项目管理员都能翻别的项目在干什么。
2) Agent 的工具调用与人的写操作同表呈现（entry=agent）：业主怎么审计人就怎么审计 Pilot。
3) 只读入口（GET 路由）不落审计：否则「打开审计页」本身会把审计刷满，治理面板变成噪音。
"""
from __future__ import annotations

from tests.conftest import ADMIN_PASSWORD


async def _admin_h(client, session):
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


async def _project(client, h, name):
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mk_env(client, h, pid, name):
    r = await client.post("/api/v1/envs", json={"project_id": pid, "name": name,
                                            "config": {"vars": [["base_url", "http://127.0.0.1:9999"]]}}, headers=h)
    assert r.status_code == 201, r.text


async def test_audit_query_shape_and_filters(client, session) -> None:
    h = await _admin_h(client, session)
    pid = await _project(client, h, "审计项目")
    await _mk_env(client, h, pid, "测试环境")

    # 一次成功的写入 = 一行 entry=http（同事务落，不是异步补记）
    r = await client.get("/api/v1/audit", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items, "项目里发生过写入却没有审计行 = 审计没接上写入口"
    row = items[0]
    for k in ("id", "ts", "user_id", "user_name", "entry", "action", "target", "ok", "diff"):
        assert k in row, "审计行缺字段 " + k
    assert row["entry"] == "http" and row["action"] == "env_create"
    assert row["target"] == pid, "target 必须是对象标识，否则无法追溯改的是哪个资源"
    assert row["user_name"], "审计要能直接读出是谁，不该让业主去查用户表"
    # 最新在前：治理面板第一屏要看的就是刚刚发生了什么
    ts = [x["ts"] for x in items]
    assert ts == sorted(ts, reverse=True), "审计列表必须倒序"

    # action 精确筛选：业主查「谁在这个项目建过环境」
    r2 = await client.get("/api/v1/audit", params={"project_id": pid, "action": "env_create"}, headers=h)
    assert r2.status_code == 200
    assert all(x["action"] == "env_create" for x in r2.json()["items"])

    # 失败的写入同样留痕（审计的价值一半在「谁试过且没成」）
    bad = await client.post("/api/v1/envs", json={"project_id": pid, "name": "测试环境"}, headers=h)
    assert bad.status_code == 409
    r3 = await client.get("/api/v1/audit", params={"project_id": pid, "ok": "false"}, headers=h)
    assert r3.status_code == 200, r3.text
    assert r3.json()["items"], "失败写入没落审计"
    assert r3.json()["items"][0]["ok"] is False
    assert "error" in (r3.json()["items"][0]["diff"] or {})

    # entry=agent 现在是空的：Web 操作不会伪装成 Pilot
    r4 = await client.get("/api/v1/audit", params={"project_id": pid, "entry": "agent"}, headers=h)
    assert r4.status_code == 200 and r4.json()["items"] == []


async def test_audit_query_shows_agent_entry(client, session) -> None:
    """Pilot 的工具调用落同一张表：审计是业主核查 Agent 行为的唯一凭据。"""
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher

    h = await _admin_h(client, session)
    pid = await _project(client, h, "Pilot审计")
    admin = (await client.get("/api/v1/auth/me", headers=h)).json()

    disp = ToolDispatcher(session)
    ctx = ServiceCtx(entry="agent", user_id=admin["id"], user_name=admin["name"],
                    is_system_admin=True, perms={"*"}, db=session)
    ok = await disp.call("env_list", {"project_id": pid}, ctx, mode="PLAN", grants=set())
    assert ok.ok is True, ok.error
    denied = await disp.call("_no_such_tool_xyz", {"project_id": pid}, ctx, mode="PLAN", grants=set())
    assert denied.ok is False

    r = await client.get("/api/v1/audit", params={"project_id": pid, "entry": "agent"}, headers=h)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert any(x["action"] == "env_list" and x["ok"] for x in items)
    assert any(x["ok"] is False for x in items), "被拒的调用也要留痕"


async def test_audit_query_requires_system_admin(client, session, make_user) -> None:
    h = await _admin_h(client, session)
    pid = await _project(client, h, "别人的项目")
    await _mk_env(client, h, pid, "生产")

    from app.modules.iam.models import ProjectMember

    # 项目管理员：`-*:manage` 且角色不含 system:* → 审计必须 403
    pa, hpa = await make_user("proj_admin")
    session.add(ProjectMember(project_id=pid, user_id=pa.id, role_code="PROJECT_ADMIN"))
    await session.commit()
    r = await client.get("/api/v1/audit", params={"project_id": pid}, headers=hpa)
    assert r.status_code == 403, r.text
    assert r.json()["code"] in ("insufficient_permission", "forbidden")

    ro, hro = await make_user("proj_ro")
    session.add(ProjectMember(project_id=pid, user_id=ro.id, role_code="READONLY"))
    await session.commit()
    assert (await client.get("/api/v1/audit", params={"project_id": pid}, headers=hro)).status_code == 403

    # 不带 project_id 的平台级审计：普通用户连门槛都过不了
    assert (await client.get("/api/v1/audit", headers=hro)).status_code == 403


async def test_audit_query_paging_cursor(client, session) -> None:
    h = await _admin_h(client, session)
    pid = await _project(client, h, "翻页项目")
    for i in range(5):
        await _mk_env(client, h, pid, "环境" + str(i))
    r1 = await client.get("/api/v1/audit", params={"project_id": pid, "size": 2}, headers=h)
    assert r1.status_code == 200
    assert len(r1.json()["items"]) == 2 and r1.json()["next_cursor"]
    r2 = await client.get("/api/v1/audit", params={"project_id": pid, "size": 2,
                                                    "cursor": r1.json()["next_cursor"]}, headers=h)
    assert len(r2.json()["items"]) == 2
    ids = [x["id"] for x in r1.json()["items"]] + [x["id"] for x in r2.json()["items"]]
    assert len(set(ids)) == 4, "游标翻页重复了：" + str(ids)

    # 非法游标 → bad_cursor：不静默返回首页，否则用户以为数据丢了
    r3 = await client.get("/api/v1/audit", params={"project_id": pid, "cursor": "@@@@"}, headers=h)
    assert r3.status_code == 400 and r3.json()["code"] == "bad_cursor"

async def test_custom_role_cannot_grant_platform_perms(client, session, make_user) -> None:
    """自定义角色即使写了 system:*，项目作用域也拿不到平台级权限位。

    角色模板可编辑（role_template 表），所以这条不能只靠内置模板的 `-system:*`；
    拒绝必须发生在权限解析出口，而不是模板文案里。
    """
    from app.modules.iam.models import ProjectMember, RoleTemplate

    h = await _admin_h(client, session)
    pid = await _project(client, h, "自定义角色")
    session.add(RoleTemplate(code="INTERN", name="实习生", perms=["system:*", "*:read"], builtin=False))
    await session.commit()
    it, hi = await make_user("intern1")
    session.add(ProjectMember(project_id=pid, user_id=it.id, role_code="INTERN"))
    await session.commit()

    r = await client.get("/api/v1/audit", params={"project_id": pid}, headers=hi)
    assert r.status_code == 403, r.text
    # 项目内的读仍然正常：拒绝只砍 system:*，没有把角色整体废掉
    assert (await client.get("/api/v1/envs", params={"project_id": pid}, headers=hi)).status_code == 200
    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=hi)).json()["items"]
    assert not [x["name"] for x in tools if x["perm"].startswith("system:")]
