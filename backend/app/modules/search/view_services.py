"""个人视图 CRUD + 高级搜索能力元数据（§11.5.1 视图选择器，D47-a）。

为什么住 search 模块：MS 的一条视图存的就是「一份搜索条件」（它的 `user_view` 装的是
searchMode + 条件表），生命周期与一次检索同构；而视图 CRUD 只读写 saved_view 自己这张表，
不碰任何领域模型。`view_type` 由调用方（各列表页）给，本模块**不认识具体页面有哪些可筛字段**
——那份白名单由各页在 `app/shared/filter_registry.py` 里登记自己，本模块只查表。

一条刻意的口径，先说死：**保存视图时不校验字段白名单**。
- 校验需要「这个 view_type 有哪些可筛字段」的注册表，而那份注册表按页分布在后端各模块，
  search 模块要拿它就得反向 import 全部领域模块的 service（破契约 1）。
- 更要紧的是向前兼容：字段白名单会随批次变（新列进来、旧列改名）。存的时候钉死，
  下次升级后用户的老视图会整条读不出来，用户看到的是「我存的视图没了」。
- 所以：**存任意形状的筛选，读回时由各页白名单校验**。撞上不认识的字段 → 400 带可筛清单，
  用户改一下筛选就能用，视图本身还在。宁可报错说清「这个字段现在筛不了了」，
  也不要静默把它从条件里摘掉——那会让用户以为筛过了。
"""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.search.models import SavedView
from app.shared.filter_registry import get_entry, view_types
from app.shared.filters import KINDS, OPERATOR_LABELS, OPERATORS, BadFilter, kind_ops

# MS 的 13 枚操作符里一期不落地的那两枚 + 原因。写在代码里而不是只写在文档里：
# 前端要照这个在界面上说清「MS 有而这里没有」，而一句「一期不做」的文档前端拿不到。
_UNAVAILABLE: dict[str, str] = {
    "COUNT_GT": "按数量比较要有可聚合的子表（如用例的断言条数），当前没有任何一页有这种子表，"
                "摆出来就是点了没反应的假操作符",
    "COUNT_LT": "同 COUNT_GT",
}


class FilterMetaOut(BaseModel):
    """高级搜索能力清单：操作符全集 + 每种字段类型可用的子集 + 指定页面的可筛字段。

    前端表单**照这个渲染**，不在前端另抄一份字段名或操作符清单——第 29 轮那条轴（同一枚举
    多端镜像）的教训是手抄必然漂。前端那份镜像表由测试逐字读本模块核对（`shared/assertions.py`
    同法），而字段清单连镜像都不需要：直接来自 `filter_meta` 的响应。
    """

    operators: list[str]
    labels: dict[str, str]
    kinds: dict[str, list[str]]
    unavailable: dict[str, str] = Field(default_factory=dict)
    # 已登记可筛面的页面（视图选择器/筛选面板按它决定哪些页面显示「高级搜索」入口）
    supported_view_types: list[str] = Field(default_factory=list)
    # 请求带了 view_type 才填；没带 = 只回全局清单（前端启动时拉一次操作符表用）
    fields: list[dict] = Field(default_factory=list)
    view_label: str | None = None


class ViewOut(BaseModel):
    id: str
    project_id: str
    view_type: str
    name: str
    conditions: dict
    pos: int
    updated_at: str


def _iso(v) -> str:
    return v.isoformat() if v is not None else ""


def _out(r: SavedView) -> ViewOut:
    return ViewOut(id=r.id, project_id=r.project_id, view_type=r.view_type, name=r.name,
                   conditions=r.conditions, pos=r.pos, updated_at=_iso(r.updated_at))


def _valid_shape(conditions: dict) -> dict:
    """只钉「它是一份高级搜索条件」的形状（search_mode + conditions 数组）。
    字段白名单不校验，理由见模块 docstring。"""
    if not isinstance(conditions.get("conditions"), list):
        raise ValueError("conditions 必须含 conditions 数组（shared.filters 的那份形状）")
    return conditions


class ViewListIn(BaseModel):
    project_id: str
    view_type: str = Field(min_length=1, max_length=32)


class FilterMetaIn(BaseModel):
    """`view_type` 可省：省略 = 只要操作符/类型两份全局清单（前端启动时拉一次）。

    `project_id` **必填**，虽然这份清单眼下与项目无关。理由不是形式：R30 之后不带
    project_id 的请求只有系统管理员有读位（非管理员的平台面只剩 auth:*），一个普通成员
    打开接口页去拉筛选表单就会吃 403 —— 页面自己的元数据把页面成员挡在门外。带上它，
    这一格和 `search_assets`/`workbench_stats` 同族（成员凭 `*:read` 可读），
    顺带也为「以后字段按项目不同」（自定义字段，C 档）留了口子。
    """

    project_id: str
    view_type: str | None = Field(default=None, max_length=32)


@service(
    perm="search:read",
    effect="read",
    name="filter_meta",
    description="列出高级搜索支持的操作符、各字段类型可用的子集，以及指定列表页可筛的字段"
                "（前端筛选表单的唯一真相，不在前端另抄一份）",
    http={"method": "GET", "path": "/filter-meta", "tags": ["search"], "status": 200},
    tool=False,  # 纯 UI 元数据：模型不填表单，给它这个工具没有意义
)
async def filter_meta(payload: FilterMetaIn, ctx) -> FilterMetaOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("search:read")
    # 页面字段来自 shared.filter_registry（各页面模块自己登记），本模块不认识任何领域模块：
    # 要在这里 import api_test 才能拿到字段的话，第二第三页就得各加一行分支，
    # 组合层会退化成一份「哪些页面存在」的硬编码清单。
    # 未知页名转 400 而不是让它冒出去：BadFilter 是 ValueError，全局错误处理器不认它，
    # 前端拼错一个 view_type 会收到 500——那是把用户写错的参数报成服务端故障。
    try:
        entry = get_entry(payload.view_type) if payload.view_type else None
    except BadFilter as e:
        raise ApiError("bad_filter", str(e), 400, {"view_type": payload.view_type}) from e
    return FilterMetaOut(
        operators=sorted(OPERATORS),
        labels=dict(OPERATOR_LABELS),
        kinds={k: kind_ops(k) for k in sorted(KINDS)},
        # 一期明确不提供的操作符 + 原因：让前端能说清「为什么 MS 里有的这里没有」，
        # 而不是让用户以为点不到是 bug。
        unavailable=dict(_UNAVAILABLE),
        supported_view_types=view_types(),
        fields=entry.meta() if entry else [],
        view_label=entry.label if entry else None,
    )


@service(
    perm="search:read",
    effect="read",
    name="saved_view_list",
    description="列出本项目本页面上我保存的筛选视图（个人视图，同项目别人看不到）",
    http={"method": "GET", "path": "/saved-views", "tags": ["search"], "status": 200},
)
async def saved_view_list(payload: ViewListIn, ctx) -> list[ViewOut]:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("search:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(
        select(SavedView)
        .where(SavedView.project_id == payload.project_id,
               SavedView.view_type == payload.view_type,
               SavedView.owner_id == ctx.user_id)
        .order_by(SavedView.pos, SavedView.name)
    )).scalars().all()
    return [_out(r) for r in rows]


class ViewCreateIn(BaseModel):
    project_id: str
    view_type: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    conditions: dict

    @field_validator("conditions")
    @classmethod
    def _shape(cls, v: dict) -> dict:
        return _valid_shape(v)


@service(
    perm="search:view:create",
    effect="write",
    name="saved_view_create",
    description="把当前筛选存成个人视图",
    http={"method": "POST", "path": "/saved-views", "tags": ["search"], "status": 201},
)
async def saved_view_create(payload: ViewCreateIn, ctx) -> ViewOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("search:view:create")
    assert ctx.db is not None
    await _assert_name_free(ctx.db, payload.project_id, payload.view_type, ctx.user_id,
                            payload.name)
    # 新建排最后：当前最大 pos + 1。id/时刻列都交给模型列默认（new_id + TimestampMixin），
    # 服务层不自己造 uuid、不自己取此刻——两处口径迟早和别的表分叉。
    cur = (await ctx.db.execute(
        select(SavedView.pos).where(SavedView.project_id == payload.project_id,
                                    SavedView.view_type == payload.view_type,
                                    SavedView.owner_id == ctx.user_id)
        .order_by(SavedView.pos.desc()).limit(1)
    )).scalars().first()
    row = SavedView(project_id=payload.project_id, view_type=payload.view_type,
                    owner_id=ctx.user_id, name=payload.name, conditions=payload.conditions,
                    pos=(cur + 1) if cur is not None else 0)
    ctx.db.add(row)
    await ctx.db.flush()
    return _out(row)


class ViewUpdateIn(BaseModel):
    project_id: str
    view_type: str = Field(min_length=1, max_length=32)
    view_id: str
    name: str | None = Field(default=None, min_length=1, max_length=128)
    conditions: dict | None = None


@service(
    perm="search:view:update",
    effect="write",
    name="saved_view_update",
    description="改个人视图的名称或筛选条件",
    http={"method": "PATCH", "path": "/saved-views/{view_id}", "tags": ["search"], "status": 200},
)
async def saved_view_update(payload: ViewUpdateIn, ctx) -> ViewOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("search:view:update")
    assert ctx.db is not None
    row = await _fetch(ctx.db, payload.view_id, payload.project_id, payload.view_type, ctx.user_id)
    if payload.conditions is not None:
        # 改条件也过形状校验：update 可以只改名不传条件，所以 validator 挂不上，这里补。
        if not isinstance(payload.conditions.get("conditions"), list):
            raise ApiError("bad_request", "conditions 必须含 conditions 数组", 400, {})
        row.conditions = payload.conditions
    if payload.name is not None and payload.name != row.name:
        await _assert_name_free(ctx.db, row.project_id, row.view_type, row.owner_id,
                                payload.name)
        row.name = payload.name
    await ctx.db.flush()  # updated_at 由 TimestampMixin 的 onupdate 走
    return _out(row)


class ViewDeleteIn(BaseModel):
    project_id: str
    view_type: str = Field(min_length=1, max_length=32)
    view_id: str


@service(
    perm="search:view:delete",
    effect="destructive",
    name="saved_view_delete",
    description="删除个人视图（只删自己的；视图不挂任何引用，删了不影响任何资产）",
    http={"method": "DELETE", "path": "/saved-views/{view_id}", "tags": ["search"], "status": 200},
)
async def saved_view_delete(payload: ViewDeleteIn, ctx) -> dict:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("search:view:delete")
    assert ctx.db is not None
    row = await _fetch(ctx.db, payload.view_id, payload.project_id, payload.view_type, ctx.user_id)
    # destructive 但**不做引用检测、不做输名称二段式**：视图是个人偏好，没有任何资产引用它。
    # 硬凑一个「输入名称确认」会把「误删一个筛选组合」渲染成「危险操作」，
    # 反而训练用户对所有二次确认无脑点确定——那才是真正危险的副作用。
    vid = row.id
    await ctx.db.delete(row)
    await ctx.db.flush()
    return {"ok": True, "id": vid}


async def _fetch(db, view_id: str, project_id: str, view_type: str, owner_id: str) -> SavedView:
    """按 id + 项目 + 页面 + **主人** 取行；取不到 → 404。

    owner_id 进谓词是这件事的唯一点：别人的视图与不存在同码同文案，
    不泄露「这个项目里有这么一条视图」（assert_row_visible 同一口径）。
    """
    row = (await db.execute(
        select(SavedView).where(SavedView.id == view_id,
                                SavedView.project_id == project_id,
                                SavedView.view_type == view_type,
                                SavedView.owner_id == owner_id)
    )).scalars().first()
    if row is None:
        raise ApiError("not_found", "视图不存在", 404, {"view_id": view_id})
    return row


async def _assert_name_free(db, project_id: str, view_type: str, owner_id: str,
                            name: str) -> None:
    """同页面同主人的视图名不得重复（唯一约束 uq_saved_view_scope_name 的预检）。

    **owner_id 必须在谓词里**：唯一约束按 (project, view_type, owner, name) 四元组判重，
    预检若漏了 owner，两个人在同一页面各存一个叫「我的失败」的视图，第二个人会被 409 拦住，
    而数据库认为那两个名字根本不冲突——预检比约束严，就是多拦了合法请求。

    没有 `except_id` 参数：改名的调用方只在「名字真的变了」时才走到这里（见
    saved_view_update），而名字变了的匹配行必然是另一条，排除自己那行是个永不生效的分支。
    """
    stmt = select(SavedView.id).where(SavedView.project_id == project_id,
                                      SavedView.view_type == view_type,
                                      SavedView.owner_id == owner_id,
                                      SavedView.name == name)
    if (await db.execute(stmt.limit(1))).first() is not None:
        raise ApiError("name_taken", "该页面上你已有同名视图", 409, {"name": name})
