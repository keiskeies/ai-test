"""D191：缺陷域服务面判据（D190 裁定的 25 条可做端点）。

每条断言都对着 D190 的一条裁定或本仓先例：
1. 迁移形状：defect 新增 tags/delete_user/delete_time；follower/comment 两张新表在。
2. CRUD 往返 + 每列写入方；状态机写路径真校验（new→closed 409；new→in_process 200）。
3. 列表：页码分页真 total、状态/优先级/标签/关键词/我关注的筛选。
4. 回收站：删除写 delete_user/time；恢复清空（不复制 MS）；purge 逐字确认并级联三张子表。
5. 评论：两层嵌套；仅创建人可编辑/删除；父删连子删。
6. 关注：幂等；写位（READONLY 403）。
7. 关联：候选取未关联、重复跳过、未知用例 422、名称解析、取消关联。
8. 跨项目：逐字同 404（不泄露存在性）。
9. 导出：CSV 文本 + 缺 id 如实报。
"""
from __future__ import annotations

from sqlalchemy import text

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _create(client, h, pid: str, title: str, **kw) -> dict:
    r = await client.post(_BASE + "/defects", json={"project_id": pid, "title": title, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _list(client, h, pid: str, **params) -> dict:
    r = await client.get(_BASE + "/defects",
                         params=[("project_id", pid)] + [(k, str(v)) for k, v in params.items()],
                         headers=h)
    assert r.status_code == 200, r.text
    return r.json()


# ══════════ 1. 迁移形状 ══════════
async def test_defect_service_tables_shape(conn) -> None:
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "cols": {c["name"] for c in insp.get_columns("defect")},
            "fcols": {c["name"] for c in insp.get_columns("defect_follower")},
            "ccols": {c["name"] for c in insp.get_columns("defect_comment")},
            "fpk": tuple(insp.get_pk_constraint("defect_follower")["constrained_columns"]),
        }

    got = await conn.run_sync(_read)
    assert {"defect_follower", "defect_comment"} <= got["tables"]
    assert {"tags", "delete_user", "delete_time", "num", "template_id"} <= got["cols"]
    # D192 之后 num/template_id 已建；仍未到位的列不许出现
    assert not ({"platform", "platform_bug_id", "pos"} & got["cols"])
    assert got["fpk"] == ("defect_id", "user_id"), "关注表复合主键必须是 (defect_id,user_id)"
    assert {"parent_id", "reply_user_id", "content", "created_by"} <= got["ccols"]
    assert "notifier" not in got["ccols"], "富文本 @ 未落地，notifier 是有列没写入方"


# ══════════ 2. CRUD + 状态机 ══════════
async def test_crud_and_transition_validation(client, session, make_user) -> None:
    boss, hb = await make_user("d191boss", admin=True)
    boss_id = boss.id
    pid = await _proj(client, hb, "D191本体")
    d = await _create(client, hb, pid, "登录失败", description="偶现", priority="P1",
                      tags=["回归", "登录", "回归"])
    assert d["status"] == "new" and d["tags"] == ["回归", "登录"], "标签必须去重且保序"
    assert d["created_by"] == boss_id and d["updated_by"] == boss_id
    assert d["link_count"] == 0 and d["comment_count"] == 0 and d["followed"] is False

    g = await client.get(_BASE + f"/defects/{d['id']}", params={"project_id": pid}, headers=hb)
    assert g.status_code == 200 and g.json()["title"] == "登录失败"

    # 状态机：new → closed 是非法边（409），new → in_process 合法
    bad = await client.patch(_BASE + f"/defects/{d['id']}",
                             json={"project_id": pid, "status": "closed"}, headers=hb)
    assert bad.status_code == 409 and bad.json()["code"] == "invalid_transition"
    ok = await client.patch(_BASE + f"/defects/{d['id']}",
                            json={"project_id": pid, "status": "in_process", "tags": []}, headers=hb)
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "in_process" and ok.json()["tags"] == [], "tags=[] 必须清空"
    same = await client.patch(_BASE + f"/defects/{d['id']}",
                              json={"project_id": pid, "status": "in_process"}, headers=hb)
    assert same.status_code == 200, "同态不算转移"

    # handle_user_set：显式 null 才能清空
    u = await client.patch(_BASE + f"/defects/{d['id']}",
                           json={"project_id": pid, "handle_user_id": boss_id, "handle_user_set": True},
                           headers=hb)
    assert u.json()["handle_user_id"] == boss_id
    u2 = await client.patch(_BASE + f"/defects/{d['id']}",
                            json={"project_id": pid, "handle_user_id": None, "handle_user_set": True},
                            headers=hb)
    assert u2.json()["handle_user_id"] is None


# ══════════ 3. 列表筛选与分页 ══════════
async def test_list_filters_and_page_total(client, make_user) -> None:
    boss, hb = await make_user("d191list", admin=True)
    pid = await _proj(client, hb, "D191列表")
    a = await _create(client, hb, pid, "A 登录超时", priority="P0", tags=["甲"])
    b = await _create(client, hb, pid, "B 支付失败", priority="P1", tags=["乙"])
    c = await _create(client, hb, pid, "C 登录闪退", priority="P0", tags=["甲", "乙"])
    page1 = await _list(client, hb, pid, current=1, size=2)
    page2 = await _list(client, hb, pid, current=2, size=2)
    assert page1["total"] == 3 and len(page1["items"]) == 2
    assert page2["total"] == 3 and len(page2["items"]) == 1
    assert {x["id"] for x in page1["items"] + page2["items"]} == {a["id"], b["id"], c["id"]}

    by_status = await _list(client, hb, pid, status="new")
    assert by_status["total"] == 3
    by_priority = await _list(client, hb, pid, priority="P0")
    assert {x["id"] for x in by_priority["items"]} == {a["id"], c["id"]}
    by_tag = await _list(client, hb, pid, tag="甲")
    assert {x["id"] for x in by_tag["items"]} == {a["id"], c["id"]}
    by_kw = await _list(client, hb, pid, keyword="登录")
    assert {x["id"] for x in by_kw["items"]} == {a["id"], c["id"]}

    await client.post(_BASE + f"/defects/{a['id']}/follow", json={"project_id": pid}, headers=hb)
    followed = await _list(client, hb, pid, followed_by_me=True)
    assert [x["id"] for x in followed["items"]] == [a["id"]]


# ══════════ 4. 回收站 ══════════
async def test_trash_restore_purge_cascade(client, session, conn, make_user) -> None:
    boss, hb = await make_user("d191trash", admin=True)
    boss_id = boss.id
    pid = await _proj(client, hb, "D191回收")
    d = await _create(client, hb, pid, "待回收")
    await client.post(_BASE + f"/defects/{d['id']}/comments",
                      json={"project_id": pid, "content": "评论"}, headers=hb)
    await client.post(_BASE + f"/defects/{d['id']}/follow", json={"project_id": pid}, headers=hb)

    r = await client.post(_BASE + f"/defects/{d['id']}/delete", json={"project_id": pid, "defect_id": d["id"]},
                          headers=hb)
    assert r.status_code == 200 and r.json()["affected"] == 1
    gone = await client.get(_BASE + f"/defects/{d['id']}", params={"project_id": pid}, headers=hb)
    assert gone.status_code == 404
    bin_rows = await _list(client, hb, pid, recycled=True)
    assert bin_rows["total"] == 1
    row = bin_rows["items"][0]
    assert row["delete_user"] == boss_id and row["delete_time"]

    rs = await client.post(_BASE + f"/defects/{d['id']}/restore", json={"project_id": pid, "defect_id": d["id"]},
                           headers=hb)
    assert rs.status_code == 200
    assert rs.json()["delete_user"] is None and rs.json()["delete_time"] is None, \
        "恢复必须清空删除人/时间（D190 §5 第 5 条）"

    await client.post(_BASE + f"/defects/{d['id']}/delete", json={"project_id": pid, "defect_id": d["id"]},
                      headers=hb)
    wrong = await client.post(_BASE + f"/defects/{d['id']}/purge",
                              json={"project_id": pid, "defect_id": d["id"], "confirm_title": "写错了"},
                              headers=hb)
    assert wrong.status_code == 409 and wrong.json()["code"] == "title_mismatch"
    purged = await client.post(_BASE + f"/defects/{d['id']}/purge",
                               json={"project_id": pid, "defect_id": d["id"], "confirm_title": "待回收"},
                               headers=hb)
    assert purged.status_code == 200 and purged.json()["affected"] == 1
    counts = (await conn.execute(text(
        "SELECT (SELECT COUNT(*) FROM defect), (SELECT COUNT(*) FROM defect_comment),"
        " (SELECT COUNT(*) FROM defect_follower)"))).one()
    assert tuple(counts) == (0, 0, 0), "彻底删除必须同事务清干净评论/关注（MS 的孤儿行不许复刻）"


# ══════════ 5. 评论 ══════════
async def test_comments_nesting_author_and_cascade(client, make_user) -> None:
    boss, hb = await make_user("d191c1", admin=True)
    mem, hm = await make_user("d191c2")
    pid = await _proj(client, hb, "D191评论")
    await _member(client, hb, pid, mem.id, "MEMBER")
    d = await _create(client, hb, pid, "带评论")
    root = await client.post(_BASE + f"/defects/{d['id']}/comments",
                             json={"project_id": pid, "content": "顶层"}, headers=hb)
    assert root.status_code == 201
    rid = root.json()["id"]
    child = await client.post(_BASE + f"/defects/{d['id']}/comments",
                              json={"project_id": pid, "content": "回复", "parent_id": rid}, headers=hm)
    assert child.status_code == 201 and child.json()["reply_user_id"] == boss.id
    grand = await client.post(_BASE + f"/defects/{d['id']}/comments",
                              json={"project_id": pid, "content": "三层", "parent_id": child.json()["id"]},
                              headers=hm)
    assert grand.status_code == 422, "只支持两层"

    tree = await client.get(_BASE + f"/defects/{d['id']}/comments", params={"project_id": pid}, headers=hb)
    assert tree.json()["total"] == 2
    assert tree.json()["items"][0]["children"][0]["content"] == "回复"

    deny = await client.patch(_BASE + f"/defect-comments/{rid}",
                              json={"project_id": pid, "content": "改"}, headers=hm)
    assert deny.status_code == 403
    own = await client.patch(_BASE + f"/defect-comments/{rid}",
                             json={"project_id": pid, "content": "改"}, headers=hb)
    assert own.status_code == 200 and own.json()["content"] == "改"

    dl = await client.post(_BASE + f"/defect-comments/{rid}/delete",
                           json={"project_id": pid, "comment_id": rid}, headers=hb)
    assert dl.status_code == 200
    left = await client.get(_BASE + f"/defects/{d['id']}/comments", params={"project_id": pid}, headers=hb)
    assert left.json()["total"] == 0, "父删必须连子删"


# ══════════ 6. 关注：幂等 + 写位 ══════════
async def test_follow_is_idempotent_and_write_gated(client, make_user) -> None:
    boss, hb = await make_user("d191f1", admin=True)
    ro, hr = await make_user("d191f2")
    pid = await _proj(client, hb, "D191关注")
    await _member(client, hb, pid, ro.id, "READONLY")
    d = await _create(client, hb, pid, "关注我")
    f1 = await client.post(_BASE + f"/defects/{d['id']}/follow", json={"project_id": pid}, headers=hb)
    f2 = await client.post(_BASE + f"/defects/{d['id']}/follow", json={"project_id": pid}, headers=hb)
    assert f1.json()["following"] is True and f1.json()["follower_count"] == 1
    assert f2.json()["follower_count"] == 1, "关注必须幂等"
    deny = await client.post(_BASE + f"/defects/{d['id']}/follow", json={"project_id": pid}, headers=hr)
    assert deny.status_code == 403 and deny.json()["details"]["perm"] == "defect:defect:update"
    uf = await client.post(_BASE + f"/defects/{d['id']}/unfollow", json={"project_id": pid}, headers=hb)
    assert uf.json()["follower_count"] == 0


# ══════════ 7. 关联用例 ══════════
async def test_case_links_candidates_dedup_and_missing(client, make_user) -> None:
    boss, hb = await make_user("d191l1", admin=True)
    pid = await _proj(client, hb, "D191关联")
    other = await _proj(client, hb, "D191关联B")
    d = await _create(client, hb, pid, "关联缺陷")
    s = await client.post(_BASE + "/scenarios", json={"project_id": pid, "name": "场景甲"}, headers=hb)
    assert s.status_code == 201, s.text
    sid = s.json()["id"]
    foreign = await client.post(_BASE + "/scenarios", json={"project_id": other, "name": "别人家的场景"}, headers=hb)
    assert foreign.status_code == 201

    cand = await client.get(_BASE + "/defect-link-candidates",
                            params={"project_id": pid, "defect_id": d["id"], "case_type": "scenario"},
                            headers=hb)
    assert cand.status_code == 200 and [x["id"] for x in cand.json()["items"]] == [sid], \
        "候选只列本项目、未关联的用例"

    add = await client.post(_BASE + "/defect-links",
                            json={"project_id": pid, "defect_id": d["id"], "case_type": "scenario",
                                  "case_ids": [sid, sid]}, headers=hb)
    assert add.status_code == 201 and add.json() == {"created": 1, "skipped": 1}
    again = await client.post(_BASE + "/defect-links",
                              json={"project_id": pid, "defect_id": d["id"], "case_type": "scenario",
                                    "case_ids": [sid]}, headers=hb)
    assert again.json()["skipped"] == 1
    empty = await client.get(_BASE + "/defect-link-candidates",
                             params={"project_id": pid, "defect_id": d["id"], "case_type": "scenario"},
                             headers=hb)
    assert empty.json()["items"] == []

    links = await client.get(_BASE + f"/defects/{d['id']}/case-links", params={"project_id": pid}, headers=hb)
    assert links.status_code == 200 and links.json()["total"] == 1
    link = links.json()["items"][0]
    assert link["case_name"] == "场景甲" and link["case_exists"] is True

    missing = await client.post(_BASE + "/defect-links",
                                json={"project_id": pid, "defect_id": d["id"], "case_type": "scenario",
                                      "case_ids": ["nope"]}, headers=hb)
    assert missing.status_code == 422 and missing.json()["code"] == "unknown_case"

    rm = await client.post(_BASE + f"/defect-links/{link['id']}/delete",
                           json={"project_id": pid, "defect_id": d["id"], "link_id": link["id"]}, headers=hb)
    assert rm.status_code == 200
    after = await client.get(_BASE + f"/defects/{d['id']}/case-links", params={"project_id": pid}, headers=hb)
    assert after.json()["total"] == 0


# ══════════ 8. 跨项目同 404 ══════════
async def test_cross_project_is_verbatim_not_found(client, make_user) -> None:
    boss, hb = await make_user("d191x1", admin=True)
    pid = await _proj(client, hb, "D191跨A")
    pid2 = await _proj(client, hb, "D191跨B")
    d = await _create(client, hb, pid, "只在A")
    r = await client.get(_BASE + f"/defects/{d['id']}", params={"project_id": pid2}, headers=hb)
    assert r.status_code == 404 and r.json()["message"] == "缺陷不存在"
    u = await client.patch(_BASE + f"/defects/{d['id']}", json={"project_id": pid2, "title": "越权改"}, headers=hb)
    assert u.status_code == 404 and u.json()["message"] == "缺陷不存在"


# ══════════ 9. 导出 ══════════
async def test_export_csv_and_missing_note(client, make_user) -> None:
    boss, hb = await make_user("d191e1", admin=True)
    pid = await _proj(client, hb, "D191导出")
    a = await _create(client, hb, pid, "导出甲", tags=["标签1"])
    await _create(client, hb, pid, "导出乙")
    # CSV 公式注入：以 = 开头的标题在 Excel 里会被当公式执行 → 导出时加前导单引号
    await _create(client, hb, pid, "=1+1")
    out = await client.post(_BASE + "/defects/export", json={"project_id": pid}, headers=hb)
    assert out.status_code == 200, out.text
    body = out.json()
    assert body["exported"] == 3 and body["filename"].endswith(".csv")
    assert "标题" in body["content"] and "导出甲" in body["content"] and "导出乙" in body["content"]
    assert "'=1+1" in body["content"], "公式开头的单元格必须被中和（CSV 注入防护）"
    assert body["content"].startswith("\ufeff"), "CSV 带 BOM，Excel 才不乱码"

    partial = await client.post(_BASE + "/defects/export",
                                json={"project_id": pid, "defect_ids": [a["id"], "ghost"]}, headers=hb)
    assert partial.json()["exported"] == 1 and partial.json()["notes"], "缺 id 必须如实报"
    cols = await client.get(_BASE + "/defect-export-columns", params={"project_id": pid}, headers=hb)
    assert cols.status_code == 200 and cols.json()["columns"][0]["key"] == "num"


# ══════════ 10. 权限：MEMBER 不能删、READONLY 不能建 ══════════
async def test_role_gates(client, make_user) -> None:
    boss, hb = await make_user("d191r1", admin=True)
    mem, hm = await make_user("d191r2")
    ro, hr = await make_user("d191r3")
    pid = await _proj(client, hb, "D191权限")
    await _member(client, hb, pid, mem.id, "MEMBER")
    await _member(client, hb, pid, ro.id, "READONLY")
    d = await _create(client, hb, pid, "权限对象")
    deny_del = await client.post(_BASE + f"/defects/{d['id']}/delete",
                                 json={"project_id": pid, "defect_id": d["id"]}, headers=hm)
    assert deny_del.status_code == 403 and deny_del.json()["details"]["perm"] == "defect:defect:delete"
    deny_create = await client.post(_BASE + "/defects",
                                    json={"project_id": pid, "title": "只读别建"}, headers=hr)
    assert deny_create.status_code == 403 and deny_create.json()["details"]["perm"] == "defect:defect:create"
    can_read = await client.get(_BASE + "/defects", params={"project_id": pid}, headers=hr)
    assert can_read.status_code == 200 and can_read.json()["total"] == 1
