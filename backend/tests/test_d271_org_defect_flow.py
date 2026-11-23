"""D271：组织级缺陷状态流模板（org_defect_status / org_defect_status_transition）。

口径（对齐 MS 的 OrganizationStatusFlowSetting；D269 单租户约束不变）：
- 优先级 **项目自定义 > 所属组织模板 > 内置默认图**；组织模板不复制到项目，
  改模板对「未自定义」的项目立即生效；
- 授权不在静态位：系统管理员、ORG_ADMIN、或持 `system:org:defect:manage` 的用户组成员；
  普通组织成员 403（经 REGISTRY 调 iam 的 org_cap_check，缺陷模块不 import iam）；
- 删仍被**继承项目**引用的状态 → 409 status_in_use，details.in_use 按项目列出；
- 删组织时模板行一并清掉（iam 侧 raw SQL 级联，无外键）。
"""
from __future__ import annotations

from sqlalchemy import func, select

from app.modules.defect.models import OrgDefectStatus, OrgDefectStatusTransition

_BASE = "/api/v1"
CAP_DEFECT = "system:org:defect:manage"


async def _org(client, h, *, name: str = "研发一部", code: str = "rd1") -> dict:
    r = await client.post(_BASE + "/system/orgs", headers=h, json={"name": name, "code": code})
    assert r.status_code == 201, r.text
    return r.json()


async def _join(client, h, org_id: str, account: str, role: str = "ORG_MEMBER") -> None:
    r = await client.post(_BASE + "/system/orgs/members/set", headers=h,
                          json={"org_id": org_id, "account": account, "role_code": role})
    assert r.status_code == 200, r.text


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _assign(client, h, org_id: str, pid: str) -> None:
    r = await client.post(_BASE + "/system/orgs/projects/assign", headers=h,
                          json={"org_id": org_id, "target_project_id": pid})
    assert r.status_code == 200, r.text


def _status(key: str, name: str, *, start: bool = False, end: bool = False) -> dict:
    return {"key": key, "name": name, "is_start": start, "is_end": end}


def _edge(frm: str, to: str) -> dict:
    return {"from_key": frm, "to_key": to}


CUSTOM = (
    [_status("todo", "待处理", start=True), _status("doing", "处理中"),
     _status("done", "已完成", end=True)],
    [_edge("todo", "doing"), _edge("doing", "done"), _edge("done", "doing")],
)


async def _org_get(client, h, org_id: str):
    return await client.post(_BASE + "/system/orgs/defect-flow/get", headers=h,
                             json={"org_id": org_id})


async def _org_save(client, h, org_id: str, statuses: list[dict], edges: list[dict]):
    return await client.post(_BASE + "/system/orgs/defect-flow/save", headers=h,
                             json={"org_id": org_id, "statuses": statuses, "transitions": edges})


async def _org_reset(client, h, org_id: str):
    return await client.post(_BASE + "/system/orgs/defect-flow/reset", headers=h,
                             json={"org_id": org_id})


async def _proj_flow(client, h, pid: str) -> dict:
    r = await client.get(_BASE + "/defect-statuses", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _create(client, h, pid: str, title: str) -> dict:
    r = await client.post(_BASE + "/defects", json={"project_id": pid, "title": title}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


# ══════════ 1. 迁移形状 ══════════
async def test_org_flow_tables_shape(conn) -> None:
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "scols": {c["name"] for c in insp.get_columns("org_defect_status")},
            "tcols": {c["name"] for c in insp.get_columns("org_defect_status_transition")},
            "suq": {u["name"] for u in insp.get_unique_constraints("org_defect_status")},
            "tuq": {u["name"] for u in insp.get_unique_constraints("org_defect_status_transition")},
        }

    got = await conn.run_sync(_read)
    assert {"org_defect_status", "org_defect_status_transition"} <= got["tables"]
    assert {"org_id", "key", "name", "is_start", "is_end", "position"} <= got["scols"]
    assert {"org_id", "from_key", "to_key"} <= got["tcols"]
    assert "uq_org_defect_status_org_key" in got["suq"]
    assert "uq_org_defect_transition_org_edge" in got["tuq"]


# ══════════ 2. 授权：组委派 / ORG_ADMIN / 普通成员 ══════════
async def test_org_flow_auth_by_cap(client, make_user) -> None:
    _, admin = await make_user("d271a", admin=True)
    _, alice = await make_user("d271b")
    org = await _org(client, admin, name="D271授权", code="d271a")
    await _join(client, admin, org["id"], "d271b")

    # 普通组织成员无管理位：读也 403（模板里只有组织管理位持有者能看）
    assert (await _org_get(client, alice, org["id"])).status_code == 403
    statuses, edges = CUSTOM
    assert (await _org_save(client, alice, org["id"], statuses, edges)).status_code == 403

    # 组委派 system:org:defect:manage 之后可读可写
    r = await client.post(_BASE + "/system/orgs/groups", headers=admin,
                          json={"org_id": org["id"], "name": "缺陷管理员", "perms": [CAP_DEFECT]})
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    r = await client.post(_BASE + "/system/orgs/groups/members/set", headers=admin,
                          json={"group_id": gid, "account": "d271b"})
    assert r.status_code == 200, r.text

    got = await _org_get(client, alice, org["id"])
    assert got.status_code == 200, got.text
    assert got.json()["org_id"] == org["id"] and got.json()["customized"] is False

    saved = await _org_save(client, alice, org["id"], statuses, edges)
    assert saved.status_code == 200, saved.text
    assert saved.json()["customized"] is True and saved.json()["start_key"] == "todo"

    # 非本组织成员（系统管理员除外）不能借 org_id 越权
    _, bob = await make_user("d271c")
    assert (await _org_get(client, bob, org["id"])).status_code == 403

    # 系统管理员天然可用
    assert (await _org_reset(client, admin, org["id"])).status_code == 200
    assert (await _org_get(client, admin, org["id"])).json()["customized"] is False


# ══════════ 3. 项目继承组织模板 / 自定义覆盖 / 重置回落 ══════════
async def test_project_inherits_org_then_overrides(client, make_user) -> None:
    _, h = await make_user("d271d", admin=True)
    org = await _org(client, h, name="D271继承", code="d271b")
    pid = await _proj(client, h, "D271继承项目")
    await _assign(client, h, org["id"], pid)

    # 没模板：内置默认
    body = await _proj_flow(client, h, pid)
    assert body["source"] == "default" and body["customized"] is False
    assert body["start_key"] == "new"

    statuses, edges = CUSTOM
    assert (await _org_save(client, h, org["id"], statuses, edges)).status_code == 200

    # 组织模板对未自定义项目立即生效（不复制行）
    body = await _proj_flow(client, h, pid)
    assert body["source"] == "org" and body["customized"] is False
    assert body["start_key"] == "todo"
    assert [s["key"] for s in body["statuses"]] == ["todo", "doing", "done"]
    d = await _create(client, h, pid, "继承组织模板")
    assert d["status"] == "todo"

    # 项目自定义覆盖组织（新图要覆盖缺陷当前所在的 todo，否则 409 悬空）
    r = await client.post(_BASE + "/defect-statuses", headers=h, json={
        "project_id": pid,
        "statuses": [_status("todo", "待处理", start=True), _status("doing", "处理中"),
                     _status("verified", "已验证", end=True)],
        "transitions": [_edge("todo", "doing"), _edge("doing", "verified"),
                        _edge("verified", "doing")],
    })
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "project"  # 保存响应也要如实带层号，前端标签不能还是「内置默认」
    body = await _proj_flow(client, h, pid)
    assert body["source"] == "project" and body["customized"] is True
    assert body["start_key"] == "todo"
    assert [s["key"] for s in body["statuses"]] == ["todo", "doing", "verified"]

    # 重置项目定制 → 回落到组织模板（不是内置默认）
    r = await client.post(_BASE + "/defect-statuses/reset", json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "org" and r.json()["start_key"] == "todo"


# ══════════ 4. 组织模板删仍在用的状态 → 409（按项目列出）══════════
async def test_org_template_dangling_guard(client, make_user) -> None:
    _, h = await make_user("d271e", admin=True)
    org = await _org(client, h, name="D271悬空", code="d271c")
    pid = await _proj(client, h, "D271悬空项目")
    await _assign(client, h, org["id"], pid)
    statuses, edges = CUSTOM
    assert (await _org_save(client, h, org["id"], statuses, edges)).status_code == 200
    await _create(client, h, pid, "占着 todo")

    deny = await _org_save(client, h, org["id"],
                           [_status("doing", "处理中", start=True), _status("done", "已完成", end=True)],
                           [_edge("doing", "done")])
    assert deny.status_code == 409 and deny.json()["code"] == "status_in_use"
    assert deny.json()["details"]["in_use"] == {pid: {"todo": 1}}

    # 重置同样被拦（todo 不在内置默认图里）
    deny_reset = await _org_reset(client, h, org["id"])
    assert deny_reset.status_code == 409 and deny_reset.json()["code"] == "status_in_use"

    # 模板未被改动
    body = await _org_get(client, h, org["id"])
    assert body.json()["customized"] is True and body.json()["start_key"] == "todo"

    # 先把缺陷改派到 doing，重置仍被拦（doing 不在内置默认图里）
    d = (await client.get(_BASE + "/defects", params={"project_id": pid}, headers=h)).json()
    did = d["items"][0]["id"]
    step = await client.patch(_BASE + f"/defects/{did}", headers=h,
                              json={"project_id": pid, "defect_id": did, "status": "doing"})
    assert step.status_code == 200, step.text
    still_denied = await _org_reset(client, h, org["id"])
    assert still_denied.status_code == 409 and still_denied.json()["code"] == "status_in_use"

    # 清掉唯一缺陷（回收 → 彻底删除）后重置成功，继承项目回落内置默认
    r = await client.post(_BASE + f"/defects/{did}/delete", headers=h,
                          json={"project_id": pid, "defect_id": did})
    assert r.status_code == 200, r.text
    r = await client.post(_BASE + f"/defects/{did}/purge", headers=h,
                          json={"project_id": pid, "defect_id": did, "confirm_title": "占着 todo"})
    assert r.status_code == 200, r.text
    ok = await _org_reset(client, h, org["id"])
    assert ok.status_code == 200 and ok.json()["customized"] is False
    assert (await _proj_flow(client, h, pid))["source"] == "default"


# ══════════ 5. 删组织清模板（无外键的显式级联）══════════
async def test_delete_org_clears_org_flow(client, make_user, session) -> None:
    _, h = await make_user("d271f", admin=True)
    org = await _org(client, h, name="D271删除", code="d271d")
    statuses, edges = CUSTOM
    assert (await _org_save(client, h, org["id"], statuses, edges)).status_code == 200

    r = await client.post(_BASE + "/system/orgs/delete", headers=h, json={"org_id": org["id"]})
    assert r.status_code == 200, r.text

    n_status = (await session.execute(
        select(func.count(OrgDefectStatus.id)).where(OrgDefectStatus.org_id == org["id"])
    )).scalar_one()
    n_edge = (await session.execute(
        select(func.count(OrgDefectStatusTransition.id))
        .where(OrgDefectStatusTransition.org_id == org["id"])
    )).scalar_one()
    assert int(n_status) == 0 and int(n_edge) == 0
