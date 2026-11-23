"""D206 判据刀：计划关联行的执行人指派 / 拖拽排序 / 批量取消关联。

钉的契约（一条判断一条用例）：

1. **指派**：批量指派到本项目成员；`executor_id=None` 是「取消指派」而不是「不改」；
   非成员 → 422 invalid_executor；任一 link 不在本计划 → 404 且**整批不落库**。
2. **排序**：`link_ids` 的先后就是新顺序（sort_order 从 1 连续），列表按它返回；
   重复 id 422；**子集** 422（未列出的行会和第 1 名抢同一个 sort_order = 不确定序）。
3. **批量取消关联**：只删关联行 + 该行的人工结论/流水，用例本体不动；
   全有或全无（混入外来的 link_id → 404，一行都不删）。
4. **功能用例列表同一份指派**：plan_functional_case_list 的 executor_id/sort_order
   与关联行一致（人工执行界面看的是同一份指派）。
5. **权限位真守护**：READONLY 调 assign/sort 403（details.perm 指名），
   MEMBER 调批量取消 403（-*:delete），拒绝不落库。
6. **表形状**：迁移 0041 的两列 + 组合索引在场（d183 形状用例已扩到十二列）。
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import text

from app.modules.api_test.models import ApiCase
from app.modules.testplan.models import PlanCaseLink, PlanFunctionalExec, PlanFunctionalExecHistory

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _seed_case(session, pid: str, row_id: str, name: str) -> None:
    session.add(ApiCase(id=row_id, project_id=pid, definition_id="seed-def", name=name))
    await session.commit()


async def _link(client, h, pid: str, plan_id: str, subject_type: str, subject_id: str):
    return await client.post(
        _BASE + f"/plans/{plan_id}/case-links",
        json={"project_id": pid, "subject_type": subject_type, "subject_id": subject_id},
        headers=h,
    )


async def _links(client, h, pid: str, plan_id: str) -> list[dict]:
    r = await client.get(_BASE + f"/plans/{plan_id}/case-links", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _assign(client, h, pid: str, plan_id: str, ids: list[str], executor: str | None):
    return await client.post(
        _BASE + f"/plans/{plan_id}/case-links/assign",
        json={"project_id": pid, "link_ids": ids, "executor_id": executor},
        headers=h,
    )


async def _sort(client, h, pid: str, plan_id: str, ids: list[str]):
    return await client.post(
        _BASE + f"/plans/{plan_id}/case-links/sort",
        json={"project_id": pid, "link_ids": ids},
        headers=h,
    )


async def _count(conn, table: str, where: str, **params) -> int:
    r = await conn.execute(text(f"SELECT COUNT(*) FROM {table} WHERE " + where), params)
    return int(r.scalar_one())


async def _seed_three_links(client, h, session, pid: str, plan_id: str) -> list[dict]:
    for i, name in enumerate(("用例A", "用例B", "用例C")):
        await _seed_case(session, pid, f"c{i}", name)
        r = await _link(client, h, pid, plan_id, "api_case", f"c{i}")
        assert r.status_code == 201, r.text
    return await _links(client, h, pid, plan_id)


# ══════════ 1. 指派 ══════════
async def test_assign_clear_and_all_or_nothing(client, session, make_user) -> None:
    _, h = await make_user("d206a", admin=True)
    mate, _ = await make_user("d206a2")
    outsider, _ = await make_user("d206a3")
    mate_id, outsider_id = mate.id, outsider.id
    pid = await _proj(client, h, "D206指派")
    await _member(client, h, pid, mate_id, "MEMBER")
    plan = await _plan(client, h, pid, "指派计划")
    links = await _seed_three_links(client, h, session, pid, plan["id"])
    a, b, c = (x["id"] for x in links)

    r = await _assign(client, h, pid, plan["id"], [a, b], mate_id)
    assert r.status_code == 200 and r.json()["updated"] == 2
    got = {x["id"]: x["executor_id"] for x in await _links(client, h, pid, plan["id"])}
    assert got[a] == mate_id and got[b] == mate_id and got[c] is None

    # None = 取消指派（不是「不改」）
    r = await _assign(client, h, pid, plan["id"], [a], None)
    assert r.status_code == 200
    got = {x["id"]: x["executor_id"] for x in await _links(client, h, pid, plan["id"])}
    assert got[a] is None and got[b] == mate_id

    # 非本项目成员 → 422，且不落库
    r = await _assign(client, h, pid, plan["id"], [a], outsider_id)
    assert r.status_code == 422 and r.json()["code"] == "invalid_executor"

    # 混入别的计划的 link → 404 整批不动（b 仍指着 mate）
    other = await _plan(client, h, pid, "另一个计划")
    foreign = (await _link(client, h, pid, other["id"], "api_case", "c0")).json()["id"]
    r = await _assign(client, h, pid, plan["id"], [a, foreign], mate_id)
    assert r.status_code == 404 and foreign in r.json()["details"]["link_ids"]
    got = {x["id"]: x["executor_id"] for x in await _links(client, h, pid, plan["id"])}
    assert got[a] is None and got[b] == mate_id


# ══════════ 2. 排序 ══════════
async def test_sort_full_order_and_reject_subset_or_dup(client, session, make_user) -> None:
    _, h = await make_user("d206s", admin=True)
    pid = await _proj(client, h, "D206排序")
    plan = await _plan(client, h, pid, "排序计划")
    links = await _seed_three_links(client, h, session, pid, plan["id"])
    a, b, c = (x["id"] for x in links)

    r = await _sort(client, h, pid, plan["id"], [c, a, b])
    assert r.status_code == 200 and r.json()["updated"] == 3
    got = [(x["id"], x["sort_order"]) for x in await _links(client, h, pid, plan["id"])]
    assert got == [(c, 1), (a, 2), (b, 3)], got

    dup = await _sort(client, h, pid, plan["id"], [a, a, b])
    assert dup.status_code == 422 and dup.json()["code"] == "validation_failed"

    sub = await _sort(client, h, pid, plan["id"], [b, a])
    assert sub.status_code == 422 and sub.json()["code"] == "incomplete_sort"
    # 被拒后顺序原样
    got = [(x["id"], x["sort_order"]) for x in await _links(client, h, pid, plan["id"])]
    assert got == [(c, 1), (a, 2), (b, 3)]


# ══════════ 3. 批量取消关联 + 级联结论 ══════════
async def test_batch_delete_cascades_exec_and_all_or_nothing(client, session, conn, make_user) -> None:
    _, h = await make_user("d206d", admin=True)
    pid = await _proj(client, h, "D206批量摘挂")
    plan = await _plan(client, h, pid, "摘挂计划")
    links = await _seed_three_links(client, h, session, pid, plan["id"])
    a, b = links[0]["id"], links[1]["id"]

    session.add(PlanFunctionalExec(
        id="fe1", project_id=pid, plan_id=plan["id"], link_id=a, case_id="c0",
        result="pass", executed_at=datetime(2026, 1, 1, tzinfo=UTC)))
    session.add(PlanFunctionalExecHistory(
        id="fh1", project_id=pid, plan_id=plan["id"], link_id=a, case_id="c0", seq=1,
        result="pass", executed_by="u1"))
    session.add(PlanFunctionalExec(
        id="fe2", project_id=pid, plan_id=plan["id"], link_id=b, case_id="c1",
        result="fail", executed_at=datetime(2026, 1, 1, tzinfo=UTC)))
    await session.commit()

    # 混入外来 id → 404 全不动
    other = await _plan(client, h, pid, "别的计划")
    foreign = (await _link(client, h, pid, other["id"], "api_case", "c2")).json()["id"]
    r = await client.post(_BASE + f"/plans/{plan['id']}/case-links/batch-delete",
                          json={"project_id": pid, "link_ids": [a, foreign]}, headers=h)
    assert r.status_code == 404
    assert await _count(conn, "plan_case_link", "plan_id = :p", p=plan["id"]) == 3

    r = await client.post(_BASE + f"/plans/{plan['id']}/case-links/batch-delete",
                          json={"project_id": pid, "link_ids": [a]}, headers=h)
    assert r.status_code == 200 and r.json()["updated"] == 1
    assert await _count(conn, "plan_case_link", "plan_id = :p", p=plan["id"]) == 2
    assert await _count(conn, "plan_functional_exec", "link_id = :l", l=a) == 0
    assert await _count(conn, "plan_functional_exec_history", "link_id = :l", l=a) == 0
    # 别的关联的结论一根毫毛没动
    assert await _count(conn, "plan_functional_exec", "link_id = :l", l=b) == 1
    # 用例本体不动
    assert await _count(conn, "api_case", "id = :i", i="c0") == 1


# ══════════ 4. 功能用例列表同一份指派 ══════════
async def test_functional_list_reflects_assign_and_sort(client, make_user) -> None:
    _, h = await make_user("d206f", admin=True)
    pid = await _proj(client, h, "D206功能列表")
    plan = await _plan(client, h, pid, "功能计划")
    ids = []
    for name in ("功能A", "功能B"):
        r = await client.post(_BASE + "/functional-cases", json={"project_id": pid, "name": name}, headers=h)
        assert r.status_code == 201, r.text
        cid = r.json()["id"]
        lk = await _link(client, h, pid, plan["id"], "functional_case", cid)
        assert lk.status_code == 201, lk.text
        ids.append(lk.json()["id"])

    me = (await client.get(_BASE + "/auth/me", headers=h)).json()
    assert (await _assign(client, h, pid, plan["id"], [ids[0]], me["id"])).status_code == 200
    assert (await _sort(client, h, pid, plan["id"], [ids[1], ids[0]])).status_code == 200

    r = await client.get(_BASE + f"/plans/{plan['id']}/functional-cases",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert [x["link_id"] for x in rows] == [ids[1], ids[0]]
    by_id = {x["link_id"]: x for x in rows}
    assert by_id[ids[0]]["executor_id"] == me["id"] and by_id[ids[0]]["sort_order"] == 2
    assert by_id[ids[1]]["executor_id"] is None and by_id[ids[1]]["sort_order"] == 1


# ══════════ 5. 权限位 ══════════
async def test_gates_readonly_and_member(client, session, make_user) -> None:
    _, h = await make_user("d206g", admin=True)
    ro, hro = await make_user("d206g2")
    me, hme = await make_user("d206g3")
    ro_id, me_id = ro.id, me.id
    pid = await _proj(client, h, "D206权限")
    await _member(client, h, pid, ro_id, "READONLY")
    await _member(client, h, pid, me_id, "MEMBER")
    plan = await _plan(client, h, pid, "权限计划")
    links = await _seed_three_links(client, h, session, pid, plan["id"])
    a = links[0]["id"]

    r = await _assign(client, hro, pid, plan["id"], [a], ro_id)
    assert r.status_code == 403 and r.json()["details"]["perm"] == "testplan:link:update"
    r = await _sort(client, hro, pid, plan["id"], [a, links[1]["id"], links[2]["id"]])
    assert r.status_code == 403 and r.json()["details"]["perm"] == "testplan:link:update"
    # MEMBER 有 update 但 -*:delete：批量摘挂被拒
    r = await client.post(_BASE + f"/plans/{plan['id']}/case-links/batch-delete",
                          json={"project_id": pid, "link_ids": [a]}, headers=hme)
    assert r.status_code == 403 and r.json()["details"]["perm"] == "testplan:link:delete"
    assert await _count_orm(session, plan["id"]) == 3


async def _count_orm(session, plan_id: str) -> int:
    from sqlalchemy import func, select

    return int((await session.execute(
        select(func.count()).select_from(PlanCaseLink).where(PlanCaseLink.plan_id == plan_id))).scalar_one())
