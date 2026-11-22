"""1D T4 设备服务面（§11.4.14 + D2）：CRUD + 先 connect 验证再入库 + 测试即拍 + 重连 + 删除/purge。

五条钉都有各自的意图（对着计划 T4 逐条来）：
- ① **先 connect 验证再入库**：create 时设备连不通 → 422 connect_failed + 排错提示（人话，
  不是 500）；只有 connect 得通 + getprop 拉得到机型才 201，且 last_state 落首帧。
  **没有 adb 二进制也 422 响亮**——「这台机器要管设备却缺 adb」是配置故障，绝不装死不假在线。
- ② **测试即拍**：/test 读机型 + exec-out screencap → 真 PNG bytes → base64 缩略图。
- ③ **重连**：disconnect 后重连，刷新 last_state 首帧。
- ④ **删除前占用检测**：本批拦「被 adb_case.default_device 引用」的 purge（引用完整性），
  delete 是软删放行；purge 输错名/不确认 detach 都 409。
- ⑤ **权限面**：read/create/update/delete 三段；READONLY 只见读不见写；delete=destructive。

全部走假设备 fixture（T1 的 FakeDeviceManager），不接触真设备/emulator——门禁不该依赖它在不在。
"""
from __future__ import annotations

import base64
import os
import shutil

import pytest
from httpx import AsyncClient

from app.core.config import get_settings


@pytest.fixture()
def fake_adb():
    """一台开箱即用的假 WiFi 设备（T1 FakeDeviceManager），同时钉好 settings.adb_path 与 env。

    跨进程可控：把 FAKE_ADB_STATE 指到管理器状态文件，产品代码（建连/心跳）读到的
    就是这台假设备。每次测试前重建以隔离状态。锁走全局 get_bus()，这里也把它换成一
    个全新 fakeredis server——否则 device_lock 在用例间会串台（两台测试设备的 serial
    相同，锁键撞名）。
    """
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager()
    mgr.with_device(serial="192.168.1.50:5555")
    s = get_settings()
    s.adb_path = str(mgr.adb())
    os.environ["FAKE_ADB_STATE"] = str(mgr.state_path)
    import fakeredis
    import fakeredis.aioredis as fa

    from app.core.eventbus import init_bus

    init_bus(client=fa.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True))
    return mgr


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("adboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "adp" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


def _mk_body(pid, name, serial="192.168.1.50:5555", **kw):
    body = {"project_id": pid, "name": name, "serial": serial}
    body.update(kw)
    return body


async def _mk(client: AsyncClient, h, pid, name, **kw) -> dict:
    r = await client.post("/api/v1/adb-devices", json=_mk_body(pid, name, **kw), headers=h)
    assert r.status_code == 201, r.text
    return r.json()


# —— ① 先 connect 验证再入库 ————————————————————————————————


async def test_create_connects_first_then_201(client, make_user, fake_adb) -> None:
    """建连成功才入库：201 + last_state 首帧有机型/系统/在线。"""
    _, h, pid = await _setup(client, make_user, "A")
    d = await _mk(client, h, pid, "真机一号")
    assert d["serial"] == "192.168.1.50:5555"
    assert d["connect_type"] == "wifi"
    assert d["wifi_addr"] == "192.168.1.50", "serial 的 host 自动带出 wifi_addr"
    st = d["last_state"]
    assert st["online"] is True
    assert st["model"] == "Pixel 3a (fake)"
    assert st["os"] == "12"
    assert st["last_check_at"], "首帧带心跳时间戳"


async def test_create_connect_fail_is_loud_422(client, make_user, fake_adb) -> None:
    """connect 失败 → 422 connect_failed + 排错提示（不是 500），也不留脏行。"""
    from sqlalchemy import func, select

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbDevice

    _, h, pid = await _setup(client, make_user, "B")
    fake_adb.set_state({
        "devices": [{"serial": "9.9.9.9:5555", "state": "device"}],
        "connect_fail": ["9.9.9.9:5555"],
        "file_root": str(fake_adb.file_root),
    })
    r = await client.post("/api/v1/adb-devices",
                          json=_mk_body(pid, "连不上的", serial="9.9.9.9:5555"), headers=h)
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "connect_failed", body
    assert "adb connect" in body["message"] and "9.9.9.9:5555" in body["message"], body["message"]
    # 没留脏行

    async with get_sessionmaker()() as s:
        n = await s.scalar(select(func.count()).select_from(AdbDevice).where(
            AdbDevice.project_id == pid))
        assert n == 0


async def test_create_without_adb_is_loud_422(client, make_user, monkeypatch) -> None:
    """机器上没有 adb 二进制 → create 422 响亮（安装指引），绝不装死、不假在线。"""
    _, h, pid = await _setup(client, make_user, "C")
    s = get_settings()
    monkeypatch.setattr(s, "adb_path", "")
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("ProgramFiles", raising=False)
    monkeypatch.setattr(shutil, "which", lambda name: None)
    monkeypatch.delenv("FAKE_ADB_STATE", raising=False)
    r = await client.post("/api/v1/adb-devices",
                          json=_mk_body(pid, "无 adb"), headers=h)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "connect_failed", r.json()
    assert "adb" in r.json()["message"]


async def test_create_bad_adb_path_is_loud_422(client, make_user, monkeypatch) -> None:
    """D158：TP_ADB_PATH 指到不存在的路径 = 同一个「缺 adb」错误面 → 同样 422 带指引。

    这条腿盯的是 _connect_verify 的 except RuntimeError：resolver 在这条路上抛的必须
    是该 catch 的类型，否则异常穿门 → 全局 500「服务内部错误」，手册承诺的 422 没了。
    """
    _, h, pid = await _setup(client, make_user, "C2")
    s = get_settings()
    monkeypatch.setattr(s, "adb_path", "C:/definitely/not/a/real/adb.exe")
    monkeypatch.delenv("FAKE_ADB_STATE", raising=False)
    r = await client.post("/api/v1/adb-devices",
                          json=_mk_body(pid, "adb 指错的"), headers=h)
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "connect_failed", body
    assert "TP_ADB_PATH" in body["message"], body["message"]
    assert "adb 不存在" in body["message"], body["message"]


async def test_duplicate_name_409_and_usb_write_rejected(client, make_user, fake_adb) -> None:
    _, h, pid = await _setup(client, make_user, "D")
    await _mk(client, h, pid, "重名")
    r = await client.post("/api/v1/adb-devices", json=_mk_body(pid, "重名"), headers=h)
    assert r.status_code == 409 and r.json()["code"] == "conflict", r.text
    # D14：USB 写入口一期显式 422，不静默改写成 wifi
    r2 = await client.post("/api/v1/adb-devices",
                           json=_mk_body(pid, "USB", serial="emulator-5554", connect_type="usb"),
                           headers=h)
    assert r2.status_code == 422, r2.text
    assert "USB" in r2.json()["message"] or "一期" in r2.json()["message"]


# —— 列表/详情/更新 —————————————————————————————————————


async def test_list_default_excludes_recycled(client, make_user, fake_adb) -> None:
    _, h, pid = await _setup(client, make_user, "E")
    d1 = await _mk(client, h, pid, "一号")
    await _mk(client, h, pid, "二号")
    # 软删：POST delete
    await client.post("/api/v1/adb-devices/" + d1["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    rows = (await client.get("/api/v1/adb-devices", params={"project_id": pid}, headers=h)).json()
    assert [i["name"] for i in rows["items"]] == ["二号"]
    rec = (await client.get("/api/v1/adb-devices", params={"project_id": pid, "recycled": True},
                            headers=h)).json()
    assert [i["name"] for i in rec["items"]] == ["一号"]


async def test_update_serial_must_go_through_test_endpoint(client, make_user, fake_adb) -> None:
    """改 serial = 改连接对象，必须重验；直接 PATCH → 422（连不上的对象不该静默入库）。"""
    _, h, pid = await _setup(client, make_user, "F")
    d = await _mk(client, h, pid, "需要改串")
    r = await client.patch("/api/v1/adb-devices/" + d["id"],
                           json={"project_id": pid, "serial": "10.0.0.9:5555"}, headers=h)
    assert r.status_code == 422, r.text
    assert "重验" in r.json()["message"]
    # 浅字段（name/enabled/可见性）可以改
    r2 = await client.patch("/api/v1/adb-devices/" + d["id"],
                            json={"project_id": pid, "name": "改名"}, headers=h)
    assert r2.status_code == 200 and r2.json()["name"] == "改名", r2.text


async def test_get_cross_project_is_404(client, make_user, fake_adb) -> None:
    _, h1, pid1 = await _setup(client, make_user, "G")
    _, h2, pid2 = await _setup(client, make_user, "H")
    d = await _mk(client, h1, pid1, "别家设备")
    r = await client.get("/api/v1/adb-devices/" + d["id"], params={"project_id": pid2}, headers=h2)
    assert r.status_code == 404, r.text


# —— ② 测试即拍 & ③ 重连 —————————————————————————————————


async def test_test_connection_returns_screenshot(client, make_user, fake_adb) -> None:
    _, h, pid = await _setup(client, make_user, "I")
    d = await _mk(client, h, pid, "拍照设备")
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/test",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["connected"] is True
    assert body["model"] == "Pixel 3a (fake)"
    assert body["screenshot_b64"], "screencap 真 PNG → base64，必须有缩略图"
    raw = base64.b64decode(body["screenshot_b64"])
    assert raw[:4] == b"\x89PNG", "缩略图必须是真 PNG 字节（取证 ④ 的 bytes 通道）"


async def test_reconnect_refreshes_last_state(client, make_user, fake_adb) -> None:
    _, h, pid = await _setup(client, make_user, "J")
    d = await _mk(client, h, pid, "重连设备")
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/reconnect",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["last_state"]["online"] is True


# —— ④ purge / 引用保护 / 回收站 ————————————————————————————————


async def test_occupation_reads_monitor_and_queue(client, make_user, fake_adb) -> None:
    """卡片墙占用读数：无锁=空闲；占锁=占用；排队人数如实（D17 真实数字）。"""
    from app.modules.execution.adb_lock import acquire, occupied, release

    _, h, pid = await _setup(client, make_user, "O")
    d = await _mk(client, h, pid, "占用读数设备")
    r = await client.get("/api/v1/adb-devices/" + d["id"] + "/occupation",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["occupied"] is False, r.text

    await acquire(d["serial"], "run:o1:1:test")
    await acquire(d["serial"], "run:o2:1:test")
    r2 = await client.get("/api/v1/adb-devices/" + d["id"] + "/occupation",
                          params={"project_id": pid}, headers=h)
    body = r2.json()
    assert body["occupied"] is True and body["holder"] == "run:o1:1:test"
    assert body["queued"] == 1, "D17：排队人数是真实数字，不是估算"
    await release(d["serial"], "run:o1:1:test")
    assert (await occupied(d["serial"]))["holder"] == "run:o2:1:test"


async def test_force_release_audited_and_occupation_cleared(client, make_user, fake_adb) -> None:
    """强制释放（管理员，D16）：删锁 + 审计；原持有者此后不能再续期/释放。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.audit.models import AuditLog
    from app.modules.execution.adb_lock import acquire, occupied, release, renew

    _, h, pid = await _setup(client, make_user, "F")
    d = await _mk(client, h, pid, "被强制释放")
    await acquire(d["serial"], "run:held:1:worker")
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/force-release",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["released_holder"] == "run:held:1:worker", body
    assert (await occupied(d["serial"]))["holder"] is None
    # 原持有者失效
    assert await renew(d["serial"], "run:held:1:worker") is False
    assert await release(d["serial"], "run:held:1:worker") is False
    # 审计落库：写入口自动记 action=adb_device_force_release（entry=http）
    async with get_sessionmaker()() as s:
        rows = (await s.execute(select(AuditLog).where(
            AuditLog.action == "adb_device_force_release"))).scalars().all()
        assert len(rows) == 1, "强制释放必须落审计"
        assert rows[0].entry == "http" and rows[0].ok is True


async def test_force_release_requires_manage_perm(client, make_user, fake_adb) -> None:
    """D159 翻案钉：强制释放 = 管理位（adb:device:manage），不是 update 位。

    旧契约把门禁挂在 adb:device:update 上，MEMBER（["*","-*:delete","-*:manage",…]）
    顺手持有 → 任何测试工程师都能强拆别人的锁，与蓝图/服务描述/UI 三处「管理员」承诺
    相违。新契约下：MEMBER 持 update 却因 -*:manage 拿不到 manage → 403 且
    details.perm 点名缺的是 manage 位（不是别的位凑巧挡住）；同一个人升 PROJECT_ADMIN
    后立即 200——位就是唯一变量。READONLY 只有读占用的能力，继续 403。
    """
    from app.modules.execution.adb_lock import acquire, occupied

    _, hb, pid = await _setup(client, make_user, "G")
    d = await _mk(client, hb, pid, "权限面设备")
    await acquire(d["serial"], "run:x:1:test")

    # —— MEMBER：持 update（改名能过）但不持 manage（强拆被拒）——
    mb, hmb = await make_user("amem" + pid[:4])
    mid = mb.id  # 提前取 id：403 那脚会让共享 session rollback 过期对象，之后再摸 mb.id 会 MissingGreenlet
    await client.put(f"/api/v1/projects/{pid}/members/{mid}", json={"role_code": "MEMBER"},
                     headers=hb)
    r = await client.patch("/api/v1/adb-devices/" + d["id"],
                           json={"project_id": pid, "name": "member改名验证update位"}, headers=hmb)
    assert r.status_code == 200, "前置：MEMBER 必须仍持 adb:device:update，否则本钉测不到靶位"
    r2 = await client.post("/api/v1/adb-devices/" + d["id"] + "/force-release",
                           json={"project_id": pid}, headers=hmb)
    assert r2.status_code == 403, r2.text
    body = r2.json()
    assert body["code"] == "insufficient_permission" and body["details"]["perm"] == "adb:device:manage", \
        "403 必须点名缺 adb:device:manage（update 位挡不住 ≠ 别的门位凑巧挡住）"
    assert (await occupied(d["serial"]))["holder"] == "run:x:1:test", "403 不许把锁顺手拆了"

    # —— 升 PROJECT_ADMIN（持 manage）：同一个人同一设备，立即强拆成功 ——
    await client.put(f"/api/v1/projects/{pid}/members/{mid}", json={"role_code": "PROJECT_ADMIN"},
                     headers=hb)
    r3 = await client.post("/api/v1/adb-devices/" + d["id"] + "/force-release",
                           json={"project_id": pid}, headers=hmb)
    assert r3.status_code == 200, r3.text
    assert r3.json()["released_holder"] == "run:x:1:test"

    # —— READONLY：读得到占用，强拆仍 403 ——
    ro, hro = await make_user("adir" + pid[:4])
    roid = ro.id  # 同上：过早取 id，避开 403 rollback 后的过期属性
    await client.put(f"/api/v1/projects/{pid}/members/{roid}", json={"role_code": "READONLY"},
                     headers=hb)
    r4 = await client.get("/api/v1/adb-devices/" + d["id"] + "/occupation",
                          params={"project_id": pid}, headers=hro)
    assert r4.status_code == 200 and r4.json()["occupied"] is False
    r5 = await client.post("/api/v1/adb-devices/" + d["id"] + "/force-release",
                           json={"project_id": pid}, headers=hro)
    assert r5.status_code == 403 and r5.json()["details"]["perm"] == "adb:device:manage", r5.text
    # 工具面：occupation 是 read 可见，force_release 是 write，且注册表位就是 manage
    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid},
                              headers=hb)).json()["items"]
    by_name = {t["name"]: t for t in tools}
    assert by_name["adb_device_occupation"]["effect"] == "read"
    assert by_name["adb_device_force_release"]["effect"] == "write"
    assert by_name["adb_device_force_release"]["perm"] == "adb:device:manage"


async def test_delete_and_restore_soft_then_purge(client, make_user, fake_adb) -> None:
    _, h, pid = await _setup(client, make_user, "K")
    d = await _mk(client, h, pid, "走回收站的设备")
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    # 回收站里 get 404
    assert (await client.get("/api/v1/adb-devices/" + d["id"],
                             params={"project_id": pid}, headers=h)).status_code == 404
    # 恢复
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/restore",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["status"] == "normal", r.text
    # 再进回收站 → purge
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    bad = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                            json={"project_id": pid, "confirm_name": "走回收站的设备 "}, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "name_mismatch", bad.text
    ok = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "走回收站的设备"}, headers=h)
    assert ok.status_code == 200, ok.text
    assert (await client.get("/api/v1/adb-devices", params={"project_id": pid, "recycled": True},
                             headers=h)).json()["items"] == []


async def test_recycled_list_resolves_deleter_name(client, make_user, fake_adb) -> None:
    """§11.4.18 回收站「删除人/删除时间」：设备回收站列表把 updated_by 解析成人名。

    与 test_adb_case.py 同名钉同理由（那边注释为准，不重复长文）：updated_by 钉「删的是
    谁」，updated_by_name 钉「id→人名解析对了」，updated_at 只钉非空且 ≥ 回收前——
    DATETIME 同秒会飘，不钉精确时刻。删除人用另一个 PROJECT_ADMIN（name≠account≠id，
    三种错法互不相同一眼可辨；MEMBER 角色 "-*:delete" 删不动）。
    """
    from datetime import datetime

    _, h, pid = await _setup(client, make_user, "Q")
    killer, hk = await make_user("adkiller" + pid[:6], name="删设备的老李")
    assert (await client.put(f"/api/v1/projects/{pid}/members/{killer.id}",
                             json={"role_code": "PROJECT_ADMIN"}, headers=h)).status_code == 200
    d = await _mk(client, h, pid, "被人删掉的设备")
    before = d["updated_at"]
    assert (await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                              json={"project_id": pid}, headers=hk)).status_code == 200
    items = (await client.get("/api/v1/adb-devices",
                              params={"project_id": pid, "recycled": True},
                              headers=h)).json()["items"]
    row = next(i for i in items if i["id"] == d["id"])
    assert row["updated_by"] == killer.id, "记的必须是删除人，不是 owner/创建人"
    assert row["updated_by_name"] == "删设备的老李", "人名没解析对（回填 id/None 都红在这行）"
    assert row["updated_at"], "回收写这行会 bump updated_at → 它就是删除时间"
    # 库内 DATETIME 秒级（本测试实测：create 回显 44.056102 → 列表读回 44）：
    # 截到秒再比，否则同秒假红。
    assert datetime.fromisoformat(row["updated_at"]) >= datetime.fromisoformat(before).replace(microsecond=0)


async def test_purge_requires_detach_for_referencing_case(client, make_user, fake_adb) -> None:
    """被 adb_case.default_device 引用的设备：purge 必须确认 detach（引用完整性的守门人）。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbCase

    _, h, pid = await _setup(client, make_user, "L")
    d = await _mk(client, h, pid, "被引用的设备")
    # 造一条引用它的 ADB 用例（T7 之前直接写库；default_device 填这台串号）
    async with get_sessionmaker()() as s:
        case = AdbCase(project_id=pid, name="默认用这台", module_id=None,
                       steps=[{"id": "k1", "type": "home"}],
                       default_device=d["serial"])
        s.add(case)
        await s.commit()
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "被引用的设备"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "in_use", r.text
    assert "default_device" in r.json()["message"]
    r2 = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "被引用的设备",
                                 "detach_referencing": True}, headers=h)
    assert r2.status_code == 200, r2.text
    async with get_sessionmaker()() as s:
        row = (await s.execute(select(AdbCase).where(AdbCase.name == "默认用这台"))).scalar_one()
        assert row.default_device is None, "detach 后 default_device 必须清空"


# —— ④-b D175：purge 引用明细套 notify/role 同款尺（count 照报、明细按 adb:case:read 门） ——


async def _device_only_member(client, make_user, hb, pid, tag: str):
    """只有 adb:device:delete 的自定义角色成员（D37 配得出的真实权限组合）：
    进得了 purge，但没有 adb:case:read——正是台账 D175 实测的那套 perms。"""
    r = await client.post("/api/v1/custom-roles", json={
        "project_id": pid, "name": "只删设备" + tag, "template_code": "READONLY",
        "perms": ["adb:device:delete"]}, headers=hb)
    assert r.status_code == 201, r.text
    u, hu = await make_user("addel" + tag)
    assert (await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                             json={"role_code": r.json()["code"]}, headers=hb)).status_code == 200
    return u, hu


async def _private_ref_case(pid, serial, name, owner_id) -> str:
    """别人的私有用例（project_public=False）引用该 serial：直接写库（既有 purge 钉同法）。"""
    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbCase

    async with get_sessionmaker()() as s:
        c = AdbCase(project_id=pid, name=name, module_id=None,
                    steps=[{"id": "k1", "type": "home"}], default_device=serial,
                    owner_id=owner_id, project_public=False)
        s.add(c)
        await s.commit()
        return c.id


async def test_purge_ref_details_visible_with_case_read(client, make_user, fake_adb) -> None:
    """有 adb:case:read（boss=PROJECT_ADMIN）：名字在场、count 全量、无隐瞒句。"""
    boss, h, pid = await _setup(client, make_user, "P1")
    d = await _mk(client, h, pid, "明细可见的设备")
    await _private_ref_case(pid, d["serial"], "私有引用案", boss.id)
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "明细可见的设备"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "in_use", r.text
    det = r.json()["details"]
    assert det["count"] == 1
    assert [c["name"] for c in det["referring_cases"]] == ["私有引用案"]
    assert det["details_hidden"] is False and det["details_truncated"] is False
    assert "default_device" in r.json()["message"]
    assert "adb:case:read" not in r.json()["message"], "看得见名单的人不该被塞「去找有权限的人」"


async def test_purge_ref_details_hidden_without_case_read(client, make_user, fake_adb) -> None:
    """D175 主钉：只有 adb:device:delete ⇒ count 照报 + 明细 [] + details_hidden=True
    + 消息点名 adb:case:read；私有用例名整条响应不许出现；拦截照旧（设备没被删）。"""
    boss, h, pid = await _setup(client, make_user, "P2")
    d = await _mk(client, h, pid, "明细被隐瞒的设备")
    await _private_ref_case(pid, d["serial"], "看不见的名字", boss.id)
    _, hu = await _device_only_member(client, make_user, h, pid, "p2")
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "明细被隐瞒的设备"}, headers=hu)
    assert r.status_code == 409 and r.json()["code"] == "in_use", r.text
    body = r.json()
    det = body["details"]
    assert det["count"] == 1, "count 照报：隐瞒明细不等于隐瞒引用存在"
    assert "1 条" in body["message"]
    assert det["referring_cases"] == []
    assert det["details_hidden"] is True, "明细被隐瞒这件事本身要可见"
    assert "adb:case:read" in body["message"], body["message"]
    assert "看不见的名字" not in r.text, "隐瞒 = 整条响应里都不出现名字，不只是明细置空"
    # 拦不拦由数据决定、不由权限决定：设备仍在回收站，没被删
    items = (await client.get("/api/v1/adb-devices", params={"project_id": pid, "recycled": True},
                              headers=h)).json()["items"]
    assert [i["id"] for i in items] == [d["id"]]


async def test_purge_detach_physically_clears_refs_without_case_read(client, make_user, fake_adb) -> None:
    """权限门只隐瞒明细、不改物理行为：只有 adb:device:delete + detach=true 照样清引用删设备。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbCase

    boss, h, pid = await _setup(client, make_user, "P3")
    d = await _mk(client, h, pid, "可被detach的设备")
    cid = await _private_ref_case(pid, d["serial"], "看不见但清得掉的案", boss.id)
    _, hu = await _device_only_member(client, make_user, h, pid, "p3")
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "可被detach的设备",
                                "detach_referencing": True}, headers=hu)
    assert r.status_code == 200, r.text
    async with get_sessionmaker()() as s:
        row = (await s.execute(select(AdbCase).where(AdbCase.id == cid))).scalar_one()
        assert row.default_device is None, "物理清引用不因权限门改变"
    assert (await client.get("/api/v1/adb-devices", params={"project_id": pid, "recycled": True},
                             headers=h)).json()["items"] == []


async def test_purge_ref_details_truncation_separate_from_hidden(client, make_user, fake_adb) -> None:
    """REF_DETAIL_CAP 截断与权限隐瞒是两回事（notify/service.py:164 口径）：
    21 条引用 ⇒ count=21、明细 20、truncated=True；无权限时 hidden 与 truncated 同时 True。"""
    from app.modules.adb_test.device_services import REF_DETAIL_CAP

    boss, h, pid = await _setup(client, make_user, "P4")
    d = await _mk(client, h, pid, "被二十一条引用的设备")
    for i in range(REF_DETAIL_CAP + 1):
        await _private_ref_case(pid, d["serial"], "引用案" + str(i), boss.id)
    _, hu = await _device_only_member(client, make_user, h, pid, "p4")
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    body = {"project_id": pid, "confirm_name": "被二十一条引用的设备"}
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge", json=body, headers=h)
    assert r.status_code == 409, r.text
    det = r.json()["details"]
    assert det["count"] == REF_DETAIL_CAP + 1, "count 永远是全量"
    assert len(det["referring_cases"]) == REF_DETAIL_CAP, "明细被截在上限"
    assert det["details_truncated"] is True, "截了明细必须声明，否则 20 条被当全量"
    assert det["details_hidden"] is False
    r2 = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge", json=body, headers=hu)
    assert r2.status_code == 409, r2.text
    det2 = r2.json()["details"]
    assert det2["count"] == REF_DETAIL_CAP + 1
    assert det2["referring_cases"] == []
    assert det2["details_hidden"] is True and det2["details_truncated"] is True, "隐瞒与截断各说各的"


async def test_purge_counts_recycled_refs_and_detach_clears_them(client, make_user, fake_adb) -> None:
    """回收站用例的引用照样算（拦截由数据决定）、detach 照样清——物理行为不变。

    与 ui_element/_scan_element_refs 只数 normal 不同：purge 有 detach 出口，回收站里的
    default_device 也是真引用（恢复即悬空），所以全量扫、全量清（notify/iam 同形：
    count 不加 status 过滤）。这条钉住「连 recycled 都算」的既有口径不被权限门顺手改掉。
    """
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbCase

    _, h, pid = await _setup(client, make_user, "P5")
    d = await _mk(client, h, pid, "被回收案引用的设备")
    c = await client.post("/api/v1/adb-cases", json={
        "project_id": pid, "name": "回收了的引用案", "default_device": d["serial"],
        "steps": [{"id": "k1", "type": "home"}]}, headers=h)
    assert c.status_code == 201, c.text
    cid = c.json()["id"]
    assert (await client.post(f"/api/v1/adb-cases/{cid}/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "被回收案引用的设备"}, headers=h)
    assert r.status_code == 409 and r.json()["details"]["count"] == 1, r.text
    r2 = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "被回收案引用的设备",
                                 "detach_referencing": True}, headers=h)
    assert r2.status_code == 200, r2.text
    async with get_sessionmaker()() as s:
        row = (await s.execute(select(AdbCase).where(AdbCase.id == cid))).scalar_one()
        assert row.status == "recycled" and row.default_device is None


# —— ⑤ 权限面 ————————————————————————————————————————————


async def test_readonly_can_read_devices_not_write(client, make_user, fake_adb) -> None:
    _, hb, pid = await _setup(client, make_user, "M")
    await _mk(client, hb, pid, "老板的设备")
    ro, hro = await make_user("adro" + pid[:4])
    await client.put(f"/api/v1/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"},
                     headers=hb)
    assert (await client.get("/api/v1/adb-devices", params={"project_id": pid},
                             headers=hro)).status_code == 200
    r = await client.post("/api/v1/adb-devices",
                          json=_mk_body(pid, "只读建不了"), headers=hro)
    assert r.status_code == 403, r.text
    # create 也走 connect 验证才 403？不——权限门在 connect 之前（403 优先）
    assert r.json()["code"] == "insufficient_permission"
    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid},
                              headers=hb)).json()["items"]
    by_name = {t["name"]: t for t in tools}
    assert by_name["adb_device_list"]["effect"] == "read"
    assert by_name["adb_device_test"]["effect"] == "read"  # 读类 :read 结尾，READONLY glob 可见
    assert by_name["adb_device_create"]["effect"] == "write"
    assert by_name["adb_device_delete"]["effect"] == "destructive"
    assert "adb_device_purge" not in by_name, "purge 是 tool=False 内部件，不许进工具面"


def test_perm_points_synced_surface(session) -> None:
    """adb:* 权限点全部进注册表（registry_sync 落库由既有 sync 测试覆盖）。"""
    from app.core.registry import REGISTRY

    pts = REGISTRY.perm_points()
    for p in ("adb:device:read", "adb:device:create", "adb:device:update", "adb:device:delete",
              "adb:module:read", "adb:module:create", "adb:module:update", "adb:module:delete"):
        assert p in pts, "权限点缺失: " + p


# —— ⑥ D167：delete/purge 动数据前查执行锁（占用拦截，holder 按 adb:device:read 门） ——


async def test_delete_blocked_while_locked_holder_visible_with_read(client, make_user, fake_adb) -> None:
    """D167 主钉（软删向）：被占设备 delete ⇒ 409 in_use，有 read 位 holder 可见，
    设备没进回收站（卡片墙/强制释放逃生门都还在）。"""
    from app.modules.execution.adb_lock import acquire

    _, h, pid = await _setup(client, make_user, "R1")
    d = await _mk(client, h, pid, "正被执行的设备")
    await acquire(d["serial"], "run:del1:1:worker")
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "in_use", r.text
    body = r.json()
    assert "占用" in body["message"] and "强制释放" in body["message"], body["message"]
    det = body["details"]
    assert det["device_id"] == d["id"]
    assert det["holder"] == "run:del1:1:worker", "occupation 端点在 read 位下给 holder，这里同尺"
    assert det["details_hidden"] is False
    # 没被软删：normal 列表还在，回收站为空
    items = (await client.get("/api/v1/adb-devices", params={"project_id": pid}, headers=h)).json()["items"]
    assert [i["id"] for i in items] == [d["id"]]
    assert (await client.get("/api/v1/adb-devices", params={"project_id": pid, "recycled": True},
                             headers=h)).json()["items"] == []


async def test_delete_locked_holder_hidden_without_read(client, make_user, fake_adb) -> None:
    """只有 adb:device:delete（无 read 位）：照样 409 拦截，但 holder=None +
    details_hidden=True，run 身份串整条响应不许出现（D175 同款尺）。"""
    from app.modules.execution.adb_lock import acquire

    _, h, pid = await _setup(client, make_user, "R2")
    d = await _mk(client, h, pid, "holder要隐瞒的设备")
    _, hu = await _device_only_member(client, make_user, h, pid, "r2")
    await acquire(d["serial"], "run:secret-holder:1:worker")
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                          json={"project_id": pid}, headers=hu)
    assert r.status_code == 409 and r.json()["code"] == "in_use", r.text
    det = r.json()["details"]
    assert det["holder"] is None, "delete 位不隐含 read 位：holder 必须隐瞒"
    assert det["details_hidden"] is True, "隐瞒本身要可见"
    assert "run:secret-holder" not in r.text, "隐瞒 = 整条响应不出现身份串"
    items = (await client.get("/api/v1/adb-devices", params={"project_id": pid}, headers=h)).json()["items"]
    assert [i["id"] for i in items] == [d["id"]], "拦截由数据决定，不由权限决定"


async def test_purge_locked_gate_fires_before_refs(client, make_user, fake_adb) -> None:
    """purge 被占 ⇒ 409 in_use，且锁门在 refs 门之前：同时有引用与锁时，details 是
    锁形状（holder），不是引用形状（count/referring_cases）——物理约束优先。
    （「回收站+持锁」经 API 不可达，但锁键独立于设备表：先软删再 acquire 即此态，
    也是①落地前遗留数据/竞态的真实形状。）"""
    from app.modules.execution.adb_lock import acquire

    boss, h, pid = await _setup(client, make_user, "R3")
    d = await _mk(client, h, pid, "锁与引用双重占")
    await _private_ref_case(pid, d["serial"], "也引用它的案", boss.id)
    assert (await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    await acquire(d["serial"], "run:purge1:1:worker")
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "锁与引用双重占"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "in_use", r.text
    det = r.json()["details"]
    assert det["holder"] == "run:purge1:1:worker", "锁门先开火：details 必须是锁形状"
    assert "count" not in det and "referring_cases" not in det, "refs 门不该抢在锁门前面"
    # 设备还在回收站，没被物理删
    items = (await client.get("/api/v1/adb-devices", params={"project_id": pid, "recycled": True},
                              headers=h)).json()["items"]
    assert [i["id"] for i in items] == [d["id"]]


async def test_purge_locked_holder_hidden_without_read(client, make_user, fake_adb) -> None:
    """purge 向的隐瞒门：只有 adb:device:delete ⇒ 409 + holder=None + hidden=True。"""
    from app.modules.execution.adb_lock import acquire

    _, h, pid = await _setup(client, make_user, "R4")
    d = await _mk(client, h, pid, "purge隐瞒holder")
    _, hu = await _device_only_member(client, make_user, h, pid, "r4")
    assert (await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    await acquire(d["serial"], "run:purge-secret:1:worker")
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "purge隐瞒holder"}, headers=hu)
    assert r.status_code == 409 and r.json()["code"] == "in_use", r.text
    det = r.json()["details"]
    assert det["holder"] is None and det["details_hidden"] is True
    assert "run:purge-secret" not in r.text


async def test_delete_and_purge_ok_after_release(client, make_user, fake_adb) -> None:
    """正对照：锁门只拦「正被占」——释放后软删/purge 照常 200，不是把删除一律焊死。"""
    from app.modules.execution.adb_lock import acquire, release

    _, h, pid = await _setup(client, make_user, "R5")
    d = await _mk(client, h, pid, "释放后能删的设备")
    await acquire(d["serial"], "run:r5:1:worker")
    assert (await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 409
    assert await release(d["serial"], "run:r5:1:worker") is True
    assert (await client.post("/api/v1/adb-devices/" + d["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    # purge 向同证：再占锁 ⇒ 409；强制释放（逃生门）后 ⇒ 200
    await acquire(d["serial"], "run:r5b:1:worker")
    body = {"project_id": pid, "confirm_name": "释放后能删的设备"}
    assert (await client.post("/api/v1/adb-devices/" + d["id"] + "/purge",
                              json=body, headers=h)).status_code == 409
    assert (await client.post("/api/v1/adb-devices/" + d["id"] + "/force-release",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r = await client.post("/api/v1/adb-devices/" + d["id"] + "/purge", json=body, headers=h)
    assert r.status_code == 200, r.text
    assert (await client.get("/api/v1/adb-devices", params={"project_id": pid, "recycled": True},
                             headers=h)).json()["items"] == []
