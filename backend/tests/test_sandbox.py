"""1B T5：受限 exec 沙箱（§8.5）+ script 断言真求值。

沙箱的定位要在测试里说明白：**它是护栏不是安全边界**。真闸门是 builtins 白名单里
根本没有 open/exec/eval/compile/import 之外的东西；文本预检只是把最常见的误用变成
可读报错。能编辑场景脚本的人本来就有 scenario:update 权限，威胁模型是「误用 + 手滑」，
不是对抗攻击者——§8.5 把强隔离推到三期，这条判断必须留在文档与测试里，不许反过来
宣称「沙箱安全」。
"""
from __future__ import annotations

import inspect
import threading
import time
import urllib.request

import pytest

from app.shared.assertions import ResponseView, evaluate
from app.shared.sandbox import ScriptResult, run_script

R = ResponseView(status=200, headers={"content-type": "application/json"},
                 body_text='{"code": 0, "data": {"token": "tk"}}', elapsed_ms=120)


# —— 正常路径 ——

def test_script_reads_writes_vars_and_logs() -> None:
    code = "\n".join([
        "total = 0",
        "for i in range(4):",
        "    total = total + i",
        "log('start')",
        "ctx.vars['total'] = str(total)",
        "print('done', total)",
        "log('end')",
    ])
    res = run_script(code, ctx_vars={"seed": "1"})
    assert res.ok, res.error
    assert res.vars["total"] == "6"
    assert res.vars["seed"] == "1", "原有变量必须保留，不是覆盖成一个新字典"
    assert res.logs == ["start", "done 6", "end"], "log 与 print 进同一条有序日志"


def test_last_response_is_visible() -> None:
    code = "ctx.vars['st'] = str(ctx.last_response['status'])"
    res = run_script(code, ctx_vars={}, last_response={"status": 201, "body": "x"})
    assert res.ok and res.vars["st"] == "201"


def test_whitelisted_modules_are_bound() -> None:
    code = "\n".join([
        "ctx.vars['j'] = json.dumps({'a': 1}, sort_keys=True)",
        "ctx.vars['m'] = str(math.floor(3.7))",
        "ctx.vars['q'] = parse.quote('a b')",
        "ctx.vars['h'] = hashlib.md5(b'x').hexdigest()[:8]",
        "ctx.vars['re'] = ','.join(re.findall('[0-9]', 'a1b2'))",
    ])
    res = run_script(code, ctx_vars={})
    assert res.ok, res.error
    assert res.vars["j"] == '{"a": 1}'
    assert res.vars["m"] == "3"
    assert res.vars["q"] == "a%20b"
    assert res.vars["re"] == "1,2"
    assert len(res.vars["h"]) == 8


def test_whitelisted_import_is_allowed() -> None:
    res = run_script("import json\nctx.vars['k'] = json.dumps([1, 2])", ctx_vars={})
    assert res.ok, res.error
    assert res.vars["k"] == "[1, 2]"


# —— urllib：§8.5 白名单里是 urllib.parse，不是 urllib.request ——
# 曾经的洞：import 闸只看顶层段，urllib 在册 → import urllib.request 放行，脚本拿到真实
# 出网 TCP，把「出网默认关闭」的口径直接击穿。白名单必须按完整模块路径判定。

@pytest.fixture()
def urlopen_spy(monkeypatch) -> list:
    """把「没有发起网络尝试」钉成可证伪断言：测试进程里的 urlopen 换成纯记录器。"""
    calls: list = []

    def spy(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("urlopen 绝不该被调用")

    monkeypatch.setattr(urllib.request, "urlopen", spy)
    return calls


def test_import_urllib_request_rejected_in_precheck(urlopen_spy) -> None:
    for code in ["import urllib.request", "from urllib import request",
                 "from urllib.request import urlopen", "import urllib.error",
                 "import urllib.request as rq"]:
        res = run_script(code + "\nctx.vars['x'] = '1'", ctx_vars={})
        assert not res.ok, code
        assert res.error.startswith("脚本被拒绝："), "必须是预检拒的，不是运行期才炸：" + res.error
        assert "urllib.request" in res.error, res.error
        assert "白名单" in res.error and "urllib.parse" in res.error, "要指到 §8.5 那条口径上"
    assert urlopen_spy == [], "被拦下就绝不能有真实 urlopen 调用"


def test_bare_import_urllib_rejected(urlopen_spy) -> None:
    """裸 urllib 也不许 import：urllib 包对象上挂着 .request，给它等于没堵。"""
    res = run_script("import urllib\nctx.vars['x'] = '1'", ctx_vars={})
    assert not res.ok
    assert res.error.startswith("脚本被拒绝：") and "urllib" in res.error
    assert urlopen_spy == []


def test_prebound_urllib_neutered_and_no_network_attempt(urlopen_spy) -> None:
    """预绑的 urllib 不许带 .request：urllib.request.urlopen(...) 必须 AttributeError 而死。"""
    res = run_script("ctx.vars['x'] = str(urllib.request.urlopen('http://127.0.0.1:9/', timeout=1))",
                     ctx_vars={})
    assert not res.ok
    assert "AttributeError" in res.error and "request" in res.error, res.error
    assert urlopen_spy == [], "没有 import 也照样能出网的洞必须由预绑对象本身堵上"
    assert res.vars == {}


def test_prebound_urllib_view_shape() -> None:
    from app.shared.sandbox import IMPORT_WHITELIST, MODULES
    assert "urllib.parse" in IMPORT_WHITELIST
    assert "urllib" not in IMPORT_WHITELIST, "白名单存完整模块路径，裸根名不再放行"
    assert not hasattr(MODULES["urllib"], "request")
    assert MODULES["urllib"].parse.urlencode({"k": "v"}) == "k=v"


def test_urllib_parse_import_forms_still_work() -> None:
    res = run_script("import urllib.parse\nctx.vars['q'] = urllib.parse.urlencode({'k': 'v'})",
                     ctx_vars={})
    assert res.ok, res.error
    assert res.vars["q"] == "k=v"
    res2 = run_script("from urllib.parse import unquote\nctx.vars['u'] = unquote('a%20b')",
                      ctx_vars={})
    assert res2.ok and res2.vars["u"] == "a b", res2.error
    res3 = run_script("from urllib import parse\nctx.vars['q'] = parse.urlencode({'k': 'v'})",
                      ctx_vars={})
    assert res3.ok and res3.vars["q"] == "k=v", res3.error
    res4 = run_script("import urllib.parse as up\nctx.vars['q'] = up.urlencode({'k': 'v'})",
                      ctx_vars={})
    assert res4.ok and res4.vars["q"] == "k=v", res4.error


def test_prebound_urllib_parse_still_reachable() -> None:
    res = run_script("ctx.vars['q'] = urllib.parse.urlencode({'a b': 'c d'})", ctx_vars={})
    assert res.ok, res.error
    assert res.vars["q"] == "a+b=c+d"


# —— 越界：必须拒绝，且报错要说清动了什么 ——

def test_import_outside_whitelist_rejected_with_module_name() -> None:
    for code in ["import os", "import subprocess", "from pathlib import Path"]:
        res = run_script(code + "\nctx.vars['x'] = '1'", ctx_vars={})
        assert not res.ok, code
        assert "os" in res.error or "subprocess" in res.error or "pathlib" in res.error, res.error
        assert "白名单" in res.error, "要说清是被白名单拦的，不是「模块不存在」"


def test_open_call_rejected_by_source_precheck() -> None:
    res = run_script("f = open('/etc/passwd')\nctx.vars['x'] = f.read()", ctx_vars={})
    assert not res.ok
    assert "open" in res.error


def test_dunder_access_rejected() -> None:
    for code in ["ctx.__globals__['x'] = 1", "x = ().__class__", "ctx.vars.__class__ = 1"]:
        res = run_script(code, ctx_vars={})
        assert not res.ok, code
        assert "dunder" in res.error or "双下划线" in res.error, res.error


def test_attribute_lookup_helpers_rejected() -> None:
    """getattr/setattr 是 dunder 文本预检的绕行门，必须一起堵。"""
    for code in ["getattr(ctx, 'vars')['a'] = '1'", "setattr(ctx, 'x', 1)"]:
        res = run_script(code, ctx_vars={})
        assert not res.ok, code
        assert "getattr" in res.error or "setattr" in res.error, res.error


def test_precheck_does_not_hit_substring_false_positive() -> None:
    """文本预检用词边界，否则 retrieval( 这种变量名会被误判成 eval(。"""
    code = "retrieval = {'k': 'v'}\nctx.vars['x'] = retrieval['k']"
    res = run_script(code, ctx_vars={})
    assert res.ok, res.error
    assert res.vars["x"] == "v"


def test_syntax_error_is_reported_not_raised() -> None:
    res = run_script("def broken(:\n  pass", ctx_vars={})
    assert not res.ok
    assert "SyntaxError" in res.error


def test_runtime_error_reports_type_and_stops_writing_vars() -> None:
    """异常前已写的 vars 也不采信：半改状态比不改更危险（下游步骤会以为脚本跑成了）。"""
    res = run_script("ctx.vars['a'] = '1'\nraise ValueError('boom')", ctx_vars={"keep": "0"})
    assert not res.ok
    assert "ValueError" in res.error and "boom" in res.error
    assert res.vars == {"keep": "0"}


# —— 超时 ——

def test_timeout_default_is_five_seconds() -> None:
    """§8.5 钉死 5s；不真等 5 秒，钉默认值即可。"""
    assert inspect.signature(run_script).parameters["timeout_s"].default == 5


def test_hanging_script_returns_timeout_error_fast() -> None:
    t0 = time.perf_counter()
    res = run_script("import time\nctx.vars['x'] = '1'\ntime.sleep(30)", ctx_vars={}, timeout_s=0.2)
    spent = time.perf_counter() - t0
    assert not res.ok
    assert "超时" in res.error and "0.2" in res.error
    assert spent < 5, "必须 join(timeout) 就返回，不能等脚本自己结束"


def test_timeout_does_not_adopt_vars_even_after_thread_finishes() -> None:
    """诚实条款的核心可证伪形式：超时线程写不到调用方的变量表。

    线程不可强杀（Python 没有安全终止点），所以沙箱喂给它的是**副本**；调用方那份
    字典在超时路径上永不被碰，等线程真跑完也一样。
    """
    src = {"a": "1"}
    res = run_script("import time\ntime.sleep(0.2)\nctx.vars['a'] = '2'\nctx.vars['late'] = 'x'",
                     ctx_vars=src, timeout_s=0.02)
    assert not res.ok and "超时" in res.error
    assert "late" not in res.vars
    assert res.vars.get("a") == "1"
    time.sleep(0.4)  # 等那条僵尸线程真跑完
    assert src == {"a": "1"}, "超时线程事后写完也不能污染调用方字典"


def test_runaway_thread_is_daemon() -> None:
    """线程不可强杀 ⇒ 必须是 daemon，否则 pytest/worker 退出时 join 挂死整机。"""
    res = run_script("import time\ntime.sleep(5)", ctx_vars={}, timeout_s=0.05)
    assert not res.ok
    assert res.thread is not None and res.thread.daemon is True


# —— 输出上限 ——

def test_output_cap_and_truncated_flag() -> None:
    res = run_script("print('x' * 200000)", ctx_vars={}, max_output=64_000)
    assert res.ok, res.error
    assert res.truncated is True
    assert sum(len(x) for x in res.logs) <= 64_000


def test_output_under_cap_is_not_truncated() -> None:
    res = run_script("print('x' * 100)", ctx_vars={}, max_output=64_000)
    assert res.ok and res.truncated is False
    assert len(res.logs) == 1 and len(res.logs[0]) == 100


# —— 出网助手 ——

def test_http_helper_denied_without_allowlist() -> None:
    res = run_script("r = http.get('http://127.0.0.1:1/x')\nctx.vars['ok'] = 'yes'", ctx_vars={})
    assert not res.ok
    assert "白名单" in res.error, "默认关闭出网，而不是「能连内网只是没配」"


def test_http_helper_denied_when_prefix_not_matched() -> None:
    res = run_script("http.get('http://evil.example/x')", ctx_vars={},
                     url_allowlist=["http://127.0.0.1/"])
    assert not res.ok
    assert "白名单" in res.error


def test_http_helper_allowed_prefix_reaches_the_network_layer() -> None:
    """放行的是闸门不是结果：端口 1 必然连不上，所以错误里必须是连接失败而非白名单。"""
    res = run_script("http.get('http://127.0.0.1:1/x')", ctx_vars={},
                     url_allowlist=["http://127.0.0.1:1/"], timeout_s=8)
    assert not res.ok
    assert "白名单" not in res.error, res.error


# —— script 断言接线 ——

def test_script_assertion_passes_and_sees_variables() -> None:
    rows = evaluate([{"type": "script", "code": "assert ctx.vars['code'] == '0'",
                      "expected": None}], R, variables={"code": "0"})
    assert rows[0]["passed"] is True, rows[0]
    assert rows[0]["type"] == "script"


def test_script_assertion_failure_carries_the_assert_message() -> None:
    rows = evaluate([{"type": "script",
                      "code": "assert ctx.vars['code'] == '0', '业务码非0'"}], R,
                    variables={"code": "5"})
    assert rows[0]["passed"] is False
    assert "业务码非0" in rows[0]["error"], rows[0]["error"]


def test_script_assertion_other_exception_reports_original_error() -> None:
    """非断言异常要原样带出类型：报告里写「脚本异常 TypeError」才查得下去。"""
    missing = evaluate([{"type": "script", "code": "ctx.vars['nope']"}], R, variables={})[0]
    assert missing["passed"] is False and "KeyError" in missing["error"], missing["error"]
    wrong = evaluate([{"type": "script", "code": "1 + \"x\""}], R, variables={})[0]
    assert wrong["passed"] is False and "TypeError" in wrong["error"], wrong["error"]


def test_script_assertion_can_read_response_body() -> None:
    code = "\n".join(["body = json.loads(ctx.last_response['body'])",
                      "assert body['data']['token'] == 'tk', 'token 不对'"])
    assert evaluate([{"type": "script", "code": code}], R)[0]["passed"] is True


def test_script_assertion_without_code_is_a_clear_failure() -> None:
    rows = evaluate([{"type": "script"}], R)
    assert rows[0]["passed"] is False
    assert "code" in rows[0]["error"], "要说缺什么，而不是抛 KeyError 把执行核 500"


def test_script_assertion_honours_timeout_ms() -> None:
    """复用断言已有的 timeout_ms 字段；不传则默认 5s（§8.5）。"""
    rows = evaluate([{"type": "script", "code": "import time\ntime.sleep(3)",
                      "timeout_ms": 200}], R)
    assert rows[0]["passed"] is False
    assert "超时" in rows[0]["error"], rows[0]["error"]


def test_script_assertion_still_denies_import_os() -> None:
    rows = evaluate([{"type": "script", "code": "import os\nassert True"}], R)
    assert rows[0]["passed"] is False
    assert "白名单" in rows[0]["error"]


def test_evaluate_signature_keeps_old_callers_working() -> None:
    """execution/core.py:93 是三参数调用，不能因为加 variables 就炸 1A 的绿。"""
    assert evaluate([{"type": "status_code", "expected": 200}], R)[0]["passed"] is True


def test_result_shape() -> None:
    res = run_script("log('hi')", ctx_vars={})
    assert isinstance(res, ScriptResult)
    assert set(res.__dict__) >= {"ok", "vars", "logs", "error", "truncated"}
    assert res.error is None


def test_no_thread_left_running_under_normal_scripts() -> None:
    before = threading.active_count()
    for _ in range(5):
        run_script("ctx.vars['a'] = '1'", ctx_vars={})
    assert threading.active_count() <= before + 1  # 超时用例可能留一条 daemon 僵尸


def test_vars_are_isolated_per_call() -> None:
    src = {"a": "1"}
    run_script("ctx.vars['b'] = '2'", ctx_vars=src)
    assert "b" not in src, "沙箱内加键不能反向污染入参"
