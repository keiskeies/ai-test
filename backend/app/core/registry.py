"""工具注册表：@service 标注后五路同生的「单一真相」。

ToolSpec = 一个 service 函数在全系统的元数据：
- HTTP 路由（http 非 None 时，build_router 生成）
- OpenAPI（FastAPI 自动）
- Agent 工具 schema（json_schema，给模型 function calling）
- 权限位（perm，鉴权唯一入口 match_perm）
- 审计（audit 中间层按 effect 记录，见 T8）
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel

from app.core.permissions import match_perm

Effect = Literal["read", "write", "destructive"]


@dataclass
class ToolSpec:
    name: str                      # 稳定 snake_case 全局唯一 = Agent 工具名
    description: str
    json_schema: dict[str, Any]
    perm: str                      # 权限点，如 project:create
    effect: Effect
    handler: Callable[..., Awaitable[Any]]
    model: type[BaseModel]
    tool: bool = True              # 是否暴露为 Agent 工具
    resident: bool = False         # 常驻工具（compact 后仍在场）
    http: dict[str, Any] | None = None  # {method, path, tags, status}
    dynamic_perm: bool = False  # D164：perm 仅投影占位，钥匙执行时才定，路由/dispatcher 跳过静态门（体内 ctx.require 是唯一鉴权点）
    domain: str = field(default="")

    def __post_init__(self) -> None:
        if not self.domain:
            self.domain = self.perm.split(":")[0]


class ServiceRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        if spec.name in self._tools:
            raise RuntimeError(f"service 名称重复注册：{spec.name}")
        self._tools[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def all(self) -> list[ToolSpec]:
        return list(self._tools.values())

    def list_tools(self, perms: set[str] | None) -> list[ToolSpec]:
        """按权限位过滤 Agent 工具声明（READONLY 用户不见写工具 → §9.4）。"""
        out = []
        for t in self._tools.values():
            if not t.tool:
                continue
            if perms is None or match_perm(perms, t.perm):
                out.append(t)
        return sorted(out, key=lambda t: t.name)

    def perm_points(self) -> set[str]:
        return {t.perm for t in self._tools.values()}


REGISTRY = ServiceRegistry()
