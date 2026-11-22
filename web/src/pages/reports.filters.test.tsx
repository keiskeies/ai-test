// 报告中心筛选条的「控件 → 线上参数」测试（测试债第十五轮，轴③ 零引用 testid）。
//
// 为什么这一页要这么写：reports.tsx 的七个筛选项全都只 `patch({...})` 改本地 state，
// 真正的合同在 load()（:89-110）——它把 f 翻成 query 再交给 reportApi.list。
// 「点了下拉，state 变了」是假断言：state 变了而后端没收到参数，用户看到的就是
// 一扇假门。所以本页全部断言押在 **fetch 收到的 URL 字符串**上（reportApi.list 也走
// 同一个 global.fetch），每条都问「线上到底有没有这个键、值是不是 id 而不是展示名」。
// 手法同 reports.test.tsx / schedules.test.tsx：matchMedia 补丁 + useAuth.setState +
// 未 mock 的 URL 直接 throw（静默返回 undefined 会把「漏 mock」演成「页面正常」）。
//
// D47-b 退役记录：原「加载更多 reports-more：游标 + 追加语义」三条随按钮一起删除——本页
// 已按设计去掉游标追加，改 page 模式（一页两把尺子的老账）；游标路径本身仍有后端测试钉字节
// 同一（backend/tests/test_d47b_report_page.py），D127 的 bug 类（取数落地触发 effect 重跑）
// 换皮成「点第 3 页恰好一条请求」继续钉。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// useNavigate 换成可断言的 spy（口径同 adbDevices.test.tsx:11-15：其余导出走真实现，
// ProjectGate 也用 useNavigate，不能整体断掉）。
const navSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navSpy,
}));

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

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

function row(id: string, over: Partial<ReportRow> = {}): ReportRow {
  return {
    id, subject_name: "下单链路", subject_type: "scenario", trigger: "manual",
    env_name: null, created_by_name: "张三", status: "passed",
    stats: { total: 2 }, pass_rate: 1, elapsed_ms: 100,
    started_at: "2026-11-16T10:00:00", ...over,
  };
}

const PAGE1 = { items: [row("r1"), row("r2")], next_cursor: null as string | null, total: 2 };

/** 页码模式响应：total 可选——缺键就是后端游标式响应的真实形状，不是显式 null。 */
interface PageResp { items: ReportRow[]; next_cursor: string | null; total?: number | null }

interface Cfg {
  /** current 缺省或为 "1" 的请求出这一页；其余页码出 more，没配就重复 first。 */
  first?: PageResp;
  more?: PageResp;
  failReports?: boolean;
}

/** 页码模式公共响应工厂：total 只从响应来，测试里的「共 N 条」全靠它。 */
function page(items: ReportRow[], total: number): PageResp {
  return { items, next_cursor: null, total };
}

/** 每次 /reports 请求的原始 query string（含被 URLSearchParams 编码后的形状）。 */
let reportQueries: string[] = [];
let cfg: Cfg = {};

function installFetch(): void {
  reportQueries = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // 每次调用都现拷一份：真 fetch 每次解析出一棵**全新的对象图**，而这个桩以前把同一个
    // cfg.first 对象反复交出去 —— setItems(同一个数组引用) 会被 React 按同一性直接跳过，
    // 「取数落地把 load 的依赖改脏 → effect 重跑 → 无限请求」这类回路在线上必现、在这套
    // 桩下永远测不出（reports.tsx 的 load 依赖里一度真的多了 items，就是这个形状）。
    // 深拷一次的成本换的是「桩不许比真接口更好说话」。
    const resp = (json: unknown) =>
      ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(JSON.stringify(json)) as unknown,
      }) as unknown as Response;
    const plain = (items: unknown[]) => ({ items, next_cursor: null });
    if (url.includes("/reports?")) {
      reportQueries.push(url.slice(url.indexOf("?") + 1));
      if (cfg.failReports) throw new Error("网络不通（测试注入）");
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      // 页码模式：非第 1 页出 more；没配 more 就重复 first（后端最后一页之后的行为不归前端管）
      if (!q.get("current") || q.get("current") === "1") return resp(cfg.first ?? PAGE1);
      return resp(cfg.more ?? cfg.first ?? PAGE1);
    }
    if (url.includes("/scenarios?")) return resp(plain([{ id: "s1", name: "履约场景A" }]));
    if (url.includes("/envs?")) {
      return resp(plain([
        { id: "env-pre", project_id: "p1", name: "预发环境", position: 1, config: null },
        { id: "env-test", project_id: "p1", name: "测试环境", position: 2, config: null },
      ]));
    }
    if (url.includes("/members")) {
      return resp(plain([
        { user_id: "u-77", name: "李四", account: "lisi" },
        { user_id: "u1", name: "张三", account: "zhangsan" },
      ]));
    }
    throw new Error("未 mock 的请求: GET " + url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  navSpy.mockClear();
  cfg = {};
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
  installFetch();
});

/** 渲染 + 等首屏行落地，返回此刻已发出的 /reports 请求条数（后续断言以此为基线）。 */
async function renderAndSettle(rows = 2): Promise<number> {
  render(<MemoryRouter><ReportsPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByTestId("reports-row").length).toBe(rows));
  // D127 回路的绊线（页码版）：挂载稳定后 /reports 必须**恰好**一条。取数落地若把 load 的
  // 依赖改脏（曾经真发生过：依赖里多了 load 自己 setItems 写的那个 items），就是
  // 响应→新 items→load 换身份→effect 重跑→再请求 的无限回路。这里给它 300ms 观察窗，
  // 回路会在这段时间里把条数涨上去，绊线当场红——比让测试进程转到超时后被 worker 掐死
  // 好读得多（那种挂法 CI 上只留一句 tinypool onUnexpectedExit，看不出是谁的锅）。
  await new Promise((r) => setTimeout(r, 300));
  expect(reportQueries).toHaveLength(1);
  return reportQueries.length;
}

/** 展开指定 testid 的 Select，按文案点其中一项（口径同 reports.test.tsx:67-77）。 */
async function pickOption(testid: string, label: string): Promise<void> {
  const sel = screen.getByTestId(testid).querySelector(".ant-select-selector") as HTMLElement;
  fireEvent.mouseDown(sel);
  await waitFor(() => {
    const hit = Array.from(document.querySelectorAll(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content"))
      .some((n) => (n.textContent ?? "") === label);
    expect(hit).toBe(true);
  });
  const opt = Array.from(document.querySelectorAll(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content"))
    .find((n) => (n.textContent ?? "") === label) as Element;
  fireEvent.click(opt);
}

/** 浮层里当前可见的全部选项文案。 */
function visibleOptions(): string[] {
  return Array.from(document.querySelectorAll(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content"))
    .map((n) => n.textContent ?? "");
}

/** 等「比 before 更多的 /reports 请求」落地，返回最后一条的 query。 */
async function lastQuery(before: number): Promise<URLSearchParams> {
  await waitFor(() => expect(reportQueries.length).toBeGreaterThan(before));
  return new URLSearchParams(reportQueries[reportQueries.length - 1]);
}

/** daysAgoIso(:42) 的独立实现：分钟级 naive UTC，用于校验 since 的**数值**而不只是键。 */
function sinceDaysAgo(days: number, toleranceMs: number): [number, number] {
  const t = Date.now() - days * 86400_000;
  return [t - toleranceMs, t + toleranceMs];
}

describe("时间筛选 reports-filter-days：since 的正反两向", () => {
  it("默认「近 7 天」：每个 /reports 请求都带 since，且值是 7 天前的分钟级 naive UTC", async () => {
    await renderAndSettle();
    expect(reportQueries.length).toBeGreaterThan(0);
    const qs = reportQueries.map((q) => new URLSearchParams(q));
    // 正对照：每条请求都带着不带 since 就等价于「不限时间」的两个基础键
    for (const q of qs) {
      expect(q.get("project_id")).toBe("p1");
      expect(q.get("size")).toBe("20");
      const since = q.get("since");
      expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/); // 剥掉 Z 与秒（:44）
      const [lo, hi] = sinceDaysAgo(7, 120_000);
      const t = Date.parse((since as string) + "Z"); // naive 串按 UTC 解释（R62 口径）
      expect(t).toBeGreaterThanOrEqual(lo);
      expect(t).toBeLessThanOrEqual(hi);
    }
  });

  it("切「不限时间」→ 请求里 since 整体消失；再切「近 30 天」→ since 回来且是 30 天前", async () => {
    const base = await renderAndSettle();
    await pickOption("reports-filter-days", "不限时间");
    const q0 = await lastQuery(base);
    // 半条测试只证「键会出现」；这里证的是 value=0 时键**整个不在**（:94 的 f.days > 0）
    expect(q0.has("since")).toBe(false);
    expect(q0.get("project_id")).toBe("p1"); // 正对照：不是整条请求没发出去

    const base2 = reportQueries.length;
    await pickOption("reports-filter-days", "近 30 天");
    const q30 = await lastQuery(base2);
    const since = q30.get("since");
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const [lo, hi] = sinceDaysAgo(30, 120_000);
    const t = Date.parse((since as string) + "Z");
    expect(t).toBeGreaterThanOrEqual(lo);
    expect(t).toBeLessThanOrEqual(hi);
  });
});

describe("状态 / 环境 / 执行人：值必须原样落到线上参数", () => {
  it("结果下拉点「断言失败」→ status=failed（词表 key，不是中文标签）", async () => {
    const base = await renderAndSettle();
    await pickOption("reports-filter-status", "断言失败");
    const q = await lastQuery(base);
    expect(q.get("status")).toBe("failed");
    expect(reportQueries[reportQueries.length - 1]).not.toContain("断言失败");
  });

  it("环境下拉的 id 来自 /envs：点「预发环境」→ env_id=env-pre，不是环境名", async () => {
    const base = await renderAndSettle();
    await pickOption("reports-filter-env", "预发环境");
    expect(visibleOptions()).toContain("预发环境"); // 选项确实来自 /envs
    const q = await lastQuery(base);
    expect(q.get("env_id")).toBe("env-pre");
    expect(reportQueries[reportQueries.length - 1]).not.toContain("预发环境");
  });

  it("执行人点「李四」→ created_by=u-77：后端按 run.created_by 筛，value 只能是 user_id", async () => {
    const base = await renderAndSettle();
    await pickOption("reports-filter-creator", "李四");
    const q = await lastQuery(base);
    // 展示名与 id 同时可断言：下拉里是「李四」，线上必须是 u-77
    expect(q.get("created_by")).toBe("u-77");
    expect(reportQueries[reportQueries.length - 1]).not.toContain("李四");
    expect(reportQueries[reportQueries.length - 1]).not.toContain("lisi");
  });
});

describe("取数失败：reports-failed 的两半", () => {
  it("/reports 挂掉时，警告 Alert 与「暂时取不到报告」的空表文案同时成立", async () => {
    cfg = { failReports: true };
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("reports-failed")).toBeTruthy());
    // testid 落在 Alert 根节点本身（实测 DOM），警告语义 = 它自己的 ant-alert-warning
    expect(screen.getByTestId("reports-failed").classList.contains("ant-alert-warning")).toBe(true);
    // 另半边：表不能演成「还没有报告」（那是「确实没有」），要说「取不到」。
    // 实测 antd 5.29 把字符串 emptyText 直接渲染进占位单元格，没有 .ant-empty-description。
    const cell = within(screen.getByTestId("reports-body"))
      .getByRole("cell", { name: "暂时取不到报告" });
    expect(cell.textContent).toBe("暂时取不到报告");
    expect(screen.queryByText(
      "还没有报告（调试运行默认不显示，右上角「含调试」可看）")).toBeNull();
  });
});

describe("页码分页 ListPager：current / total 的线上形状（D47-b）", () => {
  /** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
  function pager(): HTMLElement {
    return screen.getByTestId("list-pager");
  }
  function clickPage(n: number): void {
    fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
  }
  /** 展开档位下拉并按数字前缀点其中一项（口径同 listPagination.test.tsx pickSize）。 */
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
    fireEvent.click(screen.getByTestId("reports-refresh"));
  }
  /** 表内行链接文案 = 当前表格真实渲染的行（替换/追加语义只能从 DOM 看出来）。 */
  function rowTexts(): string[] {
    return within(screen.getByTestId("reports-body"))
      .getAllByTestId("reports-row-link").map((n) => n.textContent ?? "");
  }

  it("响应 total=137 → 页脚「共 137 条」；每条请求都带 current，任何一条都不带 cursor", async () => {
    // 共 137 条 vs 表里 2 行：数字对不上正是「total 只从响应来、不由行数现攒」的证明
    cfg = { first: page([row("r1"), row("r2")], 137) };
    await renderAndSettle();
    expect(pager().textContent).toContain("共 137 条");
    expect(reportQueries.length).toBeGreaterThan(0); // 正对照：不是整块渲染了个寂寞
    for (const raw of reportQueries) {
      expect(new URLSearchParams(raw).get("current")).toBe("1");
    }
    // 游标键在整页的任何一条请求上都不许出现（后端 current+cursor 同传必 400）
    expect(reportQueries.some((raw) => new URLSearchParams(raw).has("cursor"))).toBe(false);
  });

  it("响应没有 total 键（后端游标式形状）→ 页脚整块不渲染，不挂假「共 0 条」", async () => {
    cfg = { first: { items: [row("r1"), row("r2")], next_cursor: null } };
    await renderAndSettle();
    expect(screen.queryByTestId("list-pager")).toBeNull();
  });

  it("点第 3 页：恰好一条 current=3 请求（D127 换皮），行是替换不是追加", async () => {
    // D127 的 bug 类在页码模式下的换皮：取数落地若把 load 的依赖改脏（如 total 进依赖），
    // setTotal → load 换身份 → effect 重跑 → 多一条重置请求把第 3 页掀回第 1 页。
    // 这里数请求条数：点一次页码 = before+1 条，多一条都红。
    cfg = {
      first: page([row("r1"), row("r2")], 137),
      more: page([row("r3", { subject_name: "退款链路" }), row("r4", { subject_name: "退款链路" })], 137),
    };
    const before = await renderAndSettle();
    clickPage(3);
    await waitFor(() => expect(reportQueries.length).toBe(before + 1));
    const q = new URLSearchParams(reportQueries[reportQueries.length - 1]);
    expect(q.get("current")).toBe("3");
    expect(q.has("cursor")).toBe(false);
    // 替换语义：r1/r2 必须下桌（append 变异这里是 4 行、前页还挂着）
    await waitFor(() => expect(rowTexts()).toEqual(["退款链路", "退款链路"]));
    // 受控闭环：current 回写到 3，高亮跟过来
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
    // 迟到的重置请求也要抓到：替换落地后请求总数仍恰好 before+1
    expect(reportQueries.length).toBe(before + 1);
  });

  it("停在第 3 页改筛选（天数/结果/环境）→ 下一条请求 current=1", async () => {
    cfg = {
      first: page([row("r1"), row("r2")], 137),
      more: page([row("r3"), row("r4")], 137),
    };
    await renderAndSettle();
    // 三个筛选各来一遍，每次都先回到第 3 页再改——reset 必须是筛选的不变量，不是某条路径的巧合
    const cases: Array<[string, string, (q: URLSearchParams) => void]> = [
      ["reports-filter-days", "近 30 天", (q) => expect(q.has("since")).toBe(true)],
      ["reports-filter-status", "断言失败", (q) => expect(q.get("status")).toBe("failed")],
      ["reports-filter-env", "预发环境", (q) => expect(q.get("env_id")).toBe("env-pre")],
    ];
    for (const [testid, label, expectFilterParam] of cases) {
      const before = reportQueries.length; // 必须在点页码**前**取数：lastQuery 等的是「比 before 多」
      clickPage(3);
      const at = await lastQuery(before);
      expect(at.get("current")).toBe("3"); // 正对照：确实停在第 3 页，reset 才有东西可回
      // pickOption 返回时 fetch 已同步入队（push 在 fetch 体内），基线必须在点击前取
      const beforePick = reportQueries.length;
      await pickOption(testid, label);
      const q = await lastQuery(beforePick);
      expect(q.get("current")).toBe("1"); // 改筛选后落回第 1 页
      expectFilterParam(q); // 正对照：筛选参数与 current=1 同时在线，不是筛选没生效的假回页
      // 页码高亮同步回 1（受控回写，不只是请求里改了口）
      expect(pager().querySelector(".ant-pagination-item-1.ant-pagination-item-active")).toBeTruthy();
    }
  });

  it("停在第 3 页点「刷新」→ 重发的是 current=3，不是回第 1 页", async () => {
    cfg = {
      first: page([row("r1"), row("r2")], 137),
      more: page([row("r3"), row("r4")], 137),
    };
    await renderAndSettle();
    const atPage3 = reportQueries.length;
    clickPage(3);
    const landed = await lastQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：刷新前先确实停在第 3 页
    const before = reportQueries.length;
    clickRefresh();
    await waitFor(() => expect(reportQueries.length).toBe(before + 1));
    const q = new URLSearchParams(reportQueries[reportQueries.length - 1]);
    expect(q.get("current")).toBe("3");
    // 刷新不许顺手把用户弹回第 1 页：页码高亮原地不动
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
  });

  it("停在第 3 页换 50/页 → 线上一条 size=50&current=1（换档位必回第 1 页，AntD 钳过的页码不上线）", async () => {
    // 137 条：20/页停第 3 页，换 50/页 AntD 会自己钳出 onChange(2, 50)——
    // 页面若把那个 2 转发上线（绕过 ListPager 的 onPage(1)），这条的红就在 current 上。
    cfg = {
      first: page([row("r1"), row("r2")], 137),
      more: page([row("r3"), row("r4")], 137),
    };
    await renderAndSettle();
    const atPage3 = reportQueries.length;
    clickPage(3);
    const landed = await lastQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：换档位前确实停在第 3 页
    const before = reportQueries.length;
    await pickPagerSize("50");
    await waitFor(() => expect(reportQueries.length).toBe(before + 1));
    const q = new URLSearchParams(reportQueries[reportQueries.length - 1]);
    expect(q.get("size")).toBe("50");
    expect(q.get("current")).toBe("1");
  });

  it("取数失败不留谎脚注：先「共 137 条」落地，刷新失败后分页器整块消失", async () => {
    cfg = { first: page([row("r1"), row("r2")], 137) };
    await renderAndSettle();
    expect(pager().textContent).toContain("共 137 条");
    cfg = { failReports: true };
    clickRefresh();
    await waitFor(() => expect(screen.getByTestId("reports-failed")).toBeTruthy());
    // 空表上面不许挂着陈旧的「共 137 条」——total 必须随失败清空
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(screen.queryByText("共 137 条")).toBeNull();
  });
});

describe("行链接与时间列", () => {
  it("点场景名链接 reports-row-link → 导航到 /reports/<row id>", async () => {
    await renderAndSettle();
    fireEvent.click(screen.getAllByTestId("reports-row-link")[0]);
    await waitFor(() => expect(navSpy).toHaveBeenCalled());
    expect(navSpy).toHaveBeenCalledWith("/reports/r1");
    // 只去过这一个地方。调用**条数**没钉：实测点链接是 2 次（<a> 自己的 onClick +
    // 冒泡到 reports.tsx:198 的行 onClick，两条都是 load-bearing 行为，钉死条数会
    // 把将来「给 <a> 加 stopPropagation」的正当修复误判成回归）。
    expect(new Set(navSpy.mock.calls.map((c) => c[0]))).toEqual(new Set(["/reports/r1"]));
  });

  it("report-time 画换算后的东八区时刻；started_at 为 null 的行画「—」而不是假时刻", async () => {
    cfg = { first: { items: [
      row("r1", { started_at: "2026-11-16T10:00:00" }), // naive → 按 UTC 解释 → +8h
      row("r2", { started_at: null }),
    ], next_cursor: null } };
    await renderAndSettle();
    expect(screen.getAllByTestId("report-time").map((n) => n.textContent))
      .toEqual(["2026-11-16 18:00:00", "—"]);
  });
});

describe("筛选条整体渲染（reports-body / reports-filters 正对照）", () => {
  it("reports-filters 是 reports-body 的子树，且七个 Select 钩子全部真渲染出选择器", async () => {
    await renderAndSettle();
    const body = screen.getByTestId("reports-body");
    const bar = screen.getByTestId("reports-filters");
    expect(body.contains(bar)).toBe(true);
    for (const id of ["reports-filter-days", "reports-filter-scene", "reports-filter-subject-type",
      "reports-filter-trigger", "reports-filter-status", "reports-filter-env", "reports-filter-creator"]) {
      const node = within(bar).getByTestId(id);
      // 「有 testid」不等于「是个控件」：必须真的渲染出 antd 的选择器节点
      expect(node.querySelector(".ant-select-selector")).toBeTruthy();
    }
    expect(within(bar).getByTestId("reports-include-debug")).toBeTruthy();
    // 场景选项来自 /scenarios（列表行里没有的场景也筛得到，:80-87 的反假筛选口径）
    const sel = within(bar).getByTestId("reports-filter-scene")
      .querySelector(".ant-select-selector") as HTMLElement;
    fireEvent.mouseDown(sel);
    await waitFor(() => expect(visibleOptions()).toContain("履约场景A"));
  });
});
