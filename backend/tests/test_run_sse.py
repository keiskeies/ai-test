"""1B T11：run SSE 通道（GET /api/v1/events/run/{run_id}）。

Review Focus 3 的两个时序都必须钉：
  A 跑完再连 → 全量重放，seq 单调连续，最后一帧是 run_end；
  B 跑到一半连 → 已有事件走重放、之后走直播，**不重不漏**（中间取消制造直播段），
    拼起来仍是 1..N 连续无洞无重；Last-Event-ID 头续传生效。

鉴权（R22 口径）：非成员 403；跨项目 run_id 404（与 report_get 同尺，不泄露存在性）；
READONLY 成员可看进度（api:run:read 是读位）。

手法沿用 T9/agent SSE：build_run_sse 直调 + get_sessionmaker 独立 session
（响应流活过请求 session 的问题同 agent）；403/404 在流开始前抛出，走真 HTTP 路由测。
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import func, select
from starlette.requests import Request

from app.core.eventbus import init_bus
from app.modules.execution.models import RunEvent, RunRecord

target = FastAPI()


@target.get("/ping")
async def ping():
    return JSONResponse({"pong": True})


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
    from app.modules.scenario.services import set_debug_transport

    set_debug_transport(lambda: TR)
    yield
    set_debug_transport(None)


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _node(key, kind, *, config=None, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": None,
         "config": config or {}, "children": []}
    n.update(extra)
    return n


async def _setup(client, make_user, tag, *, graph=None):
    u, h = await make_user("t11s" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t11sp" + tag},
                             headers=h)).json()["id"]
    g = graph if graph is not None else _graph(
        _node("s1", "set_var", config={"vars": {"a": "1"}}),
        _node("s2", "http_direct", config={"url": BASE + "/ping", "method": "GET"}))
    sid = (await client.post("/api/v1/scenarios", headers=h,
                             json={"project_id": pid, "name": "sse场景" + tag,
                                   "step_graph": g})).json()["id"]
    return u, h, pid, sid


def _req(headers=None):
    scope = {"type": "http", "method": "GET", "path": "/x", "query_string": b"",
             "headers": headers or [], "client": ("127.0.0.1", 1), "scheme": "http",
             "server": ("t", 80), "root_path": ""}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(scope, receive)


async def _raw_get(app, path: str, *, query: bytes = b"", headers=None,
                   until=None, timeout: float = 10.0) -> tuple[int, str]:
    """真走挂载路由的 ASGI 调用（httpx.ASGITransport 会缓冲整个响应体，流式 200 经它
    永不返回——repo 的 SSE 测试都不从 client 走流，这里用裸 ASGI 补路由级覆盖）。

    receive 第一次给 http.request、之后永挂：流保持活着，测试读够帧（until 谓词命中）
    或任务自然结束（403/404 是普通 JSON）后由测试亲手 cancel——不模拟断连，
    starlette 的断连监听会在半帧处 cancel 生成器，把「读够就收工」变成竞态。
    """
    messages: list[dict] = []
    started = asyncio.Event()
    calls = 0

    async def receive():
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.Event().wait()  # 永挂，直至测试 cancel 整个任务
        return {"type": "http.disconnect"}

    async def send(msg: dict) -> None:
        messages.append(msg)
        if msg["type"] == "http.response.start":
            started.set()

    scope = {"type": "http", "http_version": "1.1", "method": "GET", "path": path,
             "raw_path": path.encode(), "query_string": query, "root_path": "",
             "scheme": "http", "server": ("test", 80), "client": ("127.0.0.1", 1),
             "headers": headers or []}
    task = asyncio.create_task(app(scope, receive, send))

    def _body() -> str:
        return b"".join(m.get("body", b"") for m in messages
                        if m["type"] == "http.response.body").decode()

    async def _drain() -> None:
        while True:
            if task.done():
                return
            if until is not None and until(_body()):
                return
            await asyncio.sleep(0.02)

    try:
        await asyncio.wait_for(started.wait(), timeout)
        await asyncio.wait_for(_drain(), timeout)
    except TimeoutError as exc:  # 3.12 起 asyncio.TimeoutError 就是内建 TimeoutError（UP041）
        task.cancel()
        # from exc：超时本身的 traceback 正是查挂死时要看的东西，别用 from None 抹掉（B904）
        raise AssertionError("SSE 路由未在 " + str(timeout) + "s 内就绪/读够：" + path) from exc
    finally:
        if not task.done():
            task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 收尾方式，非被测行为
            pass
    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    return status, _body()


def _auth(h: dict) -> list[tuple[bytes, bytes]]:
    return [(b"authorization", h["Authorization"].encode())]


def _parse(buf: str) -> list[dict]:
    out = []
    for blk in buf.strip().split("\n\n"):
        if not blk.strip():
            continue
        lines = blk.split("\n")
        out.append({"id": lines[0][4:], "type": lines[1][7:],
                    "data": json.loads(lines[2][6:])})
    return out


async def _collect(resp, *, stop_type: str = "run_end", timeout: float = 15.0) -> list[dict]:
    """从流里读帧直到 stop_type 出现（读满即关流，避免悬挂）。"""
    frames: list[dict] = []
    buf = ""
    it = resp.body_iterator

    async def _go():
        nonlocal buf
        async for chunk in it:
            buf += chunk
            frames.clear()
            frames.extend(_parse(buf))
            if any(f["data"]["type"] == stop_type for f in frames):
                return

    try:
        await asyncio.wait_for(_go(), timeout)
    finally:
        try:
            await it.aclose()
        except Exception:
            pass
    return frames


async def _wait_done(session, run_id: str, timeout: float = 20.0) -> None:
    """终态 + run_end 事件都落库（run_end 在 run_graph commit 之后补发——R74 时序坑）。"""
    t0 = time.perf_counter()
    while True:
        await session.rollback()
        rec = await session.get(RunRecord, run_id)
        await session.refresh(rec)
        if rec.status == "passed":
            n = await session.scalar(select(func.count()).select_from(RunEvent)
                                     .where(RunEvent.run_id == run_id,
                                            RunEvent.type == "run_end"))
            if n:
                return
        assert time.perf_counter() - t0 < timeout, "run 未在 " + str(timeout) + "s 内收尾"
        await asyncio.sleep(0.05)


# —— 时序 A：跑完再连，全量重放 ——————————————————————————


async def test_sse_after_finish_full_replay(session, client, make_user, fake_bus) -> None:
    from app.core.db import get_sessionmaker
    from app.modules.scenario.routes import build_run_sse

    _u, h, pid, sid = await _setup(client, make_user, "a")
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    await _wait_done(session, run_id)
    total = await session.scalar(select(func.count()).select_from(RunEvent)
                                 .where(RunEvent.run_id == run_id))
    assert total >= 5  # s1 run/pass + s2 run/pass + run_end

    async with get_sessionmaker()() as s:
        resp = await build_run_sse(s, _req(), pid, run_id, None)
        frames = await _collect(resp)
    seqs = [f["data"]["seq"] for f in frames]
    assert seqs == sorted(seqs) and seqs == list(range(1, len(seqs) + 1)), \
        "全量重放必须从 1 起连续（断线重放的底座）"
    assert frames[-1]["data"]["type"] == "run_end"
    assert all(f["id"] == str(f["data"]["seq"]) for f in frames), "SSE id 即 Last-Event-ID"


# —— 时序 B：跑到一半连，重放+直播不重不漏 —————————————————


async def test_sse_midrun_no_dup_no_gap(session, client, make_user, fake_bus) -> None:
    """已有事件走重放、取消产生的新事件走直播；拼接后 seq 仍 1..N 连续无重。"""
    from app.core.db import get_sessionmaker
    from app.modules.scenario.engine.events import request_cancel
    from app.modules.scenario.routes import build_run_sse

    g = _graph(_node("s1", "set_var", config={"vars": {"a": "1"}}),
               _node("s2", "sleep", config={"ms": 3000}))
    _u, h, pid, sid = await _setup(client, make_user, "b", graph=g)
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    # 等到至少一条事件落库（此时 s2 还在睡），流才有「重放段」
    t0 = time.perf_counter()
    while True:
        await session.rollback()
        n = await session.scalar(select(func.count()).select_from(RunEvent)
                                 .where(RunEvent.run_id == run_id))
        if n >= 1 or time.perf_counter() - t0 > 10:
            break
        await asyncio.sleep(0.05)
    assert n >= 1

    async with get_sessionmaker()() as s:
        resp = await build_run_sse(s, _req(), pid, run_id, None)
        reader = asyncio.create_task(_collect(resp))
        await asyncio.sleep(0.3)  # 流已建好并开始重放
        await request_cancel(fake_bus, run_id)  # 取消 → 新事件从**直播**通道来
        frames = await reader
    seqs = [f["data"]["seq"] for f in frames]
    assert seqs == list(range(1, len(seqs) + 1)), \
        "重放段+直播段拼接后必须连续无洞无重（Review Focus 3）"
    assert frames[-1]["data"]["type"] == "run_end"
    types = [f["data"]["type"] for f in frames]
    assert "step/cancelled" in types or "step/pass" in types


async def test_sse_last_event_id_resumes(session, client, make_user, fake_bus) -> None:
    from app.core.db import get_sessionmaker
    from app.modules.scenario.routes import build_run_sse

    _u, h, pid, sid = await _setup(client, make_user, "c")
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    await _wait_done(session, run_id)
    async with get_sessionmaker()() as s:
        last = await session.scalar(select(func.max(RunEvent.seq))
                                    .where(RunEvent.run_id == run_id))
        resp = await build_run_sse(s, _req([(b"last-event-id", str(last - 1).encode())]),
                                   pid, run_id, None)
        frames = await _collect(resp)
    assert [f["data"]["seq"] for f in frames] == [last], "Last-Event-ID 之后只补新的那一条"


# —— 鉴权（走挂载路由的裸 ASGI 调用）——————————————————


async def test_sse_auth_nonmember_403_cross_project_404_readonly_ok(app, session,
                                                                     client, make_user,
                                                                     fake_bus) -> None:
    _u, h, pid, sid = await _setup(client, make_user, "d")
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    # 等 run 收尾（含 run_end）：断连式裸调用只重放「当下已落库」的事件
    await _wait_done(session, run_id)
    path = "/api/v1/events/run/" + run_id
    q = ("project_id=" + pid).encode()
    other, ho = await make_user("t11soutsider")
    st, body = await _raw_get(app, path, query=q, headers=_auth(ho))
    assert st == 403, "非成员不许订阅别人的进度：" + body[:200]
    # 项目成员 + 别人的 run → 404（report_get 同尺：不泄露存在性）
    other_pid = (await client.post("/api/v1/projects", json={"name": "t11spother"},
                                   headers=ho)).json()["id"]
    st2, _b2 = await _raw_get(app, path, query=("project_id=" + other_pid).encode(),
                              headers=_auth(ho))
    assert st2 == 404
    ro, hr = await make_user("t11sro")
    assert (await client.put(f"/api/v1/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=h)).status_code == 200
    st3, body3 = await _raw_get(app, path, query=q, headers=_auth(hr),
                                until=lambda b: 'event: run_end' in b)
    assert st3 == 200, "READONLY 可看进度（api:run:read 是读位）"
    assert "id: 1" in body3 and 'event: run_end' in body3
