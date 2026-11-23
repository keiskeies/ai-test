"""D224 判据刀：ADB 设备卡片墙高级搜索（D47-a 三件套铺到设备页）。

钉的契约：

1. **字段白名单 = ADB_DEVICE_LIST_FILTER**（name / serial / connect_type / enabled /
   project_public / created_at / updated_at），meta 与它同源；白名单外 400 带本页清单。
2. **条件是 WHERE**：与项目轴、回收站视图轴、state 三档轴并行 AND。
3. **两把尺子不混**：`state`（空闲/占用/离线）是 Redis 参与的两阶段轴，`recycled` 是视图轴，
   `last_state` 是心跳 JSON 帧，`owner_id`/`updated_by` 是裸 id——都不进条件组；点名它们必 400。
4. **两阶段腿也吃条件**：`state=idle` + 条件时，total 是「条件筛过的在线全集里未持锁的那部分」，
   不是先按 state 数完再在页内过滤。
5. **可见性绕不过**：非公开且非本人拥有的设备，条件命中也不出现（`visible_clause` 先于条件）。
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import fakeredis
import pytest
from fakeredis import FakeAsyncRedis

from app.core.eventbus import EventBus, init_bus
from app.modules.adb_test.models import AdbDevice

_BASE = "/api/v1"
_NOW = datetime.now(UTC).replace(microsecond=0)


@pytest.fixture()
def fake_bus():
    """每用例独立 fakeredis server（test_d47b_adb_device_page 同款）：两阶段腿读锁不碰共享库。"""
    server = fakeredis.FakeServer()
    bus = init_bus(client=FakeAsyncRedis(server=server, decode_responses=True))
    yield bus


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _dev(session, pid: str, *, did: str, name: str, serial: str,
               online: bool | None = True, enabled: bool = True,
               project_public: bool = True, owner_id: str | None = None) -> str:
    """直种一行设备：last_state 的在线位由用例给定（None = 列 NULL，从没测过）。"""
    frame = None if online is None else {"online": online, "model": "Pixel", "os": "13"}
    session.add(AdbDevice(id=did, project_id=pid, name=name, serial=serial,
                          connect_type="wifi", enabled=1 if enabled else 0,
                          last_state=frame, status="normal", project_public=project_public,
                          owner_id=owner_id, created_at=_NOW, updated_at=_NOW))
    await session.commit()
    return did


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _list(client, h, pid: str, **params: Any) -> dict:
    qs: list[tuple[str, str]] = [("project_id", pid)]
    for k, v in params.items():
        if isinstance(v, bool):
            qs.append((k, "true" if v else "false"))
        else:
            qs.append((k, str(v)))
    r = await client.get(_BASE + "/adb-devices", params=qs, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def _names(body: dict) -> set[str]:
    return {x["name"] for x in body["items"]}


async def test_filter_meta_registers_adb_device(client, make_user) -> None:
    _, h = await make_user("d224a", admin=True)
    pid = await _proj(client, h, "D224元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "adb_device"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "adb_device" in body["supported_view_types"]
    assert body["view_label"] == "设备管理"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"name", "serial", "connect_type", "enabled", "project_public",
                      "created_at", "updated_at"}
    # 三把尺子 + 心跳帧 + 裸 id 都不是可筛字段
    assert not ({"state", "recycled", "status", "last_state", "owner_id", "updated_by",
                 "project_id"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["enabled"]["kind"] == "bool"
    assert by_field["connect_type"]["kind"] == "enum"
    assert by_field["created_at"]["kind"] == "time"
    assert "CONTAINS" not in by_field["enabled"]["ops"], "布尔列不该有包含语义"


async def test_conditions_apply_as_where(client, session, make_user, fake_bus: EventBus) -> None:
    _, h = await make_user("d224b", admin=True)
    pid = await _proj(client, h, "D224条件")
    await _dev(session, pid, did="d224-1", name="登录机", serial="10.1.0.1:5555")
    await _dev(session, pid, did="d224-2", name="支付机", serial="10.1.0.2:5555", enabled=False)
    await _dev(session, pid, did="d224-3", name="登录备用", serial="10.1.0.3:5555")

    assert _names(await _list(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"}))) == {"登录机", "登录备用"}
    # 串号是连接对象：按 host 前缀筛
    assert _names(await _list(client, h, pid, filter=_f(
        {"field": "serial", "operator": "CONTAINS", "value": "10.1.0.2"}))) == {"支付机"}
    # 布尔列真按 0/1 比较（enabled 是 SmallInteger）
    assert _names(await _list(client, h, pid, filter=_f(
        {"field": "enabled", "operator": "EQUALS", "value": False}))) == {"支付机"}
    assert _names(await _list(client, h, pid, filter=_f(
        {"field": "enabled", "operator": "EQUALS", "value": True}))) == {"登录机", "登录备用"}
    # OR：名字含「支付」或串号含「.3:」→ 两台
    assert _names(await _list(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "支付"},
        {"field": "serial", "operator": "CONTAINS", "value": ".3:"}, mode="OR"))) == {
        "支付机", "登录备用"}
    # 时间条件真参与比较
    assert _names(await _list(client, h, pid, filter=_f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]}))) == {
        "登录机", "支付机", "登录备用"}
    assert _names(await _list(client, h, pid, filter=_f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["1990-01-01T00:00:00Z", "1991-01-01T00:00:00Z"]}))) == set()


async def test_filter_composes_with_state_two_phase(client, session, make_user,
                                                    fake_bus: EventBus) -> None:
    """两阶段腿（state=idle）吃同一份条件：total 是条件筛过的在线全集里的未持锁行数。"""
    _, h = await make_user("d224c", admin=True)
    pid = await _proj(client, h, "D224两阶段")
    await _dev(session, pid, did="d224-a", name="登录机", serial="10.2.0.1:5555", online=True)
    await _dev(session, pid, did="d224-b", name="支付机", serial="10.2.0.2:5555", online=True)
    # 离线且名字命中：state=idle 本身就会排除它（离线压倒占用），条件再筛一遍也不该冒出来
    await _dev(session, pid, did="d224-c", name="登录备用", serial="10.2.0.3:5555", online=False)

    no_filter = await _list(client, h, pid, state="idle", current=1, size=20)
    assert no_filter["total"] == 2, "两阶段腿的 total 是筛完全集长度"

    one = await _list(client, h, pid, state="idle", current=1, size=20, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"}))
    assert one["total"] == 1, "total 必须吃条件，不是先按 state 数完再在页内过滤"
    assert _names(one) == {"登录机"}


async def test_axes_are_not_filterable(client, make_user) -> None:
    """三把尺子 / 心跳帧 / 裸 id 点名进条件组必须 400，并带上本页清单。"""
    _, h = await make_user("d224d", admin=True)
    pid = await _proj(client, h, "D224轴")
    for field, op, value in (("state", "EQUALS", "idle"), ("recycled", "EQUALS", True),
                             ("status", "EQUALS", "normal"),
                             ("last_state", "CONTAINS", "Pixel"),
                             ("owner_id", "EQUALS", "u-1")):
        bad = await client.get(_BASE + "/adb-devices", params={
            "project_id": pid,
            "filter": _f({"field": field, "operator": op, "value": value}),
        }, headers=h)
        assert bad.status_code == 400, f"{field} 竟然可筛：{bad.text}"
        assert bad.json()["code"] == "bad_filter"
        assert bad.json()["details"]["view_type"] == "adb_device"
    err = await client.get(_BASE + "/adb-devices", params={
        "project_id": pid,
        "filter": _f({"field": "state", "operator": "EQUALS", "value": "idle"}),
    }, headers=h)
    assert "本页可筛" in err.json()["message"]
    assert "设备名" in err.json()["message"]


async def test_visibility_is_not_bypassed_by_filter(client, session, make_user,
                                                    fake_bus: EventBus) -> None:
    """非公开且非本人拥有的设备，条件命中也不现身：visible_clause 先于条件组。"""
    from app.modules.iam.models import ProjectMember

    ua, ha = await make_user("d224e_a")
    ub, _hb = await make_user("d224e_b")
    # 平台管理员建项目，再把人拉进来（ensure_project_access 要成员身份）
    _, hroot = await make_user("d224e_root", admin=True)
    pid = await _proj(client, hroot, "D224可见")
    session.add(ProjectMember(project_id=pid, user_id=ua.id, role_code="READONLY"))
    await session.commit()

    await _dev(session, pid, did="d224-vis", name="别人的登录机", serial="10.3.0.1:5555",
               project_public=False, owner_id=ub.id)
    assert _names(await _list(client, ha, pid)) == set()
    assert _names(await _list(client, ha, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"}))) == set()
