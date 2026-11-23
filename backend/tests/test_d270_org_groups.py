"""D270：组织级用户组（org_user_group / org_user_group_member）。

口径（D269 单租户约束不变）：
- 组作用域是**组织**，只细化「谁能在组织层做什么」（改资料/管成员/管项目归属/管组），
  **不**参与 `perms_for_user`，所以组员拿不到任何项目数据访问；
- 系统管理员与 ORG_ADMIN 天然持全部四个组织管理位，无需进组；
- 组委派的管理员不能自升 ORG_ADMIN（否则一条组权限就能换到全量组织位）。
"""
from __future__ import annotations

from typing import get_args

from sqlalchemy import func, select

from app.modules.iam.models import ORG_GROUP_PERMS, OrgUserGroup, OrgUserGroupMember, User

CAP_UPDATE = "system:org:update"
CAP_MEMBER = "system:org:member:manage"
CAP_PROJECT = "system:org:project:manage"
CAP_GROUP = "system:org:group:manage"


async def _org(client, headers, *, name: str = "研发一部", code: str = "rd1") -> dict:
    r = await client.post("/api/v1/system/orgs", headers=headers,
                          json={"name": name, "code": code})
    assert r.status_code == 201, r.text
    return r.json()


async def _join(client, headers, org_id: str, account: str, role: str = "ORG_MEMBER"):
    r = await client.post("/api/v1/system/orgs/members/set", headers=headers,
                          json={"org_id": org_id, "account": account, "role_code": role})
    assert r.status_code == 200, r.text


async def _group(client, headers, org_id: str, name: str, perms: list[str]) -> dict:
    r = await client.post("/api/v1/system/orgs/groups", headers=headers,
                          json={"org_id": org_id, "name": name, "perms": perms})
    assert r.status_code == 201, r.text
    return r.json()


async def _add_member(client, headers, group_id: str, account: str):
    return await client.post("/api/v1/system/orgs/groups/members/set", headers=headers,
                             json={"group_id": group_id, "account": account})


async def test_schema_caps_match_model_constants() -> None:
    """schema 的 OrgCap 与模型的 ORG_GROUP_PERMS 必须逐字一致（两处手写，靠这条钉住）。"""
    from app.modules.iam.org_schemas import OrgCap

    assert set(get_args(OrgCap)) == set(ORG_GROUP_PERMS)
    # D271 追加第五枚 system:org:defect:manage（组织级缺陷状态流模板）。
    assert len(ORG_GROUP_PERMS) == 5


async def test_group_caps_delegate_but_never_escalate(client, make_user, session) -> None:
    _, admin = await make_user("root", admin=True)
    _, alice = await make_user("alice")
    _, bob = await make_user("bob")
    org = await _org(client, admin)
    await _join(client, admin, org["id"], "alice")
    await _join(client, admin, org["id"], "bob")

    # 无组的普通成员：既看不到组，也管不了成员
    r = await client.post("/api/v1/system/orgs/groups/query", headers=alice,
                          json={"org_id": org["id"]})
    assert r.status_code == 403
    r = await client.post("/api/v1/system/orgs/members/query", headers=alice,
                          json={"org_id": org["id"]})
    assert r.status_code == 403

    g = await _group(client, admin, org["id"], "成员管理员", [CAP_MEMBER])
    assert g["perms"] == [CAP_MEMBER] and g["member_count"] == 0
    r = await _add_member(client, admin, g["id"], "alice")
    assert r.status_code == 200 and r.json()["account"] == "alice"
    # 重复加入幂等
    r = await _add_member(client, admin, g["id"], "alice")
    assert r.status_code == 200

    # alice 现在能看成员、能把 carol 拉进组织
    r = await client.post("/api/v1/system/orgs/members/query", headers=alice,
                          json={"org_id": org["id"]})
    assert r.status_code == 200
    assert {i["account"] for i in r.json()["items"]} == {"root", "alice", "bob"}
    _, carol = await make_user("carol")
    await _join(client, alice, org["id"], "carol")

    # 但 member:manage 不外溢：改资料/管项目/管组仍然 403
    r = await client.post("/api/v1/system/orgs/update", headers=alice,
                          json={"org_id": org["id"], "name": "被改名"})
    assert r.status_code == 403
    r = await client.post("/api/v1/system/orgs/projects/assign", headers=alice,
                          json={"org_id": org["id"], "target_project_id": "whatever"})
    assert r.status_code == 403
    r = await client.post("/api/v1/system/orgs/groups/query", headers=alice,
                          json={"org_id": org["id"]})
    assert r.status_code == 403

    # 组委派的人不能自升 ORG_ADMIN（升级口只留给 ORG_ADMIN/系统管理员）
    r = await client.post("/api/v1/system/orgs/members/set", headers=alice,
                          json={"org_id": org["id"], "account": "alice", "role_code": "ORG_ADMIN"})
    assert r.status_code == 403

    # org_list 逐行投影 my_perms（界面按它显隐按钮）
    r = await client.post("/api/v1/system/orgs/query", headers=alice, json={})
    assert r.status_code == 200
    row = next(i for i in r.json()["items"] if i["id"] == org["id"])
    assert row["my_role"] == "ORG_MEMBER" and row["my_perms"] == [CAP_MEMBER]
    # ORG_ADMIN（root 建组织时自动成为）看到的是全量五位
    r = await client.post("/api/v1/system/orgs/query", headers=admin, json={})
    row = next(i for i in r.json()["items"] if i["id"] == org["id"])
    assert row["my_role"] == "SYSTEM_ADMIN" and row["my_perms"] == list(ORG_GROUP_PERMS)

    # 组权限只影响组织层：alice 仍然看不到任何项目数据
    r = await client.get("/api/v1/projects", headers=alice)
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []

    # 移出组织时，组关系一并清掉（组不是第二套成员制）
    uid = (await session.execute(
        select(User.id).where(User.account == "alice"))).scalar_one()
    r = await client.post("/api/v1/system/orgs/members/remove", headers=admin,
                          json={"org_id": org["id"], "user_id": uid})
    assert r.status_code == 200
    n = (await session.execute(select(func.count(OrgUserGroupMember.id)).where(
        OrgUserGroupMember.user_id == uid))).scalar_one()
    assert n == 0


async def test_group_perms_drive_project_and_profile_caps(client, make_user, session) -> None:
    _, admin = await make_user("root", admin=True)
    _, alice = await make_user("alice")
    _, bob = await make_user("bob")
    org = await _org(client, admin)
    await _join(client, admin, org["id"], "alice")
    await _join(client, admin, org["id"], "bob")

    # 系统管理员先把一个项目归档进本组织
    r = await client.post("/api/v1/projects", headers=admin, json={"name": "基线项目"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    r = await client.post("/api/v1/system/orgs/projects/assign", headers=admin,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 200, r.text

    g = await _group(client, admin, org["id"], "组织运维", [CAP_MEMBER])
    await _add_member(client, admin, g["id"], "alice")

    # 只有 member:manage 时：能改项目归属吗？不能
    r = await client.post("/api/v1/system/orgs/projects/remove", headers=alice,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 403

    # 补上 project:manage + update 后：可移出/归档，可改资料
    r = await client.post("/api/v1/system/orgs/groups/update", headers=admin,
                          json={"group_id": g["id"], "perms": [CAP_MEMBER, CAP_PROJECT, CAP_UPDATE]})
    assert r.status_code == 200, r.text
    assert r.json()["perms"] == [CAP_MEMBER, CAP_PROJECT, CAP_UPDATE]

    r = await client.post("/api/v1/system/orgs/projects/remove", headers=alice,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 200, r.text
    r = await client.post("/api/v1/system/orgs/projects/assign", headers=alice,
                          json={"org_id": org["id"], "target_project_id": pid})
    assert r.status_code == 200, r.text
    r = await client.post("/api/v1/system/orgs/update", headers=alice,
                          json={"org_id": org["id"], "description": "组管理员改的说明"})
    assert r.status_code == 200, r.text
    assert r.json()["description"] == "组管理员改的说明"
    assert r.json()["my_role"] == "ORG_MEMBER"
    assert r.json()["my_perms"] == [CAP_UPDATE, CAP_MEMBER, CAP_PROJECT]

    # bob（无任何组权限）以上全部 403
    for path, body in (
        ("/api/v1/system/orgs/update", {"org_id": org["id"], "name": "bob 改名"}),
        ("/api/v1/system/orgs/projects/remove",
         {"org_id": org["id"], "target_project_id": pid}),
    ):
        r = await client.post(path, headers=bob, json=body)
        assert r.status_code == 403, (path, r.text)


async def test_group_lifecycle_and_guards(client, make_user, session) -> None:
    _, admin = await make_user("root", admin=True)
    _, alice = await make_user("alice")
    _, outsider = await make_user("outsider")
    org = await _org(client, admin)
    await _join(client, admin, org["id"], "alice")

    g = await _group(client, admin, org["id"], "组A", [CAP_GROUP])
    # 组名在组织内唯一
    r = await client.post("/api/v1/system/orgs/groups", headers=admin,
                          json={"org_id": org["id"], "name": "组A", "perms": []})
    assert r.status_code == 409 and r.json()["code"] == "conflict"
    # 非法管理位在 schema 层就被拒
    r = await client.post("/api/v1/system/orgs/groups", headers=admin,
                          json={"org_id": org["id"], "name": "组B", "perms": ["project:case:read"]})
    assert r.status_code == 422
    # 非组织成员不能进组
    r = await _add_member(client, admin, g["id"], "outsider")
    assert r.status_code == 409 and r.json()["code"] == "not_org_member"
    # 用户不存在
    r = await _add_member(client, admin, g["id"], "nobody")
    assert r.status_code == 404

    # 组员（持 group:manage）能管组，但不能管成员
    await _add_member(client, admin, g["id"], "alice")
    r = await client.post("/api/v1/system/orgs/groups/query", headers=alice,
                          json={"org_id": org["id"]})
    assert r.status_code == 200
    assert [i["name"] for i in r.json()["items"]] == ["组A"]
    r = await client.post("/api/v1/system/orgs/groups/members/query", headers=alice,
                          json={"group_id": g["id"]})
    assert r.status_code == 200 and [i["account"] for i in r.json()["items"]] == ["alice"]
    g2 = await _group(client, alice, org["id"], "组B", [])
    assert g2["name"] == "组B"
    r = await client.post("/api/v1/system/orgs/members/query", headers=alice,
                          json={"org_id": org["id"]})
    assert r.status_code == 403

    # 移出组：能力立刻消失，组员行也没了
    uid = (await session.execute(
        select(User.id).where(User.account == "alice"))).scalar_one()
    r = await client.post("/api/v1/system/orgs/groups/members/remove", headers=admin,
                          json={"group_id": g["id"], "user_id": uid})
    assert r.status_code == 200
    r = await client.post("/api/v1/system/orgs/groups/query", headers=alice,
                          json={"org_id": org["id"]})
    assert r.status_code == 403

    # 删组：组与组员行一起消失
    await _add_member(client, admin, g2["id"], "alice")
    r = await client.post("/api/v1/system/orgs/groups/delete", headers=admin,
                          json={"group_id": g2["id"]})
    assert r.status_code == 200
    assert (await session.execute(select(OrgUserGroup).where(
        OrgUserGroup.id == g2["id"]))).scalar_one_or_none() is None
    assert (await session.execute(select(OrgUserGroupMember).where(
        OrgUserGroupMember.group_id == g2["id"]))).scalar_one_or_none() is None

    # 删组织：组织下的组与组员行一并清掉
    org2 = await _org(client, admin, name="临时组织", code="tmp")
    g3 = await _group(client, admin, org2["id"], "临时组", [CAP_GROUP])
    r = await client.post("/api/v1/system/orgs/delete", headers=admin,
                          json={"org_id": org2["id"]})
    assert r.status_code == 200
    assert (await session.execute(select(OrgUserGroup).where(
        OrgUserGroup.org_id == org2["id"]))).scalar_one_or_none() is None
    assert (await session.execute(select(OrgUserGroupMember).where(
        OrgUserGroupMember.group_id == g3["id"]))).scalar_one_or_none() is None


async def test_non_member_cannot_see_or_group(client, make_user) -> None:
    _, admin = await make_user("root", admin=True)
    _, outsider = await make_user("outsider")
    org = await _org(client, admin)
    r = await client.post("/api/v1/system/orgs/groups/query", headers=outsider,
                          json={"org_id": org["id"]})
    assert r.status_code == 403
    r = await client.post("/api/v1/system/orgs/groups", headers=outsider,
                          json={"org_id": org["id"], "name": "x", "perms": []})
    assert r.status_code == 403
