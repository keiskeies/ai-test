"""T8 单接口调试：真实执行核 + env 解析 + 运行记录落库（§13 调试闭环）。"""
from __future__ import annotations

import json

import httpx
from fastapi import FastAPI, Request


def _make_target():
    app = FastAPI()

    @app.get("/ping")
    async def ping(q: str = ""):
        return {"pong": True, "q": q}

    @app.post("/echo")
    async def echo(request: Request):
        import json as _j
        raw = await request.body()
        return {"auth": request.headers.get("authorization"), "body": _j.loads(raw or b"{}")}

    @app.post("/form")
    async def form(request: Request):
        # 正对照靶：手工 parse_qsl 读 urlencoded 正文（request.form() 要 python-multipart，
        # venv 没装；这里同时钉 content-type，证明发出去的真是 form-urlencoded）
        from urllib.parse import parse_qsl
        raw = (await request.body()).decode("utf-8")
        return {"content_type": request.headers.get("content-type"), "form": dict(parse_qsl(raw))}

    return app


TARGET = _make_target()


def _inject():
    from app.modules.api_test import services as svc

    svc.set_debug_transport(lambda: httpx.ASGITransport(app=TARGET))


def _reset():
    from app.modules.api_test import services as svc

    svc.set_debug_transport(None)


async def _setup(client, make_user, tag):
    boss, hb = await make_user("dgb8boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "p8" + tag}, headers=hb)
    return boss, hb, r.json()["id"]


async def test_debug_inline_and_run_record(client, session, make_user) -> None:
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "A")
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid,
            "request": {"method": "GET", "url": "http://target/ping", "params": [["q", "hi"]],
                        "assertions": [{"type": "status_code", "expected": 200},
                                       {"type": "json_path_equals", "path": "$.pong", "expected": True}]}},
            headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] and body["passed"] and body["status"] == 200
        assert [a["passed"] for a in body["assertions"]] == [True, True]
        assert body["run_id"]
        r2 = await client.get("/api/v1/runs", params={"project_id": pid, "trigger": "debug"}, headers=h)
        items = r2.json()["items"]
        assert len(items) == 1 and items[0]["status"] == "passed"
        assert items[0]["subject_type"] == "inline"
        r3 = await client.post("/api/v1/api-debug", json={
            "project_id": pid,
            "request": {"method": "GET", "url": "http://target/ping",
                        "assertions": [{"type": "status_code", "expected": 500}]}}, headers=h)
        assert r3.json()["passed"] is False and r3.json()["ok"] is True
        r4 = await client.get("/api/v1/runs", params={"project_id": pid, "status": "failed"}, headers=h)
        assert len(r4.json()["items"]) == 1
    finally:
        _reset()


async def test_debug_definition_with_env_vars(client, session, make_user) -> None:
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "B")
        await client.post("/api/v1/envs/global-config", json={"project_id": pid, "scope_type": "VAR",
                                 "items": [["base_url", "http://target"]]}, headers=h)
        await client.post("/api/v1/envs/global-config", json={"project_id": pid, "scope_type": "HEADER",
                                 "items": [["Authorization", "Bearer ${tok}"]]}, headers=h)
        r = await client.post("/api/v1/envs", json={"project_id": pid, "name": "预发",
                                        "config": {"vars": [["tok", "T1"]]}}, headers=h)
        eid = r.json()["id"]
        rd = await client.post("/api/v1/api-definitions", json={
            "project_id": pid, "name": "回声", "method": "POST", "path": "/echo",
            "request": {"method": "POST", "url": "${base_url}/echo",
                        "body": {"type": "json", "content": json.dumps({"a": 1})},
                        "assertions": [{"type": "json_path_equals", "path": "$.auth", "expected": "Bearer T1"}]}},
            headers=h)
        did = rd.json()["id"]
        r2 = await client.post("/api/v1/api-debug",
                             json={"project_id": pid, "definition_id": did, "env_id": eid}, headers=h)
        assert r2.status_code == 200, r2.text
        b = r2.json()
        assert b["passed"] is True, b["assertions"]
        import json as _j
        assert _j.loads(b["body_text"])["body"] == {"a": 1}
        assert b["env_name"] == "预发"
        r3 = await client.get("/api/v1/runs", params={"project_id": pid, "subject_id": did}, headers=h)
        assert r3.json()["items"][0]["subject_name"] == "回声"
        assert r3.json()["items"][0]["env_name"] == "预发"
    finally:
        _reset()


async def test_debug_missing_var_422(client, make_user) -> None:
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "C")
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid,
            "request": {"method": "GET", "url": "http://target/ping",
                        "headers": [["X-T", "${token}"]]}}, headers=h)
        assert r.status_code == 422, r.text
        assert r.json()["code"] == "validation_error" and r.json()["details"]["var"] == "token"
    finally:
        _reset()


async def test_debug_validation_and_cross_project(client, make_user) -> None:
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "D")
        _, h2, pid2 = await _setup(client, make_user, "D2")
        r0 = await client.post("/api/v1/api-debug", json={"project_id": pid}, headers=h)
        assert r0.status_code == 422
        rd = await client.post("/api/v1/api-definitions", json={
            "project_id": pid, "name": "跨项目", "method": "GET", "path": "/x",
            "request": {"method": "GET", "url": "http://target/ping"}}, headers=h)
        did = rd.json()["id"]
        r = await client.post("/api/v1/api-debug",
                             json={"project_id": pid2, "definition_id": did}, headers=h2)
        assert r.status_code == 404, r.text
        r2 = await client.post("/api/v1/api-debug", json={
            "project_id": pid, "definition_id": did,
            "request": {"method": "GET", "url": "http://target/ping"}}, headers=h)
        assert r2.status_code == 422
    finally:
        _reset()


async def test_debug_rejected_in_plan_mode(client, session, make_user) -> None:
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher

    _, h, pid = await _setup(client, make_user, "E")
    disp = ToolDispatcher(session)
    ctx = ServiceCtx(entry="agent", user_id="u1", perms={"*"}, db=session)
    r = await disp.call("api_debug", {"project_id": pid,
                           "request": {"method": "GET", "url": "http://target/ping"}},
                        ctx, mode="PLAN", grants=set())
    assert r.ok is False and "只读" in (r.error or "")


# —— 第 42 轮：run_api 抛的 ValueError 族（D172 form 垃圾 / RequestAuthError）⇒ 422 不是裸 500 ——


async def test_debug_form_garbage_body_422_human_message(client, make_user) -> None:
    """D172 的 ValueError 在调试入口必须落 422 validation_error，人话原样（D157 纪律），
    不落裸 500，也不留 run 记录（请求根本没发出去）。"""
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "V1")
        # 与 D172 执行核钉同款垃圾（"&&"：parse_qsl 连空白对都凑不出）；注意带字无 '='
        # 的串在 keep_blank_values 下会成空白对、不抛——垃圾必须选真解析不出的形状
        garbage = "&&"
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid,
            "request": {"method": "POST", "url": "http://target/form",
                        "body": {"type": "form", "content": garbage}}}, headers=h)
        assert r.status_code == 422, r.text
        body = r.json()
        assert body["code"] == "validation_error", body
        assert body["message"] == "form body 无法解析（既不是 JSON 也不是 k=v&k=v）: " + garbage, \
            "str(e) 已是人话，必须原样透传，不许包一层「服务内部错误」"
        runs = (await client.get("/api/v1/runs", params={"project_id": pid}, headers=h)).json()["items"]
        assert runs == [], "没发出去的请求不该留运行记录"
    finally:
        _reset()


async def test_debug_invalid_auth_422(client, make_user) -> None:
    """RequestAuthError（ValueError 子类）同路：bearer 缺 token 过了写入层 schema
    （type 合法、config 是 dict），执行层 build_auth_kwargs 点名拒 ⇒ 422 人话。"""
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "V2")
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid,
            "request": {"method": "GET", "url": "http://target/ping",
                        "auth": {"type": "bearer", "config": {}}}}, headers=h)
        assert r.status_code == 422, r.text
        body = r.json()
        assert body["code"] == "validation_error", body
        assert "auth.type=bearer" in body["message"] and "token" in body["message"], body["message"]
    finally:
        _reset()


async def test_debug_valid_form_still_200(client, make_user) -> None:
    """正对照：合法 k=v&k=v form 调试照常 200 且真发出 form-urlencoded——
    ValueError 接捕不许把合法 form 一并焊死。"""
    _inject()
    try:
        _, h, pid = await _setup(client, make_user, "V3")
        r = await client.post("/api/v1/api-debug", json={
            "project_id": pid,
            "request": {"method": "POST", "url": "http://target/form",
                        "body": {"type": "form", "content": "a=1&b=2"},
                        "assertions": [{"type": "json_path_equals", "path": "$.form.a",
                                        "expected": "1"}]}}, headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True and body["status"] == 200 and body["passed"] is True, body
        echoed = json.loads(body["body_text"])
        assert echoed["form"] == {"a": "1", "b": "2"}
        assert echoed["content_type"] == "application/x-www-form-urlencoded"
    finally:
        _reset()