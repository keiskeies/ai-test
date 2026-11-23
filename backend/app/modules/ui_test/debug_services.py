"""UI 用例的执行出口（计划 T9）：`ui_case_resolve` + 独立用例调试/执行端点。

三件事住一个文件，因为它们共享同一条执行链（resolve → run_ui → 落库三件套），
拆开只会制造三份漂移的「怎么算 passed」：

- **`ui_case_resolve`**（内部件，`http=None`）：把 UI 用例解析成驱动器认识的形状
  （commands / elements / variables / base_url）。与 `api_case_resolve` 一对一镜像：
  **跑不了回 `executable=False` + `reason`，绝不 422**——「跑不了」是数据事实不是请求
  非法（`api_test/schemas.py:303-305` 的既有口径；引擎据此把步骤标 error 写进报告，
  而不是炸掉整场执行）。`base_url` **不是列**（实测 `Environment` 没有 base_url 列）：
  R105/D3 裁定 URL 走环境变量 `${base_url}`，所以这里从**解析后的变量**里读。
  base_url 缺失而命令是相对 `open` → 仍然 `executable=True` + `base_url=None`：
  缺 base URL 是**运行期**的定位问题（`open` 命令自己会在 message 里说「打开 /ui/…」
  这种坏 URL / 报错），不是 resolve 期的资产问题——在 resolve 期拦，等于替驱动器
  宣告它算不出的结论。
- **`ui_case_debug`**（进程内，api_debug 同档）：不投 worker，请求内 await 跑完返回。
  落 `run_record(subject_type="ui_case", trigger="debug")` + R102 的
  「一命令一行 `run_step_result` + 一个 `case` 汇总节点」+ `summary_graph` 单节点图 +
  制品入库。**debug 绝不回写 `ui_case.last_run_*`**（调试是过程不是结论，
  orchestration._run_claimed 同款裁定；report_list 默认也过滤 debug）。
- **`ui_case_run`**（投 worker）：R42 按名字投递 `ui_case.run`，web 侧不 import 引擎；
  先探 broker → 落 queued 行 → send，投不出去删行 503，绝不留孤儿 queued。
  worker 任务体（`app/worker.py`）复用**同一个** `_execute_ui_run`，trigger 是唯一差别。

**契约 1 的代价说破**：ui_test 不许 import scenario，所以 broker 探针 / NullPool
task session / run_end 事件 / 租约键这几件与 `scenario/orchestration.py`、
`scenario/engine/events.py` 同形的件在本文件**自带一份**（同 `execution/services.py`
对 `run.lease.` 前缀的先例）。键名必须与 scenario 侧逐字相等：取消键 `cancel.<run_id>`
（scenario 的 `run_cancel` 端点据此能停 UI run）、租约键 `run.lease.<run_id>`
（`settle_dead_run` 据此判「执行进程中断」）。

并发闸 `ui_run_gate()`（对计划 Interfaces 那句「进程级 asyncio.Semaphore」的**实测修正**，
2026-11-16 复测）：信号量若有 waiter 排队时事件循环关闭，会被那次 acquire **永久绑死**
在旧 loop 上，同进程下一个 `asyncio.run` 里任何 `async with` 直接
`RuntimeError: ... is bound to a different event loop`——而 worker 的真实形态恰是
`--pool=solo` 下每任务一个 `asyncio.run`，模块级信号量在第二个任务的第二次重叠起就炸。
所以闸**按事件循环缓存**：`WeakKeyDictionary` 以 running loop 为键（普通 dict 会把每代
loop 的闸泄漏到进程终老）。语义不变：**每事件循环、每进程**限 `ui_concurrency` 路并发，
**跨进程不共享**；`--pool=solo` 下同一时刻只有一个 loop 在跑，所以默认 4 是有效默认
而不是摆设（这条必须写进手册）。

Debug 出参刻意**不是** `DebugOut` 形状：`DebugPanel.tsx:7-20` 是 HTTP 载荷
（status/headers/body_text），UI 运行没有这些东西，塞假值就是撒谎（§13 纪律 1）。
跨面板真正共享的是 **R108 断言行契约** `{type,passed,expected,actual,error,path}`——
`ui_core` 产出的行原样进 `commands[]`，一个键不改；T17 的 UiDebugPanel 读命令时间线。
"""
from __future__ import annotations

import asyncio
import os
import socket
import time
import weakref
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.service import ctx_from_actor, ensure_project_access, service, trigger_from_entry
from app.modules.execution.artifacts import save_artifact
from app.modules.execution.models import RunEvent, RunRecord
from app.modules.execution.services import new_run
from app.modules.ui_test.case_services import _case, _element_ids
from app.modules.ui_test.models import STATUS_RECYCLED, UiCase, UiElement
from app.shared.visibility import assert_row_visible

UI_RUN_TASK_NAME = "ui_case.run"
# 与 scenario/engine/events.py 逐字相等的跨模块键（docstring 有账）
_CANCEL_KEY = "cancel."
_LEASE_KEY = "run.lease."
LEASE_TTL_S = 90
TERMINAL = ("passed", "failed", "error", "cancelled")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


# —— 并发闸：每事件循环一个信号量，见模块 docstring 的实测修正 ————————

_GATES: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary())


class _GateCtx:
    """`async with ui_run_gate()`：按 running loop 取/建信号量。

    限流值是**该 loop 首次建闸时**的 `get_settings().ui_concurrency`；运行中改配置
    不追溯已建的闸（改设置要重启 worker 才全量生效——这是诚实边界，不是缺陷）。
    """

    def __init__(self) -> None:
        self._sem: asyncio.Semaphore | None = None

    async def __aenter__(self) -> None:
        loop = asyncio.get_running_loop()
        sem = _GATES.get(loop)
        if sem is None:
            sem = asyncio.Semaphore(max(1, get_settings().ui_concurrency))
            _GATES[loop] = sem
        self._sem = sem
        await sem.acquire()

    async def __aexit__(self, *exc: Any) -> None:
        assert self._sem is not None
        self._sem.release()


def ui_run_gate() -> _GateCtx:
    """并发闸：`async with ui_run_gate():` 包住一次 UI 执行。

    **每事件循环、每进程**限 `ui_concurrency`（默认 4）路并发，**跨进程不共享**。
    Celery `--pool=solo` 下同一时刻只有一个 loop 活着（worker 每任务一个 `asyncio.run`），
    所以「每 loop」=「每进程当下」，默认 4 是真实生效的默认而不是摆设。
    闸按 loop 缓存在 `WeakKeyDictionary`（普通 dict 会把每代 loop 的闸泄漏到进程终老）。
    不许「简化」回模块级 Semaphore——tests/test_ui_debug.py::test_gate_survives_loop_era_change
    是这条的回归钉：模块级信号量在 waiter 排队时 loop 关闭后，会被那次 acquire 永久
    绑死在旧 loop 上，下一次 `asyncio.run` 里 `async with` 直接 RuntimeError（实测复现）。
    """
    return _GateCtx()


# —— 注册表小件：env_resolve 只经 REGISTRY（契约 1：绝不 import app.modules.env） ——


async def _env_via_registry(ctx, project_id: str, env_id: str | None) -> dict[str, Any]:
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("env_resolve")
    if spec is None:
        raise ApiError("internal_error", "env_resolve 未注册（服务尚未初始化完成）", 500)
    out = await spec.handler(spec.model.model_validate(
        {"project_id": project_id, "env_id": env_id}), ctx)
    data = out.model_dump()
    return {"vars": {str(k): str(v) for k, v in data["vars"]},
            "env_name": data.get("env_name") or None}


# ══════════════════════════ resolve（内部件） ══════════════════════════


class UiCaseResolveIn(BaseModel):
    project_id: str
    case_id: str


class UiCaseResolveOut(BaseModel):
    """UI 用例的**有效**执行形态（与 CaseResolveOut 同族语义，docstring 见模块头）。"""

    case_id: str
    case_name: str
    priority: str = "P2"
    env_id: str | None = None
    env_name: str | None = None
    commands: list[dict] = Field(default_factory=list)
    elements: dict[str, dict] = Field(default_factory=dict)  # id → {name, locator_type, locator}
    variables: dict[str, str] = Field(default_factory=dict)
    base_url: str | None = None
    executable: bool = True
    reason: str | None = None


# commands 是**列表**（§7.2 扁平命令序列），当年声明手滑写成 dict：dict 一路传给
# UiCaseResolveOut.commands 与 run_ui(commands=...)，两处都报「dict 不是 list」。
# 改声明，两处下游错误随之消失——运行期本来就是 list，只是类型在说谎。
async def _resolve_parts(db, ctx, c: UiCase) -> tuple[dict[str, dict], dict[str, str], list[dict],
                                                      str | None, str | None, list[str]]:
    """共用解析：返回 (elements, variables, commands, base_url, env_name, problems)。

    problems 非空 = executable=False 的素材（点名到元素名/id）。不抛——resolve 的
    不可执行是返回值，不是异常。
    """
    commands = [s for s in (c.steps or []) if isinstance(s, dict)]
    env = await _env_via_registry(ctx, c.project_id, c.env_id)
    variables = env["vars"]
    ids = _element_ids(c.steps)
    elements: dict[str, dict] = {}
    problems: list[str] = []
    if ids:
        rows = (await db.execute(select(UiElement).where(
            UiElement.project_id == c.project_id, UiElement.id.in_(ids)))).scalars().all()
        found = {e.id: e for e in rows}
        for i in ids:
            e = found.get(i)
            if e is None:
                problems.append("element_id " + i + " 在本项目里不存在（可能已被彻底删除）："
                                "引用它的命令没有定位目标")
            elif e.status == STATUS_RECYCLED:
                problems.append("元素「" + e.name + "」在回收站里（" + e.id + "）："
                                "先恢复它，或在这一步改用别的元素")
            else:
                elements[e.id] = {"name": e.name, "locator_type": e.locator_type,
                                  "locator": e.locator}
    base_url = variables.get("base_url")
    return elements, variables, commands, base_url, env["env_name"], problems


@service(
    perm="ui:case:read", effect="read", name="ui_case_resolve",
    description="解析 UI 用例的有效执行形态（命令/元素/变量/base_url）；"
                "不可执行回 executable=False + reason，绝不 422；供执行链与调试端点内部调用",
    http=None, tool=False, resident=False,
)
async def ui_case_resolve(payload: UiCaseResolveIn, ctx) -> UiCaseResolveOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:read")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "UI 用例不存在（在回收站）", 404, {"case_id": c.id})
    elements, variables, commands, base_url, env_name, problems = await _resolve_parts(
        ctx.db, ctx, c)
    return UiCaseResolveOut(
        case_id=c.id, case_name=c.name, priority=c.priority, env_id=c.env_id,
        env_name=env_name, commands=commands, elements=elements, variables=variables,
        base_url=base_url, executable=not problems,
        reason="；".join(problems) if problems else None)


# ══════════════════════════ 执行体（debug 与 worker 共用） ══════════════════════════


def _owner() -> str:
    return "ui-worker-" + socket.gethostname() + "-" + str(os.getpid())


async def _renew_lease(bus: Any, run_id: str, owner: str) -> bool:
    key = _LEASE_KEY + run_id
    cur = await bus.get_key(key)
    if cur is not None and cur != owner:
        return False
    await bus.set_key(key, owner, ttl=LEASE_TTL_S)
    return True


async def _release_lease(bus: Any, run_id: str, owner: str) -> None:
    key = _LEASE_KEY + run_id
    if await bus.get_key(key) == owner:
        await bus.del_key(key)


async def _publish(db: Any, bus: Any, run_id: str, type_: str, payload: dict) -> None:
    """先落 run_event + commit 再广播（R47 顺序）；与 scenario events 同信封形状。"""
    from sqlalchemy import func

    last = await db.scalar(select(func.max(RunEvent.seq)).where(RunEvent.run_id == run_id))
    ts = _now()
    row = RunEvent(run_id=run_id, seq=int(last or 0) + 1, type=type_, payload=payload or {},
                   ts=ts)
    db.add(row)
    await db.commit()
    await bus.publish("run." + run_id, {"seq": row.seq,
                                        "ts": ts.replace(tzinfo=UTC).isoformat(),
                                        "type": type_, "payload": payload or {}})


def _run_status(result: Any) -> tuple[str, str | None]:
    """UiResult → run 终态。两层词表（同 runner._top_status 的尺子）：
    cancelled > error（没跑成）> failed（跑成了但没过）> passed。"""
    rows = result.commands or []
    if any(r.get("status") == "cancelled" for r in rows):
        return "cancelled", "运行已被取消"
    if not result.ok:
        return "error", (result.error or "执行核异常")[:300]
    if any(r.get("status") == "error" for r in rows):
        bad = next(r for r in rows if r.get("status") == "error")
        return "error", str(bad.get("message") or "存在 error 命令")[:300]
    if not result.passed:
        bad = next((r for r in rows if r.get("status") == "fail"), None)
        return "failed", str((bad or {}).get("message") or "断言未通过")[:300]
    if result.error:  # 全过但有说出口的账（如制品溢出）：结论仍按跑成的来
        return "passed", None
    return "passed", None


_CASE_STATUS = {"passed": "pass", "failed": "fail", "error": "error", "cancelled": "cancelled"}


async def _execute_ui_run(db: Any, rec: RunRecord, *, actor: Mapping | None, bus: Any) -> dict:
    """领取 queued 的 ui_case run 并跑完：闸内 run_ui → R102 落库 → run_end。

    调用方给 db session 与已确认 status=queued 的行；本函数负责 running→终态、
    commit、run_end、租约、非 debug 的 last_run_* 回写。返回终态摘要 dict（worker 无返回值需求）。
    """
    from app.modules.execution.ui_core import run_ui

    run_id = rec.id
    owner = _owner()
    settings = get_settings()
    if not await _renew_lease(bus, run_id, owner):
        return {"status": rec.status, "skipped": "lease_held"}
    actor_ctx = ctx_from_actor(actor, db)
    try:
        case = await db.get(UiCase, rec.subject_id)
        if case is None or case.status == STATUS_RECYCLED:
            rec.status = "error"
            rec.error = "UI 用例不存在或已被回收，无法执行"
            rec.finished_at = _now()
            await db.commit()
            await _publish(db, bus, run_id, "run_end", {"status": "error",
                                                        "message": rec.error})
            return {"status": "error"}
        elements, variables, commands, base_url, env_name, problems = await _resolve_parts(
            db, actor_ctx, case)
        if problems:
            # 跑不了 = error（resolve 的 executable=False 在执行侧的落点：是**数据事实**
            # 进了 run 记录，不是 422——debug 点按钮的人看到的也是这条 error 行）。
            # 命令一行都不跑，但按 R102 逐行留 skip 痕迹，报告页指得出「差在哪一步之前」。
            rec.env_name = env_name or rec.env_name
            rec.status = "running"
            rec.started_at = _now()
            rec.lease_owner = owner
            await db.commit()
            reason = "；".join(problems)
            for s in (case.steps or []):
                if isinstance(s, dict):
                    await _write_step(db, run_id, str(s.get("id") or "?"), status="skip",
                                      kind=str(s.get("type") or "?"), parent_step_key="case",
                                      subject_name=case.name,
                                      detail={"message": "用例不可执行，未执行"})
            await _write_step(db, run_id, "case", status="error", kind="ui_case",
                              subject_name=case.name, elapsed_ms=0,
                              detail={"commands": [], "vars": {}, "error": reason,
                                      "artifacts": []})
            stats = {"total": len(case.steps or []), "pass": 0, "fail": 0,
                     "skip": len(case.steps or []), "error": 0, "cancelled": 0,
                     "elapsed_ms": 0, "rows_total": 0}
            rec.status = "error"
            rec.error = ("用例不可执行：" + reason)[:300]
            rec.elapsed_ms = 0
            rec.finished_at = _now()
            rec.stats = stats
            rec.summary_graph = {"version": 1, "edges": [], "nodes": [{
                "key": "case", "kind": "ui_case", "name": case.name, "config": {},
                "result": {"status": "error", "message": reason[:300]}}]}
            await db.commit()
            await _publish(db, bus, run_id, "run_end",
                           {"status": "error", "stats": stats, "message": reason[:300]})
            if rec.trigger != "debug":  # 真执行才回写「最近结果」（error 也是结论）
                c2 = await db.get(UiCase, rec.subject_id)
                if c2 is not None:
                    c2.last_run_at = _now()
                    c2.last_run_status = "error"
                    await db.commit()
            return {"status": "error", "run_id": run_id, "result": None,
                    "artifacts": [], "elapsed_ms": 0, "env_name": env_name,
                    "message": reason[:300]}
        rec.env_name = env_name or rec.env_name
        rec.status = "running"
        rec.started_at = _now()
        rec.lease_owner = owner
        await db.commit()
        max_runtime = int(rec.max_runtime_ms or settings.ui_default_max_runtime_ms)

        async def should_cancel() -> bool:
            # 每命令边界 + sleep 切片都会打到这里：顺手续租，活着的人不会被打断标「中断」
            await _renew_lease(bus, run_id, owner)
            return await bus.exists_key(_CANCEL_KEY + run_id)

        t0 = time.perf_counter()
        async with ui_run_gate():
            result = await run_ui(
                commands, elements=elements, variables=variables, base_url=base_url,
                headless=settings.ui_headless, browser_channel=settings.ui_browser_channel,
                timeout_ms=settings.ui_command_timeout_ms, max_runtime_ms=max_runtime,
                should_cancel=should_cancel)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        status, message = _run_status(result)

        # R102：一命令一行（step_key=命令 id、kind=命令 type、parent=case 汇总节点）
        counts = {"pass": 0, "fail": 0, "skip": 0, "error": 0, "cancelled": 0}
        for r in result.commands or []:
            st = str(r.get("status") or "error")
            if st in counts:
                counts[st] += 1
            await _write_step(
                db, run_id, str(r.get("id") or "?"), status=st, kind=str(r.get("type") or "?"),
                parent_step_key="case", subject_name=case.name,
                elapsed_ms=int(r.get("elapsed_ms") or 0),
                detail={"message": r.get("message"), "assertions": r.get("assertions") or []})
        art_refs = []
        for a in result.artifacts or []:
            ref = await save_artifact(db, project_id=rec.project_id, run_id=run_id,
                                      kind=str(a.get("kind") or "SCREENSHOT"),
                                      blob=a.get("blob") or b"", step_key=str(a.get("step_id")))
            art_refs.append({"kind": str(a.get("kind")), "step_key": str(a.get("step_id")),
                             "ref": ref, "bytes": len(a.get("blob") or b""),
                             "reason": a.get("reason")})
        case_status = _CASE_STATUS[status]
        await _write_step(
            db, run_id, "case", status=case_status, kind="ui_case", subject_name=case.name,
            elapsed_ms=elapsed_ms, vars_snapshot=dict(result.vars or {}),
            detail={"commands": result.commands or [], "vars": dict(result.vars or {}),
                    "error": result.error, "artifacts": art_refs})
        stats = {"total": len(result.commands or []), **counts, "elapsed_ms": elapsed_ms,
                 "rows_total": 0}
        rec.status = status
        rec.elapsed_ms = elapsed_ms
        rec.finished_at = _now()
        rec.stats = stats
        rec.summary_graph = {"version": 1, "edges": [], "nodes": [{
            "key": "case", "kind": "ui_case", "name": case.name, "config": {},
            "result": {"status": case_status, "message": message}}]}
        if message and status != "passed":
            rec.error = message
        await db.commit()
        await _publish(db, bus, run_id, "run_end",
                       {"status": status, "stats": stats, "message": message})
        # 终态回写冗余列：debug 不回写（调试是过程不是结论）
        if rec.trigger != "debug" and status in TERMINAL:
            c2 = await db.get(UiCase, rec.subject_id)
            if c2 is not None:
                c2.last_run_at = _now()
                c2.last_run_status = status
                await db.commit()
        return {"status": status, "run_id": run_id, "result": result,
                "artifacts": art_refs, "elapsed_ms": elapsed_ms, "env_name": env_name,
                "message": message}
    finally:
        await _release_lease(bus, run_id, owner)


async def _write_step(db: Any, run_id: str, step_key: str, *, status: str, kind: str,
                      parent_step_key: str | None = None, subject_name: str | None = None,
                      elapsed_ms: int | None = None, detail: dict | None = None,
                      vars_snapshot: dict | None = None) -> dict:
    """run_step_result 的 upsert（(run_id, step_key, row_no=0) 唯一）。

    与 scenario/engine/events.write_step 同形而**不 import**（契约 1）：UI 独立执行
    的 step_key 是命令 id、row_no 恒 0（无数据集展开），语义上是它的真子集。
    只 flush——一个 run 的结论要么全可见要么全不可见，commit 归 _publish/调用方。
    """
    from app.modules.execution.models import RunStepResult

    row = (await db.execute(select(RunStepResult).where(
        RunStepResult.run_id == run_id, RunStepResult.step_key == step_key,
        RunStepResult.row_no == 0))).scalars().first()
    if row is None:
        row = RunStepResult(run_id=run_id, step_key=step_key, row_no=0, kind=kind,
                            status=status, attempts=1)
        db.add(row)
    else:
        row.attempts = int(row.attempts or 0) + 1
    row.kind = kind
    row.status = status
    if parent_step_key is not None:
        row.parent_step_key = parent_step_key
    if subject_name is not None:
        row.subject_name = subject_name
    if elapsed_ms is not None:
        row.elapsed_ms = int(elapsed_ms)
    if detail is not None:
        row.detail = detail
    if vars_snapshot is not None:
        row.vars_snapshot = vars_snapshot
    await db.flush()
    return {"step_key": step_key, "status": status, "kind": kind}


# ══════════════════════════ debug（进程内） ══════════════════════════


class UiCaseDebugIn(BaseModel):
    project_id: str
    case_id: str


class UiDebugOut(BaseModel):
    """调试载荷：**不是** DebugOut（模块 docstring 有话）。R108 断言行在 commands[] 里。"""

    run_id: str
    status: str                      # passed/failed/error/cancelled
    ok: bool
    passed: bool
    elapsed_ms: int = 0
    error: str | None = None
    env_name: str | None = None
    vars: dict[str, str] = Field(default_factory=dict)
    commands: list[dict] = Field(default_factory=list)   # ui_core 行，逐键不改（R108）
    artifacts: list[dict] = Field(default_factory=list)  # {kind, step_key, ref, bytes, reason}


@service(
    perm="ui:case:debug", effect="write", name="ui_case_debug",
    description="调试 UI 用例：进程内真跑 Playwright（不投 worker），落调试 run + "
                "逐命令明细 + 制品；不回写用例「最近结果」；返回 UI 形状调试载荷",
    http={"method": "POST", "path": "/ui-cases/{case_id}/debug", "tags": ["ui"]},
)
async def ui_case_debug(payload: UiCaseDebugIn, ctx) -> UiDebugOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:debug")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "UI 用例不存在（在回收站）", 404, {"case_id": c.id})
    # 与 api_debug 同档：不可执行在这里就该说「跑不了」，而不是跑出一个假结论。
    # （resolve 不 422 是给引擎的；debug 是人点按钮，422 是它该看到的话。）
    _, _, _, _, _, problems = await _resolve_parts(ctx.db, ctx, c)
    if problems:
        raise ApiError("validation_failed", "用例不可执行：" + "；".join(problems), 422,
                       {"case_id": c.id, "problems": problems})
    from app.core.eventbus import get_bus

    env = await _env_via_registry(ctx, payload.project_id, c.env_id)
    rec = await new_run(ctx.db, project_id=payload.project_id, subject_type="ui_case",
                        subject_id=c.id, subject_name=c.name, env_id=c.env_id,
                        env_name=env["env_name"],
                        trigger="agent" if ctx.entry == "agent" else "debug",
                        created_by=ctx.user_id,
                        max_runtime_ms=get_settings().ui_default_max_runtime_ms)
    rid = rec.id  # 先取标量（commit 过期实例坑）
    await ctx.db.commit()
    actor = {"user_id": ctx.user_id, "user_name": ctx.user_name,
             "is_system_admin": bool(ctx.is_system_admin), "perms": set(ctx.perms or set()),
             "entry": ctx.entry}
    fresh = await ctx.db.get(RunRecord, rid)
    assert fresh is not None
    out = await _execute_ui_run(ctx.db, fresh, actor=actor, bus=get_bus())
    result = out.get("result")
    return UiDebugOut(
        run_id=rid, status=out["status"], ok=bool(getattr(result, "ok", False)),
        passed=bool(getattr(result, "passed", False)),
        elapsed_ms=int(out.get("elapsed_ms") or 0),
        error=(out.get("message") if isinstance(out.get("message"), str) else None)
        or getattr(result, "error", None),
        env_name=out.get("env_name"),
        vars=dict(getattr(result, "vars", {}) or {}),
        commands=list(getattr(result, "commands", []) or []),
        artifacts=list(out.get("artifacts") or []))


# ══════════════════════════ run（投 worker / inline） ══════════════════════════


class UiCaseRunIn(BaseModel):
    project_id: str
    case_id: str


class UiRunEnqueueOut(BaseModel):
    run_id: str
    status: str = "queued"


_PENDING: set[asyncio.Task] = set()   # asyncio 只持弱引用，inline 协程句柄必须握住


def _celery_client():
    """按名字投递的惰性客户端。队列名与 worker 侧同源：投递时显式带
    `queue=settings.task_queue`（D10/R118，见 config.task_queue 的来历注释），
    演示 lane 的常驻 worker 从此领不到测试 lane 的任务。"""
    from celery import Celery

    url = get_settings().redis_url
    c = Celery("testpilot-enqueue-ui", broker=url, backend=url)
    c.conf.update(task_serializer="json", accept_content=["json"],
                  broker_transport_options={"max_retries": 0})
    return c


async def _broker_alive() -> bool:
    """与 orchestration._broker_alive 同形（kombu 探针、读**当前** settings）——契约 1
    不许 import scenario，所以自带；两边行为被 test_run_endpoint 的 503+无孤儿钉住。"""
    from kombu import Connection

    try:
        with Connection(get_settings().redis_url) as conn:
            conn.ensure_connection(max_retries=0, timeout=2)
    except Exception:
        return False
    return True


def _clean_actor(actor: Mapping | None) -> dict | None:
    if not actor:
        return None
    out: dict[str, Any] = {}
    for k, v in dict(actor).items():
        out[k] = sorted(str(x) for x in v) if isinstance(v, (set, frozenset)) else v
    return out


@service(
    perm="ui:case:run", effect="write", name="ui_case_run",
    description="执行 UI 用例：投 worker（trigger=manual，R42 按名字投递）；"
                "broker 不可达 503 且不留 queued 孤儿；返回 queued 的 run_id",
    http={"method": "POST", "path": "/ui-cases/{case_id}/run", "tags": ["ui"]},
)
async def ui_case_run(payload: UiCaseRunIn, ctx) -> UiRunEnqueueOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("ui:case:run")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="UI 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "UI 用例不存在（在回收站）", 404, {"case_id": c.id})
    mode = get_settings().exec_mode
    if mode == "celery" and not await _broker_alive():
        raise ApiError("executor_unavailable",
                       "执行器不可用：worker 未启动或 broker 不可达。启动命令："
                       "celery -A app.worker:celery_app worker --pool=solo（R42：不静默降级）",
                       503)
    env = await _env_via_registry(ctx, payload.project_id, c.env_id)
    rec = await new_run(ctx.db, project_id=payload.project_id, subject_type="ui_case",
                        subject_id=c.id, subject_name=c.name, env_id=c.env_id,
                        env_name=env["env_name"],
                        trigger=trigger_from_entry(ctx.entry),
                        created_by=ctx.user_id,
                        max_runtime_ms=get_settings().ui_default_max_runtime_ms)
    rid = rec.id
    await ctx.db.commit()
    actor = {"user_id": ctx.user_id, "user_name": ctx.user_name,
             "is_system_admin": bool(ctx.is_system_admin), "perms": set(ctx.perms or set()),
             "entry": ctx.entry}
    if mode == "celery":
        try:
            _celery_client().send_task(UI_RUN_TASK_NAME, args=[rid, _clean_actor(actor)],
                                       queue=get_settings().task_queue)
        except Exception as e:
            row = await ctx.db.get(RunRecord, rid)
            if row is not None:
                await ctx.db.delete(row)  # 行是这次调用建的，删它不伤任何人
            await ctx.db.commit()
            raise ApiError("executor_unavailable",
                           "任务投递失败（broker 不可达）：worker 未启动？" + str(e)[:120],
                           503) from e
    else:
        task = asyncio.create_task(amain_ui_run(rid, actor=actor))
        _PENDING.add(task)
        task.add_done_callback(_PENDING.discard)
    return UiRunEnqueueOut(run_id=rid, status="queued")


def _task_session():
    """一次执行一副 NullPool 引擎（连接绝不跨 asyncio.run 活命）——orchestration 同因
    同形的件，契约 1 不许 import 所以自带。"""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    return eng, async_sessionmaker(bind=eng, expire_on_commit=False, autoflush=False,
                                   class_=AsyncSession)


async def amain_ui_run(run_id: str, *, actor: Mapping | None = None) -> None:
    """worker / inline 的执行入口：领取 queued → _execute_ui_run。幂等（非 queued 退出）。"""
    from app.core.eventbus import get_bus

    eng, maker = _task_session()
    try:
        async with maker() as db:
            rec = await db.get(RunRecord, run_id)
            if rec is None or rec.status != "queued" or rec.subject_type != "ui_case":
                return
            await _execute_ui_run(db, rec, actor=actor, bus=get_bus())
    finally:
        await eng.dispose()


__all__ = ["UI_RUN_TASK_NAME", "amain_ui_run", "ui_case_debug", "ui_case_resolve",
           "ui_case_run", "ui_run_gate"]
