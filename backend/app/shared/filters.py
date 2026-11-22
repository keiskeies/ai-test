"""列表高级搜索：条件 JSON → SQL 谓词（§11.5.1「高级搜索 AND/OR 条件组」，D47-a）。

条件形状与操作符清单照 MeterSphere v3 的**实物契约**（读语义不抄码，见
docs/2026-11-20-metersphere-parity-audit.md §2.1.1）：

    {"search_mode": "AND" | "OR", "conditions": [{"field", "operator", "value"}]}

MS 侧 `BaseCondition.searchMode` 默认 `"AND"`，操作符 13 枚、值控件 10 型。本平台**一期只放
当前列真的支持的组合**——把操作符摆到没有的列上就是「假筛选项」（选了没反应 = 骗人），
所以：

- **本模块不认识任何具体表**：可筛字段由调用方按页声明（`FieldSpec` 白名单）。
  字段不在白名单 → 400，**不静默忽略**（静默忽略会返回「没筛」的全量结果，用户以为是筛完的结果）。
- 操作符对某列类型无意义 → 400，同理。
- `COUNT_GT / COUNT_LT`（MS 的聚合计数操作符）一期**不提供**：它要子查询聚合，
  当前没有任何一页有可聚合的子表，摆出来就是假操作符。调用方不给 `count` 类型即拿不到。

`search_mode=OR` 时整组条件包成**一个** `or_(...)` 返回。两个理由，一真一防：

- **语义**：调用方如果逐条 `.where()` 铺下去，OR 会被 SQL 的 AND 拼接悄悄变成 AND——
  用户勾了「或」，拿到的是「且」的结果，而且界面上一切正常。返回单个元素就是让它铺不开。
- **防的是把谓词降级成裸串**：`stmt.where(text("name LIKE '%x%' OR ..."))` 这种写法
  （以及任何把条件拼成 SQL 文本的"优化"）会让 OR 吃掉可见性谓词，那才是 §4.1 的私有资源
  泄露。ORM 的 `.where()` 自己会加括号，所以本仓当前形态不会泄露——测试
  `test_or_does_not_leak_invisible_rows` 钉的是「结果里一行私有数据都不许出现」这件事本身：
  今天它由 SQLAlchemy 的括号保证，哪天有人改用裸串拼接，它当场红。

（顺带一句避免误读：SQLAlchemy 的多个 `.where()` 是 AND，不是 OR 优先级那种坑。
本模块刻意不说「分开 where 会越权」——那是把两个不同的坑混成一个，本轮自查时纠正。）
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import and_, or_, true
from sqlalchemy.sql.elements import ColumnElement

SearchMode = Literal["AND", "OR"]

# MS OperatorEnum 的 13 枚里本平台落地的 11 枚（COUNT_* 两枚见模块 docstring）。
OPERATORS: frozenset[str] = frozenset({
    "CONTAINS", "NOT_CONTAINS",
    "IN", "NOT_IN",
    "EQUALS", "NOT_EQUALS",
    "GT", "LT",
    "BETWEEN",
    "EMPTY", "NOT_EMPTY",
})

# 值控件型 → 该型允许的操作符。列没有「控件型」就没有操作符白名单，
# 而「这一列能怎么筛」是页面声明字段时必须说清楚的一件事。
_KIND_OPS: dict[str, frozenset[str]] = {
    "text": frozenset({"CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "EQUALS", "NOT_EQUALS",
                       "EMPTY", "NOT_EMPTY"}),
    "enum": frozenset({"IN", "NOT_IN", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"}),
    "number": frozenset({"EQUALS", "NOT_EQUALS", "GT", "LT", "BETWEEN", "EMPTY", "NOT_EMPTY"}),
    "time": frozenset({"GT", "LT", "BETWEEN", "EMPTY", "NOT_EMPTY"}),
    "id": frozenset({"IN", "NOT_IN", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"}),
    "bool": frozenset({"EQUALS", "NOT_EQUALS"}),
}
KINDS: frozenset[str] = frozenset(_KIND_OPS)


@dataclass(frozen=True)
class FieldSpec:
    """一列可筛字段：SQLAlchemy 列 + 值控件型 + 这列能不能为空。

    列名由调用方给，本模块不做字符串→列的反射（反射 = 把「数据库里有什么」当成
    「允许用户按什么筛」，那是注入面的另一种写法）。

    `nullable` 不是装饰：三值逻辑下 `NOT (NULL IN (…))` 是 NULL，行会被 WHERE 丢掉。
    于是「模块 不属于 [M1]」在朴素的 `NOT IN` 下会把**未分类**（module_id IS NULL）的
    接口整批藏起来——用户看到的结果是「这些就是不属于 M1 的」，而少掉的那批恰恰最不属于
    M1。所以可空列上的否定谓词必须补 `OR col IS NULL`（见 `_neg`）。
    """

    column: Any
    kind: str
    nullable: bool = True

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"未知字段类型 {self.kind!r}，可选：{sorted(KINDS)}")


class BadFilter(ValueError):
    """条件不合法（字段不在白名单 / 操作符不适用 / 值形状不对）。

    调用方必须把它转成 **400**，不许降级成「忽略这条继续查」——见模块 docstring。
    """


def _bad(msg: str) -> BadFilter:
    return BadFilter(msg)


def _neg(expr: ColumnElement[bool], spec: FieldSpec) -> ColumnElement[bool]:
    """取反，且让「这列没值」的行留在结果里（可空列）。

    只对**可空**列补 `OR col IS NULL`：非空列加这一句是死条件，只会让 SQL 变长变难读。
    取反用 `~`（SQLAlchemy 的否定入口，`col.in_(...)` 上它会得到 `NOT IN`；
    `.negate()` 不是公开入口，In 操作符上直接 TypeError——本轮踩过）。
    「没值算不算不属于这一组」是语义选择，这里的答案是**算**——用户的直觉是「它不在
    我给的那堆里」，而不是「数据库里这一格是不是 NULL」。反过来的口径（NULL 不算不属于）
    会让「未分类」这一类资产在任何否定筛选下凭空消失，那种结果没人能看出来少了。
    """
    return or_(spec.column.is_(None), ~expr) if spec.nullable else ~expr


def _like(v: str) -> str:
    """LIKE 值转义：用户敲的 % 与 _ 是**字面量**，不是通配符。

    不转义的话搜 "%" 会匹配全表，用户看到的是「这个搜索框一搜就全中」——
    这是筛选项说谎的另一种形态。ESCAPE 子句在编译器两侧（CONTAINS/NOT_CONTAINS）共用。
    """
    return v.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")


def _num(v: Any, field: str) -> float:
    if isinstance(v, bool):
        raise _bad(f"{field}：数值筛选不接受布尔值")
    try:
        return float(v)
    except (TypeError, ValueError) as e:
        raise _bad(f"{field}：期望数值，收到 {v!r}") from e


def _time(v: Any, field: str) -> datetime:
    """时间值 → **UTC naive** datetime。

    本库时刻列按 §终稿自查 存 UTC naive（UtcDateTime），拿带 tzinfo 的对象去比会直接
    被驱动拒掉或悄悄比错 8 小时，所以在这里统一剥掉 tzinfo。无 tz 的字面量按 UTC 解释
    ——不做「按浏览器时区猜」，前端传什么就是什么（前端负责换算，见 shared/listFilters.ts）。
    """
    if isinstance(v, datetime):
        dt = v
    elif isinstance(v, str):
        s = v.strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
        except ValueError as e:
            raise _bad(f"{field}：时间格式不是 ISO8601，收到 {v!r}") from e
    else:
        raise _bad(f"{field}：期望时间字符串，收到 {v!r}")
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _as_list(v: Any, field: str) -> list[Any]:
    if not isinstance(v, list) or not v:
        raise _bad(f"{field}：该操作符要非空数组，收到 {v!r}")
    return v


def _pair(v: Any, field: str) -> tuple[Any, Any]:
    if not isinstance(v, list) or len(v) != 2:
        raise _bad(f"{field}：BETWEEN 要 [下界, 上界] 两元素数组，收到 {v!r}")
    return v[0], v[1]


def _one(cond: dict[str, Any], fields: dict[str, FieldSpec]) -> ColumnElement[bool]:
    if not isinstance(cond, dict):
        raise _bad(f"条件必须是对象，收到 {cond!r}")
    field = cond.get("field")
    if not isinstance(field, str) or field not in fields:
        known = sorted(fields)
        raise _bad(f"字段 {field!r} 不在本页可筛白名单内，可筛：{known}")
    op = cond.get("operator")
    if op not in OPERATORS:
        raise _bad(f"操作符 {op!r} 不存在，可用：{sorted(OPERATORS)}")
    spec = fields[field]
    if op not in _KIND_OPS[spec.kind]:
        raise _bad(f"{field} 是 {spec.kind} 列，不支持 {op}，可用：{sorted(_KIND_OPS[spec.kind])}")

    col = spec.column
    val = cond.get("value")

    if op == "EMPTY":
        return col.is_(None)
    if op == "NOT_EMPTY":
        return col.is_not(None)
    if op in ("CONTAINS", "NOT_CONTAINS"):
        if not isinstance(val, str):
            raise _bad(f"{field}：{op} 要字符串，收到 {val!r}")
        expr = col.like(f"%{_like(val)}%", escape="\\")
        return expr if op == "CONTAINS" else _neg(expr, spec)
    if op in ("IN", "NOT_IN"):
        items = _as_list(val, field)
        if spec.kind == "number":
            items = [_num(x, field) for x in items]
        elif spec.kind == "time":
            items = [_time(x, field) for x in items]
        expr = col.in_(items)
        return expr if op == "IN" else _neg(expr, spec)
    if op in ("EQUALS", "NOT_EQUALS"):
        if spec.kind == "number":
            expr = col == _num(val, field)
        elif spec.kind == "time":
            expr = col == _time(val, field)
        elif spec.kind == "bool":
            if not isinstance(val, bool):
                raise _bad(f"{field}：布尔筛选要 true/false，收到 {val!r}")
            # 布尔列不走 _neg：`NOT (col IS true)` 对 NULL 本身就是真，没有三值逻辑的坑。
            expr = col.is_(True) if val else col.is_(False)
            return expr if op == "EQUALS" else ~expr
        else:
            if not isinstance(val, str):
                raise _bad(f"{field}：该筛选要字符串，收到 {val!r}")
            expr = col == val
        return expr if op == "EQUALS" else _neg(expr, spec)
    if op in ("GT", "LT"):
        rhs = _num(val, field) if spec.kind == "number" else _time(val, field)
        return col > rhs if op == "GT" else col < rhs
    if op == "BETWEEN":
        lo, hi = _pair(val, field)
        if spec.kind == "number":
            lo, hi = _num(lo, field), _num(hi, field)
        else:
            lo, hi = _time(lo, field), _time(hi, field)
        return and_(col >= lo, col <= hi)
    raise _bad(f"操作符 {op!r} 未被编译器实现")  # 到不了：OPERATORS 与本函数一一对应，测试钉全集


def build_conditions(raw: Any, fields: dict[str, FieldSpec]) -> ColumnElement[bool]:
    """条件 JSON → 单个谓词（OR 模式下整组包成一个括号整体）。

    返回**单个**元素而不是列表，是让 OR 无法被调用方逐条 `.where()` 铺开后悄悄退化成
    AND（模块 docstring 那条）。

    「没筛选」只有一种写法：`raw is None`，或 `conditions` 显式是空数组 → `true()`。
    **给了对象却没有 `conditions` 键 → 400**，不是「当成没筛选」。这一字之差是本模块
    的核心口径：把形状不对的条件读成空条件，用户看到的是一页没筛过的全量数据，
    而界面上一切正常。宁可让他知道条件没生效。
    """
    if raw is None:
        return true()
    if not isinstance(raw, dict):
        raise _bad(f"高级搜索必须是对象，收到 {raw!r}")
    mode = raw.get("search_mode") or "AND"
    if mode not in ("AND", "OR"):
        raise _bad(f"search_mode 只能是 AND 或 OR，收到 {mode!r}")
    if "conditions" not in raw:
        raise _bad(f"高级搜索对象缺少 conditions 数组，收到的键：{sorted(raw)}")
    conds = raw["conditions"]
    if conds is None:
        conds = []
    if not isinstance(conds, list):
        raise _bad(f"conditions 必须是数组，收到 {conds!r}")
    if not conds:
        return true()
    parts = [_one(c, fields) for c in conds]
    # `self_group()` 是我们自己套的括号：`and_`/`or_` 单独 compile 时**不带**括号
    # （实测 `str(or_(...))` 得到 `a = %s OR b = %s`）。并进 WHERE 时 SQLAlchemy 会补，
    # 所以功能上不补也一样；补的代价是 SQL 里多一对括号，买到的是「这一整个元素是组」
    # 变成我们能自己钉住的性质（test_or_group_is_parenthesized_alongside_visibility），
    # 而不是一个要读 SQLAlchemy 编译规则才能相信的行为。
    return (and_ if mode == "AND" else or_)(*parts).self_group()


# 前端表单要用的操作符人话名。**后端这份是唯一真相**，前端 `web/src/shared/listFilters.ts`
# 另有一份镜像表，由 web 侧测试逐字读本文件核对（`shared/assertions.py` 同法——第 29 轮
# 「同一枚举多端镜像」那条轴：两份清单不互相核对就必然漂移）。
OPERATOR_LABELS: dict[str, str] = {
    "CONTAINS": "包含", "NOT_CONTAINS": "不包含",
    "IN": "属于", "NOT_IN": "不属于",
    "EQUALS": "等于", "NOT_EQUALS": "不等于",
    "GT": "大于", "LT": "小于", "BETWEEN": "介于",
    "EMPTY": "为空", "NOT_EMPTY": "不为空",
}


def kind_ops(kind: str) -> list[str]:
    """某控件型可用的操作符（稳定序：字典序，前端下拉不会抖）。"""
    if kind not in KINDS:
        raise ValueError(f"未知字段类型 {kind!r}")
    return sorted(_KIND_OPS[kind])
