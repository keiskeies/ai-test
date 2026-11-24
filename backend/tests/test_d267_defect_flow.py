"""D267：缺陷状态流转配置（项目级覆盖内置默认图）。

判据：
1. 两张表 + 唯一键落位；迁移头 0048（形状在 test 里用 inspector 读）。
2. `GET /defect-statuses`：未定制 = 默认图（5 态、起始 new、9 条边、customized=false）。
3. 保存自定义图后：新建缺陷落在自定义起始态；非法转移 409、未知状态 422；
   列表按自定义 key 过滤可用（schema 不再写死五态）。
4. 删仍在用的状态（含 reset）→ 409 status_in_use，整份不落。
5. reset 清空定制 → 回到默认图。
6. 权限：读走 defect:defect:read（READONLY 可读）；写/重置走 defect:flow:manage（MEMBER 403）。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _create(client, h, pid: str, title: str) -> dict:
    r = await client.post(_BASE + "/defects", json={"project_id": pid, "title": title}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _status(key: str, name: str, *, start: bool = False, end: bool = False) -> dict:
    return {"key": key, "name": name, "is_start": start, "is_end": end}


def _edge(frm: str, to: str) -> dict:
    return {"from_key": frm, "to_key": to}


async def _save(client, h, pid: str, statuses: list[dict], edges: list[dict]):
    return await client.post(_BASE + "/defect-statuses",
                             json={"project_id": pid, "statuses": statuses, "transitions": edges},
                             headers=h)


CUSTOM = (
    [_status("todo", "待处理", start=True), _status("doing", "处理中"), _status("done", "已完成", end=True)],
    [_edge("todo", "doing"), _edge("doing", "done"), _edge("done", "doing")],
)


async def test_create_can_pick_existing_status(client, make_user) -> None:
    """D289：新建表单带「状态」下拉——默认起始态；显式值必须在图里，未知 422。"""
    _, h = await make_user("d289f", admin=True)
    pid = await _proj(client, h, "d289flow")
    statuses, edges = CUSTOM
    saved = await _save(client, h, pid, statuses, edges)
    assert saved.status_code == 200, saved.text

    picked = await client.post(_BASE + "/defects", json={
        "project_id": pid, "title": "直接进处理中", "status": "doing"}, headers=h)
    assert picked.status_code == 201, picked.text
    assert picked.json()["status"] == "doing"

    default = await _create(client, h, pid, "默认起始")
    assert default["status"] == "todo"

    bad = await client.post(_BASE + "/defects", json={
        "project_id": pid, "title": "坏状态", "status": "ghost"}, headers=h)
    assert bad.status_code == 422
    assert bad.json()["code"] == "invalid_status"


# ══════════ 1. 迁移形状 ══════════
async def test_flow_tables_shape(conn) -> None:
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "scols": {c["name"] for c in insp.get_columns("defect_status")},
            "tcols": {c["name"] for c in insp.get_columns("defect_status_transition")},
            "suq": {u["name"] for u in insp.get_unique_constraints("defect_status")},
            "tuq": {u["name"] for u in insp.get_unique_constraints("defect_status_transition")},
        }

    got = await conn.run_sync(_read)
    assert {"defect_status", "defect_status_transition"} <= got["tables"]
    assert {"project_id", "key", "name", "is_start", "is_end", "position"} <= got["scols"]
    assert {"project_id", "from_key", "to_key"} <= got["tcols"]
    assert "uq_defect_status_project_key" in got["suq"]
    assert "uq_defect_transition_project_edge" in got["tuq"]


# ══════════ 2. 默认图 + 3. 自定义图生效 ══════════
async def test_default_flow_then_custom(client, make_user) -> None:
    _, h = await make_user("d267a", admin=True)
    pid = await _proj(client, h, "D267默认")

    got = await client.get(_BASE + "/defect-statuses", params={"project_id": pid}, headers=h)
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["customized"] is False
    assert body["start_key"] == "new"
    assert [s["key"] for s in body["statuses"]] == ["new", "in_process", "resolved", "rejected", "closed"]
    assert len(body["transitions"]) == 9 and {"from_key": "new", "to_key": "in_process"} in body["transitions"]

    statuses, edges = CUSTOM
    saved = await _save(client, h, pid, statuses, edges)
    assert saved.status_code == 200, saved.text
    assert saved.json()["customized"] is True and saved.json()["start_key"] == "todo"
    assert len(saved.json()["transitions"]) == 3

    d = await _create(client, h, pid, "走自定义图")
    assert d["status"] == "todo", "新建必须落在自定义起始态"

    bad = await client.patch(_BASE + f"/defects/{d['id']}",
                             json={"project_id": pid, "defect_id": d["id"], "status": "done"}, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "invalid_transition"
    assert bad.json()["details"]["allowed"] == ["doing"]

    step = await client.patch(_BASE + f"/defects/{d['id']}",
                              json={"project_id": pid, "defect_id": d["id"], "status": "doing"}, headers=h)
    assert step.status_code == 200 and step.json()["status"] == "doing"

    ghost = await client.patch(_BASE + f"/defects/{d['id']}",
                               json={"project_id": pid, "defect_id": d["id"], "status": "ghost"}, headers=h)
    assert ghost.status_code == 422 and ghost.json()["code"] == "invalid_status"

    # schema 不再把状态写死五态：自定义 key 能作为列表筛选
    listed = await client.get(_BASE + "/defects", params={"project_id": pid, "status": "doing"}, headers=h)
    assert listed.status_code == 200 and listed.json()["total"] == 1


# ══════════ 4. 删/重置仍在用的状态 ══════════
async def test_status_in_use_blocks_save_and_reset(client, make_user) -> None:
    _, h = await make_user("d267b", admin=True)
    pid = await _proj(client, h, "D267引用")
    statuses, edges = CUSTOM
    assert (await _save(client, h, pid, statuses, edges)).status_code == 200
    await _create(client, h, pid, "占着 todo")

    deny = await _save(client, h, pid,
                       [_status("doing", "处理中", start=True), _status("done", "已完成", end=True)],
                       [_edge("doing", "done")])
    assert deny.status_code == 409 and deny.json()["code"] == "status_in_use"
    assert deny.json()["details"]["in_use"] == {"todo": 1}

    deny_reset = await client.post(_BASE + "/defect-statuses/reset",
                                   json={"project_id": pid}, headers=h)
    assert deny_reset.status_code == 409 and deny_reset.json()["code"] == "status_in_use"

    # 图没有被改动：仍是自定义图
    still = await client.get(_BASE + "/defect-statuses", params={"project_id": pid}, headers=h)
    assert still.json()["customized"] is True and len(still.json()["statuses"]) == 3


# ══════════ 5. reset 回默认 ══════════
async def test_reset_restores_default(client, make_user) -> None:
    _, h = await make_user("d267c", admin=True)
    pid = await _proj(client, h, "D267重置")
    statuses, edges = CUSTOM
    assert (await _save(client, h, pid, statuses, edges)).status_code == 200

    ok = await client.post(_BASE + "/defect-statuses/reset", json={"project_id": pid}, headers=h)
    assert ok.status_code == 200 and ok.json()["customized"] is False
    assert ok.json()["start_key"] == "new"
    d = await _create(client, h, pid, "回默认后新建")
    assert d["status"] == "new"


# ══════════ 6. 校验与权限 ══════════
async def test_flow_validation_and_perm_gates(client, make_user) -> None:
    boss, hb = await make_user("d267d", admin=True)
    mem, hm = await make_user("d267e")
    ro, hr = await make_user("d267f")
    pid = await _proj(client, hb, "D267校验")
    await _member(client, hb, pid, mem.id, "MEMBER")
    await _member(client, hb, pid, ro.id, "READONLY")

    cases = [
        ([_status("a", "甲"), _status("b", "乙")], [], "恰好一个起始态"),
        ([_status("a", "甲", start=True), _status("a", "重复", start=True)], [], "重复"),
        ([_status("a", "甲", start=True)], [_edge("a", "x")], "不存在的状态"),
        ([_status("a", "甲", start=True)], [_edge("a", "a")], "同态"),
    ]
    for statuses, edges, why in cases:
        r = await _save(client, hb, pid, statuses, edges)
        assert r.status_code == 422 and r.json()["code"] == "invalid_flow", why

    # 整份未落：坏请求之后项目仍是默认图
    got = await client.get(_BASE + "/defect-statuses", params={"project_id": pid}, headers=hb)
    assert got.json()["customized"] is False

    statuses, edges = CUSTOM
    deny_write = await _save(client, hm, pid, statuses, edges)
    assert deny_write.status_code == 403 and deny_write.json()["details"]["perm"] == "defect:flow:manage"
    deny_reset = await client.post(_BASE + "/defect-statuses/reset", json={"project_id": pid}, headers=hm)
    assert deny_reset.status_code == 403 and deny_reset.json()["details"]["perm"] == "defect:flow:manage"

    can_read = await client.get(_BASE + "/defect-statuses", params={"project_id": pid}, headers=hr)
    assert can_read.status_code == 200 and can_read.json()["customized"] is False
