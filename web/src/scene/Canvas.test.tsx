// Canvas（§11.4.9/§11.7.3 画布）组件测试。此前覆盖零：18 个 data-testid 只被
// web/e2e/*.mjs（单跑、慢）摸过，vitest 侧一条都没有。钉的都是「e2e 摸不到、
// 单元测试恰好该拥有的纯派生与守卫」：
//   ① 拖放全链路（真实 store，不 spy，断言拖完之后的树形而非传参形状）：
//      落容器=移入、落叶子=插其后、落空白=追加顶层、kind 载荷带 ref/name、
//      空串 name 回落 labelOf、未知类型载荷整个丢弃、节点 drop 的 stopPropagation
//      保证同一 drop 不被 pane 再处理一遍（只 +1 个节点）；
//   ② readOnly（T22 报告详情口径）的三道闸：节点 drop / pane drop / 右键菜单
//      全线关死，draggable 属性摘掉；红角标语义属于编辑器，只读画布即使带着
//      serverIssues 也不许点亮 node-badge；
//   ③ 右键菜单：非只读才弹，弹出即选中；复制/禁用/删除/插入到后/移入容器各自
//      驱动真实 store 出可见结果；MoveIntoModal 把「移进自己」被 store 拒绝时
//      说出 message.warning（不是静默失败）；
//   ④ 节点派生层：data-run-status / tp-node-running / 禁用 opacity=0.55 /
//      data-selected 全部跟随 store（含 run.stepStatus 的 SSE 投影实时变化）；
//   ⑤ 折叠把手 → 真实 toggleCollapsed → 子树从画布消失（折叠是视图层隐藏）。
// 【层级声明：Tier 1——渲染的是真 @xyflow/react，本文件没有 mock 它。】jsdom 垫片
// 全部收在本文件内（照 ListMode/bench 的口径，不动 vitest.config、不建共享 setup）：
//   matchMedia（antd 响应式，jsdom 没有）、ResizeObserver 空壳（xyflow 量尺寸用，
//   jsdom 没有 → 空实现让挂载走完）、window.DOMMatrixReadOnly（updateNodeInternals
//   解析 viewport transform 用）。实测真流程的节点、边、pane 都真实渲染，drop/contextmenu
//   走的是真 ReactFlow 的事件布线（ReactFlow 的 onDrop 经 ...rest 落在 .rf__wrapper 上）。
// 因此本文件【不证明】：视口几何（fitView/缩放 0.5–2.0/小地图/平移）、真实浏览器
// dragstart→drop 的 DataTransfer 生命周期（jsdom 的 fake DataTransfer 只覆盖
// getData/setData/types）、Shift 框选 onSelectionChange 的指针手势——这些归 e2e。
// 【FINDING（未修，测试按现状记录）】readOnly 只摘 draggable 属性，NodeInner 的
// onDragStart 本身不判 readOnly：程序化 dragstart 仍会写入 DND_NODE。浏览器里
// draggable=false 让该事件无法自然发生，故是纸面问题不是实害；下面钉的是
// draggable 属性这道真闸，不去给 onDragStart 的缺闸背书。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// RTL 的 act（不是裸 react）：它会把 IS_REACT_ACT_ENVIRONMENT 配好，
// 裸 react act 在本环境只警告不 flush。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";

// —— jsdom 垫片（Tier 1 的入场券，理由见文件头）——
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
// xyflow 用它观察容器/节点尺寸；jsdom 没有全局 ResizeObserver。空壳即可：
// 本文件不断言任何几何，只需要挂载不炸。
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
// updateNodeInternals 用 new window.DOMMatrixReadOnly(computedStyle.transform) 取 zoom。
class FakeDOMMatrixReadOnly {
  m22 = 1;
  constructor(_css?: string) {}
}
(window as unknown as Record<string, unknown>).DOMMatrixReadOnly = FakeDOMMatrixReadOnly;

import Canvas, { DND_KIND, DND_NAME, DND_NODE, DND_REF } from "./Canvas";
import type { Issue } from "./graphOps";
import { useSceneStore } from "./store";
import type { StepNode } from "./stepTypes";
import type { CaseRow } from "../api/api";

/** 标准树：n1(group)[n1.1 api_case, n1.2 sleep] → n2(loop)[n2.1 assert] → n3(extract, disable) */
function tree(): StepNode[] {
  return [
    { key: "n1", kind: "group", name: "下单流程", children: [
      { key: "n1.1", kind: "api_case", name: "创建订单", ref: "c1" },
      { key: "n1.2", kind: "sleep", name: "等待落库", config: { ms: 100 } },
    ] },
    { key: "n2", kind: "loop", name: "重试圈", config: { mode: "count", max_iter: 3 }, children: [
      { key: "n2.1", kind: "assert", name: "核身断言", config: { assertions: [{ type: "status_code", expected: 200 }] } },
    ] },
    { key: "n3", kind: "extract", name: "被禁的一步", disable: true,
      config: { rules: [{ var: "v", from: "last_response", expr: "$.a" }] } },
  ];
}

function caseRow(over: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "c1", project_id: "p1", definition_id: "d1", name: "已支付订单", priority: "P0",
    request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
    effective_request: null, ...over,
  };
}

const j = (v: unknown) => JSON.stringify(v);

/** 灌 store：baseline 默认与 nodes 对齐（不亮 dirty），逐项 over 覆盖。全程真实 store。 */
function seed(over: Record<string, unknown> = {}): void {
  const nodes = (over.nodes as StepNode[] | undefined) ?? tree();
  useSceneStore.setState({
    loading: false, projectId: "p1", scenarioId: "s1",
    nodes, baselineNodes: j(nodes), layout: {}, baselineEnvId: null, envId: null,
    collapsed: [], selectedKey: null, selectedKeys: [],
    serverIssues: [], cases: [caseRow()], clipboard: null, readOnly: false,
    variables: {}, baselineVariables: "{}", failFast: true, baselineFailFast: true,
    maxRuntimeMs: null, baselineMaxRuntimeMs: null,
    commonAssertions: [], baselineCommonAssertions: "[]",
    run: { ...useSceneStore.getState().run, stepStatus: {} },
    ...over,
  } as never);
}

function renderCanvas(over: Record<string, unknown> = {}): void {
  seed(over);
  // motion:false 同 ListMode/CaseList：rc-motion 的 leave 动画在 jsdom 里不完成
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <Canvas />
    </ConfigProvider>,
  );
}

function node(key: string): HTMLElement {
  const el = document.querySelector(`[data-testid="scene-node-${key}"]`);
  if (!el) throw new Error("节点没渲染: " + key);
  return el as HTMLElement;
}
const findNode = (key: string) => {
  const rec = (list: StepNode[]): StepNode | null => {
    for (const n of list) {
      if (n.key === key) return n;
      const r = rec(n.children ?? []);
      if (r) return r;
    }
    return null;
  };
  return rec(useSceneStore.getState().nodes);
};
const topKeys = () => useSceneStore.getState().nodes.map((n) => n.key);
const countAll = () => {
  let c = 0;
  const rec = (list: StepNode[]) => {
    for (const n of list) {
      c++;
      rec(n.children ?? []);
    }
  };
  rec(useSceneStore.getState().nodes);
  return c;
};
const childrenKeys = (key: string) => (findNode(key)?.children ?? []).map((n) => n.key);

/** jsdom 没实现 DataTransfer（ListMode 同款桩）；Canvas 只用到 getData/setData/types。 */
function fakeDt(map: Record<string, string>): DataTransfer {
  const data: Record<string, string> = { ...map };
  return {
    types: Object.keys(data),
    getData: (t: string) => data[t] ?? "",
    setData: (t: string, v: string) => { data[t] = v; },
    effectAllowed: "",
  } as unknown as DataTransfer;
}

/** ReactFlow 的 onDrop/onDragOver 经 ...rest 落在根包装 div（rf__wrapper）上：
 *  「落在空白画布」的 pane 路径就钉在这里。 */
function pane(): HTMLElement {
  return document.querySelector('[data-testid="rf__wrapper"]') as HTMLElement;
}

/** antd Dropdown 浮层 portal 进 body；motion:false 下关掉的浮层不卸载只挂 -hidden
 *  （ListMode 同款口径）→ 一律只认非 -hidden 的那份，点击落在菜单项本体（li）。 */
function visibleMenuEl(testid: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`))) {
    if (el.closest(".ant-dropdown-hidden")) continue;
    return (el.closest(".ant-dropdown-menu-item") ?? el.closest(".ant-dropdown-menu-submenu-title") ?? el) as HTMLElement;
  }
  return null;
}
function visibleSpan(testid: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`))
    .find((el) => !el.closest(".ant-dropdown-hidden")) ?? null;
}
async function clickItem(testid: string): Promise<void> {
  await waitFor(() => expect(visibleMenuEl(testid)).not.toBeNull(), { timeout: 4000 });
  fireEvent.click(visibleMenuEl(testid)!);
}
/** rc-menu 子菜单要 pointerover+mouseover 衍生事件才展开（ListMode 同款三件套）。 */
function hoverOpen(el: HTMLElement): void {
  fireEvent.pointerOver(el);
  fireEvent.mouseOver(el);
  fireEvent.mouseEnter(el);
}
/** 右键节点 = 弹菜单的真实入口（onContextMenu 走 contextmenu DOM 事件）。 */
function rightClick(key: string): void {
  fireEvent.contextMenu(node(key), { clientX: 120, clientY: 80 });
}
async function openMenuFor(key: string): Promise<void> {
  rightClick(key);
  await waitFor(() => expect(visibleSpan("ctx-rename")).not.toBeNull(), { timeout: 4000 });
}
/** 往 run.stepStatus 灌 SSE 投影（zustand v5：选择器返回原始字符串保稳定引用）。 */
function pushRunStatus(stepStatus: Record<string, { status: string }>): void {
  act(() => {
    useSceneStore.setState({ run: { ...useSceneStore.getState().run, stepStatus } } as never);
  });
}

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({}),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Canvas（§11.4.9 画布，真 @xyflow/react + 真 store）", () => {
  it("树→画布：节点/折叠把手渲染；点把手走真实 toggleCollapsed，子树整棵消失", () => {
    renderCanvas();
    expect(document.querySelector('[data-testid="scene-node-n1.1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="node-collapse-n1"]')!.textContent).toBe("−");
    fireEvent.click(document.querySelector('[data-testid="node-collapse-n1"]')!);
    expect(useSceneStore.getState().collapsed).toEqual(["n1"]);
    // 折叠是视图层隐藏（列表模式仍看全量）：子节点从画布消失，把手变「+」
    expect(document.querySelector('[data-testid="scene-node-n1.1"]')).toBeNull();
    expect(document.querySelector('[data-testid="scene-node-n1.2"]')).toBeNull();
    expect(document.querySelector('[data-testid="node-collapse-n1"]')!.textContent).toBe("+");
    // 叶子节点没有把手
    expect(document.querySelector('[data-testid="node-collapse-n3"]')).toBeNull();
    // 全程零网络请求（画布不自己取数）
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("节点派生：run.stepStatus → data-run-status + tp-node-running，SSE 推进实时反映；禁用=opacity 0.55 + 已禁用标签；data-selected 跟随 selectedKey", () => {
    renderCanvas({ selectedKey: "n2" });
    expect(node("n2").getAttribute("data-selected")).toBe("true");
    expect(node("n1").getAttribute("data-selected")).toBe("false");
    expect(node("n1").getAttribute("data-run-status")).toBeNull();
    expect(node("n1").classList.contains("tp-node-running")).toBe(false);
    // SSE 投影（store.run.stepStatus 单一真相）推进 → 节点呼吸高亮跟上
    pushRunStatus({ n1: { status: "running" }, n2: { status: "fail" } });
    expect(node("n1").getAttribute("data-run-status")).toBe("running");
    expect(node("n1").classList.contains("tp-node-running")).toBe(true);
    expect(node("n2").getAttribute("data-run-status")).toBe("fail");
    // 只有 running 挂 tp-node-running 动画类；fail 只换边框色不挂类
    expect(node("n2").classList.contains("tp-node-running")).toBe(false);
    // 禁用步骤：半透明 + 「已禁用」标签（disable ≠ 隐藏）
    expect(node("n3").style.opacity).toBe("0.55");
    expect(screen.getByTestId("node-disabled-tag").textContent).toBe("已禁用");
    expect(node("n3").textContent).toContain("被禁的一步");
  });

  it("api_case 摘要走 cases 名字表；serverIssues 点亮红角标；readOnly 画布角标整体熄灭", () => {
    renderCanvas({
      serverIssues: [{ node_key: "n1.1", code: "srv", message: "服务器口径的问题", path: "$" } as Issue],
    });
    expect(node("n1.1").textContent).toContain("已支付订单"); // ref=c1 → cases 命中
    expect(document.querySelectorAll('[data-testid="node-badge"]')).toHaveLength(1);
    expect(node("n1.1").querySelector('[data-testid="node-badge"]')).not.toBeNull();
    expect(node("n3").querySelector('[data-testid="node-badge"]')).toBeNull();

    // 只读画布（报告快照）：红角标语义属于编辑器——带着同一份 serverIssues 也不许亮
    cleanup();
    renderCanvas({
      readOnly: true,
      serverIssues: [{ node_key: "n1.1", code: "srv", message: "服务器口径的问题", path: "$" } as Issue],
    });
    expect(document.querySelectorAll('[data-testid="node-badge"]')).toHaveLength(0);
  });

  it("拖出：onDragStart 把本节点 key 写进 DND_NODE + effectAllowed=move；readOnly 下 draggable 属性摘掉", () => {
    renderCanvas();
    expect(node("n1").getAttribute("draggable")).toBe("true");
    const dt = fakeDt({});
    fireEvent.dragStart(node("n1.2"), { dataTransfer: dt });
    expect(dt.getData(DND_NODE)).toBe("n1.2");
    expect(dt.effectAllowed).toBe("move");

    cleanup();
    renderCanvas({ readOnly: true });
    // 只读画布不供给结构编辑：拖拽源头的 enumerated 属性必须是 false
    // （钉渲染现状：draggable={false} 序列化在 DOM 上是 "false"，同 ListMode.test 口径）
    expect(node("n1").getAttribute("draggable")).toBe("false");
  });

  it("落在节点上：容器=移入其 children 末尾；嵌套叶子=按 store 口径落顶层末尾（真实树形）", () => {
    renderCanvas();
    // n3 拖进容器 n1 → n1.children 末尾
    fireEvent.drop(node("n1"), { dataTransfer: fakeDt({ [DND_NODE]: "n3" }) });
    expect(topKeys()).toEqual(["n1", "n2"]);
    expect(childrenKeys("n1")).toEqual(["n1.1", "n1.2", "n3"]);
    // 嵌套叶子 n1.1 作目标：store.dropOn 对非容器目标走「插到其后」，但
    // insertIndexAfterTopLevel 明说「target 不在顶层 → 落末尾」，于是 n2.1 从 loop
    // 里出来、追加到顶层末尾（NodeInner 注释里的「插在它后面」只在同层时成立）。
    // 这里钉 store 的实际落点，不替注释背书。
    fireEvent.drop(node("n1.1"), { dataTransfer: fakeDt({ [DND_NODE]: "n2.1" }) });
    expect(topKeys()).toEqual(["n1", "n2", "n2.1"]);
    expect(childrenKeys("n2")).toEqual([]);
    expect(childrenKeys("n1")).toEqual(["n1.1", "n1.2", "n3"]);
    // 同层叶子目标才真的「插其后」（全新种子）：顶层 n2 拖到顶层叶子 n3 后
    cleanup();
    renderCanvas();
    fireEvent.drop(node("n3"), { dataTransfer: fakeDt({ [DND_NODE]: "n2" }) });
    expect(topKeys()).toEqual(["n1", "n3", "n2"]);
  });

  it("readDrop 解析：node 优先于 kind；kind 带 ref/name；空串 name 回落 labelOf；未知类型整个丢弃", () => {
    renderCanvas();
    // node 载荷优先：即便同时带着 kind，也只走「移动已有节点」，不新增
    fireEvent.drop(node("n3"), {
      dataTransfer: fakeDt({ [DND_NODE]: "n1.2", [DND_KIND]: "sleep" }),
    });
    expect(topKeys()).toEqual(["n1", "n2", "n3", "n1.2"]); // n1.2 挪到顶层、插叶子 n3 之后
    expect(countAll()).toBe(6); // 全树节点数不变 = kind 没被当成新步骤

    // kind 载荷带 ref/name：新 api_case 落在 n3 后、名字=拖来的名字、ref 透传
    fireEvent.drop(node("n3"), {
      dataTransfer: fakeDt({ [DND_KIND]: "api_case", [DND_REF]: "c9", [DND_NAME]: "拖来的用例" }),
    });
    const created = topKeys().map(findNode).find((n) => n?.kind === "api_case" && n.ref === "c9")!;
    expect(created).toMatchObject({ kind: "api_case", name: "拖来的用例", ref: "c9" });

    // 空串 name（资产树没给名字的控件）→ 回落 labelOf("sleep")="等待"，而不是无名节点
    fireEvent.drop(node("n3"), { dataTransfer: fakeDt({ [DND_KIND]: "sleep", [DND_NAME]: "" }) });
    expect(topKeys().map(findNode).some((n) => n?.kind === "sleep" && n.name === "等待")).toBe(true);

    // 未知类型载荷（既无 node 也无 kind）→ readDrop 返回 null，树逐字不动
    const snapshot = j(useSceneStore.getState().nodes);
    fireEvent.drop(node("n3"), { dataTransfer: fakeDt({ "text/plain": "n1" }) });
    expect(j(useSceneStore.getState().nodes)).toBe(snapshot);
  });

  it("stopPropagation：落节点的 drop 不被 pane 再处理一遍（全树只 +1，不重复追加）", () => {
    renderCanvas();
    const before = countAll();
    // pane（rf__wrapper）是节点的祖先；没有 stopPropagation 会既插其后又追加顶层 = +2
    fireEvent.drop(node("n3"), { dataTransfer: fakeDt({ [DND_KIND]: "set_var" }) });
    expect(countAll()).toBe(before + 1);
  });

  it("空白画布（pane）drop：kind 载荷→真实追加到顶层末尾；node 载荷→挪到顶层", () => {
    renderCanvas();
    fireEvent.drop(pane(), { dataTransfer: fakeDt({ [DND_KIND]: "sleep", [DND_NAME]: "尾步" }) });
    expect(topKeys().slice(0, 3)).toEqual(["n1", "n2", "n3"]);
    expect(useSceneStore.getState().nodes.at(-1)).toMatchObject({ kind: "sleep", name: "尾步" });
    // 已有节点落到空白 = 挪到顶层末尾（dropOn 的 targetKey=null 分支）
    fireEvent.drop(pane(), { dataTransfer: fakeDt({ [DND_NODE]: "n2.1" }) });
    expect(topKeys().at(-1)).toBe("n2.1");
    expect(childrenKeys("n2")).toEqual([]);
  });

  it("readOnly 的 drop 三道闸全关死：节点不落、pane 不落、树形逐字不动", () => {
    renderCanvas({ readOnly: true });
    const snapshot = j(useSceneStore.getState().nodes);
    fireEvent.drop(node("n1"), { dataTransfer: fakeDt({ [DND_NODE]: "n3" }) });
    fireEvent.drop(node("n1"), { dataTransfer: fakeDt({ [DND_KIND]: "sleep" }) });
    fireEvent.drop(pane(), { dataTransfer: fakeDt({ [DND_KIND]: "sleep" }) });
    fireEvent.drop(pane(), { dataTransfer: fakeDt({ [DND_NODE]: "n1" }) });
    expect(j(useSceneStore.getState().nodes)).toBe(snapshot);
  });

  it("右键菜单：只读不弹不选中；非只读弹出即选中该节点，复制/禁用/删除驱动真实 store", async () => {
    // 只读画布：contextmenu 既不弹菜单也不改变选中（onContextMenu 的 readOnly 早退）
    renderCanvas({ readOnly: true });
    rightClick("n3");
    expect(document.querySelector(".ant-dropdown")).toBeNull();
    expect(useSceneStore.getState().selectedKey).toBe(null);

    cleanup();
    renderCanvas();
    rightClick("n3");
    expect(useSceneStore.getState().selectedKey).toBe("n3"); // 弹菜单顺带选中（重命名口径）
    // 全套入口一次钉齐
    for (const t of ["ctx-rename", "ctx-duplicate", "ctx-disable", "ctx-insert-after", "ctx-move-into", "ctx-delete"]) {
      await waitFor(() => expect(visibleSpan(t)).not.toBeNull(), { timeout: 4000 });
    }
    // 复制：n3 就地副本（graphOps.duplicate：新 key + 「 副本」后缀，插原节点之后）
    await clickItem("ctx-duplicate");
    expect(topKeys()).toEqual(["n1", "n2", "n3", "n4"]);
    expect(findNode("n4")).toMatchObject({ kind: "extract", name: "被禁的一步 副本" });
    // 禁用/启用：disable 位真的翻过去
    await openMenuFor("n3");
    await clickItem("ctx-disable");
    expect(findNode("n3")!.disable).toBeFalsy();
    // 删除：真实 removeKey，节点从树里消失（副本 n4 不受牵连）
    await openMenuFor("n3");
    await clickItem("ctx-delete");
    expect(topKeys()).toEqual(["n1", "n2", "n4"]);
  });

  it("右键「插入到后…」子菜单：addStep(kind, 本节点) 真实插到其后", async () => {
    renderCanvas();
    await openMenuFor("n3");
    await waitFor(() => expect(visibleMenuEl("ctx-insert-after")).not.toBeNull(), { timeout: 4000 });
    hoverOpen(visibleMenuEl("ctx-insert-after")!);
    await clickItem("ctx-insert-sleep");
    // n3 是叶子 → insertAfter：新 sleep（key=n4）落在 n3 后面一位，带 sleep 底稿
    expect(topKeys()).toEqual(["n1", "n2", "n3", "n4"]);
    expect(findNode("n4")).toMatchObject({ kind: "sleep", name: "等待" });
  });

  it("右键「移入容器…」：Modal 列全容器 + 移到顶层；移进自己→store 拒绝并说出告警", async () => {
    renderCanvas();
    await openMenuFor("n3");
    await clickItem("ctx-move-into");
    await waitFor(() => expect(screen.getByTestId("move-into-modal")).toBeTruthy(), { timeout: 4000 });
    // 移入合法容器 n1：真实 moveInto 成功
    fireEvent.click(screen.getByTestId("move-into-n1"));
    expect(childrenKeys("n1")).toContain("n3");
    // 移进自己 = store.moveInto 返回 false → message.warning（不许静默失败）
    const warn = vi.spyOn(message, "warning");
    await openMenuFor("n1");
    await clickItem("ctx-move-into");
    await waitFor(() => expect(screen.getByTestId("move-into-n1")).toBeTruthy(), { timeout: 4000 });
    const snapshot = j(useSceneStore.getState().nodes);
    fireEvent.click(screen.getByTestId("move-into-n1"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(j(useSceneStore.getState().nodes)).toBe(snapshot);
    // 移到顶层：从 n1 的 children 里回到顶层
    await openMenuFor("n3");
    await clickItem("ctx-move-into");
    await waitFor(() => expect(screen.getByTestId("move-into-top")).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(screen.getByTestId("move-into-top"));
    expect(topKeys()).toContain("n3");
    expect(childrenKeys("n1")).not.toContain("n3");
  });

  it("多选成组钮：选中 <2 不出现；selectedKeys≥2 出现、计数跟随、点击真实触发 store.groupSelected", () => {
    renderCanvas();
    expect(screen.queryByTestId("canvas-group")).toBeNull();
    act(() => {
      useSceneStore.getState().setMulti(["n1", "n2"]);
    });
    const btn = screen.getByTestId("canvas-group");
    expect(btn.textContent).toContain("2");
    act(() => {
      useSceneStore.getState().setMulti(["n1", "n2", "n3"]);
    });
    expect(screen.getByTestId("canvas-group").textContent).toContain("3");
    fireEvent.click(screen.getByTestId("canvas-group"));
    const s = useSceneStore.getState();
    // 上面两行钉 Canvas 的责任（钮的显隐/计数/点击接线）；下面钉成组真的动了树。
    // 【D116 曾经在此红过】这条断言原本逐字钉的是「顶层多一个空组、被选的三步原地
    // 不动」的坏现状，注释写明「修复后此断言会变红、逼着改的人回来改口径」。修复在
    // graphOps.editList：容器类一律递归（不再只认 Array.isArray(children)），
    // groupSelected 建出来的 `group` 不带 children 字段也能被移进。口径由此改成
    // 「三个选中步真的进了新组、顶层只剩新组」。
    expect(s.nodes.map((n) => n.key)).toEqual(["n4"]);
    expect(s.nodes.at(-1)).toMatchObject({ key: "n4", kind: "group", name: "分组" });
    expect(findNode("n4")!.children!.map((c) => c.key)).toEqual(["n1", "n2", "n3"]);
    expect(s.selectedKey).toBe("n4");
    // groupSelected 本身清空 selectedKeys；但真 ReactFlow 的 onSelectionChange 会把
    // 「n4 现在是选中节点」回灌 setMulti(["n4"])——这是真流程接线的可观察证据。
    expect(s.selectedKeys).toEqual(["n4"]);
  });

  it("成组钮只在真能成组时给：跨层多选降级成人话注记；只读画布两者都不给", () => {
    // 旧实现：只要 selectedKeys≥2 就画「把选中的 N 步成组」，而 store.groupSelected
    // 对「不同父」是静默 return（store.ts:613）——点下去树纹丝不动，按钮骗人。
    renderCanvas();
    act(() => { useSceneStore.getState().setMulti(["n1.1", "n3"]); }); // 一个在 n1 里、一个在顶层
    expect(screen.queryByTestId("canvas-group")).toBeNull();
    expect(screen.getByTestId("canvas-group-note").textContent).toContain("不在同一层");
    // 注记不是死路：改选同层的两步，钮自己回来
    act(() => { useSceneStore.getState().setMulti(["n1.1", "n1.2"]); });
    expect(screen.queryByTestId("canvas-group-note")).toBeNull();
    expect(screen.getByTestId("canvas-group")).not.toBeNull();

    // 只读画布：成组是结构编辑，与拖放/右键菜单同闸（隐藏派，不是禁用）
    cleanup();
    renderCanvas({ readOnly: true });
    act(() => { useSceneStore.getState().setMulti(["n1", "n2", "n3"]); });
    expect(screen.queryByTestId("canvas-group")).toBeNull();
    expect(screen.queryByTestId("canvas-group-note")).toBeNull();
  });

  it("dirty 提示：nodes 偏离 baseline 亮「有未保存修改」，对齐 baseline 不亮", () => {
    renderCanvas({ baselineNodes: "[]" }); // 基线 ≠ 现状
    expect(screen.getByTestId("canvas-hint-dirty").textContent).toContain("未保存");
    cleanup();
    renderCanvas(); // seed 默认 baseline 与 nodes 对齐
    expect(screen.queryByTestId("canvas-hint-dirty")).toBeNull();
  });

  // scene-canvas 包装 div 的全部真实职责就两件事（读码结论，wrapRef 在 Canvas 里
  // 只有 onMenu 一处消费者）：① 它是 wrapRef 的挂靠点——右键菜单坐标 = 鼠标 client
  // 坐标减去【这个节点】的 rect 原点；② 它 position:relative，是 Dropdown 锚点 span
  // 等绝对定位层的包含块，于是「减原点」与「按原点摆回去」两端咬合成同一个坐标系。
  // 下面用 stub 的 rect 原点（jsdom 全 0 会让减法退化成恒等，什么都钉不住）把这条
  // 坐标链一次钉死：ref 挪到内层 ReactFlow 或别的 div，减法立刻取不到 50/30 原点。
  it("scene-canvas：wrapRef 就挂在这个 testid 节点上——右键菜单坐标减它的 rect 原点，绝对定位层相对它解析", async () => {
    renderCanvas();
    const wrap = screen.getByTestId("scene-canvas");
    // pane 与节点都在包装体内：既有测试在 pane()/node() 上演练的 drop/contextmenu
    // 解析于这个盒子里，而不是 document。
    expect(wrap.contains(pane())).toBe(true);
    expect(wrap.contains(node("n1"))).toBe(true);
    // 包含块：position:relative 是「减原点」这步数学有意义的前提。
    expect(getComputedStyle(wrap).position).toBe("relative");
    // 锚点 span（menu=null 期）停在 -999，不给任何人看见。
    const anchor = Array.from(wrap.querySelectorAll("span")).find((s) => s.style.width === "1px") as HTMLElement;
    expect(anchor.style.left).toBe("-999px");

    // 真 rect 只有这里 stub（几何不在本文件的证明范围，但减法链路必须有非零原点）。
    wrap.getBoundingClientRect = () => ({
      left: 50, top: 30, width: 800, height: 600, right: 850, bottom: 630, x: 50, y: 30,
      toJSON: () => ({}),
    }) as DOMRect;
    fireEvent.contextMenu(node("n2"), { clientX: 300, clientY: 210 });
    await waitFor(() => expect(visibleSpan("ctx-rename")).not.toBeNull(), { timeout: 4000 });
    // 锚点 = client − 包装体原点（wrapRef 的真身挪走一步，这里就拿回未减法的 300/210）。
    expect(anchor.style.left).toBe("250px");
    expect(anchor.style.top).toBe("180px");
    // 弹菜单顺带选中（重命名口径）——菜单驱动的仍是同一个 store。
    expect(useSceneStore.getState().selectedKey).toBe("n2");
  });
});
