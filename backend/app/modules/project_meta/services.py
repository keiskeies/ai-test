"""project_meta @service（D192）：模板 / 自定义字段 / 取号。

模板与字段的公开面各 6+5 条（MS 的图片上传 2 条不做——富文本文件库是 C12 的活），
另有两条内部服务（`http=None`、`tool=False`）：

- `project_template_resolve`：缺陷/用例创建时按 scene 取默认模板或指定模板，返回字段+选项。
  内部调用走 REGISTRY（`env_resolve` / `scenario_case_refs` 同款），不 import 领域模块。
- `project_num_next`：项目内人读编号。**DB 单行原子 upsert**，不是 MS 的 Redis-only
  （取证 §5：Redis flush 即重号且无唯一键兜底）。我们给 `(project_id,num)` 加了唯一键。

删除口径（与 MS 相反，逐条在 models.py 文件头）：
- 默认/系统模板不可删；被缺陷引用的模板不可删；被模板引用或有值行的字段不可删。
- 删模板只删自己的模板-字段行；删字段只删自己的选项——**不留下悬空 template_id 或孤儿值**。
"""
from __future__ import annotations

from sqlalchemy import column, func, select, table, text
from sqlalchemy import delete as sa_delete

from app.core.errors import ApiError, OkOut
from app.core.service import ensure_project_access, service
from app.modules.project_meta import schemas
from app.modules.project_meta.models import (
    ProjectCustomField,
    ProjectCustomFieldOption,
    ProjectTemplate,
    ProjectTemplateField,
)
from app.shared.custom_fields import (
    OPTION_TYPES,
    SCENE_LABELS,
    SCENES,
    CustomFieldError,
    dump_value,
    load_value,
    normalize_value,
)
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

NUM_INIT = 100001

# 跨域引用检查用表名反射（import-linter 契约 1：不 import defect）。
DEFECT = table("defect", column("project_id"), column("template_id"))
DEFECT_CUSTOM_FIELD = table("defect_custom_field", column("project_id"), column("field_id"),
                            column("value"))


# ══════════════════════ D247：两页高级搜索白名单 ══════════════════════
# 模板与字段同住「模板与字段」Tab，但各是一张表、各登记一枚 view_type（views/列设置也分开）。
# 白名单只收**稳定的标量列**：
# - `scene` 刻意不在里面：列表入参已把场景钉死（Tab 本身就是五场景切换），再允许按 scene
#   筛只会立刻筛出空集——那是假筛选项，同 audit 里 project_id 的处理。
# - `field_count` / `template_count` 是聚合算出来的展示值，不是列；按它筛得先改取数语句，
#   不属于本次补的「三件套」。
# - `internal`（系统内置）与 `is_default`（当前默认）在表格里以 Tag 展示，用户看得见，收。
# - `description` 是模态框里的可编辑文本，可空——「按描述找模板/字段」是真实用法。
TEMPLATE_LIST_FILTER = ListViewFilter(
    view_type="template",
    label="项目模板",
    fields={
        "name": FieldDecl(ProjectTemplate.name, "text", "模板名称", nullable=False),
        "description": FieldDecl(ProjectTemplate.description, "text", "描述"),
        "internal": FieldDecl(ProjectTemplate.internal, "bool", "系统内置", nullable=False),
        "is_default": FieldDecl(ProjectTemplate.is_default, "bool", "默认模板", nullable=False),
        "sort": FieldDecl(ProjectTemplate.sort, "number", "排序号", nullable=False),
        "created_at": FieldDecl(ProjectTemplate.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(ProjectTemplate.updated_at, "time", "更新时间", nullable=False),
    },
)
register(TEMPLATE_LIST_FILTER)

CUSTOM_FIELD_LIST_FILTER = ListViewFilter(
    view_type="custom_field",
    label="自定义字段",
    fields={
        "name": FieldDecl(ProjectCustomField.name, "text", "字段名称", nullable=False),
        "field_key": FieldDecl(ProjectCustomField.field_key, "text", "field_key", nullable=False),
        "type": FieldDecl(ProjectCustomField.type, "enum", "字段类型", nullable=False),
        "description": FieldDecl(ProjectCustomField.description, "text", "描述"),
        "internal": FieldDecl(ProjectCustomField.internal, "bool", "系统内置", nullable=False),
        "sort": FieldDecl(ProjectCustomField.sort, "number", "排序号", nullable=False),
        "created_at": FieldDecl(ProjectCustomField.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(ProjectCustomField.updated_at, "time", "更新时间", nullable=False),
    },
)
register(CUSTOM_FIELD_LIST_FILTER)


# ══════════════════════════════ 取号 ══════════════════════════════
@service(
    perm="project:num:write", effect="write", name="project_num_next",
    description="项目内人读编号取号（内部服务：DB 原子 upsert，同事务；scene 目前 bug）",
    http=None, tool=False, dynamic_perm=True,
)
async def project_num_next(payload: schemas.NumNextIn, ctx) -> schemas.NumNextOut:
    assert ctx.db is not None
    # 单语句原子：新行插 next_num=INIT+1，返回 INIT；已有行 LAST_INSERT_ID(next_num+1) 返回新值。
    res = await ctx.db.execute(text(
        "INSERT INTO num_sequence (project_id, scene, next_num, created_at, updated_at) "
        "VALUES (:p, :s, :n, NOW(), NOW()) "
        "ON DUPLICATE KEY UPDATE next_num = LAST_INSERT_ID(next_num + 1), updated_at = NOW()"
    ), {"p": payload.project_id, "s": payload.scene, "n": NUM_INIT + 1})
    if res.rowcount == 1:
        return schemas.NumNextOut(num=NUM_INIT)
    last = (await ctx.db.execute(text("SELECT LAST_INSERT_ID()"))).scalar_one()
    return schemas.NumNextOut(num=int(last) - 1)


# ══════════════════════════════ 模板 ══════════════════════════════
async def _template(db, project_id: str, template_id: str) -> ProjectTemplate:
    row = (await db.execute(select(ProjectTemplate).where(
        ProjectTemplate.id == template_id, ProjectTemplate.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "模板不存在", 404, {"template_id": template_id})
    return row


async def _field(db, project_id: str, field_id: str) -> ProjectCustomField:
    row = (await db.execute(select(ProjectCustomField).where(
        ProjectCustomField.id == field_id,
        ProjectCustomField.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "自定义字段不存在", 404, {"field_id": field_id})
    return row


async def _options_map(db, field_ids: set[str]) -> dict[str, list[schemas.FieldOptionOut]]:
    if not field_ids:
        return {}
    rows = (await db.execute(select(ProjectCustomFieldOption).where(
        ProjectCustomFieldOption.field_id.in_(field_ids)
    ).order_by(ProjectCustomFieldOption.sort, ProjectCustomFieldOption.value))).scalars().all()
    out: dict[str, list[schemas.FieldOptionOut]] = {}
    for r in rows:
        out.setdefault(r.field_id, []).append(
            schemas.FieldOptionOut(value=r.value, label=r.label, sort=r.sort))
    return out


async def _fields_for_template(db, template: ProjectTemplate) -> list[schemas.TemplateFieldOut]:
    rows = (await db.execute(
        select(ProjectTemplateField, ProjectCustomField)
        .join(ProjectCustomField, ProjectCustomField.id == ProjectTemplateField.field_id)
        .where(ProjectTemplateField.template_id == template.id,
               ProjectTemplateField.project_id == template.project_id,
               ProjectCustomField.project_id == template.project_id)
        .order_by(ProjectTemplateField.sort, ProjectTemplateField.field_id)
    )).all()
    opts = await _options_map(db, {f.id for _, f in rows})
    return [schemas.TemplateFieldOut(
        field_id=f.id, name=f.name, field_key=f.field_key, type=f.type,
        required=tf.required, sort=tf.sort,
        default_value=load_value(tf.default_value),
        options=opts.get(f.id, []),
    ) for tf, f in rows]


async def _ensure_default_template(db, project_id: str, scene: str) -> ProjectTemplate:
    """保证场景有且只有一个默认模板；没有就建系统默认（internal=True）。"""
    t = (await db.execute(select(ProjectTemplate).where(
        ProjectTemplate.project_id == project_id, ProjectTemplate.scene == scene,
        ProjectTemplate.is_default.is_(True)))).scalar_one_or_none()
    if t is not None:
        return t
    t = (await db.execute(select(ProjectTemplate).where(
        ProjectTemplate.project_id == project_id, ProjectTemplate.scene == scene,
        ProjectTemplate.internal.is_(True)).order_by(ProjectTemplate.sort, ProjectTemplate.id)
    )).scalars().first()
    if t is None:
        base = "系统默认（" + SCENE_LABELS.get(scene, scene) + "）"
        name, i = base, 2
        while (await db.execute(select(ProjectTemplate.id).where(
            ProjectTemplate.project_id == project_id, ProjectTemplate.scene == scene,
            ProjectTemplate.name == name))).first() is not None:
            name, i = base + " " + str(i), i + 1
        t = ProjectTemplate(project_id=project_id, scene=scene, name=name,
                            description="系统创建；字段与默认值可改，不可删除/改名",
                            internal=True, is_default=True, sort=0)
        db.add(t)
        await db.flush()
        return t
    t.is_default = True
    await db.flush()
    return t


async def _template_field_count(db, template_ids: list[str]) -> dict[str, int]:
    if not template_ids:
        return {}
    rows = (await db.execute(
        select(ProjectTemplateField.template_id, func.count())
        .where(ProjectTemplateField.template_id.in_(template_ids))
        .group_by(ProjectTemplateField.template_id))).all()
    return {tid: int(n) for tid, n in rows}


def _template_out(t: ProjectTemplate, count: int) -> schemas.TemplateOut:
    return schemas.TemplateOut(
        id=t.id, project_id=t.project_id, scene=t.scene, name=t.name,
        description=t.description, internal=t.internal, is_default=t.is_default,
        sort=t.sort, field_count=count,
        created_at=schemas.iso(t.created_at), updated_at=schemas.iso(t.updated_at),
    )


async def _validate_template_fields(db, project_id: str, scene: str,
                                    fields: list[schemas.TemplateFieldIn]) -> list[dict]:
    ids = [f.field_id for f in fields]
    if len(ids) != len(set(ids)):
        raise ApiError("duplicate_field", "同一个模板里字段不能重复", 422, {})
    if not ids:
        return []
    rows = (await db.execute(select(ProjectCustomField).where(
        ProjectCustomField.id.in_(ids), ProjectCustomField.project_id == project_id,
        ProjectCustomField.scene == scene))).scalars().all()
    by_id = {r.id: r for r in rows}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise ApiError("unknown_field", "有字段不存在或不属于当前项目/场景", 422, {"missing": missing})
    opts = await _options_map(db, set(ids))
    out: list[dict] = []
    for idx, f in enumerate(fields):
        row = by_id[f.field_id]
        spec = {"id": row.id, "name": row.name, "type": row.type,
                "options": [o.model_dump() for o in opts.get(row.id, [])]}
        default = None
        if f.default_value is not None:
            try:
                default = normalize_value(spec, f.default_value)
            except CustomFieldError as e:
                raise ApiError("bad_default", "字段「" + row.name + "」的默认值不合法：" + str(e),
                               422, {"field_id": row.id}) from e
        out.append({"field": f, "row": row, "default": default, "sort": f.sort if f.sort else idx})
    return out


async def _replace_template_fields(db, template: ProjectTemplate,
                                   validated: list[dict]) -> None:
    await db.execute(sa_delete(ProjectTemplateField).where(
        ProjectTemplateField.template_id == template.id))
    for item in validated:
        f = item["field"]
        db.add(ProjectTemplateField(
            project_id=template.project_id, template_id=template.id, field_id=f.field_id,
            required=f.required, sort=item["sort"],
            default_value=None if item["default"] is None else dump_value(item["default"]),
        ))


@service(
    perm="project:template:read", effect="read", name="project_template_resolve",
    description="解析场景模板（内部服务：指定 id 或默认模板 → 字段+选项+默认值）",
    http=None, tool=False, dynamic_perm=True,
)
async def project_template_resolve(payload: schemas.TemplateResolveIn, ctx) -> schemas.TemplateResolveOut:
    assert ctx.db is not None
    if payload.template_id:
        t = await _template(ctx.db, payload.project_id, payload.template_id)
        if t.scene != payload.scene:
            raise ApiError("scene_mismatch", "模板不属于该场景", 422,
                           {"template_id": t.id, "scene": payload.scene})
    else:
        t = await _ensure_default_template(ctx.db, payload.project_id, payload.scene)
    return schemas.TemplateResolveOut(template_id=t.id, scene=t.scene, name=t.name,
                                      fields=await _fields_for_template(ctx.db, t))


@service(
    perm="project:template:read", effect="read", name="project_template_list",
    description="场景下的模板列表（首次访问自动补系统默认模板）",
    http={"method": "GET", "path": "/templates", "tags": ["project_meta"]},
)
async def project_template_list(payload: schemas.TemplateListIn, ctx) -> schemas.TemplateListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:read")
    assert ctx.db is not None
    await _ensure_default_template(ctx.db, payload.project_id, payload.scene)
    await ctx.db.commit()
    rows = (await ctx.db.execute(select(ProjectTemplate).where(
        ProjectTemplate.project_id == payload.project_id, ProjectTemplate.scene == payload.scene,
        TEMPLATE_LIST_FILTER.parse(payload.filter),
    ).order_by(ProjectTemplate.is_default.desc(), ProjectTemplate.sort, ProjectTemplate.created_at))).scalars().all()
    counts = await _template_field_count(ctx.db, [r.id for r in rows])
    return schemas.TemplateListOut(items=[_template_out(r, counts.get(r.id, 0)) for r in rows])


@service(
    perm="project:template:read", effect="read", name="project_template_get",
    description="模板详情（含字段、必填、默认值、选项）",
    http={"method": "GET", "path": "/templates/{template_id}", "tags": ["project_meta"]},
)
async def project_template_get(payload: schemas.TemplateGetIn, ctx) -> schemas.TemplateDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:read")
    assert ctx.db is not None
    t = await _template(ctx.db, payload.project_id, payload.template_id)
    fields = await _fields_for_template(ctx.db, t)
    return schemas.TemplateDetailOut(**_template_out(t, len(fields)).model_dump(), fields=fields)


@service(
    perm="project:template:create", effect="write", name="project_template_create",
    description="新建模板（项目+场景内名称唯一；可一次带字段）",
    http={"method": "POST", "path": "/templates", "tags": ["project_meta"], "status": 201},
)
async def project_template_create(payload: schemas.TemplateCreateIn, ctx) -> schemas.TemplateDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:create")
    assert ctx.db is not None
    await _ensure_default_template(ctx.db, payload.project_id, payload.scene)
    dup = (await ctx.db.execute(select(ProjectTemplate.id).where(
        ProjectTemplate.project_id == payload.project_id, ProjectTemplate.scene == payload.scene,
        ProjectTemplate.name == payload.name))).first()
    if dup is not None:
        raise ApiError("conflict", "同场景下模板名已存在", 409, {"name": payload.name})
    validated = await _validate_template_fields(ctx.db, payload.project_id, payload.scene, payload.fields)
    t = ProjectTemplate(project_id=payload.project_id, scene=payload.scene, name=payload.name,
                        description=payload.description, internal=False, is_default=False,
                        sort=payload.sort, created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(t)
    await ctx.db.flush()
    await _replace_template_fields(ctx.db, t, validated)
    await ctx.db.commit()
    fields = await _fields_for_template(ctx.db, t)
    return schemas.TemplateDetailOut(**_template_out(t, len(fields)).model_dump(), fields=fields)


@service(
    perm="project:template:update", effect="write", name="project_template_update",
    description="更新模板（系统模板不可改名；fields 传了即整体替换）",
    http={"method": "PATCH", "path": "/templates/{template_id}", "tags": ["project_meta"]},
)
async def project_template_update(payload: schemas.TemplateUpdateIn, ctx) -> schemas.TemplateDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:update")
    assert ctx.db is not None
    t = await _template(ctx.db, payload.project_id, payload.template_id)
    if payload.name is not None and payload.name != t.name:
        if t.internal:
            raise ApiError("internal_immutable", "系统默认模板不可改名", 422, {"template_id": t.id})
        dup = (await ctx.db.execute(select(ProjectTemplate.id).where(
            ProjectTemplate.project_id == t.project_id, ProjectTemplate.scene == t.scene,
            ProjectTemplate.name == payload.name, ProjectTemplate.id != t.id))).first()
        if dup is not None:
            raise ApiError("conflict", "同场景下模板名已存在", 409, {"name": payload.name})
        t.name = payload.name
    if payload.description is not None:
        t.description = payload.description
    if payload.sort is not None:
        t.sort = payload.sort
    if payload.fields is not None:
        validated = await _validate_template_fields(ctx.db, t.project_id, t.scene, payload.fields)
        await _replace_template_fields(ctx.db, t, validated)
    t.updated_by = ctx.user_id
    await ctx.db.commit()
    fields = await _fields_for_template(ctx.db, t)
    return schemas.TemplateDetailOut(**_template_out(t, len(fields)).model_dump(), fields=fields)


@service(
    perm="project:template:delete", effect="destructive", name="project_template_delete",
    description="删除模板（系统/默认/被缺陷引用 → 409）",
    http={"method": "POST", "path": "/templates/{template_id}/delete", "tags": ["project_meta"]},
    tool=False,
)
async def project_template_delete(payload: schemas.TemplateDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:delete")
    assert ctx.db is not None
    t = await _template(ctx.db, payload.project_id, payload.template_id)
    if t.internal:
        raise ApiError("internal_template", "系统默认模板不可删除", 409, {"template_id": t.id})
    if t.is_default:
        raise ApiError("default_template", "默认模板不可删除：先把另一模板设为默认", 409,
                       {"template_id": t.id})
    used = int((await ctx.db.execute(select(func.count()).select_from(DEFECT).where(
        DEFECT.c.project_id == payload.project_id, DEFECT.c.template_id == t.id))).scalar_one())
    if used:
        raise ApiError("template_in_use", "有 " + str(used) + " 个缺陷正在使用该模板，不能删除",
                       409, {"template_id": t.id, "defect_count": used})
    await ctx.db.execute(sa_delete(ProjectTemplateField).where(ProjectTemplateField.template_id == t.id))
    await ctx.db.delete(t)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="project:template:update", effect="write", name="project_template_set_default",
    description="把模板设为场景默认（同场景其余模板取消默认）",
    http={"method": "POST", "path": "/templates/{template_id}/set-default", "tags": ["project_meta"]},
)
async def project_template_set_default(payload: schemas.TemplateSetDefaultIn,
                                       ctx) -> schemas.TemplateDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:update")
    assert ctx.db is not None
    t = await _template(ctx.db, payload.project_id, payload.template_id)
    rows = (await ctx.db.execute(select(ProjectTemplate).where(
        ProjectTemplate.project_id == t.project_id, ProjectTemplate.scene == t.scene))).scalars().all()
    for r in rows:
        r.is_default = r.id == t.id
    t.updated_by = ctx.user_id
    await ctx.db.commit()
    fields = await _fields_for_template(ctx.db, t)
    return schemas.TemplateDetailOut(**_template_out(t, len(fields)).model_dump(), fields=fields)


@service(
    perm="project:template:read", effect="read", name="project_template_enable_config",
    description="模板作用域开关（当前只有项目级；组织级随三级组织模型）",
    http={"method": "GET", "path": "/template-enable-config", "tags": ["project_meta"]},
)
async def project_template_enable_config(payload: schemas.TemplateListIn,
                                         ctx) -> schemas.TemplateEnableConfigOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:read")
    return schemas.TemplateEnableConfigOut(scenes={s: "project" for s in SCENES})


# ══════════════════════════════ 自定义字段 ══════════════════════════════
async def _template_count_for_fields(db, field_ids: list[str]) -> dict[str, int]:
    if not field_ids:
        return {}
    rows = (await db.execute(
        select(ProjectTemplateField.field_id, func.count())
        .where(ProjectTemplateField.field_id.in_(field_ids))
        .group_by(ProjectTemplateField.field_id))).all()
    return {fid: int(n) for fid, n in rows}


def _field_out(f: ProjectCustomField, options: list[schemas.FieldOptionOut],
               template_count: int) -> schemas.CustomFieldOut:
    return schemas.CustomFieldOut(
        id=f.id, project_id=f.project_id, scene=f.scene, name=f.name, field_key=f.field_key,
        type=f.type, description=f.description, sort=f.sort, internal=f.internal,
        options=options, template_count=template_count,
        created_at=schemas.iso(f.created_at), updated_at=schemas.iso(f.updated_at),
    )


def _validate_options(field_type: str, options: list[schemas.FieldOptionIn]) -> None:
    if field_type in OPTION_TYPES:
        if not options:
            raise ApiError("options_required", "该字段类型必须至少有一个选项", 422, {})
    elif options:
        raise ApiError("options_not_allowed", "该字段类型不接受选项", 422, {})


async def _guard_option_removal(db, field: ProjectCustomField,
                                options: list[schemas.FieldOptionIn]) -> None:
    """选项整体替换前查值：已用到的 value 不许消失（MS 会静默让旧值变孤儿）。"""
    if field.type not in OPTION_TYPES:
        return
    allowed = {o.value for o in options}
    # 用 c["value"] 而不是 c.value：ColumnCollection 自带 values() 方法，点号会被抢走
    rows = (await db.execute(select(DEFECT_CUSTOM_FIELD.c["value"]).where(
        DEFECT_CUSTOM_FIELD.c.project_id == field.project_id,
        DEFECT_CUSTOM_FIELD.c.field_id == field.id))).scalars().all()
    for raw in rows:
        v = load_value(raw)
        used = v if isinstance(v, list) else [v]
        bad = [x for x in used if isinstance(x, str) and x not in allowed]
        if bad:
            raise ApiError("option_in_use",
                           "选项 " + "、".join(bad) + " 已有缺陷在使用，不能删除",
                           409, {"field_id": field.id, "values": bad})


async def _replace_options(db, field_id: str, options: list[schemas.FieldOptionIn]) -> None:
    await db.execute(sa_delete(ProjectCustomFieldOption).where(
        ProjectCustomFieldOption.field_id == field_id))
    for idx, o in enumerate(options):
        db.add(ProjectCustomFieldOption(field_id=field_id, value=o.value, label=o.label,
                                        sort=o.sort if o.sort else idx))


@service(
    perm="project:template:read", effect="read", name="project_custom_field_list",
    description="场景下的自定义字段列表（含选项与模板引用数）",
    http={"method": "GET", "path": "/custom-fields", "tags": ["project_meta"]},
)
async def project_custom_field_list(payload: schemas.CustomFieldListIn,
                                    ctx) -> schemas.CustomFieldListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(ProjectCustomField).where(
        ProjectCustomField.project_id == payload.project_id,
        ProjectCustomField.scene == payload.scene,
        CUSTOM_FIELD_LIST_FILTER.parse(payload.filter),
    ).order_by(ProjectCustomField.sort, ProjectCustomField.name))).scalars().all()
    opts = await _options_map(ctx.db, {r.id for r in rows})
    counts = await _template_count_for_fields(ctx.db, [r.id for r in rows])
    return schemas.CustomFieldListOut(
        items=[_field_out(r, opts.get(r.id, []), counts.get(r.id, 0)) for r in rows])


@service(
    perm="project:template:read", effect="read", name="project_custom_field_get",
    description="自定义字段详情",
    http={"method": "GET", "path": "/custom-fields/{field_id}", "tags": ["project_meta"]},
)
async def project_custom_field_get(payload: schemas.CustomFieldGetIn,
                                   ctx) -> schemas.CustomFieldOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:read")
    assert ctx.db is not None
    f = await _field(ctx.db, payload.project_id, payload.field_id)
    opts = (await _options_map(ctx.db, {f.id})).get(f.id, [])
    counts = await _template_count_for_fields(ctx.db, [f.id])
    return _field_out(f, opts, counts.get(f.id, 0))


@service(
    perm="project:template:create", effect="write", name="project_custom_field_create",
    description="新建自定义字段（field_key 项目内唯一；选项型必须带选项）",
    http={"method": "POST", "path": "/custom-fields", "tags": ["project_meta"], "status": 201},
)
async def project_custom_field_create(payload: schemas.CustomFieldCreateIn,
                                      ctx) -> schemas.CustomFieldOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:create")
    assert ctx.db is not None
    _validate_options(payload.type, payload.options)
    dup_key = (await ctx.db.execute(select(ProjectCustomField.id).where(
        ProjectCustomField.project_id == payload.project_id,
        ProjectCustomField.scene == payload.scene,
        ProjectCustomField.field_key == payload.field_key))).first()
    if dup_key is not None:
        raise ApiError("conflict", "field_key 已存在", 409, {"field_key": payload.field_key})
    dup_name = (await ctx.db.execute(select(ProjectCustomField.id).where(
        ProjectCustomField.project_id == payload.project_id,
        ProjectCustomField.scene == payload.scene,
        ProjectCustomField.name == payload.name))).first()
    if dup_name is not None:
        raise ApiError("conflict", "同场景下字段名已存在", 409, {"name": payload.name})
    f = ProjectCustomField(project_id=payload.project_id, scene=payload.scene, name=payload.name,
                           field_key=payload.field_key, type=payload.type,
                           description=payload.description, sort=payload.sort,
                           internal=False, created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(f)
    await ctx.db.flush()
    await _replace_options(ctx.db, f.id, payload.options)
    await ctx.db.commit()
    return _field_out(f, [schemas.FieldOptionOut(value=o.value, label=o.label,
                                                 sort=o.sort if o.sort else i)
                          for i, o in enumerate(payload.options)], 0)


@service(
    perm="project:template:update", effect="write", name="project_custom_field_update",
    description="更新自定义字段（类型不可改；options 传了即整体替换）",
    http={"method": "PATCH", "path": "/custom-fields/{field_id}", "tags": ["project_meta"]},
)
async def project_custom_field_update(payload: schemas.CustomFieldUpdateIn,
                                      ctx) -> schemas.CustomFieldOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:update")
    assert ctx.db is not None
    f = await _field(ctx.db, payload.project_id, payload.field_id)
    if f.internal:
        raise ApiError("internal_field", "系统字段不可编辑", 422, {"field_id": f.id})
    if payload.type is not None and payload.type != f.type:
        raise ApiError("type_immutable", "字段类型创建后不可修改（旧值会静默失效）", 422,
                       {"field_id": f.id, "type": f.type})
    if payload.name is not None and payload.name != f.name:
        dup = (await ctx.db.execute(select(ProjectCustomField.id).where(
            ProjectCustomField.project_id == f.project_id,
            ProjectCustomField.scene == f.scene,
            ProjectCustomField.name == payload.name,
            ProjectCustomField.id != f.id))).first()
        if dup is not None:
            raise ApiError("conflict", "同场景下字段名已存在", 409, {"name": payload.name})
        f.name = payload.name
    if payload.description is not None:
        f.description = payload.description
    if payload.sort is not None:
        f.sort = payload.sort
    if payload.options is not None:
        _validate_options(f.type, payload.options)
        await _guard_option_removal(ctx.db, f, payload.options)
        await _replace_options(ctx.db, f.id, payload.options)
    f.updated_by = ctx.user_id
    await ctx.db.commit()
    opts = (await _options_map(ctx.db, {f.id})).get(f.id, [])
    counts = await _template_count_for_fields(ctx.db, [f.id])
    return _field_out(f, opts, counts.get(f.id, 0))


@service(
    perm="project:template:delete", effect="destructive", name="project_custom_field_delete",
    description="删除自定义字段（被模板引用或有值行 → 409，避免孤儿值）",
    http={"method": "POST", "path": "/custom-fields/{field_id}/delete", "tags": ["project_meta"]},
    tool=False,
)
async def project_custom_field_delete(payload: schemas.CustomFieldDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:template:delete")
    assert ctx.db is not None
    f = await _field(ctx.db, payload.project_id, payload.field_id)
    if f.internal:
        raise ApiError("internal_field", "系统字段不可删除", 409, {"field_id": f.id})
    linked = int((await ctx.db.execute(select(func.count()).select_from(ProjectTemplateField).where(
        ProjectTemplateField.field_id == f.id))).scalar_one())
    if linked:
        raise ApiError("field_in_use", "该字段被 " + str(linked) + " 个模板引用，先从模板移除",
                       409, {"field_id": f.id, "template_count": linked})
    values = int((await ctx.db.execute(select(func.count()).select_from(DEFECT_CUSTOM_FIELD).where(
        DEFECT_CUSTOM_FIELD.c.project_id == payload.project_id,
        DEFECT_CUSTOM_FIELD.c.field_id == f.id))).scalar_one())
    if values:
        raise ApiError("field_has_values", "该字段已有 " + str(values) + " 条值记录，不能删除",
                       409, {"field_id": f.id, "value_count": values})
    await ctx.db.execute(sa_delete(ProjectCustomFieldOption).where(
        ProjectCustomFieldOption.field_id == f.id))
    await ctx.db.delete(f)
    await ctx.db.commit()
    return OkOut(ok=True)
