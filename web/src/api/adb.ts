// ADB 设备面（§11.4.14 / 1D T4+T5）：设备 CRUD + 先 connect 验证再入库 + 测试即拍 + 占用/强制释放。
// 手写镜像后端 @service 路由（与 ui.ts 同法：生成物 schema.d.ts 的 GET 响应是 unknown——
// 后端返回标注 BaseModel 不进 OpenAPI；入参类型引生成物，后端字段一变 gen:api 后这里先编译报错）。
// 一条只有读代码才会发现的形状差异：/test 是 POST，但权限是 adb:device:read（读类动作，
// 不落库）——按钮显隐按 read 位判，不按「POST 即写」猜（device_services.py 的 READONLY glob 注释）。
import { get, patch, post } from "./client";
import type { components, operations } from "./schema";
import type { Page } from "./api";

type AdbDeviceOutRaw = components["schemas"]["AdbDeviceOut"];
/**
 * 行上的占用读数（D47-b 步 5e 前端半边）——**已知漂移的显式补键**：生成物 schema.d.ts 里
 * 还没有 AdbDeviceRowOccupation（gen:api 会自起后端抢 :8321 的业主 demo 服务，本刀禁跑），
 * 字段名与后端 app/modules/adb_test/schemas.py 的 AdbDeviceRowOccupation 逐字一致
 * （occupied / holder / queued），收尾整份重画 OpenAPI 时统一还（先例：ui.ts 的
 * ElementListInput / UiElementListRow 同款补键与同款债）。
 * 三态语义与后端同尺：**对象 = 读到了（occupied 说真相）；null/缺键 = 没读到**——
 * 「没读到」绝不塌缩成 occupied:false 的空闲（后端 schemas.py:82-84 的 §13 纪律 1）。
 */
export type AdbDeviceRowOccupation = { occupied: boolean; holder: string | null; queued: number };
/**
 * 手写镜像叠加（本文件口径）：后端 schemas.py 的 AdbDeviceOut 已加 `updated_by_name`
 * （§11.4.18 回收站「删除人」，列表出参才填）与 `occupation`（D47-b 步 5e，一次 mget
 * 批量读锁随行给出，顶掉前端逐台 GET /occupation 的 N+1），但本窗口不重跑 gen:api
 * （要自起后端），生成物还没这两个字段 → 这里本地叠加可选字段，页面只从本文件引这个
 * 合并类型；下次 gen:api 后生成物自然包含，这两行叠加收敛为无害。
 */
export type AdbDeviceOut = AdbDeviceOutRaw & {
  /** 后端解析出的操作者人名；null = 没解析/查不到人（前端画「—」，不许回填 id）。 */
  updated_by_name?: string | null;
  /** 占用读数；null/缺键 = 这次没读到（Redis 故障时整页同缺），画「读数缺失」。 */
  occupation?: AdbDeviceRowOccupation | null;
};
type AdbDeviceCreateIn = components["schemas"]["AdbDeviceCreateIn"];
type AdbDeviceOccupationOut = components["schemas"]["AdbDeviceOccupationOut"];
type AdbDeviceTestOut = components["schemas"]["AdbDeviceTestOut"];
type AdbDeviceForceReleaseOut = components["schemas"]["AdbDeviceForceReleaseOut"];
// 带路径参数的 POST/PATCH 的 body 在 OpenAPI 里是匿名 *_body 模型（照 ui.ts/scene.ts 的口径）
type AdbDeviceUpdateBody = components["schemas"]["adb_device_update_body"];
type AdbDeviceTestBody = components["schemas"]["adb_device_test_body"];
type AdbDeviceReconnectBody = components["schemas"]["adb_device_reconnect_body"];
type AdbDeviceDeleteBody = components["schemas"]["adb_device_delete_body"];
type AdbDeviceRestoreBody = components["schemas"]["adb_device_restore_body"];
type AdbDevicePurgeBody = components["schemas"]["adb_device_purge_body"];
type AdbDeviceForceReleaseBody = components["schemas"]["adb_device_force_release_body"];
type OkOut = components["schemas"]["OkOut"];

type DeviceListQuery = operations["get_adb_device_list_api_v1_adb_devices_get"]["parameters"]["query"];

const enc = encodeURIComponent;

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

// D47-b 步5e：后端 26f4dde 已收 current（页码，与 cursor 互斥，同传 400）与 state
// （offline/occupied/idle 三档筛选下推；state=occupied/idle 与 cursor 互斥、Redis 故障整请求
// 503，state=offline 纯 SQL 腿可与 cursor 并用）——schema.d.ts 里**还没有**这两个参数，
// gen:api 会自起后端抢 :8321（业主 demo 在那），本刀禁跑。这是**已知漂移的显式补键**，
// 字段名与后端 app/modules/adb_test/schemas.py 的 AdbDeviceListIn 逐字一致
// （current / state，state 词表与后端 Literal["offline","occupied","idle"] 逐字对齐），
// 收尾整份重画 OpenAPI 时统一还（先例：ui.ts 的 ElementListInput / CaseListInput 同款补键）。
export type DeviceListInput = Pick<DeviceListQuery, "project_id"> & Partial<Omit<DeviceListQuery, "project_id">>
  // D224：filter 同为已知漂移的显式补键（schema.d.ts 尚未重画），字段名与后端
  // AdbDeviceListIn.filter 逐字一致：高级搜索条件组的 JSON 串。
  & { current?: number; state?: "offline" | "occupied" | "idle"; filter?: string };

/** 409 in_use（purge 被引用硬拦，device_services.py:339-344）：details.referring_cases
 * 就是用例清单——界面必须点名是哪几条，不许只报一句「被占用」。 */
export interface AdbDevicePurgeDetails {
  device_id: string;
  referring_cases: { id: string; name: string }[];
}

export const adbApi = {
  /** 设备列表（recycled=true 只看回收站；last_state 是最新心跳帧 {model,os,online,battery_level,last_check_at}）。 */
  listDevices: (q: DeviceListInput) =>
    get<Page<AdbDeviceOut>>("/adb-devices?" + qs(q), { silent: true }),

  /** 设备详情（回收站中的设备 404）。 */
  getDevice: (projectId: string, deviceId: string) =>
    get<AdbDeviceOut>("/adb-devices/" + enc(deviceId) + "?project_id=" + enc(projectId)),

  /**
   * 创建设备：**先 adb connect + getprop 验证，连不上 422 connect_failed 且 adb 的
   * stderr/stdout 原样回显**（§4.5 原话兑现——排错提示不是翻译腔，是真 adb 输出）；
   * 成功才 201 且落 last_state 首帧。USB 写入口 422 拒绝（D14，静默改写成 wifi 是假数据）。
   */
  createDevice: (body: AdbDeviceCreateIn) => post<AdbDeviceOut>("/adb-devices", body),

  /** 改浅字段（name/enabled/可见性）；改 serial 会被 422 拒——重验走「测试连接」，不许静默入库。 */
  updateDevice: (deviceId: string, body: AdbDeviceUpdateBody) =>
    patch<AdbDeviceOut>("/adb-devices/" + enc(deviceId), body),

  /**
   * 占用快照（卡片墙「占用/排队 #n」的数据源，D17：queued 是真实排队人数，
   * 界面上不许出现任何「预计 x 分钟」的估算——编数字就是假数据）。
   */
  occupation: (projectId: string, deviceId: string) =>
    get<AdbDeviceOccupationOut>(
      "/adb-devices/" + enc(deviceId) + "/occupation?project_id=" + enc(projectId), { silent: true }),

  /**
   * 测试连接（POST 但权限 adb:device:read——只读不写库）：连接成功回 model/os +
   * base64 PNG 截图；失败**不抛**，ok=false + message 里带 adb 原样输出（回显给操作员）。
   */
  testDevice: (projectId: string, deviceId: string) =>
    post<AdbDeviceTestOut>("/adb-devices/" + enc(deviceId) + "/test",
      { project_id: projectId } satisfies AdbDeviceTestBody, { silent: true }),

  /** 重连（adb disconnect 后重验并刷新 last_state 首帧）；连不上是 422 带 adb 原话。 */
  reconnectDevice: (projectId: string, deviceId: string) =>
    post<AdbDeviceOut>("/adb-devices/" + enc(deviceId) + "/reconnect",
      { project_id: projectId } satisfies AdbDeviceReconnectBody),

  /** 软删进回收站（被 adb_case.default_device 引用也可删——引用变 unbound，硬拦在 purge）。 */
  removeDevice: (projectId: string, deviceId: string) =>
    post<OkOut>("/adb-devices/" + enc(deviceId) + "/delete",
      { project_id: projectId } satisfies AdbDeviceDeleteBody),

  /** 从回收站恢复（回收期间重名被占 → 409，不静默改名）。 */
  restoreDevice: (projectId: string, deviceId: string) =>
    post<AdbDeviceOut>("/adb-devices/" + enc(deviceId) + "/restore",
      { project_id: projectId } satisfies AdbDeviceRestoreBody),

  /**
   * 彻底删除（confirm_name 逐字相等）；被用例 default_device 引用时 409 in_use +
   * details.referring_cases 点名是哪几条，勾选 detach（detach_referencing=true）才放行并清空引用。
   */
  purgeDevice: (projectId: string, deviceId: string, confirmName: string, detachReferencing = false) =>
    post<OkOut>("/adb-devices/" + enc(deviceId) + "/purge",
      { project_id: projectId, confirm_name: confirmName, detach_referencing: detachReferencing } satisfies AdbDevicePurgeBody),

  /** 强制释放（D16 管理员逃生门，钥匙 = adb:device:update）：删锁 + 清队 + 审计落库。 */
  forceRelease: (projectId: string, deviceId: string) =>
    post<AdbDeviceForceReleaseOut>("/adb-devices/" + enc(deviceId) + "/force-release",
      { project_id: projectId } satisfies AdbDeviceForceReleaseBody),
};
