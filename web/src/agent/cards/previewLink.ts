// 候选卡 → 只读预览页的接缝（1F T4，D33 假设 b）。
// 独立模块的意义：ScenarioPlansCard 只 import 这个纯文件——绝不 import 预览页本身，
// 否则 @xyflow/monaco 会被拽进 bench 的渲染面（app.tsx 懒加载注释写明的同款坑）。
// payload 走 sessionStorage 不走查询串：graph 超 2k 字符 URL 会炸（计划 T4 原文）。

/** sessionStorage 键前缀；完整键 = 前缀 + ":" + run_id + ":" + plan_index（刷新可重进）。 */
export const PREVIEW_KEY_PREFIX = "tp-scene-preview";

export function previewStorageKey(runId: string, planIndex: number): string {
  return PREVIEW_KEY_PREFIX + ":" + runId + ":" + planIndex;
}

/** hash 路由下的新 Tab 相对地址：'#/…' 相对当前 URL 解析，查询串挂在 fragment 里。 */
export function previewPageUrl(key: string): string {
  return "#/scene-preview?k=" + encodeURIComponent(key);
}

/** 存进 sessionStorage 的信封：预览页要显示方案名，光有 graph 不够。 */
export interface PreviewEntry {
  plan_name: string;
  graph: unknown;
}

/** 坏键的三态必须可分辨（各自一个人话文案），「没存过」和「存坏了」不是一回事。 */
export type PreviewRead =
  | { kind: "ok"; planName: string; graph: Record<string, unknown> }
  | { kind: "missing" }   // 键不存在 / 未登录直达 / 会话过期被清
  | { kind: "corrupt" }   // 存的东西 JSON 解析不出来
  | { kind: "bad_graph" }; // 解析出来了但 graph 不是 §7.4 形状（没有 nodes 数组）

/** 读 + 校验：三种坏形状各归一类，全部返回可读空态而非抛出（页面不许白屏）。 */
export function readPreviewEntry(k: string | null | undefined): PreviewRead {
  if (!k) return { kind: "missing" };
  // 隐私模式等 sessionStorage 不可用的环境读键会直接抛 → 与「键不存在」同口径的人话空态
  const raw = (() => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  })();
  if (raw === null) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "corrupt" };
  const entry = parsed as Partial<PreviewEntry>;
  const g = entry.graph;
  if (!g || typeof g !== "object" || Array.isArray(g) || !Array.isArray((g as { nodes?: unknown }).nodes)) {
    return { kind: "bad_graph" };
  }
  return { kind: "ok", planName: String(entry.plan_name ?? "未命名方案"), graph: g as Record<string, unknown> };
}

/** 候选卡的 graph 是否可预览：只认 §7.4 形状（对象 + nodes 数组），形状不对按钮就不开。 */
export function previewableGraph(graph: unknown): graph is Record<string, unknown> {
  return !!graph && typeof graph === "object" && !Array.isArray(graph)
    && Array.isArray((graph as { nodes?: unknown }).nodes);
}
