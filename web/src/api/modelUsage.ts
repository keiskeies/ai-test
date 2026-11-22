// 模型用量统计（D39 · §6.8 一期「按用户/按会话的模型用量统计」）：
// GET /model-usage —— 平台级端点（一期模型全池共享，无项目作用域；project_id 只是
// 过滤参数）。出参类型手写本地声明：@service 的 BaseModel 返回不挂 response_model，
// OpenAPI 生成物里没有形状（workbench.tsx 顶部注释同款口径，R129 混合类型线）。
// 字段以后端 app/modules/workbench/model_usage.py 的 ModelUsageOut 为准。
import { get } from "./client";

export interface UserUsageRow {
  user_id: string;
  user_name: string;
  sessions: number;
  turns: number;
  /** null = 窗口内没有任何可聚合的 usage 回执 → 画「—」，不是 0（不冒充已统计）。 */
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

export interface SessionUsageRow {
  session_id: string;
  title: string;
  user_id: string;
  user_name: string;
  project_id: string;
  model_id: string | null;
  model_name: string | null;
  turns: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

export interface ModelUsageRow {
  model_id: string;
  model_name: string;
  sessions: number;
  /** 事件流里真有 usage 回执的会话数——模型卡「用量 N 会话」的数据源。 */
  usage_sessions: number;
  turns: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

export interface ModelUsageOut {
  scope: { project_id: null };
  filters: { project_id: string | null; model_id: string | null; days: number | null };
  totals: {
    sessions: number; usage_sessions: number; turns: number;
    input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  };
  users: UserUsageRow[];
  sessions: SessionUsageRow[];
  models: ModelUsageRow[];
}

export interface ModelUsageQuery {
  /** 近 N 个 UTC 日历日（含今天）；缺省 = 全量。 */
  days?: number;
  modelId?: string;
  projectId?: string;
}

export const modelUsageApi = {
  /** 三组维度恒在响应内（users/sessions/models），一次请求全给——切维度是纯渲染事。
   * 出参做形状归一：缺组按空数组（后端契约里三组恒在；归一只防「响应根本不是 ModelUsageOut」
   * 这种传输层事故把渲染层炸穿——CommandPalette 防御式读取同款口径，不是给后端的
   * 真缺组兜底：真缺组由 test_model_usage 的服务端用例负责红。 */
  stats: async (q: ModelUsageQuery = {}): Promise<ModelUsageOut> => {
    const p = new URLSearchParams();
    if (q.days != null) p.set("days", String(q.days));
    if (q.modelId) p.set("model_id", q.modelId);
    if (q.projectId) p.set("project_id", q.projectId);
    const qs = p.toString();
    const raw = await get<Partial<ModelUsageOut>>("/model-usage" + (qs ? "?" + qs : ""), { silent: true });
    return {
      scope: raw.scope ?? { project_id: null },
      filters: raw.filters ?? { project_id: null, model_id: null, days: null },
      totals: raw.totals ?? { sessions: 0, usage_sessions: 0, turns: 0,
        input_tokens: null, output_tokens: null, total_tokens: null },
      users: raw.users ?? [],
      sessions: raw.sessions ?? [],
      models: raw.models ?? [],
    };
  },
  /** 模型卡按 id 查行：全池每枚模型恒有一行，查不到 = 用量接口没取到（调用方画「—」）。
   * 纯函数导出给单测直钉。 */
  byModel: (out: ModelUsageOut, modelId: string): ModelUsageRow | undefined =>
    out.models.find((m) => m.model_id === modelId),
};
