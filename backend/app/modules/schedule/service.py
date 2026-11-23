"""定时任务服务面（§11.4.17，1E T1）：CRUD + next_5 预览 + schedule.fire 触发体。

四条这里特有的口径：
- **cron 校验的形状（2026-11-16 实测，覆盖任务原文「ValueError → 422」旧口径）**：
  `crontab(*cron.split())` 单独用不够——① 4 段串（"0 2 * *"）被 celery 静默补位成
  5 段照收（用户写错段数会入库成一个「没打算要」的排期），所以段数必须自己数；
  ② 6 段带秒抛的是 TypeError（crontab.__init__() takes from 1 to 6 positional…）不是
  ValueError，只 except ValueError 会让它变 500。校验器 = 先 `len(parts) != 5 → 422`，
  再 `except (ValueError, TypeError)` 落 422 带 crontab 原话。
- **可见性显式按 project_id 过滤**：schedule_task 没有 project_public 列，
  shared/visibility 的 getattr(row, "project_public", True) 喂它会得到「每行都公开」
  （0018 静默失效教训，models.py docstring 同批记账）——本模块一律不喂 visibility。
- **subject_type 白名单（D30 只放 scenario；D226 增 plan；D229 增 plan_report）**，
  白名单在这里把守（显式拒绝不静默改值）。plan 分支的语义：到点把计划里每条可投递关联
  经 `plan_execute` 派发（REGISTRY 按名取，不横向 import testplan），回执带
  submitted/skipped 计数；plan_report 分支：到点经 `plan_report_create` 生成一份计划报告
  快照并推任务绑定渠道（报告订阅），回执带 report_id/计数/逐渠道结果。计划类主体
  都没有任务级环境可绑（每条关联各自带 env），带 env_id 的 plan 任务 422。
- **fire 体跨模块取数走表名 SQL**（R28 先例，同 notify 的引用检测）：scenario 名、
  创建者、环境名都不 import 领域模块——契约 1 由 lint-imports 白纸黑字守着。
  run 行的构造用 execution.services.new_run：execution 是底座（契约 4 只禁
  execution→modules 反向），正向 import 与 scenario 同款合法。
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from celery.schedules import crontab
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings
from app.core.errors import ApiError, OkOut, Page, paginate, paginate_page
from app.core.service import (
    ServiceResult,
    ctx_from_actor,
    ensure_project_access,
    notify_report,
    service,
    write_audit,
)
from app.modules.execution.services import new_run
from app.modules.schedule import schemas

# 校验闸/预览/展示日历的单一只在 cron.py（service 与 beat 共用一把尺；段序坑见其 docstring）
from app.modules.schedule.cron import DISPLAY_TZ, crontab_of, next_fire_times
from app.modules.schedule.models import ScheduleTask
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

# D240：定时任务页高级搜索（D47-a 三件套铺到本页）。白名单只收 schedule_task 上
# **真实存在且用户看得懂**的列：
# - `subject_id` 不进：页面「主体」列画的是对象名（查名单），不是 id；按 id 筛等于给
#   用户一个看不见的值开口子（task_center 同尺）。
# - `last_run` / `notify_channel_ids` 是 JSON 回执/引用列：没有稳定的标量比较语义，
#   摆成可筛字段只会得到「选了没反应」的假筛选项。
# - `project_id` 是取数机制参数，由 ensure_project_access 管，不能当业务筛选项。
# - `id` 不进：Ctrl+K ?q=<id> 直达已覆盖「找某一条」，再开一个筛口只会出现两套镜像。
SCHEDULE_LIST_FILTER = ListViewFilter(
    view_type="schedule",
    label="定时任务",
    fields={
        "name": FieldDecl(ScheduleTask.name, "text", "任务名称", nullable=False),
        "subject_type": FieldDecl(ScheduleTask.subject_type, "enum", "主体类型", nullable=False),
        "cron": FieldDecl(ScheduleTask.cron, "text", "cron 表达式", nullable=False),
        "enabled": FieldDecl(ScheduleTask.enabled, "number", "启用（1/0）", nullable=False),
        "env_id": FieldDecl(ScheduleTask.env_id, "id", "环境"),
        "consecutive_failures": FieldDecl(ScheduleTask.consecutive_failures, "number",
                                          "连续失败次数", nullable=False),
        "created_by": FieldDecl(ScheduleTask.created_by, "id", "创建人"),
        "updated_by": FieldDecl(ScheduleTask.updated_by, "id", "更新人"),
        "created_at": FieldDecl(ScheduleTask.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(ScheduleTask.updated_at, "time", "更新时间", nullable=False),
    },
)
register(SCHEDULE_LIST_FILTER)

# D30 白名单原只允许 scenario；D226 增 plan（计划定时执行）；D229 增 plan_report
# （定时生成计划报告 = MS 的「报告订阅」：到点生成快照并推绑定渠道）。表列是复数语义，服务面收窄。
SUBJECT_TYPES = ("scenario", "plan", "plan_report")
# 主体类型 → 展示名（422 文案与回执共用；与 SUBJECT_TYPES 同步由下面的 assert 钉住）。
SUBJECT_LABELS = {"scenario": "场景", "plan": "测试计划", "plan_report": "计划报告"}
assert frozenset(SUBJECT_LABELS) == frozenset(SUBJECT_TYPES)


def _check_cron(cron: str) -> crontab:
    """5 段式硬校验 → 返回 crontab 对象（实现与三条实测坑的单一只在 cron.py：
    段数闸、异常形状 (ValueError, TypeError)、**关键字段序**——celery 位置参数序是
    分 时 **周 日** 月，`crontab(*parts)` 会把「0 2 * * 1」（每周一）错排成每年 1 号）。"""
    return crontab_of(cron)


def _check_subject_type(subject_type: str) -> None:
    if subject_type not in SUBJECT_TYPES:
        raise ApiError("validation_failed",
                       "定时任务主体只支持场景（scenario）、测试计划（plan）或计划报告（plan_report），"
                       "收到：" + subject_type,
                       422, {"subject_type": subject_type, "allowed": list(SUBJECT_TYPES)})


def _check_env_binding(subject_type: str, env_id: str | None) -> None:
    """计划类主体不绑环境：计划内每条关联各自带 env（只有 scenario 有任务级环境）。

    plan_report 同理：报告是计划的状态快照，环境由关联行各自决定。显式 422 而不是
    静默丢弃——收下一个永远不会被读的 env_id，等于给用户一个「绑了环境」的假象
    （判据 1：有写入方、没有真相）。
    """
    if subject_type in ("plan", "plan_report") and env_id:
        raise ApiError("validation_failed",
                       "测试计划任务不绑定环境（计划内每条关联各自带环境），请清空 env_id",
                       422, {"subject_type": subject_type, "env_id": env_id})


def _out(row: ScheduleTask) -> schemas.TaskOut:
    return schemas.TaskOut(
        id=row.id, project_id=row.project_id, name=row.name,
        subject_type=row.subject_type, subject_id=row.subject_id, cron=row.cron,
        env_id=row.env_id, enabled=row.enabled,
        notify_channel_ids=list(row.notify_channel_ids or []),
        last_run=row.last_run, consecutive_failures=row.consecutive_failures,
        created_at=_iso(row.created_at), updated_at=_iso(row.updated_at),
    )


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


async def _task(db: AsyncSession, project_id: str, task_id: str) -> ScheduleTask:
    """按 (id, project_id) 双条件取行——跨项目同 id 与不存在同 404，不泄露存在性。"""
    row = (await db.execute(select(ScheduleTask).where(
        ScheduleTask.id == task_id, ScheduleTask.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "定时任务不存在", 404, {"task_id": task_id})
    return row


# ── next_5 预览（§11.4.17 抽屉「预览未来 5 次」，读未落库草稿也算） ──────────────
#
# 算法（start+ffwd 直取 celery 的「ref 之后第一次」+ fire+1s 推进参考点，单调性由构造
# 保证）与它的两条实测坑住在 cron.next_fire_times——与 beat 的读表共用同一把尺，不抄第二份。


def _parse_base(raw: str | None) -> datetime:
    """预览参考点：缺省=当前 UTC；ISO 串——naive 视为 UTC（库内存储约定），aware 尊重偏移。"""
    if not raw:
        return datetime.now(UTC)
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError as e:
        raise ApiError("validation_failed", "base 必须是 ISO 8601 时刻：" + raw, 422,
                       {"base": raw}) from e
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


# ── CRUD（perm 三段式 schedule:task:*，读类 :read 结尾——READONLY glob 尺） ──────


@service(
    perm="schedule:task:create", effect="write", name="schedule_task_create",
    description="创建定时任务（cron 入库前 5 段校验，非法 422 带 crontab 原话；"
                "subject_type 支持 scenario / plan / plan_report，计划类主体不绑任务级"
                "环境——D226/D229）",
    http={"method": "POST", "path": "/schedule-tasks", "tags": ["schedule"], "status": 201},
    tool=False, resident=False,
)
async def schedule_task_create(payload: schemas.TaskCreateIn, ctx) -> schemas.TaskOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("schedule:task:create")
    assert ctx.db is not None
    _check_cron(payload.cron)
    _check_subject_type(payload.subject_type)
    _check_env_binding(payload.subject_type, payload.env_id)
    row = ScheduleTask(
        project_id=payload.project_id, name=payload.name,
        subject_type=payload.subject_type, subject_id=payload.subject_id,
        cron=payload.cron, env_id=payload.env_id, enabled=payload.enabled,
        notify_channel_ids=list(payload.notify_channel_ids),
        created_by=ctx.user_id, updated_by=ctx.user_id,
    )
    ctx.db.add(row)
    await ctx.db.commit()
    return _out(row)


@service(
    perm="schedule:task:read", effect="read", name="schedule_task_list",
    description="列出项目内定时任务（显式按 project_id 过滤——表无 project_public 列，"
                "不许喂 visibility 助手；enabled 可选过滤；filter 高级搜索条件组，D240）",
    http={"method": "GET", "path": "/schedule-tasks", "tags": ["schedule"]},
    resident=False,
)
async def schedule_task_list(payload: schemas.TaskListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("schedule:task:read")
    assert ctx.db is not None
    # 可见性尺：表上没有 project_public，visible_clause 会按「每行公开」放行——
    # 这里必须显式 project_id 过滤（models.py docstring 同款记账）。
    stmt = select(ScheduleTask).where(ScheduleTask.project_id == payload.project_id)
    if payload.enabled is not None:
        stmt = stmt.where(ScheduleTask.enabled == payload.enabled)
    # D240：高级搜索条件组是同一个 WHERE 里的一整个谓词（OR 组自带括号），与 enabled
    # 快捷轴 AND；放在 order_by 之前，翻页接着筛出来的集合走。
    stmt = stmt.where(SCHEDULE_LIST_FILTER.parse(payload.filter))
    stmt = stmt.order_by(ScheduleTask.id)
    # D47-b：cursor 与 current 二选一（同 report_list）。「我在哪」的两套真相一起到场
    # 是调用方的 bug，静默择一会把错位藏进翻页里，所以大声 400，不静默。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.current is not None:
        # 页码模式在同一个已排序 stmt 上 OFFSET：ORDER BY 与键集模式逐字同一条
        # （ScheduleTask.id，判据 5——两制各排各的就不是同一份列表）。
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate(ctx.db, stmt, cursor_col=ScheduleTask.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    # total 透传（D47-b）：键集路径 page.total 恒 None → _dump 不写这个键，现有消费方
    # 的响应逐字节不变；页码路径把筛选后总数带给页脚。
    return Page(items=[_out(r) for r in page.items], next_cursor=page.next_cursor,
                total=page.total)


@service(
    perm="schedule:task:read", effect="read", name="schedule_task_get",
    description="获取单个定时任务（含 last_run 回执与连续失败计数）",
    http={"method": "GET", "path": "/schedule-tasks/{task_id}", "tags": ["schedule"]},
    resident=False,
)
async def schedule_task_get(payload: schemas.TaskGetIn, ctx) -> schemas.TaskOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("schedule:task:read")
    assert ctx.db is not None
    return _out(await _task(ctx.db, payload.project_id, payload.task_id))


@service(
    perm="schedule:task:update", effect="write", name="schedule_task_update",
    description="更新定时任务（cron 改动同样过 5 段校验；enabled 开关即启停调度）",
    http={"method": "PATCH", "path": "/schedule-tasks/{task_id}", "tags": ["schedule"]},
    tool=False, resident=False,
)
async def schedule_task_update(payload: schemas.TaskUpdateIn, ctx) -> schemas.TaskOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("schedule:task:update")
    assert ctx.db is not None
    row = await _task(ctx.db, payload.project_id, payload.task_id)
    # 先全量校验后落值：一条非法字段不许把行改成半新半旧
    if payload.cron is not None:
        _check_cron(payload.cron)
    if payload.subject_type is not None:
        _check_subject_type(payload.subject_type)
    # 环境校验看「改完之后的类型」（改类型与环境一起提交也要被拦）；不看 payload 单项。
    next_type = payload.subject_type or row.subject_type
    _check_env_binding(next_type, payload.env_id)
    if payload.name is not None:
        row.name = payload.name
    if payload.subject_type is not None:
        row.subject_type = payload.subject_type
        if payload.subject_type in ("plan", "plan_report"):
            # 切到计划类主体：旧的场景级环境对新主体没有意义，显式清掉（GET 即刻可见，
            # 不是留一个孤儿 env_id 让读面各自猜）。PATCH 无法用 null 解绑，所以清空
            # 必须由这里做——先校验后落值，非法提交不会走到这行。
            row.env_id = None
    if payload.subject_id is not None:
        row.subject_id = payload.subject_id
    if payload.cron is not None:
        row.cron = payload.cron
    if payload.env_id is not None:
        row.env_id = payload.env_id
    if payload.enabled is not None:
        row.enabled = payload.enabled
    if payload.notify_channel_ids is not None:
        row.notify_channel_ids = list(payload.notify_channel_ids)
    row.updated_by = ctx.user_id
    await ctx.db.commit()
    return _out(row)


@service(
    perm="schedule:task:delete", effect="destructive", name="schedule_task_delete",
    description="删除定时任务（调度真相在读表侧，删行即停排——无本地状态要清理）",
    http={"method": "POST", "path": "/schedule-tasks/{task_id}/delete", "tags": ["schedule"]},
    tool=False, resident=False,
)
async def schedule_task_delete(payload: schemas.TaskGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("schedule:task:delete")
    assert ctx.db is not None
    row = await _task(ctx.db, payload.project_id, payload.task_id)
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="schedule:task:read", effect="read", name="schedule_task_next_5",
    description="预览未来 5 次触发时刻（§11.4.17 抽屉：保存前也能算——读草稿 cron 不落库；"
                "UTC 进 Shanghai 日历出，5 个时刻严格递增；cron 非法同样 422）",
    http={"method": "POST", "path": "/schedule-tasks/next-5", "tags": ["schedule"]},
    resident=False,
)
async def schedule_task_next_5(payload: schemas.Next5In, ctx) -> schemas.Next5Out:
    # payload 带 project_id → build_ctx 走项目权限门；预览是读类动作，perm 以 :read 结尾
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("schedule:task:read")
    base = _parse_base(payload.base)
    times = next_fire_times(payload.cron, base)
    return schemas.Next5Out(
        cron=payload.cron,
        times=[t.astimezone(DISPLAY_TZ).isoformat() for t in times],
    )


# ── schedule.fire 触发体（worker 任务体在任务体内 import 这里；R142/R144） ────────
#
# 语义（计划 R144）：定时触发没有人格化操作者——审计 entry="schedule"、user_id NULL、
# action="schedule_task.run"；run 行的 actor = 任务创建者快照（engine 的 api_case/环境
# 解析以创建者身份过权限门，创建者已删除时 actor=None，engine 有「缺少发起人身份」
# 的人话报错兜底）。零执行逻辑：建 run 行 + send_task "scenario.run" + 回执落 last_run。
#
# 跨模块取数全走表名 SQL（R28 先例，同 notify 引用检测）：scenario/environment/app_user
# 一张都不 import——契约 1 白纸黑字，lint-imports 守着。

FIRE_TASK_NAME = "schedule.fire"
SCENARIO_RUN_TASK_NAME = "scenario.run"


def _celery_client():
    """按名字投递用的惰性 Celery 客户端（形状同 orchestration._celery_client）。

    不复用 app.worker.celery_app：schedule 模块 import 它等于把 worker 的整条依赖链
    拖进来（且测试要能换成 spy——fire 的投递必须可 monkeypatch）。
    """
    from celery import Celery

    s = get_settings()
    c = Celery("testpilot-schedule", broker=s.redis_url, backend=s.redis_url)
    c.conf.update(task_serializer="json", accept_content=["json"],
                  broker_transport_options={"max_retries": 0})
    return c


def _task_session():
    """一副 NullPool 引擎用完即弃（形状同 orchestration._task_session）。

    solo 池每任务一个 asyncio.run、pytest 每用例一个新循环——asyncmy 连接绑死首次
    使用的 loop，全局 sessionmaker 的连接池跨循环必炸 "attached to a different loop"。
    """
    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    return eng, async_sessionmaker(bind=eng, expire_on_commit=False, autoflush=False,
                                   class_=AsyncSession)


async def _scenario_brief(db: AsyncSession, project_id: str,
                          scenario_id: str) -> tuple[str, str] | None:
    """场景名 + status（表名 SQL，不 import scenario）；行不存在 → None。"""
    row = (await db.execute(
        text("SELECT name, status FROM scenario WHERE id=:s AND project_id=:p"),
        {"s": scenario_id, "p": project_id})).first()
    return (str(row[0]), str(row[1])) if row is not None else None


async def _env_name(db: AsyncSession, project_id: str, env_id: str) -> str | None:
    row = (await db.execute(
        text("SELECT name FROM environment WHERE id=:e AND project_id=:p"),
        {"e": env_id, "p": project_id})).scalar_one_or_none()
    return str(row) if row is not None else None


async def _creator_actor(db: AsyncSession, created_by: str | None) -> dict | None:
    """创建者身份快照（表名 SQL 读 app_user）；创建者已删除 → None（engine 兜底报错）。

    perms 口径复刻 build_ctx：系统管理员 {"*"}，其余给空集——引擎服务里的
    ensure_project_access 会按 (user, project) 现查重填，这里伪造权限集就是撒谎。
    """
    if not created_by:
        return None
    row = (await db.execute(
        text("SELECT name, is_system_admin FROM app_user WHERE id=:u"),
        {"u": created_by})).first()
    if row is None:
        return None
    is_admin = bool(row[1])
    return {"user_id": created_by, "user_name": str(row[0]),
            "is_system_admin": is_admin, "perms": ["*"] if is_admin else [],
            "entry": "schedule"}


async def update_last_run(db: AsyncSession, row: ScheduleTask | None, receipt: dict) -> None:
    """回执落 last_run（计划 T1「update_last_run 回执」；flush 不 commit，时机归调用方）。"""
    if row is None:
        return
    row.last_run = receipt


# ── D226：plan 主体的 fire 支路 ────────────────────────────────────────────────
#
# 语义：到点把计划整批投递一遍，投递面**复用 plan_execute**（testplan 的 @service），
# 经 REGISTRY 按名取——schedule 不横向 import testplan（契约 1），也不抄一份逐条派发
# 逻辑（两套判定 = 两份会各自漂移的真相）。计划级不建外层 run：计划执行是 N 条子 run
# 的聚合，run_record 没有 plan 主体类型；回执里带 submitted/skipped 计数。

PLAN_EXECUTE_SERVICE = "plan_execute"


async def _plan_brief(db: AsyncSession, project_id: str,
                      plan_id: str) -> tuple[str, bool] | None:
    """计划名 + archived（表名 SQL，不 import testplan）；行不存在 → None。"""
    row = (await db.execute(
        text("SELECT name, archived FROM plan_record WHERE id=:p AND project_id=:proj"),
        {"p": plan_id, "proj": project_id})).first()
    return (str(row[0]), bool(row[1])) if row is not None else None


async def _fire_plan(db: AsyncSession, *, task_id: str, project_id: str,
                     plan_id: str, created_by: str | None) -> dict[str, Any]:
    """计划任务到点触发：校验计划 → 以创建者身份调 plan_execute → 回执落 last_run。"""
    fresh = datetime.now(UTC).isoformat()
    brief = await _plan_brief(db, project_id, plan_id)
    reason: str | None = None
    actor = None
    out = None
    if brief is None:
        reason = "计划不存在，未投递"
    elif brief[1]:
        reason = "计划已归档，未投递——归档是终态，请改绑别的计划"
    else:
        actor = await _creator_actor(db, created_by)
        if actor is None:
            reason = "任务创建者已删除，无法以创建者身份投递"
    if reason is None:
        from app.core.registry import REGISTRY

        spec = REGISTRY.get(PLAN_EXECUTE_SERVICE)
        if spec is None:  # pragma: no cover - create_app 后必然在册
            reason = PLAN_EXECUTE_SERVICE + " 未注册（服务尚未初始化完成）"
        else:
            ctx = ctx_from_actor(actor, db)
            try:
                out = await spec.handler(
                    spec.model.model_validate({"project_id": project_id, "plan_id": plan_id}), ctx)
            except ApiError as e:
                reason = e.message
            except Exception as e:  # noqa: BLE001 - 回执必须说得出话，worker 不许炸红
                reason = "计划执行派发失败：" + str(e)[:180]
    if out is None:
        receipt: dict[str, Any] = {"ok": False, "reason": reason, "fired_at": fresh}
        diff = {"task_id": task_id, "subject_type": "plan", "plan_id": plan_id, "error": reason}
    else:
        receipt = {"ok": True, "plan_id": plan_id, "submitted": out.submitted,
                   "skipped": out.skipped, "fired_at": fresh}
        diff = {"task_id": task_id, "subject_type": "plan", "plan_id": plan_id,
                "submitted": out.submitted, "skipped": out.skipped}
    row = await db.get(ScheduleTask, task_id)
    await update_last_run(db, row, receipt)
    await write_audit(db, user_id=None, action="schedule_task.run", target=project_id,
                      ok=bool(receipt["ok"]), diff=diff, entry="schedule")
    await db.commit()
    return receipt


# ── D229：plan_report 主体的 fire 支路（定时生成计划报告 = 报告订阅） ─────────────
#
# 语义：到点把计划**当下的状态**做成一份报告快照（plan_report_create），再把摘要推给
# 任务绑定的通知渠道（notify_report 走 core 钩子，schedule 不 import notify）。
# 三条判断：
#  1. **生成复用 plan_report_create**（REGISTRY 按名取）：报告与实时状态同一份口径是
#     那条服务的既有保证；这里另写一份取数 = 第二份会漂移的真相。
#  2. **归档计划照样出报告**（与 plan_report_create 判断 3 逐字同源）：归档封的是
#     「继续执行它」，不封「给它的历史出凭证」——所以 plan 任务 409 的规则不搬到这。
#  3. **报告先成立、通知后发生**：报告行已 commit 才调钩子；通知失败只体现在回执
#     channels/notified 上，不会把「报告没生成」这种假话写进 last_run。

PLAN_REPORT_SERVICE = "plan_report_create"


async def _fire_report(db: AsyncSession, *, task_id: str, project_id: str, plan_id: str,
                       created_by: str | None,
                       channel_ids: list[str]) -> dict[str, Any]:
    """计划报告任务到点触发：校验计划 → 以创建者身份生成报告 → 推渠道 → 回执落 last_run。"""
    fresh = datetime.now(UTC).isoformat()
    brief = await _plan_brief(db, project_id, plan_id)
    reason: str | None = None
    actor = None
    out = None
    if brief is None:
        reason = "计划不存在，未生成报告"
    else:
        actor = await _creator_actor(db, created_by)
        if actor is None:
            reason = "任务创建者已删除，无法以创建者身份生成报告"
    if reason is None:
        from app.core.registry import REGISTRY

        spec = REGISTRY.get(PLAN_REPORT_SERVICE)
        if spec is None:  # pragma: no cover - create_app 后必然在册
            reason = PLAN_REPORT_SERVICE + " 未注册（服务尚未初始化完成）"
        else:
            ctx = ctx_from_actor(actor, db)
            try:
                out = await spec.handler(
                    spec.model.model_validate({"project_id": project_id, "plan_id": plan_id}), ctx)
            except ApiError as e:
                reason = e.message
            except Exception as e:  # noqa: BLE001 - 回执必须说得出话，worker 不许炸红
                reason = "报告生成失败：" + str(e)[:180]
    if out is None:
        receipt: dict[str, Any] = {"ok": False, "reason": reason, "fired_at": fresh}
        diff: dict[str, Any] = {"task_id": task_id, "subject_type": "plan_report",
                                "plan_id": plan_id, "error": reason}
    else:
        # 报告已 commit（plan_report_create 的「大声失败」事务边界）：从这里往下，
        # 无论通知成什么样，回执都必须说「报告生成了」。
        report = {"id": out.id, "plan_id": plan_id, "plan_name": brief[0], "name": out.name,
                  "status": out.status, "total": out.total, "passed": out.passed,
                  "failed": out.failed, "executed": out.executed,
                  "not_executed": out.not_executed, "pass_rate": out.pass_rate,
                  "execute_rate": out.execute_rate}
        channels = await notify_report(db, project_id=project_id, report=report,
                                       channel_ids=channel_ids)
        notified = any(bool(c.get("ok")) for c in channels)
        receipt = {"ok": True, "plan_id": plan_id, "report_id": out.id,
                   "report_name": out.name, "status": out.status, "total": out.total,
                   "passed": out.passed, "failed": out.failed,
                   "executed": out.executed, "not_executed": out.not_executed,
                   "notified": notified, "channels": channels, "fired_at": fresh}
        if not channel_ids:
            receipt["reason"] = "未绑定通知渠道"
        elif not channels:
            # 绑了渠道却零回执 = 通知钩子自身异常（core.notify_report 吞异常后返回 []）：
            # 不许冒充「未绑定通知渠道」，报告仍是真生成的。
            receipt["reason"] = "通知发送异常（已记日志），报告已生成"
        diff = {"task_id": task_id, "subject_type": "plan_report", "plan_id": plan_id,
                "report_id": out.id, "total": out.total, "passed": out.passed,
                "notified": notified}
    row = await db.get(ScheduleTask, task_id)
    await update_last_run(db, row, receipt)
    await write_audit(db, user_id=None, action="schedule_task.run", target=project_id,
                      ok=bool(receipt["ok"]), diff=diff, entry="schedule")
    await db.commit()
    return receipt


async def fire_task(task_id: str) -> dict[str, Any]:
    """到点触发：读任务行 → 按主体类型派发 → 回执。

    - scenario（D30）：建 run（trigger="schedule"）→ 投 scenario.run → 回执。
    - plan（D226）：以创建者身份调 plan_execute（逐条投递，见 _fire_plan）→ 计数回执。
    - plan_report（D229）：以创建者身份调 plan_report_create 生成快照 → 摘要推任务绑定
      渠道（见 _fire_report）→ 回执带 report_id/计数/逐渠道结果。

    供 worker 的 schedule.fire 任务体调用（worker 模块级不 import schedule）。
    幂等防重入靠 beat 侧（D22：错过不补、单 beat 实例）；这里对「行已删除/停用」
    只回一句人话回执——beat 与 worker 之间没有锁，编锁就是顺手加 scope。
    投递失败：删 run 行不留孤儿 queued（R42 同款），失败回执落 last_run、
    审计落 ok=False——fire_task 本身不抛（solo 池里炸一条定时不该让 worker 记红账，
    真相都在 last_run 与审计里）。
    """
    eng, maker = _task_session()
    try:
        async with maker() as db:
            row = (await db.execute(select(ScheduleTask).where(
                ScheduleTask.id == task_id))).scalar_one_or_none()
            if row is None:
                return {"ok": False, "reason": "任务已删除"}
            if not row.enabled:
                return {"ok": False, "reason": "任务已停用"}
            project_id, cron = row.project_id, row.cron  # 先取标量：commit 过期实例
            if row.subject_type == "plan":
                return await _fire_plan(db, task_id=task_id, project_id=project_id,
                                        plan_id=row.subject_id, created_by=row.created_by)
            if row.subject_type == "plan_report":
                return await _fire_report(db, task_id=task_id, project_id=project_id,
                                          plan_id=row.subject_id, created_by=row.created_by,
                                          channel_ids=list(row.notify_channel_ids or []))
            brief = await _scenario_brief(db, project_id, row.subject_id)
            if brief is None or brief[1] != "normal":
                # WHY: status 只有 normal/recycled 两态（scenario/models.py）——回收态既存在也没删，
                # 与「不存在」是两件真事各说各的；把回收态演成 absence，用户会去找回收站而非恢复/改绑。
                reason = ("场景不存在，未投递" if brief is None
                          else "场景在回收站，未投递——恢复场景或改绑别的场景")
                receipt = {"ok": False, "reason": reason,
                           "fired_at": datetime.now(UTC).isoformat()}
                fresh = await db.get(ScheduleTask, task_id)
                await update_last_run(db, fresh, receipt)
                await write_audit(db, user_id=None, action="schedule_task.run",
                                  target=project_id, ok=False,
                                  diff={"task_id": task_id, "error": receipt["reason"]},
                                  entry="schedule")
                await db.commit()
                return receipt
            env_name = None
            if row.env_id:
                env_name = await _env_name(db, project_id, row.env_id)
            actor = await _creator_actor(db, row.created_by)
            rec = await new_run(db, project_id=project_id, subject_type="scenario",
                                subject_id=row.subject_id, subject_name=brief[0],
                                env_id=row.env_id, env_name=env_name,
                                trigger="schedule", created_by=row.created_by,
                                request_snapshot={"schedule_task_id": task_id})
            rid = rec.id  # 先取标量（commit/rollback 过期实例，同 scenario_run 的坑账）
            await db.commit()
            try:
                _celery_client().send_task(SCENARIO_RUN_TASK_NAME, args=[rid, actor],
                                           queue=get_settings().task_queue)
            except Exception as e:
                orphan = await db.get(type(rec), rid)
                if orphan is not None:
                    await db.delete(orphan)  # 行是这次触发建的，删它不伤任何人（R42）
                receipt = {"ok": False, "reason": "投递失败：" + str(e)[:180],
                           "fired_at": datetime.now(UTC).isoformat()}
                fresh = await db.get(ScheduleTask, task_id)
                await update_last_run(db, fresh, receipt)
                await write_audit(db, user_id=None, action="schedule_task.run",
                                  target=project_id, ok=False,
                                  diff={"task_id": task_id, "error": receipt["reason"]},
                                  entry="schedule")
                await db.commit()
                return receipt
            receipt = {"ok": True, "run_id": rid,
                       "fired_at": datetime.now(UTC).isoformat()}
            fresh = await db.get(ScheduleTask, task_id)
            await update_last_run(db, fresh, receipt)
            await write_audit(db, user_id=None, action="schedule_task.run",
                              target=project_id, ok=True,
                              diff={"task_id": task_id, "run_id": rid, "cron": cron},
                              entry="schedule")
            await db.commit()
            return receipt
    finally:
        await eng.dispose()
