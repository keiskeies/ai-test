"""D10 / R118 · Celery 队列按 TP_ENV 分道（1D T0，台账明写「放在 1D 开头」）。

钉的是一条**跨进程契约**：投递方 `send_task(queue=…)` 与消费方
`celery_app.conf.task_default_queue` 必须从**同一个函数**（Settings.task_queue）
推导同一个名字。这条契约在单进程里测不出来——两边同错也算一致——所以本文件分三层：

① 纯函数层：task_queue 从 env 推导，且**每次读现算**（投递方是长命 web 进程，
   env 在测试里被换掉后不许还吃到 import 时烘焙的旧队列名）；
② worker 层：conf 里的默认队列 = 本进程 env 推出的那条（worker 是**一个进程一条 lane**，
   import 时烘焙是正确行为，与 ① 的「现算」刻意不对称，理由写在 config 的注释里）；
③ 投递层：三条真投递路（scenario enqueue / ui_case run / adb_case run 端点）真的把
   queue 带出去（1D T7 加第三条）。
   这一层以前**从来没有测试**：celery 档只测过「broker 死了 → 503」，
   「broker 活着时投到哪」全靠肉眼——R118 那种「任务被别人的 worker 领走」恰好
   死在这条没人看的缝里；
④ 事故现场本身：两条 lane 的 worker 对同一条消息一领一空，用 fakeredis 上的
   kombu 直接复现（改回共用默认队列这条必红）。

R118 的原始事故：golden/e2e/verify 与演示常驻 worker 共用 Redis DB6 的**默认队列**，
演示 worker 领走 golden 投的 run，在另一套库上跑一个测试不认识的场景，
测试这边永远 queued 到超时（`last=queued`）。修好之后这道防线由队列名负责，
手册里那句「跑门禁前先确认没有常驻 worker」降级为提示。
"""
from __future__ import annotations

import pytest

# —— ① 纯函数层 ——————————————————————————————————————————————


def test_task_queue_derives_from_env_and_is_computed_live(monkeypatch) -> None:
    from app.core.config import get_settings

    s = get_settings()
    assert s.task_queue == "tp." + s.env

    # 现算，不是 import 时烘焙：投递方可能在 env 被换掉之后才投第一张任务。
    # monkeypatch 而不是手改 s.env——手改忘还原就是污染整个 pytest session 的 lane
    # （我自己写这版时先写成了「测完还回 dev」，而 conftest 的默认是 test）。
    seen = set()
    for probe in ("dev", "test", "e2e", "verify"):
        monkeypatch.setattr(s, "env", probe)
        assert s.task_queue == "tp." + probe
        seen.add(s.task_queue)
    # 不同 env 必须推出不同队列——整条防线的意义就是这个单射
    assert len(seen) == 4, "四条 lane 推出同名队列 = 分道形同虚设"


# —— ② worker 层 ——————————————————————————————————————————————


def test_worker_default_queue_follows_env() -> None:
    """worker 的 task_default_queue 必须来自 settings.env。

    worker 在**模块 import 时**烘焙（一个进程 = 一条 lane，进程活着期间 env 不变，
    烘焙是对的；投递方才需要现算）。所以这里断言的是「烘焙值 = 本进程 env 的推导值」，
    而不是「monkeypatch env 后 conf 会动」——后者会把错误的对称性钉成规格。
    """
    from app.core.config import get_settings
    from app.worker import celery_app

    assert celery_app.conf.task_default_queue == "tp." + get_settings().env
    # conftest 钉死 TP_ENV=test → 测试进程里 worker 领的必须是 tp.test，
    # 演示 worker（tp.dev）物理上看不见这里投的任务。
    assert celery_app.conf.task_default_queue == "tp.test"
    # 手册里的启动命令一字不改仍能工作，靠的就是 default_queue 而不是强制 -Q：
    # `celery -A app.worker:celery_app worker --pool=solo` 里没有任何队列参数。
    assert celery_app.conf.worker_prefetch_multiplier == 1  # R118 注释里那条同族配置没被顺手改掉


# —— ③ 投递层：三条真路各投一次 ——————————————————————————————


class _SendSpy:
    """假 Celery 客户端：只记 send_task 的入参，不碰 broker。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, str | None]] = []

    def send_task(self, name, args=None, queue=None, **kw):
        self.calls.append((name, tuple(args or ()), queue))
        return object()  # 返回值只被 enqueue 无视（真相以库里 run 行为准）


@pytest.fixture()
def lane_env(monkeypatch):
    """celery 档 + 一个**故意非默认**的 env 名。

    用 "lanetest" 这种一眼假的 lane：如果哪天 queue 参数丢了，断言里 "tp.lanetest"
    对比 spy 记到的 None 会直接指到病灶；沿用 "test" 的话，「queue 丢了」与
    「queue 是 test」在失败信息里长一个样。
    """
    from app.core.config import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "env", "lanetest", raising=False)
    monkeypatch.setattr(s, "exec_mode", "celery", raising=False)
    return s


async def test_scenario_enqueue_sends_to_env_queue(session, client, make_user,
                                                   lane_env, monkeypatch) -> None:
    from app.modules.scenario import orchestration as orch

    spy = _SendSpy()
    monkeypatch.setattr(orch, "_celery_client", lambda: spy)

    async def _alive() -> bool:
        return True

    monkeypatch.setattr(orch, "_broker_alive", _alive)

    g = {"version": 1, "nodes": [
        {"key": "s1", "kind": "set_var", "name": "s1", "ref": None,
         "config": {"vars": {"a": "1"}}, "children": []}]}
    u, h = await make_user("t10q1")
    pid = (await client.post("/api/v1/projects", json={"name": "t10qp"}, headers=h)).json()["id"]
    sid = (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "分道场景", "step_graph": g})).json()["id"]

    rec = await orch.enqueue(session, project_id=pid, subject_id=sid, subject_name="分道场景",
                             trigger="manual", created_by=u.id)
    assert len(spy.calls) == 1, "celery 档必须真投一次（投 0 次 = 永远 queued 的那条老路）"
    name, args, q = spy.calls[0]
    assert name == orch.RUN_TASK_NAME
    assert args[0] == rec.id
    assert q == "tp.lanetest", (f"投递没带本 lane 的队列名（拿到 {q!r}）——"
                                "queue 参数丢了就会退回默认队列，R118 的抢任务事故复活")


async def test_ui_case_run_sends_to_env_queue(client, make_user, lane_env,
                                              monkeypatch) -> None:
    """HTTP 真路：POST /ui-cases/{id}/run 的投递也必须带 lane 队列名。

    这路与 scenario 那条**各测各的**不是重复：两处 send_task 是两个文件里的两行代码
    （契约 1 不许 ui_test import scenario），改一处忘另一处正是这类分道最常见的死法。
    """
    from app.modules.ui_test import debug_services as dbg

    spy = _SendSpy()
    monkeypatch.setattr(dbg, "_celery_client", lambda: spy)

    async def _alive() -> bool:
        return True

    monkeypatch.setattr(dbg, "_broker_alive", _alive)

    _, h = await make_user("t10qrun")
    pid = (await client.post("/api/v1/projects", json={"name": "t10qrunp"}, headers=h)).json()["id"]
    r = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "分道用例", "steps": [
            {"id": "u1", "type": "open", "input": "http://x.test"}]}, headers=h)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]

    r2 = await client.post(f"/api/v1/ui-cases/{cid}/run", json={"project_id": pid}, headers=h)
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "queued"
    assert len(spy.calls) == 1
    name, _args, q = spy.calls[0]
    assert name == dbg.UI_RUN_TASK_NAME
    assert q == "tp.lanetest"


async def test_adb_case_run_sends_to_env_queue(client, make_user, lane_env,
                                               monkeypatch) -> None:
    """1D T7：第三条真投递路（POST /adb-cases/{id}/run）也必须带 lane 队列名。

    三处 send_task 是三个文件里的三行代码（契约 1 互不 import），R118 的死法就是
    「改两处忘第三处」——这条与 ui/scenario 两条各测各的，不是重复。
    """
    from app.modules.adb_test import debug_services as dbg

    spy = _SendSpy()
    monkeypatch.setattr(dbg, "_celery_client", lambda: spy)

    async def _alive() -> bool:
        return True

    monkeypatch.setattr(dbg, "_broker_alive", _alive)

    _, h = await make_user("t7qrun")
    pid = (await client.post("/api/v1/projects", json={"name": "t7qrunp"}, headers=h)).json()["id"]
    r = await client.post("/api/v1/adb-cases", json={
        "project_id": pid, "name": "分道用例", "steps": [{"id": "a1", "type": "home"}]}, headers=h)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]

    r2 = await client.post(f"/api/v1/adb-cases/{cid}/run", json={"project_id": pid}, headers=h)
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "queued"
    assert len(spy.calls) == 1
    name, args, q = spy.calls[0]
    assert name == dbg.ADB_RUN_TASK_NAME
    assert isinstance(args[0], str) and args[0], "run_id 必须随任务走（worker 按它领行）"
    assert q == "tp.lanetest"


# —— ④ 事故现场本身：跨 lane 不可见 ————————————————————————————


async def test_lanes_cannot_steal_each_others_messages() -> None:
    """R118 的机器可验版：投进 tp.test 的消息，领 tp.dev 的 worker 取不到。

    这条测的是**修复所依赖的前提**——「队列名不同 ⇒ 互相看不见」——它是 kombu/celery
    的路由语义，以前的形状（两边都吃默认队列）恰好在它外面。用 kombu 自带的 memory
    传输扮演 broker：同一进程里两个 Connection 共享它的 GlobalState，等价于
    「两个 worker 连同一个 Redis、各领各的队列」，不碰真 Redis 也不赌 fakeredis
    对 kombu 所用命令的子集支持（第一版用 fakeredis 直接 KeyError 在 redis 命令层）。
    """
    from kombu import Connection, Queue
    from kombu.messaging import Producer

    a = Connection("memory://")
    b = Connection("memory://")

    q_test = Queue("tp.test", routing_key="tp.test")
    q_dev = Queue("tp.dev", routing_key="tp.dev")

    with a.channel() as ch:
        Producer(ch).publish({"run_id": "r1"}, routing_key="tp.test", declare=[q_test])

    def drain(conn, unbound: Queue) -> list:
        with conn.channel() as ch:
            unbound(ch).declare()  # 绑定到本 channel 再声明（celery worker 起消费前同款动作）
            got = ch.basic_get(queue=unbound.name, no_ack=True)  # 取一条；空队列返回 None
            # kombu 6 的 basic_get 返回解码好的 Message（老版本是 (msg, meta, payload) 元组）
            return [] if got is None else [got.payload]

    # **先让别的 lane 试偷**，再让本 lane 领。顺序反过来这条不可能红：
    # 若本 lane 先 drain 掉唯一一条消息，另一 lane 观察到空队列就只是「本来就没货」，
    # 与「隔离生效」在断言里长得一模一样（变异实验抓到的，见台账 R138）。
    assert drain(b, q_dev) == [], "别的 lane 的 worker 绝不能领到（R118 的病根）"
    assert drain(a, q_test) == [{"run_id": "r1"}], "本 lane 的 worker 必须领得到（消息没被偷）"
