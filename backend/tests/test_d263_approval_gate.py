"""D263：审批门（ASK 模式下写/破坏性工具的页面批准）。

蓝图 §12.3/§12.2：写工具在 ASK 模式落 APPROVAL_REQ → run WAIT_APPROVAL（挂起零占用）
→ POST /agent/runs/{run_id}/approval → 由落库上下文重建循环续推。
本文件钉死四件事：
① 批准一次：工具真执行、资源真落库，续推后 run DONE；
② 拒绝：补一条 ok=False 的 TOOL_RESULT 让模型看得见「人拒绝了」，资源不落库；
③ 本会话批准：第二次同名工具不再弹审批（approved_grants 只认 decision=="session"）；
④ 鉴权与幂等：非所有者 403、非待批 409、已决 409、未知 run 404。
"""
from __future__ import annotations

import asyncio

import pytest_asyncio
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.modules.agent import gateway, tasks
from app.modules.agent.models import AgentApproval, AgentRun

BASE = "/api/v1"


@pytest_asyncio.fixture()
async def bus():
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


class SeqGateway(gateway.FakeGateway):
    """子类而非直接 FakeGateway：tasks._prepare_runner 只替换 type 恰为 FakeGateway
    的实例（补 project_id），子类原样保留——脚本序列才不会被 base_url 冲掉。"""


def install_gateways(scripts: list[str], pid: str) -> None:
    calls = {"n": 0}

    def factory(cfg):  # noqa: ANN001
        i = min(calls["n"], len(scripts) - 1)
        calls["n"] += 1
        return SeqGateway("fake://" + scripts[i], project_id=pid)

    tasks.set_gateway_factory(factory)


async def _mk(client, make_user, tag: str) -> tuple[str, dict]:
    from app.modules.model_cfg.models import ModelConfig

    _, h = await make_user("d263_" + tag)
    r = await client.post(BASE + "/projects", json={"name": "d263_" + tag}, headers=h)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    async with get_sessionmaker()() as s:
        s.add(ModelConfig(name="d263_model_" + tag, model_type="CHAT", protocol="OPENAI_COMPAT",
                          base_url="fake://d263_suspend", model_name="fake",
                          is_default=True, enabled=True))
        await s.commit()
    return pid, h


async def _new_session(client, h, pid: str, mode: str = "ASK") -> str:
    r = await client.post(BASE + "/agent/sessions", json={"project_id": pid, "mode": mode}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _send(client, h, sid: str, text: str) -> str:
    r = await client.post(BASE + f"/agent/sessions/{sid}/messages", json={"content": text}, headers=h)
    assert r.status_code == 202, r.text
    return r.json()["run_id"]


async def _runs(sid: str) -> list[AgentRun]:
    async with get_sessionmaker()() as s:
        return list((await s.execute(
            select(AgentRun).where(AgentRun.session_id == sid).order_by(AgentRun.seq))).scalars().all())


async def _wait_status(sid: str, wanted: set[str], timeout: float = 10.0) -> AgentRun:
    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        runs = await _runs(sid)
        if runs and runs[-1].status in wanted:
            return runs[-1]
        await asyncio.sleep(0.05)
    raise AssertionError(f"run 未进入 {wanted}: {[r.status for r in await _runs(sid)]}")


async def _wait_all_done(sid: str, count: int, timeout: float = 10.0) -> list[AgentRun]:
    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        runs = await _runs(sid)
        if len(runs) >= count and all(r.status in ("DONE", "ERROR", "CANCELLED") for r in runs):
            return runs
        await asyncio.sleep(0.05)
    raise AssertionError(f"{count} 个 run 未全部终态: {[r.status for r in await _runs(sid)]}")


async def _events(client, h, sid: str) -> list[dict]:
    r = await client.get(BASE + f"/agent/sessions/{sid}/messages?cursor=0&size=500", headers=h)
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _api_names(pid: str) -> list[str]:
    from app.modules.api_test.models import ApiDefinition

    async with get_sessionmaker()() as s:
        rows = (await s.execute(
            select(ApiDefinition).where(ApiDefinition.project_id == pid))).scalars().all()
        return sorted(d.name for d in rows)


async def _approve(client, h, run_id: str, tool_call_id: str, decision: str):
    return await client.post(BASE + f"/agent/runs/{run_id}/approval",
                             json={"tool_call_id": tool_call_id, "decision": decision}, headers=h)


# ══════════ ① 批准一次：真执行、真落库、run 续推到 DONE ══════════
async def test_approve_once_executes_and_resumes(client, make_user, bus) -> None:
    pid, h = await _mk(client, make_user, "once")
    install_gateways(["d263_suspend", "d263_after"], pid)
    try:
        sid = await _new_session(client, h, pid)
        await _send(client, h, sid, "帮我建一个接口")
        run = await _wait_status(sid, {"WAIT_APPROVAL"})
        evs = await _events(client, h, sid)
        req = next(e for e in evs if e["type"] == "APPROVAL_REQ")
        # run_id 必须随事件落库：刷新后的审批卡只有靠它才能回传
        assert req["payload"]["run_id"] == run.id
        assert req["payload"]["tool_call_id"] == "tc_w"
        assert req["payload"]["args"]["name"] == "审批创建的接口"

        r = await _approve(client, h, run.id, "tc_w", "once")
        assert r.status_code == 202, r.text
        runs = await _wait_all_done(sid, 1)
        assert [x.status for x in runs] == ["DONE"], [x.status for x in runs]

        evs = await _events(client, h, sid)
        tr = next(e for e in evs if e["type"] == "TOOL_RESULT" and e["payload"]["tool_call_id"] == "tc_w")
        assert tr["payload"]["ok"] is True and tr["payload"]["produced"]
        dec = next(e for e in evs if e["type"] == "APPROVAL_DECISION")
        assert dec["payload"]["decision"] == "once" and dec["payload"]["tool_call_id"] == "tc_w"
        assert await _api_names(pid) == ["审批创建的接口"]

        async with get_sessionmaker()() as s:
            ap = (await s.execute(select(AgentApproval).where(
                AgentApproval.run_id == run.id))).scalars().one()
            assert ap.decision == "once" and ap.decided_at is not None

        # 幂等：同一审批再点一次 → 409 already_decided，不会执行第二遍
        r2 = await _approve(client, h, run.id, "tc_w", "once")
        assert r2.status_code == 409
        assert r2.json()["code"] == "already_decided"
        assert await _api_names(pid) == ["审批创建的接口"]
    finally:
        tasks.set_gateway_factory(None)


# ══════════ ② 拒绝：模型收到 ok=False 的工具结果，资源不落库 ══════════
async def test_deny_resumes_with_rejection_result(client, make_user, bus) -> None:
    pid, h = await _mk(client, make_user, "deny")
    install_gateways(["d263_suspend", "d263_after"], pid)
    try:
        sid = await _new_session(client, h, pid)
        await _send(client, h, sid, "帮我建一个接口")
        run = await _wait_status(sid, {"WAIT_APPROVAL"})

        r = await _approve(client, h, run.id, "tc_w", "deny")
        assert r.status_code == 202, r.text
        runs = await _wait_all_done(sid, 1)
        assert runs[-1].status == "DONE"

        evs = await _events(client, h, sid)
        tr = next(e for e in evs if e["type"] == "TOOL_RESULT" and e["payload"]["tool_call_id"] == "tc_w")
        assert tr["payload"]["ok"] is False and "拒绝" in tr["payload"]["error"]
        assert await _api_names(pid) == []
    finally:
        tasks.set_gateway_factory(None)


# ══════════ ③ 本会话批准：同名工具第二次不再弹审批 ══════════
async def test_session_grant_skips_second_approval(client, make_user, bus) -> None:
    pid, h = await _mk(client, make_user, "session")
    install_gateways(["d263_suspend", "d263_after", "d263_write_again"], pid)
    try:
        sid = await _new_session(client, h, pid)
        await _send(client, h, sid, "帮我建一个接口")
        run = await _wait_status(sid, {"WAIT_APPROVAL"})
        r = await _approve(client, h, run.id, "tc_w", "session")
        assert r.status_code == 202, r.text
        await _wait_all_done(sid, 1)

        # 第二条消息：同一工具再调 → 会话级授权免批，直接执行到 DONE
        await _send(client, h, sid, "再建一个")
        await _wait_all_done(sid, 2)

        evs = await _events(client, h, sid)
        assert [e["type"] for e in evs].count("APPROVAL_REQ") == 1, [e["type"] for e in evs]
        tr2 = next(e for e in evs if e["type"] == "TOOL_RESULT"
                   and e["payload"]["tool_call_id"] == "tc_w2")
        assert tr2["payload"]["ok"] is True
        assert await _api_names(pid) == sorted(["第二次创建的接口", "审批创建的接口"])
    finally:
        tasks.set_gateway_factory(None)


# ══════════ ④ 鉴权与状态：非所有者 403、非待批 409、未知 404 ══════════
async def test_approval_authorization_and_state_guards(client, make_user, bus) -> None:
    pid, h = await _mk(client, make_user, "guard")
    install_gateways(["d263_suspend"], pid)
    try:
        sid = await _new_session(client, h, pid)
        await _send(client, h, sid, "帮我建一个接口")
        run = await _wait_status(sid, {"WAIT_APPROVAL"})

        # 同项目普通成员也不行：会话是私有工作区，审批只能由所有者/系统管理员做
        member, hm = await make_user("d263_guard_member")
        r = await client.put(BASE + f"/projects/{pid}/members/{member.id}",
                             json={"role_code": "MEMBER"}, headers=h)
        assert r.status_code == 200, r.text
        denied = await _approve(client, hm, run.id, "tc_w", "once")
        assert denied.status_code == 403, denied.text

        # 未知 run / 不存在的 tool_call_id
        assert (await _approve(client, h, "no-such-run", "tc_w", "once")).status_code == 404
        assert (await _approve(client, h, run.id, "no-such-call", "once")).status_code == 404

        # run 已不在等待审批（先中断）→ 409 run_not_waiting，且不执行工具
        assert (await client.post(BASE + f"/agent/sessions/{sid}/interrupt",
                                  json={"run_id": run.id}, headers=h)).status_code == 200
        late = await _approve(client, h, run.id, "tc_w", "once")
        assert late.status_code == 409
        assert late.json()["code"] == "run_not_waiting"
        assert await _api_names(pid) == []
    finally:
        tasks.set_gateway_factory(None)
