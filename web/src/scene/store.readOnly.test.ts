// D146：load() 的 readOnly 落值口径。病根：readOnly 只有 loadReport/loadCardGraph 两处
// 置 true，编辑器 load() 从不设——缺 scenario:update 的自定义角色进编辑器拿到全套编辑
// affordance，编辑半天保存吃 403。这里钉三件事（fetch 桩手法照 store.assetsFailed.test.ts）：
// ① 成功路径按调用方传入的第三参落值，两向都钉（true→只读；false/缺省→可写，
//    且上一次只读装载的 true 不许残留到下一次可写装载）；
// ② 失败路径（本体 404/403/500）不碰 readOnly——失败页不渲染编辑器，乱设只污染起点；
// ③ loadReport/loadCardGraph 的 readOnly:true 既有语义不被 load 的新参数破坏。
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

/** path 片段 → HTTP 状态；缺省 200（本体回 SCEN，清单回空 Page）。 */
function mockRoutes(status: Record<string, number>): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(status).find(([frag]) => url.includes(frag));
    if (hit && hit[1] !== 200) {
      return { ok: false, status: hit[1], json: async () => ({ code: "e", message: "错" }) } as unknown as Response;
    }
    if (url.includes("/scenarios/")) {
      return { ok: true, status: 200, json: async () => SCEN } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  useSceneStore.setState({ readOnly: false, loadFailure: null });
  vi.restoreAllMocks();
});

describe("load() 的 readOnly 落值（D146）", () => {
  it("传 true（调用方 !can(scenario:update)）→ 成功装载后只读", async () => {
    mockRoutes({});
    await useSceneStore.getState().load("p1", "s1", true);
    expect(useSceneStore.getState().readOnly).toBe(true);
    expect(useSceneStore.getState().loadFailure).toBeNull();
  });

  it("传 false / 缺省 → 可写；上一次只读装载的 true 不许残留（两向都钉，防「对谁都只读」）", async () => {
    mockRoutes({});
    await useSceneStore.getState().load("p1", "s1", true);
    await useSceneStore.getState().load("p1", "s1", false);
    expect(useSceneStore.getState().readOnly).toBe(false);
    await useSceneStore.getState().load("p1", "s1", true);
    await useSceneStore.getState().load("p1", "s1"); // 缺省 = 可写（旧调用方两参兼容）
    expect(useSceneStore.getState().readOnly).toBe(false);
  });

  it("失败路径不碰 readOnly：本体 404/403/500 时既不落 true 也不抹掉既有值", async () => {
    for (const st of [404, 403, 500]) {
      // 前置：先有一次只读装载（loadCardGraph 的既有语义），再撞失败
      useSceneStore.getState().loadCardGraph({ nodes: [], layout: {} });
      expect(useSceneStore.getState().readOnly).toBe(true);
      mockRoutes({ "/scenarios/": st });
      await useSceneStore.getState().load("p1", "s1", false);
      expect(useSceneStore.getState().loadFailure).not.toBeNull();
      expect(useSceneStore.getState().readOnly).toBe(true); // 失败不「乱设」：原值原样
    }
  });

  it("loadReport / loadCardGraph 的 readOnly:true 不被新参数破坏（既有语义回归钉）", async () => {
    mockRoutes({});
    await useSceneStore.getState().load("p1", "s1", false);
    useSceneStore.getState().loadReport("p1", { version: 1, nodes: [] });
    expect(useSceneStore.getState().readOnly).toBe(true);
    await useSceneStore.getState().load("p1", "s1", false);
    useSceneStore.getState().loadCardGraph({ nodes: [], layout: {} });
    expect(useSceneStore.getState().readOnly).toBe(true);
  });
});