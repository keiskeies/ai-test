"""D273：接口/UI/ADB 用例批量回收与批量恢复（补 §73 顺延的回收站批量入口缺口）。

钉的契约（三族同口径，纪律逐字抄 D251/D252 与单条 delete/restore）：
1. 全有或全无——任一 id 不存在/状态不对 → 404 且整批一行不动。
2. 重复 id → 422（拼错列表，不是「操作两次」）。
3. 回收侧引用检查先全查完再写：任一被未回收场景引用 → 409 + blocked 清单，零写入；
   批量不提供 force（强删必须逐个确认）。
4. 恢复侧特判：api_case 绑定的数据集已不存在 → 409 dataset_missing 整批不动（R82 同尺）；
   ui/adb_case 回收期间名字被占（含同批互撞）→ 409 conflict 整批不动（不静默改名）。
5. api_case 可达性跟着定义走：定义已回收的用例在批量里与不存在同码 404。
"""
from __future__ import annotations

REQ = {"method": "GET", "url": "http://127.0.0.1:9999/order/1"}
UI_STEPS = [{"id": "open1", "type": "open", "input": "/ui/login"}]
ADB_STEPS = [{"id": "s1", "type": "home"}]


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"},
                             headers=h)).json()["id"]
    return h, pid


async def _mk_api_case(client, h, pid, name, path="/a"):
    d = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "def_" + name, "method": "GET", "path": path,
        "request": REQ}, headers=h)).json()
    c = (await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": d["id"], "name": name}, headers=h)).json()
    return d, c


async def _mk_ui_case(client, h, pid, name):
    r = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": name, "steps": UI_STEPS}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mk_adb_case(client, h, pid, name):
    r = await client.post("/api/v1/adb-cases", json={
        "project_id": pid, "name": name, "steps": ADB_STEPS}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mk_scene(client, h, pid, ref, kind, name):
    graph = {"version": 1, "nodes": [{"key": "s1.step", "kind": kind, "ref": ref}]}
    r = await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": name, "step_graph": graph}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _names(client, h, pid, base, recycled=False):
    r = await client.get(base, params={"project_id": pid, **({"recycled": "true"} if recycled else {})},
                         headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


# ══════════ api-cases ══════════

async def test_api_case_batch_delete_and_restore(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d273a")
    d1, a = await _mk_api_case(client, h, pid, "用例A", "/a")
    _, b = await _mk_api_case(client, h, pid, "用例B", "/b")
    d3, c = await _mk_api_case(client, h, pid, "用例C", "/c")

    r = await client.post("/api/v1/api-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    # 回收站里可见、正常列表消失（回收站列表按项目全量，不带 definition_id）
    tr = await client.get("/api/v1/api-cases", params={"project_id": pid,
                          "recycled": "true"}, headers=h)
    assert {x["name"] for x in tr.json()["items"]} == {"用例A", "用例B"}

    rs = await client.post("/api/v1/api-cases/batch-restore",
                           json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert rs.status_code == 200, rs.text
    nr = await client.get("/api/v1/api-cases", params={"project_id": pid}, headers=h)
    assert {x["name"] for x in nr.json()["items"]} == {"用例A", "用例B", "用例C"}
    assert d1["id"] and d3["id"]


async def test_api_case_batch_all_or_nothing(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d273b")
    _, a = await _mk_api_case(client, h, pid, "用例A", "/a")
    _, b = await _mk_api_case(client, h, pid, "用例B", "/b")

    # 重复 id → 422
    r = await client.post("/api/v1/api-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], a["id"]]}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "validation_failed", r.text

    # 混入不存在 → 404 + 列 ids，一行不动
    r = await client.post("/api/v1/api-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], "no-such"]}, headers=h)
    assert r.status_code == 404 and r.json()["details"]["case_ids"] == ["no-such"], r.text

    # 引用拦截：B 被场景引用 → 整批 409 零写入
    await _mk_scene(client, h, pid, b["id"], "api_case", "引用场景")
    r = await client.post("/api/v1/api-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "referenced_by_scenario", r.text
    blocked = r.json()["details"]["blocked"]
    assert [x["name"] for x in blocked] == ["用例B"]
    nr = await client.get("/api/v1/api-cases", params={"project_id": pid}, headers=h)
    assert {x["name"] for x in nr.json()["items"]} == {"用例A", "用例B"}

    # 恢复方向同理：A 不在回收站 → 整批 404
    r = await client.post("/api/v1/api-cases/batch-restore",
                          json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert r.status_code == 404, r.text


async def test_api_case_batch_delete_recycled_def_404(client, make_user) -> None:
    """定义已回收的用例在批量里与不存在同码 404（assert_def_alive 同口径）。"""
    h, pid = await _setup(client, make_user, "d273c")
    d, a = await _mk_api_case(client, h, pid, "用例A", "/a")
    await client.post("/api/v1/api-definitions/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.post("/api/v1/api-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"]]}, headers=h)
    assert r.status_code == 404 and r.json()["details"]["case_ids"] == [a["id"]], r.text


async def test_api_case_batch_restore_dataset_missing_409(client, make_user) -> None:
    """回收期间数据集被删 → 恢复 409 dataset_missing 整批不动（R82 单条口径搬进批量）。"""
    h, pid = await _setup(client, make_user, "d273d")
    ds = (await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "将被删的集", "columns": ["k"], "rows": [["v"]]},
        headers=h)).json()
    d = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "def_ds", "method": "GET", "path": "/d",
        "request": REQ}, headers=h)).json()
    a = (await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": d["id"], "name": "绑集用例",
        "dataset_id": ds["id"]}, headers=h)).json()

    assert (await client.post("/api/v1/api-cases/" + a["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/datasets/" + ds["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200

    r = await client.post("/api/v1/api-cases/batch-restore",
                          json={"project_id": pid, "case_ids": [a["id"]]}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "dataset_missing", r.text
    tr = await client.get("/api/v1/api-cases", params={"project_id": pid,
                          "definition_id": d["id"], "recycled": "true"}, headers=h)
    assert {x["name"] for x in tr.json()["items"]} == {"绑集用例"}


# ══════════ ui-cases ══════════

async def test_ui_case_batch_delete_and_restore(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d273e")
    a = await _mk_ui_case(client, h, pid, "UI甲")
    b = await _mk_ui_case(client, h, pid, "UI乙")

    r = await client.post("/api/v1/ui-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    assert await _names(client, h, pid, "/api/v1/ui-cases", True) == {"UI甲", "UI乙"}
    assert await _names(client, h, pid, "/api/v1/ui-cases") == set()

    rs = await client.post("/api/v1/ui-cases/batch-restore",
                           json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert rs.status_code == 200, rs.text
    assert await _names(client, h, pid, "/api/v1/ui-cases") == {"UI甲", "UI乙"}

    # 重复 id 与不在回收站：各自 422/404，一行不动
    r = await client.post("/api/v1/ui-cases/batch-restore",
                          json={"project_id": pid, "case_ids": [a["id"], a["id"]]}, headers=h)
    assert r.status_code == 422, r.text
    # 先回收 A，再混入不存在的 id → 404 只列 no-such，A 仍在回收站
    assert (await client.post("/api/v1/ui-cases/" + a["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r = await client.post("/api/v1/ui-cases/batch-restore",
                          json={"project_id": pid, "case_ids": [a["id"], "no-such"]}, headers=h)
    assert r.status_code == 404 and r.json()["details"]["case_ids"] == ["no-such"], r.text
    assert await _names(client, h, pid, "/api/v1/ui-cases", True) == {"UI甲"}


async def test_ui_case_batch_delete_blocked_by_scenario(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d273f")
    a = await _mk_ui_case(client, h, pid, "UI甲")
    b = await _mk_ui_case(client, h, pid, "UI乙")
    await _mk_scene(client, h, pid, b["id"], "ui_case", "引用UI场景")

    r = await client.post("/api/v1/ui-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "referenced_by_scenario", r.text
    assert [x["name"] for x in r.json()["details"]["blocked"]] == ["UI乙"]
    assert await _names(client, h, pid, "/api/v1/ui-cases") == {"UI甲", "UI乙"}


# 注：ui/adb 的批量恢复里保留了「回收期间名字被占 → 409」检查（与单条 restore 同口径），
# 但 uq_ui_case_project_name / uq_adb_case_project_name 覆盖所有状态行，创建与改名
# 又都会先拦回收站重名，这条分支只可能是迁移/手工改库留下的存量脏数据，正常 API 造不出来。
# 不为它编造绕约束的测试——那测的是 UPDATE 绕不过唯一键，不是业务契约。


# ══════════ adb-cases ══════════

async def test_adb_case_batch_delete_and_restore(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d273h")
    a = await _mk_adb_case(client, h, pid, "ADB甲")
    b = await _mk_adb_case(client, h, pid, "ADB乙")

    r = await client.post("/api/v1/adb-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert r.status_code == 200, r.text
    assert await _names(client, h, pid, "/api/v1/adb-cases", True) == {"ADB甲", "ADB乙"}

    rs = await client.post("/api/v1/adb-cases/batch-restore",
                           json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert rs.status_code == 200, rs.text
    assert await _names(client, h, pid, "/api/v1/adb-cases") == {"ADB甲", "ADB乙"}


async def test_adb_case_batch_delete_blocked_by_scenario(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d273i")
    a = await _mk_adb_case(client, h, pid, "ADB甲")
    b = await _mk_adb_case(client, h, pid, "ADB乙")
    await _mk_scene(client, h, pid, b["id"], "adb_case", "引用ADB场景")

    r = await client.post("/api/v1/adb-cases/batch-delete",
                          json={"project_id": pid, "case_ids": [a["id"], b["id"]]}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "referenced_by_scenario", r.text
    assert [x["name"] for x in r.json()["details"]["blocked"]] == ["ADB乙"]
    assert await _names(client, h, pid, "/api/v1/adb-cases") == {"ADB甲", "ADB乙"}
