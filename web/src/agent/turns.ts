// 工具调用的「一行一条」合流（2026-11-21 会话流改版）。
// 事件流里一次工具是两条信封（TOOL_CALL + TOOL_RESULT），界面上只该是一行 chip：
// 结果没回来时那行显示「执行中」，回来了就地补上成败——与 cards/fold.ts 的
// 「原地更新」同一口径（事件流是真相，折叠只发生在渲染侧，applyEvent 不动）。
//
// 配对键 = payload.tool_call_id（runner 两侧都写，见 backend/app/modules/agent/runner.py:105/:129）。
// 没有 tool_call_id 的旧信封/测试信封：按「该工具最近一次尚未配对的调用」配对——
// 同一工具连续两次调用而无 id 时无法分辨归属，宁可退回两条独立渲染，也不把结果
// 安到错误的调用上（那会把成功/失败贴到别一次调用的 chip 上）。
import type { AgentEvent } from "./sse";
import { isPlanListResult } from "./cards/fold";

/** 卡片结果不进 chip：它有自己的整幅渲染（ui==="card" 分支），合进一行就把卡片吞了。 */
function isCardResult(ev: AgentEvent): boolean {
  return ev.type === "TOOL_RESULT" && (ev.payload ?? {}).ui === "card";
}

/** 该 TOOL_RESULT 能否与某次 TOOL_CALL 配对。卡片结果与计划列表合流结果都不配。 */
function isPlainResult(ev: AgentEvent): boolean {
  return ev.type === "TOOL_RESULT" && !isCardResult(ev) && !isPlanListResult(ev);
}

export interface ToolPair {
  call: AgentEvent;
  result?: AgentEvent;
}

/**
 * 返回「渲染序列」：TOOL_CALL 携带配对到的 result（就地一行），被吃掉的那条
 * TOOL_RESULT 不出现在结果里；配不上对的 TOOL_RESULT 原样保留（自己画返回块）。
 * 顺序 = 调用出现的顺序，其余事件原样透传。
 */
export function foldToolCalls(events: AgentEvent[]): Array<{ ev: AgentEvent; result?: AgentEvent }> {
  // 第一遍：按 tool_call_id 收结果；无 id 的结果按「工具名 → 队列」备用。
  const byId = new Map<string, AgentEvent>();
  const byName = new Map<string, AgentEvent[]>();
  for (const ev of events) {
    if (!isPlainResult(ev)) continue;
    const id = ev.payload?.tool_call_id;
    if (typeof id === "string" && id) byId.set(id, ev);
    else {
      const name = String(ev.payload?.tool_name ?? "");
      const q = byName.get(name) ?? [];
      q.push(ev);
      byName.set(name, q);
    }
  }
  const consumed = new Set<number>(); // 被并入 chip 的 result 的 seq
  const out: Array<{ ev: AgentEvent; result?: AgentEvent }> = [];
  for (const ev of events) {
    if (ev.type === "TOOL_CALL") {
      const id = ev.payload?.tool_call_id;
      const name = String(ev.payload?.tool_name ?? "");
      let result: AgentEvent | undefined;
      if (typeof id === "string" && id) {
        result = byId.get(id);
      } else {
        const q = byName.get(name);
        while (q && q.length > 0 && consumed.has(q[0].seq)) q.shift();
        result = q && q.length > 0 ? q[0] : undefined;
      }
      if (result) {
        consumed.add(result.seq);
        out.push({ ev, result });
      } else {
        out.push({ ev });
      }
      continue;
    }
    if (consumed.has(ev.seq)) continue;
    out.push({ ev });
  }
  return out;
}
