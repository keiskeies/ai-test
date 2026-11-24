"""D274 场景导入：本平台导出的 JSON 快照回灌成新场景。

钉五条命门：
① 往返自证：export → import 的图/变量/策略/超时逐字保留，但 **id 必须新生成**；
② 导出文件里的 validation / refs / scenario_id 不参与写入（后端不声明这些字段）；
③ 撞名自动加「 (导入)」后缀并在 renamed 里点名（不 409、不静默覆盖）；
④ 步骤图非法 → 整批 422、一条都不写（全有或全无，不静默跳过）；
⑤ 目标项目里不存在的模块/环境 → 清空 + 点名（项目私有资产不跨项目跟随）。
"""
from __future__ import annotations

from typing import Any

GRAPH = {"version": 1, "nodes": [
    {"key": "login", "kind": "api_case", "ref": "case-login", "name": "登录"},
    {"key": "wait", "kind": "sleep", "config": {"ms": 100}, "name": "停一下"},
]}
BAD_GRAPH = {"version": 1, "nodes": [{"key": "", "kind": "sleep"}]}


async def _setup(client, make_user, tag: str):
    boss, hb = await make_user("imboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "pim" + tag},
                             headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk(client, h, pid, name="登录场景", **kw) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name}
    body.update(kw)
    r = await client.post("/api/v1/scenarios", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _export(client, h, pid) -> dict[str, Any]:
    r = await client.post("/api/v1/scenario-export", json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _import(client, h, pid, scenarios) -> Any:
    return await client.post("/api/v1/scenario-import",
                             json={"project_id": pid, "scenarios": scenarios}, headers=h)


async def _names(client, h, pid) -> list[str]:
    r = await client.get("/api/v1/scenarios?project_id=" + pid + "&size=200", headers=h)
    assert r.status_code == 200, r.text
    return [x["name"] for x in r.json()["items"]]


async def test_registry_shape_perm_is_create(client) -> None:
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("scenario_import")
    assert spec is not None and spec.perm == "scenario:create" and spec.effect == "write"


async def test_roundtrip_keeps_graph_but_mints_new_id(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    src = await _mk(client, h, pid, name="履约回归", step_graph=GRAPH,
                    variables={"uid": "1"}, priority="P1", fail_fast=False,
                    max_runtime_ms=60000)
    out = await _export(client, h, pid)
    r = await _import(client, h, pid, out["scenarios"])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["imported"] == 1
    # 撞名 → 自动加后缀并点名（导出→导入同项目必然撞名）
    assert body["renamed"] == [{"from": "履约回归", "to": "履约回归 (导入)"}]
    assert body["names"] == ["履约回归 (导入)"]
    # 固定口径：新 id 不是恢复备份
    assert any("导入总会生成新的场景 id" in n for n in body["notes"])

    rows = (await client.get("/api/v1/scenarios?project_id=" + pid + "&size=200",
                             headers=h)).json()["items"]
    assert len(rows) == 2
    copy = next(x for x in rows if x["id"] != src["id"])
    # 图/变量/策略/超时逐字保留（往返自证），id 必须不同
    assert copy["step_graph"] == GRAPH and copy["variables"] == {"uid": "1"}
    assert copy["priority"] == "P1" and copy["fail_fast"] is False
    assert copy["max_runtime_ms"] == 60000
    assert copy["id"] != src["id"]
    # 跨域引用原样保留 + notes 点名（不做跨域解析，不假装成功）
    assert any("跨域引用" in n for n in body["notes"])


async def test_file_validation_and_refs_are_ignored(client, make_user) -> None:
    """导出文件里的 validation/refs/scenario_id 是溯源字段：不信任、不沿用。
    把 validation 手改成 []（文件被篡改）也改变不了后端现算的结论。"""
    _, h, pid = await _setup(client, make_user, "B")
    entry = {
        "scenario_id": "forged-id", "name": "手改文件", "priority": "P2",
        "module_id": None, "step_graph": BAD_GRAPH, "variables": {}, "fail_fast": True,
        "max_runtime_ms": None, "common_assertions": [], "env_id": None,
        "project_public": True, "validation": [], "refs": [],
    }
    r = await _import(client, h, pid, [entry])
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_error"
    assert await _names(client, h, pid) == []  # 整批不写


async def test_invalid_entry_blocks_whole_batch(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "C")
    good = {"name": "好场景", "step_graph": GRAPH}
    bad = {"name": "坏场景", "step_graph": BAD_GRAPH}
    r = await _import(client, h, pid, [good, bad])
    assert r.status_code == 422, r.text
    items = r.json()["details"]["items"]
    assert [i["name"] for i in items] == ["坏场景"]
    assert await _names(client, h, pid) == []  # 好的那条也没写（全有或全无）


async def test_private_assets_from_other_project_are_cleared(client, make_user) -> None:
    """模块/环境是项目私有资产：目标项目里不存在 → 清空并在回包里点名。"""
    _, h, pid = await _setup(client, make_user, "D")
    other = (await client.post("/api/v1/projects", json={"name": "pimD2"}, headers=h)).json()["id"]
    r = await _import(client, h, pid, [{
        "name": "带外部资产", "step_graph": GRAPH,
        "module_id": "no-such-module", "env_id": "no-such-env",
    }])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["cleared_modules"] == ["带外部资产"]
    assert body["cleared_envs"] == ["带外部资产"]
    assert any("模块在目标项目不存在" in n for n in body["notes"])
    assert any("环境在目标项目不存在" in n for n in body["notes"])
    rows = (await client.get("/api/v1/scenarios?project_id=" + pid + "&size=200",
                             headers=h)).json()["items"]
    assert rows[0]["module_id"] is None and rows[0]["env_id"] is None
    # 另一个项目没被写进任何东西（归属围栏）
    assert await _names(client, h, other) == []
