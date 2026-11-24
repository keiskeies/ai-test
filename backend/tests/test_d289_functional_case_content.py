"""D289 判据刀：功能用例补 MS v2 表单四项（前置条件 / 步骤 / 备注 / 用例状态）。

钉的契约：
1. 创建可写四项：步骤是 `[{desc, expected}]` 数组，两列全空的行不落库；用例状态默认 prepare。
2. 列表/详情/回执三处同形（同一份 `_case_out`），不出现「表单写了但读不回来」。
3. 更新三态：不带 = 不改、带 null/[] = 清空、带值 = 改；case_status 非空即改。
4. 词表外状态、超长步骤行、超行数都是 422（写入口不能把脏值放进库）。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _setup(client, make_user, name="d289"):
    _, h = await make_user(name)
    r = await client.post(_BASE + "/projects", json={"name": name + "_proj"}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _case(client, h, pid, name, **kw):
    return await client.post(_BASE + "/functional-cases",
                            json={"project_id": pid, "name": name, **kw}, headers=h)


async def test_content_fields_roundtrip(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    steps = [
        {"desc": "打开登录页", "expected": "看到账号密码框"},
        {"desc": "输入正确账号", "expected": "登录成功"},
        {"desc": "", "expected": ""},  # 两列全空：不落库
    ]
    r = await _case(client, h, pid, "完整用例", precondition="已注册账号",
                    steps=steps, remark="冒烟必跑", case_status="underway")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["precondition"] == "已注册账号"
    assert body["remark"] == "冒烟必跑"
    assert body["case_status"] == "underway"
    assert body["steps"] == steps[:2], "全空行不落库，也不在回执里画假空行"

    got = await client.get(_BASE + f"/functional-cases/{body['id']}",
                           params={"project_id": pid}, headers=h)
    assert got.status_code == 200
    assert got.json()["steps"] == steps[:2]
    assert got.json()["case_status"] == "underway"

    listed = await client.get(_BASE + "/functional-cases",
                              params={"project_id": pid, "current": 1, "size": 50}, headers=h)
    row = next(x for x in listed.json()["items"] if x["id"] == body["id"])
    assert row["precondition"] == "已注册账号"
    assert row["steps"] == steps[:2]


async def test_defaults_and_update_three_state(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d289b")
    created = await _case(client, h, pid, "默认值")
    assert created.status_code == 201
    body = created.json()
    assert body["case_status"] == "prepare", "没填状态 = 实机表单默认的「准备中」"
    assert body["precondition"] is None and body["remark"] is None
    assert body["steps"] == []
    cid = body["id"]

    # 只改名：四项原样
    keep = await client.patch(_BASE + f"/functional-cases/{cid}", json={
        "project_id": pid, "name": "只改名",
    }, headers=h)
    assert keep.status_code == 200
    assert keep.json()["case_status"] == "prepare"
    assert keep.json()["steps"] == []

    # 带值更新 + 清空
    filled = await client.patch(_BASE + f"/functional-cases/{cid}", json={
        "project_id": pid, "precondition": "已登录", "precondition_set": True,
        "remark": "备注", "remark_set": True,
        "steps": [{"desc": "点按钮", "expected": "弹窗"}], "steps_set": True,
        "case_status": "completed",
    }, headers=h)
    assert filled.status_code == 200, filled.text
    assert filled.json()["precondition"] == "已登录"
    assert filled.json()["steps"] == [{"desc": "点按钮", "expected": "弹窗"}]
    assert filled.json()["case_status"] == "completed"

    cleared = await client.patch(_BASE + f"/functional-cases/{cid}", json={
        "project_id": pid, "precondition": None, "precondition_set": True,
        "remark": None, "remark_set": True, "steps": [], "steps_set": True,
    }, headers=h)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["precondition"] is None
    assert cleared.json()["remark"] is None
    assert cleared.json()["steps"] == []


async def test_invalid_values_are_422(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d289c")
    bad_status = await _case(client, h, pid, "坏状态", case_status="done")
    assert bad_status.status_code == 422
    assert bad_status.json()["code"] == "validation_failed"

    long_row = await _case(client, h, pid, "超长步骤",
                           steps=[{"desc": "x" * 2001, "expected": ""}])
    assert long_row.status_code == 422
    assert long_row.json()["code"] == "validation_failed"

    too_many = await _case(client, h, pid, "行数超限",
                           steps=[{"desc": str(i), "expected": ""} for i in range(201)])
    assert too_many.status_code == 422, "步骤行数上限 200，不能把接口当文档库"
    assert too_many.json()["code"] == "validation_failed"
