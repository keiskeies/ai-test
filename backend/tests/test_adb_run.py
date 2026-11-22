"""1D T7 执行体（`_execute_adb_run`）本体钉：resolve 数据面 + R102 同源 + 取消/deadline。

与 test_adb_debug.py 的分工：那边钉 HTTP 面（debug 200/422、enqueue 排队接棒、broker 死
503）；这边把 worker 入口 `amain_adb_run` 直接拎出来跑，钉它背后的执行体语义——
计划 T7 的原话「同步调试与 worker **共用 `_execute_adb_run` 的一份执行体**（R102 同源）」
此前只是 docstring 的自述，本文件把它钉成可比对的字段。设备全挂假 adb（T1），门禁不依赖真机。

七条钉：
- ① resolve 的「跑不了」是数据事实不是请求非法：executable=False + reason 点名（野 serial
  点 serial、per-step device 覆盖点步骤 id），**不 422**；回收站用例才 404。
  它是 http=None / tool=False 的内部件（R44），HTTP 面不开。
- ② 同步 debug 的真载荷：R108 断言行逐键、真耗时、绿案终态截图入库（D5）、
  case 汇总行 detail 带 mode/device（降级可见是 T6 交接的责任）。
- ③ **R102 同源**（本文件核心命题）：同一用例走 debug 与走 worker 入口 amain_adb_run，
  status / 逐步状态 / R108 断言行 / mode / device 逐项相等——两把尺子不可能量出两个结论。
- ④ 设备锁真的在执行期间生效：run 活着时 occupied 读数点得出**这条 run 的 token**，
  跑完释放（锁与租约键都不残留）。
- ⑤ 取消在步边界生效（§8.7）：取消键 → 未完成步全 cancelled、run 终态 cancelled、
  run_end 事件、锁与租约键清干净。
- ⑥ deadline 在步边界生效：max_runtime_ms 撞线 → 当步 error、run error、清理干净。
- ⑦ queued 之后资产变坏（resolve 的 problems）：执行体落 error run（逐行 skip 痕迹、
  锁都不碰），非 debug 回写 last_run_status=error；worker 入口对非 queued 行与被他人
  持有租约的行幂等退出。debug 指定设备被占：当场 422 device_occupied 且**不入队**。
"""
from __future__ import annotations

import asyncio
import time

import pytest
from httpx import AsyncClient

SERIAL = "192.168.1.50:5555"


@pytest.fixture()
def fake_adb(monkeypatch):
    """假 WiFi 设备 + 全新 fakeredis 总线（锁键/取消键/租约键跨用例不串台）。

    dump 模式（假 u2 不注入）：与 test_adb_debug 同款形状——降级可见性（mode=dump）
    因此是常态路径而不是摆设。
    """
    from app.core.config import get_settings
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager()
    mgr.with_device(serial=SERIAL)
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
    boss, hb = await make_user("adbrr" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "adbrrp" + tag},
                             headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk_device(client: AsyncClient, h, pid) -> dict:
    r = await client.post("/api/v1/adb-devices", json={
        "project_id": pid, "name": "机" + str(time.time_ns() % 10**6), "serial": SERIAL},
        headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _steps():
    # 假设备 dump XML 里有「登录」（fake_adb 状态机内置页面）——断言能真判绿
    return [{"id": "s1", "type": "home"},
            {"id": "s2", "type": "assert_text", "config": {"text": "登录"}}]


async def _mk_case(client: AsyncClient, h, pid, name, **kw) -> dict:
    body = {"project_id": pid, "name": name, "steps": _steps()}
    body.update(kw)
    r = await client.post("/api/v1/adb-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _run_snapshot(run_id: str) -> dict:
    """run 行 + 步骤表 + run_event 的完整快照（每轮新会话：inline/worker 在另一副引擎写库）。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.execution.models import RunEvent, RunRecord, RunStepResult

    async with get_sessionmaker()() as s:
        rec = (await s.execute(select(RunRecord).where(RunRecord.id == run_id))).scalar_one()
        steps = (await s.execute(select(RunStepResult).where(
            RunStepResult.run_id == run_id))).scalars().all()
        events = (await s.execute(select(RunEvent).where(
            RunEvent.run_id == run_id).order_by(RunEvent.seq))).scalars().all()
        return {
            "record": {c.key: getattr(rec, c.key) for c in RunRecord.__table__.columns},
            "steps": {r.step_key: {"status": r.status, "kind": r.kind,
                                   "parent": r.parent_step_key, "detail": r.detail,
                                   "vars": r.vars_snapshot} for r in steps},
            "events": [{"type": e.type, "payload": e.payload} for e in events],
        }


async def _wait_terminal(run_id: str, timeout: float = 40.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = await _run_snapshot(run_id)
        if snap["record"]["status"] in ("passed", "failed", "error", "cancelled") \
                and any(e["type"] == "run_end" for e in snap["events"]):
            return snap
        await asyncio.sleep(0.1)
    raise AssertionError("run " + run_id + " " + str(timeout) + "s 没到终态+run_end："
                         + str(snap["record"]["status"]))


def _actor_of(boss) -> dict:
    """worker/inline 的身份快照（amain_adb_run 的 actor 入参形状）。"""
    return {"user_id": boss.id, "user_name": boss.name, "is_system_admin": True,
            "perms": {"*"}, "entry": "http"}


async def _resolve(session, boss, pid: str, cid: str) -> dict:
    """注册表直调（http=None 的内部件没有 HTTP 面）。"""
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx

    spec = REGISTRY.get("adb_case_resolve")
    assert spec is not None, "adb_case_resolve 未注册（debug_services 没进 create_app？）"
    ctx = ServiceCtx(entry="http", user_id=boss.id, user_name=boss.name,
                     is_system_admin=True, perms={"*"}, db=session)
    out = await spec.handler(spec.model.model_validate({"project_id": pid, "case_id": cid}), ctx)
    return out.model_dump()


# —— ① resolve：跑不了 = 数据事实（executable=False + 点名），不是 422 ——————————


async def test_resolve_internal_shape(client, session, make_user, fake_adb) -> None:
    """http=None（不开 HTTP 面）+ tool=False（不进模型视野，R44）+ 正常用例可执行。"""
    r = await client.post("/api/v1/adb_case_resolve", json={"project_id": "x", "case_id": "y"})
    assert r.status_code == 404, "内部服务不得暴露 HTTP 路由"
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("adb_case_resolve")
    assert spec.http is None and spec.tool is False and spec.effect == "read"

    boss, h, pid = await _setup(client, make_user, "R1")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "可跑一案")
    out = await _resolve(session, boss, pid, c["id"])
    assert out["executable"] is True and out["reason"] is None
    assert out["case_id"] == c["id"] and out["case_name"] == "可跑一案"
    assert [s["id"] for s in out["commands"]] == ["s1", "s2"]
    # 「任一空闲」不预钉设备（空闲是瞬时状态，预钉 = 替执行时刻撒谎）
    assert out["default_device"] is None and out["device_serial"] is None
    assert isinstance(out["variables"], dict)


async def test_resolve_unrunnable_names_the_culprit(client, session, make_user,
                                                    fake_adb) -> None:
    """① 三种「跑不了」各自点名，且都是 executable=False + reason（不 422）。"""
    boss, h, pid = await _setup(client, make_user, "R2")
    # a) 默认设备是野 serial（存期不校验 → 跑期 resolve 说人话）
    c1 = await _mk_case(client, h, pid, "野 serial", default_device="10.0.0.9:5555")
    out = await _resolve(session, boss, pid, c1["id"])
    assert out["executable"] is False
    assert "10.0.0.9:5555" in (out["reason"] or ""), out["reason"]
    assert out["commands"], "不可执行也要把步骤带回去（报告要知道差在哪一步之前）"
    # b) per-step device 覆盖：一期未开放 → reason 点名**步骤 id**
    c2 = await _mk_case(client, h, pid, "越权覆盖", steps=[
        {"id": "s1", "type": "home"},
        {"id": "s2", "type": "home", "device": "10.9.9.9:5555"}])
    out2 = await _resolve(session, boss, pid, c2["id"])
    assert out2["executable"] is False
    assert "s2" in (out2["reason"] or ""), "必须点名是哪一步越权：" + str(out2["reason"])
    # c) 项目里没有任何启用未回收设备：「任一空闲」挑不出设备
    boss2, h2, pid2 = await _setup(client, make_user, "R2b")
    c3 = await _mk_case(client, h2, pid2, "无设备项目")
    out3 = await _resolve(session, boss2, pid2, c3["id"])
    assert out3["executable"] is False and "设备" in (out3["reason"] or "")
    # device 写 "auto"（前端缺省）不算覆盖——否则每条用例都「不可执行」
    c4 = await _mk_case(client, h, pid, "auto 不算数", steps=[
        {"id": "s1", "type": "home", "device": "auto"}], default_device=SERIAL)
    await _mk_device(client, h, pid)
    out4 = await _resolve(session, boss, pid, c4["id"])
    assert out4["executable"] is True, "auto 是「不覆盖」的写法：" + str(out4["reason"])
    assert out4["device_serial"] == SERIAL, "指定且可用 → 回填 device_serial"


async def test_resolve_recycled_404(client, session, make_user, fake_adb) -> None:
    """回收站 = 看不见（404），与「跑不了」（executable=False）是两种答案。"""
    from app.core.errors import ApiError

    boss, h, pid = await _setup(client, make_user, "R3")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "回收之案")
    assert (await client.post("/api/v1/adb-cases/" + c["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    with pytest.raises(ApiError) as ei:
        await _resolve(session, boss, pid, c["id"])
    assert ei.value.http_status == 404


# —— ②③④ debug 真载荷 + R102 同源 + 锁在执行期间真实占有 ——————————————


def _strip_elapsed(obj):
    """把 dict/list 里所有 `elapsed_ms` 键摘掉：同源承诺是「结论」，不是「墙上时钟」。"""
    if isinstance(obj, dict):
        return {k: _strip_elapsed(v) for k, v in obj.items() if k != "elapsed_ms"}
    if isinstance(obj, list):
        return [_strip_elapsed(v) for v in obj]
    return obj


def _verdict(snap: dict) -> dict:
    """两份 run 快照里**该同源**的部分：终态、逐步结论、R108 断言行、模式、设备。"""
    steps = snap["steps"]
    return {
        "status": snap["record"]["status"],
        "step_status": {k: v["status"] for k, v in steps.items()},
        # R102 逐步行的 detail = {message, assertions}（case 汇总行才有 commands）
        "assertions": {k: _strip_elapsed((v["detail"] or {}).get("assertions"))
                       for k, v in steps.items() if k != "case"},
        "case_detail": {k: (steps["case"]["detail"] or {}).get(k)
                        for k in ("mode", "device", "error")},
        "case_commands": _strip_elapsed((steps["case"]["detail"] or {}).get("commands")),
        "case_vars": steps["case"]["vars"],
        "summary_mode": (snap["record"]["summary_graph"] or {})["nodes"][0]["config"],
        "run_end": _strip_elapsed([e["payload"] for e in snap["events"]
                                   if e["type"] == "run_end"]),
    }


async def test_debug_and_worker_share_one_execution_body(client, make_user, fake_adb) -> None:
    """③ R102 同源（T7 核心命题）：同一用例 debug 与 amain_adb_run 逐项同结论。

    debug 走 HTTP 面（进程内），worker 路径直接 `await amain_adb_run(rid)`——与 celery
    任务体 asyncio.run 桥接的是同一个协程。两把尺子比对的是执行体的产出，不是各自实现。
    """
    boss, h, pid = await _setup(client, make_user, "S1")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "同源一案", default_device=SERIAL)

    d = await client.post(f"/api/v1/adb-cases/{c['id']}/debug",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text
    dbg = d.json()
    snap_d = await _wait_terminal(dbg["run_id"])

    # worker 入口：手工造 queued 行（trigger=manual——worker 领的就是这种行）
    from app.core.db import get_sessionmaker
    from app.modules.adb_test.debug_services import amain_adb_run
    from app.modules.execution.services import new_run

    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=300_000)
        rid = rec.id
        await s.commit()
    await amain_adb_run(rid, actor=_actor_of(boss))
    snap_w = await _wait_terminal(rid)

    vd, vw = _verdict(snap_d), _verdict(snap_w)
    assert vd == vw, "debug 与 worker 结论分叉 = R102 同源被破坏：\n" + repr(vd) + "\n" + repr(vw)
    assert vd["status"] == "passed"
    assert vd["step_status"] == {"s1": "pass", "s2": "pass", "case": "pass"}
    # mode/device 两把尺子都看得见（降级不可见 = 纪律 1 违例）
    assert vd["case_detail"]["mode"] == "dump" and vd["case_detail"]["device"] == SERIAL
    assert vd["summary_mode"] == {"mode": "dump", "device": SERIAL}
    # ② 补：debug 载荷的 R108 断言行与 run 详情同源（debug 的 commands 行 = 库里的 detail）
    arows = dbg["commands"][1]["assertions"]
    assert [r["type"] for r in arows] == ["assert_text"] and arows[0]["passed"] is True
    assert set(arows[0]) == {"type", "passed", "expected", "actual", "error", "path"}
    # worker 路径回写「最近结果」；debug 不回写（trigger 是唯一差别）
    assert snap_w["record"]["stats"]["pass"] == 2 and snap_w["record"]["stats"]["total"] == 2
    from sqlalchemy import select

    from app.modules.adb_test.models import AdbCase

    async with get_sessionmaker()() as s:
        case = (await s.execute(select(AdbCase).where(AdbCase.id == c["id"]))).scalar_one()
        assert case.last_run_status == "passed" and case.last_run_at is not None


async def test_worker_entry_is_idempotent(client, make_user, fake_adb) -> None:
    """worker 入口非 queued 即退出（重投递不双跑）；被他人持有租约的行跳过。"""
    from app.core.db import get_sessionmaker
    from app.modules.adb_test import debug_services as dbg
    from app.modules.execution import adb_lock
    from app.modules.execution.services import new_run

    boss, h, pid = await _setup(client, make_user, "S2")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "幂等之案")

    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=60_000)
        rid = rec.id
        await s.commit()
    await dbg.amain_adb_run(rid, actor=_actor_of(boss))
    snap = await _wait_terminal(rid)
    # 第二次领取：status 已终态 → 直接退出，不双写事件
    await dbg.amain_adb_run(rid, actor=_actor_of(boss))
    snap2 = await _run_snapshot(rid)
    assert snap2["record"]["status"] == snap["record"]["status"] == "passed"
    assert len(snap2["events"]) == len(snap["events"]), "重复投递不许再跑一遍"
    # 锁与租约都不残留（跑完清理）
    assert (await adb_lock.occupied(SERIAL)) == {"holder": None, "queued": 0}
    from app.core.eventbus import get_bus

    assert not await get_bus().exists_key("run.lease." + rid)
    # 别人持有租约 → 领了也白领（skipped=lease_held），行不许被动过
    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=60_000)
        rid2 = rec.id
        await s.commit()
    bus = get_bus()
    await bus.set_key("run.lease." + rid2, "other-worker", ttl=90)
    await dbg.amain_adb_run(rid2, actor=_actor_of(boss))
    s2 = await _run_snapshot(rid2)
    assert s2["record"]["status"] == "queued", "租约在他人手里：第二个执行者必须原地退出"
    assert (await bus.get_key("run.lease." + rid2)) == "other-worker", "不许踩他人租约"


async def test_device_lock_held_for_run_lifetime(client, make_user, fake_adb) -> None:
    """④ §6.4/§8.7：执行期间锁归这条 run（token 认得出 run_id），跑完释放。"""
    from app.core.db import get_sessionmaker
    from app.modules.adb_test.debug_services import amain_adb_run
    from app.modules.execution import adb_lock
    from app.modules.execution.services import new_run

    boss, h, pid = await _setup(client, make_user, "L1")
    await _mk_device(client, h, pid)
    # sleep 3s：给「执行进行中」留出一个可观测窗口（sleep 按 500ms 切片检查取消）
    c = await _mk_case(client, h, pid, "占用窗口", default_device=SERIAL, steps=[
        {"id": "t1", "type": "sleep", "config": {"ms": 3000}}])
    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=60_000)
        rid = rec.id
        await s.commit()
    task = asyncio.create_task(amain_adb_run(rid, actor=_actor_of(boss)))
    try:
        await asyncio.sleep(1.2)  # 锁已抢到、sleep 还在跑
        snap = await _run_snapshot(rid)
        assert snap["record"]["status"] == "running", snap["record"]["status"]
        occ = await adb_lock.occupied(SERIAL)
        assert (occ["holder"] or "").startswith("run:" + rid + ":"), \
            "持有者 token 必须是这条 run 的（make_token 形状 run:{run_id}:...）：" + str(occ)
        assert occ["queued"] == 0
    finally:
        await task
    snap = await _wait_terminal(rid)
    assert snap["record"]["status"] == "passed"
    assert await adb_lock.occupied(SERIAL) == {"holder": None, "queued": 0}, "跑完锁必须释放"


async def test_debug_returns_real_rows_elapsed_and_artifacts(client, make_user, fake_adb) -> None:
    """② 同步调试跑通的真面目：真断言行 + 真耗时 + 终态截图落库（D5 绿案也留现场）。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.execution.models import RunArtifact

    _, h, pid = await _setup(client, make_user, "D1")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "载荷核对", default_device=SERIAL)
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/debug",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "passed" and body["ok"] is True
    assert body["elapsed_ms"] > 0, "耗时是真量出来的（perf_counter），不是零占位"
    row_s2 = next(x for x in body["commands"] if x["id"] == "s2")
    assert row_s2["status"] == "pass" and row_s2["elapsed_ms"] >= 0
    assert row_s2["assertions"][0]["expected"] == "登录"
    assert row_s2["assertions"][0]["actual"], "actual 是当时的屏幕文本（不是 None 占位）"
    # 绿案终态截图：调试载荷 + run 制品表两处都在
    arts = body["artifacts"]
    assert arts and arts[0]["kind"] == "SCREENSHOT" and arts[0]["bytes"] > 100
    assert arts[0]["ref"].startswith(body["run_id"] + "/") and arts[0]["ref"].endswith(".png")
    async with get_sessionmaker()() as s:
        rows = (await s.execute(select(RunArtifact).where(
            RunArtifact.run_id == body["run_id"]))).scalars().all()
        assert [a.kind for a in rows] == ["SCREENSHOT"] and rows[0].bytes > 100


# —— ⑤⑥ 取消 / deadline 在步边界生效（§8.7） ————————————————————


async def test_cancel_at_step_boundary(client, make_user, fake_adb) -> None:
    """取消键置位 → 正在跑的 sleep 步在切片边界停下：全环干净收尾。"""
    from app.core.db import get_sessionmaker
    from app.core.eventbus import get_bus
    from app.modules.adb_test.debug_services import amain_adb_run
    from app.modules.execution import adb_lock
    from app.modules.execution.services import new_run

    boss, h, pid = await _setup(client, make_user, "X1")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "取消之案", default_device=SERIAL, steps=[
        {"id": "t1", "type": "sleep", "config": {"ms": 8000}},
        {"id": "t2", "type": "home"}])
    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=60_000)
        rid = rec.id
        await s.commit()
    task = asyncio.create_task(amain_adb_run(rid, actor=_actor_of(boss)))
    try:
        await asyncio.sleep(1.0)
        assert (await _run_snapshot(rid))["record"]["status"] == "running"
        await get_bus().set_key("cancel." + rid, "1")
    finally:
        await task
    snap = await _wait_terminal(rid)
    assert snap["record"]["status"] == "cancelled"
    st = {k: v["status"] for k, v in snap["steps"].items()}
    assert st["t1"] == "cancelled" and st["t2"] == "skip" and st["case"] == "cancelled", st
    ends = [e for e in snap["events"] if e["type"] == "run_end"]
    assert ends and ends[-1]["payload"]["status"] == "cancelled"
    # 清理三连：设备锁、租约键、取消键由「读方消费」不管，前两个必须清
    assert await adb_lock.occupied(SERIAL) == {"holder": None, "queued": 0}
    assert not await get_bus().exists_key("run.lease." + rid)


async def test_force_release_mid_run_stops_at_next_probe(client, make_user, fake_adb) -> None:
    """D176：run 在飞时锁被强制释放、设备交给新持有者 ⇒ renew 判决 False 必须视为取消。

    库那半边早有钉（test_adb_lock.py「强制释放后原持有者不许再续期」），调用这半边
    （debug_services.should_cancel）此前把 bool 丢了——同设备串行最长破 max_runtime_ms。
    本钉走真强制释放端点 + 新 token 接棒：下一次 should_cancel 探测（sleep 切片 ≤500ms）
    即停，终态 cancelled 不是 error；收尾 release 有 token 守卫，不许误删新持有者的锁。
    """
    from app.core.db import get_sessionmaker
    from app.core.eventbus import get_bus
    from app.modules.adb_test.debug_services import amain_adb_run
    from app.modules.execution import adb_lock
    from app.modules.execution.services import new_run

    boss, h, pid = await _setup(client, make_user, "FR1")
    d = await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "被强制释放之案", default_device=SERIAL, steps=[
        {"id": "t1", "type": "sleep", "config": {"ms": 8000}},
        {"id": "t2", "type": "home"}])
    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=60_000)
        rid = rec.id
        await s.commit()
    task = asyncio.create_task(amain_adb_run(rid, actor=_actor_of(boss)))
    try:
        await asyncio.sleep(1.0)
        assert (await _run_snapshot(rid))["record"]["status"] == "running"
        occ = await adb_lock.occupied(SERIAL)
        assert (occ["holder"] or "").startswith("run:" + rid + ":"), occ
        # 管理员走真端点强制释放（含审计），新 run 接棒设备——锁键换成别的 token
        r = await client.post("/api/v1/adb-devices/" + d["id"] + "/force-release",
                              json={"project_id": pid}, headers=h)
        assert r.status_code == 200, r.text
        await adb_lock.acquire(SERIAL, "run:newholder:1:worker")
    finally:
        await task
    snap = await _wait_terminal(rid)
    assert snap["record"]["status"] == "cancelled", snap["record"]
    st = {k: v["status"] for k, v in snap["steps"].items()}
    assert st["t1"] == "cancelled" and st["t2"] == "skip" and st["case"] == "cancelled", st
    ends = [e for e in snap["events"] if e["type"] == "run_end"]
    assert ends and ends[-1]["payload"]["status"] == "cancelled"
    # 取消来自锁判决而不是取消键（键从未置位）；且在切片边界停下，没跑满 8s sleep
    assert not await get_bus().exists_key("cancel." + rid)
    assert snap["record"]["elapsed_ms"] < 8000, "强制释放后还在跑满整步 = renew 判决又被丢了"
    # 新持有者的锁不许被原 run 的收尾 release 误删（token 守卫）；租约照清
    assert (await adb_lock.occupied(SERIAL))["holder"] == "run:newholder:1:worker"
    assert not await get_bus().exists_key("run.lease." + rid)


async def test_deadline_fires_at_step_boundary(client, make_user, fake_adb) -> None:
    """max_runtime_ms 撞线：当步 error、后续 skip、run error——不是永远睡着。"""
    from app.core.db import get_sessionmaker
    from app.core.eventbus import get_bus
    from app.modules.adb_test.debug_services import amain_adb_run
    from app.modules.execution import adb_lock
    from app.modules.execution.services import new_run

    boss, h, pid = await _setup(client, make_user, "X2")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "超时之案", default_device=SERIAL, steps=[
        {"id": "t1", "type": "sleep", "config": {"ms": 30000}},
        {"id": "t2", "type": "home"}])
    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=1200)
        rid = rec.id
        await s.commit()
    t0 = time.time()
    await amain_adb_run(rid, actor=_actor_of(boss))
    snap = await _wait_terminal(rid)
    assert time.time() - t0 < 20, "deadline 没在 sleep 切片生效，跑满了整步 30s"
    assert snap["record"]["status"] == "error"
    st = {k: v["status"] for k, v in snap["steps"].items()}
    assert st["t1"] == "error" and st["t2"] == "skip" and st["case"] == "error", st
    assert "max_runtime" in str(snap["record"]["error"])
    ends = [e for e in snap["events"] if e["type"] == "run_end"]
    assert ends and ends[-1]["payload"]["status"] == "error"
    assert await adb_lock.occupied(SERIAL) == {"holder": None, "queued": 0}
    assert not await get_bus().exists_key("run.lease." + rid)


# —— ⑦ queued 之后资产变坏：执行体把「跑不了」落成 error run ————————


async def test_asset_rot_after_enqueue_becomes_error_run(client, make_user, fake_adb) -> None:
    """入队后设备被停用：worker 领到的是数据事实（resolve problems）→ error run + 逐行
    skip 痕迹；命令一行不跑（设备锁压根不碰）；非 debug 回写 last_run_status=error。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.debug_services import amain_adb_run
    from app.modules.adb_test.models import AdbDevice
    from app.modules.execution import adb_lock
    from app.modules.execution.services import new_run

    boss, h, pid = await _setup(client, make_user, "E1")
    dev = await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "机没了", default_device=SERIAL)
    async with get_sessionmaker()() as s:
        rec = await new_run(s, project_id=pid, subject_type="adb_case", subject_id=c["id"],
                            subject_name=c["name"], env_id=None, env_name=None,
                            trigger="manual", created_by=boss.id, max_runtime_ms=60_000)
        rid = rec.id
        await s.commit()
    # 排队期间设备停用（enqueue 不拦，resolve 在执行侧说人话）
    async with get_sessionmaker()() as s:
        d = (await s.execute(select(AdbDevice).where(AdbDevice.id == dev["id"]))).scalar_one()
        d.enabled = 0
        await s.commit()
    await amain_adb_run(rid, actor=_actor_of(boss))
    snap = await _wait_terminal(rid)
    assert snap["record"]["status"] == "error"
    assert "不可执行" in str(snap["record"]["error"]) and SERIAL in str(snap["record"]["error"])
    st = {k: v["status"] for k, v in snap["steps"].items()}
    assert st == {"s1": "skip", "s2": "skip", "case": "error"}, "一行没跑，但每步留痕（R102）"
    ends = [e for e in snap["events"] if e["type"] == "run_end"]
    assert ends and ends[-1]["payload"]["status"] == "error"
    # 没抢到锁就绝不留锁/租约残骸
    assert await adb_lock.occupied(SERIAL) == {"holder": None, "queued": 0}
    from app.core.eventbus import get_bus

    assert not await get_bus().exists_key("run.lease." + rid)
    # error 也是结论：非 debug 回写
    async with get_sessionmaker()() as s:
        from app.modules.adb_test.models import AdbCase

        case = (await s.execute(select(AdbCase).where(AdbCase.id == c["id"]))).scalar_one()
        assert case.last_run_status == "error"


async def test_debug_specified_device_occupied_422_never_queues(client, make_user,
                                                                fake_adb) -> None:
    """⑦ 对半：指定设备策略下 debug 抢不到 → 422 device_occupied 点名 serial/holder，
    且 token **不进 FIFO**（人在等答复，挂进队列 = 说不清在等什么）。"""
    from app.modules.execution import adb_lock

    _, h, pid = await _setup(client, make_user, "E2")
    await _mk_device(client, h, pid)
    c = await _mk_case(client, h, pid, "指定设备被占", default_device=SERIAL)
    await adb_lock.acquire(SERIAL, "run:blocker:9:h:p")
    r = await client.post(f"/api/v1/adb-cases/{c['id']}/debug",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "device_occupied", r.text
    det = r.json()["details"]
    assert det["serial"] == SERIAL and det["holder"] == "run:blocker:9:h:p"
    snap = await adb_lock.occupied(SERIAL)
    assert snap["queued"] == 0, "debug 绝不入队：队列里不许多出这条 debug 的 token"
