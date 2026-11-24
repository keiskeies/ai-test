"""D275 计划列表批量状态投影：一页一次拿齐状态/通过率/执行率/各类型用例数。

钉四条：
① 与 /plans/{id}/status 同源同值（同一个 _plan_display/_link_result/_rates，不是第二套口径）；
② 各类型计数按 subject_type 分格（功能/接口/场景/UI/ADB）；
③ 只回仍存在的计划（页面上被删的行不回摘要），total 供对账；
④ 跨项目读失败 + 缺 read 位 403（批量端点不是绕过门禁的后门）。
"""
from __future__ import annotations

from app.modules.api_test.models import ApiCase
from app.modules.execution.models import RunRecord
from app.modules.testplan.models import PlanCaseLink

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _plan(client, h, pid: str, name: str) -> str:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _batch(client, h, pid: str, ids: list[str]):
    return await client.post(_BASE + "/plan-status-batch",
                             json={"project_id": pid, "plan_ids": ids}, headers=h)


async def _seed(session, pid: str, plan_id: str, *, link_id: str, subject_type: str,
                subject_id: str) -> None:
    if subject_type == "api_case":
        session.add(ApiCase(id=subject_id, project_id=pid, definition_id="d-" + subject_id,
                            name=subject_id))
    session.add(PlanCaseLink(id=link_id, project_id=pid, plan_id=plan_id,
                             subject_type=subject_type, subject_id=subject_id,
                             subject_name="名" + subject_id))
    await session.commit()


async def _run(session, pid: str, subject_type: str, subject_id: str, status: str) -> None:
    session.add(RunRecord(project_id=pid, subject_type=subject_type, subject_id=subject_id,
                          subject_name="r", trigger="manual", status=status))
    await session.commit()


async def test_batch_matches_single_status_and_counts(client, make_user, session) -> None:
    _, h = await make_user("pbat")
    pid = await _proj(client, h, "批量状态")
    p1 = await _plan(client, h, pid, "全过")
    p2 = await _plan(client, h, pid, "未开始")
    # p1：一条 api 通过、一条 scenario 没跑；p2：一条 adb 失败
    await _seed(session, pid, p1, link_id="l1", subject_type="api_case", subject_id="a1")
    await _seed(session, pid, p1, link_id="l2", subject_type="scenario", subject_id="s1")
    await _seed(session, pid, p2, link_id="l3", subject_type="adb_case", subject_id="d1")
    await _run(session, pid, "api_case", "a1", "passed")
    await _run(session, pid, "adb_case", "d1", "failed")

    r = await _batch(client, h, pid, [p1, p2])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 2
    got = {x["plan_id"]: x for x in body["items"]}

    # ① 与单计划端点逐字段同值（两处必须同一套判据）
    for plan_id in (p1, p2):
        one = (await client.get(_BASE + f"/plans/{plan_id}/status",
                                params={"project_id": pid}, headers=h)).json()
        b = got[plan_id]
        for k in ("status", "total", "passed", "failed", "executed", "executing",
                  "not_executed", "pass_rate", "execute_rate", "archived"):
            assert b[k] == one[k], (plan_id, k, b[k], one[k])

    assert got[p1]["counts"] == {"functional_case": 0, "api_case": 1, "scenario": 1,
                                 "ui_case": 0, "adb_case": 0}
    assert got[p1]["status"] == "in_progress" and got[p1]["pass_rate"] == 0.5
    assert got[p2]["counts"]["adb_case"] == 1 and got[p2]["failed"] == 1
    assert got[p2]["status"] == "in_progress"


async def test_batch_skips_missing_plan(client, make_user) -> None:
    """页面上的行可能在取数间隙被删：批量摘要只回仍存在的，不 404 整页、也不编 0。"""
    _, h = await make_user("pbat2")
    pid = await _proj(client, h, "缺行")
    p1 = await _plan(client, h, pid, "在")
    r = await _batch(client, h, pid, [p1, "no-such-plan"])
    assert r.status_code == 200, r.text
    assert [x["plan_id"] for x in r.json()["items"]] == [p1]
    assert r.json()["total"] == 1


async def test_batch_is_project_scoped(client, make_user) -> None:
    """跨项目 id 不进摘要（project_id 谓词在场，与单计划端点同门）。"""
    _, h = await make_user("pbat3")
    pa = await _proj(client, h, "A项目")
    pb = await _proj(client, h, "B项目")
    p_in_a = await _plan(client, h, pa, "A计划")
    r = await _batch(client, h, pb, [p_in_a])
    assert r.status_code == 200, r.text
    assert r.json()["items"] == [] and r.json()["total"] == 0


async def test_batch_gate_and_shape(client, make_user) -> None:
    """注册表里的位名是真门禁（不是只靠前端藏按钮）；非项目成员连项目门都过不去。"""
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("plan_status_batch")
    assert spec is not None and spec.perm == "testplan:plan:read" and spec.effect == "read"

    admin, ha = await make_user("pbata")
    pid = await _proj(client, ha, "门禁")
    p = await _plan(client, ha, pid, "计划")
    _, hu = await make_user("pbatu")  # 不是该项目成员
    r = await _batch(client, hu, pid, [p])
    assert r.status_code == 403, r.text
