// 元素库页的角色门控测试（一期 DoD 第 3 条 UI 面补洞）。
// 五个门（uiElements.tsx:50-54）：ui:element:create → [新建元素]；ui:element:update → 行编辑钮
// 与回收站 [恢复]；ui:element:delete → 行回收钮与回收站 [彻底删除]；
// ui:module:create/delete → ModuleTree 的管理入口。全部隐藏不是禁用（文件头 :7 写明）。
// 本页钉 READONLY 全隐 + PROJECT_ADMIN 全在 + 换 my_perms 只让 delete 回来（跟位走）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import UiElementsPage from "./uiElements";
import { useAuth } from "../auth/store";
import { uiApi } from "../api/ui";
import type { UiElementListRow } from "../api/ui";

// rc-motion 的 leave 动画在 jsdom 里不完成（shell.test.tsx / ChangePasswordModal.test.tsx
// 同款对策）：弹窗关窗要能观察到收尾态，一律 motion:false。
function renderPage(): ReturnType<typeof render> {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter><UiElementsPage /></MemoryRouter>
    </ConfigProvider>,
  );
}

type Row = UiElementListRow;

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

function element(id: string, over: Partial<Row> = {}): Row {
  return { id, project_id: "p1", module_id: null, name: "登录按钮" + id, locator_type: "css",
    locator: "#submit", comment: null, owner_id: null, project_public: true, status: "normal",
    updated_by: null, created_at: null, updated_at: null, used_by: 0, ...over };
}

const TREE = { tree: [{ id: "m1", parent_id: null, name: "登录模块", sort: 0,
  status: "normal", count: 1, children: [] }], recycled: [] };

// D220：元素库页工具栏要的 /filter-meta（形状与后端 filter_registry 一致）。
// supported_view_types 必须含 ui_element，否则工具栏按「本页不支持」画——
// 那会把「桩没 mock 到」演成「功能不存在」。
const UI_ELEMENT_META = {
  view_type: "ui_element",
  fields: [
    { field: "name", label: "元素名", kind: "text",
      ops: ["CONTAINS", "EQUALS", "IN", "NOT_CONTAINS", "NOT_EQUALS", "NOT_IN"] },
    { field: "locator_type", label: "定位方式", kind: "enum",
      ops: ["EMPTY", "EQUALS", "IN", "NOT_EQUALS", "NOT_EMPTY"] },
  ],
  supported_view_types: ["ui_element"],
  view_label: "元素库",
  operators: [], labels: {}, kinds: {}, unavailable: {},
};

// ── 请求风暴刹车（罩住本文件全部 fetch 桩）──────────────────────────────────────
// 为什么要有它：本文件里「挂载恰好一条请求」的绊线，挡的是「取数落地把自己写的 state
// 塞回 load 依赖」的无限回路。但**回路的表现形式不是报红，是整份文件挂死**——每一跳
// （响应→setRows→load 换身份→effect 重跑→再请求）都排在微任务里，act() 冲不干净，
// 而 vitest 的 5s 用例超时本身是个宏任务、被同一条微任务链饿死，于是连绊线那一行都
// 执行不到。实测（本文件现跑，不是推断）：把 rows 塞回 load 依赖 → 600s 无汇总行；
// 摘掉 → 全绿。一条「只会让测试挂住、永远不会红」的守护，按判据 6 等于没有守护。
// 刹车的形状是刻意的，两点都不许改回去：
// ① 超阈值后**不抛错**——抛错会走 catch → setRows([]) → 新数组 → 依赖又变脏 →
//    回路自己续命，照样挂死（试过，仍然挂）。改为反复交出**同一个冻结响应体**：
//    同引用让 setRows 被 React 按同一性跳过，回路自己断掉，act() 能落地。
// ② 阈值不能太高——cap 25 时回路虽会自断，但自断前 React 已把 worker 冲崩
//    （日志只留一句 tinypool onUnexpectedExit，又没有汇总行了）。cap 10 实测够低。
// 刹车生效后绊线报出的数字：mock.calls 那一类报真实请求数（实测「got 12」），
// 桩自己 listUrls 那一类只报到 cap 为止（实测「got 10」= 恰好撞上 cap，不是真总数）。
// 两类都红、都能定位，但**读数字时先分清是哪一类**，别拿被夹住的数当真实请求数。
const LIST_STORM_CAP = 10;
const STORM_BODY = Object.freeze({ items: Object.freeze([]), next_cursor: null, total: 0 });
/**
 * 请求风暴刹车包装器。**包在 vi.fn 里面**（`vi.fn(stormyFetch(handler))`）而不是外面：
 * 放外面，被刹掉的那些请求就不进 mock.calls，靠 mock.calls 计数的绊线会报出一个偏小的
 * 假数字（甚至恰好 1，看着像全对）——「守护自己把证据改了」是最坏的一种守护。
 * 放里面，mock 照单全收每次调用，那条绊线的数字才是真的（桩内部自记的 listUrls 不在此列，
 * 它记的是「放行过的那几次」，见上）。
 */
function stormyFetch(inner: typeof fetch): typeof fetch {
  let listCalls = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/ui-elements\?/.test(String(input))) {
      listCalls += 1;
      if (listCalls > LIST_STORM_CAP) {
        // 冻结体**原样交出、一次都不拷**：同引用是断环的全部机制。
        return { ok: true, status: 200, json: async () => STORM_BODY } as unknown as Response;
      }
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
}

function mockBackend(recycledRows: Row[]) {
  global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const resp = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
    if (url.includes("/filter-meta")) return resp(UI_ELEMENT_META);
    if (url.includes("/saved-views")) return resp([]);
    if (url.includes("/ui-modules?") && method === "GET") return resp(TREE);
    if (url.includes("/ui-elements?") && method === "GET") {
      return resp(url.includes("recycled=true")
        ? { items: recycledRows, next_cursor: null }
        : { items: [element("e1")], next_cursor: null });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  })) as unknown as typeof fetch;
}

// ── D47-b 步5d 的服务端形状桩（页码分页契约测试专用，scenes/uiCases.test 同法）────────
// 真按 query 参数过滤（recycled / keyword 只打 name 大小写不敏感 / module_ids 重复键）、
// 按 current/size 切片、报 total；**每次调用现拷一份全新响应体**（JSON.parse(JSON.stringify)）
// ——同引用反复交出会把「响应→load 依赖变脏→无限回路」吃成假绿（计划 §六 步 3b 的学费）。
// keyword 的大小写不敏感是后端契约（只打 name、不敏感），桩照抄；测试钉的是
// 「我们把 keyword 原样送上线」，不是「浏览器替后端做了小写化」。
type ServerTree = { id: string; parent_id: string | null; name: string; sort: number;
  status: string; count: number; children: ServerTree[] };
function elementServer(rows: Row[], opts: {
  tree?: ServerTree[]; recycledRows?: Row[];
  total?: number | null; // total: null = 整键不给（游标式旧形状）
  cursor?: string | null; // 非空 = 响应同时挂着 next_cursor（钉「游标对界面零影响」）
  detailStatus?: number; // 详情探针（落点横幅的存在性作证）改回此状态码（500 = 故障≠不存在）
} = {}) {
  const listUrls: string[] = [];
  const resp = (json: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) }) as unknown as Response;
  global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/filter-meta")) return resp(UI_ELEMENT_META);
    if (url.includes("/saved-views")) return resp([]);
    if (url.includes("/ui-modules?")) return resp({ tree: opts.tree ?? [], recycled: [] });
    if (/\/ui-elements\?/.test(url)) {
      listUrls.push(url); // 计数照记：绊线要报的就是「一共发了几条」这个真数字
      const q = new URLSearchParams(url.split("?")[1]);
      const size = Number(q.get("size") ?? "20");
      const current = Number(q.get("current") ?? "1");
      const kw = (q.get("keyword") ?? "").toLowerCase();
      // module_ids 断言一律走 getAll（重复键）：逗号拼接的 "a,b" 只会解成一个不存在的 id，
      // 「url 包含 module_ids」那种断言对静默错是瞎的。
      const mids = q.getAll("module_ids");
      const wantRecycled = q.get("recycled") === "true";
      const pool = wantRecycled ? opts.recycledRows ?? [] : rows;
      const hit = pool.filter((r) => {
        if ((r.status === "recycled") !== wantRecycled) return false;
        if (mids.length && !mids.includes(r.module_id ?? "__none")) return false;
        if (kw && !r.name.toLowerCase().includes(kw)) return false;
        return true;
      });
      const page = { items: hit.slice((current - 1) * size, (current - 1) * size + size),
        next_cursor: opts.cursor ?? null } as { items: Row[]; next_cursor: string | null; total?: number };
      if (opts.total !== null) page.total = opts.total ?? hit.length;
      return resp(page);
    }
    if (/\/ui-elements\//.test(url)) {
      // 详情探针（落点横幅的存在性作证）：rows/recycledRows 里有 → 200 该行；
      // 没有 → 404（详情只认未回收元素，404 = 不存在或已回收两案并说）；
      // detailStatus 非空时整段改回该码（钉「故障 ≠ 不存在」那条横幅腿）。
      if (opts.detailStatus) {
        return resp({ code: "db_error", message: "详情库挂了", details: null }, opts.detailStatus);
      }
      const id = decodeURIComponent(url.split("/ui-elements/")[1].split("?")[0]);
      const hit = [...rows, ...(opts.recycledRows ?? [])].find((r) => r.id === id);
      return hit
        ? resp(hit)
        : resp({ code: "not_found", message: "元素不存在或已回收", details: null }, 404);
    }
    throw new Error("未 mock 的请求: " + url);
  })) as unknown as typeof fetch;
  return { listUrls };
}
/** 最近一条列表请求的 query。 */
function lastListQ(h: { listUrls: string[] }): URLSearchParams {
  return new URLSearchParams(h.listUrls[h.listUrls.length - 1].split("?")[1]);
}
/** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
function clickPage(n: number): void {
  fireEvent.click(screen.getByTestId("list-pager")
    .querySelector(`.ant-pagination-item-${n} a`) as Element);
}
function waitForRows(n: number): Promise<unknown> {
  return waitFor(() => expect(screen.getAllByTestId("ui-element-row-name")).toHaveLength(n));
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("uiElements 权限门（新建/回收全隐藏，不是禁用）", () => {
  it("READONLY：[新建元素] 与行回收钮都不在 DOM；行照渲染（读面不动）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend([]);
    render(<MemoryRouter><UiElementsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ui-element-row-name")).not.toBeNull());
    expect(screen.queryByTestId("ui-element-new")).toBeNull();
    expect(screen.queryByTestId("ui-element-delete")).toBeNull();
    // D47-b 步5d 无限回路绊线放在**全文件最早挂载列表**的这条用例上（scenes/uiCases 同法）：
    // 「取数落地把自己写的 state（rows/tree/total）塞回 load 依赖」这种回路，若绊线只在后
    // 面的页码块里，前面每条用例都带着一个不停发请求的后台回路跑完——整文件被拖垮、最后
    // 仍由页码块报红，但红得又慢又难归因。放在最前面 = 回路第一条就红，且只红一条。
    await new Promise((r) => setTimeout(r, 300));
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).filter((u) => u.includes("/ui-elements?"))).toHaveLength(1);
  });

  it("PROJECT_ADMIN：新建与回收都在", async () => {
    mockBackend([]);
    render(<MemoryRouter><UiElementsPage /></MemoryRouter>);
    // ui-element-new 只挂权限门（uiElements.tsx:217），请求在飞时就在场——拿它当等待点
    // 等于没等，行侧的 ui-element-delete（:307，随行到货）会抢跑。等待点换到行内钮本身。
    await waitFor(() => expect(screen.getByTestId("ui-element-delete")).not.toBeNull());
    expect(screen.getByTestId("ui-element-new")).not.toBeNull();
  });

  it("回收站视图：[恢复]（update 位）与 [彻底删除]（delete 位）跟位走——PA 都在，无位者都不在", async () => {
    // PA 先进回收站视图：两钮都在
    // status 必须给 recycled：后端回收站列表按 status 过滤（case_services.py:159 同法），
    // D180 后行级钮按 r.status 判，normal 行喂进回收站批次是后端给不出的假数据。
    mockBackend([element("e9", { status: "recycled" })]);
    const { unmount } = render(<MemoryRouter><UiElementsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ui-element-row-name")).not.toBeNull());
    // 回收站开关在 ModuleTree 上且挂 canManage（=ui:module:delete）：PA 有 * 才看得见
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(screen.getByTestId("ui-element-restore")).not.toBeNull());
    expect(screen.getByTestId("ui-element-purge")).not.toBeNull();
    unmount();

    cleanup();
    // 换显式 my_perms：有 module:delete（进得去回收站视图）但没有 element:update/delete
    // → [恢复]/[彻底删除] 都不渲染。跟位走，不跟 role 字符串走。
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY",
      my_perms: ["ui:element:read", "ui:module:read", "ui:module:delete", "-system:*"] } });
    mockBackend([element("e9", { status: "recycled" })]);
    render(<MemoryRouter><UiElementsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("module-recycled-toggle")).not.toBeNull());
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(screen.getByTestId("ui-element-row-name")).not.toBeNull());
    expect(screen.queryByTestId("ui-element-restore")).toBeNull();
    expect(screen.queryByTestId("ui-element-purge")).toBeNull();
  });

  it("换显式 my_perms（element read+delete，无 create/update）：回收回来、新建仍不在——跟位走", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY",
      my_perms: ["ui:element:read", "ui:element:delete", "ui:module:read", "-system:*"] } });
    mockBackend([]);
    render(<MemoryRouter><UiElementsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ui-element-delete")).not.toBeNull());
    expect(screen.queryByTestId("ui-element-new")).toBeNull();
  });
});

// §11.4.18 回收站「删除人/删除时间」两列：同一份 updated_by/updated_at 在正常行上是
// 「最后编辑人/时间」，只有回收站里最后那次写才恰好是回收本身——所以两列**必须**被
// inRecycled 守卫圈住，正常视图里出现这两列就是说谎（拆守卫后第二条用例变红）。
describe("回收站两列（§11.4.18）", () => {
  const recycledRow = element("e9", {
    status: "recycled", updated_by: "u9", updated_by_name: "王小明",
    updated_at: "2026-11-01T02:34:56+00:00",
  });

  it("回收站视图：删除人显示人名，删除时间走 Asia/Shanghai 换算", async () => {
    mockBackend([recycledRow]);
    render(<MemoryRouter><UiElementsPage /></MemoryRouter>);
    await screen.findByTestId("ui-element-row-name");
    // D47-b 步5d 顺带钉 D180 正对照：回收站开关改走 patchFilters（唯一写入口，带
    // setCurrent(1)），模板翻不翻仍只认**成功回包**，与 current 复位共用同一次点击。
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    // waitFor 不是摆设：切换瞬间的首帧还是**切换前**那批行（没有名字），findByTestId
    // 会在这一帧就放行——断言必须等回收站那次请求把行换掉（实测过一次 '—' 抢跑）。
    // 删除人是人名不是 id（后端查不到人给 null → 前端画「—」，这里给的是查到的）
    await waitFor(() =>
      expect(screen.getByTestId("ui-element-recycled-by").textContent).toContain("王小明"));
    // 02:34:56 UTC + 8h = 10:34 上海——若谁退回 slice 会露出 UTC 钟点 02:34（R68 的坑）
    await waitFor(() =>
      expect(screen.getByTestId("ui-element-recycled-at").textContent).toContain("2026-11-01 10:34"));
  });

  it("正常列表不许出现这两列（同字段在正常行上是最后编辑人，标成删除人即说谎）", async () => {
    // 正常视图的行照带 updated_by_name/updated_at——钉的是列渲染守卫，不是数据缺席
    mockBackend([element("e1", {
      updated_by: "u9", updated_by_name: "王小明", updated_at: "2026-11-01T02:34:56+00:00",
    })]);
    render(<MemoryRouter><UiElementsPage /></MemoryRouter>);
    await screen.findByTestId("ui-element-row-name");
    expect(screen.queryByTestId("ui-element-recycled-by")).toBeNull();
    expect(screen.queryByTestId("ui-element-recycled-at")).toBeNull();
    expect(screen.queryByText("删除人")).toBeNull();
    expect(screen.queryByText("删除时间")).toBeNull();
  });
});

// ── ui-element-search 把手行为（D47-b 步5d：服务端契约，打字不发请求）─────────────
// 旧版钉的是浏览器本地过滤谓词三半（trim/小写/只认名字）；下推后这三半是**后端契约**
// （keyword 只打 name、大小写不敏感、strip 后空=不过滤，222f843），本文件钉的是
// 「我们把已提交关键词原样送上线、打字零请求、提交口恰好三个」。桩真按 keyword 过滤。
describe("ui-element-search 把手行为（打字零请求 / 提交才上线 / allowClear）", () => {
  function rowNames(): (string | null)[] {
    return Array.from(document.querySelectorAll('.ant-table-tbody [data-testid="ui-element-row-name"]'))
      .map((n) => n.textContent);
  }
  /** rc-input 的 Enter 有 keyLockRef：一次 keyDown 后锁住，到 keyUp 才放行——连按两次
   *  keyDown 第二次会被静默吞掉。提交 Enter 一律按这对来（scenes/api.test 同款对策）。 */
  function pressEnter(el: HTMLElement): void {
    fireEvent.keyDown(el, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(el, { key: "Enter", code: "Enter" });
  }

  it("打字零请求；Enter 提交 trim 后的关键词且回第 1 页；大写原样上线（小写化是后端的事）", async () => {
    const h = elementServer([
      element("eA", { name: "登录按钮", locator: "#login", comment: "退款相关备注" }),
      element("eB", { name: "退款 REFUND 入口", locator: "#order-query", comment: null }),
      element("eC", { name: "支付按钮", locator: "#refund-pay", comment: null }),
    ]);
    renderPage();
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const search = screen.getByTestId("ui-element-search");
    expect(search.tagName).toBe("INPUT");
    expect(search.getAttribute("placeholder")).toBe("搜索元素名");
    // 打字六个字 = 零条新请求（合并成单一 state 的旧形状会逐字发 GET）
    const before = h.listUrls.length;
    fireEvent.change(search, { target: { value: " 退款 REFUND " } });
    await new Promise((r) => setTimeout(r, 120));
    expect(h.listUrls).toHaveLength(before);
    // 提交口 1（Enter）：trim 后进线；桩小写化后 eB 命中（eA 备注里也写退款不算——只打 name）
    pressEnter(search);
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.get("keyword")).toBe("退款 REFUND"); // trim 两半：首尾空格不许上线
    expect(q.getAll("module_ids")).toEqual([]); // 没选模块 = 空
    await waitFor(() => expect(rowNames()).toEqual(["退款 REFUND 入口"]));
    // 大写提交原样上线（浏览器不再 toLowerCase——大小写不敏感是后端契约）
    expect(q.has("cursor")).toBe(false);
  });

  it("allowClear 提交空串 = keyword 整个不上线（不挂空键）；纯空白提交同样不上线", async () => {
    const h = elementServer([element("eA", { name: "登录按钮" })]);
    renderPage();
    await waitFor(() => expect(rowNames()).toHaveLength(1));
    const search = screen.getByTestId("ui-element-search");
    fireEvent.change(search, { target: { value: "登录" } });
    pressEnter(search); // 提交后才过滤（桩按 keyword 滤，行集不变=命中自己）
    await waitFor(() => expect(lastListQ(h).get("keyword")).toBe("登录"));
    // 纯空白提交：kw 归空，参数整个不上线（挂 keyword= 空串就不是「不过滤」的契约形状）
    fireEvent.change(search, { target: { value: "   " } });
    pressEnter(search);
    await waitFor(() => expect(lastListQ(h).has("keyword")).toBe(false));
    // 提交口 3（allowClear）：点清空钮 = onChange('') + onSearch('')，keyword 依旧不上线
    const icon = () => (search.closest(".ant-input-affix-wrapper") as HTMLElement)
      .querySelector(".ant-input-clear-icon")!;
    fireEvent.change(search, { target: { value: "登录" } });
    pressEnter(search);
    await waitFor(() => expect(lastListQ(h).get("keyword")).toBe("登录"));
    fireEvent.click(icon());
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
    await waitFor(() => expect(lastListQ(h).has("keyword")).toBe(false));
    expect(icon().className).toContain("ant-input-clear-icon-hidden");
  });

  it("停在第 3 页提交关键词 → current=1 与 keyword 一起上线（筛选漏斗的回页）", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => element("e" + (i + 1)));
    const h = elementServer(rows);
    renderPage();
    await waitForRows(20);
    clickPage(3);
    await waitFor(() => expect(lastListQ(h).get("current")).toBe("3"));
    const before = h.listUrls.length;
    const search = screen.getByTestId("ui-element-search");
    fireEvent.change(search, { target: { value: "按钮5" } });
    pressEnter(search);
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.get("keyword")).toBe("按钮5");
    expect(q.get("current")).toBe("1"); // 正对照：确实从第 3 页被漏斗拍回第 1 页
  });
});

// ── 第二十轮：本页三个零引用把手补测（审计轴③）───────────────────────────────
// ui-element-new-modal / ui-element-new-comment（search 把手已随 D47-b 步5d 改服务端契约，
// 钉法见上方新 describe）。每条都钉「做什么」而不是「在场」：弹窗 confirmLoading 的 busy
// 观察面、备注框的受控回环与 POST body 形状。
// POST /ui-elements 按 login.test.tsx 的 release 手法挂起，专杀 confirmLoading。

type MockCtl = {
  posts: Record<string, unknown>[];
  patches: { url: string; body: Record<string, unknown> }[];
  patchFail: { code: string; message: string; details?: unknown } | null;
  hold: boolean;
  failNext: boolean;
  resolvePost: () => void;
  getListCount: () => number;
};

/** GET 树/列表/详情探针 + POST /ui-elements 捕获（hold=true 时 POST 挂起等 resolvePost；
 *  failNext=true 时下一次 resolvePost 回 409 信封——catch 腿不关窗，好观察 busy 落地）。
 *  PATCH /ui-elements/{id}（D120 编辑）：body 进 patches；patchFail 非空时整段回 409 信封。
 *  GET /ui-elements/{id}（D47-b 步5d 落点探针）：liveRows 里有 → 200 该行；没有 → 404
 *  （详情只认未回收元素，404 = 不存在或已回收两案并说）；detailStatus=500 时改回 500
 *  钉「故障 ≠ 不存在」那条横幅腿。 */
function mockElements(opts: { liveRows?: Row[]; detailStatus?: number } = {}): MockCtl {
  const live = opts.liveRows ?? [element("e1")];
  const resp = (json: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => json }) as unknown as Response;
  let release: ((r: Response) => void) | null = null;
  const ctl: MockCtl = {
    posts: [],
    patches: [],
    patchFail: null,
    hold: false,
    failNext: false,
    resolvePost: () => {
      const r = release; release = null;
      r?.(ctl.failNext
        ? resp({ code: "name_exists", message: "重名" }, 409)
        : resp(element("n9")));
    },
    getListCount: () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("/ui-elements?")).length,
  };
  global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/ui-modules?") && method === "GET") return resp(TREE);
    if (url.includes("/ui-elements?") && method === "GET") {
      return resp({ items: url.includes("recycled=true") ? [] : live, next_cursor: null });
    }
    if (url.includes("/ui-elements/") && method === "GET") {
      if (opts.detailStatus) {
        return resp({ code: "db_error", message: "详情库挂了", details: null }, opts.detailStatus);
      }
      const id = decodeURIComponent(url.split("/ui-elements/")[1].split("?")[0]);
      const hit = live.find((r) => r.id === id);
      return hit
        ? resp(hit)
        : resp({ code: "not_found", message: "元素不存在或已回收", details: null }, 404);
    }
    if (url.endsWith("/ui-elements") && method === "POST") {
      ctl.posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Promise<Response>((r) => {
        if (ctl.hold) release = r; else r(resp(element("n9")));
      });
    }
    if (/\/ui-elements\/[^/?]+$/.test(url) && method === "PATCH") {
      ctl.patches.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (ctl.patchFail) {
        return resp({ code: ctl.patchFail.code, message: ctl.patchFail.message,
          details: ctl.patchFail.details ?? null }, 409);
      }
      return resp(element("e1"));
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  })) as unknown as typeof fetch;
  return ctl;
}


describe("新建弹窗把手行为（ui-element-new-modal / ui-element-new-comment）", () => {
  it("ui-element-new-modal：busy 期间 ok 钮 loading 吞点击；409 失败不关窗恢复可点，重试成功才关窗重刷列表", async () => {
    // 杀什么：:298 confirmLoading={busy} → false —— loading 类、吞点击、失败腿三处同红；
    // :297 open={creating} → 恒 true —— 成功后的 wrap display:none 永不到来，关窗断言红。
    const ctl = mockElements();
    ctl.hold = true;
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    // 首次打开前 Portal 从未挂过：壳整个不在 DOM（不是隐藏，是压根没渲染）
    expect(screen.queryByTestId("ui-element-new-modal")).toBeNull();
    fireEvent.click(screen.getByTestId("ui-element-new"));
    const modal = await screen.findByTestId("ui-element-new-modal");
    expect(modal.querySelector(".ant-modal-title")?.textContent).toBe("新建元素");
    const ok = screen.getByTestId("ui-element-new-ok") as HTMLButtonElement;
    // 两字按钮文案被 antd 拆字插空格（「创 建」），去空白再逐字比
    expect(ok.textContent!.replace(/\s/g, "")).toBe("创建");
    expect(Array.from(modal.querySelectorAll(".ant-modal-footer .ant-btn"))
      .map((b) => b.textContent!.replace(/\s/g, "")).sort()).toEqual(["创建", "取消"]);
    fireEvent.change(screen.getByTestId("ui-element-name"), { target: { value: "新元素" } });
    fireEvent.change(screen.getByTestId("ui-element-new-locator"), { target: { value: "#x" } });
    fireEvent.click(ok);
    await waitFor(() => expect(ctl.posts.length).toBe(1));
    // :116 setBusy(true) → :298 confirmLoading={busy}：antd 5 的 loading 不挂原生 disabled
    // （button.js 里 disabled=mergedDisabled 与 loading 分离），busy 的观察面 = loading 类
    // + 点击被 loading 守卫吞掉（button.js:184）——「busy 期间不可点」就是这两件事。
    await waitFor(() => expect(ok.className).toContain("ant-btn-loading"));
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok); // busy 期间的第二次点击必须不再发 POST
    expect(ctl.posts.length).toBe(1);
    // 用失败回包释放 busy：catch 不关窗 → 能在**开着的**弹窗上观察 busy 落地
    ctl.failNext = true;
    ctl.resolvePost();
    await waitFor(() => expect(ok.className).not.toContain("ant-btn-loading"));
    const wrap = document.querySelector(".ant-modal-wrap") as HTMLElement;
    expect(wrap.style.display).toBe(""); // 409 留在原地改（:126 catch 不关窗）
    expect(ctl.getListCount()).toBe(1); // 失败不重刷列表
    // 恢复可点 = 再点真发得出 POST；第二次即时成功 → 关窗 + 列表重拉
    ctl.hold = false;
    fireEvent.click(ok);
    await waitFor(() => expect(ctl.posts.length).toBe(2));
    await waitFor(() => expect(wrap.style.display).toBe("none"));
    await waitFor(() => expect(ctl.getListCount()).toBe(2)); // :125 创建成功后 await load()
  });

  it("ui-element-new-comment：受控回环钉 rows/maxLength/placeholder；备注 trim 后进 POST body，留空落 null，成功重开归零", async () => {
    // 杀什么：:120 的 comment 从 body 摘掉 / 换成恒 null → 「登录按钮的备注」那条红；
    // 摘 `|| null` → 留空腿 body.comment 成 ""（或键整个消失）红；
    // :310 的 rows/maxLength/placeholder 三个属性值各有一处逐字钉。
    const ctl = mockElements();
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    fireEvent.click(screen.getByTestId("ui-element-new"));
    const ta = () => screen.getByTestId("ui-element-new-comment") as HTMLTextAreaElement;
    await screen.findByTestId("ui-element-new-comment");
    // 把手本体：testid 穿透到 textarea，三个属性形状逐字钉
    expect(ta().tagName).toBe("TEXTAREA");
    // antd TextArea 的 autoSize 要等 value 落进 DOM 后才算 rows：等 rows 真到 2 再钉。
    await waitFor(() => expect(ta().rows).toBe(2));
    expect(ta().getAttribute("maxLength")).toBe("500");
    expect(ta().getAttribute("placeholder")).toBe("备注（可选）");
    expect(ta().value).toBe(""); // 受控初值 = cComment 的 useState("")
    // 受控回环：改后 input 里是**未 trim 的原样**（trim 只发生在入 body 那一刻）
    fireEvent.change(ta(), { target: { value: "  登录按钮的备注  " } });
    expect(ta().value).toBe("  登录按钮的备注  ");
    fireEvent.change(screen.getByTestId("ui-element-name"), { target: { value: "登录按钮" } });
    fireEvent.change(screen.getByTestId("ui-element-new-locator"), { target: { value: " #submit " } });
    fireEvent.click(screen.getByTestId("ui-element-new-ok"));
    await waitFor(() => expect(ctl.posts.length).toBe(1));
    const body = ctl.posts[0];
    expect("comment" in body).toBe(true);
    expect(body.comment).toBe("登录按钮的备注"); // :120 trim 后进 body（不是带空格原样）
    expect(body.name).toBe("登录按钮");
    expect(body.locator).toBe("#submit"); // locator 的 trim 同场对照
    expect(body.locator_type).toBe("css"); // cType 默认值 :107
    expect(body.project_public).toBe(true); // :121 写死的项目资产位
    expect(body.module_id).toBeNull(); // 未选模块
    // 成功关窗后重开：备注归零（:124 提交成功 + :205 打开前的两处重置）
    const wrap = document.querySelector(".ant-modal-wrap") as HTMLElement;
    await waitFor(() => expect(wrap.style.display).toBe("none"));
    fireEvent.click(screen.getByTestId("ui-element-new"));
    await waitFor(() => expect(ta().value).toBe(""));
    // 重开时上一次提交的 load() 可能还在飞（okButtonProps confirmLoading 禁用 OK），
    // 禁用的钮点了等于没点：等 busy 落定再点第二次的 OK。
    const ok2 = () => screen.getByTestId("ui-element-new-ok");
    await waitFor(() => expect(ok2().className).not.toContain("ant-btn-loading"));
    // 留空腿：只填必填两项再提 → body.comment 是 null（`|| null` 那半），不是 ""、不是缺键
    fireEvent.change(screen.getByTestId("ui-element-name"), { target: { value: "无备注元素" } });
    fireEvent.change(screen.getByTestId("ui-element-new-locator"), { target: { value: "#y" } });
    fireEvent.click(screen.getByTestId("ui-element-new-ok"));
    await waitFor(() => expect(ctl.posts.length).toBe(2));
    expect("comment" in ctl.posts[1]).toBe(true);
    expect(ctl.posts[1].comment).toBeNull();
  });
});

// 第八道差集第二十三轮（切片 B 的 F6 半边）：本页原先没有任何错误态——列表 500/403 之后
// rows 留在 []，空态于是把「没取到」说成「还没有元素」，而且 listElements 是 silent 请求，
// toast 一消失就只剩这句假话。同病灶在 adbCases.tsx 的 loadError 上已修，这里补齐孪生腿。
describe("列表取数失败不许演成空数据（loadError 态）", () => {
  function mockListFailing(): void {
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ui-modules?")) {
        return { ok: true, status: 200, json: async () => TREE } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({
        code: "db_error", message: "元素库挂了", details: null,
      }) } as unknown as Response;
    })) as unknown as typeof fetch;
  }

  it("列表 500：Alert 说「元素列表加载失败」并带上后端原文", async () => {
    mockListFailing();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("ui-element-load-error")).not.toBeNull());
    expect(screen.getByTestId("ui-element-load-error").textContent).toContain("元素列表加载失败");
    expect(screen.getByTestId("ui-element-load-error").textContent).toContain("元素库挂了");
    // 本页 catch 清行，所以脚注在失败时必须闭嘴：「共 0 条」是拿故障演实测零
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    expect(document.body.textContent).not.toContain("共 0 条");
  });

  it("同一屏的空态不许再说「还没有元素」——失败与真空是两句话", async () => {
    mockListFailing();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("ui-element-load-error")).not.toBeNull());
    expect(document.body.textContent).not.toContain("还没有元素，点右上角新建元素");
    expect(document.body.textContent).toContain("元素列表没取到");
    // 不给 ×：脚注（:313）与空态读同一个 loadError，× 就是「把故障擦成还没有元素」的按钮
    expect(screen.getByTestId("ui-element-load-error").querySelector(".ant-alert-close-icon")).toBeNull();
  });
});

// 第八道差集第二十三轮（uiElements.tsx 脚注）：「共 N 条」只有一次 size=200 的取数作证，
// Page 没有 total（api.ts:76）——游标非空就是后端明说「后面还有」，那时写「共」是把第一页
// 说成全项目普查。变异：删掉成功路径的 setHasMore(l.next_cursor != null) → 第一条红。
// ── D47-b 步5d：「共 N 条」只有服务端 total 这一张嘴 + 页码模式请求形状 ──────────
// 旧用例钉的是游标世界（next_cursor 非空 → 脚注改口「后面还有没取的」）：页码模式下
// 下一页永远点得到，「还有没取的」不再是脚注能说的事，next_cursor 对界面零影响
// （下面拿 cursor:"c2" 钉死）。这是**有意退役**不是静默删测试——scenes/uiCases 同款先例。
describe("「共 N 条」只有服务端 total 这一张嘴（游标对界面零影响）", () => {
  it("total=45 而行数 2：「共 45 条」只跟服务端 total；游标非空不再改口", async () => {
    elementServer([element("e1"), element("e2")], { total: 45, cursor: "c2" });
    renderPage();
    await waitForRows(2);
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    expect(document.body.textContent).not.toContain("共 2 条"); // 行数不是总数
    expect(document.body.textContent).not.toContain("后面还有没取的"); // 游标不再驱动文案
  });

  it("刷新失败清行清 total（旧「上次取到 N 条」腿随游标世界退役）：无行、页脚消失、脚注只说不作数", async () => {
    // 可翻故障的列表桩（uiCases.test.tsx mockList 同款）：成功一轮再翻 fail，模拟
    // 「上一秒还好、这一秒取不到」。页码模式下失败必须把行与 total 一起清掉——陈旧行/
    // 陈旧「共 N 条」+ 新 current 同屏就是「我在第几页」的两把尺子（api.tsx 步4b catch 同款理由）。
    let fail = false;
    const resp = (json: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) }) as unknown as Response;
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ui-modules?")) return resp({ tree: [], recycled: [] });
      if (fail) return resp({ code: "db_error", message: "元素库挂了", details: null }, 500);
      return resp({ items: [element("e1"), element("e2")], next_cursor: null, total: 45 });
    })) as unknown as typeof fetch;
    renderPage();
    await waitForRows(2);
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    fail = true;
    fireEvent.click(screen.getByTestId("ui-element-reload")); // 本页有刷新钮（uiCases 没有）
    await screen.findByTestId("ui-element-load-error");
    expect(screen.queryAllByTestId("ui-element-row-name")).toHaveLength(0);
    expect(screen.queryByTestId("list-pager")).toBeNull(); // 陈旧的「共 45 条」不许挂在空表上
    expect(document.body.textContent).not.toContain("共 45 条");
    expect(document.body.textContent).not.toContain("上次取到");
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
  });

  it("响应没有 total 键（后端游标式形状）→ 页脚整块不渲染，不报「共 0 条」", async () => {
    elementServer([element("e1"), element("e2")], { total: null });
    renderPage();
    await waitForRows(2);
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 0 条");
    expect(document.body.textContent).not.toContain("共 2 条");
  });
});

// ── D47-b 步5d：页码模式主体（①②③⑤ + 换档位回第 1 页）──────────────────────────
// 每页至少钉：① 挂载恰好一条 current=1&size=20 且不带 cursor；② 点第 2 页恰好一条
// current=2 且行是替换；③ 停在第 3 页切回收站 → recycled=true 且 current=1；
// ⑤ 点模块 → module_ids 重复键且只带选中节点**一个**（直属口径）；换档位 → 回第 1 页。
describe("D47-b 步5d 页码模式：current 上线 / 筛选回第 1 页 / module_ids 重复键且直属", () => {
  function node(id: string, name: string, children: ServerTree[] = []): ServerTree {
    return { id, parent_id: null, name, sort: 0, status: "normal", count: 0, children };
  }
  // m-a 带一个子节点 m-a-1：若哪天有人把本页换成 subtreeIds，⑤ 当场红（见用例注释）。
  const TREE2 = [node("m-a", "登录模块", [node("m-a-1", "子模块")]), node("m-b", "结算模块")];
  async function selectModule(name: string): Promise<void> {
    const title = await waitFor(() => {
      const t = Array.from(document.querySelectorAll(".ant-tree-title"))
        .find((n) => (n.textContent ?? "").includes(name));
      if (!t) throw new Error("树里还没有「" + name + "」");
      return t;
    });
    fireEvent.click(title.closest(".ant-tree-node-content-wrapper") as HTMLElement);
  }

  it("① 挂载恰好一条 current=1&size=20 的请求，且任何一条都不带 cursor", async () => {
    const h = elementServer([element("e1"), element("e2"), element("e3")]);
    renderPage();
    await waitForRows(3);
    expect(h.listUrls).toHaveLength(1);
    const q = lastListQ(h);
    expect(q.get("current")).toBe("1");
    expect(q.get("size")).toBe("20");
    expect(q.has("cursor")).toBe(false); // current+cursor 同传后端直接 400，永不同屏
  });

  it("② 点第 2 页恰好一条 current=2（D127 换皮：换页不双发、不空转），行是替换不是追加", async () => {
    // 25 条 + size 20 → 第 2 页 5 条；行名带页号，行集跟着页号走才证明 current 真上了线。
    const rows = Array.from({ length: 25 }, (_, i) => element("e" + (i + 1), { name: "第一页元素" + i }));
    const h = elementServer(rows);
    renderPage();
    await waitForRows(20);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.listUrls).toHaveLength(1); // 挂载恰好一条（② 自身的前提）
    const before = h.listUrls.length;
    clickPage(2);
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    expect(lastListQ(h).get("current")).toBe("2");
    await waitFor(() => expect(screen.getAllByTestId("ui-element-row-name")).toHaveLength(5));
    expect(screen.getAllByTestId("ui-element-row-name")[0].textContent).toBe("第一页元素20");
    // 迟到的重置请求也要抓到：替换落地后请求总数仍恰好 2
    expect(h.listUrls).toHaveLength(2);
  });

  it("③ 停在第 3 页切回收站 → recycled=true 与 current=1 一起上线（唯一写入口的回页）", async () => {
    // 变异靶：patchFilters 里摘掉 setCurrent(1) → current 停在 3，回收集只有 1 行，
    // 第 3 页切片是空的——「切回收站把数据切没了」。正向对照（回收行真落地）同条钉住。
    const rows = Array.from({ length: 55 }, (_, i) => element("e" + (i + 1)));
    const h = elementServer(rows, { recycledRows: [element("e9", { status: "recycled" })] });
    renderPage();
    await waitForRows(20);
    clickPage(3);
    await waitFor(() => expect(lastListQ(h).get("current")).toBe("3")); // 正对照：真停在第 3 页
    const before = h.listUrls.length;
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.get("recycled")).toBe("true");
    expect(q.get("current")).toBe("1"); // 回页：确实从第 3 页被漏斗拍回第 1 页
    await waitFor(() => expect(screen.getByTestId("ui-element-restore")).not.toBeNull());
  });

  it("⑤ 点模块 → module_ids 重复键且只带选中节点**一个**（直属口径，不是漏改也不是子树）", async () => {
    // 这条钉的是「本页仍是直属」：树里 m-a 有真子节点 m-a-1，若有人把这页顺手换成
    // subtreeIds（徽标还是直属数 →「徽标写 3、列表出 7」的 R120 谎），getAll 会多回
    // m-a-1，本条当场红。断言走 getAll（重复键 + 逐值）：逗号拼接解出的 ["a,b"]
    // 会让「url 包含 module_ids」式断言假绿，这里不给他这个机会。
    const h = elementServer([element("e1", { module_id: "m-a" })], { tree: TREE2 });
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    const before = h.listUrls.length;
    await selectModule("登录模块");
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.getAll("module_ids")).toEqual(["m-a"]); // 恰好一次、恰好 m-a：不带 m-a-1/m-b
    expect(q.get("current")).toBe("1");
    // 桩真按重复键过滤：m-a 的行还在（换成逗号拼接后后端解成 ["a,b"] 的静默空集，
    // 这里行集会先红——两把锁各防各的错形）
    await waitFor(() => expect(screen.getAllByTestId("ui-element-row-name").map((n) => n.textContent))
      .toEqual(["登录按钮e1"]));
  });

  it("停在第 3 页换档位到 50 → 恰好一条 size=50&current=1（ListPager 内部回页，页面不许重抄）", async () => {
    const rows = Array.from({ length: 65 }, (_, i) => element("e" + (i + 1)));
    const h = elementServer(rows);
    renderPage();
    await waitForRows(20);
    clickPage(3);
    await waitFor(() => expect(lastListQ(h).get("current")).toBe("3"));
    const before = h.listUrls.length;
    // 档位文案由 AntD locale 拼装（测试环境是英文「50 / page」），只认数字前缀——
    // 逐字照 shared/listPagination.test.tsx 的 pickSize，别拼全文（拼错文案=假绿缺席）。
    const sizeChanger = screen.getByTestId("list-pager")
      .querySelector(".ant-pagination-options-size-changer .ant-select-selector") as HTMLElement;
    fireEvent.mouseDown(sizeChanger);
    const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
    await waitFor(() => expect(Array.from(document.querySelectorAll(contents))
      .some((n) => (n.textContent ?? "").startsWith("50"))).toBe(true));
    const opt = Array.from(document.querySelectorAll(contents))
      .find((n) => (n.textContent ?? "").startsWith("50")) as Element;
    fireEvent.click(opt);
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.get("size")).toBe("50");
    expect(q.get("current")).toBe("1"); // 换档位必回第 1 页（listPagination.tsx 注释③）
  });
});

// 第二十六轮：无新建权限时的空态不许指路到同一棵树里被藏掉的按钮——[新建元素] 挂在
// canCreate && !inRecycled 之后（uiElements.tsx:214），而旧空态对所有人一律说
// 「点右上角新建元素」，承诺的是自己刚藏起来的把手（假门）。真分支逐字不许动：
// 上面 loadError 那条（:385）与 e2e 都按「还没有元素，点右上角新建元素」钉缺席。
describe("无新建权限的空态不许指路到藏掉的[新建元素]（空态 canCreate 分支）", () => {
  it("无 create 位 + 零元素：空态逐字说「还没有元素（你没有新建权限）」，不许出现「点右上角新建元素」", async () => {
    // 杀什么：把空态改回moduleId ? … : "还没有元素，点右上角新建元素"（无 canCreate 分支）
    // → 两条断言同时红（一句演不出、一句演进了不该在的指路）。
    useAuth.setState({ project: READONLY_PROJECT });
    mockElements({ liveRows: [] });
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("还没有元素（你没有新建权限）"));
    expect(document.body.textContent).not.toContain("点右上角新建元素");
    // 空态说「没有新建权限」的当帧，按钮本体（ui-element-new）必须真的不在 DOM——
    // 两句要是能同时成立，说明分支读的不是同一个 canCreate。
    expect(screen.queryByTestId("ui-element-new")).toBeNull();
  });
});

// 同 api.test.tsx 末段：U2（摘掉 loadError={loadError}）是本轮另一个 GREEN——
// 组件侧 M1~M3 只证明「传了才说人话」，页面传不传没钉子。本页 load（:88）把
// /ui-modules 与 /ui-elements 放在同一把 Promise.all 里，列表 500 时树取到了但
// recycled 恒 []，回收站视图正好踩中 ModuleTree.tsx:191 那句「回收站是空的」。
describe("列表失败要传进模块树：回收站栏不许说「回收站是空的」（R26 站点 U2 接线）", () => {
  it("列表 500 后切回收站：这一栏说「回收站没取到」，不说「回收站是空的」", async () => {
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ui-modules?")) {
        return { ok: true, status: 200, json: async () => TREE } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({
        code: "db_error", message: "元素库挂了", details: null,
      }) } as unknown as Response;
    })) as unknown as typeof fetch;
    renderPage();
    await screen.findByTestId("ui-element-load-error");
    fireEvent.click(await screen.findByTestId("module-recycled-toggle"));
    const tip = await screen.findByTestId("module-tree-load-error");
    expect(tip.textContent).toContain("回收站没取到");
    expect(document.body.textContent).not.toContain("回收站是空的");
  });
});

// ── D180：切回收站的竞态窗口（uiCases.test.tsx 同名组的双胞胎，手法照抄）────────
// 点击同步翻 inRecycled，行要等下一次 Promise.all 回包才换；那一格里正常行会挂上
// 回收站模板（删除人列 + 恢复/彻底删除钮）。普通跑法量不到，把回收站那次 GET 挂成
// 手工 deferred。注意本页 catch 清行（uiCases 留行），② 的持久档表现是「行清空 +
// 模板仍不翻 + 空态说没取到」；shownRecycled 失败不翻这条两页同尺。
describe("D180 切回收站的竞态窗口（模板滞后于数据，不是滞后于点击）", () => {
  function okResp(json: unknown, status = 200): Response {
    return { ok: status < 400, status, json: async () => json } as unknown as Response;
  }
  /** 正常列表/树立即回包，回收站那次 GET 挂在手工 deferred 上由用例放行。
   *  liveRows 可换：⑤ 要的是「初始列表本来就空」那一格——表里有行时 antd 不渲染 Empty，
   *  空态那条腿（uiElements.tsx:252）在本文件里一次都没进过分支（leg1 变异本轮实测杀不死）。 */
  function mockRacyList(liveRows: Row[] | null = null) {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((r) => { resolve = r; });
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ui-modules?")) return okResp(TREE);
      if (url.includes("/ui-elements?")) {
        if (url.includes("recycled=true")) return promise;
        return okResp({ items: liveRows ?? [element("e1", {
          updated_by: "u9", updated_by_name: "最后编辑的老李",
          updated_at: "2026-11-01T02:34:56+00:00",
        })], next_cursor: null });
      }
      throw new Error("未 mock 的请求: " + url);
    })) as unknown as typeof fetch;
    return { resolve };
  }
  function recycledCalls(): number {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("/ui-elements?")
        && String(c[0]).includes("recycled=true")).length;
  }
  /** 回收站那次请求的 query（D47-b 步5d：钉 toggle 并口后带 current=1、不带 cursor）。 */
  function recycledQs(): URLSearchParams {
    const hit = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/ui-elements?") && u.includes("recycled=true"));
    expect(hit.length).toBeGreaterThan(0);
    return new URLSearchParams(hit[hit.length - 1].split("?")[1]);
  }
  function raceRowTr(id: string): HTMLElement {
    const tr = document.querySelector<HTMLElement>('tr[data-row-key="' + id + '"]');
    expect(tr).not.toBeNull();
    return tr as HTMLElement;
  }
  function recycledTemplateAbsent(): void {
    expect(screen.queryByTestId("ui-element-recycled-by")).toBeNull();
    expect(screen.queryByTestId("ui-element-recycled-at")).toBeNull();
    expect(screen.queryByTestId("ui-element-restore")).toBeNull();
    expect(screen.queryByTestId("ui-element-purge")).toBeNull();
    expect(screen.queryByText("删除人")).toBeNull();
    expect(document.body.textContent).not.toContain("最后编辑的老李");
    expect(document.body.textContent).not.toContain("回收站视图");
  }

  it("① 点回收站 + 列表在途：正常行不提前挂回收站模板——无删除人列、无恢复/彻底删除、不出现 updated_by_name", async () => {
    const dfd = mockRacyList();
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1)); // 「已在途」变成显式前提
    recycledTemplateAbsent();
    // inRecycled 的本职不变：树栏标题照实说「请求要什么」，不跟着模板滞后
    // 切换钮改为图标钮（2026-11-22 设计改版），文案搬到 aria-label；可访问名与语义不变。
    expect(screen.getByTestId("module-recycled-toggle").getAttribute("aria-label")).toBe("退出回收站");
    // D47-b 步5d：回收站那次请求带 current=1（toggle 已并入 patchFilters 唯一写入口）；
    // 此刻 total 还是上一次成功取数的值——行没下桌、页码器照旧报数，都不算说谎
    expect(recycledQs().get("current")).toBe("1");
    expect(recycledQs().has("cursor")).toBe(false);
    dfd.resolve(okResp({ items: [], next_cursor: null }));
    // 闸门只能数「回收站视图」：本页有模块树（uiElements.tsx:201），那一栏在点击当场就说
    // 「回收站是空的」（桩里 recycled 恒 []），拿它当「列表已回包」的证据会在慢后端下先绿，
    // 于是下一行断言赶在回包之前跑（本轮 R31 探针实测红在这里）。
    await waitFor(() => expect(document.body.textContent).toContain("回收站视图"));
  });

  it("② 点回收站 + 列表回 500（持久档）：加载失败提示照常，模板到死保持正常视图那套", async () => {
    // D180 主案发现场：失败后 inRecycled 停在 true——shownRecycled 不翻，
    // 说谎窗口不许变成永久态（本页 catch 清行，说谎列就更没有行可挂）。
    const dfd = mockRacyList();
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(okResp({ code: "db_error", message: "元素库挂了", details: null }, 500));
    await screen.findByTestId("ui-element-load-error");
    expect(document.body.textContent).toContain("元素库挂了");
    recycledTemplateAbsent();
    expect(document.body.textContent).not.toContain("回收站是空的"); // 失败不演空回收站
    // D47-b 步5d：失败清行清 total → 页脚整块不渲染。陈旧「共 N 条」挂在空表上 = 拿
    // 上一批的总数冒充这一屏（api.tsx / uiCases 同款；旧「上次取到 N 条」腿随游标世界退役）
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 1 条");
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    // 失败后把 500 换成成功也不该有残留：模板只认成功回包（此处不再发请求，只钉当前帧）
  });

  it("③ 请求成功落回回收站视图：两列与两钮照常出现（正向对照，防「永远不显示删除人」也全绿）", async () => {
    const dfd = mockRacyList();
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(okResp({ items: [element("e9", {
      status: "recycled", updated_by: "u9", updated_by_name: "王小回收",
      updated_at: "2026-11-01T02:34:56+00:00",
    })], next_cursor: null }));
    await waitFor(() =>
      expect(screen.getByTestId("ui-element-recycled-by").textContent).toContain("王小回收"));
    // 02:34 UTC +8h = 10:34 上海（timefmt 换算顺带再过一遍）
    expect(screen.getByTestId("ui-element-recycled-at").textContent).toContain("2026-11-01 10:34");
    expect(screen.getByTestId("ui-element-restore")).not.toBeNull();
    expect(screen.getByTestId("ui-element-purge")).not.toBeNull();
    expect(document.body.textContent).toContain("回收站视图");
  });

  it("④ 混合数据正对照：回收站批次里混进 status:normal 的行 → 该行无删除人单元格、无恢复/彻底删除，只有正常视图的回收钮", async () => {
    // 后端正常不给混合数据（case_services.py:159 按 status 过滤），这条是给半 2 的
    // 「逐行身份」买的双保险：陈旧/混合数据也永远不会有彻底删除钮落到活行上。
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ui-modules?")) return okResp(TREE);
      if (url.includes("/ui-elements?")) {
        const items = url.includes("recycled=true") ? [
          element("e9", { status: "recycled", updated_by: "u9", updated_by_name: "王小回收" }),
          element("e8", { updated_by: "u9", updated_by_name: "最后编辑的老李" }),
        ] : [element("e1")];
        return okResp({ items, next_cursor: null });
      }
      throw new Error("未 mock 的请求: " + url);
    })) as unknown as typeof fetch;
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("ui-element-row-name")).toHaveLength(2));
    // 回收行照常：两列 + 两钮（PA 全权限）
    expect(within(raceRowTr("e9")).getByTestId("ui-element-recycled-by").textContent).toContain("王小回收");
    expect(within(raceRowTr("e9")).getByTestId("ui-element-restore")).not.toBeNull();
    expect(within(raceRowTr("e9")).getByTestId("ui-element-purge")).not.toBeNull();
    // 混进来的正常行：删除人单元格不给画（落「—」）、回收站两钮不给，正常视图的回收钮照给
    expect(within(raceRowTr("e8")).queryByTestId("ui-element-recycled-by")).toBeNull();
    expect(within(raceRowTr("e8")).queryByTestId("ui-element-restore")).toBeNull();
    expect(within(raceRowTr("e8")).queryByTestId("ui-element-purge")).toBeNull();
    expect(within(raceRowTr("e8")).getByTestId("ui-element-delete")).not.toBeNull();
    expect(document.body.textContent).not.toContain("最后编辑的老李");
  });

  it("⑤ 空态那条腿：项目里本来就没元素 + 回收站请求在途 → 空态说「还没有元素」，不说「回收站是空的」", async () => {
    // 这条腿要单独的用例：①②③④ 的初始列表恒带一行活元素，有行 ⇒ antd 不渲染 Empty
    // ⇒ uiElements.tsx:252 那条 ternary 从没进过分支，leg1 变异（shownRecycled→inRecycled）
    // 在本文件里杀不死。只有让**初始**列表就是空的，才能量到它。
    // 只查表格自己那份空态：ModuleTree 一栏在点击当场就会说「回收站是空的」（桩里
    // recycled 恒 []），断言整页文本会被这个兄弟满足，gate 不住任何东西。
    const dfd = mockRacyList([]);
    renderPage();
    await waitFor(() => expect(document.querySelector(".ant-table-placeholder")).not.toBeNull());
    const emptyDesc = () => document
      // 2026-11-22 空态改由 StateView 画（统一线稿插画 + 文案层级），不再是 antd Empty——
      // 占位单元格里没有 .ant-empty-description。契约不变：钉的仍是「占位区说了哪句话」，
      // 所以改读整个 .ant-table-placeholder 的文本，文案断言一个字不动。
      .querySelector(".ant-table-placeholder")?.textContent ?? "";
    expect(emptyDesc()).toContain("还没有元素，点右上角新建元素");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1)); // 已在途
    expect(emptyDesc()).not.toContain("回收站是空的");
    // 正对照：真取回空回收站后同一句必须改口，否则这条腿只是「永远不说」
    dfd.resolve(okResp({ items: [], next_cursor: null }));
    await waitFor(() => expect(emptyDesc()).toContain("回收站是空的"));
  });
});

// ── D120：行编辑入口 + PATCH None 语义 + 409 引用清单复用 ─────────────────────
// 编辑弹窗 = 新建弹窗同一套把手（名称/类型▾/表达式/备注）+ 可见性开关；初值 prefill 自行。
// PATCH body 只装**改动项**（后端 None=不改；module_set 恒缺省，行绝不挪模块）。
// 改定位器撞 409 referenced_by_case → 复用删除那条路的同一只清单弹窗（ui-element-refs），
// 且编辑窗不关——用户就在改定位器的现场，清单回答的是「哪几条用例挡着」。
describe("D120 编辑入口（权限门 + 回收行不给 + prefill + PATCH 只发改动项）", () => {
  function editButtonFor(id: string): HTMLElement | null {
    const tr = document.querySelector('tr[data-row-key="' + id + '"]');
    expect(tr).not.toBeNull();
    return (tr as HTMLElement).querySelector('[data-testid="ui-element-edit"]');
  }

  async function openEditModal(id: string): Promise<void> {
    await waitFor(() => expect(editButtonFor(id)).not.toBeNull());
    fireEvent.click(editButtonFor(id) as HTMLElement);
    await screen.findByTestId("ui-element-edit-modal");
  }
  function lastDropdown(): HTMLElement {
    const ds = Array.from(document.querySelectorAll(".ant-select-dropdown"));
    return ds[ds.length - 1] as HTMLElement;
  }

  it("prefill 从行来：名称/类型/表达式/备注/可见性五控件初值 = 行数据；开关文案是公开语义", async () => {
    mockElements({ liveRows: [element("e7", {
      name: "私有备注元素", locator_type: "xpath", locator: "//button",
      comment: "老备注", project_public: false,
    })] });
    renderPage();
    await openEditModal("e7");
    expect((screen.getByTestId("ui-element-edit-name") as HTMLInputElement).value)
      .toBe("私有备注元素");
    const sel = screen.getByTestId("ui-element-edit-type");
    expect(sel.querySelector(".ant-select-selection-item")?.textContent).toBe("xpath");
    expect((screen.getByTestId("ui-element-edit-locator") as HTMLInputElement).value).toBe("//button");
    expect((screen.getByTestId("ui-element-edit-comment") as HTMLTextAreaElement).value).toBe("老备注");
    const sw = screen.getByTestId("ui-element-edit-public");
    expect(sw.getAttribute("aria-checked")).toBe("false"); // project_public:false 预填
    // 词表与新建同一个 LOCATOR_OPTIONS（5 种，R100/D2）：打开下拉逐字对
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    await waitFor(() => expect(
      Array.from(lastDropdown().querySelectorAll(".ant-select-item-option-content"))
        .map((n) => n.textContent),
    ).toEqual(["id", "css", "xpath", "text", "name"]));
    expect(screen.getByText("项目内公开（关掉后仅自己与项目管理员可见）")).not.toBeNull();
    // 无引用行不画引用警示条（used_by=0）
    expect(document.body.textContent).not.toContain("正被");
  });

  it("PATCH 只发改动项：动名字只发 name，动开关只发 project_public；module_set 恒缺省；成功后关窗重刷", async () => {
    const ctl = mockElements();
    renderPage();
    await openEditModal("e1");
    const ok = () => screen.getByTestId("ui-element-edit-ok") as HTMLButtonElement;
    // 零改动直接保存：不发 PATCH（None 语义的反面——把「没改」发成一整包就是假 PATCH）。
    // toast 挂 React 树外的 portal，异步落屏：断言圈进 waitFor（adbCaseDetail.test 同款对策）。
    fireEvent.click(ok());
    expect(ctl.patches.length).toBe(0);
    await waitFor(() => expect(document.body.textContent).toContain("没有改动可保存"));
    // 只改备注（带空格原样进框，trim 只发生在入 body 那一刻，同新建流 :120 手法）
    fireEvent.change(screen.getByTestId("ui-element-edit-comment"),
      { target: { value: "  新备注  " } });
    fireEvent.click(ok());
    await waitFor(() => expect(ctl.patches.length).toBe(1));
    expect(ctl.patches[0].url).toContain("/ui-elements/e1");
    expect(Object.keys(ctl.patches[0].body).sort()).toEqual(["comment", "project_id"]);
    expect(ctl.patches[0].body.comment).toBe("新备注");
    // 成功：关窗 + 列表重拉（mock GET 回原行，所以第二次的 prefill 还是原值）
    await waitFor(() => expect(ctl.getListCount()).toBe(2));
    await openEditModal("e1");
    // 只翻可见性开关 → body 只有 project_public:false（关掉腿）
    fireEvent.click(screen.getByTestId("ui-element-edit-public"));
    fireEvent.click(ok());
    await waitFor(() => expect(ctl.patches.length).toBe(2));
    expect(Object.keys(ctl.patches[1].body).sort()).toEqual(["project_id", "project_public"]);
    expect(ctl.patches[1].body.project_public).toBe(false);
    // 三发 body 里 module_set 一个都没有（弹窗无模块项 → 绝不挪模块）
    for (const p of ctl.patches) expect("module_set" in p.body).toBe(false);
  });

  it("改定位器撞 409 referenced_by_case：复用删除的清单弹窗点名用例，编辑窗不关，撤掉定位改动后仍能存名", async () => {
    const ctl = mockElements();
    ctl.patchFail = { code: "referenced_by_case", message: "被引用", details: {
      cases: [{ id: "c1", name: "登录流程", step_indexes: [0] }],
      referenced_by: 1, details_hidden: false,
    } };
    renderPage();
    await openEditModal("e1");
    // 改定位表达式（used_by=0 的行也照样演 409——引用门是服务端的事）
    fireEvent.change(screen.getByTestId("ui-element-edit-locator"), { target: { value: "#changed" } });
    fireEvent.click(screen.getByTestId("ui-element-edit-ok"));
    // 清单弹窗 = 删除口那只（同一组 testid），标题按入口措辞，用例逐条列出（第 1 步）
    const refs = await screen.findByTestId("ui-element-refs");
    expect(refs.textContent).toContain("登录流程");
    expect(refs.textContent).toContain("第 1 步");
    expect(refs.textContent).toContain("先解引用再来");
    expect(document.body.textContent).toContain("改定位器被拦截：还有 UI 用例在用这个元素");
    // 编辑窗留在原地：改过的值还在（关窗 = 把用户刚写的定位表达式弄丢）
    expect((screen.getByTestId("ui-element-edit-locator") as HTMLInputElement).value).toBe("#changed");
    // 关掉清单后，「没被当成功、列表不重刷」的唯一观察面是 GET 计数（list GET 的 URL 带
    // ?project_id=，与裸 /ui-elements/e1 的 PATCH 天然分得开）；不查 ui-element-refs 的
    // 缺席——antd Modal 关窗走 leave 动画，destroyOnHidden 缺席时壳留在 DOM（display:none），
    // 缺席断言量的不是「关没关」（create 弹窗那组量的是 wrap display，同因）。
    fireEvent.click(screen.getByTestId("ui-element-refs-ok"));
    expect(ctl.getListCount()).toBe(1);
    // 撤掉定位改动、只改名 → PATCH 不含定位字段，成功保存（409 只拦定位器，不拦名字）
    ctl.patchFail = null;
    fireEvent.change(screen.getByTestId("ui-element-edit-locator"), { target: { value: "#submit" } });
    fireEvent.change(screen.getByTestId("ui-element-edit-name"), { target: { value: "改了名的" } });
    fireEvent.click(screen.getByTestId("ui-element-edit-ok"));
    await waitFor(() => expect(ctl.patches.length).toBe(2));
    expect(Object.keys(ctl.patches[1].body).sort()).toEqual(["name", "project_id"]);
    await waitFor(() => expect(ctl.getListCount()).toBe(2));
  });

  it("回收行 / 无 update 位都不画编辑钮：跟位走也不跟视图错", async () => {
    // ① READONLY：行照渲染，编辑钮不在 DOM（隐藏不是禁用）
    useAuth.setState({ project: READONLY_PROJECT });
    mockElements();
    const { unmount } = renderPage();
    await waitFor(() => expect(editButtonFor("e1")).toBeNull());
    expect(screen.queryByTestId("ui-element-row-name")).not.toBeNull();
    unmount();

    cleanup();
    // ② 有 delete 无 update：回收钮在、编辑钮不在——新 <Space> 包装没把两个位焊在一起
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY",
      my_perms: ["ui:element:read", "ui:element:delete", "ui:module:read", "-system:*"] } });
    mockElements();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("ui-element-delete")).not.toBeNull());
    expect(screen.queryByTestId("ui-element-edit")).toBeNull();
  });

  it("回收站视图里回收行只有恢复/彻底删除，没有编辑（后端对回收行 PATCH 直接 404）", async () => {
    mockBackend([element("e9", { status: "recycled" })]);
    renderPage();
    await screen.findByTestId("ui-element-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(screen.getByTestId("ui-element-restore")).not.toBeNull());
    expect(screen.getByTestId("ui-element-purge")).not.toBeNull();
    expect(screen.queryByTestId("ui-element-edit")).toBeNull();
  });
});

// ── D134 空态按真实筛选态归因（D47-b 步5d：归因读**已提交**的 kw，桩真按 keyword/
// module_ids 过滤——行集与归因一起对，桩与页面不许各滤各的；scenes.test.tsx 同名组孪生）──
describe("D134 空态按真实筛选态归因（uiElements.tsx）", () => {
  const emptyDesc = () => document
    // 空态换 StateView 后没有 .ant-empty-description，读整个占位单元格（文案断言不变）。
    .querySelector(".ant-table-placeholder")?.textContent ?? "";
  const TREE_M: ServerTree[] = [{ id: "m1", parent_id: null, name: "空的模块", sort: 0,
    status: "normal", count: 0, children: [] }];
  async function selectModule(name: string): Promise<void> {
    const title = await waitFor(() => {
      const t = Array.from(document.querySelectorAll(".ant-tree-title"))
        .find((n) => (n.textContent ?? "").includes(name));
      if (!t) throw new Error("树里还没有「" + name + "」");
      return t;
    });
    fireEvent.click(title.closest(".ant-tree-node-content-wrapper") as HTMLElement);
  }

  it("只选模块、没提交关键词：怪模块不怪关键词（桩真按 module_ids 过滤）", async () => {
    elementServer([element("e1", { module_id: null })], { tree: TREE_M });
    renderPage();
    await waitForRows(1);
    await selectModule("空的模块");
    await waitFor(() => expect(screen.queryByTestId("ui-element-row-name")).toBeNull());
    expect(emptyDesc()).toBe("该模块下还没有元素");
    expect(document.body.textContent).not.toContain("没有匹配的元素");
  });

  it("有关键词时仍怪关键词：模块半句不许抢走关键词半句（提交后才换归因）", async () => {
    elementServer([element("e1", { module_id: null })], { tree: TREE_M });
    renderPage();
    await waitForRows(1);
    const search = screen.getByTestId("ui-element-search");
    fireEvent.change(search, { target: { value: "查无此词" } });
    await new Promise((r) => setTimeout(r, 120)); // 打字阶段零请求：归因也不许提前改口
    expect(screen.getAllByTestId("ui-element-row-name")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(search, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("ui-element-row-name")).toBeNull());
    expect(emptyDesc()).toBe("没有匹配的元素，换个关键词试试");
    expect(document.body.textContent).not.toContain("该模块下还没有元素");
  });
});

// ── D47-b 步5d：落点横幅在页码模式下必须说真话（D129 的页码换皮 + F9 教训）─────────
// D129 当年禁掉「分页挡住」是因为本页全量取数、那尊神永假；页码模式后**分页真的能挡住
// 落点了**，横幅获得第三句真话——但也仅此三句：行在当前页→「已标出」；详情 found 而不在
// 本页→点名在场的嫌疑人（关键词/模块/后面的页）；详情 404/故障→存在性按证据说。
// F9（台账 §六）：latch「存在」不可测，「它在什么场景下挡住什么」才可测——下面的用例全部
// 是**先制造落点、再改筛选/换页、看横幅说的话对不对**，两向都钉（挡住时不演「已标出」，
// 放行后不许赖着「不在当前这一页」）。存在性由详情探针作证：rows 只剩当前页后，它对
// 「这条元素存在吗」不再能作证（把「被筛选挡住」说成「不存在」= 本 describe 的头号猎物）。
describe("D47-b 步5d 落点横幅：页码/筛选挡住 ≠ 不存在（探针作证 + latch 双向）", () => {
  function renderAt(q: string): void {
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter initialEntries={["/?q=" + q]}><UiElementsPage /></MemoryRouter>
      </ConfigProvider>,
    );
  }
  const banner = () => screen.getByTestId("ui-element-hit");
  async function selectModule(name: string): Promise<void> {
    const title = await waitFor(() => {
      const t = Array.from(document.querySelectorAll(".ant-tree-title"))
        .find((n) => (n.textContent ?? "").includes(name));
      if (!t) throw new Error("树里还没有「" + name + "」");
      return t;
    });
    fireEvent.click(title.closest(".ant-tree-node-content-wrapper") as HTMLElement);
  }

  it("落点在当页（15 行取 e15）：横幅说「已在下表标出」，那一行真带高亮", async () => {
    // mockElements 的响应没有 total 键 → ListPager 整块不渲染（.ant-pagination 缺席
    // 现在的成因是「响应没总数」，不是旧版的「全量取数不分页」——观察面同形，理由换了）。
    mockElements({ liveRows: Array.from({ length: 15 }, (_, i) => element("e" + (i + 1))) });
    renderAt("e15");
    const b = await banner();
    await waitFor(() => expect(b.textContent).toContain("已在下表标出这一行"));
    expect(document.querySelector(".ant-pagination")).toBeNull();
    await waitFor(() => expect(document.querySelectorAll(
      '.ant-table-tbody [data-testid="ui-element-row-name"]')).toHaveLength(15));
    const tr = document.querySelector('tr[data-row-key="e15"]');
    expect(tr).not.toBeNull();
    expect((tr as HTMLElement).className).toContain("tp-row-hit");
  });

  it("模块筛选挡住的落点：横幅说「还在但不在当前这一页」并点名模块筛选；清掉筛选改口「已标出」", async () => {
    // 桩真按 module_ids 过滤：选中 m1 后 e2（未分类）从**服务端响应**里掉出去——
    // rows 里没有它 ≠ 它不存在，探针（found）必须把「这条元素还在」撑住。
    elementServer([element("e1", { module_id: "m1" }), element("e2", { module_id: null })],
      { tree: [{ id: "m1", parent_id: null, name: "登录模块", sort: 0, status: "normal",
        count: 1, children: [] }] });
    renderAt("e2");
    await waitForRows(2);
    await selectModule("登录模块");
    await waitFor(() => expect(screen.getAllByTestId("ui-element-row-name")).toHaveLength(1));
    const b = await waitFor(() => {
      expect(banner().textContent).toContain("这条元素还在，但不在当前这一页");
      return banner();
    });
    expect(b.textContent).toContain("模块筛选");
    expect(b.textContent).toContain("全部元素"); // 出口指真把手（module-all 就在树顶）
    expect(b.textContent).not.toContain("不存在"); // 头号猎物：被筛掉 ≠ 查无此元素
    expect(b.textContent).not.toContain("已在下表标出");
    // 正对照（F9 反向）：清掉模块筛选 → 同一横幅改口「已标出」，行回 DOM
    fireEvent.click(screen.getByTestId("module-all"));
    await waitFor(() => expect(banner().textContent).toContain("已在下表标出这一行"));
    expect(document.querySelector('tr[data-row-key="e2"]')).not.toBeNull();
  });

  it("已提交关键词挡住的落点：横幅点名「搜索关键词」不赖模块；清空后改口「已标出」", async () => {
    // 打字阶段不许改横幅（kw 未提交）；Enter 提交后桩真按 keyword 过滤、行集清空。
    elementServer([element("e1")]);
    renderAt("e1");
    await waitForRows(1);
    const search = screen.getByTestId("ui-element-search");
    fireEvent.change(search, { target: { value: "查无此词" } });
    await new Promise((r) => setTimeout(r, 120));
    expect(banner().textContent).toContain("已在下表标出这一行"); // 打字没挡住任何东西
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(search, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("ui-element-row-name")).toBeNull());
    await waitFor(() => expect(banner().textContent).toContain("被已提交的搜索关键词挡住"));
    expect(banner().textContent).not.toContain("模块筛选"); // 没选模块不许赖不在场的真凶
    expect(banner().textContent).not.toContain("不存在");
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(search, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(banner().textContent).toContain("已在下表标出这一行"));
  });

  it("翻页挡住的落点：横幅直说「在后面的页里」并指页码；翻过去改口「已标出」（D129 后新的真话）", async () => {
    // 25 条 / size 20：落点 e25 在第 2 页。首屏它不在 rows——旧版在这里只有「不在当前列表里」
    // 可说且被禁止提分页；页码模式后「后面的页」是真凶，横幅必须点名它，而且名字取探针
    // （「第二页元素25」）而非裸 id——探针 found 时不许把 id 当名字摊出去。
    const rows = Array.from({ length: 25 }, (_, i) =>
      element("e" + (i + 1), { name: i < 24 ? "填充元素" + i : "第二页元素25" }));
    elementServer(rows);
    renderAt("e25");
    await waitForRows(20);
    const b = await waitFor(() => {
      expect(banner().textContent).toContain("它在列表后面的页里");
      return banner();
    });
    expect(b.textContent).toContain("第二页元素25"); // 名字来自探针，不是裸 e25
    expect(b.textContent).not.toContain("快捷搜索定位到「e25」");
    expect(b.textContent).not.toContain("不存在");
    expect(document.querySelector('tr[data-row-key="e25"]')).toBeNull();
    clickPage(2); // F9 反向：翻页放行后横幅必须改口并高亮
    await waitFor(() => expect(banner().textContent).toContain("已在下表标出这一行"));
    await waitFor(() => expect(document.querySelector('tr[data-row-key="e25"]')).not.toBeNull());
  });

  it("详情 404（真不存在或已回收）：横幅两案并说，不替后端二选一，也不说「已标出」", async () => {
    elementServer([element("e1")]);
    renderAt("ghost");
    await waitForRows(1);
    const b = await waitFor(() => {
      expect(banner().textContent).toContain("要么不存在，要么已被放入回收站");
      return banner();
    });
    expect(b.textContent).not.toContain("已在下表标出");
    expect(b.textContent).not.toContain("正在向元素详情确认");
  });

  it("详情探针故障（500）：横幅说「确认不了」，故障不许演成「不存在」", async () => {
    elementServer([element("e1")], { detailStatus: 500 });
    renderAt("e1");
    await waitForRows(1);
    // rows 里有 e1 → hitRow 在 → 走「已标出」分支？不——探针 500 时 hitRow 仍在（行在当页），
    // 横幅第一优先是 hitRow：行确实画着并高亮，这句是当场事实，不需要存在性作证。
    await waitFor(() => expect(banner().textContent).toContain("已在下表标出这一行"));
    // 所以故障分支要用**不在当页**的落点亮：ghost 不在 rows，探针 500 → 不可知。
    cleanup();
    elementServer([element("e1")], { detailStatus: 500 });
    renderAt("ghost");
    await waitForRows(1);
    const b = await waitFor(() => {
      expect(banner().textContent).toContain("确认不了");
      return banner();
    });
    expect(b.textContent).toContain("不代表这条元素不存在");
    expect(b.textContent).not.toContain("要么不存在");
    expect(b.textContent).not.toContain("已在下表标出");
  });

  it("手动关掉横幅后，换页与改筛选都不许把它顶回来（?q= 一直挂在地址上）", async () => {
    // F9（台账 §六）在本页的换皮：latch 的**存在**不可测，它「在什么场景下挡住什么」才可测。
    // onClose 清的是 hitId，而 hitId 同时喂两处（uiElements.tsx:428 rowClassName 与横幅本体），
    // 所以关一次要掉两样：横幅下桌 + 行高亮下桌。两样都钉——只钉横幅的话，
    // 「另开一个 closed 旗只压横幅、高亮赖着不走」这种写法杀不掉。
    // 关完之后必须再改数据（换页 = rows 整个换掉，是最能让 latch 复活的动作）：
    // 少了这一步，这条用例只测了正向路径，等于没测（F9 原话）。
    const rows = Array.from({ length: 25 }, (_, i) => element("e" + (i + 1)));
    elementServer(rows);
    renderAt("e3");
    await waitFor(() => expect(banner()).not.toBeNull());
    await waitForRows(20);
    const tr = () => document.querySelector('tr[data-row-key="e3"]') as HTMLElement | null;
    expect(tr()).not.toBeNull();
    expect(tr()!.className).toContain("tp-row-hit"); // 前提自证：关之前两样都在场
    fireEvent.click(banner().querySelector(".ant-alert-close-icon") as Element);
    await waitFor(() => expect(screen.queryByTestId("ui-element-hit")).toBeNull());
    expect(tr()!.className).not.toContain("tp-row-hit");
    // 换页：rows 换成另一批全新对象，横幅与高亮都不许跟着回来
    clickPage(2);
    await waitForRows(5);
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByTestId("ui-element-hit")).toBeNull();
    // 改筛选：提交关键词再清空，rows 又换两轮，依旧不许回来
    const search = screen.getByTestId("ui-element-search");
    fireEvent.change(search, { target: { value: "登录按钮" } });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByTestId("ui-element-hit")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    await waitForRows(20);
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByTestId("ui-element-hit")).toBeNull();
    // 落点行回到当页后仍然不高亮——「用户已经说不要了」对两样都成立
    expect(tr()).not.toBeNull();
    expect(tr()!.className).not.toContain("tp-row-hit");
  });
});

// ── uiApi.listElements 的 module_ids 入参契约（api/ui.ts 直接进 fetch 的那一层）──────
// 页面级 ⑤ 只发一个模块 id：`String(["m-a"]) === "m-a"` 与逐个 append 在 URL 上不可区分，
// 逗号拼接变异（qs 的 set(k, String(v)) 对数组的行为——["a","b"] 拼成 "a,b"，后端
// list[str] 解成**一个**值 ["a,b"]：一个模块都匹配不上、列表空且不报错的静默错）在页面级
// 杀不死。这条从 api 层直接钉「请求串上 module_ids 键出现几次、值分别是什么」，
// 两个 id 一上逗号必红（scene.ts 步5b 同款用例的 ui 面孪生）。
describe("uiApi.listElements 的 module_ids 是重复 query 键（逗号拼接是静默错）", () => {
  function captureFetch(): string[] {
    const seen: string[] = [];
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { ok: true, status: 200,
        json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
    })) as unknown as typeof fetch;
    return seen;
  }

  it("module_ids=[m1,m2] → module_ids 键恰好出现 2 次、值按序 m1/m2，串上无逗号编码", async () => {
    const seen = captureFetch();
    await uiApi.listElements({ project_id: "p1", size: 20, current: 1, module_ids: ["m1", "m2"] });
    expect(seen).toHaveLength(1);
    const q = new URLSearchParams(seen[0].split("?")[1]);
    expect(q.getAll("module_ids")).toEqual(["m1", "m2"]);
    expect(seen[0]).not.toContain("%2C"); // 逗号编码 = 拼接变异走私上了线
    // 标量照常在线、空数组 = 不发（不挂空键）
    expect(q.get("current")).toBe("1");
    const seen2 = captureFetch();
    await uiApi.listElements({ project_id: "p1", size: 20, current: 1, module_ids: [] });
    expect(new URLSearchParams(seen2[0].split("?")[1]).getAll("module_ids")).toEqual([]);
  });
});

// ── D220：元素库页的 D47-a 三件套 ────────────────────────────────────────────────
describe("uiElements D220 高级搜索与列设置", () => {
  it("空条件不拼 filter；应用「元素名包含 登录」后下一次列表请求带条件 JSON", async () => {
    const h = elementServer([element("e1", { name: "登录按钮" })]);
    renderPage();
    await waitForRows(1);
    // 空条件整个参数不上线（不是 filter=）
    expect(lastListQ(h).has("filter")).toBe(false);
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(h.listUrls.length).toBe(2));
    // 字段名来自后端 meta 的第一项（name），前端不自列字段
    expect(JSON.parse(lastListQ(h).get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "登录" }],
    });
  });

  it("列设置勾掉「关联用例数」只藏那一列（其余表头原样）", async () => {
    elementServer([element("e1")]);
    renderPage();
    await waitForRows(1);
    const thead = (): string => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("关联用例数");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "定位方式", "表达式", "关联用例数", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("关联用例数")]);
    await waitFor(() => expect(thead()).not.toContain("关联用例数"));
    expect(thead()).toContain("定位方式");
  });
});
