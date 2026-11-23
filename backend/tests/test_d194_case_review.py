"""D194：用例评审（模块树 / 评审 / 关联 / 评审人 / 结论 / 重审 / 权限）。"""
from __future__ import annotations

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


async def _review(client, h, pid: str, name: str, **kw):
    return await client.post(_BASE + "/case-reviews",
                             json={"project_id": pid, "name": name, **kw}, headers=h)


async def _get(client, h, pid: str, rid: str):
    return await client.get(_BASE + f"/case-reviews/{rid}", params={"project_id": pid}, headers=h)


async def _submit(client, h, pid: str, rid: str, cid: str, action: str, comment: str | None = None):
    return await client.post(_BASE + f"/case-reviews/{rid}/cases/{cid}/results", json={
        "project_id": pid, "review_id": rid, "case_id": cid,
        "action": action, "comment": comment,
    }, headers=h)


# ══════════ 1. 迁移形状 ══════════
async def test_review_tables_shape(conn) -> None:
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "rcols": {c["name"] for c in insp.get_columns("case_review")},
            "ruq": {u["name"] for u in insp.get_unique_constraints("case_review")},
            "cuq": {u["name"] for u in insp.get_unique_constraints("case_review_case")},
            "rpk": tuple(insp.get_pk_constraint("case_review_reviewer")["constrained_columns"]),
        }

    got = await conn.run_sync(_read)
    assert {"case_review_module", "case_review", "case_review_case",
            "case_review_reviewer", "case_review_result"} <= got["tables"]
    assert "status" not in got["rcols"], "评审状态必须读时聚合，不在库里存第二份"
    assert "pass_rate" not in got["rcols"] and "case_count" not in got["rcols"]
    assert "uq_case_review_project_num" in got["ruq"]
    assert "uq_case_review_case_pair" in got["cuq"]
    assert got["rpk"] == ("review_id", "case_id", "user_id")


# ══════════ 2. 评审模块树 ══════════
async def test_review_module_tree_and_guards(client, make_user) -> None:
    _, h = await make_user("d194m", admin=True)
    pid = await _proj(client, h, "D194模块")
    root = await client.post(_BASE + "/case-review-modules",
                             json={"project_id": pid, "name": "登录评审"}, headers=h)
    assert root.status_code == 201, root.text
    child = await client.post(_BASE + "/case-review-modules",
                              json={"project_id": pid, "name": "子评审", "parent_id": root.json()["id"]},
                              headers=h)
    assert child.status_code == 201
    dup = await client.post(_BASE + "/case-review-modules",
                            json={"project_id": pid, "name": "登录评审"}, headers=h)
    assert dup.status_code == 409
    tree = await client.get(_BASE + "/case-review-modules/tree", params={"project_id": pid}, headers=h)
    assert tree.json()["tree"][0]["children"][0]["name"] == "子评审"
    cyc = await client.patch(_BASE + f"/case-review-modules/{root.json()['id']}", json={
        "project_id": pid, "parent_id": child.json()["id"], "parent_set": True,
    }, headers=h)
    assert cyc.status_code == 422 and cyc.json()["code"] == "cycle"
    dele = await client.post(_BASE + f"/case-review-modules/{root.json()['id']}/delete",
                             json={"project_id": pid, "module_id": root.json()["id"]}, headers=h)
    assert dele.status_code == 409 and dele.json()["code"] == "module_not_empty"
    # 回收子模块后删根；恢复子模块时父在回收站 → 409
    await client.post(_BASE + f"/case-review-modules/{child.json()['id']}/delete",
                      json={"project_id": pid, "module_id": child.json()["id"]}, headers=h)
    assert (await client.post(_BASE + f"/case-review-modules/{root.json()['id']}/delete",
                              json={"project_id": pid, "module_id": root.json()["id"]},
                              headers=h)).status_code == 200
    res_child = await client.post(_BASE + f"/case-review-modules/{child.json()['id']}/restore",
                                  json={"project_id": pid, "module_id": child.json()["id"]}, headers=h)
    assert res_child.status_code == 409 and res_child.json()["code"] == "parent_recycled"


# ══════════ 3. 单评审人规则 + 历史 + 校验 ══════════
async def test_single_rule_results_history_and_permissions(client, make_user) -> None:
    boss, hb = await make_user("d194s", admin=True)
    rev, hr = await make_user("d194rev")
    out, ho = await make_user("d194out")
    pid = await _proj(client, hb, "D194单规则")
    for u in (rev, out):
        await _member(client, hb, pid, u.id)
    c = await _case(client, hb, pid, "登录成功")
    r = await _review(client, hb, pid, "单规则评审", case_ids=[c["id"]], reviewer_ids=[rev.id])
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert r.json()["num"] == 100001 and r.json()["status"] == "not_started"
    assert r.json()["case_count"] == 1 and r.json()["reviewer_count"] == 1

    sugg = await _submit(client, hr, pid, rid, c["id"], "suggestion", "先看看")
    assert sugg.status_code == 201, sugg.text
    assert sugg.json()["result"] == "pending"
    mid = await _get(client, hb, pid, rid)
    assert mid.json()["status"] == "in_review" and mid.json()["started"] is True

    fail_no_comment = await _submit(client, hr, pid, rid, c["id"], "fail")
    assert fail_no_comment.status_code == 422 and fail_no_comment.json()["code"] == "comment_required"
    outsider = await _submit(client, ho, pid, rid, c["id"], "pass")
    assert outsider.status_code == 403

    passed = await _submit(client, hr, pid, rid, c["id"], "pass")
    assert passed.status_code == 201 and passed.json()["result"] == "pass"
    done = await _get(client, hb, pid, rid)
    assert done.json()["status"] == "completed"
    assert done.json()["pass_rate"] == 100 and done.json()["pass_count"] == 1

    hist = await client.get(_BASE + f"/case-reviews/{rid}/cases/{c['id']}/results",
                            params={"project_id": pid}, headers=hb)
    assert hist.status_code == 200
    actions = [(x["action"], x["active"]) for x in hist.json()["items"]]
    assert ("pass", True) in actions and ("suggestion", False) in actions

    # 用例视角反查
    side = await client.get(_BASE + f"/functional-cases/{c['id']}/reviews",
                            params={"project_id": pid}, headers=hb)
    assert side.json()["items"][0]["review_id"] == rid
    assert side.json()["items"][0]["result"] == "pass"


# ══════════ 4. 多人规则 + 重审 ══════════
async def test_multiple_rule_and_re_review(client, make_user) -> None:
    boss, hb = await make_user("d194b", admin=True)
    r1, h1 = await make_user("d194r1")
    r2, h2 = await make_user("d194r2")
    pid = await _proj(client, hb, "D194多规则")
    for u in (r1, r2):
        await _member(client, hb, pid, u.id)
    c = await _case(client, hb, pid, "多人评审用例")
    r = await _review(client, hb, pid, "多人评审", pass_rule="multiple",
                      case_ids=[c["id"]], reviewer_ids=[r1.id, r2.id])
    assert r.status_code == 201, r.text
    rid = r.json()["id"]

    assert (await _submit(client, h1, pid, rid, c["id"], "pass")).json()["result"] == "pending"
    both = await _submit(client, h2, pid, rid, c["id"], "pass")
    assert both.json()["result"] == "pass"
    assert (await _get(client, hb, pid, rid)).json()["status"] == "completed"

    failed = await _submit(client, h1, pid, rid, c["id"], "fail", "回归失败")
    assert failed.json()["result"] == "fail"
    assert (await _get(client, hb, pid, rid)).json()["pass_rate"] == 0

    rr = await client.post(_BASE + f"/case-reviews/{rid}/cases/{c['id']}/re-review",
                           json={"project_id": pid, "review_id": rid, "case_id": c["id"]}, headers=hb)
    assert rr.status_code == 200, rr.text
    assert rr.json()["result"] == "pending" and rr.json()["re_review"] is True
    assert (await _get(client, hb, pid, rid)).json()["status"] == "in_review"

    # 重审后旧结论全部作废：两人重新 pass 才完成
    assert (await _submit(client, h1, pid, rid, c["id"], "pass")).json()["result"] == "pending"
    assert (await _submit(client, h2, pid, rid, c["id"], "pass")).json()["result"] == "pass"


# ══════════ 5. 关联/取消/换评审人 ══════════
async def test_associate_disassociate_and_reviewers(client, make_user) -> None:
    boss, hb = await make_user("d194a", admin=True)
    r1, h1 = await make_user("d194a1")
    r2, h2 = await make_user("d194a2")
    pid = await _proj(client, hb, "D194关联")
    for u in (r1, r2):
        await _member(client, hb, pid, u.id)
    c1 = await _case(client, hb, pid, "用例一")
    c2 = await _case(client, hb, pid, "用例二")
    r = await _review(client, hb, pid, "关联评审", case_ids=[c1["id"]], reviewer_ids=[r1.id])
    rid = r.json()["id"]

    add = await client.post(_BASE + f"/case-reviews/{rid}/cases", json={
        "project_id": pid, "review_id": rid, "case_ids": [c2["id"], c2["id"]],
    }, headers=hb)
    assert add.status_code == 200 and add.json() == {"created": 1, "skipped": 1}
    again = await client.post(_BASE + f"/case-reviews/{rid}/cases", json={
        "project_id": pid, "review_id": rid, "case_ids": [c2["id"]],
    }, headers=hb)
    assert again.json()["skipped"] == 1
    listing = await client.get(_BASE + f"/case-reviews/{rid}/cases", params={"project_id": pid}, headers=hb)
    assert listing.json()["total"] == 2

    # 把 c1 的评审人从 r1 换成 r2：r1 的通过不再算数 → pending
    await _submit(client, h1, pid, rid, c1["id"], "pass")
    assert (await _get(client, hb, pid, rid)).json()["pass_count"] == 1
    sw = await client.post(_BASE + f"/case-reviews/{rid}/cases/reviewers", json={
        "project_id": pid, "review_id": rid, "case_ids": [c1["id"]],
        "reviewer_ids": [r2.id], "mode": "replace",
    }, headers=hb)
    assert sw.status_code == 200
    row = [x for x in (await client.get(_BASE + f"/case-reviews/{rid}/cases",
                                        params={"project_id": pid}, headers=hb)).json()["items"]
           if x["case_id"] == c1["id"]][0]
    assert row["result"] == "pending" and [x["user_id"] for x in row["reviewers"]] == [r2.id]

    dis = await client.post(_BASE + f"/case-reviews/{rid}/cases/{c1['id']}/delete",
                            json={"project_id": pid, "review_id": rid, "case_id": c1["id"]}, headers=hb)
    assert dis.status_code == 200
    assert (await client.get(_BASE + f"/case-reviews/{rid}/cases",
                             params={"project_id": pid}, headers=hb)).json()["total"] == 1


# ══════════ 6. 角色门/跨项目/删除评审 ══════════
async def test_roles_cross_project_and_delete(client, make_user) -> None:
    boss, hb = await make_user("d194p", admin=True)
    mem, hm = await make_user("d194p2")
    ro, hr = await make_user("d194p3")
    # 403 的写请求会 rollback 并过期同 session 的 ORM 实例；先取标量
    mem_id, ro_id = mem.id, ro.id
    pid = await _proj(client, hb, "D194权限")
    pid2 = await _proj(client, hb, "D194权限B")
    for uid, role in ((mem_id, "MEMBER"), (ro_id, "READONLY")):
        await _member(client, hb, pid, uid, role)
    c = await _case(client, hb, pid, "权限用例")
    deny_create = await _review(client, hr, pid, "只读别建")
    assert deny_create.status_code == 403 and deny_create.json()["details"]["perm"] == "review:review:create"
    r = await _review(client, hb, pid, "权限评审", case_ids=[c["id"]], reviewer_ids=[mem_id])
    rid = r.json()["id"]
    assert (await _get(client, hr, pid, rid)).status_code == 200
    deny_submit = await _submit(client, hr, pid, rid, c["id"], "pass")
    assert deny_submit.status_code == 403 and deny_submit.json()["details"]["perm"] == "review:result:create"
    deny_del = await client.post(_BASE + f"/case-reviews/{rid}/delete",
                                 json={"project_id": pid, "review_id": rid, "confirm_name": "权限评审"},
                                 headers=hm)
    assert deny_del.status_code == 403 and deny_del.json()["details"]["perm"] == "review:review:delete"
    cross = await _get(client, hb, pid2, rid)
    assert cross.status_code == 404 and cross.json()["message"] == "评审不存在"
    wrong = await client.post(_BASE + f"/case-reviews/{rid}/delete",
                              json={"project_id": pid, "review_id": rid, "confirm_name": "错"},
                              headers=hb)
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch"
    ok = await client.post(_BASE + f"/case-reviews/{rid}/delete",
                           json={"project_id": pid, "review_id": rid, "confirm_name": "权限评审"},
                           headers=hb)
    assert ok.status_code == 200
    n = (await client.get(_BASE + "/case-reviews", params={"project_id": pid}, headers=hb)).json()["total"]
    assert n == 0
