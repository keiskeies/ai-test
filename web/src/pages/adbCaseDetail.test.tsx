// ADB 用例详情页（步骤编辑器 + 设备策略 + 调试/执行）的组件测试（1D T9）。
// 钉的是页面编排逻辑（e2e 未跑之前的本地证据）：
// ① 设备策略两段式（任一空闲 ⇄ 指定设备）：保存体带 default_device + default_device_set 声明位；
//    库里 serial 未登记 → 「设备未登记」橙标如实出现（存期不校验，跑时才解析）；
// ② 调试语义（D17 两副面孔的界面兑现）：dirty 时调试先代存并在 note 里说「已代为保存」；
//    占用 422 → 面板 Alert「调试没有发起」原话直出，绝不演半截结论；
// ③ 权限隐藏不是禁用：无 adb:case:update / adb:case:run 时保存/调试/执行不渲染；
// ④ modeBadge 三态（u2/dump/null）——降级不可见是纪律 1 违例，措辞在这里钉。
// Monaco（shell 的 cmd 编辑器）mock 成占位，同 StepParams.test.tsx 的分工。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

vi.mock("../components/CodeEditor", () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="mock-monaco" value={value}
      onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

import AdbCaseDetailPage from "./adbCaseDetail";
import { message } from "antd";
import { modeBadge } from "../adb/AdbDebugPanel";
import { useAuth } from "../auth/store";
import type { AdbCaseOut, AdbCaseReferencesOut, AdbDebugResult } from "../api/adbCase";

const CASE: AdbCaseOut = {
  id: "c1", project_id: "p1", module_id: null, name: "登录冒烟", priority: "P1",
  enabled: true, steps: [{ id: "a1", type: "connect", addr: "127.0.0.1:5555" }],
  default_device: null, owner_id: null, project_public: true, status: "normal",
  step_count: 1, last_run_at: null, last_run_status: null, updated_by: null,
  created_at: null, updated_at: null, issues: [],
};

const DEBUG_RESULT: AdbDebugResult = {
  run_id: "r1", status: "passed", ok: true, passed: true, elapsed_ms: 1200, error: null,
  mode: "dump", device: "192.168.1.21:5555", vars: {},
  commands: [{ id: "a1", type: "connect", status: "pass", message: "connected", elapsed_ms: 120 }],
  artifacts: [],
};

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

interface MockState { patched: unknown[]; debugBody?: unknown; runBody?: unknown }

function mockBackend(
  state: MockState,
  opts: { caseRow?: AdbCaseOut; debugFail?: string; caseGetFail?: boolean;
    caseGetStatus?: number; refs?: AdbCaseReferencesOut } = {},
) {
  const caseRow = opts.caseRow ?? CASE;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/v1/adb-cases/c1?") && method === "GET") {
      // 详情 404（回收/不存在）：Editor 的 catch 走 missing 分支（:232-237 早退警告页）
      if (opts.caseGetFail) {
        return { ok: false, status: 404, json: async () => ({
          code: "not_found", message: "用例不存在（演示 404）", details: null,
        }) } as unknown as Response;
      }
      // 非 404 的失败（500/网络）：走 loadFailed 分支，不许蹭「不存在」那句话
      if (opts.caseGetStatus) {
        const s = opts.caseGetStatus;
        return { ok: false, status: s, json: async () => ({
          code: s === 403 ? "insufficient_permission" : "internal_error",
          message: "演示 " + s, details: s === 403
            ? { perm: "adb:case:read", project_id: "p1" } : null,
        }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => caseRow } as unknown as Response;
    }
    if (url.startsWith("/api/v1/adb-cases/c1") && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      state.patched.push(body);
      return { ok: true, status: 200, json: async () => ({ ...caseRow, ...body,
        default_device: body.default_device ?? null }) } as unknown as Response;
    }
    if (url.includes("/adb-cases/c1/debug") && method === "POST") {
      state.debugBody = JSON.parse(String(init?.body));
      if (opts.debugFail) {
        return { ok: false, status: 422, json: async () => ({
          code: "device_occupied", message: opts.debugFail, details: null,
        }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => DEBUG_RESULT } as unknown as Response;
    }
    if (url.includes("/adb-cases/c1/run") && method === "POST") {
      state.runBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ run_id: "r9", status: "queued" }) } as unknown as Response;
    }
    if (url.includes("/adb-case-references")) {
      return { ok: true, status: 200, json: async () => (opts.refs ?? {
        items: [{ scenario_id: "s1", scenario_name: "混合场景", step_keys: ["n3"] }],
        details_hidden: false,
      }) } as unknown as Response;
    }
    if (url.includes("/adb-devices?")) {
      return { ok: true, status: 200, json: async () => ({
        items: [{ id: "d1", project_id: "p1", name: "小米13", serial: "192.168.1.21:5555",
          connect_type: "wifi", wifi_addr: "192.168.1.21", enabled: true,
          last_state: { model: "小米 13", online: true }, owner_id: null, project_public: true,
          status: "normal", updated_by: null, created_at: null, updated_at: null, occupied_by: null }],
        next_cursor: null,
      }) } as unknown as Response;
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/adb/cases/c1"]}>
      <Routes>
        <Route path="/adb/cases/:id" element={<AdbCaseDetailPage />} />
        {/* D123：落点不再是一枚裸 div——执行投完队列跳的是 /runs?run=<id>，
            这条路由把 location.search 原样摊出来，钉「参数真的带上了」。 */}
        <Route path="/runs" element={<RunsLand />} />
      </Routes>
    </MemoryRouter>,
  );
}

function RunsLand() {
  const loc = useLocation();
  return <div data-testid="landed-runs" data-search={loc.search} />;
}

beforeEach(() => {
  cleanup();
  // antd message 挂在 React 树外的 portal 上，cleanup 管不到：默认 3s 的 toast 会漂进
  // 后一条测试的 body.textContent，污染「屏上不许出现 X」这类负断言（D136 的 toast
  // 两腿全靠这类断言分家）。
  message.destroy();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("modeBadge（降级要说人话，T6 交接的可见性）", () => {
  it("u2=绿控件树会话；dump=橙降级（慢但判定同一份）；null=不叠徽标", () => {
    expect(modeBadge("u2")).toEqual({ text: "控件树会话 (u2)", color: "green" });
    expect(modeBadge("dump")?.color).toBe("orange");
    expect(modeBadge("dump")?.text).toContain("降级");
    expect(modeBadge(null)).toBeNull();
    expect(modeBadge(undefined)).toBeNull();
    // 后端加了新模式：照实透传，不猜语义
    expect(modeBadge("scrcpy")).toEqual({ text: "模式 scrcpy", color: "default" });
  });
});

describe("详情页编排", () => {
  it("加载：默认设备=任一空闲；切「指定设备」出下拉并预选，保存体带 default_device+声明位", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("case-name")).not.toBeNull());
    expect((screen.getByTestId("case-name") as HTMLInputElement).value).toBe("登录冒烟");
    // 场景引用只读事实（含命中步骤 key）
    await waitFor(() => expect(screen.getByTestId("adb-case-ref")).not.toBeNull());
    expect(screen.getByTestId("adb-case-ref").textContent).toContain("混合场景");
    expect(screen.getByTestId("adb-case-ref").textContent).toContain("n3");

    // 设备策略切到「指定设备」→ 出下拉（脏了，保存按钮文案要跟）
    fireEvent.click(screen.getByText("指定设备"));
    await waitFor(() => expect(screen.getByTestId("case-device")).not.toBeNull());
    expect(screen.getByTestId("adb-case-save").textContent).toContain("有未保存修改");
    fireEvent.click(screen.getByTestId("adb-case-save"));
    await waitFor(() => expect(state.patched.length).toBe(1));
    const body = state.patched[0] as { default_device: string | null; default_device_set: boolean; steps_set: boolean };
    // 切「指定设备」时代码预选了唯一一台（小米13）；声明位必须齐
    expect(body.default_device).toBe("192.168.1.21:5555");
    expect(body.default_device_set).toBe(true);
    expect(body.steps_set).toBe(true);
  });

  it("库里 serial 未登记 → 「设备未登记」橙标如实出现，不静默清掉策略", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state, { caseRow: { ...CASE, default_device: "10.0.0.9:5555" } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("adb-case-device-unbound")).not.toBeNull());
    expect(screen.getByTestId("adb-case-device-unbound").textContent).toContain("设备未登记");
  });

  it("dirty 时点调试：先代存、note 说出「已代为保存」；dump 结果出降级徽标", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("case-name")).not.toBeNull());
    fireEvent.change(screen.getByTestId("case-name"), { target: { value: "登录冒烟改" } });
    fireEvent.click(screen.getByTestId("adb-case-debug"));
    // 代存发生（PATCH 一次）+ debug 发起
    await waitFor(() => expect(state.debugBody).toBeTruthy());
    expect(state.patched.length).toBe(1);
    await waitFor(() => expect(screen.getByTestId("adb-debug-panel")).not.toBeNull());
    // 面板在 await run 之前就开（adbCaseDetail.tsx:209-212），note 要 note && !running 才渲染
    // （AdbDebugPanel.tsx:144，契约钉在 AdbDebugPanel.test.tsx:115）——慢后端下这里先撞上
    // 的是合法的「正在跑」窗口，不是 note 丢了。等 note 真在场再读。
    await waitFor(() => expect(screen.queryByTestId("adb-debug-note")).not.toBeNull());
    expect(screen.getByTestId("adb-debug-note").textContent).toContain("已代为保存");
    expect(screen.getByTestId("adb-debug-mode").textContent).toContain("降级");
    expect(screen.getByTestId("adb-debug-device").textContent).toContain("192.168.1.21:5555");
    // 调试永不排队（D17）：全页不出现「预计」
    expect(document.body.textContent).not.toContain("预计");
  });

  it("占用 422：面板 Alert「调试没有发起」原话直出，不演半截结论", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state, { debugFail: "设备 小米13 正被 run:r8 占用，调试不排队" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("case-name")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-case-debug"));
    await waitFor(() => expect(screen.getByTestId("adb-debug-panel")).not.toBeNull());
    const panel = screen.getByTestId("adb-debug-panel");
    await waitFor(() => expect(panel.textContent).toContain("调试没有发起"));
    expect(panel.textContent).toContain("调试不排队");
    // 没有结果却画了时间线 = 半截结论，红
    expect(screen.queryByTestId("adb-debug-step-row")).toBeNull();
  });

  it("只读成员（无 update/run）：保存/调试/执行/名称编辑全不渲染", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state);
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("case-name")).not.toBeNull());
    expect(screen.queryByTestId("adb-case-save")).toBeNull();
    expect(screen.queryByTestId("adb-case-debug")).toBeNull();
    expect(screen.queryByTestId("adb-case-run")).toBeNull();
    expect((screen.getByTestId("case-name") as HTMLInputElement).disabled).toBe(true);
  });

  it("执行 = enqueue：投队列后跳运行记录（queued 的 run_id 带上）", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("adb-case-run")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-case-run"));
    await waitFor(() => expect(state.runBody).toBeTruthy());
    expect(state.runBody).toEqual({ project_id: "p1" });
    // 投完队列跳运行记录（带 run_id 的落点是真的）；D123：?run= 必须真带在查询串上，
    // 落点 runs 页靠它认行——裸跳 /runs 等于把 run_id 丢在半路。
    await waitFor(() => expect(screen.getByTestId("landed-runs")).not.toBeNull());
    expect(screen.getByTestId("landed-runs").getAttribute("data-search")).toBe("?run=r9");
  });

  // D136：toast 按设备策略分叉。后端两条策略的占用语义根本不同
  // （debug_services.py:382-384 指定设备才 FIFO；:401-404 任一空闲纯轮询不入队），
  // 旧文案对两条策略统一承诺「按 FIFO 排队，位次在运行记录里看」——后半句还是假的：
  // 全仓没有界面渲染 device_queued 位次。两腿各钉各的文案，且互斥：
  // 变异靶①：toast 不再看 policy（两腿之一红）；②：任一空闲腿重新承诺排队或位次（红）。
  it("执行 toast 按策略分叉（D136）：任一空闲=轮询等待不排队；指定设备=FIFO+位次记在运行事件（界面未展示）", async () => {
    // toast 挂 React 树外的 portal、还带离场动画——body.textContent 会混进前面测试的
    // 残留 toast，所以断言一律圈在「已投执行队列」这几枚真身节点上，不赌全局屏面。
    const runToasts = () => Array.from(document.querySelectorAll(".ant-message-notice-content"))
      .filter((n) => (n.textContent ?? "").includes("已投执行队列（run r9）"));
    // 腿①：CASE.default_device=null → policy=any，toast 只许说「换空闲设备/轮询/不排队」。
    // 此刻屏上所有「已投执行队列」toast 都出自新文案（旧文案的 run-toast 已随源码消失）。
    const state: MockState = { patched: [] };
    mockBackend(state);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("adb-case-run")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-case-run"));
    await waitFor(() => expect(runToasts().length).toBeGreaterThan(0));
    expect(runToasts()[runToasts().length - 1].textContent).toContain("设备占用时会自动挑空闲设备");
    expect(runToasts()[runToasts().length - 1].textContent).toContain("全部占用时轮询等待，不排队");
    for (const t of runToasts()) {
      expect(t.textContent).not.toContain("FIFO");
      expect(t.textContent).not.toContain("位次在运行记录里看");
    }
    // 腿②：库里存了 serial → policy=pinned，toast 承诺 FIFO，但位次必须落在
    // 「记在运行事件里（当前界面未展示）」——「在运行记录里看」是 D136 要杀的假话。
    cleanup();
    const state2: MockState = { patched: [] };
    mockBackend(state2, { caseRow: { ...CASE, default_device: "192.168.1.21:5555" } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("adb-case-run")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-case-run"));
    await waitFor(() => expect(runToasts()[runToasts().length - 1]?.textContent)
      .toContain("指定设备占用时会按 FIFO 排队"));
    const pinned = runToasts()[runToasts().length - 1];
    expect(pinned.textContent).toContain("真实位次记在运行事件里（当前界面未展示）");
    expect(pinned.textContent).not.toContain("不排队");
    // 假话在屏上任何一枚 run-toast 都不许出现（含残留）
    for (const t of runToasts()) expect(t.textContent).not.toContain("位次在运行记录里看");
  });

  it("page-adb-case-detail：壳永远在场，且把 PageHead + ProjectGate 内容包在自己里面", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("case-name")).not.toBeNull());
    // :342 的壳：文档里恰好一个（挂两页 = 渲染撞车，本身就是要红的事）
    expect(screen.getAllByTestId("page-adb-case-detail")).toHaveLength(1);
    const shell = screen.getByTestId("page-adb-case-detail");
    // :343/:344 两枚子节点都在壳内：摘掉壳（改渲染 Fragment/裸 div）后这两条各红一条
    expect(shell.tagName).toBe("DIV");
    expect(shell.querySelector(".tp-page-head")).not.toBeNull();
    expect(shell.querySelector('[data-testid="case-name"]')).not.toBeNull();
    // 杀 AD26：:343 的 PageHead title="ADB 用例详情"——改字/删 title 这条即红。
    // 上面只钉了 .tp-page-head 容器在场，从没钉过标题文本；e2e 的 tp-page-title
    // 断言只在列表页（nav.spec.mjs:72「ADB 用例」），详情页标题此前全线无人质询。
    expect(shell.querySelector(".tp-page-title")?.textContent).toBe("ADB 用例详情");

    // 没项目：壳照在（:342 在 ProjectGate 外层），内容区换 no-project 空态——
    // 壳不随 ProjectGate 分支消失，是这行的契约。先 cleanup 再二渲染（防 getBy 撞双份）。
    cleanup();
    useAuth.setState({ project: null, ready: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("no-project")).not.toBeNull());
    expect(screen.getAllByTestId("page-adb-case-detail")).toHaveLength(1);
    const shell2 = screen.getByTestId("page-adb-case-detail");
    expect(shell2.querySelector('[data-testid="no-project"]')).not.toBeNull();
    expect(shell2.querySelector('[data-testid="case-name"]')).toBeNull();
  });

  it("adb-case-detail-missing：详情 404 → 警告页原文出现且编辑器消失；happy path 上它必须缺席", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state, { caseGetFail: true });
    renderPage();
    const alert = await waitFor(() => {
      const n = screen.getByTestId("adb-case-detail-missing");
      expect(n.textContent).toContain("用例加载失败");
      return n;
    });
    // :234 的 Alert 属性形状（type/showIcon）+ :235/:236 两段原文逐字钉
    expect(alert.className).toContain("ant-alert-warning");
    expect(alert.querySelector(".ant-alert-icon")).not.toBeNull();
    expect(alert.textContent).toContain(
      "后端回「不存在」：这条 ADB 用例已被回收或从未存在——以上方刚才的错误提示为准。");
    // 404 腿不许顺带把「没取到」那条也画出来：两条分支各说各的失败类
    expect(screen.queryByTestId("adb-case-detail-failed")).toBeNull();
    // missing 是早退分支（:232 return）：整棵编辑器（壳内 meta/refs/步骤表）不得残留
    expect(screen.queryByTestId("adb-case-meta")).toBeNull();
    expect(screen.queryByTestId("adb-case-refs")).toBeNull();
    expect(screen.queryByTestId("page-adb-case-detail")
      ?.querySelector('[data-testid="case-name"]')).toBeNull();

    // 对照腿：同一套 mock 只在 caseGetFail 上不同 → 正常页里 missing 必须不存在。
    // 「mock 里数据是空」不会翻这个分支——只有 GET 真的失败才会。
    cleanup();
    const state2: MockState = { patched: [] };
    mockBackend(state2);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("case-name")).not.toBeNull());
    expect(screen.queryByTestId("adb-case-detail-missing")).toBeNull();
  });

  it("详情 500 ≠ 404：说「没取到」，不许蹭「已被回收或从未存在」", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state, { caseGetStatus: 500 });
    renderPage();
    const alert = await waitFor(() => {
      const n = screen.getByTestId("adb-case-detail-failed");
      expect(n.textContent).toContain("用例加载失败");
      return n;
    });
    expect(alert.textContent).toContain(
      "这条用例没取到（后端没回「不存在」，也还没到没权限那步）——与用例本身无关，重试或看后端日志。");
    // 只有 404/410 才许进 missing 分支；一次 500 就宣布用例没了 = 替故障下结论
    expect(screen.queryByTestId("adb-case-detail-missing")).toBeNull();
    expect(screen.queryByTestId("perm-empty")).toBeNull();
  });

  it("case-priority：库里 P1 显示 P1（不是 P2 默认值）；改成 P3 → 保存体 priority 是 P3", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state);
    renderPage();
    await waitFor(() => expect(
      (screen.getByTestId("case-name") as HTMLInputElement).value).toBe("登录冒烟"));
    const sel = screen.getByTestId("case-priority");
    // :251 value={priority} ← :94 setPriority(c.priority)：fixture 是 P1，初始态若回写 P2
    // （:57 的 useState 初值）这里就是 P2 → 红。「P2」作为可点选项文本此刻只活在收起的
    // 下拉里，可见区里的 P1/P2 只可能来自这一行选中值。
    expect(sel.textContent).toContain("P1");
    expect(sel.textContent).not.toContain("P2");
    // :251 的内联宽（style={{ width: 96 }}）逐字钉在这枚节点自己的 style 上
    expect(sel.style.width).toBe("96px");    // 点开：:37 PRIO_OPTIONS 四档原样出（顺序即选项顺序）
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    await waitFor(() => expect(
      document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").length,
    ).toBe(4));
    const optionTexts = Array.from(document.querySelectorAll(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")).map((n) => n.textContent);
    expect(optionTexts).toEqual(["P0", "P1", "P2", "P3"]);

    // 点 P3 → 显示跟手改（:252 onChange={setPriority}）
    const p3 = Array.from(document.querySelectorAll(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option"))
      .find((n) => n.textContent === "P3")!;
    fireEvent.click(p3);
    await waitFor(() => expect(sel.textContent).toContain("P3"));
    // 改档即脏（dirty useMemo :78-81 把 priority 算进去了）：保存钮文案要跟
    expect(screen.getByTestId("adb-case-save").textContent).toContain("有未保存修改");
    fireEvent.click(screen.getByTestId("adb-case-save"));
    await waitFor(() => expect(state.patched.length).toBe(1));
    // :165-168 updateCase 的请求体：priority 是改后的 P3，其余字段没被带歪
    const body = state.patched[0] as Record<string, unknown>;
    expect(body.priority).toBe("P3");
    expect(body.name).toBe("登录冒烟");
    expect(body.steps_set).toBe(true);
  });

  it("adb-case-meta：名字/优先级/设备策略三件同排；无 update 权时 meta 在场但整排禁编辑", async () => {
    const state: MockState = { patched: [] };
    mockBackend(state);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("adb-case-meta")).not.toBeNull());
    const meta = screen.getByTestId("adb-case-meta");
    // :248 的容器（antd Space → div.ant-space）恰好一个；三件按 :249→:251→:255 的源码序排
    expect(document.querySelectorAll('[data-testid="adb-case-meta"]')).toHaveLength(1);
    expect(meta.className).toContain("ant-space");
    const kids = ["case-name", "case-priority", "case-device-policy"]
      .map((id) => meta.querySelector(`[data-testid="${id}"]`)!);
    expect(kids.every(Boolean)).toBe(true);
    for (let i = 1; i < kids.length; i++) {
      // 兄弟前后序 = :249→:251→:255 的源码序（把某件挪出/挪后，位序翻转即红）
      expect(kids[i - 1].compareDocumentPosition(kids[i])
        & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    // :248 写死的内联 marginBottom（antd Space 的 display 来自组件 CSS，钉 style 位才
    // 指得到这一行；摘掉 style={{ marginBottom: 8 }} 即红）
    expect(meta.style.marginBottom).toBe("8px");

    // 对照腿（D47「隐藏不是禁用」在 meta 这一排的另一半）：控件不摘、整排 disabled。
    // 与上一条只差 my_perms 一个 fixture 位。
    cleanup();
    mockBackend(state);
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read"] } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("adb-case-meta")).not.toBeNull());
    const roMeta = screen.getByTestId("adb-case-meta");
    expect(roMeta.querySelector('[data-testid="case-name"]')).not.toBeNull();
    expect(roMeta.querySelector('[data-testid="case-priority"]')!.className).toContain("ant-select-disabled");
    expect(roMeta.querySelector('[data-testid="case-device-policy"]')!.className)
      .toContain("ant-segmented-disabled");
    // 保存钮不在 meta 里（canUpdate 关：:279 整个节点不渲染，而不是变灰）
    expect(roMeta.querySelector('[data-testid="adb-case-save"]')).toBeNull();
  });

  it("adb-case-refs：两条引用按 scenario 展开 + 步骤 key 顿号拼接；空/隐瞒两条文案互斥；拉挂 → 重试真重发", async () => {
    const refsFixture: AdbCaseReferencesOut = {
      items: [
        { scenario_id: "s1", scenario_name: "混合场景", step_keys: ["n3", "n7"] },
        { scenario_id: "s2", scenario_name: "回归场景", step_keys: [] },
      ],
      details_hidden: false,
    };
    const state: MockState = { patched: [] };
    mockBackend(state, { refs: refsFixture });
    renderPage();
    const box = await waitFor(() => {
      const n = screen.getByTestId("adb-case-refs");
      expect(screen.queryAllByTestId("adb-case-ref")).toHaveLength(2);
      return n;
    });
    // :302 容器：标题「场景引用」+ 每条 item 一行（:317 按 scenario_id 展开，不是按 step_key）
    expect(box.textContent).toContain("场景引用");
    expect(box.querySelectorAll('[data-testid="adb-case-ref"]')).toHaveLength(2);
    const rows = Array.from(box.querySelectorAll('[data-testid="adb-case-ref"]'));
    // 行①：:319 链接名 + :320-322 step_keys 非空才拼「（步骤 x、y）」（顿号 join）
    expect(rows[0].textContent).toContain("混合场景");
    expect(rows[0].textContent).toContain("（步骤 n3、n7）");
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("#/scene/s1");
    // 行②：step_keys=[] → 整段「步骤」后缀不得出现（条件渲染反证）
    expect(rows[1].textContent).toContain("回归场景");
    expect(rows[1].textContent).not.toContain("步骤");
    expect(rows[1].querySelector("a")?.getAttribute("href")).toBe("#/scene/s2");

    // 对照腿 A：空 items + 可见 → 「还没有场景引用」，隐瞒话术不得串台
    cleanup();
    mockBackend(state, { refs: { items: [], details_hidden: false } });
    renderPage();
    const emptyBox = await waitFor(() => {
      const n = screen.getByTestId("adb-case-refs");
      expect(n.textContent).toContain("还没有场景引用这条用例");
      return n;
    });
    expect(emptyBox.textContent).not.toContain("明细隐瞒");
    expect(emptyBox.querySelector('[data-testid="adb-case-ref"]')).toBeNull();

    // 对照腿 B：空 items + details_hidden → 报数量口径换成隐瞒话术（同一 items=[]，
    // 仅 details_hidden 位翻转 → 文案必须不同，防「空=一种文案」的错误因果）
    cleanup();
    mockBackend(state, { refs: { items: [], details_hidden: true } });
    renderPage();
    const hiddenBox = await waitFor(() => {
      const n = screen.getByTestId("adb-case-refs");
      expect(n.textContent).toContain("被场景引用中（你没有场景读取权限，明细隐瞒）");
      return n;
    });
    expect(hiddenBox.textContent).not.toContain("还没有场景引用");

    // 对照腿 C：refs 端点拉挂 → 「引用清单没拉到」+ 重试入口；点重试真的重发请求并恢复。
    // 全量 mock 先铺好，只把 references 端点在开关为真时掰成 500。
    cleanup();
    mockBackend(state, { refs: refsFixture });
    let refsFail = true;
    const baseFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/adb-case-references") && refsFail) {
        return { ok: false, status: 500, json: async () => ({
          code: "boom", message: "引用清单拉挂了（演示）", details: null }) } as unknown as Response;
      }
      return baseFetch(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    renderPage();
    const errBox = await waitFor(() => {
      const n = screen.getByTestId("adb-case-refs");
      expect(n.textContent).toContain("引用清单没拉到");
      return n;
    });
    // 「没有引用」≠「没拉到」：拉挂时不得装出空态（:304 refsError 分支）
    expect(errBox.textContent).not.toContain("还没有场景引用");
    // 先掰开关再点：onClick 里 references() 同步发 fetch，点在开关前 = 重试又撞 500。
    refsFail = false;
    fireEvent.click(screen.getByText("重试"));
    await waitFor(() => expect(screen.queryAllByTestId("adb-case-ref")).toHaveLength(2));
  });
});
