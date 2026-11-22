"""jsonpath 点路径子集（§7.1 断言/提取够用即可；不引第三方库——1A 全局约束）。

支持：$ 根、.key、[key]、[引号包裹的任意键（可含空格）]、[int]。缺段/语法不认/类型不符抛 JsonPathMissing（不是 500）。
"""
from __future__ import annotations

from typing import Any

QUOTES = chr(39) + chr(34)  # 单双引号都接受


class JsonPathMissing(Exception):
    """路径在数据中不存在或表达式不合法。"""

    def __init__(self, path: str) -> None:
        super().__init__("路径不存在: " + path)
        self.path = path


def _segments(expr: str) -> list:
    s = expr.strip()
    if not s.startswith("$"):
        raise JsonPathMissing(expr)
    segs: list = []
    i, n = 1, len(s)
    while i < n:
        ch = s[i]
        if ch == ".":
            j = i + 1
            while j < n and (s[j].isalnum() or s[j] == "_"):
                j += 1
            if j == i + 1:
                raise JsonPathMissing(expr)
            segs.append(s[i + 1:j])
            i = j
        elif ch == "[":
            j = i + 1
            if j < n and s[j] in QUOTES:
                q = s[j]
                k = s.find(q, j + 1)
                close = s.find("]", k + 1) if k > 0 else -1
                if k < 0 or close < 0:
                    raise JsonPathMissing(expr)
                segs.append(s[j + 1:k])
                i = close + 1
            else:
                k = s.find("]", j)
                if k < 0:
                    raise JsonPathMissing(expr)
                body = s[j:k].strip()
                neg = body.startswith("-")
                digits = body[1:] if neg else body
                if not digits.isdigit():
                    raise JsonPathMissing(expr)
                segs.append(-int(digits) if neg else int(digits))
                i = k + 1
        else:
            raise JsonPathMissing(expr)
    return segs


def jsonpath_get(data: Any, expr: str) -> Any:
    cur = data
    for seg in _segments(expr):
        if isinstance(seg, int):
            if not isinstance(cur, list) or seg >= len(cur) or seg < -len(cur):
                raise JsonPathMissing(expr)
            cur = cur[seg]
        else:
            if not isinstance(cur, dict) or seg not in cur:
                raise JsonPathMissing(expr)
            cur = cur[seg]
    return cur