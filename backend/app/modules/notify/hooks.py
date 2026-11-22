"""run 终态钩子的 notify 侧实现（1E T3）：定时 run 落终态 → 按渠道真发 + 落账。

装配（main.create_app）：`set_run_finalized_hook(notify.hooks.on_run_finalized)`——
core 只调钩子不认识 notify（set_audit_writer 同款形状，契约 1 由 lint-imports 守着，
本模块对 schedule 也只走**表名 SQL**，R28 先例）。

五条口径：
- **只认 trigger="schedule" 的终态 run**（计划 T3 原文「手动 run 终态不通知」）；
  一期只有定时挂渠道，没有「所有执行都通知」的全局开关——不造。
- **一条都不假发**：没绑渠道 / 渠道行已删 → 如实不发，`last_run` 里「没发」
  （reason=未绑定通知渠道 / 渠道不存在）与「发了失败」（channels[].ok=False + error）
  是两种不同形状；发送结果逐渠道落 notify_channel.last_send（D28，测试发送同形）。
- **consecutive_failures 由本钩子统一维护**（全仓唯一写入方）：run 通过归零、
  未通过 +1；**发送失败不碰计数**——通知坏了 ≠ 执行坏了（计划 T3 测试口径）。
- **告警阈值 = 常量 3**（§11.4.17「连续失败[3]次后通知」）：T1 落地时表上没落
  阈值列（T0「一列不多」纪律），每任务可配阈值待业主裁——按计划补记裁定按常量 3
  实现并如实记账；计数**恰好到达** 3 时向同渠道追加一条告警摘要，之后逐次只发摘要
  不重复告警。
- 异常语义：本模块**不吞**异常（吞在 core.run_finalized 那唯一一处，保证「摘掉
  try/except 变异必红」）；只在自己的 commit 失败时 rollback 洗清会话再上抛，
  不把脏事务留给 run 收尾的后续 publish。
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select, text

from app.modules.notify import senders, template
from app.modules.notify.models import NotifyChannel
from app.shared.utcnow import utc_now_iso

# §11.4.17「连续失败[3]次后通知」：阈值列未落库（待业主裁），按计划补记按常量实现。
ALERT_THRESHOLD = 3


def _merged_receipt(prior: Any, final: dict[str, Any]) -> str:
    """last_run 合并：保留 fire 回执（ok/run_id/fired_at），追加 run_final 段——
    形状沿用 schedule.service.update_last_run 的字段，不另发明一套顶层键。"""
    base = prior if isinstance(prior, dict) else {}
    return json.dumps({**base, "run_final": final}, ensure_ascii=False)


async def _send_one(db, chan: NotifyChannel, markdown: str,
                    failures: list[Exception]) -> senders.SendResult:
    """单渠道发送 + D28 落账。**发送器抛异常**（senders.send 的契约是永不抛，真抛
    = 实现坏了）：先如实落 last_send/回执，再收集起来在钩子末尾上抛——唯一吞异常点
    在 core.run_finalized，保留「旁路炸了」的日志与变异自证的靶。"""
    try:
        res = await senders.send({"type": chan.type, "config": dict(chan.config or {})}, markdown)
    except Exception as e:  # noqa: BLE001  记账后交唯一吞点，不在这里私自吞
        failures.append(e)
        res = senders.SendResult(ok=False, error=type(e).__name__ + ": " + str(e)[:180])
    chan.last_send = {"ok": res.ok, "latency_ms": res.latency_ms, "error": res.error,
                      "raw": res.raw, "checked_at": utc_now_iso()}
    return res


async def on_run_finalized(db, *, run_id: str, project_id: str, trigger: str,
                           ok: bool, summary: dict[str, Any]) -> None:
    """core 钩子实现：只处理 trigger=schedule；其余一秒返回（手工 run 零通知）。

    定位「这个 run 属于哪个定时任务」：读 run 出生快照 request_snapshot.schedule_task_id
    （fire 建 run 时随写）——last_run.$.run_id 会被下一次 fire 覆盖，重叠时拿它回表丢通知（D162）。
    """
    if trigger != "schedule":
        return
    try:
        await _handle(db, run_id, project_id, ok, summary)
    except Exception:
        # 只洗会话，不吞语义——上抛给 core.run_finalized（唯一吞异常点），
        # 换 run 收尾的后续 publish 还能用这个 session。
        try:
            await db.rollback()
        except Exception:  # pragma: no cover  会话彻底坏了也没别的办法，异常照上抛
            pass
        raise


async def _handle(db, run_id: str, project_id: str, ok: bool, summary: dict[str, Any]) -> None:
    snap = (await db.execute(
        text("SELECT request_snapshot FROM run_record WHERE id=:r"), {"r": run_id})).scalar()
    snap = json.loads(snap) if isinstance(snap, str) else snap  # 驱动对 JSON 回读形状不保证
    tid = str(snap.get("schedule_task_id") or "") if isinstance(snap, dict) else ""
    row = (await db.execute(
        text("SELECT id, name, notify_channel_ids, consecutive_failures, last_run "
             "FROM schedule_task WHERE id=:t AND project_id=:p LIMIT 1"),
        {"t": tid, "p": project_id})).first() if tid else None
    if row is None:
        return  # 旧 run/非定时 run 无快照键、或任务已删：不发不记账，不造假
    task_id, task_name = str(row[0]), str(row[1])
    channel_ids = row[2]
    if isinstance(channel_ids, str):  # 驱动对 JSON 列的回读形状不保证（str/dict/list）
        channel_ids = json.loads(channel_ids)
    channel_ids = [str(c) for c in (channel_ids or [])]
    prev_fail = int(row[3] or 0)
    prior = row[4]
    if isinstance(prior, str):
        prior = json.loads(prior)

    # 计数唯一写入点：run 结果定生死，发送成败绝不碰它（通知坏了 ≠ 执行坏了）
    new_fail = 0 if ok else prev_fail + 1

    channels_out: list[dict[str, Any]] = []
    send_failures: list[Exception] = []
    reason: str | None = None
    if not channel_ids:
        reason = "未绑定通知渠道"
    else:
        render_summary = {**summary, "task_name": task_name,
                          "executor_name": await _executor_name(db, summary.get("created_by"))}
        markdown = template.render(render_summary)
        for cid in channel_ids:
            chan = (await db.execute(
                select(NotifyChannel).where(NotifyChannel.id == cid))).scalar_one_or_none()
            if chan is None:
                channels_out.append({"channel_id": cid, "ok": False, "error": "渠道不存在"})
                continue
            res = await _send_one(db, chan, markdown, send_failures)
            channels_out.append({"channel_id": cid, "name": chan.name,
                                 "ok": res.ok, "error": res.error})

    alarmed = False
    if new_fail == ALERT_THRESHOLD:  # 恰好越限那一次追加告警（4/5 次不重复轰炸）
        alarmed = await _send_alert(db, channel_ids, task_name, new_fail, channels_out,
                                    send_failures)

    final = {"run_id": run_id, "status": summary.get("status"), "ok": ok,
             "finished_at": summary.get("finished_at"),
             "notified": bool(channels_out) and any(c["ok"] for c in channels_out),
             "channels": channels_out, "reason": reason,
             "alert_fired": alarmed, "consecutive_failures": new_fail}
    await db.execute(
        text("UPDATE schedule_task SET last_run=:v, consecutive_failures=:n WHERE id=:i"),
        {"v": _merged_receipt(prior, final), "n": new_fail, "i": task_id})
    await db.commit()
    if send_failures:
        # 账已落库，这里把「发送器抛穿」的异常交给唯一吞点（core.run_finalized）：
        # 日志留痕 + 摘掉那层 try/except 的变异自证有靶可打。
        raise send_failures[0]


async def _executor_name(db, created_by: Any) -> str | None:
    """执行人显示名（表名 SQL 读 app_user，R28）；查不到就 None——模板缺行不显，不造。"""
    if not created_by:
        return None
    row = (await db.execute(
        text("SELECT name FROM app_user WHERE id=:u"), {"u": str(created_by)})).first()
    return str(row[0]) if row is not None else None


async def _send_alert(db, channel_ids: list[str], task_name: str, failures: int,
                      channels_out: list[dict[str, Any]],
                      send_failures: list[Exception]) -> bool:
    """达阈告警摘要发同渠道（§11.4.17）：告警对象=渠道（D28 裁定，不发「管理员」私信）。"""
    md = ("### TestPilot 告警 · 定时任务连续失败 " + str(failures) + " 次\n"
          "- 任务：" + task_name + "\n"
          "- 请检查场景执行与通知渠道（最近一次结果已随各次摘要发出）")
    any_ok = False
    for cid in channel_ids:
        chan = (await db.execute(
            select(NotifyChannel).where(NotifyChannel.id == cid))).scalar_one_or_none()
        if chan is None:
            continue
        res = await _send_one(db, chan, md, send_failures)
        any_ok = any_ok or res.ok
        channels_out.append({"channel_id": cid, "name": chan.name, "alert": True,
                             "ok": res.ok, "error": res.error})
    return any_ok
