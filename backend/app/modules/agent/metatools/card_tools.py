"""1F T2 · 卡片/计划型元工具五件（§9.7 `:600-607` 卡片型工具，R148/D31/D32/D36）。

形状（§12.2 `:1570` 信封逐字对齐）：handler 返回 `{ui:"card", card:{kind, ...}}`，
dispatcher 从返回 dict 里提取 ui 进 ToolResult.ui，runner 落 TOOL_RESULT 事件时
`payload.ui` + `payload.content.card` 同源带出——REST 重放与 SSE 读同一事件，
卡片透传免费覆盖断线重连/历史回放（R148）。

三条硬口径：
- **graph 先过 scenario/graph.py 的结构校验再出卡**（取证 ⑨：validate/iter_nodes 复用，
  画布保存与卡片同一把尺）——非法图 ok=False 带人话 error 回注模型自纠，
  绝不把野 JSON 递给画布（纪律 1：画布炸给业主看是假功能的另一种形状）；
- **payload 自包含**（§13 `:1599` 一期卡片条款 / R147 零迁移承诺）：步骤预览 +
  资产 id/名内联，前端零二次查询；`scenario_draft` 是二期表，这里没有任何落库口子；
- **ui 值域在出口断言**：ui ∈ {None,"card","approval","diff"}，越界直接抛——
  协议违反回注模型救不了（模型不知道该修协议常量），必须红在代码里。

D32：ask_user 不挂起运行——落卡后本轮照常走完（run 边界干净），
用户点选项回写为新用户消息（R149 同路），不建 WAIT_USER 态。
D36：propose_plan/update_plan_item 渲染为事件流内的 generic/plan_list 计划列表卡，
「原地更新」= 前端合流层按最新一条 plan_list 覆盖渲染（fold.ts），后端配套：
update_plan_item 只有 (id,state) 两个参数，完整 items 来自进程内会话槽位
（agent run 与工具执行同进程；服务重启后槽位丢失 → ok=False 说「先 propose_plan」，
宁抛不装）。

route 白名单：值逐字抄自 `web/src/layout/shell.tsx` 现行导航真值（MENU 里带 to 的
全部路径）——「界面能配、跳了 404」是纪律 1 的假功能形状，白名单外 ok=False。
"""
from __future__ import annotations

import copy
from typing import Any

from sqlalchemy import select

from app.core.errors import ApiError
from app.core.service import ServiceCtx, ensure_project_access
from app.modules.adb_test.models import AdbCase
from app.modules.agent.metatools.spec import (
    PLAN_WRITE_PERM,
    REAL_HANDLERS,
    AskUserIn,
    ProposePlanIn,
    ProposeScenarioPlansIn,
    SuggestOpenPageIn,
    UpdatePlanItemIn,
)
from app.modules.api_test.models import ApiCase
from app.modules.scenario import graph as scenario_graph
from app.modules.ui_test.models import UiCase
from app.shared.visibility import visible_clause

# kind 值域与蓝图 §12.2 `:1570` 逐字对齐（单测钉枚举集合相等，防手滑改名）；
# report_summary/device_status 是后续批次的卡（1F 只保证枚举在场，不做渲染器）。
CARD_KINDS: frozenset[str] = frozenset({"scenario_plans", "report_summary", "device_status", "generic"})
# §12.2 `:1570`：tool_result.payload.ui 值域。None=普通结果；approval=审批卡（二期门）。
UI_KINDS: frozenset[str | None] = frozenset({None, "card", "approval", "diff"})
PLAN_ITEM_STATES: frozenset[str] = frozenset({"pending", "doing", "done", "skipped"})

# route 白名单：web/src/layout/shell.tsx MENU 里带 to 的导航真值（1F T2 抄录时点）。
# 详情类路由（/scene/:id 等）不在表内：params 走查询串（前端 OpenPageCard 拼接），
# 拼不进路径段——放进来就是「跳了 404」的假门预备役。
OPEN_PAGE_ROUTES: tuple[str, ...] = (
    "/",  # 项目与工作台
    "/bench",  # Pilot 试验台
    "/api",  # 接口管理
    "/scene",  # 场景编排
    "/datasets",  # 数据集
    "/ui/elements",  # 元素库
    "/ui/cases",  # UI 用例
    "/adb/devices",  # 设备管理
    "/adb/cases",  # ADB 用例
    "/runs",  # 运行记录
    "/reports",  # 报告中心
    "/settings",  # 项目与成员
    "/notify/channels",  # 通知渠道
    "/schedules",  # 定时任务（1e/schedules 落地：shell.tsx nav-cron 已带 to，白名单必须跟）
)

# graph 引用类 kind → 资产模型（ref 必须解析到本项目内可见资产，id/名内联进 payload）
_REF_MODELS: dict[str, Any] = {"api_case": ApiCase, "ui_case": UiCase, "adb_case": AdbCase}


def _card(card: dict[str, Any], ui: str = "card") -> dict[str, Any]:
    """出卡唯一出口：kind 值域 + ui 值域双断言。

    越界 = 编程错误（协议常量被手滑改坏），直接抛——回注模型救不了协议违反，
    宁可 run 落 ERROR 让人看见，不许把坏信封混进事件流让前端兜底猜。
    """
    kind = card.get("kind")
    if kind not in CARD_KINDS:
        raise RuntimeError(f"卡片 kind 越界: {kind!r}（§12.2 值域: {sorted(CARD_KINDS)}）")
    if ui not in UI_KINDS:
        raise RuntimeError(f"ui 值域越界: {ui!r}（§12.2 :1570 值域: {sorted(str(x) for x in UI_KINDS)}）")
    return {"ui": ui, "card": card}


def _str_field(raw: dict[str, Any], key: str) -> str:
    """自由 JSON 字段收窄为 str（非 str/缺失一律 ""，由调用方按缺失报错）。"""
    v = raw.get(key)
    return v if isinstance(v, str) else ""


def _list_field(raw: dict[str, Any], key: str) -> list[Any]:
    v = raw.get(key)
    return v if isinstance(v, list) else []


async def propose_scenario_plans(payload: ProposeScenarioPlansIn, ctx: ServiceCtx) -> dict[str, Any]:
    """候选场景方案卡（§9.7 `:600-601`；每个 plan {name,intent,est_steps[],graph,env_hint,risks[]}）。

    出卡前逐方案过硬门（全部人话 error，回注模型自纠）：
    ① 方案数 ≥2（spec 描述自陈「≥2 候选」，单候选不叫「候选方案卡」）；
    ② 必填字段齐全（name/intent/est_steps/graph；env_hint/risks 可选）；
    ③ graph 过 scenario/graph.py validate()——与画布保存同一把尺（取证 ⑨）；
    ④ graph 里 api_case/ui_case/adb_case 的 ref 必须解析到本项目可见资产
       （visible_clause + 非回收，与 T1 检索同尺），并把资产名内联成 ref_name。
    一期边界（R147）：payload 自包含、零落库——scenario_draft 是二期表，
    「保存为正式场景」的口子在这里不存在（前端卡片上的保存钮恒 disabled 提示二期开放）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require(PLAN_WRITE_PERM)
    assert ctx.db is not None
    plans = payload.plans
    if len(plans) < 2:
        raise ApiError("validation_failed",
                       f"候选方案只有 {len(plans)} 个：卡片协议要求 ≥2 个候选供用户抉择"
                       "（§9.7 产出 1~3 个候选、卡片至少两个可选项）。请补充差异化方案后重调。", 422)
    out_plans: list[dict[str, Any]] = []
    for i, raw in enumerate(plans, start=1):
        tag = f"第 {i} 个候选方案"
        # 显式收窄：raw 是自由 JSON（dict[str, Any]），非 str/缺失一律折成 ""，由下方按缺失报错。
        name = _str_field(raw, "name")
        intent = _str_field(raw, "intent")
        est = raw.get("est_steps")
        graph = raw.get("graph")
        if not name.strip():
            raise ApiError("validation_failed", tag + "缺少 name（卡片标题，用户靠它区分候选）", 422)
        if not intent.strip():
            raise ApiError("validation_failed", f"候选方案「{name}」缺少 intent（覆盖意图，卡片必填）", 422)
        if not isinstance(est, list) or not est or any(not isinstance(s, str) or not s.strip() for s in est):
            raise ApiError("validation_failed",
                           f"候选方案「{name}」的 est_steps 必须是非空字符串列表（步骤预览，卡片正文）", 422)
        if not isinstance(graph, dict):
            raise ApiError("validation_failed",
                           f"候选方案「{name}」缺少 graph 或 graph 不是 JSON 对象（§7.4 步骤树形状）", 422)
        issues = scenario_graph.validate(graph)
        if issues:
            lines = "; ".join(str(x.get("message")) for x in issues[:5])
            more = f"（共 {len(issues)} 处，前 5 处如下）" if len(issues) > 5 else ""
            raise ApiError("validation_failed",
                           f"候选方案「{name}」的步骤图未通过结构校验{more}: {lines}。"
                           "请按 §7.4 step_graph 协议修正后重调（画布只接收通过校验的图）。", 422)
        names = await _resolve_ref_names(ctx, payload.project_id, [
            (node.get("ref"), str(node.get("kind") or ""))
            for node, _p, _d in scenario_graph.iter_nodes(graph)
            if str(node.get("kind") or "") in _REF_MODELS])
        inline: dict[str, Any] = copy.deepcopy(graph)
        for node, _p, _d in scenario_graph.iter_nodes(inline):
            kind = str(node.get("kind") or "")
            if kind not in _REF_MODELS:
                continue
            label = names.get((str(node.get("ref")), kind))
            if label is None:
                raise ApiError("validation_failed",
                               f"候选方案「{name}」的步骤 {node.get('key')!r} 引用的 "
                               f"{kind} 资产 {node.get('ref')!r} 在本项目不可见（不存在/已回收/无权限），"
                               "请先用 search_test_assets 确认可用资产。", 422)
            node["ref_name"] = label
        risks = _list_field(raw, "risks")
        raw_env = raw.get("env_hint")
        env_hint = raw_env if isinstance(raw_env, str) else None
        out_plans.append({"name": name, "intent": intent, "est_steps": est,
                          "env_hint": env_hint, "risks": [str(r) for r in risks],
                          "graph": inline})
    return _card({"kind": "scenario_plans", "plans": out_plans})


async def _resolve_ref_names(ctx: ServiceCtx, project_id: str,
                             refs: list[tuple[Any, str]]) -> dict[tuple[str, str], str]:
    """(ref,kind) → 资产名：可见性/回收口径与 T1 检索同尺（visible_clause）。"""
    found: dict[tuple[str, str], str] = {}
    for ref, kind in refs:
        key = (str(ref), kind)
        if not isinstance(ref, str) or not ref or key in found:
            continue
        model = _REF_MODELS[kind]
        row = (await ctx.db.execute(
            select(model.name)
            .where(model.id == ref, model.project_id == project_id,
                   model.status != "recycled", visible_clause(model, ctx))
        )).first()
        if row is not None:
            found[key] = str(row[0])
    return found


async def ask_user(payload: AskUserIn, ctx: ServiceCtx) -> dict[str, Any]:
    """运行内提问卡（§9.7 `:607`；D32：不挂起——落卡后本轮照常走完）。

    options 空列表合法（开放式提问），但元素必须非空白（空白选项渲染成点不动的空气泡）。
    """
    ctx.require(PLAN_WRITE_PERM)
    opts = [str(o) for o in payload.options]
    if any(not o.strip() for o in opts):
        raise ApiError("validation_failed", "ask_user 的选项不能是空白字符串（渲染成点不动的空选项）", 422)
    if len(set(opts)) != len(opts):
        raise ApiError("validation_failed", "ask_user 的选项不能重复（用户会以为有两个相同答案）", 422)
    return _card({"kind": "generic", "form": "question",
                  "question": payload.question, "options": opts})


async def propose_plan(payload: ProposePlanIn, ctx: ServiceCtx) -> dict[str, Any]:
    """目标计划列表卡（§11.4.33；D36：一期就在事件流里渲染，独立侧栏推二期）。

    items 每项 {id, text(或 title 别名), state?}；state 缺省 pending，值域四态。
    产出后整列表存进会话槽位（进程内），update_plan_item 据此回全量 items——
    「同名工具最新结果覆盖渲染」的前端合流口径要求每次都是完整列表。
    """
    ctx.require(PLAN_WRITE_PERM)
    items: list[dict[str, Any]] = []
    for i, raw in enumerate(payload.items, start=1):
        iid = raw.get("id")
        text = raw.get("text") if isinstance(raw.get("text"), str) else raw.get("title")
        state = raw.get("state", "pending")
        if iid is None or str(iid) == "":
            raise ApiError("validation_failed", f"计划第 {i} 项缺少 id（update_plan_item 按它推进状态）", 422)
        if not isinstance(text, str) or not text.strip():
            raise ApiError("validation_failed",
                           f"计划第 {i} 项（id={iid}）缺少 text（条目文本，列表卡正文）", 422)
        if state not in PLAN_ITEM_STATES:
            raise ApiError("validation_failed",
                           f"计划第 {i} 项（id={iid}）state={state!r} 越界，值域: {sorted(PLAN_ITEM_STATES)}", 422)
        items.append({"id": str(iid), "text": text, "state": str(state)})
    if len({it["id"] for it in items}) != len(items):
        raise ApiError("validation_failed", "计划项 id 重复（update_plan_item 会推进错条目）", 422)
    _SESSION_PLANS[ctx.session_id or ""] = items
    return _card({"kind": "generic", "form": "plan_list", "items": items})


# 会话 → 最近一次 propose_plan 的完整 items（update_plan_item 回全量列表的数据源）。
# 进程内是刻意的一期口径：agent run 与工具执行同进程（tasks._execute），零迁移承诺
# 下不落表；进程重启槽位丢失 → update_plan_item 明确 ok=False，不装作还能更新。
_SESSION_PLANS: dict[str, list[dict[str, Any]]] = {}


async def update_plan_item(payload: UpdatePlanItemIn, ctx: ServiceCtx) -> dict[str, Any]:
    """计划项状态推进（§11.4.33：pending→doing→done/skipped；state 值域已在模型钉死）。

    返回**全量** plan_list 卡（前端合流层按最新一条覆盖渲染 = 原地更新的地形）。
    """
    ctx.require(PLAN_WRITE_PERM)
    items = _SESSION_PLANS.get(ctx.session_id or "")
    if not items:
        raise ApiError("not_found",
                       "本会话还没有计划列表（propose_plan 的会话槽位为空——服务重启或未先建计划）。"
                       "请先调 propose_plan 重建列表，再推进状态。", 404)
    hit = [it for it in items if it["id"] == payload.id]
    if not hit:
        raise ApiError("not_found",
                       f"计划项 id={payload.id!r} 不存在，当前列表 id: {[it['id'] for it in items]}", 404)
    hit[0]["state"] = payload.state
    return _card({"kind": "generic", "form": "plan_list",
                  "items": copy.deepcopy(items)})


async def suggest_open_page(payload: SuggestOpenPageIn, ctx: ServiceCtx) -> dict[str, Any]:
    """跳转建议卡（route 白名单 = shell.tsx 导航真值；白名单外 ok=False）。

    前端 OpenPageCard 把 params 拼查询串——所以白名单只收不带路径参数的导航页；
    params 值必须可字符串化（查询串拼不出 dict，宁抛不装）。
    """
    ctx.require(PLAN_WRITE_PERM)
    if payload.route not in OPEN_PAGE_ROUTES:
        raise ApiError("validation_failed",
                       f"route {payload.route!r} 不在一期导航白名单内，跳过去就是 404。"
                       f"可选路由: {list(OPEN_PAGE_ROUTES)}", 422)
    return _card({"kind": "generic", "form": "open_page",
                  "route": payload.route, "params": dict(payload.params)})


# —— 回填登记（T2 的接线点，T1 同款机制）：真 handler 按名字进 spec.REAL_HANDLERS，
# __init__.py 钉「先 import 实现模块 → 再 register_metatools()」的顺序。
def register_card_handlers() -> None:
    REAL_HANDLERS.setdefault("propose_scenario_plans", propose_scenario_plans)
    REAL_HANDLERS.setdefault("ask_user", ask_user)
    REAL_HANDLERS.setdefault("propose_plan", propose_plan)
    REAL_HANDLERS.setdefault("update_plan_item", update_plan_item)
    REAL_HANDLERS.setdefault("suggest_open_page", suggest_open_page)


register_card_handlers()
