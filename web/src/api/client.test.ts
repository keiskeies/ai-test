// refresh-and-retry 拦截器单测（蓝图 §3.4 refresh 半区的前端半边）。
// node 环境跑：antd 的 message 与全局 fetch / localStorage / location 全部桩掉，
// 不起 DOM——与被测代码的约定一致（client.ts 只碰这三样浏览器 API）。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("antd", () => ({ message: { error: vi.fn() } }));

type FakeRes = { status: number; ok: boolean; json: () => Promise<unknown> };
const res = (status: number, body: unknown): FakeRes => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

/** 每个用例重新装配模块图：refreshPromise 是模块级状态，必须隔离。 */
async function load() {
  vi.resetModules();
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as Record<string, unknown>).location = { hash: "" };
  const client = await import("./client");
  return { client, fetchMock: vi.fn() };
}

const err401 = { code: "unauthorized", message: "登录状态无效或已过期", details: {} };

describe("401 → 单次 refresh → 重试原请求", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes_once_and_retries_original_request", async () => {
    const { client } = await load();
    client.setToken("old-token");
    const calls: { url: string; auth?: string }[] = [];
    const f = vi.fn(async (url: string, opts?: RequestInit) => {
      const auth = (opts?.headers as Record<string, string>)?.["Authorization"];
      calls.push({ url, auth });
      if (url.endsWith("/auth/refresh")) return res(200, { token: "new-token" });
      if (auth === "Bearer old-token") return res(401, err401);
      return res(200, { items: [] });
    });
    vi.stubGlobal("fetch", f);
    const out = await client.get<{ items: unknown[] }>("/projects");
    expect(out).toEqual({ items: [] });
    expect(client.getToken()).toBe("new-token");
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/projects", "/api/v1/auth/refresh", "/api/v1/projects"]);
    expect(calls[2].auth).toBe("Bearer new-token");
  });

  it("concurrent_401s_share_one_refresh_no_stampede", async () => {
    const { client } = await load();
    client.setToken("old-token");
    let refreshCount = 0;
    const f = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCount++;
        // 故意慢一点：让三个 401 都落到同一个 refreshPromise 上
        await new Promise((r) => setTimeout(r, 10));
        return res(200, { token: "new-token" });
      }
      const auth = (opts?.headers as Record<string, string>)?.["Authorization"];
      return auth === "Bearer new-token" ? res(200, { ok: true }) : res(401, err401);
    });
    vi.stubGlobal("fetch", f);
    const outs = await Promise.all([client.get("/projects"), client.get("/roles"), client.get("/users")]);
    expect(outs).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshCount).toBe(1);
  });

  it("refresh_failure_falls_back_to_logout", async () => {
    const { client } = await load();
    client.setToken("old-token");
    const f = vi.fn(async (url: string) =>
      url.endsWith("/auth/refresh") ? res(401, err401) : res(401, err401));
    vi.stubGlobal("fetch", f);
    await expect(client.get("/projects")).rejects.toMatchObject({ status: 401 });
    // 登出兜底：token 清掉、hash 指向登录页
    expect(client.getToken()).toBeNull();
    expect((globalThis as unknown as { location: { hash: string } }).location.hash).toBe("#/login");
    // refresh 只试一次，不重试原请求
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/auth/refresh"))).toHaveLength(1);
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/projects"))).toHaveLength(1);
  });

  it("retry_that_401s_again_does_not_loop", async () => {
    const { client } = await load();
    client.setToken("old-token");
    const f = vi.fn(async (url: string) =>
      url.endsWith("/auth/refresh") ? res(200, { token: "new-token" }) : res(401, err401));
    vi.stubGlobal("fetch", f);
    await expect(client.get("/projects")).rejects.toMatchObject({ status: 401 });
    // 原请求恰好两次（首发 + 一次重试），refresh 恰好一次
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/projects"))).toHaveLength(2);
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/auth/refresh"))).toHaveLength(1);
    expect(client.getToken()).toBeNull(); // 最终仍 401 → 登出
  });

  it("login_401_never_triggers_refresh", async () => {
    const { client } = await load();
    const f = vi.fn(async () => res(401, { code: "bad_credentials", message: "账号或密码错误", details: {} }));
    vi.stubGlobal("fetch", f);
    await expect(client.post("/auth/login", { account: "a", password: "b" })).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1); // 只有 login 自己，没有 refresh
    // 登录失败留在登录页：不清 hash、不清 token 也不跳登录（原语义）
    expect((globalThis as unknown as { location: { hash: string } }).location.hash).toBe("");
  });

  it("success_path_is_untouched", async () => {
    const { client } = await load();
    client.setToken("tok");
    const f = vi.fn(async () => res(200, { hi: 1 }));
    vi.stubGlobal("fetch", f);
    expect(await client.get("/healthz")).toEqual({ hi: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
