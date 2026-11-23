"""功能用例域 @service（D193）：用例本体 + 模块树 + 自定义值 + 回收站。

评审（127 端点里的 38）留给 D194；附件/需求关联/关系图仍是后续域。
脑图在 D268 补齐：只读树 + 便签（空白节点）的新增/改名/移动/删除。
模板与取号走 `project_meta` 的内部服务（REGISTRY 派发），零横向 import。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import column, func, select, table
from sqlalchemy import delete as sa_delete

from app.core.errors import ApiError, OkOut, Page, paginate_page
from app.core.registry import REGISTRY
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.functional import schemas
from app.modules.functional.models import (
    PRIORITIES,
    STATUS_NORMAL,
    STATUS_RECYCLED,
    FunctionalCase,
    FunctionalCaseComment,
    FunctionalCaseCustomField,
    FunctionalCaseFollower,
    FunctionalCaseRelation,
    FunctionalMinderNote,
    FunctionalModule,
)
from app.shared.custom_fields import (
    CustomFieldError,
    dump_value,
    load_value,
    validate_custom_values,
)
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

APP_USER = table("app_user", column("id"), column("name"), column("account"))

# D219：功能用例列表的可筛面（D47-a 三件套铺到功能用例页）。字段全是 functional_case
# 上真实存在的列，白名单外 400 带本页清单。三个轴刻意不进条件组：
# - `recycled` 是视图开关（正常/回收站同一端点），进条件组会造出「正常视图里再筛回收站」
#   这种自相矛盾的查询；
# - `module_id` / `unfiled_only` 是左树的取数轴（整棵子树 / 未分类），与条件组是两个
#   入口，混进来会让「左树选中的范围」被条件悄悄换掉；
# - `status` 同理是视图状态（normal/recycled），业务上不可筛。
# `module_id` 列本身不作为业务字段暴露：本页的模块归属由左树表达（ADB 页同款裁定）。
FUNCTIONAL_CASE_LIST_FILTER = ListViewFilter(
    view_type="functional_case",
    label="功能用例",
    fields={
        "num": FieldDecl(FunctionalCase.num, "number", "编号", nullable=False),
        "name": FieldDecl(FunctionalCase.name, "text", "用例名称", nullable=False),
        "description": FieldDecl(FunctionalCase.description, "text", "描述"),
        "priority": FieldDecl(FunctionalCase.priority, "enum", "优先级", nullable=False),
        "template_id": FieldDecl(FunctionalCase.template_id, "id", "模板", nullable=False),
        "created_by": FieldDecl(FunctionalCase.created_by, "id", "创建人"),
        "updated_by": FieldDecl(FunctionalCase.updated_by, "id", "更新人"),
        "created_at": FieldDecl(FunctionalCase.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(FunctionalCase.updated_at, "time", "更新时间", nullable=False),
    },
)
register(FUNCTIONAL_CASE_LIST_FILTER)


async def _user_names(db, ids: set[str | None]) -> dict[str, str]:
    real = {i for i in ids if i}
    if not real:
        return {}
    rows = (await db.execute(select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(real)))).all()
    return {r.id: r.name for r in rows}


async def _resolve_template(ctx, project_id: str, template_id: str | None):
    spec = REGISTRY.get("project_template_resolve")
    assert spec is not None, "project_meta 服务未注册"
    return await spec.handler(spec.model.model_validate({
        "project_id": project_id, "scene": "functional", "template_id": template_id,
    }), ctx)


async def _next_num(ctx, project_id: str) -> int:
    spec = REGISTRY.get("project_num_next")
    assert spec is not None, "取号服务未注册"
    out = await spec.handler(spec.model.model_validate({
        "project_id": project_id, "scene": "functional",
    }), ctx)
    return int(out.num)


def _validate_custom(fields, values: dict | None, *, require_all: bool) -> dict:
    specs = []
    for f in fields:
        d = f.model_dump()
        d["id"] = d.pop("field_id")
        specs.append(d)
    try:
        return validate_custom_values(specs, values, require_all=require_all)
    except CustomFieldError as e:
        raise ApiError("custom_field_invalid", str(e), 422,
                       {"field_id": e.field_id, "missing": e.missing}) from e


async def _load_custom_values(db, case_ids: list[str]) -> dict[str, dict]:
    if not case_ids:
        return {}
    rows = (await db.execute(select(FunctionalCaseCustomField).where(
        FunctionalCaseCustomField.case_id.in_(case_ids)))).scalars().all()
    out: dict[str, dict] = {i: {} for i in case_ids}
    for r in rows:
        out.setdefault(r.case_id, {})[r.field_id] = load_value(r.value)
    return out


async def _replace_custom_values(db, case_id: str, project_id: str, values: dict) -> None:
    await db.execute(sa_delete(FunctionalCaseCustomField).where(
        FunctionalCaseCustomField.case_id == case_id))
    for fid, v in values.items():
        db.add(FunctionalCaseCustomField(case_id=case_id, field_id=fid,
                                         project_id=project_id, value=dump_value(v)))


def _case_out(c: FunctionalCase, names: dict[str, str], custom: dict | None = None) -> schemas.CaseOut:
    return schemas.CaseOut(
        id=c.id, num=c.num, project_id=c.project_id, module_id=c.module_id,
        template_id=c.template_id, name=c.name, priority=c.priority,
        description=c.description, recycled=c.status == STATUS_RECYCLED,
        custom_fields=custom or {},
        created_by=c.created_by, created_by_name=names.get(c.created_by or ""),
        updated_by=c.updated_by, updated_by_name=names.get(c.updated_by or ""),
        created_at=schemas.iso(c.created_at), updated_at=schemas.iso(c.updated_at),
    )


async def _followed_ids(db, case_ids: list[str], user_id: str) -> set[str]:
    """D234：一页一条 IN 查完「我关注了哪几条」，不逐行问（同 D231 计划口径）。"""
    if not case_ids or not user_id:
        return set()
    rows = (await db.execute(select(FunctionalCaseFollower.case_id).where(
        FunctionalCaseFollower.case_id.in_(case_ids),
        FunctionalCaseFollower.user_id == user_id))).scalars().all()
    return set(rows)


async def _follower_count(db, case_id: str) -> int:
    return int((await db.execute(select(func.count()).select_from(FunctionalCaseFollower).where(
        FunctionalCaseFollower.case_id == case_id))).scalar_one())


async def _case(db, project_id: str, case_id: str, *, include_recycled: bool = False) -> FunctionalCase:
    row = (await db.execute(select(FunctionalCase).where(
        FunctionalCase.id == case_id, FunctionalCase.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "用例不存在", 404, {"case_id": case_id})
    if row.status == STATUS_RECYCLED and not include_recycled:
        raise ApiError("not_found", "用例不存在（在回收站，请先恢复）", 404, {"case_id": case_id})
    return row


async def _module(db, project_id: str, module_id: str, *, include_recycled: bool = False) -> FunctionalModule:
    row = (await db.execute(select(FunctionalModule).where(
        FunctionalModule.id == module_id, FunctionalModule.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "模块不存在", 404, {"module_id": module_id})
    if row.status == STATUS_RECYCLED and not include_recycled:
        raise ApiError("not_found", "模块不存在（在回收站）", 404, {"module_id": module_id})
    return row


# ══════════════════════════════ 模块树 ══════════════════════════════
def _build_tree(nodes: list[FunctionalModule], counts: dict[str, int]) -> list[schemas.ModuleNode]:
    by_id = {n.id: schemas.ModuleNode(id=n.id, parent_id=n.parent_id, name=n.name,
                                      sort=n.sort, status=n.status,
                                      case_count=counts.get(n.id, 0)) for n in nodes}
    roots: list[schemas.ModuleNode] = []
    for n in sorted(nodes, key=lambda x: (x.sort, x.name, x.id)):
        node = by_id[n.id]
        if n.parent_id and n.parent_id in by_id:
            by_id[n.parent_id].children.append(node)
        else:
            roots.append(node)
    return roots


@service(
    perm="functional:module:read", effect="read", name="functional_module_tree",
    description="功能用例模块树（含每个模块的用例数；回收站另列）",
    http={"method": "GET", "path": "/functional-modules/tree", "tags": ["functional"]},
)
async def functional_module_tree(payload: schemas.ModuleTreeIn, ctx) -> schemas.ModuleTreeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:module:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(FunctionalModule).where(
        FunctionalModule.project_id == payload.project_id))).scalars().all()
    normal = [m for m in rows if m.status == STATUS_NORMAL]
    recycled = [m for m in rows if m.status == STATUS_RECYCLED]
    counts: dict[str, int] = {}
    if normal:
        cr = (await ctx.db.execute(
            select(FunctionalCase.module_id, func.count())
            .where(FunctionalCase.project_id == payload.project_id,
                   FunctionalCase.status == STATUS_NORMAL,
                   FunctionalCase.module_id.is_not(None))
            .group_by(FunctionalCase.module_id))).all()
        counts = {mid: int(n) for mid, n in cr}
    return schemas.ModuleTreeOut(
        tree=_build_tree(normal, counts),
        recycled=[schemas.ModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                                     sort=m.sort, status=m.status) for m in recycled]
        if payload.include_recycled else [],
    )


async def _sibling_name_taken(db, project_id: str, parent_id: str | None, name: str,
                              exclude: str | None = None) -> bool:
    stmt = select(FunctionalModule.id).where(
        FunctionalModule.project_id == project_id,
        FunctionalModule.name == name,
        FunctionalModule.status == STATUS_NORMAL)
    stmt = stmt.where(FunctionalModule.parent_id.is_(None)) if parent_id is None \
        else stmt.where(FunctionalModule.parent_id == parent_id)
    if exclude:
        stmt = stmt.where(FunctionalModule.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="functional:module:create", effect="write", name="functional_module_create",
    description="新建用例模块（同父下重名 409；父模块必须在正常状态）",
    http={"method": "POST", "path": "/functional-modules", "tags": ["functional"], "status": 201},
)
async def functional_module_create(payload: schemas.ModuleCreateIn, ctx) -> schemas.ModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:module:create")
    assert ctx.db is not None
    if payload.parent_id:
        await _module(ctx.db, payload.project_id, payload.parent_id)
    if await _sibling_name_taken(ctx.db, payload.project_id, payload.parent_id, payload.name):
        raise ApiError("conflict", "同一父模块下名称已存在", 409, {"name": payload.name})
    m = FunctionalModule(project_id=payload.project_id, parent_id=payload.parent_id,
                         name=payload.name, sort=payload.sort)
    ctx.db.add(m)
    await ctx.db.commit()
    return schemas.ModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                              sort=m.sort, status=m.status)


async def _would_cycle(db, project_id: str, module_id: str, new_parent: str | None) -> bool:
    cur = new_parent
    guard = 0
    while cur:
        if cur == module_id:
            return True
        row = (await db.execute(select(FunctionalModule.parent_id).where(
            FunctionalModule.id == cur, FunctionalModule.project_id == project_id))).first()
        cur = row[0] if row else None
        guard += 1
        if guard > 10000:
            return True
    return False


@service(
    perm="functional:module:update", effect="write", name="functional_module_update",
    description="更新/移动模块（防环、同父重名 409）",
    http={"method": "PATCH", "path": "/functional-modules/{module_id}", "tags": ["functional"]},
)
async def functional_module_update(payload: schemas.ModuleUpdateIn, ctx) -> schemas.ModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:module:update")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id)
    parent_id = m.parent_id
    if payload.parent_set:
        parent_id = payload.parent_id
        if parent_id:
            await _module(ctx.db, payload.project_id, parent_id)
            if await _would_cycle(ctx.db, payload.project_id, m.id, parent_id):
                raise ApiError("cycle", "不能把模块移动到自己的子树里", 422, {"module_id": m.id})
    name = payload.name if payload.name is not None else m.name
    if (payload.name is not None and payload.name != m.name) or payload.parent_set:
        if await _sibling_name_taken(ctx.db, payload.project_id, parent_id, name, exclude=m.id):
            raise ApiError("conflict", "同一父模块下名称已存在", 409, {"name": name})
    m.name = name
    m.parent_id = parent_id
    if payload.sort is not None:
        m.sort = payload.sort
    await ctx.db.commit()
    return schemas.ModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                              sort=m.sort, status=m.status)


@service(
    perm="functional:module:delete", effect="destructive", name="functional_module_delete",
    description="模块放入回收站（有正常子模块或用例 → 409）",
    http={"method": "POST", "path": "/functional-modules/{module_id}/delete", "tags": ["functional"]},
)
async def functional_module_delete(payload: schemas.ModuleGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:module:delete")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id)
    kids = int((await ctx.db.execute(select(func.count()).select_from(FunctionalModule).where(
        FunctionalModule.parent_id == m.id,
        FunctionalModule.status == STATUS_NORMAL))).scalar_one())
    cases = int((await ctx.db.execute(select(func.count()).select_from(FunctionalCase).where(
        FunctionalCase.module_id == m.id,
        FunctionalCase.status == STATUS_NORMAL))).scalar_one())
    if kids or cases:
        raise ApiError("module_not_empty",
                       "模块下还有 " + str(kids) + " 个子模块、" + str(cases) + " 条用例，不能回收",
                       409, {"module_id": m.id, "children": kids, "cases": cases})
    m.status = STATUS_RECYCLED
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="functional:module:update", effect="write", name="functional_module_restore",
    description="从回收站恢复模块（父模块在回收站/同级重名 → 409）",
    http={"method": "POST", "path": "/functional-modules/{module_id}/restore", "tags": ["functional"]},
)
async def functional_module_restore(payload: schemas.ModuleGetIn, ctx) -> schemas.ModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:module:update")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id, include_recycled=True)
    if m.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "模块不在回收站", 404, {"module_id": m.id})
    if m.parent_id:
        parent = await _module(ctx.db, payload.project_id, m.parent_id, include_recycled=True)
        if parent.status == STATUS_RECYCLED:
            raise ApiError("parent_recycled", "父模块在回收站：先恢复父模块", 409,
                           {"module_id": m.id})
    if await _sibling_name_taken(ctx.db, payload.project_id, m.parent_id, m.name, exclude=m.id):
        raise ApiError("conflict", "回收期间同级出现了同名模块：先处理它再恢复", 409,
                       {"name": m.name})
    m.status = STATUS_NORMAL
    await ctx.db.commit()
    return schemas.ModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                              sort=m.sort, status=m.status)


@service(
    perm="functional:module:delete", effect="destructive", name="functional_module_purge",
    description="彻底删除模块（必须已回收且无任何子模块/用例；逐字确认名称）",
    http={"method": "POST", "path": "/functional-modules/{module_id}/purge", "tags": ["functional"]},
    tool=False,
)
async def functional_module_purge(payload: schemas.ModulePurgeIn, ctx) -> schemas.ModulePurgeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:module:delete")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id, include_recycled=True)
    if m.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的模块", 409, {"module_id": m.id})
    if payload.confirm_name != m.name:
        raise ApiError("name_mismatch", "确认名称与模块名不一致，未删除", 409, {"module_id": m.id})
    kids = int((await ctx.db.execute(select(func.count()).select_from(FunctionalModule).where(
        FunctionalModule.parent_id == m.id))).scalar_one())
    cases = int((await ctx.db.execute(select(func.count()).select_from(FunctionalCase).where(
        FunctionalCase.module_id == m.id))).scalar_one())
    if kids or cases:
        raise ApiError("module_not_empty", "模块下仍有子模块或用例（含回收站），不能彻底删除",
                       409, {"module_id": m.id, "children": kids, "cases": cases})
    await ctx.db.delete(m)
    await ctx.db.commit()
    return schemas.ModulePurgeOut(ok=True, purged_modules=1)


# ══════════════════════════════ 用例 ══════════════════════════════
@service(
    perm="functional:case:read", effect="read", name="functional_case_list",
    description="列出功能用例（模块/优先级/关键词/回收站/高级搜索；页码分页；含自定义值）",
    http={"method": "GET", "path": "/functional-cases", "tags": ["functional"]},
)
async def functional_case_list(payload: schemas.CaseListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:read")
    assert ctx.db is not None
    stmt = select(FunctionalCase).where(
        FunctionalCase.project_id == payload.project_id,
        FunctionalCase.status == (STATUS_RECYCLED if payload.recycled else STATUS_NORMAL))
    if payload.unfiled_only:
        stmt = stmt.where(FunctionalCase.module_id.is_(None))
    elif payload.module_id:
        stmt = stmt.where(FunctionalCase.module_id == payload.module_id)
    if payload.priority:
        stmt = stmt.where(FunctionalCase.priority == payload.priority)
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(FunctionalCase.name.like(kw) | FunctionalCase.description.like(kw))
    if payload.followed_by_me:
        stmt = stmt.where(FunctionalCase.id.in_(select(FunctionalCaseFollower.case_id).where(
            FunctionalCaseFollower.user_id == ctx.user_id,
            FunctionalCaseFollower.project_id == payload.project_id)))
    stmt = stmt.where(FUNCTIONAL_CASE_LIST_FILTER.parse(payload.filter))
    stmt = stmt.order_by(FunctionalCase.created_at.desc(), FunctionalCase.id.desc())
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    ids = [c.id for c in page.items]
    names = await _user_names(ctx.db, {c.created_by for c in page.items}
                              | {c.updated_by for c in page.items})
    custom = await _load_custom_values(ctx.db, ids)
    followed = await _followed_ids(ctx.db, ids, ctx.user_id)
    return Page(items=[schemas.CaseListRowOut(
        **_case_out(c, names, custom.get(c.id, {})).model_dump(),
        followed=c.id in followed) for c in page.items],
        next_cursor=None, total=page.total)


@service(
    perm="functional:case:create", effect="write", name="functional_case_create",
    description="新建功能用例（模板必填值校验；num 项目内唯一；模块可空）",
    http={"method": "POST", "path": "/functional-cases", "tags": ["functional"], "status": 201},
)
async def functional_case_create(payload: schemas.CaseCreateIn, ctx) -> schemas.CaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:create")
    assert ctx.db is not None
    if payload.module_id:
        await _module(ctx.db, payload.project_id, payload.module_id)
    resolved = await _resolve_template(ctx, payload.project_id, payload.template_id)
    values = _validate_custom(resolved.fields, payload.custom_fields, require_all=True)
    num = await _next_num(ctx, payload.project_id)
    c = FunctionalCase(project_id=payload.project_id, num=num, module_id=payload.module_id,
                       template_id=resolved.template_id, name=payload.name,
                       priority=payload.priority, description=payload.description,
                       status=STATUS_NORMAL, created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(c)
    await ctx.db.flush()
    await _replace_custom_values(ctx.db, c.id, payload.project_id, values)
    await ctx.db.commit()
    names = await _user_names(ctx.db, {ctx.user_id})
    return _case_out(c, names, values)


@service(
    perm="functional:case:read", effect="read", name="functional_case_get",
    description="用例详情（含自定义值）",
    http={"method": "GET", "path": "/functional-cases/{case_id}", "tags": ["functional"]},
)
async def functional_case_get(payload: schemas.CaseGetIn, ctx) -> schemas.CaseDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:read")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    names = await _user_names(ctx.db, {c.created_by, c.updated_by})
    custom = (await _load_custom_values(ctx.db, [c.id])).get(c.id, {})
    followed = await _followed_ids(ctx.db, [c.id], ctx.user_id)
    return schemas.CaseDetailOut(**_case_out(c, names, custom).model_dump(),
                                 followed=c.id in followed,
                                 follower_count=await _follower_count(ctx.db, c.id))


@service(
    perm="functional:case:update", effect="write", name="functional_case_follow",
    description="关注功能用例（幂等；回执现查关注人数）",
    http={"method": "POST", "path": "/functional-cases/{case_id}/follow", "tags": ["functional"]},
    tool=False,
)
async def functional_case_follow(payload: schemas.CaseFollowIn,
                                 ctx) -> schemas.CaseFollowOut:
    """D234：关注是个人行为，但写副作用一律走写位（`functional:case:update`），
    不借 read——只读角色不该改动关注行。回收站里的用例仍可关注（用户可能先关注等恢复）。"""
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id, include_recycled=True)
    existing = (await ctx.db.execute(select(FunctionalCaseFollower).where(
        FunctionalCaseFollower.case_id == c.id,
        FunctionalCaseFollower.user_id == ctx.user_id))).scalar_one_or_none()
    if existing is None:
        ctx.db.add(FunctionalCaseFollower(case_id=c.id, user_id=ctx.user_id,
                                          project_id=c.project_id,
                                          created_at=datetime.now(UTC)))
        await ctx.db.commit()
    return schemas.CaseFollowOut(following=True,
                                 follower_count=await _follower_count(ctx.db, c.id))


@service(
    perm="functional:case:update", effect="write", name="functional_case_unfollow",
    description="取消关注功能用例（幂等；回执现查关注人数）",
    http={"method": "POST", "path": "/functional-cases/{case_id}/unfollow", "tags": ["functional"]},
    tool=False,
)
async def functional_case_unfollow(payload: schemas.CaseFollowIn,
                                   ctx) -> schemas.CaseFollowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id, include_recycled=True)
    await ctx.db.execute(sa_delete(FunctionalCaseFollower).where(
        FunctionalCaseFollower.case_id == c.id,
        FunctionalCaseFollower.user_id == ctx.user_id))
    await ctx.db.commit()
    return schemas.CaseFollowOut(following=False,
                                 follower_count=await _follower_count(ctx.db, c.id))


@service(
    perm="functional:case:update", effect="write", name="functional_case_update",
    description="更新用例（模块移动、模板切换、自定义值全量替换）",
    http={"method": "PATCH", "path": "/functional-cases/{case_id}", "tags": ["functional"]},
)
async def functional_case_update(payload: schemas.CaseUpdateIn, ctx) -> schemas.CaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    content_changed = False
    if payload.name is not None:
        if payload.name != c.name:
            content_changed = True
        c.name = payload.name
    if payload.priority is not None:
        c.priority = payload.priority
    if payload.description_set:
        if (payload.description or "") != (c.description or ""):
            content_changed = True
        c.description = payload.description
    if payload.module_set:
        if payload.module_id is not None:
            await _module(ctx.db, payload.project_id, payload.module_id)
        c.module_id = payload.module_id
    if payload.template_id is not None or payload.custom_fields is not None:
        current = (await _load_custom_values(ctx.db, [c.id])).get(c.id, {})
        target_tid = payload.template_id or c.template_id
        resolved = await _resolve_template(ctx, payload.project_id, target_tid)
        if resolved.template_id != c.template_id:
            allowed = {f.field_id for f in resolved.fields}
            current = {k: v for k, v in current.items() if k in allowed}
        incoming = current if payload.custom_fields is None else payload.custom_fields
        values = _validate_custom(resolved.fields, incoming, require_all=True)
        await _replace_custom_values(ctx.db, c.id, payload.project_id, values)
        c.template_id = resolved.template_id
    if content_changed:
        spec = REGISTRY.get("project_application_enabled")
        if spec is not None:
            enabled = await spec.handler(spec.model.model_validate({
                "project_id": payload.project_id, "key": "functional.re_review",
            }), ctx)
            if enabled.enabled:
                rr = REGISTRY.get("review_case_auto_re_review")
                if rr is not None:
                    await rr.handler(rr.model.model_validate({
                        "project_id": payload.project_id, "case_id": c.id,
                    }), ctx)
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    names = await _user_names(ctx.db, {c.created_by, c.updated_by})
    custom = (await _load_custom_values(ctx.db, [c.id])).get(c.id, {})
    return _case_out(c, names, custom)


@service(
    perm="functional:case:delete", effect="destructive", name="functional_case_delete",
    description="用例放入回收站",
    http={"method": "POST", "path": "/functional-cases/{case_id}/delete", "tags": ["functional"]},
)
async def functional_case_delete(payload: schemas.CaseGetIn, ctx) -> schemas.CaseBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:delete")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    c.status = STATUS_RECYCLED
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=1)


@service(
    perm="functional:case:update", effect="write", name="functional_case_restore",
    description="从回收站恢复用例",
    http={"method": "POST", "path": "/functional-cases/{case_id}/restore", "tags": ["functional"]},
)
async def functional_case_restore(payload: schemas.CaseGetIn, ctx) -> schemas.CaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id, include_recycled=True)
    if c.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "用例不在回收站", 404, {"case_id": c.id})
    c.status = STATUS_NORMAL
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    names = await _user_names(ctx.db, {c.created_by, c.updated_by})
    custom = (await _load_custom_values(ctx.db, [c.id])).get(c.id, {})
    return _case_out(c, names, custom)


async def _purge_one(db, c: FunctionalCase, ctx) -> None:
    await db.execute(sa_delete(FunctionalCaseCustomField).where(
        FunctionalCaseCustomField.case_id == c.id))
    await db.execute(sa_delete(FunctionalCaseFollower).where(
        FunctionalCaseFollower.case_id == c.id))
    await db.execute(sa_delete(FunctionalCaseComment).where(
        FunctionalCaseComment.case_id == c.id))
    await db.execute(sa_delete(FunctionalCaseRelation).where(
        (FunctionalCaseRelation.from_case_id == c.id)
        | (FunctionalCaseRelation.to_case_id == c.id)))
    spec = REGISTRY.get("file_target_purge")
    assert spec is not None, "filelib 服务未注册"
    await spec.handler(spec.model.model_validate({
        "project_id": c.project_id, "target_type": "functional_case", "target_id": c.id,
    }), ctx)
    await db.delete(c)


@service(
    perm="functional:case:delete", effect="destructive", name="functional_case_purge",
    description="彻底删除回收站中的用例（逐字确认名称；同事务清自定义值）",
    http={"method": "POST", "path": "/functional-cases/{case_id}/purge", "tags": ["functional"]},
    tool=False,
)
async def functional_case_purge(payload: schemas.CasePurgeIn, ctx) -> schemas.CaseBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:delete")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id, include_recycled=True)
    if c.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的用例", 409, {"case_id": c.id})
    if payload.confirm_name != c.name:
        raise ApiError("name_mismatch", "确认名称与用例名不一致，未删除", 409, {"case_id": c.id})
    await _purge_one(ctx.db, c, ctx)
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=1)


@service(
    perm="functional:case:delete", effect="destructive", name="functional_case_batch_delete",
    description="批量放入回收站（只影响正常用例）",
    http={"method": "POST", "path": "/functional-cases/batch-delete", "tags": ["functional"]},
    tool=False,
)
async def functional_case_batch_delete(payload: schemas.CaseBatchIn, ctx) -> schemas.CaseBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:delete")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(FunctionalCase).where(
        FunctionalCase.project_id == payload.project_id,
        FunctionalCase.id.in_(payload.case_ids),
        FunctionalCase.status == STATUS_NORMAL))).scalars().all()
    for c in rows:
        c.status = STATUS_RECYCLED
        c.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=len(rows))


@service(
    perm="functional:case:update", effect="write", name="functional_case_batch_restore",
    description="批量恢复回收站用例",
    http={"method": "POST", "path": "/functional-cases/batch-restore", "tags": ["functional"]},
    tool=False,
)
async def functional_case_batch_restore(payload: schemas.CaseBatchIn, ctx) -> schemas.CaseBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(FunctionalCase).where(
        FunctionalCase.project_id == payload.project_id,
        FunctionalCase.id.in_(payload.case_ids),
        FunctionalCase.status == STATUS_RECYCLED))).scalars().all()
    for c in rows:
        c.status = STATUS_NORMAL
        c.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=len(rows))


@service(
    perm="functional:case:delete", effect="destructive", name="functional_case_batch_purge",
    description="批量彻底删除回收站用例（不可恢复）",
    http={"method": "POST", "path": "/functional-cases/batch-purge", "tags": ["functional"]},
    tool=False,
)
async def functional_case_batch_purge(payload: schemas.CaseBatchIn, ctx) -> schemas.CaseBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:delete")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(FunctionalCase).where(
        FunctionalCase.project_id == payload.project_id,
        FunctionalCase.id.in_(payload.case_ids),
        FunctionalCase.status == STATUS_RECYCLED))).scalars().all()
    for c in rows:
        await _purge_one(ctx.db, c, ctx)
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=len(rows))


@service(
    perm="functional:case:update", effect="write", name="functional_case_batch_update",
    description="批量编辑用例（优先级 / 模块；只影响本项目正常用例，回收站不参与）",
    http={"method": "POST", "path": "/functional-cases/batch-update", "tags": ["functional"]},
    tool=False,
)
async def functional_case_batch_update(payload: schemas.CaseBatchUpdateIn,
                                       ctx) -> schemas.CaseBatchOut:
    """D232：一条 UPDATE 覆盖选中的正常用例。

    口径（每条都有测试）：
    - **至少给一个字段**：priority 与 module_set 都缺 → 422，不做「空更新却回 affected=N」
      （那会让人以为改了东西）。
    - **module_set 哨兵**：`module_set=true + module_id=null` = 移到未分组；`module_set=false`
      = 不动模块（JSON 分不清 null 与缺省，故用哨兵，同 CaseUpdateIn）。
    - **模块必须在本项目**（`_module` 404）——跨项目模块 id 不能被「编辑」进来。
    - **重复 id → 422 整批不动**（D209 计划批量删除同尺：重复不是「改两次」，是客户端错误）。
    - **只改正常态**：回收站里的 id 不在 WHERE 里，affected 也不含它（批量编辑不是恢复）。
    - 只动 priority / module_id / updated_by；名称、描述、模板与自定义值一概不碰
      （批量覆盖内容是「覆盖」不是「编辑」，本刀不做）。返回 affected = 真正改到的行数。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    if payload.priority is None and not payload.module_set:
        raise ApiError("empty_update", "至少指定优先级或模块", 422, {})
    if len(set(payload.case_ids)) != len(payload.case_ids):
        raise ApiError("duplicate_case_ids", "case_ids 有重复项，未修改", 422, {})
    if payload.module_set and payload.module_id is not None:
        await _module(ctx.db, payload.project_id, payload.module_id)
    rows = (await ctx.db.execute(select(FunctionalCase).where(
        FunctionalCase.project_id == payload.project_id,
        FunctionalCase.id.in_(payload.case_ids),
        FunctionalCase.status == STATUS_NORMAL))).scalars().all()
    for c in rows:
        if payload.priority is not None:
            c.priority = payload.priority
        if payload.module_set:
            c.module_id = payload.module_id
        c.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=len(rows))


@service(
    perm="functional:case:create", effect="write", name="functional_case_batch_copy",
    description="批量复制用例（副本进本项目；可选目标模块与名称后缀；评论/关系不复制）",
    http={"method": "POST", "path": "/functional-cases/batch-copy", "tags": ["functional"]},
    tool=False,
)
async def functional_case_batch_copy(payload: schemas.CaseBatchCopyIn,
                                     ctx) -> schemas.CaseBatchCopyOut:
    """D233：逐条复制选中的正常用例。

    口径（每条都有测试）：
    - **复制 = 新建**：副本走 `functional:case:create` 位（本仓没有 MS 的 copy 专用位；
      复制产出的就是一条新用例，用 create 位才与「能不能建」同尺），每条新取一个 num。
    - **module_set 哨兵**：缺省 = 各副本留在源用例自己的模块；`module_set=true` 时
      全部落到 `module_id`（null = 未分类）。
    - **只复制正常态**：回收站/跨项目/不存在的 id 一律 404 且**整批不写**（不复制半批，
      也不泄露别项目用例的存在性）。
    - **content 全抄、关系不抄**：模板、名称+后缀、优先级、描述、自定义值随行复制；
      评论与前后置关系说的是「源那一条」的事，不复制。
    - 重复 id 去重保序（复制两次同一条不是两个请求，去重后只产出一个副本）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:create")
    assert ctx.db is not None
    if payload.module_set and payload.module_id is not None:
        await _module(ctx.db, payload.project_id, payload.module_id)
    ids = list(dict.fromkeys(payload.case_ids))
    rows = (await ctx.db.execute(select(FunctionalCase).where(
        FunctionalCase.project_id == payload.project_id,
        FunctionalCase.id.in_(ids),
        FunctionalCase.status == STATUS_NORMAL))).scalars().all()
    by_id = {r.id: r for r in rows}
    missing = [cid for cid in ids if cid not in by_id]
    if missing:
        raise ApiError("not_found", "用例不存在", 404, {"case_ids": missing})
    customs = await _load_custom_values(ctx.db, ids)
    created: list[str] = []
    for cid in ids:
        src = by_id[cid]
        name = src.name + payload.name_suffix
        if len(name) > 255:
            raise ApiError("name_too_long", "复制后的用例名称超过 255 字",
                           422, {"case_id": src.id})
        c = FunctionalCase(
            project_id=payload.project_id, num=await _next_num(ctx, payload.project_id),
            module_id=payload.module_id if payload.module_set else src.module_id,
            template_id=src.template_id, name=name, priority=src.priority,
            description=src.description, status=STATUS_NORMAL,
            created_by=ctx.user_id, updated_by=ctx.user_id,
        )
        ctx.db.add(c)
        await ctx.db.flush()
        await _replace_custom_values(ctx.db, c.id, payload.project_id, customs.get(cid, {}))
        created.append(c.id)
    await ctx.db.commit()
    return schemas.CaseBatchCopyOut(ok=True, affected=len(created), case_ids=created)


# ══════════════════════════════ 统计 ══════════════════════════════
@service(
    perm="functional:case:read", effect="read", name="functional_case_stats",
    description="功能用例统计（按优先级/模块/创建人分组计数；含回收站总数）",
    http={"method": "POST", "path": "/functional-cases/stats", "tags": ["functional"]},
    tool=False,
)
async def functional_case_stats(payload: schemas.CaseStatsIn, ctx) -> schemas.CaseStatsOut:
    """D236：分组计数（MS `/report/test/case/count/getReport` 的 X 轴子集）。

    口径：`total` / `groups` 吃**当前视图**（`recycled` 开关），`recycled_total` 永远
    是回收站的行数——两个数并排出现，用户才分得清「在用多少」与「删了多少」。
    `groups` 的计数之和必须等于 `total`：同一份 `where`（项目 + 视图状态）分两路
    取数（一次 count、一次 group by），两路复用同一个条件元组，不各写一遍。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:read")
    assert ctx.db is not None
    status = STATUS_RECYCLED if payload.recycled else STATUS_NORMAL
    scope = (FunctionalCase.project_id == payload.project_id,
             FunctionalCase.status == status)
    total = int((await ctx.db.execute(
        select(func.count()).select_from(FunctionalCase).where(*scope))).scalar_one())
    recycled_total = int((await ctx.db.execute(
        select(func.count()).select_from(FunctionalCase).where(
            FunctionalCase.project_id == payload.project_id,
            FunctionalCase.status == STATUS_RECYCLED))).scalar_one())

    groups: list[schemas.CaseStatGroup] = []
    if payload.group_by == "priority":
        rows = (await ctx.db.execute(
            select(FunctionalCase.priority, func.count()).where(*scope)
            .group_by(FunctionalCase.priority))).all()
        counts = {str(k): int(n) for k, n in rows}
        # 四个优先级**全部列出**（没有用例的记 0）：统计图的横轴不因数据缺口变形，
        # 「P0 一条都没有」本身就是要看的事实。
        groups = [schemas.CaseStatGroup(key=p, label=p, count=counts.get(p, 0))
                  for p in PRIORITIES]
    elif payload.group_by == "module":
        rows = (await ctx.db.execute(
            select(FunctionalCase.module_id, func.count()).where(*scope)
            .group_by(FunctionalCase.module_id))).all()
        mod_rows = (await ctx.db.execute(select(FunctionalModule.id, FunctionalModule.name).where(
            FunctionalModule.project_id == payload.project_id))).all()
        names = {str(mid): str(name) for mid, name in mod_rows}
        for mid, n in rows:
            key = str(mid) if mid else ""
            # 模块彻底删除要求「无任何用例」，所以正常数据里不会出现查不到名字的 id；
            # 真出现了（历史脏数据）也如实标「未知模块」，不把行藏起来。
            label = "未分类" if not mid else names.get(key, "未知模块")
            groups.append(schemas.CaseStatGroup(key=key, label=label, count=int(n)))
        groups.sort(key=lambda g: (-g.count, g.label))
    else:  # creator
        rows = (await ctx.db.execute(
            select(FunctionalCase.created_by, func.count()).where(*scope)
            .group_by(FunctionalCase.created_by))).all()
        names = await _user_names(ctx.db, {str(uid) for uid, _ in rows if uid})
        for uid, n in rows:
            key = str(uid) if uid else ""
            label = "—" if not uid else names.get(key, key)
            groups.append(schemas.CaseStatGroup(key=key, label=label, count=int(n)))
        groups.sort(key=lambda g: (-g.count, g.label))
    return schemas.CaseStatsOut(total=total, recycled_total=recycled_total,
                                group_by=payload.group_by, groups=groups)


# ══════════════════════════════ 评论 ══════════════════════════════
async def _comment(db, project_id: str, comment_id: str) -> FunctionalCaseComment:
    row = (await db.execute(select(FunctionalCaseComment).where(
        FunctionalCaseComment.id == comment_id,
        FunctionalCaseComment.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "评论不存在", 404, {"comment_id": comment_id})
    return row


@service(
    perm="functional:case:read", effect="read", name="functional_case_comment_list",
    description="用例评论（两层嵌套）",
    http={"method": "GET", "path": "/functional-cases/{case_id}/comments", "tags": ["functional"]},
)
async def functional_case_comment_list(payload: schemas.CaseCommentListIn,
                                       ctx) -> schemas.CaseCommentListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:read")
    assert ctx.db is not None
    await _case(ctx.db, payload.project_id, payload.case_id, include_recycled=True)
    rows = (await ctx.db.execute(select(FunctionalCaseComment).where(
        FunctionalCaseComment.project_id == payload.project_id,
        FunctionalCaseComment.case_id == payload.case_id
    ).order_by(FunctionalCaseComment.created_at, FunctionalCaseComment.id))).scalars().all()
    names = await _user_names(ctx.db, {r.created_by for r in rows} | {r.reply_user_id for r in rows})
    nodes = {r.id: schemas.CaseCommentOut(
        id=r.id, case_id=r.case_id, parent_id=r.parent_id, content=r.content,
        reply_user_id=r.reply_user_id, reply_user_name=names.get(r.reply_user_id or ""),
        created_by=r.created_by, created_by_name=names.get(r.created_by),
        created_at=schemas.iso(r.created_at), updated_at=schemas.iso(r.updated_at),
    ) for r in rows}
    roots: list[schemas.CaseCommentOut] = []
    for r in rows:
        node = nodes[r.id]
        if r.parent_id and r.parent_id in nodes:
            nodes[r.parent_id].children.append(node)
        else:
            roots.append(node)
    return schemas.CaseCommentListOut(items=roots, total=len(rows))


@service(
    perm="functional:case:comment", effect="write", name="functional_case_comment_add",
    description="新增评论（parent_id 指向顶层评论时成为回复）",
    http={"method": "POST", "path": "/functional-cases/{case_id}/comments", "tags": ["functional"], "status": 201},
)
async def functional_case_comment_add(payload: schemas.CaseCommentAddIn,
                                      ctx) -> schemas.CaseCommentOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:comment")
    assert ctx.db is not None
    await _case(ctx.db, payload.project_id, payload.case_id)
    reply_user: str | None = None
    if payload.parent_id:
        parent = await _comment(ctx.db, payload.project_id, payload.parent_id)
        if parent.case_id != payload.case_id:
            raise ApiError("not_found", "父评论不属于该用例", 404, {"parent_id": payload.parent_id})
        if parent.parent_id:
            raise ApiError("bad_request", "只支持两级评论：回复不能挂在回复上", 422,
                           {"parent_id": payload.parent_id})
        reply_user = parent.created_by
    row = FunctionalCaseComment(project_id=payload.project_id, case_id=payload.case_id,
                                parent_id=payload.parent_id, content=payload.content,
                                reply_user_id=reply_user, created_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.commit()
    names = await _user_names(ctx.db, {ctx.user_id, reply_user})
    return schemas.CaseCommentOut(
        id=row.id, case_id=row.case_id, parent_id=row.parent_id, content=row.content,
        reply_user_id=row.reply_user_id, reply_user_name=names.get(reply_user or ""),
        created_by=row.created_by, created_by_name=names.get(ctx.user_id),
        created_at=schemas.iso(row.created_at), updated_at=schemas.iso(row.updated_at),
    )


@service(
    perm="functional:case:comment", effect="write", name="functional_case_comment_update",
    description="编辑评论（仅创建人）",
    http={"method": "PATCH", "path": "/functional-case-comments/{comment_id}", "tags": ["functional"]},
)
async def functional_case_comment_update(payload: schemas.CaseCommentUpdateIn,
                                         ctx) -> schemas.CaseCommentOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:comment")
    assert ctx.db is not None
    row = await _comment(ctx.db, payload.project_id, payload.comment_id)
    if row.created_by != ctx.user_id:
        raise ApiError("forbidden", "只有评论创建人可以编辑", 403, {"comment_id": row.id})
    row.content = payload.content
    await ctx.db.commit()
    names = await _user_names(ctx.db, {row.created_by, row.reply_user_id})
    return schemas.CaseCommentOut(
        id=row.id, case_id=row.case_id, parent_id=row.parent_id, content=row.content,
        reply_user_id=row.reply_user_id, reply_user_name=names.get(row.reply_user_id or ""),
        created_by=row.created_by, created_by_name=names.get(row.created_by),
        created_at=schemas.iso(row.created_at), updated_at=schemas.iso(row.updated_at),
    )


@service(
    perm="functional:case:comment", effect="destructive", name="functional_case_comment_delete",
    description="删除评论（仅创建人；父评论连子回复一起删）",
    http={"method": "POST", "path": "/functional-case-comments/{comment_id}/delete", "tags": ["functional"]},
)
async def functional_case_comment_delete(payload: schemas.CaseCommentDeleteIn,
                                         ctx) -> schemas.CaseBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:comment")
    assert ctx.db is not None
    row = await _comment(ctx.db, payload.project_id, payload.comment_id)
    if row.created_by != ctx.user_id:
        raise ApiError("forbidden", "只有评论创建人可以删除", 403, {"comment_id": row.id})
    await ctx.db.execute(sa_delete(FunctionalCaseComment).where(
        FunctionalCaseComment.parent_id == row.id))
    await ctx.db.delete(row)
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=1)


# ══════════════════════════════ 前后置关系 ══════════════════════════════
def _case_brief(c: FunctionalCase) -> schemas.CaseBrief:
    return schemas.CaseBrief(id=c.id, num=c.num, name=c.name)


@service(
    perm="functional:case:read", effect="read", name="functional_case_relation_list",
    description="用例的前置/后置用例",
    http={"method": "GET", "path": "/functional-cases/{case_id}/relations", "tags": ["functional"]},
)
async def functional_case_relation_list(payload: schemas.CaseRelationListIn,
                                        ctx) -> schemas.CaseRelationListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:read")
    assert ctx.db is not None
    case = await _case(ctx.db, payload.project_id, payload.case_id, include_recycled=True)
    pre_edges = (await ctx.db.execute(select(FunctionalCaseRelation).where(
        FunctionalCaseRelation.project_id == payload.project_id,
        FunctionalCaseRelation.to_case_id == case.id,
        FunctionalCaseRelation.relation_type == "predecessor"))).scalars().all()
    succ_edges = (await ctx.db.execute(select(FunctionalCaseRelation).where(
        FunctionalCaseRelation.project_id == payload.project_id,
        FunctionalCaseRelation.from_case_id == case.id,
        FunctionalCaseRelation.relation_type == "predecessor"))).scalars().all()
    ids = {e.from_case_id for e in pre_edges} | {e.to_case_id for e in succ_edges}
    cases = {c.id: c for c in (await ctx.db.execute(select(FunctionalCase).where(
        FunctionalCase.id.in_(ids)))).scalars().all()} if ids else {}
    return schemas.CaseRelationListOut(
        predecessors=[schemas.CaseRelationOut(
            relation_id=e.id, case=_case_brief(cases[e.from_case_id]),
            relation_type="predecessor") for e in pre_edges if e.from_case_id in cases],
        successors=[schemas.CaseRelationOut(
            relation_id=e.id, case=_case_brief(cases[e.to_case_id]),
            relation_type="successor") for e in succ_edges if e.to_case_id in cases],
    )


@service(
    perm="functional:case:update", effect="write", name="functional_case_relation_add",
    description="加前置/后置用例（自环/直接反向环 409；同边幂等）",
    http={"method": "POST", "path": "/functional-cases/{case_id}/relations", "tags": ["functional"], "status": 201},
)
async def functional_case_relation_add(payload: schemas.CaseRelationAddIn,
                                       ctx) -> schemas.CaseRelationOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    case = await _case(ctx.db, payload.project_id, payload.case_id)
    target = await _case(ctx.db, payload.project_id, payload.target_case_id)
    if target.id == case.id:
        raise ApiError("self_relation", "用例不能与自己建立前后置关系", 422, {"case_id": case.id})
    if payload.relation_type == "predecessor":
        frm, to = target, case
    else:
        frm, to = case, target
    reverse = (await ctx.db.execute(select(FunctionalCaseRelation.id).where(
        FunctionalCaseRelation.project_id == payload.project_id,
        FunctionalCaseRelation.from_case_id == to.id,
        FunctionalCaseRelation.to_case_id == frm.id))).first()
    if reverse is not None:
        raise ApiError("cycle", "这会与已有关系形成直接环", 409,
                       {"case_id": case.id, "target_case_id": target.id})
    existing = (await ctx.db.execute(select(FunctionalCaseRelation).where(
        FunctionalCaseRelation.project_id == payload.project_id,
        FunctionalCaseRelation.from_case_id == frm.id,
        FunctionalCaseRelation.to_case_id == to.id))).scalar_one_or_none()
    if existing is not None:
        return schemas.CaseRelationOut(relation_id=existing.id, case=_case_brief(target),
                                       relation_type=payload.relation_type)
    row = FunctionalCaseRelation(project_id=payload.project_id, from_case_id=frm.id,
                                 to_case_id=to.id, relation_type="predecessor",
                                 created_by=ctx.user_id, created_at=datetime.now(UTC))
    ctx.db.add(row)
    await ctx.db.commit()
    return schemas.CaseRelationOut(relation_id=row.id, case=_case_brief(target),
                                   relation_type=payload.relation_type)


@service(
    perm="functional:case:update", effect="write", name="functional_case_relation_delete",
    description="删除一条前后置关系",
    http={"method": "POST", "path": "/functional-case-relations/{relation_id}/delete", "tags": ["functional"]},
)
async def functional_case_relation_delete(payload: schemas.CaseRelationDeleteIn,
                                          ctx) -> schemas.CaseBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    row = (await ctx.db.execute(select(FunctionalCaseRelation).where(
        FunctionalCaseRelation.id == payload.relation_id,
        FunctionalCaseRelation.project_id == payload.project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "关系不存在", 404, {"relation_id": payload.relation_id})
    await ctx.db.delete(row)
    await ctx.db.commit()
    return schemas.CaseBatchOut(ok=True, affected=1)

# ══════════════════════════════ 脑图（D268）══════════════════════════════
MINDER_NOTE_MAX = 500


def _minder_case(c: FunctionalCase) -> schemas.MinderCaseOut:
    return schemas.MinderCaseOut(id=c.id, num=c.num, name=c.name, priority=c.priority)


def _minder_sort_key(n: schemas.MinderNodeOut) -> tuple[int, str, str]:
    return (n.sort, n.name, n.id)


def _build_minder(
    modules: list[FunctionalModule],
    notes: list[FunctionalMinderNote],
    cases_by_module: dict[str, list[FunctionalCase]],
) -> list[schemas.MinderNodeOut]:
    """模块 + 便签合成一棵树（用例叶只挂模块）。

    数据异常（父链断裂/成环）不让整棵脑图消失：DFS 走完把没访问到的节点补到根层。
    宁可多画一个节点，也不静默吞掉用例。
    """
    children: dict[str | None, list[tuple[str, object]]] = {}
    for m in modules:
        children.setdefault(m.parent_id, []).append(("module", m))
    for n in notes:
        children.setdefault(n.parent_id, []).append(("note", n))
    visited: set[tuple[str, str]] = set()

    def make(kind: str, row: object) -> schemas.MinderNodeOut:
        if kind == "module":
            m = row
            assert isinstance(m, FunctionalModule)
            cases = cases_by_module.get(m.id, [])
            return schemas.MinderNodeOut(
                id=m.id, kind="module", name=m.name, parent_id=m.parent_id, sort=m.sort,
                case_count=len(cases), cases=[_minder_case(c) for c in cases],
                children=build(m.id))
        n = row
        assert isinstance(n, FunctionalMinderNote)
        return schemas.MinderNodeOut(
            id=n.id, kind="note", name=n.name, parent_id=n.parent_id, sort=n.sort,
            children=build(n.id))

    def build(parent_id: str | None) -> list[schemas.MinderNodeOut]:
        out: list[schemas.MinderNodeOut] = []
        for kind, row in children.get(parent_id, []):
            if (kind, row.id) in visited:  # type: ignore[attr-defined]
                continue
            visited.add((kind, row.id))  # type: ignore[attr-defined]
            out.append(make(kind, row))
        out.sort(key=_minder_sort_key)
        return out

    tree = build(None)
    for kind, row in ([("module", m) for m in modules]
                      + [("note", n) for n in notes]):
        if (kind, row.id) in visited:
            continue
        visited.add((kind, row.id))
        tree.append(make(kind, row))
    tree.sort(key=_minder_sort_key)
    return tree


async def _minder_note(db, project_id: str, note_id: str) -> FunctionalMinderNote:
    row = (await db.execute(select(FunctionalMinderNote).where(
        FunctionalMinderNote.id == note_id,
        FunctionalMinderNote.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "便签不存在", 404, {"note_id": note_id})
    return row


def _note_out(n: FunctionalMinderNote) -> schemas.MinderNodeOut:
    return schemas.MinderNodeOut(id=n.id, kind="note", name=n.name,
                                 parent_id=n.parent_id, sort=n.sort)


async def _minder_parent(db, project_id: str, parent_id: str) -> None:
    """父节点只能是本项目的正常模块或便签。

    便签可以挂便签（脑图里再分层）；**模块仍只能挂模块**——模块写路径不认便签父节点，
    所以「模块挂在便签下」只可能是脏数据，`_build_minder` 与删除护栏都按脏数据兜底。
    """
    m = (await db.execute(select(FunctionalModule.id).where(
        FunctionalModule.id == parent_id,
        FunctionalModule.project_id == project_id,
        FunctionalModule.status == STATUS_NORMAL))).first()
    if m is not None:
        return
    n = (await db.execute(select(FunctionalMinderNote.id).where(
        FunctionalMinderNote.id == parent_id,
        FunctionalMinderNote.project_id == project_id))).first()
    if n is not None:
        return
    raise ApiError("not_found", "父节点不存在（只能是本项目的模块或便签）", 404,
                   {"parent_id": parent_id})


async def _note_would_cycle(db, project_id: str, note_id: str,
                            new_parent: str) -> bool:
    cur: str | None = new_parent
    guard = 0
    while cur:
        if cur == note_id:
            return True
        row = (await db.execute(select(FunctionalMinderNote.parent_id).where(
            FunctionalMinderNote.id == cur,
            FunctionalMinderNote.project_id == project_id))).first()
        if row is None:
            return False  # 模块是链的终点
        cur = row[0]
        guard += 1
        if guard > 10000:
            return True
    return False


@service(
    perm="functional:case:read", effect="read", name="functional_minder_tree",
    description="功能用例脑图（模块 + 便签 + 用例叶；回收站不进脑图）",
    http={"method": "GET", "path": "/functional-minder", "tags": ["functional"]},
    tool=False,
)
async def functional_minder_tree(payload: schemas.MinderTreeIn,
                                 ctx) -> schemas.MinderTreeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:read")
    assert ctx.db is not None
    modules = (await ctx.db.execute(select(FunctionalModule).where(
        FunctionalModule.project_id == payload.project_id,
        FunctionalModule.status == STATUS_NORMAL))).scalars().all()
    notes = (await ctx.db.execute(select(FunctionalMinderNote).where(
        FunctionalMinderNote.project_id == payload.project_id))).scalars().all()
    cases = (await ctx.db.execute(select(FunctionalCase).where(
        FunctionalCase.project_id == payload.project_id,
        FunctionalCase.status == STATUS_NORMAL)
        .order_by(FunctionalCase.num))).scalars().all()
    by_module: dict[str, list[FunctionalCase]] = {}
    unfiled: list[FunctionalCase] = []
    # 模块回收前必须先清空用例（`functional_module_delete` 409 护栏），所以正常用例的
    # 模块理论上都在。脏数据下若指向回收站/不存在的模块，宁可归到「未分类」也不隐藏。
    normal_ids = {m.id for m in modules}
    for c in cases:
        if c.module_id and c.module_id in normal_ids:
            by_module.setdefault(c.module_id, []).append(c)
        else:
            unfiled.append(c)
    return schemas.MinderTreeOut(
        project_id=payload.project_id,
        nodes=_build_minder(list(modules), list(notes), by_module),
        unfiled_cases=[_minder_case(c) for c in unfiled],
        total_cases=len(cases),
    )


@service(
    perm="functional:case:update", effect="write", name="functional_minder_note_create",
    description="脑图新建便签（空白节点；父节点只能是本项目的模块或便签）",
    http={"method": "POST", "path": "/functional-minder/notes",
          "tags": ["functional"], "status": 201},
    tool=False,
)
async def functional_minder_note_create(payload: schemas.MinderNoteCreateIn,
                                        ctx) -> schemas.MinderNodeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    if payload.parent_id:
        await _minder_parent(ctx.db, payload.project_id, payload.parent_id)
    total = int((await ctx.db.execute(select(func.count()).select_from(
        FunctionalMinderNote).where(
        FunctionalMinderNote.project_id == payload.project_id))).scalar_one())
    if total >= MINDER_NOTE_MAX:
        raise ApiError("too_many_notes", "便签最多 " + str(MINDER_NOTE_MAX) + " 个",
                       422, {"limit": MINDER_NOTE_MAX})
    n = FunctionalMinderNote(project_id=payload.project_id, parent_id=payload.parent_id,
                             name=payload.name, sort=payload.sort, created_by=ctx.user_id)
    ctx.db.add(n)
    await ctx.db.commit()
    return _note_out(n)


@service(
    perm="functional:case:update", effect="write", name="functional_minder_note_update",
    description="脑图便签改名/移动（防环）",
    http={"method": "PATCH", "path": "/functional-minder/notes/{note_id}",
          "tags": ["functional"]},
    tool=False,
)
async def functional_minder_note_update(payload: schemas.MinderNoteUpdateIn,
                                        ctx) -> schemas.MinderNodeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    n = await _minder_note(ctx.db, payload.project_id, payload.note_id)
    parent_id = n.parent_id
    if payload.parent_set:
        parent_id = payload.parent_id
        if parent_id:
            await _minder_parent(ctx.db, payload.project_id, parent_id)
            if await _note_would_cycle(ctx.db, payload.project_id, n.id, parent_id):
                raise ApiError("cycle", "不能把便签移动到自己的子树里", 422,
                               {"note_id": n.id})
    if payload.name is not None:
        n.name = payload.name
    n.parent_id = parent_id
    if payload.sort is not None:
        n.sort = payload.sort
    await ctx.db.commit()
    return _note_out(n)


@service(
    perm="functional:case:update", effect="destructive", name="functional_minder_note_delete",
    description="删除脑图便签（连子便签一起；下面还有模块 → 409）",
    http={"method": "POST", "path": "/functional-minder/notes/{note_id}/delete",
          "tags": ["functional"]},
    tool=False,
)
async def functional_minder_note_delete(payload: schemas.MinderNoteGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("functional:case:update")
    assert ctx.db is not None
    n = await _minder_note(ctx.db, payload.project_id, payload.note_id)
    rows = (await ctx.db.execute(select(FunctionalMinderNote).where(
        FunctionalMinderNote.project_id == payload.project_id))).scalars().all()
    kids: dict[str | None, list[str]] = {}
    for r in rows:
        kids.setdefault(r.parent_id, []).append(r.id)
    doomed: set[str] = set()
    stack = [n.id]
    while stack:
        cur = stack.pop()
        if cur in doomed:
            continue
        doomed.add(cur)
        stack.extend(kids.get(cur, []))
    mods = int((await ctx.db.execute(select(func.count()).select_from(FunctionalModule).where(
        FunctionalModule.project_id == payload.project_id,
        FunctionalModule.parent_id.in_(doomed)))).scalar_one())
    if mods:
        raise ApiError("note_not_empty",
                       "便签下还有 " + str(mods) + " 个模块，先把它们移走", 409,
                       {"note_id": n.id, "modules": mods})
    await ctx.db.execute(sa_delete(FunctionalMinderNote).where(
        FunctionalMinderNote.project_id == payload.project_id,
        FunctionalMinderNote.id.in_(doomed)))
    await ctx.db.commit()
    return OkOut(ok=True)
