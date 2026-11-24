"""D277 功能用例列表的评审/执行结论批量投影。

钉三条：
① 取**最近一次**评审结论与最近一次人工执行结论（升序遍历取最后一条，不按插入序猜）；
② 没发生过 = null，与 fail 分开（不把「从未评审」画成未通过）；
③ 只回仍存在的用例（取数间隙被删的行不回摘要）。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.review.models import CaseReview, CaseReviewCase
from app.modules.testplan.models import PlanFunctionalExec

_BASE = "/api/v1"


async def _setup(client, make_user, tag: str):
    _, h = await make_user("fcb" + tag)
    pid = (await client.post(_BASE + "/projects", json={"name": "pf" + tag},
                             headers=h)).json()["id"]
    ids = []
    for name in ("用例甲", "用例乙"):
        r = await client.post(_BASE + "/functional-cases", json={
            "project_id": pid, "name": name, "priority": "P2",
        }, headers=h)
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    return h, pid, ids


async def _batch(client, h, pid: str, ids: list[str]):
    return await client.post(_BASE + "/functional-case-summary-batch",
                             json={"project_id": pid, "case_ids": ids}, headers=h)


async def test_latest_review_and_exec(client, make_user, session) -> None:
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("functional_case_summary_batch")
    assert spec is not None and spec.perm == "functional:case:read"

    h, pid, (c1, c2) = await _setup(client, make_user, "A")
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    session.add(CaseReview(id="rv1", project_id=pid, num=1, name="初评"))
    session.add(CaseReview(id="rv2", project_id=pid, num=2, name="复审"))
    session.add(CaseReviewCase(id="rl1", project_id=pid, review_id="rv1", case_id=c1,
                               result="pass", updated_at=t0))
    session.add(CaseReviewCase(id="rl2", project_id=pid, review_id="rv2", case_id=c1,
                               result="fail", updated_at=t0 + timedelta(hours=1)))
    session.add(PlanFunctionalExec(id="e1", project_id=pid, plan_id="pl1", link_id="lk1",
                                   case_id=c1, result="pass", executed_at=t0))
    session.add(PlanFunctionalExec(id="e2", project_id=pid, plan_id="pl2", link_id="lk2",
                                   case_id=c1, result="blocked", executed_at=t0 + timedelta(hours=2)))
    await session.commit()

    r = await _batch(client, h, pid, [c1, c2, "no-such-case"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 2
    got = {x["case_id"]: x for x in body["items"]}
    assert got[c1]["review_result"] == "fail" and got[c1]["review_name"] == "复审"
    assert got[c1]["exec_result"] == "blocked" and got[c1]["exec_at"]
    # 从未评审/从未执行 = null，不是 fail、也不是空字符串
    assert got[c2]["review_result"] is None and got[c2]["exec_result"] is None
    assert got[c2]["review_name"] is None and got[c2]["exec_at"] is None


async def test_other_project_is_scoped(client, make_user) -> None:
    h, pid, (c1, _c2) = await _setup(client, make_user, "B")
    other = (await client.post(_BASE + "/projects", json={"name": "pfB2"},
                                headers=h)).json()["id"]
    body = (await _batch(client, h, other, [c1])).json()
    assert body["items"] == [] and body["total"] == 0
