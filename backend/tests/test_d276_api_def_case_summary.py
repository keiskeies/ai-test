"""D276 接口列表的用例规模批量投影：一页一次算「用例数/执行结果/通过率」。

钉四条：
① 聚合口径：有失败用例 → failed（历史失败不被后一次通过抹掉）；全过 → passed；
   部分执行且全过 → partial；无用例/未执行 → none；
② 回收站的用例不算规模（case_count 只数正常用例）；
③ 只回仍存在的接口（页面上被删的行画「—」，不回编造的 0）；
④ 出参补上 created_at（列表「创建时间」列的真相）。
"""
from __future__ import annotations

from app.modules.api_test.models import ApiCase
from app.modules.execution.models import RunRecord

_BASE = "/api/v1"


async def _setup(client, make_user, tag: str):
    _, h = await make_user("apib" + tag)
    pid = (await client.post(_BASE + "/projects", json={"name": "pi" + tag},
                             headers=h)).json()["id"]

    async def mk_def(name: str) -> str:
        r = await client.post(_BASE + "/api-definitions", json={
            "project_id": pid, "name": name, "method": "GET", "path": "/" + name,
        }, headers=h)
        assert r.status_code == 201, r.text
        return r.json()["id"]

    return h, pid, mk_def


async def _case(session, pid: str, def_id: str, name: str, status: str = "normal") -> str:
    case = ApiCase(id="c-" + name, project_id=pid, definition_id=def_id, name=name,
                   status=status)
    session.add(case)
    await session.commit()
    return case.id


async def _run(session, pid: str, case_id: str, status: str) -> None:
    session.add(RunRecord(project_id=pid, subject_type="api_case", subject_id=case_id,
                          subject_name="r", trigger="manual", status=status))
    await session.commit()


async def _batch(client, h, pid: str, ids: list[str]):
    return await client.post(_BASE + "/api-def-case-summary-batch",
                             json={"project_id": pid, "definition_ids": ids}, headers=h)


async def test_registry_and_created_at_out(client, make_user) -> None:
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("api_def_case_summary_batch")
    assert spec is not None and spec.perm == "api:def:read"

    h, pid, mk = await _setup(client, make_user, "A")
    did = await mk("创建时间")
    rows = (await client.get(_BASE + "/api-definitions?project_id=" + pid + "&size=50",
                             headers=h)).json()["items"]
    row = next(x for x in rows if x["id"] == did)
    assert row["created_at"]  # D276 新出参：不是 null


async def test_aggregate_result_and_rate(client, make_user, session) -> None:
    h, pid, mk = await _setup(client, make_user, "B")
    d1 = await mk("多用例")
    d2 = await mk("空接口")
    d3 = await mk("全过")
    c1 = await _case(session, pid, d1, "c1")
    c2 = await _case(session, pid, d1, "c2")
    c3 = await _case(session, pid, d3, "c3")
    await _case(session, pid, d1, "回收的", status="recycled")
    await _run(session, pid, c1, "passed")
    await _run(session, pid, c2, "failed")
    await _run(session, pid, c2, "passed")  # 历史失败不被后一次通过抹掉
    await _run(session, pid, c3, "passed")

    r = await _batch(client, h, pid, [d1, d2, d3, "no-such-def"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3  # 不存在的 id 不回摘要
    got = {x["definition_id"]: x for x in body["items"]}

    assert got[d1]["case_count"] == 2  # 回收用例不算
    assert got[d1]["executed"] == 2 and got[d1]["passed"] == 1 and got[d1]["failed"] == 1
    assert got[d1]["result"] == "failed"
    assert got[d1]["case_pass_rate"] == 0.5
    assert got[d2]["case_count"] == 0 and got[d2]["result"] == "none"
    assert got[d2]["case_pass_rate"] == 0.0
    assert got[d3]["result"] == "passed" and got[d3]["case_pass_rate"] == 1.0


async def test_partial_and_running(client, make_user, session) -> None:
    h, pid, mk = await _setup(client, make_user, "C")
    d = await mk("部分")
    c1 = await _case(session, pid, d, "p1")
    await _case(session, pid, d, "p2")
    await _run(session, pid, c1, "passed")
    got = {x["definition_id"]: x for x in (await _batch(client, h, pid, [d])).json()["items"]}
    assert got[d]["result"] == "partial" and got[d]["case_pass_rate"] == 0.5

    await _run(session, pid, c1, "running")
    got = {x["definition_id"]: x for x in (await _batch(client, h, pid, [d])).json()["items"]}
    # 有执行中且无失败 → running（即便有历史通过，也不谎报 passed）
    assert got[d]["result"] == "running" and got[d]["executed"] == 1


async def test_other_project_is_scoped(client, make_user) -> None:
    h, pid, mk = await _setup(client, make_user, "D")
    d = await mk("本项")
    other = (await client.post(_BASE + "/projects", json={"name": "pD2"},
                                headers=h)).json()["id"]
    body = (await _batch(client, h, other, [d])).json()
    assert body["items"] == [] and body["total"] == 0
