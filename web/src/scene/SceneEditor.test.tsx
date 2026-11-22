// SceneEditor（§11.4.9 外壳，14 testid）组件侧单测——此前 vitest 零 import（audit-test-debt
// 命中）。主题=顶栏自己的门与接线：Canvas/AssetTree/PropsPanel/IssuePanel/ListMode/
// DebugDrawer/ConflictModal 全换 marker 桩（各有同名 .test.tsx，子组件行为一条不证明不重
// 复）。路由=【(A) 真 data router】createMemoryRouter：leave-go→proceed / leave-stay→reset
// 在真路由上全程可观测，(B) 假 hook 备选没启用——假 hook 反会把「和 react-router 状态机
// 接错线」测没。【钉】①loading 门 ②dirty 点亮→熄灭（卡亮=卡灭一样糟）③primary 只跟活动
// 模式且桩互换 ④环境（源 envs、空占位「还没有环境」、清除必落 null——undefined 会漏进调
// 试请求体 env_id）⑤undo/redo disabled 跟栈迁移 ⑥执行钮 disabled 门+脏/净 title 逐字（诚
// 实就写在这行字上）⑦取消钮只在 running、乐观「取消中…」先于请求返回、载荷带 project_id、
// 失败腿 Error.message/非 Error 兜底、无 runId 点空 ⑧Ctrl+S/Z/⇧Z/Y+裸 z 不理+isTypingTarget
// 五类逐类否决 ⑨离开拦截三态 ⑩back→/scene ⑪save/startRun 只钉被调。【不证明】beforeunload
// （jsdom 无可观测效果）、Tooltip 气泡、被桩子替换的一切。FINDING（未修，按现状记录）：快
// 捷键听 keydown 不看钮 disabled——空栈 Ctrl+Z 照样进 doUndo，靠 store no-op 兜底，钮门与
// 键门不是一道。垫片收本文件：matchMedia；Request 桩（react-router 导航 new Request(url,
// {signal}) 落 undici 的 AbortSignal instanceof 校验炸导航、只漏 unhandled rejection；路由
// 表零 loader 无消费者）。真 store 保持真实，save/doUndo/doRedo/load 换 spy 存/还原（同
// AssetTree 口径）；cancelRun/startRun 在 API/模块边界换壳。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import SceneEditorPage from "./SceneEditor";
import { useAuth } from "../auth/store";
import { createUndoStack } from "./graphOps";
import { selectDirty, useSceneStore } from "./store";
import { ApiErr } from "../api/client";
import type { StepNode } from "./stepTypes";
const mm = (q: string) => ({ matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false });
Object.defineProperty(window, "matchMedia", { writable: true, value: mm });
class ShimRequest { url: string; constructor(url: string) { this.url = url; } }
vi.stubGlobal("Request", ShimRequest);
// vi.mock 工厂被提升：它引用的 helper 必须一起进 hoisted 作用域。
const h = vi.hoisted(() => ({ apiCancelRun: vi.fn(), startRunSpy: vi.fn() }));
const stub = vi.hoisted(() => (t: string) => ({ __esModule: true, default: () => <div data-testid={t} /> }));
vi.mock("./Canvas", () => stub("stub-canvas")); vi.mock("./AssetTree", () => stub("stub-asset-tree"));
vi.mock("./PropsPanel", () => stub("stub-props")); vi.mock("./IssuePanel", () => stub("stub-issue"));
vi.mock("./ListMode", () => stub("stub-list")); vi.mock("./ConflictModal", () => stub("stub-conflict"));
vi.mock("./DebugDrawer", () => ({ __esModule: true, default: () => <div data-testid="stub-drawer" />,
  startRun: (...a: unknown[]) => h.startRunSpy(...a) })); // 模块级函数，只能模块边界换 spy
vi.mock("../api/scene", async (orig) => {
  const mod = await orig<typeof import("../api/scene")>();
  return { ...mod, sceneApi: { ...mod.sceneApi, cancelRun: h.apiCancelRun } };
});
const PROJECT = { id: "p1", name: "履约", description: null, status: "normal", my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const SCEN = { id: "s1", project_id: "p1", name: "下单链路", version: 3 } as never;
const N1: StepNode[] = [{ key: "a", kind: "sleep", name: "等待A", config: {} }]; const N2: StepNode[] = [{ key: "b", kind: "sleep", name: "等待B", config: {} }];
const j = (v: unknown) => JSON.stringify(v ?? null); // 与 store 的 dirty 基线序列化同口径
const run = (o: Record<string, unknown> = {}) => ({ open: false, trigger: null, runId: null, phase: "idle",
  errorText: null, finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false, ...o } as never);
/** 灌 store：baseline==nodes 起步（不脏）；其余草稿字段用 store 初始态（本来自对齐）。 */
function seed(over: Record<string, unknown> = {}): void {
  useSceneStore.setState({ loading: false, scenario: SCEN, projectId: "p1", scenarioId: "s1", mode: "canvas",
    nodes: N1, baselineNodes: j(N1), layout: {}, envId: null, envs: [], baselineEnvId: null,
    // D146：readOnly 也是合并态——只读用例灌的 true 不显式清会串到下一条（同 loadFailure 口径）
    readOnly: false,
    // seed = 「本体取到了」这一态：loadFailure 必须显式清，否则上一条用例灌的失败会顺着
    // 真 store 活到下一条（zustand 的 setState 是合并，不是重置）。
    loadFailure: null,
    undo: createUndoStack({ nodes: N1, layout: {} }), run: run(), ...over });
}
/** dirty 的最小来源：真 apply（压 undo，与画布编辑同一条路）。 */
const makeDirty = () => act(() => { useSceneStore.getState().apply((ns) => [...ns, N2[0]]); });
const setPhase = (p: string) => act(() => { useSceneStore.setState((s) => ({ run: { ...s.run, phase: p } }) as never); });
// antd Modal 不 destroyOnClose：关后 wrap 藏 display:none；没开过时 wrap 压根不存在——两种「没开」都得算关。
const guardOpen = () => { const w = screen.queryByTestId("leave-guard-modal")?.querySelector(".ant-modal-wrap") as HTMLElement | null;
  return !!w && w.style.display !== "none"; };
const saveSpy = vi.fn(); const doUndoSpy = vi.fn(); const doRedoSpy = vi.fn();
const savedActions = {} as Record<string, unknown>;
function renderEditor(): void {  render(<ConfigProvider theme={{ token: { motion: false } }}>
    <RouterProvider router={createMemoryRouter([
      { path: "/scene/:id", element: <>
        <SceneEditorPage />
        {/* isTypingTarget 五类否决探针（快捷键不许劫持真实输入）；kbd-monaco 在 .monaco-editor 里面 */}
        <input data-testid="kbd-input" defaultValue="z" /><textarea data-testid="kbd-textarea" defaultValue="z" />
        <select data-testid="kbd-select"><option value="o">o</option></select>
        <div className="monaco-editor"><span data-testid="kbd-monaco">m</span></div>
        <div data-testid="kbd-ce" contentEditable suppressContentEditableWarning>ce</div>
      </> },
      { path: "/scene", element: <div data-testid="page-scene-list" /> },
    ], { initialEntries: ["/scene/s1"] })} />
  </ConfigProvider>);
}
const mount = async () => { renderEditor(); await screen.findByTestId("page-scene-editor"); };
const mountRun = (o: Record<string, unknown> = {}) => {
  seed({ run: run({ open: true, trigger: "manual", runId: "r1", phase: "running", ...o }) }); renderEditor(); };
beforeEach(() => {
  seed(); useAuth.setState({ project: PROJECT, user: null, ready: true } as never);
  const s = useSceneStore.getState();
  Object.assign(savedActions, { save: s.save, doUndo: s.doUndo, doRedo: s.doRedo, load: s.load });
  // load 换空 async：挂载副作用不许碰网络；save 常驻 spy（⑥⑪只钉被调）。
  useSceneStore.setState({ save: saveSpy, load: vi.fn(async () => undefined) } as never);
  h.apiCancelRun.mockReset().mockResolvedValue({ status: "cancelled" });
  h.startRunSpy.mockReset(); saveSpy.mockReset(); doUndoSpy.mockReset(); doRedoSpy.mockReset();
});
afterEach(() => { cleanup(); useSceneStore.setState(savedActions as never); vi.restoreAllMocks(); });
describe("SceneEditor 顶栏（真 store + 真 data router，子组件全桩）", () => {
  it("①loading 门只给 Spin（同一挂载内翻 loading 即放行）；②dirty 点亮、回基线熄灭", async () => {
    seed({ loading: true, scenario: null }); renderEditor();
    await screen.findByTestId("scene-editor-loading"); expect(screen.queryByTestId("page-scene-editor")).toBeNull();
    act(() => seed()); // 门是 reactive 的：灌好数据（loading=false）同一挂载直接放行
    await screen.findByTestId("page-scene-editor");
    expect(screen.queryByTestId("scene-editor-loading")).toBeNull();
    expect(screen.getByTestId("stub-asset-tree")).toBeTruthy(); // marker 桩就位
    expect(screen.queryByTestId("scene-dirty-dot")).toBeNull(); makeDirty();
    expect(screen.getByTestId("scene-dirty-dot")).toBeTruthy();
    act(() => { useSceneStore.getState().apply((ns) => ns.slice(0, 1)); }); // 回基线=不脏
    expect(screen.queryByTestId("scene-dirty-dot")).toBeNull(); // 卡亮和卡灭一样糟
  });
  it("③primary 只跟活动模式且画布桩换列表桩；⑤undo/redo disabled 跟栈逐拍迁移", async () => {
    await mount();
    const prim = (t: string) => screen.getByTestId(t).className.includes("ant-btn-primary");
    expect([prim("scene-mode-canvas"), prim("scene-mode-list")]).toEqual([true, false]);
    fireEvent.click(screen.getByTestId("scene-mode-list"));
    expect(useSceneStore.getState().mode).toBe("list");
    expect([prim("scene-mode-canvas"), prim("scene-mode-list")]).toEqual([false, true]);
    expect([!!screen.queryByTestId("stub-canvas"), !!screen.queryByTestId("stub-list")]).toEqual([false, true]); // 画布桩整棵换成列表桩
    const u = () => screen.getByTestId("scene-undo") as HTMLButtonElement;
    const r = () => screen.getByTestId("scene-redo") as HTMLButtonElement;
    expect([u().disabled, r().disabled]).toEqual([true, true]); // 空栈双禁用
    makeDirty(); await waitFor(() => expect(u().disabled).toBe(false));
    expect(r().disabled).toBe(true);
    fireEvent.click(u()); // 真 doUndo
    await waitFor(() => expect(useSceneStore.getState().nodes).toEqual(N1));
    expect([u().disabled, r().disabled]).toEqual([true, false]);
    fireEvent.click(r());
    await waitFor(() => expect(useSceneStore.getState().nodes).toEqual([...N1, N2[0]]));
  });
  it("④环境：选项源 envs、空占位「还没有环境」、选择写 envId、清除落 null（非 undefined）", async () => {
    await mount();
    const sel = screen.getByTestId("scene-env");
    const ph = () => sel.querySelector(".ant-select-selection-placeholder")?.textContent;
    expect(ph()).toBe("还没有环境"); // 逐字：空环境说真话，不是「请选择」套话
    act(() => { seed({ envs: [{ id: "e1", name: "日常" }, { id: "e2", name: "预发" }] }); });
    expect(ph()).toBe("环境");
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector") as Element);
    await waitFor(() => expect([...document.querySelectorAll(".ant-select-item-option")]
      .map((el) => el.getAttribute("title"))).toEqual(["日常", "预发"]));
    fireEvent.click(document.querySelector('.ant-select-item-option[title="日常"]') as Element);
    await waitFor(() => expect(useSceneStore.getState().envId).toBe("e1"));
    // `v ?? null` 钉点：antd 清除递 onChange 的是 undefined（清除钮绑 mousedown 防 blur
    // 抢先）。同步断言当场红——waitFor(x).not.toBeUndefined() 对 undefined 是假绿，写不得。
    fireEvent.mouseDown(sel.querySelector(".ant-select-clear") as Element);
    expect(useSceneStore.getState().envId).not.toBeUndefined();
    await waitFor(() => expect(useSceneStore.getState().envId).toBe(null));
  });
  // envPlaceholder 的 denied/error 两支以前零断言：只有「有没有环境」被钉过。摘掉那两行
  // 时占位会退回 count 分支，对着 403 喊「还没有环境」——让人去新建一个本来就存在的环境。
  it("④b环境占位分三种真事：没权限看 / 这次没取到 / 项目真没有（有环境时失败也要说失败）", async () => {
    await mount();
    const sel = screen.getByTestId("scene-env");
    const ph = () => sel.querySelector(".ant-select-selection-placeholder")?.textContent;
    const failWith = (f: string | null) => act(() => {
      useSceneStore.setState({ assetsFailed: { cases: null, uiCases: null, adbCases: null, envs: f } } as never);
    });
    failWith("denied");
    expect(ph()).toBe("无权限看环境");
    failWith("error");
    expect(ph()).toBe("环境没取到"); // 逐字：不并成「还没有环境」
    // 有环境也盖不住失败：清单没取到时「环境」这个中性词会让下拉看起来只是没选
    act(() => { seed({ envs: [{ id: "e1", name: "日常" }] }); });
    expect(ph()).toBe("环境没取到");
    failWith(null);
    expect(ph()).toBe("环境");
  });
  it("⑥执行钮 disabled 只跟 runPhase、脏/净双 title 逐字；⑪save/debug/run 只钉被调", async () => {
    await mount();
    const btn = () => screen.getByTestId("scene-run") as HTMLButtonElement;
    // 「实时」二字摘掉：同一次渲染里 DebugDrawer 会说「进度流断了…期间状态可能不再更新」
    // （DebugDrawer.tsx:149），钮上的 title 不能无条件承诺实时。
    expect([btn().disabled, btn().title]).toEqual([false, "执行已保存的场景（进度见运行抽屉）"]);
    fireEvent.click(screen.getByTestId("scene-save")); expect(saveSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("scene-debug")); expect(h.startRunSpy).toHaveBeenCalledWith("debug");
    fireEvent.click(btn()); expect(h.startRunSpy).toHaveBeenCalledWith("manual");
    expect(h.startRunSpy).toHaveBeenCalledTimes(2); // 保存/跑内部归 store.save、DebugDrawer 自己的测试
    makeDirty();
    await waitFor(() => expect(btn().title).toBe("执行跑已保存的场景：先保存（Ctrl+S）"));
    for (const [p, d] of [["running", true], ["starting", true], ["done", false]] as const) {
      setPhase(p); // 门只跟 phase 走；dirty 只改 title 不 disable
      expect(btn().disabled, p).toBe(d);
    }
  });
  it("⑦取消钮：只在 running、乐观「取消中…」先于请求返回、载荷/失败腿/无 runId 点空", async () => {
    mountRun();
    expect((await screen.findByTestId("scene-cancel-run")).textContent).toBe("取消");
    for (const p of ["idle", "starting", "done"]) {
      setPhase(p); // 别的时候给取消钮是骗人：点了什么也不会发生
      expect(screen.queryByTestId("scene-cancel-run"), p).toBeNull();
    }
    setPhase("running");
    fireEvent.click(screen.getByTestId("scene-cancel-run"));
    // 同步断言（未 await）：旗先立、请求后发——await 之后再测就分不出先后（腿 b）
    const c = screen.getByTestId("scene-cancel-run") as HTMLButtonElement;
    expect([c.textContent, c.disabled]).toEqual(["取消中…", true]);
    expect(h.apiCancelRun).toHaveBeenCalledWith("r1", { project_id: "p1" });
    const errSpy = vi.spyOn(message, "error");
    // 失败腿①：Error 原文逐字进红条（409 already_finished 也要让用户看见）；腿②：非
    // Error 抛没 message 可读，走「取消请求没有送达」专属兜底。
    for (const [th, msg] of [[new Error("409 already_finished"), "409 already_finished"], ["boom", "取消请求没有送达"]] as const) {
      cleanup(); h.apiCancelRun.mockRejectedValueOnce(th); mountRun();
      fireEvent.click(await screen.findByTestId("scene-cancel-run"));
      await waitFor(() => expect(errSpy).toHaveBeenCalledWith(msg));
    }
    cleanup(); mountRun({ runId: null }); h.apiCancelRun.mockReset();
    fireEvent.click(await screen.findByTestId("scene-cancel-run"));
    expect(h.apiCancelRun).not.toHaveBeenCalled(); // 守卫腿：没 runId 连请求都不许发
  });
  it("⑧Ctrl+S/Z/⇧Z/Y 各归其位、裸 z 不理；五类输入环境里 isTypingTarget 全否决", async () => {
    useSceneStore.setState({ doUndo: doUndoSpy, doRedo: doRedoSpy } as never);
    await mount();
    const kd = (o: Record<string, unknown>) => fireEvent.keyDown(window, o);
    kd({ key: "s", ctrlKey: true }); kd({ key: "S", metaKey: true }); // mac 腿+大写不许漏
    expect(saveSpy).toHaveBeenCalledTimes(2);
    kd({ key: "z", ctrlKey: true });
    expect(doUndoSpy).toHaveBeenCalledTimes(1);
    kd({ key: "z", ctrlKey: true, shiftKey: true }); kd({ key: "Z", ctrlKey: true, shiftKey: true });
    kd({ key: "y", ctrlKey: true }); expect(doRedoSpy).toHaveBeenCalledTimes(3);
    kd({ key: "z" }); // 裸 z：打字不是撤销
    expect(doUndoSpy).toHaveBeenCalledTimes(1);
    const keys = [{ key: "s", ctrlKey: true }, { key: "z", ctrlKey: true }, { key: "z", ctrlKey: true, shiftKey: true }, { key: "y", ctrlKey: true }];
    const before = [saveSpy, doUndoSpy, doRedoSpy].map((f) => f.mock.calls.length);
    // kbd-monaco 是 .monaco-editor 的子节点：closest 必须爬得动这一层（腿 c）
    for (const t of ["kbd-input", "kbd-textarea", "kbd-select", "kbd-monaco", "kbd-ce"])
      for (const k of keys) fireEvent.keyDown(screen.getByTestId(t), k);
    expect([saveSpy, doUndoSpy, doRedoSpy].map((f) => f.mock.calls.length)).toEqual(before);
  });
  it("⑨⑩净：back 直落 /scene；脏：back 被拦 → stay 留下 → 再 back 再拦 → go 放行", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("scene-back")); // 不脏不该拦
    await screen.findByTestId("page-scene-list");
    cleanup(); await mount();
    expect(guardOpen()).toBe(false);
    makeDirty();
    fireEvent.click(screen.getByTestId("scene-back"));
    await waitFor(guardOpen);
    expect(screen.getByTestId("leave-guard-modal").textContent).toContain("有未保存的修改");
    fireEvent.click(screen.getByTestId("leave-stay")); // blocker.reset：这次导航作废
    await waitFor(() => expect(guardOpen()).toBe(false));
    expect(useSceneStore.getState().nodes).toEqual([...N1, N2[0]]); // 留下不是偷偷 discard
    fireEvent.click(screen.getByTestId("scene-back")); // stay 不是一劳永逸，还脏还得拦
    await waitFor(guardOpen);
    fireEvent.click(screen.getByTestId("leave-go")); // blocker.proceed
    await waitFor(() => expect(screen.queryByTestId("page-scene-editor")).toBeNull());
    await screen.findByTestId("page-scene-list");
  });

  // D144：本体取不到以前 = 一句一闪而过的 toast + 一个永久转圈（store 的 loading:false
  // 在那条路上到不了）。四态各一条，外加一条走真 load 的整链路。分句口径同 adbCaseDetail。
  const failed403 = new ApiErr("insufficient_permission", "缺少权限：scenario:read", 403,
    { perm: "scenario:read" });
  it("D144·404：画「已被回收」并给返回，Spin 必须消失（永久转圈就是缺陷本身）", async () => {
    seed({ loading: false, scenario: null, loadFailure: { kind: "missing" } }); renderEditor();
    const box = await screen.findByTestId("scene-load-failed");
    expect(box.textContent).toContain("已被回收或从未存在");
    expect(screen.queryByTestId("scene-editor-loading")).toBeNull();
    expect(screen.queryByTestId("page-scene-editor")).toBeNull(); // 失败态不许偷放编辑器
    fireEvent.click(screen.getByTestId("scene-load-back"));
    await screen.findByTestId("page-scene-list");
  });
  it("D144·500：只说「没取到」，不许替用户断定场景没了（把故障演成回收=让人去回收站捞）", async () => {
    seed({ loading: false, scenario: null, loadFailure: { kind: "error" } }); renderEditor();
    const box = await screen.findByTestId("scene-load-failed");
    expect(box.textContent).toContain("与场景本身无关");
    expect(box.textContent).not.toContain("已被回收");
    // 串台用节点判、不用文案判：本页 500 的正文照抄孪生，里面有一句
    // 「也还没到没权限那步」——那是否定句，拿 not.toContain("权限") 抓它会误伤合法文案。
    expect(screen.queryByTestId("perm-empty")).toBeNull(); // 走了 403 的落地页才算串台
  });
  it("D144·403：落权限空页（后端位名原话 + 出路），不说「稍后再试」", async () => {
    seed({ loading: false, scenario: null, loadFailure: { kind: "denied", err: failed403 } }); renderEditor();
    await screen.findByTestId("perm-empty");
    expect(screen.getByTestId("perm-empty-desc").textContent).toContain("scenario:read");
    expect(document.body.textContent).not.toContain("稍后再试"); // 稳定的权限结论不是临时故障
    expect(screen.queryByTestId("scene-load-failed")).toBeNull();
    expect(screen.queryByTestId("scene-editor-loading")).toBeNull();
    fireEvent.click(screen.getByTestId("scene-load-back"));
    await screen.findByTestId("page-scene-list"); // 缺权限也要有出口
  });
  it("D144·[重试] 再发一次：重试钮不复用挂载那次，点了必须有第二次 load", async () => {
    const loadSpy = vi.fn(async () => undefined);
    seed({ loading: false, scenario: null, loadFailure: { kind: "error" } });
    useSceneStore.setState({ load: loadSpy } as never);
    renderEditor();
    await screen.findByTestId("scene-load-failed");
    // 挂载副作用本身就会 load 一次，所以门是「次数 +1」：
    // 只断言 toHaveBeenCalledWith("p1","s1") 会被挂载那一次满足，重试钮什么都不干也绿
    // （第一版就是这么写的，变异 e3 当场活下来）。
    const atMount = loadSpy.mock.calls.length;
    fireEvent.click(screen.getByTestId("scene-load-retry"));
    await waitFor(() => expect(loadSpy.mock.calls.length).toBe(atMount + 1));
    expect(loadSpy.mock.calls[atMount]).toEqual(["p1", "s1", false]); // 复发的必须是「这一个场景」；第三参=!canUpdate（D146，本夹具 my_perms=["*"]）
  });
  it("D144·整链路（真 load + 真 fetch 404）：本地脏草稿被归零，失败页的返回不被离开拦截扣住", async () => {
    // 这条是唯一走真 store load 的：变异「blankDraft 漏一个 baseline 字段」只有在这里才红
    // ——脏草稿 + 失败页 = 顶栏脏点常亮，于是全页唯一的出口被 useBlocker 弹窗扣死。
    global.fetch = vi.fn(async (input: RequestInfo | URL) => ({
      ok: String(input).includes("/scenarios/") ? false : true,
      status: String(input).includes("/scenarios/") ? 404 : 200,
      json: async () => (String(input).includes("/scenarios/")
        ? { code: "not_found", message: "场景不存在" } : { items: [], next_cursor: null }),
    })) as unknown as typeof fetch;
    makeDirty(); // 挂载前本地确实有未保存草稿
    useSceneStore.setState({ load: savedActions.load } as never);
    renderEditor();
    await screen.findByTestId("scene-load-failed");
    expect(selectDirty(useSceneStore.getState())).toBe(false); // 前置：草稿已随失败作废
    expect(screen.queryByTestId("scene-dirty-dot")).toBeNull();
    fireEvent.click(screen.getByTestId("scene-load-back"));
    await screen.findByTestId("page-scene-list"); // 没有弹窗拦路
  });
  it("D144·正对照：本体取到了就不许出现任何失败块（「一律说没取到」在这里先红）", async () => {
    renderEditor();
    await screen.findByTestId("page-scene-editor");
    expect(screen.queryByTestId("scene-load-failed")).toBeNull();
    expect(screen.queryByTestId("perm-empty")).toBeNull();
  });
});

// D146：perms 维度的只读门——与 ⑥ 的 phase 门是两道独立的门（⑥ 的钉子原样不动：
// 有权限时执行钮 disabled 仍只跟 runPhase 走）。READONLY 持 scenario:read 能进编辑器
// （D47），所以门在编辑器内部：写钮隐藏（§11.5.1 隐藏派，镜像 uiCaseDetail）+ 横幅。
describe("D146 只读编辑器（无 scenario:update）", () => {
  const RO_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };
  const roAuth = () => useAuth.setState({ project: RO_PROJECT, user: null, ready: true } as never);

  it("写钮五件全不在 DOM + 只读横幅在场 + 环境下拉禁用；正对照：有权限全在场、横幅缺席", async () => {
    roAuth(); seed({ readOnly: true }); await mount();
    const banner = screen.getByTestId("scene-readonly-banner");
    expect(banner.textContent).toContain("scenario:update");
    expect(banner.textContent).toContain("只读");
    for (const t of ["scene-save", "scene-debug", "scene-run", "scene-undo", "scene-redo"])
      expect(screen.queryByTestId(t), t).toBeNull(); // 隐藏不是禁用：DOM 里压根没有
    expect(screen.getByTestId("scene-env").className).toContain("ant-select-disabled");
    expect(screen.getByTestId("scene-back")).toBeTruthy(); // 读把手（返回/模式切换）不藏
    // 正对照（防「对谁都只读」的镜像假绿）：同一套断言在可写角色下全部反过来
    cleanup(); useAuth.setState({ project: PROJECT, user: null, ready: true } as never);
    seed(); await mount();
    expect(screen.queryByTestId("scene-readonly-banner")).toBeNull();
    for (const t of ["scene-save", "scene-debug", "scene-run", "scene-undo", "scene-redo"])
      expect(screen.getByTestId(t), t).toBeTruthy();
    expect(screen.getByTestId("scene-env").className).not.toContain("ant-select-disabled");
  });

  it("load 第三参 = !canUpdate：只读角色传 true、可写角色传 false（重试同参复发）", async () => {
    const loadSpy = useSceneStore.getState().load as unknown as ReturnType<typeof vi.fn>;
    roAuth(); seed({ loading: false, scenario: null, loadFailure: { kind: "error" } });
    renderEditor(); await screen.findByTestId("scene-load-failed");
    expect(loadSpy).toHaveBeenLastCalledWith("p1", "s1", true);
    fireEvent.click(screen.getByTestId("scene-load-retry"));
    expect(loadSpy).toHaveBeenLastCalledWith("p1", "s1", true);
    cleanup(); useAuth.setState({ project: PROJECT, user: null, ready: true } as never);
    seed({ loading: false, scenario: null, loadFailure: { kind: "error" } });
    renderEditor(); await screen.findByTestId("scene-load-failed");
    expect(loadSpy).toHaveBeenLastCalledWith("p1", "s1", false);
  });

  it("⌘S/⌘Z/⌘⇧Z/⌘Y 只读全不生效；同一挂载翻回可写立即恢复（门跟 readOnly 走，不是写死）", async () => {
    useSceneStore.setState({ doUndo: doUndoSpy, doRedo: doRedoSpy } as never);
    roAuth(); seed({ readOnly: true }); await mount();
    const kd = (o: Record<string, unknown>) => fireEvent.keyDown(window, o);
    kd({ key: "s", ctrlKey: true }); kd({ key: "z", ctrlKey: true });
    kd({ key: "z", ctrlKey: true, shiftKey: true }); kd({ key: "y", ctrlKey: true });
    expect([saveSpy, doUndoSpy, doRedoSpy].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    act(() => seed()); // 翻回可写：门是 reactive 的，不是「一次只读终身只读」
    kd({ key: "s", ctrlKey: true }); kd({ key: "z", ctrlKey: true }); kd({ key: "y", ctrlKey: true });
    expect([saveSpy, doUndoSpy, doRedoSpy].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

// D147：库里被 fromGraphV1 滤掉的畸形步骤必须可观察——横幅说清数量与「保存已被拦下」。
// 与 D146 只读横幅是两道独立的门（上面 D146 的钉子原样不动）：可并存、互不挤掉。
// seed 是合并态：graphRejected 每条用例显式灌，不靠上一条的残留。
describe("D147 畸形步骤警示横幅（graphRejected）", () => {
  it("rejected 非空 → 横幅在场、文案含数量与「保存已被拦下」；只读横幅不被连带点亮", async () => {
    seed({ graphRejected: [{ kind: "sleep" }, "junk"] }); await mount();
    const banner = screen.getByTestId("scene-graph-rejected");
    expect(banner.textContent).toContain("2 个步骤形状不合规");
    expect(banner.textContent).toContain("未载入画布");
    expect(banner.textContent).toContain("保存已被拦下");
    expect(banner.className).toContain("ant-alert-warning");
    expect(screen.queryByTestId("scene-readonly-banner")).toBeNull(); // 可写角色：只读横幅不许串台
  });
  it("正对照：无 rejected 横幅缺席；同一挂载内落值/清空即亮/即撤（门是 reactive 的）", async () => {
    seed({ graphRejected: [] }); await mount();
    expect(screen.queryByTestId("scene-graph-rejected")).toBeNull();
    act(() => { useSceneStore.setState({ graphRejected: [42] } as never); });
    expect(screen.getByTestId("scene-graph-rejected").textContent).toContain("1 个步骤形状不合规");
    act(() => { useSceneStore.setState({ graphRejected: [] } as never); });
    expect(screen.queryByTestId("scene-graph-rejected")).toBeNull(); // 卡亮和卡灭一样糟
  });
  it("只读 + rejected 双横幅并存：D146 横幅逐字还在，D147 横幅数量照说", async () => {
    seed({ readOnly: true, graphRejected: [null] }); await mount();
    const ro = screen.getByTestId("scene-readonly-banner");
    expect(ro.textContent).toContain("scenario:update"); // D146 成果不许被挤掉
    expect(screen.getByTestId("scene-graph-rejected").textContent).toContain("1 个步骤形状不合规");
  });
});

// D152：环境清单也可能 >200 条——Select 下拉底部（dropdownRender）挂「加载更多」。
// 仅当 assetsHasMore.envs 渲染（游标空 = 取全了，钮消失），busy disabled。
// D146 只读横幅与 D147 graph-rejected 横幅各有专腿在上面，一字未动；这里只钉新入口。
describe("D152 环境下拉「加载更多」（env-more）", () => {
  const moreSpy = vi.fn();
  let savedMore: unknown = null;
  const noMore = { cases: false, uiCases: false, adbCases: false, envs: false };
  const openEnv = () => {
    fireEvent.mouseDown(screen.getByTestId("scene-env").querySelector(".ant-select-selector") as Element);
  };
  beforeEach(() => {
    moreSpy.mockReset();
    savedMore = useSceneStore.getState().loadMoreAssets;
    // seed 是合并态：游标/在途/失败位显式灌，不吃上一条用例的残留
    useSceneStore.setState({
      loadMoreAssets: moreSpy, assetsHasMore: { ...noMore },
      assetsLoadingMore: { ...noMore }, assetsCursor: { cases: null, uiCases: null, adbCases: null, envs: null },
      assetsFailed: { cases: null, uiCases: null, adbCases: null, envs: null }, graphRejected: [],
    } as never);
  });
  afterEach(() => { useSceneStore.setState({ loadMoreAssets: savedMore } as never); });

  it("hasMore.envs=true → 下拉底部有钮、点击发 loadMoreAssets('envs')；=false → 钮缺席（正对照同帧）", async () => {
    seed({ envs: [{ id: "e1", name: "日常" }], assetsHasMore: { ...noMore, envs: true } });
    await mount();
    openEnv();
    const btn = await screen.findByTestId("env-more");
    expect(btn.textContent).toBe("加载更多"); // 不承诺「共 N」：游标分页没有 total
    fireEvent.click(btn);
    expect(moreSpy).toHaveBeenCalledWith("envs");
    expect(moreSpy).toHaveBeenCalledTimes(1);
    // 正对照：取全了（hasMore.envs=false）钮消失，但菜单选项本体照常——防「整个下拉没了」的假绿
    cleanup();
    seed({ envs: [{ id: "e1", name: "日常" }], assetsHasMore: { ...noMore } });
    await mount();
    openEnv();
    await waitFor(() => expect(document.querySelector('.ant-select-item-option[title="日常"]')).toBeTruthy());
    expect(screen.queryByTestId("env-more")).toBeNull();
  });

  it("busy → env-more disabled 且点击不发；正对照：同一挂载内 busy 落 false 即可点", async () => {
    seed({ envs: [{ id: "e1", name: "日常" }], assetsHasMore: { ...noMore, envs: true },
      assetsLoadingMore: { ...noMore, envs: true } });
    await mount();
    openEnv();
    const btn = await screen.findByTestId("env-more") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(moreSpy).not.toHaveBeenCalled();
    act(() => { useSceneStore.setState({ assetsLoadingMore: { ...noMore } } as never); });
    expect((screen.getByTestId("env-more") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("env-more"));
    expect(moreSpy).toHaveBeenCalledWith("envs");
    expect(moreSpy).toHaveBeenCalledTimes(1);
  });
});
