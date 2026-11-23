"""缺陷域 @service（D191：把 D190 裁定的 25 条可做端点接上线）。

口径来源是 `docs/2026-11-22-d190-defect-framediff.md` §4 的「可执行边界」。
本文件覆盖 24 个 @service（MS 的 `/bug/page` 与 `/bug/trash/page` 折叠成一个
`defect_list` + `recycled` 谓词，先例 = ui_case 列表）：

- 核心 10：list / create / update / get / exists / delete / batch_delete /
  batch_update / export_columns / export
- 回收站 4：restore / purge / batch_restore / batch_purge
- 关联 4：candidates / add / list / remove
- 评论 4：list / add / update / delete
- 关注 2：follow / unfollow

**主动不跟 MS 的病**（每条都在 D190 §5 有可复跑理由，这里落成代码）：
1. 写操作一律 POST + 写权限位（MS 的 follow/unfollow 是 GET + READ）。
2. 状态流转在写路径**真校验**，非法转移 409（MS 只拿边表渲染下拉框）。
3. 回收站恢复**清空** delete_user/delete_time（MS 把上一次删除留在行上）。
4. 彻底删除在一个事务里清干净三张子表（MS 只删主表，留下孤儿）。
5. 关联采用 DDL 唯一键判重（MS 代码层判重、两套口径可重复插）。

跨域取数一律**表名反射**，不 import 其他领域模块（import-linter 契约 1）：
用例候选/名称走 `CASE_TABLES`，用户名走 `APP_USER`。
"""
from __future__ import annotations

import csv
import io
from datetime import UTC, datetime

from sqlalchemy import column, func, or_, select, table
from sqlalchemy import delete as sa_delete

from app.core.errors import ApiError, Page, paginate_page
from app.core.registry import REGISTRY
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.defect import flow as defect_flow
from app.modules.defect import schemas
from app.modules.defect.models import (
    DEFECT_CASE_TYPES,
    Defect,
    DefectCaseLink,
    DefectComment,
    DefectCustomField,
    DefectFollower,
)
from app.shared.custom_fields import (
    CustomFieldError,
    dump_value,
    load_value,
    validate_custom_values,
)
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

# 反射表只带本文件用到的列（抄多列 = 对不存在的列写 SQL；抄错 = 运行期才炸）。
# 断言保证词表与反射表不分叉（testplan/services.py 同款 import 期大声失败）。
CASE_TABLES = {
    "api_case": table("api_case", column("id"), column("project_id"), column("name"), column("status")),
    "scenario": table("scenario", column("id"), column("project_id"), column("name"), column("status")),
    "ui_case": table("ui_case", column("id"), column("project_id"), column("name"), column("status")),
    "adb_case": table("adb_case", column("id"), column("project_id"), column("name"), column("status")),
    "functional_case": table(
        "functional_case", column("id"), column("project_id"), column("name"), column("status")
    ),
}
assert frozenset(CASE_TABLES) == frozenset(DEFECT_CASE_TYPES), \
    "CASE_TABLES 与 DEFECT_CASE_TYPES 分叉了：" + str(sorted(CASE_TABLES))

CASE_LABELS = {
    "api_case": "接口用例",
    "scenario": "场景",
    "ui_case": "UI 用例",
    "adb_case": "ADB 用例",
    "functional_case": "功能用例",
}
APP_USER = table("app_user", column("id"), column("name"), column("account"))

# D216：缺陷列表的可筛面（D47-a 三件套铺到缺陷页）。只收 defect 表上有读取方的业务列；
# 三个「轴」不进条件组：
# - `recycled` 是视图开关（与 MS 的 /bug/page 和 /bug/trash/page 折叠成同一端点同源），
#   进条件组会造出「recycled=false 的视图里再筛 recycled=true」这种自相矛盾；
# - `delete_user`/`delete_time` 只在回收站视图有意义，正常列表里恒空，做成条件就是假门；
# - `tag` / `keyword` 是顶层快捷筛选：tags 以逗号串存储，条件组只能 LIKE，
#   会复刻 D190 明令避免的「bug1 命中 bug10」；精确标签匹配留在顶层 find_in_set。
DEFECT_LIST_FILTER = ListViewFilter(
    view_type="defect",
    label="缺陷管理",
    fields={
        "num": FieldDecl(Defect.num, "number", "编号", nullable=False),
        "title": FieldDecl(Defect.title, "text", "标题", nullable=False),
        "status": FieldDecl(Defect.status, "enum", "状态", nullable=False),
        "priority": FieldDecl(Defect.priority, "enum", "优先级", nullable=False),
        "handle_user_id": FieldDecl(Defect.handle_user_id, "id", "处理人"),
        "template_id": FieldDecl(Defect.template_id, "id", "模板", nullable=False),
        "created_by": FieldDecl(Defect.created_by, "id", "创建人"),
        "updated_by": FieldDecl(Defect.updated_by, "id", "更新人"),
        "created_at": FieldDecl(Defect.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(Defect.updated_at, "time", "更新时间", nullable=False),
    },
)
register(DEFECT_LIST_FILTER)


# ══════════════════════════════ 小工具 ══════════════════════════════
def _split_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [t for t in (x.strip() for x in raw.split(",")) if t]


def _join_tags(tags: list[str] | None) -> str | None:
    if not tags:
        return None
    seen: list[str] = []
    for t in tags:
        if t not in seen:
            seen.append(t)
    return ",".join(seen)


def _merge_tags(raw: str | None, extra: list[str]) -> str | None:
    return _join_tags(_split_tags(raw) + list(extra))


async def _user_names(db, ids: set[str | None]) -> dict[str, str]:
    real = {i for i in ids if i}
    if not real:
        return {}
    rows = (await db.execute(select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(real)))).all()
    return {r.id: r.name for r in rows}


async def _user_exists(db, user_id: str) -> bool:
    return (await db.execute(select(APP_USER.c.id).where(APP_USER.c.id == user_id))).first() is not None


async def _defect(db, project_id: str, defect_id: str, *, include_recycled: bool = False) -> Defect:
    """按 (id, project_id) 取行；跨项目与不存在同码同文案（不泄露存在性）。"""
    row = (await db.execute(
        select(Defect).where(Defect.id == defect_id, Defect.project_id == project_id)
    )).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "缺陷不存在", 404, {"defect_id": defect_id})
    if row.recycled and not include_recycled:
        raise ApiError("not_found", "缺陷不存在（在回收站，请先恢复）", 404, {"defect_id": defect_id})
    return row


def _check_transition(flow: defect_flow.DefectFlow, old: str, new: str) -> None:
    if not flow.has(new):
        raise ApiError("invalid_status", "未知的缺陷状态：" + new, 422, {"status": new})
    if not flow.allows(old, new):
        raise ApiError("invalid_transition",
                       "缺陷状态不能从「" + flow.name_of(old) + "」直接变为「" + flow.name_of(new) + "」", 409,
                       {"from": old, "to": new, "allowed": list(flow.allowed(old))})

async def _counts(db, project_id: str, defect_ids: list[str]) -> dict[str, tuple[int, int, int]]:
    """一次批量取三组计数：关联用例 / 评论 / 关注人。返回 {defect_id: (link, comment, follower)}。"""
    if not defect_ids:
        return {}
    out: dict[str, tuple[int, int, int]] = {i: (0, 0, 0) for i in defect_ids}
    # 三组分开写而不是循环：三张模型的列类型不同，循环里 model 会被推成 type[Base]，
    # mypy 看不见 project_id/defect_id（Write 一次一处，读起来也比 zip 元组直白）。
    link_rows = (await db.execute(
        select(DefectCaseLink.defect_id, func.count()).where(
            DefectCaseLink.project_id == project_id, DefectCaseLink.defect_id.in_(defect_ids)
        ).group_by(DefectCaseLink.defect_id))).all()
    comment_rows = (await db.execute(
        select(DefectComment.defect_id, func.count()).where(
            DefectComment.project_id == project_id, DefectComment.defect_id.in_(defect_ids)
        ).group_by(DefectComment.defect_id))).all()
    follower_rows = (await db.execute(
        select(DefectFollower.defect_id, func.count()).where(
            DefectFollower.project_id == project_id, DefectFollower.defect_id.in_(defect_ids)
        ).group_by(DefectFollower.defect_id))).all()
    for did, n in link_rows:
        out[did] = (int(n), out[did][1], out[did][2])
    for did, n in comment_rows:
        out[did] = (out[did][0], int(n), out[did][2])
    for did, n in follower_rows:
        out[did] = (out[did][0], out[did][1], int(n))
    return out


async def _followed_ids(db, defect_ids: list[str], user_id: str) -> set[str]:
    if not defect_ids:
        return set()
    rows = (await db.execute(
        select(DefectFollower.defect_id).where(DefectFollower.user_id == user_id,
                                               DefectFollower.defect_id.in_(defect_ids))
    )).scalars().all()
    return set(rows)


# ══════════════════════════════ 模板 / 取号 / 自定义值 ══════════════════════════════
async def _resolve_template(ctx, project_id: str, template_id: str | None):
    """调 project_meta 的内部服务（REGISTRY 派发，不 import 领域模块）。"""
    spec = REGISTRY.get("project_template_resolve")
    assert spec is not None, "project_meta 服务未注册（main._SERVICE_MODULES 漏了？）"
    return await spec.handler(spec.model.model_validate({
        "project_id": project_id, "scene": "bug", "template_id": template_id,
    }), ctx)


async def _next_num(ctx, project_id: str) -> int:
    spec = REGISTRY.get("project_num_next")
    assert spec is not None, "取号服务未注册（main._SERVICE_MODULES 漏了？）"
    out = await spec.handler(spec.model.model_validate({
        "project_id": project_id, "scene": "bug",
    }), ctx)
    return int(out.num)


def _validate_custom(fields, values: dict | None, *, require_all: bool) -> dict:
    # 模板字段对外叫 field_id；shared 校验器统一用 id（与值表的键一致）
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


async def _load_custom_values(db, defect_ids: list[str]) -> dict[str, dict]:
    if not defect_ids:
        return {}
    rows = (await db.execute(select(DefectCustomField).where(
        DefectCustomField.defect_id.in_(defect_ids)))).scalars().all()
    out: dict[str, dict] = {i: {} for i in defect_ids}
    for r in rows:
        out.setdefault(r.defect_id, {})[r.field_id] = load_value(r.value)
    return out


async def _replace_custom_values(db, defect_id: str, project_id: str, values: dict) -> None:
    await db.execute(sa_delete(DefectCustomField).where(DefectCustomField.defect_id == defect_id))
    for fid, v in values.items():
        db.add(DefectCustomField(defect_id=defect_id, field_id=fid, project_id=project_id,
                                 value=dump_value(v)))


def _out(row: Defect, names: dict[str, str], counts: tuple[int, int, int], followed: bool,
         custom_fields: dict | None = None) -> schemas.DefectOut:
    link, comment, follower = counts
    return schemas.DefectOut(
        id=row.id, num=row.num, project_id=row.project_id, template_id=row.template_id,
        title=row.title, description=row.description,
        status=row.status, priority=row.priority, handle_user_id=row.handle_user_id,
        handle_user_name=names.get(row.handle_user_id or ""), tags=_split_tags(row.tags),
        custom_fields=custom_fields or {},
        recycled=row.recycled, created_by=row.created_by,
        created_by_name=names.get(row.created_by or ""), updated_by=row.updated_by,
        updated_by_name=names.get(row.updated_by or ""),
        created_at=schemas.iso(row.created_at), updated_at=schemas.iso(row.updated_at),
        delete_user=row.delete_user, delete_user_name=names.get(row.delete_user or ""),
        delete_time=schemas.iso(row.delete_time), link_count=link, comment_count=comment,
        follower_count=follower, followed=followed,
    )


async def _out_one(db, row: Defect, ctx_user: str) -> schemas.DefectOut:
    counts = (await _counts(db, row.project_id, [row.id])).get(row.id, (0, 0, 0))
    followed = row.id in await _followed_ids(db, [row.id], ctx_user)
    names = await _user_names(db, {row.handle_user_id, row.created_by, row.updated_by, row.delete_user})
    custom = (await _load_custom_values(db, [row.id])).get(row.id, {})
    return _out(row, names, counts, followed, custom)


# ══════════════════════════════ 核心 CRUD ══════════════════════════════
@service(
    perm="defect:defect:read", effect="read", name="defect_list",
    description="列出项目缺陷（页码分页；recycled=true 看回收站；支持状态/优先级/处理人/标签/关键词/我关注的）",
    http={"method": "GET", "path": "/defects", "tags": ["defect"]},
)
async def defect_list(payload: schemas.DefectListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    stmt = select(Defect).where(Defect.project_id == payload.project_id,
                                Defect.recycled.is_(payload.recycled),
                                # D216：高级搜索条件与项目/回收站轴并行 AND；OR 组自带括号，
                                # 不会把 project_id 或 recycled 谓词吃进 OR 里。
                                DEFECT_LIST_FILTER.parse(payload.filter))
    if payload.status:
        stmt = stmt.where(Defect.status == payload.status)
    if payload.priority:
        stmt = stmt.where(Defect.priority == payload.priority)
    if payload.handle_user_id:
        stmt = stmt.where(Defect.handle_user_id == payload.handle_user_id)
    if payload.template_id:
        stmt = stmt.where(Defect.template_id == payload.template_id)
    if payload.tag:
        # 逗号分隔存储 → find_in_set 做精确标签匹配（like '%tag%' 会把 bug1 命中 bug10）
        stmt = stmt.where(func.find_in_set(payload.tag, Defect.tags) > 0)
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(Defect.title.like(kw), Defect.description.like(kw)))
    if payload.followed_by_me:
        stmt = stmt.where(Defect.id.in_(
            select(DefectFollower.defect_id).where(DefectFollower.user_id == ctx.user_id)
        ))
    # 回收站照 MS 的 `/bug/trash/page` 按删除时间倒序（D190 §1.2）；正常列表用创建时间
    # 倒序（我们没有 MS 的 `pos` 拖拽位，D190 §5 第 3 条）。两条都用 id 兜底同秒并列。
    if payload.recycled:
        stmt = stmt.order_by(Defect.delete_time.desc(), Defect.id.desc())
    else:
        stmt = stmt.order_by(Defect.created_at.desc(), Defect.id.desc())
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    rows = page.items
    ids = [r.id for r in rows]
    counts = await _counts(ctx.db, payload.project_id, ids)
    followed = await _followed_ids(ctx.db, ids, ctx.user_id)
    names = await _user_names(ctx.db, {r.handle_user_id for r in rows} | {r.created_by for r in rows}
                             | {r.updated_by for r in rows} | {r.delete_user for r in rows})
    custom = await _load_custom_values(ctx.db, ids)
    return Page(items=[_out(r, names, counts.get(r.id, (0, 0, 0)), r.id in followed,
                            custom.get(r.id, {})) for r in rows],
                next_cursor=None, total=page.total)


@service(
    perm="defect:defect:create", effect="write", name="defect_create",
    description="新建缺陷（起始态 new；标题 1-255；标签去重；处理人可为空）",
    http={"method": "POST", "path": "/defects", "tags": ["defect"], "status": 201},
)
async def defect_create(payload: schemas.DefectCreateIn, ctx) -> schemas.DefectOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:create")
    assert ctx.db is not None
    if payload.handle_user_id is not None and not await _user_exists(ctx.db, payload.handle_user_id):
        raise ApiError("unknown_user", "处理人不存在", 422, {"handle_user_id": payload.handle_user_id})
    resolved = await _resolve_template(ctx, payload.project_id, payload.template_id)
    values = _validate_custom(resolved.fields, payload.custom_fields, require_all=True)
    num = await _next_num(ctx, payload.project_id)
    flow = await defect_flow.load_flow(ctx.db, payload.project_id)
    row = Defect(project_id=payload.project_id, num=num, template_id=resolved.template_id,
                 title=payload.title, description=payload.description,
                 status=flow.start_key, priority=payload.priority,
                 handle_user_id=payload.handle_user_id, tags=_join_tags(payload.tags),
                 recycled=False, created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.flush()
    await _replace_custom_values(ctx.db, row.id, payload.project_id, values)
    await ctx.db.commit()
    return await _out_one(ctx.db, row, ctx.user_id)


@service(
    perm="defect:defect:update", effect="write", name="defect_update",
    description="更新缺陷（PATCH；改状态必须过状态图，非法转移 409；tags=[] 清空）",
    http={"method": "PATCH", "path": "/defects/{defect_id}", "tags": ["defect"]},
)
async def defect_update(payload: schemas.DefectUpdateIn, ctx) -> schemas.DefectOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:update")
    assert ctx.db is not None
    row = await _defect(ctx.db, payload.project_id, payload.defect_id)
    if payload.title is not None:
        row.title = payload.title
    if payload.description_set:
        row.description = payload.description
    if payload.priority is not None:
        row.priority = payload.priority
    if payload.handle_user_set:
        if payload.handle_user_id is not None and not await _user_exists(ctx.db, payload.handle_user_id):
            raise ApiError("unknown_user", "处理人不存在", 422, {"handle_user_id": payload.handle_user_id})
        row.handle_user_id = payload.handle_user_id
    if payload.status is not None:
        flow = await defect_flow.load_flow(ctx.db, payload.project_id)
        _check_transition(flow, row.status, payload.status)
        row.status = payload.status
    if payload.tags is not None:
        row.tags = _join_tags(payload.tags)
    if payload.template_id is not None or payload.custom_fields is not None:
        current = (await _load_custom_values(ctx.db, [row.id])).get(row.id, {})
        target_tid = payload.template_id or row.template_id
        resolved = await _resolve_template(ctx, payload.project_id, target_tid)
        if resolved.template_id != row.template_id:
            # 换模板：旧值只保留新模板仍有的字段，其余按新模板必填规则重新校验
            allowed = {f.field_id for f in resolved.fields}
            current = {k: v for k, v in current.items() if k in allowed}
        incoming = current if payload.custom_fields is None else payload.custom_fields
        values = _validate_custom(resolved.fields, incoming, require_all=True)
        await _replace_custom_values(ctx.db, row.id, payload.project_id, values)
        row.template_id = resolved.template_id
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return await _out_one(ctx.db, row, ctx.user_id)


# ══════════════════════════════ 状态流转配置（D267）══════════════════════════
def _flow_out(project_id: str, flow: defect_flow.DefectFlow) -> schemas.DefectFlowOut:
    return schemas.DefectFlowOut(
        project_id=project_id,
        customized=flow.customized,
        source=flow.source,
        start_key=flow.start_key,
        statuses=[schemas.DefectFlowStatusOut(key=s.key, name=s.name, is_start=s.is_start, is_end=s.is_end)
                  for s in flow.statuses],
        transitions=[schemas.DefectFlowEdgeOut(from_key=frm, to_key=to)
                     for frm, tos in flow.edges.items() for to in tos],
    )


@service(
    perm="defect:defect:read", effect="read", name="defect_flow_get",
    description="项目的缺陷状态图（未定制时回落内置默认图，customized=false）",
    http={"method": "GET", "path": "/defect-statuses", "tags": ["defect"]},
    tool=False,
)
async def defect_flow_get(payload: schemas.DefectFlowGetIn, ctx) -> schemas.DefectFlowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    return _flow_out(payload.project_id, await defect_flow.load_flow(ctx.db, payload.project_id))


@service(
    perm="defect:flow:manage", effect="write", name="defect_flow_save",
    description="整份替换项目的缺陷状态图（恰好一个起始态；删仍在用的状态 409）",
    http={"method": "POST", "path": "/defect-statuses", "tags": ["defect"]},
    tool=False,
)
async def defect_flow_save(payload: schemas.DefectFlowIn, ctx) -> schemas.DefectFlowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:flow:manage")
    assert ctx.db is not None
    flow = await defect_flow.save_flow(
        ctx.db, payload.project_id,
        [(s.key, s.name, s.is_start, s.is_end) for s in payload.statuses],
        [(e.from_key, e.to_key) for e in payload.transitions],
    )
    await ctx.db.commit()
    return _flow_out(payload.project_id, flow)


@service(
    perm="defect:flow:manage", effect="destructive", name="defect_flow_reset",
    description="清空项目的状态图定制，回到内置默认图",
    http={"method": "POST", "path": "/defect-statuses/reset", "tags": ["defect"]},
    tool=False,
)
async def defect_flow_reset(payload: schemas.DefectFlowResetIn, ctx) -> schemas.DefectFlowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:flow:manage")
    assert ctx.db is not None
    await defect_flow.reset_flow(ctx.db, payload.project_id)
    await ctx.db.commit()
    return _flow_out(payload.project_id, await defect_flow.load_flow(ctx.db, payload.project_id))


# ══════════════════════ 组织级状态流模板（D271）══════════════════════
# 与 MS 的 OrganizationStatusFlowSetting 对齐：模板不复制到项目，改模板对「未自定义」的
# 项目立即生效（优先级 项目 > 组织 > 内置默认，见 flow.py 头注释）。
# 授权不在静态位上：`_require_org_defect_manage` 经 REGISTRY 调 iam 的 `org_cap_check`，
# 由它判定系统管理员 / ORG_ADMIN / 持 `system:org:defect:manage` 的组员——本模块不 import iam。
def _org_flow_out(org_id: str, flow: defect_flow.DefectFlow | None) -> schemas.OrgDefectFlowOut:
    f = defect_flow.DEFAULT_FLOW if flow is None else flow
    return schemas.OrgDefectFlowOut(
        org_id=org_id,
        customized=flow is not None,
        start_key=f.start_key,
        statuses=[schemas.DefectFlowStatusOut(key=s.key, name=s.name, is_start=s.is_start, is_end=s.is_end)
                  for s in f.statuses],
        transitions=[schemas.DefectFlowEdgeOut(from_key=frm, to_key=to)
                     for frm, tos in f.edges.items() for to in tos],
    )


async def _require_org_defect_manage(ctx, org_id: str) -> None:
    spec = REGISTRY.get("org_cap_check")
    assert spec is not None, "iam 的 org_cap_check 未注册"
    await spec.handler(spec.model.model_validate({
        "org_id": org_id, "cap": "system:org:defect:manage",
    }), ctx)


@service(
    perm="system:org:read", effect="read", name="defect_org_flow_get",
    description="组织的缺陷状态流模板（没建模板时回内置默认图，customized=false）",
    http={"method": "POST", "path": "/system/orgs/defect-flow/get", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def defect_org_flow_get(payload: schemas.OrgDefectFlowGetIn, ctx) -> schemas.OrgDefectFlowOut:
    await _require_org_defect_manage(ctx, payload.org_id)
    assert ctx.db is not None
    return _org_flow_out(payload.org_id, await defect_flow.load_org_flow(ctx.db, payload.org_id))


@service(
    perm="system:org:update", effect="write", name="defect_org_flow_save",
    description="整份替换组织的缺陷状态流模板（影响所有未自定义状态流的项目）",
    http={"method": "POST", "path": "/system/orgs/defect-flow/save", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def defect_org_flow_save(payload: schemas.OrgDefectFlowIn, ctx) -> schemas.OrgDefectFlowOut:
    await _require_org_defect_manage(ctx, payload.org_id)
    assert ctx.db is not None
    flow = await defect_flow.save_org_flow(
        ctx.db, payload.org_id,
        [(s.key, s.name, s.is_start, s.is_end) for s in payload.statuses],
        [(e.from_key, e.to_key) for e in payload.transitions],
    )
    await ctx.db.commit()
    return _org_flow_out(payload.org_id, flow)


@service(
    perm="system:org:update", effect="destructive", name="defect_org_flow_reset",
    description="删除组织的状态流模板，继承它的项目回落内置默认图",
    http={"method": "POST", "path": "/system/orgs/defect-flow/reset", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def defect_org_flow_reset(payload: schemas.OrgDefectFlowResetIn, ctx) -> schemas.OrgDefectFlowOut:
    await _require_org_defect_manage(ctx, payload.org_id)
    assert ctx.db is not None
    await defect_flow.reset_org_flow(ctx.db, payload.org_id)
    await ctx.db.commit()
    return _org_flow_out(payload.org_id, await defect_flow.load_org_flow(ctx.db, payload.org_id))


@service(
    perm="defect:defect:read", effect="read", name="defect_get",
    description="缺陷详情（含计数与当前用户是否关注）",
    http={"method": "GET", "path": "/defects/{defect_id}", "tags": ["defect"]},
)
async def defect_get(payload: schemas.DefectGetIn, ctx) -> schemas.DefectOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    row = await _defect(ctx.db, payload.project_id, payload.defect_id)
    return await _out_one(ctx.db, row, ctx.user_id)


@service(
    perm="defect:defect:read", effect="read", name="defect_exists",
    description="缺陷存在性探测（回收站里的也算存在）",
    http={"method": "GET", "path": "/defects/{defect_id}/exists", "tags": ["defect"]},
)
async def defect_exists(payload: schemas.DefectGetIn, ctx) -> schemas.DefectExistsOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    found = (await ctx.db.execute(
        select(Defect.id).where(Defect.id == payload.defect_id, Defect.project_id == payload.project_id)
    )).first()
    return schemas.DefectExistsOut(exists=found is not None)


@service(
    perm="defect:defect:delete", effect="destructive", name="defect_delete",
    description="把缺陷放入回收站（软删；工作流状态保持不变）",
    http={"method": "POST", "path": "/defects/{defect_id}/delete", "tags": ["defect"]},
)
async def defect_delete(payload: schemas.DefectDeleteIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:delete")
    assert ctx.db is not None
    row = await _defect(ctx.db, payload.project_id, payload.defect_id)
    row.recycled = True
    row.delete_user = ctx.user_id
    row.delete_time = datetime.now(UTC)
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=1)


@service(
    perm="defect:defect:delete", effect="destructive", name="defect_batch_delete",
    description="批量放入回收站（只影响未回收的缺陷；不存在的 id 静默忽略）",
    http={"method": "POST", "path": "/defects/batch-delete", "tags": ["defect"]},
    tool=False,
)
async def defect_batch_delete(payload: schemas.DefectBatchIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:delete")
    assert ctx.db is not None
    rows = (await ctx.db.execute(
        select(Defect).where(Defect.project_id == payload.project_id,
                             Defect.id.in_(payload.defect_ids), Defect.recycled.is_(False))
    )).scalars().all()
    now = datetime.now(UTC)
    for row in rows:
        row.recycled = True
        row.delete_user = ctx.user_id
        row.delete_time = now
        row.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=len(rows))


@service(
    perm="defect:defect:update", effect="write", name="defect_batch_update",
    description="批量编辑标签（add_tags 追加去重 / clear_tags 清空 / replace_tags 覆盖）",
    http={"method": "POST", "path": "/defects/batch-update", "tags": ["defect"]},
    tool=False,
)
async def defect_batch_update(payload: schemas.DefectBatchUpdateIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:update")
    assert ctx.db is not None
    rows = (await ctx.db.execute(
        select(Defect).where(Defect.project_id == payload.project_id,
                             Defect.id.in_(payload.defect_ids), Defect.recycled.is_(False))
    )).scalars().all()
    for row in rows:
        if payload.action == "clear_tags":
            row.tags = None
        elif payload.action == "add_tags":
            row.tags = _merge_tags(row.tags, payload.tags)
        else:
            row.tags = _join_tags(payload.tags)
        row.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=len(rows))


# ══════════════════════════════ 回收站 ══════════════════════════════
@service(
    perm="defect:defect:update", effect="write", name="defect_restore",
    description="从回收站恢复缺陷（清空删除人/删除时间；工作流状态不受影响）",
    http={"method": "POST", "path": "/defects/{defect_id}/restore", "tags": ["defect"]},
)
async def defect_restore(payload: schemas.DefectGetIn, ctx) -> schemas.DefectOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:update")
    assert ctx.db is not None
    row = await _defect(ctx.db, payload.project_id, payload.defect_id, include_recycled=True)
    if not row.recycled:
        raise ApiError("not_recycled", "缺陷不在回收站", 404, {"defect_id": payload.defect_id})
    row.recycled = False
    row.delete_user = None
    row.delete_time = None
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return await _out_one(ctx.db, row, ctx.user_id)


async def _purge_one(db, row: Defect, ctx) -> None:
    """彻底删除 + 四张子表/附件链接清理（D190 §5 第 3 条：MS 只删主表，留下孤儿）。"""
    await db.execute(sa_delete(DefectCaseLink).where(DefectCaseLink.defect_id == row.id))
    await db.execute(sa_delete(DefectComment).where(DefectComment.defect_id == row.id))
    await db.execute(sa_delete(DefectFollower).where(DefectFollower.defect_id == row.id))
    await db.execute(sa_delete(DefectCustomField).where(DefectCustomField.defect_id == row.id))
    spec = REGISTRY.get("file_target_purge")
    assert spec is not None, "filelib 服务未注册"
    await spec.handler(spec.model.model_validate({
        "project_id": row.project_id, "target_type": "bug", "target_id": row.id,
    }), ctx)
    await db.delete(row)


@service(
    perm="defect:defect:delete", effect="destructive", name="defect_purge",
    description="彻底删除回收站中的缺陷（物理删除并清空关联/评论/关注/自定义值；须逐字确认标题）",
    http={"method": "POST", "path": "/defects/{defect_id}/purge", "tags": ["defect"]},
    tool=False,
)
async def defect_purge(payload: schemas.DefectPurgeIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:delete")
    assert ctx.db is not None
    row = await _defect(ctx.db, payload.project_id, payload.defect_id, include_recycled=True)
    if not row.recycled:
        raise ApiError("not_recycled", "只能彻底删除回收站里的缺陷：请先放入回收站", 409,
                       {"defect_id": row.id})
    if payload.confirm_title != row.title:
        raise ApiError("title_mismatch", "确认标题与缺陷标题不一致，未删除", 409,
                       {"defect_id": row.id})
    await _purge_one(ctx.db, row, ctx)
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=1)


@service(
    perm="defect:defect:update", effect="write", name="defect_batch_restore",
    description="批量恢复回收站中的缺陷",
    http={"method": "POST", "path": "/defects/batch-restore", "tags": ["defect"]},
    tool=False,
)
async def defect_batch_restore(payload: schemas.DefectBatchIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:update")
    assert ctx.db is not None
    rows = (await ctx.db.execute(
        select(Defect).where(Defect.project_id == payload.project_id,
                             Defect.id.in_(payload.defect_ids), Defect.recycled.is_(True))
    )).scalars().all()
    for row in rows:
        row.recycled = False
        row.delete_user = None
        row.delete_time = None
        row.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=len(rows))


@service(
    perm="defect:defect:delete", effect="destructive", name="defect_batch_purge",
    description="批量彻底删除回收站中的缺陷（不可恢复）",
    http={"method": "POST", "path": "/defects/batch-purge", "tags": ["defect"]},
    tool=False,
)
async def defect_batch_purge(payload: schemas.DefectBatchIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:delete")
    assert ctx.db is not None
    rows = (await ctx.db.execute(
        select(Defect).where(Defect.project_id == payload.project_id,
                             Defect.id.in_(payload.defect_ids), Defect.recycled.is_(True))
    )).scalars().all()
    for row in rows:
        await _purge_one(ctx.db, row, ctx)
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=len(rows))


# ══════════════════════════════ 关联用例 ══════════════════════════════
async def _case_map(db, project_id: str, pairs: set[tuple[str, str]]) -> dict[tuple[str, str], str]:
    """按类型批量取用例名。返回 {(case_type, case_id): name}；对象不存在则键缺失。"""
    out: dict[tuple[str, str], str] = {}
    by_type: dict[str, set[str]] = {}
    for t, i in pairs:
        by_type.setdefault(t, set()).add(i)
    for t, ids in by_type.items():
        tbl = CASE_TABLES[t]
        rows = (await db.execute(select(tbl.c.id, tbl.c.name).where(
            tbl.c.project_id == project_id, tbl.c.id.in_(ids)))).all()
        for r in rows:
            out[(t, r.id)] = r.name
    return out


@service(
    perm="defect:defect:read", effect="read", name="defect_link_list",
    description="列出缺陷关联的用例（对象被删后保留关联行并标 case_exists=false）",
    http={"method": "GET", "path": "/defects/{defect_id}/case-links", "tags": ["defect"]},
)
async def defect_link_list(payload: schemas.DefectLinkListIn, ctx) -> schemas.DefectLinkListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    await _defect(ctx.db, payload.project_id, payload.defect_id, include_recycled=True)
    rows = (await ctx.db.execute(
        select(DefectCaseLink).where(DefectCaseLink.project_id == payload.project_id,
                                     DefectCaseLink.defect_id == payload.defect_id)
        .order_by(DefectCaseLink.created_at, DefectCaseLink.id)
    )).scalars().all()
    names = await _case_map(ctx.db, payload.project_id, {(r.case_type, r.case_id) for r in rows})
    items = [schemas.DefectLinkOut(
        id=r.id, defect_id=r.defect_id, case_type=r.case_type, case_id=r.case_id,
        case_name=names.get((r.case_type, r.case_id)),
        case_exists=(r.case_type, r.case_id) in names,
        created_by=r.created_by, created_at=schemas.iso(r.created_at),
    ) for r in rows]
    return schemas.DefectLinkListOut(items=items, total=len(items))


@service(
    perm="defect:link:update", effect="write", name="defect_link_add",
    description="批量关联用例（case_type 取 DEFECT_CASE_TYPES；重复关联跳过）",
    http={"method": "POST", "path": "/defect-links", "tags": ["defect"], "status": 201},
)
async def defect_link_add(payload: schemas.DefectLinkAddIn, ctx) -> schemas.DefectLinkAddOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:link:update")
    assert ctx.db is not None
    await _defect(ctx.db, payload.project_id, payload.defect_id)
    tbl = CASE_TABLES[payload.case_type]
    found = set((await ctx.db.execute(select(tbl.c.id).where(
        tbl.c.project_id == payload.project_id, tbl.c.id.in_(payload.case_ids)))).scalars().all())
    missing = [i for i in payload.case_ids if i not in found]
    if missing:
        raise ApiError("unknown_case", "有 " + str(len(missing)) + " 个用例不存在或不属于本项目",
                       422, {"case_type": payload.case_type, "missing": missing})
    # 请求体自身的重复先去重：同一个事务里插两条相同唯一键会在 flush 时撞 DDL 唯一键，
    # 那不是「重复关联跳过」的语义（跳过的是库里已有的），而是调用方把同一对写了两遍。
    unique_ids = list(dict.fromkeys(payload.case_ids))
    existing = set((await ctx.db.execute(select(DefectCaseLink.case_id).where(
        DefectCaseLink.defect_id == payload.defect_id,
        DefectCaseLink.case_type == payload.case_type,
        DefectCaseLink.case_id.in_(unique_ids)))).scalars().all())
    created = 0
    for cid in unique_ids:
        if cid in existing:
            continue
        ctx.db.add(DefectCaseLink(project_id=payload.project_id, defect_id=payload.defect_id,
                                  case_id=cid, case_type=payload.case_type, created_by=ctx.user_id))
        created += 1
    await ctx.db.commit()
    return schemas.DefectLinkAddOut(created=created, skipped=len(payload.case_ids) - created)


@service(
    perm="defect:link:update", effect="write", name="defect_link_remove",
    description="取消一条用例关联（硬删）",
    http={"method": "POST", "path": "/defect-links/{link_id}/delete", "tags": ["defect"]},
)
async def defect_link_remove(payload: schemas.DefectLinkRemoveIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:link:update")
    assert ctx.db is not None
    link = (await ctx.db.execute(
        select(DefectCaseLink).where(DefectCaseLink.id == payload.link_id,
                                     DefectCaseLink.project_id == payload.project_id,
                                     DefectCaseLink.defect_id == payload.defect_id)
    )).scalar_one_or_none()
    if link is None:
        raise ApiError("not_found", "关联不存在", 404, {"link_id": payload.link_id})
    await ctx.db.delete(link)
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=1)


@service(
    perm="defect:defect:read", effect="read", name="defect_link_candidates",
    description="候选用例（按类型列未关联的用例，支持关键词；供关联弹窗）",
    http={"method": "GET", "path": "/defect-link-candidates", "tags": ["defect"]},
)
async def defect_link_candidates(payload: schemas.DefectLinkCandidateIn, ctx) -> schemas.DefectCaseOptionOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    await _defect(ctx.db, payload.project_id, payload.defect_id, include_recycled=True)
    tbl = CASE_TABLES[payload.case_type]
    linked = select(DefectCaseLink.case_id).where(DefectCaseLink.defect_id == payload.defect_id,
                                                  DefectCaseLink.case_type == payload.case_type)
    stmt = select(tbl.c.id, tbl.c.name, tbl.c.status).where(
        tbl.c.project_id == payload.project_id,
        tbl.c.status == "normal",
        tbl.c.id.not_in(linked),
    ).order_by(tbl.c.name)
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(tbl.c.name.like(kw))
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    return schemas.DefectCaseOptionOut(
        items=[schemas.DefectCaseOption(id=r.id, name=r.name, status=r.status) for r in page.items],
        total=page.total or 0,
    )


# ══════════════════════════════ 评论 ══════════════════════════════
@service(
    perm="defect:defect:read", effect="read", name="defect_comment_list",
    description="缺陷评论（两层嵌套：顶层带 children）",
    http={"method": "GET", "path": "/defects/{defect_id}/comments", "tags": ["defect"]},
)
async def defect_comment_list(payload: schemas.DefectCommentListIn, ctx) -> schemas.DefectCommentListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    await _defect(ctx.db, payload.project_id, payload.defect_id, include_recycled=True)
    rows = (await ctx.db.execute(
        select(DefectComment).where(DefectComment.project_id == payload.project_id,
                                    DefectComment.defect_id == payload.defect_id)
        .order_by(DefectComment.created_at, DefectComment.id)
    )).scalars().all()
    names = await _user_names(ctx.db, {r.created_by for r in rows} | {r.reply_user_id for r in rows})
    nodes = {r.id: schemas.DefectCommentOut(
        id=r.id, defect_id=r.defect_id, parent_id=r.parent_id, content=r.content,
        reply_user_id=r.reply_user_id, reply_user_name=names.get(r.reply_user_id or ""),
        created_by=r.created_by, created_by_name=names.get(r.created_by),
        created_at=schemas.iso(r.created_at), updated_at=schemas.iso(r.updated_at),
    ) for r in rows}
    roots: list[schemas.DefectCommentOut] = []
    for r in rows:
        node = nodes[r.id]
        if r.parent_id and r.parent_id in nodes:
            nodes[r.parent_id].children.append(node)
        else:
            roots.append(node)
    return schemas.DefectCommentListOut(items=roots, total=len(rows))


@service(
    perm="defect:defect:comment", effect="write", name="defect_comment_add",
    description="新增评论（parent_id 指向顶层评论时成为回复）",
    http={"method": "POST", "path": "/defects/{defect_id}/comments", "tags": ["defect"], "status": 201},
)
async def defect_comment_add(payload: schemas.DefectCommentAddIn, ctx) -> schemas.DefectCommentOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:comment")
    assert ctx.db is not None
    await _defect(ctx.db, payload.project_id, payload.defect_id)
    reply_user: str | None = None
    if payload.parent_id:
        parent = (await ctx.db.execute(
            select(DefectComment).where(DefectComment.id == payload.parent_id,
                                        DefectComment.project_id == payload.project_id,
                                        DefectComment.defect_id == payload.defect_id)
        )).scalar_one_or_none()
        if parent is None:
            raise ApiError("not_found", "父评论不存在", 404, {"parent_id": payload.parent_id})
        if parent.parent_id:
            raise ApiError("bad_request", "只支持两级评论：回复不能挂在回复上", 422,
                           {"parent_id": payload.parent_id})
        reply_user = parent.created_by
    row = DefectComment(project_id=payload.project_id, defect_id=payload.defect_id,
                        parent_id=payload.parent_id, content=payload.content,
                        reply_user_id=reply_user, created_by=ctx.user_id)
    ctx.db.add(row)
    await ctx.db.commit()
    names = await _user_names(ctx.db, {ctx.user_id, reply_user})
    return schemas.DefectCommentOut(
        id=row.id, defect_id=row.defect_id, parent_id=row.parent_id, content=row.content,
        reply_user_id=row.reply_user_id, reply_user_name=names.get(reply_user or ""),
        created_by=row.created_by, created_by_name=names.get(ctx.user_id),
        created_at=schemas.iso(row.created_at), updated_at=schemas.iso(row.updated_at),
    )


async def _comment(db, project_id: str, comment_id: str) -> DefectComment:
    row = (await db.execute(
        select(DefectComment).where(DefectComment.id == comment_id,
                                    DefectComment.project_id == project_id)
    )).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "评论不存在", 404, {"comment_id": comment_id})
    return row


@service(
    perm="defect:defect:comment", effect="write", name="defect_comment_update",
    description="编辑评论（仅创建人可编辑）",
    http={"method": "PATCH", "path": "/defect-comments/{comment_id}", "tags": ["defect"]},
)
async def defect_comment_update(payload: schemas.DefectCommentUpdateIn, ctx) -> schemas.DefectCommentOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:comment")
    assert ctx.db is not None
    row = await _comment(ctx.db, payload.project_id, payload.comment_id)
    if row.created_by != ctx.user_id:
        raise ApiError("forbidden", "只有评论创建人可以编辑", 403, {"comment_id": row.id})
    row.content = payload.content
    await ctx.db.commit()
    names = await _user_names(ctx.db, {row.created_by, row.reply_user_id})
    return schemas.DefectCommentOut(
        id=row.id, defect_id=row.defect_id, parent_id=row.parent_id, content=row.content,
        reply_user_id=row.reply_user_id, reply_user_name=names.get(row.reply_user_id or ""),
        created_by=row.created_by, created_by_name=names.get(row.created_by),
        created_at=schemas.iso(row.created_at), updated_at=schemas.iso(row.updated_at),
    )


@service(
    perm="defect:defect:comment", effect="destructive", name="defect_comment_delete",
    description="删除评论（仅创建人；父评论连同子回复一起删）",
    http={"method": "POST", "path": "/defect-comments/{comment_id}/delete", "tags": ["defect"]},
)
async def defect_comment_delete(payload: schemas.DefectCommentDeleteIn, ctx) -> schemas.DefectBatchOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:comment")
    assert ctx.db is not None
    row = await _comment(ctx.db, payload.project_id, payload.comment_id)
    if row.created_by != ctx.user_id:
        raise ApiError("forbidden", "只有评论创建人可以删除", 403, {"comment_id": row.id})
    await ctx.db.execute(sa_delete(DefectComment).where(DefectComment.parent_id == row.id))
    await ctx.db.delete(row)
    await ctx.db.commit()
    return schemas.DefectBatchOut(ok=True, affected=1)


# ══════════════════════════════ 关注 ══════════════════════════════
async def _follower_count(db, defect_id: str) -> int:
    return int((await db.execute(select(func.count()).select_from(DefectFollower)
                                 .where(DefectFollower.defect_id == defect_id))).scalar_one())


@service(
    perm="defect:defect:update", effect="write", name="defect_follow",
    description="关注缺陷（幂等；写位，不借用 read）",
    http={"method": "POST", "path": "/defects/{defect_id}/follow", "tags": ["defect"]},
)
async def defect_follow(payload: schemas.DefectFollowIn, ctx) -> schemas.DefectFollowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:update")
    assert ctx.db is not None
    await _defect(ctx.db, payload.project_id, payload.defect_id)
    exists = (await ctx.db.execute(
        select(DefectFollower).where(DefectFollower.defect_id == payload.defect_id,
                                     DefectFollower.user_id == ctx.user_id)
    )).scalar_one_or_none()
    if exists is None:
        ctx.db.add(DefectFollower(defect_id=payload.defect_id, user_id=ctx.user_id,
                                  project_id=payload.project_id,
                                  created_at=datetime.now(UTC)))
        await ctx.db.commit()
    return schemas.DefectFollowOut(following=True, follower_count=await _follower_count(ctx.db, payload.defect_id))


@service(
    perm="defect:defect:update", effect="write", name="defect_unfollow",
    description="取消关注缺陷（幂等）",
    http={"method": "POST", "path": "/defects/{defect_id}/unfollow", "tags": ["defect"]},
)
async def defect_unfollow(payload: schemas.DefectFollowIn, ctx) -> schemas.DefectFollowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:update")
    assert ctx.db is not None
    await _defect(ctx.db, payload.project_id, payload.defect_id)
    row = (await ctx.db.execute(
        select(DefectFollower).where(DefectFollower.defect_id == payload.defect_id,
                                     DefectFollower.user_id == ctx.user_id)
    )).scalar_one_or_none()
    if row is not None:
        await ctx.db.delete(row)
        await ctx.db.commit()
    return schemas.DefectFollowOut(following=False, follower_count=await _follower_count(ctx.db, payload.defect_id))


# ══════════════════════════════ 导出 ══════════════════════════════
def _csv_safe(v: object) -> object:
    """CSV 公式注入防护：以 = + - @ 或制表/回车开头的单元格加前导单引号。

    缺陷标题是用户可控文本，Excel 打开导出文件时会把 `=cmd|...` 当公式执行。
    只动"看起来像公式"的文本单元格；数字/时刻不经过这里（本导出的列全是文本）。
    """
    if not isinstance(v, str):
        return v
    if v.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + v
    return v


_EXPORT_COLUMNS = (
    ("num", "ID"),
    ("id", "内部 ID"),
    ("title", "标题"),
    ("status", "状态"),
    ("priority", "优先级"),
    ("tags", "标签"),
    ("handle_user_name", "处理人"),
    ("created_by_name", "创建人"),
    ("created_at", "创建时间"),
    ("updated_at", "更新时间"),
)


@service(
    perm="defect:defect:read", effect="read", name="defect_export_columns",
    description="缺陷导出的固定列配置（num + 固定列；自定义字段列随功能用例导出一起接）",
    http={"method": "GET", "path": "/defect-export-columns", "tags": ["defect"]},
)
async def defect_export_columns(payload: schemas.DefectExportColumnsIn, ctx) -> schemas.DefectExportColumnsOut:
    # 该端点只回静态列，但仍要过项目门：项目不存在/不可见时不能拿到一份「导出面」。
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    return schemas.DefectExportColumnsOut(
        columns=[schemas.DefectExportColumn(key=k, label=v) for k, v in _EXPORT_COLUMNS])


@service(
    perm="defect:defect:read", effect="read", name="defect_export",
    description="导出缺陷为 CSV（勾选或全量非回收；固定列含 num；读类动作，POST 不影响 READONLY glob）",
    http={"method": "POST", "path": "/defects/export", "tags": ["defect"]},
    tool=False,
)
async def defect_export(payload: schemas.DefectExportIn, ctx) -> schemas.DefectExportOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("defect:defect:read")
    assert ctx.db is not None
    stmt = select(Defect).where(Defect.project_id == payload.project_id, Defect.recycled.is_(False))
    notes: list[str] = []
    if payload.defect_ids is not None:
        wanted = set(payload.defect_ids)
        stmt = stmt.where(Defect.id.in_(wanted))
    rows = (await ctx.db.execute(stmt.order_by(Defect.created_at.desc(), Defect.id.desc()))).scalars().all()
    if payload.defect_ids is not None and len(rows) != len(set(payload.defect_ids)):
        missing = sorted(set(payload.defect_ids) - {r.id for r in rows})
        notes.append("有 " + str(len(missing)) + " 个缺陷未导出（不存在、在回收站或不属于本项目）")
    names = await _user_names(ctx.db, {r.handle_user_id for r in rows} | {r.created_by for r in rows})
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _, label in _EXPORT_COLUMNS])
    for r in rows:
        writer.writerow([_csv_safe(c) for c in (
            r.num, r.id, r.title, r.status, r.priority, ",".join(_split_tags(r.tags)),
            names.get(r.handle_user_id or "", ""), names.get(r.created_by or "", ""),
            schemas.iso(r.created_at) or "", schemas.iso(r.updated_at) or "",
        )])
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return schemas.DefectExportOut(filename="defects-" + stamp + ".csv",
                                   content="\ufeff" + buf.getvalue(), exported=len(rows), notes=notes)
