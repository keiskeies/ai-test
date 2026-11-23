"""D208 判据刀：复制计划（MS TestPlanService.copy 的等价面）。

钉的契约（一条判断一条用例）：

1. **抄头 + 抄关联，不抄执行结论/报告**（copy_header_and_links...）：源计划挂两条关联
   （一条场景、一条功能用例），场景关联带环境/执行人/排序位，功能用例已被人工执行，
   且源计划已生成一份报告。复制后：
   - 新计划头 = 源 description，`archived=False`（复制件是可用的新计划，MS 复位 Prepare），
     `created_by/updated_by` = 复制人；
   - 关联两行逐列抄（subject_type/id/name/env_id/executor_id/sort_order），created_by = 复制人；
   - **新计划的 status 是 not_started、executed=0**，功能用例列表 result=none；
     报告列表 total=0——上一轮的结论不许搬进新计划；
   - 源计划一根毫毛没动（两条关联仍在、status 仍 executed=1、报告仍在）。
2. **默认名形状与截断**（default_name...）：`<源名>_<5 位>_COPY`，源名 200 字时结果仍 ≤200
   且后缀保住；同源复制两次两次都不撞名（随机后缀的存在意义）。
3. **显式名：重名 409、超长 422、正常名 201**（explicit_name...）。
4. **跨项目/不存在同码同文案 404**（cross_project...）：两种错位都 404「计划不存在」。
5. **权限**（gates...）：READONLY 403 且 details.perm=testplan:plan:create、拒绝不落库；
   MEMBER（持 `*`、无 delete/manage）可以复制——与新建同一位是本刀的位选择。
6. **空计划复制**（empty_plan...）：total=0、status=not_started，不报错。
"""
from __future__ import annotations

import re

from app.modules.env.models import Environment
from app.modules.functional.models import FunctionalCase
from app.modules.scenario.models import Scenario

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _plan(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _link(client, h, pid: str, plan_id: str, subject_type: str, subject_id: str) -> dict:
    r = await client.post(_BASE + f"/plans/{plan_id}/case-links",
                          json={"project_id": pid, "subject_type": subject_type,
                                "subject_id": subject_id}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _links(client, h, pid: str, plan_id: str) -> dict:
    r = await client.get(_BASE + f"/plans/{plan_id}/case-links",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _status(client, h, pid: str, plan_id: str) -> dict:
    r = await client.get(_BASE + f"/plans/{plan_id}/status",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _copy(client, h, pid: str, plan_id: str, **body):
    return await client.post(_BASE + f"/plans/{plan_id}/copy",
                             json={"project_id": pid, **body}, headers=h)


async def _count(conn, sql: str, **params) -> int:
    from sqlalchemy import text

    return int((await conn.execute(text(sql), params)).scalar_one())


async def test_copy_header_and_links_without_results(client, session, conn, make_user) -> None:
    """源计划：2 关联（环境/执行人/排序位）、功能用例已执行、报告已生成 → 复制件全抄关联、零结论。"""
    admin, h = await make_user("d208a", admin=True)
    pid = await _proj(client, h, "D208复制")
    src = await _plan(client, h, pid, "结算回归", description="覆盖结算主链路")
    session.add(Environment(id="env-d208", project_id=pid, name="联调环境"))
    session.add(Scenario(id="sc-d208", project_id=pid, name="下单场景",
                         step_graph={"version": 1, "nodes": []}, env_id="env-d208"))
    session.add(FunctionalCase(id="fc-d208", project_id=pid, num=208001,
                               name="登录成功", template_id="tpl-seed"))
    await session.commit()

    # 场景关联（自动抄 env）+ 功能用例关联，然后指派执行人、排定顺序、执行功能用例。
    lk_sc = await _link(client, h, pid, src["id"], "scenario", "sc-d208")
    lk_fc = await _link(client, h, pid, src["id"], "functional_case", "fc-d208")
    mem, _mh = await make_user("d208m")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await client.post(_BASE + f"/plans/{src['id']}/case-links/assign",
                          json={"project_id": pid, "link_ids": [lk_sc["id"], lk_fc["id"]],
                                "executor_id": mem.id}, headers=h)
    assert r.status_code == 200, r.text
    r = await client.post(_BASE + f"/plans/{src['id']}/case-links/sort",
                          json={"project_id": pid,
                                "link_ids": [lk_fc["id"], lk_sc["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    r = await client.post(_BASE + f"/plans/{src['id']}/functional-cases/execute",
                          json={"project_id": pid, "link_ids": [lk_fc["id"]],
                                "result": "pass", "comment": "登录链路 OK"}, headers=h)
    assert r.status_code == 200, r.text
    r = await client.post(_BASE + f"/plans/{src['id']}/reports",
                          json={"project_id": pid, "name": "源报告"}, headers=h)
    assert r.status_code == 201, r.text

    r = await _copy(client, h, pid, src["id"])
    assert r.status_code == 201, r.text
    dst = r.json()
    assert dst["id"] != src["id"]
    assert dst["project_id"] == pid
    assert dst["description"] == "覆盖结算主链路"
    assert dst["archived"] is False  # 归档位不抄
    assert dst["created_by"] == admin.id and dst["updated_by"] == admin.id

    # 关联逐列抄（含 D206 的 executor_id / sort_order 与 D183 的 env 快照）。
    got = await _links(client, h, pid, dst["id"])
    assert got["total"] == 2
    by_type = {x["subject_type"]: x for x in got["items"]}
    assert by_type["scenario"]["subject_id"] == "sc-d208"
    assert by_type["scenario"]["subject_name"] == "下单场景"
    assert by_type["scenario"]["env_id"] == "env-d208"
    assert by_type["scenario"]["executor_id"] == mem.id
    assert by_type["scenario"]["sort_order"] == 2  # 排序被抄：fc 在前(1)、sc 在后(2)
    assert by_type["functional_case"]["subject_id"] == "fc-d208"
    assert by_type["functional_case"]["executor_id"] == mem.id
    assert by_type["functional_case"]["sort_order"] == 1
    assert all(x["created_by"] == admin.id for x in got["items"])

    # 结论不抄：新计划未开始（功能用例的 pass 没有跟着过去）。
    st = await _status(client, h, pid, dst["id"])
    assert (st["total"], st["executed"], st["passed"]) == (2, 0, 0)
    assert st["status"] == "not_started"
    assert all(x["result"] == "none" and x["executed"] is False for x in st["links"])
    r = await client.get(_BASE + f"/plans/{dst['id']}/functional-cases",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert [x["result"] for x in r.json()["items"]] == ["none"]
    r = await client.get(_BASE + f"/plans/{dst['id']}/reports",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["total"] == 0
    # 库层再证一次：新计划没有结论行、没有报告行。
    assert await _count(conn, "SELECT COUNT(*) FROM plan_functional_exec WHERE plan_id=:p",
                        p=dst["id"]) == 0
    assert await _count(conn, "SELECT COUNT(*) FROM plan_report WHERE plan_id=:p",
                        p=dst["id"]) == 0

    # 源计划一根毫毛没动。
    src_links = await _links(client, h, pid, src["id"])
    assert src_links["total"] == 2
    assert {x["id"] for x in src_links["items"]} == {lk_sc["id"], lk_fc["id"]}
    st_src = await _status(client, h, pid, src["id"])
    assert (st_src["executed"], st_src["passed"]) == (1, 1)
    r = await client.get(_BASE + f"/plans/{src['id']}/reports",
                         params={"project_id": pid}, headers=h)
    assert r.json()["total"] == 1


async def test_default_name_shape_and_truncation(client, make_user) -> None:
    """默认名 `<源名>_<5位>_COPY`；200 字源名复制仍 ≤200 且后缀完整；连复制两次不撞名。"""
    _, h = await make_user("d208b", admin=True)
    pid = await _proj(client, h, "D208命名")
    long_name = "长" * 200
    src = await _plan(client, h, pid, long_name)

    r1 = await _copy(client, h, pid, src["id"])
    assert r1.status_code == 201, r1.text
    name1 = r1.json()["name"]
    assert len(name1) <= 200
    assert re.fullmatch(r"长{189}_[0-9a-f]{5}_COPY", name1), name1

    r2 = await _copy(client, h, pid, src["id"])
    assert r2.status_code == 201, r2.text
    assert r2.json()["name"] != name1  # 随机后缀防同项目重名 409


async def test_explicit_name_conflict_and_validation(client, make_user) -> None:
    """显式名：正常 201、同项目重名 409、超 200 字 422。"""
    _, h = await make_user("d208c", admin=True)
    pid = await _proj(client, h, "D208显式名")
    src = await _plan(client, h, pid, "源计划")
    await _plan(client, h, pid, "占位计划")

    r = await _copy(client, h, pid, src["id"], name="复制件")
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "复制件"

    r = await _copy(client, h, pid, src["id"], name="占位计划")
    assert r.status_code == 409 and r.json()["message"] == "计划名已存在"

    r = await _copy(client, h, pid, src["id"], name="x" * 201)
    assert r.status_code == 422


async def test_cross_project_and_missing_are_same_404(client, make_user) -> None:
    """别项目的 plan_id / 不存在的 plan_id：同码同文案 404，不泄露存在性。"""
    _, h = await make_user("d208d", admin=True)
    pid_a = await _proj(client, h, "D208甲")
    pid_b = await _proj(client, h, "D208乙")
    pb = await _plan(client, h, pid_b, "乙计划")

    r1 = await _copy(client, h, pid_a, pb["id"])
    r2 = await _copy(client, h, pid_a, "no-such-plan")
    assert r1.status_code == r2.status_code == 404
    assert r1.json()["message"] == r2.json()["message"] == "计划不存在"


async def test_gates(client, conn, make_user) -> None:
    """READONLY 403（perm 原话）且不落库；MEMBER 可复制。"""
    _, h = await make_user("d208e", admin=True)
    pid = await _proj(client, h, "D208门")
    src = await _plan(client, h, pid, "门计划")
    before = await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE project_id=:p", p=pid)

    ro, roh = await make_user("d208ro")
    await _member(client, h, pid, ro.id, "READONLY")
    r = await _copy(client, roh, pid, src["id"])
    assert r.status_code == 403
    assert r.json()["details"]["perm"] == "testplan:plan:create"
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE project_id=:p",
                        p=pid) == before  # 门拒绝不落库

    mem, mh = await make_user("d208me")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await _copy(client, mh, pid, src["id"])
    assert r.status_code == 201, r.text


async def test_empty_plan_copy(client, make_user) -> None:
    """空计划复制：新计划 total=0、not_started，不报错。"""
    _, h = await make_user("d208f", admin=True)
    pid = await _proj(client, h, "D208空")
    src = await _plan(client, h, pid, "空计划")
    r = await _copy(client, h, pid, src["id"])
    assert r.status_code == 201, r.text
    st = await _status(client, h, pid, r.json()["id"])
    assert (st["total"], st["executed"], st["status"]) == (0, 0, "not_started")
    assert st["links"] == []
