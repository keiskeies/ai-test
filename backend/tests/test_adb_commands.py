"""1D T3：§7.3 ADB 步骤协议与保存期校验（纯函数、无 DB、无设备）。

钉的是「保存期能不能拦住」，不碰设备：某 type 在真机上做不做得到（assert_toast 的
抓取可行性，前置取证 ⑪/D21）属执行核 T6；本文件只管**形状**。

两条最重要的诚实线：
- `empty_steps`：空用例「零步全绿」是假绿，保存期就拦（§13 纪律 1，与 test_ui_commands 同罪）。
- `record_unpaired`：录屏起止包裹（§6.4）是序列级规则，执行到一半才发现没配对，
  前面所有步骤白跑比 422 贵——所以这里就拦。

前端 web/src/adb/commands.ts 是同一套规则的第二个实现；两边由**同一批用例表**钉住不漂
（本文件与 commands.test.ts 的 SUMMARY_CASES/坏值表逐字对齐，R100/R101 孪生对同款）。
"""
from __future__ import annotations

import copy

from app.modules.adb_test.commands import (
    CFG_SCHEMA,
    OPTIONAL_ALLOWED,
    STEP_TYPES,
    summarize,
    validate_steps,
)

# 每个 kind 一个合法样例值；坏值表 BAD_BY_KIND 与前端 commands.test.ts 共用同一批字面值。
SAMPLE = {
    "text": "v", "ms": 1000, "ms0": 0, "coord": 10, "int": 3, "bool": True,
    "var": "out1", "pkg": "com.example.app", "addr": "192.168.1.20:5555",
    "url": "https://example.com",
}


def sample(kind: str):
    if kind.startswith("enum:"):
        return kind[5:].split("|")[0]
    return SAMPLE[kind]


def full_config(t: str) -> dict:
    """该 type 的完整合法 config（必填+可选全填）。"""
    return {spec[1:] if spec.startswith("!") else spec: sample(kind)
            for spec, kind in CFG_SCHEMA[t].items()}


_ID = iter(range(1, 10_000))


def step(t: str, **extra) -> dict:
    """一条最小可保存步骤（§7.3 步骤对象全字段）；extra 覆盖顶层字段。

    id 自增而不是写死 "a1"：写死会让**任何**多步序列白白多出一条 dup_id，
    序列级测试（录屏配对）就被 id 规则污染——那是测试脚手架的错，不是被测代码的错。
    """
    s: dict = {"id": "a" + str(next(_ID)), "type": t, "device": "auto",
               "config": full_config(t), "pre_wait_ms": 0, "optional": False}
    s.update(extra)
    return s


def one(t: str, **extra) -> list:
    """把一条 type=t 的步骤放进「可保存」的最小序列。

    录屏两步天生不能单独存在（§6.4 起止包裹），单独一步的合法序列**不存在**——
    这不是被测代码的漏洞，是这条规则应有的样子，所以按类型补上伴侣步。
    """
    s = step(t, **extra)
    if t == "screen_record_start":
        return [s, step("screen_record_stop")]
    if t == "screen_record_stop":
        return [step("screen_record_start"), s]
    return [s]


def doc_example() -> list:
    """§7.3 示例逐字誊写：`"auto|<device_id>"` 是占位符，取 "auto"。"""
    return [{"id": "a1", "type": "click_by_text", "device": "auto",
             "config": {"text": "登录", "timeout_ms": 8000},
             "pre_wait_ms": 0, "optional": False}]


def codes(issues) -> list[str]:
    return sorted(i["code"] for i in issues)


# —— 协议对齐试金石 ——

def test_doc_example_is_valid() -> None:
    """§7.3 的示例逐字对齐：零 issue。"""
    assert validate_steps(doc_example()) == []


def test_step_types_verbatim_from_blueprint() -> None:
    """26 个 type 逐字取自 §7.3 的枚举串（line 403），顺序即原文顺序（file_push 在 file_pull 前）。"""
    assert STEP_TYPES == (
        "connect", "shell", "install", "uninstall", "start_app", "kill_app",
        "click_xy", "long_click", "swipe", "input_text",
        "click_by_text", "click_by_xpath",
        "assert_text", "assert_element", "assert_toast",
        "screenshot", "screen_record_start", "screen_record_stop",
        "sleep", "file_push", "file_pull", "assert_file",
        "back", "home", "open_url", "extract_ui_text",
    )
    assert len(STEP_TYPES) == 26


def test_schema_covers_every_type_exactly_once() -> None:
    """参数表与 type 全集一一对应：漏一个 type = 那个 type 的 config 完全不校验（假绿）。"""
    assert set(CFG_SCHEMA) == set(STEP_TYPES)
    empty = {t for t in STEP_TYPES if not CFG_SCHEMA[t]}
    assert empty == {"back", "home"}, "只有 back/home 是无参步骤"


# —— 26 种 type 的最小合法步 ——

def test_every_type_minimal_legal() -> None:
    for t in STEP_TYPES:
        issues = validate_steps(one(t))
        assert issues == [], (t, issues)


def test_missing_required_config_named_per_key() -> None:
    """每个必填键单独缺席都要被点名（参数表单按同一张表生成，缺哪项说哪项）。"""
    for t, schema in CFG_SCHEMA.items():
        for spec in schema:
            if not spec.startswith("!"):
                continue
            key = spec[1:]
            cfg = full_config(t)
            del cfg[key]
            issues = validate_steps(one(t, config=cfg))
            assert codes(issues) == ["missing_config"], (t, key, issues)
            assert key in issues[0]["message"], "要点名缺的是哪个参数"


def test_optional_config_keys_may_be_absent() -> None:
    """只填必填键即合法：timeout_ms/reinstall/activity 这类可选项有执行期默认语义。"""
    for t, schema in CFG_SCHEMA.items():
        cfg = {spec[1:]: sample(kind) for spec, kind in schema.items() if spec.startswith("!")}
        issues = validate_steps(one(t, config=cfg))
        assert issues == [], (t, issues)


# —— 每种参数种类的坏值（kind 词表与坏值表和前端孪生共用同一批字面值）——

BAD_BY_KIND = {
    "text": ["", "   ", 42, True, [], {}],
    "ms": [0, -1, 1.5, "1000", True],
    "ms0": [-1, 1.5, "0"],
    "coord": [-1, 1.5, "10"],
    "int": [0, -1, 1.5, "3"],
    "bool": ["true", 0, 1, ""],
    "var": ["", "1a", "a-b", "a b", "中文", 42],
    "pkg": ["", "com", "com.", "1com.x", "com..x", "com.example.app!"],
    "addr": ["", "1.2.3.4", "1.2.3.4:", ":5555", "1.2.3.4:abc", "1.2.3.4:99999"],
    "url": ["", "example.com", "ftp://x", "://x"],
}


def test_bad_config_values_are_bad_config() -> None:
    for t, schema in CFG_SCHEMA.items():
        for spec, kind in schema.items():
            key = spec[1:] if spec.startswith("!") else spec
            bads = BAD_BY_KIND.get(kind, [])
            if kind.startswith("enum:"):
                bads = BAD_BY_KIND.get("enum", ["nope"])
            for bad in bads:
                cfg = full_config(t)
                cfg[key] = bad
                out = validate_steps(one(t, config=cfg))
                assert codes(out) == ["bad_config"], (t, key, bad, out)


def test_extract_ui_text_selector_pair() -> None:
    """by/value 只给一半 = 「知道在哪找却不知道找什么」；整对缺位=整屏提取，合法。"""
    whole = step("extract_ui_text", config={"save_var": "t"})
    assert validate_steps([whole]) == []
    only_by = step("extract_ui_text", config={"save_var": "t", "by": "text"})
    assert codes(validate_steps([only_by])) == ["bad_selector_pair"]
    only_val = step("extract_ui_text", config={"save_var": "t", "value": "登录"})
    assert codes(validate_steps([only_val])) == ["bad_selector_pair"], "反过来只给 value 同样说不清"


# —— 步骤对象顶层字段（§7.3：device / pre_wait_ms / optional）——

def test_device_field() -> None:
    assert validate_steps([step("shell", device="192.168.1.20:5555")]) == []
    assert validate_steps([step("shell", device=None)]) == [], "缺省=按执行时解析"
    for bad in ["", "   ", 42, True, []]:
        assert codes(validate_steps([step("shell", device=bad)])) == ["bad_device"], bad


def test_pre_wait_field() -> None:
    assert validate_steps([step("shell", pre_wait_ms=0)]) == []
    assert validate_steps([step("shell", pre_wait_ms=None)]) == []
    for bad in [-1, 1.5, "100", True]:
        assert codes(validate_steps([step("shell", pre_wait_ms=bad)])) == ["bad_pre_wait"], bad


def test_optional_field_and_semantics() -> None:
    assert validate_steps([step("assert_text", optional=True)]) == []
    assert validate_steps([step("screenshot", optional=True)]) == []
    assert codes(validate_steps([step("assert_text", optional="yes")])) == ["bad_optional"]
    for t in sorted(set(STEP_TYPES) - set(OPTIONAL_ALLOWED)):
        issues = validate_steps(one(t, optional=True))
        assert codes(issues) == ["optional_on_action"], (t, issues)
        assert "不允许" in issues[0]["message"], "要说清是哪类步骤不能配失败不阻断"


def test_optional_allowed_is_assert_extract_and_screenshot_only() -> None:
    """optional 白名单是裁决口径（R88 同源：失败不阻断只对断言/提取成立）。"""
    assert OPTIONAL_ALLOWED == {"assert_text", "assert_element", "assert_toast",
                                "assert_file", "extract_ui_text", "screenshot"}


# —— 录屏起止包裹（§6.4，序列级）——

def test_recording_pair_legal_wrapping() -> None:
    seq = [step("screen_record_start"), step("shell", config={"cmd": "ls"}),
           step("screen_record_stop")]
    assert validate_steps(seq) == []
    seq2 = seq + [step("screen_record_start"), step("screen_record_stop")]
    assert validate_steps(seq2) == [], "允许多段，但每段都得闭合"


def test_recording_stop_without_start() -> None:
    issues = validate_steps([step("screen_record_stop")])
    assert codes(issues) == ["record_unpaired"]
    assert issues[0]["index"] == 0, "报错指向那条真正没被包裹的 stop"


def test_recording_start_without_stop() -> None:
    issues = validate_steps([step("screen_record_start"), step("shell")])
    assert codes(issues) == ["record_unpaired"]
    assert issues[0]["index"] == 0, "未闭合的 start 指向 start 行"


def test_recording_nested_start() -> None:
    issues = validate_steps([step("screen_record_start"), step("screen_record_start")])
    assert codes(issues) == ["record_unpaired", "record_unpaired"], issues
    # 两条都钉在第 2 行：那是唯一需要动手的行。第 1 段的未闭合写在第 2 行的
    # 「第 1 行的开始录屏还没结束就又开了一段」里——用户照任意一条改（补 stop 或删行）
    # 都收敛；把第二条挪去指第 1 行反而会引出「两行各改一处」的错误修法。
    assert {i["index"] for i in issues} == {1}
    text = "".join(i["message"] for i in issues)
    assert "第 1 行" in text and "第 2 行" in text, "两段录屏各被点名一次，一条都不许吞"


def test_recording_pairs_ignore_malformed_steps() -> None:
    seq = [step("screen_record_start"), None, step("screen_record_stop")]
    assert codes(validate_steps(seq)) == ["bad_step"], "None 行有 bad_step，但不许搅乱配对判定"


# —— id 规则（R102：step_key 唯一性）——

def test_dup_id_points_at_second_row() -> None:
    issues = validate_steps([step("back", id="a1"), step("back", id="a1")])
    assert codes(issues) == ["dup_id"]
    assert issues[0]["index"] == 1


def test_bad_id_shapes() -> None:
    for bad in ["", "a b", "中文", "a1.", "u" * 41, 123, None]:
        issues = validate_steps([step("back", id=bad)])
        assert codes(issues) == ["bad_id"], (bad, issues)


# —— empty_steps / unknown_type / 畸形输入绝不抛 ——

def test_empty_steps_blocked() -> None:
    issues = validate_steps([])
    assert codes(issues) == ["empty_steps"]
    assert "假绿" in issues[0]["message"], "要说清为什么空数组不能存"


def test_unknown_type() -> None:
    for bad in ["kafka_send", "", 3, None]:
        issues = validate_steps([step("back", type=bad)])
        assert codes(issues) == ["unknown_type"], (bad, issues)
    assert "kafka_send" in validate_steps([step("back", type="kafka_send")])[0]["message"]


def test_garbage_inputs_return_issues_not_exceptions() -> None:
    garbage = [None, "", "abc", 42, {}, {"steps": "x"}, [[]],
               [[{"id": "a1", "type": "back"}]], ["x"], [None], [{}],
               [{"id": "a1", "type": 3}], [1, 2],
               [{"id": "a1", "type": "shell", "config": "ls"}],
               [{"id": "a1", "type": "shell", "config": ["ls"]}]]
    for g in garbage:
        out = validate_steps(g)  # type: ignore[arg-type]
        assert isinstance(out, list), g
        assert out, "垃圾输入必须产 issue，不能静默当成合法序列"
        for i in out:
            assert set(i) == {"index", "code", "message"}, i
            assert isinstance(i["index"], int), i


def test_validate_does_not_mutate_input() -> None:
    steps = doc_example() + [step("screen_record_start"), step("screen_record_stop")]
    before = copy.deepcopy(steps)
    validate_steps(steps)
    assert steps == before


# —— summarize：§11.4.12 行摘要（后端孪生，与前端 summary 同一批期望串）——

SUMMARY_CASES = [
    ({"id": "a1", "type": "click_by_text", "config": {"text": "登录"}}, "按文本点击 登录"),
    ({"id": "a1", "type": "click_by_text", "config": {}}, "按文本点击 （未填）"),
    ({"id": "a1", "type": "shell", "config": {"cmd": "dumpsys battery"}},
     "Shell 命令 dumpsys battery"),
    ({"id": "a1", "type": "shell", "config": {}}, "Shell 命令 （未填命令）"),
    ({"id": "a1", "type": "click_xy", "config": {"x": 100, "y": 200}}, "坐标点击 (100,200)"),
    ({"id": "a1", "type": "click_xy", "config": {}}, "坐标点击 （未填坐标）"),
    ({"id": "a1", "type": "start_app", "config": {"package": "com.demo.app"}},
     "启动应用 com.demo.app"),
    ({"id": "a1", "type": "sleep", "config": {"ms": 3000}}, "等待时间 3000 ms"),
    ({"id": "a1", "type": "screenshot", "config": {"save_var": "shot"}}, "截图 → $shot"),
    ({"id": "a1", "type": "screenshot", "config": {}}, "截图"),
    ({"id": "a1", "type": "screen_record_start", "config": {"max_s": 60}},
     "开始录屏 ≤60s"),
    ({"id": "a1", "type": "assert_element",
      "config": {"by": "resource_id", "value": "btn"}}, "断言控件 btn [resource_id]"),
    ({"id": "a1", "type": "file_pull", "config": {"remote": "/sdcard/a.txt"}},
     "拉取文件 /sdcard/a.txt"),
    ({"id": "a1", "type": "assert_file",
      "config": {"remote": "/sdcard/a.txt", "contains": "ok"}},
     "断言文件 /sdcard/a.txt 含「ok」"),
    ({"id": "a1", "type": "extract_ui_text", "config": {"save_var": "t"}},
     "提取界面文本 → $t"),
    ({"id": "a1", "type": "back"}, "返回键"),
    ({"id": "a1", "type": "dance"}, "dance"),
]


def test_summarize_table() -> None:
    """与 web/src/adb/commands.test.ts 的 SUMMARY_CASES 逐字同串——两份实现的防漂锚点。"""
    for stp, expect in SUMMARY_CASES:
        assert summarize(stp) == expect, stp


def test_summarize_survives_garbage() -> None:
    for bad in [None, "abc", 42, [], {}, {"type": 3}, {"type": "shell", "config": 42}]:
        assert isinstance(summarize(bad), str), bad
