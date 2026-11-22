"""变量模板 `${var}` 渲染 + 分层合并（§7.5）。

快败语义：未定义变量抛 MissingVar（不静默留空）——调试/执行入口统一转 422。
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

_PAT = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class MissingVar(Exception):
    """模板引用了未定义变量。"""

    def __init__(self, name: str) -> None:
        super().__init__("未定义变量: ${" + name + "}")
        self.name = name


def render(text: str, variables: Mapping[str, str]) -> str:
    def rep(m: re.Match) -> str:
        key = m.group(1)
        if key not in variables:
            raise MissingVar(key)
        return str(variables[key])

    return _PAT.sub(rep, text)


def render_deep(obj: Any, variables: Mapping[str, str]) -> Any:
    """递归渲染 dict/list/tuple/str 内的所有 ${var}；返回新对象，不改入参。"""
    if isinstance(obj, str):
        return render(obj, variables)
    if isinstance(obj, Mapping):
        return {k: render_deep(v, variables) for k, v in obj.items()}
    if isinstance(obj, list):
        return [render_deep(v, variables) for v in obj]
    if isinstance(obj, tuple):
        return tuple(render_deep(v, variables) for v in obj)
    return obj


def merge_vars(*layers: Mapping[str, str] | None) -> dict[str, str]:
    """后层覆盖前层（调用方按 全局→环境→用例→数据集行→调试临时 的顺序传层）。"""
    out: dict[str, str] = {}
    for layer in layers:
        for k, v in (layer or {}).items():
            out[str(k)] = str(v)
    return out
