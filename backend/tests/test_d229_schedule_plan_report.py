"""D229：定时任务主体 `plan_report` —— 到点生成计划报告并推绑定渠道（报告订阅）。

钉的七件事：

① **白名单第三值**：plan_report 收；计划类主体（plan/plan_report）带 env_id → 422
   （显式拒绝，不静默丢一个永远读不到的列值）；update 切到 plan_report 时旧 env 被清掉。
② **fire 复用 plan_report_create**：经 REGISTRY 按名取、以创建者身份调（ctx.entry=
   schedule）；报告行真的落库，计数与计划关联对得上（不另写一份取数）。
③ **报告先成立、通知后发生**：没有绑定渠道时报告照样生成，回执如实写
   notified=False + reason「未绑定通知渠道」——不拿「没发」冒充「没生成」。
④ **绑了渠道就真发**：逐渠道回执 ok=True；正文是计划报告模板（计划名/计数/相对链接），
   渠道的 last_send 同步落账（D28 同款）。
⑤ **每次触发一份新快照**：连发两次 = 两条不同 id 的报告（定时订阅的本义）。
⑥ **跑不了的如实回执**：计划不存在 / 创建者已删除 → ok=False + 人话 reason，零报告。
⑦ **归档计划照样出报告**：归档封「继续执行」，不封「给历史出凭证」（与
   plan_report_create 判断 3 逐字同源）——所以 plan 主体的 409 规则不搬到这里。

手法同 test_d226_schedule_plan：HTTP 面走 client + admin headers；fire_task 自带
NullPool 会话（先 commit 才可见）；发送器用 monkeypatch 替身（CI 无外网）。
"""
from __future__ import annotations

import pytest

from app.modules.notify import hooks as notify_hooks
from app.modules.notify.senders import SendResult
from app.modules.schedule import service as svc

BASE = "/api/v1/schedule-tasks"


@pytest.fixture()
async def admin_h(client, make_user):
    _u, h = await make_user("d229_admin", admin=True)
    return h


async def _mk_project(client, h, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mk_plan_with_link(client, h, pid: str) -> str:
    """建计划 + 一个场景关联（报告 total=1）；返回 plan_id。"""
    s = await client.post("/api/v1/scenarios", json={"project_id": pid, "name": "D229 场景"},
                          headers=h)
    assert s.status_code in (200, 201), s.text
    p = await client.post("/api/v1/plans", json={"project_id": pid, "name": "D229 计划"},
                          headers=h)
    assert p.status_code in (200, 201), p.text
    plan_id = p.json()["id"]
    lk = await client.post(f"/api/v1/plans/{plan_id}/case-links",
                           json={"project_id": pid, "subject_type": "scenario",
                                 "subject_id": s.json()["id"]}, headers=h)
    assert lk.status_code in (200, 201), lk.text
    return plan_id


async def _mk_task(client, h, pid: str, *, subject_type: str, subject_id: str, **kw):
    body = {"project_id": pid, "name": "D229 任务", "subject_type": subject_type,
            "subject_id": subject_id, "cron": "0 8 * * *", **kw}
    return await client.post(BASE, json=body, headers=h)


async def _mk_channel(client, h, name: str) -> str:
    r = await client.post("/api/v1/notify-channels",
                          json={"name": name, "type": "WEBHOOK",
                                "config": {"url": "http://example.invalid/hook"}}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _reports_url(plan_id: str, pid: str, suffix: str = "") -> str:
    return f"/api/v1/plans/{plan_id}/reports{suffix}?" + "project_id=" + pid


# ── ① 白名单与 env 语义 ───────────────────────────────────────────────────────


async def test_plan_report_task_created_and_env_rejected(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D229 白名单")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    ok = await _mk_task(client, admin_h, pid, subject_type="plan_report", subject_id=plan_id)
    assert ok.status_code == 201, ok.text
    assert ok.json()["subject_type"] == "plan_report"
    env = await client.post("/api/v1/envs", params={"project_id": pid},
                            json={"project_id": pid, "name": "D229 环境"}, headers=admin_h)
    assert env.status_code in (200, 201), env.text
    bad = await _mk_task(client, admin_h, pid, subject_type="plan_report", subject_id=plan_id,
                         env_id=env.json()["id"])
    assert bad.status_code == 422 and "不绑定环境" in bad.json()["message"], bad.text


async def test_update_switch_to_plan_report_clears_env(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D229 切主体")
    env = await client.post("/api/v1/envs", params={"project_id": pid},
                            json={"project_id": pid, "name": "D229 环境2"}, headers=admin_h)
    assert env.status_code in (200, 201), env.text
    c = await _mk_task(client, admin_h, pid, subject_type="scenario", subject_id="s_x",
                       env_id=env.json()["id"])
    assert c.status_code == 201, c.text
    tid = c.json()["id"]
    r = await client.patch(BASE + "/" + tid,
                           json={"project_id": pid, "subject_type": "plan_report"},
                           headers=admin_h)
    assert r.status_code == 200, r.text
    assert r.json()["env_id"] is None, "切到计划报告必须清掉场景级环境（不留孤儿绑定）"


# ── ②③⑤ fire 支路 ────────────────────────────────────────────────────────────


async def test_fire_generates_snapshot_without_channels(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D229 生成")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    t = await _mk_task(client, admin_h, pid, subject_type="plan_report", subject_id=plan_id)
    tid = t.json()["id"]

    receipt = await svc.fire_task(tid)

    assert receipt["ok"] is True, receipt
    assert receipt["report_id"], receipt
    assert receipt["total"] == 1 and receipt["executed"] == 0 and receipt["passed"] == 0, receipt
    assert receipt["status"] == "not_started", receipt
    # ③ 报告照样成立，没绑渠道如实写：
    assert receipt["notified"] is False
    assert receipt["channels"] == []
    assert receipt["reason"] == "未绑定通知渠道"

    # 报告真的落库（列表端点看得到，且计数与计划关联对得上）
    lst = await client.get(_reports_url(plan_id, pid), headers=admin_h)
    assert lst.status_code == 200, lst.text
    rows = lst.json()["items"]
    assert len(rows) == 1 and rows[0]["id"] == receipt["report_id"], rows
    assert rows[0]["total"] == 1 and rows[0]["plan_id"] == plan_id, rows[0]
    # 详情 = 明细携带关联对象快照（不是空壳）
    det = await client.get("/api/v1/plan-reports/" + receipt["report_id"],
                           params={"project_id": pid}, headers=admin_h)
    assert det.status_code == 200, det.text
    items = det.json()["items"]
    assert len(items) == 1 and items[0]["subject_type"] == "scenario", items
    assert items[0]["result"] == "none" and items[0]["executed"] is False, items[0]

    # 回执落 last_run（GET 即刻可见）
    got = await client.get(BASE + "/" + tid, params={"project_id": pid}, headers=admin_h)
    lr = got.json()["last_run"]
    assert lr["ok"] is True and lr["report_id"] == receipt["report_id"], lr


async def test_each_fire_makes_a_new_snapshot(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D229 两次")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    tid = (await _mk_task(client, admin_h, pid, subject_type="plan_report",
                          subject_id=plan_id)).json()["id"]

    r1 = await svc.fire_task(tid)
    r2 = await svc.fire_task(tid)

    assert r1["ok"] is True and r2["ok"] is True, (r1, r2)
    assert r1["report_id"] != r2["report_id"], "定时订阅每触发一次就是一份新快照"
    lst = await client.get(_reports_url(plan_id, pid), headers=admin_h)
    assert lst.json()["total"] == 2, lst.text


async def test_fire_reports_missing_plan_without_creating_anything(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D229 计划消失")
    t = await _mk_task(client, admin_h, pid, subject_type="plan_report",
                       subject_id="no-such-plan")
    tid = t.json()["id"]

    receipt = await svc.fire_task(tid)

    assert receipt["ok"] is False and "计划不存在" in receipt["reason"], receipt
    got = await client.get(BASE + "/" + tid, params={"project_id": pid}, headers=admin_h)
    assert got.json()["last_run"]["ok"] is False, got.text


async def test_fire_creator_deleted_no_report(client, admin_h, session) -> None:
    from sqlalchemy import update

    from app.modules.schedule.models import ScheduleTask

    pid = await _mk_project(client, admin_h, "D229 创建者没了")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    tid = (await _mk_task(client, admin_h, pid, subject_type="plan_report",
                          subject_id=plan_id)).json()["id"]
    await session.execute(update(ScheduleTask).where(ScheduleTask.id == tid)
                          .values(created_by="ghost-user"))
    await session.commit()

    receipt = await svc.fire_task(tid)

    assert receipt["ok"] is False and "创建者已删除" in receipt["reason"], receipt
    lst = await client.get(_reports_url(plan_id, pid), headers=admin_h)
    assert lst.json()["total"] == 0, lst.text


async def test_fire_archived_plan_still_generates(client, admin_h) -> None:
    """归档封的是执行，不是出报告（plan 任务的 409 规则不搬过来）。"""
    pid = await _mk_project(client, admin_h, "D229 归档")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    a = await client.post(f"/api/v1/plans/{plan_id}/archive",
                          json={"project_id": pid}, headers=admin_h)
    assert a.status_code == 200, a.text
    tid = (await _mk_task(client, admin_h, pid, subject_type="plan_report",
                          subject_id=plan_id)).json()["id"]

    receipt = await svc.fire_task(tid)

    assert receipt["ok"] is True and receipt["report_id"], receipt
    assert receipt["status"] == "archived", receipt


# ── ④ 渠道真发 ───────────────────────────────────────────────────────────────


async def test_fire_sends_report_to_bound_channels(client, admin_h, monkeypatch) -> None:
    pid = await _mk_project(client, admin_h, "D229 推渠道")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    ch = await _mk_channel(client, admin_h, "D229 渠道")
    tid = (await _mk_task(client, admin_h, pid, subject_type="plan_report",
                          subject_id=plan_id,
                          notify_channel_ids=[ch])).json()["id"]

    sent: list[tuple[dict, str]] = []

    async def fake_send(chan, markdown, *a, **kw):
        sent.append((chan, markdown))
        return SendResult(ok=True, latency_ms=1, raw="ok")

    monkeypatch.setattr(notify_hooks.senders, "send", fake_send)

    receipt = await svc.fire_task(tid)

    assert receipt["ok"] is True, receipt
    assert receipt["notified"] is True, receipt
    assert [c["channel_id"] for c in receipt["channels"]] == [ch], receipt
    assert receipt["channels"][0]["ok"] is True, receipt
    assert len(sent) == 1
    markdown = sent[0][1]
    assert "计划报告" in markdown and "D229 计划" in markdown, markdown
    assert "/plan-reports/" + receipt["report_id"] in markdown, markdown
    # D28 同款：渠道的 last_send 落账（发送成功也是账）
    got = await client.get("/api/v1/notify-channels/" + ch, headers=admin_h)
    assert got.json()["last_send"]["ok"] is True, got.text


async def test_fire_missing_channel_row_is_honest_not_silent(client, admin_h) -> None:
    """绑了已删除的渠道：报告照样生成，回执逐条写 ok=False「渠道不存在」。"""
    pid = await _mk_project(client, admin_h, "D229 渠道没了")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    tid = (await _mk_task(client, admin_h, pid, subject_type="plan_report",
                          subject_id=plan_id,
                          notify_channel_ids=["gone-channel"])).json()["id"]

    receipt = await svc.fire_task(tid)

    assert receipt["ok"] is True and receipt["notified"] is False, receipt
    assert receipt["channels"] == [{"channel_id": "gone-channel", "ok": False,
                                    "error": "渠道不存在"}], receipt


async def test_hook_crash_is_reported_as_abnormal_not_as_unbound(client, admin_h,
                                                                monkeypatch) -> None:
    """钩子自身炸了（core 吞掉返回 []）≠ 没绑渠道：回执必须说得出这两种形状的差别。"""
    import app.core.service as core_service

    pid = await _mk_project(client, admin_h, "D229 钩子炸了")
    plan_id = await _mk_plan_with_link(client, admin_h, pid)
    ch = await _mk_channel(client, admin_h, "D229 渠道3")
    tid = (await _mk_task(client, admin_h, pid, subject_type="plan_report",
                          subject_id=plan_id, notify_channel_ids=[ch])).json()["id"]

    async def boom(*a, **kw):
        raise RuntimeError("hook boom")

    monkeypatch.setattr(core_service, "_report_notify_hook", boom)

    receipt = await svc.fire_task(tid)

    assert receipt["ok"] is True and receipt["report_id"], receipt
    assert receipt["notified"] is False and receipt["channels"] == [], receipt
    assert "通知发送异常" in receipt["reason"], receipt
