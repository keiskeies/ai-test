"""D203 判据刀：平台运维登记面（服务集成 / 资源池 / 插件 / 系统信息）。

钉的契约（一条判断一条用例）：

1. **服务集成**：名称项目内唯一；token 加密落库、回显只有末 4 位、响应里没有明文键；
   token=None 保留、空串清除；base_url 必须是 http(s)；启停与删除。
2. **资源池**：容量 1..1000（0 / 1001 都 422）；名称项目内唯一；改容量与启停。
3. **插件**：config 必须是合法 JSON（建与改都校验，改失败不落半截值）；
   `loadable` 恒 False —— 登记 ≠ 装载，meta 里把这句话写明。
4. **系统信息 / 许可证**：migration_head 读的是真 alembic_version，
   社区版不设功能门（licensed=True、enforced=False）。
5. **项目隔离**：跨项目拿详情 = 404；READONLY 可读，写 403 且 details.perm 指名。
6. **表形状 = 迁移**：三张表的关键列都在库里（ORM 与迁移没漂移）。
"""

from __future__ import annotations

from sqlalchemy import text

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _integration(client, h, pid: str, name: str = "GitHub", **kw):
    body = {
        "project_id": pid,
        "kind": kw.pop("kind", "github"),
        "name": name,
        "base_url": kw.pop("base_url", "https://api.github.com"),
        **kw,
    }
    return await client.post(_BASE + "/service-integrations", json=body, headers=h)


async def _pool(client, h, pid: str, name: str = "本地池", **kw):
    return await client.post(
        _BASE + "/resource-pools", json={"project_id": pid, "name": name, **kw}, headers=h
    )


async def _plugin(client, h, pid: str, name: str = "kafka", **kw):
    return await client.post(
        _BASE + "/plugins", json={"project_id": pid, "name": name, **kw}, headers=h
    )


# ══════════ 服务集成 ══════════
async def test_integration_crud_token_masking(client, make_user) -> None:
    _, h = await make_user("d203a", admin=True)
    pid = await _proj(client, h, "D203集成")

    meta = await client.get(_BASE + "/service-integrations/meta",
                            params={"project_id": pid}, headers=h)
    assert meta.status_code == 200, meta.text
    assert meta.json()["kinds"] == ["github", "gitlab", "gitee"]

    c = await _integration(client, h, pid, token="ghp_1234567890abcd")
    assert c.status_code == 201, c.text
    body = c.json()
    iid = body["id"]
    assert body["has_token"] is True and body["token_hint"] == "****abcd"
    # 明文 token 与密文列都不许出现在响应里
    assert "token" not in body and "token_enc" not in body
    assert body["created_by"] and body["created_at"]

    # 重名 → 409（同项目）
    dup = await _integration(client, h, pid, token="x")
    assert dup.status_code == 409 and dup.json()["code"] == "conflict"

    # base_url 只收 http(s)
    bad = await _integration(client, h, pid, name="FTP", base_url="ftp://example.com")
    assert bad.status_code == 422 and bad.json()["code"] == "bad_url"

    # token=None 保留原值；空串清除
    keep = await client.patch(_BASE + f"/service-integrations/{iid}",
                              json={"project_id": pid, "description": "备注"}, headers=h)
    assert keep.status_code == 200 and keep.json()["token_hint"] == "****abcd"
    clear = await client.patch(_BASE + f"/service-integrations/{iid}",
                               json={"project_id": pid, "token": ""}, headers=h)
    assert clear.status_code == 200
    assert clear.json()["has_token"] is False and clear.json()["token_hint"] is None

    # 启停 + 列表过滤 + 关键词
    dis = await client.post(_BASE + f"/service-integrations/{iid}/status",
                            json={"project_id": pid, "integration_id": iid, "enabled": False},
                            headers=h)
    assert dis.status_code == 200 and dis.json()["enabled"] is False
    only = await client.get(_BASE + "/service-integrations",
                            params={"project_id": pid, "enabled_only": True}, headers=h)
    assert only.json()["items"] == []
    kw = await client.get(_BASE + "/service-integrations",
                          params={"project_id": pid, "keyword": "git"}, headers=h)
    assert [i["name"] for i in kw.json()["items"]] == ["GitHub"]

    # 删除后详情 404
    d = await client.post(_BASE + f"/service-integrations/{iid}/delete",
                          json={"project_id": pid, "integration_id": iid}, headers=h)
    assert d.status_code == 200 and d.json()["ok"] is True
    gone = await client.get(_BASE + f"/service-integrations/{iid}",
                            params={"project_id": pid}, headers=h)
    assert gone.status_code == 404


# ══════════ 资源池 ══════════
async def test_resource_pool_capacity_and_unique(client, make_user) -> None:
    _, h = await make_user("d203p", admin=True)
    pid = await _proj(client, h, "D203资源池")

    ok = await _pool(client, h, pid, capacity=3)
    assert ok.status_code == 201, ok.text
    pool_id = ok.json()["id"]
    assert ok.json()["capacity"] == 3 and ok.json()["kind"] == "local"

    for cap in (0, 1001):
        r = await _pool(client, h, pid, name=f"坏容量{cap}", capacity=cap)
        assert r.status_code == 422, (cap, r.text)
    bad_kind = await _pool(client, h, pid, name="坏类型", kind="k8s")
    assert bad_kind.status_code == 422

    dup = await _pool(client, h, pid, capacity=1)
    assert dup.status_code == 409 and dup.json()["code"] == "conflict"

    up = await client.patch(_BASE + f"/resource-pools/{pool_id}",
                            json={"project_id": pid, "capacity": 8, "enabled": False},
                            headers=h)
    assert up.status_code == 200
    assert up.json()["capacity"] == 8 and up.json()["enabled"] is False

    lst = await client.get(_BASE + "/resource-pools",
                           params={"project_id": pid, "enabled_only": True}, headers=h)
    assert lst.json()["items"] == []
    assert (await client.get(_BASE + f"/resource-pools/{pool_id}",
                             params={"project_id": pid}, headers=h)).json()["capacity"] == 8

    rm = await client.post(_BASE + f"/resource-pools/{pool_id}/delete",
                           json={"project_id": pid, "pool_id": pool_id}, headers=h)
    assert rm.status_code == 200
    assert (await client.post(_BASE + f"/resource-pools/{pool_id}/delete",
                              json={"project_id": pid, "pool_id": pool_id},
                              headers=h)).status_code == 404


# ══════════ 插件 ══════════
async def test_plugin_json_validation_and_loadable(client, make_user) -> None:
    _, h = await make_user("d203g", admin=True)
    pid = await _proj(client, h, "D203插件")

    meta = await client.get(_BASE + "/plugins/meta", params={"project_id": pid}, headers=h)
    assert meta.status_code == 200
    assert meta.json()["kinds"] == ["protocol", "assertion"]
    assert "没有动态装载点" in meta.json()["note"]

    bad = await _plugin(client, h, pid, config="{not json")
    assert bad.status_code == 422 and bad.json()["code"] == "bad_json"

    c = await _plugin(client, h, pid, config='{"brokers": ["a:9092"]}')
    assert c.status_code == 201, c.text
    plug_id = c.json()["id"]
    # 登记 ≠ 装载：开关打开也不许说「已装载」
    assert c.json()["loadable"] is False and c.json()["enabled"] is True

    bad_up = await client.patch(_BASE + f"/plugins/{plug_id}",
                                json={"project_id": pid, "config": "["}, headers=h)
    assert bad_up.status_code == 422 and bad_up.json()["code"] == "bad_json"
    still = await client.get(_BASE + f"/plugins/{plug_id}", params={"project_id": pid}, headers=h)
    assert still.json()["config"] == '{"brokers": ["a:9092"]}'

    st = await client.post(_BASE + f"/plugins/{plug_id}/status",
                           json={"project_id": pid, "plugin_id": plug_id, "enabled": False},
                           headers=h)
    assert st.status_code == 200
    assert st.json()["enabled"] is False and st.json()["loadable"] is False

    rm = await client.post(_BASE + f"/plugins/{plug_id}/delete",
                           json={"project_id": pid, "plugin_id": plug_id}, headers=h)
    assert rm.status_code == 200
    assert (await client.get(_BASE + f"/plugins/{plug_id}",
                             params={"project_id": pid}, headers=h)).status_code == 404


# ══════════ 系统信息 / 许可证 ══════════
async def test_system_info_reads_real_migration_head(client, session, make_user) -> None:
    _, h = await make_user("d203s", admin=True)
    # conftest 的 conn 夹具会 TRUNCATE 全表（alembic_version 也在其中），所以这里
    # 塞一个哨兵值而不是「0040」：接口若真读表就回哨兵；回 None/常量就说明是假的。
    await session.execute(text("INSERT INTO alembic_version (version_num) VALUES ('9999_d203')"))
    await session.commit()
    info = await client.get(_BASE + "/system/info", headers=h)
    assert info.status_code == 200, info.text
    body = info.json()
    assert body["migration_head"] == "9999_d203"
    assert body["version"] == "0.1.0"
    assert body["edition"] == "community"
    assert body["licensed"] is True and body["license_enforced"] is False

    lic = await client.get(_BASE + "/system/license", headers=h)
    assert lic.status_code == 200
    assert lic.json()["enforced"] is False and lic.json()["expires_at"] is None
    assert lic.json()["features"]["functional_cases"] is True


# ══════════ 项目隔离 / 权限 ══════════
async def test_project_isolation_and_readonly(client, make_user) -> None:
    _, hb = await make_user("d203x", admin=True)
    ro, hr = await make_user("d203x2")
    pid = await _proj(client, hb, "D203隔离A")
    pid2 = await _proj(client, hb, "D203隔离B")
    assert (await client.put(_BASE + f"/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=hb)).status_code == 200

    iid = (await _integration(client, hb, pid)).json()["id"]
    other = await client.get(_BASE + f"/service-integrations/{iid}",
                             params={"project_id": pid2}, headers=hb)
    assert other.status_code == 404
    # 同名在另一个项目不算冲突
    assert (await _integration(client, hb, pid2)).status_code == 201

    assert (await client.get(_BASE + "/service-integrations",
                             params={"project_id": pid}, headers=hr)).status_code == 200
    deny_int = await _integration(client, hr, pid, name="只读建的")
    assert deny_int.status_code == 403
    assert deny_int.json()["details"]["perm"] == "integration:integration:create"
    deny_pool = await _pool(client, hr, pid)
    assert deny_pool.status_code == 403
    assert deny_pool.json()["details"]["perm"] == "resource:pool:create"
    deny_plug = await _plugin(client, hr, pid)
    assert deny_plug.status_code == 403
    assert deny_plug.json()["details"]["perm"] == "plugin:plugin:create"
    # 非成员什么都看不到
    outsider, ho = await make_user("d203x3")
    assert (await client.get(_BASE + "/service-integrations",
                             params={"project_id": pid}, headers=ho)).status_code == 403


# ══════════ 表形状 = 迁移 ══════════
async def test_tables_match_models(session) -> None:
    expect = {
        "service_integration": {"id", "project_id", "kind", "name", "base_url", "token_enc",
                                "description", "enabled", "created_by", "updated_by",
                                "created_at", "updated_at"},
        "resource_pool": {"id", "project_id", "name", "kind", "description", "capacity",
                          "enabled", "created_by", "updated_by", "created_at", "updated_at"},
        "plugin": {"id", "project_id", "name", "kind", "version", "description", "config",
                   "enabled", "created_by", "updated_by", "created_at", "updated_at"},
    }
    for table, cols in expect.items():
        rows = (await session.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = DATABASE() AND table_name = :t"), {"t": table})).all()
        assert {r[0] for r in rows} == cols, table
