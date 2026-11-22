"""1B T10 场景模块树：无限级、环检测、软删后代、根层重名（§4.4 / R45）。

scenario_module 是独立于 api_module 的第二棵树（R45）：权限位 scenario:module:*，
引用完整性不与接口共用。根层 parent_id 为 NULL，MySQL 唯一键不判等 NULL，
所以根层重名必须由服务层自查（1A 在 api_module 上踩过的同一个坑）。
"""
from __future__ import annotations


async def _setup(client, make_user, tag):
    boss, hb = await make_user("smboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "psm" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk(client, h, pid, name, parent=None):
    body = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post("/api/v1/scenario-modules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mkscen(client, h, pid, name, module_id=None):
    body = {"project_id": pid, "name": name}
    if module_id:
        body["module_id"] = module_id
    r = await client.post("/api/v1/scenarios", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _walk(ns):
    out = set()
    for n in ns:
        out.add(n["name"])
        out |= await _walk(n["children"])
    return out


async def test_module_tree_structure_and_counts(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    root = await _mk(client, h, pid, "交易链路")
    mid = await _mk(client, h, pid, "下单", root["id"])
    leaf = await _mk(client, h, pid, "批量", mid["id"])
    await _mkscen(client, h, pid, "下单成功", mid["id"])
    await _mkscen(client, h, pid, "下单失败", mid["id"])
    r = await client.get("/api/v1/scenario-modules", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    tree = r.json()["tree"]
    assert len(tree) == 1
    assert tree[0]["name"] == "交易链路" and tree[0]["count"] == 0
    n1 = tree[0]["children"][0]
    assert n1["name"] == "下单" and n1["count"] == 2, "直属场景计数只算本模块，不算子孙"
    assert n1["children"][0]["id"] == leaf["id"]


async def test_module_cycle_and_dup(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "B")
    a = await _mk(client, h, pid, "A")
    b = await _mk(client, h, pid, "B", a["id"])
    c = await _mk(client, h, pid, "C", b["id"])
    # A 挂到自己孙子 C 下 → 400（成环）
    r = await client.patch("/api/v1/scenario-modules/" + a["id"],
                           json={"project_id": pid, "parent_id": c["id"]}, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "invalid_input", r.text
    # 挂到自己下 → 400
    r2 = await client.patch("/api/v1/scenario-modules/" + a["id"],
                            json={"project_id": pid, "parent_id": a["id"]}, headers=h)
    assert r2.status_code == 400, r2.text
    # 同父重名 → 409
    r3 = await client.post("/api/v1/scenario-modules", json={
        "project_id": pid, "name": "B", "parent_id": a["id"]}, headers=h)
    assert r3.status_code == 409, r3.text
    # 根层重名 → 409（服务层自查：MySQL 唯一键不判等 NULL，根层靠这里兜）
    r4 = await client.post("/api/v1/scenario-modules", json={"project_id": pid, "name": "A"}, headers=h)
    assert r4.status_code == 409 and r4.json()["code"] == "conflict", r4.text
    # 正常移动 B → 根：ok
    r5 = await client.patch("/api/v1/scenario-modules/" + b["id"],
                            json={"project_id": pid, "parent_id": None}, headers=h)
    assert r5.status_code == 200, r5.text
    r6 = await client.get("/api/v1/scenario-modules", params={"project_id": pid}, headers=h)
    assert {n["name"] for n in r6.json()["tree"]} == {"A", "B"}


async def test_module_recycle_soft_deletes_descendants(client, make_user) -> None:
    """软删自身+后代：中层的子孙一起进回收站；恢复时整体回归。"""
    _, h, pid = await _setup(client, make_user, "C")
    top = await _mk(client, h, pid, "顶层")
    mid = await _mk(client, h, pid, "中层", top["id"])
    low = await _mk(client, h, pid, "下层", mid["id"])
    r = await client.post("/api/v1/scenario-modules/" + mid["id"] + "/delete",
                          json={"project_id": pid, "module_id": mid["id"]}, headers=h)
    assert r.status_code == 200, r.text
    r2 = await client.get("/api/v1/scenario-modules", params={"project_id": pid}, headers=h)
    assert {n["name"] for n in r2.json()["tree"]} == {"顶层"}
    r3 = await client.get("/api/v1/scenario-modules",
                          params={"project_id": pid, "include_recycled": True}, headers=h)
    rec = r3.json()["recycled"]
    assert [x["name"] for x in rec] == ["中层"], "回收视图只回收集群根，子孙挂在 children"
    assert rec[0]["children"][0]["id"] == low["id"]
    # 恢复中层 → 下层随之回归
    r4 = await client.post("/api/v1/scenario-modules/" + mid["id"] + "/restore",
                           json={"project_id": pid, "module_id": mid["id"]}, headers=h)
    assert r4.status_code == 200, r4.text
    r5 = await client.get("/api/v1/scenario-modules", params={"project_id": pid}, headers=h)
    assert await _walk(r5.json()["tree"]) == {"顶层", "中层", "下层"}
    # 回收站里的模块名照样占位：同名重建 409 且文案点名回收站
    assert (await client.post("/api/v1/scenario-modules/" + top["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    dup = await client.post("/api/v1/scenario-modules", json={"project_id": pid, "name": "顶层"}, headers=h)
    assert dup.status_code == 409 and "回收站" in dup.json()["message"], dup.text


async def test_module_delete_perms(client, make_user) -> None:
    from app.core.registry import REGISTRY

    for nm, perm in (("scenario_module_tree", "scenario:module:read"),
                     ("scenario_module_create", "scenario:module:create"),
                     ("scenario_module_update", "scenario:module:update"),
                     ("scenario_module_delete", "scenario:module:delete"),
                     ("scenario_module_restore", "scenario:module:update")):
        spec = REGISTRY.get(nm)
        assert spec is not None, nm + " 未注册"
        assert spec.perm == perm, nm
    assert REGISTRY.get("scenario_module_delete").effect == "destructive"

    _, h, pid = await _setup(client, make_user, "D")
    m = await _mk(client, h, pid, "成员不可删")
    member, hm = await make_user("smdmem")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + member.id,
                             json={"role_code": "MEMBER"}, headers=h)).status_code == 200
    r = await client.post("/api/v1/scenario-modules/" + m["id"] + "/delete",
                          json={"project_id": pid}, headers=hm)
    assert r.status_code == 403, r.text
    # READONLY 不能建模块
    ro, hr = await make_user("smdro")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                             json={"role_code": "READONLY"}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/scenario-modules", json={
        "project_id": pid, "name": "只读建"}, headers=hr)).status_code == 403
    # 非成员连看都不可见
    _, hg = await make_user("smdout")
    assert (await client.get("/api/v1/scenario-modules", params={"project_id": pid},
                             headers=hg)).status_code == 403


async def test_module_purge_detaches_scenarios_but_never_deletes_them(client, make_user) -> None:
    """场景模块 purge 首次走 HTTP 出口（此前注册了但从没被试过）。

    三口径照 api_module 的同名测试钉：正常态不许直接 purge → not_recycled；确认名不符
    不放行 → name_mismatch；真删后场景不陪葬（模块是收纳方式，场景是资产，只清空归属）
    且同名墓碑解放。
    """
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("scenario_module_purge")
    assert spec is not None and spec.effect == "destructive" and spec.perm == "scenario:module:delete"
    assert spec.tool is False, "彻底删除不进 Pilot 工具箱：不可逆操作只走人工 UI"

    _, h, pid = await _setup(client, make_user, "E")
    top = await _mk(client, h, pid, "交易链路")
    sub = await _mk(client, h, pid, "下单", top["id"])
    keep = await _mk(client, h, pid, "留着")
    s_sub = await _mkscen(client, h, pid, "下单成功", sub["id"])
    s_top = await _mkscen(client, h, pid, "每日对账", top["id"])

    # ① 正常态模块不许直接彻底删除：必须先回收
    live = await client.post("/api/v1/scenario-modules/" + keep["id"] + "/purge",
                             json={"project_id": pid, "confirm_name": "留着"}, headers=h)
    assert live.status_code == 409 and live.json()["code"] == "not_recycled", live.text

    # 回收整棵子树（子孙一起进回收站）
    assert (await client.post("/api/v1/scenario-modules/" + top["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200

    # ② 确认名差两个字就不放行
    wrong = await client.post("/api/v1/scenario-modules/" + top["id"] + "/purge",
                              json={"project_id": pid, "confirm_name": "交易"}, headers=h)
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch", wrong.text

    # ③ 逐字相符 → 真删：父子两个模块都没了，两个场景还活着
    ok = await client.post("/api/v1/scenario-modules/" + top["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "交易链路"}, headers=h)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["purged_modules"] == 2 and body["detached_scenarios"] == 2, body
    for sid in (s_sub["id"], s_top["id"]):
        g = await client.get("/api/v1/scenarios/" + sid, params={"project_id": pid}, headers=h)
        assert g.status_code == 200 and g.json()["module_id"] is None, g.text

    # 树只剩「留着」、回收站空了（墓碑行物理删除，不是又软删一遍）
    tree = (await client.get("/api/v1/scenario-modules", params={
        "project_id": pid, "include_recycled": True}, headers=h)).json()
    assert [n["name"] for n in tree["tree"]] == ["留着"], tree
    assert tree["recycled"] == [], tree["recycled"]
    # 同名解放：回收站占位是墓碑行，purge 后同名可重建
    assert (await client.post("/api/v1/scenario-modules",
                              json={"project_id": pid, "name": "交易链路"}, headers=h)).status_code == 201
    # 再 purge 一个不存在的模块 → 404
    gone = await client.post("/api/v1/scenario-modules/" + top["id"] + "/purge",
                             json={"project_id": pid, "confirm_name": "交易链路"}, headers=h)
    assert gone.status_code == 404 and gone.json()["code"] == "not_found", gone.text


def test_migration_0016_roundtrip() -> None:
    """0015→0016→0015→0016：两表能建能拆；down 不碰别的表的数据；up 再建回来。"""
    import os
    from datetime import UTC, datetime
    from urllib.parse import urlsplit, urlunsplit

    from alembic import command
    from alembic.config import Config

    u = urlsplit(os.environ["TP_DB_URL"])
    schema = "tp_m16_" + datetime.now(UTC).strftime("%H%M%S") + "_" + os.urandom(2).hex()

    import pymysql

    admin2 = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                             password=u.password, autocommit=True)

    def conn():
        return pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                               password=u.password, database=schema, autocommit=True)

    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    cfg.set_main_option("sqlalchemy.url",
                        urlunsplit(u._replace(path="/" + schema)).replace("+asyncmy", "+pymysql"))
    new = {"scenario", "scenario_module"}

    def tbls():
        c = conn()
        with c.cursor() as cur:
            cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=%s"
                        " AND table_type=%s", (schema, "BASE TABLE"))
            out = {r[0] for r in cur.fetchall()}
        c.close()
        return out

    def cols(tbl: str) -> set[str]:
        c = conn()
        with c.cursor() as cur:
            cur.execute("SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema=%s AND table_name=%s", (schema, tbl))
            out = {r[0] for r in cur.fetchall()}
        c.close()
        return out

    try:
        with admin2.cursor() as cur:
            cur.execute("CREATE DATABASE " + chr(96) + schema + chr(96) +
                        " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
        command.upgrade(cfg, "0015")
        assert not new & tbls(), "0015 世界不该有两张新表"

        c = conn()
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO run_record (id, project_id, subject_type, subject_id, subject_name,"
                " `trigger`, status, created_at, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())",
                ("keep-0016", "p1", "scenario", "s1", "留着", "debug", "passed"))
        c.close()

        command.upgrade(cfg, "0016")
        assert new <= tbls(), "0016 没建表"
        expect_sc = {"id", "project_id", "module_id", "name", "status", "priority", "step_graph",
                     "variables", "fail_fast", "max_runtime_ms", "env_id", "owner_id",
                     "project_public", "version", "step_count", "last_run_at", "last_run_status",
                     "updated_by", "created_at", "updated_at"}
        expect_sm = {"id", "project_id", "parent_id", "name", "sort", "status", "created_at", "updated_at"}
        assert expect_sc <= cols("scenario"), cols("scenario")
        assert expect_sm <= cols("scenario_module"), cols("scenario_module")

        # 数据可写读（含 JSON 列与保留字无关的列名）
        c = conn()
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO scenario (id, project_id, name, step_graph, version, step_count,"
                " created_at, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,NOW(),NOW())",
                ("sc-0016", "p1", "建出来的场景", '{"version": 1, "nodes": []}', 1, 0))
            cur.execute("SELECT name, step_graph FROM scenario WHERE id=%s", ("sc-0016",))
            row = cur.fetchone()
            assert row[0] == "建出来的场景" and row[1] is not None
        c.close()

        command.downgrade(cfg, "0015")
        assert not new & tbls(), "down 没拆干净"
        c = conn()
        with c.cursor() as cur:
            cur.execute("SELECT subject_name FROM run_record WHERE id=%s", ("keep-0016",))
            assert cur.fetchone()[0] == "留着", "down 不该碰别人家的表"
        c.close()

        command.upgrade(cfg, "0016")
        assert new <= tbls(), "重新 upgrade 失败"
    finally:
        with admin2.cursor() as cur:
            cur.execute("DROP DATABASE IF EXISTS " + chr(96) + schema + chr(96))
        admin2.close()
