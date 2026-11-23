// 测试计划列表页（D183 步 6a）组件测试。fetch 全 mock，同 schedules.test.tsx 手法。
// 这份文件防的谎，逐条编号：
// ① 无 testplan:plan:read → 表格压根不渲染、列表请求压根不发（不演假空表）；
// ② 写钮缺位一律不渲染（不是禁用）：无 :create 没有[新建]，无 :update/:delete/:manage 行内钮不在；
//    归档走 **:manage**——若实现拿 :update 当归档门，READONLY+update 的用例形状会露馅，
//    所以归档钮的在场/缺席只按 :manage 断言（*:read 下必须不在，["*"] 下必须在）；
// ③ 归档是终态：已归档行**没有**归档把手（后端 409 拒重复归档，摆把手=假门）；
// ④ 列表不画展示态：PlanOut 没有 status 字段，页面不许逐行拉 /status（N+1 + 编数），
//    行内文案里不许出现「未开始/进行中/已完成」任何一词；
// ⑤ 展示态词表外值渲染原文（planDisplayMeta 纯函数，R112：不回落友好标签）；
// ⑥ POST/PATCH body 字段名与后端逐字段一致（断 JSON 本体）；PATCH 回填断了会把描述
//    静默洗成空串——编辑用例断**预填原样回传**；
// ⑦ DELETE 带 JSON body（后端从 body 读 project_id）——只断「发过 DELETE」不算数；
// ⑧ total 只从响应来（行数 2 ≠ 总数 137 的 fixture 让 total=items.length 变异在「共 N 条」露馅）；
//    缺 total 键 → 分页器整块不渲染；total=0 → 大方说「共 0 条」；
// ⑨ 页码请求永远带 current 不带 cursor；翻页恰好一条请求（D127 绊线 renderSettled）；
//    改档位回第 1 页；刷新不回第 1 页；
// ⑩ 取数失败：非 closable 错误条（关掉=只剩空表冒充「没有计划」）、行清零、total 清空、
//    空态文案不许指向不在 DOM 的按钮；
// ⑪ 后端 409/422 的 message 逐字节回显（toBe，前端翻译必红）；
// ⑫ 时间只走 fmtTime（+08:00 ISO → 上海墙钟逐字对，slice/toLocaleString 变异会红）；
// ⑬ 行名**是链接**（6b 落地 /plans/:id 路由后与名称列同批翻）：6a 当初钉「不可点」防的是
//    catch-all 静默弹回工作台；路由真落地后这条钉「点了真去 /plans/p1」——两头不许只改一边。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import PlansPage, { planDisplayMeta } from "./plans";
import { useAuth } from "../auth/store";
import type { components } from "../api/schema";

type PlanOut = components["schemas"]["PlanOut"];
/** D231：列表行多一位 followed（后端 PlanListRowOut；现查 plan_follower，不存列表第二份）。 */
type PlanRow = PlanOut & { followed?: boolean };

function plan(id: string, over: Partial<PlanRow> = {}): PlanRow {
  return { id, project_id: "p1", name: "计划" + id, description: null, archived: false,
    created_by: null, updated_by: null, created_at: null, updated_at: null, ...over };
}

const ROWS: PlanOut[] = [
  plan("p1", { name: "结算回归", description: "覆盖结算主链路", created_at: "2026-11-20T10:30:00+08:00" }),
  plan("p2", { name: "老计划", archived: true, created_at: null }),
];

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

const calls: { url: string; method: string; body: unknown }[] = [];

/** 独特到不可能被硬编码的后端原话（409 重名）——前端翻译/硬编码必被 toBe 抓。 */
const BACKEND_RAW = "同名计划已存在：「结算回归」（含回收墓碑判重，码 0xd183a6）";

interface BackendOpts {
  /** 页码路由：按 current 参数回对应页，响应带 total。不带 = 响应没有 total 键。 */
  paged?: { items: PlanOut[]; total: number }[];
  /** 第一次列表 GET 失败、之后成功（首载失败腿）。 */
  listFailOnce?: boolean;
  /** 第一次成功、第二次起一直失败（刷新失败清零腿）。 */
  listFailAfterFirst?: boolean;
  /** POST /plans 直接失败且 message=BACKEND_RAW。 */
  createFail?: boolean;
  /** 列表返回固定集合（空态两分支用）。 */
  fixedItems?: PlanRow[];
  /** fixedItems 响应里是否带 total 键。 */
  fixedTotal?: number | null;
  /** D211：模块树响应（缺省 = 空树 + 未分组 0）。 */
  tree?: unknown;
}

function mockBackend(over: BackendOpts = {}) {
  calls.length = 0;
  let listFailed = false;
  let listGets = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const resp = (status: number, json: unknown) => ({
      ok: status < 400, status,
      // 深拷同 schedules.test.tsx:129-133：桩不许比真 fetch 更好说话——同引用两次
      // setRows 会被 React 按同一性跳过，无限重取回路就永远测不出。
      json: async () => JSON.parse(JSON.stringify(json)) as unknown,
    }) as unknown as Response;
    if (url.includes("/plans?") && method === "GET") {
      if (over.listFailOnce && !listFailed) { listFailed = true; return resp(503, LOAD503); }
      if (over.listFailAfterFirst) { listGets += 1; if (listGets > 1) return resp(503, LOAD503); }
      if (over.paged) {
        const cur = Number(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("current") ?? "1");
        const p = over.paged[Math.min(Math.max(cur, 1), over.paged.length) - 1];
        return resp(200, { items: p.items, next_cursor: null, total: p.total });
      }
      if (over.fixedItems) {
        return resp(200, over.fixedTotal === undefined
          ? { items: over.fixedItems, next_cursor: null }
          : { items: over.fixedItems, next_cursor: null, total: over.fixedTotal });
      }
      return resp(200, { items: ROWS, next_cursor: null });
    }
    if (url.endsWith("/plans") && method === "POST") {
      if (over.createFail) return resp(409, { code: "name_exists", message: BACKEND_RAW, details: {} });
      return resp(201, { id: "p9", ...body, archived: false, created_at: null, updated_at: null });
    }
    const m = url.match(/\/plans\/([^/?]+)$/);
    if (m && method === "PATCH") {
      const row = ROWS.find((r) => r.id === m[1]) ?? ROWS[0];
      return resp(200, { ...row, ...body });
    }
    if (m && method === "DELETE") return resp(200, { ok: true });
    const a = url.match(/\/plans\/([^/?]+)\/archive$/);
    if (a && method === "POST") {
      const row = ROWS.find((r) => r.id === a[1]) ?? ROWS[0];
      return resp(200, { ...row, archived: true });
    }
    // D231：关注/取关。回执两位都是后端现查结果；这里按路径前缀给确定值，
    // 断的是前端「按当前 followed 选路」与「照抄回执」，不是守桩。
    const f = url.match(/\/plans\/([^/?]+)\/(un)?follow$/);
    if (f && method === "POST") return resp(200, { following: !f[2], follower_count: f[2] ? 2 : 3 });
    // D208：复制。复制件名由后端生成（前端只回显），这里给固定串方便断「用了响应的名」。
    const c = url.match(/\/plans\/([^/?]+)\/copy$/);
    if (c && method === "POST") {
      const row = ROWS.find((r) => r.id === c[1]) ?? ROWS[0];
      return resp(201, { ...row, id: "p9", name: row.name + "_abcde_COPY", archived: false });
    }
    // D209：批量删。后端回 {ok:true}；断 body 时前端不许传「选中行的其他字段」。
    if (url.endsWith("/plans/batch-delete") && method === "POST") {
      return resp(200, { ok: true });
    }
    // D211：模块树（左树首载；缺省给空树）。CRUD 回固定形状，断点靠 calls 里的 body。
    if (url.includes("/plan-modules/tree") && method === "GET") {
      return resp(200, over.tree ?? { nodes: [], unassigned_count: 0 });
    }
    if (url.endsWith("/plan-modules") && method === "POST") {
      return resp(201, { id: "m9", parent_id: null, name: (body as { name: string }).name,
        sort: 0, plan_count: 0, children: [] });
    }
    const mu = url.match(/\/plan-modules\/([^/?]+)$/);
    if (mu && method === "PATCH") {
      return resp(200, { id: mu[1], parent_id: null, name: (body as { name: string }).name,
        sort: 0, plan_count: 0, children: [] });
    }
    const md = url.match(/\/plan-modules\/([^/?]+)\/delete$/);
    if (md && method === "POST") return resp(200, { ok: true });
    // D212：高级搜索元数据 + 个人视图（工具条首载两请求）。
    if (url.includes("/filter-meta") && method === "GET") {
      return resp(200, {
        view_type: "plan",
        fields: [
          { field: "name", label: "计划名称", kind: "text",
            ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"] },
          { field: "archived", label: "是否归档", kind: "bool", ops: ["EQUALS", "NOT_EQUALS"] },
          { field: "module_id", label: "所属模块", kind: "id",
            ops: ["IN", "NOT_IN", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"] },
          { field: "created_at", label: "创建时间", kind: "time", ops: ["GT", "LT", "BETWEEN"] },
        ],
        supported_view_types: ["plan"],
        unavailable: {},
      });
    }
    if (url.includes("/saved-views") && method === "GET") return resp(200, []);
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

const LOAD503 = { code: "plan_unavailable", message: "计划服务暂不可用：DB 连接超时", details: {} };

// vitest 无 globals ⇒ RTL 自动 cleanup 不注册：两头各清一次（schedules.test.tsx:187-189 同款）。
afterEach(cleanup);
beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

function renderPage(entry = "/plans"): void {
  render(<MemoryRouter initialEntries={[entry]}><PlansPage /></MemoryRouter>);
}

/** 表内行 id（按行名链接 testid 认行，比数 tr 稳）。 */
function shownPlanRows(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='plans-row-']"))
    .map((n) => (n.getAttribute("data-testid") ?? "").replace("plans-row-", ""));
}
function listReqs(): typeof calls {
  return calls.filter((c) => c.method === "GET" && c.url.includes("/plans?"));
}
/** 渲染 + 等首屏行落地 + D127 绊线：300ms 观察窗后列表 GET 必须恰好一条。 */
async function renderSettled(): Promise<void> {
  renderPage();
  await waitFor(() => expect(shownPlanRows().length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 300));
  expect(listReqs()).toHaveLength(1);
}

/** 页码一律走类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
function pager(): HTMLElement {
  return screen.getByTestId("list-pager");
}
function clickPage(n: number): void {
  fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
}
/** 展开档位下拉并按数字前缀点其中一项（同 schedules.test.tsx pickPagerSize）。 */
async function pickPagerSize(prefix: string): Promise<void> {
  const sel = pager().querySelector(".ant-pagination-options-size-changer .ant-select-selector") as HTMLElement;
  fireEvent.mouseDown(sel);
  const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
  await waitFor(() => expect(
    Array.from(document.querySelectorAll(contents))
      .some((n) => (n.textContent ?? "").startsWith(prefix))).toBe(true));
  const opt = Array.from(document.querySelectorAll(contents))
    .find((n) => (n.textContent ?? "").startsWith(prefix)) as Element;
  fireEvent.click(opt);
}

/** 页码 fixture：3 页各两行、total=137（行数 ≠ 总数，total 冒充在「共 N 条」露馅）。 */
const PAGED = [
  { items: [ROWS[0], ROWS[1]], total: 137 },
  { items: [plan("p3"), plan("p4")], total: 137 },
  { items: [plan("p5"), plan("p6")], total: 137 },
];

describe("权限门", () => {
  it("无 testplan:plan:read：表格不渲染，列表请求压根不发", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER", my_perms: ["notify:channel:read"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plans-no-read")).not.toBeNull());
    expect(screen.queryByTestId("plans-table")).toBeNull();
    expect(calls.some((c) => c.url.includes("/plans?"))).toBe(false);
  });

  it("READONLY（*:read）：读得到表；新建/编辑/归档/删除都不在 DOM；挂稳后列表 GET 恰好一条（D127 绊线）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    renderPage();
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    await new Promise((r) => setTimeout(r, 300));
    expect(listReqs()).toHaveLength(1); // 回路在：load 依赖里塞回它写的 state → 这里红
    expect(screen.queryByTestId("plans-create")).toBeNull();
    expect(screen.queryByTestId("plans-edit-p1")).toBeNull();
    expect(screen.queryByTestId("plans-copy-p1")).toBeNull(); // D208：复制与新建同门（:create）
    expect(screen.queryByTestId("plans-archive-p1")).toBeNull(); // :manage 缺位 → 不渲染（非禁用）
    expect(screen.queryByTestId("plans-remove-p1")).toBeNull();
    // 正对照：不是整块操作列没了——编辑钮的缺席和「操作列压根没渲染」得区分开：
    // 有 :read 有行、表格在（shownPlanRows 已证），按钮由权限而非渲染缺失。
    expect(screen.getByTestId("plans-table")).not.toBeNull();
  });

  it("持 * 的人：新建/编辑/归档/删除都在；**已归档行没有归档把手**（终态不摆假门）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    expect(screen.getByTestId("plans-create")).not.toBeNull();
    expect(screen.getByTestId("plans-edit-p1")).not.toBeNull();
    expect(screen.getByTestId("plans-copy-p1")).not.toBeNull(); // D208
    expect(screen.getByTestId("plans-archive-p1")).not.toBeNull();
    expect(screen.getByTestId("plans-remove-p1")).not.toBeNull();
    // p2 已归档：归档钮不存在（后端对已归档再归档 409——点了必失败的把手就是假门）
    expect(screen.queryByTestId("plans-archive-p2")).toBeNull();
    // 但删除对已归档行照在（归档 ≠ 只读，后端 DELETE 不拦归档件）
    expect(screen.getByTestId("plans-remove-p2")).not.toBeNull();
  });
});

describe("D208 复制计划", () => {
  it("点击复制发 POST /plans/{id}/copy（body 只有 project_id）、回显后端生成的名并重取列表", async () => {
    mockBackend();
    await renderSettled();
    fireEvent.click(screen.getByTestId("plans-copy-p1"));
    await waitFor(() => expect(
      calls.filter((c) => c.method === "POST" && c.url.includes("/plans/p1/copy"))).toHaveLength(1));
    const req = calls.find((c) => c.method === "POST" && c.url.includes("/copy"))!;
    // 只发 project_id：name 省略 = 后端生成 `<源名>_<5位>_COPY`（前端不自己拼名）
    expect(req.body).toEqual({ project_id: "p1" });
    // 复制后重新取列表（新计划可能不在当前页，前端不往 rows 里塞凭空位置）
    await waitFor(() => expect(listReqs()).toHaveLength(2));
  });

  it("READONLY 已归档行也无复制钮——复制与新建同门（:create）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    await renderSettled();
    expect(screen.queryByTestId("plans-copy-p1")).toBeNull();
    expect(screen.queryByTestId("plans-copy-p2")).toBeNull();
  });
});

describe("D209 批量删除计划", () => {
  it("勾选行后出现批量删除钮；确认发 POST /plans/batch-delete（body 只带 project_id + plan_ids），成功后清勾选并重取列表", async () => {
    mockBackend();
    await renderSettled();
    fireEvent.click(document.querySelector(".ant-table-thead input[type='checkbox']") as Element);
    await waitFor(() => expect(screen.getByTestId("plans-batch-delete")).not.toBeNull());
    expect(screen.getByTestId("plans-batch-delete").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("plans-batch-delete"));
    fireEvent.click(await screen.findByTestId("plans-batch-delete-ok"));
    await waitFor(() => expect(
      calls.filter((c) => c.method === "POST" && c.url.endsWith("/plans/batch-delete"))).toHaveLength(1));
    const req = calls.find((c) => c.method === "POST" && c.url.endsWith("/plans/batch-delete"))!;
    // 只带 id 列表：行对象里的 name/archived 等不许混进请求（后端 schema 也会拒未知字段之外的噪音）
    expect(req.body).toEqual({ project_id: "p1", plan_ids: ["p1", "p2"] });
    // 本地不先删行：等后端成功后再取列表；且勾选集清空 → 批量钮消失
    await waitFor(() => expect(listReqs()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("plans-batch-delete")).toBeNull());
  });

  it("READONLY：没有勾选列、也没有批量删除钮（不摆用不了的把手）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    await renderSettled();
    expect(document.querySelector(".ant-table-thead input[type='checkbox']")).toBeNull();
    expect(screen.queryByTestId("plans-batch-delete")).toBeNull();
  });
});

describe("D211 计划模块树", () => {
  // 根 m1 计数 2（直属），子 m2 计数 1：父不并入子树，钉「直属」口径。
  const TREE = { unassigned_count: 3, nodes: [{
    id: "m1", parent_id: null, name: "回归", sort: 0, plan_count: 2,
    children: [{ id: "m2", parent_id: "m1", name: "结算", sort: 0, plan_count: 1, children: [] }],
  }] };

  it("左树渲染模块名与直属计数；点模块发 module_id（整棵子树口径）、点未分组发 unassigned=true 且不带 module_id", async () => {
    mockBackend({ tree: TREE });
    await renderSettled();
    expect(screen.getByTestId("plan-module-node-m1").textContent).toContain("回归");
    expect(screen.getByTestId("plan-module-node-m1").textContent).toContain("2");
    expect(screen.getByTestId("plan-module-unassigned").textContent).toContain("3");
    // 未分组计数是树外入口的事，不混进模块节点（「未分组」不是模块）
    expect(screen.getByTestId("plan-module-node-m1").textContent).not.toContain("未分组");

    fireEvent.click(screen.getByTestId("plan-module-node-m1"));
    await waitFor(() => expect(listReqs().at(-1)!.url).toContain("module_id=m1"));
    expect(new URLSearchParams(listReqs().at(-1)!.url.split("?")[1]).get("current")).toBe("1");

    fireEvent.click(screen.getByTestId("plan-module-unassigned"));
    await waitFor(() => expect(listReqs().at(-1)!.url).toContain("unassigned=true"));
    expect(listReqs().at(-1)!.url).not.toContain("module_id=");
    // 回「全部计划」= 两个过滤键都不带
    fireEvent.click(screen.getByTestId("plan-module-all"));
    await waitFor(() => {
      const q = new URLSearchParams(listReqs().at(-1)!.url.split("?")[1]);
      expect(q.has("module_id")).toBe(false);
      expect(q.has("unassigned")).toBe(false);
    });
  });

  it("选中模块后新建计划：POST /plans body 带 module_id（默认未分组路径由既有用例逐字钉住不许多发键）", async () => {
    mockBackend({ tree: TREE });
    await renderSettled();
    fireEvent.click(screen.getByTestId("plan-module-node-m1"));
    await waitFor(() => expect(listReqs().at(-1)!.url).toContain("module_id=m1"));
    fireEvent.click(screen.getByTestId("plans-create"));
    await screen.findByTestId("plan-field-name");
    fireEvent.change(screen.getByTestId("plan-field-name"), { target: { value: "模块内新计划" } });
    fireEvent.click(screen.getByTestId("plan-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/plans"))).toBe(true));
    const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/plans"))!;
    expect(c.body).toEqual({ project_id: "p1", name: "模块内新计划", description: "", module_id: "m1" });
  });

  it("新建模块：POST /plan-modules body 恰 {project_id,parent_id,name}，成功重取树；未选中模块时不摆改名/删除把手", async () => {
    mockBackend({ tree: TREE });
    await renderSettled();
    expect(screen.queryByTestId("plan-module-rename")).toBeNull();
    expect(screen.queryByTestId("plan-module-delete")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-module-new"));
    const input = await screen.findByTestId("plan-module-name-input");
    fireEvent.change(input, { target: { value: "新模块" } });
    fireEvent.click(screen.getByTestId("plan-module-name-ok"));
    await waitFor(() => expect(
      calls.some((c) => c.method === "POST" && c.url.endsWith("/plan-modules"))).toBe(true));
    const req = calls.find((c) => c.method === "POST" && c.url.endsWith("/plan-modules"))!;
    expect(req.body).toEqual({ project_id: "p1", parent_id: null, name: "新模块" });
    // 首载 1 次 + 写后 1 次
    await waitFor(() => expect(
      calls.filter((c) => c.url.includes("/plan-modules/tree")).length).toBe(2));
  });

  it("READONLY：树照读（计数可见），新建/改名/删除模块都不在 DOM", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend({ tree: TREE });
    await renderSettled();
    expect(screen.getByTestId("plan-module-node-m1")).not.toBeNull();
    expect(screen.queryByTestId("plan-module-new")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-module-node-m1"));
    await waitFor(() => expect(listReqs().at(-1)!.url).toContain("module_id=m1"));
    expect(screen.queryByTestId("plan-module-rename")).toBeNull();
    expect(screen.queryByTestId("plan-module-delete")).toBeNull();
  });
});

describe("D212 计划列表高级搜索 / 列设置", () => {
  const sentFilter = (c: { url: string }) => {
    const raw = new URL(c.url, "http://x").searchParams.get("filter");
    return raw === null ? null : JSON.parse(raw);
  };

  it("空条件不拼 filter；应用「名称包含 结算」后下一次列表请求带条件 JSON", async () => {
    mockBackend();
    await renderSettled();
    expect(sentFilter(listReqs()[0])).toBeNull();
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const row = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(row).getByTestId("lt-val-text"), { target: { value: "结算" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listReqs()).toHaveLength(2));
    expect(sentFilter(listReqs()[1])).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "结算" }],
    });
  });

  it("列设置勾掉「描述」只藏那一列（其余表头原样）", async () => {
    localStorage.clear();
    mockBackend();
    await renderSettled();
    const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("描述");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "描述", "归档", "创建时间", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("描述")]);
    await waitFor(() => expect(thead()).not.toContain("描述"));
    expect(thead()).toContain("归档");
  });
});

describe("行渲染（只画后端答过的问题）", () => {
  it("name/描述/归档/时间从 payload 来；时间走 fmtTime（+08:00 → 上海墙钟，缺 →「—」）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    expect(screen.getByTestId("plans-row-p1").textContent).toBe("结算回归");
    expect(screen.getByTestId("plans-row-p2").textContent).toBe("老计划");
    const tags = screen.getAllByTestId("plans-archived-tag").map((n) => n.textContent);
    expect(tags).toEqual(["未归档", "已归档"]);
    // 时间列按行重复出现（p1 行在前）：正对照 + 缺值分支各钉一次
    const created = screen.getAllByTestId("plans-created").map((n) => n.textContent);
    expect(created).toEqual(["2026-11-20 10:30:00", "—"]); // +08:00 ISO → 上海墙钟（slice 变异会红）
    expect(screen.getAllByTestId("plans-updated").map((n) => n.textContent)).toEqual(["—", "—"]);
    // 页面契约（nav.spec 同源）：page-plans + PageHead 标题
    expect(screen.getByTestId("page-plans")).not.toBeNull();
    expect(document.querySelector(".tp-page-title")?.textContent).toBe("测试计划");
  });

  it("行名**是链接且点了真导航**：/plans/:id 已由 6b 落地，⑬ 随路由同批翻（6a 防的弹回工作台已不存在）", async () => {
    // 依据：app.tsx 的 `{path:"plans/:id"}` 真路由已落地——catch-all 弹回工作台的前提消失，
    // 名称列（plans.tsx 名称列注释）与这条断言在同一个改动里翻面，两头不许只改一边。
    // 这里用 Routes 装一个探针页：断「点了之后屏幕上真换成 /plans/p1 对应的页面」。
    mockBackend();
    render(
      <MemoryRouter initialEntries={["/plans"]}>
        <Routes>
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/plans/:id" element={<div data-testid="detail-probe">详情探针</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    const cell = screen.getByTestId("plans-row-p1");
    expect(cell.tagName).toBe("A"); // 是链接（6a 钉的是 not.toBe("A")，翻转要断得同样死）
    fireEvent.click(cell);
    await waitFor(() => expect(screen.getByTestId("detail-probe")).not.toBeNull());
  });

  it("列表不画展示态：行内零「未开始/进行中/已完成」，且全程零 /status 请求（不 N+1 编数）", async () => {
    mockBackend();
    await renderSettled();
    const table = screen.getByTestId("plans-table").textContent ?? "";
    expect(table).not.toContain("未开始");
    expect(table).not.toContain("进行中");
    expect(table).not.toContain("已完成");
    expect(calls.some((c) => c.url.includes("/status"))).toBe(false);
  });
});

describe("展示态词表纯函数（R112：词表外渲染原文）", () => {
  it("四态有中文文案；词表外值原样 + default 色，绝不回落友好标签", () => {
    expect(planDisplayMeta("not_started")).toEqual({ label: "未开始", color: "default" });
    expect(planDisplayMeta("completed")).toEqual({ label: "已完成", color: "green" });
    expect(planDisplayMeta("in_progress")).toEqual({ label: "进行中", color: "processing" });
    expect(planDisplayMeta("archived")).toEqual({ label: "已归档", color: "default" });
    // 后端哪天加第五态而词表没跟上：画原文（生码），不画「进行中」（撒谎）。
    expect(planDisplayMeta("awaiting_approval")).toEqual({ label: "awaiting_approval", color: "default" });
  });
});

describe("新建 / 编辑（断 body JSON 本体，不钉「发过请求」）", () => {
  it("新建：POST /plans 的 body 字段名与 PlanCreateIn 完全一致，成功后重拉列表", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plans-create")).not.toBeNull());
    const before = listReqs().length;
    fireEvent.click(screen.getByTestId("plans-create"));
    await screen.findByTestId("plan-field-name");
    fireEvent.change(screen.getByTestId("plan-field-name"), { target: { value: "结算回归 v2" } });
    fireEvent.change(screen.getByTestId("plan-field-description"), { target: { value: "跨期" } });
    fireEvent.click(screen.getByTestId("plan-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/plans"))).toBe(true));
    const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/plans"))!;
    expect(c.body).toEqual({ project_id: "p1", name: "结算回归 v2", description: "跨期" });
    await waitFor(() => expect(listReqs().length).toBeGreaterThan(before)); // 重拉，不本地插行
  });

  it("编辑：预填原样回传——PATCH body 逐字段 {project_id,name,description}（回填断了会把描述静默洗没）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plans-edit-p1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plans-edit-p1"));
    const nameEl = await screen.findByTestId("plan-field-name");
    // 正对照：回填真的发生（值来自行数据），否则「保存洗掉描述」的变异在这先红
    expect((nameEl as HTMLInputElement).value).toBe("结算回归");
    expect((screen.getByTestId("plan-field-description") as HTMLTextAreaElement).value).toBe("覆盖结算主链路");
    fireEvent.change(nameEl, { target: { value: "结算回归 v2" } });
    fireEvent.click(screen.getByTestId("plan-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect(c.url).toContain("/plans/p1");
    expect(c.body).toEqual({ project_id: "p1", name: "结算回归 v2", description: "覆盖结算主链路" });
  });

  it("后端 409 的 message 逐字节进 Alert（原话回显不翻译），弹窗留着可改可重试", async () => {
    mockBackend({ createFail: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plans-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plans-create"));
    await screen.findByTestId("plan-field-name");
    fireEvent.change(screen.getByTestId("plan-field-name"), { target: { value: "结算回归" } });
    fireEvent.click(screen.getByTestId("plan-save"));
    const alert = await screen.findByTestId("plan-save-error");
    expect(alert.className).toContain("ant-alert-error");
    expect(screen.getByTestId("plan-save-error-text").textContent).toBe(BACKEND_RAW); // toBe：翻译必红
    expect(screen.getByTestId("plan-field-name")).not.toBeNull(); // 失败不关窗，可改完重试
  });
});

describe("归档 / 删除（终态与级联都是后端口径，按钮只按权限位出现）", () => {
  it("归档：确认文案说终态无反归档；POST /plans/p1/archive body 恰好 {project_id}；行翻成已归档", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plans-archive-p1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plans-archive-p1"));
    const okBtn = await screen.findByTestId("plans-archive-ok");
    expect(document.body.textContent).toContain("没有反归档入口"); // 确认框与后端行为一致
    fireEvent.click(okBtn);
    await waitFor(() => expect(calls.some(
      (c) => c.method === "POST" && c.url.endsWith("/plans/p1/archive"))).toBe(true));
    const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/archive"))!;
    expect(c.body).toEqual({ project_id: "p1" });
    // 响应行（archived:true）落表：p1 的徽标翻「已归档」，且 p1 的归档把手消失（终态）
    await waitFor(() => expect(
      screen.getAllByTestId("plans-archived-tag").map((n) => n.textContent)).toEqual(["已归档", "已归档"]));
    expect(screen.queryByTestId("plans-archive-p1")).toBeNull();
  });

  it("删除：DELETE 带 JSON body {project_id}（后端从 body 读）；行下桌", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plans-remove-p1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plans-remove-p1"));
    fireEvent.click(await screen.findByTestId("plans-delete-ok"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/plans/p1"))).toBe(true));
    const c = calls.find((x) => x.method === "DELETE")!;
    expect(c.body).toEqual({ project_id: "p1" }); // 只断「发过 DELETE」= 没断 body
    await waitFor(() => expect(shownPlanRows()).toEqual(["p2"]));
  });
});

describe("页码分页：current / total 的线上形状", () => {
  it("total=137 → 「共 137 条」（行数 2 ≠ 总数）；每条请求 current=1&size=50，任何一条不带 cursor", async () => {
    mockBackend({ paged: PAGED });
    renderPage();
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    expect(pager().textContent).toContain("共 137 条");
    expect(listReqs().length).toBeGreaterThan(0); // 正对照
    for (const c of listReqs()) {
      const q = new URLSearchParams(c.url.slice(c.url.indexOf("?") + 1));
      expect(q.get("current")).toBe("1");
      expect(q.get("size")).toBe("50");
    }
    expect(listReqs().some((c) => c.url.includes("cursor="))).toBe(false);
  });

  it("响应没有 total 键 → 分页器整块不渲染，不挂假「共 0 条」；行照渲染", async () => {
    mockBackend();
    await renderSettled(); // 默认响应无 total 键
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(shownPlanRows().length).toBeGreaterThan(0);
  });

  it("点第 3 页：恰好一条 current=3 请求（无 cursor），行是替换不是追加，高亮跟到 3", async () => {
    mockBackend({ paged: PAGED });
    renderPage();
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    const before = listReqs().length;
    clickPage(3);
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const q = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1));
    expect(q.get("current")).toBe("3");
    expect(q.has("cursor")).toBe(false);
    await waitFor(() => expect(shownPlanRows()).toEqual(["p5", "p6"])); // append 变异这里是 6 行
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
    expect(listReqs().length).toBe(before + 1); // 迟到的重置请求也要抓到
  });

  it("停在第 3 页换 100/页 → 线上一条 size=100&current=1（换档位必回第 1 页）", async () => {
    mockBackend({ paged: PAGED });
    renderPage();
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    const atPage3 = listReqs().length;
    clickPage(3);
    await waitFor(() => expect(listReqs().length).toBe(atPage3 + 1));
    const landed = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1));
    expect(landed.get("current")).toBe("3"); // 正对照：换档位前确实停在第 3 页
    const before = listReqs().length;
    await pickPagerSize("100");
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const q = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1));
    expect(q.get("size")).toBe("100");
    expect(q.get("current")).toBe("1");
  });

  it("停在第 3 页点刷新 → 重发的是 current=3，不回第 1 页", async () => {
    mockBackend({ paged: PAGED });
    renderPage();
    await waitFor(() => expect(shownPlanRows()).toEqual(["p1", "p2"]));
    clickPage(3);
    await waitFor(() => expect(listReqs().at(-1)!.url).toContain("current=3"));
    const before = listReqs().length;
    fireEvent.click(screen.getByTestId("plans-reload"));
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const q = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1));
    expect(q.get("current")).toBe("3");
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
  });

  it("取数失败不留谎脚注：先「共 137 条」，刷新失败后分页器整块消失、行清零", async () => {
    mockBackend({ paged: PAGED, listFailAfterFirst: true });
    renderPage();
    await waitFor(() => expect(pager().textContent).toContain("共 137 条"));
    fireEvent.click(screen.getByTestId("plans-reload"));
    await waitFor(() => expect(screen.getByTestId("plans-load-error")).not.toBeNull());
    await waitFor(() => expect(shownPlanRows()).toEqual([]));
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(screen.queryByText("共 137 条")).toBeNull();
  });
});

describe("失败与空态（空态文案不许指向不在 DOM 的按钮）", () => {
  it("首载 503：非 closable 错误条 + 后端原话；行清零；不出现「还没有计划」这种把失败演成空", async () => {
    mockBackend({ listFailOnce: true });
    renderPage();
    const alert = await screen.findByTestId("plans-load-error");
    expect(alert.textContent).toContain("测试计划列表加载失败");
    expect(alert.textContent).toContain("计划服务暂不可用：DB 连接超时"); // 原话进 description
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull(); // × = 消证按钮，不许有
    expect(shownPlanRows()).toEqual([]);
    await waitFor(() => expect(screen.queryByText(/还没有计划/)).toBeNull());
  });

  it("空表两分支：无 :create 说「你没有新建权限」且新建不在 DOM；有 :create 才指路右上角；total=0 大方说「共 0 条」", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend({ fixedItems: [], fixedTotal: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByText("共 0 条")).not.toBeNull());
    await waitFor(() => expect(screen.getByText(/还没有计划（你没有新建权限）/)).not.toBeNull());
    expect(screen.queryByTestId("plans-create")).toBeNull();
  });

  it("空表（有新建权限）：指路「点右上角新建」，且该钮真在 DOM 里（指路不是假门）", async () => {
    mockBackend({ fixedItems: [], fixedTotal: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByText(/还没有计划，点右上角新建/)).not.toBeNull());
    expect(screen.getByTestId("plans-create")).not.toBeNull();
  });
});

describe("D231 计划关注（视图轴 + 星标）", () => {
  it("① 星标吃列表行的 followed；点星按当前态选 follow/unfollow，回执只改这一行", async () => {
    mockBackend({
      fixedItems: [
        plan("p1", { name: "甲计划", followed: true }),
        plan("p2", { name: "乙计划", followed: false }),
      ],
      fixedTotal: 2,
    });
    await renderSettled();
    expect(screen.getByTestId("plans-follow-p1").getAttribute("data-followed")).toBe("true");
    expect(screen.getByTestId("plans-follow-p2").getAttribute("data-followed")).toBe("false");

    fireEvent.click(screen.getByTestId("plans-follow-p2"));
    await waitFor(() => expect(calls.some(
      (c) => c.url === "/api/v1/plans/p2/follow" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.url === "/api/v1/plans/p2/follow")!.body)
      .toEqual({ project_id: "p1" });
    // 回执 following=true → 只改 p2；p1 的星标不受影响（不是整表重取/整表重算）。
    await waitFor(() => expect(screen.getByTestId("plans-follow-p2")
      .getAttribute("data-followed")).toBe("true"));
    expect(screen.getByTestId("plans-follow-p1").getAttribute("data-followed")).toBe("true");

    fireEvent.click(screen.getByTestId("plans-follow-p1"));
    await waitFor(() => expect(screen.getByTestId("plans-follow-p1")
      .getAttribute("data-followed")).toBe("false"));
    expect(calls.some((c) => c.url === "/api/v1/plans/p1/unfollow" && c.method === "POST")).toBe(true);
  });

  it("② 「我关注的」是后端筛：带 followed_by_me=true 且回第 1 页；关掉后不再带这个键", async () => {
    mockBackend();
    await renderSettled();
    expect(listReqs().some((c) => c.url.includes("followed_by_me"))).toBe(false);

    fireEvent.click(screen.getByTestId("plans-followed-only"));
    await waitFor(() => expect(listReqs().some(
      (c) => c.url.includes("followed_by_me=true"))).toBe(true));
    expect(listReqs().at(-1)!.url).toContain("current=1");

    fireEvent.click(screen.getByTestId("plans-followed-only"));
    await waitFor(() => expect(listReqs().at(-1)!.url).not.toContain("followed_by_me"));
  });

  it("③ READONLY：星标不渲染（关注是写位 :update），筛选开关是读行为照常在场", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend({ fixedItems: [plan("p1", { followed: true })], fixedTotal: 1 });
    await renderSettled();
    expect(screen.queryByTestId("plans-follow-p1")).toBeNull();
    expect(screen.getByTestId("plans-followed-only")).not.toBeNull();
  });
});
