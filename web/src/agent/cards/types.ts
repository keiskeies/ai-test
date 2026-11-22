// 卡片协议类型（§12.2 :1570 / 1F 计划 T2+T3）。
// kind 值域与后端 `backend/app/agent/metatools/card_tools.py` 的 CARD_KINDS 常量**逐字对齐**
// （§12.2 值域，两边各有一条单测钉枚举相等——后端那条在 T2 落地时补）。
export const CARD_KINDS = ["scenario_plans", "report_summary", "device_status", "generic"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** 信封位置：TOOL_RESULT.payload = {tool_name, ok, ui, content:{card:CardPayload}}；
 *  ui ∈ {null,"card","approval","diff"}（§12.2），本层只认 "card"。 */
export interface CardPayload extends Record<string, unknown> {
  kind: CardKind;
}

// ---------- 各 kind 的具体形状（按 T2 计划的返回体逐字段抄写） ----------

/** propose_scenario_plans → {kind:"scenario_plans", plans:[...]}，payload 自包含（零二次查询）。 */
export interface ScenarioPlan {
  name: string;
  /** 覆盖意图 */
  intent: string;
  /** 步骤预览（逐行展示） */
  est_steps: string[];
  risks?: string[];
  env_hint?: string;
  /** §7.4 场景图形状——T3 前端不消费，T4 画布预览才用 */
  graph?: unknown;
}
export interface ScenarioPlansPayload extends CardPayload {
  kind: "scenario_plans";
  plans: ScenarioPlan[];
}

/** ask_user → {kind:"generic", form:"question", ...}（D32：不挂起，回写一条用户消息即答完）。 */
export interface QuestionPayload extends CardPayload {
  kind: "generic";
  form: "question";
  question: string;
  options?: string[];
}

/** propose_plan / update_plan_item → 计划列表卡（§11.4.33）。
 *  state 值域 = pending→doing→done/skipped；「最新结果覆盖渲染」＝update_plan_item 原地更新口径。 */
export type PlanItemState = "pending" | "doing" | "done" | "skipped";
export interface PlanItem {
  id: string | number;
  text: string;
  state: PlanItemState;
}
export interface PlanListPayload extends CardPayload {
  kind: "generic";
  form: "plan_list";
  items: PlanItem[];
  title?: string;
}

/** suggest_open_page → {kind:"generic", form:"open_page", route, params}（route 后端有白名单门）。 */
export interface OpenPagePayload extends CardPayload {
  kind: "generic";
  form: "open_page";
  route: string;
  params?: Record<string, string | number>;
}

// ---------- generic 的分派键 ----------
// kind==="generic" 时靠 form 二级分派（question / plan_list / open_page），
// 注册表键统一为 kind 或 "generic:<form>"——分派只走协议键，绝不按 tool_name 硬编码（:607 通用件）。
export function cardRegistryKey(p: CardPayload): string {
  const form = typeof p.form === "string" && p.form !== "" ? p.form : null;
  return p.kind === "generic" && form ? "generic:" + form : p.kind;
}

/** 运行时窄化：SSE payload 是 Record<string,unknown>，进协议层前必须过这道闸。 */
export function isCardPayload(x: unknown): x is CardPayload {
  return (
    typeof x === "object" && x !== null &&
    (CARD_KINDS as readonly string[]).includes(String((x as Record<string, unknown>).kind))
  );
}
