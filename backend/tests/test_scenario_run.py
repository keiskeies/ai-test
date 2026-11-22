"""1B T11：scenario_run / scenario_debug / run_cancel / run_rerun_step @service。

计划 Step 1 判据 + T11 落地裁定：
  ① scenario_run（inline）→ 轮询到终态、明细齐全、summary_graph 每 key 有状态、
     冗余列回写、trigger=manual、created_by 落库；
  ② scenario_debug 跑**传入**图而非库里的（Review Focus 11 / §11.5.6），trigger=debug，
     图快照随 run 行走（裁定①：queued 自包含），且 **debug 不回写 last_run_***——
     debug 是过程不是结论，「最近结果」只认真执行；
  ③ run_cancel 落在 sleep 中间 → cancelled；已完成步骤保留；终态再取消 → 409；
  ④ run_rerun_step 经 HTTP：靶场计数 ==1、上游 extract 的 ${uid} 仍可用、
     stats.rerun_of 指回原 run；bogus step_key → 409 snapshot_missing；
  ⑤ Agent 入口 trigger 自动 agent（ctx.entry），HTTP 入口恒 manual——trigger 是事实，
     不许调用方自选（schedule/webhook 链路 1B 还不存在）；
  ⑥ 重复投递同一 run 不双写步骤（幂等）。

手法沿用 T9：inline 档 + fakeredis 全局 bus + set_debug_transport 注内存靶
（裁定②：HTTP 通道递不进 transport，走 1A 同款模块钩子）。
"""
from __future__ import annotations

import asyncio
import copy
import socket
import threading
import time

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.eventbus import init_bus
from app.modules.execution.models import RunEvent, RunRecord, RunStepResult

target = FastAPI()
_hits: list[str] = []


@target.get("/ping")
async def ping():
    _hits.append("ping")
    return JSONResponse({"pong": True})


@target.get("/login")
async def login():
    _hits.append("login")
    return JSONResponse({"uid": 42})


@target.get("/order/{oid}")
async def order(oid: str):
    _hits.append("order:" + oid)
    return JSONResponse({"ok": True})


@target.get("/echo")
async def echo(who: str = "?"):
    # 1C T10 混合链的 HTTP 腿锚点：把 query 回显成 JSON，定义断言 $.who 判它
    _hits.append("echo:" + who)
    return JSONResponse({"who": who, "ok": True})


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


@pytest.fixture()
def fake_bus():
    return init_bus(client=FakeAsyncRedis(decode_responses=True))


@pytest.fixture(autouse=True)
def _transport_hook():
    from app.modules.scenario.services import set_debug_transport

    set_debug_transport(lambda: TR)
    yield
    set_debug_transport(None)


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _node(key, kind, *, config=None, children=None, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": None,
         "config": config or {}, "children": children or []}
    n.update(extra)
    return n


async def _setup(client, make_user, tag, *, graph=None, **scen_kw):
    u, h = await make_user("t11" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t11p" + tag},
                             headers=h)).json()["id"]
    g = graph if graph is not None else _graph(
        _node("s1", "set_var", config={"vars": {"a": "1"}}),
        _node("s2", "http_direct", config={"url": BASE + "/ping", "method": "GET"}))
    sid = (await client.post("/api/v1/scenarios", headers=h,
                             json={"project_id": pid, "name": "场景" + tag,
                                   "step_graph": g, **scen_kw})).json()["id"]
    return u, h, pid, sid


async def _wait_terminal(session, run_id, timeout=20.0):
    """与 T9 同法：终态 + run_end 事件都到位才算完（run_end 在 commit 之后补发）。"""
    t0 = time.perf_counter()
    while True:
        await session.rollback()
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


# —— ① scenario_run 端到端 ——————————————————————————————


async def test_scenario_run_end_to_end(session, client, make_user, fake_bus) -> None:
    u, h, pid, sid = await _setup(client, make_user, "a")
    uid = u.id  # 先取标量：_wait_terminal 的 rollback 会过期实例（MissingGreenlet 的坑）
    r = await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    body = r.json()
    run_id = body["run_id"]
    assert body["status"] == "queued", "投递语义：返回时还没跑完"
    done = await _wait_terminal(session, run_id)
    assert done.status == "passed", (done.status, done.error)
    assert done.trigger == "manual" and done.created_by == uid
    assert done.summary_graph and all("result" in n for n in done.summary_graph["nodes"]), \
        "summary_graph 每 key 有状态（报告页整树上色的前提）"
    steps = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == run_id))).scalars().all()
    assert {s.step_key for s in steps} == {"s1", "s2"} and all(s.status == "pass" for s in steps)
    from app.modules.scenario.models import Scenario

    # 「最近结果」的回写排在 run_end 发布之后（_run_claimed 的刻意顺序：先让 SSE 消费方
    # 拿到终态，冗余列是派生数据），所以这里必须等。
    # **每轮先 rollback**：库是 REPEATABLE-READ（实测 @@transaction_isolation），
    # 事务的快照在首次 SELECT 就定死，此后 refresh 只会被同一份快照答同一个旧值——
    # 光加超时轮询等于「闭着眼睛多等 10 秒」，满载下必红（本条上一版就这么红给我看的）。
    # rollback 结束当前事务，下一轮才看得到别的连接在那之后 commit 的回写。同法见 _wait_terminal。
    t0 = time.perf_counter()
    while True:
        await session.rollback()
        sc = await session.get(Scenario, sid)
        await session.refresh(sc)
        if sc.last_run_status is not None or time.perf_counter() - t0 > 10:
            break
        await asyncio.sleep(0.05)
    assert sc.last_run_status == "passed", "真执行必须回写「最近结果」（T10 列表页数据源）"


async def test_scenario_run_recycled_404(session, client, make_user, fake_bus) -> None:
    _u, h, pid, sid = await _setup(client, make_user, "gone")
    assert (await client.post(f"/api/v1/scenarios/{sid}/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    before = await session.scalar(select(func.count()).select_from(RunRecord))
    r = await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 404
    after = await session.scalar(select(func.count()).select_from(RunRecord))
    assert after == before, "回收站场景不许留下 queued 孤儿 run"


# —— ② debug 跑传入图；不回写冗余列 ——————————————————————


async def test_debug_runs_passed_graph_not_saved(session, client, make_user,
                                                 fake_bus) -> None:
    saved = _graph(_node("keep", "set_var", config={"vars": {"k": "1"}}))
    u, h, pid, sid = await _setup(client, make_user, "dbg", graph=saved)
    dbg = _graph(_node("dbg", "http_direct",
                       config={"url": BASE + "/ping", "method": "GET"}))
    r = await client.post(f"/api/v1/scenarios/{sid}/debug", headers=h,
                          json={"project_id": pid, "graph": dbg,
                                "variables": {}})
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    done = await _wait_terminal(session, run_id)
    assert done.status == "passed", (done.status, done.error)
    assert _hits == ["ping"], "跑的是传入图里的 dbg 步，不是库里的 keep"
    assert done.trigger == "debug"
    assert done.request_snapshot and done.request_snapshot["graph"]["nodes"][0]["key"] == "dbg", \
        "裁定①：debug 的图随 run 行走，queued 自包含"
    from app.modules.scenario.models import Scenario

    sc = await session.get(Scenario, sid)
    await session.refresh(sc)
    assert sc.last_run_status is None, "debug 是过程不是结论：不许污染「最近结果」"
    # 报告中心默认过滤 debug（Review Focus 11），运行记录页可见
    assert (await client.get("/api/v1/reports", params={"project_id": pid},
                             headers=h)).json()["items"] == []
    assert len((await client.get("/api/v1/runs", params={"project_id": pid},
                                 headers=h)).json()["items"]) == 1


async def test_debug_invalid_graph_422(session, client, make_user, fake_bus) -> None:
    _u, h, pid, sid = await _setup(client, make_user, "dbg2")
    r = await client.post(f"/api/v1/scenarios/{sid}/debug", headers=h, json={
        "project_id": pid, "graph": _graph(_node("x", "no_such_kind"))})
    assert r.status_code == 422, r.text


async def test_debug_draft_fail_fast_wins_over_saved(session, client, make_user,
                                                     fake_bus) -> None:
    """T11 裁定①的补刀：debug 快照里 fail_fast 必须取**草稿**，不是库里的行。

    抽屉里改了「忽略继续」（draft fail_fast=false）但没保存就点调试：
    执行必须按草稿继续跑后续步骤。旧行为拿的是 SAVED 行的 fail_fast=true，
    抽屉显示草稿策略、执行用旧策略——同一个函数里自相矛盾（截图即穿帮）。
    """
    _u, h, pid, sid = await _setup(client, make_user, "ff1", fail_fast=True)
    failing = _graph(
        _node("bad", "http_direct",
              config={"url": BASE + "/ping", "method": "GET",
                      "assertions": [{"type": "status_code", "expected": 599}]}),
        _node("after", "set_var", config={"vars": {"z": "1"}}))
    r = await client.post(f"/api/v1/scenarios/{sid}/debug", headers=h, json={
        "project_id": pid, "graph": failing, "fail_fast": False})
    assert r.status_code == 200, r.text
    done = await _wait_terminal(session, r.json()["run_id"])
    assert done.request_snapshot["fail_fast"] is False, \
        "入队快照必须记草稿的 fail_fast（执行了什么以入队快照为准）"
    rows = {s.step_key: s.status for s in (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == done.id))).scalars().all()}
    assert rows["bad"] == "fail" and rows["after"] == "pass", \
        "草稿 fail_fast=false：首步失败后续照跑，不许 skip（" + str(rows) + "）"
    assert done.status == "failed"


async def test_debug_fail_fast_defaults_to_saved_row(session, client, make_user,
                                                     fake_bus) -> None:
    """不带 fail_fast 的 debug 继承保存行（缺省不是第三种策略，是「没改」）。"""
    _u, h, pid, sid = await _setup(client, make_user, "ff2", fail_fast=True)
    failing = _graph(
        _node("bad", "http_direct",
              config={"url": BASE + "/ping", "method": "GET",
                      "assertions": [{"type": "status_code", "expected": 599}]}),
        _node("after", "set_var", config={"vars": {"z": "1"}}))
    r = await client.post(f"/api/v1/scenarios/{sid}/debug", headers=h, json={
        "project_id": pid, "graph": failing})
    assert r.status_code == 200, r.text
    done = await _wait_terminal(session, r.json()["run_id"])
    assert done.request_snapshot["fail_fast"] is True
    rows = {s.step_key: s.status for s in (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == done.id))).scalars().all()}
    assert rows["bad"] == "fail" and rows["after"] == "skip", \
        "继承保存行的 fail_fast=true：后续必须 skip（" + str(rows) + "）"


# —— ③ 取消 ——————————————————————————————————————————


async def test_run_cancel_mid_sleep_and_recancel_409(session, client, make_user,
                                                     fake_bus) -> None:
    g = _graph(_node("s1", "set_var", config={"vars": {"kept": "yes"}}),
               _node("s2", "sleep", config={"ms": 30000}))
    _u, h, pid, sid = await _setup(client, make_user, "c", graph=g)
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    t0 = time.perf_counter()
    while True:  # sleep 真在睡了（两条 step/running 事件）才叫「落在中间」
        await session.rollback()
        n = await session.scalar(select(func.count()).select_from(RunEvent)
                                 .where(RunEvent.run_id == run_id,
                                        RunEvent.type == "step/running"))
        if n >= 2 or time.perf_counter() - t0 > 10:
            break
        await asyncio.sleep(0.05)
    assert n >= 2
    r = await client.post(f"/api/v1/runs/{run_id}/cancel", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    done = await _wait_terminal(session, run_id, timeout=8.0)
    assert done.status == "cancelled"
    await session.rollback()
    s1 = (await session.execute(select(RunStepResult).where(
        RunStepResult.run_id == run_id, RunStepResult.step_key == "s1"))).scalar_one()
    assert s1.status == "pass", "已完成步骤保留可读（§8.2）"
    again = await client.post(f"/api/v1/runs/{run_id}/cancel", headers=h,
                              json={"project_id": pid})
    assert again.status_code == 409 and again.json()["code"] == "already_finished", \
        "取消一个跑完的 run 是点错了，不许假装成功"


# —— ④ 单步重跑接线 ————————————————————————————————————


async def test_rerun_step_via_http(session, client, make_user, fake_bus) -> None:
    g = _graph(_node("lg", "http_direct",
                     config={"url": BASE + "/login", "method": "GET"}),
               _node("xt", "extract", config={"rules": [{"var": "uid", "expr": "$.uid"}]}),
               _node("pb", "http_direct",
                     config={"url": BASE + "/order/${uid}", "method": "GET"}))
    _u, h, pid, sid = await _setup(client, make_user, "rs", graph=g)
    src = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                             json={"project_id": pid})).json()["run_id"]
    await _wait_terminal(session, src)
    assert _hits.count("order:42") == 1

    r = await client.post(f"/api/v1/runs/{src}/rerun-step", headers=h,
                          json={"project_id": pid, "step_key": "pb"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "passed", body  # 同步等待：响应即终态（裁定⑤）
    assert _hits.count("order:42") == 2 and _hits.count("login") == 1, \
        "只重跑 pb 一步，且快照里的 uid 还在（上游 extract 没重放）"
    new = await session.get(RunRecord, body["run_id"])
    assert new.stats["rerun_of"] == src and new.stats["rerun_step"] == "pb"

    bad = await client.post(f"/api/v1/runs/{src}/rerun-step", headers=h,
                            json={"project_id": pid, "step_key": "nope"})
    assert bad.status_code == 409 and bad.json()["code"] == "snapshot_missing"


# —— ⑤ trigger 口径 ——————————————————————————————————


async def test_agent_entry_trigger_agent_http_manual(session, client, make_user,
                                                     fake_bus) -> None:
    """trigger 是事实记录：HTTP 入口恒 manual，Agent 入口（ctx.entry=agent）自动 agent。"""
    from app.core.service import ServiceCtx
    from app.modules.scenario import schemas, services

    u, h, pid, sid = await _setup(client, make_user, "trig")
    uid, uname, uadmin = u.id, u.name, bool(u.is_system_admin)  # 先取标量（同 ① 的坑）
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    assert (await session.get(RunRecord, run_id)).trigger == "manual"

    actx = ServiceCtx(entry="agent", user_id=uid, user_name=uname,
                      is_system_admin=uadmin, perms=set(), db=session)
    out = await services.scenario_run(
        schemas.ScenarioRunIn(project_id=pid, scenario_id=sid), actx)
    assert (await session.get(RunRecord, out.run_id)).trigger == "agent"


# —— ⑥ 幂等：重复投递同一 run 不双写 ————————————————————


async def test_double_delivery_is_idempotent(session, client, make_user,
                                             fake_bus) -> None:
    """重复投递同一 run（消息重投的最坏形状）：第二次 _amain 必须直接退出，不双写。

    先 new_run 造 queued 行再手工投两次：走 HTTP 的 run 第一次就被 inline 协程领走，
    没法在它之后可靠地再投同一条——幂等门判的是「非 queued 直接退出」，直接喂给它。
    """
    from app.modules.execution.services import new_run
    from app.modules.scenario.orchestration import _amain

    _u, _h, pid, sid = await _setup(client, make_user, "idem")
    rec = await new_run(session, project_id=pid, subject_type="scenario",
                        subject_id=sid, subject_name="幂等", trigger="manual",
                        created_by=None, env_id=None, env_name=None)
    rid = rec.id
    await session.commit()
    await _amain(rid, bus=fake_bus, transport=TR)
    await session.rollback()
    mid = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == rid))).scalars().all()
    assert mid and all(r.attempts == 1 for r in mid)
    await _amain(rid, bus=fake_bus, transport=TR)  # 第二次投递：必须直接退出
    await session.rollback()
    rows = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == rid))).scalars().all()
    assert len(rows) == len(mid) and all(r.attempts == 1 for r in rows), \
        "重复投递不双写步骤（非 queued 直接退出，T9 幂等门的对外承诺）"
    assert (await session.get(RunRecord, rid)).status == "passed"


# ═══════════════ 1C T10：场景里的 ui_case 步骤（api→ui→api 混合链）═══════════════
#
# 计划 D1 的最小混合证据：**真浏览器**跑 api_case → ui_case → api_case，UI 步 save_var
# 的值被后面的 API 步用上。UI 腿走真靶场（scripts/target_app.py，8322 起顺延——
# 9999/8321/5173 是前端车道），chromium 起不来整组 skip 并打印原因（同 test_ui_debug
# 的诚实判据，绝不静默绿）。HTTP 腿仍走 ASGITransport 内存靶——transport 只注给 HTTP，
# UI 腿不认识 transport（真网络真渲染），这正是「混合」要证明的分层。
# 这里不碰 playwright e2e / 前端端口；只起后端内存靶 + 靶场 uvicorn。

UI_TARGET_PORT_BASE = 8322


def _pick_ui_port() -> int:
    import os

    base = int(os.environ.get("TP_UI_TARGET_PORT", str(UI_TARGET_PORT_BASE)))
    for p in range(base, base + 8):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
            except OSError:
                continue
            return p
    raise RuntimeError(str(base) + ".." + str(base + 7) + " 全被占用，起不了 UI 靶场")


@pytest.fixture(scope="module")
def ui_base_url():
    """靶场 uvicorn 线程（module 级复用），teardown 必关——同 test_ui_debug 的手法。"""
    import uvicorn

    from scripts.target_app import app

    port = _pick_ui_port()
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(cfg)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("靶场 uvicorn 15s 没起来")
        time.sleep(0.05)
    yield "http://127.0.0.1:" + str(port)
    server.should_exit = True
    th.join(timeout=8)
    assert not th.is_alive(), "靶场线程没收尾，会拖住后续测试"


@pytest.fixture(scope="module")
def ui_browser():
    """真浏览器判据：起得来才跑本组，起不来整组 skip（打印原因，绝不静默）。

    探针照 test_ui_debug：在自己的 asyncio.run 里起一次立刻关——判据只是「起得来」，
    不跨用例（跨用例的 loop 正是 test_ui_debug 并发闸回归钉过的坑）。
    """
    async def probe() -> str:
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            b = await pw.chromium.launch(headless=True)
            v = b.version
            await b.close()
            return v

    try:
        return asyncio.run(probe())
    except Exception as e:  # noqa: BLE001 skip 判据就是一切启动失败
        pytest.skip("真实 chromium 启动失败，ui_case 场景步骤整组跳过（这不是通过）："
                    + type(e).__name__ + ": " + str(e)[:300])


async def _create_ui_case(client, h, pid, base) -> str:
    """元素 + 登录 UI 用例（u5 get_text save_var 抓工作台标题）。"""
    ids = []
    for name, lt, loc in (("账号框", "id", "account"), ("口令框", "css", "#password"),
                          ("登录按钮", "id", "submit"), ("工作台标题", "id", "title")):
        r = await client.post("/api/v1/ui-elements", json={
            "project_id": pid, "name": name, "locator_type": lt, "locator": loc}, headers=h)
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    ea, ep, es, et = ids
    steps = [
        {"id": "u1", "type": "open", "input": "${base_url}/ui/login"},
        {"id": "u2", "type": "input", "element_id": ea, "input": "demo"},
        {"id": "u3", "type": "input", "element_id": ep, "input": "demo123"},
        {"id": "u4", "type": "click", "element_id": es},
        # save_var：登录落地后的工作台 <h1 id="title">订单工作台</h1> 的文本存进变量，
        # 供场景里后面的 API 步 ${ui_title} 引用——D1 混合证据的接头。
        {"id": "u5", "type": "get_text", "element_id": et, "save_var": "ui_title"},
        {"id": "u6", "type": "assert_title", "input": "工作台"},
    ]
    r = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "登录取标题" + str(time.time_ns() % 10**6),
        "steps": steps}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _mixed_graph(a1_cid: str, ui_cid: str, a2_cid: str) -> dict:
    return _graph(
        _node("a1", "api_case", ref=a1_cid, name="登录取token"),
        _node("ui", "ui_case", ref=ui_cid, name="UI 登录取标题"),
        _node("a2", "api_case", ref=a2_cid, name="用 UI 变量查订单"))


async def _mixed_setup(client, make_user, tag, ui_base, *, ui_steps_mutate=None):
    """项目 + 环境(base_url=靶场, tok=tk-1) + 两个 api_case + UI 用例 + 混合场景。

    api1: GET ${base}/echo?who=ui-chain 的内存靶定义（定义断言 $.who == "ui-chain"）。
    api2: GET ${base}/order/${ui_title}，定义断言 $.ok == true —— ${ui_title} 只有
          UI 步真的登录、抓到「订单工作台」并 save_var 之后才渲染得出；缺变量时
          h_api_case 直接 error（不发半截模板），所以 api2 pass 本身就证明 UI 的
          save_var 经 dispatch 合并流进了后续步骤。
    """
    u, h = await make_user("t10" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t10p" + tag},
                             headers=h)).json()["id"]
    r = await client.post("/api/v1/envs", json={
        "project_id": pid, "name": "env" + tag,
        "config": {"vars": [["base_url", ui_base], ["tok", "tk-1"]]}}, headers=h)
    assert r.status_code == 201, r.text
    env_id = r.json()["id"]
    d1 = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "回显" + tag, "method": "GET", "path": "/echo",
        "request": {"method": "GET", "url": "${base}/echo?who=ui-chain",
                    "assertions": [{"type": "json_path_equals", "path": "$.who",
                                    "expected": "ui-chain"}]}})).json()["id"]
    c1 = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": d1, "name": "回显用例" + tag})).json()["id"]
    d2 = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "按标题查" + tag, "method": "GET", "path": "/order/x",
        "request": {"method": "GET", "url": "${base}/order/${ui_title}",
                    "headers": [["Authorization", "Bearer ${tok}"]],
                    "assertions": [{"type": "json_path_equals", "path": "$.ok",
                                    "expected": True}]}})).json()["id"]
    c2 = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": d2, "name": "订单用例" + tag})).json()["id"]
    ui_cid = await _create_ui_case(client, h, pid, ui_base)
    g = _mixed_graph(c1, ui_cid, c2)
    sid = (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "混合场景" + tag, "step_graph": g,
        "variables": {"base": BASE}, "env_id": env_id})).json()["id"]
    if ui_steps_mutate is not None:
        await _patch_ui_steps(client, h, pid, ui_cid, ui_steps_mutate)
    return u, h, pid, sid, ui_cid


async def _patch_ui_steps(client, h, pid, ui_cid, mutate) -> None:
    steps = (await client.get("/api/v1/ui-cases/" + ui_cid,
                              params={"project_id": pid}, headers=h)).json()["steps"]
    steps = copy.deepcopy(steps)
    mutate(steps)
    r = await client.patch("/api/v1/ui-cases/" + ui_cid, json={
        "project_id": pid, "steps": steps, "steps_set": True}, headers=h)
    assert r.status_code == 200, r.text


async def _run_rows(session, rid):
    rows = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == rid))).scalars().all()
    return {r.step_key: r for r in rows}


async def test_mixed_api_ui_api_scenario_real_browser(session, client, make_user, fake_bus,
                                                      ui_base_url, ui_browser) -> None:
    """④（本任务存在的理由）：api→ui→api 真浏览器跑通，UI 步 save_var 喂给后面的 API 步。

    每个环节都不许用假：HTTP 腿走内存靶（transport 钩子注入），UI 腿走 8322 真靶场真
    chromium。api2 的 URL 带 ${ui_title}——UI 步没跑、没登录、没抓标题，渲染就缺变量、
    api2 必 error；它 pass 即混合链成立。
    """
    _u, h, pid, sid, _cid = await _mixed_setup(client, make_user, "mix", ui_base_url)
    rid = (await client.post("/api/v1/scenarios/" + sid + "/run", headers=h,
                             json={"project_id": pid})).json()["run_id"]
    done = await _wait_terminal(session, rid, timeout=90.0)
    assert done.status == "passed", (done.status, done.error)
    rows = await _run_rows(session, rid)
    assert {k: r.status for k, r in rows.items()} == {"a1": "pass", "ui": "pass",
                                                      "a2": "pass"}
    assert _hits.count("echo:ui-chain") == 1
    # UI save_var → 场景 vars → 下一 api 步 URL：order 步骤的键就是抓到的标题文本
    assert "order:订单工作台" in _hits, "UI 步抓到的标题必须原样流进后续 API 步：" + str(_hits)
    ui_row = rows["ui"]
    assert ui_row.kind == "ui_case"
    snap = ui_row.vars_snapshot
    assert snap.get("ui_title") == "订单工作台", "vars_snapshot 要留得住 save_var（重跑依据）"
    assert ui_row.detail["response"] == {"status": None, "body": None}, \
        "UI 步 detail.response 是占位（None 状态码），不是假 HTTP"
    assert ui_row.detail["commands"], "步骤明细要能回看命令时间线"
    assert isinstance(ui_row.detail["artifacts"], list)
    for a in ui_row.detail["artifacts"]:
        assert set(a) == {"kind", "step_key", "command", "bytes", "reason"}, a
    # ⑥ 截图进 report_get 且 step_key 对得上画布步骤
    rep = (await client.get("/api/v1/reports/" + rid, params={"project_id": pid},
                            headers=h)).json()
    arts = rep["artifacts"]
    assert arts, "UI 步骤的截图必须进报告中心（run_artifact 行才是报告的数据源）"
    assert all(a["step_key"] == "ui" for a in arts), str(arts)
    shot = next(a for a in arts if a["kind"] == "SCREENSHOT")
    name = shot["ref"].split("/")[-1]
    dl = await client.get("/api/v1/artifacts/" + rid + "/" + name,
                          params={"project_id": pid}, headers=h)
    assert dl.status_code == 200 and dl.headers["content-type"] == "image/png"
    assert dl.content.startswith(b"\x89PNG") and len(dl.content) > 1000, "真截图字节，不是占位"
    # ⑦ UI 步没有数据集行：按行重跑必须在建 run 行之前 400（钉住 runner 的 kind 白名单）
    r400 = await client.post("/api/v1/runs/" + rid + "/rerun-step", headers=h,
                             json={"project_id": pid, "step_key": "ui", "row_no": 1})
    assert r400.status_code == 400, r400.text


async def test_ui_step_failure_fails_run_not_error(session, client, make_user, fake_bus,
                                                   ui_base_url, ui_browser) -> None:
    """⑤ UI 断言没过 → 步骤 fail、整场 failed（红得正确：跑成了但没过，不是没跑成）。"""
    def break_it(steps):
        for s in steps:
            if s["id"] == "u6":
                s["input"] = "永远不该出现的标题XYZ"

    _u, h, pid, sid, ui_cid = await _mixed_setup(client, make_user, "fail", ui_base_url,
                                                 ui_steps_mutate=break_it)
    rid = (await client.post("/api/v1/scenarios/" + sid + "/run", headers=h,
                             json={"project_id": pid})).json()["run_id"]
    done = await _wait_terminal(session, rid, timeout=90.0)
    assert done.status == "failed", (done.status, done.error)
    rows = await _run_rows(session, rid)
    assert rows["ui"].status == "fail", "断言不成立是业务结论 fail，不许冒成 error"
    assert "a2" not in rows or rows["a2"].status == "skip", "fail_fast：UI 失败后 a2 不再跑"
    # 失败步骤的当场截图同样要能在报告里点开（⑥ 的红案半边）
    rep = (await client.get("/api/v1/reports/" + rid, params={"project_id": pid},
                            headers=h)).json()
    kinds = [a["kind"] for a in rep["artifacts"]]
    assert "SCREENSHOT" in kinds and "DOM" in kinds, str(kinds)


async def test_ui_step_respects_cancel(session, client, make_user, fake_bus,
                                        ui_base_url, ui_browser) -> None:
    """取消线：UI 命令执行中置 cancel → 驱动器在命令/sleep 切片边界停 → 步骤/整场 cancelled。

    取消必须真的穿过 h_ui_case 传给 run_ui 的 should_cancel（is_cancelled(ctx.bus,run_id)）：
    线断了的话这条用例只能等 5 条命令自然跑完，run 会是 passed——那才是它存在的理由。
    """
    def slow_sleep(steps):
        # 在 u4（点击）之前插一条 20s sleep：sleep 按 500ms 切片查取消旗标（ui_core），
        # 取消必须在一个切片内生效，而不是等满 20 秒。
        steps.insert(3, {"id": "usleep", "type": "sleep", "input": "20000"})

    _u, h, pid, sid, ui_cid = await _mixed_setup(client, make_user, "cxl", ui_base_url,
                                                 ui_steps_mutate=slow_sleep)
    rid = (await client.post("/api/v1/scenarios/" + sid + "/run", headers=h,
                             json={"project_id": pid})).json()["run_id"]
    # 等 UI 步进入 running（a1 与 ui 两条 step/running 事件）再按停止
    t0 = time.perf_counter()
    while True:
        await session.rollback()
        n = await session.scalar(select(func.count()).select_from(RunEvent)
                                 .where(RunEvent.run_id == rid,
                                        RunEvent.type == "step/running"))
        if n >= 2 or time.perf_counter() - t0 > 60:
            break
        await asyncio.sleep(0.05)
    assert n >= 2, "UI 步没进入 running 就按停止，测不到命令边界"
    t1 = time.perf_counter()
    r = await client.post("/api/v1/runs/" + rid + "/cancel", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    done = await _wait_terminal(session, rid, timeout=30.0)
    took = time.perf_counter() - t1
    assert done.status == "cancelled", (done.status, done.error)
    assert took < 10, "取消没有在 sleep 切片里生效（等满了？）：" + format(took, ".1f") + "s"
    rows = await _run_rows(session, rid)
    assert rows["ui"].status == "cancelled"
