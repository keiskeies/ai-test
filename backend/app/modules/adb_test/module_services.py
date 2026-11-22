"""ADB 模块树 @service（第四棵树，R99）：无限级 + 环检测 + 回收站，语义镜像 api/ui/scenario。

与前三棵树的有意差异：
- 权限位 `adb:module:*`（R45 同一判断：元素的模块回收不该动到接口/场景）。
- **单一资产**：树服务的资产只有 ADB 用例（adb_case），所以节点只有 `count`
  （直属未回收用例数），没有 ui 树那组 element_count/case_count 分列。
- 模块彻底删除时用例**不陪葬**（模块是收纳方式），只把 module_id 置 None；
  回执 `detached_cases` 给真实数字。⚠ 前端 `shared/moduleTree.ts` 的删模块提示
  只在认得的回执键上显示数字：T9 复用该组件宽带件时必须一并加宽（T4 条目标注），
  别让「N 条用例转为未分类」静默显示成 0。
"""
from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.adb_test import schemas
from app.modules.adb_test.models import STATUS_RECYCLED, AdbCase, AdbModule
from app.shared.visibility import visible_clause


async def _adb_module(db, project_id: str, module_id: str) -> AdbModule:
    m = (await db.execute(select(AdbModule).where(AdbModule.id == module_id,
                                                  AdbModule.project_id == project_id))).scalar_one_or_none()
    if m is None:
        raise ApiError("not_found", "ADB 模块不存在", 404, {"module_id": module_id})
    return m


async def _dup_check(db, project_id: str, parent_id: str | None, name: str, exclude: str | None = None) -> None:
    """同层级查重，回收站里的同名同样要拦。

    根模块 parent_id 为 NULL，MySQL 唯一键不判等 NULL，uq_adb_module_parent_name 对根层
    不生效——这一层是根层重名的唯一守门人（1A/1B/1C 踩过三次，这是第四次）。
    """
    stmt = select(AdbModule).where(AdbModule.project_id == project_id, AdbModule.name == name)
    stmt = stmt.where(AdbModule.parent_id.is_(None) if parent_id is None
                      else AdbModule.parent_id == parent_id)
    if exclude:
        stmt = stmt.where(AdbModule.id != exclude)
    hit = (await db.execute(stmt)).scalars().first()
    if hit is None:
        return
    if hit.status == STATUS_RECYCLED:
        raise ApiError("conflict", "同层级下有个同名模块在回收站里：先恢复它，或者换个名字", 409,
                       {"name": name})
    raise ApiError("conflict", "同层级下模块名已存在", 409, {"name": name})


async def _descendants(db, project_id: str, root_id: str) -> list[str]:
    """一次查全量 + 内存 BFS（防 N+1）。含 root 自身。"""
    rows = (await db.execute(select(AdbModule.id, AdbModule.parent_id).where(
        AdbModule.project_id == project_id))).all()
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
    await _adb_module(db, project_id, new_parent)
    if module_id is not None:
        if new_parent in await _descendants(db, project_id, module_id):
            raise ApiError("invalid_input", "不能挂到自己的子孙下（会形成环）", 400)


async def _case_counts(db, project_id: str, ctx) -> dict[str, int]:
    rows = (await db.execute(
        select(AdbCase.module_id, func.count())
        .where(AdbCase.project_id == project_id, visible_clause(AdbCase, ctx),
               AdbCase.status != STATUS_RECYCLED)
        .group_by(AdbCase.module_id))).all()
    return {m: c for m, c in rows if m}


@service(
    perm="adb:module:read", effect="read", name="adb_module_tree",
    description="整棵 ADB 模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点）；"
                "count=直属未回收 ADB 用例数",
    http={"method": "GET", "path": "/adb-modules", "tags": ["adb"]},
)
async def adb_module_tree(payload: schemas.AdbModuleTreeIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:module:read")
    assert ctx.db is not None

    mods = (await ctx.db.execute(select(AdbModule).where(
        AdbModule.project_id == payload.project_id).order_by(AdbModule.sort, AdbModule.name))).scalars().all()
    counts = await _case_counts(ctx.db, payload.project_id, ctx)
    nodes = {m.id: schemas.AdbModuleNode(
        id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status,
        count=counts.get(m.id, 0), children=[])
        for m in mods}
    parent_of = {m.id: m.parent_id for m in mods}
    status_of = {m.id: m.status for m in mods}

    def _hidden(nid: str) -> bool:
        """祖先链上有回收站节点 = 整枝都不该出现在正常树里（父在回收站，孩子跟着藏）。"""
        cur: str | None = nid
        while cur is not None and cur in status_of:
            if status_of[cur] == STATUS_RECYCLED:
                return True
            cur = parent_of.get(cur)
        return False

    tree: list[schemas.AdbModuleNode] = []
    recycled: list[schemas.AdbModuleNode] = []
    for m in mods:
        n = nodes[m.id]
        if _hidden(m.id):
            if not payload.include_recycled:
                continue
            par = parent_of[m.id] if parent_of[m.id] in parent_of else None
            if status_of[m.id] == STATUS_RECYCLED and (par is None or not _hidden(par)):
                recycled.append(n)  # 回收根：平铺给回收站视图
            elif par is not None and status_of[par] == STATUS_RECYCLED:
                nodes[par].children.append(n)
            continue
        if m.parent_id and m.parent_id in nodes and not _hidden(m.parent_id):
            nodes[m.parent_id].children.append(n)
        else:
            tree.append(n)
    return schemas.AdbModuleTreeOut(tree=tree, recycled=recycled)


@service(
    perm="adb:module:create", effect="write", name="adb_module_create",
    description="新建 ADB 模块（同父重名 409；根层重名同样 409——MySQL 唯一键不判等 NULL，根层由服务层自查）",
    http={"method": "POST", "path": "/adb-modules", "tags": ["adb"], "status": 201},
)
async def adb_module_create(payload: schemas.AdbModuleCreateIn, ctx) -> schemas.AdbModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:module:create")
    assert ctx.db is not None
    await _ensure_parent_ok(ctx.db, payload.project_id, None, payload.parent_id)
    await _dup_check(ctx.db, payload.project_id, payload.parent_id, payload.name)
    m = AdbModule(project_id=payload.project_id, parent_id=payload.parent_id,
                  name=payload.name, sort=payload.sort)
    ctx.db.add(m)
    await ctx.db.commit()
    return schemas.AdbModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status)


@service(
    perm="adb:module:update", effect="write", name="adb_module_update",
    description="改名/排序/移动 ADB 模块（parent_id 显式传入即移动，null=移到根；成环 400）",
    http={"method": "PATCH", "path": "/adb-modules/{module_id}", "tags": ["adb"]},
)
async def adb_module_update(payload: schemas.AdbModuleUpdateIn, ctx) -> schemas.AdbModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:module:update")
    assert ctx.db is not None
    m = await _adb_module(ctx.db, payload.project_id, payload.module_id)
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
    return schemas.AdbModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status)


async def _set_status_subtree(db, project_id: str, module_id: str, status: str) -> int:
    ids = await _descendants(db, project_id, module_id)
    rows = (await db.execute(select(AdbModule).where(AdbModule.id.in_(ids)))).scalars().all()
    for r in rows:
        r.status = status
    return len(rows)


@service(
    perm="adb:module:delete", effect="destructive", name="adb_module_delete",
    description="把 ADB 模块连子孙放入回收站（软删；用例不删，恢复后原样回归）",
    http={"method": "POST", "path": "/adb-modules/{module_id}/delete", "tags": ["adb"]},
    resident=False,
)
async def adb_module_delete(payload: schemas.AdbModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:module:delete")
    assert ctx.db is not None
    await _adb_module(ctx.db, payload.project_id, payload.module_id)
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, STATUS_RECYCLED)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="adb:module:update", effect="write", name="adb_module_restore",
    description="从回收站恢复 ADB 模块（子孙一并回归）",
    http={"method": "POST", "path": "/adb-modules/{module_id}/restore", "tags": ["adb"]},
    resident=False,
)
async def adb_module_restore(payload: schemas.AdbModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:module:update")
    assert ctx.db is not None
    m = await _adb_module(ctx.db, payload.project_id, payload.module_id)
    # 祖先也得救：只把自己拨回 normal、父级还在回收站，恢复出来的是一棵挂在隐藏节点下的孤儿枝
    cur = m.parent_id
    guard = 0
    while cur and guard < 64:
        p = await ctx.db.get(AdbModule, cur)
        if p is None or p.status != STATUS_RECYCLED:
            break
        p.status = "normal"
        cur = p.parent_id
        guard += 1
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, "normal")
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="adb:module:delete", effect="destructive", name="adb_module_purge",
    description="彻底删除回收站中的 ADB 模块（连子孙一起物理删除；其下用例改为未分类，"
                "不连带删除；不可恢复；须逐字确认模块名）",
    http={"method": "POST", "path": "/adb-modules/{module_id}/purge", "tags": ["adb"]},
    tool=False, resident=False,
)
async def adb_module_purge(payload: schemas.AdbModulePurgeIn, ctx) -> schemas.AdbModulePurgeOut:
    """回收站出口。资产不陪葬：删收纳盒只清空归属（变未分类）。
    ⚠ 回执键 detached_cases：前端 moduleTree 的「N 条用例转为未分类」提示按它显示，
    别让界面拿它当 0（T9 加宽组件时点名过）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:module:delete")
    assert ctx.db is not None
    m = await _adb_module(ctx.db, payload.project_id, payload.module_id)
    if m.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的模块：请先放入回收站", 409,
                       {"module_id": m.id})
    if payload.confirm_name != m.name:
        raise ApiError("name_mismatch", "确认名称与模块名不一致，未删除", 409, {"module_id": m.id})
    ids = await _descendants(ctx.db, payload.project_id, m.id)
    rows = (await ctx.db.execute(select(AdbModule).where(AdbModule.id.in_(ids)))).scalars().all()
    if any(r.status != STATUS_RECYCLED for r in rows):
        raise ApiError("state_conflict", "该模块子树里还有未回收的节点，先处理完再来", 409,
                       {"module_id": m.id, "normal_children": [r.name for r in rows if r.status != STATUS_RECYCLED]})
    cases = (await ctx.db.execute(select(AdbCase).where(
        AdbCase.project_id == payload.project_id, AdbCase.module_id.in_(ids)))).scalars().all()
    for c in cases:
        c.module_id = None
    for r in rows:
        await ctx.db.delete(r)
    await ctx.db.commit()
    return schemas.AdbModulePurgeOut(ok=True, purged_modules=len(rows), detached_cases=len(cases))
