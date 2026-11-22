// UiDebugPanel（T17，§11.4.12 UI 调试底栏）的组件测试：全仓此前没有任何测试 import 它
// （audit-test-debt.mjs 榜首）。"让 Pilot 分析"钮由 DebugPanel.pilot.test.tsx 钉死（本面板
// 不传 subject 就不画钮），这里不重复；预算全花在 props 契约 {result, running, error, note,
// projectId, onClose} 与 8 个自有 testid：running 半截态 / 空态+onClose / 发起失败 Alert /
// 成功回执（徽标、耗时、报告 href、行 data-*、vars、断言卡复用件）/ 未知 status 回落生码 /
// failed 断言行 / 截图带 project_id + 卸载 revoke / 拖把手 120~0.6·innerHeight 夹紧。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";
import UiDebugPanel from "./UiDebugPanel";
import type { UiDebugResult } from "./debugRows";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();

/** 字段逐字 = UiDebugResult（debugRows.ts:11-22，后端 UiDebugOut 的手写镜像）。
 *  UiResult.commands 行后端还带第 7 键 detail（ui_core.py:237-241 _row_cmd，恒 {}），
 *  但 cmdRows（debugRows.ts:92-101）不读它、面板不显示，所以 fixture 不写它。 */
function mkResult(over: Partial<UiDebugResult> = {}): UiDebugResult {
  return { run_id: "run-1", status: "passed", ok: true, passed: true, elapsed_ms: 1234,
    error: null, env_name: "本地", vars: { tok: "abc" },
    commands: [
      { id: "c1", type: "open", status: "pass", message: "打开 https://t.cn", elapsed_ms: 900 },
      { id: "c2", type: "assert_text", status: "pass", message: "文案「余额」已出现", elapsed_ms: 20,
        assertions: [{ type: "assert_text", passed: true, expected: "余额", actual: "余额" }] },
    ],
    artifacts: [],
    ...over,
  };
}

function renderPanel(props: Partial<Parameters<typeof UiDebugPanel>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <UiDebugPanel result={null} running={false} error={null} note={null}
        projectId="p1" onClose={onClose} {...props} />
    </ConfigProvider>,
  );
  return { ...utils, onClose };
}

const panel = () => screen.getByTestId("ui-debug-panel");
const badge = () => screen.getByTestId("ui-debug-badge");
const MAX_H = Math.round(window.innerHeight * 0.6); // 夹具公式，不写死数字

beforeEach(() => {
  cleanup();
  URL.createObjectURL = vi.fn(() => "blob:shot");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => cleanup());

describe("running 半截态：!running 门全让位，只认 result 的门照旧", () => {
  it("running=true：徽标独占「运行中」，note/Alert/耗时/时间线消失；报告链接与环境标在场", () => {
    renderPanel({ running: true, result: mkResult(), error: "上一轮的发起错误", note: "已代为保存。" });
    expect(badge().textContent).toBe("运行中");
    expect(badge().className).toContain("ant-tag-processing");
    expect(screen.getByText(/真浏览器正在跑/)).not.toBeNull();
    expect(screen.queryByTestId("ui-debug-note")).toBeNull();
    expect(screen.queryByText("调试没有发起")).toBeNull();
    expect(screen.queryByText("1234ms")).toBeNull();
    expect(screen.queryAllByTestId("debug-cmd-row")).toHaveLength(0);
    // FINDING（按现状钉）：:116/:118 两道门只看 result 不看 !running——重跑进行中
    // 仍画着上一轮的 env_name 和指向旧 run_id 的「查看报告」。AdbDebugPanel 同款不对称
    // 已在其测试里挂过账（AdbDebugPanel.test.tsx FINDING-1），大概率是同一笔已知决策。
    expect(screen.getByText("本地")).not.toBeNull();
    expect(screen.getByTestId("ui-debug-report-link").getAttribute("href")).toBe("#/reports/run-1");
  });
});

describe("空态与关闭", () => {
  it("全空：Empty 话术原样、无徽标无报告链接；点关闭恰叫一次 onClose", () => {
    const { onClose } = renderPanel();
    expect(screen.getByText("点「调试」用真浏览器跑一遍")).not.toBeNull();
    expect(screen.queryByTestId("ui-debug-badge")).toBeNull();
    expect(screen.queryByTestId("ui-debug-report-link")).toBeNull();
    expect(screen.queryByTestId("ui-debug-note")).toBeNull();
    fireEvent.click(screen.getByTestId("ui-debug-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("发起失败（error 直出，不演半截结论）", () => {
  it("徽标「发起失败」红 + Alert description 逐字 + note 在场 + 零命令行 + 无报告链接", () => {
    const ERR = "定位器解析失败：strict mode violation（422）";
    renderPanel({ error: ERR, note: "本次发起前已代为保存屏幕上的修改。" });
    expect(badge().textContent).toBe("发起失败");
    expect(badge().getAttribute("data-status")).toBe("error");
    expect(badge().className).toContain("ant-tag-red");
    expect(screen.getByText("调试没有发起")).not.toBeNull();
    expect(screen.getByText(ERR)).not.toBeNull();
    expect(screen.getByTestId("ui-debug-note").textContent).toContain("已代为保存");
    expect(screen.queryByText("点「调试」用真浏览器跑一遍")).toBeNull();
    expect(screen.queryAllByTestId("debug-cmd-row")).toHaveLength(0);
    expect(screen.queryByTestId("ui-debug-report-link")).toBeNull();
  });
});

describe("成功回执的整板渲染", () => {
  it("通过徽标+耗时+报告 href；时间线两行 data-*/message 逐字；vars 摊开；断言卡直复 DebugPanel", () => {
    renderPanel({ result: mkResult() });
    expect(badge().textContent).toBe("通过");
    expect(badge().getAttribute("data-status")).toBe("passed");
    expect(badge().className).toContain("ant-tag-green");
    expect(screen.getByText("1234ms")).not.toBeNull();
    const link = screen.getByTestId("ui-debug-report-link");
    expect(link.getAttribute("href")).toBe("#/reports/run-1");
    expect(link.textContent).toBe("查看报告");
    const rows = screen.getAllByTestId("debug-cmd-row");
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["c1", "c2"]);
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["pass", "pass"]);
    expect(screen.getByTestId("debug-cmd-message-c1").textContent).toBe("打开 https://t.cn");
    expect(rows[0].textContent).toContain("open");
    expect(rows[0].textContent).toContain("900ms");
    expect(rows[1].textContent).toContain("文案「余额」已出现");
    const vars = screen.getByTestId("debug-vars");
    expect(vars.textContent).toContain("变量快照（1）");
    expect(screen.getByText("${tok}").tagName).toBe("CODE");
    expect(vars.textContent).toContain("= abc");
    expect(screen.getByTestId("debug-panel")).toBeTruthy(); // 断言卡复用件在场
    expect(screen.getByTestId("debug-assert-pass").textContent).toBe("断言全过");
    expect(screen.getByTestId("assertion-card").textContent).toContain("assert_text");
  });

  it("未知 status 回落生码；vars={} 画「没有存过变量」并说明 console 未采集", () => {
    renderPanel({ result: mkResult({ status: "timeout", vars: {} }) });
    expect(badge().textContent).toBe("timeout"); // meta?.label ?? result.status，不编友好标签
    expect(badge().getAttribute("data-status")).toBe("timeout");
    expect(screen.getByTestId("debug-vars").textContent).toContain("变量快照（0）");
    expect(screen.getByTestId("debug-vars").textContent).toContain("没有存过变量");
    expect(screen.queryByText("${tok}")).toBeNull();
  });

  it("failed：徽标「断言失败」橙；失败断言行 期望/实际 逐字；ok=false → 复用件报「请求失败」", () => {
    renderPanel({ result: mkResult({
      status: "failed", ok: false, passed: false,
      commands: [{ id: "x1", type: "assert_text", status: "fail", message: "文案未出现", elapsed_ms: 60,
        assertions: [{ type: "assert_text", passed: false, expected: "余额", actual: "首页" }] }],
    }) });
    expect(badge().textContent).toBe("断言失败");
    expect(badge().className).toContain("ant-tag-orange");
    const card = screen.getByTestId("assertion-card");
    expect(card.textContent).toContain('期望 "余额"');
    expect(card.textContent).toContain('实际 "首页"');
    expect(screen.getByTestId("debug-status").textContent).toBe("请求失败");
  });
});

describe("截图内联：projectId 必须跟着取字节请求走", () => {
  it("SCREENSHOT → /artifacts/{run}/{name}?project_id=p1 → img；加载中可见；卸载 revoke", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return { ok: true, status: 200, blob: async () => new Blob(["px"]), json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { unmount } = renderPanel({
      result: mkResult({
        run_id: "run-9",
        commands: [{ id: "c1", type: "screenshot", status: "pass", message: "", elapsed_ms: 9 }],
        artifacts: [{ kind: "SCREENSHOT", step_key: "c1", ref: "run-9/fail.png", bytes: 100, reason: "失败截图" }],
      }),
    });
    expect(screen.getByText("截图加载中…")).not.toBeNull();
    const img = await screen.findByTestId("debug-shot-c1");
    expect(img.getAttribute("src")).toBe("blob:shot");
    expect(img.getAttribute("alt")).toBe("fail.png");
    expect(screen.getByText("失败截图")).not.toBeNull();
    expect(urls).toEqual(["/api/v1/artifacts/run-9/fail.png?project_id=p1"]);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:shot");
  });
});

describe("拖把手：120 ~ round(0.6·innerHeight)", () => {
  it("默认 300；上拖 +100；越界双向夹紧；pointerUp 后再移动不改高", () => {
    renderPanel();
    expect(panel().style.height).toBe("300px");
    expect(panel().style.minHeight).toBe("120px");
    expect(panel().style.maxHeight).toBe(MAX_H + "px");
    const handle = screen.getByTestId("ui-debug-resize");
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 300, pointerId: 1 });
    expect(panel().style.height).toBe("400px");
    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
    expect(panel().style.height).toBe(MAX_H + "px");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 10, pointerId: 1 });
    expect(panel().style.height).toBe(MAX_H + "px");
    fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 600, pointerId: 1 });
    expect(panel().style.height).toBe("120px");
  });
});
