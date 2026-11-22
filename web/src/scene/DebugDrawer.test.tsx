// DebugDrawer（§11.5.6/§11.7.3 底部运行抽屉，T20/T21）组件测试，此前 vitest 侧零 import
// （audit-test-debt.mjs 命中）。钉「渲染层不说谎」：① open=false 零 DOM；默认高 269px=
// round(768×0.35)、上限 461px=round(768×0.6)——jsdom innerHeight 是真值 768，clamp 可断言；
// 指针拖拽手势几何归 e2e。② 头标文案=诚实条款：debug「调试（未保存草稿）」vs manual
// 「执行（已保存场景）」，互换=撒谎（两者跑的不是同一份图）；③ 徽标三分支 + starting/idle
// 无徽标（没终态就没结论）+ 未知 finalStatus 渲染原文（宁可生码，不编友好标签）；④ report-
// link 只在 runId+done，running/error 挂链接=虚假承诺；⑤ debug-stats 全文 + data-stats=
// JSON.stringify(stats)、null 整行缺席、elapsed_ms 只在 done 计（running 摆耗时=假数）；
// ⑥ 步骤行 data-key/data-status、行名回落 key、rowProgress 只在有时渲染、debug-loading 只在
// running 零步骤空转；⑦ pickStep 拼「→ METHOD url」「← JSON(response)」「logs」且换步整体
// 替换，失败清占位提示零日志行（catch 不炸、不演陈旧详情）；⑧ 事件行 seq 补位 3 格、
// key/row_progress/message 后缀独立可缺省，SSE 帧灌进真实 applyRunEvent；⑨ startRun（命名
// 导出，此前全仓零覆盖）：无 scenario 零调用；manual+dirty 且保存被本地预检拒 → error 文案+
// run 零调用（绝不拿草稿演执行）；保存成功 → run 被调；debug 请求体=草稿图+滤空 key 变量+
// env_id/fail_fast；拒绝 → failRun。
// 【层级声明】真实 zustand store（dirty=nodes vs baseline 真实偏离，manual 腿走真 store.save
// 打到被 mock 的 sceneApi.update），selectDirty 不打桩；只 mock ../api/scene、../api/report、
// ../shared/sse 三个模块边界。matchMedia 垫片收在本文件（仓库口径：无共享 setup）。
// 【FINDING（未修，按现状记录）】catch 占位详情的 kind:""/status（DebugDrawer.tsx:81）从未被
// render 读取——可观察证据只有「detail 已置上」（占位提示消失）；本测试钉可观察面。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
// jsdom 没实现 matchMedia（antd 响应式断点要；Canvas.test.tsx 同款垫片）
Object.defineProperty(window, "matchMedia", { writable: true, value: (q: string) => ({
  matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) });

const h = vi.hoisted(() => ({ update: vi.fn(), run: vi.fn(), debug: vi.fn(), get: vi.fn(),
  stepDetail: vi.fn(), openRunStream: vi.fn(), close: vi.fn() }));
vi.mock("../api/scene", () => ({ sceneApi: { get: h.get, update: h.update, run: h.run, debug: h.debug } }));
vi.mock("../api/report", () => ({ reportApi: { stepDetail: h.stepDetail } }));
vi.mock("../shared/sse", () => ({ openRunStream: h.openRunStream }));

import DebugDrawer, { startRun } from "./DebugDrawer";
import { selectDirty, useSceneStore } from "./store";
import type { StepNode } from "./stepTypes";
import { sceneApi } from "../api/scene";
import { ApiErr } from "../api/client";

type ScenarioOut = Awaited<ReturnType<typeof sceneApi.update>>;
const SCEN = { id: "s1", project_id: "p1", name: "场景", status: "normal", priority: "P2",
  step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true, max_runtime_ms: null,
  env_id: null, version: 3, step_count: 0, issues: [] } as unknown as ScenarioOut;
const tree = (): StepNode[] => [ // n1/n2 进步骤名表；树外 key（n9）用来钉「回落原文」
  { key: "n1", kind: "sleep", name: "登录请求", config: { ms: 100 } },
  { key: "n2", kind: "sleep", name: "等待落库", config: { ms: 50 } }];
const j = (v: unknown) => JSON.stringify(v ?? null);
const IDLE = { open: false, trigger: null, runId: null, phase: "idle", errorText: null,
  finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false,
  downStrikes: 0 };
function seed(over: Record<string, unknown> = {}): void {
  const nodes = (over.nodes as StepNode[] | undefined) ?? tree();
  useSceneStore.setState({
    loading: false, scenario: SCEN, projectId: "p1", scenarioId: "s1", nodes,
    baselineNodes: j(nodes), layout: {}, envId: null, baselineEnvId: null,
    variables: {}, baselineVariables: "{}", failFast: true, baselineFailFast: true,
    maxRuntimeMs: null, baselineMaxRuntimeMs: null, commonAssertions: [],
    baselineCommonAssertions: "[]", serverIssues: [], conflict: null, refused: false,
    saving: false, collapsed: [], selectedKey: null, selectedKeys: [], readOnly: false,
    run: IDLE, ...over,
  } as never);
}
/** 重挂一轮（默认：抽屉打开 + running + runId=run-1 的 SSE 订阅态）；over 覆盖 run 字段。 */
function mount(over: Record<string, unknown> = {}): void {
  cleanup();
  seed({ run: { ...IDLE, open: true, trigger: "debug", runId: "run-1", phase: "running", ...over } });
  render(<ConfigProvider wave={{ disabled: true }} theme={{ token: { motion: false } }}>
    <DebugDrawer />
  </ConfigProvider>);
}
function rowOf(key: string): HTMLElement {
  const el = document.querySelector(`[data-testid="debug-step-row"][data-key="${key}"]`);
  if (!el) throw new Error("步骤行没渲染: " + key);
  return el as HTMLElement;
}
const logLines = () => screen.getAllByTestId("debug-log-line").map((el) => el.textContent);
/** 手工可控 promise：详情请求什么时候回由测试说了算，才能造「先点的后回」。 */
function deferred<T = Record<string, unknown>>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => {
    resolve = r;
  });
  return { p, resolve };
}
const badge = () => document.querySelector<HTMLElement>('[data-testid="debug-run-badge"]');
beforeEach(() => {
  for (const f of [h.update, h.run, h.debug, h.get, h.stepDetail, h.close]) f.mockReset();
  h.openRunStream.mockReset().mockImplementation(() => ({ close: h.close }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("DebugDrawer 渲染层（真 store + 真 store 动作）", () => {
  it("抽屉骨架：open=false 零 DOM、高度 269/461px clamp、关闭走真 closeRun、头标文案诚实条款", () => {
    mount({ open: false, runId: null, phase: "idle" });
    expect(screen.queryByTestId("debug-drawer")).toBeNull();
    mount();
    const d = screen.getByTestId("debug-drawer");
    expect([d.style.height, d.style.maxHeight]).toEqual(["269px", "461px"]); // round(768×0.35/0.6)
    fireEvent.click(screen.getByTestId("debug-drawer-close"));
    expect(screen.queryByTestId("debug-drawer")).toBeNull();
    expect(useSceneStore.getState().run.open).toBe(false); // 真实 closeRun，不是本地藏起来
    mount({ trigger: "debug" });
    expect(screen.getByText("调试（未保存草稿）")).toBeTruthy();
    mount({ trigger: "manual" }); // 两句互换＝对用户撒谎：debug 演草稿、manual 演保存行
    expect(screen.getByText("执行（已保存场景）")).toBeTruthy();
    expect(screen.queryByText("调试（未保存草稿）")).toBeNull();
  });
  it("头部元信息：徽标三分支/无徽标/未知态原文 + 报告链接只在 runId+done + stats 全规格", () => {
    const stats = { total: 3, pass: 2, fail: 1, skip: 0, error: 0, cancelled: 0, elapsed_ms: 1234 };
    mount({ phase: "error", runId: null });
    expect([badge()!.textContent, badge()!.dataset.status]).toEqual(["发起失败", "error"]);
    mount({ phase: "done", finalStatus: "passed", stats });
    expect([badge()!.textContent, badge()!.dataset.status]).toEqual(["通过", "passed"]);
    expect(screen.getByTestId("debug-report-link").getAttribute("href")).toBe("#/reports/run-1");
    expect(screen.getByTestId("debug-stats").getAttribute("data-stats")).toBe(JSON.stringify(stats));
    expect(screen.getByTestId("debug-stats").textContent).toBe("共 3 · 过 2 · 败 1 · 跳 0 · 错 0 · 取消 0");
    expect(screen.getByText("1234ms")).toBeTruthy(); // 耗时只在 done 计：running 的耗时不是终态
    // 没报告却挂链接=虚假承诺；running 摆耗时=假数；但进度事实本身照摆
    for (const over of [{ phase: "running" }, { phase: "error" }]) {
      mount({ stats, ...over });
      expect(screen.queryByTestId("debug-report-link"), JSON.stringify(over)).toBeNull();
      expect(screen.queryByText("1234ms"), JSON.stringify(over)).toBeNull();
      expect(screen.getByTestId("debug-stats"), JSON.stringify(over)).toBeTruthy();
    }
    mount({ phase: "running" });
    expect([badge()!.textContent, badge()!.dataset.status]).toEqual(["运行中", "running"]);
    for (const phase of ["starting", "idle"]) { // 没有终态就没有结论，抢先挂徽标就是编结果
      mount({ phase, runId: null }); expect(badge(), phase).toBeNull(); }
    mount({ phase: "done", finalStatus: "mystery_status" });
    expect(badge()!.textContent).toBe("mystery_status"); // 词表查不到渲染原文，不编友好标签
    mount({ phase: "done", finalStatus: "passed", runId: null });
    expect(screen.queryByTestId("debug-report-link")).toBeNull(); // 没 runId 就没有报告可看
    mount({ phase: "done", finalStatus: "passed", stats: null });
    expect(screen.queryByTestId("debug-stats")).toBeNull(); // 没 stats 整行缺席，不演「共 0」
  });
  it("步骤行：data-key/data-status、行名回落 key、rowProgress 只在有时渲染、空转只在零步骤", () => {
    mount({ stepStatus: { n1: { status: "pass" }, n2: { status: "running", rowProgress: "3/10" },
      n9: { status: "skip" } } });
    expect(rowOf("n1").dataset.status).toBe("pass");
    expect(rowOf("n1").textContent).toContain("登录请求"); // 步骤名来自草稿节点树
    expect(rowOf("n1").textContent).not.toContain("3/10"); // rowProgress 没有就不摆
    expect(screen.getByTestId("debug-step-status-n1").textContent).toBe("通过");
    expect(rowOf("n2").textContent).toContain("3/10");
    expect(rowOf("n9").textContent).toContain("n9"); // 树外 key 回落原文，不编名字
    expect(screen.queryByTestId("debug-loading")).toBeNull(); // 有行就不许空转
    mount({ stepStatus: {} });
    expect(screen.getByTestId("debug-loading")).toBeTruthy(); // running 零步骤：转圈而不是空白面板
  });
  it("pickStep：成功拼三类行且换步整体替换；拒绝清占位提示零日志行（不演陈旧详情）", async () => {
    mount({ stepStatus: { n1: { status: "pass" }, n2: { status: "fail" } } });
    h.stepDetail.mockResolvedValue({ step_key: "n1", kind: "api_case", status: "pass",
      detail: { request: { method: "POST", url: "/login" }, response: { code: 200 }, logs: ["耗时 12ms"] } });
    fireEvent.click(rowOf("n1"));
    await waitFor(() => expect(logLines()).toEqual(["→ POST /login", "← {\"code\":200}", "耗时 12ms"]));
    expect(h.stepDetail).toHaveBeenCalledWith({ project_id: "p1", run_id: "run-1", step_key: "n1" });
    // 换步：method 缺省回落 GET、response:null 也如实拼「← null」，旧行不残留（替换不是追加）
    h.stepDetail.mockResolvedValue({ step_key: "n2", kind: "sleep", status: "fail",
      detail: { request: { url: "/x" }, response: null, logs: [] } });
    fireEvent.click(rowOf("n2"));
    await waitFor(() => expect(logLines()).toEqual(["→ GET /x", "← null"]));
    // 拒绝路径：占位提示清掉（= catch 里的 setDetail 真发生了）且零日志行、组件不炸
    h.stepDetail.mockRejectedValue(new Error("404"));
    fireEvent.click(rowOf("n1"));
    await waitFor(() => expect(screen.queryByText("点左边的步骤看请求 / 响应 / 日志。")).toBeNull());
    expect(screen.queryAllByTestId("debug-log-line")).toHaveLength(0);
    // 点了却没取到 ⇒ 面板自己说清这件事，不能回到「点左边的步骤…」那张什么都没发生的脸
    expect(screen.getByTestId("debug-step-detail-failed").textContent).toContain("这一步的详情没取到");
  });
  // 上面那条每点一步都先 await 完再点下一步 = 永远串行，恰好躲过真实点击的形状：
  // 人会连点，两个请求同时在飞、谁先回不确定。这里让**先点的后回**，
  // 钉「右栏显示的一定是最后一次点击的那一步」。撤掉 pickStep 里的 seq 守卫这条必须红。
  it("pickStep 乱序回包：先点 n1（慢）再点 n2（快），迟到的 n1 不许盖掉 n2", async () => {
    const g1 = deferred();
    const g2 = deferred();
    h.stepDetail.mockImplementation((p: { step_key: string }) =>
      (p.step_key === "n1" ? g1.p : g2.p));
    mount({ stepStatus: { n1: { status: "pass" }, n2: { status: "fail" } } });

    fireEvent.click(rowOf("n1")); // 慢：详情扣在 g1 里不放
    fireEvent.click(rowOf("n2")); // 快：立刻回
    await act(async () => {
      g2.resolve({ step_key: "n2", kind: "sleep", status: "fail",
        detail: { request: { url: "/fast" }, response: null, logs: [] } });
    });
    expect(logLines()).toEqual(["→ GET /fast", "← null"]);

    // n1 现在才回——它对应的点击已经不是最新一次，右栏必须原地不动
    await act(async () => {
      g1.resolve({ step_key: "n1", kind: "api_case", status: "pass",
        detail: { request: { method: "POST", url: "/login" }, response: { code: 200 }, logs: [] } });
    });
    expect(logLines(), "迟到的旧点击回应不许覆盖最新一次点击").toEqual(["→ GET /fast", "← null"]);
  });
  // 换轮这条要**同一次挂载内**改 runId：重挂会把 detail 整个丢掉，那条路不经过
  // seq 守卫，写成重挂就是一条永远不会红的假钉（本轮静态审计抓的就是这种洞）。
  it("pickStep 换轮在途：旧 run 的详情迟到后既不覆盖也不点亮失败态", async () => {
    const gate = deferred();
    h.stepDetail.mockReturnValue(gate.p);
    mount({ stepStatus: { n1: { status: "pass" } } });
    fireEvent.click(rowOf("n1")); // 请求在途
    // 同一棵组件树里换新一轮：:72 那个 effect 会清空 detail，但它清不掉已经在飞的请求
    await act(async () => {
      useSceneStore.setState((s) => ({ run: { ...s.run, runId: "run-2" } }));
    });
    await act(async () => {
      gate.resolve({ step_key: "n1", kind: "api_case", status: "pass",
        detail: { request: { method: "GET", url: "/old-run" }, response: null, logs: [] } });
    });
    // 旧 run 的响应混进新树会演「秒回」——抽屉里既没有它的日志、
    // 也没有「这一步的详情没取到」那张失败脸（新一轮什么都没点过）
    expect(screen.queryAllByTestId("debug-log-line")).toHaveLength(0);
    expect(screen.queryByTestId("debug-step-detail-failed")).toBeNull();
    expect(screen.getByText("点左边的步骤看请求 / 响应 / 日志。")).toBeTruthy();
  });
  it("事件行+SSE：seq 补位 3 格、后缀独立可缺省；帧进真实 applyRunEvent；终态/卸载都关流", () => {
    mount({ runId: "run-9", events: [
      { seq: 7, type: "step/running", payload: { key: "n1", row_progress: "2/5", message: "开跑" } },
      { seq: 12, type: "run_start", payload: {} } ] });
    expect(h.openRunStream).toHaveBeenCalledWith("p1", "run-9",
      expect.objectContaining({ onEvent: expect.any(Function) }));
    const lines = screen.getAllByTestId("debug-event-line");
    expect(lines.map((l) => l.getAttribute("data-seq"))).toEqual(["7", "12"]); // 属性原值，补位只是展示
    expect(lines[0].textContent).toBe("[  7] step/running n1 2/5 — 开跑");
    expect(lines[1].textContent).toBe("[ 12] run_start"); // 无 message 不许拖「 — undefined」尾巴
    const handlers = h.openRunStream.mock.calls[0][2] as { onEvent: (ev: unknown) => void };
    act(() => handlers.onEvent({ seq: 1, ts: null, type: "step/running", payload: { key: "n2", row_progress: "2/5" } }));
    expect(rowOf("n2").dataset.status).toBe("running"); // 抽屉与画布共用同一份事实（真 store 投影）
    expect(rowOf("n2").textContent).toContain("2/5");
    act(() => handlers.onEvent({ seq: 2, ts: null, type: "run_end", payload: { status: "passed", stats: { total: 1 } } }));
    expect(screen.getByTestId("debug-report-link")).toBeTruthy(); // run_end→done 的可见收敛
    cleanup();
    expect(h.close).toHaveBeenCalled(); // 终态换流 + 卸载都走同一条 close 保证
  });
  it("进度标签跟断流信号走：onDown 说「进度流断了」，onOpen 续传后回到「SSE 实时进度」", () => {
    // 旧文案在断流期间仍喊「SSE 实时进度」= 假话：shared/sse.ts 把流错误咽掉静默重连，
    // 这段间隙里状态根本不动。可用信号 = openRunStream 的 onDown/onOpen（每次断连/连上必发）。
    mount();
    expect(screen.getByTestId("debug-progress-label").textContent).toBe("SSE 实时进度");
    const handlers = h.openRunStream.mock.calls[0][2] as { onDown: () => void; onOpen: () => void };
    act(() => handlers.onDown());
    const down = screen.getByTestId("debug-progress-label").textContent!;
    expect(down).toContain("进度流断了");
    expect(down).not.toContain("SSE 实时进度"); // 断流期间不许继续喊实时
    act(() => handlers.onOpen());
    expect(screen.getByTestId("debug-progress-label").textContent).toBe("SSE 实时进度");
  });
  it("D150 接线：onDown 同时喂 store.noteStreamDown（真 store 计连续断流），onOpen 不喂", () => {
    // noteStreamDown 的阈值/取数/收敛语义在 store.sseReconcile.test.ts 钉；这里只钉
    // 「回调位真的接上了」——onDown 只 setStreamDown 不计数 = 对账永远不触发（死代码形状）。
    mount();
    const handlers = h.openRunStream.mock.calls[0][2] as { onDown: () => void; onOpen: () => void };
    expect(useSceneStore.getState().run.downStrikes).toBe(0);
    act(() => handlers.onDown());
    expect(useSceneStore.getState().run.downStrikes).toBe(1);
    act(() => handlers.onDown());
    expect(useSceneStore.getState().run.downStrikes).toBe(2);
    act(() => handlers.onOpen()); // 续传只撤「进度流断了」标签，不产生断流计数
    expect(useSceneStore.getState().run.downStrikes).toBe(2);
  });
});
describe("startRun（命名导出，此前全仓零覆盖）", () => {
  it("无 scenario：立即返回，api 零调用，run 状态纹丝不动", async () => {
    seed({ scenario: null });
    await startRun("debug");
    expect(h.debug).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(useSceneStore.getState().run).toMatchObject({ phase: "idle", open: false });
  });
  it("manual+dirty 且保存被本地预检拒：message.error 且 run 零调用（绝不拿草稿演执行）", async () => {
    const spy = vi.spyOn(message, "error");
    seed({ nodes: [{ key: "n1", kind: "nope" } as unknown as StepNode], baselineNodes: "[]" });
    await startRun("manual");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("已保存"));
    expect(h.update).not.toHaveBeenCalled(); // 本地预检就拦下，请求根本没出门
    expect(h.run).not.toHaveBeenCalled();
    expect(useSceneStore.getState().run.phase).toBe("idle"); // 连 beginRun 都没发生
  });
  it("manual+dirty 但保存成功：先保存后执行，dirty 熄灭，run 真被调", async () => {
    seed({ baselineNodes: "[]" }); // nodes vs baseline → dirty（真实 selectDirty 判据）
    h.update.mockResolvedValue(SCEN); h.run.mockResolvedValue({ run_id: "run-9" });
    await startRun("manual");
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(selectDirty(useSceneStore.getState())).toBe(false);
    expect(h.run).toHaveBeenCalledWith("s1", { project_id: "p1", env_id: null });
    expect(h.debug).not.toHaveBeenCalled();
    expect(useSceneStore.getState().run).toMatchObject({ runId: "run-9", phase: "running", trigger: "manual" });
  });
  it("debug：请求体=草稿图+空 key 变量滤掉+env_id+fail_fast，attachRun 开新会话", async () => {
    seed({ variables: { "": "还在敲", tok: "1" }, envId: "e7", failFast: false, baselineFailFast: false });
    h.debug.mockResolvedValue({ run_id: "run-9" });
    await startRun("debug");
    expect(h.debug).toHaveBeenCalledWith("s1", expect.objectContaining({
      project_id: "p1", // 跑的就是未保存草稿本身
      graph: { version: 1, nodes: tree(), layout: {} },
      variables: { tok: "1" }, // 空 key 是编辑中的草稿位，不发给后端
      env_id: "e7", fail_fast: false }));
    expect(useSceneStore.getState().run).toMatchObject({ open: true, trigger: "debug", runId: "run-9", phase: "running" });
  });
  it("manual+dirty 保存没成功的三种因各说一句人话：冲突/被拒/请求本身没成", async () => {
    // 旧实现三种失败一律喊「先处理问题面板再执行」——冲突要的是弹窗裁决、请求 500
    // 时面板本来就没行，那句话把人支使到一个空面板前。
    const spy = vi.spyOn(message, "error");
    seed({ baselineNodes: "[]" });
    h.update.mockRejectedValue(new ApiErr("conflict", "版本冲突", 409));
    h.get.mockResolvedValue({ ...SCEN, step_graph: { version: 9, nodes: [] }, version: 9 });
    await startRun("manual");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("冲突"));
    expect(useSceneStore.getState().conflict).not.toBeNull();
    // 校验拒：refused 位是它的唯一痕迹
    cleanup();
    spy.mockClear();
    seed({ baselineNodes: "[]" });
    h.update.mockRejectedValue(new ApiErr("validation_error", "图不合法", 422, { issues: [] }));
    await startRun("manual");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("校验拒了"));
    // 500：既没冲突也没 refused ⇒ 不许说「先处理问题面板」（那张面板是空的）
    cleanup();
    spy.mockClear();
    seed({ baselineNodes: "[]" });
    h.update.mockRejectedValue(new ApiErr("internal_error", "500 后端炸了", 500));
    await startRun("manual");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("保存请求本身没成功"));
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("问题面板"));
    expect(h.run).not.toHaveBeenCalled();
  });
  it("api 拒绝：failRun 落成 phase=error + errorText 逐字（发起失败必须可见）", async () => {
    h.debug.mockRejectedValue(new Error("503 队列满了"));
    await startRun("debug");
    expect(useSceneStore.getState().run).toMatchObject({ phase: "error", errorText: "503 队列满了" });
  });

  // F3：发起那一格（点击 → attachRun 落地）的再入。顶栏那条「disabled 只跟 runPhase 走」的
  // 口径（SceneEditor.test.tsx ⑥）把 startRun 换成了 spy，所以它永远看不见这一格——门必须装在
  // startRun 自己身上，这里也就只能从 startRun 这一头敲：两次不 await 的调用 = 连点两下。
  it("F3｜manual+脏：保存还在途时再点一次执行 = 只保存一次、只起一个 run", async () => {
    const save = deferred<ScenarioOut>();
    seed({ baselineNodes: "[]" });
    h.update.mockReturnValue(save.p);
    h.run.mockResolvedValue({ run_id: "run-a" });
    const first = startRun("manual");
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(1));
    void startRun("manual"); // 保存那一格里钮还是可点：顶栏 disabled 只认 runPhase
    void startRun("manual");
    await Promise.resolve();
    expect(h.update).toHaveBeenCalledTimes(1); // 旧实现：三次点击 = 多次 PUT
    save.resolve(SCEN);
    await first;
    await waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(useSceneStore.getState().run).toMatchObject({ runId: "run-a", phase: "running" });
  });

  it("F3｜debug 连点：debug 请求在途时第二次不起新 run（否则后到的 attachRun 顶掉前一个，前一个再没人追进度）", async () => {
    const dbg = deferred<{ run_id: string }>();
    h.debug.mockReturnValue(dbg.p);
    const first = startRun("debug");
    await waitFor(() => expect(h.debug).toHaveBeenCalledTimes(1));
    void startRun("debug");
    void startRun("debug"); // 「狂点」而不是只点两下
    dbg.resolve({ run_id: "run-b" });
    await first;
    await waitFor(() => expect(useSceneStore.getState().run.runId).toBe("run-b"));
    expect(h.debug).toHaveBeenCalledTimes(1);
  });

  it("F3 正对照｜上一轮落地后还能再发起：门只挡同一轮的再入，不是把执行钮永久焊死", async () => {
    h.debug.mockResolvedValueOnce({ run_id: "run-1" }).mockResolvedValueOnce({ run_id: "run-2" });
    await startRun("debug");
    expect(useSceneStore.getState().run.runId).toBe("run-1");
    await startRun("debug");
    expect(useSceneStore.getState().run.runId).toBe("run-2");
    expect(h.debug).toHaveBeenCalledTimes(2);
  });

  it("F3 正对照｜发起失败/保存被拒都要把门交还：否则一次失败就再也点不动执行", async () => {
    h.debug.mockRejectedValueOnce(new Error("503 队列满了"));
    await startRun("debug");
    expect(useSceneStore.getState().run.phase).toBe("error");
    h.debug.mockResolvedValueOnce({ run_id: "run-c" });
    await startRun("debug"); // 上一轮 failRun 之后必须还能再发起
    expect(useSceneStore.getState().run.runId).toBe("run-c");
    // 早退那一条（保存被本地预检拒 → try 里 return）也要走 finally
    seed({ nodes: [{ key: "n1", kind: "nope" } as unknown as StepNode], baselineNodes: "[]" });
    const spy = vi.spyOn(message, "error");
    await startRun("manual");
    expect(spy).toHaveBeenCalled();
    h.debug.mockResolvedValueOnce({ run_id: "run-d" });
    await startRun("debug");
    expect(useSceneStore.getState().run.runId).toBe("run-d");
  });
});
