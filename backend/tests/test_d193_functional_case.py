"""D193：功能用例本体 + 模块树 + 回收站 + 自定义值。"""
from __future__ import annotations

from sqlalchemy import text

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _field(client, h, pid: str, name: str, key: str, ftype: str = "input",
                 options: list[dict] | None = None) -> dict:
    r = await client.post(_BASE + "/custom-fields", json={
        "project_id": pid, "scene": "functional", "name": name, "field_key": key,
        "type": ftype, "options": options or [],
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _template(client, h, pid: str, name: str, fields: list[dict]) -> dict:
    r = await client.post(_BASE + "/templates", json={
        "project_id": pid, "scene": "functional", "name": name, "fields": fields,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _module(client, h, pid: str, name: str, parent: str | None = None) -> dict:
    r = await client.post(_BASE + "/functional-modules", json={
        "project_id": pid, "name": name, "parent_id": parent,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _case(client, h, pid: str, name: str, **kw):
    return await client.post(_BASE + "/functional-cases",
                             json={"project_id": pid, "name": name, **kw}, headers=h)


# ══════════ 1. 迁移形状 ══════════
async def test_functional_tables_shape(conn) -> None:
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "cols": {c["name"]: c for c in insp.get_columns("functional_case")},
            "uq": {u["name"] for u in insp.get_unique_constraints("functional_case")},
            "muq": {u["name"] for u in insp.get_unique_constraints("functional_module")},
        }

    got = await conn.run_sync(_read)
    assert {"functional_module", "functional_case", "functional_case_custom_field"} <= got["tables"]
    assert got["cols"]["num"]["nullable"] is False
    assert got["cols"]["template_id"]["nullable"] is False
    assert "uq_functional_case_project_num" in got["uq"]
    assert "uq_functional_module_parent_name" in got["muq"]


# ══════════ 2. 模块树 ══════════
async def test_module_tree_crud_and_guards(client, make_user) -> None:
    _, h = await make_user("d193m", admin=True)
    pid = await _proj(client, h, "D193模块")
    root = await _module(client, h, pid, "登录")
    child = await _module(client, h, pid, "短信登录", root["id"])
    dup = await client.post(_BASE + "/functional-modules",
                            json={"project_id": pid, "name": "登录"}, headers=h)
    assert dup.status_code == 409
    tree = await client.get(_BASE + "/functional-modules/tree", params={"project_id": pid}, headers=h)
    assert tree.status_code == 200
    root_node = tree.json()["tree"][0]
    assert root_node["name"] == "登录" and root_node["children"][0]["name"] == "短信登录"
    # 防环：把根移到自己子节点下
    cyc = await client.patch(_BASE + f"/functional-modules/{root['id']}", json={
        "project_id": pid, "parent_id": child["id"], "parent_set": True,
    }, headers=h)
    assert cyc.status_code == 422 and cyc.json()["code"] == "cycle"
    # 有子模块不能回收
    dele = await client.post(_BASE + f"/functional-modules/{root['id']}/delete",
                             json={"project_id": pid, "module_id": root["id"]}, headers=h)
    assert dele.status_code == 409 and dele.json()["code"] == "module_not_empty"
    # 先删子再删根
    await client.post(_BASE + f"/functional-modules/{child['id']}/delete",
                      json={"project_id": pid, "module_id": child["id"]}, headers=h)
    ok = await client.post(_BASE + f"/functional-modules/{root['id']}/delete",
                           json={"project_id": pid, "module_id": root["id"]}, headers=h)
    assert ok.status_code == 200
    tre2 = await client.get(_BASE + "/functional-modules/tree",
                            params={"project_id": pid, "include_recycled": True}, headers=h)
    assert tre2.json()["tree"] == [] and len(tre2.json()["recycled"]) == 2
    # 恢复子模块时父模块仍在回收站 → 409
    res_child = await client.post(_BASE + f"/functional-modules/{child['id']}/restore",
                                  json={"project_id": pid, "module_id": child["id"]}, headers=h)
    assert res_child.status_code == 409 and res_child.json()["code"] == "parent_recycled"
    # 恢复根 → 再恢复子
    await client.post(_BASE + f"/functional-modules/{root['id']}/restore",
                      json={"project_id": pid, "module_id": root["id"]}, headers=h)
    res2 = await client.post(_BASE + f"/functional-modules/{child['id']}/restore",
                             json={"project_id": pid, "module_id": child["id"]}, headers=h)
    assert res2.status_code == 200
    # 彻底删除：先回收再逐字确认
    await client.post(_BASE + f"/functional-modules/{child['id']}/delete",
                      json={"project_id": pid, "module_id": child["id"]}, headers=h)
    bad = await client.post(_BASE + f"/functional-modules/{child['id']}/purge",
                            json={"project_id": pid, "module_id": child["id"], "confirm_name": "错"},
                            headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "name_mismatch"
    pg = await client.post(_BASE + f"/functional-modules/{child['id']}/purge",
                           json={"project_id": pid, "module_id": child["id"], "confirm_name": "短信登录"},
                           headers=h)
    assert pg.status_code == 200


# ══════════ 3. 用例 CRUD + 模板校验 + num ══════════
async def test_case_crud_template_num_and_trash(client, session, conn, make_user) -> None:
    _, h = await make_user("d193c", admin=True)
    pid = await _proj(client, h, "D193用例")
    pid2 = await _proj(client, h, "D193用例B")
    mod = await _module(client, h, pid, "登录模块")
    f = await _field(client, h, pid, "前置条件", "precondition", "input")
    t = await _template(client, h, pid, "用例模板", [{"field_id": f["id"], "required": True}])
    await client.post(_BASE + f"/templates/{t['id']}/set-default",
                      json={"project_id": pid, "template_id": t["id"]}, headers=h)

    missing = await _case(client, h, pid, "缺必填")
    assert missing.status_code == 422 and missing.json()["code"] == "custom_field_invalid"
    c1 = await _case(client, h, pid, "登录成功", module_id=mod["id"],
                     custom_fields={f["id"]: "预置账号"})
    assert c1.status_code == 201, c1.text
    body = c1.json()
    assert body["num"] == 100001 and body["template_id"] == t["id"]
    assert body["custom_fields"][f["id"]] == "预置账号"
    c2 = await _case(client, h, pid, "登录失败", priority="P0",
                     custom_fields={f["id"]: "预置账号"})
    assert c2.status_code == 201 and c2.json()["num"] == 100002
    other = await _case(client, h, pid2, "别的项目")
    assert other.status_code == 201 and other.json()["num"] == 100001

    # 列表筛选：模块 / 关键词 / 优先级
    by_mod = await client.get(_BASE + "/functional-cases",
                              params={"project_id": pid, "module_id": mod["id"]}, headers=h)
    assert [x["id"] for x in by_mod.json()["items"]] == [body["id"]]
    by_kw = await client.get(_BASE + "/functional-cases",
                             params={"project_id": pid, "keyword": "失败"}, headers=h)
    assert [x["id"] for x in by_kw.json()["items"]] == [c2.json()["id"]]
    by_pri = await client.get(_BASE + "/functional-cases",
                              params={"project_id": pid, "priority": "P0"}, headers=h)
    assert [x["id"] for x in by_pri.json()["items"]] == [c2.json()["id"]]

    # 更新（模块移动 + 值替换）
    upd = await client.patch(_BASE + f"/functional-cases/{body['id']}", json={
        "project_id": pid, "name": "登录成功（改）", "priority": "P1",
        "module_id": None, "module_set": True,
        "custom_fields": {f["id"]: "新前置"},
    }, headers=h)
    assert upd.status_code == 200, upd.text
    assert upd.json()["name"] == "登录成功（改）" and upd.json()["module_id"] is None
    assert upd.json()["custom_fields"][f["id"]] == "新前置"

    # 回收站三态 + 级联值
    await client.post(_BASE + f"/functional-cases/{body['id']}/delete",
                      json={"project_id": pid, "case_id": body["id"]}, headers=h)
    gone = await client.get(_BASE + f"/functional-cases/{body['id']}", params={"project_id": pid}, headers=h)
    assert gone.status_code == 404
    bin_rows = await client.get(_BASE + "/functional-cases",
                                params={"project_id": pid, "recycled": True}, headers=h)
    assert [x["id"] for x in bin_rows.json()["items"]] == [body["id"]]
    rs = await client.post(_BASE + f"/functional-cases/{body['id']}/restore",
                           json={"project_id": pid, "case_id": body["id"]}, headers=h)
    assert rs.status_code == 200 and rs.json()["recycled"] is False
    await client.post(_BASE + f"/functional-cases/{body['id']}/delete",
                      json={"project_id": pid, "case_id": body["id"]}, headers=h)
    wrong = await client.post(_BASE + f"/functional-cases/{body['id']}/purge",
                              json={"project_id": pid, "case_id": body["id"], "confirm_name": "错"},
                              headers=h)
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch"
    pg = await client.post(_BASE + f"/functional-cases/{body['id']}/purge",
                           json={"project_id": pid, "case_id": body["id"], "confirm_name": "登录成功（改）"},
                           headers=h)
    assert pg.status_code == 200
    n = (await conn.execute(text("SELECT COUNT(*) FROM functional_case_custom_field WHERE case_id=:c"),
                            {"c": body["id"]})).scalar_one()
    assert n == 0


# ══════════ 4. 角色门 + 跨项目 ══════════
async def test_roles_and_cross_project(client, make_user) -> None:
    boss, hb = await make_user("d193r", admin=True)
    mem, hm = await make_user("d193r2")
    ro, hr = await make_user("d193r3")
    pid = await _proj(client, hb, "D193权限")
    pid2 = await _proj(client, hb, "D193权限B")
    for u, role in ((mem, "MEMBER"), (ro, "READONLY")):
        r = await client.put(_BASE + f"/projects/{pid}/members/{u.id}", json={"role_code": role}, headers=hb)
        assert r.status_code == 200
    c = await _case(client, hb, pid, "权限用例")
    assert c.status_code == 201, c.text
    cid = c.json()["id"]
    deny_create = await _case(client, hr, pid, "只读别建")
    assert deny_create.status_code == 403 and deny_create.json()["details"]["perm"] == "functional:case:create"
    can_read = await client.get(_BASE + "/functional-cases", params={"project_id": pid}, headers=hr)
    assert can_read.status_code == 200
    mem_del = await client.post(_BASE + f"/functional-cases/{cid}/delete",
                                json={"project_id": pid, "case_id": cid}, headers=hm)
    assert mem_del.status_code == 403 and mem_del.json()["details"]["perm"] == "functional:case:delete"
    cross = await client.get(_BASE + f"/functional-cases/{cid}", params={"project_id": pid2}, headers=hb)
    assert cross.status_code == 404 and cross.json()["message"] == "用例不存在"
