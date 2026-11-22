"""1D T7 执行面（§11.5.5 + §6.4/§8.7）：同步调试 + enqueue + 设备锁接入 + 一份执行体。

手法照 test_ui_debug.py（inline 执行的轮询先看库；每轮 rollback 防 REPEATABLE-READ 快照
骗过轮询），设备全部挂假 adb（T1），门禁不依赖真机。六条钉：
- ① **debug 真跑**（进程内，不投 worker）：假设备上 home+assert_text 全绿 → 200 passed；
  run 行 subject_type=adb_case/trigger=debug、R102 逐步 + case 汇总行、mode 落进详情
  （降级可见是 T6 交接的责任）。
- ② **debug 不回写 last_run_***（调试是过程不是结论）；manual run（inline）回写。
- ③ **调试必选空闲设备**（§11.5.5 原话）：设备被占 → 422 device_occupied，绝不排队。
- ④ background 抢不到锁就排队：锁被他人持有时 manual run 停在 queued 等（位次以
  device_queued 事件播出），对方释放后自动接棒跑完——§6.4「同设备串行」的端到端形状。
- ⑤ broker 死了 503 且不留 queued 孤儿（R42 不静默降级）。
- ⑥ 跑不了的用例 debug 422 说人话（无设备可跑 / per-step device 覆盖未开放）。
"""
from __future__ import annotations

import asyncio
import time

import pytest
from httpx import AsyncClient


@pytest.fixture()
def fake_adb(monkeypatch):
    """一台开箱即用的假 WiFi 设备 + 全新 fakeredis 总线（锁键/取消键跨用例不串台）。

    dump 模式（假 u2 不注入）：控件树类步骤走 uiautomator dump——顺带把「降级看得见」
    钉成常态路径（mode=dump 必须出现在 debug 出参与 run 详情里）。
    """
    from app.core.config import get_settings
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager()
    mgr.with_device(serial="192.168.1.50:5555")
    monkeypatch.setattr(get_settings(), "adb_path", mgr.adb())
    monkeypatch.setenv("FAKE_ADB_STATE", str(mgr.state_path))
    from app.modules.execution import adb_u2

    monkeypatch.setattr(adb_u2, "connect_session", lambda addr, **kw: None)
    import fakeredis
    import fakeredis.aioredis as fa

    from app.core.eventbus import init_bus

    init_bus(client=fa.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True))
    return mgr


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("adbg" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "adbgp" + tag},
                             headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk_device(client: AsyncClient, h, pid, name="测试机") -> dict:
    r = await client.post("/api/v1/adb-devices", json={
        "project_id": pid, "name": name, "serial": "192.168.1.50:5555"}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _steps():
    # 假设备的 dump XML 里有「登录」（fake_adb 的状态机内置页面）——断言能真判绿
    return [{"id": "s1", "type": "home"},
            {"id": "s2", "type": "assert_text", "config": {"text": "登录"}}]


async def _mk_case(client: AsyncClient, h, pid, name, **kw) -> dict:
    body = {"project_id": pid, "name": name, "steps": _steps()}
    body.update(kw)
    r = await client.post("/api/v1/adb-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _wait_run(run_id: str, to_status=("passed", "failed", "error", "cancelled"),
                    timeout: float = 20.0):
    """轮询 run 终态：每轮新开会话（inline 任务在另一副 NullPool 引擎上写库）。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.execution.models import RunRecord

    deadline = time.time() + timeout
    while time.time() < deadline:
        async with get_sessionmaker()() as s:
            rec = (await s.execute(select(RunRecord).where(RunRecord.id == run_id))).scalar_one()
            if rec.status in to_status:
                return {c.key: getattr(rec, c.key) for c in RunRecord.__table__.columns}
        await asyncio.sleep(0.1)
    raise AssertionError(f"run {run_id} {timeout}s 没到终态")


# —— ①② debug 真跑 + 回写口径 ——————————————————————————————


async def test_debug_runs_in_process_and_is_visible(client, make_user, fake_adb) -> None:
    """debug 200：真跑假设备全绿；mode=dump 出现在出参与 run 详情（降级可见）。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.execution.models import RunRecord, RunStepResult

    _, h, pid = await _setup(client, make_user, "A")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "调试一案")
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/debug",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "passed" and body["passed"] is True, body
    assert body["mode"] == "dump", "假 u2 起不来 → dump 模式，且必须出现在调试载荷里"
    assert body["device"] == "192.168.1.50:5555"
    assert [row["id"] for row in body["commands"]] == ["s1", "s2"]
    # R108 断言行逐键在（跨面板共享的只有这个）
    arows = body["commands"][1]["assertions"]
    assert arows and set(arows[0]) == {"type", "passed", "expected", "actual", "error", "path"}

    async with get_sessionmaker()() as s:
        rec = (await s.execute(select(RunRecord).where(RunRecord.id == body["run_id"]))).scalar_one()
        assert rec.subject_type == "adb_case" and rec.trigger == "debug"
        assert rec.status == "passed"
        node = rec.summary_graph["nodes"][0]
        assert node["kind"] == "adb_case" and node["config"]["mode"] == "dump"
        steps = (await s.execute(select(RunStepResult).where(
            RunStepResult.run_id == rec.id).order_by(RunStepResult.step_key))).scalars().all()
        keys = {r.step_key: r.status for r in steps}
        assert keys == {"s1": "pass", "s2": "pass", "case": "pass"}, "R102 逐步 + case 汇总"
        # ② debug 不回写「最近结果」（调试是过程不是结论）
        from app.modules.adb_test.models import AdbCase

        case = (await s.execute(select(AdbCase).where(AdbCase.id == c["id"]))).scalar_one()
        assert case.last_run_at is None and case.last_run_status is None


async def test_manual_run_inline_writes_back_last_result(client, make_user, fake_adb) -> None:
    """② 对半：manual（inline）跑完回写 last_run_*——「最近结果」只认真执行。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbCase

    _, h, pid = await _setup(client, make_user, "B")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "手跑二案")
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/run", json={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["status"] == "queued", r.text
    rec = await _wait_run(r.json()["run_id"])
    assert rec["status"] == "passed" and rec["trigger"] == "manual"
    async with get_sessionmaker()() as s:
        case = (await s.execute(select(AdbCase).where(AdbCase.id == c["id"]))).scalar_one()
        assert case.last_run_status == "passed" and case.last_run_at is not None


# —— ③ 调试必选空闲设备 ——————————————————————————————


async def test_debug_never_queues_device_occupied_422(client, make_user, fake_adb) -> None:
    """③ 锁在他人手里：debug 端点当场 422 device_occupied（人在等答复，排队=撒谎）。"""
    from app.modules.execution import adb_lock

    await adb_lock.acquire("192.168.1.50:5555", "run:other:1:h:p")
    _, h, pid = await _setup(client, make_user, "C")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "抢不上机器")
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/debug",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "device_occupied", body
    # 「任一空闲」策略：明细逐台报占用（serial/holder/排队人数都是真实读数，D17）
    dev = {d["serial"]: d for d in body["details"]["devices"]}
    assert dev["192.168.1.50:5555"]["holder"] == "run:other:1:h:p"
    # 绝不排队：锁队列里没有这条 debug 的 token
    snap = await adb_lock.occupied("192.168.1.50:5555")
    assert snap["holder"] == "run:other:1:h:p" and snap["queued"] == 0


# —— ④ background 排队接棒（§6.4 同设备串行的端到端） ——————————————


async def test_manual_run_waits_for_device_then_finishes(client, make_user, fake_adb) -> None:
    """④ 锁被占时 manual run 排队等待（device_queued 事件带真实位次），释放后接棒跑完。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.execution import adb_lock
    from app.modules.execution.models import RunEvent
    from app.modules.execution.models import RunRecord as RunRecord_

    await adb_lock.acquire("192.168.1.50:5555", "run:blocker:1:h:p")
    _, h, pid = await _setup(client, make_user, "D")
    await _mk_device(client, h, pid)
    # 指定设备策略才走 FIFO 排队（「任一空闲」是候选轮询，不入队、不占位次）
    c = await _mk_case(client, h, pid, "排队接棒", default_device="192.168.1.50:5555")
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/run", json={"project_id": pid}, headers=h)
    rid = r.json()["run_id"]
    await asyncio.sleep(0.8)  # 等待边界粒度 0.5s：足够把「还在排队」看成事实
    async with get_sessionmaker()() as s:
        rec = (await s.execute(select(RunRecord_.id, RunRecord_.status).where(
            RunRecord_.id == rid))).first()
        assert rec.status == "queued", "拿不到设备必须老实停在 queued，不假装在跑"
        events = (await s.execute(select(RunEvent).where(RunEvent.run_id == rid))).scalars().all()
        dq = [e for e in events if e.type == "device_queued"]
        assert dq and dq[0].payload["position"] == 1, "D17：位次是真实队列位次"
    # 对方释放 → FIFO 晋升 → inline 的下轮轮询抢到位 → 跑完
    assert await adb_lock.release("192.168.1.50:5555", "run:blocker:1:h:p")
    rec = await _wait_run(rid)
    assert rec["status"] == "passed", rec


# —— ⑤ broker 死了不静默 ——————————————————————————————


async def test_celery_mode_dead_broker_503_no_orphan(client, make_user, fake_adb,
                                                     monkeypatch) -> None:
    from sqlalchemy import func, select

    from app.core.config import get_settings
    from app.core.db import get_sessionmaker
    from app.modules.adb_test import debug_services as dbg
    from app.modules.execution.models import RunRecord

    async def _dead() -> bool:
        return False

    monkeypatch.setattr(dbg, "_broker_alive", _dead)
    monkeypatch.setattr(get_settings(), "exec_mode", "celery")
    _, h, pid = await _setup(client, make_user, "E")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "没有 worker")
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/run", json={"project_id": pid}, headers=h)
    assert r.status_code == 503 and r.json()["code"] == "executor_unavailable", r.text
    async with get_sessionmaker()() as s:
        n = await s.scalar(select(func.count()).select_from(RunRecord).where(
            RunRecord.project_id == pid))
        assert n == 0, "投不出去 = 一行都不留（孤儿 queued 是最难查的脏数据）"


# —— ⑥ debug 对「跑不了」说人话 ——————————————————————————————


async def test_debug_loud_on_unrunnable(client, make_user, fake_adb) -> None:
    """⑥ 没设备可跑 / per-step device 覆盖：debug 422（resolve 的 422 档位）。"""
    _, h, pid = await _setup(client, make_user, "F")
    # 项目里一台设备都没登记：「任一空闲」挑不出设备
    c = await _mk_case(client, h, pid, "无设备用例")
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/debug",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 422 and "没有" in r.json()["message"], r.text
    # 逐步骤换设备一期未开放：响亮拒绝而不是悄悄忽略
    c2 = await _mk_case(client, h, pid, "越权覆盖", steps=[
        {"id": "s1", "type": "home", "device": "10.9.9.9:5555"}])
    r2 = await client.post(f"/api/v1/adb-cases/{c2['id']}/debug",
                           json={"project_id": pid}, headers=h)
    assert r2.status_code == 422 and "s1" in r2.json()["message"], r2.text
