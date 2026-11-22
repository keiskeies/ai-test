// D147：畸形步骤不许静默消失。病根：fromGraphV1 白名单过滤 + load() 拿过滤后的 nodes
// 当基线 + saveBody 原样写回 ⇒「打开→什么都没动→保存」就把 Agent 生成/直接改库的
// 畸形 step_graph 条目写没了（backend handlers.py:807 自认来源）。这里钉四件事
// （fetch 桩手法照 store.readOnly.test.ts）：
// ① load 把被滤条目逐字落 graphRejected（同引用），合规图 rejected=[]，每次 load 重置
//    （含本体失败路径 blankDraft）；
// ② save 在 graphRejected 非空时早退——写请求（sceneApi.update 走 PATCH）零发出，
//    话走 422 同款 refused+serverIssues 路径；正对照：rejected=[] 时 save 照常发；
// ③ loadReport 同样入账；loadCardGraph 逐字往返零过滤、字段重置不串台；
// ④ 409 冲突快照带走 serverRejected，takeServer 采纳服务器树时落 graphRejected——
//    「用服务器」不许当场把畸形步骤洗掉，下一次 save 照样被拦。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneStore } from "./store";

const GOOD = { key: "n1", kind: "sleep", name: "等待", config: { ms: 1000 } };
const BAD_NO_KEY = { kind: "sleep", config: { ms: 5 } }; // 缺 key：isStepNode 拒
const BAD_NO_KIND = { key: "n2" };                       // 缺 kind：isStepNode 拒
const DIRTY_GRAPH = { version: 1, nodes: [GOOD, BAD_NO_KEY, "junk", BAD_NO_KIND], layout: {} };
const CLEAN_GRAPH = { version: 1, nodes: [GOOD], layout: {} };

const SCEN = {
  id: "s1", project_id: "p1", module_id: null, name: "场景", status: "normal", priority: "P2",
  step_graph: CLEAN_GRAPH, variables: {}, fail_fast: true, max_runtime_ms: null,
  env_id: null, owner_id: "u1", project_public: true, version: 3, step_count: 0, issues: [],
  produced: [], last_run_at: null, last_run_status: null, updated_by: "u1",
  created_at: null, updated_at: null,
};

interface Call { method: string; url: string; body?: Record<string, unknown> }
let calls: Call[] = [];
let scenGraph: unknown = CLEAN_GRAPH;
let scenVersion = 3;
let getStatus = 200;   // 本体 GET 的状态（404 腿用）
let patchStatus = 200; // 更新 PATCH 的状态（409 腿用）

function mockFetch(): void {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (url.includes("/scenarios/")) {
      if (method === "PATCH") {
        if (patchStatus !== 200) {
          return { ok: false, status: patchStatus, json: async () => ({ code: "conflict", message: "版本冲突" }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ ...SCEN, version: scenVersion }) } as unknown as Response;
      }
      if (getStatus !== 200) {
        return { ok: false, status: getStatus, json: async () => ({ code: "not_found", message: "场景不存在" }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ...SCEN, version: scenVersion, step_graph: scenGraph }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 写请求 = PATCH/PUT（sceneApi.update 实际走 PATCH；「PUT 零发出」按写请求口径数）。 */
const writes = () => calls.filter((c) => c.method === "PATCH" || c.method === "PUT");

beforeEach(() => {
  scenGraph = CLEAN_GRAPH; scenVersion = 3; getStatus = 200; patchStatus = 200;
  useSceneStore.setState({ graphRejected: [], refused: false, serverIssues: [], conflict: null,
    loadFailure: null, saving: false, overrideFailed: null });
  vi.restoreAllMocks();
  mockFetch();
});

describe("load() 落 graphRejected（D147）", () => {
  it("①畸形图：被滤条目逐字入账（同引用、不改造），合规节点照常载入", async () => {
    scenGraph = DIRTY_GRAPH;
    await useSceneStore.getState().load("p1", "s1");
    const s = useSceneStore.getState();
    expect(s.loadFailure).toBeNull();
    expect(s.nodes).toEqual([GOOD]);
    expect(s.graphRejected).toEqual([BAD_NO_KEY, "junk", BAD_NO_KIND]);
    expect(s.graphRejected[0]).toBe(BAD_NO_KEY); // 逐字 = 原对象同引用
    expect(s.graphRejected[2]).toBe(BAD_NO_KIND);
    expect(s.baselineNodes).toBe(JSON.stringify([GOOD])); // 基线只含合规节点（dirty 判据不变）
  });

  it("①正对照 + 重置：合规图 graphRejected=[]；脏→净→脏每次 load 都重置，不残留", async () => {
    await useSceneStore.getState().load("p1", "s1"); // 净
    expect(useSceneStore.getState().graphRejected).toEqual([]);
    scenGraph = DIRTY_GRAPH;
    await useSceneStore.getState().load("p1", "s1"); // 脏
    expect(useSceneStore.getState().graphRejected).toHaveLength(3);
    scenGraph = CLEAN_GRAPH;
    await useSceneStore.getState().load("p1", "s1"); // 净：上一次的 rejected 不许残留
    expect(useSceneStore.getState().graphRejected).toEqual([]);
  });

  it("①失败路径：本体 404 → blankDraft 把 graphRejected 归零（失败页不背上一场的账）", async () => {
    scenGraph = DIRTY_GRAPH;
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().graphRejected).toHaveLength(3);
    getStatus = 404;
    await useSceneStore.getState().load("p1", "s1");
    expect(useSceneStore.getState().loadFailure).not.toBeNull();
    expect(useSceneStore.getState().graphRejected).toEqual([]);
  });
});

describe("save() 早退门（D147）", () => {
  it("②graphRejected 非空：写请求零发出，refused+serverIssues 说人话（含数量）", async () => {
    scenGraph = DIRTY_GRAPH;
    await useSceneStore.getState().load("p1", "s1");
    await useSceneStore.getState().save();
    const s = useSceneStore.getState();
    expect(writes()).toHaveLength(0); // 一个写请求都不许发——发出去就是把畸形步骤写没
    expect(s.refused).toBe(true);
    expect(s.saving).toBe(false);
    const issue = s.serverIssues.find((i) => i.code === "graph_rejected");
    expect(issue).toBeTruthy();
    expect(issue!.message).toContain("3 个步骤形状不合规未载入画布");
    expect(issue!.message).toContain("先修复图再保存");
    expect(s.scenario!.version).toBe(3); // 版本没动：保存确实没发生
  });

  it("②正对照：rejected=[] 时 save 照常——恰一个 PATCH，图原样进请求体", async () => {
    await useSceneStore.getState().load("p1", "s1"); // CLEAN_GRAPH
    await useSceneStore.getState().save();
    const s = useSceneStore.getState();
    expect(writes()).toHaveLength(1);
    expect(writes()[0].method).toBe("PATCH");
    expect(writes()[0].url).toContain("/scenarios/s1");
    expect((writes()[0].body!.step_graph as { nodes: unknown }).nodes).toEqual([GOOD]);
    expect(s.refused).toBe(false);
    expect(s.serverIssues.find((i) => i.code === "graph_rejected")).toBeUndefined();
  });
});

describe("loadReport / loadCardGraph 的 graphRejected 口径（D147）", () => {
  it("③loadReport 过白名单同样入账；loadCardGraph 逐字往返零过滤、字段重置不串台", () => {
    useSceneStore.getState().loadReport("p1", DIRTY_GRAPH);
    let s = useSceneStore.getState();
    expect(s.nodes).toEqual([GOOD]);
    expect(s.graphRejected).toEqual([BAD_NO_KEY, "junk", BAD_NO_KIND]);
    // 候选卡预览：同一张畸形图逐字渲染（不静默丢），graphRejected 重置为 []
    useSceneStore.getState().loadCardGraph(DIRTY_GRAPH);
    s = useSceneStore.getState();
    expect(s.nodes).toEqual([GOOD, BAD_NO_KEY, "junk", BAD_NO_KIND]);
    expect(s.graphRejected).toEqual([]);
  });
});

describe("409 → takeServer 不许洗掉畸形步骤（D147）", () => {
  it("④冲突快照带 serverRejected；「用服务器」落 graphRejected，下一次 save 仍被拦", async () => {
    await useSceneStore.getState().load("p1", "s1"); // 本地净图，save 放行
    patchStatus = 409; scenVersion = 4; scenGraph = DIRTY_GRAPH; // 服务器侧已改成畸形图
    await useSceneStore.getState().save();
    let s = useSceneStore.getState();
    expect(writes()).toHaveLength(1); // 第一次 save 正常发出，撞 409
    expect(s.conflict).not.toBeNull();
    expect(s.conflict!.serverVersion).toBe(4);
    expect(s.conflict!.serverRejected).toEqual([BAD_NO_KEY, "junk", BAD_NO_KIND]);
    useSceneStore.getState().takeServer();
    s = useSceneStore.getState();
    expect(s.nodes).toEqual([GOOD]); // 采纳的是过滤后的服务器树
    expect(s.graphRejected).toEqual([BAD_NO_KEY, "junk", BAD_NO_KIND]); // 但被滤条目必须可观察
    expect(s.conflict).toBeNull();
    await useSceneStore.getState().save(); // 再保存：仍被拦，不许把服务器的畸形步骤写没
    s = useSceneStore.getState();
    expect(writes()).toHaveLength(1); // 零新增写请求
    expect(s.refused).toBe(true);
  });
});