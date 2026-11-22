"""T7 私有资源数据权限（§4.1）+ 运行记录查询（§13 简易运行记录）。"""
from __future__ import annotations

GHOST = "00000000-0000-0000-0000-000000000000"


async def _setup(client, make_user, tag):
    boss, hb = await make_user("v7boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "p7" + tag}, headers=hb)
    pid = r.json()["id"]
    a, ha = await make_user("v7alice" + tag)
    b, hb2 = await make_user("v7bob" + tag)
    for uid in (a.id, b.id):
        rr = await client.put("/api/v1/projects/" + pid + "/members/" + uid,
                            json={"role_code": "MEMBER"}, headers=hb)
        assert rr.status_code == 200
    return pid, (boss, hb), (a, ha), (b, hb2)


async def _mkdef(client, h, pid, name, public=True):
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": "/x",
        "request": {"method": "GET", "url": "http://t/x"}, "project_public": public}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_private_invisible_to_peer(client, make_user) -> None:
    pid, (boss, hb), (a, ha), (b, hb2) = await _setup(client, make_user, "A")
    priv = await _mkdef(client, ha, pid, "私有接口", public=False)
    await _mkdef(client, ha, pid, "公开接口", public=True)
    assert priv["project_public"] is False and priv["owner_id"] == a.id
    # B 列表：只见公开
    r = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=hb2)
    names = [x["name"] for x in r.json()["items"]]
    assert names == ["公开接口"]
    # B get 私有 与 get 不存在 → 响应逐字段相等（不泄露存在性）
    r1 = await client.get("/api/v1/api-definitions/" + priv["id"], params={"project_id": pid}, headers=hb2)
    r2 = await client.get("/api/v1/api-definitions/" + GHOST, params={"project_id": pid}, headers=hb2)
    assert r1.status_code == 404 == r2.status_code
    assert (r1.json()["code"], r1.json()["message"]) == (r2.json()["code"], r2.json()["message"])  # 同码同文案
    # B update 私有 → 404（有 update 权限位也不行）
    r3 = await client.patch("/api/v1/api-definitions/" + priv["id"],
                            json={"project_id": pid, "name": "hijack", "version": 1}, headers=hb2)
    assert r3.status_code == 404
    # A 本人可见可改
    ver = priv["version"]
    r4 = await client.patch("/api/v1/api-definitions/" + priv["id"],
                            json={"project_id": pid, "name": "改个名", "version": ver}, headers=ha)
    assert r4.status_code == 200, r4.text
    # 项目管理员全见
    r5 = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=hb)
    assert {x["name"] for x in r5.json()["items"]} == {"改个名", "公开接口"}  # 管理员看得到私有（已被 A 改名）
    # 转公开后 B 可见
    await client.patch("/api/v1/api-definitions/" + priv["id"],
                       json={"project_id": pid, "project_public": True, "version": ver + 1}, headers=ha)
    r6 = await client.get("/api/v1/api-definitions", params={"project_id": pid}, headers=hb2)
    assert {x["name"] for x in r6.json()["items"]} == {"改个名", "公开接口"}


async def test_run_record_list_and_detail(client, session, make_user) -> None:
    pid, (boss, hb), (a, ha), (b, hb2) = await _setup(client, make_user, "B")
    from app.modules.execution.models import RunRecord

    for i, (trg, st) in enumerate([("debug", "passed"), ("agent", "failed"), ("debug", "failed")]):
        session.add(RunRecord(project_id=pid, subject_type="api_definition", subject_id="subj" + str(i % 2),
                              subject_name="接口" + str(i % 2), trigger=trg, status=st,
                              status_code=200 if st == "passed" else 500, elapsed_ms=50 + i,
                              request_snapshot={"method": "GET"}, response_snapshot={"status": 200},
                              assertions=[{"type": "status_code", "passed": st == "passed"}],
                              created_by=a.id))
    await session.commit()
    r = await client.get("/api/v1/runs", params={"project_id": pid}, headers=hb)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 3
    assert items[0]["created_by_name"] == "v7aliceB"
    assert "response_snapshot" not in items[0]  # 列表不吐大字段
    # 过滤
    r2 = await client.get("/api/v1/runs", params={"project_id": pid, "trigger": "debug", "status": "failed"}, headers=hb)
    assert len(r2.json()["items"]) == 1
    # 详情带快照
    rid = items[0]["id"]
    r3 = await client.get("/api/v1/runs/" + rid, params={"project_id": pid}, headers=hb)
    assert r3.status_code == 200
    assert r3.json()["response_snapshot"] == {"status": 200}
    # 非成员不可见
    _, ho = await make_user("v7outB")
    r4 = await client.get("/api/v1/runs", params={"project_id": pid}, headers=ho)
    assert r4.status_code == 403