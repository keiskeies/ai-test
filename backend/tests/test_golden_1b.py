"""1B 金线（计划 Task 24）：编排 → 执行 → 报告 → 重跑 → purge 后仍完整，一条链跑到底。

与分件测试的分工：每个件都有自己的专项测试，金线钉的是**接线**——
ASGITransport 打真内存靶、exec_mode=inline（与 worker 同一份 run_graph）、
挂载路由进出（不是直调 service），断言的全是消费方视角的事实。

celery 端到端**不在本文件复刻**：D5 的唯一证明点是 scripts/verify_worker.py
（真 Redis broker + 真 worker 子进程 + 跨进程 pub/sub，R72 备案过这个裁定）。
本文件把它作为子进程跑（自建自删一次性 schema，脚本自带），环境不具备时
pytest.skip——但**打印响亮原因**：静默跳过的绿在本仓等于撒谎（§13 纪律 1）。
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.core.eventbus import init_bus
from app.modules.execution.models import RunEvent, RunRecord, RunStepResult

# —— 内存靶：登录发 token、查单必回 PAID、回显 order_id ——
target = FastAPI()


@target.post("/login")
async def login():
    return JSONResponse({"token": "tk-golden", "user": {"id": 1}})


@target.get("/order/{oid}")
async def order(oid: str):
    return JSONResponse({"order_id": oid, "status": "PAID", "amount": 9.9})


TR = ASGITransport(app=target)
BASE = "http://tp-target"


@pytest.fixture(autouse=True)
def _boot_registry():
    from app.main import create_app

    create_app()


@pytest.fixture()
def fake_bus():
    return init_bus(client=FakeAsyncRedis(decode_responses=True))


@pytest.fixture(autouse=True)
def _transport_hook():
    from app.modules.api_test import services as api_svc
    from app.modules.scenario.services import set_debug_transport

    api_svc.set_debug_transport(lambda: TR)
    set_debug_transport(lambda: TR)
    yield
    api_svc.set_debug_transport(None)
    set_debug_transport(None)


async def _wait_terminal(run_id: str, timeout: float = 30.0):
    """终态 + run_end 都落库才算完（R74：passed 可见 ≠ run_end 已发）。"""
    t0 = time.perf_counter()
    while True:
        async with get_sessionmaker()() as s:
            rec = await s.get(RunRecord, run_id)
            n = await s.scalar(select(func.count()).select_from(RunEvent)
                               .where(RunEvent.run_id == run_id,
                                      RunEvent.type == "run_end"))
            if rec is not None and rec.status in ("passed", "failed", "error", "cancelled") and n:
                return rec
        if time.perf_counter() - t0 > timeout:
            raise AssertionError("金线 run 未在 " + str(timeout) + "s 内收尾")
        await asyncio.sleep(0.05)


def _node(key, kind, *, config=None, children=None, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": None,
         "config": config or {}, "children": children or []}
    n.update(extra)
    return n


async def test_golden_1b_scenario_to_report_with_rerun(client, make_user, fake_bus) -> None:
    # ══ 建资产：2 接口 + 2 用例（1 条绑 3 行数据集）+ 场景 + 保存校验 ══
    boss, h = await make_user("g1bboss")
    pid = (await client.post("/api/v1/projects", json={"name": "金线1B"},
                             headers=h)).json()["id"]
    d1 = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "登录获取令牌", "method": "POST", "path": "/login",
        "request": {"method": "POST", "url": BASE + "/login"}})).json()["id"]
    d2 = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "查询订单", "method": "GET", "path": "/order/{id}",
        "request": {"method": "GET", "url": BASE + "/order/1"}})).json()["id"]
    dsid = (await client.post("/api/v1/datasets", headers=h, json={
        "project_id": pid, "name": "订单参数集", "columns": ["oid"],
        "rows": [["1"], ["2"], ["3"]]})).json()["id"]
    c_login = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": d1, "name": "登录冒烟"})).json()["id"]
    c_ds = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": d2, "name": "数据驱动查单",
        "request": {"url": BASE + "/order/${oid}"}, "dataset_id": dsid})).json()["id"]

    graph = {"version": 1, "nodes": [
        _node("login", "api_case", config={}, ref=c_login),
        _node("tok", "extract", config={"rules": [{"var": "token", "expr": "$.token"}]}),
        _node("poll", "loop", config={"mode": "while", "max_iter": 3,
                                      "cond": "ctx.vars.get('st','') != 'PAID'"},
              children=[_node("poll.q", "http_direct",
                              config={"url": BASE + "/order/1", "method": "GET",
                                      "headers": [["Authorization", "Bearer ${token}"]]})]),
        _node("ds", "api_case", config={"headers": [["Authorization", "Bearer ${token}"]]},
              ref=c_ds),
        _node("fin", "assert", config={"assertions": [
            {"type": "status_code", "expected": 200},
            {"type": "json_path_equals", "path": "$.status", "expected": "PAID"}]}),
    ]}
    # 保存触发校验：先塞一个坏图（break 在循环外）→ 422，证明金线的校验门不是摆设
    bad = {"version": 1, "nodes": [_node("bk", "break")]}
    r_bad = await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "坏图场景", "step_graph": bad})
    assert r_bad.status_code == 422 and r_bad.json()["details"]["issues"][0]["code"] == "break_outside_loop"

    sid = (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "金线场景", "step_graph": graph,
        "fail_fast": True})).json()["id"]

    # ══ 执行（inline）→ 轮询终态 ══
    r = await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    done = await _wait_terminal(run_id)
    assert done.status == "passed", (done.status, done.error)

    # ══ run_step_result：行数（含 row_no 展开：ds 节点 3 行 + 节点行）══
    async with get_sessionmaker()() as s:
        rows = (await s.execute(select(RunStepResult)
                                .where(RunStepResult.run_id == run_id))).scalars().all()
    by_key = {}
    for w in rows:
        by_key.setdefault(w.step_key, []).append(w)
    assert {k for k in by_key} == {"login", "tok", "poll", "poll.q", "ds", "fin"}, \
        sorted(by_key)
    ds_rows = sorted(w.row_no for w in by_key["ds"])
    assert ds_rows == [0, 1, 2, 3], "数据集步：节点行(0) + 3 条数据行必须并存"
    assert all(w.status == "pass" for w in by_key["ds"])
    assert {w.row_total for w in by_key["ds"] if w.row_no} == {3}

    # ══ summary_graph 每 key 有状态；stats 与 pass_rate 一致 ══
    assert done.summary_graph
    states = {n["key"]: n["result"]["status"] for n in done.summary_graph["nodes"]
              if isinstance(n.get("result"), dict)}
    assert states == {"login": "pass", "tok": "pass", "poll": "pass",
                      "ds": "pass", "fin": "pass"}, states
    st = done.stats
    # pass_rate 口径 §8.6：数据集步按节点计 1 步 → total=5, pass=5, skip=0
    assert st["total"] == 5 and st["pass"] == 5 and st["rows_total"] == 3, st

    # ══ run_event：seq 单调连续、以 run_end 收尾；SSE 全量重放 == 事件表 ══
    async with get_sessionmaker()() as s:
        evts = (await s.execute(select(RunEvent).where(RunEvent.run_id == run_id)
                                .order_by(RunEvent.seq))).scalars().all()
    seqs = [e.seq for e in evts]
    assert seqs == list(range(1, len(seqs) + 1)), "seq 必须从 1 连续"
    assert evts[-1].type == "run_end"
    assert any(e.type == "step/running" and json.loads(json.dumps(e.payload)).get("key") == "ds"
               for e in evts)

    from starlette.requests import Request

    from app.modules.scenario.routes import build_run_sse
    messages: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(m):
        messages.append(m)

    scope = {"type": "http", "http_version": "1.1", "method": "GET",
             "path": "/api/v1/events/run/" + run_id, "raw_path": b"/", "query_string": b"",
             "root_path": "", "scheme": "http", "server": ("t", 80),
             "client": ("127.0.0.1", 1), "headers": []}
    # 专属 session 且必须关掉：不关 = 事务吊着 schema 的 MDL，teardown 的
    # DROP DATABASE 会被它永远堵住（第一版金线就挂在这，测试本身是绿的）。
    sse_db = get_sessionmaker()()
    try:
        resp = await build_run_sse(sse_db, Request(scope, receive), pid, run_id, None)
        body = b""
        agen = resp.body_iterator

        async def _drain():
            nonlocal body
            async for chunk in agen:
                body += chunk if isinstance(chunk, bytes) else chunk.encode()
        task = asyncio.create_task(_drain())
        # run 已终态：重放一次性发完，之后 generator 仍挂着等直播——读够 run_end 帧就亲手收工
        t0 = time.perf_counter()
        while b"run_end" not in body and time.perf_counter() - t0 < 10:
            await asyncio.sleep(0.02)
        task.cancel()
    finally:
        await sse_db.close()
    replayed = []
    for blk in body.decode().strip().split("\n\n"):
        lines = blk.split("\n")
        if len(lines) >= 3 and lines[0].startswith("id: "):
            replayed.append(json.loads(lines[2][6:]))
    assert [f["seq"] for f in replayed] == seqs, "SSE 全量重放必须逐帧等于事件表"

    # ══ 报告中心可读 → 制造一个失败步 → 重跑只跑那一步 → purge 资产报告仍完整 ══
    rep = await client.get("/api/v1/reports/" + run_id,
                           params={"project_id": pid}, headers=h)
    assert rep.status_code == 200, rep.text
    assert rep.json()["pass_rate"] == 1.0

    # 失败重跑：对 pass 步骤做单步重跑同样合法（§8.3 只约束快照存在）；
    # 断言重跑新 run 只含该步、stats.rerun_of 指回原 run、原 run 不变。
    rr = await client.post("/api/v1/runs/" + run_id + "/rerun-step", headers=h, json={
        "project_id": pid, "step_key": "fin"})
    assert rr.status_code == 200, rr.text
    new_run = rr.json()
    assert new_run["status"] in ("passed", "failed")
    async with get_sessionmaker()() as s:
        nr = await s.get(RunRecord, new_run["run_id"])
        assert nr.stats["rerun_of"] == run_id and nr.stats["rerun_step"] == "fin"
        keys = [n["key"] for n in nr.summary_graph["nodes"]]
        assert keys == ["fin"], "单步重跑的图只含该步"
        old = await s.get(RunRecord, run_id)
        assert old.status == "passed" and old.stats == done.stats, "原 run 不许被改写"

    # purge 场景与用例（先回收再彻底删）→ report_get 仍完整（Review Focus 10）
    await client.post(f"/api/v1/scenarios/{sid}/delete", json={"project_id": pid}, headers=h)
    assert (await client.post(f"/api/v1/scenarios/{sid}/purge", headers=h, json={
        "project_id": pid, "scenario_id": sid, "confirm_name": "金线场景"})).status_code == 200
    for cid in (c_login, c_ds):
        await client.post(f"/api/v1/api-cases/{cid}/delete",
                          json={"project_id": pid, "case_id": cid}, headers=h)
        await client.post(f"/api/v1/api-cases/{cid}/purge", headers=h, json={
            "project_id": pid, "case_id": cid, "confirm_name":
                "登录冒烟" if cid == c_login else "数据驱动查单"})
    rep2 = await client.get("/api/v1/reports/" + run_id,
                            params={"project_id": pid}, headers=h)
    assert rep2.status_code == 200, rep2.text
    j = rep2.json()
    assert j["subject_name"] == "金线场景" and j["summary_graph"], "资产 purge 后报告自包含"
    assert len(j["summary_graph"]["nodes"]) == 5


# ══ celery 端到端：D5 的唯一证明点是 scripts/verify_worker.py（R72）══════════


async def test_golden_1b_celery_end_to_end() -> None:
    """真 broker + 真 worker 子进程：跑 scripts/verify_worker.py（自起自杀、自建自删）。

    本进程不碰它的 DB/Redis——脚本自己建一次性 schema、自选端口、起靶场与 solo
    worker、投递、跨进程收事件、核验终态后全部拆掉（subprocess timeout=240s 兜底）。
    pytest.skip 只在环境明确不可用
    时发生，且**打印原因**：静默跳过的绿在本仓等于撒谎。

    CI 里**大声跳过**（计划 T25 裁定「CI 不起 worker」）：verify_worker 的 scratch
    根硬编码 D:/tmp，Linux runner 上必炸——跳过要说原因，不许装跑过。
    """
    if os.environ.get("GITHUB_ACTIONS"):
        print("\n[GOLDEN-1B][SKIP] CI 环境按计划 T25 不起 worker（scratch 根 D:/tmp 也是 Windows 专用）"
              "——celery 端到端由本地/夜间任务跑 scripts/verify_worker.py 验证。")
        pytest.skip("CI 按计划不跑 worker 子进程（见打印）")
    backend = Path(__file__).resolve().parents[1]
    py = sys.executable

    # 环境探测：MySQL + Redis 可达才值得起子进程（探测失败 → 大声 skip）
    from urllib.parse import urlsplit

    import pymysql
    from redis.asyncio import Redis as ARedis

    base = os.environ.get("TP_DB_URL", "")
    u = urlsplit(base)
    try:
        conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                               password=u.password, connect_timeout=3)
        conn.close()
    except Exception as e:  # noqa: BLE001
        print("\n[GOLDEN-1B][SKIP] MySQL 不可达（" + str(e)[:120] +
              "）——celery 端到端未验证，不是通过！")
        pytest.skip("MySQL 不可达：celery e2e 未验证（见打印）")
    try:
        r = ARedis.from_url(os.environ.get("TP_REDIS_URL", ""),
                            socket_connect_timeout=3)
        await r.ping()
        await r.aclose()
    except Exception as e:  # noqa: BLE001
        print("\n[GOLDEN-1B][SKIP] Redis 不可达（" + str(e)[:120] +
              "）——celery 端到端未验证，不是通过！")
        pytest.skip("Redis 不可达：celery e2e 未验证（见打印）")

    proc = subprocess.run([py, str(backend / "scripts" / "verify_worker.py")],
                          cwd=str(backend), capture_output=True, text=True, timeout=240)
    tail = (proc.stdout or "")[-4000:] + "\n" + (proc.stderr or "")[-2000:]
    if proc.returncode != 0:
        pytest.fail("verify_worker.py 非零退出（celery 端到端坏了）：\n" + tail)
    assert "OK: celery worker 端到端通过" in proc.stdout, tail
