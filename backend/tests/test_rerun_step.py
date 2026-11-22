"""1B T13：单步重跑的上下文重建（§8.3 完整版；计划落点裁定 ①-⑦）。

钉的五条判据（计划 Step 1）+ 两条落地点：
  ① 上游 extract 的变量在重跑中可用 —— 且**只能**来自 vars_snapshot：重跑全程没有
     scenario 行参与（源 run 的图取自 summary_graph，裁定①），变量再别处无来源；
  ② 容器步重跑跑完整子树（语义完整优先），且不外溢到兄弟步骤；
  ③ 指定 row_no 只重跑那一行，新 run 的明细仍按**源行号**落（报告的 #rN 展示键对得上）；
     行号越界 400 且**不留下任何 run 行**（先验后建，孤儿 run 是 T9 就立的规矩）；
  ④ 明细/快照/图三者任一缺失 → 409 snapshot_missing（不是静默造空上下文跑下去——
     「看起来通过其实没有变量」比报错糟糕得多）；
  ⑤ 原 run 的状态与明细一字不动；
  ⑥ last_response 回落：目标步 detail 没有响应时，取同 run 内**按事件 seq** 最近一条
     有响应的步骤（裁定③：run_step_result 没有顺序列，seq 是唯一时间真相）；
  ⑦ 新 run 的 stats/summary_graph 带 rerun_of/rerun_step（T11 接线与报告页跳转的读侧）。
"""
from __future__ import annotations

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import delete, func, select

from app.core.errors import ApiError
from app.core.eventbus import EventBus
from app.modules.execution.models import RunRecord, RunStepResult
from app.modules.scenario.engine.events import publish, write_step
from app.modules.scenario.engine.runner import run_graph, run_single_step

target = FastAPI()
_hits: list[str] = []


@target.get("/login")
async def login():
    _hits.append("login")
    return JSONResponse({"uid": 42, "code": "0"})


@target.get("/order/{oid}")
async def order(oid: str):
    _hits.append("order:" + oid)
    return JSONResponse({"order_id": oid, "status": "PAID"})


@target.post("/c1")
async def c1():
    _hits.append("c1")
    return JSONResponse({"ok": 1})


@target.post("/c2")
async def c2():
    _hits.append("c2")
    return JSONResponse({"ok": 1})


@target.get("/who")
async def who(request: Request):
    _hits.append("who:" + request.headers.get("x-who", ""))
    return JSONResponse({"who": request.headers.get("x-who", ""),
                         "want": request.headers.get("x-want", "")})


TR = ASGITransport(app=target)
BASE = "http://tp-target"


@pytest.fixture(autouse=True)
def _reset_hits():
    _hits.clear()
    yield
    _hits.clear()


@pytest.fixture(autouse=True)
def _boot_registry():
    from app.main import create_app

    create_app()


@pytest.fixture()
def bus():
    return EventBus(FakeAsyncRedis(decode_responses=True))


def node(key, kind, *, config=None, ref=None, children=None, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": ref,
         "config": config or {}, "children": children or []}
    n.update(extra)
    return n


def hd(url, **kw):
    cfg = {"url": url, "method": "GET"}
    cfg.update(kw)
    return cfg


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _actor_admin():
    """合成发起人：让注册表里的 env_resolve 过得去（管理员短路成员校验，同 T8）。"""
    return {"user_id": "t13-sys", "user_name": "t13-sys", "is_system_admin": True,
            "perms": {"*"}, "entry": "web"}


async def _mk_run(session, pid, rid, **kw):
    session.add(RunRecord(id=rid, project_id=pid, subject_type="scenario",
                          subject_id=kw.pop("subject_id", "sc-1"),
                          subject_name=kw.pop("subject_name", "重跑源"), trigger="manual",
                          status="running", **kw))
    await session.commit()


async def _rows(session, rid):
    rs = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == rid))).scalars().all()
    return {(r.step_key, r.row_no): r for r in rs}


# —— ① + ⑦ + ⑤：快照重建、rerun_of 标注、原 run 不动 ——————————————————


async def test_rerun_uses_vars_snapshot_and_annotates_source(session, conn, bus) -> None:
    g = _graph(node("lg", "http_direct", config=hd("${base}/login")),
               node("xt", "extract", config={"rules": [{"var": "uid", "expr": "$.uid"}]}),
               node("pb", "http_direct", config=hd("${base}/order/${uid}")))
    await _mk_run(session, "p1", "src1")
    st = await run_graph(session, project_id="p1", run_id="src1", graph=g,
                         variables={"base": BASE}, transport=TR, bus=bus,
                         actor=_actor_admin())
    assert st["status"] == "passed" and _hits.count("order:42") == 1

    new_id = await run_single_step(session, project_id="p1", source_run_id="src1",
                                   step_key="pb", transport=TR, bus=bus,
                                   actor=_actor_admin())
    assert new_id != "src1"
    new = await session.get(RunRecord, new_id)
    assert new.status == "passed", (new.status, new.error)
    assert _hits.count("order:42") == 2, "重跑真的又打了一次，且用的还是快照里的 uid"
    assert new.stats["rerun_of"] == "src1" and new.stats["rerun_step"] == "pb"
    assert new.summary_graph["rerun_of"] == "src1"
    # 新 run 的图上只有这一步；快照里没有 base 之外的场景层——uid 只能来自 vars_snapshot
    keys = [n["key"] for n in new.summary_graph["nodes"]]
    assert keys == ["pb"]
    rows = await _rows(session, new_id)
    assert set(rows) == {("pb", 0)}
    assert rows[("pb", 0)].status == "pass"
    assert rows[("pb", 0)].vars_snapshot.get("uid") == "42"
    # ⑤：原 run 一字不动
    src = await session.get(RunRecord, "src1")
    await session.refresh(src)
    assert src.status == "passed" and src.stats["total"] == 3
    assert "rerun_of" not in src.stats
    src_rows = await _rows(session, "src1")
    assert len(src_rows) == 3


# —— ②：容器步重跑整个子树，不碰兄弟 ————————————————————————


async def test_rerun_container_executes_whole_subtree(session, conn, bus) -> None:
    g = _graph(node("lp", "loop", config={"mode": "count", "max_iter": 2},
                    children=[node("a1", "http_direct", config=hd("${base}/c1", method="POST")),
                              node("a2", "http_direct", config=hd("${base}/c2", method="POST"))]),
               node("tail", "http_direct", config=hd("${base}/c1", method="POST")))
    await _mk_run(session, "p2", "src2")
    await run_graph(session, project_id="p2", run_id="src2", graph=g,
                    variables={"base": BASE}, transport=TR, bus=bus, actor=_actor_admin())
    assert _hits.count("c1") == 3 and _hits.count("c2") == 2  # 循环2轮×c1 + 尾巴1次

    new_id = await run_single_step(session, project_id="p2", source_run_id="src2",
                                   step_key="lp", transport=TR, bus=bus,
                                   actor=_actor_admin())
    assert _hits.count("c1") == 5, "lp 重跑 = 2 轮 × c1，tail 的那次不重放"
    assert _hits.count("c2") == 4
    rows = await _rows(session, new_id)
    assert {("lp", 0), ("a1", 0), ("a2", 0)} <= set(rows), "子树三行都要在新 run 里有明细"
    assert rows[("lp", 0)].status == "pass"
    new = await session.get(RunRecord, new_id)
    assert new.status == "passed"


# —— ③：数据集行级重跑（只跑一行、按源行号落、越界不留孤儿） ——————


async def _kit_case(client, make_user, tag: str, rows):
    """项目 + 定义 + 用例（绑数据集，断言 $.who == ${want}）。返回 (user, pid, case_id)。"""
    u, h = await make_user("t13" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t13p" + tag},
                             headers=h)).json()["id"]
    did = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "取身份" + tag, "method": "GET", "path": "/who",
        "request": {"method": "GET", "url": "${base}/who",
                    "headers": [["X-Who", "${who}"], ["X-Want", "${want}"]]}})).json()["id"]
    r = await client.post("/api/v1/datasets", headers=h, json={
        "project_id": pid, "name": "ds" + tag, "columns": ["who", "want"], "rows": rows})
    dsid = r.json()["id"]
    cid = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": did, "name": "行用例" + tag, "dataset_id": dsid,
        "assertions": [{"type": "json_path_equals", "path": "$.who", "expected": "${want}"}],
    })).json()["id"]
    return u, pid, cid


async def test_rerun_single_dataset_row(session, conn, client, make_user, bus) -> None:
    u, pid, cid = await _kit_case(client, make_user, "r3",
                                  [["a", "a"], ["b", "b"], ["c", "c"]])
    actor = {"user_id": u.id, "user_name": u.name, "is_system_admin": u.is_system_admin,
             "perms": set(), "entry": "web"}
    g = _graph(node("ds", "api_case", ref=cid))
    await _mk_run(session, pid, "src3")
    st = await run_graph(session, project_id=pid, run_id="src3", graph=g,
                         variables={"base": BASE}, transport=TR, bus=bus, actor=actor)
    assert st["status"] == "passed" and st["rows_total"] == 3

    new_id = await run_single_step(session, project_id=pid, source_run_id="src3",
                                   step_key="ds", row_no=2, transport=TR, bus=bus,
                                   actor=actor)
    new = await session.get(RunRecord, new_id)
    assert new.status == "passed", (new.status, new.error, new.stats)
    assert new.stats["rows_total"] == 1 and new.stats["rerun_row_no"] == 2
    rows = await _rows(session, new_id)
    assert sorted(k for k in rows if k[0] == "ds") == [("ds", 0), ("ds", 2)], \
        "只跑第 2 行，且明细仍落在源行号 2（#r2 展示键与源 run 对齐）"
    assert rows[("ds", 2)].status == "pass"
    assert _hits.count("who:b") == 2 and _hits.count("who:a") == 1 and \
        _hits.count("who:c") == 1, "只有 b 行被重放"

    # 越界：400 且**一个 run 行都不许多出来**（先验后建）
    before = await session.scalar(select(func.count()).select_from(RunRecord))
    with pytest.raises(ApiError) as ei:
        await run_single_step(session, project_id=pid, source_run_id="src3",
                              step_key="ds", row_no=99, transport=TR, bus=bus,
                              actor=actor)
    assert ei.value.http_status == 400 and ei.value.code == "validation_error"
    await session.rollback()
    after = await session.scalar(select(func.count()).select_from(RunRecord))
    assert after == before


async def test_rerun_row_follows_updated_dataset(session, conn, client, make_user,
                                                 bus) -> None:
    """裁定④的可解释语义：源 run 跑完之后数据集被改了 → 行重跑按**新**行值发请求。

    改过的行本来就该按改过的跑；vars 基底仍是当时快照，新行值在其上合并（行最高）。
    数据集收缩后老行号越界 → 400（越界判定走的是**新** resolve 的行数）。
    """
    u, h = await make_user("t13r5")
    pid = (await client.post("/api/v1/projects", json={"name": "t13p5"},
                             headers=h)).json()["id"]
    did = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "取身份5", "method": "GET", "path": "/who",
        "request": {"method": "GET", "url": "${base}/who",
                    "headers": [["X-Who", "${who}"], ["X-Want", "${want}"]]}})).json()["id"]
    r = await client.post("/api/v1/datasets", headers=h, json={
        "project_id": pid, "name": "ds5", "columns": ["who", "want"],
        "rows": [["a", "a"], ["b", "b"]]})
    dsid = r.json()["id"]
    cid = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": did, "name": "行用例5", "dataset_id": dsid,
        "assertions": [{"type": "json_path_equals", "path": "$.who", "expected": "${want}"}],
    })).json()["id"]
    actor = {"user_id": u.id, "user_name": u.name, "is_system_admin": u.is_system_admin,
             "perms": set(), "entry": "web"}
    await _mk_run(session, pid, "src5")
    st = await run_graph(session, project_id=pid, run_id="src5",
                         graph=_graph(node("ds", "api_case", ref=cid)),
                         variables={"base": BASE}, transport=TR, bus=bus, actor=actor)
    assert st["status"] == "passed"

    # 源 run 跑完后改表：第 2 行 b→z，并且只剩 2 行
    patched = await client.patch(f"/api/v1/datasets/{dsid}", headers=h, json={
        "project_id": pid, "rows": [["a", "a"], ["z", "z"]]})
    assert patched.status_code == 200, patched.text

    new_id = await run_single_step(session, project_id=pid, source_run_id="src5",
                                   step_key="ds", row_no=2, transport=TR, bus=bus,
                                   actor=actor)
    new = await session.get(RunRecord, new_id)
    assert new.status == "passed", (new.status, new.error)
    assert _hits.count("who:z") == 1 and _hits.count("who:b") == 1, \
        "重跑按新行值 z 发请求；当年的 b 不再重放"
    rows = await _rows(session, new_id)
    assert rows[("ds", 2)].vars_snapshot.get("who") == "z", "新行值合并进快照基底（行最高）"

    # 收缩到 1 行后，老行号 2 在新数据集上不存在 → 400（越界判定走**新** resolve）
    patched2 = await client.patch(f"/api/v1/datasets/{dsid}", headers=h, json={
        "project_id": pid, "rows": [["z", "z"]]})
    assert patched2.status_code == 200, patched2.text
    before = await session.scalar(select(func.count()).select_from(RunRecord))
    with pytest.raises(ApiError) as ei:
        await run_single_step(session, project_id=pid, source_run_id="src5",
                              step_key="ds", row_no=2, transport=TR, bus=bus,
                              actor=actor)
    assert ei.value.http_status == 400 and ei.value.code == "validation_error"
    await session.rollback()
    after = await session.scalar(select(func.count()).select_from(RunRecord))
    assert after == before


# —— ④：缺什么就说什么（三种形态都叫 snapshot_missing） ——————————


async def test_rerun_snapshot_missing_three_shapes(session, conn, client, make_user,
                                                   bus) -> None:
    await _mk_run(session, "p4", "src4")  # 没有 summary_graph
    with pytest.raises(ApiError) as e1:
        await run_single_step(session, project_id="p4", source_run_id="src4",
                              step_key="x", bus=bus)
    assert e1.value.code == "snapshot_missing" and e1.value.http_status == 409

    # 有图、步骤行存在、vars_snapshot 为 NULL → 缺的是变量快照
    await _mk_run(session, "p4", "src4b",
                  summary_graph=_graph(node("x", "set_var")))
    await write_step(session, "src4b", "x", status="pass", kind="set_var",
                     vars_snapshot=None)
    await publish(session, "src4b", "step/pass", {"key": "x"}, bus=bus)
    with pytest.raises(ApiError) as e2:
        await run_single_step(session, project_id="p4", source_run_id="src4b",
                              step_key="x", bus=bus)
    assert e2.value.code == "snapshot_missing"

    # 图有、边界判得过（数据集真有 2 行）、但该行的明细不存在（跑一半被清理）
    u, pid, cid = await _kit_case(client, make_user, "r6", [["a", "a"], ["b", "b"]])
    actor = {"user_id": u.id, "user_name": u.name, "is_system_admin": u.is_system_admin,
             "perms": set(), "entry": "web"}
    await _mk_run(session, pid, "src4c")
    await run_graph(session, project_id=pid, run_id="src4c",
                    graph=_graph(node("ds", "api_case", ref=cid)),
                    variables={"base": BASE}, transport=TR, bus=bus, actor=actor)
    await session.execute(delete(RunStepResult).where(
        RunStepResult.run_id == "src4c", RunStepResult.row_no == 2))
    await session.commit()
    with pytest.raises(ApiError) as e3:
        await run_single_step(session, project_id=pid, source_run_id="src4c",
                              step_key="ds", row_no=2, transport=TR, bus=bus,
                              actor=actor)
    assert e3.value.code == "snapshot_missing" and e3.value.http_status == 409
    assert "第 2 行" in e3.value.message

    # 跨项目/不存在的源 run → 404（不是 409：连来源都没有）
    with pytest.raises(ApiError) as e4:
        await run_single_step(session, project_id="other", source_run_id="src4c",
                              step_key="ds", bus=bus)
    assert e4.value.http_status == 404


# —— ⑥：last_response 回落按事件 seq 取最近有响应的步骤 ——————————


async def test_rerun_falls_back_to_nearest_response(session, conn, bus) -> None:
    """目标步（assert）自己没有响应明细；重建必须从同 run 里按 seq 找到 h 的响应。

    没有 seq 就没有「最近」：run_step_result 无顺序列、created_at 秒精度排不出来，
    所以插入顺序故意做成 a 在 h 之前——若按表序回落就会拿到空上下文，断言 error。
    """
    view = {"status": 200, "headers": {}, "body": '{"ok": 1}', "elapsed_ms": 5,
            "body_size": 9, "truncated": False}
    g = _graph(node("a", "assert",
                    config={"assertions": [{"type": "status_code", "expected": 200}]}),
               node("h", "http_direct", config=hd("${base}/login")))
    await _mk_run(session, "p6", "src6", summary_graph=g)
    await write_step(session, "src6", "a", status="pass", kind="assert",
                     detail={"request": None, "response": None, "assertions": [],
                             "logs": []},
                     vars_snapshot={})
    await write_step(session, "src6", "h", status="pass", kind="http_direct",
                     detail={"request": None, "response": view, "assertions": [],
                             "logs": []},
                     vars_snapshot={})
    await publish(session, "src6", "step/running", {"key": "h"}, bus=bus)
    await publish(session, "src6", "step/pass", {"key": "h"}, bus=bus)
    await publish(session, "src6", "step/running", {"key": "a"}, bus=bus)
    await publish(session, "src6", "step/pass", {"key": "a"}, bus=bus)

    new_id = await run_single_step(session, project_id="p6", source_run_id="src6",
                                   step_key="a", bus=bus)
    new = await session.get(RunRecord, new_id)
    assert new.status == "passed", (new.status, new.error)
    assert _hits == [], "assert 重跑不发请求——它验的是重建出来的 last_response"
