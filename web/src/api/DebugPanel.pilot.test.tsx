// 「调试失败 → 让 Pilot 分析（带响应体）」的渲染侧闸门（蓝图 docs/2026-11-13-ai-test-platform-design.md:1426）。
// debugPilot.test.ts 钉的是拼稿纯逻辑；这个文件只钉两件事：
//   ① 钮出现的条件（失败态 **且** 给了对象名）——三处只当断言卡复用的调用点不传 subject，
//      一个钮都不许画；② 点下去只做 nav("/bench", {state:{pilotDraft}})，零请求。
// navSpy 手法照 adbDevices.test.tsx:13：要抓第二个参数里的 state 对象，MemoryRouter 抓不到。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navSpy,
}));

import DebugPanel from "./DebugPanel";
import type { DebugResult } from "./DebugPanel";

const base = {
  run_id: "r1", ok: true, passed: true, status: 200, headers: {}, body_text: "{\"code\":0}",
  truncated: false, body_size: 10, elapsed_ms: 12, error: null, env_name: "本地",
  assertions: [{ type: "status_code", expected: 200, passed: true, actual: 200 }],
} as const;

const res = (x: Partial<DebugResult>): DebugResult => ({ ...base, ...x }) as DebugResult;

beforeEach(() => {
  cleanup();
  navSpy.mockClear();
});

describe("「让 Pilot 分析」只在真失败 + 有对象名时出现", () => {
  it("断言失败 + subject → 钮在，且就住在面板标题行里", () => {
    render(<DebugPanel result={res({ passed: false })} subject="查询订单" />);
    expect(screen.getByTestId("debug-ask-pilot").textContent).toBe("让 Pilot 分析");
  });

  it("请求失败（!ok）→ 也给钮：这是蓝图点名的主场景", () => {
    render(<DebugPanel result={res({ ok: false, passed: false, status: null })} subject="登录" />);
    expect(screen.getByTestId("debug-ask-pilot")).toBeTruthy();
  });

  it("全过 → 不画（摆一个「分析」钮问一件没发生的事，是假门）", () => {
    render(<DebugPanel result={res({})} subject="查询订单" />);
    expect(screen.queryByTestId("debug-ask-pilot")).toBeNull();
  });

  it("零断言行 + ok：passed=all([])=true → 与「未校验」徽标同口径，不画", () => {
    render(<DebugPanel result={res({ passed: true, assertions: [] })} subject="查询订单" />);
    expect(screen.getByTestId("debug-assert-none")).toBeTruthy();
    expect(screen.queryByTestId("debug-ask-pilot")).toBeNull();
  });

  it("不传 subject → 一个钮都不画（AdbDebugPanel/UiDebugPanel/reportDetail 三处断言卡复用靠这条兜住）", () => {
    render(<DebugPanel result={res({ passed: false })} />);
    expect(screen.queryByTestId("debug-ask-pilot")).toBeNull();
    render(<DebugPanel result={res({ ok: false, passed: false })} subject={null} />);
    expect(screen.queryByTestId("debug-ask-pilot")).toBeNull();
    expect(navSpy).not.toHaveBeenCalled();
  });

  it("result=null 的空态不炸、也不画钮", () => {
    render(<DebugPanel result={null} subject="查询订单" />);
    expect(screen.getByTestId("debug-panel")).toBeTruthy();
    expect(screen.queryByTestId("debug-ask-pilot")).toBeNull();
  });
});

describe("点一下只做预填导航，不偷发", () => {
  it("nav 收 /bench + 带响应体的草稿；页面上没有第二件事发生", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<MemoryRouter><DebugPanel result={res({
      passed: false, body_text: "{\"msg\":\"库存不足\"}",
    })} subject="下单" requestLine="POST /api/orders" /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("debug-ask-pilot"));
    expect(navSpy).toHaveBeenCalledTimes(1);
    expect(navSpy.mock.calls[0][0]).toBe("/bench");
    const draft = (navSpy.mock.calls[0][1] as { state: { pilotDraft: string } }).state.pilotDraft;
    expect(draft).toContain("对象：下单");
    expect(draft).toContain("请求：POST /api/orders");
    expect(draft).toContain("{\"msg\":\"库存不足\"}"); // 「带响应体」逐字进草稿
    expect(fetchSpy).not.toHaveBeenCalled();
    // 点完仍在原地：面板没被卸载，发送钮在人手里（预填 ≠ 已发）
    expect(screen.getByTestId("debug-panel")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("requestLine 不传时草稿里不出现「请求：」行——没有的形状不编", () => {
    render(<MemoryRouter><DebugPanel result={res({ passed: false })} subject="某运行" /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("debug-ask-pilot"));
    const draft = (navSpy.mock.calls[0][1] as { state: { pilotDraft: string } }).state.pilotDraft;
    expect(draft).not.toContain("请求：");
    expect(draft).toContain("对象：某运行");
  });
});
