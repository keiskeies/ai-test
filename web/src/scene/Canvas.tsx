// 画布（§11.4.9/§11.7.3）：@xyflow/react 渲染，但**连线只由树生成**——
// 用户拖不出边（§7.4 无 DAG 汇聚边）：nodesConnectable=false、不传 onConnect，
// 结构改动全部走 HTML5 拖拽与右键菜单。节点 224×64、左边条 4px 域色、缩放 0.5–2.0、
// 小地图 120×80、进页自动适配。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, Handle, MarkerType, MiniMap, Position, ReactFlow,
  type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button, Dropdown, Modal, message } from "antd";
import { childrenOf, isValidKey, walk } from "./graphOps";
import { autoLayout, NODE_H, NODE_W } from "./layout";
import { BLOCKED_1B, CONTAINER_KINDS, kindMeta, labelOf, type StepNode } from "./stepTypes";
import { mergeIssues, selectDirty, useSceneStore } from "./store";
import { tpv } from "../theme";

export const DND_NODE = "application/x-tp-node";
export const DND_KIND = "application/x-tp-kind";
export const DND_REF = "application/x-tp-ref";
export const DND_NAME = "application/x-tp-name";

interface MenuState { key: string; x: number; y: number }

/** 从 DragEvent 里还原拖拽载荷（资产树新增 / 画布内移动两条路共用）。 */
function readDrop(dt: DataTransfer): { node?: string; kind?: string; ref?: string; name?: string } | null {
  const node = dt.getData(DND_NODE);
  if (node) return { node };
  const kind = dt.getData(DND_KIND);
  if (kind) return { kind, ref: dt.getData(DND_REF) || undefined, name: dt.getData(DND_NAME) || undefined };
  return null;
}

function NodeInner(props: NodeProps) {
  const d = props.data as {
    node: StepNode;
    bad: boolean;
    collapsed: boolean;
    hasChildren: boolean;
    caseName: string | null;
    onMenu: (key: string, x: number, y: number) => void;
    readOnly: boolean;
  };
  const n = d.node;
  const meta = kindMeta(n.kind);
  const blocked = !!BLOCKED_1B[n.kind];
  // T21 呼吸高亮：SSE 投影的步骤现状（store.run.stepStatus 单一真相）。
  // 选择器返回原始字符串——zustand v5 的稳定性要求天然满足。
  const runStatus = useSceneStore((s) => s.run.stepStatus[n.key]?.status);
  // 全部引 theme token（§11.6.2/§11.6.3），此处不再手抄 hex：
  // running/skip 此前是手抄的 antd 默认蓝 #1677FF 与禁用灰 #B4BBC2，与 tp 色板无关，
  // 改主题必漂。fail 用 warning 橙、error 用 error 红是 1B 的书面裁定（1B 计划 T21
  // 「配色修正」：断言没过 ≠ 请求没发出去），别「照蓝图」把 fail 改回红。
  // cancelled 蓝图未给色（只给了通过/失败/运行/跳过/未执行五态），沿用原中性灰不发明。
  const runColors: Record<string, string> = {
    running: tpv.func.processing, pass: tpv.primary[500], fail: tpv.func.warning, error: tpv.func.error,
    skip: tpv.func.skip, cancelled: tpv.text[4],
  };
  const runBorder = runStatus ? runColors[runStatus] ?? tpv.border : null;
  const summary = n.kind === "api_case"
    ? (d.caseName ?? n.ref ?? "未选用例")
    : n.kind === "sleep" ? "等待 " + String(n.config?.ms ?? "?") + "ms"
      : n.kind === "loop" ? (String(n.config?.mode ?? "count") + " ≤" + String(n.config?.max_iter ?? "?"))
        : n.kind === "foreach" ? (String(n.config?.list_var ?? "?") + " → " + String(n.config?.item_var ?? "?"))
          : n.kind === "if" ? (String(((n.config?.branches as unknown[]) ?? []).length) + " 分支")
            : meta.label;
  return (
    <div
      data-testid={"scene-node-" + n.key}
      data-selected={props.selected ? "true" : "false"}
      data-run-status={runStatus}
      className={runStatus === "running" ? "tp-node-running" : undefined}
      draggable={!d.readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_NODE, n.key);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer.types);
        if (types.includes(DND_NODE) || types.includes(DND_KIND)) e.preventDefault();
      }}
      onDrop={(e) => {
        // 落在节点上：容器=移入/插入容器末尾，叶子=插在它后面（语义同 store.dropOn）。
        // stopPropagation：别让同一个 drop 再被画布 pane 处理一遍。
        if (d.readOnly) return;
        const payload = readDrop(e.dataTransfer);
        if (!payload) return;
        e.preventDefault();
        e.stopPropagation();
        useSceneStore.getState().dropOn(payload as never, n.key);
      }}
      onContextMenu={(e) => {
        if (d.readOnly) return; // 只读画布：没有结构编辑，也就没有右键菜单
        e.preventDefault(); d.onMenu(n.key, e.clientX, e.clientY);
      }}
      style={{
        width: NODE_W, height: NODE_H, background: tpv.bg.container, borderRadius: 6,
        border: "1px solid " + (runBorder ?? (props.selected ? tpv.primary[600] : tpv.border)),
        boxShadow: props.selected ? "0 0 0 2px " + tpv.primary[200] : tpv.shadow.s1,
        opacity: n.disable ? 0.55 : 1, position: "relative", overflow: "visible",
        display: "flex", alignItems: "stretch", cursor: "grab",
      }}
    >
      <span style={{ width: 4, background: meta.color, borderRadius: "6px 0 0 6px", flex: "0 0 4px" }} />
      <div style={{ padding: "6px 10px", minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, color: "var(--tp-text-2)", display: "flex", gap: 6, alignItems: "center" }}>
          <span>{meta.label}</span>
          {n.disable && <span data-testid="node-disabled-tag" style={{
            background: "#F2F3F4", color: "#8B8E94", borderRadius: 4, padding: "0 4px", fontSize: 11,
          }}>已禁用</span>}
          {blocked && <span style={{ color: "#D48806", fontSize: 11 }}>保存会被拒（{BLOCKED_1B[n.kind]} 开放）</span>}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {n.name || n.key}
        </div>
        <div style={{ fontSize: 11, color: "var(--tp-text-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {summary} · {n.key}
        </div>
      </div>
      {d.bad && (
        <span data-testid="node-badge" title="本地校验问题，见底部问题面板" style={{
          position: "absolute", top: -7, right: -7, width: 16, height: 16, borderRadius: "50%",
          background: "var(--tp-func-error)", color: "#fff", fontSize: 11, lineHeight: "16px", textAlign: "center",
        }}>!</span>
      )}
      {d.hasChildren && (
        <span data-testid={"node-collapse-" + n.key}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); useSceneStore.getState().toggleCollapsed(n.key); }}
          style={{
            position: "absolute", bottom: -10, left: "50%", transform: "translateX(-50%)",
            background: "var(--tp-bg-container)", border: "1px solid var(--tp-border)", borderRadius: 8, fontSize: 10,
            padding: "0 6px", cursor: "pointer", color: "var(--tp-text-2)", zIndex: 2,
          }}>
          {d.collapsed ? "+" : "−"}
        </span>
      )}
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
}
const StepFlowNode = memo(NodeInner);
const nodeTypes = { step: StepFlowNode };

/** 折叠容器时整个子树从画布隐藏（列表模式仍看全量；树是真数据，画布只是视图）。 */
function visiblePairs(nodes: StepNode[], collapsed: string[]): [StepNode, string | null][] {
  const out: [StepNode, string | null][] = [];
  const rec = (list: StepNode[], parent: string | null) => {
    for (const n of list) {
      out.push([n, parent]);
      if (collapsed.includes(n.key)) continue;
      rec(childrenOf(n), n.key);
    }
  };
  rec(nodes, null);
  return out;
}

function MoveIntoModal(props: { targetKey: string | null; onClose: () => void }) {
  const nodes = useSceneStore((s) => s.nodes);
  const moveInto = useSceneStore((s) => s.moveInto);
  if (!props.targetKey) return null;
  const containers: StepNode[] = [];
  const rec = (list: StepNode[]) => {
    for (const n of list) {
      if ((CONTAINER_KINDS as readonly string[]).includes(n.kind)) containers.push(n);
      rec(childrenOf(n));
    }
  };
  rec(nodes);
  const tryMove = (containerKey: string | null) => {
    const ok = moveInto(props.targetKey as string, containerKey);
    if (!ok) message.warning("这个移动被拒绝：目标必须是容器，且不能移进自己或自己的后代");
    props.onClose();
  };
  return (
    <Modal open data-testid="move-into-modal" title="移入容器" onCancel={props.onClose}
      footer={<Button onClick={props.onClose}>取消</Button>} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Button data-testid="move-into-top" onClick={() => tryMove(null)}>移到顶层</Button>
        {containers.map((c) => (
          <Button key={c.key} data-testid={"move-into-" + c.key}
            onClick={() => tryMove(c.key)}>
            {c.name || labelOf(c.kind)}（{c.key}）
          </Button>
        ))}
      </div>
    </Modal>
  );
}

export default function Canvas() {
  const nodes = useSceneStore((s) => s.nodes);
  const layout = useSceneStore((s) => s.layout);
  const revision = useSceneStore((s) => s.revision);
  const collapsed = useSceneStore((s) => s.collapsed);
  const selectedKey = useSceneStore((s) => s.selectedKey);
  const cases = useSceneStore((s) => s.cases);
  const dropOn = useSceneStore((s) => s.dropOn);
  const select = useSceneStore((s) => s.select);
  const removeKey = useSceneStore((s) => s.removeKey);
  const duplicateKey = useSceneStore((s) => s.duplicateKey);
  const toggleDisableKey = useSceneStore((s) => s.toggleDisableKey);
  const setMulti = useSceneStore((s) => s.setMulti);
  const dirty = useSceneStore(selectDirty);
  const readOnly = useSceneStore((s) => s.readOnly);
  // zustand v5：选择器必须返回稳定引用，否则 useSyncExternalStore 判定快照不稳定 →
  // 无限重渲（React #185）。issue 合并放 useMemo，不在选择器里现算。
  const serverIssues = useSceneStore((s) => s.serverIssues);
  const issues = useMemo(() => mergeIssues(nodes, serverIssues), [nodes, serverIssues]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveIntoTarget, setMoveIntoTarget] = useState<string | null>(null);

  const onMenu = useCallback((key: string, x: number, y: number) => {
    select(key);
    const host = wrapRef.current?.getBoundingClientRect();
    setMenu({ key, x: x - (host?.left ?? 0), y: y - (host?.top ?? 0) });
  }, [select]);

  // 结构变化 → 重跑自动布局。节点位置由布局说了算（draggable=false，拖拽=结构操作），
  // 所以画布坐标永远是 autoLayout 的确定性输出，undo/redo 之后位置也自洽。
  useEffect(() => {
    let cancelled = false;
    void autoLayout(nodes).then((pos) => {
      if (cancelled) return;
      useSceneStore.setState({ layout: pos });
    });
    return () => { cancelled = true; };
  }, [revision, nodes]);

  const badKeys = useMemo(() => new Set(issues.map((i) => i.node_key)), [issues]);
  const caseName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cases) m.set(c.id, c.name);
    return m;
  }, [cases]);

  const rfNodes: Node[] = useMemo(() => {
    const pairs = visiblePairs(nodes, collapsed);
    return pairs.map(([n, parent]) => ({
      id: n.key,
      type: "step",
      position: layout[n.key] ?? { x: 0, y: 0 },
      selected: n.key === selectedKey,
      draggable: false, // 位置由布局说了算；HTML5 拖拽（移动节点）走 NodeInner
      hidden: !!parent && collapsed.includes(parent),
      data: {
        node: n,
        // 只读画布（报告详情）不跑本地校验：报告图是执行快照，红角标语义属于编辑器
        bad: readOnly ? false : badKeys.has(n.key) || (n.key !== "" && !isValidKey(n.key)),
        collapsed: collapsed.includes(n.key),
        hasChildren: childrenOf(n).length > 0,
        caseName: n.kind === "api_case" ? (caseName.get(n.ref ?? "") ?? null) : null,
        onMenu,
        readOnly,
      },
    }));
  }, [nodes, layout, collapsed, selectedKey, badKeys, caseName, onMenu, readOnly]);

  const rfEdges: Edge[] = useMemo(() => {
    const pairs = visiblePairs(nodes, collapsed);
    return pairs
      .filter(([, p]) => !!p)
      .map(([n, p]) => ({
        id: p + "->" + n.key, source: p as string, target: n.key,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "#B4BBC2" },
        style: { stroke: "#B4BBC2" },
      }));
  }, [nodes, collapsed]);

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const k = menu.key;
    return [
      { key: "ctx-rename", label: <span data-testid="ctx-rename">重命名</span>,
        onClick: () => {
          select(k);
          // 选中即打开属性面板；下一步聚焦名称输入（面板同帧渲染，宏任务里再找）
          setTimeout(() => (document.querySelector("[data-testid='prop-name']") as HTMLInputElement | null)?.focus(), 0);
        } },
      { key: "ctx-duplicate", label: <span data-testid="ctx-duplicate">复制</span>, onClick: () => duplicateKey(k) },
      { key: "ctx-disable", label: <span data-testid="ctx-disable">禁用/启用</span>, onClick: () => toggleDisableKey(k) },
      { key: "ctx-insert-after", label: <span data-testid="ctx-insert-after">插入到后…</span>,
        children: (["sleep", "set_var", "assert", "extract", "script", "group", "if", "loop", "break"] as const)
          .map((kind) => ({
            key: "ins-" + kind, label: <span data-testid={"ctx-insert-" + kind}>{labelOf(kind)}</span>,
            onClick: () => useSceneStore.getState().addStep(kind, k),
          })) },
      { key: "ctx-move-into", label: <span data-testid="ctx-move-into">移入容器…</span>, onClick: () => setMoveIntoTarget(k) },
      { type: "divider" as const },
      { key: "ctx-delete", danger: true, label: <span data-testid="ctx-delete">删除</span>, onClick: () => removeKey(k) },
    ];
  }, [menu, duplicateKey, toggleDisableKey, removeKey, select]);

  return (
    <div ref={wrapRef} data-testid="scene-canvas" style={{ position: "relative", width: "100%", height: "100%", background: "var(--tp-bg-layout)" }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={() => undefined}
        onEdgesChange={() => undefined}
        nodesConnectable={false}
        deleteKeyCode={null}
        elementsSelectable
        onNodeClick={(_, n) => select(n.id)}
        onPaneClick={() => { select(null); setMenu(null); }}
        onSelectionChange={({ nodes: sel }) => setMulti(sel.map((n) => n.id))}
        selectionKeyCode="Shift"
        minZoom={0.5}
        maxZoom={2.0}
        fitView
        proOptions={{ hideAttribution: true }}
        onDrop={(e) => {
          e.preventDefault();
          if (readOnly) return; // 只读画布不收拖拽载荷
          const payload = readDrop(e.dataTransfer);
          if (payload) dropOn(payload as never, null); // 落在空白画布 = 追加到顶层末尾
        }}
        onDragOver={(e) => { e.preventDefault(); }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--tp-border)" />
        <MiniMap pannable zoomable style={{ width: 120, height: 80 }}
          onNodeClick={(_, n) => select(n.id)} />
      </ReactFlow>
      {dirty && (
        <span data-testid="canvas-hint-dirty" style={{ position: "absolute", top: 8, left: 8, color: "var(--tp-text-3)", fontSize: 12, zIndex: 4 }}>
          有未保存修改（Ctrl+S 保存；Shift+框选多选后可成组）
        </span>
      )}
      <Dropdown open={!!menu} onOpenChange={(o) => { if (!o) setMenu(null); }}
        menu={{ items: menuItems, style: { minWidth: 168 } }}
        placement="bottomLeft" autoAdjustOverflow>
        <span style={{ position: "absolute", left: menu?.x ?? -999, top: menu?.y ?? -999, width: 1, height: 1 }} />
      </Dropdown>
      <GroupButton />
      <MoveIntoModal targetKey={moveIntoTarget} onClose={() => setMoveIntoTarget(null)} />
    </div>
  );
}

function GroupButton() {
  const nodes = useSceneStore((s) => s.nodes);
  const readOnly = useSceneStore((s) => s.readOnly);
  const selectedKeys = useSceneStore((s) => s.selectedKeys);
  const groupSelected = useSceneStore((s) => s.groupSelected);
  // 只读画布不给结构编辑入口（D47 隐藏派）：拖放与右键菜单都闸了，成组这条以前漏着。
  if (readOnly || selectedKeys.length < 2) return null;
  // groupSelected 只支持同层成组，且做不到时是**静默 return**。这里若照旧画一颗
  // 「把选中的 N 步成组」的钮，点下去树纹丝不动——钮必须只在真能成组时给。
  if (!sameLevelSelection(nodes, selectedKeys)) {
    return (
      <span data-testid="canvas-group-note"
        style={{ position: "absolute", bottom: 12, left: 12, zIndex: 5, fontSize: 12, color: tpv.text[3] }}>
        选中的 {selectedKeys.length} 步不在同一层，成组只收同一层的步骤
      </span>
    );
  }
  return (
    <Button size="small" type="primary" ghost data-testid="canvas-group"
      style={{ position: "absolute", bottom: 12, left: 12, zIndex: 5 }}
      onClick={() => groupSelected()}>
      把选中的 {selectedKeys.length} 步成组
    </Button>
  );
}

/** 与 store.groupSelected 的「同一个父」判据同一套算法：那里改判据，这里就得跟着改。 */
function sameLevelSelection(nodes: StepNode[], keys: string[]): boolean {
  const parent = new Map<string, string | null>();
  for (const [node, p] of walk(nodes)) parent.set(node.key, p);
  const ps = new Set(keys.map((k) => parent.get(k) ?? null));
  return ps.size === 1;
}
