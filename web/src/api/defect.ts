// 缺陷族前端镜像（D191；后端 app/modules/defect/services.py 为准）。
//
// 手写镜像而不是 `pnpm gen:api`：生成器会自起后端抢 :8321（plan.ts 文件头同一条禁令）。
// 行/入参类型**逐字对齐**后端 schemas.py；后端改字段时这里没有编译期护栏，
// 所以每条注释都点名后端出处，改动时照 services/schemas 现核。
//
// 状态词表与转移边是后端 models.py 的两份常量（`DEFECT_STATUSES` / `DEFECT_TRANSITIONS`）。
// 前端只拿它渲染下拉框；**真正的门禁在后端**（非法转移 409），这里漏一条只是少一个选项，
// 多一条会被后端当场拒绝——绝不反过来。
import { get, patch, post } from "./client";

export type DefectRow = {
  id: string;
  num: number;
  project_id: string;
  template_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  handle_user_id: string | null;
  handle_user_name: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  recycled: boolean;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  delete_user: string | null;
  delete_user_name: string | null;
  delete_time: string | null;
  link_count: number;
  comment_count: number;
  follower_count: number;
  followed: boolean;
};

export type DefectPage = { items: DefectRow[]; total: number | null };

export type DefectComment = {
  id: string;
  defect_id: string;
  parent_id: string | null;
  content: string;
  reply_user_id: string | null;
  reply_user_name: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  children: DefectComment[];
};

export type DefectLink = {
  id: string;
  defect_id: string;
  case_type: string;
  case_id: string;
  case_name: string | null;
  case_exists: boolean;
  created_by: string | null;
  created_at: string | null;
};

export type DefectCaseOption = { id: string; name: string; status: string | null };
export type DefectCasePage = { items: DefectCaseOption[]; total: number };

export type DefectExport = { filename: string; content: string; exported: number; notes: string[] };

export const DEFECT_STATUSES = ["new", "in_process", "resolved", "rejected", "closed"] as const;

/** 与后端 models.DEFECT_TRANSITIONS 逐条同构（同态放行由 allowedStatuses 自己补）。 */
export const DEFECT_TRANSITIONS: Record<string, string[]> = {
  new: ["in_process", "rejected"],
  in_process: ["rejected", "resolved", "closed"],
  resolved: ["in_process", "closed"],
  rejected: ["in_process"],
  closed: ["in_process"],
};

export type DefectStatusMeta = { label: string; color: string };
const STATUS_META: Record<string, DefectStatusMeta> = {
  new: { label: "新建", color: "default" },
  in_process: { label: "处理中", color: "processing" },
  resolved: { label: "已解决", color: "success" },
  rejected: { label: "已拒绝", color: "warning" },
  closed: { label: "已关闭", color: "default" },
};
/** 词表外的值渲染原文（R112 口径：没见过的不许演成见过的）。 */
export function statusMeta(v: string): DefectStatusMeta {
  return STATUS_META[v] ?? { label: v, color: "default" };
}

/** 当前状态允许的去向（含自身：同态不构成转移，后端放行）。 */
export function allowedStatuses(current: string): string[] {
  return [current, ...(DEFECT_TRANSITIONS[current] ?? [])];
}

// ══════════ 状态流转配置（D267，后端 /defect-statuses）══════════
// 每个项目可整份覆盖默认图；后端空表 = 默认图，所以这里拿到的一定是生效图。
export type DefectFlowStatus = { key: string; name: string; is_start: boolean; is_end: boolean };
export type DefectFlowEdge = { from_key: string; to_key: string };
/** 图从哪来（D271）：项目自定义 > 所属组织模板 > 内置默认。 */
export type DefectFlowSource = "project" | "org" | "default";
/** 项目/组织两份读口共有的形状（assert 守卫只看这几列）。 */
export type DefectFlowView = {
  customized: boolean;
  source?: DefectFlowSource;
  start_key: string;
  statuses: DefectFlowStatus[];
  transitions: DefectFlowEdge[];
};
export type DefectFlow = DefectFlowView & { project_id: string };
export type OrgDefectFlow = DefectFlowView & { org_id: string };

export const defectFlowApi = {
  get: (projectId: string) => get<DefectFlow>("/defect-statuses" + qs({ project_id: projectId })),
  save: (projectId: string, statuses: DefectFlowStatus[], transitions: DefectFlowEdge[]) =>
    post<DefectFlow>("/defect-statuses", { project_id: projectId, statuses, transitions }),
  reset: (projectId: string) => post<DefectFlow>("/defect-statuses/reset", { project_id: projectId }),
};

/** D271：组织级状态流模板（授权在服务端按 org_cap_check 判定）。 */
export const defectOrgFlowApi = {
  get: (orgId: string) => post<OrgDefectFlow>("/system/orgs/defect-flow/get", { org_id: orgId }),
  save: (orgId: string, statuses: DefectFlowStatus[], transitions: DefectFlowEdge[]) =>
    post<OrgDefectFlow>("/system/orgs/defect-flow/save", { org_id: orgId, statuses, transitions }),
  reset: (orgId: string) => post<OrgDefectFlow>("/system/orgs/defect-flow/reset", { org_id: orgId }),
};

/** 形状守卫：拿到的不是图（老假接口/网关错误页）就不能塞进 state，否则渲染期炸。 */
export function isDefectFlow(x: unknown): x is DefectFlow {
  const f = x as DefectFlow | null;
  return Boolean(f) && Array.isArray(f!.statuses) && Array.isArray(f!.transitions)
    && typeof f!.start_key === "string";
}

export function isOrgDefectFlow(x: unknown): x is OrgDefectFlow {
  const f = x as OrgDefectFlow | null;
  return Boolean(f) && typeof f!.org_id === "string"
    && Array.isArray(f!.statuses) && Array.isArray(f!.transitions)
    && typeof f!.start_key === "string";
}

/** 状态名：优先用项目配置的 name；拉不到图时退回内置词表（陌生 key 渲染原文）。 */
export function flowLabel(flow: DefectFlow | null, key: string): string {
  return flow?.statuses.find((s) => s.key === key)?.name ?? statusMeta(key).label;
}

/** 当前状态允许的去向（含自身）：有图按图，没图按内置常量。 */
export function flowAllowed(flow: DefectFlow | null, current: string): string[] {
  if (!flow) return allowedStatuses(current);
  return [current, ...flow.transitions.filter((e) => e.from_key === current).map((e) => e.to_key)];
}

export const CASE_TYPE_LABELS: Record<string, string> = {
  api_case: "接口用例",
  scenario: "场景",
  ui_case: "UI 用例",
  adb_case: "ADB 用例",
  functional_case: "功能用例",
};

export type DefectListQuery = {
  project_id: string;
  current: number;
  size: number;
  recycled?: boolean;
  status?: string;
  priority?: string;
  handle_user_id?: string;
  keyword?: string;
  tag?: string;
  followed_by_me?: boolean;
  template_id?: string;
  // D216：高级搜索条件组（JSON 串）。与上面各快捷筛选并行 AND，空串=没筛选。
  filter?: string;
};

export type DefectCreateBody = {
  project_id: string;
  title: string;
  description?: string | null;
  priority?: string;
  handle_user_id?: string | null;
  tags?: string[];
  template_id?: string | null;
  custom_fields?: Record<string, unknown>;
};

export type DefectUpdateBody = {
  project_id: string;
  title?: string;
  template_id?: string | null;
  custom_fields?: Record<string, unknown>;
  description?: string | null;
  description_set?: boolean;
  priority?: string;
  handle_user_id?: string | null;
  handle_user_set?: boolean;
  status?: string;
  tags?: string[];
};

function qs(q: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? "?" + s : "";
}

export const defectApi = {
  list: (q: DefectListQuery) => get<DefectPage>("/defects" + qs(q)),

  create: (body: DefectCreateBody) => post<DefectRow>("/defects", body),
  update: (id: string, body: DefectUpdateBody) =>
    patch<DefectRow>("/defects/" + encodeURIComponent(id), body),
  get: (projectId: string, id: string) =>
    get<DefectRow>("/defects/" + encodeURIComponent(id) + qs({ project_id: projectId })),
  remove: (projectId: string, id: string) =>
    post<{ ok: boolean; affected: number }>("/defects/" + encodeURIComponent(id) + "/delete",
      { project_id: projectId, defect_id: id }),
  batchDelete: (projectId: string, ids: string[]) =>
    post<{ ok: boolean; affected: number }>("/defects/batch-delete", { project_id: projectId, defect_ids: ids }),
  batchUpdateTags: (projectId: string, ids: string[], action: "add_tags" | "clear_tags" | "replace_tags",
                    tags: string[]) =>
    post<{ ok: boolean; affected: number }>("/defects/batch-update",
      { project_id: projectId, defect_ids: ids, action, tags }),
  restore: (projectId: string, id: string) =>
    post<DefectRow>("/defects/" + encodeURIComponent(id) + "/restore", { project_id: projectId, defect_id: id }),
  purge: (projectId: string, id: string, confirmTitle: string) =>
    post<{ ok: boolean; affected: number }>("/defects/" + encodeURIComponent(id) + "/purge",
      { project_id: projectId, defect_id: id, confirm_title: confirmTitle }),
  batchRestore: (projectId: string, ids: string[]) =>
    post<{ ok: boolean; affected: number }>("/defects/batch-restore", { project_id: projectId, defect_ids: ids }),
  batchPurge: (projectId: string, ids: string[]) =>
    post<{ ok: boolean; affected: number }>("/defects/batch-purge", { project_id: projectId, defect_ids: ids }),

  comments: (projectId: string, defectId: string) =>
    get<{ items: DefectComment[]; total: number }>(
      "/defects/" + encodeURIComponent(defectId) + "/comments" + qs({ project_id: projectId })),
  addComment: (projectId: string, defectId: string, content: string, parentId?: string | null) =>
    post<DefectComment>("/defects/" + encodeURIComponent(defectId) + "/comments",
      { project_id: projectId, defect_id: defectId, content, parent_id: parentId ?? null }),
  updateComment: (projectId: string, commentId: string, content: string) =>
    patch<DefectComment>("/defect-comments/" + encodeURIComponent(commentId),
      { project_id: projectId, comment_id: commentId, content }),
  deleteComment: (projectId: string, commentId: string) =>
    post<{ ok: boolean; affected: number }>("/defect-comments/" + encodeURIComponent(commentId) + "/delete",
      { project_id: projectId, comment_id: commentId }),

  links: (projectId: string, defectId: string) =>
    get<{ items: DefectLink[]; total: number }>(
      "/defects/" + encodeURIComponent(defectId) + "/case-links" + qs({ project_id: projectId })),
  addLinks: (projectId: string, defectId: string, caseType: string, caseIds: string[]) =>
    post<{ created: number; skipped: number }>("/defect-links",
      { project_id: projectId, defect_id: defectId, case_type: caseType, case_ids: caseIds }),
  removeLink: (projectId: string, defectId: string, linkId: string) =>
    post<{ ok: boolean; affected: number }>("/defect-links/" + encodeURIComponent(linkId) + "/delete",
      { project_id: projectId, defect_id: defectId, link_id: linkId }),
  candidates: (projectId: string, defectId: string, caseType: string, keyword?: string,
               current = 1, size = 20) =>
    get<DefectCasePage>("/defect-link-candidates" + qs({
      project_id: projectId, defect_id: defectId, case_type: caseType,
      keyword, current, size,
    })),

  follow: (projectId: string, id: string) =>
    post<{ following: boolean; follower_count: number }>("/defects/" + encodeURIComponent(id) + "/follow",
      { project_id: projectId, defect_id: id }),
  unfollow: (projectId: string, id: string) =>
    post<{ following: boolean; follower_count: number }>("/defects/" + encodeURIComponent(id) + "/unfollow",
      { project_id: projectId, defect_id: id }),

  exportCsv: (projectId: string, ids?: string[]) =>
    post<DefectExport>("/defects/export", { project_id: projectId, defect_ids: ids ?? null }),
  exportColumns: (projectId: string) =>
    get<{ columns: { key: string; label: string }[] }>("/defect-export-columns" + qs({ project_id: projectId })),
};
