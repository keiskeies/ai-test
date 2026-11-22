"""step_graph 协议与保存期校验（设计 §7.4）：纯函数、无 DB、无 IO。

画布保存与 Agent 建场景都调 validate()，所以「界面能保存的图」与「引擎能跑的图」
是同一份口径，不存在第二套校验。对外唯一契约：**任何输入都返回 issue 列表，绝不抛
异常** —— step_graph 是前端自由 JSON，畸形图必须是 422 里的可读问题，不是 500。

两套深度口径刻意不同：树深度按执行递归算（if 的分支容器也占一层，因为「进 if → 选
分支 → 跑 children」确实多走一层）；key 的点号段数由画布命名决定，另设上限。两者都
不是随便取的数字，各自的理由写在对应的 issue 文案里。
"""
from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any, TypeGuard

KINDS = frozenset({
    "api_case", "ui_case", "adb_case", "http_direct", "sleep", "loop", "if", "foreach",
    "break", "continue", "script", "extract", "assert", "set_var", "group",
})
# R48：一期 kind 白名单=全集，缺执行器的 kind 保存期就拦，别让场景跑到第 7 步才告诉
# 用户这一步没人执行。1C T10 摘掉 ui_case、1D T8 摘掉 adb_case（两侧执行器都已注册），
# 字典清空但机制保留：这一处与 engine/handlers.py 的 PENDING_KINDS、handlers 注册表
# 三处成对，未来批次再拦新 kind 时三处一起写。
BLOCKED_1B: dict[str, str] = {}
MAX_DEPTH = 10
MAX_KEY_LENGTH = 64  # = run_step_result.step_key 列宽
MAX_KEY_SEGMENTS = 10
MAX_KEY_SEGMENT_LENGTH = 40
MAX_EXPANSION = 500  # §8.6 数据集行数 × 外层循环次数

CONTAINER_KINDS = frozenset({"loop", "foreach", "if", "group"})
REF_KINDS = frozenset({"api_case", "ui_case", "adb_case"})
Issue = dict[str, Any]

_KEY_RE = re.compile(
    r"^[A-Za-z0-9_-]{1," + str(MAX_KEY_SEGMENT_LENGTH) + r"}"
    r"(\.[A-Za-z0-9_-]{1," + str(MAX_KEY_SEGMENT_LENGTH) + "})*$"
)


def _is_int(x: Any) -> TypeGuard[int]:
    """TypeGuard 而不是 bool：调用点写完 `if _is_int(rows) and rows > 0` 还得
    拿 rows 做乘法，返回 bool 的话 mypy 依旧当它是 Any|None（数据集行数来自
    JSON，None 是常态），报「None 不能参与运算」。判定语义一字未改。"""
    return isinstance(x, int) and not isinstance(x, bool)


def _text(x: Any) -> bool:
    return isinstance(x, str) and x.strip() != ""


def _str_field(node: dict, name: str) -> str:
    v = node.get(name)
    return v if isinstance(v, str) else ""


def _key_problem(key: str) -> str | None:
    if not _text(key):
        return "步骤 key 不能为空：报告、SSE 高亮、单步重跑都以 key 为主键"
    if not _KEY_RE.match(key):
        return ("步骤 key " + repr(key) + " 不合法：只允许字母数字下划线短横线，点号分层，段长 1-"
                + str(MAX_KEY_SEGMENT_LENGTH) + "，且不能含 #（数据集行键要用 #rN 后缀）")
    segs = key.split(".")
    if len(segs) > MAX_KEY_SEGMENTS:
        return ("步骤 key " + repr(key) + " 有 " + str(len(segs)) + " 段，超过 "
                + str(MAX_KEY_SEGMENTS) + " 段上限（点号层级就是嵌套深度）")
    if len(key) > MAX_KEY_LENGTH:
        return ("步骤 key 长度 " + str(len(key)) + " 超过 " + str(MAX_KEY_LENGTH)
                + "，写不进 run_step_result.step_key")
    return None


def _required_config(kind: str, cfg: dict) -> list[str]:
    """kind 必填 config 表：保存期校验、画布表单、handler 共用这一份口径。"""
    miss: list[str] = []
    if kind == "http_direct":
        if not _text(cfg.get("url")):
            miss.append("config.url")
    elif kind == "sleep":
        if not (_is_int(cfg.get("ms")) and cfg["ms"] > 0):
            miss.append("config.ms（正整数毫秒）")
    elif kind == "loop":
        if not (_is_int(cfg.get("max_iter")) and cfg["max_iter"] > 0):
            miss.append("config.max_iter（正整数，防死循环的硬上限）")
        mode = cfg.get("mode")
        if not isinstance(mode, str) or mode == "" or mode == "while":
            if not _text(cfg.get("cond")):
                miss.append("config.cond（while 模式必须有条件表达式）")
    elif kind == "foreach":
        if not _text(cfg.get("list_var")):
            miss.append("config.list_var")
        if not _text(cfg.get("item_var")):
            miss.append("config.item_var")
    elif kind == "script":
        if not _text(cfg.get("code")):
            miss.append("config.code")
    elif kind == "extract":
        rules = cfg.get("rules")
        if not isinstance(rules, list) or not rules:
            miss.append("config.rules（至少一条提取规则）")
        elif any(not (isinstance(r, dict) and _text(r.get("var")) and _text(r.get("expr"))) for r in rules):
            miss.append("config.rules（每条规则都要有 var 与 expr）")
    elif kind == "assert":
        items = cfg.get("assertions")
        if not isinstance(items, list) or not items:
            miss.append("config.assertions（至少一条断言）")
    elif kind == "set_var":
        vs = cfg.get("vars")
        if not isinstance(vs, dict) or not vs:
            miss.append("config.vars（至少一个变量）")
    elif kind == "adb_case":
        # 设备策略（§11.4.12）：点了「指定设备」却没选设备 = 配置残缺，保存期就说。
        # 缺省（不填 device_policy）合法——那是不覆盖，跑用例自己的默认设备。
        policy = cfg.get("device_policy")
        if policy is not None and not isinstance(policy, str):
            miss.append("config.device_policy（any_idle / specified）")
        elif policy == "specified" and not _text(cfg.get("device_serial")):
            miss.append("config.device_serial（指定了「指定设备」就要选一台设备）")
    return miss


class _State:
    def __init__(self, depth_limit: Any, expansion_limit: Any, dataset_rows: Any) -> None:
        self.depth_limit = depth_limit if _is_int(depth_limit) and depth_limit > 0 else MAX_DEPTH
        self.expansion_limit = (expansion_limit if _is_int(expansion_limit) and expansion_limit > 0
                                else MAX_EXPANSION)
        self.dataset_rows = dataset_rows if isinstance(dataset_rows, dict) else {}
        self.seen: set[str] = set()
        self.issues: list[Issue] = []

    def issue(self, node_key: str, code: str, message: str, path: str) -> None:
        self.issues.append({"node_key": node_key, "code": code, "message": message, "path": path})


def _check_expansion(node_key: str, path: str, factor: int, st: _State) -> None:
    """disable 只是跳过不是删除：步骤还带着 N 行数据集，展开量必须照样算。"""
    rows = st.dataset_rows.get(node_key)
    if not (_is_int(rows) and rows > 0):
        return
    total = rows * factor
    if total > st.expansion_limit:
        st.issue(node_key, "expansion_overflow",
                 "该步骤数据集 " + str(rows) + " 行 × 外层循环 " + str(factor) + " 次 = "
                 + str(total) + " 次执行，超过上限 " + str(st.expansion_limit)
                 + "（§8.6）；请精简数据集或调低循环次数", path)


def _walk(nodes: list, path: str, parent_key: str | None, depth: int, factor: int,
          in_loop: bool, st: _State) -> None:
    for i, node in enumerate(nodes):
        p = path + "[" + str(i) + "]"
        if not isinstance(node, dict):
            st.issue("", "bad_node", "步骤必须是 JSON 对象，实际是 " + type(node).__name__, p)
            continue
        key = _str_field(node, "key")
        kind = _str_field(node, "kind")
        raw_cfg = node.get("config")
        cfg = raw_cfg if isinstance(raw_cfg, dict) else {}
        children = node.get("children")

        if depth > st.depth_limit:
            st.issue(key, "depth_exceeded",
                     "步骤嵌套到第 " + str(depth) + " 层，超过上限 " + str(st.depth_limit)
                     + "（§7.4）；请拆成子场景或减少嵌套", p)

        problem = _key_problem(key)
        if problem is not None:
            st.issue(key, "bad_key", problem, p)
        elif key in st.seen:
            st.issue(key, "dup_key", "步骤 key " + repr(key) + " 重复；同一场景内必须唯一"
                     + "（run_step_result 以 run_id + step_key 为行键）", p)
        else:
            st.seen.add(key)

        if kind not in KINDS:
            st.issue(key, "unknown_kind", "未知步骤类型 " + repr(kind or "(未填)")
                     + "；一期支持：" + ", ".join(sorted(KINDS)), p)
            continue
        if kind in BLOCKED_1B:
            # 1D T8 起 BLOCKED_1B 为空（ui_case/adb_case 都已开放）——本分支是留给未来
            # 批次的机制，文案不能再点名 UI/手机（那是旧的被拦名单，留着就是假叙事）。
            st.issue(key, "kind_not_available",
                     kind + " 步骤要到 " + BLOCKED_1B[kind] + " 批次才开放，"
                     "现在保存会失败；可先用 http_direct 或 script 占位", p)
            continue

        if kind in ("break", "continue") and not in_loop:
            st.issue(key, "break_outside_loop",
                     kind + " 只能出现在 loop / foreach 内部，否则执行时没有任何循环可以跳出", p)

        if kind in REF_KINDS and not _text(node.get("ref")):
            st.issue(key, "missing_ref", kind + " 缺少 ref：要知道这一步到底跑哪个用例", p)

        for m in _required_config(kind, cfg):
            st.issue(key, "missing_config", kind + " 缺少必填配置 " + m, p)

        if kind not in CONTAINER_KINDS:
            if isinstance(children, list) and children:
                st.issue(key, "children_not_allowed",
                         kind + " 是叶子步骤，不能有 children（要串子步骤请用 group）", p)
            _check_expansion(key, p, factor, st)
            continue

        # ---- 容器：children 数组顺序即执行顺序 ----
        if kind == "if":
            has_branches = "branches" in cfg
            branches = cfg.get("branches")
            if not has_branches:
                st.issue(key, "missing_config", "if 缺少必填配置 config.branches（至少一个分支）", p)
                continue
            if not isinstance(branches, list):
                st.issue(key, "bad_node", "if 的 config.branches 必须是数组", p + ".config.branches")
                continue
            if not branches:
                st.issue(key, "missing_config", "if 缺少必填配置 config.branches（至少一个分支）", p)
                continue
            if _is_true(cfg.get("parallel_branches")):
                st.issue(key, "not_supported_yet", "if 分支并发执行为二期能力", p)
            for bi, br in enumerate(branches):
                bp = p + ".config.branches[" + str(bi) + "]"
                if not isinstance(br, dict):
                    st.issue(key, "bad_node", "if 分支必须是 JSON 对象", bp)
                    continue
                if not _text(br.get("cond")):
                    st.issue(key, "empty_cond", "if 的第 " + str(bi + 1)
                             + " 个分支没有条件；无条件分支请在画布上选「否则(else)」", bp)
                bc = br.get("children")
                if bc is None:
                    continue
                if not isinstance(bc, list):
                    st.issue(key, "bad_node", "if 分支的 children 必须是数组", bp + ".children")
                    continue
                # 分支容器占一层：执行递归确实多走一层，深度上限要按真实递归深度算
                _walk(bc, bp + ".children", key, depth + 2, factor, in_loop, st)
            continue

        if kind == "group" and _is_true(cfg.get("parallel")):
            st.issue(key, "not_supported_yet",
                     "group 并发执行（.parallel）为二期能力（§7.4）；一期 group 只作串行容器", p)

        if not isinstance(children, list):
            if children is not None:
                st.issue(key, "bad_node", kind + " 的 children 必须是数组", p + ".children")
            continue
        child_factor = factor
        child_in_loop = in_loop
        if kind == "loop":
            child_in_loop = True
            if _is_int(cfg.get("max_iter")) and cfg["max_iter"] > 0:
                child_factor = factor * cfg["max_iter"]  # while 模式按 max_iter 取最坏情况
        elif kind == "foreach":
            child_in_loop = True  # 列表长度只有运行时知道；保存期按 ×1 估，运行时有第二道闸门
        _walk(children, p + ".children", key, depth + 1, child_factor, child_in_loop, st)


def _is_true(x: Any) -> bool:
    return x is True or (isinstance(x, str) and x.strip().lower() in ("1", "true", "yes"))


def iter_nodes(graph: Any) -> Iterator[tuple[dict, str | None, int]]:
    """深度优先遍历，产出 (节点, 父 key, 深度)。if 的子节点在 config.branches[i].children，
    与容器的 children 两处都覆盖。畸形输入静默跳过——遍历器不产 issue，issue 归 validate。"""
    if not isinstance(graph, dict):
        return
    nodes = graph.get("nodes")
    if not isinstance(nodes, list):
        return
    yield from _iter(nodes, None, 1)


def _iter(nodes: list, parent_key: str | None, depth: int) -> Iterator[tuple[dict, str | None, int]]:
    for node in nodes:
        if not isinstance(node, dict):
            continue
        yield node, parent_key, depth
        key = _str_field(node, "key") or None
        kind = _str_field(node, "kind")
        if kind not in CONTAINER_KINDS:
            continue
        if kind == "if":
            cfg = node.get("config")
            branches = cfg.get("branches") if isinstance(cfg, dict) else None
            if not isinstance(branches, list):
                continue
            for br in branches:
                if not isinstance(br, dict):
                    continue
                bc = br.get("children")
                if isinstance(bc, list):
                    yield from _iter(bc, key, depth + 2)
            continue
        kids = node.get("children")
        if isinstance(kids, list):
            yield from _iter(kids, key, depth + 1)


def validate(graph: Any, *, depth_limit: int = MAX_DEPTH, expansion_limit: int = MAX_EXPANSION,
             dataset_rows: dict[str, int] | None = None) -> list[Issue]:
    """保存期校验：返回 issue 列表（空 = 可保存）。对任何输入都不抛异常、不改入参。"""
    st = _State(depth_limit, expansion_limit, dataset_rows)
    if not isinstance(graph, dict):
        st.issue("", "bad_version",
                 "step_graph 必须是 JSON 对象，实际是 " + type(graph).__name__, "$")
        return st.issues
    version = graph.get("version")
    if not (_is_int(version) and version == 1):
        st.issue("", "bad_version",
                 "step_graph.version 必须是整数 1（当前协议版本），实际是 " + repr(version)
                 + "；协议升级走迁移，不让前端猜", "$.version")
    nodes = graph.get("nodes")
    if nodes is None:
        st.issue("", "bad_node", "step_graph 缺少 nodes 数组", "$.nodes")
    elif not isinstance(nodes, list):
        st.issue("", "bad_node", "step_graph.nodes 必须是数组，实际是 " + type(nodes).__name__, "$.nodes")
    else:
        _walk(nodes, "$.nodes", None, 1, 1, False, st)
    return st.issues
