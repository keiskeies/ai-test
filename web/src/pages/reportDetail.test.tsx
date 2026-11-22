// 报告详情页的角色门控测试（一期 DoD 第 3 条 UI 面补洞）。
// 钉的是：[失败步骤重跑] 打的是写端点 POST /runs/{id}/rerun-step（perm=scenario:run），
// 缺位的 READONLY 连按钮都不该看见（隐藏不是禁用，口径同 schedules.tsx:479 /
// notifyChannels.tsx:403）；且按钮跟权限位走、不跟 role 字符串走——给一条只有
// `*:read + scenario:run` 的显式 my_perms，钮就要回来（§10.1 前端渲染的唯一事实源是位）。
// Canvas 用 vi.mock 换桩：@xyflow 在 jsdom 跑不动（scenePreview.test.tsx 同款分工），
// 本页要钉的是权限门与重跑接线，画布真实渲染归 e2e。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

vi.mock("../scene/Canvas", () => ({
  __esModule: true,
  default: () => <div data-testid="canvas-stub" />,
}));

// Monaco 在 jsdom 里缺 ResizeObserver（adbCaseDetail.test.tsx 同款分工）：右栏只读
// JSON 编辑器钉的不是它自己，桩成 textarea 即可。
vi.mock("../components/CodeEditor", () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <textarea data-testid="mock-monaco" value={value} readOnly />,
}));

import ReportDetailPage from "./reportDetail";
import type { ReportDetail } from "../api/report";
import { useAuth } from "../auth/store";
import { useSceneStore } from "../scene/store";
import { tp } from "../theme";

// jsdom 会把 rgba 规范化成 `rgba(31, 40, 51, 0.45)`：去空格 + 补零对齐后与 token 对表，
// 比的仍是 theme.ts 的原值而不是手抄字面量。
const normColor = (s: string) => s.replace(/\s+/g, "").replace(/,0\./g, ",.");

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

// failed 报告 + 失败步 post：自动选中（row_no=0 的 fail）→ rerunnable 为真，
// 门控生效与否在 DOM 上直接可分辨（钮在不在，而不是永远 disabled 看不出门）。
const REPORT = {
  id: "r1", subject_name: "下单链路", subject_type: "scenario", trigger: "manual",
  env_id: null, env_name: null, created_by_name: "张三", status: "failed", error: null,
  started_at: null, finished_at: null, elapsed_ms: 1200,
  stats: { total: 2, pass: 1, fail: 1, skip: 0, error: 0 }, pass_rate: 0.5,
  summary_graph: { version: 1, nodes: [{ key: "post", kind: "http_direct", name: "下单",
    config: {}, children: [], result: { status: "fail" } }] },
  steps: [
    { step_key: "login", kind: "http_direct", status: "pass", parent_step_key: null,
      subject_name: null, elapsed_ms: 300, attempts: 1, row_no: 0, pass_rows: null, total_rows: null },
    { step_key: "post", kind: "http_direct", status: "fail", parent_step_key: null,
      subject_name: null, elapsed_ms: 900, attempts: 1, row_no: 0, pass_rows: null, total_rows: null },
  ],
  artifacts: [],
} as unknown as ReportDetail;

const STEP_DETAIL = {
  step_key: "post", kind: "http_direct", status: "fail", row_no: 0, parent_step_key: null,
  subject_name: null, elapsed_ms: 900, attempts: 1, vars_snapshot: {},
  detail: { request: {}, response: null, assertions: [], logs: [],
    error: "断言失败：期望 200，实际 500" },
};

const calls: { url: string; method: string; body: unknown }[] = [];

/** 报告可换 + 按 step_key 换步骤详情载荷（缺省回落 STEP_DETAIL）的 fetch 桩。 */
function mockBackend(report: ReportDetail = REPORT, stepOverrides: Record<string, unknown> = {}) {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const resp = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
    if (url.includes("/reports/r1/steps?") && method === "GET") {
      const key = new URL("http://x" + url).searchParams.get("step_key") ?? "";
      return resp(stepOverrides[key] ?? STEP_DETAIL);
    }
    if (url.startsWith("/api/v1/reports/r1?") && method === "GET") return resp(report);
    if (url.includes("/runs/r1/rerun-step") && method === "POST") {
      return resp({ run_id: "r2", status: "passed", rerun_of: "r1" });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

// ── 截图灯箱（蓝图 :1544「截图灯箱全屏遮罩,S3」）────────────────────────
// 带 SCREENSHOT 制品的报告：post 步自动选中 → 右栏制品区出缩略图。
// 制品字节经 fetchArtifactBlob → objectURL，这里把 createObjectURL 桩成可辨认的
// 固定串（api.test.tsx:69 同款分工），灯箱内 img 的 src 必须就是它。
const ARTIFACT_URL = "blob:shot-screenshot";
const REPORT_SHOT = {
  ...REPORT,
  artifacts: [{ kind: "SCREENSHOT", step_key: "post", ref: "r1/fail.png", bytes: 69 }],
} as unknown as ReportDetail;

// 制品桩的三种字节模式：ok（默认，立即 200）/ gate（挂到手动 release 才回，
// fail 档带 404 信封）/ artifact-500（制品请求直接 500，覆盖 toast 分支）。
type ArtifactMode =
  | { kind: "ok" }
  | { kind: "artifact-500" }
  | { kind: "gate"; gate: Promise<"ok" | "fail"> }
  | { kind: "gate-json"; gate: Promise<void> };

function mockArtifactBackend(mode: ArtifactMode = { kind: "ok" },
  report: ReportDetail = REPORT_SHOT) {
  calls.length = 0;
  (URL as { createObjectURL: unknown }).createObjectURL =
    vi.fn(() => ARTIFACT_URL);
  (URL as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url, method: "GET", body: undefined });
    if (url.includes("/api/v1/artifacts/")) {
      const json = (code: string, message: string) =>
        ({ ok: false, status: 404, json: async () => ({ code, message }) }) as unknown as Response;
      if (mode.kind === "artifact-500")
        return json("artifact_expired", "制品已过期");
      if (mode.kind === "gate") {
        const r = await mode.gate;
        if (r === "fail") return json("artifact_expired", "制品已过期");
      }
      if (mode.kind === "gate-json") await mode.gate;
      return { ok: true, status: 200,
        blob: async () => new Blob([new Uint8Array([1])], { type: "image/png" }) } as unknown as Response;
    }
    const resp = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
    if (url.includes("/reports/r1/steps?")) return resp(STEP_DETAIL);
    if (url.startsWith("/api/v1/reports/r1?")) return resp(report);
    throw new Error("未 mock 的请求: GET " + url);
  }) as unknown as typeof fetch;
}

async function renderWithShot() {
  mockArtifactBackend();
  renderPage();
  await screen.findByTestId("report-artifact-img");
}

// 「让 Pilot 总结失败原因」的落点桩页：不 mock useNavigate，而是真导航到 /bench，
// 用 useLocation().state 把「路由真的把 pilotDraft 送到了目的地」钉死——
// 这正是 bench 侧（兄弟任务）读取 pilotDraft 的同一条通路。
function BenchLand() {
  const loc = useLocation();
  const draft = (loc.state as { pilotDraft?: string } | null)?.pilotDraft ?? "";
  return <div data-testid="landed-bench">{draft}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/reports/r1"]}>
      <Routes>
        {/* 静态段 /reports/r2 优先于 /reports/:id 匹配：重跑成功跳转的落点用桩页钉死 */}
        <Route path="/reports/r2" element={<div data-testid="landed-new-report" />} />
        {/* rerun_of 来源链接（r1 由 r0 重跑而来）的落点：同样静态段优先 */}
        <Route path="/reports/r0" element={<div data-testid="landed-origin-report" />} />
        <Route path="/reports/:id" element={<ReportDetailPage />} />
        <Route path="/bench" element={<BenchLand />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ── 通过率环：概览卡**外壳**里确实存着第二份副本 ────────────────────────────
// report-overview-pass-rate 上的 data-percent 是 e2e 钉着的契约
// （web/e2e/reports.spec.mjs 在多个场景上断言它的值：50 / 100 / 0 与一个 expectedPct），
// 所以这份副本删不得 —— 与 planDetail 那种「外壳改挂原值 data-rate」的解法在这里不通用。
// 于是钉法换成**不变量**：同一张页上外壳那份与环那份必须逐字相等。
// 为什么这比各钉一个字面量强：两份各自都对时字面量断言全绿，只有「两处同源」这件事
// 被钉住，才有人改坏一处就红（6b V1 变异实测的正是各算各的、断言只钉住一份）。
describe("通过率环的两份 data-percent 必须同源（e2e 契约副本不可各算各的）", () => {
  async function ringsOf(report: ReportDetail) {
    mockBackend(report);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("report-overview")).not.toBeNull());
    const shell = screen.getByTestId("report-overview-pass-rate");
    const ring = within(shell).getByTestId("report-pass-rate");
    return { shell: shell.getAttribute("data-percent"), ring: ring.getAttribute("data-percent") };
  }

  it("有跳步的报告：两处都跟后端 pass_rate 走，且彼此相等", async () => {
    // pass=2、total=4、skip=1 ⇒ 后端 `def _pass_rate` 给 2/(4−1)=0.666→**67**；
    // 谁要是拿 pass/total 现攒就得到 50。三个数互不相同，红了能直接读出是谁在算。
    const { shell, ring } = await ringsOf({
      ...REPORT,
      stats: { total: 4, pass: 2, fail: 1, skip: 1, error: 0 }, pass_rate: 2 / 3,
    } as unknown as ReportDetail);
    expect(ring).toBe("67"); // 环（唯一该算的那份）
    expect(shell).toBe("67"); // e2e 契约副本，不许自己算出第二个数
    expect(shell).toBe(ring); // 不变量本身
  });

  it("全跳步（分母 ≤0，后端给 null）：两处都画空值，不许画 0", async () => {
    const { shell, ring } = await ringsOf({
      ...REPORT, status: "skipped",
      stats: { total: 3, pass: 0, fail: 0, skip: 3, error: 0 }, pass_rate: null,
    } as unknown as ReportDetail);
    expect(ring).toBe(""); // 「0%」是结论（全挂），空值是没结论——混了就是撒谎
    expect(shell).toBe("");
    expect(within(screen.getByTestId("report-overview-pass-rate"))
      .getByTestId("report-pass-rate").textContent).toBe("-");
  });
});

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("reportDetail 权限门（重跑 = scenario:run 写端点）", () => {
  it("READONLY（*:read,-system:*）：重跑钮压根不在 DOM；列表钮照在（读面不动）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("report-overview")).not.toBeNull());
    expect(screen.queryByTestId("report-rerun")).toBeNull();
    expect(screen.getByText("返回列表")).not.toBeNull();
  });

  it("PROJECT_ADMIN（*）：钮在，且选中失败步后可点 → POST rerun-step 并跳新报告", async () => {
    mockBackend();
    renderPage();
    const btn = await screen.findByTestId("report-rerun");
    // 自动选中第一个失败步：rerunnable 成立，按钮不得是 disabled 假门
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some(
      (c) => c.method === "POST" && c.url.includes("/runs/r1/rerun-step"))).toBe(true));
    const c = calls.find((x) => x.url.includes("/rerun-step"))!;
    expect(c.body).toEqual({ project_id: "p1", step_key: "post" });
    await waitFor(() => expect(screen.getByTestId("landed-new-report")).not.toBeNull());
  });

  it("换显式 my_perms（*:read + scenario:run，role 串仍写 READONLY）：钮回来——跟位走不跟 role 走", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY",
      my_perms: ["*:read", "-system:*", "scenario:run"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("report-rerun")).not.toBeNull());
  });

  it("无 scenario:run 的自定义位集（scenario:* 读写齐但剥掉 run）：钮同样不在 DOM", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER",
      my_perms: ["scenario:create", "scenario:update", "scenario:read"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("report-overview")).not.toBeNull());
    expect(screen.queryByTestId("report-rerun")).toBeNull();
  });

  it("可重跑口径不放宽：选中通过步 → 钮仍在（有权限）但 disabled，交给 Tooltip 说原因", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("report-rerun")).not.toBeNull());
    // 点通过步（树里 hint 序 post 在前，login 排第二）：选中它，rerunnable 掉 → 按钮 disabled
    const rows = screen.getAllByTestId("report-step-row");
    const loginRow = rows.find((r) => r.getAttribute("data-key") === "login")!;
    fireEvent.click(loginRow);
    const btn = screen.getByTestId("report-rerun");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
  });
});

// 报告详情 → Pilot 预填（D84 诚实切片）：点「让 Pilot 总结失败原因」只导航 +
// 带 state.pilotDraft 落进 bench 输入框（发送键在人手里），不发任何请求建会话。
// 钉四条：有失败步时钮在且可点；草稿带失败步名+其报错（逐子串断言，不整串对表）；
// 步骤全过但有运行级报错时草稿照常带上下文、不写失败步小节（D143 后「无失败步」这一
// 形状已经没有入口，见下面那条翻案注释）；超上限只列前 8 个并明说截断、总长不破 20000。
describe("报告详情 → Pilot 草稿预填（nav state）", () => {
  // 无失败步的对照报告：全 pass、无运行级报错
  const REPORT_CLEAN = {
    ...REPORT,
    status: "passed", error: null, pass_rate: 1,
    stats: { total: 2, pass: 2, fail: 0, skip: 0, error: 0 },
    steps: REPORT.steps.map((s) => ({ ...s, status: "pass" })),
    summary_graph: { version: 1, nodes: [
      { key: "login", kind: "http_direct", name: "登录", config: {}, children: [], result: { status: "pass" } },
      { key: "post", kind: "http_direct", name: "下单", config: {}, children: [], result: { status: "pass" } }] },
  } as unknown as ReportDetail;

  // 10 个失败步（> 代码里声明的每份草稿 8 个上限）
  const REPORT_MANY = {
    ...REPORT,
    stats: { total: 10, pass: 0, fail: 10, skip: 0, error: 0 }, pass_rate: 0,
    steps: Array.from({ length: 10 }, (_, i) => ({
      step_key: "f" + (i + 1), kind: "http_direct", status: "fail", parent_step_key: null,
      subject_name: "步" + (i + 1), elapsed_ms: 10, attempts: 1, row_no: 0,
      pass_rows: null, total_rows: null,
    })),
    summary_graph: null,
  } as unknown as ReportDetail;

  /** 报告可换的 fetch 桩：步骤详情按 step_key 回各自的报错。 */
  function mockReport(report: ReportDetail, stepErrors: Record<string, string> = {}) {
    calls.length = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: undefined });
      const resp = (json: unknown) =>
        ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      if (url.includes("/reports/r1/steps?") && method === "GET") {
        const key = new URL("http://x" + url).searchParams.get("step_key") ?? "";
        return resp({ step_key: key, kind: "http_direct", status: "fail", row_no: 0,
          parent_step_key: null, subject_name: null, elapsed_ms: 1, attempts: 1,
          vars_snapshot: {}, detail: { error: stepErrors[key] ?? null } });
      }
      if (url.startsWith("/api/v1/reports/r1?") && method === "GET") return resp(report);
      throw new Error("未 mock 的请求: " + method + " " + url);
    }) as unknown as typeof fetch;
  }

  it("有失败步的报告：按钮存在且可点（不挂权限门、不 disabled）", async () => {
    mockBackend();
    renderPage();
    const btn = await screen.findByTestId("report-ask-pilot");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("点击 → 真导航到 /bench，state.pilotDraft 带失败步名与其报错、报告名与运行状态", async () => {
    mockBackend(); // STEP_DETAIL.detail.error = 「断言失败：期望 200，实际 500」
    renderPage();
    fireEvent.click(await screen.findByTestId("report-ask-pilot"));
    const landed = await screen.findByTestId("landed-bench");
    const draft = landed.textContent ?? "";
    // 失败步行：stepTreeLabel 取图上的节点名「下单」（subject_name 为 null 时的真名），
    // 行格式「序号. 名 · kind · 状态标签」是拼装的骨架，逐段钉死
    expect(draft).toContain("1. 下单 · http_direct · 断言失败");
    expect(draft).toContain("断言失败：期望 200，实际 500");
    // 报告级上下文：对象名 + 类型词表标签 + 状态词表标签
    expect(draft).toContain("下单链路（场景）");
    expect(draft).toContain("断言失败"); // STATUSES.failed
    expect(draft).toContain("失败步骤");
    // REPORT.error 为 null → 不许出现「运行级报错」行（缺字段就整行省略，不写 unknown）
    expect(draft).not.toContain("运行级报错");
  });

  // D143 翻案（本轮）：这里原本有一条「对照：没有失败步 → 仍然导航，但草稿不含失败步骤小节」，
  // 钉的是「通过报告也照导航」——那正是 D143 判死的形状（草稿第一句断言有失败，屏幕写着「通过」）。
  // 它的前半句（无失败步不许写失败小节）本身是对的，只是所附的入口没了：门落下后
  // 「无失败步还能点这支钮」在界面上不可达，所以钉它 = 钉一个画不出来的形状。
  // 下面那条把这条口径搬到门内仍可到达的形状上（步骤全过、只有运行级报错），断言一字不减。
  it("步骤全过、只有运行级报错：草稿照常带报告上下文，但不写任何失败步骤小节", async () => {
    mockReport({ ...REPORT_CLEAN, status: "error", error: "请求失败：连接被拒绝" } as unknown as ReportDetail);
    renderPage();
    fireEvent.click(await screen.findByTestId("report-ask-pilot"));
    const landed = await screen.findByTestId("landed-bench");
    const draft = landed.textContent ?? "";
    expect(draft).toContain("下单链路（场景）"); // 报告上下文照常带
    expect(draft).toContain("运行级报错：请求失败：连接被拒绝"); // 有的那条照写
    // 实测而非推理：没有失败步就不该有小节标题，也不该有编号行
    expect(draft).not.toContain("失败步骤");
    expect(draft).not.toMatch(/^\d+\. /m);
  });

  it("上限：10 个失败步只列前 8 个并明说截断；草稿长度 < 20000", async () => {
    const errs: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) errs["f" + i] = "第 " + i + " 步断言挂了";
    mockReport(REPORT_MANY, errs);
    renderPage();
    fireEvent.click(await screen.findByTestId("report-ask-pilot"));
    const landed = await screen.findByTestId("landed-bench");
    const draft = landed.textContent ?? "";
    // 明说截断口径：总数 10、只列 8
    expect(draft).toContain("共 10 个，只列前 8 个");
    // 只列前 8：编号行恰好 8 条，第 8 在、第 9 不在（f8 列了、f9/f10 没列）
    expect(draft.match(/^\d+\. /gm)).toHaveLength(8);
    expect(draft).toContain("步8");
    expect(draft).not.toContain("步9");
    expect(draft).not.toContain("步10");
    expect(draft.length).toBeLessThan(20000);
  });
});

// D143：出口门——草稿第一句就是断言「这份报告有失败原因」，通过报告上按钮照挂、
// 草稿照写，屏幕与稿子自相矛盾（蓝图 :1428 把这支出口钉在「带失败步骤上下文」上）。
// 口径与草稿自身同源：row_no=0 的 fail/error 汇总行，或运行级 report.error；
// 都不满足就整支不渲染（隐藏不是禁用，同 api/DebugPanel.tsx:59 / adbCaseDetail.tsx:16）。
describe("报告详情 Pilot 出口的失败态门（D143）", () => {
  // 全通过 + 无运行级报错：门的两条腿都落空
  const ALL_PASS = {
    ...REPORT,
    status: "passed", error: null, pass_rate: 1,
    stats: { total: 2, pass: 2, fail: 0, skip: 0, error: 0 },
    steps: REPORT.steps.map((s) => ({ ...s, status: "pass" })),
  } as unknown as ReportDetail;

  // 步骤全过、只有运行级报错：report.error 那条腿必须单独撑得起门
  const RUN_ERROR_ONLY = {
    ...ALL_PASS, status: "error", error: "请求失败：连接被拒绝",
  } as unknown as ReportDetail;

  // 失败步挂在 row_no=1（明细行）而不是汇总行：门与草稿同源（row_no=0 口径），不是「任意行」
  const FAIL_ONLY_DETAIL_ROW = {
    ...REPORT,
    steps: [
      REPORT.steps[0],
      { ...REPORT.steps[1], row_no: 1 },
    ],
  } as unknown as ReportDetail;

  it("通过报告（全 pass 步 + 无运行级报错）：按钮压根不在 DOM——通过报告没有「失败原因」可总结", async () => {
    mockBackend(ALL_PASS);
    renderPage();
    await screen.findByTestId("report-overview");
    expect(screen.queryByTestId("report-ask-pilot")).toBeNull();
  });

  it("失败报告：按钮在且可点，点出的草稿第一句就是那句断言「请帮我总结这份运行报告的失败原因」", async () => {
    mockBackend(REPORT);
    renderPage();
    const btn = await screen.findByTestId("report-ask-pilot");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    const landed = await screen.findByTestId("landed-bench");
    // 首句即断言：门放行后草稿的开头必须还是蓝图钉死的那句原话（label 与草稿同源）
    expect((landed.textContent ?? "")
      .startsWith("请帮我总结这份运行报告的失败原因。")).toBe(true);
  });

  it("步骤全过但有运行级报错：按钮照在——report.error 那条腿独立成立，门不是只看步骤", async () => {
    mockBackend(RUN_ERROR_ONLY);
    renderPage();
    expect(await screen.findByTestId("report-ask-pilot")).not.toBeNull();
  });

  it("败步只在 row_no=1 明细行（无汇总行败步、无运行级报错）：按钮不在——门按草稿的 row_no=0 口径判，不是「任意行有败」", async () => {
    mockBackend(FAIL_ONLY_DETAIL_ROW);
    renderPage();
    await screen.findByTestId("report-overview");
    expect(screen.queryByTestId("report-ask-pilot")).toBeNull();
  });
});

// 蓝图 :1544「截图灯箱全屏遮罩,S3」：点缩略图必须开**页内灯箱**（role=dialog +
// tp.mask 遮罩 + tp.shadow.s3），不是 window.open 新标签页。断言全部在灯箱节点
// 内部查 img——只断「函数被调」的测试换不回这条蓝图。
describe("报告详情截图灯箱（:1544 全屏遮罩 + S3）", () => {
  it("点缩略图 → 页内灯箱打开：dialog 内包着 src=制品 objectURL 的 img；不开新标签页", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderWithShot();
    // 未点击前灯箱不在 DOM
    expect(screen.queryByTestId("report-artifact-lightbox")).toBeNull();
    fireEvent.click(screen.getByTestId("report-artifact-img-open"));
    const lb = screen.getByTestId("report-artifact-lightbox");
    expect(lb.getAttribute("role")).toBe("dialog");
    expect(lb.getAttribute("aria-label")).toContain("fail.png");
    // 灯箱必须是全屏遮罩 + S3 阴影（值与 theme 对表，不是像但不是的近似值）
    expect(lb.style.position).toBe("fixed");
    expect(normColor(lb.style.background)).toBe(normColor(tp.mask));
    // 遮罩色与阴影在同一节点树内：shadow 挂在灯箱内的图上（getComputedStyle 在 jsdom
    // 不解析行内 boxShadow 速写，故比对行内串对 theme token）
    const shot = screen.getByTestId("report-artifact-lightbox-img");
    expect(shot.closest("[data-testid='report-artifact-lightbox']")).toBe(lb);
    // jsdom 会重排 boxShadow 速写（色前置、0→0px）：按 s3 的三个构件对表——
    // 独属 s3 的 .14 透明度 + 12px/32px 偏移（s1/s2 的 .05/.08 挡在这一条外）
    const bs = normColor((shot.parentElement as HTMLElement).style.boxShadow);
    const s3 = tp.shadow.s3;
    expect(bs).toContain(normColor(s3.slice(s3.indexOf("rgba"))));
    expect(bs).toContain("12px");
    expect(bs).toContain("32px");
    expect(shot.getAttribute("src")).toBe(ARTIFACT_URL);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("Escape → 灯箱消失（缩略图还在，页面没塌）", async () => {
    await renderWithShot();
    fireEvent.click(screen.getByTestId("report-artifact-img-open"));
    expect(screen.getByTestId("report-artifact-lightbox")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("report-artifact-lightbox")).toBeNull();
    expect(screen.getByTestId("report-artifact-img")).not.toBeNull();
  });

  it("遮罩空白处点击 → 关；灯箱内图片上点击 → 不关（否则看图即误关）", async () => {
    await renderWithShot();
    fireEvent.click(screen.getByTestId("report-artifact-img-open"));
    const lb = screen.getByTestId("report-artifact-lightbox");
    fireEvent.mouseDown(screen.getByTestId("report-artifact-lightbox-img"));
    expect(screen.queryByTestId("report-artifact-lightbox")).not.toBeNull();
    fireEvent.mouseDown(lb);
    expect(screen.queryByTestId("report-artifact-lightbox")).toBeNull();
  });

  it("显式关闭钮 → 灯箱消失，且可再次打开", async () => {
    await renderWithShot();
    fireEvent.click(screen.getByTestId("report-artifact-img-open"));
    fireEvent.click(screen.getByTestId("report-artifact-lightbox-close"));
    expect(screen.queryByTestId("report-artifact-lightbox")).toBeNull();
    fireEvent.click(screen.getByTestId("report-artifact-img-open"));
    expect(screen.getByTestId("report-artifact-lightbox")).not.toBeNull();
  });

  it("灯箱内「看原图」= 灯箱专属的 objectURL 出口：href 是 blob（裸 /api/v1 路径点开是 401），缩略图态零外漏", async () => {
    await renderWithShot();
    // 未开灯箱：这条「跳过灯箱直达原图」的第二条路必须不存在
    expect(screen.queryByTestId("report-artifact-lightbox-origin")).toBeNull();
    fireEvent.click(screen.getByTestId("report-artifact-img-open"));
    const lb = screen.getByTestId("report-artifact-lightbox");
    const origin = within(lb).getByTestId("report-artifact-lightbox-origin");
    // href 必须挂制品字节换出的 objectURL（fetchArtifactBlob 带 token 的那条路），
    // 换成裸 /api/v1/artifacts/... 就是「点开 401」的回归
    expect(origin.getAttribute("href")).toBe(ARTIFACT_URL);
    expect(origin.getAttribute("target")).toBe("_blank");
    expect(origin.getAttribute("rel")).toContain("noreferrer");
    // 整个文档里带 blob href 的锚点只此一个：原图出口不另立山头
    const blobLinks = Array.from(document.querySelectorAll("a"))
      .filter((a) => (a.getAttribute("href") ?? "").startsWith("blob:"));
    expect(blobLinks).toHaveLength(1);
  });
});

// ── 第十八轮补测：同一区域的三态不许互相冒充 ────────────────────────────
// 报告在取 / 报告带着运行级报错落地 / 干净的落地：同一块概览区给出三种可分辨的东西。
// report-loading（:349）与 report-overview-error（:515）都是这一判据的构件。
describe("报告详情三态（report-loading / report-overview-error）", () => {
  it("报告在取：页面上只有 report-loading 转圈，概览卡与步骤区不许提前出现；落地后转圈让位", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/reports/r1?")) {
        await gate;
        return { ok: true, status: 200, json: async () => REPORT } as unknown as Response;
      }
      if (url.includes("/reports/r1/steps?")) {
        return { ok: true, status: 200, json: async () => STEP_DETAIL } as unknown as Response;
      }
      throw new Error("未 mock 的请求: " + url);
    }) as unknown as typeof fetch;
    renderPage();
    const loading = await screen.findByTestId("report-loading");
    expect(loading.classList.contains("ant-spin")).toBe(true);
    expect(screen.queryByTestId("report-overview")).toBeNull();
    expect(screen.queryByTestId("report-step-row")).toBeNull();
    expect(screen.queryByTestId("report-overview-error")).toBeNull();
    release();
    await screen.findByTestId("report-overview");
    expect(screen.queryByTestId("report-loading")).toBeNull();
  });

  it("report.error：概览卡内出「运行结论」Alert，描述逐字=快照原文；干净报告同一位置零残留", async () => {
    // 特例映射先钉：这条快照的标题本身就是结论，不许再套「运行结论」的壳
    mockBackend({ ...REPORT, error: "执行进程中断" });
    renderPage();
    const interrupted = await screen.findByTestId("report-overview-error");
    expect(interrupted.textContent).toContain("执行进程中断");
    expect(interrupted.textContent).not.toContain("运行结论");
    cleanup();

    mockBackend({ ...REPORT, error: "runner 在 step=post 处超时" });
    renderPage();
    const alert = await screen.findByTestId("report-overview-error");
    // 卡必须长在概览卡里面（区域归属），而不是页面角落飘一张无主 Alert
    expect(screen.getByTestId("report-overview").contains(alert)).toBe(true);
    expect(alert.classList.contains("ant-alert-error")).toBe(true);
    expect(alert.textContent).toContain("运行结论");
    expect(alert.textContent).toContain("runner 在 step=post 处超时");
    cleanup();

    // 对照：REPORT.error === null → 成功壳不许自带一张空报错壳
    mockBackend();
    renderPage();
    await screen.findByTestId("report-overview");
    expect(screen.queryByTestId("report-overview-error")).toBeNull();
  });
});

// 步骤 detail.error（report-detail-error）：有 → 报错卡且描述逐字；无 → 整卡不渲染
// （空描述 Alert 就是装样子）；换选步骤 → 卡跟着步骤的数据走。
describe("步骤报错卡（report-detail-error）", () => {
  const LOGIN_DETAIL = {
    step_key: "login", kind: "http_direct", status: "pass", row_no: 0, parent_step_key: null,
    subject_name: null, elapsed_ms: 300, attempts: 1, vars_snapshot: {},
    detail: { request: {}, response: null, assertions: [], logs: [], error: null },
  };

  it("post（detail.error 有值）→ 卡内描述逐字；换选 login（error:null）→ 整卡消失而页不塌", async () => {
    mockBackend(REPORT, { login: LOGIN_DETAIL });
    renderPage();
    // 自动选中 post → 报错卡出现，描述就是快照里的报错原文
    const alert = await screen.findByTestId("report-detail-error");
    expect(alert.classList.contains("ant-alert-error")).toBe(true);
    expect(alert.textContent).toContain("步骤报错");
    expect(alert.textContent).toContain("断言失败：期望 200，实际 500");
    // login 步详情此刻一次都没取过：没选中的步骤不许把详情悄悄拉出来
    expect(calls.some((c) => c.url.includes("step_key=login"))).toBe(false);

    // 换选通过步：r2 静态段未注册，点击安全
    fireEvent.click(screen.getAllByTestId("report-step-row")
      .find((r) => r.getAttribute("data-key") === "login")!);
    await waitFor(() => expect(screen.queryByTestId("report-detail-error")).toBeNull());
    // 右栏仍是活的工作区（step_key 标题在），不是整块塌了才「没有报错」。
    // 必须等内容而不是等壳：`report-step-detail` 是个**常驻空壳**（reportDetail.tsx:548 无条件
    // 渲染），换步后先转 Spin；上面那个 waitFor 在「loading 期 error 也不在」时就已成立，
    // 于是同步 getByText 会在满载的全量 ⑥ 里读到空壳（实测 2026-11-18 红过一次）。
    await waitFor(() => expect(screen.getByTestId("report-step-detail").textContent).toContain("login"));
  });
});

// 截图制品的取字节三态（report-artifact-img-loading / -error）：pending → loading 文案、
// 失败 → Alert+重试、重试成功 → img。三态在制品区互斥，装绿（失败还留图）当场红。
describe("截图制品三态（report-artifact-img-loading / report-artifact-img-error）", () => {
  async function renderGatedShot() {
    let release: (v: "ok" | "fail") => void = () => {};
    const gate = new Promise<"ok" | "fail">((res) => { release = res; });
    mockArtifactBackend({ kind: "gate", gate });
    renderPage();
    const loading = await screen.findByTestId("report-artifact-img-loading");
    return { loading, release };
  }

  it("在取：制品区只有「截图加载中…」，img 不许提前出现；字节落地后 loading 让位给 img", async () => {
    const { loading, release } = await renderGatedShot();
    expect(loading.textContent).toContain("截图加载中…");
    expect(screen.queryByTestId("report-artifact-img")).toBeNull();
    expect(screen.queryByTestId("report-artifact-img-error")).toBeNull();
    release("ok");
    const img = await screen.findByTestId("report-artifact-img");
    expect(img.getAttribute("src")).toBe(ARTIFACT_URL);
    expect(screen.queryByTestId("report-artifact-img-loading")).toBeNull();
  });

  it("取失败：碎图标/空壳都不许留——Alert 说清后端 message；点重试只再取一次字节并回到 img", async () => {
    const { release } = await renderGatedShot();
    release("fail");
    const alert = await screen.findByTestId("report-artifact-img-error");
    expect(alert.textContent).toContain("截图取不到");
    expect(alert.textContent).toContain("制品已过期"); // 信封 message 逐字上屏
    expect(screen.queryByTestId("report-artifact-img")).toBeNull();
    expect(screen.queryByTestId("report-artifact-img-loading")).toBeNull();

    // gate 已 settle，重试点不能再吃同一个桩：换成 ok 模式再点（calls 随之清零，
    // 下一步才能钉「重试只重取制品字节」这一条最小请求集）
    mockArtifactBackend();
    // antd 给两汉字按钮名自动插空格（「重 试」）：name 用 /\s*/ 容忍
    fireEvent.click(within(alert).getByRole("button", { name: /重\s*试/ }));
    await screen.findByTestId("report-artifact-img");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/artifacts/r1/fail.png?project_id=p1",
    ]);
    expect(screen.queryByTestId("report-artifact-img-error")).toBeNull();
  });
});

// 非截图制品（report-artifact-link）：裸 href 点开是 401（R107 实测），所以锚点必须
// 没有 href，点击走带鉴权 fetch → objectURL → window.open；取不到则 toast + 不开窗。
describe("非截图制品链接（report-artifact-link：点击走带鉴权 fetch，不开裸 href）", () => {
  const REPORT_FILE = {
    ...REPORT,
    artifacts: [{ kind: "DOM", step_key: "post", ref: "r1/page.html", bytes: 123 }],
  } as unknown as ReportDetail;

  it("无 href、标签带 kind/名/字节数；点击先带 token 取字节再 open(objectURL)，取回前链接哑火", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    mockArtifactBackend({ kind: "gate-json", gate }, REPORT_FILE);
    renderPage();
    const link = await screen.findByTestId("report-artifact-link");
    expect(link.textContent).toBe("DOM · page.html（123B）");
    expect(link.getAttribute("href")).toBeNull(); // 裸 href 回归 = 点开 401

    fireEvent.click(link);
    expect(link.style.opacity).toBe("0.5"); // 在途哑火（pointerEvents:none），防双击二开
    expect(openSpy).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(ARTIFACT_URL, "_blank"));
    // 取字节那条请求就是带 project_id 的制品端点，不是拼出来的裸路径
    expect(calls.some((c) => c.url === "/api/v1/artifacts/r1/page.html?project_id=p1")).toBe(true);
    await waitFor(() => expect(link.style.opacity).toBe(""));
    openSpy.mockRestore();
  });

  it("取不到：后端 message 上 toast，window.open 一次都不调（不开 about:blank 假窗）", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    mockArtifactBackend({ kind: "artifact-500" }, REPORT_FILE);
    renderPage();
    const link = await screen.findByTestId("report-artifact-link");
    fireEvent.click(link);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/artifacts/"))).toBe(true));
    await waitFor(() => expect(document.body.textContent).toContain("制品已过期"));
    expect(openSpy).not.toHaveBeenCalled();
    // toast 之后链接恢复可用（busy 收尾），不永久卡死
    await waitFor(() => expect(link.style.opacity).toBe(""));
    openSpy.mockRestore();
  });
});

// R22-修复5：制品区标题不许再承诺「超阈值」——64KB 阈值只在 offload_detail（step detail
// 内大字段外置，不产生本区条目），本区条目来自 save_artifact 的无条件入库：3KB 截图也在这。
describe("制品区标题（说的是入库机制，不是没发生的阈值）", () => {
  it("标题是「制品（截图/DOM 等外置的原始字节）」，「超阈值」三字不在制品区", async () => {
    mockArtifactBackend();
    renderPage();
    const img = await screen.findByTestId("report-artifact-img");
    const zone = img.closest("div")!.parentElement!;
    expect(zone.textContent).toContain("制品（截图/DOM 等外置的原始字节）");
    expect(zone.textContent).not.toContain("超阈值");
  });
});

// 只读画布（report-canvas）：Canvas 在 jsdom 换桩，这里钉两件事——
// ① 桩件确实长在 report-canvas 这块区域里；② 灌给画布的是这份报告快照自己的终态
// （scene store.run.stepStatus 就是 Canvas 的着色数据源，login 不在图上就不许有颜色）。
describe("只读画布（report-canvas ← summary_graph 快照）", () => {
  it("桩画布挂在 report-canvas 内；节点与终态色来自本报告的 summary_graph，不是 steps 的并集", async () => {
    mockBackend();
    renderPage();
    await screen.findByTestId("report-overview");
    const canvas = screen.getByTestId("report-canvas");
    expect(within(canvas).getByTestId("canvas-stub")).not.toBeNull();
    const s = useSceneStore.getState();
    expect(s.readOnly).toBe(true);
    expect(s.nodes.map((n) => n.key)).toEqual(["post"]); // 图上只有 post；steps 里有 login
    expect(s.run.stepStatus.post.status).toBe("fail"); // 终态色取 result.status
    expect(s.run.stepStatus.login).toBeUndefined(); // 图上没有的步不许被染上色
  });
});

// 单步重跑报告的来源链接（report-rerun-origin）：rerun_of 在场才出现，点击落到
// **原报告**的详情路由（/reports/{rerun_of}），而不是当前页或列表页。
describe("重跑来源链接（report-rerun-origin）", () => {
  const REPORT_RERUN = {
    ...REPORT,
    stats: { ...REPORT.stats, rerun_of: "r0", rerun_step: "post" },
  } as unknown as ReportDetail;

  it("普通报告零残留；rerun_of=r0 的报告给出来源链接，点击导航到 /reports/r0", async () => {
    mockBackend();
    renderPage();
    await screen.findByTestId("report-overview");
    expect(screen.queryByTestId("report-rerun-origin")).toBeNull();
    cleanup();

    mockBackend(REPORT_RERUN);
    renderPage();
    // 概览标题的紫色徽标与段落同源（stats.rerun_step）：先确认它说的就是重跑 post
    await screen.findByTestId("report-overview");
    expect(screen.getByTestId("report-overview").textContent).toContain("单步重跑 post");
    const link = await screen.findByTestId("report-rerun-origin");
    fireEvent.click(link);
    // 落点路由是 /reports/r0 的桩页：导航到 r1 自己或 /reports 列表都到不了这里
    await screen.findByTestId("landed-origin-report");
  });
});

// UI 步右栏分流（report-cmd-message / report-ui-commands / report-ui-vars）：
// 全部按**行/键**绑定断言（within），上一轮在这类表上抓到过「标签挂错行」的假绿。
// UI 载荷放在模块级：ADB 那组要用它当「反方向」对照（同一条判据不能只钉一支）。
const UI_REPORT = {
  ...REPORT,
  subject_type: "ui_case",
  steps: [{ step_key: "case", kind: "ui_case", status: "fail", parent_step_key: null,
    subject_name: "登录案", elapsed_ms: 800, attempts: 1, row_no: 0,
    pass_rows: null, total_rows: null }],
  summary_graph: { version: 1, nodes: [{ key: "case", kind: "ui_case", name: "UI 登录案",
    config: {}, children: [], result: { status: "fail" } }] },
} as unknown as ReportDetail;

const UI_DETAIL = {
  step_key: "case", kind: "ui_case", status: "fail", row_no: 0, parent_step_key: null,
  subject_name: "登录案", elapsed_ms: 800, attempts: 1,
  vars_snapshot: { token: "tk-9", uid: "7" },
  detail: {
    message: "命令 2/3 失败：点击超时",
    error: "命令 u2 失败",
    commands: [
      { id: "u1", type: "navigate", status: "pass", message: "已进入登录页", elapsed_ms: 120 },
      { id: "u2", type: "click", status: "fail", message: "点击超时", elapsed_ms: 3000,
        assertions: [{ type: "status", passed: false, expected: 200, actual: 500 }] },
    ],
  },
};

describe("UI 步右栏：命令时间线 / 回执 / 变量快照（行级绑定）", () => {
  const UI_DETAIL_NOVARS = { ...UI_DETAIL, vars_snapshot: {} };

  function uiRow(id: string) {
    const row = screen.getAllByTestId("report-cmd-row")
      .find((r) => r.getAttribute("data-id") === id)!;
    return within(row);
  }

  it("命令时间线：标题条数=行数；u1/u2 各说各话——状态标签/回执/耗时按行绑定不串台", async () => {
    mockBackend(UI_REPORT, { case: UI_DETAIL });
    renderPage();
    const box = await screen.findByTestId("report-ui-commands");
    expect(box.textContent).toContain("命令时间线（2）");
    const rows = within(box).getAllByTestId("report-cmd-row");
    expect(rows).toHaveLength(2);
    // u1：只许出现自己的回执与「通过」标签；u2 的失败话语一个都不许漏进这行
    const r1 = uiRow("u1");
    expect(r1.getByText("已进入登录页")).not.toBeNull();
    expect(r1.getByText("通过")).not.toBeNull();
    expect(r1.getByText("120ms")).not.toBeNull();
    expect(r1.queryByText("断言失败")).toBeNull();
    expect(r1.queryByText("点击超时")).toBeNull();
    // u2：STEP_STATUSES.fail 的标签是「断言失败」，回执是自己的那条
    const r2 = uiRow("u2");
    expect(r2.getByText("断言失败")).not.toBeNull();
    expect(r2.getByText("点击超时")).not.toBeNull();
    expect(r2.queryByText("已进入登录页")).toBeNull();
  });

  it("命令时间线空态：没有命令行时明说数据缺失，标题 0 且零行（不摆空表装跑过）", async () => {
    mockBackend(UI_REPORT, {
      case: { ...UI_DETAIL, detail: { ...UI_DETAIL.detail, commands: [], message: null } },
    });
    renderPage();
    const box = await screen.findByTestId("report-ui-commands");
    expect(box.textContent).toContain("命令时间线（0）");
    expect(within(box).queryAllByTestId("report-cmd-row")).toHaveLength(0);
    expect(box.textContent).toContain("这次运行没有留下命令行");
  });

  it("report-cmd-message：回执逐字=detail.message；HTTP 步带同样的 message 也不给回执位（hideHttp 分流）", async () => {
    mockBackend(UI_REPORT, { case: UI_DETAIL });
    renderPage();
    const msg = await screen.findByTestId("report-cmd-message");
    expect(msg.textContent).toBe("命令 2/3 失败：点击超时");
    cleanup();
    // 对照组：kind=http_direct 的步即便带 message，右栏也只出别的（回执是 UI 步的话）
    mockBackend(REPORT, {
      post: { ...STEP_DETAIL,
        detail: { ...STEP_DETAIL.detail, message: "HTTP 步不该说出口的回执" } },
    });
    renderPage();
    await screen.findByTestId("report-detail-error");
    expect(screen.queryByTestId("report-cmd-message")).toBeNull();
  });

  it("report-ui-vars：快照标题计数=键数，每个 ${键} 跟自己的值成对；空快照明说没存过", async () => {
    mockBackend(UI_REPORT, { case: UI_DETAIL });
    renderPage();
    const box = await screen.findByTestId("report-ui-vars");
    expect(box.textContent).toContain("变量快照（2）");
    // 键值成对钉在同一行文本里：${token} 挂了 uid 的值（tk-9/7 互换）当场红
    const lineToken = box.textContent!.match(/\$\{token\}\s*=\s*\S+/)?.[0] ?? "";
    expect(lineToken).toContain("${token} = tk-9");
    expect(box.textContent).toContain("${uid} = 7");
    cleanup();

    mockBackend(UI_REPORT, { case: UI_DETAIL_NOVARS });
    renderPage();
    const empty = await screen.findByTestId("report-ui-vars");
    expect(empty.textContent).toContain("变量快照（0）");
    expect(empty.textContent).toContain("（没有存过变量）");
    expect(empty.textContent).not.toContain("${token}");
  });

  // 未选中任何步时的引导句：UI 运行结构性没有 HTTP 请求/响应（hideHttp 分流），
  // 对 ui_case 报说「看请求 / 响应」就是承诺本页永远给不出的两样东西。
  // 用全 pass 的 UI 报告绕过「自动选中第一个失败步」，让右栏停在未选中态。
  it("未选中态的引导句按主体分句：ui_case 不再承诺「请求 / 响应」，HTTP 报原句不动", async () => {
    mockBackend({
      ...UI_REPORT,
      status: "passed",
      steps: [{ ...UI_REPORT.steps[0], status: "pass" }],
    } as unknown as ReportDetail);
    renderPage();
    const box = await screen.findByTestId("report-step-detail");
    expect(box.textContent).toContain("UI 运行不产生 HTTP 请求与响应");
    expect(box.textContent).not.toContain("看请求 / 响应");
    cleanup();

    mockBackend({
      ...REPORT,
      status: "passed",
      steps: REPORT.steps.map((s) => ({ ...s, status: "pass" })),
    } as unknown as ReportDetail);
    renderPage();
    const http = await screen.findByTestId("report-step-detail");
    expect(http.textContent).toContain("看请求 / 响应 / 断言 / 日志");
    expect(http.textContent).not.toContain("UI 运行不产生");
  });
});

// ADB 报告走同一套右栏分流（D154）：adb_case 的 detail 与 ui_case 同形
// （handlers.py h_adb_case / adb_test/debug_services.py 都落 commands + vars + assertions），
// 但判据原先只认 ui_case，后果三条都在这一块钉：①回执与时间线上不了屏 ②反而摆两个
// 永远空的 JSON 编辑器 ③引导句与画布提示替 ADB 报承诺 HTTP 请求/响应。
// 每条 adb 断言都配一条**反方向**（UI/HTTP 报必须保持原样），否则「一律渲染」也过。
describe("ADB 报告的右栏分流（D154：回执上屏、空编辑器消失、话不承诺 HTTP）", () => {
  const ADB_REPORT = {
    ...REPORT,
    subject_type: "adb_case",
    steps: [
      { step_key: "case", kind: "adb_case", status: "fail", parent_step_key: null,
        subject_name: "登录案", elapsed_ms: 900, attempts: 1, row_no: 0,
        pass_rows: null, total_rows: null },
      { step_key: "d2", kind: "click_by_text", status: "fail", parent_step_key: "case",
        subject_name: "登录案", elapsed_ms: 3000, attempts: 1, row_no: 0,
        pass_rows: null, total_rows: null },
    ],
    summary_graph: { version: 1, nodes: [{ key: "case", kind: "adb_case", name: "ADB 登录案",
      config: {}, children: [], result: { status: "fail" } }] },
  } as unknown as ReportDetail;

  const ADB_DETAIL = {
    step_key: "case", kind: "adb_case", status: "fail", row_no: 0, parent_step_key: null,
    subject_name: "登录案", elapsed_ms: 900, attempts: 1,
    vars_snapshot: { token: "tk-adb" },
    detail: {
      message: "命令 2/2 失败：没找到控件",
      error: "断言文本失败",
      mode: "dump", device: "emulator-5554",
      commands: [
        { id: "d1", type: "shell", status: "pass", message: "shell 0", elapsed_ms: 40 },
        { id: "d2", type: "click_by_text", status: "fail", message: "没找到控件", elapsed_ms: 3000,
          assertions: [{ type: "assert_text", passed: false, expected: "首页", actual: "" }] },
      ],
    },
  };
  const ADB_CMD_DETAIL = {
    step_key: "d2", kind: "click_by_text", status: "fail", row_no: 0, parent_step_key: "case",
    subject_name: "登录案", elapsed_ms: 3000, attempts: 1, vars_snapshot: {},
    detail: { message: "没找到控件", assertions: [], logs: [] },
  };

  it("汇总节点：回执 / 命令时间线 / 变量快照 / 断言卡一块不少（①）", async () => {
    mockBackend(ADB_REPORT, { case: ADB_DETAIL });
    renderPage();
    // 回执：修复前 hideHttp 为假，这块整块不渲染
    const msg = await screen.findByTestId("report-cmd-message");
    expect(msg.textContent).toBe("命令 2/2 失败：没找到控件");
    const box = await screen.findByTestId("report-ui-commands");
    expect(box.textContent).toContain("命令时间线（2）");
    const rows = within(box).getAllByTestId("report-cmd-row");
    expect(rows).toHaveLength(2);
    // 逐行绑定：d1 的说不出现在 d2 行上（同 UI 腿的尺子）
    const r1 = within(rows[0]);
    expect(r1.getByText("shell 0")).not.toBeNull();
    expect(r1.queryByText("没找到控件")).toBeNull();
    expect((await screen.findByTestId("report-ui-vars")).textContent).toContain("${token} = tk-adb");
    // 断言卡（DebugPanel 原样渲染的 R108 行）：修复前 ADB 拿不到这块，
    // 它掉进的是下面那张通用断言表（mixedScene e2e 原来钉的就是这个错形状）。
    const panel = screen.getByTestId("report-step-detail");
    const cards = within(panel).getAllByTestId("assertion-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("assert_text");
    expect(cards[0].textContent).toContain("首页"); // 该断言自己的「期望」，不是别行的
  });

  it("设备与降级模式当场说出（T6 同一支笔），UI 汇总行不冒充（反方向）", async () => {
    // 这块整块按数据分流（生产侧只有 adb 写 detail.mode/device，见 reportDetail.tsx 渲染处注释），
    // 所以「UI 不冒充」钉的是数据面：UI 的 detail 里没有这两样，徽标行就整块不存在。
    mockBackend(ADB_REPORT, { case: ADB_DETAIL });
    renderPage();
    const tags = await screen.findByTestId("report-adb-device");
    expect(tags.textContent).toContain("设备 emulator-5554");
    expect(tags.textContent).toContain("降级：dump 轮询（慢但判定同一份）");
    cleanup();
    mockBackend(UI_REPORT, { case: UI_DETAIL });
    renderPage();
    await screen.findByTestId("report-ui-commands");
    expect(screen.queryByTestId("report-adb-device")).toBeNull();
  });

  it("设备没连上（mode/device 都是 null）就不摆空徽标行；只有设备无模式时只出设备", async () => {
    // 真实形状：adb_test/debug_services.py 对没跑起来的运行写 "mode": None, "device": None。
    // 上面那条已证「有就出」，这条补「没有就不」——否则「无条件渲染」也只是渲染一个空壳。
    mockBackend(ADB_REPORT, {
      case: { ...ADB_DETAIL, detail: { ...ADB_DETAIL.detail, mode: null, device: null } },
    });
    renderPage();
    await screen.findByTestId("report-ui-commands"); // 右栏已落地，不是还没渲染出来
    expect(screen.queryByTestId("report-adb-device")).toBeNull();
    cleanup();
    mockBackend(ADB_REPORT, {
      case: { ...ADB_DETAIL, detail: { ...ADB_DETAIL.detail, mode: null } },
    });
    renderPage();
    const tags = await screen.findByTestId("report-adb-device");
    expect(tags.textContent).toContain("设备 emulator-5554");
    expect(tags.textContent).not.toContain("降级");
  });

  it("ADB 步零个空 JSON 编辑器，HTTP 步照常两个（② + 正对照）", async () => {
    mockBackend(ADB_REPORT, { case: ADB_DETAIL });
    renderPage();
    await screen.findByTestId("report-ui-commands"); // 等右栏落地再数
    // 修复前是 2 个：请求={} 与 响应=null 的假编辑器（纪律 1 禁止的形状）
    expect(screen.queryAllByTestId("mock-monaco")).toHaveLength(0);
    cleanup();
    mockBackend(REPORT);
    renderPage();
    await screen.findByTestId("report-detail-error");
    expect(screen.queryAllByTestId("mock-monaco")).toHaveLength(2);
  });

  it("未选中态引导句对 adb 也不承诺「请求 / 响应」，场景报原句不动（③ + 正对照）", async () => {
    mockBackend({
      ...ADB_REPORT, status: "passed",
      steps: ADB_REPORT.steps.map((s) => ({ ...s, status: "pass" })),
    } as unknown as ReportDetail, { case: { ...ADB_DETAIL, status: "pass" } });
    renderPage();
    const box = await screen.findByTestId("report-step-detail");
    expect(box.textContent).toContain("ADB 运行不产生 HTTP 请求与响应");
    expect(box.textContent).not.toContain("看请求 / 响应");
    cleanup();
    mockBackend({ ...REPORT, status: "passed",
      steps: REPORT.steps.map((s) => ({ ...s, status: "pass" })) } as unknown as ReportDetail);
    renderPage();
    const http = await screen.findByTestId("report-step-detail");
    expect(http.textContent).toContain("看请求 / 响应 / 断言 / 日志");
    expect(http.textContent).not.toContain("ADB 运行不产生");
  });

  it("画布提示按主体措辞：adb 说 ADB 用例、ui 仍说 UI 用例（④ 两支各自钉）", async () => {
    mockBackend(ADB_REPORT, { case: ADB_DETAIL });
    renderPage();
    const note = await screen.findByTestId("report-ui-note");
    expect(note.textContent).toContain("1 条 ADB 用例");
    expect(note.textContent).not.toContain("1 条 UI 用例");
    cleanup();
    mockBackend(UI_REPORT, { case: UI_DETAIL });
    renderPage();
    const uiNote = await screen.findByTestId("report-ui-note");
    expect(uiNote.textContent).toContain("1 条 UI 用例");
  });

  it("命令行钮 disabled 且指引说清选哪个节点（409 那堵墙），汇总节点仍可点（UI 同口径）", async () => {
    mockBackend(ADB_REPORT, { case: ADB_DETAIL, d2: ADB_CMD_DETAIL });
    renderPage();
    // 自动选中的是失败的汇总行 → 钮可点（能力口径没被本修动坏）
    await screen.findByTestId("report-cmd-message");
    const btn = screen.getByTestId("report-rerun");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    // 点到命令行（parent=adb_case）：钮留在原地震 disabled，Tooltip 说出该选「用例」节点
    fireEvent.click(screen.getAllByTestId("report-step-row").find((r) => r.getAttribute("data-key") === "d2")!);
    await waitFor(() => expect((screen.getByTestId("report-rerun") as HTMLButtonElement).disabled).toBe(true));
  });
});

// HTTP 断言表（report-assert-mark）与日志区（report-detail-logs）：
// 逐行 within 绑定（上一轮实测过「断言全绿但标记挂在别的行」的假绿）。
describe("HTTP 步断言标记与日志（report-assert-mark / report-detail-logs 行级绑定）", () => {
  const ASSERT_STEP = {
    ...STEP_DETAIL,
    detail: {
      ...STEP_DETAIL.detail,
      logs: ["step post start", "断言 status：期望 200，实际 500"],
      assertions: [
        { type: "status", passed: true, expected: 200, actual: 200 },
        { type: "json_path", passed: false, expected: "OK", actual: "FAIL" },
      ],
    },
  };
  const LOGIN_STEP = {
    ...STEP_DETAIL, step_key: "login", status: "pass",
    detail: { request: {}, response: null, assertions: [], logs: ["login ok"], error: null },
  };

  function assertRow(term: string) {
    const row = screen.getAllByTestId("report-assert-row")
      .find((r) => (r.textContent ?? "").includes(term))!;
    return within(row);
  }

  it("两行断言各挂各的 ✓/✗：绿勾只出现在 passed:true 的那行，预期/实际也不串台", async () => {
    mockBackend(REPORT, { post: ASSERT_STEP, login: LOGIN_STEP });
    renderPage();
    // 两行一起等（findAll：findBy 对「恰好两行」的期望本身就该红）
    await screen.findAllByTestId("report-assert-row");
    const rows = screen.getAllByTestId("report-assert-row");
    expect(rows).toHaveLength(2);
    const passRow = assertRow("status");
    expect(passRow.getByTestId("report-assert-mark").textContent).toBe("✓");
    // 预期/实际都渲染 JSON.stringify(200)="200"：两格都在本行、一格都不越到下行
    expect(passRow.getAllByText("200")).toHaveLength(2);
    expect(passRow.queryByText("\"OK\"")).toBeNull();
    const failRow = assertRow("json_path");
    expect(failRow.getByTestId("report-assert-mark").textContent).toBe("✗");
    expect(failRow.getByText("\"OK\"")).not.toBeNull(); // JSON.stringify 逐字
    expect(failRow.getByText("\"FAIL\"")).not.toBeNull();
    expect(failRow.queryByText("200")).toBeNull();
  });

  it("日志按步骤绑定：post 两行逐字 join，换选 login 只留 login 自己的日志", async () => {
    mockBackend(REPORT, { post: ASSERT_STEP, login: LOGIN_STEP });
    renderPage();
    const logs = await screen.findByTestId("report-detail-logs");
    expect(logs.textContent).toBe("step post start\n断言 status：期望 200，实际 500");
    fireEvent.click(screen.getAllByTestId("report-step-row")
      .find((r) => r.getAttribute("data-key") === "login")!);
    await waitFor(() =>
      expect(screen.getByTestId("report-detail-logs").textContent).toBe("login ok"));
    // 上一步的日志不许残留在换选后的右栏
    expect(screen.getByTestId("report-detail-logs").textContent).not.toContain("step post start");
  });

  it("对照：logs 为空 → 日志区整块不存在（成功壳不摆空 pre）", async () => {
    mockBackend(); // STEP_DETAIL.logs = []
    renderPage();
    await screen.findByTestId("report-detail-error");
    expect(screen.queryByTestId("report-detail-logs")).toBeNull();
  });
});

// ── 差集补测：前端 fixture ↔ 后端 *Out 的「有值侧」────────────────────────
// 后端 Out 里这些字段是真填的（report_services.py:282-294 / 步骤详情端点），生产渲染
// 代码也在，但本文件 fixture 一律写 null，于是那条有值分支在门禁里从没执行过。
// 每条都在自己的 it() 里用 mockBackend 传新载荷：默认 REPORT 一字不动，零污染既有测试。
describe("reportDetail 有值分支（fixture ↔ 后端 Out 差集）", () => {
  it("开始/结束有值：UTC 串按 Asia/Shanghai +8 换算，钉完整时刻而不是「不是 —」", async () => {
    // ⚠ 更正此前这句「后端 iso_dt 落库带 +00:00（execution/timefmt.py:293-294）」——**两处都错**：
    //   ① 那个行号根本不存在（timefmt.py 只有 18 行）；② iso_dt 就是 `dt.isoformat()`
    //     （execution/timefmt.py `def iso_dt`），而 started_at 是**朴素** DateTime（models.py
    //     列定义无 timezone=True，写入侧 `datetime.now(UTC).replace(tzinfo=None)`）
    //     → **线上串不带任何偏移**。原 fixture 手写 `+00:00` 恰好把这点遮住，而这个
    //     describe 的标题正是「fixture ↔ 后端 Out 差集」——它该抓的没抓。
    // 现在喂真形状（裸串）。显示仍 +8：parseUtc 对无偏移串补 `Z`（timefmt.ts），
    // 所以期望串不变 —— 变的是「我们声称后端发的是什么」。
    // 钉含年月日时分秒的完整串：换算错 8 小时或退化成裸截断，这一条当场红。
    mockBackend({ ...REPORT,
      started_at: "2026-11-15T03:24:05", finished_at: "2026-11-15T03:26:07" });
    renderPage();
    await screen.findByTestId("report-overview");
    // 标签↔值同行绑定：从「开始」label 拿到所在 Descriptions cell，期望串必须长在同一个 cell 里
    const pairs = [["开始", "2026-11-15 11:24:05"], ["结束", "2026-11-15 11:26:07"]] as const;
    for (const [label, expected] of pairs) {
      const cell = screen.getByText(label).closest(".ant-descriptions-item") as HTMLElement;
      expect(within(cell).getByText(expected)).not.toBeNull();
      expect(cell.textContent).not.toContain("—"); // 空值壳不许和有值壳同屏
    }
  });

  it("env_name 有值：概要标题出环境 Tag，Pilot 草稿带上「环境：…」行", async () => {
    mockBackend({ ...REPORT, env_name: "prod-hz" });
    renderPage();
    const overview = await screen.findByTestId("report-overview");
    // reportDetail.tsx:460 的 {report.env_name && <Tag>}：Tag 就长在概览卡标题里
    expect(within(overview).getByText("prod-hz")).not.toBeNull();
    // :405 的草稿行同字段同源：点了「让 Pilot 总结」，草稿必须带环境
    fireEvent.click(screen.getByTestId("report-ask-pilot"));
    const landed = await screen.findByTestId("landed-bench");
    expect(landed.textContent).toContain("环境：prod-hz");
  });

  it("数据集步行数徽标：3/10 上树；pass_rows=null 走 ?? 0 出 0/10；total_rows=0 整段不出现", async () => {
    const mk = (key: string, pass: number | null, total: number) => ({
      step_key: key, kind: "http_direct", status: "pass", parent_step_key: null,
      subject_name: null, elapsed_ms: 10, attempts: 1, row_no: 0,
      pass_rows: pass, total_rows: total,
    });
    mockBackend({ ...REPORT, steps: [
      ...REPORT.steps,
      mk("ds-full", 3, 10), mk("ds-null", null, 10), mk("ds-zero", null, 0),
    ] } as unknown as ReportDetail);
    renderPage();
    await screen.findByTestId("report-overview");
    const rowOf = (key: string) => within(screen.getAllByTestId("report-step-row")
      .find((r) => r.getAttribute("data-key") === key)!);
    // reportDetail.tsx:131-134：徽标就在该步行内（within 绑定，不许挂到别的行）
    expect(rowOf("ds-full").getByText("3/10")).not.toBeNull();
    // ?? 0 那一支必须钉住：没回 pass_rows 也要读成 0/10，否则 ?? 0 是死代码
    expect(rowOf("ds-null").getByText("0/10")).not.toBeNull();
    // > 0 守卫：total_rows=0 时整段不渲染（步名/键里都没有「/」，出现即假徽标）
    expect(rowOf("ds-zero").queryByText("0/0")).toBeNull();
    expect(rowOf("ds-zero").queryByText(/\d+\//)).toBeNull();
  });

  it("attempts>1：步骤详情回 attempts=3 → 右栏出现「尝试 3 次」（attempts:1 侧由既有各条守着）", async () => {
    mockBackend(REPORT, { post: { ...STEP_DETAIL, attempts: 3 } });
    renderPage();
    // 等**内容**而不是等壳：`report-step-detail`（reportDetail.tsx:548）是常驻 div，详情请求在
    // 飞的时候它是空的——findByTestId 只保证壳在，满载全量 ⑥ 下同步 getByText 读到空壳即红
    // （2026-11-18 实测：单跑 37/37 绿，全量 1346 里这条红）。
    const box = await screen.findByText("尝试 3 次");
    expect(within(screen.getByTestId("report-step-detail")).getByText("尝试 3 次")).not.toBeNull();
    expect(box.textContent).toBe("尝试 3 次");
  });

  it("子步归组缩进：parent_step_key=login 的行 paddingLeft 22px（8+14）、紧跟父步之后，顶层仍是 8px", async () => {
    mockBackend({ ...REPORT, steps: [...REPORT.steps, {
      step_key: "login.c1", kind: "http_direct", status: "pass", parent_step_key: "login",
      subject_name: null, elapsed_ms: 50, attempts: 1, row_no: 0,
      pass_rows: null, total_rows: null,
    }] } as unknown as ReportDetail);
    renderPage();
    await screen.findByTestId("report-overview");
    const rows = screen.getAllByTestId("report-step-row");
    // login 不在 summary_graph 节点里 → orderKeysByHints 保持后端原序排在 post 之后；
    // rec() 把子步紧排在父步的下一行（depth+1）——这是观察到的实际序，语义=执行序
    expect(rows.map((r) => r.getAttribute("data-key"))).toEqual(["post", "login", "login.c1"]);
    const rowOf = (key: string) => rows.find((r) => r.getAttribute("data-key") === key)!;
    // reportDetail.tsx:120 的 padding: 4px 8px 4px (8 + depth*14)px
    expect(rowOf("post").style.paddingLeft).toBe("8px");
    expect(rowOf("login.c1").style.paddingLeft).toBe("22px");
    // 子步 status=pass：不许抢走「自动选中第一个 fail 步」（post 仍是右栏第一眼对象）。
    // 等内容不等内容壳（同上一条的理由）：右栏的 step_key 标题就是「选中的是哪一步」的证据。
    await waitFor(() => expect(screen.getByTestId("report-step-detail").textContent).toContain("post"));
  });
});

// ── D142：单步详情的「取不到」分四种来路，不再一律喊「暂时…点重试」 ──
// 病根：后端这个调用点上有两条 404（明细行缺 / 报告本体没了）和一个 403，
// 全被同一个 catch 抹成「暂时取不到…点重试再看」。而 `report_services.py:250` 明写
// runner 可能只落展开行不落 base 行——列表页 :250-254 会归并出状态、明细端点
// :322-331 却要求精确匹配 (step_key,row_no) ⇒ 这一步**永远**读不到，重试一万次也是同一句话。
// 「重试」这个动作本身就是话：递给人按了不变的重试，等于把死路包装成希望（§13 纪律 1）。
describe("reportDetail 单步详情的四种「取不到」（D142）", () => {
  /** 错误信封桩：只让 steps 端点回错误，报告本体照常 200（页面还在，才分得清是谁没了）。 */
  function mockStepErr(status: number, code: string, details: unknown): void {
    calls.length = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/reports/r1/steps?")) {
        return { ok: false, status, json: async () => ({ code, message: "后端原话", details }) } as unknown as Response;
      }
      if (url.startsWith("/api/v1/reports/r1?")) {
        return { ok: true, status: 200, json: async () => REPORT } as unknown as Response;
      }
      throw new Error("未 mock 的请求: GET " + url);
    }) as unknown as typeof fetch;
  }
  const box = async () => screen.findByTestId("report-step-error");

  it("404 带 details.step_key（只有展开行没有 base 行）：说「本来就没有」，且**不给重试钮**", async () => {
    mockStepErr(404, "not_found", { run_id: "r1", step_key: "post", row_no: 0 });
    renderPage();
    const el = await box();
    expect(el.textContent).toContain("明细行本来就没有");
    expect(el.getAttribute("data-failure")).toBe("gone");
    // 这三句都是「暂时」口径的残留：留在屏上就等于还在承诺「再试一次会不同」
    expect(el.textContent).not.toContain("暂时");
    expect(el.textContent).not.toContain("网络抖动");
    expect(el.textContent).not.toContain("点重试");
    expect(screen.queryByTestId("report-step-retry")).toBeNull();
    // 出路得给一句真话：状态在左栏那一行上，这句话本页兑现得了
    expect(el.textContent).toContain("看左栏那一行");
    // 选中态不丢（这条是旧契约的一部分，别在改文案时顺手改掉）
    expect(el.textContent).toContain("post");
  });

  it("404 只带 run_id（报告本体被回收）：说的是报告没了，不许赖给这一步", async () => {
    mockStepErr(404, "not_found", { run_id: "r1" });
    renderPage();
    const el = await box();
    expect(el.getAttribute("data-failure")).toBe("run_gone");
    expect(el.textContent).toContain("这份报告已经不在了");
    // 同一步的 404 与这一步的 404 必须是两句话：把「报告没了」说成「这步没落库」
    // 会让人去查 runner，而该查的是回收站
    expect(el.textContent).not.toContain("明细行本来就没有");
    expect(el.textContent).not.toContain("暂时");
    expect(screen.queryByTestId("report-step-retry")).toBeNull();
  });

  it("410 与 404 同判（Gone 也是后端当面说「不在」）：不许因为码位不同就归给「暂时」", async () => {
    mockStepErr(410, "not_found", { run_id: "r1", step_key: "post", row_no: 0 });
    renderPage();
    const el = await box();
    expect(el.getAttribute("data-failure")).toBe("gone");
    expect(el.textContent).toContain("明细行本来就没有");
    expect(screen.queryByTestId("report-step-retry")).toBeNull();
  });

  it("403：说「读不了了」并**保留**重试——权限是可能被补回来的，那才是重试该出现的场合", async () => {
    mockStepErr(403, "insufficient_permission", { perm: "api:run:read" });
    renderPage();
    const el = await box();
    expect(el.getAttribute("data-failure")).toBe("denied");
    expect(el.textContent).toContain("读不了了");
    expect(el.textContent).not.toContain("暂时取不到");
    expect(el.textContent).not.toContain("网络抖动");
    expect(screen.getByTestId("report-step-retry")).not.toBeNull();
  });

  it("500 仍是「暂时取不到…点重试再看」：分句不许把唯一该喊暂时的腿改松（正对照）", async () => {
    mockStepErr(500, "internal_error", null);
    renderPage();
    const el = await box();
    expect(el.getAttribute("data-failure")).toBe("transient");
    expect(el.textContent).toContain("暂时取不到");
    expect(el.textContent).toContain("点重试再看");
    expect(screen.getByTestId("report-step-retry")).not.toBeNull();
    // 反面对手：故障不许被说成数据本来就没有（那会让人去回收站捞一条好端端的报告）
    expect(el.textContent).not.toContain("本来就没有");
    expect(el.textContent).not.toContain("读不了了");
  });

  it("断网（fetch 直接抛，没有状态码可依）按 transient：无情报就不下结论", async () => {
    calls.length = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/reports/r1/steps?")) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => REPORT } as unknown as Response;
    }) as unknown as typeof fetch;
    renderPage();
    const el = await box();
    expect(el.getAttribute("data-failure")).toBe("transient");
    expect(el.textContent).toContain("暂时取不到");
    expect(screen.getByTestId("report-step-retry")).not.toBeNull();
  });

  it("重试钮真的重发请求，且故障转好后同一步出真详情（重试不许是个空钮）", async () => {
    let fail = true;
    calls.length = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url, method: "GET", body: undefined }); // 不 push 的话下面那个计数永远是 0，断言就成了必然红（或换个写法就必然绿）
      if (url.includes("/reports/r1/steps?")) {
        if (fail) return { ok: false, status: 500, json: async () => ({ code: "internal_error", message: "错" }) } as unknown as Response;
        return { ok: true, status: 200, json: async () => STEP_DETAIL } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => REPORT } as unknown as Response;
    }) as unknown as typeof fetch;
    renderPage();
    await box();
    const before = calls.filter((c) => c.url.includes("/steps?")).length;
    fail = false;
    fireEvent.click(screen.getByTestId("report-step-retry"));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/steps?")).length).toBe(before + 1));
    await waitFor(() => expect(screen.queryByTestId("report-step-error")).toBeNull());
    // 出的是**真详情**而不是壳：STEP_DETAIL 里的报错原文只可能来自那次成功的响应
    await waitFor(() => expect(screen.getByTestId("report-detail-error").textContent)
      .toContain("断言失败：期望 200，实际 500"));
  });
});

// ── D138：「步骤」统计行的计数尺子必须与 stats 同源 ──
// stats 的 pass/fail/skip/error 按主体类型是两把尺：场景按顶层节点计
// （scenario/engine/runner.py:506-510 汇总 top 节点，total=len(top)）；UI/ADB 用例按
// 命令计（ui_test / adb_test 的 debug_services：for r in result.commands 逐命令累计，
// total=len(commands)）。后端不许动（stats.total 是通过率分母），所以标签跟着尺子走：
// 用例类报写「N 命令」，「N 顶层」只属于按节点计的报。断言一律圈在 report-stats-row
// 里——「顶层」一词在画布提示与缩进测试的语境里合法存在，整页 contains 会误伤。
describe("「步骤」统计行的计量尺子（D138：节点尺 vs 命令尺不许混在同一行）", () => {
  // UI 报的真实现场形状：1 个顶层节点、stats 按命令计（total=3，败 1）——
  // 修复前这一行是「1 顶层 过 1 败 1」，节点尺和命令尺并排（缺陷复现）。
  const UI_STATS_REPORT = {
    ...UI_REPORT,
    stats: { total: 3, pass: 1, fail: 1, skip: 0, error: 1 },
  } as unknown as ReportDetail;
  // ADB 报同形（D154 已确立 adb_case 与 ui_case 的 stats 同尺：adb_test/debug_services.py:547
  // total=len(result.commands)），措辞必须同一条腿，不能只修 UI。
  const ADB_STATS_REPORT = {
    ...REPORT,
    subject_type: "adb_case",
    steps: [{ step_key: "case", kind: "adb_case", status: "fail", parent_step_key: null,
      subject_name: "登录案", elapsed_ms: 900, attempts: 1, row_no: 0,
      pass_rows: null, total_rows: null }],
    stats: { total: 2, pass: 1, fail: 1, skip: 0, error: 0 },
    summary_graph: { version: 1, nodes: [{ key: "case", kind: "adb_case", name: "ADB 登录案",
      config: {}, children: [], result: { status: "fail" } }] },
  } as unknown as ReportDetail;

  async function statsRow(report: ReportDetail) {
    mockBackend(report);
    renderPage();
    await screen.findByTestId("report-overview");
    return screen.getByTestId("report-stats-row");
  }

  it("场景报（按顶层节点计）：行首仍是「2 顶层」，一个「命令」都不许出现", async () => {
    const row = await statsRow(REPORT); // 2 个顶层步 + stats {total:2,pass:1,fail:1}
    expect(within(row).getByText("2 顶层")).not.toBeNull();
    expect(within(row).getByText("过 1")).not.toBeNull();
    expect(within(row).getByText("败 1")).not.toBeNull();
    expect(row.textContent).not.toContain("命令");
  });

  it("UI 用例报（按命令计）：行首是「3 命令」（=stats.total），「顶层」不许上这行", async () => {
    const row = await statsRow(UI_STATS_REPORT);
    // 3 = stats.total（命令数），不是 steps 里的顶层节点数 1——取错源这一条即红
    expect(within(row).getByText("3 命令")).not.toBeNull();
    expect(within(row).getByText("过 1")).not.toBeNull();
    expect(within(row).getByText("错 1")).not.toBeNull();
    expect(row.textContent).not.toContain("顶层");
  });

  it("ADB 用例报同尺（D154 口径）：行首「2 命令」，「顶层」不许上这行", async () => {
    const row = await statsRow(ADB_STATS_REPORT);
    expect(within(row).getByText("2 命令")).not.toBeNull();
    expect(within(row).getByText("败 1")).not.toBeNull();
    expect(row.textContent).not.toContain("顶层");
  });

  it("两把尺不许反向串门：场景报拿不到「命令」措辞、用例报拿不到「顶层」措辞（交叉对照）", async () => {
    const scen = await statsRow(REPORT);
    expect(within(scen).queryByText(/命令/)).toBeNull();
    cleanup();
    const ui = await statsRow(UI_STATS_REPORT);
    expect(within(ui).queryByText(/顶层/)).toBeNull();
  });
});

describe("概览状态徽标的词表外 status（R112：不回落友好标签）", () => {
  it("后端从没发过的 status 渲染原文；同屏词表内步骤照常画友好标签（正对照）", async () => {
    // reportDetail.tsx:406 的 `STATUSES[report.status] ?? …`（现为 vocabMeta(STATUSES, …)）
    // 此前**没人钉过**：把兜底改成 `?? STATUSES.failed`（未知一律画「断言失败」），
    // 本文件其余各例照全绿。形状同 planReportDetail.test.tsx ⑥b（LINK_RESULTS 侧的实测洞）。
    // "blocked" 不在 STATUSES 六态里。REPORT 本体一字不动，只在载荷上换 status。
    mockBackend({ ...REPORT, status: "blocked" } as unknown as ReportDetail);
    renderPage();
    await screen.findByTestId("report-overview");
    const badge = screen.getByTestId("report-overview-status");
    expect(badge.textContent).toBe("blocked"); // 生码原样上屏
    // 负断言 scope 在徽标本身：同屏步骤树里 post 步合法画着「断言失败」，
    // 整页 not.toContain 会被它误红；整页 contains 也会喂错对象（通过率列 6b 同款教训）。
    expect(badge.textContent).not.toContain("断言失败"); // 绝不回落成认识的话
    // 正对照：同一屏的步骤树行走 STEP_STATUSES，词表内值照常画友好标签——
    // 兜底只发生在「查不到」那一条腿上，不是整页退化成了原文。
    const rows = screen.getAllByTestId("report-step-row");
    const rowOf = (k: string) => within(rows.find((n) => n.getAttribute("data-key") === k)!);
    expect(rowOf("login").getByText("通过")).not.toBeNull(); // pass → 通过
    expect(rowOf("post").getByText("断言失败")).not.toBeNull(); // fail → 断言失败
  });
});
