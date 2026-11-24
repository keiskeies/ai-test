// 功能用例页（D193）组件测试：列表/模块树/新建 body/删除/只读门。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;
// 导出会走 downloadBlob：jsdom 没有 createObjectURL/revokeObjectURL，桩掉（同 api.test.tsx）。
URL.createObjectURL = vi.fn(() => "blob:fake") as unknown as typeof URL.createObjectURL;
URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;

import FunctionalCasesPage from "./functionalCases";
import { Modal } from "antd";
import { useAuth } from "../auth/store";
import type { CaseRow } from "../api/functional";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

function row(id: string, over: Partial<CaseRow> = {}): CaseRow {
  return {
    id, num: id === "c1" ? 100001 : 100002, project_id: "p1", module_id: "m1",
    template_id: "tpl1", name: "用例" + id, priority: "P2", description: null,
    precondition: null, steps: [], remark: null, case_status: "prepare",
    recycled: false, custom_fields: {},
    owner_id: null, owner_name: null, tags: [],
    created_by: "u1", created_by_name: "张三",
    updated_by: "u1", updated_by_name: "张三",
    created_at: "2026-11-23T10:00:00+08:00", updated_at: "2026-11-23T10:00:00+08:00", ...over,
  };
}
const ROWS = [
  row("c1", { name: "登录成功", priority: "P0", owner_id: "u2", owner_name: "李四",
    tags: ["回归", "核心", "冒烟"],
    precondition: "已登录", steps: [{ desc: "点登录", expected: "进入首页" }],
    remark: "冒烟必跑", case_status: "underway" }),
  row("c2", { name: "登录失败", module_id: null }),
];

const calls: { url: string; method: string; body: unknown }[] = [];

// D219：功能用例页工具栏要的 /filter-meta（形状与后端 filter_registry 一致）。
// supported_view_types 必须含 functional_case，否则工具栏按「本页不支持」画——
// 那会把「桩没 mock 到」演成「功能不存在」。
const FC_META = {
  view_type: "functional_case",
  fields: [
    { field: "name", label: "用例名称", kind: "text",
      ops: ["CONTAINS", "EQUALS", "IN", "NOT_CONTAINS", "NOT_EQUALS", "NOT_IN"] },
    { field: "priority", label: "优先级", kind: "enum",
      ops: ["EMPTY", "EQUALS", "IN", "NOT_EQUALS", "NOT_EMPTY"] },
  ],
  supported_view_types: ["functional_case"],
  view_label: "功能用例",
  operators: [], labels: {}, kinds: {}, unavailable: {},
};

/** 从列表 URL 取 query（同 adbCases.test.tsx 的取法）。 */
function qsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

function mockBackend(): void {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.includes("/projects/p1/members")) {
      return resp(200, { items: [{ user_id: "u2", account: "li", name: "李四" }] });
    }
    if (url.includes("/filter-meta")) return resp(200, FC_META);
    if (url.includes("/saved-views")) return resp(200, []);
    if (url.includes("/functional-modules/tree") && method === "GET") {
      return resp(200, { tree: [{ id: "m1", parent_id: null, name: "登录模块", sort: 0,
        status: "normal", case_count: 1, children: [] }], recycled: [] });
    }
    // D268：脑图抽屉一开就拉整棵树（模块 + 便签 + 用例叶）。
    if (url.includes("/functional-minder") && method === "GET") {
      return resp(200, {
        project_id: "p1",
        nodes: [{ id: "m1", kind: "module", name: "登录模块", parent_id: null, sort: 0,
          case_count: 1, cases: [{ id: "c1", num: 100001, name: "登录成功", priority: "P0" }],
          children: [] }],
        unfiled_cases: [], total_cases: 1,
      });
    }
    if (url.includes("/templates?") && method === "GET") {
      return resp(200, { items: [{ id: "tpl1", project_id: "p1", scene: "functional",
        name: "系统默认（功能用例）", description: null, internal: true, is_default: true,
        sort: 0, field_count: 0, created_at: null, updated_at: null }] });
    }
    if (/\/templates\/tpl1(\?|$)/.test(url) && method === "GET") {
      return resp(200, { id: "tpl1", project_id: "p1", scene: "functional",
        name: "系统默认（功能用例）", description: null, internal: true, is_default: true,
        sort: 0, field_count: 0, created_at: null, updated_at: null, fields: [] });
    }
    if (url.includes("/functional-cases/export") && method === "GET") {
      return { ok: true, status: 200, blob: async () => new Blob(["x"]),
        json: async () => ({}) } as unknown as Response;
    }
    // D277：当前页评审/执行结论批量投影（c1 有评审+执行，c2 两件都没发生过）
    if (url.includes("/functional-case-summary-batch") && method === "POST") {
      const ids = (body as { case_ids: string[] }).case_ids;
      return resp(200, { items: ids.map((id) => id === "c1"
        ? { case_id: id, review_result: "pass", review_name: "初评",
            exec_result: "blocked", exec_at: "2026-01-01T00:00:00Z" }
        : { case_id: id, review_result: null, review_name: null,
            exec_result: null, exec_at: null }), total: ids.length });
    }
    if (/\/functional-cases\?/.test(url) && method === "GET") {
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const recycled = q.get("recycled") === "true";
      const items = recycled ? ROWS.map((r) => ({ ...r, recycled: true })) : ROWS;
      return resp(200, { items, next_cursor: null, total: items.length });
    }
    if (/\/functional-cases\/stats$/.test(url) && method === "POST") {
      // D236：分组轴由请求 body 决定，mock 跟着变——这样测试能证明「切换轴会重取」。
      const groupBy = (body as { group_by?: string }).group_by ?? "priority";
      const groups = groupBy === "module"
        ? [
          { key: "m1", label: "登录模块", count: 1 },
          { key: "", label: "未分类", count: 1 },
        ]
        : groupBy === "creator"
          ? [{ key: "u1", label: "张三", count: 2 }]
          : groupBy === "owner"
            ? [{ key: "u2", label: "李四", count: 1 }, { key: "", label: "—", count: 1 }]
            : [
            { key: "P0", label: "P0", count: 1 },
            { key: "P1", label: "P1", count: 0 },
            { key: "P2", label: "P2", count: 1 },
            { key: "P3", label: "P3", count: 0 },
          ];
      return resp(200, {
        total: 2, recycled_total: 0, group_by: groupBy, groups,
      });
    }
    if (url.endsWith("/functional-cases") && method === "POST") {
      return resp(201, { ...row("c9"), ...body });
    }
    // D289：编辑用例（PATCH 带 *_set 哨兵）；回执按请求覆盖，前端只看成功/失败
    if (/\/functional-cases\/c1$/.test(url) && method === "PATCH") {
      return resp(200, { ...row("c1"), ...body });
    }
    if (/\/functional-cases\/batch-update$/.test(url) && method === "POST") {
      return resp(200, { ok: true, affected: (body.case_ids as string[]).length });
    }
    if (/\/functional-cases\/batch-restore$/.test(url) && method === "POST") {
      // D253：后端是「能恢复的都恢复」，affected 可能小于勾选数——mock 按请求原样回
      return resp(200, { ok: true, affected: (body.case_ids as string[]).length });
    }
    if (/\/functional-cases\/batch-purge$/.test(url) && method === "POST") {
      return resp(200, { ok: true, affected: (body.case_ids as string[]).length });
    }
    if (/\/functional-cases\/batch-copy$/.test(url) && method === "POST") {
      return resp(200, { ok: true, affected: (body.case_ids as string[]).length, case_ids: [] });
    }
    if (/\/functional-cases\/c1\/(un)?follow$/.test(url) && method === "POST") {
      const unfollow = /unfollow$/.test(url);
      return resp(200, { following: !unfollow, follower_count: unfollow ? 0 : 1 });
    }
    if (/\/functional-cases\/c1\/delete$/.test(url) && method === "POST") {
      return resp(200, { ok: true, affected: 1 });
    }
    if (/\/functional-cases\/c1\/restore$/.test(url) && method === "POST") {
      return resp(200, { ...row("c1"), recycled: false });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

// D253：批量恢复用 Modal.confirm（静态挂在 body，cleanup 收不走），每个用例后清一次，
// 否则下一个用例的 findByRole("dialog") 会摸到上一张残留弹窗。
afterEach(() => { Modal.destroyAll(); cleanup(); });
beforeEach(() => {
  cleanup();
  localStorage.clear();
  mockBackend();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

function renderPage(): void {
  render(<MemoryRouter><FunctionalCasesPage /></MemoryRouter>);
}

describe("功能用例列表", () => {
  it("渲染模块树、用例行与总条数", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(screen.getAllByText("登录模块").length).toBeGreaterThan(0);
    expect(screen.getByTestId("list-pager").textContent).toContain("共 2 条");
    expect(screen.getByTestId("fc-new")).toBeTruthy();
  });

  it("D277 评审/执行两列：一次批量；从未发生画「未评审/未执行」而不是「未通过」", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("fc-review-c1").textContent).toBe("通过"));
    expect(screen.getByTestId("fc-exec-c1").textContent).toBe("阻塞");
    // c2 从未评审/执行：画「未评审/未执行」，不把没发生过的画成未通过
    expect(screen.getByTestId("fc-review-c2").textContent).toBe("未评审");
    expect(screen.getByTestId("fc-exec-c2").textContent).toBe("未执行");
    const batches = calls.filter((c) => c.url.includes("/functional-case-summary-batch"));
    expect(batches).toHaveLength(1);
  });

  it("新建：POST body 带模板与自定义值", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-new"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/templates?"))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/templates/tpl1"))).toBe(true));
    fireEvent.change(screen.getByTestId("fc-field-name"), { target: { value: "新用例" } });
    fireEvent.click(screen.getByTestId("fc-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/functional-cases"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1", name: "新用例", priority: "P2",
        template_id: "tpl1", custom_fields: {}, module_id: null, owner_id: null, tags: [],
      });
    });
  });

  it("删除：POST + body", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getAllByTestId("fc-del")[0]);
    const ok = await screen.findByRole("button", { name: "放入回收站" });
    fireEvent.click(ok);
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/functional-cases\/c1\/delete$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", case_id: "c1" });
    });
  });

  it("D268：点「脑图」开抽屉，按 project_id 拉脑图并画出用例叶", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(calls.some((c) => c.url.includes("/functional-minder"))).toBe(false);  // 不开抽屉不发请求
    fireEvent.click(screen.getByTestId("fc-mind"));
    await waitFor(() => expect(screen.getByTestId("minder-module-m1")).toBeTruthy());
    const req = calls.find((c) => c.method === "GET" && c.url.includes("/functional-minder"));
    expect(req).toBeTruthy();
    expect(req!.url).toContain("project_id=p1");
    expect(screen.getByTestId("minder-case-c1").textContent).toContain("登录成功");
  });

  it("READONLY：新建/删除/编辑不在 DOM", async () => {
    useAuth.setState({ project: READONLY });
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(screen.queryByTestId("fc-new")).toBeNull();
    expect(screen.queryByTestId("fc-del")).toBeNull();
    expect(screen.queryByTestId("fc-edit")).toBeNull();
  });

  it("D219 空条件不拼 filter；应用「用例名称包含 登录」后下一次列表请求带条件 JSON", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const listUrls = (): string[] => calls.filter((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)).map((c) => c.url);
    expect(qsOf(listUrls()[0]).has("filter")).toBe(false); // 空条件整个参数不上线（不是 filter=）
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listUrls().length).toBe(2));
    // 字段名来自后端 meta 的第一项（name），前端不自列字段
    expect(JSON.parse(qsOf(listUrls()[1]).get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "登录" }],
    });
  });

  it("D219 列设置勾掉「自定义字段」只藏那一列（其余表头原样）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const thead = (): string => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("自定义字段");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["编号", "名称", "评审结果", "标签", "优先级", "模块", "用例描述",
      "执行结果", "责任人", "自定义字段", "更新人", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("自定义字段")]);
    await waitFor(() => expect(thead()).not.toContain("自定义字段"));
    expect(thead()).toContain("优先级");
  });
});

// ── D232：功能用例批量编辑（优先级 / 模块） ────────────────────────────────
const visibleOptions = (): HTMLElement[] => Array.from(document.querySelectorAll(
  ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")) as HTMLElement[];

/** 打开某个 Select 并点选文案与 label 完全一致的选项（模糊匹配会撞上「不修改模块」）。 */
async function pick(testid: string, label: string): Promise<void> {
  fireEvent.mouseDown(screen.getByTestId(testid).querySelector(".ant-select-selector")!);
  await waitFor(() => expect(visibleOptions().some((o) => (o.textContent ?? "") === label)).toBe(true));
  fireEvent.click(visibleOptions().find((o) => (o.textContent ?? "") === label)!);
}

const rowBoxes = (): HTMLInputElement[] =>
  Array.from(document.querySelectorAll(".ant-table-tbody input[type='checkbox']")) as HTMLInputElement[];

async function selectFirstTwoRows(): Promise<void> {
  await waitFor(() => expect(rowBoxes().length).toBe(2));
  fireEvent.click(rowBoxes()[0]);
  fireEvent.click(rowBoxes()[1]);
  await waitFor(() => expect(screen.getByTestId("fc-batch-edit").textContent).toContain("2"));
}

describe("D232 批量编辑", () => {
  it("勾选两条改优先级+未分类：body 带 module_set 与 module_id=null，成功后话术与刷新", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const listUrls = (): string[] => calls.filter((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)).map((c) => c.url);
    const before = listUrls().length;

    await selectFirstTwoRows();
    fireEvent.click(screen.getByTestId("fc-batch-edit"));
    await waitFor(() => expect(screen.getByText("批量编辑 2 条用例")).toBeTruthy());
    await pick("fc-batch-priority", "P1");
    await pick("fc-batch-module", "未分类");
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));

    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/functional-cases\/batch-update$/.test(x.url));
      expect(c).toBeTruthy();
      // 精确相等：未选的字段不能混进 body（后端 module_id 缺省 vs null 靠 module_set 区分）
      expect(c!.body).toEqual({
        project_id: "p1", case_ids: ["c1", "c2"],
        priority: "P1", module_set: true, module_id: null,
      });
    });
    expect(await screen.findByText("已更新 2 条")).toBeTruthy();
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(before));
  });

  it("只改优先级：body 不含 module_set / module_id", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    await selectFirstTwoRows();
    fireEvent.click(screen.getByTestId("fc-batch-edit"));
    await waitFor(() => expect(screen.getByText("批量编辑 2 条用例")).toBeTruthy());
    await pick("fc-batch-priority", "P0");
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/functional-cases\/batch-update$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", case_ids: ["c1", "c2"], priority: "P0" });
    });
  });

  it("两个字段都不选：前端拦住，不发请求（后端会 422 empty_update）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    await selectFirstTwoRows();
    fireEvent.click(screen.getByTestId("fc-batch-edit"));
    await waitFor(() => expect(screen.getByText("批量编辑 2 条用例")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    expect(await screen.findByText("至少选择优先级或模块")).toBeTruthy();
    expect(calls.some((x) => x.url.includes("/batch-update"))).toBe(false);
  });

  it("READONLY 无勾选列；回收站有勾选（批量恢复）但没有批量编辑按钮", async () => {
    useAuth.setState({ project: READONLY });
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(rowBoxes().length).toBe(0);
    expect(screen.queryByTestId("fc-batch-edit")).toBeNull();

    // 换回写位：回收站视图现在可勾选（D253 批量恢复），但批量编辑/复制仍只属于正常视图
    cleanup();
    useAuth.setState({ project: PROJECT });
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-recycled"));
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && /recycled=true/.test(c.url))).toBe(true));
    await waitFor(() => expect(screen.getByText(/退出回收站/)).toBeTruthy());
    expect(rowBoxes().length).toBe(2);
    expect(screen.queryByTestId("fc-batch-edit")).toBeNull();
    expect(screen.queryByTestId("fc-copy")).toBeNull();
  });
});

// ── D233：功能用例批量复制 ──────────────────────────────────────────────────
describe("D233 批量复制", () => {
  it("勾选两条复制到未分类：body 带 module_set 与 module_id=null，成功后话术与刷新", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const listUrls = (): string[] => calls.filter((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)).map((c) => c.url);
    const before = listUrls().length;

    await selectFirstTwoRows();
    fireEvent.click(screen.getByTestId("fc-copy"));
    await waitFor(() => expect(screen.getByText("批量复制 2 条用例")).toBeTruthy());
    await pick("fc-copy-module", "未分类");
    const modal = screen.getByText("批量复制 2 条用例").closest(".ant-modal") as HTMLElement;
    fireEvent.click(within(modal).getByRole("button", { name: /复\s*制/ }));

    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/functional-cases\/batch-copy$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({
        project_id: "p1", case_ids: ["c1", "c2"],
        name_suffix: "（副本）", module_set: true, module_id: null,
      });
    });
    expect(await screen.findByText("已复制 2 条")).toBeTruthy();
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(before));
  });

  it("默认保持原模块 + 后缀留空：body 不含 module_set，name_suffix 为空串", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    await selectFirstTwoRows();
    fireEvent.click(screen.getByTestId("fc-copy"));
    await waitFor(() => expect(screen.getByText("批量复制 2 条用例")).toBeTruthy());
    fireEvent.change(screen.getByTestId("fc-copy-suffix"), { target: { value: "" } });
    const modal = screen.getByText("批量复制 2 条用例").closest(".ant-modal") as HTMLElement;
    fireEvent.click(within(modal).getByRole("button", { name: /复\s*制/ }));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/functional-cases\/batch-copy$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", case_ids: ["c1", "c2"], name_suffix: "" });
    });
  });

  it("READONLY 与回收站视图：没有批量复制按钮", async () => {
    useAuth.setState({ project: READONLY });
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(screen.queryByTestId("fc-copy")).toBeNull();
    expect(rowBoxes().length).toBe(0);

    cleanup();
    useAuth.setState({ project: PROJECT });
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-recycled"));
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && /recycled=true/.test(c.url))).toBe(true));
    expect(screen.queryByTestId("fc-copy")).toBeNull();
  });
});

// ── D234：功能用例关注 ──────────────────────────────────────────────────────
describe("D234 关注", () => {
  it("点星标关注只改本行（不整页重取），body 是 project_id+case_id", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const listUrls = (): string[] => calls.filter((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)).map((c) => c.url);
    const before = listUrls().length;
    const star = (): HTMLElement => screen.getByTestId("fc-follow-c1");
    expect(star().getAttribute("data-followed")).toBe("0");

    fireEvent.click(star());
    await waitFor(() => expect(star().getAttribute("data-followed")).toBe("1"));
    const c = calls.find((x) => x.method === "POST" && /\/functional-cases\/c1\/follow$/.test(x.url));
    expect(c).toBeTruthy();
    expect(c!.body).toEqual({ project_id: "p1", case_id: "c1" });
    expect(listUrls().length).toBe(before); // 只改本行：不触发整页请求
  });

  it("「我关注的」是后端视图轴：开关前后列表 URL 的 followed_by_me 参数如实", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const listUrls = (): string[] => calls.filter((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)).map((c) => c.url);
    expect(qsOf(listUrls()[0]).has("followed_by_me")).toBe(false);

    fireEvent.click(screen.getByTestId("fc-followed-only"));
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(1));
    expect(qsOf(listUrls()[listUrls().length - 1]).get("followed_by_me")).toBe("true");

    fireEvent.click(screen.getByTestId("fc-followed-only"));
    await waitFor(() => expect(qsOf(listUrls()[listUrls().length - 1]).has("followed_by_me")).toBe(false));
  });

  it("READONLY：没有星标（写位），但「我关注的」读视图仍在", async () => {
    useAuth.setState({ project: READONLY });
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(screen.queryByTestId("fc-follow-c1")).toBeNull();
    expect(screen.getByTestId("fc-followed-only")).toBeTruthy();
  });
});

// ── D235：导出与列表同一把尺 + 导出所选 ─────────────────────────────────────
describe("D235 导出范围", () => {
  const exportUrls = (): string[] => calls.filter((c) =>
    c.method === "GET" && c.url.includes("/functional-cases/export")).map((c) => c.url);

  it("高级搜索生效后「导出」带上同一份条件，不带 ids", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(calls.filter((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)).length).toBeGreaterThan(1));

    fireEvent.click(screen.getByTestId("fc-export"));
    await waitFor(() => expect(exportUrls().length).toBe(1));
    const q = qsOf(exportUrls()[0]);
    expect(JSON.parse(q.get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "登录" }],
    });
    expect(q.has("ids")).toBe(false);
  });

  it("勾选后出现「导出所选（2）」，URL 带 ids=c1,c2 且不带高级条件", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(screen.queryByTestId("fc-export-selected")).toBeNull();

    await selectFirstTwoRows();
    expect(screen.getByTestId("fc-export-selected").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("fc-export-selected"));
    await waitFor(() => expect(exportUrls().length).toBe(1));
    const q = qsOf(exportUrls()[0]);
    expect(q.get("ids")).toBe("c1,c2");
    expect(q.has("filter")).toBe(false);
  });

  it("「我关注的」开着导出时，URL 带 followed_by_me=true（所见即所得）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-followed-only"));
    await waitFor(() => expect(calls.some((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)
      && qsOf(c.url).get("followed_by_me") === "true")).toBe(true));
    fireEvent.click(screen.getByTestId("fc-export"));
    await waitFor(() => expect(exportUrls().length).toBe(1));
    expect(qsOf(exportUrls()[0]).get("followed_by_me")).toBe("true");
  });
});

// ── D236：功能用例统计 ──────────────────────────────────────────────────────
describe("D236 统计", () => {
  const statCalls = (): { url: string; method: string; body: unknown }[] => calls.filter((c) =>
    c.method === "POST" && /\/functional-cases\/stats$/.test(c.url));

  it("点「统计」按优先级取数：body 带当前视图，弹层里四档全在", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-stats"));
    await waitFor(() => expect(statCalls().length).toBe(1));
    expect(statCalls()[0].body).toEqual({
      project_id: "p1", group_by: "priority", recycled: false,
    });
    await waitFor(() => expect(screen.queryByTestId("fc-stats-total")).toBeTruthy());
    await waitFor(() => expect(
      screen.getByTestId("fc-stats-total").textContent).toContain("共 2 条"));
    const rows = (await screen.findAllByTestId("fc-stats-row")).map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(4); // 没有用例的 P1/P3 也列出（横轴不变形）
    expect(rows[0]).toContain("P0");
    expect(rows[1]).toContain("0");
  });

  it("切换分组轴会带新 group_by 重取，模块轴含「未分类」", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-stats"));
    await waitFor(() => expect(statCalls().length).toBe(1));

    await pick("fc-stats-groupby", "模块");
    await waitFor(() => expect(statCalls().length).toBe(2));
    expect(statCalls()[1].body).toMatchObject({ project_id: "p1", group_by: "module" });
    await waitFor(() => {
      const text = screen.getAllByTestId("fc-stats-row").map((r) => r.textContent ?? "").join("|");
      expect(text).toContain("登录模块");
      expect(text).toContain("未分类");
    });
  });

  it("回收站视图里统计范围跟随视图（recycled=true）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-recycled"));
    await waitFor(() => expect(screen.getByText(/退出回收站/)).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-stats"));
    await waitFor(() => expect(statCalls().length).toBe(1));
    expect(statCalls()[0].body).toMatchObject({ recycled: true });
    expect(screen.getByText(/统计范围：回收站/)).toBeTruthy();
  });
});

// D253：回收站批量恢复——后端 /functional-cases/batch-restore 早就在，
// 缺的是「回收站里也能勾行 + 一根按钮线」。钉住 body 与「跳过数如实报」。
describe("D253 回收站批量恢复", () => {
  const restoreCalls = () => calls.filter(
    (c) => c.method === "POST" && /functional-cases\/batch-restore/.test(c.url));

  it("回收站勾 2 条 → 确认 → POST 带 ids，成功后清选择并重拉", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-recycled"));
    await waitFor(() => expect(screen.getByText(/退出回收站/)).toBeTruthy());
    const recycledGets = () => calls.filter(
      (c) => c.method === "GET" && /recycled=true/.test(c.url)).length;
    const before = recycledGets();

    await waitFor(() => expect(rowBoxes().length).toBe(2));
    fireEvent.click(rowBoxes()[0]);
    fireEvent.click(rowBoxes()[1]);
    fireEvent.click(await screen.findByTestId("fc-batch-restore"));
    await screen.findAllByText(/恢复所选 2 条用例/);
    // 静态 confirm 的按钮取「最后一组 confirm 的主按钮」——同套件里若残留别的弹窗，
    // 按 role=dialog 摸到的可能是它，按文案找按钮又会撞 antd 的两字插空格。
    const okBtns = Array.from(document.querySelectorAll(
      ".ant-modal-confirm-btns .ant-btn-primary")) as HTMLElement[];
    fireEvent.click(okBtns[okBtns.length - 1]);

    await waitFor(() => expect(restoreCalls().length).toBe(1));
    expect(restoreCalls()[0].body).toMatchObject({ project_id: "p1", case_ids: ["c1", "c2"] });
    // 成功后选择清空（按钮随选择出现/消失），列表与模块树都重拉
    await waitFor(() => expect(screen.queryByTestId("fc-batch-restore")).toBeNull());
    await waitFor(() => expect(recycledGets()).toBeGreaterThan(before));
  });
});

// D281：责任人——列表画姓名（空画「—」）、新建可选人、统计有 owner 轴。
describe("D281 责任人", () => {
  it("列表责任人列：有值画姓名，未指派画「—」", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    expect(screen.getByTestId("fc-owner-c1").textContent).toBe("李四");
    expect(screen.getByTestId("fc-owner-c2").textContent).toBe("—");
  });

  it("新建弹窗选责任人 → POST body 带 owner_id", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-new"));
    await waitFor(() => expect(screen.getByTestId("fc-field-owner")).toBeTruthy());
    await pick("fc-field-owner", "李四");
    fireEvent.change(screen.getByTestId("fc-field-name"), { target: { value: "指派用例" } });
    fireEvent.click(screen.getByTestId("fc-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/functional-cases"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ project_id: "p1", name: "指派用例", owner_id: "u2" });
    });
  });

  it("统计切到「责任人」轴：body 带 group_by=owner，未指派归「—」", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-stats"));
    await waitFor(() => expect(
      calls.filter((c) => c.method === "POST" && /\/functional-cases\/stats$/.test(c.url)).length).toBe(1));
    await pick("fc-stats-groupby", "责任人");
    await waitFor(() => {
      const stats = calls.filter((c) => c.method === "POST" && /\/functional-cases\/stats$/.test(c.url));
      expect(stats[stats.length - 1].body).toMatchObject({ project_id: "p1", group_by: "owner" });
    });
    await waitFor(() => {
      const text = screen.getAllByTestId("fc-stats-row").map((r) => r.textContent ?? "").join("|");
      expect(text).toContain("李四");
      expect(text).toContain("—");
    });
  });
});

// D254：批量彻底删除——单条要逐字输用例名，批量改成输固定短语「彻底删除」。
// 钉：① 弹窗点名要删的用例；② 没输对短语时确认钮禁用；③ body 带 ids 且不可逆说明在。
describe("D254 回收站批量彻底删除", () => {
  const purgeCalls = () => calls.filter(
    (c) => c.method === "POST" && /functional-cases\/batch-purge/.test(c.url));

  it("勾 2 条 → 短语确认前禁用 → 输入「彻底删除」后提交", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-recycled"));
    await waitFor(() => expect(screen.getByText(/退出回收站/)).toBeTruthy());
    await waitFor(() => expect(rowBoxes().length).toBe(2));
    fireEvent.click(rowBoxes()[0]);
    fireEvent.click(rowBoxes()[1]);
    fireEvent.click(await screen.findByTestId("fc-batch-purge"));

    const summary = await screen.findByTestId("fc-batch-purge-summary");
    expect(summary.textContent).toContain("登录成功");
    expect(summary.textContent).toContain("无法恢复");

    const okBtns = () => Array.from(document.querySelectorAll(
      ".ant-modal-footer .ant-btn-primary")) as HTMLButtonElement[];
    const ok = okBtns()[okBtns().length - 1];
    expect(ok.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("fc-batch-purge-confirm"),
      { target: { value: "彻底删除" } });
    await waitFor(() => expect(okBtns()[okBtns().length - 1].disabled).toBe(false));
    fireEvent.click(okBtns()[okBtns().length - 1]);

    await waitFor(() => expect(purgeCalls().length).toBe(1));
    expect(purgeCalls()[0].body).toMatchObject({ project_id: "p1", case_ids: ["c1", "c2"] });
    await waitFor(() => expect(screen.queryByTestId("fc-batch-purge")).toBeNull());
  });
});

// D283：标签——列表最多画两枚 + 「+N」，空画「—」；表单可录入；筛选走顶层 tag
// （后端 FIND_IN_SET 精确匹配，不做 LIKE）。
describe("D283 标签", () => {
  /** rc-select 的 tags 输入：先在搜索框里改值，再按 Enter 收成标签。
   *  keyDown 必须带 keyCode/which 13——只给 key: "Enter" 时 rc-select 不收；
   *  按完要补 keyUp——rc-input 的 keyLockRef 会锁住下一次 keyDown。 */
  async function addTag(testid: string, value: string): Promise<void> {
    const input = screen.getByTestId(testid).querySelector("input")!;
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
    fireEvent.keyUp(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(screen.getByTestId(testid).textContent).toContain(value));
  }

  it("列表标签列：有值画前两枚 + 「+N」，无标签画「—」", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const c1 = screen.getByTestId("fc-tags-c1");
    expect(c1.textContent).toContain("回归");
    expect(c1.textContent).toContain("核心");
    expect(c1.textContent).toContain("+1"); // 第三枚「冒烟」收进 +1
    expect(c1.textContent).not.toContain("冒烟");
    expect(screen.getByTestId("fc-tags-c2").textContent).toBe("—");
  });

  it("新建时录入标签 → POST body 带 tags", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-new"));
    await waitFor(() => expect(screen.getByTestId("fc-field-tags")).toBeTruthy());
    fireEvent.change(screen.getByTestId("fc-field-name"), { target: { value: "带标签用例" } });
    await addTag("fc-field-tags", "回归");
    await addTag("fc-field-tags", "冒烟");
    fireEvent.click(screen.getByTestId("fc-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/functional-cases"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ project_id: "p1", name: "带标签用例", tags: ["回归", "冒烟"] });
    });
  });

  it("标签筛选：回车后列表请求带 tag（前端不做本地过滤）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    const listUrls = (): string[] => calls.filter((c) =>
      c.method === "GET" && /\/functional-cases\?/.test(c.url)).map((c) => c.url);
    expect(qsOf(listUrls()[0]).has("tag")).toBe(false);

    const input = screen.getByTestId("fc-filter-tag");
    expect(input.tagName).toBe("INPUT");
    fireEvent.change(input, { target: { value: "  回归  " } });
    // rc-input 的 Enter 有 keyLockRef：keyDown 后要 keyUp 才放行下一次
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
    fireEvent.keyUp(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(1));
    // trim 后上线；纯空白清空时参数整个不上线（不是 tag=）
    expect(qsOf(listUrls()[listUrls().length - 1]).get("tag")).toBe("回归");
  });
});

// D289：MS v2 功能用例表单——两栏满高（左内容 / 右属性），补前置条件、步骤、备注、用例状态。
describe("D289 用例表单", () => {
  it("新建页两栏：内容在左、属性在右；步骤行可增删并随 POST 提交", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fc-new"));
    await waitFor(() => expect(screen.getByTestId("fc-form-side")).toBeTruthy());
    expect(document.querySelector(".tp-record-editor--side-right")).toBeTruthy();
    expect(screen.getByTestId("fc-field-status")).toBeTruthy();

    fireEvent.click(screen.getByTestId("fc-step-add"));
    await waitFor(() => expect(screen.getByTestId("fc-step-desc-0")).toBeTruthy());
    fireEvent.change(screen.getByTestId("fc-step-desc-0"), { target: { value: "打开登录页" } });
    fireEvent.change(screen.getByTestId("fc-step-expected-0"), { target: { value: "看到表单" } });
    fireEvent.change(screen.getByTestId("fc-field-precondition"), { target: { value: "已注册账号" } });
    fireEvent.change(screen.getByTestId("fc-field-remark"), { target: { value: "冒烟必跑" } });
    fireEvent.change(screen.getByTestId("fc-field-name"), { target: { value: "带步骤用例" } });
    fireEvent.click(screen.getByTestId("fc-save"));

    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/functional-cases"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1", name: "带步骤用例",
        precondition: "已注册账号", remark: "冒烟必跑",
        steps: [{ desc: "打开登录页", expected: "看到表单" }],
        case_status: "prepare",
      });
    });
  });

  it("编辑：四项回显；清空前置条件与步骤后 PATCH 带 null/[] 与 *_set", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getAllByTestId("fc-edit")[0]);
    await waitFor(() => expect(screen.getByTestId("fc-form-side")).toBeTruthy());
    expect((screen.getByTestId("fc-field-precondition") as HTMLTextAreaElement).value).toBe("已登录");
    expect((screen.getByTestId("fc-field-remark") as HTMLTextAreaElement).value).toBe("冒烟必跑");
    expect((screen.getByTestId("fc-step-desc-0") as HTMLTextAreaElement).value).toBe("点登录");

    fireEvent.change(screen.getByTestId("fc-field-precondition"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("fc-step-del-0"));
    await waitFor(() => expect(screen.queryByTestId("fc-step-desc-0")).toBeNull());
    fireEvent.click(screen.getByTestId("fc-save"));

    await waitFor(() => {
      const c = calls.find((x) => x.method === "PATCH" && /\/functional-cases\/c1$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1",
        precondition: null, precondition_set: true,
        steps: [], steps_set: true,
        remark: "冒烟必跑", remark_set: true,
        case_status: "underway",
      });
    });
  });
});



