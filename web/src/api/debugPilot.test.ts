// 蓝图 :1426「调试失败 → 让 Pilot 分析（带响应体）」的发送端纯逻辑。
// 与 adbDevices.test.tsx 的 pilotDraftFor、reportDetail 的 askPilot 同一条 D84 口径：
// 拼稿是纯函数、nav 是注入的，所以「预填不偷发」这一整类断言不需要 Router 就能钉。
// 这里刻意不 mock 任何网络：本模块根本不发请求，能发出请求就是违约。
import { describe, expect, it, vi } from "vitest";

import {
  askPilotAboutDebug, buildDebugPilotDraft, clipMarked, debugFailedForPilot, describeAssertRow,
  PILOT_BODY_CLIP, PILOT_DRAFT_MAX, PILOT_ROW_LINE_CLIP,
} from "./debugPilot";
import type { DebugResult } from "./DebugPanel";

// 与 DebugPanel.test.tsx:13 同形状：一条「请求成功、断言全过」的基线，各条测试只改要钉的键。
const base = {
  run_id: "r1", ok: true, passed: true, status: 200, headers: {}, body_text: "{\"code\":0}",
  truncated: false, body_size: 10, elapsed_ms: 12, error: null, env_name: "本地",
  assertions: [{ type: "status_code", expected: 200, passed: true, actual: 200 }],
} as const;

const res = (x: Partial<DebugResult>): DebugResult => ({ ...base, ...x }) as DebugResult;

describe("clipMarked：截断必须留痕", () => {
  it("不超限原样返回，一个字都不加", () => {
    expect(clipMarked("abc", 10)).toBe("abc");
    expect(clipMarked("0123456789", 10)).toBe("0123456789"); // 边界：等长不算超
  });

  it("超限：截到 max 并写明原文多长、带了前多少", () => {
    const out = clipMarked("x".repeat(30), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("已截断：原文 30 字符，只带前 10");
  });
});

describe("debugFailedForPilot：什么时候递刀子", () => {
  it("请求本身失败 → 递（哪怕断言一条没过也没意义，ok=false 就够）", () => {
    expect(debugFailedForPilot(res({ ok: false, passed: false, status: null }))).toBe(true);
  });

  it("请求成功但有断言失败 → 递", () => {
    expect(debugFailedForPilot(res({ passed: false }))).toBe(true);
  });

  it("全过 → 不递", () => {
    expect(debugFailedForPilot(res({}))).toBe(false);
  });

  it("零断言行 + ok=true：后端 all([]) === true，落进「全过」，不递", () => {
    // 与 DebugPanel 的「未校验」徽标同源：零行时不猜原因，也就不说「这次失败来分析」。
    expect(debugFailedForPilot(res({ passed: true, assertions: [] }))).toBe(false);
  });
});

describe("describeAssertRow：一行话术", () => {
  it("有 path/expected/actual 时按 类型 · 路径 · 期望 · 实际 拼，失败前缀 [败]", () => {
    const line = describeAssertRow({
      type: "json_path_equals", path: "$.data.id", expected: 7, actual: 3, passed: false,
    });
    expect(line).toBe("[败] json_path_equals $.data.id · 期望 7 · 实际 3");
  });

  it("actual 缺席就不写「实际 null」——没跑出来的值不许编", () => {
    const line = describeAssertRow({ type: "body_contains", expected: "tk", passed: false });
    expect(line).toBe("[败] body_contains · 期望 \"tk\"");
    expect(line).not.toContain("实际");
  });

  it("行内 error 带上，整行超 PILOT_ROW_LINE_CLIP 时截断并留痕", () => {
    const line = describeAssertRow({ type: "script", passed: false, error: "e".repeat(500) });
    expect(line).toContain("报错 eeee");
    expect(line.length).toBeLessThanOrEqual(PILOT_ROW_LINE_CLIP + "\n…（已截断：原文 500 字符，只带前 120）".length);
    expect(line).toContain("已截断");
  });
});

describe("buildDebugPilotDraft：现场 → 草稿", () => {
  it("断言失败形状：标题、对象、结论行、断言逐条、响应体逐字", () => {
    const draft = buildDebugPilotDraft("查询订单", res({
      passed: false,
      assertions: [
        { type: "status_code", expected: 200, passed: true, actual: 200 },
        { type: "json_path_equals", path: "$.data.id", expected: 7, passed: false, actual: null },
      ],
    }));
    expect(draft).toContain("这次调试失败了，帮我分析一下原因。");
    expect(draft).toContain("对象：查询订单");
    expect(draft).toContain("请求发出去了，但有断言没过");
    expect(draft).toContain("运行 ID：r1");
    expect(draft).toContain("状态码：200");
    expect(draft).toContain("环境：本地");
    expect(draft).toContain("耗时：12 ms");
    expect(draft).toContain("断言结果（共 2 条）：");
    expect(draft).toContain("2. [败] json_path_equals $.data.id · 期望 7 · 实际 null");
    // 「带响应体」是蓝图点名的那半句：逐字，不压成结论
    expect(draft).toContain("响应体：\n{\"code\":0}");
    expect(draft).toContain("响应体大小：10 字节");
  });

  it("请求没成功形状：说「没拿到响应」，不谎称「有响应但错了」", () => {
    const draft = buildDebugPilotDraft("登录", res({
      ok: false, passed: false, status: null, body_text: null, body_size: 0,
      error: "连接被拒绝", assertions: [],
    }));
    expect(draft).toContain("请求本身失败（没拿到响应）");
    expect(draft).not.toContain("请求发出去了");
    expect(draft).toContain("报错：连接被拒绝");
    expect(draft).toContain("响应体：\n（无响应体）");
    expect(draft).not.toContain("状态码："); // status=null → 整行省略
    expect(draft).not.toContain("断言结果"); // 零行 → 不摆空标题
  });

  it("前置失败造的假结果（run_id 为空）：运行 ID 写「没落运行记录」，不留个空冒号", () => {
    const draft = buildDebugPilotDraft("用例A", res({ run_id: "", ok: false, passed: false }));
    expect(draft).toContain("运行 ID：（本次调试没落运行记录）");
  });

  it("缺的字段整行消失：env_name / error / body_size=0 且无响应体", () => {
    const draft = buildDebugPilotDraft("X", res({
      env_name: null, error: null, body_size: 0, body_text: null, ok: false, passed: false,
    }));
    expect(draft).not.toContain("环境：");
    expect(draft).not.toContain("报错：");
    expect(draft).not.toContain("响应体大小：");
  });

  it("requestLine 传了才写「请求：」行", () => {
    expect(buildDebugPilotDraft("X", res({}), "GET /api/orders")).toContain("请求：GET /api/orders");
    expect(buildDebugPilotDraft("X", res({}), null)).not.toContain("请求：");
  });

  it("响应体超 PILOT_BODY_CLIP：截断并写明原文长度", () => {
    const body = "y".repeat(PILOT_BODY_CLIP + 5_000);
    const draft = buildDebugPilotDraft("X", res({ body_text: body, body_size: body.length }));
    expect(draft).toContain("已截断：原文 " + body.length + " 字符，只带前 " + PILOT_BODY_CLIP);
  });

  it("断言条数无上限 → 整段兜底必带「少了多少字符」这句话，且绝不超 20000", () => {
    // 唯一能顶到 PILOT_DRAFT_MAX 的现实形状：断言结果行堆量（每行 ≤ ~130 字）。
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
      type: "json_path_equals", path: "$.data.item" + i, expected: "x".repeat(60),
      actual: "y".repeat(60), passed: false,
    }));
    const d1 = buildDebugPilotDraft("大报表", res({ passed: false, assertions: rows(260) }));
    expect(d1.length).toBeLessThanOrEqual(PILOT_DRAFT_MAX); // 说到做到：上限就是上限
    expect(d1).toContain("草稿整体超限，末尾内容未带入：");
    // 报的数要跟着真丢的量走，不能是个写死的常数
    const stated = (s: string) => Number(s.match(/未带入：(\d+) 字符/)?.[1] ?? -1);
    const d2 = buildDebugPilotDraft("大报表", res({ passed: false, assertions: rows(400) }));
    expect(d2.length).toBeLessThanOrEqual(PILOT_DRAFT_MAX);
    expect(stated(d2)).toBeGreaterThan(stated(d1));
    expect(stated(d1)).toBeGreaterThan(0);
  });

  it("普通长度的草稿不碰任何截断标记", () => {
    const draft = buildDebugPilotDraft("查询订单", res({ passed: false }));
    expect(draft).not.toContain("截断");
  });
});

describe("askPilotAboutDebug：只 nav，不发", () => {
  it("nav 收到 /bench + state.pilotDraft 整段，且没有第二处副作用", () => {
    const nav = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    askPilotAboutDebug("查询订单", res({ passed: false }), nav, "POST /api/orders");
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav.mock.calls[0][0]).toBe("/bench");
    const state = (nav.mock.calls[0][1] as { state: { pilotDraft: string } }).state;
    expect(state.pilotDraft).toContain("对象：查询订单");
    expect(state.pilotDraft).toContain("请求：POST /api/orders");
    expect(state.pilotDraft.length).toBeLessThanOrEqual(PILOT_DRAFT_MAX + 40);
    expect(fetchSpy).not.toHaveBeenCalled(); // 预填阶段零请求：会话惰性到首条消息才建
    vi.unstubAllGlobals();
  });

  it("nav 抛错（路由外调用）不吞：让调用方看见，不静默成「已经放好了」", () => {
    const nav = vi.fn(() => { throw new Error("useNavigate 在 Router 之外"); });
    expect(() => askPilotAboutDebug("X", res({ passed: false }), nav)).toThrow(/Router/);
  });
});
