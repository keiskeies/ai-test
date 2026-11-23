// 个人中心（D198）：资料保存 / API Key 签发与吊销。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import MePage from "./me";
import { useAuth } from "../auth/store";

const PROFILE = {
  id: "u1", account: "admin", name: "系统管理员", email: "a@b.c", is_system_admin: true,
  prefs: { theme: "system", language: "zh-CN" }, created_at: "2026-11-14T16:27:58Z",
};
const KEY = {
  id: "k1", name: "CI", prefix: "tp_abcdefghi", created_at: "2026-11-23T10:00:00+08:00",
  last_used_at: null, expires_at: null, revoked_at: null,
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
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, method, body });
    if (url.endsWith("/personal/profile") && method === "GET") return resp(200, PROFILE);
    if (url.endsWith("/personal/profile") && method === "PATCH") return resp(200, { ...PROFILE, ...body });
    if (url.endsWith("/personal/my-assets")) return resp(200, { counts: { defects: 2, functional_cases: 3 } });
    if (url.endsWith("/personal/recent-projects")) {
      return resp(200, { items: [{ id: "p1", name: "履约", role_code: "PROJECT_ADMIN", updated_at: null }] });
    }
    if (url.endsWith("/personal/api-keys") && method === "GET") return resp(200, { items: [KEY] });
    if (url.endsWith("/personal/api-keys") && method === "POST") {
      return resp(201, { ...KEY, id: "k9", name: body.name, key: "tp_plain_once" });
    }
    if (/\/personal\/api-keys\/k1\/revoke$/.test(url) && method === "POST") return resp(200, { ok: true });
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  useAuth.setState({
    user: { id: "u1", account: "admin", name: "系统管理员", email: "a@b.c", is_system_admin: true, status: "active" },
    project: null, ready: true,
    refreshProject: async () => undefined,
  } as never);
});
afterEach(cleanup);

function renderPage(): void {
  render(<MemoryRouter><MePage /></MemoryRouter>);
}

describe("个人中心", () => {
  it("渲染资料/资产/最近项目/Key", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("CI")).toBeTruthy());
    expect((screen.getByTestId("me-name") as HTMLInputElement).value).toBe("系统管理员");
    expect(screen.getByText("缺陷")).toBeTruthy();
    expect(screen.getByText("履约")).toBeTruthy();
  });

  it("保存资料：PATCH 带 name/email/prefs", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("me-name")).toBeTruthy());
    fireEvent.change(screen.getByTestId("me-name"), { target: { value: "新名字" } });
    fireEvent.click(screen.getByText("保存资料"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "PATCH" && x.url.endsWith("/personal/profile"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ name: "新名字", prefs: { theme: "system", language: "zh-CN" } });
    });
  });

  it("签发 Key：明文只显示一次；吊销走 revoke", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("me-key-new")).toBeTruthy());
    fireEvent.click(screen.getByTestId("me-key-new"));
    fireEvent.change(screen.getByPlaceholderText("名称（如 CI）"), { target: { value: "CI2" } });
    fireEvent.click(screen.getByTestId("me-key-ok"));
    await waitFor(() => expect(screen.getByTestId("me-key-plain").textContent).toContain("tp_plain_once"));
    fireEvent.click(screen.getByTestId("me-key-revoke"));
    await waitFor(() => {
      expect(calls.some((x) => /\/personal\/api-keys\/k1\/revoke$/.test(x.url))).toBe(true);
    });
  });
});
