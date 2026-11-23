// 平台运维（D203）组件测试。
// 钉：① 三块列表渲染（令牌只回末 4 位、插件恒「未装载」）；② 新建集成的 POST body；
// ③ 资源池容量入 body；④ 插件 config 非 JSON 时前端拦下（不发请求）；
// ⑤ READONLY（*:read）看不到任何写钮；⑥ 启停走 /status 并把新值带进 body。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import PlatformOpsTab from "./PlatformOpsTab";

const calls: { url: string; method: string; body: unknown }[] = [];

const INT = {
  id: "i1", project_id: "p1", kind: "github", name: "主仓库",
  base_url: "https://api.github.com", has_token: true, token_hint: "****abcd",
  description: null, enabled: true, created_by: "u1", created_at: null, updated_at: null,
};
const POOL = {
  id: "p1pool", project_id: "p1", name: "本地池", kind: "local", description: null,
  capacity: 4, enabled: true, created_by: "u1", created_at: null, updated_at: null,
};
const PLUG = {
  id: "pl1", project_id: "p1", name: "kafka", kind: "protocol", version: "1.0.0",
  description: null, config: '{"brokers":[]}', enabled: true, loadable: false,
  created_by: "u1", created_at: null, updated_at: null,
};

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.includes("/service-integrations/meta")) return resp(200, { kinds: ["github", "gitlab", "gitee"] });
    if (url.includes("/service-integrations?") && method === "GET") return resp(200, { items: [INT] });
    if (url.endsWith("/service-integrations") && method === "POST") {
      return resp(201, { ...INT, id: "i9", ...body, has_token: Boolean(body.token), token_hint: "****wxyz" });
    }
    if (url.includes("/status") && method === "POST") return resp(200, { ...INT, enabled: body.enabled });
    if (url.includes("/resource-pools?") && method === "GET") return resp(200, { items: [POOL] });
    if (url.endsWith("/resource-pools") && method === "POST") {
      return resp(201, { ...POOL, id: "p9", ...body });
    }
    if (url.includes("/plugins/meta")) {
      return resp(200, { kinds: ["protocol", "assertion"], note: "插件清单只做登记：没有动态装载点。" });
    }
    if (url.includes("/plugins?") && method === "GET") return resp(200, { items: [PLUG] });
    if (url.endsWith("/plugins") && method === "POST") return resp(201, { ...PLUG, id: "pl9", ...body });
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

const FULL = ["*"];

describe("平台运维", () => {
  it("三块列表渲染：令牌只回末 4 位、插件恒「未装载」、资源池容量可见", async () => {
    render(<PlatformOpsTab projectId="p1" perms={FULL} />);
    await waitFor(() => expect(screen.getByText("主仓库")).toBeTruthy());
    expect(screen.getByText("****abcd")).toBeTruthy();
    expect(screen.getAllByText("本地池").length).toBeGreaterThan(0);
    expect(screen.getByText("4")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("kafka")).toBeTruthy());
    expect(screen.getByTestId("plugin-unloaded").textContent).toBe("未装载");
    expect(screen.getByText(/没有动态装载点/)).toBeTruthy();
  });

  it("新建集成：POST body 逐字段（含 token）", async () => {
    render(<PlatformOpsTab projectId="p1" perms={FULL} />);
    await waitFor(() => expect(screen.getByText("主仓库")).toBeTruthy());
    fireEvent.click(screen.getByTestId("si-new"));
    fireEvent.change(screen.getByTestId("si-name"), { target: { value: "备份仓库" } });
    fireEvent.change(screen.getByTestId("si-url"), { target: { value: "https://gitlab.com" } });
    fireEvent.change(screen.getByTestId("si-token"), { target: { value: "glpat-wxyz" } });
    fireEvent.click(screen.getByTestId("si-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/service-integrations"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1", kind: "github", name: "备份仓库",
        base_url: "https://gitlab.com", token: "glpat-wxyz", enabled: true,
      });
    });
  });

  it("新建资源池：容量进 body", async () => {
    render(<PlatformOpsTab projectId="p1" perms={FULL} />);
    await waitFor(() => expect(screen.getByText("本地池")).toBeTruthy());
    fireEvent.click(screen.getByTestId("pool-new"));
    fireEvent.change(screen.getByTestId("pool-name"), { target: { value: "UI 池" } });
    fireEvent.click(screen.getByTestId("pool-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/resource-pools"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ project_id: "p1", name: "UI 池", kind: "local", capacity: 1 });
    });
  });

  it("插件 config 非 JSON：前端拦下且不发 POST", async () => {
    render(<PlatformOpsTab projectId="p1" perms={FULL} />);
    await waitFor(() => expect(screen.getByText("kafka")).toBeTruthy());
    fireEvent.click(screen.getByTestId("plugin-new"));
    fireEvent.change(screen.getByTestId("plugin-name"), { target: { value: "坏插件" } });
    fireEvent.change(screen.getByTestId("plugin-config"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByTestId("plugin-save"));
    await waitFor(() => expect(screen.getByText("配置必须是合法 JSON")).toBeTruthy());
    expect(calls.some((x) => x.method === "POST" && x.url.endsWith("/plugins"))).toBe(false);
  });

  it("启停：POST /status 带 enabled=false", async () => {
    render(<PlatformOpsTab projectId="p1" perms={FULL} />);
    const sw = await screen.findByTestId("si-toggle-i1");
    fireEvent.click(sw);
    await waitFor(() => {
      const c = calls.find((x) => x.url.endsWith("/service-integrations/i1/status"));
      expect(c?.body).toMatchObject({ project_id: "p1", integration_id: "i1", enabled: false });
    });
  });

  it("READONLY（*:read）：三块列表都在，但没有任何写钮", async () => {
    render(<PlatformOpsTab projectId="p1" perms={["*:read"]} />);
    await waitFor(() => expect(screen.getByText("主仓库")).toBeTruthy());
    expect(screen.getByText("kafka")).toBeTruthy();
    expect(screen.queryByTestId("si-new")).toBeNull();
    expect(screen.queryByTestId("pool-new")).toBeNull();
    expect(screen.queryByTestId("plugin-new")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.queryByText("删除")).toBeNull();
    expect((screen.getByTestId("si-toggle-i1") as HTMLButtonElement).disabled).toBe(true);
  });
});
