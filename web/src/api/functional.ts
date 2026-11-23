// 功能用例族前端镜像（D193）：用例本体 + 模块树 + 回收站。
// 后端 app/modules/functional/services.py 为准；模板/字段沿用 projectMeta.ts。
import { get, getBlob, patch, post, postForm } from "./client";

export type FunctionalModuleNode = {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  status: string;
  case_count: number;
  children: FunctionalModuleNode[];
};

export type ModuleTree = { tree: FunctionalModuleNode[]; recycled: FunctionalModuleNode[] };

export type CaseRow = {
  id: string;
  num: number;
  project_id: string;
  module_id: string | null;
  template_id: string;
  name: string;
  priority: string;
  description: string | null;
  recycled: boolean;
  custom_fields: Record<string, unknown>;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** D234：列表行「我关注了没」（只在读路径出现，创建/更新回执没有）。 */
  followed?: boolean;
};

/** D234：详情现查关注态与人数（后端不存冗余列）。 */
export type CaseDetail = CaseRow & { followed?: boolean; follower_count?: number };

export type CaseFollowOut = { following: boolean; follower_count: number };

export type CasePage = { items: CaseRow[]; total: number | null };

export type CaseListQuery = {
  project_id: string;
  module_id?: string;
  unfiled_only?: boolean;
  priority?: string;
  keyword?: string;
  recycled?: boolean;
  /** D234：「我关注的」视图轴（后端与模块/未分组/关键词/高级搜索并行 AND）。 */
  followed_by_me?: boolean;
  /** D219：高级搜索条件组（JSON 串，字段白名单由后端 FUNCTIONAL_CASE_LIST_FILTER 给）。 */
  filter?: string;
  current: number;
  size: number;
};

export type CaseComment = {
  id: string;
  case_id: string;
  parent_id: string | null;
  content: string;
  reply_user_id: string | null;
  reply_user_name: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  children: CaseComment[];
};

export type CaseRelationItem = {
  relation_id: string;
  case: { id: string; num: number; name: string };
  relation_type: "predecessor" | "successor";
};

export type CaseRelations = { predecessors: CaseRelationItem[]; successors: CaseRelationItem[] };

export type CaseCreateBody = {
  project_id: string;
  module_id?: string | null;
  name: string;
  priority?: string;
  description?: string | null;
  template_id?: string | null;
  custom_fields?: Record<string, unknown>;
};

export type CaseUpdateBody = {
  project_id: string;
  name?: string;
  priority?: string;
  description?: string | null;
  description_set?: boolean;
  module_id?: string | null;
  module_set?: boolean;
  template_id?: string | null;
  custom_fields?: Record<string, unknown>;
};

/** D232：批量编辑（只有两个真实列：优先级 / 模块）。
 *  模块用 module_set 哨兵区分「不改」与「移到未分组（module_id=null）」——JSON 里 null
 *  与缺省在 Pydantic 里都是 None，没有哨兵分不清（后端 CaseBatchUpdateIn 同款）。
 *  两个字段都不给时后端 422 `empty_update`，前端也应先拦住（不发空请求）。 */
export type CaseBatchUpdateBody = {
  project_id: string;
  case_ids: string[];
  priority?: string;
  module_id?: string | null;
  module_set?: boolean;
};

/** D233：批量复制。module_set 同 D232 的哨兵——缺省 = 副本留在源用例自己的模块，
 *  true 时全落到 module_id（null = 未分类）；name_suffix 默认「（副本）」，
 *  空串 = 副本与源同名。评论与前后置关系不复制（后端口径）。 */
export type CaseBatchCopyBody = {
  project_id: string;
  case_ids: string[];
  module_id?: string | null;
  module_set?: boolean;
  name_suffix?: string;
};

export type CaseBatchCopyOut = { ok: boolean; affected: number; case_ids: string[] };

/** D236：统计分组轴（后端 Literal 三选一；MS 的 casetype 等本仓无等价列，不硬造）。 */
export type CaseStatsGroupBy = "priority" | "module" | "creator";

export type CaseStatGroup = { key: string; label: string; count: number };

export type CaseStats = {
  total: number;
  recycled_total: number;
  group_by: string;
  groups: CaseStatGroup[];
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

const enc = encodeURIComponent;

export const functionalApi = {
  tree: (projectId: string, includeRecycled = false) =>
    get<ModuleTree>("/functional-modules/tree" + qs({ project_id: projectId, include_recycled: includeRecycled || undefined })),
  createModule: (body: { project_id: string; parent_id?: string | null; name: string; sort?: number }) =>
    post<FunctionalModuleNode>("/functional-modules", body),
  updateModule: (id: string, body: { project_id: string; name?: string; sort?: number;
                                      parent_id?: string | null; parent_set?: boolean }) =>
    patch<FunctionalModuleNode>("/functional-modules/" + enc(id), body),
  deleteModule: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/functional-modules/" + enc(id) + "/delete",
      { project_id: projectId, module_id: id }),
  restoreModule: (projectId: string, id: string) =>
    post<FunctionalModuleNode>("/functional-modules/" + enc(id) + "/restore",
      { project_id: projectId, module_id: id }),
  purgeModule: (projectId: string, id: string, confirmName: string) =>
    post<{ ok: boolean; purged_modules: number }>("/functional-modules/" + enc(id) + "/purge",
      { project_id: projectId, module_id: id, confirm_name: confirmName }),

  listCases: (q: CaseListQuery) => get<CasePage>("/functional-cases" + qs(q)),
  createCase: (body: CaseCreateBody) => post<CaseRow>("/functional-cases", body),
  getCase: (projectId: string, id: string) =>
    get<CaseDetail>("/functional-cases/" + enc(id) + qs({ project_id: projectId })),
  /** D234：关注/取关（幂等；回执 follower_count 是操作后现查）。 */
  followCase: (projectId: string, id: string) =>
    post<CaseFollowOut>("/functional-cases/" + enc(id) + "/follow",
      { project_id: projectId, case_id: id }),
  unfollowCase: (projectId: string, id: string) =>
    post<CaseFollowOut>("/functional-cases/" + enc(id) + "/unfollow",
      { project_id: projectId, case_id: id }),
  updateCase: (id: string, body: CaseUpdateBody) =>
    patch<CaseRow>("/functional-cases/" + enc(id), body),
  deleteCase: (projectId: string, id: string) =>
    post<{ ok: boolean; affected: number }>("/functional-cases/" + enc(id) + "/delete",
      { project_id: projectId, case_id: id }),
  restoreCase: (projectId: string, id: string) =>
    post<CaseRow>("/functional-cases/" + enc(id) + "/restore",
      { project_id: projectId, case_id: id }),
  purgeCase: (projectId: string, id: string, confirmName: string) =>
    post<{ ok: boolean; affected: number }>("/functional-cases/" + enc(id) + "/purge",
      { project_id: projectId, case_id: id, confirm_name: confirmName }),
  batchDelete: (projectId: string, ids: string[]) =>
    post<{ ok: boolean; affected: number }>("/functional-cases/batch-delete",
      { project_id: projectId, case_ids: ids }),
  batchRestore: (projectId: string, ids: string[]) =>
    post<{ ok: boolean; affected: number }>("/functional-cases/batch-restore",
      { project_id: projectId, case_ids: ids }),
  /** D232：批量编辑优先级/模块；affect = 真正改到的「本项目正常用例」行数。 */
  batchUpdate: (body: CaseBatchUpdateBody) =>
    post<{ ok: boolean; affected: number }>("/functional-cases/batch-update", body),
  /** D233：批量复制（副本进本项目；回执带新用例 id，供列表定位/刷新）。 */
  batchCopy: (body: CaseBatchCopyBody) =>
    post<CaseBatchCopyOut>("/functional-cases/batch-copy", body),
  /** D236：统计（只读；total 吃当前视图，recycled_total 永远是回收站行数）。 */
  stats: (body: { project_id: string; group_by?: CaseStatsGroupBy; recycled?: boolean }) =>
    post<CaseStats>("/functional-cases/stats", body),
  batchPurge: (projectId: string, ids: string[]) =>
    post<{ ok: boolean; affected: number }>("/functional-cases/batch-purge",
      { project_id: projectId, case_ids: ids }),

  comments: (projectId: string, caseId: string) =>
    get<{ items: CaseComment[]; total: number }>("/functional-cases/" + enc(caseId) + "/comments"
      + qs({ project_id: projectId })),
  addComment: (projectId: string, caseId: string, content: string, parentId?: string | null) =>
    post<CaseComment>("/functional-cases/" + enc(caseId) + "/comments",
      { project_id: projectId, case_id: caseId, content, parent_id: parentId ?? null }),
  updateComment: (projectId: string, commentId: string, content: string) =>
    patch<CaseComment>("/functional-case-comments/" + enc(commentId),
      { project_id: projectId, comment_id: commentId, content }),
  deleteComment: (projectId: string, commentId: string) =>
    post<{ ok: boolean }>("/functional-case-comments/" + enc(commentId) + "/delete",
      { project_id: projectId, comment_id: commentId }),

  relations: (projectId: string, caseId: string) =>
    get<CaseRelations>("/functional-cases/" + enc(caseId) + "/relations"
      + qs({ project_id: projectId })),
  addRelation: (projectId: string, caseId: string, targetCaseId: string,
                relationType: "predecessor" | "successor") =>
    post<CaseRelationItem>("/functional-cases/" + enc(caseId) + "/relations",
      { project_id: projectId, case_id: caseId, target_case_id: targetCaseId,
        relation_type: relationType }),
  deleteRelation: (projectId: string, relationId: string) =>
    post<{ ok: boolean }>("/functional-case-relations/" + enc(relationId) + "/delete",
      { project_id: projectId, relation_id: relationId }),

  // ── D205：Excel 模板 / 导入 / 导出 ───────────────────────────────────────
  /** 模板下载（当前/默认模板的自定义字段列 + 填写说明页）。 */
  importTemplate: (projectId: string, templateId?: string) =>
    getBlob("/functional-cases/import-template" + qs({ project_id: projectId, template_id: templateId })),
  /** 导出（只读）。D235 起筛选轴与列表对齐：filter / followed_by_me / ids。 */
  exportCases: (q: { project_id: string; module_id?: string; keyword?: string;
    priority?: string; template_id?: string; include_recycled?: boolean;
    filter?: string; followed_by_me?: boolean; ids?: string }) =>
    getBlob("/functional-cases/export" + qs(q)),
  /** 导入（multipart，全有或全无；失败 details.errors 带 Excel 行号）。 */
  importCases: (form: FormData) =>
    postForm<{ created: number; rows: number }>("/functional-cases/import", form),
};

// ── D268 用例脑图（C11）─────────────────────────────────────────────────
export type MinderCase = { id: string; num: number; name: string; priority: string };

export type MinderNode = {
  id: string;
  kind: "module" | "note";
  name: string;
  parent_id: string | null;
  sort: number;
  case_count: number;
  cases: MinderCase[];
  children: MinderNode[];
};

export type MinderTree = {
  project_id: string;
  nodes: MinderNode[];
  unfiled_cases: MinderCase[];
  total_cases: number;
};

/** 后端契约见 `functional/services.py::functional_minder_*`：
 *  树 = 模块 + 便签 + 用例叶；用例只挂模块；便签可挂模块/便签。 */
export const functionalMinderApi = {
  tree: (projectId: string) => get<MinderTree>("/functional-minder" + qs({ project_id: projectId })),
  createNote: (projectId: string, name: string, parentId: string | null = null) =>
    post<MinderNode>("/functional-minder/notes", { project_id: projectId, parent_id: parentId, name }),
  updateNote: (noteId: string, body: { project_id: string; name?: string;
                                        parent_id?: string | null; parent_set?: boolean }) =>
    patch<MinderNode>("/functional-minder/notes/" + enc(noteId), body),
  deleteNote: (projectId: string, noteId: string) =>
    post<{ ok: boolean }>("/functional-minder/notes/" + enc(noteId) + "/delete",
      { project_id: projectId, note_id: noteId }),
};
