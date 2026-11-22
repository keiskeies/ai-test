"""元素库 @service（§11.4.11 / §11.5.4 / R106）：CRUD + 回收站三件套 + 引用检测。

三条本模块特有的判断，都各有一条测试钉着：

**1. `used_by` 与删除拦截同源。** 列表列「关联用例数」和 delete 该不该 409 走的是
同一个 `_scan_element_refs` 调用（列表页每页一次批量扫，不是每行一次）。分成两套算法
就会出现「徽标说 0 条、删除弹 409」——§11.5.4 那个界面能造成的最坏误导。

**2. 引用扫描不看可见性，只有「能不能说出名字」看。** 别人的私有用例指着这个元素，
删了它照样是坏的；可见性只决定明细说不说得出（`details_hidden`）。与
`scenario.services._scan_refs` 的同一判断（R106）。

**3. 元素 purge 也硬拦引用**，不沿用场景「回收拦、彻底删除也拦但先要输名」的两档：
元素被物理删除后，引用它的用例里那个 `element_id` 永久指不到东西，用例只能在执行期炸
（`ui_case_resolve` 会回 executable=False），而用例作者甚至不知道少了什么。用例是资产、
元素也是资产（R99 口径），没有「先毁资产再问名字」的道理。
"""
from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy import column, select, table

from app.core.errors import ApiError, Page, paginate, paginate_page
from app.core.permissions import match_perm
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.ui_test import schemas
from app.modules.ui_test.models import STATUS_RECYCLED, UiCase, UiElement
from app.modules.ui_test.module_services import _ui_module
from app.shared.filters import _like
from app.shared.visibility import assert_row_visible, visible_clause

# 表名 join（不 import iam.models，也不跨模块 import workbench——契约 1 领域模块零横向）。
# 形状照 workbench/model_usage.py:46 与 execution/timefmt.py:13：同一段 3 列小表反射，
# 各自域内留一份，重复三处是这套契约的既定代价，抽 shared 反而要动已交付面。
APP_USER = table("app_user", column("id"), column("name"))


async def _user_names(db, user_ids: set[str]) -> dict[str, str]:
    """id → 人名，一次 IN 查询（照 workbench/model_usage._user_names 的形状抄一份）。

    查不到的人**根本不出现在 dict 里**：调用方拿到 None 画「—」，绝不许拿 user id
    冒充人名——uuid 摊进「删除人」列比画个破折号更误导（读的人会以为那是个名字）。
    """
    if not user_ids:
        return {}
    return {
        r[0]: r[1] for r in (await db.execute(
            select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(sorted(user_ids)))
        )).all()
    }


def _el_out(e: UiElement, used_by: int = 0, updated_by_name: str | None = None) -> schemas.UiElementOut:
    return schemas.UiElementOut(
        id=e.id, project_id=e.project_id, module_id=e.module_id, name=e.name,
        locator_type=e.locator_type, locator=e.locator, comment=e.comment,
        owner_id=e.owner_id, project_public=e.project_public, status=e.status,
        updated_by=e.updated_by, updated_by_name=updated_by_name,
        created_at=schemas.iso(e.created_at), updated_at=schemas.iso(e.updated_at),
        used_by=used_by,
    )


async def _element(db, project_id: str, element_id: str) -> UiElement:
    """按 (id, project_id) 取行；跨项目 → 404 与不存在同码同文案（不泄露存在性）。"""
    e = (await db.execute(select(UiElement).where(UiElement.id == element_id,
                                                  UiElement.project_id == project_id))).scalar_one_or_none()
    if e is None:
        raise ApiError("not_found", "元素不存在", 404, {"element_id": element_id})
    return e


async def _name_dup(db, project_id: str, name: str, exclude: str | None = None) -> None:
    """同项目同名（**含回收站墓碑**）→ 409 name_exists，文案给出口。

    元素是扁平命名空间（uq_ui_element_project_name 不含 module_id），所以这里不查
    parent/module。放过墓碑行会在回收站和正常列表里同时出现两个同名元素，
    引用检测的用例清单就成了谜题（谁引用的是哪一个？）。
    """
    stmt = select(UiElement).where(UiElement.project_id == project_id, UiElement.name == name)
    if exclude:
        stmt = stmt.where(UiElement.id != exclude)
    hit = (await db.execute(stmt)).scalars().first()
    if hit is None:
        return
    if hit.status == STATUS_RECYCLED:
        raise ApiError("conflict", "同名元素在回收站里占着名字：先恢复它，或者彻底删除它", 409,
                       {"name": name, "name_exists": True, "recycled": True})
    raise ApiError("conflict", "元素名已存在", 409, {"name": name, "name_exists": True})


async def _scan_element_refs(db, project_id: str,
                             element_ids: set[str]) -> dict[str, list[schemas.UiCaseRefItem]]:
    """一趟扫完全项目**未回收** UI 用例，按 element_id 归组。回收的用例不算引用。

    回收的不算：回收站是「已经决定不要了」的暂存区，把它计成引用会让「先把那条用例
    扔了再来删元素」变成不可能完成的任务（T5 Step 1 ③ 钉的就是这条）。
    内存里数而不是 SQL JSON 函数：steps 是 JSON 列，MySQL 的 JSON_SEARCH 写法在
    SQLite/MySQL 之间不可移植，而且一个项目的 UI 用例量级本来就该整表扫（与
    `scenario._scan_refs` 全表扫 step_graph 同一取舍）。
    """
    out: dict[str, list[schemas.UiCaseRefItem]] = {}
    if not element_ids:
        return out
    rows = (await db.execute(
        select(UiCase).where(UiCase.project_id == project_id, UiCase.status == "normal")
    )).scalars().all()
    for c in rows:
        steps = c.steps if isinstance(c.steps, list) else []
        hits: dict[str, list[int]] = {}
        for idx, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            eid = step.get("element_id")
            if isinstance(eid, str) and eid in element_ids:
                hits.setdefault(eid, []).append(idx)
        for eid, indexes in hits.items():
            bucket = out.setdefault(eid, [])
            # 同一用例多处引用同一元素只出一条，index 合并（按用例一行才读得懂）
            found = next((i for i in bucket if i.case_id == c.id), None)
            if found is None:
                bucket.append(schemas.UiCaseRefItem(case_id=c.id, case_name=c.name,
                                                    step_indexes=sorted(indexes),
                                                    sort=c.priority or "P2"))
            else:
                found.step_indexes = sorted(set(found.step_indexes + indexes))
    for bucket in out.values():
        bucket.sort(key=lambda x: (x.sort, x.case_id))
    return out


async def _guard_delete(db, ctx, project_id: str, element: UiElement, *, action: str) -> None:
    """引用硬拦（R106）。delete / purge 两条路共用，409 的 details.cases 直接给清单。

    明细可见性：调用方没有 `ui:case:read` 时**数量照报、名字不说**（details_hidden）。
    「拦住了但说不清被谁拦」是必要的诚实——那人的用例可能是私有的，
    但删掉元素照样会把它弄坏，所以保护照常生效。
    """
    found = await _scan_element_refs(db, project_id, {element.id})
    items = found.get(element.id) or []
    if not items:
        return
    may_see = match_perm(ctx.perms, "ui:case:read")
    # 两句「说一半」的诚实，都只加文案不动行为：
    # ① 回收站口径 —— _scan_element_refs 只数 normal 用例（:105，刻意的：回收站是
    #    「已决定不要了」的暂存区，数进来会让删除永远做不到）。照 N 条解完绑删除会成功，
    #    而回收站里那条一恢复就悬空引用、执行期才炸，所以「回收 ≠ 解绑」必须此刻说出口
    #    （与 api_test/case_services.py:127 同一条口径）。
    # ② 明细可见性 —— 无 ui:case:read 时数量照报、名字隐瞒（本文件 :134 的既有纪律，
    #    scenario/services.py:475 同款），「名单在哪、要什么权限」不说，用户会以为没人名。
    tail = "（回收站里的用例也一样：回收 ≠ 解绑，那里的引用没算进这个数量）"
    if not may_see:
        tail += "；用例名单需要 ui:case:read 权限，请联系有该权限的成员解引用"
    raise ApiError("referenced_by_case",
                   "这个元素还被 " + str(len(items)) + " 条 UI 用例用着，先在用例里解引用再来"
                   + ("（" + action + "）" if action else "") + tail,
                   409,
                   {"cases": [{"id": i.case_id, "name": i.case_name, "step_indexes": i.step_indexes}
                              for i in items] if may_see else [],
                    "referenced_by": len(items),
                    "details_hidden": not may_see})


@service(
    perm="ui:element:read", effect="read", name="ui_element_list",
    description="列出项目下的元素（默认不含回收站；recycled=true 只看已回收；"
                "used_by=未回收 UI 用例引用数，与删除拦截同源，批量一次算不 N+1）",
    http={"method": "GET", "path": "/ui-elements", "tags": ["ui"]},
)
async def ui_element_list(payload: schemas.UiElementListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:element:read")
    assert ctx.db is not None
    stmt = select(UiElement).where(UiElement.project_id == payload.project_id,
                                   visible_clause(UiElement, ctx),
                                   UiElement.status == (STATUS_RECYCLED if payload.recycled else "normal"))
    if payload.unfiled_only:
        stmt = stmt.where(UiElement.module_id.is_(None))
    elif payload.module_id:
        stmt = stmt.where(UiElement.module_id == payload.module_id)
    # D47-b 步 5c 的两路下推谓词，形态逐字照步 4a 的 api_definition_list；口径差异在
    # schemas.UiElementListIn 的注释里说清：**直属**，这一刀不翻子树、徽标一行没动。
    # - module_ids：None = 不加这一路；[] = `IN (NULL)`，对任何行都不成立——含 module_id
    #   IS NULL 的未分类行，空集就是空集。
    # - keyword：只打 name 一列。单列 LIKE 本身就是一个谓词，不存在步 4a 那个「OR 逃出
    #   括号」的问题，所以这里没有 or_/self_group 可用武之地。转义复用 filters._like +
    #   ESCAPE '\\'：用户敲的 %/_ 是字面量；大小写不敏感由 utf8mb4_0900_ai_ci 提供
    #   （步 4 已取证）。全空白 = 没筛选；strip 后的词进 LIKE（用户看不见也删不掉的
    #   两端空白不进入匹配，api 页同款坑）。
    if payload.module_ids is not None:
        stmt = stmt.where(UiElement.module_id.in_(payload.module_ids))
    if payload.keyword and payload.keyword.strip():
        kw = payload.keyword.strip()
        stmt = stmt.where(UiElement.name.like(f"%{_like(kw)}%", escape="\\"))
    stmt = stmt.order_by(UiElement.id)
    # D47-b 步 5c：cursor 与 current 二选一（逐字照姊妹刀 ui_case_list 步 5a）。
    # 「我在哪」的两套真相一起到场是调用方的 bug，静默择一会把错位藏进翻页里，所以大声 400。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在**同一条已排序 stmt** 上 OFFSET：ORDER BY 与键集逐字同一条（判据 5），
        # 且 total 与 items 吃同一份 WHERE——筛选在前、数数在后（MS 的 PageHelper 同构）。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate(ctx.db, stmt, cursor_col=UiElement.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    # 一次批量扫拿全页 used_by：每行单独扫是 N+1，各自另写一套计数则迟早与 409 分叉
    used = await _scan_element_refs(ctx.db, payload.project_id, {e.id for e in page.items})
    # 出结果之后再补一次小查询取人名（照 model_usage 的「分页/过滤后再回填」手法，
    # 不改 paginate 的键集游标——改 join 会把 items 从 model 变 tuple，与本端点无关）。
    # 正常视图也带这个字段是刻意的：字段语义随视图变（回收站=删除人，正常行=最后编辑人），
    # 变的是**列的标题与出现与否**（前端只在回收站视图渲染），不是数字本身。
    names = await _user_names(ctx.db, {e.updated_by for e in page.items if e.updated_by})
    return Page(items=[_el_out(e, used_by=len(used.get(e.id) or []),
                               updated_by_name=names.get(e.updated_by or ""))
                       for e in page.items],
                next_cursor=page.next_cursor, total=page.total)


@service(
    perm="ui:element:create", effect="write", name="ui_element_create",
    description="新建元素（同项目重名含回收站墓碑 → 409 name_exists；定位器类型限 5 种，R100/D2）",
    http={"method": "POST", "path": "/ui-elements", "tags": ["ui"], "status": 201},
)
async def ui_element_create(payload: schemas.UiElementCreateIn, ctx) -> schemas.UiElementOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:element:create")
    assert ctx.db is not None
    if payload.module_id is not None:
        await _ui_module(ctx.db, payload.project_id, payload.module_id)
    await _name_dup(ctx.db, payload.project_id, payload.name)
    e = UiElement(project_id=payload.project_id, module_id=payload.module_id, name=payload.name,
                  locator_type=payload.locator_type, locator=payload.locator,
                  comment=payload.comment, owner_id=ctx.user_id,
                  project_public=payload.project_public, updated_by=ctx.user_id)
    ctx.db.add(e)
    await ctx.db.commit()
    return _el_out(e)


@service(
    perm="ui:element:read", effect="read", name="ui_element_get",
    description="获取元素详情（回收站中的元素 404；used_by 与删除拦截同源）",
    http={"method": "GET", "path": "/ui-elements/{element_id}", "tags": ["ui"]},
)
async def ui_element_get(payload: schemas.UiElementGetIn, ctx) -> schemas.UiElementOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:element:read")
    assert ctx.db is not None
    e = await _element(ctx.db, payload.project_id, payload.element_id)
    assert_row_visible(e, ctx, what="元素不存在")
    if e.status == STATUS_RECYCLED:
        raise ApiError("not_found", "元素不存在（在回收站）", 404, {"element_id": e.id})
    used = await _scan_element_refs(ctx.db, payload.project_id, {e.id})
    return _el_out(e, used_by=len(used.get(e.id) or []))


@service(
    perm="ui:element:update", effect="write", name="ui_element_update",
    description="改元素（改名/定位器/备注/移动模块/可见性）。**有引用时改 locator_type 或 locator "
                "→ 409 referenced_by_case**：用例的 steps 不存定位器副本，改了等于静默改写别人的用例",
    http={"method": "PATCH", "path": "/ui-elements/{element_id}", "tags": ["ui"]},
)
async def ui_element_update(payload: schemas.UiElementUpdateIn, ctx) -> schemas.UiElementOut:
    """两处引用检测（R106 点名的两条路）：delete 与「改定位器」。

    改定位器为什么也要拦：`ui_case.steps` 只存 `element_id`，**不存定位器快照**
    （T6 的 `ui_case_resolve` 才在执行时解析）。所以改一个被引用的元素 = 把所有引用它
    的用例的定位器一起改掉，而且没有任何一处会提示。这与改 `locator_type` 是同一件事
    ——换类型（css → xpath）比换表达式的破坏性更大，两者一起改更是常见误操作，
    所以两条一起拦，不玩「改表达式放过、改类型才拦」那种读起来别扭的区分。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:element:update")
    assert ctx.db is not None
    e = await _element(ctx.db, payload.project_id, payload.element_id)
    assert_row_visible(e, ctx, what="元素不存在")
    if e.status == STATUS_RECYCLED:
        raise ApiError("not_found", "元素不存在（在回收站，请先恢复）", 404, {"element_id": e.id})
    changing_locator = ((payload.locator_type is not None and payload.locator_type != e.locator_type)
                        or (payload.locator is not None and payload.locator != e.locator))
    if changing_locator:
        await _guard_delete(ctx.db, ctx, payload.project_id, e, action="改定位器会让引用它的用例改指向")
    if payload.name is not None and payload.name != e.name:
        await _name_dup(ctx.db, payload.project_id, payload.name, exclude=e.id)
        e.name = payload.name
    if payload.locator_type is not None:
        e.locator_type = payload.locator_type
    if payload.locator is not None:
        e.locator = payload.locator
    if payload.comment is not None:
        e.comment = payload.comment
    if payload.module_set:
        if payload.module_id is not None:
            await _ui_module(ctx.db, payload.project_id, payload.module_id)
        e.module_id = payload.module_id
    if payload.project_public is not None:
        e.project_public = payload.project_public
    e.updated_by = ctx.user_id
    await ctx.db.commit()
    return _el_out(e)


@service(
    perm="ui:element:delete", effect="destructive", name="ui_element_delete",
    description="把元素放入回收站（软删；被未回收 UI 用例引用 → 409 referenced_by_case + 用例清单，R106）",
    http={"method": "POST", "path": "/ui-elements/{element_id}/delete", "tags": ["ui"]},
    resident=False,
)
async def ui_element_delete(payload: schemas.UiElementGetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:element:delete")
    assert ctx.db is not None
    e = await _element(ctx.db, payload.project_id, payload.element_id)
    assert_row_visible(e, ctx, what="元素不存在")
    if e.status != "normal":
        raise ApiError("not_found", "元素不存在", 404, {"element_id": e.id})
    # 与场景删除的差别：场景删了只是收不起来，元素删了**引用它的用例会在执行期炸**
    # （steps 里只剩一个指不到东西的 element_id），所以这里必须硬拦而不是提示（R106）。
    await _guard_delete(ctx.db, ctx, payload.project_id, e, action="回收后引用它的用例会跑不起来")
    e.status = STATUS_RECYCLED
    # 回收这次写操作也要落 updated_by：§11.4.18 回收站的「删除人」读的就是这一列。
    # 不落库的话列上挂着的是**上一个编辑人**——B 改过、A 删的，列会说「B 删的」，
    # 而这条软删恰恰是 A 按的钮（「删除时间」靠 updated_at 的 onupdate 自动跟上了，
    # 操作者不跟就是半对半错，比全错更难查）。
    e.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="ui:element:update", effect="write", name="ui_element_restore",
    description="从回收站恢复元素（同名已被别人占走 → 409 name_exists，不静默改名）",
    http={"method": "POST", "path": "/ui-elements/{element_id}/restore", "tags": ["ui"]},
    resident=False,
)
async def ui_element_restore(payload: schemas.UiElementGetIn, ctx) -> schemas.UiElementOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:element:update")
    assert ctx.db is not None
    e = await _element(ctx.db, payload.project_id, payload.element_id)
    assert_row_visible(e, ctx, what="元素不存在")
    if e.status != STATUS_RECYCLED:
        raise ApiError("not_found", "元素不在回收站", 404, {"element_id": e.id})
    # 墓碑期间可能有人建了同名元素（墓碑占名的另一侧：墓碑让新建撞名，这里让恢复撞名）。
    # 静默改名会让引用清单和用户的记忆分叉，所以给 409 让人自己处理。
    stmt = select(UiElement).where(UiElement.project_id == payload.project_id,
                                   UiElement.name == e.name, UiElement.id != e.id,
                                   UiElement.status == "normal")
    if (await ctx.db.execute(stmt)).scalars().first() is not None:
        raise ApiError("conflict", "回收期间这个名字已经被另一个元素占用：先处理它再恢复", 409,
                       {"name": e.name, "name_exists": True})
    e.status = "normal"
    await ctx.db.commit()
    return _el_out(e)


@service(
    perm="ui:element:delete", effect="destructive", name="ui_element_purge",
    description="彻底删除回收站中的元素（物理删除；被引用同样硬拦；须逐字确认元素名）",
    http={"method": "POST", "path": "/ui-elements/{element_id}/purge", "tags": ["ui"]},
    tool=False, resident=False,
)
async def ui_element_purge(payload: schemas.UiElementPurgeIn, ctx) -> BaseModel:
    """回收站出口（R53：只有软删过的东西能到这里，且必须逐字确认名称）。

    **与 scenario_purge 的有意分歧**：场景 purge 只校验「在回收站 + 输名」，元素 purge
    多一道引用硬拦。理由在文件头第 3 条——物理删掉一个被引用的元素，用例里那个
    `element_id` 永久指不到东西（软删还能靠恢复补救，物理删不行），
    而用例作者只会看到执行期一句「元素不存在」。输名确认挡不住这种损坏：
    名字打对了照样把 20 条用例一起毁掉。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:element:delete")
    assert ctx.db is not None
    e = await _element(ctx.db, payload.project_id, payload.element_id)
    assert_row_visible(e, ctx, what="元素不存在")
    if e.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的元素：请先放入回收站", 409,
                       {"element_id": e.id})
    if payload.confirm_name != e.name:
        raise ApiError("name_mismatch", "确认名称与元素名不一致，未删除", 409, {"element_id": e.id})
    await _guard_delete(ctx.db, ctx, payload.project_id, e, action="彻底删除后引用它的用例永久损坏")
    await ctx.db.delete(e)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="ui:case:read", effect="read", name="ui_element_refs",
    description="批量查引用这些元素的未回收 UI 用例（供删除保护内部调用；"
                "无 ui:case:read 时数量照报、明细隐瞒）",
    http=None, tool=False, resident=False,
)
async def ui_element_refs(payload: schemas.UiElementRefsIn, ctx) -> schemas.UiElementRefsOut:
    """删除保护的引用查询。照 `scenario_case_refs`（services.py:411-435）的三点分歧：

    ① 批量入参——一次删多个元素时逐个问是 N+1 次全用例扫；
    ② **不因缺 `ui:case:read` 而 403**——拦不拦由**数据**决定，不由查看引用所需的权限
       决定，否则一个没有用例权限的人反而能绕开保护直接删；
    ③ 无权限时 `details_hidden=True` 且明细为空——「查不到是谁」要说出口，
       不能退化成「没人引用」这种会让人误删的假安慰。
    """
    await ensure_project_access(ctx, payload.project_id)  # 只查归属，不 require ui:case:read
    assert ctx.db is not None
    found = await _scan_element_refs(ctx.db, payload.project_id, set(payload.element_ids))
    may_see = match_perm(ctx.perms, "ui:case:read")
    groups = [schemas.UiElementRefGroup(element_id=eid, count=len(items),
                                        items=items if may_see else [])
              for eid, items in sorted(found.items()) if items]
    return schemas.UiElementRefsOut(groups=groups,
                                    details_hidden=bool(not may_see and any(g.count for g in groups)))
