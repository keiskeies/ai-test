// turns.ts 的配对口径。这里钉的是「什么并进一行、什么绝不并」——
// 合错了会把一次调用的成败贴到另一次调用上，比多画一行严重得多。
import { describe, expect, it } from "vitest";
import { foldToolCalls } from "./turns";
import type { AgentEvent } from "./sse";

const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): AgentEvent =>
  ({ seq, ts: "2026-11-21T10:00:00+08:00", type, payload });

const call = (seq: number, name: string, id?: string) =>
  ev(seq, "TOOL_CALL", { tool_name: name, args: { q: seq }, ...(id ? { tool_call_id: id } : {}) });
const result = (seq: number, name: string, id?: string, ok = true) =>
  ev(seq, "TOOL_RESULT", { tool_name: name, ok, ...(id ? { tool_call_id: id } : {}), content: { items: [] } });

describe("foldToolCalls", () => {
  it("带 tool_call_id 的调用与结果合成一条，结果信封不再单独出现", () => {
    const out = foldToolCalls([call(1, "api_list", "c1"), result(2, "api_list", "c1")]);
    expect(out).toHaveLength(1);
    expect(out[0].ev.seq).toBe(1);
    expect(out[0].result?.seq).toBe(2);
  });

  it("结果还没回来 → 只有调用，result 为 undefined（chip 停在执行中）", () => {
    const out = foldToolCalls([call(1, "api_list", "c1")]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBeUndefined();
  });

  it("无 id 时按同名 FIFO 配对；两次同名调用各吃各的结果，不串", () => {
    const out = foldToolCalls([call(1, "api_list"), call(2, "api_list"), result(3, "api_list"), result(4, "api_list")]);
    const tools = out.filter((x) => x.ev.type === "TOOL_CALL");
    expect(tools).toHaveLength(2);
    expect(tools[0].result?.seq).toBe(3);
    expect(tools[1].result?.seq).toBe(4);
    expect(out).toHaveLength(2); // 两条结果都被吃掉
  });

  it("无 id 且调用数多于结果数：多出来的那次调用留在执行中，不拿别人的结果凑", () => {
    const out = foldToolCalls([call(1, "api_list"), call(2, "api_list"), result(3, "api_list")]);
    const tools = out.filter((x) => x.ev.type === "TOOL_CALL");
    expect(tools[0].result?.seq).toBe(3);
    expect(tools[1].result).toBeUndefined();
  });

  it("配不上对的结果原样保留（历史截断/单测直挂时仍要能看返回）", () => {
    const out = foldToolCalls([result(9, "api_list")]);
    expect(out).toHaveLength(1);
    expect(out[0].ev.type).toBe("TOOL_RESULT");
    expect(out[0].result).toBeUndefined();
  });

  it("卡片结果（ui=card）绝不并进 chip：它有自己的整幅渲染", () => {
    const card = ev(2, "TOOL_RESULT", {
      tool_name: "ask_user", tool_call_id: "c1", ok: true, ui: "card",
      content: { card: { kind: "generic", form: "question", question: "部到哪？" } },
    });
    const out = foldToolCalls([call(1, "ask_user", "c1"), card]);
    expect(out).toHaveLength(2);
    expect(out[0].result).toBeUndefined();
    expect(out[1].ev.seq).toBe(2);
  });

  it("其余事件原样透传且顺序不变（USER/TEXT 不被工具合流牵连）", () => {
    const out = foldToolCalls([
      ev(1, "USER", { text: "帮我看看" }),
      call(2, "api_list", "c1"),
      result(3, "api_list", "c1"),
      ev(4, "TEXT", { text: "查到了" }),
    ]);
    expect(out.map((x) => x.ev.seq)).toEqual([1, 2, 4]);
  });

  it("RUN_END 透传（它是状态信号，渲染侧自己 return null）", () => {
    const out = foldToolCalls([ev(1, "RUN_END", { status: "DONE" })]);
    expect(out).toHaveLength(1);
  });
});
