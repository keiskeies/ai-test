"""项目设置 @service（D199）：应用开关 + 误报库。"""
from __future__ import annotations

import re
from datetime import UTC, datetime

from sqlalchemy import or_, select

from app.core.errors import ApiError, OkOut
from app.core.service import ensure_project_access, service
from app.modules.project_settings import schemas
from app.modules.project_settings.models import (
    APP_BY_KEY,
    APPLICATIONS,
    FakeError,
    ProjectApplication,
    PublicScript,
)
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

# D250：公共脚本高级搜索白名单。只收**表格里看得见**的标量列：
# 名称 / 语言 / 版本 / 启用 / 说明。
# - `content` 是脚本正文（大文本），按它做子串搜会把 loader 压垮，也不是「列」的用法；
# - `created_by` / `updated_by` 存的是 id，界面按姓名展示（要联表），不在这把尺上；
# - `created_at` / `updated_at` 不在表格里显示（列表就按 updated_at 倒序），
#   摆进筛选面会让用户以为能按它排序/定位，先不收。
# 关键词与「只看启用」两条快捷轴保留，filter 叠加在其后。
PUBLIC_SCRIPT_LIST_FILTER = ListViewFilter(
    view_type="public_script",
    label="公共脚本",
    fields={
        "name": FieldDecl(PublicScript.name, "text", "脚本名", nullable=False),
        "language": FieldDecl(PublicScript.language, "enum", "语言", nullable=False),
        "version": FieldDecl(PublicScript.version, "number", "版本", nullable=False),
        "enabled": FieldDecl(PublicScript.enabled, "bool", "启用", nullable=False),
        "description": FieldDecl(PublicScript.description, "text", "说明"),
    },
)
register(PUBLIC_SCRIPT_LIST_FILTER)


async def _overrides(db, project_id: str) -> dict[str, bool]:
    rows = (await db.execute(select(ProjectApplication).where(
        ProjectApplication.project_id == project_id))).scalars().all()
    return {r.key: r.enabled for r in rows}


@service(
    perm="project:application:read", effect="read", name="project_application_list",
    description="项目应用开关（代码默认 + 项目覆盖；含分组/标签/说明）",
    http={"method": "GET", "path": "/project-applications", "tags": ["project_settings"]},
)
async def project_application_list(payload: schemas.ApplicationListIn,
                                   ctx) -> schemas.ApplicationListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:application:read")
    assert ctx.db is not None
    over = await _overrides(ctx.db, payload.project_id)
    return schemas.ApplicationListOut(items=[schemas.ApplicationItem(
        key=a["key"], group=a["group"], label=a["label"], description=a["description"],
        default=bool(a["default"]), enabled=over.get(a["key"], bool(a["default"])),
    ) for a in APPLICATIONS])


@service(
    perm="project:application:update", effect="write", name="project_application_update",
    description="切换项目应用开关（未知 key 422；upsert 覆盖行）",
    http={"method": "PATCH", "path": "/project-applications/{key}", "tags": ["project_settings"]},
)
async def project_application_update(payload: schemas.ApplicationUpdateIn,
                                     ctx) -> schemas.ApplicationItem:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:application:update")
    assert ctx.db is not None
    meta = APP_BY_KEY.get(payload.key)
    if meta is None:
        raise ApiError("unknown_application", "未知的项目应用开关", 422, {"key": payload.key})
    row = (await ctx.db.execute(select(ProjectApplication).where(
        ProjectApplication.project_id == payload.project_id,
        ProjectApplication.key == payload.key))).scalar_one_or_none()
    if row is None:
        row = ProjectApplication(project_id=payload.project_id, key=payload.key,
                                 enabled=payload.enabled, updated_by=ctx.user_id,
                                 updated_at=datetime.now(UTC))
        ctx.db.add(row)
    else:
        row.enabled = payload.enabled
        row.updated_by = ctx.user_id
        row.updated_at = datetime.now(UTC)
    await ctx.db.commit()
    return schemas.ApplicationItem(
        key=meta["key"], group=meta["group"], label=meta["label"],
        description=meta["description"], default=bool(meta["default"]),
        enabled=payload.enabled,
    )


@service(
    perm="project:application:read", effect="read", name="project_application_enabled",
    description="内部读取：某项目某开关是否开启（无覆盖行 = 代码默认）",
    http=None, tool=False, dynamic_perm=True,
)
async def project_application_enabled(payload: schemas.ApplicationEnabledIn,
                                      ctx) -> schemas.ApplicationEnabledOut:
    assert ctx.db is not None
    meta = APP_BY_KEY.get(payload.key)
    if meta is None:
        raise ApiError("unknown_application", "未知的项目应用开关", 422, {"key": payload.key})
    row = (await ctx.db.execute(select(ProjectApplication.enabled).where(
        ProjectApplication.project_id == payload.project_id,
        ProjectApplication.key == payload.key))).first()
    return schemas.ApplicationEnabledOut(
        key=payload.key, enabled=bool(row[0]) if row is not None else bool(meta["default"]))


# ══════════ 误报规则 ══════════
def _out(r: FakeError) -> schemas.FakeErrorOut:
    return schemas.FakeErrorOut(
        id=r.id, project_id=r.project_id, name=r.name, pattern=r.pattern,
        match_type=r.match_type, description=r.description, enabled=r.enabled,
        created_by=r.created_by, created_at=schemas.iso(r.created_at),
        updated_at=schemas.iso(r.updated_at))


async def _rule(db, project_id: str, rule_id: str) -> FakeError:
    row = (await db.execute(select(FakeError).where(
        FakeError.id == rule_id, FakeError.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "误报规则不存在", 404, {"rule_id": rule_id})
    return row


def _check_regex(match_type: str | None, pattern: str | None) -> None:
    if match_type == "regex" and pattern:
        try:
            re.compile(pattern)
        except re.error as e:
            raise ApiError("bad_regex", "正则表达式非法：" + str(e), 422, {"pattern": pattern}) from e


async def _name_taken(db, project_id: str, name: str, exclude: str | None = None) -> bool:
    stmt = select(FakeError.id).where(FakeError.project_id == project_id, FakeError.name == name)
    if exclude:
        stmt = stmt.where(FakeError.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="project:fake_error:read", effect="read", name="fake_error_list",
    description="误报规则列表（关键词/只看启用）",
    http={"method": "GET", "path": "/fake-errors", "tags": ["project_settings"]},
)
async def fake_error_list(payload: schemas.FakeErrorListIn,
                          ctx) -> schemas.FakeErrorListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:fake_error:read")
    assert ctx.db is not None
    stmt = select(FakeError).where(FakeError.project_id == payload.project_id)
    if payload.enabled_only:
        stmt = stmt.where(FakeError.enabled.is_(True))
    if payload.keyword:
        stmt = stmt.where(or_(
            FakeError.name.contains(payload.keyword, autoescape=True),
            FakeError.pattern.contains(payload.keyword, autoescape=True),
        ))
    rows = (await ctx.db.execute(stmt.order_by(FakeError.created_at, FakeError.id))).scalars().all()
    return schemas.FakeErrorListOut(items=[_out(r) for r in rows])


@service(
    perm="project:fake_error:read", effect="read", name="fake_error_get",
    description="误报规则详情",
    http={"method": "GET", "path": "/fake-errors/{rule_id}", "tags": ["project_settings"]},
)
async def fake_error_get(payload: schemas.FakeErrorGetIn, ctx) -> schemas.FakeErrorOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:fake_error:read")
    assert ctx.db is not None
    return _out(await _rule(ctx.db, payload.project_id, payload.rule_id))


@service(
    perm="project:fake_error:create", effect="write", name="fake_error_create",
    description="新增误报规则（名称项目内唯一；regex 先编译校验）",
    http={"method": "POST", "path": "/fake-errors", "tags": ["project_settings"], "status": 201},
)
async def fake_error_create(payload: schemas.FakeErrorCreateIn,
                            ctx) -> schemas.FakeErrorOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:fake_error:create")
    assert ctx.db is not None
    if await _name_taken(ctx.db, payload.project_id, payload.name):
        raise ApiError("conflict", "误报规则名已存在", 409, {"name": payload.name})
    _check_regex(payload.match_type, payload.pattern)
    row = FakeError(project_id=payload.project_id, name=payload.name, pattern=payload.pattern,
                    match_type=payload.match_type, description=payload.description,
                    enabled=payload.enabled, created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.commit()
    return _out(row)


@service(
    perm="project:fake_error:update", effect="write", name="fake_error_update",
    description="更新误报规则",
    http={"method": "PATCH", "path": "/fake-errors/{rule_id}", "tags": ["project_settings"]},
)
async def fake_error_update(payload: schemas.FakeErrorUpdateIn,
                            ctx) -> schemas.FakeErrorOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:fake_error:update")
    assert ctx.db is not None
    row = await _rule(ctx.db, payload.project_id, payload.rule_id)
    if payload.name is not None and payload.name != row.name:
        if await _name_taken(ctx.db, payload.project_id, payload.name, exclude=row.id):
            raise ApiError("conflict", "误报规则名已存在", 409, {"name": payload.name})
        row.name = payload.name
    if payload.pattern is not None:
        row.pattern = payload.pattern
    if payload.match_type is not None:
        row.match_type = payload.match_type
    _check_regex(row.match_type, row.pattern)
    if payload.description is not None:
        row.description = payload.description
    if payload.enabled is not None:
        row.enabled = payload.enabled
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _out(row)


@service(
    perm="project:fake_error:delete", effect="destructive", name="fake_error_delete",
    description="删除误报规则",
    http={"method": "POST", "path": "/fake-errors/{rule_id}/delete", "tags": ["project_settings"]},
)
async def fake_error_delete(payload: schemas.FakeErrorDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:fake_error:delete")
    assert ctx.db is not None
    row = await _rule(ctx.db, payload.project_id, payload.rule_id)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


# ══════════ 公共脚本 ══════════
def _script_out(r: PublicScript) -> schemas.ScriptOut:
    return schemas.ScriptOut(
        id=r.id, project_id=r.project_id, name=r.name, description=r.description,
        language=r.language, content=r.content, enabled=r.enabled, version=r.version,
        created_by=r.created_by, created_at=schemas.iso(r.created_at),
        updated_at=schemas.iso(r.updated_at))


async def _script(db, project_id: str, script_id: str) -> PublicScript:
    row = (await db.execute(select(PublicScript).where(
        PublicScript.id == script_id,
        PublicScript.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "公共脚本不存在", 404, {"script_id": script_id})
    return row


async def _script_name_taken(db, project_id: str, name: str, exclude: str | None = None) -> bool:
    stmt = select(PublicScript.id).where(PublicScript.project_id == project_id,
                                         PublicScript.name == name)
    if exclude:
        stmt = stmt.where(PublicScript.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="project:script:read", effect="read", name="public_script_list",
    description="公共脚本列表（关键词/只看启用）",
    http={"method": "GET", "path": "/public-scripts", "tags": ["project_settings"]},
)
async def public_script_list(payload: schemas.ScriptListIn, ctx) -> schemas.ScriptListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:script:read")
    assert ctx.db is not None
    stmt = select(PublicScript).where(PublicScript.project_id == payload.project_id)
    if payload.enabled_only:
        stmt = stmt.where(PublicScript.enabled.is_(True))
    if payload.keyword:
        stmt = stmt.where(or_(
            PublicScript.name.contains(payload.keyword, autoescape=True),
            PublicScript.description.contains(payload.keyword, autoescape=True),
        ))
    stmt = stmt.where(PUBLIC_SCRIPT_LIST_FILTER.parse(payload.filter))
    rows = (await ctx.db.execute(stmt.order_by(PublicScript.updated_at.desc(),
                                              PublicScript.id))).scalars().all()
    return schemas.ScriptListOut(items=[_script_out(r) for r in rows])


@service(
    perm="project:script:read", effect="read", name="public_script_get",
    description="公共脚本详情",
    http={"method": "GET", "path": "/public-scripts/{script_id}", "tags": ["project_settings"]},
)
async def public_script_get(payload: schemas.ScriptGetIn, ctx) -> schemas.ScriptOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:script:read")
    assert ctx.db is not None
    return _script_out(await _script(ctx.db, payload.project_id, payload.script_id))


@service(
    perm="project:script:create", effect="write", name="public_script_create",
    description="新建公共脚本（名称项目内唯一）",
    http={"method": "POST", "path": "/public-scripts", "tags": ["project_settings"], "status": 201},
)
async def public_script_create(payload: schemas.ScriptCreateIn, ctx) -> schemas.ScriptOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:script:create")
    assert ctx.db is not None
    if await _script_name_taken(ctx.db, payload.project_id, payload.name):
        raise ApiError("conflict", "脚本名已存在", 409, {"name": payload.name})
    row = PublicScript(project_id=payload.project_id, name=payload.name,
                       description=payload.description, language=payload.language,
                       content=payload.content, enabled=payload.enabled, version=1,
                       created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.commit()
    return _script_out(row)


@service(
    perm="project:script:update", effect="write", name="public_script_update",
    description="更新公共脚本（内容变化时 version+1）",
    http={"method": "PATCH", "path": "/public-scripts/{script_id}", "tags": ["project_settings"]},
)
async def public_script_update(payload: schemas.ScriptUpdateIn, ctx) -> schemas.ScriptOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:script:update")
    assert ctx.db is not None
    row = await _script(ctx.db, payload.project_id, payload.script_id)
    if payload.name is not None and payload.name != row.name:
        if await _script_name_taken(ctx.db, payload.project_id, payload.name, exclude=row.id):
            raise ApiError("conflict", "脚本名已存在", 409, {"name": payload.name})
        row.name = payload.name
    if payload.description is not None:
        row.description = payload.description
    if payload.language is not None:
        row.language = payload.language
    if payload.enabled is not None:
        row.enabled = payload.enabled
    if payload.content is not None and payload.content != row.content:
        row.content = payload.content
        row.version += 1
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _script_out(row)


@service(
    perm="project:script:delete", effect="destructive", name="public_script_delete",
    description="删除公共脚本",
    http={"method": "POST", "path": "/public-scripts/{script_id}/delete", "tags": ["project_settings"]},
)
async def public_script_delete(payload: schemas.ScriptDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:script:delete")
    assert ctx.db is not None
    row = await _script(ctx.db, payload.project_id, payload.script_id)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="project:script:update", effect="write", name="public_script_status",
    description="启用/停用公共脚本",
    http={"method": "POST", "path": "/public-scripts/{script_id}/status", "tags": ["project_settings"]},
)
async def public_script_status(payload: schemas.ScriptStatusIn, ctx) -> schemas.ScriptOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:script:update")
    assert ctx.db is not None
    row = await _script(ctx.db, payload.project_id, payload.script_id)
    row.enabled = payload.enabled
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _script_out(row)
