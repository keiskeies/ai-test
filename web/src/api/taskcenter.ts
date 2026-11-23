// 任务中心前端镜像（D196）。后端 app/modules/taskcenter/services.py 为准。
import { get, post } from "./client";

export type TaskSummary = {
  total: number;
  queued: number;
  running: number;
  passed: number;
  failed: number;
  error: number;
  cancelled: number;
  active: number;
  pass_rate: number;
  avg_elapsed_ms: number | null;
};

export type TaskRow = {
  id: string;
  project_id: string;
  subject_type: string;
  subject_id: string;
  subject_name: string;
  env_name: string | null;
  trigger: string;
  status: string;
  elapsed_ms: number | null;
  error: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested: boolean;
  queue_position: number | null;
  can_stop: boolean;
  can_rerun: boolean;
};

export type TaskDetail = TaskRow & {
  stats: Record<string, unknown> | null;
  step_counts: Record<string, number>;
};

export type TaskQueue = { available: boolean; queue_length: number; items: TaskRow[] };
export type TaskPage = { items: TaskRow[]; total: number | null };

/** D237：批量停止的逐条分账（stopped + skipped + failed = 去重后的请求条数）。 */
export type TaskBatchStopOut = {
  ok: boolean;
  stopped: number;
  skipped: number;
  stopped_ids: string[];
  skipped_ids: string[];
  failed: Array<{ run_id: string; code: string; message: string }>;
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

export const taskCenterApi = {
  summary: (projectId: string) =>
    get<TaskSummary>("/task-center/summary" + qs({ project_id: projectId })),
  list: (q: { project_id: string; state?: "active" | "finished"; subject_type?: string;
              trigger?: string; keyword?: string; filter?: string;
              current: number; size: number }) =>
    get<TaskPage>("/task-center/tasks" + qs(q)),
  queue: (projectId: string) =>
    get<TaskQueue>("/task-center/queue" + qs({ project_id: projectId })),
  detail: (projectId: string, runId: string) =>
    get<TaskDetail>("/task-center/tasks/" + enc(runId) + qs({ project_id: projectId })),
  stop: (projectId: string, runId: string) =>
    post<{ ok: boolean; status: string }>("/task-center/tasks/" + enc(runId) + "/stop",
      { project_id: projectId, run_id: runId }),
  /** D237：批量停止（缺 id 整批 404；已结束/取消中的进 skipped，不逐条报错）。 */
  batchStop: (projectId: string, runIds: string[]) =>
    post<TaskBatchStopOut>("/task-center/tasks/batch-stop",
      { project_id: projectId, run_ids: runIds }),
  rerun: (projectId: string, runId: string) =>
    post<{ run_id: string; status: string }>("/task-center/tasks/" + enc(runId) + "/rerun",
      { project_id: projectId, run_id: runId }),
};

export const TASK_STATUS_META: Record<string, { label: string; color: string }> = {
  queued: { label: "排队中", color: "default" },
  running: { label: "运行中", color: "processing" },
  passed: { label: "通过", color: "success" },
  failed: { label: "失败", color: "error" },
  error: { label: "错误", color: "warning" },
  cancelled: { label: "已取消", color: "default" },
};

export const SUBJECT_LABELS: Record<string, string> = {
  scenario: "场景",
  api_case: "接口用例",
  api_definition: "接口",
  ui_case: "UI 用例",
  adb_case: "ADB 用例",
};

export const TRIGGER_LABELS: Record<string, string> = {
  manual: "手动",
  debug: "调试",
  schedule: "定时",
  agent: "Pilot",
  webhook: "Webhook",
};
