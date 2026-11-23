// Pilot 试验台（bench.tsx，§11.3/§11.4.30）组件测试。此前是覆盖零：11 个 data-testid
// 没有一个被任何测试/e2e 摸过。钉的全是文件头注释里写明的口径：
//   ① R23 惰性会话：[开始新会话] 只 GET /agent/tools（URL 字面量，含 /api/v1 前缀与
//      project_id 逐字），POST /agent/sessions 只在第一条消息时发生一次，body 逐字
//      {project_id, model_id, thinking, mode}——任何一键改名都是后端契约静默断裂；
//   ② 消息 POST body 逐字 {content}（不是 text）；SSE 只在会话建成后开一次（s1）；
//   ③ RUN_END 终态分档（:75-88 注释）：WAIT_APPROVAL → 等待审批且中断钮必须活着
//      （D263 起审批卡也可回传，中断是另一条随时可走的出口）；ERROR → 出错（崩掉的 run 不许洗成绿「空闲」）；
//      DONE/CANCELLED/未知 → 空闲且 run 清空（中断钮消失）；
//      APPROVAL_REQ（:91）同样进等待审批；
//   ④ 诚实失败：发消息 500 → 状态回落到发起前那一刻的状态（绝不假「运行中」）、输入不丢、
//      toast 带后端原话；会话创建失败 → 保持发起前的「空闲」且 SSE 一条不开；
//      model-cfgs 403（R19：model:cfg 仅系统管理员）→ 选择器消失、silent 不吵 toast、
//      body 不带 model_id；
//      model-cfgs 非 403（500 / 断网 TypeError）→ 选择器同样消失，但右栏必须说另一句
//      话（「没取到（不是没有权限）」）——取数失败不许演成权限规则；200 但无可用 CHAT
//      → 「没有」是事实，失败句与权限措辞都不许出现；
//   ⑤ 事件流：seq 去重、计划列表原地合流（§11.4.33）、工具效果徽标吃 /agent/tools 映射；
//   ⑥ 卡片回写（R149/D32）：「[卡片操作] 」前缀 + 忙判定与 send() 同口径（运行中不排队
//      不吞点击 → 选项 disabled +「等本轮结束」）；
//   ⑦ 重新开始/卸载必关旧 SSE 句柄（流泄漏 = 断线重连风暴）；
//   ⑧ 挂起态（等待审批）与运行中同口径忙：send/sendText/cardCtx.busy 共用中断钮那一个
//      判定（挂起时后端 messages 必 409）；任何发送失败 = 还原调用前状态——挂起不被洗成
//      「空闲」，中断钮与审批卡都不拆。
//   ⑨ D179 世代守卫：以上⑧是「同一条腿的同步还原」，表达不出**迟到**的收尾。SSE 比
//      POST messages 回包先到是真事（快 run 的 RUN_END 在途窗口里就能推来），于是：
//      迟到的失败 catch 把「等待审批」洗成发起前的「空闲」（中断钮拆掉）；迟到的 run_id
//      认领到一个已经终态的 run（中断按错 id）；迟到的 setDraft("") 吃掉在途窗口里新打的字。
//      这三条都要用手工 deferred 把竞态钉在「在途」那一格才测得出来。
//   ⑩ D55 判据3 刷新恢复：localStorage["tp.bench.session."+projectId] = 按项目的恢复锚点，
//      会话建成即写、「重新开始」即删、GET 历史 404 即删。挂载时锚点在手 → GET
//      /agent/sessions/{sid}/messages 按 next_cursor 逐页回放（cursor 参数逐字进 URL），
//      信封喂进与直播同一条 applyEvent（同一个 event-card、同一个状态机，没有第二套渲染），
//      放完挂直播流续传；空历史不画卡不吵 toast；回放途中发送双闸（按钮 disabled + send()
//      内部 busy 闸）拦死，状态槽说「正在回放历史…」；恢复绝不伪造「运行中」，屏上状态
//      只由事件落定。无锚点 = 挂载零条 messages GET（恢复腿请求数为零）。
//      beforeEach 里 localStorage.clear()：持久化腿会在发送时写键，不清会把上一回合的
//      锚点带进下一回合的挂载，恢复 GET 混进 calls 计数。
// SSE 用 vi.mock 换桩：shared/sse.ts 是 reader 不结束的 while(true) 循环（它有自己的
// sse.test.ts 全套），页面层要钉的是「何时开流、事件如何驱动状态」，桩掉后可确定性注入。
import { beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { message } from "antd";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
// jsdom 的 Element 没有 scrollTo（本文件实测 undefined）：:56 的事件流自动滚底
// effect 每推一条事件就跑一次，不补桩则第一条 SSE 直接把用例炸穿。
Element.prototype.scrollTo = () => undefined;
// SSE 注入走裸 act()（非 RTL 包装路径）：React 18 要求显式声明 act 环境，否则只警告不 flush。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 每次调用给一个独立 close 桩：「重新开始关旧流 / 卸载关新流」按句柄分别可查。
const sse = vi.hoisted(() => ({
  openAgentStream: vi.fn((..._args: unknown[]): { close: () => void } => ({ close: vi.fn() })),
}));
vi.mock("../agent/sse", () => ({ openAgentStream: sse.openAgentStream }));

import Bench from "./bench";
import { setToken } from "../api/client";
import { useAuth } from "../auth/store";
import type { ProjectOut } from "../auth/store";

interface ModelOut { id: string; name: string; model_type: string; enabled: boolean; is_default: boolean; supports_tools: boolean; }
function model(over: Partial<ModelOut> = {}): ModelOut {
  return { id: "m1", name: "n", model_type: "CHAT", enabled: true, is_default: false, supports_tools: true, ...over };
}
// 两条可选 CHAT（一默认）+ EMBEDDING（必须不出现）+ 停用 CHAT（必须不出现）
const MODELS: ModelOut[] = [
  model({ id: "m1", name: "fundgpt-coder", is_default: true }),
  model({ id: "m2", name: "gpt-x" }),
  model({ id: "m3", name: "bge-m3", model_type: "EMBEDDING" }),
  model({ id: "m4", name: "旧模型", enabled: false }),
];

const TOOLS = [
  { name: "create_api_case", effect: "write" as const },
  { name: "destroy_data", effect: "destructive" as const },
];

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

type Call = { url: string; method: string; body?: string };
const calls: Call[] = [];

const cfg = {
  project: PROJECT as ProjectOut, // GET /projects 回包内容（D102：项目级权限位的数据源，可替换）
  modelCfgForbidden: false, // R19：非系统管理员 → model-cfgs 403
  modelCfg500: false, // 服务端错误：取数失败 ≠ 权限规则
  modelCfgDown: false, // fetch 直接 reject TypeError（后端宕机/断网），连 ApiErr 都没有
  modelCfgItems: MODELS as ModelOut[], // 200 回包内容可替换（如全非 CHAT/停用 → 「真没有」正对照）
  sessionFails: false,
  messageFails: false,
  message503: false, // true=引擎不可用（503），false=普通 400
  runId: "r1",
  // D179 竞态把手：非空时把对应 POST 挂在 promise 上，由用例决定回包何时落地——
  // 「同一时刻的同步还原」表达不出「迟到的收尾」，只有把请求钉住在途那一格才测得出来。
  msgGates: [] as (Promise<void> | null)[], // 按 messages POST 的到达顺序逐条消费（null = 这条不挂门）
  sessionGate: null as Promise<void> | null,
  runIdByCall: [] as string[], // 按 messages POST 顺序回不同 run_id（区分两条在飞发送）
  // D55 恢复把手：GET messages 的历史页按到达顺序消费；耗尽后恒回「空页 + null」
  // （翻页不封顶的变异体因此能自然收敛，而「GET 条数」断言照样红它——不让变异把用例吊死）。
  historyPages: [] as { items: unknown[]; next_cursor: string | null }[],
  historyStatus: 0, // >0 = 历史 GET 一律回这个状态（404 = 会话已删腿）
  historyGate: null as Promise<void> | null, // 钉住「历史还在途」那一格（双发送闸的用例）
};

beforeEach(() => {
  cleanup();
  message.destroy();
  // D55 持久化会在发送时写 localStorage["tp.bench.session.*"]；不清就是把上一回合的
  // 恢复锚点带进下一回合的挂载——恢复 GET 会混进 calls 计数、把「无键零请求」钉歪。
  localStorage.clear();
  calls.length = 0;
  cfg.project = PROJECT;
  cfg.modelCfgForbidden = false;
  cfg.modelCfg500 = false;
  cfg.modelCfgDown = false;
  cfg.modelCfgItems = MODELS;
  cfg.sessionFails = false;
  cfg.messageFails = false;
  cfg.message503 = false;
  cfg.runId = "r1";
  cfg.msgGates = [];
  cfg.sessionGate = null;
  cfg.runIdByCall = [];
  cfg.historyPages = [];
  cfg.historyStatus = 0;
  cfg.historyGate = null;
  msgIdx = 0;
  sse.openAgentStream.mockClear();
  setToken("tok-test"); // getToken() 有值 → 「写类操作会真实落库」提示行在
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: true, status: "active" },
    project: PROJECT, ready: true,
  });
  const resp = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
  const fail = (status: number, code: string, msg: string) =>
    ({ ok: false, status, json: async () => ({ code, message: msg }) }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    if (method === "GET" && url === "/api/v1/projects?size=200") return resp({ items: [cfg.project] });
    if (method === "GET" && url === "/api/v1/model-cfgs?size=200") {
      if (cfg.modelCfgDown) throw new TypeError("Failed to fetch"); // 传输层失败：不是 ApiErr
      if (cfg.modelCfg500) return fail(500, "boom", "模型列表查询失败");
      if (cfg.modelCfgForbidden) return fail(403, "forbidden", "模型配置不可见");
      return resp({ items: cfg.modelCfgItems });
    }
    if (method === "GET" && url.startsWith("/api/v1/agent/tools?")) return resp({ items: TOOLS });
    if (method === "GET" && /^\/api\/v1\/agent\/sessions\/s1\/messages\?/.test(url)) {
      // D55 恢复回放的历史 GET：门 → 状态 → 按到达顺序发页（耗尽恒回空页，见 cfg 注释）
      if (cfg.historyGate) await cfg.historyGate;
      if (cfg.historyStatus) return fail(cfg.historyStatus, "gone", "会话不存在");
      return resp(cfg.historyPages.shift() ?? { items: [], next_cursor: null });
    }
    if (method === "POST" && url === "/api/v1/agent/sessions") {
      if (cfg.sessionGate) await cfg.sessionGate; // 钉住「会话还没建成」那一格
      return cfg.sessionFails ? fail(500, "boom", "会话创建失败") : resp({ id: "s1" });
    }
    if (method === "POST" && /^\/api\/v1\/agent\/sessions\/s1\/messages$/.test(url)) {
      const i = msgIdx++; // 两条在飞发送各有各的门与 run_id（D179 的迟到腿要分世代）
      const gate = cfg.msgGates[i];
      if (gate) await gate;
      if (cfg.messageFails)
        return cfg.message503 ? fail(503, "engine_down", "执行链路不可用") : fail(400, "invalid_input", "输入不合法");
      return resp({ run_id: cfg.runIdByCall[i] ?? cfg.runId });
    }
    // D263 审批回传：路径逐字 /agent/runs/{run}/approval，body {tool_call_id, decision}
    if (method === "POST" && /^\/api\/v1\/agent\/runs\/[^/]+\/approval$/.test(url))
      return resp({ ok: true });
    if (method === "POST" && /^\/api\/v1\/agent\/sessions\/s1\/interrupt$/.test(url))
      return fail(404, "run_gone", "运行已结束"); // 钉 silent catch：任何错都不许吵出 toast
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
});

// ── 小工具 ────────────────────────────────────────────────────────────────────

const statusText = () => screen.getByTestId("bench-status").textContent;
const callsTo = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url));
const postBody = (c: Call) => JSON.parse(c.body ?? "{}") as Record<string, unknown>;
function toastText(): string {
  return Array.from(document.querySelectorAll(".ant-message")).map((n) => n.textContent).join("|");
}
/** rc-select 的 testid 挂在外层：disabled 类在 .ant-select 根上（closest 含自身）。 */
function selectDisabled(testid: string): boolean {
  const node = screen.getByTestId(testid).closest(".ant-select") ?? screen.getByTestId(testid);
  return node.className.includes("ant-select-disabled");
}
const visibleOptions = () => Array.from(document.querySelectorAll(
  ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")) as HTMLElement[];
async function openSelect(testid: string): Promise<void> {
  fireEvent.mouseDown(screen.getByTestId(testid).querySelector(".ant-select-selector")!);
}
async function clickOption(label: string): Promise<void> {
  await waitFor(() => {
    expect(visibleOptions().some((o) => (o.textContent ?? "").includes(label))).toBe(true);
  });
  fireEvent.click(visibleOptions().find((o) => (o.textContent ?? "").includes(label))!);
}

type Ev = { seq: number; ts: string; type: string; payload: Record<string, unknown> };
const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): Ev =>
  ({ seq, ts: "2026-11-20T10:00:00+08:00", type, payload });
const planEv = (seq: number, title: string, items: unknown[]): Ev =>
  ev(seq, "TOOL_RESULT", {
    tool_name: "update_plan_item", ui: "card", ok: true,
    content: { card: { kind: "generic", form: "plan_list", title, items } },
  });
const questionEv = (seq: number): Ev =>
  ev(seq, "TOOL_RESULT", {
    tool_name: "ask_user", ui: "card", ok: true,
    content: { card: { kind: "generic", form: "question", question: "部到哪个环境？", options: ["预发环境", "线上环境"] } },
  });

/** 取第 n 条 SSE 流的 onEvent 回调（openAgentStream(sessionId, { onEvent })）。 */
function sseEmit(callIndex: number, e: Ev): void {
  const handlers = sse.openAgentStream.mock.calls[callIndex][1] as { onEvent: (ev: Ev) => void };
  act(() => handlers.onEvent(e));
}
const sseHandle = (callIndex: number) =>
  sse.openAgentStream.mock.results[callIndex].value as { close: ReturnType<typeof vi.fn> };

/** 默认挂载（无 location.state）。传 pilotDraft = 模拟「问 Pilot」入口的
 *  nav("/bench", { state: { pilotDraft } })，即发送端契约的接收侧。 */
function renderBench(pilotDraft?: string): void {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/bench", state: pilotDraft ? { pilotDraft } : null }]}>
      <Bench />
    </MemoryRouter>
  );
}
/** 渲染 + 点 [开始新会话]，等工具效果表回来（armed）。 */
async function startSession(): Promise<void> {
  renderBench();
  fireEvent.click(await screen.findByTestId("bench-start"));
  await waitFor(() => expect(callsTo("GET", /^\/api\/v1\/agent\/tools/).length).toBe(1));
}
/** 输入 + Ctrl+Enter 发送，等状态上「运行中」。 */
async function sendMessage(text: string): Promise<void> {
  const input = screen.getByTestId("bench-input");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(statusText()).toBe("运行中"));
}

// ── 入口与 armed 门（:183/:275 两态）─────────────────────────────────────────

it("未武装是诚实空态：状态「未开始」、输入区不渲染；挂载只拉 projects/model-cfgs（字面 URL 含 /api/v1）", async () => {
  renderBench();
  expect(screen.getByTestId("bench").textContent).toContain("Pilot 试验台");
  expect(statusText()).toBe("未开始");
  expect(document.body.textContent).toContain("选择项目并点「开始新会话」");
  expect(screen.queryByTestId("bench-input")).toBeNull();
  await waitFor(() =>
    expect(calls.some((c) => c.url === "/api/v1/projects?size=200" && c.method === "GET")).toBe(true));
  expect(calls.some((c) => c.url === "/api/v1/model-cfgs?size=200" && c.method === "GET")).toBe(true);
});

it("[开始新会话] 只 armed + GET tools（URL 字面量 project_id=p1），POST /agent/sessions 零条（R23 惰性）", async () => {
  renderBench();
  const start = await screen.findByTestId("bench-start");
  expect((start as HTMLButtonElement).disabled).toBe(false); // authProject 在手，钮即刻可用
  fireEvent.click(start);
  // 字面 URL：client 的 /api/v1 前缀 + project_id 参数名（悄悄改名 = tools 永远 400）
  await waitFor(() =>
    expect(callsTo("GET", /^\/api\/v1\/agent\/tools\?project_id=p1$/).length).toBe(1));
  expect(callsTo("POST", /\/agent\/sessions/).length).toBe(0); // 点一下不建会话
  expect(sse.openAgentStream).not.toHaveBeenCalled();
  expect(statusText()).toBe("空闲");
  expect(document.body.textContent).toContain("发一条消息，看 Pilot 一步步干活");
  // 武装后项目锁死（换项目 = 会话错位），按钮换「重新开始」
  expect(selectDisabled("bench-project-select")).toBe(true);
  expect(screen.getByTestId("bench-start").textContent).toContain("重新开始");
  // token 在 → 右栏落库警示常驻（:267 getToken() 门，写类操作真实落库不许悄悄试）
  expect(document.body.textContent).toContain("写类操作会真实落库");
});

// ── 请求形状（后端契约面）────────────────────────────────────────────────────

it("惰性会话（R23）：首条消息建会话（body 逐字四字段）+ messages 逐字 {content}；第二条复用会话不再建", async () => {
  await startSession();
  // body 里的 model_id 来自 /model-cfgs 的**回包**（bench.tsx:47-52 才 setModelId），
  // 而 startSession 只等到 tools GET 派发。慢后端下按 Ctrl+Enter 时默认模型还没选上，
  // POST body 就少一个 model_id——先等选择器真带上默认模型（同 :279 那条用例的等法）。
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  await sendMessage("帮我建一个查询订单接口");
  expect(sse.openAgentStream).toHaveBeenCalledTimes(1);
  expect(sse.openAgentStream.mock.calls[0][0]).toBe("s1"); // 会话 id 对上才开流
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/);
  expect(sp.length).toBe(1);
  // 默认档翻案（R44）：初始 mode 改为 PLAN（蓝图 §13 把写工具阶梯+审批门推到二期，
  // 一期唯一全通的档是只读 PLAN）。这条不碰选择器，钉的就是「默认档逐字进 body」。
  expect(postBody(sp[0])).toEqual({ project_id: "p1", model_id: "m1", thinking: "medium", mode: "PLAN" });
  let msgs = callsTo("POST", /^\/api\/v1\/agent\/sessions\/s1\/messages$/);
  expect(msgs.length).toBe(1);
  expect(postBody(msgs[0])).toEqual({ content: "帮我建一个查询订单接口" }); // 是 content 不是 text

  pushRunEnd();
  await sendMessage("再加个字段校验");
  expect(callsTo("POST", /^\/api\/v1\/agent\/sessions$/).length).toBe(1); // 第二条不新建会话
  expect(sse.openAgentStream).toHaveBeenCalledTimes(1); // 也不重开流
  msgs = callsTo("POST", /^\/api\/v1\/agent\/sessions\/s1\/messages$/);
  expect(msgs.length).toBe(2);
  expect(postBody(msgs[1])).toEqual({ content: "再加个字段校验" });
});

// 后端只发 DONE/WAIT_APPROVAL/ERROR/CANCELLED（agent/models.py:43；RUN_END 发射点
// runner.py:59、tasks.py:81/:92、routes.py:131）。"SUCCEEDED" 是后端从不发出的虚构值——
// 旧默认参数喂它，等于让「崩溃 run 被洗成空闲」这条链永远测不出来。默认改用真发的 DONE。
function pushRunEnd(status = "DONE", seq = 50): void {
  sseEmit(0, ev(seq, "RUN_END", { status }));
}

it("模式/思考下拉的选择逐字进 POST /agent/sessions；会话落地后三个下拉全部锁死", async () => {
  await startSession();
  expect(selectDisabled("bench-mode-select")).toBe(false); // 会话未建：可改
  expect(selectDisabled("bench-thinking-select")).toBe(false);
  await openSelect("bench-mode-select");
  await clickOption("只读（PLAN）");
  await openSelect("bench-thinking-select");
  await clickOption("高");
  // 同 :263：startSession 只等到 tools 的**派发**，model_id 来自 /model-cfgs 的**回包**。
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  await sendMessage("先只看看不动东西");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(postBody(sp)).toEqual({ project_id: "p1", model_id: "m1", thinking: "high", mode: "PLAN" });
  // 会话已定：run 结束也锁死（session 参数是会话级承诺，:232/:245/:260 的 sessionId !== null 门）
  pushRunEnd();
  await waitFor(() => expect(statusText()).toBe("空闲"));
  expect(selectDisabled("bench-mode-select")).toBe(true);
  expect(selectDisabled("bench-thinking-select")).toBe(true);
  expect(selectDisabled("bench-model-select")).toBe(true);
});

// R44 翻案配套：默认档从 FULL 翻成 PLAN（蓝图 §13：写工具阶梯+审批门属二期）后，
// FULL 路径的覆盖不许跟着丢——这条显式手选 FULL，钉「选择器的 onChange 真把选择送进 body」。
// 上面那条不碰选择器（默认档 = PLAN），这条手动切到 FULL：onChange 若断，两条合起来
// 一个红 PLAN 一个红 FULL，默认与切换各有自己的点名红。
it("默认翻案（R44）：手选切到「全自动（FULL）」→ create body 逐字带 mode:\"FULL\"（选择器通路保留覆盖）", async () => {
  await startSession();
  await openSelect("bench-mode-select");
  await clickOption("全自动（FULL）");
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  await sendMessage("切到 FULL 再发");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(postBody(sp)).toEqual({ project_id: "p1", model_id: "m1", thinking: "medium", mode: "FULL" });
});

// ── D102 角色级模式门：FULL 选项按 agent:full:use 出（形状=隐藏，非禁用）──────────
// 后端建会话对无位者 FULL 一律 403（test_d102_full_mode_gate），前端不许再摆一个
// 「看得见、按得动、发出去必 403」的档位——选择器选项不是写入口，取隐藏。
// PROJECT 夹具 my_perms=["*"]（PROJECT_ADMIN）有位 → 上面 R44 那条就是「有位 FULL 可选」
// 的正腿；本组钉反面：MEMBER 兜底表（deny 位所在）与服务端下发的无位 my_perms 两条路。

it("D102｜MEMBER 兜底表无 FULL 位：模式下拉只有 PLAN/ASK 两项，PLAN 手选照常进 body", async () => {
  const memberProject = { ...PROJECT, my_role: "MEMBER", my_perms: undefined };
  cfg.project = memberProject; // 项目列表（activeProject 的数据源）与 store 同一份 MEMBER 视角
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: memberProject, // 无 my_perms → 走 ROLE_PATTERNS.MEMBER 兜底
  });
  await startSession();
  await openSelect("bench-mode-select");
  await waitFor(() => expect(visibleOptions().length).toBe(2));
  const texts = visibleOptions().map((o) => o.textContent ?? "");
  expect(texts.join("|")).toContain("只读（PLAN）");
  expect(texts.join("|")).toContain("询问（ASK）");
  expect(texts.join("|")).not.toContain("全自动（FULL）"); // 隐藏而不是禁用：DOM 里压根没有
  // 选择器对 PLAN/ASK 照常工作（隐藏一个选项 ≠ 锁死整个选择器）
  await clickOption("只读（PLAN）");
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  await sendMessage("只读也能干活");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(postBody(sp)).toEqual({ project_id: "p1", model_id: "m1", thinking: "medium", mode: "PLAN" });
});

it("D102｜服务端下发不含该位的 my_perms：同样不出 FULL 项（patternsForProject 优先服务端路）", async () => {
  // 自定义角色：通配 + 逐位 deny，agent:full:use 不在放行集（与内置 MEMBER 等价的效果）
  const customProject = { ...PROJECT, my_role: "CUSTOM",
    my_perms: ["*", "-*:delete", "-*:manage", "-system:*", "-agent:full:*"] };
  cfg.project = customProject;
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: customProject,
  });
  await startSession();
  await openSelect("bench-mode-select");
  await waitFor(() => expect(visibleOptions().length).toBe(2));
  expect(visibleOptions().map((o) => o.textContent ?? "").join("|")).not.toContain("FULL");
});

it("D102｜正对照（有位的普通用户）：FULL 项回来且可选（门是位判定，不是「非系统管理员一律隐藏」）", async () => {
  const grantedProject = { ...PROJECT, my_role: "CUSTOM", my_perms: ["*", "-agent:full:delete"] }; // deny 罩不到 :use
  cfg.project = grantedProject;
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: grantedProject,
  });
  await startSession();
  await openSelect("bench-mode-select");
  await waitFor(() => expect(visibleOptions().length).toBe(3));
  await clickOption("全自动（FULL）");
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  await sendMessage("有位的普通用户按 FULL");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(postBody(sp).mode).toBe("FULL");
});

// ── 模型选择器（R19 的 403 降级面 —— 本页唯一的「权限」形状）─────────────────

it("模型下拉只收 enabled 的 CHAT；默认模型自动选中并进 body.model_id", async () => {
  await startSession();
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  await openSelect("bench-model-select");
  await waitFor(() => expect(visibleOptions().length).toBe(2));
  const texts = visibleOptions().map((o) => o.textContent ?? "");
  expect(texts.join("|")).toContain("gpt-x");
  expect(texts.join("|")).not.toContain("bge-m3"); // EMBEDDING 不进 CHAT 选择器
  expect(texts.join("|")).not.toContain("旧模型"); // enabled=false 不进
  // D104 反面对照：supports_tools=true（夹具默认）的模型不带「不支持工具」标注
  expect(texts.join("|")).not.toContain("不支持工具");
});

// ── D104 D 态：supports_tools 前端接线（数据在库、前端此前不吃）──────────────
// 裁定是最小诚实形状：false 的模型【照样可选】（后端 gateway 丢 tools 优雅降级，
// 禁选/隐藏都是过度纠正），但 label 必须明说「（不支持工具）」——不撒谎 UI（§13 纪律 1）。
// 夹具刻意让默认模型 supports_tools=false：默认自动选中腿与标注腿同框，且钉「标注不挡自动选中」。

it("D104｜supports_tools=false 的模型带「（不支持工具）」标注但仍可选；true 的不带", async () => {
  cfg.modelCfgItems = [
    model({ id: "m1", name: "fundgpt-coder", is_default: true }), // true：无标注
    model({ id: "m2", name: "legacy-no-tools", supports_tools: false }), // false：带标注
  ];
  await startSession();
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  await openSelect("bench-model-select");
  await waitFor(() => expect(visibleOptions().length).toBe(2));
  const texts = visibleOptions().map((o) => o.textContent ?? "");
  expect(texts.join("|")).toContain("legacy-no-tools（不支持工具）");
  expect(texts.join("|")).not.toContain("fundgpt-coder（默认）不支持工具"); // true 的干净
  // 「照样可选」不是摆设：点它 → 选择真落地并进 body.model_id
  await clickOption("legacy-no-tools");
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("legacy-no-tools"));
  await sendMessage("不带工具也能聊");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(postBody(sp).model_id).toBe("m2");
});

it("D104｜默认模型本身就 supports_tools=false：照常自动选中进 body，标注同框可见（两条腿互不干扰）", async () => {
  cfg.modelCfgItems = [model({ id: "m1", name: "only-model", is_default: true, supports_tools: false })];
  await startSession();
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("only-model"));
  // 标注先量（发送后会话建立 → 三个下拉按既有口径锁死，锁死后开不出下拉）
  await openSelect("bench-model-select");
  await waitFor(() =>
    expect(visibleOptions().map((o) => o.textContent ?? "").join("|")).toContain("不支持工具"));
  await sendMessage("默认就是它");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(postBody(sp).model_id).toBe("m1"); // 标注不许把默认自动选中腿挤掉
});

it("model-cfgs 403（非系统管理员，R19）：选择器消失、silent 不吵 toast；仍可发送且 body 不带 model_id", async () => {
  cfg.modelCfgForbidden = true;
  await startSession(); // 只读视角：模型配置不可见也不能拦试验台
  expect(screen.queryByTestId("bench-model-select")).toBeNull(); // 隐藏而不是空下拉
  expect(toastText()).not.toContain("模型配置不可见"); // silent:true —— 403 不许吵
  // 403 是设计内降级（R19）：不许混进「取数失败」那句话——那是把权限规则说成查询故障
  expect(screen.queryByTestId("bench-model-unavailable")).toBeNull();
  expect(document.body.textContent).not.toContain("模型列表没取到");
  await sendMessage("查一下订单表");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(sp.body).not.toContain("model_id"); // 不带字段 = 用后端默认模型，不是 model_id:null
  expect(postBody(sp)).toEqual({ project_id: "p1", thinking: "medium", mode: "PLAN" }); // 默认档 R44 起为 PLAN
});

// 失败句与权限措辞是两套话术，测试用「不含对方」互钉：notice 节点摘掉后的全文里
// 不许出现任何权限claim（notice 自己的「不是没有权限」是否定式声明，先摘再查）。
const NOTICE_DENIED_RE = /没有权限|无权限|不可见|仅系统管理员|未授权/;
function bodyTextWithoutNotice(): string {
  const all = document.body.textContent ?? "";
  const notice = screen.queryByTestId("bench-model-unavailable");
  return notice ? all.replace(notice.textContent ?? "", "") : all;
}

it("model-cfgs 500（不是权限）：选择器消失但右栏说「模型列表没取到」，silent 不吵 toast；仍可发送且 body 不带 model_id", async () => {
  cfg.modelCfg500 = true;
  await startSession();
  // modelsFailed 是回包之后才落的态（bench.tsx:69），startSession 只等到 tools 派发：
  // 慢后端下这里同步查会拿不到（本轮探针实测红）。findBy 等到它出现，断言强度不变。
  const notice = await screen.findByTestId("bench-model-unavailable");
  expect(screen.queryByTestId("bench-model-select")).toBeNull(); // 没得选照样隐藏
  expect(notice.textContent).toContain("模型列表没取到");
  expect(notice.textContent).toContain("不是没有权限"); // 明说这不是权限判定
  expect(notice.textContent).toContain("平台默认模型");
  expect(toastText()).not.toContain("模型列表查询失败"); // silent:true 保持——降级靠句不靠吵
  await sendMessage("照发不误");
  const sp = callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0];
  expect(postBody(sp)).toEqual({ project_id: "p1", thinking: "medium", mode: "PLAN" }); // 与 403 同款回退（默认档 R44 起为 PLAN）
});

it("model-cfgs 传输层失败（fetch reject TypeError，连 ApiErr 都不是）：说「没取到」，绝不许说成权限", async () => {
  cfg.modelCfgDown = true;
  await startSession();
  expect(screen.queryByTestId("bench-model-select")).toBeNull();
  const notice = screen.getByTestId("bench-model-unavailable"); // 状态盲 catch 会把这条演成 403：红在这
  expect(notice.textContent).toContain("模型列表没取到");
  expect(toastText()).toBe("");
  // 权限侧 claim 一条都不许出现（后端 403 原话「模型配置不可见」更不许凭空冒出来）
  expect(bodyTextWithoutNotice()).not.toMatch(NOTICE_DENIED_RE);
});

it("正对照：model-cfgs 200 但全非 CHAT/全停用 →「真没有」既非失败也非权限，失败句与权限措辞都不出现", async () => {
  cfg.modelCfgItems = [
    model({ id: "m9", name: "bge-m3", model_type: "EMBEDDING" }),
    model({ id: "m8", name: "旧模型", enabled: false }),
  ];
  await startSession();
  expect(screen.queryByTestId("bench-model-select")).toBeNull(); // 没有可选项 → 隐藏（既有口径）
  expect(screen.queryByTestId("bench-model-unavailable")).toBeNull(); // 200 是取到了，不许说「没取到」
  expect(document.body.textContent).not.toContain("模型列表没取到");
  expect(bodyTextWithoutNotice()).not.toMatch(NOTICE_DENIED_RE); // 也不许顺手 claim 权限问题
});

it("正对照：model-cfgs 200 有可用模型（成功路径）→ 选择器在，失败句不出现", async () => {
  await startSession();
  await waitFor(() =>
    expect(screen.getByTestId("bench-model-select").textContent).toContain("fundgpt-coder（默认）"));
  expect(screen.queryByTestId("bench-model-unavailable")).toBeNull();
});

// ── 失败诚实性 ────────────────────────────────────────────────────────────────

it("发消息 503：状态回落「空闲」不假「运行中」，输入原文保住，toast 带后端原话", async () => {
  await startSession();
  await sendMessage("第一轮是好的");
  pushRunEnd();
  await waitFor(() => expect(statusText()).toBe("空闲"));
  cfg.messageFails = true;
  cfg.message503 = true;
  const input = screen.getByTestId("bench-input");
  fireEvent.change(input, { target: { value: "这条会失败，字不能丢" } });
  fireEvent.click(screen.getByTestId("bench-send")); // 按钮路径（Ctrl+Enter 之外另一条入口）
  await waitFor(() => {
    expect(callsTo("POST", /\/messages$/).length).toBe(2);
    expect(statusText()).toBe("空闲"); // catch 分支：有会话 → 空闲，绝不停在「运行中」
  });
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe("这条会失败，字不能丢");
  // toast 要 waitFor：上面那个 waitFor 只等到「请求数 + 状态回落」，antd message 是
  // **另一次 React 渲染**才上屏的 —— 直接同步断言就是跟它抢，全套并跑时先输（实测
  // 红过一次：`expected '' to contain '执行链路不可用'`，单跑 50 passed 全绿）。
  // 同文件正向 toast 断言的写法一致（:583 以及 EnvPanel.test.tsx:318 那一族都是 waitFor 包着），
  // 反向断言（:485/:514/:526 那几条 not.toContain / toBe("")）**故意不包** ——
  // 「没有」这件事在 t=0 就成立，包进 waitFor 只会让它永远绿，那是自欺。
  await waitFor(() => expect(toastText()).toContain("执行链路不可用")); // 非 silent post：后端信封原话上屏
  expect(screen.queryByTestId("bench-interrupt")).toBeNull(); // 没跑起来就没有中断钮
});

it("会话创建失败：还原发起前的「空闲」（catch 不编状态：旧实现按 sessionId 硬造「未开始」），SSE 一条不开，toast 带原话，输入保住", async () => {
  cfg.sessionFails = true;
  await startSession();
  const input = screen.getByTestId("bench-input");
  fireEvent.change(input, { target: { value: "先建会话再说话" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("POST", /^\/api\/v1\/agent\/sessions$/).length).toBe(1));
  // 失败前页面就是「空闲」（start() 落的态）：诚实 = 原样还回去；catch 若回退成
  // sessionId ? "空闲" : "未开始"，这里会量到凭空捏出来的「未开始」。
  expect(statusText()).toBe("空闲");
  expect(sse.openAgentStream).not.toHaveBeenCalled(); // 没有 s 就没有流可开
  expect(callsTo("POST", /\/messages$/).length).toBe(0); // 会话没成就不发第二条请求
  await waitFor(() => expect(toastText()).toContain("会话创建失败"));
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe("先建会话再说话");
});

// ── RUN_END / APPROVAL_REQ 状态机 + 中断出口 ─────────────────────────────────

it("RUN_END 两态：DONE→空闲且中断钮消失；WAIT_APPROVAL→等待审批且中断钮活着，POST body 逐字 {run_id} 且 404 静默", async () => {
  cfg.runId = "r77";
  await startSession();
  await sendMessage("建个用例");
  expect(screen.getByTestId("bench-interrupt")).not.toBeNull(); // 运行中可中断
  pushRunEnd();
  await waitFor(() => expect(statusText()).toBe("空闲"));
  expect(screen.queryByTestId("bench-interrupt")).toBeNull(); // run 清空 = 没东西可中断

  await sendMessage("再跑一轮");
  // 等到认领真的提交再按中断：sendMessage 只等到「运行中」（那是 await 之前同步落的态），
  // 慢后端下回包还在途 → runId 仍是 null → interrupt() 首行 return，一条都不发
  // （本轮 R31 探针实测 `expected +0 to be 1`，与 :448 那条 D179 用例同根）。
  await waitClaimed();
  sseEmit(0, ev(8, "RUN_END", { status: "WAIT_APPROVAL" }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  // S0 无页面审批：挂起态下中断是唯一出口，钮消失就是把用户锁死（:61 注释的口径）
  await waitFor(() => expect(screen.queryByTestId("bench-interrupt")).not.toBeNull());
  fireEvent.click(screen.getByTestId("bench-interrupt"));
  await waitFor(() => expect(callsTo("POST", /^\/api\/v1\/agent\/sessions\/s1\/interrupt$/).length).toBe(1));
  expect(postBody(callsTo("POST", /interrupt$/)[0])).toEqual({ run_id: "r77" });
  // mock 固定回 404（silent catch「已结束」）：不许把错误炸成 toast
  expect(toastText()).not.toContain("运行已结束");
});

it("RUN_END {status:\"ERROR\"} →「出错」红牌且中断钮消失：崩掉的 run 不许洗回绿色「空闲」", async () => {
  // tasks.py:81/:92 在未配置模型/模型不支持 tools 时发 {"status":"ERROR"}。旧实现只有
  // WAIT_APPROVAL 一支，ERROR 落进 else → 绿色「空闲」= 宣称一切正常。
  await startSession();
  await sendMessage("这轮会崩");
  sseEmit(0, ev(7, "RUN_END", { status: "ERROR" }));
  await waitFor(() => expect(statusText()).toBe("出错"));
  expect(tagNode().className).toContain("ant-tag-red");
  expect(tagNode().className).not.toContain("ant-tag-green"); // 核心：不再是「一切正常」的绿
  // 「出错」是终态：runId 已清、running 判定（:113）不认它 → 中断钮不在 DOM
  expect(screen.queryByTestId("bench-interrupt")).toBeNull();
});

it("RUN_END {status:\"CANCELLED\"} →「空闲」不是「已取消」：中断后页面语义就是回到可操作态", async () => {
  // routes.py:131 用户中断发 CANCELLED；e2e bench.spec.mjs:78-80 钉的正是中断后「空闲」。
  // 这条钉死 CANCELLED 不许跟着 ERROR 一起改成独立终态字样。
  await startSession();
  await sendMessage("跑一轮然后中断");
  sseEmit(0, ev(7, "RUN_END", { status: "CANCELLED" }));
  await waitFor(() => expect(statusText()).toBe("空闲"));
  expect(tagNode().className).toContain("ant-tag-green");
  expect(screen.queryByTestId("bench-interrupt")).toBeNull(); // run 清空：没东西可中断
});

it("APPROVAL_REQ 事件：状态即跳「等待审批」，审批卡摊开工具与参数，中断钮在", async () => {
  await startSession();
  await sendMessage("帮我改数据库结构");
  sseEmit(0, ev(3, "APPROVAL_REQ",
    { run_id: "r1", tool_call_id: "tc1", tool_name: "create_api_case", args: { name: "订单查询" } }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  const card = screen.getByTestId("approval-card");
  expect(card.textContent).toContain("create_api_case");
  expect(card.textContent).toContain("订单查询");
  expect(screen.getByTestId("bench-interrupt")).not.toBeNull(); // 等待审批也算 running（:153）
});

it("审批卡三档回传：POST 路径与 body 逐字；决策事件把卡翻成只读", async () => {
  cfg.runId = "r88";
  await startSession();
  await sendMessage("建个用例");
  await waitClaimed();
  sseEmit(0, ev(3, "APPROVAL_REQ",
    { run_id: "r88", tool_call_id: "tc9", tool_name: "create_api_case", args: { name: "x" } }));
  await waitFor(() => expect(screen.getByTestId("approval-once")).not.toBeNull());
  fireEvent.click(screen.getByTestId("approval-once"));
  await waitFor(() => expect(
    callsTo("POST", /^\/api\/v1\/agent\/runs\/r88\/approval$/).length).toBe(1));
  expect(postBody(callsTo("POST", /\/approval$/)[0]))
    .toEqual({ tool_call_id: "tc9", decision: "once" });
  // APPROVAL_DECISION 一到（回放/直播同一条路），卡片变只读徽标，按钮不再重复可点
  sseEmit(0, ev(4, "APPROVAL_DECISION", { tool_call_id: "tc9", decision: "once" }));
  await waitFor(() => expect(screen.queryByTestId("approval-once")).toBeNull());
  expect(screen.getByTestId("approval-decided").textContent).toContain("已批准");
});

it("挂起态（等待审批）拒发：Ctrl+Enter 一条消息都不发，状态不被洗、中断钮留在屏上、草稿不吞", async () => {
  // 挂起时后端 messages 必 409 session_busy（routes.py 的刻意拦截）。旧守卫只认「运行中」：
  // Ctrl+Enter 放行 → 409 落进旧 catch（硬造 空闲）→ 状态徽章被洗、running 变假、
  // 屏上唯一的中断出口被拆掉——正是审批卡让用户按的那个钮。守卫与 catch 一起改掉了这条链。
  cfg.messageFails = true; // 守卫改回「只认运行中」时这条 409 会真的落进 catch（弱腿的扳机）
  await startSession();
  await sendMessage("先跑一轮");
  sseEmit(0, ev(6, "RUN_END", { status: "WAIT_APPROVAL" }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  expect(callsTo("POST", /\/messages$/).length).toBe(1);
  const input = screen.getByTestId("bench-input");
  fireEvent.change(input, { target: { value: "挂起中补一句" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  // 守卫正确 → send() 首行即 return，没有第二条在飞请求
  await waitFor(() => expect(callsTo("POST", /\/messages$/).length).toBe(1));
  expect(statusText()).toBe("等待审批"); // 被拒的发送不许改写挂起态
  expect(screen.queryByTestId("bench-interrupt")).not.toBeNull(); // 唯一出口还在
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe("挂起中补一句");
});

// ── 事件流渲染 ────────────────────────────────────────────────────────────────

it("seq 去重：同 seq 推两次只渲染一份（重连重放不许画双份）", async () => {
  await startSession();
  await sendMessage("打招呼");
  sseEmit(0, ev(1, "USER", { text: "用户原话" }));
  sseEmit(0, ev(1, "USER", { text: "用户原话" }));
  await waitFor(() => expect(screen.getAllByTestId("event-card").length).toBe(1));
  expect(screen.getByTestId("event-card").textContent).toContain("用户原话");
});

it("计划列表原地合流（§11.4.33）：两份 plan_list TOOL_RESULT 界面上只留最新一份", async () => {
  await startSession();
  await sendMessage("先出个计划");
  sseEmit(0, planEv(4, "第一步", [{ id: 1, text: "写接口", state: "pending" }]));
  await waitFor(() => expect(screen.getAllByTestId("plan-list-card").length).toBe(1));
  sseEmit(0, planEv(5, "第一步", [
    { id: 1, text: "写接口", state: "done" },
    { id: 2, text: "补测试", state: "doing" },
  ]));
  await waitFor(() => expect(screen.getAllByTestId("plan-list-card").length).toBe(1));
  const card = screen.getByTestId("plan-list-card");
  expect(card.textContent).toContain("1/2"); // 进度跟最新一份走
  expect(screen.queryByTestId("plan-item-pending")).toBeNull(); // 旧「待办」形态被覆盖掉
});

it("工具效果徽标吃 /agent/tools 映射：登记过的 create_api_case 画「写入」，没登记的说「效果未知」", async () => {
  await startSession();
  await sendMessage("看看订单");
  sseEmit(0, ev(2, "TOOL_CALL", { tool_name: "create_api_case", args: {} }));
  sseEmit(0, ev(3, "TOOL_CALL", { tool_name: "神秘工具", args: {} }));
  await waitFor(() => expect(screen.getAllByTestId("event-card").length).toBe(2));
  const cards = screen.getAllByTestId("event-card");
  expect(cards[0].textContent).toContain("写入"); // effects[name]=write（start() 拉的映射表）
  // 以前这里断言「只读」，注释写着「可疑默认值」：映射表拿不到时把没登记的画成最安全的
  // 模样，等于用徽标替用户做了一次没拿到的判定。现在如实说不知道。
  expect(cards[1].textContent).toContain("效果未知");
  expect(cards[1].textContent).not.toContain("只读");
});

// ── 卡片回写（R149/D32）──────────────────────────────────────────────────────

it("ask_user 卡：运行中/等待审批选项都 disabled +「等本轮结束」且点击不排队不吞请求；空闲后点 → POST body「[卡片操作] 回答：xxx」", async () => {
  await startSession();
  await sendMessage("问一句部哪");
  sseEmit(0, questionEv(2));
  await waitFor(() => expect(screen.getByTestId("question-card")).not.toBeNull());
  const opts = screen.getAllByTestId("question-option");
  expect((opts[0] as HTMLButtonElement).disabled).toBe(true); // busy = running（运行中档）
  expect(screen.getByTestId("card-busy-note")).not.toBeNull();
  fireEvent.click(opts[0]); // 运行中硬点：既不排队也不发请求（:124 忙判定与 send() 同口径）
  expect(callsTo("POST", /\/messages$/).length).toBe(1);

  // 挂起档：cardCtx.busy 若单独写 status==="运行中"，等待审批下选项会解锁——
  // 点击穿过 sendText 旧守卫（同样只认运行中）真发 POST，后端回手一个 409。
  sseEmit(0, ev(3, "RUN_END", { status: "WAIT_APPROVAL" }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  const optsWait = screen.getAllByTestId("question-option");
  expect((optsWait[0] as HTMLButtonElement).disabled).toBe(true); // busy = running（等待审批档：与中断钮同口径）
  expect(screen.getByTestId("card-busy-note")).not.toBeNull();
  fireEvent.click(optsWait[0]); // 挂起中硬点：一条消息都不许发出去
  expect(callsTo("POST", /\/messages$/).length).toBe(1);

  pushRunEnd();
  await waitFor(() => expect(statusText()).toBe("空闲"));
  const opts2 = screen.getAllByTestId("question-option");
  expect((opts2[0] as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(opts2[0]);
  await waitFor(() => expect(callsTo("POST", /\/messages$/).length).toBe(2));
  expect(postBody(callsTo("POST", /\/messages$/)[1]))
    .toEqual({ content: "[卡片操作] 回答：预发环境" }); // 前缀 + 卡片文案拼接（:140）
});

// ── SSE 句柄生命周期 ─────────────────────────────────────────────────────────

it("重新开始关旧流并清屏；卸载关在飞的流（流泄漏 = 每 1.5s 重连风暴）", async () => {
  await startSession();
  await sendMessage("第一轮");
  sseEmit(0, ev(1, "USER", { text: "旧轮的事件" }));
  const h1 = sseHandle(0);
  pushRunEnd(); // 运行中「重新开始」是 disabled 的：先让本轮收尾
  await waitFor(() => expect(statusText()).toBe("空闲"));
  fireEvent.click(screen.getByTestId("bench-start")); // 重新开始
  expect(h1.close).toHaveBeenCalledTimes(1); // :80 先关旧句柄
  expect(screen.queryAllByTestId("event-card").length).toBe(0); // 事件清屏
  expect(statusText()).toBe("空闲");

  await sendMessage("第二轮");
  expect(sse.openAgentStream).toHaveBeenCalledTimes(2); // 新会话配新流
  const h2 = sseHandle(1);
  cleanup(); // 卸载 → 挂载 effect 的 return 里 close
  expect(h2.close).toHaveBeenCalledTimes(1);
});

// ── 问 Pilot 预填入口（D84 诚实切片：只填不发，注入一次即清）─────────────────
// 发送端契约（reportDetail / adbDevices 两个入口，按字面写）：
//   nav("/bench", { state: { pilotDraft: "<多行文本>" } })
// 接收端口径：挂载时一次性 seed 进 composer，然后 replace 清 state——刷新 / 浏览器
// 后退 / 再次导航都不许把同一段草稿倒回来第二遍；预填永不自发（人自己按发送）。

const PILOT_DRAFT = "报告 r1 第 3 步失败了\n帮我看看失败原因，顺带说下能不能重跑";

it("带 pilotDraft 挂载：开始会话后输入框逐字预填，且绝不自动发送（不建会话、不开流、状态不动）", async () => {
  renderBench(PILOT_DRAFT);
  // 未武装没有输入区（既有 :183 门，不许为此改视觉）：seed 进的是 draft state，武装后才可见
  fireEvent.click(await screen.findByTestId("bench-start"));
  await waitFor(() => expect(callsTo("GET", /^\/api\/v1\/agent\/tools/).length).toBe(1));
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe(PILOT_DRAFT);
  // 预填 ≠ 发送：没有人的按键就没有任何写请求
  expect(callsTo("POST", /\/messages$/).length).toBe(0);
  expect(callsTo("POST", /^\/api\/v1\/agent\/sessions$/).length).toBe(0);
  expect(sse.openAgentStream).not.toHaveBeenCalled();
  expect(statusText()).toBe("空闲");
});

it("对照（control）：不带 pilotDraft 挂载 → 输入框量出来就是空串，发送钮维持 disabled", async () => {
  renderBench();
  fireEvent.click(await screen.findByTestId("bench-start"));
  await waitFor(() => expect(callsTo("GET", /^\/api\/v1\/agent\/tools/).length).toBe(1));
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe("");
  expect((screen.getByTestId("bench-send") as HTMLButtonElement).disabled).toBe(true);
});

it("预填是真草稿不是摆设：可编辑、发送钮即刻可用，改一笔再点发送 → POST content 是改后全文", async () => {
  renderBench(PILOT_DRAFT);
  fireEvent.click(await screen.findByTestId("bench-start"));
  await waitFor(() => expect(callsTo("GET", /^\/api\/v1\/agent\/tools/).length).toBe(1));
  const send = screen.getByTestId("bench-send");
  expect((send as HTMLButtonElement).disabled).toBe(false); // draft 有字 → !draft.trim() 门开
  const input = screen.getByTestId("bench-input");
  const edited = PILOT_DRAFT + "\n顺带看下超时配置";
  fireEvent.change(input, { target: { value: edited } });
  expect((input as HTMLTextAreaElement).value).toBe(edited);
  fireEvent.click(send);
  await waitFor(() => expect(statusText()).toBe("运行中"));
  const msgs = callsTo("POST", /^\/api\/v1\/agent\/sessions\/s1\/messages$/);
  expect(msgs.length).toBe(1);
  expect(postBody(msgs[0])).toEqual({ content: edited }); // 逐字 = 用户手改后的全文，不是原始 seed
});

/** 假导航页：[go-pilot] 逐字按发送端契约 nav；[home]/[back] 负责离开与浏览器后退。 */
function NavButton({ testid, to, withDraft, back }:
  { testid: string; to?: string; withDraft?: boolean; back?: boolean }) {
  const nav = useNavigate();
  return (
    <button
      data-testid={testid}
      onClick={() => (back
        ? nav(-1)
        : nav(to!, withDraft ? { state: { pilotDraft: PILOT_DRAFT } } : undefined))}
    />
  );
}

it("注入是一次性的：带草稿挂载 → 离开 → 后退回 /bench 不再倒回同一段草稿（state 已被 replace 清掉）", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="/"
          element={<><NavButton testid="go-pilot" to="/bench" withDraft /><NavButton testid="back" back /></>}
        />
        <Route
          path="/bench"
          element={<><NavButton testid="home" to="/" /><Bench /></>}
        />
      </Routes>
    </MemoryRouter>
  );
  // 第一程：nav 带 pilotDraft 进来 → 注入生效
  fireEvent.click(screen.getByTestId("go-pilot"));
  fireEvent.click(await screen.findByTestId("bench-start"));
  await waitFor(() => expect(callsTo("GET", /^\/api\/v1\/agent\/tools/).length).toBe(1));
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe(PILOT_DRAFT);
  // 离开 /bench（卸载），再走浏览器后退回来：那条 history 条目的 state 必须已被清掉
  fireEvent.click(screen.getByTestId("home"));
  await waitFor(() => expect(screen.queryByTestId("bench-input")).toBeNull());
  fireEvent.click(screen.getByTestId("back"));
  fireEvent.click(await screen.findByTestId("bench-start"));
  await waitFor(() => expect(callsTo("GET", /^\/api\/v1\/agent\/tools/).length).toBe(2));
  // 生产端删掉那行 replace 清 state → 这一行会量到 PILOT_DRAFT（本用例的存在理由）
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe("");
});

// ── 状态标签（bench-status-tag，:176-180）：四色映射 + 标签内含状态节点 ──────
// antd Tag 的 preset/status 色在 jsdom 里落成根节点类名 ant-tag-<color>
// （antd/es/tag/index.js: isPresetColor||isPresetStatusColor 才挂该后缀类）。
// 「default」也是 status 色（未开始 = 灰），四档各钉一类后缀，且互斥——
// 三元链里任何一档换色/掉档都只红对应那步。

const tagNode = () =>
  screen.getByTestId("bench-status-tag").querySelector(".ant-tag") as HTMLElement;

// ── D179 迟到的收尾（世代守卫）──────────────────────────────────────────────
// 把手：cfg.msgGates[i] / cfg.sessionGate 让第 i 条 POST 挂在 promise 上，用例亲手把
// 「回包还在途」这一格按住，再在中间塞 SSE 事件。串行 `await` 的写法表达不出这个洞——
// 那条路上 catch 永远紧跟 setStatus，中间插不进 RUN_END。

let msgIdx = 0; // messages POST 的到达序号（每次请求分配一个世代）
function pending(): { p: Promise<void>; release: () => void } {
  let release = () => {};
  const p = new Promise<void>((r) => { release = r; });
  return { p, release };
}
/** 让「迟到的回包」真的走完 catch：release 只解开 fetch 里那一层 await，后面的 json 解析、
 *  client 的信封判定、catch 里的 setStatus 还排在微任务队上。`await Promise.resolve()` 抽不干
 *  它——断言会在收尾之前跑，两条实现都绿，那是一只永远杀不死变异体的假把手（本文件实测：
 *  这样写的三条用例对 b3/b4/b5 三个变异全部放行）。用几个真实宏任务抽干微任务队（不用假定时器）。 */
async function drain(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}
/** 等「这一轮的回包真的被吃掉并提交了」：认领 run_id 与擦草稿在同一个 then 里，
 *  草稿清空 = 二者都已落 DOM。**不能用 drain 代替**——R31 探针把延迟加在 mock 返回之后，
 *  drain 的 8 个宏任务全跑在应答落地之前，于是「点中断」发生在认领之前，
 *  interrupt() 首行 `if (!runId) return` 一条都不发（本轮实测：两条用例 `expected +0 to be 1`）。
 *  DOM 观察而非内部计数：还要证明 React 已提交，否则 DOM 上挂的 onClick 仍是旧闭包里的 runId。 */
async function waitClaimed(): Promise<void> {
  await waitFor(() => expect(inputVal()).toBe(""));
}
/** 输入 + Ctrl+Enter，只等到请求真的派发出去（不等状态，状态由门决定）。 */
async function sendNow(text: string): Promise<void> {
  const before = callsTo("POST", /\/messages$/).length;
  fireEvent.change(screen.getByTestId("bench-input"), { target: { value: text } });
  fireEvent.keyDown(screen.getByTestId("bench-input"), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("POST", /\/messages$/).length).toBe(before + 1));
}
const inputVal = () => (screen.getByTestId("bench-input") as HTMLTextAreaElement).value;

it("D179｜回包迟到的失败 catch 不许把「等待审批」洗成发起前的空闲：SSE 先挂起、POST 后 400，中断钮全程还在", async () => {
  // 快 run 的 RUN_END 比 POST messages 的 202/400 先到是真序。旧 catch 无条件 setStatus(prev)：
  // prev 是发起那一刻的「空闲」→ 挂起被洗成绿「空闲」、running 变假、屏上唯一出口消失，
  // 用户看着「空闲」却无法中断一个后端仍在等审批的 run。
  const { p, release } = pending();
  cfg.msgGates = [p];
  cfg.messageFails = true; // 门一开就 400（catch 腿的扳机）
  await startSession();
  await sendNow("这轮会挂起");
  expect(statusText()).toBe("运行中");
  sseEmit(0, ev(1, "RUN_END", { status: "WAIT_APPROVAL" }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  expect(screen.queryByTestId("bench-interrupt")).not.toBeNull();
  release(); // 迟到回包落地，catch 此刻才有资格动状态
  await drain();
  expect(statusText()).toBe("等待审批"); // 世代已动：屏上才是更晚的事实
  expect(screen.queryByTestId("bench-interrupt")).not.toBeNull(); // 唯一出口不被迟到的失败拆掉
});

it("D179 正对照｜挂起先于回包时 run_id 仍要照常认领：门开后中断按到本轮 r9", async () => {
  // 反向腿：若把 run_id 也一起锁在同一代上，挂起（不是终态，仍属本轮）会吞掉回包里的 run_id，
  // interrupt() 首行 if (!runId) return 让这个「唯一出口」永远按不动。
  const { p, release } = pending();
  cfg.msgGates = [p];
  cfg.runId = "r9";
  await startSession();
  await sendNow("挂起但回包晚到");
  sseEmit(0, ev(1, "RUN_END", { status: "WAIT_APPROVAL" }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  release();
  // 这条正对照钉的就是「认领会发生」，所以必须先等它发生再按钮：直接按会在慢后端下落到
  // runId 仍为 null 的那一格（本轮探针实测 `expected +0 to be 1`），那测的就不再是世代守卫。
  await waitClaimed();
  fireEvent.click(screen.getByTestId("bench-interrupt"));
  await waitFor(() => expect(callsTo("POST", /interrupt$/).length).toBe(1));
  expect(postBody(callsTo("POST", /interrupt$/)[0])).toEqual({ run_id: "r9" });
  expect(statusText()).toBe("等待审批");
});

it("D179｜卡片回写（sendText）同一条腿：挂起先于回包 + 回包 400，状态与中断钮都不被洗", async () => {
  // sendText 是 send 的双胞胎，守卫必须同时存在，否则「点卡片选项」这条路照样洗状态。
  await startSession();
  await sendMessage("先问一句");
  sseEmit(0, questionEv(2));
  await waitFor(() => expect(screen.getByTestId("question-card")).not.toBeNull());
  pushRunEnd();
  await waitFor(() => expect(statusText()).toBe("空闲"));
  const { p, release } = pending();
  cfg.msgGates = [null, p]; // 第 1 条 = 上面 ungated 的 sendMessage
  fireEvent.click(screen.getAllByTestId("question-option")[0]);
  await waitFor(() => expect(callsTo("POST", /\/messages$/).length).toBe(2));
  cfg.messageFails = true;
  sseEmit(0, ev(3, "RUN_END", { status: "WAIT_APPROVAL" }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  release();
  await drain();
  expect(statusText()).toBe("等待审批"); // 迟到的 400 不许把挂起洗成空闲
  expect(screen.queryByTestId("bench-interrupt")).not.toBeNull();
});

it("D179｜在途窗口里新打的字不许被 send 的 setDraft(\"\") 吃掉：发完只擦自己那份", async () => {
  // 慢发送期间人接着敲了下半句：无条件清空 = 把刚打的字吞进一次他看不见的回包里。
  const { p, release } = pending();
  cfg.msgGates = [p];
  await startSession();
  await sendNow("第一条已经发出去了");
  fireEvent.change(screen.getByTestId("bench-input"), { target: { value: "正在打的第二条" } });
  release();
  await drain(); // 必须抽干：迟到的 setDraft 在 release 之后才跑，waitFor 会在它之前先绿
  expect(inputVal()).toBe("正在打的第二条");
  expect(postBody(callsTo("POST", /\/messages$/)[0])).toEqual({ content: "第一条已经发出去了" });
});

it("D179｜本轮已终态后迟到的 run_id 不许认领：否则下一条消息的中断钮按的是上一轮的 run（后端 404 还被静默吞）", async () => {
  // 上一轮的 run 已经 DONE，迟到的回包还带着它的 id；中断一个已结束的运行 = 404 not_found，
  // 而 interrupt() 的 catch 是静默的 → 用户按下中断却什么都没发生，屏上还写着「运行中」。
  const a = pending();
  const b = pending();
  cfg.msgGates = [a.p, b.p];
  cfg.runIdByCall = ["r上一轮", "r本轮"];
  await startSession();
  await sendNow("第一轮");
  pushRunEnd("DONE", 1); // run 在回包之前就结束了
  await waitFor(() => expect(statusText()).toBe("空闲"));
  a.release(); // 迟到的 r上一轮 此刻才回
  await drain();
  await sendNow("第二轮"); // 本轮「运行中」→ 中断钮出现，它此刻只能用屏上的 runId
  expect(statusText()).toBe("运行中");
  fireEvent.click(screen.getByTestId("bench-interrupt"));
  await drain();
  expect(callsTo("POST", /interrupt$/).length).toBe(0); // 没 id 就一条都不发，更不能按旧 id 发
  b.release(); // 正对照：本轮回包落地后同一个钮按的就是本轮 id
  // 这里绝不能写成「先 waitFor 一条已经成立的 0 再点」——那条 waitFor 第一次轮询就通过，
  // 点击于是赶在认领之前，b7 变异（认领不加守卫）也照样绿。等草稿被这一次发送擦掉 = 认领已提交。
  await waitClaimed();
  fireEvent.click(screen.getByTestId("bench-interrupt"));
  await waitFor(() => expect(callsTo("POST", /interrupt$/).length).toBe(1));
  expect(postBody(callsTo("POST", /interrupt$/)[0])).toEqual({ run_id: "r本轮" });
});

it("D179｜建会话在途时按「重新开始」：这条消息作废——不发消息、不开流、不认领被放弃的会话", async () => {
  const { p, release } = pending();
  cfg.sessionGate = p;
  await startSession();
  const input = screen.getByTestId("bench-input");
  fireEvent.change(input, { target: { value: "发在旧会话上" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("POST", /\/agent\/sessions$/).length).toBe(1));
  fireEvent.click(screen.getByTestId("bench-start")); // 重新开始：世代 +1
  release();
  await drain();
  await drain();
  expect(callsTo("POST", /\/messages$/).length).toBe(0); // 消息不再发往已被放弃的会话
  expect(sse.openAgentStream).not.toHaveBeenCalled(); // 流泄漏 = 每 1.5s 重连风暴
  expect(statusText()).toBe("空闲"); // 迟到的 send 不许把新会话标成运行中
});

it("状态标签底色四态：未开始=default、空闲=green（各档后缀互斥，三元链逐档钉死）", async () => {
  renderBench();
  // 未开始 → 灰（default 档：三元兜底分支被换色的 mutant 在这里红）
  expect(statusText()).toBe("未开始");
  expect(tagNode().className).toContain("ant-tag-default");
  expect(tagNode().className).not.toContain("ant-tag-green");
  expect(tagNode().className).not.toContain("ant-tag-processing");
  expect(tagNode().className).not.toContain("ant-tag-orange");

  fireEvent.click(await screen.findByTestId("bench-start"));
  await waitFor(() => expect(statusText()).toBe("空闲"));
  // 空闲 → 绿（「空闲」档换色/掉档的 mutant 在这里红）
  expect(tagNode().className).toContain("ant-tag-green");
  expect(tagNode().className).not.toContain("ant-tag-default");
  expect(tagNode().className).not.toContain("ant-tag-processing");
  expect(tagNode().className).not.toContain("ant-tag-orange");
});

it("状态标签底色随运行态：运行中=processing、等待审批=orange，且标签内含 bench-status 节点与状态文案", async () => {
  await startSession();
  await sendMessage("跑一轮看看");
  // 运行中 → processing（蓝，动效档）
  expect(tagNode().className).toContain("ant-tag-processing");
  expect(tagNode().className).not.toContain("ant-tag-green");
  expect(tagNode().className).not.toContain("ant-tag-orange");
  expect(tagNode().className).not.toContain("ant-tag-default");
  // 标签不是光杆色块：内层 bench-status 节点必须真在 Tag 里，文案「状态：xx」同屏
  expect(tagNode().contains(screen.getByTestId("bench-status"))).toBe(true);
  expect(tagNode().textContent).toBe("状态：运行中");

  sseEmit(0, ev(9, "RUN_END", { status: "WAIT_APPROVAL" }));
  await waitFor(() => expect(statusText()).toBe("等待审批"));
  // 等待审批 → orange（挂起警示档：三元里掉这档 = 掉进 default 兜底，这里红）
  expect(tagNode().className).toContain("ant-tag-orange");
  expect(tagNode().className).not.toContain("ant-tag-green");
  expect(tagNode().className).not.toContain("ant-tag-processing");
  expect(tagNode().className).not.toContain("ant-tag-default");
  expect(tagNode().contains(screen.getByTestId("bench-status"))).toBe(true);
  expect(tagNode().textContent).toBe("状态：等待审批");
});

// ── D55 判据3：刷新恢复（localStorage 锚点 + GET messages 回放喂 applyEvent + 直播续传）──
// 回放与直播共用同一条 applyEvent（bench.tsx 的 reducer），所以这里钉的是：信封 → event-card
// 与状态机逐字复用直播那套断言；分页逐字（cursor 参数进 URL、next_cursor→下一页、封顶 3 页）；
// 锚点生命周期（建会话写 / 重新开始删 / 历史 404 删）；无键零请求；回放中双发送闸；
// 判据4：回放绝不伪造「运行中」——屏上状态只由事件落定。

const SESSION_LS = "tp.bench.session.p1"; // 按项目键：projectId 改名 = 恢复跨项目串会话，红在这
const MSG_GET = /\/api\/v1\/agent\/sessions\/s1\/messages\?/;
const page = (items: Ev[], next_cursor: string | null) => ({ items, next_cursor });

it("D55｜恢复主腿：键在手 → GET 历史按 next_cursor 翻页（cursor 参数逐字）、信封走同一条 applyEvent 画 event-card、放完开直播流且续传生效、卸载关流", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  cfg.historyPages = [
    page([ev(1, "USER", { text: "历史的一句" }), ev(2, "TOOL_CALL", { tool_name: "create_api_case", args: {} })], "2"),
    page([ev(3, "TEXT", { text: "历史的回答" })], null),
  ];
  renderBench();
  // 三张卡 = 回放信封经 EventCard（与直播同一渲染路）；空态占位被历史顶掉
  await waitFor(() => expect(screen.getAllByTestId("event-card").length).toBe(3));
  expect(screen.getAllByTestId("event-card")[0].textContent).toContain("历史的一句");
  expect(document.body.textContent).not.toContain("发一条消息，看 Pilot 一步步干活");
  // 分页逐字：第一页 cursor=0，下一页 cursor = 上一页的 next_cursor（"2"），且恰好两页
  const urls = callsTo("GET", MSG_GET).map((c) => c.url);
  expect(urls.length).toBe(2);
  expect(urls[0]).toContain("/agent/sessions/s1/messages?cursor=0&size=200");
  expect(urls[1]).toContain("cursor=2");
  // 效果徽标与直播同一张表（loadToolEffects 在恢复路也拉）
  await waitFor(() =>
    expect(screen.getAllByTestId("event-card")[1].textContent).toContain("写入"));
  // 历史放完：认领会话 + 挂直播流（openAgentStream 无 cursor 参数，首连全量重放由 seq 去重消化）
  await waitFor(() => expect(sse.openAgentStream).toHaveBeenCalledTimes(1));
  expect(sse.openAgentStream.mock.calls[0][0]).toBe("s1");
  expect(statusText()).toBe("空闲"); // 历史无终态信封 → 空闲基线，绝不假「运行中」
  // 还在跑的会话：直播事件照常续上（同一个 reducer）
  sseEmit(0, ev(4, "USER", { text: "直播续上来的一句" }));
  await waitFor(() => expect(screen.getAllByTestId("event-card").length).toBe(4));
  cleanup();
  expect(sseHandle(0).close).toHaveBeenCalledTimes(1); // 恢复开的流，卸载必须关
});

it("D55｜分页封顶 3 页：next_cursor 一直给也不许无限翻页（封顶断掉后照常开流收尾）", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  // 三页全带 next_cursor：不限页的实现会去发第 4 页（mock 耗尽恒回空页收敛），GET 计数红它
  cfg.historyPages = [page([ev(1, "USER", { text: "a" })], "1"), page([ev(2, "USER", { text: "b" })], "2"), page([ev(3, "USER", { text: "c" })], "3")];
  renderBench();
  await waitFor(() => expect(sse.openAgentStream).toHaveBeenCalledTimes(1));
  expect(callsTo("GET", MSG_GET).length).toBe(3);
  expect(screen.getAllByTestId("event-card").length).toBe(3);
});

it("D55｜空历史：不画卡、不吵 toast、不编「无历史」字样——屏与今天武装空态逐字同款，流照开", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  // 前序用例迟到的 catch toast（release 之后才挂进全局 .ant-message，比 beforeEach 的
  // message.destroy() 还晚）会漂进本用例：先 drain 让在飞的挂载全部落地，取基线，
  // 再断「本用例没新增任何 toast」——空历史该静默，多一个字的 toast 都红。
  await drain();
  const baseline = toastText();
  renderBench();
  await waitFor(() => expect(sse.openAgentStream).toHaveBeenCalledTimes(1));
  expect(callsTo("GET", MSG_GET).length).toBe(1);
  expect(screen.queryAllByTestId("event-card").length).toBe(0);
  expect(toastText()).toBe(baseline);
  expect(baseline).not.toContain("会话不存在"); // 空历史更不该有已删措辞（基线本身来自失败用例，不含恢复措辞）
  expect(document.body.textContent).not.toContain("无历史");
  expect(document.body.textContent).toContain("发一条消息，看 Pilot 一步步干活"); // 既有空态原样
  expect(statusText()).toBe("空闲");
});

it("D55｜会话已删（历史 404）：清键、silent 不吵 toast、退回未武装全新屏、不开流；非 404 失败不清键", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  cfg.historyStatus = 404;
  renderBench();
  await waitFor(() => expect(localStorage.getItem(SESSION_LS)).toBeNull()); // 锚点作废即清
  await waitFor(() => expect(statusText()).toBe("未开始"));
  expect(toastText()).not.toContain("会话不存在"); // silent:true —— 已删是设计内分支，不许 client 抢弹
  expect(sse.openAgentStream).not.toHaveBeenCalled(); // 没会话没流
  expect(screen.queryByTestId("bench-input")).toBeNull(); // 全新未武装屏
  expect(callsTo("GET", MSG_GET).length).toBe(1); // 只试了一页就收手
});

it("D55｜非 404 的历史失败（500）：键保留（没拿到 ≠ 已删除），屏退回全新但不谎称已删", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  cfg.historyStatus = 500;
  renderBench();
  await waitFor(() => expect(statusText()).toBe("未开始"));
  expect(localStorage.getItem(SESSION_LS)).toBe("s1"); // 下次刷新还能救
  expect(sse.openAgentStream).not.toHaveBeenCalled();
});

it("D55｜无键 = 零请求：挂载不发任何 messages GET、不开流，屏与今天逐字相同（恢复腿整体不存在）", async () => {
  renderBench();
  await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/projects?size=200")).toBe(true));
  await drain(); // 给恢复腿（若有）抽干派发窗口，再数才是「一条都没发」
  expect(callsTo("GET", /\/messages/).length).toBe(0);
  expect(sse.openAgentStream).not.toHaveBeenCalled();
  expect(statusText()).toBe("未开始");
  expect(screen.queryByTestId("bench-input")).toBeNull();
});

it("D55｜持久化生命周期：会话建成即写按项目键；「重新开始」清键（旧会话不许刷新还魂）", async () => {
  await startSession();
  expect(localStorage.getItem(SESSION_LS)).toBeNull(); // 只武装没建会话 = 没有锚点
  await sendMessage("建会话的一句话");
  expect(localStorage.getItem(SESSION_LS)).toBe("s1"); // 建成即落盘（sendMessage 等到「运行中」= setItem 之后）
  pushRunEnd();
  await waitFor(() => expect(statusText()).toBe("空闲"));
  fireEvent.click(screen.getByTestId("bench-start")); // 重新开始
  expect(localStorage.getItem(SESSION_LS)).toBeNull(); // 放弃 = 清锚点
});

it("D55｜回放中双发送闸：状态槽「正在回放历史…」、按钮 disabled、Ctrl+Enter 零发送、草稿不吞；回放完成闸开可正常发送", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  const { p, release } = pending();
  cfg.historyGate = p;
  cfg.historyPages = [page([ev(1, "USER", { text: "历史的一句" })], null)];
  renderBench();
  // 回放进行中：输入区可见（armed 即开）但闸着——不让人把消息插进半截时间线
  const input = await screen.findByTestId("bench-input");
  expect(statusText()).toBe("正在回放历史…");
  expect(statusText()).not.toBe("运行中"); // 判据4：回放不是运行，绝不伪造
  fireEvent.change(input, { target: { value: "回放中想插一句" } });
  expect((screen.getByTestId("bench-send") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId("bench-send"));
  fireEvent.keyDown(screen.getByTestId("bench-input"), { key: "Enter", ctrlKey: true });
  expect(callsTo("POST", /\/messages$/).length).toBe(0); // 按钮 + 快捷键两条路都拦死
  expect((screen.getByTestId("bench-input") as HTMLTextAreaElement).value).toBe("回放中想插一句"); // 拦≠吞
  release();
  await waitFor(() => expect(statusText()).toBe("空闲")); // 闸开
  fireEvent.click(screen.getByTestId("bench-send")); // 复用既有会话发出去（不重建会话）
  await waitFor(() => expect(callsTo("POST", /\/agent\/sessions\/s1\/messages$/).length).toBe(1));
  expect(callsTo("POST", /^\/api\/v1\/agent\/sessions$/).length).toBe(0);
});

it("D55｜判据4 状态诚实：历史里的 WAIT_APPROVAL 终态由 applyEvent 落「等待审批」，回放途中槽位不是「运行中」", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  const { p, release } = pending();
  cfg.historyGate = p;
  cfg.historyPages = [page([
    ev(1, "USER", { text: "改库结构" }),
    ev(2, "APPROVAL_REQ", { tool_name: "create_api_case", args: {} }),
    ev(3, "RUN_END", { status: "WAIT_APPROVAL" }),
  ], null)];
  renderBench();
  await screen.findByTestId("bench-input");
  expect(statusText()).toBe("正在回放历史…"); // 在途那一格也不演「运行中」
  release();
  await waitFor(() => expect(statusText()).toBe("等待审批")); // 状态只由历史事件落定
  expect(screen.getByTestId("approval-card")).not.toBeNull(); // 审批卡与直播同款
});

it("D55｜回放途中按「重新开始」：历史作废——不开流、不上屏、锚点已清、新屏干净", async () => {
  localStorage.setItem(SESSION_LS, "s1");
  const { p, release } = pending();
  cfg.historyGate = p;
  cfg.historyPages = [page([ev(1, "USER", { text: "不该出现的旧历史" })], null)];
  renderBench();
  await screen.findByTestId("bench-input");
  fireEvent.click(screen.getByTestId("bench-start")); // 重新开始（回放中 running=false，钮可用）
  release(); // 迟到的历史回包此刻才落地：世代已动，没有上屏资格
  await drain();
  expect(sse.openAgentStream).not.toHaveBeenCalled();
  expect(screen.queryAllByTestId("event-card").length).toBe(0);
  expect(statusText()).toBe("空闲"); // start() 落的基线不被迟到回放改写
  expect(localStorage.getItem(SESSION_LS)).toBeNull();
});

// ── 会话流改版（2026-11-21）：一次工具 = 一行 chip + 右栏只用事件流真数据 ──────────
// 这里钉的是「集成后仍然成立」的两件事：渲染侧两层合流没动 applyEvent（seq 去重、
// 世代闸、状态机全部原样），以及右栏那两个读数与事件流同源——事件没说过的一律不上屏。

it("改版｜一次工具的两条信封只画一行 chip，结果回来就地补成败", async () => {
  await startSession();
  await sendMessage("建个接口");
  sseEmit(0, ev(2, "TOOL_CALL", { tool_name: "create_api_case", args: { a: 1 }, tool_call_id: "c1" }));
  await waitFor(() => expect(screen.getAllByTestId("event-card").length).toBe(1));
  expect(screen.getByTestId("event-card").textContent).toContain("执行中");
  sseEmit(0, ev(3, "TOOL_RESULT", { tool_name: "create_api_case", ok: true, tool_call_id: "c1", content: { id: "x" } }));
  // 仍是 1 张：结果并进同一行，而不是另起一张「结果」卡
  await waitFor(() => {
    const cards = screen.getAllByTestId("event-card");
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain("成功");
  });
  expect(screen.queryByTestId("tool-pending")).toBeNull();
  expect(screen.queryByTestId("event-kind")).toBeNull(); // 大写徽标整块下线
});

it("改版｜右栏计数与事件流同源：调用数/失败数/产出条目都随事件长", async () => {
  await startSession();
  await sendMessage("建两个接口");
  // 起手：右栏存在但两个读数都是零——没有「未知」也没有假数字
  expect(screen.getByTestId("bench-side-progress").textContent).toContain("工具调用 0 次");
  expect(screen.getByTestId("bench-side-produced-empty")).toBeTruthy();

  sseEmit(0, ev(2, "TOOL_CALL", { tool_name: "create_api_case", args: {}, tool_call_id: "c1" }));
  sseEmit(0, ev(3, "TOOL_RESULT", {
    tool_name: "create_api_case", ok: true, tool_call_id: "c1",
    content: { id: "d1" }, produced: [{ kind: "api_definition", id: "d1", name: "查询订单" }],
  }));
  await waitFor(() => expect(screen.getByTestId("bench-side-produced").textContent).toContain("接口定义 · 查询订单"));
  expect(screen.getByTestId("bench-side-progress").textContent).toContain("工具调用 1 次");
  // 产出条目有真路由：接口定义落 #/api?def=<id>（后端 produced[].link 的 /api/definition/ 前端没有）
  const link = screen.getByTestId("bench-side-produced").querySelector("a");
  expect(link?.getAttribute("href")).toBe("#/api?def=d1");
  // 同一资源第二次被动过（update）不重复列
  sseEmit(0, ev(4, "TOOL_RESULT", {
    tool_name: "create_api_case", ok: false, tool_call_id: "c1", error: "炸了",
    produced: [{ kind: "api_definition", id: "d1", name: "查询订单" }],
  }));
  await waitFor(() => expect(screen.getByTestId("bench-side-progress").textContent).toContain("失败 1"));
  expect(screen.getByTestId("bench-side-produced").querySelectorAll("div").length).toBe(1);
});

it("改版｜无直达路由的产出（成员）画成不可点的文本行，不给假链接", async () => {
  await startSession();
  await sendMessage("导入成员");
  sseEmit(0, ev(2, "TOOL_RESULT", {
    tool_name: "user_import", ok: true, content: {},
    produced: [{ kind: "user", id: "u1", name: "第 1 行 甲" }],
  }));
  await waitFor(() => expect(screen.getByTestId("bench-side-produced").textContent).toContain("成员 · 第 1 行 甲"));
  expect(screen.getByTestId("bench-side-produced").querySelector("a")).toBeNull();
});

it("改版｜USAGE 累计进右栏，ts 不可用时「更新于」画破折号而不是当前时间", async () => {
  await startSession();
  await sendMessage("看看就好");
  // ts 空串 = 信封没带可用时刻（Ev 类型里 ts 恒有值，这里造的就是「有字段但读不出时刻」那一档）
  sseEmit(0, { ...ev(2, "USAGE", { input_tokens: 12, output_tokens: 4 }), ts: "" });
  await waitFor(() => expect(screen.getByTestId("bench-side-progress").textContent).toContain("入 12 / 出 4"));
  expect(screen.getByTestId("bench-side-progress").textContent).toContain("更新于 —");
});

it("改版｜三个会话参数仍在（搬进输入区工具条不改 testid/锁定口径），会话建成后锁死", async () => {
  await startSession();
  expect(selectDisabled("bench-mode-select")).toBe(false);
  expect(selectDisabled("bench-thinking-select")).toBe(false);
  await openSelect("bench-mode-select");
  await clickOption("询问（ASK）");
  await sendMessage("问一句");
  // 参数逐字进建会话请求（搬到输入区工具条之后契约不变）
  expect(postBody(callsTo("POST", /^\/api\/v1\/agent\/sessions$/)[0])).toMatchObject({ mode: "ASK" });
  pushRunEnd();
  await waitFor(() => expect(selectDisabled("bench-mode-select")).toBe(true));
  expect(selectDisabled("bench-thinking-select")).toBe(true);
});

it("改版｜汇总 pill 只在真改动过资源时出现，读数是产出数 + 调用数", async () => {
  await startSession();
  await sendMessage("看看环境就好");
  // 只读一轮：pill 整块不出现（摆一个「已改动 0 个资源」等于宣布一件没发生的事）
  sseEmit(0, ev(2, "TOOL_CALL", { tool_name: "search_tools", args: {}, tool_call_id: "c1" }));
  sseEmit(0, ev(3, "TOOL_RESULT", { tool_name: "search_tools", ok: true, tool_call_id: "c1", content: {} }));
  await waitFor(() => expect(screen.getByTestId("bench-side-progress").textContent).toContain("工具调用 1 次"));
  expect(screen.queryByTestId("bench-summary-pill")).toBeNull();
  // 真产出一次 → pill 出现，两个读数与右栏同源（同一个 produced/toolCalls，不是第二份计数）
  sseEmit(0, ev(4, "TOOL_CALL", { tool_name: "create_api_case", args: {}, tool_call_id: "c2" }));
  sseEmit(0, ev(5, "TOOL_RESULT", {
    tool_name: "create_api_case", ok: true, tool_call_id: "c2",
    content: { id: "d1" }, produced: [{ kind: "api_definition", id: "d1", name: "查询订单" }],
  }));
  await waitFor(() => expect(screen.getByTestId("bench-pill-produced").textContent).toBe("已改动 1 个资源"));
  expect(screen.getByTestId("bench-pill-tools").textContent).toBe("工具调用 2 次");
  expect(screen.getByTestId("bench-side-progress").textContent).toContain("工具调用 2 次");
});
