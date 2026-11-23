"""ADB 用例的执行出口（1D T7）：`adb_case_resolve` + 同步调试 / enqueue + worker 执行入口。

ui_test/debug_services.py 的近亲（R102 同源）：三件事住一个文件，因为它们共享同一条
执行链（resolve → 设备锁 → run_adb → 落库三件套 → run_end），拆开只会制造多份漂移的
「怎么算 passed」。**同步 debug 与 worker 任务共用同一个 `_execute_adb_run`**——调试
一次和后台跑一次不可能得出两种结论，这是 R102 的硬约束，不是复用顺手。

与 UI 侧的三处有意差异（其余逐键镜像）：

- **没有 env**：`adb_case` 无 env_id（§4.5 没列，T2 已钉），变量只取全局配置
  （`env_resolve` 传 env_id=None 的既有语义）。
- **设备是执行槽位**（§6.4/§8.7）：跑之前必须过 T5 的设备锁。`default_device` = 指定
  serial；留空 = 「任一空闲」（§4.5 原话）。两条策略 × 两种触发：
  - background（manual/agent）：指定设备抢不到锁就 FIFO 排队，位次以 `device_queued`
    run 事件如实播出（D17 只显真实位次）；「任一空闲」在候选设备轮询抢占（空闲是瞬时
    状态，不预钉一台——预钉等于替执行时刻撒谎）。取消/deadline 在等待边界生效。
  - debug（trigger=debug）：§11.5.5 原话「调试必选空闲设备」：端点当场 422
    `device_occupied`，绝不排队（人在等一句答复，排队等于把人挂住还说不清在等什么）。
- **per-step `device` 覆盖一期未开放**：执行核一次 `run_adb` 只吃一个 serial（u2 会话
  模式、录屏配对都是单设备状态），逐步骤换设备要把用例切段执行——独立批次的形状。
  resolve 对非 `auto` 的 device 值回 `executable=False` + 点名步骤 id（界面能配、执行
  悄悄忽略 = §13 纪律 1 的假功能；响亮拒绝才是诚实）。

**T6 交接的责任在这里兑现**：执行包（adb_core）零 logger 是设计（ui_core/api_core 同
款），所以「u2→dump 降级看得见」的落点是本函数——`result.mode` 写进 run 详情（case
汇总行 detail + summary_graph 节点 config）+ 降级时打一条 warning。悄悄换引擎就是
纪律 1 违例。

**契约 1 的代价**（与 ui_test 同账）：broker 探针 / NullPool task session / run_end 事件 /
租约键与 `scenario/orchestration.py` 同形的件在本文件自带一份。键名与 scenario 侧逐字
相等：取消键 `cancel.<run_id>`、租约键 `run.lease.<run_id>`。

Debug 出参刻意**不是** `DebugOut`（HTTP 载荷形状）：ADB 运行没有 status/headers/body，
塞假值就是撒谎（§13 纪律 1）；跨面板真正共享的是 R108 断言行——`adb_core` 的行原样进
`commands[]`，一个键不改。
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.service import ctx_from_actor, ensure_project_access, service, trigger_from_entry
from app.modules.adb_test.case_services import _case
from app.modules.adb_test.models import STATUS_NORMAL, STATUS_RECYCLED, AdbCase, AdbDevice
from app.modules.execution.adb_lock import (
    acquire,
    dequeue,
    make_token,
    occupied,
    release,
    renew,
)
from app.modules.execution.artifacts import save_artifact
from app.modules.execution.models import RunEvent, RunRecord
from app.modules.execution.services import new_run
from app.shared.visibility import assert_row_visible

logger = logging.getLogger("testpilot")

ADB_RUN_TASK_NAME = "adb_case.run"
# 与 scenario/engine/events.py 逐字相等的跨模块键（docstring 有账）
_CANCEL_KEY = "cancel."
_LEASE_KEY = "run.lease."
LEASE_TTL_S = 90
TERMINAL = ("passed", "failed", "error", "cancelled")
# 设备等待轮询粒度：与 ui_core 取消切片同量级（位次/空闲变化最迟 0.5s 后被看见）
_DEVICE_POLL_S = 0.5
# §7.3 步骤 device 的「不覆盖」写法：前端孪生缺省填 "auto"（web/src/adb/commands.ts）
_DEVICE_AUTO = "auto"


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


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


async def _usable_devices(db, project_id: str) -> list[AdbDevice]:
    """可执行设备池 = 未回收且启用；按 id 定序（候选轮询的顺序必须确定，否则两台
    worker 的抢占次序随机抖动，排队公平无从谈起）。"""
    rows = (await db.execute(select(AdbDevice).where(
        AdbDevice.project_id == project_id, AdbDevice.status == STATUS_NORMAL,
        AdbDevice.enabled == 1).order_by(AdbDevice.id))).scalars().all()
    return list(rows)


# ══════════════════════════ resolve（内部件） ══════════════════════════


class AdbCaseResolveIn(BaseModel):
    project_id: str
    case_id: str
    # 场景步骤级设备策略覆盖（1D T8/R145，画布 PropsPanel 的「任一空闲 / 指定设备」）。
    # 与用例自己的 default_device 是「这一步」vs「这条案」的关系；None = 不覆盖，
    # 沿用用例口径（debug/worker 档没有这两个键，R102 同源钉的就是那条原样路）。
    # 注意这与 §7.3 的**逐步骤** device 覆盖是两回事——后者一期未开放（设备锁按案占用），
    # _resolve_parts 里那条 problem 不许因为本参数存在而放宽。
    device_policy: str | None = None
    device_serial: str | None = None


class StepDeviceOverride(BaseModel):
    """步骤级设备策略的归一形状（resolve 与执行体共用同一份校验，别写两把尺子）。"""

    policy: str                     # any_idle | specified
    serial: str | None = None
    bad: str | None = None          # 非 None = 配置残缺，交给 resolve 判「跑不了」


def _step_device(policy: str | None, serial: str | None) -> StepDeviceOverride | None:
    """把入参的两个散字段归一成一个覆盖；都没给 = None（不覆盖）。

    残缺不静默回退：`specified` 不给 serial 会让用户以为跑在他点的那台设备上；未知词
    同理。两者都回 `bad` 让上层判「跑不了」（数据事实，不是请求非法）——在引擎路径上
    抛校验异常只会变成一个查不出原因的 500。
    """
    if policy is None and not serial:
        return None
    p = (policy or "").strip()
    s = (serial or "").strip() or None
    if p not in ("any_idle", "specified"):
        return StepDeviceOverride(policy=p or "(空)", bad="步骤的设备策略 " + repr(policy)
                                  + " 不是本系统认识的写法")
    if p == "any_idle":
        return StepDeviceOverride(policy="any_idle")
    if s is None:
        return StepDeviceOverride(policy="specified",
                                  bad="步骤选了「指定设备」但没有填设备")
    return StepDeviceOverride(policy="specified", serial=s)


class AdbCaseResolveOut(BaseModel):
    """ADB 用例的**有效**执行形态（与 UiCaseResolveOut 同族语义：跑不了回
    executable=False + reason，绝不 422——「跑不了」是数据事实不是请求非法，引擎据此
    把步骤标 error 写进报告，而不是炸掉整场执行）。"""

    case_id: str
    case_name: str
    priority: str = "P2"
    default_device: str | None = None  # 指定 serial；None = 任一空闲
    device_serial: str | None = None   # 指定且可用时回填；留空策略不预钉（瞬时状态）
    commands: list[dict] = Field(default_factory=list)
    variables: dict[str, str] = Field(default_factory=dict)
    executable: bool = True
    reason: str | None = None


async def _resolve_parts(db, ctx, c: AdbCase,
                         step_device: StepDeviceOverride | None = None
                         ) -> tuple[list[dict], dict[str, str], str | None, list[str]]:
    """共用解析：返回 (commands, variables, device_serial, problems)。

    problems 非空 = executable=False 的素材（点名到 serial/步骤 id）。不抛。
    设备可用性与 per-step device 覆盖都在这道核——它们是「跑不了」，不是「存不了」：
    保存门（case_services._gate）只管协议形状，设备今天没登记不拦保存（env 同款口径）。

    step_device（引擎步骤级覆盖，R145）优先于用例的 default_device：画布上那一步点了
    哪台就跑哪台。覆盖只改「跑哪台」，不改「一条案跑一台」的前提——逐步骤 device 那条
    problem 与它无关，照旧拦。
    """
    commands = [s for s in (c.steps or []) if isinstance(s, dict)]
    env = await _env_via_registry(ctx, c.project_id, None)
    variables = env["vars"]
    problems: list[str] = []
    devices = await _usable_devices(db, c.project_id)
    serials = {d.serial for d in devices}
    device_serial: str | None = None
    if step_device is not None and step_device.bad:
        problems.append(step_device.bad)
    wanted = step_device.serial if step_device is not None else c.default_device
    if step_device is not None and step_device.policy == "any_idle":
        wanted = None
    if wanted:
        if wanted in serials:
            device_serial = wanted
        else:
            who = "步骤指定的设备" if step_device is not None else "默认设备"
            problems.append(who + " " + repr(wanted) + " 不在本项目可用设备里"
                            "（未登记 / 已停用 / 已回收）：这一步没有设备可跑")
    elif not devices:
        problems.append("项目里没有任何启用且未回收的 ADB 设备：「任一空闲」挑不出设备")
    for s in commands:
        dev = s.get("device")
        if isinstance(dev, str) and dev.strip() and dev.strip() != _DEVICE_AUTO:
            problems.append("步骤 " + repr(str(s.get("id"))) + " 指定了设备覆盖 " + repr(dev)
                            + "：一条用例跑在一台设备上（设备锁按案占用），"
                            "逐步骤换设备一期未开放——请去掉该步骤的 device 字段")
    return commands, variables, device_serial, problems


@service(
    perm="adb:case:read", effect="read", name="adb_case_resolve",
    description="解析 ADB 用例的有效执行形态（步骤/变量/设备策略）；"
                "不可执行回 executable=False + reason，绝不 422；供执行链与调试端点内部调用",
    http=None, tool=False, resident=False,
)
async def adb_case_resolve(payload: AdbCaseResolveIn, ctx) -> AdbCaseResolveOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:read")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 用例不存在（在回收站）", 404, {"case_id": c.id})
    commands, variables, device_serial, problems = await _resolve_parts(
        ctx.db, ctx, c, _step_device(payload.device_policy, payload.device_serial))
    return AdbCaseResolveOut(
        case_id=c.id, case_name=c.name, priority=c.priority, default_device=c.default_device,
        device_serial=device_serial, commands=commands, variables=variables,
        executable=not problems, reason="；".join(problems) if problems else None)


# ══════════════════════════ 执行体（debug 与 worker 共用，R102 同源） ══════════════════════════


def _owner() -> str:
    return "adb-worker-" + socket.gethostname() + "-" + str(os.getpid())


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
    """AdbRunResult → run 终态。两层词表（ui debug_services 同款尺子）：
    cancelled > error（没跑成）> failed（跑成了但没过）> passed。"""
    rows = result.commands or []
    if any(r.get("status") == "cancelled" for r in rows):
        return "cancelled", "运行已被取消"
    if not result.ok:
        return "error", (result.error or "执行核异常")[:300]
    if any(r.get("status") == "error" for r in rows):
        bad = next(r for r in rows if r.get("status") == "error")
        return "error", str(bad.get("message") or "存在 error 步骤")[:300]
    if not result.passed:
        bad = next((r for r in rows if r.get("status") == "fail"), None)
        return "failed", str((bad or {}).get("message") or "断言未通过")[:300]
    return "passed", None


_CASE_STATUS = {"passed": "pass", "failed": "fail", "error": "error", "cancelled": "cancelled"}


async def _write_step(db: Any, run_id: str, step_key: str, *, status: str, kind: str,
                      parent_step_key: str | None = None, subject_name: str | None = None,
                      elapsed_ms: int | None = None, detail: dict | None = None,
                      vars_snapshot: dict | None = None) -> dict:
    """run_step_result 的 upsert（(run_id, step_key, row_no=0) 唯一）。

    与 ui_test debug_services._write_step 同形而各带一份（契约 1）：ADB 独立执行的
    step_key 是步骤 id、row_no 恒 0（无数据集展开）。只 flush——commit 归调用方。
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


async def _finish_error(db: Any, bus: Any, rec: RunRecord, reason: str,
                        steps: list) -> dict:
    """跑不了 = error：命令一行不跑，但按 R102 逐行留 skip 痕迹 + case error 汇总行。

    resolve 的 executable=False 在执行侧的落点——是**数据事实**进了 run 记录，不是 422
    （debug 点按钮的人在端点就被拦；这里兜住 queued 之后资产变坏的手工/后台 run）。
    """
    run_id = rec.id
    rec.status = "running"
    rec.started_at = _now()
    await db.commit()
    for s in steps:
        if isinstance(s, dict):
            await _write_step(db, run_id, str(s.get("id") or "?"), status="skip",
                              kind=str(s.get("type") or "?"), parent_step_key="case",
                              subject_name=rec.subject_name,
                              detail={"message": "用例不可执行，未执行"})
    await _write_step(db, run_id, "case", status="error", kind="adb_case",
                      subject_name=rec.subject_name, elapsed_ms=0,
                      detail={"commands": [], "vars": {}, "error": reason, "artifacts": []})
    stats = {"total": len(steps), "pass": 0, "fail": 0, "skip": len(steps), "error": 0,
             "cancelled": 0, "elapsed_ms": 0, "rows_total": 0}
    rec.status = "error"
    rec.error = ("用例不可执行：" + reason)[:300]
    rec.elapsed_ms = 0
    rec.finished_at = _now()
    rec.stats = stats
    rec.summary_graph = {"version": 1, "edges": [], "nodes": [{
        "key": "case", "kind": "adb_case", "name": rec.subject_name, "config": {},
        "result": {"status": "error", "message": reason[:300]}}]}
    await db.commit()
    await _publish(db, bus, run_id, "run_end",
                   {"status": "error", "stats": stats, "message": reason[:300]})
    if rec.trigger != "debug":  # 真执行才回写「最近结果」（error 也是结论）
        c2 = await db.get(AdbCase, rec.subject_id)
        if c2 is not None:
            c2.last_run_at = _now()
            c2.last_run_status = "error"
            await db.commit()
    return {"status": "error", "run_id": run_id, "result": None, "artifacts": [],
            "elapsed_ms": 0, "message": reason[:300], "mode": None, "device": None}


async def _acquire_device(db: Any, bus: Any, rec: RunRecord, *, serial: str | None,
                          candidates: list[str], is_debug: bool,
                          owner: str) -> tuple[str | None, str | None, str | None]:
    """设备槽位抢占。返回 (serial, token, problem)——problem 非空即「拿不到设备」的终态素材
    （"cancelled" 是取消专用哨兵）。token 只有抢锁成功时非 None：释放必须用**同一次
    acquire 的 token**（token 校验释放，adb_lock 的规矩），所以必须原样带出来。

    两条策略 × 两种触发（模块 docstring 的口径）：
    - 指定设备：background 抢不到锁就留在 FIFO 里等（位次以 device_queued 事件如实
      播出，D17 只显真实位次）；debug 抢不到 → dequeue 退出 + 报错，**绝不排队**。
    - 任一空闲：空闲是瞬时状态，不预钉一台——每轮在候选间轮询抢占，纯轮询不入队。
    等待边界：取消键（cancelled 终态）与 max_runtime deadline（error）都生效；
    每次醒来顺手续 run 租约（活着的人不被 settle_dead_run 标「中断」）。
    """
    run_id = rec.id
    deadline = _now().timestamp() + int(rec.max_runtime_ms or
                                        get_settings().adb_default_max_runtime_ms) / 1000.0
    token = make_token(run_id)
    specified = serial is not None
    targets: list[str] = [serial] if serial is not None else list(candidates)
    queued_event_sent = False

    while True:
        for s in targets:
            got = await acquire(s, token)
            if got["acquired"]:
                return s, token, None
            if not specified:
                # 任一空闲：acquire 失败会把 token 塞进该设备队列——轮询策略不占队
                await dequeue(s, token)
                continue
            if is_debug:
                await dequeue(s, token)
                snap = await occupied(s)
                return (None, None, "设备 " + repr(s) + " 正被占用（持有者 "
                        + str(snap["holder"]) + "）：调试不排队，请等它空闲后再试"
                        if snap["holder"] else "设备 " + repr(s) + " 抢占失败")
            if not queued_event_sent:
                queued_event_sent = True
                await _publish(db, bus, run_id, "device_queued",
                               {"serial": s, "position": got["position"],
                                "queued": got["queued"]})
        # 本轮没抢到：等待边界三连——续租、看取消、看 deadline
        await _renew_lease(bus, run_id, owner)
        if await bus.exists_key(_CANCEL_KEY + run_id):
            if specified:
                await dequeue(targets[0], token)
            return (None, None, "cancelled")
        if _now().timestamp() >= deadline:
            if specified:
                await dequeue(targets[0], token)
            return (None, None, "等待设备超时（max_runtime_ms 已到）" if specified
                    else "等待空闲设备超时（max_runtime_ms 已到）")
        await asyncio.sleep(_DEVICE_POLL_S)


async def _execute_adb_run(db: Any, rec: RunRecord, *, actor: Mapping | None, bus: Any,
                           override_vars: Mapping | None = None,
                           step_device: StepDeviceOverride | None = None) -> dict:
    """领取 queued 的 adb_case run 并跑完：设备锁 → run_adb → R102 落库 → run_end。

    **debug 与 worker 共用的唯一执行体**（R102）：调试一次和后台跑一次不可能得出两种
    结论。调用方给 db session 与已确认 status=queued 的行；本函数负责 running→终态、
    commit、run_end、run 租约与设备锁的获取/续期/释放、非 debug 的 last_run_* 回写。
    override_vars（1D T8/R145，仅引擎步骤传）：场景运行期变量叠加在解析出的变量层上
    （混合场景里 api 步 extract 的值要能渲染进 adb 步的 ${...}）；None = debug/worker
    的原样口径，一个键不少一个键不多——R102 同源钉的正是这条默认路。
    step_device（1D T8/R145，同样只有引擎步骤传）：画布那一步的设备策略覆盖用例默认，
    只改「跑哪台」，排队/422 的分流仍按 trigger 走（场景档可排队、debug 永不排队）。
    """
    from app.modules.execution.adb_core import run_adb

    run_id = rec.id
    owner = _owner()
    settings = get_settings()
    if not await _renew_lease(bus, run_id, owner):
        return {"status": rec.status, "skipped": "lease_held"}
    device_serial: str | None = None
    lock_token: str | None = None
    try:
        case = await db.get(AdbCase, rec.subject_id)
        if case is None or case.status == STATUS_RECYCLED:
            rec.status = "error"
            rec.error = "ADB 用例不存在或已被回收，无法执行"
            rec.finished_at = _now()
            await db.commit()
            await _publish(db, bus, run_id, "run_end", {"status": "error",
                                                        "message": rec.error})
            return {"status": "error", "run_id": run_id, "result": None, "artifacts": [],
                    "elapsed_ms": 0, "message": rec.error, "mode": None, "device": None}
        commands, variables, device_serial, problems = await _resolve_parts(
            db, ctx_from_actor(actor, db), case, step_device)
        if override_vars:
            # 引擎档：场景运行期变量覆盖同名解析值（api 步 extract → adb 步渲染，R145）
            variables = {**variables,
                         **{str(k): str(v) for k, v in override_vars.items()}}
        if problems:
            return await _finish_error(db, bus, rec, "；".join(problems),
                                       list(case.steps or []))
        devices = await _usable_devices(db, rec.project_id)
        is_debug = rec.trigger == "debug"
        serial, lock_token, problem = await _acquire_device(
            db, bus, rec, serial=device_serial, candidates=[d.serial for d in devices],
            is_debug=is_debug, owner=owner)
        if problem == "cancelled":
            rec.status = "cancelled"
            rec.error = "运行已被取消（等待设备期间）"
            rec.finished_at = _now()
            await db.commit()
            await _publish(db, bus, run_id, "run_end",
                           {"status": "cancelled", "message": rec.error})
            return {"status": "cancelled", "run_id": run_id, "result": None, "artifacts": [],
                    "elapsed_ms": 0, "message": rec.error, "mode": None, "device": None}
        if problem is not None:
            return await _finish_error(db, bus, rec, problem, list(case.steps or []))
        assert serial is not None and lock_token is not None  # problem=None ⇒ 抢锁成功
        device_serial = serial
        rec.status = "running"
        rec.started_at = _now()
        rec.lease_owner = owner
        await db.commit()
        max_runtime = int(rec.max_runtime_ms or settings.adb_default_max_runtime_ms)

        async def should_cancel() -> bool:
            # 每步骤边界 + sleep 切片都会打到这里：顺手续 run 租约与设备锁
            await _renew_lease(bus, run_id, owner)
            # D176：renew 的判决不许丢——被强制释放/已过期 ⇒ False（adb_lock.py:90，
            # 原持有者不许续）。视为取消，run_adb 在步边界停下（终态 cancelled）；
            # 否则管理员强制释放后接棒的新 run 会与本案同设备并行，最长 max_runtime_ms。
            # 与 :449 租约检查同一「所有权没了就自停」姿势；收尾 release 有 token 守卫，
            # 不会误删新持有者的锁。
            if not await renew(device_serial, lock_token):
                return True
            return await bus.exists_key(_CANCEL_KEY + run_id)

        t0 = time.perf_counter()
        result = await run_adb(commands, serial=device_serial, variables=variables,
                               timeout_ms=settings.adb_command_timeout_ms,
                               max_runtime_ms=max_runtime, should_cancel=should_cancel)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        status, message = _run_status(result)

        # T6 交接的责任在此兑现：降级看得见——mode 进 run 详情，dump 模式再打一条 warning
        if result.mode == "dump":
            logger.warning("adb run %s 在 dump 轮询模式（uiautomator2 会话没起来，设备 %s）："
                           "慢但可用，不是换结论", run_id, device_serial)

        # R102：一步一行（step_key=步骤 id、kind=步骤 type、parent=case 汇总节点）
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
            db, run_id, "case", status=case_status, kind="adb_case", subject_name=case.name,
            elapsed_ms=elapsed_ms, vars_snapshot=dict(result.vars or {}),
            detail={"commands": result.commands or [], "vars": dict(result.vars or {}),
                    "error": result.error, "artifacts": art_refs, "mode": result.mode,
                    "device": device_serial})
        stats = {"total": len(result.commands or []), **counts, "elapsed_ms": elapsed_ms,
                 "rows_total": 0}
        rec.status = status
        rec.elapsed_ms = elapsed_ms
        rec.finished_at = _now()
        rec.stats = stats
        rec.summary_graph = {"version": 1, "edges": [], "nodes": [{
            "key": "case", "kind": "adb_case", "name": case.name,
            "config": {"mode": result.mode, "device": device_serial},
            "result": {"status": case_status, "message": message}}]}
        if message and status != "passed":
            rec.error = message
        await db.commit()
        await _publish(db, bus, run_id, "run_end",
                       {"status": status, "stats": stats, "message": message})
        # 终态回写冗余列：debug 不回写（调试是过程不是结论）
        if rec.trigger != "debug" and status in TERMINAL:
            c2 = await db.get(AdbCase, rec.subject_id)
            if c2 is not None:
                c2.last_run_at = _now()
                c2.last_run_status = status
                await db.commit()
        return {"status": status, "run_id": run_id, "result": result,
                "artifacts": art_refs, "elapsed_ms": elapsed_ms, "message": message,
                "mode": result.mode, "device": device_serial}
    finally:
        if device_serial is not None and lock_token is not None:
            # 只有真的占上过锁才释放；release 是 token 校验的，误调不伤他人（返回 False）
            try:
                await release(device_serial, lock_token)
            except Exception:  # noqa: BLE001 收尾不许吞掉终态结论——锁有 TTL 兜底
                logger.warning("adb run %s 释放设备锁失败（TTL %ss 后自然到期）",
                               run_id, 60)
        await _release_lease(bus, run_id, owner)


# ══════════════════════════ debug（进程内，§11.5.5） ══════════════════════════


class AdbCaseDebugIn(BaseModel):
    project_id: str
    case_id: str


class AdbDebugOut(BaseModel):
    """调试载荷：**不是** DebugOut（模块 docstring 有话）。R108 断言行在 commands[] 里。

    mode/device 是 ADB 侧多出来的两键：降级不可见 = 纪律 1 违例（T6 交接），调试面板
    要当场说出「这案走的是 dump 轮询，慢但判定同一份」。
    """

    run_id: str
    status: str                      # passed/failed/error/cancelled
    ok: bool
    passed: bool
    elapsed_ms: int = 0
    error: str | None = None
    mode: str | None = None          # u2 | dump | None（没连上）
    device: str | None = None        # 真跑在哪台设备上
    vars: dict[str, str] = Field(default_factory=dict)
    commands: list[dict] = Field(default_factory=list)   # adb_core 行，逐键不改（R108）
    artifacts: list[dict] = Field(default_factory=list)  # {kind, step_key, ref, bytes, reason}


@service(
    perm="adb:case:run", effect="write", name="adb_case_debug",
    description="调试 ADB 用例：进程内真跑（不投 worker），落调试 run + 逐步明细 + 制品；"
                "必选空闲设备（占用 422 device_occupied，绝不排队）；不回写「最近结果」",
    http={"method": "POST", "path": "/adb-cases/{case_id}/debug", "tags": ["adb"]},
)
async def adb_case_debug(payload: AdbCaseDebugIn, ctx) -> AdbDebugOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:run")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 用例不存在（在回收站）", 404, {"case_id": c.id})
    # 与 ui_case_debug 同档：不可执行在这里说「跑不了」（422），不是跑出一个假结论。
    commands, _, device_serial, problems = await _resolve_parts(ctx.db, ctx, c)
    if problems:
        raise ApiError("validation_failed", "用例不可执行：" + "；".join(problems), 422,
                       {"case_id": c.id, "problems": problems})
    # 「调试必选空闲设备」（§11.5.5 原话）：指定设备查那一台；「任一空闲」不是先抢一台
    # 再等它——挑「任一」的本分是**当场找一台空的**，全占就是没有（等待中设备随时易主，
    # 预钉等于替执行时刻撒谎）。执行体里的 debug 抢占是「先答后抢」窗口的竞态兜底。
    if device_serial:
        snap = await occupied(device_serial)
        if snap["holder"] is not None:
            raise ApiError("device_occupied", "设备 " + device_serial + " 正被占用（持有者 "
                           + str(snap["holder"]) + ("，排队 " + str(snap["queued"]) + " 人"
                                                   if snap["queued"] else "")
                           + "）：调试不排队，请等它空闲", 422,
                           {"serial": device_serial, "holder": snap["holder"],
                            "queued": snap["queued"]})
    else:
        busy: list[dict] = []
        free: str | None = None
        for d in await _usable_devices(ctx.db, payload.project_id):
            snap = await occupied(d.serial)
            if snap["holder"] is None:
                free = d.serial
                break
            busy.append({"serial": d.serial, "holder": snap["holder"], "queued": snap["queued"]})
        if free is None and not busy:
            raise ApiError("validation_failed",
                           "项目里没有任何启用且未回收的 ADB 设备：调试没有设备可跑", 422,
                           {"case_id": c.id})
        if free is None:
            raise ApiError("device_occupied", "项目里没有空闲设备（" + str(len(busy))
                           + " 台全被占用）：调试不排队，请等一台空闲", 422, {"devices": busy})
    from app.core.eventbus import get_bus

    rec = await new_run(ctx.db, project_id=payload.project_id, subject_type="adb_case",
                        subject_id=c.id, subject_name=c.name, env_id=None, env_name=None,
                        trigger="agent" if ctx.entry == "agent" else "debug",
                        created_by=ctx.user_id,
                        max_runtime_ms=get_settings().adb_default_max_runtime_ms)
    rid = rec.id  # 先取标量（commit 过期实例坑）
    await ctx.db.commit()
    actor = {"user_id": ctx.user_id, "user_name": ctx.user_name,
             "is_system_admin": bool(ctx.is_system_admin), "perms": set(ctx.perms or set()),
             "entry": ctx.entry}
    fresh = await ctx.db.get(RunRecord, rid)
    assert fresh is not None
    out = await _execute_adb_run(ctx.db, fresh, actor=actor, bus=get_bus())
    result = out.get("result")
    return AdbDebugOut(
        run_id=rid, status=out["status"], ok=bool(getattr(result, "ok", False)),
        passed=bool(getattr(result, "passed", False)),
        elapsed_ms=int(out.get("elapsed_ms") or 0),
        error=(out.get("message") if isinstance(out.get("message"), str) else None)
        or getattr(result, "error", None),
        mode=out.get("mode"), device=out.get("device"),
        vars=dict(getattr(result, "vars", {}) or {}),
        commands=list(getattr(result, "commands", []) or []),
        artifacts=list(out.get("artifacts") or []))


# ══════════════════════════ run（投 worker / inline） ══════════════════════════


class AdbCaseRunIn(BaseModel):
    project_id: str
    case_id: str


class AdbRunEnqueueOut(BaseModel):
    run_id: str
    status: str = "queued"


_PENDING: set[asyncio.Task] = set()   # asyncio 只持弱引用，inline 协程句柄必须握住


def _celery_client():
    """按名字投递的惰性客户端。队列名与 worker 侧同源：投递时显式带
    `queue=settings.task_queue`（D10/R118，与 ui/scenario 两处同款）。"""
    from celery import Celery

    url = get_settings().redis_url
    c = Celery("testpilot-enqueue-adb", broker=url, backend=url)
    c.conf.update(task_serializer="json", accept_content=["json"],
                  broker_transport_options={"max_retries": 0})
    return c


async def _broker_alive() -> bool:
    """与 orchestration._broker_alive 同形（kombu 探针、读**当前** settings）——契约 1
    不许 import scenario，所以自带；行为被 test_adb_debug 的 503+无孤儿钉住。"""
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
    perm="adb:case:run", effect="write", name="adb_case_run",
    description="执行 ADB 用例：投 worker（trigger=manual，R42 按名字投递）；"
                "broker 不可达 503 且不留 queued 孤儿；指定设备忙则 FIFO 排队（位次走 "
                "device_queued 事件），返回 queued 的 run_id",
    http={"method": "POST", "path": "/adb-cases/{case_id}/run", "tags": ["adb"]},
)
async def adb_case_run(payload: AdbCaseRunIn, ctx) -> AdbRunEnqueueOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:run")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 用例不存在（在回收站）", 404, {"case_id": c.id})
    mode = get_settings().exec_mode
    if mode == "celery" and not await _broker_alive():
        raise ApiError("executor_unavailable",
                       "执行器不可用：worker 未启动或 broker 不可达。启动命令："
                       "celery -A app.worker:celery_app worker --pool=solo（R42：不静默降级）",
                       503)
    # enqueue 不拦「跑不了」：resolve 的 problems 会作为 error run 落库（数据事实），
    # 设备占用也不拦——后台 run 排队等设备是 §6.4 的默认承诺。
    rec = await new_run(ctx.db, project_id=payload.project_id, subject_type="adb_case",
                        subject_id=c.id, subject_name=c.name, env_id=None, env_name=None,
                        trigger=trigger_from_entry(ctx.entry),
                        created_by=ctx.user_id,
                        max_runtime_ms=get_settings().adb_default_max_runtime_ms)
    rid = rec.id
    await ctx.db.commit()
    actor = {"user_id": ctx.user_id, "user_name": ctx.user_name,
             "is_system_admin": bool(ctx.is_system_admin), "perms": set(ctx.perms or set()),
             "entry": ctx.entry}
    if mode == "celery":
        try:
            _celery_client().send_task(ADB_RUN_TASK_NAME, args=[rid, _clean_actor(actor)],
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
        task = asyncio.create_task(amain_adb_run(rid, actor=actor))
        _PENDING.add(task)
        task.add_done_callback(_PENDING.discard)
    return AdbRunEnqueueOut(run_id=rid, status="queued")


def _task_session():
    """一次执行一副 NullPool 引擎（连接绝不跨 asyncio.run 活命）——orchestration 同因
    同形的件，契约 1 不许 import 所以自带。"""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    return eng, async_sessionmaker(bind=eng, expire_on_commit=False, autoflush=False,
                                   class_=AsyncSession)


async def amain_adb_run(run_id: str, *, actor: Mapping | None = None,
                        override_vars: Mapping | None = None,
                        step_device: StepDeviceOverride | None = None) -> None:
    """worker / inline 的执行入口：领取 queued → _execute_adb_run。幂等（非 queued 退出）。

    override_vars / step_device 只有场景引擎（adb_case_engine_run）会传，见 `_execute_adb_run`。
    """
    from app.core.eventbus import get_bus

    eng, maker = _task_session()
    try:
        async with maker() as db:
            rec = await db.get(RunRecord, run_id)
            if rec is None or rec.status != "queued" or rec.subject_type != "adb_case":
                return
            await _execute_adb_run(db, rec, actor=actor, bus=get_bus(),
                                   override_vars=override_vars, step_device=step_device)
    finally:
        await eng.dispose()


# ══════════════════════════ 引擎步骤入口（1D T8，R145） ══════════════════════════


class AdbCaseEngineRunIn(BaseModel):
    project_id: str
    case_id: str
    # 场景 run id：取消翻译的源键（cancel.<engine_run_id> → cancel.<本次 adb run>）。
    # 引擎在场景步骤边界查自己的旗，执行体查的是 adb run 那把键——隔着一次进程内
    # 子执行，必须显式接线，否则「停止」对进行中的 adb 步骤失效。
    engine_run_id: str | None = None
    # 场景运行期变量（api 步 extract 的值要能渲染进 adb 步的 ${...}，R145）；
    # 叠加在执行体解析出的变量层上，debug/worker 档没有这个键、口径不变。
    engine_vars: dict[str, str] = Field(default_factory=dict)
    # 画布那一步的设备策略（§11.4.12「任一空闲 / 指定设备」，R145）：None = 不覆盖，
    # 用用例自己的 default_device。前端 PropsPanel 存的就是这两个键，别再让它空转。
    device_policy: str | None = None
    device_serial: str | None = None


class AdbCaseEngineRunOut(BaseModel):
    """引擎步骤的折料（与 AdbDebugOut 同族，同源 `_execute_adb_run` 出参）：
    run_id 让报告页认得出这条子 run；queued 是 device_queued 事件的真位次载荷（D17）。"""

    run_id: str
    status: str                      # passed/failed/error/cancelled
    elapsed_ms: int = 0
    error: str | None = None
    mode: str | None = None
    device: str | None = None
    vars: dict[str, str] = Field(default_factory=dict)
    commands: list[dict] = Field(default_factory=list)   # adb_core 行，逐键不改（R108）
    artifacts: list[dict] = Field(default_factory=list)  # {kind, step_key, ref, bytes, reason}
    queued: list[dict] = Field(default_factory=list)     # device_queued 事件载荷


@service(
    perm="adb:case:run", effect="write", name="adb_case_engine_run",
    description="场景引擎步骤入口：建 manual run 行后进程内同步跑完 R102 那份唯一执行体"
                "（R145：不起第二份执行体）；设备忙可 FIFO 排队（device_queued 真位次，"
                "与 debug 永不排队相对）；取消经 engine_run_id 翻译进执行体；"
                "内部件（http=None/tool=False），仅供 scenario 的 h_adb_case 经 REGISTRY 调用",
    http=None, tool=False, resident=False,
)
async def adb_case_engine_run(payload: AdbCaseEngineRunIn, ctx) -> AdbCaseEngineRunOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:case:run")
    assert ctx.db is not None
    c = await _case(ctx.db, payload.project_id, payload.case_id)
    assert_row_visible(c, ctx, what="ADB 用例不存在")
    if c.status == STATUS_RECYCLED:
        # 保存后被回收（腐坏引用）：404 上抛，引擎折成步骤 error——绝不静默跳过
        raise ApiError("not_found", "ADB 用例不存在（在回收站）", 404, {"case_id": c.id})
    from app.core.eventbus import get_bus

    bus = get_bus()
    # trigger=manual 是与 adb_case_debug 的全部差别（R102）：场景/后台档设备忙可排队，
    # debug 档 422 绝不排队——分流在执行体按 trigger 做，引擎一个字不碰。
    rec = await new_run(ctx.db, project_id=payload.project_id, subject_type="adb_case",
                        subject_id=c.id, subject_name=c.name, env_id=None, env_name=None,
                        trigger="manual", created_by=ctx.user_id,
                        max_runtime_ms=get_settings().adb_default_max_runtime_ms)
    rid = rec.id
    await ctx.db.commit()
    actor = {"user_id": ctx.user_id, "user_name": ctx.user_name,
             "is_system_admin": bool(ctx.is_system_admin), "perms": set(ctx.perms or set()),
             "entry": ctx.entry}

    async def _translate_cancel() -> None:
        while True:
            if await bus.exists_key(_CANCEL_KEY + rid):
                return  # 执行体已自行收尾，无需翻译
            if payload.engine_run_id and await bus.exists_key(_CANCEL_KEY + str(payload.engine_run_id)):
                await bus.set_key(_CANCEL_KEY + rid, "engine")
                return
            await asyncio.sleep(_DEVICE_POLL_S)

    watcher = (asyncio.create_task(_translate_cancel())
               if payload.engine_run_id else None)
    step_device = _step_device(payload.device_policy, payload.device_serial)
    try:
        # 与 worker 任务体桥接的同一个协程（R102 的引擎第三触发，R145）
        await amain_adb_run(rid, actor=actor, override_vars=payload.engine_vars or None,
                            step_device=step_device)
    finally:
        if watcher is not None:
            watcher.cancel()
            try:
                await watcher
            except asyncio.CancelledError:
                pass

    # 读终态：amain 用的是另一副 NullPool 引擎的 session。上面的 commit 已终结本会话
    # 事务，此后的 SELECT 是新快照（REPEATABLE-READ），能看到对方 commit 的终态。
    # **必须 populate_existing**：new_run 建的行还躺在本会话 identity map 里（status=queued），
    # 普通 get() 命中 identity map 就不发 SELECT——读到的是投递时的旧值，
    # 引擎会把跑通的步骤折成 error（queued/running 都不在终态词表里）。
    from app.modules.execution.models import RunEvent as _RunEvent
    from app.modules.execution.models import RunStepResult as _Rsr

    fresh = (await ctx.db.execute(select(RunRecord).where(RunRecord.id == rid)
                                  .execution_options(populate_existing=True))).scalar_one()
    assert fresh is not None
    case_row = (await ctx.db.execute(select(_Rsr).where(
        _Rsr.run_id == rid, _Rsr.step_key == "case", _Rsr.row_no == 0))).scalars().first()
    case_detail = dict(case_row.detail or {}) if case_row is not None else {}
    queued = [dict(e.payload) for e in (await ctx.db.execute(
        select(_RunEvent).where(_RunEvent.run_id == rid, _RunEvent.type == "device_queued")
        .order_by(_RunEvent.seq))).scalars().all()]
    return AdbCaseEngineRunOut(
        run_id=rid, status=fresh.status, elapsed_ms=int(fresh.elapsed_ms or 0),
        error=fresh.error, mode=case_detail.get("mode"), device=case_detail.get("device"),
        vars={str(k): str(v) for k, v in (case_row.vars_snapshot or {}).items()}
        if case_row is not None else {},
        commands=list(case_detail.get("commands") or []),
        artifacts=list(case_detail.get("artifacts") or []),
        queued=queued)


__all__ = ["ADB_RUN_TASK_NAME", "adb_case_debug", "adb_case_engine_run", "adb_case_resolve",
           "adb_case_run", "amain_adb_run"]
