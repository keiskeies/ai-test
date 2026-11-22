"""T7 环境管理：第一个真实 @service（金线双路证明）。"""
from __future__ import annotations

from sqlalchemy import select


async def _mk_project(client, h, name):
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_env_crud_via_http(client, make_user) -> None:
    _, h = await make_user("envboss")
    pid = await _mk_project(client, h, "envproj1")
    body = {"project_id": pid, "name": "测试环境", "config": {"vars": [["base_url", "http://127.0.0.1:9999"]]}}
    r = await client.post("/api/v1/envs", json=body, headers=h)
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    assert r.json()["config"]["vars"][0][0] == "base_url"

    r2 = await client.get("/api/v1/envs", params={"project_id": pid}, headers=h)
    assert r2.status_code == 200 and [x["id"] for x in r2.json()["items"]] == [eid]

    r3 = await client.patch("/api/v1/envs/" + eid, json={"project_id": pid, "name": "预发"}, headers=h)
    assert r3.status_code == 200 and r3.json()["name"] == "预发"

    r4 = await client.request("DELETE", "/api/v1/envs/" + eid, json={"project_id": pid}, headers=h)
    assert r4.status_code == 200, r4.text
    r5 = await client.get("/api/v1/envs", params={"project_id": pid}, headers=h)
    assert r5.json()["items"] == []


async def test_env_via_agent_dispatcher_dual_audit(client, make_user, session) -> None:
    """同 service 经 Dispatcher（agent 入口）调用成功且审计多一条 entry=agent。"""
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher
    from app.modules.audit.models import AuditLog

    _, h = await make_user("envboss2")
    pid = await _mk_project(client, h, "envproj2")
    me = (await client.get("/api/v1/auth/me", headers=h)).json()

    ctx = ServiceCtx(entry="agent", user_id=me["id"], user_name="x", perms={"*"}, db=session)
    disp = ToolDispatcher(session)
    r = await disp.call("env_create", {"project_id": pid, "name": "agent建的环境"}, ctx, mode="FULL", grants=set())
    assert r.ok is True, r.error
    assert r.content["name"] == "agent建的环境"

    rows = (
        await session.execute(select(AuditLog).where(AuditLog.entry == "agent", AuditLog.action == "env_create"))
    ).scalars().all()
    assert len(rows) == 1


async def test_env_nonmember_forbidden(client, make_user) -> None:
    _, h_boss = await make_user("envboss3")
    _, h_out = await make_user("envout3")
    pid = await _mk_project(client, h_boss, "envproj3")
    r = await client.post("/api/v1/envs", json={"project_id": pid, "name": "x"}, headers=h_out)
    assert r.status_code == 403 and r.json()["code"] == "forbidden"


async def test_env_readonly_cannot_write(client, make_user) -> None:
    _, h_boss = await make_user("envboss4")
    pid = await _mk_project(client, h_boss, "envproj4")
    from app.core.db import get_sessionmaker
    from app.core.security import create_access_token, hash_password
    from app.modules.iam.models import User

    async with get_sessionmaker()() as s:
        u = User(account="envro4", name="envro4", password_hash=hash_password("Passw0rd!"), status="active")
        s.add(u)
        await s.commit()
        uid = u.id
    await client.put(f"/api/v1/projects/{pid}/members/{uid}", json={"role_code": "READONLY"}, headers=h_boss)
    hh = {"Authorization": "Bearer " + create_access_token(uid)}
    r = await client.get("/api/v1/envs", params={"project_id": pid}, headers=hh)
    assert r.status_code == 200
    r2 = await client.post("/api/v1/envs", json={"project_id": pid, "name": "x"}, headers=hh)
    assert r2.status_code == 403 and r2.json()["code"] == "insufficient_permission"


async def test_openapi_contains_env_routes(client) -> None:
    spec = (await client.get("/api/v1/openapi.json")).json()
    assert "/api/v1/envs" in spec["paths"]
    assert "post" in spec["paths"]["/api/v1/envs"] and "get" in spec["paths"]["/api/v1/envs"]
