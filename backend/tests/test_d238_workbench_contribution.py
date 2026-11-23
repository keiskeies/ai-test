"""D238 判据刀：工作台「我的关注与创建」贡献块。

契约（对应 workbench/services.py `WorkbenchContribution` 的 docstring）：

1. **我创建的**只算有创建者列的两种：功能用例（normal，不含回收站）与近 7 天缺陷
   （`created_at >= 窗口起点`，不含回收站）。接口/场景/UI/ADB 没有创建者列，不硬算。
2. **我关注的**三桶来自三张关注表，按 (project_id, user_id) 现查；`followed_total`
   等于三桶之和，不是另一次查询。
3. **跨项目隔离**：别项目的用例/缺陷/关注行不串入。
4. 每个用户的读数只反映自己（成员视角不是管理员视角）。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.defect.models import Defect, DefectFollower
from app.modules.functional.models import (
    STATUS_NORMAL,
    STATUS_RECYCLED,
    FunctionalCase,
    FunctionalCaseFollower,
)
from app.modules.testplan.models import PlanFollower

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str = "MEMBER") -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


def _case(session, pid: str, uid: str, num: int, *, status: str = STATUS_NORMAL) -> FunctionalCase:
    c = FunctionalCase(id=f"fc{num}-{uid[:6]}", project_id=pid, num=num,
                       template_id="tpl-d238", name="用例" + str(num),
                       priority="P2", status=status, created_by=uid)
    session.add(c)
    return c


def _defect(session, pid: str, uid: str, num: int, *, days_ago: int = 0,
            recycled: bool = False) -> Defect:
    d = Defect(id=f"df{num}-{uid[:6]}", project_id=pid, num=num,
               template_id="tpl-d238", title="缺陷" + str(num), priority="P2",
               status="new", recycled=recycled, created_by=uid,
               created_at=datetime.now(UTC) - timedelta(days=days_ago))
    session.add(d)
    return d


async def _stats(client, h, pid: str) -> dict:
    r = await client.get(_BASE + f"/workbench-stats?project_id={pid}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()["contribution"]


async def test_my_created_and_followed(client, session, make_user) -> None:
    boss, hb = await make_user("d238a", admin=True)
    member, hm = await make_user("d238a_m")
    pid = await _proj(client, hb, "D238贡献")
    pid_b = await _proj(client, hb, "D238别项目")
    await _member(client, hb, pid, member.id)

    # 我创建的功能用例：2 正常 + 1 回收站；成员 1 正常；别项目 1 正常（不得串入）
    _case(session, pid, boss.id, 1)
    _case(session, pid, boss.id, 2)
    _case(session, pid, boss.id, 3, status=STATUS_RECYCLED)
    _case(session, pid, member.id, 4)
    _case(session, pid_b, boss.id, 5)
    # 我创建的缺陷：近 7 天 1 + 30 天前 1（窗外）+ 回收站 1；成员近 7 天 1
    _defect(session, pid, boss.id, 1)
    _defect(session, pid, boss.id, 2, days_ago=30)
    _defect(session, pid, boss.id, 3, recycled=True)
    _defect(session, pid, member.id, 4)
    _defect(session, pid_b, boss.id, 5)
    # 关注：计划 2 + 功能用例 1 + 缺陷 1（管理员）；成员 1 条计划关注
    session.add(PlanFollower(plan_id="pl1", user_id=boss.id, project_id=pid))
    session.add(PlanFollower(plan_id="pl2", user_id=boss.id, project_id=pid))
    session.add(PlanFollower(plan_id="pl3", user_id=member.id, project_id=pid, ))
    session.add(FunctionalCaseFollower(case_id=f"fc1-{boss.id[:6]}", user_id=boss.id, project_id=pid))
    session.add(DefectFollower(defect_id=f"df1-{boss.id[:6]}", user_id=boss.id, project_id=pid))
    # 别项目的关注行不串入
    session.add(PlanFollower(plan_id="plb", user_id=boss.id, project_id=pid_b))
    await session.commit()

    mine = await _stats(client, hb, pid)
    assert mine == {
        "functional_case_created": 2,
        "defect_created_7d": 1,
        "followed_plan": 2,
        "followed_functional_case": 1,
        "followed_defect": 1,
        "followed_total": 4,
    }

    theirs = await _stats(client, hm, pid)
    assert theirs["functional_case_created"] == 1
    assert theirs["defect_created_7d"] == 1
    assert theirs["followed_plan"] == 1
    assert theirs["followed_functional_case"] == 0
    assert theirs["followed_defect"] == 0
    assert theirs["followed_total"] == 1


async def test_empty_project_contribution_is_zero(client, make_user) -> None:
    _, h = await make_user("d238b", admin=True)
    pid = await _proj(client, h, "D238空项目")
    body = await _stats(client, h, pid)
    assert set(body.values()) == {0}
