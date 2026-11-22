// 会话页右栏「产出/进度」的数据层（2026-11-21 改版）。纯函数，不碰 React、不发请求。
//
// 数据源只有事件流本身：后端 TOOL_RESULT.payload.produced 一直在发
// （runner.py:129 → dispatcher.py:94，形状见 api_test/schemas.py 的 ProducedRef），
// 此前前端零消费方。这里补上那个消费方——**只列事件真说过的资源**，
// 拿不到的一律不画（截图那种「+2 -6 文件改动」「来源列表」本仓库后端不产，
// 照抄就是三个假面板，故整块不做）。
import type { AgentEvent } from "./sse";
import { parseUtc } from "../shared/timefmt";

export interface ProducedRef {
  kind: string;
  id: string;
  name: string;
}

/** 事件流里被动过的资源，按 kind+id 去重、保留首次出现顺序。
 *  同一个资源被 create 后又 update 会出现两条 produced——它们是同一个东西，只列一次。 */
export function producedRefs(events: AgentEvent[]): ProducedRef[] {
  const out: ProducedRef[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "TOOL_RESULT") continue;
    const raw = (ev.payload ?? {}).produced;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const kind = typeof r.kind === "string" ? r.kind : "";
      const id = typeof r.id === "string" ? r.id : "";
      if (!kind || !id) continue; // 认不出是哪个资源 = 不列，不画一条点不动的假行
      const key = kind + ":" + id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, id, name: typeof r.name === "string" && r.name ? r.name : id });
    }
  }
  return out;
}

/**
 * 产出条目 → 站内 hash 路由。**只认这里能真拼出来的**，其余返回 null（画成不可点的文本行）。
 * 后端 produced[].link 不可信：api_definition 给 `/api/definition/{id}`（前端无此路由，
 * 实际落点是 `#/api?def=<id>`），scenario 给 `/scen/{id}`（路由是 `/scene/:id`，少个 e）。
 * 用例/成员同理没有可直达的详情路由——宁可不给链接，不给点了跳错地方的链接。
 */
export function producedHref(kind: string, id: string): string | null {
  if (kind === "api_definition") return "#/api?def=" + encodeURIComponent(id);
  if (kind === "scenario") return "#/scene/" + encodeURIComponent(id);
  if (kind === "data_set") return "#/datasets";
  return null;
}

/** 产出条目的中文类型名；认不出的 kind 原样显示后端给的值，不翻译成「其它」糊过去。 */
const KIND_LABEL: Record<string, string> = {
  api_definition: "接口定义",
  api_case: "接口用例",
  data_set: "数据集",
  scenario: "场景",
  user: "成员",
};

export function producedLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export interface TurnStat {
  toolCalls: number;
  /** 其中失败几次：只数「已经回来的结果」，执行中的那次不算失败也不计成功。 */
  toolFails: number;
  inputTokens: number;
  outputTokens: number;
  /** 最后一条带 ts 的事件；一条都没有 = null（画「—」而不是当前时间）。 */
  lastTs: string | null;
}

/** 进度卡的全部数字都从事件流数出来——没有第二个计数器。 */
export function turnStats(events: AgentEvent[]): TurnStat {
  const s: TurnStat = { toolCalls: 0, toolFails: 0, inputTokens: 0, outputTokens: 0, lastTs: null };
  for (const ev of events) {
    if (ev.ts && parseUtc(ev.ts) !== null) s.lastTs = ev.ts; // 事件按 seq 递增到达，最后一条即最新
    if (ev.type === "TOOL_CALL") s.toolCalls += 1;
    if (ev.type === "TOOL_RESULT" && (ev.payload ?? {}).ok === false) s.toolFails += 1;
    if (ev.type === "USAGE") {
      const p = ev.payload ?? {};
      s.inputTokens += Number(p.input_tokens ?? 0) || 0;
      s.outputTokens += Number(p.output_tokens ?? 0) || 0;
    }
  }
  return s;
}
