"""D226：定时任务支持「测试计划」（MS 计划定时执行）——白名单、env 语义、fire 支路。

钉的五件事：

① **subject_type 白名单 = scenario / plan**，其余 422 且 details.allowed 报全量清单
   （D30 的「显式拒绝不静默改值」继续有效，只是从单值变两值）。
② **计划任务不绑环境**：create 带 env_id → 422（显式拒绝，不静默丢一个永远读不到的
   列值）；update 切到 plan 时把旧 env_id **清掉**（GET 即刻可见），PATCH 无法用 null
   解绑，所以清空必须由服务做。
③ **fire 走 plan_execute 且以创建者身份**：经 REGISTRY 按名取（不横向 import testplan），
   派发时 ctx.entry="schedule"——子 run 的 trigger 由 trigger_from_entry 落 "schedule"
   （否则定时跑出来的用例在运行记录里显示成「手动」）。
④ **跑不了的如实回执**：计划不存在 / 已归档 / 创建者已删除，各给一句可上屏的原因，
   且零派发（stub 未被调用）；单条 ApiError 由 plan_execute 记 skipped，不拖垮整批。
⑤ **回执落 last_run + 审计 ok 轴**：成功记 submitted/skipped；失败记 reason。

手法同 test_schedule_service：HTTP 面走 client + admin headers；fire_task 自带 NullPool
会话（先 commit 才可见）；派发用 REGISTRY.handler 的 spy（CI 无真 worker）。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.core.errors import ApiError
from app.core.registry import REGISTRY
from app.modules.schedule import service as svc

BASE = "/api/v1/schedule-tasks"


@pytest.fixture()
async def admin_h(client, make_user):
    _u, h = await make_user("d226_admin", admin=True)
    return h


async def _mk_project(client, h, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mk_plan_with_link(client, h, pid: str) -> tuple[str, str]:
    """建计划 + 一个场景关联；返回 (plan_id, scenario_id)。"""
    s = await client.post("/api/v1/scenarios", json={"project_id": pid, "name": "D226 场景"},
                          headers=h)
    assert s.status_code in (200, 201), s.text
    sid = s.json()["id"]
    p = await client.post("/api/v1/plans", json={"project_id": pid, "name": "D226 计划"},
                          headers=h)
    assert p.status_code in (200, 201), p.text
    pid_plan = p.json()["id"]
    lk = await client.post(f"/api/v1/plans/{pid_plan}/case-links",
                           json={"project_id": pid, "subject_type": "scenario", "subject_id": sid},
                           headers=h)
    assert lk.status_code in (200, 201), lk.text
    return pid_plan, sid


async def _mk_task(client, h, pid: str, *, subject_type: str, subject_id: str, **kw):
    body = {"project_id": pid, "name": "D226 任务", "subject_type": subject_type,
            "subject_id": subject_id, "cron": "0 2 * * *", **kw}
    return await client.post(BASE, json=body, headers=h)


def _spy(name: str, fn):
    """临时换 REGISTRY 某服务的 handler（ToolSpec 是可变 dataclass，D225 同款手法）。"""
    spec = REGISTRY.get(name)
    assert spec is not None, name
    old = spec.handler
    spec.handler = fn
    return spec, old


# ── ① 白名单与 ② env 语义 ─────────────────────────────────────────────────────


@pytest.mark.parametrize("st", ["ui_case", "adb_case", "inline", "nonsense"])
async def test_subject_type_outside_whitelist_422(client, admin_h, st: str) -> None:
    pid = await _mk_project(client, admin_h, "D226 白名单-" + st)
    r = await _mk_task(client, admin_h, pid, subject_type=st, subject_id="x")
    assert r.status_code == 422 and r.json()["code"] == "validation_failed", r.text
    assert r.json()["details"]["allowed"] == ["scenario", "plan", "plan_report"], r.text


async def test_plan_task_rejects_env_id(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D226 plan-env")
    env = await client.post("/api/v1/envs", params={"project_id": pid},
                            json={"project_id": pid, "name": "D226 环境"}, headers=admin_h)
    assert env.status_code in (200, 201), env.text
    r = await _mk_task(client, admin_h, pid, subject_type="plan", subject_id="p_x",
                       env_id=env.json()["id"])
    assert r.status_code == 422, r.text
    assert "不绑定环境" in r.json()["message"], r.text


async def test_update_switch_to_plan_clears_env(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D226 切主体")
    env = await client.post("/api/v1/envs", params={"project_id": pid},
                            json={"project_id": pid, "name": "D226 环境2"}, headers=admin_h)
    assert env.status_code in (200, 201), env.text
    c = await _mk_task(client, admin_h, pid, subject_type="scenario", subject_id="s_x",
                       env_id=env.json()["id"])
    assert c.status_code in (200, 201), c.text
    tid = c.json()["id"]
    assert c.json()["env_id"] == env.json()["id"]
    r = await client.patch(BASE + "/" + tid, json={"project_id": pid, "subject_type": "plan"},
                           headers=admin_h)
    assert r.status_code == 200, r.text
    assert r.json()["subject_type"] == "plan"
    assert r.json()["env_id"] is None, "切到计划必须清掉场景级环境（不留孤儿绑定）"
    # 反向：同一次提交里又给 env_id → 422 且原行不动
    r2 = await client.patch(BASE + "/" + tid,
                            json={"project_id": pid, "subject_type": "plan",
                                  "env_id": env.json()["id"]}, headers=admin_h)
    assert r2.status_code == 422, r2.text
    g = await client.get(BASE + "/" + tid, params={"project_id": pid}, headers=admin_h)
    assert g.json()["env_id"] is None


# ── ③④⑤ fire 支路 ─────────────────────────────────────────────────────────────


async def test_fire_plan_dispatches_with_schedule_identity(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D226 触发")
    plan_id, sid = await _mk_plan_with_link(client, admin_h, pid)
    t = await _mk_task(client, admin_h, pid, subject_type="plan", subject_id=plan_id)
    assert t.status_code in (200, 201), t.text
    tid = t.json()["id"]

    calls: list[tuple[dict, str]] = []

    async def stub_run(payload, ctx):
        calls.append((payload.model_dump(), ctx.entry))
        return SimpleNamespace(run_id="run-d226")

    spec, old = _spy("scenario_run", stub_run)
    try:
        receipt = await svc.fire_task(tid)
    finally:
        spec.handler = old

    assert receipt["ok"] is True, receipt
    assert receipt["submitted"] == 1 and receipt["skipped"] == 0, receipt
    assert len(calls) == 1
    body, entry = calls[0]
    assert body["scenario_id"] == sid and body["project_id"] == pid
    # 子 run 的 trigger 口径：ctx.entry=schedule → trigger_from_entry 落 "schedule"
    assert entry == "schedule"

    got = await client.get(BASE + "/" + tid, params={"project_id": pid}, headers=admin_h)
    lr = got.json()["last_run"]
    assert lr["ok"] is True and lr["submitted"] == 1 and lr["skipped"] == 0, lr


async def test_fire_plan_single_failure_is_skipped_not_fatal(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D226 单条失败")
    plan_id, _sid = await _mk_plan_with_link(client, admin_h, pid)
    t = await _mk_task(client, admin_h, pid, subject_type="plan", subject_id=plan_id)
    tid = t.json()["id"]

    async def stub_503(payload, ctx):
        raise ApiError("unavailable", "broker 不可达", 503)

    spec, old = _spy("scenario_run", stub_503)
    try:
        receipt = await svc.fire_task(tid)
    finally:
        spec.handler = old
    assert receipt["ok"] is True, receipt
    assert receipt["submitted"] == 0 and receipt["skipped"] == 1, receipt


async def test_fire_plan_missing_plan_no_dispatch(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D226 计划消失")
    t = await _mk_task(client, admin_h, pid, subject_type="plan", subject_id="no-such-plan")
    tid = t.json()["id"]
    calls: list[int] = []

    async def stub_run(payload, ctx):
        calls.append(1)
        return SimpleNamespace(run_id="x")

    spec, old = _spy("scenario_run", stub_run)
    try:
        receipt = await svc.fire_task(tid)
    finally:
        spec.handler = old
    assert receipt["ok"] is False and "计划不存在" in receipt["reason"], receipt
    assert calls == []


async def test_fire_plan_archived_no_dispatch(client, admin_h) -> None:
    pid = await _mk_project(client, admin_h, "D226 归档")
    plan_id, _sid = await _mk_plan_with_link(client, admin_h, pid)
    a = await client.post(f"/api/v1/plans/{plan_id}/archive", json={"project_id": pid},
                          headers=admin_h)
    assert a.status_code == 200, a.text
    t = await _mk_task(client, admin_h, pid, subject_type="plan", subject_id=plan_id)
    tid = t.json()["id"]
    calls: list[int] = []

    async def stub_run(payload, ctx):
        calls.append(1)
        return SimpleNamespace(run_id="x")

    spec, old = _spy("scenario_run", stub_run)
    try:
        receipt = await svc.fire_task(tid)
    finally:
        spec.handler = old
    assert receipt["ok"] is False and "归档" in receipt["reason"], receipt
    assert calls == []


async def test_fire_plan_creator_deleted_no_dispatch(client, admin_h, session) -> None:
    from sqlalchemy import update

    from app.modules.schedule.models import ScheduleTask

    pid = await _mk_project(client, admin_h, "D226 创建者没了")
    plan_id, _sid = await _mk_plan_with_link(client, admin_h, pid)
    t = await _mk_task(client, admin_h, pid, subject_type="plan", subject_id=plan_id)
    tid = t.json()["id"]
    await session.execute(update(ScheduleTask).where(ScheduleTask.id == tid)
                          .values(created_by="ghost-user"))
    await session.commit()
    receipt = await svc.fire_task(tid)
    assert receipt["ok"] is False and "创建者已删除" in receipt["reason"], receipt


def test_trigger_from_entry_mapping() -> None:
    """子 run 的 trigger 事实口径（execution/models.py:25 的五个词）。"""
    from app.core.service import trigger_from_entry

    assert trigger_from_entry("agent") == "agent"
    assert trigger_from_entry("schedule") == "schedule"
    assert trigger_from_entry("http") == "manual"
