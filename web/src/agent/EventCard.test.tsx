// EventCard 的卡片协议分支：ui="card" 走 renderCard；未注册 kind 落折叠 JSON + 人话（不白屏）。
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import EventCard from "./EventCard";
import "./cards"; // 内置渲染器注册副作用
import type { AgentEvent } from "./sse";
import type { CardContext } from "./cards";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const ctx: CardContext = { onUserMessage: () => undefined, busy: false };

function ev(payload: Record<string, unknown>, seq = 1): AgentEvent {
  return { seq, ts: null, type: "TOOL_RESULT", payload };
}

beforeEach(cleanup);

describe("EventCard 的 TOOL_RESULT(ui=card) 分支", () => {
  it("已注册 kind → 走卡片渲染而不是默认 JSON 折叠", () => {
    render(
      <EventCard
        effects={{}}
        cardCtx={ctx}
        ev={ev({
          tool_name: "propose_scenario_plans", ok: true, ui: "card",
          content: { card: { kind: "scenario_plans", plans: [{ name: "甲方案", intent: "i", est_steps: ["s1"] }] } },
        })}
      />,
    );
    expect(screen.getByTestId("scenario-plans-card")).toBeTruthy();
    expect(screen.queryByTestId("tool-json")).toBeNull();
  });

  it("未注册 kind（report_summary）→ 「暂不支持的卡片类型」人话 + 折叠原始 JSON，不白屏", () => {
    render(
      <EventCard
        effects={{}}
        cardCtx={ctx}
        ev={ev({ tool_name: "x", ok: true, ui: "card", content: { card: { kind: "report_summary", foo: 1 } } })}
      />,
    );
    expect(screen.getByText(/暂不支持的卡片类型/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("tool-expand"));
    expect(screen.getByTestId("tool-json").textContent).toContain("report_summary");
  });

  it("没有 ui=card 的普通 TOOL_RESULT 不受影响（默认 JSON 折叠）", () => {
    render(<EventCard effects={{}} ev={ev({ tool_name: "search_tools", ok: true, content: { items: [] } })} />);
    expect(screen.getByTestId("tool-expand")).toBeTruthy();
    expect(screen.queryByTestId("scenario-plans-card")).toBeNull();
  });
});

// 效果徽标的三态：只认 /agent/tools 给的真读数。这张表是 start() 里异步拉的，失败时// 整张清空（bench.tsx:109）——若把「查不到」当「read」，一次拉取失败就把写工具全涂成
// 蓝色「只读」，而同一轮会话的 APPROVAL_REQ 卡还写着「等待审批：写工具」。
describe("EventCard 的工具效果徽标", () => {
  const tool = (name: string, effects: Record<string, "read" | "write" | "destructive">) =>
    render(<EventCard effects={effects} ev={ev({ tool_name: name, ok: true, content: {} })} />);

  it("表里有才报对应态：read/write/destructive 三种文案各自落地", () => {
    tool("search_tools", { search_tools: "read" });
    expect(screen.getByText("只读")).toBeTruthy();
    cleanup();
    tool("case_create", { case_create: "write" });
    expect(screen.getByText("写入")).toBeTruthy();
    cleanup();
    tool("case_delete", { case_delete: "destructive" });
    expect(screen.getByText("破坏性")).toBeTruthy();
  });

  it("效果表缺失 → 「效果未知」，绝不降级成「只读」", () => {
    tool("case_create", {}); // 空表 = /agent/tools 那一路失败
    expect(screen.getByText("效果未知")).toBeTruthy();
    expect(screen.queryByText("只读")).toBeNull();
  });

  it("表里有别人但没这个工具 → 同样算未知，不拿默认值补一个「只读」", () => {
    tool("case_create", { search_tools: "read" });
    expect(screen.getByText("效果未知")).toBeTruthy();
    expect(screen.queryByText("只读")).toBeNull();
  });
});

// 审批卡文案（D126）：每个分句都必须是此刻按得动的按钮。「切 FULL 模式重试」在会话内
// 按不到——模式选择器 disabled={running || sessionId !== null}，挂起态本身就禁着它，
// 唯一出路是「重新开始」另起会话。文案许诺同屏禁止的操作 = 又一句假话。
describe("APPROVAL_REQ 审批卡", () => {
  const approval = () =>
    render(
      <EventCard
        effects={{}}
        cardCtx={ctx}
        ev={{ seq: 1, ts: null, type: "APPROVAL_REQ", payload: { tool_name: "case_delete", args: { id: 1 } } }}
      />,
    );

  it("挂起提示 + 工具名 + 参数在卡上", () => {
    approval();
    const card = screen.getByTestId("approval-card");
    expect(card.textContent).toContain("暂不支持在页面上批准");
    expect(card.textContent).toContain("case_delete");
  });

  it("出路两句都可执行：「中断」结束本轮 + 换模式须走「重新开始」，不出现「切 FULL 模式重试」", () => {
    approval();
    const card = screen.getByTestId("approval-card");
    expect(card.textContent).toContain("中断");
    expect(card.textContent).toContain("重新开始"); // 会话内切模式的真前提
    expect(card.textContent).not.toContain("或切 FULL 模式重试");
  });

  it("出路说成有序两步：先「中断」（此刻「重新开始」是灰的），中断后它才可点", () => {
    // 这张卡存在的唯一状态下 status=等待审批，bench.tsx:113 的 running 把「重新开始」
    // 按死（:198 disabled）。旧文案「先点『重新开始』另起会话」许诺了一颗当帧禁用的钮
    // = 假门：用户必须先「中断」离开等待审批，那颗钮才会亮。
    approval();
    const t = screen.getByTestId("approval-card").textContent!;
    expect(t).toContain("先点「中断」"); // 第一步点名，且带「先」字
    expect(t).toContain("中断后"); // 第二步的时序连词：中断是「重新开始」变可点的前提
    expect(t).toContain("「重新开始」是灰的"); // 当场摊牌：同帧那颗钮按不动
    expect(t.indexOf("中断")).toBeLessThan(t.indexOf("重新开始")); // 顺序不许倒装
  });
});

// ── 会话流静默化改版（2026-11-21）────────────────────────────────────────────
// 事件名徽标（TOOL_CALL/TOOL_RESULT）整块下线：口径改由 chip 文案 + 成败标签承担。
// 这里钉的是「徽标没了之后，哪些话必须还在」，以及三种到场形状各画什么。
describe("工具 chip（徽标下线的替代口径）", () => {
  const ev2 = (payload: Record<string, unknown>, type = "TOOL_CALL", seq = 1): AgentEvent =>
    ({ seq, ts: "2026-11-21T10:00:00+08:00", type, payload });

  it("不再出现大写事件名徽标", () => {
    render(<EventCard effects={{}} ev={ev2({ tool_name: "search_tools", ok: true, content: {} }, "TOOL_RESULT")} />);
    expect(screen.queryByTestId("event-kind")).toBeNull();
    expect(screen.getByTestId("event-card").textContent).not.toContain("TOOL_RESULT");
  });

  it("只有 TOOL_CALL → 「执行中…」，且不凭空编一个返回块", () => {
    render(<EventCard effects={{ create_api_case: "write" }} ev={ev2({ tool_name: "create_api_case", args: { a: 1 } })} />);
    expect(screen.getByTestId("tool-pending").textContent).toContain("执行中");
    const labels = screen.getAllByTestId("tool-expand").map((n) => n.textContent);
    expect(labels).toEqual(["参数"]); // 没有结果就没有「返回结果」那一栏
    expect(screen.getByTestId("event-card").textContent).not.toContain("成功");
  });

  it("调用 + 配对结果 → 一屏之内同时有工具名、效果、成败，且不再说「执行中」", () => {
    render(
      <EventCard
        effects={{ create_api_case: "write" }}
        ev={ev2({ tool_name: "create_api_case", args: { a: 1 } })}
        result={ev2({ tool_name: "create_api_case", ok: true, content: { id: "x" } }, "TOOL_RESULT", 2)}
      />,
    );
    const t = screen.getByTestId("event-card").textContent!;
    expect(t).toContain("create_api_case");
    expect(t).toContain("写入");
    expect(t).toContain("成功");
    expect(screen.queryByTestId("tool-pending")).toBeNull();
    expect(screen.getAllByTestId("tool-expand").map((n) => n.textContent)).toEqual(["参数", "返回结果"]);
  });

  it("只有 TOOL_RESULT（历史被截断/单测直挂）→ 只画返回块，不补一个假参数块", () => {
    render(<EventCard effects={{}} ev={ev2({ tool_name: "search_tools", ok: false, error: "炸了" }, "TOOL_RESULT")} />);
    expect(screen.getAllByTestId("tool-expand").map((n) => n.textContent)).toEqual(["返回结果"]);
    expect(screen.getByTestId("event-card").textContent).toContain("失败");
  });

  it("结果带 produced → chip 上报「产出 N 个资源」（与右栏同一份数据）", () => {
    render(
      <EventCard
        effects={{ api_definition_create: "write" }}
        ev={ev2({ tool_name: "api_definition_create", args: {} })}
        result={ev2({ tool_name: "api_definition_create", ok: true, content: {}, produced: [{ kind: "api_definition", id: "d1", name: "查询订单" }] }, "TOOL_RESULT", 2)}
      />,
    );
    expect(screen.getByTestId("tool-produced").textContent).toContain("产出 1 个资源");
  });

  it("空 produced 数组不说「产出 0 个资源」（那等于宣布一件没发生的事）", () => {
    render(
      <EventCard
        effects={{}}
        ev={ev2({ tool_name: "search_tools", args: {} })}
        result={ev2({ tool_name: "search_tools", ok: true, content: {}, produced: [] }, "TOOL_RESULT", 2)}
      />,
    );
    expect(screen.queryByTestId("tool-produced")).toBeNull();
  });

  it("THINKING 不再刷大写标签，折叠头是人话", () => {
    render(<EventCard effects={{}} ev={ev2({ text: "先看看有哪些环境" }, "THINKING")} />);
    expect(screen.queryByTestId("event-kind")).toBeNull();
    expect(screen.getByTestId("event-card").textContent).toContain("思考中");
  });
});
