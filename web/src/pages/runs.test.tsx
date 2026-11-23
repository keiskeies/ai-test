// 运行记录页（§11.4.26 子集）组件测试——补 runs.tsx 的零覆盖账。
// 钉四条「注释里写着生产故障、却从来没有测试」的不变量：
// ① D82 假门半边（:137-141 筛选项 / :23-26 徽标）：触发筛选项只出 SELECTABLE_TRIGGERS
//    （webhook 零写入方，点了必是空表 = 假门），徽标却查 TRIGGERS 全表（库里存了就照实画）。
//    两个半边在同一条测试里同时钉——只钉一边，「顺手统一」的改动就会拆掉另一边。
// ② R112 宁可生码不可撒谎（:107-114）：ui_case 画词表值「UI 用例」（老三元会贴成「接口」，
//    那是主动说错）；词表外的 code 原样直出，绝不回落成任何友好 label。
// ③ 故障 ≠ 空数据（:83-86 / :147-166）：列表 403 → 警示 Alert 上屏、正常空态文案消失；
//    正常空集 → 空态引导在、Alert 消失。两个分支互斥地钉，反了也红。
// ④ R68 时区（:98-103）：run-time 必须走 fmtTime——UTC ISO 渲染成东八区墙钟，
//    不是 slice(0,19) 的 UTC 钟点。期望值锚在 timefmt.test.ts 的实测数据（03:24:05 UTC
//    → 11:24:05 上海），不复用 fmtTime 实现本身，避免被测件与预期值同谋。
// 附赠：页码分页（D47-b，同 报告中心 ee938ec 的转换）——current 上线、替换语义、
// 失败清 total、以及「挂载稳定后恰好一条列表请求」的 D127 绊线；与详情按钮的 GET 口径。
// fetch 全 mock，同 reports.test.tsx / schedules.test.tsx 手法；
// client.ts:77 给所有请求前缀 /api/v1，断言 URL 一律带上该前缀。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import RunsPage, { pickDeepLinkHit } from "./runs";
import type { RunRow } from "../api/api";
import { useAuth } from "../auth/store";

function run(id: string, over: Partial<RunRow> = {}): RunRow {
  return {
    id, subject_type: "api_case", subject_id: "c1", subject_name: "下单用例",
    env_name: "测试环境", trigger: "debug", status: "passed", status_code: 200,
    elapsed_ms: 123, error: null, created_at: "2026-11-15T03:24:05+00:00",
    created_by_name: "张三", ...over,
  };
}

// R68 的实测原料（timefmt.test.ts 同款）：UTC 03:24:05 → 东八区 11:24:05。
const UTC_ISO = "2026-11-15T03:24:05+00:00";
const SHANGHAI = "2026-11-15 11:24:05";

const ROWS: RunRow[] = [
  run("r1", { created_at: UTC_ISO }),
  // R112 的正主：词表里有 ui_case → 只许画「UI 用例」；老三元会把它贴成「接口」
  run("r2", { subject_type: "ui_case", subject_name: "登录页冒烟", trigger: "schedule", status: "queued" }),
  // 探针行：词表外 subject_type（只许生码）+ 库里真存在的 webhook 行（徽标只许照实画）
  run("r3", { subject_type: "quantum_thing", subject_name: "来历不明的运行", trigger: "webhook",
    status_code: null, created_at: null, status: "error" }),
];

const DETAIL = {
  ...run("r1"),
  request_snapshot: { method: "GET", path: "/demo/ping" },
  response_snapshot: { headers: {}, body_text: '{"a":1}', truncated: false, body_size: 7 },
  assertions: [],
};

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

// D242：高级搜索三件套的依赖。字段与后端 RUN_LIST_FILTER 同名同 kind——表单照 meta
// 渲染，前端不自己列字段名。
const FILTER_META = {
  view_type: "run", view_label: "运行记录",
  supported_view_types: ["run"],
  fields: [
    { field: "subject_name", label: "对象名称", kind: "text",
      ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS"] },
    { field: "status", label: "状态", kind: "enum",
      ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
    { field: "trigger", label: "触发方式", kind: "enum",
      ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
    { field: "created_at", label: "创建时间", kind: "time", ops: ["BETWEEN", "GT", "LT"] },
  ],
  unavailable: {},
};

const calls: { url: string; method: string; body: unknown }[] = [];

/** D47-b 页码模式响应：total 可选——缺键就是后端游标式响应的真实形状，不是显式 null。 */
type ListPage = { items: RunRow[]; next_cursor: string | null; total?: number | null };
interface BackendOpts { listStatus?: number; pages?: ListPage[]; detail?: unknown }

/** 安装 fetch 桩并**返回配置句柄**：失败清空 total 那条要在挂载后翻 listStatus。 */
function mockBackend(over: BackendOpts = {}): BackendOpts {
  const backend = over;
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    // 每次调用现拷一份响应体：真 fetch 每次解析出一棵**全新的对象图**，而 reports 转换前的桩
    // 把同一个对象反复交出去——setItems(同一引用) 被 React 按同一性跳过，
    // 「取数落地把 load 的依赖改脏 → effect 重跑 → 无限请求」的回路在线上必现、
    // 在那套桩下永远测不出（reports.tsx 的 load 依赖里一度真的多了 items）。
    // 桩不许比真接口更好说话。
    const resp = (status: number, json: unknown) =>
      ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) as unknown }) as unknown as Response;
    // D242：ListToolbar 挂载即拉元数据与个人视图（未 mock 会 throw，整页红成取数失败）
    if (url.includes("/filter-meta?")) return resp(200, FILTER_META);
    if (url.includes("/saved-views?")) return resp(200, []);
    if (/\/runs\/[^/?]+\?/.test(url)) return resp(200, backend.detail ?? DETAIL);
    if (url.includes("/runs?")) {
      if (backend.listStatus) {
        return resp(backend.listStatus, { code: "forbidden", message: "无权查看运行记录", details: {} });
      }
      const pages = backend.pages ?? [{ items: ROWS, next_cursor: null }];
      // 页码路由：不带 current 或 current=1 的请求出第一段；其余页码出第二段，没配就重复第一段
      const cur = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("current");
      return resp(200, !cur || cur === "1" ? pages[0] : (pages[1] ?? pages[0]));
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return backend;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

/** 展开指定 testid 的 antd 下拉，返回当前浮层里全部选项文案（同 reports.test.tsx）。 */
async function openSelectOptions(testid: string): Promise<string[]> {
  const sel = screen.getByTestId(testid).querySelector(".ant-select-selector")!;
  fireEvent.mouseDown(sel);
  await waitFor(() => {
    expect(document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
      .length).toBeGreaterThan(0);
  });
  return Array.from(document.querySelectorAll(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content"))
    .map((n) => n.textContent ?? "");
}

/** 只点**当前展开**浮层里的选项（收起的旧浮层可能还留在 DOM）。 */
async function clickOption(text: string): Promise<void> {
  const opt = await screen.findByText(text, {
    selector: ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content",
  });
  fireEvent.click(opt);
}

const listCalls = () => calls.filter((c) => c.url.includes("/runs?"));

/** 最后一条列表请求的 query（在“比 before 多”上等待）。 */
async function lastQuery(before: number): Promise<URLSearchParams> {
  await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
  const u = listCalls()[listCalls().length - 1].url;
  return new URLSearchParams(u.slice(u.indexOf("?") + 1));
}

describe("① 触发筛选项 D82（关假门）× 徽标（数据契约）——两半同钉", () => {
  it("筛选项恰好 调试/手动/定时/Pilot 四项（无 Webhook 假门），而库里 trigger=webhook 的行徽标仍照实画「⇢ Webhook」", async () => {
    mockBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    // D127 绊线放在**全文件最早挂载列表**的用例上（schedules/notifyChannels 同法，实测理由）：
    // 「取数落地把自己写的 state 塞回 load 依赖」这种回路，若绊线只在后面的页码块里，
    // 前面每条用例都会带着一个不停发请求的后台回路跑完——整文件从 10s 拖到 9min+，
    // 最后仍由页码块报红，但红得又慢又难归因。放在最前面 = 回路第一条就红，且只红一条。
    await new Promise((r) => setTimeout(r, 300));
    expect(listCalls()).toHaveLength(1);
    const opts = await openSelectOptions("runs-filter-trigger");
    // 正负同断言：选项集**恰好**这四项——下拉整体没渲染会红，多出「⇢ Webhook」也会红
    //（mutation 靶：把筛选项数据源换回 TRIGGERS 全表，这里立刻红）。
    expect(opts).toEqual(["✎ 调试", "▶ 手动", "◷ 定时", "✦ Pilot"]);
    // 另一半边：徽标查 TRIGGERS 全表。库里存了 webhook 就画词表值；
    // 降级成 "? webhook" 是把已经发生的事演成不认识，方向相反但同类，同样不许。
    const badges = screen.getAllByTestId("run-trigger").map((n) => n.textContent);
    expect(badges).toContain("⇢ Webhook");
    expect(badges).not.toContain("? webhook");
    expect(badges).toContain("✎ 调试"); // 正对照：可承诺值照旧画友好文案
  });

  it("选「◷ 定时」→ 列表请求真的带 trigger=schedule（可承诺项不是摆设）", async () => {
    mockBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    await openSelectOptions("runs-filter-trigger");
    await clickOption("◷ 定时");
    await waitFor(() => expect(listCalls().some((c) => c.url.includes("trigger=schedule"))).toBe(true));
  });
});

describe("② 对象类型 Tag（R112 宁可生码，不可撒谎）", () => {
  it("ui_case → 「UI 用例」（老三元会贴成「接口」）；词表外 code 原样直出，绝不回落成友好标签", async () => {
    mockBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-subject-type").length).toBe(3));
    const tags = screen.getAllByTestId("run-subject-type").map((n) => n.textContent);
    // 行序 = ROWS 序：api_case 词表值 / ui_case 词表值 / 词表外原样
    expect(tags).toEqual(["用例", "UI 用例", "quantum_thing"]);
    // 「接口」压根不该出现：api_definition 没在这一页出现，出现即说明词表外回落了
    expect(tags).not.toContain("接口");
  });
});

describe("③ 故障 ≠ 空数据（403 摊开说，不演「暂无记录」）", () => {
  it("列表 403：警示卡「运行记录没取到」上屏，正常空态引导文案不在 DOM", async () => {
    mockBackend({ listStatus: 403 });
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("运行记录没取到")).not.toBeNull());
    // 「把故障演成空数据」的反面：正常空态那句引导用户去调试的文案必须消失
    expect(screen.queryByText(/还没有运行记录/)).toBeNull();
    expect(screen.getByTestId("runs-empty-hint").textContent).toBe("暂时取不到记录");
  });

  it("正常空集：空态引导在、警示卡不出现（没故障别喊故障——反向半边）", async () => {
    mockBackend({ pages: [{ items: [], next_cursor: null }] });
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("runs-empty-hint")).not.toBeNull());
    expect(screen.getByTestId("runs-empty-hint").textContent)
      .toBe("还没有运行记录，去接口管理点一次「调试」就会出现在这里");
    expect(screen.queryByText("运行记录没取到")).toBeNull();
  });
});

describe("④ run-time 走 fmtTime（R68：UTC 存储 / 东八区展示）", () => {
  it("UTC ISO 渲染成东八区墙钟 11:24:05，而不是 slice(0,19) 的 UTC 钟点；null → 「—」", async () => {
    mockBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-time").length).toBe(3));
    const times = screen.getAllByTestId("run-time").map((n) => n.textContent);
    // 期望值是手写死的锚（timefmt.test.ts 的 R68 实测数据），不复用 fmtTime 实现
    expect(times[0]).toBe(SHANGHAI);
    expect(times[0]).not.toBe(UTC_ISO.slice(0, 19)); // 截断出来的 03:24 形状正则测不出来
    expect(times[2]).toBe("—"); // null created_at 画「—」，不编假时刻
  });
});

describe("页码分页 ListPager（D47-b）：current / total 的线上形状与替换语义", () => {
  /** 挂载后等行落地，再给回路一个观察窗——「恰好一条列表请求」是 D127 的页码版绊线。
   *  取数落地若把 load 的依赖改脏（load 自己写的那份 items 曾被放进依赖），就是
   *  响应→新 items→load 换身份→effect 重跑→再请求 的无限回路。没有这条绊线，回路会
   *  把测试转到超时后被 worker 掐死（CI 只留一句 tinypool onUnexpectedExit）；有了它，
   *  300ms 观察窗当场红一句 expected length 1。 */
  async function renderAndSettle(rows = 3): Promise<number> {
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(rows));
    await new Promise((r) => setTimeout(r, 300));
    expect(listCalls()).toHaveLength(1);
    return listCalls().length;
  }
  /** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
  function pager(): HTMLElement {
    return screen.getByTestId("list-pager");
  }
  function clickPage(n: number): void {
    fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
  }
  /** 展开档位下拉并按数字前缀点其中一项（口径同 reports.filters.test.tsx pickPagerSize）。 */
  async function pickPagerSize(prefix: string): Promise<void> {
    const sel = pager().querySelector(
      ".ant-pagination-options-size-changer .ant-select-selector",
    ) as HTMLElement;
    fireEvent.mouseDown(sel);
    const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
    await waitFor(() => expect(
      Array.from(document.querySelectorAll(contents))
        .some((n) => (n.textContent ?? "").startsWith(prefix))).toBe(true));
    const opt = Array.from(document.querySelectorAll(contents))
      .find((n) => (n.textContent ?? "").startsWith(prefix)) as Element;
    fireEvent.click(opt);
  }
  /** 「刷新」是两汉字按钮（AntD 插空格），不拿文本当锚点。
   *  2026-11-21 图标切到 Lucide 后不再产生 `.anticon-reload` 类名——改用按钮自己的
   *  data-testid 定位（比图标类名更稳：换图标库不该让测试红）。 */
  function clickRefresh(): void {
    fireEvent.click(screen.getByTestId("runs-refresh"));
  }
  /** 表内行 id = 当前表格真实渲染的行（替换/追加语义只能从 DOM 看出来）。 */
  function rowIds(): string[] {
    return screen.getAllByTestId("run-row").map((n) => n.getAttribute("data-run-id") ?? "");
  }
  /** 137 条/20 一页共 7 页：够点到第 3 页，也让「共 137 条」对不上屏上 2 行（total 不许由行数现攒）。 */
  const pages137 = {
    pages: [
      { items: [run("a"), run("b")], next_cursor: null, total: 137 },
      { items: [run("g"), run("h")], next_cursor: null, total: 137 },
    ],
  };

  it("响应 total=137 → 页脚「共 137 条」（表里只有 2 行）；每条请求都带 current，任何一条都不带 cursor", async () => {
    // 共 137 条 vs 表里 2 行：数字对不上正是「total 只从响应来、不由行数现攒」的证明
    mockBackend(pages137);
    await renderAndSettle(2);
    expect(pager().textContent).toContain("共 137 条");
    expect(listCalls().length).toBeGreaterThan(0); // 正对照：不是整块渲染了个寂寞
    for (const c of listCalls()) {
      const q = new URLSearchParams(c.url.slice(c.url.indexOf("?") + 1));
      expect(q.get("current")).toBe("1");
    }
    // 游标键在任何一条请求上都不许出现（后端 current+cursor 同传必 400）
    expect(listCalls().some((c) => new URLSearchParams(c.url.slice(c.url.indexOf("?") + 1)).has("cursor"))).toBe(false);
  });

  it("点第 3 页：恰好一条 current=3 请求（D127 换皮），行是替换不是追加", async () => {
    // 取数落地若把 load 的依赖改脏（如 items 进依赖），setItems → load 换身份 →
    // effect 重跑 → 多一条重置请求把第 3 页掀回第 1 页。这里数请求条数：
    // 点一次页码 = before+1 条，多一条都红。
    mockBackend(pages137);
    const before = await renderAndSettle(2);
    clickPage(3);
    const q = await lastQuery(before);
    expect(q.get("current")).toBe("3");
    expect(q.has("cursor")).toBe(false);
    // 替换语义：a/b 必须下桌（append 变异这里 4 行、前页还挂着）
    await waitFor(() => expect(rowIds()).toEqual(["g", "h"]));
    // 受控闭环：current 回写到 3，高亮跟过来
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
    // 迟到的重置请求也要抓到：替换落地后请求总数仍恰好 before+1
    expect(listCalls().length).toBe(before + 1);
  });

  it("停在第 3 页改筛选（对象类型/触发/状态）→ 下一条请求 current=1", async () => {
    // 三个筛选各来一遍，每次都先回到第 3 页再改——reset 必须是筛选写入口的不变量，
    // 不是某条路径的巧合。变异靶：patch 里删 setCurrent(1) → 三条全红。
    mockBackend(pages137);
    await renderAndSettle(2);
    const cases: Array<[string, string, (q: URLSearchParams) => void]> = [
      ["runs-filter-subject-type", "UI 用例", (q) => expect(q.get("subject_type")).toBe("ui_case")],
      ["runs-filter-trigger", "◷ 定时", (q) => expect(q.get("trigger")).toBe("schedule")],
      ["runs-filter-status", "排队中", (q) => expect(q.get("status")).toBe("queued")],
    ];
    for (const [testid, label, expectFilterParam] of cases) {
      const atPage = listCalls().length; // 基线必须在点页码**前**取
      clickPage(3);
      const landed = await lastQuery(atPage);
      expect(landed.get("current")).toBe("3"); // 正对照：确实停在第 3 页，reset 才有东西可回
      const beforePick = listCalls().length;
      await openSelectOptions(testid);
      await clickOption(label);
      const q = await lastQuery(beforePick);
      expect(q.get("current")).toBe("1"); // 改筛选后落回第 1 页
      expectFilterParam(q); // 正对照：筛选参数与 current=1 同时在线，不是筛选没生效的假回页
      // 页码高亮同步回 1（受控回写，不只是请求里改了口）
      expect(pager().querySelector(".ant-pagination-item-1.ant-pagination-item-active")).toBeTruthy();
    }
  });

  it("停在第 3 页点「刷新」→ 重发的是 current=3，不是回第 1 页", async () => {
    mockBackend(pages137);
    await renderAndSettle(2);
    const atPage = listCalls().length;
    clickPage(3);
    const landed = await lastQuery(atPage);
    expect(landed.get("current")).toBe("3"); // 正对照：刷新前先确实停在第 3 页
    const before = listCalls().length;
    clickRefresh();
    await waitFor(() => expect(listCalls().length).toBe(before + 1));
    const q = new URLSearchParams(listCalls()[listCalls().length - 1].url.slice(
      listCalls()[listCalls().length - 1].url.indexOf("?") + 1));
    expect(q.get("current")).toBe("3");
    // 刷新不许顺手把用户弹回第 1 页：页码高亮原地不动
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
  });

  it("停在第 3 页换 50/页 → 线上一条 size=50&current=1（换档位必回第 1 页，AntD 钳过的页码不上线）", async () => {
    // 137 条：20/页停第 3 页，换 50/页 AntD 会自己钳出 onChange(2, 50)——
    // 页面若把那个 2 转发上线（绕过 ListPager 的 onPage(1)），这条的红就在 current 上。
    mockBackend(pages137);
    await renderAndSettle(2);
    const atPage = listCalls().length;
    clickPage(3);
    const landed = await lastQuery(atPage);
    expect(landed.get("current")).toBe("3"); // 正对照：换档位前确实停在第 3 页
    const before = listCalls().length;
    await pickPagerSize("50");
    await waitFor(() => expect(listCalls().length).toBe(before + 1));
    const q = new URLSearchParams(listCalls()[listCalls().length - 1].url.slice(
      listCalls()[listCalls().length - 1].url.indexOf("?") + 1));
    expect(q.get("size")).toBe("50");
    expect(q.get("current")).toBe("1");
  });

  it("响应没有 total 键（后端游标式形状）→ 页脚整块不渲染，不挂假「共 0 条」", async () => {
    mockBackend(); // 默认 pages 不带 total 键——真实形状，不是显式 null
    await renderAndSettle(3);
    expect(screen.queryByTestId("list-pager")).toBeNull();
  });

  it("取数失败不留谎脚注：先「共 137 条」落地，刷新失败后分页器整块消失", async () => {
    const backend = mockBackend(pages137);
    await renderAndSettle(2);
    expect(pager().textContent).toContain("共 137 条");
    backend.listStatus = 403; // 挂载后翻故障：模拟「上一秒还好、这一秒取不到」
    clickRefresh();
    await waitFor(() => expect(screen.getByText("运行记录没取到")).not.toBeNull());
    // 空表上面不许挂着陈旧的「共 137 条」——total 必须随失败清空
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(screen.queryByText("共 137 条")).toBeNull();
  });
});

describe("详情按钮（GET /runs/{id}?project_id= 后开抽屉，复用 DebugPanel）", () => {
  it("点击 → GET /api/v1/runs/r1?project_id=p1；抽屉里请求快照与 debug-panel 同屏", async () => {
    mockBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-detail").length).toBe(3));
    fireEvent.click(screen.getAllByTestId("run-detail")[0]); // r1
    await waitFor(() => expect(screen.getByTestId("run-request")).not.toBeNull());
    const c = calls.find((x) => x.url === "/api/v1/runs/r1?project_id=p1");
    expect(c?.method).toBe("GET");
    expect(screen.getByTestId("run-request").textContent).toContain("/demo/ping");
    // 「现场」与「档案」同一套渲染：抽屉里就是调试页那块 DebugPanel
    expect(screen.getByTestId("debug-panel")).not.toBeNull();
  });
});

// R22-修复5：场景/UI/ADB 运行的逐条断言只写在 run_step_result.detail，run_record.assertions
// 恒空（save_run 只有接口调试路径写它）。抽屉顶着一枚「断言失败」的状态徽标，再在断言徽标
// 上说「本次没有执行任何断言」，就是同一块面板里自己打自己。零行在这里只能说「没带行」。
describe("断言徽标分「记录没带行」与「真没跑断言」两种零行", () => {
  async function openDrawer(detail: unknown): Promise<void> {
    renderWithBench(detail);
    await waitFor(() => expect(screen.getAllByTestId("run-detail").length).toBe(3));
    fireEvent.click(screen.getAllByTestId("run-detail")[0]);
    await screen.findByTestId("debug-panel");
  }

  it("场景运行 failed + 记录零断言行 → 「断言明细在步骤里」，「未校验」那句假话不在 DOM", async () => {
    await openDrawer({
      ...run("r1", { subject_type: "scenario", status: "failed", status_code: 200 }),
      request_snapshot: { method: "GET", path: "/demo/ping" },
      response_snapshot: { headers: {}, body_text: "{}", truncated: false, body_size: 2 },
      assertions: [],
    });
    expect(screen.getByTestId("debug-assert-unknown").textContent).toContain("断言明细在步骤里");
    expect(screen.queryByTestId("debug-assert-none")).toBeNull();
    // 状态徽标与断言徽标此刻必须同调：都指「断言有败、明细在别处」，不指「没跑断言」
    expect(screen.getByText("断言失败")).not.toBeNull();
  });

  it("接口用例 failed + 零断言行 → 仍是「未校验」：save_run 真写了这列，零行就是真没配/全停用", async () => {
    // 变异靶：API_DEBUG_SUBJECTS 摘掉 api_case → 这行翻成「断言明细在步骤里」红
    //（接口调试的逐条断言就在 record 里，没有「步骤」可去，改口就是新假话）。
    await openDrawer({
      ...run("r1", { subject_type: "api_case", status: "failed", status_code: 500 }),
      request_snapshot: { method: "GET", path: "/demo/ping" },
      response_snapshot: { headers: {}, body_text: "{}", truncated: false, body_size: 2 },
      assertions: [],
    });
    expect(screen.getByTestId("debug-assert-none").textContent).toContain("未校验");
    expect(screen.queryByTestId("debug-assert-unknown")).toBeNull();
  });
});

// 响应体「已截断」标注的页级半边。后端 execution/core.py:17 `MAX_BODY_CHARS = 1_000_000`、
// 同文件 `truncated = len(text) > MAX_BODY_CHARS`（现 109-111）超量才置 truncated，
// execution/services.py 的 `"truncated": result.truncated`（现 229）把它写进 response_snapshot；
// runs.tsx:44 truncated: Boolean(snap.truncated) 喂 DebugPanel，DebugPanel.tsx:156 拼
// 「响应体（已截断）」。DebugPanel.test.tsx:122 钉的是组件侧，而本文件此前 6 处
// response_snapshot fixture 一律 truncated: false（:58/:253/:268/:303/:324/:337），
// 这四个字在 runs 页级从没画过。两向同钉：render 写死任一侧都会红。
describe("详情抽屉响应体折叠标题的「（已截断）」两向", () => {
  it("truncated=true 的运行 → 抽屉折叠标题写「响应体（已截断）」；truncated=false 的只有「响应体」", async () => {
    // 真值形状：body_size 1234567 > MAX_BODY_CHARS，body_text 是截到 100 万字符的样例头
    renderWithBench({
      ...run("r1", { status: "passed" }),
      request_snapshot: { method: "GET", path: "/demo/ping" },
      response_snapshot: { headers: {}, body_text: '{"a":"' + "x".repeat(64) + '"}',
        truncated: true, body_size: 1234567 },
      assertions: [],
    });
    await waitFor(() => expect(screen.getAllByTestId("run-detail").length).toBe(3));
    fireEvent.click(screen.getAllByTestId("run-detail")[0]);
    await screen.findByTestId("debug-panel");
    expect(screen.getByText("响应体（已截断）")).not.toBeNull();
    // 两个标题不许同时在屏上（拼错成前后双份也会红）
    expect(screen.queryByText("响应体")).toBeNull();

    cleanup();
    renderWithBench({
      ...run("r1", { status: "passed" }),
      request_snapshot: { method: "GET", path: "/demo/ping" },
      response_snapshot: { headers: {}, body_text: '{"a":1}', truncated: false, body_size: 7 },
      assertions: [],
    });
    await waitFor(() => expect(screen.getAllByTestId("run-detail").length).toBe(3));
    fireEvent.click(screen.getAllByTestId("run-detail")[0]);
    await screen.findByTestId("debug-panel");
    expect(screen.getByText("响应体").textContent).toBe("响应体");
    expect(screen.queryByText("响应体（已截断）")).toBeNull();
  });
});

// 蓝图 :1426「调试失败 → 让 Pilot 分析（带响应体）」在运行记录侧的落点。
// 运行记录是失败现场回看的主要去处，抽屉里的 DebugPanel 拿到 subject 后才给这个出口。
// 落点页用 reportDetail.test.tsx:131 的 BenchLand 手法读 location.state——抓的是真路由
// 传过去的 state 对象，不是 spy 的调用参数：这样断的是「预填真能落到 Pilot 输入框那条路」。
function BenchLand() {
  const loc = useLocation();
  const draft = (loc.state as { pilotDraft?: string } | null)?.pilotDraft ?? "";
  return <div data-testid="landed-bench">{draft}</div>;
}

function renderWithBench(detail: unknown) {
  mockBackend({ detail });
  return render(
    <MemoryRouter initialEntries={["/runs"]}>
      <Routes>
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/bench" element={<BenchLand />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("详情抽屉的「让 Pilot 分析」（蓝图 :1426）", () => {
  it("status=error 的运行：草稿带对象名与逐字响应体，且落在 /bench 的 state 里", async () => {
    renderWithBench({
      ...run("r1", { status: "error", status_code: null, subject_name: "下单用例" }),
      request_snapshot: { method: "GET", path: "/demo/ping" },
      response_snapshot: { headers: {}, body_text: '{"err":" upstream 502"}', truncated: false, body_size: 21 },
      assertions: [{ type: "status_code", expected: 200, passed: false, actual: 502 }],
      error: "断言未通过",
    });
    await waitFor(() => expect(screen.getAllByTestId("run-detail").length).toBe(3));
    fireEvent.click(screen.getAllByTestId("run-detail")[0]);
    const btn = await screen.findByTestId("debug-ask-pilot");
    fireEvent.click(btn);
    const landed = await screen.findByTestId("landed-bench");
    expect(landed.textContent).toContain("对象：下单用例");
    expect(landed.textContent).toContain("报错：断言未通过");
    expect(landed.textContent).toContain('{"err":" upstream 502"}'); // 「带响应体」逐字
    expect(landed.textContent).toContain("[败] status_code · 期望 200 · 实际 502");
    // request_snapshot 的形状不足以还原当时真实发出的一行，宁缺不编
    expect(landed.textContent).not.toContain("请求：");
  });

  it("passed 的运行不给出口：全过没得分析，摆钮是假门", async () => {
    renderWithBench({
      ...run("r1", { status: "passed" }),
      request_snapshot: null,
      response_snapshot: { headers: {}, body_text: "{}", truncated: false, body_size: 2 },
      assertions: [],
    });
    await waitFor(() => expect(screen.getAllByTestId("run-detail").length).toBe(3));
    fireEvent.click(screen.getAllByTestId("run-detail")[0]);
    await screen.findByTestId("debug-panel");
    expect(screen.queryByTestId("debug-ask-pilot")).toBeNull();
  });

  it("草稿用快照名（D141）：契约收紧后没有任何一格能长出「对象：null」或假兜底", async () => {
    // 旧用例喂 subject_name=null 断言屏上出「（对象已删除）」——那是给不可达的分支续命：
    // 列 NOT NULL（execution/models.py:22，「对象删除后仍可读」），API 永远给得出名字。
    // 收紧后 null 连类型都进不来；这里改断真契约：草稿名 = 快照名，且假句绝迹。
    renderWithBench({
      ...run("r2", { status: "error", subject_name: "被删接口的快照名" }),
      request_snapshot: null,
      response_snapshot: { headers: {}, body_text: null, truncated: false, body_size: 0 },
      assertions: [],
    });
    await waitFor(() => expect(screen.getAllByTestId("run-detail").length).toBe(3));
    fireEvent.click(screen.getAllByTestId("run-detail")[0]);
    const btn = await screen.findByTestId("debug-ask-pilot");
    fireEvent.click(btn);
    const landed = await screen.findByTestId("landed-bench");
    expect(landed.textContent).toContain("对象：被删接口的快照名");
    expect(landed.textContent).not.toContain("对象：null");
    expect(landed.textContent).not.toContain("对象已删除");
  });
});

describe("零引用 testid 补账：runs-body / runs-filters / runs-empty", () => {
  /** 参数感知假后端：按 status/trigger/subject_type 过滤 ROWS——筛掉谁，屏上就少谁。 */
  function mockFilteringBackend(): void {
    calls.length = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: undefined });
      if (url.includes("/filter-meta?")) {
        return { ok: true, status: 200, json: async () => FILTER_META } as unknown as Response;
      }
      if (url.includes("/saved-views?")) {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      const q = new URL(url, "http://x").searchParams;
      const items = ROWS.filter((r) => (["subject_type", "trigger", "status"] as const)
        .every((k) => !q.get(k) || r[k] === q.get(k)));
      return { ok: true, status: 200, json: async () => ({ items, next_cursor: null }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const BASE_URL = "/api/v1/runs?project_id=p1&size=20&current=1";

  it("runs-filters：三下拉+刷新按 对象类型→触发→状态→刷新 序挂在 marginBottom=12px+wrap 的 Space 上；选「排队中」→ 只发带 status=queued 的精确 URL 且屏上只剩 r2，点 × 清空 → URL 回到裸基串、三行回来", async () => {
    // 变异靶：删 wrap（flexWrap 变 "" 红）· marginBottom 改 24（红）· 挪动三个 Select 的
    // 顺序（toEqual 的序红）· onChange 不接 setState / 参数名漂移（精确 URL 相等红）
    mockFilteringBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    expect(listCalls()[0].url).toBe(BASE_URL);
    const space = screen.getByTestId("runs-filters");
    expect(space.style.marginBottom).toBe("12px");
    expect(space.style.flexWrap).toBe("wrap");
    const kids = Array.from(space.children);
    // 第四个槽位认 testid 而不是文本「刷新」：2026-11-21 刷新钮加了 runs-refresh 这个
    // data-testid（图标从 antd 换 Lucide 后，原先按 .anticon-reload 找它的两处测试改认它）。
    // 顺序契约不变：对象类型 → 触发 → 状态 → 刷新。
    expect(kids.map((n) => n.querySelector("[data-testid]")?.getAttribute("data-testid") ?? n.textContent))
      .toEqual(["runs-filter-subject-type", "runs-filter-trigger", "runs-filter-status", "runs-refresh"]);

    // 有筛选的一侧：参数进请求、行集跟着收缩（假后端真按 status 过滤，屏上不许有漏网的）
    await openSelectOptions("runs-filter-status");
    await clickOption("排队中");
    await waitFor(() => expect(
      screen.getAllByTestId("run-row").map((n) => n.getAttribute("data-run-id"))).toEqual(["r2"]));
    expect(listCalls()[listCalls().length - 1].url).toBe(BASE_URL + "&status=queued");
    // 撤筛选的一侧：× 清空后参数必须整体撤掉（残留 status= 会把 3 行筛成 1 行）
    fireEvent.mouseDown(screen.getByTestId("runs-filter-status").querySelector(".ant-select-clear")!);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    expect(listCalls()[listCalls().length - 1].url).toBe(BASE_URL);
  });

  it("runs-body：筛选区→run-row 行→分页器依序全在它体内；没选项目时整个 body 缺席、给「先在工作台选项目」且一次 /runs 都不发", async () => {
    // 变异靶：把 list-pager 块挪到 Table 之前（相邻先后断言红）· 把 Table 挪出这个 div
    //（body.contains 红）· ProjectGate 守卫翻掉让无项目也发列表请求（第二侧红）
    mockBackend({ pages: [{ items: [run("a"), run("b")], next_cursor: null, total: 42 }] });
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(2));
    const body = screen.getByTestId("runs-body");
    const marks = [screen.getByTestId("runs-filters"),
      ...screen.getAllByTestId("run-row"), screen.getByTestId("list-pager")];
    for (const m of marks) expect(body.contains(m)).toBe(true);
    for (let i = 0; i < marks.length - 1; i++) {
      // 严格先后：筛选区在前、行居中、分页器垫底（DOM 顺序 = 页面读序）
      expect(!!(marks[i].compareDocumentPosition(marks[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    }
    // 第二侧：ProjectGate 守卫——没项目就没有 body，更没有「猜一个项目」的列表请求
    cleanup();
    mockBackend();
    useAuth.setState({ project: null });
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("no-project")).not.toBeNull());
    expect(screen.getByTestId("no-project").textContent).toContain("先在工作台选项目");
    expect(screen.queryByTestId("runs-body")).toBeNull();
    expect(listCalls().length).toBe(0);
  });

  it("runs-empty：有行时 0 个、空集时恰好 1 个且描述是「去调试」引导；403 时文案换成「暂时取不到记录」——一套 Empty 两种文案按状态分派", async () => {
    // 变异靶：:163 的 failed 三元反向（两侧文案同时红）· 描述硬编码一种文案（另一侧红）·
    // 无条件多挂一个 Empty（「有行时 0 个」红）
    mockBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    expect(screen.queryAllByTestId("runs-empty")).toHaveLength(0);

    cleanup();
    mockBackend({ pages: [{ items: [], next_cursor: null }] });
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("runs-empty").length).toBe(1));
    expect(screen.queryAllByTestId("run-row")).toHaveLength(0);
    expect(screen.getByTestId("runs-empty").querySelector(".ant-empty-description")!.textContent)
      .toBe("还没有运行记录，去接口管理点一次「调试」就会出现在这里");

    cleanup();
    mockBackend({ listStatus: 403 });
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(
      screen.getByTestId("runs-empty").querySelector(".ant-empty-description")!.textContent)
      .toBe("暂时取不到记录"));
    expect(screen.queryAllByTestId("run-row")).toHaveLength(0);
  });
});

// D123 的另一半：adbCaseDetail「执行」跳 /runs?run=<id>，此前 runs.tsx 对 ?run= 零读取
// （useSearchParams 全页 grep = 0），参数被静默吞掉。现在 runs 是诚实消费者：行在第一页
// → 高亮 + 点名横幅；不在 → 「不在这页里」明说；没参数 → 什么都不多渲染。
// 形状同 schedules/notifyChannels 的 ?q= 落点（pickDeepLinkHit 同款纯函数同套钉法）。
describe("D242 高级搜索 + 列设置（三件套铺到运行记录）", () => {
  const listReqs = () => calls.filter((c) => c.url.includes("/runs?"));
  const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";

  it("空条件不拼 filter；应用「对象名称包含 登录」后请求带条件 JSON，且从第 3 页回第 1 页", async () => {
    // 变异靶：load 不接 advFilter（第二条请求无 filter）· 条件变化不回第 1 页
    //（current 仍为 3）· 空条件也拼 filter=（第一条请求带 filter=）
    mockBackend({ pages: [
      { items: [run("a"), run("b")], next_cursor: null, total: 60 },
      { items: [run("c")], next_cursor: null, total: 60 },
    ] });
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(2));
    expect(listReqs()[0].url).not.toContain("filter="); // 「没筛选」不该写成骗人的 filter=
    // 先到第 3 页，证明条件变化真有「回第 1 页」这件事可做
    fireEvent.click(screen.getByTestId("list-pager").querySelector(".ant-pagination-item-3 a") as Element);
    await waitFor(() => expect(new URL(listReqs()[listReqs().length - 1].url, "http://x")
      .searchParams.get("current")).toBe("3"));
    const before = listReqs().length;
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    // 字段名来自后端 meta 的第一项（subject_name），前端不自列字段
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const q = new URL(listReqs()[listReqs().length - 1].url, "http://x").searchParams;
    expect(JSON.parse(q.get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "subject_name", operator: "CONTAINS", value: "登录" }],
    });
    expect(q.get("current")).toBe("1"); // 条件一变必回第 1 页
  });

  it("列设置勾掉「环境」只藏那一列（其余表头原样）", async () => {
    // 变异靶：columns 不包 applyColumnPrefs（勾了没反应）· key 与 CHOICES 漂移（藏错列）
    mockBackend();
    render(<MemoryRouter><RunsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    expect(thead()).toContain("环境");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["时间", "对象", "触发", "状态", "响应码", "耗时", "环境", "执行人"]);
    fireEvent.click(boxes[labels.indexOf("环境")]);
    await waitFor(() => expect(thead()).not.toContain("环境"));
    expect(thead()).toContain("执行人");
  });
});

describe("pickDeepLinkHit（?run=<id> 认行的纯判断，无 DOM）", () => {
  it("id 在已加载行里才认；不在/为空/列表没加载完一律 null", () => {
    expect(pickDeepLinkHit(ROWS, "r2")).toBe("r2");
    expect(pickDeepLinkHit(ROWS, "r404")).toBeNull();
    expect(pickDeepLinkHit(ROWS, null)).toBeNull();
    expect(pickDeepLinkHit(ROWS, "")).toBeNull();
    expect(pickDeepLinkHit([], "r1")).toBeNull(); // 列表还没加载完
  });
});

describe("?run=<id> 深链落点（adbCaseDetail 执行后的跳转真有人接）", () => {
  function renderAt(entry: string) {
    return render(<MemoryRouter initialEntries={[entry]}><RunsPage /></MemoryRouter>);
  }

  it("?run=r2：横幅点名 + 该行 tp-row-hit、别行不带；点 × 关闭后横幅与高亮一起消失", async () => {
    mockBackend();
    renderAt("/runs?run=r2");
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    const banner = await screen.findByTestId("runs-deeplink");
    expect(banner.textContent).toContain("运行 r2 就在下表");
    expect(banner.querySelector(".ant-alert-close-icon")).not.toBeNull();
    const rows = screen.getAllByTestId("run-row");
    const hit = rows.find((r) => r.className.includes("tp-row-hit"))!;
    expect(hit.getAttribute("data-run-id")).toBe("r2");
    // 恰好一行高亮：别行都是空 class（假高亮 = 满屏皆「命中」）
    for (const r of rows) {
      if (r !== hit) expect(r.className).not.toContain("tp-row-hit");
    }
    // 关闭：横幅撤、高亮也撤（只撤横幅留下高亮，等于关不掉的暗桩）
    fireEvent.click(banner.querySelector(".ant-alert-close-icon")!);
    await waitFor(() => expect(screen.queryByTestId("runs-deeplink")).toBeNull());
    expect(document.querySelector(".tp-row-hit")).toBeNull();
  });

  it("?run=zz9（第一页没有这条）：诚实横幅「不在这页里——点右上「刷新」或减少筛选」，屏上零高亮；关闭生效", async () => {
    mockBackend();
    renderAt("/runs?run=zz9");
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    const banner = await screen.findByTestId("runs-deeplink");
    expect(banner.textContent).toContain("zz9 不在这页里——点右上「刷新」或减少筛选");
    // 不假高亮：找不到时一行都不许带命中类
    expect(document.querySelector(".tp-row-hit")).toBeNull();
    fireEvent.click(banner.querySelector(".ant-alert-close-icon")!);
    await waitFor(() => expect(screen.queryByTestId("runs-deeplink")).toBeNull());
  });

  it("无 ?run= 参数：不渲染任何深链横幅（对照腿——横幅不许无条件挂）", async () => {
    mockBackend();
    renderAt("/runs");
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(3));
    expect(screen.queryByTestId("runs-deeplink")).toBeNull();
    expect(document.querySelector(".tp-row-hit")).toBeNull();
  });

  it("翻页补上真身（D47-b 页码版）：miss 横幅在第 3 页的行出现后翻成「就在下表」并高亮——横幅不赖在假话上", async () => {

    // 第 1 页没有 zz，第 3 页才是 zz；变异靶：认行只跑一次（一次性 latch）→ 翻页后不重认，红
    mockBackend({ pages: [
      { items: [run("a"), run("b")], next_cursor: null, total: 60 },
      { items: [run("zz")], next_cursor: null, total: 60 },
    ] });
    renderAt("/runs?run=zz");
    await waitFor(() => expect(screen.getAllByTestId("run-row").length).toBe(2));
    await waitFor(() => expect(screen.getByTestId("runs-deeplink").textContent)
      .toContain("zz 不在这页里"));
    fireEvent.click(screen.getByTestId("list-pager").querySelector(".ant-pagination-item-3 a") as Element);
    await waitFor(() => expect(screen.getAllByTestId("run-row").map((n) => n.getAttribute("data-run-id")))
      .toEqual(["zz"]));
    await waitFor(() => expect(screen.getByTestId("runs-deeplink").textContent)
      .toContain("zz 就在下表"));
    const rows = screen.getAllByTestId("run-row");
    expect(rows.find((r) => r.className.includes("tp-row-hit"))!.getAttribute("data-run-id")).toBe("zz");
  });
});
