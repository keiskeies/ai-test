"""1E T3：run 终态钩子 → 通知（「定时→执行→通知」DoD 闭环的最后一根线）。

钉的对象（任务书 ①-⑤ + 计划 T3 的告警例）：
① 定时 run 落终态 → 渠道**真收到一次**（假接收端 = test_notify 同款 http.server，
  「调用过」的 mock 不算收到）；Markdown 逐字段钉（通过率口径 Σpass/(total−skip)）；
② 手工 run → 零通知（trigger 闸住在钩子第一行）；
③ 发送器抛 → run 终态**不受影响**（passed 还是 passed）+ 失败落 last_run/last_send——
  变异自证：摘掉 core.run_finalized 的 try/except，本例必红（异常改判 run 为 error）；
④ consecutive_failures 连错两次 =2、成功一次归零（唯一写入方 = 本钩子）；
⑤ 模板渲染快照：关键字段齐全 + 无密钥字样 + 「打开报告」只给相对路径。

手法：fire_task（真回执落 last_run）→ _amain 直接 await（同 test_scenario_run ⑥ 的
worker 替身，inline 语义、真 run_graph、真钩子）——_amain 返回时钩子已同步跑完，
零轮询零竞态。跨连接可见性一律「每轮先 rollback」（REPEATABLE-READ 快照坑，同仓先例）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import select

from app.modules.notify import hooks as notify_hooks
from app.modules.schedule import service as svc
from app.modules.schedule.models import ScheduleTask
from tests.test_notify import FakeReceiver

MAIN_SRC = Path(__file__).resolve().parents[1] / "app" / "main.py"

target = FastAPI()


@target.get("/ping")
async def ping():
    return JSONResponse({"pong": True})


TR = ASGITransport(app=target)


@pytest.fixture(autouse=True)
def fake_bus():
    from app.core.eventbus import init_bus

    return init_bus(client=FakeAsyncRedis(decode_responses=True))


class _SpyCelery:
    def __init__(self) -> None:
        self.sent: list = []

    def send_task(self, name, args=None, **kw):
        self.sent.append((name, args, kw))


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _node(key, kind, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": None, "config": {}, "children": []}
    n.update(extra)
    return n


PASS_GRAPH = _graph(_node("s1", "set_var", config={"vars": {"a": "1"}}))
# assert 排最前（无上游响应）→ 步骤 error → run error：确定性红图，不打任何网络。
# 断言列表保存期必须非空（graph.py 校验），运行期才走「前面还没有任何响应」的 error 分支。
FAIL_GRAPH = _graph(_node("a1", "assert",
                          config={"assertions": [{"type": "status_code", "expect": 200}]}))


async def _setup(client, make_user, session, *, tag, graph=None, channel=True):
    """admin + 项目 + 场景（HTTP 面真建）+ 渠道（假接收端）+ 定时任务（模型直插）。"""
    _u, h = await make_user("hook_" + tag, admin=True)
    pid = (await client.post("/api/v1/projects", json={"name": "hk_" + tag},
                             headers=h)).json()["id"]
    g = graph if graph is not None else PASS_GRAPH
    sid = (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "场景" + tag, "step_graph": g})).json()["id"]
    rx = FakeReceiver()
    chan_id = None
    if channel:
        from app.modules.notify.models import NotifyChannel

        chan = NotifyChannel(name="接收端" + tag, type="WEBHOOK", config={"url": rx.url})
        session.add(chan)
        await session.commit()
        chan_id = chan.id
    task = ScheduleTask(project_id=pid, name="夜间回归" + tag, subject_type="scenario",
                        subject_id=sid, cron="* * * * *",
                        notify_channel_ids=[chan_id] if chan_id else [],
                        created_by=_u.id)
    session.add(task)
    await session.commit()
    return {"h": h, "pid": pid, "sid": sid, "rx": rx, "task_id": task.id,
            "chan_id": chan_id, "admin_id": _u.id}


async def _fire_and_run(monkeypatch, setup) -> str:
    """真 fire_task（last_run 回执）→ 直接 await _amain（worker 替身）：返回时终态
    与钩子都已落库。"""
    from app.core.eventbus import get_bus

    monkeypatch.setattr(svc, "_celery_client", lambda: _SpyCelery())
    receipt = await svc.fire_task(setup["task_id"])
    assert receipt["ok"] is True, receipt
    from app.modules.scenario.orchestration import _amain

    await _amain(receipt["run_id"], bus=get_bus(), transport=TR)
    return receipt["run_id"]


async def _fresh(session, task_id):
    """跨连接读真相：先 rollback 结束本事务快照，再按主键重取（同仓 REPEATABLE-READ 坑）。"""
    await session.rollback()
    row = (await session.execute(select(ScheduleTask).where(
        ScheduleTask.id == task_id))).scalar_one()
    await session.refresh(row)
    return row


def _run_final(task):
    lr = task.last_run
    if isinstance(lr, str):
        lr = json.loads(lr)
    return lr.get("run_final") if isinstance(lr, dict) else None


async def _run_status(session, run_id):
    from app.modules.execution.models import RunRecord

    await session.rollback()  # 新事务新快照才看得见 _amain 独立连接 commit 的终态
    rec = await session.get(RunRecord, run_id)
    await session.refresh(rec)
    return rec


# ── ① 定时 run 落终态 → 渠道真收到一次 + 双账本 ─────────────────────────────────


async def test_schedule_run_notifies_receiver_once(client, make_user, session, monkeypatch) -> None:
    from app.modules.notify.models import NotifyChannel

    setup = await _setup(client, make_user, session, tag="ok")
    try:
        run_id = await _fire_and_run(monkeypatch, setup)
        assert len(setup["rx"].received) == 1, "渠道必须真收到且只收到一次"
        text_body = setup["rx"].received[0]["json"]["text"]
        # 模板逐字段（通过率 = 1/(1−0) = 100.0%）
        assert "场景ok" in text_body and "定时任务：夜间回归ok" in text_body
        assert "触发方式：定时" in text_body and "结果：通过" in text_body
        assert "通过率：100.0%" in text_body
        assert "执行人：hook_ok" in text_body
        assert "打开报告](/reports/" + run_id + ")" in text_body  # 相对路径，不拼绝对 URL
        assert "••••" not in text_body and "token" not in text_body.lower()

        task = await _fresh(session, setup["task_id"])
        rf = _run_final(task)
        assert rf["run_id"] == run_id and rf["status"] == "passed" and rf["ok"] is True
        assert rf["notified"] is True and rf["reason"] is None
        assert rf["channels"] == [{"channel_id": setup["chan_id"], "name": "接收端ok",
                                   "ok": True, "error": None}]
        assert task.consecutive_failures == 0
        # fire 回执（run_id/fired_at）被合并保留，不被终态段覆盖掉
        assert task.last_run["run_id"] == run_id and task.last_run["fired_at"]

        chan = await session.get(NotifyChannel, setup["chan_id"])
        await session.refresh(chan)
        assert chan.last_send["ok"] is True and chan.last_send["checked_at"]  # D28 落账

        rec = await _run_status(session, run_id)
        assert rec.status == "passed" and rec.trigger == "schedule"
    finally:
        setup["rx"].stop()


# ── ② 手工 run → 零通知（trigger 闸） ───────────────────────────────────────────


async def test_manual_run_notifies_nothing(client, make_user, session) -> None:
    from app.core.eventbus import get_bus
    from app.modules.execution.services import new_run
    from app.modules.scenario.orchestration import _amain

    setup = await _setup(client, make_user, session, tag="man")
    try:
        rec = await new_run(session, project_id=setup["pid"], subject_type="scenario",
                            subject_id=setup["sid"], subject_name="手工跑的",
                            env_id=None, env_name=None, trigger="manual", created_by=None)
        rid = rec.id
        await session.commit()
        await _amain(rid, bus=get_bus(), transport=TR)
        assert setup["rx"].received == [], "手工 run 发通知 = 噪音，越过计划边界"
        task = await _fresh(session, setup["task_id"])
        assert _run_final(task) is None and task.consecutive_failures == 0
    finally:
        setup["rx"].stop()


# ── ③ 发送器抛 → run 终态不动 + 失败落账（变异自证的靶） ────────────────────────


async def test_sender_raise_keeps_run_passed_and_records_failure(
    client, make_user, session, monkeypatch
) -> None:
    """senders.send 的契约是永不抛——真抛 = 实现坏了：先如实落账（last_send/回执），
    异常交 core.run_finalized 的唯一吞点。摘掉那层 try/except：异常回灌 run_graph 的
    调用方 _run_claimed，把刚 commit 的 passed 改判 error——本例的 passed 断言必红。"""
    from app.modules.notify.models import NotifyChannel

    async def _boom(channel, markdown):
        raise RuntimeError("sender exploded (mutant probe)")

    monkeypatch.setattr(notify_hooks.senders, "send", _boom)
    setup = await _setup(client, make_user, session, tag="boom")
    try:
        run_id = await _fire_and_run(monkeypatch, setup)
        rec = await _run_status(session, run_id)
        assert rec.status == "passed", "通知是旁路：旁路炸了 run 必须还是 passed"
        assert setup["rx"].received == []  # 真抛 = 没发出去，不许假称收到

        task = await _fresh(session, setup["task_id"])
        rf = _run_final(task)
        assert rf["notified"] is False and rf["status"] == "passed"
        assert rf["channels"][0]["ok"] is False
        assert "RuntimeError: sender exploded" in rf["channels"][0]["error"]
        chan = await session.get(NotifyChannel, setup["chan_id"])
        await session.refresh(chan)
        assert chan.last_send["ok"] is False and "RuntimeError" in chan.last_send["error"]
        # 发送坏了 ≠ 执行坏了：计数纹丝不动
        assert task.consecutive_failures == 0
    finally:
        setup["rx"].stop()


# ── ④ consecutive_failures：连错两次 =2、成功归零（唯一写入方） ─────────────────


async def test_consecutive_failures_two_then_reset(client, make_user, session, monkeypatch) -> None:
    setup = await _setup(client, make_user, session, tag="cnt", graph=FAIL_GRAPH)
    try:
        await _fire_and_run(monkeypatch, setup)
        assert (await _fresh(session, setup["task_id"])).consecutive_failures == 1
        await _fire_and_run(monkeypatch, setup)
        assert (await _fresh(session, setup["task_id"])).consecutive_failures == 2
        # 成功一次归零：把场景图换成绿图再打一轮
        await session.rollback()
        from app.modules.scenario.models import Scenario

        scen = await session.get(Scenario, setup["sid"])
        scen.step_graph = PASS_GRAPH
        await session.commit()
        await _fire_and_run(monkeypatch, setup)
        assert (await _fresh(session, setup["task_id"])).consecutive_failures == 0
    finally:
        setup["rx"].stop()


# ── 告警：连错到第 3 次 → 同渠道追加一条告警摘要（第 4 次不重复轰炸） ────────────


async def test_alert_fires_exactly_at_three(client, make_user, session, monkeypatch) -> None:
    setup = await _setup(client, make_user, session, tag="alert", graph=FAIL_GRAPH)
    try:
        for _ in range(3):
            await _fire_and_run(monkeypatch, setup)
        msgs = [r["json"]["text"] for r in setup["rx"].received]
        # 第 3 次 = 摘要 + 告警共两条，前两次各一条
        assert len(msgs) == 4, msgs
        assert "连续失败 3 次" in msgs[-1] and "夜间回归alert" in msgs[-1]
        rf = _run_final(await _fresh(session, setup["task_id"]))
        assert rf["alert_fired"] is True and rf["consecutive_failures"] == 3
        assert any(c.get("alert") for c in rf["channels"])

        await _fire_and_run(monkeypatch, setup)  # 第 4 次：只发摘要，不再告警
        assert len(setup["rx"].received) == 5
        rf4 = _run_final(await _fresh(session, setup["task_id"]))
        assert rf4["alert_fired"] is False and rf4["consecutive_failures"] == 4
    finally:
        setup["rx"].stop()


# ── 不假发：没绑渠道 = 「没发」，与「发了失败」是 last_run 里两种形状 ────────────


async def test_no_channel_honestly_not_sent(client, make_user, session, monkeypatch) -> None:
    setup = await _setup(client, make_user, session, tag="nochan", channel=False)
    try:
        await _fire_and_run(monkeypatch, setup)
        rf = _run_final(await _fresh(session, setup["task_id"]))
        assert rf["notified"] is False and rf["channels"] == []
        assert rf["reason"] == "未绑定通知渠道"  # 「没发」说的出口，不是「已发送」的假成功
    finally:
        setup["rx"].stop()

    # 渠道被删（绑了个不存在的 id）= 另一种「发了但发不出去」，明细可查
    setup2 = await _setup(client, make_user, session, tag="gone")
    try:
        await session.rollback()
        t2 = (await session.execute(select(ScheduleTask).where(
            ScheduleTask.id == setup2["task_id"]))).scalar_one()
        t2.notify_channel_ids = ["deleted-channel"]
        await session.commit()
        await _fire_and_run(monkeypatch, setup2)
        rf2 = _run_final(await _fresh(session, setup2["task_id"]))
        assert rf2["notified"] is False and rf2["reason"] is None
        assert rf2["channels"] == [{"channel_id": "deleted-channel",
                                    "ok": False, "error": "渠道不存在"}]
        assert setup2["rx"].received == []
    finally:
        setup2["rx"].stop()


# ── ⑤ 模板快照（纯函数）：字段齐全 + 无密钥 + 相对链接；缺字段整行省略 ──────────


def test_template_render_snapshot_no_secrets() -> None:
    from app.modules.notify import template

    md = template.render({
        "run_id": "r-777", "status": "failed", "trigger": "schedule",
        "subject_name": "履约回归", "env_name": "staging", "executor_name": "张三",
        "task_name": "每日回归", "elapsed_ms": 12345,
        "stats": {"total": 4, "pass": 3, "fail": 1, "skip": 1, "error": 0, "cancelled": 0},
        "error": "步骤 s3 断言未通过", "config": {"access_token": "LEAK-MUST-NOT-APPEAR"},
    })
    assert md.splitlines()[0] == "### TestPilot 执行结果摘要 · 未通过"
    assert "- 定时任务：每日回归" in md
    assert "- 场景：履约回归" in md and "- 触发方式：定时" in md and "- 结果：未通过" in md
    assert "- 通过率：100.0%" in md  # 3/(4−1)：Σpass/Σ(total−skip) 同一把尺
    assert "- 耗时：12.3s" in md and "- 环境：staging" in md and "- 执行人：张三" in md
    assert "- 失败原因：步骤 s3 断言未通过" in md
    assert "[打开报告](/reports/r-777)" in md  # 相对路径（平台无 base_url，拼绝对=假链接）
    low = md.lower()
    assert "leak-must-not-appear" not in low and "token" not in low and "secret" not in low
    assert "config" not in low  # 白名单渲染：多塞的键根本不进正文

    # 缺字段诚实省略（run_record 里没有的不显示，不画「未知」也不造 0%）
    sparse = template.render({"run_id": "r1", "status": "passed", "trigger": "schedule"})
    assert "环境" not in sparse and "执行人" not in sparse and "耗时" not in sparse
    assert "通过率：算不出" in sparse and "失败原因" not in sparse


# ── 结构钉：钩子注册在装配期（删这行 ① 必红的靶之外，再钉一层装配事实） ─────────


def test_hook_registration_is_wired_in_main() -> None:
    src = MAIN_SRC.read_text(encoding="utf-8")
    assert "set_run_finalized_hook(notify_hooks.on_run_finalized)" in src
    # core 侧只调钩子不认识 notify（契约 2 的源码级回声）
    from app.core import service as core_service

    core_src = Path(core_service.__file__).read_text(encoding="utf-8")
    assert "app.modules.notify" not in core_src
