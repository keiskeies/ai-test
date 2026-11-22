"""D74 场景导出备份（§11.4.8 批量条 [导出]）：勾选/全量场景 → 只读快照 JSON。

形状照抄接口域 api_export（export_services.py:205）：同一套权限口径
（ensure_project_access + ctx.require，POST 但 perm 以 :read 结尾）、同一条查询围栏
（project_id + visible_clause + status != recycled）、同一个缺 id 口径（带 ids 时逐条
校验，缺失/已回收/不可见 → 整批 404 fail-fast，**绝不静默跳过后少导几条**）、
同一个出参形状（数据 + exported + notes 人话如实报）。

**只读导出，不可回灌**（与 api_export 的刻意分歧，宁少做不假门）：
api_export 选 OpenAPI3 是因为导入向导（T4）真能吃回——往返自证有对手方。
场景域没有导入解析器，step_graph 的私有协议也没有任何外部格式可映射；
声称「可被导入吃回」就是自证无门。所以本导出的可验证性落在另一处：每条 entry 带
`validation` 字段——保存期同一口径的 graph.validate()（T4）现算结果，空列表 = 合法图。
「导出的东西能被 validate 判真假」在这里成立；「能再导入」不成立，报告与 out 描述都说明白。

跨模块引用（场景步骤 ref → api/ui/adb 资产）怎么表达：**原样 id 指针**。
step_graph 逐字导出，refs 数组点名每个引用步骤（step_key/kind/ref）。不做跨域解析
（不查 api_case_resolve 等）：那些服务要求**目标域**的读权限，接进来会把「scenario:read
能导出」变成「还须有 api:case:read / ui / adb 读权限」的权限交集，且逐条解析是 N+1——
api_export 也没做同类解析，照抄它就不发明。

未覆盖场景如实报：
① 无导入侧（如上，这是最大的一条限制）；
② env_id/module_id 是平台内部 id，换项目/换平台后指向不存在，语义在 notes 点名；
③ 全量（ids 缺省）= 项目内全部非回收**且对调用者可见**的场景——回收站里的东西
   与私有不可见场景永远不进气泡（与 api_export 同围栏）。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.scenario import schemas
from app.modules.scenario.graph import iter_nodes, validate
from app.modules.scenario.models import Scenario
from app.shared.visibility import visible_clause

# graph.REF_KINDS 同款列举（那边是 frozenset，导入它反而牵大依赖面——三元素照抄常量，
# graph.py 改词表时这里由 test_scenario_export 的 refs 用例兜底）。
_REF_KINDS = ("api_case", "ui_case", "adb_case")


def _refs_of(graph: dict) -> list[dict[str, str]]:
    """跨域引用点名：[(step_key, kind, ref)]——引用怎么导出就在这一个函数里说清。"""
    out: list[dict[str, str]] = []
    for node, _parent, _depth in iter_nodes(graph):
        kind = str(node.get("kind") or "")
        ref = str(node.get("ref") or "")
        if kind in _REF_KINDS and ref:
            out.append({"step_key": str(node.get("key") or ""), "kind": kind, "ref": ref})
    return out


def _entry(s: Scenario) -> dict[str, Any]:
    """一条场景 → 只读快照。字段全部映射 Scenario 真实列（名与 ScenarioCreateIn 对齐，
    多出的 scenario_id/validation/refs 是溯源与可验证性，不是第二套配置）。"""
    return {
        "scenario_id": s.id,
        "name": s.name,
        "priority": s.priority,
        "module_id": s.module_id,
        "step_graph": s.step_graph,
        "variables": dict(s.variables or {}),
        "fail_fast": bool(s.fail_fast),
        "max_runtime_ms": s.max_runtime_ms,
        "common_assertions": list(s.common_assertions or []),
        "env_id": s.env_id,
        "project_public": s.project_public,
        # 保存期唯一口径的 T4 validate（空 = 合法图）：对**列原值**判定——非 dict 的图
        # validate 自会报 bad_version（对 {} 兜底判定会把「列被外力破坏」洗成「缺 nodes」）。
        # 老场景可能带历史坏图，scenario_get 用同一函数暴露 live issues，导出保持一致。
        "validation": validate(s.step_graph),
        "refs": _refs_of(s.step_graph if isinstance(s.step_graph, dict) else {}),
    }


@service(
    perm="scenario:read", effect="read", name="scenario_export",
    description="导出备份（D74，§11.4.8 批量条）：勾选/全量场景 → 只读快照 JSON"
                "（step_graph 逐字 + 保存期同口径 validate 判定 + 引用原样 id 指针；"
                "读类动作故 perm 以 :read 结尾；**只读导出不可回灌**——场景域无导入解析器，"
                "如实报，不假装往返）",
    http={"method": "POST", "path": "/scenario-export", "tags": ["scenario"], "status": 200},
    tool=False,
)
async def scenario_export(payload: schemas.ScenarioExportIn, ctx) -> schemas.ScenarioExportOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:read")
    assert ctx.db is not None
    # 围栏三件套逐字照抄 api_export（export_services.py:219）：项目归属 + 可见性 + 非回收。
    # 不可见/回收站场景在这一步就被 SQL 挡掉，泄不进 rows，也就泄不进导出结果。
    stmt = select(Scenario).where(
        Scenario.project_id == payload.project_id,
        visible_clause(Scenario, ctx),
        Scenario.status != "recycled",
    )
    if payload.scenario_ids is not None:
        if len(set(payload.scenario_ids)) != len(payload.scenario_ids):
            raise ApiError("validation_failed", "scenario_ids 含重复 id", 422)
        stmt = stmt.where(Scenario.id.in_(payload.scenario_ids))
    rows = (await ctx.db.execute(stmt.order_by(Scenario.id))).scalars().all()
    if payload.scenario_ids is not None:
        # api_export 的既有口径（export_services.py:229）：整批 404 fail-fast，不是跳过+报告。
        # 「勾了 3 条只回来 2 条还 200」会把半份备份当成全份带走，宁可整批重来。
        missing = sorted(set(payload.scenario_ids) - {r.id for r in rows})
        if missing:
            raise ApiError("not_found", "场景不存在、已回收或不可见：" + ", ".join(missing), 404,
                           {"scenario_ids": missing})
    entries = [_entry(r) for r in rows]
    notes: list[str] = []
    for e in entries:
        # 逐条点名（照 api_export 的「草稿接口未导出（如实报）」分支的点名式 notes）
        if e["validation"]:
            notes.append("「" + e["name"] + "」的图有 " + str(len(e["validation"]))
                         + " 个校验问题（明细见该条 validation），照常导出（如实报）")
        if e["refs"]:
            notes.append("「" + e["name"] + "」含 " + str(len(e["refs"]))
                         + " 个跨域引用步骤（api_case/ui_case/adb_case，明细见该条 refs）："
                           "ref 是原样 id 指针，未做跨域解析（如实报）")
    if entries:
        notes.append("本导出是只读备份快照：module_id/env_id 为平台内部 id，换项目/换平台后"
                     "不自动成立；平台当前没有场景导入入口，不可回灌（如实报，与 api_export"
                     "的 OpenAPI3 往返自证是刻意分歧）")
    return schemas.ScenarioExportOut(scenarios=entries, exported=len(entries), notes=notes)
