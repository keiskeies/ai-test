"""API 模块树 @service（T9）：无限级 + 环检测 + 回收站（§4.4）。"""
from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.api_test import schemas
from app.modules.api_test.models import ApiDefinition, ApiModule


async def _mod(db, project_id: str, module_id: str) -> ApiModule:
    m = (await db.execute(select(ApiModule).where(ApiModule.id == module_id,
                                      ApiModule.project_id == project_id))).scalar_one_or_none()
    if m is None:
        raise ApiError("not_found", "模块不存在", 404, {"module_id": module_id})
    return m


async def _dup_check(db, project_id: str, parent_id: str | None, name: str, exclude: str | None = None) -> None:
    """同层级查重。回收站里的同名同样要拦。

    这层判断是唯一守门人：根模块 parent_id 为 NULL，而 MySQL 的唯一键不判等 NULL，
    uq_module_parent_name 对根层级根本不生效（非根才兜得住）。放过回收站的墓碑行，
    就会在同一层级真建出两个同名模块——树里两根一模一样的名字，用户无从分辨哪根是有用的。
    """
    stmt = select(ApiModule).where(ApiModule.project_id == project_id, ApiModule.name == name)
    stmt = stmt.where(ApiModule.parent_id.is_(None) if parent_id is None
                       else ApiModule.parent_id == parent_id)
    if exclude:
        stmt = stmt.where(ApiModule.id != exclude)
    # 历史数据里可能已经存在多根同名（本检查修好之前建的），取一条足以说明问题
    hit = (await db.execute(stmt)).scalars().first()
    if hit is None:
        return
    if hit.status == "recycled":
        raise ApiError("conflict", "同层级下有个同名模块在回收站里：先恢复它，或者换个名字", 409,
                       {"name": name})
    raise ApiError("conflict", "同层级下模块名已存在", 409, {"name": name})

async def _descendants(db, project_id: str, root_id: str) -> list[str]:
    """一次查全量 + 内存 BFS（防 N+1）。含 root 自身。"""
    rows = (await db.execute(select(ApiModule.id, ApiModule.parent_id).where(
        ApiModule.project_id == project_id))).all()
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
    await _mod(db, project_id, new_parent)  # 新父必须存在
    if module_id is not None:
        if new_parent in await _descendants(db, project_id, module_id):
            raise ApiError("invalid_input", "不能挂到自己的子孙下（会形成环）", 400)


@service(
    perm="api:module:read", effect="read", name="api_module_tree",
    description="整棵接口模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点）",
    http={"method": "GET", "path": "/api-modules", "tags": ["api_test"]},
)
async def api_module_tree(payload: schemas.ModuleTreeIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:module:read")
    assert ctx.db is not None
    from app.shared.visibility import visible_clause

    mods = (await ctx.db.execute(select(ApiModule).where(
        ApiModule.project_id == payload.project_id).order_by(ApiModule.sort, ApiModule.name))).scalars().all()
    cnt_rows = (await ctx.db.execute(
        select(ApiDefinition.module_id, func.count())
        .where(ApiDefinition.project_id == payload.project_id,
               visible_clause(ApiDefinition, ctx), ApiDefinition.status != "recycled")
        .group_by(ApiDefinition.module_id))).all()
    counts = {m: c for m, c in cnt_rows if m}
    nodes = {m.id: schemas.ModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort,
                                       status=m.status, count=counts.get(m.id, 0), children=[])
             for m in mods}
    # 回收子树整体折叠：从回收根向下收集（含自身），默认视图剔除，include_recycled 时作为 recycled 根
    parent_of = {m.id: m.parent_id for m in mods}
    status_of = {m.id: m.status for m in mods}

    # D47-b 步 4a：徽标从「直属计数」翻成**子树计数**——与列表的 module_ids 子树筛选是
    # 同一条裁定（MS 语义「点模块看整棵子树」，owner 推翻 T23/R120 的直属旧口径；徽标与
    # 列表必须同口径，否则「徽标写 3、列表出 7」那个谎只是换了方向）。
    # 实现 = 一次内存后序归并（先孩子后父亲，按深度降序），**不是**逐节点再查一次——
    # N+1 是这里的失效模式。叶子徽标天然 = 直属（它没有可加的孩子）。
    # 上流边界只有一条：回收节点的计数**不**流入正常父节点。回收子树在默认视图里不可见、
    # 前端拿不到它们的 id、列表查询也就永远不带它们——让它们的接口计入可见父亲的徽标，
    # 恰好把刚消灭的那个谎原样请回来。回收集群内部照常累加（include_recycled 视图下
    # 回收根的徽标与它的子树列表同样对得上）。
    depth: dict[str, int] = {}

    def _depth(nid: str) -> int:
        hit = depth.get(nid)
        if hit is not None:
            return hit
        par = parent_of.get(nid)
        hit = 0 if par is None or par not in parent_of else _depth(par) + 1
        depth[nid] = hit
        return hit

    for nid in sorted(parent_of, key=_depth, reverse=True):
        par = parent_of.get(nid)
        if par is not None and par in nodes and (status_of[nid] != "recycled" or status_of[par] == "recycled"):
            nodes[par].count += nodes[nid].count

    def _hidden(nid: str) -> bool:
        cur: str | None = nid
        while cur is not None and cur in status_of:
            if status_of[cur] == "recycled":
                return True
            cur = parent_of.get(cur)
        return False

    tree: list[schemas.ModuleNode] = []
    recycled: list[schemas.ModuleNode] = []
    for m in mods:
        n = nodes[m.id]
        if _hidden(m.id):
            if not payload.include_recycled:
                continue
            par = parent_of[m.id] if parent_of[m.id] in parent_of else None
            if status_of[m.id] == "recycled" and (par is None or not _hidden(par)):
                recycled.append(n)  # 回收集群根
            elif par is not None and status_of[par] == "recycled":
                nodes[par].children.append(n)  # 回收集群内部挂接
            continue
        if m.parent_id and m.parent_id in nodes and not _hidden(m.parent_id):
            nodes[m.parent_id].children.append(n)
        else:
            tree.append(n)
    return schemas.ModuleTreeOut(tree=tree, recycled=recycled)


@service(
    perm="api:module:create", effect="write", name="api_module_create",
    description="新建接口模块（同父重名 409）",
    http={"method": "POST", "path": "/api-modules", "tags": ["api_test"], "status": 201},
)
async def api_module_create(payload: schemas.ModuleCreateIn, ctx) -> schemas.ModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:module:create")
    assert ctx.db is not None
    await _ensure_parent_ok(ctx.db, payload.project_id, None, payload.parent_id)
    await _dup_check(ctx.db, payload.project_id, payload.parent_id, payload.name)
    m = ApiModule(project_id=payload.project_id, parent_id=payload.parent_id,
                  name=payload.name, sort=payload.sort)
    ctx.db.add(m)
    await ctx.db.commit()
    return schemas.ModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort)


@service(
    perm="api:module:update", effect="write", name="api_module_update",
    description="改名/排序/移动模块（parent_id 显式传入即移动，null=移到根；成环 400）",
    http={"method": "PATCH", "path": "/api-modules/{module_id}", "tags": ["api_test"]},
)
async def api_module_update(payload: schemas.ModuleUpdateIn, ctx) -> schemas.ModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:module:update")
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
    return schemas.ModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status)


async def _set_status_subtree(db, project_id: str, module_id: str, status: str) -> int:
    ids = await _descendants(db, project_id, module_id)
    rows = (await db.execute(select(ApiModule).where(ApiModule.id.in_(ids)))).scalars().all()
    for r in rows:
        r.status = status
    return len(rows)


@service(
    perm="api:module:delete", effect="destructive", name="api_module_delete",
    description="把模块连子孙放入回收站（软删；接口不删，恢复后原样回归）",
    http={"method": "POST", "path": "/api-modules/{module_id}/delete", "tags": ["api_test"]},
    resident=False,
)
async def api_module_delete(payload: schemas.ModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:module:delete")
    assert ctx.db is not None
    await _mod(ctx.db, payload.project_id, payload.module_id)
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, "recycled")
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="api:module:delete",
    effect="destructive",
    name="api_module_purge",
    description="彻底删除回收站中的模块（连子孙一起物理删除；其下接口改为未分类，不连带删除；不可恢复）",
    http={"method": "POST", "path": "/api-modules/{module_id}/purge", "tags": ["api_test"]},
    tool=False,
    resident=False,
)
async def api_module_purge(payload: schemas.ModulePurgeIn, ctx) -> BaseModel:
    """回收站的出口（§11.4.18）。两点与接口彻底删除不同，都是有意的：

    1) 接口不陪葬。模块是收纳方式，接口是资产；删收纳盒不该烧掉里面的东西，
       只把归属清空（变未分类），接口自己还能走一遍它自己的回收站。
    2) 族谱状态不一致就不动手。正常视图里看得见的模块不能被后台悄悄删掉。
    回执给出删了几层模块、脱管几个接口：不可逆操作至少要让人知道动了什么。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:module:delete")
    assert ctx.db is not None
    m = await _mod(ctx.db, payload.project_id, payload.module_id)
    if m.status != "recycled":
        raise ApiError("not_recycled", "只能彻底删除回收站里的模块：请先放入回收站", 409,
                       {"module_id": m.id})
    if payload.confirm_name != m.name:
        raise ApiError("name_mismatch", "确认名称与模块名不一致，未删除", 409,
                       {"module_id": m.id})
    ids = await _descendants(ctx.db, payload.project_id, m.id)
    rows = (await ctx.db.execute(select(ApiModule).where(ApiModule.id.in_(ids)))).scalars().all()
    if any(r.status != "recycled" for r in rows):
        raise ApiError("state_conflict", "该模块子树里还有未回收的节点，先处理完再来", 409,
                       {"module_id": m.id, "normal_children": [r.name for r in rows if r.status != "recycled"]})
    defs = (await ctx.db.execute(select(ApiDefinition).where(
        ApiDefinition.project_id == payload.project_id,
        ApiDefinition.module_id.in_(ids)))).scalars().all()
    for d in defs:
        d.module_id = None
    for r in rows:
        await ctx.db.delete(r)
    await ctx.db.commit()
    return schemas.ModulePurgeOut(ok=True, purged_modules=len(rows), detached_definitions=len(defs))


@service(
    perm="api:module:update", effect="write", name="api_module_restore",
    description="从回收站恢复模块（子孙一并回归）",
    http={"method": "POST", "path": "/api-modules/{module_id}/restore", "tags": ["api_test"]},
    resident=False,
)
async def api_module_restore(payload: schemas.ModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:module:update")
    assert ctx.db is not None
    m = await _mod(ctx.db, payload.project_id, payload.module_id)
    # 父级还在回收站 → 先恢复父级（否则恢复出来的节点不可达）
    cur = m.parent_id
    guard = 0
    while cur and guard < 64:
        p = await ctx.db.get(ApiModule, cur)
        if p is None or p.status != "recycled":
            break
        p.status = "normal"
        cur = p.parent_id
        guard += 1
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, "normal")
    await ctx.db.commit()
    return schemas.OkOut(ok=True)
