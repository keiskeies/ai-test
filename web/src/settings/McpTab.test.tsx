// D265 MCP 管理页：状态渲染、添加/编辑（env 留空=保留、勾选清空）、测试连接与工具预览。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import McpTab, { parseEffects, parseKv, parseLines, statusMeta, type McpServer } from "./McpTab";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

function srv(over: Partial<McpServer> = {}): McpServer {
  return {
    id: "m1", name: "fake-tools", transport: "stdio", command: "python", args: ["server.py"],
    url: "", env_keys: ["TOKEN"], has_headers: false, enabled: true, status: "online",
    tool_count: 2, tool_effects: {}, last_error: null,
    last_checked_at: "2026-11-24T10:00:00+00:00", last_latency_ms: 120, ...over,
  };
}

interface Call { url: string; method: string; body?: string }

function mockFetch(items: McpServer[], opts: { listFail?: boolean; testOk?: boolean } = {}) {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    const ok = (status: number, data: unknown) => ({ ok: true, status, json: async () => data }) as unknown as Response;
    if (url.includes("/mcp-servers?") && method === "GET") {
      if (opts.listFail) {
        return { ok: false, status: 403, json: async () => ({ code: "insufficient_permission", message: "拒绝" }) } as unknown as Response;
      }
      return ok(200, { items, next_cursor: null });
    }
    if (/\/mcp-servers\/[^/]+\/tools$/.test(url)) {
      return ok(200, { items: [{ name: "echo", description: "回显文本",
        input_schema: { type: "object", properties: { text: { type: "string" } } } }], cached_at: null });
    }
    if (/\/mcp-servers\/[^/]+\/test$/.test(url)) {
      return ok(200, { ok: opts.testOk ?? true, latency_ms: 88, tool_count: 2,
        tools: [], status: opts.testOk === false ? "offline" : "online",
        error: opts.testOk === false ? "ConnectError: refused" : null, last_checked_at: null });
    }
    if (/\/mcp-servers\/[^/]+\/toggle$/.test(url)) {
      return ok(200, { ...items[0], enabled: JSON.parse(String(init?.body)).enabled });
    }
    if (method === "POST" && url.endsWith("/mcp-servers")) return ok(201, { ...srv({ id: "m9" }) });
    if (method === "PATCH") return ok(200, { ...items[0], name: "renamed" });
    if (method === "DELETE") return ok(200, { ok: true });
    return ok(200, { items, next_cursor: null });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => cleanup());

describe("解析纯函数", () => {
  it("args 去空行；KEY=VALUE 忽略注释与残缺行；effect 只收 read/write", () => {
    expect(parseLines(" npx \n\n -y\n")).toEqual(["npx", "-y"]);
    expect(parseKv("# c\nA=1\nbad\nB = two=2\n")).toEqual({ A: "1", B: "two=2" });
    expect(parseEffects("a=read\nb=write\nc=other")).toEqual({ a: "read", b: "write" });
    expect(statusMeta("online").badge).toBe("success");
    expect(statusMeta("offline").badge).toBe("error");
    expect(statusMeta("disabled").badge).toBe("default");
  });
});

describe("列表与状态", () => {
  it("在线/停用与最近错误都如实上屏；停用不显示工具数", async () => {
    mockFetch([srv(), srv({ id: "m2", name: "dead", status: "offline", enabled: false,
      tool_count: 0, last_error: "ConnectError: refused" })]);
    render(<McpTab canManage />);
    await screen.findByTestId("mcp-table");
    const badges = screen.getAllByTestId("mcp-status").map((n) => n.getAttribute("data-state"));
    expect(badges).toEqual(["online", "offline"]);
    expect(screen.getByTestId("mcp-error-m2").textContent).toContain("ConnectError");
  });

  it("列表 403：出诚实告警，不装空态", async () => {
    mockFetch([], { listFail: true });
    render(<McpTab canManage />);
    expect(await screen.findByTestId("mcp-load-failed")).not.toBeNull();
    expect(screen.queryByTestId("mcp-table")).toBeNull();
  });
});

describe("添加与编辑", () => {
  it("添加：stdio 参数按行拆、env 按 KEY=VALUE 送，保存后重拉", async () => {
    const calls = mockFetch([]);
    render(<McpTab canManage />);
    await screen.findByTestId("mcp-table");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "fs" } });
    fireEvent.change(screen.getByTestId("mcp-form-command"), { target: { value: "/usr/bin/uvx" } });
    fireEvent.change(screen.getByTestId("mcp-form-args"), { target: { value: "mcp-server\n/data" } });
    fireEvent.change(screen.getByTestId("mcp-form-env"), { target: { value: "TOKEN=abc" } });
    fireEvent.click(screen.getByText("保存并重连"));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/mcp-servers")).length).toBe(1));
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/mcp-servers"))!.body!);
    expect(body).toMatchObject({ name: "fs", transport: "stdio", command: "/usr/bin/uvx",
      args: ["mcp-server", "/data"], env: { TOKEN: "abc" }, enabled: true });
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/mcp-servers?")).length).toBeGreaterThan(1));
  });

  it("校验：stdio 没命令不出请求，错误留在弹窗", async () => {
    const calls = mockFetch([]);
    render(<McpTab canManage />);
    await screen.findByTestId("mcp-table");
    fireEvent.click(screen.getByTestId("mcp-add"));
    fireEvent.change(screen.getByTestId("mcp-form-name"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("保存并重连"));
    expect(await screen.findByTestId("mcp-form-error")).not.toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("编辑：env 留空=不下发；勾选清空才发 {}；工具权限一并送", async () => {
    const calls = mockFetch([srv()]);
    render(<McpTab canManage />);
    await screen.findByTestId("mcp-table");
    fireEvent.click(screen.getByTestId("mcp-edit-m1"));
    fireEvent.change(screen.getByTestId("mcp-form-effects"), { target: { value: "echo=read" } });
    fireEvent.click(screen.getByText("保存并重连"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body1 = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
    expect(body1.env).toBeUndefined();
    expect(body1.tool_effects).toEqual({ echo: "read" });

    cleanup();
    const calls2 = mockFetch([srv()]);
    render(<McpTab canManage />);
    await screen.findByTestId("mcp-table");
    fireEvent.click(screen.getByTestId("mcp-edit-m1"));
    fireEvent.click(screen.getByTestId("mcp-form-clear"));
    fireEvent.click(screen.getByText("保存并重连"));
    await waitFor(() => expect(calls2.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls2.find((c) => c.method === "PATCH")!.body!).env).toEqual({});
  });
});

describe("操作", () => {
  it("测试连接：打到 /test 并刷新列表", async () => {
    const calls = mockFetch([srv()]);
    render(<McpTab canManage />);
    await screen.findByTestId("mcp-table");
    fireEvent.click(screen.getByTestId("mcp-test-m1"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/mcp-servers/m1/test"))).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/mcp-servers?")).length).toBeGreaterThan(1));
  });

  it("工具预览：弹窗列出工具名与 input schema", async () => {
    mockFetch([srv()]);
    render(<McpTab canManage />);
    await screen.findByTestId("mcp-table");
    fireEvent.click(screen.getByTestId("mcp-tools-m1"));
    await waitFor(() => expect(screen.getByTestId("mcp-schema-echo")).not.toBeNull());
    expect(screen.getByTestId("mcp-schema-echo").textContent).toContain('"text"');
  });

  it("无管理位：添加/编辑/测试/删除全隐藏为 disabled，工具预览仍可看", async () => {
    mockFetch([srv()]);
    render(<McpTab canManage={false} />);
    await screen.findByTestId("mcp-table");
    expect((screen.getByTestId("mcp-add") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("mcp-edit-m1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("mcp-test-m1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("mcp-tools-m1") as HTMLButtonElement).disabled).toBe(false);
  });
});
