"""Mock @service（D201）：服务与规则管理；公开匹配在 routes.py。"""
from __future__ import annotations

import re

from sqlalchemy import func, select

from app.core.errors import ApiError, OkOut
from app.core.service import ensure_project_access, service
from app.modules.mock import schemas
from app.modules.mock.models import MockRule, MockService
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

# D241：Mock 规则页高级搜索（D47-a 三件套铺到 Mock 规则列表）。白名单只收
# mock_rule 上**真实、且用户看得懂**的标量列：
# - `service_id` / `project_id` 是取数作用域（页面已按选中的服务取数），不开放为条件；
# - `headers` / `body` 是 JSON / 长文本响应内容，没有稳定的标量比较语义；
# - `id` 不进：规则表本来就是「当前服务的规则」小集合，页面没有按 id 找的需求。
MOCK_RULE_LIST_FILTER = ListViewFilter(
    view_type="mock_rule",
    label="Mock 规则",
    fields={
        "name": FieldDecl(MockRule.name, "text", "规则名", nullable=False),
        "method": FieldDecl(MockRule.method, "enum", "请求方法", nullable=False),
        "path": FieldDecl(MockRule.path, "text", "匹配路径", nullable=False),
        "match_type": FieldDecl(MockRule.match_type, "enum", "匹配方式", nullable=False),
        "status_code": FieldDecl(MockRule.status_code, "number", "状态码", nullable=False),
        "delay_ms": FieldDecl(MockRule.delay_ms, "number", "延迟（ms）", nullable=False),
        "priority": FieldDecl(MockRule.priority, "number", "优先级", nullable=False),
        # enabled 是 Boolean 列：用 number（1/0）而不是 bool——前端值控件对 bool 没有
        # 稳定的标量输入（Option 值是字符串，后端又只收真布尔），1/0 在 MySQL 上同义。
        "enabled": FieldDecl(MockRule.enabled, "number", "启用（1/0）", nullable=False),
        "created_by": FieldDecl(MockRule.created_by, "id", "创建人"),
        "updated_by": FieldDecl(MockRule.updated_by, "id", "更新人"),
        "created_at": FieldDecl(MockRule.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(MockRule.updated_at, "time", "更新时间", nullable=False),
    },
)
register(MOCK_RULE_LIST_FILTER)


async def _service(db, project_id: str, service_id: str) -> MockService:
    row = (await db.execute(select(MockService).where(
        MockService.id == service_id,
        MockService.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "Mock 服务不存在", 404, {"service_id": service_id})
    return row


async def _rule(db, project_id: str, rule_id: str) -> MockRule:
    row = (await db.execute(select(MockRule).where(
        MockRule.id == rule_id, MockRule.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "Mock 规则不存在", 404, {"rule_id": rule_id})
    return row


async def _service_out(db, s: MockService) -> schemas.ServiceOut:
    n = int((await db.execute(select(func.count()).select_from(MockRule).where(
        MockRule.service_id == s.id))).scalar_one())
    return schemas.ServiceOut(
        id=s.id, project_id=s.project_id, name=s.name, description=s.description,
        enabled=s.enabled, rule_count=n, mock_base="/mock/" + s.id,
        created_at=schemas.iso(s.created_at), updated_at=schemas.iso(s.updated_at))


def _rule_out(r: MockRule) -> schemas.RuleOut:
    return schemas.RuleOut(
        id=r.id, project_id=r.project_id, service_id=r.service_id, name=r.name,
        method=r.method, path=r.path, match_type=r.match_type,
        status_code=r.status_code, headers=r.headers, body=r.body,
        delay_ms=r.delay_ms, priority=r.priority, enabled=r.enabled,
        created_at=schemas.iso(r.created_at), updated_at=schemas.iso(r.updated_at))


async def _service_name_taken(db, project_id: str, name: str, exclude: str | None = None) -> bool:
    stmt = select(MockService.id).where(MockService.project_id == project_id,
                                        MockService.name == name)
    if exclude:
        stmt = stmt.where(MockService.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


def check_regex(match_type: str, path: str) -> None:
    if match_type == "regex":
        try:
            re.compile(path)
        except re.error as e:
            raise ApiError("bad_regex", "路径正则非法：" + str(e), 422, {"path": path}) from e


def match_rule(rules: list[MockRule], method: str, path: str) -> MockRule | None:
    """方法 + 路径匹配；按 priority desc、created_at asc 取第一条。"""
    candidates = []
    for r in rules:
        if not r.enabled:
            continue
        if r.method not in (method.upper(), "ANY"):
            continue
        if r.match_type == "exact" and r.path != path:
            continue
        if r.match_type == "prefix" and not path.startswith(r.path):
            continue
        if r.match_type == "regex":
            try:
                if re.fullmatch(r.path, path) is None:
                    continue
            except re.error:
                continue
        candidates.append(r)
    if not candidates:
        return None
    candidates.sort(key=lambda x: (-x.priority, x.created_at, x.id))
    return candidates[0]


@service(
    perm="mock:mock:read", effect="read", name="mock_service_list",
    description="Mock 服务列表（含规则数与公开基址）",
    http={"method": "GET", "path": "/mock-services", "tags": ["mock"]},
)
async def mock_service_list(payload: schemas.ServiceListIn, ctx) -> schemas.ServiceListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(MockService).where(
        MockService.project_id == payload.project_id
    ).order_by(MockService.created_at, MockService.id))).scalars().all()
    return schemas.ServiceListOut(items=[await _service_out(ctx.db, s) for s in rows])


@service(
    perm="mock:mock:read", effect="read", name="mock_service_get",
    description="Mock 服务详情",
    http={"method": "GET", "path": "/mock-services/{service_id}", "tags": ["mock"]},
)
async def mock_service_get(payload: schemas.ServiceGetIn, ctx) -> schemas.ServiceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:read")
    assert ctx.db is not None
    return await _service_out(ctx.db, await _service(ctx.db, payload.project_id, payload.service_id))


@service(
    perm="mock:mock:create", effect="write", name="mock_service_create",
    description="新建 Mock 服务（名称项目内唯一）",
    http={"method": "POST", "path": "/mock-services", "tags": ["mock"], "status": 201},
)
async def mock_service_create(payload: schemas.ServiceCreateIn, ctx) -> schemas.ServiceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:create")
    assert ctx.db is not None
    if await _service_name_taken(ctx.db, payload.project_id, payload.name):
        raise ApiError("conflict", "Mock 服务名已存在", 409, {"name": payload.name})
    s = MockService(project_id=payload.project_id, name=payload.name,
                    description=payload.description, enabled=payload.enabled,
                    created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(s)
    await ctx.db.commit()
    return await _service_out(ctx.db, s)


@service(
    perm="mock:mock:update", effect="write", name="mock_service_update",
    description="更新 Mock 服务（含启停）",
    http={"method": "PATCH", "path": "/mock-services/{service_id}", "tags": ["mock"]},
)
async def mock_service_update(payload: schemas.ServiceUpdateIn, ctx) -> schemas.ServiceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:update")
    assert ctx.db is not None
    s = await _service(ctx.db, payload.project_id, payload.service_id)
    if payload.name is not None and payload.name != s.name:
        if await _service_name_taken(ctx.db, payload.project_id, payload.name, exclude=s.id):
            raise ApiError("conflict", "Mock 服务名已存在", 409, {"name": payload.name})
        s.name = payload.name
    if payload.description is not None:
        s.description = payload.description
    if payload.enabled is not None:
        s.enabled = payload.enabled
    s.updated_by = ctx.user_id
    await ctx.db.commit()
    return await _service_out(ctx.db, s)


@service(
    perm="mock:mock:delete", effect="destructive", name="mock_service_delete",
    description="删除 Mock 服务（连同规则）",
    http={"method": "POST", "path": "/mock-services/{service_id}/delete", "tags": ["mock"]},
)
async def mock_service_delete(payload: schemas.ServiceDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:delete")
    assert ctx.db is not None
    s = await _service(ctx.db, payload.project_id, payload.service_id)
    from sqlalchemy import delete as sa_delete

    await ctx.db.execute(sa_delete(MockRule).where(MockRule.service_id == s.id))
    await ctx.db.delete(s)
    await ctx.db.commit()
    return OkOut(ok=True)


# ══════════ 规则 ══════════
@service(
    perm="mock:mock:read", effect="read", name="mock_rule_list",
    description="Mock 服务的规则列表（priority desc；filter 高级搜索条件组，D241）",
    http={"method": "GET", "path": "/mock-services/{service_id}/rules", "tags": ["mock"]},
)
async def mock_rule_list(payload: schemas.RuleListIn, ctx) -> schemas.RuleListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:read")
    assert ctx.db is not None
    await _service(ctx.db, payload.project_id, payload.service_id)
    stmt = select(MockRule).where(
        MockRule.project_id == payload.project_id,
        MockRule.service_id == payload.service_id
    )
    # D241：条件在服务作用域内再 AND（作用域由上面的 where 把关，filter 不碰它）。
    stmt = stmt.where(MOCK_RULE_LIST_FILTER.parse(payload.filter))
    rows = (await ctx.db.execute(
        stmt.order_by(MockRule.priority.desc(), MockRule.created_at, MockRule.id))).scalars().all()
    return schemas.RuleListOut(items=[_rule_out(r) for r in rows])


@service(
    perm="mock:mock:read", effect="read", name="mock_rule_get",
    description="Mock 规则详情",
    http={"method": "GET", "path": "/mock-rules/{rule_id}", "tags": ["mock"]},
)
async def mock_rule_get(payload: schemas.RuleGetIn, ctx) -> schemas.RuleOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:read")
    assert ctx.db is not None
    return _rule_out(await _rule(ctx.db, payload.project_id, payload.rule_id))


@service(
    perm="mock:mock:create", effect="write", name="mock_rule_create",
    description="新建 Mock 规则（regex 路径先编译）",
    http={"method": "POST", "path": "/mock-rules", "tags": ["mock"], "status": 201},
)
async def mock_rule_create(payload: schemas.RuleCreateIn, ctx) -> schemas.RuleOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:create")
    assert ctx.db is not None
    await _service(ctx.db, payload.project_id, payload.service_id)
    check_regex(payload.match_type, payload.path)
    r = MockRule(project_id=payload.project_id, service_id=payload.service_id,
                 name=payload.name, method=payload.method.upper(), path=payload.path,
                 match_type=payload.match_type, status_code=payload.status_code,
                 headers=payload.headers, body=payload.body, delay_ms=payload.delay_ms,
                 priority=payload.priority, enabled=payload.enabled,
                 created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(r)
    await ctx.db.commit()
    return _rule_out(r)


@service(
    perm="mock:mock:update", effect="write", name="mock_rule_update",
    description="更新 Mock 规则",
    http={"method": "PATCH", "path": "/mock-rules/{rule_id}", "tags": ["mock"]},
)
async def mock_rule_update(payload: schemas.RuleUpdateIn, ctx) -> schemas.RuleOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:update")
    assert ctx.db is not None
    r = await _rule(ctx.db, payload.project_id, payload.rule_id)
    if payload.name is not None:
        r.name = payload.name
    if payload.method is not None:
        r.method = payload.method.upper()
    if payload.path is not None:
        r.path = payload.path
    if payload.match_type is not None:
        r.match_type = payload.match_type
    if payload.status_code is not None:
        r.status_code = payload.status_code
    if payload.headers is not None:
        r.headers = payload.headers
    if payload.body is not None:
        r.body = payload.body
    if payload.delay_ms is not None:
        r.delay_ms = payload.delay_ms
    if payload.priority is not None:
        r.priority = payload.priority
    if payload.enabled is not None:
        r.enabled = payload.enabled
    check_regex(r.match_type, r.path)
    r.updated_by = ctx.user_id
    await ctx.db.commit()
    return _rule_out(r)


@service(
    perm="mock:mock:delete", effect="destructive", name="mock_rule_delete",
    description="删除 Mock 规则",
    http={"method": "POST", "path": "/mock-rules/{rule_id}/delete", "tags": ["mock"]},
)
async def mock_rule_delete(payload: schemas.RuleDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:delete")
    assert ctx.db is not None
    r = await _rule(ctx.db, payload.project_id, payload.rule_id)
    await ctx.db.delete(r)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="mock:mock:read", effect="read", name="mock_rule_test",
    description="用方法与路径试探会命中哪条规则（管理页调试）",
    http={"method": "POST", "path": "/mock-rules/test", "tags": ["mock"]},
)
async def mock_rule_test(payload: schemas.RuleTestIn, ctx) -> schemas.RuleTestOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("mock:mock:read")
    assert ctx.db is not None
    await _service(ctx.db, payload.project_id, payload.service_id)
    rows = (await ctx.db.execute(select(MockRule).where(
        MockRule.project_id == payload.project_id,
        MockRule.service_id == payload.service_id))).scalars().all()
    hit = match_rule(list(rows), payload.method, payload.path)
    return schemas.RuleTestOut(matched=hit is not None, rule=_rule_out(hit) if hit else None)
