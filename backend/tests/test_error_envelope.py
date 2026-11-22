"""错误信封（§12.1）：字段校验失败必须 422 + validation_failed，任何路由都一样。

带路径参数的写路由用 create_model 重建 body 模型（路径参数以 path 为准），
而 create_model 不继承 field_validator —— 校验因此晚到，在 service.py 里抛；
没有 ValidationError handler 时它被兜底 handler 吞成 500「服务内部错误」。
"""
from __future__ import annotations


async def _mkdef(client, h, pid):
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "查单", "method": "GET", "path": "/order",
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_field_validator_on_path_route_is_422(client, make_user):
    _, uh = await make_user("env1")
    pid = (await client.post("/api/v1/projects", json={"name": "p-env"}, headers=uh)).json()["id"]
    did = await _mkdef(client, uh, pid)
    # PATCH /api-definitions/{id}：路径参数路由，body 模型是重建的
    r = await client.patch("/api/v1/api-definitions/" + did, headers=uh, json={
        "project_id": pid, "method": "FETCH",  # 不在 Literal 白名单内
    })
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "validation_failed", body
    assert body["details"]["errors"], body


async def test_query_param_validation_still_422(client, make_user):
    _, uh = await make_user("env2")
    pid = (await client.post("/api/v1/projects", json={"name": "p-env2"}, headers=uh)).json()["id"]
    r = await client.get("/api/v1/api-definitions?project_id=" + pid + "&size=9999", headers=uh)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_failed", r.json()
