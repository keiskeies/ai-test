"""设备服务面（§4.5 / §11.4.14 / D2）：CRUD + 先 connect 验证再入库 + 测试即拍 + 重连。

三条这里特有的口径：
- **先 connect 验证再入库**（§4.5 原文「先 adb connect 验证再入库」）：create 时设备必须
  `adb connect` 得通 + getprop 拉得到机型。失败 → 422 `connect_failed` + 排错提示（那是
  人话，不是 500）。成功才 201 且落 last_state 首帧。
- **D14：connect_type=USB 写入口一期 422 拒绝**（静默改写成 WIFI 是 §13 纪律 1 的镜像违例）。
- **删除前占用检测**（D167，已实现）：delete/purge 动数据前都查执行锁（occupied），
  被占 ⇒ 409 in_use（holder 按 adb:device:read 隐瞒）；purge 里锁检测在引用检测之前
  （物理约束优先）。「被 adb_case.default_device 引用」的 purge 拦截与 detach 仍在
  （引用完整性是 1A 起的老规矩）。引用数量与列表徽标同一次扫描（schemas 模块注释的
  「安全数字」口径）。
"""
from __future__ import annotations

import base64
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
from sqlalchemy import func, select

from app.core.errors import ApiError, Page, paginate, paginate_page
from app.core.permissions import match_perm
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.adb_test import schemas
from app.modules.adb_test.case_services import _user_names
from app.modules.adb_test.models import STATUS_RECYCLED, AdbCase, AdbDevice
from app.modules.execution.adb_cli import (
    adb_connect,
    adb_disconnect,
    adb_executable,
    adb_getprop,
    adb_screencap,
)
from app.modules.execution.adb_lock import force_release, occupation_batch, occupied
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.visibility import assert_row_visible, visible_clause

# 引用明细上限（notify/service.py:35、iam/role_services.py:34 同款尺）：count 全量照报，
# 明细只给前 REF_DETAIL_CAP 条，截了必须用 details_truncated 说出口。
REF_DETAIL_CAP = 20

# D224：设备卡片墙的可筛面（D47-a 三件套铺到设备页）。白名单只收 `adb_device` 上真实
# 存在的列：name / serial / connect_type / enabled / project_public / created_at /
# updated_at。刻意不进的四项，理由各自写明：
# - `state`（空闲/占用/离线）不是 SQL 列：占用一半在 Redis，本页已有自己的 Segmented
#   三档轴（含两阶段取数 + 超限大声报错）。把它再塞进条件组 = 两把尺子量同一个词；
# - `recycled` / `status` 是视图轴（回收站开关），进 UI 是「换个视图」不是「按属性筛」；
# - `owner_id` / `updated_by` 是裸 id：界面上没有人名可比，按 id 筛是给调用方用的；
# - `last_state` 是心跳 JSON 帧（机型/电量/在线），不是属性列。
ADB_DEVICE_LIST_FILTER = ListViewFilter(
    view_type="adb_device",
    label="设备管理",
    fields={
        "name": FieldDecl(AdbDevice.name, "text", "设备名", nullable=False),
        "serial": FieldDecl(AdbDevice.serial, "text", "连接地址", nullable=False),
        "connect_type": FieldDecl(AdbDevice.connect_type, "enum", "连接方式", nullable=False),
        "enabled": FieldDecl(AdbDevice.enabled, "bool", "启用", nullable=False),
        "project_public": FieldDecl(AdbDevice.project_public, "bool", "项目内公开", nullable=False),
        "created_at": FieldDecl(AdbDevice.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(AdbDevice.updated_at, "time", "更新时间", nullable=False),
    },
)
register(ADB_DEVICE_LIST_FILTER)

# D47-b 步 5e 两阶段取数（state=occupied/idle）的 SQL 全集硬上限。超限**报错**而不是
# 只数本页：Redis 读数进不了 SQL，「筛完全集再数 total」的前提是全集取回；给不出真
# total 时宁可报错也不发一个「共 N 台」的说谎页脚（§三禁令，§五·实测前提 3）。
# 码取 400：这是「本次请求的筛选组合给不出真 total」，换更小的页/换个 state 就能重试，
# 不是条件头不满足的 412（仓内零处用 412，无先例）；本函数抛的就是 400
# state_filter_too_broad，测试钉的也是 400（test_d47b_adb_device_page.
# test_state_scan_cap_is_loud_error）——注释先前写 412 属漂，以代码与用例为准。
# 2000 = 单请求一次 mget + 一次全行取回的舒适区；真到了这个量级，缩小范围的出口是
# project（本查询本就锁死单项目）→ 这一页的数据形态本身需要人看一眼。
_STATE_SCAN_CAP = 2000


def _online_cond():
    """在线谓词 = `json_extract(last_state,'$.online') IS TRUE`（判据的**唯一**构造点）。

    `== True` 不是笔误：对 JSON 表达式它是 SQL 比较，不是 Python 真值比较。两种形态的
    渲染结果现跑核过（MySQL 8.4.13 dialect 编译）：`== True` → `json_extract(adb_device.
    last_state, '$.online') = true`（JSON 比较，只有 JSON true 命中；NULL 列/缺键交 NULL，
    作 WHERE 条件即被排除——正是「在线」全集该有的边界），`.is_(True)` 才是 `IS true`，
    `.is_not(True)` → `... IS NOT true`（_offline_cond 用）。`== True` 触发 ruff E712 的
    误报，故 noqa——把它「顺手改成」`= false` / `~(...)` 都是行为改变，见 _offline_cond。
    """
    return func.json_extract(AdbDevice.last_state, "$.online") == True  # noqa: E712


def _offline_cond():
    """离线谓词 = 在线取反的 **IS NOT TRUE** 形态，不是 `= false`，也不是 `NOT (= true)`。

    真库七行真值表（MySQL 8.4.13 现跑）：NULL 列 / 空对象 / 缺 online 键让 json_extract
    交出 SQL NULL，`= true` 对它们是 NULL 而非 0，`NOT NULL` 仍不为真——取反写法会把
    这批行**整批漏掉**（实测 `NOT (=true)` 命中 {false,null,数字1} 三行，`IS NOT TRUE`
    命中六行，`json_extract=false` 只命中 {false} 一行）。数字 1 也算离线——与前端
    adbDevices.tsx cardStateOf 的 `row.last_state?.online !== true`（严格不等）逐字同尺，
    筛选下推因此不改变现有行为。last_state 整列为 NULL（从没探测过）= 离线，同样覆盖。
    """
    return _online_cond().is_not(True)


async def _safe_occupation_batch(serials: list[str]) -> tuple[dict[str, dict[str, Any]], bool]:
    """占用读数的故障降级：返回 (读数表, 是否读失败)。空入参 ({}, False)——没读不等于读挂。

    Redis 挂掉既不意味着设备空闲（异常穿门 → 列表整条 500，设备清单本是 MySQL 的照看不了；
    吞掉给空读数 → 卡片全画「空闲」，是说谎），所以这里把失败如实带出去，由调用方分路：
    无 state 筛选 → 行 occupation=None（「没读到」，前端画读数缺失）；
    state=occupied/idle → 整个 503（total 由锁算出，读不到锁就没有可信的列表形状）。
    serial 去重再发（两行同 serial 共用一次锁读——物理设备只有一台，读数天然同值）。
    """
    if not serials:
        return {}, False
    try:
        occ = await occupation_batch(list(dict.fromkeys(serials)))
    except Exception:  # noqa: BLE001  读数故障面 = bus 连接/命令的一切异常；语义按「读不到」统一降级
        return {}, True
    return occ, False


def _row_occupation(d: AdbDevice, occ: dict[str, dict[str, Any]]) -> schemas.AdbDeviceRowOccupation | None:
    """行 → 占用读数。读数表里没这台 = **没读到** → None，不许塌缩成 occupied:false 的空闲。

    Redis 故障时调用方拿到的是空表（_safe_occupation_batch 的降级形状），整页逐行 None；
    「没读到」与「读到空闲」在响应里是两个形状（null vs occupied:false），页脚/卡片各自如实。
    """
    snap = occ.get(d.serial)
    if snap is None:
        return None
    return schemas.AdbDeviceRowOccupation(occupied=snap["holder"] is not None,
                                          holder=snap["holder"], queued=int(snap["queued"]))


def _wifi_addr_from_serial(serial: str) -> str:
    """WiFi serial `host:port` → host；给了完整 serial 时 wi wifi_addr 自动带出。"""
    return serial.rsplit(":", 1)[0] if ":" in serial else serial


def _state_frame(*, model: str | None, os_version: str | None, online: bool,
                 battery_level: int | None) -> dict[str, Any]:
    """设备 last_state 帧的标准形状（建连首帧与心跳帧同一形状：机型/系统/电量/在线）。"""
    return {
        "model": model, "os": os_version, "online": online,
        "battery_level": battery_level,
        "last_check_at": datetime.now(UTC).isoformat(),
    }


async def _device(db, project_id: str, device_id: str) -> AdbDevice:
    d = (await db.execute(select(AdbDevice).where(
        AdbDevice.id == device_id, AdbDevice.project_id == project_id))).scalar_one_or_none()
    if d is None:
        raise ApiError("not_found", "ADB 设备不存在", 404, {"device_id": device_id})
    return d


def _out(d: AdbDevice, updated_by_name: str | None = None, *,
         occupation: schemas.AdbDeviceRowOccupation | None = None) -> schemas.AdbDeviceOut:
    return schemas.AdbDeviceOut(
        id=d.id, project_id=d.project_id, name=d.name, serial=d.serial,
        connect_type=d.connect_type, wifi_addr=d.wifi_addr, enabled=bool(d.enabled),
        last_state=d.last_state, owner_id=d.owner_id, project_public=d.project_public,
        status=d.status, updated_by=d.updated_by, updated_by_name=updated_by_name,
        created_at=schemas.iso(d.created_at), updated_at=schemas.iso(d.updated_at),
        occupation=occupation,
    )


async def _connect_verify(serial: str) -> tuple[str, str]:
    """先 connect 验证：connect 得通 + getprop 拉机型/系统。失败 → 422 排错提示。

    返回 (model, os_version)；connect_fail 的设备（fake 或真实目标）在这条路上必须变成
    可读的 422，不是 500——「连不上」是用户该修的配置问题。成功帧的组装由调用方
    _state_frame 完成（建连与心跳同一形状）。
    """
    try:
        adb_executable()
    except RuntimeError as e:
        raise ApiError("connect_failed", str(e), 422, {"serial": serial}) from e
    c = await adb_connect(serial)
    if not c.ok:
        # connect 的 stderr/stdout 原样回显 + 排错提示（§4.5「原样回显」）
        raise ApiError("connect_failed",
                       "adb connect " + serial + " 失败：" + (c.error or c.text), 422, {"serial": serial})
    model = (await adb_getprop(serial, "ro.product.model")).text.strip()
    osver = (await adb_getprop(serial, "ro.build.version.release")).text.strip()
    return model or "未知机型", osver or "未知系统"


@service(
    perm="adb:device:create", effect="write", name="adb_device_create",
    description="创建 ADB 设备（先 adb connect 验证再入库：连不上 → 422 排错提示；成功才 201）",
    http={"method": "POST", "path": "/adb-devices", "tags": ["adb"], "status": 201},
)
async def adb_device_create(payload: schemas.AdbDeviceCreateIn, ctx) -> schemas.AdbDeviceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:create")
    assert ctx.db is not None
    if payload.connect_type == "usb":
        raise ApiError("validation_failed", "USB 连接设备一期暂不支持写入口（D14）：请用 WiFi 地址创建，"
                       "或等待后续批次启用 USB", 422, {"connect_type": "usb"})
    dup = (await ctx.db.execute(select(AdbDevice).where(
        AdbDevice.project_id == payload.project_id, AdbDevice.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        msg = "设备名在回收站占位，请先恢复或改名" if dup.status == STATUS_RECYCLED else "设备名已存在"
        raise ApiError("conflict", msg, 409, {"name": payload.name})
    verify_model, verify_os = await _connect_verify(payload.serial)
    d = AdbDevice(project_id=payload.project_id, name=payload.name, serial=payload.serial,
                  connect_type="wifi", wifi_addr=payload.wifi_addr or (_wifi_addr_from_serial(payload.serial)),
                  enabled=1 if payload.enabled else 0,
                  last_state=_state_frame(model=verify_model, os_version=verify_os,
                                          online=True, battery_level=None),
                  owner_id=ctx.user_id, project_public=payload.project_public, updated_by=ctx.user_id)
    ctx.db.add(d)
    await ctx.db.commit()
    return _out(d)


@service(
    perm="adb:device:read", effect="read", name="adb_device_list",
    description="列出项目下的 ADB 设备（默认不含回收站；last_state 是最新心跳帧；"
                "state=offline/occupied/idle 按卡片三档筛选、每行带占用读数、页码模式报真 total）",
    http={"method": "GET", "path": "/adb-devices", "tags": ["adb"]},
)
async def adb_device_list(payload: schemas.AdbDeviceListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:read")
    assert ctx.db is not None
    stmt = select(AdbDevice).where(
        AdbDevice.project_id == payload.project_id,
        visible_clause(AdbDevice, ctx),
        AdbDevice.status == (STATUS_RECYCLED if payload.recycled else "normal"),
    )
    # D224：高级搜索条件组进同一个 WHERE，位置在 order_by 与两条取数腿之前——
    # ① 白名单外 400 带本页清单（parse 的文案），不降级成「忽略这条继续查」；
    # ② 两阶段腿（occupied/idle）筛的是同一份条件后的在线全集，total 与状态轴不吃两套口径；
    # ③ visible_clause 已在上面，条件组绕不过「非公开仅 owner 可见」。
    stmt = stmt.where(ADB_DEVICE_LIST_FILTER.parse(payload.filter))
    # 判据 5 的「同一个表达式」在本函数内只有一个来源：两腿（SQL 分页腿 / 两阶段腿）都吃
    # 这条已排序 stmt，ORDER BY AdbDevice.id 一次定死，谁都不许另排。
    stmt = stmt.order_by(AdbDevice.id)
    # cursor 与 current 互斥（逐字照姊妹刀 ui_element_list 步 5c）：两套「我在哪」的真相
    # 一起到场是调用方的 bug，静默择一会把错位藏进翻页里。
    if payload.current is not None and payload.cursor is not None:
        raise ApiError("bad_request", "cursor 与 current 只能给一个", 400,
                       {"cursor": payload.cursor, "current": payload.current})
    if payload.state == "offline":
        # 纯 SQL 腿：离线谓词见 _offline_cond（IS NOT TRUE 形态）。游标/页码两种模式都能用，
        # total 与 items 吃同一份 WHERE（筛完再数，MS PageHelper 同构）。
        stmt = stmt.where(_offline_cond())
    elif payload.state in ("occupied", "idle"):
        # 两阶段腿（§五·实测前提 3）：occupied/idle 的真相一半在 Redis，做不成 SQL 谓词。
        # 先按「在线」把 SQL 层筛完（occupied 也必须先 AND 在线——离线设备照样持锁，只查锁
        # 会把界面画成「离线」的机器选进「占用」，筛选与卡片各说一套就是这刀要消灭的说谎）。
        # 整集取回 → 一次 mget 批量读锁 → Python 筛 → 切页 + 数 total。
        if payload.cursor is not None:
            # 游标切片的前提「按 id 走到哪都只回看 SQL」在这里不成立：锁读不全取完根本
            # 筛不了。与其给一个游标语义名存实亡的响应，不如大声 400 指路。
            raise ApiError("bad_request",
                           "state=occupied/idle 依赖 Redis 锁全集读数，无法用游标翻页；请用 current 页码",
                           400, {"state": payload.state, "cursor": payload.cursor})
        stmt = stmt.where(_online_cond())
        # 上限 +1 一次取回：行数本身就是「超没超」的证据，不用另发 COUNT。
        rows_all = (await ctx.db.execute(stmt.limit(_STATE_SCAN_CAP + 1))).scalars().unique().all()
        if len(rows_all) > _STATE_SCAN_CAP:
            # 说谎页脚的另一个形状：超限后「只数这一页/只筛这一页」就是假 total（§三禁令）。
            # 报错并把缩小范围的出口说清——本端点没有设备子集参数，缩范围只剩 recycled
            # 视图、state=offline（纯 SQL 不受上限约束）或按项目拆。
            raise ApiError(
                "state_filter_too_broad",
                "在线设备超过 " + str(_STATE_SCAN_CAP) + " 台：occupied/idle 需要整集读锁才报得出真 total，"
                "本次拒绝给一个只数了部分行的假「共 N 台」。缩小范围：改用 state=offline 先排除离线的、"
                "切 recycled 视图、或按项目拆小。", 400,
                {"state": payload.state, "cap": _STATE_SCAN_CAP})
        occ, read_failed = await _safe_occupation_batch([d.serial for d in rows_all])
        if read_failed:
            # 「读不到」不能塌缩成空读数（那等于宣布整页空闲），也不能整条 500（设备清单
            # 本身是 MySQL 的——无 state 路径会照常服务）。可 total 是锁算出来的，此刻列表
            # 形状无从谈起：503 + 指路，比一个「看起来正常的空列表」诚实（评审补刀 §13 纪律 1）。
            raise ApiError("lock_store_unavailable",
                           "设备锁读数不可用（Redis 故障），state=occupied/idle 无法给出可信的列表与 total；"
                           "请去掉 state 先看设备清单，或稍后重试", 503, {"state": payload.state})
        want_held = payload.state == "occupied"
        kept = [d for d in rows_all if ((occ.get(d.serial) or {}).get("holder") is not None) == want_held]
        # 与 paginate_page 同款的钳位（default 走 schema 的 50；越界 422 在 schema 层已拦）。
        size = max(1, min(int(payload.size or 20), 200))
        current = max(1, int(payload.current or 1))
        rows = kept[(current - 1) * size:current * size]
        names = await _user_names(ctx.db, {d.updated_by for d in rows if d.updated_by})
        # total 恒为筛完全集长度（两阶段腿的 total 就是 len(kept)，天然「筛完再数」）；
        # next_cursor=None：页码模式不产游标（两套真相并存禁止，姊妹刀同款）。
        return Page(items=[_out(d, updated_by_name=names.get(d.updated_by or ""),
                                occupation=_row_occupation(d, occ)) for d in rows],
                    next_cursor=None, total=len(kept))
    # 无 state / state=offline：SQL 分页腿。双参互斥已在上面拦过。
    if payload.current is not None:
        page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    else:
        page = await paginate(ctx.db, stmt, cursor_col=AdbDevice.id, row_key=lambda r: r.id,
                              cursor=payload.cursor, size=payload.size)
    # 行上的占用读数（D47-b 步 5e）：一次 mget 顶掉前端逐台 GET /occupation 的 N+1。
    # 只读本页 serial（页码/游标两模式都只要页内这几台）；Redis 挂 → 逐行 None（未知），
    # total/清单不受影响——设备清单是 MySQL 的，「读不到占用」不许拖垮它，也不许画成空闲。
    occ, _read_failed = await _safe_occupation_batch([d.serial for d in page.items])
    # 回收站「删除人」列（§11.4.18）：分页出结果后按页内 updated_by 去重一次 IN 查
    # （case_services._user_names，手法 B）；查不到人留 None，前端画「—」。
    names = await _user_names(ctx.db, {d.updated_by for d in page.items if d.updated_by})
    return Page(items=[_out(d, updated_by_name=names.get(d.updated_by or ""),
                            occupation=_row_occupation(d, occ)) for d in page.items],
                next_cursor=page.next_cursor, total=page.total)


@service(
    perm="adb:device:read", effect="read", name="adb_device_get",
    description="获取单个 ADB 设备",
    http={"method": "GET", "path": "/adb-devices/{device_id}", "tags": ["adb"]},
)
async def adb_device_get(payload: schemas.AdbDeviceGetIn, ctx) -> schemas.AdbDeviceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:read")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    if d.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 设备不存在（在回收站）", 404, {"device_id": d.id})
    return _out(d)


@service(
    perm="adb:device:read", effect="read", name="adb_device_occupation",
    description="读取设备占用快照（谁在占用/几人在排队）——卡片墙「占用/排队」与执行前的空闲判定",
    http={"method": "GET", "path": "/adb-devices/{device_id}/occupation", "tags": ["adb"]},
    resident=False,
)
async def adb_device_occupation(payload: schemas.AdbDeviceOccupationIn, ctx) -> schemas.AdbDeviceOccupationOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:read")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    snap = await occupied(d.serial)
    return schemas.AdbDeviceOccupationOut(device_id=d.id, occupied=snap["holder"] is not None,
                                          holder=snap["holder"] if snap["holder"] is not None else None,
                                          queued=int(snap["queued"]))


@service(
    perm="adb:device:manage", effect="write", name="adb_device_force_release",
    description="强制释放被占用的设备（管理员，D16）：删锁 + 清队；被释放的原持有者此后不再能续期/释放",
    http={"method": "POST", "path": "/adb-devices/{device_id}/force-release", "tags": ["adb"]},
    resident=False,
)
async def adb_device_force_release(payload: schemas.AdbDeviceForceReleaseIn, ctx) -> schemas.AdbDeviceForceReleaseOut:
    await ensure_project_access(ctx, payload.project_id)
    # D159：门禁位与「管理员」承诺对齐——:manage 被 MEMBER 的 -*:manage 拒掉，只剩项目管理员及以上
    ctx.require("adb:device:manage")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    before = await occupied(d.serial)
    released = before["holder"] if before["holder"] is not None else None
    await force_release(d.serial)
    # 审计：service 写入口自动落 audit_log（entry=http，action=adb_device_force_release）
    return schemas.AdbDeviceForceReleaseOut(ok=True, device_id=d.id, released_holder=released)


@service(
    perm="adb:device:update", effect="write", name="adb_device_update",
    description="更新 ADB 设备浅字段（name/enabled/可见性；改 serial/connect_type 用测试连接端点重验）",
    http={"method": "PATCH", "path": "/adb-devices/{device_id}", "tags": ["adb"]},
)
async def adb_device_update(payload: schemas.AdbDeviceUpdateIn, ctx) -> schemas.AdbDeviceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:update")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    if d.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 设备不存在（在回收站，请先恢复）", 404, {"device_id": d.id})
    if payload.name is not None and payload.name != d.name:
        same = (await ctx.db.execute(select(AdbDevice).where(
            AdbDevice.project_id == payload.project_id, AdbDevice.name == payload.name,
            AdbDevice.id != d.id))).scalars().first()
        if same is not None:
            raise ApiError("conflict",
                           ("设备名在回收站占位，请先恢复" if same.status == STATUS_RECYCLED
                            else "设备名已存在"), 409, {"name": payload.name})
        d.name = payload.name
    if payload.serial is not None and payload.serial != d.serial:
        # 改串号 = 改连接对象，必须重验（不本地改，走测试连接端点）
        raise ApiError("validation_failed", "改 serial/connect_type 请用设备的「测试连接」端点完成重验，"
                       "不直接 PATCH——连不上的对象不该静默入库", 422, {"device_id": d.id, "serial": payload.serial})
    if payload.enabled is not None:
        d.enabled = 1 if payload.enabled else 0
    if payload.project_public is not None:
        d.project_public = payload.project_public
    d.updated_by = ctx.user_id
    await ctx.db.commit()
    return _out(d)


@service(
    perm="adb:device:read", effect="read", name="adb_device_test",
    description="测试连接设备：adb connect + getprop 原样回显 + 截一张 screencap 缩略图（bytes→base64）；"
                "不写库，卡片墙「测试连接」按钮",
    http={"method": "POST", "path": "/adb-devices/{device_id}/test", "tags": ["adb"]},
)
async def adb_device_test(payload: schemas.AdbDeviceTestIn, ctx) -> schemas.AdbDeviceTestOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:read")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    if d.status == STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 设备不存在（在回收站）", 404, {"device_id": d.id})
    try:
        model, osver = await _connect_verify(d.serial)
    except ApiError as e:
        return schemas.AdbDeviceTestOut(ok=False, connected=False, message=str(e.message))
    shot = await adb_screencap(d.serial)
    b64 = None
    if shot.ok and shot.out[:4] == b"\x89PNG":
        b64 = base64.b64encode(shot.out).decode("ascii")
    return schemas.AdbDeviceTestOut(ok=True, connected=True,
                                    message="连接成功：" + d.serial,
                                    model=model, os_version=osver,
                                    battery_level=None, screenshot_b64=b64)


@service(
    perm="adb:device:update", effect="write", name="adb_device_reconnect",
    description="重连设备：adb disconnect 后重连，刷新 last_state（§6.4 断开/重连）",
    http={"method": "POST", "path": "/adb-devices/{device_id}/reconnect", "tags": ["adb"]},
    resident=False,
)
async def adb_device_reconnect(payload: schemas.AdbDeviceReconnectIn, ctx) -> schemas.AdbDeviceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:update")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    await adb_disconnect(d.serial)
    model, osver = await _connect_verify(d.serial)
    d.last_state = _state_frame(model=model, os_version=osver, online=True, battery_level=None)
    d.updated_by = ctx.user_id
    await ctx.db.commit()
    return _out(d)


async def _assert_not_locked(d: AdbDevice, ctx) -> None:
    """D167：delete/purge 动数据前的执行锁门。被占 ⇒ 409 in_use（锁只有一个 holder，
    不需要 count）。holder 是 run 身份串，occupation 端点在 adb:device:read 下给它——
    delete 位不隐含 read 位，明细按 read 位隐瞒（D175 purge 引用检测同款尺）。"""
    snap = await occupied(d.serial)
    if snap["holder"] is None:
        return
    may_see = match_perm(ctx.perms, "adb:device:read")
    raise ApiError("in_use", "设备正被执行锁占用，先等执行结束（或在设备卡片强制释放）再删", 409,
                   {"device_id": d.id, "holder": snap["holder"] if may_see else None,
                    "details_hidden": not may_see})


@service(
    perm="adb:device:delete", effect="destructive", name="adb_device_delete",
    description="把 ADB 设备放入回收站（软删；被 adb_case 引用时仍可删——default_device 变 unbound，"
                "执行时 tell；硬拦留在 purge）",
    http={"method": "POST", "path": "/adb-devices/{device_id}/delete", "tags": ["adb"]},
    resident=False,
)
async def adb_device_delete(payload: schemas.AdbDeviceGetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:delete")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    if d.status != "normal":
        raise ApiError("not_found", "ADB 设备不存在", 404, {"device_id": d.id})
    await _assert_not_locked(d, ctx)
    d.status = STATUS_RECYCLED
    d.updated_by = ctx.user_id
    await ctx.db.commit()
    return schemas.OkOut(ok=True)


@service(
    perm="adb:device:update", effect="write", name="adb_device_restore",
    description="从回收站恢复 ADB 设备",
    http={"method": "POST", "path": "/adb-devices/{device_id}/restore", "tags": ["adb"]},
    resident=False,
)
async def adb_device_restore(payload: schemas.AdbDeviceGetIn, ctx) -> schemas.AdbDeviceOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:update")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    if d.status != STATUS_RECYCLED:
        raise ApiError("not_found", "ADB 设备不在回收站", 404, {"device_id": d.id})
    dup = (await ctx.db.execute(select(AdbDevice).where(
        AdbDevice.project_id == payload.project_id, AdbDevice.name == d.name,
        AdbDevice.status == "normal", AdbDevice.id != d.id))).scalars().first()
    if dup is not None:
        raise ApiError("conflict", "回收期间这个名字已被另一台设备占用：先处理它再恢复", 409,
                       {"name": d.name, "name_exists": True})
    d.status = "normal"
    d.updated_by = ctx.user_id
    await ctx.db.commit()
    return _out(d)


@service(
    perm="adb:device:delete", effect="destructive", name="adb_device_purge",
    description="彻底删除回收站中的 ADB 设备（物理删除；被用例 default_device 引用时确认 detach；不可恢复）",
    http={"method": "POST", "path": "/adb-devices/{device_id}/purge", "tags": ["adb"]},
    tool=False, resident=False,
)
async def adb_device_purge(payload: schemas.AdbDevicePurgeIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("adb:device:delete")
    assert ctx.db is not None
    d = await _device(ctx.db, payload.project_id, payload.device_id)
    assert_row_visible(d, ctx, what="ADB 设备不存在")
    if d.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的设备：请先放入回收站", 409,
                       {"device_id": d.id})
    if payload.confirm_name != d.name:
        raise ApiError("name_mismatch", "确认名称与设备名不一致，未删除", 409, {"device_id": d.id})
    # D167：锁检测在 refs 检测之前（物理约束优先——正被执行的设备连 detach 都不该谈）
    await _assert_not_locked(d, ctx)
    refs = (await ctx.db.execute(select(AdbCase).where(
        AdbCase.project_id == payload.project_id, AdbCase.default_device == d.serial)
        .order_by(AdbCase.id))).scalars().all()
    if refs and not payload.detach_referencing:
        # D175：notify_channel_delete / role_delete 同款尺——count 照报（拦不拦由数据决定，
        # 不由权限决定），明细按 adb:case:read 隐瞒：调用方可以只有 adb:device:delete，
        # 别人私有用例的名字不该摊给他。查询本身不加 status/visibility 过滤（与 notify/iam
        # 同形）：refs 同时驱动拦截与 detach 的物理清引用，回收站里的引用也算数、也清得掉。
        may_see = match_perm(ctx.perms, "adb:case:read")
        items = [{"id": c.id, "name": c.name} for c in refs[:REF_DETAIL_CAP]]
        msg = ("有 " + str(len(refs)) + " 条 ADB 用例把该设备设为 default_device："
               "勾选「释放引用」才能删除（或先改那些用例）")
        if not may_see:
            # api_test/case_services.py:119 同款人话：隐瞒本身可见、出口可操作
            msg += "；用例明细需要 adb:case:read 权限，请联系有该权限的成员先解绑"
        # details_hidden 与 details_truncated 分开（notify/service.py:164 口径）：
        # count 报 25、明细给 20 条时，不告知截断前端会把 20 条当全量。
        raise ApiError("in_use", msg, 409,
                       {"device_id": d.id, "count": len(refs),
                        "referring_cases": items if may_see else [],
                        "details_hidden": not may_see,
                        "details_truncated": len(refs) > len(items)})
    for c in refs:
        c.default_device = None
    await ctx.db.delete(d)
    await ctx.db.commit()
    return schemas.OkOut(ok=True)
