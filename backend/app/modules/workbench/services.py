"""工作台统计（§11.5.2 一期简化版）：一屏聚合，一个端点。

落点为什么是独立 composition 模块 `app/modules/workbench/`（与 search/ 同族）：
统计要同时读 api_test / scenario / ui_test / adb_test 的资产模型和 execution 的
run_record——从任何一边 import 另一边都破契约 1（领域模块互相独立）。composition 层才允许正向读
领域模块；execution 是底座（契约 4 只禁 execution→modules 的反向），正向读它合法。

口径（数字会被团队当事实读，逐条写死）：
- 窗口：近 7 天 = 展示时区 Asia/Shanghai 的「含今天的 7 个日历日」（§3.4-6 展示口径）。
  时刻存储是 UTC naive（core/db 约定），窗口起点在 Shanghai 本地零点算好再换回 UTC，
  **不在 UTC 上切日**——UTC 切日会把东八区 0~8 点的运行划进昨天。
- 运行时刻排序键 = COALESCE(started_at, created_at)，与 report_list / R70 同一把尺。
- 通过率 = Σpass / Σ(total−skip)（§8.6 口径按窗口聚合；stats 缺行的运行不进分母，
  全 skip / 无 stats 时返回 None，前端画「-」，不画 0%）。
- 触发方式：工作台是活跃度视角，debug 也算一次执行，不过滤（与报告中心「结论视角」
  默认滤 debug 是两把尺，各自在注释里写明，不互相冒充）。
- 失败 TOP1：subject_type=scenario、status ∈ {failed, error} 的运行按场景计次取最大。
- 每日趋势：按 Shanghai 日历日分桶；当日无运行 → pass_rate=null（缺，不是 0%）。
- 我最近编辑：**只覆盖 scenario / ui_case**——这两张表有 updated_by 列；
  api_definition / api_case 没有编辑者列；adb_case（1D T8 有 updated_by）暂不进
  本榜单——前端「我最近编辑」的分节在 T9 之后按 my_recent_edits_types 加宽，
  与其悄悄多一类让口径与前端对不上，不如留到加宽同批改。
  与其伪造一份不存在的编辑历史（§13 纪律 1），不如少给两列并在响应里带上
  `my_recent_edits_types` 让前端如实标注覆盖范围。
- 可见性：资产计数与「我最近编辑」都过 visible_clause（与 search 同一把尺）；
  运行不受私有资产可见性影响（run_record 没有 owner 语义，报告中心同样全见）。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlalchemy import String, cast, func, select

from app.core.service import ensure_project_access, service
from app.modules.adb_test.models import AdbCase
from app.modules.api_test.models import ApiCase, ApiDefinition
from app.modules.execution.models import RunRecord
from app.modules.execution.timefmt import APP_USER, iso_dt
from app.modules.scenario.models import Scenario
from app.modules.ui_test.models import UiCase
from app.shared.visibility import visible_clause

# 展示时区（蓝图 §3.4-6 写死；后端要切「上海日历日」就必须自己算，不能指望前端）
DISPLAY_TZ = ZoneInfo("Asia/Shanghai")
WINDOW_DAYS = 7
# 「失败」的运行状态：断言失败 + 请求失败都算失败（queued/running 不是失败）
FAIL_STATUSES = ("failed", "error")


class WorkbenchStatsIn(BaseModel):
    project_id: str


class AssetCounts(BaseModel):
    api_definition: int = 0
    api_case: int = 0
    scenario: int = 0
    ui_case: int = 0
    adb_case: int = 0


class TopFailScenario(BaseModel):
    subject_id: str
    subject_name: str
    fail_count: int


class DailyPoint(BaseModel):
    date: str  # Shanghai 日历日 YYYY-MM-DD
    runs: int = 0
    pass_rate: float | None = None  # 当日无运行或分母为 0 → None（缺，不是 0）


class RecentRunItem(BaseModel):
    id: str
    subject_name: str
    subject_type: str
    trigger: str
    status: str
    started_at: str | None = None
    # §11.4.1 最近执行行的「耗时」：与运行记录/报告中心同一列 elapsed_ms（同一把尺，
    # 不在工作台另算 finished−started——1A 老记录 elapsed_ms 可为空，前端画「—」）
    elapsed_ms: int | None = None
    created_by_name: str | None = None
    pass_rate: float | None = None


class RecentEditItem(BaseModel):
    id: str
    name: str
    type: str  # scenario | ui_case（见模块 docstring：其余两类无 updated_by 列）
    updated_at: str | None = None


class WorkbenchStatsOut(BaseModel):
    window: dict  # {days, since, until}（ISO UTC，前端展示换算交给 shared/timefmt）
    assets: AssetCounts
    runs_7d: int = 0
    pass_rate: float | None = None  # 窗口聚合；无有效分母 → None
    top_fail: TopFailScenario | None = None
    daily: list[DailyPoint] = Field(default_factory=list)  # 恒 7 个点，缺日是 runs=0
    recent_runs: list[RecentRunItem] = Field(default_factory=list)
    my_recent_edits: list[RecentEditItem] = Field(default_factory=list)
    # 诚实标注「我最近编辑」覆盖了哪些资产类型（api_definition/api_case 无编辑者列）
    my_recent_edits_types: list[str] = Field(default_factory=lambda: ["scenario", "ui_case"])


def _utc_naive(dt: datetime) -> datetime:
    """列值归一：UtcDateTime 读回是 aware UTC，裸 DateTime 列读回是 naive UTC——都折成 naive UTC。"""
    return dt.astimezone(UTC).replace(tzinfo=None) if dt.tzinfo is not None else dt


def window_start_utc(now_utc: datetime, days: int = WINDOW_DAYS) -> datetime:
    """近 N 天窗口起点（含今天）：Asia/Shanghai 的 (今天−(N−1)) 日 00:00 → UTC naive。

    先换到 Shanghai 日历、再归零、再回 UTC——顺序反了（UTC 先归零）就会把
    东八区 00:00~08:00 的运行划到前一天去。
    入参 naive 视为 UTC（naive.astimezone 会按**系统时区**解读——Windows 开发机与
    服务器时区不同结果就漂移，这是 R68 的变种，先把口径钉进函数里）。
    """
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=UTC)
    today_local = now_utc.astimezone(DISPLAY_TZ).date()
    start_local = datetime.combine(today_local - timedelta(days=days - 1), datetime.min.time(), tzinfo=DISPLAY_TZ)
    return start_local.astimezone(UTC).replace(tzinfo=None)


def _day_local(dt_utc_naive: datetime) -> str:
    """UTC naive 运行时刻 → Shanghai 日历日字符串（分桶唯一入口，测试钉边界）。"""
    return dt_utc_naive.replace(tzinfo=UTC).astimezone(DISPLAY_TZ).strftime("%Y-%m-%d")


def _rate(pass_sum: int, total_sum: int, skip_sum: int) -> float | None:
    """窗口聚合通过率，口径同 report_services._pass_rate（Σ 版）：分母 ≤ 0 → None。"""
    denom = total_sum - skip_sum
    if denom <= 0:
        return None
    return float(pass_sum / denom)


@service(
    perm="workbench:read", effect="read", name="workbench_stats",
    description="工作台统计（§11.5.2）：资产数 / 近 7 天执行 / 通过率 / 失败 TOP1 场景 / "
                "每日趋势 / 最近执行 10 条 / 我最近编辑 10 条（后者仅 scenario+ui_case，见 description 口径）",
    http={"method": "GET", "path": "/workbench-stats", "tags": ["workbench"]},
    resident=False,
)
async def workbench_stats(payload: WorkbenchStatsIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("workbench:read")
    assert ctx.db is not None
    db = ctx.db
    pid = payload.project_id
    now = datetime.now(UTC)
    since = window_start_utc(now)

    # —— 统计卡 1：资产数（可见口径同 search；回收站不进数） ——
    async def _asset_count(model, *extra) -> int:
        stmt = select(func.count()).select_from(model).where(
            model.project_id == pid, visible_clause(model, ctx), *extra)
        return int((await db.execute(stmt)).scalar_one())

    assets = AssetCounts(
        api_definition=await _asset_count(ApiDefinition, ApiDefinition.status != "recycled"),
        api_case=await _asset_count(ApiCase, ApiCase.status != "recycled"),
        scenario=await _asset_count(Scenario, Scenario.status != "recycled"),
        ui_case=await _asset_count(UiCase, UiCase.status != "recycled"),
        adb_case=await _asset_count(AdbCase, AdbCase.status != "recycled"),
    )

    # —— 窗口内运行（一次取回，runs_7d / 通过率 / TOP1 / 趋势四个数同一份数据，
    # 不各查各的——分叉的口径才是统计页最危险的 bug） ——
    sort_key = func.coalesce(RunRecord.started_at, RunRecord.created_at)
    rows = (await db.execute(
        select(RunRecord.subject_id, RunRecord.subject_name, RunRecord.subject_type,
               RunRecord.status, RunRecord.stats, RunRecord.started_at, RunRecord.created_at)
        .where(RunRecord.project_id == pid, sort_key >= since)
    )).all()
    runs_7d = len(rows)
    p_sum = t_sum = s_sum = 0
    fails: dict[str, dict] = {}
    by_day: dict[str, list[int]] = {}  # day → [runs, pass, total, skip]（runs 恒计，stats 缺行也计）
    for sid, sname, stype, status, stats, started_at, created_at in rows:
        if stats:
            p_sum += int(stats.get("pass") or 0)
            t_sum += int(stats.get("total") or 0)
            s_sum += int(stats.get("skip") or 0)
        if stype == "scenario" and status in FAIL_STATUSES:
            f = fails.setdefault(sid, {"subject_id": sid, "subject_name": sname, "fail_count": 0})
            f["fail_count"] += 1
            f["subject_name"] = sname  # 名称快照取最近一条
        d = _day_local(_utc_naive(started_at or created_at))
        cell = by_day.setdefault(d, [0, 0, 0, 0])
        cell[0] += 1
        if stats:
            cell[1] += int(stats.get("pass") or 0)
            cell[2] += int(stats.get("total") or 0)
            cell[3] += int(stats.get("skip") or 0)
    top_fail = max(fails.values(), key=lambda f: f["fail_count"], default=None)

    today_local = now.astimezone(DISPLAY_TZ).date()
    daily: list[DailyPoint] = []
    for i in range(WINDOW_DAYS - 1, -1, -1):
        day = (today_local - timedelta(days=i)).isoformat()
        n, p, t, s = by_day.get(day, [0, 0, 0, 0])
        daily.append(DailyPoint(date=day, runs=n, pass_rate=_rate(p, t, s)))

    # —— 最近执行 10 条（含 debug：工作台是活跃度视角；执行人名字走 APP_USER 表名 join） ——
    recent_rows = (await db.execute(
        select(RunRecord, APP_USER.c.name)
        .outerjoin(APP_USER, RunRecord.created_by == cast(APP_USER.c.id, String(36)))
        .where(RunRecord.project_id == pid)
        .order_by(sort_key.desc(), RunRecord.id.desc())
        .limit(10)
    )).all()
    recent_runs = [
        RecentRunItem(id=r.id, subject_name=r.subject_name, subject_type=r.subject_type,
                      trigger=r.trigger, status=r.status, started_at=iso_dt(r.started_at),
                      elapsed_ms=r.elapsed_ms,
                      created_by_name=n,
                      pass_rate=_rate(int((r.stats or {}).get("pass") or 0),
                                      int((r.stats or {}).get("total") or 0),
                                      int((r.stats or {}).get("skip") or 0)) if r.stats else None)
        for r, n in recent_rows
    ]

    # —— 我最近编辑 10 条：仅 scenario / ui_case（其余表无 updated_by 列，见 docstring） ——
    edits: list[RecentEditItem] = []
    for model, label in ((Scenario, "scenario"), (UiCase, "ui_case")):
        rows2 = (await db.execute(
            select(model.id, model.name, model.updated_at)
            .where(model.project_id == pid, model.status != "recycled",
                   model.updated_by == ctx.user_id, visible_clause(model, ctx))
            .order_by(model.updated_at.desc()).limit(10)
        )).all()
        edits.extend(RecentEditItem(id=i, name=n, type=label, updated_at=iso_dt(u)) for i, n, u in rows2)
    edits.sort(key=lambda e: e.updated_at or "", reverse=True)

    return WorkbenchStatsOut(
        window={"days": WINDOW_DAYS, "since": since.isoformat(), "until": now.isoformat()},
        assets=assets, runs_7d=runs_7d, pass_rate=_rate(p_sum, t_sum, s_sum),
        top_fail=TopFailScenario(**top_fail) if top_fail else None,
        daily=daily, recent_runs=recent_runs, my_recent_edits=edits[:10],
    )
