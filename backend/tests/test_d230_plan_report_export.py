"""D230：计划报告导出（自包含 HTML，JSON 载体）——五件事逐一钉住。

① **导出 = 快照换壳**：内容抄 `_report_out`（率/计数/明细都是报告行与明细副本），
   生成报告后再往计划里挂一条新关联，导出仍是原来那一条（活数据不回流）。
② **一切用户输入都 escape**：用例名与报告名里放 `<script>`/`<b>`，导出文件里必须是
   `&lt;script&gt;`，原样标签一个都不许出现（导出文件会在浏览器里打开）。
③ **文件名可落地**：报告名里的 `\\ / : * ? " < > |` 换 `_`，日期取 created_at 前 10 位。
④ **权限与可达性**：READONLY（有 `testplan:report:read`）能导出；跨项目与不存在同码
   404 同文案（与详情端点共用 `_report` 的唯一出口）。
⑤ **载体形状**：`{filename, media_type, content, item_count}`，media_type 由后端给死，
   item_count = 本次导出的明细行数（≠ 计划当前关联数）。

手法同 test_d183_plan_reports（HTTP 面 + admin headers；报告靠 POST /plans/{id}/reports 生成）。
"""
from __future__ import annotations

import pytest

BASE = "/api/v1"


@pytest.fixture()
async def admin_h(client, make_user):
    _u, h = await make_user("d230_admin", admin=True)
    return h


async def _proj(client, h, name: str) -> str:
    r = await client.post(BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _plan(client, h, pid: str, name: str, link_names: list[str]) -> str:
    """建计划 + 逐条场景关联（用例名可控，用于 XSS 断言）；返回 plan_id。"""
    p = await client.post(BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert p.status_code in (200, 201), p.text
    plan_id = p.json()["id"]
    for n in link_names:
        s = await client.post(BASE + "/scenarios", json={"project_id": pid, "name": n}, headers=h)
        assert s.status_code in (200, 201), s.text
        lk = await client.post(BASE + f"/plans/{plan_id}/case-links",
                              json={"project_id": pid, "subject_type": "scenario",
                                    "subject_id": s.json()["id"]}, headers=h)
        assert lk.status_code in (200, 201), lk.text
    return plan_id


async def _report(client, h, pid: str, plan_id: str, name: str | None = None) -> dict:
    body: dict = {"project_id": pid, "plan_id": plan_id}
    if name is not None:
        body["name"] = name
    r = await client.post(BASE + f"/plans/{plan_id}/reports", json=body, headers=h)
    assert r.status_code in (200, 201), r.text
    return r.json()


def _export_url(pid: str, report_id: str) -> str:
    return BASE + "/plan-reports/" + report_id + "/export?project_id=" + pid


async def test_export_html_escapes_every_user_value(client, admin_h) -> None:
    pid = await _proj(client, admin_h, "D230 转义")
    plan_id = await _plan(client, admin_h, pid, "D230 计划 <b>加粗</b>",
                          ["<script>alert(1)</script>"])
    rep = await _report(client, admin_h, pid, plan_id, name="导出 <b>报告</b>")

    r = await client.get(_export_url(pid, rep["id"]), headers=admin_h)

    assert r.status_code == 200, r.text
    out = r.json()
    assert out["media_type"] == "text/html; charset=utf-8", out
    assert out["item_count"] == 1, out
    html = out["content"]
    assert html.startswith("<!DOCTYPE html>"), html[:40]
    # 用户输入只以转义形式出现
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html, html
    assert "<script>alert(1)</script>" not in html, html
    assert "&lt;b&gt;报告&lt;/b&gt;" in html, html
    assert "<b>报告" not in html, html
    # 计数/词表/页脚都在（不是空壳文件）
    assert "未执行" in html and "通过率" in html and "快照副本" in html, html
    assert out["filename"].endswith(".html"), out


async def test_export_is_snapshot_not_live_data(client, admin_h) -> None:
    pid = await _proj(client, admin_h, "D230 快照")
    plan_id = await _plan(client, admin_h, pid, "D230 快照计划", ["D230 原用例"])
    rep = await _report(client, admin_h, pid, plan_id)

    # 报告生成后再往计划挂一条新关联：导出不许把它算进来。
    s = await client.post(BASE + "/scenarios",
                          json={"project_id": pid, "name": "D230 后来者"}, headers=admin_h)
    assert s.status_code in (200, 201), s.text
    lk = await client.post(BASE + f"/plans/{plan_id}/case-links",
                           json={"project_id": pid, "subject_type": "scenario",
                                 "subject_id": s.json()["id"]}, headers=admin_h)
    assert lk.status_code in (200, 201), lk.text

    out = (await client.get(_export_url(pid, rep["id"]), headers=admin_h)).json()

    assert out["item_count"] == 1, out
    assert "D230 原用例" in out["content"], out["content"]
    assert "D230 后来者" not in out["content"], "导出读了活数据——这不是快照"
    # 头行计数同样不随活数据长：总数仍是 1
    assert "<b>1</b><span>总数</span>" in out["content"], out["content"]


async def test_export_filename_sanitized_and_follows_rename(client, admin_h) -> None:
    pid = await _proj(client, admin_h, "D230 文件名")
    plan_id = await _plan(client, admin_h, pid, "D230 文件名计划", [])
    rep = await _report(client, admin_h, pid, plan_id, name='结算/回归:报告*?"<>|')

    out = (await client.get(_export_url(pid, rep["id"]), headers=admin_h)).json()

    fn = out["filename"]
    assert fn.endswith(".html"), fn
    assert not any(ch in fn for ch in '\\/:*?"<>|'), fn
    assert "结算_回归_报告" in fn, fn

    # 改名后导出文件名跟着新名字（导出读的是当前 name，内容/计数仍是冻结快照）
    rn = await client.patch(BASE + "/plan-reports/" + rep["id"],
                            json={"project_id": pid, "name": "改名后"}, headers=admin_h)
    assert rn.status_code == 200, rn.text
    out2 = (await client.get(_export_url(pid, rep["id"]), headers=admin_h)).json()
    assert out2["filename"].startswith("改名后-"), out2["filename"]


async def test_export_readonly_allowed_and_cross_project_404(client, session, make_user) -> None:
    from app.modules.iam.models import ProjectMember

    _, h = await make_user("d230_root", admin=True)
    ro, hro = await make_user("d230_ro")
    pid = await _proj(client, h, "D230 权限")
    other = await _proj(client, h, "D230 别的项目")
    session.add(ProjectMember(project_id=pid, user_id=ro.id, role_code="READONLY"))
    await session.commit()
    plan_id = await _plan(client, h, pid, "D230 权限计划", ["D230 只读用例"])
    rep = await _report(client, h, pid, plan_id)

    ok = await client.get(_export_url(pid, rep["id"]), headers=hro)
    assert ok.status_code == 200, ok.text
    assert ok.json()["item_count"] == 1

    gone = await client.get(_export_url(pid, "no-such-report"), headers=h)
    cross = await client.get(_export_url(other, rep["id"]), headers=h)
    assert gone.status_code == cross.status_code == 404, (gone.text, cross.text)
    assert gone.json()["message"] == cross.json()["message"], (gone.text, cross.text)


async def test_export_rejects_stranger(client, make_user) -> None:
    """非本项目成员：越权正门（ensure_project_access）先挡，404 与不存在同码。"""
    _, h = await make_user("d230_owner", admin=True)
    _, stranger = await make_user("d230_stranger")
    pid = await _proj(client, h, "D230 陌生人")
    plan_id = await _plan(client, h, pid, "D230 陌生人计划", [])
    rep = await _report(client, h, pid, plan_id)

    r = await client.get(_export_url(pid, rep["id"]), headers=stranger)
    # 越权正门给的是 403「无此项目权限」（ensure_project_access 的口径，与 404 不混淆：
    # 陌生人不进项目就不该知道这个报告存不存在）。
    assert r.status_code == 403 and "无此项目权限" in r.json()["message"], r.text


def test_html_renderer_never_leaks_raw_angle_brackets() -> None:
    """纯函数腿：词表外的 status/result 画原码，但仍要 escape（<img> 不是标签）。"""
    from app.modules.testplan import schemas
    from app.modules.testplan.services import _report_html

    out = schemas.PlanReportOut(
        id="r1", project_id="p1", plan_id="p2", name="报告<img src=x>",
        status="<script>s</script>", total=1, passed=0, failed=0, executed=1,
        executing=0, not_executed=0, pass_rate=0.0, execute_rate=1.0,
        created_by=None, created_at="2026-11-23T00:00:00+00:00", updated_at=None,
        items=[schemas.PlanReportItemOut(
            id="i1", report_id="r1", link_id="l1", subject_type="scenario",
            subject_id="s1", subject_name="用例<u>下划线</u>", env_id=None,
            executed=True, executing=False, result="<i>结论</i>",
            created_at=None, updated_at=None)])

    html = _report_html(out)

    assert "<img" not in html and "&lt;img" in html, html
    assert "<script>s</script>" not in html and "&lt;script&gt;s&lt;/script&gt;" in html
    assert "<u>" not in html and "&lt;u&gt;下划线&lt;/u&gt;" in html
    assert "<i>结论</i>" not in html and "&lt;i&gt;结论&lt;/i&gt;" in html
    # 空计划如实写「没有明细行」（不拿空白冒充 0 行）
    empty = out.model_copy(update={"items": []})
    assert "（该报告没有明细行）" in _report_html(empty)
