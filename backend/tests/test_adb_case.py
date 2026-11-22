"""1D T7 用例服务面（§7.3/§11.4.12）：CRUD + 保存门 + 回收站 + 引用检测 + worker 任务登记。

五条钉（对着计划 T7 逐条来）：
- ① **保存门只有一道**（协议门）：steps 不过 §7.3 → 422 + 逐行 issues；**device serial
  存期不校验**（「先存草稿、设备还没登记」是正常顺序，ui 的 env 同款口径）。
- ② 回收站全环：delete（软删）→ 列表 recycled 视角 → restore（名字被占 409 不静默改名）
  → purge（逐字确认名，不确认 409）。
- ③ 引用检测与 UI 一对一镜像：1D T8 起 HTTP 面真出数（场景保存收 adb_case 节点）——
  引用检查找得到、被引用用例删除 409（force 两段式，与 api_case 同口径）。
- ④ 工具面纪律：purge / 内部批量 refs 不出现（tool=False）；delete 是 destructive。
- ⑤ worker 任务与词表：`adb_case.run` 在 celery_app.tasks 登记（R42 按名字投递的
  前提）；run 列表的 subject_type pattern 收 adb_case（R112，1C 的同课重演）。
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.fixture()
def fake_adb(monkeypatch):
    """设备 serial 存期不校验，但设备行仍要「登记过」才能进可用池（resolve 侧）——
    引用/CRUD 这几条钉不跑设备，本夹具只把 adb_path 指到假二进制，防止误触真 PATH。"""
    from app.core.config import get_settings
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager().with_device(serial="192.168.1.50:5555")
    monkeypatch.setattr(get_settings(), "adb_path", mgr.adb())
    return mgr


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("adboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "adcp" + tag},
                             headers=hb)).json()["id"]
    return boss, hb, pid


def _steps():
    return [{"id": "s1", "type": "home"},
            {"id": "s2", "type": "assert_text", "config": {"text": "登录"}}]


async def _mk(client: AsyncClient, h, pid, name, **kw) -> dict:
    body = {"project_id": pid, "name": name, "steps": _steps()}
    body.update(kw)
    r = await client.post("/api/v1/adb-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _patch(client: AsyncClient, h, pid, cid, **kw):
    body = {"project_id": pid}
    body.update(kw)
    return await client.patch("/api/v1/adb-cases/" + cid, json=body, headers=h)


# —— ① 保存门 + serial 存期口径 ——————————————————————————————


async def test_create_gate_and_serial_not_validated_at_save(client, make_user, fake_adb) -> None:
    """协议门拦畸形步骤（422 + 逐行 issues），但 default_device 的野 serial 照存 201。"""
    _, h, pid = await _setup(client, make_user, "A")
    r = await client.post("/api/v1/adb-cases", json={
        "project_id": pid, "name": "坏步骤", "steps": [
            {"id": "s1", "type": "no_such_type"},
            {"id": "s1", "type": "home"},
        ]}, headers=h)
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "validation_error"
    issues = body["details"]["issues"]
    assert len(issues) >= 2 and {i["index"] for i in issues} == {0, 1}, issues
    # 空步骤 = 零步全绿的假绿，保存期就拦（§13 纪律 1）
    r2 = await client.post("/api/v1/adb-cases", json={
        "project_id": pid, "name": "空用例", "steps": []}, headers=h)
    assert r2.status_code == 422
    assert any(i["code"] == "empty_steps" for i in r2.json()["details"]["issues"])
    # serial 存期不校验：设备还没登记是正常顺序（跑的时候 resolve 会说「跑不了」）
    c = await _mk(client, h, pid, "先存草稿", default_device="10.0.0.9:5555")
    assert c["default_device"] == "10.0.0.9:5555"
    assert c["step_count"] == 2, "step_count 是门过后的冗余计数"


async def test_name_dup_and_recycled_name_hold(client, make_user, fake_adb) -> None:
    """同项目重名 409（含回收站墓碑占名——撞上唯一键的时机不同不能给两个错误码）。"""
    _, h, pid = await _setup(client, make_user, "B")
    c = await _mk(client, h, pid, "同名之争")
    r = await client.post("/api/v1/adb-cases", json={
        "project_id": pid, "name": "同名之争", "steps": _steps()}, headers=h)
    assert r.status_code == 409 and r.json()["details"]["name_exists"] is True
    # 回收站里的墓碑照样占名
    assert (await client.post(f"/api/v1/adb-cases/{c['id']}/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r2 = await client.post("/api/v1/adb-cases", json={
        "project_id": pid, "name": "同名之争", "steps": _steps()}, headers=h)
    assert r2.status_code == 409
    assert r2.json()["details"].get("recycled") is True, "占名者是墓碑要说出口（先恢复或彻底删）"


# —— ② 回收站全环 ——————————————————————————————


async def test_recycle_lifecycle(client, make_user, fake_adb) -> None:
    """delete→recycled 列表→restore→purge（确认名不符不放行）。"""
    _, h, pid = await _setup(client, make_user, "C")
    c = await _mk(client, h, pid, "回收之旅")
    base = f"/api/v1/adb-cases/{c['id']}"
    # 正常态不许直接 purge：只有软删过的东西能到物理删除门口（R53）
    assert (await client.post(base + "/purge", json={"project_id": pid, "confirm_name": "回收之旅"},
                              headers=h)).status_code == 409
    assert [i["id"] for i in (await client.get(
        "/api/v1/adb-cases", params={"project_id": pid}, headers=h)).json()["items"]] == [c["id"]]
    assert (await client.post(base + "/delete", json={"project_id": pid}, headers=h)).status_code == 200
    assert [i["id"] for i in (await client.get(
        "/api/v1/adb-cases", params={"project_id": pid, "recycled": True},
        headers=h)).json()["items"]] == [c["id"]]
    assert (await client.get(base, params={"project_id": pid}, headers=h)).status_code == 404
    # 墓碑可以复活；复活后再回收，这次输错名不放行、输对才物理删除
    assert (await client.post(base + "/restore", json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post(base + "/delete", json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post(base + "/purge", json={"project_id": pid, "confirm_name": "差一个字"},
                              headers=h)).status_code == 409
    assert (await client.post(base + "/purge", json={"project_id": pid, "confirm_name": "回收之旅"},
                              headers=h)).status_code == 200
    assert (await client.get(base, params={"project_id": pid, "recycled": True},
                             headers=h)).status_code == 404


async def test_recycled_list_resolves_deleter_name(client, make_user, fake_adb) -> None:
    """§11.4.18 回收站「删除人/删除时间」：回收站列表必须把 updated_by 解析成人名。

    三条断言各钉一句谎：
    - updated_by == 删除人 id（回收那次写操作记的就是删除人，不是 owner）；
    - updated_by_name == 删除人的 name（id→人名解析对了；回填 id 这条必须红）；
    - updated_at 非空且 ≥ 回收前的值（回收是最后写这行 → 它兼任「删除时间」；同秒
      DATETIME 会飘，钉「不早于」而不是精确时刻）。
    删除人刻意用**另一个** PROJECT_ADMIN 成员：name 与 account 不同、id 是 UUID，
    名字/账号/id 三种回填互不相同，链路坏在哪一步一眼可辨（MEMBER 角色 "-*:delete"
    删不动，所以用 PROJECT_ADMIN）。
    """
    from datetime import datetime

    _, h, pid = await _setup(client, make_user, "G")
    killer, hk = await make_user("adkiller" + pid[:6], name="回收的老王")
    assert (await client.put(f"/api/v1/projects/{pid}/members/{killer.id}",
                             json={"role_code": "PROJECT_ADMIN"}, headers=h)).status_code == 200
    c = await _mk(client, h, pid, "被人删掉的用例")
    before = c["updated_at"]
    assert (await client.post(f"/api/v1/adb-cases/{c['id']}/delete",
                              json={"project_id": pid}, headers=hk)).status_code == 200
    items = (await client.get("/api/v1/adb-cases",
                              params={"project_id": pid, "recycled": True},
                              headers=h)).json()["items"]
    row = next(i for i in items if i["id"] == c["id"])
    assert row["updated_by"] == killer.id, "记的必须是删除人，不是 owner/创建人"
    assert row["updated_by_name"] == "回收的老王", "人名没解析对（回填 id/None 都红在这行）"
    assert row["updated_at"], "回收写这行会 bump updated_at → 它就是删除时间"
    # 库内 DATETIME 秒级：create 回显带微秒、回收站列表是重新读库（微秒已被截掉），
    # 同秒时「原始值 ≥」会假红——截到秒再比（这就是「别钉精确时刻」的实测形状）。
    assert datetime.fromisoformat(row["updated_at"]) >= datetime.fromisoformat(before).replace(microsecond=0)


# —— ③ 引用检测：HTTP 恒空的诚实 + 直插通道 ——————————————————————————————


async def test_references_channel_live_via_direct_insert(client, make_user, session,
                                                         fake_adb) -> None:
    """1D T8 改钉：通道不再需要直插——HTTP 保存 adb_case 场景就能出数。

    `scenario_case_refs` 把非 api_case 步骤的 ref 当 definition_ids 匹配，adb_case 步骤
    的 ref 就是 ADB 用例 id（T8 的 adb_case_resolve 入参）——这个耦合读代码看不出来，
    钉成测试（test_ui_case.py 的同款坑）。
    """
    _, h, pid = await _setup(client, make_user, "D")
    c = await _mk(client, h, pid, "被场景当一步")
    r = await client.get("/api/v1/adb-case-references",
                         params={"project_id": pid, "case_id": c["id"]}, headers=h)
    assert r.status_code == 200 and r.json() == {"items": [], "details_hidden": False}
    # 缺 case_id 必须 422：静默回空会让人以为「没被引用」然后去删（§13 纪律 1）
    assert (await client.get("/api/v1/adb-case-references",
                             params={"project_id": pid}, headers=h)).status_code == 422

    # 1D T8：走真 HTTP 保存（BLOCKED_1B 已清空，场景存得下 adb_case 节点）
    g = {"version": 1, "nodes": [
        {"key": "k1", "kind": "adb_case", "ref": c["id"], "name": "跑设备"},
        {"key": "k2", "kind": "api_case", "ref": "other", "name": "跑接口"}]}
    sid = (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "混排场景", "step_graph": g})).json()["id"]
    r2 = await client.get("/api/v1/adb-case-references",
                          params={"project_id": pid, "case_id": c["id"]}, headers=h)
    body = r2.json()
    assert len(body["items"]) == 1, "step_graph 里的 adb_case.ref 必须算引用（走错通道就红）"
    assert body["items"][0]["step_keys"] == ["k1"] and body["items"][0]["scenario_name"] == "混排场景"

    # 被引用的用例删除必须 409 并点名引用者（与 api_case 同口径的 force 两段式）
    d = await client.post(f"/api/v1/adb-cases/{c['id']}/delete",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 409 and d.json()["code"] == "referenced_by_scenario", d.text
    assert d.json()["details"]["count"] == 1
    assert d.json()["details"]["scenarios"][0]["scenario_id"] == sid
    # 409 不许顺手改状态：用例还活着
    assert (await client.get(f"/api/v1/adb-cases/{c['id']}",
                             params={"project_id": pid}, headers=h)).json()["status"] == "normal"
    # force=看见清单后的第二段；回收后 purge 仍硬拦（回收 ≠ 解绑，无 force 出口）
    assert (await client.post(f"/api/v1/adb-cases/{c['id']}/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200
    p = await client.post(f"/api/v1/adb-cases/{c['id']}/purge", json={
        "project_id": pid, "confirm_name": "被场景当一步"}, headers=h)
    assert p.status_code == 409 and p.json()["code"] == "referenced_by_scenario", p.text


# —— ④⑤ 工具面 + worker 任务 + 词表 ——————————————————————————————


async def test_tool_surface_and_permissions(client, make_user, fake_adb) -> None:
    """READONLY 读 200 写 403；purge / refs 内部件不在工具面；delete=destructive。"""
    _, hb, pid = await _setup(client, make_user, "E")
    ro, hro = await make_user("adro" + pid[:6])
    assert (await client.put(f"/api/v1/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=hb)).status_code == 200
    c = await _mk(client, hb, pid, "老板的用例")
    assert (await client.get("/api/v1/adb-cases", params={"project_id": pid},
                             headers=hro)).status_code == 200
    assert (await _patch(client, hro, pid, c["id"], name="改不了")).status_code == 403
    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid},
                              headers=hb)).json()["items"]
    names = {t["name"] for t in tools}
    for absent in ("adb_case_purge", "adb_case_refs", "adb_case_resolve"):
        assert absent not in names, absent + " 不该在工具面（tool=False 漏进=权限绕过）"
    assert {"adb_case_list", "adb_case_create", "adb_case_update", "adb_case_delete",
            "adb_case_debug", "adb_case_run"} <= names
    by_name = {t["name"]: t for t in tools}
    assert by_name["adb_case_delete"]["effect"] == "destructive"


def test_worker_task_registered_by_name() -> None:
    """R42：投递方按名字 send_task——任务名登记是跨进程契约的接收端。"""
    import app.worker as worker_mod

    assert "adb_case.run" in worker_mod.celery_app.tasks
    assert "ui_case.run" in worker_mod.celery_app.tasks  # 别把旧的顶掉


async def test_run_list_accepts_adb_case_subject(client, make_user, fake_adb) -> None:
    """R112 词表（1C 的同课重演）：subject_type=adb_case 必须收——不收就是
    「ADB 运行出现在列表里却筛不出来」。"""
    _, h, pid = await _setup(client, make_user, "F")
    r = await client.get("/api/v1/runs", params={"project_id": pid, "subject_type": "adb_case"},
                         headers=h)
    assert r.status_code == 200, r.text
    r2 = await client.get("/api/v1/runs", params={"project_id": pid, "subject_type": "bogus"},
                          headers=h)
    assert r2.status_code == 422, "pattern 是闭集，野值照收 = 前端拼错词表也不报错"
