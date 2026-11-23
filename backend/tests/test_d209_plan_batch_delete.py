"""D209 判据刀：批量删除计划（MS TestPlanController `/delete/batch` 的等价面）。

钉的契约：

1. **一次事务删干净每一把刀**（test_batch_deletes_all_cascades...）：两个计划分别带
   场景关联 / 功能用例结论 + 报告，批量删后 plan_record、plan_case_link、
   plan_functional_exec(_history)、plan_report(_item) 全部归零；**另一个计划毫发无损**。
2. **全有或全无**（test_missing_id...）：列表里混一个不存在的 id → 404 + details.plan_ids
   恰是缺的那个，**真的那个一行都不许删**（「删一半再报错」是最坏的成功）。
3. **重复 id → 422、空列表 422**（test_duplicate_and_empty...）：同一计划删两次没有第二种
   语义（说明调用方拼错了），整批不动。
4. **跨项目 id 与不存在同码同文案**（test_cross_project...）：404「计划不存在」，
   两个项目的数据都不动。
5. **权限**（test_gates...）：READONLY/MEMBER 403（MEMBER 的 `-*:delete` 显式拒绝），
   PROJECT_ADMIN 可以；拒绝不落库。
"""
from __future__ import annotations

from app.modules.env.models import Environment
from app.modules.functional.models import FunctionalCase
from app.modules.scenario.models import Scenario

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _plan(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _link(client, h, pid: str, plan_id: str, subject_type: str, subject_id: str) -> dict:
    r = await client.post(_BASE + f"/plans/{plan_id}/case-links",
                          json={"project_id": pid, "subject_type": subject_type,
                                "subject_id": subject_id}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _batch(client, h, pid: str, ids: list[str]):
    return await client.post(_BASE + "/plans/batch-delete",
                             json={"project_id": pid, "plan_ids": ids}, headers=h)


async def _count(conn, sql: str, **params) -> int:
    from sqlalchemy import text

    return int((await conn.execute(text(sql), params)).scalar_one())


async def test_batch_deletes_all_cascades_and_spares_other_plans(client, session, conn, make_user) -> None:
    _, h = await make_user("d209a", admin=True)
    pid = await _proj(client, h, "D209级联")
    a = await _plan(client, h, pid, "甲计划")
    b = await _plan(client, h, pid, "乙计划")
    keep = await _plan(client, h, pid, "留下的计划")
    session.add(Environment(id="env-d209", project_id=pid, name="环境"))
    session.add(Scenario(id="sc-d209", project_id=pid, name="场景",
                         step_graph={"version": 1, "nodes": []}, env_id="env-d209"))
    session.add(FunctionalCase(id="fc-d209", project_id=pid, num=209001,
                               name="功能用例", template_id="tpl-seed"))
    await session.commit()
    await _link(client, h, pid, a["id"], "scenario", "sc-d209")
    lk_b = await _link(client, h, pid, b["id"], "functional_case", "fc-d209")
    await _link(client, h, pid, keep["id"], "scenario", "sc-d209")
    r = await client.post(_BASE + f"/plans/{b['id']}/functional-cases/execute",
                          json={"project_id": pid, "link_ids": [lk_b["id"]],
                                "result": "fail", "comment": "挂了"}, headers=h)
    assert r.status_code == 200, r.text
    for p in (a, b, keep):
        r = await client.post(_BASE + f"/plans/{p['id']}/reports",
                              json={"project_id": pid}, headers=h)
        assert r.status_code == 201, r.text

    r = await _batch(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 200 and r.json() == {"ok": True}

    # 两个目标计划的所有刀归零；第三个计划与它那条关联、报告原样在。
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE project_id=:p AND id IN (:a,:b)",
                        p=pid, a=a["id"], b=b["id"]) == 0
    assert await _count(conn, "SELECT COUNT(*) FROM plan_case_link WHERE plan_id IN (:a,:b)",
                        a=a["id"], b=b["id"]) == 0
    assert await _count(conn, "SELECT COUNT(*) FROM plan_functional_exec WHERE plan_id IN (:a,:b)",
                        a=a["id"], b=b["id"]) == 0
    assert await _count(conn, "SELECT COUNT(*) FROM plan_functional_exec_history WHERE plan_id IN (:a,:b)",
                        a=a["id"], b=b["id"]) == 0
    assert await _count(conn, "SELECT COUNT(*) FROM plan_report WHERE plan_id IN (:a,:b)",
                        a=a["id"], b=b["id"]) == 0
    # 报告明细按 report_id 级联删——两计划的明细一条不剩（不留孤儿）。
    assert await _count(
        conn,
        "SELECT COUNT(*) FROM plan_report_item i JOIN plan_report r ON r.id=i.report_id "
        "WHERE r.plan_id IN (:a,:b)", a=a["id"], b=b["id"]) == 0

    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE id=:p", p=keep["id"]) == 1
    assert await _count(conn, "SELECT COUNT(*) FROM plan_case_link WHERE plan_id=:p",
                        p=keep["id"]) == 1
    assert await _count(conn, "SELECT COUNT(*) FROM plan_report WHERE plan_id=:p",
                        p=keep["id"]) == 1
    r = await client.get(_BASE + f"/plans/{keep['id']}",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200


async def test_missing_id_aborts_whole_batch(client, conn, make_user) -> None:
    _, h = await make_user("d209b", admin=True)
    pid = await _proj(client, h, "D209全无")
    p = await _plan(client, h, pid, "真计划")
    before = await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE project_id=:p", p=pid)

    r = await _batch(client, h, pid, [p["id"], "ghost-plan"])
    assert r.status_code == 404
    assert r.json()["message"] == "计划不存在"
    assert r.json()["details"]["plan_ids"] == ["ghost-plan"]
    # 真的那个一行都没删。
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE project_id=:p",
                        p=pid) == before
    r = await client.get(_BASE + f"/plans/{p['id']}", params={"project_id": pid}, headers=h)
    assert r.status_code == 200


async def test_duplicate_and_empty_ids(client, conn, make_user) -> None:
    _, h = await make_user("d209c", admin=True)
    pid = await _proj(client, h, "D209拼错")
    p = await _plan(client, h, pid, "计划")
    r = await _batch(client, h, pid, [p["id"], p["id"]])
    assert r.status_code == 422
    assert r.json()["message"] == "plan_ids 不能重复"
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE id=:p", p=p["id"]) == 1

    r = await _batch(client, h, pid, [])
    assert r.status_code == 422  # min_length=1


async def test_cross_project_same_as_missing(client, conn, make_user) -> None:
    _, h = await make_user("d209d", admin=True)
    pid_a = await _proj(client, h, "D209甲")
    pid_b = await _proj(client, h, "D209乙")
    pb = await _plan(client, h, pid_b, "乙计划")
    pa = await _plan(client, h, pid_a, "甲计划")

    r1 = await _batch(client, h, pid_a, [pa["id"], pb["id"]])
    r2 = await _batch(client, h, pid_a, ["no-such-plan"])
    assert r1.status_code == r2.status_code == 404
    assert r1.json()["message"] == r2.json()["message"] == "计划不存在"
    assert r1.json()["details"]["plan_ids"] == [pb["id"]]
    # 甲的项目（含合法 id）与乙的项目都一行没动。
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE id IN (:a,:b)",
                        a=pa["id"], b=pb["id"]) == 2


async def test_gates(client, conn, make_user) -> None:
    _, h = await make_user("d209e", admin=True)
    pid = await _proj(client, h, "D209门")
    p = await _plan(client, h, pid, "门计划")
    before = await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE project_id=:p", p=pid)

    ro, roh = await make_user("d209ro")
    await _member(client, h, pid, ro.id, "READONLY")
    r = await _batch(client, roh, pid, [p["id"]])
    assert r.status_code == 403
    assert r.json()["details"]["perm"] == "testplan:plan:delete"

    mem, mh = await make_user("d209me")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await _batch(client, mh, pid, [p["id"]])
    assert r.status_code == 403  # MEMBER 的 -*:delete
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE project_id=:p",
                        p=pid) == before

    pa, pah = await make_user("d209pa")
    await _member(client, h, pid, pa.id, "PROJECT_ADMIN")
    r = await _batch(client, pah, pid, [p["id"]])
    assert r.status_code == 200, r.text
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE id=:p", p=p["id"]) == 0
