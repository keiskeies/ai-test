"""D274 场景导入：把本平台 `scenario_export` 产出的 JSON 快照回灌成新场景。

与导出（export_services.py）的关系，以及三条不撒谎的口径：

1. **只吃本平台的导出格式**（`{"scenarios": [...]}`，字段与 `_entry` 的可写子集对齐）。
   MS 的接口自动化 JSON / JMeter .jmx 没有解析器，不假装能读——前端入口文案与本文
   都只说「本平台导出文件」。
2. **不沿用文件里的 scenario_id**：每次导入都生成新 id。跨项目导入、重复导入同一份
   文件都不会撞主键；代价是「同一场景的旧报告/计划关联不会指到新行上」，这是新资产
   而不是恢复备份，如实说。
3. **不信任文件里的 validation**：逐条用保存期同一口径 `graph.validate` 现算；有一条
   不合法就整批 422、一条都不写（与批量操作全有或全无同尺，绝不静默跳过）。

项目私有资产（模块 / 环境）**只在目标项目里存在时才保留**，否则清空并在回包里点名
（与 D261 跨项目复制的处理同一条理由：模块与环境是项目私有 id，换项目后指向不存在）。
跨域引用（api_case / ui_case / adb_case）没有可解析的目标，原样保留 id 指针并在 notes
里说明——不静默改写、也不假装解析成功。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import column, select, table

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.scenario import schemas
from app.modules.scenario.graph import iter_nodes, validate
from app.modules.scenario.models import STATUS_NORMAL, Scenario, ScenarioModule
from app.shared.assertions import prune_rows
from app.shared.tags import join_tags

# 环境表反射（与 services.py 同一条纪律：领域模块之间零横向 import）。
ENVIRONMENT = table("environment", column("id"), column("project_id"))

_REF_KINDS = ("api_case", "ui_case", "adb_case")
_MAX_NAME = 200


def _suffixed(base: str, suffix: str) -> str:
    """截断到 200 再拼后缀——后缀是「这一行为什么改了名」的证据，不能被截掉。"""
    return base[: _MAX_NAME - len(suffix)] + suffix


def _ref_count(graph: dict) -> int:
    if not isinstance(graph, dict):
        return 0
    return sum(1 for node, _p, _d in iter_nodes(graph)
               if str(node.get("kind") or "") in _REF_KINDS and str(node.get("ref") or ""))


@service(
    perm="scenario:create", effect="write", name="scenario_import",
    description="导入场景（本平台导出的 JSON 快照；逐条重新校验步骤图，全有或全无；"
                "模块/环境在目标项目不存在时清空并如实回报，跨域引用原样保留 id 指针）",
    http={"method": "POST", "path": "/scenario-import", "tags": ["scenario"], "status": 201},
    tool=False,
)
async def scenario_import(payload: schemas.ScenarioImportIn, ctx) -> schemas.ScenarioImportOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:create")
    assert ctx.db is not None

    # ① 逐条现算校验：不信任文件里的 validation，有一条不合格整批不写。
    bad: list[dict[str, Any]] = []
    for i, e in enumerate(payload.scenarios):
        issues = validate(e.step_graph if isinstance(e.step_graph, dict) else {})
        if issues:
            bad.append({"index": i, "name": e.name, "issues": issues})
    if bad:
        raise ApiError("validation_error",
                       "导入取消：" + str(len(bad)) + " 条场景的步骤图未通过校验，未写入任何一条",
                       422, {"items": bad[:50]})

    # ② 目标项目里真实存在的模块 / 环境（项目私有资产，不存在就清空）。
    module_ids = set((await ctx.db.execute(select(ScenarioModule.id).where(
        ScenarioModule.project_id == payload.project_id,
        ScenarioModule.status == STATUS_NORMAL,
    ))).scalars().all())
    env_ids = set((await ctx.db.execute(select(ENVIRONMENT.c.id).where(
        ENVIRONMENT.c.project_id == payload.project_id,
    ))).scalars().all())
    # ③ 撞名集合一次取全（含回收站——回收站里的名字同样占位，scenario_create 同尺）。
    taken = set((await ctx.db.execute(select(Scenario.name).where(
        Scenario.project_id == payload.project_id,
    ))).scalars().all())

    renamed: list[dict[str, str]] = []
    cleared_modules: list[str] = []
    cleared_envs: list[str] = []
    names: list[str] = []
    refs_total = 0
    for e in payload.scenarios:
        name = e.name
        if name in taken:
            name, n = _suffixed(e.name, " (导入)"), 2
            while name in taken:
                name, n = _suffixed(e.name, " (导入 " + str(n) + ")"), n + 1
            renamed.append({"from": e.name, "to": name})
        taken.add(name)
        module_id = e.module_id
        if module_id is not None and module_id not in module_ids:
            cleared_modules.append(name)
            module_id = None
        env_id = e.env_id
        if env_id is not None and env_id not in env_ids:
            cleared_envs.append(name)
            env_id = None
        graph = e.step_graph if isinstance(e.step_graph, dict) else {"version": 1, "nodes": []}
        refs_total += _ref_count(graph)
        ctx.db.add(Scenario(
            project_id=payload.project_id, module_id=module_id, name=name,
            priority=e.priority, step_graph=graph, variables=dict(e.variables or {}),
            fail_fast=bool(e.fail_fast), max_runtime_ms=e.max_runtime_ms, env_id=env_id,
            common_assertions=prune_rows(e.common_assertions),
            tags=join_tags(e.tags),
            owner_id=ctx.user_id, project_public=bool(e.project_public),
            version=1, step_count=sum(1 for _ in iter_nodes(graph)),
            updated_by=ctx.user_id,
        ))
        names.append(name)
    await ctx.db.commit()

    notes: list[str] = []
    if renamed:
        notes.append(str(len(renamed)) + " 条与现有场景重名，已自动改名（明细见 renamed）")
    if cleared_modules:
        notes.append(str(len(cleared_modules)) + " 条引用的模块在目标项目不存在，已落到未分类"
                     "（明细见 cleared_modules）")
    if cleared_envs:
        notes.append(str(len(cleared_envs)) + " 条引用的环境在目标项目不存在，已清空"
                     "（明细见 cleared_envs）")
    if refs_total:
        notes.append("导入内容含 " + str(refs_total) + " 个跨域引用步骤（api_case/ui_case/adb_case）："
                     "ref 按 id 原样保留，目标项目里不存在这些资产时执行会失败（导入不做跨域解析）")
    notes.append("导入总会生成新的场景 id：这是新增资产，不是恢复旧 id 的备份")
    return schemas.ScenarioImportOut(
        imported=len(names), names=names, renamed=renamed,
        cleared_modules=cleared_modules, cleared_envs=cleared_envs, notes=notes,
    )
