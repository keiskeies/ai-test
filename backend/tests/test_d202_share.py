"""D202：分享链接（公开读取、密码、过期、吊销、计划报告）。"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.execution.models import RunRecord
from app.modules.share.models import ShareLink
from app.modules.testplan.models import PlanReport, PlanReportItem

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _run(session, pid: str, uid: str, rid: str = "r-share") -> RunRecord:
    r = RunRecord(id=rid, project_id=pid, subject_type="scenario", subject_id="s1",
                  subject_name="分享场景", trigger="manual", status="passed",
                  elapsed_ms=1234, stats={"total": 2, "pass": 2}, created_by=uid,
                  summary_graph={"version": 1, "nodes": []})
    session.add(r)
    return r


async def test_report_share_public_and_views(client, session, make_user) -> None:
    boss, h = await make_user("d202a", admin=True)
    pid = await _proj(client, h, "D202报告")
    _run(session, pid, boss.id)
    await session.commit()
    c = await client.post(_BASE + "/share-links", json={
        "project_id": pid, "target_type": "report", "target_id": "r-share",
    }, headers=h)
    assert c.status_code == 201, c.text
    token = c.json()["token"]
    assert c.json()["share_path"] == "/share/" + token and c.json()["view_count"] == 0

    pub = await client.get(_BASE + "/share/" + token)  # 不带 Authorization
    assert pub.status_code == 200, pub.text
    body = pub.json()
    assert body["type"] == "report" and body["title"] == "分享场景"
    assert body["report"]["status"] == "passed" and body["report"]["stats"]["pass"] == 2

    lst = await client.get(_BASE + "/share-links", params={"project_id": pid}, headers=h)
    assert lst.json()["items"][0]["view_count"] == 1
    assert lst.json()["items"][0]["last_viewed_at"]


async def test_share_password_expiry_revoke(client, session, make_user) -> None:
    boss, h = await make_user("d202p", admin=True)
    pid = await _proj(client, h, "D202密码")
    _run(session, pid, boss.id, "r-pw")
    await session.commit()
    c = await client.post(_BASE + "/share-links", json={
        "project_id": pid, "target_type": "report", "target_id": "r-pw", "password": "s3cret",
    }, headers=h)
    sid, token = c.json()["id"], c.json()["token"]
    assert c.json()["has_password"] is True
    no_pw = await client.get(_BASE + "/share/" + token)
    assert no_pw.status_code == 401 and no_pw.json()["details"]["password_required"] is True
    wrong = await client.get(_BASE + "/share/" + token, params={"password": "bad"})
    assert wrong.status_code == 401
    ok = await client.get(_BASE + "/share/" + token, params={"password": "s3cret"})
    assert ok.status_code == 200
    # 过期：直接改库到过去
    row = await session.get(ShareLink, sid)
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await session.commit()
    assert (await client.get(_BASE + "/share/" + token,
                             params={"password": "s3cret"})).status_code == 410
    # 吊销另一条有效链接
    c2 = await client.post(_BASE + "/share-links", json={
        "project_id": pid, "target_type": "report", "target_id": "r-pw",
    }, headers=h)
    rv = await client.post(_BASE + f"/share-links/{c2.json()['id']}/revoke",
                           json={"project_id": pid, "share_id": c2.json()["id"]}, headers=h)
    assert rv.status_code == 200
    assert (await client.get(_BASE + "/share/" + c2.json()["token"])).status_code == 404


async def test_plan_report_share_items(client, session, make_user) -> None:
    boss, h = await make_user("d202pr", admin=True)
    pid = await _proj(client, h, "D202计划报告")
    rep = PlanReport(id="pr1", project_id=pid, plan_id="pl1", name="回归报告",
                     status="completed", total=1, passed=1, failed=0, executed=1, executing=0,
                     created_by=boss.id)
    item = PlanReportItem(id="pri1", project_id=pid, report_id="pr1", link_id="lk1",
                          subject_type="scenario", subject_id="s1", subject_name="结算场景",
                          executed=True, executing=False, result="passed")
    session.add_all([rep, item])
    await session.commit()
    c = await client.post(_BASE + "/share-links", json={
        "project_id": pid, "target_type": "plan_report", "target_id": "pr1",
    }, headers=h)
    assert c.status_code == 201, c.text
    pub = await client.get(_BASE + "/share/" + c.json()["token"])
    assert pub.status_code == 200
    body = pub.json()
    assert body["report"]["name"] == "回归报告"
    assert body["report"]["items"][0]["subject_name"] == "结算场景"
    assert body["report"]["items"][0]["result"] == "passed"


async def test_share_permissions_and_cross_project(client, session, make_user) -> None:
    boss, hb = await make_user("d202x", admin=True)
    ro, hr = await make_user("d202x2")
    pid = await _proj(client, hb, "D202权限")
    pid2 = await _proj(client, hb, "D202权限B")
    r = await client.put(_BASE + f"/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"},
                         headers=hb)
    assert r.status_code == 200
    _run(session, pid, boss.id, "r-perm")
    await session.commit()
    assert (await client.get(_BASE + "/share-links", params={"project_id": pid},
                             headers=hr)).status_code == 200
    deny = await client.post(_BASE + "/share-links", json={
        "project_id": pid, "target_type": "report", "target_id": "r-perm",
    }, headers=hr)
    assert deny.status_code == 403 and deny.json()["details"]["perm"] == "share:link:create"
    cross = await client.post(_BASE + "/share-links", json={
        "project_id": pid2, "target_type": "report", "target_id": "r-perm",
    }, headers=hb)
    assert cross.status_code == 404
