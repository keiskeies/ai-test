"""D74 场景导出备份：只读快照 + 归属/可见性围栏（§11.4.8 批量条 [导出]）。

照 test_api_export.py 的形状钉，但**钉的方向不同**：那边命门是「导出→导入往返自证」，
场景域没有导入解析器，往返无从谈起（假门）。这边的命门是围栏三件套：
① 跨项目越权：甲项目的场景 id 拿到乙项目（我是乙成员）去导 → 404，一条内容都不泄
  （变异 A：摘掉 SQL 的 project_id 归属围栏 → 本用例红）；
② 回收站里的场景导不出：全量不进气泡、点 id 整批 404（与 api_export 同口径 fail-fast）；
③ 私有不可见场景不泄：MEMBER 全量导出看不到别人的私有场景、点它的 id → 404
  （变异 B：摘掉 visible_clause → 私有场景静默泄进导出结果 → 本用例红）。
另有内容面：step_graph 逐字、validate 现算判定、refs 原样 id 指针、notes 如实报。
"""
from __future__ import annotations

from typing import Any

GRAPH = {"version": 1, "nodes": [
    {"key": "login", "kind": "api_case", "ref": "case-login", "name": "登录"},
    {"key": "wait", "kind": "sleep", "config": {"ms": 100}, "name": "停一下"},
]}


async def _setup(client, make_user, tag: str):
    boss, hb = await make_user("exboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "pex" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk(client, h, pid, name="登录场景", **kw) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name}
    body.update(kw)
    r = await client.post("/api/v1/scenarios", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _member(client, make_user, h, pid, tag: str):
    m, hm = await make_user("exmem" + tag)
    r = await client.put("/api/v1/projects/" + pid + "/members/" + m.id,
                         json={"role_code": "MEMBER"}, headers=h)
    assert r.status_code == 200, r.text
    return m, hm


async def _export(client, h, pid, ids=None):
    body: dict[str, Any] = {"project_id": pid}
    if ids is not None:
        body["scenario_ids"] = ids
    r = await client.post("/api/v1/scenario-export", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


# —————————————————————— 注册形状（READONLY glob 坑，同 test_api_export） ——————————————————————

async def test_registry_shape_perm_is_read(client) -> None:
    from app.core.permissions import match_perm
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("scenario_export")
    assert spec is not None and spec.perm == "scenario:read" and spec.effect == "read"
    # READONLY 的 ["*:read"] 必须盖住 scenario:read——POST 动作 perm 以 :read 结尾才不被 glob 漏
    assert match_perm({"*:read"}, "scenario:read")


# —————————————————————— 内容面：勾选导出、字段逐字、validate/refs ——————————————————————

async def test_export_selected_fields_verbatim(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    s = await _mk(client, h, pid, name="履约回归", step_graph=GRAPH, variables={"uid": "1"},
                  priority="P1", fail_fast=False, max_runtime_ms=60000)
    await _mk(client, h, pid, name="没被勾的")
    out = await _export(client, h, pid, [s["id"]])
    assert out["exported"] == 1
    assert len(out["scenarios"]) == 1
    e = out["scenarios"][0]
    # 字段逐字：step_graph 快照原样、变量/策略/超时/可见性都在（导出的是真配置不是摘要）
    assert e["scenario_id"] == s["id"] and e["name"] == "履约回归"
    assert e["step_graph"] == GRAPH and e["variables"] == {"uid": "1"}
    assert e["priority"] == "P1" and e["fail_fast"] is False and e["max_runtime_ms"] == 60000
    # validate 现算：合法图 → 空列表（「能被 validate 判真假」的正面证据）
    assert e["validation"] == []
    # 跨域引用 = 原样 id 指针（kind/ref/step_key 点名，不做跨域解析）
    assert e["refs"] == [{"step_key": "login", "kind": "api_case", "ref": "case-login"}]
    # 如实报：D274 起导出可回灌（导入生成新 id，不是恢复备份），这条口径写在 notes 里
    assert any("本导出是场景快照" in n and "导入" in n and "id 会重新生成" in n for n in out["notes"])
    assert any("跨域引用" in n and "case-login" not in n and s["name"] in n for n in out["notes"])


async def test_export_ids_edge_cases(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "B")
    s = await _mk(client, h, pid, name="在场")
    # 不存在的 id → 404 fail-fast（api_export 口径：整批报错，不是跳过+报告）
    miss = await client.post("/api/v1/scenario-export", json={
        "project_id": pid, "scenario_ids": ["不存在"]}, headers=h)
    assert miss.status_code == 404, miss.text
    assert miss.json()["details"]["scenario_ids"] == ["不存在"]
    # 重复 id → 422（与 api_export 同）
    dup = await client.post("/api/v1/scenario-export", json={
        "project_id": pid, "scenario_ids": [s["id"], s["id"]]}, headers=h)
    assert dup.status_code == 422 and dup.json()["code"] == "validation_failed", dup.text


async def test_export_reports_invalid_graph(client, make_user, session) -> None:
    """老场景带历史坏图：照常导出，但 validation 现算出 issue、notes 点名（如实报）。"""
    from app.modules.scenario.models import Scenario

    _, h, pid = await _setup(client, make_user, "C")
    s = await _mk(client, h, pid, name="坏图老场景")
    row = await session.get(Scenario, s["id"])
    row.step_graph = {"version": 1, "nodes": [{"key": "b", "kind": "break"}]}  # break 出环
    await session.commit()
    out = await _export(client, h, pid, [s["id"]])
    e = out["scenarios"][0]
    codes = [i["code"] for i in e["validation"]]
    assert "break_outside_loop" in codes, e["validation"]
    assert any("坏图老场景" in n and "校验问题" in n for n in out["notes"])


# —————————————————————— 围栏①：跨项目越权（变异 A 的靶子） ——————————————————————

async def test_cross_project_scenario_ids_rejected(client, make_user) -> None:
    """甲的场景 id 拿到乙项目（我是乙成员）去导 → 404，一条内容都不泄。

    这是变异 A 的靶子：摘掉 SQL 里的 project_id 归属围栏，这条就会 200 且 scenarios
    里出现甲的场景内容——红。
    """
    _, ha, pid_a = await _setup(client, make_user, "X1")
    sa = await _mk(client, ha, pid_a, name="甲项目机密场景")
    _, hb, pid_b = await _setup(client, make_user, "X2")
    r = await client.post("/api/v1/scenario-export", json={
        "project_id": pid_b, "scenario_ids": [sa["id"]]}, headers=hb)
    assert r.status_code == 404, r.text
    assert r.json()["details"]["scenario_ids"] == [sa["id"]]
    assert "甲项目机密场景" not in r.text
    # 非成员整项目也被拦（ensure_project_access / build_ctx 的 403，同 api_export 用例）
    _, ho = await make_user("exout")
    r2 = await client.post("/api/v1/scenario-export", json={"project_id": pid_a}, headers=ho)
    assert r2.status_code in (403, 404), r2.text


# —————————————————————— 围栏②：回收站里的场景导不出 ——————————————————————

async def test_recycled_scenario_not_exportable(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "D")
    s = await _mk(client, h, pid, name="要回收的")
    keep = await _mk(client, h, pid, name="留下的")
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    # 全量：回收中的不进气泡，正常场景照常出
    full = await _export(client, h, pid)
    assert [e["scenario_id"] for e in full["scenarios"]] == [keep["id"]]
    # 点它的 id：与 api_export 同口径——整批 404（「已回收」与「不可见」「不存在」同文案族）
    r = await client.post("/api/v1/scenario-export", json={
        "project_id": pid, "scenario_ids": [s["id"]]}, headers=h)
    assert r.status_code == 404, r.text
    # 混在一批里也不许只导一条：勾 2 回 1 的半份备份最骗人
    r2 = await client.post("/api/v1/scenario-export", json={
        "project_id": pid, "scenario_ids": [keep["id"], s["id"]]}, headers=h)
    assert r2.status_code == 404, r2.text
    # restore 之后重新可导（导出围栏认的是当前状态）
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/restore",
                              json={"project_id": pid}, headers=h)).status_code == 200
    back = await _export(client, h, pid)
    assert {e["scenario_id"] for e in back["scenarios"]} == {s["id"], keep["id"]}


# —————————————————————— 围栏③：私有不可见场景（变异 B 的靶子） ——————————————————————

async def test_private_scenario_never_leaks(client, make_user) -> None:
    """MEMBER 全量导出看不到别人的私有场景；点它的 id → 404；owner 自己导得出。

    这是变异 B 的靶子：摘掉 visible_clause，第一条断言就会在 full["names"] 里
    看到「老板私藏」——红。
    """
    boss, hb, pid = await _setup(client, make_user, "P")
    secret = await _mk(client, hb, pid, name="老板私藏", project_public=False)
    pub = await _mk(client, hb, pid, name="项目公共")
    _m, hm = await _member(client, make_user, hb, pid, "P")
    full = await _export(client, hm, pid)
    names = [e["name"] for e in full["scenarios"]]
    assert names == ["项目公共"], full
    assert [e["scenario_id"] for e in full["scenarios"]] == [pub["id"]], full
    r = await client.post("/api/v1/scenario-export", json={
        "project_id": pid, "scenario_ids": [secret["id"]]}, headers=hm)
    assert r.status_code == 404, r.text
    assert "老板私藏" not in r.text
    # owner（项目创建者=PROJECT_ADMIN）全量能看到私有行；换个普通成员自己建的私有也能自导
    boss_full = await _export(client, hb, pid)
    assert {e["name"] for e in boss_full["scenarios"]} == {"老板私藏", "项目公共"}
    _m2, hm2 = await _member(client, make_user, hb, pid, "P2")
    s2 = await _mk(client, hm2, pid, name="成员自留地", project_public=False)
    out2 = await _export(client, hm2, pid, [s2["id"]])
    assert out2["exported"] == 1 and out2["scenarios"][0]["name"] == "成员自留地"
