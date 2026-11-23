"""UI 用例 @service（§7.2 / §11.4.12 / §11.5.4）：CRUD + 回收站 + 两道保存门。

保存期两道门，顺序是定过的，别换：

1. **协议门**（`commands.validate_commands`）：命令结构不合法 → 422 `validation_error`
   + `details.issues`。校验器是画布与后端的同一份规则（前端孪生 `web/src/ui/commands.ts`），
   所以「画布能保存、后端说非法」这种分叉不可能出现。
2. **引用门**（本文件）：`element_id` 必须指向同项目且**未回收**的元素 → 422
   `unknown_element`。协议门只管「有没有给 element_id」，管不了「这个 id 存不存在」——
   存一个指不到的 id 下去，用例保存成功、列表正常，直到执行那一刻才炸
   （`ui_case_resolve` 会回 executable=False）。1B 的 R48 早把这类问题的成本搬到编辑期，
   这里是同一判断。

两道门都用 422 + `details.issues`（每条带 `index`），因为 §11.4.12 的命令列表编辑器
要**逐行标红**：只有顶层错误码的话，用户知道保存失败但不知道是哪一步。
顶层 code 分开（`validation_error` / `unknown_element`）是为了让界面能说清
「格式有问题」和「元素找不到了」是两句不同的话——前者改命令，后者去元素库。
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel
from sqlalchemy import select

from app.core.errors import ApiError, Page, paginate, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.ui_test import schemas
from app.modules.ui_test.commands import validate_commands

# _user_names 住在 element_services：域内正向 import 是既有惯例（ui_element_update 走
# element_services、两文件共用 _ui_module 同法），契约 1 只禁跨领域模块。
from app.modules.ui_test.element_services import _user_names
from app.modules.ui_test.models import STATUS_RECYCLED, UiCase, UiElement
from app.modules.ui_test.module_services import _ui_module
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.visibility import assert_row_visible, visible_clause


def _issues_for(steps: Any) -> list[dict]:
    """live issues（纯 T4 validate；对任何输入都返回列表，绝不抛异常）。"""
    return validate_commands(steps if steps is not None else [])


def _element_ids(steps: Any) -> list[str]:
    """steps 里出现过的 element_id（去重、保序）。非 list / 非 dict 步一律跳过：
    畸形结构由协议门负责报，这里不能因为脏数据抛异常。"""
    if not isinstance(steps, list):
        return []
    out: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        eid = step.get("element_id")
        if isinstance(eid, str) and eid != "" and eid not in out:
            out.append(eid)
    return out


async def _check_elements(db, project_id: str, steps: Any) -> None:
    """引用门：每个 element_id 必须存在、属于本项目、未回收。否则 422 unknown_element。

    跨项目的 id 与不存在的 id **同一个码同一句文案**（与 404 不泄露存在性同尺）：
    区分它们等于向别的项目的探测者确认「这个 id 在别处存在」。
    已回收单独给一句——「元素在回收站里，恢复它或改用别的」比「不存在」有用得多，
    而且它是真实存在的状态（元素回收时用例还留着引用；删元素那条路已被 R106 拦住，
    但先删用例引用再回收的路径仍然能把用例留成悬空引用）。
    """
    ids = _element_ids(steps)
    if not ids:
        return
    rows = (await db.execute(select(UiElement).where(
        UiElement.project_id == project_id, UiElement.id.in_(ids)))).scalars().all()
    found = {e.id: e for e in rows}
    missing = [i for i in ids if i not in found]
    recycled = [e for e in found.values() if e.status == STATUS_RECYCLED]
    if not missing and not recycled:
        return
    issues: list[dict] = []
    steps_list = steps if isinstance(steps, list) else []
    for idx, step in enumerate(steps_list):
        eid = step.get("element_id") if isinstance(step, dict) else None
        if isinstance(eid, str) and (eid in missing or eid in {r.id for r in recycled}):
            in_bin = any(r.id == eid for r in recycled)
            name = next((r.name for r in recycled if r.id == eid), eid)
            issues.append({"index": idx, "code": "unknown_element",
                           "message": ("元素「" + name + "」在回收站里：先恢复它，或在这一步改用别的元素"
                                       if in_bin else
                                       "element_id " + eid + " 在本项目里不存在（可能是别的项目的元素，"
                                       "或已被彻底删除）：这一步跑起来会找不到定位目标")})
    raise ApiError("unknown_element",
                   "有 " + str(len(missing) + len(recycled)) + " 个元素引用指向不到的元素：先在元素库处理，"
                   "再来保存用例", 422, {"issues": issues})


def _case_out(c: UiCase, issues: list[dict] | None = None,
              updated_by_name: str | None = None) -> schemas.UiCaseOut:
    return schemas.UiCaseOut(
        id=c.id, project_id=c.project_id, module_id=c.module_id, name=c.name,
        priority=c.priority, enabled=bool(c.enabled), steps=list(c.steps or []),
        env_id=c.env_id, owner_id=c.owner_id, project_public=c.project_public,
        status=c.status, step_count=c.step_count, last_run_at=schemas.iso(c.last_run_at),
        last_run_status=c.last_run_status, updated_by=c.updated_by,
        updated_by_name=updated_by_name,
        created_at=schemas.iso(c.created_at), updated_at=schemas.iso(c.updated_at),
        issues=issues if issues is not None else _issues_for(c.steps),
    )


async def _case(db, project_id: str, case_id: str) -> UiCase:
    c = (await db.execute(select(UiCase).where(UiCase.id == case_id,
                                               UiCase.project_id == project_id))).scalar_one_or_none()
    if c is None:
        raise ApiError("not_found", "UI 用例不存在", 404, {"case_id": case_id})
    return c


async def _name_dup(db, project_id: str, name: str, exclude: str | None = None) -> None:
    """同项目同名（含回收站墓碑）→ 409。

    码用 `conflict` 而不是新造一个 `name_exists`：全库的重名冲突今天都是 `conflict`，
    连服务层漏检时兜底的 IntegrityError handler（errors.py:83-88）也回 `conflict`——
    同一个人同一个误操作，不能因为撞上唯一键的时机不同而看到两个错误码。
    「是不是重名」放在 details.name_exists 里给前端判。
    """
    stmt = select(UiCase).where(UiCase.project_id == project_id, UiCase.name == name)
    if exclude:
        stmt = stmt.where(UiCase.id != exclude)
    hit = (await db.execute(stmt)).scalars().first()
    if hit is None:
        return
    if hit.status == STATUS_RECYCLED:
        raise ApiError("conflict", "同名用例在回收站里占着名字：先恢复它，或者彻底删除它", 409,
                       {"name": name, "name_exists": True, "recycled": True})
    raise ApiError("conflict", "UI 用例名已存在", 409, {"name": name, "name_exists": True})


async def _gate(db, project_id: str, steps: Any) -> int:
    """两道保存门，返回 step_count（冗余列，列表不 N+1）。"""
    issues = _issues_for(steps)
    if issues:
        raise ApiError("validation_error",
                       "UI 用例校验未通过：共 " + str(len(issues)) + " 个命令问题", 422,
                       {"issues": issues})
    await _check_elements(db, project_id, steps)
    return len(steps) if isinstance(steps, list) else 0


# D213：UI 用例列表的可筛面（D47-a 三件套从 api/plan 铺到 ui_case 页）。字段全是
# ui_case 上真实存在的业务列；project_id / status 之外的取数开关（cursor/current/
# recycled/module_id/unfiled_only）仍是顶层参数——它们一个管可见性、一个管视图，
# 进了 filter 就等于让两套开关抢同一个名字。
UI_CASE_LIST_FILTER = ListViewFilter(
    view_type="ui_case",
    label="UI 用例",
    fields={
        "name": FieldDecl(UiCase.name, "text", "用例名称", nullable=False),
        "priority": FieldDecl(UiCase.priority, "enum", "优先级", nullable=False),
        "enabled": FieldDecl(UiCase.enabled, "bool", "是否启用", nullable=False),
        "module_id": FieldDecl(UiCase.module_id, "id", "所属模块"),
        "env_id": FieldDecl(UiCase.env_id, "id", "所属环境"),
        "owner_id": FieldDecl(UiCase.owner_id, "id", "负责人"),
        "step_count": FieldDecl(UiCase.step_count, "number", "步骤数", nullable=False),
        "last_run_at": FieldDecl(UiCase.last_run_at, "time", "最近执行时间"),
        "last_run_status": FieldDecl(UiCase.last_run_status, "enum", "最近执行结果"),
        "updated_by": FieldDecl(UiCase.updated_by, "id", "更新人"),
        "created_at": FieldDecl(UiCase.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(UiCase.updated_at, "time", "更新时间", nullable=False),
    },
)
register(UI_CASE_LIST_FILTER)


@service(
    perm="ui:case:read", effect="read", name="ui_case_list",
    description="列出项目下的 UI 用例（默认不含回收站；§11.5.4 六列的最近结果读冗余列，不 N+1 查 run_record）",
    http={"method": "GET", "path": "/ui-cases", "tags": ["ui"]},
)
async def ui_case_list(payload: schemas.UiCaseListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:read")
    assert ctx.db is not None
    stmt = select(UiCase).where(UiCase.project_id == payload.project_id,
                                visible_clause(UiCase, ctx),
                                UiCase.status == (STATUS_RECYCLED if payload.recycled else "normal"),
                                UI_CASE_LIST_FILTER.parse(payload.filter))
    if payload.unfiled_only:
        stmt = stmt.where(UiCase.module_id.is_(None))
    elif payload.module_id:
        stmt = stmt.where(UiCase.module_id == payload.module_id)
    stmt = stmt.order_by(UiCase.id)
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
        page = await paginate(ctx.db, stmt, cursor_col=UiCase.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    # last_run_at/last_run_status 是 ui_case 行上的冗余列（终态回写），这里一条 SELECT
    # 都不额外发：照 scenario_list 的做法。「最近结果」查运行表会让列表页随运行数线性变慢。
    # updated_by_name 是唯一的例外：出结果之后一次 IN 小查询补人名（与元素列表同法，
    # 不动 paginate 的键集游标），§11.4.18 回收站的「删除人」列读它。
    names = await _user_names(ctx.db, {c.updated_by for c in page.items if c.updated_by})
    return Page(items=[_case_out(c, issues=[], updated_by_name=names.get(c.updated_by or ""))
                       for c in page.items], next_cursor=page.next_cursor, total=page.total)


@service(
    perm="ui:case:create", effect="write", name="ui_case_create",
    description="创建 UI 用例（steps 过 §7.2 协议校验 + 元素引用完整性：不过 → 422；同项目重名 409）",
    http={"method": "POST", "path": "/ui-cases", "tags": ["ui"], "status": 201},
)
async def ui_case_create(payload: schemas.UiCaseCreateIn, ctx) -> schemas.UiCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:create")
    assert ctx.db is not None
    if payload.module_id is not None:
        await _ui_module(ctx.db, payload.project_id, payload.module_id)
    await _name_dup(ctx.db, payload.project_id, payload.name)
    # steps 缺省 = None → 协议门给 empty_steps（"空用例跑起来零步全绿是假绿"）。
    # 刻意不给默认 []：那会把「前端忘了传」和「用户真存了空序列」混成同一句话。
    count = await _gate(ctx.db, payload.project_id, payload.steps)
    c = UiCase(project_id=payload.project_id, module_id=payload.module_id, name=payload.name,
               priority=payload.priority, enabled=1 if payload.enabled else 0,
               steps=list(payload.steps or []), env_id=payload.env_id, owner_id=ctx.user_id,
               project_public=payload.project_public, step_count=count, updated_by=ctx.user_id)
    ctx.db.add(c)
    await ctx.db.commit()
    return _case_out(c, issues=[])


@service(
    perm="ui:case:read", effect="read", name="ui_case_get",
    description="获取 UI 用例详情（含 live issues：打开老用例就看得见校验问题，不必等保存 422）",
    http={"method": "GET", "path": "/ui-cases/{case_id}", "tags": ["ui"]},
)
async def ui_case_get(payload: schemas.UiCaseGetIn, ctx) -> schemas.UiCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:read")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "UI 用例不存在（在回收站）", 404, {"case_id": c.id})
    return _case_out(c)


@service(
    perm="ui:case:update", effect="write", name="ui_case_update",
    description="更新 UI 用例（改 steps 时重过两道门并重算 step_count；无乐观锁，R104 与 ApiCase 对齐）",
    http={"method": "PATCH", "path": "/ui-cases/{case_id}", "tags": ["ui"]},
)
async def ui_case_update(payload: schemas.UiCaseUpdateIn, ctx) -> schemas.UiCaseOut:
    """**没有 version 乐观锁**（R104，业主裁决）：与 ApiCase 同档，后写覆盖先写。

    代价说清楚：两个人同时编辑同一条用例，后保存的会静默覆盖前一个人的命令序列。
    1C 的用例编辑是单人短会话场景，加锁要把 version 透到画布每个保存动作上；
    真要做是独立批次的事（`test_ui_models.py::test_ui_case_has_no_version_column` 钉着
    这个决定，防止有人「顺手补个乐观锁更严谨」把裁决改掉而不说。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "UI 用例不存在（在回收站，请先恢复）", 404, {"case_id": c.id})
    if payload.name is not None and payload.name != c.name:
        await _name_dup(ctx.db, payload.project_id, payload.name, exclude=c.id)
        c.name = payload.name
    if payload.priority is not None:
        c.priority = payload.priority
    if payload.enabled is not None:
        c.enabled = 1 if payload.enabled else 0
    if payload.module_set:
        if payload.module_id is not None:
            await _ui_module(ctx.db, payload.project_id, payload.module_id)
        c.module_id = payload.module_id
    if payload.env_set:
        # 与 scenario 一致：环境**不在保存期校验**，跑的时候才解析（env_resolve 失败=跑不了，
        # 不是存不了）。存期拦环境等于把「先存草稿、环境还没建好」的正常顺序堵死。
        c.env_id = payload.env_id
    if payload.steps_set:
        c.step_count = await _gate(ctx.db, payload.project_id, payload.steps)
        c.steps = list(payload.steps or [])
    if payload.project_public is not None:
        c.project_public = payload.project_public
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    return _case_out(c, issues=[])


def _blocked(ref: dict, *, action: str, case_id: str) -> ApiError:
    """把「被场景引用」拼成给用户看的 409（与 adb_test / api_test 的 _blocked 同口径）：
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
    perm="ui:case:delete", effect="destructive", name="ui_case_delete",
    description="把 UI 用例放入回收站（软删；已回收再删 404；被未回收场景引用时 409 并列出引用者，确认要连带断掉这些步骤才带 force）",
    http={"method": "POST", "path": "/ui-cases/{case_id}/delete", "tags": ["ui"]},
    resident=False,
)
async def ui_case_delete(payload: schemas.UiCaseDeleteIn, ctx) -> BaseModel:
    """1C T10 接上场景引用拦截（与 adb_case_delete / api_case_delete 同款 force 两段式）。

    T6 时这里刻意不写：BLOCKED_1B 让场景存不下 ui_case 节点，恒为 0 的保护是
    §13 纪律 1 禁止的假门。T10 摘插槽（graph.py:25 清空）后通道真出数
    （ui_case_refs），保护随之生效——ADB 侧在 1D T8 记过同一笔账，UI 这边欠到今天。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:delete")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status != "normal":
        raise ApiError("not_found", "UI 用例不存在", 404, {"case_id": c.id})
    # 先查引用再改状态：409 必须是一条什么都没改的失败（否则重试看到的就是「已回收」）
    ref = (await _scenario_refs(ctx, payload.project_id, [c.id])).get(c.id)
    # force 只放行「已经看见引用清单」的人：明细被隐瞒时 force 同样拦下——
    # 他不知道该断的是谁的步骤，一键下去坏的是别人的场景。
    if ref and (not payload.force or ref["hidden"]):
        raise _blocked(ref, action="回收", case_id=c.id)
    c.status = STATUS_RECYCLED
    # 回收这次写操作落 updated_by：§11.4.18 回收站「删除人」列读的就是它。
    # 不写则列上挂着上一个编辑人（B 改过、A 删的 → 显示 B），而「删除时间」靠
    # updated_at onupdate 已经跟上了——时间与人对不上是更难查的半错（与元素同法）。
    c.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="ui:case:update", effect="write", name="ui_case_restore",
    description="从回收站恢复 UI 用例（回收期间名字被占 → 409，不静默改名）",
    http={"method": "POST", "path": "/ui-cases/{case_id}/restore", "tags": ["ui"]},
    resident=False,
)
async def ui_case_restore(payload: schemas.UiCaseGetIn, ctx) -> schemas.UiCaseOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:update")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status != STATUS_RECYCLED:
        raise ApiError("not_found", "UI 用例不在回收站", 404, {"case_id": c.id})
    stmt = select(UiCase).where(UiCase.project_id == payload.project_id,
                                UiCase.name == c.name, UiCase.id != c.id,
                                UiCase.status == "normal")
    if (await ctx.db.execute(stmt)).scalars().first() is not None:
        raise ApiError("conflict", "回收期间这个名字已经被另一条用例占用：先处理它再恢复", 409,
                       {"name": c.name, "name_exists": True})
    # 恢复不做元素引用体检：里面可能有已被回收的元素（那是允许的，跑的时候 resolve 会说），
    # 也可能有已被彻底删除的元素（元素 purge 有 R106 硬拦，理论到不了这里）。
    # 在这里拦恢复等于把回收站变成一个需要元素库先健康的入口。
    c.status = "normal"
    await ctx.db.commit()
    return _case_out(c)


@service(
    perm="ui:case:delete", effect="destructive", name="ui_case_purge",
    description="彻底删除回收站中的 UI 用例（物理删除，不可恢复；须逐字确认用例名）",
    http={"method": "POST", "path": "/ui-cases/{case_id}/purge", "tags": ["ui"]},
    tool=False, resident=False,
)
async def ui_case_purge(payload: schemas.UiCasePurgeIn, ctx) -> BaseModel:
    """回收站出口（R53）：只有软删过的东西能到这里，且必须逐字确认名称。

    与 `ui_element_purge` 相反，这里**不**查引用：它自己引用的元素被删不影响这条用例
    被物理删除。它与 `adb_case_purge` 有一处已知分歧：ADB 侧 T8 给彻底删除接了
    「被场景引用 → 硬拦（回收 ≠ 解绑）」，UI 侧的删除保护这次只接了 `ui_case_delete`
    一段——被 force 回收的用例在这里还能物理删掉，把场景步骤留成悬空。是补同款硬拦
    还是裁决保留出口，等业主定，别顺手改（改了 test_golden_1c 的 force 回收链要先解绑）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:delete")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的用例：请先放入回收站", 409,
                       {"case_id": c.id})
    if payload.confirm_name != c.name:
        raise ApiError("name_mismatch", "确认名称与用例名不一致，未删除", 409, {"case_id": c.id})
    await ctx.db.delete(c)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="ui:case:read", effect="read", name="ui_case_references",
    description="查引用这条 UI 用例的未回收场景（含命中步骤 key；供用例详情「场景引用」Tab）",
    http={"method": "GET", "path": "/ui-case-references", "tags": ["ui"]},
)
async def ui_case_references(payload: schemas.UiCaseReferencesIn, ctx) -> schemas.UiCaseReferencesOut:
    """HTTP 面是**单条查询**（scalar case_id），批量口径在内部件 `ui_case_refs`。

    为什么不是 GET + `case_ids=[...]`：路由是注册表的投影，`core/service.py:262-270`
    把 GET 的 payload 字段摊成 query 参数，而 FastAPI 把 required 的 list 当 **body**——
    写出来会是「路由存在但永远 422 body required」。这与 1B 的分工完全同构：
    `scenario_references`（GET 单查，给界面）+ `scenario_case_refs`（批量，给删除保护）。
    """
    if not payload.case_id:
        raise ApiError("validation_failed", "case_id 必填", 422)
    found = await _scenario_refs(ctx, payload.project_id, [payload.case_id])
    ref = found.get(payload.case_id)
    if not ref:
        return schemas.UiCaseReferencesOut(items=[], details_hidden=False)
    # 明细可见性：没有 scenario:read 时数量照报、名字不说（与 scenario_references 同尺）
    items = [] if ref["hidden"] else [
        schemas.ScenarioRefItem(scenario_id=i["scenario_id"], scenario_name=i["scenario_name"],
                                step_keys=list(i["step_keys"]), sort=i.get("sort") or "P2")
        for i in ref["scenarios"]]
    return schemas.UiCaseReferencesOut(items=items, details_hidden=bool(ref["hidden"]))


@service(
    perm="ui:case:read", effect="read", name="ui_case_refs",
    description="批量查引用这些用例的未回收场景（供 T10 删除保护内部调用；"
                "无 scenario:read 时数量照报、明细隐瞒）",
    http=None, tool=False, resident=False,
)
async def ui_case_refs(payload: schemas.UiCaseRefsIn, ctx) -> schemas.UiCaseRefsOut:
    """T10 的 `ui_case` 步骤删除保护走这里（与 `ui_element_refs` 同款三点分歧）。"""
    if not payload.case_ids:
        return schemas.UiCaseRefsOut(groups=[])
    found = await _scenario_refs(ctx, payload.project_id, list(payload.case_ids))
    groups = [schemas.UiCaseRefGroup(
        case_id=cid, count=ref["count"],
        items=[schemas.ScenarioRefItem(scenario_id=i["scenario_id"], scenario_name=i["scenario_name"],
                                       step_keys=list(i["step_keys"]), sort=i.get("sort") or "P2")
               for i in ref["scenarios"]] if not ref["hidden"] else [])
        for cid, ref in sorted(found.items()) if ref["count"]]
    return schemas.UiCaseRefsOut(groups=groups,
                                 details_hidden=bool(any(r["hidden"] for r in found.values())))


async def _scenario_refs(ctx, project_id: str, case_ids: list[str]) -> dict[str, dict]:
    """跨模块问「这些 UI 用例被哪些未回收场景当一步」：只经注册表调 `scenario_case_refs`（契约 1）。

    `scenario_case_refs` 把非 `api_case` 步骤的 `ref` 当作 definition_ids 匹配
    （`scenario/services.py:392`）——`ui_case` 步骤的 ref 就是 UI 用例 id（T10 的
    `ui_case_resolve` 入参就是 case_id），所以走 definition_ids 这个通道是对的。
    名字读起来别扭（用例走"定义"通道）是 1B 留下的形状，`test_ui_case.py` 里那条
    直插 step_graph 的测试钉住了这个耦合，T10 改不动它而不红。

    未注册时按「零引用」放行是不可接受的：那等于注册顺序悄悄决定删除保护生不生效
    （`api_test/case_services.py:89-103` 的同一口径）。

    1C T10 起真出数：`graph.BLOCKED_1B` 清空后场景保存能收下 `ui_case` 节点，
    本通道零改动自动开始匹配（`ui_case_delete` 的保护与 test_ui_case.py 的 HTTP
    保存路径钉住出数；ADB 侧 1D T8 走的是同一通道、同一形状）。
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
