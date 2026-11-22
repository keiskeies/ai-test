// loadCardGraph 往返测（1F T4）：1B 的「画布序列化必测往返」同款纪律——
// graph JSON 序列化 → loadCardGraph 反序列化进 store → store 现状必须与入参逐字一致。
// 只 import store（纯 zustand 模块，无 React/DOM），node 环境即可跑。
import { beforeEach, describe, expect, it } from "vitest";
import { selectDirty, useSceneStore } from "./store";

/** 一个带齐各形状的候选图：容器 children、config、layout、disable、
 *  还有一颗带 est_steps 的节点数据——往返丢哪个都会红。 */
function candidateGraph() {
  return JSON.parse(JSON.stringify({
    version: 1,
    nodes: [
      { key: "login", kind: "api_case", name: "登录", ref: "case-1",
        config: { est_steps: ["打开登录页", "输入账号密码", "断言跳转首页"] } },
      { key: "flow", kind: "loop", name: "重试轮询", disable: true,
        config: { mode: "count", max_iter: 3 },
        children: [
          { key: "flow.sleep", kind: "sleep", name: "等待", config: { ms: 1000 } },
          { key: "flow.assert", kind: "assert", name: "断言",
            config: { assertions: [{ type: "status", expected: 200 }] } },
        ] },
    ],
    layout: { login: { x: 0, y: 0 }, flow: { x: 0, y: 120 },
      "flow.sleep": { x: 0, y: 240 }, "flow.assert": { x: 0, y: 360 } },
  }));
}

beforeEach(() => {
  // store 是模块级单例：每条用例前把画布状态复位成「非只读空画布」，互不串扰
  useSceneStore.setState({
    readOnly: false, nodes: [], layout: {}, baselineNodes: "[]",
    selectedKey: null, selectedKeys: [], serverIssues: [], scenario: null,
    run: { open: false, trigger: null, runId: null, phase: "idle", errorText: null,
      finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false,
      downStrikes: 0 },
  });
});

describe("loadCardGraph（候选卡只读预览装载）", () => {
  it("往返一致：graph 序列化 → 装载 → store 的 nodes/layout 与入参逐字相等", () => {
    const graph = candidateGraph();
    const before = JSON.stringify(graph);
    useSceneStore.getState().loadCardGraph(graph);
    const s = useSceneStore.getState();
    expect(JSON.stringify({ version: 1, nodes: s.nodes, layout: s.layout })).toBe(before);
    // 节点级数据逐个点名：est_steps 这类卡片附带字段不许在装载时被丢掉
    expect(s.nodes[0].config?.est_steps).toEqual(["打开登录页", "输入账号密码", "断言跳转首页"]);
    expect(s.nodes[1].children?.[1].config?.assertions).toEqual([{ type: "status", expected: 200 }]);
    expect(s.layout["flow.assert"]).toEqual({ x: 0, y: 360 });
  });

  it("装载后进入只读：readOnly 置真、dirty 恒假、不残留选中/问题", () => {
    useSceneStore.getState().loadCardGraph(candidateGraph());
    const s = useSceneStore.getState();
    expect(s.readOnly).toBe(true);
    expect(s.scenario).toBeNull();
    expect(selectDirty(s)).toBe(false);
    expect(s.selectedKey).toBeNull();
    expect(s.serverIssues).toEqual([]);
  });

  it("候选没跑过：stepStatus 染色层必须为空（绝不复用 loadReport 塞假 result）", () => {
    const graph = candidateGraph();
    // 就算 graph 里混进了 result 字段（候选形状不该有），也不许被读成执行染色
    (graph.nodes[0] as Record<string, unknown>).result = { status: "pass" };
    useSceneStore.getState().loadCardGraph(graph);
    const s = useSceneStore.getState();
    expect(s.run.stepStatus).toEqual({});
    expect(s.run.phase).toBe("idle");
    expect(s.run.runId).toBeNull();
  });

  it("畸形 graph 不抛：非对象/缺 nodes 一律装载为空画布", () => {
    for (const bad of [undefined, null, "not-a-graph", 42, [], { nodes: "x" }]) {
      expect(() => useSceneStore.getState().loadCardGraph(bad)).not.toThrow();
      expect(useSceneStore.getState().nodes).toEqual([]);
      expect(useSceneStore.getState().readOnly).toBe(true);
    }
  });
});
