"""1B T4：step_graph 协议与保存期校验（§7.4，纯函数、无 DB）。

钉的是「保存期能不能拦住」：画布保存与 Agent 建场景调同一个 validate，所以畸形图
要么在这里变成带 path 的 issue，要么就不该进 DB。校验函数对任何输入只产 issue、
绝不抛异常——畸形 graph 不能变成 500。
"""
from __future__ import annotations

import copy

from app.modules.scenario.graph import BLOCKED_1B, KINDS, MAX_DEPTH, iter_nodes, validate


def doc_example() -> dict:
    """§7.4 示例逐字誊写：省略号占位符补成真实子节点。

    1D T8 起 n8（adb_case）也在示例内整体放行：两侧执行器都已注册，示例不再需要
    「去掉 adb_case」的括号——留着就是假叙事。
    """
    return {
        "version": 1,
        "nodes": [
            {"key": "n1", "kind": "api_case", "ref": "case-login", "name": "登录", "disable": False},
            {"key": "n2", "kind": "loop", "name": "重试直到成功",
             "config": {"mode": "while", "cond": "ctx.vars.get('ok') != '1'", "max_iter": 5},
             "children": [{"key": "n2.1", "kind": "api_case", "ref": "case-poll", "name": "轮询状态"}]},
            {"key": "n3", "kind": "if", "config": {"branches": [
                {"cond": "ctx.vars['code'] == '0'", "children": [
                    {"key": "n3.1", "kind": "extract",
                     "config": {"rules": [{"var": "uid", "from": "last_response", "expr": "$.id"}]}}]},
                {"cond": "else", "children": [
                    {"key": "n3.2", "kind": "assert", "config": {"assertions": [
                        {"type": "status_code", "expected": 500}]}}]}]}},
            {"key": "n4", "kind": "foreach", "config": {"list_var": "users", "item_var": "u"},
             "children": [{"key": "n4.1", "kind": "sleep", "config": {"ms": 200}}]},
            {"key": "n5", "kind": "sleep", "config": {"ms": 3000}},
            {"key": "n6", "kind": "script", "config": {"code": "ctx.vars['ok'] = '1'"}},
            {"key": "n7", "kind": "extract",
             "config": {"rules": [{"var": "uid", "from": "last_response", "expr": "$.id"}]}},
            {"key": "n8", "kind": "adb_case", "ref": "adb-1", "name": "手机端下单"},
        ],
        "layout": {"n1": {"x": 0, "y": 0}, "n2": {"x": 0, "y": 120}},
    }


def codes(issues) -> list[str]:
    return sorted(i["code"] for i in issues)


def wrap(*nodes) -> dict:
    return {"version": 1, "nodes": list(nodes)}


def nest(depth: int) -> dict:
    """depth 层 loop 嵌套，最内层一个 sleep。"""
    cur = {"key": "leaf", "kind": "sleep", "config": {"ms": 1}}
    for i in range(depth - 1, 0, -1):
        cur = {"key": "L" + str(i), "kind": "loop",
               "config": {"mode": "count", "max_iter": 2}, "children": [cur]}
    return {"version": 1, "nodes": [cur]}


# —— 协议对齐试金石 ——

def test_doc_example_is_valid() -> None:
    """§7.4 的示例（含 n8 adb_case）零 issue：1D T8 起示例整体可保存、可执行。"""
    assert validate(doc_example()) == []


def test_blocked_1b_is_empty_adb_saves_clean() -> None:
    """1D T8 改钉（不是删）：adb_case 保存放行，BLOCKED_1B 清空。

    空表本身就是钉子——当初往表里塞 kind 的正是「保存期就拦」的承诺，摘掉 kind 必须
    在这里留痕，不许悄悄删表。
    """
    assert BLOCKED_1B == {}
    assert validate(wrap({"key": "a1", "kind": "adb_case", "ref": "adb-1"})) == []
    assert validate(wrap({"key": "u1", "kind": "ui_case", "ref": "ui-1"})) == []


def test_kind_not_available_mechanism_still_fires(monkeypatch) -> None:
    """机制本体不许 dead-on-arrival：未来批次往 BLOCKED_1B 塞 kind 时必须照样拦。

    表清空后这个分支没有真数据可走——所以塞一条假条目验证分支形状：issue 是
    kind_not_available、点名批次、且不再点名 UI/手机（旧的被拦名单是假叙事）。
    假条目要用真 kind（kafka_send 会先走 unknown_kind 分支，够不到这里）。
    """
    import app.modules.scenario.graph as graph

    monkeypatch.setattr(graph, "BLOCKED_1B", {"adb_case": "2A"})
    issues = validate(wrap({"key": "k1", "kind": "adb_case", "ref": "x"}))
    assert codes(issues) == ["kind_not_available"], issues
    assert issues[0]["node_key"] == "k1"
    assert "2A" in issues[0]["message"], "要告诉用户什么时候能用，不是只说不支持"
    assert "UI" not in issues[0]["message"] and "手机" not in issues[0]["message"]


def test_adb_case_device_policy_config_checked_at_save() -> None:
    """画布上的设备策略在保存期就校验（与执行期同一把尺，别等第 7 步才红）。

    缺省合法 = 不覆盖，跑用例默认设备；「指定设备」不填 serial 是半套配置，保存就拦；
    写了别的策略词同样保存就拦——执行期只认这两个词，存进去没人认的值等于假配置。
    """
    assert codes(validate(wrap({"key": "a1", "kind": "adb_case", "ref": "r"}))) == []
    assert codes(validate(wrap({"key": "a1", "kind": "adb_case", "ref": "r",
                                "config": {"device_policy": "any_idle"}}))) == []
    half = validate(wrap({"key": "a1", "kind": "adb_case", "ref": "r",
                          "config": {"device_policy": "specified"}}))
    assert codes(half) == ["missing_config"], half
    assert "device_serial" in half[0]["message"]
    assert codes(validate(wrap({"key": "a1", "kind": "adb_case", "ref": "r",
                                "config": {"device_policy": "specified",
                                           "device_serial": "1.2.3.4:5555"}}))) == []
    bogus = validate(wrap({"key": "a1", "kind": "adb_case", "ref": "r",
                           "config": {"device_policy": 7}}))
    assert codes(bogus) == ["missing_config"], bogus


def test_ui_case_requires_ref_like_api_case() -> None:
    """ui_case 保存放行后走 REF_KINDS 既有口径：缺 ref 仍是 missing_ref（钉住现状语义）。"""
    assert codes(validate(wrap({"key": "u1", "kind": "ui_case"}))) == ["missing_ref"]


def test_kind_enum_matches_spec() -> None:
    """§7.4 kind 枚举 15 个，一期白名单=全集。"""
    assert KINDS == {"api_case", "ui_case", "adb_case", "http_direct", "sleep", "loop", "if",
                     "foreach", "break", "continue", "script", "extract", "assert", "set_var",
                     "group"}
    assert MAX_DEPTH == 10


# —— break/continue 位置（Review Focus 1）——

def test_break_outside_loop_in_three_places() -> None:
    assert codes(validate(wrap({"key": "b", "kind": "break"}))) == ["break_outside_loop"]
    in_if = wrap({"key": "i", "kind": "if", "config": {"branches": [
        {"cond": "else", "children": [{"key": "i.1", "kind": "break"}]}]}})
    assert codes(validate(in_if)) == ["break_outside_loop"], "if 分支不是循环体"
    in_group = wrap({"key": "g", "kind": "group", "children": [{"key": "g.1", "kind": "continue"}]})
    assert codes(validate(in_group)) == ["break_outside_loop"], "group 是串行容器不是循环"


def test_break_inside_loop_and_foreach_is_ok() -> None:
    g = wrap({"key": "L", "kind": "loop", "config": {"mode": "count", "max_iter": 3},
              "children": [{"key": "L.1", "kind": "api_case", "ref": "c"},
                           {"key": "L.2", "kind": "break"}]})
    assert validate(g) == []
    g2 = wrap({"key": "F", "kind": "foreach", "config": {"list_var": "xs", "item_var": "x"},
               "children": [{"key": "F.1", "kind": "continue"}]})
    assert validate(g2) == []


def test_break_deep_inside_loop_still_ok() -> None:
    """合法容器是**任意层**外层循环，不是直接父节点。"""
    g = wrap({"key": "L", "kind": "loop", "config": {"mode": "count", "max_iter": 2}, "children": [
        {"key": "L.1", "kind": "if", "config": {"branches": [
            {"cond": "else", "children": [
                {"key": "L.1.1", "kind": "group", "children": [
                    {"key": "L.1.1.1", "kind": "break"}]}]}]}}]})
    assert validate(g) == []


# —— 深度 ——

def test_depth_limit_boundary() -> None:
    assert validate(nest(MAX_DEPTH)) == [], "10 层必须放行"
    issues = validate(nest(MAX_DEPTH + 1))
    assert codes(issues) == ["depth_exceeded"]
    assert issues[0]["node_key"] == "leaf"
    assert "11" in issues[0]["message"], "要说清第几层超了"


def test_depth_limit_is_a_parameter() -> None:
    assert codes(validate(nest(4), depth_limit=3)) == ["depth_exceeded"]


# —— key ——

def test_duplicate_key_rejected() -> None:
    g = wrap({"key": "a", "kind": "sleep", "config": {"ms": 1}},
             {"key": "a", "kind": "sleep", "config": {"ms": 2}})
    assert codes(validate(g)) == ["dup_key"]


def test_bad_key_shapes() -> None:
    for bad in ["", "n#1", "n 1", "中文", ("a." * 30) + "b", "n1."]:
        issues = validate(wrap({"key": bad, "kind": "sleep", "config": {"ms": 1}}))
        assert codes(issues) == ["bad_key"], (bad, issues)


def test_hash_is_illegal_because_of_row_suffix() -> None:
    """§8.6 用 step_key 加 #rN 作数据集行展示键：key 自身带 # 会让拆分二义。"""
    assert codes(validate(wrap({"key": "a#r1", "kind": "sleep", "config": {"ms": 1}}))) == ["bad_key"]


# —— 结构：叶子不得有 children ——

def test_leaf_with_children_rejected() -> None:
    leaves = [("sleep", {"ms": 1}, None), ("script", {"code": "x"}, None),
              ("assert", {"assertions": [{}]}, None),
              ("extract", {"rules": [{"var": "v", "expr": "$"}]}, None),
              ("set_var", {"vars": {"a": "1"}}, None),
              ("break", None, None), ("continue", None, None), ("api_case", None, "c")]
    for kind, cfg, ref in leaves:
        n = {"key": "x", "kind": kind,
             "children": [{"key": "y", "kind": "sleep", "config": {"ms": 1}}]}
        if cfg is not None:
            n["config"] = cfg
        if ref is not None:
            n["ref"] = ref
        issues = validate(wrap(n))
        assert "children_not_allowed" in codes(issues), (kind, issues)


# —— 必填 config（单一口径表）——

def test_missing_ref_for_ref_kinds() -> None:
    assert codes(validate(wrap({"key": "x", "kind": "api_case"}))) == ["missing_ref"]


def test_missing_config_table() -> None:
    cases = [
        ({"key": "x", "kind": "http_direct"}, "config.url"),
        ({"key": "x", "kind": "sleep"}, "config.ms"),
        ({"key": "x", "kind": "sleep", "config": {"ms": 0}}, "config.ms"),
        ({"key": "x", "kind": "loop", "config": {"mode": "while", "cond": "True"}}, "config.max_iter"),
        ({"key": "x", "kind": "loop", "config": {"mode": "while", "max_iter": 3}}, "config.cond"),
        ({"key": "x", "kind": "foreach", "config": {"list_var": "xs"}}, "config.item_var"),
        ({"key": "x", "kind": "script"}, "config.code"),
        ({"key": "x", "kind": "extract", "config": {"rules": []}}, "config.rules"),
        ({"key": "x", "kind": "extract", "config": {"rules": [{"var": "v"}]}}, "config.rules"),
        ({"key": "x", "kind": "assert", "config": {"assertions": []}}, "config.assertions"),
        ({"key": "x", "kind": "set_var", "config": {"vars": {}}}, "config.vars"),
    ]
    for node, expect in cases:
        issues = validate(wrap(node))
        assert codes(issues) == ["missing_config"], (node, issues)
        assert expect in issues[0]["message"], (expect, issues[0]["message"])


def test_if_branch_shape() -> None:
    assert codes(validate(wrap({"key": "x", "kind": "if"}))) == ["missing_config"]
    assert codes(validate(wrap({"key": "x", "kind": "if", "config": {"branches": []}}))) == ["missing_config"]
    empty_cond = wrap({"key": "x", "kind": "if", "config": {"branches": [{"children": []}]}})
    assert codes(validate(empty_cond)) == ["empty_cond"]
    # 空 children 合法：新建分支还没填内容是常态
    ok = {"key": "x", "kind": "if", "config": {"branches": [{"cond": "else", "children": []}]}}
    assert validate(wrap(ok)) == []


def test_unknown_kind() -> None:
    issues = validate(wrap({"key": "x", "kind": "kafka_send"}))
    assert codes(issues) == ["unknown_kind"]
    assert "kafka_send" in issues[0]["message"]


def test_group_parallel_is_phase_two() -> None:
    g = wrap({"key": "g", "kind": "group", "config": {"parallel": True}, "children": []})
    issues = validate(g)
    assert codes(issues) == ["not_supported_yet"]
    assert "二期" in issues[0]["message"]


# —— 数据集 × 循环展开上限 ——

def _expansion(rows: int, loop_iter: int | None = None) -> list[str]:
    step = {"key": "n1", "kind": "api_case", "ref": "c"}
    nodes = [step] if loop_iter is None else [
        {"key": "L", "kind": "loop", "config": {"mode": "count", "max_iter": loop_iter},
         "children": [step]}]
    return codes(validate({"version": 1, "nodes": nodes}, dataset_rows={"n1": rows}))


def test_expansion_limit_boundary() -> None:
    assert _expansion(499) == []
    assert _expansion(500) == []
    assert _expansion(501) == ["expansion_overflow"]


def test_expansion_multiplies_enclosing_loops() -> None:
    assert _expansion(100, loop_iter=5) == []
    assert _expansion(101, loop_iter=5) == ["expansion_overflow"]


def test_expansion_counts_disabled_steps_too() -> None:
    """disable 只是跳过不是删除：步骤还带着 12 行数据集，展开量照样要算。"""
    nodes = [{"key": "n1", "kind": "api_case", "ref": "c", "disable": True}]
    out = codes(validate({"version": 1, "nodes": nodes}, dataset_rows={"n1": 501}))
    assert out == ["expansion_overflow"]


# —— version ——

def test_bad_version() -> None:
    for bad in [{"nodes": []}, {"version": 2, "nodes": []}, {"version": "1", "nodes": []},
                {"version": 0, "nodes": []}]:
        assert codes(validate(bad)) == ["bad_version"], bad


# —— 畸形输入绝不抛异常 ——

def test_garbage_inputs_return_issues_not_exceptions() -> None:
    garbage = [None, "abc", 42, [], {}, {"nodes": "x"}, {"version": 1, "nodes": {"a": 1}},
               {"version": 1, "nodes": [None]}, {"version": 1, "nodes": ["x"]},
               {"version": 1, "nodes": [{}]}, {"version": 1, "nodes": [{"kind": 3}]},
               {"version": 1, "nodes": [{"key": "a", "kind": "if", "config": {"branches": "x"}}]},
               {"version": 1, "nodes": [{"key": "a", "kind": "loop", "children": "x"}]},
               {"version": 1, "nodes": [{"key": "a", "kind": "sleep", "config": []}]}]
    for g in garbage:
        out = validate(g)  # type: ignore[arg-type]
        assert isinstance(out, list), g
        assert out, "垃圾输入必须产 issue，不能静默当成合法图"
        for i in out:
            assert set(i) == {"node_key", "code", "message", "path"}, i


def test_validate_does_not_mutate_input() -> None:
    g = doc_example()
    before = copy.deepcopy(g)
    validate(g)
    assert g == before


# —— iter_nodes：两处 children 都要覆盖 ——

def test_iter_nodes_covers_both_children_places() -> None:
    seen = list(iter_nodes(doc_example()))
    keys = {n["key"] for n, _p, _d in seen}
    assert keys == {"n1", "n2", "n2.1", "n3", "n3.1", "n3.2", "n4", "n4.1", "n5", "n6", "n7", "n8"}
    depth = {n["key"]: d for n, _p, d in seen}
    parent = {n["key"]: p for n, p, _d in seen}
    assert depth["n1"] == 1 and depth["n2.1"] == 2 and depth["n3.1"] == 3
    assert parent["n1"] is None and parent["n2.1"] == "n2" and parent["n3.1"] == "n3"


def test_iter_nodes_survives_garbage() -> None:
    assert list(iter_nodes("nope")) == []
    assert list(iter_nodes({"nodes": [None, 1, "x"]})) == []


# —— path 供画布定位 ——

def test_issue_path_locates_the_node() -> None:
    g = wrap({"key": "i", "kind": "if", "config": {"branches": [
        {"cond": "else", "children": [{"key": "b", "kind": "break"}]}]}})
    issues = validate(g)
    assert issues[0]["path"].startswith("$.nodes[0]"), issues[0]["path"]
    assert "branches[0]" in issues[0]["path"], "if 分支里的节点要能定位到具体分支"
    assert issues[0]["node_key"] == "b"
