"""T16 金线 E2E（§13 S0 判据 1~3 串联）：真 login→项目→环境→HTTP 建接口→Pilot 会话（fake 模型）→落库→审计→只读可见性。

与 test_agent_api 的差别：这里全部走公开 HTTP 接口 + bootstrap 账号真登录，模拟业主手动演示路径全程。
"""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from tests.conftest import ADMIN_PASSWORD

REQ = {"method": "GET", "url": "http://127.0.0.1:9999/order/{id}", "headers": [], "params": [],
       "body": {"type": "none"}, "timeout_ms": 5000,
       "assertions": [{"type": "status_code", "expected": 200}]}


@pytest_asyncio.fixture()
async def bus():
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


@pytest.fixture(autouse=True)
def _prod_gateway():
    """金线走生产装配：fake:// 由 build_gateway 原生识别，无测试注入工厂。"""
    from app.modules.agent import tasks

    tasks.set_gateway_factory(None)
    yield
    tasks.set_gateway_factory(None)


async def _wait_settled(sid: str, timeout: float = 15.0) -> None:
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.agent.models import AgentRun

    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        async with get_sessionmaker()() as s:
            runs = (await s.execute(select(AgentRun).where(AgentRun.session_id == sid))).scalars().all()
        if runs and all(r.status in ("DONE", "ERROR", "CANCELLED") for r in runs):
            return
        await asyncio.sleep(0.05)
    raise AssertionError("金线 run 未收尾: " + sid)


async def test_golden_path(client, session, bus) -> None:
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.api_test.models import ApiDefinition
    from app.modules.audit.models import AuditLog
    from app.modules.iam.bootstrap import run_bootstrap
    from app.modules.model_cfg.models import ModelConfig

    # ① bootstrap → 真登录（业主拿到的是账号密码，不是注入 token）
    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    h = {"Authorization": "Bearer " + r.json()["token"]}

    # ② fake 模型（生产装配语义：出厂种子同构行，base_url=fake://）
    async with get_sessionmaker()() as s:
        cfg = ModelConfig(name="金线假模型", model_type="CHAT", protocol="OPENAI_COMPAT",
                          base_url="fake://basic_two_tools", model_name="fake", enabled=True)
        s.add(cfg)
        await s.commit()
        cid = cfg.id

    # ③ 项目 / 环境（base_url 指靶场）/ HTTP 手工建一个接口
    pid = (await client.post("/api/v1/projects", json={"name": "金线演示项目"}, headers=h)).json()["id"]
    re_ = await client.post("/api/v1/envs", json={
        "project_id": pid, "name": "测试环境",
        "config": {"vars": [["base_url", "http://127.0.0.1:9999"]]}}, headers=h)
    assert re_.status_code == 201, re_.text
    r_api = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "手工建单", "method": "GET", "path": "/order/manual", "request": REQ}, headers=h)
    assert r_api.status_code == 201, r_api.text

    # ④ 同 token 开 Pilot 会话（FULL），发消息，fake 模型回放两工具脚本
    sid = (await client.post("/api/v1/agent/sessions",
                             json={"project_id": pid, "mode": "FULL", "model_id": cid}, headers=h)).json()["id"]
    rmsg = await client.post("/api/v1/agent/sessions/" + sid + "/messages",
                             json={"content": "帮我建一个查询订单接口"}, headers=h)
    assert rmsg.status_code == 202, rmsg.text
    await _wait_settled(sid)

    # ⑤ 事件全序列（历史接口 = SSE 重放的同一数据源）
    rc = await client.get("/api/v1/agent/sessions/" + sid + "/messages", params={"size": 50}, headers=h)
    assert rc.status_code == 200, rc.text
    evs = rc.json()["items"]
    types = [e["type"] for e in evs]
    assert types == ["USER", "THINKING", "TOOL_CALL", "TOOL_RESULT", "THINKING", "TOOL_CALL",
                     "TOOL_RESULT", "TEXT", "USAGE", "RUN_END"]
    assert evs[-1]["payload"] == {"status": "DONE"}
    tr2 = evs[6]["payload"]
    assert tr2["tool_name"] == "api_definition_create" and tr2["ok"] is True
    assert tr2["produced"][0]["kind"] == "api_definition"
    # {{PID}} 占位符已在运行时绑定为真实项目 → 工具结果非错误
    tr1 = evs[3]["payload"]
    assert tr1["tool_name"] == "env_list" and tr1["ok"] is True, tr1

    # ⑥ Agent 创建的接口真实落库（与手工建的并存）
    async with get_sessionmaker()() as s:
        defs = (await s.execute(
            select(ApiDefinition).where(ApiDefinition.project_id == pid).order_by(ApiDefinition.created_at)
        )).scalars().all()
    assert [d.name for d in defs] == ["手工建单", "查询订单"]

    # ⑦ 审计两入口：http（手工/越权）与 agent（工具执行）都在，且动作可分辨
    async with get_sessionmaker()() as s:
        rows = (await s.execute(select(AuditLog))).scalars().all()
    entries = {a.entry for a in rows}
    assert {"http", "agent"} <= entries, entries
    agent_actions = {a.action for a in rows if a.entry == "agent"}
    assert "env_list" in agent_actions and "api_definition_create" in agent_actions
    http_actions = {a.action for a in rows if a.entry == "http"}
    assert "api_definition_create" in http_actions and "env_create" in http_actions

    # ⑧ READONLY 成员：元数据接口无写工具；PLAN 里写工具被拒（只读话术）【§9.4】
    from app.core.security import create_access_token, hash_password
    from app.modules.iam.models import User

    viewer = User(account="golden_viewer", name="只读小李", password_hash=hash_password("Passw0rd!"),
                  status="active")
    session.add(viewer)
    await session.commit()
    rm = await client.put("/api/v1/projects/" + pid + "/members/" + viewer.id,
                          json={"role_code": "READONLY"}, headers=h)
    assert rm.status_code == 200, rm.text
    hs = {"Authorization": "Bearer " + create_access_token(viewer.id)}
    rt = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=hs)
    assert rt.status_code == 200, rt.text
    items = rt.json()["items"]
    assert any(x["name"] == "api_definition_list" for x in items)
    assert not [x for x in items if x["effect"] in ("write", "destructive")]

    # ⑨ PLAN（只读）模式：写工具调用被模式门拒绝，库里不多东西【§9.4】
    async with get_sessionmaker()() as s:
        cfg2 = ModelConfig(name="金线假模型-PLAN", model_type="CHAT", protocol="OPENAI_COMPAT",
                           base_url="fake://plan_write_denied", model_name="fake", enabled=True)
        s.add(cfg2)
        await s.commit()
        cid2 = cfg2.id
    sid2 = (await client.post("/api/v1/agent/sessions",
                              json={"project_id": pid, "mode": "PLAN", "model_id": cid2}, headers=h)).json()["id"]
    r2 = await client.post("/api/v1/agent/sessions/" + sid2 + "/messages",
                           json={"content": "建个接口"}, headers=h)
    assert r2.status_code == 202, r2.text
    await _wait_settled(sid2)
    rc2 = await client.get("/api/v1/agent/sessions/" + sid2 + "/messages", params={"size": 50}, headers=h)
    evs2 = rc2.json()["items"]
    tr = [e for e in evs2 if e["type"] == "TOOL_RESULT"][0]["payload"]
    assert tr["ok"] is False and "只读" in tr["error"]
    async with get_sessionmaker()() as s:
        defs2 = (await s.execute(select(ApiDefinition).where(ApiDefinition.project_id == pid))).scalars().all()
    assert [d.name for d in defs2] == ["手工建单", "查询订单"]  # 未被 PLAN 会话污染

