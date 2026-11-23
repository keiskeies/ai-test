"""MCP 服务配置 CRUD + 连接测试（§9.8/§11.4.24）。

治理（§9.8）：MCP 配置权仅系统管理员——mcp:server:read 读、mcp:server:manage 写。
env/headers 整串 Fernet 加密落库，回显只给键名；update 时 None=保留、{}=清空。
stdio 型 MCP 本质是「管理员在服务器上执行既定命令」：保存/启停/测试都会拉起进程，
全部走权限位与审计，默认不做容器隔离（与设计文档一致）。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import select

from app.core.errors import ApiError, OkOut, Page, paginate
from app.core.security import dec_key, enc_key
from app.core.service import service
from app.modules.mcp import client as mcp_client
from app.modules.mcp import schemas
from app.modules.mcp.models import McpServer


def _enc_json(data: dict[str, str] | None) -> str | None:
    if not data:
        return None
    return enc_key(json.dumps(data, ensure_ascii=False, sort_keys=True))


def _keys(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        data = json.loads(dec_key(raw))
    except Exception:  # noqa: BLE001 主密钥变更：回显键名失败不 500
        return []
    return sorted(data) if isinstance(data, dict) else []


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _out(s: McpServer) -> schemas.ServerOut:
    live = mcp_client.runtime.is_live(s.id)
    if not s.enabled:
        status = "disabled"
    elif live:
        status = "online"
    else:
        status = s.status or "offline"
    return schemas.ServerOut(
        id=s.id, name=s.name, transport=s.transport, command=s.command or "",
        args=[str(a) for a in (s.args or [])], url=s.url or "",
        env_keys=_keys(s.env_enc), has_headers=bool(s.headers_enc),
        enabled=s.enabled, status=status,
        tool_count=len(s.tool_cache or []), tool_effects=dict(s.tool_effects or {}),
        last_error=s.last_error, last_checked_at=_iso(s.last_checked_at),
        last_latency_ms=s.last_latency_ms,
    )


async def _get(db, server_id: str) -> McpServer:
    row = (await db.execute(select(McpServer).where(McpServer.id == server_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "MCP 服务不存在", 404, {"server_id": server_id})
    return row


async def _apply_probe(db, row: McpServer, *, close_first: bool = False) -> schemas.TestOut:
    """探测 → 落 tool_cache/status/last_*。失败也是结果：保留旧缓存，但状态转 offline。"""
    if close_first:
        await mcp_client.runtime.close(row.id)
    cfg = mcp_client.cfg_from(row)
    outcome = await mcp_client.probe(cfg)
    row.status = "online" if outcome.ok else "offline"
    if outcome.ok:
        row.tool_cache = outcome.tools
        row.last_error = None
    else:
        row.last_error = outcome.error
    row.last_checked_at = datetime.now(UTC)
    row.last_latency_ms = outcome.latency_ms
    await db.commit()
    return schemas.TestOut(
        ok=outcome.ok, latency_ms=outcome.latency_ms, tool_count=len(outcome.tools),
        tools=[schemas.ToolItem(**t) for t in outcome.tools], status=row.status,
        error=outcome.error, last_checked_at=_iso(row.last_checked_at),
    )


@service(
    perm="mcp:server:read", effect="read", name="mcp_server_list",
    description="列出 MCP 服务（状态/工具数/最近错误；env 与 headers 只回键名）",
    http={"method": "GET", "path": "/mcp-servers", "tags": ["mcp"], "status": 200},
    tool=False, resident=False,
)
async def mcp_server_list(payload: schemas.ServerListIn, ctx) -> Page:
    ctx.require("mcp:server:read")
    assert ctx.db is not None
    # 键集分页必须按 cursor_col 排序（paginate 的游标谓词是 id > cursor）；
    # MCP 服务是管理员手工维护的小清单，按 id 升序足够，不做 name 排序的伪游标。
    stmt = select(McpServer).order_by(McpServer.id)
    page = await paginate(ctx.db, stmt, cursor_col=McpServer.id, row_key=lambda r: r.id,
                          cursor=payload.cursor, size=payload.size)
    return Page(items=[_out(s) for s in page.items], next_cursor=page.next_cursor)


@service(
    perm="mcp:server:manage", effect="write", name="mcp_server_create",
    description="登记一个 MCP 服务并立即探测工具（stdio 型会拉起管理员指定的命令）",
    http={"method": "POST", "path": "/mcp-servers", "tags": ["mcp"], "status": 201},
    tool=False, resident=False,
)
async def mcp_server_create(payload: schemas.ServerCreateIn, ctx) -> schemas.ServerOut:
    ctx.require("mcp:server:manage")
    assert ctx.db is not None
    dup = (await ctx.db.execute(select(McpServer).where(McpServer.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "MCP 服务名称已存在", 409, {"name": payload.name})
    row = McpServer(
        name=payload.name, transport=payload.transport, command=payload.command or None,
        args=list(payload.args), env_enc=_enc_json(payload.env),
        url=payload.url or None, headers_enc=_enc_json(payload.headers),
        enabled=payload.enabled, status="disabled" if not payload.enabled else "offline",
        tool_cache=None, tool_effects=dict(payload.tool_effects),
    )
    ctx.db.add(row)
    await ctx.db.flush()
    await ctx.db.commit()
    if row.enabled:
        await _apply_probe(ctx.db, row)
    return _out(row)


@service(
    perm="mcp:server:manage", effect="write", name="mcp_server_update",
    description="修改 MCP 服务；env/headers 留空表示保留旧值，保存后立即重连",
    http={"method": "PATCH", "path": "/mcp-servers/{server_id}", "tags": ["mcp"], "status": 200},
    tool=False, resident=False,
)
async def mcp_server_update(payload: schemas.ServerUpdateIn, ctx) -> schemas.ServerOut:
    ctx.require("mcp:server:manage")
    assert ctx.db is not None
    row = await _get(ctx.db, payload.server_id)
    if payload.name is not None and payload.name != row.name:
        dup = (await ctx.db.execute(select(McpServer).where(
            McpServer.name == payload.name, McpServer.id != row.id))).scalar_one_or_none()
        if dup is not None:
            raise ApiError("conflict", "MCP 服务名称已存在", 409, {"name": payload.name})
        row.name = payload.name
    for field in ("transport", "command", "url", "enabled"):
        v = getattr(payload, field)
        if v is not None:
            setattr(row, field, v)
    if payload.args is not None:
        row.args = list(payload.args)
    if payload.env is not None:
        row.env_enc = _enc_json(payload.env)
    if payload.headers is not None:
        row.headers_enc = _enc_json(payload.headers)
    if payload.tool_effects is not None:
        row.tool_effects = dict(payload.tool_effects)
    await ctx.db.commit()
    # 「保存并重连」：配置变了就丢掉旧会话；启用中则重新探测并刷新工具缓存。
    await mcp_client.runtime.close(row.id)
    if row.enabled:
        await _apply_probe(ctx.db, row)
    else:
        row.status = "disabled"
        await ctx.db.commit()
    return _out(row)


@service(
    perm="mcp:server:manage", effect="destructive", name="mcp_server_delete",
    description="删除 MCP 服务并关闭其常驻连接",
    http={"method": "DELETE", "path": "/mcp-servers/{server_id}", "tags": ["mcp"], "status": 200},
    tool=False, resident=False,
)
async def mcp_server_delete(payload: schemas.ServerIdIn, ctx) -> OkOut:
    ctx.require("mcp:server:manage")
    assert ctx.db is not None
    row = await _get(ctx.db, payload.server_id)
    await mcp_client.runtime.close(row.id)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="mcp:server:manage", effect="write", name="mcp_server_test",
    description="立即连接并列出 MCP 工具；结果写回状态、延迟与工具缓存",
    http={"method": "POST", "path": "/mcp-servers/{server_id}/test", "tags": ["mcp"], "status": 200},
    tool=False, resident=False,
)
async def mcp_server_test(payload: schemas.ServerIdIn, ctx) -> schemas.TestOut:
    ctx.require("mcp:server:manage")
    assert ctx.db is not None
    row = await _get(ctx.db, payload.server_id)
    return await _apply_probe(ctx.db, row, close_first=True)


@service(
    perm="mcp:server:manage", effect="write", name="mcp_server_toggle",
    description="启用/停用 MCP 服务；启用即探测，停用即断开会话",
    http={"method": "POST", "path": "/mcp-servers/{server_id}/toggle", "tags": ["mcp"], "status": 200},
    tool=False, resident=False,
)
async def mcp_server_toggle(payload: schemas.ToggleIn, ctx) -> schemas.ServerOut:
    ctx.require("mcp:server:manage")
    assert ctx.db is not None
    row = await _get(ctx.db, payload.server_id)
    if row.enabled == payload.enabled:
        return _out(row)
    row.enabled = payload.enabled
    await ctx.db.commit()
    if payload.enabled:
        await _apply_probe(ctx.db, row)
    else:
        await mcp_client.runtime.close(row.id)
        row.status = "disabled"
        await ctx.db.commit()
    return _out(row)


@service(
    perm="mcp:server:read", effect="read", name="mcp_server_tools",
    description="查看 MCP 服务的工具缓存（工具预览；不发起实时连接）",
    http={"method": "GET", "path": "/mcp-servers/{server_id}/tools", "tags": ["mcp"], "status": 200},
    tool=False, resident=False,
)
async def mcp_server_tools(payload: schemas.ServerIdIn, ctx) -> schemas.ToolsOut:
    ctx.require("mcp:server:read")
    assert ctx.db is not None
    row = await _get(ctx.db, payload.server_id)
    return schemas.ToolsOut(
        items=[schemas.ToolItem(name=str(t.get("name") or ""),
                                description=str(t.get("description") or ""),
                                input_schema=t.get("input_schema") or {})
               for t in (row.tool_cache or []) if isinstance(t, dict)],
        cached_at=_iso(row.last_checked_at),
    )
