"""1F T1 · 读类元工具三件（§6.2 `:540` 清单里的读/盘点三件，R150/D34）。

三件都住 composition 层（agent 是编排模块，R26「可正向读取领域模块」）：
正向 import 领域 models 与 `app/modules/search/` 同构——契约 1 的独立清单不含 agent，
契约 3 防的是「领域模块认识 agent」，方向相反，两条天然保住。

为什么可见性与转义都走现成的尺而不是自己造（R150 原文）：
- 可见性 = `shared/visibility.visible_clause`（回收不可见 + 私有可见性一把尺），
  各自造谓词早晚分叉出「Ctrl+K 看得见、Pilot 看不见」的口径债；
- LIKE 转义直接 import `search.services._like`：同一个函数，不是「同款实现」——
  "100%" / "a_b" 必须按字面匹配，两份实现迟早漂移。

D34 的诚实标注（一期只有关键词路）：`search_test_assets` 返回 `meta.mode="keyword"`，
docstring 与 meta 都说「只有关键词路」，不装 §6.2 目标态的双路混合。

越权口径：三件都 `ensure_project_access`（带 project_id 的两件）+ `ctx.require(perm)`，
与 search 同码——非成员/不存在项目同一 403「无此项目权限」，不泄露存在性。
"""
from __future__ import annotations

from math import ceil
from typing import Any

from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.errors import ApiError
from app.core.registry import REGISTRY
from app.core.service import ServiceCtx, ensure_project_access
from app.modules.adb_test.models import AdbCase, AdbModule
from app.modules.agent.metatools.spec import (
    REAL_HANDLERS,
    GetProjectOutlineIn,
    SearchTestAssetsIn,
    SearchToolsIn,
)
from app.modules.api_test.models import ApiCase, ApiDefinition, ApiModule
from app.modules.scenario.models import Scenario, ScenarioModule
from app.modules.search.services import _like  # 同一把转义尺，不是同款实现（R150）
from app.modules.ui_test.models import UiCase, UiElement, UiModule
from app.shared.visibility import visible_clause

# 单次返回的行数上限：给模型吃的是摘要形状，不是全量列表（§9.2「结果整形」）
ROW_LIMIT = 30
# ≤2k token 口径：中英混排 1 token ≈ 2 字符（CJK≈1 字/token、ASCII≈4 字符/token 取中值，
# 偏保守）→ 2000 token 折算 4000 字符。估算是估算（未实测），所以它进 meta 可被核对。
TOKEN_BUDGET = 2000
CHAR_BUDGET = 4000
# 模块树装填的行数护栏（节点小，预算先到的是字符数；行数只是防病态树的下限护栏）
MODULE_ROW_LIMIT = 500

# —— 词表：kind 用 workbench AssetCounts 的名字（不是 Ctrl+K 的 definition/case 那套
# UI 分组名），因为本模块的计数要和 workbench 交叉对账，一套词表少一次翻译错。
KIND_ORDER: tuple[str, ...] = (
    "api_definition", "api_case", "scenario", "ui_element", "ui_case", "adb_case",
)


class AssetHit(BaseModel):
    id: str
    kind: str
    name: str
    module_id: str | None = None
    method: str | None = None
    path: str | None = None
    priority: str | None = None
    definition_name: str | None = None


class SearchAssetsMeta(BaseModel):
    # D34：一期只有 MySQL LIKE 关键词路——mode 明写 keyword，不装双路
    mode: str = "keyword"
    limit: int = ROW_LIMIT
    returned: int = 0
    truncated: bool = False
    # module 收窄是否命中了真实模块（没命中=空结果，且如实说明「不是没资产，是模块不存在」）
    module_matched: bool | None = None


class SearchTestAssetsOut(BaseModel):
    items: list[AssetHit] = []
    meta: SearchAssetsMeta = SearchAssetsMeta()


class ToolDecl(BaseModel):
    name: str
    description: str
    perm: str
    effect: str
    resident: bool
    json_schema: dict[str, Any]


class SearchToolsMeta(BaseModel):
    mode: str = "keyword"
    limit: int = ROW_LIMIT
    total_matched: int = 0
    returned: int = 0
    truncated: bool = False


class SearchToolsOut(BaseModel):
    items: list[ToolDecl] = []
    meta: SearchToolsMeta = SearchToolsMeta()


class OutlineModuleNode(BaseModel):
    id: str
    name: str
    tree: str  # api | scenario | ui | adb（四棵独立的树，§11.5 各自一棵）
    parent_id: str | None = None
    path: str = ""


class OutlineMeta(BaseModel):
    """截断口径全部在这里可观测（不许静默截断）。"""

    # 口径见模块常量：1 token ≈ 2 字符的保守估算折算（未实测，是估算不是分词器）
    token_budget: int = TOKEN_BUDGET
    char_budget: int = CHAR_BUDGET
    chars_used: int = 0
    approx_tokens: int = 0
    modules_total: int = 0
    modules_returned: int = 0
    modules_cut: int = 0
    truncated: bool = False
    assets_complete: bool = True  # 计数是聚合值，永不截断


class ProjectOutlineOut(BaseModel):
    project_id: str
    # kind → 可见且非回收的件数（口径逐字对齐 workbench.services.AssetCounts）
    assets: dict[str, int] = {}
    modules: list[OutlineModuleNode] = []
    meta: OutlineMeta = OutlineMeta()


_MOD_TREES: tuple[tuple[str, Any], ...] = (
    ("api", ApiModule), ("scenario", ScenarioModule), ("ui", UiModule), ("adb", AdbModule),
)

# 计数口径 = workbench.services 的 _asset_count 逐字同款：project + 非回收 + visible_clause。
# （workbench 不数 ui_element——AssetCounts 没这一列；outline 多数的一类不影响
# 五类交集的交叉断言，测试只断交集。）
_COUNT_MODELS: tuple[tuple[str, Any], ...] = (
    ("api_definition", ApiDefinition), ("api_case", ApiCase), ("scenario", Scenario),
    ("ui_element", UiElement), ("ui_case", UiCase), ("adb_case", AdbCase),
)


async def _visible_count(db, ctx, project_id: str, model) -> int:
    stmt = select(func.count()).select_from(model).where(
        model.project_id == project_id, model.status != "recycled",
        visible_clause(model, ctx))
    return int((await db.execute(stmt)).scalar_one())


def _module_paths(rows: list[tuple[str, str, str | None, str]]) -> list[OutlineModuleNode]:
    """rows=(id,name,parent_id,tree) → 带路径的节点。

    路径 = 祖先名拼接（环防御：遇环截断，脏数据不许把 outline 拖进死循环）。
    """
    by_id = {r[0]: r for r in rows}

    def path_of(mid: str) -> str:
        parts: list[str] = []
        seen: set[str] = set()
        cur: str | None = mid
        while cur in by_id and cur not in seen:
            seen.add(cur)
            parts.append(by_id[cur][1])
            cur = by_id[cur][2]
        return "/".join(reversed(parts))

    return [OutlineModuleNode(id=i, name=n, tree=tree, parent_id=p, path=path_of(i))
            for i, n, p, tree in rows]


def _fit_modules(nodes: list[OutlineModuleNode], char_budget: int,
                 row_limit: int) -> tuple[list[OutlineModuleNode], int]:
    """按序装填直到字符预算/行数上限：返回 (留下节点, 估算字符数)。截断可观测。"""
    kept: list[OutlineModuleNode] = []
    used = 0
    for n in nodes:
        cost = len(n.path) + len(n.name) + 48  # 48 ≈ 每节点 JSON 骨架常量（id/树名/引号）
        if kept and (used + cost > char_budget or len(kept) >= row_limit):
            break
        kept.append(n)
        used += cost
    return kept, used


async def get_project_outline(payload: GetProjectOutlineIn, ctx: ServiceCtx) -> ProjectOutlineOut:
    """项目模块树 + 各类资产计数摘要（§6.2 `:540` get_project_outline）。

    ≤2k token 截断口径（可观测，不静默）：预算按 **1 token ≈ 2 字符** 的保守估算折算成
    char_budget=4000 字符（CJK≈1 字/token、ASCII≈4 字符/token 取中值；是估算口径不是
    分词器实测——「未实测」写在这，不许当成量过）。装填按 (树名, 路径) 稳定序，
    装不下即停：meta.modules_cut 报被切掉的节点数、meta.truncated 报有无、
    meta.chars_used/approx_tokens 报实际用量。计数是 SQL 聚合值，永不截断
    （assets_complete 恒 True，这是承诺不是摆设）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("agent:meta:read")
    assert ctx.db is not None
    db = ctx.db
    pid = payload.project_id

    assets = {kind: await _visible_count(db, ctx, pid, model) for kind, model in _COUNT_MODELS}

    rows: list[tuple[str, str, str | None, str]] = []  # (id, name, parent_id, tree)
    for tree, model in _MOD_TREES:
        found = (await db.execute(
            select(model.id, model.name, model.parent_id)
            .where(model.project_id == pid, model.status != "recycled")
            .order_by(model.sort, model.name, model.id)
        )).all()
        rows.extend((r[0], r[1], r[2], tree) for r in found)
    # 稳定序：树名 → 名 → id（跨树排序不依赖 DB 方言的中文 collation）
    rows.sort(key=lambda r: (r[3], r[1], r[0]))
    nodes = _module_paths(rows)
    # 路径排序（父在子前，深度优先的可读形状）
    nodes.sort(key=lambda n: (n.tree, n.path))
    kept, used = _fit_modules(nodes, CHAR_BUDGET, MODULE_ROW_LIMIT)
    meta = OutlineMeta(
        chars_used=used, approx_tokens=ceil(used / 2),
        modules_total=len(nodes), modules_returned=len(kept),
        modules_cut=len(nodes) - len(kept),
        truncated=len(kept) < len(nodes),
    )
    return ProjectOutlineOut(project_id=pid, assets=assets, modules=kept, meta=meta)


async def search_test_assets(payload: SearchTestAssetsIn, ctx: ServiceCtx) -> SearchTestAssetsOut:
    """按关键词跨模块检索测试资产（§6.2 `:540` / R150 / D34）。

    独立服务面、共享谓词：与 Ctrl+K 的 search_assets 权限语义不同（本工具给模型吃
    ≤2k token 摘要形状 + kind/module 收窄），但可见性用同一把 `visible_clause`、
    LIKE 转义 import 同一个 `_like` 函数——回收不可见、私有不可见、"100%"/"a_b"
    字面匹配，与 Ctrl+K 口径逐字一致（分叉就是口径债）。

    D34 诚实标注：一期只有关键词路（MySQL LIKE），`meta.mode="keyword"`——
    §9.10 `:683` 的降级条款就是本期交付态，不装 §6.2 的双路混合。
    module 收窄 = 该棵模块树内子树命中（含未分类除外——模块 id 精确匹配其下资产）；
    模块 id 不存在 → 空结果 + module_matched=False（如实说「模块没找到」）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("agent:meta:read")
    assert ctx.db is not None
    db = ctx.db
    pid = payload.project_id
    # 无关键词 = 盘点式列出（各类前 N 条）；有关键词走同一把转义 LIKE
    keyword = payload.keyword.strip() if payload.keyword else None
    like = _like(keyword) if keyword else None
    want = {payload.kind} if payload.kind else set(KIND_ORDER)

    module_matched: bool | None = None
    if payload.module:
        matched = False
        for _, model in _MOD_TREES:
            hit = (await db.execute(select(model.id).where(
                model.project_id == pid, model.id == payload.module))).first()
            if hit is not None:
                matched = True
                break
        module_matched = matched
        if not matched:
            return SearchTestAssetsOut(meta=SearchAssetsMeta(module_matched=False))

    items: list[AssetHit] = []
    total = 0
    kind_models = dict(_COUNT_MODELS)
    for kind in KIND_ORDER:
        if kind not in want:
            continue
        remainder = ROW_LIMIT - len(items)  # 全局预算：后面的 kind 不得挤爆 ≤2k 摘要形状
        model = kind_models[kind]
        if kind == "api_case":
            # 可达性跟定义走（search/assert_def_alive 同尺）：定义回收则其 normal 用例
            # 整体不可搜；module 收窄经定义走——ApiCase 行自己没有 module_id 列。
            stmt = (select(ApiCase, ApiDefinition.name)
                    .join(ApiDefinition, ApiDefinition.id == ApiCase.definition_id)
                    .where(ApiCase.project_id == pid, ApiCase.status == "normal",
                           ApiDefinition.status != "recycled", visible_clause(ApiCase, ctx)))
            if payload.module:
                stmt = stmt.where(ApiDefinition.module_id == payload.module)
            if like is not None:
                stmt = stmt.where(like(ApiCase.name))
            pairs = (await db.execute(stmt.order_by(ApiCase.id).limit(remainder + 1))).all()
            total += len(pairs)
            for c, dname in pairs[:remainder]:
                items.append(AssetHit(id=c.id, kind=kind, name=c.name, priority=c.priority,
                                      definition_name=dname))
            continue
        stmt = select(model).where(model.project_id == pid, model.status != "recycled",
                                   visible_clause(model, ctx))
        if payload.module:
            stmt = stmt.where(model.module_id == payload.module)
        if like is not None:
            cond = like(model.name)
            if kind == "api_definition":
                cond = cond | like(model.path)  # 定义按 name+path 双列命中（Ctrl+K 同尺）
            stmt = stmt.where(cond)
        rows = (await db.execute(
            stmt.order_by(model.id).limit(remainder + 1))).scalars().all()
        total += len(rows)
        for r in rows[:remainder]:
            # getattr：api_case 走上面的 join 分支（行上没有 module_id 列），
            # 其余五类都有；循环里 model 是异质元组，按列存在性取值。
            items.append(AssetHit(id=r.id, kind=kind, name=r.name,
                                  module_id=getattr(r, "module_id", None),
                                  method=getattr(r, "method", None),
                                  path=getattr(r, "path", None),
                                  priority=getattr(r, "priority", None)))

    return SearchTestAssetsOut(
        items=items,
        meta=SearchAssetsMeta(returned=len(items), truncated=total > len(items),
                              module_matched=module_matched))


async def search_tools(payload: SearchToolsIn, ctx: ServiceCtx) -> SearchToolsOut:
    """按关键词检索工具声明子集（§9.2 `:542` 分组级发现的一期最小实现）。

    扫 REGISTRY、按 名字/描述 关键词（大小写不敏感的子串，同一把 `_like` 转义尺在
    内存里等价于小写包含）回声明 JSON 子集——供模型「当轮载入」，不做上下文注入魔法。
    权限过滤走 `REGISTRY.list_tools(ctx.perms)` 现成语义：caller 权限位吃不到的工具
    声明根本不出现在候选池（READONLY 看不到写工具声明，§9.4）。
    """
    kw = payload.keyword.strip().lower()
    if not kw:
        # SearchToolsIn 的 min_length 挡不住全空白（与 Ctrl+K 的 _blank 校验同款坑）：
        # 空白词请求全部声明 = 越权撑爆上下文，422 拒回让人/模型都看见原因。
        raise ApiError("validation_failed", "工具检索关键词不能为空白", 422)
    # search_tools 本身不带 project_id，但权限位仍要过（dispatcher 已挡，直调路径也挡）
    ctx.require("agent:meta:read")
    candidates = [t for t in REGISTRY.list_tools(ctx.perms)
                  if kw in t.name.lower() or kw in t.description.lower()]
    total = len(candidates)
    items = [ToolDecl(name=t.name, description=t.description, perm=t.perm,
                      effect=t.effect, resident=t.resident,
                      json_schema=t.json_schema)
             for t in candidates[:ROW_LIMIT]]
    return SearchToolsOut(
        items=items,
        meta=SearchToolsMeta(total_matched=total, returned=len(items),
                             truncated=total > len(items)))


# —— 回填登记（T1 的接线点）：把三个真 handler 按名字交给 spec.REAL_HANDLERS，
# register_metatools() 装配时按名字取用；未登记的（卡片五件，T2 的活）继续吃骨架。
# 本模块绝不 import spec.REAL_HANDLERS 之外的注册机制——注册面仍然只有 spec 一个出口。
def register_read_handlers() -> None:
    REAL_HANDLERS.setdefault("get_project_outline", get_project_outline)
    REAL_HANDLERS.setdefault("search_test_assets", search_test_assets)
    REAL_HANDLERS.setdefault("search_tools", search_tools)


register_read_handlers()
