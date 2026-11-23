"""D228 判据刀：接口用例独立执行（api_case_run）。

钉的契约：

1. **执行与调试是同一条链。** `api_case_run` 调 `_execute_case`，与 `api_debug(case_id)`
   共用可见性/定义回收/分层合并/数据集首行/环境变量/超时默认值——两次跑出来的
   request_snapshot 必须逐字相等；分叉成两份实现就会在变量层或超时上各自漂移。
2. **trigger 是事实口径。** HTTP 手动入口 → `manual`；定时计划重建的 ctx
   （entry="schedule"）→ `schedule`。调试入口仍是 `debug`，不在这里冒充。
3. **落 run_record：subject_type="api_case"、subject_id=用例、subject_name=用例名。**
4. **权限与可达性：** READONLY 403（没有 `api:case:run`）；MEMBER 200；用例/定义在
   回收站 404（与「不存在」同码，不泄露存在性）。
"""
from __future__ import annotations

import httpx
from fastapi import FastAPI

_BASE = "/api/v1"


def _make_target():
    app = FastAPI()

    @app.get("/ping")
    async def ping(q: str = ""):
        return {"pong": True, "q": q}

    return app


TARGET = _make_target()


def _inject() -> None:
    from app.modules.api_test import services as svc

    svc.set_debug_transport(lambda: httpx.ASGITransport(app=TARGET))


def _reset() -> None:
    from app.modules.api_test import services as svc

    svc.set_debug_transport(None)


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _definition(client, h, pid: str, name: str = "登录接口") -> str:
    r = await client.post(_BASE + "/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": "/ping",
        "request": {"method": "GET", "url": "http://target/ping",
                    "params": [["q", "hi"]],
                    "assertions": [{"type": "status_code", "expected": 200},
                                   {"type": "json_path_equals", "path": "$.pong", "expected": True}]},
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _case(client, h, pid: str, did: str, name: str = "登录接口用例") -> str:
    r = await client.post(_BASE + "/api-cases", json={
        "project_id": pid, "definition_id": did, "name": name,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _seed(client, h, pid: str) -> tuple[str, str]:
    did = await _definition(client, h, pid)
    return did, await _case(client, h, pid, did)


async def test_run_builds_run_record_and_shares_chain_with_debug(
    client, session, make_user,
) -> None:
    """独立执行落 api_case run；与调试共用链 → 请求快照逐字相等。"""
    _inject()
    try:
        _, h = await make_user("d228a", admin=True)
        pid = await _proj(client, h, "D228执行")
        _, cid = await _seed(client, h, pid)

        r = await client.post(_BASE + f"/api-cases/{cid}/run",
                              json={"project_id": pid, "case_id": cid}, headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] and body["passed"] and body["status"] == 200 and body["run_id"]
        run_id = body["run_id"]

        rows = (await client.get(_BASE + "/runs", params={
            "project_id": pid, "subject_id": cid}, headers=h)).json()["items"]
        assert len(rows) == 1
        assert rows[0]["trigger"] == "manual"
        assert rows[0]["subject_type"] == "api_case"
        assert rows[0]["subject_name"] == "登录接口用例"
        assert rows[0]["status"] == "passed"

        # 调试同一用例：链必须是同一条（可见性→定义→合并→环境→发送），只有 trigger 不同
        d = await client.post(_BASE + "/api-debug",
                              json={"project_id": pid, "case_id": cid}, headers=h)
        assert d.status_code == 200, d.text
        assert d.json()["passed"] is True
        dbg_id = d.json()["run_id"]

        r1 = (await client.get(_BASE + f"/runs/{run_id}", params={"project_id": pid},
                               headers=h)).json()
        r2 = (await client.get(_BASE + f"/runs/{dbg_id}", params={"project_id": pid},
                               headers=h)).json()
        assert r1["subject_type"] == r2["subject_type"] == "api_case"
        assert r1["trigger"] == "manual" and r2["trigger"] == "debug"
        assert r1["request_snapshot"] == r2["request_snapshot"]
        # Q=hi 的查询参数与两条断言都来自同一条合并链
        assert r1["request_snapshot"]["params"] == [["q", "hi"]]
        assert len(r1["request_snapshot"]["assertions"]) == 2
    finally:
        _reset()


async def test_schedule_entry_records_schedule_trigger(
    client, session, make_user,
) -> None:
    """定时计划重建的 ctx（entry="schedule"）→ trigger=schedule，不冒充手动。"""
    _inject()
    try:
        user, h = await make_user("d228b", admin=True)
        pid = await _proj(client, h, "D228定时")
        _, cid = await _seed(client, h, pid)

        from app.core.registry import REGISTRY
        from app.core.service import ctx_from_actor

        spec = REGISTRY.get("api_case_run")
        assert spec is not None, "api_case_run 未注册"
        ctx = ctx_from_actor({"user_id": user.id, "entry": "schedule", "perms": ["*"],
                              "is_system_admin": True}, session)
        out = await spec.handler(
            spec.model.model_validate({"project_id": pid, "case_id": cid}), ctx)
        assert out.passed is True

        rows = (await client.get(_BASE + "/runs", params={
            "project_id": pid, "subject_id": cid, "trigger": "schedule"}, headers=h)).json()["items"]
        assert len(rows) == 1
        assert rows[0]["subject_type"] == "api_case"
        assert rows[0]["id"] == out.run_id
    finally:
        _reset()


async def test_readonly_forbidden_member_allowed(client, session, make_user) -> None:
    """没有 api:case:run 的角色 403；MEMBER 有该位照跑。"""
    from app.modules.iam.models import ProjectMember

    _inject()
    try:
        _, hroot = await make_user("d228c_root", admin=True)
        ro, hro = await make_user("d228c_ro")
        mem, hmem = await make_user("d228c_mem")
        pid = await _proj(client, hroot, "D228权限")
        session.add_all([
            ProjectMember(project_id=pid, user_id=ro.id, role_code="READONLY"),
            ProjectMember(project_id=pid, user_id=mem.id, role_code="MEMBER"),
        ])
        await session.commit()
        _, cid = await _seed(client, hroot, pid)

        r = await client.post(_BASE + f"/api-cases/{cid}/run",
                              json={"project_id": pid, "case_id": cid}, headers=hro)
        assert r.status_code == 403, r.text

        r = await client.post(_BASE + f"/api-cases/{cid}/run",
                              json={"project_id": pid, "case_id": cid}, headers=hmem)
        assert r.status_code == 200, r.text
        assert r.json()["passed"] is True
    finally:
        _reset()


async def test_recycled_case_and_definition_are_404(client, session, make_user) -> None:
    """用例/定义在回收站：与「不存在」同码 404，且一条 run 都不落。"""
    _inject()
    try:
        _, h = await make_user("d228d", admin=True)
        pid = await _proj(client, h, "D228回收")

        # 用例回收
        did, cid = await _seed(client, h, pid)
        r = await client.post(_BASE + f"/api-cases/{cid}/delete",
                              json={"project_id": pid, "case_id": cid}, headers=h)
        assert r.status_code == 200, r.text
        r = await client.post(_BASE + f"/api-cases/{cid}/run",
                              json={"project_id": pid, "case_id": cid}, headers=h)
        assert r.status_code == 404, r.text

        # 另一条用例，定义回收 → 用例跟着不可达
        did2 = await _definition(client, h, pid, name="另一个接口")
        cid2 = await _case(client, h, pid, did2, name="另一个用例")
        r = await client.post(_BASE + f"/api-definitions/{did2}/delete",
                              json={"project_id": pid, "definition_id": did2}, headers=h)
        assert r.status_code == 200, r.text
        r = await client.post(_BASE + f"/api-cases/{cid2}/run",
                              json={"project_id": pid, "case_id": cid2}, headers=h)
        assert r.status_code == 404, r.text

        rows = (await client.get(_BASE + "/runs", params={
            "project_id": pid, "subject_type": "api_case"}, headers=h)).json()["items"]
        assert rows == [], "被拦下的执行不许留 run_record"
    finally:
        _reset()
