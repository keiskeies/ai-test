// sidepanel.ts：右栏两个读数的取数口径。核心纪律是「事件没说的一律不编」——
// 产出为空就说为空，没有 ts 就别拿当前时间冒充「更新于」。
import { describe, expect, it } from "vitest";
import { producedLabel, producedRefs, producedHref, turnStats } from "./sidepanel";
import type { AgentEvent } from "./sse";

const ev = (seq: number, type: string, payload: Record<string, unknown> = {}, ts: string | null = "2026-11-21T10:00:00+08:00"): AgentEvent =>
  ({ seq, ts, type, payload });

describe("producedRefs", () => {
  it("从 TOOL_RESULT.payload.produced 收资源，kind+id 去重（先出现的胜出）", () => {
    const out = producedRefs([
      ev(1, "TOOL_RESULT", { tool_name: "api_definition_create", ok: true, produced: [{ kind: "api_definition", id: "d1", name: "查询订单" }] }),
      ev(2, "TOOL_RESULT", { tool_name: "api_definition_update", ok: true, produced: [{ kind: "api_definition", id: "d1", name: "查询订单（改名）" }] }),
      ev(3, "TOOL_RESULT", { tool_name: "data_set_create", ok: true, produced: [{ kind: "data_set", id: "s1", name: "订单数据集" }] }),
    ]);
    expect(out).toEqual([
      { kind: "api_definition", id: "d1", name: "查询订单" },
      { kind: "data_set", id: "s1", name: "订单数据集" },
    ]);
  });

  it("缺 kind 或缺 id 的条目不列（认不出是哪个资源 = 不画一条点不动的假行）", () => {
    const out = producedRefs([
      ev(1, "TOOL_RESULT", { ok: true, produced: [{ kind: "api_definition" }, { id: "x" }, { kind: "", id: "" }, null, "字符串"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("没有 produced / produced 不是数组 / 非 TOOL_RESULT 事件：一律零产出", () => {
    expect(producedRefs([ev(1, "TOOL_RESULT", { ok: true, content: {} })])).toEqual([]);
    expect(producedRefs([ev(1, "TOOL_RESULT", { ok: true, produced: "三个" })])).toEqual([]);
    expect(producedRefs([ev(1, "TOOL_CALL", { produced: [{ kind: "user", id: "u1", name: "甲" }] })])).toEqual([]);
  });

  it("name 缺失时退回 id（宁可显示一串 id，也不显示空白行）", () => {
    expect(producedRefs([ev(1, "TOOL_RESULT", { ok: true, produced: [{ kind: "user", id: "u1" }] })]))
      .toEqual([{ kind: "user", id: "u1", name: "u1" }]);
  });
});

describe("producedHref / producedLabel", () => {
  it("只给真存在的路由：接口定义落 ?def=，场景落 /scene/（后端 link 的 /scen/ 拼法是错的）", () => {
    expect(producedHref("api_definition", "d 1")).toBe("#/api?def=d%201");
    expect(producedHref("scenario", "s1")).toBe("#/scene/s1");
    expect(producedHref("data_set", "x1")).toBe("#/datasets");
  });

  it("没有可直达页面的 kind 返回 null（用例/成员/未知 kind 不给假链接）", () => {
    expect(producedHref("api_case", "c1")).toBeNull();
    expect(producedHref("user", "u1")).toBeNull();
    expect(producedHref("widget", "w1")).toBeNull();
  });

  it("认得出的 kind 给中文名，认不出的原样回显后端值（不翻译成「其它」糊过去）", () => {
    expect(producedLabel("api_definition")).toBe("接口定义");
    expect(producedLabel("scenario")).toBe("场景");
    expect(producedLabel("weird_kind")).toBe("weird_kind");
  });
});

describe("turnStats", () => {
  it("调用次数、失败次数、tokens 都从事件流数出来", () => {
    const s = turnStats([
      ev(1, "TOOL_CALL", { tool_name: "a" }),
      ev(2, "TOOL_RESULT", { tool_name: "a", ok: true }),
      ev(3, "TOOL_CALL", { tool_name: "b" }),
      ev(4, "TOOL_RESULT", { tool_name: "b", ok: false }),
      ev(5, "USAGE", { input_tokens: 10, output_tokens: 3 }),
      ev(6, "USAGE", { input_tokens: 5, output_tokens: 2 }),
    ]);
    expect(s).toEqual({ toolCalls: 2, toolFails: 1, inputTokens: 15, outputTokens: 5, lastTs: "2026-11-21T10:00:00+08:00" });
  });

  it("执行中的调用计入次数但不算失败；一条 ts 都没有时 lastTs 为 null（画「—」而不是当前时间）", () => {
    const s = turnStats([ev(1, "TOOL_CALL", { tool_name: "a" }, null)]);
    expect(s.toolCalls).toBe(1);
    expect(s.toolFails).toBe(0);
    expect(s.lastTs).toBeNull();
  });

  it("非法 ts 不参与「更新于」（坏串不许变成读数）", () => {
    expect(turnStats([ev(1, "TEXT", { text: "x" }, "昨天")]).lastTs).toBeNull();
  });

  it("tokens 字段不是数字时按 0 计，不产出 NaN", () => {
    const s = turnStats([ev(1, "USAGE", { input_tokens: "abc", output_tokens: null })]);
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(0);
  });
});
