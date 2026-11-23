"""D237 判据刀：任务中心批量停止（对齐 MS `/task/center/stop/batch`）。

契约要点（对应 services.py `task_batch_stop` 的 docstring 三条）：

1. **三桶分账**：stopped / skipped / failed 之和 = 去重后的请求条数；重复 id 只算一条。
2. **缺 id / 跨项目 id → 404 且整批零写入**：存在的那条也不能被顺手停掉。
3. **已结束 / 已在取消中 → skipped**（批量里这是常态，不逐条 409）；逐条失败不回滚。
4. **权限**：READONLY 无 `task:center:stop` → 整批 403；MEMBER 有该位可停。
"""
from __future__ import annotations

import pytest_asyncio

from app.modules.execution.models import RunRecord

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
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=hb)
    assert r.status_code == 200, r.text


def _run(session, pid: str, uid: str, *, rid: str, status: str,
         subject_type: str = "scenario", cancel_requested: int = 0) -> RunRecord:
    r = RunRecord(id=rid, project_id=pid, subject_type=subject_type, subject_id="s1",
                  subject_name="场景-" + rid, trigger="manual", status=status,
                  elapsed_ms=1200 if status in ("passed", "failed", "error") else None,
                  created_by=uid, cancel_requested=cancel_requested)
    session.add(r)
    return r


async def _batch(client, h, pid: str, ids: list[str]):
    return await client.post(_BASE + "/task-center/tasks/batch-stop",
                             json={"project_id": pid, "run_ids": ids}, headers=h)


async def test_stops_active_and_skips_finished(client, session, make_user, fake_bus) -> None:
    boss, h = await make_user("d237a", admin=True)
    pid = await _proj(client, h, "D237批量停止")
    _run(session, pid, boss.id, rid="r-q1", status="queued")
    _run(session, pid, boss.id, rid="r-run", status="running")
    _run(session, pid, boss.id, rid="r-pass", status="passed")
    _run(session, pid, boss.id, rid="r-cancelling", status="queued", cancel_requested=1)
    await session.commit()

    r = await _batch(client, h, pid, ["r-q1", "r-run", "r-pass", "r-cancelling", "r-q1"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stopped"] == 2 and body["skipped"] == 2 and body["failed"] == []
    assert body["stopped_ids"] == ["r-q1", "r-run"]  # 去重保序：r-q1 只出现一次
    assert body["skipped_ids"] == ["r-pass", "r-cancelling"]
    assert body["stopped"] + body["skipped"] + len(body["failed"]) == 4

    for rid in ("r-q1", "r-run"):
        row = await session.get(RunRecord, rid)
        await session.refresh(row)
        assert row.cancel_requested == 1, rid
    passed = await session.get(RunRecord, "r-pass")
    await session.refresh(passed)
    assert passed.cancel_requested == 0  # 已结束的没被写


async def test_missing_id_rejects_whole_batch(client, session, make_user, fake_bus) -> None:
    boss, h = await make_user("d237b", admin=True)
    pid = await _proj(client, h, "D237缺id")
    pid_b = await _proj(client, h, "D237别项目")
    _run(session, pid, boss.id, rid="r-ok", status="queued")
    _run(session, pid_b, boss.id, rid="r-other", status="queued")
    await session.commit()

    r = await _batch(client, h, pid, ["r-ok", "r-ghost", "r-other"])
    assert r.status_code == 404, r.text
    assert r.json()["code"] == "not_found"
    # 缺的不存在、跨项目的也不在本项目集合里：两条都报出来
    assert r.json()["details"]["run_ids"] == ["r-ghost", "r-other"]
    for rid in ("r-ok", "r-other"):
        row = await session.get(RunRecord, rid)
        await session.refresh(row)
        assert row.cancel_requested == 0, rid  # 整批零写入


async def test_empty_and_too_many_ids_rejected(client, make_user, fake_bus) -> None:
    _, h = await make_user("d237c", admin=True)
    pid = await _proj(client, h, "D237边界")
    empty = await _batch(client, h, pid, [])
    assert empty.status_code == 422
    too_many = await _batch(client, h, pid, ["r" + str(i) for i in range(101)])
    assert too_many.status_code == 422


async def test_permissions(client, session, make_user, fake_bus) -> None:
    boss, hb = await make_user("d237p", admin=True)
    ro, hr = await make_user("d237p_ro")
    member, hm = await make_user("d237p_m")
    pid = await _proj(client, hb, "D237权限")
    await _member(client, hb, pid, ro.id, "READONLY")
    await _member(client, hb, pid, member.id, "MEMBER")
    _run(session, pid, boss.id, rid="r-p1", status="queued")
    _run(session, pid, boss.id, rid="r-p2", status="queued")
    await session.commit()

    deny = await _batch(client, hr, pid, ["r-p1"])
    assert deny.status_code == 403, deny.text

    ok = await _batch(client, hm, pid, ["r-p1", "r-p2"])
    assert ok.status_code == 200, ok.text
    assert ok.json()["stopped"] == 2
