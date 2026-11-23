// 场景列表页（§11.4.8）——一期 DoD 判据第 3 条「UI 面」（1E T9 补账）的角色门控用例。
// 手法照抄 adbCases.test.tsx / api.test.tsx：fetch 全 mock 到 client 层、useAuth.setState 注身份。
// 期望值从 web/src/auth/perms.ts 的 ROLE_PATTERNS 字面量推导（改那张表这条会变红）：
//   PROJECT_ADMIN ["*","-system:*"]                  → scenario:{create,update,delete} 全有
//   MEMBER ["*","-*:delete","-*:manage","-system:*"] → create/update 有、delete 被 -*:delete 拒
//   READONLY ["*:read","-system:*"]                  → create/update/delete 全无（读写三位都不同名）
// 最后一条钉「按钮跟 my_perms 走、不跟写死的 role 字符串走」：服务端显式补位即按钮回来。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfigProvider, message, Modal } from "antd"; // D74 导出例：spy message.warning 钉「notes 非空不静默」

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import ScenesPage from "./scenes";
import { useAuth } from "../auth/store";
import { sceneApi } from "../api/scene";
import type { ScenarioListRow } from "../api/scene";
import { STATUSES } from "../shared/runVocab";

type Row = ScenarioListRow;

function scene(over: Partial<Row> = {}): Row {
  return {
    id: "s1", project_id: "p1", name: "履约回归", status: "normal", priority: "P2",
    variables: {}, fail_fast: true, project_public: true, version: 1, step_count: 2,
    issues: [], produced: [], ...over,
  };
}

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

function mockRows(items: Row[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/scenario-modules") ? { tree: [], recycled: [] }
      : url.includes("/envs?") ? { items: [{ id: "e9", project_id: "p1", name: "预发环境",
        position: 0, config: null }], next_cursor: null }
      : url.includes("/members") ? { items: [], next_cursor: null }
      // D261：跨项目复制的项目候选（当前项目 p1 由页面自己过滤掉）
      : url.includes("/projects?") ? { items: [
        { id: "p1", name: "履约", my_role: "PROJECT_ADMIN", my_perms: ["*"] },
        { id: "p2", name: "结算", my_role: "PROJECT_ADMIN", my_perms: ["*"] },
        { id: "p3", name: "只读项目", my_role: "READONLY", my_perms: ["*:read"] },
      ], next_cursor: null }
      : { items, next_cursor: null };
    // 每次调用现拷一份全新对象图（真 fetch 每次解析出新的对象——同引用交两次会把
    // 「setRows(同一数组) → React  bail out → load 依赖实际没变」的 rows-进-依赖 回路
    // 吃成假绿：深拷之后那个回路会在绊线上真转出第二发，才量得着（计划 §六 步 3b 的学费）。
    return { ok: true, status: 200,
      json: async () => JSON.parse(JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ── D47-b 步5b 的服务端形状桩（页码分页契约测试专用）────────────────────────────
// 真按 query 参数过滤（recycled / keyword 只打 name 大小写不敏感 / module_ids 重复键）、
// 按 current/size 切片、报 total；**每次调用现拷一份全新响应体**（JSON.parse(JSON.stringify)，
// api.test.tsx:62 同法）——同引用反复交出会把「响应→load 依赖变脏→无限回路」吃成假绿，
// reports/runs 转换都为这个付过学费（计划 §六 步 3b：300ms 打出 22~34 条请求而测试全绿）。
// keyword 的大小写不敏感是后端契约（只打 name、不敏感），桩照抄；测试钉的是
// 「我们把 keyword 原样送上线」，不是「浏览器替后端做了小写化」。
type ServerTree = { id: string; parent_id: string | null; name: string; sort: number;
  status: string; count: number; children: ServerTree[] };
function sceneServer(rows: Row[], opts: {
  tree?: ServerTree[]; total?: number | null; // total: null = 响应整键不给（游标式旧形状）
} = {}) {
  const listUrls: string[] = [];
  const resp = (json: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/scenario-modules")) return resp({ tree: opts.tree ?? [], recycled: [] });
    if (url.includes("/members") || url.includes("/envs?")) return resp({ items: [], next_cursor: null });
    if (/\/scenarios\?/.test(url)) {
      listUrls.push(url);
      const q = new URLSearchParams(url.split("?")[1]);
      const size = Number(q.get("size") ?? "20");
      const current = Number(q.get("current") ?? "1");
      const kw = (q.get("keyword") ?? "").toLowerCase();
      // module_ids 断言一律走 getAll（重复键）：逗号拼接的 "a,b" 只会解成一个不存在的 id，
      // 「url 包含 module_ids」那种断言对静默错是瞎的。
      const mids = q.getAll("module_ids");
      const wantRecycled = q.get("recycled") === "true";
      const hit = rows.filter((r) => {
        if ((r.status === "recycled") !== wantRecycled) return false;
        if (mids.length && !mids.includes(r.module_id ?? "__none")) return false;
        if (kw && !r.name.toLowerCase().includes(kw)) return false;
        return true;
      });
      const page = { items: hit.slice((current - 1) * size, (current - 1) * size + size),
        next_cursor: null } as { items: Row[]; next_cursor: null; total?: number };
      if (opts.total !== null) page.total = opts.total ?? hit.length;
      return resp(page);
    }
    return resp({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { listUrls };
}
/** 最近一条列表请求的 query。 */
function lastListQ(h: { listUrls: string[] }): URLSearchParams {
  return new URLSearchParams(h.listUrls[h.listUrls.length - 1].split("?")[1]);
}
/** rc-input 的 Enter 有 keyLockRef：一次 keyDown 后锁住，到 keyUp 才放行——连按两次
 *  keyDown 第二次会被静默吞掉。提交 Enter 一律按这对来（api.test.tsx:99 同款）。 */
function pressEnter(el: HTMLElement): void {
  fireEvent.keyDown(el, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(el, { key: "Enter", code: "Enter" });
}
/** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
function clickPage(n: number): void {
  fireEvent.click(screen.getByTestId("list-pager")
    .querySelector(`.ant-pagination-item-${n} a`) as Element);
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
  mockRows([scene()]);
});

describe("场景页角色门控（判据第 3 条 UI 面）", () => {
  it("PROJECT_ADMIN：新建/行内删除/勾选后批量回收站全在", async () => {
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    // D47-b 步5b 无限回路绊线放在**全文件最早挂载列表**的用例上（api.test.tsx:144 实测理由）：
    // 「取数落地把自己写的 state（rows/total）塞回 load 依赖」这种回路，若绊线只在后面的
    // 页码块里，前面每条用例都带着一个不停发请求的后台回路跑完——整文件被拖垮、最后仍由
    // 页码块报红，但红得又慢又难归因。放在最前面 = 回路第一条就红，且只红一条。
    await new Promise((r) => setTimeout(r, 300));
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).filter((u) => u.includes("/scenarios?"))).toHaveLength(1);
    expect(screen.getByTestId("scene-new")).not.toBeNull();
    expect(screen.getByTestId("scene-delete")).not.toBeNull();
    // 勾选行 → 批量条：移动/复制（scenario:update）与回收站（scenario:delete）都在
    const box = document.querySelector<HTMLInputElement>(".ant-table-thead input[type=checkbox]");
    expect(box).not.toBeNull();
    fireEvent.click(box!);
    await waitFor(() => expect(screen.getByTestId("scene-batch-bar")).not.toBeNull());
    expect(screen.getByTestId("scene-batch-del")).not.toBeNull();
  });

  it("内置表 MEMBER（-*:delete）：可新建，行内删除与批量回收站不在", async () => {
    // my_perms 缺省 → 回落 ROLE_PATTERNS.MEMBER 兜底路（patternsForProject 的另一分支）
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER", my_perms: undefined } });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    expect(screen.getByTestId("scene-new")).not.toBeNull();
    expect(screen.queryByTestId("scene-delete")).toBeNull();
    const box = document.querySelector<HTMLInputElement>(".ant-table-thead input[type=checkbox]");
    fireEvent.click(box!);
    await waitFor(() => expect(screen.getByTestId("scene-batch-bar")).not.toBeNull());
    expect(screen.getByTestId("scene-batch-move")).not.toBeNull(); // scenario:update 不被 -*:delete 拒
    expect(screen.queryByTestId("scene-batch-del")).toBeNull();
  });

  it("内置表 READONLY：新建/行内删除/批量按钮全不在（隐藏不是禁用）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: undefined } });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name"); // 读权限在（*:read）→ 列表照常渲染
    expect(screen.queryByTestId("scene-new")).toBeNull();
    expect(screen.queryByTestId("scene-delete")).toBeNull();
    const box = document.querySelector<HTMLInputElement>(".ant-table-thead input[type=checkbox]");
    fireEvent.click(box!);
    await waitFor(() => expect(screen.getByTestId("scene-batch-bar")).not.toBeNull());
    expect(screen.queryByTestId("scene-batch-move")).toBeNull();
    expect(screen.queryByTestId("scene-batch-del")).toBeNull();
  });

  it("按钮跟 my_perms 走：READONLY 角色 + 服务端显式 scenario:create → 新建回来，删除仍旧不在", async () => {
    // 服务端 my_perms 优先（perms.ts:45）——同一按钮的生死只由位集决定，不由 role 字符串决定
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "scenario:create"] } });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    expect(screen.getByTestId("scene-new")).not.toBeNull();
    expect(screen.queryByTestId("scene-delete")).toBeNull();
  });
});

// ── D255：场景批量回收/恢复（替代前端 for 循环单删）─────────────────────────
// 钉：① 批量回收只发一条 batch-delete（不再 N 次 /delete，避免半批成功半批失败）；
//     ② 回收站里能勾选并批量恢复，body 带勾中的 ids。
describe("回收站批量（D255）", () => {
  afterEach(() => { Modal.destroyAll(); cleanup(); });

  function mockBatch(items: Row[]) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = url.includes("/scenario-modules") ? { tree: [], recycled: [] }
        : url.includes("/members") || url.includes("/envs?") ? { items: [], next_cursor: null }
        : { items, next_cursor: null };
      return { ok: true, status: 200,
        json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }
  const boxes = () => Array.from(document.querySelectorAll(
    '.ant-table-tbody tr.ant-table-row input[type="checkbox"]'));
  const batchCall = (calls: { url: string; body: unknown }[], path: string) =>
    calls.find((c) => c.url.includes(path));

  it("批量回收只发一条 batch-delete，body 带勾选 ids", async () => {
    const calls = mockBatch([scene({ id: "s1" }), scene({ id: "s2", name: "下单主链" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    fireEvent.click(boxes()[0]);
    fireEvent.click(boxes()[1]);
    fireEvent.click(await screen.findByTestId("scene-batch-del"));
    fireEvent.click(await screen.findByTestId("scene-del-ok"));

    await waitFor(() => expect(batchCall(calls, "/scenario-batch-delete")).toBeTruthy());
    expect(batchCall(calls, "/scenario-batch-delete")!.body).toEqual(
      { project_id: "p1", scenario_ids: ["s1", "s2"] });
    // 旧的 N 次单删必须一条都不剩
    expect(calls.some((c) => c.method === "POST" && /\/scenarios\/[^/]+\/delete$/.test(c.url)))
      .toBe(false);
  });

  it("批量复制只发一条 batch-copy，body 带勾选 ids", async () => {
    const calls = mockBatch([scene({ id: "s1" }), scene({ id: "s2", name: "下单主链" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    fireEvent.click(boxes()[0]);
    fireEvent.click(boxes()[1]);
    fireEvent.click(await screen.findByTestId("scene-batch-copy"));

    await waitFor(() => expect(batchCall(calls, "/scenario-batch-copy")).toBeTruthy());
    expect(batchCall(calls, "/scenario-batch-copy")!.body).toEqual(
      { project_id: "p1", scenario_ids: ["s1", "s2"] });
    expect(calls.some((c) => c.url.includes("/duplicate"))).toBe(false);
  });

  it("回收站勾选后批量恢复，body 带 ids", async () => {
    const calls = mockBatch([
      scene({ id: "s1", status: "recycled", updated_by: "u9" }),
      scene({ id: "s2", name: "下单主链", status: "recycled", updated_by: "u9" }),
    ]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(boxes().length).toBe(2));
    fireEvent.click(boxes()[0]);
    fireEvent.click(await screen.findByTestId("scene-batch-restore"));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: /恢\s*复/ }));

    await waitFor(() => expect(batchCall(calls, "/scenario-batch-restore")).toBeTruthy());
    expect(batchCall(calls, "/scenario-batch-restore")!.body).toEqual(
      { project_id: "p1", scenario_ids: ["s1"] });
  });
});

// ── D256：场景回收站批量彻底删除（短语确认；服务端也验）─────────────────────
describe("回收站批量彻底删除（D256）", () => {
  afterEach(() => { Modal.destroyAll(); cleanup(); });

  it("未输短语禁用；输对后 POST 带 confirm_word 与 ids", async () => {
    const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      const json = url.includes("/scenario-modules") ? { tree: [], recycled: [] }
        : { items: [scene({ id: "s1", status: "recycled", updated_by: "u9" }),
          scene({ id: "s2", name: "下单主链", status: "recycled", updated_by: "u9" })],
        next_cursor: null };
      return { ok: true, status: 200,
        json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
    }) as unknown as typeof fetch;

    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(document.querySelectorAll(
      '.ant-table-tbody tr.ant-table-row input[type="checkbox"]').length).toBe(2));
    const boxes = Array.from(document.querySelectorAll(
      '.ant-table-tbody tr.ant-table-row input[type="checkbox"]'));
    fireEvent.click(boxes[0]);
    fireEvent.click(await screen.findByTestId("scene-batch-purge"));

    const summary = await screen.findByTestId("scene-batch-purge-summary");
    expect(summary.textContent).toContain("无法恢复");

    const okBtns = () => Array.from(document.querySelectorAll(
      ".ant-modal-footer .ant-btn-primary")) as HTMLButtonElement[];
    const ok = () => okBtns()[okBtns().length - 1];
    expect(ok().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("scene-batch-purge-confirm"),
      { target: { value: "彻底删除" } });
    await waitFor(() => expect(ok().disabled).toBe(false));
    fireEvent.click(ok());

    await waitFor(() => expect(calls.some((c) => c.url.includes("/scenario-batch-purge"))).toBe(true));
    const sent = calls.find((c) => c.url.includes("/scenario-batch-purge"))!;
    expect(sent.body).toEqual({ project_id: "p1", scenario_ids: ["s1"], confirm_word: "彻底删除" });
    await waitFor(() => expect(screen.queryByTestId("scene-batch-bar-recycled")).toBeNull());
  });
});

// §11.4.18 回收站「删除人/删除时间」两列：同一份 updated_by 在正常行上是「最后编辑人」，
// 只有回收站里最后那次写才恰好是回收本身——所以两列**必须**被 inRecycled 守卫圈住，
// 正常视图里出现这两列就是说谎（变异 B 拆守卫后第二条用例变红）。
describe("回收站两列（§11.4.18）", () => {
  const recycledRow = scene({
    status: "recycled", updated_by: "u9", updated_by_name: "王小明",
    updated_at: "2026-11-01T02:34:56+00:00",
  });

  it("回收站视图：删除人显示人名，删除时间走 Asia/Shanghai 换算", async () => {
    mockRows([recycledRow]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    // 删除人是人名不是 id（后端查不到人给 null → 前端画「—」，这里给的是查到的）
    expect((await screen.findByTestId("scene-recycled-by")).textContent).toContain("王小明");
    // 02:34:56 UTC + 8h = 10:34 上海——若谁退回 slice(0,16) 会露出 UTC 钟点 02:34（R68 的坑）
    expect((await screen.findByTestId("scene-recycled-at")).textContent).toContain("2026-11-01 10:34");
  });

  it("正常列表不许出现这两列（同字段在正常行上是最后编辑人，标成删除人即说谎）", async () => {
    mockRows([recycledRow]); // 行数据照带 updated_by_name/updated_at，钉的是列渲染不是数据
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    expect(screen.queryByTestId("scene-recycled-by")).toBeNull();
    expect(screen.queryByTestId("scene-recycled-at")).toBeNull();
    expect(screen.queryByText("删除人")).toBeNull();
    expect(screen.queryByText("删除时间")).toBeNull();
  });
});

// D74 批量条 [导出]（§11.4.8）：手法照 api.test.tsx 的导出例——mock sceneApi.export、
// 桩 URL.createObjectURL 记 Blob、spy HTMLAnchorElement.click 钉下载触达。
// 钉三件事：① 点钮 → 真调 sceneApi.export 且入参就是勾选的 id 列表原样（变异：摘 onClick
// 或摘 scenario_ids 展开即红——「勾了 3 条点导出、实际没带 ids」是 §13 纪律 1 的假门反例）；
// ② 返回体落盘成 blob（导出的内容真的能带走，不是 toast 空转）；
// ③ notes 非空出 warning 不静默；无 scenario:read 隐藏（后端 perm 同源）。
describe("批量导出（D74）", () => {
  const EXPORT_OUT = {
    scenarios: [{
      scenario_id: "s1", name: "履约回归", priority: "P2", module_id: null,
      step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true,
      max_runtime_ms: null, common_assertions: [], env_id: null, project_public: true,
      validation: [], refs: [],
    }],
    exported: 1, notes: [],
  };

  function checkRows(...idx: number[]) {
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('.ant-table-tbody input[type="checkbox"]'));
    for (const i of idx) fireEvent.click(boxes[i]);
  }

  it("勾选 2 行 → [导出] 入参的 scenario_ids 恰好是这 2 个 id，返回体落盘下载", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    (URL as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    const exp = vi.spyOn(sceneApi, "export").mockResolvedValue(EXPORT_OUT);
    mockRows([scene(), scene({ id: "s2", name: "登录接口集" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    checkRows(0, 1);
    await screen.findByTestId("scene-batch-bar");
    fireEvent.click(screen.getByTestId("scene-batch-export"));
    await waitFor(() => expect(exp).toHaveBeenCalledTimes(1));
    // 入参逐字钉：project + 选中 id 列表原样（顺序随勾选，集合必须恰好相等）
    const body = exp.mock.calls[0][0];
    expect(body.project_id).toBe("p1");
    expect([...(body.scenario_ids ?? [])].sort()).toEqual(["s1", "s2"]);
    // blob 内容 = 后端返回体（可带走的备份，不是占位）
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const blobArg = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(await blobArg.text()).toContain('"scenario_id": "s1"');
    expect(await screen.findByText(/已导出 1 条/)).not.toBeNull();
    clickSpy.mockRestore();
  });

  it("notes 非空 → warning 如实报，不静默", async () => {
    const warnSpy = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    (URL as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(sceneApi, "export").mockResolvedValue({
      ...EXPORT_OUT, notes: ["「履约回归」的图有 1 个校验问题（如实报）"],
    });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    checkRows(0);
    await screen.findByTestId("scene-batch-bar");
    fireEvent.click(screen.getByTestId("scene-batch-export"));
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(String(warnSpy.mock.calls[0][0])).toContain("校验问题");
    warnSpy.mockRestore();
  });

  it("无 scenario:read → [导出] 不渲染（隐藏而非禁用，§11.5.1）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["scenario:update"] } });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    checkRows(0);
    await waitFor(() => expect(screen.getByTestId("scene-batch-bar")).not.toBeNull());
    expect(screen.getByTestId("scene-batch-move")).not.toBeNull(); // update 位在 → 移动在，对照组
    expect(screen.queryByTestId("scene-batch-export")).toBeNull();
  });
});

// D70 反向假门：批量「执行」曾是说谎的 disabled 钮（背后 scenario_run 端点早已注册）。
// 这里钉的是「真入口」：可点（变异 A：改回 disabled / 摘 onClick 即红）、真调 sceneApi.run
// 且入参带环境口径（变异 B：不带 env 门 / 绕过权限即红）、无 scenario:run 时不渲染（隐藏非禁用）。
// 环境语义与场景编辑器 scene-env 同源：env_id=null = 用场景自己配置的环境（后端
// scenario_run 落 payload.env_id or s.env_id），不是「没环境也行」。
describe("批量执行（D70 反向假门解禁）", () => {
  const withEnv = scene({ env_id: "e5" });

  function checkFirstRow() {
    const box = document.querySelector<HTMLInputElement>(".ant-table-thead input[type=checkbox]");
    expect(box).not.toBeNull();
    fireEvent.click(box!);
  }

  it("钮可点；选了覆写环境 → 一次 batchRun 投递整批，body 带 {project_id, scenario_ids, env_id} 并有成功反馈", async () => {
    const batchRun = vi.spyOn(sceneApi, "batchRun")
      .mockResolvedValue({ ok: true, run_ids: ["r1", "r2"], failed: [] });
    const run = vi.spyOn(sceneApi, "run");
    mockRows([scene(), scene({ id: "s2", name: "登录接口集" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name"); // 两行 → 两个名字，findBy* 遇多重命中会抛
    checkFirstRow();
    await screen.findByTestId("scene-batch-run"); // 存在且**没断言 disabled**——那是旧假门的回归保护
    const btn = screen.getByTestId("scene-batch-run") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await screen.findByTestId("scene-run-modal");
    // antd Select 展开靠 .ant-select-selector 的 mousedown（照 notifyChannels.test 的手法）
    fireEvent.mouseDown(document.querySelector(".ant-modal .ant-select-selector")!);
    fireEvent.click(await screen.findByText("预发环境", { selector: ".ant-select-item-option-content" }));
    fireEvent.click(screen.getByTestId("scene-run-ok"));
    await waitFor(() => expect(batchRun).toHaveBeenCalledTimes(1));
    // D258：不再逐条 /scenarios/{id}/run，整批一次请求；勾选顺序原样进 scenario_ids
    expect(batchRun).toHaveBeenCalledWith(
      { project_id: "p1", scenario_ids: ["s1", "s2"], env_id: "e9" });
    expect(run).not.toHaveBeenCalled();
    // 成功反馈：话术与相邻「已移动 N 个场景 / 已复制 N 个场景」同构，且说清投递语义
    expect(await screen.findByText(/已入队 2 个执行/)).not.toBeNull();
  });

  it("场景自带环境 + 不选覆写 → env_id=null 交给后端逐场景回落（与编辑器同口径）", async () => {
    const batchRun = vi.spyOn(sceneApi, "batchRun")
      .mockResolvedValue({ ok: true, run_ids: ["r1"], failed: [] });
    mockRows([withEnv]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    checkFirstRow();
    fireEvent.click(screen.getByTestId("scene-batch-run"));
    await screen.findByTestId("scene-run-modal");
    const ok = screen.getByTestId("scene-run-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(false); // 场景自身 env_id 在 → 无覆写也许可执行
    fireEvent.click(ok);
    await waitFor(() => expect(batchRun).toHaveBeenCalledWith(
      { project_id: "p1", scenario_ids: ["s1"], env_id: null }));
  });

  it("无环境可跑（覆写未选且场景自身 env_id 空）→ 点名拦下，一次请求都不发（不许偷偷跑）", async () => {
    const batchRun = vi.spyOn(sceneApi, "batchRun")
      .mockResolvedValue({ ok: true, run_ids: [], failed: [] });
    mockRows([scene()]); // env_id 缺省 = 未配置环境
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    checkFirstRow();
    fireEvent.click(screen.getByTestId("scene-batch-run"));
    await screen.findByTestId("scene-run-modal");
    const ok = screen.getByTestId("scene-run-ok") as HTMLButtonElement;
    await waitFor(() => expect(ok.disabled).toBe(true));
    expect(await screen.findByTestId("scene-run-blocked")).not.toBeNull();
    expect(batchRun).not.toHaveBeenCalled();
  });

  it("部分投递失败 → 按回包 failed[] 报「已入队 1 个，1 个没投递成功」并清勾选", async () => {
    // D258 把「半途失败」从客户端循环的异常改成服务端 failed[] 回执：预检全有或全无，
    // 投递逐条 commit，broker 在第 k 条死掉时前 k-1 条已经诞生——回包必须如实分账，
    // 前端也不能拿勾选数冒充「已启动数」。
    const batchRun = vi.spyOn(sceneApi, "batchRun").mockResolvedValue({
      ok: true, run_ids: ["r1"],
      failed: [{ scenario_id: "s2", code: "executor_unavailable", message: "执行器不可用" }],
    });
    mockRows([scene({ env_id: "e5" }), scene({ id: "s2", name: "登录接口集", env_id: "e5" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    checkFirstRow();
    fireEvent.click(await screen.findByTestId("scene-batch-run"));
    await screen.findByTestId("scene-run-modal");
    fireEvent.click(screen.getByTestId("scene-run-ok"));
    expect(await screen.findByText(/已入队 1 个，1 个没投递成功/)).not.toBeNull();
    expect(batchRun).toHaveBeenCalledTimes(1); // 整批一次请求，不是回滚重投
    // 部分成功也要清掉勾选（load() 里 setSel([])）：同一批勾选不能被再点一次。
    await waitFor(() => expect(screen.queryByTestId("scene-batch-bar")).toBeNull());
  });

  it("无 scenario:run → 钮不渲染（按钮级权限点隐藏而非禁用，§11.5.1）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "scenario:update"] } });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    checkFirstRow();
    await waitFor(() => expect(screen.getByTestId("scene-batch-bar")).not.toBeNull());
    expect(screen.getByTestId("scene-batch-move")).not.toBeNull(); // update 位在 → 移动在，对照组
    expect(screen.queryByTestId("scene-batch-run")).toBeNull(); // run 位缺 → 执行钮整个不出现
  });

  it("D261 复制到项目：开窗现拉候选、当前项目不出现、无新建权限的目标禁用；确认后一条 batch-copy 带 target_project_id", async () => {
    const batchCopy = vi.spyOn(sceneApi, "batchCopy")
      .mockResolvedValue({ ok: true, created: 1, names: ["履约回归 - 副本"] });
    mockRows([scene()]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    checkFirstRow();
    fireEvent.click(await screen.findByTestId("scene-batch-copy-to"));
    await screen.findByTestId("scene-copy-to-modal");

    // 候选里不能出现当前项目（p1 履约）——复制给自己是「复制」钮的事
    fireEvent.mouseDown(document.querySelector(
      '[data-testid="scene-copy-to-project"] .ant-select-selector')!);
    const dropdown = document.querySelector(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden)") as HTMLElement;
    expect(within(dropdown).queryByText("履约")).toBeNull();
    expect(within(dropdown).getByText("结算")).not.toBeNull();
    // 只读项目标出原因并禁用（真正的门禁在后端，这里只避免点进去才吃 403）
    const ro = within(dropdown).getByText("只读项目（无场景新建权限）");
    expect((ro.closest(".ant-select-item-option") as HTMLElement).className)
      .toContain("ant-select-item-option-disabled");

    fireEvent.click(within(dropdown).getByText("结算"));
    fireEvent.click(screen.getByTestId("scene-copy-to-ok"));
    await waitFor(() => expect(batchCopy).toHaveBeenCalledWith({
      project_id: "p1", scenario_ids: ["s1"], target_project_id: "p2" }));
    expect(await screen.findByText(/已复制 1 个场景到「结算」/)).not.toBeNull();
    // 复制成功后清勾选：同一批勾选不能被再点一次
    await waitFor(() => expect(screen.queryByTestId("scene-batch-bar")).toBeNull());
  });
});

// ── 第十八轮 C：轴③ 零引用把手补测（scenes.tsx 的 9 个 data-testid）────────────
// 手法照上：fetch 全 mock 到 client 层（list 走 silent → 失败不弹 toast，错误态只能查表体）、
// useAuth.setState 注身份、vi.spyOn(sceneApi, *) 钉请求载荷本体。
// 注：scene-new-menu（scenes.tsx:356）在 jsdom 里摸不到 —— antd 5.29 Dropdown 把未知 props
// 转给 @rc-component/trigger 2.x，而 trigger 只从 restProps 里取事件回调、从不落 DOM
// （实测 <Dropdown data-testid> 挂/开两态 document 里都查无此节点）。该把手的**行为**
// 改走 trigger 钮 scene-new + 弹出菜单项文本钉死（下面 3 条），testid 本身是装饰性挂载。

function rowsEl(): HTMLElement {
  const el = document.querySelector(".ant-table-tbody");
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

/** 当前渲染的行名（按 DOM 顺序；空表返回 []，供 waitFor 轮询）。行内 span 的 testid 是 scene-row-name（scenes.tsx:416）。 */
function rowNames(): string[] {
  return within(rowsEl()).queryAllByTestId("scene-row-name").map((n) => n.textContent ?? "");
}

/** 等多行列表就绪（多行时 findByTestId 会 multiple 抛，这里按行数等）。 */
async function waitForRows(n: number): Promise<void> {
  await waitFor(() => expect(rowNames()).toHaveLength(n), { timeout: 4000 });
}

function rowBoxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(".ant-table-tbody input[type=checkbox]"));
}

/** 表头全选：三行的 id 全进 sel（批量条 id 载荷用例的「全选」入口）。 */
function checkAll(): void {
  const box = document.querySelector<HTMLInputElement>(".ant-table-thead input[type=checkbox]");
  expect(box).not.toBeNull();
  fireEvent.click(box!);
}

/** antd Dropdown trigger=["hover"] + mouseEnterDelay≈0.15s：三件套（ModuleTree.test.tsx:159 同款）。 */
async function hoverOpen(el: Element): Promise<void> {
  fireEvent.pointerOver(el);
  fireEvent.mouseOver(el);
  fireEvent.mouseEnter(el);
  await waitFor(() => {
    expect(document.querySelector(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item"))
      .not.toBeNull();
  }, { timeout: 4000 });
}

function visibleMenuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    ".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item"));
}

function menuItemByText(text: string): HTMLElement {
  const el = visibleMenuItems().find((n) => (n.textContent ?? "").includes(text));
  if (!el) throw new Error("菜单里没有「" + text + "」，现有："
    + visibleMenuItems().map((n) => n.textContent).join("/"));
  return el;
}

/** Select 展开：testid 挂在 .ant-select 根上（实测），点开 .ant-select-selector
 *  （RequestEditor.test.tsx:50 同款），然后点 option。 */
async function pickOption(selRoot: Element, label: string): Promise<void> {
  fireEvent.mouseDown(selRoot.querySelector(".ant-select-selector")!);
  fireEvent.click(await screen.findByText(label, { selector: ".ant-select-item-option-content" }));
}

/** 点弹窗的 [取消]（testid 只挂 ok 钮；antd 给两字 CJK 钮的可达名加了空格 → 正则匹配）。 */
function cancelModal(okTestId: string): void {
  const footer = screen.getByTestId(okTestId).closest(".ant-modal-footer") as HTMLElement;
  fireEvent.click(within(footer).getByRole("button", { name: /取\s*消/ }));
}

/** 带真模块树的 fetch mock：/scenario-modules 返回两节点树（移动目标下拉的选项来源），
 *  其余路由与 mockRows 同法（node 形状 = ScenarioModuleNode，toMod 会归一 children）。 */
function mockRowsWithTree(items: Row[]): void {
  const mod = (id: string, name: string) => ({
    id, parent_id: null, name, sort: 1, status: "normal", count: 0, children: [],
  });
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/scenario-modules")
      ? { tree: [mod("m1", "交易域"), mod("m2", "支付域")], recycled: [] }
      : url.includes("/members") ? { items: [], next_cursor: null }
      : { items, next_cursor: null };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const THREE = [
  scene(), // s1 履约回归
  scene({ id: "s2", name: "登录接口集" }),
  scene({ id: "s3", name: "退款链路" }),
];

beforeEach(() => {
  // Modal/Dropdown 的 portal 挂在 body 的独立 root 里，RTL cleanup 拆不掉
  // （ModuleTree.test.tsx 开头同款回归保护）：残留会把下条用例查成 multiple。
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
  // antd message 的 toast 也挂 body 自己的 root：上一条的「已复制 N 个场景」漂到
  // 下一条的 queryByText(/已复制/) 就是假绿/假红源，逐条清掉。
  message.destroy();
});

// scene-search（scenes.tsx）：D47-b 步5b 起把手是**服务端关键词**（keyword= 只打 name，
// 大小写不敏感是后端契约，浏览器不再小写化）。钉三件事（api.test.tsx 步4b 同法）：
// ① 打字只动输入框，零请求、行集纹丝不动；② 提交（Enter/放大镜/清空）各恰好一条请求，
// keyword 原样（trim 后）上线；「没有匹配」空态仍按**已提交**关键词归因。
describe("搜索把手（scene-search，服务端关键词）", () => {
  it("打字零请求；Enter 提交恰好一条 keyword=；大小写原样上线（后端的事不代劳）", async () => {
    const h = sceneServer([
      scene({ name: "履约回归" }), scene({ id: "s2", name: "登录接口集" }),
      scene({ id: "s3", name: "退款链路" }),
    ]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    const search = screen.getByTestId("scene-search");
    const base = h.listUrls.length;
    // ① 打字 = 零请求（与服务端契约最硬的一条腿：打字若仍本地过滤，行集当场就红）
    fireEvent.change(search, { target: { value: " 接口 " } });
    await new Promise((r) => setTimeout(r, 120));
    expect(h.listUrls.length).toBe(base);
    expect(screen.getAllByTestId("scene-row-name")).toHaveLength(3); // 行集纹丝不动
    // ② Enter 提交恰好一条，keyword 带着原样（trim 掉两端空白）上线，且回第 1 页
    pressEnter(search);
    await waitFor(() => expect(h.listUrls.length).toBe(base + 1));
    expect(lastListQ(h).get("keyword")).toBe("接口");
    expect(lastListQ(h).get("current")).toBe("1");
    await waitFor(() => expect(screen.getAllByTestId("scene-row-name").map((n) => n.textContent))
      .toEqual(["登录接口集"]));
    // 大写路径原样上线（浏览器不再 toLowerCase；大小写不敏感是后端 LIKE 的性质，桩照抄契约）
    fireEvent.change(search, { target: { value: "REFUND" } });
    const icon = (search.closest(".ant-input-search") as HTMLElement)
      .querySelector(".ant-input-search-button") as HTMLElement;
    const at2 = h.listUrls.length;
    fireEvent.click(icon); // 放大镜 = 另一个提交口
    await waitFor(() => expect(h.listUrls.length).toBe(at2 + 1));
    expect(lastListQ(h).get("keyword")).toBe("REFUND");
    // ③ allowClear 清空也是提交口：一条不带 keyword 的请求，全量回来
    const at3 = h.listUrls.length;
    const clearIcon = (search.closest(".ant-input-affix-wrapper") as HTMLElement)
      .querySelector(".ant-input-clear-icon") as Element;
    fireEvent.click(clearIcon);
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
    await waitFor(() => expect(h.listUrls.length).toBe(at3 + 1));
    expect(lastListQ(h).has("keyword")).toBe(false);
    await waitFor(() => expect(screen.getAllByTestId("scene-row-name")).toHaveLength(3));
    // ④ 纯空白提交 = 提交「不过滤」：kw 同值（空）合并 → 零新请求、永不上线 keyword
    fireEvent.change(search, { target: { value: "   " } });
    const at5 = h.listUrls.length;
    pressEnter(search);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.listUrls.length).toBe(at5);
    expect(lastListQ(h).has("keyword")).toBe(false);
  });

  it("提交全不匹配的关键词 → 空态「没有匹配的场景」不是空列表假象；没敲回车的那半截不背锅", async () => {
    const h = sceneServer([scene({ name: "Login Flow" }), scene({ id: "s2", name: "履约回归" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(2);
    const search = screen.getByTestId("scene-search");
    // 输入「查无此景」但**不提交**：行集不变、零请求——归因也不许提前怪它（D134 口径的腿）
    fireEvent.change(search, { target: { value: "查无此景" } });
    await new Promise((r) => setTimeout(r, 120));
    expect(h.listUrls).toHaveLength(1);
    expect(screen.getAllByTestId("scene-row-name")).toHaveLength(2);
    const emptyDesc = () => document
      .querySelector(".ant-table-placeholder .ant-empty-description")?.textContent ?? "";
    expect(emptyDesc()).not.toContain("没有匹配的场景");
    // 提交后才换行集与归因（大小写不敏感由桩照抄后端契约）
    pressEnter(search);
    await waitFor(() => expect(screen.queryByTestId("scene-row-name")).toBeNull());
    expect(emptyDesc()).toBe("没有匹配的场景，换个关键词试试");
  });
});

// scene-reload（scenes.tsx）：把手真身是重发 list 请求。
// list 走 silent（api/scene.ts 的 list 带 {silent:true}），失败不弹 toast，
// 所以失败路径的可见真相 = Alert 摊开说 + 空态改口（页码模式清行，见下）。
describe("刷新把手（scene-reload）", () => {
  const urls = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]));
  const listGetCount = () => urls().filter((u) => u.includes("/scenarios?")).length;

  it("点刷新 → GET /scenarios 再发一次；每次点击恰好重发一轮（list+tree 同批，不空转不双发）", async () => {
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    expect(listGetCount()).toBe(1);
    fireEvent.click(screen.getByTestId("scene-reload"));
    await waitFor(() => expect(listGetCount()).toBe(2));
    fireEvent.click(screen.getByTestId("scene-reload"));
    await waitFor(() => expect(listGetCount()).toBe(3));
    // load() 是 Promise.all([moduleTree, list])：每次刷新树与列表同批各一发，
    // 点了不重发（空转假门）或多发（双发浪费）都会在这两行断言间露馅。
    expect(urls().filter((u) => u.includes("/scenario-modules")).length).toBe(3);
  });

  // D47-b 步5b **有意的行为改变**（本条是对旧用例「刷新失败 → 上一次的行原样留着」的
  // 改写，不是删除——旧口径随本地过滤一起退役了，理由照 api.tsx 的 catch 注释）：
  // 页码模式下失败**清行清 total**——陈旧行 + 新 current 同屏就是「我在第几页」的两把
  // 尺子，与后端禁 cursor+current 同罪；旧脚注「上次取到 N 条」随清行一起退场。
  // 故障仍摊开说（Alert + 空态改口），只是不再拿上一批行冒充当前页。
  // D180 的不变量不受影响：shownRecycled 仍只在取数成功那一刻跟行一起翻（上面「D180 切
  // 回收站」的 ①③④⑤ 原样保留、② 随清行语义改写——失败不翻模板这条腿由「行没了 +
  // 字样/钮/空态一个不许出现」的组合继续钉死，没有任何一条被静默删掉）。
  it("刷新失败 → 清行清 total（页码模式不留两把尺子），Alert 与「计数不作数」都在", async () => {
    sceneServer(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    expect(screen.getByTestId("list-pager").textContent).toContain("共 3 条");
    // 下一轮 fetch 全 500（client 对非 ok 仍先 json()，信封要给真消息）
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500,
      json: async () => ({ code: "internal_error", message: "服务开小差了" }),
    })) as unknown as typeof fetch;
    fireEvent.click(screen.getByTestId("scene-reload"));
    // 新 mock 自己记次：这一发就是刷新补发的那次 list（摘 onClick 则永远是 0）
    await waitFor(() => expect(listGetCount()).toBe(1));
    await screen.findByTestId("scene-load-error");
    expect(document.body.textContent).toContain("服务开小差了");
    // 旧口径「行原样留着」作废：陈旧行不许冒充当前页（三行全下桌、空态改口）
    expect(screen.queryByTestId("scene-row-name")).toBeNull();
    expect(document.body.textContent).toContain("场景列表没取到");
    // 陈旧「共 3 条」不留在空表下：total 清空，分页器整块不渲染
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    expect(document.body.textContent).not.toContain("上次取到 3 条");
  });
});

// scene-new-menu（scenes.tsx:356）：testid 本身摸不进 DOM（Trigger 不落未知 props，见上注），
// 行为走 trigger 钮：菜单三项各归各位 —— blank 开弹窗 / gen 拉用例开弹窗 / pilot 跳 /bench。
// 变异：onClick 的 key 接错一根（blank↔gen、pilot 不 nav）即对应用例红。
describe("新建菜单三个出口（scene-new-menu 的行为面）", () => {
  it("「空白场景」→ 弹新建弹窗；「从用例生成」→ 拉 /api-cases 并弹窗；「让 Pilot 生成」→ 跳 /bench", async () => {
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    await hoverOpen(screen.getByTestId("scene-new"));
    expect(menuItemByText("空白场景")).toBeTruthy();
    expect(menuItemByText("从用例生成")).toBeTruthy();
    fireEvent.click(menuItemByText("空白场景"));
    await screen.findByTestId("scene-blank-modal");
    // 不关窗直接走第二条路：jsdom 的 fireEvent 不拦遮罩，两条弹窗互不遮蔽彼此 testid

    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("从用例生成"));
    await screen.findByTestId("scene-gen-modal");
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).some((u) => u.includes("/api-cases?"))).toBe(true);
  });

  it("「让 Pilot 生成」= 真跳 /bench（1F T6 哨兵翻真），还留在场景页就是假门", async () => {
    render(
      <MemoryRouter initialEntries={["/scenes"]}>
        <Routes>
          <Route path="/scenes" element={<ScenesPage />} />
          <Route path="/bench" element={<div data-testid="bench-page">试验台</div>} />
        </Routes>
      </MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("Pilot"));
    await screen.findByTestId("bench-page");
  });

  it("回收站视图整个菜单不渲染（canCreate 与 !inRecycled 双闸，回收站里新建是假门）", async () => {
    mockRows([scene({ status: "recycled", updated_by_name: "王小明" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("module-recycled-toggle");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await screen.findByTestId("scene-recycled-by");
    expect(screen.queryByTestId("scene-new")).toBeNull();
  });
});

// scene-blank-modal + scene-blank-prio（scenes.tsx:493/500）：POST body 必须带**用户选的**
// 优先级（:146 priority: blankPrio），没选则如实提交初始 P2；改名重开不许带出上次的草稿。
// 变异：body 里 priority 写死 "P2" → 第一条红；onOpen 不复位 → 第二条红。
describe("空白场景弹窗（scene-blank-modal / scene-blank-prio）", () => {
  async function openBlank(): Promise<void> {
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("空白场景"));
    await screen.findByTestId("scene-blank-modal");
  }

  it("选 P0 + 填名 → create body 的 priority 就是 P0，step_graph 是空骨架", async () => {
    const create = vi.spyOn(sceneApi, "create").mockResolvedValue({} as never);
    await openBlank();
    fireEvent.change(screen.getByTestId("scene-blank-name"), { target: { value: "履约回归" } });
    await pickOption(screen.getByTestId("scene-blank-prio").closest(".ant-select")!, "P0");
    fireEvent.click(screen.getByTestId("scene-blank-ok"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toEqual({
      project_id: "p1", name: "履约回归", priority: "P0", module_id: null,
      step_graph: { version: 1, nodes: [] },
      variables: {}, fail_fast: true, project_public: true,
    });
  });

  it("没碰优先级 → 提交初始 P2（默认要说得出口）；取消的草稿重开不许带出来", async () => {
    const create = vi.spyOn(sceneApi, "create").mockResolvedValue({} as never);
    await openBlank();
    // 新开的弹窗里优先级就显示 P2 —— 这就是「用户没选时的既见默认」，提交必须与所见一致
    expect(screen.getByTestId("scene-blank-prio").textContent).toContain("P2");
    fireEvent.change(screen.getByTestId("scene-blank-name"), { target: { value: "一次" } });
    fireEvent.click(screen.getByTestId("scene-blank-ok"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0].priority).toBe("P2");
    expect(create.mock.calls[0][0].name).toBe("一次");

    // 填一半取消 → 重开必须是干净表单：菜单 onClick 里的 setBlankName("")/setBlankPrio("P2")
    fireEvent.change(screen.getByTestId("scene-blank-name"), { target: { value: "半截草稿" } });
    await pickOption(screen.getByTestId("scene-blank-prio").closest(".ant-select")!, "P3");
    cancelModal("scene-blank-ok");
    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("空白场景"));
    expect((screen.getByTestId("scene-blank-name") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("scene-blank-prio").textContent).toContain("P2");
    // 第一次 create 成功后还有 await load()（scenes.tsx:181），busy 要到那儿才释放，
    // 而 confirmLoading 让 OK 直接吞点击——慢后端探针实测第二次 create 一条都不发。
    // 类名必须在**弹窗开着**的时候数：关着期间整棵子树不重渲染，ant-btn-loading 会冻住
    // （adbDevices.purge.test.tsx:216 / ModelTab.test.tsx:213 记过的同款陷阱）。
    await waitFor(() => expect(screen.getByTestId("scene-blank-ok").className).not.toContain("ant-btn-loading"));
    fireEvent.change(screen.getByTestId("scene-blank-name"), { target: { value: "二次" } });
    fireEvent.click(screen.getByTestId("scene-blank-ok"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0].name).toBe("二次");
    expect(create.mock.calls[1][0].priority).toBe("P2"); // 取消前的 P3 不许走私进下一次提交
  });

  it("无 scenario:create → 触发钮不渲染，弹窗根本没有入口（隐藏不是禁用）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "scenario:run"] } });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    expect(screen.queryByTestId("scene-new")).toBeNull();
    expect(screen.queryByTestId("scene-blank-modal")).toBeNull();
  });
});

// scene-batch-copy（scenes.tsx:375）：批量语义 = 每个勾中的 id 各发一次 duplicate、
// 没勾的一个不发（批量条本身就是空选的物理拦截）；中途失败不许谎报「已复制 N 个」。
// 变异：循环条件改用 rows 全量 → 第一条的 id 集合多一个即红；catch 里照发 success → 第三条红。
describe("批量复制（scene-batch-copy）", () => {
  it("勾 s1+s3 → 一条 batch-copy，body 带勾选 ids（D257 起不再 N 次 duplicate）", async () => {
    const copy = vi.spyOn(sceneApi, "batchCopy")
      .mockResolvedValue({ ok: true, created: 2, names: [] } as never);
    const dup = vi.spyOn(sceneApi, "duplicate").mockResolvedValue({} as never);
    mockRows(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    const boxes = rowBoxes();
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    await screen.findByTestId("scene-batch-bar");
    fireEvent.click(screen.getByTestId("scene-batch-copy"));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(copy.mock.calls[0][0]).toEqual({ project_id: "p1", scenario_ids: ["s1", "s3"] });
    expect(dup).not.toHaveBeenCalled();
    expect(await screen.findByText(/已复制 2 个场景/)).not.toBeNull();
  });

  it("空选：批量条（连复制钮）整个不渲染，duplicate 一个都不发", async () => {
    const dup = vi.spyOn(sceneApi, "duplicate")
      .mockImplementation(async (id: string) => scene({ id }) as never);
    mockRows(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    expect(screen.queryByTestId("scene-batch-bar")).toBeNull();
    expect(screen.queryByTestId("scene-batch-copy")).toBeNull();
    expect(dup).not.toHaveBeenCalled();
  });

  it("batch-copy 失败 → 不谎报成功，success toast 一条都不新增，选择保留", async () => {
    const okSpy = vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    const copy = vi.spyOn(sceneApi, "batchCopy")
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "not_found" }));
    mockRows(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    const boxes = rowBoxes();
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]); // 只勾 2 个：断言对象与文案里的数字对得上
    // message.destroy() 只触发离场动画，jsdom 里节点未必来得及摘除：上一条漂来的
    // success toast 会污染全页 textQuery，所以这里数「新增的 success toast」而非查文本。
    const okToasts = () => document.querySelectorAll(".ant-message-notice-success").length;
    const before = okToasts();
    fireEvent.click(screen.getByTestId("scene-batch-copy"));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(okSpy).not.toHaveBeenCalled();
    expect(okToasts()).toBe(before);
    // 选择保留，用户改名单后可重试
    expect(screen.getByTestId("scene-batch-bar")).not.toBeNull();
  });

  it("无 scenario:update → 复制钮不渲染（隐藏而非禁用），移动钮同位缺席由上轮已钉", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "scenario:run"] } });
    mockRows(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    checkAll();
    await waitFor(() => expect(screen.getByTestId("scene-batch-bar")).not.toBeNull());
    expect(screen.getByTestId("scene-batch-run")).not.toBeNull(); // run 位在 → 执行在，对照组
    expect(screen.queryByTestId("scene-batch-copy")).toBeNull();
  });
});

// scene-gen-modal（scenes.tsx:508）：真建场景 —— N 个勾选用例按列表顺序变 api_case 步骤
// 骨架（ref=case_id、name 带上，:174-181），status!=normal 的用例根本不进列表（:161）。
// 变异：nodes 用 caseSel 之外的 rows 全量 / 摘掉 status filter / 空选不拦 → 逐条对应红。
describe("从用例生成（scene-gen-modal）", () => {
  it("拉 /api-cases 只收 normal；勾 2 个 → 生成的步骤骨架按序、ref=用例 id、name 随行", async () => {
    const create = vi.spyOn(sceneApi, "create").mockResolvedValue({} as never);
    // 复用 mockRows 的分路由：/api-cases? 落兜底分支，返回的就是「用例列表」
    mockRows([
      { id: "c1", project_id: "p1", definition_id: "d1", name: "下单", priority: "P0",
        request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
        effective_request: null },
      { id: "c2", project_id: "p1", definition_id: "d2", name: "支付", priority: "P1",
        request: null, assertions: [], dataset_id: null, sort: 2, status: "normal",
        effective_request: null },
      { id: "c3", project_id: "p1", definition_id: "d3", name: "已废弃", priority: "P2",
        request: null, assertions: [], dataset_id: null, sort: 3, status: "recycled",
        effective_request: null },
    ] as unknown as Row[]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3); // 兜底分支同样喂主列表：三行都在
    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("从用例生成"));
    await screen.findByTestId("scene-gen-modal");
    // W3a：壳（Modal 骨架）随 setGen(true) 同帧挂上，/api-cases 还在飞时窗内是空表——
    // 等待点挪到内容本身（满载机上 0ms 宏任务都会被挤到断言之后的现实时间线）。
    await within(screen.getByTestId("scene-gen-modal")).findByText("下单");
    // 弹窗内断言必须 within：兜底 fetch 把同一批用例也喂给了主列表（行名同为「下单/支付」），
    // 全页 textQuery 会 multiple 抛 —— 这不是凑合，正是「弹窗里的表才是勾选发生地」。
    const modal = screen.getByTestId("scene-gen-modal");
    expect(within(modal).getByText("下单")).not.toBeNull();
    expect(within(modal).queryByText("已废弃")).toBeNull(); // status!=normal 的不给勾（宁缺毋滥）
    fireEvent.change(within(modal).getByTestId("scene-gen-name"), { target: { value: "交易链路" } });
    // 必须限定 .ant-table-row：这张表带 scroll.y，rc-table 会在 tbody 顶部插一条
    // aria-hidden 的 measure 行（实测多出一个 checkbox），按裸索引取会整体错一位。
    const boxes = Array.from(modal.querySelectorAll<HTMLInputElement>(
      ".ant-table-tbody .ant-table-row input[type=checkbox]"));
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByTestId("scene-gen-ok"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const body = create.mock.calls[0][0];
    expect(body.name).toBe("交易链路");
    expect(body.step_graph).toEqual({
      version: 1,
      nodes: [
        { key: "s1", kind: "api_case", ref: "c1", name: "下单" },
        { key: "s2", kind: "api_case", ref: "c2", name: "支付" },
      ],
    });
  });

  it("没勾用例 → [生成] 是 disabled，空选一个都不发（拦截器兜底也不许偷发）", async () => {
    const create = vi.spyOn(sceneApi, "create").mockResolvedValue({} as never);
    mockRows([
      { id: "c1", project_id: "p1", definition_id: "d1", name: "下单", priority: "P0",
        request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
        effective_request: null },
    ] as unknown as Row[]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("从用例生成"));
    await screen.findByTestId("scene-gen-modal");
    fireEvent.change(screen.getByTestId("scene-gen-name"), { target: { value: "空手道" } });
    const ok = screen.getByTestId("scene-gen-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.click(ok);
    expect(create).not.toHaveBeenCalled();
  });
});

// scene-move-modal（scenes.tsx:533）：弹窗标题喊「移动 N 个场景」，body 必须真带那 N 个 id
// 和选中的目标模块（batchMove 是单请求，不是逐行 PATCH）。
// 变异：scenario_ids 写死首行 / module_id 丢 → 逐条红。
describe("批量移动（scene-move-modal）", () => {
  it("全选 3 行 + 选目标模块 → batchMove 带全部 3 个 id 与目标 module_id", async () => {
    const mv = vi.spyOn(sceneApi, "batchMove").mockResolvedValue({ ok: true });
    mockRowsWithTree(THREE); // 目标下拉的选项来自 /scenario-modules 的树（flatten(tree)）
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    checkAll(); // 表头全选
    fireEvent.click(screen.getByTestId("scene-batch-move"));
    await screen.findByTestId("scene-move-modal");
    await pickOption(screen.getByTestId("scene-move-target").closest(".ant-select")!, "支付域");
    fireEvent.click(screen.getByTestId("scene-move-ok"));
    await waitFor(() => expect(mv).toHaveBeenCalledTimes(1));
    expect(mv.mock.calls[0][0]).toEqual({
      project_id: "p1", scenario_ids: ["s1", "s2", "s3"], module_id: "m2",
    });
    expect(await screen.findByText(/已移动 3 个场景/)).not.toBeNull();
  });

  it("目标不选（allowClear 落占位「未分类（根）」）→ module_id=null 而非静默选第一个模块", async () => {
    const mv = vi.spyOn(sceneApi, "batchMove").mockResolvedValue({ ok: true });
    // 必须用**带真树**的 mock：树为空时 `flatten(tree)[0]?.value ?? null` 也得出 null，
    // 「悄悄选第一个模块」这个错分支就永远显不出来（变异取证实测过，见 1G 计划第十八轮）。
    mockRowsWithTree(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findAllByTestId("scene-row-name");
    checkAll();
    fireEvent.click(screen.getByTestId("scene-batch-move"));
    await screen.findByTestId("scene-move-modal");
    expect(screen.getByTestId("scene-move-target").textContent).toContain("未分类（根）");
    fireEvent.click(screen.getByTestId("scene-move-ok"));
    await waitFor(() => expect(mv).toHaveBeenCalledTimes(1));
    expect(mv.mock.calls[0][0].module_id).toBeNull();
    expect(mv.mock.calls[0][0].scenario_ids).toEqual(["s1", "s2", "s3"]);
  });

  it("无 scenario:update → 移动钮不渲染（隐藏而非禁用；run 位在的对照组）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "scenario:run"] } });
    mockRows(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    checkAll();
    await waitFor(() => expect(screen.getByTestId("scene-batch-bar")).not.toBeNull());
    expect(screen.getByTestId("scene-batch-run")).not.toBeNull();
    expect(screen.queryByTestId("scene-batch-move")).toBeNull();
  });
});

// scene-run-dot（scenes.tsx:52）：状态色点按行绑定 —— 点色是本页私有的十六进制（画的是点
// 不是 Tag），**文案吃 shared/runVocab.STATUSES**（D178：同一个值在 uiCases/schedules 两页
// 叫「断言失败/请求失败」，本页曾自写「失败/异常」= 一个值两个名字）。
// 期望值从 STATUSES 取：钉的是「两页同词」这条关系，改词表不会假红，改回手写词表必红。
// null → 「未运行」文字而不是假装有结果（:48）。
describe("最近结果状态点（scene-run-dot）", () => {
  it("每行的点色/文案按各自状态出：s1 断言失败红、s2 通过绿、s3 未运行无点", async () => {
    mockRows([
      scene({ last_run_status: "failed" }),
      scene({ id: "s2", name: "登录接口集", last_run_status: "passed" }),
      scene({ id: "s3", name: "退款链路", last_run_status: null }),
    ]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    // 行内绑定：按 antd 的 tr[data-row-key] 锁行再 within —— 挂错行/全行同色都红
    const tbody = rowsEl();
    const cell = (id: string) => {
      const tr = tbody.querySelector('tr[data-row-key="' + id + '"]') as HTMLElement | null;
      expect(tr).not.toBeNull();
      // 行名自证：锁的就是那一行，不是「恰好第 n 个 tr」
      return tr as HTMLElement;
    };
    expect(within(cell("s1")).getByTestId("scene-row-name").textContent).toBe("履约回归");
    expect(within(cell("s2")).getByTestId("scene-row-name").textContent).toBe("登录接口集");
    expect(within(cell("s3")).getByTestId("scene-row-name").textContent).toBe("退款链路");
    const dot1 = within(cell("s1")).getByTestId("scene-run-dot") as HTMLElement;
    expect(dot1.style.background).toBe("var(--tp-func-error)"); // RUN_DOT.failed 吃 tp.func.error（点色不再是本页私有 hex）
    expect(cell("s1").textContent).toContain(STATUSES.failed.label); // 「断言失败」，不是本页旧词「失败」
    const dot2 = within(cell("s2")).getByTestId("scene-run-dot") as HTMLElement;
    expect(dot2.style.background).toBe("var(--tp-func-success)"); // RUN_DOT.passed 吃 tp.func.success
    expect(cell("s2").textContent).toContain(STATUSES.passed.label);
    expect(dot1.style.background).not.toBe(dot2.style.background); // 全行同色（写死 color）即红
    expect(within(cell("s3")).queryByTestId("scene-run-dot")).toBeNull();
    expect(cell("s3").textContent).toContain("未运行");
  });

  // D178 的第二条腿：这一列的取值域只有 4 终态 + NULL（唯一回写门是 orchestration.py:268
  // 的 `status in TERMINAL`，且 trigger != "debug"）。RUN_DOT 里画 running/queued 两行
  // = 画两个生产写不出来的形状，还会把「正在跑」演给看的人。未知值一律降级成
  // 「灰点 + 原文」（:49 的 ??，宁可生码不可撒谎），这条同时钉住那两行不许回来。
  it("非终态值不承诺：running/queued 走未知降级（灰点 + 原文），终态才吃词表", async () => {
    mockRows([
      scene({ last_run_status: "running" }),
      scene({ id: "s2", name: "登录接口集", last_run_status: "queued" }),
      scene({ id: "s3", name: "退款链路", last_run_status: "error" }),
      scene({ id: "s4", name: "对账链路", last_run_status: "cancelled" }),
    ]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(4);
    const tbody = rowsEl();
    const cell = (id: string) => {
      const tr = tbody.querySelector('tr[data-row-key="' + id + '"]') as HTMLElement | null;
      expect(tr).not.toBeNull();
      return tr as HTMLElement;
    };
    for (const [id, raw] of [["s1", "running"], ["s2", "queued"]] as const) {
      const dot = within(cell(id)).getByTestId("scene-run-dot") as HTMLElement;
      // 降级到 cancelled 那支的灰：未知值不许借「运行中」的蓝
      expect(dot.style.background).toBe("var(--tp-text-3)"); // 降级灰 = tpv.func.skip（未知值不许借「运行中」的蓝）
      expect(cell(id).textContent).toContain(raw); // 原文，不编友好标签
      expect(cell(id).textContent).not.toContain(STATUSES.running.label);
      expect(cell(id).textContent).not.toContain(STATUSES.queued.label);
    }
    expect(cell("s3").textContent).toContain(STATUSES.error.label); // 「请求失败」，不是旧词「异常」
    expect(cell("s4").textContent).toContain(STATUSES.cancelled.label);
    // error 与 failed 同色（都是红的两种），但必须两个词——同色不同词是这张表的分工
    const dotErr = within(cell("s3")).getByTestId("scene-run-dot") as HTMLElement;
    expect(dotErr.style.background).toBe("var(--tp-func-error)");
  });

  // D178 裁 ③：这列的表头必须自己交代口径。它读冗余列、只在终态回写，正在跑的那次
  // 此刻不反映在这里——不写出来，读的人就拿「最近结果」当实时状态（第 2 条用例钉的是
  // 「不画蓝点」，钉不住表头这句话，两者是不同的承诺）。
  it("表头 tooltip 说清「不含调试、不反映正在跑的那次」", async () => {
    mockRows([scene({ last_run_status: "passed" })]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(1);
    const th = Array.from(rowsEl().ownerDocument.querySelectorAll<HTMLElement>("thead th"))
      .find((n) => (n.textContent ?? "").includes("最近结果"));
    expect(th).toBeDefined();
    const head = th as HTMLElement;
    // antd Tooltip 的 hover 处理器挂在它包住的那个 span 上（不是 th），只 hover th 弹不出来
    // （本轮探针实测：th 的 innerHTML 是 <span aria-describedby=…>）；两节点都过一遍。
    const hover = (n: Element | null) => {
      if (!n) return;
      fireEvent.pointerOver(n);
      fireEvent.mouseOver(n);
      fireEvent.mouseEnter(n);
    };
    hover(head);
    hover(head.querySelector("*"));
    await waitFor(() => {
      const tip = Array.from(document.querySelectorAll<HTMLElement>(".ant-tooltip:not(.ant-tooltip-hidden)"))
        .map((n) => n.textContent ?? "").join("");
      expect(tip).toContain("终态");
      expect(tip).toContain("不含调试");
      expect(tip).toContain("正在跑");
    }, { timeout: 4000 });
  });
});

// ── scene-new-menu（scenes.tsx:356）补账 ─────────────────────────────────────
// 该 testid 挂在 Dropdown 上，而 @rc-component/trigger 从不把未知 props 落 DOM（本文件
// 第十八轮的实测注释）——所以「testid 落点」这句永远为假，这里一概不查 testid 本身，
// 全部钉 newMenu（:321-334）的可观察行为：① 菜单项集合 = newMenu.items 的字面量集
// （名称、条数、且 blank/gen/pilot 三项一一对应）；② 开/闭两态（closed → items absent /
// opened → present）；③ 每项点击的后果（弹哪个窗 / 往哪跳）；④ 触发钮就是 newMenu 包住
// 的那个「新建场景」钮（canCreate 闸门归零时整条菜单入口蒸发）。
// 既有三条只按文案点单项，对「多一项/少一项/换一项」全盲；下面两条把集合与后果钉死。
describe("新建下拉的菜单集合与点击后果（scene-new-menu，newMenu 的实集）", () => {
  // newMenu.items 的字面量快照（scenes.tsx:322-326）：改名称/增删条目都会让本表红。
  const MENU = [
    { label: "空白场景", opens: "scene-blank-modal" },
    { label: "从用例生成", opens: "scene-gen-modal" },
    { label: "让 Pilot 生成", opens: null }, // pilot 不弹窗，跳 /bench（第三条单独钉）
  ];

  it("scene-new-menu：未 hover 零菜单项；hover 后恰好三项、名称顺序与 newMenu 字面量一致；点「空白场景」弹新建窗；菜单收起后项从 DOM 消失", async () => {
    // motion:false（ModuleTree.test.tsx:128 同款）：jsdom 没有 transitionend，
    // 开着动效的 leave-motion 永远挂起、弹窗 DOM 停在 inMotion 摘不掉——「closed → absent」
    // 这条量不到。关掉动效后关闭即卸载，量的才是「销毁不是隐藏」这句话。
    render(<ConfigProvider theme={{ token: { motion: false } }}><MemoryRouter><ScenesPage /></MemoryRouter></ConfigProvider>);
    await screen.findByTestId("scene-row-name");
    // 闭态（菜单从未打开）：一个菜单项都不许存在——预渲染整张菜单就是假门
    expect(visibleMenuItems()).toHaveLength(0);
    expect(screen.queryByTestId("scene-blank-modal")).toBeNull();
    await hoverOpen(screen.getByTestId("scene-new"));
    // 开态：集合=条数+名称+顺序三重钉死（toEqual 有序数组，mutate「换序/改名/多一项」都红）
    expect(visibleMenuItems().map((n) => n.textContent?.trim()))
      .toEqual(MENU.map((m) => m.label));
    // 点击后果落在 newMenu.onClick 的 key 路由上：blank → 弹 scene-blank-modal
    fireEvent.click(menuItemByText("空白场景"));
    await screen.findByTestId("scene-blank-modal");
    // 收起：React 的 onMouseLeave 由原生 mouseout 衍生（fireEvent.mouseLeave 的
    // 直发 mouseleave 到不了 EnterLeave 插件），leave → motion leave 后 trigger 卸弹窗。
    // antd 的弹窗 root 不随 RTL cleanup 卸载，菜单 DOM 若只藏不删，这条会因残留项而红
    // ——正是「closed → absent」的钉。
    fireEvent.mouseOut(screen.getByTestId("scene-new"));
    await waitFor(() => expect(visibleMenuItems()).toHaveLength(0), { timeout: 4000 });
  });

  it("scene-new-menu：每项点击各归各位——「从用例生成」发 /api-cases 拉 normal 用例并弹其窗；「让 Pilot 生成」跳 /bench 且弹层里绝不出现第三个窗", async () => {
    mockRows([
      { id: "c1", project_id: "p1", definition_id: "d1", name: "下单", priority: "P0",
        request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
        effective_request: null },
      { id: "c3", project_id: "p1", definition_id: "d3", name: "已废弃", priority: "P2",
        request: null, assertions: [], dataset_id: null, sort: 3, status: "recycled",
        effective_request: null },
    ] as unknown as Row[]);
    render(
      <MemoryRouter initialEntries={["/scenes"]}>
        <Routes>
          <Route path="/scenes" element={<ScenesPage />} />
          <Route path="/bench" element={<div data-testid="bench-page">试验台</div>} />
        </Routes>
      </MemoryRouter>);
    await waitForRows(2); // 兜底分支把同一批用例也喂给主列表：两行（多行时 findByTestId 会 multiple 抛）
    // 闭态：gen 窗没被预渲染（onClick 没跑过，模态不该先在 DOM 里躺着）
    expect(screen.queryByTestId("scene-gen-modal")).toBeNull();
    await hoverOpen(screen.getByTestId("scene-new"));
    // 后果①：key="gen" → openGen() 真拉 /api-cases（带 project_id 与 size），且 status
    // 过滤在后果里可见——normal 的「下单」进弹窗候选、archived 的「已废弃」不给勾。
    fireEvent.click(menuItemByText("从用例生成"));
    await screen.findByTestId("scene-gen-modal");
    // W3a：等待点从壳挪到内容——壳挂上时 openGen 的 /api-cases 还没回，见 :682 同注。
    await within(screen.getByTestId("scene-gen-modal")).findByText("下单");
    const apiCall = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).find((u) => u.includes("/api-cases?"));
    expect(apiCall).toBeDefined();
    expect(apiCall).toContain("project_id=p1");
    expect(within(screen.getByTestId("scene-gen-modal")).getByText("下单")).not.toBeNull();
    expect(within(screen.getByTestId("scene-gen-modal")).queryByText("已废弃")).toBeNull();
    // 后果②：key="pilot" → nav("/bench")，整页换掉（ScenesPage 连同其弹窗一起卸载）。
    cancelModal("scene-gen-ok"); // 正经关窗，不留悬挂模态
    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("让 Pilot 生成"));
    await screen.findByTestId("bench-page");
    // 跳的就是 /bench 路由本身——1F T6 前这里是 Modal.info 说明占位，mutate 回占位
    // 则永远停在场景页、bench-page 缺席，上面那行 findByTestId 超时即红。
  });
});

// 第八道差集的第二十三轮 → D47-b 步5b 改写：旧账「Page 只有 items+next_cursor、脚注的
// 「共」要游标作证」随页码模式作废——「共 N 条」从此只有**服务端 total** 这一张嘴：
// ⑥ 只跟响应 total（造 total=45 而行数 2）；⑦ 失败清行清 total（ListPager 随之消失）；
// ⑧ total 缺键（后端尚未上页码模式的游标式响应）→ 页脚整块不渲染且不报「共 0 条」。
describe("「共 N 条」只有服务端 total 这一张嘴（D47-b 步5b）", () => {
  it("total=45 而行数 2：「共 45 条」来自响应 total，不是屏上行数现攒；旧游标脚注整条退役", async () => {
    sceneServer([scene(), scene({ id: "s2", name: "退款链路" })], { total: 45 });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(2);
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    expect(document.body.textContent).not.toContain("共 2 条"); // 本地行数不许冒充「共」
    expect(document.body.textContent).not.toContain("单页上限 200");
    expect(document.body.textContent).not.toContain("后面还有没取的");
    expect(document.body.textContent).not.toContain("当前列表");
    expect(document.body.textContent).not.toContain("上次取到");
  });

  it("total 缺键（游标式旧响应）→ 页脚整块不渲染，也绝不报「共 0 条」（假按钮禁令）", async () => {
    sceneServer([scene(), scene({ id: "s2", name: "退款链路" })], { total: null });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(2);
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 0 条");
  });

  // 旧「首屏就 500」用例随本 describe 改写保留（口径没变，只是「脚注不报数」如今由
  // 清 total 兑现：分页器整块不渲染）：把失败画成实测零仍是禁止的。
  it("首屏就 500：Alert 摊开说；空态不说「还没有场景」；脚注不报数、分页器不渲染", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500,
      json: async () => ({ code: "internal_error", message: "场景库挂了", details: null }),
    })) as unknown as typeof fetch;
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    const alert = await screen.findByTestId("scene-load-error");
    expect(document.body.textContent).toContain("场景库挂了");
    expect(document.body.textContent).toContain("场景列表没取到");
    expect(document.body.textContent).not.toContain("还没有场景，点右上角新建");
    // 一行都没有时连数都不报：「共 0 条」是拿故障演实测零
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    expect(screen.queryByTestId("list-pager")).toBeNull();
    // 不给 ×：关掉这条 = 空态改口成「还没有场景」，把挂掉的请求演成实测零条
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
  });
});

// ── D47-b 步5b：页码模式主体（①②③⑤⑦ + runBlocked 的 sel⊆当前页 不变量）──────────
// 每页至少钉：① 挂载恰好一条 current=1&size=20；② 点第 2 页恰好一条 current=2；
// ③ 停在第 3 页点回收站 → recycled=true 且 current=1（筛选回第 1 页）；
// ⑤ 点模块 → module_ids 只带选中节点那**一个**（钉「本页仍是直属」，见用例注释）；
// ⑦ 失败清行清 total 在上面「刷新把手」；绊线在文件第一条（角色门控）。
describe("D47-b 步5b 页码模式：current 上线 / 筛选回第 1 页 / module_ids 重复键且直属", () => {
  function node(id: string, name: string, children: ServerTree[] = []): ServerTree {
    return { id, parent_id: null, name, sort: 0, status: "normal", count: 0, children };
  }
  // m-a 带一个孙子 m-a-1：若哪天有人把本页换成 subtreeIds，本用例当场红（见 ⑤ 注释）。
  const TREE = [node("m-a", "订单域", [node("m-a-1", "子单")]), node("m-b", "结算域")];
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
    const h = sceneServer(THREE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(3);
    expect(h.listUrls).toHaveLength(1);
    const q = lastListQ(h);
    expect(q.get("current")).toBe("1");
    expect(q.get("size")).toBe("20");
    expect(q.has("cursor")).toBe(false); // current+cursor 同传后端直接 400，永不同屏
  });

  it("② 点第 2 页恰好一条 current=2（D127 换皮：换页不双发、不空转）", async () => {
    // 25 条 + size 20 → 第 2 页 5 条；行名带页号，行集跟着页号走才证明 current 真上了线。
    const rows = Array.from({ length: 25 }, (_, i) =>
      scene({ id: "p1-" + i, name: "第一页场景" + i }));
    const h = sceneServer(rows);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(20);
    const before = h.listUrls.length;
    clickPage(2);
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    expect(lastListQ(h).get("current")).toBe("2");
    await waitFor(() => expect(screen.getAllByTestId("scene-row-name")).toHaveLength(5));
    expect(screen.getAllByTestId("scene-row-name")[0].textContent).toBe("第一页场景20");
  });

  it("③ 停在第 3 页点回收站 → 下一条请求 recycled=true 且 current=1（筛选漏斗的回页）", async () => {
    const rows = Array.from({ length: 55 }, (_, i) =>
      scene({ id: "p1-" + i, name: "第一页场景" + i }));
    const h = sceneServer(rows);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(20);
    clickPage(3);
    await waitFor(() => expect(h.listUrls[h.listUrls.length - 1]).toContain("current=3"));
    const before = h.listUrls.length;
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.get("recycled")).toBe("true");
    expect(q.get("current")).toBe("1"); // 正对照：确实从第 3 页被漏斗拍回第 1 页
  });

  it("⑤ 点模块 → module_ids 重复键且只带选中节点**一个**（直属口径，不是漏改也不是子树）", async () => {
    // 这条钉的是「本页仍是直属」：树里 m-a 有真子孙 m-a-1，若有人把这页顺手换成
    // subtreeIds（徽标还是直属数 →「徽标写 3、列表出 7」的 R120 谎），getAll 会多回
    // m-a-1，本条当场红。换成子树是另一刀、要后端徽标同刀改 + 业主先裁，不是这里顺手。
    // 断言走 getAll（重复键 + 逐值）：逗号拼接（qs 的 String(v) 之错）解出的 ["a,b"]
    // 会让「url 包含 module_ids」式断言假绿，这里不给他这个机会。
    const h = sceneServer([scene({ module_id: "m-a" })], { tree: TREE });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    const before = h.listUrls.length;
    await selectModule("订单域");
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.getAll("module_ids")).toEqual(["m-a"]); // 恰好一次、恰好 m-a：不带 m-a-1/m-b
    expect(q.get("current")).toBe("1");
    // 桩真按重复键过滤：m-a 的行还在（换成逗号拼接后后端解成 ["a,b"] 的静默空集，
    // 这里行集会先红——两把锁各防各的错形）
    await waitFor(() => expect(screen.getAllByTestId("scene-row-name").map((n) => n.textContent))
      .toEqual(["履约回归"]));
  });

  it("runBlocked 不变量：勾选后换页清空勾选——批量前校验只对当前页的行成立，不退化成静默放行", async () => {
    // runBlocked 用 rows.find 做「选中项缺环境」的批量前校验，它依赖 sel ⊆ 当前页 rows。
    // 勾中没有环境的 s1 → 弹窗点名拦下；此刻换到第 2 页：load 清 sel → 批量条整个下桌，
    // 「拦下」不许变成「放行」（换页后校验悄悄失明 = 静默放行没环境的场景去跑）。
    sceneServer([
      scene({ id: "s1", name: "没环境的场景" }),
      ...Array.from({ length: 20 }, (_, i) =>
        scene({ id: "o" + i, name: "填充场景" + i, env_id: "e5" })),
    ]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(20);
    fireEvent.click(rowBoxes()[0]); // s1：env_id 缺省
    await screen.findByTestId("scene-batch-bar");
    fireEvent.click(screen.getByTestId("scene-batch-run"));
    await screen.findByTestId("scene-run-modal");
    const ok = screen.getByTestId("scene-run-ok") as HTMLButtonElement;
    await waitFor(() => expect(ok.disabled).toBe(true));
    expect(await screen.findByTestId("scene-run-blocked")).not.toBeNull();
    cancelModal("scene-run-ok");
    clickPage(2);
    await waitFor(() => expect(screen.getAllByTestId("scene-row-name")[0].textContent)
      .toBe("填充场景19")); // 第 2 页落地
    // 换页清勾选：批量条消失（不是禁用糊弄，是没有勾选），换页后什么都不校验的窗口不存在
    expect(screen.queryByTestId("scene-batch-bar")).toBeNull();
  });
});

// ── 第二十三轮：批量执行窗里的「环境没取到」──
// 旧实现 `catch { setEnvs([]); } finally { setEnvsLoaded(true); }`：环境取失败与「项目真的
// 没配环境」画同一个 placeholder「还没有环境」，而 finally 把这次失败**永久钉死**——
// 关掉重开也不再请求，这一窗余生都在说「还没有环境」。旁边注释还写着「失败不假装环境列表
// 为空是同一句话」，描述的正是它没做的事。
describe("第二十三轮：批量执行窗的环境取失败", () => {
  const ENV_OK = { items: [{ id: "e9", project_id: "p1", name: "预发环境", position: 0, config: null }], next_cursor: null };
  /** env 请求第 N 次的行为由 envMode 决定：always 恒失败；once 只失败第一次。 */
  function mockEnv(mode: "always" | "once") {
    let envTries = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/envs?")) {
        envTries += 1;
        if (mode === "always" || envTries === 1) {
          return { ok: false, status: 500,
            json: async () => ({ code: "internal_error", message: "环境挂了", details: {} }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ENV_OK } as unknown as Response;
      }
      const body = url.includes("/scenario-modules") ? { tree: [], recycled: [] }
        : url.includes("/members") ? { items: [], next_cursor: null }
        : { items: [scene(), scene({ id: "s2", name: "登录接口集" })], next_cursor: null };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return () => envTries;
  }
  const ph = () => document.querySelector(".ant-modal .ant-select-selection-placeholder")?.textContent ?? "";

  async function openModal(): Promise<void> {
    await waitFor(() => expect(screen.getAllByTestId("scene-row-name")).toHaveLength(2));
    // 顶部表头全选（批量条只认勾选）——本 describe 自带的局部版本，
    // 文件里那个 checkRows 在另一个 describe 作用域内，拿不到。
    // 已勾过时不再点：勾选是组件 state，第二次点表头会把两行**取消**掉，批量条消失。
    if (!screen.queryByTestId("scene-batch-bar")) {
      const all = document.querySelector<HTMLInputElement>(".ant-table-thead input[type=checkbox]");
      expect(all).not.toBeNull();
      fireEvent.click(all!);
    }
    fireEvent.click(await screen.findByTestId("scene-batch-run"));
    await screen.findByTestId("scene-run-modal");
  }

  it("环境 500：placeholder 与窗内提示都说「没取到」，不许说「还没有环境」", async () => {
    mockEnv("always");
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await openModal();
    expect(await screen.findByTestId("scene-run-env-failed")).not.toBeNull();
    expect(ph()).toBe("环境没取到，关掉重开可重试");
    expect(document.body.textContent).not.toContain("还没有环境");
  });

  it("失败后关掉再开：真的重新请求（旧 finally 置 loaded → 第二次零请求，故障被永久定性）", async () => {
    const tries = mockEnv("always");
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await openModal();
    // W3a：openModal 等的是窗壳挂上，env 请求的「真的发出去了」要在下一帧才成观测事实——
    // 等待点挪到这个可观测后果上（计数断言一字未动）。
    await waitFor(() => expect(tries()).toBe(1));
    cancelModal("scene-run-ok");
    await openModal();
    await waitFor(() => expect(tries()).toBe(2));
  });

  it("重开时后端已恢复：选项回来了、失败提示消失、placeholder 回到中性句", async () => {
    mockEnv("once");
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await openModal();
    await screen.findByTestId("scene-run-env-failed");
    cancelModal("scene-run-ok");
    await openModal();
    await waitFor(() => expect(screen.queryByTestId("scene-run-env-failed")).toBeNull());
    expect(ph()).toBe("覆写环境（不选=各场景自带环境）");
    fireEvent.mouseDown(document.querySelector(".ant-modal .ant-select-selector")!);
    expect(await screen.findByText("预发环境", { selector: ".ant-select-item-option-content" })).not.toBeNull();
  });

  it("正对照：环境取成功 → 无失败提示，真空项目才说「还没有环境」", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/envs?") ? { items: [], next_cursor: null }
        : url.includes("/scenario-modules") ? { tree: [], recycled: [] }
          : url.includes("/members") ? { items: [], next_cursor: null }
            : { items: [scene(), scene({ id: "s2", name: "登录接口集" })], next_cursor: null };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await openModal();
    expect(screen.queryByTestId("scene-run-env-failed")).toBeNull();
    // W3a：「还没有环境」是 env 空回包落地后才换上的 placeholder，窗壳挂上时 env 还可能在飞
    // ——等待点挪到内容（串与 toBe 一字不动）。
    await waitFor(() => expect(ph()).toBe("还没有环境"));
  });
});

// ── 第廿六轮：空态指路话要兑现（两处）────────────────────────────────────────
// ① 「还没有场景，点右上角新建」指着的那枚钮在 :394 被 canCreate && !inRecycled 双闸
//    圈住：无新建权限的人照着空态去点，点的是一个根本没渲染的把手（规则④）。文案按
//    canCreate 分叉后 true 分支逐字不动——上面「首屏就 500」里那条 not.toContain(
//    「还没有场景，点右上角新建」) 钉着它对加载失败静默，动半个字它会红。
// ② 「从用例生成」弹窗的 /api-cases 是 silent 拉取：请求失败（连 toast 都没有）/
//    整页取回却全被 status 滤进回收站 / next_cursor 非空（单页 200，全称否定撑不住，
//    规则②）此前全塌成「项目里还没有接口用例」——把故障和存在演成 absence（规则③）。
// 四个 gen 用例各钉一个分支的确切新串：撤任一生产分支，只有对应那条红。
describe("第廿六轮：空态指路话要兑现（新建权限分叉 + 用例弹窗三态）", () => {
  /** /api-cases 单独分流（fail/next_cursor/全回收都由它给），主列表恒一行让菜单可开。 */
  function mockGenPage(opts: { items?: unknown[]; nextCursor?: string | null; fail?: boolean }): void {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api-cases?")) {
        if (opts.fail) {
          return { ok: false, status: 500,
            json: async () => ({ code: "internal_error", message: "用例库挂了", details: null }) } as unknown as Response;
        }
        return { ok: true, status: 200,
          json: async () => ({ items: opts.items ?? [], next_cursor: opts.nextCursor ?? null }) } as unknown as Response;
      }
      const body = url.includes("/scenario-modules") ? { tree: [], recycled: [] }
        : url.includes("/members") ? { items: [], next_cursor: null }
        : { items: [scene()], next_cursor: null };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const apiCase = (id: string, status: string) => ({
    id, project_id: "p1", definition_id: "d" + id, name: "用例" + id, priority: "P2",
    request: null, assertions: [], dataset_id: null, sort: 1, status, effective_request: null,
  });

  async function openGenModal(): Promise<HTMLElement> {
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    await hoverOpen(screen.getByTestId("scene-new"));
    fireEvent.click(menuItemByText("从用例生成"));
    return screen.findByTestId("scene-gen-modal");
  }

  it("从用例生成：silent 拉取 500 → 弹窗说「接口用例没取到，不是项目里没有」，不把故障演成空项目", async () => {
    mockGenPage({ fail: true });
    const modal = await openGenModal();
    expect(await within(modal).findByText("接口用例没取到，不是项目里没有：刷新或重试本弹窗")).not.toBeNull();
    // 失败绝不塌成 absence（规则③）；也不许点名 403——silent catch 混装 403 与网络挂（规则①）
    expect(within(modal).queryByText(/项目里还没有接口用例/)).toBeNull();
  });

  it("从用例生成：取回 2 条全被 status 滤进回收站 → 说「都在回收站里」，不说「还没有」", async () => {
    mockGenPage({ items: [apiCase("c1", "recycled"), apiCase("c2", "recycled")] });
    const modal = await openGenModal();
    expect(await within(modal).findByText("取到的 2 条接口用例都在回收站里，先恢复或换项目")).not.toBeNull();
    expect(within(modal).queryByText(/项目里还没有接口用例/)).toBeNull();
  });

  it("从用例生成：next_cursor 非空 = 单页 200 取不全 → 承认「只取到前 200 条」，不发全称否定", async () => {
    mockGenPage({ items: [], nextCursor: "c200" });
    const modal = await openGenModal();
    expect(await within(modal).findByText("只取到前 200 条接口用例，列表可能不全：勾不到的先去接口管理按模块找")).not.toBeNull();
    expect(within(modal).queryByText(/项目里还没有接口用例/)).toBeNull();
  });

  it("从用例生成：真·空列表（0 条且无游标）→ 原句逐字保留（e2e 可能 keyed 在它上面）", async () => {
    mockGenPage({ items: [] });
    const modal = await openGenModal();
    expect(await within(modal).findByText("项目里还没有接口用例：先去接口管理建用例")).not.toBeNull();
  });

  it("无 scenario:create + 零场景：空态改口「还没有场景（你没有新建权限）」，不指路到没渲染的钮", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: undefined } });
    mockRows([]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitFor(() => expect(document.body.textContent).toContain("还没有场景（你没有新建权限）"));
    expect(screen.queryByTestId("scene-new")).toBeNull(); // 双保险：被指路的那枚钮真没渲染
    expect(document.body.textContent).not.toContain("点右上角新建");
  });
});

// 第二十六轮站点 E 的第三站：scenes.tsx 的 <ModuleTree> 同样漏接线（本轮由我补上）。
// load() 是 Promise.all([moduleTree, list])（:95-98）：刷新失败时 recycledTree 留在 []，
// 不接线就等于让 ModuleTree.tsx:191 在「没取到」的当帧画「回收站是空的」。
// 上面 :465 那条钉的是「行不许塌」，这条钉的是「树栏不许把故障说成空」——两个把手各自独立。
describe("列表失败要传进模块树：回收站栏不许说「回收站是空的」（R26 站点 E 接线）", () => {
  it("全 500 后切回收站：这一栏说「回收站没取到」，不说「回收站是空的」", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500,
      json: async () => ({ code: "internal_error", message: "服务开小差了" }),
    })) as unknown as typeof fetch;
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-load-error");
    fireEvent.click(await screen.findByTestId("module-recycled-toggle"));
    const tip = await screen.findByTestId("module-tree-load-error");
    expect(tip.textContent).toContain("回收站没取到");
    expect(document.body.textContent).not.toContain("回收站是空的");
  });
});

// ── 第五道差集（前端 fixture ↔ 后端 ScenarioOut）：负责人列 / 模块列的「有值」分支 ────
// 背景：本文件既有 fixture 里 owner_id 全缺省（列表只画过「—」）、行 module_id 恒 null
// （Tag 那一支与「已回收模块」回落从没跑过），而 scenario/schemas.py:144/154 的
// module_id/owner_id 后端真填（场景编辑器选模块/落负责人即非空）。期望文案逐字对齐
// shared/ownerName.ts 的 ownerLabel 四支与 scenes.tsx:488-490/500-501，样板对齐
// adbCases.test.tsx:74/87（同一列在那边有钉）。行锁定一律 tr[data-row-key]（rowKey="id"），
// 防的是「名字恰好出现在页头/模块树栏」的假绿。各自的 fetch 桩在 it 内自带，不动共用 fixture。
const OUTSIDER = "3f2a9c81-77bd-4e6a-9d10-000000000000"; // 系统管理员式 uuid：slice(0,8)="3f2a9c81"

/** 行壳（rowKey="id" 落的 data-row-key）：列断言一律 within 它，行绑定不是「全局有这文字」。 */
function rowTr(id: string): HTMLElement {
  const tr = document.querySelector<HTMLElement>('tr[data-row-key="' + id + '"]');
  expect(tr).not.toBeNull();
  return tr as HTMLElement;
}

/** 负责人列专用桩：members 三态（有名/空表/500），其余路由与 mockRows 同法。 */
function mockOwnerView(items: Row[], members: "named" | "empty" | "fail"): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/members")) {
      if (members === "fail") {
        return { ok: false, status: 500, json: async () => ({
          code: "db_error", message: "成员表挂了", details: null,
        }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({
        items: members === "named" ? [{ user_id: "u1", account: "zhangsan", name: "张三" }] : [],
        next_cursor: null,
      }) } as unknown as Response;
    }
    const body = url.includes("/scenario-modules") ? { tree: [], recycled: [] }
      : url.includes("/envs?") ? { items: [], next_cursor: null }
      : { items, next_cursor: null };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("负责人列有值分支（ownerLabel 首次被喂进真数据）", () => {
  it("负责人列：成员表命中 owner_id=u1 → 那一列画「张三」，不是 id", async () => {
    mockOwnerView([scene({ owner_id: "u1" })], "named");
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    // members 是异步就绪（loading 帧画「…」），必须等 ready 帧
    await waitFor(() => expect(within(rowTr("s1")).queryByText("张三")).not.toBeNull());
    expect(rowTr("s1").textContent).not.toContain("…"); // 就绪后不许停在加载点
  });

  it("负责人列：owner_id 是成员表查不到的 uuid → 画「非项目成员 3f2a9c81」（短 id），不摊整串 uuid", async () => {
    mockOwnerView([scene({ owner_id: OUTSIDER })], "empty");
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    // 文案逐字抄 ownerName.ts:34「非项目成员 + ownerId.slice(0,8)」
    await waitFor(() =>
      expect(within(rowTr("s1")).queryByText("非项目成员 3f2a9c81")).not.toBeNull());
    expect(rowTr("s1").textContent).not.toContain(OUTSIDER); // uuid 摊出去就是 1C 量出的原缺陷
  });

  it("负责人列：成员表 500 → 画「名字未取到 3f2a9c81」，既失败就不许把 uuid 当名字、也不许判成「非项目成员」", async () => {
    mockOwnerView([scene({ owner_id: OUTSIDER })], "fail");
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    // 文案逐字抄 ownerName.ts:30「名字未取到 + slice(0,8)」：failed 与 ready-查不到两句话必须分开，
    // 混了就是把「拉挂了」谎称成「这人不在项目里」（比 uuid 更糟的误导）。
    await waitFor(() =>
      expect(within(rowTr("s1")).queryByText("名字未取到 3f2a9c81")).not.toBeNull());
    expect(rowTr("s1").textContent).not.toContain("非项目成员");
    expect(rowTr("s1").textContent).not.toContain(OUTSIDER);
  });
});

describe("模块列 Tag 有值分支（module_id 后端真填）", () => {
  /** 带指定模块树的桩：tree 供 moduleName 拍平（scenes.tsx:137-142 含 children 的 walk）。 */
  function mockModuleView(items: Row[], tree: unknown[]): void {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/scenario-modules") ? { tree, recycled: [] }
        : url.includes("/members") ? { items: [], next_cursor: null }
        : { items, next_cursor: null };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  const mod = (id: string, name: string) => ({
    id, parent_id: null, name, sort: 1, status: "normal", count: 0, children: [],
  });

  it("模块列：module_id=m1 且树里有 m1「订单域」→ 那一列画「订单域」，不画裸 id", async () => {
    mockModuleView([scene({ module_id: "m1" })], [mod("m1", "订单域")]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    // within(rowTr)：模块树侧栏也画「订单域」，全局查会把侧栏当列命中（假绿）
    expect(within(rowTr("s1")).getByText("订单域")).not.toBeNull();
    expect(rowTr("s1").textContent).not.toContain("m1");
  });

  it("模块列：module_id 在两棵树都查不到 → 画「已回收模块」，模块被回收后列表不许画裸 uuid", async () => {
    // 树刻意非空：树为空时 map 空集也能碰出回落，钉不出「查不到」这个语义
    mockModuleView([scene({ id: "s2", name: "孤儿场景", module_id: "m-zombie" })],
      [mod("m1", "订单域")]);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    expect(within(rowTr("s2")).getByText("已回收模块")).not.toBeNull();
    expect(rowTr("s2").textContent).not.toContain("m-zombie");
  });
});

// ── D180 切回收站的竞态窗口（scenes.tsx）────────────────────────────────────
// 点击同步翻 inRecycled（请求参数/新建闸），行要等下一次 list 回包才换。那一格里正常行
// 会挂上回收站模板：「删除人」把最后编辑人说成删除人，活行还长出 恢复/彻底删除
// （scenes.tsx 行内注释禁的正是这句谎）。普通跑法量不到：请求立刻回包，窗口合上。所以把
// 回收站那次 GET 挂成手工 deferred。
// 修法两半各自有腿：半 1 模板读 shownRecycled（①②③），半 2 行级 r.status（④）。
// D47-b 步5b 注：失败腿（②）从「留行 = 持久档」改成「清行」（陈旧行 + inRecycled 的
// 新请求是两把尺子）—— shownRecycled「失败不翻」的不变量原样保留，只是它守的谎面
// （留下的活行）随清行一起下桌了。
// 曾想再加一条「模块树选择也读 shownRecycled」：ownModuleIds 在选中的模块不在那棵树时返回
// null（= 不过滤），两种实现画出的行一模一样 → 那条永远杀不死变异，故不写。
describe("D180 切回收站：模板滞后于数据，不是滞后于点击", () => {
  const ok = (json: unknown, status = 200): Response =>
    ({ ok: status < 400, status, json: async () => json }) as unknown as Response;
  function deferredResp() {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((r) => { resolve = r; });
    return { promise, resolve };
  }
  /** 正常列表立即回包（行照带 updated_by_name/updated_at：钉的是渲染，不是数据缺席），
   *  回收站那次 GET 挂在 deferred 上，何时放行由用例决定。tree 给两个真模块供 ⑤ 用。
   *  liveRows 可换：⑥ 要的是「初始列表本来就空」那一格——表里有行时 antd 不渲染
   *  Empty，空态那条腿（scenes.tsx:472）在本文件里一次都没进过分支。 */
  function mockRacyList(itemsWithTree = true, liveRows: Row[] | null = null) {
    const dfd = deferredResp();
    const mod = (id: string, name: string) => ({
      id, parent_id: null, name, sort: 1, status: "normal", count: 0, children: [],
    });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/scenario-modules")) {
        return ok(itemsWithTree
          ? { tree: [mod("m1", "交易域"), mod("m2", "支付域")], recycled: [] }
          : { tree: [], recycled: [] });
      }
      if (url.includes("/members")) return ok({ items: [], next_cursor: null });
      if (url.includes("/envs?")) return ok({ items: [], next_cursor: null });
      if (url.includes("recycled=true")) return dfd.promise;
      return ok({ items: liveRows ?? [scene({ id: "s1", name: "活场景",
        updated_by: "u9", updated_by_name: "最后编辑的老李",
        updated_at: "2026-11-01T02:34:56+00:00" })], next_cursor: null });
    }) as unknown as typeof fetch;
    return dfd;
  }
  const recycledCalls = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes("/scenarios?") && String(c[0]).includes("recycled=true")).length;

  it("① 点回收站 + 列表在途：活行不提前挂回收站模板（无删除人列/无恢复彻底删除/不露 updated_by_name）", async () => {
    const dfd = mockRacyList();
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1)); // 显式前提：已在途
    expect(screen.queryByTestId("scene-recycled-by")).toBeNull();
    expect(screen.queryByTestId("scene-recycled-at")).toBeNull();
    expect(screen.queryByTestId("scene-restore")).toBeNull();
    expect(screen.queryByTestId("scene-purge")).toBeNull();
    expect(screen.queryByText("删除人")).toBeNull();
    // 「最后编辑的老李」在正常视图任何一列都不该露面；它一出现就是删除人列抢跑
    expect(document.body.textContent).not.toContain("最后编辑的老李");
    expect(document.body.textContent).not.toContain("回收站视图");
    // inRecycled 的本职不动：钮照实说「请求要什么」，不跟着模板滞后
    // 切换钮改为图标钮（2026-11-22 设计改版），文案搬到 aria-label；可访问名与语义不变。
    expect(screen.getByTestId("module-recycled-toggle").getAttribute("aria-label")).toBe("退出回收站");
    dfd.resolve(ok({ items: [], next_cursor: null })); // 放行：这时才许翻模板
    // 「回收站视图」只有列表那一栏会说（ModuleTree 不画它）；拿「回收站是空的」当闸门是假的——
    // 模块树那份在点击当场就成立（我的桩里 recycled 恒 []），慢网络下它会先绿，
    // 于是下一条断言赶在列表回包之前跑（本轮 R31 探针实测就是这么红的）。
    await waitFor(() => expect(document.body.textContent).toContain("回收站视图"));
  });

  it("② 点回收站 + 回 500（页码模式 = 清行）：活行下桌，模板与回收站字样都不翻，失败提示照常", async () => {
    // D47-b 步5b 改了失败语义（同 api.test.tsx 的 ②）：页码模式下失败清行清 total——
    // 陈旧行 + inRecycled 的新请求就是「我在第几页」的两把尺子。D180 的不变量仍然全在：
    // 模板只跟成功走——行没了，「回收站视图」字样、彻底删除/恢复两钮、「回收站是空的」
    // 空态一个都不许出现，谎面从根上没了。「失败不翻模板」这条腿由 ①③⑤ + 本条的
    // not.toContain 组合钉死，没有任何一条被静默删掉。
    const dfd = mockRacyList();
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(ok({ code: "db_error", message: "场景库挂了", details: null }, 500));
    await screen.findByTestId("scene-load-error");
    expect(document.body.textContent).toContain("场景库挂了");
    await waitFor(() => expect(screen.queryByTestId("scene-row-name")).toBeNull()); // 页码模式清行
    expect(screen.queryByTestId("scene-recycled-by")).toBeNull();
    expect(screen.queryByTestId("scene-purge")).toBeNull();
    expect(screen.queryByTestId("scene-restore")).toBeNull();
    expect(document.body.textContent).not.toContain("最后编辑的老李");
    expect(document.body.textContent).not.toContain("回收站视图");
    expect(document.body.textContent).not.toContain("回收站是空的"); // 失败不演空回收站
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
  });

  it("③ 成功落回回收站：删除人显人名、删除时间走 Asia/Shanghai、两钮都在（正向对照）", async () => {
    const dfd = mockRacyList();
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(ok({ items: [scene({ id: "s9", name: "被回收的场景", status: "recycled",
      updated_by: "u9", updated_by_name: "王小回收", updated_at: "2026-11-01T02:34:56+00:00" })],
    next_cursor: null }));
    await waitFor(() =>
      expect(screen.getByTestId("scene-recycled-by").textContent).toContain("王小回收"));
    expect(screen.getByTestId("scene-recycled-at").textContent).toContain("2026-11-01 10:34");
    expect(screen.getByTestId("scene-restore")).not.toBeNull();
    expect(screen.getByTestId("scene-purge")).not.toBeNull();
    expect(document.body.textContent).toContain("回收站视图");
  });

  it("④ 混合数据正对照：回收批次里混 status:normal 的行 → 该行无删除人、无彻底删除，只有正常视图的把手", async () => {
    // 后端正常不给混合数据（list 按 status 过滤），这条钉的是半 2：行身份逐行认 r.status。
    const dfd = mockRacyList();
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await screen.findByTestId("scene-row-name");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(ok({ items: [
      scene({ id: "s-real", name: "真回收行", status: "recycled",
        updated_by: "u9", updated_by_name: "王小回收" }),
      scene({ id: "s-mixed", name: "混进来的活行", status: "normal",
        updated_by: "u9", updated_by_name: "最后编辑的老李" }),
    ], next_cursor: null }));
    await waitFor(() => expect(screen.getByTestId("scene-recycled-by").textContent).toContain("王小回收"));
    expect(within(rowTr("s-real")).queryByTestId("scene-purge")).not.toBeNull();
    // 活行那一格：既没有删除人单元格，也不许长彻底删除/恢复
    expect(within(rowTr("s-mixed")).queryByTestId("scene-recycled-by")).toBeNull();
    expect(within(rowTr("s-mixed")).queryByTestId("scene-purge")).toBeNull();
    expect(within(rowTr("s-mixed")).queryByTestId("scene-restore")).toBeNull();
    expect(within(rowTr("s-mixed")).getByText("混进来的活行")).not.toBeNull();
  });

  it("⑤ 空态那条腿：项目里本来就没场景 + 回收站请求在途 → 空态说「还没有场景」，不说「回收站是空的」", async () => {
    // 第三十四轮补的腿：s1 变异（空态模板从 shownRecycled 退回 inRecycled）在本文件里
    // 曾经杀不死——上面几条的初始列表恒带一行活场景，antd 有行就不渲染 Empty，那条腿
    // 一次都没进过分支。要量到它必须让**初始**列表就是空的。
    // 这一格是真的：空项目点回收站、回包未到，此刻屏上没有任何回收行，
    // 「回收站是空的」是把「还没取到」说成「取到了、是空」（同族规则③）。
    const dfd = mockRacyList(true, []);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitFor(() => expect(recycledCalls()).toBe(0));
    const emptyDesc = () => document
      .querySelector(".ant-table-placeholder .ant-empty-description")?.textContent ?? "";
    expect(emptyDesc()).toContain("还没有场景");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1)); // 已在途
    expect(emptyDesc()).not.toContain("回收站是空的");
    // 正对照：真的取回空回收站之后，同一句必须改口——否则这条腿会变成「永远不说」
    dfd.resolve(ok({ items: [], next_cursor: null }));
    await waitFor(() => expect(emptyDesc()).toContain("回收站是空的"));
  });

});

// ── D133：导出成功的 toast 不许被固定快照说明染成 warning ────────────────────────
// 后端只要导出过就固定追加「本导出是只读备份快照…」一条（scenario/export_services.py:123-126），
// 旧前端拿 notes.length>0 当「有问题」的尺子 → 干净的成功永远出 warning。
// 新口径：固定说明按内容开头排除，剩下的逐条问题 note（图校验/跨域引用）才配 warning。
describe("D133 导出 toast：成功是 success，问题才 warning", () => {
  const SNAPSHOT_NOTE = "本导出是只读备份快照：module_id/env_id 为平台内部 id，换项目/换平台后不自动成立；不可回灌（如实报）";
  const OUT_WITH_NOTE = {
    scenarios: [{
      scenario_id: "s1", name: "履约回归", priority: "P2", module_id: null,
      step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true,
      max_runtime_ms: null, common_assertions: [], env_id: null, project_public: true,
      validation: [], refs: [],
    }],
    exported: 1, notes: [SNAPSHOT_NOTE],
  };
  function stubDownload(): void {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    (URL as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
  }
  async function clickExport(): Promise<void> {
    await screen.findByTestId("scene-row-name");
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('.ant-table-tbody input[type="checkbox"]'));
    fireEvent.click(boxes[0]);
    await screen.findByTestId("scene-batch-bar");
    fireEvent.click(screen.getByTestId("scene-batch-export"));
  }

  it("notes 只有固定快照说明 → success 报「已导出」，不出 warning（后端必附这条）", async () => {
    const okSpy = vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    const warnSpy = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    stubDownload();
    vi.spyOn(sceneApi, "export").mockResolvedValue(OUT_WITH_NOTE);
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await clickExport();
    await waitFor(() => expect(okSpy).toHaveBeenCalled());
    expect(String(okSpy.mock.calls[0][0])).toContain("已导出 1 条（只读备份快照，当前无导入可回灌）");
    expect(warnSpy).not.toHaveBeenCalled();
    okSpy.mockRestore(); warnSpy.mockRestore();
  });

  it("固定说明 + 真问题 note 同车 → warning 只列问题那条，条数不把说明算进问题", async () => {
    const okSpy = vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    const warnSpy = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    stubDownload();
    vi.spyOn(sceneApi, "export").mockResolvedValue({
      ...OUT_WITH_NOTE,
      notes: ["「履约回归」含 2 个跨域引用步骤（如实报）", SNAPSHOT_NOTE],
    });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await clickExport();
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain("「履约回归」含 2 个跨域引用步骤");
    expect(msg).not.toContain(SNAPSHOT_NOTE); // 固定说明不摊进问题清单
    expect(msg).toContain("1 条问题说明");
    expect(okSpy).not.toHaveBeenCalled();
    okSpy.mockRestore(); warnSpy.mockRestore();
  });
});

// ── sceneApi.list 的 module_ids 入参契约（api/scene.ts 直接进 fetch 的那一层）──────
// 页面级 ⑤ 只发一个模块 id：`String(["m-a"]) === "m-a"` 与逐个 append 在 URL 上不可区分，
// 逗号拼接变异（qs 的 set(k, String(v)) 对数组的行为——["a","b"] 拼成 "a,b"，后端
// list[str] 解成**一个**值 ["a,b"]：一个模块都匹配不上、列表空且不报错的静默错）在页面级
// 杀不死。这条从 api 层直接钉「请求串上 module_ids 键出现几次、值分别是什么」
// （new URLSearchParams(url.split("?")[1]).getAll("module_ids")），两个 id 一上逗号必红。
describe("sceneApi.list 的 module_ids 是重复 query 键（逗号拼接是静默错）", () => {
  function captureFetch(): string[] {
    const seen: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { ok: true, status: 200,
        json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return seen;
  }

  it("module_ids=[m1,m2] → module_ids 键恰好出现 2 次、值按序 m1/m2，串上无逗号编码", async () => {
    const seen = captureFetch();
    await sceneApi.list({ project_id: "p1", size: 20, current: 1, module_ids: ["m1", "m2"] });
    expect(seen).toHaveLength(1);
    const q = new URLSearchParams(seen[0].split("?")[1]);
    expect(q.getAll("module_ids")).toEqual(["m1", "m2"]);
    expect(seen[0]).not.toContain("%2C"); // 逗号编码 = 拼接变异走私上了线
    // 标量照常在线、空数组 = 不发（不挂空键）
    expect(q.get("current")).toBe("1");
    const seen2 = captureFetch();
    await sceneApi.list({ project_id: "p1", size: 20, current: 1, module_ids: [] });
    expect(new URLSearchParams(seen2[0].split("?")[1]).getAll("module_ids")).toEqual([]);
  });
});
// ── D134：空态按真实筛选态归因（D47-b 步5b：归因读**已提交**的 kw，桩真按 keyword/
// module_ids 过滤——行集与归因一起对，桩与页面不许各滤各的）──────────────────────
describe("D134 空态按真实筛选态归因（scenes.tsx）", () => {
  const emptyDesc = () => document
    .querySelector(".ant-table-placeholder .ant-empty-description")?.textContent ?? "";
  async function selectModule(name: string): Promise<void> {
    const title = await waitFor(() => {
      const t = Array.from(document.querySelectorAll(".ant-tree-title"))
        .find((n) => (n.textContent ?? "").includes(name));
      if (!t) throw new Error("树里还没有「" + name + "」");
      return t;
    });
    fireEvent.click(title.closest(".ant-tree-node-content-wrapper") as HTMLElement);
  }
  // 行是未分类（module_id=null）：选中 m1「空的模块」后桩按重复键过滤 → 行集为空
  const TREE: ServerTree[] = [{ id: "m1", parent_id: null, name: "空的模块", sort: 0,
    status: "normal", count: 0, children: [] }];

  it("只选模块、没提交关键词：怪模块不怪关键词（桩真按 module_ids 过滤）", async () => {
    sceneServer([scene({ module_id: null })], { tree: TREE });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(1);
    await selectModule("空的模块");
    await waitFor(() => expect(screen.queryByTestId("scene-row-name")).toBeNull());
    expect(emptyDesc()).toBe("这个模块下没有场景（换个模块或看「未分类」）");
    expect(document.body.textContent).not.toContain("没有匹配的场景");
  });

  it("有关键词时仍怪关键词：模块半句不许抢走关键词半句（提交后才换归因）", async () => {
    sceneServer([scene({ module_id: null })], { tree: TREE });
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(1);
    const search = screen.getByTestId("scene-search");
    fireEvent.change(search, { target: { value: "查无此景" } });
    pressEnter(search); // 服务端契约：提交才换行集（打字零请求）
    await waitFor(() => expect(screen.queryByTestId("scene-row-name")).toBeNull());
    expect(emptyDesc()).toBe("没有匹配的场景，换个关键词试试");
    expect(document.body.textContent).not.toContain("这个模块下没有场景");
  });
});

// ── D214：场景列表高级搜索 / 列设置（D47-a 三件套铺到场景页）────────────────────
describe("D214 场景列表高级搜索 / 列设置", () => {
  const listUrls: string[] = [];
  function mockD214(): void {
    listUrls.length = 0;
    const resp = (json: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/scenario-modules")) return resp({ tree: [], recycled: [] });
      if (url.includes("/members") || url.includes("/envs?")) return resp({ items: [], next_cursor: null });
      if (url.includes("/filter-meta")) {
        return resp({
          view_type: "scenario",
          fields: [
            { field: "name", label: "场景名称", kind: "text",
              ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"] },
            { field: "priority", label: "优先级", kind: "enum",
              ops: ["IN", "NOT_IN", "EQUALS", "NOT_EQUALS", "EMPTY", "NOT_EMPTY"] },
          ],
          supported_view_types: ["scenario"],
          unavailable: {},
        });
      }
      if (url.includes("/saved-views")) return resp([]);
      if (/\/scenarios\?/.test(url)) {
        listUrls.push(url);
        return resp({ items: [scene()], next_cursor: null, total: 1 });
      }
      return resp({ items: [], next_cursor: null });
    }) as unknown as typeof fetch;
  }
  const sentFilter = (url: string) => {
    const raw = new URL(url, "http://x").searchParams.get("filter");
    return raw === null ? null : JSON.parse(raw);
  };

  it("空条件不拼 filter；应用「名称包含 履约」后下一次列表请求带条件 JSON", async () => {
    mockD214();
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(1);
    expect(sentFilter(listUrls[0])).toBeNull();
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const row = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(row).getByTestId("lt-val-text"), { target: { value: "履约" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listUrls.length).toBe(2));
    expect(sentFilter(listUrls[1])).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "履约" }],
    });
  });

  it("列设置勾掉「优先级」只藏那一列（其余表头原样）", async () => {
    localStorage.clear();
    mockD214();
    render(<MemoryRouter><ScenesPage /></MemoryRouter>);
    await waitForRows(1);
    const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("优先级");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "模块", "优先级", "最近结果", "步骤数", "定时", "负责人", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("优先级")]);
    await waitFor(() => expect(thead()).not.toContain("优先级"));
    expect(thead()).toContain("步骤数");
  });
});
