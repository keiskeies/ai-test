// load() 把四份清单的失败原因分开记账（assetsFailed），这里钉记账本身。
//
// 病根：四份请求全部 `.catch` 成空数组。吞掉错误的后果不是「少一份数据」，是界面跟着
// 说谎——AssetTree 与顶栏拿 `length === 0` 当证据，对着一次 500 或一个 403 说
// 「项目里还没有可用的用例」。所以这里不测文案（文案在 AssetTree.test.tsx），只测：
// ① 取到了就记 null（空数组是事实，不许被顺手记成失败）；
// ② 403 记 "denied"、其余记 "error"——两者混成一个 "error" 就等于把稳定的权限结论
//    说成「等会儿再试」；
// ③ 一份挂掉不牵连另一份的记账（Promise.all 只允许场景本体那一路 reject）。
// node 环境：只 import store，fetch 整体换成按路径回状态的桩。
// client.ts 读 localStorage 取 token，node 环境没有这个全局，故本文件整体切到 jsdom
// （不是组件测试，只是要那个全局；纯 store 逻辑照常直跑）。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneStore, selectDirty } from "./store";

const SCEN = {
  id: "s1", project_id: "p1", module_id: null, name: "场景", status: "normal", priority: "P2",
  step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true, max_runtime_ms: null,
  env_id: null, owner_id: "u1", project_public: true, version: 3, step_count: 0, issues: [],
  produced: [], last_run_at: null, last_run_status: null, updated_by: "u1",
  created_at: null, updated_at: null,
};

/** 一份 URL 对应的成功响应（场景本体走单对象，清单走 Page）。 */
function routeResponse(input: RequestInfo | URL): Response {
  const url = String(input);
  if (url.includes("/scenarios/")) {
    return { ok: true, status: 200, json: async () => SCEN } as unknown as Response;
  }
  const item = url.includes("/envs")
    ? { id: "e1", name: "dev" }
    : { id: "c1", project_id: "p1", name: "用例", priority: "P0", status: "normal" };
  return {
    ok: true, status: 200,
    json: async () => ({ items: [item], next_cursor: null }),
  } as unknown as Response;
}

/** path 片段 → HTTP 状态。缺省 200 + 一条 normal 行。 */
function mockRoutes(status: Record<string, number>): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(status).find(([frag]) => url.includes(frag));
    if (hit && hit[1] !== 200) {
      return { ok: false, status: hit[1], json: async () => ({ code: "e", message: "错" }) } as unknown as Response;
    }
    return routeResponse(input);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  useSceneStore.setState({ assetsFailed: { cases: "error", uiCases: "error", adbCases: "error", envs: "error" } });
  vi.restoreAllMocks();
});

const clean = { cases: null, uiCases: null, adbCases: null, envs: null };

describe("load() 的清单失败记账（assetsFailed）", () => {
  it("四份全 200：清空上一轮的失败位，全记 null（空数组是事实不是故障）", async () => {
    mockRoutes({});
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().assetsFailed).toEqual(clean);
    expect(useSceneStore.getState().cases).toHaveLength(1);
  });

  it("403 记 denied、500 记 error：把权限结论并进「没取到」= 喊人等一会儿", async () => {
    mockRoutes({ "/api-cases": 403, "/ui-cases": 500, "/envs": 403 });
    await useSceneStore.getState().load("p1", "s1");
    const f = useSceneStore.getState().assetsFailed;
    expect(f.cases).toBe("denied");
    expect(f.uiCases).toBe("error");
    expect(f.envs).toBe("denied");
    expect(f.adbCases).toBeNull();
  });

  it("一份挂掉不改别人的账：失败的那份摊平为空数组，成功的那份照常列行", async () => {
    mockRoutes({ "/ui-cases": 503 });
    await useSceneStore.getState().load("p1", "s1");
    const s = useSceneStore.getState();
    expect(s.assetsFailed).toEqual({ ...clean, uiCases: "error" });
    expect(s.uiCases).toEqual([]);
    expect(s.cases).toHaveLength(1);
    expect(s.adbCases).toHaveLength(1);
    expect(s.loading).toBe(false);
  });

  it("网络层抛错（没有状态码）按 error 记，不因为拿不到 status 就当成取到了", async () => {
    const ok = routeResponse;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/adb-cases")) throw new TypeError("Failed to fetch");
      return ok(input);
    }) as unknown as typeof fetch;
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().assetsFailed.adbCases).toBe("error");
    expect(useSceneStore.getState().assetsFailed.cases).toBeNull();
  });
});

// D144：本体（`sceneApi.get` 那一路）以前不 catch，一抛就让 `loading:false` 到不了——
// 404（已回收）与 403（没读权限）都是一句一闪而过的 toast 加一个永久转圈。
// 这里钉三件事：① 本体挂了 loading 也必须落 false（转圈本身就是缺陷）；
// ② 三种原因分开记（口径同 adbCaseDetail.tsx:234-252），403 不许说成「等一会儿」；
// ③ 本体挂了草稿必须归零 ⇒ dirty 恒 false，否则失败页上那个「返回」会被离开拦截扣住。
// 正对照在最后：成功路径必须记 null，否则「一律说没取到」也能全绿。
describe("load() 的本体失败记账（D144）", () => {
  beforeEach(() => {
    useSceneStore.setState({
      loading: false, scenario: null, nodes: [], baselineNodes: "[]", envs: [],
      assetsFailed: { ...clean }, loadFailure: null,
    });
  });

  it("本体 404：loadFailure=missing，且 loading 必须落 false（永久转圈就是缺陷本身）", async () => {
    mockRoutes({ "/scenarios/": 404 });
    await useSceneStore.getState().load("p1", "s1");
    const s = useSceneStore.getState();
    expect(s.loadFailure).toEqual({ kind: "missing" });
    expect(s.loading).toBe(false);
    expect(s.scenario).toBeNull();
  });

  it("本体 403：记 denied 并带上那个 ApiErr（权限空页要读后端原话的权限位）", async () => {
    mockRoutes({ "/scenarios/": 403 });
    await useSceneStore.getState().load("p1", "s1");
    const f = useSceneStore.getState().loadFailure;
    expect(f?.kind).toBe("denied");
    expect(f?.kind === "denied" ? f.err.status : null).toBe(403);
  });

  it("500 与网络层抛错都只记 error：把故障说成「已被回收」= 让人去回收站捞一条好端端的场景", async () => {
    mockRoutes({ "/scenarios/": 500 });
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().loadFailure).toEqual({ kind: "error" });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/scenarios/")) throw new TypeError("Failed to fetch");
      return routeResponse(input);
    }) as unknown as typeof fetch;
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().loadFailure).toEqual({ kind: "error" });
  });

  it("本体挂了不牵连清单：清单照常入账，各自的失败位照常记", async () => {
    mockRoutes({ "/scenarios/": 404, "/envs": 403, "/ui-cases": 500 });
    await useSceneStore.getState().load("p1", "s1");
    const s = useSceneStore.getState();
    expect(s.loadFailure).toEqual({ kind: "missing" });
    expect(s.assetsFailed).toEqual({ ...clean, envs: "denied", uiCases: "error" });
    expect(s.cases).toHaveLength(1); // 取到的那份不许被连坐清空
  });

  it("本体挂了而本地有未保存草稿：草稿归零 ⇒ dirty=false，失败页的「返回」不被离开拦截扣住", async () => {
    useSceneStore.setState({
      scenario: SCEN as never, nodes: [{ key: "a", kind: "sleep", name: "旧场景的一步", config: {} }] as never,
      baselineNodes: "[]", // 与 nodes 不等 = 脏
    });
    expect(selectDirty(useSceneStore.getState())).toBe(true); // 前置事实：动手前确实是脏的
    mockRoutes({ "/scenarios/": 404 });
    await useSceneStore.getState().load("p1", "s1");
    const s = useSceneStore.getState();
    expect(s.nodes).toEqual([]);
    expect(selectDirty(s)).toBe(false);
  });

  it("正对照：本体取到了就记 null（「一律说没取到」的写法在这里先红）", async () => {
    mockRoutes({});
    useSceneStore.setState({ loadFailure: { kind: "error" } }); // 上一次的失败不许跟过来
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().loadFailure).toBeNull();
    expect(useSceneStore.getState().scenario).toBeTruthy();
  });
});
