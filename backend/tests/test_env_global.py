"""T6：项目级全局配置 + resolve_env 分层合并（§4.2/§7.5 优先级链的全局/环境两层）。"""
from __future__ import annotations


async def _boss(client, make_user):
    u, h = await make_user("env6boss")
    r = await client.post("/api/v1/projects", json={"name": "p6"}, headers=h)
    return u, h, r.json()["id"]


async def _set_gcfg(client, h, pid, scope, items):
    return await client.post("/api/v1/envs/global-config",
                           json={"project_id": pid, "scope_type": scope, "items": items}, headers=h)


async def test_global_config_roundtrip(client, make_user) -> None:
    _, h, pid = await _boss(client, make_user)
    r = await _set_gcfg(client, h, pid, "VAR", [["base_url", "http://A"]])
    assert r.status_code == 200, r.text
    r2 = await client.get("/api/v1/envs/global-config", params={"project_id": pid}, headers=h)
    assert r2.status_code == 200
    scopes = r2.json()["scopes"]
    assert scopes["VAR"] == [["base_url", "http://A"]]
    assert scopes["ASSERT"] == [] and scopes["EXTRACT"] == []
    # 整段覆盖语义（不做增量合并——UI 一次提交整表）
    await _set_gcfg(client, h, pid, "VAR", [["base_url", "http://B"], ["token", "tk"]])
    r3 = await client.get("/api/v1/envs/global-config", params={"project_id": pid}, headers=h)
    assert r3.json()["scopes"]["VAR"] == [["base_url", "http://B"], ["token", "tk"]]


async def test_resolve_env_layering(client, session, make_user) -> None:
    from app.modules.env.services import resolve_env

    _, h, pid = await _boss(client, make_user)
    await _set_gcfg(client, h, pid, "VAR", [["base_url", "http://GLOBAL"], ["shared", "g"]])
    await _set_gcfg(client, h, pid, "HEADER", [["X-Source", "global"], ["X-Both", "g"]])
    r = await client.post("/api/v1/envs", json={"project_id": pid, "name": "e6",
                                "config": {"vars": [["base_url", "http://ENV"], ["local", "l"]],
                                           "headers": [["X-Both", "env"], ["X-Env", "1"]]}}, headers=h)
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    vars_, headers_, timeout_ = await resolve_env(session, project_id=pid, env_id=eid)
    assert vars_ == {"base_url": "http://ENV", "shared": "g", "local": "l"}  # 环境覆盖全局
    keys = [k for k, _v in headers_]
    assert "X-Source" in keys and "X-Env" in keys
    both = [v for k, v in headers_ if k.lower() == "x-both"]
    assert both == ["env"]  # 大小写不敏感去重，环境层胜出
    assert timeout_ is None
    # 无环境 = 仅全局层
    vars2, headers2, _t = await resolve_env(session, project_id=pid, env_id=None)
    assert vars2 == {"base_url": "http://GLOBAL", "shared": "g"}
    assert [v for k, v in headers2 if k.lower() == "x-both"] == ["g"]


async def test_resolve_env_timeout_and_missing_env(client, session, make_user) -> None:
    import pytest

    from app.core.errors import ApiError
    from app.modules.env.services import resolve_env

    _, h, pid = await _boss(client, make_user)
    r = await client.post("/api/v1/envs", json={"project_id": pid, "name": "e6t",
                            "config": {"timeout_ms": 3500}}, headers=h)
    _, _, t = await resolve_env(session, project_id=pid, env_id=r.json()["id"])
    assert t == 3500
    # 跨项目 env_id → 与不存在同 404（不泄露存在性）
    with pytest.raises(ApiError) as e:
        await resolve_env(session, project_id=pid, env_id="00000000-0000-0000-0000-000000000000")
    assert e.value.http_status == 404


async def test_global_config_nonmember_forbidden(client, make_user) -> None:
    _, h, pid = await _boss(client, make_user)
    _, ho = await make_user("out6")
    r = await client.get("/api/v1/envs/global-config", params={"project_id": pid}, headers=ho)
    assert r.status_code == 403
    r2 = await _set_gcfg(client, ho, pid, "VAR", [])
    assert r2.status_code == 403