"""1B T6：执行上下文 / 事件日志 / 步骤落库 / cancel 与租约（§8.2 §8.4 + R47）。

这三块是 runner 的地基，测试钉的是**顺序与幂等**，不是字段搬运：
- 落库必须早于广播（R47）：Web 一旦收到事件就一定重放得到；
- 步骤按 (run_id, step_key, row_no) 覆盖而非追加：重跑不该在报告里长出第二行；
- 租约只有当前 owner 能续：否则崩溃复活的僵尸 worker 会把新持有人的租约续下去。
"""
from __future__ import annotations

import time

import pytest
from fakeredis import FakeAsyncRedis
from sqlalchemy import func, select

from app.core.eventbus import EventBus
from app.modules.execution.models import RunEvent, RunStepResult
from app.modules.scenario.engine.context import ExecutionContext
from app.modules.scenario.engine.events import (
    clear_cancel,
    is_cancelled,
    lease_alive,
    lease_owner,
    publish,
    renew_lease,
    replay_events,
    request_cancel,
    write_step,
)
from app.shared.vars import MissingVar


class ProbeBus:
    """假总线：publish 时反查库，用可观察的方式证明「先落库后广播」。"""

    def __init__(self, probe=None) -> None:
        self.sent: list = []
        self._probe = probe

    async def publish(self, channel, event) -> None:
        seen = await self._probe(event["seq"]) if self._probe is not None else None
        self.sent.append({"channel": channel, "event": event, "row_at_publish": seen})


# —— seq 与顺序 ——

async def test_publish_seq_is_strictly_increasing(session) -> None:
    bus = ProbeBus()
    got = [(await publish(session, "run-1", "step", {"k": "n1"}, bus=bus))["seq"] for _ in range(3)]
    assert got == [1, 2, 3], "seq 必须从 1 起严格递增，它就是 SSE 的 Last-Event-ID"
    rows = (await session.execute(select(RunEvent).where(RunEvent.run_id == "run-1")
                                  .order_by(RunEvent.seq))).scalars().all()
    assert [r.seq for r in rows] == [1, 2, 3], "重复 publish 不能产生同 seq 的两行"


async def test_publish_lands_in_db_before_broadcast(session) -> None:
    async def probe(seq: int):
        return (await session.execute(select(RunEvent).where(RunEvent.run_id == "run-1",
                                                            RunEvent.seq == seq))).scalar_one_or_none()

    bus = ProbeBus(probe=probe)
    ev = await publish(session, "run-1", "run_end", {"stats": {"total": 1}}, bus=bus)
    assert bus.sent[0]["row_at_publish"] is not None, (
        "广播时库里查不到这条 seq → Web 会收到重放不出来的事件（R47 明令禁止的顺序）")
    assert bus.sent[0]["row_at_publish"].type == "run_end"
    assert bus.sent[0]["channel"] == "run.run-1", "频道名要能被 sse_response 的 channel 直接复用"
    assert ev["type"] == "run_end" and ev["payload"] == {"stats": {"total": 1}}
    assert isinstance(ev["ts"], str) and ev["ts"], "信封里的 ts 是给 JSON 用的字符串"
    # 库里的 ts 是 naive UTC（MySQL DATETIME 无时区），信封必须补偏移：
    # 少了 +00:00，前端 new Date(ts) 会按本地时区解析，报告时间整体差 8 小时。
    assert ev["ts"].endswith("+00:00"), "ts 必须显式带 UTC 偏移：" + ev["ts"]


async def test_publish_commits_so_other_sessions_see_it(session) -> None:
    """commit（不是 flush）：worker 与 Web 是两个 session，未提交的事件对 Web 不可见。"""
    await publish(session, "run-2", "log", {"msg": "hi"}, bus=ProbeBus())
    assert not session.in_transaction(), "publish 必须 commit 而不是只 flush"
    n = (await session.execute(select(func.count()).select_from(RunEvent)
                               .where(RunEvent.run_id == "run-2"))).scalar_one()
    assert n == 1


async def test_replay_events_filters_by_cursor(session) -> None:
    bus = ProbeBus()
    for i in range(4):
        await publish(session, "run-3", "step", {"i": i}, bus=bus)
    everything = await replay_events(session, "run-3", 0)
    assert [e["seq"] for e in everything] == [1, 2, 3, 4]
    tail = await replay_events(session, "run-3", 2)
    assert [e["seq"] for e in tail] == [3, 4], "断线重连只补 cursor 之后的"
    assert tail[0]["type"] == "step" and tail[0]["payload"] == {"i": 2}
    assert set(tail[0]) == {"seq", "ts", "type", "payload"}, "信封形状即 sse replay_fn 的契约"
    assert await replay_events(session, "run-3", 4) == []
    assert await replay_events(session, "no-such-run", 0) == []


# —— 步骤落库 ——

async def test_write_step_twice_overwrites_same_key(session) -> None:
    first = await write_step(session, "run-4", "n1", status="running", kind="api_case")
    second = await write_step(session, "run-4", "n1", status="pass", kind="api_case",
                              elapsed_ms=42, subject_name="登录用例")
    rows = (await session.execute(select(RunStepResult)
                                  .where(RunStepResult.run_id == "run-4"))).scalars().all()
    assert len(rows) == 1, "同 key 再写必须是覆盖：报告里不该长出第二行"
    assert rows[0].status == "pass" and rows[0].elapsed_ms == 42
    assert rows[0].subject_name == "登录用例"
    assert first.id == second.id == rows[0].id, "覆盖必须复用同一行（含同一 id）"


async def test_write_step_bumps_attempts_on_rerun(session) -> None:
    """attempts 是 §8.3 单步重跑的唯一痕迹，报告要能看出这行被重跑过。"""
    await write_step(session, "run-5", "n1", status="fail", kind="api_case")
    await write_step(session, "run-5", "n1", status="pass", kind="api_case")
    await write_step(session, "run-5", "n1", status="pass", kind="api_case")
    row = (await session.execute(select(RunStepResult)
                                 .where(RunStepResult.run_id == "run-5"))).scalars().one()
    assert row.attempts == 3


async def test_write_step_dataset_rows_coexist(session) -> None:
    """数据集展开的每一步按 (key,row_no) 各占一行（§8.6），彼此不覆盖。"""
    for i in range(3):
        await write_step(session, "run-6", "n2", status="pass", kind="api_case",
                         row_no=i + 1, row_total=3, detail={"row": i + 1})
    rows = (await session.execute(select(RunStepResult).where(RunStepResult.run_id == "run-6")
                                  .order_by(RunStepResult.row_no))).scalars().all()
    assert [r.row_no for r in rows] == [1, 2, 3]
    assert all(r.row_total == 3 for r in rows)
    assert rows[0].detail == {"row": 1}


async def test_write_step_non_dataset_row_is_zero_not_null(session) -> None:
    """row_no=0 而非 NULL：MySQL 唯一键不判等 NULL，NULL 会让覆盖退化成追加。"""
    await write_step(session, "run-7", "n1", status="pass", kind="sleep")
    row = (await session.execute(select(RunStepResult)
                                 .where(RunStepResult.run_id == "run-7"))).scalars().one()
    assert row.row_no == 0


async def test_write_step_flushes_but_does_not_commit(session) -> None:
    """write_step 只 flush：与 publish 成对使用，由 publish 的 commit 一并提交，
    否则「步骤已提交而事件未提交」会让报告与直播对不上。"""
    await write_step(session, "run-8", "n1", status="running", kind="api_case")
    await session.rollback()
    n = (await session.execute(select(func.count()).select_from(RunStepResult)
                               .where(RunStepResult.run_id == "run-8"))).scalar_one()
    assert n == 0, "write_step 里偷 commit 会让 rollback 撤不掉半步骤状态"


async def test_write_step_keeps_parent_and_vars_snapshot(session) -> None:
    await write_step(session, "run-9", "n2.1", status="pass", kind="assert",
                     parent_step_key="n2", vars_snapshot={"uid": "7"})
    row = (await session.execute(select(RunStepResult)
                                 .where(RunStepResult.run_id == "run-9"))).scalars().one()
    assert row.parent_step_key == "n2", "父子关系要落库，报告页才能脱离 step_graph 重建步骤树"
    assert row.vars_snapshot == {"uid": "7"}, "§8.3 单步重跑靠它重建上下文"


# —— cancel / 租约 ——

@pytest.fixture()
def raw() -> FakeAsyncRedis:
    return FakeAsyncRedis(decode_responses=True)


@pytest.fixture()
def bus(raw) -> EventBus:
    return EventBus(raw)


async def test_cancel_flag_roundtrip(bus) -> None:
    assert await is_cancelled(bus, "run-1") is False
    await request_cancel(bus, "run-1", reason="user")
    assert await is_cancelled(bus, "run-1") is True
    await clear_cancel(bus, "run-1")
    assert await is_cancelled(bus, "run-1") is False, "重跑同一个 run 前必须能清旗标"
    assert await is_cancelled(bus, "run-other") is False, "旗标按 run 隔离"


async def test_cancel_flag_has_a_ttl(bus) -> None:
    await request_cancel(bus, "run-ttl")
    ttl = await bus.ttl_key("cancel.run-ttl")
    assert 0 < ttl <= 86400, "旗标必须带 TTL，否则被杀 worker 的键永久堆积"


async def test_lease_only_current_owner_can_renew(bus) -> None:
    assert await lease_alive(bus, "run-2") is False
    assert await renew_lease(bus, "run-2", "workerA", ttl=30) is True
    assert await lease_alive(bus, "run-2") is True
    assert await lease_owner(bus, "run-2") == "workerA"
    assert await renew_lease(bus, "run-2", "workerB", ttl=30) is False, (
        "别人持有的租约不能被续：僵尸 worker 会靠它一直占着 run")
    assert await lease_owner(bus, "run-2") == "workerA"
    assert await renew_lease(bus, "run-2", "workerA", ttl=30) is True


async def test_lease_ttl_is_passed_through(bus) -> None:
    await renew_lease(bus, "run-3", "w", ttl=30)
    ttl = await bus.ttl_key("run.lease.run-3")
    assert 20 <= ttl <= 30, "TTL 必须真传到 Redis，否则 worker 崩溃后 run 永久卡在 running"


async def test_lease_expires_and_can_be_taken_over(bus) -> None:
    await renew_lease(bus, "run-4", "dead-worker", ttl=1)
    assert await renew_lease(bus, "run-4", "new-worker", ttl=30) is False
    time.sleep(1.2)
    assert await lease_alive(bus, "run-4") is False, "租约过期必须判死，否则孤儿 run 没人接管"
    assert await renew_lease(bus, "run-4", "new-worker", ttl=30) is True
    assert await lease_owner(bus, "run-4") == "new-worker"


async def test_bus_keys_are_namespaced(bus, raw) -> None:
    """键必须带 tp. 前缀：这套 Redis 与 celery broker 同实例同 db6。"""
    await request_cancel(bus, "run-5")
    assert await raw.exists("tp.cancel.run-5") == 1
    assert await raw.exists("cancel.run-5") == 0


# —— 执行上下文 ——

def test_render_string_and_deep() -> None:
    ctx = ExecutionContext(None, None, "run-1", "p1", {"uid": "7", "tok": "abc"})
    assert ctx.render("${uid}") == "7"
    assert ctx.render("no vars here") == "no vars here"
    out = ctx.render({"headers": {"Authorization": "Bearer ${tok}"}, "q": ["${uid}", 3],
                      "n": {"deep": "${uid}-${tok}"}})
    assert out == {"headers": {"Authorization": "Bearer abc"}, "q": ["7", 3],
                   "n": {"deep": "7-abc"}}


def test_render_missing_var_names_the_var() -> None:
    """Review Focus 8：缺变量必须点名，不能只说「渲染失败」。"""
    ctx = ExecutionContext(None, None, "run-1", "p1", {"uid": "7"})
    with pytest.raises(MissingVar) as e:
        ctx.render("${uid}/${uid2}")
    assert e.value.name == "uid2"
    assert "uid2" in str(e.value)
    with pytest.raises(MissingVar) as e2:
        ctx.render({"a": ["${gone}"]})
    assert e2.value.name == "gone"


def test_ctx_does_not_mutate_injected_vars() -> None:
    src = {"uid": "7"}
    ctx = ExecutionContext(None, None, "run-1", "p1", src)
    ctx.vars["extra"] = "1"
    assert "extra" not in src, "引擎改 ctx.vars 不能污染调用方传进来的字典"


def test_vars_snapshot_is_a_detached_copy() -> None:
    ctx = ExecutionContext(None, None, "run-1", "p1", {"uid": "7"})
    snap = ctx.vars_snapshot()
    snap["uid"] = "mutated"
    snap["new"] = "x"
    assert ctx.vars == {"uid": "7"}, "快照是 §8.3 重跑依据，必须与实时 vars 脱钩"


def test_headers_and_timeout_defaults() -> None:
    ctx = ExecutionContext(None, None, "run-1", "p1", {}, {"X-A": "1"}, 3000)
    assert ctx.headers == {"X-A": "1"} and ctx.timeout_ms == 3000
    assert ctx.last_response is None
    ctx2 = ExecutionContext(None, None, "run-1", "p1")
    assert ctx2.vars == {} and ctx2.headers == {} and ctx2.timeout_ms == 10000
    assert ctx2.run_id == "run-1" and ctx2.project_id == "p1"


def test_logs_accumulate_per_step_in_order() -> None:
    ctx = ExecutionContext(None, None, "run-1", "p1")
    ctx.log("n1", "第一行")
    ctx.log("n2", "别的步骤")
    ctx.log("n1", "第二行")
    assert ctx.logs_for("n1") == ["第一行", "第二行"], "按步骤隔离且有序，写进 detail.logs"
    assert ctx.logs_for("n2") == ["别的步骤"]
    assert ctx.logs_for("never-logged") == []


# —— actor / transport（T7 勘误③：handler 要以发起人身份调内部服务） ——


def test_actor_defaults_to_none_means_system() -> None:
    """不传 actor 时是「系统触发」（定时/webhook）：没有发起人身份可用。

    默认值必须是 None 而不是一个空权限的假用户：后者的效果是每条 api_case 步骤
    都因缺权限失败，用户看到的是一屏红色的「你没权限」，而真正的原因是不存在
    发起人——两种错法要能被区分开（T9 的 enqueue 就靠这个决定用不用系统身份）。
    """
    ctx = ExecutionContext(None, None, "run-1", "p1")
    assert ctx.actor is None


def test_actor_snapshot_is_copied_not_aliased() -> None:
    """actor 是发起时刻的身份快照，必须与调用方字典脱钩。

    执行可能跑几十分钟，期间发起人被降权或退出登录都是常态。快照语义（而不是
    每次步骤回查库）是刻意的产品取向：一次执行的权限在一次运行内保持一致，
    否则跑到一半会突然从 pass 变成 insufficient_permission，报告无法解释。
    """
    src = {"user_id": "u1", "user_name": "张三", "is_system_admin": False,
           "perms": {"api:case:read"}, "entry": "web"}
    ctx = ExecutionContext(None, None, "run-1", "p1", actor=src)
    src["perms"].add("scenario:update")
    src["user_name"] = "改名了"
    assert ctx.actor["perms"] == {"api:case:read"}, "权限集合必须拷副本"
    assert ctx.actor["user_name"] == "张三", "名字也要停在发起时刻"
    assert ctx.actor["entry"] == "web"


def test_actor_perms_become_a_fresh_set() -> None:
    """传 tuple/列表也行：handler 那边 ctx.require 要往 perms 里读，必须是 set。"""
    ctx = ExecutionContext(None, None, "run-1", "p1",
                          actor={"user_id": "u1", "perms": ["api:case:read", "env:read"]})
    assert isinstance(ctx.actor["perms"], set)


def test_transport_defaults_to_none_and_is_passed_through() -> None:
    """transport 默认 None = 真实网络；测试注入 ASGITransport 内存靶（勘误③）。

    这条断言看着平凡，实际是红线：如果默认值不是 None 而是某个共享 transport，
    生产环境就会悄悄连到测试靶上。
    """
    assert ExecutionContext(None, None, "run-1", "p1").transport is None
    sentinel = object()
    assert ExecutionContext(None, None, "run-1", "p1", transport=sentinel).transport is sentinel


def test_actor_and_transport_do_not_disturb_positional_args() -> None:
    """只加关键字参数，不动既有位置参数次序（T6 已有测试按位置传到 timeout_ms）。"""
    ctx = ExecutionContext(None, None, "run-9", "p9", {"a": 1}, {"X": "y"}, 2000)
    assert ctx.timeout_ms == 2000 and ctx.vars == {"a": "1"} and ctx.actor is None
