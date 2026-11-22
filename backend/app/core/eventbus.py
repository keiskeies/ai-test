"""事件总线：Redis pub/sub 加速器（seq 真相在库，重放与直播同一信封）。

设计（§9.9）：
- 事件信封 {seq, ts, type, payload}，seq 会话内单调；
- pub/sub 只负责"快"，SSE 侧以 seq 去重合并重放流；
- 测试注入 fakeredis client（init_bus(client=...)）。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

_CHANNEL_PREFIX = "tp"


class _Subscription:
    """已加入频道的订阅：`async for` 取事件，`aclose()` 退订并释放连接。

    与旧的 async generator 版唯一的区别是「加入频道的时机」提前到了 `await subscribe()`
    里——调用方拿到本对象时服务端已经记下这个订阅，重放与直播之间不再有丢事件窗口。
    """

    def __init__(self, ps: Any) -> None:
        self._ps = ps
        self._gen = self._iter()

    async def _iter(self) -> AsyncIterator[dict]:
        async for msg in self._ps.listen():
            if msg.get("type") != "message":
                continue
            try:
                yield json.loads(msg["data"])
            except (KeyError, TypeError, ValueError):
                continue

    def __aiter__(self) -> AsyncIterator[dict]:
        return self._gen

    async def __anext__(self) -> dict:
        return await self._gen.__anext__()

    async def aclose(self) -> None:
        try:
            await self._ps.unsubscribe()
            await self._ps.aclose()
        except Exception:  # pragma: no cover
            pass


class EventBus:
    def __init__(self, client: Any) -> None:
        self._r = client

    @staticmethod
    def channel(name: str) -> str:
        return _CHANNEL_PREFIX + "." + name

    async def publish(self, channel: str, event: dict) -> None:
        await self._r.publish(self.channel(channel), json.dumps(event, ensure_ascii=False, default=str))

    async def subscribe(self, channel: str) -> _Subscription:
        """**await 到返回时，SUBSCRIBE 已在服务端生效**——这个语义是 D11 的修复点。

        它曾经是 async generator：函数体要到调用方第一次 `__anext__` 才执行，所以
        `agen = bus.subscribe(ch)` 这一行什么都没订阅。sse.py 正是这样用的，于是它那行
        「先订阅，消除重放完-再订阅的窗口」的注释在说谎：重放期间发布的事件既不在订阅里，
        又可能不被重放的快照覆盖 → 首帧可丢。改成 await 到频道真的加入，窗口才真的关掉。
        """
        ps = self._r.pubsub()
        await ps.subscribe(self.channel(channel))
        return _Subscription(ps)

    async def lock(self, key: str, ttl: int = 300) -> bool:
        """进程间互斥（SETNX + TTL）：agent.lock.{sid} 防双实例。"""
        return bool(await self._r.set(self.channel("lock." + key), "1", nx=True, ex=ttl))

    async def unlock(self, key: str) -> None:
        await self._r.delete(self.channel("lock." + key))

    # ---- 键级原语（1B T6）：取消旗标与运行租约要带 TTL 的读写，pub/sub 承载不了 ----

    async def set_key(self, key: str, value: str, ttl: int | None = None) -> bool:
        res = await self._r.set(self.channel(key), value, ex=ttl)
        return bool(res)

    async def get_key(self, key: str) -> str | None:
        return await self._r.get(self.channel(key))

    async def del_key(self, key: str) -> int:
        return int(await self._r.delete(self.channel(key)))

    async def exists_key(self, key: str) -> bool:
        return bool(await self._r.exists(self.channel(key)))

    async def ttl_key(self, key: str) -> int:
        """剩余秒数；-1=键存在但无过期，-2=键不存在（Redis 原生语义，调用方按此判）。"""
        return int(await self._r.ttl(self.channel(key)))

    async def set_nx(self, key: str, value: str, ttl: int) -> bool:
        """SET NX EX：仅在键不存在时写入。锁定原语（同 set_key 走 tp. 前缀）。"""
        return bool(await self._r.set(self.channel(key), value, nx=True, ex=ttl))

    async def expire_key(self, key: str, ttl: int) -> bool:
        """续期：把键的过期时间重设为 ttl 秒（锁续期的原子单命令）。"""
        return bool(await self._r.expire(self.channel(key), ttl))

    async def rpush(self, key: str, *values: str) -> int:
        """队尾追加，返回新长度（设备锁 FIFO 队列）。"""
        return int(await self._r.rpush(self.channel(key), *values))

    async def lrange(self, key: str, start: int, end: int) -> list[str]:
        return [str(x) for x in (await self._r.lrange(self.channel(key), start, end) or [])]

    async def lpop(self, key: str) -> str | None:
        v = await self._r.lpop(self.channel(key))
        return str(v) if v is not None else None

    async def lpos(self, key: str, value: str) -> int | None:
        """元素在列表中的位次（0-based）；不存在 → None。RPOS 的 FIFO 等价物：token
        在队里唯一时首位即队位。fakeredis 2.40 无 rpos，真 Redis 的 lpos 语义一致。"""
        return await self._r.lpos(self.channel(key), value)

    async def mget_keys(self, keys: list[str]) -> list[str | None]:
        """批量读多个键：设备卡片墙一次取回整页设备的占用状态，不做 N+1。"""
        if not keys:
            return []
        vals = await self._r.mget(*[self.channel(k) for k in keys])
        return [str(v) if v is not None else None for v in (vals or [])]

    @property
    def client(self):
        """底层 redis client：需要 WATCH/MULTI/EXEC 原子性时（设备锁的 token-校验释放）
        由调用方在事务脚本里用；fakeredis 无 Lua（R140 落码裁定），该原子性由事务提供。"""
        return self._r


    async def aclose(self) -> None:
        await self._r.aclose()


_bus: EventBus | None = None


def init_bus(client: Any | None = None, url: str | None = None) -> EventBus:
    global _bus
    if client is None:
        import redis.asyncio as aioredis

        from app.core.config import get_settings

        u = url or get_settings().redis_url
        client = aioredis.from_url(u, decode_responses=True)
    _bus = EventBus(client)
    return _bus


def get_bus() -> EventBus:
    global _bus
    if _bus is None:
        # 直接返回 init_bus() 的产物：写完 init_bus() 再 return _bus，mypy 看不出
        # 全局被赋值（它在另一个函数里 global 改），仍按 None 报。少一次绕路，语义同。
        return init_bus()
    return _bus
