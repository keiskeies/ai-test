"""1F T0 元工具层骨架钉：手写注册 + 权限位 + 结构扫描 + 1E 边界防御。

四个门（1F 计划 T0 checkbox 逐条对账）：
① 结构钉——metatools/*.py 里 @service 字面量计数为 0（R146：改回装饰器 = 蓝图回退）；
② 权限位——REGISTRY.perm_points() 含 agent:meta:read / agent:plan:write（启动同步入库吃到）；
③ 重名自检——REGISTRY.register 撞名即 RuntimeError（与 @service 同池，红在 CI 不炸启动）；
④ 边界例——app/modules/agent/** 零 import schedule/notify（1E 在飞的防御）。
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest
from pydantic import BaseModel

from app.core.registry import REGISTRY, ToolSpec
from app.core.service import ServiceCtx
from app.modules.agent.metatools import META_TOOL_NAMES, register_metatools

BACKEND_ROOT = Path(__file__).resolve().parents[1]
METATOOLS_DIR = BACKEND_ROOT / "app" / "modules" / "agent" / "metatools"
AGENT_DIR = BACKEND_ROOT / "app" / "modules" / "agent"

# 装饰器的字面量在测试里拼出来：本测试文件也归 app/ 之外的 tests/ 扫不到，
# 但保持「仓库里这个字面量只出现在装饰器真实用法处」的 grep 直觉，方便人肉复核。
SERVICE_DECORATOR = "@" + "service"


def _metatool_sources() -> list[Path]:
    files = sorted(METATOOLS_DIR.glob("*.py"))
    assert files, "metatools 包必须存在且含 .py 源文件（骨架被删了？)"
    return files


def test_metatools_registered() -> None:
    """import 包即注册：八个 spec 全体在场，且落在同一个 REGISTRY（与 @service 同池）。"""
    for name in META_TOOL_NAMES:
        assert REGISTRY.get(name) is not None, f"元工具 {name} 未注册"


def test_no_service_decorator_in_metatools() -> None:
    """结构钉（R146 的账）：metatools/*.py 里 @service 字面量计数恒为 0。

    这是源码扫描不是运行时断言——运行时两者注册出的 ToolSpec 同形，抓不回退；
    只有扫源码能钉住「手写注册」这个蓝图口径本身（§6.2 `:540`「手写,非 service」）。
    """
    hits: dict[str, int] = {}
    for f in _metatool_sources():
        n = f.read_text(encoding="utf-8").count(SERVICE_DECORATOR)
        if n:
            hits[f.name] = n
    assert hits == {}, f"metatools 出现装饰器注册（蓝图口径回退）：{hits}"


def test_r146_spec_shape() -> None:
    """R146 形状钉：http=None / tool=True / resident=True / effect=read。"""
    for name in META_TOOL_NAMES:
        spec = REGISTRY.get(name)
        assert spec is not None
        assert spec.http is None, f"{name} 不得有 HTTP 面"
        assert spec.tool is True and spec.resident is True
        assert spec.effect == "read", f"{name} 元工具不落业务数据（D31）"
        assert isinstance(spec.json_schema, dict) and spec.json_schema != {}
        assert spec.model.model_json_schema() == spec.json_schema


def test_perm_points_contain_meta_bits() -> None:
    """两位权限点进 perm_points()——启动 sync_perm_points 入库才吃得到（§15 纪律 7）。"""
    pts = REGISTRY.perm_points()
    assert "agent:meta:read" in pts
    assert "agent:plan:write" in pts
    for name in META_TOOL_NAMES:
        spec = REGISTRY.get(name)
        assert spec is not None
        assert spec.perm in {"agent:meta:read", "agent:plan:write"}


def test_duplicate_registration_raises() -> None:
    """重名即抛（registry 现成机制）：喂一个撞名的 spec，元工具与 @service 同池要红在 CI。"""

    class _DupIn(BaseModel):
        project_id: str

    async def dup_handler(payload: _DupIn, ctx: ServiceCtx) -> None:
        return None

    with pytest.raises(RuntimeError):
        REGISTRY.register(
            ToolSpec(
                name="search_tools", description="撞名测试", json_schema={},
                perm="agent:meta:read", effect="read", handler=dup_handler,
                model=_DupIn, tool=True, resident=True, http=None,
            )
        )


def test_register_metatools_is_idempotent_for_self() -> None:
    """本包自守卫只挡自身重入（装配路径二次 import 不该炸）；真撞名照抛（上一例钉的）。"""
    register_metatools()  # 不抛 = 幂等
    assert all(REGISTRY.get(n) for n in META_TOOL_NAMES)


# —— 边界例：agent 零 import schedule/notify（1E 在飞的防御）——
# 扫描走 ast 解析真 import 语句，不扫原文——原文匹配会被注释/docstring 里的解释性
# 文字误伤（本仓库被「自己的说明注释把检查扫红」坑过），也只认 app.modules.schedule
# / app.modules.notify 及其子模块、`from app.modules import schedule` 的绑定名。

_FORBIDDEN_PKGS = ("schedule", "notify")


def _imported_module_nodes(tree: ast.AST) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            out.add(node.module)
            # from app.modules import schedule → 绑定名也是模块引用
            if node.module == "app.modules":
                out.update(f"app.modules.{a.name}" for a in node.names)
    return out


def test_agent_never_imports_schedule_or_notify() -> None:
    """1F/1E 边界钉：app/modules/agent/** 的任何 .py 不得 import 这两个模块。"""
    offenders: list[str] = []
    py_files = sorted(AGENT_DIR.rglob("*.py"))
    assert len(py_files) >= 5, "agent 包源码集异常（扫描根错了？）"
    for f in py_files:
        rel = f.relative_to(BACKEND_ROOT).as_posix()
        if "__pycache__" in rel:
            continue
        tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
        for mod in _imported_module_nodes(tree):
            m = re.match(r"app\.modules\.(\w+)", mod)
            if m and m.group(1) in _FORBIDDEN_PKGS:
                offenders.append(f"{rel} -> {mod}")
    assert offenders == [], f"agent 反向认识 1E 领地（边界例先红先说）：{offenders}"
