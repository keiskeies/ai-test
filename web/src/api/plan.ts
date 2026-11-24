// 测试计划族前端镜像（D183 步 6a；后端 app/modules/testplan/ 为准）。
// 手写镜像后端 @service 路由：列表 GET 的 200 在生成物里是裸 `{}`（后端返回标注 BaseModel
// 不进 OpenAPI，与 api.ts / ui.ts / scene.ts 同法手写分页外壳）；行/入参类型一律引 schema.d.ts
// 生成物，后端字段一改这里先编译报错，不会静默漂移（ui.ts 文件头同一 rationale）。
// gen:api 本刀禁跑（会自起后端抢 :8321 的业主 demo 服务）——6a 时 PlanListIn 的
// current/size 已在生成物 query 里，列表不需要补键；6b 开 link/report 家族时同样现核
// operations（实测三个 GET 的 current/size 都在场）。**本文件只有一处手写行类型**：
// 报告列表行 PlanReportListRow——它**不是"还没生成"，是永远不会生成**（根因见下方该类型
// 处的注释：端点返回标注是 `-> ServiceResult`）。其余类型一律引生成物，别照着它再补。
// 端点面：6a 页面消费 list/create/update/archive/remove；get/status 由 **6b 详情页**消费
// （状态卡的四态/两率只从 GET /status 这一条读路取，页面零重算——见 pages/planDetail.tsx 文件头）。
// 关联（case-links）家族随 6b 开镜像；报告家族 6b 消费 GET list + POST create（详情页
// 报告区块）；报告详情一族（GET /plan-reports/{id} 与 /items）随 **6c**（pages/planReportDetail.tsx）
// 落地——不做没人调的接口这条纪律（ui.ts）对新家族仍然生效。
import { get, patch, post, del } from "./client";
import type { components, operations } from "./schema";
import type { Page } from "./api";

// 报告**列表行**：services._report_row（services.py:627-636）回的是头投影
// **PlanReportListRowOut——没有 items[]**；items 只存在于 PlanReportOut（详情，6c）。
// brief 里「每行自带 items 快照」说的是详情形状，以现核 services.py:818-829 为准。
// 该模型**永远不会进 schema.d.ts**，不是"还没进"：`openapi()` 实测 components 里没有
// PlanReportListRowOut，报告列表端点的 200 是裸 `{}`——根因是 `plan_report_list` 的返回
// 标注是 `-> ServiceResult`（services.py:818），而同族的 `plan_get` 标 `-> schemas.PlanOut`
// （services.py:222）就拿到了 `$ref`。**只有写进返回标注的模型才进 OpenAPI**，
// 所以重跑 gen:api 也补不上这一份（gen:api 本刀还禁跑：会自起后端抢 :8321 的业主 demo）。
// ⇒ 这是一份**长期镜像**，不是待合流的临时补键；后端若哪天把返回标注改成具体模型，
// 这里才改成引生成物。字段与后端 schemas.PlanReportListRowOut（schemas.py:327-345）逐字一致，
// 但它**没有编译期护栏**（生成物一改这里不会报错）——改后端那个模型时必须手动来改这里。
// 不许把它宽成 PlanReportOut——详情形状冒充列表行，页面就会去点一个不存在的 items 键。
export type PlanReportListRow = {
  id: string;
  project_id: string;
  plan_id: string;
  name: string;
  /** 生成时刻 _plan_display 的快照列（非词表值渲染原文，R112 同 planDisplayMeta 口径） */
  status: string;
  total: number;
  passed: number;
  failed: number;
  executed: number;
  executing: number;
  not_executed: number;
  pass_rate: number;
  execute_rate: number;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};
type PlanLinkOut = components["schemas"]["PlanLinkOut"];
type PlanLinkCreateBody = components["schemas"]["plan_link_create_body"];
type PlanLinkDeleteBody = components["schemas"]["plan_link_delete_body"];
type PlanReportCreateBody = components["schemas"]["plan_report_create_body"];
type PlanReportDeleteBody = components["schemas"]["plan_report_delete_body"];
type PlanReportOut = components["schemas"]["PlanReportOut"];
type PlanReportItemOut = components["schemas"]["PlanReportItemOut"];
/** D230 导出载体（content = 自包含 HTML 文本；由前端 downloadBlob 落地为文件）。 */
type PlanReportExport = { filename: string; media_type: string; content: string; item_count: number };
type PlanStatusOut = components["schemas"]["PlanStatusOut"];
type PlanOut = components["schemas"]["PlanOut"];
type PlanCreateIn = components["schemas"]["PlanCreateIn"];

/** D279：计划头六个可写位（测试阶段/计划与实际起止/责任人）。
 *  生成物本刀没有这些键（gen:api 禁跑，会自起后端抢 :8321 的业主 demo），手写交集，
 *  字段与后端 schemas.PlanCreateIn / PlanUpdateIn / PlanOut 逐字一致。
 *  日期一律 ISO 串；null = 未填（不是「今天」，也不画 0）。 */
export type PlanScheduleFields = {
  stage?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  owner_id?: string | null;
};
/** 更新路径的三态哨兵：带 `xxx_set: true` 才认 `xxx`（含 null = 清空）；
 *  不带 = 不动。与后端 PlanUpdateIn 的 `*_set` 逐字一致。 */
export type PlanScheduleSentinels = {
  stage_set?: boolean;
  planned_start_set?: boolean;
  planned_end_set?: boolean;
  actual_start_set?: boolean;
  actual_end_set?: boolean;
  owner_set?: boolean;
};

/** D285：标签（与后端 PlanRecord.tags 逗号串一一对应；出参为数组，空 = 无标签）。
 *  生成物本刀没有这一键（gen:api 禁跑），手写交集补齐。 */
export type PlanTagsField = { tags?: string[] };

/** D211：新建计划可带 module_id（生成物本刀没有这一键，手写交集补齐，字段与后端
 *  schemas.PlanCreateIn 一致；省略/null = 未分组）。 */
export type PlanCreateBody = PlanCreateIn & PlanScheduleFields & PlanTagsField
  & { module_id?: string | null };
type PlanUpdateBody = components["schemas"]["plan_update_body"]
  & PlanScheduleFields & PlanScheduleSentinels & PlanTagsField;
type PlanArchiveBody = components["schemas"]["plan_archive_body"];
// D208：复制入参**手写**——gen:api 本刀禁跑（会自起后端抢业主 :8321 的服务），生成物里
// 还没有 plan_copy_body；字段与后端 schemas.PlanCopyIn 逐字一致（project_id 必填，
// name 可选 = 不给自己生成 `<源名>_<5位>_COPY`）。
export type PlanCopyBody = { project_id: string; name?: string };

/** D225：执行计划的逐条结果。run_id 与 reason 二选一：
 *  投出去 → run_id；没投出去 → reason（人话，直接上屏，不翻译）。 */
export type PlanExecuteItem = {
  link_id: string;
  subject_type: string;
  subject_id: string;
  subject_name: string;
  run_id?: string | null;
  reason?: string | null;
};
export type PlanExecuteResult = {
  plan_id: string;
  submitted: number;
  skipped: number;
  items: PlanExecuteItem[];
};
export type PlanExecuteBody = { project_id: string; plan_id: string };
/** D209：批量删计划（MS `/delete/batch`）。全有或全无：任一 id 不在本项目 → 404 整批不动。 */
export type PlanBatchDeleteBody = { project_id: string; plan_ids: string[] };
type PlanDeleteBody = components["schemas"]["plan_delete_body"];
type OkOut = components["schemas"]["OkOut"];

// ── D231：计划关注人 ─────────────────────────────────────────────────────────
// gen:api 禁跑（会自起后端抢业主 :8321 的服务），生成物里还没有 D231 的三个模型；
// 手写交集与后端 schemas.PlanListRowOut / PlanDetailOut / PlanFollowOut 逐字段一致。
// 列表行只带 followed（不带总数：列表不做每页 GROUP BY，总数只在详情回答）；
// 关注态是**现查**plan_follower 的结果，不存前端第二份真相。
export type PlanRow = PlanOut & PlanScheduleFields & PlanTagsField & {
  /** D279：责任人姓名（后端一次批量解析；没有可解析的名字时缺省，前端画「—」） */
  owner_name?: string | null;
  followed?: boolean;
};

/** D275：列表页批量状态投影（后端 schemas.PlanStatusSummaryOut 手写镜像）。
 *  与 /plans/{id}/status 同一套判据（_plan_display/_link_result/_rates），只是不带 links 明细。 */
export type PlanStatusSummary = {
  plan_id: string;
  archived: boolean;
  status: string;
  total: number;
  passed: number;
  failed: number;
  executed: number;
  executing: number;
  not_executed: number;
  pass_rate: number;
  execute_rate: number;
  counts: {
    functional_case: number;
    api_case: number;
    scenario: number;
    ui_case: number;
    adb_case: number;
  };
};
export type PlanDetail = PlanOut & PlanScheduleFields & PlanTagsField & {
  owner_name?: string | null;
  followed?: boolean;
  follower_count?: number;
};
export type PlanFollowOut = { following: boolean; follower_count: number };

// 列表 query 直接引生成物 operations：后端 PlanListIn 改字段名，这里编译期就断。
type PlanListQuery = operations["get_plan_list_api_v1_plans_get"]["parameters"]["query"];
// 关联/报告两个 GET 的 200 在生成物里是裸 `{}`（@service 返回标注 BaseModel 不进
// OpenAPI，与 plan_list 同病）；query 参数本身已进生成物（current/size 实测在场），照抄引。
type PlanLinkListQuery =
  operations["get_plan_link_list_api_v1_plans__plan_id__case_links_get"]["parameters"]["query"];
type PlanReportListQuery =
  operations["get_plan_report_list_api_v1_plans__plan_id__reports_get"]["parameters"]["query"];
// 明细分页 GET 的 200 在生成物里同样是裸 unknown（plan_report_item_list 返回标注
// `-> ServiceResult`，services.py:785，与 plan_report_list 同病）；query 三键
// （project_id 必填 + current/size 可选）已在生成物，照抄引。
type PlanReportItemListQuery =
  operations["get_plan_report_item_list_api_v1_plan_reports__report_id__items_get"]["parameters"]["query"];

// ── D204：计划内功能用例（人工执行） ────────────────────────────────────────
// 这次的返回标注是 `-> ServiceResult`（分页 Page）与 `-> OkOut`（写），与列表族同病：
// 200 外壳不进 schema，行类型手写镜像后端 schemas.PlanFunctionalCaseOut（逐字段一致）。
// 词表 `none + 四值` 与后端 models.PLAN_FUNCTIONAL_RESULTS 对齐；前端不多造值。
export type PlanFunctionalResult = "pass" | "fail" | "blocked" | "skip";
export type PlanFunctionalCaseRow = {
  link_id: string;
  case_id: string;
  num: number;
  name: string;
  priority: string;
  module_id?: string | null;
  result: "none" | PlanFunctionalResult;
  comment?: string | null;
  executed: boolean;
  executed_by?: string | null;
  executed_at?: string | null;
};
export type PlanFunctionalListQuery = {
  project_id: string;
  current: number;
  size: number;
  keyword?: string;
  module_id?: string;
  /** none = 尚未给结论；不传 = 不筛 */
  result?: "none" | PlanFunctionalResult;
};
export type PlanFunctionalExecuteBody = {
  project_id: string;
  link_ids: string[];
  result: PlanFunctionalResult;
  comment?: string;
};

// ── D207：计划缺陷清单（只读聚合） ─────────────────────────────────────────
// 行类型镜像后端 schemas.PlanBugOut（逐字段一致）；数据是缺陷本体的实时投影，
// 不存快照，前端也不缓存成第二份真相。
export type PlanBugRow = {
  id: string;
  num: number;
  title: string;
  status: string;
  priority: string;
  handle_user_id?: string | null;
  handle_user_name?: string | null;
  tags: string[];
  created_at?: string | null;
  updated_at?: string | null;
};
export type PlanBugListQuery = {
  project_id: string;
  current: number;
  size: number;
  status?: string;
  priority?: string;
  keyword?: string;
};

// ── D211：计划模块树 ───────────────────────────────────────────────────────
// gen:api 禁跑（会自起后端抢业主 :8321 的服务），模块一族全部手写镜像后端：
// 类型与 schemas.PlanModuleNode/PlanModuleTreeOut 逐字段一致；4 个端点的返回里
// tree 标了 PlanModuleTreeOut（会进生成物，但本刀生成物没有），其余 CRUD 同理。
// 计数含归档计划（archive 不改 module_id）；树里没有「未分组」这个假节点。
export type PlanModuleNode = {
  id: string;
  parent_id?: string | null;
  name: string;
  sort: number;
  /** 本模块**直属**计划数（子模块的计划不并进来） */
  plan_count: number;
  children: PlanModuleNode[];
};
export type PlanModuleTree = { nodes: PlanModuleNode[]; unassigned_count: number };
export type PlanModuleCreateBody = {
  project_id: string;
  parent_id?: string | null;
  name: string;
  sort?: number;
};
/** parent_set = true 才认 parent_id（含 null = 移到根层）；与后端 PlanModuleUpdateIn 同款哨兵。 */
export type PlanModuleUpdateBody = {
  project_id: string;
  name?: string;
  parent_set?: boolean;
  parent_id?: string | null;
  sort?: number;
};

/** 列表 query 的模块扩展（后端 PlanListIn 本刀新增两键，生成物还没跟上，手写交集补齐）。 */
export type PlanListQueryWithModule = PlanListQuery & {
  /** 该模块**及整棵子树**内的计划 */
  module_id?: string;
  /** 只看未分组计划；与 module_id 同传后端 422 */
  unassigned?: boolean;
  /** D212：高级搜索条件（JSON 串，后端 PlanListIn.filter）。空条件不传。 */
  filter?: string;
  /** D231：只看我关注的计划（视图轴，与模块/未分组/条件组并行 AND）。 */
  followed_by_me?: boolean;
  /** D285：标签精确筛选（后端 FIND_IN_SET；空/全空白 = 不过滤）。 */
  tag?: string;
};

/** 关联改环境入参。**手写判别式，刻意偏离生成物一处**（生成物在说谎的地方）：
 *  ① plan_link_update_body 把 clear_env 标成必填——后端默认是 false（schemas.py:147
 *     `clear_env: bool = False`，生成物 @default false 注释在场），省略与 false 同义
 *     （services.py:439 判真值不判键在不在），必填是类型层面的假话，这里改回可选。
 *  ② env_id 与 clear_env **同给 = 422**「env_id 与 clear_env 不能同时给」
 *     （services.py:439-442 现核）。与其在页面里 if/else 守规矩再测试钉一遍，
 *     不如让「两个都给」在这个类型上**不可表示**——调用方连编译都过不去。
 *  plan_id/link_id 不在 body：路径带，后端 create_model 合并（与 update/archive 同形状）。 */
export type PlanLinkUpdateBody = { project_id: string } & (
  | { env_id: string; clear_env?: never }
  | { clear_env: true; env_id?: never }
  | { env_id?: never; clear_env?: never }
);

// ── D206：执行人指派 / 拖拽排序 / 批量摘除 ──────────────────────────────────
// PlanLinkOut 在生成物里没有这两列（后端这次加了，但 gen:api 禁跑）：**手写交集补齐**，
// 字段与后端 schemas.PlanLinkOut（schemas.py）逐字一致；`executor_id=null` 是「未指派」，
// `sort_order=0` 是「从未排过」（列表退化回 id 升序）。
export type PlanLinkRow = PlanLinkOut & {
  executor_id?: string | null;
  sort_order?: number;
};
export type PlanLinkAssignBody = {
  project_id: string;
  link_ids: string[];
  /** null = 取消指派；省略与 null 同义（后端默认 None），这里显式写 null 让语义可见。 */
  executor_id?: string | null;
};
export type PlanLinkSortBody = { project_id: string; link_ids: string[] };
export type PlanLinkBatchDeleteBody = { project_id: string; link_ids: string[] };
type PlanLinkWriteOut = { updated: number };

const enc = encodeURIComponent;

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

export type PlanFunctionalHistoryRow = {
  id: string;
  seq: number;
  result: string;
  comment: string | null;
  executed_by: string | null;
  created_at: string | null;
};

export type PlanFunctionalHistoryQuery = {
  project_id: string;
  current: number;
  size: number;
};

export const planApi = {
  /** 计划列表（页码制：current+size，后端 paginate_page 钳 size 1..200，本端点没有 cursor
   *  这一说——响应里 next_cursor 恒 null）。响应外壳手写 Page<PlanOut>：plan_list 返回
   *  core Page(items, next_cursor=None, total=…)，带 total。
   *  注意：PlanOut 没有展示态字段（库里没那列，_plan_display 现算只从 status 出口给），
   *  列表页不许逐行拉 /status（N+1 请求 + 给列表编一个它没给过的数）。 */
  list: (q: PlanListQueryWithModule) =>
    get<Page<PlanRow>>("/plans?" + qs(q), { silent: true }),

  // ── D211：计划模块树（左树 + 按模块过滤 + 模块 CRUD） ─────────────────────

  /** 模块树（perm testplan:plan:read）。树里只有模块，「未分组」由 unassigned_count 单列，
   *  前端渲染成树外的一条入口——不把一类「没有模块的计划」伪装成一个模块节点。 */
  moduleTree: (projectId: string) =>
    get<PlanModuleTree>("/plan-modules/tree?project_id=" + enc(projectId), { silent: true }),

  /** 新建模块（perm testplan:plan:create；同父重名 409，父模块须在本项目）。 */
  createModule: (body: PlanModuleCreateBody) =>
    post<PlanModuleNode>("/plan-modules", body),

  /** 改名/移动/排序（perm testplan:plan:update；成环 422 cycle、同父重名 409）。 */
  updateModule: (moduleId: string, body: PlanModuleUpdateBody) =>
    patch<PlanModuleNode>("/plan-modules/" + enc(moduleId), body),

  /** 删模块（perm testplan:plan:delete，destructive）。有子模块或计划 → 409 module_not_empty，
   *  **不递归删计划**（与 MS 相反，见后端 models.PlanModule docstring）。 */
  deleteModule: (moduleId: string, body: { project_id: string }) =>
    post<OkOut>("/plan-modules/" + enc(moduleId) + "/delete", body),

  /** 计划详情（6b 详情页消费；跨项目与不存在同码同文案，前端不分句）。
   *  D231：多两问 followed / follower_count——两条都是 `_plan` 之后现查 plan_follower
   *  （不存计划表冗余列）；写路径（create/update/archive/copy）不回答这两问。 */
  get: (projectId: string, planId: string) =>
    get<PlanDetail>("/plans/" + enc(planId) + "?project_id=" + enc(projectId)),

  /** D231：关注计划（perm testplan:plan:update——写副作用走写位，不借 read）。
   *  幂等：重复关注 following 仍 true；回执 follower_count 是操作后现查的行数。 */
  follow: (planId: string, body: { project_id: string }) =>
    post<PlanFollowOut>("/plans/" + enc(planId) + "/follow", body),

  /** D231：取消关注（幂等：未关注也回 following=false，不报错）。 */
  unfollow: (planId: string, body: { project_id: string }) =>
    post<PlanFollowOut>("/plans/" + enc(planId) + "/unfollow", body),

  /** 计划实时状态（现算：status 四态 + 两个率 + 逐关联结论；率口径 pass=passed÷total、
   *  execute=executed÷total，空计划 0.0 不是 1.0——后端 _rates 是唯一算式）。 */
  status: (projectId: string, planId: string) =>
    get<PlanStatusOut>("/plans/" + enc(planId) + "/status?project_id=" + enc(projectId)),

  /** D275：列表页批量状态（当前页一次，替代逐行 N+1）。只回仍存在的计划——
   *  取数间隙被删的行不在 items 里，前端画「—」而不是编 0。silent：页面自己有失败提示条。 */
  statusBatch: (projectId: string, planIds: string[]) =>
    post<{ items: PlanStatusSummary[]; total: number }>("/plan-status-batch",
      { project_id: projectId, plan_ids: planIds }, { silent: true }),

  /** 新建计划（同项目重名 409——重名检查连回收站式墓碑都算，后端 _name_dup）。 */
  create: (body: PlanCreateBody) => post<PlanOut>("/plans", body),

  /** 改名/描述（PATCH 语义：不传=不改。**改不了归档**——archived 是后端显式声明的拒收
   *  哨兵位，传了值 422 说清去哪，传 null=没打算改。归档只有 archive()）。 */
  update: (planId: string, body: PlanUpdateBody) =>
    patch<PlanOut>("/plans/" + enc(planId), body),

  /** 归档（perm 是 testplan:plan:manage，不是 :update；归档是**终态**——对已归档再归档
   *  后端 409 already_archived，无反归档路径，UI 不许把它演成可撤销开关）。 */
  archive: (planId: string, body: PlanArchiveBody) =>
    post<PlanOut>("/plans/" + enc(planId) + "/archive", body),

  /** D225：执行计划（perm testplan:plan:execute）。对计划内全部可运行关联对象
   *  （场景/UI 用例/ADB 用例）各投一次 worker；逐条回报 run_id 或跳过原因。
   *  **不返回整体成功/失败**：投出去几条、几条没投出去（及原因）都在 items 里——
   *  「部分成功」是常态（架构上的 503、权限缺位、对象在回收站都可能只挂一条）。 */
  execute: (planId: string, body: PlanExecuteBody) =>
    post<PlanExecuteResult>("/plans/" + enc(planId) + "/execute", body),

  /** 删除（DELETE 带 JSON body：后端入参模型统一从 body 读 project_id，client.del 同款；
   *  级联删关联与报告是后端一条事务，前端不预告细节）。 */
  remove: (planId: string, body: PlanDeleteBody) =>
    del<OkOut>("/plans/" + enc(planId), body),

  /** D208：复制计划（perm testplan:plan:create，与新建同一位；MS 的 copy 用 create/copy 二选一）。
   *  复制头 + 全部用例关联；**执行结论与已生成报告不复制**（复制件是全新一轮，未归档）。
   *  name 省略 = 后端生成 `<源名>_<5位>_COPY`；同项目重名 409（含显式给名的那条路）。 */
  copy: (planId: string, body: PlanCopyBody) =>
    post<PlanOut>("/plans/" + enc(planId) + "/copy", body),

  /** D209：批量删除（POST /plans/batch-delete，与单删同一位 testplan:plan:delete）。
   *  全有或全无：任一 id 不在本项目 → 404，一行都不删；级联与单删同一条事务。 */
  batchDelete: (body: PlanBatchDeleteBody) =>
    post<OkOut>("/plans/batch-delete", body),

  // ── 关联（case-links）家族：6b 详情页消费 ────────────────────────────────

  /** 关联行分页（页码制，plan_list 同款裁决：只做页码、不挂 cursor）。响应外壳手写
   *  Page<PlanLinkOut>：services.py:414-425 返回 core Page(items, next_cursor=None,
   *  total=…)——total 是真总数，next_cursor 恒 null。
   *  **PlanLinkOut 没有 result/executed/executing**（执行结论在 GET /status 的 links[] 里，
   *  按 link_id == PlanLinkOut.id join，见 services.py:605-606；join 不上的行渲染「—」，
   *  不许现算一个结论填上去）。 */
  listLinks: (planId: string, q: PlanLinkListQuery) =>
    get<Page<PlanLinkRow>>("/plans/" + enc(planId) + "/case-links?" + qs(q), { silent: true }),

  /** 挂关联（409 已在此计划 / 404 subject 不存在·跨项目·回收站——原话直出，不翻译）。
   *  env_id 省略 = 后端抄 subject 自己的 env（抄不到留空 = 执行时沿用 subject 默认口径），
   *  所以「没选环境」不是「无环境」，UI 不许把空说成后者。 */
  createLink: (planId: string, body: PlanLinkCreateBody) =>
    post<PlanLinkOut>("/plans/" + enc(planId) + "/case-links", body),

  /** 改关联的环境（**只改得动 env**：subject 改不了，那是删了重挂。env_id 与 clear_env
   *  同给 422——类型 PlanLinkUpdateBody 已把这条路堵死，见其定义处注释）。 */
  updateLink: (planId: string, linkId: string, body: PlanLinkUpdateBody) =>
    patch<PlanLinkOut>("/plans/" + enc(planId) + "/case-links/" + enc(linkId), body),

  /** 摘除关联（DELETE 带 JSON body {project_id}；只删关联行，用例本体无损）。 */
  deleteLink: (planId: string, linkId: string, body: PlanLinkDeleteBody) =>
    del<OkOut>("/plans/" + enc(planId) + "/case-links/" + enc(linkId), body),

  // ── D206：批量指派执行人 / 排序 / 批量摘除 ────────────────────────────────

  /** 批量指派执行人（perm testplan:link:update）。执行人必须是本项目成员（422
   *  invalid_executor）；任一 link 不在本计划 → 404 整批不动。 */
  assignLinks: (planId: string, body: PlanLinkAssignBody) =>
    post<PlanLinkWriteOut>("/plans/" + enc(planId) + "/case-links/assign", body),

  /** 拖拽排序（perm 同上）。link_ids **必须覆盖计划内全部关联**（422 incomplete_sort），
   *  先后即新顺序；页面因此只在「本页装得下全部关联」时摆上下移把手。 */
  sortLinks: (planId: string, body: PlanLinkSortBody) =>
    post<PlanLinkWriteOut>("/plans/" + enc(planId) + "/case-links/sort", body),

  /** 批量摘除（perm testplan:link:delete，destructive）：删关联行 + 该行人工结论/流水，
   *  用例本体不动；全有或全无。 */
  batchDeleteLinks: (planId: string, body: PlanLinkBatchDeleteBody) =>
    post<PlanLinkWriteOut>("/plans/" + enc(planId) + "/case-links/batch-delete", body),

  // ── D204：计划内功能用例（人工执行结论） ─────────────────────────────────

  /** 计划内功能用例分页（结论来源是 plan_functional_exec，不是 run_record）。
   *  perm testplan:link:read；与关联列表不同，这一族带**精确 result**（none/pass/fail/
   *  blocked/skip），列表页据此画原值 Tag——plan status 只有 passed/failed 两轴，
   *  拿 status 画结论会把「阻塞」显示成「未通过」。 */
  listFunctional: (planId: string, q: PlanFunctionalListQuery) =>
    get<Page<PlanFunctionalCaseRow>>("/plans/" + enc(planId) + "/functional-cases?" + qs(q),
      { silent: true }),

  /** 写人工结论（批量 link_ids；覆盖当前结论 + 追加一条 history）。
   *  perm testplan:functional:execute；归档计划 409；跨计划 link 整批 404。 */
  executeFunctional: (planId: string, body: PlanFunctionalExecuteBody) =>
    post<OkOut>("/plans/" + enc(planId) + "/functional-cases/execute", body),

  /** D218：结论变更历史（append-only 流水，seq 倒序，页码分页）。
   *  perm testplan:link:read；行类型是**长期手写镜像**（端点返回标注是 ServiceResult，
   *  `PlanFunctionalHistoryOut` 不进 OpenAPI），字段与后端 schemas.py:355 逐字一致。 */
  functionalHistory: (planId: string, linkId: string, q: PlanFunctionalHistoryQuery) =>
    get<Page<PlanFunctionalHistoryRow>>(
      "/plans/" + enc(planId) + "/functional-cases/" + enc(linkId) + "/history?" + qs(q),
      { silent: true }),

  /** D207：计划缺陷清单（计划内用例关联的缺陷，按缺陷去重；只读）。
   *  perm testplan:link:read；回收站里的缺陷不出现（读的是「这个计划暴露了哪些缺陷」）。 */
  listBugs: (planId: string, q: PlanBugListQuery) =>
    get<Page<PlanBugRow>>("/plans/" + enc(planId) + "/bugs?" + qs(q), { silent: true }),

  // ── 报告家族（列表 + 生成）：6b 详情页消费；报告详情一族归 6c ─────────────

  /** 报告分页（页码制同上）。行 = 头投影 PlanReportListRowOut，**不带 items**
   *  （明细归详情 = 6c；列表不为每行明细付查询，services.py:815 的 description 原话）。 */
  listReports: (planId: string, q: PlanReportListQuery) =>
    get<Page<PlanReportListRow>>("/plans/" + enc(planId) + "/reports?" + qs(q), { silent: true }),

  /** 生成报告（一次性快照：此刻的结论定格进库，之后的执行不动已生成的报告。
   *  name 省略 = 后端抄「<计划名> 报告」。perm testplan:report:create。 */
  createReport: (planId: string, body: PlanReportCreateBody) =>
    post<components["schemas"]["PlanReportOut"]>("/plans/" + enc(planId) + "/reports", body),

  // ── 报告详情一族：6c 报告详情页（pages/planReportDetail.tsx）消费 ─────────

  /** 报告详情（头 + **全量内联 items**，这条路径不分页——schemas.py PlanReportGetIn 没有
   *  current/size，快照逐字节用例钉的就是这个形状）。返回标注 `-> schemas.PlanReportOut`
   *  进了生成物（与裸 `{}` 的列表端点不同病），响应类型直接引生成物。
   *  头九字段 + 两率 + items；两率是后端读时从存量计数派生的纯函数（口径 = PlanStatusOut：
   *  分母 = total，空报告 0.0 不是 1.0），页面照旧零重算。 */
  report: (reportId: string, projectId: string) =>
    get<PlanReportOut>("/plan-reports/" + enc(reportId) + "?project_id=" + enc(projectId)),

  /** 明细的**页码窗口**（步 5 端点；详情内联 items 与本页共用同一份 where/order_by——
   *  序 = link_id 升序，「逐页走出的 items == 详情 items」是后端用例钉的，不是约定）。
   *  响应外壳手写 Page<PlanReportItemOut>：services.py:785 返回 core
   *  Page(items, next_cursor=None, total=…)，200 在生成物里是裸 unknown（返回标注
   *  `-> ServiceResult`），列 listLinks/listReports 同款。size 后端夹 1..200。 */
  reportItems: (reportId: string, q: PlanReportItemListQuery) =>
    get<Page<PlanReportItemOut>>("/plan-reports/" + enc(reportId) + "/items?" + qs(q), { silent: true }),

  /** 删除报告（物理删；后端同事务级联删**该报告的**明细行——只按 report_id 删。
   *  级联细节前端不预告，见 planApi.remove 同一口径。perm testplan:report:delete。 */
  deleteReport: (reportId: string, body: PlanReportDeleteBody) =>
    del<OkOut>("/plan-reports/" + enc(reportId), body),

  /** D210：报告改名（PATCH /plan-reports/{id}，perm testplan:report:update）。
   *  后端只写 name 一列——内容快照（status/计数/明细）仍是生成时刻的定格；前端改完只重取列表，
   *  不重新生成报告。响应是列表行形状（PlanReportListRowOut），不是详情（没有 items）。 */
  renameReport: (reportId: string, body: { project_id: string; name: string }) =>
    patch<PlanReportListRow>("/plan-reports/" + enc(reportId), body),

  /** D230：导出报告（GET /plan-reports/{id}/export，perm testplan:report:read）。
   *  载体是 JSON 文本（content = 自包含 HTML），**不是** Blob 响应：本仓端点全在
   *  @service 注册表里，raw 路由会漏权限/审计/OpenAPI 同一张网；前端 `downloadBlob`
   *  把 content 落地为 .html（defect_export 的 CSV 载体同款先例）。
   *  内容是生成报告时的快照明细，item_count = 实际导出的明细行数（≠ 计划当前关联数）。 */
  exportReport: (reportId: string, projectId: string) =>
    get<PlanReportExport>("/plan-reports/" + enc(reportId) + "/export?project_id=" + enc(projectId)),
};
