"""ADB 用例 @service（§7.3 / §11.4.12 / §11.5.5）：CRUD + 回收站 + 保存门 + 场景引用检测。

ui_test/case_services.py 的近亲（R102 同源），两处有意差异：

1. **只有一道保存门**（协议门 `commands.validate_steps`）：UI 的第二道「引用门」查的是
   元素库，ADB 步骤不引用元素库——per-step `device` 与 `default_device` 存的是**设备
   serial**，存期不校验存在性（与 UI 的 env 同款口径：先存草稿、设备还没登记是正常
   顺序；跑的时候 resolve 会说「跑不了」，那是数据事实不是请求非法）。
2. **steps 缺省语义相同**：None → 协议门给 `empty_steps`（「空用例零步全绿是假绿」）。

引用检测与 UI 一对一镜像：HTTP 面单条（`adb_case_references`）+ 内部批量
（`adb_case_refs`，供删除保护），都只经注册表问 `scenario_case_refs`（契约 1）。
1D T8 起真出数：`BLOCKED_1B` 清空后场景能存 `adb_case` 节点，`adb_case_delete`
的引用拦截同步接上（与 api_case 同款 force 两段式；api_test/case_services 为前置例）。
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.sql import column, table

from app.core.errors import ApiError, Page, paginate, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.adb_test import schemas
from app.modules.adb_test.commands import validate_steps
from app.modules.adb_test.models import STATUS_RECYCLED, AdbCase
from app.modules.adb_test.module_services import _adb_module
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.visibility import assert_row_visible, visible_clause

# 契约 1：adb_test 不 import iam → 人名解析走表名 join（audit/services._APP_USER 同形状）。
# §11.4.18 回收站的「删除人」列要的是人名：updated_by 是 user id，把 id 直接渲染成删除人
# 等于把 UUID 当人名，界面就不诚实了；查不到人留 None，前端画「—」。
_APP_USER = table("app_user", column("id"), column("name"))

# D217：ADB 用例列表的可筛面（D47-a 三件套铺到 ADB 页）。只收 adb_case 表上的业务列；
# `recycled` 是视图轴（与 status 的原值一起由顶层开关决定，进条件组会自相矛盾），
# `module_id`/`unfiled_only` 是模块树轴（页面由左侧树驱动，条件组里再来一份就是两把尺子）。
ADB_CASE_LIST_FILTER = ListViewFilter(
    view_type="adb_case",
    label="ADB 用例",
    fields={
        "name": FieldDecl(AdbCase.name, "text", "名称", nullable=False),
        "priority": FieldDecl(AdbCase.priority, "enum", "优先级", nullable=False),
        "enabled": FieldDecl(AdbCase.enabled, "bool", "启用", nullable=False),
        "default_device": FieldDecl(AdbCase.default_device, "text", "默认设备"),
        "owner_id": FieldDecl(AdbCase.owner_id, "id", "负责人"),
        "project_public": FieldDecl(AdbCase.project_public, "bool", "项目内公开", nullable=False),
        "step_count": FieldDecl(AdbCase.step_count, "number", "步骤数", nullable=False),
        "last_run_at": FieldDecl(AdbCase.last_run_at, "time", "最近执行时间"),
        "last_run_status": FieldDecl(AdbCase.last_run_status, "enum", "最近执行结果"),
        "updated_by": FieldDecl(AdbCase.updated_by, "id", "更新人"),
        "created_at": FieldDecl(AdbCase.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(AdbCase.updated_at, "time", "更新时间", nullable=False),
    },
)
register(ADB_CASE_LIST_FILTER)


async def _user_names(db, user_ids: set[str]) -> dict[str, str]:
    """批量 id→人名（workbench/model_usage._user_names 同款手法 B）。

    刻意是「分页拿到页内行之后的一次小 IN 查询」而不是把列表 stmt 改成 join：
    paginate 的 page.items 一旦变 tuple，row_key/游标全要跟着改，与这件事无关。
    """
    if not user_ids:
        return {}
    return {
        r[0]: r[1] for r in (await db.execute(
            select(_APP_USER.c.id, _APP_USER.c.name).where(_APP_USER.c.id.in_(sorted(user_ids)))
        )).all()
    }


def _issues_for(steps: Any) -> list[dict]:
    """live issues（纯协议校验；对任何输入都返回列表，绝不抛异常）。"""
    return validate_steps(steps if steps is not None else [])


def _case_out(c: AdbCase, issues: list[dict] | None = None,
              updated_by_name: str | None = None) -> schemas.AdbCaseOut:
    return schemas.AdbCaseOut(
        id=c.id, project_id=c.project_id, module_id=c.module_id, name=c.name,
        priority=c.priority, enabled=bool(c.enabled), steps=list(c.steps or []),
        default_device=c.default_device, owner_id=c.owner_id, project_public=c.project_public,
        status=c.status, step_count=c.step_count, last_run_at=schemas.iso(c.last_run_at),
        last_run_status=c.last_run_status, updated_by=c.updated_by,
        updated_by_name=updated_by_name,
        created_at=schemas.iso(c.created_at), updated_at=schemas.iso(c.updated_at),
        issues=issues if issues is not None else _issues_for(c.steps),
    )


async def _case(db, project_id: str, case_id: str) -> AdbCase:
    c = (await db.execute(select(AdbCase).where(AdbCase.id == case_id,
                                                AdbCase.project_id == project_id))).scalar_one_or_none()
    if c is None:
        raise ApiError("not_found", "ADB 用例不存在", 404, {"case_id": case_id})
    return c


async def _name_dup(db, project_id: str, name: str, exclude: str | None = None) -> None:
    """同项目同名（含回收站墓碑）→ 409。

    码用 `conflict` + details.name_exists（ui_case 的同款理由：全库重名冲突今天都是
    `conflict`，撞上唯一键的时机不同不能给出两个错误码）。
    """
    stmt = select(AdbCase).where(AdbCase.project_id == project_id, AdbCase.name == name)
    if exclude:
        stmt = stmt.where(AdbCase.id != exclude)
    hit = (await db.execute(stmt)).scalars().first()
    if hit is None:
        return
    if hit.status == STATUS_RECYCLED:
        raise ApiError("conflict", "同名用例在回收站里占着名字：先恢复它，或者彻底删除它", 409,
                       {"name": name, "name_exists": True, "recycled": True})
    raise ApiError("conflict", "ADB 用例名已存在", 409, {"name": name, "name_exists": True})


def _gate(steps: Any) -> int:
    """保存门（协议门）：不过 → 422 validation_error + details.issues（逐行标红）；
    过了返回 step_count（冗余列，列表不 N+1）。"""
    issues = _issues_for(steps)
    if issues:
        raise ApiError("validation_error",
                       "ADB 用例校验未通过：共 " + str(len(issues)) + " 个步骤问题", 422,
                       {"issues": issues})
    return len(steps) if isinstance(steps, list) else 0


@service(
    perm="adb:case:read", effect="read", name="adb_case_list",
    description="列出项目下的 ADB 用例（默认不含回收站；最近结果读冗余列，不 N+1 查 run_record）",
    http={"method": "GET", "path": "/adb-cases", "tags": ["adb"]},
)
async def adb_case_list(payload: schemas.AdbCaseListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:read")
    assert ctx.db is not None
    stmt = select(AdbCase).where(AdbCase.project_id == payload.project_id,
                                 visible_clause(AdbCase, ctx),
                                 AdbCase.status == (STATUS_RECYCLED if payload.recycled else "normal"),
                                 # D217：高级搜索条件与项目/可见性/回收站轴并行 AND；
                                 # OR 组自带括号，不会把可见性谓词吃进 OR 里。
                                 ADB_CASE_LIST_FILTER.parse(payload.filter))
    if payload.unfiled_only:
        stmt = stmt.where(AdbCase.module_id.is_(None))
    elif payload.module_id:
        stmt = stmt.where(AdbCase.module_id == payload.module_id)
    stmt = stmt.order_by(AdbCase.id)
    # D47-b 步 5a：cursor 与 current 二选一（同 api_definition_list / report_list）。
    # 「我在哪」的两套真相一起到场是调用方的 bug，静默择一会把错位藏进翻页里，所以大声 400。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在**同一条已排序 stmt** 上 OFFSET：ORDER BY 与键集逐字同一条（判据 5），
        # 且 total 与 items 吃同一份 WHERE——筛选在前、数数在后（MS 的 PageHelper 同构）。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate(ctx.db, stmt, cursor_col=AdbCase.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    # last_run_* 是行上冗余列（终态回写），列表一条额外 SELECT 都不发（ui_case_list 同款）
    # updated_by_name 是回收站「删除人」列的唯一例外查询：分页出结果后按页内 id 去重一次
    # IN 查（手法 B，不改 paginate 的 join 形状——见 _user_names 注释）。
    names = await _user_names(ctx.db, {c.updated_by for c in page.items if c.updated_by})
    return Page(items=[_case_out(c, issues=[], updated_by_name=names.get(c.updated_by or ""))
                       for c in page.items], next_cursor=page.next_cursor, total=page.total)


@service(
    perm="adb:case:create", effect="write", name="adb_case_create",
    description="创建 ADB 用例（steps 过 §7.3 协议校验：不过 → 422 逐行 issues；同项目重名 409）",
    http={"method": "POST", "path": "/adb-cases", "tags": ["adb"], "status": 201},
)
async def adb_case_create(payload: schemas.AdbCaseCreateIn, ctx) -> schemas.AdbCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:create")
    assert ctx.db is not None
    if payload.module_id is not None:
        await _adb_module(ctx.db, payload.project_id, payload.module_id)
    await _name_dup(ctx.db, payload.project_id, payload.name)
    count = _gate(payload.steps)
    c = AdbCase(project_id=payload.project_id, module_id=payload.module_id, name=payload.name,
                priority=payload.priority, enabled=1 if payload.enabled else 0,
                steps=list(payload.steps or []), default_device=payload.default_device,
                owner_id=ctx.user_id, project_public=payload.project_public,
                step_count=count, updated_by=ctx.user_id)
    ctx.db.add(c)
    await ctx.db.commit()
    return _case_out(c, issues=[])


@service(
    perm="adb:case:read", effect="read", name="adb_case_get",
    description="获取 ADB 用例详情（含 live issues：打开老用例就看得见校验问题，不必等保存 422）",
    http={"method": "GET", "path": "/adb-cases/{case_id}", "tags": ["adb"]},
)
async def adb_case_get(payload: schemas.AdbCaseGetIn, ctx) -> schemas.AdbCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:read")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 用例不存在（在回收站）", 404, {"case_id": c.id})
    return _case_out(c)


@service(
    perm="adb:case:update", effect="write", name="adb_case_update",
    description="更新 ADB 用例（改 steps 时重过协议门并重算 step_count；无乐观锁，R104 同 UiCase）",
    http={"method": "PATCH", "path": "/adb-cases/{case_id}", "tags": ["adb"]},
)
async def adb_case_update(payload: schemas.AdbCaseUpdateIn, ctx) -> schemas.AdbCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 用例不存在（在回收站，请先恢复）", 404, {"case_id": c.id})
    if payload.name is not None and payload.name != c.name:
        await _name_dup(ctx.db, payload.project_id, payload.name, exclude=c.id)
        c.name = payload.name
    if payload.priority is not None:
        c.priority = payload.priority
    if payload.enabled is not None:
        c.enabled = 1 if payload.enabled else 0
    if payload.module_set:
        if payload.module_id is not None:
            await _adb_module(ctx.db, payload.project_id, payload.module_id)
        c.module_id = payload.module_id
    if payload.default_device_set:
        # 存期不校验 serial 存在性（上面模块 docstring 的口径）
        c.default_device = payload.default_device
    if payload.steps_set:
        c.step_count = _gate(payload.steps)
        c.steps = list(payload.steps or [])
    if payload.project_public is not None:
        c.project_public = payload.project_public
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    return _case_out(c, issues=[])


def _blocked(ref: dict, *, action: str, case_id: str) -> ApiError:
    """把「被场景引用」拼成给用户看的 409（与 api_test 的 _blocked 同口径）：
    点名引用者与命中步骤，他才有的可解；无 scenario:read 时数量照报、明细隐瞒。"""
    details: dict = {"case_id": case_id, "count": ref["count"], "scenarios": ref["scenarios"]}
    if ref["hidden"]:
        return ApiError("referenced_by_scenario",
                        "该用例被 " + str(ref["count"]) + " 个未回收场景引用，不能" + action
                        + "；引用明细需要 scenario:read 权限，请联系有该权限的成员在场景里先解绑",
                        409, {**details, "reason": "missing_scenario_read"})
    names = "、".join("「" + s["scenario_name"] + "」步骤 " + "、".join(s["step_keys"])
                      for s in ref["scenarios"][:5])
    more = " 等 " + str(ref["count"]) + " 个场景" if ref["count"] > 5 else ""
    head = "该用例被 " + str(ref["count"]) + " 个未回收场景引用：" + names + more
    tail = ("；先在场景里改引用，或确认要连带断掉这些步骤后带 force=true 重试" if action == "回收"
            else "；彻底删除不可回退，请先在场景里改引用（回收站里的用例也一样：回收 ≠ 解绑）")
    return ApiError("referenced_by_scenario", head + tail, 409, details)


@service(
    perm="adb:case:delete", effect="destructive", name="adb_case_delete",
    description="把 ADB 用例放入回收站（软删；已回收再删 404；被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force）",
    http={"method": "POST", "path": "/adb-cases/{case_id}/delete", "tags": ["adb"]},
    resident=False,
)
async def adb_case_delete(payload: schemas.AdbCaseDeleteIn, ctx) -> BaseModel:
    """1D T8 接上场景引用拦截（与 api_case_delete 同款 force 两段式）。

    T7 时这里刻意不写：BLOCKED_1B 让场景存不下 adb_case 节点，恒为 0 的保护是
    §13 纪律 1 禁止的假门。T8 摘插槽后通道真出数（adb_case_refs），保护随之生效。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:delete")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status != "normal":
        raise ApiError("not_found", "ADB 用例不存在", 404, {"case_id": c.id})
    # 先查引用再改状态：409 必须是一条什么都没改的失败（否则重试看到的就是「已回收」）
    ref = (await _scenario_refs(ctx, payload.project_id, [c.id])).get(c.id)
    # force 只放行「已经看见引用清单」的人：明细被隐瞒时 force 同样拦下——
    # 他不知道该断的是谁的步骤，一键下去坏的是别人的场景。
    if ref and (not payload.force or ref["hidden"]):
        raise _blocked(ref, action="回收", case_id=c.id)
    c.status = STATUS_RECYCLED
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="adb:case:update", effect="write", name="adb_case_restore",
    description="从回收站恢复 ADB 用例（回收期间名字被占 → 409，不静默改名）",
    http={"method": "POST", "path": "/adb-cases/{case_id}/restore", "tags": ["adb"]},
    resident=False,
)
async def adb_case_restore(payload: schemas.AdbCaseGetIn, ctx) -> schemas.AdbCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status != STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 用例不在回收站", 404, {"case_id": c.id})
    stmt = select(AdbCase).where(AdbCase.project_id == payload.project_id,
                                 AdbCase.name == c.name, AdbCase.id != c.id,
                                 AdbCase.status == "normal")
    if (await ctx.db.execute(stmt)).scalars().first() is not None:
        raise ApiError("conflict", "回收期间这个名字已经被另一条用例占用：先处理它再恢复", 409,
                       {"name": c.name, "name_exists": True})
    c.status = "normal"
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    return _case_out(c)


@service(
    perm="adb:case:delete", effect="destructive", name="adb_case_purge",
    description="彻底删除回收站中的 ADB 用例（物理删除，不可恢复；须逐字确认用例名）",
    http={"method": "POST", "path": "/adb-cases/{case_id}/purge", "tags": ["adb"]},
    tool=False, resident=False,
)
async def adb_case_purge(payload: schemas.AdbCasePurgeIn, ctx) -> BaseModel:
    """回收站出口（R53）：只有软删过的东西能到这里，且必须逐字确认名称。

    1D T8 接上引用硬拦（与 api_case_purge 同款，无 force 出口）：回收 ≠ 解绑，
    场景步骤的 ref 还指着它，物理删掉就是让那一步永久悬空。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:delete")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的用例：请先放入回收站", 409,
                       {"case_id": c.id})
    if payload.confirm_name != c.name:
        raise ApiError("name_mismatch", "确认名称与用例名不一致，未删除", 409, {"case_id": c.id})
    ref = (await _scenario_refs(ctx, payload.project_id, [c.id])).get(c.id)
    if ref:
        raise _blocked(ref, action="彻底删除", case_id=c.id)
    await ctx.db.delete(c)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="adb:case:read", effect="read", name="adb_case_references",
    description="查引用这条 ADB 用例的未回收场景（含命中步骤 key；供用例详情「场景引用」Tab）",
    http={"method": "GET", "path": "/adb-case-references", "tags": ["adb"]},
)
async def adb_case_references(payload: schemas.AdbCaseReferencesIn,
                              ctx) -> schemas.AdbCaseReferencesOut:
    """HTTP 面单条查询；批量口径在内部件 `adb_case_refs`（与 ui_case_references 同构，
    「GET + required list 会成永远 422 的路由」是那边实测过的坑）。"""
    if not payload.case_id:
        raise ApiError("validation_failed", "case_id 必填", 422)
    found = await _scenario_refs(ctx, payload.project_id, [payload.case_id])
    ref = found.get(payload.case_id)
    if not ref:
        return schemas.AdbCaseReferencesOut(items=[], details_hidden=False)
    items = [] if ref["hidden"] else [
        schemas.AdbScenarioRefItem(scenario_id=i["scenario_id"], scenario_name=i["scenario_name"],
                                   step_keys=list(i["step_keys"]), sort=i.get("sort") or "P2")
        for i in ref["scenarios"]]
    return schemas.AdbCaseReferencesOut(items=items, details_hidden=bool(ref["hidden"]))


@service(
    perm="adb:case:read", effect="read", name="adb_case_refs",
    description="批量查引用这些 ADB 用例的未回收场景（供 T8 删除保护内部调用；"
                "无 scenario:read 时数量照报、明细隐瞒）",
    http=None, tool=False, resident=False,
)
async def adb_case_refs(payload: schemas.AdbCaseRefsIn, ctx) -> schemas.AdbCaseRefsOut:
    if not payload.case_ids:
        return schemas.AdbCaseRefsOut(groups=[])
    found = await _scenario_refs(ctx, payload.project_id, list(payload.case_ids))
    groups = [schemas.AdbCaseRefGroup(
        case_id=cid, count=ref["count"],
        items=[schemas.AdbScenarioRefItem(scenario_id=i["scenario_id"], scenario_name=i["scenario_name"],
                                          step_keys=list(i["step_keys"]), sort=i.get("sort") or "P2")
               for i in ref["scenarios"]] if not ref["hidden"] else [])
        for cid, ref in sorted(found.items()) if ref["count"]]
    return schemas.AdbCaseRefsOut(groups=groups,
                                  details_hidden=bool(any(r["hidden"] for r in found.values())))


async def _scenario_refs(ctx, project_id: str, case_ids: list[str]) -> dict[str, dict]:
    """跨模块问「这些 ADB 用例被哪些未回收场景当一步」：只经注册表调 `scenario_case_refs`（契约 1）。

    `scenario_case_refs` 把非 `api_case` 步骤的 `ref` 当 definition_ids 匹配
    （scenario/services.py `_scan_refs`）——`adb_case` 步骤的 ref 就是 ADB 用例 id
    （T8 的 `adb_case_resolve` 入参就是 case_id），与 `ui_case` 走同一通道。

    未注册时按「零引用」放行不可接受：注册顺序不能悄悄决定删除保护生不生效。

    1D T8 起真出数：`graph.BLOCKED_1B` 清空后场景保存能收下 `adb_case` 节点，
    本通道零改动自动开始匹配（test_adb_case.py 的 HTTP 保存路径钉住出数）。
    """
    from app.core.registry import REGISTRY

    ids = [c for c in dict.fromkeys(case_ids) if c]
    if not ids:
        return {}
    spec = REGISTRY.get("scenario_case_refs")
    if spec is None:
        raise ApiError("internal_error", "scenario_case_refs 未注册（服务尚未初始化完成）", 500)
    out = await spec.handler(spec.model.model_validate(
        {"project_id": project_id, "definition_ids": ids}), ctx)
    data = out.model_dump()
    return {g["ref_id"]: {"count": g["count"], "scenarios": g["items"],
                          "hidden": bool(data["details_hidden"]) and g["count"] > 0}
            for g in data["groups"]}
