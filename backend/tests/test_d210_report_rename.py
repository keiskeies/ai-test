"""D210 判据刀：计划报告改名（MS `TestPlanReportController.reName` 的等价面）。

钉的契约：

1. **只动 name，内容快照逐字节不动**（test_rename_only_touches_name...）：改名前后
   status/五个计数/items 原样；库侧明细表行数与每行 result 不变；计划归档后改名仍可以
   （标题是元数据，不是执行动作）。
2. **404 同码同文案**（test_missing_or_cross_project...）：不存在 / 别项目的报告。
3. **校验**（test_validation...）：空名 422、超 200 字 422。
4. **权限**（test_gates...）：READONLY 403 details.perm=testplan:report:update；MEMBER
   放行（MEMBER 持 `*`，update 不在 deny 列表里）；拒绝不落库。
5. **列表/详情读到新名**（test_rename_visible_everywhere...）：改名后 GET 详情与
   GET 计划报告列表都报新名。
"""
from __future__ import annotations

from app.modules.env.models import Environment
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


async def _plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _report(client, h, pid: str, plan_id: str, **body) -> dict:
    r = await client.post(_BASE + f"/plans/{plan_id}/reports",
                          json={"project_id": pid, **body}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _rename(client, h, pid: str, report_id: str, name: str):
    return await client.patch(_BASE + f"/plan-reports/{report_id}",
                              json={"project_id": pid, "name": name}, headers=h)


async def _count(conn, sql: str, **params) -> int:
    from sqlalchemy import text

    return int((await conn.execute(text(sql), params)).scalar_one())


async def test_rename_only_touches_name_and_works_after_archive(client, session, conn, make_user) -> None:
    _, h = await make_user("d210a", admin=True)
    pid = await _proj(client, h, "D210改名")
    plan = await _plan(client, h, pid, "改名计划")
    session.add(Environment(id="env-d210a", project_id=pid, name="环境"))
    session.add(Scenario(id="sc-d210a", project_id=pid, name="改名场景",
                         step_graph={"version": 1, "nodes": []}, env_id="env-d210a"))
    await session.commit()
    r = await client.post(_BASE + f"/plans/{plan['id']}/case-links",
                          json={"project_id": pid, "subject_type": "scenario",
                                "subject_id": "sc-d210a"}, headers=h)
    assert r.status_code == 201, r.text
    rep = await _report(client, h, pid, plan["id"], name="旧报告名")
    before = (await client.get(_BASE + f"/plan-reports/{rep['id']}",
                               params={"project_id": pid}, headers=h)).json()

    # 归档计划后再改名：标题是元数据，归档封的是执行编排，不封改名。
    r = await client.post(_BASE + f"/plans/{plan['id']}/archive",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text

    r = await _rename(client, h, pid, rep["id"], "新报告名")
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["id"] == rep["id"] and row["name"] == "新报告名"

    after = (await client.get(_BASE + f"/plan-reports/{rep['id']}",
                              params={"project_id": pid}, headers=h)).json()
    # 内容快照逐字段原样（name 之外全等；created_at 也不动）。
    for k in ("plan_id", "status", "total", "passed", "failed", "executed", "executing",
              "created_by", "created_at", "items"):
        assert after[k] == before[k], "改名动了内容列：" + k
    assert after["name"] == "新报告名"
    # 库侧：明细行一条不少、结论值原样。
    assert await _count(conn, "SELECT COUNT(*) FROM plan_report_item WHERE report_id=:r",
                        r=rep["id"]) == len(before["items"])
    if before["items"]:
        from sqlalchemy import text

        want = {x["link_id"]: x["result"] for x in before["items"]}
        rows = (await conn.execute(
            text("SELECT link_id, result FROM plan_report_item WHERE report_id=:r"),
            {"r": rep["id"]})).all()
        assert {str(a): str(b) for a, b in rows} == want


async def test_missing_or_cross_project_same_404(client, make_user) -> None:
    _, h = await make_user("d210b", admin=True)
    pid_a = await _proj(client, h, "D210甲")
    pid_b = await _proj(client, h, "D210乙")
    plan_b = await _plan(client, h, pid_b, "乙计划")
    rep_b = await _report(client, h, pid_b, plan_b["id"])

    r1 = await _rename(client, h, pid_a, rep_b["id"], "越权改名")
    r2 = await _rename(client, h, pid_a, "no-such-report", "越权改名")
    assert r1.status_code == r2.status_code == 404
    assert r1.json()["message"] == r2.json()["message"] == "报告不存在"
    # 乙项目的报告名字没被改。
    got = (await client.get(_BASE + f"/plan-reports/{rep_b['id']}",
                            params={"project_id": pid_b}, headers=h)).json()
    assert got["name"] == rep_b["name"]


async def test_validation(client, make_user) -> None:
    _, h = await make_user("d210c", admin=True)
    pid = await _proj(client, h, "D210校验")
    plan = await _plan(client, h, pid, "校验计划")
    rep = await _report(client, h, pid, plan["id"])
    assert (await _rename(client, h, pid, rep["id"], "")).status_code == 422
    assert (await _rename(client, h, pid, rep["id"], "x" * 201)).status_code == 422


async def test_gates(client, conn, make_user) -> None:
    _, h = await make_user("d210d", admin=True)
    pid = await _proj(client, h, "D210门")
    plan = await _plan(client, h, pid, "门计划")
    rep = await _report(client, h, pid, plan["id"], name="原名")

    ro, roh = await make_user("d210ro")
    await _member(client, h, pid, ro.id, "READONLY")
    r = await _rename(client, roh, pid, rep["id"], "只读改名")
    assert r.status_code == 403
    assert r.json()["details"]["perm"] == "testplan:report:update"
    assert await _count(conn, "SELECT COUNT(*) FROM plan_report WHERE id=:r AND name='原名'",
                        r=rep["id"]) == 1

    mem, mh = await make_user("d210me")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await _rename(client, mh, pid, rep["id"], "成员改名")
    assert r.status_code == 200, r.text


async def test_rename_visible_everywhere(client, make_user) -> None:
    _, h = await make_user("d210e", admin=True)
    pid = await _proj(client, h, "D210可见")
    plan = await _plan(client, h, pid, "可见计划")
    rep = await _report(client, h, pid, plan["id"], name="旧名")
    assert (await _rename(client, h, pid, rep["id"], "列表新名")).status_code == 200
    detail = (await client.get(_BASE + f"/plan-reports/{rep['id']}",
                               params={"project_id": pid}, headers=h)).json()
    assert detail["name"] == "列表新名"
    r = await client.get(_BASE + f"/plans/{plan['id']}/reports",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200
    assert [x["name"] for x in r.json()["items"]] == ["列表新名"]
