// 环境管理面（§7.5 分层变量）此前全仓库唯一的引用断言是 PermEmpty.test.tsx:23 借 GlobalConfig
// 证明它自己的 403 空页——环境 CRUD（新建/保存/删除/默认选中/全局配置保存）零断言，
// 删掉 post("/envs") 八道门禁照样全绿（1G 台账 D63/D112 同类的「有实现、无测试」面）。
// 钉十二条契约（字段名/词表/动词以后端为准，逐条给 file:line，不照前端猜）：
// ① 列表 GET /envs?project_id&size=200（路由 services.py:45，Page 信封 api.ts:76，
//    /api/v1 前缀 client.ts:77）；后端只按 id 游标排（services.py:54 注释「position 由前端
//    排序」）→ sortEnvs 按 position 再 name；value===null 时默认选中排序后第一条。
// ② 过期 value：不在列表里的 value 必须被换掉（EnvPanel.tsx:74），空列表则落 null。
// ③ 新建 → POST /envs（services.py:22）body 逐字 = EnvCreateIn（schemas.py:9-13，
//    name 前端 maxLength=200 镜像 max_length=200）；新建位 position=现有最大值+1
//    （EnvPanel.tsx:200）；toPairs 丢空 key 行并 trim key（EnvPanel.tsx:18）；
//    成功 = onSelect(返回行 id) + toast「环境已创建并选中」+ 重拉。
// ④ config.timeout_ms 留空不发键、填了才发（EnvPanel.tsx:132；后端 config 是自由 dict，
//    schemas.py:13，resolve 侧只认 >0 的整数 services.py:186）。
//    ④c 超时 Tooltip 口径=后端门槛：仅当请求不带 timeout_ms 键时才套用环境超时
//    （api_test/services.py:383/399/426 explicit_timeout），而编辑器保存的请求总带该键
//    （RequestEditor.tsx:40/70、req.ts:77）→ 旧句「留空用请求自己的超时」恒不触发，是假话。
// ⑤ draft.id 存在 → PATCH /envs/{id}（services.py:66，不是 POST）；body 不带 env_id 是对的：
//    路由投影把路径参数注入并覆盖 body（service.py:324-332，_BODY_METHODS service.py:280）；
//    toast 走「环境已保存」分支（EnvPanel.tsx:135，与 ③ 的 toast 是两条不同分支）。
// ⑥ 环境名留空 → toast「环境名必填」且 POST/PATCH 一条不发：早返回在 setSaving 之前
//    （EnvPanel.tsx:128）。
// ⑦ 删除确认 → DELETE /envs/{id} body {project_id}（services.py:92 + EnvDeleteIn
//    schemas.py:30；env_id 同上走 path）；toast「已删除」+ 重拉；删掉的是当前选中 →
//    选中落到重拉后排序第一条（EnvPanel.tsx:155）。
//    ⑦b 二确文案讲真话：env 删除是硬删无级联无改绑（env/services.py `await ctx.db.delete(e)` = 192），ui_test
//    models.py:81 / scenario models.py:37 / schedule models.py:45 的 env_id 都会悬空，
//    运行期经 resolve_env 404「环境不存在」（env/services.py:267，在 `async def resolve_env` 内；
//    调试端点 env_resolve（:285）只是把同一个 resolve_env 包了一层，报的是同一条。
//    ⚠ 该文件有三处 raise「环境不存在」：143 / 169 / 267，**只有 resolve_env 那条是运行期** ——
//    别照行号点，行号一漂就指到 env_delete 的引用检测上，读的人会以为是删环境时报的 404）——旧句
//    「接口与用例不受影响」在共用本组件的 uiCaseDetail 页是假话，新句点名失效面。
// ⑧ Modal.confirm 里点[取消] = 一条请求都不发，也不偷偷重拉。
// ⑨ 只读把手（§11.5.1：读态是「藏」不是「禁」）：canManage=false → 行内删除钮消失；
//    canCreate=false → [新建环境]消失；两者皆关 → [保存环境]消失（(canCreate||canManage)
//    分支 EnvPanel.tsx:225），canManage 单独为真时保存钮仍在。
// ⑩ GlobalConfig POST /envs/global-config（services.py `async def global_config_update` = 223；
//    ⚠ 别引 :131 —— 那行现在是另一个端点的 `name="env_update"`）body 逐字
//    {project_id, scope_type, items}，scope_type 走 GlobalConfigUpdateIn.pattern 的词表
//    ^(VAR|HEADER|ASSERT|EXTRACT)$（schemas.py:45；四作用域 SCOPES services.py:197 = 顶格 `^SCOPES`；
//    ⚠ 别引 :108 —— 那行是另一个端点 env_list 注册块里的 perm）；
//    ASSERT+EXTRACT 条数提示行「已保存 N 条全局断言/提取配置（存而未用…）」：执行侧
//    resolve_env 只读 VAR/HEADER（env/services.py:255/258，在 `async def resolve_env` 内），models.py:21 自述「存而不用」，
//    旧句「1B 执行链路生效」是假话；条数仍是真数，必须保留；保存后必重拉
//    （GET services.py `async def global_config_get` = 206，GlobalConfigOut.scopes schemas.py:49-50。
//    ⚠ 别引 :114 —— 那行是 `async def env_list`，本仓有 10 个 services.py，
//    只写 basename 的引用连普查都判不了「指哪个文件」）。
// ⑪ GlobalConfig 的 PairTable 接线：ro={!canManage}（EnvPanel.tsx:301）——只读时输入框
//    disabled 且保存钮消失；idPrefix 隔离（gvar/ghdr vs env-var/env-header），
//    环境 Tab 与全局 Tab 同屏时定位互不串。PairTable 自身行为在
//    RequestEditor.test.tsx，不在此重复；PermEmpty.test.tsx:112 已钉 403 空页，也不重复。
// ⑫ /envs 取失败 ≠ 没有环境：placeholder 与下拉旁提示都要改口（对齐 scenes.tsx:630-637
//    已发货的三态形状），管理窗同一份空列表也不许再喊「还没有环境」（EnvPanel.tsx:179 旧态）；
//    失败不是永久定性：load 成功一次必须把失败态清掉（EnvPanel.tsx:65-67 旧 catch 只吞不标）。
// ⑬ 保存后的重拉不许吃掉等待里敲的那半行（EnvPanel.tsx:296 editGen）：POST 在途到回灌落地
//    这一格里 PairTable 仍可编辑，无条件 setVars/setHeaders 会把「屏上的」换成「服务器旧的」。
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, Modal, message } from "antd";
import EnvSelect, { GlobalConfig } from "./EnvPanel";
import type { EnvRow } from "./api";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// 乱序喂进去：sortEnvs 必须洗成 alpha(p0) → aaa(p1,name 序) → beta(p1)
const E1: EnvRow = { id: "e1", project_id: "p1", name: "alpha", position: 0,
  config: { vars: [["k1", "v1"]], headers: [], timeout_ms: 3000 } };
const E2: EnvRow = { id: "e2", project_id: "p1", name: "beta", position: 1, config: null };
const E3: EnvRow = { id: "e3", project_id: "p1", name: "aaa", position: 1, config: {} };
const PAGE1: EnvRow[] = [E2, E1, E3];
const CREATED: EnvRow = { id: "e9", project_id: "p1", name: "新环境", position: 2, config: {} };

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

interface Call { url: string; method: string; body?: string }
type Resp = { status: number; body: unknown };

/** pages/globalResp 是「该端点第 1/2/… 次请求的回执」序列（耗尽后停在最后一项）：
 * 「删完再拉要给出剩余列表」这条契约要求列表桩能按次序变脸。 */
function mockBackend(over: {
  pages?: EnvRow[][];
  pagesFail?: number[];
  createResp?: Resp[];
  // 409 in_use 的回执（D139）：删除被引用拦下时后端带逐域清单，前端要点名
  deleteResp?: Resp[];
  globalScopes?: Record<string, unknown>;
  globalPostResp?: Resp[];
  globalResp?: Resp[];
  // 第 N 次 GET global-config 挂在这个 promise 上（按到达序取，缺省不挂）：
  // 「保存后的重拉在途」这一格用普通跑法量不到——回包总是立刻落地。
  globalGate?: (Promise<void> | undefined)[];
} = {}): Call[] {
  const calls: Call[] = [];
  const take = (seq: Resp[] | undefined, i: number, okBody: Resp): Resp =>
    seq && i < seq.length ? seq[i] : okBody;
  let nList = 0;
  let nTry = 0;
  let nCreate = 0;
  let nDel = 0;
  let nGPost = 0;
  let nGGet = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    if (url.startsWith("/api/v1/envs/global-config")) {
      if (method === "GET") {
        const gate = over.globalGate?.[nGGet];
        if (gate) await gate;
        const okBody = { scopes: over.globalScopes ?? { VAR: [], HEADER: [], ASSERT: [], EXTRACT: [] } };
        const r = take(over.globalResp, nGGet++, { status: 200, body: okBody });
        return res(r.status, r.body);
      }
      const r = take(over.globalPostResp, nGPost++, { status: 200, body: { ok: true } });
      return res(r.status, r.body);
    }
    if (method === "GET" && url.startsWith("/api/v1/envs?")) {
      // pagesFail 列出的第 N 次「列表请求」（1 起）回 500；成功次数单独计数，
      // pages 序列按成功序取——失败不消耗 pages 槽位。
      nTry++;
      if (over.pagesFail?.includes(nTry)) {
        return res(500, { code: "http_500", message: "boom" });
      }
      const seq = over.pages ?? [PAGE1];
      const items = seq[Math.min(nList, seq.length - 1)];
      nList++;
      return res(200, { items, next_cursor: null }); // Page<EnvRow> 信封（api.ts:76）
    }
    if (method === "POST" && url === "/api/v1/envs") {
      const r = take(over.createResp, nCreate++, { status: 201, body: CREATED });
      return res(r.status, r.body);
    }
    if (method === "PATCH" && /^\/api\/v1\/envs\/[^/]+$/.test(url)) {
      return res(200, E1);
    }
    if (method === "DELETE" && /^\/api\/v1\/envs\/[^/]+$/.test(url)) {
      const r = take(over.deleteResp, nDel++, { status: 200, body: { ok: true } });
      return res(r.status, r.body);
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

const listGets = (c: Call[]) => c.filter((x) => x.method === "GET" && x.url.startsWith("/api/v1/envs?"));
const envPosts = (c: Call[]) => c.filter((x) => x.method === "POST" && x.url === "/api/v1/envs");
const envPatches = (c: Call[]) => c.filter((x) => x.method === "PATCH" && x.url.startsWith("/api/v1/envs/"));
const envDels = (c: Call[]) => c.filter((x) => x.method === "DELETE" && x.url.startsWith("/api/v1/envs/"));
const gGets = (c: Call[]) => c.filter((x) => x.method === "GET" && x.url.startsWith("/api/v1/envs/global-config"));
const gPosts = (c: Call[]) => c.filter((x) => x.method === "POST" && x.url.startsWith("/api/v1/envs/global-config"));

function toastText(): string {
  return Array.from(document.querySelectorAll(".ant-message")).map((n) => n.textContent).join("|");
}

/** 受控包装：真实页面（pages/api.tsx:337、pages/uiCaseDetail.tsx:207）都是 state 驱动，
 * 默认选中/删除回落都要靠 onChange 回灌才看得见——sel 把当前 value 摊到 DOM 上断言。 */
function Harness({ initial = null, canManage = true, canCreate = true, headersApply, pid = "p1" }: {
  initial?: string | null; canManage?: boolean; canCreate?: boolean; headersApply?: boolean; pid?: string;
}) {
  const [v, setV] = useState<string | null>(initial);
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <span data-testid="sel">{v === null ? "null" : v}</span>
      <EnvSelect projectId={pid} value={v} onChange={setV}
        canManage={canManage} canCreate={canCreate} headersApply={headersApply} />
    </ConfigProvider>
  );
}

const selText = () => screen.getByTestId("sel").textContent;

/** motion:false 同 UsersTab.test.tsx:84-93：jsdom 里 rc-motion 的动画不完成，
 * Modal 的开/关断言会失真。 */
async function openManager() {
  fireEvent.click(screen.getByTestId("env-manage"));
  await screen.findByTestId("env-close");
}

/** 先等列表真的落进下拉（选中项 label 画进 .ant-select-selection-item），再开管理窗：
 * EnvManager 的 draft 只在 open 翻转那一刻按当时的 envs 快照生成（EnvPanel.tsx:118-123），
 * 抢在列表返回前开窗会冻结出 blankEnv 兜底，「打开即回填选中环境」就测不到了。 */
async function openManagerLoaded() {
  await screen.findByText("alpha", { selector: ".ant-select-selection-item" });
  await openManager();
}

/** antd InputNumber 的 data-* 落点可能是 wrapper（同 RequestEditor.test.tsx:160-162）。 */
function typeNumber(testId: string, value: string): void {
  const node = screen.getByTestId(testId);
  const input = node.tagName === "INPUT" ? node : node.querySelector("input")!;
  fireEvent.change(input, { target: { value } });
}

/** 同上落点不确定性，但要拿住 input 元素本体读 value / 后续 fireEvent。 */
function numInputLike(testId: string): HTMLInputElement {
  const node = screen.getByTestId(testId);
  return (node.tagName === "INPUT" ? node : node.querySelector("input")) as HTMLInputElement;
}

/** antd 两字按钮自动空格成「删 除」「取 消」（UsersTab.test.tsx:242 同款正则容忍）。 */
async function modalButton(re: RegExp) {
  return screen.findByRole("button", { name: re }, { timeout: 2000 });
}

beforeEach(() => {
  cleanup();
  message.destroy();
  // Modal.confirm 的二确挂在 body 上自己的 root 里，不归 RTL 容器管（cleanup 拆不掉）：
  // 上一用例残留的「删除环境？」会让本用例的 findByText 撞 multiple elements。
  Modal.destroyAll();
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
});

// 注意顺序：destroy 必须在 cleanup 之后各来一次收尾——把 DOM 从 body 上直接抹掉会
// 让 antd 的 message/confirm 复用已断开的容器，后续用例的 toast 就永远查不到。
afterEach(() => {
  cleanup();
  message.destroy();
  Modal.destroyAll();
  // jsdom 里 rc-motion 的 leave 不完成，destroyAll 之后 confirm 的 .ant-modal-root
  // 仍挂在 body 上；只拆这些残留根节点（不动 message 的容器），否则下一条用例的
  // 二确按钮会命中上一用例没走[取消]路径的窗。
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
});

describe("① 列表拉取口径 + sortEnvs + 默认选中", () => {
  it("GET /envs?project_id=p1&size=200；乱序进列表出 alpha→aaa→beta；value=null 自动选中排序第一条", async () => {
    const calls = mockBackend();
    render(<Harness />);
    await waitFor(() => expect(selText()).toBe("e1"));
    expect(listGets(calls)[0].url).toBe("/api/v1/envs?project_id=p1&size=200");
    await openManagerLoaded();
    const names = (await screen.findAllByTestId("env-item")).map((n) => n.textContent);
    // position 优先，同 position 按 name 字典序（EnvPanel.tsx:19）
    expect(names[0]).toContain("alpha");
    expect(names[1]).toContain("aaa");
    expect(names[2]).toContain("beta");
    expect(screen.getAllByText("当前").length).toBe(1); // 选中项画「当前」标
  });
});

describe("①b 环境下拉 Tooltip 按宿主分裂（EnvPanel.tsx:81）", () => {
  it("默认宿主承诺「变量与公共请求头来自这里」；headersApply=false（UI 用例页）只承诺变量并点名不注入公共请求头", async () => {
    // WHY UI 侧必须改口：UI 环境桥只留 vars/env_name（ui_test/debug_services.py:139-140），
    // EnvResolveOut.headers 被丢弃（env/schemas.py:58-60），ui_core.py 全文零 header 概念——
    // 公共请求头在 UI 运行里是零效果配置，旧句在 uiCaseDetail 页（:207 挂同一组件）是假话。
    const visibleTips = () => Array.from(
      document.querySelectorAll(".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner"),
    ).map((n) => n.textContent).join("|");

    mockBackend();
    const { unmount } = render(<Harness initial="e1" />);
    await screen.findByText("alpha", { selector: ".ant-select-selection-item" });
    const node = screen.getByTestId("env-select");
    fireEvent.mouseOver(node);
    fireEvent.mouseEnter(node);
    await waitFor(() => {
      expect(visibleTips()).toContain("调试时使用的环境：变量与公共请求头来自这里");
    }, { timeout: 4000 });
    unmount();

    mockBackend();
    render(<Harness initial="e1" headersApply={false} />);
    await screen.findByText("alpha", { selector: ".ant-select-selection-item" });
    const node2 = screen.getByTestId("env-select");
    fireEvent.mouseOver(node2);
    fireEvent.mouseEnter(node2);
    await waitFor(() => {
      expect(visibleTips()).toContain("UI 运行只取这里的变量：UI 执行核没有请求头概念，公共请求头不会注入");
    }, { timeout: 4000 });
    expect(visibleTips()).not.toContain("变量与公共请求头来自这里");
  });
});

describe("② 过期 value 的替换", () => {
  it("value 指向已不存在的环境 → 换成排序第一条", async () => {
    mockBackend();
    render(<Harness initial="zzz" />);
    await waitFor(() => expect(selText()).toBe("e1"));
  });

  it("列表为空 + 过期 value → 落 null（不能悬着一个查无此 id）", async () => {
    mockBackend({ pages: [[]] });
    render(<Harness initial="zzz" />);
    await waitFor(() => expect(selText()).toBe("null"));
  });
});

describe("③ 新建环境", () => {
  it("[新建环境] position=现有最大+1；POST /envs body 逐字 EnvCreateIn：空 key 行丢弃、key 去空白、timeout 留空不发键；成功=选中返回 id + toast + 重拉", async () => {
    const calls = mockBackend();
    render(<Harness initial="e1" />);
    await waitFor(() => expect(selText()).toBe("e1"));
    await openManagerLoaded();
    fireEvent.click(await screen.findByTestId("env-new"));
    await screen.findByTestId("env-name");
    fireEvent.change(screen.getByTestId("env-name"), { target: { value: "新环境" } });
    fireEvent.change(screen.getByTestId("env-var-key-0"), { target: { value: "  base_url  " } });
    fireEvent.change(screen.getByTestId("env-var-val-0"), { target: { value: "http://127.0.0.1:9999" } });
    fireEvent.click(screen.getByTestId("env-var-add")); // 追加的空行必须被 toPairs 丢掉
    const getsBefore = listGets(calls).length;
    fireEvent.click(screen.getByTestId("env-save"));

    await waitFor(() => expect(envPosts(calls).length).toBe(1));
    const body = JSON.parse(envPosts(calls)[0].body!);
    // 字段名逐字对齐 EnvCreateIn（schemas.py:9-13）；e1 是 name 输入框的来路（draftFrom），
    // 新建位 position=2 = max(0,1,1)+1（EnvPanel.tsx:200）
    expect(body).toEqual({
      project_id: "p1", name: "新环境", position: 2,
      config: { vars: [["base_url", "http://127.0.0.1:9999"]], headers: [] },
    });
    expect("timeout_ms" in body.config).toBe(false); // 留空不发键（不是 null、不是 0）
    await waitFor(() => expect(toastText()).toContain("环境已创建并选中"));
    await waitFor(() => expect(selText()).toBe("e9")); // onSelect(后端返回行 id)，不是本地猜
    await waitFor(() => expect(listGets(calls).length).toBe(getsBefore + 1)); // 落库必重拉
  });
});

describe("④ config.timeout_ms", () => {
  it("超时填 3000 → POST body 的 config 带 timeout_ms:3000（填了才发）", async () => {
    const calls = mockBackend();
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    fireEvent.click(await screen.findByTestId("env-new"));
    fireEvent.change(screen.getByTestId("env-name"), { target: { value: "T" } });
    typeNumber("env-timeout", "3000");
    fireEvent.click(screen.getByTestId("env-save"));
    await waitFor(() => expect(envPosts(calls).length).toBe(1));
    const body = JSON.parse(envPosts(calls)[0].body!);
    expect(body.config.timeout_ms).toBe(3000);
  });

  it("超时 Tooltip 钉后端门槛口径：悬浮浮出「仅对未自带超时的请求生效…编辑器外创建」，不承诺留空兜底", async () => {
    // WHY 断言这句而非旧句：explicit_timeout 门槛（api_test/services.py:383/399/426）让
    // 「留空用请求自己的超时」对本 UI 保存的请求恒不成立（RequestEditor.tsx:40/70 总写键）。
    mockBackend();
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    const node = screen.getByTestId("env-timeout");
    fireEvent.mouseOver(node);
    fireEvent.mouseEnter(node);
    const visibleTips = () => Array.from(
      document.querySelectorAll(".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner"),
    ).map((n) => n.textContent).join("|");
    await waitFor(() => {
      expect(visibleTips()).toContain(
        "仅对未自带超时的请求生效；本编辑器保存的请求总自带超时，这里实际作用于编辑器外（如 Agent）创建的请求");
    }, { timeout: 4000 });
    expect(visibleTips()).not.toContain("留空用请求自己的超时");
  });
});

describe("④b env-position（EnvPanel.tsx:216-218）：回填、# 前缀、写入草稿、null 落 0", () => {
  it("打开管理窗：env-position 回填 draft.position（alpha=0）、addonBefore 画 #；改 7 → PATCH body position:7", async () => {
    const calls = mockBackend();
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    const pos = numInputLike("env-position");
    expect(pos.value).toBe("0"); // draftFrom(alpha).position=0 原样回填
    // addonBefore="#"：rc-input-number 的 testid 落点（wrapper/input）是版本细节，
    // 故向上找组容器（closest 含自身）再查 addon 节点，不押死 antd 内部类名全称。
    const node = screen.getByTestId("env-position");
    const grp = (node.closest("[class*='group-wrapper']")
      ?? node.querySelector("[class*='group-wrapper']") ?? document.body) as HTMLElement;
    const addons = Array.from(grp.querySelectorAll("[class*='group-addon']")).map((n) => n.textContent);
    expect(addons).toContain("#");

    fireEvent.change(pos, { target: { value: "7" } });
    fireEvent.click(screen.getByTestId("env-save"));
    await waitFor(() => expect(envPatches(calls).length).toBe(1));
    // position 真进了 PATCH body（EnvPanel.tsx:134），不是只停在组件内部
    expect(JSON.parse(envPatches(calls)[0].body!).position).toBe(7);
  });

  it("清空输入（onChange 收到 null）→ Number(v ?? 0) 落 0：PATCH body position 归零而不是 null", async () => {
    // beta 的 position=1：清空后 body 必须是 0（?? 0 守卫后 Number 归零），不是 null
    const calls = mockBackend();
    render(<Harness initial="e2" />);
    await screen.findByText("beta", { selector: ".ant-select-selection-item" });
    await openManager();
    // draft 由选中项（e2/beta）生成：position 回填 1
    const pos = numInputLike("env-position");
    await waitFor(() => expect(pos.value).toBe("1"));
    fireEvent.change(pos, { target: { value: "" } }); // rc-input-number 清空 → onChange(null)
    fireEvent.click(screen.getByTestId("env-save"));
    await waitFor(() => expect(envPatches(calls).length).toBe(1));
    expect(envPatches(calls)[0].url).toBe("/api/v1/envs/e2");
    const body = JSON.parse(envPatches(calls)[0].body!);
    expect(body.position).toBe(0); // Number(null ?? 0)===0；若 handler 直发 v（null）这里必红
    expect("position" in body).toBe(true);
  });
});

describe("⑤ 保存已有环境：PATCH 不是 POST", () => {
  it("draft.id=e1 → PATCH /envs/e1（body 无 env_id，id 走 path）+ 回填 config 原样回传 + toast「环境已保存」+ POST 零条", async () => {
    const calls = mockBackend();
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    const name = screen.getByTestId("env-name") as HTMLInputElement;
    expect(name.value).toBe("alpha"); // 打开管理即回填选中环境（draftFrom）
    fireEvent.change(name, { target: { value: "alpha-改" } });
    fireEvent.click(screen.getByTestId("env-save"));

    await waitFor(() => expect(envPatches(calls).length).toBe(1));
    expect(envPatches(calls)[0].url).toBe("/api/v1/envs/e1");
    const body = JSON.parse(envPatches(calls)[0].body!);
    // EnvUpdateIn（schemas.py:22-27）的 env_id 由路由投影从 path 注入并覆盖 body
    // （service.py:324-332），body 里不许混进 env_id
    expect(body).toEqual({
      project_id: "p1", name: "alpha-改", position: 0,
      config: { vars: [["k1", "v1"]], headers: [], timeout_ms: 3000 },
    });
    await waitFor(() => expect(toastText()).toContain("环境已保存"));
    expect(envPosts(calls)).toHaveLength(0); // 保存不许走创建动词
    expect(envDels(calls)).toHaveLength(0);
  });
});

describe("⑥ 环境名必填的早返回", () => {
  it("新建位留空名字直接点保存 → toast「环境名必填」，POST/PATCH 一条不发", async () => {
    const calls = mockBackend();
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    fireEvent.click(await screen.findByTestId("env-new"));
    fireEvent.click(screen.getByTestId("env-save"));
    await waitFor(() => expect(toastText()).toContain("环境名必填"));
    expect(envPosts(calls)).toHaveLength(0);
    expect(envPatches(calls)).toHaveLength(0);
  });
});

describe("⑦ 删除环境（确认路径）", () => {
  it("行内删除 → 二确讲清后果 → DELETE /envs/e1 body {project_id} + toast「已删除」+ 重拉 + 选中落到剩余排序第一条", async () => {
    // 第二次列表给出删后剩余（乱序进，排序后 aaa 在 beta 前）
    const calls = mockBackend({ pages: [PAGE1, [E2, E3]] });
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    fireEvent.click(screen.getByLabelText("删除环境-alpha"));
    // 二确必须讲真话。D139 起被引用的环境根本删不掉（env/services.py 的删门 409 in_use），
    // 所以旧句「引用它的环境选择会失效……需重新选择环境才能继续运行」描述的是一个系统
    // 已经不会发生的行为——第十道差集那一轴（文案承诺 → 兑现）。新句只说两件真事：硬删
    // 不可恢复（env 是硬删无级联）、被引用时删不掉且会点名。
    const confirmText = await screen.findByText(/的变量与请求头会一并删除/);
    expect(confirmText.textContent).toContain("不可恢复");
    expect(confirmText.textContent).toContain("删不掉");
    expect(confirmText.textContent).toContain("场景");
    expect(confirmText.textContent).toContain("UI 用例");
    expect(confirmText.textContent).toContain("定时任务");
    expect(confirmText.textContent).not.toContain("不受影响");
    // 「会失效 / 需重新选择」是删成功之后的形状，本门已禁止它发生——留着就是假话
    expect(confirmText.textContent).not.toContain("会失效");
    expect(confirmText.textContent).not.toContain("重新选择");
    fireEvent.click(await modalButton(/^删\s*除$/));

    await waitFor(() => expect(envDels(calls).length).toBe(1));
    expect(envDels(calls)[0].url).toBe("/api/v1/envs/e1");
    // EnvDeleteIn（schemas.py:30-32）：env_id 走 path，body 只带 project_id
    expect(JSON.parse(envDels(calls)[0].body!)).toEqual({ project_id: "p1" });
    await waitFor(() => expect(toastText()).toContain("已删除"));
    await waitFor(() => expect(selText()).toBe("e3")); // 删的是选中项 → 落剩余第一条（aaa）
    expect(listGets(calls).length).toBe(2);
  });
});

describe("⑧ 删除环境（取消路径）", () => {
  it("二确里点[取消] → DELETE 零条、列表也不偷偷重拉", async () => {
    const calls = mockBackend();
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    fireEvent.click(screen.getByLabelText("删除环境-alpha"));
    // antd 5 的 Modal.confirm 把同一标题画两处（.ant-modal-title + .ant-modal-confirm-title），
    // 裸 findByText 必撞 multiple——定位收窄到 confirm 自己的标题节点。
    expect(await screen.findByText("删除环境？", { selector: ".ant-modal-confirm-title" })).not.toBeNull();
    fireEvent.click(await modalButton(/^取\s*消$/));
    await new Promise((r) => setTimeout(r, 50));
    expect(envDels(calls)).toHaveLength(0);
    expect(listGets(calls)).toHaveLength(1);
    // 取消不许把选中悄悄改掉
    await new Promise((r) => setTimeout(r, 50));
    expect(selText()).toBe("e1");
  });
});

describe("⑨ 只读把手是「藏」不是「禁」（§11.5.1）", () => {
  it("canManage=false：行内删除钮从 DOM 消失；canCreate=false：[新建环境]消失", async () => {
    mockBackend();
    render(<Harness initial="e1" canManage={false} canCreate={false} />);
    await openManagerLoaded();
    await screen.findAllByTestId("env-item");
    expect(screen.queryByTestId("env-delete")).toBeNull();
    expect(screen.queryByTestId("env-new")).toBeNull();
  });

  it("canCreate=false 但 canManage=true：保存钮还在（(canCreate||canManage) 分支）；两者全关：保存钮消失", async () => {
    mockBackend();
    const { unmount } = render(<Harness initial="e1" canManage canCreate={false} />);
    await openManagerLoaded();
    expect(await screen.findByTestId("env-save")).not.toBeNull();
    expect(screen.queryByTestId("env-new")).toBeNull();
    unmount();

    mockBackend();
    render(<Harness initial="e1" canManage={false} canCreate={false} />);
    await openManagerLoaded();
    await screen.findAllByTestId("env-item");
    expect(screen.queryByTestId("env-save")).toBeNull();
    expect(screen.queryByTestId("env-delete")).toBeNull();
    expect(screen.queryByTestId("env-new")).toBeNull();
  });
});

describe("⑩ GlobalConfig 保存与四作用域", () => {
  const SCOPES = {
    VAR: [["base_url", "http://a"]],
    HEADER: [],
    ASSERT: [["a1"]],
    EXTRACT: [["e1"], ["e2"]],
  };

  // 钉「存而未用」而非旧句「1B 执行链路生效」：resolve_env 只读 VAR/HEADER
  // （env/services.py:166/169），ASSERT/EXTRACT 无任何消费者（models.py:21「存而不用」）。
  it("GET 带四作用域 → 提示行「已保存 3 条全局断言/提取配置（存而未用…）」；改变量保存 → POST body 逐字 {project_id,scope_type:'VAR',items} + toast + 重拉", async () => {
    const calls = mockBackend({ globalScopes: SCOPES });
    render(<GlobalConfig projectId="p1" canManage />);
    // W4b：global-hint（EnvPanel.tsx:300）是无条件渲染的常驻 Alert，GET 在飞时壳已在但
    // description 还没带上条数尾巴 → 等待点挪到 GET 带回的正文，URL 断言排在内容落定后。
    // ASSERT(1) + EXTRACT(2) = 3 条（条数是真数，保留；「生效」是假话，不许回来）
    await waitFor(() => expect(screen.getByTestId("global-hint").textContent)
      .toContain("已保存 3 条全局断言/提取配置（存而未用"));
    expect(gGets(calls)[0].url).toBe("/api/v1/envs/global-config?project_id=p1");
    expect(screen.getByTestId("global-hint").textContent).not.toContain("执行链路生效");

    fireEvent.change(screen.getByTestId("gvar-val-0"), { target: { value: "http://b" } });
    const getsBefore = gGets(calls).length;
    fireEvent.click(screen.getByTestId("global-save-var"));
    await waitFor(() => expect(gPosts(calls).length).toBe(1));
    expect(gPosts(calls)[0].url).toBe("/api/v1/envs/global-config");
    // scope_type 词表 ^(VAR|HEADER|ASSERT|EXTRACT)$（schemas.py:45）——这里必须发大写原名
    expect(JSON.parse(gPosts(calls)[0].body!)).toEqual({
      project_id: "p1", scope_type: "VAR", items: [["base_url", "http://b"]],
    });
    await waitFor(() => expect(toastText()).toContain("全局变量已保存"));
    await waitFor(() => expect(gGets(calls).length).toBe(getsBefore + 1));
  });

  it("切到[全局请求头]保存 → 同一 POST 端点，scope_type 逐字 'HEADER' + toast「全局请求头已保存」", async () => {
    const calls = mockBackend({ globalScopes: SCOPES });
    render(<GlobalConfig projectId="p1" canManage />);
    fireEvent.click(await screen.findByRole("tab", { name: /^全局请求头/ }));
    fireEvent.change(await screen.findByTestId("ghdr-key-0"), { target: { value: "X-Trace" } });
    fireEvent.change(screen.getByTestId("ghdr-val-0"), { target: { value: "1" } });
    // 钮在 GET 落地前是 disabled（EnvPanel.tsx:368 disabled={scopesState !== "ok"}），
    // rc-button 直接吞点击：探针实测慢后端下 POST 一条都不发。等解禁再按——这一条钉的是
    // scope_type 逐字 'HEADER'，不该退化成「等一条永远不会发出的请求」。
    await waitFor(() => expect((screen.getByTestId("global-save-header") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("global-save-header"));
    await waitFor(() => expect(gPosts(calls).length).toBe(1));
    expect(JSON.parse(gPosts(calls)[0].body!)).toEqual({
      project_id: "p1", scope_type: "HEADER", items: [["X-Trace", "1"]],
    });
    await waitFor(() => expect(toastText()).toContain("全局请求头已保存"));
    // 同「正对照」那条：等到自己承诺的重拉发出为止，别让它在 cleanup 之后打进别人的桩。
    await waitFor(() => expect(gGets(calls)).toHaveLength(2));
    expect(envPosts(calls)).toHaveLength(0); // 别串到环境创建端点
  });

  it("无 ASSERT/EXTRACT 时提示行不挂条数尾巴（assertCount=0 分支）", async () => {
    mockBackend({ globalScopes: { VAR: [], HEADER: [], ASSERT: [], EXTRACT: [] } });
    render(<GlobalConfig projectId="p1" canManage />);
    // 「不挂尾巴」是缺席断言，而尾巴只在回包之后才可能挂上：不先等 GET 落地，这条用例
    // 在飞时就通过了——慢后端探针下它照样绿，等于什么都没钉。用「钮解禁」当落地门。
    await waitFor(() => expect((screen.getByTestId("global-save-var") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("global-hint").textContent).not.toContain("已保存");
  });
});

describe("⑪ GlobalConfig 的 PairTable 接线（ro + idPrefix）", () => {
  it("canManage=false：两个保存钮消失，gvar/ghdr 输入框 disabled（ro={!canManage} 而不是把钮置灰）", async () => {
    mockBackend();
    render(<GlobalConfig projectId="p1" canManage={false} />);
    await screen.findByTestId("gvar-key-0");
    expect(screen.queryByTestId("global-save-var")).toBeNull();
    expect((screen.getByTestId("gvar-key-0") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: /^全局请求头/ }));
    const k = (await screen.findByTestId("ghdr-key-0")) as HTMLInputElement;
    expect(k.disabled).toBe(true);
    expect(screen.queryByTestId("global-save-header")).toBeNull();
  });

  it("环境 Tab 与全局 Tab 同屏时 idPrefix 隔离：env-var-* 与 gvar-* 各自可定位", async () => {
    mockBackend();
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    await screen.findByTestId("env-var-key-0"); // 环境页签里的 PairTable
    fireEvent.click(screen.getByRole("tab", { name: "项目全局配置" }));
    await screen.findByTestId("gvar-key-0"); // 全局页签里的 PairTable（两个面板同时在 DOM）
    expect(screen.getByTestId("env-var-key-0")).not.toBeNull();
    // 全局面板的保存钮在，环境面板的把手不受影响
    expect(screen.getByTestId("global-save-var")).not.toBeNull();
    expect(screen.getByTestId("env-save")).not.toBeNull();
  });
});

describe("⑫ 取失败 ≠ 没有环境：三态 placeholder + 失败可恢复", () => {
  // 对齐 scenes.tsx:630-637 已发货的三态形状；EnvSelect 的重拉走 [load]（projectId 变化），
  // 与 scenes 的「关窗重开」是不同生命周期，但共同底线：失败是第三种可见状态，
  // 且任何一次成功 load 必须把它抹掉。
  const envPh = () => (screen.getByTestId("env-select")
    .querySelector(".ant-select-selection-placeholder")?.textContent ?? "");
  const modalText = () => document.querySelector(".ant-modal")?.textContent ?? "";

  it("500：placeholder 说「没取到」+ 下拉旁挂失败提示，全页不许出现「还没有环境」", async () => {
    mockBackend({ pages: [PAGE1], pagesFail: [1] });
    render(<Harness />);
    expect(await screen.findByTestId("env-select-failed")).not.toBeNull();
    expect(envPh()).toBe("环境没取到，重进本页可重试");
    expect(envPh()).not.toBe("还没有环境");
    expect(document.body.textContent).not.toContain("还没有环境");
  });

  it("正对照：200 空列表 → placeholder 画「还没有环境」，失败提示必须缺席", async () => {
    // 没有这条，「逢空就喊失败」的实现也能过上一条——那是假绿。
    mockBackend({ pages: [[]] });
    render(<Harness />);
    await waitFor(() => expect(envPh()).toBe("还没有环境"));
    expect(screen.queryByTestId("env-select-failed")).toBeNull();
  });

  it("失败后重拉成功（projectId 变化触发 [load]）：失败态清空、真实环境名回来并自动选中", async () => {
    mockBackend({ pages: [PAGE1], pagesFail: [1] });
    const { rerender } = render(<Harness pid="p1" />);
    await screen.findByTestId("env-select-failed");
    expect(envPh()).toBe("环境没取到，重进本页可重试");
    rerender(<Harness pid="p2" />); // 同页换项目 = 该组件生命周期里的「再拉一次」
    await waitFor(() => expect(screen.queryByTestId("env-select-failed")).toBeNull());
    await waitFor(() => expect(selText()).toBe("e1"));
    await screen.findByText("alpha", { selector: ".ant-select-selection-item" });
  });

  it("管理窗不替失败说话：500 后窗内说「没取到」且新建出口在场；空回包才画 Empty「还没有环境」", async () => {
    mockBackend({ pages: [[]], pagesFail: [1] });
    const { unmount } = render(<Harness />);
    await screen.findByTestId("env-select-failed");
    await openManager();
    expect(await screen.findByTestId("env-manager-failed")).not.toBeNull();
    expect(modalText()).not.toContain("还没有环境");
    expect(screen.getByTestId("env-new")).not.toBeNull(); // 失败态仍留着重拉出口
    unmount();

    mockBackend({ pages: [[]] });
    render(<Harness />);
    await openManager();
    expect(await screen.findByText("还没有环境", { selector: ".ant-empty-description" })).not.toBeNull();
    expect(screen.queryByTestId("env-manager-failed")).toBeNull();
  });
});


describe("⑫ 全局配置没取到的那一格（第三十三轮：不许拿空表化妆成「没有配置」，更不许据此覆盖式保存）", () => {
  const SCOPES_FULL = {
    VAR: [["base_url", "http://a"], ["token", "t1"]],
    HEADER: [["X-Trace", "1"]],
    ASSERT: [], EXTRACT: [],
  };
  const FAIL500: Resp = { status: 500, body: { code: "http_500", message: "boom" } };
  const OK_BODY = { status: 200, body: { scopes: SCOPES_FULL } };
  const disabled = (id: string) => (screen.getByTestId(id) as HTMLButtonElement).disabled;
  // 「GET 真的落地了」的两种说法，都是只有成功路径才会成立的事实：
  // · tab 上的条数尾巴（EnvPanel.tsx:338 cnt 只在 scopesState==='ok' 时才拼）；
  // · 保存钮解禁（:359/:368 disabled={scopesState !== "ok"}）。
  // 为什么不能用 global-hint：它是常驻 Alert（:349），挂载当场就在，GET 在飞时 findBy
  // 就已经通过——慢后端探针实测 6 条用例因此赶在回包前跑。也不能用「失败句消失了」：
  // load() 一开始就把状态打成 loading（:302），失败句在重拉的**起点**就没了，不是成功的证据。
  const countIn = async (name: RegExp, n: string) => {
    await waitFor(() => expect(screen.getByRole("tab", { name }).textContent).toContain(n));
  };
  const saveReady = async (id = "global-save-var") => {
    await waitFor(() => expect(disabled(id)).toBe(false));
  };

  it("GET 500 → 说「没取到（不是项目里没有配置）」、条数不报数、保存钮禁用且点不出 POST", async () => {
    const calls = mockBackend({ globalResp: [FAIL500] });
    render(<GlobalConfig projectId="p1" canManage />);
    expect(await screen.findByTestId("global-config-failed")).not.toBeNull();
    expect(screen.getByTestId("global-config-failed").textContent).toContain("全局配置没取到");
    expect(screen.getByTestId("global-config-failed").textContent).toContain("不是项目里没有配置");
    // 覆盖式保存的前提是知道现状；不知道就不许发那一条 POST（发了就是把已有配置写成空）
    expect(disabled("global-save-var")).toBe(true);
    fireEvent.click(screen.getByTestId("global-save-var"));
    await new Promise((r) => setTimeout(r, 0));
    expect(gPosts(calls)).toHaveLength(0);
    // 条数也不许凭空报 0：读失败时「全局变量（0）」同样是句假话
    expect(screen.getByRole("tab", { name: /^全局变量/ }).textContent).not.toContain("0");
  });

  it("正对照：GET 200 有配置 → 不出现失败句、钮可点、POST 带真实条目", async () => {
    const calls = mockBackend({ globalScopes: SCOPES_FULL });
    render(<GlobalConfig projectId="p1" canManage />);
    await saveReady();
    expect(screen.queryByTestId("global-config-failed")).toBeNull();
    expect(disabled("global-save-var")).toBe(false);
    await countIn(/^全局变量/, "2");
    fireEvent.click(screen.getByTestId("global-save-var"));
    await waitFor(() => expect(gPosts(calls).length).toBe(1));
    expect(JSON.parse(gPosts(calls)[0].body!).items).toEqual([["base_url", "http://a"], ["token", "t1"]]);
    // 收尾必须等到自己承诺的那次重拉**发出去**（⑩ 第一条同款等待）。不然探针把 POST 应答
    // 延后 60ms，saveScope 的 await load() 就在 cleanup 之后才跑：那条 GET 打进**下一条
    // 用例**的 fetch 桩、吃掉它的 globalResp[1]，于是「重试」拿到的是缺省空回包 →
    // 计数（0）。泄漏的请求不该改写下一个人的剧本，而慢后端下只有等尾巴才拦得住它。
    await waitFor(() => expect(gGets(calls)).toHaveLength(2));
  });

  it("失败后点「重试」→ 失败句消失、条数回来、钮解禁（本页切 Tab 不重拉，得给出就地出路）", async () => {
    const calls = mockBackend({ globalResp: [FAIL500, OK_BODY] });
    render(<GlobalConfig projectId="p1" canManage />);
    await screen.findByTestId("global-config-failed");
    fireEvent.click(screen.getByTestId("global-config-retry"));
    // 顺序有讲究：先等条数回来（成功路径才成立），再断言失败句没了。反过来写的话
    // 「失败句消失」会在重拉起点的 loading 那一格就成立，等于断言了个开始。
    await countIn(/^全局变量/, "2");
    await saveReady();
    expect(screen.queryByTestId("global-config-failed")).toBeNull();
    expect(gGets(calls)).toHaveLength(2); // 重试真的又拉了一次
  });

  it("保存后的重拉失败不许把已经显示的现状收回空态（否则每次存盘都闪一次「没取到」）", async () => {
    mockBackend({ globalScopes: SCOPES_FULL, globalResp: [OK_BODY, FAIL500] });
    render(<GlobalConfig projectId="p1" canManage />);
    await saveReady(); // 等第一次 GET 真的落地（常驻壳 global-hint 不能当门）
    await countIn(/^全局变量/, "2");
    fireEvent.click(screen.getByTestId("global-save-var"));
    await waitFor(() => expect(toastText()).toContain("全局变量已保存"));
    // 迟到的那次重拉失败要真的失败完才好看屏：用「保存态释放」当门（saveScope 的
    // finally setSaving(null) 排在 await load() 之后），setTimeout(0) 在慢后端下赶不到。
    await waitFor(() => expect(screen.getByTestId("global-save-var").className).not.toContain("ant-btn-loading"));
    expect(screen.queryByTestId("global-config-failed")).toBeNull();
    await countIn(/^全局变量/, "2");
    expect(disabled("global-save-var")).toBe(false);
  });

  it("canManage=false 时本来就没有保存钮：失败句照样要说（只读也被蒙在鼓里）", async () => {
    mockBackend({ globalResp: [FAIL500] });
    render(<GlobalConfig projectId="p1" canManage={false} />);
    expect(await screen.findByTestId("global-config-failed")).not.toBeNull();
    expect(screen.queryByTestId("global-save-var")).toBeNull();
  });

  // 第三十四轮（同族的方向反例）：保存成功后那次重拉会无条件 setVars/setHeaders，而
  // PairTable 在保存期间照样可编辑（ro 只跟 canManage 走）。回包一落地就把人在等待里敲的
  // 半行盖掉——屏上摆的不是他马上要点「保存」发出去的那份，而保存是覆盖式的。
  // SERVER_AFTER 特意带一条 ASSERT：hint 里那句「已保存 1 条全局断言」只可能来自 scopes，
  // 而 setScopes 不在守卫内 —— 拿它当「迟到的回包已经落地」的闸门，比 toast 可靠
  // （antd 的 message 挂在 render 容器外，cleanup 不洗，前一条用例的 toast 会留着让
  //  waitFor 第一次轮询就通过，断言于是赶在回包之前跑 = 又一只杀不死变异的假把手）。
  const SERVER_AFTER: Resp = { status: 200, body: { scopes: {
    VAR: [["base_url", "http://服务器那份"]], HEADER: [["X-Srv", "1"]],
    ASSERT: [["a1", "1"]], EXTRACT: [] } } };
  const reloadLanded = async () => {
    await waitFor(() => expect(screen.getByTestId("global-hint").textContent)
      .toContain("已保存 1 条全局断言/提取配置"));
  };

  it("保存后的重拉在途时人改了表格 → 迟到的回包不许吃掉那半行", async () => {
    let release!: () => void;
    const gated = new Promise<void>((r) => { release = r; });
    const calls = mockBackend({ globalScopes: SCOPES_FULL, globalResp: [OK_BODY, SERVER_AFTER],
      globalGate: [undefined, gated] });
    render(<GlobalConfig projectId="p1" canManage />);
    await saveReady(); // 首拉没落地前钮是 disabled，点击会被吞 → 门永远等不到第 2 次 GET
    fireEvent.click(screen.getByTestId("global-save-var"));
    // 门挂在第 2 次 GET 上：calls 在 fetch 进门前就 push，所以「已经在途」用请求数说，
    // 不靠 loading 类名（那只证明钮的状态，不证明回包真的扣住了）。
    await waitFor(() => expect(gGets(calls)).toHaveLength(2));
    fireEvent.change(screen.getByTestId("gvar-val-0"), { target: { value: "http://我刚敲的" } });
    await act(async () => { release(); }); // 回包落地：它带的是服务器那份，不含刚敲的半行
    await reloadLanded();
    expect((screen.getByTestId("gvar-val-0") as HTMLInputElement).value).toBe("http://我刚敲的");
    expect((screen.getByTestId("gvar-key-0") as HTMLInputElement).value).toBe("base_url");
    expect(document.body.textContent).not.toContain("http://服务器那份");
  });

  it("同一条腿在请求头表上也得成立：在途改 ghdr → 迟到的回包不吃那半行", async () => {
    let release!: () => void;
    const gated = new Promise<void>((r) => { release = r; });
    const calls = mockBackend({ globalScopes: SCOPES_FULL, globalResp: [OK_BODY, SERVER_AFTER],
      globalGate: [undefined, gated] });
    render(<GlobalConfig projectId="p1" canManage />);
    await screen.findByTestId("global-hint");
    // 请求头那条腿单独钉：editGen 是两个 onChange 各自 +1，只测 VAR 时把 ghdr 那处漏掉
    // 依旧全绿（两处递增长得一样，不代表一处能替另一处作证）。
    fireEvent.click(screen.getByRole("tab", { name: /^全局请求头/ })); // 未激活的 Tab 不挂载
    await saveReady("global-save-header"); // 首拉没落地前钮禁用，点击会被吞 → 门永远等不到第 2 次 GET
    fireEvent.click(screen.getByTestId("global-save-header"));
    await waitFor(() => expect(gGets(calls)).toHaveLength(2));
    fireEvent.change(screen.getByTestId("ghdr-val-0"), { target: { value: "trace-我刚敲的" } });
    await act(async () => { release(); });
    await reloadLanded();
    expect((screen.getByTestId("ghdr-val-0") as HTMLInputElement).value).toBe("trace-我刚敲的");
    expect((screen.getByTestId("ghdr-key-0") as HTMLInputElement).value).toBe("X-Trace");
    expect(document.body.textContent).not.toContain("X-Srv");
  });

  it("正对照：重拉期间没人动表格 → 服务器那份照旧回灌（守卫不许变成「永远不回灌」）", async () => {
    let release!: () => void;
    const gated = new Promise<void>((r) => { release = r; });
    const calls = mockBackend({ globalScopes: SCOPES_FULL, globalResp: [OK_BODY, SERVER_AFTER],
      globalGate: [undefined, gated] });
    render(<GlobalConfig projectId="p1" canManage />);
    await screen.findByTestId("global-hint");
    await saveReady(); // 首拉没落地前钮禁用，这一条的门（第 2 次 GET）就永远等不到
    fireEvent.click(screen.getByTestId("global-save-var"));
    await waitFor(() => expect(gGets(calls)).toHaveLength(2));
    await act(async () => { release(); });
    await reloadLanded();
    expect((screen.getByTestId("gvar-key-0") as HTMLInputElement).value).toBe("base_url");
    expect((screen.getByTestId("gvar-val-0") as HTMLInputElement).value).toBe("http://服务器那份");
    expect(screen.getByRole("tab", { name: /^全局变量/ }).textContent).toContain("1"); // 计数跟着回灌
  });
});

// ── ⓭ 删除被 409 in_use 拦下（D139）：后端给的引用清单必须点名，三个数不许互相裹 ──
// 后端 env/services.py 的删门把引用数拆成 count = own + foreign，明细只从 own 取，
// 另有 details_hidden（权限咽了明细）与 details_truncated（上限截了明细）两把独立的尺。
// 前端这一屏的唯一价值就是把这三件事**分别**说清；合并任意两件都会指错出路：
// 把 foreign 说成 hidden → 用户去申请一个申请了也拿不到的权限；
// 把 truncated 说成「共 N 条」→ 他以为列全了，去解绑前两条就以为完事。
const inUseBody = (over: Record<string, unknown> = {}) => ({
  code: "in_use", message: "该环境被 场景 2 条 引用，先解绑再删", ...over,
});

describe("⓭ 删除被引用拦下（409 in_use）：点名引用方，三个数各说各的", () => {
  /** 走完整删除路径拿住 in_use 弹窗。 */
  async function triggerInUse(details: unknown): Promise<Call[]> {
    const calls = mockBackend({ deleteResp: [{ status: 409, body: inUseBody({ details }) }] });
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    fireEvent.click(screen.getByLabelText("删除环境-alpha"));
    fireEvent.click(await modalButton(/^删\s*除$/));
    await screen.findByTestId("env-inuse");
    return calls;
  }

  it("本项目的引用照常点名；环境未被删除（不发第二次 DELETE、不重拉成删后态）", async () => {
    const calls = await triggerInUse({
      env_id: "e1", count: 2,
      scenario: { label: "场景", count: 2, own: 2, foreign: 0, details_hidden: false,
        details_truncated: false,
        items: [{ id: "s1", name: "夜跑场景" }, { id: "s2", name: "冒烟场景" }] },
    });
    expect((await screen.findByTestId("env-inuse-scenario")).textContent).toContain("场景");
    expect(screen.getByTestId("env-inuse-scenario").textContent).toContain("2 条");
    expect(screen.getAllByTestId("env-inuse-item").map((n) => n.textContent))
      .toEqual(["夜跑场景", "冒烟场景"]);
    // 拦截态下这些「另一件事」的句子一句都不许出现
    expect(screen.queryByTestId("env-inuse-foreign")).toBeNull();
    expect(screen.queryByTestId("env-inuse-truncated")).toBeNull();
    // 409 是拦截不是失败：不发第二次 DELETE。
    // （这里刻意不断言「没有『已删除』toast」——antd 静态 message 的 DOM 节点跨用例累积，
    //  本文件的 toastText() 量得到的是整份文件的 toast 之和，见 :213-216 对 .ant-modal-root
    //  的同款处理。假绿比少一条断言更坏，所以只断言量得准的：请求条数 + 屏上仍在。）
    expect(envDels(calls).length).toBe(1);
    expect(screen.getByTestId("env-inuse")).toBeTruthy();
  });

  it("跨项目的引用只报条数不报名字，且绝不写成「需要权限」（foreign ≠ hidden，M7 那条轴）", async () => {
    await triggerInUse({
      env_id: "e1", count: 1,
      scenario: { label: "场景", count: 1, own: 0, foreign: 1, details_hidden: false,
        details_truncated: false, items: [] },
    });
    const box = screen.getByTestId("env-inuse-scenario");
    expect(box.textContent).toContain("另有 1 条在其它项目");
    expect(box.textContent).not.toContain("权限"); // 有权限也拿不到名字，说权限是撒谎
    expect(screen.queryAllByTestId("env-inuse-item")).toHaveLength(0);
  });

  it("details_hidden=true 才说「需要权限」，并且不画空列表", async () => {
    await triggerInUse({
      env_id: "e1", count: 1,
      ui_case: { label: "UI 用例", count: 1, own: 1, foreign: 0, details_hidden: true,
        details_truncated: false, items: [] },
    });
    const box = screen.getByTestId("env-inuse-ui_case");
    expect(box.textContent).toContain("ui:case:read");
    expect(box.textContent).toContain("不可见");
    expect(screen.queryAllByTestId("env-inuse-item")).toHaveLength(0);
  });

  it("被上限截断时说清「仅列前 N 条，另有 M 条未列出」——不许把 20 当全量", async () => {
    await triggerInUse({
      env_id: "e1", count: 25,
      scenario: { label: "场景", count: 25, own: 25, foreign: 0, details_hidden: false,
        details_truncated: true,
        items: Array.from({ length: 20 }, (_, i) => ({ id: "s" + i, name: "场景" + i })) },
    });
    const box = screen.getByTestId("env-inuse-scenario");
    expect(box.textContent).toContain("仅列前 20 条");
    expect(box.textContent).toContain("另有 5 条");
    expect(screen.getAllByTestId("env-inuse-item")).toHaveLength(20);
  });

  it("多域同时拦：每域一条，缺席的域不画空壳", async () => {
    await triggerInUse({
      env_id: "e1", count: 3,
      scenario: { label: "场景", count: 2, own: 2, foreign: 0, details_hidden: false,
        details_truncated: false, items: [{ id: "s1", name: "A" }, { id: "s2", name: "B" }] },
      schedule_task: { label: "定时任务", count: 1, own: 0, foreign: 1, details_hidden: false,
        details_truncated: false, items: [] },
    });
    expect(screen.getByTestId("env-inuse-scenario")).toBeTruthy();
    expect(screen.getByTestId("env-inuse-schedule_task")).toBeTruthy();
    expect(screen.queryByTestId("env-inuse-ui_case")).toBeNull(); // 后端没给的域不许凭空画出来
  });

  it("关掉弹窗后环境还在（列表没被本地乐观删掉）", async () => {
    const calls = await triggerInUse({
      env_id: "e1", count: 1,
      scenario: { label: "场景", count: 1, own: 1, foreign: 0, details_hidden: false,
        details_truncated: false, items: [{ id: "s1", name: "A" }] },
    });
    fireEvent.click(await modalButton(/^知道了$/));
    await waitFor(() => expect(screen.queryByTestId("env-inuse")).toBeNull());
    // 拦截后不重拉、不丢选中：alpha 仍是当前选中
    expect(listGets(calls).length).toBe(1);
    expect(selText()).toBe("e1");
  });

  it("非 in_use 的删除失败（500）不画引用弹窗——那是网络错，不是拦截", async () => {
    mockBackend({ deleteResp: [{ status: 500, body: { code: "http_500", message: "boom" } }] });
    render(<Harness initial="e1" />);
    await openManagerLoaded();
    fireEvent.click(screen.getByLabelText("删除环境-alpha"));
    fireEvent.click(await modalButton(/^删\s*除$/));
    await waitFor(() => expect(toastText()).toContain("boom"));
    expect(screen.queryByTestId("env-inuse")).toBeNull();
  });
});
