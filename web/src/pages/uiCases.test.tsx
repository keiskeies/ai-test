// UI 用例列表页（D73 回收站补洞）的组件测试。形状照抄 uiElements.test.tsx（角色门控 +
// 回收站两列守卫）与 adbCases.test.tsx（回收站视图 + 彻底删除输名），手法同款：
// fetch 全 mock 到 client 的 fetch 层、useAuth.setState 注项目/权限。
// 钉四件最容易坏的事：
// ① 角色门控三档（一期 DoD 第 3 条 / §11.11「按钮级权限点隐藏（非禁用）」）：
//    PA 全在；MEMBER（-*:delete）有 [恢复] 无 [删除]/[彻底删除]；READONLY 三钮全无（行照渲染）；
// ② 回收站两列的 inRecycled 守卫：正常行上 updated_by 是最后编辑人，标成「删除人」就是说谎；
// ③ 彻底删除必须逐字输名才放行（disabled 直到输入完全匹配，后端 :338 同硬校验）；
// ④ 切回收站时列表请求真的带 recycled=true（不带就是点了没反应的假 toggle）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfigProvider, Modal } from "antd";
import { MemoryRouter } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import UiCasesPage from "./uiCases";
import { useAuth } from "../auth/store";
import type { UiCaseListRow } from "../api/ui";

type Row = UiCaseListRow;

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
// MEMBER 的 -*:delete（auth/perms.ts 内置表同值）：恢复走 ui:case:update 该在，
// 删除/彻底删除走 ui:case:delete 该没——这一档钉的是「恢复不是删除」的位分工。
const MEMBER_PROJECT = { ...PROJECT, my_role: "MEMBER",
  my_perms: ["*", "-*:delete", "-*:manage", "-system:*"] };
const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

function uiCase(id: string, over: Partial<Row> = {}): Row {
  return { id, project_id: "p1", module_id: null, name: "登录冒烟" + id, priority: "P1",
    enabled: true, owner_id: null, project_public: true, status: "normal", step_count: 0,
    last_run_at: null, last_run_status: null, updated_by: null,
    created_at: null, updated_at: null, issues: [], ...over };
}

// 记录所有 POST（url + body），钉「彻底删除真的带 confirm_name」这类请求侧事实
let posts: { url: string; body: Record<string, unknown> }[] = [];
// D47-b 步5a：记录本轮桩见过的所有列表 GET URL——D127 绊线「挂载稳定后恰好一条请求」
// 与「点一次页码恰好一条」都数它。
let listUrls: string[] = [];

/** 从列表 URL 取 query（同 runs.test.tsx :138 的取法）。 */
function qsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

/** 每次调用现拷一份响应体（D127 桩纪律，runs.test.tsx :80-86 同款理由）：真 fetch 每次
 *  解析出一棵全新对象图，桩把同一对象反复交出，「响应→新 rows→load 换身份→effect 重跑」
 *  的无限回路就会藏进桩里（步3b 实测：线上必现、测试全绿）。桩不许比真接口更好说话。 */
const deepResp = (json: unknown, status = 200) =>
  ({ ok: status < 400, status,
    json: async () => JSON.parse(JSON.stringify(json)) as unknown }) as unknown as Response;

function mockBackend(pages: { normal: Row[]; recycled: Row[]; total?: number | null }) {
  posts = [];
  listUrls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const resp = (json: unknown) => deepResp(json);
    if (method === "POST" && url.includes("/ui-cases/")) {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return resp({ ok: true });
    }
    if (url.includes("/projects/") && url.includes("/members")) {
      return resp({ items: [{ user_id: "u9", account: "lisi", name: "李四" }], next_cursor: null });
    }
    if (url.includes("/ui-cases?") && method === "GET") {
      listUrls.push(url);
      // 桩按真实 query 参数切片（current/size/recycled）：永远交出同一批行，
      // 「点第 2 页行没换」「翻页不生效」这类 bug 就测不出（桩纪律，runs.test.tsx 同款）。
      const q = qsOf(url);
      const pool = q.get("recycled") === "true" ? pages.recycled : pages.normal;
      const cur = Number(q.get("current") ?? "1");
      const size = Number(q.get("size") ?? "20");
      const items = pool.slice((cur - 1) * size, (cur - 1) * size + size);
      return resp(pages.total === undefined
        ? { items, next_cursor: null }
        : { items, next_cursor: null, total: pages.total });
    }
    // D213：高级搜索元数据 + 个人视图（工具条首载两请求）。
    if (url.includes("/filter-meta") && method === "GET") {
      return resp({
        view_type: "ui_case", fields: [
          { field: "name", label: "用例名称", kind: "text",
            ops: ["CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"] },
          { field: "priority", label: "优先级", kind: "enum",
            ops: ["IN", "NOT_IN", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"] },
          { field: "last_run_status", label: "最近执行结果", kind: "enum",
            ops: ["IN", "NOT_IN", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"] },
        ],
        supported_view_types: ["ui_case"], unavailable: {},
      });
    }
    if (url.includes("/saved-views") && method === "GET") return resp([]);
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cleanup();
  // Modal.confirm 的静态弹窗挂在 document.body 的独立 root 上，cleanup 管不到它：
  // 上一用例没关掉的确认框会带着 ui-case-del-ok 混进下一用例（实测 Found multiple）。
  // destroyAll 只启动离场动画，jsdom 里 rc-motion 永远不完成 → 节点必须同步摘掉。
  Modal.destroyAll();
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("uiCases 角色门控（隐藏不是禁用；位名照 case_services.py）", () => {
  it("PROJECT_ADMIN：新建、行删除都在；回收站视图里 [恢复]（update 位）[彻底删除]（delete 位）都在", async () => {
    mockBackend({ normal: [uiCase("c1")], recycled: [uiCase("c9", { status: "recycled" })] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    // 「新建」按钮只认同步的权限态（uiCases.tsx:43），首帧就在；[删除] 是逐行画的
    // （:248），得等列表回包。所以门钉在行上而不是钉在壳上（下面两条兄弟用例就这么写），
    // 但「新建在场」这条正向断言不能因为换了门就丢——负向腿只有 READONLY 那条。
    expect(screen.getByTestId("ui-case-new")).not.toBeNull();
    await screen.findByTestId("ui-case-row-name");
    // D47-b 步5a：D127 绊线放在**全文件最早挂载列表**的这条用例上（runs/reports 同法，
    // 实测理由见计划 §六）：「取数落地把自己写的 rows 塞回 load 依赖」这种无限回路，
    // 若绊线只在后面的页码块里，前面每条用例都带着不停发请求的后台回路跑完——整文件
    // 从秒级拖到分钟级、最后仍由页码块报红，红得又慢又难归因。放最前 = 回路第一条就红，
    // 且只红一条。顺带钉①：挂载首发恰好 current=1&size=20、任何一条不带 cursor。
    await new Promise((r) => setTimeout(r, 300));
    expect(listUrls).toHaveLength(1);
    const q0 = qsOf(listUrls[0]);
    expect(q0.get("current")).toBe("1");
    expect(q0.get("size")).toBe("20");
    expect(q0.has("cursor")).toBe(false);
    expect(listUrls.some((u) => qsOf(u).has("cursor"))).toBe(false);
    expect(screen.getByTestId("ui-case-del")).not.toBeNull();
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await screen.findByTestId("ui-case-restore");
    expect(screen.getByTestId("ui-case-purge")).not.toBeNull();
  });

  it("MEMBER（-*:delete）：[删除]/[彻底删除] 都不在 DOM，[恢复] 在——恢复走 update 位不是 delete 位", async () => {
    useAuth.setState({ project: MEMBER_PROJECT });
    mockBackend({ normal: [uiCase("c1")], recycled: [uiCase("c9", { status: "recycled" })] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    expect(screen.queryByTestId("ui-case-del")).toBeNull();
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await screen.findByTestId("ui-case-restore");
    expect(screen.queryByTestId("ui-case-purge")).toBeNull();
  });

  it("READONLY：删除/恢复/彻底删除全部不在 DOM；行照渲染（读面不动），新建也不在", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend({ normal: [uiCase("c1")], recycled: [uiCase("c9", { status: "recycled" })] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    expect(screen.queryByTestId("ui-case-new")).toBeNull();
    expect(screen.queryByTestId("ui-case-del")).toBeNull();
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await waitFor(() => expect(screen.getByTestId("ui-case-row-name").textContent).toContain("c9"));
    expect(screen.queryByTestId("ui-case-restore")).toBeNull();
    expect(screen.queryByTestId("ui-case-purge")).toBeNull();
  });
});

// §11.4.18 回收站两列：同一份 updated_by/updated_at 在正常行上是「最后编辑人/时间」
// （ui_case_update 也写它们），只有回收站里最后那次写才恰好是回收本身——两列**必须**
// 被 inRecycled 守卫圈住，正常视图里出现这两列就是说谎（拆守卫后第二条用例变红）。
describe("回收站两列（§11.4.18）", () => {
  const recycledRow = uiCase("c9", {
    status: "recycled", updated_by: "u9", updated_by_name: "王小明",
    updated_at: "2026-11-01T02:34:56+00:00",
  });

  it("回收站视图：删除人显示人名，删除时间走 Asia/Shanghai 换算；列表请求带 recycled=true", async () => {
    mockBackend({ normal: [uiCase("c1")], recycled: [recycledRow] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    // waitFor 不是摆设：切换瞬间的首帧还是**切换前**那批行（没有名字）——断言必须等
    // 回收站那次请求把行换掉（uiElements.test.tsx 实测过 '—' 抢跑的教训）。
    await waitFor(() =>
      expect(screen.getByTestId("ui-case-recycled-by").textContent).toContain("王小明"));
    // 02:34:56 UTC + 8h = 10:34 上海——若谁退回 slice 会露出 UTC 钟点 02:34（R68 的坑）
    await waitFor(() =>
      expect(screen.getByTestId("ui-case-recycled-at").textContent).toContain("2026-11-01 10:34"));
    // 假 toggle 钉这条：切过去必须真带 recycled=true（后端 UiCaseListIn.recycled 收这个参数）
    const listCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]));
    expect(listCalls.some((u) => u.includes("/ui-cases?") && u.includes("recycled=true"))).toBe(true);
  });

  it("正常列表不许出现这两列（同字段在正常行上是最后编辑人，标成删除人即说谎）", async () => {
    // 正常视图的行照带 updated_by_name/updated_at——钉的是列渲染守卫，不是数据缺席
    mockBackend({ normal: [uiCase("c1", {
      updated_by: "u9", updated_by_name: "王小明", updated_at: "2026-11-01T02:34:56+00:00",
    })], recycled: [] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    expect(screen.queryByTestId("ui-case-recycled-by")).toBeNull();
    expect(screen.queryByTestId("ui-case-recycled-at")).toBeNull();
    expect(screen.queryByText("删除人")).toBeNull();
    expect(screen.queryByText("删除时间")).toBeNull();
  });
});

describe("回收站行操作（软删确认 / 输名彻底删除）", () => {
  it("正常视图删除入口：确认弹窗 → POST /ui-cases/{id}/delete 带 project_id", async () => {
    mockBackend({ normal: [uiCase("c1", { name: "旧登录" })], recycled: [] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-del");
    fireEvent.click(screen.getByTestId("ui-case-del"));
    const ok = await screen.findByTestId("ui-case-del-ok");
    fireEvent.click(ok);
    await waitFor(() => expect(posts.some((p) =>
      p.url.includes("/ui-cases/c1/delete") && p.body.project_id === "p1")).toBe(true));
  });

  it("恢复：POST /ui-cases/{id}/restore 带 project_id", async () => {
    mockBackend({ normal: [], recycled: [uiCase("c9", { status: "recycled" })] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-recycled");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    fireEvent.click(await screen.findByTestId("ui-case-restore"));
    await waitFor(() => expect(posts.some((p) =>
      p.url.includes("/ui-cases/c9/restore") && p.body.project_id === "p1")).toBe(true));
  });

  it("彻底删除：名字没输对之前「我已确认」必须 disabled；逐字输对才放行且带 confirm_name", async () => {
    mockBackend({ normal: [], recycled: [uiCase("c9", { name: "旧用例", status: "recycled" })] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-recycled");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    fireEvent.click(await screen.findByTestId("ui-case-purge"));
    await screen.findByTestId("ui-case-purge-confirm");
    const ok = screen.getByTestId("ui-case-purge-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    // 前缀不算数：部分匹配照样 disabled（后端 confirm_name != c.name 是逐字相等）
    fireEvent.change(screen.getByTestId("ui-case-purge-confirm"), { target: { value: "旧用" } });
    expect((screen.getByTestId("ui-case-purge-ok") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("ui-case-purge-confirm"), { target: { value: "旧用例" } });
    await waitFor(() =>
      expect((screen.getByTestId("ui-case-purge-ok") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("ui-case-purge-ok"));
    await waitFor(() => expect(posts.some((p) =>
      p.url.includes("/ui-cases/c9/purge")
      && p.body.project_id === "p1" && p.body.confirm_name === "旧用例")).toBe(true));
  });
});

// —— 回收 409「被场景引用」（后端 ui_case_delete 接上引用保护的前端半环）——
// 拦截 DOM 复用 CaseList.tsx 的 ScenarioRefsBlockModal（D86 同一份 DOM/文案），
// 这里钉的是 uiCases.tsx 接线：409 → 弹窗点名场景名；[仍要回收] → 第二个请求 force:true。
// 断言里的中文全部抄自 CaseList.tsx:62/69/73/83/89 与 uiCases.tsx 的 blurb，非发明文案。
const SCENARIOS = [
  { scenario_id: "s1", scenario_name: "下单主链路", step_keys: ["k1", "k2"] },
  { scenario_id: "s2", scenario_name: "回归集", step_keys: ["k9"] },
];

type DelBehavior = "blocked" | "blocked_then_ok";

function mockDeleteBehavior(rows: Row[], behavior: DelBehavior, fullCount = 2) {
  posts = [];
  listUrls = [];
  let deleteTried = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const resp = (json: unknown, status = 200) => deepResp(json, status);
    if (method === "POST" && url.includes("/ui-cases/c1/delete")) {
      deleteTried += 1;
      if (behavior === "blocked_then_ok" && deleteTried > 1) return resp({ ok: true });
      return resp({
        code: "referenced_by_scenario", message: "该用例被引用，不能回收",
        // 用例侧 details 顶层键是 case_id（ui_test/case_services.py _blocked）
        details: { case_id: "c1", count: fullCount, scenarios: SCENARIOS },
      }, 409);
    }
    if (method === "POST" && url.includes("/ui-cases/")) {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return resp({ ok: true });
    }
    if (url.includes("/projects/") && url.includes("/members")) {
      return resp({ items: [{ user_id: "u9", account: "lisi", name: "李四" }], next_cursor: null });
    }
    if (url.includes("/ui-cases?") && method === "GET") {
      listUrls.push(url);
      return resp({ items: url.includes("recycled=true") ? [] : rows, next_cursor: null });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

function deleteBodies(): Record<string, unknown>[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes("/ui-cases/c1/delete"))
    .map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
}

async function openBlockModal() {
  await screen.findByTestId("ui-case-del");
  fireEvent.click(screen.getByTestId("ui-case-del"));
  fireEvent.click(await screen.findByTestId("ui-case-del-ok"));
}

describe("uiCases 回收 409「被场景引用」拦截弹窗", () => {
  // motion:false 同 CaseList.test.tsx:77-84：rc-motion 的 leave 动画在 jsdom 里不完成，
  // destroyOnHidden 关掉后的节点会永远留在 DOM，「弹窗关掉」这条断言就测不了。
  function renderPage(rows: Row[], behavior: DelBehavior, fullCount = 2) {
    mockDeleteBehavior(rows, behavior, fullCount);
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><UiCasesPage /></MemoryRouter>
      </ConfigProvider>,
    );
  }

  it("409 明细可见：弹窗点名每个引用场景与命中步骤（场景名必须出现）", async () => {
    renderPage([uiCase("c1", { name: "被引用的用例" })], "blocked");
    await openBlockModal();
    const box = await screen.findByTestId("ui-case-scenario-block");
    // 抄 CaseList.tsx:81 的渲染形状「{场景名}」与 uiCases 传入的 subject
    expect(box.textContent).toContain("下单主链路");
    expect(box.textContent).toContain("k1、k2"); // CaseList.tsx:83 步骤 join("、")
    expect(box.textContent).toContain("回归集");
    // 抄 CaseList.tsx:69「被 N 个未回收场景引用」
    expect(box.textContent).toContain("未回收场景引用");
    // blurb 抄 uiCases.tsx 的 ScenarioRefsBlockModal blurb 参数
    expect(box.textContent).toContain("回收不会删除用例");
    expect(box.querySelector("a")?.getAttribute("href")).toBe("#/scene/s1"); // CaseList.tsx:81
  });

  it("count 大于列出条数 → 说明「等 N 个场景」（抄 CaseList.tsx:89）", async () => {
    renderPage([uiCase("c1")], "blocked", 7);
    await openBlockModal();
    expect((await screen.findByTestId("ui-case-scenario-block")).textContent).toContain("等 7 个场景");
  });

  it("点「仍要回收」→ 第二个请求 body force===true；成功后弹窗关闭", async () => {
    renderPage([uiCase("c1")], "blocked_then_ok");
    await openBlockModal();
    await screen.findByTestId("ui-case-scenario-block");
    // okText 抄 CaseList.tsx:63「仍要回收（会断掉这些步骤）」（antd 两字按钮自动空格，正则容忍）
    fireEvent.click(await screen.findByTestId("ui-case-scenario-block-force"));
    await waitFor(() => expect(deleteBodies().length).toBe(2));
    expect("force" in deleteBodies()[0]).toBe(false); // 第一段不带 force
    expect(deleteBodies()[1].force).toBe(true); // force 语义：重投带 force:true
    expect(deleteBodies()[1].project_id).toBe("p1");
    await waitFor(() => expect(screen.queryByTestId("ui-case-scenario-block")).toBeNull());
  });
});

// 第二十六轮：回收确认的后半句原先写「会拒绝并点名是哪些场景」——可后端对没有
// scenario:read 的调用方（D37 自定义角色可带 ui:case:delete 不带 scenario:read）刻意只报
// 数量不报名（ui_test/case_services.py:263 的 hidden 分支，details_hidden）。
// 两个分支都兑现的只有「拒绝 + 给出引用情况」，所以文案必须带上明细的权限前提。
describe("回收确认文案不许承诺两个后端分支都给不出的「点名」", () => {
  it("软删确认 content：逐字含限定句「（引用明细要 scenario:read 才看得到）」，逐字不含「点名是哪些场景」", async () => {
    mockBackend({ normal: [uiCase("c1", { name: "旧登录" })], recycled: [] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-del");
    fireEvent.click(screen.getByTestId("ui-case-del"));
    // 确认框走 Modal.confirm 的独立 body root——从 ok 钮回溯到确认壳，只圈这段文案，
    // 不把别的弹窗（拦截弹窗正文也写「未回收场景引用」）卷进断言。
    const ok = await screen.findByTestId("ui-case-del-ok");
    const box = ok.closest(".ant-modal-confirm") as HTMLElement;
    // 杀什么：把 content 改回「…会拒绝并点名是哪些场景。」→ 前两红各钉一边
    // （旧句回来 not.toContain 红；限定句消失 toContain 红）。
    expect(box.textContent).not.toContain("点名是哪些场景");
    expect(box.textContent).toContain(
      "其若被未回收场景引用会拒绝回收，并给出引用情况（引用明细要 scenario:read 才看得到）。");
    // 前两句逐字不动（软删可恢复 + 彻底删除输名是 adbCases 同族手感）——逐字钉防连带改写
    expect(box.textContent).toContain("软删，可随时恢复；彻底删除需逐字确认名称。");
  });
});

// 第八道差集第二十三轮：本页原来取数失败只留一句「还没有 UI 用例」——而 listCases 是
// silent:true（api/ui.ts:95），连 toast 都没有，故障被演成实测零条。原 catch 的注释写着
// 「toast 已在 client 里弹」，那句注释本身就是假话。这条纪律（失败≠实测零）原样保留。
// D47-b 步5a 改的是脚注的计数腿：本页已接页码分页，「刷新失败保留旧行 + 上次取到 N 条」
// 与「游标非空 → 后面还有没取的」两条腿**有意退役**——页码模式下失败清行（陈旧行 + 新
// current 同屏是「我在第几页」的两把尺子，与后端禁 cursor+current 同罪，api.tsx 步4b 同款
// 理由），「共 N 条」改由服务端 total 经 ListPager 说出，rows.length/next_cursor 不再参与计数。
describe("取数失败摊开说 + 「共 N 条」只有服务端 total 这一张嘴", () => {
  /** 可翻故障的列表桩（runs.test.tsx 的 BackendOpts 句柄同款）：挂载后翻 fail 模拟
   *  「上一秒还好、这一秒取不到」。total===undefined 时响应不带 total 键（游标式真实形状）。 */
  interface ListBackend { fail?: boolean; total?: number | null; cursor?: string | null }
  function mockList(b: ListBackend = { total: 2 }): ListBackend {
    listUrls = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/members")) return deepResp({ items: [], next_cursor: null });
      if (b.fail) {
        return deepResp({ code: "db_error", message: "用例库挂了", details: null }, 500);
      }
      listUrls.push(url);
      const q = qsOf(url);
      const cur = Number(q.get("current") ?? "1");
      const size = Number(q.get("size") ?? "20");
      const pool = [uiCase("c1"), uiCase("c2")];
      const items = pool.slice((cur - 1) * size, (cur - 1) * size + size);
      const body: Record<string, unknown> = { items, next_cursor: b.cursor ?? null };
      if (b.total !== undefined) body.total = b.total;
      return deepResp(body);
    }) as unknown as typeof fetch;
    return b;
  }

  it("首屏 500：Alert 带后端原文，空态改口，脚注不报数，页脚不挂假分页器", async () => {
    mockList({ fail: true });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    const alert = await screen.findByTestId("ui-case-load-error");
    expect(document.body.textContent).toContain("用例库挂了");
    expect(document.body.textContent).toContain("用例列表没取到");
    expect(document.body.textContent).not.toContain("还没有 UI 用例");
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    // 失败清 total（初值即 null）→ ListPager 整块不渲染，「共 0 条」的假象没有出口
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 0 条");
    // 不给 ×：脚注（:288）与空态读同一个 loadError，加个 × 就是「把故障擦成还没有用例」的按钮
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
  });

  it("刷新失败清行清 total（旧「上次取到 N 条」腿随游标世界退役）：无行、页脚消失、脚注只说不作数", async () => {
    // 旧用例钉的是「刷新失败但行还在 → 脚注改口上次取到」——页码模式把这换成清行清 total：
    // 行留着 + current 指着新页，就是拿上一批行冒充当前页（api.tsx 步4b catch 的同款理由）。
    // 改断言不删用例：留行旧口径退役了，「失败不留谎脚注」这条纪律换了形状继续钉。
    const b = mockList(); // total=2、2 行落地
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(2));
    expect(document.body.textContent).toContain("共 2 条"); // ListPager 报的是服务端 total=2
    b.fail = true;
    fireEvent.click(screen.getByTestId("ui-case-recycled")); // 无刷新钮，切视图同样重跑 load()
    await screen.findByTestId("ui-case-load-error");
    expect(screen.queryAllByTestId("ui-case-row-name")).toHaveLength(0);
    expect(screen.queryByTestId("list-pager")).toBeNull(); // 陈旧的「共 2 条」不许挂在空表上
    expect(document.body.textContent).not.toContain("共 2 条");
    expect(document.body.textContent).not.toContain("上次取到");
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
  });

  it("total=45 而行数 2：「共 45 条」只跟服务端 total；游标非空不再改口（旧 hasMore 腿退役）", async () => {
    // 旧用例「游标非空 → 后面还有没取的」退役：页码模式下下一页永远点得到，
    // 「还有没取的」不再是脚注能说的事，next_cursor 对界面零影响（这条拿 cursor:"c2" 钉死）。
    // 「共」的口径换了来源也照样钉：数字与屏上行数对不上正是「total 不许由行数现攒」的证明。
    mockList({ total: 45, cursor: "c2" });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(2));
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    expect(document.body.textContent).not.toContain("共 2 条"); // 行数不是总数
    expect(document.body.textContent).not.toContain("后面还有没取的"); // 游标不再驱动文案
  });

  it("响应没有 total 键（后端游标式形状）→ 页脚整块不渲染，不报「共 0 条」（⑥）", async () => {
    // 旧「游标为空才写共 2 条」的改写：脚注不再拿 rows.length 现攒「共」，
    // 总数只有服务端 total 这一张嘴——它缺席时 ListPager 宁可不渲染也不说「共 0 条」。
    mockList({ total: undefined });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(2));
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 0 条");
    expect(document.body.textContent).not.toContain("共 2 条");
  });
});

// ── D47-b 步5a：点页码 / 切回收站的请求形状 ────────────────────────────────
describe("页码分页：点页码与切回收站的请求形状（D47-b 步5a）", () => {
  /** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
  function pager(): HTMLElement {
    return screen.getByTestId("list-pager");
  }
  function clickPage(n: number): void {
    fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
  }
  const many = (n: number) => Array.from({ length: n }, (_, i) => uiCase("c" + (i + 1)));
  /** 表内行 id = 当前表格真实渲染的行（替换/追加语义只能从 DOM 看出来）。 */
  const rowKeys = () => Array.from(document.querySelectorAll("tbody tr[data-row-key]"))
    .map((tr) => tr.getAttribute("data-row-key"));
  /** 等第 before+1 条列表请求落地，返回它的 query（runs.test.tsx lastQuery 同款）。 */
  async function lastQuery(before: number): Promise<URLSearchParams> {
    await waitFor(() => expect(listUrls.length).toBe(before + 1));
    return qsOf(listUrls[listUrls.length - 1]);
  }

  it("② 点第 2 页 → 恰好一条 current=2（D127 换皮：多一条都红），行是替换不是追加", async () => {
    // 取数落地若把 load 的依赖改脏（items 进依赖），setRows → load 换身份 → effect 重跑 →
    // 多一条重置请求把第 2 页掀回第 1 页。数请求条数：点一次页码 = before+1，多一条都红。
    mockBackend({ normal: many(45), recycled: [], total: 45 });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(20));
    await new Promise((r) => setTimeout(r, 300));
    expect(listUrls).toHaveLength(1); // 挂载恰好一条（绊线的页码版复读，兜 ② 自身的前提）
    clickPage(2);
    const q = await lastQuery(1);
    expect(q.get("current")).toBe("2");
    expect(q.has("cursor")).toBe(false); // 后端 current+cursor 同传必 400
    // 替换语义：第 1 页 20 行必须下桌，屏上只剩第 21~40 行（append 变异会在这里数出 40 行）
    await waitFor(() => expect(rowKeys()).toEqual(
      Array.from({ length: 20 }, (_, i) => "c" + (i + 21))));
    expect(pager().querySelector(".ant-pagination-item-2.ant-pagination-item-active")).toBeTruthy();
    // 迟到的重置请求也要抓到：替换落地后请求总数仍恰好 2
    expect(listUrls).toHaveLength(2);
  });

  it("③ 停在第 3 页点回收站 → recycled=true 与 current=1 一起上线（唯一写入口的回页）", async () => {
    // 变异靶：toggleRecycled 里摘掉 setCurrent(1) → current 停在 3，回收集只有 1 行，
    // 第 3 页切片是空的——「切回收站把数据切没了」。正向对照（回收行真落地）同条钉住。
    mockBackend({ normal: many(65), recycled: [uiCase("c9", { status: "recycled" })], total: 65 });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(20));
    clickPage(3);
    const landed = await lastQuery(1);
    expect(landed.get("current")).toBe("3"); // 正对照：确实停在第 3 页，回页才有东西可回
    const before = listUrls.length;
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    const q = await lastQuery(before);
    expect(q.get("recycled")).toBe("true");
    expect(q.get("current")).toBe("1");
    await waitFor(() => expect(screen.getByTestId("ui-case-restore")).not.toBeNull());
    expect(rowKeys()).toEqual(["c9"]); // 回收集按 current=1 切出来就是这一行
  });
});

// ── 第五道差集（前端 fixture ↔ 后端 UiCaseOut）：负责人列的「有值」分支 ──────────────
// 背景：本文件 fixture（:40）owner_id 恒 null，uiCases.tsx:225-226 那列只画过「—」；
// 而 ui_test/schemas.py:292 `class UiCaseOut` 的 owner_id（:301）后端真填。shared/ownerName.test.ts 钉的是
// 纯函数，不构成页级证据（页面从没把真数据喂进 ownerLabel）。文案逐字抄 ownerName.ts:32/34，
// 口径对齐 adbCases.test.tsx:74/87。行锁定走 tr[data-row-key]（rowKey="id"，uiCases.tsx:179），
// 防「名字恰好出现在别处」的假绿。各自的 fetch 桩在 it 内自带，不动共用 fixture。
describe("负责人列有值分支（uiCases 页首次把真 owner_id 喂进 ownerLabel）", () => {
  const OUTSIDER = "3f2a9c81-77bd-4e6a-9d10-000000000000"; // slice(0,8)="3f2a9c81"

  /** 成员表给 u1「张三」，两行用例：u1（查得到）与局外人 uuid（查不到）。 */
  function mockOwnerView(): void {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/projects/") && url.includes("/members")) {
        return deepResp({ items: [{ user_id: "u1", account: "zhangsan", name: "张三" }], next_cursor: null });
      }
      if (url.includes("/ui-cases?")) {
        return deepResp({ items: [
          uiCase("c1", { owner_id: "u1" }),
          uiCase("c2", { owner_id: OUTSIDER }),
        ], next_cursor: null });
      }
      throw new Error("未 mock 的请求: " + url);
    }) as unknown as typeof fetch;
  }

  function rowTr(id: string): HTMLElement {
    const tr = document.querySelector<HTMLElement>('tr[data-row-key="' + id + '"]');
    expect(tr).not.toBeNull();
    return tr as HTMLElement;
  }

  it("负责人列：成员表命中 owner_id=u1 → 那一列画「张三」，不是 id", async () => {
    mockOwnerView();
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    // 两行挂同名 testid：findByTestId 会 multiple 抛，按行数等（本文件 :366 同款）
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(2));
    // members 异步就绪（loading 帧画「…」），等 ready 帧
    await waitFor(() => expect(within(rowTr("c1")).queryByText("张三")).not.toBeNull());
    expect(rowTr("c1").textContent).not.toContain("…"); // 就绪后不许停在加载点
  });

  it("负责人列：owner_id 是成员表查不到的 uuid → 画「非项目成员 3f2a9c81」（短 id），不摊整串 uuid", async () => {
    mockOwnerView();
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(2));
    await waitFor(() =>
      expect(within(rowTr("c2")).queryByText("非项目成员 3f2a9c81")).not.toBeNull());
    expect(rowTr("c2").textContent).not.toContain(OUTSIDER); // uuid 摊出去就是 ownerName.ts 头注释量出的原缺陷
  });
});

// ── D180：切回收站的竞态窗口 ────────────────────────────────────────────────
// 点击同步翻 inRecycled，行却要等下一次 listCases 回包才换；那一格里**正常行会挂上
// 回收站模板**：「删除人」列把最后编辑人说成删除人，活行还长出恢复/彻底删除。回 500 时
// 行会被清掉（页码模式新口径，见 ② 的注释），但 shownRecycled 仍不翻——模板既不提前翻、
// 也不跟着失败翻。普通跑法量不到（请求立刻回包），所以把回收站那次请求挂成
// 手工 deferred：在途时断言、回包/回 500 后逐条观察。修法两半：
// 半 1 shownRecycled（模板跟数据走，失败不翻）由 ①②③ 钉；
// 半 2 行级 r.status 由 ④ 混合正对照钉——两半任一退回 inRecycled，本组都有用例红。
describe("D180 切回收站的竞态窗口（模板滞后于数据，不是滞后于点击）", () => {
  function okResp(json: unknown, status = 200): Response {
    return { ok: status < 400, status, json: async () => json } as unknown as Response;
  }
  function deferredResp() {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((r) => { resolve = r; });
    return { promise, resolve };
  }
  /** 正常列表立即回包（行照带 updated_by_name——钉的是渲染不是数据缺席），
   *  回收站那次 GET 挂在手工 deferred 上，由用例自己放行。
   *  liveRows 可换：⑤ 要的是「初始列表本来就空」那一格——表里有行时 antd 不渲染
   *  Empty，空态那条腿（uiCases.tsx:189）在本文件里一次都没进过分支（leg1 变异杀不死）。 */
  function mockRacyList(liveRows: Row[] | null = null) {
    listUrls = [];
    const dfd = deferredResp();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/members")) return deepResp({ items: [], next_cursor: null });
      if (url.includes("/ui-cases?")) {
        if (url.includes("recycled=true")) return dfd.promise;
        return deepResp({ items: liveRows ?? [uiCase("c1", {
          updated_by: "u9", updated_by_name: "最后编辑的老李",
          updated_at: "2026-11-01T02:34:56+00:00",
        })], next_cursor: null });
      }
      throw new Error("未 mock 的请求: " + url);
    }) as unknown as typeof fetch;
    return dfd;
  }
  function recycledCalls(): number {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("/ui-cases?") && String(c[0]).includes("recycled=true")).length;
  }
  function raceRowTr(id: string): HTMLElement {
    const tr = document.querySelector<HTMLElement>('tr[data-row-key="' + id + '"]');
    expect(tr).not.toBeNull();
    return tr as HTMLElement;
  }

  it("① 点回收站 + 列表在途：正常行不提前挂回收站模板——无删除人列、无恢复/彻底删除、不出现 updated_by_name", async () => {
    const dfd = mockRacyList();
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    // 竞态窗口 = 回收站请求已发出、还没回包；waitFor 只是把「已在途」变成显式前提
    await waitFor(() => expect(recycledCalls()).toBe(1));
    expect(screen.queryByTestId("ui-case-recycled-by")).toBeNull();
    expect(screen.queryByTestId("ui-case-recycled-at")).toBeNull();
    expect(screen.queryByTestId("ui-case-restore")).toBeNull();
    expect(screen.queryByTestId("ui-case-purge")).toBeNull();
    expect(screen.queryByText("删除人")).toBeNull();
    // 「最后编辑的老李」在正常视图的任何一列都不该出现；它一露面就是删除人列抢跑
    expect(document.body.textContent).not.toContain("最后编辑的老李");
    expect(document.body.textContent).not.toContain("回收站视图");
    // inRecycled 的本职不变：钮照实说「请求要什么」，不跟着模板滞后
    expect(screen.getByTestId("ui-case-recycled").textContent).toContain("退出回收站");
    // 放行收尾（空回收站）：行换掉、模板这时才许翻
    dfd.resolve(okResp({ items: [], next_cursor: null }));
    await waitFor(() => expect(screen.queryByTestId("ui-case-row-name")).toBeNull());
    expect(document.body.textContent).toContain("回收站是空的");
    expect(document.body.textContent).toContain("回收站视图");
  });

  it("② 点回收站 + 列表回 500（页码模式：清行）：模板不提前翻，加载失败提示照常", async () => {
    // D180 的不变量原样保住：shownRecycled 失败不翻——旧口径里它靠「留行 + 行还是正常模板」
    // 体现；页码模式失败清行后，它变成「屏上既没有行、也没有回收站列、也没有回收站视图字样」。
    // 「正常行保持正常模板」这条断言随留行口径一起退役（有意分歧，理由在 uiCases.tsx catch），
    // 换成「无行 + 模板不提前翻 + 加载失败提示照常」——改断言，不删用例。
    const dfd = mockRacyList();
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(okResp({ code: "db_error", message: "用例库挂了", details: null }, 500));
    await screen.findByTestId("ui-case-load-error");
    expect(document.body.textContent).toContain("用例列表加载失败");
    expect(document.body.textContent).toContain("用例库挂了");
    // 清行（页码模式新口径）：行不许留在屏上冒充回收站当前页
    expect(screen.queryAllByTestId("ui-case-row-name")).toHaveLength(0);
    expect(screen.queryByTestId("ui-case-recycled-by")).toBeNull();
    expect(screen.queryByTestId("ui-case-recycled-at")).toBeNull();
    expect(screen.queryByTestId("ui-case-restore")).toBeNull();
    expect(screen.queryByTestId("ui-case-purge")).toBeNull();
    expect(document.body.textContent).not.toContain("最后编辑的老李");
    expect(document.body.textContent).not.toContain("回收站视图");
    expect(document.body.textContent).not.toContain("回收站是空的"); // 失败不演空回收站
  });

  it("③ 请求成功落回回收站视图：两列与两钮照常出现（正向对照，防「永远不显示删除人」也全绿）", async () => {
    const dfd = mockRacyList();
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(okResp({ items: [uiCase("c9", {
      status: "recycled", updated_by: "u9", updated_by_name: "王小回收",
      updated_at: "2026-11-01T02:34:56+00:00",
    })], next_cursor: null }));
    await waitFor(() =>
      expect(screen.getByTestId("ui-case-recycled-by").textContent).toContain("王小回收"));
    // 02:34 UTC +8h = 10:34 上海（timefmt 换算顺带再过一遍）
    expect(screen.getByTestId("ui-case-recycled-at").textContent).toContain("2026-11-01 10:34");
    expect(screen.getByTestId("ui-case-restore")).not.toBeNull();
    expect(screen.getByTestId("ui-case-purge")).not.toBeNull();
    expect(document.body.textContent).toContain("回收站视图");
  });

  it("④ 混合数据正对照：回收站批次里混进 status:normal 的行 → 该行无删除人单元格、无恢复/彻底删除，只有正常视图的删除", async () => {
    // 后端正常不给混合数据（case_services.py:159 按 status 过滤），这条是给半 2 的
    // 「逐行身份」买的双保险：陈旧/混合数据也永远不会有彻底删除钮落到活行上。
    mockBackend({ normal: [uiCase("c1")], recycled: [
      uiCase("c9", { status: "recycled", updated_by: "u9", updated_by_name: "王小回收" }),
      uiCase("c8", { updated_by: "u9", updated_by_name: "最后编辑的老李" }),
    ] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(2));
    // 回收行照常：两列 + 两钮（PA 全权限）
    expect(within(raceRowTr("c9")).getByTestId("ui-case-recycled-by").textContent).toContain("王小回收");
    expect(within(raceRowTr("c9")).getByTestId("ui-case-restore")).not.toBeNull();
    expect(within(raceRowTr("c9")).getByTestId("ui-case-purge")).not.toBeNull();
    // 混进来的正常行：删除人单元格不给画（落「—」）、回收站两钮不给，正常视图的删除照给
    expect(within(raceRowTr("c8")).queryByTestId("ui-case-recycled-by")).toBeNull();
    expect(within(raceRowTr("c8")).queryByTestId("ui-case-restore")).toBeNull();
    expect(within(raceRowTr("c8")).queryByTestId("ui-case-purge")).toBeNull();
    expect(within(raceRowTr("c8")).getByTestId("ui-case-del")).not.toBeNull();
    expect(document.body.textContent).not.toContain("最后编辑的老李");
  });

  it("⑤ 空态那条腿：项目里本来就没用例 + 回收站请求在途 → 空态说「还没有 UI 用例」，不说「回收站是空的」", async () => {
    // 补的腿：leg1 变异（空态描述从 shownRecycled 退回 inRecycled，uiCases.tsx:189）在本
    // 文件里曾经杀不死——①②③④ 的初始列表恒带一行活用例，antd 有行就不渲染 Empty，
    // 那条腿一次都没进过分支。要量到它必须让**初始**列表就是空的。
    // 这一格是真的：空项目点回收站、回包未到，屏上没有任何回收行，
    // 「回收站是空的」是把「还没取到」说成「取到了、是空」（同族规则③）。
    // 只查表格自己那份空态（.ant-table-placeholder 圈住）：整页文本会被别的 Empty 满足，
    // 断言就门不住任何东西（scenes/api 同轮探针实测过的假把手）。
    const dfd = mockRacyList([]);
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector(".ant-table-placeholder")).not.toBeNull());
    const emptyDesc = () => document
      // 2026-11-22 空态改由 StateView 画（统一线稿插画 + 文案层级），不再是 antd Empty——
      // 占位单元格里没有 .ant-empty-description。契约不变：钉的仍是「占位区说了哪句话」，
      // 所以改读整个 .ant-table-placeholder 的文本，文案断言一个字不动。
      .querySelector(".ant-table-placeholder")?.textContent ?? "";
    expect(emptyDesc()).toContain("还没有 UI 用例");
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await waitFor(() => expect(recycledCalls()).toBe(1)); // 已在途
    expect(emptyDesc()).not.toContain("回收站是空的");
    dfd.resolve(okResp({ items: [], next_cursor: null }));
    // 正对照：真取回空回收站后同一句必须改口，否则这条腿只是「永远不说」
    await waitFor(() => expect(emptyDesc()).toContain("回收站是空的"));
  });
});

describe("D213 UI 用例列表高级搜索 / 列设置", () => {
  const sentFilter = () => {
    const raw = qsOf(listUrls.at(-1)!).get("filter");
    return raw === null ? null : JSON.parse(raw);
  };

  it("应用「名称包含 冒烟」后下一次列表请求带条件 JSON，空条件时首次请求不带 filter", async () => {
    mockBackend({ normal: [uiCase("c1")], recycled: [], total: 1 });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    expect(qsOf(listUrls[0]).get("filter")).toBeNull();

    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const row = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(row).getByTestId("lt-val-text"), { target: { value: "冒烟" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listUrls).toHaveLength(2));
    expect(sentFilter()).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "冒烟" }],
    });
    // 高级搜索与回收站开关并行：条件在场不影响 recycled 轴
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await waitFor(() => expect(qsOf(listUrls.at(-1)!).get("recycled")).toBe("true"));
    expect(sentFilter()).not.toBeNull();
  });

  it("列设置勾掉「优先级」只藏那一列（其余表头与行操作原样）", async () => {
    mockBackend({ normal: [uiCase("c1")], recycled: [], total: 1 });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findByTestId("ui-case-row-name");
    const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("优先级");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "优先级", "启用", "最近结果", "负责人", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("优先级")]);
    await waitFor(() => expect(thead()).not.toContain("优先级"));
    expect(thead()).toContain("最近结果");
    expect(screen.getByTestId("ui-case-del")).not.toBeNull();
  });
});

// ── D273：UI 用例批量回收/恢复（正常视图批量回收，回收站批量恢复）────────────
// 与 api.tsx D251/D252 同口径。mockBackend 已按 recycled 切片并把 /ui-cases/ POST 全记录，
// 这里直接复用：勾选 → 确认 → posts 里出现 batch-delete/batch-restore + case_ids。
describe("uiCases 批量回收/恢复（D273）", () => {
  function boxes(): HTMLElement[] {
    return Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row input[type="checkbox"]'));
  }

  it("勾 2 行 → 批量回收：POST batch-delete 带 case_ids；MEMBER 无删除位不渲染批量条", async () => {
    mockBackend({ normal: [uiCase("c1"), uiCase("c2"), uiCase("c3")], recycled: [] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findAllByTestId("ui-case-row-name");
    expect(screen.queryByTestId("ui-case-batch-bar")).toBeNull();
    fireEvent.click(boxes()[0]);
    fireEvent.click(boxes()[1]);
    expect((await screen.findByTestId("ui-case-batch-bar")).textContent).toContain("已选 2 项");
    fireEvent.click(screen.getByTestId("ui-case-batch-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "放入回收站" }));
    await waitFor(() => expect(posts.some((p) => p.url.includes("/ui-cases/batch-delete"))).toBe(true));
    const call = posts.find((p) => p.url.includes("/ui-cases/batch-delete"))!;
    expect(call.body.project_id).toBe("p1");
    expect([...(call.body.case_ids as string[])].sort()).toEqual(["c1", "c2"]);
    await waitFor(() => expect(screen.queryByTestId("ui-case-batch-bar")).toBeNull());
  });

  it("MEMBER（-*:delete）：正常视图无勾选列、无批量回收条（隐藏不是禁用）", async () => {
    useAuth.setState({ project: MEMBER_PROJECT });
    mockBackend({ normal: [uiCase("c1")], recycled: [] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await screen.findAllByTestId("ui-case-row-name");
    expect(screen.queryByTestId("ui-case-batch-delete")).toBeNull();
    expect(boxes()).toHaveLength(0);
  });

  it("回收站视图勾行 → 批量恢复：POST batch-restore 带 case_ids", async () => {
    mockBackend({ normal: [], recycled: [uiCase("c9", { status: "recycled" }), uiCase("c8", { status: "recycled" })] });
    render(<MemoryRouter><UiCasesPage /></MemoryRouter>);
    await waitFor(() => expect(document.body.textContent).toContain("还没有 UI 用例"));
    fireEvent.click(screen.getByTestId("ui-case-recycled"));
    await waitFor(() => expect(screen.getAllByTestId("ui-case-row-name")).toHaveLength(2));
    fireEvent.click(boxes()[0]);
    expect(await screen.findByTestId("ui-case-batch-restore")).not.toBeNull();
    fireEvent.click(screen.getByTestId("ui-case-batch-restore"));
    const m = await waitFor(() => {
      const el = document.querySelector(".ant-modal-confirm") as HTMLElement | null;
      if (!el) throw new Error("确认框未出现");
      return el;
    });
    fireEvent.click(within(m).getByRole("button", { name: /^恢\s*复$/ }));
    await waitFor(() => expect(posts.some((p) => p.url.includes("/ui-cases/batch-restore"))).toBe(true));
    const call = posts.find((p) => p.url.includes("/ui-cases/batch-restore"))!;
    expect((call.body.case_ids as string[]).length).toBeGreaterThan(0);
  });
});
