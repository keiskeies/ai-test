"""Celery worker（T9 / D5 兑现点）：L2 执行进程。

起法（Windows 必须 --pool=solo，prefork 不支持，前置取证 §1）：
    celery -A app.worker:celery_app worker --pool=solo -l info

两条铁律（1A 已用血换过）：
① 任务体第一步必须 create_app()：REGISTRY 在 create_app() 之前是空的（"toolbox total: 0"），
   set_perms_resolver / set_audit_writer / env_resolve / api_case_resolve 全在里面装配；
② worker 内用 asyncio.run 桥接现有 async 代码，不引入第二套同步版 DB/总线。

本模块**模块级不 import scenario**：web 侧经 send_task 按名字投递（R42），worker 侧才
需要引擎——引擎 import 全在任务体内。test_execution_worker 扫源码钉这条。
"""
from __future__ import annotations

import asyncio

from celery import Celery

from app.core.config import get_settings

_settings = get_settings()


def _beat_schedule() -> dict:
    """beat 周期：ADB 心跳默认 15s（D15：§6.4「每 15s」是死的；无系统参数行用默认）。

    留给管理诊断页加宽度的一处入口：将来系统参数「ADB心跳间隔」落库后，在这里按
    参数行覆盖，而不是散进配置各处。只起 worker 不启 beat 时该表静默（不影响普通
    任务领取），靠 `celery beat` 或 `-B` 才真正排期。
    """
    return {
        "tp.adb.heartbeat": {
            "task": "adb.heartbeat",
            "schedule": 15.0,
            "options": {"queue": _settings.task_queue},
        },
    }


celery_app = Celery("testpilot", broker=_settings.redis_url, backend=_settings.redis_url)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # D10/R118：默认队列按 env 分道（`tp.dev` / `tp.test` / `tp.e2e`…），口径与投递方
    # send_task(queue=settings.task_queue) 同源（config.Settings.task_queue 一条函数）。
    # 用 task_default_queue 而不是要求启动时加 `-Q`：手册里那条 `celery -A app.worker
    # :celery_app worker --pool=solo` 一字不改照常能用，而演示用的常驻 dev worker
    # **物理上领不到** test/e2e 投的任务——以前它们共用默认队列，谁先起谁抢（R118 实测）。
    task_default_queue=_settings.task_queue,
    # 一个 worker 一次只预取一条：solo 池本来就串行，预取多了等于把排队的 run 攥在
    # 一个可能死掉的进程手里（broker 重启后别的 worker 领不到）。
    worker_prefetch_multiplier=1,
    worker_send_task_events=False,
    timezone="UTC",
    beat_schedule=_beat_schedule(),  # ADB 心跳默认 15s（D15）；起 beat 进程才生效，不隐式炸任务
)

_booted = False


def _boot() -> None:
    """幂等装配：REGISTRY / perms resolver / audit writer / event bus。"""
    global _booted
    if _booted:
        return
    from app.core.eventbus import init_bus
    from app.main import create_app

    create_app()
    init_bus()
    _booted = True


@celery_app.task(name="scenario.run", acks_late=False)
def run_scenario_task(run_id: str, actor: dict | None = None) -> str:
    """领取并执行一个场景 run。返回值只是投递回执；真相永远以库里 run 行为准。"""
    _boot()

    async def _go() -> None:
        # bus 必须每个循环重新 init：redis-asyncio 的连接池绑死首次使用的 loop，
        # 而 solo 池每个任务一个 asyncio.run——复用全局旧 bus 会在第二个任务上炸
        # "attached to a different loop"。计划原文把 init_bus 放 _boot()，落地实测
        # 后挪进协程体内（_boot 里的 init_bus 保留：给同进程的非任务路径兜底）。
        from app.core.eventbus import init_bus
        from app.modules.scenario.orchestration import _amain

        init_bus()
        await _amain(run_id, actor=actor)

    asyncio.run(_go())
    return run_id


@celery_app.task(name="ui_case.run", acks_late=False)
def run_ui_case_task(run_id: str, actor: dict | None = None) -> str:
    """领取并执行一个 UI 用例 run（1C T9）。返回值只是投递回执；真相以库里 run 行为准。

    与 scenario.run 同款纪律：_boot() 先装配 REGISTRY，`asyncio.run` 桥接 async 执行体，
    ui_test 的 import 在协程体内（模块级 import ui_test 会破 test_worker 的结构钉与
    「web 进程不加载执行模块」的实测前提）。并发闸住在 debug_services.ui_run_gate
    （每事件循环一个——solo 池每任务一个新 loop，模块级信号量会被绑死在旧 loop 上炸掉；
    跨进程不共享，solo 下只有一个进程，默认 4 是真实默认）。
    """
    _boot()

    async def _go() -> None:
        from app.core.eventbus import init_bus
        from app.modules.ui_test.debug_services import amain_ui_run

        init_bus()  # 每循环重 init：连接池绑死首次使用的 loop（同 run_scenario_task 注释）
        await amain_ui_run(run_id, actor=actor)

    asyncio.run(_go())
    return run_id


@celery_app.task(name="adb_case.run", acks_late=False)
def run_adb_case_task(run_id: str, actor: dict | None = None) -> str:
    """领取并执行一个 ADB 用例 run（1D T7）。返回值只是投递回执；真相以库里 run 行为准。

    与 ui_case.run 同款纪律：_boot() 装配 REGISTRY 后 asyncio.run 桥接；adb_test 的
    import 在协程体内（模块级 import 会破 worker 的结构钉）。设备锁与 run 租约的续期
    都在 _execute_adb_run 的 should_cancel 边界里（每步骤 + sleep 切片），solo 池下
    一次只跑一条——跨设备的「并行」在 1D 是「多 worker 进程」的事，不是这里的。
    """
    _boot()

    async def _go() -> None:
        from app.core.eventbus import init_bus
        from app.modules.adb_test.debug_services import amain_adb_run

        init_bus()  # 每循环重 init：连接池绑死首次使用的 loop（同 run_scenario_task 注释）
        await amain_adb_run(run_id, actor=actor)

    asyncio.run(_go())
    return run_id


@celery_app.task(name="adb.heartbeat", acks_late=False)
def run_adb_heartbeat() -> int:
    """ADB 设备心跳（§6.4 每 15s + D15 默认 15s，1D T4）。

    beat_schedule 见 _beat_schedule()（15s 周期）；本任务体同样 _boot() 装配后
    asyncio.run 桥接。心跳不抛（周期任务没有「让它失败一次」的意义）：缺 adb/缺设备
    的静默跳过语义在 heartbeat.heartbeat_once 内，这里只收一个 int 回执。
    """
    _boot()

    async def _go() -> int:
        from app.modules.adb_test.heartbeat import heartbeat_once

        return await heartbeat_once()

    return asyncio.run(_go())


@celery_app.task(name="schedule.fire", acks_late=False)
def run_schedule_fire(task_id: str) -> dict:
    """定时触发（1E T1 / R142）：beats 投到点事件，这里建 run 行 + 投 scenario.run。

    零执行逻辑全在 schedule.service.fire_task（建 run + send_task + last_run 回执 +
    entry=schedule 审计，R144）；schedule 模块的 import 在任务体内——worker 模块级
    不 import schedule 是同「不 import scenario」的结构钉同款纪律（本测文件扫源码）。
    fire_task 自己不抛（失败落 last_run/审计），这里的 try 只兜装配层炸穿（DB 全断）：
    回执改写成成人话返回，solo 池不记红账——真相在库里，不在 broker 的 result 里。
    """
    _boot()

    async def _go() -> dict:
        from app.modules.schedule.service import fire_task

        return await fire_task(task_id)

    try:
        return asyncio.run(_go())
    except Exception as e:
        return {"ok": False, "reason": "触发异常：" + type(e).__name__ + ": " + str(e)[:180]}

