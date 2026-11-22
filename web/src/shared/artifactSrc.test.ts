// 制品取字节（artifactSrc.ts）单测。node 环境跑（.test.ts 不在 jsdom glob 里）：
// fetch / localStorage / location / antd.message 全桩掉，不起 DOM——与 client.test.ts、
// sse.test.ts 同一约定。URL.createObjectURL 在 node 24 是真实实现，不桩：
// 「返回的是 objectURL、且就是响应字节做的 Blob」用真 URL + 真 Blob 钉最干净。
//
// 模块装配走 client.test.ts 的 load()：resetModules + 真 localStorage/location 再动态 import。
// 必须动态——refreshPromise 是 client 的模块级状态，而 artifactSrc 引它的
// getToken/refreshOnce/onUnauthorized，静态 import 会把所有用例粘在同一个登录态上。
// 同理 ApiErr 用 load() 返回的那份做 instanceof：resetModules 后新旧模块的类身份不同。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("antd", () => ({ message: { error: vi.fn() } }));

type FakeRes = {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  blob: () => Promise<Blob>;
};

const okBlob = (bytes = "PNGBYTES"): FakeRes => ({
  status: 200, ok: true,
  json: async () => { throw new Error("不该走 json：成功路只读 blob"); },
  blob: async () => new Blob([bytes]),
});
const http = (status: number, body: unknown): FakeRes => ({
  status, ok: false,
  json: async () => body,
  blob: async () => new Blob([]),
});
const notJson = (status: number): FakeRes => ({
  status, ok: false,
  json: async () => { throw new TypeError("Unexpected token '<'"); }, // 网关 HTML 页的解析炸法
  blob: async () => new Blob([]),
});
const err401 = { code: "unauthorized", message: "登录状态无效或已过期", details: {} };
const okRefresh = { status: 200, ok: true, json: async () => ({ token: "fresh" }), blob: async () => new Blob([]) };

const ART = "/api/v1/artifacts/";

async function load() {
  vi.resetModules();
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as Record<string, unknown>).location = { hash: "" };
  const art = await import("./artifactSrc");
  const client = await import("../api/client");
  return { art, client };
}

const hash = () => String((globalThis as unknown as { location: { hash: string } }).location.hash);
const artifactCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter((c) => String(c[0]).startsWith(ART));

describe("fetchArtifactBlob", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("URL 构造：runId/name/project_id 各自转义，一个都不许裸奔", async () => {
    const { art, client } = await load();
    client.setToken("tok");
    // 形参要写出来：vi.fn 从实现体推 Mock<[]>，下面按下标取实参就会撞 TS2493
    const f = vi.fn(async (_url: string, _opts?: RequestInit) => okBlob());
    vi.stubGlobal("fetch", f);
    await art.fetchArtifactBlob("run A/1", "shot 1.png", { projectId: "p/1" });
    // 含空格与 / 的入参：少一步 encodeURIComponent，路径段就散了、query 就多一个参数
    expect(String(f.mock.calls[0][0]))
      .toBe("/api/v1/artifacts/run%20A%2F1/shot%201.png?project_id=p%2F1");
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("401 刷得动：恰好两次制品请求，重试带新 access", async () => {
    const { art, client } = await load();
    client.setToken("stale");
    const f = vi.fn(async (url: string, opts?: RequestInit) => {
      if (String(url).endsWith("/auth/refresh")) return okRefresh;
      const auth = (opts?.headers as Record<string, string>)?.Authorization;
      return auth === "Bearer fresh" ? okBlob() : http(401, err401);
    });
    vi.stubGlobal("fetch", f);
    await expect(art.fetchArtifactBlob("r1", "s.txt", { projectId: "p" })).resolves.toMatch(/^blob:/);
    expect(artifactCalls(f)).toHaveLength(2); // 只补这一次，不循环
    const retry = artifactCalls(f)[1][1] as RequestInit;
    expect((retry.headers as Record<string, string>).Authorization).toBe("Bearer fresh");
    expect(hash()).toBe(""); // 刷得动就不许登出
  });

  it("401 但压根没登录：不空转 refresh，一次请求就登出", async () => {
    const { art, client } = await load();
    client.setToken(null);
    const f = vi.fn(async () => http(401, err401));
    vi.stubGlobal("fetch", f);
    await expect(art.fetchArtifactBlob("r1", "s.txt", { projectId: "p" }))
      .rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(f).toHaveBeenCalledTimes(1); // 只有那一次制品请求，/auth/refresh 没被碰
    expect(hash()).toBe("#/login");
  });

  it("401 刷不动（refresh 返非 200）：制品请求仍只有一次", async () => {
    const { art, client } = await load();
    client.setToken("stale");
    const f = vi.fn(async (url: string) =>
      String(url).endsWith("/auth/refresh") ? http(401, err401) : http(401, err401));
    vi.stubGlobal("fetch", f);
    await expect(art.fetchArtifactBlob("r1", "s.txt", { projectId: "p" }))
      .rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(artifactCalls(f)).toHaveLength(1);
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("刷新成功但仍 401：登出 + ApiErr(unauthorized)", async () => {
    const { art, client } = await load();
    const ApiErr = client.ApiErr; // resetModules 后的类身份，静态 import 的那份对不上
    client.setToken("stale");
    const f = vi.fn(async (url: string) =>
      String(url).endsWith("/auth/refresh") ? okRefresh : http(401, err401));
    vi.stubGlobal("fetch", f);
    const p = art.fetchArtifactBlob("r1", "s.txt", { projectId: "p" });
    const err = await p.then(
      () => { throw new Error("本该抛出 ApiErr"); },
      (e: unknown) => e as Error & { code: string; status: number },
    );
    expect(err).toBeInstanceOf(ApiErr);
    expect(err).toMatchObject({ code: "unauthorized", status: 401 });
    expect(client.getToken()).toBeNull(); // 真登出，不是只抛错
    expect(hash()).toBe("#/login");
  });

  it("silent 的 401：照抛 ApiErr，但不踢登出", async () => {
    const { art, client } = await load();
    client.setToken("stale");
    const f = vi.fn(async (url: string) =>
      String(url).endsWith("/auth/refresh") ? okRefresh : http(401, err401));
    vi.stubGlobal("fetch", f);
    await expect(art.fetchArtifactBlob("r1", "s.txt", { projectId: "p", silent: true }))
      .rejects.toMatchObject({ status: 401 });
    // silent 只关「登出副作用」这一扇门：hash 不动、token 还在，调用方自己消化错误
    expect(hash()).toBe("");
    expect(client.getToken()).toBe("fresh"); // refresh 本身照做，只是不再 onUnauthorized
  });

  it("非 401 的错：信封里的 code/message 原样带出", async () => {
    const { art, client } = await load();
    client.setToken("tok");
    const ApiErr = client.ApiErr;
    vi.stubGlobal("fetch", vi.fn(async () => http(404, { code: "artifact_missing", message: "制品不存在" })));
    const err = await art.fetchArtifactBlob("r1", "gone.txt", { projectId: "p" })
      .then(() => null, (e: Error & { code: string }) => e);
    expect(err).toBeInstanceOf(ApiErr);
    expect(err).toMatchObject({ code: "artifact_missing", message: "制品不存在", status: 404 });
  });

  it("非 JSON 错误体：落 http_<status> +「制品取不到」，解析炸不许盖掉真状态码", async () => {
    const { art } = await load();
    vi.stubGlobal("fetch", vi.fn(async () => notJson(502)));
    await expect(art.fetchArtifactBlob("r1", "s.txt", { projectId: "p" }))
      .rejects.toMatchObject({ code: "http_502", message: "制品取不到", status: 502 });
  });

  it("成功：响应字节做成 Blob 换成 objectURL 交还调用方", async () => {
    const { art, client } = await load();
    client.setToken("tok");
    // 真 URL + 真 Blob：createObjectURL 的入参就是响应字节做的 Blob。lib.dom 把它标成
    // Blob | MediaSource，而 expect(...).toBeInstanceOf 不做类型收窄，所以取值处断言
    // 类型、下面运行时的 toBeInstanceOf(Blob) 仍在钉真实身份。
    const created = vi.spyOn(URL, "createObjectURL");
    vi.stubGlobal("fetch", vi.fn(async () => okBlob("PNGBYTES")));
    const url = await art.fetchArtifactBlob("r1", "s.png", { projectId: "p" });
    expect(url).toMatch(/^blob:/);
    expect(created).toHaveBeenCalledTimes(1);
    const blob = created.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("PNGBYTES"); // 内容与响应字节一一对应
    created.mockRestore();
  });
});
