// ListMode（T20，§11.4.10 列表模式）的组件测试。这个文件此前零覆盖：28 个前端测试与
// web/e2e/*.mjs 都不引用它的 17 个 data-testid（e2e/sceneList.spec.mjs 只摸到行计数/搜索/
// 选中/菜单计数的边）。这里钉的是「别的组件赖以协作的契约」：
// ① 每个行动作到底把哪个 key 传给 store 的哪个动作——传错 id 对其它任何测试都不可见；
// ② 编号/层级是 rowsOf 算出来的（1.1、2.1），折叠只隐藏不改变编号口径；
// ③ 搜索是纯客户端过滤（0 网络请求）：命中 name 或 key、大小写不敏感，过滤态 draggable 摘掉；
// ④ 勾选框/行菜单「禁用」走同一个 toggleDisableKey(key)，勾选不带动选中；
// ⑤ 拖放分叉：自身=no-op、容器=moveInto、普通行=moveNodeTo(parent, idx+1)、kind 载荷=dropOn；
// ⑥ 剪贴板按钮的有无严格跟随 clipboard 状态，粘贴只发 pasteInto(null)；
// ⑦ api_case 摘要的名字解析：命中 cases → 名字；ref 查无 → 前 8 位；无 ref → 未选用例；
// ⑧ serverIssues ∪ 本地非法 key → 行红角标（node-badge）的落点。
// 手法照抄同目录 PropsPanel.assert.test.tsx（matchMedia 垫片 + 直渲）与 CaseList.test.tsx
// （fetch 桩、motion:false）。ListMode 零 props、零直接请求：状态从 useSceneStore.setState
// 灌入，动作断言用 spyOn 换掉 store 动作（不污染其它用例，测完逐字还原）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import ListMode from "./ListMode";
import { DND_KIND, DND_NAME, DND_NODE, DND_REF } from "./Canvas";
import type { Issue } from "./graphOps";
import { useSceneStore } from "./store";
import type { StepNode } from "./stepTypes";
import type { CaseRow } from "../api/api";

/** 被换掉的 store 动作；每次 renderWith 重新安装，收尾时逐字还原真实实现。 */
const ACTION_NAMES = [
  "select", "addStep", "dropOn", "removeKey", "duplicateKey", "toggleDisableKey",
  "moveInto", "moveNodeTo", "copyNode", "pasteInto",
] as const;
const act = {} as Record<(typeof ACTION_NAMES)[number], ReturnType<typeof vi.fn>>;
let saved: Array<[string, unknown]> = [];

function installSpies(): void {
  restoreSpies();
  const store = useSceneStore.getState() as unknown as Record<string, unknown>;
  saved = ACTION_NAMES.map((n) => [n, store[n]]);
  const next: Record<string, unknown> = {};
  for (const n of ACTION_NAMES) next[n] = vi.fn();
  useSceneStore.setState(next as never);
  const st = useSceneStore.getState() as unknown as Record<string, never>;
  for (const n of ACTION_NAMES) act[n] = st[n];
}
function restoreSpies(): void {
  if (!saved.length) return;
  useSceneStore.setState(Object.fromEntries(saved) as never);
  saved = [];
}

function caseRow(over: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "c1", project_id: "p1", definition_id: "d1", name: "已支付订单", priority: "P0",
    request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
    effective_request: null, ...over,
  };
}

/** 标准树：n1(group)[n1.1 api_case, n1.2 sleep] → n2(loop)[n2.1 assert] → n3(extract, disable) → n4(group, 空)。 */
function tree(): StepNode[] {
  return [
    { key: "n1", kind: "group", name: "下单流程", children: [
      { key: "n1.1", kind: "api_case", name: "创建订单", ref: "c1" },
      { key: "n1.2", kind: "sleep", name: "等待落库", config: { ms: 100 } },
    ] },
    { key: "n2", kind: "loop", name: "重试圈", config: { mode: "count", max_iter: 3 }, children: [
      { key: "n2.1", kind: "assert", name: "核身断言", config: { assertions: [{ type: "status_code", expected: 200 }] } },
    ] },
    { key: "n3", kind: "extract", name: "被禁的一步", disable: true, config: { rules: [{ var: "v", from: "last_response", expr: "$.a" }] } },
    { key: "n4", kind: "group", name: "空分组", children: [] },
  ];
}

function seed(over: Record<string, unknown> = {}): void {
  useSceneStore.setState({
    loading: false, projectId: "p1", scenarioId: "s1",
    nodes: tree(), collapsed: [], selectedKey: null, selectedKeys: [],
    serverIssues: [], cases: [caseRow()], clipboard: null, readOnly: false,
    ...over,
  } as never);
}

/** 渲染（motion:false 同 CaseList：rc-motion 的 leave 动画在 jsdom 里不完成）。 */
function renderWith(over: Record<string, unknown> = {}): void {
  seed(over);
  installSpies();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ListMode />
    </ConfigProvider>,
  );
}

function row(key: string): HTMLElement {
  return document.querySelector(`[data-testid="scene-list-row"][data-key="${key}"]`) as HTMLElement;
}
function rowKeys(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="scene-list-row"]'))
    .map((n) => n.getAttribute("data-key")!);
}

/** 模拟 DataTransfer（jsdom 没有实现；ListMode 只用到 getData/types/setData）。 */
function fakeDt(map: Record<string, string>): DataTransfer {
  const data: Record<string, string> = { ...map };
  return {
    types: Object.keys(data),
    getData: (t: string) => data[t] ?? "",
    setData: (t: string, v: string) => { data[t] = v; },
    effectAllowed: "",
  } as unknown as DataTransfer;
}

/** antd 浮层 portal 进 body，motion:false 下关掉的浮层不卸载、只挂 -hidden
 *  （StepListEditor.test.tsx:174 同款口径）→ 每行一个 Dropdown 实例，开过的浮层全部留在
 *  DOM 里，testid 会撞车，一律只认非 -hidden 的那份。菜单里 data-testid 在 label 的
 *  <span> 上，点击要落在菜单项本体（li）。 */
function visibleMenuEl(testid: string): HTMLElement | null {
  const spans = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`));
  for (const el of spans) {
    if (el.closest(".ant-dropdown-hidden")) continue;
    return (el.closest(".ant-dropdown-menu-item") ?? el.closest(".ant-dropdown-menu-submenu-title") ?? el) as HTMLElement;
  }
  return null;
}
/** 同口径但停在 label <span> 上（读文案用，不折到 li）。 */
function visibleSpan(testid: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`))
    .find((el) => !el.closest(".ant-dropdown-hidden")) ?? null;
}
async function clickItem(testid: string): Promise<void> {
  await waitFor(() => expect(visibleMenuEl(testid)).not.toBeNull(), { timeout: 4000 });
  fireEvent.click(visibleMenuEl(testid)!);
}
/** 打开/收起某行的 [···] 菜单（trigger=click，再点一次收起；钮本身 stopPropagation）。 */
function openMenu(rowKey: string): void {
  fireEvent.click(row(rowKey).querySelector('[data-testid="list-menu"]')!);
}
/** rc 系的 onMouseEnter（工具栏 Dropdown 默认 hover 触发、rc-menu 子菜单）要 mouseover
 *  衍生事件才认，fireEvent.mouseEnter 单独发不触发，三件套齐上
 *  （StepListEditor.test.tsx 的 hoverInsertSubmenuClick 同款）。 */
function hoverOpen(el: HTMLElement): void {
  fireEvent.pointerOver(el);
  fireEvent.mouseOver(el);
  fireEvent.mouseEnter(el);
}

beforeEach(() => {
  // ListMode 零直接请求：这个桩只记录不该发生的请求（空态/失败态不许偷偷拉数据）。
  global.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({}),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  restoreSpies();
  vi.restoreAllMocks();
});

describe("ListMode（§11.4.10 列表模式）", () => {
  it("行序/编号/层级：与画布同一棵树的第二种视图（1 / 1.1 / 1.2 / 2 / 2.1 / 3 / 4）", () => {
    renderWith();
    expect(rowKeys()).toEqual(["n1", "n1.1", "n1.2", "n2", "n2.1", "n3", "n4"]);
    const text = (key: string) => row(key).textContent ?? "";
    expect(text("n1")).toContain("1");
    expect(text("n1.1")).toContain("1.1");
    expect(text("n1.2")).toContain("1.2");
    expect(text("n2.1")).toContain("2.1");
    expect(text("n3")).toContain("3");
    // 名字缺省显示 key；禁用行仍在列表里（禁用≠隐藏）
    expect(text("n1.1")).toContain("创建订单");
    expect(text("n3")).toContain("被禁的一步");
  });

  it("行摘要：每种 kind 的人话摘要按 config 算（×3 次 / 等待 100ms / 2 分支 / n 条…）", () => {
    seed({
      nodes: [
        { key: "n1", kind: "group", name: "g", children: [{ key: "n1.1", kind: "sleep", config: { ms: 100 } }] },
        { key: "n2", kind: "loop", name: "l", config: { mode: "count", max_iter: 3, cond: "" } },
        { key: "n3", kind: "loop", name: "w", config: { mode: "while", max_iter: 7, cond: "$.ok" } },
        { key: "n4", kind: "foreach", name: "f", config: { list_var: "orders", item_var: "o" } },
        { key: "n5", kind: "if", name: "i", config: { branches: [{ cond: "$.a", children: [] }, { cond: "else", children: [] }] } },
        { key: "n6", kind: "http_direct", name: "h", config: { method: "POST", url: "/order" } },
        { key: "n7", kind: "script", name: "s", config: { code: "x = 1" } },
        { key: "n8", kind: "assert", name: "a", config: { assertions: [{ type: "status_code", expected: 200 }, { type: "regex", expected: "x" }] } },
        { key: "n9", kind: "extract", name: "e", config: { rules: [{ var: "v", expr: "$.a" }] } },
        { key: "n10", kind: "group", name: "空", children: [] },
      ],
    });
    installSpies();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <ListMode />
      </ConfigProvider>,
    );
    expect(row("n1").textContent).toContain("1 子步");
    expect(row("n1.1").textContent).toContain("等待 100ms");
    expect(row("n2").textContent).toContain("×3 次");
    expect(row("n3").textContent).toContain("while ≤7 次");
    expect(row("n4").textContent).toContain("orders → o");
    expect(row("n5").textContent).toContain("2 分支");
    expect(row("n6").textContent).toContain("POST /order");
    expect(row("n7").textContent).toContain("受限沙箱脚本");
    expect(row("n8").textContent).toContain("2 条断言");
    expect(row("n9").textContent).toContain("1 条提取");
    expect(row("n10").textContent).toContain("分组（串行容器）");
  });

  it("api_case 摘要三段解析：cases 命中→名字；ref 查无→前 8 位；无 ref→未选用例", () => {
    renderWith({
      nodes: [
        { key: "n1", kind: "api_case", name: "甲", ref: "c1" },
        { key: "n2", kind: "api_case", name: "乙", ref: "deadbeefcafe0001" },
        { key: "n3", kind: "api_case", name: "丙" },
      ],
      cases: [caseRow({ id: "c1", name: "已支付订单" })],
    });
    expect(row("n1").textContent).toContain("API·已支付订单");
    expect(row("n2").textContent).toContain("API·deadbeef");
    expect(row("n3").textContent).toContain("API·未选用例");
  });

  it("红角标：serverIssues 与本地非法 key 各自点亮 node-badge，落点精确到行", () => {
    renderWith({
      serverIssues: [{ node_key: "n1.1", code: "srv", message: "服务器口径的问题", path: "$" } as Issue],
      nodes: [...tree(), { key: "bad key!", kind: "sleep", name: "坏钥匙", config: { ms: 1 } }],
    });
    const badges = screen.getAllByTestId("node-badge");
    expect(badges).toHaveLength(2);
    expect(row("n1.1").querySelector('[data-testid="node-badge"]')).not.toBeNull();
    expect(row("bad key!").querySelector('[data-testid="node-badge"]')).not.toBeNull();
    expect(row("n1").querySelector('[data-testid="node-badge"]')).toBeNull();
    expect(row("n3").querySelector('[data-testid="node-badge"]')).toBeNull();
  });

  it("折叠：点把手只隐藏后代且不改变剩余编号；叶子行不响应；再点展开", () => {
    renderWith({ collapsed: ["n1"] });
    expect(rowKeys()).toEqual(["n1", "n2", "n2.1", "n3", "n4"]);
    expect(row("n2").textContent).toContain("2");
    expect(row("n2.1").textContent).toContain("2.1"); // 折叠兄弟不重排编号
    // 叶子行 n3 的把手点了什么都不该发生
    fireEvent.click(screen.getByTestId("list-collapse-n3"));
    expect(useSceneStore.getState().collapsed).toEqual(["n1"]);
    fireEvent.click(screen.getByTestId("list-collapse-n2"));
    expect(rowKeys()).toEqual(["n1", "n2", "n3", "n4"]);
    fireEvent.click(screen.getByTestId("list-collapse-n1"));
    expect(rowKeys()).toEqual(["n1", "n1.1", "n1.2", "n2", "n3", "n4"]);
  });

  it("搜索是纯客户端过滤：命中 name/key、大小写不敏感；过滤态 draggable 摘掉；无命中给专属空文案；清空复原", async () => {
    renderWith();
    const search = screen.getByTestId("list-search") as HTMLInputElement;
    // 未过滤态：行可拖
    expect(row("n1").getAttribute("draggable")).toBe("true");

    fireEvent.change(search, { target: { value: "等待" } }); // name 命中
    expect(rowKeys()).toEqual(["n1.2"]);

    fireEvent.change(search, { target: { value: "N2" } }); // key 命中，大小写不敏感
    expect(rowKeys()).toEqual(["n2", "n2.1"]);

    // 过滤态下行序不代表真实顺序 → draggable 必须摘掉（源码注释的口径）。
    // 钉渲染现状：draggable={false} 走 React 的 enumerated 属性序列化，落在 DOM 上是
    // draggable="false" 而不是摘掉属性——语义同样不可拖，别按「属性消失」断言。
    expect(row("n2").getAttribute("draggable")).toBe("false");

    fireEvent.change(search, { target: { value: "查无此项" } });
    expect(document.querySelectorAll('[data-testid="scene-list-row"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("没有名字或 key 含「查无此项」的步骤");
    // 客户端过滤：全程零网络请求，也没有「加载中」
    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("加载");

    // allowClear 清空 → 全量回来（7 行同屏，不能用 getBy* 单数查）
    const clearBtn = document.querySelector(".ant-input-clear-icon") as HTMLElement;
    fireEvent.mouseDown(clearBtn);
    fireEvent.click(clearBtn);
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(rowKeys()).toHaveLength(7));
    expect(rowKeys()).toEqual(["n1", "n1.1", "n1.2", "n2", "n2.1", "n3", "n4"]);
  });

  it("空文案诚实（折叠态）：命中步藏在折叠里 → 说「折叠中的 N 个步骤未参与搜索」，不是全称否定", () => {
    // n1 折叠 → n1.1「创建订单」根本不在可见行集里；此前空态flatly说「没有」是假话。
    renderWith({ collapsed: ["n1"] });
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "创建订单" } });
    expect(document.querySelectorAll('[data-testid="scene-list-row"]')).toHaveLength(0);
    // 逐步数出未参与搜索的折叠后代：7 全量 − 5 可见 = 2（钉死 N 的算术，改错就死）
    expect(document.body.textContent)
      .toContain("没有名字或 key 含「创建订单」的步骤（折叠中的 2 个步骤未参与搜索，展开后再试）");
    // 诚实修法≠偷偷全展开：树必须还停在折叠态
    expect(rowKeys()).toEqual([]);
    expect(useSceneStore.getState().collapsed).toEqual(["n1"]);
  });

  it("空文案诚实（全展开）：什么都没折叠且真无命中 → 全称否定，不带「未参与搜索」尾巴", () => {
    renderWith(); // collapsed: []
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "查无此项" } });
    expect(document.querySelectorAll('[data-testid="scene-list-row"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("没有名字或 key 含「查无此项」的步骤");
    // 尾巴只在有折叠时出现：全展开态挂上它就是把「搜过全树」说成「没搜全」（反向假话）
    expect(document.body.textContent).not.toContain("未参与搜索");
  });

  it("页脚文案跟 draggable 同态：搜索过滤态承认「不可拖拽排序」， normal 态才说拖把手=排序", () => {
    renderWith();
    expect(document.body.textContent).toContain("拖把手=排序，拖到容器行=嵌套");
    expect(document.body.textContent).not.toContain("不可拖拽排序");
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "等待" } });
    // draggable 摘掉（行 190 口径）的同一渲染帧里，页脚不许再无条件承诺能拖
    expect(row("n1.2").getAttribute("draggable")).toBe("false");
    expect(document.body.textContent)
      .toContain("搜索过滤态中不可拖拽排序；清空搜索即恢复。与画布同一份图，随时切换。");
    expect(document.body.textContent).not.toContain("拖把手=排序");
  });

  it("点行=选中且 data-selected 单点跟随；[···] 钮本身不改变选中", () => {
    renderWith();
    expect(row("n1").getAttribute("data-selected")).toBe("false");
    // select 被换掉了 → selectedKey 不会自己动，渲染也就永远停在未选中。这里让桩复现真实
    // store 的 select（store.ts:450 `set({ selectedKey: key })`），才断言得了「徽标跟随选中」。
    act.select.mockImplementation((key: string | null) => {
      useSceneStore.setState({ selectedKey: key } as never);
    });
    fireEvent.click(row("n1.2"));
    expect(act.select).toHaveBeenCalledWith("n1.2");
    expect(row("n1.2").getAttribute("data-selected")).toBe("true");
    expect(document.querySelectorAll("[data-selected='true']")).toHaveLength(1);
    // 菜单钮 stopPropagation：展开菜单不该把选中抢过去
    fireEvent.click(screen.getAllByTestId("list-menu")[1]);
    expect(act.select).toHaveBeenCalledTimes(1);
    expect(row("n1.2").getAttribute("data-selected")).toBe("true");
  });

  it("勾选框=disable 位：勾选态=!disable，切换只发 toggleDisableKey(key) 且不带动选中", () => {
    renderWith();
    const leaf = (key: string) => (screen.getByTestId("list-enable-" + key) as HTMLElement).closest("label")!;
    expect(leaf("n3").querySelector("input")!.checked).toBe(false); // disable:true → 未勾
    expect(leaf("n1").querySelector("input")!.checked).toBe(true);
    fireEvent.click(screen.getByTestId("list-enable-n3"));
    expect(act.toggleDisableKey).toHaveBeenCalledWith("n3");
    expect(act.select).not.toHaveBeenCalled();
  });

  it("行菜单：复制/就地副本/禁用切换/删除各自携带本行 key", async () => {
    // 先验 [···] 里「禁用」的文案跟随 disable 位（n3 disable:true → 应画「启用」）。
    renderWith();
    openMenu("n3");
    await waitFor(() => expect(visibleSpan("list-disable")).not.toBeNull(), { timeout: 4000 });
    expect(visibleSpan("list-disable")!.textContent).toBe("启用");

    // 动作段单独一次渲染：Dropdown 浮层 portal 进 body 且点完一项就收掉，开过的浮层还会留在
    // DOM 里让 testid 撞车（每行一个 Dropdown 实例）→ 每次点项前重新开本行菜单，只认非
    // -hidden 的那份（StepListEditor.test.tsx openRowMenu 同款节奏）。
    cleanup();
    renderWith();
    openMenu("n1.1"); // 此前用裸下标 [1]/[2] 数钮，行序一变就摸到别的行——按行 key 定位
    await clickItem("list-copy");
    expect(act.copyNode).toHaveBeenCalledWith("n1.1");
    openMenu("n1.1");
    await clickItem("list-duplicate");
    expect(act.duplicateKey).toHaveBeenCalledWith("n1.1");
    openMenu("n1.1");
    await clickItem("list-disable");
    expect(act.toggleDisableKey).toHaveBeenCalledWith("n1.1");
    openMenu("n1.1");
    await clickItem("list-delete");
    expect(act.removeKey).toHaveBeenCalledWith("n1.1");
    expect(act.removeKey).toHaveBeenCalledTimes(1);
  });

  it("「加一步到后…」子菜单：addStep(kind, 本行 key)——目标行错了就是插错位置", async () => {
    renderWith();
    openMenu("n2.1");
    // rc-menu 子菜单是独立 portal，mouseenter 要 pointerover+mouseover 衍生才触发
    // （StepListEditor.test.tsx hoverInsertSubmenuClick 同款三件套），delay ~0.1s 给足。
    await waitFor(() => expect(visibleMenuEl("list-add-after-n2.1")).not.toBeNull(), { timeout: 4000 });
    hoverOpen(visibleMenuEl("list-add-after-n2.1")!);
    await clickItem("list-ins-n2.1-sleep");
    expect(act.addStep).toHaveBeenCalledTimes(1);
    expect(act.addStep).toHaveBeenCalledWith("sleep", "n2.1");
  });

  it("重命名（去右面板）：只发 select(本行 key)", async () => {
    renderWith();
    fireEvent.click(row("n4").querySelector('[data-testid="list-menu"]')!);
    await clickItem("list-rename");
    expect(act.select).toHaveBeenCalledWith("n4");
    expect(useSceneStore.getState().selectedKey).toBe(null); // 动作被 spy 换掉，真实 select 没跑
  });

  it("工具栏 [+ 添加步骤]：addStep(kind, null) 挂顶层；粘贴钮只在有剪贴板时出现且只发 pasteInto(null)", async () => {
    renderWith();
    expect(screen.queryByTestId("list-paste")).toBeNull();
    // 工具栏这个 Dropdown 没写 trigger → antd 默认 hover：click 打不开（行菜单才是 click）。
    hoverOpen(screen.getByTestId("list-add-step"));
    await clickItem("list-addmenu-foreach");
    expect(act.addStep).toHaveBeenCalledWith("foreach", null);

    cleanup();
    renderWith({ clipboard: { key: "cp", kind: "sleep", config: { ms: 1 } } });
    const paste = screen.getByTestId("list-paste");
    expect(paste.textContent).toContain("粘贴");
    fireEvent.click(paste);
    expect(act.pasteInto).toHaveBeenCalledWith(null);
  });

  it("拖放回自身行 = 纯 no-op：四个移动动作与告警都不许发", () => {
    renderWith();
    fireEvent.drop(row("n3"), { dataTransfer: fakeDt({ [DND_NODE]: "n3" }) });
    expect(act.moveInto).not.toHaveBeenCalled();
    expect(act.moveNodeTo).not.toHaveBeenCalled();
    expect(act.dropOn).not.toHaveBeenCalled();
    expect(act.removeKey).not.toHaveBeenCalled();
  });

  it("拖放分叉：容器行→moveInto(被拖,目标)；普通行→moveNodeTo(被拖,parent,落点)；失败给告警", () => {
    // n1 补第三子：下面要单独钉「向下落同层」的传参现状（见 FINDINGS 注释）。
    renderWith({ nodes: tree().map((n) => n.key === "n1"
      ? { ...n, children: [...n.children!, { key: "n1.3", kind: "sleep", name: "第三子", config: { ms: 2 } }] }
      : n) });
    // n3 拖到容器 n1 上 = 移入
    fireEvent.drop(row("n1"), { dataTransfer: fakeDt({ [DND_NODE]: "n3" }) });
    expect(act.moveInto).toHaveBeenCalledWith("n3", "n1");
    // n1.2 拖到同层 n1.1 后 = 插到它后面：parent=n1、index=1（n1.1 的 idx0+1）
    fireEvent.drop(row("n1.1"), { dataTransfer: fakeDt({ [DND_NODE]: "n1.2" }) });
    expect(act.moveNodeTo).toHaveBeenCalledWith("n1.2", "n1", 1);
    // 向下落同层（n1.1 落到 n1.2 后面）：被拖节点在目标**前面**，而 moveNode 是先删后插，
    // 删掉 n1.1 会把 n1.2 往前挪一格 ⇒ 这里必须传 idx（不是 idx+1），
    // 否则 [n1.1,n1.2,n1.3] 会变成 [n1.2,n1.3,n1.1]——落点越过目标一格（D115）。
    fireEvent.drop(row("n1.2"), { dataTransfer: fakeDt({ [DND_NODE]: "n1.1" }) });
    expect(act.moveNodeTo).toHaveBeenCalledWith("n1.1", "n1", 1);
    // n2.1 拖到顶层普通行 n3 后：parent=null、index=3（n3 是顶层 idx2，+1=3；被拖不在顶层
    // 列表里、删除不挪位 → 落点恰在 n3 后）。要出 moveNodeTo(…, null, ·) 必须落普通行：
    // n2 是 loop=容器，落它只能走 moveInto（下一行就钉这个分叉）。
    fireEvent.drop(row("n3"), { dataTransfer: fakeDt({ [DND_NODE]: "n2.1" }) });
    expect(act.moveNodeTo).toHaveBeenCalledWith("n2.1", null, 3);
    // 目标行是容器就一律 moveInto ——哪怕被拖的正是它的亲儿子
    fireEvent.drop(row("n2"), { dataTransfer: fakeDt({ [DND_NODE]: "n2.1" }) });
    expect(act.moveInto).toHaveBeenCalledWith("n2.1", "n2");
    expect(act.moveInto).toHaveBeenCalledTimes(2);
    expect(act.moveNodeTo).toHaveBeenCalledTimes(3); // 普通行绝不走 moveInto，反之亦然
    // 被拒的移动要说出来（store 返回 false → message.warning）
    const warn = vi.spyOn(message, "warning");
    act.moveInto.mockReturnValue(false);
    act.moveNodeTo.mockReturnValue(false);
    fireEvent.drop(row("n1"), { dataTransfer: fakeDt({ [DND_NODE]: "n3" }) });
    fireEvent.drop(row("n3"), { dataTransfer: fakeDt({ [DND_NODE]: "n2.1" }) });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("kind 载荷拖放（从资产树拖入）：dropOn 带 ref/name；空串转 undefined；目标=落点行", () => {
    renderWith();
    fireEvent.drop(row("n2"), {
      dataTransfer: fakeDt({ [DND_KIND]: "api_case", [DND_REF]: "c9", [DND_NAME]: "拖来的用例" }),
    });
    expect(act.dropOn).toHaveBeenCalledWith(
      { kind: "api_case", ref: "c9", name: "拖来的用例" }, "n2");
    fireEvent.drop(row("n3"), { dataTransfer: fakeDt({ [DND_KIND]: "sleep" }) });
    expect(act.dropOn).toHaveBeenLastCalledWith({ kind: "sleep", ref: undefined, name: undefined }, "n3");
    expect(act.moveInto).not.toHaveBeenCalled();
    expect(act.moveNodeTo).not.toHaveBeenCalled();
  });

  it("空树=「切回画布拖进来」的空态且工具栏仍在；整棵树不触发任何网络请求", () => {
    renderWith({
      nodes: [],
      serverIssues: [{ node_key: "ghost", code: "srv", message: "来自服务器的问题", path: "$" } as Issue],
    });
    expect(screen.getByTestId("scene-list-mode").textContent)
      .toContain("还没有步骤。切回画布，从左侧把用例或逻辑控件拖进来。");
    expect(screen.getByTestId("list-search")).toBeTruthy();
    expect(document.querySelectorAll('[data-testid="scene-list-row"]')).toHaveLength(0);
    // 有 serverIssues 也不许把「空」演成「加载失败」或偷偷拉数据
    expect(document.body.textContent).not.toContain("失败");
    expect(global.fetch).not.toHaveBeenCalled();

    // 有数据的常态同样零请求（数据从 store 来，列表模式不自己取数）
    cleanup();
    renderWith();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // D146：只读关写把手——添加/粘贴/行菜单隐藏（§11.5.1），勾选禁用、拖把手摘掉、
  // drop 早退（外部载荷也不收）。正对照防「对谁都只读」。
  it("D146 只读：添加/粘贴/行菜单不在 DOM、勾选 disabled、draggable=false、drop 不动 store；空树工具栏同闸", () => {
    renderWith({ readOnly: true, clipboard: tree()[0] });
    expect(screen.queryByTestId("list-add-step")).toBeNull();
    expect(screen.queryByTestId("list-paste")).toBeNull(); // 剪贴板有货也不给粘贴
    expect(screen.queryAllByTestId("list-menu")).toHaveLength(0);
    expect((screen.getByTestId("list-enable-n1") as HTMLInputElement).disabled).toBe(true);
    expect(row("n1").getAttribute("draggable")).toBe("false");
    fireEvent.drop(row("n2"), { dataTransfer: fakeDt({ [DND_NODE]: "n3" }) });
    expect(act.moveInto).not.toHaveBeenCalled();
    expect(act.moveNodeTo).not.toHaveBeenCalled();
    fireEvent.drop(row("n1"), { dataTransfer: fakeDt({ [DND_KIND]: "sleep" }) });
    expect(act.dropOn).not.toHaveBeenCalled();
    expect(screen.getByTestId("scene-list-mode").textContent).toContain("只读模式");
    cleanup(); renderWith({ readOnly: true, nodes: [] }); // 空树分支的工具栏同一道闸
    expect(screen.queryByTestId("list-add-step")).toBeNull();
    // 正对照：可写态全在场、勾选可用、拖把手在
    cleanup(); renderWith({ clipboard: tree()[0] });
    expect(screen.getByTestId("list-add-step")).toBeTruthy();
    expect(screen.getByTestId("list-paste")).toBeTruthy();
    expect(screen.getAllByTestId("list-menu").length).toBeGreaterThan(0);
    expect((screen.getByTestId("list-enable-n1") as HTMLInputElement).disabled).toBe(false);
    expect(row("n1").getAttribute("draggable")).toBe("true");
  });
});
