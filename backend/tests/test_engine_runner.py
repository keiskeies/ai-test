"""1B T8：顺序解释执行 + 数据集行展开（§8.6 + §8.2 + Review Focus 2/8/10）。

runner 与 handlers 的分工按 handlers 模块 docstring 的原文口径：handler 只管
「每种 kind 做什么」，runner 管「按顺序取节点、落库、发事件、展开数据集行」。
所以这里钉的全是 runner 层语义：步骤序列与两层状态词映射、fail_fast/optional、
数据集行展开（行级变量最高优先级，RF8）、展开上限（RF2 执行期半边）、超时/取消
边界、每步 vars_snapshot、summary_graph 自包含（RF10）。
跨模块只经 REGISTRY（契约 4）：本文件末尾用源码扫描钉「runner 未 import api_test」，
数据集解析能跑通本身就是走注册表的证明。

靶与手法沿用 T7（test_engine_handlers.py）：ASGITransport 内存靶 + fakeredis；
api_case 数据集用 client 造真项目/定义/用例/数据集，api_case_resolve 走注册表。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import select

from app.core.eventbus import EventBus
from app.modules.execution.models import RunEvent, RunRecord, RunStepResult
from app.modules.scenario.engine.events import request_cancel
from app.modules.scenario.engine.runner import run_graph

# —— 内存靶 ——————————————————————————————————————————

target = FastAPI()
_hits: list[str] = []


@target.get("/order")
async def order(request: Request):
    _hits.append("order:" + request.query_params.get("state", "?"))
    return JSONResponse({"id": 7, "state": request.query_params.get("state", "?")})


@target.get("/who")
async def who(request: Request):
    # 把头原样回显成 JSON：变量到底渲染成了什么，断言和测试都看得见内容
    _hits.append("who:" + request.headers.get("x-who", ""))
    return JSONResponse({"who": request.headers.get("x-who", ""),
                         "want": request.headers.get("x-want", "")})


@target.get("/big")
async def big():
    # 大响应体靶：§8.8 的 64KB 线要有真东西可裁（约 300KB，够越过阈值 4 倍）
    return JSONResponse({"blob": "x" * 300_000})


@target.post("/login")
async def login(request: Request):
    _hits.append("login")
    return JSONResponse({"token": "tk-1", "uid": 42, "code": "0"})


TR = ASGITransport(app=target)
BASE = "http://tp-target"


@pytest.fixture(autouse=True)
def _reset_hits():
    _hits.clear()
    yield
    _hits.clear()


@pytest.fixture(autouse=True)
def _boot_registry():
    """env_resolve / api_case_resolve 都从 REGISTRY 取：先装配（与 worker._boot 同手法）。"""
    from app.main import create_app

    create_app()


@pytest.fixture()
def bus():
    return EventBus(FakeAsyncRedis(decode_responses=True))


# —— 脚手架 ——————————————————————————————————————————


def node(key, kind, *, config=None, ref=None, children=None, name=None, **extra):
    n = {"key": key, "kind": kind, "name": name or key, "ref": ref,
         "config": config or {}, "children": children or []}
    n.update(extra)
    return n


def hd(url, **kw):
    cfg = {"url": url, "method": "GET"}
    cfg.update(kw)
    return cfg


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _actor(u):
    return {"user_id": u.id, "user_name": u.name, "is_system_admin": u.is_system_admin,
            "perms": set(), "entry": "web"}


def _actor_admin():
    """合成发起人：只为让注册表里的 env_resolve 过得去（管理员短路项目成员校验）。"""
    return {"user_id": "t8-sys", "user_name": "t8-sys", "is_system_admin": True,
            "perms": {"*"}, "entry": "web"}


async def _mk_run(session, pid, rid):
    """run 行由 T9 的 enqueue 创建；T8 测试自己先落一行（run_graph 终态要回写它）。"""
    session.add(RunRecord(id=rid, project_id=pid, subject_type="scenario",
                          subject_id="sc-1", subject_name="runner 测试", trigger="manual",
                          status="running"))
    await session.commit()


async def _rows(session, rid):
    rs = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == rid)
        .order_by(RunStepResult.step_key, RunStepResult.row_no))).scalars().all()
    return {(r.step_key, r.row_no): r for r in rs}


async def _events(session, rid):
    es = (await session.execute(
        select(RunEvent).where(RunEvent.run_id == rid).order_by(RunEvent.seq))).scalars().all()
    return [(e.type, e.payload or {}) for e in es]


async def _kit(client, make_user, tag, *, ds_rows=None, columns=("who", "want"),
               env=None, global_items=None):
    """项目(+全局变量) → 接口（headers 用 ${who}/${want}）→ 用例（可绑数据集，
    断言 $.who == ${want}）→ 环境。返回 (user, pid, cid, env_id)。

    断言的期望值本身是模板：只有行/场景/环境/全局四层按「行最高」合并过，
    行用例才可能绿——⑥ 用它把 RF8 钉在执行结果上而不是快照上。
    """
    u, h = await make_user("t8" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t8p" + tag},
                             headers=h)).json()["id"]
    if global_items:
        r = await client.post("/api/v1/envs/global-config", headers=h, json={
            "project_id": pid, "scope_type": "VAR", "items": global_items})
        assert r.status_code == 200, r.text
    req = {"method": "GET", "url": "${base}/who",
           "headers": [["X-Who", "${who}"], ["X-Want", "${want}"]]}
    did = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "取身份" + tag, "method": "GET", "path": "/who",
        "request": req})).json()["id"]
    dsid = None
    if ds_rows:
        r = await client.post("/api/v1/datasets", headers=h, json={
            "project_id": pid, "name": "ds" + tag, "columns": list(columns), "rows": ds_rows})
        assert r.status_code == 201, r.text
        dsid = r.json()["id"]
    body = {"project_id": pid, "definition_id": did, "name": "行用例" + tag,
            "dataset_id": dsid,
            "assertions": [{"type": "json_path_equals", "path": "$.who", "expected": "${want}"}]}
    cid = (await client.post("/api/v1/api-cases", headers=h, json=body)).json()["id"]
    eid = None
    if env:
        eid = (await client.post("/api/v1/envs", headers=h, json={
            "project_id": pid, "name": "env" + tag, "config": {"vars": env}})).json()["id"]
    return u, pid, cid, eid


def _who_hits() -> int:
    return sum(1 for h in _hits if h.startswith("who"))


def _order_hits() -> int:
    return sum(1 for h in _hits if h.startswith("order"))


# —— 判据①：三步顺序、状态序列、事件词汇表、summary_graph 自包含 ——————


async def test_step_sequence_status_mapping_and_events(session, conn, bus) -> None:
    await _mk_run(session, "p1", "r1")
    g = _graph(node("s1", "set_var", config={"vars": {"a": "1"}}),
               node("s2", "http_direct",
                    config=hd("${base}/order",
                              assertions=[{"type": "status_code", "expected": 418}])),
               node("s3", "http_direct", config=hd("${base}/order")))
    stats = await run_graph(session, project_id="p1", run_id="r1", graph=g,
                            variables={"base": BASE}, transport=TR, bus=bus,
                            actor=_actor_admin())
    assert stats["status"] == "failed", stats
    assert (stats["total"], stats["pass"], stats["fail"], stats["skip"], stats["error"]) == \
        (3, 1, 1, 1, 0)
    rows = await _rows(session, "r1")
    assert [rows[("s1", 0)].status, rows[("s2", 0)].status, rows[("s3", 0)].status] == \
        ["pass", "fail", "skip"]
    assert rows[("s1", 0)].kind == "set_var" and rows[("s2", 0)].parent_step_key is None
    evs = await _events(session, "r1")
    # skip 的步骤没有 running（没执行过就不该呼吸）；事件词汇表逐字钉死
    assert [t for t, _p in evs] == ["step/running", "step/pass", "step/running",
                                    "step/fail", "step/skip"]
    assert [p["key"] for _t, p in evs] == ["s1", "s1", "s2", "s2", "s3"]
    rec = await session.get(RunRecord, "r1")
    assert rec.status == "failed" and rec.stats["total"] == 3
    sg = rec.summary_graph
    assert sg["nodes"][0]["result"]["status"] == "pass"
    assert sg["nodes"][2]["result"]["status"] == "skip", "报告自包含：不查步骤表也能上色"
    assert sg["nodes"][2]["result"]["message"], "skip 也要说清为什么没跑"


# —— 判据②：fail_fast=true 第 2 步失败 → 第 3 步 skip、run=failed ————


async def test_fail_fast_skips_rest_and_fails_run(session, conn, bus) -> None:
    await _mk_run(session, "p2", "r2")
    g = _graph(node("s1", "http_direct", config=hd("${base}/order")),
               node("s2", "http_direct",
                    config=hd("${base}/order",
                              assertions=[{"type": "status_code", "expected": 500}])),
               node("s3", "http_direct", config=hd("${base}/order")))
    stats = await run_graph(session, project_id="p2", run_id="r2", graph=g, fail_fast=True,
                            variables={"base": BASE}, transport=TR, bus=bus,
                            actor=_actor_admin())
    assert stats["status"] == "failed"
    assert _order_hits() == 2, "第 3 步不得发出请求"
    rows = await _rows(session, "r2")
    assert rows[("s2", 0)].status == "fail" and rows[("s3", 0)].status == "skip"
    assert stats["message"], "run 失败要带着首个失败原因"


# —— 判据③：optional 第 2 步失败 → 第 3 步照跑、run=passed ————————


async def test_optional_failure_does_not_block_or_fail_run(session, conn, bus) -> None:
    await _mk_run(session, "p3", "r3")
    g = _graph(node("s1", "http_direct", config=hd("${base}/order")),
               node("s2", "http_direct", optional=True,
                    config=hd("${base}/order",
                              assertions=[{"type": "status_code", "expected": 500}])),
               node("s3", "http_direct", config=hd("${base}/order")))
    stats = await run_graph(session, project_id="p3", run_id="r3", graph=g, fail_fast=True,
                            variables={"base": BASE}, transport=TR, bus=bus,
                            actor=_actor_admin())
    assert stats["status"] == "passed", "optional 失败既不阻断也不判 run 失败"
    assert _order_hits() == 3, "第 3 步必须照跑"
    rows = await _rows(session, "r3")
    assert rows[("s2", 0)].status == "fail" and rows[("s3", 0)].status == "pass"


# —— 判据④：数据集 3 行 → 3 条 row_no 明细 + 节点 pass + rows_total=3 ——


async def test_dataset_rows_expand_with_progress(session, conn, client, make_user, bus) -> None:
    u, pid, cid, _ = await _kit(client, make_user, "d3",
                                ds_rows=[["a", "a"], ["b", "b"], ["c", "c"]])
    await _mk_run(session, pid, "r4")
    g = _graph(node("ds", "api_case", ref=cid))
    stats = await run_graph(session, project_id=pid, run_id="r4", graph=g,
                            variables={"base": BASE}, transport=TR, bus=bus, actor=_actor(u))
    assert stats["status"] == "passed" and stats["total"] == 1 and stats["pass"] == 1
    assert stats["rows_total"] == 3
    rows = await _rows(session, "r4")
    assert sorted(k for k in rows if k[0] == "ds") == [("ds", 0), ("ds", 1), ("ds", 2), ("ds", 3)]
    assert all(rows[("ds", i)].status == "pass" for i in (1, 2, 3))
    assert rows[("ds", 0)].status == "pass" and rows[("ds", 0)].row_total == 3
    assert _who_hits() == 3
    row_ev = [p for _t, p in await _events(session, "r4") if "row_no" in p]
    assert [p["row_progress"] for p in row_ev] == ["1/3", "2/3", "3/3"], \
        "行进度徽标（§8.6 画布呼吸）的数据源"


# —— 判据⑤：数据集第 2 行失败：fail_fast 拦后续行；非 fail_fast 三行全跑 ——


async def test_dataset_row_failure_respects_fail_fast(session, conn, client, make_user,
                                                      bus) -> None:
    u, pid, cid, _ = await _kit(client, make_user, "d5",
                                ds_rows=[["ok1", "ok1"], ["nope", "X"], ["ok3", "ok3"]])
    await _mk_run(session, pid, "r5a")
    await _mk_run(session, pid, "r5b")
    g = _graph(node("ds", "api_case", ref=cid))
    a = await run_graph(session, project_id=pid, run_id="r5a", graph=g, fail_fast=True,
                        variables={"base": BASE}, transport=TR, bus=bus, actor=_actor(u))
    rows_a = await _rows(session, "r5a")
    assert sorted(k[1] for k in rows_a if k[0] == "ds") == [0, 1, 2], "第 3 行不得执行"
    assert rows_a[("ds", 0)].status == "fail" and rows_a[("ds", 2)].status == "fail"
    assert a["status"] == "failed" and a["rows_total"] == 2
    b = await run_graph(session, project_id=pid, run_id="r5b", graph=g, fail_fast=False,
                        variables={"base": BASE}, transport=TR, bus=bus, actor=_actor(u))
    rows_b = await _rows(session, "r5b")
    assert sorted(k[1] for k in rows_b if k[0] == "ds") == [0, 1, 2, 3]
    assert [rows_b[("ds", i)].status for i in (1, 2, 3)] == ["pass", "fail", "pass"]
    assert rows_b[("ds", 0)].status == "fail", "有一行没过节点就是 fail"
    assert b["status"] == "failed" and b["rows_total"] == 3
    assert _who_hits() == 5, "两轮合计 2+3 次请求"


# —— 判据⑥：行值 > 场景值 > 环境值 > 全局值（Review Focus 8） ————————


async def test_row_vars_beat_scene_env_global(session, conn, client, make_user, bus) -> None:
    u, pid, cid, eid = await _kit(
        client, make_user, "d6", ds_rows=[["row-user", "row-user"]],
        env=[["who", "env-user"], ["envv", "E"]],
        global_items=[["gv", "G"], ["who", "global-user"]])
    await _mk_run(session, pid, "r6")
    g = _graph(node("ds", "api_case", ref=cid))
    stats = await run_graph(session, project_id=pid, run_id="r6", graph=g, env_id=eid,
                            variables={"base": BASE, "gv": "S", "who": "scene-user"},
                            transport=TR, bus=bus, actor=_actor(u))
    # 断言 expected 是 ${want}=row-user、请求头是 ${who}：四层里行最高，这两处才可能绿
    assert stats["status"] == "passed", stats
    assert _hits[-1] == "who:row-user", "实际发出去的头必须用行值"
    rows = await _rows(session, "r6")
    snap = rows[("ds", 1)].vars_snapshot
    assert snap["who"] == "row-user", "行覆盖场景/环境/全局"
    assert snap["envv"] == "E" and snap["gv"] == "S", "行没带的列保留场景/环境/全局（场景胜全局）"
    assert snap["base"] == BASE
    hdrs = rows[("ds", 0)].detail["request"]["headers"]
    assert ["X-Who", "row-user"] in hdrs, "detail 存渲染后的真实请求（§8.3 重跑依据）"


# —— 判据⑦：max_runtime_ms 到点 → 剩余 skip、run=error 且说明超时 ——


async def test_max_runtime_timeout_skips_and_errors(session, conn, bus) -> None:
    await _mk_run(session, "p7", "r7")
    g = _graph(node("s1", "sleep", config={"ms": 200}),
               node("s2", "http_direct", config=hd("${base}/order")))
    stats = await run_graph(session, project_id="p7", run_id="r7", graph=g,
                            max_runtime_ms=1, variables={"base": BASE}, transport=TR,
                            bus=bus, actor=_actor_admin())
    assert stats["status"] == "error"
    assert "超时" in stats["message"] and "max_runtime" in stats["message"], \
        "报告不能只说 error，要指到超时这个原因"
    rec = await session.get(RunRecord, "r7")
    assert rec.status == "error" and "超时" in (rec.error or "")
    assert _order_hits() == 0, "超时后不得再发请求"
    rows = await _rows(session, "r7")
    assert rows[("s2", 0)].status == "skip" and "超时" in (rows[("s2", 0)].detail or {}).get(
        "error", ""), "skip 行要自己说清为什么没跑（报告页逐行展开看的是 detail）"


# —— 判据⑧：展开总数 > expansion_limit → 立即终止 expansion_overflow ——


async def test_expansion_overflow_terminates_run(session, conn, client, make_user,
                                                 bus) -> None:
    u, pid, cid, _ = await _kit(client, make_user, "d8",
                                ds_rows=[[str(i), str(i)] for i in range(600)])
    await _mk_run(session, pid, "r8")
    g = _graph(node("ds", "api_case", ref=cid))
    stats = await run_graph(session, project_id=pid, run_id="r8", graph=g,
                            expansion_limit=500, variables={"base": BASE},
                            transport=TR, bus=bus, actor=_actor(u))
    assert stats["status"] == "error" and "expansion_overflow" in stats["message"]
    assert _who_hits() == 0, "超限必须在发出第一个请求前就拦下，不是静默截断"
    rows = await _rows(session, "r8")
    assert sorted(k[1] for k in rows if k[0] == "ds") == [0], "一行都没展开"
    assert rows[("ds", 0)].status == "error"


# —— 判据⑨：每步 vars_snapshot 非空且随 extract 增长 ——————————————————


async def test_vars_snapshot_nonempty_and_grows_with_extract(session, conn, bus) -> None:
    await _mk_run(session, "p9", "r9")
    g = _graph(node("h", "http_direct",
                    config=hd("${base}/login", method="POST",
                              body={"type": "json", "content": "{}"})),
               node("x", "extract", config={"rules": [{"var": "uid", "expr": "$.uid"}]}),
               node("a", "assert",
                    config={"assertions": [{"type": "status_code", "expected": 200}]}))
    stats = await run_graph(session, project_id="p9", run_id="r9", graph=g,
                            variables={"base": BASE}, transport=TR, bus=bus,
                            actor=_actor_admin())
    assert stats["status"] == "passed", stats
    rows = await _rows(session, "r9")
    s_h = rows[("h", 0)].vars_snapshot
    s_x = rows[("x", 0)].vars_snapshot
    s_a = rows[("a", 0)].vars_snapshot
    assert s_h, "每步都要有快照（§8.3 重跑依据）"
    assert "uid" not in s_h and s_x["uid"] == "42" and len(s_x) > len(s_h)
    assert s_a["uid"] == "42"


# —— 判据⑩：数据集行级作用域（runner :345-349 与 :361）——每行都从场景层重新出发 ——
#
# 为什么这两条必须用 stub handler 钉：行循环（_expand_rows）只 dispatch api_case 那一个
# 节点本身——h_api_case/_send 从不返回 vars，extract/script 节点根本不在行作用域内，
# api_case 也不是容器（children 被忽略）。当前 handler 面里「行内返回 vars」没有任何真实
# 挂载点，这条契约是防御性的（:345 注释预先写出了「行内 extract」这个未来 handler），
# 唯一可执行的判定点就是 dispatch 的单点合并（ctx.vars.update(out.vars)）。所以用
# monkeypatch 换掉 HANDLERS["api_case"]：行作用域本来就是 runner 自己的语义，与 handler
# 是谁无关。判定用「下游引用行列/提取值 → render 快败（error：缺少变量：${x}）」——
# 未定义必须炸在缺它的那一步并点名变量，而不是静默渲染成空串。


def _fake_row_extract_case(entries: list, *, extract_on: str):
    """stub api_case handler：入口处记录 (行值, 当时看得见的 tok)，extract_on 那一行
    「提取」出 tok 交回 vars——那正是 dispatch 会合并进本行 ctx.vars 的增量，
    别的行与节点之后的步骤都不许看见它。"""
    import app.modules.scenario.engine.handlers as H

    async def fake(node, ctx, *, run_children, in_loop=False, run_lists=None):
        who = str(ctx.vars.get("who") or "?")
        entries.append((who, ctx.vars.get("tok")))
        view = {"status": 200, "headers": {}, "body": json.dumps({"who": who}),
                "elapsed_ms": 1}
        ctx.last_response = view  # 与 _send 同款：末行响应要留给下游提取
        detail = {"request": None, "response": dict(view), "assertions": [], "logs": []}
        if who == extract_on:  # 模拟「这一行的响应里有 token」的行内提取
            return H.StepOutcome("pass", "行内提取 tok", detail, vars={"tok": "tk-" + who})
        return H.StepOutcome("pass", "无提取", detail)

    return fake


async def test_dataset_rows_restart_from_scene_vars(session, conn, bus, monkeypatch) -> None:
    await _mk_run(session, "p12", "r12")
    import app.modules.scenario.engine.handlers as H

    entries: list = []
    monkeypatch.setitem(H.HANDLERS, "api_case",
                        _fake_row_extract_case(entries, extract_on="r1"))
    g = _graph(node("ds", "api_case", ref="stub"))
    stats = await run_graph(session, project_id="p12", run_id="r12", graph=g,
                            variables={"base": BASE}, transport=TR, bus=bus,
                            actor=_actor_admin(),
                            dataset_rows={"step_key": "ds", "columns": ["who"],
                                          "rows": [[1, ["r1"]], [2, ["r2"]]],
                                          "case_name": "行作用域", "total": 2})
    assert stats["status"] == "passed" and stats["rows_total"] == 2, stats
    # 核心：第 2 行入口处的 tok 必须是 None。把 :347 的 merge_vars(scene_vars, 行值)
    # 改成在上一行 ctx.vars 上累加，行 2 入口就会带着 tk-r1——本断言即红。
    assert entries == [("r1", None), ("r2", None)], \
        "每行都从场景层重发：第 2 行不得读到第 1 行提取的 tok"
    rows = await _rows(session, "r12")
    s1, s2 = rows[("ds", 1)].vars_snapshot, rows[("ds", 2)].vars_snapshot
    assert s1["tok"] == "tk-r1", "行 1 自己的提取要留在自己那行快照里（否则「行 2 没有」是恒真）"
    assert "tok" not in s2 and s2["who"] == "r2", "行 2 快照：行值照旧最高，行 1 的 tok 不在场"
    head = rows[("ds", 0)].vars_snapshot
    assert "who" not in head and "tok" not in head, "节点行（row_no=0）快照是场景层，不含行层"


# —— 判据⑪：行层（含末行提取值、行列名本身）到数据集节点为止——节点之后引用即缺变量 ——
#
# 这条钉 :361 的 ctx.vars = scene_vars：删掉它，循环退出后 ctx.vars 停在末行那份，
# 行列名（who）与末行提取值（tok）一起偷渡进下游步骤——下游 ${who} 渲染成 "r2"、
# ${tok} 渲染成 "tk-r2"，两个 error 变 pass，本组断言即红。
# 同时正向钉 last_response 的**故意**留末行（:361 注释「供下游提取」）：节点后的
# extract 必须还能读到末行响应——把它一起钉成清空，就把契约钉反了方向。


async def test_row_layer_stops_at_the_dataset_node(session, conn, bus, monkeypatch) -> None:
    await _mk_run(session, "p13", "r13")
    import app.modules.scenario.engine.handlers as H

    entries: list = []
    monkeypatch.setitem(H.HANDLERS, "api_case",
                        _fake_row_extract_case(entries, extract_on="r2"))
    # 提取放在末行：:361 还原失守时泄漏的正是这份「最近一次」的增量
    g = _graph(node("ds", "api_case", ref="stub"),
               node("e", "extract", config={"rules": [{"var": "u", "expr": "$.who"}]}),
               node("after_tok", "http_direct",
                    config=hd("${base}/who?who=${tok}&want=x")),
               node("after_who", "http_direct",
                    config=hd("${base}/who?who=${who}&want=x")))
    stats = await run_graph(session, project_id="p13", run_id="r13", graph=g,
                            fail_fast=False,  # 两个下游都要跑到，各自指名缺哪个变量
                            variables={"base": BASE}, transport=TR, bus=bus,
                            actor=_actor_admin(),
                            dataset_rows={"step_key": "ds", "columns": ["who"],
                                          "rows": [[1, ["r1"]], [2, ["r2"]]],
                                          "case_name": "行作用域", "total": 2})
    assert stats["status"] == "error" and stats["rows_total"] == 2, stats
    rows = await _rows(session, "r13")
    # 正向钉 last_response 留末行：节点后的 extract 读到的是末行响应，提出值进场景层
    assert rows[("e", 0)].status == "pass" and rows[("e", 0)].vars_snapshot["u"] == "r2", \
        "last_response 故意留末行（供下游提取），这一条不许被钉成清空"
    d_tok = str(rows[("after_tok", 0)].detail)
    assert rows[("after_tok", 0)].status == "error" \
        and "缺少变量" in d_tok and "tok" in d_tok, \
        "末行提取的 tok 不得外溢：节点后引用它必须按未定义快败，而不是渲染成 tk-r2"
    d_who = str(rows[("after_who", 0)].detail)
    assert rows[("after_who", 0)].status == "error" \
        and "缺少变量" in d_who and "who" in d_who, \
        "行列名同样到节点为止：下游 ${who} 不许沿用末行的 r2"
    assert _who_hits() == 0, "缺变量的两个下游一个请求都不该发出去"
    assert rows[("ds", 2)].vars_snapshot["tok"] == "tk-r2", \
        "tok 确实产生过（在末行自己的快照里）——否则上面两条缺变量断言恒真"


async def test_dataset_inside_loop_counts_toward_expansion_cap(session, conn, client,
                                                               make_user, bus) -> None:
    u, pid, cid, _ = await _kit(client, make_user, "d10",
                                ds_rows=[["a", "a"], ["b", "b"], ["c", "c"]])
    await _mk_run(session, pid, "r10")
    lp = node("lp", "loop", config={"mode": "while", "cond": "1 == 1", "max_iter": 300},
              children=[node("ds", "api_case", ref=cid)])
    stats = await run_graph(session, project_id=pid, run_id="r10", graph=_graph(lp),
                            expansion_limit=10, variables={"base": BASE},
                            transport=TR, bus=bus, actor=_actor(u))
    assert stats["status"] == "error" and "expansion_overflow" in stats["message"]
    assert stats["rows_total"] == 9, "第 4 轮之前 9+3>10，整轮拦下（不是跑完再算账）"
    assert _who_hits() == 9


# —— 取消边界：置位后一步都不该跑，终态 cancelled ——————————————————


async def test_cancel_before_start_marks_run_cancelled(session, conn, bus) -> None:
    await _mk_run(session, "p11", "r11")
    await request_cancel(bus, "r11", reason="user")
    g = _graph(node("s1", "http_direct", config=hd("${base}/order")),
               node("s2", "http_direct", config=hd("${base}/order")))
    stats = await run_graph(session, project_id="p11", run_id="r11", graph=g,
                            variables={"base": BASE}, transport=TR, bus=bus,
                            actor=_actor_admin())
    assert stats["status"] == "cancelled"
    assert _hits == [], "取消后一个请求都不该发"
    rows = await _rows(session, "r11")
    assert rows[("s1", 0)].status == "cancelled"
    rec = await session.get(RunRecord, "r11")
    assert rec.status == "cancelled"


# —— 契约 4 + 注册表面：runner 是纯内部件 ——————————————————————


def test_runner_crosses_modules_only_via_registry() -> None:
    import app.modules.scenario.engine.runner as runner_mod

    src = Path(runner_mod.__file__).read_text(encoding="utf-8")
    assert "api_test" not in src, "引擎不得 import api_test（契约 4），取数只走 REGISTRY"
    assert "REGISTRY" in src, "api_case/环境解析必须经注册表出口"
    assert "http={" not in src, "runner 是 http=None 的内部件，不得声明 HTTP 面"


def test_handlers_crosses_modules_only_via_registry() -> None:
    """1C T10 扩展：1B 时 ui_case 不注册所以 handler 侧无 ui_test 之虞；现在注册了，
    ui_case_resolve 也必须只走 REGISTRY（禁词加 ui_test，同 api_test 一条纪律）。"""
    import app.modules.scenario.engine.handlers as handlers_mod

    src = Path(handlers_mod.__file__).read_text(encoding="utf-8")
    assert "ui_test" not in src, "引擎不得 import ui_test（契约 1），ui_case 取数只走 REGISTRY"
    assert "api_test" not in src, "引擎不得 import api_test（契约 4），取数只走 REGISTRY"
    assert "REGISTRY" in src, "api_case/ui_case/环境解析必须经注册表出口"


# —— §8.8 的 64KB 线在**真执行链**上生效（runner 的 offload_detail 接线） ————


async def test_oversized_body_is_offloaded_on_the_real_path(session, conn, bus, tmp_path,
                                                            monkeypatch) -> None:
    """跑一个 300KB 响应的场景：DB 存 ref + head，完整原文在盘上可下载。

    这条测试存在的理由是**接线前这里是静默截断**：handlers 落库前按 8000 字符砍掉
    body 并打 body_inline_truncated 标记，用户打开报告看到的是被砍剩的响应，还以为是
    目标系统返回的就这么长——比报错更糟。Task 14 交的 offload_detail 当时零调用点，
    所以 §8.8 那句「别让大行拖垮备份」既没兑现、也没人发现它把响应切了。
    """
    from app.core.config import get_settings
    from app.modules.execution.models import RunArtifact

    art = tmp_path / "artifacts"
    art.mkdir()
    monkeypatch.setenv("TP_ARTIFACTS_DIR", str(art))
    get_settings.cache_clear()
    try:
        await _mk_run(session, "pbig", "rbig")
        g = _graph(node("b1", "http_direct", config=hd("${base}/big")))
        stats = await run_graph(session, project_id="pbig", run_id="rbig", graph=g,
                                variables={"base": BASE}, transport=TR, bus=bus,
                                actor=_actor_admin())
        assert stats["status"] == "passed", stats
        row = (await _rows(session, "rbig"))[("b1", 0)]
        body = row.detail["response"]["body"]
        assert isinstance(body, dict) and body["truncated"] is True, body
        assert body["bytes"] > 200_000 and body["head"].startswith("{"), body["bytes"]
        assert "body_inline_truncated" not in row.detail["response"], "老的手工截断痕迹必须消失"
        on_disk = (art / body["_ref"]).read_bytes()
        assert len(on_disk) == body["bytes"], "head 之外的正文一个字节都不能少"
        assert b"xxxx" in on_disk
        arts = (await session.execute(
            select(RunArtifact).where(RunArtifact.run_id == "rbig"))).scalars().all()
        assert [(a.step_key, a.kind) for a in arts] == [("b1", "RESPONSE")]
        # 裁剪只发生在落库那份：extract 要用的 last_response 仍是全文（不在这张表里）
        assert json.loads(on_disk)["blob"].startswith("xxxx")
    finally:
        get_settings.cache_clear()
