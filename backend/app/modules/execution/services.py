"""运行记录服务：写入口 save_run / new_run + 查询 @service（§13；1B 报告中心升级）。

契约 4：execution 不 import 其他 modules —— created_by_name 用表名 join app_user；
租约键（Review Focus 6）用 get_bus().exists_key(...) 自己拼字符串。键名与
scenario.engine.events.lease_key 存在于两处是契约 4 的直接代价，test_execution_worker
的字符串相等测试钉死两处同步改（改一边必红）。
"""
from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field
from sqlalchemy import String, cast, select

from app.core.errors import ApiError, Page, paginate_desc, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.execution.models import RunRecord
from app.modules.execution.timefmt import APP_USER, iso_dt

# 跨模块协议：与 scenario.engine.events.lease_key 的构造必须逐字相等（测试钉死）
LEASE_KEY_PREFIX = "run.lease."
# T9 词表：queued/running 由 enqueue 写入，cancelled 由 runner 写入（1A 只有终态三态）
RUN_STATUS_PATTERN = "^(queued|running|passed|failed|error|cancelled)$"
# 1C T11（R112）：subject_type 词表。库里 run_record.subject_type 是自由 String，
# 1B 只写过前三类，1C 起 ui_case 真会出现——列表不给这个条件，UI 运行就会
# 「出现在列表里却筛不出来」。词表与前端 shared/runVocab 的 SUBJECT_TYPES 同源
# （runVocab.test.ts 从本文件抠 pattern 对表）。1D T7：adb_case 加入（同一课重演一次）。
SUBJECT_TYPE_PATTERN = "^(api_definition|api_case|scenario|ui_case|adb_case)$"


class RunListIn(BaseModel):
    project_id: str
    subject_id: str | None = None
    # 与 RunRecord.trigger 注释同一张词表（R46）：曾经允许库里从不写的 "case"、却拒绝
    # 模型自己声明的 manual/webhook，1B 一写 manual 就会被自己的列表接口 422。
    trigger: str | None = Field(default=None, pattern="^(debug|manual|schedule|agent|webhook)$")
    # T9：执行链走 worker 后库里真会写 queued/running/cancelled——不放宽就筛不出「运行中」
    status: str | None = Field(default=None, pattern=RUN_STATUS_PATTERN)
    # 1C T11：对象类型筛选（R112）；非法值 422，不静默忽略——静默忽略等于用户
    # 以为筛过了，列表却还是全量，那是「筛了个寂寞」的假绿。
    subject_type: str | None = Field(default=None, pattern=SUBJECT_TYPE_PATTERN)
    cursor: str | None = None
    # current（D47-b）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径（徽标 size=1、api.tsx 逐行取最近一次都走这条，形状不许变）；
    # 与 cursor 互斥，两者同时到场在 handler 里 400（判据同 report_list）。
    current: int | None = None
    size: int = Field(default=20, ge=1, le=200)


class RunGetIn(BaseModel):
    project_id: str
    run_id: str


class RunOut(BaseModel):
    id: str
    subject_type: str
    subject_id: str
    # D141：列是 NOT NULL 快照（models.py:22「对象删除后仍可读」，迁移 0009 起从未放宽），
    # _base_out 永远填得上。此前契约写成 str | None，逼出前端两句假兜底
    # （「名字为空 = 对象已删除」既不可达也不成立）——收紧成 str，兜底全删。
    subject_name: str
    env_name: str | None = None
    trigger: str
    status: str
    status_code: int | None = None
    elapsed_ms: int | None = None
    error: str | None = None
    created_at: str | None = None
    created_by_name: str | None = None
    # 1B 报告中心：真实执行窗口与统计（1A 老记录为 None）
    started_at: str | None = None
    finished_at: str | None = None
    stats: dict | None = None


class RunDetailOut(RunOut):
    request_snapshot: dict | None = None
    response_snapshot: dict | None = None
    assertions: list | None = None


async def settle_dead_run(db, rec: RunRecord) -> bool:
    """running 而租约键已消失 = 执行进程中断（Review Focus 6）。返回是否改写了状态。

    worker 被杀后 run 不能永远 running：画布上的死节点、报告里的假「执行中」都比
    一句「执行进程中断」坏得多。判据只有 Redis 键在不在——TTL 与 max_runtime 同量级，
    活着的人必然在续租（T6 renew_lease）。

    总线本身故障时**不判中断**（返回 False）：观测通道坏了不该反过来杀死一个可能还
    活着的 run——误杀一个健康执行比放过一个僵尸难查得多（僵尸至少还会被 TTL 兜住）。
    """
    if rec.status != "running":
        return False
    from app.core.eventbus import get_bus

    try:
        alive = await get_bus().exists_key(LEASE_KEY_PREFIX + rec.id)
    except Exception:
        return False
    if alive:
        return False
    rec.status = "error"
    rec.error = "执行进程中断"
    rec.finished_at = datetime.now(UTC).replace(tzinfo=None)
    await db.commit()
    return True


def _base_out(r: RunRecord, name: str | None) -> dict:
    return dict(id=r.id, subject_type=r.subject_type, subject_id=r.subject_id,
                subject_name=r.subject_name, env_name=r.env_name, trigger=r.trigger,
                status=r.status, status_code=r.status_code, elapsed_ms=r.elapsed_ms,
                error=r.error, created_at=r.created_at.isoformat() if r.created_at else None,
                created_by_name=name, started_at=iso_dt(r.started_at), finished_at=iso_dt(r.finished_at),
                stats=r.stats)


@service(
    perm="api:run:read", effect="read", name="run_record_list",
    description="分页查询运行记录（列表不带响应体；过滤 subject_id/subject_type/trigger/status）",
    http={"method": "GET", "path": "/runs", "tags": ["execution"]},
    resident=False,
)
async def run_record_list(payload: RunListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:run:read")
    assert ctx.db is not None
    stmt = (
        select(RunRecord, APP_USER.c.name)
        .outerjoin(APP_USER, RunRecord.created_by == cast(APP_USER.c.id, String(36)))
        .where(RunRecord.project_id == payload.project_id)
    )
    if payload.subject_id:
        stmt = stmt.where(RunRecord.subject_id == payload.subject_id)
    if payload.subject_type:
        stmt = stmt.where(RunRecord.subject_type == payload.subject_type)
    if payload.trigger:
        stmt = stmt.where(RunRecord.trigger == payload.trigger)
    if payload.status:
        stmt = stmt.where(RunRecord.status == payload.status)
    # 最新在前：列表徽标取 size=1 即最近一次；同秒记录用 id 兜底，翻页不重不漏
    stmt = stmt.order_by(RunRecord.created_at.desc(), RunRecord.id.desc())
    # D47-b：cursor 与 current 二选一（同 report_list）。「我在哪」的两套真相一起到场
    # 是调用方的 bug，静默择一会把错位藏进翻页里，所以大声 400，不静默。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在同一个已排序 stmt 上 OFFSET：ORDER BY 与键集模式逐字同一条
        # （created_at desc, id desc，判据 5——两制各排各的就不是同一份列表）。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate_desc(
            ctx.db, stmt, key_cols=[RunRecord.created_at, RunRecord.id],
            row_key=lambda row: [row[0].created_at.isoformat(), row[0].id],
            decode_key=lambda parts: [datetime.fromisoformat(str(parts[0])), str(parts[1])],
            cursor=payload.cursor, size=payload.size,
        )
    # total 透传（D47-b）：键集路径 page.total 恒 None → _dump 不写这个键，徽标等
    # 现有消费方的响应逐字节不变；页码路径把筛选后总数带给页脚。
    return Page(items=[RunOut(**_base_out(r, n)) for r, n in page.items],
                next_cursor=page.next_cursor, total=page.total)


@service(
    perm="api:run:read", effect="read", name="run_get",
    description="单条运行记录详情（含请求/响应快照与断言明细）",
    http={"method": "GET", "path": "/runs/{run_id}", "tags": ["execution"]},
    resident=False,
)
async def run_get(payload: RunGetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:run:read")
    assert ctx.db is not None
    row = (await ctx.db.execute(
        select(RunRecord, APP_USER.c.name)
        .outerjoin(APP_USER, RunRecord.created_by == cast(APP_USER.c.id, String(36)))
        .where(RunRecord.id == payload.run_id, RunRecord.project_id == payload.project_id)
    )).first()
    if row is None:
        raise ApiError("not_found", "运行记录不存在", 404, {"run_id": payload.run_id})
    r, n = row
    await settle_dead_run(ctx.db, r)  # 查询即自愈：running 但租约已失 → error（RF6）
    return RunDetailOut(**_base_out(r, n), request_snapshot=r.request_snapshot,
                        response_snapshot=r.response_snapshot, assertions=r.assertions)


async def new_run(db, *, project_id: str, subject_type: str, subject_id: str,
                  subject_name: str, env_id: str | None, env_name: str | None,
                  trigger: str, created_by: str | None,
                  max_runtime_ms: int | None = None,
                  request_snapshot: dict | None = None) -> RunRecord:
    """场景执行 run 的出生：status=queued（flush 不 commit，提交时机归调用方）。

    与 save_run 的分工是口径而非历史包袱：save_run 从 RunResult 判终态（1A 单请求调试，
    写完即终态）；new_run 只造 queued 行，终态由 runner 的执行结果回写——「status 由
    执行决定」，所以这两个构造点都不会自己撒谎。

    request_snapshot（T11 裁定①）：scenario_debug 把未保存的 {graph, variables,
    fail_fast} 随 run 行出生——queued 的语义由此自包含，worker 领取时不必也不该
    再读 scenario 行（场景行可能已被改/删，「执行了什么」以入队时的快照为准）。
    """
    rec = RunRecord(project_id=project_id, subject_type=subject_type, subject_id=subject_id,
                    subject_name=subject_name, env_id=env_id, env_name=env_name,
                    trigger=trigger, status="queued", created_by=created_by,
                    max_runtime_ms=max_runtime_ms, request_snapshot=request_snapshot)
    db.add(rec)
    await db.flush()
    return rec


async def save_run(db, *, project_id: str, subject_type: str, subject_id: str,
                   subject_name: str | None, env_id: str | None, env_name: str | None,
                   trigger: str, result, request_snapshot: dict, created_by: str,
                   started_at: datetime | None = None, finished_at: datetime | None = None,
                   stats: dict | None = None, summary_graph: dict | None = None,
                   max_runtime_ms: int | None = None) -> RunRecord:
    """运行历史的构造点之一（commit 由调用方负责）。result = execution.core.RunResult。

    1A 的调用方不传终态字段（单接口调试没有步骤树），1B 场景执行传全：
    写入口保持唯一，避免两处各自决定 status 口径（1A Review Focus 的教训）。
    场景批执行的出生走 new_run（queued），本函数只管「写完即终态」的单请求调试。
    """
    status = "error" if not result.ok else ("passed" if result.passed() else "failed")
    resp = None
    if result.status is not None:
        resp = {"status": result.status, "headers": result.headers, "elapsed_ms": result.elapsed_ms,
                "truncated": result.truncated, "body_size": result.body_size}
        if result.body_text is not None:
            resp["body_text"] = result.body_text
    rec = RunRecord(project_id=project_id, subject_type=subject_type, subject_id=subject_id,
                    subject_name=subject_name, env_id=env_id, env_name=env_name,
                    trigger=trigger, status=status, status_code=result.status,
                    elapsed_ms=result.elapsed_ms, request_snapshot=request_snapshot,
                    response_snapshot=resp, assertions=result.assertions or None,
                    error=result.error, created_by=created_by,
                    started_at=started_at, finished_at=finished_at, stats=stats,
                    summary_graph=summary_graph, max_runtime_ms=max_runtime_ms)
    db.add(rec)
    await db.flush()
    return rec
