// 报告中心「触发」筛选项的诚实性测试（D82：关假门，账留原地）。
// 钉两半：
// ① 筛选项不许出现「⇢ Webhook」——全仓零写入方（/hook/run/{token} 不存在，
//    写入方是 §12.4 一期 run-hook，待业主裁 D82），点它必是空表 = §13 纪律 1 假门；
//    同一条断言里带正对照（调试/手动/定时/Pilot 四项都在），负断言才有意义。
// ② 数据契约半边：后端 pattern 合法收 webhook，库里真出现 trigger=webhook 的行时
//    徽标必须照实画「⇢ Webhook」——筛选项裁的是承诺面，徽标报的是已发生的事。
// fetch 全 mock，同 schedules.test.tsx 手法。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import ReportsPage from "./reports";
import type { ReportRow } from "../api/report";
import { useAuth } from "../auth/store";

function row(id: string, trigger: string): ReportRow {
  return {
    id, subject_name: "下单链路", subject_type: "scenario", trigger,
    env_name: null, created_by_name: "张三", status: "passed",
    stats: { total: 2 }, pass_rate: 1, elapsed_ms: 100,
    started_at: "2026-11-16T10:00:00",
  };
}

// 真 webhook 行是**故意放进去的探针**：UI 不许承诺 webhook 会发生，
// 但行真从后端来了就得可读地画出来（数据契约半边）。
const ROWS: ReportRow[] = [row("r1", "manual"), row("r2", "webhook")];

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

function mockBackend() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const resp = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
    const page = (items: unknown[]) => ({ items, next_cursor: null });
    if (url.includes("/reports?")) return resp(page(ROWS));
    if (url.includes("/scenarios?")) return resp(page([{ id: "s1", name: "履约场景A" }]));
    if (url.includes("/envs?")) return resp(page([{ id: "e1", name: "测试环境" }]));
    if (url.includes("/members")) return resp(page([{ user_id: "u1", name: "张三", account: "a" }]));
    throw new Error("未 mock 的请求: GET " + url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
  mockBackend();
});

/** 展开「触发」下拉，返回浮层里全部选项文案。 */
async function openTriggerOptions(): Promise<string[]> {
  const sel = screen.getByTestId("reports-filter-trigger").querySelector(".ant-select-selector")!;
  fireEvent.mouseDown(sel);
  await waitFor(() => {
    expect(document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
      .length).toBeGreaterThan(0);
  });
  return Array.from(document.querySelectorAll(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content"))
    .map((n) => n.textContent ?? "");
}

describe("触发筛选项（D82 关假门）", () => {
  it("下拉里没有 Webhook（零写入方的承诺），而调试/手动/定时/Pilot 四项都在（正对照）", async () => {
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("reports-row").length).toBe(2));
    const opts = await openTriggerOptions();
    // 正负同一条 assertion：选项集**恰好**这四项——整个下拉没渲染会红，
    // 多出「⇢ Webhook」也会红。
    expect(opts).toEqual(["✎ 调试", "▶ 手动", "◷ 定时", "✦ Pilot"]);
  });
});

describe("库里真出现 trigger=webhook 的行（数据契约半边）", () => {
  it("徽标照实画「⇢ Webhook」：筛选裁承诺面，但已发生的 run 不能演成不认识", async () => {
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("reports-row").length).toBe(2));
    const badges = screen.getAllByTestId("report-trigger").map((n) => n.textContent);
    expect(badges).toContain("▶ 手动"); // 正对照：可承诺值照旧画友好文案
    // 徽标查 TRIGGERS 全表：库里存了 webhook 就画它的词表值。降级成 "? webhook"
    // 等于把已经发生的事演成「不认识」——那也是一种撒谎，方向相反但同类。
    expect(badges).toContain("⇢ Webhook");
    // 同一页的两个半边同时钉住：徽标有，筛选项没有。
    const opts = await openTriggerOptions();
    expect(opts).not.toContain("⇢ Webhook");
  });
});

describe("执行人筛选项 Tooltip（数据源口径）", () => {
  it("Tooltip 说的是项目成员全名单，不再谎称「已加载结果里出现过的人」", async () => {
    // creatorOpts(:118-120) 来自 /projects/{pid}/members 全量名单，不是结果行现攒
    //（:114-116 的反假筛选口径）；后端 created_by 服务端筛（report_services.py:194-195），
    // 没在本页出现过的成员照样筛得到——旧句把权威名单说成半截视图，是反向画饼。
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("reports-row").length).toBe(2));
    const node = screen.getByTestId("reports-filter-creator");
    fireEvent.mouseOver(node);
    fireEvent.mouseEnter(node);
    const visibleTips = () => Array.from(
      document.querySelectorAll(".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner"),
    ).map((n) => n.textContent).join("|");
    await waitFor(() => expect(visibleTips()).toContain("按项目成员筛"));
    expect(visibleTips()).toContain("项目全员"); // 正对照：说清名单范围
    expect(visibleTips()).not.toContain("已加载结果里出现过的人");
  });
});

describe("subject_name 列头（对象类型混排的诚实性）", () => {
  it("列头画「对象」不画「场景」：ui_case 行不许被标题判成场景", async () => {
    // report_list 默认返回全部 subject_type（report_services.py:176-187 只裁 debug），
    // 本页自带「对象类型」筛选就是混排的自供状；runVocab.ts:76-79：贴错对象类型
    // 是主动说错。行用 ui_case 渲染，让误标成为测试的靶心。
    const uiRow: ReportRow = {
      ...row("r-ui", "manual"), subject_type: "ui_case", subject_name: "登录页巡检",
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const resp = (json: unknown) =>
        ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      const page = (items: unknown[]) => ({ items, next_cursor: null });
      if (url.includes("/reports?")) return resp(page([uiRow]));
      if (url.includes("/scenarios?")) return resp(page([{ id: "s1", name: "履约场景A" }]));
      if (url.includes("/envs?")) return resp(page([{ id: "e1", name: "测试环境" }]));
      if (url.includes("/members")) return resp(page([{ user_id: "u1", name: "张三", account: "a" }]));
      throw new Error("未 mock 的请求: GET " + url);
    }) as unknown as typeof fetch;
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("reports-row").length).toBe(1));
    expect(screen.getByText("登录页巡检")).toBeTruthy(); // 正对照：ui_case 行真渲染了
    const headers = screen.getAllByRole("columnheader").map((n) => n.textContent);
    expect(headers).toContain("对象");
    expect(headers).not.toContain("场景");
  });
});

describe("通过率列的环：只许有一个算式（6b V1 变异的形状）", () => {
  it("环上 data-percent 跟的是后端 pass_rate，不是拿 stats 计数现攒的 pass/total", async () => {
    // 后端 `def _pass_rate`（report_services.py，判据 3）是 pass/(total−skip)，**分母扣跳步**；
    // 页面若自己拿 pass/total 现算，在有跳步的行上就会算出另一个数（判据 2 禁止重算）。
    // 所以 fixture 必须带 skip：pass=2、total=4、skip=1 ⇒ 后端 2/(4−1)=0.666→**67**，
    // 而 pass/total=2/4=50 —— 只有这两个数不同，断言才分得清谁在算。
    // 行数据只在本 it() 里覆盖，不动顶部 ROWS（既有 4 处 length===2 的断言口径不变）。
    const skipRow: ReportRow = {
      ...row("r-skip", "manual"),
      stats: { total: 4, pass: 2, fail: 1, skip: 1, error: 0 }, pass_rate: 2 / 3,
    };
    const nullRow: ReportRow = { ...row("r-none", "manual"), stats: { total: 1, skip: 1 }, pass_rate: null };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const resp = (json: unknown) =>
        ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      const page = (items: unknown[]) => ({ items, next_cursor: null });
      if (url.includes("/reports?")) return resp(page([skipRow, nullRow]));
      if (url.includes("/scenarios?")) return resp(page([{ id: "s1", name: "履约场景A" }]));
      if (url.includes("/envs?")) return resp(page([{ id: "e1", name: "测试环境" }]));
      if (url.includes("/members")) return resp(page([{ user_id: "u1", name: "张三", account: "a" }]));
      throw new Error("未 mock 的请求: GET " + url);
    }) as unknown as typeof fetch;
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    const rows = await waitFor(() => {
      const r = screen.getAllByTestId("reports-row");
      expect(r.length).toBe(2);
      return r;
    });
    // 环的 data-percent 落在外层 span（antd Progress 不转发未知 prop）。
    // 用 within 而不是整页 toContainText("67%")：整页搜会被别的文本喂饱（6b 实测过）。
    const ring = within(rows[0]).getByTestId("report-pass-rate");
    expect(ring.getAttribute("data-percent")).toBe("67"); // pass/total 现算会给 50
    // 正对照 + null 半边：分母 ≤0（全跳步）后端给 null，界面画「-」而不是 0%。
    // 「0%」是一个结论（全挂），「-」是没结论——混了就是撒谎。
    const dash = within(rows[1]).getByTestId("report-pass-rate");
    expect(dash.getAttribute("data-percent")).toBe("");
    expect(dash.textContent).toBe("-");
  });
});

describe("环境列 render（v ?? 「—」）的两个分支", () => {
  it("后端真填 env_name 的行画「测试环境」，null 的行画「—」——写死任何一侧都会红", async () => {
    // reports.tsx:146 `{ title: "环境", dataIndex: "env_name", render: (v) => v ?? "—" }`；
    // report_services.py:219 env_name=r.env_name 真填（RunRecord 有 env_name 列，
    // 跑在某个环境上的运行必有值）。而本文件 :29 与 reports.filters.test.tsx:41 的
    // fixture 一律 null，truthy 侧在门禁⑥里从没执行过。行数据只在本 it() 里覆盖，
    // 不动顶部共用常量（ROWS）——既有测试的 env_name 口径不变。
    const withEnv: ReportRow = { ...row("r-env", "manual"), env_name: "测试环境" };
    const noEnv: ReportRow = { ...row("r-null", "manual"), env_name: null };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const resp = (json: unknown) =>
        ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      const page = (items: unknown[]) => ({ items, next_cursor: null });
      if (url.includes("/reports?")) return resp(page([withEnv, noEnv]));
      if (url.includes("/scenarios?")) return resp(page([{ id: "s1", name: "履约场景A" }]));
      if (url.includes("/envs?")) return resp(page([{ id: "e1", name: "测试环境" }]));
      if (url.includes("/members")) return resp(page([{ user_id: "u1", name: "张三", account: "a" }]));
      throw new Error("未 mock 的请求: GET " + url);
    }) as unknown as typeof fetch;
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("reports-row").length).toBe(2));
    const headers = screen.getAllByRole("columnheader").map((n) => n.textContent);
    const envIdx = headers.indexOf("环境");
    expect(envIdx).toBeGreaterThan(-1); // 守卫：列没了 indexOf=-1、下面 cells 全 undefined，两句都成恒真
    const cells = screen.getAllByTestId("reports-row")
      .map((r) => r.querySelectorAll("td")[envIdx].textContent);
    // truthy 侧照实画环境名（render 写死 "—" 则第一行红），null 侧画「—」
    //（摘掉 ?? 直出则第二行是空单元格，也红）；执行人列同为 v ?? "—"、值是「张三」，
    // 错位取列同样红。
    expect(cells).toEqual(["测试环境", "—"]);
    // 环境名只在环境列出现这一次：筛选下拉未展开、/envs? 的选项不在 DOM 里。
    expect(screen.getAllByText("测试环境")).toHaveLength(1);
  });
});

describe("结果列词表外 status（R112：不回落友好标签）", () => {
  it("后端从没发过的 status 渲染原文；同屏 passed 行照常画友好标签（正对照）", async () => {
    // reports.tsx:154 的 `STATUSES[v] ?? …`（现为 vocabMeta(STATUSES, v)）此前**没人钉过**：
    // 把兜底改成 `?? { label: "未知状态" }` 或任何友好标签，本文件全部 8 例照全绿——
    // 形状同 planReportDetail.test.tsx ⑥b（那是 LINK_RESULTS 侧，实测出的洞）。
    // "blocked" 不在 STATUSES 六态里。行数据只在本 it() 里覆盖，不动顶部 ROWS。
    const weird: ReportRow = { ...row("r-weird", "manual"), status: "blocked" };
    const ok: ReportRow = { ...row("r-ok", "manual") }; // status: "passed"（词表内）
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const resp = (json: unknown) =>
        ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      const page = (items: unknown[]) => ({ items, next_cursor: null });
      if (url.includes("/reports?")) return resp(page([weird, ok]));
      if (url.includes("/scenarios?")) return resp(page([{ id: "s1", name: "履约场景A" }]));
      if (url.includes("/envs?")) return resp(page([{ id: "e1", name: "测试环境" }]));
      if (url.includes("/members")) return resp(page([{ user_id: "u1", name: "张三", account: "a" }]));
      throw new Error("未 mock 的请求: GET " + url);
    }) as unknown as typeof fetch;
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    const rows = await waitFor(() => {
      const r = screen.getAllByTestId("reports-row");
      expect(r.length).toBe(2);
      return r;
    });
    // 断言 scoped 到本行的「结果」徽标：不 scope 时 toContain("通过") 会被另一行喂饱、
    // not.toContain 会被列头/别处文本意外满足（通过率列 6b 的同款教训）。
    const weirdBadge = within(rows[0]).getByTestId("report-status");
    expect(weirdBadge.textContent).toBe("blocked"); // 生码原样上屏
    expect(weirdBadge.textContent).not.toContain("通过"); // 绝不回落成认识的话
    // 正对照：同屏词表内行照常画友好标签——不是整列退化成了原文
    expect(within(rows[1]).getByTestId("report-status").textContent).toBe("通过");
  });
});
