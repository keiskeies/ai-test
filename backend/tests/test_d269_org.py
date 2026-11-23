"""D269：组织层（org 扩列 / org_member / project.organization_id / 组织角色边界）。

口径（设计文档 §4.1 单租户不变）：
- 组织只做管理与分组，**不**改变项目数据权限（项目可见性仍按 project_member）；
- 系统管理员独占组织创建/删除；ORG_ADMIN 管本组织成员与项目归属；ORG_MEMBER 只读；
- 组织成员能看到本组织名下的项目列表（组织是组织成员可见的分组），但打不开项目数据。
"""
from __future__ import annotations

from app.modules.iam.models import Org, OrgMember, Project


async def _create_org(client, headers, *, name: str = "研发一部", code: str = "rd1",
                      description: str | None = "默认描述") -> dict:
    r = await client.post("/api/v1/system/orgs", headers=headers,
                          json={"name": name, "code": code, "description": description})
    assert r.status_code == 201, r.text
    return r.json()


async def _add_member(client, headers, org_id: str, account: str, role: str) -> dict:
    r = await client.post("/api/v1/system/orgs/members/set", headers=headers,
                          json={"org_id": org_id, "account": account, "role_code": role})
    assert r.status_code == 200, r.text
    return r.json()


async def test_org_crud_and_guards(client, make_user, session) -> None:
    _, admin = await make_user("root", admin=True)
    org = await _create_org(client, admin)
    assert org["my_role"] == "SYSTEM_ADMIN"
    assert org["member_count"] == 1  # 创建者自动成为组织管理员
    assert org["project_count"] == 0

    # 代码/名称都不可重复
    r = await client.post("/api/v1/system/orgs", headers=admin,
                          json={"name": "另一个", "code": "rd1"})
    assert r.status_code == 409 and r.json()["code"] == "conflict"
    r = await client.post("/api/v1/system/orgs", headers=admin,
                          json={"name": "研发一部", "code": "rd2"})
    assert r.status_code == 409 and r.json()["code"] == "conflict"

    # 列表 + 关键字 + 详情
    r = await client.post("/api/v1/system/orgs/query", headers=admin, json={"q": "研发"})
    assert r.status_code == 200
    assert [i["id"] for i in r.json()["items"]] == [org["id"]]
    r = await client.post("/api/v1/system/orgs/get", headers=admin, json={"org_id": org["id"]})
    assert r.status_code == 200 and r.json()["code"] == "rd1"

    # 改名/说明/状态
    r = await client.post("/api/v1/system/orgs/update", headers=admin,
                          json={"org_id": org["id"], "name": "研发中心", "status": "disabled"})
    assert r.status_code == 200
    assert r.json()["name"] == "研发中心" and r.json()["status"] == "disabled"

    # 默认组织不可删
    default = await _create_org(client, admin, name="默认组织", code="default")
    r = await client.post("/api/v1/system/orgs/delete", headers=admin, json={"org_id": default["id"]})
    assert r.status_code == 409 and r.json()["code"] == "default_org"

    # 有项目的组织不可删；移出后可删（并级联清成员）
    proj = await client.post("/api/v1/projects", headers=admin, json={"name": "组织项目"})
    assert proj.status_code == 201, proj.text
    pid = proj.json()["id"]
    r = await client.post("/api/v1/system/orgs/projects/assign", headers=admin,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 200, r.text
    r = await client.post("/api/v1/system/orgs/delete", headers=admin, json={"org_id": org["id"]})
    assert r.status_code == 409 and r.json()["code"] == "org_not_empty"
    r = await client.post("/api/v1/system/orgs/projects/remove", headers=admin,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 200
    r = await client.post("/api/v1/system/orgs/delete", headers=admin, json={"org_id": org["id"]})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert (await session.execute(
        OrgMember.__table__.select().where(OrgMember.org_id == org["id"])
    )).all() == []


async def test_org_members_and_last_admin_guard(client, make_user) -> None:
    admin_user, admin = await make_user("root", admin=True)
    # 先取标量：失败的写请求会 rollback，过期实例的懒加载在异步会话里会炸 MissingGreenlet。
    admin_id = admin_user.id
    org = await _create_org(client, admin)
    u1, _ = await make_user("u1")
    u2, _ = await make_user("u2")
    u1_id, u2_id = u1.id, u2.id

    assert (await _add_member(client, admin, org["id"], "u1", "ORG_MEMBER"))["role_code"] == "ORG_MEMBER"
    r = await client.post("/api/v1/system/orgs/members/query", headers=admin, json={"org_id": org["id"]})
    assert r.status_code == 200
    accounts = {i["account"] for i in r.json()["items"]}
    assert accounts == {admin_user.account, "u1"}

    # u1 提成管理员后，可以把创建者降为普通成员；但最后一名管理员不能被降/被移出
    await _add_member(client, admin, org["id"], "u1", "ORG_ADMIN")
    await _add_member(client, admin, org["id"], "u1", "ORG_MEMBER")  # 仍有创建者一名管理员
    r = await client.post("/api/v1/system/orgs/members/set", headers=admin,
                          json={"org_id": org["id"], "account": admin_user.account, "role_code": "ORG_MEMBER"})
    assert r.status_code == 409 and r.json()["code"] == "last_org_admin"
    r = await client.post("/api/v1/system/orgs/members/remove", headers=admin,
                          json={"org_id": org["id"], "user_id": admin_id})
    assert r.status_code == 409 and r.json()["code"] == "last_org_admin"

    # 未知账号 / 未知成员
    r = await client.post("/api/v1/system/orgs/members/set", headers=admin,
                          json={"org_id": org["id"], "account": "nobody", "role_code": "ORG_MEMBER"})
    assert r.status_code == 404
    r = await client.post("/api/v1/system/orgs/members/remove", headers=admin,
                          json={"org_id": org["id"], "user_id": u2_id})
    assert r.status_code == 404

    # 非法角色在 schema 层被拒
    r = await client.post("/api/v1/system/orgs/members/set", headers=admin,
                          json={"org_id": org["id"], "account": "u1", "role_code": "PROJECT_ADMIN"})
    assert r.status_code == 422

    r = await client.post("/api/v1/system/orgs/members/remove", headers=admin,
                          json={"org_id": org["id"], "user_id": u1_id})
    assert r.status_code == 200


async def test_org_project_assignment(client, make_user, session) -> None:
    _, admin = await make_user("root", admin=True)
    org = await _create_org(client, admin)
    proj = await client.post("/api/v1/projects", headers=admin, json={"name": "归档项目"})
    pid = proj.json()["id"]

    r = await client.post("/api/v1/system/orgs/projects/assign", headers=admin,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 200 and r.json()["id"] == pid
    row = (await session.execute(Project.__table__.select().where(Project.id == pid))).first()
    assert row is not None and row.organization_id == org["id"]

    r = await client.post("/api/v1/system/orgs/projects/query", headers=admin, json={"org_id": org["id"]})
    assert [i["id"] for i in r.json()["items"]] == [pid]
    r = await client.post("/api/v1/system/orgs/get", headers=admin, json={"org_id": org["id"]})
    assert r.json()["project_count"] == 1

    # 不存在的项目 / 不属于该组织的项目
    r = await client.post("/api/v1/system/orgs/projects/assign", headers=admin,
                          json={"org_id": org["id"], "target_project_id": "nope"})
    assert r.status_code == 404
    _ = await _create_org(client, admin, name="另一个组织", code="rd2")
    r = await client.post("/api/v1/system/orgs/projects/remove", headers=admin,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 200
    r = await client.post("/api/v1/system/orgs/projects/remove", headers=admin,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 404


async def test_org_roles_scope_and_isolation(client, make_user) -> None:
    _, admin = await make_user("root", admin=True)
    _, h1 = await make_user("u1")
    _, h2 = await make_user("u2")
    _, h3 = await make_user("u3")
    org = await _create_org(client, admin)
    other = await _create_org(client, admin, name="隔离组织", code="iso")
    await _add_member(client, admin, org["id"], "u1", "ORG_ADMIN")
    await _add_member(client, admin, org["id"], "u2", "ORG_MEMBER")
    proj = await client.post("/api/v1/projects", headers=admin, json={"name": "组织内项目"})
    pid = proj.json()["id"]
    await client.post("/api/v1/system/orgs/projects/assign", headers=admin,
                      json={"org_id": org["id"], "target_project_id": pid})

    # ORG_ADMIN：只见自己的组织，可管理成员/项目/改资料，但不能建组织
    r = await client.post("/api/v1/system/orgs/query", headers=h1, json={})
    assert [i["id"] for i in r.json()["items"]] == [org["id"]]
    r = await client.post("/api/v1/system/orgs/members/query", headers=h1, json={"org_id": org["id"]})
    assert r.status_code == 200
    r = await client.post("/api/v1/system/orgs/update", headers=h1,
                          json={"org_id": org["id"], "description": "组织管理员改的说明"})
    assert r.status_code == 200 and r.json()["description"] == "组织管理员改的说明"
    r = await client.post("/api/v1/system/orgs/projects/query", headers=h1, json={"org_id": org["id"]})
    assert [i["id"] for i in r.json()["items"]] == [pid]
    r = await client.post("/api/v1/system/orgs", headers=h1, json={"name": "越权组织", "code": "xx"})
    assert r.status_code == 403
    r = await client.post("/api/v1/system/orgs/delete", headers=h1, json={"org_id": org["id"]})
    assert r.status_code == 403
    # 别的组织不可见/不可改（响应同形，不泄露存在性）
    r = await client.post("/api/v1/system/orgs/get", headers=h1, json={"org_id": other["id"]})
    assert r.status_code == 403

    # ORG_MEMBER：能看组织与项目清单，不能看成员/不能改
    r = await client.post("/api/v1/system/orgs/members/query", headers=h2, json={"org_id": org["id"]})
    assert r.status_code == 403
    r = await client.post("/api/v1/system/orgs/projects/query", headers=h2, json={"org_id": org["id"]})
    assert r.status_code == 200
    r = await client.post("/api/v1/system/orgs/projects/remove", headers=h2,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 403

    # 外部用户：列表为空、详情 403、mine 为空
    r = await client.post("/api/v1/system/orgs/query", headers=h3, json={})
    assert r.status_code == 200 and r.json()["items"] == []
    r = await client.post("/api/v1/system/orgs/get", headers=h3, json={"org_id": org["id"]})
    assert r.status_code == 403
    r = await client.post("/api/v1/my-orgs", headers=h3, json={})
    assert r.status_code == 200 and r.json()["items"] == []
    r = await client.post("/api/v1/my-orgs", headers=h1, json={})
    assert [i["role_code"] for i in r.json()["items"]] == ["ORG_ADMIN"]

    # 组织成员不会因为「在组织里」就获得项目数据权限：项目详情仍是成员制
    r = await client.get(f"/api/v1/projects/{pid}", headers=h2)
    assert r.status_code == 403


async def test_create_project_org_resolution(client, make_user, session) -> None:
    _, admin = await make_user("root", admin=True)
    _, h1 = await make_user("u1")
    # 干净库没有默认组织（conftest TRUNCATE），手动造一个验证回落
    session.add(Org(id="default-org", name="默认组织", code="default", status="normal"))
    await session.commit()

    r = await client.post("/api/v1/projects", headers=h1, json={"name": "未指定组织的项目"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    row = (await session.execute(Project.__table__.select().where(Project.id == pid))).first()
    assert row.organization_id == "default-org"

    # 非成员不能把项目塞进别人的组织；成为成员后可以
    other = await _create_org(client, admin, name="其他组织", code="other")
    r = await client.post("/api/v1/projects", headers=h1,
                          json={"name": "越权组织项目", "organization_id": other["id"]})
    assert r.status_code == 403
    await _add_member(client, admin, other["id"], "u1", "ORG_MEMBER")
    r = await client.post("/api/v1/projects", headers=h1,
                          json={"name": "合法组织项目", "organization_id": other["id"]})
    assert r.status_code == 201, r.text
    row = (await session.execute(
        Project.__table__.select().where(Project.id == r.json()["id"]))).first()
    assert row.organization_id == other["id"]

    r = await client.post("/api/v1/projects", headers=h1,
                          json={"name": "不存在的组织", "organization_id": "nope"})
    assert r.status_code == 404
