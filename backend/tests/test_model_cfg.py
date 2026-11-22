"""T13 模型配置：加密回显打码、update 空值不覆盖、probe、权限门。"""
from __future__ import annotations

from tests.test_registry import make_user_named

BASE = "/api/v1"


async def _admin(client, make_user, tag):
    _, h = await make_user("mc_" + tag, admin=True)
    return h


def _body(tag="m", **kw):
    b = {"name": "模型" + tag, "model_type": "CHAT", "protocol": "OPENAI_COMPAT",
         "base_url": "http://127.0.0.1:9/v1", "model_name": "gpt-fake", "api_key": "sk-secret-1234567890"}
    b.update(kw)
    return b


async def test_create_list_masked(client, make_user) -> None:
    h = await _admin(client, make_user, "cl")
    r = await client.post(BASE + "/model-cfgs", json=_body("cl"), headers=h)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["api_key_masked"] == "****7890"
    assert "sk-secret" not in r.text

    # 库内是密文
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.model_cfg.models import ModelConfig

    async with get_sessionmaker()() as s:
        cfg = (await s.execute(select(ModelConfig).where(ModelConfig.id == out["id"]))).scalar_one()
        assert cfg.api_key_enc is not None and "sk-secret" not in cfg.api_key_enc

    g = await client.get(BASE + "/model-cfgs", headers=h)
    assert g.status_code == 200
    items = g.json()["items"]
    assert len(items) == 1 and items[0]["api_key_masked"] == "****7890"
    assert "api_key" not in items[0] or "sk-secret" not in str(items[0])


async def test_default_unique(client, make_user) -> None:
    """CHAT 唯一默认：新默认顶替旧默认。"""
    h = await _admin(client, make_user, "dflt")
    r1 = await client.post(BASE + "/model-cfgs", json=_body("d1", is_default=True), headers=h)
    assert r1.status_code == 201
    r2 = await client.post(BASE + "/model-cfgs", json=_body("d2", is_default=True), headers=h)
    assert r2.status_code == 201
    g = await client.get(BASE + "/model-cfgs", headers=h)
    d = {x["name"]: x["is_default"] for x in g.json()["items"]}
    assert d["模型d1"] is False and d["模型d2"] is True


async def test_update_empty_key_keeps_old(client, make_user) -> None:
    h = await _admin(client, make_user, "uk")
    rid = (await client.post(BASE + "/model-cfgs", json=_body("uk"), headers=h)).json()["id"]
    r = await client.patch(BASE + "/model-cfgs/" + rid, json={"model_name": "gpt-new", "api_key": ""}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["model_name"] == "gpt-new"
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.core.security import dec_key
    from app.modules.model_cfg.models import ModelConfig

    async with get_sessionmaker()() as s:
        cfg = (await s.execute(select(ModelConfig).where(ModelConfig.id == rid))).scalar_one()
        assert dec_key(cfg.api_key_enc) == "sk-secret-1234567890"
    # 换新 key
    r2 = await client.patch(BASE + "/model-cfgs/" + rid, json={"api_key": "sk-new-0000"}, headers=h)
    assert r2.status_code == 200 and r2.json()["api_key_masked"] == "****0000"


async def test_probe_fake_and_dead(client, make_user) -> None:
    h = await _admin(client, make_user, "pb")
    fake = (await client.post(BASE + "/model-cfgs", json=_body("pf", base_url="fake://basic_two_tools"), headers=h)).json()["id"]
    r = await client.post(BASE + "/model-cfgs/" + fake + "/probe", json={}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["latency_ms"] >= 0
    assert body["capabilities"]["tools"] is True

    dead = (await client.post(BASE + "/model-cfgs", json=_body("dd", base_url="http://127.0.0.1:9/v1"), headers=h)).json()["id"]
    r2 = await client.post(BASE + "/model-cfgs/" + dead + "/probe", json={}, headers=h)
    assert r2.status_code == 200
    assert r2.json()["ok"] is False and r2.json()["error"]


async def test_delete_and_permission_gate(client, make_user) -> None:
    h = await _admin(client, make_user, "perm")
    r = await client.post(BASE + "/model-cfgs", json=_body("pm"), headers=h)
    rid = r.json()["id"]
    _, h_ro = await make_user("mc_ro_user")
    # 非系统管理员且无任何权限位 → 403 insufficient_permission（模型配置为全局资源）
    r2 = await client.post(BASE + "/model-cfgs", json=_body("pm2"), headers=h_ro)
    assert r2.status_code == 403 and r2.json()["code"] == "insufficient_permission", r2.text
    g = await client.get(BASE + "/model-cfgs", headers=h_ro)
    assert g.status_code == 403 and g.json()["code"] == "insufficient_permission"
    # 管理员删除
    d = await client.delete(BASE + "/model-cfgs/" + rid, headers=h)
    assert d.status_code == 200, d.text
    g2 = await client.get(BASE + "/model-cfgs", headers=h)
    assert g2.json()["items"] == []


async def test_global_governance(client, make_user) -> None:
    """§9.10 治理：模型全局共享。PROJECT_ADMIN 可读可建，但不能删（仅系统管理员）。"""
    h = await _admin(client, make_user, "gov")
    pid = (await client.post("/api/v1/projects", json={"name": "gov_proj"}, headers=h)).json()["id"]
    hs = await make_user_named(client, h, pid, "gov_pa", "PROJECT_ADMIN")
    g = await client.get(BASE + "/model-cfgs", headers=hs)
    assert g.status_code == 403 and g.json()["code"] == "insufficient_permission", g.text  # 治理：模型仅系统管理员（§9.10）
    rid = (await client.post(BASE + "/model-cfgs", json=_body("gv"), headers=h)).json()["id"]
    d = await client.delete(BASE + "/model-cfgs/" + rid, headers=hs)
    # 权限点门先于服务体：PROJECT_ADMIN 未持有 model:cfg:delete
    assert d.status_code == 403 and d.json()["code"] == "insufficient_permission", d.text
    # 系统管理员可删
    d2 = await client.delete(BASE + "/model-cfgs/" + rid, headers=h)
    assert d2.status_code == 200, d2.text
    # PROJECT_ADMIN 连改也不行
    rid2 = (await client.post(BASE + "/model-cfgs", json=_body("gv2"), headers=h)).json()["id"]
    u = await client.patch(BASE + "/model-cfgs/" + rid2, json={"model_name": "x"}, headers=hs)
    assert u.status_code == 403 and u.json()["code"] == "insufficient_permission"
