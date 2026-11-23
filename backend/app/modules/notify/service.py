"""通知渠道服务面（§11.4.26，1E T2）：CRUD + 删除前引用检测 + 测试发送。

四条这里特有的口径：
- **type 枚外 422**：合法集是 models.CHANNEL_TYPES 单一真相（§4:211 五元枚举），
  schema 层不收窄——枚举改一处即可，测试对 legal 侧从 CHANNEL_TYPES 推导（负例只钉
  明显不是渠道提供者的串），避免「清单扩容时负例钉随之处处变红」的 rot 坑。
- **D24 config 逐键密文**：敏感键值/URL query 段 Fernet 落库（core/security 现成的
  enc_key，与 model_cfg.api_key 同一把 TP_FERNET_KEY），回显逐键打码；update 传入值
  若等于当前打码回显视为「没改」，保留旧密文（前端把回显原样 PATCH 回来不许毁密钥）。
- **删除前引用检测**：被任何 schedule_task.notify_channel_ids 引用 → 409 列引用。
  语义照 scenario_case_refs（scenario/services.py:413）三点分歧：①不 require
  schedule:read——拦不拦由数据决定，缺权限的人反而不该能绕开保护直接删；
  ②无权限时 count 照报、明细隐瞒（details_hidden）；③「查不到是谁」要说出口。
  跨模块取数走**表名 SQL**（R28 口径：服务层跨模块信息用 SQL 表名 join，不 import
  领域模块——契约 1 独立性由 lint-imports 守着，notify import schedule 会直接红）。
- **测试发送是 POST 但 perm 是 `notify:channel:read`**：读类动作必须 `:read` 后缀
  结尾（1D READONLY glob 坑第三次预警，iam/roles.py 的 `["*:read"]` glob 只有这个
  后缀才盖得住）；effect="read" 同 model_cfg_probe 先例——PLAN 模式放行、结果如实
  落 last_send（D28）。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select, text

from app.core.errors import ApiError, OkOut, Page, paginate, paginate_page
from app.core.permissions import match_perm
from app.core.service import ServiceResult, service
from app.modules.notify import schemas, senders
from app.modules.notify.models import CHANNEL_TYPES, NotifyChannel
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.utcnow import utc_now_iso

# 引用明细最多列这么多条（列表页 409 弹窗读得完；计数永远是全量）。
REF_DETAIL_CAP = 20

# D243：通知渠道页高级搜索（D47-a 三件套铺到本页）。白名单只收页面上看得见的
# 标量列：名称 / 类型 / 创建时间 / 最近更新时间。
# - `config` 是渠道配置（密钥逐键打码回显的 JSON），条件比较它既无稳定语义，
#   还可能把「按密钥值筛」这种不该存在的入口摆出来；`last_send` 同理是发送回执 JSON。
# - `id` 是定位键，页头没有按 id 找的入口。
# - 渠道是平台级配置（无 project_id 列），所以白名单天然没有项目维度；
#   project_id 只用于 filter-meta / 保存视图的作用域校验，不参与数据过滤。
CHANNEL_LIST_FILTER = ListViewFilter(
    view_type="channel",
    label="通知渠道",
    fields={
        "name": FieldDecl(NotifyChannel.name, "text", "名称", nullable=False),
        "type": FieldDecl(NotifyChannel.type, "enum", "类型", nullable=False),
        "created_at": FieldDecl(NotifyChannel.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(NotifyChannel.updated_at, "time", "更新时间", nullable=False),
    },
)
register(CHANNEL_LIST_FILTER)


def _out(row: NotifyChannel) -> schemas.ChannelOut:
    return schemas.ChannelOut(
        id=row.id, name=row.name, type=row.type,
        config=senders.mask_config(row.config or {}),
        last_send=row.last_send,
        created_at=schemas.iso(row.created_at), updated_at=schemas.iso(row.updated_at),
    )


def _check_type(type_: str) -> None:
    if type_ not in CHANNEL_TYPES:
        raise ApiError("validation_failed", "渠道类型不在枚举内：" + type_, 422,
                       {"type": type_, "allowed": list(CHANNEL_TYPES)})


async def _channel(db, channel_id: str) -> NotifyChannel:
    row = (await db.execute(select(NotifyChannel).where(NotifyChannel.id == channel_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "通知渠道不存在", 404, {"channel_id": channel_id})
    return row


async def _schedule_refs(db, channel_id: str) -> tuple[int, list[dict[str, str]]]:
    """被哪些定时任务引用（count 全量 + 明细前 REF_DETAIL_CAP 条）。

    表名 SQL 而非 import schedule.models：契约 1（modules 互不 import）+ R28 先例。
    JSON_CONTAINS 走 MySQL JSON 语义，`["a","b"]` 数组含 channel_id 即命中。
    """
    cnt = (await db.execute(
        text("SELECT COUNT(*) FROM schedule_task "
             "WHERE JSON_CONTAINS(notify_channel_ids, JSON_QUOTE(:cid))"),
        {"cid": channel_id})).scalar_one()
    rows = (await db.execute(
        text("SELECT id, name FROM schedule_task "
             "WHERE JSON_CONTAINS(notify_channel_ids, JSON_QUOTE(:cid)) "
             "ORDER BY id LIMIT :lim"),
        {"cid": channel_id, "lim": REF_DETAIL_CAP})).all()
    return int(cnt), [{"task_id": r[0], "name": r[1]} for r in rows]


@service(
    perm="notify:channel:create", effect="write", name="notify_channel_create",
    description="创建通知渠道（WEBHOOK/DINGTALK/WECOM/FEISHU/EMAIL；"
                "敏感配置逐键 Fernet 加密落库，回显打码）",
    http={"method": "POST", "path": "/notify-channels", "tags": ["notify"], "status": 201},
    tool=False, resident=False,
)
async def notify_channel_create(payload: schemas.ChannelCreateIn, ctx) -> schemas.ChannelOut:
    ctx.require("notify:channel:create")
    assert ctx.db is not None
    _check_type(payload.type)
    dup = (await ctx.db.execute(select(NotifyChannel).where(NotifyChannel.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "渠道名称已存在", 409, {"name": payload.name})
    row = NotifyChannel(name=payload.name, type=payload.type, config=senders.encrypt_config(payload.config))
    ctx.db.add(row)
    await ctx.db.commit()
    return _out(row)


@service(
    perm="notify:channel:read", effect="read", name="notify_channel_list",
    description="列出通知渠道（config 逐键打码回显：token前5位•••• / url query 段[已配置]）",
    http={"method": "GET", "path": "/notify-channels", "tags": ["notify"]},
    resident=False,
)
async def notify_channel_list(payload: schemas.ChannelListIn, ctx) -> ServiceResult:
    ctx.require("notify:channel:read")
    assert ctx.db is not None
    stmt = select(NotifyChannel).order_by(NotifyChannel.id)
    if payload.type:
        stmt = stmt.where(NotifyChannel.type == payload.type)
    # D243：条件进 SQL（在分页前），total 与翻页吃同一份集合；空条件 = 没传。
    stmt = stmt.where(CHANNEL_LIST_FILTER.parse(payload.filter))
    # D47-b：cursor 与 current 二选一（同 report_list）。「我在哪」的两套真相一起到场
    # 是调用方的 bug，静默择一会把错位藏进翻页里，所以大声 400，不静默。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在同一个已排序 stmt 上 OFFSET：ORDER BY 与键集模式逐字同一条
        # （NotifyChannel.id，判据 5——两制各排各的就不是同一份列表）。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate(ctx.db, stmt, cursor_col=NotifyChannel.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    # total 透传（D47-b）：键集路径 page.total 恒 None → _dump 不写这个键，现有消费方
    # 的响应逐字节不变；页码路径把筛选后总数带给页脚。
    return Page(items=[_out(r) for r in page.items], next_cursor=page.next_cursor,
                total=page.total)


@service(
    perm="notify:channel:read", effect="read", name="notify_channel_get",
    description="获取单个通知渠道（config 打码回显 + last_send 最近一次发送结果）",
    http={"method": "GET", "path": "/notify-channels/{channel_id}", "tags": ["notify"]},
    resident=False,
)
async def notify_channel_get(payload: schemas.ChannelGetIn, ctx) -> schemas.ChannelOut:
    ctx.require("notify:channel:read")
    assert ctx.db is not None
    return _out(await _channel(ctx.db, payload.channel_id))


@service(
    perm="notify:channel:update", effect="write", name="notify_channel_update",
    description="更新通知渠道（config 整体替换；值等于当前打码回显的键视为未改、保留旧密文）",
    http={"method": "PATCH", "path": "/notify-channels/{channel_id}", "tags": ["notify"]},
    tool=False, resident=False,
)
async def notify_channel_update(payload: schemas.ChannelUpdateIn, ctx) -> schemas.ChannelOut:
    ctx.require("notify:channel:update")
    assert ctx.db is not None
    row = await _channel(ctx.db, payload.channel_id)
    if payload.name is not None and payload.name != row.name:
        dup = (await ctx.db.execute(select(NotifyChannel).where(
            NotifyChannel.name == payload.name, NotifyChannel.id != row.id))).scalars().first()
        if dup is not None:
            raise ApiError("conflict", "渠道名称已存在", 409, {"name": payload.name})
        row.name = payload.name
    if payload.config is not None:
        # D24 归并在 senders（加解密唯一真相）：打码回显原样送回 = 没改，旧密文保留
        row.config = senders.merge_config_for_update(dict(row.config or {}), payload.config)
    await ctx.db.commit()
    return _out(row)


@service(
    perm="notify:channel:delete", effect="destructive", name="notify_channel_delete",
    description="删除通知渠道（被任何 schedule_task.notify_channel_ids 引用时 409 列出引用）",
    http={"method": "POST", "path": "/notify-channels/{channel_id}/delete", "tags": ["notify"]},
    tool=False, resident=False,
)
async def notify_channel_delete(payload: schemas.ChannelGetIn, ctx) -> OkOut:
    ctx.require("notify:channel:delete")
    assert ctx.db is not None
    row = await _channel(ctx.db, payload.channel_id)
    count, items = await _schedule_refs(ctx.db, row.id)
    if count:
        # scenario_case_refs 语义：count 照报（不由权限决定拦不拦），明细按 schedule:read
        may_see = match_perm(ctx.perms, "schedule:read")
        # details_hidden 只表达「权限拦了明细」；details_truncated 表达「REF_DETAIL_CAP 截了明细」。
        # 两者必须分开：count 报 25、明细给 20 条时，前端若不被告知截断，会把 20 条当全量。
        raise ApiError("in_use", "该渠道被 " + str(count) + " 个定时任务引用，先解绑再删", 409,
                       {"channel_id": row.id, "count": count,
                        "tasks": items if may_see else [],
                        "details_hidden": not may_see,
                        "details_truncated": count > len(items)})
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="notify:channel:read", effect="read", name="notify_channel_test",
    description="测试发送：按渠道当前配置真发一条测试 Markdown，行内 ✓/✗ + 原始响应；"
                "结果回写 last_send（读类动作故 perm 以 :read 结尾——POST 不影响 glob 命中）",
    http={"method": "POST", "path": "/notify-channels/{channel_id}/test", "tags": ["notify"]},
    resident=False,
)
async def notify_channel_test(payload: schemas.ChannelGetIn, ctx) -> schemas.ChannelTestOut:
    ctx.require("notify:channel:read")
    assert ctx.db is not None
    row = await _channel(ctx.db, payload.channel_id)
    result = await senders.send(row, "### TestPilot 渠道测试\n\n这是一条来自「" + row.name + "」的测试通知。")
    last_send: dict[str, Any] = {
        "ok": result.ok, "latency_ms": result.latency_ms, "error": result.error,
        "raw": result.raw, "checked_at": utc_now_iso(),
    }
    row.last_send = last_send  # D28：每次发送结果如实落账（机器流水，不进审计）
    await ctx.db.commit()
    return schemas.ChannelTestOut(ok=result.ok, latency_ms=result.latency_ms,
                                  error=result.error, raw=result.raw, last_send=last_send)
