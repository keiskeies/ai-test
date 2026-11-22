// 画布自动布局（elkjs）：§11.7.3 规格——步骤节点 224×64。
// 纯函数：nodes → LayoutMap（key → 绝对坐标）。渲染是平铺的（容器不包裹子节点，
// 父子关系由树生成的边可视化），所以布局用「父在上、子在下」的 layered 图。
// 失败回落：elk 抛错时用「深度缩进 + 顺序纵排」的保底坐标——布局是体验件，
// 绝不能把编辑页拖白屏。
import ELK from "elkjs/lib/elk.bundled.js";

import { childrenOf } from "./graphOps";
import type { LayoutMap, StepNode } from "./stepTypes";

export const NODE_W = 224;
export const NODE_H = 64;
// DOWN 方向下同层兄弟横向并排：GAP_SIBLING 是层内横向距（喂 nodeNode），
// GAP_LAYER 是层间纵向距（喂 nodeNodeBetweenLayers，画布无边标签，48 收紧到 32）。
// 旧名 GAP_X/Y 与轴向相反，改名消除误读；值不改算法逻辑。
const GAP_SIBLING = 48; // §11.7.3 同层距
const GAP_LAYER = 32; // 层间距（无边标签后收紧）

interface FlatNode {
  node: StepNode;
  parentKey: string | null;
}

export function flattenTree(nodes: StepNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  const push = (list: StepNode[], parentKey: string | null) => {
    for (const n of list) {
      out.push({ node: n, parentKey });
      push(childrenOf(n), n.key);
    }
  };
  push(nodes, null);
  return out;
}

const elk = new ELK();

/** 自动布局：返回每个 key 的绝对坐标。调用方合并进 layout（用户没手动拖过的位置才更新）。 */
export async function autoLayout(nodes: StepNode[]): Promise<LayoutMap> {
  const flat = flattenTree(nodes);
  if (flat.length === 0) return {};
  try {
    const g = await elk.layout({
      id: "root",
      algorithm: "layered",
      layoutOptions: {
        "elk.direction": "DOWN",
        "elk.spacing.nodeNode": String(GAP_SIBLING),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(GAP_LAYER),
        "elk.layered.nodePlacement.strategy": "SIMPLE",
      },
      children: flat.map(({ node }) => ({ id: node.key, width: NODE_W, height: NODE_H })),
      edges: flat
        .filter((f) => f.parentKey)
        .map((f) => ({ id: "e-" + f.node.key, sources: [f.parentKey as string], targets: [f.node.key] })),
    });
    const map: LayoutMap = {};
    for (const c of g.children ?? []) {
      map[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
    }
    return map;
  } catch {
    return fallbackLayout(nodes);
  }
}

/** 保底：同层顺序纵排、子层右移——不美观但绝不重叠，elk 挂了画布照常可用。 */
function fallbackLayout(nodes: StepNode[]): LayoutMap {
  const map: LayoutMap = {};
  let seq = 0;
  const place = (list: StepNode[], depth: number) => {
    for (const n of list) {
      // x 用同层横向距（test 钉死 48），y 与层间纵向距同源
      map[n.key] = { x: depth * (NODE_W + GAP_SIBLING), y: seq * (NODE_H + GAP_LAYER) };
      seq++;
      place(childrenOf(n), depth + 1);
    }
  };
  place(nodes, 0);
  return map;
}
