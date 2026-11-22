// 1B T18：step_graph 图操作（纯 TS）单测。Vitest 点名于 §5.3 / §14。
// 覆盖：round-trip 一致（§14 硬条款）、nextKey 不复用删除 key、moveIntoContainer 拒绝
// 自环、undo 超 50 丢最旧、validateLocal 与后端 T4 同源（同一批畸形图结论一致）。
import { describe, expect, it } from "vitest";
import { fromGraphV1, toGraphV1 } from "./graphOps";
import {
  allKeys,
  countSteps,
  createUndoStack,
  duplicate,
  findByKey,
  insertAfter,
  insertInto,
  moveIntoContainer,
  moveNode,
  nextKey,
  pushUndo,
  redo,
  remove,
  rename,
  reorder,
  toggleDisable,
  undo,
  validateLocal,
  walk,
} from "./graphOps";
import type { Issue } from "./graphOps";
import type { StepNode } from "./stepTypes";

// —— §7.4 文档示例 fixture（除 adb_case 外，与后端 test_scenario_graph.doc_example 同构）——
function docExample(): ReturnType<typeof toGraphV1> {
  return toGraphV1([
    { key: "n1", kind: "api_case", ref: "case-login", name: "登录" },
    { key: "n2", kind: "loop", name: "重试直到成功",
      config: { mode: "while", cond: "ctx.vars.get('ok') != '1'", max_iter: 5 },
      children: [{ key: "n2.1", kind: "api_case", ref: "case-poll", name: "轮询状态" }] },
    { key: "n3", kind: "if",
      config: { branches: [
        { cond: "ctx.vars['code'] == '0'", children: [
          { key: "n3.1", kind: "extract", config: { rules: [{ var: "uid", from: "last_response", expr: "$.id" }] } }] },
        { cond: "else", children: [
          { key: "n3.2", kind: "assert", config: { assertions: [{ type: "status_code", expected: 500 }] } }],
        },
      ] },
    },
    { key: "n4", kind: "foreach", config: { list_var: "users", item_var: "u" },
      children: [{ key: "n4.1", kind: "sleep", config: { ms: 200 } }] },
    { key: "n5", kind: "sleep", config: { ms: 3000 } },
    { key: "n6", kind: "script", config: { code: "ctx.vars['ok'] = '1'" } },
    { key: "n7", kind: "extract", config: { rules: [{ var: "uid", from: "last_response", expr: "$.id" }] } },
  ], { n1: { x: 0, y: 0 }, n2: { x: 0, y: 120 } });
}

function codes(issues: Issue[]): string[] {
  return issues.map((i) => i.code).sort();
}

/** 递归地把节点树按 key 排序后 JSON 化——用「节点集合相等」代替「数组顺序相等」。 */
function sortTopKeys(nodes: StepNode[]): string {
  const norm = nodes.map((n) => sortNode(n));
  return JSON.stringify(norm.sort((a, b) => a.key.localeCompare(b.key)));
}

function sortNode(n: StepNode): StepNode {
  const next = { ...n };
  if (next.kind === "if") {
    const branches = (next.config!.branches as unknown as { cond: string; children: StepNode[] }[]);
    next.config = { ...next.config,
      branches: branches.map((b) => ({ ...b, children: [...b.children].sort(sortByKey) })) };
  } else if (Array.isArray(next.children)) {
    next.children = [...next.children].sort(sortByKey);
  }
  return next;
}

function sortByKey(a: StepNode, b: StepNode): number {
  return a.key.localeCompare(b.key);
}
describe("toGraphV1 / fromGraphV1 round-trip（§14）", () => {
  it("嵌套 if 分支 + loop children + layout + disable + 场景变量全部保持", () => {
    const src = docExample();
    // 构造更重的 graph：if 分支内层叠 loop，带 disable 与场景变量
    const nodes = src.nodes.map((n) => ({ ...n }));
    const n3 = nodes[2] as StepNode;
    const branches = n3.config!.branches as {
      cond: string; children: StepNode[];
    }[];
    branches[0] = {
      cond: branches[0].cond,
      children: [{ key: "n3.1", kind: "loop",
        config: { mode: "count", max_iter: 3 },
        children: [{ key: "n3.1.1", kind: "api_case", ref: "c", name: "内层", disable: true }] }],
    };
    const graph = toGraphV1(nodes, {
      n1: { x: 1, y: 2 },
      n3: { x: 3, y: 4 },
    });
    const viaJson = JSON.parse(JSON.stringify(graph));
    const back = fromGraphV1(viaJson);
    // §14 硬条款：往返后节点树字节等价（lenient 对 key 顺序无要求，逐层比对）
    expect(sortTopKeys(back.nodes)).toEqual(sortTopKeys(nodes));
    expect(() => JSON.stringify(back.nodes)).not.toThrow();
    // 也验证 fromGraphV1 对畸形 graph 不抛异常
    // （D147 起返回值多带一个 rejected 数组：这里同步把形状钉齐，非改判）
    expect(fromGraphV1(null as unknown as never)).toEqual({ nodes: [], layout: {}, rejected: [] });
    expect(fromGraphV1({ nodes: "x" } as unknown as never)).toEqual({ nodes: [], layout: {}, rejected: [] });
    // layout 只带坐标，不承载执行语义
    expect(back.layout["n1"]).toEqual({ x: 1, y: 2 });
    expect(back.layout["n3"]).toEqual({ x: 3, y: 4 });
    // disable 保留
    const found = findAll(back.nodes, "n3.1.1");
    expect(found.length).toBe(1);
    expect(found[0].disable).toBe(true);
    // if 分支 + loop 子级结构完整且顺序正确
    const find3 = findAll(back.nodes, "n3");
    expect(find3.length).toBe(1);
    const b0 = (find3[0].config!.branches as unknown as { children: StepNode[] }[])[0];
    expect(b0.children[0].kind).toBe("loop");
    expect(b0.children[0].key).toBe("n3.1");
    // 场景变量（config.vars/场景变量）也存活
    const extract = findAll(back.nodes, "n7")[0];
    expect(extract.kind).toBe("extract");
    expect((extract.config!.rules as { var: string }[])[0].var).toBe("uid");
  });
});

function findAll(nodes: StepNode[], key: string): StepNode[] {
  const out: StepNode[] = [];
  for (const [n] of walk(nodes)) if (n.key === key) out.push(n);
  return out;
}
describe("nextKey 不复用删除的 key", () => {
  it("删除后 key 不再被分配", () => {
    const used = new Set<string>(["n1", "n2", "n3"]);
    const k = nextKey(used, null);
    expect(k).toBe("n4"); // 从 n1 起扫，跳过已用
  });
  it("base 为容器时分配子 key", () => {
    const used = new Set<string>(["n2", "n1", "n2.1", "n2.2"]);
    expect(nextKey(used, "n2")).toBe("n2.3");
  });
  it("空集合时从 n1 开始", () => {
    expect(nextKey(new Set(), null)).toBe("n1");
  });
});

describe("插入 / 删除 / 重命名 / 禁用 / 排序（不可变）", () => {
  it("insertAfter 在同层 sibling 之后插入", () => {
    const start = docExample().nodes;
    const out = insertAfter(start, "n3", { key: "n8", kind: "sleep", config: { ms: 1 } });
    const keys = topLevelKeys(out);
    const idx = keys.indexOf("n8");
    expect(keys[idx - 1]).toBe("n3");
    expect(keys[0]).toBe("n1"); // 原有的不动
  });
  it("insertAfter 找不到 sibling 不动", () => {
    const start = docExample().nodes;
    const out = insertAfter(start, "no-such", { key: "x", kind: "sleep", config: { ms: 1 } });
    expect(out).toBe(start); // 引用相等 —— 没找到
  });
  it("insertInto 容器末尾（group/loop 走 children）", () => {
    // 用 loop 容器
    const loop: StepNode = { key: "L", kind: "loop", config: { mode: "count", max_iter: 2 }, children: [] };
    const out = insertInto([loop], "L", { key: "L.1", kind: "sleep", config: { ms: 5 } });
    const [l] = findAll(out, "L");
    expect(l.children!.map((c) => c.key)).toEqual(["L.1"]);
  });
  it("insertInto if 插到指定分支", () => {
    const ifn: StepNode = { key: "I", kind: "if",
      config: { branches: [{ cond: "else", children: [] }] } };
    const out = insertInto([ifn], "I", { key: "I.1", kind: "sleep", config: { ms: 5 } }, 0);
    const [i] = findAll(out, "I");
    const b = (i.config!.branches as unknown as { children: StepNode[] }[])[0];
    expect(b.children.map((c) => c.key)).toEqual(["I.1"]);
  });
  it("remove 删除顶层与子树节点", () => {
    const start = docExample().nodes;
    const out = remove(start, "n4");
    expect(findAll(out, "n4").length).toBe(0);
    const out2 = remove(out, "n2");
    expect(findAll(out2, "n2").length).toBe(0);
    expect(findAll(out2, "n2.1").length).toBe(0); // 子树一起没
  });
  it("rename 更新名称，空名保原名", () => {
    const start = docExample().nodes;
    const out = rename(start, "n2", "重试直到成功改名");
    const [n2] = findAll(out, "n2");
    expect(n2.name).toBe("重试直到成功改名");
    const out2 = rename(start, "n2", "   ");
    expect(findAll(out2, "n2")[0].name).toBe("重试直到成功");
  });
  it("toggleDisable 翻转 disable、不存在则不动", () => {
    let out = toggleDisable(docExample().nodes, "n6");
    expect(findAll(out, "n6")[0].disable).toBe(true);
    out = toggleDisable(out, "n6");
    expect(findAll(out, "n6")[0].disable).toBe(false);
    expect(toggleDisable(out, "zzz")).toBe(out);
  });
  it("reorder 搬移同层节点到目标位", () => {
    const out = reorder(docExample().nodes, "n1", 2);
    const keys = topLevelKeys(out);
    expect(keys[2]).toBe("n1");
    expect(keys.length).toBe(docExample().nodes.length);
  });
});

function topLevelKeys(nodes: StepNode[]): string[] {
  return nodes.map((n) => n.key);
}
describe("moveIntoContainer 拒绝把容器塞进自己后代", () => {
  function tree(): StepNode[] {
    return [
      { key: "g1", kind: "group", children: [
        { key: "g2", kind: "group", children: [
          { key: "leaf", kind: "sleep", config: { ms: 1 } },
        ] },
      ] },
      { key: "g3", kind: "group", children: [] },
    ];
  }
  it("拒绝 g1 移入 g2（g2 是 g1 后代）", () => {
    const out = moveIntoContainer(tree(), "g2", "g1");
    expect(out).toBeNull();
  });
  it("拒绝移入自身", () => {
    expect(moveIntoContainer(tree(), "g1", "g1")).toBeNull();
  });
  it("允许 g2 移入 g3（横向）", () => {
    const out = moveIntoContainer(tree(), "g3", "g2");
    expect(out).not.toBeNull();
    // g3.children 现在含 g2；原 g1 里没有 g2
    const g3 = out!.find((n) => n.key === "g3")!;
    expect(g3.children!.map((c) => c.key)).toEqual(["g2"]);
    const g1 = out!.find((n) => n.key === "g1")!;
    expect(g1.children!.length).toBe(0);
  });
});

// T19 补洞（ledger R69）：旧 moveIntoContainer 对顶层节点直接返回 null（findByKey 的
// parentKey 为 null → 「顶层没有祖先可移」），于是「把顶层步骤移进循环」这个最常见
// 手势被静默拒绝；把节点移出容器回顶层同样表达不了。moveNode 是通用形：toParent=null
// 表示顶层，moveIntoContainer 退化为薄包装，上面三条旧测试一字未动仍然全绿。
describe("moveNode 通用移动（顶层⇄容器）", () => {
  function tree(): StepNode[] {
    return [
      { key: "top", kind: "api_case", ref: "c1" },
      { key: "lp", kind: "loop", config: { mode: "count", max_iter: 2 }, children: [
        { key: "kid", kind: "sleep", config: { ms: 1 } },
      ] },
    ];
  }
  it("顶层步骤移进容器（旧 API 拒绝的常见情形）", () => {
    const out = moveNode(tree(), { key: "top", toParent: "lp" });
    expect(out).not.toBeNull();
    expect(out!.map((n) => n.key)).toEqual(["lp"]);
    expect(out![0].children!.map((c) => c.key)).toEqual(["kid", "top"]);
  });
  it("容器子节点移回顶层（toParent=null）", () => {
    const out = moveNode(tree(), { key: "kid", toParent: null });
    expect(out).not.toBeNull();
    expect(out!.map((n) => n.key)).toEqual(["top", "lp", "kid"]);
    expect(out![1].children!.length).toBe(0);
  });
  it("插入位置 index 生效（顶层头部插入）", () => {
    const out = moveNode(tree(), { key: "kid", toParent: null, index: 0 });
    expect(out!.map((n) => n.key)).toEqual(["kid", "top", "lp"]);
  });
  it("移进自己的后代被拒（新路径同守环规）", () => {
    const deep: StepNode[] = [
      { key: "g1", kind: "group", children: [{ key: "g2", kind: "group", children: [] }] },
    ];
    expect(moveNode(deep, { key: "g1", toParent: "g2" })).toBeNull();
    expect(moveNode(deep, { key: "g1", toParent: "g1" })).toBeNull();
  });
  it("目标不存在 / 目标不是容器 → 拒绝", () => {
    expect(moveNode(tree(), { key: "top", toParent: "nope" })).toBeNull();
    expect(moveNode(tree(), { key: "top", toParent: "kid" })).toBeNull();
  });
  it("移动保留整棵子树与原 key（改层级不改协议 key，重命名另有入口）", () => {
    const out = moveNode(tree(), { key: "lp", toParent: "lp2" });
    expect(out).toBeNull(); // lp2 不存在
    const into = moveNode([...tree(), { key: "wrap", kind: "group", children: [] }],
      { key: "lp", toParent: "wrap" });
    expect(into).not.toBeNull();
    const wrap = into!.find((n) => n.key === "wrap")!;
    expect(wrap.children![0].key).toBe("lp");
    expect(wrap.children![0].children!.map((c) => c.key)).toEqual(["kid"]);
  });
  it("顶层移到顶层 = 改顺序；同容器内移动合法", () => {
    const out = moveNode(tree(), { key: "top", toParent: null, index: 1 });
    expect(out!.map((n) => n.key)).toEqual(["lp", "top"]);
    const nest: StepNode[] = [{ key: "g", kind: "group", children: [
      { key: "a", kind: "sleep", config: { ms: 1 } },
      { key: "b", kind: "sleep", config: { ms: 2 } },
    ] }];
    const same = moveNode(nest, { key: "b", toParent: "g" });
    expect(same!.find((n) => n.key === "g")!.children!.map((c) => c.key)).toEqual(["a", "b"]);
  });
  it("if 分支里的节点也能移出去", () => {
    const cond: StepNode[] = [
      { key: "if1", kind: "if", config: { branches: [
        { cond: "else", children: [{ key: "in", kind: "sleep", config: { ms: 1 } }] },
      ] } },
    ];
    const out = moveNode(cond, { key: "in", toParent: null });
    expect(out!.map((n) => n.key)).toEqual(["if1", "in"]);
  });
});

// D116：容器**没带 children 字段**时，编辑面曾静默 no-op。
// 根因在 editList：旧代码只递归 `Array.isArray(node.children)` 的节点，而生产里两个建
// 容器（「成组」「从资产树拖一个 loop」）的地方都不带这个字段，moveNode 的 guard 又放行
// 它们 → 界面当场显示一个空容器，而往里拖一步/移进去/改名/删除全部什么也不做、也不报错。
// 下面标「【红腿】」的三条是变异自证过的：把 editList 改回 Array.isArray 它们同红。
// 标「【对照】」的钉的是同一条路上本来就没坏的地方（以及修复没顺手放开 guard），
// 它们在坏代码上也绿——留着是为了钉住「修复的边界」，别把它们误读成缺陷复现。
describe("容器缺 children 字段（D116：编辑面不再静默 no-op）", () => {
  /** 逐字复刻生产建出来的容器：dropOn 给 config，groupSelected 连 config 都没有。 */
  function childlessTree(): StepNode[] {
    return [
      { key: "a", kind: "sleep", name: "A", config: { ms: 1 } },
      { key: "b", kind: "sleep", name: "B", config: { ms: 2 } },
      { key: "lp", kind: "loop", name: "循环", config: { mode: "count", max_iter: 3 } },
      { key: "grp", kind: "group", name: "分组" },
    ];
  }

  it("【红腿】移进没有 children 字段的 loop / group：真的落进去，不再返回 null", () => {
    const intoLoop = moveNode(childlessTree(), { key: "a", toParent: "lp" });
    expect(intoLoop).not.toBeNull();
    expect(intoLoop!.find((n) => n.key === "lp")!.children!.map((c) => c.key)).toEqual(["a"]);
    const intoGroup = moveNode(childlessTree(), { key: "b", toParent: "grp" });
    expect(intoGroup).not.toBeNull();
    expect(intoGroup!.find((n) => n.key === "grp")!.children!.map((c) => c.key)).toEqual(["b"]);
  });

  it("【红腿】moveIntoContainer（右键「移入容器」入口）同一条通路也活了", () => {
    const out = moveIntoContainer(childlessTree(), "grp", "a");
    expect(out).not.toBeNull();
    expect(out!.find((n) => n.key === "grp")!.children!.map((c) => c.key)).toEqual(["a"]);
  });

  it("【红腿】真的改动时才物化 children:[]，且原树一字不动（不可变）", () => {
    const tree = childlessTree();
    const out = moveNode(tree, { key: "a", toParent: "grp" })!;
    expect(out.find((n) => n.key === "grp")!.children).toEqual([
      { key: "a", kind: "sleep", name: "A", config: { ms: 1 } },
    ]);
    // 原树：a 还在顶层、grp 依旧没有 children 字段
    expect(tree.map((n) => n.key)).toEqual(["a", "b", "lp", "grp"]);
    expect(tree.find((n) => n.key === "grp")!.children).toBeUndefined();
  });

  it("【对照】insertInto 走的是自己那套递归（insertIntoRec），本来就没坏", () => {
    // 坏版也一样绿：insertIntoRec 命中 key 时直接 `children ?? []` 拼新数组，
    // 不依赖 children 字段存在。留这条是钉「两条插入通路都得能吃缺字段的容器」，
    // 不是 D116 的红腿。
    const out = insertInto(childlessTree(), "lp", { key: "new", kind: "sleep", config: { ms: 5 } });
    expect(out.find((n) => n.key === "lp")!.children!.map((c) => c.key)).toEqual(["new"]);
  });

  it("【对照】容器里已有 children 数组时，改名/禁用/删除一直进得去", () => {
    const tree: StepNode[] = [
      { key: "lp", kind: "loop", config: { mode: "count", max_iter: 2 },
        children: [{ key: "k1", kind: "sleep", config: { ms: 1 } }] },
    ];
    expect(findByKey(rename(tree, "lp", "外层循环"), "lp")![0].name).toBe("外层循环");
    expect(findByKey(rename(tree, "k1", "改名"), "k1")![0].name).toBe("改名");
    expect(findByKey(toggleDisable(tree, "k1"), "k1")![0].disable).toBe(true);
    expect(remove(tree, "k1").find((n) => n.key === "lp")!.children).toEqual([]);
  });

  it("【对照】叶子节点仍不是容器：移进 sleep 照样拒绝（修复没把 guard 一起放开）", () => {
    expect(moveNode(childlessTree(), { key: "a", toParent: "b" })).toBeNull();
  });

  it("【对照】无关的 no-op 不改引用、也不把空壳容器物化成 children:[]", () => {
    // 引用语义是调用方的依据：store.removeKey/renameKey 靠 `next === s.nodes` 判
    // 「什么都没改」，dirty 比对与 undo 也吃这个引用。
    const tree = childlessTree();
    expect(remove(tree, "不存在的 key")).toBe(tree);
    expect(insertAfter(tree, "不存在的 key", { key: "x", kind: "sleep" })).toBe(tree);
    expect(tree.find((n) => n.key === "lp")!.children).toBeUndefined();
    expect(tree.find((n) => n.key === "grp")!.children).toBeUndefined();
  });
});

describe("duplicate", () => {
  it("复制一棵子树并给整棵新 key", () => {
    const src: StepNode[] = [
      { key: "n2", kind: "loop", config: { mode: "count", max_iter: 2 },
        children: [{ key: "n2.1", kind: "sleep", config: { ms: 1 } }] },
      { key: "n3", kind: "sleep", config: { ms: 2 } },
    ];
    const before = allKeys(src);
    const out = duplicate(src, "n2");
    const after = allKeys(out);
    // 复制后：原节点都在 + 两大新 key（根与子/孙），key 集合无冲突
    expect(before.size).toBe(3);
    expect(after.size).toBe(5);
    // 副本根的 key 是全新空位（不是 n2/n3，也不与任何现有 key 撞）
    const newKeys = [...after].filter((k) => !before.has(k));
    expect(newKeys.length).toBe(2);
    expect(newKeys[0].startsWith(newKeys[1].split(".")[0]) || newKeys[0].startsWith(newKeys[1]))
      .toBe(true);
    // 副本根是 loop、名字带「副本」，其子树 key 跟随新前缀
    const root = findAll(out, newKeys[0])[0];
    expect(root.kind).toBe("loop");
    expect(root.name).toContain("副本");
    expect(newKeys[1]).toBe(newKeys[0] + ".1");
  });
});

describe("undo / redo 栈", () => {
  it("超 50 后丢最旧", () => {
    const st = createUndoStack<number>(0, 50);
    let s = st;
    for (let i = 1; i <= 60; i++) s = pushUndo(s, i);
    expect(s.present).toBe(60);
    expect(s.past.length).toBe(50);
    // 最旧的 0~10 被丢掉，past 里是 10..59
    expect(s.past[0]).toBe(10);
    expect(s.past[s.past.length - 1]).toBe(59);
  });
  it("undo/redo 行为与 future 清空", () => {
    let s = createUndoStack<number>(1, 10);
    s = pushUndo(s, 2);
    s = pushUndo(s, 3);
    expect(s.present).toBe(3);
    const u1 = undo(s)!;
    expect(u1.present).toBe(2);
    const u2 = undo(u1)!;
    expect(u2.present).toBe(1);
    expect(undo(u2)).toBeNull();
    // redo 走回 2
    const r1 = redo(u2)!;
    expect(r1.present).toBe(2);
    // 提交新状态清空 future
    const push4 = pushUndo(redo(u2)!, 4);
    expect(push4.future.length).toBe(0);
    expect(push4.present).toBe(4);
  });
});

describe("walk / countSteps / findByKey / allKeys", () => {
  it("walk 覆盖 if 分支与 loop children 两处", () => {
    const src = docExample();
    const keys = [...walk(src.nodes)].map(([n]) => n.key);
    expect(keys).toContain("n3.1");
    expect(keys).toContain("n3.2");
    expect(keys).toContain("n4.1");
    expect(keys).toContain("n2.1");
  });
  it("countSteps 数整棵树", () => {
    expect(countSteps(docExample().nodes)).toBe(11); // 7 顶层 + n2.1 + n3.1 + n3.2 + n4.1
  });
  it("findByKey 返回节点与其父 key", () => {
    expect(findByKey(docExample().nodes, "n2.1")![1]).toBe("n2");
    expect(findByKey(docExample().nodes, "zzz")).toBeNull();
  });
});
describe("validateLocal 与后端 T4 同源", () => {
  it("§7.4 示例（除 adb 外）零 issue", () => {
    expect(validateLocal(docExample().nodes)).toEqual([]);
  });
  it("unknown kind 仍拦；ui_case 解禁（R111/1C）；adb_case 解禁（1D）", () => {
    const issues = validateLocal([
      { key: "x", kind: "kafka_send" as never },
    ]);
    expect(codes(issues)).toEqual(["unknown_kind"]);
    // 1C 解禁：带 ref 的 ui_case 零 issue（config 口径 = 只要 ref，后端 graph.py
    // _required_config 无 ui_case 分支，前端对齐）；无 ref → missing_ref。
    const ui = validateLocal([{ key: "u1", kind: "ui_case", ref: "ui-1" }]);
    expect(ui).toEqual([]);
    const uiNoRef = validateLocal([{ key: "u1", kind: "ui_case" }]);
    expect(codes(uiNoRef)).toEqual(["missing_ref"]);
    // 1D 解禁：adb_case 带 ref 零 issue；无 ref → missing_ref。BLOCKED_1B 空表保留，
    // unknown_kind 那条断言就是「表还在、后续新 kind 仍拦」的哨兵。
    const adb = validateLocal([{ key: "u1", kind: "adb_case", ref: "a-1" }]);
    expect(adb).toEqual([]);
    const adbNoRef = validateLocal([{ key: "u1", kind: "adb_case" }]);
    expect(codes(adbNoRef)).toEqual(["missing_ref"]);
    // 1D T8：设备策略与后端 graph._required_config 同尺——缺省=不覆盖（合法），
    // 「指定设备」没选设备要在保存前就报，别等执行到那一步。
    expect(validateLocal([{ key: "u1", kind: "adb_case", ref: "a-1",
      config: { device_policy: "any_idle" } }])).toEqual([]);
    const half = validateLocal([{ key: "u1", kind: "adb_case", ref: "a-1",
      config: { device_policy: "specified" } }]);
    expect(codes(half)).toEqual(["missing_config"]);
    expect(half[0]?.message).toContain("device_serial");
    expect(validateLocal([{ key: "u1", kind: "adb_case", ref: "a-1",
      config: { device_policy: "specified", device_serial: "1.2.3.4:5555" } }])).toEqual([]);
  });
  it("break/continue 在循环外三种位置都报", () => {
    expect(codes(validateLocal([{ key: "b", kind: "break" }]))).toEqual(["break_outside_loop"]);
    const inIf: StepNode[] = [
      { key: "i", kind: "if", config: { branches: [
        { cond: "else", children: [{ key: "i.1", kind: "break" }] }] } },
    ];
    expect(codes(validateLocal(inIf))).toEqual(["break_outside_loop"]);
    const inGroup: StepNode[] = [{ key: "g", kind: "group", children: [{ key: "g.1", kind: "continue" }] }];
    expect(codes(validateLocal(inGroup))).toEqual(["break_outside_loop"]);
  });
  it("循环内的 break/continue 合法", () => {
    const ok = validateLocal([
      { key: "L", kind: "loop", config: { mode: "count", max_iter: 3 },
        children: [{ key: "L.1", kind: "api_case", ref: "c" }, { key: "L.2", kind: "break" }] },
    ]);
    expect(ok).toEqual([]);
    const inForeach = validateLocal([
      { key: "F", kind: "foreach", config: { list_var: "xs", item_var: "x" },
        children: [{ key: "F.1", kind: "continue" }] },
    ]);
    expect(inForeach).toEqual([]);
  });
  it("深度上限 10 / 11 层超限", () => {
    const nest = (d: number): StepNode[] => {
      let cur: StepNode = { key: "leaf", kind: "sleep", config: { ms: 1 } };
      for (let i = d - 1; i >= 1; i--) {
        cur = { key: "L" + i, kind: "loop", config: { mode: "count", max_iter: 2 }, children: [cur] };
      }
      return [cur];
    };
    expect(codes(validateLocal(nest(10)))).toEqual([]);
    expect(codes(validateLocal(nest(11)))).toEqual(["depth_exceeded"]);
  });
  it("duplicate key / bad key / # 非法", () => {
    expect(codes(validateLocal([
      { key: "a", kind: "sleep", config: { ms: 1 } },
      { key: "a", kind: "sleep", config: { ms: 2 } },
    ]))).toEqual(["dup_key"]);
    for (const bad of ["", "n#1", "n 1", "中文", "a.".repeat(30) + "b", "n1."]) {
      expect(codes(validateLocal([{ key: bad, kind: "sleep", config: { ms: 1 } } as StepNode])))
        .toEqual(["bad_key"]);
    }
  });
  it("叶子带 children 拒绝；必填 config 表逐条命中", () => {
    const leaf: StepNode = { key: "x", kind: "sleep", config: { ms: 1 },
      children: [{ key: "y", kind: "sleep", config: { ms: 1 } }] };
    expect(codes(validateLocal([leaf]))).toContain("children_not_allowed");
    const cases: { node: StepNode; expectMsg: string }[] = [
      { node: { key: "x", kind: "http_direct" }, expectMsg: "config.url" },
      { node: { key: "x", kind: "sleep" }, expectMsg: "config.ms" },
      { node: { key: "x", kind: "sleep", config: { ms: 0 } }, expectMsg: "config.ms" },
      { node: { key: "x", kind: "loop", config: { mode: "while", cond: "True" } }, expectMsg: "config.max_iter" },
      { node: { key: "x", kind: "loop", config: { mode: "while", max_iter: 3 } }, expectMsg: "config.cond" },
      { node: { key: "x", kind: "foreach", config: { list_var: "xs" } }, expectMsg: "config.item_var" },
      { node: { key: "x", kind: "script" }, expectMsg: "config.code" },
      { node: { key: "x", kind: "extract", config: { rules: [] } }, expectMsg: "config.rules" },
      { node: { key: "x", kind: "extract", config: { rules: [{ var: "v" }] } }, expectMsg: "config.rules" },
      { node: { key: "x", kind: "assert", config: { assertions: [] } }, expectMsg: "config.assertions" },
      { node: { key: "x", kind: "set_var", config: { vars: {} } }, expectMsg: "config.vars" },
    ];
    for (const c of cases) {
      const issues = validateLocal([c.node]);
      expect(codes(issues)).toEqual(["missing_config"]);
      expect(issues[0].message).toContain(c.expectMsg);
    }
  });
  it("if 缺 branches/空 branches、分支缺 cond、空 children 合法", () => {
    expect(codes(validateLocal([{ key: "x", kind: "if" }]))).toEqual(["missing_config"]);
    expect(codes(validateLocal([{ key: "x", kind: "if", config: { branches: [] } }])))
      .toEqual(["missing_config"]);
    expect(codes(validateLocal([{ key: "x", kind: "if",
      config: { branches: [{ children: [] }] } }]))).toEqual(["empty_cond"]);
    expect(validateLocal([{ key: "x", kind: "if",
      config: { branches: [{ cond: "else", children: [] }] } }])).toEqual([]);
  });
});

// D147：fromGraphV1 的白名单过滤不许静默——被滤掉的原始条目逐字进 rejected。
// 病根：store.load 拿过滤后的 nodes 当基线，saveBody 原样写回 ⇒「打开→什么都没动→保存」
// 就把 Agent 生成/直接改库的畸形步骤写没了。这里钉「逐字」（同引用、不改造、不猜形状）。
describe("fromGraphV1 rejected（D147）", () => {
  it("畸形条目逐字收进 rejected（原对象同引用），合规节点照常载入、顺序不变", () => {
    const good1 = { key: "n1", kind: "sleep", config: { ms: 100 } };
    const good2 = { key: "n2", kind: "api_case", ref: "c" };
    const badNoKey = { kind: "sleep", config: { ms: 1 } }; // 缺 key
    const badNoKind = { key: "n9" };                       // 缺 kind
    const raw = { version: 1, nodes: [good1, badNoKey, "junk", null, 42, badNoKind, good2],
      layout: { n1: { x: 1, y: 2 }, bad: { x: "no" } } };
    const back = fromGraphV1(raw);
    expect(back.nodes).toEqual([good1, good2]);
    expect(back.rejected).toEqual([badNoKey, "junk", null, 42, badNoKind]);
    // 逐字 = 同引用：不改造、不深拷贝、不猜形状（对象条目原样可指认）
    expect(back.rejected[0]).toBe(badNoKey);
    expect(back.rejected[4]).toBe(badNoKind);
    // layout 行为逐字不变：畸形坐标照旧被丢（layout 不是步骤，不进 rejected）
    expect(back.layout).toEqual({ n1: { x: 1, y: 2 } });
  });
  it("正对照：合规图 rejected=[]，nodes/layout 与旧行为逐字一致", () => {
    const src = docExample();
    const back = fromGraphV1(JSON.parse(JSON.stringify(src)));
    expect(back.rejected).toEqual([]);
    expect(sortTopKeys(back.nodes)).toEqual(sortTopKeys(src.nodes));
    expect(back.layout).toEqual(src.layout);
  });
  it("nodes 非数组 / 缺 nodes / 空数组：没有「逐条」可言，rejected=[]（不猜整图形状）", () => {
    expect(fromGraphV1({ version: 1, nodes: "x" }).rejected).toEqual([]);
    expect(fromGraphV1({ version: 1 }).rejected).toEqual([]);
    expect(fromGraphV1({ version: 1, nodes: [] })).toEqual({ nodes: [], layout: {}, rejected: [] });
    expect(fromGraphV1(undefined).rejected).toEqual([]);
  });
});
