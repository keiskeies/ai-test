"""adb_test schemas（§4.5 / §11.4.14 / §11.5.4 扩展三件 + 第四棵模块树 + 设备测试即拍）。

一条贯穿本模块的口径与 ui_test 同源：**`used_by`/`occupation` 是安全数字，不是浏览清单**。
设备卡片的「占用」徽标与列表的「关联用例数」必须与删除拦截同一次扫描——徽标说 0 而删除
弹 409 是界面能造成的最坏误导（ui_test/schemas.py:3-8 为同一道判断题写过注释）。
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.modules.adb_test.models import CONNECT_TYPES

# 词表唯一来源是 models.CONNECT_TYPES（D14 的 wifi/usb 两值）。join 生成 pattern，
# 加类型只改模型文件一处。
_CONNECT_PATTERN = "^(" + "|".join(CONNECT_TYPES) + ")$"
# §4.5 serial：WiFi 是 host:port，USB 是设备串号（一期 422 拒绝写），校验宽松放行
# ip:port / 串号两种形态。交给 D14 的服务层把关。
PRESET_STATUS_RECYCLED = "recycled"


def iso(dt: datetime | None) -> str | None:
    """datetime → 带时区偏移的 ISO；None 透传（ui_test/schemas.iso 同款）。"""
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class OkOut(BaseModel):
    ok: bool = True


# ══════════════════════════════════ 设备（§4.5 / §11.4.14 卡片墙）══════════════════════════════════
class AdbDeviceCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    serial: str = Field(min_length=1, max_length=64)  # 192.168.1.50:5555 / USB 串号
    connect_type: str = Field(default="wifi", pattern=_CONNECT_PATTERN)
    wifi_addr: str | None = Field(default=None, max_length=64)
    enabled: bool = True
    project_public: bool = True


class AdbDeviceUpdateIn(BaseModel):
    """PATCH 语义：None = 不改。connect_type/wifi 修改走「测试连接再保存」的独立验证端点。"""

    project_id: str
    device_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    serial: str | None = Field(default=None, min_length=1, max_length=64)
    # connect_type 改值要重新验证可连；UI 走「测试连接」端点批量改，这里只允许 name/enabled 等浅字段
    enabled: bool | None = None
    project_public: bool | None = None


class AdbDeviceGetIn(BaseModel):
    project_id: str
    device_id: str


# —— 设备锁占用（§6.4/§8.7 + T5）：卡片墙「占用/排队」与强制释放 ——
class AdbDeviceOccupationIn(BaseModel):
    """读取设备占用快照：{holder, queued}。只读路径，不触碰锁本身。"""

    project_id: str
    device_id: str


class AdbDeviceOccupationOut(BaseModel):
    device_id: str
    occupied: bool  # 当前是否有持有者（卡片「占用」蓝色态）
    holder: str | None  # 持有者 token（run:{run_id}:{attempt}…，卡片解析 run 名）
    queued: int  # 排队人数（D17：真实位次，非估算）


class AdbDeviceRowOccupation(BaseModel):
    """列表行上的占用读数（D47-b 步 5e）：字段口径与 AdbDeviceOccupationOut 的三件一致
    （occupied/holder/queued，单条端点继续用它，详情页与执行前判空还依赖那个形状）。

    **行上的 null 与 occupied=false 是两回事**（§13 纪律 1：读不到 ≠ 空闲）：
    AdbDeviceOut.occupation=None 说「这次没读到」（Redis 故障，整页同缺），卡片不许据此画
    空闲；occupied=False + holder=None 说「读到了，真空闲」。前端拿 None 画「读数缺失」。
    """

    occupied: bool  # 当前是否有持有者（与单条端点同尺：holder is not None）
    holder: str | None  # 持有者 token（run:{run_id}:{attempt}…，卡片解析 run 名）
    queued: int  # 排队人数（D17：真实数字，非估算；只有持锁的行才会去读队列键）


class AdbDeviceForceReleaseIn(BaseModel):
    """管理员强制释放（D16：adb:device:update 即钥匙）：删锁 + 清队 + 审计。"""

    project_id: str
    device_id: str


class AdbDeviceForceReleaseOut(BaseModel):
    ok: bool = True
    device_id: str
    released_holder: str | None  # 强制释放前占用它的持有者（供审计/回显）


class AdbDeviceListIn(BaseModel):
    project_id: str
    recycled: bool = False
    cursor: str | None = None
    # state（D47-b 步 5e）：卡片墙三档筛选下推（业主裁定 5·4「三个筛选项都兑现、total 说真话」）。
    # 判据 = 前端唯一真值 adbDevices.tsx cardStateOf（:58-62）：**离线压倒占用**，在线判据
    # last_state?.online !== true（严格不等）。三档谓词逐字对齐（§五·实测前提 1/3 + 并行评审补刀）：
    # - offline  = (json_extract(last_state,'$.online') = true) IS NOT TRUE —— 纯 SQL 下推。
    #   必须 IS NOT TRUE 而不是 = false：NULL 列/空对象/缺 online 键对 = true 交出 SQL NULL，
    #   直接取反会把这批行整批漏掉（七行真值表现跑过）；数字 1 也不算在线（与前端严格 !== 同尺）。
    # - occupied = **在线** 且 锁持有；idle = **在线** 且 锁未持有。
    #   「先 AND 在线」不是修饰：锁键对离线设备照样占位（adb_lock 模块 docstring），若 occupied
    #   只查锁，一台界面上写着「离线」的掉线设备会被选进「占用」——筛选与卡片各说一套。
    #   后两档的锁读数不在 MySQL（occupied/idle 不可能是 SQL 谓词），走两阶段：在线全集 →
    #   occupation_batch 批量读锁 → Python 筛 → 切页 + 数 total（超 _STATE_SCAN_CAP 大声报错，
    #   绝不「只数这一页」冒充「共 N 台」）。offline 对 cursor 模式也可用（纯 SQL 谓词，
    #   游标语义不被破坏）；occupied/idle 与 cursor 互斥（400，见 handler 注释）。
    state: Literal["offline", "occupied", "idle"] | None = None
    # D224：高级搜索条件组（JSON 串，形状见 shared/filter_registry）。None / 空串 = 没筛选。
    # 与上面两条轴（state 三档 / recycled 视图）并行 AND；白名单不含它们，理由见登记处。
    filter: str | None = None
    # current（D47-b 步 5e）：页码分页入口，MS {current, pageSize, total} 口径（姊妹刀 5a/5c 同款）。
    # None = 键集/游标路径；与 cursor 互斥，两者同时到场在 handler 里大声 400。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)


class AdbDevicePurgeIn(BaseModel):
    project_id: str
    device_id: str
    confirm_name: str = Field(min_length=1, max_length=200)
    # 设备被 adb_case.default_device 引用时，purge 必须确认「释放引用」
    detach_referencing: bool = False


class AdbDeviceOut(BaseModel):
    id: str
    project_id: str
    name: str
    serial: str
    connect_type: str = "wifi"
    wifi_addr: str | None = None
    enabled: bool = True
    last_state: dict[str, Any] | None = None  # {model, os, battery_level, online, last_check_at}
    owner_id: str | None = None
    project_public: bool = True
    status: str = "normal"
    updated_by: str | None = None
    # §11.4.18 回收站「删除人」列：列表出参把 updated_by 解析成 app_user.name（各 service
    # 文件自带表名 join，契约 1 不 import iam）。查不到人留 None → 前端画「—」，绝不拿
    # id 冒充人名；单条出参不跑这次解析（None = 没查过，消费方回收站只读列表）。
    updated_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    # §11.4.14 卡片墙「占用墙」的字段：当前锁状态（T5 填），这里先给出字段形状
    occupied_by: str | None = None  # 当前持有锁的 run_id / 排队者 id；T5 实现
    # D47-b 步 5e：列表行自带占用读数（一次 mget 批量读锁，顶掉前端逐台 GET /occupation 的
    # N+1；单条端点没删，详情页/执行前判空仍在用）。语义三态要分清：
    # dict = 读到（occupied 字段给真相）；None = 没读到（Redis 故障，整页缺失）——
    # 「没读到」绝不塌缩成 occupied:false 的空闲态（说谎页脚同款纪律）。
    occupation: AdbDeviceRowOccupation | None = None


# —— 测试即拍（§11.4.14：读设备信息 + 截屏缩略图）——
class AdbDeviceTestIn(BaseModel):
    project_id: str
    device_id: str


class AdbDeviceTestOut(BaseModel):
    ok: bool
    connected: bool  # adb connect 是否成功
    message: str  # 人话回显（getprop 细节或排错提示）
    model: str | None = None
    os_version: str | None = None
    battery_level: int | None = None
    screenshot_b64: str | None = None  # 截图缩略（exec-out screencap bytes → base64）


# —— 重连 / 断开（§6.4）——
class AdbDeviceReconnectIn(BaseModel):
    project_id: str
    device_id: str


# ── 设备引用查询（T7 删除保护内部件；不暴露 HTTP，照 scenario_case_refs）──
class AdbDeviceRefsIn(BaseModel):
    project_id: str
    device_ids: list[str] = Field(default_factory=list)


class AdbCaseRefItem(BaseModel):
    case_id: str
    case_name: str
    default_device: str | None = None
    sort: str = Field(default="P2", exclude=True)


class AdbDeviceRefGroup(BaseModel):
    device_id: str
    count: int = 0
    items: list[AdbCaseRefItem] = Field(default_factory=list)


class AdbDeviceRefsOut(BaseModel):
    groups: list[AdbDeviceRefGroup] = Field(default_factory=list)
    details_hidden: bool = False


# ══════════════════════════════════ 模块树（第四棵树，§4.5 同 api_module）══════════════════════════════════
class AdbModuleNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int = 0
    status: str = "normal"
    # 树服务的资产 = ADB 用例；徽标 count = 直属未回收用例数（无第二资产，element_count 类不加）
    count: int = 0
    children: list[AdbModuleNode] = []


class AdbModuleTreeIn(BaseModel):
    project_id: str
    include_recycled: bool = False


class AdbModuleTreeOut(BaseModel):
    tree: list[AdbModuleNode] = []
    recycled: list[AdbModuleNode] = []


class AdbModuleCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class AdbModuleUpdateIn(BaseModel):
    project_id: str
    module_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None  # 显式传入（含 null）即移动；缺省=不动父级


class AdbModuleDeleteIn(BaseModel):
    project_id: str
    module_id: str


class AdbModulePurgeIn(BaseModel):
    project_id: str
    module_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class AdbModulePurgeOut(BaseModel):
    ok: bool = True
    purged_modules: int = 0
    detached_cases: int = 0


# ══════════════════════════════════ ADB 用例（§7.3 / §11.4.12 / §11.5.5）══════════════════════════════════
# 无 env_id / env_set（§4.5 没列，T2 已钉）；无 version（R104 同 ApiCase/UiCase）。
class AdbCaseCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    module_id: str | None = None
    priority: str = Field(default="P2", pattern="^(P0|P1|P2|P3)$")
    enabled: bool = True
    # 默认 None 而不是 []（UiCaseCreateIn 同款）：「忘了传」与「真存了空序列」是两句话，
    # 空步骤由协议门的 empty_steps 说。
    steps: list[dict[str, Any]] | None = None
    # §4.5 default_device：设备 serial（指定设备）或 None=「任一空闲」。**存期不校验存在性**
    # （与 ui 的 env 同口径：跑的时候才解析——先存草稿、设备还没登记是正常顺序）。
    default_device: str | None = Field(default=None, max_length=64)
    project_public: bool = True


class AdbCaseUpdateIn(BaseModel):
    project_id: str
    case_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    priority: str | None = Field(default=None, pattern="^(P0|P1|P2|P3)$")
    enabled: bool | None = None
    steps: list[dict[str, Any]] | None = None
    # PATCH 里 None 已是「不改」，清空步骤序列靠显式声明位（UiCaseUpdateIn 同法）
    steps_set: bool = False
    module_id: str | None = None
    module_set: bool = False
    default_device: str | None = None
    default_device_set: bool = False
    project_public: bool | None = None


class AdbCaseGetIn(BaseModel):
    project_id: str
    case_id: str


class AdbCaseDeleteIn(BaseModel):
    """回收用例。force 与 api_case_delete 同款：给「已经看见引用清单、确认要连带断掉
    场景步骤」的人用的第二段——第一段不带 force 只会 409 并把引用者列出来。"""

    project_id: str
    case_id: str
    force: bool = False


class AdbCaseListIn(BaseModel):
    project_id: str
    module_id: str | None = None
    unfiled_only: bool = False
    recycled: bool = False
    # D217：高级搜索条件组（JSON 串，形状见 shared/filters.py）。与 module/unfiled/recycled
    # 并行 AND；空串=没筛选，坏条件 400 且带本页可筛清单。
    filter: str | None = None
    cursor: str | None = None
    # current（D47-b 步 5a）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径（形状逐字节不变）；与 cursor 互斥，两者同时到场在 handler 里 400。
    # 前提天然满足：这两页的筛选（project/module/unfiled/recycled）本来就全在 SQL WHERE 里，
    # 没有本地过滤要下推，total 与 items 吃同一份条件（步 4b 对接口页的前置要求在这里免费成立）。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)


class AdbCasePurgeIn(BaseModel):
    project_id: str
    case_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class AdbCaseBatchDeleteIn(BaseModel):
    """批量回收（D273，对齐 api_case_batch_delete）：全有或全无，不提供批量 force。"""

    project_id: str
    case_ids: list[str] = Field(min_length=1, max_length=200)


class AdbCaseBatchRestoreIn(BaseModel):
    """批量恢复（D273）：全有或全无；任一名被占 → 409 整批不动（单条 restore 同口径）。"""

    project_id: str
    case_ids: list[str] = Field(min_length=1, max_length=200)


class AdbCaseOut(BaseModel):
    id: str
    project_id: str
    module_id: str | None = None
    name: str
    priority: str = "P2"
    enabled: bool = True
    steps: list[dict[str, Any]] = Field(default_factory=list)
    default_device: str | None = None
    owner_id: str | None = None
    project_public: bool = True
    status: str = "normal"
    step_count: int = 0
    last_run_at: str | None = None
    last_run_status: str | None = None
    updated_by: str | None = None
    # §11.4.18 回收站「删除人」列：语义与解析口径同 AdbDeviceOut.updated_by_name。
    updated_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    # 打开老用例就看见问题，不必等保存 422（scenario_get / ui_case_get 的 live issues 同手感）
    issues: list[dict[str, Any]] = Field(default_factory=list)


class AdbCaseReferencesIn(BaseModel):
    """HTTP 面单条查询（用例详情「场景引用」Tab）。刻意不是 list：GET 摊 query 参数，
    required list 会变成「路由存在但永远 422 body required」（ui 的同款实测，见其注释）。"""

    project_id: str
    case_id: str


class AdbScenarioRefItem(BaseModel):
    scenario_id: str
    scenario_name: str
    step_keys: list[str] = Field(default_factory=list)
    sort: str = Field(default="P2", exclude=True)


class AdbCaseReferencesOut(BaseModel):
    items: list[AdbScenarioRefItem] = Field(default_factory=list)
    details_hidden: bool = False


class AdbCaseRefsIn(BaseModel):
    project_id: str
    case_ids: list[str] = Field(default_factory=list)


class AdbCaseRefGroup(BaseModel):
    case_id: str
    count: int = 0
    items: list[AdbScenarioRefItem] = Field(default_factory=list)


class AdbCaseRefsOut(BaseModel):
    groups: list[AdbCaseRefGroup] = Field(default_factory=list)
    details_hidden: bool = False
