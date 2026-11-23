// 环境组面板（D200 / C1）测试：D249 起两件事要钉——
// ① 原有 CRUD 不被工具栏改造弄坏（新建 body 原样、只读无写钮）；
// ② 三件套真听条件：选视图 → 条件作为 filter 重查；列设置只藏勾掉那一列。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import EnvGroupsPanel from "./EnvGroupsPanel";
import type { EnvGroup } from "../api/projectAssets";

// antd 响应式观察器要 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const GROUP: EnvGroup = {
  id: "g1", project_id: "p1", name: "预发全套", description: "上线前回归",
  envs: [{ id: "e1", name: "预发环境" }], created_at: null, updated_at: null,
};

type Call = { url: string; method: string; body: string | null };
const calls: Call[] = [];

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

const META = {
  operators: ["CONTAINS", "EQUALS"], labels: { CONTAINS: "包含", EQUALS: "等于" },
  kinds: { text: ["CONTAINS", "EQUALS"] }, unavailable: {},
  supported_view_types: ["env_group"], view_label: "环境组",
  fields: [{ field: "name", label: "组名", kind: "text", ops: ["CONTAINS", "EQUALS"] }],
};

function mockFetch(opts: { views?: unknown[] } = {}): Call[] {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : null });
    if (url.includes("/filter-meta?")) return resp(200, META);
    if (url.includes("/saved-views?")) return resp(200, opts.views ?? []);
    if (url.includes("/env-groups?") && method === "GET") return resp(200, { items: [GROUP] });
    if (url.includes("/envs?")) return resp(200, { items: [{ id: "e1", name: "预发环境" }] });
    if (url.endsWith("/env-groups") && method === "POST") {
      return resp(201, { ...GROUP, id: "g9", ...JSON.parse(String(init?.body)) });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => { localStorage.clear(); });
afterEach(cleanup);

function renderPanel(canEdit = true, canView = true): void {
  render(<EnvGroupsPanel projectId="p1" canEdit={canEdit}
    canSaveView={canView} canDeleteView={canView} />);
}

describe("EnvGroupsPanel", () => {
  it("列出组与环境；只读无新建钮", async () => {
    mockFetch();
    renderPanel(false);
    await screen.findByText("预发全套");
    expect(screen.getByText("预发环境")).toBeTruthy();
    expect(screen.queryByTestId("env-group-new")).toBeNull();
    cleanup();

    mockFetch();
    renderPanel();
    await screen.findByText("预发全套");
    expect(screen.getByTestId("env-group-new")).toBeTruthy();
  });

  it("新建环境组 → POST body 带项目/组名/说明/环境，成功后重拉", async () => {
    const c = mockFetch();
    renderPanel();
    await screen.findByText("预发全套");
    fireEvent.click(screen.getByTestId("env-group-new"));
    fireEvent.change(screen.getByPlaceholderText("组名"), { target: { value: "回归组" } });
    fireEvent.change(screen.getByPlaceholderText("说明"), { target: { value: "回归用" } });
    fireEvent.click(screen.getByTestId("env-group-save"));

    await waitFor(() => expect(c.some((x) => x.method === "POST" && x.url.endsWith("/env-groups"))).toBe(true));
    const body = JSON.parse(c.find((x) => x.method === "POST")!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ project_id: "p1", name: "回归组", description: "回归用", env_ids: [] });
    await waitFor(() => expect(
      c.filter((x) => x.method === "GET" && x.url.includes("/env-groups?")).length).toBeGreaterThan(1));
  });

  it("选视图 → 条件作为 filter 重查（不串到 /envs 选项请求）", async () => {
    const view = {
      id: "v1", project_id: "p1", view_type: "env_group", name: "只看预发",
      conditions: { search_mode: "AND", conditions: [
        { field: "name", operator: "CONTAINS", value: "预发" }] },
      pos: 0, updated_at: null,
    };
    const c = mockFetch({ views: [view] });
    renderPanel();
    await screen.findByText("预发全套");

    fireEvent.mouseDown(screen.getByTestId("lt-view").querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText("只看预发"));

    await waitFor(() => {
      const last = c.filter((x) => x.url.includes("/env-groups?")).at(-1)!;
      expect(last.url).toContain("filter=");
      expect(decodeURIComponent(last.url)).toContain('"field":"name"');
    });
    // 环境下拉的选项请求是组表单的粮草，不能被列表条件污染
    const lastEnvs = c.filter((x) => x.url.includes("/envs?")).at(-1)!;
    expect(lastEnvs.url).not.toContain("filter=");
  });

  it("D259：保存视图里的「组内环境名」条件原样进 filter（字段清单来自后端 meta，前端不复算）", async () => {
    const view = {
      id: "v2", project_id: "p1", view_type: "env_group", name: "只看预发环境",
      conditions: { search_mode: "AND", conditions: [
        { field: "envs", operator: "CONTAINS", value: "预发" }] },
      pos: 0, updated_at: null,
    };
    const c = mockFetch({ views: [view] });
    renderPanel();
    await screen.findByText("预发全套");

    fireEvent.mouseDown(screen.getByTestId("lt-view").querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText("只看预发环境"));

    await waitFor(() => {
      const last = c.filter((x) => x.url.includes("/env-groups?")).at(-1)!;
      expect(decodeURIComponent(last.url)).toContain('"field":"envs"');
      expect(decodeURIComponent(last.url)).toContain('"operator":"CONTAINS"');
    });
  });

  it("列设置取消「说明」→ 只藏这一列", async () => {
    mockFetch();
    renderPanel();
    await screen.findByText("预发全套");
    const header = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(header()).toContain("说明");

    fireEvent.click(screen.getByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    fireEvent.click(within(panel).getByText("说明").closest("label")!);

    await waitFor(() => expect(header()).not.toContain("说明"));
    expect(header()).toContain("环境"); // 别的列不受牵连
  });
});
