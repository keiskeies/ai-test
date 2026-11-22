"""T11 假模型回放 + ReAct Runner（金线闭环 + Review Focus 3 自纠）。"""
from __future__ import annotations

from pathlib import Path

import pytest_asyncio
from sqlalchemy import select

from app.modules.agent.models import AgentMessage, AgentRun, AgentSession

FIXTURES = Path(__file__).parent / "fixtures" / "fake_model"


@pytest_asyncio.fixture()
async def bus():
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


async def _mk(client, make_user, engine, tag, mode="FULL"):
    _, h = await make_user("runner_" + tag)
    r = await client.post("/api/v1/projects", json={"name": "run_proj_" + tag}, headers=h)
    assert r.status_code == 201, r.text
    me = (await client.get("/api/v1/auth/me", headers=h)).json()
    from sqlalchemy.ext.asyncio import AsyncSession

    s2 = AsyncSession(bind=engine, expire_on_commit=False)
    sess = AgentSession(project_id=r.json()["id"], user_id=me["id"], title="t11", mode=mode)
    s2.add(sess)
    await s2.commit()
    return s2, sess, r.json()["id"]


def _fixture_for(name: str, pid: str, tmp_path) -> Path:
    text = (FIXTURES / (name + ".jsonl")).read_text(encoding="utf-8").replace("{{PID}}", pid)
    out = Path(tmp_path) / (name + ".jsonl")
    out.write_text(text, encoding="utf-8")
    return out


async def _run(client, make_user, engine, bus, tmp_path, name, tag, mode="FULL"):
    from app.modules.agent import store
    from app.modules.agent.dispatcher import ToolDispatcher
    from app.modules.agent.gateway import FakeGateway
    from app.modules.agent.runner import AgentRunner

    s2, sess, pid = await _mk(client, make_user, engine, tag, mode)
    fixture = _fixture_for(name, pid, tmp_path)
    await store.append_event(s2, sess.id, None, "USER", {"text": "帮我建一个查询订单接口"})
    runner = AgentRunner(gateway=FakeGateway(fixture), dispatcher=ToolDispatcher(s2))
    await runner.run_turn(sess.id)
    rows = (await s2.execute(select(AgentMessage).where(AgentMessage.session_id == sess.id).order_by(AgentMessage.seq))).scalars().all()
    return s2, sess, pid, rows


async def test_basic_two_tools_sequence(client, session, engine, bus, make_user, tmp_path) -> None:
    s2, sess, pid, rows = await _run(client, make_user, engine, bus, tmp_path, "basic_two_tools", "basic")
    types = [m.type for m in rows]
    assert types == ["USER", "THINKING", "TOOL_CALL", "TOOL_RESULT", "THINKING", "TOOL_CALL", "TOOL_RESULT", "TEXT", "USAGE", "RUN_END"]
    assert rows[9].payload == {"status": "DONE"}
    # 聚合：连续 delta 合并成一段
    assert rows[1].payload["text"] == "先看看项目里有哪些环境，再创建查询订单接口。"
    assert rows[7].payload["text"] == "已完成：查询到 1 个环境，并创建了接口「查询订单」。"
    assert rows[8].payload == {"input_tokens": 1234, "output_tokens": 456}
    # TOOL_RESULT 内容
    tr1 = rows[3].payload
    assert tr1["ok"] is True and tr1["tool_call_id"] == "tc_1"
    tr2 = rows[6].payload
    assert tr2["ok"] is True and tr2["produced"][0]["kind"] == "api_definition"
    # 金线闭环：接口真的落库了
    from app.modules.api_test.models import ApiDefinition

    defs = (await s2.execute(select(ApiDefinition).where(ApiDefinition.project_id == pid))).scalars().all()
    assert [d.name for d in defs] == ["查询订单"] and defs[0].status == "complete"
    # run 状态
    run = (await s2.execute(select(AgentRun).where(AgentRun.session_id == sess.id))).scalars().one()
    assert run.status == "DONE" and run.seq == 1
    await s2.close()


async def test_bad_args_then_fix(client, session, engine, bus, make_user, tmp_path) -> None:
    """【RF3】args 校验失败 → TOOL_RESULT ok=False 含字段名 → 模型自纠 → DONE。"""
    s2, sess, pid, rows = await _run(client, make_user, engine, bus, tmp_path, "bad_args_then_fix", "bad")
    types = [m.type for m in rows]
    assert types == ["USER", "THINKING", "TOOL_CALL", "TOOL_RESULT", "TOOL_CALL", "TOOL_RESULT", "TEXT", "USAGE", "RUN_END"]
    bad = rows[3].payload
    assert bad["ok"] is False and bad["tool_call_id"] == "bad_1"
    for field in ("name", "method", "path"):
        assert field in bad["error"]
    good = rows[5].payload
    assert good["ok"] is True
    run = (await s2.execute(select(AgentRun).where(AgentRun.session_id == sess.id))).scalars().one()
    assert run.status == "DONE"
    await s2.close()


async def test_ask_mode_suspends_on_write(client, session, engine, bus, make_user, tmp_path) -> None:
    """ASK 模式写工具 → APPROVAL_REQ + run WAIT_APPROVAL（S0 到挂起为止）。"""
    s2, sess, pid, rows = await _run(client, make_user, engine, bus, tmp_path, "basic_two_tools", "ask", mode="ASK")
    types = [m.type for m in rows]
    assert types[:4] == ["USER", "THINKING", "TOOL_CALL", "TOOL_RESULT"]  # env_list 只读直接过
    assert "APPROVAL_REQ" in types
    assert types.index("APPROVAL_REQ") == types.index("TOOL_CALL", 4) + 1
    assert types[-1] == "RUN_END" and rows[-1].payload == {"status": "WAIT_APPROVAL"}
    run = (await s2.execute(select(AgentRun).where(AgentRun.session_id == sess.id))).scalars().one()
    assert run.status == "WAIT_APPROVAL"
    ap = rows[types.index("APPROVAL_REQ")]
    assert ap.payload["tool_name"] == "api_definition_create" and ap.payload["tool_call_id"] == "tc_2"
    # 审批卡上必须看得见「将要执行的参数」（EventCard 渲染 payload.args）：卡片显示的
    # 参数必须与模型请求的参数逐字相同。挂在 BaseException.args 上会被
    # super().__init__(msg) 覆盖成一句话，审批人只看见 "awaiting approval for ..."，
    # 看不见要建哪个接口就点了批准。
    tc2 = next(m for m in rows if m.type == "TOOL_CALL" and m.payload["tool_call_id"] == "tc_2")
    assert ap.payload["args"] == tc2.payload["args"]
    assert ap.payload["args"]["name"] == "查询订单"
    # 落库那行同理：二期「批准并执行」读的就是这张表的 args
    from app.modules.agent.models import AgentApproval

    ap_row = (await s2.execute(select(AgentApproval).where(AgentApproval.run_id == run.id))).scalars().one()
    assert ap_row.args == tc2.payload["args"]
    await s2.close()
