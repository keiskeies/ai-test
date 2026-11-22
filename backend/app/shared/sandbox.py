"""受限 exec 脚本沙箱（§8.5）：前置/后置脚本、script 步骤、script 断言共用同一份白名单。

定位要说清楚，**这是护栏不是安全边界**：真正的闸门是 builtins 白名单里根本没有
open/exec/eval/compile/getattr；AST 预检只是把最常见的误用变成立刻可读的报错（带行号，
比正则精确：retrieval( 不会被误判成 eval(）。能写场景脚本的人本来就有 scenario:update
权限，威胁模型是「误用与手滑」，不是对抗攻击者；§8.5 把强隔离推到三期，这里不谎称硬隔离。

四条不可省略的实现约束，都由 tests/test_sandbox.py 钉住：

1. 执行线程是 daemon：Python 没有安全终止点，超时后线程仍在跑，非 daemon 会让
   worker 退出时 join 挂死。
2. 超时/异常都不采信脚本写的变量：线程拿的是入参字典的副本，调用方那份永不被碰，
   僵尸线程事后写完也污染不到；半改状态比不改更危险。
3. 出网默认关闭，且 import 闸按完整模块路径封死：url_allowlist 为空时 http.get/post
   一调用即报错，不是「能连内网只是没配」；§8.5 白名单里是 urllib.parse 而非 urllib，
   urllib.request 的一切 import 形态在预检即拒，预绑的 urllib 名字也只挂 parse。
   与开头定位一致：这是护栏，不是安全边界。
4. print 与 log 进同一条有序日志，各次调用各成一行（忽略 end=），总长受 max_output 约束。
"""
from __future__ import annotations

import ast
import base64
import datetime
import hashlib
import json
import math
import random
import re
import threading
import time
import urllib.parse
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

DEFAULT_TIMEOUT_S = 5
DEFAULT_MAX_OUTPUT = 64_000
HTTP_BODY_CHARS = 200_000


class _UrllibView:
    """预绑的 urllib 替身：只挂 .parse——urllib.request 走属性访问也是 AttributeError。"""

    parse: Any = urllib.parse


_URLLIB_VIEW = _UrllibView()

# 预绑到全局的模块：脚本里直接写 json.dumps(...) 即可，不必 import
MODULES: dict[str, Any] = {
    "json": json, "re": re, "math": math, "datetime": datetime, "random": random,
    "time": time, "hashlib": hashlib, "base64": base64, "urllib": _URLLIB_VIEW,
    "parse": urllib.parse,
}
# 允许 import 的**完整模块路径**（不是顶层名）：X.Y 只有在 X.Y 本身在册时才放行。
# 按顶层名判定的旧写法会让 urllib.request 顺着 urllib 溜进来——§8.5 白名单里是
# urllib.parse，裸 urllib 也不许 import（urllib 包对象上挂着 .request）。
IMPORT_WHITELIST = frozenset({
    "json", "re", "math", "datetime", "random", "time", "hashlib", "base64",
    "urllib.parse",
    "uuid", "decimal", "itertools", "functools", "collections", "collections.abc",
    "string", "statistics", "copy", "textwrap", "unicodedata",
})


def _import_denied_path(mod_name: str, from_names: Sequence[str]) -> str | None:
    """import 准入判定（完整路径），返回被拒的具体模块路径（None = 放行）：
    `import a.b` 要求 a.b 本身在册；`from M import x, y` 要求 M 在册（json 这类普通
    模块），或 M.x、M.y 逐个在册（放行 from urllib import parse，杀掉 from urllib import request）。"""
    if mod_name in IMPORT_WHITELIST:
        return None
    if from_names and all(mod_name + "." + n in IMPORT_WHITELIST for n in from_names):
        return None
    if from_names:
        return next((mod_name + "." + n for n in from_names
                     if mod_name + "." + n not in IMPORT_WHITELIST), "?")
    return mod_name or "?"
BUILTINS: dict[str, Any] = {
    "len": len, "range": range, "str": str, "dict": dict, "list": list, "tuple": tuple,
    "set": set, "frozenset": frozenset, "int": int, "float": float, "bool": bool,
    "sorted": sorted, "reversed": reversed, "min": min, "max": max, "sum": sum,
    "abs": abs, "round": round, "enumerate": enumerate, "zip": zip, "map": map,
    "filter": filter, "any": any, "all": all, "isinstance": isinstance,
    "issubclass": issubclass, "repr": repr, "hash": hash, "ord": ord, "chr": chr,
    "bin": bin, "hex": hex, "oct": oct, "divmod": divmod, "pow": pow, "format": format,
    "Exception": Exception, "BaseException": BaseException, "ValueError": ValueError,
    "TypeError": TypeError, "KeyError": KeyError, "IndexError": IndexError,
    "AttributeError": AttributeError, "ZeroDivisionError": ZeroDivisionError,
    "RuntimeError": RuntimeError, "StopIteration": StopIteration,
}
# 这些名字整体不可见（连别名都不许起），堵住 x = eval; x(...) 的绕路
FORBIDDEN_NAMES = frozenset({
    "open", "exec", "eval", "compile", "getattr", "setattr", "delattr", "globals",
    "locals", "vars", "input", "exit", "quit", "breakpoint", "memoryview", "super",
    "type", "object", "classmethod", "staticmethod", "property", "importlib",
})
# 非 dunder 的帧/代码对象属性：顺着它们能爬出 exec 的全局字典，必须点名堵
FRAME_ATTRS = frozenset({"gi_frame", "gi_code", "gi_running", "f_back", "f_globals",
                         "f_locals", "f_code", "f_builtins"})


class ScriptDenied(Exception):
    """白名单拒绝：文案直接说清动了哪条规矩，别让用户去猜。"""


@dataclass
class ScriptResult:
    ok: bool
    vars: dict[str, Any] = field(default_factory=dict)
    logs: list[str] = field(default_factory=list)
    error: str | None = None
    truncated: bool = False
    thread: threading.Thread | None = None
    # 条件表达式（mode="condition"）的求值结果；脚本模式恒为 None。
    # 单独一个字段而不是塞进 vars：条件是只读判定，不该往变量表里写回东西。
    value: Any = None


def _is_dunder(x: str) -> bool:
    return len(x) > 4 and x.startswith("__") and x.endswith("__")


def _deny_import(name: str) -> str:
    msg = ("import " + name + " 被拒绝：不在脚本可导入模块白名单内（§8.5）；"
           "已预绑 json/re/math/datetime/random/time/hashlib/base64/urllib.parse，无需 import")
    if name == "urllib" or name.startswith("urllib."):
        msg += "。提醒：§8.5 白名单里是 urllib.parse，不是 urllib.request——出网请求没有许可路径"
    return msg


def _forbidden_in(tree: ast.AST) -> str | None:
    """AST 红线遍历：脚本与条件表达式**共用这一份**，杜绝两套护栏慢慢分叉。"""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                denied = _import_denied_path(a.name, ())
                if denied is not None:
                    return _deny_import(denied)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                return "不允许相对导入（§8.5 白名单只放行白名单内的绝对导入）"
            denied = _import_denied_path(node.module or "",
                                         [n.name for n in node.names])
            if denied is not None:
                return _deny_import(denied)
        elif isinstance(node, ast.Attribute):
            if _is_dunder(node.attr) or node.attr in FRAME_ATTRS:
                return ("不允许访问双下划线（dunder）属性 " + node.attr
                        + "：这是绕过白名单的常见路径，请改用 ctx.vars 与白名单内置函数")
        elif isinstance(node, ast.Name):
            if _is_dunder(node.id):
                return ("不允许访问双下划线（dunder）名字 " + node.id
                        + "：这是绕过白名单的常见路径，请改用 ctx.vars 与白名单内置函数")
            if node.id in FORBIDDEN_NAMES:
                return "不允许使用 " + node.id + "（§8.5 白名单里没有它）"

    return None


def _precheck(code: str) -> str | None:
    """脚本正文预检（mode=exec）：语法错误也归一成可读文案，不抛。"""
    try:
        tree = ast.parse(code, filename="script", mode="exec")
    except SyntaxError as e:
        return "SyntaxError: " + str(e.msg) + "（第 " + str(e.lineno) + " 行）"
    except BaseException as e:  # noqa: BLE001
        return type(e).__name__ + ": " + str(e)
    return _forbidden_in(tree)


def _precheck_condition(expr: str) -> str | None:
    """条件表达式预检（mode=eval）：同一批红线，外加「必须是表达式」与禁 yield/await。

    mode=eval 是刻意的：它让 x = 1、import os、def f(): ... 这类语句**解析即失败**，
    于是能把「条件位置只能写表达式」这句人话还给用户，而不是求值时冒一句 SyntaxError。
    yield/await 即使在 lambda 里合法也一律拒绝——它们会让条件返回一个生成器对象，
    真值恒为 True，条件永远成立：这种静默错比报错危险得多。
    """
    try:
        tree = ast.parse(expr, filename="condition", mode="eval")
    except SyntaxError as e:
        return ("条件必须是一个表达式（例如 ctx.vars.get(「ok」) != 「1」，字符串要用引号），"
                "不能是赋值、import 或多行代码：") + str(e.msg) + "（第 " + str(e.lineno) + " 行）"
    except BaseException as e:  # noqa: BLE001
        return type(e).__name__ + ": " + str(e)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Yield, ast.YieldFrom, ast.Await)):
            return ("条件表达式里不允许 yield/await：它会让条件返回生成器或协程对象，"
                    "真值恒为 True → 条件永远成立；条件每次循环迭代都要同步求值一次，请直接写布尔表达式")

    return _forbidden_in(tree)


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    """运行期第二道闸：AST 已拦一次，这里防动态拼出来的导入路径。"""
    if level:
        raise ScriptDenied("不允许相对导入（§8.5 白名单只放行白名单内的绝对导入）")
    denied = _import_denied_path(str(name), [str(n) for n in (fromlist or ())])
    if denied is not None:
        raise ScriptDenied(_deny_import(denied))
    mod = __import__(name, globals, locals, fromlist, level)
    # import urllib.parse 会把名字 urllib 重绑成真实包对象——包上挂着 .request，必须换回视图
    if not fromlist and str(name).split(".")[0] == "urllib" and "." in str(name):
        return _URLLIB_VIEW
    return mod


class _Ctx:
    """脚本里的 ctx：vars 可读写，last_response 是本步响应的只读快照。"""

    def __init__(self, variables: dict, last_response: dict | None) -> None:
        self.vars = variables
        self.last_response = last_response or {}


class _Http:
    """受 URL 白名单约束的出网助手（§10-4）：前缀匹配，默认全拒。"""

    def __init__(self, allowlist: Sequence | None, timeout_s: float) -> None:
        self._allowlist = [p for p in (allowlist or []) if isinstance(p, str) and p]
        self._timeout = timeout_s

    def _gate(self, url) -> str:
        if not isinstance(url, str) or not url.strip():
            raise ScriptDenied("http 助手需要一个非空 URL 字符串，收到 " + repr(url))
        if not self._allowlist:
            raise ScriptDenied("出网未启用：本次执行没有配置 URL 白名单，http.get/post 一律拒绝"
                               "（默认关闭，不是「能连内网只是没配」）")
        if not any(url.startswith(p) for p in self._allowlist):
            raise ScriptDenied("URL " + repr(url) + " 不在出网白名单内；允许前缀："
                               + ", ".join(self._allowlist))
        return url

    def _call(self, method: str, url, **kw) -> dict:
        self._gate(url)
        kw.setdefault("timeout", self._timeout)
        kw.setdefault("trust_env", False)
        t0 = time.perf_counter()
        resp = httpx.request(method, url, **kw)
        return {
            "status": resp.status_code,
            "headers": {k.lower(): v for k, v in resp.headers.items()},
            "body": resp.text[:HTTP_BODY_CHARS],
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
        }

    def get(self, url, **kw) -> dict:
        return self._call("GET", url, **kw)

    def post(self, url, **kw) -> dict:
        return self._call("POST", url, **kw)


def _to_text(x) -> str:
    if isinstance(x, str):
        return x
    if isinstance(x, (dict, list, tuple, Mapping, Sequence)):
        try:
            return json.dumps(x, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            return repr(x)
    return str(x)


def _fmt_seconds(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else str(x)


def run_script(code: str, *, ctx_vars: Mapping | None, last_response: dict | None = None,
               timeout_s: float = DEFAULT_TIMEOUT_S, max_output: int = DEFAULT_MAX_OUTPUT,
               url_allowlist: Sequence | None = None, mode: str = "script",
               timeout_message: str | None = None) -> ScriptResult:
    """在受限全局里 exec 一段脚本，返回变量增量、有序日志与错误；任何失败都不抛。

    ctx_vars 会被复制一份喂给脚本：**入参字典永不被改**，因此超时/异常路径返回的 vars
    一定是干净的原始快照——这就是「不采信超时线程输出」的可证伪实现。
    """
    if mode not in ("script", "condition"):
        # 传错 mode 是调用方的编程错误，必须炸出来；默默当成 script 跑会产出无人能解释的结果
        raise ValueError("run_script 的 mode 只支持 script/condition，收到 " + repr(mode))
    original = dict(ctx_vars or {})
    if mode == "condition":
        empty = "条件表达式为空：loop 的 cond 与 if 的分支条件都必须填写"
    else:
        empty = "脚本内容为空：script 步骤/断言必须有 code 正文"
    if not isinstance(code, str) or not code.strip():
        return ScriptResult(False, original, [], empty)
    reason = _precheck_condition(code) if mode == "condition" else _precheck(code)
    if reason is not None:
        return ScriptResult(False, original, [], "脚本被拒绝：" + reason)

    logs: list = []
    lock = threading.Lock()
    state = {"truncated": False}

    def emit(parts: tuple, sep=" ") -> None:
        joiner = sep if isinstance(sep, str) else " "
        text = joiner.join(_to_text(p) for p in parts)
        with lock:
            used = sum(len(x) for x in logs)
            if used >= max_output:
                state["truncated"] = True
                return
            if used + len(text) > max_output:
                keep = max(0, max_output - used)
                if keep:
                    logs.append(text[:keep])
                state["truncated"] = True
                return
            logs.append(text)

    def log(*parts, **kw) -> None:
        emit(parts, kw.get("sep", " "))

    def script_print(*parts, **kw) -> None:
        emit(parts, kw.get("sep", " "))

    glb: dict = dict(MODULES)
    glb.update(BUILTINS)
    bi = dict(BUILTINS)
    # CPython 的 IMPORT_NAME 只从 __builtins__ 里取 __import__，
    # 放在全局的同名键根本不生效（第一版就是这么漏的），所以闸门必须塞进 builtins 字典。
    bi["__import__"] = _safe_import
    glb["__builtins__"] = bi
    glb["__name__"] = "tp_script"
    glb["log"] = log
    glb["print"] = script_print
    glb["http"] = _Http(url_allowlist, timeout_s)
    ctx = _Ctx(dict(original), last_response)
    glb["ctx"] = ctx

    failure: list = []

    is_cond = mode == "condition"

    def target() -> None:
        try:
            if is_cond:
                # 把表达式变成一条赋值，从而复用同一套护栏与超时线程。
                # 外层括号是必需的：否则用户写「1 +  # 注释」时续行会把闭合括号吃掉。
                exec("__value__ = (" + code + "\n)", glb)
            else:
                exec(code, glb)
        except ScriptDenied as e:
            failure.append(str(e))
        except AssertionError as e:
            # 断言失败是业务结论而不是脚本崩溃：原文给报告，不加工成「脚本异常」
            failure.append("AssertionError: " + (str(e) or "断言不成立"))
        except BaseException as e:  # noqa: BLE001 沙箱必须吸收一切异常，绝不让执行核 500
            failure.append(type(e).__name__ + ": " + str(e)[:300])

    t = threading.Thread(target=target, daemon=True, name="tp-script")
    t.start()
    t.join(timeout_s)
    with lock:
        snapshot = list(logs)
    if t.is_alive():
        # 线程不可强杀：它拿着副本继续跑，调用方这份快照与入参都不采信其后续写入
        head = timeout_message or ("脚本超时 " + _fmt_seconds(timeout_s) + "s（§8.5 单脚本上限）")
        return ScriptResult(False, original, snapshot,
                            head + "；后台线程无法强杀，其后续写入不会被采信",
                            state["truncated"], t)
    if failure:
        return ScriptResult(False, original, snapshot, failure[0], state["truncated"], t)
    return ScriptResult(True, ctx.vars, snapshot, None, state["truncated"], t,
                        glb.get("__value__") if is_cond else None)

@dataclass
class ConditionResult:
    """条件求值结果。ok 只说「求值过程成不成立」，true_ 才是业务真值：

    条件写错（KeyError、超时、碰红线）时 true_ 必须是 False——loop 会因此退出、
    if 会落到 else 分支，这是唯一能让「写坏的条件」不至于把整个 run 拖成死循环的取向。
    """

    ok: bool
    value: Any = None
    error: str | None = None
    vars: dict[str, Any] = field(default_factory=dict)

    @property
    def true_(self) -> bool:
        return bool(self.value) if self.ok else False



_NAME_ERROR_RE = re.compile(r"name ['\"]?(\w+)['\"]? is not defined")


def _hint_condition_names(error: str | None) -> str | None:
    """条件里最常见的错法是裸写变量名（n > 3 而不是 ctx.vars["n"]），补一句正确写法。

    只在末尾追加提示，原文一字不动：报告页与日志仍能看到解释器本来的话。
    条件位置不提供裸名字展开——vars 全链路是 str，裸 n < 3 会变成 str 与 int 比较的
    TypeError，比一句 NameError 更难懂；script 步骤也只认 ctx.vars，两处保持同一口径。
    """
    if not error or not error.startswith("NameError:"):
        return error
    m = _NAME_ERROR_RE.search(error)
    name = m.group(1) if m else None
    if not name:
        return error
    return (error + "；条件表达式里变量要写 ctx.vars[" + chr(39) + name + chr(39)
            + "]，不能裸写名字（ctx.last_response 可直接取上一步响应）")

def evaluate_condition(expr: str, *, ctx_vars: Mapping | None,
                       last_response: dict | None = None,
                       timeout_s: float | None = None) -> ConditionResult:
    """求值一个条件表达式（loop.while 的 cond、if 的分支条件，§7.4 §8.5）。

    与 run_script 共用全部护栏，只是把正文包成一条赋值。任何失败都归一为
    ok=False + 可读 error，绝不抛：调用方是执行循环，它需要「这一轮条件不成立」
    这样的可判定结论，而不是一个把 run 炸掉的异常。
    """
    # 同 assertions：显式给默认值，不用 `**kw` 让调用形状不可判定
    r = run_script(expr, ctx_vars=ctx_vars, last_response=last_response,
                   mode="condition",
                   timeout_s=DEFAULT_TIMEOUT_S if timeout_s is None else timeout_s,
                   timeout_message=("条件表达式超时（循环条件必须快速返回，否则整个 run"
                                    " 会卡在这一步）"))
    return ConditionResult(ok=r.ok, value=r.value, error=_hint_condition_names(r.error),
                           vars=r.vars)
