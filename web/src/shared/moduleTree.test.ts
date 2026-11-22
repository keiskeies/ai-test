// 1C T14：模块树共用纯件（flatten / ownModuleIds / purgeDetachedClauses）单测。
// purgeDetachedClauses 钉的是 ModuleTree 彻底删除回执缺陷：旧代码只认
// detached_definitions / detached_scenarios，UI 模块 purge 回的是 detached_elements，
// 「N 个元素转为未分类」会被静默算成 0（成功提示说错话，R112 同型缺陷）；
// R122 又补了第二侧——UI 模块挂着用例时 detached_cases 也被漏掉。
import { describe, expect, it } from "vitest";
import { flatten, ownModuleIds, purgeDetachedClauses, subtreeIds, type PurgeReceipt } from "./moduleTree";
import type { ModNode } from "../api/ModuleTree";

function node(id: string, name: string, children: ModNode[] = []): ModNode {
  return { id, parent_id: null, name, sort: 0, status: "normal", count: 0, children };
}

// 两棵树：root > (a, b > b1)；root2 独立
const tree: ModNode[] = [
  node("root", "根", [node("a", "甲"), node("b", "乙", [node("b1", "乙一")])]),
  node("root2", "根二"),
];

describe("flatten：树摊平成下拉选项（缩进表层级）", () => {
  it("深度优先 + 每层一个全角空格缩进", () => {
    expect(flatten(tree)).toEqual([
      { value: "root", label: "根" },
      { value: "a", label: "　甲" },
      { value: "b", label: "　乙" },
      { value: "b1", label: "　　乙一" },
      { value: "root2", label: "根二" },
    ]);
  });
  it("空树 → 空数组", () => {
    expect(flatten([])).toEqual([]);
  });
});

describe("ownModuleIds：按模块筛选的集合（只有该模块自己）", () => {
  // T23 收裁（台账 R120）：这函数以前叫 subtreeIds、注释写「子树（含自身）」，
  // 而实现从来收集不到子孙（命中之后对每个孩子 walk(c) 是在子树里再找同一个 id，
  // 永远 null）。裁的是**改字不改行为**：后端树徽标明写「count=直属未回收元素+用例」
  // （ui_test/module_services.py:100），列表若把子孙模块的行算进来，点一个徽标写 3
  // 的模块会出 7 行——徽标与列表打架比「不含子模块」严重得多。
  // 于是三页文案一起落到「选中模块」，函数名与注释落到实际语义。
  // 真要做子树过滤，得连后端徽标口径一起改，那是产品决定。
  it("命中只返回 {自身}，反向钉「不含子孙」（与徽标同口径，不是半成品）", () => {
    expect(ownModuleIds(tree, "root")).toEqual(new Set(["root"]));
    expect(ownModuleIds(tree, "b")).toEqual(new Set(["b"]));
    // 反向钉：子孙的 id 明确不在集合里（哪天有人「顺手修好」它，这条会红并逼他去看徽标口径）
    expect(ownModuleIds(tree, "root")!.has("b1")).toBe(false);
    expect(ownModuleIds(tree, "b")!.has("b1")).toBe(false);
  });
  it("叶子只含自身；找不到返回 null（调用方视为不过滤）", () => {
    expect(ownModuleIds(tree, "b1")).toEqual(new Set(["b1"]));
    expect(ownModuleIds(tree, "nope")).toBeNull();
    expect(ownModuleIds([], "root")).toBeNull();
  });
  it("场景页 / UI 元素页仍走本函数：它们的后端徽标还是直属数", () => {
    // 业主裁定（D47-b §五·1）只把**接口树**的徽标改成子树数，另两棵树没动。
    // 谁要是把这里也「顺手改成子树」，那两页立刻变成「徽标 3、列表 7 行」——R120 的原话。
    // 这条钉的是「差异是有意的」，不是「还没改完」。
    expect(ownModuleIds(tree, "b")).toEqual(new Set(["b"]));
    expect(subtreeIds(tree, "b")).toEqual(new Set(["b", "b1"]));
  });
});

describe("subtreeIds：接口页的模块过滤集合（含全部子孙，D47-b §五·1）", () => {
  it("命中返回自身 + 全部子孙，且只有这些", () => {
    expect(subtreeIds(tree, "root")).toEqual(new Set(["root", "a", "b", "b1"]));
    expect(subtreeIds(tree, "b")).toEqual(new Set(["b", "b1"]));
    // 反向钉：兄弟子树与另一棵根都不许进来（收多了就是筛选说谎）
    expect(subtreeIds(tree, "b")!.has("a")).toBe(false);
    expect(subtreeIds(tree, "b")!.has("root")).toBe(false);
    expect(subtreeIds(tree, "a")!.has("root")).toBe(false);
  });
  it("叶子只含自身；找不到返回 null（与 ownModuleIds 同款语义）", () => {
    expect(subtreeIds(tree, "b1")).toEqual(new Set(["b1"]));
    expect(subtreeIds(tree, "root2")).toEqual(new Set(["root2"]));
    expect(subtreeIds(tree, "nope")).toBeNull();
    expect(subtreeIds([], "root")).toBeNull();
  });
  it("三层以上一次收全（递归深度是这函数唯一会错的地方）", () => {
    const deep: ModNode[] = [node("L0", "0", [node("L1", "1", [node("L2", "2", [node("L3", "3")])])])];
    expect(subtreeIds(deep, "L0")).toEqual(new Set(["L0", "L1", "L2", "L3"]));
    expect(subtreeIds(deep, "L1")).toEqual(new Set(["L1", "L2", "L3"]));
    expect(subtreeIds(deep, "L2")).toEqual(new Set(["L2", "L3"]));
  });
  it("子孙的子孙重复 id 不会把递归打死（Set 收敛 + 每节点只访问一次）", () => {
    // 真实数据里 id 唯一，这条防的是「哪天有人改成 push 进数组」时递归/去重行为变化。
    const kids = [node("x1", "x1"), node("x2", "x2", [node("x3", "x3")])];
    const got = subtreeIds([node("x", "x", kids)], "x");
    expect(got).toEqual(new Set(["x", "x1", "x2", "x3"]));
    expect(got!.size).toBe(4);
  });
});

describe("purgeDetachedClauses：三棵模块树的彻底删除回执都要接住", () => {
  const r = (extra: Partial<PurgeReceipt>): PurgeReceipt =>
    ({ purged_modules: 2, ...extra });
  it("api 树：detached_definitions → 「N 个接口转为未分类」", () => {
    expect(purgeDetachedClauses(r({ detached_definitions: 5 }), "接口"))
      .toEqual(["5 个接口转为未分类"]);
  });
  it("场景树：detached_scenarios", () => {
    expect(purgeDetachedClauses(r({ detached_scenarios: 3 }), "场景"))
      .toEqual(["3 个场景转为未分类"]);
  });
  it("UI 树：detached_elements（缺陷回归：旧链式取值漏掉这个键 → 从句整个丢掉）", () => {
    expect(purgeDetachedClauses(r({ detached_elements: 1 }), "元素"))
      .toEqual(["1 个元素转为未分类"]);
  });
  // R122：UI 模块真的装用例（种子的「演示：登录工作台」就在 UI 演示模块里），
  // purge 也把 UiCase.module_id 一并置空。旧消息只报元素那一侧，同场转出的用例被漏掉——
  // 少说一件事的成功提示仍然是说错话（R112 同型，只是这次漏的是第二个键）。
  it("UI 树两侧都有：元素与用例各说一句，谁也不吞谁", () => {
    expect(purgeDetachedClauses(r({ detached_elements: 1, detached_cases: 2 }), "元素"))
      .toEqual(["1 个元素转为未分类", "2 条 UI 用例转为未分类"]);
  });
  it("只有用例那一侧转出（空模块挂着用例）也要说话", () => {
    expect(purgeDetachedClauses(r({ detached_elements: 0, detached_cases: 1 }), "元素"))
      .toEqual(["1 条 UI 用例转为未分类"]);
  });
  it("回执没有任何转出键 → 空数组（调用方据此省略整个从句）", () => {
    expect(purgeDetachedClauses(r({}), "元素")).toEqual([]);
  });
});
