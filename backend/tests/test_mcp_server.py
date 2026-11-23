"""D265 MCP 服务：登记/探测/启停/权限门 + 运行时调用与 Agent 工具面。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import pytest_asyncio

BASE = "/api/v1"
FAKE_SERVER = str(Path(__file__).with_name("mcp_fake_server.py"))


@pytest_asyncio.fixture(autouse=True)
async def _mcp_runtime_cleanup():
    """每用例独立事件循环：清掉上一轮的常驻连接，避免跨 loop 复用任务。"""
    from app.modules.mcp import client as mcp_client

    await mcp_client.runtime.shutdown()
    yield
    await mcp_client.runtime.shutdown()


async def _admin(make_user, tag: str):
    _, headers = await make_user("mcp_" + tag, admin=True)
    return headers


def _stdio_body(name: str = "fake-tools", **kw):
    body = {"name": name, "transport": "stdio", "command": sys.executable, "args": [FAKE_SERVER]}
    body.update(kw)
    return body


async def test_create_probe_list_tools(client, make_user) -> None:
    h = await _admin(make_user, "crud")
    r = await client.post(BASE + "/mcp-servers", json=_stdio_body(), headers=h)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["status"] == "online" and out["tool_count"] == 2
    assert out["last_latency_ms"] is not None and out["last_error"] is None

    g = await client.get(BASE + "/mcp-servers", headers=h)
    assert g.status_code == 200
    items = g.json()["items"]
    assert [x["name"] for x in items] == ["fake-tools"]
    assert items[0]["status"] == "online"

    t = await client.get(BASE + "/mcp-servers/" + out["id"] + "/tools", headers=h)
    assert t.status_code == 200, t.text
    names = {x["name"] for x in t.json()["items"]}
    assert names == {"echo", "add"}
    echo = next(x for x in t.json()["items"] if x["name"] == "echo")
    assert echo["input_schema"]["properties"]["text"]["type"] == "string"

    # 名称唯一
    dup = await client.post(BASE + "/mcp-servers", json=_stdio_body(), headers=h)
    assert dup.status_code == 409 and dup.json()["code"] == "conflict"


async def test_secrets_masked_and_update_semantics(client, make_user) -> None:
    h = await _admin(make_user, "secret")
    body = _stdio_body(name="sec", env={"TOKEN": "super-secret-value"},
                       headers={"Authorization": "Bearer secret-header"})
    r = await client.post(BASE + "/mcp-servers", json=body, headers=h)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["env_keys"] == ["TOKEN"] and out["has_headers"] is True
    assert "super-secret-value" not in r.text and "secret-header" not in r.text

    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.mcp.models import McpServer

    async with get_sessionmaker()() as s:
        row = (await s.execute(select(McpServer).where(McpServer.id == out["id"]))).scalar_one()
        assert row.env_enc is not None and "super-secret-value" not in row.env_enc
        assert row.headers_enc is not None and "secret-header" not in row.headers_enc

    # 不传 env/headers = 保留
    p = await client.patch(BASE + "/mcp-servers/" + out["id"], json={"name": "sec2"}, headers=h)
    assert p.status_code == 200, p.text
    assert p.json()["env_keys"] == ["TOKEN"] and p.json()["has_headers"] is True
    # 显式 {} = 清空
    p2 = await client.patch(BASE + "/mcp-servers/" + out["id"],
                            json={"env": {}, "headers": {}}, headers=h)
    assert p2.status_code == 200 and p2.json()["env_keys"] == [] and p2.json()["has_headers"] is False


async def test_toggle_and_delete(client, make_user) -> None:
    h = await _admin(make_user, "toggle")
    sid = (await client.post(BASE + "/mcp-servers", json=_stdio_body(name="tg"), headers=h)).json()["id"]
    d = await client.post(BASE + "/mcp-servers/" + sid + "/toggle", json={"enabled": False}, headers=h)
    assert d.status_code == 200 and d.json()["status"] == "disabled"
    e = await client.post(BASE + "/mcp-servers/" + sid + "/toggle", json={"enabled": True}, headers=h)
    assert e.status_code == 200 and e.json()["status"] == "online"
    # 再次测试连接
    t = await client.post(BASE + "/mcp-servers/" + sid + "/test", json={}, headers=h)
    assert t.status_code == 200 and t.json()["ok"] is True and t.json()["tool_count"] == 2
    rm = await client.delete(BASE + "/mcp-servers/" + sid, headers=h)
    assert rm.status_code == 200
    assert (await client.get(BASE + "/mcp-servers", headers=h)).json()["items"] == []


async def test_http_transport_offline_is_a_result(client, make_user) -> None:
    h = await _admin(make_user, "http")
    r = await client.post(BASE + "/mcp-servers",
                          json={"name": "dead-http", "transport": "http", "url": "http://127.0.0.1:9/mcp"},
                          headers=h)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["status"] == "offline" and out["tool_count"] == 0
    assert out["last_error"]
    t = await client.post(BASE + "/mcp-servers/" + out["id"] + "/test", json={}, headers=h)
    assert t.status_code == 200 and t.json()["ok"] is False and t.json()["error"]


async def test_stdio_requires_command(client, make_user) -> None:
    h = await _admin(make_user, "valid")
    r = await client.post(BASE + "/mcp-servers", json={"name": "bad", "transport": "stdio"}, headers=h)
    assert r.status_code == 422


async def test_permission_gate(client, make_user) -> None:
    h = await _admin(make_user, "gate")
    _, h_ro = await make_user("mcp_ro_user")
    g = await client.get(BASE + "/mcp-servers", headers=h_ro)
    assert g.status_code == 403 and g.json()["code"] == "insufficient_permission"
    c = await client.post(BASE + "/mcp-servers", json=_stdio_body("nope"), headers=h_ro)
    assert c.status_code == 403 and c.json()["code"] == "insufficient_permission"
    # 管理员建的项目成员（PROJECT_ADMIN）同样没有 MCP 治理位
    pid = (await client.post(BASE + "/projects", json={"name": "mcp_proj"}, headers=h)).json()["id"]
    from tests.test_registry import make_user_named

    hs = await make_user_named(client, h, pid, "mcp_pa", "PROJECT_ADMIN")
    g2 = await client.get(BASE + "/mcp-servers", headers=hs)
    assert g2.status_code == 403 and g2.json()["code"] == "insufficient_permission"


async def test_agent_tool_surface_and_call(client, make_user, session) -> None:
    h = await _admin(make_user, "agent")
    pid = (await client.post(BASE + "/projects", json={"name": "mcp_agent_proj"}, headers=h)).json()["id"]
    body = _stdio_body(name="fake-tools", tool_effects={"echo": "read"})
    sid = (await client.post(BASE + "/mcp-servers", json=body, headers=h)).json()["id"]

    tools = await client.get(BASE + "/agent/tools", params={"project_id": pid}, headers=h)
    assert tools.status_code == 200, tools.text
    by_name = {x["name"]: x for x in tools.json()["items"]}
    assert "mcp__fake-tools__echo" in by_name and by_name["mcp__fake-tools__echo"]["effect"] == "read"
    assert by_name["mcp__fake-tools__add"]["effect"] == "write"

    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import NeedApproval, ToolDispatcher

    ctx = ServiceCtx(entry="agent", user_id="u-mcp", db=session, is_system_admin=True, perms={"*"})
    disp = ToolDispatcher(session)
    res = await disp.call("mcp__fake-tools__echo", {"text": "hi"}, ctx, mode="FULL", grants=set())
    assert res.ok is True, res.error
    assert "echo:hi" in str(res.content)

    monkey = await disp.call("mcp__fake-tools__add", {"a": 2, "b": 3}, ctx, mode="FULL", grants=set())
    assert monkey.ok is True and "5" in str(monkey.content)

    # 默认 write：ASK 模式必须走审批门
    with pytest.raises(NeedApproval):
        await disp.call("mcp__fake-tools__add", {"a": 1, "b": 1}, ctx, mode="ASK", grants=set())
    # read 覆写：PLAN 模式放行
    plan = await disp.call("mcp__fake-tools__echo", {"text": "x"}, ctx, mode="PLAN", grants=set())
    assert plan.ok is True

    # 无治理位 → 与不存在同一句话
    ctx2 = ServiceCtx(entry="agent", user_id="u2", db=session, perms={"project:read"},
                      session_id=None)
    denied = await disp.call("mcp__fake-tools__echo", {"text": "x"}, ctx2, mode="FULL", grants=set())
    assert denied.ok is False and denied.error
    # 停用后工具从声明里消失
    await client.post(BASE + "/mcp-servers/" + sid + "/toggle", json={"enabled": False}, headers=h)
    tools2 = await client.get(BASE + "/agent/tools", params={"project_id": pid}, headers=h)
    assert not any(x["name"].startswith("mcp__") for x in tools2.json()["items"])
