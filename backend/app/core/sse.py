"""SSE：游标续传（Review Focus 2 钉此处）。

帧格式：id: {seq}\nevent: {type}\ndata: {json}\n\n
顺序：先建订阅 → 再重放 seq > cursor → 直播按 seq 去重合并 ⇒ 不重不漏。
"""
from __future__ import annotations

import inspect
import json
from collections.abc import Awaitable, Callable

from starlette.requests import Request
from starlette.responses import StreamingResponse

ReplayFn = Callable[[int], "list[dict] | Awaitable[list[dict]]"]


def _frame(ev: dict) -> str:
    return "id: {}\nevent: {}\ndata: {}\n\n".format(ev.get("seq"), ev.get("type"), json.dumps(ev, ensure_ascii=False, default=str))


def _cursor_from(request: Request, cursor: int | None) -> int:
    if cursor is not None:
        return int(cursor)
    hdr = request.headers.get("last-event-id")
    try:
        return int(hdr) if hdr else 0
    except ValueError:
        return 0


def sse_response(request: Request, channel: str, replay_fn: ReplayFn, cursor: int | None = None) -> StreamingResponse:
    from app.core.eventbus import get_bus

    start = _cursor_from(request, cursor)

    async def stream():
        bus = get_bus()
        # 必须 await：subscribe 到返回时频道才真的加入。它曾是 async generator，
        # 「取一次才跑一段」⇒ 这一行什么都没订阅，下面的重放就活在一个没关掉的窗口里
        # （D11 首帧丢失的第一半；另一半是重放用的读快照太旧，由 replay_fn 自己负责）。
        sub = await bus.subscribe(channel)
        last = start
        try:
            replayed = replay_fn(start)
            if inspect.isawaitable(replayed):
                replayed = await replayed
            for ev in replayed or []:
                seq = int(ev.get("seq", 0))
                if seq <= last:
                    continue
                last = seq
                yield _frame(ev)
            while True:
                if await request.is_disconnected():
                    return
                try:
                    ev = await sub.__anext__()
                except StopAsyncIteration:
                    return
                seq = int(ev.get("seq", 0))
                if seq <= last:  # 重放期竞态重复 → 丢弃
                    continue
                last = seq
                yield _frame(ev)
        finally:
            await sub.aclose()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
