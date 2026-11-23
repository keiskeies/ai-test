"""D225 判据刀：执行计划（投递 + 逐条回报跳过原因）。

钉的契约：

1. **投递走各自领域的既有执行服务**（`scenario_run` / `ui_case_run` / `adb_case_run` /
   `api_case_run`），经 REGISTRY 派发；每条关联恰好投一次，入参按 subject 类型正确成形
   （场景喂 `scenario_id`，UI/ADB/接口用例喂 `case_id`），顺序 = 关联 id 升序。
2. **逐条失败不拖垮整批，且失败可见**：某条 `ApiError` 只记该条 reason，其余照投。
3. **跑不了的如实跳过**：functional_case（人工执行）不进投递表，reason 说清去哪做，
   不谎报「已投递」。接口用例自 D228 起有独立执行服务，进投递表。
4. **归档计划 409**；跨项目与不存在同码同文案（404）；没有执行位（READONLY）403。
"""
from __future__ import annotations

from types import SimpleNamespace

from app.core.errors import ApiError
from app.core.registry import REGISTRY
from app.modules.adb_test.models import AdbCase
from app.modules.api_test.models import ApiCase
from app.modules.scenario.models import Scenario
from app.modules.testplan.models import PlanCaseLink
from app.modules.ui_test.models import UiCase

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _plan(client, h, pid: str, name: str = "回归计划") -> str:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _link(client, h, pid: str, plan_id: str, subject_type: str, subject_id: str) -> dict:
    r = await client.post(_BASE + f"/plans/{plan_id}/case-links", json={
        "project_id": pid, "plan_id": plan_id,
        "subject_type": subject_type, "subject_id": subject_id,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _seed_subjects(session, pid: str, user_id: str) -> None:
    session.add_all([
        Scenario(id="sc-d225", project_id=pid, name="登录场景", status="normal",
                 step_graph={"nodes": [], "edges": []}, fail_fast=1, version=1,
                 project_public=True, owner_id=user_id),
        UiCase(id="ui-d225", project_id=pid, name="登录界面", status="normal",
               steps=[], enabled=1, project_public=True, owner_id=user_id),
        AdbCase(id="ad-d225", project_id=pid, name="登录真机", status="normal",
                steps=[], enabled=1, project_public=True, owner_id=user_id),
        ApiCase(id="ap-d225", project_id=pid, definition_id="def-x", name="登录接口",
                priority="P2", project_public=True, status="normal", owner_id=user_id),
    ])
    await session.commit()


def _stub_runs(monkeypatch, *, adb_error: bool = False) -> list[tuple[str, dict]]:
    """把三家投递服务换成记录器：只验编排，不真起 worker/浏览器/真机。"""
    calls: list[tuple[str, dict]] = []

    def stub(name: str, prefix: str):
        async def handler(payload, ctx):
            calls.append((name, payload.model_dump()))
            if name == "adb_case" and adb_error:
                raise ApiError("executor_unavailable", "执行器不可用：worker 未启动", 503)
            return SimpleNamespace(run_id=f"run-{prefix}")
        return handler

    for kind, svc, prefix in (("scenario", "scenario_run", "s"),
                              ("ui_case", "ui_case_run", "u"),
                              ("adb_case", "adb_case_run", "a"),
                              ("api_case", "api_case_run", "c")):
        spec = REGISTRY.get(svc)
        assert spec is not None, f"{svc} 未注册"
        monkeypatch.setattr(spec, "handler", stub(kind, prefix))
    return calls


async def test_execute_submits_runnable_and_reports_skips(
    client, session, make_user, monkeypatch,
) -> None:
    user, h = await make_user("d225a", admin=True)
    pid = await _proj(client, h, "D225执行")
    await _seed_subjects(session, pid, user.id)
    plan_id = await _plan(client, h, pid)
    links = [
        await _link(client, h, pid, plan_id, "api_case", "ap-d225"),
        await _link(client, h, pid, plan_id, "scenario", "sc-d225"),
        await _link(client, h, pid, plan_id, "ui_case", "ui-d225"),
        await _link(client, h, pid, plan_id, "adb_case", "ad-d225"),
    ]
    # 功能用例走人工结论（D204），没有「投递」这回事：这里只测它被如实跳过
    session.add(PlanCaseLink(id="lk-d225-fn", project_id=pid, plan_id=plan_id,
                             subject_type="functional_case", subject_id="fn-d225",
                             subject_name="功能用例X", sort_order=9))
    await session.commit()

    calls = _stub_runs(monkeypatch)
    r = await client.post(_BASE + f"/plans/{plan_id}/execute",
                          json={"project_id": pid, "plan_id": plan_id}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["submitted"], body["skipped"]) == (4, 1)

    by_type = {i["subject_type"]: i for i in body["items"]}
    assert by_type["scenario"]["run_id"] == "run-s"
    assert by_type["ui_case"]["run_id"] == "run-u"
    assert by_type["adb_case"]["run_id"] == "run-a"
    assert by_type["api_case"]["run_id"] == "run-c"
    assert "人工执行" in by_type["functional_case"]["reason"]

    # 每条恰好投一次，入参按类型成形（关联 id 是随机 uuid，投递顺序跟着关联序走，
    # 所以按类型取入参，不对 calls 下标写死）
    assert sorted(c[0] for c in calls) == ["adb_case", "api_case", "scenario", "ui_case"]
    by_kind = {c[0]: c[1] for c in calls}
    assert by_kind["scenario"]["scenario_id"] == "sc-d225" and "case_id" not in by_kind["scenario"]
    assert by_kind["ui_case"]["case_id"] == "ui-d225"
    assert by_kind["adb_case"]["case_id"] == "ad-d225"
    assert by_kind["api_case"]["case_id"] == "ap-d225"
    # items 的顺序 = 关联 id 升序（与 _plan_links 同尺，页面按这个序一排到底）
    order = [i["link_id"] for i in body["items"]]
    assert order == sorted(i["link_id"] for i in body["items"])
    # 页面按关联顺序一排到底：api/functional 两条也在结果里，不是只回成功的那几条
    assert {i["link_id"] for i in body["items"]} >= {lk["id"] for lk in links}


async def test_one_subject_failure_does_not_abort_the_batch(
    client, session, make_user, monkeypatch,
) -> None:
    user, h = await make_user("d225b", admin=True)
    pid = await _proj(client, h, "D225单条失败")
    await _seed_subjects(session, pid, user.id)
    plan_id = await _plan(client, h, pid)
    await _link(client, h, pid, plan_id, "scenario", "sc-d225")
    await _link(client, h, pid, plan_id, "ui_case", "ui-d225")
    await _link(client, h, pid, plan_id, "adb_case", "ad-d225")

    _stub_runs(monkeypatch, adb_error=True)
    r = await client.post(_BASE + f"/plans/{plan_id}/execute",
                          json={"project_id": pid, "plan_id": plan_id}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["submitted"] == 2 and body["skipped"] == 1
    adb = next(i for i in body["items"] if i["subject_type"] == "adb_case")
    assert "执行器不可用" in adb["reason"]
    # 失败那一条不拦前面两条
    assert {i["subject_type"] for i in body["items"] if i["run_id"]} == {"scenario", "ui_case"}


async def test_archived_plan_is_rejected(client, session, make_user, monkeypatch) -> None:
    user, h = await make_user("d225c", admin=True)
    pid = await _proj(client, h, "D225归档")
    await _seed_subjects(session, pid, user.id)
    plan_id = await _plan(client, h, pid)
    await _link(client, h, pid, plan_id, "scenario", "sc-d225")
    arch = await client.post(_BASE + f"/plans/{plan_id}/archive",
                             json={"project_id": pid, "plan_id": plan_id}, headers=h)
    assert arch.status_code == 200, arch.text

    calls = _stub_runs(monkeypatch)
    r = await client.post(_BASE + f"/plans/{plan_id}/execute",
                          json={"project_id": pid, "plan_id": plan_id}, headers=h)
    assert r.status_code == 409, r.text
    assert "归档" in r.json()["message"]
    assert calls == [], "归档计划一条都不许投"


async def test_cross_project_404_and_readonly_403(client, session, make_user,
                                                  monkeypatch) -> None:
    from app.modules.iam.models import ProjectMember

    ua, ha = await make_user("d225d")
    _, hroot = await make_user("d225d_root", admin=True)
    pa = await _proj(client, hroot, "D225甲")
    pb = await _proj(client, hroot, "D225乙")
    session.add(ProjectMember(project_id=pa, user_id=ua.id, role_code="READONLY"))
    await session.commit()
    await _seed_subjects(session, pa, ua.id)
    plan_id = await _plan(client, hroot, pa)
    await _link(client, hroot, pa, plan_id, "scenario", "sc-d225")

    _stub_runs(monkeypatch)
    # 跨项目与不存在同码同文案（不泄露存在性）
    r = await client.post(_BASE + f"/plans/{plan_id}/execute",
                          json={"project_id": pb, "plan_id": plan_id}, headers=hroot)
    assert r.status_code == 404 and r.json()["message"] == "计划不存在"
    # READONLY 没有 testplan:plan:execute
    r = await client.post(_BASE + f"/plans/{plan_id}/execute",
                          json={"project_id": pa, "plan_id": plan_id}, headers=ha)
    assert r.status_code == 403, r.text
