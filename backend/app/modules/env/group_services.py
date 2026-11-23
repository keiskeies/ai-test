"""环境组 @service（D200 / C1）：多环境打包。"""
from __future__ import annotations

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select

from app.core.errors import ApiError, OkOut
from app.core.service import ensure_project_access, service
from app.modules.env import group_schemas as schemas
from app.modules.env.models import Environment, EnvironmentGroup, EnvironmentGroupItem
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

# D259：`envs` 是跨 environment_group_item + environment 的打包结果（卡片里展示成 Tag），
# 不是一个真列。按环境名筛用**相关标量子查询**把组内环境名拼成一个串（GROUP_CONCAT），
# 于是 CONTAINS / NOT_CONTAINS / EMPTY / NOT_EMPTY 都有诚实语义：
#   包含 X = 至少一个环境名含 X；为空 = 组里没有环境。
# 其余操作符（EQUALS/IN…）对拼接串在多个环境时必然漏判，**刻意收窄**（假筛选项禁令）——
# 前端下拉从 filter-meta 的 ops 现取，不会摆出这些选项。
# project_id 是取数轴，不重复登记。
_ENV_NAMES = (
    select(func.group_concat(Environment.name, ", "))
    .select_from(EnvironmentGroupItem)
    .join(Environment, Environment.id == EnvironmentGroupItem.env_id)
    .where(EnvironmentGroupItem.group_id == EnvironmentGroup.id)
    .correlate(EnvironmentGroup)
    .scalar_subquery()
)

ENV_GROUP_LIST_FILTER = ListViewFilter(
    view_type="env_group",
    label="环境组",
    fields={
        "name": FieldDecl(EnvironmentGroup.name, "text", "组名", nullable=False),
        "description": FieldDecl(EnvironmentGroup.description, "text", "说明"),
        "envs": FieldDecl(_ENV_NAMES, "text", "组内环境名", nullable=True,
                          ops_override=frozenset({"CONTAINS", "NOT_CONTAINS",
                                                  "EMPTY", "NOT_EMPTY"})),
        "created_at": FieldDecl(EnvironmentGroup.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(EnvironmentGroup.updated_at, "time", "更新时间", nullable=False),
    },
)
register(ENV_GROUP_LIST_FILTER)


async def _group(db, project_id: str, group_id: str) -> EnvironmentGroup:
    row = (await db.execute(select(EnvironmentGroup).where(
        EnvironmentGroup.id == group_id,
        EnvironmentGroup.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "环境组不存在", 404, {"group_id": group_id})
    return row


async def _validate_envs(db, project_id: str, env_ids: list[str]) -> list[str]:
    uniq = list(dict.fromkeys(env_ids))
    if not uniq:
        return []
    rows = (await db.execute(select(Environment.id).where(
        Environment.id.in_(uniq), Environment.project_id == project_id))).scalars().all()
    found = set(rows)
    missing = [e for e in uniq if e not in found]
    if missing:
        raise ApiError("unknown_env", "有环境不存在或不属于本项目", 422, {"missing": missing})
    return uniq


async def _out(db, g: EnvironmentGroup) -> schemas.EnvGroupOut:
    rows = (await db.execute(
        select(Environment.id, Environment.name)
        .join(EnvironmentGroupItem, EnvironmentGroupItem.env_id == Environment.id)
        .where(EnvironmentGroupItem.group_id == g.id)
        .order_by(EnvironmentGroupItem.sort, Environment.name))).all()
    return schemas.EnvGroupOut(
        id=g.id, project_id=g.project_id, name=g.name, description=g.description,
        envs=[schemas.EnvBrief(id=r.id, name=r.name) for r in rows],
        created_at=schemas.iso(g.created_at), updated_at=schemas.iso(g.updated_at))


async def _name_taken(db, project_id: str, name: str, exclude: str | None = None) -> bool:
    stmt = select(EnvironmentGroup.id).where(
        EnvironmentGroup.project_id == project_id, EnvironmentGroup.name == name)
    if exclude:
        stmt = stmt.where(EnvironmentGroup.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


async def _replace_envs(db, plan: EnvironmentGroup, env_ids: list[str]) -> None:
    await db.execute(sa_delete(EnvironmentGroupItem).where(
        EnvironmentGroupItem.group_id == plan.id))
    for i, eid in enumerate(env_ids):
        db.add(EnvironmentGroupItem(group_id=plan.id, env_id=eid,
                                    project_id=plan.project_id, sort=i))


@service(
    perm="env:group:read", effect="read", name="env_group_list",
    description="环境组列表（含每个组的环境）",
    http={"method": "GET", "path": "/env-groups", "tags": ["env"]},
)
async def env_group_list(payload: schemas.EnvGroupListIn, ctx) -> schemas.EnvGroupListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:group:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(EnvironmentGroup).where(
        EnvironmentGroup.project_id == payload.project_id,
        ENV_GROUP_LIST_FILTER.parse(payload.filter),
    ).order_by(EnvironmentGroup.created_at, EnvironmentGroup.id))).scalars().all()
    return schemas.EnvGroupListOut(items=[await _out(ctx.db, g) for g in rows])


@service(
    perm="env:group:create", effect="write", name="env_group_create",
    description="新建环境组（名称项目内唯一）",
    http={"method": "POST", "path": "/env-groups", "tags": ["env"], "status": 201},
)
async def env_group_create(payload: schemas.EnvGroupCreateIn, ctx) -> schemas.EnvGroupOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:group:create")
    assert ctx.db is not None
    env_ids = await _validate_envs(ctx.db, payload.project_id, payload.env_ids)
    if await _name_taken(ctx.db, payload.project_id, payload.name):
        raise ApiError("conflict", "环境组名已存在", 409, {"name": payload.name})
    g = EnvironmentGroup(project_id=payload.project_id, name=payload.name,
                         description=payload.description, created_by=ctx.user_id,
                         updated_by=ctx.user_id)
    ctx.db.add(g)
    await ctx.db.flush()
    await _replace_envs(ctx.db, g, env_ids)
    await ctx.db.commit()
    return await _out(ctx.db, g)


@service(
    perm="env:group:update", effect="write", name="env_group_update",
    description="更新环境组（env_ids 传了即整体替换）",
    http={"method": "PATCH", "path": "/env-groups/{group_id}", "tags": ["env"]},
)
async def env_group_update(payload: schemas.EnvGroupUpdateIn, ctx) -> schemas.EnvGroupOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:group:update")
    assert ctx.db is not None
    g = await _group(ctx.db, payload.project_id, payload.group_id)
    if payload.name is not None and payload.name != g.name:
        if await _name_taken(ctx.db, payload.project_id, payload.name, exclude=g.id):
            raise ApiError("conflict", "环境组名已存在", 409, {"name": payload.name})
        g.name = payload.name
    if payload.description is not None:
        g.description = payload.description
    if payload.env_ids is not None:
        await _replace_envs(ctx.db, g, await _validate_envs(ctx.db, payload.project_id, payload.env_ids))
    g.updated_by = ctx.user_id
    await ctx.db.commit()
    return await _out(ctx.db, g)


@service(
    perm="env:group:read", effect="read", name="env_group_get",
    description="环境组详情",
    http={"method": "GET", "path": "/env-groups/{group_id}", "tags": ["env"]},
)
async def env_group_get(payload: schemas.EnvGroupGetIn, ctx) -> schemas.EnvGroupOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:group:read")
    assert ctx.db is not None
    return await _out(ctx.db, await _group(ctx.db, payload.project_id, payload.group_id))


@service(
    perm="env:group:delete", effect="destructive", name="env_group_delete",
    description="删除环境组（只删打包关系，不删环境本身）",
    http={"method": "POST", "path": "/env-groups/{group_id}/delete", "tags": ["env"]},
)
async def env_group_delete(payload: schemas.EnvGroupGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:group:delete")
    assert ctx.db is not None
    g = await _group(ctx.db, payload.project_id, payload.group_id)
    await ctx.db.execute(sa_delete(EnvironmentGroupItem).where(
        EnvironmentGroupItem.group_id == g.id))
    await ctx.db.delete(g)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="env:group:update", effect="write", name="env_group_envs_add",
    description="向环境组加环境（replace/append）",
    http={"method": "POST", "path": "/env-groups/{group_id}/envs", "tags": ["env"]},
)
async def env_group_envs_add(payload: schemas.EnvGroupEnvsIn, ctx) -> schemas.EnvGroupEnvsOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:group:update")
    assert ctx.db is not None
    g = await _group(ctx.db, payload.project_id, payload.group_id)
    env_ids = await _validate_envs(ctx.db, payload.project_id, payload.env_ids)
    if payload.mode == "replace" or payload.mode == "append":
        existing = set((await ctx.db.execute(select(EnvironmentGroupItem.env_id).where(
            EnvironmentGroupItem.group_id == g.id))).scalars().all())
        if payload.mode == "append":
            env_ids = list(existing) + [e for e in env_ids if e not in existing]
        await _replace_envs(ctx.db, g, env_ids)
    g.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.EnvGroupEnvsOut(affected=len(env_ids))


@service(
    perm="env:group:update", effect="write", name="env_group_env_remove",
    description="从环境组移除一个环境",
    http={"method": "POST", "path": "/env-groups/{group_id}/envs/{env_id}/delete", "tags": ["env"]},
)
async def env_group_env_remove(payload: schemas.EnvGroupEnvRemoveIn,
                               ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:group:update")
    assert ctx.db is not None
    g = await _group(ctx.db, payload.project_id, payload.group_id)
    hit = (await ctx.db.execute(select(EnvironmentGroupItem).where(
        EnvironmentGroupItem.group_id == g.id,
        EnvironmentGroupItem.env_id == payload.env_id))).scalar_one_or_none()
    if hit is None:
        raise ApiError("not_found", "该环境不在此组里", 404, {"env_id": payload.env_id})
    await ctx.db.delete(hit)
    g.updated_by = ctx.user_id
    await ctx.db.commit()
    return OkOut(ok=True)
