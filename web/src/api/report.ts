// 报告中心查询面（§11.4.15/§11.4.16）：列表 + 详情 + 单步明细。
// 出参手写的原因与 api.ts 相同：后端 report_* 返回类型标注为 BaseModel，
// OpenAPI 里 200 响应是 unknown（schema.d.ts 提不出行类型），入参 query 仍引生成物。
import { get } from "./client";
import type { operations } from "./schema";
import type { Page } from "./api";

type ReportListQuery = operations["get_report_list_api_v1_reports_get"]["parameters"]["query"];
type StepDetailQuery = operations["get_report_step_detail_api_v1_reports__run_id__steps_get"]["parameters"]["query"];

const enc = encodeURIComponent;

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

/** 列表行（ReportListItemOut）：pass_rate = pass/(total-skip)，分母 ≤0 时为 null（画「-」）。 */
export interface ReportRow {
  id: string;
  subject_name: string;
  subject_type: string;
  trigger: string;
  env_name: string | null;
  created_by_name: string | null;
  status: string;
  stats: Record<string, unknown> | null;
  pass_rate: number | null;
  elapsed_ms: number | null;
  started_at: string | null;
}

/** 步骤摘要（ReportStepSummary）：数据集步折成 1 节点，pass_rows/total_rows 供「3/10」展示。 */
export interface ReportStepSummary {
  step_key: string;
  kind: string;
  status: string;
  parent_step_key: string | null;
  subject_name: string | null;
  elapsed_ms: number | null;
  attempts: number;
  row_no: number;
  pass_rows: number | null;
  total_rows: number | null;
}

/** 详情（ReportGetOut）：summary_graph/steps/artifacts 全部来自执行时快照（§14 自包含）。 */
export interface ReportDetail {
  id: string;
  subject_name: string;
  subject_type: string;
  trigger: string;
  env_id: string | null;
  env_name: string | null;
  created_by_name: string | null;
  status: string;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  stats: Record<string, unknown> | null;
  pass_rate: number | null;
  summary_graph: Record<string, unknown> | null;
  steps: ReportStepSummary[];
  artifacts: Array<{
    step_key: string | null;
    kind: string;
    ref: string;
    bytes: number | null;
    created_at: string | null;
  }>;
}

/** 单步明细（ReportStepDetailOut）：detail = {request, response, assertions, logs, script?}。 */
export interface ReportStepDetail {
  step_key: string;
  kind: string;
  status: string;
  row_no: number;
  parent_step_key: string | null;
  subject_name: string | null;
  elapsed_ms: number | null;
  attempts: number;
  vars_snapshot: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
}

// D215：filter（高级搜索条件组 JSON 串）后端已加进 ReportListIn，而 schema.d.ts 要等
// gen:api 重画（会自起后端抢 8321，与 D47-b 同笔账）。照 scene.ts 的手写镜像约定在派生
// 类型上显式补键，字段名与后端 `ReportListIn.filter` 逐字一致，下次 gen 合流不漂移。
export type ReportListFilter = Pick<ReportListQuery, "project_id"> & Partial<Omit<ReportListQuery, "project_id">>
  & { filter?: string };

export const reportApi = {
  /** 报告列表：默认不含 trigger=debug（Review Focus 11：报告是结论，调试看运行记录页）。 */
  list: (f: ReportListFilter) =>
    get<Page<ReportRow>>("/reports?" + qs(f), { silent: true }),

  /** 报告详情：概要 + summary_graph 快照 + 步骤摘要 + 制品（资产删了也完整可读）。 */
  get: (projectId: string, runId: string) =>
    get<ReportDetail>("/reports/" + enc(runId) + "?project_id=" + enc(projectId)),

  /** 单步明细：row_no=0 为节点整体行；数据集步按行取明细传具体 row_no。 */
  stepDetail: (q: Pick<StepDetailQuery, "project_id" | "step_key"> & { run_id: string; row_no?: number }) => {
    const { run_id, ...rest } = q;
    return get<ReportStepDetail>("/reports/" + enc(run_id) + "/steps?" + qs(rest));
  },
};
