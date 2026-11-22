"""T10 agent 表 + append-only 事件存储（seq 单调、重放、总线同信封）。"""
from __future__ import annotations

import asyncio

import pytest_asyncio
from sqlalchemy import select

from app.modules.agent.models import AgentMessage, AgentSession


@pytest_asyncio.fixture()
async def bus():
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


async def _mk_project(client, make_user, tag):
    _, h = await make_user("storeboss_" + tag)
    r = await client.post("/api/v1/projects", json={"name": "store_proj_" + tag}, headers=h)
    assert r.status_code == 201, r.text
    me = (await client.get("/api/v1/auth/me", headers=h)).json()
    return r.json()["id"], me["id"]


async def test_append_seq_monotonic_concurrent(client, session, engine, bus, make_user) -> None:
    from app.modules.agent import store

    pid, uid = await _mk_project(client, make_user, "c")
    sess = AgentSession(project_id=pid, user_id=uid, title="t10")
    session.add(sess)
    await session.commit()

    received: list[dict] = []

    async def sub():
        # subscribe 现在 await 到「频道已加入」才返回（D11）
        async for ev in await bus.subscribe("agent." + sess.id):
            received.append(ev)
            if len(received) >= 20:
                return

    t = asyncio.create_task(sub())
    await asyncio.sleep(0.05)

    async def writer(tag: str):
        from sqlalchemy.ext.asyncio import AsyncSession

        async with AsyncSession(bind=engine, expire_on_commit=False) as s2:  # 独立连接才谈得上并发防重
            for i in range(10):
                await store.append_event(s2, sess.id, None, "TEXT", {"text": tag + str(i)})

    await asyncio.gather(writer("a"), writer("b"))
    await asyncio.wait_for(t, 10)

    rows = (await session.execute(
        select(AgentMessage).where(AgentMessage.session_id == sess.id).order_by(AgentMessage.seq))).scalars().all()
    assert [m.seq for m in rows] == list(range(1, 21))  # 无重复无空洞
    assert len(received) == 20
    assert sorted(e["seq"] for e in received) == list(range(1, 21))
    from sqlalchemy.ext.asyncio import AsyncSession

    async with AsyncSession(bind=engine, expire_on_commit=False) as s2:
        envs = await store.replay(s2, sess.id, 0)
    assert [e["seq"] for e in envs] == list(range(1, 21))
    assert set(envs[0]) == {"seq", "ts", "type", "payload"}


async def test_replay_cursor(client, session, engine, bus, make_user) -> None:
    from app.modules.agent import store

    pid, uid = await _mk_project(client, make_user, "r")
    sess = AgentSession(project_id=pid, user_id=uid, title="t10r")
    session.add(sess)
    await session.commit()
    from sqlalchemy.ext.asyncio import AsyncSession

    async with AsyncSession(bind=engine, expire_on_commit=False) as s2:
        for i in range(5):
            await store.append_event(s2, sess.id, None, "TEXT", {"i": i})
        envs = await store.replay(s2, sess.id, 3)
    assert [e["seq"] for e in envs] == [4, 5]
    assert envs[0]["payload"] == {"i": 3}


async def test_tables_columns(engine) -> None:
    from sqlalchemy import inspect as sa_inspect

    def _cols(sync_conn):
        insp = sa_inspect(sync_conn)
        return {t: {c["name"] for c in insp.get_columns(t)} for t in insp.get_table_names()}

    async with engine.connect() as conn:
        cols = await conn.run_sync(_cols)
    assert {"id", "session_id", "run_id", "seq", "type", "payload"} <= cols["agent_message"]
    assert {"id", "project_id", "user_id", "mode", "thinking"} <= cols["agent_session"]
    assert {"id", "run_id", "tool_call_id", "decision"} <= cols["agent_approval"]
    assert {"id", "session_id", "seq", "status", "lease_owner"} <= cols["agent_run"]
