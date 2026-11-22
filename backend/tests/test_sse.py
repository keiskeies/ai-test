"""T9 事件总线 + SSE 游标续传（Review Focus 2：重放与直播同一信封，不重不漏）。"""
from __future__ import annotations

import asyncio
import json

import pytest


def env(seq: int, typ: str = "TEXT") -> dict:
    return {"seq": seq, "ts": f"2026-11-14T00:00:{seq:02d}+00:00", "type": typ, "payload": {"text": "e" + str(seq)}}


async def _fake_redis():
    import fakeredis.aioredis

    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
async def bus():
    from app.core.eventbus import init_bus

    r = await _fake_redis()
    b = init_bus(client=r)
    yield b
    await b.aclose()


def _frames(text: str) -> list[dict]:
    out = []
    for blk in text.strip().split("\n\n"):
        if not blk.strip():
            continue
        cur: dict = {}
        for line in blk.split("\n"):
            if line.startswith("id: "):
                cur["id"] = line[4:]
            elif line.startswith("event: "):
                cur["event"] = line[7:]
            elif line.startswith("data: "):
                cur["data"] = json.loads(line[6:])
        out.append(cur)
    return out


async def _read_frames(resp, n: int, timeout: float = 5.0) -> list[dict]:
    """从 StreamingResponse 的迭代器读 n 帧（读满即关流，避免悬挂）。"""
    frames: list[dict] = []
    buf = ""
    it = resp.body_iterator

    async def _go():
        nonlocal buf
        async for chunk in it:
            buf += chunk
            frames.clear()
            frames.extend(_frames(buf))
            if len(frames) >= n:
                return

    try:
        await asyncio.wait_for(_go(), timeout)
    finally:
        try:
            await it.aclose()
        except Exception:
            pass
    return frames[:n]


async def test_pubsub_roundtrip(bus) -> None:
    got: list[dict] = []

    async def sub():
        # subscribe 现在是 await 到「频道已加入」才返回（D11），不再是取一次才跑一段
        async for ev in await bus.subscribe("chan.a"):
            got.append(ev)
            if len(got) >= 2:
                return

    t = asyncio.create_task(sub())
    await asyncio.sleep(0.05)
    await bus.publish("chan.a", env(1))
    await bus.publish("chan.a", env(2))
    await asyncio.wait_for(t, 5)
    assert [e["seq"] for e in got] == [1, 2]
    assert set(got[0]) == {"seq", "ts", "type", "payload"}


async def test_sse_replay_cursor(bus) -> None:
    """cursor=0 收全 5；cursor=3 只收 4,5 —— 重放与直播同信封不重不漏【RF2】。"""
    from app.core.sse import sse_response

    store = [env(i) for i in range(1, 6)]
    replay = lambda cur: [e for e in store if e["seq"] > cur]  # noqa: E731

    req = _fake_request()
    resp = sse_response(req, "chan.b", replay, cursor=0)
    frames = await _read_frames(resp, 5)
    assert [f["data"]["seq"] for f in frames] == [1, 2, 3, 4, 5]
    assert all(f["event"] == f["data"]["type"] and f["id"] == str(f["data"]["seq"]) for f in frames)

    resp2 = sse_response(_fake_request(), "chan.b", replay, cursor=3)
    frames2 = await _read_frames(resp2, 2)
    assert [f["data"]["seq"] for f in frames2] == [4, 5]


async def test_sse_replay_then_live_no_dup(bus) -> None:
    """重放 1..3，直播 2..5（2、3 是竞态重复）→ 输出 1,2,3,4,5 恰好一次。"""
    from app.core.sse import sse_response

    store = [env(i) for i in range(1, 4)]
    replay = lambda cur: [e for e in store if e["seq"] > cur]  # noqa: E731

    async def pump():
        await asyncio.sleep(0.1)
        for i in (2, 3, 4, 5):
            await bus.publish("chan.c", env(i))

    t = asyncio.create_task(pump())
    resp = sse_response(_fake_request(), "chan.c", replay, cursor=0)
    frames = await _read_frames(resp, 5)
    await t
    assert [f["data"]["seq"] for f in frames] == [1, 2, 3, 4, 5]


async def test_last_event_id_header(bus) -> None:
    from app.core.sse import sse_response

    store = [env(i) for i in range(1, 6)]
    replay = lambda cur: [e for e in store if e["seq"] > cur]  # noqa: E731

    req = _fake_request(headers=[(b"last-event-id", b"4")])
    resp = sse_response(req, "chan.d", replay, cursor=None)
    frames = await _read_frames(resp, 1)
    assert frames[0]["data"]["seq"] == 5


async def test_subscribe_is_joined_when_it_returns(bus) -> None:
    """D11 第一半：`await bus.subscribe()` 返回时频道必须已加入。

    它曾是 async generator——`bus.subscribe(ch)` 那一行什么都不做，函数体要到第一次
    __anext__ 才跑，于是「先订阅再重放」是假的。这条不留 sleep：订阅→**立刻**发布→再读，
    旧形状下这条事件在订阅生效前就发完了，必然收不到。
    """
    sub = await bus.subscribe("chan.join")
    await bus.publish("chan.join", env(1))
    got = await asyncio.wait_for(sub.__anext__(), 5)
    assert got["seq"] == 1
    await sub.aclose()


async def test_first_frame_published_during_replay_is_not_lost(bus) -> None:
    """D11 的首帧形状，钉成确定性的红：事件恰好在**重放进行中**发布且重放看不见它。

    真实现场是「seq 1 在 POST /run 返回前就发了」，界面上 `[2]…[6]` 全在、独缺 `[1]`。
    这里把时序做成必然：replay_fn 自己发布 seq 1 并回空列表（等价于「发布晚于重放快照」），
    那么 seq 1 只能靠直播订阅送达——而直播订阅必须在重放**之前**就已生效才收得到。
    """
    from app.core.sse import sse_response

    async def replay_publishing_inside(cur: int) -> list[dict]:
        await bus.publish("chan.first", env(1))
        return []

    resp = sse_response(_fake_request(), "chan.first", replay_publishing_inside, cursor=0)
    frames = await _read_frames(resp, 1, timeout=5.0)
    assert [f["data"]["seq"] for f in frames] == [1], "首帧在重放窗口里发布 → 丢了（D11）"


async def test_sse_build_resets_the_read_snapshot_without_touching_replays() -> None:
    """D11 第二半：换读快照的点在**建流处**，且重放函数绝不替调用方回滚。

    MySQL 实测 REPEATABLE-READ（`SELECT @@transaction_isolation`），SSE 路由在鉴权与「运行
    存在性」两处已经发过 SELECT，快照即被钉住；重放沿用就查不到其后 commit 的行。
    但换快照不能放进 `replay_events`/`store.replay`——那两条也服务 REST 路，回滚会把调用方
    尚未提交的写一起丢掉（本仓真实踩过：改在重放里 rollback 后，一条在 flush 之后取消息的
    测试立刻变红）。所以两条都钉：建流先 rollback 再建流；重放本身一次 rollback 都不发。
    """
    from app.modules.scenario.routes import build_run_sse

    calls: list[str] = []

    class _Db:
        async def rollback(self) -> None:
            calls.append("rollback")

    resp = await build_run_sse(_Db(), _fake_request(), "p1", "run-1", 0)
    assert resp.media_type == "text/event-stream"
    assert calls == ["rollback"], f"建流没换读快照，调用={calls}"

    # 重放函数不得动事务：REST 路的 session 上有调用方未提交的写
    from app.modules.scenario.engine.events import replay_events

    class _Result:
        def scalars(self) -> _Result:
            return self

        def all(self) -> list:
            return []

    class _ReadDb:
        async def rollback(self) -> None:
            calls.append("replay-rollback")

        async def execute(self, *_a, **_k) -> _Result:
            calls.append("execute")
            return _Result()

    await replay_events(_ReadDb(), "run-1", 0)
    assert "replay-rollback" not in calls, f"重放替调用方回滚了，调用={calls}"
    assert calls[-1] == "execute"


def _fake_request(headers=None):
    from starlette.requests import Request

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/x",
        "query_string": b"",
        "headers": headers or [],
        "client": ("127.0.0.1", 1234),
        "scheme": "http",
        "server": ("test", 80),
        "root_path": "",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(scope, receive)
