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
type PlanStatusOut = components["schemas"]["PlanStatusOut"];
type PlanOut = components["schemas"]["PlanOut"];
type PlanCreateIn = components["schemas"]["PlanCreateIn"];
type PlanUpdateBody = components["schemas"]["plan_update_body"];
type PlanArchiveBody = components["schemas"]["plan_archive_body"];
type PlanDeleteBody = components["schemas"]["plan_delete_body"];
type OkOut = components["schemas"]["OkOut"];

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

const enc = encodeURIComponent;

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

export const planApi = {
  /** 计划列表（页码制：current+size，后端 paginate_page 钳 size 1..200，本端点没有 cursor
   *  这一说——响应里 next_cursor 恒 null）。响应外壳手写 Page<PlanOut>：plan_list 返回
   *  core Page(items, next_cursor=None, total=…)，带 total。
   *  注意：PlanOut 没有展示态字段（库里没那列，_plan_display 现算只从 status 出口给），
   *  列表页不许逐行拉 /status（N+1 请求 + 给列表编一个它没给过的数）。 */
  list: (q: PlanListQuery) =>
    get<Page<PlanOut>>("/plans?" + qs(q), { silent: true }),

  /** 计划详情（6b 详情页消费；跨项目与不存在同码同文案，前端不分句）。 */
  get: (projectId: string, planId: string) =>
    get<PlanOut>("/plans/" + enc(planId) + "?project_id=" + enc(projectId)),

  /** 计划实时状态（现算：status 四态 + 两个率 + 逐关联结论；率口径 pass=passed÷total、
   *  execute=executed÷total，空计划 0.0 不是 1.0——后端 _rates 是唯一算式）。 */
  status: (projectId: string, planId: string) =>
    get<PlanStatusOut>("/plans/" + enc(planId) + "/status?project_id=" + enc(projectId)),

  /** 新建计划（同项目重名 409——重名检查连回收站式墓碑都算，后端 _name_dup）。 */
  create: (body: PlanCreateIn) => post<PlanOut>("/plans", body),

  /** 改名/描述（PATCH 语义：不传=不改。**改不了归档**——archived 是后端显式声明的拒收
   *  哨兵位，传了值 422 说清去哪，传 null=没打算改。归档只有 archive()）。 */
  update: (planId: string, body: PlanUpdateBody) =>
    patch<PlanOut>("/plans/" + enc(planId), body),

  /** 归档（perm 是 testplan:plan:manage，不是 :update；归档是**终态**——对已归档再归档
   *  后端 409 already_archived，无反归档路径，UI 不许把它演成可撤销开关）。 */
  archive: (planId: string, body: PlanArchiveBody) =>
    post<PlanOut>("/plans/" + enc(planId) + "/archive", body),

  /** 删除（DELETE 带 JSON body：后端入参模型统一从 body 读 project_id，client.del 同款；
   *  级联删关联与报告是后端一条事务，前端不预告细节）。 */
  remove: (planId: string, body: PlanDeleteBody) =>
    del<OkOut>("/plans/" + enc(planId), body),

  // ── 关联（case-links）家族：6b 详情页消费 ────────────────────────────────

  /** 关联行分页（页码制，plan_list 同款裁决：只做页码、不挂 cursor）。响应外壳手写
   *  Page<PlanLinkOut>：services.py:414-425 返回 core Page(items, next_cursor=None,
   *  total=…)——total 是真总数，next_cursor 恒 null。
   *  **PlanLinkOut 没有 result/executed/executing**（执行结论在 GET /status 的 links[] 里，
   *  按 link_id == PlanLinkOut.id join，见 services.py:605-606；join 不上的行渲染「—」，
   *  不许现算一个结论填上去）。 */
  listLinks: (planId: string, q: PlanLinkListQuery) =>
    get<Page<PlanLinkOut>>("/plans/" + enc(planId) + "/case-links?" + qs(q), { silent: true }),

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
};
