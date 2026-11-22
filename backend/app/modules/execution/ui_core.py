"""UI 执行核（§6.3/§8.1，计划 T7）：Playwright 驱动，纯引擎无 DB，异常归一不抛。

与 1A 的 `core.py:run_api` 同层同风格：关键字参数 + 结构化结果，浏览器/网络一切异常
吸收成 `ok=False` / 命令行 `error`，绝不抛穿给引擎。驱动器**不认识资产**——元素由调用方
解析成 `{element_id: {name, locator_type, locator}}` 传进来（R94 分层的实质：资产住在
`ui_test`，驱动住在 `execution`，独立调试与场景步骤共用这一份代码，不可能跑出两种结论）。

三条铁律，都被 tests/test_ui_core.py 钉着：
- **契约 4**：模块级零 `app.modules.*` import；`playwright` 在 `run_ui` 体内延迟 import
  （R95——「后端没装浏览器」绝不能表现为「整个后端起不来」）。
- **async API only**（R96）：sync API 在 `asyncio.run` 内直接抛异常（前置取证 1 实测），
  而 worker 的真实形态就是 `asyncio.run` 包一层协程。
- **fail ≠ error**：断言跑成了但结论不成立 = fail（橙）；这一步没能执行完（缺元素、超时、
  浏览器死了）= error（红）。两色在报告页是不同处置动作，串色等于伪造结论。
"""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from app.shared.vars import MissingVar, render

# sleep 的取消检查粒度：与 handlers.py 的 SLEEP_SLICE_MS 同值同意——500ms 兼顾
# 「点停止立刻生效」与「别把取消查询打爆」。
SLEEP_SLICE_MS = 500
# D5：每案制品硬上限。save_artifact 没有大小闸（前置取证 5），全命令截图会把制品
# 目录撑爆——裁掉的不截，但必须在 message 里说出口，静默不截是假绿。
MAX_SHOTS_PER_CASE = 2
MAX_DOM_PER_CASE = 1
# R101：这 5 种各需独立机制（文件选择/下载监听/frame 与窗口句柄/原生弹窗），1C 半做
# 等于做假。保存期 validate_commands 已拒，这里仍防御——收到就给 error + 点名批次，
# 绝不 KeyError。刻意本地硬编码而不是 import ui_test.commands：契约 4 禁止 execution
# 认识领域模块；名单与 BLOCKED_1C 的同源由 T21 契约回归共同钉住。
_BLOCKED_1C = ("upload/download/switch_frame/switch_window/dialog_accept 命令要到 1C+ "
               "批次才开放（R101：各需独立机制，半做等于做假）")
# §7.2 枚举（24）里本驱动器有实现的 19 种；其余走 blocked/unknown 两条 error 路。
_SUPPORTED = frozenset({
    "open", "click", "dblclick", "input", "clear", "select", "hover", "key", "scroll",
    "wait_element", "wait_text", "sleep", "assert_text", "assert_element", "assert_title",
    "get_text", "get_attr", "screenshot", "js",
})
_ASSERT_TYPES = frozenset({"assert_text", "assert_element", "assert_title"})


@dataclass
class UiResult:
    """整案结论。ok=跑没跑起来（浏览器起得来），passed=断言全过——两层不能互推。"""

    ok: bool
    passed: bool
    commands: list[dict] = field(default_factory=list)   # {id,type,status,message,elapsed_ms,assertions,detail}
    vars: dict[str, str] = field(default_factory=dict)
    error: str | None = None
    artifacts: list[dict] = field(default_factory=list)  # [{kind:"SCREENSHOT"|"DOM", blob, step_id, reason}]


def _stringify(value: Any) -> str:
    """进 vars 的值一律 str（1B T6 口径）；dict/list 用 ensure_ascii=False 保中文（勘误⑥）。"""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _short(text: str, limit: int = 200) -> str:
    return text if len(text) <= limit else text[:limit] + "…(截断)"


def _selector(loc: Mapping) -> str:
    """locator_type → Playwright selector（R100 一期 5 种，映射表由计划钉死）。"""
    t, v = loc.get("type"), str(loc.get("value", ""))
    if t == "id":
        return "#" + v
    if t == "css":
        return v
    if t == "xpath":
        return "xpath=" + v
    if t == "name":
        return "[name=" + v + "]"
    if t == "text":
        return "text=" + v          # Playwright 文本引擎（前置取证 1 实测可用）
    raise ValueError("未知定位器类型 " + repr(t) + "，一期支持 id/css/xpath/text/name（R100）")


def _resolve(step: Mapping, elements: Mapping) -> tuple[str | None, str]:
    """命令 → (selector | None, 人话描述)。element_id 与 inline_locator 二选一（§7.2）。"""
    eid = step.get("element_id")
    if eid is not None and str(eid) != "":
        el = elements.get(str(eid))
        if not isinstance(el, Mapping):
            return None, "元素库里没有元素 " + str(eid) + "（可能已被删除或不属于本项目）"
        loc: Mapping = {"type": el.get("locator_type"), "value": el.get("locator")}
        label = str(el.get("name") or eid) + "[" + str(el.get("locator_type")) + ":" \
            + str(el.get("locator")) + "]"
    else:
        raw = step.get("inline_locator")
        if not isinstance(raw, Mapping):
            return None, "命令既没有 element_id 也没有 inline_locator，没有定位目标"
        loc = raw
        label = str(loc.get("type")) + ":" + str(loc.get("value"))
    try:
        return _selector(loc), label
    except ValueError as e:
        return None, str(e)


def _has_locator(step: Mapping) -> bool:
    return (step.get("element_id") not in (None, "")) or (step.get("inline_locator") is not None)


def _render_maybe(text: Any, variables: dict[str, str]) -> tuple[str, str | None]:
    """${var} 渲染；未定义变量 → (原文, 错误)。快败口径转成命令行 error，不抛穿。"""
    if not isinstance(text, str):
        return _stringify(text), None
    try:
        return render(text, variables), None
    except MissingVar as e:
        return text, str(e)


def _row(a_type: str, passed: bool, expected: Any, actual: Any,
         error: str | None, path: str) -> dict:
    """断言行逐键同 shared/assertions.py 的 _row（R108）：{type,passed,expected,actual,error,path}。

    键名写错 DebugPanel 会静默渲染「期望 null」，所以这里单点构造，禁止手搓字典。
    path 对 UI 是定位器描述——字段复用不是语义冒充（DebugPanel 只把它当代码片段显示）。
    """
    return {"type": a_type, "passed": passed, "expected": expected,
            "actual": actual, "error": error, "path": path}


def _locator_error(e: Exception, label: str, timeout_ms: int) -> Exception:
    """Playwright 异常 → 人话异常。堆栈和 Call log 绝不能进报告（计划 T7 定位器条款）。"""
    from playwright.async_api import TimeoutError as PWTimeout

    if isinstance(e, PWTimeout):
        return RuntimeError("定位器 " + label + " 没找到，超时 "
                            + str(max(1, round(timeout_ms / 1000))) + "s")
    return RuntimeError("定位器 " + label + " 操作失败：" + type(e).__name__ + ": "
                        + _short(str(e), 150))


class _Cancelled(Exception):
    """sleep 切片轮询到取消旗标：用异常穿透，让主循环把该行记成 cancelled。"""


class _DeadlineHit(Exception):
    """sleep 切片撞到 max_runtime_ms：主循环据此记 error + 后续 skip + 整案 运行超时。"""


async def run_ui(commands: list[dict], *, elements: dict[str, dict],
                 variables: dict[str, str] | None = None, base_url: str | None = None,
                 headless: bool = True, browser_channel: str = "",
                 timeout_ms: int = 10_000, max_runtime_ms: int | None = None,
                 should_cancel: Callable[[], Awaitable[bool]] | None = None) -> UiResult:
    """跑一条 UI 用例（§7.2 扁平命令列表）。一切失败归一进行结果，不抛穿（同 run_api）。

    elements 由调用方解析好传入（驱动器不懂数据库，R94）；should_cancel 是异步探测，
    在每条命令前与 sleep 的每个 500ms 切片后被查询。
    """
    from playwright.async_api import async_playwright  # R95：延迟 import，见模块 docstring

    vars_: dict[str, str] = {str(k): str(v) for k, v in (variables or {}).items()}
    result = UiResult(ok=False, passed=False, vars=vars_)
    deadline = None if max_runtime_ms is None else time.perf_counter() + max_runtime_ms / 1000
    budget = {"shot": MAX_SHOTS_PER_CASE, "dom": MAX_DOM_PER_CASE}
    overflow: list[str] = []   # 被配额裁掉/采集失败的账，最后写进命令行 message 说出口

    async def cancelled() -> bool:
        # `is None` 而不是 bool(should_cancel)：后者不窄化类型，mypy 在第二个操作数里
        # 仍当它可能是 None 而报「None not callable」。语义一字不差。
        return False if should_cancel is None else await should_cancel()

    async def capture(page: Any, step_id: str, reason: str, need: str) -> None:
        """截图/DOM 采集，带 D5 配额；裁掉的记账，绝不静默不截。"""
        if budget[need] <= 0:
            overflow.append(step_id + ": " + reason + "因每案制品配额（"
                            + str(MAX_SHOTS_PER_CASE) + " 图 + " + str(MAX_DOM_PER_CASE)
                            + " DOM）未采集")
            return
        budget[need] -= 1
        try:
            if need == "shot":
                blob = await page.screenshot(full_page=True)
                result.artifacts.append({"kind": "SCREENSHOT", "blob": blob,
                                         "step_id": step_id, "reason": reason})
            else:
                html = await page.content()
                result.artifacts.append({"kind": "DOM", "blob": html.encode("utf-8"),
                                         "step_id": step_id, "reason": reason})
        except Exception as e:  # noqa: BLE001 采集失败要说出口，不能让报告假装截过了
            overflow.append(step_id + ": " + reason + "采集失败 " + type(e).__name__
                            + ": " + _short(str(e), 120))

    try:
        async with async_playwright() as pw:
            launch_kw: dict[str, Any] = {"headless": headless}
            if browser_channel:
                launch_kw["channel"] = browser_channel
            try:
                browser = await pw.chromium.launch(**launch_kw)
            except Exception as e:  # noqa: BLE001 浏览器起不来 = 整案没跑成（ok=False），不抛穿
                result.error = ("浏览器启动失败（检查 chromium 是否已装，或配 "
                                "TP_UI_BROWSER_CHANNEL=chrome/msedge 用系统浏览器）："
                                + type(e).__name__ + ": " + _short(str(e), 200))
                for c in commands or []:
                    result.commands.append(_row_cmd(c, "skip", "浏览器未启动，未执行", 0))
                return result
            try:
                context = await browser.new_context()
                page = await context.new_page()
                page.set_default_timeout(timeout_ms)
                await _run_commands(page, commands or [], elements, vars_, result,
                                    base_url, timeout_ms, deadline, cancelled, capture)
            finally:
                try:
                    await browser.close()
                except Exception:  # noqa: BLE001 收尾失败不该改写已得的结论
                    pass
    except Exception as e:  # noqa: BLE001 执行核必须吸收一切异常（同 run_api 的口径）
        result.error = result.error or ("执行核异常 " + type(e).__name__ + ": " + _short(str(e), 200))
    if overflow:
        tail = "制品提示：" + "；".join(overflow)
        if result.commands:
            m = result.commands[-1].get("message")
            result.commands[-1]["message"] = (str(m) + "；" + tail) if m else tail
        else:
            result.error = (result.error or "") + "；" + tail
    return result


def _row_cmd(step: Any, status: str, message: str | None, elapsed_ms: int) -> dict:
    sid = step.get("id") if isinstance(step, Mapping) else None
    typ = step.get("type") if isinstance(step, Mapping) else None
    return {"id": sid if isinstance(sid, str) else str(sid), "type": typ, "status": status,
            "message": message, "elapsed_ms": elapsed_ms, "assertions": [], "detail": {}}


async def _run_commands(page: Any, commands: list, elements: Mapping, vars_: dict[str, str],
                        result: UiResult, base_url: str | None, default_ms: int,
                        deadline: float | None, cancelled, capture) -> None:
    """主循环：逐命令执行，红即停（fail_fast），停后剩余补 skip；D5 制品在这里记账。"""
    result.ok = True  # 走到这里 = 浏览器起得来、页面建得起（「跑起来了」的最小事实）
    stopped_reason: str | None = None   # None | "timeout" | "cancel" | "fail_fast"
    has_failure = False
    for step in commands:
        row = _row_cmd(step, "pass", None, 0)
        t0 = time.perf_counter()
        if not isinstance(step, Mapping):
            row.update(status="error", message="命令必须是 JSON 对象（§7.2），实际是 "
                       + type(step).__name__)
            row["elapsed_ms"] = 0
            result.commands.append(row)
            has_failure = True
            stopped_reason = "fail_fast"
            continue
        if stopped_reason is not None:
            reason = ("运行超时（max_runtime_ms），未执行" if stopped_reason == "timeout"
                      else "运行已中止（取消或前序失败），未执行")
            row.update(status="skip", message=reason, elapsed_ms=0)
            result.commands.append(row)
            continue
        if deadline is not None and time.perf_counter() >= deadline:
            stopped_reason = "timeout"
            result.error = "运行超时：已达 max_runtime_ms 上限，剩余命令已跳过"
            row.update(status="skip", message="运行超时（max_runtime_ms），未执行", elapsed_ms=0)
            result.commands.append(row)
            continue
        if await cancelled():
            stopped_reason = "cancel"
            row.update(status="cancelled", message="运行已取消，本步未执行", elapsed_ms=0)
            result.commands.append(row)
            continue
        try:
            message = await _exec_one(page, step, elements, vars_, result, base_url,
                                      default_ms, deadline, cancelled, capture, row)
            row["message"] = message
        except _Cancelled:
            row.update(status="cancelled", message="等待被取消",
                       elapsed_ms=int((time.perf_counter() - t0) * 1000))
            result.commands.append(row)
            stopped_reason = "cancel"
            continue
        except _DeadlineHit:
            row.update(status="error",
                       message="运行超时：已达 max_runtime_ms 上限，本步被中止",
                       elapsed_ms=int((time.perf_counter() - t0) * 1000))
            result.commands.append(row)
            result.error = "运行超时：已达 max_runtime_ms 上限，剩余命令已跳过"
            has_failure = True
            stopped_reason = "timeout"
            continue
        except Exception as e:  # noqa: BLE001 单命令一切意外 = error 行（红），不抛穿
            row.update(status="error", message=type(e).__name__ + ": " + _short(str(e), 180),
                       elapsed_ms=int((time.perf_counter() - t0) * 1000))
        row["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
        result.commands.append(row)
        if row["status"] in ("fail", "error"):
            has_failure = True
            # 失败自动制品（§6.3 + D5）：当场 1 图 + 1 DOM，配额内
            await capture(page, row["id"], "命令失败自动截图", "shot")
            await capture(page, row["id"], "命令失败自动 DOM 快照", "dom")
            if not step.get("optional"):
                stopped_reason = "fail_fast"

    # D5 终态截图：无论绿红都留一张现场（配额未尽时；裁掉的已记进 overflow 说出口）
    last_id = result.commands[-1]["id"] if result.commands else "?"
    await capture(page, last_id, "整案终态截图", "shot")
    result.passed = (not has_failure and result.error is None
                     and all(c["status"] in ("pass", "skip") for c in result.commands))


async def _exec_one(page: Any, step: Mapping, elements: Mapping, vars_: dict[str, str],
                    result: UiResult, base_url: str | None, default_ms: int,
                    deadline: float | None, cancelled, capture, row: dict) -> str:
    """执行一条命令，返回 message。判定不成立 → row.status=fail 后正常返回；
    这一步跑不动 → 抛异常/置 error（fail/error 之分就钉在这一个函数里）。"""
    t = step.get("type")
    tm = _cmd_timeout(step, default_ms)

    if t not in _SUPPORTED:
        row["status"] = "error"
        if t in ("upload", "download", "switch_frame", "switch_window", "dialog_accept"):
            return _BLOCKED_1C + "；保存期已拒（T4），执行核仍防御性拒绝，不静默跳过"
        return "未知命令类型 " + repr(t) + "（§7.2 全集 24 种，本核实现 19 种）"

    text, err = _render_maybe(step.get("input"), vars_)
    if err is not None:
        row["status"] = "error"
        return err

    if t == "open":
        url = text if "://" in text else (base_url or "").rstrip("/") + "/" + str(text).lstrip("/")
        await page.goto(url, timeout=tm)
        return "打开 " + url

    if t in ("click", "dblclick", "hover", "input", "clear", "select"):
        sel, label = _resolve(step, elements)
        if sel is None:
            row["status"] = "error"
            return label
        action = {"input": "fill", "clear": "clear_fill", "select": "select_option"}.get(t, t)
        try:
            if action == "fill":
                await page.fill(sel, text, timeout=tm)
            elif action == "clear_fill":
                await page.fill(sel, "", timeout=tm)
            elif action == "select_option":
                await page.select_option(sel, text, timeout=tm)
            elif action == "dblclick":
                await page.dblclick(sel, timeout=tm)
            elif action == "hover":
                await page.hover(sel, timeout=tm)
            else:
                await page.click(sel, timeout=tm)
        except Exception as e:  # noqa: BLE001 定位/动作失败 = error（红），说人话
            raise _locator_error(e, label, tm) from e
        return t + " " + label + (" ← " + _short(text, 60) if t == "input" else "")

    if t == "key":
        try:
            await page.keyboard.press(text)
        except Exception as e:  # noqa: BLE001
            row["status"] = "error"
            return "按键 " + repr(text) + " 失败：" + type(e).__name__ + ": " + _short(str(e), 150)
        return "按键 " + text

    if t == "scroll":
        if _has_locator(step):
            sel, label = _resolve(step, elements)
            if sel is None:
                row["status"] = "error"
                return label
            try:
                await page.locator(sel).scroll_into_view_if_needed(timeout=tm)
            except Exception as e:  # noqa: BLE001
                raise _locator_error(e, label, tm) from e
            return "滚动到 " + label
        try:
            dy = int(text) if str(text).strip() != "" else 300
        except ValueError:
            row["status"] = "error"
            return "scroll 的 input 是像素数（无定位目标时），收到 " + repr(step.get("input"))
        await page.mouse.wheel(0, dy)
        return "滚动 " + str(dy) + "px"

    if t == "wait_element":
        sel, label = _resolve(step, elements)
        if sel is None:
            row["status"] = "error"
            return label
        try:
            await page.wait_for_selector(sel, state="visible", timeout=tm)
        except Exception as e:  # noqa: BLE001 等不到 = 没跑成 = error（红）
            raise _locator_error(e, label, tm) from e
        return "等到 " + label

    if t == "wait_text":
        sel, label = _resolve(step, elements)
        if sel is None:
            row["status"] = "error"
            return label
        try:
            await page.wait_for_selector(sel + ":has-text(" + _quote(text) + ")",
                                         state="visible", timeout=tm)
        except Exception as e:  # noqa: BLE001
            raise _locator_error(e, label + " 含文本 " + _short(text, 40), tm) from e
        return "等到 " + label + " 含文本 " + repr(text)

    if t == "sleep":
        try:
            ms = int(str(text).strip())
        except ValueError:
            row["status"] = "error"
            return "sleep 的 input 必须是毫秒数，收到 " + repr(step.get("input"))
        left = max(0, ms)
        while True:
            # 切片睡眠 + 每片查取消（h_sleep 同款：一口气睡满会让「停止」等到超时才生效）
            if await cancelled():
                raise _Cancelled
            if deadline is not None and time.perf_counter() >= deadline:
                raise _DeadlineHit
            if left <= 0:
                break
            piece = min(left, SLEEP_SLICE_MS)
            await asyncio.sleep(piece / 1000.0)
            left -= piece
        return "等待 " + str(ms) + "ms"

    if t in _ASSERT_TYPES:
        return await _assert(page, step, elements, t, text, tm, row)

    if t in ("get_text", "get_attr"):
        sel, label = _resolve(step, elements)
        if sel is None:
            row["status"] = "error"
            return label
        try:
            if t == "get_text":
                value: Any = await page.inner_text(sel, timeout=tm)
            else:
                value = await page.get_attribute(sel, text, timeout=tm)
        except Exception as e:  # noqa: BLE001
            raise _locator_error(e, label, tm) from e
        sv = step.get("save_var")
        if isinstance(sv, str) and sv:
            vars_[sv] = _stringify(value if value is not None else "")
        return t + " " + label + (" → ${" + sv + "}" if isinstance(sv, str) and sv else "")

    if t == "screenshot":
        # 显式截图同样吃 D5 配额——命令级截图不能把失败截图的配额吃光（裁掉会记账说出口）
        await capture(page, row["id"], "screenshot 命令", "shot")
        return "已截图"

    if t == "js":
        try:
            value = await page.evaluate(text)
        except Exception as e:  # noqa: BLE001 脚本崩 = 没跑成 = error，不是 fail
            row["status"] = "error"
            return "JS 执行失败 " + type(e).__name__ + ": " + _short(str(e), 150)
        sv = step.get("save_var")
        if isinstance(sv, str) and sv:
            vars_[sv] = _stringify(value)
        return "JS 结果 " + _short(_stringify(value), 120)

    row["status"] = "error"
    return "命令类型未实现（不应到达）: " + repr(t)


def _cmd_timeout(step: Mapping, default_ms: int) -> int:
    tm = step.get("timeout_ms")
    return tm if isinstance(tm, int) and not isinstance(tm, bool) and tm > 0 else default_ms


def _quote(text: str) -> str:
    """Playwright :has-text() 参数的引号转义（用双引号包裹并转义内部双引号）。"""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


async def _assert(page: Any, step: Mapping, elements: Mapping, t: str, text: str,
                  tm: int, row: dict) -> str:
    """三种断言。判定不成立 → fail（橙）；连判定对象都没有 → error（红，走异常/置位）。

    assert_element 的语义就是「在不在」——等不到是**判定结论**（fail），不是没跑成；
    assert_text 找不到元素则连文本都没得读，属于没跑成（error），两色不混。
    """
    if t == "assert_title":
        actual = await page.title()
        passed = text in actual
        row["assertions"] = [_row("assert_title", passed, text, actual, None, "page.title()")]
        row["status"] = "pass" if passed else "fail"
        return "标题" + ("含" if passed else "不含") + " " + repr(text) + "（实际 " + repr(actual) + "）"
    sel, label = _resolve(step, elements)
    if sel is None:
        row["status"] = "error"
        return label
    if t == "assert_element":
        try:
            await page.wait_for_selector(sel, state="visible", timeout=tm)
            found = True
        except Exception:  # noqa: BLE001 TimeoutError 即「不在」——这是判定结论
            found = False
        expected = step.get("input")
        expect_absent = expected in (False, "absent", "false")
        passed = (not found) if expect_absent else found
        row["assertions"] = [_row("assert_element", passed,
                                  expected if expected is not None else "存在",
                                  "可见" if found else "未找到", None, label)]
        row["status"] = "pass" if passed else "fail"
        return "元素 " + label + (" " if found else " 未") + "可见"
    try:
        await page.wait_for_selector(sel, state="visible", timeout=tm)
        actual_text = await page.inner_text(sel, timeout=tm)
    except Exception as e:  # noqa: BLE001 判定对象都没有 = error
        raise _locator_error(e, label, tm) from e
    passed = text in actual_text
    row["assertions"] = [_row("assert_text", passed, text, _short(actual_text), None, label)]
    row["status"] = "pass" if passed else "fail"
    return "元素 " + label + " 文本" + ("含" if passed else "不含") + " " + repr(text)
