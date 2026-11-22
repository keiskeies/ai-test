// step_graph 图操作（纯函数 + 不可变）：画布/列表两种模式共用同一份节点树的状态机。
// 唯一序列化点：toGraphV1 / fromGraphV1（设计 §7.4）。全部操作返回新数组，不原地改。
// 不含 React/DOM import；validateLocal 与后端 graph.py 保持同源规则，后端仍是最终真相。
import {
  BLOCKED_1B,
  CONTAINER_KINDS,
  KINDS,
  LOOP_KINDS,
  MAX_DEPTH,
  MAX_KEY_LENGTH,
  MAX_KEY_SEGMENTS,
  MAX_KEY_SEGMENT_LENGTH,
  REF_KINDS,
  type LayoutMap,
  type StepNode,
} from "./stepTypes";

// —— §7.4 序列化协议 ——

export interface GraphV1 {
  version: 1;
  nodes: StepNode[];
  layout: LayoutMap;
}

/** 序列化：nodes + layout → §7.4 graph。node 上的 disable/false 等 falsy 可选字段保留。 */
export function toGraphV1(nodes: StepNode[], layout: LayoutMap = {}): GraphV1 {
  return { version: 1, nodes, layout: { ...layout } };
}

/** 反序列化：graph → nodes/layout。畸形输入返回空数组，绝不抛异常（与后端 validate 同精神）。
 *  D147：被白名单过滤掉的原始条目**逐字**收进 rejected（同引用、不改造、不猜形状）——
 *  静默丢弃会让「打开→什么都没动→保存」把库里畸形步骤写没；调用方必须交代这些条目。
 *  整图畸形（null / nodes 非数组）没有「逐条」可言，rejected=[]。 */
export function fromGraphV1(graph: unknown): { nodes: StepNode[]; layout: LayoutMap; rejected: unknown[] } {
  if (!graph || typeof graph !== "object") return { nodes: [], layout: {}, rejected: [] };
  const g = graph as { nodes?: unknown; layout?: unknown };
  const nodes: StepNode[] = [];
  const rejected: unknown[] = [];
  if (Array.isArray(g.nodes)) {
    for (const n of g.nodes) {
      if (isStepNode(n)) nodes.push(n);
      else rejected.push(n);
    }
  }
  const layout: LayoutMap = {};
  if (g.layout && typeof g.layout === "object") {
    for (const [k, v] of Object.entries(g.layout as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as { x?: unknown }).x === "number"
        && typeof (v as { y?: unknown }).y === "number") {
        layout[k] = { x: (v as { x: number }).x, y: (v as { y: number }).y };
      }
    }
  }
  return { nodes, layout, rejected };
}

function isStepNode(x: unknown): x is StepNode {
  return !!x && typeof x === "object"
    && typeof (x as { key?: unknown }).key === "string"
    && typeof (x as { kind?: unknown }).kind === "string";
}

// —— key 工具 ——

/** §7.4 key 规则：点号分段的字母数字下划线短横线，段长 1-40、段数 ≤10、总长 ≤64、不含 #。
 *  三条上限分别由 KEY_RE（段长）、MAX_KEY_SEGMENTS（段数，split(".") 数）、
 *  MAX_KEY_LENGTH（总长）把关——**分段不是这个正则数的**（曾经有个配套的 SEG_RE
 *  全局正则想干这事，实际没人调用，段数是下面 split(".") 数的；lint 扫出来删了，
 *  留着会让人以为分段规则归正则管）。 */
const KEY_RE = /^[A-Za-z0-9_-]{1,40}(\.[A-Za-z0-9_-]{1,40})*$/;

export function isValidKey(key: string): boolean {
  return KEY_RE.test(key) && !key.includes("#")
    && key.split(".").length <= MAX_KEY_SEGMENTS && key.length <= MAX_KEY_LENGTH;
}

export function keyProblem(key: string): string | null {
  if (!key) return "步骤 key 不能为空：报告、SSE 高亮、单步重跑都以 key 为主键";
  if (!KEY_RE.test(key) || key.includes("#"))
    return "步骤 key「" + key + "」不合法：只允许字母数字下划线短横线，点号分层，段长 1-"
      + MAX_KEY_SEGMENT_LENGTH + "，且不能含 #（数据集行键要用 #rN 后缀）";
  if (key.split(".").length > MAX_KEY_SEGMENTS)
    return "步骤 key「" + key + "」有 " + key.split(".").length + " 段，超过 "
      + MAX_KEY_SEGMENTS + " 段上限";
  if (key.length > MAX_KEY_LENGTH)
    return "步骤 key 长度 " + key.length + " 超过 " + MAX_KEY_LENGTH + "，写不进 run_step_result.step_key";
  return null;
}

/**
 * 生成一个不与已用 key 冲突的新 key。
 *
 * base 语义：
 *  - base 为空/null → 顶层级新 key，风格 "n1"、"n2" 与 §7.4 文档示例一致；
 *  - base 是已有容器 key → 该容器的子 key，风格 "n2.1"、"n2.2"。
 *
 * 「删除后不复用」的保证系于调用方：把本会话**分配过的全部 key**（含已删除的）传给
 * existing，让它成为单调集；扫描只找第一个空位，因此被删过的 key（仍在集合里）永不会被
 * 复用。graphOps 内部依此，用 allKeys 只管当前节点时是尽力而为（新会话里删除的 key 由
 * 持有者把它们留在单调集里）。
 */
export function nextKey(existing: Iterable<string>, base: string | null = null): string {
  const used = new Set(existing);
  const prefix = base ?? "n";
  if (used.has(prefix)) {
    // base 是已有容器 → 分配子 key
    for (let i = 1; ; i++) {
      const c = prefix + "." + i;
      if (!used.has(c)) return c;
    }
  }
  // base 是前缀 → 顶层风格 prefix1 / prefix2
  for (let i = 1; ; i++) {
    const c = prefix + i;
    if (!used.has(c)) return c;
  }
}

/** 深度优先遍历：yield (节点, 父 key, 深度)。if 的子节点在 config.branches[].children。 */
export function walk(
  nodes: StepNode[],
  parentKey: string | null = null,
  depth = 1,
): Generator<[StepNode, string | null, number]> {
  return walkNodes(nodes, parentKey, depth);
}

function* walkNodes(
  nodes: StepNode[],
  parentKey: string | null,
  depth: number,
): Generator<[StepNode, string | null, number]> {
  for (const node of nodes) {
    yield [node, parentKey, depth];
    if (!CONTAINER_KINDS.includes(node.kind as never)) continue;
    if (node.kind === "if") {
      const branches = branchList(node);
      for (const br of branches) {
        if (Array.isArray(br.children)) {
          yield* walkNodes(br.children, node.key, depth + 2);
        }
      }
      continue;
    }
    if (Array.isArray(node.children)) {
      yield* walkNodes(node.children, node.key, depth + 1);
    }
  }
}

function branchList(node: StepNode): { cond?: unknown; children?: StepNode[] }[] {
  if (!node.config || typeof node.config !== "object") return [];
  const b = node.config.branches;
  return Array.isArray(b) ? (b as { cond?: unknown; children?: StepNode[] }[]) : [];
}

/** 按 key 找节点；找到即返回 [节点, 父 key]，找不到返回 null。 */
export function findByKey(nodes: StepNode[], key: string): [StepNode, string | null] | null {
  for (const [node, parent] of walk(nodes)) {
    if (node.key === key) return [node, parent];
  }
  return null;
}

/** 统计步骤数：容器本身的子节点也算（纯树计数，与后端 run stats 口径无关）。 */
export function countSteps(nodes: StepNode[]): number {
  let n = 0;
  for (const [_node] of walk(nodes)) n++; // 只数个数：`_` 前缀即「故意不用」（eslint argsIgnorePattern）
  return n;
}

/** 收集全部 key（含 if 分支里的），供 key 冲突判断与 nextKey。 */
export function allKeys(nodes: StepNode[]): Set<string> {
  const keys = new Set<string>();
  for (const [node] of walk(nodes)) keys.add(node.key);
  return keys;
}

// —— 深拷贝（操作全部不可变） ——

function deepCopy<T>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

// —— 树编辑递归辅助 ——
// 所有操作输出全新节点对象；找到目标 → 就地处理并短路返回，否则递归并向父重建。

/** 把 newNode 插入 containerKey 容器内末尾；容器是 if → 插入 branchIndex 分支。 */
export function insertInto(
  nodes: StepNode[],
  containerKey: string,
  newNode: StepNode,
  branchIndex = 0,
): StepNode[] {
  const n = deepCopy(newNode);
  const ok = insertIntoRec(nodes, containerKey, n, branchIndex);
  return ok ? ok : nodes;
}

function insertIntoRec(
  nodes: StepNode[],
  containerKey: string,
  child: StepNode,
  branchIndex: number,
): StepNode[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.key === containerKey) {
      const copy = nodes.slice();
      if (node.kind === "if") {
        const branches = branchList(node);
        const bi = branches.length ? Math.max(0, Math.min(branchIndex, branches.length - 1)) : 0;
        const nb = branches.slice();
        nb[bi] = { ...nb[bi], children: [...(nb[bi].children ?? []), child] };
        copy[i] = { ...node, config: { ...node.config, branches: nb } };
        return copy;
      }
      copy[i] = { ...node, children: [...(node.children ?? []), child] };
      return copy;
    }
    // 向下找
    if (node.kind === "if") {
      const branches = branchList(node);
      for (let b = 0; b < branches.length; b++) {
        const kids = branches[b].children ?? [];
        const r = insertIntoRec(kids, containerKey, child, branchIndex);
        if (r) {
          const copy = nodes.slice();
          const nb = branches.slice();
          nb[b] = { ...nb[b], children: r };
          copy[i] = { ...node, config: { ...node.config, branches: nb } };
          return copy;
        }
      }
    } else if (Array.isArray(node.children)) {
      const r = insertIntoRec(node.children, containerKey, child, branchIndex);
      if (r) {
        const copy = nodes.slice();
        copy[i] = { ...node, children: r };
        return copy;
      }
    }
  }
  return null;
}

/** 在 siblingKey 之后插入 newNode；siblingKey 没找到则原样返回。 */
export function insertAfter(nodes: StepNode[], siblingKey: string, newNode: StepNode): StepNode[] {
  const n = deepCopy(newNode);
  return editList(nodes, (list, _p) => {
    const idx = list.findIndex((x) => x.key === siblingKey);
    if (idx < 0) return null;
    const copy = list.slice();
    copy.splice(idx + 1, 0, n);
    return copy;
  });
}

/** 删除 key 命中的节点；命中后返回删掉节点后的列表并短路。 */
export function remove(nodes: StepNode[], key: string): StepNode[] {
  return editList(nodes, (list, _p) => {
    const idx = list.findIndex((x) => x.key === key);
    if (idx < 0) return null;
    const copy = list.slice();
    copy.splice(idx, 1);
    return copy;
  });
}

/** 重命名某个节点：name 为空则保留原名。 */
export function rename(nodes: StepNode[], key: string, name: string): StepNode[] {
  return editList(nodes, (list, _p) => {
    const idx = list.findIndex((x) => x.key === key);
    if (idx < 0) return null;
    const copy = list.slice();
    copy[idx] = { ...copy[idx], name: name.trim() || copy[idx].name };
    return copy;
  });
}

/** 切换节点的禁/启用位：disable=true 只是跳过执行，不是删除（后端展开量仍要算，§8.6）。 */
export function toggleDisable(nodes: StepNode[], key: string): StepNode[] {
  return editList(nodes, (list, _p) => {
    const idx = list.findIndex((x) => x.key === key);
    if (idx < 0) return null;
    const copy = list.slice();
    copy[idx] = { ...copy[idx], disable: !copy[idx].disable };
    return copy;
  });
}

/** 把 targetKey 节点移进某个容器（ancestorKey）的最末尾。
 * 顶层节点同样可移入——R69：旧实现借 findByKey 的 parentKey 判「有没有祖先可移」，
 * 顶层节点 parentKey 恒 null 被误拒；现委托 moveNode，由它统一判 guard。
 * 返回 null 表示拒绝（目标不存在 / 不是容器 / 自环），调用方据此给 UI 提示。 */
export function moveIntoContainer(
  nodes: StepNode[],
  ancestorKey: string,
  targetKey: string,
): StepNode[] | null {
  return moveNode(nodes, { key: targetKey, toParent: ancestorKey });
}

/**
 * 通用移动：把 key 节点整棵子树搬到 toParent 容器的 index 位（缺省末尾）；
 * toParent=null 表示顶层（同层移动即改顺序）。T20 列表模式的「拖出循环」与
 * T19 右键「移入容器」共用这一个入口——树编辑口径只有一份（含 if 分支特判）。
 *
 * guard（全部返回 null，调用方负责把拒绝说给用户听，不许静默变「什么都没发生」）：
 *  - key 不存在 / 自移（toParent === key）；
 *  - toParent 非 null 但不存在或不是容器（§7.4：只有 loop/foreach/if/group 收 children）；
 *  - toParent 落在 key 自己的子树内（移进自己后代 = 造环）。
 * key 不因移动而改：§7.4 的 key 点号层级只是命名风格，协议不要求与父子关系一致
 * （后端 validate 只看 key 合法与唯一），改名另有 rename 入口。
 */
export function moveNode(
  nodes: StepNode[],
  opts: { key: string; toParent: string | null; index?: number },
): StepNode[] | null {
  const { key, toParent, index } = opts;
  const found = findByKey(nodes, key);
  if (!found) return null;
  const [node] = found;
  if (toParent !== null) {
    if (toParent === key) return null; // 不能移进自己
    const dest = findByKey(nodes, toParent);
    if (!dest) return null;
    if (!CONTAINER_KINDS.includes(dest[0].kind as never)) return null;
    // toParent 位于 key 的子树内（含 key 自身）→ 移进去就是环
    if (isInside(nodes, key, toParent)) return null;
  }
  const removed = remove(nodes, key);
  if (toParent === null) {
    const copy = removed.slice();
    copy.splice(Math.max(0, Math.min(index ?? copy.length, copy.length)), 0, node);
    return copy;
  }
  return insertIntoAt(removed, toParent, node, index);
}

/** insertInto 的定版插入：index 缺省=末尾；if 容器插第一个分支（与包装语义一致）。 */
function insertIntoAt(
  nodes: StepNode[],
  containerKey: string,
  child: StepNode,
  index?: number,
): StepNode[] | null {
  const at = index === undefined ? null : Math.max(0, index);
  const out = editList(nodes, (list, parent) => {
    if (!parent || parent.key !== containerKey) return null;
    const copy = list.slice();
    copy.splice(at ?? copy.length, 0, child);
    return copy;
  });
  return out === nodes ? null : out;
}

/** key 是否在 scope 的子树内（含 scope 自身）。 */
function isInside(nodes: StepNode[], scope: string, key: string): boolean {
  for (const [node] of walk(nodes)) {
    if (node.key !== scope) continue;
    if (node.key === key) return true;
    for (const [d] of walkChildren(node)) {
      if (d.key === key) return true;
    }
    return false;
  }
  return false;
}

/** 取某节点的直接子树（跳过自身）：if 则取全部分支的 children 合并。 */
function walkChildren(node: StepNode): Generator<[StepNode, string | null, number]> {
  if (node.kind === "if") {
    const out: StepNode[] = [];
    for (const br of branchList(node)) out.push(...(br.children ?? []));
    return walk(out, node.key, 1);
  }
  return walk(node.children ?? [], node.key, 1);
}

/** 直接子节点数组（只读语义）：if 取全部分支 children 的拼接。布局/渲染共用。 */
export function childrenOf(node: StepNode): StepNode[] {
  if (node.kind === "if") {
    const out: StepNode[] = [];
    for (const br of branchList(node)) out.push(...(br.children ?? []));
    return out;
  }
  return node.children ?? [];
}

/** 深拷贝节点：复制（含子孙），自动给新 key（同层唯一），并加 " 副本" 后缀名。 */
export function duplicate(nodes: StepNode[], sourceKey: string): StepNode[] {
  const found = findByKey(nodes, sourceKey);
  if (!found) return nodes;
  const [src] = found;
  const used = allKeys(nodes);
  const copied = deepCopy(src);
  const parentPath = src.key.split(".").slice(0, -1).join(".");
  const newRoot = parentPath ? nextKey(used, parentPath) : nextKey(used, null);
  mapSubtree(copied, src.key, newRoot);
  copied.name = (copied.name || "步骤") + " 副本";
  // 插在原节点后面（与 insertAfter 同层语义）
  return insertAfter(nodes, sourceKey, copied);
}

/** 把整棵子树的 key 前缀从 oldRoot 换成 newRoot，保留层级后缀。 */
function mapSubtree(node: StepNode, oldRoot: string, newRoot: string): void {
  const suffix = node.key.slice(oldRoot.length); // "n2.1" - "n2" = ".1"
  node.key = newRoot + suffix;                    // "n5" + ".1"
  if (node.kind === "if") {
    for (const br of branchList(node)) {
      for (const k of br.children ?? []) mapSubtree(k, oldRoot, newRoot);
    }
  } else if (Array.isArray(node.children)) {
    for (const k of node.children) mapSubtree(k, oldRoot, newRoot);
  }
}

/**
 * 复制节点（含子孙）为**独立副本**：换新 key（全树唯一，删除后不复用）但不插入。
 * T20 列表模式的「复制 → 粘贴(N)」用它：剪贴板里放的是快照，粘贴时机由 UI 决定，
 * 所以不能复用 duplicate()（那是「立刻插在原位」的语义）。key 分配口径与 duplicate 同源。
 */
export function cloneNode(nodes: StepNode[], src: StepNode): StepNode {
  const used = allKeys(nodes);
  const copied = deepCopy(src);
  const parentPath = src.key.split(".").slice(0, -1).join(".");
  const newRoot = parentPath ? nextKey(used, parentPath) : nextKey(used, null);
  mapSubtree(copied, src.key, newRoot);
  return copied;
}

/**
 * 同级重排：把 key 移到新的 index（0-based）。index 越界裁到 [0,len-1]。
 * 也支持把 across 层级移动——但本函数只做同级相邻 swap 的稳定版：fromIndex → toIndex。
 */
export function reorder(nodes: StepNode[], key: string, toIndex: number): StepNode[] {
  return editList(nodes, (list, _p) => {
    const idx = list.findIndex((x) => x.key === key);
    if (idx < 0) return null;
    const copy = list.slice();
    const [node] = copy.splice(idx, 1);
    const t = Math.max(0, Math.min(toIndex, copy.length));
    copy.splice(t, 0, node);
    return copy;
  });
}

// —— 递归树编辑：op 在每一层 children 上尝试；首中短路。 ——
function editList(
  nodes: StepNode[],
  op: (list: StepNode[], parent: StepNode | null) => StepNode[] | null,
  parent: StepNode | null = null,
): StepNode[] {
  const hit = op(nodes, parent);
  if (hit) return hit;
  let changed = false;
  const out: StepNode[] = [];
  for (const node of nodes) {
    let next = node;
    if (node.kind === "if") {
      const branches = branchList(node);
      let nb = branches;
      for (let i = 0; i < branches.length; i++) {
        const kids = branches[i].children ?? [];
        const r = editList(kids, op, node);
        if (r !== kids) {
          nb = branches.slice();
          nb[i] = { ...branches[i], children: r };
          break;
        }
      }
      if (nb !== branches) { next = { ...node, config: { ...node.config, branches: nb } }; changed = true; }
    } else if (CONTAINER_KINDS.includes(node.kind as never)) {
      // 容器类**一律递归**，不看 children 在不在。此前只认 Array.isArray(children)，
      // 于是新建的 loop/group（dropOn 与 groupSelected 都不带 children 字段）永远进不去：
      // 往里拖一步 / 移进去 / 改名全部静默 no-op，界面还当场显示出一个空容器。
      // 就地补一个空 children 再递归——已落库的老场景带同样的缺字段，一并自愈。
      // 判定必须比 `r !== kids` 而不是 `r !== node.children`：缺字段时后者对任何
      // 无关的 no-op 遍历都成立，会把空壳容器凭空物化成 children:[] 并谎报「改了」，
      // 调用方（insertAfter 的引用语义、undo、dirty 比对）全跟着受骗。
      const kids = Array.isArray(node.children) ? node.children : [];
      const r = editList(kids, op, node);
      if (r !== kids) { next = { ...node, children: r }; changed = true; }
    }
    out.push(next);
  }
  // 什么都没变时返回原引用——调用方（insertAfter 找不到目标等）依赖引用语义
  return changed ? out : nodes;
}
// —— 本地预检（validateLocal）——
// 与后端 graph.py 同源规则子集：key 唯一、深度 ≤10、break/continue 必须在循环内、
// 必填 config（§7.4 口径表）。后端是最终真相；前端只做「保存前可感知」的即时反馈。

export interface Issue {
  node_key: string;
  code: string;
  message: string;
  path: string;
}

interface VState {
  seen: Set<string>;
  issues: Issue[];
}

function push(v: VState, nodeKey: string, code: string, message: string, path: string): void {
  v.issues.push({ node_key: nodeKey, code, message, path });
}

function isPlainInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

function nonEmptyStr(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}

/** §7.4 必填 config 口径表（与 graph.py._required_config 逐条对齐）。 */
function requiredConfig(kind: string, cfg: Record<string, unknown> | null | undefined): string[] {
  const miss: string[] = [];
  const c = cfg ?? {};
  switch (kind) {
    case "http_direct":
      if (!nonEmptyStr(c.url)) miss.push("config.url");
      break;
    case "sleep":
      if (!(isPlainInt(c.ms) && (c.ms as number) > 0)) miss.push("config.ms（正整数毫秒）");
      break;
    case "loop": {
      if (!(isPlainInt(c.max_iter) && (c.max_iter as number) > 0))
        miss.push("config.max_iter（正整数，防死循环的硬上限）");
      const mode = c.mode;
      if (typeof mode !== "string" || mode === "" || mode === "while") {
        if (!nonEmptyStr(c.cond)) miss.push("config.cond（while 模式必须有条件表达式）");
      }
      break;
    }
    case "foreach":
      if (!nonEmptyStr(c.list_var)) miss.push("config.list_var");
      if (!nonEmptyStr(c.item_var)) miss.push("config.item_var");
      break;
    case "script":
      if (!nonEmptyStr(c.code)) miss.push("config.code");
      break;
    case "extract": {
      const rules = c.rules;
      if (!Array.isArray(rules) || rules.length === 0) miss.push("config.rules（至少一条提取规则）");
      else if (rules.some((r) => !(r && typeof r === "object"
        && nonEmptyStr((r as Record<string, unknown>).var)
        && nonEmptyStr((r as Record<string, unknown>).expr)))) {
        miss.push("config.rules（每条规则都要有 var 与 expr）");
      }
      break;
    }
    case "assert": {
      const items = c.assertions;
      if (!Array.isArray(items) || items.length === 0) miss.push("config.assertions（至少一条断言）");
      break;
    }
    case "set_var": {
      const vs = c.vars;
      if (!vs || typeof vs !== "object" || Array.isArray(vs)) miss.push("config.vars（至少一个变量）");
      else if (Object.keys(vs as Record<string, unknown>).length === 0) miss.push("config.vars（至少一个变量）");
      break;
    }
    case "adb_case": {
      // 设备策略（§11.4.12）：与后端 graph._required_config 同尺——缺省=不覆盖（合法），
      // 「指定设备」没选设备 = 半套配置，保存期就说，别等执行到那一步才红。
      const policy = c.device_policy;
      if (policy !== undefined && policy !== null && typeof policy !== "string") {
        miss.push("config.device_policy（any_idle / specified）");
      } else if (policy === "specified" && !nonEmptyStr(c.device_serial)) {
        miss.push("config.device_serial（指定了「指定设备」就要选一台设备）");
      }
      break;
    }
    default:
      break;
  }
  return miss;
}
/** 本地预检：对 nodes 列表做保存前检查。只产 issue、绝不抛异常。 */
export function validateLocal(nodes: StepNode[]): Issue[] {
  const v: VState = { seen: new Set(), issues: [] };
  valWalk(nodes, "$.nodes", null, 1, false, v);
  return v.issues;
}

function valWalk(
  nodes: StepNode[],
  path: string,
  parentKey: string | null,
  depth: number,
  inLoop: boolean,
  v: VState,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const p = path + "[" + i + "]";
    if (!node || typeof node !== "object" || typeof (node as StepNode).kind !== "string") {
      push(v, "", "bad_node", "步骤必须是 JSON 对象", p);
      continue;
    }
    const key = node.key ?? "";
    if (depth > MAX_DEPTH) {
      push(v, key, "depth_exceeded",
        "步骤嵌套到第 " + depth + " 层，超过上限 " + MAX_DEPTH + "（§7.4）；请减小嵌套", p);
    }
    const prob = keyProblem(key);
    if (prob) {
      push(v, key, "bad_key", prob, p);
    } else if (v.seen.has(key)) {
      push(v, key, "dup_key", "步骤 key「" + key + "」重复；同一场景内必须唯一", p);
    } else {
      v.seen.add(key);
    }

    const kind = node.kind;
    if (!(KINDS as readonly string[]).includes(kind)) {
      push(v, key, "unknown_kind",
        "未知步骤类型「" + (kind || "(未填)") + "」；一期支持：" + KINDS.join(", "), p);
      continue;
    }
    if (BLOCKED_1B[kind]) {
      push(v, key, "kind_not_available",
        kind + " 步骤要到 " + BLOCKED_1B[kind] + " 批次才开放（现在保存会失败）", p);
      continue;
    }
    if ((kind === "break" || kind === "continue") && !inLoop) {
      push(v, key, "break_outside_loop",
        kind + " 只能出现在 loop / foreach 内部，否则执行时没有任何循环可以跳出", p);
    }
    if ((REF_KINDS as readonly string[]).includes(kind) && !nonEmptyStr(node.ref)) {
      push(v, key, "missing_ref", kind + " 缺少 ref：要知道这一步到底跑哪个用例", p);
    }
    for (const m of requiredConfig(kind, node.config ?? undefined)) {
      push(v, key, "missing_config", kind + " 缺少必填配置 " + m, p);
    }

    if (!(CONTAINER_KINDS as readonly string[]).includes(kind)) {
      if (Array.isArray(node.children) && node.children.length > 0) {
        push(v, key, "children_not_allowed",
          kind + " 是叶子步骤，不能有 children（要串子步骤请用 group）", p);
      }
      continue;
    }

    // 容器：children 数组顺序即执行顺序
    if (kind === "if") {
      const branches = branchList(node);
      if (branches.length === 0) {
        push(v, key, "missing_config", "if 缺少必填配置 config.branches（至少一个分支）", p);
        continue;
      }
      for (let bi = 0; bi < branches.length; bi++) {
        const br = branches[bi];
        const bp = p + ".config.branches[" + bi + "]";
        if (!br || typeof br !== "object") {
          push(v, key, "bad_node", "if 分支必须是 JSON 对象", bp);
          continue;
        }
        if (!nonEmptyStr(br.cond)) {
          push(v, key, "empty_cond",
            "if 的第 " + (bi + 1) + " 个分支没有条件；无条件分支请在画布上选「否则(else)」", bp);
        }
        const bc = br.children;
        if (bc === undefined) continue;
        if (!Array.isArray(bc)) {
          push(v, key, "bad_node", "if 分支的 children 必须是数组", bp + ".children");
          continue;
        }
        valWalk(bc, bp + ".children", key, depth + 2, inLoop, v);
      }
      continue;
    }

    if (!Array.isArray(node.children) && node.children != null) {
      push(v, key, "bad_node", kind + " 的 children 必须是数组", p + ".children");
      continue;
    }
    const childInLoop = inLoop || (LOOP_KINDS as readonly string[]).includes(kind);
    valWalk(node.children ?? [], p + ".children", key, depth + 1, childInLoop, v);
  }
}
// —— undo/redo 栈（上限 50，超限丢最旧）——

export interface UndoStack<T> {
  limit: number;
  past: T[];
  present: T;
  future: T[];
}

/** 创建 undo 栈：present 为当前快照，push 记录前一个状态，undo/redo 在 past/future 间移动。 */
export function createUndoStack<T>(initial: T, limit = 50): UndoStack<T> {
  return { limit, past: [], present: deepCopy(initial), future: [] };
}

/** 提交新状态到 undo 栈（新状态成为 present，旧 present 进 past，future 清空）。 */
export function pushUndo<T>(stack: UndoStack<T>, next: T): UndoStack<T> {
  const past = stack.past.concat(deepCopy(stack.present));
  if (past.length > stack.limit) past.shift(); // 丢最旧
  return { ...stack, past, present: deepCopy(next), future: [] };
}

export function canUndo<T>(stack: UndoStack<T>): boolean {
  return stack.past.length > 0;
}

export function undo<T>(stack: UndoStack<T>): UndoStack<T> | null {
  if (!canUndo(stack)) return null;
  const prev = stack.past[stack.past.length - 1];
  const future = stack.future.concat(deepCopy(stack.present));
  return {
    ...stack,
    past: stack.past.slice(0, -1),
    present: deepCopy(prev),
    future,
  };
}

export function canRedo<T>(stack: UndoStack<T>): boolean {
  return stack.future.length > 0;
}

export function redo<T>(stack: UndoStack<T>): UndoStack<T> | null {
  if (!canRedo(stack)) return null;
  const next = stack.future[stack.future.length - 1];
  const past = stack.past.concat(deepCopy(stack.present));
  return {
    ...stack,
    past,
    present: deepCopy(next),
    future: stack.future.slice(0, -1),
  };
}
