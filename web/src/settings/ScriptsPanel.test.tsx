// 公共脚本面板（D200 / C2）测试：D250 起三件套要钉住——
// ① 原有 CRUD 不被改造弄坏（新建 body 原样、只读无写钮）；
// ② 选视图 → 条件作为 filter 重查；列设置只藏勾掉的那列；
// ③ 筛「启用=是」时把行切停用 → 重拉，而不是留一张与条件不符的旧脸。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ScriptsPanel from "./ScriptsPanel";
import type { ScriptRow } from "../api/projectAssets";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const SCRIPT: ScriptRow = {
  id: "s1", project_id: "p1", name: "登录函数", description: "登录复用",
  language: "python", content: "def login(): pass", enabled: true, version: 2,
  created_by: null, created_at: null, updated_at: null,
};

type Call = { url: string; method: string; body: string | null };
const calls: Call[] = [];

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

const META = {
  operators: ["CONTAINS", "EQUALS"], labels: { CONTAINS: "包含", EQUALS: "等于" },
  kinds: { text: ["CONTAINS", "EQUALS"] }, unavailable: {},
  supported_view_types: ["public_script"], view_label: "公共脚本",
  fields: [{ field: "name", label: "脚本名", kind: "text", ops: ["CONTAINS", "EQUALS"] }],
};

function mockFetch(opts: { views?: unknown[] } = {}): Call[] {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : null });
    if (url.includes("/filter-meta?")) return resp(200, META);
    if (url.includes("/saved-views?")) return resp(200, opts.views ?? []);
    if (url.includes("/public-scripts?") && method === "GET") return resp(200, { items: [SCRIPT] });
    if (url.endsWith("/public-scripts") && method === "POST") {
      return resp(201, { ...SCRIPT, id: "s9", ...JSON.parse(String(init?.body)) });
    }
    if (url.includes("/public-scripts/") && method === "PATCH") {
      return resp(200, { ...SCRIPT, enabled: JSON.parse(String(init?.body)).enabled });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => { localStorage.clear(); });
afterEach(cleanup);

function renderPanel(canEdit = true, canView = true): void {
  render(<ScriptsPanel projectId="p1" canEdit={canEdit}
    canSaveView={canView} canDeleteView={canView} />);
}

describe("ScriptsPanel", () => {
  it("列出脚本；只读无新建钮", async () => {
    mockFetch();
    renderPanel(false);
    await screen.findByText("登录函数");
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.queryByTestId("script-new")).toBeNull();
    cleanup();

    mockFetch();
    renderPanel();
    await screen.findByText("登录函数");
    expect(screen.getByTestId("script-new")).toBeTruthy();
  });

  it("新建脚本 → POST body 原样（项目/名称/语言/内容/启用），成功后重拉", async () => {
    const c = mockFetch();
    renderPanel();
    await screen.findByText("登录函数");
    fireEvent.click(screen.getByTestId("script-new"));
    fireEvent.change(screen.getByPlaceholderText("脚本名"), { target: { value: "签名工具" } });
    fireEvent.change(screen.getByPlaceholderText("脚本内容"),
      { target: { value: "def sign():\n    return 1\n" } });
    fireEvent.click(screen.getByTestId("script-save"));

    await waitFor(() => expect(
      c.some((x) => x.method === "POST" && x.url.endsWith("/public-scripts"))).toBe(true));
    const body = JSON.parse(c.find((x) => x.method === "POST")!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      project_id: "p1", name: "签名工具", language: "python",
      content: "def sign():\n    return 1\n", enabled: true,
    });
    await waitFor(() => expect(
      c.filter((x) => x.method === "GET" && x.url.includes("/public-scripts?")).length)
      .toBeGreaterThan(1));
  });

  it("选视图 → 条件作为 filter 重查", async () => {
    const view = {
      id: "v1", project_id: "p1", view_type: "public_script", name: "只看登录",
      conditions: { search_mode: "AND", conditions: [
        { field: "name", operator: "CONTAINS", value: "登录" }] },
      pos: 0, updated_at: null,
    };
    const c = mockFetch({ views: [view] });
    renderPanel();
    await screen.findByText("登录函数");

    fireEvent.mouseDown(screen.getByTestId("lt-view").querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText("只看登录"));

    await waitFor(() => {
      const last = c.filter((x) => x.url.includes("/public-scripts?")).at(-1)!;
      expect(last.url).toContain("filter=");
      expect(decodeURIComponent(last.url)).toContain('"field":"name"');
    });
  });

  it("列设置取消「说明」→ 只藏这一列", async () => {
    mockFetch();
    renderPanel();
    await screen.findByText("登录函数");
    const headerText = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(headerText()).toContain("说明");

    fireEvent.click(screen.getByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    fireEvent.click(within(panel).getByText("说明").closest("label")!);

    await waitFor(() => expect(headerText()).not.toContain("说明"));
    expect(headerText()).toContain("语言");
  });

  it("有筛选时切「启用」→ 重拉而非本地打补丁（行可能已不属于结果集）", async () => {
    const view = {
      id: "v2", project_id: "p1", view_type: "public_script", name: "只看启用",
      conditions: { search_mode: "AND", conditions: [
        { field: "enabled", operator: "EQUALS", value: true }] },
      pos: 0, updated_at: null,
    };
    const c = mockFetch({ views: [view] });
    renderPanel();
    await screen.findByText("登录函数");

    // 先套上「只看启用」条件
    fireEvent.mouseDown(screen.getByTestId("lt-view").querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText("只看启用"));
    await waitFor(() => expect(
      c.filter((x) => x.url.includes("/public-scripts?")).at(-1)!.url).toContain("filter="));
    const before = c.filter((x) => x.method === "GET" && x.url.includes("/public-scripts?")).length;

    // 把这一行切停用：条件 启用=true 下它已不该在列表里，必须重拉
    fireEvent.click(document.querySelector(".ant-switch") as HTMLElement);
    await waitFor(() => expect(
      c.filter((x) => x.method === "GET" && x.url.includes("/public-scripts?")).length)
      .toBeGreaterThan(before));
  });
});
