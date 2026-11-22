"""1C T4：§7.2 UI 命令协议与保存期校验（纯函数、无 DB）。

钉的是「保存期能不能拦住」：`empty_steps` 最重要——空用例跑起来「零步全绿」是假绿，
必须保存期就拦（与 R48 kind_not_available 同一诚实口径）。validate_commands 对任何
输入只产 issue、绝不抛异常——前端自由 JSON 不能变成 500。

前端 web/src/ui/commands.ts 是同一套规则的第二个实现；两边由**同一批用例表**钉住不漂
（case 名与本文件对齐，见该文件测试）。
"""
from __future__ import annotations

import copy

from app.modules.ui_test.commands import (
    BLOCKED_1C,
    COMMAND_TYPES,
    ELEMENT_TYPES,
    summarize,
    validate_commands,
)

# §7.2 需要定位器的 12 种（24 - 5 blocked - open/sleep/screenshot/js/assert_title/key/scroll）
LOCATOR_REQUIRED = [
    "click", "dblclick", "input", "clear", "select", "hover",
    "wait_element", "wait_text", "assert_text", "assert_element",
    "get_text", "get_attr",
]
# 不需要定位器的 7 种（前 4 个是任务点名的，assert_title 是页面级标题，
# key/scroll 可以页面级按键/滚轮，不需要元素）
NO_LOCATOR = ["open", "sleep", "screenshot", "js", "assert_title", "key", "scroll"]
# §7.2/T4「必须有值」的 6 种
INPUT_REQUIRED = ["input", "key", "select", "js", "assert_text", "assert_title"]


def step(t: str, **extra) -> dict:
    """一条最小可保存命令：需要定位器/输入值的类型自动补上。"""
    s: dict = {"id": "u1", "type": t, "element_id": None, "inline_locator": None,
               "input": None, "timeout_ms": None, "save_var": None, "optional": False}
    if t in LOCATOR_REQUIRED:
        s["element_id"] = "e1"
    if t in INPUT_REQUIRED:
        s["input"] = "v"
    s.update(extra)
    return s


def doc_example() -> list:
    """§7.2 示例逐字誊写：`"<元素库id>"` 是占位符，补成真实 id；null 保持 None。"""
    return [{"id": "u1", "type": "click", "element_id": "e-login-btn", "inline_locator": None,
             "input": None, "timeout_ms": 10000, "save_var": None, "optional": False}]


def codes(issues) -> list[str]:
    return sorted(i["code"] for i in issues)


# —— 协议对齐试金石 ——

def test_doc_example_is_valid() -> None:
    """§7.2 的示例逐字对齐：零 issue。"""
    assert validate_commands(doc_example()) == []


def test_command_types_verbatim_from_blueprint() -> None:
    """24 个 type 逐字取自 §7.2 line 393，顺序也不许动。"""
    assert COMMAND_TYPES == (
        "open", "click", "dblclick", "input", "clear", "select", "hover", "key", "scroll",
        "wait_element", "wait_text", "sleep", "assert_text", "assert_element", "assert_title",
        "get_text", "get_attr", "screenshot", "js",
        "upload", "download", "switch_frame", "switch_window", "dialog_accept",
    )
    assert len(COMMAND_TYPES) == 24


def test_blocked_1c_five_types() -> None:
    """R101：5 种在保存期就诚实拒绝，值带批次。"""
    assert BLOCKED_1C == {"upload": "1C+", "download": "1C+", "switch_frame": "1C+",
                          "switch_window": "1C+", "dialog_accept": "1C+"}
    for t in BLOCKED_1C:
        issues = validate_commands([step(t)])
        assert codes(issues) == ["command_not_available"], t
        assert t in issues[0]["message"], "要点名是哪条命令"
        assert "1C+" in issues[0]["message"], "要告诉用户什么时候能用，不是只说不支持"


def test_element_types_is_five_per_R100() -> None:
    """R100/D2：§4.4 表 5 个 vs §6.3「六类型」是蓝图自相矛盾，一期按表做 5 个。"""
    assert ELEMENT_TYPES == ("id", "css", "xpath", "text", "name")


# —— 24 种 type 的最小合法步 ——

def test_every_type_minimal_legal() -> None:
    for t in COMMAND_TYPES:
        issues = validate_commands([step(t)])
        expect = ["command_not_available"] if t in BLOCKED_1C else []
        assert codes(issues) == expect, (t, issues)


# —— element_id 与 inline_locator 二选一（§7.2 line 393）——

def test_locator_xor_one_is_enough() -> None:
    for t in LOCATOR_REQUIRED:
        assert validate_commands([step(t, element_id="e1", inline_locator=None)]) == [], t
        loc = {"type": "css", "value": "#btn"}
        assert validate_commands([step(t, element_id=None, inline_locator=loc)]) == [], t


def test_both_locators_rejected() -> None:
    for t in LOCATOR_REQUIRED:
        issues = validate_commands([step(t, element_id="e1", inline_locator={"type": "css", "value": "#b"})])
        assert codes(issues) == ["both_locators"], (t, issues)
        assert "二选一" in issues[0]["message"]


def test_missing_element_ref_for_locator_types() -> None:
    assert len(LOCATOR_REQUIRED) == 12
    for t in LOCATOR_REQUIRED:
        issues = validate_commands([step(t, element_id=None)])
        assert codes(issues) == ["missing_element_ref"], (t, issues)


def test_no_locator_types_ok_without_any() -> None:
    for t in NO_LOCATOR:
        assert validate_commands([step(t, element_id=None)]) == [], t


def test_bad_locator_shapes() -> None:
    bads = [{"type": "css"}, {"value": "#b"}, {"type": "jquery", "value": "#b"},
            {"type": "CSS", "value": "#b"}, {"type": "css", "value": ""},
            {"type": 3, "value": "#b"}, "css=#b", ["css", "#b"], 42]
    for bad in bads:
        issues = validate_commands([step("click", element_id=None, inline_locator=bad)])
        assert codes(issues) == ["bad_locator"], (bad, issues)


# —— timeout / id / save_var ——

def test_bad_timeout_values() -> None:
    for bad in [0, -1, "10", 1.5, True]:
        issues = validate_commands([step("click", timeout_ms=bad)])
        assert codes(issues) == ["bad_timeout"], (bad, issues)
    assert validate_commands([step("click", timeout_ms=10000)]) == []
    assert validate_commands([step("click", timeout_ms=None)]) == [], "null=用默认超时"


def test_dup_id_points_at_second_row() -> None:
    issues = validate_commands([step("screenshot", id="u1"), step("screenshot", id="u1")])
    assert codes(issues) == ["dup_id"]
    assert issues[0]["index"] == 1


def test_bad_id_shapes() -> None:
    for bad in ["", "a b", "中文", "u1.", "u" * 41, 123, None]:
        issues = validate_commands([step("screenshot", id=bad)])
        assert codes(issues) == ["bad_id"], (bad, issues)


def test_bad_save_var() -> None:
    for bad in ["a b", "1a", "a-b", "中文", ""]:
        issues = validate_commands([step("get_text", save_var=bad)])
        assert codes(issues) == ["bad_save_var"], (bad, issues)
    assert validate_commands([step("get_text", save_var="user_name")]) == []
    assert validate_commands([step("get_text", save_var=None)]) == []


# —— empty_steps：假绿的闸门 ——

def test_empty_steps_blocked() -> None:
    issues = validate_commands([])
    assert codes(issues) == ["empty_steps"]
    assert "假绿" in issues[0]["message"], "要说清为什么空数组不能存"


# —— missing_input：这 6 类必须有值 ——

def test_missing_input_types() -> None:
    assert len(INPUT_REQUIRED) == 6
    for t in INPUT_REQUIRED:
        for bad in [None, "", 42]:
            issues = validate_commands([step(t, input=bad)])
            assert codes(issues) == ["missing_input"], (t, bad, issues)


def test_optional_is_not_input() -> None:
    """optional（失败继续）是 bool 开关，不参与 missing_input。"""
    assert validate_commands([step("click", optional=True)]) == []


# —— unknown_type ——

def test_unknown_type() -> None:
    for bad in ["kafka_send", "", 3, None]:
        issues = validate_commands([step("screenshot", type=bad)])
        assert codes(issues) == ["unknown_type"], (bad, issues)
    assert "kafka_send" in validate_commands([step("screenshot", type="kafka_send")])[0]["message"]


# —— 畸形输入绝不抛异常 ——

def test_garbage_inputs_return_issues_not_exceptions() -> None:
    garbage = [None, "", "abc", 42, {}, {"steps": "x"}, [[]], [[{"id": "u1", "type": "screenshot"}]],
               ["x"], [None], [{}], [{"id": "u1", "type": 3}], [1, 2]]
    for g in garbage:
        out = validate_commands(g)  # type: ignore[arg-type]
        assert isinstance(out, list), g
        assert out, "垃圾输入必须产 issue，不能静默当成合法序列"
        for i in out:
            assert set(i) == {"index", "code", "message"}, i
            assert isinstance(i["index"], int), i


def test_validate_does_not_mutate_input() -> None:
    steps = doc_example() + [step("click", inline_locator={"type": "css", "value": "#b"})]
    before = copy.deepcopy(steps)
    validate_commands(steps)
    assert steps == before


# —— summarize：§11.4.12 行摘要（后端孪生，与前端 summary 同一批期望串）——

SUMMARY_CASES = [
    ({"id": "u1", "type": "click", "element_id": "e1"}, "点击 登录按钮"),
    ({"id": "u1", "type": "click", "element_id": "e9"}, "点击 元素 e9"),
    ({"id": "u1", "type": "click", "inline_locator": {"type": "css", "value": "#submit"}},
     "点击 css:#submit"),
    ({"id": "u1", "type": "open", "input": "https://x/login"}, "打开 https://x/login"),
    ({"id": "u1", "type": "input", "element_id": "e1", "input": "admin"}, "输入 admin → 登录按钮"),
    ({"id": "u1", "type": "sleep", "input": "3000"}, "等待时间 3000 ms"),
    ({"id": "u1", "type": "assert_title", "input": "工作台"}, "断言标题 工作台"),
    ({"id": "u1", "type": "js", "input": "1+1"}, "执行JS 1+1"),
    ({"id": "u1", "type": "screenshot"}, "截图"),
    ({"id": "u1", "type": "dance"}, "dance"),
]


def test_summarize_table() -> None:
    """与 web/src/ui/commands.test.ts 的 SUMMARY_CASES 逐字同串——两份实现的防漂锚点。"""
    names = {"e1": "登录按钮"}
    for cmd, expect in SUMMARY_CASES:
        assert summarize(cmd, names) == expect, cmd


def test_summarize_survives_garbage() -> None:
    for bad in [None, "abc", 42, [], {}, {"type": 3}]:
        assert isinstance(summarize(bad, {}), str)
