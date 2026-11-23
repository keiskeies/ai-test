// 用例评审页（D194）组件测试：列表/权限门 + 详情结论提交/历史。
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
window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;

import CaseReviewsPage from "./caseReviews";
import CaseReviewDetailPage from "./caseReviewDetail";
import { useAuth } from "../auth/store";
import type { ReviewCaseRow, ReviewRow } from "../api/review";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

const REVIEW: ReviewRow = {
  id: "r1", num: 100001, project_id: "p1", module_id: "m1", name: "登录评审",
  description: null, pass_rule: "single", start_at: null, end_at: null, started: true,
  status: "in_review", case_count: 1, pass_count: 0, resolved_count: 0, pass_rate: 0,
  reviewer_count: 1, created_by: "u1", created_by_name: "张三",
  created_at: "2026-11-23T10:00:00+08:00", updated_at: "2026-11-23T10:00:00+08:00",
};
const RCASE: ReviewCaseRow = {
  id: "rc1", review_id: "r1", case_id: "c1", case_name: "登录成功",
  case_exists: true, result: "pending", re_review: false,
  reviewers: [{ user_id: "u2", name: "李四" }], updated_at: "2026-11-23T10:00:00+08:00",
};

const calls: { url: string; method: string; body: unknown }[] = [];

// D221：评审页工具栏要的 /filter-meta（形状与后端 filter_registry 一致）。
// supported_view_types 必须含 case_review，否则工具栏按「本页不支持」画——
// 那会把「桩没 mock 到」演成「功能不存在」。
const REVIEW_META = {
  view_type: "case_review",
  fields: [
    { field: "name", label: "评审名称", kind: "text",
      ops: ["CONTAINS", "EQUALS", "IN", "NOT_CONTAINS", "NOT_EQUALS", "NOT_IN"] },
    { field: "pass_rule", label: "通过规则", kind: "enum",
      ops: ["EMPTY", "EQUALS", "IN", "NOT_EQUALS", "NOT_EMPTY"] },
  ],
  supported_view_types: ["case_review"],
  view_label: "用例评审",
  operators: [], labels: {}, kinds: {}, unavailable: {},
};

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
    if (url.includes("/filter-meta")) return resp(200, REVIEW_META);
    if (url.includes("/saved-views")) return resp(200, []);
    if (url.includes("/case-review-modules/tree")) {
      return resp(200, { tree: [{ id: "m1", parent_id: null, name: "登录评审模块", sort: 0,
        status: "normal", review_count: 1, children: [] }], recycled: [] });
    }
    if (url.includes("/projects/p1/members")) {
      return resp(200, { items: [{ user_id: "u2", account: "li", name: "李四" }] });
    }
    if (url.includes("/functional-cases?") && method === "GET") {
      return resp(200, { items: [{ id: "c1", num: 100001, project_id: "p1", module_id: null,
        template_id: "tpl1", name: "登录成功", priority: "P2", description: null, recycled: false,
        custom_fields: {}, created_by: null, created_by_name: null, updated_by: null,
        updated_by_name: null, created_at: null, updated_at: null }], total: 1 });
    }
    if (/\/case-reviews\?/.test(url) && method === "GET") {
      return resp(200, { items: [REVIEW], next_cursor: null, total: 1 });
    }
    if (/\/case-reviews\/r1\/cases\?/.test(url) && method === "GET") {
      return resp(200, { items: [RCASE], next_cursor: null, total: 1 });
    }
    if (/\/case-reviews\/r1\?/.test(url) && method === "GET") return resp(200, REVIEW);
    if (/\/case-reviews\/r1\/cases\/c1\/results$/.test(url) && method === "POST") {
      return resp(201, { ...RCASE, result: body.action === "fail" ? "fail" : "pass" });
    }
    if (/\/case-reviews\/r1\/cases\/c1\/results\?/.test(url) && method === "GET") {
      return resp(200, { items: [
        { id: "h1", user_id: "u2", user_name: "李四", action: "suggestion",
          comment: "先看看", active: false, created_at: "2026-11-23T10:01:00+08:00" },
        { id: "h2", user_id: "u2", user_name: "李四", action: "pass",
          comment: null, active: true, created_at: "2026-11-23T10:02:00+08:00" },
      ] });
    }
    if (/\/functional-cases\/c1\/reviews/.test(url)) return resp(200, { items: [] });
    if (url.endsWith("/case-reviews") && method === "POST") {
      return resp(201, { ...REVIEW, id: "r9" });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

afterEach(cleanup);
beforeEach(() => {
  cleanup();
  localStorage.clear();
  mockBackend();
  useAuth.setState({
    user: { id: "u2", account: "a", name: "李四", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

function renderList(): void {
  render(<MemoryRouter><CaseReviewsPage /></MemoryRouter>);
}
function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={["/reviews/r1"]}>
      <Routes><Route path="/reviews/:id" element={<CaseReviewDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("评审列表", () => {
  it("渲染评审行与状态/通过率", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录评审")).toBeTruthy());
    expect(screen.getByText("评审中")).toBeTruthy();
    expect(screen.getByTestId("review-new")).toBeTruthy();
  });

  it("READONLY：新建/删除不在 DOM", async () => {
    useAuth.setState({ project: READONLY });
    renderList();
    await waitFor(() => expect(screen.getByText("登录评审")).toBeTruthy());
    expect(screen.queryByTestId("review-new")).toBeNull();
    expect(screen.queryByTestId("review-del")).toBeNull();
  });
});

describe("评审详情", () => {
  it("渲染用例行；提交通过走 POST 结论", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId("review-detail-title").textContent).toBe("登录评审"));
    expect(screen.getByText("登录成功")).toBeTruthy();
    fireEvent.click(screen.getByTestId("review-case-submit"));
    const ok = await screen.findByTestId("review-submit-ok");
    fireEvent.click(ok);
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/case-reviews\/r1\/cases\/c1\/results$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ project_id: "p1", review_id: "r1", case_id: "c1", action: "pass" });
    });
  });

  it("历史：展示有效/作废两条", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText("登录成功")).toBeTruthy());
    fireEvent.click(screen.getByTestId("review-case-history"));
    await waitFor(() => expect(screen.getByText("先看看")).toBeTruthy());
    expect(screen.getAllByText("有效").length).toBeGreaterThan(0);
    expect(screen.getAllByText("作废").length).toBeGreaterThan(0);
  });
});

// ── D221：评审页的 D47-a 三件套 ────────────────────────────────────────────────
describe("评审列表 D221 高级搜索与列设置", () => {
  const lastListUrl = (): string => [...calls].reverse()
    .find((c) => c.method === "GET" && /\/case-reviews\?/.test(c.url))!.url;

  it("空条件不拼 filter；应用「评审名称包含 登录」后下一次列表请求带条件 JSON", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录评审")).toBeTruthy());
    // 空条件整个参数不上线（不是 filter=）
    expect(new URL(lastListUrl(), "http://x").searchParams.has("filter")).toBe(false);
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() =>
      expect(new URL(lastListUrl(), "http://x").searchParams.get("filter")).toBeTruthy());
    // 字段名来自后端 meta 的第一项（name），前端不自列字段
    expect(JSON.parse(new URL(lastListUrl(), "http://x").searchParams.get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "登录" }],
    });
  });

  it("列设置勾掉「通过率」只藏那一列（其余表头原样）", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录评审")).toBeTruthy());
    const thead = (): string => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("通过率");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["ID", "名称", "状态", "通过率", "规则", "评审人", "创建人", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("通过率")]);
    await waitFor(() => expect(thead()).not.toContain("通过率"));
    expect(thead()).toContain("状态");
  });
});
