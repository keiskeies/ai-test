from app.shared.assertions import ResponseView, evaluate, prune_rows

R = ResponseView(status=200, headers={"content-type": "application/json", "x-trace": "t1"},
                 body_text="""{"code": 0, "data": {"token": "tk"}}""", elapsed_ms=120)


def _res(a):
    return evaluate(a, R)[0]


def test_all_types():
    assert _res([{"type": "status_code", "expected": 200}])["passed"]
    assert not _res([{"type": "status_code", "expected": 500}])["passed"]
    assert _res([{"type": "json_path_equals", "path": "$.data.token", "expected": "tk"}])["passed"]
    assert _res([{"type": "json_path_equals", "path": "$.code", "expected": "0"}])["passed"]  # 数字归一
    f = _res([{"type": "json_path_equals", "path": "$.nope", "expected": 1}])
    assert not f["passed"] and "路径不存在" in f["error"]
    assert _res([{"type": "body_contains", "expected": "token"}])["passed"]
    assert _res([{"type": "header_exists", "expected": "X-Trace"}])["passed"]
    assert _res([{"type": "response_time_lt", "expected": 1000}])["passed"]
    assert not _res([{"type": "response_time_lt", "timeout_ms": 50}])["passed"]  # 兼容 timeout_ms
    # 1B 起 script 断言真求值（§8.5）；旧的「恒失败并注明 1B 开放」已失效，
    # 留在那里就是一行自相矛盾的绿，故一并改写。
    ok = _res([{"type": "script", "code": "assert True"}])
    assert ok["passed"] is True
    bad = _res([{"type": "script", "code": "assert 1 == 2"}])
    assert not bad["passed"] and "AssertionError" in bad["error"]
    no = _res([{"type": "script"}])
    assert not no["passed"] and "code" in no["error"]
    u = _res([{"type": "weird"}])
    assert not u["passed"] and "未知断言类型" in u["error"]


def test_empty_assertions():
    assert evaluate([], R) == []


def test_status_code_string_expected_numeric_normalized():
    """D173：两个前端编辑器一个存 Number 一个存字符串——'200' 对 200 响应必须判过
    （与 json_path_equals 同一套 _eq 数字归一）；非数字串/'500' 仍判不过，数字路照旧。"""
    assert _res([{"type": "status_code", "expected": "200"}])["passed"]
    assert not _res([{"type": "status_code", "expected": "abc"}])["passed"]
    assert not _res([{"type": "status_code", "expected": "500"}])["passed"]
    assert _res([{"type": "status_code", "expected": 200}])["passed"]
    assert not _res([{"type": "status_code", "expected": 500}])["passed"]


def test_result_echoes_path():
    """多条 jsonpath 断言同时跑时，结果卡要能看出是哪条：path 必须回显。"""
    rows = evaluate([
        {"type": "json_path_equals", "path": "$.data.token", "expected": "tk"},
        {"type": "json_path_equals", "path": "$.code", "expected": 1},
    ], R)
    assert [r["path"] for r in rows] == ["$.data.token", "$.code"]
    assert rows[0]["passed"] and not rows[1]["passed"]
    # 非 jsonpath 类型不硬塞 path 键，前端才不会以为有路径可显示
    assert "path" not in _res([{"type": "status_code", "expected": 200}])


# —— D78 补的两件：regex 类型 + enabled 启用开关（顺序/跳过） ——


def test_regex_hits_and_misses():
    """regex：expected=正则正文；re.search 语义（部分匹配即通过），判定用 search 不是 match。"""
    ok = _res([{"type": "regex", "expected": r'"token":\s*"tk"'}])
    assert ok["passed"] and ok["actual"] == '"token": "tk"'  # actual 回显命中片段
    # search 而非 match：不锚定行首也算命中（"code" 在正文中部）
    assert _res([{"type": "regex", "expected": r"code"}])["passed"]
    miss = _res([{"type": "regex", "expected": r"^NOPE-\d+$"}])
    assert not miss["passed"] and miss["error"] is None  # 没命中是业务结论，不是错误
    assert miss["actual"].startswith("{")  # actual 给响应节选，报告能看出在比什么


def test_regex_bad_pattern_has_its_own_error():
    """坏正则：判 False + 原话点名「正则写法不合法」，不许糊成断言失败或 500。"""
    f = _res([{"type": "regex", "expected": "(unclosed["}])
    assert not f["passed"] and f["error"].startswith("正则写法不合法：")


def test_regex_with_path():
    """path 先取字段再匹配；取不到值复用 JsonPathMissing 通路。"""
    # 锚定 ^tk$：拿整份 body_text 冒充「path 取到的值」会因锚点不过而红——path 真被用上了
    assert _res([{"type": "regex", "path": "$.data.token", "expected": r"^tk$"}])["passed"]
    miss = _res([{"type": "regex", "path": "$.nope", "expected": "x"}])
    assert not miss["passed"] and "路径不存在" in miss["error"]
    # 非字符串字段序列化后再匹配（$.data 是对象）
    assert _res([{"type": "regex", "path": "$.data", "expected": "tk"}])["passed"]


def test_regex_non_json_with_path():
    """响应非 JSON 但给了 path：复用 json_path_equals 那句「响应不是合法 JSON」。"""
    plain = ResponseView(status=200, headers={}, body_text="plain text", elapsed_ms=1)
    f = evaluate([{"type": "regex", "path": "$.a", "expected": "plain"}], plain)[0]
    assert not f["passed"] and f["error"] == "响应不是合法 JSON，无法按 jsonpath 断言"
    # 不带 path 时非 JSON 响应照常匹 body_text
    assert evaluate([{"type": "regex", "expected": "plain"}], plain)[0]["passed"]


def test_enabled_skips_only_explicit_false():
    """enabled 三态：False 跳过且**不产结果行**；true/缺键都执行——缺键是老数据，
    它们必须照旧执行，这条就是向后兼容的钉。"""
    rows = evaluate([
        {"type": "status_code", "expected": 500, "enabled": False},  # 关掉：库里是没过的那条
        {"type": "status_code", "expected": 200, "enabled": True},
        {"type": "status_code", "expected": 200},                    # 老数据：无 enabled 键
    ], R)
    assert len(rows) == 2, "enabled=False 的行不许以「假绿行」混进结果——不出现才是对的"
    assert all(r["passed"] for r in rows)
    # 全关 → 结果空（各判定口径 all([]) = True：一步没有启用的断言 = 没有门）
    assert evaluate([{"type": "status_code", "expected": 500, "enabled": False}], R) == []


def test_rows_follow_assertion_order():
    """排序（D78）：结果行顺序 == 数组顺序——乱序数组、乱序 enabled 都要保住相对顺序。"""
    rows = evaluate([
        {"type": "body_contains", "expected": "tk", "enabled": False},
        {"type": "response_time_lt", "expected": 1000},
        {"type": "status_code", "expected": 500},
        {"type": "body_contains", "expected": "nope"},
    ], R)
    assert [r["type"] for r in rows] == ["response_time_lt", "status_code", "body_contains"]


def test_prune_rows_drops_none_keeps_false():
    """入库口径（门禁⑦ e2e 撞出来的形状漂移）：null 占位键不占存储位，False 关闭位必须留。

    `enabled: False` 是 D78 唯一有语义的关闭值——把它当空值丢掉等于把用户关掉的断言
    重新打开，比多存一个 null 严重，所以这里按值筛 None 而不是「筛掉所有假值」。
    """
    assert prune_rows([
        {"type": "json_path_equals", "path": "$.status", "expected": "ok",
         "timeout_ms": None, "code": None},
        {"type": "status_code", "expected": 200, "enabled": False},
    ]) == [
        {"type": "json_path_equals", "path": "$.status", "expected": "ok"},
        {"type": "status_code", "expected": 200, "enabled": False},
    ]
    assert prune_rows(None) == []
    assert prune_rows([]) == []


def test_prune_rows_is_read_equivalent_for_every_type():
    """剪枝前后必须判得一模一样：这钉的是「None 不落库 = 零语义变化」，老数据因此零迁移。

    七种类型逐个过——`response_time_lt` 与 `script` 读 timeout_ms、`script` 读 code、
    `regex`/`json_path_equals` 读 path，任何一个读取方把 None 和缺键走成两条路就会红。
    """
    raw = [
        {"type": "status_code", "expected": 200, "path": None, "code": None},
        {"type": "json_path_equals", "path": "$.data.token", "expected": "tk", "timeout_ms": None},
        {"type": "body_contains", "expected": "token", "code": None},
        {"type": "regex", "expected": "^tk$", "path": "$.data.token", "timeout_ms": None},
        {"type": "header_exists", "expected": "x-trace", "timeout_ms": None},
        {"type": "response_time_lt", "expected": None, "timeout_ms": 1000},  # 阈值走 timeout_ms
        {"type": "script", "code": "assert True", "timeout_ms": None, "path": None},
    ]
    assert [r["passed"] for r in evaluate(raw, R)] == [r["passed"] for r in evaluate(prune_rows(raw), R)]
    assert all(r["passed"] for r in evaluate(prune_rows(raw), R)), "剪枝不该把通过的判成失败"
