// 画布拖拽换序的落点钉（D115）。
// moveNode 是「先删后插」，而落点下标原先取自**删除前**的数组：往下拖时被拖节点
// 自己那一格会被抽掉，目标因此前移一格 ⇒ 节点落到目标后面第二格。
// 列表模式与画布是两处独立实现的同层「插到其后」，两边都缺这格补偿，故各钉一条。
// 这里跑真实 store（不 spy），钉的是拖完之后的实际顺序，不是传参形状。
import { beforeEach, describe, expect, it } from "vitest";
import { useSceneStore } from "./store";
import type { StepNode } from "./stepTypes";

const topKeys = () => useSceneStore.getState().nodes.map((n) => n.key);

function seed(nodes: StepNode[]): void {
  useSceneStore.setState({ nodes, layout: {}, baselineNodes: "[]", readOnly: false });
}

beforeEach(() => {
  seed([
    { key: "a", kind: "api_case", name: "a" },
    { key: "b", kind: "api_case", name: "b" },
    { key: "c", kind: "api_case", name: "c" },
    { key: "d", kind: "api_case", name: "d" },
  ] as StepNode[]);
});

describe("画布 dropOn 换序落点（同层插到目标之后）", () => {
  it("往下拖：a 落到 b 之后 = a,b,c,d → b,a,c,d（不是 b,c,a,d）", () => {
    useSceneStore.getState().dropOn({ node: "a" }, "b");
    expect(topKeys()).toEqual(["b", "a", "c", "d"]);
  });

  it("往上拖：d 落到 b 之后 = a,b,c,d → a,b,d,c（反向本来就对，钉住别被补偿改坏）", () => {
    useSceneStore.getState().dropOn({ node: "d" }, "b");
    expect(topKeys()).toEqual(["a", "b", "d", "c"]);
  });

  it("跨层往上拖到顶层：被拖不在顶层数组里，删除不挪位 ⇒ 仍插在目标之后", () => {
    seed([
      { key: "a", kind: "api_case", name: "a" },
      { key: "g", kind: "loop", name: "g", children: [{ key: "g.1", kind: "sleep", name: "s" }] },
      { key: "z", kind: "api_case", name: "z" },
    ] as StepNode[]);
    useSceneStore.getState().dropOn({ node: "g.1" }, "a");
    expect(topKeys()).toEqual(["a", "g.1", "g", "z"]);
  });
});
