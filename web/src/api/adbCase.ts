// ADB 用例面（§7.3 / §11.4.12 / §11.5.5，1D T7 端点的 T9 前端接线）：
// CRUD + 回收站三件套 + 场景引用 + 调试（同步）+ 执行（enqueue）。
//
// 类型是**手写镜像**（与 ui.ts 的 UiDebugResult 同口径，R129「混合类型」）：
// T7 的后端路由已提交，但本窗口不重跑 gen:api（要自起后端，与并行后端批次同树不动），
// 字段逐字对齐 backend/app/modules/adb_test/schemas.py 的 AdbCaseOut 与
// debug_services.py 的 AdbDebugOut/AdbRunEnqueueOut。后端字段一变，下次 gen:api 后
// 这里与生成物的差异会撞眼，不静默漂移。
//
// 两条只有读后端才看得见的语义（界面必须兑现）：
// ① debug 入参只有 {project_id, case_id}——没有 graph 字段（与 UiCaseDebugIn 同形），
//    跑的是库里已保存的序列；「调试必选空闲设备，占用 422 device_occupied 绝不排队」
//    是端点硬规矩（D17），占用/离线以 422 原话回显。
// ② run 是 enqueue：broker 不可达 503 不留孤儿；指定设备忙则 FIFO 排队，
//    位次走 device_queued 事件（界面只许出现真实位次，不许出现时长估算）。
import { get, patch, post } from "./client";
import type { Page } from "./api";

/** AdbCaseOut（schemas.py 的 AdbCaseOut）：steps 是 §7.3 JSON 数组，issues 是 live 校验问题。 */
export interface AdbCaseOut {
  id: string;
  project_id: string;
  module_id: string | null;
  name: string;
  priority: string;
  enabled: boolean;
  steps: Record<string, unknown>[];
  /** 设备 serial（指定设备）；null =「任一空闲」（§4.5，存期不校验存在性）。 */
  default_device: string | null;
  owner_id: string | null;
  project_public: boolean;
  status: string;
  step_count: number;
  last_run_at: string | null;
  last_run_status: string | null;
  updated_by: string | null;
  /** §11.4.18 回收站「删除人」：后端把 updated_by 解析成 app_user.name（列表出参才填，
   *  查不到人 = null → 画「—」，绝不拿 id 冒充人名）。 */
  updated_by_name?: string | null;
  created_at: string | null;
  updated_at: string | null;
  issues: Record<string, unknown>[];
}

export interface AdbCaseCreateIn {
  project_id: string;
  name: string;
  module_id?: string | null;
  priority?: string;
  enabled?: boolean;
  steps?: Record<string, unknown>[] | null;
  default_device?: string | null;
  project_public?: boolean;
}

/** PATCH 语义：None=不改，清空 steps / default_device 靠显式声明位（同 ui_case_update）。 */
export interface AdbCaseUpdateBody {
  project_id: string;
  name?: string | null;
  priority?: string | null;
  enabled?: boolean | null;
  steps?: Record<string, unknown>[] | null;
  steps_set?: boolean;
  module_id?: string | null;
  module_set?: boolean;
  default_device?: string | null;
  default_device_set?: boolean;
  project_public?: boolean | null;
}

/** AdbCaseReferencesOut（用例详情「场景引用」的数据源）。 */
export interface AdbCaseReferencesOut {
  items: { scenario_id: string; scenario_name: string; step_keys: string[] }[];
  details_hidden: boolean;
}

/** AdbDebugOut.artifacts 的行与 UiArtifactRef 同形（{kind,step_key,ref,bytes,reason}），
 *  ui/debugRows 的 shotsByStep/cmdRows/assertionRows 直接复用（R108/R107 三件套）。 */
export interface AdbArtifactRef {
  kind: string; // SCREENSHOT / VIDEO / LOG
  step_key: string;
  ref: string;
  bytes: number;
  reason?: string | null;
}

/** AdbDebugOut：mode/device 是 ADB 侧多出来的两键——降级不可见 = 纪律 1 违例（T6 交接）。 */
export interface AdbDebugResult {
  run_id: string;
  status: string; // passed/failed/error/cancelled
  ok: boolean;
  passed: boolean;
  elapsed_ms: number;
  error: string | null;
  /** u2 | dump | null（没连上）——调试面板必须当场说出这案走的是哪条线。 */
  mode: string | null;
  /** 真跑在哪台设备的 serial 上。 */
  device: string | null;
  vars: Record<string, string>;
  commands: Record<string, unknown>[];
  artifacts: AdbArtifactRef[];
}

/** AdbRunEnqueueOut：投 worker 立即返回，进度在运行记录/事件流里看。 */
export interface AdbRunEnqueueOut {
  run_id: string;
  status: string; // queued
}

const enc = encodeURIComponent;

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

export interface AdbCaseListInput {
  project_id: string;
  module_id?: string;
  unfiled_only?: boolean;
  recycled?: boolean;
  cursor?: string;
  size?: number;
  /** D47-b 步5a：后端已有 current（页码分页）；手写镜像先补上——本文件头的约定如此
   *  （schema.d.ts 尚未重画：gen:api 会自起后端抢 8321，生成物重画是收尾单独一次，
   *  那一刀把整份 OpenAPI 的漂移一起看过）。 */
  current?: number;
  /** D217：高级搜索条件组（JSON 串），与 module/unfiled/recycled 并行 AND。 */
  filter?: string;
}

export const adbCaseApi = {
  /** 用例列表（recycled=true 只看回收站；最近结果读冗余列，不 N+1 查 run_record）。 */
  listCases: (q: AdbCaseListInput) =>
    get<Page<AdbCaseOut>>("/adb-cases?" + qs({ ...q }), { silent: true }),

  /** 用例详情（含 live issues：打开老用例就看得见校验问题，不必等保存 422）。 */
  getCase: (projectId: string, caseId: string) =>
    get<AdbCaseOut>("/adb-cases/" + enc(caseId) + "?project_id=" + enc(projectId)),

  /** 新建（steps 过 §7.3 协议门，不过 → 422 details.issues；同项目重名 409）。 */
  createCase: (body: AdbCaseCreateIn) => post<AdbCaseOut>("/adb-cases", body),

  /** 改用例（steps 不传=不改，清空靠 steps_set=true 声明位）。 */
  updateCase: (caseId: string, body: AdbCaseUpdateBody) =>
    patch<AdbCaseOut>("/adb-cases/" + enc(caseId), body),

  /** 放入回收站（软删；当前后端对场景引用不硬拦——保护通道归 T8 后端半边）。 */
  removeCase: (projectId: string, caseId: string) =>
    post<{ ok: boolean }>("/adb-cases/" + enc(caseId) + "/delete", { project_id: projectId }),

  /** 从回收站恢复（回收期间名字被占 → 409，不静默改名）。 */
  restoreCase: (projectId: string, caseId: string) =>
    post<AdbCaseOut>("/adb-cases/" + enc(caseId) + "/restore", { project_id: projectId }),

  /** 彻底删除（confirm_name 逐字相等，物理删除不可恢复）。 */
  purgeCase: (projectId: string, caseId: string, confirmName: string) =>
    post<{ ok: boolean }>("/adb-cases/" + enc(caseId) + "/purge",
      { project_id: projectId, confirm_name: confirmName }),

  /** 场景引用（含命中步骤 key；无 scenario:read 时数量照报、明细隐瞒）。 */
  references: (projectId: string, caseId: string) =>
    get<AdbCaseReferencesOut>("/adb-case-references?project_id=" + enc(projectId)
      + "&case_id=" + enc(caseId)),

  /**
   * 调试（trigger=debug，进程内真跑、不落报告中心、不回写「最近结果」）。
   * 必选空闲设备：占用 422 device_occupied 绝不排队（D17——人在等一句答复）。
   */
  debugCase: (projectId: string, caseId: string) =>
    post<AdbDebugResult>("/adb-cases/" + enc(caseId) + "/debug", { project_id: projectId }),

  /** 执行（投 worker，trigger=manual）：返回 queued 的 run_id；设备忙 FIFO 排队。 */
  runCase: (projectId: string, caseId: string) =>
    post<AdbRunEnqueueOut>("/adb-cases/" + enc(caseId) + "/run", { project_id: projectId }),
};
