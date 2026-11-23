// 附件卡（D195）：列表 / 上传（blob→link）/ 移除 / 只读门。
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

import Attachments from "./Attachments";

const FILE = {
  id: "b1", sha256: "x".repeat(64), size: 1024, mime: "text/plain", original_name: "a.txt",
};
const LINK = {
  id: "l1", target_type: "bug", target_id: "d1", role: "attachment",
  display_name: "a.txt", blob: FILE, created_by: "u1", created_by_name: "张三",
  created_at: "2026-11-23T10:00:00+08:00",
};

const calls: { url: string; method: string; body: unknown }[] = [];

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
    if (url.includes("/files/blobs") && method === "POST") return resp(200, { blob: FILE });
    if (/\/attachments\?/.test(url) && method === "GET") {
      return resp(200, { items: [LINK] });
    }
    if (url.endsWith("/attachments") && method === "POST") {
      return resp(201, { created: 1, skipped: 0 });
    }
    if (/\/attachments\/l1\/delete$/.test(url) && method === "POST") return resp(200, { ok: true });
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
});
afterEach(cleanup);

describe("附件卡", () => {
  it("渲染附件；上传走 blob → link", async () => {
    render(<Attachments projectId="p1" targetType="bug" targetId="d1" canWrite />);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    expect(screen.getByText("1.0 KB")).toBeTruthy();
    const input = screen.getByTestId("attachment-input");
    fireEvent.change(input, { target: { files: [new File(["hello"], "a.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("/files/blobs"))).toBe(true));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/attachments"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1", target_type: "bug", target_id: "d1", blob_ids: ["b1"],
      });
    });
  });

  it("移除调用 unlink", async () => {
    render(<Attachments projectId="p1" targetType="bug" targetId="d1" canWrite />);
    await waitFor(() => expect(screen.getByTestId("attachment-delete")).toBeTruthy());
    fireEvent.click(screen.getByTestId("attachment-delete"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/attachments\/l1\/delete$/.test(x.url));
      expect(c).toBeTruthy();
    });
  });

  it("只读：没有上传/移除钮", async () => {
    render(<Attachments projectId="p1" targetType="bug" targetId="d1" canWrite={false} />);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeTruthy());
    expect(screen.queryByTestId("attachment-upload")).toBeNull();
    expect(screen.queryByTestId("attachment-delete")).toBeNull();
  });
});
