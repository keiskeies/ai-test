"""场景资产 @service：CRUD + 乐观锁 + 校验 + 回收站 + 引用检测（计划 Task 10）。

- scenario_create/update 的 step_graph 走 T4 graph.validate()：有 issue → 422
  validation_error + details.issues（画布问题面板可直接消费）。validate 是保存期唯一
  口径，引擎与画布与这里的结论不可能分叉。
- update 带 version 乐观锁：不匹配 → 409 conflict + details.current_version
  （Review Focus 5）。成功则 version+=1、重算 step_count、记 updated_by。
- scenario_get 返回 live issues：打开老场景就看见问题，不必等保存报错。
- scenario_purge：tool=False + 输名确认 + 仅回收站可 purge（R53，与接口/用例同手感）。
- scenario_references：给 definition_id 或 case_id，返回引用的**未回收**场景 + 命中
  步骤 key 列表（Review Focus 9 的资产侧：data_set_delete 的 used_by 口径由协调者接入）。
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
from sqlalchemy import column, delete, func, select, table

from app.core.errors import ApiError, Page, paginate, paginate_desc, paginate_page
from app.core.permissions import match_perm
from app.core.service import ServiceResult, ensure_project_access, service, trigger_from_entry
from app.modules.scenario import schemas
from app.modules.scenario.graph import iter_nodes, validate
from app.modules.scenario.models import STATUS_RECYCLED, Scenario, ScenarioRevision
from app.modules.scenario.module_services import _mod
from app.shared.assertions import prune_rows
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.filters import _like
from app.shared.tags import join_tags, split_tags
from app.shared.visibility import assert_row_visible, visible_clause

# 回收站「删除人」列的人名来源（§11.4.18）：表名反射而非 import iam.models——领域模块之间
# 零横向 import 是 import-linter 契约 1 守着的红线。形状照 workbench/model_usage.py 的
# 同款 APP_USER（那边是 composition 层，这份是 scenario 域自己的；两份各守各的调用点）。
APP_USER = table("app_user", column("id"), column("name"))

# 接口定义 → 它的用例 id（§11.4.3「场景引用」Tab 按 definition_id 查时展开用）。表名反射
# 而非 import api_test，与上面 APP_USER 同理由（契约 1 零横向 import）。
# 为什么不走 REGISTRY 调 api_case_list：那条路先过 `api:case:read`，会把「这个接口被 N 个
# 场景引用」对只有 `scenario:read` 的人整块拒掉——而这条信息本来就归 scenario:read 管。
# 代价是本文件自己认一次软删口径 status=='normal'，由 test_definition_refs 钉住。
API_CASE = table("api_case", column("id"), column("project_id"),
                 column("definition_id"), column("status"))

# 场景绑环境（env_id）的归属校验用（D181）。表名反射而非 import env.models——领域模块之间
# 零横向 import 是 import-linter 契约 1 的红线，与上面 APP_USER/API_CASE 同理由。
ENVIRONMENT = table("environment", column("id"), column("project_id"))


def _issues_for(graph: dict | None) -> list[dict]:
    """live issue（纯 T4 validate；对任何输入都返回列表，绝不抛异常）。"""
    return validate(graph or {"version": 1, "nodes": []})


def _step_count(graph: dict | None) -> int:
    if not isinstance(graph, dict):
        return 0
    n = sum(1 for _ in iter_nodes(graph))
    return n


def _produced(s: Scenario) -> list[dict[str, str]]:
    return [{"kind": "scenario", "id": s.id, "name": s.name, "link": "/scen/" + s.id}]


def _iso(dt: datetime | None) -> str | None:
    """datetime → 带时区标记的 ISO；None 透传（前端画「—」）。

    对外时间戳必须有偏移标记：裸 naive 字符串到了前端 `new Date()` 会**按本地时区**解析，
    整页时间差 8 小时（events.py 里同一件事已经踩过一次，ledger 也记着）。
    ORM 读回来的 datetime 由 UtcDateTime 挂了 tzinfo=UTC，走这里是个 no-op；留着的理由是
    唯一口径：以后谁改成裸 SQL 取时间列（list_projects 就是那种列元组写法）或传进 naive 值，
    在这一个函数里被兜住，而不是在某个字段上静默少个 +00:00。
    """
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


def _revision_digest(s: Scenario) -> dict[str, Any]:
    """D262：变更历史快照（只取可安全落盘的摘要）。

    敏感值一律降级成摘要：`variables` 只留键名（值可能是 token/密码），`step_graph`
    只留步骤数（节点 config 里可能内嵌鉴权头）。其余标量字段本身不含密钥，按值记录。
    前后两份 digest 逐键比较即得到 changed；键集合在这里一处定义，读写两侧不会分叉。
    """
    return {
        "name": s.name,
        "priority": s.priority,
        # D284：标签进历史摘要（标签本身不是敏感值，按数组记录）
        "tags": split_tags(s.tags),
        "module_id": s.module_id,
        "fail_fast": bool(s.fail_fast),
        "max_runtime_ms": s.max_runtime_ms,
        "env_id": s.env_id,
        "project_public": bool(s.project_public),
        "step_graph": {"step_count": s.step_count},
        "variables": {"keys": sorted((s.variables or {}).keys())},
        "common_assertions": {"count": len(s.common_assertions or [])},
    }


def _out(s: Scenario, *, issues: list[dict] | None = None, produced: bool = False) -> schemas.ScenarioOut:
    return schemas.ScenarioOut(
        id=s.id, project_id=s.project_id, module_id=s.module_id, name=s.name, status=s.status,
        priority=s.priority, step_graph=s.step_graph, variables=dict(s.variables or {}),
        fail_fast=bool(s.fail_fast), max_runtime_ms=s.max_runtime_ms, env_id=s.env_id,
        common_assertions=list(s.common_assertions or []),
        tags=split_tags(s.tags),
        owner_id=s.owner_id, project_public=s.project_public, version=s.version,
        step_count=s.step_count, last_run_at=_iso(s.last_run_at),
        last_run_status=s.last_run_status, updated_by=s.updated_by,
        created_at=_iso(s.created_at), updated_at=_iso(s.updated_at),
        issues=issues if issues is not None else _issues_for(s.step_graph),
        produced=(_produced(s) if produced else []),
    )


async def _scen(db, project_id: str, scenario_id: str) -> Scenario:
    s = (await db.execute(select(Scenario).where(Scenario.id == scenario_id,
                                                 Scenario.project_id == project_id))).scalar_one_or_none()
    if s is None:
        raise ApiError("not_found", "场景不存在", 404, {"scenario_id": scenario_id})
    return s


async def _env(db, project_id: str, env_id: str) -> None:
    """D181：场景绑环境前的归属校验（形状照 module_services._mod / env_update 的取行 + 404）。

    环境行按 (id, project_id) 双条件取——查不到（不存在、或在别的项目）都回 404「环境不存在」，
    与不存在同码、不泄露存在性（env/services.py resolve_env 的既有口径：跨项目 env 与
    不存在是同一句话）。修的是 D181：B 项目的场景此前可以写上 A 项目环境的 id，保存全绿，
    到点运行才在执行链路 404——病因与现场隔着一次运行。
    """
    hit = (await db.execute(select(ENVIRONMENT.c.id).where(
        ENVIRONMENT.c.id == env_id, ENVIRONMENT.c.project_id == project_id))).first()
    if hit is None:
        raise ApiError("not_found", "环境不存在", 404, {"env_id": env_id})


async def _user_names(db, user_ids: set[str]) -> dict[str, str]:
    """id→人名的小查询（形状照 workbench/model_usage.py 的 _user_names，域内自抄一份：
    领域模块之间零横向 import，也不为一份两用的映射去新建 core/ helper）。

    查不到的 id 不在结果里——调用方落到 None，前端画「—」；用 id 冒充人名是把 uuid
    摊给业主看。
    """
    if not user_ids:
        return {}
    return {
        r[0]: r[1] for r in (await db.execute(
            select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(sorted(user_ids)))
        )).all()
    }


async def _validate_and_count(graph: dict | None) -> int:
    """T4 validate 的保存期拦截：有 issue → 422 validation_error + details.issues。"""
    issues = _issues_for(graph)
    if issues:
        raise ApiError("validation_error", "场景校验未通过：请先处理问题面板里的 " +
                       str(len(issues)) + " 个问题", 422, {"issues": issues})
    return _step_count(graph)


# D214：场景列表的可筛面（D47-a 三件套从 api/plan/ui_case 铺到场景页）。字段全是
# Scenario 上真实存在的业务列；project_id / recycled / module_id / module_ids / keyword
# 仍是顶层参数——前两个管越权与视图，后三个是页面既有入口（模块树 / 快捷搜索），
# 进了 filter 就是让两套开关抢同一个名字。
SCENARIO_LIST_FILTER = ListViewFilter(
    view_type="scenario",
    label="场景编排",
    fields={
        "name": FieldDecl(Scenario.name, "text", "场景名称", nullable=False),
        "priority": FieldDecl(Scenario.priority, "enum", "优先级", nullable=False),
        "module_id": FieldDecl(Scenario.module_id, "id", "所属模块"),
        "env_id": FieldDecl(Scenario.env_id, "id", "所属环境"),
        "owner_id": FieldDecl(Scenario.owner_id, "id", "负责人"),
        "fail_fast": FieldDecl(Scenario.fail_fast, "bool", "失败即停", nullable=False),
        "max_runtime_ms": FieldDecl(Scenario.max_runtime_ms, "number", "超时上限(ms)"),
        "project_public": FieldDecl(Scenario.project_public, "bool", "项目内公开", nullable=False),
        "step_count": FieldDecl(Scenario.step_count, "number", "步骤数", nullable=False),
        "last_run_at": FieldDecl(Scenario.last_run_at, "time", "最近执行时间"),
        "last_run_status": FieldDecl(Scenario.last_run_status, "enum", "最近执行结果"),
        "updated_by": FieldDecl(Scenario.updated_by, "id", "更新人"),
        "created_at": FieldDecl(Scenario.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(Scenario.updated_at, "time", "更新时间", nullable=False),
    },
)
register(SCENARIO_LIST_FILTER)


@service(
    perm="scenario:read", effect="read", name="scenario_list",
    description="列出项目下的场景（默认不含回收站；recycled=true 只看已回收；最近结果来自冗余列，不 N+1 查运行记录）",
    http={"method": "GET", "path": "/scenarios", "tags": ["scenario"]},
)
async def scenario_list(payload: schemas.ScenarioListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:read")
    assert ctx.db is not None
    # D47-b 步 5b：module_ids / keyword 下推到 SQL（此前是前端拉一页回浏览器内存过滤），
    # 与已有的单值 module_id、recycled、可见性谓词 AND 进同一条 where。
    # - module_ids：前端把直属那一个模块 id 发来（场景树徽标本来就是直属计数，两边口径
    #   已一致，不做子树展开——那是另一刀）。None = 不加这一路；[] 与 None 的区分不可混同。
    #   空列表的渲染实测是 `module_id IN (NULL) AND (1 != 1)`（SQLAlchemy 2.1.8 literal render
    #   现跑）——靠那个恒假项匹配不到任何行，不是靠三值逻辑。
    #   真正与现状等价的是**非空**列表也捞不到未分类行：`NULL IN (...)` 不为真，而老代码
    #   `sub.has(r.module_id ?? "__none")`（HEAD scenes.tsx:144）里那个哨兵永远不在集合里
    #   ——未分类在树上不是可选节点（shared/moduleTree.ts:58-60 写死了不为它造假选项）。
    # - keyword：**只打 name 一列**（现状本地框就只搜 name，别顺手加列 = 行为改变）。
    #   转义复用 shared.filters._like + ESCAPE '\\'：用户敲的 % / _ 是字面量。
    #   大小写不敏感靠列的 utf8mb4_0900_ai_ci（步 4 已取证与浏览器 toLowerCase 同宽）。
    #   全空白 = 没筛选（清空输入框和敲了空格是同一件事）。
    stmt = select(Scenario).where(Scenario.project_id == payload.project_id,
                                  visible_clause(Scenario, ctx),
                                  Scenario.status == (STATUS_RECYCLED if payload.recycled else "normal"),
                                  SCENARIO_LIST_FILTER.parse(payload.filter))
    if payload.module_id:
        stmt = stmt.where(Scenario.module_id == payload.module_id)
    if payload.module_ids is not None:
        stmt = stmt.where(Scenario.module_id.in_(payload.module_ids))
    if payload.keyword and payload.keyword.strip():
        kw = payload.keyword.strip()  # 两端空白不进入匹配（用户看不见也删不掉的空格）
        stmt = stmt.where(Scenario.name.like(f"%{_like(kw)}%", escape="\\"))
    # D284：标签精确筛选走 FIND_IN_SET（逗号串上的 LIKE 会把 bug1 命中 bug10）；
    # 全空白 = 不过滤（与 keyword 同尺）。
    if payload.tag and payload.tag.strip():
        stmt = stmt.where(func.find_in_set(payload.tag.strip(), Scenario.tags) > 0)
    stmt = stmt.order_by(Scenario.id)
    # D47-b 步 5b：cursor 与 current 二选一（同 /api-definitions 步 4b）。
    # 「我在哪」的两套真相一起到场是调用方的 bug，静默择一会把错位藏进翻页里，所以大声 400。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在**同一条已排序 stmt** 上 OFFSET：ORDER BY 与键集逐字同一条（判据 5），
        # 且 total 与 items 用的是同一份谓词——筛选在前、数数在后（MS 的 PageHelper 同构）。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate(ctx.db, stmt, cursor_col=Scenario.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    items = [_out(s) for s in page.items]
    # 回收站「删除人」列（§11.4.18）：先分页拿到结果、再对这一页的 id 补一次小查询填名字。
    # 不在 paginate 的 stmt 上 join APP_USER——那会把 items 从 model 变成 tuple，
    # row_key/游标全要跟着改，而本任务只是给列表加一列展示名（改动半径与本任务不成比例）。
    names = await _user_names(ctx.db, {s.updated_by for s in page.items if s.updated_by})
    for it, s in zip(items, page.items, strict=True):
        it.updated_by_name = names.get(s.updated_by) if s.updated_by else None
    return Page(items=items, next_cursor=page.next_cursor, total=page.total)


@service(
    perm="scenario:create", effect="write", name="scenario_create",
    description="创建场景（step_graph 过 step_graph 协议校验：有 issue → 422 validation_error + details.issues；同项目重名 409）",
    http={"method": "POST", "path": "/scenarios", "tags": ["scenario"], "status": 201},
)
async def scenario_create(payload: schemas.ScenarioCreateIn, ctx) -> schemas.ScenarioOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:create")
    assert ctx.db is not None
    dup = (await ctx.db.execute(select(Scenario).where(Scenario.project_id == payload.project_id,
                                                       Scenario.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        msg = "场景名在回收站占位，请先恢复或改名" if dup.status == STATUS_RECYCLED else "场景名已存在"
        raise ApiError("conflict", msg, 409, {"name": payload.name})
    if payload.module_id is not None:
        await _mod(ctx.db, payload.project_id, payload.module_id)
    if payload.env_id is not None:
        await _env(ctx.db, payload.project_id, payload.env_id)
    count = await _validate_and_count(payload.step_graph)
    s = Scenario(project_id=payload.project_id, module_id=payload.module_id, name=payload.name,
                 priority=payload.priority, step_graph=payload.step_graph,
                 variables=dict(payload.variables or {}), fail_fast=payload.fail_fast,
                 max_runtime_ms=payload.max_runtime_ms, env_id=payload.env_id,
                 common_assertions=prune_rows(payload.common_assertions),
                 tags=join_tags(payload.tags),
                 owner_id=ctx.user_id, project_public=payload.project_public,
                 version=1, step_count=count, updated_by=ctx.user_id)
    ctx.db.add(s)
    await ctx.db.commit()
    return _out(s, issues=[], produced=True)


@service(
    perm="scenario:read", effect="read", name="scenario_get",
    description="获取场景详情（含 live issues：打开老场景即能看见校验问题，不必等保存报错）",
    http={"method": "GET", "path": "/scenarios/{scenario_id}", "tags": ["scenario"]},
)
async def scenario_get(payload: schemas.ScenarioGetIn, ctx) -> schemas.ScenarioOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:read")
    assert ctx.db is not None
    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status == STATUS_RECYCLED:
        raise ApiError("not_found", "场景不存在（在回收站）", 404, {"scenario_id": s.id})
    return _out(s)


@service(
    perm="scenario:update", effect="write", name="scenario_update",
    description="更新场景（乐观锁：version 不匹配 → 409 conflict + details.current_version；成功则 version+=1、重算 step_count、记 updated_by）",
    http={"method": "PATCH", "path": "/scenarios/{scenario_id}", "tags": ["scenario"]},
)
async def scenario_update(payload: schemas.ScenarioUpdateIn, ctx) -> schemas.ScenarioOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:update")
    assert ctx.db is not None
    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status == STATUS_RECYCLED:
        raise ApiError("not_found", "场景不存在（在回收站，请先恢复）", 404, {"scenario_id": s.id})
    if s.version != payload.version:
        raise ApiError("conflict", "版本冲突：他人已修改，请刷新后重试", 409,
                       {"current_version": s.version, "your_version": payload.version})
    # D262：变更历史的前像必须在任何赋值之前取（s 是 ORM 行，改字段就是改它）。
    before = _revision_digest(s)
    if payload.name is not None:
        if payload.name != s.name:
            dup = (await ctx.db.execute(select(Scenario).where(
                Scenario.project_id == payload.project_id, Scenario.name == payload.name,
                Scenario.id != s.id))).scalar_one_or_none()
            if dup is not None:
                raise ApiError("conflict", "场景名已存在", 409, {"name": payload.name})
        s.name = payload.name
    if payload.priority is not None:
        s.priority = payload.priority
    # D284：标签三态（None = 不改、[] = 清空）
    if payload.tags is not None:
        s.tags = join_tags(payload.tags)
    if payload.module_set:
        if payload.module_id is not None:
            await _mod(ctx.db, payload.project_id, payload.module_id)
        s.module_id = payload.module_id
    if payload.step_graph is not None:
        s.step_count = await _validate_and_count(payload.step_graph)
        s.step_graph = payload.step_graph
    if payload.variables is not None:
        s.variables = dict(payload.variables)
    if payload.fail_fast is not None:
        s.fail_fast = payload.fail_fast
    if payload.max_runtime_set:
        s.max_runtime_ms = payload.max_runtime_ms
    if payload.common_assertions_set:
        # 与 max_runtime_set 同款：显式声明位为真才落库（[] = 清空并停用，None = 不改）。
        # prune_rows：只在这里过一次入库口径（同 api_case 的 exclude_none 落库），
        # 运行期读的是这行，所以快照/detail 里也是剪过的形状，不会出现两套形状。
        s.common_assertions = prune_rows(payload.common_assertions)
    if payload.env_set:
        # D181：改绑/绑定时校验环境归属本项目（env_id=None = 解绑，照旧不校验——
        # 解开一个脏指向不该要求那个指向还有效）。与 _mod 的门位对齐：校验在落库前。
        if payload.env_id is not None:
            await _env(ctx.db, payload.project_id, payload.env_id)
        s.env_id = payload.env_id
    if payload.project_public is not None:
        s.project_public = payload.project_public
    s.version += 1
    s.updated_by = ctx.user_id
    # D262：一次成功 update 落一行历史（version = 变更后的版本号）。没有字段差异也落：
    # version 确实前进了，历史出现空档会让「v5 是谁改的」永久无法回答；changed=[] 就是
    # 「这次保存只推进了版本」的如实记录。
    after = _revision_digest(s)
    ctx.db.add(ScenarioRevision(
        project_id=payload.project_id, scenario_id=s.id, version=s.version,
        actor_id=ctx.user_id,
        changed=[{"field": k, "before": before[k], "after": after[k]}
                 for k in before if before[k] != after[k]],
    ))
    await ctx.db.commit()
    return _out(s, issues=[])


@service(
    perm="scenario:read", effect="read", name="scenario_revisions",
    description="场景变更历史（append-only，最新在前；variables 只回键名、step_graph 只回步骤数，不回敏感原文）",
    http={"method": "GET", "path": "/scenarios/{scenario_id}/revisions", "tags": ["scenario"]},
    resident=False,
)
async def scenario_revisions(payload: schemas.ScenarioRevisionListIn, ctx) -> ServiceResult:
    """D262：场景变更历史。

    可见性口径与 scenario_get 逐字一致（同项目 + 行级可见；回收站中的场景 404）：
    历史里可能含旧名称/旧环境等已不可见的元信息，不能成为绕过「场景在回收站」的第二扇门。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:read")
    assert ctx.db is not None
    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status == STATUS_RECYCLED:
        raise ApiError("not_found", "场景不存在（在回收站）", 404, {"scenario_id": s.id})
    stmt = (select(ScenarioRevision)
            .where(ScenarioRevision.project_id == payload.project_id,
                   ScenarioRevision.scenario_id == s.id)
            .order_by(ScenarioRevision.version.desc(), ScenarioRevision.id.desc()))
    page = await paginate_desc(
        ctx.db, stmt, key_cols=[ScenarioRevision.version, ScenarioRevision.id],
        row_key=lambda r: [r.version, r.id],
        decode_key=lambda parts: [int(parts[0]), str(parts[1])],
        cursor=payload.cursor, size=payload.size,
    )
    names = await _user_names(ctx.db, {r.actor_id for r in page.items if r.actor_id})
    return Page(items=[schemas.ScenarioRevisionOut(
        id=r.id, scenario_id=r.scenario_id, version=r.version,
        actor_id=r.actor_id, actor_name=names.get(r.actor_id) if r.actor_id else None,
        changed=list(r.changed or []), created_at=_iso(r.created_at),
    ) for r in page.items], next_cursor=page.next_cursor)


@service(
    perm="scenario:delete", effect="destructive", name="scenario_delete",
    description="把场景放入回收站（软删；已回收再删 404）",
    http={"method": "POST", "path": "/scenarios/{scenario_id}/delete", "tags": ["scenario"]},
    resident=False,
)
async def scenario_delete(payload: schemas.ScenarioGetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:delete")
    assert ctx.db is not None
    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status != "normal":
        raise ApiError("not_found", "场景不存在", 404, {"scenario_id": s.id})
    s.status = STATUS_RECYCLED
    # 回收这次写操作落 updated_by：§11.4.18 回收站「删除人」列读的就是它。不写则列上挂着
    # 上一个编辑人（B 改过、A 删的 → 显示 B），而「删除时间」靠 updated_at onupdate 已经
    # 跟上了——时间与人对不上是更难查的半错（与 UI 用例/元素同法）。
    s.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="scenario:update", effect="write", name="scenario_restore",
    description="从回收站恢复场景",
    http={"method": "POST", "path": "/scenarios/{scenario_id}/restore", "tags": ["scenario"]},
    resident=False,
)
async def scenario_restore(payload: schemas.ScenarioGetIn, ctx) -> schemas.ScenarioOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:update")
    assert ctx.db is not None
    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status != STATUS_RECYCLED:
        raise ApiError("not_found", "场景不在回收站", 404, {"scenario_id": s.id})
    s.status = "normal"
    await ctx.db.commit()
    return _out(s)


@service(
    perm="scenario:delete", effect="destructive", name="scenario_purge",
    description="彻底删除回收站中的场景（物理删除，不可恢复；须逐字确认场景名）",
    http={"method": "POST", "path": "/scenarios/{scenario_id}/purge", "tags": ["scenario"]},
    tool=False, resident=False,
)
async def scenario_purge(payload: schemas.ScenarioPurgeIn, ctx) -> BaseModel:
    """回收站出口（R53）：只有软删过的东西能到这里，且必须逐字确认名称。"""
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:delete")
    assert ctx.db is not None
    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的场景：请先放入回收站", 409,
                       {"scenario_id": s.id})
    if payload.confirm_name != s.name:
        raise ApiError("name_mismatch", "确认名称与场景名不一致，未删除", 409,
                       {"scenario_id": s.id})
    # D262：历史随场景彻底删除显式删净（全库无外键，级联必须写出来；否则留孤儿行
    # 占库且永远无法通过任何入口读到）。
    await ctx.db.execute(delete(ScenarioRevision).where(ScenarioRevision.scenario_id == s.id))
    await ctx.db.delete(s)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="scenario:update", effect="write", name="scenario_duplicate",
    description="复制场景（step_graph/variables/priority 原样；新场景名默认加「- 副本」后缀，可覆盖）",
    http={"method": "POST", "path": "/scenarios/{scenario_id}/duplicate", "tags": ["scenario"]},
)
async def scenario_duplicate(payload: schemas.ScenarioDuplicateIn, ctx) -> schemas.ScenarioOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:update")
    assert ctx.db is not None
    src = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(src, ctx, what="场景不存在")
    if src.status != "normal":
        raise ApiError("not_found", "场景不存在（回收站中的场景不可复制）", 404, {"scenario_id": src.id})
    name = payload.name or (src.name + " - 副本")
    dup = (await ctx.db.execute(select(Scenario).where(Scenario.project_id == payload.project_id,
                                                       Scenario.name == name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "场景名已存在", 409, {"name": name})
    if payload.module_id is not None:
        await _mod(ctx.db, payload.project_id, payload.module_id)
    s = Scenario(project_id=payload.project_id, module_id=payload.module_id if payload.module_id is not None
                 else src.module_id, name=name, priority=src.priority, step_graph=src.step_graph,
                 variables=dict(src.variables or {}), fail_fast=bool(src.fail_fast),
                 max_runtime_ms=src.max_runtime_ms, env_id=src.env_id,
                 common_assertions=list(src.common_assertions or []),
                 tags=src.tags,
                 owner_id=ctx.user_id, project_public=src.project_public, version=1,
                 step_count=src.step_count, updated_by=ctx.user_id)
    ctx.db.add(s)
    await ctx.db.commit()
    return _out(s, issues=[])


@service(
    perm="scenario:update", effect="write", name="scenario_batch_copy",
    description="批量复制场景（名称自动追加「 - 副本」并按需加数字后缀；回收站中的场景拒 404）；"
                "target_project_id 不同时跨项目复制，另需目标项目的 scenario:create，"
                "环境清空、模块落到目标项目（项目私有资产不跟随）",
    http={"method": "POST", "path": "/scenario-batch-copy", "tags": ["scenario"]},
)
async def scenario_batch_copy(payload: schemas.ScenarioBatchCopyIn, ctx) -> BaseModel:
    """D257：把前端 N 次 single duplicate 循环收成一次事务。

    与单条 duplicate 的两点差异（都在 schemas 的类注释里）：
    - 撞名不再 409，自动找下一个可用后缀——批量里有一个重名就全批失败不可接受；
    - 回包带最终名清单，前端 toast 才能说明「叫什么的副本被建出来了」。

    D261：`target_project_id` 不同 = 跨项目复制。读源要源项目权限，落副本要目标项目的
    `scenario:create`；环境与模块都是项目私有资产，跨项目时 env_id 清空、module_id
    缺省落到目标项目未分类（不能跟随源模块 id，那在目标项目里是另一个/不存在的模块）。
    """
    target = payload.target_project_id or payload.project_id
    cross = target != payload.project_id
    await ensure_project_access(ctx, payload.project_id)  # 读源场景的权限
    assert ctx.db is not None
    if not cross:
        ctx.require("scenario:update")
        if payload.module_id is not None:
            await _mod(ctx.db, payload.project_id, payload.module_id)
        rows = await _batch_rows(ctx, payload.project_id, payload.scenario_ids,
                                 "normal", "不存在（在回收站中的不可复制）")
    else:
        # 源行的可见性必须按**源项目**身份判定：ensure_project_access(target) 会把
        # ctx.perms 换成目标项目的位，先切后查的话，「目标项目管理员、源项目普通成员」
        # 就能看见源项目里别人私有的场景（可见性谓词读的是 ctx.perms）。
        rows = await _batch_rows(ctx, payload.project_id, payload.scenario_ids,
                                 "normal", "不存在（在回收站中的不可复制）")
        await ensure_project_access(ctx, target)
        ctx.require("scenario:create")
        if payload.module_id is not None:
            await _mod(ctx.db, target, payload.module_id)  # 模块必须属于**落点**项目
    taken = {n for n in (await ctx.db.execute(select(Scenario.name).where(
        Scenario.project_id == target))).scalars().all()}
    created: list[str] = []
    for src in rows:
        base = src.name + " - 副本"
        name, i = base, 2
        while name in taken:
            name, i = base + " " + str(i), i + 1
        taken.add(name)
        if cross:
            module_id = payload.module_id          # 缺省 = 目标项目未分类
            env_id = None                          # 环境是项目私有资产（D181）
        else:
            module_id = (payload.module_id if payload.module_id is not None
                         else src.module_id)
            env_id = src.env_id
        dup = Scenario(project_id=target, module_id=module_id,
                       name=name, priority=src.priority, step_graph=src.step_graph,
                       variables=dict(src.variables or {}), fail_fast=bool(src.fail_fast),
                       max_runtime_ms=src.max_runtime_ms, env_id=env_id,
                       common_assertions=list(src.common_assertions or []),
                       tags=src.tags,
                       owner_id=ctx.user_id, project_public=src.project_public, version=1,
                       step_count=src.step_count, updated_by=ctx.user_id)
        ctx.db.add(dup)
        created.append(name)
    await ctx.db.commit()
    return schemas.ScenarioBatchCopyOut(created=len(created), names=created)


@service(
    perm="scenario:run", effect="write", name="scenario_batch_run",
    description="批量执行场景：预检全有或全无，投递逐条进行并逐条回报失败",
    http={"method": "POST", "path": "/scenario-batch-run", "tags": ["scenario"]},
)
async def scenario_batch_run(payload: schemas.ScenarioBatchRunIn, ctx) -> BaseModel:
    """D258：替代前端 N 次单跑。

    - 预检（重复/存在/状态/统一环境可解析）全有或全无：任何一条不合格 → 一个 run
      都不建；
    - 投递阶段逐条 enqueue（它自己 commit，攒批会拖垮 broker 失败时的清理），
      中途 broker 挂掉时回包用 `failed` 逐条说明，不假装整批成功。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:run")
    assert ctx.db is not None
    if payload.env_id:
        await _env_name_for(ctx, payload.project_id, payload.env_id)  # 环境不可用当场 404
    rows = await _batch_rows(ctx, payload.project_id, payload.scenario_ids,
                             "normal", "不存在（在回收站中的不可执行）")
    from app.modules.scenario.orchestration import enqueue

    trigger = trigger_from_entry(ctx.entry)
    transport = _transport_factory() if _transport_factory else None
    # 先取标量：enqueue 内部 commit，之后不能再摸 ORM 属性（同 T9 的「先取标量」坑）
    items = [(s.id, s.name, s.env_id, s.max_runtime_ms) for s in rows]
    run_ids: list[str] = []
    failed: list[schemas.ScenarioBatchRunFailed] = []
    for sid, sname, s_env, s_max in items:
        env_id = payload.env_id or s_env
        try:
            env_name = await _env_name_for(ctx, payload.project_id, env_id)
            rec = await enqueue(ctx.db, project_id=payload.project_id, subject_id=sid,
                                subject_name=sname, trigger=trigger, created_by=ctx.user_id,
                                env_id=env_id, env_name=env_name,
                                max_runtime_ms=s_max, actor=_actor_from(ctx),
                                transport=transport)
            run_ids.append(rec.id)
        except ApiError as e:
            failed.append(schemas.ScenarioBatchRunFailed(
                scenario_id=sid, code=e.code, message=e.message))
    return schemas.ScenarioBatchRunOut(run_ids=run_ids, failed=failed)


@service(
    perm="scenario:update", effect="write", name="scenario_batch_move",
    description="批量移动场景到某模块（module_id=None 移到根/未分类；回收站中的场景被拒 404）",
    http={"method": "POST", "path": "/scenario-batch-move", "tags": ["scenario"]},
)
async def scenario_batch_move(payload: schemas.ScenarioBatchMoveIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:update")
    assert ctx.db is not None
    if payload.module_id is not None:
        await _mod(ctx.db, payload.project_id, payload.module_id)
    rows = (await ctx.db.execute(select(Scenario).where(Scenario.project_id == payload.project_id,
                                                        Scenario.id.in_(payload.scenario_ids)))).scalars().all()
    if len(rows) != len(set(payload.scenario_ids)):
        raise ApiError("not_found", "部分场景不存在（可能已回收或属于其他项目）", 404)
    for s in rows:
        # 回收站中的场景不能被批量移动：它是「已删除」状态，移动是写操作，不该救活它。
        if s.status != "normal":
            raise ApiError("not_found", "部分场景在回收站中，不能批量移动", 404, {"scenario_id": s.id})
        s.module_id = payload.module_id
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


async def _batch_rows(ctx, project_id: str, ids: list[str], want_status: str,
                      what: str) -> list:
    """批量取行并校验状态；任一不合规 → 404 + 具体 ids（整批不动）。

    `what` 是给用户看的短语：「不存在或已回收」/「不存在或不在回收站」。
    """
    uniq = list(dict.fromkeys(ids))
    if len(uniq) != len(ids):
        raise ApiError("validation_failed", "scenario_ids 不能重复", 422,
                       {"scenario_ids": ids})
    rows = (await ctx.db.execute(select(Scenario).where(
        Scenario.project_id == project_id, Scenario.id.in_(uniq)))).scalars().all()
    found = {s.id: s for s in rows}
    bad = [i for i in uniq if i not in found or found[i].status != want_status]
    if bad:
        raise ApiError("not_found", "有场景" + what, 404, {"scenario_ids": bad})
    for s in rows:
        assert_row_visible(s, ctx, what="场景不存在")
    return rows


@service(
    perm="scenario:delete", effect="destructive", name="scenario_batch_delete",
    description="批量放入回收站（全有或全无：任一不存在/已回收 → 404 整批不动）",
    http={"method": "POST", "path": "/scenario-batch-delete", "tags": ["scenario"]},
    resident=False,
)
async def scenario_batch_delete(payload: schemas.ScenarioBatchIn, ctx) -> BaseModel:
    """替代前端 N 次单删循环：要么整批进回收站，要么一行都没动。

    `updated_by` 逐行写删除人——回收站「删除人」列读的就是它（同单删）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:delete")
    assert ctx.db is not None
    rows = await _batch_rows(ctx, payload.project_id, payload.scenario_ids,
                             "normal", "不存在或已在回收站")
    for s in rows:
        s.status = STATUS_RECYCLED
        s.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="scenario:update", effect="write", name="scenario_batch_restore",
    description="批量从回收站恢复（全有或全无：任一不存在/不在回收站 → 404 整批不动）",
    http={"method": "POST", "path": "/scenario-batch-restore", "tags": ["scenario"]},
    resident=False,
)
async def scenario_batch_restore(payload: schemas.ScenarioBatchIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:update")
    assert ctx.db is not None
    rows = await _batch_rows(ctx, payload.project_id, payload.scenario_ids,
                             STATUS_RECYCLED, "不存在或不在回收站")
    for s in rows:
        s.status = "normal"
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="scenario:delete", effect="destructive", name="scenario_batch_purge",
    description="批量彻底删除回收站中的场景（物理删除；服务端验固定确认短语）",
    http={"method": "POST", "path": "/scenario-batch-purge", "tags": ["scenario"]},
    tool=False, resident=False,
)
async def scenario_batch_purge(payload: schemas.ScenarioBatchPurgeIn, ctx) -> BaseModel:
    """D256：回收站批量物理删除。

    单条 purge 的护栏是「逐字输入场景名」；批量里 N 个名字逐个输不现实，降级为固定
    短语「彻底删除」——但**服务端必须验**，不能只靠前端禁用按钮。先验短语再验行，
    保证「短语错」不会被行不存在/状态不对的错误掩盖。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:delete")
    assert ctx.db is not None
    if payload.confirm_word != "彻底删除":
        raise ApiError("confirm_word_mismatch",
                       "请逐字输入「彻底删除」以确认，未执行任何删除", 409,
                       {"expected": "彻底删除"})
    rows = await _batch_rows(ctx, payload.project_id, payload.scenario_ids,
                             STATUS_RECYCLED, "不存在或不在回收站")
    # D262：批量彻底删除同样显式清历史（与单条 purge 同一口径，一次 IN 删净）。
    await ctx.db.execute(delete(ScenarioRevision).where(
        ScenarioRevision.scenario_id.in_([s.id for s in rows])))
    for s in rows:
        await ctx.db.delete(s)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


def _find_refs(graph: dict | None, hit_case_ids: set[str] | None,
               hit_def_ids: set[str]) -> list[str]:
    """在 step_graph 里兜出命中引用的事实 key：api_case 步骤的 ref 是 case_id；
    ui_case/adb_case 的 ref 是定义 id（二期）。"""
    keys: list[str] = []
    if not isinstance(graph, dict):
        return keys
    for node, _parent, _depth in iter_nodes(graph):
        kind = node.get("kind")
        ref = str(node.get("ref") or "")
        if not ref:
            continue
        if kind == "api_case" and hit_case_ids is not None and ref in hit_case_ids:
            keys.append(str(node.get("key") or ""))
        elif kind in ("ui_case", "adb_case") and ref in hit_def_ids:
            keys.append(str(node.get("key") or ""))
    return keys


@service(
    perm="scenario:read", effect="read", name="scenario_references",
    description="查引用某用例/接口定义的未回收场景（含命中步骤 key 列表；供接口详情「场景引用」Tab）",
    http={"method": "GET", "path": "/scenario-references", "tags": ["scenario"]},
)
async def scenario_references(payload: schemas.ScenarioReferencesIn, ctx) -> schemas.ScenarioReferencesOut:
    if not payload.case_id and not payload.definition_id:
        raise ApiError("validation_failed", "case_id 与 definition_id 必须至少给一个", 422)
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:read")
    assert ctx.db is not None
    # definition_id 是**接口定义**的 id，而 step_graph 里 api_case 步骤的 ref 是**用例** id
    # （见 _find_refs：definition_ids 只喂 ui_case/adb_case）。直接拿定义 id 去比 ref 恒不命中，
    # 「场景引用」Tab 就会对每个接口都显示「暂无引用」——一个骗人放心删的假空态，比报错更坏。
    # 所以先把定义展开成它下面的未回收用例，再按用例 ref 查。
    # definition_id 同时继续喂 hit_def_ids：ui_case/adb_case 步骤的 ref 按 _find_refs 的口径
    # 就是定义 id，这里不能顺手砍掉那条通路。
    hit_case_ids: set[str] = set()
    hit_def_ids: set[str] = set()
    if payload.case_id:
        hit_case_ids.add(payload.case_id)
    if payload.definition_id:
        hit_def_ids.add(payload.definition_id)
        rows_ = (await ctx.db.execute(
            select(API_CASE.c.id).where(API_CASE.c.project_id == payload.project_id,
                                        API_CASE.c.definition_id == payload.definition_id,
                                        API_CASE.c.status == "normal")
        )).all()
        hit_case_ids.update(r[0] for r in rows_)
    stmt = select(Scenario).where(Scenario.project_id == payload.project_id,
                                  Scenario.status == "normal")
    rows = (await ctx.db.execute(stmt)).scalars().all()
    items: list[schemas.ScenarioReferenceItem] = []
    for s in rows:
        keys = _find_refs(s.step_graph, hit_case_ids or None, hit_def_ids)
        if keys:
            items.append(schemas.ScenarioReferenceItem(
                scenario_id=s.id, scenario_name=s.name, step_keys=sorted(keys), sort=s.priority or "P2"))
    # 稳定排序：优先级字典序 + 场景 id（避免同一数据下列表顺序随机抖动）
    items.sort(key=lambda x: (x.sort, x.scenario_id))
    return schemas.ScenarioReferencesOut(items=items)


async def _scan_refs(db, project_id: str, hit_case_ids: set[str],
                     hit_def_ids: set[str]) -> dict[str, list[schemas.ScenarioReferenceItem]]:
    """一趟扫完全项目未回收场景，按被引用 id 归组。返回 {case_id|definition_id: [引用者]}。

    不用 visible_clause：删除保护的口径必须比「看得见」更宽——别人的私有场景也指着
    这条用例，删了它照样是坏的。可见性只影响**能不能说出名字**（见 details_hidden）。
    """
    out: dict[str, list[schemas.ScenarioReferenceItem]] = {}
    if not (hit_case_ids or hit_def_ids):
        return out
    rows = (await db.execute(
        select(Scenario).where(Scenario.project_id == project_id, Scenario.status == "normal")
    )).scalars().all()
    for s in rows:
        if not isinstance(s.step_graph, dict):
            continue
        for node, _parent, _depth in iter_nodes(s.step_graph):
            kind, ref = node.get("kind"), str(node.get("ref") or "")
            if not ref:
                continue
            hit = ref in hit_case_ids if kind == "api_case" else ref in hit_def_ids
            if not hit:
                continue
            bucket = out.setdefault(ref, [])
            # 同一场景里多处引用同一目标只出一条，key 合并（引用表按场景一行才读得懂）
            found = next((i for i in bucket if i.scenario_id == s.id), None)
            if found is None:
                bucket.append(schemas.ScenarioReferenceItem(
                    scenario_id=s.id, scenario_name=s.name,
                    step_keys=[str(node.get("key") or "")], sort=s.priority or "P2"))
            else:
                found.step_keys.append(str(node.get("key") or ""))
    for bucket in out.values():
        for it in bucket:
            it.step_keys = sorted(set(it.step_keys))
        bucket.sort(key=lambda x: (x.sort, x.scenario_id))
    return out


@service(
    perm="scenario:read", effect="read", name="scenario_case_refs",
    description="批量查引用这些用例/接口定义的未回收场景（供删除保护内部调用；无 scenario:read 时数量照报、明细隐瞒）",
    http=None, tool=False, resident=False,
)
async def scenario_case_refs(payload: schemas.ScenarioCaseRefsIn, ctx) -> schemas.ScenarioCaseRefsOut:
    """删除保护的引用查询（1B Review Focus 9 勘误后的 ①② 两条都走这里）。

    与 scenario_references 的三点有意分歧：
    ① 批量入参——数据集删除会牵出一批用例，逐个问是 N+1 次全场景扫；
    ② 不因缺 scenario:read 而 403——拦不拦由**数据**决定，不由查看引用所需的权限决定，
       否则一个没有场景权限的人反而能绕开保护直接删；
    ③ 无权限时 details_hidden=True 且明细为空——「查不到是谁」要说出口，
       不能退化成「没人引用」这种会让人误删的假安慰。
    """
    await ensure_project_access(ctx, payload.project_id)  # 只查归属，不 require scenario:read
    assert ctx.db is not None
    found = await _scan_refs(ctx.db, payload.project_id, set(payload.case_ids),
                             set(payload.definition_ids))
    may_see = match_perm(ctx.perms, "scenario:read")
    groups = [schemas.ScenarioRefGroup(ref_id=rid, count=len(items),
                                      items=items if may_see else [])
              for rid, items in sorted(found.items()) if items]
    return schemas.ScenarioCaseRefsOut(
        groups=groups, details_hidden=not may_see and any(g.count for g in groups))



# ══════════════════════════ T11：执行 / 调试 / 取消 / 单步重跑 ══════════════════════════
#
# 分工重申：@service 只做「资格判定 + 参数口径 + 投递」，编排在 orchestration，
# 引擎在 engine/。run_rerun_step 例外——单步重跑是同步等待的（run_single_step 本就
# await 到终态，裁定⑤），所以 web 进程必须装载引擎：这不是对 R42「web 不加载引擎」
# 的背叛——那条纪律约束的是**批量执行**的投递路径（celery 档下 web 连引擎都不 import）；
# 重跑一次只跑一步、当场回结果，硬套 worker 队列只会把一个同步交互拆成轮询。

# 仅供测试注入（1A set_debug_transport 同款，裁定②）。类型写成 object 会让调用点
# 报「object not callable」，而它确实是零参工厂（tests 注入 lambda: ASGITransport(...)）。
_transport_factory: Callable[[], Any] | None = None


def set_debug_transport(factory) -> None:
    global _transport_factory
    _transport_factory = factory


def _actor_from(ctx) -> dict:
    """身份快照随 run 走（T9 裁定：由触发点携带，orchestration 不反查 IAM）。"""
    return {"user_id": ctx.user_id, "user_name": ctx.user_name,
            "is_system_admin": bool(ctx.is_system_admin), "perms": set(ctx.perms or set()),
            "entry": ctx.entry}


async def _env_name_for(ctx, project_id: str, env_id: str | None) -> str | None:
    """run 行的 env_name 展示快照：经注册表问 env 模块（契约 1）。

    env_id 给了就必须解析得出——「选了个不存在/没权限的环境」要在**点运行的时候**
    失败，而不是让 run 出生后再在执行期报「环境不可用」。
    """
    if not env_id:
        return None
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("env_resolve")
    if spec is None:
        raise ApiError("internal_error", "env_resolve 未注册（服务尚未初始化完成）", 500)
    out = await spec.handler(spec.model.model_validate({"project_id": project_id,
                                                        "env_id": env_id}), ctx)
    return out.model_dump().get("env_name") or None


@service(
    perm="scenario:run", effect="write", name="scenario_run",
    description="执行场景：建 queued run 并投递给 worker（inline 档为同进程协程）；"
                "trigger 由入口自动决定（HTTP=manual，Agent=agent），调用方不可自选",
    http={"method": "POST", "path": "/scenarios/{scenario_id}/run", "tags": ["scenario"]},
)
async def scenario_run(payload: schemas.ScenarioRunIn, ctx) -> schemas.RunEnqueueOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:run")
    assert ctx.db is not None
    from app.modules.scenario.orchestration import enqueue

    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status != "normal":
        raise ApiError("not_found", "场景不存在（在回收站）", 404, {"scenario_id": s.id})
    env_id = payload.env_id or s.env_id
    env_name = await _env_name_for(ctx, payload.project_id, env_id)
    # trigger 是事实记录（裁定⑥）：入口是什么就写什么；schedule 是第三种真实入口
    # （计划定时执行经本服务建子 run，entry="schedule" → trigger="schedule"）。
    trigger = trigger_from_entry(ctx.entry)
    rec = await enqueue(ctx.db, project_id=payload.project_id, subject_id=s.id,
                        subject_name=s.name, trigger=trigger, created_by=ctx.user_id,
                        env_id=env_id, env_name=env_name,
                        max_runtime_ms=s.max_runtime_ms, actor=_actor_from(ctx),
                        transport=_transport_factory() if _transport_factory else None)
    rid = rec.id  # 先取标量（commit 过期实例的坑，同 T9）
    return schemas.RunEnqueueOut(run_id=rid, status=rec.status)


@service(
    perm="scenario:run", effect="write", name="scenario_debug",
    description="调试场景：跑**传入**的 step_graph（未保存也许可 debug，§11.5.6）；"
                "trigger=debug，图随 run 行快照自包含，不回写「最近结果」",
    http={"method": "POST", "path": "/scenarios/{scenario_id}/debug", "tags": ["scenario"]},
)
async def scenario_debug(payload: schemas.ScenarioDebugIn, ctx) -> schemas.RunEnqueueOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:run")
    assert ctx.db is not None
    from app.modules.scenario.orchestration import enqueue

    s = await _scen(ctx.db, payload.project_id, payload.scenario_id)
    assert_row_visible(s, ctx, what="场景不存在")
    if s.status != "normal":
        raise ApiError("not_found", "场景不存在（在回收站）", 404, {"scenario_id": s.id})
    # 保存期同一口径的 validate（T4）：画布问题面板的 issue 原样带回 422
    issues = _issues_for(payload.graph)
    if issues:
        raise ApiError("validation_error", "调试图校验未通过：共 " + str(len(issues)) +
                       " 个问题", 422, {"issues": issues})
    env_id = payload.env_id or s.env_id
    env_name = await _env_name_for(ctx, payload.project_id, env_id)
    # 快照三件套同源（T11 裁定①）：graph/variables 本来就取草稿，fail_fast 也是草稿的一部分——
    # 抽屉显示草稿策略而执行用库里旧策略，同一个函数里自相矛盾，截图即穿帮。
    # None=本次没改，继承保存行；入队后快照自包含，_run_claimed 只读快照。
    # T20b：common_assertions 也在入队时解析进快照（取保存行——公共断言在场景级面板编辑，
    # 调试抽屉不携带草稿值）：debug 与 manual 同路都读快照，行在执行前被改也不漂移（裁定①）。
    snapshot = {"graph": payload.graph, "variables": dict(payload.variables or {}),
                "fail_fast": bool(s.fail_fast) if payload.fail_fast is None
                else payload.fail_fast,
                "common_assertions": list(s.common_assertions or [])}
    rec = await enqueue(ctx.db, project_id=payload.project_id, subject_id=s.id,
                        subject_name=s.name, trigger="debug", created_by=ctx.user_id,
                        env_id=env_id, env_name=env_name,
                        max_runtime_ms=s.max_runtime_ms, actor=_actor_from(ctx),
                        transport=_transport_factory() if _transport_factory else None,
                        request_snapshot=snapshot)
    rid = rec.id
    return schemas.RunEnqueueOut(run_id=rid, status=rec.status)


# D164 裁定①：取消钥匙按 run 的域解析 = 三个执行门位的逐字镜像（scenario_run / ui_case_run /
# adb_case_run 的 perm，逐字相等由 test_d164 对 REGISTRY 实钉）；未知域 fail closed（宁抛不装绿）。
_RUN_CANCEL_PERM = {"scenario": "scenario:run", "ui_case": "ui:case:run", "adb_case": "adb:case:run"}


@service(
    perm="scenario:run", effect="write", name="run_cancel",
    description="取消执行中的 run：置取消旗（步骤边界生效，§8.2）；已完成步骤保留可读",
    http={"method": "POST", "path": "/runs/{run_id}/cancel", "tags": ["scenario"]},
    resident=False, dynamic_perm=True,
)
async def run_cancel(payload: schemas.RunCancelIn, ctx) -> schemas.RunCancelOut:
    await ensure_project_access(ctx, payload.project_id)
    assert ctx.db is not None
    from app.core.eventbus import get_bus
    from app.modules.execution.models import RunRecord
    from app.modules.scenario.engine.events import request_cancel

    rec = (await ctx.db.execute(
        select(RunRecord).where(RunRecord.id == payload.run_id,
                                RunRecord.project_id == payload.project_id)
    )).scalars().first()
    if rec is None:
        raise ApiError("not_found", "运行不存在", 404, {"run_id": payload.run_id})
    perm = _RUN_CANCEL_PERM.get(rec.subject_type)  # D164：先读行、域定钥匙；未知域 fail closed
    if perm is None:
        raise ApiError("ungoverned_subject", "该 run 的域（" + rec.subject_type + "）没有已知的执行权限位可以治理取消",
                       403, {"subject_type": rec.subject_type})
    ctx.require(perm)
    if rec.status in ("passed", "failed", "error", "cancelled"):
        # 取消一个跑完的 run 是用户点错了，不是成功 no-op（裁定④）：说清楚。
        raise ApiError("already_finished", "运行已结束（" + rec.status + "），无需取消",
                       409, {"run_id": payload.run_id, "status": rec.status})
    await request_cancel(get_bus(), payload.run_id)
    rec.cancel_requested = 1
    await ctx.db.commit()
    return schemas.RunCancelOut(ok=True, status=rec.status)


@service(
    perm="scenario:run", effect="write", name="run_rerun_step",
    description="单步重跑：从来源 run 的落库快照重建上下文只跑该步（§8.3）；"
                "同步等待，响应即终态；明细缺失 409 snapshot_missing",
    http={"method": "POST", "path": "/runs/{run_id}/rerun-step", "tags": ["scenario"]},
    resident=False,
)
async def run_rerun_step(payload: schemas.RerunStepIn, ctx) -> schemas.RerunStepOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:run")
    assert ctx.db is not None
    from app.modules.execution.models import RunRecord
    from app.modules.scenario.engine.runner import run_single_step

    src = (await ctx.db.execute(
        select(RunRecord.id).where(RunRecord.id == payload.run_id,
                                   RunRecord.project_id == payload.project_id)
    )).first()
    if src is None:
        raise ApiError("not_found", "运行不存在", 404, {"run_id": payload.run_id})
    new_id = await run_single_step(
        ctx.db, project_id=payload.project_id, source_run_id=payload.run_id,
        step_key=payload.step_key, row_no=payload.row_no, env_id=payload.env_id,
        transport=_transport_factory() if _transport_factory else None,
        actor=_actor_from(ctx), trigger="manual", created_by=ctx.user_id)
    # 先取标量：run_single_step 内部多次 commit 会过期实例
    new = await ctx.db.get(RunRecord, new_id)
    return schemas.RerunStepOut(run_id=new_id, status=new.status,
                                rerun_of=payload.run_id)
