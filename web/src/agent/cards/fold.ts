// 计划列表的「原地更新」合流（§11.4.33：propose_plan 建列表、update_plan_item 推进状态，
// 事件流里是多条 TOOL_RESULT，界面上只该有一份活文档）。
// 口径：所有 generic/plan_list 卡片的 TOOL_RESULT 里，**最新一条覆盖此前所有**——
// 同名工具（update_plan_item 连续推进）要覆盖，propose_plan→update_plan_item 换名也要覆盖，
// 因为画的始终是同一份计划。其余事件原样透传，顺序不变。
import type { AgentEvent } from "../sse";
import { cardRegistryKey, isCardPayload } from "./types";

export function isPlanListResult(ev: AgentEvent): boolean {
  if (ev.type !== "TOOL_RESULT") return false;
  const p = ev.payload ?? {};
  if (p.ui !== "card" || p.ok === false) return false;
  const card = (p.content as Record<string, unknown> | undefined)?.card;
  return isCardPayload(card) && cardRegistryKey(card) === "generic:plan_list";
}

export function foldPlanListCards(events: AgentEvent[]): AgentEvent[] {
  let lastPlanSeq = -1;
  for (const ev of events) if (isPlanListResult(ev)) lastPlanSeq = ev.seq;
  return events.filter((ev) => !isPlanListResult(ev) || ev.seq === lastPlanSeq);
}
