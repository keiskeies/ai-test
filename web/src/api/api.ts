// 后端出参的前端镜像（api_test / env / execution 三模块的读模型）。
import type { RequestObject } from "./req";

export interface ApiDef {
  id: string;
  project_id: string;
  module_id: string | null;
  name: string;
  method: string;
  path: string;
  request: RequestObject | null;
  status: string;           // draft | complete | recycled
  version: number;
  owner_id: string | null;
  /** 蓝图 :1376 列表列「负责人」：后端 join app_user 回填的人名（前端拉成员表换名字
   *  在权限上就是错的——GET /members 要 ensure_member）。owner_id 有人但这里为 null
   *  = 账号已删/查不到，前端照实说，不许画空名字。 */
  owner_name?: string | null;
  project_public: boolean;
  /** D282：接口说明（自由文本，空 = 没写）。 */
  description?: string | null;
  /** D282：标签列表（后端把逗号串 split 成数组；空数组 = 无标签）。 */
  tags?: string[];
  /** 蓝图 :1376 列表列「更新时间」：后端 ApiDefOut.updated_at（带 +00:00 偏移的 ISO）。 */
  updated_at?: string | null;
  /** D276 列表列「创建时间」：后端 ApiDefOut.created_at（同上 ISO 口径）。 */
  created_at?: string | null;
}

/** D276：接口列表的用例规模批量投影（后端 ApiDefCaseSummaryOut 手写镜像）。
 *  result 是聚合态：none/running/failed/partial/passed，判据见后端服务注释。 */
export interface ApiDefCaseSummary {
  definition_id: string;
  case_count: number;
  executed: number;
  passed: number;
  failed: number;
  running: number;
  case_pass_rate: number;
  result: string;
}

export interface CaseRow {
  id: string;
  project_id: string;
  definition_id: string;
  name: string;
  priority: string;
  request: Record<string, unknown> | null;   // 覆盖层
  assertions: Record<string, unknown>[];
  dataset_id: string | null;
  sort: number;
  status: string;
  effective_request: RequestObject | null;
}

export interface DatasetRow {
  id: string;
  project_id: string;
  name: string;
  columns: string[];
  rows: string[][];
  row_count: number;
  used_by?: number;      // 被几条未回收用例引用（删除前就得看见）
  // 绑定它的用例（含回收站里的）是否还被未回收场景扣着 → 删除必 409。
  // 不能并进 used_by：徽标说 0 而删除 409，是 1B 删除保护加到回收站用例之后
  // 必然出现的缺口，后端与这里共用同一判据（RF9）。
  scenario_held?: boolean;
}


export interface EnvRow {
  id: string;
  project_id: string;
  name: string;
  position: number;
  config: Record<string, unknown> | null;
}

export interface RunRow {
  id: string;
  subject_type: string;
  subject_id: string;
  // D141：后端 RunOut.subject_name 收紧成 str（列 NOT NULL 快照，execution/models.py:22），
  // 旧声明 string | null 逼出的两句「…已删除」假兜底不可达且语义为假，已删（D141）。
  subject_name: string;
  env_name: string | null;
  trigger: string;
  status: string;
  status_code: number | null;
  elapsed_ms: number | null;
  error: string | null;
  created_at: string | null;
  created_by_name: string | null;
}

/** D47-b：页码分页端点（入参带 current）的响应多一个 total；游标端点的响应里**压根没有这个键**
 *  （不是显式 null）。消费方一律判 `== null`：null / undefined / 缺键都是「这接口不报总数」。 */
export interface Page<T> { items: T[]; next_cursor: string | null; total?: number | null }

// —— iam / audit 读模型（设置页）——
export interface MemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role_code: string;
  account: string | null;
  name: string | null;
}

export interface RoleRow { code: string; name: string; perms?: string[] }

export interface CandidateRow { id: string; account: string; name: string; is_member: boolean }

export interface UserRow {
  id: string;
  account: string;
  name: string;
  email: string | null;
  is_system_admin: boolean;
  status: string;
}

export interface AuditRow {
  id: string;
  ts: string | null;
  user_id: string | null;
  user_name: string | null;
  entry: string;
  action: string;
  target: string;
  ok: boolean;
  diff: Record<string, unknown> | null;
}

