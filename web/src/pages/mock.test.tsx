// API Mock 页（D201）：服务/规则渲染、建服务、只读门。
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

import MockPage from "./mock";
import { useAuth } from "../auth/store";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };
const SERVICE = {
  id: "s1", project_id: "p1", name: "订单 Mock", description: null, enabled: true,
  rule_count: 1, mock_base: "/mock/s1", created_at: null, updated_at: null,
};
const RULE = {
  id: "r1", project_id: "p1", service_id: "s1", name: "用户", method: "GET",
  path: "/users", match_type: "exact", status_code: 200, headers: null, body: "{}",
  delay_ms: 0, priority: 0, enabled: true, created_at: null, updated_at: null,
};

const calls: { url: string; method: string; body: unknown }[] = [];

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ url, method, body });
    if (url.includes("/mock-services?") && method === "GET") return resp(200, { items: [SERVICE] });
    if (/\/mock-services\/s1\/rules\?/.test(url) && method === "GET") return resp(200, { items: [RULE] });
    // D241：高级搜索三件套的依赖（元数据 / 个人视图）；不 mock 会命中下面的 throw，
    // 把「本测试没 mock」演成「筛选功能故障」。
    if (url.includes("/filter-meta?")) {
      return resp(200, {
        view_type: "mock_rule", view_label: "Mock 规则",
        supported_view_types: ["mock_rule"],
        fields: [
          { field: "name", label: "规则名", kind: "text",
            ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS"] },
          { field: "method", label: "请求方法", kind: "enum",
            ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
          { field: "enabled", label: "启用（1/0）", kind: "number",
            ops: ["EQUALS", "NOT_EQUALS", "GT", "LT", "BETWEEN"] },
        ],
        unavailable: {},
      });
    }
    if (url.includes("/saved-views?")) return resp(200, []);
    if (url.endsWith("/mock-services") && method === "POST") {
      return resp(201, { ...SERVICE, id: "s2", ...body as object });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});
afterEach(cleanup);

function renderPage(): void {
  render(<MemoryRouter><MockPage /></MemoryRouter>);
}

describe("API Mock", () => {
  it("渲染服务与规则", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("订单 Mock")).toBeTruthy());
    expect(screen.getByText("用户")).toBeTruthy();
    expect(screen.getByText("/users")).toBeTruthy();
    expect(screen.getByTestId("mock-service-new")).toBeTruthy();
  });

  it("新建服务：POST body", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("订单 Mock")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mock-service-new"));
    fireEvent.change(screen.getByTestId("mock-service-name"), { target: { value: "支付 Mock" } });
    fireEvent.click(screen.getByTestId("mock-service-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/mock-services"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ project_id: "p1", name: "支付 Mock" });
    });
  });

  it("READONLY：新建/编辑/删除不在 DOM", async () => {
    useAuth.setState({ project: READONLY });
    renderPage();
    await waitFor(() => expect(screen.getByText("订单 Mock")).toBeTruthy());
    expect(screen.queryByTestId("mock-service-new")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.queryByText("删除")).toBeNull();
  });
});

// ── D241：Mock 规则高级搜索 + 列设置 ─────────────────────────────────────────
function ruleReqs(): { url: string; method: string }[] {
  return calls.filter((c) => c.method === "GET" && /\/mock-services\/s1\/rules\?/.test(c.url));
}

describe("D241 Mock 规则高级搜索与列设置", () => {
  it("空条件不拼 filter；应用「规则名包含 用户」后规则请求带条件 JSON", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("用户")).toBeTruthy());
    expect(ruleReqs()[0].url).not.toContain("filter=");
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "用户" } });
    const before = ruleReqs().length; // 基线在「应用」之前取：fetch 在桩里同步入队
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(ruleReqs().length).toBe(before + 1));
    const raw = new URLSearchParams(ruleReqs().at(-1)!.url.slice(ruleReqs().at(-1)!.url.indexOf("?") + 1))
      .get("filter");
    expect(JSON.parse(raw!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "用户" }],
    });
  });

  it("列设置勾掉「匹配」只藏那一列（其余表头原样，操作列不可隐藏）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("/users")).toBeTruthy());
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["顺序", "名称", "匹配", "响应", "启用"]);
    fireEvent.click(boxes[labels.indexOf("匹配")]);
    await waitFor(() => expect(screen.queryByText("/users")).toBeNull());
    expect(screen.getByText("用户")).toBeTruthy();
  });
});
