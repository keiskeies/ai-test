"""D204 判据刀：计划内功能用例（关联 + 人工结论 + 状态聚合 + 级联）。

钉的契约（一条判断一条用例）：

1. **功能用例能挂进计划**：词表新增 functional_case，subject_name 从用例表抄、env 恒 None；
   列表行带用例号/优先级/模块与当前结论（未执行 = none）。
2. **人工结论落库并进状态聚合**：pass → plan_status passed/executed 各 1、计划 completed；
   再改 fail → in_progress；blocked/skip 算「已执行但未通过」（failed），列表仍显示原值。
3. **拒绝要开口**：词表外 result 422；跨计划 link 整批 404（不写半批）；非功能用例关联 422；
   已归档计划 409。
4. **级联**：摘挂带走执行结论与流水；删计划同样带走（别的计划一行不动）。
5. **权限位真守护**：READONLY 的 execute 403 且 details.perm 指名；列表读取放行。
6. **表形状 = 迁移形状**：link_id 唯一键、索引在场。
"""

from __future__ import annotations

from app.modules.functional.models import FunctionalCase

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _seed_case(
    session, pid: str, *, case_id: str, num: int, name: str, module_id: str | None = None
) -> None:
    session.add(
        FunctionalCase(
            id=case_id, project_id=pid, num=num, name=name, template_id="tpl-seed", module_id=module_id
        )
    )
    await session.commit()


async def _link(client, h, pid: str, plan_id: str, subject_type: str, subject_id: str):
    return await client.post(
        _BASE + f"/plans/{plan_id}/case-links",
        json={"project_id": pid, "subject_type": subject_type, "subject_id": subject_id},
        headers=h,
    )


async def _execute(
    client, h, pid: str, plan_id: str, link_ids: list[str], result: str, comment: str | None = None
):
    return await client.post(
        _BASE + f"/plans/{plan_id}/functional-cases/execute",
        json={"project_id": pid, "link_ids": link_ids, "result": result, "comment": comment},
        headers=h,
    )


async def _list(client, h, pid: str, plan_id: str, **params):
    r = await client.get(
        _BASE + f"/plans/{plan_id}/functional-cases",
        params=[("project_id", pid)] + [(k, str(v)) for k, v in params.items()],
        headers=h,
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _status(client, h, pid: str, plan_id: str) -> dict:
    r = await client.get(_BASE + f"/plans/{plan_id}/status", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _count(conn, table: str, where: str, **params) -> int:
    from sqlalchemy import text

    r = await conn.execute(text(f"SELECT COUNT(*) FROM {table} WHERE " + where), params)
    return int(r.scalar_one())


async def test_functional_case_link_list_and_execute_aggregates(client, session, make_user) -> None:
    """挂载 → 列表 → 通过 → 失败 → 阻塞，四步都读回同一个真相。"""
    boss, hb = await make_user("d204a", admin=True)
    pid = await _proj(client, hb, "D204挂载")
    pl = await _plan(client, hb, pid, "功能计划")
    await _seed_case(session, pid, case_id="fc-1", num=100001, name="登录成功", module_id="mod-1")

    lk = await _link(client, hb, pid, pl["id"], "functional_case", "fc-1")
    assert lk.status_code == 201, lk.text
    body = lk.json()
    assert body["subject_name"] == "登录成功" and body["env_id"] is None
    lid = body["id"]

    lst = await _list(client, hb, pid, pl["id"])
    assert lst["total"] == 1
    row = lst["items"][0]
    assert (row["num"], row["name"], row["priority"], row["module_id"]) == (100001, "登录成功", "P2", "mod-1")
    assert row["result"] == "none" and row["executed"] is False, "未执行必须是 none，不是默认 pass"

    ok = await _execute(client, hb, pid, pl["id"], [lid], "pass", "手工通过")
    assert ok.status_code == 200 and ok.json() == {"ok": True}, ok.text
    st = await _status(client, hb, pid, pl["id"])
    assert (st["total"], st["passed"], st["executed"], st["status"]) == (1, 1, 1, "completed")
    row = (await _list(client, hb, pid, pl["id"]))["items"][0]
    assert (row["result"], row["executed"], row["comment"]) == ("pass", True, "手工通过")

    await _execute(client, hb, pid, pl["id"], [lid], "fail")
    st = await _status(client, hb, pid, pl["id"])
    assert (st["passed"], st["failed"], st["executed"], st["status"]) == (0, 1, 1, "in_progress")

    blocked = await _execute(client, hb, pid, pl["id"], [lid], "blocked")
    assert blocked.status_code == 200
    row = (await _list(client, hb, pid, pl["id"]))["items"][0]
    assert row["result"] == "blocked", "列表必须显示原值（阻塞不许被投影成 fail）"
    st = await _status(client, hb, pid, pl["id"])
    assert (st["passed"], st["failed"], st["executed"]) == (0, 1, 1), (
        "blocked 应算已执行未通过（executed=1/passed=0），不许抬高通过率"
    )

    hist = await client.get(
        _BASE + f"/plans/{pl['id']}/functional-cases/{lid}/history", params={"project_id": pid}, headers=hb
    )
    assert hist.status_code == 200, hist.text
    results = [x["result"] for x in hist.json()["items"]]
    assert results == ["blocked", "fail", "pass"], "append-only 历史且序号倒序：" + str(results)
    assert [x["seq"] for x in hist.json()["items"]] == [3, 2, 1]
    assert hist.json()["items"][0]["comment"] is None


async def test_execute_rejections_and_filters(client, session, conn, make_user) -> None:
    """词表外 result / 跨计划 link / 非功能用例关联 / 归档计划，四种拒绝都不落库；筛选 total 一致。"""
    boss, hb = await make_user("d204b", admin=True)
    pid = await _proj(client, hb, "D204拒绝")
    pa = await _plan(client, hb, pid, "甲")
    pb = await _plan(client, hb, pid, "乙")
    await _seed_case(session, pid, case_id="fc-a", num=1, name="用例甲", module_id="m1")
    await _seed_case(session, pid, case_id="fc-b", num=2, name="用例乙", module_id="m2")

    la = await _link(client, hb, pid, pa["id"], "functional_case", "fc-a")
    lb = await _link(client, hb, pid, pb["id"], "functional_case", "fc-b")
    assert la.status_code == 201 and lb.status_code == 201
    lid_a, lid_b = la.json()["id"], lb.json()["id"]

    bad = await _execute(client, hb, pid, pa["id"], [lid_a], "nonsense")
    assert bad.status_code == 422 and bad.json()["code"] == "validation_failed"
    cross = await _execute(client, hb, pid, pa["id"], [lid_a, lid_b], "pass")
    assert cross.status_code == 404 and set(cross.json()["details"]["link_ids"]) == {lid_b}, (
        "跨计划的 link 必须整批拒绝"
    )
    assert await _count(conn, "plan_functional_exec", "plan_id=:p", p=pa["id"]) == 0, "整批 404 却写了半批"

    # 非功能用例的关联写人工结论 → 422（不能拿场景的 link_id 冒充）
    from app.modules.api_test.models import ApiCase

    session.add(ApiCase(id="api-x", project_id=pid, definition_id="d", name="接口用例"))
    await session.commit()
    api_link = await _link(client, hb, pid, pa["id"], "api_case", "api-x")
    assert api_link.status_code == 201
    wrong_type = await _execute(client, hb, pid, pa["id"], [api_link.json()["id"]], "pass")
    assert wrong_type.status_code == 422 and wrong_type.json()["code"] == "validation_failed"

    # 筛选：module_id / keyword / result，total 都按同一谓词算
    empty = await _list(client, hb, pid, pa["id"], result="none")
    assert empty["total"] == 1 and empty["items"][0]["case_id"] == "fc-a"
    await _execute(client, hb, pid, pa["id"], [lid_a], "pass")
    assert (await _list(client, hb, pid, pa["id"], result="none"))["total"] == 0
    assert (await _list(client, hb, pid, pa["id"], result="pass"))["total"] == 1
    assert (await _list(client, hb, pid, pa["id"], module_id="m2"))["total"] == 0
    assert (await _list(client, hb, pid, pa["id"], keyword="甲"))["total"] == 1

    arch = await client.post(_BASE + f"/plans/{pa['id']}/archive", json={"project_id": pid}, headers=hb)
    assert arch.status_code == 200, arch.text
    denied = await _execute(client, hb, pid, pa["id"], [lid_a], "fail")
    assert denied.status_code == 409 and denied.json()["code"] == "already_archived"


async def test_cascade_on_unlink_and_plan_delete(client, session, conn, make_user) -> None:
    """摘挂带走结论+流水；删计划带走本计划全部、别的计划一行不动。"""
    boss, hb = await make_user("d204c", admin=True)
    pid = await _proj(client, hb, "D204级联")
    victim = await _plan(client, hb, pid, "被删")
    neighbor = await _plan(client, hb, pid, "幸存")
    await _seed_case(session, pid, case_id="fc-v", num=1, name="被删用例")
    await _seed_case(session, pid, case_id="fc-n", num=2, name="幸存用例")
    lv = (await _link(client, hb, pid, victim["id"], "functional_case", "fc-v")).json()
    ln = (await _link(client, hb, pid, neighbor["id"], "functional_case", "fc-n")).json()
    await _execute(client, hb, pid, victim["id"], [lv["id"]], "pass")
    await _execute(client, hb, pid, neighbor["id"], [ln["id"]], "fail")
    assert await _count(conn, "plan_functional_exec", "plan_id=:p", p=victim["id"]) == 1
    assert await _count(conn, "plan_functional_exec_history", "plan_id=:p", p=victim["id"]) == 1

    un = await client.request(
        "DELETE", _BASE + f"/plans/{victim['id']}/case-links/{lv['id']}", json={"project_id": pid}, headers=hb
    )
    assert un.status_code == 200
    assert await _count(conn, "plan_functional_exec", "link_id=:l", l=lv["id"]) == 0, (
        "摘挂后当前结论还在 = 孤儿行"
    )
    assert await _count(conn, "plan_functional_exec_history", "link_id=:l", l=lv["id"]) == 0

    dl = await client.request(
        "DELETE", _BASE + f"/plans/{victim['id']}", json={"project_id": pid}, headers=hb
    )
    assert dl.status_code == 200
    assert await _count(conn, "plan_functional_exec", "plan_id=:p", p=victim["id"]) == 0
    assert await _count(conn, "plan_functional_exec_history", "plan_id=:p", p=victim["id"]) == 0
    assert await _count(conn, "plan_functional_exec", "plan_id=:p", p=neighbor["id"]) == 1, (
        "删计划级联按 plan_id 走，不许波及隔壁计划"
    )
    assert await _count(conn, "plan_case_link", "plan_id=:p", p=neighbor["id"]) == 1


async def test_execute_perm_gate_and_table_shape(client, session, conn, make_user) -> None:
    """READONLY 的 execute 403 且指名权限位；link_id 唯一键与索引在场。"""
    from sqlalchemy import inspect

    boss, hb = await make_user("d204d", admin=True)
    pid = await _proj(client, hb, "D204门禁")
    pl = await _plan(client, hb, pid, "门禁计划")
    await _seed_case(session, pid, case_id="fc-g", num=1, name="门禁用例")
    lk = (await _link(client, hb, pid, pl["id"], "functional_case", "fc-g")).json()

    ro, hr = await make_user("d204dro")
    r = await client.put(
        _BASE + f"/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"}, headers=hb
    )
    assert r.status_code == 200, r.text
    assert (await _list(client, hr, pid, pl["id"]))["total"] == 1, "READONLY 应读得到列表"
    denied = await _execute(client, hr, pid, pl["id"], [lk["id"]], "pass")
    assert denied.status_code == 403
    assert denied.json()["details"]["perm"] == "testplan:functional:execute"
    assert await _count(conn, "plan_functional_exec", "link_id=:l", l=lk["id"]) == 0

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "cols": {c["name"] for c in insp.get_columns("plan_functional_exec")},
            "idx": {i["name"] for i in insp.get_indexes("plan_functional_exec")},
            "uq": {
                (u["name"], tuple(sorted(u["column_names"])))
                for u in insp.get_unique_constraints("plan_functional_exec")
            },
        }

    got = await conn.run_sync(_read)
    assert set(got["cols"]) == {
        "id",
        "project_id",
        "plan_id",
        "link_id",
        "case_id",
        "result",
        "comment",
        "executed_by",
        "executed_at",
        "created_at",
        "updated_at",
    }
    assert ("uq_plan_functional_exec_link", ("link_id",)) in got["uq"]
    for i in (
        "ix_plan_functional_exec_project_id",
        "ix_plan_functional_exec_plan_id",
        "ix_plan_functional_exec_link_id",
        "ix_plan_functional_exec_case_id",
    ):
        assert i in got["idx"], "缺索引 " + i

    def _read_hist(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "cols": {c["name"] for c in insp.get_columns("plan_functional_exec_history")},
            "idx": {i["name"] for i in insp.get_indexes("plan_functional_exec_history")},
        }

    hist_shape = await conn.run_sync(_read_hist)
    assert "seq" in hist_shape["cols"], "历史表缺 seq，秒内两次改判无法定序"
    assert "ix_plan_functional_exec_history_link_seq" in hist_shape["idx"]
