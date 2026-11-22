"""1E T1：DbScheduler 读表调度核（R142）——真 beat 进程不进 CI（同 emulator 条款），
但 get_schedule 本身走**真库往返**（NullPool + 线程内新 loop，pytest 宿主可跑）：
「增删改即时可见」钉的是那条真 SQL，不是打桩后的想象。

钉的四条（计划 T1 点名）：
- get_schedule 每次现读：插行/停用/改 cron/删行 → 下一次调用即反映；
- 单行坏 cron（绕过服务面直写库的历史数据）→ 跳过该行、别的行照常（同心跳的静默哲学）；
- DB 读失败 → 返回上次快照且不抛（打桩 _load_entries 制造「库挂」——真断库没法 hermetic）；
- 同名同 cron 的条目复用旧 Entry：基类 tick 每轮经 schedule 属性调 get_schedule，
  全新 Entry 会把 last_run_at/total_run_count 抹平（触发计数永远归零的静默死法）。
"""
from __future__ import annotations

import pytest

import app.beat as beat_mod
from app.beat import DbScheduler


@pytest.fixture()
def sched():
    return DbScheduler(app=beat_mod.celery_app, lazy=True)


async def _mk(session, pid: str, cron: str, *, enabled: int = 1) -> str:
    from app.modules.schedule.models import ScheduleTask

    row = ScheduleTask(project_id=pid, name="t-" + cron.replace(" ", "_"),
                       subject_type="scenario", subject_id="s1", cron=cron, enabled=enabled)
    session.add(row)
    await session.commit()
    return row.id


async def test_get_schedule_reflects_insert_disable_edit_delete(session, sched) -> None:
    """真库往返：行变了，下一次 get_schedule 就是新答案（R142 的全部意义）。"""
    # 空表 → 空 dict 且快照机制不报错（自 1e 去重并入）
    assert await beat_mod._load_entries() == {}
    pid = "beat_pid"
    t1 = await _mk(session, pid, "0 2 * * *")
    data = sched.get_schedule()
    assert list(data) == ["schedule:" + t1]
    e = data["schedule:" + t1]
    assert e.task == "schedule.fire" and e.args == [t1]  # 按行 id 投递（改名不炸排期）
    assert str(e.schedule) == "<crontab: 0 2 * * * (m/h/dM/MY/d)>"  # 渲染格式钉（1e 并入）
    assert e.options.get("queue") == beat_mod._settings.task_queue  # R118：落对队列

    # 插一行 → 即见
    t2 = await _mk(session, pid, "*/5 * * * *")
    assert sorted(sched.get_schedule()) == sorted(["schedule:" + t1, "schedule:" + t2])

    # 停用 → 即消失（enabled 是读表 SQL 的 WHERE）
    from app.modules.schedule.models import ScheduleTask

    row = await session.get(ScheduleTask, t2)
    row.enabled = 0
    await session.commit()
    assert list(sched.get_schedule()) == ["schedule:" + t1]

    # 改 cron → 条目换血（渲染串变了且格式原样，beat 会重算下次触发；精确等式自 1e 并入）
    row = await session.get(ScheduleTask, t1)
    row.cron = "30 3 * * *"
    await session.commit()
    session.expire_all()
    assert str(sched.get_schedule()["schedule:" + t1].schedule) == \
        "<crontab: 30 3 * * * (m/h/dM/MY/d)>"

    # 删行 → 条目即刻消失
    await session.delete(row)
    await session.commit()
    assert sched.get_schedule() == {}


async def test_bad_cron_row_skipped_others_survive(session, sched) -> None:
    """绕过服务面直写库的坏 cron：跳过它、别的行照常——一行坏不拖死全场。"""
    bad = await _mk(session, "beat_bad", "0 2 * *")      # 4 段（服务面进不来，直写能进）
    await _mk(session, "beat_bad", "0 2 * * *")          # 好行
    data = sched.get_schedule()
    assert list(data) == [k for k in data if not k.endswith(bad)]
    assert len(data) == 1


async def test_db_failure_returns_previous_snapshot_no_raise(sched, monkeypatch) -> None:
    """DB 挂了吃旧快照（beat 不许炸）；首轮就挂 → 空起步同样不抛；恢复后回到真相。"""
    calls = {"n": 0}

    async def flaky() -> dict:  # _load_entries 是协程函数——桩也必须是（_run_sync 的契约）
        calls["n"] += 1
        if calls["n"] == 1:
            return {"schedule:t1": {"task": "schedule.fire", "args": ["t1"],
                                    "schedule": 10.0}}
        raise RuntimeError("DB 连不上（模拟）")  # 第 2、3 次连挂——重复挂也不许抛/不许换脸

    monkeypatch.setattr(beat_mod, "_load_entries", flaky)
    before = dict(sched.get_schedule())
    assert list(before) == ["schedule:t1"]

    after = sched.get_schedule()  # 不许抛
    assert list(after) == ["schedule:t1"]
    assert after["schedule:t1"] is before["schedule:t1"]  # 连 Entry 都是原来那颗
    after2 = sched.get_schedule()  # 第二次失败：仍吃同一颗快照（自 1e「不重复吼」并入）
    assert after2["schedule:t1"] is before["schedule:t1"]

    # 恢复：坏一轮不永久
    async def recovered() -> dict:
        return {"schedule:t1": {"task": "schedule.fire", "args": ["t1"], "schedule": 10.0},
                "schedule:t9": {"task": "schedule.fire", "args": ["t9"], "schedule": 11.0}}

    monkeypatch.setattr(beat_mod, "_load_entries", recovered)
    assert sorted(sched.get_schedule()) == ["schedule:t1", "schedule:t9"]


def test_first_round_db_failure_starts_empty(monkeypatch) -> None:
    s2 = DbScheduler(app=beat_mod.celery_app, lazy=True)  # 新实例：没有「上次」可吃

    async def boom() -> dict:
        raise RuntimeError("库没起")

    monkeypatch.setattr(beat_mod, "_load_entries", boom)
    assert s2.get_schedule() == {}  # 空起步、不抛——beat 下一轮再试


async def test_unchanged_row_keeps_entry_object_progress(session, sched) -> None:
    """同名同 cron 必须复用 Entry：基类每轮 tick 都调 get_schedule，换对象=计数归零。"""
    t = await _mk(session, "beat_keep", "0 2 * * *")
    first = sched.get_schedule()["schedule:" + t]
    first.total_run_count = 7  # 模拟已投过 7 次
    again = sched.get_schedule()["schedule:" + t]
    assert again is first and again.total_run_count == 7


def test_add_remove_are_noops_and_setup_installs_heartbeat() -> None:
    """R142：运行时注入通道关死（排期唯一来源=库表）；起 beat 时 ADB 心跳照装——
    本 beat 是 app 唯一的 beat，不装它心跳静默停摆。"""
    s = DbScheduler(app=beat_mod.celery_app, lazy=True)
    assert s.add(name="x", task="y", schedule=10.0) is None
    assert "x" not in s.schedule
    assert s.remove("anything") is None
    # remove 也休想动真实数据（自 1e 的 add/remove no-op 断言强度）
    s.schedule["keep"] = object()  # type: ignore[assignment]
    assert s.remove("keep") is None and "keep" in s.schedule
    s.setup_schedule()
    assert "tp.adb.heartbeat" in s.schedule


def test_beat_module_wiring() -> None:
    """`celery -A app.beat beat` 的两个入口事实：beat_scheduler 指路牌立在模块配置上
    （不写它起的是原生 Scheduler——读不到表、静默空班）；服务注册面不进 beat 进程。"""
    assert beat_mod.celery_app.conf.beat_scheduler == "app.beat.DbScheduler"
    assert beat_mod.celery_app.conf.task_default_queue == beat_mod._settings.task_queue
    src = open(beat_mod.__file__, encoding="utf-8").read()
    top = [ln for ln in src.splitlines() if ln.startswith(("import ", "from "))]
    assert not any("app.main" in ln or "service" in ln or "app.worker" in ln for ln in top), \
        "beat 模块级不加载服务面/worker（fire 归 worker，读表只认 cron 助手与模型）"
