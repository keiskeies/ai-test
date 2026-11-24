"""D279：计划补测试阶段/计划与实际起止/责任人（对齐 MS 计划列表六列）。

钉五条：
① 六列**创建可写、列表/详情可读**（owner_name 由读路批量解析，不画裸 UUID）；
② 更新路径的 `*_set` 三态：不带 = 不动、带 null = 清空、带值 = 改；
③ 两对时刻的先后校验在**合并后的现值**上做（只改一端也要和另一端比），结束早于开始 422；
④ 责任人必须是本项目成员（项目外的人 422，不落一条没人认领的假指派）；
⑤ 复制计划随源抄这六列（复制的是「同一套计划安排」，不是「上一轮的结论」）。

不钉的东西（保持既有裁定）：可见性仍按 project_id 显式过滤，owner_id **不是**可见性列
（test_d183_plan_crud 的源码扫描继续守「不接 visibility」）。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_create_roundtrip_and_read_paths(client, make_user) -> None:
    """①：建计划带六列 → 列表行/详情原样读回，owner_name 解析成人名。"""
    boss, h = await make_user("d279a")
    boss_id, boss_name = boss.id, boss.name
    pid = await _proj(client, h, "D279 计划六列")

    r = await client.post(_BASE + "/plans", headers=h, json={
        "project_id": pid,
        "name": "结算回归 v2",
        "description": "覆盖跨期结算",
        "stage": "系统测试",
        "planned_start": "2026-11-20T10:30:00+08:00",
        "planned_end": "2026-11-21T18:00:00+08:00",
        "actual_start": "2026-11-20T11:00:00+08:00",
        "actual_end": None,
        "owner_id": boss_id,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["stage"] == "系统测试"
    assert body["owner_id"] == boss_id
    assert body["owner_name"] == boss_name, "写路径回执也要带姓名（前端原地替换行）"
    # DB 存 naive UTC，出参统一带偏移（schemas.iso）；只钉时刻值，不钉偏移写法
    assert body["planned_start"].startswith("2026-11-20T02:30:00")
    assert body["planned_end"].startswith("2026-11-21T10:00:00")
    assert body["actual_start"].startswith("2026-11-20T03:00:00")
    assert body["actual_end"] is None

    lst = await client.get(_BASE + "/plans", headers=h,
                           params=[("project_id", pid), ("current", "1"), ("size", "50")])
    assert lst.status_code == 200, lst.text
    row = next(i for i in lst.json()["items"] if i["id"] == body["id"])
    assert row["stage"] == "系统测试"
    assert row["owner_name"] == boss_name
    assert row["planned_end"].startswith("2026-11-21T10:00:00")

    got = await client.get(_BASE + "/plans/" + body["id"], headers=h,
                           params={"project_id": pid})
    assert got.status_code == 200, got.text
    assert got.json()["owner_name"] == boss_name
    assert got.json()["actual_start"].startswith("2026-11-20T03:00:00")


async def test_update_sentinels_three_states(client, make_user) -> None:
    """②③：不带 = 不动；带 null = 清空；带值 = 改；只改一端时按合并后现值校验先后。"""
    _, h = await make_user("d279b")
    pid = await _proj(client, h, "D279 三态")
    aid = (await client.post(_BASE + "/plans", headers=h, json={
        "project_id": pid, "name": "三态计划",
        "stage": "冒烟", "planned_start": "2026-11-20T09:00:00+08:00",
        "planned_end": "2026-11-20T18:00:00+08:00",
    })).json()["id"]

    # 只改 stage：其余三个时刻不带哨兵 → 一个都不许动
    r = await client.patch(_BASE + "/plans/" + aid, headers=h, json={
        "project_id": pid, "stage": "回归", "stage_set": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["stage"] == "回归"
    assert r.json()["planned_start"].startswith("2026-11-20T01:00:00")

    # 清空 stage + planned_start：带 set + null = 真清空（不是「不改」）
    r = await client.patch(_BASE + "/plans/" + aid, headers=h, json={
        "project_id": pid, "stage": None, "stage_set": True,
        "planned_start": None, "planned_start_set": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["stage"] is None
    assert r.json()["planned_start"] is None
    assert r.json()["planned_end"].startswith("2026-11-20T10:00:00"), "没带的字段被误改/误清"

    # 只改 planned_end 到开始之前 → 422（用合并后的现值比：start 已在库，end 是本次改的）
    r = await client.patch(_BASE + "/plans/" + aid, headers=h, json={
        "project_id": pid,
        "planned_start": "2026-11-20T09:00:00+08:00", "planned_start_set": True,
        "planned_end": "2026-11-20T08:00:00+08:00", "planned_end_set": True,
    })
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "invalid_time_range"

    # 清空两端都带 set 是合法的（没有先后可违约）
    r = await client.patch(_BASE + "/plans/" + aid, headers=h, json={
        "project_id": pid, "planned_start": None, "planned_start_set": True,
        "planned_end": None, "planned_end_set": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["planned_start"] is None and r.json()["planned_end"] is None


async def test_owner_must_be_project_member(client, make_user) -> None:
    """④：项目外的人不能当责任人（422 invalid_owner），不是本项目成员也不泄露别处信息。"""
    _, h = await make_user("d279c")
    outsider, _ = await make_user("d279c_out")
    outsider_id = outsider.id  # 先取：后续请求会把 ORM 实例 expire 掉
    pid = await _proj(client, h, "D279 责任人")

    r = await client.post(_BASE + "/plans", headers=h, json={
        "project_id": pid, "name": "越界责任人", "owner_id": outsider_id,
    })
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "invalid_owner"

    # 建出来的计划（无责任人）上改成项目外的人同样拒绝
    aid = (await client.post(_BASE + "/plans", headers=h, json={
        "project_id": pid, "name": "无责任人",
    })).json()["id"]
    r = await client.patch(_BASE + "/plans/" + aid, headers=h, json={
        "project_id": pid, "owner_id": outsider_id, "owner_set": True,
    })
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "invalid_owner"


async def test_create_time_range_validation(client, make_user) -> None:
    """③：创建路径同样校验两对时刻（实际结束早于实际开始 → 422）。"""
    _, h = await make_user("d279d")
    pid = await _proj(client, h, "D279 起止校验")
    r = await client.post(_BASE + "/plans", headers=h, json={
        "project_id": pid, "name": "倒挂计划",
        "actual_start": "2026-11-22T10:00:00+08:00",
        "actual_end": "2026-11-22T09:00:00+08:00",
    })
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "invalid_time_range"


async def test_copy_carries_schedule_and_owner(client, make_user) -> None:
    """⑤：复制随源抄六列；归档位仍不抄（复制件是可用的新计划）。"""
    boss, h = await make_user("d279e")
    boss_id, boss_name = boss.id, boss.name
    pid = await _proj(client, h, "D279 复制")
    src = (await client.post(_BASE + "/plans", headers=h, json={
        "project_id": pid, "name": "源计划", "stage": "验收",
        "planned_start": "2026-11-20T09:00:00+08:00",
        "planned_end": "2026-11-25T18:00:00+08:00",
        "owner_id": boss_id,
    })).json()["id"]
    await client.post(_BASE + "/plans/" + src + "/archive", headers=h, json={"project_id": pid})

    r = await client.post(_BASE + "/plans/" + src + "/copy", headers=h,
                          json={"project_id": pid, "name": "复制件"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["archived"] is False
    assert body["stage"] == "验收"
    assert body["owner_id"] == boss_id and body["owner_name"] == boss_name
    assert body["planned_start"].startswith("2026-11-20T01:00:00")
    assert body["planned_end"].startswith("2026-11-25T10:00:00")
