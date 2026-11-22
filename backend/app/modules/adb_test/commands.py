"""ADB 步骤协议与保存期校验（§7.3）：纯函数、无 DB、无 IO——ui_test/commands.py 同族。

steps 是**扁平步骤数组**（§7.3 的 step 对象：{id,type,device,config,pre_wait_ms,optional}），
issue 按数组 index 定位。对外唯一契约：**任何输入都返回 issue 列表，绝不抛**——
steps 是前端自由 JSON，畸形步骤必须是 422 里的可读问题，不是 500。

三条这里特有的口径：
- `empty_steps` 与 UI 同罪：空步骤用例跑起来「零步全绿」是假绿，保存期就拦（§13 纪律 1）。
- **录屏成对**（§6.4「起止命令包裹」）是序列级规则：screen_record_stop 之前必须有未配对的
  start，start 也不许套 start。这条在保存期拦而不是执行期——执行到一半才发现没配对，
  前面所有步骤的白跑比 422 贵得多。
- 参数表是**声明式**的（CFG_SCHEMA：type → {key: kind}，`!` 前缀 = 必填），前端孪生
  web/src/adb/commands.ts 抄同一张表；两份由 test_adb_commands.py 与 commands.test.ts
  的**同一批用例表**钉住不漂，后端仍是最终真相（与 R100/R101 的孪生对完全同构）。

26 个 type 逐字取自 §7.3 的枚举串，顺序即原文顺序，不发明、不改名、不重排。
本文件只管**形状**：某 type 在设备上到底做不做得到（如 assert_toast 的抓取可行性，
前置取证 ⑪ / D21）是执行核 T6 与业主裁决的事，不在保存期装懂。
"""
from __future__ import annotations

import re
from typing import Any

# §7.3 line 403 的枚举串，26 种，原文顺序。
STEP_TYPES: tuple[str, ...] = (
    "connect", "shell", "install", "uninstall", "start_app", "kill_app",
    "click_xy", "long_click", "swipe", "input_text",
    "click_by_text", "click_by_xpath",
    "assert_text", "assert_element", "assert_toast",
    "screenshot", "screen_record_start", "screen_record_stop",
    "sleep", "file_push", "file_pull", "assert_file",
    "back", "home", "open_url", "extract_ui_text",
)

# 中文标签（§11.4.12 行摘要用；§11.5.5 说的「参数表单随类型切换」用的也是这套名字）。
_LABELS: dict[str, str] = {
    "connect": "连接设备", "shell": "Shell 命令", "install": "安装 APK",
    "uninstall": "卸载应用", "start_app": "启动应用", "kill_app": "杀掉应用",
    "click_xy": "坐标点击", "long_click": "长按", "swipe": "滑动",
    "input_text": "输入文本", "click_by_text": "按文本点击", "click_by_xpath": "按XPath点击",
    "assert_text": "断言文本", "assert_element": "断言控件", "assert_toast": "断言Toast",
    "screenshot": "截图", "screen_record_start": "开始录屏", "screen_record_stop": "结束录屏",
    "sleep": "等待时间", "file_push": "推送文件", "file_pull": "拉取文件",
    "assert_file": "断言文件", "back": "返回键", "home": "Home 键",
    "open_url": "打开链接", "extract_ui_text": "提取界面文本",
}

# 声明式参数表：`!` 前缀 = 必填键。kind 语义见 _check_kind——
# text=非空串 / ms=正整数毫秒 / ms0=非负整数 / coord=非负整数坐标 / int=正整数 /
# bool / var=合法变量名 / pkg=包名 / addr=ip:port / url=http(s)://。
CFG_SCHEMA: dict[str, dict[str, str]] = {
    "connect": {"!addr": "addr"},
    "shell": {"!cmd": "text"},
    "install": {"!path": "text", "reinstall": "bool"},
    "uninstall": {"!package": "pkg"},
    "start_app": {"!package": "pkg", "activity": "text"},
    "kill_app": {"!package": "pkg"},
    "click_xy": {"!x": "coord", "!y": "coord"},
    "long_click": {"!x": "coord", "!y": "coord"},
    "swipe": {"!x1": "coord", "!y1": "coord", "!x2": "coord", "!y2": "coord",
              "duration_ms": "ms"},
    "input_text": {"!text": "text"},
    "click_by_text": {"!text": "text", "timeout_ms": "ms"},
    "click_by_xpath": {"!xpath": "text", "timeout_ms": "ms"},
    "assert_text": {"!text": "text", "timeout_ms": "ms", "mode": "enum:contains|equals"},
    "assert_element": {"!by": "enum:text|xpath|resource_id", "!value": "text",
                       "timeout_ms": "ms"},
    "assert_toast": {"!text": "text", "timeout_ms": "ms"},
    "screenshot": {"save_var": "var"},
    "screen_record_start": {"max_s": "int"},
    "screen_record_stop": {"save_var": "var"},
    "sleep": {"!ms": "ms"},
    "file_push": {"!local": "text", "!remote": "text"},
    "file_pull": {"!remote": "text", "local": "text"},
    "assert_file": {"!remote": "text", "contains": "text"},
    "back": {},
    "home": {},
    "open_url": {"!url": "url"},
    "extract_ui_text": {"!save_var": "var", "by": "enum:text|xpath|resource_id",
                        "value": "text"},
}

# 断言类步骤：可选字段 `optional`（失败不阻断）只对断言/提取有意义——点在 UI 上
# §11.4.12 的「optional」列，执行语义见 T6（失败记 fail 但整案继续）。
OPTIONAL_ALLOWED = frozenset({"assert_text", "assert_element", "assert_toast", "assert_file",
                              "extract_ui_text", "screenshot"})

MAX_ID_LENGTH = 40  # 同 UI：id 进 run_step_result.step_key（R102）
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1," + str(MAX_ID_LENGTH) + r"}$")
_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PKG_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$")
_ADDR_RE = re.compile(r"^[A-Za-z0-9._-]+:\d{1,5}$")
_URL_RE = re.compile(r"^https?://\S+$")
Issue = dict[str, Any]


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _check_kind(key: str, val: Any, kind: str) -> str | None:
    """单键校验：返回人话问题（None = 合法）。kind 词表与前端孪生逐字一致。"""
    if kind == "text":
        if not (isinstance(val, str) and val.strip() != ""):
            return key + " 必须是非空字符串"
        return None
    if kind == "ms":
        if not (_is_int(val) and val > 0):
            return key + " 必须是正整数毫秒，实际是 " + repr(val)
        return None
    if kind in ("ms0", "coord"):
        if not (_is_int(val) and val >= 0):
            return key + (" 必须是正整数毫秒（0=立即）" if kind == "ms0"
                          else " 必须是非负整数坐标") + "，实际是 " + repr(val)
        return None
    if kind == "int":
        if not (_is_int(val) and val > 0):
            return key + " 必须是正整数，实际是 " + repr(val)
        return None
    if kind == "bool":
        if not isinstance(val, bool):
            return key + " 必须是 true/false，实际是 " + repr(val)
        return None
    if kind == "var":
        if not (isinstance(val, str) and bool(_VAR_RE.fullmatch(val))):
            return (key + " " + repr(val) + " 不是合法变量名：只能是字母/数字/下划线，"
                    "且不能以数字开头（结果要存进执行变量）")
        return None
    if kind == "pkg":
        if not (isinstance(val, str) and bool(_PKG_RE.fullmatch(val))):
            return key + " " + repr(val) + " 不是合法包名（如 com.example.app）"
        return None
    if kind == "addr":
        if not (isinstance(val, str) and bool(_ADDR_RE.fullmatch(val))):
            return key + " " + repr(val) + " 不是 ip:port（§6.4 WiFi 地址，如 192.168.1.20:5555）"
        # 形状对但端口 65535+ 的设备永远连不上——保存期就说不通，别留到执行期演一遍失败
        if int(val.rsplit(":", 1)[1]) > 65535:
            return key + " " + repr(val) + " 的端口超过 65535，不可能是 adb 端口"
        return None
    if kind == "url":
        if not (isinstance(val, str) and bool(_URL_RE.fullmatch(val.strip()))):
            return key + " " + repr(val) + " 不是 http(s) 链接"
        return None
    if kind.startswith("enum:"):
        allowed = kind[5:].split("|")
        if val not in allowed:
            return key + " " + repr(val) + " 不是可选值之一：" + " / ".join(allowed)
        return None
    return "内部错误：未知校验种类 " + repr(kind)  # 表写错时的自曝，不该在生产出现


def _validate_config(i: int, t: str, config: Any, issue) -> None:
    schema = CFG_SCHEMA[t]
    if config is None:
        config = {}  # §7.3 步骤对象带 config；缺省按空配置处理，必填键自然被下面拦下
    if not isinstance(config, dict):
        issue(i, "bad_config", t + " 的 config 必须是 JSON 对象（§7.3），实际是 "
              + type(config).__name__)
        return
    for spec, kind in schema.items():
        required = spec.startswith("!")
        key = spec[1:] if required else spec
        if key not in config or config.get(key) is None:
            if required:
                issue(i, "missing_config", t + " 缺少必填参数 " + key
                      + "（§11.4.12 展开行的参数表单就是按这张表生成的，§7.3）")
            continue
        prob = _check_kind(key, config.get(key), kind)
        if prob is not None:
            issue(i, "bad_config", t + "：" + prob)
    # extract_ui_text 的选择器成对规则（§7.3 之外唯一的跨键规则，前端孪生同规）：
    # 只给 by 不给 value = 「知道在哪找却不知道找什么」，运行时无法两全。
    if t == "extract_ui_text":
        by, value = config.get("by"), config.get("value")
        if (by is None) != (value is None):
            issue(i, "bad_selector_pair",
                  "extract_ui_text 的 by 与 value 必须成对：只给一半等于没说清从哪提取")


def _validate_recording_pairs(steps: list, issue) -> None:
    """录屏「起止包裹」（§6.4）：stop 必须配对一个先行的未配对 start。

    刻意扫**整条序列**而不是逐步独立判——配对是序列属性。报错指向 stop 的下标，
    因为「没有 start 的 stop」是画布上那条真正没被包裹的孤儿线。
    """
    open_start = -1  # 未配对的 start 下标；-1 = 当前没在录
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        t = step.get("type")
        if t == "screen_record_start":
            if open_start >= 0:
                issue(i, "record_unpaired",
                      "第 " + str(open_start + 1) + " 行的「开始录屏」还没结束就又开了一段"
                      "（§6.4 录屏是起止包裹，一段没结束不能开下一段）")
            open_start = i
        elif t == "screen_record_stop":
            if open_start < 0:
                issue(i, "record_unpaired",
                      "「结束录屏」前面没有未结束的「开始录屏」（§6.4 起止包裹）："
                      "没有 start 的 stop 执行时会对着空气收尾")
            else:
                open_start = -1
    if open_start >= 0:
        issue(open_start, "record_unpaired",
              "第 " + str(open_start + 1) + " 行的「开始录屏」没有配对的「结束录屏」"
              "（录屏文件不会 finalize，整段录制作废，§6.4）")


def _short(x: Any, limit: int = 60) -> str:
    # 调用方一律先经 val()（非空串或 None）：None 必须返回**空串**让 `or "（未填…）"` 兜底
    # 接住——写 str(None) 会产出 "Shell 命令 None"，前端孪生给的是（未填命令），当场漂。
    if not isinstance(x, str) or x == "":
        return ""
    return x if len(x) <= limit else repr(x)


def summarize(step: Any) -> str:
    """§11.4.12 行摘要：命令名 + 一个最能代表「这步在干什么」的参数。绝不抛。"""
    if not isinstance(step, dict):
        return "步骤（" + type(step).__name__ + "）"
    t = step.get("type")
    if not isinstance(t, str) or t == "":
        return "步骤（未填类型）"
    label = _LABELS.get(t, t)
    config = step.get("config")
    cfg = config if isinstance(config, dict) else {}

    def val(key: str) -> Any:
        v = cfg.get(key)
        return v if isinstance(v, str) and v.strip() != "" else None

    if t == "shell":
        return label + " " + (_short(val("cmd")) or "（未填命令）")
    if t in ("click_by_text", "click_by_xpath", "assert_text", "assert_toast", "input_text",
             "open_url", "connect"):
        key = {"click_by_text": "text", "click_by_xpath": "xpath", "assert_text": "text",
               "assert_toast": "text", "input_text": "text", "open_url": "url",
               "connect": "addr"}[t]
        return label + " " + (_short(val(key)) or "（未填）")
    if t in ("uninstall", "start_app", "kill_app"):
        return label + " " + (_short(val("package")) or "（未填包名）")
    if t in ("click_xy", "long_click"):
        x, y = cfg.get("x"), cfg.get("y")
        return label + (" (" + str(x) + "," + str(y) + ")" if _is_int(x) and _is_int(y)
                        else " （未填坐标）")
    if t == "swipe":
        pts = (cfg.get("x1"), cfg.get("y1"), cfg.get("x2"), cfg.get("y2"))
        return label + (" →" if all(_is_int(p) for p in pts) else " （未填坐标）")
    if t == "sleep":
        ms = cfg.get("ms")
        return label + (" " + str(ms) + " ms" if _is_int(ms) else " （未填）")
    if t in ("file_push", "file_pull", "assert_file"):
        head = label + " " + (_short(val("remote")) or "（未填设备路径）")
        return head + (" 含「" + _short(val("contains")) + "」"
                       if t == "assert_file" and val("contains") else "")
    if t == "assert_element":
        return label + " " + (_short(val("value")) or "（未填）") + \
            (" [" + val("by") + "]" if val("by") else "")
    if t in ("screenshot", "screen_record_stop"):
        sv = val("save_var")
        return label + (" → $" + sv if sv else "")
    if t == "screen_record_start":
        mx = cfg.get("max_s")
        return label + (" ≤" + str(mx) + "s" if _is_int(mx) else "")
    if t == "extract_ui_text":
        sv = val("save_var")
        return label + (" → $" + sv if sv else " （未填变量）")
    return label


def validate_steps(steps: object) -> list[Issue]:
    """保存期校验：issue 列表（空 = 可保存）。对任何输入不抛异常、不改入参。"""
    issues: list[Issue] = []

    def issue(index: int, code: str, message: str) -> None:
        issues.append({"index": index, "code": code, "message": message})

    if not isinstance(steps, list):
        issue(-1, "bad_step", "ADB 步骤序列必须是 JSON 数组（§7.3），实际是 "
              + type(steps).__name__)
        return issues
    if not steps:
        issue(-1, "empty_steps",
              "步骤序列不能为空：空用例跑起来「零步全绿」是假绿，保存期就拦（§7.3/§13 纪律 1）")
        return issues

    seen: set[str] = set()
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            issue(i, "bad_step", "步骤必须是 JSON 对象（§7.3），实际是 " + type(step).__name__)
            continue

        sid = step.get("id")
        if not (isinstance(sid, str) and _ID_RE.fullmatch(sid)):
            issue(i, "bad_id", "步骤 id "
                  + repr(sid if isinstance(sid, str) or sid is None else str(sid))
                  + " 不合法：只允许字母数字下划线短横线，长 1-" + str(MAX_ID_LENGTH)
                  + "（id 会写进 run_step_result.step_key，R102）")
        elif sid in seen:
            issue(i, "dup_id", "步骤 id " + repr(sid) + " 重复；同一用例内必须唯一（R102）")
        else:
            seen.add(sid)

        t = step.get("type")
        if t not in STEP_TYPES:
            issue(i, "unknown_type", "未知步骤类型 "
                  + repr(t if isinstance(t, str) or t is None else str(t))
                  + "；§7.3 全集共 " + str(len(STEP_TYPES)) + " 种：" + "|".join(STEP_TYPES))
            continue

        _validate_config(i, t, step.get("config"), issue)

        dev = step.get("device")
        if dev is not None and not (isinstance(dev, str) and dev.strip() != ""):
            issue(i, "bad_device", "步骤的 device 给「auto」或设备 id 字符串（§7.3 的按步设备"
                  "覆盖；id 是否存在在执行期核），实际是 " + repr(dev))
        pw = step.get("pre_wait_ms")
        if pw is not None and not (_is_int(pw) and pw >= 0):
            issue(i, "bad_pre_wait", "pre_wait_ms 给了就必须是非负整数毫秒（§7.3），实际是 "
                  + repr(pw))
        opt = step.get("optional")
        if opt is not None and not isinstance(opt, bool):
            issue(i, "bad_optional", "optional 给了就必须是 true/false（§7.3 失败不阻断），"
                  "实际是 " + repr(opt))
        if opt is True and t not in OPTIONAL_ALLOWED:
            issue(i, "optional_on_action", t + " 不是断言/提取类步骤，不允许 optional=true"
                  "（操作类步骤失败不继续是语义错误：点了没点上，后面全是对着空气操作）")

    _validate_recording_pairs(steps, issue)
    return issues
