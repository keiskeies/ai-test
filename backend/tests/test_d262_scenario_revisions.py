"""D262：场景变更历史（scenario_revision）。

基础特质：谁在什么时候把场景改成了什么样，必须可追责；但历史不能变成敏感值的
第二份拷贝——`variables` 只记键名、`step_graph` 只记步骤数，值一律不进库。

可见性口径与 scenario_get 逐字一致：同项目 + 行级可见（私有场景只给 owner/管理员），
回收站里的场景 404——历史里可能有旧名称等元信息，不能成为绕过回收站的第二扇门。
"""
from __future__ import annotations

from sqlalchemy import func, select

_BASE = "/api/v1"


async def _setup(client, make_user, name):
    user, h = await make_user(name)
    pid = (await client.post(_BASE + "/projects", json={"name": name + "_p"},
                             headers=h)).json()["id"]
    return user, h, pid


async def _mk(client, h, pid, name="甲", **kw):
    body = {"project_id": pid, "name": name, "step_graph": {"version": 1, "nodes": []}}
    body.update(kw)
    r = await client.post(_BASE + "/scenarios", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _upd(client, h, pid, s, **kw):
    body = {"project_id": pid, "version": s["version"]}
    body.update(kw)
    return await client.patch(_BASE + "/scenarios/" + s["id"], json=body, headers=h)


async def _revs(client, h, pid, sid, **params):
    return await client.get(_BASE + "/scenarios/" + sid + "/revisions",
                            params={"project_id": pid, **params}, headers=h)


# ══════════ 1. 两次更新 → 两条历史；最新在前；字段与前后值正确 ══════════
async def test_update_appends_revisions_newest_first(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "d262a")
    s = await _mk(client, h, pid, name="原始名", priority="P2")

    r1 = await _upd(client, h, pid, s, name="新名字", priority="P0")
    assert r1.status_code == 200, r1.text
    # max_runtime_ms 是「显式声明位」字段：只给值不给 max_runtime_set=True 等于没改
    r2 = await _upd(client, h, pid, r1.json(), fail_fast=False,
                    max_runtime_ms=60000, max_runtime_set=True)
    assert r2.status_code == 200, r2.text

    got = await _revs(client, h, pid, s["id"])
    assert got.status_code == 200, got.text
    items = got.json()["items"]
    # 最新在前：版本 3（第二次更新）→ 版本 2（第一次更新）
    assert [x["version"] for x in items] == [3, 2], items
    assert items[0]["actor_name"] == "d262a", items[0]

    newest = {c["field"]: c for c in items[0]["changed"]}
    assert set(newest) == {"fail_fast", "max_runtime_ms"}, newest
    assert newest["fail_fast"]["before"] is True and newest["fail_fast"]["after"] is False
    assert newest["max_runtime_ms"] == {"field": "max_runtime_ms",
                                        "before": None, "after": 60000}

    first = {c["field"]: c for c in items[1]["changed"]}
    assert set(first) == {"name", "priority"}, first
    assert first["name"]["before"] == "原始名" and first["name"]["after"] == "新名字"


# ══════════ 2. 敏感值不进历史：variables 只留键名、step_graph 只留步骤数 ══════════
async def test_revision_never_stores_sensitive_values(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "d262b")
    s = await _mk(client, h, pid, name="带密钥")
    g = {"version": 1, "nodes": [
        {"key": "n1", "kind": "sleep", "config": {"ms": 5}},
        {"key": "n2", "kind": "sleep", "config": {"ms": 6}},
    ]}
    r = await _upd(client, h, pid, s,
                   step_graph=g,
                   variables={"token": "super-secret-value", "base": "http://t"})
    assert r.status_code == 200, r.text

    body = (await _revs(client, h, pid, s["id"])).json()
    changed = {c["field"]: c for c in body["items"][0]["changed"]}
    assert changed["step_graph"] == {"field": "step_graph",
                                     "before": {"step_count": 0}, "after": {"step_count": 2}}
    assert changed["variables"] == {"field": "variables",
                                    "before": {"keys": []},
                                    "after": {"keys": ["base", "token"]}}
    # 整个响应里不允许出现变量值（历史不是密钥备份）
    assert "super-secret-value" not in str(body)


# ══════════ 3. 倒序游标分页：size=1 逐页取齐，不重不漏 ══════════
async def test_revisions_cursor_pagination(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "d262c")
    s = await _mk(client, h, pid)
    for i in range(3):
        r = await _upd(client, h, pid, s, name="名" + str(i))
        assert r.status_code == 200, r.text
        s = r.json()

    p1 = (await _revs(client, h, pid, s["id"], size=1)).json()
    assert [x["version"] for x in p1["items"]] == [4] and p1["next_cursor"]
    p2 = (await _revs(client, h, pid, s["id"], size=1, cursor=p1["next_cursor"])).json()
    assert [x["version"] for x in p2["items"]] == [3] and p2["next_cursor"]
    p3 = (await _revs(client, h, pid, s["id"], size=1, cursor=p2["next_cursor"])).json()
    assert [x["version"] for x in p3["items"]] == [2] and p3["next_cursor"] is None


# ══════════ 4. 可见性：跨项目 403/404、私有场景 404、回收站 404 ══════════
async def test_revision_visibility_matches_scenario_get(client, make_user) -> None:
    user_a, ha, pa = await _setup(client, make_user, "d262d_a")
    user_b, hb, pb = await _setup(client, make_user, "d262d_b")
    s = await _mk(client, ha, pa, name="公开场景")

    # 另一个项目的人：拿自己的 project_id 查别人的场景 → 404（不泄露存在性）
    assert (await _revs(client, hb, pb, s["id"])).status_code == 404
    # 拿别人的 project_id → 403（非成员）
    assert (await _revs(client, hb, pa, s["id"])).status_code == 403

    # 私有场景：同项目普通成员也看不到历史
    priv = await _mk(client, ha, pa, name="私有场景", project_public=False)
    assert (await client.put(_BASE + "/projects/" + pa + "/members/" + user_b.id,
                             json={"role_code": "MEMBER"}, headers=ha)).status_code == 200
    assert (await _revs(client, hb, pa, priv["id"])).status_code == 404
    assert (await _revs(client, ha, pa, priv["id"])).status_code == 200
    assert user_a.id and user_b.id  # 两个主体都真实存在（防夹具空转）

    # 回收站中的场景：历史与详情同尺 404
    assert (await client.post(_BASE + "/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pa}, headers=ha)).status_code == 200
    assert (await _revs(client, ha, pa, s["id"])).status_code == 404


# ══════════ 5. 彻底删除清历史：不留孤儿行 ══════════
async def test_purge_removes_revision_rows(client, make_user, session) -> None:
    from app.modules.scenario.models import ScenarioRevision

    _, h, pid = await _setup(client, make_user, "d262e")
    s = await _mk(client, h, pid, name="要彻底删的")
    assert (await _upd(client, h, pid, s, name="改过名")).status_code == 200

    count = await session.scalar(select(func.count()).select_from(ScenarioRevision)
                                 .where(ScenarioRevision.scenario_id == s["id"]))
    assert count == 1

    assert (await client.post(_BASE + "/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post(_BASE + "/scenarios/" + s["id"] + "/purge",
                              json={"project_id": pid, "confirm_name": "改过名"},
                              headers=h)).status_code == 200
    left = await session.scalar(select(func.count()).select_from(ScenarioRevision)
                                .where(ScenarioRevision.scenario_id == s["id"]))
    assert left == 0
