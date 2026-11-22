"""1B T9：执行编排 —— enqueue / worker 任务 / 取消 / 租约（D5 兑现点）。

计划 Step 1 的四条可自动化断言 + 两条钉桩：
  ① exec_mode=inline 端到端出终态（inline 跑的是同一份引擎，差别只在谁起协程）；
  ② exec_mode=celery + 连不上的 broker → 503 executor_unavailable，消息指向 worker 未启动，
     且不静默降级、也不留下「投不出去却已入库」的孤儿 run（先探 broker 再落 run 行）；
  ③ cancel：sleep 中途置位 → run=cancelled，sleep 步在取消后 ≤600ms 结束，已完成步骤明细仍在；
  ④ 租约失效（进程中断）：查询详情时发现 run.lease 键没了 → 标 error「执行进程中断」；
  ⑤ 真 worker 冒烟不在本文件（要起子进程），那是 scripts/verify_worker.py，输出贴 ledger；
  ⑥ 跨模块键名（execution 不能 import scenario）→ 字符串相等测试钉两处必须同步改；
  ⑦ 词表：run/report 列表的 status 过滤器必须认 queued/running/cancelled（T9 起库里真会写）。

手法：fakeredis 注入全局 bus（run_get 的租约判定走 get_bus()，必须 hermetic）；
inline 用 transport 打内存靶（不依赖网络）；celery 档只验「不可达 → 503」，
真投递由 verify_worker.py 用真 Redis 验（CI 不起 worker，见 T25）。
"""
from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.eventbus import init_bus
from app.modules.execution.models import RunEvent, RunRecord, RunStepResult
from app.modules.scenario.engine.events import lease_key, renew_lease
from app.modules.scenario.graph import validate

target = FastAPI()
_hits: list[str] = []


@target.get("/ping")
async def ping():
    _hits.append("ping")
    return JSONResponse({"pong": True})


TR = ASGITransport(app=target)
BASE = "http://tp-target"


@pytest.fixture(autouse=True)
def _reset_hits():
    _hits.clear()
    yield
    _hits.clear()


@pytest.fixture()
def fake_bus():
    """全局 bus 指向 fakeredis：enqueue/_amain/run_get 都经 get_bus()，测试必须换掉真 Redis。"""
    bus = init_bus(client=FakeAsyncRedis(decode_responses=True))
    return bus


@pytest.fixture()
def inline_mode(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "exec_mode", "inline", raising=False)
    return s


@pytest.fixture()
def celery_dead_broker(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "exec_mode", "celery", raising=False)
    # 端口 1 无监听：连接拒绝是即时错误，不会让测试等重试
    monkeypatch.setattr(s, "redis_url", "redis://127.0.0.1:1/0", raising=False)
    return s


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _node(key, kind, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": None, "config": {}, "children": []}
    n.update(extra)
    return n


async def _scenario(session, client, make_user, tag: str, graph: dict, **kw):
    """真 client 造项目 + 场景（scenario_create 走真校验，不绕 API 造脏数据）。"""
    u, h = await make_user("t9" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t9p" + tag},
                             headers=h)).json()["id"]
    body = {"project_id": pid, "name": "场景" + tag, "step_graph": graph, **kw}
    sid = (await client.post("/api/v1/scenarios", headers=h, json=body)).json()["id"]
    return u, h, pid, sid


async def _wait_terminal(session, run_id: str, timeout: float = 20.0) -> RunRecord:
    """轮询到终态（enqueue 是异步投递，inline 也是后台协程——轮询本身就是在验「不假同步」）。

    终态可见（run_graph 的 commit）之后还要等 run_end 事件：_amain 是在 commit **之后**
    才补发 run_end 的，先看见 passed 再看见 run_end 是正常时序，不是 bug。
    """
    t0 = time.perf_counter()
    while True:
        await session.rollback()  # 开新事务才能看见 _amain 独立连接提交的行
        rec = await session.get(RunRecord, run_id)
        await session.refresh(rec)
        if rec.status in ("passed", "failed", "error", "cancelled"):
            n = await session.scalar(select(func.count()).select_from(RunEvent)
                                     .where(RunEvent.run_id == run_id,
                                            RunEvent.type == "run_end"))
            if n:
                return rec
        if time.perf_counter() - t0 > timeout:
            raise AssertionError("run 未在 " + str(timeout) + "s 内进入终态+run_end："
                                 + rec.status)
        await asyncio.sleep(0.05)


# —— ① inline 端到端：queued → running → 终态，步骤/事件/回写齐全 ——————


async def test_inline_enqueue_runs_same_engine_end_to_end(session, client, make_user,
                                                          inline_mode, fake_bus) -> None:
    from app.modules.scenario.orchestration import enqueue

    g = _graph(_node("s1", "set_var", config={"vars": {"a": "1"}}),
               _node("s2", "http_direct", config={"url": BASE + "/ping", "method": "GET"}))
    assert validate(g) == []
    u, _h, pid, sid = await _scenario(session, client, make_user, "a", g,
                                      variables={"x": "1"})
    rec = await enqueue(session, project_id=pid, subject_id=sid, subject_name="场景a",
                        trigger="manual", created_by=u.id,
                        bus=fake_bus, transport=TR)
    assert rec.status == "queued", "enqueue 只投递不执行：返回时必须是 queued"
    done = await _wait_terminal(session, rec.id)
    assert done.status == "passed", (done.status, done.error)
    assert done.started_at is not None and done.finished_at is not None
    assert done.stats and done.stats["pass"] == 2
    assert _hits == ["ping"], "inline 跑的是同一份引擎：请求真的发出去了"
    steps = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == rec.id)
        .order_by(RunStepResult.step_key))).scalars().all()
    assert [s.status for s in steps] == ["pass", "pass"]
    evs = (await session.execute(
        select(RunEvent).where(RunEvent.run_id == rec.id).order_by(RunEvent.seq)
    )).scalars().all()
    types = [e.type for e in evs]
    assert types[-1] == "run_end", "run_end 是 SSE 停流信号，必须由编排层补发"
    assert types.count("step/pass") == 2
    # T10 列表页的「最近结果」冗余列：终态必须回写。
    # **必须轮询且每轮 rollback**：回写排在 run_end 发布之后（_run_claimed 的刻意顺序），
    # 而库是 REPEATABLE-READ（实测 @@transaction_isolation）——事务快照在首次 SELECT 定死，
    # 此后 refresh 只会被同一份快照答同一个旧值。这里的「rollback 一次 + get」看着像开了
    # 新事务，其实 _wait_terminal 早已在本事务里 SELECT 过，快照早冻结，rollback 后只读到
    # 回写**之前**的状态：单跑能过纯属时序运气，满载必红。同法见 test_scenario_run ①。
    from app.modules.scenario.models import Scenario

    t0 = time.perf_counter()
    while True:
        await session.rollback()
        sc = await session.get(Scenario, sid)
        await session.refresh(sc)
        if sc.last_run_status is not None or time.perf_counter() - t0 > 10:
            break
        await asyncio.sleep(0.05)
    assert sc.last_run_status == "passed" and sc.last_run_at is not None


async def test_inline_missing_scenario_marks_error(session, client, make_user,
                                                   inline_mode, fake_bus) -> None:
    """场景没了再投递：执行不得假装成功，run 落 error 且说清原因。

    先删后投（而不是投完删）：_amain 是后台协程，删与读的顺序不确定；
    这条测的是 _amain 的「场景缺失」防御分支，不需要再造投递竞态的轮子。
    """
    from app.modules.scenario.orchestration import enqueue

    g = _graph(_node("s1", "set_var", config={"vars": {"a": "1"}}))
    u, _h, pid, sid = await _scenario(session, client, make_user, "gone", g)
    from app.modules.scenario.models import Scenario

    s = await session.get(Scenario, sid)
    await session.delete(s)
    await session.commit()
    rec = await enqueue(session, project_id=pid, subject_id=sid, subject_name="gone",
                        trigger="manual", created_by=u.id, bus=fake_bus, transport=TR)
    done = await _wait_terminal(session, rec.id)
    assert done.status == "error"
    assert "场景" in (done.error or ""), done.error


# —— ② celery 档：broker 不可达 → 503 executor_unavailable，不留孤儿 run ——


async def test_celery_unreachable_broker_is_loud_503(session, client, make_user,
                                                     celery_dead_broker) -> None:
    from app.modules.scenario.orchestration import enqueue

    g = _graph(_node("s1", "set_var", config={"vars": {"a": "1"}}))
    u, _h, pid, sid = await _scenario(session, client, make_user, "b", g)
    before = await session.scalar(select(func.count()).select_from(RunRecord))
    with pytest.raises(ApiError) as ei:
        await enqueue(session, project_id=pid, subject_id=sid, subject_name="b",
                      trigger="manual", created_by=u.id)
    assert ei.value.http_status == 503
    assert ei.value.code == "executor_unavailable"
    assert "worker" in ei.value.message, "报错必须指向「worker 未启动」这个真原因（R42）"
    await session.rollback()
    after = await session.scalar(select(func.count()).select_from(RunRecord))
    assert after == before, "投不出去就不该留下永远 queued 的孤儿 run 行"


def test_default_exec_mode_is_celery() -> None:
    """exec_mode 默认必须是 celery：inline 当默认交付 = D5 变空话（计划风险表点名过）。"""
    src = (get_settings().model_fields["exec_mode"]).default
    assert src == "celery"


# —— ③ 取消落在 sleep 中间（Review Focus 4） ——————————————————


async def test_cancel_mid_sleep_is_fast_and_keeps_completed_steps(session, client,
                                                                  make_user, inline_mode,
                                                                  fake_bus) -> None:
    from app.modules.scenario.engine.events import request_cancel
    from app.modules.scenario.orchestration import enqueue

    g = _graph(_node("s1", "set_var", config={"vars": {"kept": "yes"}}),
               # 30s 而非 5s：测试在取消后 ~1s 就结束，30s 只是「还没被取消时别到期」的
               # 兜底。5s 版在机器停顿 3.5s 时会把健康执行误判成取消失效（主线校准 R76）。
               _node("s2", "sleep", config={"ms": 30000}))
    u, _h, pid, sid = await _scenario(session, client, make_user, "c", g)
    rec = await enqueue(session, project_id=pid, subject_id=sid, subject_name="c",
                        trigger="manual", created_by=u.id, bus=fake_bus, transport=TR)
    rid = rec.id  # 先取标量：session.rollback() 会过期 ORM 实例，之后碰属性 = 同步 IO
    t0 = time.perf_counter()
    while True:  # 等 sleep 真的在跑再取消，才叫「落在中间」
        await session.rollback()
        # runner 只 publish step/running 事件、不落 running 步骤行（没跑完就没有结论行），
        # 所以判「sleep 正在睡」的证据是事件序列 s1-pass 之后那条 s2-running
        n = await session.scalar(select(func.count()).select_from(RunEvent)
                                 .where(RunEvent.run_id == rid,
                                        RunEvent.type == "step/running"))
        if n >= 2 or time.perf_counter() - t0 > 10:
            break
        await asyncio.sleep(0.05)
    assert n >= 2, "sleep 步应进入 running 后才取消（事件：s1、s2 各一条 step/running）"
    await request_cancel(fake_bus, rid)
    tc = time.perf_counter()
    done = await _wait_terminal(session, rid, timeout=6.0)
    spent_ms = (time.perf_counter() - tc) * 1000
    assert done.status == "cancelled"
    assert spent_ms <= 5000, "sleep 按 500ms 切片轮询，取消不该慢过 5s（实测 " + \
        str(int(spent_ms)) + "ms；真失效时 sleep 还有 30s 才自然到期，会走到这条）"
    await session.rollback()
    s1 = (await session.execute(select(RunStepResult).where(
        RunStepResult.run_id == rid, RunStepResult.step_key == "s1"))).scalar_one()
    assert s1.status == "pass", "已完成步骤明细保留可读，不回滚（§8.2）"


# —— ④ 租约失效 = 进程中断（Review Focus 6）：查询详情时判中断 ————————


async def test_dead_lease_marks_run_error_on_detail_query(session, client, make_user,
                                                          fake_bus) -> None:
    from app.modules.execution.services import LEASE_KEY_PREFIX

    u, h = await make_user("t9d")
    pid = (await client.post("/api/v1/projects", json={"name": "t9pd"},
                             headers=h)).json()["id"]
    rec = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-x",
                    subject_name="僵尸 run", trigger="manual", status="running",
                    created_by=u.id, started_at=datetime.now(UTC).replace(tzinfo=None),
                    lease_owner="ghost-worker")
    session.add(rec)
    await session.commit()
    # 把租约交给「不存在的 owner」且 TTL=1s：模拟 worker 进程被杀后租约自然过期
    assert await renew_lease(fake_bus, rec.id, "ghost-worker", ttl=1)
    await asyncio.sleep(1.3)
    r = await client.get("/api/v1/runs/" + rec.id, params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "error", body
    assert "执行进程中断" in body["error"]
    # 报告详情是同一判据（报告中心也要给中断态上色）
    r2 = await client.get("/api/v1/reports/" + rec.id, params={"project_id": pid},
                          headers=h)
    assert r2.json()["status"] == "error"
    # 键名前缀必须与 scenario.engine.events 的唯一构造点相等：改一边必红
    assert LEASE_KEY_PREFIX + "abc" == lease_key("abc")


async def test_live_lease_does_not_mark_error(session, client, make_user, fake_bus) -> None:
    """反向钉：租约还活着（正常执行中）时查询不得误杀。"""
    u, h = await make_user("t9d2")
    pid = (await client.post("/api/v1/projects", json={"name": "t9pd2"},
                             headers=h)).json()["id"]
    rec = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-y",
                    subject_name="执行中", trigger="manual", status="running",
                    created_by=u.id)
    session.add(rec)
    await session.commit()
    assert await renew_lease(fake_bus, rec.id, "live-worker", ttl=60)
    r = await client.get("/api/v1/runs/" + rec.id, params={"project_id": pid}, headers=h)
    assert r.json()["status"] == "running", "活着的不许标 error"


# —— ⑦ 状态词表：queued/running/cancelled 必须能被过滤（旧 pattern 会 422）——


async def test_status_vocabulary_widened_on_both_lists(session, client, make_user) -> None:
    u, h = await make_user("t9v")
    pid = (await client.post("/api/v1/projects", json={"name": "t9pv"},
                             headers=h)).json()["id"]
    for st in ("queued", "running", "cancelled"):
        session.add(RunRecord(project_id=pid, subject_type="scenario",
                              subject_id="sc-" + st, subject_name=st, trigger="manual",
                              status=st, created_by=u.id))
    await session.commit()
    for path in ("/api/v1/runs", "/api/v1/reports"):
        for st in ("queued", "running", "cancelled", "passed"):
            r = await client.get(path, params={"project_id": pid, "status": st}, headers=h)
            assert r.status_code == 200, path + " status=" + st + " → " + str(r.status_code)
    bad = await client.get("/api/v1/runs", params={"project_id": pid, "status": "nope"},
                           headers=h)
    assert bad.status_code == 422, "词表放宽不等于不设防"


# —— ⑥ worker 入口结构钉（不起子进程的那半边；真跑在 verify_worker.py）——


def test_worker_task_registered_without_importing_engine() -> None:
    """worker.py 必须注册 scenario.run，且模块级不 import 引擎/编排协程。

    引擎 import 写在任务函数体内：celery worker 确实需要它，但「web 侧不 import 引擎」
    的前提是这条依赖链不能反向蔓延（orchestration 同理，见下一测）。
    """
    import app.worker as worker_mod

    assert "scenario.run" in worker_mod.celery_app.tasks
    conf = worker_mod.celery_app.conf
    assert conf.task_serializer == "json"
    assert conf.worker_prefetch_multiplier == 1
    src = open(worker_mod.__file__, encoding="utf-8").read()
    top = [ln for ln in src.splitlines() if ln.startswith(("import ", "from "))]
    assert not any("scenario" in ln for ln in top), \
        "worker 模块级不许 import scenario（引擎只在任务体内取）"


def test_orchestration_does_not_import_engine_at_module_level() -> None:
    """R42 的可实测事实：exec_mode=celery 的 web 进程 import orchestration 时，
    引擎模块不该被加载 —— run_graph 的 import 必须写在协程体内。
    只扫模块级（行首无缩进）：函数体内的延迟 import 正是本测允许并要求的形态。"""
    import app.modules.scenario.orchestration as orch

    src = open(orch.__file__, encoding="utf-8").read()
    for line in src.splitlines():
        if line.startswith(("import ", "from ")) and "run_graph" in line:
            raise AssertionError("run_graph 不许模块级 import：" + line)


def test_inline_pending_tasks_are_held() -> None:
    """asyncio 只持弱引用：enqueue 的协程句柄必须被模块级集合持住，否则任务可能被
    GC 掉——「提交后无声无息」是最难查的一种死法。"""
    import app.modules.scenario.orchestration as orch

    assert hasattr(orch, "_PENDING"), "inline 协程句柄要有强引用容器"
