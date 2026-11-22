"""1D T8：场景里的 adb_case 步骤真执行（引擎 → adb_case_engine_run → _execute_adb_run）。

与 test_engine_handlers.py 的分工：那边钉 h_adb_case 的折法与防御（缺 ref/缺身份）；
这边把整条链跑穿——**混合场景（api + 等待 + 判断 + ADB）里的 ADB 腿**是一期 DoD 的
最小证据，设备全挂假 adb（T1），门禁不依赖真机。

七条钉：
- ① 真执行落库：adb 步 pass、detail 齐（commands/artifacts/mode/device/adb_run_id），
  降级可见（mode=dump）；
- ② **R145 同源**：引擎步骤经 `amain_adb_run` → `_execute_adb_run`，不是第二份执行体
  ——包装件计数 + 子 run 行形状与 debug/worker 同尺，逻辑被分叉就红；
- ③ 腐坏引用 → 步骤 error 点名，绝不静默跳过/假绿；
- ④ 场景内设备被占 → 排队（background 档），不是 422；detail["device_queued"] 带
  真实位次（D17，绝不编 ETA）；
- ⑤ 取消场景 run → 翻译进进行中的 adb 步（engine_run_id → cancel.<adb run>），
  步骤 cancelled 而不是留在 running；
- ⑥ vars 分层：上游 extract 的值渲染进 adb 步（override_vars），save_var 的增量
  只交真变化键进场景 vars。
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.eventbus import init_bus
from app.modules.execution.models import RunEvent, RunRecord, RunStepResult

SERIAL = "192.168.1.50:5555"

target = FastAPI()
_hits: list[str] = []


@target.get("/who")
async def who():
    _hits.append("who")
    # 值「登录」刻意与假设备 dump XML 里的文本同词：adb 步 ${who} 断言判绿 = 分层通了
    return JSONResponse({"who": "登录"})


TR = ASGITransport(app=target)
BASE = "http://tp-target"


@pytest.fixture(autouse=True)
def _reset_hits():
    _hits.clear()
    yield
    _hits.clear()


@pytest.fixture(autouse=True)
def _boot_registry():
    from app.main import create_app

    create_app()


@pytest.fixture(autouse=True)
def _transport_hook():
    from app.modules.scenario.services import set_debug_transport

    set_debug_transport(lambda: TR)
    yield
    set_debug_transport(None)


@pytest.fixture()
def fake_adb(monkeypatch):
    """假 WiFi 设备 + 全新 fakeredis 总线（锁键/取消键/租约键跨用例不串台）。

    dump 模式（假 u2 不注入）：与 test_adb_run 同款形状——降级可见（mode=dump）是常态。
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

    init_bus(client=fa.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True))
    return mgr


# —— 脚手架 —————————————————————————————————————————


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _node(key, kind, *, config=None, ref=None, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": ref,
         "config": config or {}, "children": []}
    n.update(extra)
    return n


async def _setup(client, make_user, tag):
    u, h = await make_user("t8adb" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t8adbp" + tag},
                             headers=h)).json()["id"]
    return u, h, pid


async def _mk_device(client, h, pid, serial: str = SERIAL) -> dict:
    r = await client.post("/api/v1/adb-devices", json={
        "project_id": pid, "name": "机" + str(time.time_ns() % 10**6), "serial": serial},
        headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mk_case(client, h, pid, name, steps, **kw) -> dict:
    body = {"project_id": pid, "name": name, "steps": steps}
    body.update(kw)
    r = await client.post("/api/v1/adb-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mk_scenario(client, h, pid, name, graph) -> str:
    r = await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": name, "step_graph": graph})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _snapshot(rid: str) -> dict:
    """每轮新会话：inline 协程与 adb 子 run 在另一副 NullPool 引擎上写库。"""
    from app.core.db import get_sessionmaker

    async with get_sessionmaker()() as s:
        rec = (await s.execute(select(RunRecord).where(RunRecord.id == rid))).scalar_one()
        steps = (await s.execute(select(RunStepResult).where(
            RunStepResult.run_id == rid))).scalars().all()
        n_end = await s.scalar(select(func.count()).select_from(RunEvent).where(
            RunEvent.run_id == rid, RunEvent.type == "run_end"))
        return {"status": rec.status, "error": rec.error,
                "steps": {r.step_key: r for r in steps}, "run_end": bool(n_end)}


async def _wait_terminal(rid: str, timeout: float = 45.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = await _snapshot(rid)
        if snap["status"] in ("passed", "failed", "error", "cancelled") and snap["run_end"]:
            return snap
        await asyncio.sleep(0.1)
    raise AssertionError("run " + rid + " " + str(timeout) + "s 没到终态+run_end")


async def _sub_runs(pid: str) -> list[dict]:
    """项目下的 adb 子 run（引擎步骤建的 manual 行），每行摊平成标量 dict。"""
    from app.core.db import get_sessionmaker

    async with get_sessionmaker()() as s:
        rows = (await s.execute(select(RunRecord).where(
            RunRecord.project_id == pid, RunRecord.subject_type == "adb_case")
            .order_by(RunRecord.created_at))).scalars().all()
        return [{"id": r.id, "status": r.status, "trigger": r.trigger,
                 "subject_id": r.subject_id} for r in rows]


async def _run_via_http(client, h, pid, sid) -> str:
    r = await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    return r.json()["run_id"]


# —— ① 混合场景的 ADB 腿真执行 + detail 形状 ——————————————————


async def test_adb_step_runs_for_real_and_lands_detail(client, make_user, fake_adb) -> None:
    """api → adb 的混合场景：ADB 腿在假设备上真跑，步骤/子 run 双双落库。

    这是一期 DoD「混合场景执行 → 报告」的最小后端证据。detail 逐键钉：报告页与
    单步重跑都按这些键取数；mode=dump 是降级可见的兑现（T6 交接）。
    """
    _u, h, pid = await _setup(client, make_user, "A")
    await _mk_device(client, h, pid)
    case = await _mk_case(client, h, pid, "绿案", [
        {"id": "s1", "type": "home"},
        {"id": "s2", "type": "assert_text", "config": {"text": "登录"}}])
    sid = await _mk_scenario(client, h, pid, "混合A", _graph(
        _node("api", "http_direct", config={"url": BASE + "/who", "method": "GET"}),
        _node("adb", "adb_case", ref=case["id"])))
    rid = await _run_via_http(client, h, pid, sid)
    snap = await _wait_terminal(rid)
    assert snap["status"] == "passed", (snap["status"], snap["error"])
    assert _hits == ["who"], "API 腿也要真发过（混合，不是只跑 adb）"
    row = snap["steps"]["adb"]
    assert row.status == "pass" and row.kind == "adb_case"
    d = row.detail
    assert [c["id"] for c in d["commands"]] == ["s1", "s2"], "R108 逐步行原样进 detail"
    assert [c["status"] for c in d["commands"]] == ["pass", "pass"]
    assert d["mode"] == "dump", "降级必须看得见（假 u2 不注入 → dump 是常态）"
    assert d["device"] == SERIAL
    assert d["response"] == {"status": None, "body": None}, "ADB 步没有 HTTP 响应：占位"
    for a in d["artifacts"]:
        assert set(a) == {"kind", "step_key", "ref", "bytes", "reason"}, a
    # 子 run：trigger=manual（场景/后台档，与 debug 相对——排队分流就靠它）
    subs = await _sub_runs(pid)
    assert len(subs) == 1
    assert d["adb_run_id"] == subs[0]["id"], "detail 要认得出这条子 run（报告页下钻入口）"
    assert subs[0]["trigger"] == "manual" and subs[0]["status"] == "passed"
    assert subs[0]["subject_id"] == case["id"]


# —— ② R145 同源：引擎步骤穿过 _execute_adb_run，不是第二份执行体 ——————————————


async def test_adb_step_goes_through_the_shared_execution_body(
        client, session, make_user, fake_adb, monkeypatch) -> None:
    """把 `_execute_adb_run` 包一层 spy：引擎步骤必须**恰好经它一次**，且带 override_vars。

    如果有人给引擎分叉出第二份执行体（R145 的违例形状），spy 计数归零、本用例必红——
    这不是自说自话的 docstring 钉。子 run 的行形状（trigger=manual、case 汇总行
    detail 带 mode/device）与 debug/worker 同一份尺（R102），逐键比对。
    """
    from app.modules.adb_test import debug_services as dbg
    from app.modules.scenario.engine.context import ExecutionContext
    from app.modules.scenario.engine.handlers import dispatch, make_runner

    calls: list[dict] = []
    original = dbg._execute_adb_run

    async def spy(db, rec, *, actor, bus, override_vars=None, step_device=None):
        calls.append({"run_id": rec.id, "trigger": rec.trigger,
                      "override_vars": dict(override_vars or {}),
                      "step_device": step_device})
        return await original(db, rec, actor=actor, bus=bus, override_vars=override_vars,
                              step_device=step_device)

    monkeypatch.setattr(dbg, "_execute_adb_run", spy)

    u, h, pid = await _setup(client, make_user, "S")
    await _mk_device(client, h, pid)
    case = await _mk_case(client, h, pid, "同源钉", [
        {"id": "s1", "type": "home"},
        {"id": "s2", "type": "assert_text", "config": {"text": "登录"}}])

    from app.core.eventbus import get_bus

    ctx = ExecutionContext(session, get_bus(), "run-src-" + str(time.time_ns()), pid,
                           {"engine_only": "1"}, {}, 60_000,
                           actor={"user_id": u.id, "user_name": u.name,
                                  "is_system_admin": True, "perms": {"*"}, "entry": "http"})
    n = {"key": "adb1", "kind": "adb_case", "name": "跑设备", "ref": case["id"],
         "config": {}, "children": [], "disable": False}
    out = await dispatch(n, ctx, run_children=make_runner(ctx))
    assert out.status == "pass", out.message
    assert len(calls) == 1, "引擎步骤 = 恰好一次共享执行体；0 次 = 分叉出了第二份"
    assert calls[0]["trigger"] == "manual", "场景档走 manual（debug 永不排队的分流键）"
    assert calls[0]["override_vars"].get("engine_only") == "1", (
        "ctx.vars 必须作为 override_vars 传进去（R145 的变量分层）")
    assert out.detail["adb_run_id"] == calls[0]["run_id"]
    # 子 run 行形状与 debug/worker 同一份尺：case 汇总行 + mode/device 进 detail
    snap = await _snapshot(calls[0]["run_id"])
    assert snap["status"] == "passed"
    case_row = snap["steps"]["case"]
    assert case_row.kind == "adb_case" and case_row.detail["mode"] == "dump"
    assert case_row.detail["device"] == SERIAL
    assert {k: r.status for k, r in snap["steps"].items() if k != "case"} == {"s1": "pass",
                                                                              "s2": "pass"}


# —— ②b 画布的设备策略真生效（§11.4.12 / R145） ————————————————


async def test_step_device_policy_overrides_case_default(
        client, make_user, fake_adb) -> None:
    """画布上点「指定设备 = 另一台」：这一步就跑在那台上，用例自己的默认让位。

    这是 R145 唯一没被自动带上的那条——引擎与执行体分两层传参，中间任何一层漏传，
    画布上的选择器就是个假旋钮（界面能配、执行不认，§13 纪律 1 禁止的形状）。
    """
    second = "192.168.1.77:5555"
    # 夹具状态文件是 fake 与产品之间唯一的合同：读回来加一台，再原子写回
    state = json.loads(fake_adb.state_path.read_text(encoding="utf-8"))
    state["devices"] = [{"serial": SERIAL, "state": "device"},
                        {"serial": second, "state": "device"}]
    fake_adb.set_state(state)
    _u, h, pid = await _setup(client, make_user, "P")
    await _mk_device(client, h, pid)
    await _mk_device(client, h, pid, serial=second)
    case = await _mk_case(client, h, pid, "默认机A", [{"id": "s1", "type": "home"}],
                          default_device=SERIAL)
    sid = await _mk_scenario(client, h, pid, "步骤指定机B", _graph(
        _node("adb", "adb_case", ref=case["id"],
              config={"device_policy": "specified", "device_serial": second})))
    rid = await _run_via_http(client, h, pid, sid)
    snap = await _wait_terminal(rid)
    assert snap["steps"]["adb"].status == "pass", snap["steps"]["adb"].detail
    subs = await _sub_runs(pid)
    assert len(subs) == 1
    sub = await _snapshot(subs[0]["id"])
    assert sub["steps"]["case"].detail["device"] == second, "跑错设备 = 策略没传到执行体"


async def test_specified_device_missing_names_the_reason(
        client, make_user, fake_adb) -> None:
    """指定了一台项目里不存在的设备：步骤 error 点名设备，而不是随便挑一台跑绿。

    回退到「任一空闲」是最坏的失败方式——用户会以为跑在他点的那台上。
    """
    _u, h, pid = await _setup(client, make_user, "M")
    await _mk_device(client, h, pid)
    case = await _mk_case(client, h, pid, "无默认", [{"id": "s1", "type": "home"}])
    sid = await _mk_scenario(client, h, pid, "指定野设备", _graph(
        _node("adb", "adb_case", ref=case["id"],
              config={"device_policy": "specified", "device_serial": "9.9.9.9:5555"})))
    rid = await _run_via_http(client, h, pid, sid)
    snap = await _wait_terminal(rid)
    msg = str(snap["steps"]["adb"].detail.get("error") or "")
    assert snap["steps"]["adb"].status == "error", msg
    assert "9.9.9.9:5555" in msg, "要点名是哪台设备，否则用户只能猜"
    assert await _sub_runs(pid) == [], "预检没过就不该建子 run（别留下半条运行记录）"


# —— ③ 腐坏引用：error 点名，绝不假绿 ——————————————————


async def test_recycled_ref_is_error_naming_the_culprit(client, make_user, fake_adb) -> None:
    """场景保存后用例被回收：步骤 error 点名「ADB 用例不可用」，run 绝不显示绿。

    「一条其实什么都没测的场景显示绿色，比显示红色危险得多」——1B 立下的原则，
    adb 腿必须同样守住。
    """
    _u, h, pid = await _setup(client, make_user, "R")
    await _mk_device(client, h, pid)
    case = await _mk_case(client, h, pid, "会被回收", [
        {"id": "s1", "type": "home"}])
    sid = await _mk_scenario(client, h, pid, "腐坏引用", _graph(
        _node("adb", "adb_case", ref=case["id"])))
    assert (await client.post(f"/api/v1/adb-cases/{case['id']}/delete",
                              json={"project_id": pid}, headers=h)).status_code == 409
    # 被引用 → 409；force=看过清单后的第二段（删除保护自身在 test_adb_case.py 钉透）
    assert (await client.post(f"/api/v1/adb-cases/{case['id']}/delete",
                              json={"project_id": pid, "force": True},
                              headers=h)).status_code == 200
    rid = await _run_via_http(client, h, pid, sid)
    snap = await _wait_terminal(rid)
    assert snap["status"] in ("failed", "error"), snap
    row = snap["steps"]["adb"]
    assert row.status == "error", "腐坏引用必须红，不许 skip/静默通过"
    assert "ADB 用例" in (row.detail.get("error") or ""), str(row.detail)
    assert await _sub_runs(pid) == [], "resolve 都没过，不该建子 run 行"


# —— ④ 场景内设备被占：排队，不是 422；位次是真的 ——————————————


async def test_busy_device_queues_in_scene_with_real_position(client, make_user, fake_adb) -> None:
    """④ 场景内设备被他人占用：adb 步骤停在执行体里 FIFO 等待（background 档承诺）。

    debug 档 422 绝不排队、场景/后台档排队——分流在 trigger，引擎一个字不碰。
    detail["device_queued"] 带真实队列位次（D17：只显真实位次，绝不编 ETA）。
    """
    from app.modules.execution import adb_lock

    await adb_lock.acquire(SERIAL, "run:blocker:1:h:p")
    _u, h, pid = await _setup(client, make_user, "Q")
    await _mk_device(client, h, pid)
    # 指定设备策略才走 FIFO（「任一空闲」是候选轮询，不入队、不占位次）
    case = await _mk_case(client, h, pid, "排队接棒", [
        {"id": "s1", "type": "home"},
        {"id": "s2", "type": "assert_text", "config": {"text": "登录"}}],
        default_device=SERIAL)
    sid = await _mk_scenario(client, h, pid, "排队场景", _graph(
        _node("adb", "adb_case", ref=case["id"])))
    rid = await _run_via_http(client, h, pid, sid)
    await asyncio.sleep(1.0)  # 等待边界粒度 0.5s：足够把「还在排队」看成事实
    snap = await _snapshot(rid)
    assert snap["status"] == "running", "设备忙 = 老实等着，不 422 不失败也不假过"
    subs = await _sub_runs(pid)
    assert len(subs) == 1 and subs[0]["status"] == "queued", "拿不到锁必须停在 queued"
    # 对方释放 → FIFO 晋升 → 执行体下一轮轮询抢到位 → 跑完
    assert await adb_lock.release(SERIAL, "run:blocker:1:h:p")
    snap = await _wait_terminal(rid)
    assert snap["status"] == "passed", (snap["status"], snap["error"])
    d = snap["steps"]["adb"].detail
    q = d.get("device_queued")
    assert q and q[0]["position"] == 1 and q[0]["serial"] == SERIAL, (
        "D17：位次是真实队列读数：" + str(q))
    assert "eta" not in str(q).lower(), "绝不编造预计等待时间"


# —— ⑤ 取消场景 run：翻译进进行中的 adb 步 ——————————————


async def test_cancel_scenario_reaches_inflight_adb_step(client, make_user, fake_adb) -> None:
    """adb 步在 30s sleep 里时取消**场景** run：cancel.<场景> 翻译成 cancel.<adb 子 run>。

    翻译线断了的话这条只能等 adb 自然跑完（run 会 passed）——那才是它存在的理由。
    步骤终态 cancelled，绝不留在 running；子 run 同样 cancelled。
    """
    _u, h, pid = await _setup(client, make_user, "C")
    await _mk_device(client, h, pid)
    case = await _mk_case(client, h, pid, "慢设备", [
        {"id": "s1", "type": "sleep", "config": {"ms": 30000}}])
    sid = await _mk_scenario(client, h, pid, "取消传播", _graph(
        _node("adb", "adb_case", ref=case["id"])))
    rid = await _run_via_http(client, h, pid, sid)
    # 等子 run 进入 running（sleep 真在睡）再按停止
    deadline = time.time() + 20
    subs: list[dict] = []
    while time.time() < deadline:
        subs = await _sub_runs(pid)
        if subs and subs[0]["status"] == "running":
            break
        await asyncio.sleep(0.1)
    assert subs and subs[0]["status"] == "running", "adb 子 run 没进 running，测不到步边界"
    t0 = time.perf_counter()
    r = await client.post("/api/v1/runs/" + rid + "/cancel", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    snap = await _wait_terminal(rid, timeout=20.0)
    assert time.perf_counter() - t0 < 12, "取消没在 sleep 切片里生效（等满了？）"
    assert snap["status"] == "cancelled", (snap["status"], snap["error"])
    assert snap["steps"]["adb"].status == "cancelled"
    subs = await _sub_runs(pid)
    assert subs[0]["status"] == "cancelled", "翻译断线的话子 run 会自己跑成 passed"


# —— ⑥ vars 分层：extract → adb 步渲染；save_var 增量回填 ——————————————


async def test_extracted_var_renders_into_adb_step_and_save_var_flows_back(
        client, make_user, fake_adb) -> None:
    """上游 extract 的「登录」经 override_vars 渲染进 adb 步的 ${who} 断言判绿。

    反证形状：分层断了（override_vars 没传/没叠）→ assert_text 拿字面 ${who} 找不到
    → adb 步 fail、整场 failed。同时 screenshot save_var 的 artifact#1 只作为**新键**
    进场景 vars（打底带回的入参变量不许算「这一步改的」，vars_snapshot 两键钉死）。
    """
    _u, h, pid = await _setup(client, make_user, "V")
    await _mk_device(client, h, pid)
    case = await _mk_case(client, h, pid, "变量往返", [
        {"id": "s1", "type": "assert_text", "config": {"text": "${who}"}},
        {"id": "s2", "type": "screenshot", "config": {"save_var": "shot"}}])
    sid = await _mk_scenario(client, h, pid, "变量分层", _graph(
        _node("api", "http_direct", config={"url": BASE + "/who", "method": "GET"}),
        _node("xt", "extract", config={"rules": [{"var": "who", "expr": "$.who"}]}),
        _node("adb", "adb_case", ref=case["id"])))
    rid = await _run_via_http(client, h, pid, sid)
    snap = await _wait_terminal(rid)
    assert snap["status"] == "passed", (snap["status"], snap["error"],
                                        snap["steps"]["adb"].detail.get("error"))
    assert _hits == ["who"]
    row = snap["steps"]["adb"]
    c1 = row.detail["commands"][0]
    assert c1["status"] == "pass" and "登录" in c1["message"], (
        "断言文本必须是渲染后的「登录」：" + str(c1))
    snap_vars = row.vars_snapshot
    assert snap_vars.get("who") == "登录" and snap_vars.get("shot") == "artifact#1", (
        "打底变量 + save_var 新值都要在对下游可见的快照里：" + str(snap_vars))
    assert row.detail["artifacts"], "screenshot 制品摘要要跟着步骤走"
