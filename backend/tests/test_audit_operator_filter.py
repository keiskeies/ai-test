"""审计的「操作人」筛选项端到端可筛（§11.5.1：操作人/模块/动作/对象/时间过滤）。

services.py 早就接了 user_id（AuditListIn + WHERE），这里钉的是**HTTP 面真的把它
带进 SQL**：同一项目里两个操作人各有一行日志时，?user_id= 必须只回那个人的行。
只对单个 user_id 断言「恰好一人」——Pilot（entry=agent，挂在触发人名下）与
schedule（user_id 为空）都不会被未设值的筛选悄悄藏掉。
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


async def _audit(client, h, pid, **extra):
    r = await client.get("/api/v1/audit", params={"project_id": pid, "size": 200, **extra}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def test_audit_filter_by_user_id(client, session, make_user) -> None:
    from app.modules.iam.models import ProjectMember

    h = await _admin_h(client, session)
    pid = await _project(client, h, "操作人筛选")
    # 系统管理员本人（admin）在这个项目留一行：env_create
    await _mk_env(client, h, pid, "共用环境")
    # 项目成员（非系统管理员）留另一行：env_create——两条日志、两个操作人
    op, hop = await make_user("operator_a")
    session.add(ProjectMember(project_id=pid, user_id=op.id, role_code="MEMBER"))
    await session.commit()
    await _mk_env(client, hop, pid, "成员环境")

    # 不设 user_id：两个人的行都在（筛选未设值不得悄悄隐藏任何操作人）
    whole = await _audit(client, h, pid)
    by_user = {x["user_id"] for x in whole}
    admin_id = (await client.get("/api/v1/auth/me", headers=h)).json()["id"]
    assert {admin_id, op.id} <= by_user, "种子没落全：" + str(by_user)

    # ?user_id= 只回那一个人的行——HTTP query 参数 → SQL WHERE 全链路
    only = await _audit(client, h, pid, user_id=op.id)
    assert only, "按操作人筛完反而空了 = user_id 没透传到 SQL"
    assert all(x["user_id"] == op.id for x in only), "筛了操作人却混进别人的行"
    assert admin_id not in {x["user_id"] for x in only}

    only_admin = await _audit(client, h, pid, user_id=admin_id)
    assert all(x["user_id"] == admin_id for x in only_admin)
    assert len(only) + len(only_admin) < len(whole) or by_user == {admin_id, op.id}


async def test_audit_agent_rows_survive_unfiltered_and_honor_operator(client, session) -> None:
    """Pilot 的行挂在触发人名下：按该操作人筛必须带出他的 Pilot 行，不设值时也不该丢。"""
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher

    h = await _admin_h(client, session)
    pid = await _project(client, h, "Pilot操作人筛选")
    admin = (await client.get("/api/v1/auth/me", headers=h)).json()

    disp = ToolDispatcher(session)
    ctx = ServiceCtx(entry="agent", user_id=admin["id"], user_name=admin["name"],
                     is_system_admin=True, perms={"*"}, db=session)
    ok = await disp.call("env_list", {"project_id": pid}, ctx, mode="PLAN", grants=set())
    assert ok.ok is True, ok.error

    whole = await _audit(client, h, pid)
    assert any(x["entry"] == "agent" and x["user_id"] == admin["id"] for x in whole)
    only = await _audit(client, h, pid, user_id=admin["id"])
    assert any(x["entry"] == "agent" for x in only), "按操作人筛把 Pilot 行筛丢了"
