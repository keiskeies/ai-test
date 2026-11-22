// D47-a · 列表工具栏的行为钉（视图选择器 / 高级搜索 / 列设置）。
//
// 只钉这一件事里**会说谎**的几处，不重测 AntD 自身：
// ① 元数据三态各画各的——「拉挂了」绝不能被画成「本页不支持」（拿故障演事实）；
// ② 字段与操作符的候选只来自后端 filter_meta，前端没有自己的词表；
// ③ 已生效的条件必须能在控件上看见（含时间）；
// ④ 列设置真能把偏好写进 localStorage，且「恢复默认」是删键不是写空集。
//
// jsdom 里 AntD 弹层不可靠（AuditTab.test.tsx:159 已记过这条），所以时间控件不走日历弹层，
// 面板内容用 data-testid 直接取，不靠 role/键盘模拟。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { message } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import { ListToolbar, useColumnPrefs } from "./ListToolbar";
import { emptyFilter } from "../listFilters";
import type { ColumnPref, FilterDoc, FilterMeta, SavedView } from "../listFilters";

const META: FilterMeta = {
  operators: ["CONTAINS", "EQUALS", "IN", "EMPTY", "NOT_EMPTY", "GT", "LT", "BETWEEN"],
  labels: { CONTAINS: "包含", EQUALS: "等于", IN: "属于", EMPTY: "为空", NOT_EMPTY: "不为空",
    GT: "大于", LT: "小于", BETWEEN: "介于" },
  kinds: { text: ["CONTAINS"], enum: ["IN"], time: ["GT"] },
  unavailable: { COUNT_GT: "没有可聚合的子表", COUNT_LT: "同 COUNT_GT" },
  supported_view_types: ["api"],
  view_label: "接口管理",
  fields: [
    { field: "name", label: "接口名称", kind: "text", ops: ["CONTAINS", "EQUALS", "EMPTY"] },
    { field: "method", label: "请求方法", kind: "enum", ops: ["IN", "EQUALS"] },
    { field: "created_at", label: "创建时间", kind: "time", ops: ["GT", "BETWEEN"] },
  ],
};

const VIEW: SavedView = {
  id: "v1", project_id: "p1", view_type: "api", name: "我的 GET",
  conditions: { search_mode: "AND",
    conditions: [{ field: "method", operator: "EQUALS", value: "GET" }] },
  pos: 1, updated_at: "2026-11-20T00:00:00",
};

const okRes = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errRes = (status: number, msg: string) =>
  ({ ok: false, status, json: async () => ({ code: "e", message: msg }) }) as unknown as Response;

interface Call { url: string; body?: string; method: string }

/** 按 URL 分派的 fetch 桩。route 返回 undefined = 用默认响应（META / 一张视图）。 */
function mockFetch(route: (url: string) => unknown = () => undefined): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined, method: String(init?.method ?? "GET") });
    const hit = route(url);
    if (hit instanceof Promise || (hit && typeof (hit as { json?: unknown }).json === "function")) {
      return hit as Response;
    }
    if (url.includes("/filter-meta")) return okRes(hit ?? META);
    if (url.includes("/saved-views")) {
      if (hit !== undefined) return okRes(hit);
      // POST 的回包是真 ViewOut（不是 {}）：桩给畸形回包，测的就是不真实的成功路径
      return okRes(String(init?.method ?? "GET") === "POST"
        ? { ...VIEW, id: "v-new", name: JSON.parse(String(init?.body)).name }
        : [VIEW]);
    }
    return okRes(hit ?? {});
  }) as unknown as typeof fetch;
  return calls;
}

const COLS = [{ key: "name", label: "名称" }, { key: "method", label: "方法" },
  { key: "path", label: "路径" }];

type Props = React.ComponentProps<typeof ListToolbar>;

/** 渲染工具栏并回收 onFilterChange 的实参（Harness 是普通函数，不是组件——用法是
 *  `const h = Harness(); render(h.ui)`，写成 `<Harness />.ui` 是拿 JSX 元素去取属性）。 */
function Harness(over: Partial<Props> = {}) {
  const seen: { f: FilterDoc | null } = { f: null };
  const cols: { p: ColumnPref | null } = { p: null };
  const ui = (
    <ListToolbar
      projectId="p1" viewType="api"
      filter={over.filter ?? emptyFilter()}
      onFilterChange={(f) => { seen.f = f; }}
      allColumns={COLS} canSaveView canDeleteView
      columnPref={over.columnPref ?? null}
      onColumnPrefChange={(n) => { cols.p = n; over.onColumnPrefChange?.(n); }}
      {...over}
    />
  );
  return { ui, seen, cols };
}

/** 把 fetch 桩塞进 global（`.tsx` 里跨行写 `as unknown as typeof fetch` 会被 ASI 咬一口，
 *  收进函数就没这个坑——报的是 TS1434「Unexpected keyword」，很误导）。 */
function asFetch(fn: unknown): void {
  global.fetch = fn as typeof fetch;
}

/** 打开高级搜索面板（入口钮本身按状态分 testid，见 ListToolbar）。 */
async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId("lt-search"));
  return screen.findByTestId("lt-panel");
}

beforeEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); mockFetch(); });

describe("高级搜索入口的三态（不许把故障画成事实）", () => {
  it("元数据在路上：入口是 loading 且禁用，不写成「不支持」", async () => {
    // 每个 URL 各挂一个 promise：共用一条会把 META 也当视图列表喂回去
    const held: { release?: (r: Response) => void } = {};
    const pending = (url: string) => new Promise<Response>((res) => {
      if (url.includes("/filter-meta")) held.release = res; else res(okRes([VIEW]));
    });
    asFetch(vi.fn((input: RequestInfo | URL) => pending(String(input))));
    render(Harness().ui);
    const btn = await screen.findByTestId("lt-search-loading");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("lt-search-unsupported")).toBeNull();
    held.release?.(okRes(META));
    await waitFor(() => expect(screen.getByTestId("lt-search")).toBeTruthy());
  });

  it("元数据拉挂了：说「未取到」并给真重试，绝不显示「不支持」", async () => {
    let failing = true;
    const calls = mockFetch((u) => {
      if (!u.includes("/filter-meta")) return undefined;
      return failing ? errRes(503, "网关挂了") : undefined;
    });
    render(Harness().ui);
    const btn = await screen.findByTestId("lt-search-failed");
    expect(btn.textContent).toContain("未取到");
    expect(screen.queryByTestId("lt-search-unsupported")).toBeNull();
    failing = false;
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("lt-search")).toBeTruthy());
    expect(screen.queryByTestId("lt-search-failed")).toBeNull();
    expect(calls.filter((c) => c.url.includes("/filter-meta")).length).toBe(2);
  });

  it("后端没登记这一页：入口禁用，不摆一个点开就 400 的按钮", async () => {
    mockFetch((u) => (u.includes("/filter-meta") ? { ...META, supported_view_types: [] } : undefined));
    render(Harness().ui);
    const btn = await screen.findByTestId("lt-search-unsupported");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("lt-search")).toBeNull();
  });
});

describe("筛选面板：候选只来自后端", () => {
  it("加条件后直接应用被挡住（半填的条件不发）", async () => {
    const warn = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    const h = Harness();
    render(h.ui);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const row = await within(panel).findByTestId("lt-cond-row");
    // 新行取后端给的第一个字段 + 该字段的第一个操作符（前端不自排顺序）
    expect(row.textContent).toContain("接口名称");
    expect(row.textContent).toContain("包含");
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    // 后端对缺 value 的 CONTAINS 是 400，对空串是 LIKE '%%' 全表命中——都不该发出去
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("接口名称");
    expect(h.seen.f).toBeNull();
  });

  it("填完值再应用 → 发出后端那套 JSON 形状", async () => {
    const h = Harness();
    render(h.ui);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const row = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(row).getByTestId("lt-val-text"), { target: { value: "订单" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(h.seen.f).not.toBeNull());
    expect(h.seen.f).toEqual({ search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "订单" }] });
  });

  it("面板底部如实交代：值不校验 + 哪些操作符暂不支持", async () => {
    render(Harness().ui);
    const panel = await openPanel();
    expect(panel.textContent).toContain("暂不支持");
    expect(panel.textContent).toContain("COUNT_GT");
  });

  it("已生效的时间条件必须显示在控件里（往返）", async () => {
    const f: FilterDoc = { search_mode: "AND",
      conditions: [{ field: "created_at", operator: "GT", value: "2026-11-20T08:30:00Z" }] };
    render(Harness({ filter: f }).ui);
    await openPanel();
    const input = (await screen.findByTestId("lt-val-time")) as HTMLInputElement;
    // 第一版这里写死 value={null}：条件在生效而控件画成空的，用户点「应用」就把它清了
    expect(input.type).toBe("datetime-local");
    expect(input.value).not.toBe("");
  });

  it("「为空」这类操作符不配值控件（后端压根不看 value）", async () => {
    const f: FilterDoc = { search_mode: "AND",
      conditions: [{ field: "name", operator: "EMPTY" }] };
    render(Harness({ filter: f }).ui);
    await openPanel();
    const row = await screen.findByTestId("lt-cond-row");
    expect(within(row).queryByTestId("lt-val-text")).toBeNull();
    expect(within(row).queryByTestId("lt-val-one")).toBeNull();
  });

  it("文本条件把当前值显示出来（改了别想蒙混）", async () => {
    const f: FilterDoc = { search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "订单" }] };
    render(Harness({ filter: f }).ui);
    await openPanel();
    const row = await screen.findByTestId("lt-cond-row");
    expect((within(row).getByTestId("lt-val-text") as HTMLInputElement).value).toBe("订单");
  });

  it("入口上的摘要说得出筛的是什么，且 AND/OR 看得出区别", async () => {
    const f: FilterDoc = { search_mode: "OR",
      conditions: [{ field: "name", operator: "CONTAINS", value: "订单" }] };
    render(Harness({ filter: f }).ui);
    const btn = await screen.findByTestId("lt-search");
    expect(btn.textContent).toContain("接口名称包含 订单");
  });
});

describe("视图选择器", () => {
  it("当前条件等于某个已存视图 → 选择器显示它的名字，删除钮才出现", async () => {
    render(Harness({ filter: VIEW.conditions }).ui);
    const sel = await screen.findByTestId("lt-view");
    await waitFor(() => expect(sel.textContent).toContain("我的 GET"));
    // 钮上写死「删除视图」，视图名在 aria-label：文案带变量会让这一格按不定长文本抖
    const del2 = screen.getByTestId("lt-delete-view");
    expect(del2.getAttribute("aria-label")).toContain("我的 GET");
  });

  it("没有筛选条件时不能存视图（存一个「全部数据」的视图是噪音）", async () => {
    render(Harness().ui);
    const btn = await screen.findByTestId("lt-save-view");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("存视图 POST /saved-views，带 view_type 与当前条件", async () => {
    const calls = mockFetch();
    vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    render(Harness({ filter: VIEW.conditions }).ui);
    fireEvent.click(await screen.findByTestId("lt-save-view"));
    fireEvent.change(await screen.findByTestId("lt-view-name"), { target: { value: "我的 GET 2" } });
    fireEvent.click(await screen.findByTestId("lt-view-name-ok"));
    await waitFor(() => {
      const hit = calls.find((c) => c.method === "POST" && c.url.includes("/saved-views"));
      expect(hit).toBeTruthy();
      const body = JSON.parse(hit!.body!);
      expect(body).toMatchObject({ project_id: "p1", view_type: "api", name: "我的 GET 2" });
      expect(body.conditions.conditions[0].field).toBe("method");
    });
  });

  it("点删除视图 → DELETE /saved-views/{id} 带三个入参", async () => {
    const calls = mockFetch();
    render(Harness({ filter: VIEW.conditions }).ui);
    const btn = await screen.findByTestId("lt-delete-view");
    fireEvent.click(btn);
    await waitFor(() => {
      const hit = calls.find((c) => c.method === "DELETE" && c.url.includes("/saved-views/v1"));
      expect(hit).toBeTruthy();
      expect(JSON.parse(hit!.body!)).toMatchObject({ project_id: "p1", view_type: "api", view_id: "v1" });
    });
  });

  it("视图列表拉挂了：说「没取到」而不是「你没有视图」", async () => {
    mockFetch((u) => (u.includes("/saved-views") ? errRes(500, "炸了") : undefined));
    render(Harness().ui);
    expect(await screen.findByTestId("lt-view-retry")).toBeTruthy();
  });
});

describe("列设置（受控：工具栏回报 → 页面落盘 → 表格真的变）", () => {
  it("勾掉一列 → 只回报给页面，不在组件里偷偷写盘", async () => {
    const h = Harness();
    render(h.ui);
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3);            // 三列三个开关，一列都不漏
    expect(boxes.every((b) => b.checked)).toBe(true);
    fireEvent.click(boxes[1]);                 // 取消「方法」
    await waitFor(() => expect(h.cols.p).toEqual({ hidden: ["method"] }));
    // 落盘是 useColumnPrefs 的职责，组件自己不碰 localStorage（两处落盘早晚分叉）
    expect(localStorage.getItem("tp.listCols.api")).toBeNull();
  });

  it("恢复默认回报 null（页面据此删键）", async () => {
    const h = Harness({ columnPref: { hidden: ["method"] } });
    render(h.ui);
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    fireEvent.click(within(panel).getByTestId("lt-col-reset"));
    expect(h.cols.p).toBeNull();
  });

  it("勾掉的列在面板里显示为未勾选（偏好真的驱动控件，不只是控件驱动偏好）", async () => {
    render(Harness({ columnPref: { hidden: ["path"] } }).ui);
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
  });

  it("useColumnPrefs：改偏好落盘，恢复默认删键", () => {
    function Probe() {
      const [pref, set] = useColumnPrefs("api", ["name", "method", "path"]);
      return <div>
        <span data-testid="p">{JSON.stringify(pref)}</span>
        <button data-testid="hide" onClick={() => set({ hidden: ["method"] })}>藏</button>
        <button data-testid="reset" onClick={() => set(null)}>复位</button>
      </div>;
    }
    render(<Probe />);
    expect(screen.getByTestId("p").textContent).toBe("null");   // 没设过 = null，不是空集
    fireEvent.click(screen.getByTestId("hide"));
    expect(screen.getByTestId("p").textContent).toBe('{"hidden":["method"]}');
    expect(JSON.parse(localStorage.getItem("tp.listCols.api")!).hidden).toEqual(["method"]);
    fireEvent.click(screen.getByTestId("reset"));
    expect(screen.getByTestId("p").textContent).toBe("null");
    // 删键而不是写空集：写空集会把「设过且全显示」说成「没设过」
    expect(localStorage.getItem("tp.listCols.api")).toBeNull();
  });
});
