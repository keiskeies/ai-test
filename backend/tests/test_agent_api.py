"""T12 Agent HTTP/SSE API：会话、忙防护【RF5】、中断、历史、工具可见性【§9.4】。"""
from __future__ import annotations

import asyncio
import json

import pytest
import pytest_asyncio

from tests.test_registry import make_user_named


@pytest_asyncio.fixture()
async def bus():
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


@pytest.fixture(autouse=True)
def _fake_gateway():
    """本模块后台任务默认 FakeGateway（fixture 名由会话 model 决定）。"""
    from app.modules.agent import gateway, tasks

    def factory(cfg):
        name = (cfg.base_url or "")
        if name.startswith("fake://"):
            return gateway.FakeGateway(name)
        return gateway.FakeGateway("fake://basic_two_tools")

    tasks.set_gateway_factory(factory)
    yield
    tasks.set_gateway_factory(None)


async def _mk(client, make_user, tag, mode="FULL", model="fake://basic_two_tools"):
    from app.core.db import get_sessionmaker
    from app.modules.model_cfg.models import ModelConfig

    _, h = await make_user("api_" + tag)
    r = await client.post("/api/v1/projects", json={"name": "api_proj_" + tag}, headers=h)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    async with get_sessionmaker()() as s:
        cfg = ModelConfig(name="m_" + tag, model_type="CHAT", protocol="OPENAI_COMPAT",
                          base_url=model, model_name="fake", is_default=True, enabled=True)
        s.add(cfg)
        await s.commit()
        cfg_id = cfg.id
    return pid, h, cfg_id


async def _wait_done(client, sid, timeout=8.0):
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.agent.models import AgentRun

    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        async with get_sessionmaker()() as s:
            runs = (await s.execute(select(AgentRun).where(AgentRun.session_id == sid))).scalars().all()
        if runs and all(r.status in ("DONE", "ERROR", "CANCELLED") for r in runs):
            return runs
        await asyncio.sleep(0.05)
    raise AssertionError("run 未在超时内结束: " + sid)


async def test_session_create_and_defaults(client, make_user, bus) -> None:
    pid, h, cfg_id = await _mk(client, make_user, "sess")
    r = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "PLAN"}, headers=h)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["mode"] == "PLAN" and body["status"] == "active"
    assert body["model_id"] == cfg_id and body["thinking"] == "medium"

    r2 = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "BOGUS"}, headers=h)
    assert r2.status_code == 422 and r2.json()["code"] == "validation_failed"


async def test_session_create_requires_project_membership(client, make_user) -> None:
    """安全回归：create_session 曾是本文件唯一没把项目门的端点——任何登录用户
    可对任意 project_id 建会话。钉三件事：403 且错误形状与既有门一致；不存在与
    无权同响应；**且行数为零**——只断状态码的话「先落行再报错」也能过。"""
    from sqlalchemy import func, select

    from app.core.db import get_sessionmaker
    from app.modules.agent.models import AgentSession

    pid, h_owner, _ = await _mk(client, make_user, "guard")
    _, h_outsider = await make_user("api_guard_outsider")

    r = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"}, headers=h_outsider)
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "forbidden" and r.json()["message"] == "无此项目权限"

    # 不存在的 project_id 必须同码同形（403 而非 404，不泄露存在性）
    r_x = await client.post("/api/v1/agent/sessions", json={"project_id": "no-such-project"}, headers=h_outsider)
    assert (r_x.status_code, r_x.json()["code"]) == (403, "forbidden")

    async with get_sessionmaker()() as s:
        n = (await s.execute(select(func.count()).select_from(AgentSession))).scalar_one()
    assert n == 0

    # 成员同请求仍 201：门没有顺手打死 happy path
    ok = await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"}, headers=h_owner)
    assert ok.status_code == 201, ok.text


async def test_model_without_tools_refuses_session(client, make_user, bus) -> None:
    """§9.6 `:588`「tools 不支持 → 该模型禁用于操作类会话」的兑现钉。

    此前的行为是**静默降级**：`gateway.py:110` 的 `if tools and model.supports_tools`
    把工具丢掉后照常跑完，轮次还落 DONE——用户看到「助手回答完了」，以为平台被操作过，
    其实模型一个工具都没拿到。蓝图要的是拒绝 + 提示，两条都要有。
    """
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.model_cfg.models import ModelConfig

    pid, h, _ = await _mk(client, make_user, "notools")
    # 把这条会话要用的模型改成「不支持工具」（列默认是 True，所以必须显式翻）
    async with get_sessionmaker()() as s:
        cfg = (await s.execute(select(ModelConfig).where(ModelConfig.name == "m_notools"))).scalar_one()
        cfg.supports_tools = False
        await s.commit()

    sid = (await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"}, headers=h)).json()["id"]
    r = await client.post("/api/v1/agent/sessions/" + sid + "/messages",
                          json={"content": "帮我建查询订单接口"}, headers=h)
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    runs = await _wait_done(client, sid)
    run = next(x for x in runs if x.id == run_id)
    assert run.status == "ERROR", f"不该跑完：{run.status}"
    assert "未开启工具能力" in (run.error or ""), run.error

    # 走 HTTP 历史读，而不是直接查表：「提示」必须是前端拿得到的东西
    g = await client.get("/api/v1/agent/sessions/" + sid + "/messages", params={"cursor": 0}, headers=h)
    assert g.status_code == 200
    items = g.json()["items"]
    types = [e["type"] for e in items]
    assert "ERROR" in types, types
    # 最要紧的一条：真被放行的话 FakeGateway 会吐出 TOOL_CALL——**一条都不许有**
    assert "TOOL_CALL" not in types, f"模型没拿到工具却演了操作：{types}"
    assert types[-1] == "RUN_END" and items[-1]["payload"]["status"] == "ERROR"


async def test_message_flow_and_history(client, make_user, bus) -> None:
    pid, h, _ = await _mk(client, make_user, "flow")
    sid = (await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"}, headers=h)).json()["id"]
    r = await client.post("/api/v1/agent/sessions/" + sid + "/messages",
                          json={"content": "帮我建查询订单接口"}, headers=h)
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    runs = await _wait_done(client, sid)
    assert any(x.id == run_id and x.status == "DONE" for x in runs)

    g = await client.get("/api/v1/agent/sessions/" + sid + "/messages", params={"cursor": 0}, headers=h)
    assert g.status_code == 200
    body = g.json()
    types = [e["type"] for e in body["items"]]
    assert types == ["USER", "THINKING", "TOOL_CALL", "TOOL_RESULT", "THINKING", "TOOL_CALL", "TOOL_RESULT", "TEXT", "USAGE", "RUN_END"]
    # RUN_END 携带最终状态，供前端停止"进行中"指示（产品决策：轮次必须有终态事件）
    assert body["items"][-1]["payload"]["status"] == "DONE"
    assert body["items"][0]["payload"]["text"] == "帮我建查询订单接口"

    # 游标续传：seq>3
    g2 = await client.get("/api/v1/agent/sessions/" + sid + "/messages", params={"cursor": 3}, headers=h)
    assert [e["seq"] for e in g2.json()["items"]] == [4, 5, 6, 7, 8, 9, 10]


async def test_session_busy_409(client, make_user, bus) -> None:
    """【RF5】RUNNING run 期间第二条消息 → 409 session_busy。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.agent import tasks
    from app.modules.agent.models import AgentMessage, AgentRun

    pid, h, _ = await _mk(client, make_user, "busy")
    sid = (await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"}, headers=h)).json()["id"]

    # 手工造 RUNNING run（模拟在跑）+ 慢网关防真任务竞态
    async with get_sessionmaker()() as s:
        run = AgentRun(session_id=sid, seq=1, status="RUNNING")
        s.add(run)
        await s.commit()

    async def _slow_factory(cfg):
        class Slow:
            async def stream(self, **kw):
                await asyncio.sleep(30)
                if False:
                    yield {}
        return Slow()

    tasks.set_gateway_factory(_slow_factory)
    r = await client.post("/api/v1/agent/sessions/" + sid + "/messages", json={"content": "打断我"}, headers=h)
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "session_busy"
    # 未落 USER 事件
    async with get_sessionmaker()() as s:
        n = len((await s.execute(select(AgentMessage).where(AgentMessage.session_id == sid))).scalars().all())
    assert n == 0


async def test_interrupt(client, make_user, bus) -> None:
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.agent.models import AgentMessage, AgentRun

    pid, h, _ = await _mk(client, make_user, "intr")
    sid = (await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"}, headers=h)).json()["id"]
    async with get_sessionmaker()() as s:
        run = AgentRun(session_id=sid, seq=1, status="RUNNING")
        s.add(run)
        await s.commit()
        rid = run.id
    r = await client.post("/api/v1/agent/sessions/" + sid + "/interrupt", json={"run_id": rid}, headers=h)
    assert r.status_code == 200, r.text
    async with get_sessionmaker()() as s:
        run2 = (await s.execute(select(AgentRun).where(AgentRun.id == rid))).scalar_one()
        assert run2.status == "CANCELLED"
        evs = (await s.execute(select(AgentMessage).where(AgentMessage.session_id == sid))).scalars().all()
    assert any(m.type == "ERROR" and m.payload.get("reason") == "interrupted" for m in evs)


async def test_sse_wiring_replay(client, make_user, bus) -> None:
    """GET /events/agent/{sid}：重放帧不重不漏；Last-Event-ID 生效【RF2 接线】。"""
    from starlette.requests import Request

    from app.core.db import get_sessionmaker
    from app.modules.agent.routes import build_agent_sse

    pid, h, _ = await _mk(client, make_user, "sse")
    sid = (await client.post("/api/v1/agent/sessions", json={"project_id": pid, "mode": "FULL"}, headers=h)).json()["id"]
    await client.post("/api/v1/agent/sessions/" + sid + "/messages", json={"content": "hi"}, headers=h)
    await _wait_done(client, sid)

    def req(headers=None):
        scope = {"type": "http", "method": "GET", "path": "/x", "query_string": b"",
                 "headers": headers or [], "client": ("127.0.0.1", 1), "scheme": "http",
                 "server": ("t", 80), "root_path": ""}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        return Request(scope, receive)

    async with get_sessionmaker()() as s:
        resp = await build_agent_sse(s, req(), sid, cursor=6)
        buf = ""
        async for chunk in resp.body_iterator:
            buf += chunk
            if buf.count("\n\n") >= 3:
                break
    frames = [blk for blk in buf.strip().split("\n\n") if blk.strip()]
    seqs = [int(f.split("\n")[0][4:]) for f in frames]
    assert seqs == [7, 8, 9]

    async with get_sessionmaker()() as s:
        resp2 = await build_agent_sse(s, req([(b"last-event-id", b"8")]), sid, cursor=None)
        buf2 = ""
        async for chunk in resp2.body_iterator:
            buf2 += chunk
            break
    assert json.loads(buf2.strip().split("\n")[2][6:])["seq"] == 9


async def test_tool_visibility_readonly(client, make_user, bus) -> None:
    """【§9.4】READONLY 成员：模型声明里没有任何写工具；且发消息被拒。"""

    from app.modules.agent import gateway, tasks

    captured: dict = {}

    class Cap(gateway.FakeGateway):
        async def stream(self, **kw):
            captured["tools"] = kw["tools"]
            async for ev in super().stream(**kw):
                yield ev

    def factory(cfg):
        return Cap("fake://tools_capture")

    tasks.set_gateway_factory(factory)

    pid, hb, _ = await _mk(client, make_user, "vis")
    hs = await make_user_named(client, hb, pid, "viewer", "READONLY")
    sid = (await client.post("/api/v1/agent/sessions", json={"project_id": pid}, headers=hs)).json()["id"]
    r = await client.post("/api/v1/agent/sessions/" + sid + "/messages", json={"content": "看看"}, headers=hs)
    assert r.status_code == 202, r.text
    await _wait_done(client, sid)
    names = {t["name"] for t in captured["tools"]}
    assert "env_list" in names and "api_definition_list" in names
    for w in ("env_create", "api_definition_create", "env_delete", "api_definition_update", "env_update"):
        assert w not in names


async def test_tools_metadata_endpoint(client, make_user, bus) -> None:
    """§12.3 试验台工具元数据：成员可见（name/effect 供前端着色），非成员 403。"""
    pid, h, _ = await _mk(client, make_user, "tools")
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    by_name = {t["name"]: t for t in items}
    assert "api_definition_list" in by_name, sorted(by_name)
    assert by_name["api_definition_list"]["effect"] == "read"
    assert by_name["api_definition_create"]["effect"] == "write"
    # 每条都有着色/展开所需字段
    for t in items:
        assert set(["name", "description", "effect", "perm"]) <= set(t)
    # 非成员不可见
    _, h2 = await make_user("api_tools_outsider")
    r2 = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=h2)
    assert r2.status_code == 403 and r2.json()["code"] == "forbidden"
