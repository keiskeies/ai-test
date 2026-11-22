"""1B T7：kind handler 注册表（§8.1 §7.4 §8.2 §8.5 §8.6）。

这一层是场景引擎的分发面：runner（T8）只管「按顺序取节点、交给 handler、落库」，
所有 kind 语义都在这里。所以测试钉四类事：

1. 状态口径不外溢：detail 里跑的是 RunStepResult 那套词（running/pass/fail/skip/
   error/cancelled），run_record 那套（passed/failed/error）留给 T9 汇总时映射；
2. 容器语义：loop / foreach / if / group 如何消化 break|continue、如何决定父状态；
3. 取消落在长等待里（§8.2）：sleep 按 500ms 切片、每片查旗标，不是等满了才发现；
4. API 类步骤复用 1A 既有口径：断言来自请求自身（run_api 内部评估一次），
   环境超时只在请求没写 timeout_ms 时生效（与 api_debug 同口径）。

内存靶手法见 1A tests/test_execution_core.py：给 run_api 传 ASGITransport。
api_case 步骤经注册表调 api_case_resolve（R44），需要真 session 与真项目数据，
靶地址由变量 base 渲染进 url。
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncBaseTransport, ConnectError

from app.core.eventbus import EventBus
from app.modules.scenario.engine.context import ExecutionContext
from app.modules.scenario.engine.events import request_cancel
from app.modules.scenario.engine.handlers import (
    HANDLERS,
    PENDING_KINDS,
    BranchResult,
    dispatch,
    make_runner,
)

# —— 内存靶：一个够小的「被测系统」 ——————————————————————————

target = FastAPI()
_hits: list[str] = []


@target.post("/login")
async def login(request: Request):
    _hits.append("login")
    return JSONResponse({"token": "tk-1", "uid": 42, "code": "0"})


@target.get("/order")
async def order(request: Request):
    # 把 query 与 authorization 都记下来：验证「变量真的渲染进请求」必须看得见内容，
    # 只记被调用过几次的话，参数丢失会测不出来。
    _hits.append("order:" + request.headers.get("authorization", "")
                 + ":" + request.query_params.get("state", "?"))
    return JSONResponse({"id": 7, "state": request.query_params.get("state", "?")})


@target.get("/flaky")
async def flaky():
    """前两次 Pending、第三次起 Succeeded：验 loop.while 真的在转圈而不是假退出。"""
    n = _hits.count("flaky")
    _hits.append("flaky")
    return JSONResponse({"state": "Pending" if n < 2 else "Succeeded"})


TR = ASGITransport(app=target)
BASE = "http://tp-target"


class BoomTransport(AsyncBaseTransport):
    """必炸的传输层：注入式靶子根本不看 host，所以「连不上」只能自己造。

    原测试写的是 url=http://127.0.0.1:1/x，配着 ASGITransport 永远走不到网络层
    （ASGITransport 直接进程内派发给 target，host 与端口都被忽略），于是拿到的是
    target 的 404 而不是 ConnectError —— error 判据从没被真的验过。
    """

    async def handle_async_request(self, request):  # pragma: no cover - 必须先抛
        raise ConnectError("connection refused（测试注入：模拟目标不可达）")


BOOM = BoomTransport()


@pytest.fixture(autouse=True)
def _reset_hits():
    _hits.clear()
    yield
    _hits.clear()


# —— 脚手架 —————————————————————————————————————————


def make_ctx(vars_=None, *, bus=None, run_id="run-h", transport=TR, actor=None):
    raw = FakeAsyncRedis(decode_responses=True)
    return ExecutionContext(None, bus or EventBus(raw), run_id, "p-h",
                            {"base": BASE, **(vars_ or {})}, {}, 10_000,
                            actor=actor, transport=transport)


def node(key, kind, *, config=None, ref=None, children=None, name=None, disable=False):
    return {"key": key, "kind": kind, "name": name or key, "ref": ref, "disable": disable,
            "config": config or {}, "children": children or []}


async def run_one(n, ctx, **kw):
    """走注册表分发（注册表本身就是被测契约），容器默认用真 runner 递归。"""
    kw.setdefault("run_children", make_runner(ctx))
    return await dispatch(n, ctx, **kw)


def hd(url, **kw):
    """http_direct 节点配置：config 自身就是请求描述（勘误①）。"""
    cfg = {"url": url, "method": "GET"}
    cfg.update(kw)
    return cfg


def codes(outcomes):
    return [o.status for o in outcomes]


def n_order() -> int:
    """发过几次 /order。list.count 是精确匹配，不能用它数前缀。"""
    return sum(1 for h in _hits if h.startswith("order:"))



# —— 注册表形状（15 个 kind 全注册，两张闸表清空但机制保留） ————————


def test_registry_covers_exactly_the_runnable_kinds() -> None:
    """1D T8：15/15 全部注册（1B 的 13 个 + 1C 的 ui_case + 1D 的 adb_case）。"""
    assert set(HANDLERS) == {
        "api_case", "ui_case", "adb_case", "http_direct", "sleep", "loop", "if", "foreach",
        "break", "continue", "script", "extract", "assert", "set_var", "group",
    }


def test_pending_kinds_is_empty() -> None:
    """1D T8 改钉（不是删）：PENDING_KINDS 清空——但 dispatch 的闸仍在下一个用例里钉。

    这一条与 :1069 的注册表成对：查 PENDING_KINDS 在查 HANDLERS **之前**，两边必须
    同时说话。名单清空本身就是钉子（当初塞 adb_case 进表的就是「没执行器就别跑」）。
    """
    assert PENDING_KINDS == {}
    assert "adb_case" in HANDLERS
    assert "ui_case" in HANDLERS


async def test_pending_gate_fires_for_a_future_kind(monkeypatch) -> None:
    """机制本体不许 dead-on-arrival：假条目必须照旧得到 error + 批次说明，而不是 skip。

    表清空后闸没有真数据可走——所以 monkeypatch 一条未来批次的 kind 验证分支形状：
    「一条其实什么都没测的步骤绝不能显示绿色」这条原则从 1B 一直有效。
    """
    import app.modules.scenario.engine.handlers as handlers

    monkeypatch.setattr(handlers, "PENDING_KINDS", {"kafka_send": "2A"})
    ctx = make_ctx()
    out = await run_one(node("p-gate", "kafka_send", ref="x"), ctx)
    assert out.status == "error", "未开放的 kind 静默跳过 = 报告页假绿"
    assert "2A" in out.message
    assert out.detail["error"]


def test_handler_takes_node_ctx_and_run_children() -> None:
    """契约形状：所有 handler 都是 (node, ctx, *, run_children, in_loop) 的 async 函数。"""
    import inspect

    for kind, fn in HANDLERS.items():
        sig = inspect.signature(fn)
        assert inspect.iscoroutinefunction(fn), kind + " 必须是 async handler"
        assert list(sig.parameters)[:2] == ["node", "ctx"], kind
        assert "run_children" in sig.parameters, kind


# —— http_direct：config 自身就是请求描述（勘误①） ——————————


async def test_http_direct_sends_and_evaluates_assertions() -> None:
    ctx = make_ctx()
    cfg = hd("${base}/order", params=[["state", "open"]],
             headers=[["Authorization", "Bearer ${tok}"]],
             assertions=[{"type": "status_code", "expected": 200},
                         {"type": "json_path_equals", "path": "$.state", "expected": "open"}])
    ctx.vars["tok"] = "tk-9"
    out = await run_one(node("h1", "http_direct", config=cfg), ctx)
    assert out.status == "pass", out.message
    assert [a["passed"] for a in out.detail["assertions"]] == [True, True]
    assert _hits == ["order:Bearer tk-9:open"], "变量必须渲染进 URL/query/header"
    # last_response 供后续 assert/extract 速取（§7.5）
    assert ctx.last_response["status"] == 200
    assert json.loads(ctx.last_response["body"])["state"] == "open"


async def test_http_direct_assertion_failure_is_fail_not_error() -> None:
    """断言不成立是业务结论（fail），不是步骤异常（error）——报告页要分开显示。"""
    ctx = make_ctx()
    cfg = hd("${base}/order", assertions=[{"type": "status_code", "expected": 418}])
    out = await run_one(node("h2", "http_direct", config=cfg), ctx)
    assert out.status == "fail"
    assert not out.detail["assertions"][0]["passed"]


async def test_http_direct_network_error_is_error() -> None:
    """连不上是 error（执行失败），不是 fail（断言不成立）：两种红含义不同。"""
    ctx = make_ctx(transport=BOOM)
    out = await run_one(node("h3", "http_direct", config=hd("${base}/order")), ctx)
    assert out.status == "error"
    assert out.detail["error"], "网络错误原文要进 detail，否则报告只有一句失败"


async def test_http_direct_env_timeout_only_when_unset() -> None:
    """与 api_debug 同口径：请求自己写了 timeout_ms，环境/全局值不得悄悄覆盖。"""
    ctx = make_ctx()
    out = await run_one(node("h4", "http_direct", config=hd("${base}/order")), ctx)
    assert out.detail["request"]["timeout_ms"] == ctx.timeout_ms
    out2 = await run_one(node("h5", "http_direct",
                             config=hd("${base}/order", timeout_ms=4321)), ctx)
    assert out2.detail["request"]["timeout_ms"] == 4321


# —— sleep：取消要落在长等待里（§8.2） ——————————————————


async def test_sleep_runs_to_completion_when_not_cancelled() -> None:
    ctx = make_ctx()
    t0 = time.perf_counter()
    out = await run_one(node("s0", "sleep", config={"ms": 220}), ctx)
    el = time.perf_counter() - t0
    assert out.status == "pass" and el >= 0.20, "没取消就得睡满，否则等待步骤形同虚设"


async def test_sleep_is_cut_short_by_cancel_within_one_slice() -> None:
    """5s 的 sleep 中途置 cancel：必须在一个 500ms 切片内退出，而不是等满 5s。

    这是 §8.2「取消落在长等待里」唯一的可执行验证点。等满再检查的话，用户点停止
    要等五分钟，定时任务的排队队列会被一个卡住的场景全部堵死。
    """
    ctx = make_ctx()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.08)
        await request_cancel(ctx.bus, ctx.run_id, reason="user")

    task = asyncio.create_task(cancel_soon())
    t0 = time.perf_counter()
    out = await run_one(node("s1", "sleep", config={"ms": 5000}), ctx)
    elapsed = time.perf_counter() - t0
    await task
    assert out.status == "cancelled"
    assert elapsed < 1.5, "等了 " + format(elapsed, ".2f") + "s：切片太大或压根没查旗标"
    assert "取消" in (out.message or "")


async def test_sleep_already_cancelled_does_not_sleep_at_all() -> None:
    ctx = make_ctx()
    await request_cancel(ctx.bus, ctx.run_id)
    t0 = time.perf_counter()
    out = await run_one(node("s2", "sleep", config={"ms": 5000}), ctx)
    assert out.status == "cancelled" and time.perf_counter() - t0 < 0.5


# —— 停用与未注册 kind ——————————————————————————————


async def test_disabled_step_is_skipped_without_running() -> None:
    """disable=true → skip：画布上灰掉的步骤不得真的发请求。"""
    ctx = make_ctx()
    out = await run_one(node("d1", "http_direct", config=hd("${base}/order"), disable=True), ctx)
    assert out.status == "skip"
    assert _hits == [], "停用的步骤被真的执行了"


async def test_adb_case_missing_ref_is_error_not_silent_skip() -> None:
    """1D T8 改钉（不是删）：adb_case 走 h_adb_case 真执行；执行前的缺陷仍是 error。

    老叙述「1D 不跑 ADB → error 说明几期开放」已翻面：现在这一步真的跑。原原则
    「一条其实什么都没测的步骤绝不许显示绿色」由这条（缺 ref 当场 error）与
    test_engine_handlers 的 pending 闸用例、test_scenario_run_adb.py 的真执行组共同钉住。
    """
    ctx = make_ctx(actor={"user_id": "u1", "user_name": "u", "is_system_admin": False,
                         "perms": set(), "entry": "http"})
    out = await run_one(node("u-adb_case", "adb_case"), ctx)
    assert out.status == "error"
    assert "用例" in out.message, "要指名缺的是用例引用，否则用户只看到一个没道理的红点"


async def test_adb_case_missing_actor_is_identity_error() -> None:
    """无发起人身份 → error 且直指身份缺失（与 api/ui 同口径，先于 resolve 判死）。"""
    ctx = make_ctx()  # 没有 actor
    out = await run_one(node("u-adb-who", "adb_case", ref="asset-1"), ctx)
    assert out.status == "error"
    assert "身份" in out.message and "归属人" in out.message, (
        "「没身份」与「没权限」必须分开说，定时任务全红时才查得出原因")


async def test_unknown_kind_is_an_error() -> None:
    ctx = make_ctx()
    out = await run_one(node("z", "teleport"), ctx)
    assert out.status == "error" and "teleport" in out.message


# —— set_var / extract / assert / script ————————————————


async def test_set_var_writes_and_renders_into_next_step() -> None:
    ctx = make_ctx()
    out = await run_one(node("v1", "set_var", config={"vars": {"tok": "tk-9", "n": 3}}), ctx)
    assert out.status == "pass"
    assert ctx.vars["tok"] == "tk-9" and ctx.vars["n"] == "3", "vars 一律 str（T6 口径）"
    assert out.vars == {"tok": "tk-9", "n": "3"}, "handler 通过返回值交变量，别偷写 ctx"
    out2 = await run_one(node("v2", "http_direct", config=hd("${base}/order",
                           params=[["t", "${tok}"]])), ctx)
    assert out2.status == "pass"


async def test_extract_then_next_step_uses_extracted_var() -> None:
    """§7.5 的关键链路：extract 提 uid → 下一步 ${uid} 生效（T8/T11 重跑都靠它）。"""
    ctx = make_ctx()
    await run_one(node("e0", "http_direct", config=hd("${base}/login", method="POST",
                       body={"type": "json", "content": "{}"})), ctx)
    out = await run_one(node("e1", "extract", config={"rules": [
        {"var": "uid", "from": "last_response", "expr": "$.uid"},
        {"var": "tk", "from": "last_response", "expr": "$.token"}]}), ctx)
    assert out.status == "pass", out.message
    assert ctx.vars["uid"] == "42" and ctx.vars["tk"] == "tk-1"
    nxt = await run_one(node("e2", "http_direct", config=hd("${base}/order",
                           headers=[["Authorization", "Bearer ${tk}"]])), ctx)
    assert nxt.status == "pass"
    assert _hits[-1] == "order:Bearer tk-1:?", "提取的值必须真的进到下一个请求里"


async def test_extract_missing_path_is_error_with_path_name() -> None:
    """路径取不到 → error 且点名是哪个表达式：只说「提取失败」用户无从下手。"""
    ctx = make_ctx()
    await run_one(node("x0", "http_direct", config=hd("${base}/order")), ctx)
    out = await run_one(node("x1", "extract", config={"rules": [{"var": "nope",
                                                                 "expr": "$.missing.deep"}]}), ctx)
    assert out.status == "error"
    assert "$.missing.deep" in out.message


async def test_extract_without_response_is_error() -> None:
    ctx = make_ctx()
    out = await run_one(node("x2", "extract", config={"rules": [{"var": "a", "expr": "$.id"}]}), ctx)
    assert out.status == "error" and "响应" in out.message


async def test_assert_passes_against_last_response() -> None:
    ctx = make_ctx()
    await run_one(node("a0", "http_direct", config=hd("${base}/order", params=[["state", "ok"]])), ctx)
    out = await run_one(node("a1", "assert", config={"assertions": [
        {"type": "status_code", "expected": 200},
        {"type": "body_contains", "expected": "ok"}]}), ctx)
    assert out.status == "pass"
    assert len(out.detail["assertions"]) == 2


async def test_assert_failure_is_fail_with_rows() -> None:
    ctx = make_ctx()
    await run_one(node("a2", "http_direct", config=hd("${base}/order")), ctx)
    out = await run_one(node("a3", "assert", config={"assertions": [
        {"type": "json_path_equals", "path": "$.id", "expected": 999}]}), ctx)
    assert out.status == "fail"
    row = out.detail["assertions"][0]
    assert row["passed"] is False and row["expected"] == 999 and row["actual"] == 7, (
        "期望/实际都要给出，报告页不能只说断言失败")


async def test_assert_without_response_is_error() -> None:
    ctx = make_ctx()
    out = await run_one(node("a4", "assert", config={"assertions": [
        {"type": "status_code", "expected": 200}]}), ctx)
    assert out.status == "error" and "响应" in out.message


async def test_script_writes_vars_and_logs() -> None:
    """§8.5：脚本经沙箱跑，vars 回写、log() 进 detail.logs。"""
    ctx = make_ctx({"n": "3"})
    code = "log('准备下单')\nctx.vars['total'] = str(int(ctx.vars['n']) * 2)\n"
    out = await run_one(node("sc1", "script", config={"code": code}), ctx)
    assert out.status == "pass", out.message
    assert ctx.vars["total"] == "6"
    assert out.detail["logs"] == ["准备下单"]
    assert out.detail["script"] == code, "报告页要能回看脚本原文"


async def test_script_failure_is_error_with_reason() -> None:
    ctx = make_ctx()
    out = await run_one(node("sc2", "script", config={"code": "ctx.vars['x'] = 1/0"}), ctx)
    assert out.status == "error"
    assert "ZeroDivisionError" in out.message


async def test_script_guardrails_hold_here_too() -> None:
    """script 步骤复用同一沙箱：红线不能在这条路径上松掉。"""
    ctx = make_ctx()
    out = await run_one(node("sc3", "script", config={"code": "import os\nos.getcwd()"}), ctx)
    assert out.status == "error" and "os" in out.message


async def test_script_assertion_failure_is_fail_not_error() -> None:
    """脚本里 assert 不成立是业务结论（与 sandbox 的口径一致）。"""
    ctx = make_ctx()
    out = await run_one(node("sc4", "script", config={"code": "assert 1 == 2, '接口应返回成功'"}), ctx)
    assert out.status == "fail"
    assert "接口应返回成功" in out.message


# —— if：分支顺序与 else 兜底（§7.4） ————————————————


async def test_if_takes_first_matching_branch_only() -> None:
    """分支按顺序求值，命中第一个就停：这是 if 的语义，不是并行全跑。"""
    ctx = make_ctx({"code": "1"})
    n = node("if1", "if", config={"branches": [
        {"cond": "ctx.vars['code'] == '1'", "children": [node("if1.1", "set_var",
                                                              config={"vars": {"hit": "a"}})]},
        {"cond": "ctx.vars['code'] == '1'", "children": [node("if1.2", "set_var",
                                                              config={"vars": {"hit": "b"}})]},
        {"cond": "else", "children": [node("if1.3", "set_var", config={"vars": {"hit": "c"}})]}]})
    out = await run_one(n, ctx)
    assert out.status == "pass"
    assert ctx.vars["hit"] == "a", "后面的分支不得再执行"
    assert ctx.vars.get("hit_b") is None


async def test_if_falls_through_to_else() -> None:
    ctx = make_ctx({"code": "9"})
    n = node("if2", "if", config={"branches": [
        {"cond": "ctx.vars['code'] == '1'", "children": [node("if2.1", "set_var",
                                                              config={"vars": {"hit": "a"}})]},
        {"cond": "else", "children": [node("if2.2", "set_var", config={"vars": {"hit": "else"}})]}]})
    out = await run_one(n, ctx)
    assert out.status == "pass" and ctx.vars["hit"] == "else"


async def test_if_marks_untaken_children_as_skipped() -> None:
    """未命中分支的子节点要出现在结果里标 skip：报告页否则看不出「有条路没走」。"""
    ctx = make_ctx({"code": "9"})
    n = node("if3", "if", config={"branches": [
        {"cond": "ctx.vars['code'] == '1'", "children": [node("if3.1", "set_var",
                                                              config={"vars": {"x": "1"}})]},
        {"cond": "else", "children": [node("if3.2", "set_var", config={"vars": {"x": "2"}})]}]})
    out = await run_one(n, ctx)
    skipped = [o for o in out.children if o.status == "skip"]
    assert [o.key for o in skipped] == ["if3.1"], "跳过的是未命中分支的子节点"


async def test_if_with_no_branch_taken_is_pass() -> None:
    """没有 else 且都不成立：整步 pass（这就是「可选分支」的正常用法）。"""
    ctx = make_ctx({"code": "9"})
    n = node("if4", "if", config={"branches": [
        {"cond": "ctx.vars['code'] == '1'", "children": [node("if4.1", "set_var",
                                                              config={"vars": {"x": "1"}})]}]})
    out = await run_one(n, ctx)
    assert out.status == "pass"
    assert codes([o for c in out.children for o in [c]]) == ["skip"]


async def test_if_broken_condition_takes_else_and_reports_it() -> None:
    """条件写坏（KeyError）→ 按假处理走 else，并把原因留在 message 里。

    刻意不让整个 run 崩：一个手滑的条件表达式不该毁掉已经跑完的二十步。
    """
    ctx = make_ctx()
    n = node("if5", "if", config={"branches": [
        {"cond": "ctx.vars['never_set'] == '1'", "children": [node("if5.1", "set_var",
                                                                   config={"vars": {"h": "a"}})]},
        {"cond": "else", "children": [node("if5.2", "set_var", config={"vars": {"h": "b"}})]}]})
    out = await run_one(n, ctx)
    assert ctx.vars["h"] == "b"
    assert out.status == "pass"
    assert any("KeyError" in (c.message or "") for c in out.children), "要留下可查的痕迹"


async def test_if_child_failure_fails_the_step() -> None:
    ctx = make_ctx({"code": "1"})
    n = node("if6", "if", config={"branches": [
        {"cond": "else", "children": [node("if6.1", "assert",
                                           config={"assertions": [{"type": "status_code",
                                                                   "expected": 200}]})]}]})
    out = await run_one(n, ctx)
    assert out.status == "fail", "分支里的步骤失败必须冒泡，否则 if 变成失败吸尘器"


# —— loop：count / while / max_iter / break|continue ————————


async def test_loop_count_runs_max_iter_times() -> None:
    ctx = make_ctx()
    n = node("L1", "loop", config={"mode": "count", "max_iter": 3},
             children=[node("L1.1", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx)
    assert out.status == "pass"
    assert n_order() == 3, "count 模式 = 跑满 max_iter 轮（勘误④）"
    assert out.iterations == 3


async def test_loop_while_exits_when_condition_becomes_true() -> None:
    """/flaky 前两次 Pending、第三次 Succeeded：验 while 真的在转圈且会自己收束。

    条件写成 ctx.vars.get("state", "Pending") == "Pending" —— 与 §7.4 的原型例子同形
    （ctx.vars.get("ok") != "1"）：首轮之前就有确定真值，不依赖「上一轮响应」这种首轮
    还不存在的东西。状态由循环体内的 extract 更新，是真实轮询任务的写法。
    """
    ctx = make_ctx()
    n = node("L2", "loop", config={"mode": "while", "max_iter": 10,
                                   "cond": "ctx.vars.get('state', 'Pending') == 'Pending'"},
             children=[node("L2.1", "http_direct", config=hd("${base}/flaky")),
                       node("L2.2", "extract", config={"rules": [
                           {"var": "state", "expr": "$.state"}]})])
    out = await run_one(n, ctx)
    assert out.status == "pass", out.message
    assert _hits.count("flaky") == 3, "转了 " + str(_hits.count("flaky")) + " 圈：条件判定没生效"
    assert out.iterations == 3
    assert ctx.vars["state"] == "Succeeded"


async def test_loop_stops_at_max_iter_when_condition_never_satisfied() -> None:
    """条件永远成立时靠 max_iter 硬上限收口：这是防死循环的唯一保障。"""
    ctx = make_ctx()
    n = node("L3", "loop", config={"mode": "while", "max_iter": 4, "cond": "1 == 1"},
             children=[node("L3.1", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx)
    assert out.iterations == 4
    assert n_order() == 4
    assert out.status == "pass"
    assert "上限" in (out.message or ""), "要说明是被 max_iter 截停而非自然收工，否则用户以为重试成功了"


async def test_loop_max_iter_note_says_condition_held_not_never_true() -> None:
    """for…else 分支的文案兑现（handlers.py:1007）：截停 = 条件**每轮都成立**。

    上面 :991 是 `if not res.true_: break`，走到 else 恰恰证明 cond 一次都没假。
    旧文案「仍未等到条件成立」说的是反面，照它排查会去查「条件为什么不成立」——
    而真正的故障是「条件一直成立、循环没停下来」。钉两头：新词必须在，旧谎言必须不在。
    """
    ctx = make_ctx()
    n = node("LW1", "loop", config={"mode": "while", "max_iter": 3, "cond": "1 == 1"},
             children=[node("LW1.1", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx)
    assert out.iterations == 3 and out.status == "pass"
    msg = out.message or ""
    assert "已到 max_iter=3 上限：条件始终成立，循环被上限截停" in msg, msg
    assert "仍未等到条件成立" not in msg, "「没等到成立」与「始终成立」互斥，两句不能同时兑现"


async def test_loop_while_normal_exit_note_unchanged() -> None:
    """条件转假的那条路（:992）没被上面那次改文案动到：正常退出仍说「条件不再成立」。

    两头都钉 = 两条分支的文案各自只描述自己发生过的事，改一头不会悄悄顺走另一头。
    """
    ctx = make_ctx(vars_={"go": "1"})
    n = node("LW2", "loop", config={"mode": "while", "max_iter": 5,
                                    "cond": "ctx.vars.get('go', '1') == '1'"},
             children=[node("LW2.1", "script", config={"code": "ctx.vars['go'] = '0'"})])
    out = await run_one(n, ctx)
    assert out.status == "pass" and out.iterations == 1
    assert "条件不再成立，正常退出" in (out.message or ""), out.message


async def test_loop_condition_error_exits_loop_and_marks_step_error() -> None:
    """条件本身求值失败（碰红线/语法错）→ 步骤 error：静默退出会把错误藏起来。"""
    ctx = make_ctx()
    n = node("L4", "loop", config={"mode": "while", "max_iter": 5, "cond": "open('x')"},
             children=[node("L4.1", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx)
    assert out.status == "error"
    assert _hits == [], "条件都不成立就不该跑第一轮"


async def test_loop_zero_iterations_when_condition_false_at_start() -> None:
    """while 一开始就不成立 → 0 轮、pass：这是「跳过直到条件成立」的正常写法。"""
    ctx = make_ctx()
    n = node("L5", "loop", config={"mode": "while", "max_iter": 5, "cond": "1 == 2"},
             children=[node("L5.1", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx)
    assert out.status == "pass" and out.iterations == 0 and _hits == []



async def test_break_exits_loop_early() -> None:
    """break 提前跳出：数到 2 就停，后面的轮次不再起。

    用脚本自己累加计数，不依赖「loop 自动写入轮次变量」：设计 §7.4 的 loop config
    只有 mode/cond/max_iter 三件，不替它发明第四个字段（勘误④的同一个教训）。
    """
    ctx = make_ctx()
    n = node("L6", "loop", config={"mode": "count", "max_iter": 5}, children=[
        node("L6.1", "script",
             config={"code": "ctx.vars['n'] = str(int(ctx.vars.get('n', '0')) + 1)"}),
        node("L6.2", "if", config={"branches": [
            {"cond": "ctx.vars.get('n') == '2'",
             "children": [node("L6.2.1", "break")]}]}),
        node("L6.3", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx, in_loop=True)
    assert out.status == "pass"
    assert out.iterations == 2, "数到 2 的那一轮应在 break 处收束"
    # 第 2 轮在 break 处就收束了，那一轮的 http 步骤根本不执行 → 只发过 1 次。
    # （原断言写的是 2，与上一行自相矛盾：iterations 到 2 就说明第 2 轮没跑完。）
    assert n_order() == 1, "break 之后的步骤与轮次一次都不该发"


async def test_continue_skips_rest_of_iteration_only() -> None:
    """continue 只跳过本轮剩余步骤，循环本身继续跑满。"""
    ctx = make_ctx()
    n = node("L7", "loop", config={"mode": "count", "max_iter": 3}, children=[
        node("L7.1", "if", config={"branches": [
            {"cond": "1 == 1", "children": [node("L7.1.1", "continue")]}]}),
        node("L7.2", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx, in_loop=True)
    assert out.iterations == 3, "continue 不该终止循环"
    assert _hits == [], "每轮都在 continue 处跳过后续"


async def test_control_outside_loop_is_error() -> None:
    """break/continue 落在循环外 → error（与 T4 的保存校验双保险）。

    保存校验挡得住画布保存，但 step_graph 也可能来自 Agent 生成或直接改库；
    执行期这第二道必须也在，而且要说清是哪一步。
    """
    ctx = make_ctx()
    for kind in ("break", "continue"):
        out = await run_one(node("c-" + kind, kind), ctx, in_loop=False)
        assert out.status == "error", kind
        assert "循环" in out.message, kind


# —— foreach：逐行写 item_var（§7.4 + 勘误⑥） ————————


async def test_foreach_runs_children_once_per_row() -> None:
    """三行各执行一次，且 item_var 逐行变化——数据驱动的最小闭环。"""
    ctx = make_ctx({"users": json.dumps(["a", "b", "c"])})
    n = node("F1", "foreach", config={"list_var": "users", "item_var": "u"},
             children=[node("F1.1", "http_direct",
                            config=hd("${base}/order", params=[["state", "${u}"]]))])
    out = await run_one(n, ctx)
    assert out.status == "pass", out.message
    assert out.iterations == 3
    assert _hits == ["order::a", "order::b", "order::c"], (
        "逐行变化必须体现在真实请求上，只数次数测不出参数丢失")
    assert ctx.vars["u"] == "c", "结束后停在最后一行（不是残留初值）"


async def test_foreach_accepts_native_list_var() -> None:
    """list_var 既接受 JSON 字符串也接受真 list：Agent 直接写 vars 时不必 JSON 化。

    这里注入 list 用 run_lists（假 run_children 只观察 ctx.vars）：vars 走 DB 取数
    是 T8 的事，T7 不碰数据库，所以真 list 由这个入口喂进来。
    """
    seen = []

    async def rc(nodes, parent_key, **kw):
        seen.append(ctx.vars.get("it"))
        return BranchResult(status="pass", stopped=False, outcomes=[])

    ctx = make_ctx()
    out = await dispatch(node("F2", "foreach", config={"list_var": "items", "item_var": "it"}),
                         ctx, run_children=rc, run_lists={"items": [1, 2]})
    assert out.status == "pass" and out.iterations == 2
    assert seen == ["1", "2"], "标量按 str 落 vars（勘误⑥）"


async def test_foreach_serialises_dict_items_as_json() -> None:
    """dict/list 元素进 vars 要 json.dumps(ensure_ascii=False)：脚本里再 json.loads。"""
    seen = []

    async def rc(nodes, parent_key, **kw):
        seen.append(ctx.vars.get("r"))
        return BranchResult(status="pass", stopped=False, outcomes=[])

    ctx = make_ctx()
    await dispatch(node("F3", "foreach", config={"list_var": "rows", "item_var": "r"}), ctx,
                   run_children=rc, run_lists={"rows": [{"名": "张三"}, {"名": "李四"}]})
    assert json.loads(seen[0])["名"] == "张三", "中文必须原样保留，不得转义成 u+XXXX 序列"
    assert len(seen) == 2


async def test_foreach_missing_or_bad_list_is_error() -> None:
    ctx = make_ctx({"users": "not-json"})
    out = await run_one(node("F4", "foreach", config={"list_var": "users", "item_var": "u"}), ctx)
    assert out.status == "error" and "users" in out.message
    ctx2 = make_ctx()
    out2 = await run_one(node("F5", "foreach", config={"list_var": "absent", "item_var": "u"}), ctx2)
    assert out2.status == "error" and "absent" in out2.message


async def test_foreach_empty_list_is_pass_with_zero_iterations() -> None:
    calls = []

    async def rc(nodes, parent_key, **kw):
        calls.append(nodes)
        return BranchResult(status="pass", stopped=False, outcomes=[])

    ctx = make_ctx({"users": "[]"})
    out = await dispatch(node("F6", "foreach", config={"list_var": "users", "item_var": "u"}), ctx,
                         run_children=rc)
    assert out.status == "pass" and out.iterations == 0 and calls == []


# —— group：一期只是串行容器（§7.4） ————————————————


async def test_group_runs_children_in_serial_order() -> None:
    ctx = make_ctx()
    n = node("G1", "group", name="下单流程", children=[
        node("G1.1", "http_direct", config=hd("${base}/order")),
        node("G1.2", "http_direct", config=hd("${base}/order")),
        node("G1.3", "http_direct", config=hd("${base}/order"))])
    out = await run_one(n, ctx)
    assert out.status == "pass"
    assert [c.key for c in out.children] == ["G1.1", "G1.2", "G1.3"], "顺序即数组顺序"
    assert len(_hits) == 3


async def test_group_child_failure_fails_group() -> None:
    """子步骤失败必须让 group 变红：分组不能当失败吸尘器。"""
    ctx = make_ctx()
    n = node("G2", "group", children=[
        node("G2.1", "http_direct",
             config=hd("${base}/order", assertions=[{"type": "status_code", "expected": 418}]))])
    out = await run_one(n, ctx)
    assert out.status == "fail", "子步骤 fail 必须冒泡到 group"


# —— api_case：经注册表取有效请求（R44 + 勘误③） ————————


async def _kit(client, h, name):
    """造一个项目 + 定义 + 用例；定义 url 用 ${base} 变量指向内存靶。"""
    pid = (await client.post("/api/v1/projects", json={"name": name}, headers=h)).json()["id"]
    req = {"url": "${base}/login", "method": "POST",
           "body": {"type": "json", "content": "{}"},
           "assertions": [{"type": "status_code", "expected": 200}]}
    did = (await client.post("/api/v1/api-definitions", headers=h,
                             json={"project_id": pid, "name": "登录", "method": "POST",
                                   "path": "/login", "request": req})).json()["id"]
    cid = (await client.post("/api/v1/api-cases", headers=h,
                             json={"project_id": pid, "definition_id": did,
                                   "name": "正常登录"})).json()["id"]
    return pid, cid


async def test_api_case_resolves_via_registry_and_runs(client, session, make_user) -> None:
    """完整链路：resolve（合并定义与用例）→ 渲染 → 发送 → 断言 → last_response。

    这里必须用真 session：api_case_resolve 有 ensure_project_access，走的是真权限
    resolver。伪造 perms 的 ctx 测不出权限（1A 的同一个教训）。
    """
    u, h = await make_user("h7case")
    pid, cid = await _kit(client, h, "h7a")
    ctx = ExecutionContext(session, EventBus(FakeAsyncRedis(decode_responses=True)),
                           "run-c", pid, {"base": BASE}, {}, 10_000, transport=TR,
                           actor={"user_id": u.id, "user_name": u.name,
                                  "is_system_admin": u.is_system_admin,
                                  "perms": {"api:case:read"}, "entry": "web"})
    out = await run_one(node("c1", "api_case", ref=cid), ctx)
    assert out.status == "pass", out.message
    assert _hits == ["login"]
    assert ctx.last_response["status"] == 200
    assert [a["type"] for a in out.detail["assertions"]] == ["status_code"]
    assert out.detail["request"]["url"] == BASE + "/login", "detail 里要能看到渲染后的真实请求"


async def test_api_case_missing_actor_is_error_with_reason(client, session, make_user) -> None:
    """没有发起人身份（系统触发未配归属人）→ error 且说清原因，不是含糊的 403。

    定时任务最常见的坑就是「Owner 离职后场景全红却看不出为什么」，文案必须直指身份缺失。
    """
    u, h = await make_user("h7nobody")
    pid, cid = await _kit(client, h, "h7b")
    ctx = ExecutionContext(session, EventBus(FakeAsyncRedis(decode_responses=True)),
                           "run-c2", pid, {"base": BASE}, {}, 10_000, transport=TR)
    out = await run_one(node("c2", "api_case", ref=cid), ctx)
    assert out.status == "error"
    assert "身份" in out.message
    assert _hits == [], "拿不到身份就不该发请求"


async def test_api_case_outsider_is_error_not_exception(client, session, make_user) -> None:
    """非项目成员的身份 → 步骤 error 并带上 not_found 的原因，绝不把 ApiError 抛穿 runner。"""
    u, h = await make_user("h7own")
    pid, cid = await _kit(client, h, "h7c")
    other, _ = await make_user("h7out")
    ctx = ExecutionContext(session, EventBus(FakeAsyncRedis(decode_responses=True)),
                           "run-c3", pid, {"base": BASE}, {}, 10_000, transport=TR,
                           actor={"user_id": other.id, "user_name": other.name,
                                  "is_system_admin": False, "perms": set(), "entry": "web"})
    out = await run_one(node("c3", "api_case", ref=cid), ctx)
    assert out.status == "error"
    assert out.message, "错误原因必须留在 message 里，报告页才有话可说"


# —— 1C T10：ui_case 步骤走真注册表出口 + 假驱动注入（单元档） ——————————
#
# 这一组的 UI 腿是**假驱动**：monkeypatch `execution.ui_core.run_ui` 这个接缝，
# 只验 h_ui_case 的折法（resolve 经 REGISTRY、状态映射、vars 增量、detail 形状、
# 制品摘要不带 blob）。真浏览器的 api_case→ui_case→api_case 混合链在
# tests/test_scenario_run.py::test_mixed_api_ui_api_scenario_real_browser（D1 最小混合证据）。
# 不装 app.core.registry 而是走 create_app 装配——与 test_engine_runner 同手法，
# 避免污染其它测试文件看到的全局注册表。


@pytest.fixture()
def _boot_registry():
    from app.main import create_app

    create_app()


async def _ui_kit(client, h, pid, steps: list[dict], env_vars: list) -> str:
    r = await client.post("/api/v1/envs", json={
        "project_id": pid, "name": "uienv" + str(len(steps)) + str(time.time_ns() % 10**6),
        "config": {"vars": env_vars}}, headers=h)
    assert r.status_code == 201, r.text
    env_id = r.json()["id"]
    r = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "uilabel" + str(time.time_ns() % 10**6),
        "steps": steps, "env_id": env_id}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _ui_steps() -> list[dict]:
    return [
        {"id": "u1", "type": "open", "input": "${base_url}/ui/login"},
        {"id": "u2", "type": "assert_title", "input": "演示商城"},
    ]


def _ui_ctx(session, pid, uid, perms=None):
    return ExecutionContext(session, EventBus(FakeAsyncRedis(decode_responses=True)),
                            "run-u", pid, {}, {}, 10_000,
                            actor={"user_id": uid, "user_name": "u", "is_system_admin": False,
                                   "perms": perms if perms is not None else {"ui:case:read"},
                                   "entry": "web"})


def _fake_run_ui(result, preset_vars=None):
    """造一个假 run_ui：吞掉关键字参数、返回预置 UiResult，并记下调用形状。

    preset_vars 模拟真驱动器的 save_var：真 run_ui 把**入参 variables 打底**再叠
    save_var 的结果，假件必须同形——否则 vars 增量测试会拿假的打底差异说谎。
    """
    calls = []

    async def fake(commands, **kw):
        calls.append({"commands": commands, **kw})
        if preset_vars is not None:
            result.vars = {**kw["variables"], **preset_vars}
        return result

    return fake, calls


async def test_ui_case_defers_to_ui_core_via_registry(client, session, make_user,
                                                      monkeypatch, _boot_registry) -> None:
    """① ui_case 步骤经 ui_case_resolve 取资产、调 execution.ui_core.run_ui，全过 → pass。

    断言的是 handler 与驱动器之间的**整条缝**：commands/elements/variables/base_url
    必须来自注册表解析（不是 node 里抄的），should_cancel 必须是可调用（Stop 按钮的线）。
    """
    from app.modules.execution import ui_core
    from app.modules.execution.ui_core import UiResult

    u, h = await make_user("h10u1")
    pid = (await client.post("/api/v1/projects", json={"name": "h10a"},
                             headers=h)).json()["id"]
    cid = await _ui_kit(client, h, pid, _ui_steps(), [["base_url", "http://fake-target"]])
    fake, calls = _fake_run_ui(UiResult(ok=True, passed=True,
                                        commands=[{"id": "u1", "type": "open", "status": "pass",
                                                   "message": "打开", "elapsed_ms": 5,
                                                   "assertions": [], "detail": {}},
                                                  {"id": "u2", "type": "assert_title",
                                                   "status": "pass", "message": "标题含",
                                                   "elapsed_ms": 1, "assertions": [],
                                                   "detail": {}}]))
    monkeypatch.setattr(ui_core, "run_ui", fake)
    ctx = _ui_ctx(session, pid, u.id)
    out = await run_one(node("uc1", "ui_case", ref=cid), ctx)
    assert out.status == "pass", out.message
    assert len(calls) == 1, "步骤执行 = 恰好一次 run_ui"
    assert calls[0]["commands"][0]["id"] == "u1"
    assert calls[0]["base_url"] == "http://fake-target", "base_url 来自环境变量（R105/D3）"
    assert callable(calls[0]["should_cancel"]), "取消探测必须传给驱动器（画布 Stop 的线）"
    assert set(out.detail) >= {"request", "response", "assertions", "logs",
                               "commands", "artifacts", "case_id"}
    assert out.detail["response"] == {"status": None, "body": None}, \
        "UI 步没有 HTTP 响应：占位而非假状态码（单步重跑靠这个键不去找邻居）"


async def test_ui_case_maps_failure_and_vars_and_detail(client, session, make_user,
                                                        monkeypatch, _boot_registry) -> None:
    """⑤+vars+细节：断言没过 → fail（不是 error）；save_var 增量**返回**给 dispatch 合并。

    handler 直接写 ctx.vars 会让「这一步改了哪些变量」不可审计（§8.3 重跑依据），
    所以 out.vars 里必须有、ctx.vars 是 dispatch 合进去的——两条都钉。
    """
    from app.modules.execution import ui_core
    from app.modules.execution.ui_core import UiResult

    u, h = await make_user("h10u2")
    pid = (await client.post("/api/v1/projects", json={"name": "h10b"},
                             headers=h)).json()["id"]
    cid = await _ui_kit(client, h, pid, _ui_steps(), [["base_url", "http://fake-target"]])
    fake, _ = _fake_run_ui(UiResult(
        ok=True, passed=False,
        commands=[{"id": "u1", "type": "open", "status": "pass", "message": "打开",
                   "elapsed_ms": 3, "assertions": [], "detail": {}},
                  {"id": "u2", "type": "assert_title", "status": "fail", "message": "标题不含",
                   "elapsed_ms": 2, "assertions": [
                      {"type": "assert_title", "passed": False, "expected": "演示商城",
                       "actual": "登录失败", "error": None, "path": "page.title()"}],
                   "detail": {}}],
        vars={}), preset_vars={"got": "hello"})
    monkeypatch.setattr(ui_core, "run_ui", fake)
    ctx = _ui_ctx(session, pid, u.id)
    ctx.vars["tok"] = "keep-me"  # 驱动器打底会把它原样带回：不得被算成「这一步改的」
    out = await run_one(node("uc2", "ui_case", ref=cid), ctx)
    assert out.status == "fail", "断言没过是业务结论（fail），不是没跑成（error）"
    assert out.vars == {"got": "hello"}, "增量里剔除驱动器打底带回来的入参变量，只交新值"
    assert ctx.vars["got"] == "hello", "dispatch 单点合并后变量对下游可见（混合链的前提）"
    assert out.detail["assertions"][0]["passed"] is False


async def test_ui_case_artifact_summaries_carry_no_blob(client, session, make_user,
                                                        monkeypatch, _boot_registry) -> None:
    """⑥ 前置：detail["artifacts"] 必须是**摘要**（kind/step_key/bytes），blob 不落 JSON 列。

    UiResult.artifacts[].blob 是 bytes，run_step_result.detail 是 JSON 列：
    offload_detail 不会剥它（_encoded 吞 TypeError，绑参时 json.dumps 直接炸），
    所以 handler 交出 artifacts（全量，含 blob）供 runner 落盘，detail 里只留摘要。
    """
    from app.modules.execution import ui_core
    from app.modules.execution.ui_core import UiResult

    u, h = await make_user("h10u3")
    pid = (await client.post("/api/v1/projects", json={"name": "h10c"},
                             headers=h)).json()["id"]
    cid = await _ui_kit(client, h, pid, _ui_steps(), [["base_url", "http://fake-target"]])
    fake, _ = _fake_run_ui(UiResult(
        ok=True, passed=False,
        commands=[{"id": "u1", "type": "open", "status": "error", "message": "导航失败",
                   "elapsed_ms": 3, "assertions": [], "detail": {}}],
        artifacts=[{"kind": "SCREENSHOT", "blob": b"\x89PNG" + b"0" * 500,
                    "step_id": "u1", "reason": "命令失败自动截图"}]))
    monkeypatch.setattr(ui_core, "run_ui", fake)
    ctx = _ui_ctx(session, pid, u.id)
    out = await run_one(node("uc3", "ui_case", ref=cid), ctx)
    assert out.status == "error", "命令没跑成（error 行）→ 步骤 error，不是 fail"
    s = out.detail["artifacts"][0]
    assert s == {"kind": "SCREENSHOT", "step_key": "uc3", "command": "u1", "bytes": 504,
                 "reason": "命令失败自动截图"}, s
    assert "blob" not in s
    assert out.artifacts[0]["blob"].startswith(b"\x89PNG"), "blob 随 StepOutcome 交 runner 落盘"


async def test_ui_case_missing_ref_and_actor_are_errors(client, session, make_user,
                                                        _boot_registry) -> None:
    """与 api_case 同口径的两道防御：ref 空、无发起人身份 → error 且文案点名根因。"""
    ctx = make_ctx()
    out = await run_one(node("uc4", "ui_case"), ctx)
    assert out.status == "error" and "用例" in out.message
    u, h = await make_user("h10u4")
    pid = (await client.post("/api/v1/projects", json={"name": "h10d"},
                             headers=h)).json()["id"]
    cid = await _ui_kit(client, h, pid, _ui_steps(), [["base_url", "http://x"]])
    ctx2 = ExecutionContext(session, EventBus(FakeAsyncRedis(decode_responses=True)),
                            "run-u4", pid, {}, {}, 10_000)  # 无 actor
    out2 = await run_one(node("uc5", "ui_case", ref=cid), ctx2)
    assert out2.status == "error" and "归属人" in out2.message


async def test_ui_case_not_executable_is_error_with_reason(client, session, make_user,
                                                           _boot_registry) -> None:
    """resolve 回 executable=False（元素悬空）→ 步骤 error 带 reason，不是 422 不是静默。

    悬空引用直插复现（同 test_ui_debug 的手法）：execute 前不必起浏览器就能判死。
    """
    from app.modules.ui_test.models import UiCase

    u, h = await make_user("h10u5")
    pid = (await client.post("/api/v1/projects", json={"name": "h10e"},
                             headers=h)).json()["id"]
    row = UiCase(project_id=pid, name="幽灵元素引用", priority="P2", enabled=1,
                 steps=[{"id": "u1", "type": "click", "element_id": "el-ghost"}],
                 step_count=1, project_public=True)
    session.add(row)
    await session.commit()
    ctx = _ui_ctx(session, pid, u.id)
    out = await run_one(node("uc6", "ui_case", ref=row.id), ctx)
    assert out.status == "error"
    assert "el-ghost" in out.message, "reason 要点名是哪个元素：" + str(out.message)


# —— 回归：实现时补的口径（测试正文没覆盖、但代码已这么承诺的行为）———


async def test_broken_if_condition_leaves_trace_on_the_step_message() -> None:
    """条件写坏的痕迹必须留在**步骤**的 message 上，不能只在折叠的 skip 行里。

    报告列表默认折叠子节点，用户先看到的就是这一行；只写 skip 行等于把
    「你的条件写错了」藏起来。
    """
    ctx = make_ctx()
    n = node("if7", "if", config={"branches": [
        {"cond": "ctx.vars['never'] == '1'", "children": []},
        {"cond": "else", "children": [node("if7.1", "set_var", config={"vars": {"h": "b"}})]}]})
    out = await run_one(n, ctx)
    assert out.status == "pass"
    assert "KeyError" in (out.message or ""), "步骤这一行自己要说清有过求值失败"


async def test_inner_loop_break_does_not_escape_to_outer_loop() -> None:
    """内层循环的 break 只终结内层：外层还得跑满，否则一个 break 能吃掉整张画布。

    控制信号在 loop/foreach 处「消化」掉不外传，这条是那个口径唯一的可证伪点。
    """
    ctx = make_ctx()
    inner = node("O1.1", "loop", config={"mode": "count", "max_iter": 4}, children=[
        node("O1.1.1", "if", config={"branches": [
            {"cond": "1 == 1", "children": [node("O1.1.1.1", "break")]}]}),
        node("O1.1.2", "http_direct", config=hd("${base}/order"))])
    outer = node("O1", "loop", config={"mode": "count", "max_iter": 3}, children=[inner])
    out = await run_one(outer, ctx, in_loop=False)
    assert out.iterations == 3, "外层必须跑满：内层 break 不该冒泡上来"
    assert n_order() == 0, "内层每轮都在 break 处收束，http 一步都不该发"
    assert out.status == "pass", out.message


async def test_cancel_inside_container_propagates_out() -> None:
    """cancel 与 break 走同一条返回通道，但语义相反：它必须一路冒到顶层。"""
    ctx = make_ctx()
    await request_cancel(ctx.bus, ctx.run_id)
    n = node("K1", "group", children=[
        node("K1.1", "loop", config={"mode": "count", "max_iter": 3},
             children=[node("K1.1.1", "http_direct", config=hd("${base}/order"))])])
    out = await run_one(n, ctx)
    assert out.status == "cancelled", "取消信号被容器吞掉的话，停止按钮只能等自然跑完"
    assert _hits == []


# —— 边界：缺变量与非法提取来源 ——————————————————————


async def test_missing_variable_is_error_naming_the_var() -> None:
    """渲染缺变量 → error 且点名变量（§7.5 的口径，报告页直接照着补）。"""
    ctx = make_ctx()
    out = await run_one(node("m1", "http_direct", config=hd("${base}/x?u=${absent}")), ctx)
    assert out.status == "error"
    assert "absent" in out.message


async def test_extract_rejects_unknown_source() -> None:
    """from 只认 last_response：其它值明确报错，不静默当 body_jsonpath 跑。

    设计 §7.4 的示例带 "from": "last_response"，而 T4 的保存校验只要求 var+expr；
    所以 from 缺省合法、写了别处必须说清（否则用户以为能从 header 取）。
    """
    ctx = make_ctx()
    await run_one(node("m2", "http_direct", config=hd("${base}/order")), ctx)
    out = await run_one(node("m3", "extract", config={"rules": [
        {"var": "a", "from": "header", "expr": "$.x-id"}]}), ctx)
    assert out.status == "error" and "header" in out.message
