"""D197：功能用例评论 + 前后置关系。"""
from __future__ import annotations

from sqlalchemy import text

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, hb, pid: str, uid: str, role: str = "MEMBER") -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=hb)
    assert r.status_code == 200, r.text


async def _case(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/functional-cases", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_comment_nesting_author_and_cascade(client, make_user) -> None:
    boss, hb = await make_user("d197c1", admin=True)
    mem, hm = await make_user("d197c2")
    pid = await _proj(client, hb, "D197评论")
    await _member(client, hb, pid, mem.id)
    c = await _case(client, hb, pid, "评论用例")
    root = await client.post(_BASE + f"/functional-cases/{c['id']}/comments",
                             json={"project_id": pid, "content": "顶层"}, headers=hb)
    assert root.status_code == 201, root.text
    rid = root.json()["id"]
    child = await client.post(_BASE + f"/functional-cases/{c['id']}/comments",
                              json={"project_id": pid, "content": "回复", "parent_id": rid}, headers=hm)
    assert child.status_code == 201 and child.json()["reply_user_id"] == boss.id
    grand = await client.post(_BASE + f"/functional-cases/{c['id']}/comments",
                              json={"project_id": pid, "content": "三层", "parent_id": child.json()["id"]},
                              headers=hm)
    assert grand.status_code == 422

    tree = await client.get(_BASE + f"/functional-cases/{c['id']}/comments",
                            params={"project_id": pid}, headers=hb)
    assert tree.json()["total"] == 2
    assert tree.json()["items"][0]["children"][0]["content"] == "回复"

    deny = await client.patch(_BASE + f"/functional-case-comments/{rid}",
                              json={"project_id": pid, "comment_id": rid, "content": "改"}, headers=hm)
    assert deny.status_code == 403
    own = await client.patch(_BASE + f"/functional-case-comments/{rid}",
                             json={"project_id": pid, "comment_id": rid, "content": "改"}, headers=hb)
    assert own.status_code == 200
    dl = await client.post(_BASE + f"/functional-case-comments/{rid}/delete",
                           json={"project_id": pid, "comment_id": rid}, headers=hb)
    assert dl.status_code == 200
    left = await client.get(_BASE + f"/functional-cases/{c['id']}/comments",
                            params={"project_id": pid}, headers=hb)
    assert left.json()["total"] == 0


async def test_relations_direction_cycle_and_delete(client, make_user) -> None:
    boss, hb = await make_user("d197r", admin=True)
    pid = await _proj(client, hb, "D197关系")
    a = await _case(client, hb, pid, "用例A")
    b = await _case(client, hb, pid, "用例B")
    c = await _case(client, hb, pid, "用例C")

    # A 的后置 = B；C 的前置 = A（即 A 的前置 = C）
    r1 = await client.post(_BASE + f"/functional-cases/{a['id']}/relations", json={
        "project_id": pid, "case_id": a["id"], "target_case_id": b["id"],
        "relation_type": "successor",
    }, headers=hb)
    assert r1.status_code == 201, r1.text
    r2 = await client.post(_BASE + f"/functional-cases/{a['id']}/relations", json={
        "project_id": pid, "case_id": a["id"], "target_case_id": c["id"],
        "relation_type": "predecessor",
    }, headers=hb)
    assert r2.status_code == 201
    same = await client.post(_BASE + f"/functional-cases/{a['id']}/relations", json={
        "project_id": pid, "case_id": a["id"], "target_case_id": b["id"],
        "relation_type": "successor",
    }, headers=hb)
    assert same.status_code == 201 and same.json()["relation_id"] == r1.json()["relation_id"]

    self_r = await client.post(_BASE + f"/functional-cases/{a['id']}/relations", json={
        "project_id": pid, "case_id": a["id"], "target_case_id": a["id"],
        "relation_type": "predecessor",
    }, headers=hb)
    assert self_r.status_code == 422 and self_r.json()["code"] == "self_relation"
    cyc = await client.post(_BASE + f"/functional-cases/{b['id']}/relations", json={
        "project_id": pid, "case_id": b["id"], "target_case_id": a["id"],
        "relation_type": "successor",
    }, headers=hb)
    assert cyc.status_code == 409 and cyc.json()["code"] == "cycle"

    rel = await client.get(_BASE + f"/functional-cases/{a['id']}/relations",
                           params={"project_id": pid}, headers=hb)
    assert [x["case"]["name"] for x in rel.json()["predecessors"]] == ["用例C"]
    assert [x["case"]["name"] for x in rel.json()["successors"]] == ["用例B"]

    d = await client.post(_BASE + f"/functional-case-relations/{r1.json()['relation_id']}/delete",
                          json={"project_id": pid, "relation_id": r1.json()["relation_id"]}, headers=hb)
    assert d.status_code == 200
    assert (await client.get(_BASE + f"/functional-cases/{a['id']}/relations",
                             params={"project_id": pid}, headers=hb)).json()["successors"] == []


async def test_purge_cascades_comments_relations(client, conn, make_user) -> None:
    _, h = await make_user("d197p", admin=True)
    pid = await _proj(client, h, "D197级联")
    a = await _case(client, h, pid, "A")
    b = await _case(client, h, pid, "B")
    await client.post(_BASE + f"/functional-cases/{a['id']}/comments",
                      json={"project_id": pid, "content": "评论"}, headers=h)
    await client.post(_BASE + f"/functional-cases/{a['id']}/relations", json={
        "project_id": pid, "case_id": a["id"], "target_case_id": b["id"], "relation_type": "successor",
    }, headers=h)
    await client.post(_BASE + f"/functional-cases/{a['id']}/delete",
                      json={"project_id": pid, "case_id": a["id"]}, headers=h)
    pg = await client.post(_BASE + f"/functional-cases/{a['id']}/purge",
                           json={"project_id": pid, "case_id": a["id"], "confirm_name": "A"}, headers=h)
    assert pg.status_code == 200
    row = (await conn.execute(text(
        "SELECT (SELECT COUNT(*) FROM functional_case_comment WHERE case_id=:c),"
        " (SELECT COUNT(*) FROM functional_case_relation WHERE from_case_id=:c OR to_case_id=:c)"
    ), {"c": a["id"]})).one()
    assert tuple(row) == (0, 0)


async def test_permissions_and_cross_project(client, make_user) -> None:
    boss, hb = await make_user("d197x", admin=True)
    ro, hr = await make_user("d197x2")
    pid = await _proj(client, hb, "D197权限")
    pid2 = await _proj(client, hb, "D197权限B")
    await _member(client, hb, pid, ro.id, "READONLY")
    a = await _case(client, hb, pid, "A")
    b = await _case(client, hb, pid, "B")
    assert (await client.get(_BASE + f"/functional-cases/{a['id']}/comments",
                             params={"project_id": pid}, headers=hr)).status_code == 200
    deny = await client.post(_BASE + f"/functional-cases/{a['id']}/comments",
                             json={"project_id": pid, "content": "只读别评"}, headers=hr)
    assert deny.status_code == 403 and deny.json()["details"]["perm"] == "functional:case:comment"
    cross = await client.post(_BASE + f"/functional-cases/{a['id']}/relations", json={
        "project_id": pid2, "case_id": a["id"], "target_case_id": b["id"], "relation_type": "successor",
    }, headers=hb)
    assert cross.status_code == 404
