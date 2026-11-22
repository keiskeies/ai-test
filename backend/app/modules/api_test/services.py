"""api_definition @service 四件套（金线全形：HTTP+工具+权限+审计）。"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.sql import column, table

from app.core.errors import ApiError, Page, paginate, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.api_test import schemas
from app.modules.api_test.models import ApiCase, ApiDefinition, DataSet
from app.modules.execution.core import run_api
from app.modules.execution.services import save_run
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.filters import _like
from app.shared.vars import MissingVar, merge_vars
from app.shared.visibility import assert_row_visible, visible_clause

# D47-a §11.5.1 高级搜索：本页可筛字段的白名单。登记在 shared.filter_registry，
# 于是 filter_meta 与前端表单都从同一份里取，页面模块不必被 search 反向 import。
# 每个字段都是 api_definition 上真实存在的一列——**没列的列就是筛不了**（不在白名单
# → 400 带清单），比默默忽略一条条件诚实得多。
# 刻意不可筛的两项，都写在 filter_registry 模块 docstring 里：project_id（越权正门，
# 由 ensure_project_access + visible_clause 管）与 recycled（回收站是页面开关，不是属性）。
API_LIST_FILTER = ListViewFilter(
    view_type="api",
    label="接口管理",
    fields={
        "name": FieldDecl(ApiDefinition.name, "text", "接口名称"),
        "path": FieldDecl(ApiDefinition.path, "text", "路径"),
        # method/status 在库里 NOT NULL：FieldDecl 因此自动拿不到「为空/不为空」，
        # 非空列上摆「为空」是点了没反应的假筛选项。
        "method": FieldDecl(ApiDefinition.method, "enum", "请求方法", nullable=False),
        "status": FieldDecl(ApiDefinition.status, "enum", "定义状态", nullable=False),
        "module_id": FieldDecl(ApiDefinition.module_id, "id", "所属模块"),
        "owner_id": FieldDecl(ApiDefinition.owner_id, "id", "负责人"),
        "created_at": FieldDecl(ApiDefinition.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(ApiDefinition.updated_at, "time", "更新时间", nullable=False),
    },
)
register(API_LIST_FILTER)

# 契约 1：api_test 不 import iam → 人名解析走表名 join（adb_test/case_services 同形状）。
# 前端换名字那条路（拉 /projects/{pid}/members）在权限上就是错的：该端点要 ensure_member，
# 而ReadOnly 之外的人也要能看见「负责人」列——id→名必须在后端 join 掉。
_APP_USER = table("app_user", column("id"), column("name"))


async def _user_names(db, user_ids: set[str]) -> dict[str, str]:
    """批量 id→人名：一页一次 IN 查询，不是逐行 N 次（adb_test._user_names 同款手法 B）。

    查不到的人（账号已删）留在 dict 外 → owner_name=None，前端照实说，不画空名字。
    """
    if not user_ids:
        return {}
    return {
        r[0]: r[1] for r in (await db.execute(
            select(_APP_USER.c.id, _APP_USER.c.name).where(_APP_USER.c.id.in_(sorted(user_ids)))
        )).all()
    }


def _produced(e: ApiDefinition) -> list[schemas.ProducedRef]:
    # ProducedRef 而不是同形 dict：ApiDefOut.produced 声明的就是 list[ProducedRef]。
    # dict 也能被 pydantic 校验过，但类型检查器只能报「dict 不是 ProducedRef」，
    # 而字段声明本身就在说这件事——按声明构造才对（序列化出来一字不差）。
    return [schemas.ProducedRef(kind="api_definition", id=e.id, name=e.name,
                              link="/api/definition/" + e.id)]


def _out(e: ApiDefinition, produced: bool = False, owner_name: str | None = None) -> schemas.ApiDefOut:
    return schemas.ApiDefOut(
        id=e.id, project_id=e.project_id, module_id=e.module_id, name=e.name, method=e.method, path=e.path,
        request=e.request, status=e.status, version=e.version,
        owner_id=e.owner_id, owner_name=owner_name, project_public=e.project_public,
        updated_at=schemas.iso(e.updated_at),
        produced=(_produced(e) if produced else []),
    )


def _norm_method(m: str) -> str:
    m = m.upper()
    if m not in {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"}:
        raise ApiError("validation_failed", "不支持的 HTTP 方法：" + m, 422, {"method": m})
    return m


@service(
    perm="api:def:create",
    effect="write",
    name="api_definition_create",
    description="创建 API 接口定义（request 为 §7.1 请求对象；name+project 唯一）",
    http={"method": "POST", "path": "/api-definitions", "tags": ["api_test"], "status": 201},
)
async def api_definition_create(payload: schemas.ApiDefCreateIn, ctx) -> schemas.ApiDefOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:create")
    assert ctx.db is not None
    dup = (
        await ctx.db.execute(select(ApiDefinition).where(ApiDefinition.project_id == payload.project_id,
                                                          ApiDefinition.name == payload.name))
    ).scalar_one_or_none()
    if dup is not None:
        msg = "接口名在回收站占位，请先恢复或改名" if dup.status == "recycled" else "接口名已存在"
        raise ApiError("conflict", msg, 409, {"name": payload.name})
    method = _norm_method(payload.method)
    req = payload.request.model_dump(exclude_none=True) if payload.request else None
    e = ApiDefinition(project_id=payload.project_id, module_id=payload.module_id, name=payload.name,
                      method=method, path=payload.path, request=req,
                      status="complete" if payload.request else "draft",
                      owner_id=ctx.user_id, project_public=payload.project_public)
    ctx.db.add(e)
    await ctx.db.commit()
    # 出参与列表/单查同形：owner_name 当场查一次（创建人就是 ctx.user_id，一条带 =d 的 SELECT）。
    names = await _user_names(ctx.db, {e.owner_id} if e.owner_id else set())
    return _out(e, produced=True, owner_name=names.get(e.owner_id or ""))


@service(
    perm="api:def:read",
    effect="read",
    name="api_definition_list",
    description="列出项目下的 API 接口定义（filter 传高级搜索条件 JSON："
                "{search_mode: AND|OR, conditions: [{field, operator, value}]}，"
                "可筛字段与操作符见 /filter-meta?view_type=api）",
    http={"method": "GET", "path": "/api-definitions", "tags": ["api_test"], "status": 200},
)
async def api_definition_list(payload: schemas.ApiDefListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:read")
    assert ctx.db is not None
    # 定义 status = draft/complete/recycled 三态：正常视图 = 非回收（draft/complete 都算），回收视图 = recycled
    #
    # 高级搜索（D47-a）：`parse` 回**单个**谓词，与可见性谓词并排在同一个 where 里
    # （SQLAlchemy 的多个 where 参数是 AND，OR 条件组因此关在自己的括号里）。
    # tests/test_d47a_list_filters.py 的 test_or_does_not_leak_invisible_rows 用别人的
    # 私有行做靶子钉这一行：结果里多出一行私有数据，它就红。
    #
    # D47-b 步 4a 的两路新谓词同样只是往同一个 where 里追加，口径逐字继承上面那段：
    # - module_ids：前端把「选中节点 + 全部子孙」（MS 语义：点模块看整棵子树，owner 裁定
    #   推翻 T23/R120 的直属旧口径）算好后发来。None = 不加这一路；[] = `IN (NULL)`，
    #   对任何行都不成立——**含 module_id 为 NULL 的未分类行**，空集就是空集。
    # - keyword：name/path 两列的 OR 包含，`self_group()` 自己把 OR 关进括号（与
    #   filters.build_conditions 同一条纪律：单独 compile 的 or_ 不带括号，括号必须是
    #   我们能自己钉住的性质）。转义复用 filters._like + ESCAPE '\`：用户敲的 %/_ 是字面量。
    #   **只匹配 name+path**：MS 还匹配 num/tags，本库的 api_definition 没有这两列
    #   （列集见 models.py 的 ApiDefinition），不为此造列。
    clauses: list[Any] = [
        ApiDefinition.project_id == payload.project_id, visible_clause(ApiDefinition, ctx),
        ApiDefinition.status == "recycled" if payload.recycled else ApiDefinition.status != "recycled",
        API_LIST_FILTER.parse(payload.filter),
    ]
    if payload.module_ids is not None:
        clauses.append(ApiDefinition.module_id.in_(payload.module_ids))
    if payload.keyword and payload.keyword.strip():
        kw = payload.keyword.strip()  # 全空白 = 没筛选；两端空白不进入匹配（用户看不见也删不掉的空格）
        clauses.append(or_(
            ApiDefinition.name.like(f"%{_like(kw)}%", escape="\\"),
            ApiDefinition.path.like(f"%{_like(kw)}%", escape="\\"),
        ).self_group())
    stmt = (
        select(ApiDefinition)
        .where(*clauses)
        .order_by(ApiDefinition.id)
    )
    # D47-b 步 4b：cursor 与 current 二选一（同 report_list/run_record_list）。
    # 「我在哪」的两套真相一起到场是调用方的 bug，静默择一会把错位藏进翻页里，所以大声 400。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在**同一条已排序 stmt** 上 OFFSET：ORDER BY 与键集逐字同一条（判据 5），
        # 且 total 与 items 用的是同一份 clauses——筛选在前、数数在后，MS 的 PageHelper 同构。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate(ctx.db, stmt, cursor_col=ApiDefinition.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    # 「负责人」列的名字：分页出结果后按页内 owner_id 去重一次 IN 查（手法 B，
    # 同 adb_case_list 的 updated_by_name），不改 paginate 的 join 形状。
    names = await _user_names(ctx.db, {e.owner_id for e in page.items if e.owner_id})
    return Page(items=[_out(e, owner_name=names.get(e.owner_id or "")) for e in page.items],
                next_cursor=page.next_cursor, total=page.total)


@service(
    perm="api:def:read",
    effect="read",
    name="api_definition_get",
    description="获取单个 API 接口定义",
    http={"method": "GET", "path": "/api-definitions/{definition_id}", "tags": ["api_test"], "status": 200},
)
async def api_definition_get(payload: schemas.ApiDefGetIn, ctx) -> schemas.ApiDefOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:read")
    assert ctx.db is not None
    e = await _fetch(ctx.db, payload.project_id, payload.definition_id)
    assert_row_visible(e, ctx, what="接口定义不存在")
    if e.status == "recycled":
        raise ApiError("not_found", "接口定义不存在（在回收站）", 404, {"definition_id": e.id})
    # 单查同样把 id→名换掉（一次带 =d 的 SELECT，不是 N+1）：
    # 出参形状与列表一致，前端详情/其它消费方不用各自再想办法认人。
    names = await _user_names(ctx.db, {e.owner_id} if e.owner_id else set())
    return _out(e, owner_name=names.get(e.owner_id or ""))


@service(
    perm="api:def:update",
    effect="write",
    name="api_definition_update",
    description="更新 API 接口定义（乐观锁：version 不匹配 → 409 conflict）",
    http={"method": "PATCH", "path": "/api-definitions/{definition_id}", "tags": ["api_test"], "status": 200},
)
async def api_definition_update(payload: schemas.ApiDefUpdateIn, ctx) -> schemas.ApiDefOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:update")
    assert ctx.db is not None
    e = await _fetch(ctx.db, payload.project_id, payload.definition_id)
    assert_row_visible(e, ctx, what="接口定义不存在")
    if e.status == "recycled":
        raise ApiError("not_found", "接口定义不存在（在回收站，请先恢复）", 404, {"definition_id": e.id})
    if e.version != payload.version:
        raise ApiError("conflict", "版本冲突：他人已修改，请刷新后重试", 409,
                       {"current_version": e.version, "your_version": payload.version})
    if payload.name is not None:
        e.name = payload.name
    if payload.path is not None:
        e.path = payload.path
    if payload.request is not None:
        e.request = payload.request.model_dump(exclude_none=True)
        e.method = payload.request.method
        e.status = "complete"
    if payload.module_id is not None:
        e.module_id = payload.module_id
    if payload.project_public is not None:
        e.project_public = payload.project_public
    e.version += 1
    await ctx.db.commit()
    names = await _user_names(ctx.db, {e.owner_id} if e.owner_id else set())
    return _out(e, produced=True, owner_name=names.get(e.owner_id or ""))


async def _fetch(db, project_id: str, definition_id: str) -> ApiDefinition:
    e = (
        await db.execute(select(ApiDefinition).where(ApiDefinition.id == definition_id,
                                                      ApiDefinition.project_id == project_id))
    ).scalar_one_or_none()
    if e is None:
        raise ApiError("not_found", "接口定义不存在", 404, {"definition_id": definition_id})
    return e


async def _definition_scenario_refs(ctx, project_id: str, definition_id: str) -> dict | None:
    """定义级的场景引用：场景步骤的 ref 存的是 **case_id**（scenario `_scan_refs` 的
    api_case 分支按 case_ids 匹配，definition_ids 只喂 ui_case/adb_case 步骤），
    所以「场景指着这条接口」在数据上等价于「场景指着它的某条用例」——没有直接指着
    定义的 api 步骤可数，把定义 id 塞进 definition_ids 会是一扇恒为 0 的假门。

    只数未回收用例：已回收用例的步骤本来就跑不动（api_case_resolve 先判用例状态），
    回收定义不会让它坏第二次，拦这种引用只会把人训练成无脑 force；定义软删 +
    restore 全有全无，也不存在数据集 purge 那种「恢复后永久悬空」。

    跨模块口径照旧经注册表（契约 1），这里只是复用同包的 _scenario_refs 壳子。
    """
    # 与 api_debug 里 _visible_case/merge_request 同款延迟导入：不在顶层把两文件的
    # import 图焊死，私有件复用留在调用点。
    from app.modules.api_test.case_services import _scenario_refs

    assert ctx.db is not None
    case_ids = list((await ctx.db.execute(
        select(ApiCase.id).where(ApiCase.project_id == project_id,
                                 ApiCase.definition_id == definition_id,
                                 ApiCase.status == "normal"))).scalars().all())
    refs = await _scenario_refs(ctx, project_id, case_ids)
    if not refs:
        return None
    hidden = any(bool(r["hidden"]) for r in refs.values())
    merged: dict[str, dict] = {}
    for r in refs.values():
        for s in r["scenarios"]:
            m = merged.setdefault(s["scenario_id"], {"scenario_name": s["scenario_name"],
                                                     "step_keys": set(s["step_keys"])})
            m["step_keys"].update(s["step_keys"])
    scenarios = [{"scenario_id": sid, "scenario_name": m["scenario_name"],
                  "step_keys": sorted(m["step_keys"])} for sid, m in sorted(merged.items())]
    if hidden:
        # 明细被 scenario_case_refs 抹平后跨用例去重无从谈起：count 取各用例引用数之和，
        # 一个场景引用两条用例时会多算——方向是宁多报不少报，少报会骗人按下删除键。
        return {"count": sum(r["count"] for r in refs.values()), "scenarios": [], "hidden": True}
    return {"count": len(scenarios), "scenarios": scenarios, "hidden": False}


def _blocked_definition(ref: dict, *, definition_id: str) -> ApiError:
    """定义级「被场景引用」409：错误码与 details 键式与用例侧 _blocked 同一套词汇，
    但措辞必须说清这里断的是什么——回收不删用例，坏的是指向其用例的场景步骤，
    且一切随 restore 原样回来。"""
    details: dict = {"definition_id": definition_id, "count": ref["count"],
                     "scenarios": ref["scenarios"]}
    if ref["hidden"]:
        # 数量照报、明细隐瞒：查不到是谁必须说出口，退化成「没人引用」会骗人按下删除键
        return ApiError("referenced_by_scenario",
                        "该接口的用例被 " + str(ref["count"]) + " 个未回收场景引用，不能回收；"
                        "引用明细需要 scenario:read 权限，请联系有该权限的成员在场景里先解绑",
                        409, {**details, "reason": "missing_scenario_read"})
    names = "、".join("「" + s["scenario_name"] + "」步骤 " + "、".join(s["step_keys"])
                      for s in ref["scenarios"][:5])
    more = " 等 " + str(ref["count"]) + " 个场景" if ref["count"] > 5 else ""
    return ApiError("referenced_by_scenario",
                    "该接口的用例被 " + str(ref["count"]) + " 个未回收场景引用：" + names + more
                    + "；回收不会删除用例，但用例随接口整体不可达，这些步骤会当场解析失败"
                    "（restore 后原样回来）；先在场景里改引用，或确认要连带断掉这些步骤后带 force=true 重试",
                    409, details)


@service(
    perm="api:def:delete",
    effect="destructive",
    name="api_definition_delete",
    description="接口定义放入回收站（软删；用例不删，随定义整体不可达，restore 原样回归；"
                "其未回收用例被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force）",
    http={"method": "POST", "path": "/api-definitions/{definition_id}/delete", "tags": ["api_test"]},
    resident=False,
)
async def api_definition_delete(payload: schemas.ApiDefDeleteIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:delete")
    assert ctx.db is not None
    e = await _fetch(ctx.db, payload.project_id, payload.definition_id)
    assert_row_visible(e, ctx, what="接口定义不存在")
    if e.status == "recycled":
        raise ApiError("not_found", "接口定义不存在", 404, {"definition_id": e.id})
    # 先查引用再改状态：409 必须是一条什么都没改的失败（否则重试看到的就是「已回收」）
    ref = await _definition_scenario_refs(ctx, payload.project_id, e.id)
    # force 只放行「已经看见引用清单」的人：明细被隐瞒时 force 同样拦下——
    # 他不知道该断的是谁的步骤，一键下去坏的是别人的场景。
    if ref and (not payload.force or ref["hidden"]):
        raise _blocked_definition(ref, definition_id=e.id)
    e.status = "recycled"
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="api:def:delete",
    effect="destructive",
    name="api_definition_purge",
    description="彻底删除回收站中的接口定义（物理删除，连带其用例；接口名随之释放，不可恢复）",
    http={"method": "POST", "path": "/api-definitions/{definition_id}/purge", "tags": ["api_test"]},
    tool=False,
    resident=False,
)
async def api_definition_purge(payload: schemas.ApiDefPurgeIn, ctx) -> BaseModel:
    """回收站的出口。只有软删过的东西能走到这里，且必须逐字确认名称。

    为什么非做不可：uq_apidef_project_name 把名字连同软删行一起占住，
    没有彻底删除，回收站就是一扇单向门——删错的名字永远腾不出来。
    运行记录不追删：subject_name 是冗余快照，历史调试仍要能查（§6.7）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:delete")
    assert ctx.db is not None
    e = await _fetch(ctx.db, payload.project_id, payload.definition_id)
    assert_row_visible(e, ctx, what="接口定义不存在")
    if e.status != "recycled":
        raise ApiError("not_recycled", "只能彻底删除回收站里的接口：请先放入回收站", 409,
                       {"definition_id": e.id})
    if payload.confirm_name != e.name:
        raise ApiError("name_mismatch", "确认名称与接口名不一致，未删除", 409,
                       {"definition_id": e.id})
    cases = (
        await ctx.db.execute(select(ApiCase).where(ApiCase.definition_id == e.id))
    ).scalars().all()
    for c in cases:
        await ctx.db.delete(c)
    await ctx.db.delete(e)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="api:def:update",
    effect="write",
    name="api_definition_restore",
    description="从回收站恢复接口定义",
    http={"method": "POST", "path": "/api-definitions/{definition_id}/restore", "tags": ["api_test"]},
    resident=False,
)
async def api_definition_restore(payload: schemas.ApiDefGetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:update")
    assert ctx.db is not None
    e = await _fetch(ctx.db, payload.project_id, payload.definition_id)
    assert_row_visible(e, ctx, what="接口定义不存在")
    if e.status != "recycled":
        raise ApiError("not_found", "接口定义不在回收站", 404, {"definition_id": e.id})
    e.status = "complete" if e.request else "draft"
    await ctx.db.commit()
    names = await _user_names(ctx.db, {e.owner_id} if e.owner_id else set())
    return _out(e, owner_name=names.get(e.owner_id or ""))


# —— 调试执行（T8）：传输钩子仅供测试注入（与 tasks.set_gateway_factory 同款） ——
_transport_factory: Callable[[], Any] | None = None


def set_debug_transport(factory) -> None:
    global _transport_factory
    _transport_factory = factory


async def _resolve_via_registry(ctx, project_id: str, env_id: str | None):
    """跨模块取环境数据：只经注册表调 env_resolve（契约 1：模块间不 import）。"""
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("env_resolve")
    if spec is None:  # 与 engine/handlers._resolve_case 同款：未注册是装配错，大声 500
        raise ApiError("internal_error", "env_resolve 未注册（服务尚未初始化完成）", 500)
    out = await spec.handler(spec.model.model_validate({"project_id": project_id, "env_id": env_id}), ctx)
    return dict(out.model_dump())


@service(
    perm="api:debug:run", effect="write", name="api_debug",
    description="单接口调试：真实发送请求并评估断言（对目标系统有外部副作用；返回全量响应与断言明细）",
    http={"method": "POST", "path": "/api-debug", "tags": ["api_test"]},
)
async def api_debug(payload: schemas.ApiDebugIn, ctx) -> schemas.DebugOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:debug:run")
    assert ctx.db is not None
    given = [payload.definition_id, payload.request, payload.case_id].count(None)
    if given != 2:
        raise ApiError("validation_failed", "definition_id / request / case_id 必须三选一", 422)
    if payload.subject_definition_id is not None and (payload.definition_id or payload.case_id):
        raise ApiError("validation_failed", "subject_definition_id 只在用 request 调试草稿时使用", 422,
                       {"subject_definition_id": payload.subject_definition_id})
    dataset_row: dict[str, str] = {}
    if payload.definition_id is not None:
        e = await _fetch(ctx.db, payload.project_id, payload.definition_id)
        assert_row_visible(e, ctx, what="接口定义不存在")
        if e.status == "recycled":
            raise ApiError("not_found", "接口定义不存在（在回收站）", 404, {"definition_id": e.id})
        req = dict(e.request or {})
        req.setdefault("method", e.method)
        req.setdefault("url", e.path)
        explicit_timeout = True  # 定义内 request 已含显式 timeout 默认值
        subject_type, subject_id, subject_name = "api_definition", e.id, e.name
    elif payload.case_id is not None:
        from app.modules.api_test.case_services import _visible_case, merge_request
        from app.modules.api_test.models import ApiDefinition as _AD

        cs = await _visible_case(ctx.db, ctx, payload.project_id, payload.case_id)
        if cs.status != "normal":
            raise ApiError("not_found", "用例不存在", 404, {"case_id": cs.id})
        defn = await ctx.db.get(_AD, cs.definition_id)
        if defn is None or defn.status == "recycled":
            raise ApiError("not_found", "用例所属接口在回收站", 404, {"case_id": cs.id})
        eff = merge_request(defn, cs)
        if eff is None:
            raise ApiError("validation_failed", "用例不可执行：定义无请求对象且用例未覆盖 url", 422)
        req = eff  # 先判 None 再交给 req：直接赋值会让 req 的类型里留着 None
        explicit_timeout = "timeout_ms" in req
        subject_type, subject_id, subject_name = "api_case", cs.id, cs.name
        if cs.dataset_id:
            ds = await ctx.db.get(DataSet, cs.dataset_id)
            if ds is not None and ds.rows:
                # 数据驱动首行层：高于环境、低于调试临时（1B 场景循环时全行驱动）
                dataset_row = {str(k): str(v) for k, v in zip(ds.columns, ds.rows[0], strict=False)}
    else:
        ro = payload.request
        assert ro is not None
        req = ro.model_dump(exclude_none=True)
        explicit_timeout = "timeout_ms" in (ro.model_fields_set or set())
        subject_type, subject_id, subject_name = "inline", "inline", "临时请求"
        if payload.subject_definition_id is not None:
            # 草稿调试也要出现在接口行的「最近结果」里：归属到定义，但跑的仍是编辑器里的请求
            owner = await _fetch(ctx.db, payload.project_id, payload.subject_definition_id)
            assert_row_visible(owner, ctx, what="接口定义不存在")
            if owner.status == "recycled":
                raise ApiError("not_found", "接口定义不存在（在回收站）", 404, {"definition_id": owner.id})
            subject_type, subject_id, subject_name = "api_definition", owner.id, owner.name
    env = await _resolve_via_registry(ctx, payload.project_id, payload.env_id)
    # 变量分层：全局⊕环境（env_resolve 已合并）→ 调试临时覆盖（§7.5 最高优先级）
    variables = merge_vars(dict((k, v) for k, v in env["vars"]), dataset_row, payload.variables)
    # 请求头：环境层为底，请求自身同名（大小写不敏感）覆盖
    own = [[str(k), str(v)] for k, v in (req.get("headers") or [])]
    own_keys = {k.lower() for k, _v in own}
    req["headers"] = [h for h in env["headers"] if h[0].lower() not in own_keys] + own
    if env["timeout_ms"] and not explicit_timeout:
        req["timeout_ms"] = env["timeout_ms"]
    transport = _transport_factory() if _transport_factory else None
    try:
        result = await run_api(req, variables=variables, transport=transport)
    except MissingVar as e:
        raise ApiError("validation_error", "缺少变量：" + e.name, 422, {"var": e.name}) from e
    except ValueError as e:
        # D172 form 垃圾 body 与 RequestAuthError（ValueError 子类）同路：执行核抛的
        # 已是人话（D157 纪律），原样转 422，不落裸 500。MissingVar 非 ValueError，顺序无碍。
        raise ApiError("validation_error", str(e), 422) from e
    rec = await save_run(ctx.db, project_id=payload.project_id, subject_type=subject_type,
                         subject_id=subject_id, subject_name=subject_name,
                         env_id=payload.env_id, env_name=env["env_name"],
                         trigger="agent" if ctx.entry == "agent" else "debug",
                         result=result, request_snapshot=req, created_by=ctx.user_id)
    await ctx.db.commit()
    return schemas.DebugOut(run_id=rec.id, ok=result.ok, passed=result.passed(),
                             status=result.status, headers=result.headers,
                             body_text=result.body_text, truncated=result.truncated,
                             body_size=result.body_size, elapsed_ms=result.elapsed_ms,
                             error=result.error, assertions=result.assertions,
                             env_name=env["env_name"])
