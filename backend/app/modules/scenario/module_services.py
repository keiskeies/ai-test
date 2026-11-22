"""场景模块树 @service（1B R45）：无限级 + 环检测 + 回收站，语义镜像 api_module。

与 api_module 的有意差异：
- 权限位 scenario:module:*（R45：api:module:* 不该管场景，两棵树引用完整性不共享）。
- count 数的是直属**未回收**场景（含可见性过滤），不是接口定义。
- 模块彻底删除时场景不陪葬（场景是资产、模块是收纳方式），只把 module_id 置 None。
"""
from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.scenario import schemas
from app.modules.scenario.models import STATUS_RECYCLED, Scenario, ScenarioModule
from app.shared.visibility import visible_clause


async def _mod(db, project_id: str, module_id: str) -> ScenarioModule:
    m = (await db.execute(select(ScenarioModule).where(ScenarioModule.id == module_id,
                                                       ScenarioModule.project_id == project_id))).scalar_one_or_none()
    if m is None:
        raise ApiError("not_found", "场景模块不存在", 404, {"module_id": module_id})
    return m


async def _dup_check(db, project_id: str, parent_id: str | None, name: str, exclude: str | None = None) -> None:
    """同层级查重，回收站里的同名同样要拦。

    根模块 parent_id 为 NULL，MySQL 唯一键不判等 NULL，uq_scenario_module_parent_name
    对根层不生效——这一层是根层重名的唯一守门人（1A 在 api_module 上踩过的坑）。
    放过回收站的墓碑行，就会在同一层级建出两个同名模块，树里两根一模一样。
    """
    stmt = select(ScenarioModule).where(ScenarioModule.project_id == project_id, ScenarioModule.name == name)
    stmt = stmt.where(ScenarioModule.parent_id.is_(None) if parent_id is None
                      else ScenarioModule.parent_id == parent_id)
    if exclude:
        stmt = stmt.where(ScenarioModule.id != exclude)
    hit = (await db.execute(stmt)).scalars().first()
    if hit is None:
        return
    if hit.status == STATUS_RECYCLED:
        raise ApiError("conflict", "同层级下有个同名模块在回收站里：先恢复它，或者换个名字", 409,
                       {"name": name})
    raise ApiError("conflict", "同层级下模块名已存在", 409, {"name": name})


async def _descendants(db, project_id: str, root_id: str) -> list[str]:
    """一次查全量 + 内存 BFS（防 N+1）。含 root 自身。"""
    rows = (await db.execute(select(ScenarioModule.id, ScenarioModule.parent_id).where(
        ScenarioModule.project_id == project_id))).all()
    kids: dict[str, list[str]] = {}
    for mid, pid in rows:
        kids.setdefault(pid or "", []).append(mid)
    out: list[str] = []
    stack = [root_id]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(kids.get(cur, []))
    return out


async def _ensure_parent_ok(db, project_id: str, module_id: str | None, new_parent: str | None) -> None:
    if new_parent is None:
        return
    if module_id is not None and new_parent == module_id:
        raise ApiError("invalid_input", "模块不能挂到自己下面", 400)
    await _mod(db, project_id, new_parent)
    if module_id is not None:
        if new_parent in await _descendants(db, project_id, module_id):
            raise ApiError("invalid_input", "不能挂到自己的子孙下（会形成环）", 400)


@service(
    perm="scenario:module:read", effect="read", name="scenario_module_tree",
    description="整棵场景模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点）",
    http={"method": "GET", "path": "/scenario-modules", "tags": ["scenario"]},
)
async def scenario_module_tree(payload: schemas.ScenarioModuleTreeIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:module:read")
    assert ctx.db is not None

    mods = (await ctx.db.execute(select(ScenarioModule).where(
        ScenarioModule.project_id == payload.project_id).order_by(ScenarioModule.sort, ScenarioModule.name))).scalars().all()
    cnt_rows = (await ctx.db.execute(
        select(Scenario.module_id, func.count())
        .where(Scenario.project_id == payload.project_id,
               visible_clause(Scenario, ctx), Scenario.status != STATUS_RECYCLED)
        .group_by(Scenario.module_id))).all()
    counts = {m: c for m, c in cnt_rows if m}
    nodes = {m.id: schemas.ScenarioModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort,
                                              status=m.status, count=counts.get(m.id, 0), children=[])
             for m in mods}
    parent_of = {m.id: m.parent_id for m in mods}
    status_of = {m.id: m.status for m in mods}

    def _hidden(nid: str) -> bool:
        cur: str | None = nid
        while cur is not None and cur in status_of:
            if status_of[cur] == STATUS_RECYCLED:
                return True
            cur = parent_of.get(cur)
        return False

    tree: list[schemas.ScenarioModuleNode] = []
    recycled: list[schemas.ScenarioModuleNode] = []
    for m in mods:
        n = nodes[m.id]
        if _hidden(m.id):
            if not payload.include_recycled:
                continue
            par = parent_of[m.id] if parent_of[m.id] in parent_of else None
            if status_of[m.id] == STATUS_RECYCLED and (par is None or not _hidden(par)):
                recycled.append(n)
            elif par is not None and status_of[par] == STATUS_RECYCLED:
                nodes[par].children.append(n)
            continue
        if m.parent_id and m.parent_id in nodes and not _hidden(m.parent_id):
            nodes[m.parent_id].children.append(n)
        else:
            tree.append(n)
    return schemas.ScenarioModuleTreeOut(tree=tree, recycled=recycled)


@service(
    perm="scenario:module:create", effect="write", name="scenario_module_create",
    description="新建场景模块（同父重名 409；根层重名同样 409——MySQL 唯一键不判等 NULL，根层由服务层自查）",
    http={"method": "POST", "path": "/scenario-modules", "tags": ["scenario"], "status": 201},
)
async def scenario_module_create(payload: schemas.ScenarioModuleCreateIn, ctx) -> schemas.ScenarioModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:module:create")
    assert ctx.db is not None
    await _ensure_parent_ok(ctx.db, payload.project_id, None, payload.parent_id)
    await _dup_check(ctx.db, payload.project_id, payload.parent_id, payload.name)
    m = ScenarioModule(project_id=payload.project_id, parent_id=payload.parent_id,
                       name=payload.name, sort=payload.sort)
    ctx.db.add(m)
    await ctx.db.commit()
    return schemas.ScenarioModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort)


@service(
    perm="scenario:module:update", effect="write", name="scenario_module_update",
    description="改名/排序/移动场景模块（parent_id 显式传入即移动，null=移到根；成环 400）",
    http={"method": "PATCH", "path": "/scenario-modules/{module_id}", "tags": ["scenario"]},
)
async def scenario_module_update(payload: schemas.ScenarioModuleUpdateIn, ctx) -> schemas.ScenarioModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:module:update")
    assert ctx.db is not None
    m = await _mod(ctx.db, payload.project_id, payload.module_id)
    moving = "parent_id" in payload.model_fields_set
    new_parent = payload.parent_id if moving else m.parent_id
    if moving:
        await _ensure_parent_ok(ctx.db, payload.project_id, m.id, new_parent)
    new_name = payload.name if payload.name is not None else m.name
    if moving or payload.name is not None:
        await _dup_check(ctx.db, payload.project_id, new_parent, new_name, exclude=m.id)
    if payload.name is not None:
        m.name = payload.name
    if payload.sort is not None:
        m.sort = payload.sort
    if moving:
        m.parent_id = new_parent
    await ctx.db.commit()
    return schemas.ScenarioModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status)


async def _set_status_subtree(db, project_id: str, module_id: str, status: str) -> int:
    ids = await _descendants(db, project_id, module_id)
    rows = (await db.execute(select(ScenarioModule).where(ScenarioModule.id.in_(ids)))).scalars().all()
    for r in rows:
        r.status = status
    return len(rows)


@service(
    perm="scenario:module:delete", effect="destructive", name="scenario_module_delete",
    description="把场景模块连子孙放入回收站（软删；场景不删，恢复后原样回归）",
    http={"method": "POST", "path": "/scenario-modules/{module_id}/delete", "tags": ["scenario"]},
    resident=False,
)
async def scenario_module_delete(payload: schemas.ScenarioModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:module:delete")
    assert ctx.db is not None
    await _mod(ctx.db, payload.project_id, payload.module_id)
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, STATUS_RECYCLED)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="scenario:module:update", effect="write", name="scenario_module_restore",
    description="从回收站恢复场景模块（子孙一并回归）",
    http={"method": "POST", "path": "/scenario-modules/{module_id}/restore", "tags": ["scenario"]},
    resident=False,
)
async def scenario_module_restore(payload: schemas.ScenarioModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:module:update")
    assert ctx.db is not None
    m = await _mod(ctx.db, payload.project_id, payload.module_id)
    cur = m.parent_id
    guard = 0
    while cur and guard < 64:
        p = await ctx.db.get(ScenarioModule, cur)
        if p is None or p.status != STATUS_RECYCLED:
            break
        p.status = "normal"
        cur = p.parent_id
        guard += 1
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, "normal")
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="scenario:module:delete", effect="destructive", name="scenario_module_purge",
    description="彻底删除回收站中的场景模块（连子孙一起物理删除；其下场景改为未分类，不连带删除；不可恢复）",
    http={"method": "POST", "path": "/scenario-modules/{module_id}/purge", "tags": ["scenario"]},
    tool=False, resident=False,
)
async def scenario_module_purge(payload: schemas.ScenarioModulePurgeIn, ctx) -> BaseModel:
    """回收站出口。场景是资产、模块是收纳方式：删收纳盒不烧场景，只清空归属（变未分类）。"""
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("scenario:module:delete")
    assert ctx.db is not None
    m = await _mod(ctx.db, payload.project_id, payload.module_id)
    if m.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的模块：请先放入回收站", 409,
                       {"module_id": m.id})
    if payload.confirm_name != m.name:
        raise ApiError("name_mismatch", "确认名称与模块名不一致，未删除", 409,
                       {"module_id": m.id})
    ids = await _descendants(ctx.db, payload.project_id, m.id)
    rows = (await ctx.db.execute(select(ScenarioModule).where(ScenarioModule.id.in_(ids)))).scalars().all()
    if any(r.status != STATUS_RECYCLED for r in rows):
        raise ApiError("state_conflict", "该模块子树里还有未回收的节点，先处理完再来", 409,
                       {"module_id": m.id, "normal_children": [r.name for r in rows if r.status != STATUS_RECYCLED]})
    scs = (await ctx.db.execute(select(Scenario).where(
        Scenario.project_id == payload.project_id, Scenario.module_id.in_(ids)))).scalars().all()
    for s in scs:
        s.module_id = None
    for r in rows:
        await ctx.db.delete(r)
    await ctx.db.commit()
    return schemas.ScenarioModulePurgeOut(ok=True, purged_modules=len(rows), detached_scenarios=len(scs))
