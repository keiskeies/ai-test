"""1A 金线（§13 判据串联）：真登录 → 全局变量 → Pilot(FULL) 建定义→建用例→用例调试三连 → 运行记录 → 审计 → 可见性/PLAN 门。"""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport

from tests.conftest import ADMIN_PASSWORD


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
    """生产装配：fake:// 原生识别；调试传输注入进程内靶（R28：CI 零真实网络）。"""
    from app.modules.agent import tasks
    from app.modules.api_test import services as api_svc

    target = FastAPI()

    @target.api_route("/{tail:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def _any(tail: str):
        return {"path": "/" + tail, "order_id": "1", "status": "PAID"}

    api_svc.set_debug_transport(lambda: ASGITransport(app=target))
    tasks.set_gateway_factory(None)
    yield
    api_svc.set_debug_transport(None)
    tasks.set_gateway_factory(None)


async def _wait_settled(sid: str, timeout: float = 20.0) -> None:
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


async def test_golden_1a_build_and_debug(client, session, bus) -> None:
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.agent.models import AgentRun
    from app.modules.api_test.models import ApiCase, ApiDefinition
    from app.modules.audit.models import AuditLog
    from app.modules.execution.models import RunRecord
    from app.modules.iam.bootstrap import run_bootstrap
    from app.modules.model_cfg.models import ModelConfig

    # ① 真登录
    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    h = {"Authorization": "Bearer " + r.json()["token"]}

    # ② fake 模型（生产装配）
    async with get_sessionmaker()() as s:
        cfg = ModelConfig(name="1A金线假模型", model_type="CHAT", protocol="OPENAI_COMPAT",
                          base_url="fake://onea_build_and_debug", model_name="fake", enabled=True)
        s.add(cfg)
        await s.commit()
        cid = cfg.id

    # ③ 项目 + 全局变量（base_url 走全局层 = "切环境不改资产" 的金线证明）
    pid = (await client.post("/api/v1/projects", json={"name": "1A金线项目"}, headers=h)).json()["id"]
    rg = await client.post("/api/v1/envs/global-config", json={
        "project_id": pid, "scope_type": "VAR",
        "items": [["base_url", "http://target"], ["token", "tk-demo"]]}, headers=h)
    assert rg.status_code == 200, rg.text

    # ④ Pilot FULL：定义→用例→调试 三连（TR 链接上一步 id）
    sid = (await client.post("/api/v1/agent/sessions",
                             json={"project_id": pid, "mode": "FULL", "model_id": cid}, headers=h)).json()["id"]
    rmsg = await client.post("/api/v1/agent/sessions/" + sid + "/messages",
                             json={"content": "建查询订单1号接口并做一条已支付订单用例，然后调试它"}, headers=h)
    assert rmsg.status_code == 202, rmsg.text
    await _wait_settled(sid)

    # ⑤ 事件序列与三次工具结果
    evs = (await client.get("/api/v1/agent/sessions/" + sid + "/messages",
                             params={"size": 50}, headers=h)).json()["items"]
    types = [e["type"] for e in evs]
    assert types.count("TOOL_CALL") == 3 and types.count("TOOL_RESULT") == 3
    assert evs[-1]["type"] == "RUN_END" and evs[-1]["payload"] == {"status": "DONE"}
    trs = [e for e in evs if e["type"] == "TOOL_RESULT"]
    names = [t["payload"]["tool_name"] for t in trs]
    assert names == ["api_definition_create", "api_case_create", "api_debug"], names
    for t in trs:
        assert t["payload"]["ok"] is True, t["payload"]
    dbg = trs[2]["payload"]["content"]
    assert dbg["ok"] is True and dbg["passed"] is True and dbg["status"] == 200
    assert all(a["passed"] for a in dbg["assertions"]) and len(dbg["assertions"]) == 2  # 定义断言+用例追加

    # ⑥ 资产真实落库且互相链接
    async with get_sessionmaker()() as s:
        defs = (await s.execute(select(ApiDefinition).where(ApiDefinition.project_id == pid))).scalars().all()
        cases = (await s.execute(select(ApiCase).where(ApiCase.project_id == pid))).scalars().all()
        runs = (await s.execute(select(RunRecord).where(RunRecord.project_id == pid))).scalars().all()
        agent_runs = (await s.execute(select(AgentRun).where(AgentRun.session_id == sid))).scalars().all()
    assert [d.name for d in defs] == ["查询订单1号"] and defs[0].status == "complete"
    assert [c.name for c in cases] == ["已支付订单"] and cases[0].definition_id == defs[0].id
    assert cases[0].priority == "P1" and all(r.status == "DONE" for r in agent_runs)
    # ⑦ 运行记录：trigger=agent（入口可区分），subject 链到用例
    assert len(runs) == 1 and runs[0].trigger == "agent"
    assert runs[0].subject_type == "api_case" and runs[0].subject_id == cases[0].id
    assert runs[0].subject_name == "已支付订单" and runs[0].status == "passed"
    rr = await client.get("/api/v1/runs", params={"project_id": pid, "trigger": "agent"}, headers=h)
    assert rr.status_code == 200 and len(rr.json()["items"]) == 1

    # ⑧ 审计：agent 入口三动作 + http 入口（登录/建项目/全局配置）
    async with get_sessionmaker()() as s:
        rows = (await s.execute(select(AuditLog))).scalars().all()
    aa = {a.action for a in rows if a.entry == "agent"}
    assert {"api_definition_create", "api_case_create", "api_debug"} <= aa, aa
    ha = {a.action for a in rows if a.entry == "http"}
    assert "global_config_update" in ha

    # ⑨ READONLY：看不到写工具、私有资产不可见（用第二账号私有用例）
    from app.core.security import create_access_token, hash_password
    from app.modules.iam.models import User

    peer = User(account="g1a_peer", name="同事", password_hash=hash_password("Passw0rd!"), status="active")
    viewer = User(account="g1a_viewer", name="只读", password_hash=hash_password("Passw0rd!"), status="active")
    session.add_all([peer, viewer])
    await session.commit()
    hp = {"Authorization": "Bearer " + create_access_token(peer.id)}
    hv = {"Authorization": "Bearer " + create_access_token(viewer.id)}
    for u in (peer, viewer):
        assert (await client.put("/api/v1/projects/" + pid + "/members/" + u.id,
                                 json={"role_code": "READONLY" if u is viewer else "MEMBER"}, headers=h)).status_code == 200
    rp = await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": defs[0].id, "name": "私有用例", "project_public": False}, headers=hp)
    assert rp.status_code == 201, rp.text
    priv_id = rp.json()["id"]
    # §4.1：私有只对 owner 与管理员可见；其他成员（含 READONLY）404＝不存在
    rg2 = await client.get("/api/v1/api-cases/" + priv_id, params={"project_id": pid}, headers=hv)
    assert rg2.status_code == 404
    rp2 = await client.get("/api/v1/api-cases/" + priv_id, params={"project_id": pid}, headers=hp)
    assert rp2.status_code == 200  # owner 可见
    ra = await client.get("/api/v1/api-cases/" + priv_id, params={"project_id": pid}, headers=h)
    assert ra.status_code == 200  # 管理员可见
    rv = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=hv)
    assert not [x for x in rv.json()["items"] if x["effect"] != "read"]

    # ⑩ PLAN 模式：api_debug 被只读门拒绝，零副作用
    async with get_sessionmaker()() as s:
        cfg2 = ModelConfig(name="1A金线假模型-PLAN", model_type="CHAT", protocol="OPENAI_COMPAT",
                           base_url="fake://plan_debug_denied", model_name="fake", enabled=True)
        s.add(cfg2)
        await s.commit()
        cid2 = cfg2.id
    sid2 = (await client.post("/api/v1/agent/sessions",
                              json={"project_id": pid, "mode": "PLAN", "model_id": cid2}, headers=h)).json()["id"]
    assert (await client.post("/api/v1/agent/sessions/" + sid2 + "/messages",
                                json={"content": "调试一下"}, headers=h)).status_code == 202
    await _wait_settled(sid2)
    evs2 = (await client.get("/api/v1/agent/sessions/" + sid2 + "/messages",
                              params={"size": 50}, headers=h)).json()["items"]
    trp = [e for e in evs2 if e["type"] == "TOOL_RESULT"][0]["payload"]
    assert trp["ok"] is False and "只读" in trp["error"]
    async with get_sessionmaker()() as s:
        runs2 = (await s.execute(select(RunRecord).where(RunRecord.project_id == pid))).scalars().all()
    assert len(runs2) == 1  # PLAN 未新增运行记录
