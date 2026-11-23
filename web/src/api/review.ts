// 用例评审前端镜像（D194）。后端 app/modules/review/services.py 为准。
import { get, patch, post } from "./client";

export type ReviewModuleNode = {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  status: string;
  review_count: number;
  children: ReviewModuleNode[];
};

export type ReviewModuleTree = { tree: ReviewModuleNode[]; recycled: ReviewModuleNode[] };

export type Reviewer = { user_id: string; name: string | null };

export type ReviewRow = {
  id: string;
  num: number;
  project_id: string;
  module_id: string | null;
  name: string;
  description: string | null;
  pass_rule: "single" | "multiple";
  start_at: string | null;
  end_at: string | null;
  started: boolean;
  status: "not_started" | "in_review" | "completed";
  case_count: number;
  pass_count: number;
  resolved_count: number;
  pass_rate: number;
  reviewer_count: number;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type ReviewPage = { items: ReviewRow[]; total: number | null };

export type ReviewCaseRow = {
  id: string;
  review_id: string;
  case_id: string;
  case_name: string | null;
  case_exists: boolean;
  result: "pending" | "pass" | "fail";
  re_review: boolean;
  reviewers: Reviewer[];
  updated_at: string | null;
};

export type ReviewCasePage = { items: ReviewCaseRow[]; total: number | null };

export type ReviewResultRow = {
  id: string;
  user_id: string;
  user_name: string | null;
  action: "suggestion" | "pass" | "fail";
  comment: string | null;
  active: boolean;
  created_at: string | null;
};

export type CaseReviewLink = {
  review_id: string;
  review_num: number;
  review_name: string;
  status: string;
  result: string;
  re_review: boolean;
  case_count: number;
  pass_rate: number;
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

export const reviewApi = {
  tree: (projectId: string, includeRecycled = false) =>
    get<ReviewModuleTree>("/case-review-modules/tree" + qs({
      project_id: projectId, include_recycled: includeRecycled || undefined })),
  createModule: (body: { project_id: string; parent_id?: string | null; name: string; sort?: number }) =>
    post<ReviewModuleNode>("/case-review-modules", body),
  updateModule: (id: string, body: { project_id: string; name?: string; sort?: number;
                                      parent_id?: string | null; parent_set?: boolean }) =>
    patch<ReviewModuleNode>("/case-review-modules/" + enc(id), body),
  deleteModule: (projectId: string, id: string) =>
    post<{ ok: boolean }>("/case-review-modules/" + enc(id) + "/delete",
      { project_id: projectId, module_id: id }),
  restoreModule: (projectId: string, id: string) =>
    post<ReviewModuleNode>("/case-review-modules/" + enc(id) + "/restore",
      { project_id: projectId, module_id: id }),
  purgeModule: (projectId: string, id: string, confirmName: string) =>
    post<{ ok: boolean; purged_modules: number }>("/case-review-modules/" + enc(id) + "/purge",
      { project_id: projectId, module_id: id, confirm_name: confirmName }),

  list: (q: { project_id: string; module_id?: string; unfiled_only?: boolean; keyword?: string;
              status?: string; created_by_me?: boolean; reviewing_me?: boolean; my_todo?: boolean;
              /** D221：高级搜索条件（JSON 串，形状见 backend shared/filter_registry） */
              filter?: string;
              current: number; size: number }) =>
    get<ReviewPage>("/case-reviews" + qs(q)),
  create: (body: { project_id: string; module_id?: string | null; name: string; description?: string | null;
                   pass_rule?: string; start_at?: string | null; end_at?: string | null;
                   case_ids?: string[]; reviewer_ids?: string[] }) =>
    post<ReviewRow>("/case-reviews", body),
  get: (projectId: string, id: string) =>
    get<ReviewRow>("/case-reviews/" + enc(id) + qs({ project_id: projectId })),
  update: (id: string, body: { project_id: string; name?: string; description?: string | null;
                               module_id?: string | null; module_set?: boolean;
                               start_at?: string | null; start_at_set?: boolean;
                               end_at?: string | null; end_at_set?: boolean }) =>
    patch<ReviewRow>("/case-reviews/" + enc(id), body),
  remove: (projectId: string, id: string, confirmName: string) =>
    post<{ ok: boolean }>("/case-reviews/" + enc(id) + "/delete",
      { project_id: projectId, review_id: id, confirm_name: confirmName }),

  cases: (q: { project_id: string; review_id: string; result?: string; reviewer_id?: string;
               todo_only?: boolean; keyword?: string; current: number; size: number }) =>
    get<ReviewCasePage>("/case-reviews/" + enc(q.review_id) + "/cases" + qs({
      project_id: q.project_id, result: q.result, reviewer_id: q.reviewer_id,
      todo_only: q.todo_only || undefined, keyword: q.keyword, current: q.current, size: q.size })),
  associate: (projectId: string, reviewId: string, caseIds: string[], reviewerIds?: string[]) =>
    post<{ created: number; skipped: number }>("/case-reviews/" + enc(reviewId) + "/cases",
      { project_id: projectId, review_id: reviewId, case_ids: caseIds,
        ...(reviewerIds ? { reviewer_ids: reviewerIds } : {}) }),
  disassociate: (projectId: string, reviewId: string, caseId: string) =>
    post<{ ok: boolean }>("/case-reviews/" + enc(reviewId) + "/cases/" + enc(caseId) + "/delete",
      { project_id: projectId, review_id: reviewId, case_id: caseId }),
  setReviewers: (projectId: string, reviewId: string, caseIds: string[], reviewerIds: string[],
                 mode: "replace" | "append" = "replace") =>
    post<{ affected: number }>("/case-reviews/" + enc(reviewId) + "/cases/reviewers",
      { project_id: projectId, review_id: reviewId, case_ids: caseIds,
        reviewer_ids: reviewerIds, mode }),
  submit: (projectId: string, reviewId: string, caseId: string,
           action: "suggestion" | "pass" | "fail", comment?: string) =>
    post<ReviewCaseRow>("/case-reviews/" + enc(reviewId) + "/cases/" + enc(caseId) + "/results",
      { project_id: projectId, review_id: reviewId, case_id: caseId, action, comment }),
  batchSubmit: (projectId: string, reviewId: string, caseIds: string[],
                action: "suggestion" | "pass" | "fail", comment?: string) =>
    post<{ affected: number; skipped: string[] }>("/case-reviews/" + enc(reviewId) + "/batch-review",
      { project_id: projectId, review_id: reviewId, case_ids: caseIds, action, comment }),
  reReview: (projectId: string, reviewId: string, caseId: string) =>
    post<ReviewCaseRow>("/case-reviews/" + enc(reviewId) + "/cases/" + enc(caseId) + "/re-review",
      { project_id: projectId, review_id: reviewId, case_id: caseId }),
  batchReReview: (projectId: string, reviewId: string, caseIds: string[]) =>
    post<{ affected: number; skipped: string[] }>("/case-reviews/" + enc(reviewId) + "/batch-re-review",
      { project_id: projectId, review_id: reviewId, case_ids: caseIds }),
  history: (projectId: string, reviewId: string, caseId: string) =>
    get<{ items: ReviewResultRow[] }>("/case-reviews/" + enc(reviewId) + "/cases/" + enc(caseId)
      + "/results" + qs({ project_id: projectId })),
  caseReviews: (projectId: string, caseId: string) =>
    get<{ items: CaseReviewLink[] }>("/functional-cases/" + enc(caseId) + "/reviews"
      + qs({ project_id: projectId })),
};

export const REVIEW_STATUS_META: Record<string, { label: string; color: string }> = {
  not_started: { label: "未开始", color: "default" },
  in_review: { label: "评审中", color: "processing" },
  completed: { label: "已完成", color: "success" },
};

export const RESULT_META: Record<string, { label: string; color: string }> = {
  pending: { label: "待评审", color: "default" },
  pass: { label: "通过", color: "success" },
  fail: { label: "不通过", color: "error" },
};

export const ACTION_LABEL: Record<string, string> = {
  suggestion: "建议",
  pass: "通过",
  fail: "不通过",
};
