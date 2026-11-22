"""D47-b 步 5e（后端半边）：/adb-devices 三档筛选下推 + 批量占用读数 + 页码分页。

页面唯一真值 = web/src/pages/adbDevices.tsx 的 cardStateOf（:58-62）：
**离线压倒占用**（last_state?.online !== true → offline，严格不等），occupancy 只在
在线之上参与。三档谓词逐字对齐（计划 §五·实测前提 1/3 + 并行评审「优先级会漏」补刀）：
- offline  = (json_extract(last_state,'$.online') = true) IS NOT TRUE —— 纯 SQL 腿；
- occupied = **在线** 且 锁持有；idle = **在线** 且 锁未持有 —— 两阶段腿
  （在线全集一次取回 → occupation_batch 一次 mget → Python 筛 → 切页 + 数 total）。

钉的契约（编号对齐任务书）：
1. mget_keys 直测（它是整块「批量占用」的底座，此前**零调用方零直测**——前缀对称
   set_nx→mget_keys 的真命中、缺键 None、逐位对齐等长、重复键各占一位不塌、空入参 []、
   值逐字等于写入 token（decode 形状：repr 的 b'token' 会在这条红）。
2. **锁键宿主是 serial 不是 id**：拿 serial 建锁，列表那一台 occupied、其余 idle；
   行占用读数三件齐（occupied/holder/queued，与单条 AdbDeviceOccupationOut 同口径——
   前端五处消费占用读数只有一处读布尔，只回 bool 会把其余四处退化成假数据）。
3. 三档互斥且穷尽（离线优先）：离线+有锁只进 offline；在线+有锁只进 occupied；
   在线无锁只进 idle；三档 total 相加 == 不带 state 的 total。
4. 离线谓词的形状：NULL 列/空对象/缺 online 键/数字 1/false 全算离线——「= false」
   与「NOT (= true)」两种顺手写法会把 NULL 系整批漏掉，本用例按整集断言把它们钉死。
5. 排队读数只对持锁行读队列：无持锁却有残留队列 → queued 0（与单条 occupied() 同尺）；
   持锁 + 2 人排队 → queued 2。同 serial 两行都显示占用（一台物理设备）。
6. 判据 5：两腿共用 ORDER BY AdbDevice.id——绝对期望序（id 序 ≠ 插入序 ≠ created_at 序，
   先自证区分度）：页码走查 == 游标走查 == 绝对 id 序，纯 SQL 腿与两阶段腿各自钉。
7. 页码判据全套：cursor+current → 400；state=occupied/idle + cursor → 400（游标切片
   前提不成立，大声报错不装没事）；total 是筛完全集；total=0 键在场；越界页 = 空 + 真 total；
   size=201 → 422；游标响应形状逐字节不变（恰好 {items,next_cursor}，行键向后兼容）。
8. 超限与故障：在线全集超 _STATE_SCAN_CAP → 400 state_filter_too_broad（报错说清缩小
   范围，绝不「只数这一页」冒充「共 N 台」）；Redis 故障时**读不到 ≠ 空闲**——无 state
   路径照常给清单与 total、逐行 occupation=null；state=occupied/idle 整请求 503。
9. transport pin：state 是标量 query 参数——非法值必须 422（Literal 到 handler 的证据）。

**为什么直插 ORM 行**（与 test_d47b_element_page.py 同款取舍）：设备 id 由服务端 uuid4()
生成，走 HTTP 建（还要假 adb 连真帧）就拿不到可控 id 序，而判据 5 需要的正是「id 序 ≠
插入序 ≠ created_at 序」；last_state 的七种形状（NULL/空对象/缺键/false/null/数字1/true）
也只有直插能给全。项目仍走 HTTP 真建，读全部走 HTTP。**锁全部走 fakeredis**（每用例独立
server）：不碰 conftest 默认指向的共享 Redis（db.internal.test:16379/6 是多会话共用的），
也不在共享库里留残留锁。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import fakeredis
import pytest
from fakeredis import FakeAsyncRedis

from app.core.eventbus import EventBus, init_bus
from app.modules.adb_test import device_services
from app.modules.adb_test.models import AdbDevice

_BASE = "/api/v1"
_NOW = datetime.now(UTC).replace(microsecond=0)


@pytest.fixture()
def fake_bus():
    """每用例独立 fakeredis server（test_adb_lock 同款）：共享 Redis 一把都不碰。"""
    server = fakeredis.FakeServer()
    bus = init_bus(client=FakeAsyncRedis(server=server, decode_responses=True))
    yield bus


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _dev(session, pid: str, *, did: str, name: str | None = None,
               serial: str | None = None, last_state: dict | None = None,
               created_at: datetime | None = None) -> str:
    """直种一行设备：id / serial / last_state 形状 / created_at 全由用例给定（模块 docstring）。"""
    session.add(AdbDevice(id=did, project_id=pid, name=name or ("设备" + did),
                          serial=serial or ("10.9." + did.replace("-", ".")),
                          connect_type="wifi", enabled=1, last_state=last_state,
                          status="normal", project_public=True,
                          created_at=created_at or _NOW, updated_at=created_at or _NOW))
    await session.commit()
    return did


async def _list(client, h, pid: str, **params: Any) -> dict[str, Any]:
    qs: list[tuple[str, str]] = [("project_id", pid)]
    for k, v in params.items():
        if isinstance(v, bool):
            qs.append((k, "true" if v else "false"))
        else:
            qs.append((k, str(v)))
    r = await client.get(_BASE + "/adb-devices", params=qs, headers=h)
    assert r.status_code == 200, "HTTP 面预期 200：" + str(r.status_code) + " " + r.text
    return r.json()


def _ids(body: dict[str, Any]) -> list[str]:
    return [x["id"] for x in body["items"]]


def _row(body: dict[str, Any], did: str) -> dict[str, Any]:
    rows = [x for x in body["items"] if x["id"] == did]
    assert len(rows) == 1, "设备 " + did + " 在结果里出现 " + str(len(rows)) + " 次：" + str(_ids(body))
    return rows[0]


# ══════════ 1. mget_keys 直测（前缀链的第一份证据）══════════

async def test_bus_mget_keys_contract(fake_bus: EventBus) -> None:
    """六条直测（探针在真 Redis 上跑过，这里用例化）：前缀对称真命中、缺键 None、
    逐位对齐等长、重复键各占一位不塌、空入参 []、**值逐字等于写入 token**。

    最后一条防的是 decode 形状雷：mget_keys 对取回值做 str(v)，client 没配
    decode_responses 时交出的是 "b'token'"（bytes 的 repr）——不报错，只是 holder 永远错。
    只断言「非 None / truthy」对这个形状是瞎的，必须逐字相等。
    """
    bus = fake_bus
    # ① 前缀对称：adb_lock 写路径（set_nx→channel() 的 tp. 前缀）→ mget_keys 读得到
    await bus.set_nx("adb.dev.SERIAL-A", "run:m1:1:w", 60)
    # ⑤ 空入参 → []
    assert await bus.mget_keys([]) == []
    # ①②③ 命中 / 缺键 / 逐位对齐：入参 3 键 → 出参 3 位，[命中, 缺失, 命中]
    await bus.set_nx("adb.dev.SERIAL-C", "run:m3:1:w", 60)
    got = await bus.mget_keys(["adb.dev.SERIAL-A", "adb.dev.SERIAL-B", "adb.dev.SERIAL-C"])
    assert len(got) == 3, "出参与入参不等长，按下标配回设备必然错位"
    assert got == ["run:m1:1:w", None, "run:m3:1:w"], got
    # ④ 重复键各占一位不塌：同键两次 → 两个独立槽位都有值（批量占用按行下标配回的前提）
    dup = await bus.mget_keys(["adb.dev.SERIAL-A", "adb.dev.SERIAL-A"])
    assert dup == ["run:m1:1:w", "run:m1:1:w"], dup
    # ⑥ 值逐字（repr 形状在这行红）
    assert got[0] == "run:m1:1:w" and isinstance(got[0], str)
    assert not got[0].startswith("b'"), "decode_responses 没了：holder 变成 bytes 的 repr"


async def test_occupation_batch_hits_serial_lock(fake_bus: EventBus) -> None:
    """链证据（HTTP 之下的一层）：acquire(写锁) → occupation_batch 逐台回 holder 逐字相等，
    无锁台 holder=None + queued=0；空入参 {}。"""
    from app.modules.execution.adb_lock import acquire, occupation_batch

    await acquire("10.1.1.1:5555", "run:b1:1:worker")
    await acquire("10.1.1.1:5555", "run:b2:1:worker")   # 排队第 1
    out = await occupation_batch(["10.1.1.1:5555", "10.1.1.2:5555"])
    assert out == {"10.1.1.1:5555": {"holder": "run:b1:1:worker", "queued": 1},
                   "10.1.1.2:5555": {"holder": None, "queued": 0}}, out
    assert await occupation_batch([]) == {}


# ══════════ 2. 批量占用上列表：锁键宿主是 serial ══════════

async def test_list_row_occupation_lock_host_is_serial(client, session, make_user, fake_bus) -> None:
    """拿 serial 建锁 → 列表那一台 occupied 且 holder 逐字、queued 真实，其余 idle。

    批量版若照 occupied() 的形参名拿主键 id 拼 lock_key：每个键都 miss → 全部「空闲」
    且不报错——本用例三行（一把锁 + 排队一人、一把锁没排队、没锁）把这条错法钉死。
    """
    from app.modules.execution.adb_lock import acquire

    _, h = await make_user("d475e1ser", admin=True)
    pid = await _proj(client, h, "D475e宿主")
    await _dev(session, pid, did="sv-1", serial="172.20.0.1:5555", last_state={"online": True})
    await _dev(session, pid, did="sv-2", serial="172.20.0.2:5555", last_state={"online": True})
    await _dev(session, pid, did="sv-3", serial="172.20.0.3:5555", last_state={"online": True})
    await acquire("172.20.0.1:5555", "run:sv-a:1:worker")
    await acquire("172.20.0.1:5555", "run:sv-b:1:worker")  # 排队 #1
    await acquire("172.20.0.2:5555", "run:sv-c:1:worker")

    body = await _list(client, h, pid, size=50)
    r1, r2, r3 = _row(body, "sv-1"), _row(body, "sv-2"), _row(body, "sv-3")
    assert r1["occupation"] == {"occupied": True, "holder": "run:sv-a:1:worker", "queued": 1}, r1
    assert r2["occupation"] == {"occupied": True, "holder": "run:sv-c:1:worker", "queued": 0}, r2
    assert r3["occupation"] == {"occupied": False, "holder": None, "queued": 0}, r3


async def test_batch_reads_queue_only_for_holders(client, session, make_user, fake_bus) -> None:
    """排队键只对**持锁**的那几台读：无锁台留着一条非空队列（释放竞态/强拆残留的形状）→
    queued 仍报 0（与单条 occupied() 的口径逐字一致：holder None 就不读队列）。
    持锁台 2 人排队 → queued 2（D17 真实数字）。"""
    from app.modules.execution.adb_lock import acquire, queue_key

    _, h = await make_user("d475e2que", admin=True)
    pid = await _proj(client, h, "D475e队列")
    await _dev(session, pid, did="q-1", serial="172.21.0.1:5555", last_state={"online": True})
    await _dev(session, pid, did="q-2", serial="172.21.0.2:5555", last_state={"online": True})
    await fake_bus.rpush(queue_key("172.21.0.2:5555"), "ghost:1", "ghost:2")
    await acquire("172.21.0.1:5555", "run:q-a:1:worker")
    await acquire("172.21.0.1:5555", "run:q-b:1:worker")
    await acquire("172.21.0.1:5555", "run:q-c:1:worker")

    body = await _list(client, h, pid, size=50)
    assert _row(body, "q-1")["occupation"]["queued"] == 2
    assert _row(body, "q-2")["occupation"]["queued"] == 0, \
        "没持锁就不该把孤儿队列数进徽标（单条 /occupation 同尺）"


async def test_same_serial_two_rows_both_occupied(client, session, make_user, fake_bus) -> None:
    """serial 不是唯一键（models.py:40 明写同物理设备可进多项目/多行）：两行同 serial，
    一把物理锁 → **两行都显示占用、holder 相同**（物理设备就一台，它确实被占着）。
    批量读数内部按 serial 去重省一次读，但结果必须逐行配回，不许「一键只配一行」。"""
    from app.modules.execution.adb_lock import acquire

    _, h = await make_user("d475e3dup", admin=True)
    pid = await _proj(client, h, "D475e同串")
    await _dev(session, pid, did="ds-1", name="甲项目别名", serial="172.22.0.9:5555",
               last_state={"online": True})
    await _dev(session, pid, did="ds-2", name="乙项目别名", serial="172.22.0.9:5555",
               last_state={"online": True})
    await acquire("172.22.0.9:5555", "run:ds:1:worker")

    body = await _list(client, h, pid, size=50)
    assert _row(body, "ds-1")["occupation"]["holder"] == "run:ds:1:worker"
    assert _row(body, "ds-2")["occupation"]["holder"] == "run:ds:1:worker"
    occ_state = await _list(client, h, pid, size=50, state="occupied")
    assert _ids(occ_state) == ["ds-1", "ds-2"], "同 serial 的两行都要出现在 occupied 里"


# ══════════ 3. 三档互斥且穷尽（离线压倒占用）══════════

async def test_state_three_way_mutex_and_exhaustive(client, session, make_user, fake_bus) -> None:
    """评审补刀的主钉：三种代表行各只进一档——
    ① 离线+无锁 → 只 offline；② 在线+有锁 → 只 occupied；
    ③ 在线+无锁 → 只 idle；④（最易被种子掩盖）**离线+有锁 → 只 offline**
    （锁键对离线设备照样占位是 adb_lock docstring 的常态：run 跑一半设备掉线）。
    末行总账：三档 total 相加 == 不带 state 的 total（漏任一档 / 档间重叠都红）。
    """
    from app.modules.execution.adb_lock import acquire

    _, h = await make_user("d475e3way", admin=True)
    pid = await _proj(client, h, "D475e三档")
    await _dev(session, pid, did="mw-1", name="离线无锁", serial="172.23.0.1:5555",
               last_state={"online": False})
    await _dev(session, pid, did="mw-2", name="在线有锁", serial="172.23.0.2:5555",
               last_state={"online": True})
    await _dev(session, pid, did="mw-3", name="在线无锁", serial="172.23.0.3:5555",
               last_state={"online": True})
    await _dev(session, pid, did="mw-4", name="离线有锁", serial="172.23.0.4:5555",
               last_state={"online": False})
    await acquire("172.23.0.2:5555", "run:mw-held:1:worker")
    await acquire("172.23.0.4:5555", "run:mz-offline-held:1:worker")

    all_body = await _list(client, h, pid, current=1, size=50)
    off = await _list(client, h, pid, current=1, size=50, state="offline")
    occ = await _list(client, h, pid, current=1, size=50, state="occupied")
    idl = await _list(client, h, pid, current=1, size=50, state="idle")

    assert _ids(off) == ["mw-1", "mw-4"], "离线档（含离线有锁）：" + str(_ids(off))
    assert _ids(occ) == ["mw-2"], "占用档（在线且有锁）：" + str(_ids(occ))
    assert _ids(idl) == ["mw-3"], "空闲档（在线且无锁）：" + str(_ids(idl))
    # 离线有锁的那台：界面写「离线」，绝不允许同时出现在占用/空闲
    assert "mw-4" not in _ids(occ) and "mw-4" not in _ids(idl), "离线压倒占用被写反"
    assert off["total"] + occ["total"] + idl["total"] == all_body["total"], \
        "三档不穷尽/有重叠：" + str([off["total"], occ["total"], idl["total"], all_body["total"]])


async def test_offline_predicate_covers_all_null_shapes(client, session, make_user, fake_bus) -> None:
    """离线 = IS NOT TRUE 的七行真值表整集钉：NULL 列 / 空对象 / 缺 online 键 / false /
    null / 数字 1 全算离线，只有 JSON true 不算。

    这条按**整集相等**断言，因此两种「顺手」错法都红：
    - `json_extract=false` → 只命中 false 一行（NULL 系整批漏掉）；
    - `NOT (=true)` → 同样漏掉 NULL 列/空对象/缺键三行（NOT NULL 不为真）。
    数字 1 算离线 = 前端 `last_state?.online !== true` 的严格不等尺（下推不改行为）。
    """
    _, h = await make_user("d475e4nul", admin=True)
    pid = await _proj(client, h, "D475e离线形")
    await _dev(session, pid, did="nl-null", name="整列NULL", last_state=None)
    await _dev(session, pid, did="nl-empty", name="空对象", last_state={})
    await _dev(session, pid, did="nl-miss", name="缺键", last_state={"model": "X"})
    await _dev(session, pid, did="nl-false", name="显式false", last_state={"online": False})
    await _dev(session, pid, did="nl-nulld", name="显式null", last_state={"online": None})
    await _dev(session, pid, did="nl-one", name="数字1", last_state={"online": 1})
    await _dev(session, pid, did="nl-true", name="在线", last_state={"online": True})

    off = await _list(client, h, pid, current=1, size=50, state="offline")
    assert _ids(off) == ["nl-empty", "nl-false", "nl-miss", "nl-null", "nl-nulld", "nl-one"], \
        "离线档必须收齐 NULL/空/缺键/false/null/数字1（=false 与 NOT() 两种错法的命中集都更小）：" \
        + str(_ids(off))
    assert off["total"] == 6
    # 在线的那台不进离线档，进空闲档（无锁）
    idl = await _list(client, h, pid, current=1, size=50, state="idle")
    assert _ids(idl) == ["nl-true"]


# ══════════ 6. 判据 5：两腿绝对期望序 ══════════

async def test_two_legs_share_absolute_id_order(client, session, make_user, fake_bus) -> None:
    """纯 SQL 腿（不带 state）与两阶段腿（state=idle）都走查成**绝对 id 升序**，
    页码与游标走查都一致。种子先自证区分度：id 字典序 ≠ 插入序 ≠ created_at 序
    （姊妹刀教训：自证红在自己的种子上 = 自证无效；这里三条互异性逐条在位）。

    id 字典序 a<d<m<q<t<z；插入序 z,t,q,a,d,m；created_at 老→新 m,q,z,d,t,a。
    （第一版种子栽过：插入序取 z,t,q,m,d,a 时它的**倒序恰好等于 id 升序**，第二条互异性
    断言当场红——互异性断言的价值就在这：换种子先被自己拦住，而不是被后人换掉。）
    """
    _, h = await make_user("d475e5ord", admin=True)
    pid = await _proj(client, h, "D475e序")
    plan = [("dv-z", 4), ("dv-t", 6), ("dv-q", 2), ("dv-a", 8), ("dv-d", 3), ("dv-m", 1)]
    inserted = [d for d, _ in plan]
    for did, back in plan:
        await _dev(session, pid, did=did, name="序" + did,
                   serial="172.24.0." + did[-1] + ":5555",
                   last_state={"online": True}, created_at=_NOW - timedelta(days=back))

    expected = sorted(inserted)
    by_time_asc = [d for d, _ in sorted(plan, key=lambda x: x[1])]
    assert expected != inserted, "种子没区分度（id 序 == 插入序），本例白测"
    assert expected != list(reversed(inserted)), "种子没区分度（id 序 == 插入序倒序），本例白测"
    assert expected != by_time_asc, "种子没区分度（id 序 == created_at 升序），本例白测"

    async def _page_walk(**extra: Any) -> list[str]:
        walk: list[str] = []
        for current in (1, 2, 3):
            b = await _list(client, h, pid, size=2, current=current, **extra)
            assert b["total"] == 6, "每页 total 恒等于全集条数：" + str(b["total"])
            walk += _ids(b)
        return walk

    sql_leg = await _page_walk()
    assert sql_leg == expected, "纯 SQL 腿页码走查必须 = id 升序：" + str(sql_leg)
    two_leg = await _page_walk(state="idle")
    assert two_leg == expected, "两阶段腿（Redis 筛完再切页）必须同一条 ORDER BY：" + str(two_leg)

    cursor_walk: list[str] = []
    cursor: str | None = None
    for _ in range(8):
        b = await _list(client, h, pid, size=2) if cursor is None else \
            await _list(client, h, pid, size=2, cursor=cursor)
        cursor_walk += _ids(b)
        cursor = b["next_cursor"]
        if cursor is None:
            break
    assert cursor_walk == expected, "游标走查与绝对期望序不同：" + str(cursor_walk)


# ══════════ 7. 页码判据：形状 / 互斥 / total / 越界 / 422 ══════════

async def test_wire_shape_cursor_unchanged_and_paged_total(client, session, make_user, fake_bus) -> None:
    """游标模式响应恰好 {items,next_cursor}（**逐字节形状不变**，行键向后兼容：
    旧行键集合 + 新 occupation 一个）；页码模式恰好 {items,next_cursor,total} 且
    next_cursor is None；size=201 → 422；state 非法值 → 422（Literal 到 handler 的 transport 钉）。"""
    _, h = await make_user("d475e6shr", admin=True)
    pid = await _proj(client, h, "D475e形状")
    for i in range(3):
        await _dev(session, pid, did="sh-" + str(i), name="形" + str(i),
                   serial="172.25.0." + str(i) + ":5555", last_state={"online": True})

    body = await _list(client, h, pid, size=2)
    assert set(body) == {"items", "next_cursor"}, "游标首页多/少键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    nxt = await _list(client, h, pid, size=2, cursor=body["next_cursor"])
    assert set(nxt) == {"items", "next_cursor"}, "游标续页形状变了：" + str(sorted(nxt))
    # 行向后兼容：旧字段一个不丢（occupied_by 历史键仍在），且**只**新增 occupation 一个——
    # 精确键集钉（信封级同款纪律：凭空多键没人评审过就是改契约）
    legacy = {"id", "project_id", "name", "serial", "connect_type", "wifi_addr", "enabled",
              "last_state", "owner_id", "project_public", "status", "updated_by",
              "updated_by_name", "created_at", "updated_at", "occupied_by"}
    assert set(body["items"][0]) == legacy | {"occupation"}, \
        "行键集必须 = 旧键 + occupation（多一键=没评审过的契约变更，少一键=向后兼容回退）：" \
        + str(sorted(set(body["items"][0])))

    paged = await _list(client, h, pid, size=10, current=1)
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码模式必须带 total：" + str(sorted(paged))
    assert paged["next_cursor"] is None, "页码模式不产游标（两套真相并存禁止）"

    over = await client.get(_BASE + "/adb-devices",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422, "size 越界是 422 不是钳位：" + over.text
    bad = await client.get(_BASE + "/adb-devices",
                           params={"project_id": pid, "state": "sleeping"}, headers=h)
    assert bad.status_code == 422, "state 词表外必须 422（Literal 没到 handler 就会静默 None）：" + bad.text


async def test_dual_param_400_rules(client, session, make_user, fake_bus) -> None:
    """cursor+current → 400；**state=occupied/idle + cursor → 400**（游标切片的前提
    「按 id 往前翻只看 SQL」在 Redis 筛选下不成立，指路 current）；
    state=offline + cursor 合法（纯 SQL 腿）；state=occupied + current 合法。"""
    from app.modules.execution.adb_lock import acquire

    _, h = await make_user("d475e7dual", admin=True)
    pid = await _proj(client, h, "D475e互斥")
    for i in range(4):
        await _dev(session, pid, did="du-" + str(i), name="设" + str(i),
                   serial="172.26.0." + str(i) + ":5555", last_state={"online": i != 3})
    await acquire("172.26.0.0:5555", "run:du:1:worker")

    first = await _list(client, h, pid, size=2)
    both = await client.get(_BASE + "/adb-devices", params={
        "project_id": pid, "size": 2, "cursor": first["next_cursor"], "current": 2}, headers=h)
    assert both.status_code == 400, "cursor 与 current 同时到场必须大声报错：" + both.text
    assert both.json()["code"] == "bad_request"

    for st in ("occupied", "idle"):
        r = await client.get(_BASE + "/adb-devices", params={
            "project_id": pid, "size": 2, "state": st, "cursor": first["next_cursor"]}, headers=h)
        assert r.status_code == 400, "state=" + st + " 带 cursor 必须 400 而不是默默按游标切片：" + r.text
        assert r.json()["code"] == "bad_request" and "current" in r.json()["message"], r.text

    ok_off = await _list(client, h, pid, size=2, state="offline", cursor=first["next_cursor"])
    # 唯一离线台是 du-3（id 最大），游标从 du-1 续页它仍 > 游标值 → 离线腿照常走通并返回它
    assert _ids(ok_off) == ["du-3"], "offline 是纯 SQL 腿，游标续页必须合法且筛对：" + str(_ids(ok_off))
    ok_occ = await _list(client, h, pid, size=2, state="occupied", current=1)
    assert _ids(ok_occ) == ["du-0"]


async def test_state_without_current_is_page_one_not_an_error(client, session, make_user, fake_bus) -> None:
    """state=occupied/idle **省略** current 是合法的：落到第 1 页、total 照给（200 不是 400）。

    为什么单独钉一条：被禁的组合只有「带 **cursor**」（游标腿没法整集读锁）与「双参同传」，
    「不带 current」从来不在禁列里 —— `current = max(1, int(payload.current or 1))` 缺省第 1 页。
    这句话本轮被误写成「state 档必须带 current 否则 400」并被下游照做（派活前提），
    而上面那条只测了「带 current 的合法腿」，省不省略没人钉 —— 于是没有一条测试能纠正它。
    前端恒带 current 所以线上行为不受影响，钉的是**契约本身**，不是某个调用方的习惯。
    """
    from app.modules.execution.adb_lock import acquire

    _, h = await make_user("d475e10nocur", admin=True)
    pid = await _proj(client, h, "D475e省略current")
    for i in range(3):
        await _dev(session, pid, did="nc-" + str(i), name="省" + str(i),
                   serial="172.27.0." + str(i) + ":5555", last_state={"online": True})
    await acquire("172.27.0.1:5555", "run:nc:1:worker")

    bare = await client.get(_BASE + "/adb-devices",
                            params={"project_id": pid, "size": 2, "state": "occupied"}, headers=h)
    assert bare.status_code == 200, "省略 current 是「要第 1 页」，不是错误：" + str(bare.status_code) + " " + bare.text
    body = bare.json()
    assert _ids(body) == ["nc-1"], "缺省必须落第 1 页且筛对（只有 nc-1 持锁）：" + str(_ids(body))
    assert body["total"] == 1, "省略 current 时 total 照样是真总数，不许因此退化成不给：" + str(body["total"])
    assert body["next_cursor"] is None, "页码语义（缺省也是页码）不产游标"

    explicit = await _list(client, h, pid, size=2, state="occupied", current=1)
    assert _ids(explicit) == _ids(body) and explicit["total"] == body["total"], \
        "省略 current 与显式 current=1 必须逐字同结果——否则「缺省」就不是第 1 页，是第三种东西"


async def test_total_counts_filtered_set_zero_and_overpage(client, session, make_user, fake_bus) -> None:
    """total 数 WHERE 筛完全集：occupied=2 / idle=1 / offline=1 / 不筛=4 四个数互不相等，
    「本页 len=1」咬不进任何一个空子；筛空 total=0 键在场；current 越界 = 空 items + 真 total
    （两阶段腿同样：occupied 的第 2 页空但 total 仍是 2）。"""
    from app.modules.execution.adb_lock import acquire

    _, h = await make_user("d475e8tot", admin=True)
    pid = await _proj(client, h, "D475e计数")
    await _dev(session, pid, did="ct-1", name="占一", serial="172.27.0.1:5555", last_state={"online": True})
    await _dev(session, pid, did="ct-2", name="占二", serial="172.27.0.2:5555", last_state={"online": True})
    await _dev(session, pid, did="ct-3", name="闲一", serial="172.27.0.3:5555", last_state={"online": True})
    await _dev(session, pid, did="ct-4", name="线一", serial="172.27.0.4:5555", last_state={"online": False})
    await acquire("172.27.0.1:5555", "run:ct-a:1:worker")
    await acquire("172.27.0.2:5555", "run:ct-b:1:worker")

    occ = await _list(client, h, pid, current=1, size=1, state="occupied")
    idl = await _list(client, h, pid, current=1, size=1, state="idle")
    off = await _list(client, h, pid, current=1, size=1, state="offline")
    plain = await _list(client, h, pid, current=1, size=1)
    assert [occ["total"], idl["total"], off["total"], plain["total"]] == [2, 1, 1, 4]
    assert len(occ["items"]) == 1, "total 不是本页行数"
    p2 = await _list(client, h, pid, current=2, size=1, state="occupied")
    assert _ids(p2) == ["ct-2"] and p2["total"] == 2, "两阶段腿第 2 页取剩的那台，total 恒 2"
    p3 = await _list(client, h, pid, current=3, size=1, state="occupied")
    assert p3["items"] == [] and p3["total"] == 2, "越界页 = 空 + 真 total（两阶段腿），不是 500"
    assert p3["next_cursor"] is None
    none = await _list(client, h, pid, current=1, size=2, state="occupied", recycled=True)
    assert "total" in none, "total=0 不许被 falsy 判断吞掉这个键"
    assert none["total"] == 0 and none["items"] == []


# ══════════ 8. 超限与故障：不许说谎页脚、读不到 ≠ 空闲 ══════════

async def test_state_scan_cap_is_loud_error(client, session, make_user, fake_bus, monkeypatch) -> None:
    """在线全集超上限 → 400 state_filter_too_broad，message 带上限数字与缩小范围出口；
    同一批数据走纯 SQL 腿（offline / 不筛）**不受上限约束**照常 200——
    上限只属于「必须整集读锁」的两阶段腿（宁可报错也不发假 total）。"""
    _, h = await make_user("d475e9cap", admin=True)
    pid = await _proj(client, h, "D475e上限")
    for i in range(5):
        await _dev(session, pid, did="cp-" + str(i), name="上" + str(i),
                   serial="172.28.0." + str(i) + ":5555", last_state={"online": True})
    monkeypatch.setattr(device_services, "_STATE_SCAN_CAP", 3)

    r = await client.get(_BASE + "/adb-devices",
                         params={"project_id": pid, "current": 1, "size": 2, "state": "idle"}, headers=h)
    assert r.status_code == 400, "超限必须大声报错而不是给一个只数了部分的 total：" + r.text
    body = r.json()
    assert body["code"] == "state_filter_too_broad", body
    assert "3" in body["message"] and ("offline" in body["message"] or "缩小" in body["message"]), body["message"]

    off = await _list(client, h, pid, current=1, size=2, state="offline")
    assert off["total"] == 0 and off["items"] == []  # 纯 SQL 腿不触发上限
    plain = await _list(client, h, pid, current=1, size=2)
    assert plain["total"] == 5, "不带 state 的页码路径与上限无关"


async def test_redis_failure_unknown_is_not_idle(client, session, make_user, fake_bus, monkeypatch) -> None:
    """Redis 挂掉的两个形状（评审补刀：「读不到 ≠ 空闲」是底线）：
    - 无 state：清单照常 200 + total 照给（设备清单是 MySQL 的），但**每行
      occupation 必须是 null**——null=没读到，前端画「读数缺失」；若这里塌缩成
      occupied:false 就是整页假「空闲」（§13 纪律 1）。
    - state=occupied：total 由锁算出，读不到锁就没有可信形状 → 503 指路，
      不返回「看起来正常的空列表」。"""
    async def _boom(_serials: list[str]) -> dict[str, dict[str, Any]]:
        raise ConnectionError("redis down (test injected)")

    _, h = await make_user("d475e0fail", admin=True)
    pid = await _proj(client, h, "D475e故障")
    await _dev(session, pid, did="fl-1", name="故障台", serial="172.29.0.1:5555", last_state={"online": True})
    monkeypatch.setattr(device_services, "occupation_batch", _boom)

    body = await _list(client, h, pid, current=1, size=10)
    assert body["total"] == 1 and _ids(body) == ["fl-1"], "清单不许被 Redis 拖垮"
    assert body["items"][0]["occupation"] is None, \
        "读不到必须交 null（未知），塌缩成 occupied:false 就是画了一页假空闲"

    r = await client.get(_BASE + "/adb-devices",
                         params={"project_id": pid, "current": 1, "size": 10, "state": "occupied"}, headers=h)
    assert r.status_code == 503, "state=occupied 遇锁库故障必须 503 而不是空列表装正常：" + r.text
    assert r.json()["code"] == "lock_store_unavailable", r.json()
