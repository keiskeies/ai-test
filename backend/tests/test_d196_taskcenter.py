"""D196：任务中心（摘要/列表/排队位次/详情/停止/重跑边界/权限）。"""
from __future__ import annotations

import json

import pytest_asyncio

from app.core.config import get_settings
from app.modules.execution.models import RunRecord, RunStepResult

_BASE = "/api/v1"


@pytest_asyncio.fixture()
async def fake_bus():
    from fakeredis import FakeAsyncRedis

    from app.core.eventbus import init_bus

    return init_bus(client=FakeAsyncRedis(decode_responses=True))


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, hb, pid: str, uid: str, role: str = "MEMBER") -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=hb)
    assert r.status_code == 200, r.text


def _run(session, pid: str, uid: str, *, rid: str, status: str,
         subject_type: str = "scenario") -> RunRecord:
    r = RunRecord(id=rid, project_id=pid, subject_type=subject_type, subject_id="s1",
                  subject_name="场景-" + rid, trigger="manual", status=status,
                  elapsed_ms=1200 if status in ("passed", "failed", "error") else None,
                  created_by=uid)
    session.add(r)
    return r


async def test_summary_list_detail(client, session, make_user, fake_bus) -> None:
    boss, h = await make_user("d196a", admin=True)
    pid = await _proj(client, h, "D196任务")
    _run(session, pid, boss.id, rid="r-queue", status="queued")
    _run(session, pid, boss.id, rid="r-run", status="running")
    _run(session, pid, boss.id, rid="r-pass", status="passed")
    _run(session, pid, boss.id, rid="r-fail", status="failed")
    _run(session, pid, boss.id, rid="r-err", status="error", subject_type="ui_case")
    session.add_all([
        RunStepResult(run_id="r-pass", step_key="k1", row_no=0, kind="scenario_step", status="pass"),
        RunStepResult(run_id="r-pass", step_key="k2", row_no=0, kind="scenario_step", status="fail"),
    ])
    await session.commit()

    s = await client.get(_BASE + "/task-center/summary", params={"project_id": pid}, headers=h)
    assert s.status_code == 200, s.text
    body = s.json()
    assert body["total"] == 5 and body["active"] == 2
    assert body["passed"] == 1 and body["failed"] == 1 and body["error"] == 1
    assert body["pass_rate"] == 33.33

    active = await client.get(_BASE + "/task-center/tasks",
                              params={"project_id": pid, "state": "active"}, headers=h)
    assert {x["id"] for x in active.json()["items"]} == {"r-queue", "r-run"}
    finished = await client.get(_BASE + "/task-center/tasks",
                                params={"project_id": pid, "state": "finished"}, headers=h)
    assert {x["id"] for x in finished.json()["items"]} == {"r-pass", "r-fail", "r-err"}
    by_type = await client.get(_BASE + "/task-center/tasks",
                               params={"project_id": pid, "subject_type": "ui_case"}, headers=h)
    assert [x["id"] for x in by_type.json()["items"]] == ["r-err"]

    d = await client.get(_BASE + "/task-center/tasks/r-pass", params={"project_id": pid}, headers=h)
    assert d.status_code == 200
    assert d.json()["step_counts"] == {"pass": 1, "fail": 1}
    assert d.json()["can_rerun"] is True


async def test_queue_position(client, session, make_user, fake_bus) -> None:
    boss, h = await make_user("d196q", admin=True)
    pid = await _proj(client, h, "D196排队")
    _run(session, pid, boss.id, rid="r-q1", status="queued")
    _run(session, pid, boss.id, rid="r-q2", status="queued")
    await session.commit()
    client_redis = fake_bus.client
    queue = get_settings().task_queue
    msg1 = json.dumps({"headers": {"id": "r-q1"}, "body": "x"})
    msg2 = json.dumps({"headers": {"id": "r-q2"}, "body": "x"})
    await client_redis.rpush(queue, msg1)
    await client_redis.rpush(queue, msg2)
    try:
        q = await client.get(_BASE + "/task-center/queue", params={"project_id": pid}, headers=h)
        assert q.status_code == 200, q.text
        body = q.json()
        assert body["available"] is True
        pos = {x["id"]: x["queue_position"] for x in body["items"]}
        assert pos["r-q1"] is not None and pos["r-q2"] is not None
        assert pos["r-q1"] < pos["r-q2"]
        assert body["queue_length"] >= 2
    finally:
        await client_redis.lrem(queue, 0, msg1)
        await client_redis.lrem(queue, 0, msg2)


async def test_stop_and_rerun_boundary(client, session, make_user, fake_bus) -> None:
    boss, h = await make_user("d196s", admin=True)
    pid = await _proj(client, h, "D196停止")
    _run(session, pid, boss.id, rid="r-stop", status="queued")
    _run(session, pid, boss.id, rid="r-api", status="passed", subject_type="api_case")
    await session.commit()
    st = await client.post(_BASE + "/task-center/tasks/r-stop/stop",
                           json={"project_id": pid, "run_id": "r-stop"}, headers=h)
    assert st.status_code == 200, st.text
    row = await session.get(RunRecord, "r-stop")
    await session.refresh(row)
    assert row.cancel_requested == 1
    again = await client.post(_BASE + "/task-center/tasks/r-stop/stop",
                              json={"project_id": pid, "run_id": "r-stop"}, headers=h)
    assert again.status_code in (200, 409)  # runner 可能已置终态；两者都忠实
    rr = await client.post(_BASE + "/task-center/tasks/r-api/rerun",
                           json={"project_id": pid, "run_id": "r-api"}, headers=h)
    assert rr.status_code == 422 and rr.json()["code"] == "rerun_unsupported"


async def test_permissions(client, session, make_user, fake_bus) -> None:
    boss, hb = await make_user("d196p", admin=True)
    ro, hr = await make_user("d196p2")
    pid = await _proj(client, hb, "D196权限")
    await _member(client, hb, pid, ro.id, "READONLY")
    _run(session, pid, boss.id, rid="r-ro", status="queued")
    await session.commit()
    assert (await client.get(_BASE + "/task-center/summary", params={"project_id": pid},
                             headers=hr)).status_code == 200
    deny = await client.post(_BASE + "/task-center/tasks/r-ro/stop",
                             json={"project_id": pid, "run_id": "r-ro"}, headers=hr)
    assert deny.status_code == 403 and deny.json()["details"]["perm"] == "task:center:stop"
