"""D164：全平台唯一取消出口 POST /runs/{run_id}/cancel 的钥匙按 run 的域解析。

缺陷本体：run_cancel 曾不分域地 require("scenario:run")，而 UI/ADB 的 run 与场景 run
落同一张 run_record——持 ui:case:run 的自定义角色能发起却永远取消不了自己那条 run，
反过来 scenario:run 单独就能取消任何域的 run。裁定①：取消钥匙 = 该域执行门权限位
（scenario→scenario:run / ui_case→ui:case:run / adb_case→adb:case:run），未知域 fail closed。

本文件全部走**真实权限层**：自定义角色经 role_create 落库（D37 起为真）、成员经
set_member 挂真实 code、请求带真实 JWT 过 build_ctx→resolver→ctx.require——不自造 ctx.perms。
内置角色照不出这个洞（MEMBER=["*","-*:delete","-*:manage","-system:*"] 三个域的执行位
都有），所以这里全部用自定义角色，钉的就是「只有 D37 之后才存在」的那批人。

配对账：
- 域映射与三个执行门逐字相等 → test_d164_mapping_mirrors_execute_doors（对 REGISTRY 实钉，
  执行门改名/改位而映射没跟上 = 红）；
- 矩阵（test_permission_matrix）新增三行 run_cancel_*，钉内置角色 × 三域取消；
- agent 工具路（dispatcher 的 dynamic_perm 豁免）由本文件最后一条直调钉。
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def fake_bus():
    """run_cancel 放行格会真 request_cancel（bus.set_key）。必须在 client 之后装配
    （create_app 会把 bus 指回 settings 里的真 Redis——test_permission_matrix 同款纪律，
    测试签名里 fake_bus 排最后）。"""
    from fakeredis import FakeAsyncRedis

    from app.core.eventbus import init_bus

    return init_bus(client=FakeAsyncRedis(decode_responses=True))


async def _boss_project(client, make_user, tag: str) -> tuple[dict, str]:
    boss, h = await make_user("d164boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "D164项目" + tag}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _custom_role_headers(client, make_user, h_boss, pid: str, tag: str,
                               perms: list[str]) -> dict[str, str]:
    """真实自定义角色 → 真成员：role_create 落 custom_role 表，set_member 挂 code，
    请求头里的权限集由 resolver 从库里读出来——不是测试自造的 perms。"""
    r = await client.post("/api/v1/custom-roles", json={
        "project_id": pid, "name": "D164角色" + tag, "template_code": "READONLY",
        "perms": perms}, headers=h_boss)
    assert r.status_code == 201, r.text
    code = r.json()["code"]
    u, h = await make_user("d164u" + tag)
    r = await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                         json={"role_code": code}, headers=h_boss)
    assert r.status_code == 200, r.text
    return h


async def _queued_run(session, pid: str, subject_type: str) -> str:
    """直造 queued run（各域的 queued 行只有真执行才出生，测试不拖执行链进来）。
    subject_type 词表外/域外表也允许——库列是自由 String，fail-closed 分支要能被钉到。"""
    from app.modules.execution.models import RunRecord

    rec = RunRecord(project_id=pid, subject_type=subject_type, subject_id="d164-x",
                    subject_name="D164取消靶", trigger="manual", status="queued")
    session.add(rec)
    await session.commit()
    return rec.id


async def _cancel(client, h: dict[str, str], pid: str, run_id: str):
    return await client.post(f"/api/v1/runs/{run_id}/cancel", headers=h,
                             json={"project_id": pid})


async def test_d164_ui_run_cancelled_by_ui_only_role(client, make_user, session,
                                                     fake_bus) -> None:
    """判据(a)：ui_case run + 只持 ui:case:run 的角色 ⇒ 取消自己发起的域 200，旗真落下。

    旧行为是 403（静态 scenario:run 门）——这条在修复前必红，是本缺陷的正主。
    """
    h_boss, pid = await _boss_project(client, make_user, "a")
    rid = await _queued_run(session, pid, "ui_case")
    h = await _custom_role_headers(client, make_user, h_boss, pid, "a", ["ui:case:run"])
    r = await _cancel(client, h, pid, rid)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "queued"
    await session.rollback()
    from app.modules.execution.models import RunRecord

    rec = await session.get(RunRecord, rid)
    assert rec is not None and rec.cancel_requested == 1, "取消旗没落下"


async def test_d164_ui_run_denied_to_scenario_only_role(client, make_user,
                                                        session, fake_bus) -> None:
    """判据(b)：同一条 ui_case run，只持 scenario:run ⇒ 403，且 details.perm 指名 ui:case:run。

    这是被推翻的旧契约的反面（scenario:run 单独能取消任何域），403 必须来自体内按域
    require，位名走 D38 契约（details.perm），不是 route 层静态门的 scenario:run。
    """
    h_boss, pid = await _boss_project(client, make_user, "b")
    rid = await _queued_run(session, pid, "ui_case")
    h = await _custom_role_headers(client, make_user, h_boss, pid, "b", ["scenario:run"])
    r = await _cancel(client, h, pid, rid)
    assert r.status_code == 403, r.text
    body = r.json()
    assert body["code"] == "insufficient_permission", str(body)
    assert body["details"] == {"perm": "ui:case:run"}, \
        "403 必须指名域钥匙 ui:case:run（D38 契约），实得：" + str(body["details"])


async def test_d164_scenario_run_regression_legs(client, make_user, session,
                                                 fake_bus) -> None:
    """判据(c)：scenario 域回归双腿——scenario:run 照旧 200；只有 ui:case:run 反向 403。

    第二腿钉对称面：翻案只推翻「scenario:run 通吃」，不许顺手把别的域升成通吃。
    """
    h_boss, pid = await _boss_project(client, make_user, "c")
    rid = await _queued_run(session, pid, "scenario")
    h_ok = await _custom_role_headers(client, make_user, h_boss, pid, "c1", ["scenario:run"])
    r = await _cancel(client, h_ok, pid, rid)
    assert r.status_code == 200, r.text
    rid2 = await _queued_run(session, pid, "scenario")
    h_no = await _custom_role_headers(client, make_user, h_boss, pid, "c2", ["ui:case:run"])
    r2 = await _cancel(client, h_no, pid, rid2)
    assert r2.status_code == 403 and r2.json()["details"] == {"perm": "scenario:run"}, r2.text


async def test_d164_adb_run_follows_adb_key(client, make_user, session,
                                            fake_bus) -> None:
    """adb 域双腿：adb:case:run ⇒ 200；scenario:run ⇒ 403 details.perm=adb:case:run。"""
    h_boss, pid = await _boss_project(client, make_user, "d")
    rid = await _queued_run(session, pid, "adb_case")
    h_ok = await _custom_role_headers(client, make_user, h_boss, pid, "d1", ["adb:case:run"])
    assert (await _cancel(client, h_ok, pid, rid)).status_code == 200
    rid2 = await _queued_run(session, pid, "adb_case")
    h_no = await _custom_role_headers(client, make_user, h_boss, pid, "d2", ["scenario:run"])
    r2 = await _cancel(client, h_no, pid, rid2)
    assert r2.status_code == 403 and r2.json()["details"] == {"perm": "adb:case:run"}, r2.text


async def test_d164_unknown_domain_fails_closed(client, make_user, session,
                                                fake_bus) -> None:
    """未知域 fail closed：域没有已知执行门 ⇒ 403 ungoverned_subject，宁抛不装绿。

    queued 的 api_case 行今天经 API 造不出（api_debug 出生即终态、只吃 409）——直造它是
    为了钉住防御分支本身：把 fail-closed 改成兜底 scenario:run，这条先红（全位角色拿 200）。
    """
    h_boss, pid = await _boss_project(client, make_user, "e")
    rid = await _queued_run(session, pid, "api_case")
    h = await _custom_role_headers(client, make_user, h_boss, pid, "e", ["scenario:run"])
    r = await _cancel(client, h, pid, rid)
    assert r.status_code == 403, r.text
    body = r.json()
    assert body["code"] == "ungoverned_subject", str(body)
    assert body["details"] == {"subject_type": "api_case"}, str(body)
    assert "没有已知的执行权限位" in body["message"], body["message"]
    await session.rollback()
    from app.modules.execution.models import RunRecord

    rec = await session.get(RunRecord, rid)
    assert rec is not None and rec.cancel_requested == 0, "fail closed 不许先把旗落下再拒绝"


def test_d164_mapping_mirrors_execute_doors(client) -> None:
    """映射与三个执行门的注册表位逐字相等——执行门是钥匙的唯一真相，改名/改位必红。

    client 只为装配应用（import 全部 service 模块，注册表非空）。
    """
    from app.core.registry import REGISTRY
    from app.modules.scenario.services import _RUN_CANCEL_PERM

    assert _RUN_CANCEL_PERM == {
        "scenario": REGISTRY.get("scenario_run").perm,
        "ui_case": REGISTRY.get("ui_case_run").perm,
        "adb_case": REGISTRY.get("adb_case_run").perm,
    }, "取消钥匙与执行门权限位漂了（裁定①要求逐字镜像）"
    assert set(_RUN_CANCEL_PERM) == {"scenario", "ui_case", "adb_case"}, \
        "映射域集变了：矩阵行与本文件用例要同步，先回 grep subject_type 全量清单再动手"


async def test_d164_agent_tool_path_uses_domain_key(session, client, make_user,
                                                    fake_bus) -> None:
    """agent 工具路同尺：dispatcher 对 dynamic_perm 的 run_cancel 跳过静态门，
    handler 内按域 require——ui-only 角色经工具取消 ui run 成功，经工具取消 scenario run 被拒。

    没有这条，dispatcher 里 spec.perm 的静态门会把路由侧的修复旁路成第二套口径。
    """
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher

    h_boss, pid = await _boss_project(client, make_user, "g")
    ui_run = await _queued_run(session, pid, "ui_case")
    scen_run = await _queued_run(session, pid, "scenario")
    # ensure_project_access 会按 user_id 从库里重解权限集 ⇒ 必须是真实成员，不能自造 ctx
    r = await client.post("/api/v1/custom-roles", json={
        "project_id": pid, "name": "D164工具角色", "template_code": "READONLY",
        "perms": ["ui:case:run"]}, headers=h_boss)
    assert r.status_code == 201, r.text
    u, _ = await make_user("d164g")
    r = await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                         json={"role_code": r.json()["code"]}, headers=h_boss)
    assert r.status_code == 200, r.text
    disp = ToolDispatcher(session)
    ctx = ServiceCtx(entry="agent", user_id=u.id, perms=set(), db=session)
    ok = await disp.call("run_cancel", {"project_id": pid, "run_id": ui_run},
                         ctx, mode="FULL", grants=set())
    assert ok.ok is True, "agent 路 ui 域取消被静态门旁路：" + str(ok.error)
    denied = await disp.call("run_cancel", {"project_id": pid, "run_id": scen_run},
                             ctx, mode="FULL", grants=set())
    assert denied.ok is False, "agent 路 scenario 域不该被 ui:case:run 取消"
    assert "scenario:run" in str(denied.error), \
        "agent 路必须按域报缺的位名（handler 体内 require 的 D38 口径）：" + str(denied.error)
