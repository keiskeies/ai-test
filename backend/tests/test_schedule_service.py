"""1E T1：定时任务服务面 + 读表调度核 + schedule.fire（§6.7 + §11.4.17 + R142/R144）。

钉的对象按计划「实测」补记（两条都是原口径会放行的真坑）：
① cron 表驱动 422 —— **必含 4 段行**（crontab 对 4 段静默补齐照收，段数闸没了它就绿着
  入库成一个错排期）与 **6 段行**（celery 抛 TypeError，只 except ValueError 会变 500）；
② next_5 严格递增 + 落上海日历（remaining_estimate 在整 */5 边界对真实 now 返回负值，
  累加口径非单调；base 注入保证测试确定性，不挂真实时钟）；
③ get_schedule 增删改即时可见、DB 挂 → 旧快照不抛、坏 cron 行跳过（同心跳的静默哲学）
  ——在 tests/test_schedule_beat.py；
④ schedule.fire：run 行 trigger="schedule" + 审计 entry=schedule/user_id NULL（R144）+
  last_run 回执；投递失败不留孤儿 queued（R42 同款）。

手法：HTTP 面走 client + admin headers（同 test_notify）；fire_task 自带 NullPool 会话
（同库不同连接——夹具数据先 commit 才可见，正是生产形状）；投递用 spy 替
_celery_client（CI 无真 worker，同「真 beat 不进 CI」条款）。

1E T1 去重（双 agent 抢单遗留）：test_schedule_1e.py 的重复断言已并入本文件——
cron 表驱动两表合一（含 1e 的 4/6/7/0 段与非法步进行）、D30 白名单改循环钉、
CRUD 双向往返 + 跨项目 DELETE 404 + 部分更新原子性、next_5 追加「预览不落库/naive
base/缺省 base 在未来」、fire 追加 run.created_by=创建者、停用行回执、缺失场景
不留 queued 行；worker 结构钉并入注册名唯一计数。1e 里只剩它独占的钉（crontab
原话进 422 body、纯函数边界、双实例同构、注册面/权限位）。
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.modules.schedule import service as svc

BASE = "/api/v1/schedule-tasks"


@pytest.fixture()
async def admin_h(client, make_user):
    _u, h = await make_user("sch_admin", admin=True)
    return h


@pytest.fixture()
async def wired_app(app):
    """fire_task 的审计走 core.write_audit 钩子——钩子在 create_app() 装配（app 夹具已调）。"""
    return app


async def _mk_project(client, h, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create(client, h, pid, **kw):
    body = {"project_id": pid, "name": "夜跑", "subject_type": "scenario",
            "subject_id": "s_dummy", "cron": "0 2 * * *", **kw}
    return await client.post(BASE, json=body, headers=h)


# ── ① cron 422 表驱动（变异自证 ①② 的红靶都在这张表） ──────────────────────────


BAD_CRONS = [
    ("0 2 * *", "4 段：celery 静默补齐成 5 段照收——段数闸没了它就是一个错排期（实测）"),
    ("0 2", "2 段同样被补齐"),
    ("   ", "空白串：split 后段数 0"),
    ("0 2 * * * extra", "7 段：段数闸同样要拦"),
    ("0 0 2 * * *", "6 段带秒：crontab 抛 TypeError，只 except ValueError 会变 500（实测）"),
    ("* * * * * *", "6 段全星号，同样 TypeError 形状"),
    ("61 * * * *", "字段级越界：ValueError 原话必须带进 422"),
    ("abc * * * *", "非数字字面量：ValueError"),
    ("*/5x * * * *", "非法步进：ValueError"),
    ("0 2 * * 8", "day_of_week 越界（上限 6）"),
    ("* * * * 8", "周越界的另一形状（1e 去重并入行）"),
]

GOOD_CRONS = ["0 2 * * *", "*/5 * * * *", "0 2 * * 1", "0 2 15 * *", "30 6 1 1 *",
              "0 9 * * 1-5", "0 0 1 1 *"]  # 后两条自 1e 表驱动去重并入（范围+周 / 年度）


@pytest.mark.parametrize("cron,why", BAD_CRONS)
async def test_create_bad_cron_422(client, admin_h, cron, why) -> None:
    pid = await _mk_project(client, admin_h, "sch_bad")
    r = await _create(client, admin_h, pid, cron=cron)
    assert r.status_code == 422, why + " → 实际 " + str(r.status_code) + " " + r.text
    assert r.json()["code"] == "validation_failed"


@pytest.mark.parametrize("cron", GOOD_CRONS)
async def test_create_good_cron_ok(client, admin_h, cron) -> None:
    """合法侧同时钉**段序映射**：celery 位置参数序是（分 时 周 日 月），`crontab(*parts)`
    会把「0 2 * * 1」（每周一）静默错排成每年 1 号（渲染串实测为 `<crontab: 0 2 * 1 *>`）、
    把「0 2 15 * *」（每月 15 号）直接拒收——关键字映射后渲染必须原样保持输入 5 段。"""
    pid = await _mk_project(client, admin_h, "sch_good")
    r = await _create(client, admin_h, pid, cron=cron)
    assert r.status_code == 201, r.text
    from app.modules.schedule.cron import crontab_of

    assert str(crontab_of(cron)) == "<crontab: " + cron + " (m/h/dM/MY/d)>"


async def test_update_bad_cron_422_row_untouched(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "sch_upd")
    tid = (await _create(client, admin_h, pid)).json()["id"]
    r = await client.patch(BASE + "/" + tid, json={"project_id": pid, "cron": "0 2 * *"}, headers=admin_h)
    assert r.status_code == 422  # 4 段——段数闸
    assert "5 段" in r.json()["message"], r.text  # 是校验闸说的 422，不是 pydantic 的缺字段
    g = await client.get(BASE + "/" + tid + "?project_id=" + pid, headers=admin_h)
    assert g.json()["cron"] == "0 2 * * *"  # 显式拒绝：行一个字节没改
    # 先校验后落值（自 1e 去重并入）：同一请求里带合法改动，坏字段一个都不许落
    r2 = await client.patch(BASE + "/" + tid, json={"project_id": pid, "cron": "0 2 * *",
                                                    "enabled": 0}, headers=admin_h)
    assert r2.status_code == 422, r2.text
    g2 = await client.get(BASE + "/" + tid + "?project_id=" + pid, headers=admin_h)
    assert g2.json()["cron"] == "0 2 * * *" and g2.json()["enabled"] == 1, g2.text


# ── D30 白名单：显式拒绝不静默改值 ──────────────────────────────────────────────


async def test_subject_type_whitelist_explicit_reject(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "sch_d30")
    # 四值全拒（自 1e 的循环表去重并入，一行不砍）+ 人话点名收到的值，不装看不见
    for st in ("ui_case", "adb_case", "api_case", "nope"):
        r = await _create(client, admin_h, pid, subject_type=st)
        assert r.status_code == 422 and r.json()["code"] == "validation_failed", st + " 应拒：" + r.text
        assert st in r.json()["message"], st + " 点名缺失：" + r.text
    # update 同样：422 且原行纹丝不动（「不静默改值」的自证）
    tid = (await _create(client, admin_h, pid)).json()["id"]
    r2 = await client.patch(BASE + "/" + tid, json={"project_id": pid, "subject_type": "ui_case"},
                            headers=admin_h)
    assert r2.status_code == 422, r2.text
    g = await client.get(BASE + "/" + tid + "?project_id=" + pid, headers=admin_h)
    assert g.json()["subject_type"] == "scenario"


# ── CRUD + project_id 显式过滤（visibility 助手对本表失效的替代钉） ──────────────


async def test_crud_and_project_isolation(client, admin_h) -> None:
    pa = await _mk_project(client, admin_h, "sch_pa")
    pb = await _mk_project(client, admin_h, "sch_pb")
    created = await _create(client, admin_h, pa, name="A任务", notify_channel_ids=["c1"])
    ta = created.json()["id"]
    # POST 回显：默认启用 + notify 渠道原样带回（自 1e 去重并入）
    assert created.json()["enabled"] == 1 and created.json()["notify_channel_ids"] == ["c1"]
    await _create(client, admin_h, pb, name="B任务")
    la = (await client.get(BASE + "?project_id=" + pa, headers=admin_h)).json()["items"]
    assert [t["id"] for t in la] == [ta]  # B 项目的行一条都不许渗进 A 的列表
    lb = (await client.get(BASE + "?project_id=" + pb, headers=admin_h)).json()["items"]
    assert len(lb) == 1 and lb[0]["id"] != ta  # 双向隔离（1e 的 A 视角行）
    # 跨项目按 id 取/删 = 与不存在同 404（不泄露存在性）
    r = await client.get(BASE + "/" + ta + "?project_id=" + pb, headers=admin_h)
    assert r.status_code == 404
    assert (await client.post(BASE + "/" + ta + "/delete", json={"project_id": pb},
                              headers=admin_h)).status_code == 404  # 跨项目删也拒（1e 钉）
    # PATCH enabled 开关 + enabled 过滤 + 删除
    p = await client.patch(BASE + "/" + ta, json={"project_id": pa, "enabled": 0}, headers=admin_h)
    assert p.status_code == 200, p.text
    lb2 = (await client.get(BASE + "?project_id=" + pa + "&enabled=1", headers=admin_h)).json()["items"]
    assert lb2 == []
    assert (await client.post(BASE + "/" + ta + "/delete", json={"project_id": pa},
                              headers=admin_h)).status_code == 200
    assert (await client.get(BASE + "/" + ta + "?project_id=" + pa, headers=admin_h)).status_code == 404


async def test_list_requires_project_member(client, make_user) -> None:
    """非成员连列表都拿不到（项目数据权限门——本表没有 visibility 那两列可兜）。"""
    _u, h = await make_user("sch_stranger")
    r = await client.get(BASE + "?project_id=p_ghost", headers=h)
    assert r.status_code == 403 and r.json()["code"] == "forbidden", r.text


# ── ② next_5：严格递增 + 上海日历（草稿 cron，未落库也照算） ────────────────────


async def test_next_5_draft_cron_strictly_increasing_shanghai(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "sch_next5")
    # base 定在整 5 分边界——计划实测的负值时刻（remaining_estimate(now) 可为负）
    r = await client.post(BASE + "/next-5", json={
        "project_id": pid, "cron": "*/5 * * * *", "base": "2026-11-16T12:05:00+00:00"}, headers=admin_h)
    assert r.status_code == 200, r.text
    times = r.json()["times"]
    assert len(times) == 5
    # 上海日历：每条都带 +08:00 偏移（不是 UTC 原样回显）
    assert all(t.endswith("+08:00") for t in times), times
    parsed = [datetime.fromisoformat(t) for t in times]
    assert all(parsed[i] < parsed[i + 1] for i in range(4)), "预览必须严格递增（第二坑）"
    # 边界起算的第一次是 12:10Z = 上海 20:10（不把边界本身 12:05 当第一次）
    assert times[0].startswith("2026-11-16T20:10:00"), times
    assert [t.strftime("%H:%M") for t in parsed] == ["20:10", "20:15", "20:20", "20:25", "20:30"]
    # naive base 视为 UTC（库内存储约定，_parse_base 的钉，自 1e 去重并入）：
    # 与上面 aware +00:00 同 base 必须算出完全相同的一串
    rn = await client.post(BASE + "/next-5", json={
        "project_id": pid, "cron": "*/5 * * * *", "base": "2026-11-16T12:05:00"}, headers=admin_h)
    assert rn.json()["times"] == times, rn.text
    # 预览不落库：草稿 cron 没保存也不该出现任务行
    assert (await client.get(BASE + "?project_id=" + pid, headers=admin_h)
            ).json()["items"] == []


async def test_next_5_daily_shanghai_wallclock(client, admin_h) -> None:
    """cron 的 02:00 是 UTC 口径（beat/celery 同在 UTC），上海日历显示 10:00——
    同一把尺的两侧，测试说破它（前端「每天 02:00」的人话翻译是 T2 前端的事）。"""
    pid = await _mk_project(client, admin_h, "sch_next5b")
    r = await client.post(BASE + "/next-5", json={
        "project_id": pid, "cron": "0 2 * * *", "base": "2026-11-16T12:05:00+00:00"}, headers=admin_h)
    times = r.json()["times"]
    # 精确到分：上海墙上时钟 10:00 整 × 5 个不同日历日（自 1e 去重并入的精确度）
    assert [t[:16] for t in times] == ["2026-11-17T10:00", "2026-11-18T10:00", "2026-11-19T10:00",
                                       "2026-11-20T10:00", "2026-11-21T10:00"], times


async def test_next_5_bad_cron_422_same_gate(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "sch_next5c")
    r = await client.post(BASE + "/next-5", json={"project_id": pid, "cron": "0 2 * *"}, headers=admin_h)
    assert r.status_code == 422  # 草稿预览与入库同一道闸（4 段）
    # 缺省 base = 当前时刻：首个预览必须落在未来（自 1e 去重并入）
    now_r = await client.post(BASE + "/next-5", json={"project_id": pid, "cron": "0 2 * * *"},
                              headers=admin_h)
    assert datetime.fromisoformat(now_r.json()["times"][0]) > datetime.now(UTC), now_r.text


def test_display_tz_single_ruler() -> None:
    """展示日历一把尺：schedule 侧 DISPLAY_TZ 与 workbench 的 DISPLAY_TZ 同值
    （领域模块不许 import composition 层，常量同值由本钉守，漂移即红）。"""
    from app.modules.schedule.cron import DISPLAY_TZ
    from app.modules.workbench.services import DISPLAY_TZ as W

    assert str(DISPLAY_TZ) == str(W) == "Asia/Shanghai"


# ── ④ schedule.fire：run 行 + R144 审计 + last_run 回执 + 不留孤儿 ───────────────


async def _seed_scenario(session, pid: str, name: str = "履约回归",
                         status: str = "normal") -> str:
    from app.modules.scenario.models import Scenario

    s = Scenario(project_id=pid, name=name, status=status,
                 step_graph={"nodes": [], "edges": []})
    session.add(s)
    await session.commit()
    return s.id


class _SpyCelery:
    def __init__(self, fail: bool = False) -> None:
        self.sent: list = []
        self.fail = fail

    def send_task(self, name, args=None, **kw):
        if self.fail:
            raise OSError("broker down (spy)")
        self.sent.append((name, args, kw))


async def test_fire_creates_run_audit_receipt(client, admin_h, session, make_user, monkeypatch, app) -> None:
    """fire 全链路：trigger=schedule 的 queued run + 审计 entry=schedule/user_id NULL/
    action=schedule_task.run（R144）+ last_run 回执 + send_task("scenario.run") 按名字投
    （R42：不 import 任务对象）；actor = 任务创建者快照（R144 的 run 侧语义）。"""
    from app.modules.audit.models import AuditLog
    from app.modules.execution.models import RunRecord

    boss, _h = await make_user("sch_boss", admin=True)
    spy = _SpyCelery()
    monkeypatch.setattr(svc, "_celery_client", lambda: spy)

    pid = await _mk_project(client, admin_h, "sch_fire")
    sid = await _seed_scenario(session, pid)
    task = (await _create(client, admin_h, pid, subject_id=sid, name="夜间回归",
                          env_id=None)).json()

    receipt = await svc.fire_task(task["id"])
    assert receipt["ok"] is True and receipt["run_id"], receipt

    # TaskOut 不吐 created_by 按名查库——必须在 fire 提交之后查（先查会在本会话
    # 提前开 RR 快照，看不见 fire 的 run 行——去重合并时实测踩到过）
    from sqlalchemy import text as sa_text

    owner = (await session.execute(sa_text("SELECT created_by FROM schedule_task WHERE id=:i"),
                                   {"i": task["id"]})).first()[0]
    runs = (await session.execute(
        select(RunRecord).where(RunRecord.subject_id == sid))).scalars().all()
    assert len(runs) == 1
    run = runs[0]
    assert run.trigger == "schedule" and run.status == "queued"
    assert run.subject_type == "scenario" and run.subject_id == sid
    assert run.subject_name == "履约回归"  # 快照名是场景名（报告中心可读）
    # run.created_by = 任务创建者（R144 actor 语义的 run 侧，自 1e 去重并入）
    assert run.created_by == owner

    audits = (await session.execute(
        select(AuditLog).where(AuditLog.action == "schedule_task.run"))).scalars().all()
    assert len(audits) == 1
    a = audits[0]
    assert a.entry == "schedule" and a.user_id is None  # R144：审计记人，机器触发 NULL
    assert a.ok is True and a.diff["run_id"] == receipt["run_id"] and a.target == pid

    from app.core.config import get_settings

    assert len(spy.sent) == 1
    name, args, kw = spy.sent[0]
    assert name == "scenario.run" and args[0] == receipt["run_id"]
    actor = args[1]
    assert kw["queue"] == get_settings().task_queue
    # actor = 创建者快照（owner 前面已查库）
    assert actor["user_id"] == owner
    assert actor["entry"] == "schedule" and actor["user_name"] == "sch_admin"

    fresh = await session.get(svc.ScheduleTask, task["id"])
    await session.refresh(fresh)
    assert fresh.last_run["ok"] is True and fresh.last_run["run_id"] == receipt["run_id"]


async def test_fire_deleted_task_and_dead_scenario_receipts(client, admin_h, session, monkeypatch, app) -> None:
    """行删了/停用了/场景没了：回执说人话、不抛、不投毒任务、不留 queued 孤儿；
    场景缺失还落 ok=False 审计（R144）。"""
    from app.modules.audit.models import AuditLog
    from app.modules.execution.models import RunRecord

    spy = _SpyCelery()
    monkeypatch.setattr(svc, "_celery_client", lambda: spy)
    assert (await svc.fire_task("no-such-task"))["ok"] is False
    assert spy.sent == []

    pid = await _mk_project(client, admin_h, "sch_fire2")
    sid = await _seed_scenario(session, pid, "先删后触发")
    task = (await _create(client, admin_h, pid, subject_id="gone-scenario")).json()
    # 停用行（自 1e 去重并入）：回执点名「停用」，不投递
    off = (await _create(client, admin_h, pid, subject_id=sid, name="停用行")).json()
    assert (await client.patch(BASE + "/" + off["id"], json={"project_id": pid, "enabled": 0},
                               headers=admin_h)).status_code == 200
    r_off = await svc.fire_task(off["id"])
    assert r_off["ok"] is False and "停用" in r_off["reason"], r_off
    rec = await svc.fire_task(task["id"])
    assert rec["ok"] is False and "场景" in rec["reason"], rec
    # 真不存在分支的文案钉（第二十六轮）：只说「不存在」，不许顺嘴带「回收站」；
    # 整句相等而非 in——旧句「场景不存在或已被删除」也含前缀，in 会放过旧谎。
    # 键集合是抽屉「最近结果」与审计 diff 的契约，只许换 reason 的文字。
    assert rec["reason"] == "场景不存在，未投递", rec
    assert set(rec) == {"ok", "reason", "fired_at"}, rec
    assert spy.sent == []
    fresh = await session.get(svc.ScheduleTask, task["id"])
    await session.refresh(fresh)
    assert fresh.last_run is not None and fresh.last_run["ok"] is False
    bad = (await session.execute(
        select(AuditLog).where(AuditLog.action == "schedule_task.run", AuditLog.ok.is_(False))
    )).scalars().all()
    # 停用行在审计之前就早退（不落 ok=False 账），故此处仍恰一条
    assert len(bad) == 1 and bad[0].entry == "schedule" and bad[0].user_id is None
    # 未投递成功就不该有 queued 孤儿（自 1e 去重并入）
    session.expire_all()
    assert (await session.execute(
        select(RunRecord).where(RunRecord.project_id == pid))).scalars().all() == []


async def test_fire_recycled_scenario_receipt_names_recycle_bin(
        client, admin_h, session, monkeypatch, app) -> None:
    """回收站场景（status=recycled）≠ 不存在：回执必须说「回收站」并给出路（恢复/改绑），
    不许演成「不存在/已被删除」——用户照那句会去找「被删的场景」，实际要做的是恢复或改绑。
    行为半边照旧钉死：不投递、不落 run 行、回执键集合不变。"""
    from app.modules.execution.models import RunRecord

    spy = _SpyCelery()
    monkeypatch.setattr(svc, "_celery_client", lambda: spy)
    pid = await _mk_project(client, admin_h, "sch_fire_rc")
    sid = await _seed_scenario(session, pid, "回收站里的场景", status="recycled")
    task = (await _create(client, admin_h, pid, subject_id=sid)).json()

    rec = await svc.fire_task(task["id"])
    assert rec["ok"] is False, rec
    assert "回收站" in rec["reason"], rec
    assert "不存在" not in rec["reason"], rec
    assert set(rec) == {"ok", "reason", "fired_at"}, rec
    assert spy.sent == []
    fresh = await session.get(svc.ScheduleTask, task["id"])
    await session.refresh(fresh)
    assert fresh.last_run is not None and fresh.last_run["ok"] is False
    session.expire_all()
    assert (await session.execute(
        select(RunRecord).where(RunRecord.project_id == pid))).scalars().all() == []


async def test_fire_send_failure_leaves_no_orphan(client, admin_h, session, monkeypatch, app) -> None:
    """投递炸（broker 没起）：删刚建的 run 行不留永远 queued 的孤儿（R42 同款），回执落账。"""
    from app.modules.execution.models import RunRecord

    monkeypatch.setattr(svc, "_celery_client", lambda: _SpyCelery(fail=True))
    pid = await _mk_project(client, admin_h, "sch_fire3")
    sid = await _seed_scenario(session, pid, "被定时打的场景")
    task = (await _create(client, admin_h, pid, subject_id=sid)).json()
    rec = await svc.fire_task(task["id"])
    assert rec["ok"] is False and "投递失败" in rec["reason"], rec
    session.expire_all()
    orphans = (await session.execute(
        select(RunRecord).where(RunRecord.subject_id == sid))).scalars().all()
    assert orphans == [], "投递失败的 run 行必须被删干净（不留孤儿 queued）"


# ── 结构钉：worker 模块级不 import schedule（既有钉同款纪律，tests 扫源码） ──────


def test_worker_does_not_import_schedule_at_module_level() -> None:
    import app.worker as worker_mod

    assert "schedule.fire" in worker_mod.celery_app.tasks
    # 名字注册不许双份：同 name 两次注册 = 并行改动没对齐，谁赢看导入顺序（1e 去重并入）
    assert len([t for t in worker_mod.celery_app.tasks if t == "schedule.fire"]) == 1
    src = open(worker_mod.__file__, encoding="utf-8").read()
    top = [ln for ln in src.splitlines() if ln.startswith(("import ", "from "))]
    assert not any("schedule" in ln for ln in top), \
        "worker 模块级不许 import schedule（fire 体在任务体内取，同 scenario 钉）"
