// D202 公开分享页 + 分享按钮：公开读不触发登出、密码门、三类载荷渲染、创建/吊销。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import ShareViewPage from "./shareView";
import ShareButton from "../ui/ShareButton";

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  localStorage.setItem("tp_token", "tok"); // 已登录用户打开分享：401 不许触发登出跳转
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    throw new Error("未 mock: " + url);
  }) as unknown as typeof fetch;
});
afterEach(cleanup);

function renderShare(token = "tok1"): void {
  render(
    <MemoryRouter initialEntries={["/share/" + token]}>
      <Routes><Route path="/share/:token" element={<ShareViewPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("公开分享页", () => {
  it("报告分享：名字/状态/计数上屏，且读公开端点不碰登录态", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return resp(200, {
        type: "report", title: "登录场景",
        report: { id: "r1", subject_name: "登录场景", subject_type: "scenario", status: "failed",
          stats: { total: 3, pass: 2, fail: 1, skip: 0, error: 0 }, error: "步骤 s2 断言失败" },
      });
    }) as unknown as typeof fetch;
    renderShare("abc");
    await waitFor(() => expect(screen.getByTestId("share-report-name").textContent).toBe("登录场景"));
    expect(screen.getByTestId("share-report-status").textContent).toBe("断言失败");
    expect(screen.getByText("步骤 s2 断言失败")).toBeTruthy();
    expect(calls[0]).toBe("/api/v1/share/abc");
    expect(localStorage.getItem("tp_token")).toBe("tok");
  });

  it("密码门：401 password_required 不登出，输对密码后渲染计划报告明细", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes("password=")) {
        return resp(401, { code: "password_required", message: "该分享需要访问密码",
          details: { password_required: true } });
      }
      return resp(200, { type: "plan_report", title: "周报",
        report: { id: "pr1", plan_id: "pl1", name: "周报", status: "done", total: 1,
          passed: 1, failed: 0, executed: 1, executing: 0, created_at: null,
          items: [{ subject_type: "api_case", subject_id: "c1", subject_name: "下单",
            env_id: null, executed: true, executing: false, result: "pass" }] } });
    }) as unknown as typeof fetch;
    renderShare("pwd");
    await waitFor(() => expect(screen.getByTestId("share-password-gate")).toBeTruthy());
    expect(localStorage.getItem("tp_token")).toBe("tok");
    fireEvent.change(screen.getByTestId("share-password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("share-password-submit"));
    await waitFor(() => expect(screen.getByTestId("share-plan-report-name").textContent).toBe("周报"));
    expect(screen.getByText("下单")).toBeTruthy();
    expect(calls[1]).toBe("/api/v1/share/pwd?password=s3cret");
  });

  it("吊销/过期：404 与 410 各说各话，不摆重试", async () => {
    global.fetch = vi.fn(async () => resp(410, { code: "expired", message: "分享已过期" })) as unknown as typeof fetch;
    renderShare("old");
    await waitFor(() => expect(screen.getByTestId("share-fail")).toBeTruthy());
    expect(screen.getAllByText("分享已过期").length).toBeGreaterThan(0);
  });
});

describe("分享按钮", () => {
  it("列出已有链接，创建时 POST body 带目标与可选密码", async () => {
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return resp(201, { id: "s1", token: "newtok", share_path: "/share/newtok",
          target_type: "report", target_id: "r1", title: "报告", has_password: true,
          expires_at: null, revoked_at: null, view_count: 0, last_viewed_at: null, created_at: null });
      }
      return resp(200, { items: [] });
    }) as unknown as typeof fetch;
    render(<MemoryRouter><ShareButton projectId="p1" targetType="report" targetId="r1" title="报告" /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("share-open"));
    await waitFor(() => expect(calls.some((u) => u.includes("/share-links?"))).toBe(true));
    fireEvent.change(screen.getByPlaceholderText("访问密码（可选）"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("share-create"));
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toMatchObject({ project_id: "p1", target_type: "report", target_id: "r1", password: "pw" });
  });
});
