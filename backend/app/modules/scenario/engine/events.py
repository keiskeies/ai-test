"""事件日志、步骤落库、取消旗标与运行租约（§8.2 §8.4 §8.6 + ledger R47）。

为什么进度事件要先写库再广播（R47）：Web 侧 SSE 断线后拿 Last-Event-ID 来重放，
重放的唯一真相是 run_event 表。反过来（先广播后落库）就存在一个真实窗口——
浏览器已经收到 seq=7 并渲染了，此刻 worker 被杀，库里没有 seq=7，重放永远补不回来，
用户看到的进度与最终报告从此对不上。顺序写死在这里，runner 就不必再操心。

seq 用 SELECT max + 1 而不是 Redis 计数器：一个 run 只有一个持有者（租约保证），
没有并发写手，用数据库算 seq 就避免了「Redis 涨了但 DB 写失败」这类空洞与错位。

write_step 只 flush、publish 才 commit：一个步骤的结论要么步骤行与事件一起可见，
要么一起不可见。两者分开 commit 会造出「报告里有失败步骤但直播没事件」的中间态。
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select

from app.core.eventbus import get_bus
from app.modules.execution.models import RunEvent, RunStepResult

CANCEL_TTL_S = 86_400
DEFAULT_LEASE_TTL_S = 60


def _now() -> datetime:
    """落库用的时间戳：naive UTC。

    RunEvent.ts 是裸 DateTime（无 fsp、无时区），实测绑定 aware 值时 asyncmy 会静默丢掉
    偏移、并截到秒精度。这里显式给 naive UTC，把隐式行为写出来，而不是赌驱动怎么裁。
    顺序永远看 seq，不看 ts —— 同秒内多个事件 ts 相同是正常现象。
    """
    return datetime.now(UTC).replace(tzinfo=None)


def _iso(ts: datetime) -> str:
    """naive UTC → 带 Z 的 ISO：不补时区的话前端 new Date() 会按本地时区解析，差 8 小时。"""
    return ts.replace(tzinfo=UTC).isoformat() if ts.tzinfo is None else ts.isoformat()


def _envelope(row: RunEvent) -> dict[str, Any]:
    return {"seq": row.seq, "ts": _iso(row.ts), "type": row.type, "payload": row.payload or {}}


async def publish(db: Any, run_id: str, type_: str, payload: dict | None = None, *,
                  bus: Any = None) -> dict:
    """先落 run_event + commit，再广播。返回事件信封（即 SSE 的一帧内容）。"""
    if bus is None:
        bus = get_bus()
    last = await db.scalar(select(func.max(RunEvent.seq)).where(RunEvent.run_id == run_id))
    row = RunEvent(run_id=run_id, seq=int(last or 0) + 1, type=type_, payload=payload or {},
                   ts=_now())
    db.add(row)
    await db.commit()  # 提交后本行对其他 session 可见，重放与直播看到的是同一真相
    env = _envelope(row)
    await bus.publish("run." + run_id, env)
    return env


async def replay_events(db: Any, run_id: str, after_seq: int = 0) -> list[dict]:
    """seq > after_seq 的事件信封，直接喂 core/sse.py 的 replay_fn。

    **不动调用方的事务**（D11 的教训）：这条读要开新快照才对，但换快照的活儿不在这里做
    ——本函数被 SSE 与 REST 两条路共用，SSE 侧那条 session 归流所有、纯读，而 REST 侧
    拿到的是请求级 session，上面可能有调用方尚未提交的写。在这里 rollback 等于替别人
    丢掉工作（agent 侧的同族函数就撞红过一条测试）。真正的换快照点在建流处，见
    scenario/routes.py 的 build_run_sse。
    """
    rows = (await db.execute(select(RunEvent).where(RunEvent.run_id == run_id,
                                                    RunEvent.seq > int(after_seq))
                             .order_by(RunEvent.seq))).scalars().all()
    return [_envelope(r) for r in rows]


async def write_step(db: Any, run_id: str, step_key: str, *, status: str, kind: str,
                     parent_step_key: str | None = None, subject_name: str | None = None,
                     elapsed_ms: int | None = None, detail: dict | None = None,
                     row_no: int = 0, row_total: int | None = None,
                     vars_snapshot: dict | None = None) -> RunStepResult:
    """按 (run_id, step_key, row_no) upsert 一行步骤结果；只 flush，由 publish 提交。

    row_no=0 表示「不是数据集展开出来的那一行」，用 0 不用 NULL：MySQL 唯一键不判等
    NULL，用 NULL 会让「重跑覆盖同一行」退化成「每次重跑多一行脏数据」。
    """
    stmt = select(RunStepResult).where(
        RunStepResult.run_id == run_id,
        RunStepResult.step_key == step_key,
        RunStepResult.row_no == int(row_no),
)
    row = (await db.execute(stmt)).scalars().first()
    if row is None:
        row = RunStepResult(run_id=run_id, step_key=step_key, row_no=int(row_no), kind=kind,
                            status=status, attempts=1)
        db.add(row)
    else:
        row.attempts = int(row.attempts or 0) + 1  # 重跑痕迹（§8.3），报告据此标注"第 N 次执行"
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
    if row_total is not None:
        row.row_total = int(row_total)
    if vars_snapshot is not None:
        row.vars_snapshot = vars_snapshot
    await db.flush()  # 不 commit：与同一批 publish 共用一个事务边界
    return row


# ---- 取消旗标：§8.2 的停止在步骤边界生效，靠的就是这个键 ----

async def request_cancel(bus: Any, run_id: str, reason: str = "user") -> None:
    await bus.set_key("cancel." + run_id, reason, ttl=CANCEL_TTL_S)


async def clear_cancel(bus: Any, run_id: str) -> None:
    await bus.del_key("cancel." + run_id)


async def is_cancelled(bus: Any, run_id: str) -> bool:
    return await bus.exists_key("cancel." + run_id)


# ---- 运行租约：worker 崩溃后 run 不能永久停在 running（Review Focus 6）----

def lease_key(run_id: str) -> str:
    """租约键的唯一构造点。

    execution 的读路径（run_get/report_get 判「进程中断」）受契约 4 所限不许 import
    本模块，只能自带 "run.lease." 前缀拼键——键名因此存在于两处。test_execution_worker
    用字符串相等测试钉死两处必须同步改；谁要改键名，从本函数改。
    """
    return "run.lease." + run_id


async def renew_lease(bus: Any, run_id: str, owner: str, ttl: int = DEFAULT_LEASE_TTL_S) -> bool:
    """领取或续期。已被他人持有则返回 False——僵尸 worker 不能靠续租霸着 run。

    GET 与 SET 之间存在极窄竞态（两 worker 同时看到空键），1B 接受：真原子要 Lua，
    而 fakeredis 没有 lupa 就跑不了该脚本，测试覆盖不了的原子性比窄竞态更危险。
    最坏结果是同一 run 短暂双跑，报告以 (run_id, step_key, row_no) 覆盖写，
    不会留下双份脏数据。
    """
    key = lease_key(run_id)
    cur = await bus.get_key(key)
    if cur is not None and cur != owner:
        return False
    await bus.set_key(key, owner, ttl=ttl)
    return True


async def lease_owner(bus: Any, run_id: str) -> str | None:
    """当前持有人：续租失败时这是唯一能告诉用户的证据（"被 worker-A 持有"）。"""
    return await bus.get_key(lease_key(run_id))


async def lease_alive(bus: Any, run_id: str) -> bool:
    return await bus.exists_key(lease_key(run_id))


async def release_lease(bus: Any, run_id: str, owner: str) -> bool:
    """只有持有人能释放，避免误删接管者的租约。"""
    if await bus.get_key(lease_key(run_id)) != owner:
        return False
    await bus.del_key(lease_key(run_id))
    return True


__all__ = ["CANCEL_TTL_S", "DEFAULT_LEASE_TTL_S", "clear_cancel", "is_cancelled", "lease_alive",
           "lease_key", "lease_owner", "publish", "release_lease", "renew_lease", "replay_events",
           "request_cancel", "write_step"]
