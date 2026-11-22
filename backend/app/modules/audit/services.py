"""审计：写入（同事务落 audit_log，唯一写入口）+ 查询（@service，T16）。

写入不设权限位（由调用方的写入口触发），查询只给系统管理员——见 audit_list 的门。
"""
from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlalchemy import String, cast, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import column, table

from app.core.errors import ApiError, Page, paginate_desc
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.audit.models import AuditLog


async def record(
    db: AsyncSession,
    *,
    user_id: str | None,
    entry: str,
    action: str,
    target: str | None = None,
    ok: bool = True,
    diff: dict[str, Any] | None = None,
    ip: str | None = None,
) -> AuditLog:
    row = AuditLog(ts=datetime.now(UTC), user_id=user_id, entry=entry, action=action,
                   target=target, ok=ok, diff=diff, ip=ip)
    db.add(row)
    return row


# —————————————————————————— 查询面（T16） ——————————————————————————
# 契约 1：audit 不 import iam → user_name 用表名 join（与 execution 同手法）。
_APP_USER = table("app_user", column("id"), column("name"))

# 展示时区（§3.4-6）：与 workbench.services.DISPLAY_TZ 同值不同源——audit 是领域模块，
# 不 import composition 层（import-linter 契约 1 的形状纪律），3 行常量的重复换零跨模块边。
DISPLAY_TZ = ZoneInfo("Asia/Shanghai")


def _day_start_utc(d: date) -> datetime:
    """Shanghai 日历日 00:00 → 库内 naive UTC（口径同 workbench.window_start_utc：
    先落 Shanghai 日历、归零、再回 UTC——顺序反了会把东八区 00:00~08:00 划给前一天）。"""
    local = datetime.combine(d, datetime.min.time(), tzinfo=DISPLAY_TZ)
    return local.astimezone(UTC).replace(tzinfo=None)


def _parse_bound(value: str | None, *, end: bool) -> tuple[datetime, bool] | None:
    """区间端点 → (库内 naive UTC, 是否开区间)。空 → None（不设这一侧边界）。

    - 纯日期 YYYY-MM-DD（前端 RangePicker 的主形状）：Shanghai 日历日边界。
      end=False → 当日 00:00 含；end=True → **次日** 00:00 不含（「到某天」画一整天，
      MySQL DATETIME 秒级，减 1 微秒会撞上边界，用开区间最干净）。
    - 完整 ISO（手搓/API 兜底）：aware 按其自身偏移；naive 视为 Shanghai 本地
      （这就是「与 workbench 窗口同尺」的含义：用户手里的钟是东八区）。
      end=True 含到该时刻本身。
    - 认不出 → bad_request 400：静默忽略筛选条件 = 假装查了整段历史。
    """
    if not value:
        return None
    s = value.strip()
    if len(s) == 10:
        try:
            d = date.fromisoformat(s)
        except ValueError as e:
            raise ApiError("bad_request", "时间筛选格式应为 YYYY-MM-DD 或 ISO 8601", 400, {"value": value}) from e
        return (_day_start_utc(d + timedelta(days=1)) if end else _day_start_utc(d), end)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise ApiError("bad_request", "时间筛选格式应为 YYYY-MM-DD 或 ISO 8601", 400, {"value": value}) from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=DISPLAY_TZ)
    return (dt.astimezone(UTC).replace(tzinfo=None), False)


class AuditListIn(BaseModel):
    project_id: str | None = None
    entry: str | None = Field(default=None, pattern="^(http|agent|schedule)$")
    action: str | None = Field(default=None, max_length=128)
    user_id: str | None = None
    ok: bool | None = None
    # 1E T7（§11.4.27）：时间区间筛选。纯日期 YYYY-MM-DD = Shanghai 日历日边界；
    # 完整 ISO：aware 按其偏移，naive 视为 Shanghai 本地（展示口径 §3.4-6 的同一把尺）。
    ts_from: str | None = Field(default=None, max_length=40)
    ts_to: str | None = Field(default=None, max_length=40)
    cursor: str | None = None
    size: int = Field(default=20, ge=1, le=200)


class AuditOut(BaseModel):
    id: str
    ts: str | None = None
    user_id: str | None = None
    user_name: str | None = None
    entry: str
    action: str
    target: str | None = None
    ok: bool
    diff: dict[str, Any] | None = None


@service(
    perm="system:audit:read", effect="read", name="audit_list",
    description="查询审计日志（入口 http/agent/schedule + 动作 + 成败 + 时间区间筛选；最新在前）",
    http={"method": "GET", "path": "/audit", "tags": ["system"]},
    # D29（1E T7）：审计是业主核查 Pilot 的镜子，不该出现在 Pilot 自己的工具面里。
    tool=False, resident=False,
)
async def audit_list(payload: AuditListIn, ctx) -> ServiceResult:
    """审计只读口：业主在此核查人与 Pilot 各自做了什么（§11.4.27、§11.4.37）。"""
    # D23 硬门（1E T7）：审计只给系统管理员。perm 位本身已挡住（项目角色的 `*:read`
    # 被 _project_scoped 的 -system:* 显式拒绝），这一行是把判定从「权限集合恰好
    # 不含」升级成「身份必须是系统管理员」——角色模板可编辑，glob/位集合会漂移，
    # 身份检查不会。
    if not ctx.is_system_admin:
        raise ApiError("insufficient_permission", "审计日志仅系统管理员可查", 403,
                       {"perm": "system:audit:read"})
    if payload.project_id:
        await ensure_project_access(ctx, payload.project_id)
    ctx.require("system:audit:read")
    assert ctx.db is not None
    stmt = (
        select(AuditLog, _APP_USER.c.name)
        .outerjoin(_APP_USER, AuditLog.user_id == cast(_APP_USER.c.id, String(36)))
    )
    if payload.project_id:
        # target 就是 project_id（写入口统一以项目为对象落审计，见 core.service._http_audit）
        stmt = stmt.where(AuditLog.target == payload.project_id)
    lo = _parse_bound(payload.ts_from, end=False)
    hi = _parse_bound(payload.ts_to, end=True)
    if lo is not None:
        stmt = stmt.where(AuditLog.ts >= lo[0])
    if hi is not None:
        stmt = stmt.where(AuditLog.ts < hi[0] if hi[1] else AuditLog.ts <= hi[0])
    if payload.entry:
        stmt = stmt.where(AuditLog.entry == payload.entry)
    if payload.action:
        stmt = stmt.where(AuditLog.action == payload.action)
    if payload.user_id:
        stmt = stmt.where(AuditLog.user_id == payload.user_id)
    if payload.ok is not None:
        stmt = stmt.where(AuditLog.ok.is_(payload.ok))
    # 最新在前；ts 是秒级 DATETIME，同秒并列用 id 兜底保证翻页不重不漏（同 run_record 契约）
    stmt = stmt.order_by(AuditLog.ts.desc(), AuditLog.id.desc())
    page = await paginate_desc(
        ctx.db, stmt, key_cols=[AuditLog.ts, AuditLog.id],
        row_key=lambda row: [row[0].ts.isoformat(), row[0].id],
        decode_key=lambda parts: [datetime.fromisoformat(str(parts[0])), str(parts[1])],
        cursor=payload.cursor, size=payload.size,
    )
    return Page(items=[AuditOut(
        id=a.id, ts=a.ts.isoformat() if a.ts else None, user_id=a.user_id, user_name=n,
        entry=a.entry, action=a.action, target=a.target, ok=a.ok, diff=a.diff
    ) for a, n in page.items], next_cursor=page.next_cursor)