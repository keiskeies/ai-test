"""seed_demo 1E 段回归（通知渠道 + 定时任务，README-1e-demo.md 的数据面）。

钉三件事（形状对偶 test_tool_surface_1c 的种子用例）：
  ① 纯函数形状：1E 段函数存在、cron 先过 cron.py 的 5 段闸（不落库就该红）、
     hook URL 指本机回环（真钉钉/飞书绝不进种子）、env TP_DEMO_HOOK_URL 可覆盖；
  ② seed 跑两遍：渠道恰好 1 条、定时恰好 1 条，且第二遍不多一行（幂等承诺）；
  ③ 挂接关系诚实：subject 指到种下的演示场景、notify_channel_ids 指到种下的渠道，
     渠道 url 解密后就是 DEMO_HOOK_URL（D24 加密形状过一遍真实落库）。

第二遍读之前必须 rollback——REPEATABLE-READ 下不结束读事务，看到的是旧快照，
「没重复建」会被假证明（test_tool_surface_1c.py 同款记账）。
"""
from __future__ import annotations


def _load_seed():
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
    spec = importlib.util.spec_from_file_location("seed_demo_1e", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_seed_demo_1e_shape() -> None:
    mod = _load_seed()
    assert callable(mod._seed_schedule_notify_via_services)
    assert mod.DEMO_NOTIFY_CHANNEL and mod.DEMO_SCHEDULE_TASK
    # cron 必须在纯函数层就过 5 段闸（service._check_cron 读的就是这把尺）——
    # 种子里写错段数，这里先红，而不是等 seed 实跑撞 422
    from app.modules.schedule.cron import crontab_of

    crontab_of(mod.DEMO_SCHEDULE_CRON)
    # 假接收端只许指本机回环（纪律 1：种子不向外部真发流量）
    assert mod.DEMO_HOOK_URL.startswith("http://127.0.0.1"), mod.DEMO_HOOK_URL


def test_seed_demo_hook_url_env_override(monkeypatch) -> None:
    """URL 由 env 覆盖：换机器/换端口演示不改代码（任务书的显式要求）。"""
    monkeypatch.setenv("TP_DEMO_HOOK_URL", "http://127.0.0.1:12345/hook")
    assert _load_seed().DEMO_HOOK_URL == "http://127.0.0.1:12345/hook"


async def test_seed_demo_schedule_notify_idempotent(client, make_user, session) -> None:
    """seed 跑两遍：演示渠道恰好 1 条、演示定时恰好 1 条，第二遍不多一行。

    跑在测试库（conftest 已把 TP_DB_URL 指到本轮 schema；seed 用全局 maker）。
    1E 的两张表（schedule_task/notify_channel）在测试库由 alembic head 建出——
    demo 库（:3306/testpilot）没升到 head、缺这两张表，故本用例只活在测试库。
    """
    from sqlalchemy import func, select

    from app.modules.iam.models import Project
    from app.modules.notify.models import NotifyChannel
    from app.modules.notify.senders import decrypt_config
    from app.modules.scenario.models import Scenario
    from app.modules.schedule.models import ScheduleTask

    mod = _load_seed()
    assert await mod.main() == 0
    await session.rollback()  # seed 在另一条连接上 commit：不结束读事务看到的是旧快照

    pid = (await session.execute(select(Project.id).where(
        Project.name == mod.DEMO_PROJECT))).scalar_one()
    tasks = (await session.execute(select(ScheduleTask).where(
        ScheduleTask.project_id == pid))).scalars().all()
    assert len(tasks) == 1, "第一遍应建且仅建一条演示定时，实际 " + str(len(tasks))
    t = tasks[0]
    # 标量先取：后面 rollback 会过期 ORM 实例，再碰属性就是 MissingGreenlet
    assert t.name == mod.DEMO_SCHEDULE_TASK and t.cron == mod.DEMO_SCHEDULE_CRON
    assert t.subject_type == "scenario" and t.enabled == 1
    t_id, subject_id, ch_ids = t.id, t.subject_id, list(t.notify_channel_ids)

    scn_id = (await session.execute(select(Scenario.id).where(
        Scenario.project_id == pid, Scenario.name == mod.DEMO_SCENARIO))).scalar_one()
    assert subject_id == scn_id, "定时必须挂到种下的演示场景上（手册的『能跑』靠这条链）"

    chans = (await session.execute(select(NotifyChannel).where(
        NotifyChannel.name == mod.DEMO_NOTIFY_CHANNEL))).scalars().all()
    assert len(chans) == 1, "演示渠道恰好一条（name 全局唯一，重名会被 create 409）"
    ch = chans[0]
    assert ch.type == "WEBHOOK"
    assert ch_ids == [ch.id], "notify_channel_ids 应指到种下的那条渠道"
    assert decrypt_config(dict(ch.config or {})).get("url") == mod.DEMO_HOOK_URL

    n_task = await session.scalar(select(func.count()).select_from(ScheduleTask))
    n_ch = await session.scalar(select(func.count()).select_from(NotifyChannel))

    await session.rollback()
    assert await mod.main() == 0
    await session.rollback()
    assert await session.scalar(select(func.count()).select_from(ScheduleTask)) == n_task, \
        "第二遍不许重复建定时任务（幂等承诺）"
    assert await session.scalar(select(func.count()).select_from(NotifyChannel)) == n_ch, \
        "第二遍不许重复建渠道（幂等承诺）"
    # 只回 id 标量：identity map 会把命中行返回成已过期的旧实例，碰它就是 MissingGreenlet
    ids = (await session.execute(select(ScheduleTask.id).where(
        ScheduleTask.name == mod.DEMO_SCHEDULE_TASK))).scalars().all()
    assert len(ids) == 1 and ids[0] == t_id
