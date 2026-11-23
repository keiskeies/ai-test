"""D207 判据刀：计划缺陷清单（只读聚合）+ 功能用例可关联缺陷。

钉的契约（一条判断一条用例）：

1. **链路贯通**：功能用例（D193）关联缺陷 → 挂进计划 → 计划缺陷清单读得到；
   同一条缺陷被计划内两个用例指向时**只出一道**（MS `getTestPlanBug` 的 distinct 口径）。
2. **回收站不出现**：缺陷回收后清单读不到，恢复后重新出现（不建快照、读时现取）。
3. **跨项目隔离**：别项目的缺陷不进本计划；用别项目的 plan_id 取本项目的清单 = 404。
4. **空计划空列表**：total=0、items=[]，不报错（与「计划不存在」区分）。
5. **筛选下推**：status/priority/keyword 三个筛选按同一谓词算 total。
6. **权限**：READONLY 可读（只读面），写路径不受影响。
"""
from __future__ import annotations

from app.modules.functional.models import FunctionalCase

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(
        _BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=h
    )
    assert r.status_code == 200, r.text


async def _seed_case(session, pid: str, *, case_id: str, num: int, name: str) -> None:
    session.add(
        FunctionalCase(id=case_id, project_id=pid, num=num, name=name, template_id="tpl-seed")
    )
    await session.commit()


async def _defect(client, h, pid: str, title: str, **kw) -> dict:
    r = await client.post(
        _BASE + "/defects", json={"project_id": pid, "title": title, **kw}, headers=h
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _link_defect(client, h, pid: str, defect_id: str, case_ids: list[str]):
    return await client.post(
        _BASE + "/defect-links",
        json={
            "project_id": pid,
            "defect_id": defect_id,
            "case_type": "functional_case",
            "case_ids": case_ids,
        },
        headers=h,
    )


async def _link_plan(client, h, pid: str, plan_id: str, subject_id: str):
    r = await client.post(
        _BASE + f"/plans/{plan_id}/case-links",
        json={"project_id": pid, "subject_type": "functional_case", "subject_id": subject_id},
        headers=h,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _bugs(client, h, pid: str, plan_id: str, **params) -> dict:
    r = await client.get(
        _BASE + f"/plans/{plan_id}/bugs",
        params=[("project_id", pid)] + [(k, str(v)) for k, v in params.items()],
        headers=h,
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_plan_bug_list_reads_functional_case_links_deduped(
    client, session, make_user
) -> None:
    """功能用例 → 缺陷 → 计划：一条缺陷被两个计划内用例指向，清单只出一道。"""
    _, h = await make_user("d207a", admin=True)
    pid = await _proj(client, h, "D207清单")
    pl = await _plan(client, h, pid, "缺陷计划")
    await _seed_case(session, pid, case_id="fc-1", num=100001, name="登录成功")
    await _seed_case(session, pid, case_id="fc-2", num=100002, name="登录失败提示")

    d = await _defect(client, h, pid, "登录接口 500", priority="P1", tags=["登录", "后端"])
    add = await _link_defect(client, h, pid, d["id"], ["fc-1", "fc-2"])
    assert add.status_code == 201, add.text
    assert add.json()["created"] == 2
    await _link_plan(client, h, pid, pl["id"], "fc-1")
    await _link_plan(client, h, pid, pl["id"], "fc-2")

    out = await _bugs(client, h, pid, pl["id"])
    assert out["total"] == 1, "同一条缺陷被两条计划内用例指向，清单必须去重"
    assert len(out["items"]) == 1
    row = out["items"][0]
    assert row["id"] == d["id"]
    assert row["num"] == d["num"]
    assert row["title"] == "登录接口 500"
    assert row["status"] == "new" and row["priority"] == "P1"
    assert row["tags"] == ["登录", "后端"]


async def test_plan_bug_list_excludes_recycled_and_returns_after_restore(
    client, session, make_user
) -> None:
    """回收站里的缺陷不出现；恢复后读回同一行（清单不存快照）。"""
    _, h = await make_user("d207b", admin=True)
    pid = await _proj(client, h, "D207回收")
    pl = await _plan(client, h, pid, "回收计划")
    await _seed_case(session, pid, case_id="fc-r", num=100010, name="回收用例")
    d = await _defect(client, h, pid, "待回收缺陷")
    await _link_defect(client, h, pid, d["id"], ["fc-r"])
    await _link_plan(client, h, pid, pl["id"], "fc-r")
    assert (await _bugs(client, h, pid, pl["id"]))["total"] == 1

    body = {"project_id": pid, "defect_id": d["id"]}
    dele = await client.post(_BASE + f"/defects/{d['id']}/delete", json=body, headers=h)
    assert dele.status_code == 200, dele.text
    out = await _bugs(client, h, pid, pl["id"])
    assert out["total"] == 0 and out["items"] == []

    res = await client.post(_BASE + f"/defects/{d['id']}/restore", json=body, headers=h)
    assert res.status_code == 200, res.text
    assert (await _bugs(client, h, pid, pl["id"]))["total"] == 1


async def test_plan_bug_list_cross_project_isolation(client, session, make_user) -> None:
    """别项目的缺陷不进本计划；用别项目 plan_id 取本项目清单 = 404（不泄露存在性）。"""
    _, h = await make_user("d207c", admin=True)
    pa = await _proj(client, h, "D207项目A")
    pb = await _proj(client, h, "D207项目B")
    pla = await _plan(client, h, pa, "A计划")
    plb = await _plan(client, h, pb, "B计划")
    await _seed_case(session, pa, case_id="a-c", num=100020, name="A用例")
    await _seed_case(session, pb, case_id="b-c", num=100021, name="B用例")
    da = await _defect(client, h, pa, "A缺陷")
    db = await _defect(client, h, pb, "B缺陷")
    await _link_defect(client, h, pa, da["id"], ["a-c"])
    await _link_defect(client, h, pb, db["id"], ["b-c"])
    await _link_plan(client, h, pa, pla["id"], "a-c")
    await _link_plan(client, h, pb, plb["id"], "b-c")

    outa = await _bugs(client, h, pa, pla["id"])
    assert [r["id"] for r in outa["items"]] == [da["id"]]
    outb = await _bugs(client, h, pb, plb["id"])
    assert [r["id"] for r in outb["items"]] == [db["id"]]

    # B 的计划 id + A 的项目 id：计划按 (id, project_id) 取 → 404，与「不存在」同码同文案。
    r = await client.get(
        _BASE + f"/plans/{plb['id']}/bugs", params={"project_id": pa}, headers=h
    )
    assert r.status_code == 404, r.text
    assert r.json()["message"] == "计划不存在"


async def test_plan_bug_list_empty_plan_and_filters(client, session, make_user) -> None:
    """空计划 = 空列表而非 404；status/priority/keyword 下推且 total 同谓词。"""
    _, h = await make_user("d207d", admin=True)
    pid = await _proj(client, h, "D207筛选")
    pl = await _plan(client, h, pid, "筛选计划")
    empty = await _bugs(client, h, pid, pl["id"])
    assert empty["total"] == 0 and empty["items"] == []

    await _seed_case(session, pid, case_id="fc-f", num=100030, name="筛选用例")
    d1 = await _defect(client, h, pid, "登录超时", priority="P0")
    d2 = await _defect(client, h, pid, "支付失败", priority="P2")
    await _link_defect(client, h, pid, d1["id"], ["fc-f"])
    await _link_defect(client, h, pid, d2["id"], ["fc-f"])
    await _link_plan(client, h, pid, pl["id"], "fc-f")

    assert (await _bugs(client, h, pid, pl["id"]))["total"] == 2
    by_priority = await _bugs(client, h, pid, pl["id"], priority="P0")
    assert [r["id"] for r in by_priority["items"]] == [d1["id"]]
    assert by_priority["total"] == 1
    by_keyword = await _bugs(client, h, pid, pl["id"], keyword="支付")
    assert [r["id"] for r in by_keyword["items"]] == [d2["id"]]
    assert (await _bugs(client, h, pid, pl["id"], status="closed"))["total"] == 0
    # 页码：size=1 时两页拼起来恰是全集（确定性排序，不重不漏）。
    p1 = await _bugs(client, h, pid, pl["id"], current=1, size=1)
    p2 = await _bugs(client, h, pid, pl["id"], current=2, size=1)
    assert {r["id"] for r in p1["items"]} | {r["id"] for r in p2["items"]} == {d1["id"], d2["id"]}
    assert p1["items"][0]["id"] != p2["items"][0]["id"]


async def test_plan_bug_list_readonly_can_read(client, session, make_user) -> None:
    """READONLY 只读放行（清单是只读投影，与 plan_link_list 同权限位）。"""
    _, hb = await make_user("d207e-boss", admin=True)
    ro, hro = await make_user("d207e-ro")
    pid = await _proj(client, hb, "D207只读")
    await _member(client, hb, pid, ro.id, "READONLY")
    pl = await _plan(client, hb, pid, "只读计划")
    await _seed_case(session, pid, case_id="fc-ro", num=100040, name="只读用例")
    d = await _defect(client, hb, pid, "只读缺陷")
    await _link_defect(client, hb, pid, d["id"], ["fc-ro"])
    await _link_plan(client, hb, pid, pl["id"], "fc-ro")

    out = await _bugs(client, hro, pid, pl["id"])
    assert [r["id"] for r in out["items"]] == [d["id"]]
