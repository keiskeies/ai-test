"""D258：场景批量执行（替代前端 N 次单跑 /scenarios/{id}/run）。

语义与 D255–D257 同源，但投递阶段有个绕不开的事实：enqueue 逐条 commit（它要为
broker 不可达时的清理负责），攒不成一批。所以契约拆成两段：

1. 预检全有或全无——重复 id → 422；任一不存在/不在正常态 → 404 零 run；
   统一 env 不可解析 → 404 零 run；
2. 投递逐条进行，回包同时给 `run_ids` 与 `failed[]`——前端不能拿勾选数冒充
   「已启动数」（broker 中途挂掉时前 k 条已经诞生，必须如实回报）。
"""
from __future__ import annotations

import asyncio
import time

import pytest
from fakeredis import FakeAsyncRedis
from sqlalchemy import func, select

from app.core.eventbus import init_bus
from app.modules.execution.models import RunRecord


@pytest.fixture()
def fake_bus():
    """inline 档的 _amain 会 publish 事件；fakeredis 让测试不碰真 Redis。"""
    return init_bus(client=FakeAsyncRedis(decode_responses=True))


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"},
                             headers=h)).json()["id"]
    return h, pid


_GRAPH = {"version": 1, "nodes": [
    {"key": "s1", "kind": "set_var", "name": "s1", "ref": None,
     "config": {"vars": {"a": "1"}}, "children": []}]}


async def _scene(client, h, pid, name: str) -> dict:
    r = await client.post("/api/v1/scenarios",
                          json={"project_id": pid, "name": name,
                                "step_graph": _GRAPH}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _batch_run(client, h, pid, ids, env_id=None):
    body = {"project_id": pid, "scenario_ids": ids}
    if env_id is not None:
        body["env_id"] = env_id
    return await client.post("/api/v1/scenario-batch-run", json=body, headers=h)


async def _total_runs(session) -> int:
    await session.rollback()  # 看别人（inline 协程）刚 commit 的行
    return await session.scalar(select(func.count()).select_from(RunRecord))


async def _wait_terminal(session, run_ids, timeout=20.0):
    """等全部 run 到终态：不让 inline 协程在用例结束后被事件循环兜底销毁。"""
    t0 = time.perf_counter()
    while True:
        await session.rollback()
        rows = (await session.execute(
            select(RunRecord).where(RunRecord.id.in_(run_ids)))).scalars().all()
        if len(rows) == len(run_ids) and all(
                r.status in ("passed", "failed", "error", "cancelled") for r in rows):
            return rows
        if time.perf_counter() - t0 > timeout:
            raise AssertionError("run 未在 " + str(timeout) + "s 内进入终态")
        await asyncio.sleep(0.05)


# ══════════ 1. 批量投递：每条一个 run，触发入口记 manual ══════════
async def test_batch_run_enqueues_each_scenario(session, client, make_user, fake_bus) -> None:
    h, pid = await _setup(client, make_user, "d258a")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")

    r = await _batch_run(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["failed"] == []
    assert len(body["run_ids"]) == 2

    rows = await _wait_terminal(session, body["run_ids"])
    assert {x.subject_id for x in rows} == {a["id"], b["id"]}
    assert all(x.subject_type == "scenario" and x.trigger == "manual" for x in rows)
    assert all(x.status == "passed" for x in rows), [(x.status, x.error) for x in rows]

    # 列表端点能按 subject_type 查到这两条（报告/运行中心的数据源）
    listed = await client.get("/api/v1/runs",
                              params={"project_id": pid, "subject_type": "scenario"},
                              headers=h)
    assert listed.status_code == 200, listed.text
    assert {x["id"] for x in listed.json()["items"]} == set(body["run_ids"])


# ══════════ 2. 预检全有或全无：混入回收站行 → 404 零 run ══════════
async def test_batch_run_rejects_recycled_without_side_effects(
        session, client, make_user, fake_bus) -> None:
    h, pid = await _setup(client, make_user, "d258b")
    a = await _scene(client, h, pid, "甲")
    b = await _scene(client, h, pid, "乙")
    assert (await client.post("/api/v1/scenario-batch-delete",
                              json={"project_id": pid, "scenario_ids": [b["id"]]},
                              headers=h)).status_code == 200
    before = await _total_runs(session)

    r = await _batch_run(client, h, pid, [a["id"], b["id"]])
    assert r.status_code == 404, r.text
    assert r.json()["details"]["scenario_ids"] == [b["id"]]
    assert await _total_runs(session) == before, "预检失败不许留下任何 queued run"

    r2 = await _batch_run(client, h, pid, [a["id"], "no-such-id"])
    assert r2.status_code == 404
    assert r2.json()["details"]["scenario_ids"] == ["no-such-id"]
    assert await _total_runs(session) == before


# ══════════ 3. 重复 id → 422 零 run ══════════
async def test_batch_run_rejects_duplicate_ids(
        session, client, make_user, fake_bus) -> None:
    h, pid = await _setup(client, make_user, "d258c")
    a = await _scene(client, h, pid, "甲")
    before = await _total_runs(session)

    r = await _batch_run(client, h, pid, [a["id"], a["id"]])
    assert r.status_code == 422, r.text
    assert await _total_runs(session) == before


# ══════════ 4. 统一 env 不可解析 → 404 零 run（在预检阶段失败，不是执行期） ══════════
async def test_batch_run_rejects_unknown_env(
        session, client, make_user, fake_bus) -> None:
    h, pid = await _setup(client, make_user, "d258d")
    a = await _scene(client, h, pid, "甲")
    before = await _total_runs(session)

    r = await _batch_run(client, h, pid, [a["id"]], env_id="no-such-env")
    assert r.status_code == 404, r.text
    assert await _total_runs(session) == before
