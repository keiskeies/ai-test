// AssetTree（场景左资产树，§11.4.9）的组件侧单测。此前 vitest 侧零 import（audit-test-debt.mjs
// 命中；e2e/sceneCanvas.spec.mjs 只摸到 asset-case/logic-add-sleep 可点的边角）。钉的是
// Canvas/store 赖以协作的契约：① 三类用例点击各发 addStep(kind, selectedKey, {ref,name})——
// kind/ref 传错，插进画布的就是错节点，对其它任何测试不可见；② 拖拽载荷三键（DND_KIND/REF/NAME）
// + effectAllowed=copy 逐类正确（ListMode.test.tsx 钉了 Canvas 消费端，这里是生产端）；
// ③ 逻辑控件 12 钮：点击只发 addStep(kind, selectedKey)（不带 patch），拖拽只挂 DND_KIND；
// ④ 一个搜索框同时过滤三张清单、大小写不敏感、纯客户端零请求；空清单给专属空文案。
// 手法照抄 ListMode.test.tsx：matchMedia 垫片 + motion:false + setState 灌数 + 存/还原动作。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import AssetTree from "./AssetTree";
import { DND_KIND, DND_NAME, DND_REF } from "./Canvas";
import { useSceneStore } from "./store";
import type { CaseRow } from "../api/api";

const addStep = vi.fn();
/** 存/还原被换掉的真实动作（ListMode.test.tsx installSpies/restoreSpies 同款）。 */
let savedAddStep: unknown = null;
function installSpy(): void {
  if (savedAddStep === null) savedAddStep = useSceneStore.getState().addStep;
  useSceneStore.setState({ addStep } as never);
}
function restoreSpy(): void {
  if (savedAddStep === null) return;
  useSceneStore.setState({ addStep: savedAddStep } as never);
  savedAddStep = null;
}

function caseRow(over: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "c1", project_id: "p1", definition_id: "d1", name: "已支付订单", priority: "P0",
    request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
    effective_request: null, ...over,
  };
}
/** UI/ADB 用例只用到 id/name/priority 三键，其余按 store 声明的生成物类型整体转接。 */
const uiCase = (id: string, name: string, priority = "P1") =>
  ({ id, project_id: "p1", name, priority, status: "normal" }) as never;
const adbCase = (id: string, name: string, priority = "P2") =>
  ({ id, project_id: "p1", name, priority, status: "normal" }) as never;

function seed(over: Record<string, unknown> = {}): void {
  useSceneStore.setState({
    loading: false, projectId: "p1", scenarioId: "s1",
    selectedKey: null, readOnly: false,
    cases: [caseRow(), caseRow({ id: "c2", name: "MyOrder 下单", priority: "P1" })],
    uiCases: [uiCase("u1", "冒烟UI")],
    adbCases: [adbCase("k1", "ADB冒烟")],
    assetsFailed: { cases: null, uiCases: null, adbCases: null, envs: null },
    // 默认「取全了」：游标三真事的腿各自 over 覆盖（store 是模块单例，不重置会串腿）
    assetsHasMore: { cases: false, uiCases: false, adbCases: false, envs: false },
    ...over,
  } as never);
}

function renderTree(over: Record<string, unknown> = {}): void {
  seed(over);
  render(<ConfigProvider theme={{ token: { motion: false } }}><AssetTree /></ConfigProvider>);
}

function rows(testid: string): HTMLElement[] {
  return screen.queryAllByTestId(testid);
}
/** 记录 setData 的 DataTransfer（jsdom 无实现；ListMode.test.tsx fakeDt 同款形状）。 */
function recorder(): DataTransfer & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    types: [] as string[],
    getData: (t: string) => data[t] ?? "",
    setData: (t: string, v: string) => { data[t] = v; },
    effectAllowed: "",
  } as unknown as DataTransfer & { data: Record<string, string> };
}

beforeEach(() => {
  addStep.mockReset();
  installSpy();
  // 树零直接请求：这个桩只记录不该发生的请求（过滤是纯客户端的）。
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); restoreSpy(); vi.restoreAllMocks(); });

describe("AssetTree（左资产树，§11.4.9）", () => {
  it("三张清单各自成行：testid 区分 API/UI/ADB，名字+优先级同屏；整棵树零请求", () => {
    renderTree();
    expect(rows("asset-case").map((n) => n.textContent)).toEqual([
      "已支付订单 P0", "MyOrder 下单 P1",
    ]);
    expect(rows("asset-ui-case").map((n) => n.textContent)).toEqual(["冒烟UI P1"]);
    expect(rows("asset-adb-case").map((n) => n.textContent)).toEqual(["ADB冒烟 P2"]);
    expect(screen.getByTestId("scene-asset-tree")).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("空清单：三组各给「项目里还没有「××」」诚实空文案（不是失败、不偷偷拉数据）", () => {
    renderTree({ cases: [], uiCases: [], adbCases: [] });
    const t = screen.getByTestId("scene-asset-tree").textContent!;
    expect(t).toContain("项目里还没有「接口用例」");
    expect(t).toContain("项目里还没有「UI 用例」");
    expect(t).toContain("项目里还没有「ADB 用例」");
    expect(rows("asset-case")).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("一个搜索框同时过滤三类：大小写不敏感；过滤至空说「有但这个词没命中」；清空复原；全程零请求", () => {
    renderTree();
    const search = screen.getByTestId("asset-search");
    fireEvent.change(search, { target: { value: "order" } }); // 小写命中 MyOrder
    expect(rows("asset-case").map((n) => n.textContent)).toEqual(["MyOrder 下单 P1"]);
    expect(rows("asset-ui-case")).toHaveLength(0);
    expect(rows("asset-adb-case")).toHaveLength(0);
    fireEvent.change(search, { target: { value: "ORDER" } }); // 大写同样命中
    expect(rows("asset-case")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "查无此项" } });
    const t = screen.getByTestId("scene-asset-tree").textContent!;
    // 用例就在清单里，只是这个词搜不到。说「项目里还没有」= 让人以为要去新建一条。
    expect(t).toContain("「接口用例」里没有名字含「查无此项」的（项目里有 2 条，换个词）");
    expect(t).toContain("「UI 用例」里没有名字含「查无此项」的（项目里有 1 条，换个词）");
    expect(t).not.toContain("项目里还没有「接口用例」");
    fireEvent.change(search, { target: { value: "冒烟" } }); // UI 与 ADB 两组同时命中
    expect(rows("asset-ui-case").map((n) => n.textContent)).toEqual(["冒烟UI P1"]);
    expect(rows("asset-adb-case").map((n) => n.textContent)).toEqual(["ADB冒烟 P2"]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("失败态不并入空态：403 说没权限、其它说没取到，都不说「项目里还没有」", () => {
    renderTree({
      cases: [], uiCases: [], adbCases: [],
      assetsFailed: { cases: "denied", uiCases: "error", adbCases: null, envs: "error" },
    });
    const t = screen.getByTestId("scene-asset-tree").textContent!;
    expect(t).toContain("没有读取「接口用例」清单的权限，这里列不出来");
    expect(t).toContain("「UI 用例」清单没取到，不是项目里没有——重新进入编辑器可再拉一次");
    // 第三份真的取到了且是空数组 —— 这时才允许说「还没有」
    expect(t).toContain("项目里还没有「ADB 用例」");
    expect(t).not.toContain("项目里还没有「接口用例」");
    expect(t).not.toContain("项目里还没有「UI 用例」");
  });

  it("失败态只在空行时露出：清单有货就照常列行，不插失败文案", () => {
    renderTree({ assetsFailed: { cases: "error", uiCases: null, adbCases: null, envs: null } });
    expect(rows("asset-case")).toHaveLength(2);
    expect(screen.getByTestId("scene-asset-tree").textContent).not.toContain("没取到");
  });

  it("游标非空（只取到第一页）→ 不说「项目里有 N 条」：N 只是已取到的，出路仍是换个词", () => {
    // store.load 每份只发一次 size=200：next_cursor 非空 = 后面还有没取进来的。
    // 这时说「项目里有 N 条」= 把第一页冒充普查（「共 N」同族病灶），>200 条的项目当场撒谎。
    renderTree({ assetsHasMore: { cases: true, uiCases: false, adbCases: false, envs: false } });
    fireEvent.change(screen.getByTestId("asset-search"), { target: { value: "查无此项" } });
    const t = screen.getByTestId("scene-asset-tree").textContent!;
    expect(t).not.toContain("项目里有 2 条"); // 普查句式整句不许出现
    expect(t).toContain("「接口用例」已取到的 2 条里没有名字含「查无此项」的");
    expect(t).toContain("后面还有没取进来的"); // 不完备要自己交代
    expect(t).toContain("换个词"); // 可执行指示不许丢
    // 对照：游标为空的另外两份照常走普查句式（信号是按份的，不是一刀切）
    expect(t).toContain("「UI 用例」里没有名字含「查无此项」的（项目里有 1 条，换个词）");
  });

  it("游标为空（真的取全了）→ 才允许说「项目里有 N 条」", () => {
    // 这条是上一条的对照腿：把 more 判据写死成 true 的变异在这侧红。
    renderTree({ assetsHasMore: { cases: false, uiCases: false, adbCases: false, envs: false } });
    fireEvent.change(screen.getByTestId("asset-search"), { target: { value: "查无此项" } });
    const t = screen.getByTestId("scene-asset-tree").textContent!;
    expect(t).toContain("「接口用例」里没有名字含「查无此项」的（项目里有 2 条，换个词）");
    expect(t).not.toContain("后面还有没取进来的");
  });

  it("点击三类行 = addStep(kind, selectedKey, {ref,name})：kind/ref 错一个，插进画布的就是错节点", () => {
    renderTree({ selectedKey: "n7" });
    fireEvent.click(rows("asset-case")[1]);
    expect(addStep).toHaveBeenCalledWith("api_case", "n7", { ref: "c2", name: "MyOrder 下单" });
    fireEvent.click(rows("asset-ui-case")[0]);
    expect(addStep).toHaveBeenCalledWith("ui_case", "n7", { ref: "u1", name: "冒烟UI" });
    fireEvent.click(rows("asset-adb-case")[0]);
    expect(addStep).toHaveBeenCalledWith("adb_case", "n7", { ref: "k1", name: "ADB冒烟" });
    expect(addStep).toHaveBeenCalledTimes(3);
  });

  it("无选中时点击传 targetKey=null（追加顶层），不是 undefined/空串", () => {
    renderTree({ selectedKey: null });
    fireEvent.click(rows("asset-case")[0]);
    expect(addStep).toHaveBeenCalledWith("api_case", null, { ref: "c1", name: "已支付订单" });
  });

  it("三类行的拖拽载荷：DND_KIND 各归各类型 + DND_REF=id + DND_NAME=名字，effectAllowed=copy", () => {
    renderTree();
    const cases: Array<[string, string, string, string]> = [
      ["asset-case", "api_case", "c1", "已支付订单"],
      ["asset-ui-case", "ui_case", "u1", "冒烟UI"],
      ["asset-adb-case", "adb_case", "k1", "ADB冒烟"],
    ];
    for (const [testid, kind, id, name] of cases) {
      const dt = recorder();
      const row = rows(testid)[0];
      expect(row.getAttribute("draggable")).toBe("true");
      fireEvent.dragStart(row, { dataTransfer: dt });
      expect(dt.data[DND_KIND]).toBe(kind);
      expect(dt.data[DND_REF]).toBe(id);
      expect(dt.data[DND_NAME]).toBe(name);
      expect(dt.effectAllowed).toBe("copy");
    }
  });

  it("逻辑控件 12 个：点击只发 addStep(kind, selectedKey)（不带 patch）；拖拽只挂 DND_KIND", () => {
    renderTree({ selectedKey: "n3" });
    const kinds = ["loop", "if", "foreach", "sleep", "script", "extract",
      "assert", "set_var", "group", "break", "continue", "http_direct"];
    for (const k of kinds) {
      const btn = screen.getByTestId("logic-add-" + k);
      expect(btn.textContent).toContain("+"); // 每个都是 [+ 名字] 的加号钮
      fireEvent.click(btn);
    }
    expect(addStep).toHaveBeenCalledTimes(kinds.length);
    expect(addStep).toHaveBeenCalledWith("sleep", "n3");
    expect(addStep).toHaveBeenLastCalledWith("http_direct", "n3");
    // 逻辑控件不带头像载荷：ref/name 缺省（Canvas readDrop 的空串→undefined 口径）
    const dt = recorder();
    fireEvent.dragStart(screen.getByTestId("logic-add-loop"), { dataTransfer: dt });
    expect(dt.data[DND_KIND]).toBe("loop");
    expect(dt.data[DND_REF]).toBeUndefined();
    expect(dt.data[DND_NAME]).toBeUndefined();
  });

  it("逻辑控件点击跟 selectedKey 走：搜索过滤不影响已选目标；清空搜索后点击仍传当时选中", () => {
    renderTree({ selectedKey: "n9" });
    fireEvent.change(screen.getByTestId("asset-search"), { target: { value: "冒烟" } });
    fireEvent.click(screen.getByTestId("logic-add-if"));
    expect(addStep).toHaveBeenCalledWith("if", "n9");
  });

  // D146：只读时清单照列（读资产是正当需求），但「加入画布」的两条路都关；
  // 逻辑控件是纯写把手，整组隐藏（§11.5.1 隐藏派）。正对照防「对谁都只读」镜像假绿。
  it("D146 只读：三类行 draggable=false、点击不发 addStep、逻辑控件整组不在 DOM；搜索仍可用", () => {
    renderTree({ readOnly: true });
    expect(rows("asset-case")).toHaveLength(2); // 读侧不受影响
    for (const t of ["asset-case", "asset-ui-case", "asset-adb-case"])
      for (const r of rows(t)) expect(r.getAttribute("draggable"), t).toBe("false");
    fireEvent.click(rows("asset-case")[0]);
    fireEvent.click(rows("asset-ui-case")[0]);
    fireEvent.click(rows("asset-adb-case")[0]);
    expect(addStep).not.toHaveBeenCalled();
    expect(screen.queryByTestId("logic-add-sleep")).toBeNull();
    expect(screen.getByTestId("scene-asset-tree").textContent).not.toContain("逻辑控件");
    fireEvent.change(screen.getByTestId("asset-search"), { target: { value: "order" } });
    expect(rows("asset-case")).toHaveLength(1); // 搜索是读把手，留着
    // 正对照：可写态拖拽/点击/逻辑控件全在（既有各用例已分别钉过，这里同帧再对照一次）
    cleanup(); renderTree();
    expect(rows("asset-case")[0].getAttribute("draggable")).toBe("true");
    fireEvent.click(rows("asset-case")[0]);
    expect(addStep).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("logic-add-sleep")).toBeTruthy();
  });
});

// D152：「加载更多」入口——仅当 hasMore[slot]（游标非空）渲染，取全了钮消失；
// busy disabled 防双击；只读照常可用（D146 口径：读资产是正当需求，关的是写把手）。
// 追加语义本身在 store.assetsPaging.test.ts；这里只钉组件的门与接线，不重复证明 store。
describe("D152 资产树「加载更多」（游标分页入口）", () => {
  const loadMore = vi.fn();
  let savedLoadMore: unknown = null;
  beforeEach(() => {
    loadMore.mockReset();
    savedLoadMore = useSceneStore.getState().loadMoreAssets;
    useSceneStore.setState({
      loadMoreAssets: loadMore,
      assetsLoadingMore: { cases: false, uiCases: false, adbCases: false, envs: false },
    } as never);
  });
  afterEach(() => { useSceneStore.setState({ loadMoreAssets: savedLoadMore } as never); });

  it("hasMore 按槽控制钮在场：点击各发 loadMoreAssets(slot)；钮文案不承诺「共 N」", () => {
    renderTree({ assetsHasMore: { cases: true, uiCases: false, adbCases: true, envs: false } });
    const c = screen.getByTestId("asset-more-cases");
    expect(c.textContent).toBe("加载更多"); // 后端游标分页没有 total，任何「共 N」都是造假
    expect(screen.queryByTestId("asset-more-ui")).toBeNull(); // 游标空的槽不给钮
    expect(screen.getByTestId("asset-more-adb")).toBeTruthy();
    fireEvent.click(c);
    expect(loadMore).toHaveBeenCalledWith("cases");
    fireEvent.click(screen.getByTestId("asset-more-adb"));
    expect(loadMore).toHaveBeenCalledWith("adbCases");
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it("取全了（hasMore 全 false）→ 三钮全缺席；正对照：同帧翻一槽为 true 钮即出现", () => {
    renderTree();
    for (const t of ["asset-more-cases", "asset-more-ui", "asset-more-adb"])
      expect(screen.queryByTestId(t), t).toBeNull();
    cleanup();
    renderTree({ assetsHasMore: { cases: false, uiCases: true, adbCases: false, envs: false } });
    expect(screen.getByTestId("asset-more-ui")).toBeTruthy();
    expect(screen.queryByTestId("asset-more-cases")).toBeNull(); // 信号按槽，不一刀切
  });

  it("busy 的槽 disabled 且点击不发；别的槽不受牵连；正对照：非 busy 可点", () => {
    renderTree({
      assetsHasMore: { cases: true, uiCases: true, adbCases: false, envs: false },
      assetsLoadingMore: { cases: true, uiCases: false, adbCases: false, envs: false },
    });
    const b = screen.getByTestId("asset-more-cases") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    fireEvent.click(b);
    expect(loadMore).not.toHaveBeenCalled();
    const u = screen.getByTestId("asset-more-ui") as HTMLButtonElement;
    expect(u.disabled).toBe(false);
    fireEvent.click(u);
    expect(loadMore).toHaveBeenCalledWith("uiCases");
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("D146 只读：三钮照常在场可点（读资产正当）；写把手（逻辑控件/加入画布）仍关", () => {
    renderTree({ readOnly: true, assetsHasMore: { cases: true, uiCases: true, adbCases: true, envs: false } });
    const legs: Array<[string, string]> = [
      ["asset-more-cases", "cases"], ["asset-more-ui", "uiCases"], ["asset-more-adb", "adbCases"],
    ];
    for (const [t, slot] of legs) {
      const b = screen.getByTestId(t) as HTMLButtonElement;
      expect(b.disabled, t).toBe(false);
      fireEvent.click(b);
      expect(loadMore).toHaveBeenCalledWith(slot);
    }
    expect(loadMore).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("logic-add-sleep")).toBeNull(); // 写把手的门一道没松
    fireEvent.click(rows("asset-case")[0]);
    expect(addStep).not.toHaveBeenCalled();
  });
});
