"""报告中心查询面（§6.6 / §11.4.15 / §11.4.16）：列表、详情、单步明细。

与运行记录页（services.py 的 run_record_list / run_get）分文件的理由不是「功能不同」，
而是读面口径不同：运行记录页看过程（含 trigger=debug），报告中心看结论（默认过滤
debug，Review Focus 11）。合在一个文件里会一路涨过计划的 400 行判据。

自包含纪律（§14 / Review Focus 10）：本文件只读 run_record / run_step_result /
run_artifact，**不 join 也不 import 任何领域模块**（契约 4）。subject_name /
summary_graph / detail / vars_snapshot 都是执行时落库的快照，场景与用例被彻底删除后
报告页依然完整可读；created_by_name 走 timefmt.APP_USER 表名 join。
"""
from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field
from sqlalchemy import String, cast, func, select

from app.core.errors import ApiError, Page, paginate_desc, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.execution.models import RunArtifact, RunRecord, RunStepResult
from app.modules.execution.services import RUN_STATUS_PATTERN, SUBJECT_TYPE_PATTERN, settle_dead_run
from app.modules.execution.timefmt import APP_USER, iso_dt
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

# D215：报告中心的可筛面（D47-a 三件套铺到报告页）。字段全是 run_record 上真实存在的
# 业务列；project_id / include_debug / since / until / cursor / current / size 仍是顶层
# 参数——前三个管越权与视图口径，后四个是取数机制，进了 filter 就是让两套开关抢同一个名字。
# env_name 是执行时快照（RunRecord.env_name），与 env_id 并列给出：按 id 精确筛，按名字
# 做人话核对，两者不互相替代（快照名可能与人话环境列表不同步，但报告本就该如实回放当时）。
REPORT_LIST_FILTER = ListViewFilter(
    view_type="report",
    label="报告中心",
    fields={
        "subject_name": FieldDecl(RunRecord.subject_name, "text", "对象名称", nullable=False),
        "subject_type": FieldDecl(RunRecord.subject_type, "enum", "对象类型", nullable=False),
        "trigger": FieldDecl(RunRecord.trigger, "enum", "触发方式", nullable=False),
        "status": FieldDecl(RunRecord.status, "enum", "执行结果", nullable=False),
        "env_id": FieldDecl(RunRecord.env_id, "id", "环境"),
        "env_name": FieldDecl(RunRecord.env_name, "text", "环境名称"),
        "created_by": FieldDecl(RunRecord.created_by, "id", "执行人"),
        "status_code": FieldDecl(RunRecord.status_code, "number", "响应码"),
        "elapsed_ms": FieldDecl(RunRecord.elapsed_ms, "number", "耗时(ms)"),
        "started_at": FieldDecl(RunRecord.started_at, "time", "开始时间"),
        "finished_at": FieldDecl(RunRecord.finished_at, "time", "结束时间"),
        "created_at": FieldDecl(RunRecord.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(RunRecord.updated_at, "time", "更新时间", nullable=False),
    },
)
register(REPORT_LIST_FILTER)


# 报告列表页字段（1A run_record_list 是"运行记录页"，这里多统计口径与调试开关）
class ReportListIn(BaseModel):
    project_id: str
    subject_id: str | None = None
    # 触发方式（§11.4.15 第二筛选）——词表与 RunListIn 同一张（R46）
    trigger: str | None = Field(default=None, pattern="^(debug|manual|schedule|agent|webhook)$")
    # T9：词表与 RunListIn 同一张（queued/running/cancelled 库里真会写，报告中心也要筛得出）
    status: str | None = Field(default=None, pattern=RUN_STATUS_PATTERN)
    # 1C T11（R112）：对象类型筛选，词表与 RunListIn 同一张；缺这个条件 UI 运行
    # 会出现在报告列表里却筛不出来。非法值 422，不静默忽略。
    subject_type: str | None = Field(default=None, pattern=SUBJECT_TYPE_PATTERN)
    env_id: str | None = None
    created_by: str | None = None
    since: str | None = None   # COALESCE(started_at, created_at) >= since（ISO，闭区间，§11.4.15 时间筛选）
    until: str | None = None   # COALESCE(started_at, created_at) <= until
    # 调试开关：默认过滤 trigger=debug（Review Focus 11——报告是结论，调试过程去运行记录页看）
    include_debug: bool = False
    # D215：高级搜索条件（JSON 串，形状与 shared/filters.py 一致）。与上面各顶层筛选
    # 并行 AND；空串=没筛选，坏条件 400 且带本页可筛清单。
    filter: str | None = None
    cursor: str | None = None
    # current（D47-b）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # 与 cursor 是互斥而非优先级：键集只能往前走，「跳到第 5 页」没有上一批末位可续，
    # 只能另开一制；两者同时到场必须先 400（判据在 handler），静默择一 = 把调用方的
    # bug 藏进另一套「我在哪」的真相里。
    current: int | None = None
    size: int = Field(default=20, ge=1, le=200)


class ReportListItemOut(BaseModel):
    id: str
    subject_name: str
    subject_type: str
    trigger: str
    env_name: str | None = None
    created_by_name: str | None = None
    status: str
    stats: dict | None = None
    pass_rate: float | None = None  # pass/(total-skip)；分母为 0 时 None（前端画「-」）
    elapsed_ms: int | None = None
    started_at: str | None = None


class ReportGetIn(BaseModel):
    project_id: str
    run_id: str


class ReportStepSummary(BaseModel):
    step_key: str
    kind: str
    status: str
    parent_step_key: str | None = None
    subject_name: str | None = None
    elapsed_ms: int | None = None
    attempts: int = 1
    row_no: int = 0
    pass_rows: int | None = None  # 数据集步：通过行数（节点展示 3/10 用，§8.6）
    total_rows: int | None = None  # 数据集步：总行数


class ReportGetOut(BaseModel):
    id: str
    subject_name: str
    subject_type: str
    trigger: str
    env_id: str | None = None
    env_name: str | None = None
    created_by_name: str | None = None
    status: str
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    elapsed_ms: int | None = None
    stats: dict | None = None
    pass_rate: float | None = None
    summary_graph: dict | None = None  # 快照自包含（§14）
    steps: list[ReportStepSummary] = Field(default_factory=list)
    artifacts: list[dict] = Field(default_factory=list)


class ReportStepDetailIn(BaseModel):
    project_id: str
    run_id: str
    step_key: str
    row_no: int = 0


class ReportStepDetailOut(BaseModel):
    step_key: str
    kind: str
    status: str
    row_no: int
    parent_step_key: str | None = None
    subject_name: str | None = None
    elapsed_ms: int | None = None
    attempts: int = 1
    vars_snapshot: dict | None = None
    detail: dict | None = None


def _parse_iso(value: str | None) -> datetime | None:
    """用户 ISO → 库内 naive UTC（§3.4 时刻约定：存储一律 UTC naive，R62 的坑）。

    aware 输入转 UTC 后剥偏移；naive 输入视为 UTC 原样放行——不做 astimezone，
    否则 Windows 本机会把 naive 当本地时间再偏 8 小时。
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as e:
        raise ApiError("bad_request", "时间筛选格式应为 ISO 8601", 400,
                       {"field": value}) from e
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _pass_rate(stats: dict | None) -> float | None:
    """口径 §8.6：数据集步骤按节点计 1 步；pass_rate = pass / (total - skip)。

    stats 是执行器终态回写的唯一权威（T9 汇总），步骤表只是明细——两者冲突以
    stats 为准。分母 ≤ 0（全 skip / 缺 stats）不除零：返回 None，列表页画「-」。
    """
    if not stats:
        return None
    denom = int(stats.get("total") or 0) - int(stats.get("skip") or 0)
    if denom <= 0:
        return None
    return float(int(stats.get("pass") or 0) / denom)


def _decode_cursor_dt(value: str) -> datetime:
    """游标里的排序键 → 库内 naive UTC（aware 输入先归零偏移，与 _parse_iso 同口径）。

    抛 ValueError 而不是 ApiError：让 paginate_desc 统一归成 bad_cursor 400——
    「游标坏了」与「筛选参数格式错」是两个错，信封 code 不该混用。
    """
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as e:
        raise ValueError("bad cursor datetime") from e
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


@service(
    perm="api:run:read", effect="read", name="report_list",
    description="报告中心列表：时间/场景/对象类型/触发/执行人/环境/结果筛选，默认不含调试运行",
    http={"method": "GET", "path": "/reports", "tags": ["execution"]},
    resident=False,
)
async def report_list(payload: ReportListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:run:read")
    assert ctx.db is not None
    stmt = (
        select(RunRecord, APP_USER.c.name)
        .outerjoin(APP_USER, RunRecord.created_by == cast(APP_USER.c.id, String(36)))
        .where(RunRecord.project_id == payload.project_id)
        # D215：高级搜索条件与项目/可见性谓词同一条 SQL（AND）。返回的是**单个**谓词组，
        # OR 模式自带括号，不会把 project_id 或 include_debug 的谓词吃进 OR 里。
        .where(REPORT_LIST_FILTER.parse(payload.filter))
    )
    if not payload.include_debug:
        # Review Focus 11：报告中心默认过滤 debug（调试过程去运行记录页看，不污染结论）
        stmt = stmt.where(RunRecord.trigger != "debug")
    if payload.subject_id:
        stmt = stmt.where(RunRecord.subject_id == payload.subject_id)
    if payload.subject_type:
        stmt = stmt.where(RunRecord.subject_type == payload.subject_type)
    if payload.trigger:
        stmt = stmt.where(RunRecord.trigger == payload.trigger)
    if payload.status:
        stmt = stmt.where(RunRecord.status == payload.status)
    if payload.env_id:
        stmt = stmt.where(RunRecord.env_id == payload.env_id)
    if payload.created_by:
        stmt = stmt.where(RunRecord.created_by == payload.created_by)
    since = _parse_iso(payload.since)
    until = _parse_iso(payload.until)
    # R70：排序键必须 COALESCE(started_at, created_at)。queued/running 与 1A 老行
    # started_at IS NULL，而 MySQL DESC 把 NULL 排最后 + 游标键吐 "" → 下一页必 400
    # bad_cursor（实测：e2e 库 113 行全是 NULL）。COALESCE 永不为 NULL（created_at
    # NOT NULL），_desc_conds 的 < 谓词因此也永远可判。对外仍回真 started_at：
    # 「没开始」如实显示「—」，但不再从时间线里消失。
    sort_key = func.coalesce(RunRecord.started_at, RunRecord.created_at)
    # D177：时间窗与排序键共用同一 COALESCE（workbench services.py 同尺）。窗口若用裸
    # started_at，NULL 开始行可排序却永不可命中——前端默认必带 since，queued/老行会
    # 从默认 7 天视图里静默消失。口径二处不一致才是本缺陷本体，故只允许一个 sort_key。
    if since:
        stmt = stmt.where(sort_key >= since)
    if until:
        stmt = stmt.where(sort_key <= until)
    stmt = stmt.order_by(sort_key.desc(), RunRecord.id.desc())
    # D47-b：cursor 与 current 二选一。同时给 = 调用方对「我在哪」递上来两套真相，
    # 悄悄择一会在两套对不上时把错位藏进翻页里，所以大声 400，不静默。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在排好序的同一个 stmt 上 OFFSET（R70：排序键仍是那条 COALESCE 单表达式，
        # 两制共用一条时间线，否则两页口径会各排各的）；键集模式一行不动。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate_desc(
            ctx.db, stmt, key_cols=[sort_key, RunRecord.id],
            row_key=lambda row: [(row[0].started_at or row[0].created_at).isoformat(), row[0].id],
            decode_key=lambda parts: [_decode_cursor_dt(str(parts[0])), str(parts[1])],
            cursor=payload.cursor, size=payload.size,
        )
    items = []
    for r, n in page.items:
        items.append(ReportListItemOut(
            id=r.id, subject_name=r.subject_name, subject_type=r.subject_type,
            trigger=r.trigger, env_name=r.env_name, created_by_name=n, status=r.status,
            stats=r.stats, pass_rate=_pass_rate(r.stats),
            elapsed_ms=r.elapsed_ms, started_at=iso_dt(r.started_at),
        ))
    # total 透传（D47-b）：键集路径 page.total 恒 None → _dump 不写这个键，响应逐字节不变；
    # 页码路径把 count_of 的筛选后总数带出去给页脚。
    return Page(items=items, next_cursor=page.next_cursor, total=page.total)


@service(
    perm="api:run:read", effect="read", name="report_get",
    description="报告详情：概要 + summary_graph 快照 + 步骤摘要（数据集步带 pass_rows/total_rows）+ 制品",
    http={"method": "GET", "path": "/reports/{run_id}", "tags": ["execution"]},
    resident=False,
)
async def report_get(payload: ReportGetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:run:read")
    assert ctx.db is not None
    row = (await ctx.db.execute(
        select(RunRecord, APP_USER.c.name)
        .outerjoin(APP_USER, RunRecord.created_by == cast(APP_USER.c.id, String(36)))
        .where(RunRecord.id == payload.run_id, RunRecord.project_id == payload.project_id)
    )).first()
    if row is None:
        raise ApiError("not_found", "报告不存在", 404, {"run_id": payload.run_id})
    r, n = row
    await settle_dead_run(ctx.db, r)  # 与 run_get 同一判据：报告中心也要给中断态上色（RF6）

    rows = (await ctx.db.execute(
        select(RunStepResult).where(RunStepResult.run_id == payload.run_id)
        .order_by(RunStepResult.step_key, RunStepResult.row_no)
    )).scalars().all()
    # 数据集步骤按节点折叠为 1 步（§8.6）：row_no=0 行承载节点状态与 kind；
    # row_no>0 的展开行贡献 pass_rows/total_rows。runner 可能只写展开行没有 base 行，
    # 所以 base 行缺失时节点状态由展开行归并（全部 pass → pass，否则取首个非 pass）。
    by_key: dict[str, dict] = {}
    for sr in rows:
        b = by_key.setdefault(sr.step_key, {
            "kind": sr.kind, "status": None, "parent_step_key": sr.parent_step_key,
            "subject_name": sr.subject_name, "elapsed_ms": sr.elapsed_ms,
            "attempts": sr.attempts, "pass_rows": 0,
            "total_rows": int(sr.row_total or 0), "row_statuses": [],
        })
        if sr.row_no > 0:
            b["total_rows"] = max(b["total_rows"], int(sr.row_total or 0))
            if sr.status == "pass":
                b["pass_rows"] += 1
        b["row_statuses"].append((sr.row_no, sr.status))
    steps: list[ReportStepSummary] = []
    for key, b in by_key.items():
        base = [s for rn, s in b["row_statuses"] if rn == 0]
        if base:
            status = base[0]
        else:  # 无 base 行：全部展开行决定节点状态
            expanded = [s for rn, s in b["row_statuses"] if rn > 0]
            if not expanded:
                status = b["row_statuses"][0][1]
            else:
                status = "pass" if all(s == "pass" for s in expanded) else next(
                    s for s in expanded if s != "pass")
        steps.append(ReportStepSummary(
            step_key=key, kind=b["kind"], status=status,
            parent_step_key=b["parent_step_key"], subject_name=b["subject_name"],
            elapsed_ms=b["elapsed_ms"], attempts=b["attempts"], row_no=0,
            pass_rows=b["pass_rows"] or None,
            total_rows=b["total_rows"] or None,
        ))

    arts = (await ctx.db.execute(
        select(RunArtifact).where(RunArtifact.run_id == payload.run_id)
        .order_by(RunArtifact.created_at)
    )).scalars().all()
    out = ReportGetOut(
        id=r.id, subject_name=r.subject_name, subject_type=r.subject_type,
        trigger=r.trigger, env_id=r.env_id, env_name=r.env_name, created_by_name=n,
        status=r.status, error=r.error, started_at=iso_dt(r.started_at),
        finished_at=iso_dt(r.finished_at), elapsed_ms=r.elapsed_ms, stats=r.stats,
        pass_rate=_pass_rate(r.stats),
        summary_graph=r.summary_graph,
        steps=steps,
        artifacts=[{"step_key": a.step_key, "kind": a.kind, "ref": a.ref,
                    "bytes": a.bytes, "created_at": iso_dt(a.created_at)} for a in arts],
    )
    return out


@service(
    perm="api:run:read", effect="read", name="report_step_detail",
    description="报告步骤明细：步骤 detail（request/response/断言/logs）+ vars_snapshot；"
                "response body/logs 超阈值时以 head + 制品 ref 替身呈现，未超阈值原样返回",
    http={"method": "GET", "path": "/reports/{run_id}/steps", "tags": ["execution"]},
    resident=False,
)
async def report_step_detail(payload: ReportStepDetailIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:run:read")
    assert ctx.db is not None
    # 跨项目 run_id 一律 404（与 report_get 同尺：不泄露存在性）
    run = (await ctx.db.execute(
        select(RunRecord.id).where(RunRecord.id == payload.run_id,
                                   RunRecord.project_id == payload.project_id)
    )).first()
    if run is None:
        raise ApiError("not_found", "报告不存在", 404, {"run_id": payload.run_id})
    sr = (await ctx.db.execute(
        select(RunStepResult).where(
            RunStepResult.run_id == payload.run_id,
            RunStepResult.step_key == payload.step_key,
            RunStepResult.row_no == payload.row_no,
        )
    )).scalars().first()
    if sr is None:
        raise ApiError("not_found", "步骤明细不存在", 404,
                       {"run_id": payload.run_id, "step_key": payload.step_key, "row_no": payload.row_no})
    return ReportStepDetailOut(
        step_key=sr.step_key, kind=sr.kind, status=sr.status, row_no=sr.row_no,
        parent_step_key=sr.parent_step_key, subject_name=sr.subject_name,
        elapsed_ms=sr.elapsed_ms, attempts=sr.attempts,
        vars_snapshot=sr.vars_snapshot, detail=sr.detail,
    )
