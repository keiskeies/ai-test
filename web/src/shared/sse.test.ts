// SSE 订阅的认证/重连单测（1C+ 补：401 走静默刷新这段是新逻辑，此前 sse.ts 一行单测都没有）。
//
// 覆盖的是「401 怎么办」——这条在 e2e/sse.spec.mjs 里没有对应场景（那条测的是真断线重连
// 与 Last-Event-ID 补发，认证自始至终是有效的）。node 环境跑：fetch / localStorage /
// location / antd.message 全桩掉，不起 DOM。
//
// 三条断连路只有 401 在这里测：网络错那条要走 1500ms 重连等待，用真假时钟都要为等待本身
// 写夹具，而它已被 e2e 的真断线场景钉住——不在这重复。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SseHandle } from "./sse";

vi.mock("antd", () => ({ message: { error: vi.fn() } }));

type FakeRes = {
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
  json: () => Promise<unknown>;
};

function streamOf(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

const okStream = (frames: string[] = []): FakeRes => ({
  status: 200, ok: true, body: streamOf(frames), json: async () => ({}),
});
const statusOnly = (status: number): FakeRes => ({
  status, ok: false, body: null, json: async () => ({ code: "unauthorized", message: "x", details: {} }),
});

async function load() {
  vi.resetModules();
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as Record<string, unknown>).location = { hash: "" };
  const sse = await import("./sse");
  const client = await import("../api/client");
  return { sse, client };
}

const frame = (seq: number) => "data: " + JSON.stringify({ seq, ts: null, type: "run_end", payload: {} }) + "\n\n";
const hash = () => String((globalThis as unknown as { location: { hash: string } }).location.hash);

describe("SSE 401 → 静默刷新 / 登出", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  // 断言一抛，写在它后面的 h.close() 就永远执行不到，而那条流里的 pump() 循环还在跑：
  // 它会拿着**下一个用例**的 fetch 桩继续连（1500ms 一轮），于是「测 401」的用例失败会把
  // 后面那个只测 Last-Event-ID 的用例一起带红——红的是无辜者，读报告的人会去查错的地方。
  // 所以句柄一律登记后由 afterEach 统一 close，不靠每个用例自己记得。
  let open: SseHandle[] = [];
  const track = <T extends SseHandle>(h: T): T => { open.push(h); return h; };
  afterEach(() => { for (const h of open) h.close(); open = []; });

  it("过期 401 刷得动就带新 access 重连，事件照常送达", async () => {
    const { sse, client } = await load();
    client.setToken("stale");
    const seen: { url: string; auth: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts?: RequestInit) => {
      const auth = String((opts?.headers as Record<string, string>)?.Authorization ?? "");
      seen.push({ url: String(url), auth });
      if (String(url).endsWith("/auth/refresh")) return { status: 200, ok: true, body: null, json: async () => ({ token: "fresh" }) };
      return auth === "Bearer fresh" ? okStream([frame(1)]) : statusOnly(401);
    }));
    const evs: number[] = [];
    track(sse.openStream("/api/v1/events/run/r1", { onEvent: (e) => void evs.push(e.seq) }));
    await vi.waitFor(() => expect(evs).toEqual([1]));
    expect(seen.map((s) => s.url)).toEqual(["/api/v1/events/run/r1", "/api/v1/auth/refresh", "/api/v1/events/run/r1"]);
    expect(seen[2].auth).toBe("Bearer fresh"); // 重连用的是刷新后的 access
    expect(client.getToken()).toBe("fresh");
    expect(hash()).toBe(""); // 刷得动就不许登出
  });

  it("刷不动就登出并停手，绝不 1500ms 空转重试", async () => {
    const { sse, client } = await load();
    client.setToken("stale");
    let attempts = 0;
    let refreshes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/auth/refresh")) { refreshes++; return { status: 401, ok: false, body: null, json: async () => ({}) }; }
      attempts++;
      return statusOnly(401);
    }));
    track(sse.openStream("/api/v1/events/run/r1", { onEvent: () => undefined }));
    await vi.waitFor(() => expect(hash()).toBe("#/login"));
    expect(client.getToken()).toBeNull();
    // 「停手」必须等过 sse.ts 那 1500ms 重连间隔才算证住：只等几十毫秒的话，
    // 就算代码退回「401 也当网络错、睡 1.5 秒再连」的旧形状，这一轮也还没来得及再连，
    // 断言会照样绿——那就是我要避免的那种不可能红的测试。
    await new Promise((r) => setTimeout(r, 1800));
    expect(attempts).toBe(1);
    expect(refreshes).toBe(1);
  });

  it("刷新成功但仍 401：只补一次就登出，不拿 refresh 打洪", async () => {
    const { sse, client } = await load();
    client.setToken("stale");
    let refreshes = 0;
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshes++;
        return { status: 200, ok: true, body: null, json: async () => ({ token: "fresh" + refreshes }) };
      }
      attempts++;
      return statusOnly(401); // 每次连接都 401，哪怕 access 已经换过
    }));
    track(sse.openStream("/api/v1/events/run/r1", { onEvent: () => undefined }));
    await vi.waitFor(() => expect(hash()).toBe("#/login"));
    await new Promise((r) => setTimeout(r, 1800)); // 同样要越过 1500ms 重连间隔，见上一条测试的理由
    expect(refreshes).toBe(1); // 这一轮断连只许刷一次——否则就是拿 /auth/refresh 打洪
    expect(attempts).toBe(2);  // 首发 + 刷新后重连一次，到此为止
  });

  it("压根没登录（无 token）时不在前端空转：直接登出停手", async () => {
    const { sse, client } = await load();
    client.setToken(null);
    let refreshes = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { refreshes++; return statusOnly(401); }));
    track(sse.openStream("/api/v1/events/run/r1", { onEvent: () => undefined }));
    await vi.waitFor(() => expect(hash()).toBe("#/login"));
    await new Promise((r) => setTimeout(r, 1800)); // 同样要越过 1500ms 重连间隔，见上一条测试的理由
    expect(refreshes).toBe(1); // 只试了那一次连接，没去调 refresh
  });

  it("重连时带 Last-Event-ID，服务端按 seq 补差集", async () => {
    const { sse, client } = await load();
    client.setToken("tok");
    const heads: (string | undefined)[] = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts?: RequestInit) => {
      const hs = opts?.headers as Record<string, string>;
      heads.push(hs["Last-Event-ID"]);
      n++;
      // 第一次给到 seq 7 就断（body 结束 = 服务端断开），第二次带着 cursor 来
      return okStream(n === 1 ? [frame(6), frame(7)] : [frame(8)]);
    }));
    const evs: number[] = [];
    track(sse.openStream("/api/v1/events/run/r1", { onEvent: (e) => void evs.push(e.seq) }));
    // 超时给到 3s：body 读完 = 服务端断线，重连前要等 sse.ts 里那 1500ms 固定间隔，
    // waitFor 默认的 1s 会在第二次连接发起前就先判失败（不是行为问题，是测试时钟）。
    await vi.waitFor(() => expect(evs).toEqual([6, 7, 8]), { timeout: 4000 });
    expect(heads[0]).toBeUndefined();
    expect(heads[1]).toBe("7");
  });
});
