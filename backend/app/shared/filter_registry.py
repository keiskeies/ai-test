"""列表页可筛字段的**唯一注册表**（§11.5.1 高级搜索，D47-a）。

为什么需要这一层而不是各页自己摆一个 dict：可筛字段天生有三个读者，各拿一份就会漂——

1. 页面 service 把 `payload.filter` 编成 SQL（`shared.filters.build_conditions` 的 `fields`）；
2. `filter_meta` 把字段与操作符清单吐给前端渲染表单（前端另抄一份必漂——第 29 轮
   「同一枚举多端镜像」那条轴的口径）；
3. 400 的文案要说清「这一页到底能按什么筛」，否则用户只能照着一条只写「字段不合法」的
   报错去猜后端定的字段名。

读者 2 是决定性的：`filter_meta` 住在 `search`（composition 层），而字段住在各页面模块。
让 search 去 `from app.modules.api_test.services import ...` 也能跑，但第二、第三、第四页
都要在 search 里加一行 import 和一个分支——组合层变成一份「哪些页面存在」的硬编码清单，
正是本文件要消灭的东西。放这里之后：**页面模块 import 本模块登记自己，search 只 import
本模块**，两边永不互相认识，新增一页只改那一页。

形状取 `app/shared/assertions.py` 的「中央注册表」前例，多一条硬约束：**本模块只认
`shared.filters` 的类型，绝不 import 任何 `app.modules.*`**。它被每个页面模块 import，
反向认领域模块就是破契约（`pyproject.toml` 的 import-linter 清单靠这一点守）。

`project_id` / `cursor` / `size` / `recycled` 这类取数机制参数**刻意不是可筛字段**：
它们是分页与视图开关，不是业务属性。放进可筛清单，`filter` 就能写
`{"field":"project_id","value":"别的项目"}`，与 `ensure_project_access` + `visible_clause`
两道把关抢同一个名字——越权的正门。项目 id 只能来自 payload 顶层，由门管。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from app.core.errors import ApiError
from app.shared.filters import BadFilter, FieldSpec, build_conditions, kind_ops


@dataclass(frozen=True)
class FieldDecl:
    """一个可筛字段：列 + 控件型 + 人话名 + 这列能不能为空。

    `nullable=False` 的列**拿不到 EMPTY / NOT_EMPTY**：非空列上「为空」永远筛不出行，
    摆进下拉就是假筛选项（选了没反应 = 骗人）。这一位是白名单里唯一由数据库决定的部分，
    所以它由登记方显式写出来，而不是让前端猜列的可空性。
    """

    column: Any
    kind: str
    label: str
    nullable: bool = True

    def ops(self) -> list[str]:
        allowed = set(kind_ops(self.kind))
        if not self.nullable:
            allowed -= {"EMPTY", "NOT_EMPTY"}
        return sorted(allowed)

    def spec(self) -> FieldSpec:
        # nullable 必须一路传到底：它同时管两件事——能不能有 EMPTY/NOT_EMPTY（上面 ops()），
        # 以及否定谓词要不要补 `OR col IS NULL`（filters._neg）。在这里丢掉，
        # 非空列就会带上永假的死条件，而「这列到底能不能为空」在调用点看不出来。
        return FieldSpec(column=self.column, kind=self.kind, nullable=self.nullable)


@dataclass(frozen=True)
class ListViewFilter:
    """一个列表页的可筛面：`view_type`（每页一枚）+ 人话页名 + 字段白名单。"""

    view_type: str
    label: str
    fields: dict[str, FieldDecl]

    def specs(self) -> dict[str, FieldSpec]:
        """给 `build_conditions` 的那份白名单（每次现取，不缓存——列对象是进程级常量，
        但缓存会让测试里换假列变成要重启的事）。"""
        return {k: d.spec() for k, d in self.fields.items()}

    def meta(self) -> list[dict[str, Any]]:
        """给前端的字段清单：前端表单照这个渲染，不自己列字段名。"""
        return [{"field": k, "label": d.label, "kind": d.kind, "ops": d.ops()}
                for k, d in self.fields.items()]

    def describe(self) -> str:
        """「这一页能按什么筛」的人话清单，进 400 的 message。"""
        return "、".join(f"{d.label}（{k}）" for k, d in self.fields.items())

    def parse(self, raw: Any) -> Any:
        """页面入参里的 `filter`（JSON 串或对象）→ **单个** SQL 谓词。

        调用方把它和可见性谓词并排写进**同一个** `.where(...)`（SQLAlchemy 多个 where
        参数是 AND，OR 条件组因此关在自己的括号里）。返回单个元素就是为了让它铺不开：
        逐条 `.where()` 会把用户勾的「或」静默变成「且」，界面上还一切正常
        （`shared/filters.py` 模块 docstring 那条）。

        两类失败都转 400 且**带上本页可筛清单**（`describe()`）：字段名是后端定的，
        用户看不见，只说「不合法」等于让人猜。绝不降级成「忽略这条继续查」——那会返回
        没筛过的全量结果，而用户以为筛过了。
        """
        try:
            return build_conditions(parse_filter_json(raw), self.specs())
        except BadFilter as e:
            raise ApiError("bad_filter", f"高级搜索条件不合法：{e}；本页可筛：{self.describe()}",
                           400, {"view_type": self.view_type}) from e


_REGISTRY: dict[str, ListViewFilter] = {}


def register(entry: ListViewFilter) -> None:
    """登记一个页面的可筛面。

    重复登记**当场炸**而不是覆盖：两页同名时后 import 的那份静默替掉前一份，表现为
    「另一个页面的筛选忽然全不认了」——那种 bug 要把两个模块都读一遍才找得出来。
    """
    if entry.view_type in _REGISTRY:
        raise ValueError(f"页面可筛面重复登记：{entry.view_type}")
    _REGISTRY[entry.view_type] = entry


def get_entry(view_type: str) -> ListViewFilter:
    """取某页的可筛面；未登记的页面 → `BadFilter`（调用方转 400，不静默放行）。"""
    try:
        return _REGISTRY[view_type]
    except KeyError:
        raise BadFilter(
            f"页面 {view_type!r} 不支持高级搜索，已支持：{view_types()}") from None


def view_types() -> list[str]:
    return sorted(_REGISTRY)


def parse_filter_json(raw: Any) -> Any:
    """GET query 里的 `filter` 参数（JSON 串，或已是对象）→ 条件对象；空 → None。

    为什么是 JSON 串而不是嵌套模型：`_add_route` 的 GET 分支把入参模型的每个字段
    **原样铺成 query 参数**（app/core/service.py:384-390），HTTP query 装不下嵌套对象。
    列表端点不能因为要带条件就改成 POST——GET 列表是这一仓的取数契约（同一套游标分页、
    同一套缓存语义、前端 client.ts 的 GET 分支），为一个筛选参数换方法是拿契约换 UI。

    解析失败**必须抛，不许当成「没筛选」**：把坏条件当空条件，用户看到的是一页全量结果，
    而他以为筛过了——筛选项说谎，同 `_like` 那条轴。
    """
    if raw is None:
        return None
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        if not raw.strip():
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as e:
            raise BadFilter(f"filter 参数不是合法 JSON：{e.msg}") from e
        if not isinstance(parsed, dict):
            raise BadFilter(f"filter 参数必须是 JSON 对象，收到 {type(parsed).__name__}")
        return parsed
    raise BadFilter(f"filter 参数只能是 JSON 对象或其字符串形式，收到 {type(raw).__name__}")
