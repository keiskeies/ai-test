// D268：用例脑图组件测试。
// 钉的契约（每条对应 CaseMindmap.tsx 的实现点）：
// ① 树 = 模块 → （子模块/便签/用例叶），未分类用例单列一组；总数只算正常用例；
// ② 点用例叶走 onOpenCase（不自己跳路由，详情逻辑归页面）；
// ③ 改名按节点 kind 走对端点：模块 PATCH /functional-modules/{id}，便签
//    PATCH /functional-minder/notes/{id}，body 都带 project_id（后端必填）；
// ④ 新建便签 POST /functional-minder/notes，根层 parent_id=null；
// ⑤ 删便签 = 二次确认 → POST /functional-minder/notes/{id}/delete；
// ⑥ canEdit=false 时写入口整块不在 DOM（不是禁用）——READONLY 看不到。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "antd";
import CaseMindmap from "./CaseMindmap";
import type { MinderTree } from "./functional";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;

const TREE: MinderTree = {
  project_id: "p1",
  nodes: [{
    id: "m1", kind: "module", name: "登录", parent_id: null, sort: 0, case_count: 1,
    cases: [{ id: "c1", num: 100001, name: "登录成功", priority: "P1" }],
    children: [{
      id: "n1", kind: "note", name: "待确认", parent_id: "m1", sort: 0,
      case_count: 0, cases: [], children: [],
    }],
  }],
  unfiled_cases: [{ id: "c2", num: 100002, name: "未归类用例", priority: "P2" }],
  total_cases: 2,
};

interface Call { url: string; method: string; body?: Record<string, unknown> }
const calls: Call[] = [];

function res(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)) } as unknown as Response;
}

function mockBackend(tree: MinderTree = TREE): void {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (method === "GET" && url.includes("/functional-minder")) return res(200, tree);
    if (method === "POST" && /\/functional-minder\/notes\/[^/]+\/delete$/.test(url)) return res(200, { ok: true });
    if (method === "POST" && url.endsWith("/functional-minder/notes")) {
      return res(201, { id: "n9", kind: "note", name: String(body?.name ?? ""),
        parent_id: body?.parent_id ?? null, sort: 0, case_count: 0, cases: [], children: [] });
    }
    if (method === "PATCH" && /\/functional-minder\/notes\//.test(url)) {
      return res(200, { id: "n1", kind: "note", name: String(body?.name ?? ""),
        parent_id: body?.parent_id ?? null, sort: 0, case_count: 0, cases: [], children: [] });
    }
    if (method === "POST" && /\/functional-modules\/[^/]+\/delete$/.test(url)) return res(200, { ok: true });
    if (method === "POST" && url.endsWith("/functional-modules")) return res(201, {});
    if (method === "PATCH" && /\/functional-modules\//.test(url)) return res(200, {});
    if (method === "PATCH" && /\/functional-cases\//.test(url)) return res(200, {});
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

function renderMind(over: { canEdit?: boolean; onOpenCase?: (id: string) => void } = {}) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <CaseMindmap projectId="p1" canEdit={over.canEdit ?? true}
        onOpenCase={over.onOpenCase ?? (() => undefined)} />
    </ConfigProvider>,
  );
}

const visibleMenuItems = () => Array.from(document.querySelectorAll<HTMLElement>(
  ".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item"));

async function openMenu(label: string): Promise<void> {
  const btn = screen.getByLabelText("脑图菜单-" + label);
  fireEvent.click(btn); // trigger=["click"]：点一下才挂弹层
  await waitFor(() => expect(visibleMenuItems().length).toBeGreaterThan(0), { timeout: 4000 });
}

async function clickMenuItem(text: string): Promise<void> {
  const el = visibleMenuItems().find((n) => (n.textContent ?? "").includes(text));
  if (!el) throw new Error("菜单里没有「" + text + "」，现有："
    + visibleMenuItems().map((n) => n.textContent).join("/"));
  fireEvent.click(el);
  await new Promise((r) => setTimeout(r, 30));
}

afterEach(cleanup);
beforeEach(() => { cleanup(); mockBackend(); });

describe("用例脑图", () => {
  it("渲染模块/便签/用例叶/未分类组与总数", async () => {
    renderMind();
    await waitFor(() => expect(screen.getByTestId("minder-module-m1")).toBeTruthy());
    expect(screen.getByText("登录")).toBeTruthy();
    expect(screen.getByText("✎ 待确认")).toBeTruthy();
    expect(screen.getByTestId("minder-case-c1").textContent).toContain("登录成功");
    expect(screen.getByTestId("minder-unfiled").textContent).toContain("未分类用例");
    expect(screen.getByTestId("minder-total").textContent).toContain("共 2 条用例");
    const reqs = calls.filter((c) => c.method === "GET" && c.url.includes("/functional-minder"));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].url).toContain("project_id=p1");
  });

  it("点用例叶回调 onOpenCase（组件不自己跳路由）", async () => {
    const open = vi.fn();
    renderMind({ onOpenCase: open });
    await waitFor(() => expect(screen.getByTestId("minder-case-c1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("minder-case-c1"));
    expect(open).toHaveBeenCalledWith("c1");
  });

  it("模块改名走 PATCH /functional-modules/{id}，body 带 project_id", async () => {
    renderMind();
    await waitFor(() => expect(screen.getByTestId("minder-module-m1")).toBeTruthy());
    await openMenu("登录");
    await clickMenuItem("重命名模块");
    const input = await screen.findByTestId("minder-name");
    expect((input as HTMLInputElement).value).toBe("登录");
    fireEvent.change(input, { target: { value: "登录改" } });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/functional-modules/m1"))).toBe(true);
    });
    const c = calls.find((x) => x.method === "PATCH" && x.url.endsWith("/functional-modules/m1"))!;
    expect(c.body).toEqual({ project_id: "p1", name: "登录改" });
    // 改完重拉脑图（不靠本地臆造新树）
    await waitFor(() => expect(calls.filter((x) => x.method === "GET"
      && x.url.includes("/functional-minder")).length).toBe(2));
  });

  it("便签改名走 PATCH /functional-minder/notes/{id}", async () => {
    renderMind();
    await waitFor(() => expect(screen.getByTestId("minder-note-n1")).toBeTruthy());
    await openMenu("待确认");
    await clickMenuItem("重命名便签");
    const input = await screen.findByTestId("minder-name");
    fireEvent.change(input, { target: { value: "已确认" } });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/functional-minder/notes/n1"))).toBe(true);
    });
    expect(calls.find((x) => x.method === "PATCH" && x.url.endsWith("/functional-minder/notes/n1"))!.body)
      .toEqual({ project_id: "p1", name: "已确认" });
  });

  it("新建便签：根层 parent_id=null，POST /functional-minder/notes", async () => {
    renderMind();
    await waitFor(() => expect(screen.getByTestId("minder-add-note")).toBeTruthy());
    fireEvent.click(screen.getByTestId("minder-add-note"));
    const input = await screen.findByTestId("minder-name");
    fireEvent.change(input, { target: { value: "风险点" } });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/functional-minder/notes"))).toBe(true);
    });
    expect(calls.find((x) => x.method === "POST" && x.url.endsWith("/functional-minder/notes"))!.body)
      .toEqual({ project_id: "p1", parent_id: null, name: "风险点" });
  });

  it("删便签 = 二次确认 → POST /functional-minder/notes/{id}/delete", async () => {
    renderMind();
    await waitFor(() => expect(screen.getByTestId("minder-note-n1")).toBeTruthy());
    await openMenu("待确认");
    await clickMenuItem("删除便签");
    const ok = await screen.findByRole("button", { name: /删\s*除\s*便\s*签/ }, { timeout: 2000 });
    fireEvent.click(ok);
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST"
        && c.url.endsWith("/functional-minder/notes/n1/delete"))).toBe(true);
    });
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/functional-minder/notes/n1/delete"))!.body)
      .toEqual({ project_id: "p1", note_id: "n1" });
  });

  it("READONLY：新建/菜单/拖拽入口都不在 DOM", async () => {
    renderMind({ canEdit: false });
    await waitFor(() => expect(screen.getByTestId("minder-module-m1")).toBeTruthy());
    expect(screen.queryByTestId("minder-add-note")).toBeNull();
    expect(screen.queryByTestId("minder-add-module")).toBeNull();
    expect(screen.queryByTestId("minder-menu-m1")).toBeNull();
    expect(screen.queryByTestId("minder-menu-n1")).toBeNull();
  });

  it("取树失败不装成空脑图", async () => {
    mockBackend();
    global.fetch = vi.fn(async () => res(500, { code: "boom", message: "挂了" })) as unknown as typeof fetch;
    renderMind();
    await waitFor(() => expect(screen.getByTestId("minder-error")).toBeTruthy());
    expect(screen.getByTestId("minder-error").textContent).toContain("脑图没取到");
  });
});
