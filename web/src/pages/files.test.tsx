// 文件管理页（D195）：目录树/列表/上传/只读门。
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

import FilesPage from "./files";
import { useAuth } from "../auth/store";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

const FILE = {
  id: "e1", project_id: "p1", folder_id: "f1", name: "设计稿.png", description: null,
  tags: ["设计"], version: 1, is_latest: true, recycled: false,
  blob: { id: "b1", sha256: "x".repeat(64), size: 2048, mime: "image/png", original_name: "设计稿.png" },
  created_by: "u1", created_by_name: "张三", updated_at: "2026-11-23T10:00:00+08:00",
};

const calls: { url: string; method: string; body: unknown }[] = [];

// D222：文件页工具栏要的 /filter-meta（形状与后端 filter_registry 一致）。
// supported_view_types 必须含 file，否则工具栏按「本页不支持」画——
// 那会把「桩没 mock 到」演成「功能不存在」。
const FILE_META = {
  view_type: "file",
  fields: [
    { field: "name", label: "文件名", kind: "text",
      ops: ["CONTAINS", "EQUALS", "IN", "NOT_CONTAINS", "NOT_EQUALS", "NOT_IN"] },
    { field: "size", label: "文件大小", kind: "number",
      ops: ["EQUALS", "GT", "GTE", "LT", "LTE", "NOT_EQUALS"] },
  ],
  supported_view_types: ["file"],
  view_label: "文件库",
  operators: [], labels: {}, kinds: {}, unavailable: {},
};

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ url, method, body });
    if (url.includes("/filter-meta")) return resp(200, FILE_META);
    if (url.includes("/saved-views")) return resp(200, []);
    if (url.includes("/file-folders/tree")) {
      return resp(200, { tree: [{ id: "f1", parent_id: null, name: "设计", sort: 0,
        status: "normal", file_count: 1, children: [] }], recycled: [] });
    }
    if (/\/files\?/.test(url) && method === "GET") {
      return resp(200, { items: [FILE], next_cursor: null, total: 1 });
    }
    if (url.includes("/files/upload") && method === "POST") return resp(200, FILE);
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
});
afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

function renderPage(): void {
  render(<MemoryRouter><FilesPage /></MemoryRouter>);
}

describe("文件管理", () => {
  it("渲染目录树与文件行", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("设计稿.png")).toBeTruthy());
    expect(screen.getAllByText("设计").length).toBeGreaterThan(0);
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByTestId("file-upload")).toBeTruthy();
  });

  it("上传：multipart 到 /files/upload 后重拉列表", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("设计稿.png")).toBeTruthy());
    const input = screen.getByTestId("file-input");
    fireEvent.change(input, { target: { files: [new File(["hello"], "a.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("/files/upload"))).toBe(true));
  });

  it("READONLY：上传钮不在，目录树不可管理", async () => {
    useAuth.setState({ project: READONLY });
    renderPage();
    await waitFor(() => expect(screen.getByText("设计稿.png")).toBeTruthy());
    expect(screen.queryByTestId("file-upload")).toBeNull();
    expect(screen.queryByTestId("module-add-root")).toBeNull();
  });
});

// ── D222：文件管理页的 D47-a 三件套 ────────────────────────────────────────────
describe("文件管理 D222 高级搜索与列设置", () => {
  const lastListUrl = (): string => [...calls].reverse()
    .find((c) => c.method === "GET" && /\/files\?/.test(c.url))!.url;
  const listQuery = (): URLSearchParams => new URL(lastListUrl(), "http://x").searchParams;

  it("空条件不拼 filter；应用「文件名包含 设计」后下一次列表请求带条件 JSON", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("设计稿.png")).toBeTruthy());
    // 空条件整个参数不上线（不是 filter=）
    expect(listQuery().has("filter")).toBe(false);
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "设计" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listQuery().get("filter")).toBeTruthy());
    // 字段名来自后端 meta 的第一项（name），前端不自列字段
    expect(JSON.parse(listQuery().get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "设计" }],
    });
  });

  it("列设置勾掉「标签」只藏那一列（其余表头原样）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("设计稿.png")).toBeTruthy());
    const thead = (): string => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("标签");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "大小", "类型", "目录", "标签", "上传人", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("标签")]);
    await waitFor(() => expect(thead()).not.toContain("标签"));
    expect(thead()).toContain("目录");
  });
});
