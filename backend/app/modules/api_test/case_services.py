"""接口用例 + 数据集 @service（T10）：继承/覆盖语义 + 首行变量 + 引用保护。"""
from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.errors import ApiError, Page, paginate
from app.core.service import ServiceResult, ensure_project_access, service, trigger_from_entry
from app.modules.api_test import schemas
from app.modules.api_test.models import ApiCase, ApiDefinition, DataSet
from app.modules.execution.services import save_run
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.visibility import assert_row_visible, visible_clause

if TYPE_CHECKING:  # 只给类型检查器看：运行期不需要，也别把 db 层拉进依赖图
    from sqlalchemy.ext.asyncio import AsyncSession

# 覆盖层可触及的请求键（§7.5：整键替换，不做深合并）
# 单一口径来自 schemas：合并、校验、取消覆盖三处必须看到同一份键名
OVERLAY_KEYS = schemas.OVERLAY_KEYS

# D223：数据集列表的可筛面（D47-a 三件套铺到数据集页）。白名单只收 `data_set` 上真实
# 存在的列：name / created_at / updated_at。刻意不进的四项：
# - `columns` / `rows` 是 JSON 表格内容，不是表格属性（按「第几列叫什么」筛没有语义）；
# - `row_count` 是出参里 len(rows) 现算的、不是列（SQL 里没有可比的对象）；
# - `used_by` / `scenario_held` 是列表时现算的引用计数与拦截标记，同样不是列；
# - `project_id` 是越权正门，由 ensure_project_access 管（filter_registry 模块 docstring）。
# 项目内唯一名（uq_dataset_project_name）让 name 的 EQUALS 恰好只中一行，IN 也才可枚举。
DATASET_LIST_FILTER = ListViewFilter(
    view_type="dataset",
    label="数据集",
    fields={
        "name": FieldDecl(DataSet.name, "text", "数据集名称", nullable=False),
        "created_at": FieldDecl(DataSet.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(DataSet.updated_at, "time", "更新时间", nullable=False),
    },
)
register(DATASET_LIST_FILTER)


def merge_request(defn: ApiDefinition, case: ApiCase | None) -> dict | None:
    """定义 request ← 用例覆盖层按键替换；断言 = 定义断言 + 用例断言（追加）。
    返回 None 表示不可执行（定义是草稿且用例未覆盖 url）。"""
    base = dict(defn.request) if defn.request else None
    if base is None:
        if case is None or not (case.request or {}).get("url"):
            return None
        base = {}
    if case is not None and case.request:
        for k, v in case.request.items():
            if k in OVERLAY_KEYS and v is not None:
                base[k] = v
    base.setdefault("method", defn.method)
    base.setdefault("url", defn.path)
    merged_assertions = list((defn.request or {}).get("assertions") or [])
    if case is not None and case.assertions:
        merged_assertions += list(case.assertions)
    if merged_assertions:
        base["assertions"] = merged_assertions
    return base


def _overlay_dump(o: schemas.CaseOverlay | None) -> dict | None:
    if o is None:
        return None
    d = o.model_dump(exclude_none=True)
    return d or None


async def _case(db, project_id: str, case_id: str) -> ApiCase:
    c = (await db.execute(select(ApiCase).where(ApiCase.id == case_id,
                                    ApiCase.project_id == project_id))).scalar_one_or_none()
    if c is None:
        raise ApiError("not_found", "用例不存在", 404, {"case_id": case_id})
    return c


async def _visible_case(db, ctx, project_id: str, case_id: str) -> ApiCase:
    c = await _case(db, project_id, case_id)
    assert_row_visible(c, ctx, what="用例不存在")
    await assert_def_alive(db, ctx, project_id, c.definition_id)
    return c


async def assert_def_alive(db, ctx, project_id: str, definition_id: str) -> None:
    """用例可达性跟着定义走：定义缺失/回收 → 同码 404（不泄露存在性）。"""
    d = (await db.execute(select(ApiDefinition).where(ApiDefinition.id == definition_id,
                              ApiDefinition.project_id == project_id))).scalar_one_or_none()
    if d is None or d.status == "recycled":
        raise ApiError("not_found", "接口定义不存在", 404, {"definition_id": definition_id})


async def _dataset(db, project_id: str, dataset_id: str) -> DataSet:
    d = (await db.execute(select(DataSet).where(DataSet.id == dataset_id,
                                        DataSet.project_id == project_id))).scalar_one_or_none()
    if d is None:
        raise ApiError("not_found", "数据集不存在", 404, {"dataset_id": dataset_id})
    return d


# —— 场景引用保护（1B Review Focus 9 勘误后的 ①②）——
# 为什么要拦：场景步骤的 ref 存的是 case_id 字符串，没有外键（全库无外键，级联显式编码），
# 所以删掉用例不会报错，只会在画布上留个红点、在跑第 6 步时才炸。删除侧是唯一能把这件事
# 说清楚的时机（§6.5「删除被场景引用的用例 → 警告并列出引用」）。

async def _scenario_refs(ctx, project_id: str, case_ids: list[str]) -> dict[str, dict]:
    """跨模块问「这些用例被哪些未回收场景引用」：只经注册表调 scenario_case_refs（契约 1）。

    未注册时按「零引用」放行是不可接受的：那等于注册顺序悄悄决定删除保护生不生效。
    这里宁可 500 让装配问题当场暴露（与 handlers._resolve_case 同一口径）。
    """
    from app.core.registry import REGISTRY

    ids = [c for c in dict.fromkeys(case_ids) if c]
    if not ids:
        return {}
    spec = REGISTRY.get("scenario_case_refs")
    if spec is None:
        raise ApiError("internal_error", "scenario_case_refs 未注册（服务尚未初始化完成）", 500)
    out = await spec.handler(spec.model.model_validate(
        {"project_id": project_id, "case_ids": ids}), ctx)
    data = out.model_dump()
    # details_hidden 是整次查询的口径（一次调用只有一个调用方），逐组冗余没意义；
    # 这里摊平到每组，_blocked 才不必再关心它是批量还是一条
    return {g["ref_id"]: {"count": g["count"], "scenarios": g["items"],
                          "hidden": bool(data["details_hidden"]) and g["count"] > 0}
            for g in data["groups"]}


def _blocked(ref: dict, *, action: str, case_id: str) -> ApiError:
    """把「被场景引用」拼成给用户看的 409：点名引用者与命中步骤，他才有的可解。"""
    details: dict = {"case_id": case_id, "count": ref["count"], "scenarios": ref["scenarios"]}
    if ref["hidden"]:
        # 数量照报、明细隐瞒：查不到是谁必须说出口，退化成「没人引用」会骗人按下删除键
        return ApiError("referenced_by_scenario",
                        "该用例被 " + str(ref["count"]) + " 个未回收场景引用，不能" + action
                        + "；引用明细需要 scenario:read 权限，请联系有该权限的成员在场景里先解绑",
                        409, {**details, "reason": "missing_scenario_read"})
    names = "、".join("「" + s["scenario_name"] + "」步骤 " + "、".join(s["step_keys"])
                      for s in ref["scenarios"][:5])
    more = " 等 " + str(ref["count"]) + " 个场景" if ref["count"] > 5 else ""
    head = "该用例被 " + str(ref["count"]) + " 个未回收场景引用：" + names + more
    # 软删可回退 → 给 force 出口；硬删不可回退 → 只有一条路：先去场景里解绑
    tail = ("；先在场景里改引用，或确认要连带断掉这些步骤后带 force=true 重试" if action == "回收"
            else "；彻底删除不可回退，请先在场景里改引用（回收站里的用例也一样：回收 ≠ 解绑）")
    return ApiError("referenced_by_scenario", head + tail, 409, details)




async def _case_out(db, c: ApiCase, produced: bool = False) -> schemas.CaseOut:
    defn = await db.get(ApiDefinition, c.definition_id)
    eff = merge_request(defn, c) if defn is not None else None
    return schemas.CaseOut(
        id=c.id, project_id=c.project_id, definition_id=c.definition_id, name=c.name,
        priority=c.priority, request=c.request, assertions=list(c.assertions or []),
        dataset_id=c.dataset_id, sort=c.sort, owner_id=c.owner_id,
        project_public=c.project_public, status=c.status, effective_request=eff,
        produced=([schemas.ProducedRef(kind="api_case", id=c.id, name=c.name,
                                       link="/api/case/" + c.id)] if produced else []))


@service(
    perm="api:case:create", effect="write", name="api_case_create",
    description="在接口定义下创建用例（request 为按键覆盖层，缺省=完全继承定义；assertions 追加在定义断言后；可绑数据集）",
    http={"method": "POST", "path": "/api-cases", "tags": ["api_test"], "status": 201},
)
async def api_case_create(payload: schemas.CaseCreateIn, ctx) -> schemas.CaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:create")
    assert ctx.db is not None
    defn = (await ctx.db.execute(select(ApiDefinition).where(
        ApiDefinition.id == payload.definition_id,
        ApiDefinition.project_id == payload.project_id))).scalar_one_or_none()
    if defn is None:
        raise ApiError("not_found", "接口定义不存在", 404, {"definition_id": payload.definition_id})
    assert_row_visible(defn, ctx, what="接口定义不存在")
    if defn.status == "recycled":
        raise ApiError("not_found", "接口定义不存在（在回收站）", 404, {"definition_id": payload.definition_id})
    if payload.dataset_id:
        await _dataset(ctx.db, payload.project_id, payload.dataset_id)
    c = ApiCase(project_id=payload.project_id, definition_id=payload.definition_id,
                  name=payload.name, priority=payload.priority,
                  request=_overlay_dump(payload.request),
                  assertions=[a.model_dump(exclude_none=True) for a in payload.assertions],
                  dataset_id=payload.dataset_id, sort=payload.sort,
                  owner_id=ctx.user_id, project_public=payload.project_public)
    if merge_request(defn, c) is None:
        raise ApiError("validation_failed",
                         "定义未填请求对象且用例未覆盖 url，无法执行；请先补全定义或用例覆盖 url", 422)
    ctx.db.add(c)
    await ctx.db.commit()
    return await _case_out(ctx.db, c, produced=True)


@service(
    perm="api:case:read", effect="read", name="api_case_list",
    description="列出接口用例（默认不含回收站；recycled=true 只看已回收）",
    http={"method": "GET", "path": "/api-cases", "tags": ["api_test"]},
)
async def api_case_list(payload: schemas.CaseListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:read")
    assert ctx.db is not None
    stmt = select(ApiCase).where(ApiCase.project_id == payload.project_id,
                                   visible_clause(ApiCase, ctx),
                                   ApiCase.status == ("recycled" if payload.recycled else "normal"))
    if payload.definition_id:
        await assert_def_alive(ctx.db, ctx, payload.project_id, payload.definition_id)
        stmt = stmt.where(ApiCase.definition_id == payload.definition_id)
    stmt = stmt.order_by(ApiCase.sort, ApiCase.id)
    page = await paginate(ctx.db, stmt, cursor_col=ApiCase.id, row_key=lambda r: r.id,
                          cursor=payload.cursor, size=payload.size)
    items = [await _case_out(ctx.db, c) for c in page.items]
    return Page(items=items, next_cursor=page.next_cursor)


@service(
    perm="api:case:read", effect="read", name="api_case_get",
    description="获取用例详情（含 effective_request 合并结果）",
    http={"method": "GET", "path": "/api-cases/{case_id}", "tags": ["api_test"]},
)
async def api_case_get(payload: schemas.CaseGetIn, ctx) -> schemas.CaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:read")
    assert ctx.db is not None
    c = await _visible_case(ctx.db, ctx, payload.project_id, payload.case_id)
    return await _case_out(ctx.db, c)


@service(
    perm="api:case:run", effect="write", name="api_case_run",
    description="执行接口用例：真实发送一次请求并落 run（trigger 按入口记 manual/schedule；"
                "与调试共用 _execute_case 执行链；计划执行经此投递接口用例——D228）",
    http={"method": "POST", "path": "/api-cases/{case_id}/run", "tags": ["api_test"]},
)
async def api_case_run(payload: schemas.ApiCaseRunIn, ctx) -> schemas.ApiCaseRunOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:run")
    assert ctx.db is not None
    from app.modules.api_test.services import _execute_case

    result, req, env_name, case_name = await _execute_case(
        ctx, payload.project_id, payload.case_id, payload.env_id)
    rec = await save_run(
        ctx.db, project_id=payload.project_id, subject_type="api_case",
        subject_id=payload.case_id, subject_name=case_name,
        env_id=payload.env_id, env_name=env_name,
        # 事实口径：UI 手动 = manual、定时计划 = schedule、Agent = agent；调试另有其入口。
        trigger=trigger_from_entry(ctx.entry),
        result=result, request_snapshot=req, created_by=ctx.user_id)
    await ctx.db.commit()
    return schemas.ApiCaseRunOut(run_id=rec.id, ok=result.ok,
                                 passed=result.passed(), status=result.status)


@service(
    perm="api:case:update", effect="write", name="api_case_update",
    description="更新用例（request 覆盖层按键合并进已存覆盖；assertions 整体替换；dataset_set=true 才动数据集，可解绑传 null）",
    http={"method": "PATCH", "path": "/api-cases/{case_id}", "tags": ["api_test"]},
)
async def api_case_update(payload: schemas.CaseUpdateIn, ctx) -> schemas.CaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:update")
    assert ctx.db is not None
    c = await _visible_case(ctx.db, ctx, payload.project_id, payload.case_id)
    if payload.name is not None:
        c.name = payload.name
    if payload.priority is not None:
        c.priority = payload.priority
    if payload.request is not None:
        new_ov = _overlay_dump(payload.request) or {}
        merged = dict(c.request or {})
        merged.update(new_ov)  # 按键替换（与调试期同一语义）
        c.request = merged or None
    if payload.request_unset:
        # 同一请求里同时提交的键以 request 为准：只有本次没给的键才会被抹掉
        left = dict(c.request or {})
        for k in payload.request_unset:
            left.pop(k, None)
        c.request = left or None
    if payload.assertions is not None:
        c.assertions = [a.model_dump(exclude_none=True) for a in payload.assertions]
    if payload.dataset_set:
        if payload.dataset_id:
            await _dataset(ctx.db, payload.project_id, payload.dataset_id)
        c.dataset_id = payload.dataset_id
    if payload.sort is not None:
        c.sort = payload.sort
    if payload.project_public is not None:
        c.project_public = payload.project_public
    await ctx.db.commit()
    return await _case_out(ctx.db, c, produced=True)


@service(
    perm="api:case:delete", effect="destructive", name="api_case_delete",
    description="把用例放入回收站（软删；已回收再删 404；被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force）",
    http={"method": "POST", "path": "/api-cases/{case_id}/delete", "tags": ["api_test"]},
    resident=False,
)
async def api_case_delete(payload: schemas.CaseDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:delete")
    assert ctx.db is not None
    c = await _visible_case(ctx.db, ctx, payload.project_id, payload.case_id)
    if c.status != "normal":
        raise ApiError("not_found", "用例不存在", 404, {"case_id": c.id})
    # 先查引用再改状态：409 必须是一条什么都没改的失败（否则重试看到的就是「已回收」）
    ref = (await _scenario_refs(ctx, payload.project_id, [c.id])).get(c.id)
    # force 只放行「已经看见引用清单」的人：明细被隐瞒时 force 同样拦下——
    # 他不知道该断的是谁的步骤，一键下去坏的是别人的场景。
    if ref and (not payload.force or ref["hidden"]):
        raise _blocked(ref, action="回收", case_id=c.id)
    c.status = "recycled"

    await ctx.db.commit()
    return schemas.OkOut(ok=True)



@service(
    perm="api:case:update",
    effect="write",
    name="api_case_restore",
    description="从回收站恢复用例",
    http={"method": "POST", "path": "/api-cases/{case_id}/restore", "tags": ["api_test"]},
    resident=False,
)
async def api_case_restore(payload: schemas.CaseGetIn, ctx) -> BaseModel:
    """回收站要有出路：§4.4 的软删对接口、模块、用例一视同仁。

    可达性仍跟着定义走（_visible_case 里那道 assert_def_alive）：
    接口还在回收站时，单独把它的用例捞出来没有意义，列表里也看不见。

    恢复期校验数据集（R82 裁定）：回收期间数据集可以被删（无场景扣押的回收用例不拦
    删除——purge 出口语义），恢复就是「绑着不存在的数据集」重新变得可执行的唯一时刻。
    在这里响亮 409 并点名缺失数据集，胜过放它回列表里装健康、执行期才 resolve 404。
    不静默清绑：dataset_id 悄悄变 null 是降级，用户以为还绑着（§13 纪律 1）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:update")
    assert ctx.db is not None
    c = await _visible_case(ctx.db, ctx, payload.project_id, payload.case_id)
    if c.status != "recycled":
        raise ApiError("not_found", "用例不在回收站", 404, {"case_id": c.id})
    if c.dataset_id:
        ds = (await ctx.db.execute(select(DataSet).where(
            DataSet.id == c.dataset_id,
            DataSet.project_id == payload.project_id))).scalar_one_or_none()
        if ds is None:
            raise ApiError("dataset_missing",
                           "用例绑定的数据集已不存在（id=" + c.dataset_id +
                           "），恢复后无法执行；请先编辑用例解绑数据集再恢复", 409,
                           {"case_id": c.id, "dataset_id": c.dataset_id})
    c.status = "normal"
    await ctx.db.commit()
    return await _case_out(ctx.db, c)


@service(
    perm="api:case:delete",
    effect="destructive",
    name="api_case_purge",
    description="彻底删除回收站中的用例（物理删除，不可恢复）",
    http={"method": "POST", "path": "/api-cases/{case_id}/purge", "tags": ["api_test"]},
    tool=False,
    resident=False,
)
async def api_case_purge(payload: schemas.CasePurgeIn, ctx) -> BaseModel:
    """只有回收站里的用例能走到这里，且必须逐字确认名称（与接口/模块同一套规矩）。"""
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:delete")
    assert ctx.db is not None
    c = await _visible_case(ctx.db, ctx, payload.project_id, payload.case_id)
    if c.status != "recycled":
        raise ApiError("not_recycled", "只能彻底删除回收站里的用例：请先放入回收站", 409,
                       {"case_id": c.id})
    if payload.confirm_name != c.name:
        raise ApiError("name_mismatch", "确认名称与用例名不一致，未删除", 409,
                       {"case_id": c.id})
    # 回收 ≠ 解绑：场景步骤的 ref 还指着它，物理删掉就是让那一步永久悬空（无 force 出口，
    # 因为硬删不可回退——误删的场景步骤没法靠「恢复用例」补回来，用例行已经不在了）
    ref = (await _scenario_refs(ctx, payload.project_id, [c.id])).get(c.id)
    if ref:
        raise _blocked(ref, action="彻底删除", case_id=c.id)
    await ctx.db.delete(c)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)



def _validate_table(columns: list[str], rows: list[list[str]]) -> None:
    if not columns:
        raise ApiError("validation_failed", "数据集至少要有一列", 422)
    if any(not str(c).strip() for c in columns):
        raise ApiError("validation_failed", "列名不能为空", 422)
    if len({str(c) for c in columns}) != len(columns):
        raise ApiError("validation_failed", "列名不能重复", 422)
    for i, row in enumerate(rows):
        if len(row) != len(columns):
            raise ApiError("validation_failed",
                             "第 " + str(i + 1) + " 行有 " + str(len(row)) + " 个值，应为 " + str(len(columns)) + " 个",
                             422, {"row": i, "got": len(row), "want": len(columns)})


async def _used_by(db: AsyncSession, dataset_ids: list[str]) -> dict[str, int]:
    """一次 GROUP BY 数完引用：逐条 COUNT 会让数据集列表变成 N+1。"""
    if not dataset_ids:
        return {}
    rows = (await db.execute(
        select(ApiCase.dataset_id, func.count())
        .where(ApiCase.dataset_id.in_(dataset_ids), ApiCase.status == "normal")
        .group_by(ApiCase.dataset_id))).all()
    return {str(k): int(n) for k, n in rows}


async def _bound_case_ids(db: AsyncSession, dataset_id: str, *, status: str | None = "normal") -> list[str]:
    """绑定这个数据集的用例 id；status=None = 不分状态（含回收站）。

    默认口径与 _used_by 一致（未回收），第二道拦截要的是「含回收站」那一档。
    """
    stmt = select(ApiCase.id).where(ApiCase.dataset_id == dataset_id)
    if status is not None:
        stmt = stmt.where(ApiCase.status == status)
    return list((await db.execute(stmt)).scalars().all())


async def _bound_case_map(db: AsyncSession, dataset_ids: list[str]) -> dict[str, list[str]]:
    """{dataset_id: [绑定它的用例 id（不分状态）]}；一趟取完，别让列表变 N+1。"""
    if not dataset_ids:
        return {}
    rows = (await db.execute(
        select(ApiCase.dataset_id, ApiCase.id).where(ApiCase.dataset_id.in_(dataset_ids))
    )).all()
    out: dict[str, list[str]] = {str(d): [] for d in dataset_ids}
    for ds_id, case_id in rows:
        out.setdefault(str(ds_id), []).append(str(case_id))
    return out


async def _scenario_held_datasets(ctx, project_id: str, dataset_ids: list[str]) -> set[str]:
    """哪些数据集被场景「扣住」了：绑定它的用例（含回收站里的）正被未回收场景引用。

    删除拦截与列表徽标**必须**共用这一句判断，否则就又回到「徽标说 0、删除 409」。
    只看布尔，不碰场景名——所以无 scenario:read 的人也拿不到明细，却照样被拦住
    （拦不拦由数据决定，不由查看权限决定，与 _blocked 同一口径）。

    成本：一趟绑定关系查询 + 一趟项目内未回收场景扫描（**每次请求一次，不是每行一次**，
    与 scenario_references 同一量级）。数据集列表是翻页友好的，但项目场景多到扫描明显
    吃紧时，该加的是引用表，不是把这里改回「不查」。
    """
    bound = await _bound_case_map(ctx.db, dataset_ids)
    all_ids = [c for ids in bound.values() for c in ids]
    if not all_ids:
        return set()
    refs = await _scenario_refs(ctx, project_id, all_ids)
    held_cases = {cid for cid, r in refs.items() if r["count"]}
    return {ds for ds, ids in bound.items() if any(c in held_cases for c in ids)}



def _ds_out(d: DataSet, produced: bool = False, used_by: int = 0,
            scenario_held: bool = False) -> schemas.DatasetOut:
    return schemas.DatasetOut(id=d.id, project_id=d.project_id, name=d.name,
                               columns=list(d.columns), rows=[list(r) for r in d.rows],
                               row_count=len(d.rows), used_by=used_by,
                               scenario_held=scenario_held,
                               produced=([schemas.ProducedRef(kind="data_set", id=d.id,
                                                              name=d.name,
                                                              link="/datasets")]
                                          if produced else []))


async def _ds(db, project_id: str, dataset_id: str) -> DataSet:
    d = (await db.execute(select(DataSet).where(DataSet.id == dataset_id,
                                          DataSet.project_id == project_id))).scalar_one_or_none()
    if d is None:
        raise ApiError("not_found", "数据集不存在", 404, {"dataset_id": dataset_id})
    return d


@service(
    perm="api:dataset:read", effect="read", name="data_set_list",
    description="列出项目数据集（含列头与全量行数据）",
    http={"method": "GET", "path": "/datasets", "tags": ["api_test"]},
)
async def data_set_list(payload: schemas.DatasetListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:dataset:read")
    assert ctx.db is not None
    stmt = select(DataSet).where(DataSet.project_id == payload.project_id)
    # D223：高级搜索条件组进同一个 WHERE，位置在 order_by / paginate 之前——白名单外
    # 400 带本页清单（ListViewFilter.parse 的文案）；游标续页仍吃同一份条件。
    stmt = stmt.where(DATASET_LIST_FILTER.parse(payload.filter))
    stmt = stmt.order_by(DataSet.id)
    page = await paginate(ctx.db, stmt, cursor_col=DataSet.id, row_key=lambda r: r.id,
                          cursor=payload.cursor, size=payload.size)
    used = await _used_by(ctx.db, [d.id for d in page.items])
    ids = [d.id for d in page.items]
    held = await _scenario_held_datasets(ctx, payload.project_id, ids)
    return Page(items=[_ds_out(d, used_by=used.get(d.id, 0), scenario_held=d.id in held)
                       for d in page.items],
                next_cursor=page.next_cursor)


@service(
    perm="api:dataset:create", effect="write", name="data_set_create",
    description="创建数据集（columns 列头 + rows 二维数组；每行长度必须等于列数；name 项目内唯一）",
    http={"method": "POST", "path": "/datasets", "tags": ["api_test"], "status": 201},
)
async def data_set_create(payload: schemas.DatasetCreateIn, ctx) -> schemas.DatasetOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:dataset:create")
    assert ctx.db is not None
    _validate_table(payload.columns, payload.rows)
    dup = (await ctx.db.execute(select(DataSet).where(DataSet.project_id == payload.project_id,
                                                 DataSet.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "数据集名已存在", 409, {"name": payload.name})
    d = DataSet(project_id=payload.project_id, name=payload.name,
                  columns=list(payload.columns), rows=[list(r) for r in payload.rows])
    ctx.db.add(d)
    await ctx.db.commit()
    return _ds_out(d, produced=True)


@service(
    perm="api:dataset:update", effect="write", name="data_set_update",
    description="整表覆盖数据集（columns/rows 全量替换——表格编辑器保存即调它）",
    http={"method": "PATCH", "path": "/datasets/{dataset_id}", "tags": ["api_test"]},
)
async def data_set_update(payload: schemas.DatasetUpdateIn, ctx) -> schemas.DatasetOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:dataset:update")
    assert ctx.db is not None
    d = await _ds(ctx.db, payload.project_id, payload.dataset_id)
    new_cols = list(payload.columns) if payload.columns is not None else list(d.columns)
    new_rows = [list(r) for r in payload.rows] if payload.rows is not None else [list(r) for r in d.rows]
    _validate_table(new_cols, new_rows)
    if payload.name is not None and payload.name != d.name:
        dup = (await ctx.db.execute(select(DataSet).where(DataSet.project_id == payload.project_id,
                                                 DataSet.name == payload.name))).scalar_one_or_none()
        if dup is not None:
            raise ApiError("conflict", "数据集名已存在", 409, {"name": payload.name})
        d.name = payload.name
    d.columns = new_cols
    d.rows = new_rows
    await ctx.db.commit()
    return _ds_out(d)


@service(
    perm="api:dataset:delete", effect="destructive", name="data_set_delete",
    description="删除数据集（被未回收用例引用时 409，先解绑或回收用例；用例即使已回收，只要它还被未回收场景引用也 409）",
    http={"method": "POST", "path": "/datasets/{dataset_id}/delete", "tags": ["api_test"]},
    resident=False,
)
async def data_set_delete(payload: schemas.DatasetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:dataset:delete")
    assert ctx.db is not None
    d = await _ds(ctx.db, payload.project_id, payload.dataset_id)
    # 与列表徽标共用 _scenario_held_datasets 的判据：两处口径必须一致，
    # 否则徽标说 0 引用、删除却 409（RF9 点名的正是这个）。
    n = (await _used_by(ctx.db, [d.id])).get(d.id, 0)
    if n:
        # used_by 只数未回收用例，光说「被 N 条用例引用」是半个答案：那些用例可能还被
        # 场景引用着，用户照着提示去回收会一头撞上另一道 409。能看见就一并说清。
        extra = ""
        bound = await _bound_case_ids(ctx.db, d.id)
        refs = await _scenario_refs(ctx, payload.project_id, bound)
        held = sum(1 for r in refs.values() if r["count"])
        if held:
            extra = "；且其中 " + str(held) + " 条用例被未回收场景引用，需先在场景里改引用"
        raise ApiError("conflict", "数据集被 " + str(n) + " 条用例引用，不能删除；先在用例里解绑或回收这些用例"
                       + extra, 409, {"referenced_by": n, "scenario_held": bool(held)})
    # 第二道：used_by 数不到回收站里的用例，但那些用例的 dataset_id 还指着这里。
    # 放过它 = 数据集被硬删而用例只是「暂时看不见」；用例一旦恢复，执行时 resolve
    # 会 404「数据集不存在」（resolve 里那条注释写的「外力破坏」正是这个来源）。
    refs = await _scenario_refs(ctx, payload.project_id,
                                await _bound_case_ids(ctx.db, d.id, status="recycled"))
    hit = next((r for r in refs.values() if r["count"]), None)
    if hit is not None:
        raise _blocked_dataset(hit, dataset_id=d.id)
    await ctx.db.delete(d)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


def _blocked_dataset(ref: dict, *, dataset_id: str) -> ApiError:
    """数据集被「回收站里但还被场景引用的用例」绑定：措辞要点明这层间接关系。"""
    details = {"dataset_id": dataset_id, "count": ref["count"], "scenarios": ref["scenarios"]}
    if ref["hidden"]:
        return ApiError("referenced_by_scenario",
                        "绑定该数据集的回收站用例被 " + str(ref["count"])
                        + " 个未回收场景引用，不能删除数据集；引用明细需要 scenario:read 权限",
                        409, {**details, "reason": "missing_scenario_read"})
    names = "、".join("「" + s["scenario_name"] + "」" for s in ref["scenarios"][:5])
    # 括号里最多点名 5 个，count 却是全量：不补这句尾巴，7 个场景只列 5 个名字会让用户
    # 以为名单就是全部（照单去解绑，还剩 2 个撞第二道 409）。尾巴口径同 :123 的 _blocked。
    more = " 等 " + str(ref["count"]) + " 个场景" if ref["count"] > 5 else ""
    return ApiError("referenced_by_scenario",
                    "绑定该数据集的回收站用例仍被 " + str(ref["count"]) + " 个未回收场景引用（"
                    + names + more + "）：删掉数据集后那些用例一旦被恢复就跑不动了。"
                    "请先彻底删除这些用例，或在场景里改掉引用", 409, details)



# —— 执行引擎出口（1B T3 + R44）：与 api_case_get 共用 merge_request，
# 因此「界面看到的有效请求」与「引擎执行的有效请求」不可能分叉。
# 不复用 api_debug 的理由有两条，都是硬伤：它会自己 save_run（一次场景执行落两条
# run_record，报告统计直接失真），且只取数据集首行（§8.6 要全行展开）。


@service(
    perm="api:case:read", effect="read", name="api_case_resolve",
    description="解析用例的有效请求（定义←覆盖合并 + 定义与用例断言 + 全量数据集行）；供场景执行引擎内部调用",
    http=None, tool=False, resident=False,
)
async def api_case_resolve(payload: schemas.CaseResolveIn, ctx) -> schemas.CaseResolveOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:case:read")
    assert ctx.db is not None
    # _visible_case 已经查过定义存在且未回收；这里再取一次只为拿到 ORM 对象
    # （identity map 命中，不产生第二次 SELECT）
    cs = await _visible_case(ctx.db, ctx, payload.project_id, payload.case_id)
    if cs.status != "normal":
        raise ApiError("not_found", "用例不存在", 404, {"case_id": cs.id})
    defn = await ctx.db.get(ApiDefinition, cs.definition_id)
    if defn is None or defn.status == "recycled":
        raise ApiError("not_found", "用例所属接口不存在", 404, {"case_id": cs.id})
    req = merge_request(defn, cs)
    if req is None:
        # 草稿定义且用例未覆盖 url：可执行性交给引擎判定（见 CaseResolveOut 文档串）
        return schemas.CaseResolveOut(
            case_id=cs.id, case_name=cs.name, definition_id=defn.id, definition_name=defn.name,
            priority=cs.priority, executable=False,
            reason="接口定义为草稿且用例未覆盖 url，无法确定请求地址")
    assertions = list(req.get("assertions") or [])
    ds_out = None
    if cs.dataset_id:
        ds = await ctx.db.get(DataSet, cs.dataset_id)
        if ds is None:
            # 数据集是硬删的，删除侧有引用保护，走到这里说明数据被外力破坏 ——
            # 诚实报错让引擎把步骤标 error，不静默降级成「没有数据就跑一行」
            raise ApiError("not_found", "用例引用的数据集不存在", 404, {"dataset_id": cs.dataset_id})
        ds_out = {"id": ds.id, "columns": list(ds.columns or []),
                  "rows": [list(r) for r in (ds.rows or [])]}
    return schemas.CaseResolveOut(
        case_id=cs.id, case_name=cs.name, definition_id=defn.id, definition_name=defn.name,
        priority=cs.priority, request=req, assertions=assertions, dataset=ds_out,
        # 与 api_debug 同口径：合并结果里带 timeout_ms 就算用户显式设过，
        # 环境超时不得悄悄覆盖它（否则「环境配了 3s」会让所有用例跟着超时）
        timeout_explicit="timeout_ms" in req,
    )
