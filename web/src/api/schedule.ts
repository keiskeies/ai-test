// 定时任务面（§11.4.17，1E 已交付）：只包场景编辑器「定时绑定」需要的读面 + 改绑 PATCH。
// 手写镜像后端 @service 路由（生成物 schema.d.ts 的 GET 列表响应是 unknown——后端返回标注
// BaseModel 不进 OpenAPI，与 scene.ts / ui.ts 同法手写分页外壳）；行/入参类型直接引
// schema.d.ts（TaskOut / schedule_task_update_body 都已生成，后端字段一变 gen:api 后这里
// 先编译报错，不会静默漂移）。
// 完整的新建/编辑表单（cron 预览、渠道多选）在 pages/schedules.tsx，这里不抄第二份。
import { get, patch } from "./client";
import type { components, operations } from "./schema";
import type { Page } from "./api";

type TaskOut = components["schemas"]["TaskOut"];
type TaskUpdateBody = components["schemas"]["schedule_task_update_body"];
type ListQuery = operations["get_schedule_task_list_api_v1_schedule_tasks_get"]["parameters"]["query"];

const enc = encodeURIComponent;

function qs(o: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

/** GET /schedule-tasks：列项目内定时任务（service.schedule_task_list，enabled/cursor 可选）。 */
export function listTasks(
  q: Pick<ListQuery, "project_id"> & Partial<Omit<ListQuery, "project_id">>,
): Promise<Page<TaskOut>> {
  return get<Page<TaskOut>>("/schedule-tasks?" + qs(q));
}

/**
 * PATCH /schedule-tasks/{task_id}：只动传了的字段——后端 schedule_task_update 逐字段
 * `is not None` 落值（service.py:180-193），subject_id 单改合法，「把已有定时改绑到
 * 本场景」是后端白纸黑字支持的语义。env_id 传 null = 「未改动」（TaskUpdateIn 把 null
 * 当缺省，schedules.tsx 抽屉里有同款记账）。
 */
export function rebindTask(taskId: string, body: TaskUpdateBody): Promise<TaskOut> {
  return patch<TaskOut>("/schedule-tasks/" + enc(taskId), body);
}
