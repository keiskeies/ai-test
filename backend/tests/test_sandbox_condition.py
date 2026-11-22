"""1B T7 前置件：条件表达式沙箱求值（loop.while 与 if 的 cond，§7.4 + §8.5）。

为什么单独开一个入口而不是复用 run_script：cond 是**表达式**，模块级 return 非法，
整段 exec 的语义对不上。但绝不另起裸 eval()——护栏（AST 预检、builtins 白名单、daemon
线程超时、vars 喂副本）必须和 script 步骤共用同一套，否则两条求值路径会慢慢分叉，
「断言里能写的表达式」和「循环条件里能写的」就会出现第二种口径。
"""
from __future__ import annotations

import time

import pytest

from app.shared.sandbox import evaluate_condition


async def test_true_and_false_values() -> None:
    r = evaluate_condition("1 == 1", ctx_vars={})
    assert r.ok and r.true_ is True and r.value is True
    r = evaluate_condition("1 == 2", ctx_vars={})
    assert r.ok and r.true_ is False and r.value is False


async def test_truthiness_follows_python_not_string() -> None:
    """vars 全链路是 str（T6 口径），条件按 Python 真值判定：不逼用户写 != "0"。"""
    assert evaluate_condition('ctx.vars["n"]', ctx_vars={"n": "0"}).true_ is True, (
        '"0" 是非空字符串 → 真；要按数值判断必须显式比较，这是 Python 语义不是 bug')
    assert evaluate_condition('ctx.vars["n"]', ctx_vars={"n": ""}).true_ is False, "空串按假"
    assert evaluate_condition("ctx.vars['code']", ctx_vars={"code": 0}).true_ is False, "数值 0 按假"


async def test_bare_var_names_are_not_defined() -> None:
    """条件里只有一个变量入口：ctx.vars——与 script 步骤、script 断言同一套写法。

    不做裸名字展开是刻意的：vars 全是 str，用户写 n < 3 会撞上 str 与 int 比较的
    TypeError，比报错更难懂；且 script 步骤本来就只认 ctx.vars，两处口径必须一致。
    """
    r = evaluate_condition("n == \"3\"", ctx_vars={"n": "3"})
    assert r.ok is False and r.true_ is False
    assert "NameError" in r.error


async def test_undefined_name_error_points_at_ctx_vars() -> None:
    """条件里最频繁的错法就是裸写变量名：报错必须直接给出正确写法。"""
    r = evaluate_condition("retry_left > 0", ctx_vars={"retry_left": "2"})
    assert r.ok is False
    assert "ctx.vars" in r.error, "要告诉用户变量的正确取法"
    assert "retry_left" in r.error, "要点名是哪个名字"


async def test_design_doc_example_condition_works() -> None:
    """§7.4 原文例子必须真能跑：ctx.vars.get("ok") != "1"。"""
    expr = 'ctx.vars.get("ok") != "1"'
    assert evaluate_condition(expr, ctx_vars={"ok": "0"}).true_ is True
    assert evaluate_condition(expr, ctx_vars={"ok": "1"}).true_ is False


async def test_last_response_is_readable() -> None:
    """if 的 cond 最常见写法就是看上一步响应：ctx.last_response["status"]。"""
    r = evaluate_condition('ctx.last_response.get("status") == 200', ctx_vars={},
                           last_response={"status": 200, "body": "ok"})
    assert r.ok and r.true_ is True


async def test_prebound_modules_are_available() -> None:
    """§8.5 预绑模块在条件里同样可用：脚本能用的条件都能用，不留第二套口径。"""
    r = evaluate_condition('len(json.loads(ctx.vars["u"])) == 2', ctx_vars={"u": "[1,2]"})
    assert r.ok and r.true_ is True


async def test_missing_var_is_a_clean_error_not_a_crash() -> None:
    r = evaluate_condition('ctx.vars["nope"] == "1"', ctx_vars={})
    assert r.ok is False and r.true_ is False
    assert "KeyError" in r.error


@pytest.mark.parametrize("bad", [
    "import os",
    '__import__("os")',
    'open("x")',
    'os.system("dir")',
    "ctx.vars.__class__",
    "x = 1",
    "return 1",
    "def f(): pass",
    'lambda: (yield)',
])
async def test_same_guardrails_as_scripts(bad: str) -> None:
    """与 script 步骤同一条红线：必须被拒，且是 ok=False 而不是抛异常。"""
    r = evaluate_condition(bad, ctx_vars={})
    assert r.ok is False and r.true_ is False
    assert r.error, "拒绝必须给出原因，报告页要能直接展示"


async def test_assignment_is_rejected_with_direction() -> None:
    r = evaluate_condition('ctx.vars["ok"] = "1"', ctx_vars={})
    assert r.ok is False
    assert "表达式" in r.error, "要告诉用户条件位置只能写表达式"


async def test_empty_expression_is_rejected() -> None:
    r = evaluate_condition("   ", ctx_vars={})
    assert r.ok is False and "空" in r.error


async def test_timeout_is_enforced_and_vars_stay_clean() -> None:
    """循环条件每次迭代都求值：不卡死是底线（R56 同款——超时不采信输出）。"""
    expr = "1 == 2 or (len([x for x in range(80_000_000)]), 0)[1] == 1"
    t0 = time.perf_counter()
    r = evaluate_condition(expr, ctx_vars={"keep": "v"}, timeout_s=0.2)
    elapsed = time.perf_counter() - t0
    assert r.ok is False and "超时" in r.error
    assert elapsed < 2.0, "条件求值必须按时返回：循环卡死 = 整个 run 卡死"
    assert r.vars == {"keep": "v"}, "超时不得采信线程里的变量"

