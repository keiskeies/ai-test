"""UI 命令协议与保存期校验（设计 §7.2）：纯函数、无 DB、无 IO。

UI 用例的 steps 是**扁平命令数组**（不像 step_graph 有树与 key 层级），所以 issue 按
数组 `index` 定位，不需要 key+path。对外唯一契约：**任何输入都返回 issue 列表，绝不
抛异常** —— steps 是前端自由 JSON，畸形命令必须是 422 里的可读问题，不是 500。

`empty_steps` 是这批 code 里最重要的一个：空用例跑起来「零步全绿」是假绿，必须保存期
就拦（§13 纪律 1；R48 把场景里没人执行的 kind 拦在保存期，这里是同一口径）。

前端 web/src/ui/commands.ts 是同一套规则的第二份实现（画布要即时反馈，不能等 422）；
两份由 test_ui_commands.py 与 commands.test.ts 里**同一批用例表**钉住不漂，后端仍是
最终真相。summarize() 是前端 summary() 的后端孪生（供测试与 Pilot 展示）——刻意**不是**
「后端算好前端显示」，改文案不该发后端。
"""
from __future__ import annotations

import re
from typing import Any

# 24 种 type 逐字取自蓝图 §7.2 line 393 的枚举串（open|click|…|dialog_accept），
# 顺序即原文顺序，不发明、不改名、不重排。
COMMAND_TYPES: tuple[str, ...] = (
    "open", "click", "dblclick", "input", "clear", "select", "hover", "key", "scroll",
    "wait_element", "wait_text", "sleep", "assert_text", "assert_element", "assert_title",
    "get_text", "get_attr", "screenshot", "js",
    "upload", "download", "switch_frame", "switch_window", "dialog_accept",
)
# R101：这 5 种各需要独立机制（文件选择 / 下载目录监听 / frame 与窗口句柄生命周期 /
# 原生弹窗处理），1C 半做等于做假——保存期就拒，文案带批次，与 R48 kind_not_available
# 完全同构。值统一写 "1C+"：业主裁决 D1 若要求在 1C 内做完，整族删除即可。
BLOCKED_1C: dict[str, str] = {"upload": "1C+", "download": "1C+", "switch_frame": "1C+",
                              "switch_window": "1C+", "dialog_accept": "1C+"}
# R100/D2：蓝图自相矛盾——§4.4 表列 5 种（ID/CSS/XPATH/TEXT/NAME），§6.3 写「定位器六
# 类型」。一期按**表**做 5 个（表是字段定义，更接近数据契约），第 6 个待业主点名（候选
# placeholder）。表里是大写枚举名，小写入库（与全站词表一致），这里存小写。
ELEMENT_TYPES: tuple[str, ...] = ("id", "css", "xpath", "text", "name")

# 需要定位器的 12 种（24 − 5 blocked − 7 个不需要定位器的）。open 有 URL 无元素、
# sleep/screenshot/js 与页面级 key/scroll 不碰元素、assert_title 断言的是页面标题。
LOCATOR_REQUIRED = frozenset({
    "click", "dblclick", "input", "clear", "select", "hover",
    "wait_element", "wait_text", "assert_text", "assert_element",
    "get_text", "get_attr",
})
# §7.2/T4 点名的「必须有值」6 种：input 字段为空 = 这一步没有对象可操作。
INPUT_REQUIRED = frozenset({"input", "key", "select", "js", "assert_text", "assert_title"})

MAX_ID_LENGTH = 40  # 命令 id 会写进 run_step_result.step_key（R102），长度口径同场景 key 段
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1," + str(MAX_ID_LENGTH) + r"}$")
_SAVE_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
Issue = dict[str, Any]

# §6.3 括号里的中文命令名（§11.4.12 行摘要用）；js/screenshot 的惯用叫法是「执行JS/截图」。
_LABELS: dict[str, str] = {
    "open": "打开", "click": "点击", "dblclick": "双击", "input": "输入", "clear": "清除",
    "select": "选择", "hover": "悬停", "key": "按键", "scroll": "滚动",
    "wait_element": "等待元素", "wait_text": "等待文本", "sleep": "等待时间",
    "assert_text": "断言文本", "assert_element": "断言元素", "assert_title": "断言标题",
    "get_text": "获取文本", "get_attr": "获取属性", "screenshot": "截图", "js": "执行JS",
    "upload": "上传", "download": "下载", "switch_frame": "切frame",
    "switch_window": "切窗口", "dialog_accept": "处理弹窗",
}


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _text(x: Any) -> bool:
    return isinstance(x, str) and x.strip() != ""


def _has_locator(step: dict) -> bool:
    return step.get("element_id") is not None or step.get("inline_locator") is not None


def _locator_problem(loc: Any) -> str | None:
    """inline_locator 必须是 {type∈ELEMENT_TYPES, value 非空串}（§7.2 就地定位）。"""
    if not isinstance(loc, dict):
        return "inline_locator 必须是 {type, value} 对象，实际是 " + type(loc).__name__
    t = loc.get("type")
    if t not in ELEMENT_TYPES:
        return ("inline_locator.type " + repr(t or "(未填)") + " 不是定位器类型；一期支持（R100/D2，"
                "§4.4 表 5 种）：" + " / ".join(ELEMENT_TYPES))
    if not _text(loc.get("value")):
        return "inline_locator.value 不能为空：定位器类型后面得真的写出表达式"
    return None


def _element_ref(step: dict, element_names: dict[str, str]) -> str:
    """行摘要里的元素段：元素名优先，查不到退回 id 原文，就地定位显示 type:value。"""
    eid = step.get("element_id")
    if isinstance(eid, str) and eid != "":
        if isinstance(element_names, dict):
            name = element_names.get(eid)
            if isinstance(name, str) and name != "":
                return name
        return "元素 " + eid
    loc = step.get("inline_locator")
    if isinstance(loc, dict):
        # 先各绑一个局部名再判类型：`x.get(k) if isinstance(x.get(k), str)` 让 mypy
        # 在两个不同的调用之间丢失窄化（它不假设两次 get 返回同一个值），于是
        # `t + ":" + v` 报「None 不能相加」。绑定后判定与使用读的是同一个对象。
        raw_t = loc.get("type")
        raw_v = loc.get("value")
        t = raw_t if isinstance(raw_t, str) else "?"
        v = raw_v if isinstance(raw_v, str) else "?"
        return t + ":" + v
    return ""


def _short(x: Any, limit: int = 60) -> str:
    return x if isinstance(x, str) and len(x) <= limit else (repr(x) if isinstance(x, str) else str(x))


def summarize(step: Any, element_names: dict[str, str]) -> str:
    """§11.4.12 每行「命令名 + 关键参数摘要」。对任何输入都返回字符串，绝不抛。

    这是前端 summary() 的后端孪生（测试与 Pilot 展示用）；界面显示的是前端那份。
    """
    if not isinstance(step, dict):
        return "命令（" + type(step).__name__ + "）"
    t = step.get("type")
    if not isinstance(t, str) or t == "":
        return "命令（未填类型）"
    label = _LABELS.get(t, t)
    if t in LOCATOR_REQUIRED and not _has_locator(step):
        return label + " （未指定元素）"
    obj = _element_ref(step, element_names)
    if t == "input":
        return label + " " + _short(step.get("input")) + (" → " + obj if obj else "")
    if t == "sleep":
        val = step.get("input")
        return label + (" " + _short(val) + " ms" if val is not None else " （未填）")
    if t in ("open", "assert_title", "assert_text", "wait_text", "key", "js", "select"):
        val = step.get("input")
        return label + (" " + _short(val) if val is not None else " （未填）")
    if t == "wait_element":
        return label + " " + (obj or "（未指定元素）")
    if t in ("get_text", "get_attr"):
        head = label + " " + (obj or "（未指定元素）")
        sv = step.get("save_var")
        return head + (" → $" + sv if isinstance(sv, str) and sv != "" else "")
    if t == "scroll":
        return label + (" " + _short(step.get("input")) if _text(step.get("input")) else "")
    return label + (" " + obj if obj else "")


def validate_commands(steps: object) -> list[Issue]:
    """保存期校验：返回 issue 列表（空 = 可保存）。对任何输入都不抛异常、不改入参。"""
    issues: list[Issue] = []

    def issue(index: int, code: str, message: str) -> None:
        issues.append({"index": index, "code": code, "message": message})

    if not isinstance(steps, list):
        issue(-1, "bad_step",
              "UI 命令序列必须是 JSON 数组（§7.2 steps），实际是 " + type(steps).__name__)
        return issues
    if not steps:
        issue(-1, "empty_steps",
              "命令序列不能为空：空用例跑起来「零步全绿」是假绿，保存期就拦（§7.2/§13 纪律 1）")
        return issues

    seen: set[str] = set()
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            issue(i, "bad_step", "命令必须是 JSON 对象（§7.2），实际是 " + type(step).__name__)
            continue

        sid = step.get("id")
        # 判定内联而不是存进 id_ok：中间变量会让 isinstance 的窄化失效，下面
        # seen.add(sid) 就还是 Any|None（R102 的行键必须是 str）。
        if not (isinstance(sid, str) and _ID_RE.fullmatch(sid)):
            issue(i, "bad_id",
                  "命令 id " + repr(sid if isinstance(sid, str) or sid is None else str(sid))
                  + " 不合法：只允许字母数字下划线短横线，长 1-" + str(MAX_ID_LENGTH)
                  + "（id 会写进 run_step_result.step_key，R102）")
        elif sid in seen:
            issue(i, "dup_id", "命令 id " + repr(sid) + " 重复；同一用例内必须唯一"
                  + "（步骤明细以 id 为行键，R102）")
        else:
            seen.add(sid)

        t = step.get("type")
        if t not in COMMAND_TYPES:
            issue(i, "unknown_type", "未知命令类型 " + repr(t if isinstance(t, str) or t is None
                  else str(t)) + "；§7.2 全集共 " + str(len(COMMAND_TYPES)) + " 种："
                  + "|".join(COMMAND_TYPES))
            continue
        if t in BLOCKED_1C:
            issue(i, "command_not_available",
                  t + " 命令要到 " + BLOCKED_1C[t] + " 批次才开放（R101：文件选择/下载监听/"
                  "frame 与窗口句柄/原生弹窗各需独立机制，半做等于做假），现在保存会被拒绝")
            continue

        if t in LOCATOR_REQUIRED:
            eid = step.get("element_id")
            loc = step.get("inline_locator")
            if eid is not None and loc is not None:
                issue(i, "both_locators",
                      "element_id 与 inline_locator 二选一（§7.2 line 393）：两个都给了，"
                      "运行时不知道听谁的")
            elif eid is None and loc is None:
                issue(i, "missing_element_ref", t + " 需要定位目标：选一个元素库元素，"
                      "或用 inline_locator 就地定位")
            elif eid is None:
                prob = _locator_problem(loc)
                if prob is not None:
                    issue(i, "bad_locator", prob)

        tm = step.get("timeout_ms")
        if tm is not None and not (_is_int(tm) and tm > 0):
            issue(i, "bad_timeout", "timeout_ms 给了就必须是正整数毫秒（§7.2 示例 10000），"
                  "实际是 " + repr(tm))

        sv = step.get("save_var")
        if sv is not None and not (isinstance(sv, str) and bool(_SAVE_VAR_RE.fullmatch(sv))):
            issue(i, "bad_save_var", "save_var " + repr(sv) + " 不是合法变量名：只能是字母/数字/"
                  "下划线，且不能以数字开头（get_text/get_attr/js 的结果要存进变量）")

        if t in INPUT_REQUIRED and not _text(step.get("input")):
            issue(i, "missing_input", t + " 必须有 input：" + {
                "input": "要知道往元素里填什么",
                "key": "要知道按哪个键（如 Enter）",
                "select": "要选哪个选项值",
                "js": "要执行什么脚本",
                "assert_text": "要断言什么文本",
                "assert_title": "要断言什么标题",
            }[t])
    return issues
