"""D47-a §11.5.1 列表工具栏后端半边：高级搜索编译器 + 个人视图 CRUD（1G 第五十九轮）。

分两层，因为这两件事的失效方式完全不同：

**内核层（不碰库）**：`shared/filters.py` 把条件 JSON 编成 SQL。这里钉的是**编译产物的形状**
——用 `str(compile(...))` 直接看 SQL，而不是「跑个查询数条数」。理由：三值逻辑、括号位置、
LIKE 转义这三类 bug 在结果集里都可能恰好看不出来（数据太少、恰好没有 NULL 行），
而 SQL 文本不会说谎。

**行为层（走真 HTTP + 真 MySQL）**：视图 CRUD 的归属隔离、409 判重口径、筛选真能筛。
测试库由 conftest 每次新建临时 schema（TP_TEST_SCHEMA，会话结束 DROP），不碰共享 dev/demo 库。

变异自证（本轮逐条真跑过，改法写在各用例 docstring 里）：
- 摘掉 `api_definition_list` 里的 `visible_clause(...)` → test_or_does_not_leak_invisible_rows 红
- `_neg` 去掉 `OR col IS NULL` → test_negation_on_nullable_column_keeps_null_rows 红
- `_like` 改成原样返回 → test_like_escapes_wildcards 红
- `saved_view_list` 的 owner_id 谓词摘掉 → test_saved_views_are_owner_isolated 红
- `_fetch` 的 owner_id 谓词摘掉 → test_other_users_view_reads_as_not_found 红
- `_assert_name_free` 的 owner_id 谓词摘掉 → test_same_name_is_free_for_different_owners 红
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy.dialects import mysql
from sqlalchemy.sql.elements import ColumnElement

# app.modules.api_test.services 这一行的作用是**触发字段登记**，本体一个符号都不用
# （ruff 的 F401 靠下面的 noqa 压）。必须显式 import：本文件的内核用例不走 client 夹具
# （不 create_app），登记就没人触发，view_types() 会随 pytest 的用例顺序时灵时不灵。
import app.modules.api_test.services  # noqa: F401
from app.shared.filter_registry import view_types
from app.shared.filters import (
    KINDS,
    OPERATOR_LABELS,
    OPERATORS,
    BadFilter,
    FieldSpec,
    build_conditions,
    kind_ops,
)

# ---- 内核层夹具：两列假表，一列可空一列非空 ------------------------------------------


class _Cols:
    """每种控件型配一列真类型：编译器对 number/time/bool 走的是不同的值转换分支，
    拿 String 列去编 `EQUALS true` 只会测到「没崩」，测不到转换本身。"""

    def __init__(self) -> None:
        from sqlalchemy import Boolean, Column, DateTime, Integer, MetaData, String, Table

        md = MetaData()
        self.t = Table("t", md,
                       Column("maybe", String(32)),                   # text/enum/id，可空
                       Column("always", String(32), nullable=False),  # 同上，非空
                       Column("num", Integer),
                       Column("when", DateTime),
                       Column("flag", Boolean))


_C = _Cols()

# 控件型 → 用哪一列来编这一型的操作符
_KIND_COL = {"text": "maybe", "enum": "maybe", "id": "maybe", "number": "num",
             "time": "when", "bool": "flag"}

FIELDS: dict[str, FieldSpec] = {
    "maybe": FieldSpec(_C.t.c.maybe, "text", nullable=True),
    "always": FieldSpec(_C.t.c.always, "text", nullable=False),
    "num": FieldSpec(_C.t.c.num, "number", nullable=True),
}


def _spec(kind: str) -> FieldSpec:
    return FieldSpec(_C.t.c[_KIND_COL[kind]], kind)


def _sql(cond: ColumnElement[bool]) -> str:
    return str(cond.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))


def _one(op: str, value: Any = None, field: str = "maybe") -> str:
    raw: dict[str, Any] = {"search_mode": "AND",
                           "conditions": [{"field": field, "operator": op, "value": value}]}
    return _sql(build_conditions(raw, FIELDS))


# ---- 内核层：操作符全覆盖 ------------------------------------------------------------


def test_every_declared_operator_compiles() -> None:
    """OPERATORS 里每一枚都必须真被编译器实现。

    `filters._one` 末尾那句 `raise _bad("未被编译器实现")` 自称「到不了：OPERATORS 与本函数
    一一对应」——一句没有测试背书的一一对应就是文档。这里对**每枚操作符 × 每个支持它的
    控件型**各编一次，谁漏了实现，本例当场红（而不是等用户点到那一项才发现）。
    """
    probe = {"text": "x", "enum": "x", "id": "x", "number": 1,
             "time": "2026-01-01T00:00:00Z", "bool": True}
    seen = 0
    for kind in sorted(KINDS):
        for op in kind_ops(kind):
            val: Any = [probe[kind]] if op in ("IN", "NOT_IN") else probe[kind]
            if op == "BETWEEN":
                val = [val, val]
            if op in ("EMPTY", "NOT_EMPTY"):
                val = None
            out = _sql(build_conditions(
                {"search_mode": "AND",
                 "conditions": [{"field": "f", "operator": op, "value": val}]},
                {"f": _spec(kind)}))
            # 产物里出现的是真列名（t.maybe / t.flag…），不是条件里那个 field 别名——
            # 别名只用于报错文案。所以只钉「编出了非空、非常量的谓词」。
            assert out.strip() and out.strip().lower() != "true", f"{kind}×{op} 编出了空 SQL"
            seen += 1
    assert seen >= 30, f"只编出 {seen} 种组合，KINDS/OPERATORS 的笛卡尔积明显没扫全"


def test_time_and_bool_values_are_converted_not_passed_through() -> None:
    """time 列的比较要编译成 datetime 字面量，bool 列要编译成布尔而不是字符串 'True'。

    这两条是「值转换分支」的钉：转换没做的话 SQL 照样编得出来，只是 MySQL 那边
    要么拒收、要么把 `when = 'True'` 比成永假。
    """
    t = _sql(build_conditions(
        {"conditions": [{"field": "f", "operator": "GT", "value": "2026-01-02T03:04:05Z"}]},
        {"f": _spec("time")}))
    assert "2026-01-02 03:04:05" in t, t
    b = _sql(build_conditions(
        {"conditions": [{"field": "f", "operator": "EQUALS", "value": False}]},
        {"f": _spec("bool")}))
    assert "false" in b.lower() and "'False'" not in b, b
    # bool 的否定不走 `OR flag IS NULL`：`NOT (flag IS true)` 对 NULL 本就是真，没有三值坑
    assert "IS NULL" not in _sql(build_conditions(
        {"conditions": [{"field": "f", "operator": "NOT_EQUALS", "value": True}]},
        {"f": _spec("bool")}))


def test_labels_cover_exactly_the_operators() -> None:
    """人话名表必须与操作符集合**互相**覆盖：少一个前端就有裸英文，多一个是死翻译。"""
    # 只比集合相等不够：标签全清空，下面那条「裸英文」的告警照样不会响。
    assert OPERATOR_LABELS and all(v.strip() for v in OPERATOR_LABELS.values()), "标签表有空值"
    assert set(OPERATOR_LABELS) == set(OPERATORS), (
        "OPERATOR_LABELS 与 OPERATORS 不一致：" +
        f"缺 {sorted(set(OPERATORS) - set(OPERATOR_LABELS))}，"
        f"多 {sorted(set(OPERATOR_LABELS) - set(OPERATORS))}")


def test_count_operators_are_deliberately_absent() -> None:
    """MS 的 13 枚里 COUNT_GT/COUNT_LT 一期不做——但必须**在 filter_meta 里点名说明**。

    静少两枚 = 用户从 MS 过来找不到，只能猜是我们漏了；点名说明 = 界面能答「为什么没有」。
    """
    assert "COUNT_GT" not in OPERATORS and "COUNT_LT" not in OPERATORS
    from app.modules.search.view_services import _UNAVAILABLE

    assert set(_UNAVAILABLE) == {"COUNT_GT", "COUNT_LT"}
    # 文案非空且 COUNT_GT 那条要把理由说清（COUNT_LT 是「同 COUNT_GT」的引用，不再重复）
    assert all(v.strip() for v in _UNAVAILABLE.values()), "unavailable 的文案不许空着"
    assert "假操作符" in _UNAVAILABLE["COUNT_GT"], _UNAVAILABLE["COUNT_GT"]


def test_empty_conditions_yield_no_restriction() -> None:
    """None / 空 conditions / 空 search_mode → 不加任何限制（编译成常量 true）。

    空条件不能变成「一条都不返回」：前端首次进页面就是空条件，那种实现看起来像「表是空的」。
    """
    for raw in (None, {"conditions": []}, {"search_mode": "", "conditions": None}):
        got = _sql(build_conditions(raw, FIELDS))
        assert got.strip().lower() == "true", f"空条件应编成无限制常量，实得 {got!r}"

    # 反过来：**给了对象却没有 conditions 键**不是「没筛选」，是坏条件。
    # 读成空条件就会返回全量，而用户以为筛过了——本模块的核心口径。
    for raw in ({}, {"search_mode": "OR"}, {"conditions": {"a": 1}}):
        try:
            build_conditions(raw, FIELDS)
        except BadFilter:
            continue
        raise AssertionError(f"形状不对的条件被当成了「没筛选」：{raw!r}")


def _like_pair(value: str) -> tuple[str, str]:
    """编一条 CONTAINS，返回 (SQL 文本, 真正发给驱动的 LIKE 值)。

    转义要看**绑定参数**，不看 SQL 文本：MySQL dialect 在 literal_binds 下把 % 翻成 %%、
    反斜杠翻成两个反斜杠，两层转义叠在一行里全是斜杠，谁都判不了对不对。参数值才是
    「数据库最终拿什么去匹配」的原文。
    """
    cond = build_conditions(
        {"conditions": [{"field": "maybe", "operator": "CONTAINS", "value": value}]}, FIELDS)
    text_sql = str(cond.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))
    (like_value,) = cond.compile(dialect=mysql.dialect()).params.values()
    return text_sql, like_value


def test_like_escapes_wildcards() -> None:
    """用户敲的 % 与 _ 是字面量。把 `_like` 改回原样返回，本例红。

    不转义时搜 "%" 匹配全表：用户看到的是「这框一搜就全中」，而这是筛选项说谎的一种。
    """
    bs = chr(92)  # 一个反斜杠，写在断言里比在一堆转义里数斜杠清楚
    sql, like = _like_pair("50%_a")
    assert like == f"%50{bs}%{bs}_a%", like    # 两端那个 % 是我们加的通配符，用户那两个不是
    assert "ESCAPE" in sql, sql                # 没 ESCAPE，这两个反斜杠就是普通字符 = 没转义

    _, back = _like_pair("a" + bs + "b")
    assert back == f"%a{bs}{bs}b%", back       # 用户敲的反斜杠也要转义，否则会吞掉后一个字符

    _, only = _like_pair("%")
    assert only == f"%{bs}%%", only            # 只含通配符的输入：中间那个必须被转义



def test_negation_on_nullable_column_keeps_null_rows() -> None:
    """可空列的否定筛选必须留 NULL 行。摘掉 `_neg` 里的 `OR ... IS NULL` 本例红。

    三值逻辑下 `NOT (NULL IN ('M1'))` 是 NULL → 行被丢掉。后果是「模块 不属于 [M1]」
    把**未分类**的接口整批藏起来，而用户看到的结果被标成「这些就是不属于 M1 的」。
    """
    s = _one("NOT_IN", ["M1"])
    assert "maybe IS NULL" in s, s
    assert "NOT IN" in s, s
    assert "OR" in s, s


def test_negation_on_non_null_column_has_no_dead_null_clause() -> None:
    """非空列不补 `IS NULL`：那是永假条件，只会让 SQL 变长、让人以为这列可能为空。"""
    s = _one("NOT_EQUALS", "v", field="always")
    assert "always IS NULL" not in s, s
    assert "!=" in s or "NOT" in s, s


def test_unknown_field_message_names_the_whitelist() -> None:
    """字段名是后端定的，用户看不见 → 报错必须把可筛清单带出来。"""
    try:
        _one("EQUALS", "v", field="secret_column")
    except BadFilter as e:
        msg = str(e)
        assert "secret_column" in msg and "maybe" in msg and "always" in msg, msg
    else:
        raise AssertionError("白名单外的字段竟然过了")


def test_operator_not_applicable_to_column_kind_is_rejected() -> None:
    """在 text 列上用 BETWEEN 要 400，不能编出一条看不懂的 SQL 或静默忽略。"""
    try:
        _one("BETWEEN", ["a", "b"])  # maybe 是 text 列，BETWEEN 只属于 number/time
    except BadFilter as e:
        assert "text" in str(e) and "BETWEEN" in str(e), str(e)
    else:
        raise AssertionError("text 列上的 BETWEEN 竟然编出来了")


def test_bad_value_shapes_are_rejected_not_ignored() -> None:
    """值形状不对一律抛：IN 要非空数组、BETWEEN 要两元素、CONTAINS 要字符串。

    「不对就忽略」会返回**没筛过的全量**，而用户以为筛过了——比报错严重得多。
    """
    for op, val in (("IN", []), ("IN", "not-a-list"), ("BETWEEN", [1]), ("BETWEEN", "x"),
                    ("CONTAINS", 5), ("EQUALS", 5)):
        try:
            _one(op, val, field="num" if op == "BETWEEN" else "maybe")
        except BadFilter:
            continue
        raise AssertionError(f"{op} 接受了坏值 {val!r}")


def test_time_values_are_converted_to_naive_utc() -> None:
    """带 Z / 带偏移的时间 → UTC naive（库里存的就是 naive UTC）。

    不换算的话 `2026-01-01T00:00:00+08:00` 会被驱动拒掉，或者更糟：悄悄比错 8 小时。
    """
    from app.shared.filters import _time

    assert _time("2026-01-01T00:00:00Z", "f").tzinfo is None
    assert _time("2026-01-01T08:00:00+08:00", "f").hour == 0
    assert _time("2026-01-01T00:00:00", "f").tzinfo is None  # 无 tz 按 UTC，不猜本地
    try:
        _time("昨天", "f")
    except BadFilter as e:
        assert "ISO8601" in str(e)
    else:
        raise AssertionError("非 ISO 时间被接受了")


def test_bad_search_mode_is_rejected() -> None:
    for mode in ("MIXED", "and", 1):
        try:
            build_conditions({"search_mode": mode, "conditions": [
                {"field": "maybe", "operator": "EQUALS", "value": "x"}]}, FIELDS)
        except BadFilter:
            continue
        raise AssertionError(f"search_mode={mode!r} 被接受了")


# ---- 内核层：OR 组与可见性谓词的相对位置 ---------------------------------------------


def test_or_group_is_parenthesized_alongside_visibility() -> None:
    """OR 组必须是一个括号整体，与可见性谓词 AND 在一起。

    这条**不是**在说「分开 where 会越权」（SQLAlchemy 的多个 where 本来就是 AND，
    见 filters 模块 docstring 那条纠正）。它钉的是：组内确实是 OR、整体确实带括号——
    哪天编译器改成把条件平铺出来，前端勾「或」就会静默变成「且」。
    """
    raw = {"search_mode": "OR", "conditions": [
        {"field": "maybe", "operator": "CONTAINS", "value": "a"},
        {"field": "num", "operator": "GT", "value": 3}]}
    s = _sql(build_conditions(raw, FIELDS))
    assert s.lstrip().startswith("("), s
    assert " OR " in s, s
    assert " AND " not in s, f"OR 组里混进了顶层 AND（平铺了）：{s}"


# ---- 行为层：私有行不被 OR 筛出来（本文件的安全主案） --------------------------------


async def _project(client, h, name):
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h_pa, pid, make_user, account, role):
    u, h = await make_user(account)
    r = await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                         json={"role_code": role}, headers=h_pa)
    assert r.status_code == 200, r.text
    return u, h


async def _def(client, h, pid, name, *, public=True, path="/p"):
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": path,
        "project_public": public,
        "request": {"method": "GET", "url": "http://127.0.0.1:9/x"}}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _list(client, h, pid, flt=None):
    params: dict[str, str] = {"project_id": pid}
    if flt is not None:
        params["filter"] = json.dumps(flt, ensure_ascii=False) if not isinstance(flt, str) else flt
    r = await client.get("/api/v1/api-definitions", params=params, headers=h)
    return r


async def _names(client, h, pid, flt=None):
    r = await _list(client, h, pid, flt)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_or_does_not_leak_invisible_rows(client, make_user) -> None:
    """OR 筛选绝不能把别人的私有接口带进结果里（§4.1 数据权限）。

    靶子形状刻意挑最坏的：私有行的名字**同时命中 OR 的两侧**，公开行也命中。
    可见性谓词一旦没和 OR 组 AND 上，私有行就会因为「命中条件」而现身。
    变异自证：把 api_definition_list 里 `visible_clause(ApiDefinition, ctx)` 摘掉 → 本例红。
    """
    h_pa = (await make_user("d47pa"))[1]
    pid = await _project(client, h_pa, "d47_leak")
    _, h_view = await _member(client, h_pa, pid, make_user, "d47view", "MEMBER")
    _, h_priv = await _member(client, h_pa, pid, make_user, "d47priv", "MEMBER")

    await _def(client, h_priv, pid, "撞名-私有", public=False, path="/priv")
    await _def(client, h_priv, pid, "撞名-公开", public=True, path="/pub")

    # 控制组：不带筛选时也看不到（否则下面的断言可能只是巧合）
    assert await _names(client, h_view, pid) == {"撞名-公开"}

    for mode in ("AND", "OR"):
        got = await _names(client, h_view, pid, {
            "search_mode": mode,
            "conditions": [{"field": "path", "operator": "CONTAINS", "value": "/"},
                           {"field": "name", "operator": "CONTAINS", "value": "撞名"}]})
        assert "撞名-私有" not in got, f"{mode} 模式下私有行泄露：{got}"
        assert "撞名-公开" in got, f"{mode} 模式把该看见的也筛掉了：{got}"

    # 直接按 path 精确筛私有行所在路径：结果必须是空，而不是 403/404 之类（它只是不存在）
    got = await _names(client, h_view, pid, {
        "search_mode": "OR",
        "conditions": [{"field": "path", "operator": "EQUALS", "value": "/priv"}]})
    assert got == set(), got


async def test_list_filter_actually_filters(client, make_user) -> None:
    """筛选真能筛：CONTAINS / IN / 否定 / 时间 各来一发，并核对「筛完剩下谁」。"""
    h = (await make_user("d47filt"))[1]
    pid = await _project(client, h, "d47_filt")
    await _def(client, h, pid, "创建订单", path="/order/create")
    await _def(client, h, pid, "取消订单", path="/order/cancel")
    await _def(client, h, pid, "查询库存", path="/stock/query")

    assert await _names(client, h, pid, {"conditions": [
        {"field": "name", "operator": "CONTAINS", "value": "订单"}]}) == {"创建订单", "取消订单"}
    assert await _names(client, h, pid, {"conditions": [
        {"field": "method", "operator": "IN", "value": ["POST"]}]}) == set()
    # 未分类（module_id IS NULL）在否定筛选下必须**留在**结果里
    assert await _names(client, h, pid, {"conditions": [
        {"field": "module_id", "operator": "NOT_IN", "value": ["不存在的模块"]}]}) == \
        {"创建订单", "取消订单", "查询库存"}
    assert await _names(client, h, pid, {"conditions": [
        {"field": "path", "operator": "NOT_CONTAINS", "value": "order"}]}) == {"查询库存"}
    assert await _names(client, h, pid, {"conditions": [
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]}]}) == \
        {"创建订单", "取消订单", "查询库存"}
    assert await _names(client, h, pid, {"conditions": [
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["1990-01-01T00:00:00Z", "1991-01-01T00:00:00Z"]}]}) == set()


async def test_bad_filter_is_400_with_the_field_list(client, make_user) -> None:
    """坏条件 → 400（不是 500、不是静默返回全量），文案带本页可筛清单。"""
    h = (await make_user("d47bad"))[1]
    pid = await _project(client, h, "d47_bad")

    # 形状对、字段不在白名单：报错必须点名这个字段并把可筛清单带出来
    r = await _list(client, h, pid, {"conditions": [
        {"field": "password_hash", "operator": "EQUALS", "value": "x"}]})
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter", body
    assert "password_hash" in body["message"] and "接口名称" in body["message"], body

    # 形状本身不对（没有 conditions 键）：400，同样带清单
    r_shape = await _list(client, h, pid, {"search_mode": "OR"})
    assert r_shape.status_code == 400, r_shape.text
    assert "conditions" in r_shape.json()["message"], r_shape.json()

    r2 = await _list(client, h, pid, "这根本不是 JSON")
    assert r2.status_code == 400, r2.text
    assert r2.json()["code"] == "bad_filter", r2.json()

    r3 = await _list(client, h, pid, {"search_mode": "XOR", "conditions": []})
    assert r3.status_code == 400, r3.text

    # 空串 = 没筛选（前端常把「清空」发成空串），必须照常返回全量而不是 400
    assert await _names(client, h, pid, "") == set()


async def test_filter_composes_with_recycled_view(client, make_user) -> None:
    """筛选与回收站开关是两回事：两个都得在，且回收站视图不能因为带筛选就漏出正常行。"""
    h = (await make_user("d47rec"))[1]
    pid = await _project(client, h, "d47_rec")
    did = await _def(client, h, pid, "要被回收", path="/rec")
    await _def(client, h, pid, "留着", path="/keep")
    d = await client.post(f"/api/v1/api-definitions/{did}/delete", json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text

    flt = {"conditions": [{"field": "path", "operator": "CONTAINS", "value": "/"}]}
    got = await _names(client, h, pid, flt)
    assert got == {"留着"}, got
    r = await client.get("/api/v1/api-definitions",
                         params={"project_id": pid, "recycled": "true",
                                 "filter": json.dumps(flt)}, headers=h)
    assert r.status_code == 200, r.text
    assert {x["name"] for x in r.json()["items"]} == {"要被回收"}


# ---- 行为层：filter_meta -----------------------------------------------------------


async def test_filter_meta_drives_the_frontend_form(client, make_user) -> None:
    """前端表单照这个渲染：字段/控件型/每字段可用操作符都得给全，并且不含库里没有的列。"""
    h = (await make_user("d47meta"))[1]
    pid = await _project(client, h, "d47_meta")
    r = await client.get("/api/v1/filter-meta", params={"project_id": pid, "view_type": "api"},
                         headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert sorted(body["operators"]) == sorted(OPERATORS)
    assert body["labels"]["CONTAINS"] == "包含"
    assert set(body["kinds"]) == set(KINDS)
    assert set(body["unavailable"]) == {"COUNT_GT", "COUNT_LT"}
    assert "api" in body["supported_view_types"]
    fields = {f["field"]: f for f in body["fields"]}
    assert {"name", "path", "method", "status", "module_id", "owner_id"} <= set(fields)
    # 「没有的列」不可能出现在这里：project_id / password_hash 之类的越权面进不了清单
    assert not {"project_id", "password_hash", "request", "recycled"} & set(fields)
    # 非空列拿不到 EMPTY/NOT_EMPTY（method 在库里 NOT NULL）
    assert "EMPTY" not in fields["method"]["ops"]
    assert "EMPTY" in fields["module_id"]["ops"]
    assert fields["created_at"]["kind"] == "time" and "BETWEEN" in fields["created_at"]["ops"]


async def test_filter_meta_without_view_type_is_global_only(client, make_user) -> None:
    """不带 view_type = 只要全局清单（前端启动拉一次操作符表），fields 留空不猜。"""
    h = (await make_user("d47metabare"))[1]
    pid = await _project(client, h, "d47_meta_bare")
    r = await client.get("/api/v1/filter-meta", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["fields"] == [] and r.json()["view_label"] is None


async def test_filter_meta_unknown_view_type_is_400_not_500(client, make_user) -> None:
    """用户/前端写错页名 → 400 带已支持清单。让它冒成 500 就是把用户写错的参数
    报成服务端故障（BadFilter 是 ValueError，全局处理器不认它）。"""
    h = (await make_user("d47metaunk"))[1]
    pid = await _project(client, h, "d47_meta_unk")
    r = await client.get("/api/v1/filter-meta",
                         params={"project_id": pid, "view_type": "no_such_page"}, headers=h)
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter" and "api" in body["message"], body


async def test_filter_meta_requires_project_membership(client, make_user) -> None:
    """元数据也要过项目门：非成员不能凭一个 project_id 探这一页有哪些字段。"""
    h_a = (await make_user("d47metaout"))[1]
    pid = await _project(client, h_a, "d47_meta_out")
    _, h_b = await make_user("d47metastranger")
    r = await client.get("/api/v1/filter-meta", params={"project_id": pid}, headers=h_b)
    assert r.status_code == 403, r.text


# ---- 行为层：个人视图 CRUD ----------------------------------------------------------

_VIEW = {"search_mode": "OR", "conditions": [{"field": "name", "operator": "CONTAINS",
                                              "value": "失败"}]}


async def _mk_view(client, h, pid, name, *, view_type="api", conditions=None):
    return await client.post("/api/v1/saved-views", json={
        "project_id": pid, "view_type": view_type, "name": name,
        "conditions": conditions or _VIEW}, headers=h)


async def _views(client, h, pid, view_type="api"):
    r = await client.get("/api/v1/saved-views",
                         params={"project_id": pid, "view_type": view_type}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_saved_view_crud_roundtrip(client, make_user) -> None:
    """存 → 列 → 改 → 删，条件**原样回吐**。

    原样是语义：视图的意思是「把当时那份筛选装回去」，落库时规范化（排序/去重/改操作符）
    就会改变它筛出来的东西。
    """
    h = (await make_user("d47vcrud"))[1]
    pid = await _project(client, h, "d47_v_crud")

    r = await _mk_view(client, h, pid, "我的失败")
    assert r.status_code == 201, r.text
    vid = r.json()["id"]
    assert r.json()["conditions"] == _VIEW, r.json()
    assert r.json()["updated_at"], "列表要显示更新时间，出参不给前端就画不出"

    got = await _views(client, h, pid)
    assert [v["id"] for v in got] == [vid]

    upd = await client.patch("/api/v1/saved-views/" + vid, json={
        "project_id": pid, "view_type": "api", "view_id": vid,
        "name": "改过的名字", "conditions": {"search_mode": "AND", "conditions": []}}, headers=h)
    assert upd.status_code == 200, upd.text
    assert upd.json()["name"] == "改过的名字"
    assert upd.json()["conditions"] == {"search_mode": "AND", "conditions": []}

    dele = await client.request("DELETE", "/api/v1/saved-views/" + vid, json={
        "project_id": pid, "view_type": "api", "view_id": vid}, headers=h)
    assert dele.status_code == 200, dele.text
    assert await _views(client, h, pid) == []


async def test_saved_view_creation_requires_the_condition_shape(client, make_user) -> None:
    """形状要钉（必须带 conditions 数组），字段白名单**不**钉（docstring 那条向前兼容）。"""
    h = (await make_user("d47vshape"))[1]
    pid = await _project(client, h, "d47_v_shape")
    r = await _mk_view(client, h, pid, "没条件", conditions={"search_mode": "AND"})
    assert r.status_code == 422, r.text

    # 字段白名单外的条件**存得进来**：字段集会随批次变，存的时候钉死会让用户升级后
    # 老视图整条读不出来（「我存的视图没了」）。校验发生在读的那一页。
    r2 = await _mk_view(client, h, pid, "带未来字段", conditions={
        "search_mode": "AND", "conditions": [{"field": "someday_column",
                                              "operator": "EQUALS", "value": "x"}]})
    assert r2.status_code == 201, r2.text


async def test_saved_views_are_owner_isolated(client, make_user) -> None:
    """同项目别人的视图我看不到（视图是个人偏好，MS 同此按 userId 隔离）。

    变异自证：把 saved_view_list 里 `SavedView.owner_id == ctx.user_id` 摘掉 → 本例红。
    """
    h_pa = (await make_user("d47vpa"))[1]
    pid = await _project(client, h_pa, "d47_v_iso")
    _, h_a = await _member(client, h_pa, pid, make_user, "d47va", "MEMBER")
    _, h_b = await _member(client, h_pa, pid, make_user, "d47vb", "MEMBER")

    assert (await _mk_view(client, h_a, pid, "A的视图")).status_code == 201
    assert (await _mk_view(client, h_b, pid, "B的视图")).status_code == 201

    assert [v["name"] for v in await _views(client, h_a, pid)] == ["A的视图"]
    assert [v["name"] for v in await _views(client, h_b, pid)] == ["B的视图"]


async def test_other_users_view_reads_as_not_found(client, make_user) -> None:
    """改/删别人的视图 = 404，与不存在同码同文案（不泄露「有这条」）。

    进攻方刻意用 **PROJECT_ADMIN** 而不是 MEMBER：MEMBER 被 `-*:delete` 挡在
    `ctx.require("search:view:delete")`，那一格 403 是权限门的功劳，与归属无关；
    项目管理员**有**这一位、也看得见项目里一切私有资源，他撞上的才必须是归属谓词给的 404。
    （同一格在矩阵里也存在，见 test_permission_matrix 的 saved_view_* 三行。）

    变异自证：把 _fetch 里的 owner_id 谓词摘掉 → 本例红（PATCH 会变 200，DELETE 会真删掉）。
    """
    h_pa = (await make_user("d47v404pa"))[1]
    pid = await _project(client, h_pa, "d47_v_404")
    _, h_a = await _member(client, h_pa, pid, make_user, "d47v404a", "MEMBER")
    _, h_b = await _member(client, h_pa, pid, make_user, "d47v404b", "PROJECT_ADMIN")
    vid = (await _mk_view(client, h_a, pid, "只有我有")).json()["id"]

    p = await client.patch("/api/v1/saved-views/" + vid, json={
        "project_id": pid, "view_type": "api", "view_id": vid, "name": "我改你的"}, headers=h_b)
    assert p.status_code == 404, p.text
    assert p.json()["code"] == "not_found"

    d = await client.request("DELETE", "/api/v1/saved-views/" + vid, json={
        "project_id": pid, "view_type": "api", "view_id": vid}, headers=h_b)
    assert d.status_code == 404, d.text
    # A 的原视图完好无损
    assert [v["name"] for v in await _views(client, h_a, pid)] == ["只有我有"]


async def test_same_name_is_free_for_different_owners(client, make_user) -> None:
    """同名跨主人合法。把 _assert_name_free 的 owner_id 谓词摘掉本例红（第二人被 409）。

    唯一约束按 (project, view_type, owner, name) 四元组判重，预检若比约束严，
    就是多拦了合法请求——这种 bug 只会以「同事存了个同名视图结果我存不了」的形式被人发现。
    """
    h_pa = (await make_user("d47vdppa"))[1]
    pid = await _project(client, h_pa, "d47_v_dup")
    _, h_a = await _member(client, h_pa, pid, make_user, "d47vdpa", "MEMBER")
    _, h_b = await _member(client, h_pa, pid, make_user, "d47vdpb", "MEMBER")
    assert (await _mk_view(client, h_a, pid, "我的失败")).status_code == 201
    assert (await _mk_view(client, h_b, pid, "我的失败")).status_code == 201
    # 同主人同名 → 409
    assert (await _mk_view(client, h_a, pid, "我的失败")).status_code == 409
    # 同主人、不同页面（view_type）→ 合法：两份不同东西
    assert (await _mk_view(client, h_a, pid, "我的失败", view_type="scenario")).status_code == 201
    assert [v["name"] for v in await _views(client, h_a, pid, "scenario")] == ["我的失败"]
    # 改名撞自己另一条视图的名字 → 409；改回自己的原名 → 合法（名字没变，压根不判重）
    other = (await _mk_view(client, h_a, pid, "另一个")).json()["id"]
    bad = await client.patch("/api/v1/saved-views/" + other, json={
        "project_id": pid, "view_type": "api", "view_id": other, "name": "我的失败"}, headers=h_a)
    assert bad.status_code == 409, bad.text
    ok = await client.patch("/api/v1/saved-views/" + other, json={
        "project_id": pid, "view_type": "api", "view_id": other, "name": "另一个"}, headers=h_a)
    assert ok.status_code == 200, ok.text


async def test_readonly_role_can_read_views_but_not_write(client, make_user) -> None:
    """READONLY 能列（search:read）不能存/改/删（search:view:create|update|delete）。

    这一格与 test_permission_matrix 的 4×3 格重合，留在这里的理由：矩阵那三行用**别人的**
    view_id 打靶，拒绝格都在 `ctx.require` 就 403 了，走不到归属判定；这里补的是同一角色
    在**自己**的视图上的路径。
    """
    h_pa = (await make_user("d47vropa"))[1]
    pid = await _project(client, h_pa, "d47_v_ro")
    _, h_ro = await _member(client, h_pa, pid, make_user, "d47vro", "READONLY")
    assert (await _mk_view(client, h_pa, pid, "管理员的视图")).status_code == 201

    assert (await _views(client, h_ro, pid)) == []  # 看得见这一页，但这一页上没有他的视图
    assert (await _mk_view(client, h_ro, pid, "存不下")).status_code == 403


async def test_view_write_requires_project_membership(client, make_user) -> None:
    """跨项目：不是 A 项目的成员，连 A 项目里有个视图这件事都探不到。

    与 test_other_users_view_reads_as_not_found 是两道不同的门：那一条攻的是**同项目内**
    的归属（门过了，`_fetch` 的 owner_id 给 404），这一条攻的是**项目成员制**
    （`ensure_project_access` 直接 403，走不到归属判定）。两条都在，缺一条就是少一道闸。

    攻击写法是「拿别人的 project_id 去打别人的视图」——这正是 tpl/深链被手改之后
    最容易长出来的请求形状。
    """
    h_a = (await make_user("d47vouta"))[1]
    pid = await _project(client, h_a, "d47_v_out")
    vid = (await _mk_view(client, h_a, pid, "我项目里的")).json()["id"]
    _, h_b = await make_user("d47voutb")  # 只建用户，不加成员

    assert await _views(client, h_a, pid)  # A 自己看得见（反面对照：视图确实存在）
    assert [v["name"] for v in await _views(client, h_a, pid)] == ["我项目里的"]

    p = await client.patch("/api/v1/saved-views/" + vid, json={
        "project_id": pid, "view_type": "api", "view_id": vid, "name": "越权改名"}, headers=h_b)
    assert p.status_code == 403, p.text
    d = await client.request("DELETE", "/api/v1/saved-views/" + vid, json={
        "project_id": pid, "view_type": "api", "view_id": vid}, headers=h_b)
    assert d.status_code == 403, d.text
    assert [v["name"] for v in await _views(client, h_a, pid)] == ["我项目里的"]


# ---- 注册表自身 --------------------------------------------------------------------


def test_registry_rejects_duplicate_view_type() -> None:
    """两页抢同一个 view_type 必须当场炸，而不是后 import 的静默覆盖前一份。"""
    import pytest

    from app.shared.filter_registry import FieldDecl, ListViewFilter, register

    dup = ListViewFilter(view_type="api", label="撞名",
                         fields={"x": FieldDecl(_C.t.c.maybe, "text", "X")})
    with pytest.raises(ValueError, match="重复登记"):
        register(dup)


def test_registry_view_types_are_registered_pages() -> None:
    """已登记页面清单是前端「哪些页面有高级搜索」的真相；当前 = adb_case + adb_device + api + audit + case_review + channel + custom_field + dataset + defect + env_group + file + functional_case + member + mock_rule + plan + public_script + report + run + scenario + schedule + task_center + template + ui_case + ui_element + user。

    这条**故意**在加页时会红：加一页要同时加它的筛选行为测试（D212 的
    test_d212_plan_advanced_search.py / D213 的 test_d213_ui_case_advanced_search.py /
    D214 的 test_d214_scenario_advanced_search.py / D215 的
    test_d215_report_advanced_search.py / D216 的
    test_d216_defect_advanced_search.py / D217 的
    test_d217_adb_case_advanced_search.py / D219 的
    test_d219_functional_case_advanced_search.py / D220 的
    test_d220_ui_element_advanced_search.py / D221 的
    test_d221_case_review_advanced_search.py / D222 的
    test_d222_file_advanced_search.py / D223 的
    test_d223_dataset_advanced_search.py / D224 的
    test_d224_adb_device_advanced_search.py / D239 的
    test_d239_task_center_advanced_search.py / D240 的
    test_d240_schedule_advanced_search.py / D241 的
    test_d241_mock_rule_advanced_search.py / D242 的
    test_d242_run_advanced_search.py / D246 的
    test_d246_audit_advanced_search.py / D247 的
    test_d247_project_meta_advanced_search.py / D249 的
    test_d249_env_group_advanced_search.py / D250 的
    test_d250_public_script_advanced_search.py 就是两端随行用例），不能只改一行
    登记就当交付了。
    """
    assert view_types() == ["adb_case", "adb_device", "api", "audit", "case_review", "channel",
                            "custom_field", "dataset", "defect", "env_group", "file",
                            "functional_case", "member", "mock_rule", "plan", "public_script",
                            "report", "run", "scenario", "schedule", "task_center", "template",
                            "ui_case", "ui_element", "user"]
