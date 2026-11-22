// 模块树的共用纯函数（R99 落地）：原本在 pages/api.tsx 与 pages/scenes.tsx 逐字重复两份，
// 元素库页（T14）是第三个调用方——第三份不再复制。纯搬移，不改行为。
// 本模块必须保持纯 TS（不许 import React/antd）：vitest node 环境直接跑得动（moduleTree.test.ts）。
// 落位：计划写的路径是 src/api/moduleTree.ts，实际放 src/shared/——两点实测理由：
// ① Windows 大小写不敏感文件系统上 api/moduleTree.ts 与 api/ModuleTree.tsx 只差大小写，
//    tsc -b 直接报 TS1149 拒绝构建；
// ② shared/ 是纯件的家（timefmt/runVocab 与各自 .test.ts 同路数，T11 先例），且 vitest
//    include 本来就罩着 src/shared/**，不必为它扩配置。ModNode 的类型从 api/ModuleTree 引。
import type { ModNode } from "../api/ModuleTree";

/** 模块树摊平成下拉选项（缩进表层级），与接口页同款。 */
export function flatten(nodes: ModNode[], depth = 0): { value: string; label: string }[] {
  return nodes.flatMap((n) => [
    { value: n.id, label: "　".repeat(depth) + n.name },
    ...flatten(n.children, depth + 1),
  ]);
}

/**
 * 选中模块的行过滤集合（**只有该模块自身**）。
 *
 * **只有场景页与 UI 元素页在用**。接口页已按业主裁定（D47-b 计划 §五·1）改走
 * {@link subtreeIds}，因为接口树的徽标已同步改成子树数；这两页的后端徽标仍是直属数，
 * 所以它们的列表也必须继续只数直属——两边口径必须一起动，单边动就出事（见下）。
 *
 * 后端这三棵树的徽标原本都是 `group_by(module_id)` 的**直属**计数
 * （UI 元素树 `ui_test/module_services.py:100` 明写「count=直属未回收元素+用例」；
 * 场景树 `scenario/module_services.py:88-95`；API 树曾同口径，现已改子树）。
 * 列表若把子孙模块的行也算进来，点一个徽标写 3 的模块会出 7 行，那才是真难看。
 * 名字以前叫 `subtreeIds`、注释写「子树（含自身）」，而实现从来收集不到子孙
 * （命中节点后对每个孩子调 `walk(c)` 是在子树里再找同一个 id，永远 null）——
 * 名字与注释都在说一件它没做的事，三页底部文案还跟着说「含子模块」。
 * T23 收裁（台账 R120）：**改字不改行为**，三页文案与函数名一起落到「选中模块」。
 *
 * 找不到该模块返回 null（调用方视为不过滤）。
 */
export function ownModuleIds(nodes: ModNode[], id: string): Set<string> | null {
  const walk = (n: ModNode): Set<string> | null => {
    if (n.id === id) return new Set([n.id]);
    for (const c of n.children) { const r = walk(c); if (r) return r; }
    return null;
  };
  for (const n of nodes) { const r = walk(n); if (r) return r; }
  return null;
}

/**
 * 选中模块的行过滤集合（**含全部子孙**）——接口页专用，D47-b §五·1 的业主裁定。
 *
 * 与 {@link ownModuleIds} 的差别不是「哪个更对」，而是**跟谁家的徽标配套**：
 * 接口树的后端徽标已改成子树卷算（`api_test/module_services.py` 的 api_module_tree），
 * 列表若还只数直属，点一个徽标写 7 的模块只出 3 行——徽标与列表打架，双向都难看。
 * R120 当年那句「真要做子树过滤，得连后端徽标一起改，那是产品决定」在这里兑现：
 * 产品决定了，所以徽标与列表在同一刀里一起改，不是单边顺手修。
 *
 * 形状与 MS 一致：MS 也是前端把「选中节点 + 全部子孙」的 id 收成一个列表发给服务端，
 * 服务端只做 `module_id IN (...)`（不递归）。所以我们这边同样是纯内存 DFS + 一个 IN。
 * 注意「未分类」不是一棵子树：那些行 `module_id` 为 null，调用方的 `?? "__none"` 哨兵
 * 永远不在本集合里，选中任何模块都不会把未分类行捞进来（MS 的未规划是个有自己 id 的真节点，
 * 我们没有那个节点，也不为此造一个假选项）。
 *
 * 找不到该模块返回 null（调用方视为不过滤），与 ownModuleIds 同款语义。
 */
export function subtreeIds(nodes: ModNode[], id: string): Set<string> | null {
  const collect = (n: ModNode, into: Set<string>): void => {
    into.add(n.id);
    for (const c of n.children) collect(c, into);
  };
  const walk = (n: ModNode): Set<string> | null => {
    if (n.id === id) { const out = new Set<string>(); collect(n, out); return out; }
    for (const c of n.children) { const r = walk(c); if (r) return r; }
    return null;
  };
  for (const n of nodes) { const r = walk(n); if (r) return r; }
  return null;
}

/**
 * 模块彻底删除的回执。三棵树各自回自己的键名：api 树 detached_definitions、
 * 场景树 detached_scenarios、UI 树 detached_elements **加** detached_cases。
 * 旧代码只认前两个键，UI 树复用同组件时「N 个元素转为未分类」被静默算成 0——
 * 成功提示说错话（R112 同型）。
 */
export interface PurgeReceipt {
  purged_modules: number;
  detached_definitions?: number;
  detached_scenarios?: number;
  detached_elements?: number;
  /**
   * UI 树回执同时带的用例侧转出数。以前注释写「与资产名词不同侧，不进提示语」，
   * 那句在 R122 之后站不住：UI 模块真的能装用例（种子那条就在模块里，
   * `ui_test/module_services.py` 的 purge 也把 `UiCase.module_id` 一并置空），
   * 于是「彻底删除 1 个模块，1 个元素转为未分类」漏报了同场转出的那条用例——
   * 少说一件事的成功提示仍然是说错话。所以量级照常报，名词按侧写清。
   */
  detached_cases?: number;
}

/**
 * 回执 → 提示语从句（每棵树的回执只带自己那几个键，这里全接住）。
 * 返回的是「1 个接口转为未分类」这种整句，调用方拼在「已彻底删除 N 个模块」后面。
 */
export function purgeDetachedClauses(r: PurgeReceipt, noun: string): string[] {
  const out: string[] = [];
  // 本组件的资产名词那一侧（api=接口 / 场景=场景 / UI=元素），三选一，键名不同而已
  const own = r.detached_definitions ?? r.detached_scenarios ?? r.detached_elements;
  if (own) out.push(own + " 个" + noun + "转为未分类");
  if (r.detached_cases) out.push(r.detached_cases + " 条 UI 用例转为未分类");
  return out;
}
