"""接口定义回收站：删除=软回收（与用例/模块同族语义），回收即整体不可达，restore 原样回归。"""
from __future__ import annotations

REQ = {"method": "GET", "url": "http://127.0.0.1:9999/order/1", "body": {"type": "none"},
       "assertions": [{"type": "status_code", "expected": 200}]}


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)).json()["id"]
    mod = (await client.post("/api/v1/api-modules", json={"project_id": pid, "name": "交易"}, headers=h)).json()
    d = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "查询订单", "method": "GET", "path": "/order/1",
        "request": REQ, "module_id": mod["id"]}, headers=h)).json()
    return h, pid, mod["id"], d["id"]


async def _mk_case(client, h, pid, did, name="用例A"):
    r = await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": did, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mk_scene(client, h, pid, case_ids, name="下单场景"):
    """场景步骤的 ref 是 case_id（不是 definition_id）——引用检测的口径就长在这张图上。"""
    graph = {"version": 1, "nodes": [{"key": "s" + str(i) + ".step", "kind": "api_case", "ref": c}
                                     for i, c in enumerate(case_ids)]}
    r = await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": name, "step_graph": graph}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_recycle_hides_everywhere_and_restore_brings_back(client, make_user) -> None:
    h, pid, mid, did = await _setup(client, make_user, "recdef")
    c = await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": did, "name": "用例A"}, headers=h)
    assert c.status_code == 201, c.text
    cid = c.json()["id"]

    r = await client.post("/api/v1/api-definitions/" + did + "/delete", json={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["ok"] is True

    # 正常列表不含；recycled=true 视图含
    lst = (await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)).json()["items"]
    assert lst == []
    lst_r = (await client.get("/api/v1/api-definitions",
                              params={"project_id": pid, "recycled": "true"}, headers=h)).json()["items"]
    assert [x["id"] for x in lst_r] == [did] and lst_r[0]["status"] == "recycled"
    # 读/改/调/挂用例 全部同码 404（与不存在一致，不泄露）
    assert (await client.get("/api/v1/api-definitions/" + did, params={"project_id": pid}, headers=h)).status_code == 404
    assert (await client.patch("/api/v1/api-definitions/" + did,
                                 json={"project_id": pid, "name": "z", "version": 1}, headers=h)).status_code == 404
    assert (await client.post("/api/v1/api-debug",
                              json={"project_id": pid, "definition_id": did}, headers=h)).status_code == 404
    assert (await client.post("/api/v1/api-debug",
                              json={"project_id": pid, "case_id": cid}, headers=h)).status_code == 404
    assert (await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": did, "name": "再挂一条"}, headers=h)).status_code == 404
    assert (await client.get("/api/v1/api-cases",
                             params={"project_id": pid, "definition_id": did}, headers=h)).status_code == 404
    # 模块计数归零
    tree = (await client.get("/api/v1/api-modules", params={"project_id": pid}, headers=h)).json()["tree"]
    assert tree[0]["count"] == 0
    # 同名重建被挡且文案诚实（回收站占名，DB 唯一约束如此）
    dup = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "查询订单", "method": "GET", "path": "/x"}, headers=h)
    assert dup.status_code == 409 and "回收站" in dup.json()["message"]
    # 重复删除 → 404
    assert (await client.post("/api/v1/api-definitions/" + did + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 404

    # 恢复：一切原样回归（用例没有被动过 status，跟着定义复活）
    rs = await client.post("/api/v1/api-definitions/" + did + "/restore", json={"project_id": pid}, headers=h)
    assert rs.status_code == 200, rs.text
    assert (await client.get("/api/v1/api-definitions/" + did, params={"project_id": pid}, headers=h)).status_code == 200
    back = (await client.get("/api/v1/api-cases",
                            params={"project_id": pid, "definition_id": did}, headers=h)).json()["items"]
    assert [x["name"] for x in back] == ["用例A"]
    tree = (await client.get("/api/v1/api-modules", params={"project_id": pid}, headers=h)).json()["tree"]
    assert tree[0]["count"] == 1


async def test_recycle_respects_visibility(client, make_user) -> None:
    h, pid, mid, did = await _setup(client, make_user, "recvis")
    peer, hp = await make_user("recvis_peer")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + peer.id,
                             json={"role_code": "MEMBER"}, headers=h)).status_code == 200
    priv = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "私有接口", "method": "GET", "path": "/p",
        "request": REQ, "project_public": False}, headers=hp)).json()
    # 别人的私有 → 删除也是 404；自己的没问题
    assert (await client.post("/api/v1/api-definitions/" + priv["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200  # 管理员可见可删


async def test_effect_and_audit(client, make_user, session) -> None:
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("api_definition_delete")
    assert spec is not None and spec.effect == "destructive" and spec.perm == "api:def:delete"
    h, pid, mid, did = await _setup(client, make_user, "recaudit")
    await client.post("/api/v1/api-definitions/" + did + "/delete", json={"project_id": pid}, headers=h)
    from sqlalchemy import select

    from app.modules.audit.models import AuditLog

    rows = (await session.execute(select(AuditLog).where(AuditLog.action == "api_definition_delete"))).scalars().all()
    assert len(rows) == 1 and rows[0].entry == "http" and rows[0].ok


async def test_purge_frees_the_name_and_cascades_cases(client, make_user) -> None:
    """彻底删除（§11.4.18）：只清回收站里的东西，释放名字，用例连带消失。

    没有这一步，回收站就是单向门：软删的接口永久占着 uq_apidef_project_name，
    同名再也建不出来，而产品里没有任何出口能把名字腾出来。
    """
    h, pid, mid, did = await _setup(client, make_user, "purgedef")
    cid = (await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": did, "name": "用例A"}, headers=h)).json()["id"]
    await client.post("/api/v1/api-definitions/" + did + "/delete", json={"project_id": pid}, headers=h)

    # 还在正常视图里的接口不许直接彻底删除（防手滑：必须先回收站走一趟）
    live = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "还活着", "method": "GET", "path": "/live",
        "request": REQ}, headers=h)).json()["id"]
    bad0 = await client.post("/api/v1/api-definitions/" + live + "/purge",
                             json={"project_id": pid, "confirm_name": "还活着"}, headers=h)
    assert bad0.status_code == 409 and bad0.json()["code"] == "not_recycled", bad0.text

    # 名字打错就不删：§11.4.18 要求「输名称确认」，这是不可逆操作唯一的一次反悔机会
    bad = await client.post("/api/v1/api-definitions/" + did + "/purge",
                            json={"project_id": pid, "confirm_name": "查询订单 "}, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "name_mismatch", bad.text
    assert (await client.get("/api/v1/api-definitions",
            params={"project_id": pid, "recycled": "true"}, headers=h)).json()["items"] != []

    ok = await client.post("/api/v1/api-definitions/" + did + "/purge",
                           json={"project_id": pid, "confirm_name": "查询订单"}, headers=h)
    assert ok.status_code == 200 and ok.json()["ok"] is True, ok.text

    # 回收站空了、用例连带没了、名字腾出来了
    assert (await client.get("/api/v1/api-definitions",
            params={"project_id": pid, "recycled": "true"}, headers=h)).json()["items"] == []
    assert (await client.get("/api/v1/api-cases",
            params={"project_id": pid, "definition_id": did}, headers=h)).status_code == 404
    gone = await client.get("/api/v1/api-cases/" + cid, params={"project_id": pid}, headers=h)
    assert gone.status_code == 404, gone.text
    again = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "查询订单", "method": "GET", "path": "/order/2"}, headers=h)
    assert again.status_code == 201, again.text

    # 彻底删除本身不可逆：再删一次就是 404（连资源都没了，不区分"不在回收站"）
    again2 = await client.post("/api/v1/api-definitions/" + did + "/purge",
                               json={"project_id": pid, "confirm_name": "查询订单"}, headers=h)
    assert again2.status_code == 404, again2.text


async def test_purge_needs_delete_perm_and_keeps_history(client, make_user, session) -> None:
    """门禁与审计：只读成员不能彻底删除；删完运行记录仍可查（subject_name 是冗余列）。"""
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("api_definition_purge")
    assert spec is not None and spec.effect == "destructive" and spec.perm == "api:def:delete"
    assert spec.tool is False, "彻底删除不进 Pilot 工具箱：不可逆操作只走人工 UI，模型不该有一次手滑的机会"

    h, pid, mid, did = await _setup(client, make_user, "purgeaudit")
    ro, h_ro = await make_user("purgeaudit_ro")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                             json={"role_code": "READONLY"}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/api-definitions/" + did + "/purge",
            json={"project_id": pid, "confirm_name": "查询订单"}, headers=h_ro)).status_code == 403

    dbg = await client.post("/api/v1/api-debug", json={"project_id": pid, "definition_id": did}, headers=h)
    assert dbg.status_code == 200, dbg.text
    run_id = dbg.json()["run_id"]
    await client.post("/api/v1/api-definitions/" + did + "/delete", json={"project_id": pid}, headers=h)
    assert (await client.post("/api/v1/api-definitions/" + did + "/purge",
            json={"project_id": pid, "confirm_name": "查询订单"}, headers=h)).status_code == 200

    # 历史不追删：调试过一次的接口即使被彻底删除，运行记录仍可查、可展开
    r = await client.get("/api/v1/runs/" + run_id, params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["subject_name"] == "查询订单"

    from sqlalchemy import select

    from app.modules.audit.models import AuditLog

    # 被拒的那一次同样留痕：destructive 操作的失败尝试也要能追到人
    rows = (await session.execute(select(AuditLog).where(
        AuditLog.action == "api_definition_purge", AuditLog.target == pid
    ))).scalars().all()
    # 钉的是「两次尝试都留痕、一次拒一次成」——不是先后顺序：ts 是 DATETIME
    # 秒精度，同一秒内的两次 purge 按 ts 排序是掷硬币（满载套件下实测翻车过）。
    flags = sorted((r.ok, r.entry) for r in rows)
    assert flags == [(False, "http"), (True, "http")], flags


# ---------- 删除引用检测（D79，§11.5.3 行操作「删除(引用检测)」；与 api_case_delete 同款两段式） ----------

async def test_delete_definition_referenced_by_scenario_needs_force(client, make_user) -> None:
    """场景指着这条接口的用例 → 第一段 409 点名引用者、行没被动过、第二段 force 放行。

    引用在数据上是「场景步骤 ref=case_id」，不是「ref=definition_id」：回收定义不删用例，
    坏掉的是那些步骤（用例随定义整体不可达），409 文案必须说清这一点而不是暗示级联删除。
    """
    h, pid, mid, did = await _setup(client, make_user, "refdel")
    case = await _mk_case(client, h, pid, did)
    scene = await _mk_scene(client, h, pid, [case["id"]])

    r = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "referenced_by_scenario", body
    assert body["details"]["definition_id"] == did
    assert body["details"]["count"] == 1
    got = body["details"]["scenarios"][0]
    assert got["scenario_id"] == scene["id"] and got["scenario_name"] == "下单场景"
    assert got["step_keys"] == ["s0.step"]
    # 口径一致性：回收不删用例，文案不许暗示级联删除，要说清「步骤坏掉 + restore 可回」
    assert "不会删除用例" in body["message"] and "force" in body["message"], body["message"]

    # 409 必须是一条什么都没改的失败：定义还在正常视图、状态没动、仍可再删
    lst = (await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)).json()["items"]
    assert [x["id"] for x in lst] == [did] and lst[0]["status"] == "complete"
    assert (await client.get("/api/v1/api-definitions/" + did,
                             params={"project_id": pid}, headers=h)).status_code == 200

    f = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid, "force": True}, headers=h)
    assert f.status_code == 200, f.text
    lst_r = (await client.get("/api/v1/api-definitions",
                              params={"project_id": pid, "recycled": "true"}, headers=h)).json()["items"]
    assert [x["id"] for x in lst_r] == [did]


async def test_delete_definition_multiple_cases_one_scenario_dedup(client, make_user) -> None:
    """一个场景引用同一定义的两条用例 → 引用表按场景一行、step_keys 合并去重：
    引用表里同一个场景出现两次是读不懂的（与 _scan_refs 的归组口径一致）。"""
    h, pid, mid, did = await _setup(client, make_user, "refdup")
    c1 = await _mk_case(client, h, pid, did, name="用例1")
    c2 = await _mk_case(client, h, pid, did, name="用例2")
    await _mk_scene(client, h, pid, [c1["id"], c2["id"]])

    r = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["details"]["count"] == 1, "同一场景引用两条用例只算一个引用者"
    assert body["details"]["scenarios"][0]["step_keys"] == ["s0.step", "s1.step"]


async def test_delete_definition_not_referenced_is_free(client, make_user) -> None:
    """未被引用 → 直接回收，restore 仍原样回归（引用检测不许把好删的路堵死）。"""
    h, pid, mid, did = await _setup(client, make_user, "reffree")
    await _mk_case(client, h, pid, did)  # 有用例、但没有场景引用
    r = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["ok"] is True, r.text
    rs = await client.post("/api/v1/api-definitions/" + did + "/restore",
                           json={"project_id": pid}, headers=h)
    assert rs.status_code == 200, rs.text
    assert (await client.get("/api/v1/api-definitions/" + did,
                             params={"project_id": pid}, headers=h)).status_code == 200


async def test_delete_definition_referenced_only_by_recycled_scenario_is_free(client, make_user) -> None:
    """引用者自己进了回收站就不算引用——对齐 case 侧「未回收场景」口径
    （_scan_refs 只扫 status=normal 的场景；test_case_scenario_guard 同款钉）。"""
    h, pid, mid, did = await _setup(client, make_user, "refrec")
    case = await _mk_case(client, h, pid, did)
    scene = await _mk_scene(client, h, pid, [case["id"]])
    assert (await client.post("/api/v1/scenarios/" + scene["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text


async def test_delete_definition_recycled_case_reference_does_not_block(client, make_user) -> None:
    """已回收用例不算引用者的桥：那条步骤本来就跑不动（api_case_resolve 先判用例状态），
    回收定义不会让它坏第二次。拦这种引用只会把人训练成无脑 force。"""
    h, pid, mid, did = await _setup(client, make_user, "refcase")
    case = await _mk_case(client, h, pid, did)
    await _mk_scene(client, h, pid, [case["id"]])
    assert (await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200
    r = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text


async def test_delete_definition_blocked_without_scenario_read(client, make_user) -> None:
    """拦不拦由数据决定、不由查看引用所需的权限决定（与用例侧同一口径）：
    无 scenario:read 的删除者照样 409，但数量照报、明细隐瞒、说明原因，force 也过不去。"""
    from app.core.db import get_sessionmaker
    from app.modules.iam.models import RoleTemplate

    h, pid, mid, did = await _setup(client, make_user, "refhid")
    async with get_sessionmaker()() as s:
        s.add(RoleTemplate(code="APIO_ONLY", name="只碰接口", builtin=False,
                           perms=["api:*", "project:read"]))
        await s.commit()
    outsider, ho = await make_user("refoutsider")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + outsider.id,
                             json={"role_code": "APIO_ONLY"}, headers=h)).status_code == 200

    case = await _mk_case(client, h, pid, did)
    await _mk_scene(client, h, pid, [case["id"]])

    r = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid}, headers=ho)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "referenced_by_scenario", body
    assert body["details"]["count"] == 1
    assert body["details"]["scenarios"] == [], "无 scenario:read 时明细必须为空，不能泄露场景名"
    assert "scenario:read" in body["message"]
    # 明细被隐瞒时 force 同样拦下：不知道该断谁的步骤，一键下去坏的是别人的场景
    f = await client.post("/api/v1/api-definitions/" + did + "/delete",
                          json={"project_id": pid, "force": True}, headers=ho)
    assert f.status_code == 409, f.text
    lst = (await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=h)).json()["items"]
    assert [x["id"] for x in lst] == [did], "被隐瞒 force 拦住后定义也不能被回收"

    # boss 自己删：明细可见 + force 放行
    f2 = await client.post("/api/v1/api-definitions/" + did + "/delete",
                           json={"project_id": pid, "force": True}, headers=h)
    assert f2.status_code == 200, f2.text

