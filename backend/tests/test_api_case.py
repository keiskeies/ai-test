"""T10 接口用例：继承定义 + 按键覆盖 + 数据集首行变量 + 回收站（§4.4/§7.5）。"""
from __future__ import annotations

import json

import httpx
from fastapi import FastAPI


def _make_target():
    app = FastAPI()

    @app.api_route("/{tail:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def any_path(tail: str):
        return {"path": "/" + tail}

    return app


TARGET = _make_target()


def _inject():
    from app.modules.api_test import services as svc

    svc.set_debug_transport(lambda: httpx.ASGITransport(app=TARGET))


def _reset():
    from app.modules.api_test import services as svc

    svc.set_debug_transport(None)


async def _setup(client, make_user, tag):
    boss, hb = await make_user("c10boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "p10" + tag}, headers=hb)
    pid = r.json()["id"]
    await client.post("/api/v1/envs/global-config", json={"project_id": pid, "scope_type": "VAR",
                             "items": [["base_url", "http://target"]]}, headers=hb)
    return boss, hb, pid


async def _mkdef(client, h, pid, name="查询订单", url="${base_url}/order"):
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": "/order",
        "request": {"method": "GET", "url": url,
                    "assertions": [{"type": "status_code", "expected": 200}]}}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mkcase(client, h, pid, did, name="默认用例", **kw):
    body = {"project_id": pid, "definition_id": did, "name": name}
    body.update(kw)
    r = await client.post("/api/v1/api-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_case_crud_and_inherit(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    d = await _mkdef(client, h, pid)
    c = await _mkcase(client, h, pid, d["id"])
    assert c["priority"] == "P2" and c["request"] is None
    eff = c["effective_request"]
    assert eff["url"] == "${base_url}/order" and eff["method"] == "GET"
    assert len(eff["assertions"]) == 1
    c2 = await _mkcase(client, h, pid, d["id"], name="详情用例",
                       request={"url": "${base_url}/order/1"},
                       assertions=[{"type": "body_contains", "expected": "order"}])
    e2 = c2["effective_request"]
    assert e2["url"] == "${base_url}/order/1"
    assert len(e2["assertions"]) == 2
    r = await client.get("/api/v1/api-cases", params={"project_id": pid, "definition_id": d["id"]}, headers=h)
    assert {x["name"] for x in r.json()["items"]} == {"默认用例", "详情用例"}
    r2 = await client.patch("/api/v1/api-cases/" + c2["id"], json={
        "project_id": pid, "case_id": c2["id"], "priority": "P0",
        "request": {"params": [["id", "1"]]}}, headers=h)
    assert r2.status_code == 200 and r2.json()["priority"] == "P0"
    assert r2.json()["effective_request"]["params"] == [["id", "1"]]
    assert r2.json()["effective_request"]["url"] == "${base_url}/order/1"


async def test_case_debug_overlay(client, make_user) -> None:
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "B")
        d = await _mkdef(client, h, pid)
        c = await _mkcase(client, h, pid, d["id"], name="详情",
                           request={"url": "${base_url}/order/42"})
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid, "case_id": c["id"]}, headers=h)
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["passed"] is True, b
        assert json.loads(b["body_text"])["path"] == "/order/42"
        r2 = await client.get("/api/v1/runs", params={"project_id": pid, "subject_id": c["id"]}, headers=h)
        assert r2.json()["items"][0]["subject_type"] == "api_case"
        assert r2.json()["items"][0]["subject_name"] == "详情"
    finally:
        _reset()


async def test_case_debug_dataset_first_row(client, make_user) -> None:
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "C")
        d = await _mkdef(client, h, pid)
        ds = await client.post("/api/v1/datasets", json={
            "project_id": pid, "name": "订单参数", "columns": ["oid", "uid"],
            "rows": [["7", "u1"], ["8", "u2"]]}, headers=h)
        assert ds.status_code == 201, ds.text
        c = await _mkcase(client, h, pid, d["id"], name="数据驱动",
                           dataset_id=ds.json()["id"],
                           request={"url": "${base_url}/order/${oid}"})
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid, "case_id": c["id"]}, headers=h)
        assert r.status_code == 200, r.text
        assert json.loads(r.json()["body_text"])["path"] == "/order/7"
    finally:
        _reset()


async def test_case_soft_delete(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "D")
    d = await _mkdef(client, h, pid)
    c = await _mkcase(client, h, pid, d["id"])
    r = await client.post("/api/v1/api-cases/" + c["id"] + "/delete",
                          json={"project_id": pid, "case_id": c["id"]}, headers=h)
    assert r.status_code == 200, r.text
    r2 = await client.get("/api/v1/api-cases", params={"project_id": pid, "definition_id": d["id"]}, headers=h)
    assert r2.json()["items"] == []
    r3 = await client.get("/api/v1/api-cases", params={"project_id": pid, "definition_id": d["id"],
                                 "recycled": True}, headers=h)
    assert [x["name"] for x in r3.json()["items"]] == ["默认用例"]
    r4 = await client.post("/api/v1/api-cases/" + c["id"] + "/delete",
                          json={"project_id": pid, "case_id": c["id"]}, headers=h)
    assert r4.status_code == 404


async def test_case_private_invisible(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "E")
    d = await _mkdef(client, h, pid)
    c = await _mkcase(client, h, pid, d["id"], name="我的用例", project_public=False)
    other, ho = await make_user("c10peer")
    await client.put("/api/v1/projects/" + pid + "/members/" + other.id,
                     json={"role_code": "MEMBER"}, headers=h)
    r = await client.get("/api/v1/api-cases/" + c["id"], params={"project_id": pid}, headers=ho)
    assert r.status_code == 404
    r2 = await client.post("/api/v1/api-debug", json={"project_id": pid, "case_id": c["id"]}, headers=ho)
    assert r2.status_code == 404


async def test_case_validation(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "F")
    d = await _mkdef(client, h, pid)
    rr = await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": d["id"], "name": "坏优先级", "priority": "P9"}, headers=h)
    assert rr.status_code == 422
    r2 = await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": "nope", "name": "x"}, headers=h)
    assert r2.status_code == 404
    dft = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "草稿接口", "method": "GET", "path": "/d"}, headers=h)
    r3 = await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": dft.json()["id"], "name": "无处可去"}, headers=h)
    assert r3.status_code == 422, r3.text


async def test_case_overlay_can_reinherit(client, make_user):
    """PATCH 只按键合并会把旧覆盖留在原地；request_unset 才能恢复继承。

    UI 里把 URL 改回与接口一致 = 用户以为取消覆盖了，实际还在覆盖 → 后端要能说「删掉这个键」。
    """
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "unset")
        d = await _mkdef(client, h, pid, url="${base_url}/order")
        c = await _mkcase(client, h, pid, d["id"], request={"url": "${base_url}/order/9"})
        assert c["request"]["url"] == "${base_url}/order/9"
        r = await client.patch("/api/v1/api-cases/" + c["id"], headers=h, json={
            "project_id": pid, "request_unset": ["url"],
        })
        assert r.status_code == 200, r.text
        assert (r.json()["request"] or {}).get("url") is None
        assert r.json()["effective_request"]["url"] == "${base_url}/order"
        # 打错的键名要当场拒，静默忽略等于骗用户说恢复了继承
        bad = await client.patch("/api/v1/api-cases/" + c["id"], headers=h, json={
            "project_id": pid, "request_unset": ["nope"],
        })
        assert bad.status_code == 422, bad.text
    finally:
        _reset()


async def test_case_restore_and_purge(client, make_user) -> None:
    """回收站必须能出得来：用例有回收，就得有恢复与彻底删除。

    §4.4 写的是「软删=回收站，可恢复」；接口和模块都配了 restore/purge，
    用例只有 delete —— 手滑回收一条用例，除了改库没有任何出路。
    """
    from app.core.registry import REGISTRY

    for nm, perm in (("api_case_restore", "api:case:update"), ("api_case_purge", "api:case:delete")):
        spec = REGISTRY.get(nm)
        assert spec is not None, nm + " 未注册"
        assert spec.perm == perm, nm
    assert REGISTRY.get("api_case_restore").effect == "write"
    purge_spec = REGISTRY.get("api_case_purge")
    assert purge_spec.effect == "destructive" and purge_spec.tool is False

    _, h, pid = await _setup(client, make_user, "R")
    d = await _mkdef(client, h, pid)
    c = await _mkcase(client, h, pid, d["id"], name="已支付订单")
    assert (await client.post("/api/v1/api-cases/" + c["id"] + "/delete",
            json={"project_id": pid}, headers=h)).status_code == 200

    # 没回收的不许直接彻底删除
    d2 = await _mkdef(client, h, pid, name="另一个接口")
    live = await _mkcase(client, h, pid, d2["id"], name="活着")
    bad = await client.post("/api/v1/api-cases/" + live["id"] + "/purge",
                            json={"project_id": pid, "confirm_name": "活着"}, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "not_recycled", bad.text
    assert (await client.post("/api/v1/api-cases/" + live["id"] + "/restore",
            json={"project_id": pid}, headers=h)).status_code == 404

    # 恢复：回到正常视图，名字/覆盖层原样
    ok = await client.post("/api/v1/api-cases/" + c["id"] + "/restore",
                           json={"project_id": pid}, headers=h)
    assert ok.status_code == 200, ok.text
    assert ok.json()["name"] == "已支付订单"
    normal = await client.get("/api/v1/api-cases",
                              params={"project_id": pid, "definition_id": d["id"]}, headers=h)
    assert [x["name"] for x in normal.json()["items"]] == ["已支付订单"]

    # 再回收，然后输错名字 → 不删
    assert (await client.post("/api/v1/api-cases/" + c["id"] + "/delete",
            json={"project_id": pid}, headers=h)).status_code == 200
    wrong = await client.post("/api/v1/api-cases/" + c["id"] + "/purge",
                              json={"project_id": pid, "confirm_name": "已支付"}, headers=h)
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch", wrong.text

    good = await client.post("/api/v1/api-cases/" + c["id"] + "/purge",
                             json={"project_id": pid, "confirm_name": "已支付订单"}, headers=h)
    assert good.status_code == 200 and good.json()["ok"] is True, good.text
    assert (await client.get("/api/v1/api-cases", params={
        "project_id": pid, "definition_id": d["id"], "recycled": "true"}, headers=h)).json()["items"] == []
    assert (await client.get("/api/v1/api-cases/" + c["id"],
            params={"project_id": pid}, headers=h)).status_code == 404
    # 再删一次：对象已经不存在
    assert (await client.post("/api/v1/api-cases/" + c["id"] + "/purge",
            json={"project_id": pid, "confirm_name": "已支付订单"}, headers=h)).status_code == 404


async def test_case_purge_needs_perm(client, make_user) -> None:
    """门禁：只读成员既不能恢复也不能彻底删除。"""
    _, h, pid = await _setup(client, make_user, "S")
    d = await _mkdef(client, h, pid)
    c = await _mkcase(client, h, pid, d["id"])
    await client.post("/api/v1/api-cases/" + c["id"] + "/delete", json={"project_id": pid}, headers=h)
    ro, h_ro = await make_user("casepurge_ro")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                             json={"role_code": "READONLY"}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/api-cases/" + c["id"] + "/restore",
            json={"project_id": pid}, headers=h_ro)).status_code == 403
    assert (await client.post("/api/v1/api-cases/" + c["id"] + "/purge",
            json={"project_id": pid, "confirm_name": "默认用例"}, headers=h_ro)).status_code == 403

