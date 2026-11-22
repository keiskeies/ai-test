"""草稿调试归属：编辑器里调试未保存的请求，运行记录仍记在该接口名下（列表徽标依赖此契约）。"""
from __future__ import annotations

REQ = {"method": "GET", "url": "http://127.0.0.1:9999/order/1", "body": {"type": "none"},
       "assertions": [{"type": "status_code", "expected": 200}]}


async def _setup(client, make_user, name):
    _, h = await make_user(name)
    pid = (await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)).json()["id"]
    d = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "查询订单", "method": "GET", "path": "/order/1",
        "request": REQ}, headers=h)).json()
    return h, pid, d["id"]


async def test_draft_debug_attributes_run_to_definition(client, make_user, monkeypatch) -> None:
    import httpx

    from app.modules.api_test import services as api_svc

    async def handler(request):
        return httpx.Response(200, json={"order_id": "1", "status": "PAID"})

    api_svc.set_debug_transport(lambda: httpx.MockTransport(handler))
    try:
        h, pid, did = await _setup(client, make_user, "draftdbg")
        draft = dict(REQ)
        draft["assertions"] = [{"type": "status_code", "expected": 200},
                            {"type": "body_contains", "expected": "PAID"}]  # 未保存的改动
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid, "request": draft, "subject_definition_id": did}, headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] and body["passed"] and len(body["assertions"]) == 2

        runs = (await client.get("/api/v1/runs",
                              params={"project_id": pid, "subject_id": did, "size": 1}, headers=h)).json()["items"]
        assert len(runs) == 1 and runs[0]["subject_type"] == "api_definition"
        assert runs[0]["subject_id"] == did and runs[0]["trigger"] == "debug"
        assert runs[0]["status"] == "passed" and runs[0]["status_code"] == 200
    finally:
        api_svc.set_debug_transport(None)


async def test_attribution_rules_are_honest(client, make_user) -> None:
    h, pid, did = await _setup(client, make_user, "draftdbg2")
    # 与 definition_id 同时给 → 语义重复，明确拒绝而不是静默取一个
    r = await client.post("/api/v1/api-debug", json={
        "project_id": pid, "definition_id": did, "subject_definition_id": did}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "validation_failed"
    # 归属到不存在/别项目的接口 → 404（不泄露存在性）
    r2 = await client.post("/api/v1/api-debug", json={
        "project_id": pid, "request": REQ, "subject_definition_id": "nope"}, headers=h)
    assert r2.status_code == 404

    # 回收站里的接口不能挂归属
    await client.post("/api/v1/api-definitions/" + did + "/delete", json={"project_id": pid}, headers=h)
    r3 = await client.post("/api/v1/api-debug", json={
        "project_id": pid, "request": REQ, "subject_definition_id": did}, headers=h)
    assert r3.status_code == 404

    # 纯临时请求（不指定归属）依旧可用，记为 inline
    import httpx

    from app.modules.api_test import services as api_svc

    api_svc.set_debug_transport(lambda: httpx.MockTransport(lambda request: httpx.Response(200, json={"ok": True})))
    try:
        r4 = await client.post("/api/v1/api-debug", json={"project_id": pid, "request": REQ}, headers=h)
        assert r4.status_code == 200, r4.text
        inline = (await client.get("/api/v1/runs", params={
            "project_id": pid, "subject_id": "inline"}, headers=h)).json()["items"]
        assert len(inline) == 1 and inline[0]["subject_name"] == "临时请求"
    finally:
        api_svc.set_debug_transport(None)
