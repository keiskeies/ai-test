"""任务中心 @service（D196）：项目级运行观测、排队位次、停止与重跑。

数据源 = `run_record`（表名反射，不 import execution）；排队位次读 Celery 的 Redis 队列
（`send_task(task_id=run_id)` 之后，队列消息的 headers.id 就是 run id）。
背景任务（导入/导出）目前是同步的，没有独立表；这里只报运行 record，不编造后台队列。
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import column, func, or_, select, table

from app.core.config import get_settings
from app.core.errors import ApiError, Page, paginate_page
from app.core.eventbus import get_bus
from app.core.registry import REGISTRY
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.taskcenter import schemas
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

APP_USER = table("app_user", column("id"), column("name"), column("account"))
RUN = table(
    "run_record",
    column("id"), column("project_id"), column("subject_type"), column("subject_id"),
    column("subject_name"), column("env_name"), column("trigger"), column("status"),
    column("elapsed_ms"), column("error"), column("created_by"), column("created_at"),
    column("started_at"), column("finished_at"), column("cancel_requested"), column("stats"),
)
STEP = table("run_step_result", column("run_id"), column("status"))

# D239：任务中心高级搜索（D47-a 三件套铺到本页）。字段白名单只收 run_record 上
# **真实存在且用户看得懂**的列：
# - `queue_position` / `can_stop` / `can_rerun` 是读时算出来的展示量（Celery 队列位次、
#   状态派生的按钮开关），不是列；`cancel_requested` 是 worker 协作旗、列表里不展示，
#   拿它当筛选项等于给一个页面上看不见的状态开口子。
# - `id` 不进白名单：页头 keyword 已同时搜名称与 run id，重复一份只会出现
#   「两个框搜同一列、结果却不一样」这类说不清的镜面。
# - `project_id` 是取数机制参数，由 ensure_project_access 管，不能当业务筛选项。
TASK_LIST_FILTER = ListViewFilter(
    view_type="task_center",
    label="任务中心",
    fields={
        "subject_name": FieldDecl(RUN.c.subject_name, "text", "任务名称", nullable=False),
        "subject_type": FieldDecl(RUN.c.subject_type, "enum", "任务类型", nullable=False),
        "trigger": FieldDecl(RUN.c.trigger, "enum", "触发方式", nullable=False),
        "status": FieldDecl(RUN.c.status, "enum", "状态", nullable=False),
        "env_name": FieldDecl(RUN.c.env_name, "text", "环境"),
        "elapsed_ms": FieldDecl(RUN.c.elapsed_ms, "number", "耗时（ms）"),
        "error": FieldDecl(RUN.c.error, "text", "错误信息"),
        "created_by": FieldDecl(RUN.c.created_by, "id", "触发人"),
        "created_at": FieldDecl(RUN.c.created_at, "time", "创建时间", nullable=False),
        "started_at": FieldDecl(RUN.c.started_at, "time", "开始时间"),
        "finished_at": FieldDecl(RUN.c.finished_at, "time", "结束时间"),
    },
)
register(TASK_LIST_FILTER)

ACTIVE = ("queued", "running")
TERMINAL = schemas.TERMINAL


async def _names(db, ids: set[str | None]) -> dict[str, str]:
    real = {i for i in ids if i}
    if not real:
        return {}
    rows = (await db.execute(select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(real)))).all()
    return {r.id: r.name for r in rows}


async def _run(db, project_id: str, run_id: str):
    row = (await db.execute(select(RUN).where(RUN.c.id == run_id, RUN.c.project_id == project_id))).first()
    if row is None:
        raise ApiError("not_found", "运行不存在", 404, {"run_id": run_id})
    return row


def _out(r: Any, names: dict[str, str], positions: dict[str, int] | None = None) -> schemas.TaskOut:
    pos = (positions or {}).get(r.id)
    return schemas.TaskOut(
        id=r.id, project_id=r.project_id, subject_type=r.subject_type,
        subject_id=r.subject_id, subject_name=r.subject_name, env_name=r.env_name,
        trigger=r.trigger, status=r.status, elapsed_ms=r.elapsed_ms, error=r.error,
        created_by=r.created_by, created_by_name=names.get(r.created_by or ""),
        created_at=schemas.iso(r.created_at), started_at=schemas.iso(r.started_at),
        finished_at=schemas.iso(r.finished_at),
        cancel_requested=bool(r.cancel_requested),
        queue_position=pos,
        can_stop=r.status in ACTIVE and not r.cancel_requested,
        can_rerun=r.status in TERMINAL,
    )


async def _queue_positions(ids: list[str]) -> tuple[dict[str, int], int, bool]:
    """返回 (run_id→位次, 队列长度, Redis 是否可用)。位次 1 起。"""
    if not ids:
        return {}, 0, True
    try:
        client = get_bus().client
        queue = get_settings().task_queue
        raw = await client.lrange(queue, 0, -1)
    except Exception:
        return {}, 0, False
    wanted = set(ids)
    positions: dict[str, int] = {}
    for idx, item in enumerate(raw):
        try:
            msg = json.loads(item) if isinstance(item, (str, bytes)) else item
            tid = (msg.get("headers") or {}).get("id")
        except (TypeError, ValueError):
            continue
        if tid in wanted and tid not in positions:
            positions[str(tid)] = idx + 1
    return positions, len(raw), True


@service(
    perm="task:center:read", effect="read", name="task_summary",
    description="项目任务概览（各状态计数、活跃数、通过率、平均耗时）",
    http={"method": "GET", "path": "/task-center/summary", "tags": ["task"]},
)
async def task_summary(payload: schemas.TaskSummaryIn, ctx) -> schemas.TaskSummaryOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("task:center:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(RUN.c.status, func.count()).where(
        RUN.c.project_id == payload.project_id).group_by(RUN.c.status))).all()
    counts = {s: int(n) for s, n in rows}
    passed = counts.get("passed", 0)
    executed = passed + counts.get("failed", 0) + counts.get("error", 0)
    avg = (await ctx.db.execute(select(func.avg(RUN.c.elapsed_ms)).where(
        RUN.c.project_id == payload.project_id,
        RUN.c.status.in_(TERMINAL),
        RUN.c.elapsed_ms.is_not(None)))).scalar_one()
    return schemas.TaskSummaryOut(
        total=sum(counts.values()), queued=counts.get("queued", 0),
        running=counts.get("running", 0), passed=passed,
        failed=counts.get("failed", 0), error=counts.get("error", 0),
        cancelled=counts.get("cancelled", 0),
        active=counts.get("queued", 0) + counts.get("running", 0),
        pass_rate=round(passed * 100.0 / executed, 2) if executed else 0,
        avg_elapsed_ms=int(avg) if avg is not None else None,
    )


@service(
    perm="task:center:read", effect="read", name="task_list",
    description="任务列表（运行中/已结束、域/触发/关键词筛选；页码分页）",
    http={"method": "GET", "path": "/task-center/tasks", "tags": ["task"]},
)
async def task_list(payload: schemas.TaskListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("task:center:read")
    assert ctx.db is not None
    stmt = select(RUN).where(RUN.c.project_id == payload.project_id)
    if payload.state == "active":
        stmt = stmt.where(RUN.c.status.in_(ACTIVE))
    elif payload.state == "finished":
        stmt = stmt.where(RUN.c.status.in_(TERMINAL))
    if payload.subject_type:
        stmt = stmt.where(RUN.c.subject_type == payload.subject_type)
    if payload.trigger:
        stmt = stmt.where(RUN.c.trigger == payload.trigger)
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(RUN.c.subject_name.like(kw), RUN.c.id.like(kw)))
    # D239：高级搜索与上面的快捷筛选同一层 AND；条件进 SQL（不在页内过滤），
    # 所以下面的 total 与翻页都吃同一份集合。空条件 = None，等价于没传。
    stmt = stmt.where(TASK_LIST_FILTER.parse(payload.filter))
    stmt = stmt.order_by(RUN.c.created_at.desc(), RUN.c.id.desc())
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    rows = page.items
    names = await _names(ctx.db, {r.created_by for r in rows})
    queued = [r.id for r in rows if r.status == "queued"]
    positions, _, _ = await _queue_positions(queued)
    return Page(items=[_out(r, names, positions) for r in rows],
                next_cursor=None, total=page.total)


@service(
    perm="task:center:read", effect="read", name="task_queue",
    description="排队视图（项目内 queued run + 队列位次与队列总长；Redis 不可用如实报）",
    http={"method": "GET", "path": "/task-center/queue", "tags": ["task"]},
)
async def task_queue(payload: schemas.TaskQueueIn, ctx) -> schemas.TaskQueueOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("task:center:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(RUN).where(
        RUN.c.project_id == payload.project_id,
        RUN.c.status == "queued").order_by(RUN.c.created_at, RUN.c.id))).all()
    names = await _names(ctx.db, {r.created_by for r in rows})
    positions, length, available = await _queue_positions([r.id for r in rows])
    items = [_out(r, names, positions) for r in rows]
    items.sort(key=lambda x: (x.queue_position is None, x.queue_position or 0, x.created_at or ""))
    return schemas.TaskQueueOut(available=available, queue_length=length, items=items)


@service(
    perm="task:center:read", effect="read", name="task_detail",
    description="任务详情（run_record 头 + 统计 + 步骤状态计数）",
    http={"method": "GET", "path": "/task-center/tasks/{run_id}", "tags": ["task"]},
)
async def task_detail(payload: schemas.TaskGetIn, ctx) -> schemas.TaskDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("task:center:read")
    assert ctx.db is not None
    r = await _run(ctx.db, payload.project_id, payload.run_id)
    names = await _names(ctx.db, {r.created_by})
    positions, _, _ = await _queue_positions([r.id] if r.status == "queued" else [])
    base = _out(r, names, positions)
    steps = (await ctx.db.execute(select(STEP.c.status, func.count()).where(
        STEP.c.run_id == r.id).group_by(STEP.c.status))).all()
    return schemas.TaskDetailOut(
        **base.model_dump(), stats=r.stats,
        step_counts={s: int(n) for s, n in steps},
    )


@service(
    perm="task:center:stop", effect="write", name="task_stop",
    description="停止排队/运行中的任务（复用 run_cancel 的域权限与取消旗）",
    http={"method": "POST", "path": "/task-center/tasks/{run_id}/stop", "tags": ["task"]},
)
async def task_stop(payload: schemas.TaskStopIn, ctx) -> schemas.TaskStopOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("task:center:stop")
    assert ctx.db is not None
    r = await _run(ctx.db, payload.project_id, payload.run_id)
    if r.status not in ACTIVE:
        raise ApiError("already_finished", "任务已结束（" + r.status + "），无需停止", 409,
                       {"run_id": r.id, "status": r.status})
    spec = REGISTRY.get("run_cancel")
    assert spec is not None
    out = await spec.handler(spec.model.model_validate({
        "project_id": payload.project_id, "run_id": payload.run_id,
    }), ctx)
    return schemas.TaskStopOut(ok=True, status=getattr(out, "status", r.status))


@service(
    perm="task:center:run", effect="write", name="task_rerun",
    description="按原任务类型重新执行（场景/UI 用例/ADB 用例；其余类型如实 422）",
    http={"method": "POST", "path": "/task-center/tasks/{run_id}/rerun", "tags": ["task"]},
)
async def task_rerun(payload: schemas.TaskRerunIn, ctx) -> schemas.TaskRerunOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("task:center:rerun")
    assert ctx.db is not None
    r = await _run(ctx.db, payload.project_id, payload.run_id)
    if r.subject_type == "scenario":
        spec = REGISTRY.get("scenario_run")
        body = {"project_id": payload.project_id, "scenario_id": r.subject_id, "env_id": r.env_id}
    elif r.subject_type == "ui_case":
        spec = REGISTRY.get("ui_case_run")
        body = {"project_id": payload.project_id, "case_id": r.subject_id}
    elif r.subject_type == "adb_case":
        spec = REGISTRY.get("adb_case_run")
        body = {"project_id": payload.project_id, "case_id": r.subject_id}
    else:
        raise ApiError("rerun_unsupported",
                       "该任务类型（" + r.subject_type + "）暂不支持从任务中心重跑", 422,
                       {"subject_type": r.subject_type})
    assert spec is not None
    out = await spec.handler(spec.model.model_validate(body), ctx)
    return schemas.TaskRerunOut(run_id=out.run_id, status=getattr(out, "status", "queued"))


@service(
    perm="task:center:stop", effect="write", name="task_batch_stop",
    description="批量停止排队/运行中的任务（逐条复用 run_cancel；已结束的跳过，缺 id 整批 404）",
    http={"method": "POST", "path": "/task-center/tasks/batch-stop", "tags": ["task"]},
)
async def task_batch_stop(payload: schemas.TaskBatchStopIn, ctx) -> schemas.TaskBatchStopOut:
    """D237：MS `/task/center/stop/batch` 的等价物。

    分账口径（与单条 stop 的差异写在前面，避免两处规则漂移）：
    1. **缺 id / 跨项目 id → 404 且整批零写入**（与 batch-update / batch-copy 同一把尺：
       请求里点到的东西有一半不存在时，不能悄悄只做存在的那半）。
    2. **已结束 / 已在取消中 → skipped**：单条 stop 对已结束回 409（用户点错了要告知），
       批量里这类行是选择集的常态（列表停在页上，任务自己跑完了），逐条 409 会让整批
       变成不可用；skip 计数 + `skipped_ids` 一样说清，不静默。
    3. **逐条失败不回滚**：每条 run_cancel 自己 commit（取消旗 + 队列摘除），批量不假装
       有跨行事务；`failed` 带 code/message，调用方按条处理。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("task:center:stop")
    assert ctx.db is not None
    ids = list(dict.fromkeys(payload.run_ids))  # 去重保序：同一 run 点两次只算一条
    rows = (await ctx.db.execute(select(RUN).where(
        RUN.c.project_id == payload.project_id, RUN.c.id.in_(ids)))).all()
    found = {r.id: r for r in rows}
    missing = [i for i in ids if i not in found]
    if missing:
        raise ApiError("not_found", "部分任务不存在，整批未停止", 404, {"run_ids": missing})
    spec = REGISTRY.get("run_cancel")
    assert spec is not None
    out = schemas.TaskBatchStopOut()
    for rid in ids:
        r = found[rid]
        if r.status not in ACTIVE or r.cancel_requested:
            out.skipped += 1
            out.skipped_ids.append(rid)
            continue
        try:
            await spec.handler(spec.model.model_validate(
                {"project_id": payload.project_id, "run_id": rid}), ctx)
        except ApiError as e:
            out.failed.append(schemas.TaskBatchFailure(
                run_id=rid, code=e.code, message=e.message))
            continue
        out.stopped += 1
        out.stopped_ids.append(rid)
    return out
