"""用例评审域 @service（D194）。

口径（D194 计划，逐条对应 MS 取证 §C）：
- 评审状态/通过率**读时聚合**，库里没有第二份 status/pass_rate/case_count。
- 每条用例的当前结论存关联行 `result`，提交结论的同一事务重算；不是 MS 的 @Async 增量。
- 评审人只有 per-case 一张表；编辑评审人显式 replace/append 并重算受影响用例。
- 结论历史 append-only；重审把旧结论 active=False + 关联行 re_review=True。
- 评审模块删除非空拒绝（MS 会级联删评审）。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import column, func, select, table
from sqlalchemy import delete as sa_delete
from sqlalchemy import update as sa_update

from app.core.errors import ApiError, OkOut, Page, paginate_page
from app.core.registry import REGISTRY
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.review import schemas
from app.modules.review.models import (
    STATUS_NORMAL,
    STATUS_RECYCLED,
    CaseReview,
    CaseReviewCase,
    CaseReviewModule,
    CaseReviewResult,
    CaseReviewReviewer,
)
from app.modules.review.queries import my_todo_review_ids
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

FUNCTIONAL_CASE = table("functional_case", column("id"), column("project_id"),
                        column("name"), column("status"))
APP_USER = table("app_user", column("id"), column("name"), column("account"))

# D221：评审列表的可筛面（D47-a 三件套铺到评审页）。字段全是 case_review 上真实存在的列，
# 白名单外 400 带本页清单。这些轴刻意不进条件组：
# - `module_id` / `unfiled_only` 是左树取数轴，与条件组并行 AND 而不是互相替代；
# - `keyword` 是快捷搜索框（同名字段由它表达，进条件组会出现两套「名称含」写法）；
# - `status`（未开始/评审中/已完成）与 `pass_rate`/`case_count` 一样是**读时聚合**出来的，
#   库里没有这一列，进白名单就是假筛选项；
# - `created_by_me` / `reviewing_me` / `my_todo` 是「我」的视图开关（同一列配上当前用户，
#   不是任意值筛选）；`current`/`size` 是取数机制参数。
CASE_REVIEW_LIST_FILTER = ListViewFilter(
    view_type="case_review",
    label="用例评审",
    fields={
        "num": FieldDecl(CaseReview.num, "number", "编号", nullable=False),
        "name": FieldDecl(CaseReview.name, "text", "评审名称", nullable=False),
        "description": FieldDecl(CaseReview.description, "text", "描述"),
        "pass_rule": FieldDecl(CaseReview.pass_rule, "enum", "通过规则", nullable=False),
        "started": FieldDecl(CaseReview.started, "bool", "已开始", nullable=False),
        "start_at": FieldDecl(CaseReview.start_at, "time", "开始时间"),
        "end_at": FieldDecl(CaseReview.end_at, "time", "结束时间"),
        "created_by": FieldDecl(CaseReview.created_by, "id", "创建人"),
        "updated_by": FieldDecl(CaseReview.updated_by, "id", "更新人"),
        "created_at": FieldDecl(CaseReview.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(CaseReview.updated_at, "time", "更新时间", nullable=False),
    },
)
register(CASE_REVIEW_LIST_FILTER)


async def _user_names(db, ids: set[str | None]) -> dict[str, str]:
    real = {i for i in ids if i}
    if not real:
        return {}
    rows = (await db.execute(select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(real)))).all()
    return {r.id: r.name for r in rows}


async def _next_num(ctx, project_id: str) -> int:
    spec = REGISTRY.get("project_num_next")
    assert spec is not None
    out = await spec.handler(spec.model.model_validate({
        "project_id": project_id, "scene": "case_review",
    }), ctx)
    return int(out.num)


async def _module(db, project_id: str, module_id: str, *, include_recycled: bool = False) -> CaseReviewModule:
    row = (await db.execute(select(CaseReviewModule).where(
        CaseReviewModule.id == module_id,
        CaseReviewModule.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "评审模块不存在", 404, {"module_id": module_id})
    if row.status == STATUS_RECYCLED and not include_recycled:
        raise ApiError("not_found", "评审模块不存在（在回收站）", 404, {"module_id": module_id})
    return row


async def _review(db, project_id: str, review_id: str) -> CaseReview:
    row = (await db.execute(select(CaseReview).where(
        CaseReview.id == review_id, CaseReview.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "评审不存在", 404, {"review_id": review_id})
    return row


async def _link(db, project_id: str, review_id: str, case_id: str) -> CaseReviewCase:
    row = (await db.execute(select(CaseReviewCase).where(
        CaseReviewCase.project_id == project_id,
        CaseReviewCase.review_id == review_id,
        CaseReviewCase.case_id == case_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "用例不在该评审里", 404, {"case_id": case_id})
    return row


async def _case_names(db, project_id: str, case_ids: set[str]) -> dict[str, str]:
    if not case_ids:
        return {}
    rows = (await db.execute(select(FUNCTIONAL_CASE.c.id, FUNCTIONAL_CASE.c.name).where(
        FUNCTIONAL_CASE.c.project_id == project_id,
        FUNCTIONAL_CASE.c.id.in_(case_ids)))).all()
    return {r.id: r.name for r in rows}


async def _validate_cases(db, project_id: str, case_ids: list[str]) -> list[str]:
    uniq = list(dict.fromkeys(case_ids))
    if not uniq:
        return []
    rows = (await db.execute(select(FUNCTIONAL_CASE.c.id).where(
        FUNCTIONAL_CASE.c.project_id == project_id,
        FUNCTIONAL_CASE.c.id.in_(uniq),
        FUNCTIONAL_CASE.c.status == STATUS_NORMAL))).scalars().all()
    found = set(rows)
    missing = [c for c in uniq if c not in found]
    if missing:
        raise ApiError("unknown_case", "有 " + str(len(missing)) + " 条用例不存在、在回收站或不属于本项目",
                       422, {"missing": missing})
    return uniq


async def _validate_users(db, user_ids: list[str]) -> list[str]:
    uniq = list(dict.fromkeys(user_ids))
    if not uniq:
        return []
    rows = (await db.execute(select(APP_USER.c.id).where(APP_USER.c.id.in_(uniq)))).scalars().all()
    found = set(rows)
    missing = [u for u in uniq if u not in found]
    if missing:
        raise ApiError("unknown_user", "有评审人不存在", 422, {"missing": missing})
    return uniq


async def _reviewers_map(db, review_id: str, case_ids: list[str]) -> dict[str, list[schemas.ReviewerOut]]:
    if not case_ids:
        return {}
    rows = (await db.execute(select(CaseReviewReviewer).where(
        CaseReviewReviewer.review_id == review_id,
        CaseReviewReviewer.case_id.in_(case_ids)))).scalars().all()
    names = await _user_names(db, {r.user_id for r in rows})
    out: dict[str, list[schemas.ReviewerOut]] = {c: [] for c in case_ids}
    for r in rows:
        out.setdefault(r.case_id, []).append(
            schemas.ReviewerOut(user_id=r.user_id, name=names.get(r.user_id)))
    return out


async def _reviewer_ids(db, review_id: str, case_id: str) -> set[str]:
    rows = (await db.execute(select(CaseReviewReviewer.user_id).where(
        CaseReviewReviewer.review_id == review_id,
        CaseReviewReviewer.case_id == case_id))).scalars().all()
    return set(rows)


async def _latest_active(db, review_id: str, case_id: str) -> dict[str, CaseReviewResult]:
    rows = (await db.execute(select(CaseReviewResult).where(
        CaseReviewResult.review_id == review_id,
        CaseReviewResult.case_id == case_id,
        CaseReviewResult.active.is_(True)).order_by(
        CaseReviewResult.created_at.desc(), CaseReviewResult.id.desc()))).scalars().all()
    out: dict[str, CaseReviewResult] = {}
    for r in rows:
        out.setdefault(r.user_id, r)
    return out


def _case_result(pass_rule: str, reviewers: set[str], latest: dict[str, CaseReviewResult]) -> str:
    """由每位评审人的最新 active 结论算用例当前结论。"""
    if pass_rule == "multiple":
        required = reviewers or set(latest)
        if any(r.action == "fail" for r in latest.values() if (not required or r.user_id in required)):
            return "fail"
        if required and all(latest.get(u) is not None and latest[u].action == "pass" for u in required):
            return "pass"
        return "pending"
    # single：最新一条非建议结论说了算（suggestion 不定结论）
    decisive = [r for u, r in latest.items()
                if (not reviewers or u in reviewers) and r.action in ("pass", "fail")]
    if not decisive:
        return "pending"
    decisive.sort(key=lambda r: (r.created_at, r.id), reverse=True)
    return decisive[0].action


async def _recompute_case(db, link: CaseReviewCase, pass_rule: str) -> None:
    reviewers = await _reviewer_ids(db, link.review_id, link.case_id)
    latest = await _latest_active(db, link.review_id, link.case_id)
    link.result = _case_result(pass_rule, reviewers, latest)
    if link.result in ("pass", "fail"):
        link.re_review = False


def _summary(started: bool, links: list[CaseReviewCase]) -> dict:
    total = len(links)
    passed = sum(1 for x in links if x.result == "pass")
    resolved = sum(1 for x in links if x.result in ("pass", "fail"))
    if not started:
        status = "not_started"
    elif total > 0 and resolved == total:
        status = "completed"
    else:
        status = "in_review"
    rate = round(passed * 100.0 / total, 2) if total else 0.0
    return {"status": status, "case_count": total, "pass_count": passed,
            "resolved_count": resolved, "pass_rate": rate}


async def _review_out(db, review: CaseReview) -> schemas.ReviewOut:
    links = (await db.execute(select(CaseReviewCase).where(
        CaseReviewCase.review_id == review.id))).scalars().all()
    s = _summary(review.started, list(links))
    reviewer_count = int((await db.execute(
        select(func.count(func.distinct(CaseReviewReviewer.user_id))).where(
            CaseReviewReviewer.review_id == review.id))).scalar_one())
    names = await _user_names(db, {review.created_by})
    return schemas.ReviewOut(
        id=review.id, num=review.num, project_id=review.project_id,
        module_id=review.module_id, name=review.name, description=review.description,
        pass_rule=review.pass_rule, start_at=schemas.iso(review.start_at),
        end_at=schemas.iso(review.end_at), started=review.started,
        status=s["status"], case_count=s["case_count"], pass_count=s["pass_count"],
        resolved_count=s["resolved_count"], pass_rate=s["pass_rate"],
        reviewer_count=reviewer_count, created_by=review.created_by,
        created_by_name=names.get(review.created_by or ""),
        created_at=schemas.iso(review.created_at), updated_at=schemas.iso(review.updated_at),
    )


# ══════════ 评审模块树 ══════════
def _build_tree(nodes: list[CaseReviewModule], counts: dict[str, int]) -> list[schemas.ReviewModuleNode]:
    by_id = {n.id: schemas.ReviewModuleNode(id=n.id, parent_id=n.parent_id, name=n.name,
                                            sort=n.sort, status=n.status,
                                            review_count=counts.get(n.id, 0)) for n in nodes}
    roots: list[schemas.ReviewModuleNode] = []
    for n in sorted(nodes, key=lambda x: (x.sort, x.name, x.id)):
        node = by_id[n.id]
        if n.parent_id and n.parent_id in by_id:
            by_id[n.parent_id].children.append(node)
        else:
            roots.append(node)
    return roots


@service(
    perm="review:module:read", effect="read", name="review_module_tree",
    description="评审模块树（含每个模块的评审数；回收站另列）",
    http={"method": "GET", "path": "/case-review-modules/tree", "tags": ["review"]},
)
async def review_module_tree(payload: schemas.ReviewModuleTreeIn, ctx) -> schemas.ReviewModuleTreeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:module:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(CaseReviewModule).where(
        CaseReviewModule.project_id == payload.project_id))).scalars().all()
    normal = [m for m in rows if m.status == STATUS_NORMAL]
    recycled = [m for m in rows if m.status == STATUS_RECYCLED]
    counts: dict[str, int] = {}
    if normal:
        cr = (await ctx.db.execute(select(CaseReview.module_id, func.count()).where(
            CaseReview.project_id == payload.project_id,
            CaseReview.module_id.is_not(None)).group_by(CaseReview.module_id))).all()
        counts = {mid: int(n) for mid, n in cr}
    return schemas.ReviewModuleTreeOut(
        tree=_build_tree(normal, counts),
        recycled=[schemas.ReviewModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                                           sort=m.sort, status=m.status) for m in recycled]
        if payload.include_recycled else [],
    )


async def _sibling_taken(db, project_id: str, parent_id: str | None, name: str,
                         exclude: str | None = None) -> bool:
    stmt = select(CaseReviewModule.id).where(
        CaseReviewModule.project_id == project_id, CaseReviewModule.name == name,
        CaseReviewModule.status == STATUS_NORMAL)
    stmt = stmt.where(CaseReviewModule.parent_id.is_(None)) if parent_id is None \
        else stmt.where(CaseReviewModule.parent_id == parent_id)
    if exclude:
        stmt = stmt.where(CaseReviewModule.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="review:module:create", effect="write", name="review_module_create",
    description="新建评审模块（同父重名 409）",
    http={"method": "POST", "path": "/case-review-modules", "tags": ["review"], "status": 201},
)
async def review_module_create(payload: schemas.ReviewModuleCreateIn,
                               ctx) -> schemas.ReviewModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:module:create")
    assert ctx.db is not None
    if payload.parent_id:
        await _module(ctx.db, payload.project_id, payload.parent_id)
    if await _sibling_taken(ctx.db, payload.project_id, payload.parent_id, payload.name):
        raise ApiError("conflict", "同一父模块下名称已存在", 409, {"name": payload.name})
    m = CaseReviewModule(project_id=payload.project_id, parent_id=payload.parent_id,
                         name=payload.name, sort=payload.sort)
    ctx.db.add(m)
    await ctx.db.commit()
    return schemas.ReviewModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                                    sort=m.sort, status=m.status)


async def _would_cycle(db, project_id: str, module_id: str, new_parent: str | None) -> bool:
    cur, guard = new_parent, 0
    while cur:
        if cur == module_id:
            return True
        row = (await db.execute(select(CaseReviewModule.parent_id).where(
            CaseReviewModule.id == cur, CaseReviewModule.project_id == project_id))).first()
        cur = row[0] if row else None
        guard += 1
        if guard > 10000:
            return True
    return False


@service(
    perm="review:module:update", effect="write", name="review_module_update",
    description="更新/移动评审模块（防环、同父重名 409）",
    http={"method": "PATCH", "path": "/case-review-modules/{module_id}", "tags": ["review"]},
)
async def review_module_update(payload: schemas.ReviewModuleUpdateIn,
                               ctx) -> schemas.ReviewModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:module:update")
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
        if await _sibling_taken(ctx.db, payload.project_id, parent_id, name, exclude=m.id):
            raise ApiError("conflict", "同一父模块下名称已存在", 409, {"name": name})
    m.name, m.parent_id = name, parent_id
    if payload.sort is not None:
        m.sort = payload.sort
    await ctx.db.commit()
    return schemas.ReviewModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                                    sort=m.sort, status=m.status)


@service(
    perm="review:module:delete", effect="destructive", name="review_module_delete",
    description="评审模块放入回收站（有子模块或评审 → 409）",
    http={"method": "POST", "path": "/case-review-modules/{module_id}/delete", "tags": ["review"]},
)
async def review_module_delete(payload: schemas.ReviewModuleGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:module:delete")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id)
    kids = int((await ctx.db.execute(select(func.count()).select_from(CaseReviewModule).where(
        CaseReviewModule.parent_id == m.id,
        CaseReviewModule.status == STATUS_NORMAL))).scalar_one())
    reviews = int((await ctx.db.execute(select(func.count()).select_from(CaseReview).where(
        CaseReview.module_id == m.id))).scalar_one())
    if kids or reviews:
        raise ApiError("module_not_empty",
                       "模块下还有 " + str(kids) + " 个子模块、" + str(reviews) + " 个评审，不能回收",
                       409, {"module_id": m.id, "children": kids, "reviews": reviews})
    m.status = STATUS_RECYCLED
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="review:module:update", effect="write", name="review_module_restore",
    description="从回收站恢复评审模块（父在回收站/同级重名 → 409）",
    http={"method": "POST", "path": "/case-review-modules/{module_id}/restore", "tags": ["review"]},
)
async def review_module_restore(payload: schemas.ReviewModuleGetIn,
                                ctx) -> schemas.ReviewModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:module:update")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id, include_recycled=True)
    if m.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "模块不在回收站", 404, {"module_id": m.id})
    if m.parent_id:
        parent = await _module(ctx.db, payload.project_id, m.parent_id, include_recycled=True)
        if parent.status == STATUS_RECYCLED:
            raise ApiError("parent_recycled", "父模块在回收站：先恢复父模块", 409, {"module_id": m.id})
    if await _sibling_taken(ctx.db, payload.project_id, m.parent_id, m.name, exclude=m.id):
        raise ApiError("conflict", "回收期间同级出现了同名模块：先处理它再恢复", 409, {"name": m.name})
    m.status = STATUS_NORMAL
    await ctx.db.commit()
    return schemas.ReviewModuleNode(id=m.id, parent_id=m.parent_id, name=m.name,
                                    sort=m.sort, status=m.status)


@service(
    perm="review:module:delete", effect="destructive", name="review_module_purge",
    description="彻底删除评审模块（必须已回收且无子模块/评审；逐字确认名称）",
    http={"method": "POST", "path": "/case-review-modules/{module_id}/purge", "tags": ["review"]},
    tool=False,
)
async def review_module_purge(payload: schemas.ReviewModulePurgeIn,
                              ctx) -> schemas.ReviewModulePurgeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:module:delete")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id, include_recycled=True)
    if m.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的模块", 409, {"module_id": m.id})
    if payload.confirm_name != m.name:
        raise ApiError("name_mismatch", "确认名称与模块名不一致，未删除", 409, {"module_id": m.id})
    kids = int((await ctx.db.execute(select(func.count()).select_from(CaseReviewModule).where(
        CaseReviewModule.parent_id == m.id))).scalar_one())
    reviews = int((await ctx.db.execute(select(func.count()).select_from(CaseReview).where(
        CaseReview.module_id == m.id))).scalar_one())
    if kids or reviews:
        raise ApiError("module_not_empty", "模块下仍有子模块或评审，不能彻底删除", 409,
                       {"module_id": m.id, "children": kids, "reviews": reviews})
    await ctx.db.delete(m)
    await ctx.db.commit()
    return schemas.ReviewModulePurgeOut(ok=True, purged_modules=1)


# ══════════ 评审本体 ══════════
@service(
    perm="review:review:read", effect="read", name="review_list",
    description="评审列表（模块/关键词/状态/我创建/我评审/我的待办；页码分页）",
    http={"method": "GET", "path": "/case-reviews", "tags": ["review"]},
)
async def review_list(payload: schemas.ReviewListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:read")
    assert ctx.db is not None
    stmt = select(CaseReview).where(CaseReview.project_id == payload.project_id)
    if payload.unfiled_only:
        stmt = stmt.where(CaseReview.module_id.is_(None))
    elif payload.module_id:
        stmt = stmt.where(CaseReview.module_id == payload.module_id)
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(CaseReview.name.like(kw) | CaseReview.description.like(kw))
    if payload.created_by_me:
        stmt = stmt.where(CaseReview.created_by == ctx.user_id)
    if payload.reviewing_me or payload.my_todo:
        mine = select(CaseReviewReviewer.review_id).where(
            CaseReviewReviewer.user_id == ctx.user_id).distinct()
        stmt = stmt.where(CaseReview.id.in_(mine))
        if payload.my_todo:
            # D227：谓词抽到 review/queries.py，与工作台「待我评审」共用一份实现。
            stmt = stmt.where(CaseReview.id.in_(my_todo_review_ids(ctx.user_id)))
    if payload.status:
        cc = select(func.count()).select_from(CaseReviewCase).where(
            CaseReviewCase.review_id == CaseReview.id).scalar_subquery()
        rc = select(func.count()).select_from(CaseReviewCase).where(
            CaseReviewCase.review_id == CaseReview.id,
            CaseReviewCase.result.in_(("pass", "fail"))).scalar_subquery()
        if payload.status == "not_started":
            stmt = stmt.where(CaseReview.started.is_(False))
        elif payload.status == "completed":
            stmt = stmt.where(CaseReview.started.is_(True), cc > 0, rc == cc)
        else:
            stmt = stmt.where(CaseReview.started.is_(True), (cc == 0) | (rc < cc))
    # D221：高级搜索条件组进同一个 WHERE（OR 组自带括号，吃不掉项目/模块/我相关谓词）。
    # 谓词写在 order_by 与 paginate_page 之前——total 与 items 吃同一份条件。
    stmt = stmt.where(CASE_REVIEW_LIST_FILTER.parse(payload.filter))
    stmt = stmt.order_by(CaseReview.created_at.desc(), CaseReview.id.desc())
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    rows = page.items
    if not rows:
        return Page(items=[], next_cursor=None, total=page.total)
    ids = [r.id for r in rows]
    links = (await ctx.db.execute(select(CaseReviewCase).where(
        CaseReviewCase.review_id.in_(ids)))).scalars().all()
    by_review: dict[str, list[CaseReviewCase]] = {i: [] for i in ids}
    for lnk in links:
        by_review.setdefault(lnk.review_id, []).append(lnk)
    rev_counts = dict((await ctx.db.execute(
        select(CaseReviewReviewer.review_id, func.count(func.distinct(CaseReviewReviewer.user_id)))
        .where(CaseReviewReviewer.review_id.in_(ids)).group_by(CaseReviewReviewer.review_id))).all())
    names = await _user_names(ctx.db, {r.created_by for r in rows})
    items = []
    for r in rows:
        s = _summary(r.started, by_review.get(r.id, []))
        items.append(schemas.ReviewOut(
            id=r.id, num=r.num, project_id=r.project_id, module_id=r.module_id, name=r.name,
            description=r.description, pass_rule=r.pass_rule, start_at=schemas.iso(r.start_at),
            end_at=schemas.iso(r.end_at), started=r.started, status=s["status"],
            case_count=s["case_count"], pass_count=s["pass_count"],
            resolved_count=s["resolved_count"], pass_rate=s["pass_rate"],
            reviewer_count=int(rev_counts.get(r.id, 0)), created_by=r.created_by,
            created_by_name=names.get(r.created_by or ""),
            created_at=schemas.iso(r.created_at), updated_at=schemas.iso(r.updated_at),
        ))
    return Page(items=items, next_cursor=None, total=page.total)


@service(
    perm="review:review:create", effect="write", name="review_create",
    description="新建评审（可带用例与评审人；评审人按用例笛卡尔分派；num 项目内唯一）",
    http={"method": "POST", "path": "/case-reviews", "tags": ["review"], "status": 201},
)
async def review_create(payload: schemas.ReviewCreateIn, ctx) -> schemas.ReviewOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:create")
    assert ctx.db is not None
    if payload.module_id:
        await _module(ctx.db, payload.project_id, payload.module_id)
    if payload.start_at and payload.end_at and payload.end_at < payload.start_at:
        raise ApiError("bad_time_range", "结束时间不能早于开始时间", 422, {})
    case_ids = await _validate_cases(ctx.db, payload.project_id, payload.case_ids)
    reviewer_ids = await _validate_users(ctx.db, payload.reviewer_ids)
    num = await _next_num(ctx, payload.project_id)
    r = CaseReview(project_id=payload.project_id, num=num, module_id=payload.module_id,
                   name=payload.name, description=payload.description,
                   pass_rule=payload.pass_rule, start_at=payload.start_at, end_at=payload.end_at,
                   started=False, created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(r)
    await ctx.db.flush()
    for i, cid in enumerate(case_ids):
        ctx.db.add(CaseReviewCase(project_id=payload.project_id, review_id=r.id, case_id=cid,
                                  sort=i, result="pending", re_review=False, created_by=ctx.user_id))
        for uid in reviewer_ids:
            ctx.db.add(CaseReviewReviewer(review_id=r.id, case_id=cid, user_id=uid,
                                          project_id=payload.project_id))
    await ctx.db.commit()
    return await _review_out(ctx.db, r)


@service(
    perm="review:review:read", effect="read", name="review_get",
    description="评审详情（头信息 + 读时聚合的状态/通过率）",
    http={"method": "GET", "path": "/case-reviews/{review_id}", "tags": ["review"]},
)
async def review_get(payload: schemas.ReviewGetIn, ctx) -> schemas.ReviewOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:read")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    return await _review_out(ctx.db, r)


@service(
    perm="review:review:update", effect="write", name="review_update",
    description="编辑评审（通过规则不可改；模块/时间窗/名称/描述）",
    http={"method": "PATCH", "path": "/case-reviews/{review_id}", "tags": ["review"]},
)
async def review_update(payload: schemas.ReviewUpdateIn, ctx) -> schemas.ReviewOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:update")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    if payload.pass_rule is not None and payload.pass_rule != r.pass_rule:
        raise ApiError("pass_rule_immutable", "通过规则创建后不可修改", 422,
                       {"pass_rule": r.pass_rule})
    if payload.name is not None:
        r.name = payload.name
    if payload.description is not None:
        r.description = payload.description
    if payload.module_set:
        if payload.module_id:
            await _module(ctx.db, payload.project_id, payload.module_id)
        r.module_id = payload.module_id
    if payload.start_at_set:
        r.start_at = payload.start_at
    if payload.end_at_set:
        r.end_at = payload.end_at
    if r.start_at and r.end_at and r.end_at < r.start_at:
        raise ApiError("bad_time_range", "结束时间不能早于开始时间", 422, {})
    r.updated_by = ctx.user_id
    await ctx.db.commit()
    return await _review_out(ctx.db, r)


@service(
    perm="review:review:delete", effect="destructive", name="review_delete",
    description="删除评审（硬删关联/评审人/结论；逐字确认名称）",
    http={"method": "POST", "path": "/case-reviews/{review_id}/delete", "tags": ["review"]},
    tool=False,
)
async def review_delete(payload: schemas.ReviewDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:delete")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    if payload.confirm_name != r.name:
        raise ApiError("name_mismatch", "确认名称与评审名不一致，未删除", 409, {"review_id": r.id})
    await ctx.db.execute(sa_delete(CaseReviewResult).where(CaseReviewResult.review_id == r.id))
    await ctx.db.execute(sa_delete(CaseReviewReviewer).where(CaseReviewReviewer.review_id == r.id))
    await ctx.db.execute(sa_delete(CaseReviewCase).where(CaseReviewCase.review_id == r.id))
    await ctx.db.delete(r)
    await ctx.db.commit()
    return OkOut(ok=True)


# ══════════ 评审内的用例 ══════════
async def _case_out(db, link: CaseReviewCase, names: dict[str, str],
                    reviewers: list[schemas.ReviewerOut]) -> schemas.ReviewCaseOut:
    return schemas.ReviewCaseOut(
        id=link.id, review_id=link.review_id, case_id=link.case_id,
        case_name=names.get(link.case_id), case_exists=link.case_id in names,
        result=link.result, re_review=link.re_review, reviewers=reviewers,
        updated_at=schemas.iso(link.updated_at),
    )


@service(
    perm="review:review:read", effect="read", name="review_case_list",
    description="评审内用例列表（结论/我待办/关键词筛选；页码分页）",
    http={"method": "GET", "path": "/case-reviews/{review_id}/cases", "tags": ["review"]},
)
async def review_case_list(payload: schemas.ReviewCaseListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:read")
    assert ctx.db is not None
    await _review(ctx.db, payload.project_id, payload.review_id)
    stmt = select(CaseReviewCase).where(
        CaseReviewCase.project_id == payload.project_id,
        CaseReviewCase.review_id == payload.review_id)
    if payload.result:
        stmt = stmt.where(CaseReviewCase.result == payload.result)
    if payload.reviewer_id:
        sub = select(CaseReviewReviewer.case_id).where(
            CaseReviewReviewer.review_id == payload.review_id,
            CaseReviewReviewer.user_id == payload.reviewer_id)
        stmt = stmt.where(CaseReviewCase.case_id.in_(sub))
    if payload.todo_only:
        sub = select(CaseReviewReviewer.case_id).where(
            CaseReviewReviewer.review_id == payload.review_id,
            CaseReviewReviewer.user_id == ctx.user_id)
        stmt = stmt.where(CaseReviewCase.result == "pending", CaseReviewCase.case_id.in_(sub))
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        sub = select(FUNCTIONAL_CASE.c.id).where(
            FUNCTIONAL_CASE.c.project_id == payload.project_id,
            FUNCTIONAL_CASE.c.name.like(kw))
        stmt = stmt.where(CaseReviewCase.case_id.in_(sub))
    stmt = stmt.order_by(CaseReviewCase.sort, CaseReviewCase.id)
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    links = page.items
    names = await _case_names(ctx.db, payload.project_id, {lnk.case_id for lnk in links})
    rmap = await _reviewers_map(ctx.db, payload.review_id, [lnk.case_id for lnk in links])
    items = [await _case_out(ctx.db, lnk, names, rmap.get(lnk.case_id, [])) for lnk in links]
    return Page(items=items, next_cursor=None, total=page.total)


@service(
    perm="review:review:update", effect="write", name="review_case_associate",
    description="把用例加入评审（重复跳过；评审人按用例分派，缺省沿用已有评审人）",
    http={"method": "POST", "path": "/case-reviews/{review_id}/cases", "tags": ["review"]},
)
async def review_case_associate(payload: schemas.ReviewCaseAssociateIn,
                                ctx) -> schemas.ReviewCaseAssociateOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:update")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    case_ids = await _validate_cases(ctx.db, payload.project_id, payload.case_ids)
    if payload.reviewer_ids is None:
        existing = (await ctx.db.execute(select(CaseReviewReviewer.user_id).where(
            CaseReviewReviewer.review_id == r.id).distinct())).scalars().all()
        reviewer_ids = list(existing)
    else:
        reviewer_ids = await _validate_users(ctx.db, payload.reviewer_ids)
    existing_links = set((await ctx.db.execute(select(CaseReviewCase.case_id).where(
        CaseReviewCase.review_id == r.id,
        CaseReviewCase.case_id.in_(case_ids)))).scalars().all())
    created = 0
    for i, cid in enumerate(case_ids):
        if cid in existing_links:
            continue
        ctx.db.add(CaseReviewCase(project_id=payload.project_id, review_id=r.id, case_id=cid,
                                  sort=i, result="pending", re_review=False, created_by=ctx.user_id))
        for uid in reviewer_ids:
            ctx.db.add(CaseReviewReviewer(review_id=r.id, case_id=cid, user_id=uid,
                                          project_id=payload.project_id))
        created += 1
    r.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.ReviewCaseAssociateOut(created=created,
                                          skipped=len(payload.case_ids) - created)


@service(
    perm="review:review:update", effect="write", name="review_case_disassociate",
    description="从评审移除一条用例（连同评审人与结论历史硬删）",
    http={"method": "POST", "path": "/case-reviews/{review_id}/cases/{case_id}/delete", "tags": ["review"]},
)
async def review_case_disassociate(payload: schemas.ReviewCaseDisassociateIn,
                                   ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:update")
    assert ctx.db is not None
    link = await _link(ctx.db, payload.project_id, payload.review_id, payload.case_id)
    await ctx.db.execute(sa_delete(CaseReviewResult).where(
        CaseReviewResult.review_id == payload.review_id,
        CaseReviewResult.case_id == payload.case_id))
    await ctx.db.execute(sa_delete(CaseReviewReviewer).where(
        CaseReviewReviewer.review_id == payload.review_id,
        CaseReviewReviewer.case_id == payload.case_id))
    await ctx.db.delete(link)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="review:review:update", effect="write", name="review_case_batch_disassociate",
    description="批量从评审移除用例",
    http={"method": "POST", "path": "/case-reviews/{review_id}/cases/batch-delete", "tags": ["review"]},
    tool=False,
)
async def review_case_batch_disassociate(payload: schemas.ReviewCaseBatchDisassociateIn,
                                         ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:update")
    assert ctx.db is not None
    await _review(ctx.db, payload.project_id, payload.review_id)
    for cid in dict.fromkeys(payload.case_ids):
        await ctx.db.execute(sa_delete(CaseReviewResult).where(
            CaseReviewResult.review_id == payload.review_id,
            CaseReviewResult.case_id == cid))
        await ctx.db.execute(sa_delete(CaseReviewReviewer).where(
            CaseReviewReviewer.review_id == payload.review_id,
            CaseReviewReviewer.case_id == cid))
        await ctx.db.execute(sa_delete(CaseReviewCase).where(
            CaseReviewCase.review_id == payload.review_id,
            CaseReviewCase.case_id == cid))
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="review:review:update", effect="write", name="review_case_reviewers",
    description="批量改评审人（replace/append），并重算受影响用例的当前结论",
    http={"method": "POST", "path": "/case-reviews/{review_id}/cases/reviewers", "tags": ["review"]},
)
async def review_case_reviewers(payload: schemas.ReviewCaseReviewersIn,
                                ctx) -> schemas.ReviewCaseReviewersOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:update")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    case_ids = await _validate_cases(ctx.db, payload.project_id, payload.case_ids)
    reviewer_ids = await _validate_users(ctx.db, payload.reviewer_ids)
    links = {lnk.case_id: lnk for lnk in (await ctx.db.execute(select(CaseReviewCase).where(
        CaseReviewCase.review_id == r.id,
        CaseReviewCase.case_id.in_(case_ids)))).scalars().all()}
    missing = [c for c in case_ids if c not in links]
    if missing:
        raise ApiError("not_found", "有用例不在该评审里", 404, {"missing": missing})
    for cid in case_ids:
        if payload.mode == "replace":
            await ctx.db.execute(sa_delete(CaseReviewReviewer).where(
                CaseReviewReviewer.review_id == r.id,
                CaseReviewReviewer.case_id == cid))
        existing = set((await ctx.db.execute(select(CaseReviewReviewer.user_id).where(
            CaseReviewReviewer.review_id == r.id,
            CaseReviewReviewer.case_id == cid))).scalars().all())
        for uid in reviewer_ids:
            if uid not in existing:
                ctx.db.add(CaseReviewReviewer(review_id=r.id, case_id=cid, user_id=uid,
                                              project_id=payload.project_id))
        await ctx.db.flush()
        await _recompute_case(ctx.db, links[cid], r.pass_rule)
    r.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.ReviewCaseReviewersOut(affected=len(case_ids))


@service(
    perm="review:result:create", effect="write", name="review_case_submit",
    description="提交评审结论（suggestion/pass/fail；fail 必须带意见；仅分派评审人或系统管理员）",
    http={"method": "POST", "path": "/case-reviews/{review_id}/cases/{case_id}/results", "tags": ["review"], "status": 201},
)
async def review_case_submit(payload: schemas.ReviewSubmitIn, ctx) -> schemas.ReviewCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:result:create")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    link = await _link(ctx.db, payload.project_id, payload.review_id, payload.case_id)
    if payload.action == "fail" and not (payload.comment or "").strip():
        raise ApiError("comment_required", "不通过必须填写评审意见", 422, {"case_id": payload.case_id})
    reviewers = await _reviewer_ids(ctx.db, r.id, payload.case_id)
    if reviewers and ctx.user_id not in reviewers and not ctx.is_system_admin:
        raise ApiError("forbidden", "只有分派评审人或系统管理员可以提交结论", 403,
                       {"case_id": payload.case_id})
    await _submit_one(ctx.db, r, link, ctx.user_id, payload.action, payload.comment)
    await ctx.db.commit()
    names = await _case_names(ctx.db, payload.project_id, {link.case_id})
    rmap = await _reviewers_map(ctx.db, r.id, [link.case_id])
    return await _case_out(ctx.db, link, names, rmap.get(link.case_id, []))


async def _submit_one(db, review: CaseReview, link: CaseReviewCase, user_id: str,
                      action: str, comment: str | None) -> None:
    await db.execute(sa_update(CaseReviewResult).where(
        CaseReviewResult.review_id == review.id,
        CaseReviewResult.case_id == link.case_id,
        CaseReviewResult.user_id == user_id,
        CaseReviewResult.active.is_(True),
    ).values(active=False))
    db.add(CaseReviewResult(project_id=review.project_id, review_id=review.id,
                            case_id=link.case_id, user_id=user_id, action=action,
                            comment=comment, active=True, created_at=datetime.now(UTC)))
    review.started = True
    await db.flush()
    await _recompute_case(db, link, review.pass_rule)


@service(
    perm="review:result:create", effect="write", name="review_case_batch_submit",
    description="批量提交评审结论（未分派给当前用户的用例跳过并回报）",
    http={"method": "POST", "path": "/case-reviews/{review_id}/batch-review", "tags": ["review"]},
    tool=False,
)
async def review_case_batch_submit(payload: schemas.ReviewBatchSubmitIn,
                                   ctx) -> schemas.ReviewBatchSubmitOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:result:create")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    if payload.action == "fail" and not (payload.comment or "").strip():
        raise ApiError("comment_required", "不通过必须填写评审意见", 422, {})
    links = {lnk.case_id: lnk for lnk in (await ctx.db.execute(select(CaseReviewCase).where(
        CaseReviewCase.review_id == r.id,
        CaseReviewCase.case_id.in_(payload.case_ids)))).scalars().all()}
    affected, skipped = 0, []
    for cid in dict.fromkeys(payload.case_ids):
        link = links.get(cid)
        if link is None:
            skipped.append(cid)
            continue
        reviewers = await _reviewer_ids(ctx.db, r.id, cid)
        if reviewers and ctx.user_id not in reviewers and not ctx.is_system_admin:
            skipped.append(cid)
            continue
        await _submit_one(ctx.db, r, link, ctx.user_id, payload.action, payload.comment)
        affected += 1
    await ctx.db.commit()
    return schemas.ReviewBatchSubmitOut(affected=affected, skipped=skipped)


@service(
    perm="review:review:update", effect="write", name="review_case_re_review",
    description="重新提审：作废该用例全部有效结论，关联行回到 pending + re_review",
    http={"method": "POST", "path": "/case-reviews/{review_id}/cases/{case_id}/re-review", "tags": ["review"]},
)
async def review_case_re_review(payload: schemas.ReviewCaseReReviewIn,
                                ctx) -> schemas.ReviewCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:update")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    link = await _link(ctx.db, payload.project_id, payload.review_id, payload.case_id)
    await _re_review_one(ctx.db, r, link)
    await ctx.db.commit()
    names = await _case_names(ctx.db, payload.project_id, {link.case_id})
    rmap = await _reviewers_map(ctx.db, r.id, [link.case_id])
    return await _case_out(ctx.db, link, names, rmap.get(link.case_id, []))


async def _re_review_one(db, review: CaseReview, link: CaseReviewCase) -> None:
    await db.execute(sa_update(CaseReviewResult).where(
        CaseReviewResult.review_id == review.id,
        CaseReviewResult.case_id == link.case_id,
        CaseReviewResult.active.is_(True),
    ).values(active=False))
    link.result = "pending"
    link.re_review = True
    review.started = True
    await db.flush()


@service(
    perm="review:review:update", effect="write", name="review_case_batch_re_review",
    description="批量重新提审",
    http={"method": "POST", "path": "/case-reviews/{review_id}/batch-re-review", "tags": ["review"]},
    tool=False,
)
async def review_case_batch_re_review(payload: schemas.ReviewCaseBatchReReviewIn,
                                      ctx) -> schemas.ReviewBatchSubmitOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:update")
    assert ctx.db is not None
    r = await _review(ctx.db, payload.project_id, payload.review_id)
    links = {lnk.case_id: lnk for lnk in (await ctx.db.execute(select(CaseReviewCase).where(
        CaseReviewCase.review_id == r.id,
        CaseReviewCase.case_id.in_(payload.case_ids)))).scalars().all()}
    affected, skipped = 0, []
    for cid in dict.fromkeys(payload.case_ids):
        link = links.get(cid)
        if link is None:
            skipped.append(cid)
            continue
        await _re_review_one(ctx.db, r, link)
        affected += 1
    await ctx.db.commit()
    return schemas.ReviewBatchSubmitOut(affected=affected, skipped=skipped)


@service(
    perm="review:review:read", effect="read", name="review_case_history",
    description="某条用例在该评审里的结论历史（含已作废的旧结论）",
    http={"method": "GET", "path": "/case-reviews/{review_id}/cases/{case_id}/results", "tags": ["review"]},
)
async def review_case_history(payload: schemas.ReviewCaseDisassociateIn,
                              ctx) -> schemas.ReviewResultHistoryOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:read")
    assert ctx.db is not None
    await _link(ctx.db, payload.project_id, payload.review_id, payload.case_id)
    rows = (await ctx.db.execute(select(CaseReviewResult).where(
        CaseReviewResult.review_id == payload.review_id,
        CaseReviewResult.case_id == payload.case_id).order_by(
        CaseReviewResult.created_at.desc(), CaseReviewResult.id.desc()))).scalars().all()
    names = await _user_names(ctx.db, {r.user_id for r in rows})
    return schemas.ReviewResultHistoryOut(items=[schemas.ReviewResultOut(
        id=r.id, user_id=r.user_id, user_name=names.get(r.user_id), action=r.action,
        comment=r.comment, active=r.active, created_at=schemas.iso(r.created_at)) for r in rows])


@service(
    perm="review:review:read", effect="read", name="review_case_reviews",
    description="用例视角反查它所在的评审（含各自当前结论）",
    http={"method": "GET", "path": "/functional-cases/{case_id}/reviews", "tags": ["review"]},
)
async def review_case_reviews(payload: schemas.ReviewCaseReviewsIn,
                              ctx) -> schemas.ReviewCaseReviewsOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("review:review:read")
    assert ctx.db is not None
    links = (await ctx.db.execute(select(CaseReviewCase).where(
        CaseReviewCase.project_id == payload.project_id,
        CaseReviewCase.case_id == payload.case_id))).scalars().all()
    if not links:
        return schemas.ReviewCaseReviewsOut(items=[])
    review_ids = [lnk.review_id for lnk in links]
    reviews = {r.id: r for r in (await ctx.db.execute(select(CaseReview).where(
        CaseReview.id.in_(review_ids)))).scalars().all()}
    all_links = (await ctx.db.execute(select(CaseReviewCase).where(
        CaseReviewCase.review_id.in_(review_ids)))).scalars().all()
    by_review: dict[str, list[CaseReviewCase]] = {i: [] for i in review_ids}
    for lnk in all_links:
        by_review.setdefault(lnk.review_id, []).append(lnk)
    items = []
    for lnk in links:
        r = reviews.get(lnk.review_id)
        if r is None:
            continue
        s = _summary(r.started, by_review.get(r.id, []))
        items.append(schemas.CaseReviewLinkOut(
            review_id=r.id, review_num=r.num, review_name=r.name, status=s["status"],
            result=lnk.result, re_review=lnk.re_review, case_count=s["case_count"],
            pass_rate=s["pass_rate"],
        ))
    return schemas.ReviewCaseReviewsOut(items=items)


@service(
    perm="review:review:update", effect="write", name="review_case_auto_re_review",
    description="内部服务：用例内容变化触发全部相关评审重新提审（项目开关 CASE_RE_REVIEW 打开时由用例域调用）",
    http=None, tool=False, dynamic_perm=True,
)
async def review_case_auto_re_review(payload: schemas.AutoReReviewIn,
                                     ctx) -> schemas.AutoReReviewOut:
    assert ctx.db is not None
    links = (await ctx.db.execute(select(CaseReviewCase).where(
        CaseReviewCase.project_id == payload.project_id,
        CaseReviewCase.case_id == payload.case_id))).scalars().all()
    review_ids = {lnk.review_id for lnk in links}
    for lnk in links:
        await _re_review_one(ctx.db, await _review(ctx.db, payload.project_id, lnk.review_id), lnk)
    _ = review_ids
    return schemas.AutoReReviewOut(affected=len(links))
