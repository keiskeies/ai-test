// D266 Skills 管理页：目录同步报告、启停、全文查看（Markdown）、无管理位只读。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SkillTab from "./SkillTab";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

interface Call { url: string; method: string; body?: string }

function skill(over: Record<string, unknown> = {}) {
  return {
    id: "s1", name: "api-scenario-gen", description: "把接口用例编排成场景",
    source: "builtin", allowed_tools: ["get_project_outline", "search_test_assets"],
    enabled: true, synced_at: "2026-11-24T10:00:00+00:00", ...over,
  };
}

function mockFetch(items = [skill()], syncReport: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    const ok = (status: number, data: unknown) => ({ ok: true, status, json: async () => data }) as unknown as Response;
    if (url.endsWith("/skills") && method === "GET") return ok(200, { items });
    if (url.endsWith("/skills/sync")) {
      return ok(200, { added: ["beta"], updated: ["alpha"], removed: ["old"], unchanged: 3,
        errors: [{ file: "/bad/SKILL.md", error: "frontmatter 没有闭合的 ---" }],
        scanned_dir: "/repo/backend/skills", ...syncReport });
    }
    if (/\/skills\/[^/]+\/toggle$/.test(url)) {
      return ok(200, { ...items[0], enabled: JSON.parse(String(init?.body)).enabled });
    }
    if (/\/skills\/[^/]+$/.test(url)) {
      return ok(200, { ...items[0], body: "# 指引\n\n先调用 `get_project_outline`。\n\n- 一步\n- 两步" });
    }
    return ok(200, { items });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => cleanup());

describe("列表", () => {
  it("名称/来源/描述/allowed-tools/状态如实上屏", async () => {
    mockFetch();
    render(<SkillTab canManage />);
    await screen.findByTestId("skill-table");
    expect(screen.getByText("api-scenario-gen")).not.toBeNull();
    expect(screen.getByText("把接口用例编排成场景")).not.toBeNull();
    expect(screen.getByText("目录")).not.toBeNull();
    expect(screen.getAllByTestId("skill-tool").map((n) => n.textContent))
      .toEqual(["get_project_outline", "search_test_assets"]);
    expect(screen.getByTestId("skill-state").getAttribute("data-state")).toBe("on");
  });

  it("列表失败：出诚实告警，不装空态", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ code: "internal", message: "炸了" }),
    })) as unknown as typeof fetch;
    render(<SkillTab canManage />);
    expect(await screen.findByTestId("skill-load-failed")).not.toBeNull();
  });
});

describe("同步", () => {
  it("报告新增/变更/移除/未变与逐文件错误，并刷新列表", async () => {
    const calls = mockFetch();
    render(<SkillTab canManage />);
    await screen.findByTestId("skill-table");
    fireEvent.click(screen.getByTestId("skill-sync"));
    const report = await screen.findByTestId("skill-sync-report");
    expect(report.textContent).toContain("新增 1");
    expect(report.textContent).toContain("变更 1");
    expect(report.textContent).toContain("移除 1");
    expect(report.textContent).toContain("未变 3");
    expect(screen.getByTestId("skill-sync-dir").textContent).toContain("/repo/backend/skills");
    expect(screen.getByTestId("skill-sync-error").textContent).toContain("frontmatter");
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/skills") && c.method === "GET").length)
      .toBeGreaterThan(1));
  });
});

describe("启停与查看", () => {
  it("停用走 toggle，body 是 {enabled:false}", async () => {
    const calls = mockFetch();
    render(<SkillTab canManage />);
    await screen.findByTestId("skill-table");
    fireEvent.click(screen.getByTestId("skill-toggle-s1"));
    fireEvent.click(await screen.findByRole("button", { name: /确\s*定/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/skills/s1/toggle"))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/skills/s1/toggle"))!.body!);
    expect(body).toEqual({ enabled: false });
  });

  it("查看：抽屉里渲染 Markdown 与 allowed-tools", async () => {
    mockFetch();
    render(<SkillTab canManage />);
    await screen.findByTestId("skill-table");
    fireEvent.click(screen.getByTestId("skill-view-s1"));
    const body = await screen.findByTestId("skill-body");
    expect(body.textContent).toContain("指引");
    expect(body.textContent).toContain("先调用");
    expect(body.querySelector("h1")).not.toBeNull();
    expect(body.querySelectorAll("li").length).toBe(2);
  });

  it("无管理位：同步与启停 disabled，查看仍可用", async () => {
    mockFetch();
    render(<SkillTab canManage={false} />);
    await screen.findByTestId("skill-table");
    expect((screen.getByTestId("skill-sync") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("skill-toggle-s1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("skill-view-s1") as HTMLButtonElement).disabled).toBe(false);
  });
});
