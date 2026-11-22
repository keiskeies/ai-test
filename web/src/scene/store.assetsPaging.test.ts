// D152：资产清单游标分页（loadMoreAssets）的 store 侧单测。病根：load() 每份只发一次
// size=200，next_cursor 只喂 assetsHasMore（防普查撒谎的游标语），清单本体永远看不到
// 第 201 条，也没有任何「加载更多」入口。这里钉追加语义本身（文案/钮在组件侧测试）：
// ① load 把四份 next_cursor 落进各自槽，失败路随之 null；② 追加不 wipe、normal 过滤沿用；
// ③ 游标推进/取全后 hasMore 重算（钮消失的信号）；④ null 游标零请求（配正对照）；
// ⑤ 失败保货保游标可重试，403/500 分因沿用 load 的尺；⑥ busy 门防双击追加重复页；
// ⑦ 换场景 load 重置游标——旧游标串进新场景就是拉错页；⑧ 四槽各走各端点带 cursor；
// ⑨ D152 竞态修正：loadMore 在途时换场景 load，迟到的旧代响应（成功/失败两路）整笔作废。
// 手法照抄 store.assetsFailed.test.ts：jsdom（client.ts 读 localStorage 要那个全局）、
// fetch 整体换按路径回状态的桩；store 是模块单例，beforeEach 显式归零资产态防串腿。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneStore } from "./store";

const SCEN = {
  id: "s1", project_id: "p1", module_id: null, name: "场景", status: "normal", priority: "P2",
  step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true, max_runtime_ms: null,
  env_id: null, owner_id: "u1", project_public: true, version: 3, step_count: 0, issues: [],
  produced: [], last_run_at: null, last_run_status: null, updated_by: "u1",
  created_at: null, updated_at: null,
};

const row = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, project_id: "p1", name: "用例-" + id, priority: "P0", status: "normal", ...over });
const envRow = (id: string) => ({ id, name: "环境-" + id });

interface Route { status?: number; items?: unknown[]; cursor?: string | null; hold?: Promise<void> }
let routes: Record<string, Route> = {};
const calls: string[] = [];
const SLOTS = ["/api-cases", "/ui-cases", "/adb-cases", "/envs"] as const;

function installFetch(): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/scenarios/"))
      return { ok: true, status: 200, json: async () => SCEN } as unknown as Response;
    const frag = SLOTS.find((f) => url.includes(f))!;
    const r = routes[frag] ?? {};
    if (r.hold) await r.hold; // busy 腿：把响应扣在手里，制造「在途」窗口
    if (r.status && r.status !== 200)
      return { ok: false, status: r.status, json: async () => ({ code: "e", message: "错" }) } as unknown as Response;
    const items = r.items ?? [frag === "/envs" ? envRow("e1") : row("c1")];
    return { ok: true, status: 200, json: async () => ({ items, next_cursor: r.cursor ?? null }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const clean = { cases: null, uiCases: null, adbCases: null, envs: null };
const noMore = { cases: false, uiCases: false, adbCases: false, envs: false };
const noBusy = { ...noMore };
const ids = (a: unknown[]) => (a as { id: string }[]).map((x) => x.id);
const cursorCalls = (frag: string) => calls.filter((u) => u.includes(frag) && u.includes("cursor="));

beforeEach(() => {
  routes = {};
  calls.length = 0;
  installFetch();
  useSceneStore.setState({
    projectId: "p1", scenarioId: "s1",
    cases: [], uiCases: [], adbCases: [], envs: [],
    assetsFailed: { ...clean }, assetsHasMore: { ...noMore },
    assetsCursor: { ...clean }, assetsLoadingMore: { ...noBusy },
  } as never);
});

describe("D152 load() 的游标入账与重置", () => {
  it("四份 next_cursor 各归各槽 + hasMore 同步；失败路游标随之 null（不残留旧游标）", async () => {
    routes = { "/api-cases": { cursor: "cur-c" }, "/ui-cases": { cursor: "cur-u" },
      "/adb-cases": { cursor: "cur-a" }, "/envs": { cursor: "cur-e" } };
    await useSceneStore.getState().load("p1", "s1");
    const s = useSceneStore.getState();
    expect(s.assetsCursor).toEqual({ cases: "cur-c", uiCases: "cur-u", adbCases: "cur-a", envs: "cur-e" });
    expect(s.assetsHasMore).toEqual({ cases: true, uiCases: true, adbCases: true, envs: true });
    // 第二轮：cases 挂 500、其余取全——失败槽游标必须 null（load 失败路 next_cursor=null 已有）
    routes = { "/api-cases": { status: 500 } };
    await useSceneStore.getState().load("p1", "s1");
    const t = useSceneStore.getState();
    expect(t.assetsCursor).toEqual({ ...clean });
    expect(t.assetsHasMore).toEqual({ ...noMore });
    expect(t.assetsFailed.cases).toBe("error");
  });

  it("换场景 load 重置游标：旧场景游标残留不得串进新场景（零请求 + 正对照）", async () => {
    routes = { "/api-cases": { cursor: "old-c" }, "/ui-cases": { cursor: "old-u" },
      "/adb-cases": { cursor: "old-a" }, "/envs": { cursor: "old-e" } };
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().assetsCursor.cases).toBe("old-c"); // 前置事实：旧游标确实在
    routes = {}; // 新场景四份都取全
    await useSceneStore.getState().load("p2", "s2");
    const s = useSceneStore.getState();
    expect(s.assetsCursor).toEqual({ ...clean });
    expect(s.assetsHasMore).toEqual({ ...noMore });
    expect(s.assetsLoadingMore).toEqual({ ...noBusy });
    const n = calls.length;
    await useSceneStore.getState().loadMoreAssets("cases"); // 旧游标若残留，这里会拿 old-c 拉错页
    expect(calls.length).toBe(n);
    expect(calls.some((u) => u.includes("cursor=old-"))).toBe(false);
    // 正对照：新场景真有游标时，同一探针发得出请求（防「loadMore 永远不发」的镜像假绿）
    routes = { "/api-cases": { cursor: "new-c" } };
    await useSceneStore.getState().load("p2", "s2");
    await useSceneStore.getState().loadMoreAssets("cases");
    expect(calls.some((u) => u.includes("/api-cases") && u.includes("cursor=new-c"))).toBe(true);
  });
});

describe("D152 loadMoreAssets() 的追加语义", () => {
  it("cases 追加不 wipe + normal 过滤沿用 + 游标推进；请求与 load 同端点同参数 + cursor", async () => {
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    expect(ids(useSceneStore.getState().cases)).toEqual(["c1"]);
    routes = { "/api-cases": { items: [row("c2"), row("cX", { status: "recycled" })], cursor: "cur-2" } };
    await useSceneStore.getState().loadMoreAssets("cases");
    const s = useSceneStore.getState();
    expect(ids(s.cases)).toEqual(["c1", "c2"]); // 追加不 wipe；recycled 不进清单（load 同款过滤）
    expect(s.assetsCursor.cases).toBe("cur-2"); // 游标推进到本页响应
    expect(s.assetsHasMore.cases).toBe(true);
    expect(s.assetsFailed.cases).toBeNull();
    expect(s.assetsLoadingMore.cases).toBe(false);
    const u = cursorCalls("/api-cases").at(-1)!;
    expect(u).toContain("/api-cases");
    expect(u).toContain("project_id=p1");
    expect(u).toContain("size=200");
    expect(u).toContain("cursor=cur-1"); // 用的是手里那页的游标，不是新页的
  });

  it("末页 next_cursor=null → 游标清 null、hasMore 落 false（钮消失的信号）；再点零请求 + 正对照", async () => {
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    routes = { "/api-cases": { items: [row("c2")], cursor: null } };
    await useSceneStore.getState().loadMoreAssets("cases");
    const s = useSceneStore.getState();
    expect(s.assetsCursor.cases).toBeNull();
    expect(s.assetsHasMore.cases).toBe(false);
    expect(ids(s.cases)).toEqual(["c1", "c2"]);
    const n = calls.length;
    await useSceneStore.getState().loadMoreAssets("cases"); // 取全了：no-op
    expect(calls.length).toBe(n);
    // 正对照：游标重新非空（重进场景拉到第一页）时，同一探针发得出请求
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    await useSceneStore.getState().loadMoreAssets("cases");
    expect(calls.length).toBeGreaterThan(n + 1);
  });

  it("null 游标 ⇒ no-op 零请求（四槽都试）；正对照：有游标同一探针非零", async () => {
    await useSceneStore.getState().load("p1", "s1"); // 四份 next_cursor 全 null
    const n = calls.length;
    for (const slot of ["cases", "uiCases", "adbCases", "envs"] as const)
      await useSceneStore.getState().loadMoreAssets(slot);
    expect(calls.length).toBe(n);
    // 正对照：同一份清单游标非空时请求必须发出去（防「no-op 门对谁都关」的假绿）
    routes = { "/envs": { items: [envRow("e1")], cursor: "cur-e" } };
    await useSceneStore.getState().load("p1", "s1");
    const m = calls.length;
    await useSceneStore.getState().loadMoreAssets("envs");
    expect(calls.length).toBe(m + 1);
    expect(ids(useSceneStore.getState().envs)).toEqual(["e1", "e1"]); // 追加语义顺带再钉一次
  });

  it("失败保货保游标：500 不 wipe 已取到的、游标留着可重试；重试成功追加；403 记 denied", async () => {
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    routes = { "/api-cases": { status: 500 } };
    await useSceneStore.getState().loadMoreAssets("cases");
    const s = useSceneStore.getState();
    expect(ids(s.cases)).toEqual(["c1"]); // 货一条不许少
    expect(s.assetsCursor.cases).toBe("cur-1"); // 游标留着
    expect(s.assetsHasMore.cases).toBe(true);
    expect(s.assetsFailed.cases).toBe("error");
    expect(s.assetsLoadingMore.cases).toBe(false); // busy 必须落回，否则永远不能再点
    routes = { "/api-cases": { items: [row("c2")], cursor: null } };
    await useSceneStore.getState().loadMoreAssets("cases"); // 原地重试
    const t = useSceneStore.getState();
    expect(ids(t.cases)).toEqual(["c1", "c2"]);
    expect(t.assetsFailed.cases).toBeNull();
    expect(t.assetsCursor.cases).toBeNull();
    // 403 腿：稳定的权限结论记 denied，不并成「等会儿再试」；货与游标照样保
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    routes = { "/api-cases": { status: 403 } };
    await useSceneStore.getState().loadMoreAssets("cases");
    const u = useSceneStore.getState();
    expect(u.assetsFailed.cases).toBe("denied");
    expect(ids(u.cases)).toEqual(["c1"]);
    expect(u.assetsCursor.cases).toBe("cur-1");
  });

  it("失败不牵连别槽：envs 挂了，cases 的货/游标/失败位一字不动", async () => {
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-c" },
      "/envs": { items: [envRow("e1")], cursor: "cur-e" } };
    await useSceneStore.getState().load("p1", "s1");
    routes = { "/envs": { status: 503 } };
    await useSceneStore.getState().loadMoreAssets("envs");
    const s = useSceneStore.getState();
    expect(s.assetsFailed).toEqual({ ...clean, envs: "error" });
    expect(ids(s.envs)).toEqual(["e1"]);
    expect(s.assetsCursor).toEqual({ ...clean, cases: "cur-c", envs: "cur-e" });
    expect(s.assetsCursor.cases).toBe("cur-c");
  });

  it("busy 防双击：在途重复调用 no-op，只追加一页；落定后再点照常工作（正对照）", async () => {
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    let release!: () => void;
    const hold = new Promise<void>((res) => { release = res; });
    routes = { "/api-cases": { items: [row("c2")], cursor: null, hold } };
    const p1 = useSceneStore.getState().loadMoreAssets("cases");
    expect(useSceneStore.getState().assetsLoadingMore.cases).toBe(true); // 在途位先落
    const p2 = useSceneStore.getState().loadMoreAssets("cases"); // 双击的第二下
    release();
    await Promise.all([p1, p2]);
    expect(cursorCalls("/api-cases")).toHaveLength(1); // 只发了一页的请求
    expect(ids(useSceneStore.getState().cases)).toEqual(["c1", "c2"]); // 没有重复页
    expect(useSceneStore.getState().assetsLoadingMore.cases).toBe(false);
    // 正对照：落定后 busy 门开着，下一轮（新游标）照常追加——防「busy 永远 true」的假绿
    routes = { "/api-cases": { items: [row("c3")], cursor: null } };
    useSceneStore.setState({ assetsCursor: { ...clean, cases: "cur-2" } } as never);
    await useSceneStore.getState().loadMoreAssets("cases");
    expect(ids(useSceneStore.getState().cases)).toEqual(["c1", "c2", "c3"]);
    expect(cursorCalls("/api-cases")).toHaveLength(2);
  });

  it("uiCases/adbCases/envs 各走各端点带 cursor；三份用例 normal 过滤沿用，envs 原样追加", async () => {
    routes = { "/api-cases": { cursor: "cur-c" },
      "/ui-cases": { items: [row("u1")], cursor: "cur-u" },
      "/adb-cases": { items: [row("k1")], cursor: "cur-a" },
      "/envs": { items: [envRow("e1")], cursor: "cur-e" } };
    await useSceneStore.getState().load("p1", "s1");
    routes = {
      "/ui-cases": { items: [row("u2"), row("uX", { status: "recycled" })], cursor: null },
      "/adb-cases": { items: [row("k2"), row("kX", { status: "recycled" })], cursor: null },
      "/envs": { items: [envRow("e2")], cursor: null },
    };
    await useSceneStore.getState().loadMoreAssets("uiCases");
    await useSceneStore.getState().loadMoreAssets("adbCases");
    await useSceneStore.getState().loadMoreAssets("envs");
    const s = useSceneStore.getState();
    expect(ids(s.uiCases)).toEqual(["u1", "u2"]);
    expect(ids(s.adbCases)).toEqual(["k1", "k2"]);
    expect(ids(s.envs)).toEqual(["e1", "e2"]);
    expect(s.assetsCursor).toEqual({ ...clean, cases: "cur-c" }); // 没点的槽游标不动
    expect(s.assetsHasMore).toEqual({ ...noMore, cases: true });
    expect(cursorCalls("/ui-cases").at(-1)).toContain("cursor=cur-u");
    expect(cursorCalls("/ui-cases").at(-1)).toContain("size=200");
    expect(cursorCalls("/adb-cases").at(-1)).toContain("cursor=cur-a");
    expect(cursorCalls("/envs").at(-1)).toContain("cursor=cur-e");
    expect(cursorCalls("/envs").at(-1)).toContain("project_id=p1");
  });
});

// D152 竞态修正：load() 的最终 set 换代（assetsEpoch+1）；loadMoreAssets 发请求前捕获代数，
// 写回前核对，不等即整笔作废。串行测试本表达不出竞态——这里用「扣住响应不放的 hold 桩」
// 把在途窗口钉出来：先让第 2 页请求挂起，再让 load 完整走完，最后才放行迟到响应。
describe("D152 竞态：loadMore 在途期间的迟到响应不得写进新装载代", () => {
  it("迟到成功页整笔作废：旧场景第 2 页在换场景 load 之后才回 ⇒ 不追加、不写游标；正对照：同代响应照常追加", async () => {
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    let release!: () => void;
    const hold = new Promise<void>((res) => { release = res; });
    // 旧场景的第 2 页：响应被 hold 扣住，请求停在在途窗口里
    routes = { "/api-cases": { items: [row("old-2")], cursor: "cur-old", hold } };
    const inflight = useSceneStore.getState().loadMoreAssets("cases");
    expect(useSceneStore.getState().assetsLoadingMore.cases).toBe(true); // 前置事实：确在途
    // 在途期间换场景，且让 load 完整走完（它把 busy 归零、游标/清单整体覆盖）
    routes = { "/api-cases": { items: [row("n1")], cursor: "new-c" } };
    await useSceneStore.getState().load("p2", "s2");
    const after = useSceneStore.getState();
    expect(after.assetsCursor.cases).toBe("new-c"); // 前置事实：换代确实发生了
    const casesIds = ids(after.cases);
    release(); // 旧场景那一页此刻才落地——迟到的响应
    await inflight;
    const s = useSceneStore.getState();
    expect(ids(s.cases)).toEqual(casesIds); // 旧页一条都不许追加进新场景
    expect(s.cases.some((c) => c.id === "old-2")).toBe(false);
    expect(s.assetsCursor.cases).toBe("new-c"); // 旧游标不许串进新槽
    expect(s.assetsHasMore.cases).toBe(true);
    expect(s.assetsFailed.cases).toBeNull(); // 迟到的成功也不许顺手改失败位
    expect(s.assetsLoadingMore.cases).toBe(false); // load 已归零，迟到者不得再写 busy
    // 正对照：同代（无 intervening load）的 loadMore 照常追加——防「门对谁都关」的永久假绿
    routes = { "/api-cases": { items: [row("n2")], cursor: null } };
    await useSceneStore.getState().loadMoreAssets("cases");
    expect(ids(useSceneStore.getState().cases)).toEqual(["n1", "n2"]);
    expect(useSceneStore.getState().assetsCursor.cases).toBeNull();
  });

  it("迟到失败因整笔作废：旧场景 500 在换场景 load 之后才回 ⇒ 不写 assetsFailed/busy；正对照：同代失败照常记 error", async () => {
    routes = { "/api-cases": { items: [row("c1")], cursor: "cur-1" } };
    await useSceneStore.getState().load("p1", "s1");
    let release!: () => void;
    const hold = new Promise<void>((res) => { release = res; });
    routes = { "/api-cases": { status: 500, hold } }; // 迟到的失败路：deferred reject
    const inflight = useSceneStore.getState().loadMoreAssets("cases");
    routes = { "/api-cases": { items: [row("n1")], cursor: "new-c" } };
    await useSceneStore.getState().load("p2", "s2");
    expect(useSceneStore.getState().assetsCursor.cases).toBe("new-c"); // 前置事实：换代
    release();
    await inflight;
    const s = useSceneStore.getState();
    expect(s.assetsFailed.cases).toBeNull(); // 旧代的 500 不许说新场景「没取到」
    expect(ids(s.cases)).toEqual(["n1"]);
    expect(s.assetsCursor.cases).toBe("new-c");
    expect(s.assetsHasMore.cases).toBe(true);
    expect(s.assetsLoadingMore.cases).toBe(false);
    // 正对照：同代 loadMore 失败照常记 error、busy 照常落回——catch 门不是永远关着
    routes = { "/api-cases": { status: 500 } };
    await useSceneStore.getState().loadMoreAssets("cases");
    expect(useSceneStore.getState().assetsFailed.cases).toBe("error");
    expect(useSceneStore.getState().assetsLoadingMore.cases).toBe(false);
  });
});