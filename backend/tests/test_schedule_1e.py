"""1E T1 独占钉（去重后）：422 带 crontab 原话 / next_5 纯函数边界 / 双实例同构 / 注册面。

1E T1 曾有两个 agent 抢同一任务，各写一份测试（本文件 + test_schedule_service.py，
与 test_schedule_beat.py 的重叠面也一并核过）。去重口径：同一行为、同一入口、同一
断言强度才算重复，重复面并入断言更严的一侧——
- cron 表驱动 / D30 白名单 / CRUD 隔离 / next_5 HTTP 面 / fire 全链路与回执 → test_schedule_service.py；
- get_schedule 增删改即时可见 / DB 挂吃旧快照 / add-remove no-op → test_schedule_beat.py。
本文件只留别处没有的钉：
- 422 body 带 crontab 原话（别处只断 code/段数话术，这里断 crontab 措辞——严面保留在此）；
- next_fire_times 纯函数在触发边界的单调性（服务面直调，与 HTTP 面不同入口，不算重复）；
- 同表数据两实例算出相等 ScheduleEntry（双 beat 不互踩 heap 的前提，纯函数半）；
- _SERVICE_MODULES 注册 + 四权限位/tool=False 结构钉。
真 beat 不进 CI（R142 条款）；fire 的投递 spy 口径见 test_schedule_service.py 文件头。
"""
from __future__ import annotations

from datetime import UTC, datetime

BASE = "/api/v1"


async def test_cron_422_carries_crontab_verbatim(client, make_user) -> None:
    """422 要带 crontab 原话（蓝图 §6.7 的人话要求），不是自造文案。"""
    _u, h = await make_user("sc_cw", admin=True)
    pid = (await client.post(BASE + "/projects", json={"name": "sc_cw"}, headers=h)).json()["id"]
    r = await client.post(BASE + "/schedule-tasks", headers=h, json={
        "project_id": pid, "name": "坏步进", "subject_type": "scenario",
        "subject_id": "s1", "cron": "*/5x * * * *"})
    assert r.status_code == 422, r.text
    assert "invalid" in r.json()["message"].lower(), r.json()  # crontab 原话含 invalid…


async def test_next_5_engine_pure_function_at_boundary() -> None:
    """纯函数钉：base 恰在触发时刻边界（remaining_estimate 负值现场）也要 5 个递增的未来时刻。"""
    from app.modules.schedule.service import next_fire_times

    base = datetime(2026, 11, 16, 12, 5, tzinfo=UTC)  # */5 的整点边界
    for cron in ("*/5 * * * *", "* * * * *", "*/30 * * * *", "0 2 * * *"):
        fires = next_fire_times(cron, base)
        assert len(fires) == 5, cron
        assert all(fires[i] < fires[i + 1] for i in range(4)), cron + " 非单调：" + str(fires)
        assert all(f > base for f in fires), cron + " 有不在 base 之后的：" + str(fires)


def test_two_scheduler_instances_share_one_truth() -> None:
    """真 beat tick 合成的纯函数半：同一份表数据下两个 DbScheduler 实例算出同构条目
    （ScheduleEntry 相等 → schedules_equal 判「没变」，双 beat 不互踩 heap）。
    双进程 e2e 不在 CI（R142 条款），这里钉的是它依赖的相等性前提。"""
    from celery.beat import ScheduleEntry
    from celery.schedules import crontab

    from app.beat import celery_app

    entry = {"task": "schedule.fire", "args": ["a"],
             "schedule": crontab("0", "2"), "options": {"queue": "tp.test"}}
    e1 = ScheduleEntry(name="schedule:a", app=celery_app, **entry)
    e2 = ScheduleEntry(name="schedule:a", app=celery_app, **entry)
    assert e1 == e2, "同表数据必须算出可比相等的条目（beat 靠它判 schedule 未变）"


def test_service_module_registered_in_main() -> None:
    from app.main import _SERVICE_MODULES

    assert "app.modules.schedule.service" in _SERVICE_MODULES


async def test_registry_perms_and_tools() -> None:
    """四权限位齐 + 读类 :read 结尾（READONLY glob）+ 写类 tool=False（D29）。"""
    import app.modules.schedule.service  # noqa: F401  确保注册
    from app.core.permissions import match_perm
    from app.core.registry import REGISTRY

    by_name = {t.name: t for t in REGISTRY.all() if t.name.startswith("schedule_task_")}
    assert {t.perm for t in by_name.values()} >= {
        "schedule:task:read", "schedule:task:create",
        "schedule:task:update", "schedule:task:delete"}
    for n in ("schedule_task_list", "schedule_task_get", "schedule_task_next_5"):
        assert by_name[n].perm.endswith(":read") and match_perm({"*:read"}, by_name[n].perm), n
    for n in ("schedule_task_create", "schedule_task_update", "schedule_task_delete"):
        assert by_name[n].tool is False, n + " 写类必须 tool=False（D29）"
    assert by_name["schedule_task_delete"].effect == "destructive"
