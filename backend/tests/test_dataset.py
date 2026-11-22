"""T10 数据集：结构化表格 + 行宽校验 + 引用保护（§4.4）。"""
from __future__ import annotations


async def _setup(client, make_user, tag):
    boss, hb = await make_user("ds10boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "pd10" + tag}, headers=hb)
    return boss, hb, r.json()["id"]


async def test_dataset_crud(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    r = await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "登录账号", "columns": ["user", "pwd"],
        "rows": [["a", "1"], ["b", "2"]]}, headers=h)
    assert r.status_code == 201, r.text
    did = r.json()["id"]
    assert r.json()["row_count"] == 2
    r2 = await client.get("/api/v1/datasets", params={"project_id": pid}, headers=h)
    assert [x["name"] for x in r2.json()["items"]] == ["登录账号"]
    r3 = await client.patch("/api/v1/datasets/" + did, json={
        "project_id": pid, "dataset_id": did,
        "columns": ["user", "pwd", "role"],
        "rows": [["a", "1", "admin"]]}, headers=h)
    assert r3.status_code == 200 and len(r3.json()["rows"]) == 1
    r4 = await client.post("/api/v1/datasets/" + did + "/delete",
                           json={"project_id": pid, "dataset_id": did}, headers=h)
    assert r4.status_code == 200
    r5 = await client.get("/api/v1/datasets", params={"project_id": pid}, headers=h)
    assert r5.json()["items"] == []


async def test_dataset_row_width_and_dup(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "B")
    r = await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "坏表", "columns": ["a", "b"],
        "rows": [["1", "2"], ["3"]]}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "validation_failed"
    assert r.json()["details"]["row"] == 1
    await client.post("/api/v1/datasets", json={"project_id": pid, "name": "重名",
                          "columns": ["a"], "rows": []}, headers=h)
    r2 = await client.post("/api/v1/datasets", json={"project_id": pid, "name": "重名",
                           "columns": ["a"], "rows": []}, headers=h)
    assert r2.status_code == 409
    r3 = await client.post("/api/v1/datasets", json={"project_id": pid, "name": "空列",
                           "columns": [""], "rows": []}, headers=h)
    assert r3.status_code == 422


async def test_dataset_referenced_delete_guard(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "C")
    rd = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "接口", "method": "GET", "path": "/x",
        "request": {"method": "GET", "url": "http://t/x"}}, headers=h)
    did = rd.json()["id"]
    ds = await client.post("/api/v1/datasets", json={"project_id": pid, "name": "被引用",
                             "columns": ["a"], "rows": [["1"]]}, headers=h)
    dsid = ds.json()["id"]
    await client.post("/api/v1/api-cases", json={"project_id": pid, "definition_id": did,
                          "name": "绑集用例", "dataset_id": dsid}, headers=h)
    r = await client.post("/api/v1/datasets/" + dsid + "/delete",
                          json={"project_id": pid, "dataset_id": dsid}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "conflict"
    rc = await client.get("/api/v1/api-cases", params={"project_id": pid, "definition_id": did}, headers=h)
    cid = rc.json()["items"][0]["id"]
    await client.post("/api/v1/api-cases/" + cid + "/delete",
                      json={"project_id": pid, "case_id": cid}, headers=h)
    r2 = await client.post("/api/v1/datasets/" + dsid + "/delete",
                           json={"project_id": pid, "dataset_id": dsid}, headers=h)
    assert r2.status_code == 200, r2.text


async def test_dataset_cross_project(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "D")
    _, h2, pid2 = await _setup(client, make_user, "D2")
    ds = await client.post("/api/v1/datasets", json={"project_id": pid, "name": "跨项目",
                             "columns": ["a"], "rows": []}, headers=h)
    dsid = ds.json()["id"]
    r = await client.patch("/api/v1/datasets/" + dsid, json={
        "project_id": pid2, "dataset_id": dsid, "columns": ["z"], "rows": []}, headers=h2)
    assert r.status_code == 404

async def test_dataset_list_reports_used_by(client, make_user) -> None:
    """列表页要显示「被几条用例引用」：否则删除前只能撞 409 才知道，回收也无从判断后果。"""
    _, h, pid = await _setup(client, make_user, "UB")
    d = await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "账号", "columns": ["user"], "rows": [["a"]]}, headers=h)
    did = d.json()["id"]
    assert d.json()["used_by"] == 0
    df = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "登录", "method": "POST", "path": "/login",
        "request": {"method": "POST", "url": "http://x/login"}}, headers=h)
    didf = df.json()["id"]
    c1 = (await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": didf, "name": "c1", "dataset_id": did}, headers=h)).json()["id"]
    await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": didf, "name": "c2", "dataset_id": did}, headers=h)
    lst = (await client.get("/api/v1/datasets", params={"project_id": pid}, headers=h)).json()["items"]
    assert lst[0]["used_by"] == 2, lst
    # 回收中的用例不算引用（与 data_set_delete 口径一致：status == "normal"）
    await client.post("/api/v1/api-cases/" + c1 + "/delete", json={"project_id": pid}, headers=h)
    lst2 = (await client.get("/api/v1/datasets", params={"project_id": pid}, headers=h)).json()["items"]
    assert lst2[0]["used_by"] == 1, lst2


async def test_restore_blocked_when_dataset_gone(client, make_user) -> None:
    """恢复期校验（R82 裁定）：回收期间数据集被硬删 → 恢复用例必须 409 点名缺失数据集。

    旧行为：恢复成功 → 用例在列表里看着健康，执行期 resolve 才 404「数据集不存在」，
    永远跑不动。不许静默清绑（dataset_id 悄悄变 null 是降级：用户以为绑着）。
    """
    _, h, pid = await _setup(client, make_user, "RG")
    rd = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "接口", "method": "GET", "path": "/x",
        "request": {"method": "GET", "url": "http://t/x"}}, headers=h)
    did = rd.json()["id"]
    ds = await client.post("/api/v1/datasets", json={"project_id": pid, "name": "将被删集",
                             "columns": ["a"], "rows": [["1"]]}, headers=h)
    dsid = ds.json()["id"]
    c = await client.post("/api/v1/api-cases", json={"project_id": pid, "definition_id": did,
                             "name": "绑集用例", "dataset_id": dsid}, headers=h)
    cid = c.json()["id"]
    await client.post("/api/v1/api-cases/" + cid + "/delete",
                      json={"project_id": pid, "case_id": cid}, headers=h)
    # 无场景扣押的回收用例不拦数据集删除（test_dataset_referenced_delete_guard 钉着的语义）
    assert (await client.post("/api/v1/datasets/" + dsid + "/delete",
                              json={"project_id": pid, "dataset_id": dsid},
                              headers=h)).status_code == 200
    r = await client.post("/api/v1/api-cases/" + cid + "/restore",
                          json={"project_id": pid, "case_id": cid}, headers=h)
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "dataset_missing", r.json()
    assert "将被删集" in r.json()["message"] or dsid in str(r.json()["details"]), \
        "409 必须点名缺失的数据集，用户才知道去解绑"
    # 修复路径敞开：回收态用例解绑（dataset_set=true + null），再恢复就成功
    u = await client.patch("/api/v1/api-cases/" + cid, json={
        "project_id": pid, "case_id": cid, "dataset_set": True, "dataset_id": None}, headers=h)
    assert u.status_code == 200, u.text
    r2 = await client.post("/api/v1/api-cases/" + cid + "/restore",
                           json={"project_id": pid, "case_id": cid}, headers=h)
    assert r2.status_code == 200, r2.text
    assert r2.json()["dataset_id"] is None


async def test_restore_with_live_dataset_unaffected(client, make_user) -> None:
    """数据集还活着 → 恢复照旧成功且绑带保留（本修复不许误伤常规回收-恢复）。"""
    _, h, pid = await _setup(client, make_user, "RG2")
    rd = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "接口2", "method": "GET", "path": "/y",
        "request": {"method": "GET", "url": "http://t/y"}}, headers=h)
    did = rd.json()["id"]
    ds = await client.post("/api/v1/datasets", json={"project_id": pid, "name": "活集",
                             "columns": ["a"], "rows": [["1"]]}, headers=h)
    dsid = ds.json()["id"]
    c = await client.post("/api/v1/api-cases", json={"project_id": pid, "definition_id": did,
                             "name": "好用例", "dataset_id": dsid}, headers=h)
    cid = c.json()["id"]
    await client.post("/api/v1/api-cases/" + cid + "/delete",
                      json={"project_id": pid, "case_id": cid}, headers=h)
    r = await client.post("/api/v1/api-cases/" + cid + "/restore",
                          json={"project_id": pid, "case_id": cid}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["dataset_id"] == dsid
