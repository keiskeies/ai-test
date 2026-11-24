"""逗号串标签列的读写助手（D283 起功能用例/场景/计划共用）。

存法沿用 `defect.tags` / `api_definition.tags`：一个可空字符串列，逗号分隔、
去重保序、空 = 无标签。**不是中央标签字典**——标签由使用中产生；精确筛选走
`FIND_IN_SET`（列表的顶层 `tag` 参数），不用 LIKE（会把 bug1 命中 bug10）。

为什么不把 defect/filelib 的历史实现也搬过来：它们的去空白/长度口径各有
差异（defect 不去空白、filelib 不卡长度），改动是行为变更，不属于本刀；
新代码统一走这里（D283 顺手把口径本就一致的 api_test 局部实现切到本模块）。
"""
from __future__ import annotations

from app.core.errors import ApiError


def split_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [t for t in (x.strip() for x in raw.split(",")) if t]


def join_tags(tags: list[str] | None, *, label: str = "标签", max_len: int = 1000) -> str | None:
    """去空白、去空项、去重保序后拼串；空列表 = None（不存 ""）。

    超长直接 422：列是 String(1000)，放给数据库会在严格模式下抛 1406（500）。
    """
    if not tags:
        return None
    seen: list[str] = []
    for t in tags:
        v = (t or "").strip()
        if v and v not in seen:
            seen.append(v)
    if not seen:
        return None
    joined = ",".join(seen)
    if len(joined) > max_len:
        raise ApiError("validation_failed", f"{label}过长（合计最多 {max_len} 字符）", 422,
                       {"tags": joined[:50] + "…"})
    return joined
