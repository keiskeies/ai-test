// UI 测试资产面（§11.4.11/§11.4.12）：元素 / UI 用例 CRUD + 模块树。
// 手写镜像后端 @service 路由（生成物 schema.d.ts 的 GET 响应是 unknown——后端返回标注
// BaseModel 不进 OpenAPI，与 api.ts / scene.ts 同法手写）；入参类型直接引 schema.d.ts，
// 后端字段一变 gen:api 后这里先编译报错，不会静默漂移。
// 读面随 T13 骨架页；写面（create/update/delete/restore/purge）随 T14 元素库页落地——
// 不做没人调的接口。references 查询是内部 @service（http=None，删除保护在服务端内部
// 调用并随 409 details 下发引用清单），没有 HTTP 端点，这里不假造。
import { get, patch, post } from "./client";
import type { components, operations } from "./schema";
import type { Page } from "./api";
import type { UiDebugResult } from "../ui/debugRows";

type UiElementOut = components["schemas"]["UiElementOut"];
type UiCaseOut = components["schemas"]["UiCaseOut"];
type UiModuleNode = components["schemas"]["UiModuleNode"];
type UiElementCreateIn = components["schemas"]["UiElementCreateIn"];
type UiCaseCreateIn = components["schemas"]["UiCaseCreateIn"];
// 带路径参数的 POST/PATCH 的 body 在 OpenAPI 里是匿名 *_body 模型（路径参数从入参
// 模型里剥离）；名字与 schema.d.ts 一致，改名会在编译期报错而不是静默漂移（照 scene.ts）。
type UiElementUpdateBody = components["schemas"]["ui_element_update_body"];
type UiElementPurgeBody = components["schemas"]["ui_element_purge_body"];
type UiCaseUpdateBody = components["schemas"]["ui_case_update_body"];
type OkOut = components["schemas"]["OkOut"];

type ElementListQuery = operations["get_ui_element_list_api_v1_ui_elements_get"]["parameters"]["query"];
type CaseListQuery = operations["get_ui_case_list_api_v1_ui_cases_get"]["parameters"]["query"];

// §11.4.18 回收站「删除人」列：列表分页后用 APP_USER 小查询回填的展示名（域内
// element_services._user_names，两个列表共用同一 helper）。schema.d.ts 是 gen:api 生成物、
// 本任务不重跑 gen——手写镜像先补上（本文件开头就是这个约定：生成物缺的展示字段在
// 手写层加，字段名与后端 schemas.UiElementOut/UiCaseOut 逐字一致，下次 gen 合流不漂移）。
// 单行出口（get/create/…）不带这个名字，所以是可选。
export type UiElementListRow = UiElementOut & { updated_by_name?: string | null };
export type UiCaseListRow = UiCaseOut & { updated_by_name?: string | null };

const enc = encodeURIComponent;

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

// GET 列表响应是 Page[XxxOut]（后端 paginate 投影；schema.d.ts 里是 unknown，
// 分页外壳手写，行类型引用生成物——与 scene.ts 同口径）。
// D47-b 步5d：后端 222f843 已收 current（页码，与 cursor 互斥，同传 400）/ keyword
// （只打 name，大小写不敏感，全空白=不过滤）/ module_ids（重复 query 键）三个入参；
// schema.d.ts 里**还没有**它们——gen:api 会自起后端抢 8321（业主 demo 在那），本刀禁跑，
// 这笔漂移记在 D47-b 计划 §六，收尾整份重画 OpenAPI 时统一还（已知漂移的显式补键，
// 字段名与后端 UiElementListIn 逐字一致，照本文件头手写镜像约定与 CaseListInput 先例）。
export type ElementListInput = Pick<ElementListQuery, "project_id"> & Partial<Omit<ElementListQuery, "project_id">>
  & { current?: number; keyword?: string; module_ids?: string[];
      /** D220：高级搜索条件（JSON 串；生成物尚未收录，同 current 手补） */ filter?: string };
// D47-b 步5a：`current?: number` 是**已知漂移的显式补键**——后端 /ui-cases 已收 current
// （页码分页那半边已提交），但 schema.d.ts 尚未重画（gen:api 会自起后端抢 8321 的业主
// demo 服务，本刀不许跑），operations 的 query 里还没有这个参数。收尾时整份重画生成物
// 统一还这笔债；不许挑单个字段手补 schema.d.ts（那是生成物）。
export type CaseListInput = Pick<CaseListQuery, "project_id"> & Partial<Omit<CaseListQuery, "project_id">>
  & { current?: number; /** D213：高级搜索条件（JSON 串；生成物尚未收录，同 current 手补） */ filter?: string };

/** 409 referenced_by_case 的 details（element_services._guard_delete）：
 * 无 ui:case:read 时数量照报、明细隐瞒（details_hidden=true 且 cases=[]）。 */
export interface ElementRefDetails {
  cases: { id: string; name: string; step_indexes: number[] }[];
  referenced_by: number;
  details_hidden: boolean;
}

export const uiApi = {
  /** 元素列表（recycled=true 只看回收站；used_by=未回收 UI 用例引用数，与删除拦截同源；
   *  页码模式带 current+size，与 cursor 互斥；
   *  updated_by_name 见上方 UiElementListRow 注释——回收站「删除人」列读它）。
   *  module_ids 是 list[str] 契约 = **重复 query 键**（module_ids=a&module_ids=b），不能走 qs()：
   *  qs 的 set(k, String(v)) 会把数组拼成 "a,b"，后端 list[str] 解成**一个**值 ["a,b"]——
   *  一个模块都匹配不上、列表直接空，而且不报错（静默错）。qs 是四个模块共用的，不动它；
   *  数组在这里单独 append（scene.ts 步5b 同法）。 */
  listElements: (q: ElementListInput) => {
    const { module_ids, ...scalars } = q;
    const sp = new URLSearchParams(qs(scalars));
    for (const id of module_ids ?? []) sp.append("module_ids", id);
    return get<Page<UiElementListRow>>("/ui-elements?" + sp.toString(), { silent: true });
  },

  /** 元素详情（回收站中的元素 404）。opts 透传给 client（silent：元素库落点横幅的
   *  存在性探针用它——探针失败由横幅自己按分支摊开说，不弹全局 toast）。 */
  getElement: (projectId: string, elementId: string, opts?: { silent?: boolean }) =>
    get<UiElementOut>("/ui-elements/" + enc(elementId) + "?project_id=" + enc(projectId), opts),

  /** 新建元素（同项目重名含回收站墓碑 → 409 name_exists；定位器类型限 5 种，R100/D2）。 */
  createElement: (body: UiElementCreateIn) => post<UiElementOut>("/ui-elements", body),

  /**
   * 改元素（改名/定位器/备注/移动模块，module_set=显式传 module_id 的声明位）。
   * 有引用时改 locator_type/locator → 409 referenced_by_case（details 同删除）。
   */
  updateElement: (elementId: string, body: UiElementUpdateBody) =>
    patch<UiElementOut>("/ui-elements/" + enc(elementId), body),

  /** 元素放入回收站（被未回收 UI 用例引用 → 409 referenced_by_case + details.cases，R106）。 */
  removeElement: (projectId: string, elementId: string) =>
    post<OkOut>("/ui-elements/" + enc(elementId) + "/delete", { project_id: projectId }),

  /** 从回收站恢复元素（同名被占 → 409 name_exists，不静默改名）。 */
  restoreElement: (projectId: string, elementId: string) =>
    post<UiElementOut>("/ui-elements/" + enc(elementId) + "/restore", { project_id: projectId }),

  /** 彻底删除回收站元素（confirm_name 逐字相等 + 引用同样硬拦，R53/R106）。 */
  purgeElement: (projectId: string, elementId: string, confirmName: string) =>
    post<OkOut>("/ui-elements/" + enc(elementId) + "/purge",
      { project_id: projectId, confirm_name: confirmName } satisfies UiElementPurgeBody),

  /** UI 用例列表（最近结果读冗余列，不 N+1 查 run_record；updated_by_name 同元素列表）。 */
  listCases: (q: CaseListInput) =>
    get<Page<UiCaseListRow>>("/ui-cases?" + qs(q), { silent: true }),

  /** UI 用例详情（含 live issues：打开老用例就看得见校验问题，不必等保存 422）。 */
  getCase: (projectId: string, caseId: string) =>
    get<UiCaseOut>("/ui-cases/" + enc(caseId) + "?project_id=" + enc(projectId)),

  /** 新建用例（steps 过协议门 + 元素引用门，不过 → 422 details.issues，R104 无乐观锁）。 */
  createCase: (body: UiCaseCreateIn) => post<UiCaseOut>("/ui-cases", body),

  /** 改用例（PATCH 语义：steps 不传=不改，清空靠 steps_set=true 声明位，同 scenario）。 */
  updateCase: (caseId: string, body: UiCaseUpdateBody) =>
    patch<UiCaseOut>("/ui-cases/" + enc(caseId), body),

  /**
   * 调试（trigger=debug，不落报告中心、不回写「最近结果」）。
   * 后端入参只有 {project_id, case_id}——**没有** ScenarioDebugIn 那样的 graph 字段，
   * 跑的是库里已保存的序列（1B「跑屏幕那份草稿」的语义在这里靠编辑页先代存草稿兑现，
   * 差异在界面上说出口；见 uiCaseDetail.tsx）。进程内真跑 Playwright，一次 5~15s。
   */
  debugCase: (projectId: string, caseId: string) =>
    post<UiDebugResult>("/ui-cases/" + enc(caseId) + "/debug", { project_id: projectId }),

  /** UI 模块树（R45 同族：独立模块树；count 元素+用例合计，element_count/case_count 分开给）。 */
  moduleTree: (projectId: string, includeRecycled = false) =>
    get<{ tree: UiModuleNode[]; recycled: UiModuleNode[] }>(
      "/ui-modules?" + qs({ project_id: projectId, include_recycled: includeRecycled })),
};
