// 工作台页（§11.5.2）组件测试：fetch 全 mock，只验「数据 → 展示」的映射。
// 趋势图 mock 成占位 div：ECharts 的 canvas 渲染不是本页的契约（页级契约是
// 「有数据才挂图、空态给 Empty」），把 canvas 留给 e2e。
// 两条最要紧的诚实断言：通过率 null 画「-」不画 0%；未开放批次的快捷入口是 disabled。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// lazy(() => import(...)) 要求模块有 default 导出，mock 得带上 __esModule
vi.mock("./workbenchTrend", () => ({
  __esModule: true,
  default: ({ points }: { points: Array<{ date: string }> }) => (
    <div data-testid="wb-trend-chart">{points.length} pts</div>
  ),
}));

import Workbench, { fmtRate } from "./workbench";
import type { WorkbenchStats } from "./workbench";
import { useAuth } from "../auth/store";

const PROJECT = { id: "p1", name: "履约回归", description: null, status: "normal", my_role: "MEMBER" };

const EMPTY_STATS: WorkbenchStats = {
  window: { days: 7, since: "2026-11-09T16:00:00", until: "2026-11-16T02:00:00" },
  assets: { api_definition: 0, api_case: 0, scenario: 0, ui_case: 0, adb_case: 0 },
  runs_7d: 0, pass_rate: null, top_fail: null,
  daily: ["11-10", "11-11", "11-12", "11-13", "11-14", "11-15", "11-16"].map((d) => ({
    date: "2026-" + d, runs: 0, pass_rate: null,
  })),
  recent_runs: [], my_recent_edits: [], my_recent_edits_types: ["scenario", "ui_case"],
};

const FULL_STATS: WorkbenchStats = {
  ...EMPTY_STATS,
  assets: { api_definition: 12, api_case: 30, scenario: 5, ui_case: 3, adb_case: 4 },
  runs_7d: 7, pass_rate: 6 / 7,
  top_fail: { subject_id: "s2", subject_name: "支付场景", fail_count: 3 },
  daily: EMPTY_STATS.daily.map((p, i) => ({ ...p, runs: i === 6 ? 7 : 0, pass_rate: i === 6 ? 6 / 7 : null })),
  recent_runs: [{
    id: "r1", subject_name: "支付场景", subject_type: "scenario", trigger: "manual",
    // 与下面 updated_at **形状不同，且不是笔误**：两个都过后端 `iso_dt`，差别在列 ——
    // started_at 是裸 DateTime（naive → 裸串），updated_at 走 TimestampMixin/`UtcDateTime`
    // （读回挂 UTC → 带 +00:00）。实测 backend/.tmp/timefmt/measure-offset.py；别"顺手改齐"。
    status: "failed", started_at: "2026-11-16T01:30:00", elapsed_ms: 1234,
    created_by_name: "张三", pass_rate: 0.5,
  }],
  my_recent_edits: [{ id: "s2", name: "支付场景", type: "scenario", updated_at: "2026-11-15T10:00:00+00:00" }],
};

function mockFetch(stats: WorkbenchStats | null) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/workbench-stats")) {
      return stats === null
        ? { ok: false, status: 403, json: async () => ({ code: "forbidden", message: "无此项目权限" }) }
        : { ok: true, status: 200, json: async () => stats };
    }
    if (url.includes("/projects")) {
      return { ok: true, status: 200, json: async () => ({ items: [PROJECT], next_cursor: null }) };
    }
    throw new Error("未 mock 的请求: " + url);
  }) as unknown as typeof fetch;
}

/** 统计请求永不落定：钉「首次加载中」的读数画法（不许闪 0，也不许提前喊加载失败）。 */
function mockFetchStatsPending() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/workbench-stats")) return new Promise<never>(() => {});
    if (url.includes("/projects")) {
      return { ok: true, status: 200, json: async () => ({ items: [PROJECT], next_cursor: null }) };
    }
    throw new Error("未 mock 的请求: " + url);
  }) as unknown as typeof fetch;
}

function renderPage() {
  return render(<MemoryRouter><Workbench /></MemoryRouter>);
}

// 「→ 打开」要验真落地：内存路由挂 /scene/:id 探针（adbCaseDetail.test.tsx 同款套路）
function renderPageWithLanding() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Workbench />} />
        <Route path="/scene/:id" element={<div data-testid="landed-scene" />} />
        <Route path="/ui/cases/:id" element={<div data-testid="landed-ui-case" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const disabled = (id: string) => (screen.getByTestId(id) as HTMLButtonElement).disabled;

beforeEach(() => {
  cleanup();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("fmtRate（通过率展示口径）", () => {
  it("null 与 NaN 都画横杠，绝不画 0%", () => {
    expect(fmtRate(null)).toBe("-");
    expect(fmtRate(undefined)).toBe("-");
    expect(fmtRate(Number.NaN)).toBe("-");
  });
  it("真值保留一位小数", () => {
    expect(fmtRate(0)).toBe("0.0%");
    expect(fmtRate(6 / 7)).toBe("85.7%");
    expect(fmtRate(1)).toBe("100.0%");
  });
});

describe("工作台统计区", () => {
  it("空项目：全零 + 空态，不出现 NaN/0% 假通过率", async () => {
    mockFetch(EMPTY_STATS);
    renderPage();
    // 卡本体常驻（请求在飞时读数是「-」），壳在场 ≠ 数据到货：等 runs 的「0」真画出来再读全卡。
    await waitFor(() => expect(screen.getByTestId("wb-card-runs").textContent).toContain("0"));
    const rate = screen.getByTestId("wb-card-rate").textContent ?? "";
    expect(rate).toContain("近 7 天通过率");
    expect(rate).toContain("-");
    expect(rate).not.toContain("NaN");
    expect(screen.getByTestId("wb-card-runs").textContent).toContain("0");
    expect(screen.getByTestId("wb-card-topfail").textContent).toContain("无");
    // 空态是正当状态：趋势卡给 Empty，不给空图
    expect(screen.getByTestId("wb-trend-empty")).not.toBeNull();
    expect(screen.queryByTestId("wb-trend-chart")).toBeNull();
  });

  it("有数据：通过率/失败TOP1/最近执行/我最近编辑都上屏，趋势图挂载", async () => {
    mockFetch(FULL_STATS);
    renderPage();
    expect(await screen.findByTestId("wb-trend-chart")).not.toBeNull();
    expect(screen.getByTestId("wb-card-rate").textContent).toContain("85.7%");
    expect(screen.getByTestId("wb-card-runs").textContent).toContain("7");
    expect(screen.getByTestId("wb-card-topfail").textContent).toContain("支付场景");
    expect(screen.getByTestId("wb-recent-runs").textContent).toContain("支付场景");
    expect(screen.getByTestId("wb-recent-runs").textContent).toContain("断言失败");
    // 我最近编辑：诚实标注覆盖范围（接口/用例无编辑者列）
    expect(screen.getByTestId("wb-my-edits").textContent).toContain("支付场景");
    expect(screen.getByTestId("wb-my-edits").textContent).toContain("场景");
  });

  it("资产总数吃进 adb_case（1E T6 核对：1D T8 第 5 类资产，总数与明细都不许漏）", async () => {
    mockFetch(FULL_STATS);
    renderPage();
    // 卡本体常驻（请求在飞时读数是「-」），壳在场 ≠ 数据到货：等「54」真画出来再读。
    await waitFor(() => expect(screen.getByTestId("wb-card-assets").textContent).toContain("54"));
    const card = screen.getByTestId("wb-card-assets").textContent ?? "";
    // 12+30+5+3+4 = 54：漏加 adb_case 的实现会画 50（这条就是钉它的和式）
    expect(card).toContain("54");
    expect(card).toContain("ADB 4");
  });

  it("最近执行行带耗时（§11.4.1「场景·结果点·耗时·触发」）", async () => {
    mockFetch(FULL_STATS);
    renderPage();
    // 卡本体常驻（请求在飞时读数是「-」），壳在场 ≠ 行到货：等「1234 ms」真画出来再读。
    await waitFor(() => expect(screen.getByTestId("wb-recent-runs").textContent).toContain("1234 ms"));
    expect(screen.getByTestId("wb-recent-runs").textContent).toContain("1234 ms");
  });

  it("未知 trigger 的徽标渲染原文，不静默消失（runVocab 承诺的降级，同 22 轮静默假零一族）", async () => {
    // 旧实现 TRIGGERS[r.trigger] + {trg && <Tag>}：词表外（后端加宽/手改库）的触发方式
    // 整个徽标缺席 = 把已经发生的事装作没发生。新实现 ?? { label: r.trigger } 渲染原文。
    mockFetch({
      ...FULL_STATS,
      recent_runs: [{ ...FULL_STATS.recent_runs[0], trigger: "mystery_trigger" }],
    });
    renderPage();
    // 卡本体常驻（请求在飞时是「还没有执行记录」空态），壳在场 ≠ 行到货：等原文徽标真画出来。
    await waitFor(() => expect(screen.getByTestId("wb-recent-runs").textContent).toContain("mystery_trigger"));
    const row = screen.getByTestId("wb-recent-runs").textContent!;
    expect(row).toContain("mystery_trigger"); // 原文上屏
    // 正对照：词表内的 trigger 照常画中文，降级不是把整列换成原文
    cleanup();
    mockFetch(FULL_STATS);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-recent-runs").textContent).toContain("手动"));
    expect(screen.getByTestId("wb-recent-runs").textContent).toContain("手动");
  });

  it("耗时 null 画「—」不伪造 0", async () => {
    mockFetch({ ...FULL_STATS, recent_runs: [{ ...FULL_STATS.recent_runs[0], elapsed_ms: null }] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-recent-runs")).not.toBeNull());
    expect(screen.getByTestId("wb-recent-runs").textContent).not.toContain("0 ms");
  });

  it("我最近编辑「→ 打开」：点场景名跳 /scene/:id、UI 用例跳 /ui/cases/:id", async () => {
    mockFetch({
      ...FULL_STATS,
      my_recent_edits: [
        { id: "s2", name: "支付场景", type: "scenario", updated_at: "2026-11-15T10:00:00+00:00" },
        { id: "u9", name: "首页冒烟", type: "ui_case", updated_at: "2026-11-15T09:00:00+00:00" },
      ],
    });
    renderPageWithLanding();
    await waitFor(() => expect(screen.getByTestId("wb-edit-open-s2")).not.toBeNull());
    fireEvent.click(screen.getByTestId("wb-edit-open-s2"));
    await waitFor(() => expect(screen.getByTestId("landed-scene")).not.toBeNull());
  });

  it("我最近编辑「→ 打开」：UI 用例跳 /ui/cases/:id", async () => {
    mockFetch({
      ...FULL_STATS,
      my_recent_edits: [{ id: "u9", name: "首页冒烟", type: "ui_case", updated_at: "2026-11-15T09:00:00+00:00" }],
    });
    renderPageWithLanding();
    await waitFor(() => expect(screen.getByTestId("wb-edit-open-u9")).not.toBeNull());
    fireEvent.click(screen.getByTestId("wb-edit-open-u9"));
    await waitFor(() => expect(screen.getByTestId("landed-ui-case")).not.toBeNull());
  });

  it("统计接口失败不炸页：项目卡（项目开关）仍在", async () => {
    mockFetch(null);
    renderPage();
    // 项目列表是另一个请求：容器在 ≠ 行在，等「履约回归」真画出来再读。
    await waitFor(() => expect(screen.getByTestId("project-list").textContent).toContain("履约回归"));
    expect(screen.getByTestId("project-list").textContent).toContain("履约回归");
  });

  it("统计请求失败（silent 无 toast）：四张卡画「-」不画 0/0%「无」，并给一行「统计未加载」；成功态不给这行噪音", async () => {
    // 变异靶：把四张卡改回 `?? 0` / `(loading ? "-" : "无")`（对应卡的 statValue 红）·
    // 删掉 failed 说明块（wb-stats-failed 缺席红）· 说明块条件从 `failed` 换成 `!loading`
    //（成功态那侧多出一行噪音红）
    mockFetch(null);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-stats-failed")).not.toBeNull());
    expect(statValue("wb-card-assets")).toBe("-");
    expect(statValue("wb-card-runs")).toBe("-");
    expect(statValue("wb-card-rate")).toBe("-");
    expect(statValue("wb-card-topfail")).toBe("-");
    // 明细行同样不许冒 0（「接口 0 · 用例 0…」看着就是实测出来的零资产）
    expect(screen.getByTestId("wb-card-assets").textContent).not.toMatch(/(接口|用例|场景|UI|ADB) 0\b/);
    expect(screen.getByTestId("wb-stats-failed").textContent).toContain("统计未加载");
    expect(screen.getByTestId("wb-stats-failed").textContent).toContain("不是 0");

    // 第二侧：请求成功（哪怕全零）→ 一行「未加载」都不许出现
    cleanup();
    mockFetch(EMPTY_STATS);
    renderPage();
    await waitFor(() => expect(statValue("wb-card-assets")).toBe("0"));
    expect(screen.queryByTestId("wb-stats-failed")).toBeNull();
  });

  it("首次加载中（请求未落定）：四张卡是「-」而不是闪 0，且不提前喊加载失败", async () => {
    // 变异靶：读数改回 `st?.x ?? 0` 会在 loading 首帧闪 0（assets/runs 两侧红）·
    // 把 failed 判据写成 `!st` 会把「加载中」误报成失败（wb-stats-failed 那侧红）
    mockFetchStatsPending();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-stats")).not.toBeNull());
    expect(statValue("wb-card-assets")).toBe("-");
    expect(statValue("wb-card-runs")).toBe("-");
    expect(statValue("wb-card-rate")).toBe("-");
    expect(statValue("wb-card-topfail")).toBe("-");
    expect(screen.queryByTestId("wb-stats-failed")).toBeNull();
  });

  it("我最近编辑注记按 my_recent_edits_types 推：不谎称「暂无编辑者记录」，后端加宽后名单自己缩", async () => {
    // 变异靶：注记改回硬编码「（接口/用例暂无编辑者记录）」（两条 toContain + not.toContain 红）·
    // editScopeNote 无视 types 写死名单（加宽那侧的 not.toContain("ADB 未进本榜") 红）
    mockFetch({ ...FULL_STATS, my_recent_edits_types: ["scenario", "ui_case"] });
    renderPage();
    // 容器常驻（注记到货前画 No data 空态），壳在场 ≠ 注记到货：等「覆盖」串真画出来再读。
    await waitFor(() => expect(screen.getByTestId("wb-my-edits").textContent).toContain("覆盖：场景 / UI 用例"));
    const note = screen.getByTestId("wb-my-edits").textContent ?? "";
    expect(note).toContain("覆盖：场景 / UI 用例");
    expect(note).toContain("接口 / 用例 / ADB 未进本榜");
    // adb_case 表上有 updated_by（services.py:19-22），「暂无编辑者记录」是假话
    expect(note).not.toContain("暂无编辑者记录");

    // 第二侧：后端把 adb_case 加进榜单（types 加宽）→ 缺席名单必须跟着少一项
    cleanup();
    mockFetch({ ...FULL_STATS, my_recent_edits_types: ["scenario", "ui_case", "adb_case"] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-my-edits").textContent).toContain("覆盖：场景 / UI 用例 / ADB"));
    expect(screen.getByTestId("wb-my-edits").textContent).not.toContain("ADB 未进本榜");
  });
});

describe("快捷入口（§13 纪律 1：未开放批次不给假按钮）", () => {
  it("导入 1E T4 兑现：可点且开真向导；ADB 用例 T9 解禁可点；Pilot/接口可点", async () => {
    mockFetch(EMPTY_STATS);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-quick")).not.toBeNull());
    expect(disabled("wb-quick-import")).toBe(false);
    expect(disabled("wb-quick-adb-cases")).toBe(false);
    expect(disabled("wb-quick-pilot")).toBe(false);
    expect(disabled("wb-quick-api-new")).toBe(false);
    // 导航诚实条款：哨兵换真 = 点了真能开出三步向导（§11.4.6）
    fireEvent.click(screen.getByTestId("wb-quick-import"));
    expect(await screen.findByTestId("import-wizard")).not.toBeNull();
  });
});

/** 已发出的 fetch URL 全集（mockFetch 每次重装 vi.fn，calls 自然重置）。 */
const fetchUrls = () => (global.fetch as unknown as { mock: { calls: unknown[][] } })
  .mock.calls.map((c) => String(c[0]));

/** Statistic 的数值元素文本：绕开卡片标题里的数字，钉的是「值」而不是「卡里有数」。 */
const statValue = (cardTestid: string) =>
  screen.getByTestId(cardTestid).querySelector(".ant-statistic-content-value")!.textContent;

describe("零引用 testid 补账：wb-stats / wb-trend / wb-stats-section", () => {
  it("wb-stats：四卡按 资产→执行→通过率→TOP1 序排在行内且 gutter=[16,16] 落成 -8px 负边距+16px rowGap；读数 FULL=54/7/85.7%/支付场景·失败3次，EMPTY=0/0/-/无", async () => {
    // 变异靶：gutter 改 [8,8]（行内联样式变 -4px/8px 红）· 两卡 Col 换序（cards 数组红）·
    // Statistic 值硬编码不随 fixture 变（第二侧 0/0/-/无 红）
    mockFetch(FULL_STATS);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-trend-chart")).not.toBeNull());
    const row = screen.getByTestId("wb-stats");
    // Row gutter=[h,v]：antd 把横向 gutter 折成左右负半 margin、纵向写成 rowGap（行 104 的直接产物）
    expect(row.style.marginLeft).toBe("-8px");
    expect(row.style.marginRight).toBe("-8px");
    expect(row.style.rowGap).toBe("16px");
    const cards = Array.from(row.querySelectorAll('[data-testid^="wb-card-"]'))
      .map((n) => n.getAttribute("data-testid"));
    expect(cards).toEqual(["wb-card-assets", "wb-card-runs", "wb-card-rate", "wb-card-topfail"]);
    expect(statValue("wb-card-assets")).toBe("54"); // 12+30+5+3+4
    expect(statValue("wb-card-runs")).toBe("7");
    expect(statValue("wb-card-rate")).toBe("85.7%");
    expect(statValue("wb-card-topfail")).toBe("支付场景");
    expect(screen.getByTestId("wb-card-topfail").textContent).toContain("失败 3 次");

    // 第二侧：同一行、同一卡序，读数必须跟着 fixture 落回空态（硬编码/漏减都会在这侧红）
    cleanup();
    mockFetch(EMPTY_STATS);
    renderPage();
    await waitFor(() => expect(statValue("wb-card-topfail")).toBe("无"));
    const row2 = screen.getByTestId("wb-stats");
    expect(Array.from(row2.querySelectorAll('[data-testid^="wb-card-"]'))
      .map((n) => n.getAttribute("data-testid")))
      .toEqual(["wb-card-assets", "wb-card-runs", "wb-card-rate", "wb-card-topfail"]);
    expect(statValue("wb-card-assets")).toBe("0");
    expect(statValue("wb-card-runs")).toBe("0");
    expect(statValue("wb-card-rate")).toBe("-"); // null 分母画「-」不画 0%
    // 「失败 N 次」明细行整条缺席（卡标题本身就叫「失败 TOP1 场景」，按整行文案找）
    expect(screen.queryByText(/^失败 \d+ 次$/)).toBeNull();
  });

  it("wb-trend：卡头标题「近 7 天通过率趋势」逐字在、marginTop=16 在、序列条数跟 fixture 走（7 点→7 pts，截到 5 点→5 pts）；runs_7d=0 时卡内是「近 7 天还没有执行记录」的 Empty 而不是空图", async () => {
    // 变异靶：title 文案改动/删掉（head 标题 toBe 红）· points 硬编码成固定 7 点
    //（5 点 fixture 那侧 5 pts 红）· 空窗口判据从 runs_7d 换成 daily.length
    //（EMPTY fixture 仍带 7 个 daily 点 → 会挂图，Empty 那侧红）
    mockFetch(FULL_STATS);
    renderPage();
    const chart = await screen.findByTestId("wb-trend-chart");
    const card = screen.getByTestId("wb-trend");
    expect(card.querySelector(".ant-card-head-title")!.textContent).toBe("近 7 天通过率趋势");
    expect(card.style.marginTop).toBe("16px");
    expect(card.contains(chart)).toBe(true);
    expect(chart.textContent).toBe("7 pts"); // FULL.daily = 7 个点

    // 第二侧：序列截到 5 点，图必须只拿 5 个点——钉死 series 来自 st.daily 而非写死
    cleanup();
    mockFetch({ ...FULL_STATS, daily: FULL_STATS.daily.slice(0, 5) });
    renderPage();
    expect((await screen.findByTestId("wb-trend-chart")).textContent).toBe("5 pts");

    // 第三侧：runs_7d=0（daily 仍是 7 个点）→ 正当空态：卡内 Empty 文案，图不挂
    cleanup();
    mockFetch(EMPTY_STATS);
    renderPage();
    const empty = await screen.findByTestId("wb-trend-empty");
    expect(screen.getByTestId("wb-trend").contains(empty)).toBe(true);
    expect(empty.textContent).toContain("近 7 天还没有执行记录");
    expect(screen.queryByTestId("wb-trend-chart")).toBeNull();
  });

  it("wb-stats-section：有项目→整段统计区（wb-stats/wb-trend/两列表/快捷入口）都被它包住且按 project_id 拉数；无项目→整段消失、给「先在下方选择项目」引导且一次 /workbench-stats 都不发", async () => {
    // 变异靶：守卫 `project ?` 翻成 `!project ?`（两侧同时红）· 无项目也挂 StatsSection
    //（猜一个项目画数=假数据，无项目那侧的「不发请求 + section 缺席」红）
    mockFetch(FULL_STATS);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("wb-trend-chart")).not.toBeNull());
    const sec = screen.getByTestId("wb-stats-section");
    for (const id of ["wb-stats", "wb-trend", "wb-recent-runs", "wb-my-edits", "wb-quick"]) {
      expect(sec.contains(screen.getByTestId(id))).toBe(true); // 包住的是整段，不是其中一张卡
    }
    expect(document.body.textContent).not.toContain("先在下方选择项目");
    expect(fetchUrls().some((u) => u.includes("/workbench-stats?project_id=p1"))).toBe(true);

    // 第二侧：project=null —— section 缺席、诚实引导在场、且绝不带着猜测发统计请求
    cleanup();
    mockFetch(FULL_STATS); // 重装 vi.fn：calls 只记第二侧这一次渲染
    useAuth.setState({ project: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("project-list")).not.toBeNull());
    expect(screen.queryByTestId("wb-stats-section")).toBeNull();
    expect(document.body.textContent).toContain("先在下方选择项目，统计区随项目切换");
    expect(fetchUrls().some((u) => u.includes("/workbench-stats"))).toBe(false);
  });
});
