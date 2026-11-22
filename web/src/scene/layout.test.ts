// 画布自动布局（layout.ts）单测。node 环境跑（.test.ts 不在 jsdom glob 里）：
// 被测是纯函数 nodes → LayoutMap，elk.bundled 在 node 下能真跑（内置降级路径，实测 ~100ms），
// 所以 happy path 用真 ELK，不起 DOM、不碰渲染层。
// 回落路径（elk.layout 抛错 → fallbackLayout）才是这里的重头戏：生产里它只活在
// catch 分支里，e2e 永远走不到，只有 vi.doMock 换掉 ELK 类才钉得住。回落 describe
// 放文件最后，且只经 resetModules + 动态 import 拿被 mock 的实例——静态 import
// 早已绑定真 ELK，上面的用例不受污染。
import { describe, expect, it, vi } from "vitest";
import { NODE_H, NODE_W, autoLayout, flattenTree } from "./layout";
import type { StepNode } from "./stepTypes";

// 最小 StepNode fixture（形状抄 graphOps.test.ts 的文档示例）：含 loop children 与
// if 分支——分支子节点住在 config.branches[].children，childrenOf 会拼平带出来。
function tree(): StepNode[] {
  return [
    { key: "a", kind: "api_case", name: "登录" },
    { key: "b", kind: "loop", children: [{ key: "b.1", kind: "sleep" }] },
    { key: "c", kind: "if", config: { branches: [
      { cond: "ctx.vars['ok'] == '1'", children: [{ key: "c.1", kind: "assert" }] },
      { cond: "else", children: [{ key: "c.2", kind: "extract" }, { key: "c.3", kind: "script" }] },
    ] } },
    { key: "d", kind: "set_var" },
  ];
}

describe("常量钉死（§11.7.3）", () => {
  it("步骤节点 224×64 与规格同源", () => {
    expect(NODE_W).toBe(224);
    expect(NODE_H).toBe(64);
  });
});

describe("flattenTree", () => {
  it("空树给空数组", () => {
    expect(flattenTree([])).toEqual([]);
  });

  it("前序展开任意深度：if 分支子节点必须在场，parentKey 逐条对线", () => {
    const flat = flattenTree(tree());
    // 顺序即遍历序（父先于子、同层按数组序），parentKey 是 autoLayout 生成边的唯一依据
    expect(flat.map((f) => [f.node.key, f.parentKey])).toEqual([
      ["a", null],
      ["b", null],
      ["b.1", "b"],
      ["c", null],
      ["c.1", "c"],
      ["c.2", "c"],
      ["c.3", "c"],
      ["d", null],
    ]);
  });
});

describe("autoLayout（真 ELK）", () => {
  it("空输入走早退分支：{} 而不是把空图喂给 elk", async () => {
    await expect(autoLayout([])).resolves.toEqual({});
  });

  it("小树上每个 key 都有整数坐标（Math.round 生效）", async () => {
    const map = await autoLayout(tree());
    expect(Object.keys(map).sort()).toEqual(flattenTree(tree()).map((f) => f.node.key).sort());
    for (const pos of Object.values(map)) {
      expect(Number.isInteger(pos.x)).toBe(true);
      expect(Number.isInteger(pos.y)).toBe(true);
    }
  }, 15000); // ELK worker 冷启动在慢机上会超 vitest 默认 5s
});

describe("autoLayout 回落（elk.layout 抛错 → fallbackLayout）", () => {
  it("保底坐标：齐全、绝不重叠、逐层右移、放置序上 y 严格递增", async () => {
    let elkCalls = 0;
    vi.resetModules();
    vi.doMock("elkjs/lib/elk.bundled.js", () => ({
      default: class DeadELK {
        async layout(): Promise<never> {
          elkCalls++;
          throw new Error("elk is dead（测试注入的拒绝）");
        }
      },
    }));
    const mod = await import("./layout");
    const t = tree();
    const map = await mod.autoLayout(t);
    // 先钉「mock 确实接住了」：没接住的话 elkCalls 是 0、下面全是真 ELK 坐标在陪跑，
    // 断言再花也是假绿——这条是本 describe 存在的意义，宁可红不可假绿。
    expect(elkCalls).toBe(1);

    const flat = flattenTree(t);
    expect(Object.keys(map).sort()).toEqual(flat.map((f) => f.node.key).sort());

    // 「不美观但绝不重叠」：坐标对去重后不许缩水
    const cells = new Set(Object.values(map).map((p) => `${p.x},${p.y}`));
    expect(cells.size).toBe(flat.length);

    // 深度 → x：每深一层整列右移（列宽 NODE_W+48，48 即 GAP_X，与 NODE_W/H 同出 §11.7.3）
    const depth = new Map<string, number>();
    for (const f of flat) {
      depth.set(f.node.key, f.parentKey === null ? 0 : depth.get(f.parentKey!)! + 1);
    }
    for (const f of flat) {
      expect(map[f.node.key].x).toBe(depth.get(f.node.key)! * (NODE_W + 48));
    }

    // 放置序（与 flatten 同为前序）→ y 严格递增：真 ELK 的 DOWN 布局里同层 y 相等，
    // 所以「严格」二字同时也是走的是 fallback 而非 ELK 的行为学证据。
    let prevY = Number.NEGATIVE_INFINITY;
    for (const f of flat) {
      expect(map[f.node.key].y).toBeGreaterThan(prevY);
      prevY = map[f.node.key].y;
    }
  });
});
