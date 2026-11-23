"""D227：工作台「我的待办」——待我执行 / 待我评审。

钉的五件事：

① **待我执行的口径**：计划未归档 + 关联 `executor_id` = 我 + `subject_type=functional_case`
   + 功能用例未被回收 + **尚无可读结论**（`plan_functional_exec` 无该 link 行）。
   写一条人工结论后同一条待办消失——待办必须跟着真相走，而不是靠前端过滤。
② **只认人工执行**：场景/UI/ADB/接口关联被指派给我也**不进**待办——它们由计划「执行」
   自动跑，没有「点结论」的动作；把自动化的事派给人是一种撒谎（用例钉住）。
③ **待我评审与评审页 my_todo 同一把尺**：谓词在 review/queries.my_todo_review_ids，
   工作台与列表共用；我提了结论、用例聚合结论不再 pending 后待办消失。
④ **total 与 items 分账**：total 是全部，items 至多 10 条；跨项目只数本项目。
⑤ **角色**：READONLY 能读（workbench:read 被 *:read 罩住）且待办为空（它没有指派）；
   非成员 403。

手法：用户/计划/关联/评审直种（HTTP 面另有大批用例覆盖建改删），
「写结论」走真实接口——待办消失要由真实写路径证明，不能靠直改库。
"""
from __future__ import annotations

import pytest

from app.modules.functional.models import FunctionalCase
from app.modules.iam.models import ProjectMember
from app.modules.review.models import CaseReview, CaseReviewCase, CaseReviewReviewer
from app.modules.testplan.models import PlanCaseLink, PlanRecord

BASE = "/api/v1/workbench-stats"


@pytest.fixture()
async def admin_h(client, make_user):
    _u, h = await make_user("d227_admin", admin=True)
    return h


async def _project(client, h, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(session, make_user, account: str, pid: str, role: str = "MEMBER"):
    u, h = await make_user(account)
    session.add(ProjectMember(project_id=pid, user_id=u.id, role_code=role))
    await session.commit()
    return u, h


async def _seed_case(session, pid: str, num: int = 1, name: str = "登录功能") -> FunctionalCase:
    fc = FunctionalCase(project_id=pid, name=name, num=num, priority="P1",
                        template_id="tpl-seed", status="normal", created_by=None)
    session.add(fc)
    await session.flush()  # id 由 INSERT 默认值生成；flush 后才有值可外键引用
    return fc


async def _seed_plan(session, pid: str, name: str = "回归计划", archived: bool = False) -> PlanRecord:
    p = PlanRecord(project_id=pid, name=name, archived=archived)
    session.add(p)
    await session.flush()
    return p


def _seed_link(session, pid: str, plan_id: str, subject_type: str, subject_id: str,
               executor_id: str | None, sort_order: int = 1,
               subject_name: str = "用例快照名") -> PlanCaseLink:
    lk = PlanCaseLink(project_id=pid, plan_id=plan_id, subject_type=subject_type,
                      subject_id=subject_id, subject_name=subject_name,
                      executor_id=executor_id, sort_order=sort_order)
    session.add(lk)
    return lk


async def _stats(client, h, pid: str) -> dict:
    r = await client.get(BASE, params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["todos"]


# ── ① 待我执行 + 结论清除 ─────────────────────────────────────────────────────


async def test_my_execution_bucket_and_cleared_by_conclusion(client, admin_h, session, make_user):
    pid = await _project(client, admin_h, "D227 待执行")
    me, h = await _member(session, make_user, "d227_me", pid)
    fc = await _seed_case(session, pid, name="支付流程")
    plan = await _seed_plan(session, pid, name="夜间回归")
    link = _seed_link(session, pid, plan.id, "functional_case", fc.id, me.id)
    await session.commit()

    todos = await _stats(client, h, pid)
    assert todos["my_execution_total"] == 1, todos
    item = todos["my_executions"][0]
    assert item["plan_id"] == plan.id and item["plan_name"] == "夜间回归"
    assert item["case_id"] == fc.id and item["case_name"] == "支付流程"
    assert item["num"] == 1 and item["priority"] == "P1"

    # 写一条真实结论 → 同一条待办消失（跟着真相走）
    r = await client.post(f"/api/v1/plans/{plan.id}/functional-cases/execute",
                          json={"project_id": pid, "plan_id": plan.id,
                                "link_ids": [link.id], "result": "pass"}, headers=h)
    assert r.status_code == 200, r.text
    todos2 = await _stats(client, h, pid)
    assert todos2["my_execution_total"] == 0, todos2
    assert todos2["my_executions"] == []


async def test_my_execution_excludes_archived_other_assignee_and_automated_types(
        client, admin_h, session, make_user):
    pid = await _project(client, admin_h, "D227 排除项")
    me, h = await _member(session, make_user, "d227_me2", pid)
    other, _ = await _member(session, make_user, "d227_other", pid)
    fc = await _seed_case(session, pid)
    archived_plan = await _seed_plan(session, pid, name="已归档", archived=True)
    live_plan = await _seed_plan(session, pid, name="进行中")
    # 我：归档计划里的关联（不算）
    _seed_link(session, pid, archived_plan.id, "functional_case", fc.id, me.id)
    # 我：场景关联（自动化跑，不算待执行）
    _seed_link(session, pid, live_plan.id, "scenario", "sc-1", me.id, sort_order=2,
               subject_name="场景一")
    # 别人：活跃计划里的功能用例（不算我的）
    _seed_link(session, pid, live_plan.id, "functional_case", fc.id, other.id, sort_order=3)
    await session.commit()

    todos = await _stats(client, h, pid)
    assert todos["my_execution_total"] == 0, todos


async def test_my_execution_excludes_recycled_case(client, admin_h, session, make_user):
    pid = await _project(client, admin_h, "D227 回收")
    me, h = await _member(session, make_user, "d227_me3", pid)
    fc = await _seed_case(session, pid)
    fc.status = "recycled"
    plan = await _seed_plan(session, pid)
    _seed_link(session, pid, plan.id, "functional_case", fc.id, me.id)
    await session.commit()
    assert (await _stats(client, h, pid))["my_execution_total"] == 0


# ── ③ 待我评审 + 提交结论清除 ──────────────────────────────────────────────────


async def test_my_review_bucket_and_submit_clears(client, admin_h, session, make_user):
    pid = await _project(client, admin_h, "D227 待评审")
    me, h = await _member(session, make_user, "d227_me4", pid)
    fc = await _seed_case(session, pid, name="退款规则")
    review = CaseReview(project_id=pid, num=1, name="退款评审", pass_rule="single",
                        started=False, created_by=None)
    session.add(review)
    await session.flush()
    session.add(CaseReviewCase(project_id=pid, review_id=review.id, case_id=fc.id,
                               sort=0, result="pending", re_review=False))
    session.add(CaseReviewReviewer(project_id=pid, review_id=review.id, case_id=fc.id,
                                   user_id=me.id))
    await session.commit()

    todos = await _stats(client, h, pid)
    assert todos["my_review_total"] == 1, todos
    assert todos["my_reviews"][0]["review_id"] == review.id
    assert todos["my_reviews"][0]["review_name"] == "退款评审"
    assert todos["my_reviews"][0]["num"] == 1

    # 我已不是评审人 → 不在我的待办
    other, oh = await _member(session, make_user, "d227_other2", pid)
    assert (await _stats(client, oh, pid))["my_review_total"] == 0

    # 提交我的结论 → 用例聚合结论离开 pending → 待办消失
    r = await client.post(f"/api/v1/case-reviews/{review.id}/cases/{fc.id}/results",
                          json={"project_id": pid, "review_id": review.id,
                                "case_id": fc.id, "action": "pass"}, headers=h)
    assert r.status_code == 201, r.text
    todos2 = await _stats(client, h, pid)
    assert todos2["my_review_total"] == 0, todos2


# ── ④⑤ 跨项目 / 角色 ─────────────────────────────────────────────────────────


async def test_todos_are_project_scoped_and_role_safe(client, admin_h, session, make_user):
    p1 = await _project(client, admin_h, "D227 项目一")
    p2 = await _project(client, admin_h, "D227 项目二")
    me, h = await _member(session, make_user, "d227_scope", p1)
    session.add(ProjectMember(project_id=p2, user_id=me.id, role_code="MEMBER"))
    fc = await _seed_case(session, p1)
    plan1 = await _seed_plan(session, p1, name="项目一计划")
    _seed_link(session, p1, plan1.id, "functional_case", fc.id, me.id)
    fc2 = FunctionalCase(project_id=p2, name="项目二用例", num=1, priority="P2",
                         template_id="tpl-seed", status="normal", created_by=None)
    session.add(fc2)
    plan2 = await _seed_plan(session, p2, name="项目二计划")
    _seed_link(session, p2, plan2.id, "functional_case", fc2.id, me.id)
    await session.commit()

    assert (await _stats(client, h, p1))["my_execution_total"] == 1
    assert (await _stats(client, h, p2))["my_execution_total"] == 1

    # READONLY：读得到（*:read 罩住），但没有指派 → 空
    ro, roh = await _member(session, make_user, "d227_ro", p1, role="READONLY")
    todos = await _stats(client, roh, p1)
    assert todos["my_execution_total"] == 0 and todos["my_review_total"] == 0

    # 非成员：403（与「项目不存在」同码同文）
    outsider, ouh = await make_user("d227_outsider")
    await session.commit()
    r = await client.get(BASE, params={"project_id": p1}, headers=ouh)
    assert r.status_code == 403, r.text
