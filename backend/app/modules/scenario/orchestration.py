"""执行编排（T9）：enqueue 投递 / _amain 领取执行 / 取消 / 租约（R42/R43/D5 的兑现点）。

落点裁定（计划 T9「落点裁定」，6869a30）：`enqueue` 与 `_amain` 住这里，不住 execution、
也不住 worker.py：
① `_amain` 要 import `run_graph`（懂 step_graph 的东西按 R43 归 scenario），放 execution
   会当场破契约 4；
② `send_task("scenario.run", …)` 按名字投递的意义就是 web 侧不 import 引擎——若 enqueue
   住 worker.py，`scenario_run` 服务为了投递就得 import Celery 与整个引擎；
③ 引擎 import 写在 `_amain` 协程体内（见文件下半）：exec_mode=celery 的 web 进程连引擎
   模块都不会被加载，「不 import 引擎」是可实测的事实（test_execution_worker 扫源码钉）。

inline 与 celery 跑的是同一份 `run_graph`（R42）：差别只在谁起协程。inline 的协程句柄
必须持住强引用（`_PENDING`）——asyncio 只持弱引用，裸 create_task 的任务可能被 GC 掉，
那是「提交后无声无息」最难查的一种死法。

celery 档的诚实承诺（R42）：先探 broker 再落 run 行——投不出去就 503，绝不留下
「永远 queued 的孤儿 run」，也绝不静默降级成 inline。

actor 快照：计划原文写「_amain 传 actor={owner 快照}」。落码改为**由 enqueue 的调用方
携带**（T11 的 scenario_run 有真 ctx；owner 快照需要查 IAM 权限，而 scenario import iam
破契约 1）：谁触发、以谁的身份跑，本来就该由触发点说了算。None 表示系统触发
（1B 尚无定时/webhook 入口）：runner 按「缺身份」降级 env/api 层，语义不变。
"""
from __future__ import annotations

import asyncio
import os
import socket
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.eventbus import get_bus
from app.modules.execution.services import new_run

# inline 协程的强引用容器：见模块 docstring（asyncio 弱引用陷阱）
_PENDING: set[asyncio.Task] = set()

TERMINAL = ("passed", "failed", "error", "cancelled")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _task_session():
    """一次执行一副 NullPool 引擎：连接绝不跨 asyncio.run 活命。

    不用 app.core.db 的全局 sessionmaker：asyncmy 连接绑死在创建它的事件循环上，
    而 worker（solo 池每个任务一个 asyncio.run）与 pytest（每用例一个新循环）都会
    在任务之间换循环——池里那根「上辈子」的连接一碰就是 "attached to a different
    loop"。NullPool 用完即弃 + 显式 dispose，代价每 run 多建一次连接，换来的是
    「执行协程在哪起、怎么起」都不影响它连得上库。
    """
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    return eng, async_sessionmaker(bind=eng, expire_on_commit=False, autoflush=False,
                                   class_=AsyncSession)


def _clean_actor(actor: Mapping | None) -> dict | None:
    """身份快照转 JSON 原生：set 进不了 Celery 的 json 序列化，也不该进。"""
    if not actor:
        return None
    out: dict[str, Any] = {}
    for k, v in dict(actor).items():
        out[k] = sorted(str(x) for x in v) if isinstance(v, (set, frozenset)) else v
    return out


RUN_TASK_NAME = "scenario.run"


def _celery_client():
    """按名字投递用的惰性 Celery 客户端（不 import app.worker）。

    为什么不复用 app.worker.celery_app：import 它等于把 app.main → agent.routes 整条链
    拖进 web 请求路径（lint-imports 契约 3 当场抓到：scenario 经 app.worker 反依赖 agent）。
    send_task 按名字投递的意义就在这：web 侧只需要 broker URL 与任务名。broker URL 每次
    现取——测试 monkeypatch settings 后不许再吃到 import 时烘焙的旧连接。

    队列名同理**不烘焙**：投递方与消费方各自从 settings.task_queue 推导（D10/R118），
    所以 monkeypatch 了 env 的测试投出去的任务，物理上不会落在演示 worker 的队列里。
    """
    from celery import Celery

    s = get_settings()
    c = Celery("testpilot-enqueue", broker=s.redis_url, backend=s.redis_url)
    c.conf.update(task_serializer="json", accept_content=["json"],
                  broker_transport_options={"max_retries": 0})
    return c


async def _broker_alive() -> bool:
    """探一次 broker（不排队不重试）：broker 连不上与 worker 没起在 1B 同一处理——
    都是「现在没人能跑」，同一个 503 文案足以指路。

    探针直接用 kombu（Celery 自带依赖）连 settings.redis_url，而不是 celery_app 的
    connection：celery_app 的 broker 是模块 import 时烘焙的，探针必须跟着**当前**
    配置走，测试才能换 URL 验「不可达 → 503」。生产里两者同源（settings 是 lru_cache
    的单例），不存在探针与投递连不同 broker 的窗口。
    这是同步 socket 探针，放在 async 端点里是一次受 timeout=2s 约束的阻塞——1B 接受，
    换来的是「投不出去的 run 根本不会被建出来」。
    """
    from kombu import Connection

    try:
        with Connection(get_settings().redis_url) as conn:
            conn.ensure_connection(max_retries=0, timeout=2)
    except Exception:
        return False
    return True


async def enqueue(db: Any, *, project_id: str, subject_id: str, subject_name: str,
                  trigger: str, created_by: str | None, env_id: str | None = None,
                  env_name: str | None = None, max_runtime_ms: int | None = None,
                  actor: Mapping | None = None, transport: Any = None,
                  bus: Any = None, request_snapshot: dict | None = None) -> Any:
    """建 queued run 行并投递。返回 RunRecord（status=queued：投递不等于执行完成）。

    顺序刻意是「先探 broker → 再落行 → 再 send」：投不出去就不该留下永远 queued 的孤儿
    run 行（用户会在列表里看见一个谁也不会去跑的 run，比当场 503 坏得多）。
    send 万一还是失败（探完活后 broker 恰死）：删行后 503，同样不留孤儿。
    """
    mode = get_settings().exec_mode
    if mode == "celery" and not await _broker_alive():
        raise ApiError("executor_unavailable",
                       "执行器不可用：worker 未启动或 broker 不可达。启动命令："
                       "celery -A app.worker:celery_app worker --pool=solo（R42：不静默降级）",
                       503)
    rec = await new_run(db, project_id=project_id, subject_type="scenario",
                        subject_id=subject_id, subject_name=subject_name, env_id=env_id,
                        env_name=env_name, trigger=trigger, created_by=created_by,
                        max_runtime_ms=max_runtime_ms, request_snapshot=request_snapshot)
    await db.commit()
    if mode == "celery":
        try:
            _celery_client().send_task(RUN_TASK_NAME, args=[rec.id, _clean_actor(actor)],
                                       task_id=rec.id, queue=get_settings().task_queue)
        except Exception as e:
            await db.delete(rec)  # 行是这次调用建的，删它不伤任何人
            await db.commit()
            raise ApiError("executor_unavailable",
                           "任务投递失败（broker 不可达）：worker 未启动？" + str(e)[:120],
                           503) from e
    else:
        task = asyncio.create_task(_amain(rec.id, actor=actor, transport=transport,
                                          bus=bus if bus is not None else get_bus()))
        _PENDING.add(task)
        task.add_done_callback(_PENDING.discard)
    return rec


def _worker_owner() -> str:
    """租约持有人的可辨识名：崩溃排查时「被谁持有」是唯一可观察证据（R61）。"""
    return "worker-" + socket.gethostname() + "-" + str(os.getpid())


async def _amain(run_id: str, *, actor: Mapping | None = None, transport: Any = None,
                 bus: Any = None) -> None:
    """领取并执行一个 run：租约 → running → run_graph → run_end → 回写 → 释放租约。

    幂等：非 queued 直接退出（重复投递不双跑，T11 判据⑥）。抢不到租约（已有他人持有）
    同样直接退出——僵尸 worker 不能靠复活后继续霸着 run（R61 同源）。
    """
    # 引擎 import 全在协程体内（_run_claimed）：这是「web 进程不加载引擎」的实测前提
    # （模块 docstring ③）。本函数只碰 core 层。
    if bus is None:
        bus = get_bus()
    owner = _worker_owner()
    eng, maker = _task_session()
    try:
        await _run_claimed(maker, run_id, owner=owner, actor=actor,
                           transport=transport, bus=bus)
    finally:
        await eng.dispose()  # NullPool：不 dispose 会把连接泄漏在每个任务的循环里


async def _run_claimed(maker: Any, run_id: str, *, owner: str,
                       actor: Mapping | None, transport: Any, bus: Any) -> None:
    from app.modules.execution.models import RunRecord
    from app.modules.scenario.engine.events import publish, release_lease, renew_lease
    from app.modules.scenario.engine.runner import run_graph
    from app.modules.scenario.models import STATUS_NORMAL, Scenario

    async with maker() as db:
        rec = await db.get(RunRecord, run_id)
        if rec is None or rec.status != "queued":
            return
        # 执行蓝本（T11 裁定①）：debug 跑入队时的 request_snapshot，连场景行都不读——
        # 未保存的图也许可 debug，且「执行了什么」以入队快照为准（行可能已被改/删）。
        # manual 等真执行仍读 scenario.step_graph（场景缺失 → error，诚实失败）。
        snap = rec.request_snapshot if isinstance(rec.request_snapshot, Mapping) else None
        if rec.trigger == "debug":
            if not snap or not isinstance(snap.get("graph"), Mapping | list):
                rec.status = "error"
                rec.error = "debug 运行缺少入队时的图快照，无法执行"
                rec.finished_at = _now()
                await db.commit()
                await publish(db, run_id, "run_end", {"status": "error",
                                                      "message": rec.error}, bus=bus)
                return
            scen = await db.get(Scenario, rec.subject_id) if rec.subject_type == "scenario" else None
            graph = snap["graph"]
            variables = dict(snap.get("variables") or {})
            fail_fast = bool(snap.get("fail_fast", True if scen is None else scen.fail_fast))
            # T20b：公共断言与 fail_fast 同路——入队时已解析进快照（草稿优先、缺省继承
            # 保存行），这里只读快照，与裁定①「执行了什么以入队快照为准」同源。
            # 键缺失 = 部署前的旧快照：与 fail_fast 同款回落保存行。
            _ca = (snap.get("common_assertions") if "common_assertions" in snap
                   else (scen.common_assertions if scen is not None else None))
            common_assertions = list(_ca or [])
            sc_env_id = scen.env_id if scen is not None and scen.status == STATUS_NORMAL else None
            max_runtime = int(snap.get("max_runtime_ms")
                              or (scen.max_runtime_ms if scen else 0)
                              or get_settings().max_runtime_default_ms)
        else:
            scen = await db.get(Scenario, rec.subject_id) if rec.subject_type == "scenario" else None
            if scen is None or scen.status != STATUS_NORMAL:
                rec.status = "error"
                rec.error = "场景不存在或已被删除，无法执行"
                rec.finished_at = _now()
                await db.commit()
                await publish(db, run_id, "run_end", {"status": "error",
                                                      "message": rec.error}, bus=bus)
                return
            graph = scen.step_graph
            variables = dict(scen.variables or {})
            fail_fast = bool(scen.fail_fast)
            common_assertions = list(scen.common_assertions or [])
            sc_env_id = scen.env_id
            max_runtime = int(scen.max_runtime_ms or get_settings().max_runtime_default_ms)
        if not await renew_lease(bus, run_id, owner):
            return  # 已有他人持有：不双跑
        stats: dict[str, Any]
        try:
            rec.status = "running"
            rec.started_at = _now()
            rec.lease_owner = owner
            await db.commit()
            stats = await run_graph(
                db, project_id=rec.project_id, run_id=run_id, graph=graph,
                env_id=sc_env_id, fail_fast=fail_fast,
                max_runtime_ms=max_runtime,
                transport=transport, variables=variables, actor=actor, bus=bus,
                common_assertions=common_assertions)
        except Exception as e:  # noqa: BLE001 引擎炸穿也要出完整结论：run 不能永远 running
            rec = await db.get(RunRecord, run_id)
            if rec is not None:
                rec.status = "error"
                rec.error = ("执行异常：" + type(e).__name__ + ": " + str(e))[:300]
                rec.finished_at = _now()
                await db.commit()
            stats = {"status": "error", "message": str(e)[:280]}
        finally:
            await release_lease(bus, run_id, owner)
        status = str(stats.get("status") or "error")
        await publish(db, run_id, "run_end", {"status": status,
                                              "stats": {k: v for k, v in stats.items()
                                                        if k != "message"}}, bus=bus)
        # 终态回写场景冗余列（T10 列表页「最近结果」的数据源，不 N+1 查 run_record）。
        # debug 不回写（T11 裁定①）：调试是过程不是结论，「最近结果」只认真执行。
        if status in TERMINAL and rec is not None and rec.trigger != "debug":
            s2 = await db.get(Scenario, rec.subject_id) if rec is not None else None
            if s2 is not None:
                s2.last_run_at = _now()
                s2.last_run_status = status
                await db.commit()


__all__ = ["TERMINAL", "enqueue"]
