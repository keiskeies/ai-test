"""1F 元工具层（蓝图 §6.2 `:540`「手写,非 service」，R146）。

本包绕开 core/service.py 的 `service` 装饰器，直接对 REGISTRY 手写 ToolSpec 注册：
五路同生是装饰器的实现手段不是目的，元工具要的三路（工具 schema / 权限位 / 审计）
全部由 REGISTRY.register(ToolSpec(...)) 本身携带（1F 计划取证 ④），不要的两路
（HTTP 路由 / OpenAPI）用 http=None 天然关闭（service.py 的 build_router 挡 http=None，
所以元工具无 HTTP 面）。

结构钉（防假门第一道，tests/test_agent_metatools.py）：本包 *.py 里装饰器注册的字面量
出现次数必须为 0——把元工具改回装饰器注册是蓝图口径回退，不是优化。
因此本包所有注释/文档一律写「service 装饰器」，绝不写带 at 符号的那个字面量
（结构钉扫的是原文字面量，说明注释 itself 也会被扫到——假红先例在前，防自己比防贼要紧）。

import 即注册：main.py 装配清单 import 本包触发 register_metatools()，
与 service 装饰器的 import-时注册同机制，只是手写调用点。
"""
from __future__ import annotations

from app.modules.agent.metatools import (
    card_tools,  # noqa: F401  T2 五件真 handler 自登记
    read_tools,  # noqa: F401  T1 三件真 handler 自登记
)
from app.modules.agent.metatools.spec import META_TOOL_NAMES, register_metatools

# 顺序即契约：先 import 实现模块（read_tools/card_tools 各自触发自登记填 REAL_HANDLERS），
# 再 register_metatools()——_spec 装配时按名字取真 handler，取不到才是骨架。
register_metatools()

__all__ = ["META_TOOL_NAMES", "register_metatools"]
