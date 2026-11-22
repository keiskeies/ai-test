// 保存请求在途期间的编辑不许被记成「已保存」（D181）。
//
// 病根：save() 的请求体是发起时的快照 saveBody(s)，可基线原先写的是 await 之后的
// getState()——在途那一格里用户又改了一笔，那一笔没进这次请求，却进了基线，
// 于是脏点熄灭：界面说「已保存」，库里没有这一笔。forceSaveWithVersion 同款。
//
// 现有 save 相关测试（store.saveAssertions / ConflictModal / DebugDrawer / SceneEditor）
// 全部在请求 resolve 之后才动状态，快照 == 完成态，两版实现逐字节相同 ⇒ 这条窗口
// 从来没人钉过。所以本文件的价值不在「跑绿」，而在**能红**：把基线改回 getState()
// 就必须看见它红（变异取证见台账）。
// node 环境：只用 store（纯 zustand 模块），不碰 React/DOM。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectDirty, useSceneStore } from "./store";
import { sceneApi } from "../api/scene";
import type { StepNode } from "./stepTypes";

type ScenarioOut = Awaited<ReturnType<typeof sceneApi.update>>;

const SCEN = {
  id: "s1", project_id: "p1", module_id: null, name: "场景", status: "normal", priority: "P2",
  step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true, max_runtime_ms: null,
  env_id: null, owner_id: "u1", project_public: true, version: 3, step_count: 0, issues: [],
  produced: [], last_run_at: null, last_run_status: null, updated_by: "u1",
  created_at: null, updated_at: null,
} as unknown as ScenarioOut;

const A = { key: "a", kind: "sleep", name: "甲", config: { ms: 10 } } as unknown as StepNode;
const B = { key: "b", kind: "sleep", name: "乙", config: { ms: 20 } } as unknown as StepNode;

/** 手工可控的 promise：让测试自己决定「请求什么时候回」，编辑才能精确落在在途那一格。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => {
    resolve = r;
  });
  return { p, resolve };
}

beforeEach(() => {
  useSceneStore.setState({
    readOnly: false, scenario: SCEN, projectId: "p1",
    nodes: [A], baselineNodes: JSON.stringify([A]), layout: {},
    envId: null, baselineEnvId: null, variables: {}, baselineVariables: "{}",
    failFast: true, baselineFailFast: true, maxRuntimeMs: null, baselineMaxRuntimeMs: null,
    commonAssertions: [], baselineCommonAssertions: "[]", serverIssues: [], conflict: null,
    refused: false, saving: false,
  });
  vi.restoreAllMocks();
});

describe("保存请求在途窗口的编辑归属", () => {
  it("画布保存期间加的一步：脏点必须还亮着（那一笔没进这次请求）", async () => {
    const gate = deferred<ScenarioOut>();
    const sent: unknown[] = [];
    vi.spyOn(sceneApi, "update").mockImplementation(async (_id, body) => {
      sent.push(body);
      return gate.p;
    });

    const done = useSceneStore.getState().save();
    expect(useSceneStore.getState().saving, "请求应仍在途").toBe(true);

    // 在途那一格：用户在画布上又加了一步
    useSceneStore.getState().apply((nodes) => [...nodes, B]);

    gate.resolve({ ...SCEN, version: 4 });
    await done;

    const s = useSceneStore.getState();
    expect(sent.length, "只发过一次请求").toBe(1);
    // 服务器确实只收到甲：这一步钉「发出去的是什么」，防止有人拿回显糊弄下面的脏断言
    const graph = (sent[0] as { step_graph: { nodes: { key: string }[] } }).step_graph;
    expect(graph.nodes.map((n) => n.key)).toEqual(["a"]);
    // 关键否决位：库里没有乙 ⇒ 不能宣称已保存
    expect(s.nodes.map((n) => n.key)).toEqual(["a", "b"]);
    expect(selectDirty(s), "在途编辑未落库，脏点不许熄").toBe(true);
  });

  it("同窗口里删掉的一步：同样不许被记成已同步", async () => {
    useSceneStore.setState({ nodes: [A, B], baselineNodes: JSON.stringify([A, B]) });
    const gate = deferred<ScenarioOut>();
    vi.spyOn(sceneApi, "update").mockImplementation(() => gate.p);

    const done = useSceneStore.getState().save();
    useSceneStore.getState().apply((nodes) => nodes.filter((n) => n.key !== "b"));
    gate.resolve({ ...SCEN, version: 4 });
    await done;

    const s = useSceneStore.getState();
    // 请求发的是 [a,b]，用户随后删了 b：库里还留着 b ⇒ 与本地不一致，必须亮脏
    expect(s.nodes.map((n) => n.key)).toEqual(["a"]);
    expect(selectDirty(s)).toBe(true);
  });

  it("覆盖保存（forceSaveWithVersion）同款：在途编辑留给下一次", async () => {
    const gate = deferred<ScenarioOut>();
    const sent: unknown[] = [];
    vi.spyOn(sceneApi, "update").mockImplementation(async (_id, body) => {
      sent.push(body);
      return gate.p;
    });

    const done = useSceneStore.getState().forceSaveWithVersion(9);
    useSceneStore.getState().apply((nodes) => [...nodes, B]);
    gate.resolve({ ...SCEN, version: 10 });
    expect(await done).toBe(true);

    const s = useSceneStore.getState();
    const graph = (sent[0] as { step_graph: { nodes: { key: string }[] } }).step_graph;
    expect(graph.nodes.map((n) => n.key)).toEqual(["a"]); // 覆盖请求也只带发起时那份
    expect(selectDirty(s), "冲突弹窗里覆盖成功也不该吞掉在途编辑").toBe(true);
  });

  it("对照：窗口内不动状态 → 保存后照旧不脏（防止把脏判据改坏来糊弄上面三条）", async () => {
    vi.spyOn(sceneApi, "update").mockImplementation(async (_id, body) => ({
      ...SCEN, version: 4, ...(body as object),
    }));
    expect(selectDirty(useSceneStore.getState())).toBe(false);
    await useSceneStore.getState().save();
    expect(selectDirty(useSceneStore.getState())).toBe(false);
  });
});
