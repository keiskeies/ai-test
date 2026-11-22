"""D162：cron 触发重叠（run N 在途时 last_run 已被下一次 fire 覆盖）的通知与计数。

缺陷机理：fire 把 run_id 整对象写进 schedule_task.last_run（service.py 的
row.last_run = receipt），旧钩子按 JSON_EXTRACT(last_run,'$.run_id') 反查任务——
快 cron + 长跑下 fire N+1 抢在 run N 终态前覆盖 run_id，run N 的通知静默丢失，
且 consecutive_failures 冻死（告警阈值只认 ==3，冻住即永不再告）。

修法（已裁）：fire 建 run 时把 schedule_task_id 打进 request_snapshot，钩子只认
run 出生快照回表（唯一查表规则，无 last_run 兜底）。

手法：真 fire_task（spy 替投递）连发不投递模拟在途 → 再逐个直接 await _amain
（_fire_and_run 同款 worker 替身，inline 语义、真 run_graph、真钩子）。
FAIL_GRAPH 确定性红图，不打网络。
"""
from __future__ import annotations

import json

import pytest
from fakeredis import FakeAsyncRedis

from app.modules.schedule import service as svc
from tests.test_schedule_notify_hook import (  # 复用夹具函数与红图，不抄第二份
    FAIL_GRAPH,
    TR,
    _fresh,
    _run_final,
    _run_status,
    _setup,
    _SpyCelery,
)


@pytest.fixture(autouse=True)
def fake_bus():
    from app.core.eventbus import init_bus

    return init_bus(client=FakeAsyncRedis(decode_responses=True))


async def _deliver(run_id: str) -> None:
    """直 await _amain：返回时该 run 的终态与钩子都已落库（_fire_and_run 的后半段）。"""
    from app.core.eventbus import get_bus
    from app.modules.scenario.orchestration import _amain

    await _amain(run_id, bus=get_bus(), transport=TR)


def _lr(task) -> dict:
    lr = task.last_run
    return json.loads(lr) if isinstance(lr, str) else (lr or {})


async def test_d162_overlap_terminal_notifies_despite_overwritten_last_run(
    client, make_user, session, monkeypatch
) -> None:
    """在途重叠的正主：fire A → fire B（last_run 覆盖成 B）→ 才交付 A 的终态。

    旧实现（last_run 反查）在此处查不到任务 → 静默 return：A 的通知丢、计数冻 0。
    新实现（run 出生快照回表）：A 照常通知、计数 +1，且此刻 last_run 顶层仍指向 B
    ——两件事并存就是「快照是唯一可靠凭据」的实测形状。
    """
    setup = await _setup(client, make_user, session, tag="d162ovl", graph=FAIL_GRAPH)
    try:
        monkeypatch.setattr(svc, "_celery_client", lambda: _SpyCelery())
        ra = (await svc.fire_task(setup["task_id"]))["run_id"]
        rb = (await svc.fire_task(setup["task_id"]))["run_id"]  # A 在途，last_run 已变 B
        assert ra != rb
        lr = _lr(await _fresh(session, setup["task_id"]))
        assert lr["run_id"] == rb, "前置：交付 A 终态前 last_run 必须已指向 B（重叠窗成立）"
        assert setup["rx"].received == []

        await _deliver(ra)  # run A 终态（error）——旧实现在这里丢通知
        assert len(setup["rx"].received) == 1, "A 的终态必须真送到渠道，哪怕 last_run 已指向 B"
        assert "/reports/" + ra in setup["rx"].received[0]["json"]["text"]
        task = await _fresh(session, setup["task_id"])
        assert task.consecutive_failures == 1, "计数不许因反查落空而冻死"
        lr = _lr(task)
        assert lr["run_final"]["run_id"] == ra and lr["run_final"]["ok"] is False
        assert lr["run_id"] == rb, "fire 回执顶层仍是 B——通知落账与它指向谁无关"

        await _deliver(rb)  # B 的终态照常接上：计数继续走
        task = await _fresh(session, setup["task_id"])
        assert task.consecutive_failures == 2
        assert len(setup["rx"].received) == 2
        assert "/reports/" + rb in setup["rx"].received[1]["json"]["text"]
        assert _lr(task)["run_final"]["run_id"] == rb
        for rid in (ra, rb):
            assert (await _run_status(session, rid)).status == "error"
    finally:
        setup["rx"].stop()


async def test_d162_overlap_third_terminal_still_fires_alert(
    client, make_user, session, monkeypatch
) -> None:
    """冻死计数的下游后果：三次触发全部在途、终态逐个到——第三次仍须恰好告警。

    旧实现下三条终态全部反查落空，计数恒 0、告警永不到 3。
    """
    setup = await _setup(client, make_user, session, tag="d162alt", graph=FAIL_GRAPH)
    try:
        monkeypatch.setattr(svc, "_celery_client", lambda: _SpyCelery())
        rids = [(await svc.fire_task(setup["task_id"]))["run_id"] for _ in range(3)]
        lr = _lr(await _fresh(session, setup["task_id"]))
        assert lr["run_id"] == rids[2], "前置：last_run 只剩最后一条 fire 的 run_id"
        for rid in rids:
            await _deliver(rid)
        msgs = [r["json"]["text"] for r in setup["rx"].received]
        assert len(msgs) == 4, "三条摘要 + 第 3 次恰好一条告警，一条都不能丢：" + str(len(msgs))
        for i, rid in enumerate(rids):
            assert "/reports/" + rid in msgs[i]
        assert "连续失败 3 次" in msgs[3] and "夜间回归d162alt" in msgs[3]
        task = await _fresh(session, setup["task_id"])
        assert task.consecutive_failures == 3
        rf = _lr(task)["run_final"]
        assert rf["run_id"] == rids[2] and rf["alert_fired"] is True
        assert any(c.get("alert") for c in rf["channels"])
    finally:
        setup["rx"].stop()


async def test_d162_schedule_run_without_task_snapshot_writes_nothing(
    client, make_user, session
) -> None:
    """None 安全：trigger=schedule 但出生快照没有 schedule_task_id（旧 run/旁路 run）

    → 钩子走与「查不到任务」完全相同的路：不崩、不发、任务侧零写入（run 自身照常终态）。
    """
    from app.modules.execution.services import new_run

    setup = await _setup(client, make_user, session, tag="d162none", graph=FAIL_GRAPH)
    try:
        rec = await new_run(session, project_id=setup["pid"], subject_type="scenario",
                            subject_id=setup["sid"], subject_name="没打标的 run",
                            env_id=None, env_name=None, trigger="schedule", created_by=None)
        rid = rec.id
        await session.commit()
        await _deliver(rid)
        assert (await _run_status(session, rid)).status == "error", "旁路缺快照不许改判 run"
        assert setup["rx"].received == []
        task = await _fresh(session, setup["task_id"])
        assert task.last_run is None, "任务一行都不许被非本任务 run 的终态写脏"
        assert task.consecutive_failures == 0
        assert _run_final(task) is None
    finally:
        setup["rx"].stop()
