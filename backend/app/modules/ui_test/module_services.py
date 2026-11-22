"""UI 模块树 @service（R99 第三棵树）：无限级 + 环检测 + 回收站，语义镜像 api/scenario 两棵树。

与前两棵树的有意差异：

- 权限位 `ui:module:*`：元素的模块回收不该动到接口，也不该动到场景（R45 的同一判断）。
- **一棵树服务两类资产**（元素 + UI 用例），前两棵树各只服务一类。所以节点上除了
  `count` 还有 `element_count` / `case_count`：`count` 是两者之和（徽标语义 =
  「这个模块里有 N 项资产」），分页要单独显示自己的数字就读那两个字段。
  ⚠ 前端 `web/src/api/ModuleTree.tsx:9-12` 的 `ModNode` 只认 `count`，T14/T17 谁要
  分资产显示谁就得加一个 prop——不是后端能替他决定的事，写在注释里免得静默降级。
- 模块彻底删除时元素与用例**都不陪葬**（模块是收纳方式、资产是资产，1A §5.10 业主已认的
  口径），只把 `module_id` 置 None。
- ⚠ `ModuleTree.tsx:92-96` 读彻底删除的回执时只认 `detached_definitions` /
  `detached_scenarios` 两个键，本端点回的是 `detached_elements` / `detached_cases`：
  不改前端的话提示里「N 个元素转为未分类」会静默变成 0。T14 复用该组件时必须一并加宽。
"""
from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.ui_test import schemas
from app.modules.ui_test.models import STATUS_RECYCLED, UiCase, UiElement, UiModule
from app.shared.visibility import visible_clause


async def _ui_module(db, project_id: str, module_id: str) -> UiModule:
    m = (await db.execute(select(UiModule).where(UiModule.id == module_id,
                                                 UiModule.project_id == project_id))).scalar_one_or_none()
    if m is None:
        raise ApiError("not_found", "UI 模块不存在", 404, {"module_id": module_id})
    return m


async def _dup_check(db, project_id: str, parent_id: str | None, name: str, exclude: str | None = None) -> None:
    """同层级查重，回收站里的同名同样要拦。

    根模块 parent_id 为 NULL，MySQL 唯一键不判等 NULL，uq_ui_module_parent_name 对根层
    不生效——这一层是根层重名的唯一守门人（1A 在 api_module、1B 在 scenario_module
    各踩过一次，这是第三次）。
    """
    stmt = select(UiModule).where(UiModule.project_id == project_id, UiModule.name == name)
    stmt = stmt.where(UiModule.parent_id.is_(None) if parent_id is None
                      else UiModule.parent_id == parent_id)
    if exclude:
        stmt = stmt.where(UiModule.id != exclude)
    hit = (await db.execute(stmt)).scalars().first()
    if hit is None:
        return
    if hit.status == STATUS_RECYCLED:
        raise ApiError("conflict", "同层级下有个同名模块在回收站里：先恢复它，或者换个名字", 409,
                       {"name": name})
    raise ApiError("conflict", "同层级下模块名已存在", 409, {"name": name})


async def _descendants(db, project_id: str, root_id: str) -> list[str]:
    """一次查全量 + 内存 BFS（防 N+1）。含 root 自身。"""
    rows = (await db.execute(select(UiModule.id, UiModule.parent_id).where(
        UiModule.project_id == project_id))).all()
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
    await _ui_module(db, project_id, new_parent)
    if module_id is not None:
        if new_parent in await _descendants(db, project_id, module_id):
            raise ApiError("invalid_input", "不能挂到自己的子孙下（会形成环）", 400)


async def _counts(db, project_id: str, ctx) -> tuple[dict[str, int], dict[str, int]]:
    """直属（不含子孙）未回收元素数 / 用例数，各一条 group_by，含可见性过滤。"""
    async def _by(model) -> dict[str, int]:
        rows = (await db.execute(
            select(model.module_id, func.count())
            .where(model.project_id == project_id, visible_clause(model, ctx),
                   model.status != STATUS_RECYCLED)
            .group_by(model.module_id))).all()
        return {m: c for m, c in rows if m}
    return await _by(UiElement), await _by(UiCase)


@service(
    perm="ui:module:read", effect="read", name="ui_module_tree",
    description="整棵 UI 模块树（默认不含回收站；include_recycled=true 时 recycled 数组返回回收根节点）；"
                "count=直属未回收元素+用例，element_count/case_count 分开给",
    http={"method": "GET", "path": "/ui-modules", "tags": ["ui"]},
)
async def ui_module_tree(payload: schemas.UiModuleTreeIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:module:read")
    assert ctx.db is not None

    mods = (await ctx.db.execute(select(UiModule).where(
        UiModule.project_id == payload.project_id).order_by(UiModule.sort, UiModule.name))).scalars().all()
    el_counts, case_counts = await _counts(ctx.db, payload.project_id, ctx)
    nodes = {m.id: schemas.UiModuleNode(
        id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status,
        element_count=el_counts.get(m.id, 0), case_count=case_counts.get(m.id, 0),
        count=el_counts.get(m.id, 0) + case_counts.get(m.id, 0), children=[])
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

    tree: list[schemas.UiModuleNode] = []
    recycled: list[schemas.UiModuleNode] = []
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
    return schemas.UiModuleTreeOut(tree=tree, recycled=recycled)


@service(
    perm="ui:module:create", effect="write", name="ui_module_create",
    description="新建 UI 模块（同父重名 409；根层重名同样 409——MySQL 唯一键不判等 NULL，根层由服务层自查）",
    http={"method": "POST", "path": "/ui-modules", "tags": ["ui"], "status": 201},
)
async def ui_module_create(payload: schemas.UiModuleCreateIn, ctx) -> schemas.UiModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:module:create")
    assert ctx.db is not None
    await _ensure_parent_ok(ctx.db, payload.project_id, None, payload.parent_id)
    await _dup_check(ctx.db, payload.project_id, payload.parent_id, payload.name)
    m = UiModule(project_id=payload.project_id, parent_id=payload.parent_id,
                 name=payload.name, sort=payload.sort)
    ctx.db.add(m)
    await ctx.db.commit()
    return schemas.UiModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status)


@service(
    perm="ui:module:update", effect="write", name="ui_module_update",
    description="改名/排序/移动 UI 模块（parent_id 显式传入即移动，null=移到根；成环 400）",
    http={"method": "PATCH", "path": "/ui-modules/{module_id}", "tags": ["ui"]},
)
async def ui_module_update(payload: schemas.UiModuleUpdateIn, ctx) -> schemas.UiModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:module:update")
    assert ctx.db is not None
    m = await _ui_module(ctx.db, payload.project_id, payload.module_id)
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
    return schemas.UiModuleNode(id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, status=m.status)


async def _set_status_subtree(db, project_id: str, module_id: str, status: str) -> int:
    ids = await _descendants(db, project_id, module_id)
    rows = (await db.execute(select(UiModule).where(UiModule.id.in_(ids)))).scalars().all()
    for r in rows:
        r.status = status
    return len(rows)


@service(
    perm="ui:module:delete", effect="destructive", name="ui_module_delete",
    description="把 UI 模块连子孙放入回收站（软删；元素与用例都不删，恢复后原样回归）",
    http={"method": "POST", "path": "/ui-modules/{module_id}/delete", "tags": ["ui"]},
    resident=False,
)
async def ui_module_delete(payload: schemas.UiModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:module:delete")
    assert ctx.db is not None
    await _ui_module(ctx.db, payload.project_id, payload.module_id)
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, STATUS_RECYCLED)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="ui:module:update", effect="write", name="ui_module_restore",
    description="从回收站恢复 UI 模块（子孙一并回归）",
    http={"method": "POST", "path": "/ui-modules/{module_id}/restore", "tags": ["ui"]},
    resident=False,
)
async def ui_module_restore(payload: schemas.UiModuleDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:module:update")
    assert ctx.db is not None
    m = await _ui_module(ctx.db, payload.project_id, payload.module_id)
    # 祖先也得救：只把自己拨回 normal、父级还在回收站，恢复出来的是一棵挂在隐藏节点下的孤儿枝
    cur = m.parent_id
    guard = 0
    while cur and guard < 64:
        p = await ctx.db.get(UiModule, cur)
        if p is None or p.status != STATUS_RECYCLED:
            break
        p.status = "normal"
        cur = p.parent_id
        guard += 1
    await _set_status_subtree(ctx.db, payload.project_id, payload.module_id, "normal")
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="ui:module:delete", effect="destructive", name="ui_module_purge",
    description="彻底删除回收站中的 UI 模块（连子孙一起物理删除；其下元素与用例改为未分类，"
                "不连带删除；不可恢复；须逐字确认模块名）",
    http={"method": "POST", "path": "/ui-modules/{module_id}/purge", "tags": ["ui"]},
    tool=False, resident=False,
)
async def ui_module_purge(payload: schemas.UiModulePurgeIn, ctx) -> schemas.UiModulePurgeOut:
    """回收站出口。资产不陪葬：删收纳盒只清空归属（变未分类）。"""
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:module:delete")
    assert ctx.db is not None
    m = await _ui_module(ctx.db, payload.project_id, payload.module_id)
    if m.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的模块：请先放入回收站", 409,
                       {"module_id": m.id})
    if payload.confirm_name != m.name:
        raise ApiError("name_mismatch", "确认名称与模块名不一致，未删除", 409, {"module_id": m.id})
    ids = await _descendants(ctx.db, payload.project_id, m.id)
    rows = (await ctx.db.execute(select(UiModule).where(UiModule.id.in_(ids)))).scalars().all()
    if any(r.status != STATUS_RECYCLED for r in rows):
        raise ApiError("state_conflict", "该模块子树里还有未回收的节点，先处理完再来", 409,
                       {"module_id": m.id, "normal_children": [r.name for r in rows if r.status != STATUS_RECYCLED]})
    els = (await ctx.db.execute(select(UiElement).where(
        UiElement.project_id == payload.project_id, UiElement.module_id.in_(ids)))).scalars().all()
    for e in els:
        e.module_id = None
    scs = (await ctx.db.execute(select(UiCase).where(
        UiCase.project_id == payload.project_id, UiCase.module_id.in_(ids)))).scalars().all()
    for s in scs:
        s.module_id = None
    for r in rows:
        await ctx.db.delete(r)
    await ctx.db.commit()
    return schemas.UiModulePurgeOut(ok=True, purged_modules=len(rows),
                                    detached_elements=len(els), detached_cases=len(scs))
