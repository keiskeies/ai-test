// 场景资产面（§11.4.8/§11.4.9）：模块树 + CRUD + 回收站三件套 + duplicate/batchMove/references。
// 手写镜像后端 @service 路由（生成物 schema.d.ts 的 GET 响应是 unknown——后端返回标注
// BaseModel 不进 OpenAPI，与 1A 的 api.ts 同法手写）；入参类型直接引 schema.d.ts，
// 后端字段一变 gen:api 后这里先编译报错，不会静默漂移。
import { get, patch, post } from "./client";
import type { components, operations } from "./schema";
import type { Page } from "./api";

type ScenarioCreateIn = components["schemas"]["ScenarioCreateIn"];
// 带路径参数的 POST/PATCH 的 body 在 OpenAPI 里是匿名 *_body 模型（路径参数从入参
// 模型里剥离）；名字与 schema.d.ts 一致，改名会在编译期报错而不是静默漂移。
type ScenarioUpdateBody = components["schemas"]["scenario_update_body"];
type ScenarioOut = components["schemas"]["ScenarioOut"];
type ScenarioDuplicateBody = components["schemas"]["scenario_duplicate_body"];
type ScenarioBatchMoveIn = components["schemas"]["ScenarioBatchMoveIn"];
type ScenarioReferencesOut = components["schemas"]["ScenarioReferencesOut"];
type ScenarioModuleCreateIn = components["schemas"]["ScenarioModuleCreateIn"];
type ScenarioModuleNode = components["schemas"]["ScenarioModuleNode"];
type OkOut = components["schemas"]["OkOut"];
type RunEnqueueOut = components["schemas"]["RunEnqueueOut"];
type RunCancelOut = components["schemas"]["RunCancelOut"];
type RerunStepOut = components["schemas"]["RerunStepOut"];
type ScenarioRunBody = components["schemas"]["scenario_run_body"];
type ScenarioDebugBody = components["schemas"]["scenario_debug_body"];
type RunCancelBody = components["schemas"]["run_cancel_body"];
type RerunStepBody = components["schemas"]["run_rerun_step_body"];

type ListQuery = operations["get_scenario_list_api_v1_scenarios_get"]["parameters"]["query"];
type ReferencesQuery = operations["get_scenario_references_api_v1_scenario_references_get"]["parameters"]["query"];

const enc = encodeURIComponent;

// §11.4.18 回收站「删除人」列：scenario_list 分页后用 APP_USER 小查询回填的展示名。
// schema.d.ts 是 gen:api 生成物、本任务不重跑 gen——手写镜像先补上（本文件开头就是
// 这个约定：生成物缺的展示字段在手写层加，字段名与后端 schemas.ScenarioOut 逐字一致，
// 下次 gen 合流不漂移）。单行出口（get/create/…）不带这个名字，所以是可选。
export type ScenarioListRow = ScenarioOut & { updated_by_name?: string | null };

// D74 导出备份（§11.4.8 批量条 [导出]）：ScenarioExportIn/Out 是 scenario 域新模型，
// schema.d.ts 尚未含它们（本任务禁跑 gen:api）——同款手写镜像，字段名与后端
// app/modules/scenario/schemas.py 的 ScenarioExportIn/Out 逐字一致，下次 gen 合流不漂移。
// entry 字段与后端 export_services._entry 的键一一对应（只读快照，不可回灌）。
export type ScenarioExportIn = { project_id: string; scenario_ids?: string[] | null };
export type ScenarioExportEntry = {
  scenario_id: string;
  name: string;
  priority: string;
  module_id: string | null;
  step_graph: Record<string, unknown>;
  variables: Record<string, string>;
  fail_fast: boolean;
  max_runtime_ms: number | null;
  common_assertions: Record<string, unknown>[];
  env_id: string | null;
  project_public: boolean;
  validation: Record<string, unknown>[]; // 保存期同口径 validate：空 = 合法图
  refs: { step_key: string; kind: string; ref: string }[]; // 跨域引用 = 原样 id 指针
};
export type ScenarioExportOut = {
  scenarios: ScenarioExportEntry[];
  exported: number;
  notes: string[];
};

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

// GET /scenarios 的响应是 Page[ScenarioOut]（后端 paginate 投影；schema.d.ts 里是 unknown，
// 与 api.ts 对 Page<ApiDef> 的处理一致：分页外壳手写，行类型引用生成物）。
// D47-b 步5b：后端已加 current（页码，与 cursor 互斥，同传 400）/ keyword（只打 name，
// 大小写不敏感）/ module_ids（重复 query 键）三个入参；schema.d.ts 里**还没有**它们
// ——gen:api 会自起后端抢 8321（业主 demo 在那），本刀禁跑，这笔漂移记在 D47-b 计划 §六，
// 收尾整份重画 OpenAPI 时统一还。照本文件头的手写镜像约定，在派生类型上交显式类型，
// 字段名与后端 list 签名逐字一致，下次 gen 合流不漂移。
export type ScenarioListQuery = Pick<ListQuery, "project_id"> & Partial<Omit<ListQuery, "project_id">>
  & { current?: number; keyword?: string; module_ids?: string[] };

export const sceneApi = {
  /** 场景列表（recycled=true 只看回收站；页码模式带 current+size，与 cursor 互斥）。
   *  module_ids 是 list[str] 契约 = **重复 query 键**（module_ids=a&module_ids=b），不能走 qs()：
   *  qs 的 set(k, String(v)) 会把数组拼成 "a,b"，后端 list[str] 解成**一个**值 ["a,b"]——
   *  一个模块都匹配不上、列表直接空，而且不报错（静默错）。qs 是四个模块共用的，不动它；
   *  数组在这里单独 append（api.tsx 步4b load 的现成写法）。 */
  list: (q: ScenarioListQuery) => {
    const { module_ids, ...scalars } = q;
    const sp = new URLSearchParams(qs(scalars));
    for (const id of module_ids ?? []) sp.append("module_ids", id);
    return get<Page<ScenarioListRow>>("/scenarios?" + sp.toString(), { silent: true });
  },

  /** 场景详情（含 live issues：打开老场景就看见校验问题，不必等保存报错）。 */
  get: (projectId: string, scenarioId: string) =>
    get<ScenarioOut>("/scenarios/" + enc(scenarioId) + "?project_id=" + enc(projectId)),

  /** 创建场景（step_graph 有 issue → 422 validation_error + details.issues；重名 409）。 */
  create: (body: ScenarioCreateIn) => post<ScenarioOut>("/scenarios", body),

  /** 更新场景（乐观锁：version 不匹配 → 409 conflict + details.current_version，调用方要接住）。 */
  update: (scenarioId: string, body: ScenarioUpdateBody) =>
    patch<ScenarioOut>("/scenarios/" + enc(scenarioId), body),

  /** 软删进回收站（已回收再删 404）。 */
  remove: (projectId: string, scenarioId: string) =>
    post<OkOut>("/scenarios/" + enc(scenarioId) + "/delete", { project_id: projectId }),

  /** 从回收站恢复。 */
  restore: (projectId: string, scenarioId: string) =>
    post<ScenarioOut>("/scenarios/" + enc(scenarioId) + "/restore", { project_id: projectId }),

  /** 彻底删除（仅回收站可 purge；confirm_name 逐字相等，name_mismatch/not_recycled 409）。 */
  purge: (projectId: string, scenarioId: string, confirmName: string) =>
    post<OkOut>("/scenarios/" + enc(scenarioId) + "/purge",
      { project_id: projectId, confirm_name: confirmName }),

  /** 复制场景（graph/variables/priority 原样；名字默认加「- 副本」）。 */
  duplicate: (scenarioId: string, body: ScenarioDuplicateBody) =>
    post<ScenarioOut>("/scenarios/" + enc(scenarioId) + "/duplicate", body),

  /** 批量移动到模块（module_id=null → 根/未分类；回收站中的场景 404）。 */
  batchMove: (body: ScenarioBatchMoveIn) => post<OkOut>("/scenario-batch-move", body),

  /** 导出备份（D74，§11.4.8 批量条）：ids 传了只导这几条；缺省 = 项目内全部非回收可见场景。
   *  只读快照不可回灌（场景域无导入解析器，口径见后端 export_services 模块头）。 */
  export: (body: ScenarioExportIn) => post<ScenarioExportOut>("/scenario-export", body),

  /** 引用检测：某用例/接口定义被哪些未回收场景引用（含命中步骤 key）。 */
  references: (q: ReferencesQuery) =>
    get<ScenarioReferencesOut>("/scenario-references?" + qs(q)),

  // —— 场景模块树（R45：独立于 api_module，语义一致）——
  moduleTree: (projectId: string, includeRecycled = false) =>
    get<{ tree: ScenarioModuleNode[]; recycled: ScenarioModuleNode[] }>(
      "/scenario-modules?" + qs({ project_id: projectId, include_recycled: includeRecycled })),

  moduleCreate: (body: ScenarioModuleCreateIn) =>
    post<ScenarioModuleNode>("/scenario-modules", body),

  moduleUpdate: (moduleId: string, body: {
    project_id: string;
    name?: string | null;
    sort?: number | null;
    parent_id?: string | null;
  }) => patch<ScenarioModuleNode>("/scenario-modules/" + enc(moduleId), body),

  moduleDelete: (projectId: string, moduleId: string) =>
    post<OkOut>("/scenario-modules/" + enc(moduleId) + "/delete", { project_id: projectId }),

  moduleRestore: (projectId: string, moduleId: string) =>
    post<ScenarioModuleNode>("/scenario-modules/" + enc(moduleId) + "/restore", { project_id: projectId }),

  modulePurge: (projectId: string, moduleId: string, confirmName: string) =>
    post<{ ok: boolean; purged_modules: number; detached_scenarios: number }>(
      "/scenario-modules/" + enc(moduleId) + "/purge",
      { project_id: projectId, confirm_name: confirmName }),

  // —— T11 交付的执行面（T20 接线：调试跑未保存草稿，执行跑库里的场景）——

  /** 正式执行：跑**库里已保存**的场景，trigger=manual；返回 queued 的 run_id（投递语义）。 */
  run: (scenarioId: string, body: ScenarioRunBody) =>
    post<RunEnqueueOut>("/scenarios/" + enc(scenarioId) + "/run", body),

  /** 调试：跑**传入的未保存图**（§11.5.6），trigger=debug，不回写「最近结果」。 */
  debug: (scenarioId: string, body: ScenarioDebugBody) =>
    post<RunEnqueueOut>("/scenarios/" + enc(scenarioId) + "/debug", body),

  /** 取消执行中的 run（步骤边界生效）；已终态 409 already_finished。 */
  cancelRun: (runId: string, body: RunCancelBody) =>
    post<RunCancelOut>("/runs/" + enc(runId) + "/cancel", body),

  /** 单步重跑：从来源 run 的快照重建上下文只跑该步；同步等待，响应即终态。 */
  rerunStep: (runId: string, body: RerunStepBody) =>
    post<RerunStepOut>("/runs/" + enc(runId) + "/rerun-step", body),
};
