"""MCP 客户端运行时（§9.8）：stdio / sse / streamable-HTTP 连接、工具发现、懒启动与会话复用。

为什么不每次调用都新开连接：stdio 型要拉起子进程（npx/uvx/python），每次新开等于
每轮对话重付一次启动成本；设计文档给的是「会话首次调用懒启动，闲置 15 分钟卸载」。
MCP SDK 的连接上下文内部是 anyio task group，**进入与退出必须在同一个 asyncio 任务里**
（跨任务 __aexit__ 会报 cancel scope 错误），所以每个 server 用一个常驻任务持有连接、
通过队列接收调用——连接的生命周期与调用方的任务解耦。

工具发现（test / 保存并重连）走一次性连接：它要的是「此刻能不能连上、有哪些工具」，
不复用会话，失败也不污染正在跑的运行时。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import match_perm
from app.core.security import dec_key
from app.modules.mcp.models import McpServer

log = logging.getLogger("testpilot.mcp")

CONNECT_TIMEOUT = 15.0
CALL_TIMEOUT = 60.0
IDLE_SECONDS = 15 * 60
SWEEP_INTERVAL = 60.0
TOOL_PERM = "mcp:server:manage"


@dataclass(frozen=True)
class ServerConfig:
    """ORM 行 → 不可变快照：常驻任务不持有会话对象，避免 detach/过期属性。"""

    id: str
    name: str
    transport: str
    command: str
    args: tuple[str, ...]
    env: dict[str, str]
    url: str
    headers: dict[str, str]
    tool_cache: tuple[dict, ...] = ()
    tool_effects: dict[str, str] = field(default_factory=dict)


def _dec_json(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    try:
        data = json.loads(dec_key(raw))
    except Exception:  # noqa: BLE001 主密钥变更/旧数据：按空处理，连接照常尝试
        return {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def cfg_from(server: McpServer) -> ServerConfig:
    return ServerConfig(
        id=server.id,
        name=server.name,
        transport=server.transport,
        command=server.command or "",
        args=tuple(str(a) for a in (server.args or [])),
        env=_dec_json(server.env_enc),
        url=server.url or "",
        headers=_dec_json(server.headers_enc),
        tool_cache=tuple(t for t in (server.tool_cache or []) if isinstance(t, dict)),
        tool_effects={str(k): str(v) for k, v in (server.tool_effects or {}).items()},
    )


def _transport(cfg: ServerConfig):
    if cfg.transport == "stdio":
        env = {**os.environ, **cfg.env}
        return stdio_client(StdioServerParameters(command=cfg.command, args=list(cfg.args), env=env))
    if cfg.transport == "sse":
        return sse_client(cfg.url, headers=cfg.headers or None)
    if cfg.transport == "http":
        return streamable_http_client(cfg.url)
    raise ValueError("未知 MCP transport: " + cfg.transport)


def _fmt_error(exc: BaseException) -> str:
    """anyio 的 task group 会把单条错误包进 ExceptionGroup；消息取最内层那句。"""
    cur: BaseException = exc
    seen = 0
    while isinstance(cur, BaseExceptionGroup) and cur.exceptions and seen < 8:
        cur = cur.exceptions[0]
        seen += 1
    msg = str(cur).strip() or type(cur).__name__
    return f"{type(cur).__name__}: {msg}"[:500]


def _tool_rows(result: Any) -> list[dict]:
    rows = []
    for t in getattr(result, "tools", []) or []:
        schema = getattr(t, "input_schema", None) or {"type": "object", "properties": {}}
        rows.append({"name": str(t.name), "description": str(t.description or ""),
                     "input_schema": schema})
    return rows


@dataclass
class ProbeOutcome:
    ok: bool
    latency_ms: int = 0
    tools: list[dict] = field(default_factory=list)
    error: str | None = None


async def probe(cfg: ServerConfig) -> ProbeOutcome:
    """一次性连接：initialize + list_tools。失败不抛，落成 ok=False + 人话错误。"""
    t0 = time.perf_counter()
    try:
        async with asyncio.timeout(CONNECT_TIMEOUT):
            async with _transport(cfg) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    res = await session.list_tools()
        return ProbeOutcome(True, int((time.perf_counter() - t0) * 1000), _tool_rows(res))
    except Exception as exc:  # noqa: BLE001 探测失败是结果，不是异常
        return ProbeOutcome(False, int((time.perf_counter() - t0) * 1000), [], _fmt_error(exc))


def effect_of(cfg: ServerConfig, tool_name: str) -> str:
    """默认 write（保守）；管理员可逐工具覆写为 read。"""
    v = cfg.tool_effects.get(tool_name)
    return "read" if v == "read" else "write"


_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _slug(value: str, limit: int) -> str:
    s = _NAME_RE.sub("_", value).strip("_") or "x"
    return s[:limit]


def exposed_name(server_name: str, tool_name: str) -> str:
    """mcp__<server>__<tool>（§9.4），长度压在 64 内（OpenAI 工具名上限）。"""
    return f"mcp__{_slug(server_name, 24)}__{_slug(tool_name, 32)}"


def declarations(server: McpServer | ServerConfig) -> list[dict]:
    cfg = server if isinstance(server, ServerConfig) else cfg_from(server)
    out = []
    for t in cfg.tool_cache:
        raw = str(t.get("name") or "")
        if not raw:
            continue
        desc = str(t.get("description") or "")
        out.append({
            "name": exposed_name(cfg.name, raw),
            "description": (f"[MCP:{cfg.name}] " + desc)[:1024],
            "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
            "effect": effect_of(cfg, raw),
            "perm": TOOL_PERM,
        })
    return out


async def enabled_servers(db: AsyncSession) -> list[McpServer]:
    rows = await db.execute(select(McpServer).where(McpServer.enabled.is_(True)).order_by(McpServer.id))
    return list(rows.scalars().all())


async def tool_declarations(db: AsyncSession, perms: set[str]) -> list[dict]:
    """给 agent 的工具声明：只对持有 mcp:server:manage 的调用方展开（治理位，§9.8）。"""
    if not match_perm(perms, TOOL_PERM):
        return []
    out: list[dict] = []
    for s in await enabled_servers(db):
        out.extend(declarations(s))
    return out


async def resolve_tool(db: AsyncSession, exposed: str) -> tuple[ServerConfig, str, str] | None:
    """外部工具名 → (server 配置, 原始工具名, effect)。每次现算，改名/换缓存即时生效。"""
    for s in await enabled_servers(db):
        cfg = cfg_from(s)
        for t in cfg.tool_cache:
            raw = str(t.get("name") or "")
            if raw and exposed_name(cfg.name, raw) == exposed:
                return cfg, raw, effect_of(cfg, raw)
    return None


def _content_of(result: Any) -> Any:
    structured = getattr(result, "structured_content", None)
    if structured is not None:
        return structured
    parts: list[Any] = []
    for b in getattr(result, "content", []) or []:
        if getattr(b, "type", "") == "text":
            parts.append(getattr(b, "text", ""))
        else:
            dump = getattr(b, "model_dump", None)
            parts.append(dump(mode="json") if dump else str(b))
    if len(parts) == 1:
        return parts[0]
    return parts


@dataclass
class _Job:
    tool: str
    args: dict
    fut: asyncio.Future


class LiveServer:
    """一个 server 的常驻连接：连接在 _run 任务内建立并在同一任务内关闭。"""

    def __init__(self, cfg: ServerConfig) -> None:
        self.cfg = cfg
        self.queue: asyncio.Queue[_Job | None] = asyncio.Queue()
        self.ready = asyncio.Event()
        self.error: str | None = None
        self.last_used = time.monotonic()
        self._task: asyncio.Task | None = None

    @property
    def dead(self) -> bool:
        return self._task is None or self._task.done()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="mcp-" + self.cfg.id)
        try:
            await asyncio.wait_for(self.ready.wait(), CONNECT_TIMEOUT)
        except TimeoutError:
            self.error = "连接超时（" + str(int(CONNECT_TIMEOUT)) + "s）"
            await self.close()
        if self.error:
            raise RuntimeError(self.error)

    async def _run(self) -> None:
        try:
            async with _transport(self.cfg) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self.ready.set()
                    while True:
                        job = await self.queue.get()
                        if job is None:
                            return
                        self.last_used = time.monotonic()
                        try:
                            res = await asyncio.wait_for(session.call_tool(job.tool, job.args), CALL_TIMEOUT)
                        except Exception as exc:  # noqa: BLE001 回给调用方，不炸常驻任务
                            if not job.fut.done():
                                job.fut.set_exception(RuntimeError(_fmt_error(exc)))
                        else:
                            if not job.fut.done():
                                job.fut.set_result(res)
        except BaseException as exc:  # noqa: BLE001 连接层的 anyio 取消/异常都收在这里
            if isinstance(exc, asyncio.CancelledError):
                self.error = self.error or "连接已关闭"
            else:
                self.error = self.error or _fmt_error(exc)
        finally:
            self.ready.set()
            while not self.queue.empty():
                job = self.queue.get_nowait()
                if job is not None and not job.fut.done():
                    job.fut.set_exception(RuntimeError(self.error or "MCP 会话已关闭"))

    async def call(self, tool: str, args: dict) -> Any:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self.queue.put(_Job(tool, args, fut))
        return await asyncio.wait_for(fut, CALL_TIMEOUT + 5)

    async def close(self) -> None:
        task = self._task
        if task is None:
            return
        if task.done():
            return
        with contextlib.suppress(Exception):
            self.queue.put_nowait(None)
        try:
            await asyncio.wait_for(task, 5)
        except (TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
            task.cancel()
            with contextlib.suppress(BaseException):
                await task


class McpRuntime:
    def __init__(self) -> None:
        self._live: dict[str, LiveServer] = {}
        self._lock = asyncio.Lock()
        self._sweeper: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def is_live(self, server_id: str) -> bool:
        live = self._live.get(server_id)
        return bool(live and not live.dead)

    async def ensure(self, cfg: ServerConfig) -> LiveServer:
        async with self._lock:
            loop = asyncio.get_running_loop()
            if self._loop is not loop:  # 测试每用例新事件循环：旧任务不可能再用
                self._live.clear()
                self._sweeper = None
                self._loop = loop
            live = self._live.get(cfg.id)
            if live is not None and not live.dead:
                return live
            live = LiveServer(cfg)
            await live.start()
            self._live[cfg.id] = live
            self._ensure_sweeper(loop)
            return live

    def _ensure_sweeper(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._sweeper is not None and not self._sweeper.done():
            return
        self._sweeper = loop.create_task(self._sweep(), name="mcp-idle-sweeper")

    async def _sweep(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL)
            now = time.monotonic()
            for sid, live in list(self._live.items()):
                if live.dead:
                    self._live.pop(sid, None)
                    continue
                if now - live.last_used >= IDLE_SECONDS:
                    self._live.pop(sid, None)
                    await live.close()

    async def call(self, cfg: ServerConfig, tool: str, args: dict) -> Any:
        live = await self.ensure(cfg)
        try:
            return await live.call(tool, args)
        except Exception:
            if live.dead:
                self._live.pop(cfg.id, None)
                live = await self.ensure(cfg)
                return await live.call(tool, args)
            raise

    async def close(self, server_id: str) -> None:
        live = self._live.pop(server_id, None)
        if live is not None:
            await live.close()

    async def shutdown(self) -> None:
        sweeper = self._sweeper
        self._sweeper = None
        if sweeper is not None and not sweeper.done():
            sweeper.cancel()
            with contextlib.suppress(BaseException):
                await sweeper
        for sid in list(self._live):
            with contextlib.suppress(BaseException):
                await self.close(sid)
        self._live.clear()


runtime = McpRuntime()


async def call_exposed(db: AsyncSession, exposed: str, args: dict) -> dict:
    """分发器入口：解析外部名 → 真调用 → 统一结果形状（ok/content/error）。"""
    ref = await resolve_tool(db, exposed)
    if ref is None:
        return {"ok": False, "error": "MCP 工具不存在或服务未启用"}
    cfg, raw, _effect = ref
    try:
        result = await runtime.call(cfg, raw, args)
    except Exception as exc:  # noqa: BLE001 工具异常回注模型，不炸 run
        return {"ok": False, "error": _fmt_error(exc)}
    is_error = bool(getattr(result, "is_error", False))
    content = _content_of(result)
    if is_error:
        return {"ok": False, "error": str(content)[:500], "content": content}
    return {"ok": True, "content": content}
