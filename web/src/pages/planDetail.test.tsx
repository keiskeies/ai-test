// 测试计划详情页（D183 步 6b）组件测试。fetch 全 mock，同 plans.test.tsx 手法（最新同族）。
// 这份文件防的谎，逐条编号：
// ① 无 testplan:plan:read → 闸门一句人话，**任何请求一条都不发**（含 /status、/case-links、
//    /reports、/envs——门在 effect 上，不在渲染里）；
// ② 失败三态分岔：403 → PermEmpty（位名只认后端原话）；404/410 → 后端原话逐字上屏（不翻译、
//    不 closable、**不摆重试**——不存在不是暂时）；transient → 非 closable 错误条 + 重试钮真重发；
// ③ 无第二算式：两个率渲染值逐字 == fixture 的 pass_rate/execute_rate（fixture 特意
//    passed:2/total:3 与 pass_rate:0.6、executed:3/total:3 与 execute_rate:0.8 对不上——
//    页面里任何 naive 除法必红，这正是后端 M5/P3 变异要杀的形状）；
// ④ 跨页 straddle：分页关联行的 id 不在 status.links 里 → 渲染「—」（data-result=unknown），
//    绝不现算一个结论填上；join 得上的行照常画结论；
// ⑤ {executed:false, executing:true} → 画「执行中」**不画「未执行」**（_link_result 对
//    executed==0 恒回 none，包括正在跑的——executing 必须先过一遍，见 planDetail.tsx 文件头③）；
// ⑥ 词表外 status 渲染原文（R112 口径走 planDisplayMeta，不回落友好标签）；
// ⑦ 写钮一律按权限位**不渲染**（不是禁用）：link:create/report:create/link:update/
//    link:delete 各钉一次；归档额外要求 :manage 且 !archived（MEMBER 的 -*:manage 必须挡住）；
// ⑧ 线上 body 逐字段：POST case-links 恰好 {project_id,subject_type,subject_id,env_id}
//    无多余键（不夹带 plan_id）；PATCH env 与 clear_env **永远只带一个**；DELETE 带 JSON body；
// ⑨ 报告行**是真链接且点了真导航**：/plan-reports/:id 由 6c 落地（app.tsx 路由与名列、本条
//    同批翻——6a ⑬/6b 同款纪律）。6a/6b 当初钉「不可点」防的是 app.tsx 末尾 catch-all
//    `{path:"*", → Navigate "/" replace}` 把点不存在路由的人静默弹回工作台；路由在场这把锁就消失。
// ⑩ 页码请求形状：链接列表 total=137 行数≠总数（total=items.length 在「共 137 条」露馅）、
//    每条带 current 不带 cursor、翻页恰好一条且是替换不是追加；报告侧响应缺 total 键 →
//    该分页器整块不渲染（另一分支的正对照是链接侧的「共 137 条」在场）；
// ⑪ 挂载扇出的 D127 绊线：/plans、/status、/case-links、/reports、/envs 各恰好一条，
//    300ms 观察窗后仍各一条（load 依赖里塞回它写的 state 就在这红）；
// ⑫ 分节读门：缺 link:read → 关联节明说不演空表且该节零请求，计划/状态/报告照常；
// ⑬ env 诚实：env_id 空渲染「沿用对象默认」不是「无环境」；缺 env:config:read 的
//    :update 角色不摆空下拉假门；
// ⑭ 时间只走 fmtTime（+08:00 ISO → 上海墙钟逐字对，slice/toLocaleString 变异会红）；
// ⑮ 选择器诚实：不支持服务端搜索的类型，搜索框旁自报「在本页已加载的 N 条里筛」；
//    只有 scenario 把 keyword 真传给后端；缺对象读权限 → 明说「读不到清单≠没有」且
//    ID 通路同屏在；
// ⑯ 归档是终态：确认文案说无反归档，归档后钮消失、徽标翻转、/status 重取一次；
// ⑰ 「返回计划列表」真导航（路由 6b 已落地，同 plans ⑬ 的探针页手法）；
// ⑱ 页面契约：page-plan-detail + PageHead 标题「计划详情」（nav.spec 钉的同一对）；
// ⑨b 生成报告：POST body 恰好 {project_id}，成功后重拉列表（不本地插行）。
// ⑲ D225 执行计划：POST body 恰好 {project_id, plan_id}；回执逐条列「已投递/原因」，
//    跳过原因是后端原话；成功后状态与关联各重取；归档计划与 READONLY 都不摆执行钮。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import PlanDetailPage from "./planDetail";
import { useAuth } from "../auth/store";
import type { components } from "../api/schema";

type PlanLinkOut = components["schemas"]["PlanLinkOut"];

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

function plan(over: Record<string, unknown> = {}) {
  return { id: "p1", project_id: "p1", name: "结算回归", description: "覆盖结算主链路",
    archived: false, created_by: null, updated_by: null,
    created_at: "2026-11-20T10:30:00+08:00", updated_at: null, ...over };
}

function link(id: string, over: Partial<PlanLinkOut> = {}): PlanLinkOut {
  return { id, project_id: "p1", plan_id: "p1", subject_type: "api_case", subject_id: "c1",
    subject_name: "登录用例", env_id: null, created_by: null, created_at: null,
    updated_at: null, ...over };
}

// 关联页 fixture：lk1 能被 status join 上（passed）；lk2 join 上但 {executed:false,
// executing:true, result:"none"}——正是「跑着≠没跑过」那条谎的形状；lk9 **故意不在
// status.links 里**（status 覆盖全部关联、本页只画一页，跨页是常态）→ 必须画「—」。
const L1 = link("lk1", { subject_id: "c1", subject_name: "登录用例",
  created_at: "2026-11-19T08:00:00+08:00" });
const L2 = link("lk2", { subject_id: "c2", subject_name: "下单用例", env_id: "e1" });
const L9 = link("lk9", { subject_id: "c9", subject_name: "跨页用例" });
const LINKS_TOTAL = 137; // 行数 3 ≠ 总数：total=items.length 在「共 137 条」露馅

// 状态 fixture（判据 2 的引信）：naive 除法 pass=2/3=66.7%、exec=3/3=100%，
// 后端给的是 0.6 / 0.8——页面复算必被 ③ 抓到。
function status(over: Record<string, unknown> = {}) {
  return {
    plan_id: "p1", project_id: "p1", name: "结算回归", archived: false,
    status: "in_progress", total: 3, passed: 2, failed: 1,
    executed: 3, executing: 1, not_executed: 0,
    pass_rate: 0.6, execute_rate: 0.8,
    links: [
      { link_id: "lk1", subject_type: "api_case", subject_id: "c1", subject_name: "登录用例",
        env_id: null, executed: true, executing: false, result: "passed" },
      { link_id: "lk2", subject_type: "api_case", subject_id: "c2", subject_name: "下单用例",
        env_id: "e1", executed: false, executing: true, result: "none" },
    ],
    ...over,
  };
}

// 报告行 = PlanReportListRowOut 形状（**没有 items**——services._report_row 现核）。
const REPORT = { id: "r1", project_id: "p1", plan_id: "p1", name: "结算回归 报告",
  status: "completed", total: 3, passed: 2, failed: 1, executed: 3, executing: 1,
  not_executed: 0, pass_rate: 0.6, execute_rate: 0.8, created_by: null,
  created_at: "2026-11-20T12:00:00+08:00", updated_at: null };

const ENVS = [{ id: "e1", project_id: "p1", name: "测试环境", position: 0, config: null },
  { id: "e2", project_id: "p1", name: "预发环境", position: 1, config: null }];

// D207：计划缺陷清单行（PlanBugOut 形状）。
const BUGS = [
  { id: "bg1", num: 100001, title: "登录接口 500", status: "in_process", priority: "P1",
    handle_user_id: "u1", handle_user_name: "张三", tags: ["登录"],
    created_at: "2026-11-19T09:00:00+08:00", updated_at: "2026-11-20T09:00:00+08:00" },
  { id: "bg2", num: 100002, title: "支付超时", status: "resolved", priority: "P2",
    handle_user_id: null, handle_user_name: null, tags: [], created_at: null, updated_at: null },
];

const API_CASES = [{ id: "c1", project_id: "p1", definition_id: "d1", name: "登录用例",
  priority: "P1", request: null, assertions: [], dataset_id: null, sort: 0,
  status: "normal", effective_request: null }];
const SCENARIOS = [{ id: "s1", project_id: "p1", name: "结算主链路", status: "normal" }];

const calls: { url: string; method: string; body: unknown }[] = [];

/** 后端原话：独特到不可能被硬编码——前端翻译/硬编码必被 toBe 抓。 */
const NOT_FOUND_RAW = "计划不存在（跨项目与不存在同码同文，码 0xd183b6）";
const BACKEND_409_LINK = "该对象已在此计划中";

interface Opts {
  /** GET /plans/{id} 的状态码覆盖（403/404/503…）。 */
  planStatus?: number;
  /** 首次 GET /plans/{id} 失败、之后成功（transient 重试腿）。 */
  planFailOnce?: boolean;
  /** 首次 GET /status 失败、之后成功（状态卡失败腿）。 */
  statusFailOnce?: boolean;
  /** POST case-links 失败且 message=BACKEND_409_LINK。 */
  linkCreateFail?: boolean;
  /** 计划已归档（归档钮必须缺席）。 */
  archivedPlan?: boolean;
  /** 状态 fixture 的 status 字段覆盖（词表外值腿）。 */
  displayStatus?: string;
  /** /status 响应整块覆盖（空计划 0.0 腿）。 */
  statusOver?: Record<string, unknown>;
  /** GET /envs 的状态码覆盖（env 取失败腿）。 */
  envsStatus?: number;
  /** 关联侧 total：默认 137（跨页腿）；true → total == items.length（D206 排序把手可见腿）。 */
  linksOnOnePage?: boolean;
  /** D218：关联列表换成一条功能用例（结论历史 Drawer 腿）。 */
  functionalLinks?: boolean;
}

// D206：执行人下拉的成员名单（GET /projects/p1/members）。
const MEMBERS = [
  { user_id: "u1", account: "zhangsan", name: "张三", role_code: "PROJECT_ADMIN", role_name: "项目管理员" },
  { user_id: "u2", account: "lisi", name: "李四", role_code: "MEMBER", role_name: "成员" },
];

function mockBackend(over: Opts = {}) {
  calls.length = 0;
  let planFailed = false;
  let statusFailed = false;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const resp = (status: number, json: unknown) => ({
      ok: status < 400, status,
      // 深拷同 plans.test.tsx:88-91：桩不许比真 fetch 更好说话——同引用两次 setState
      // 会被 React 按同一性跳过，无限重取回路就永远测不出。
      json: async () => JSON.parse(JSON.stringify(json)) as unknown,
    }) as unknown as Response;
    if (url.startsWith("/api/v1/plans/p1/status")) {
      if (over.statusFailOnce && !statusFailed) {
        statusFailed = true;
        return resp(503, { code: "status_unavailable", message: "状态服务暂不可用", details: {} });
      }
      return resp(200, status({ ...(over.displayStatus ? { status: over.displayStatus } : {}),
        ...(over.statusOver ?? {}) }));
    }
    if (url.startsWith("/api/v1/projects/p1/members") && method === "GET") {
      return resp(200, { items: MEMBERS, next_cursor: null });
    }
    // D206 三条写面必须排在泛化的 /case-links 之前（否则会被 POST→201 分支吞掉）。
    if (url.endsWith("/case-links/assign") && method === "POST") {
      const ids = ((body ?? {}) as { link_ids?: string[] }).link_ids ?? [];
      return resp(200, { updated: ids.length });
    }
    if (url.endsWith("/case-links/sort") && method === "POST") {
      const ids = ((body ?? {}) as { link_ids?: string[] }).link_ids ?? [];
      return resp(200, { updated: ids.length });
    }
    if (url.endsWith("/case-links/batch-delete") && method === "POST") {
      const ids = ((body ?? {}) as { link_ids?: string[] }).link_ids ?? [];
      return resp(200, { updated: ids.length });
    }
    if (url.startsWith("/api/v1/plans/p1/case-links/") && (method === "PATCH" || method === "DELETE")) {
      if (method === "DELETE") return resp(200, { ok: true });
      const id = url.slice("/api/v1/plans/p1/case-links/".length).split("?")[0];
      const base = [L1, L2, L9].find((l) => l.id === id) ?? L1;
      const b = (body ?? {}) as Record<string, unknown>;
      return resp(200, { ...base, env_id: b.clear_env ? null : (b.env_id ?? base.env_id ?? null) });
    }
    if (url.startsWith("/api/v1/plans/p1/case-links")) {
      if (method === "POST") {
        if (over.linkCreateFail) {
          return resp(409, { code: "conflict", message: BACKEND_409_LINK, details: {} });
        }
        const b = (body ?? {}) as Record<string, unknown>;
        return resp(201, { id: "lkNew", project_id: "p1", plan_id: "p1",
          subject_type: b.subject_type ?? "api_case", subject_id: b.subject_id ?? "c1",
          subject_name: "新对象", env_id: (b.env_id as string | undefined) ?? null,
          created_by: null, created_at: null, updated_at: null });
      }
      const cur = Number(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("current") ?? "1");
      const items = over.functionalLinks
        ? (cur === 1 ? [link("lkF", { subject_type: "functional_case", subject_id: "fc1",
            subject_name: "登录功能用例" })] : [])
        : (cur === 3 ? [link("lkZ", { subject_name: "第三页用例" })] : [L1, L2, L9]);
      return resp(200, { items, next_cursor: null,
        total: over.functionalLinks ? items.length : (over.linksOnOnePage ? items.length : LINKS_TOTAL) });
    }
    if (url.startsWith("/api/v1/plans/p1/bugs")) {
      return resp(200, { items: BUGS, next_cursor: null, total: BUGS.length });
    }
    // D218：结论变更历史（append-only 流水）。12 条历史 → 第 1 页 10 条、第 2 页 2 条，
    // 「共 12 条」与翻页后的 seq 集合一起断「分页真的在服务端切」。
    if (url.includes("/functional-cases/") && url.includes("/history")) {
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const cur = Number(q.get("current") ?? "1");
      const size = Number(q.get("size") ?? "10");
      const all = Array.from({ length: 12 }, (_, i) => {
        const seq = 12 - i;
        return { id: "h" + seq, seq, result: seq === 12 ? "pass" : "fail",
          comment: "第 " + seq + " 次改判", executed_by: seq % 2 ? "u1" : "u2",
          created_at: "2026-11-21T10:00:00+08:00" };
      });
      const start = (cur - 1) * size;
      return resp(200, { items: all.slice(start, start + size), next_cursor: null, total: all.length });
    }
    if (url.startsWith("/api/v1/plans/p1/functional-cases?") && method === "GET") {
      return resp(200, { items: [{ link_id: "lkF", result: "pass", updated_at: null }],
        next_cursor: null });
    }
    if (url.startsWith("/api/v1/plan-reports/r1") && (method === "PATCH" || method === "DELETE")) {
      if (method === "PATCH") {
        const b = (body ?? {}) as { name?: string };
        return resp(200, { ...REPORT, name: b.name ?? REPORT.name });
      }
      return resp(200, { ok: true });
    }
    if (url.startsWith("/api/v1/plans/p1/reports")) {
      if (method === "POST") {
        return resp(201, { ...REPORT, id: "rNew", items: [] });
      }
      // 报告侧**故意不带 total 键**：⑩ 的另一半——缺 total → 该分页器整块不渲染。
      return resp(200, { items: [REPORT], next_cursor: null });
    }
    if (url.startsWith("/api/v1/plans/p1/archive") && method === "POST") {
      return resp(200, plan(over.archivedPlan ? {} : { archived: true }));
    }
    // D231：关注/取关（写位 :update）。回执两位都是现查结果，页面照抄、不本地 ±1。
    if (url === "/api/v1/plans/p1/follow" && method === "POST") {
      return resp(200, { following: true, follower_count: 3 });
    }
    if (url === "/api/v1/plans/p1/unfollow" && method === "POST") {
      return resp(200, { following: false, follower_count: 2 });
    }
    if (url.startsWith("/api/v1/plans/p1?") && method === "GET") {
      if (over.planStatus) {
        const s = over.planStatus;
        return resp(s, { code: s === 403 ? "insufficient_permission" : "not_found",
          message: s === 403 ? "缺少权限：testplan:plan:read" : NOT_FOUND_RAW,
          details: s === 403 ? { perm: "testplan:plan:read" } : { plan_id: "p1" } });
      }
      if (over.planFailOnce && !planFailed) {
        planFailed = true;
        return resp(503, { code: "plan_unavailable", message: "计划服务暂不可用：DB 连接超时", details: {} });
      }
      return resp(200, plan(over.archivedPlan ? { archived: true } : {}));
    }
    if (url.startsWith("/api/v1/envs?") && method === "GET") {
      if (over.envsStatus) {
        return resp(over.envsStatus, { code: "boom", message: "环境清单没取到", details: {} });
      }
      return resp(200, { items: ENVS, next_cursor: null });
    }
    if (url.startsWith("/api/v1/api-cases?") && method === "GET") {
      return resp(200, { items: API_CASES, next_cursor: null });
    }
    if (url.startsWith("/api/v1/scenarios?") && method === "GET") {
      return resp(200, { items: SCENARIOS, next_cursor: null });
    }
    if (url.startsWith("/api/v1/ui-cases?") && method === "GET") {
      return resp(200, { items: [], next_cursor: null });
    }
    if (url.startsWith("/api/v1/adb-cases?") && method === "GET") {
      return resp(200, { items: [], next_cursor: null });
    }
    // D225：执行计划逐条回执（一条投出去 + 两条如实跳过，跳过原因必须是后端给的人话）。
    if (url === "/api/v1/plans/p1/execute" && method === "POST") {
      return resp(200, {
        plan_id: "p1", submitted: 1, skipped: 2, items: [
          { link_id: "lk1", subject_type: "scenario", subject_id: "s1",
            subject_name: "结算主链路", run_id: "run-d225", reason: null },
          { link_id: "lk2", subject_type: "api_case", subject_id: "c2",
            subject_name: "下单用例", run_id: null,
            reason: "接口用例尚无独立执行引擎（目前只能经场景执行）" },
          { link_id: "lk9", subject_type: "functional_case", subject_id: "fc1",
            subject_name: "登录功能用例", run_id: null,
            reason: "功能用例是人工执行，请在关联行点「记录结论」" },
        ],
      });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

// vitest 无 globals ⇒ RTL 自动 cleanup 不注册：两头各清一次（plans.test.tsx:129-137 同款）。
afterEach(cleanup);
beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

function renderPage(entry = "/plans/p1"): void {
  // /plans 探针路由：⑰ 的返回导航与 ⑨「点了真去报告详情」都要能断「点了落在哪」。
  // 6c：/plan-reports/:id 探针是 ⑨ 翻面的另一半——断的是导航目标，不是页面本体（那由
  // planReportDetail.test.tsx 自己钉）。
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/plans/:id" element={<PlanDetailPage />} />
        <Route path="/plans" element={<div data-testid="list-probe">列表探针</div>} />
        <Route path="/plan-reports/:id" element={<div data-testid="report-probe">报告探针</div>} />
        <Route path="/defects/:id" element={<div data-testid="defect-probe">缺陷探针</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const gets = (frag: string) => calls.filter((c) => c.method === "GET" && c.url.includes(frag));

/** 渲染 + 等首屏扇出落地 + D127 绊线：300ms 观察窗后**每个端点恰好一条**（⑪）。 */
async function renderSettled(): Promise<void> {
  renderPage();
  await waitFor(() => expect(screen.getByTestId("plan-link-row-lk1")).not.toBeNull());
  await waitFor(() => expect(screen.getByTestId("plan-report-row-r1")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 300));
  expect(gets("/plans/p1?")).toHaveLength(1);
  expect(gets("/plans/p1/status")).toHaveLength(1);
  expect(gets("/plans/p1/case-links")).toHaveLength(1);
  expect(gets("/plans/p1/bugs")).toHaveLength(1);
  expect(gets("/plans/p1/reports")).toHaveLength(1);
  expect(gets("/envs?")).toHaveLength(1);
}

/** AntD 在两汉字按钮里插空格、页码必须走类选择器（plans.test.tsx 同款）。
 *  D207 之后页面上同时有「关联用例」与「计划缺陷」两个分页器：
 *  这里只取关联用例卡片里的那个（报告侧仍缺 total，不参与）。 */
function pager(): HTMLElement {
  return within(screen.getByTestId("plan-detail-links")).getByTestId("list-pager");
}
function clickPage(n: number): void {
  fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
}
function openSelectByTestId(testid: string): void {
  const trigger = screen.getByTestId(testid).querySelector(".ant-select-selector") as HTMLElement;
  fireEvent.mouseDown(trigger);
}
async function clickOption(text: string): Promise<void> {
  const opt = await screen.findByText(text, {
    selector: ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content",
  });
  fireEvent.click(opt);
}

describe("权限门（无 read 零请求；写钮缺位不渲染）", () => {
  it("① 无 testplan:plan:read：闸门句在场，且**一条请求都不发**（含子列表与 envs）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER", my_perms: ["notify:channel:read"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-no-read")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("plan-detail-status-card")).toBeNull();
    expect(calls).toHaveLength(0); // 门在 effect：连 GET 都没发过，不是发了不画
  });

  it("①b 有 plan:read 缺 link:read/report:read：两节各明说不演空表、各零请求；计划/状态照常", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER",
      my_perms: ["testplan:plan:read", "-system:*"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-status-card")).not.toBeNull());
    expect(screen.getByTestId("plan-detail-links-noread")).not.toBeNull();
    expect(screen.getByTestId("plan-detail-reports-noread")).not.toBeNull();
    expect(screen.queryByTestId("plan-detail-links")).toBeNull();
    expect(screen.queryByTestId("plan-detail-bugs")).toBeNull();
    expect(screen.queryByTestId("plan-detail-reports")).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(gets("/case-links")).toHaveLength(0); // ⑫ 缺席断言的正对照在下面的请求计数里
    expect(gets("/bugs")).toHaveLength(0);
    expect(gets("/reports")).toHaveLength(0);
    expect(gets("/plans/p1?")).toHaveLength(1); // 正对照：不是整页都没请求
    expect(gets("/plans/p1/status")).toHaveLength(1);
  });

  it("⑦ READONLY：加关联/生成报告/归档/摘除/env 下拉都不在 DOM；表格与刷新在（缺席≠没渲染）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-row-lk1")).not.toBeNull());
    expect(screen.queryByTestId("plan-link-create")).toBeNull();
    expect(screen.queryByTestId("plan-report-generate")).toBeNull();
    expect(screen.queryByTestId("plan-detail-archive")).toBeNull();
    expect(screen.queryByTestId("plan-detail-execute")).toBeNull();
    expect(screen.queryByTestId("plan-link-remove-lk1")).toBeNull();
    expect(screen.queryByTestId("plan-link-env-edit-lk1")).toBeNull();
    expect(screen.queryByTestId("plan-link-env-edit-lk2")).toBeNull();
    // 正对照：行、结论单元格、返回/刷新都在——写钮的缺席不是整个区域没渲染
    expect(screen.getByTestId("plan-link-result-lk1")).not.toBeNull();
    expect(screen.getByTestId("plan-detail-reload")).not.toBeNull();
    expect(screen.getByTestId("plan-detail-back")).not.toBeNull();
  });

  it("⑦ 归档额外要求 :manage：MEMBER（有读写无 manage）没有归档钮；持 * 且未归档才有", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER",
      my_perms: ["testplan:plan:read", "testplan:plan:update", "testplan:link:read", "-system:*"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-status-card")).not.toBeNull());
    expect(screen.queryByTestId("plan-detail-archive")).toBeNull();
    expect(screen.getByTestId("plan-detail-reload")).not.toBeNull(); // 正对照：页没挂在半路
  });

  it("⑦ 已归档计划没有归档把手（终态不摆假门；删除本刀不在详情页提供）", async () => {
    mockBackend({ archivedPlan: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-archived-tag")).not.toBeNull());
    expect(screen.queryByTestId("plan-detail-archive")).toBeNull();
    expect(screen.getByTestId("plan-detail-reload")).not.toBeNull(); // 正对照
  });
});

describe("失败三态（403 权限页 / 404 原话不重试 / transient 可重试）", () => {
  it("② 404：后端原话逐字上屏，页面不崩、没有重试钮（不存在不是暂时）", async () => {
    mockBackend({ planStatus: 404 });
    renderPage();
    const alert = await screen.findByTestId("plan-detail-not-found");
    expect(screen.getByTestId("plan-detail-not-found-text").textContent).toBe(NOT_FOUND_RAW); // toBe：翻译必红
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull(); // × = 消证按钮，不许有
    expect(screen.queryByTestId("plan-detail-retry")).toBeNull();
    expect(screen.queryByTestId("plan-detail-status-card")).toBeNull();
  });

  it("② 403：撞后端门禁走 PermEmpty（位名只认后端原话）", async () => {
    mockBackend({ planStatus: 403 });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("perm-empty")).not.toBeNull());
    expect(screen.getByTestId("perm-empty-desc").textContent).toContain("testplan:plan:read");
    expect(screen.queryByTestId("plan-detail-status-card")).toBeNull();
  });

  it("② transient 503：非 closable 错误条 + 原话；点重试真重发并落地", async () => {
    mockBackend({ planFailOnce: true });
    renderPage();
    const alert = await screen.findByTestId("plan-detail-load-error");
    expect(alert.textContent).toContain("计划服务暂不可用：DB 连接超时");
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-detail-retry"));
    await waitFor(() => expect(screen.getByTestId("plan-detail-status-card")).not.toBeNull());
    expect(gets("/plans/p1?")).toHaveLength(2); // 正对照：重试真发了第二条，不是白渲染
  });

  it("② 状态单独挂：计划卡照画（名字/时间在），但**不画态**、两个率缺席", async () => {
    mockBackend({ statusFailOnce: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-status-error")).not.toBeNull());
    expect(screen.getByTestId("plan-detail-created").textContent).toBe("2026-11-20 10:30:00");
    expect(screen.queryByTestId("plan-detail-display-status")).toBeNull(); // 态只有 /status 答过
    expect(screen.queryByTestId("plan-detail-pass-rate")).toBeNull(); // 没结论就整块不画，不演 0%
    expect(screen.getByTestId("plan-detail-status-error").textContent).toContain("状态服务暂不可用");
  });
});

describe("数字直读 /status（判据 2/3：无第二算式）", () => {
  it("③ 两个率逐字 == fixture：naive pass=66.7%/exec=100% 的复算必红；环跟率走", async () => {
    mockBackend();
    await renderSettled();
    const pr = screen.getByTestId("plan-detail-pass-rate");
    expect(pr.getAttribute("data-rate")).toBe("0.6"); // 后端原值，不是 2/3
    expect(pr.textContent).toBe("60%"); // naive 除法给 67% —— 这里必红
    const er = screen.getByTestId("plan-detail-execute-rate");
    expect(er.getAttribute("data-rate")).toBe("0.8");
    expect(er.textContent).toBe("80%"); // naive executed/total 给 100% —— 这里必红
    // 「环跟率走」必须钉在**环自己画的那个数**上。先前钉的是外壳 data-percent——外壳当时
    // 是页面第三处 `Math.round(pass_rate*100)`，把 `<PassRing rate=...>` 换成
    // `passed/total` 时外壳照样跟着变，变异 V1 实测 SURVIVED（改坏了还全绿）。
    // 外壳已改成只挂原值 data-rate，环（PassRing 内的 report-pass-rate）是唯一算式。
    const ring = within(screen.getByTestId("plan-detail-pass-ring"))
      .getByTestId("report-pass-rate");
    expect(ring.getAttribute("data-percent")).toBe("60"); // naive 除法给 67
    expect(ring.textContent).toBe("60%");
    expect(screen.getByTestId("plan-detail-pass-ring").getAttribute("data-rate")).toBe("0.6");
    // 计数也只从 /status 来（fixture: total 3 / executed 3 / executing 1 / passed 2 / failed 1）
    const card = screen.getByTestId("plan-detail-status-card").textContent ?? "";
    expect(card).toContain("60%");
    expect(card).toContain("80%");
  });

  it("③b 空计划：0.0 照画 0%（空真不是结论），环也归 0；join 全空则行画「—」不编「通过」", async () => {
    mockBackend({ statusOver: { status: "not_started", total: 0, passed: 0, failed: 0,
      executed: 0, executing: 0, not_executed: 0, pass_rate: 0, execute_rate: 0, links: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-pass-rate")).not.toBeNull());
    expect(screen.getByTestId("plan-detail-pass-rate").textContent).toBe("0%"); // 不是 100% 也不是「-」
    expect(screen.getByTestId("plan-detail-execute-rate").textContent).toBe("0%");
    expect(within(screen.getByTestId("plan-detail-pass-ring"))
      .getByTestId("report-pass-rate").getAttribute("data-percent")).toBe("0");
    expect(screen.getByTestId("plan-detail-display-status").textContent).toBe("未开始");
    // 正对照：links 清空后每行都 join 不上 → 全「—」（unknown），没有任何一行被画成「通过」
    expect(screen.getByTestId("plan-link-result-lk1").getAttribute("data-result")).toBe("unknown");
    expect(screen.queryByTestId("plan-link-executing")).toBeNull();
  });

  it("④ straddle join：lk9 不在 status.links → 「—」（data-result=unknown），join 上的照常", async () => {
    mockBackend();
    await renderSettled();
    const unknown = screen.getByTestId("plan-link-result-lk9");
    expect(unknown.textContent).toBe("—");
    expect(unknown.getAttribute("data-result")).toBe("unknown"); // 不是 none——没答过≠答了没跑
    expect(screen.getByTestId("plan-link-result-lk1").getAttribute("data-result")).toBe("passed"); // 正对照
    expect(screen.getByTestId("plan-link-result-lk1").textContent).toContain("通过");
  });

  it("⑤ {executed:false, executing:true} → 执行中，且**不是**未执行（_link_result 回的是 none）", async () => {
    mockBackend();
    await renderSettled();
    const cell = screen.getByTestId("plan-link-result-lk2");
    expect(cell.getAttribute("data-result")).toBe("none"); // 后端原值在场……
    expect(cell.getAttribute("data-executing")).toBe("true"); // ……executing 必须先过一遍
    expect(cell.textContent).toContain("执行中");
    expect(cell.textContent).not.toContain("未执行"); // 正在跑被贴「未执行」= 本页最贵的谎
    // 正对照：全页只有 lk2 一处「执行中」徽标，lk1（executing:false）没有被顺带画上
    expect(screen.getAllByTestId("plan-link-executing")).toHaveLength(1);
  });

  it("⑥ 词表外 status 渲染原文（R112：不回落友好标签）", async () => {
    mockBackend({ displayStatus: "awaiting_approval" });
    renderPage();
    await waitFor(() => expect(
      screen.getByTestId("plan-detail-display-status").textContent).toBe("awaiting_approval"));
  });

  it("⑥b 词表外 **result** 也渲染原文（结论侧的 R112，与 ⑥ 同一把锁）", async () => {
    // 这条是**我自己跑变异补的**，不是照着用例清单写的：⑥ 只钉了 status 那一侧的兜底，
    // `LinkResultCell` 里 `LINK_RESULTS[st.result] ?? {label: st.result}` 那份**没人钉过**——
    // 把它改成 `?? LINK_RESULTS.none`（没见过的结论一律画「未执行」），31 例照全绿
    // （变异 V5b 实测 SURVIVED，见 `.tmp/d183s6/6b-mut-V5b.log`）。
    // 撒谎的形状很具体：一个还在跑、后端没判过的行被说成「未执行」，和 ⑤ 是同一类谎。
    mockBackend({ statusOver: { links: [
      { link_id: "lk1", subject_type: "api_case", subject_id: "c1", subject_name: "登录用例",
        env_id: null, executed: true, executing: false, result: "awaiting_review" },
      { link_id: "lk2", subject_type: "api_case", subject_id: "c2", subject_name: "下单用例",
        env_id: "e1", executed: false, executing: true, result: "none" },
    ] } });
    renderPage();
    await waitFor(() => expect(
      screen.getByTestId("plan-link-result-lk1").textContent).toContain("awaiting_review"));
    const cell = screen.getByTestId("plan-link-result-lk1");
    expect(cell.textContent).not.toContain("未执行"); // 绝不回落成认识的话
    expect(cell.getAttribute("data-result")).toBe("awaiting_review");
    // 正对照：同屏**词表内**那行照常走自己的分支（lk2 = none + executing → 只画「执行中」），
    // 证明兜底改动没有把整列拖成原文；这行同时是 ⑤ 的地盘，两条各钉各的。
    const ok = screen.getByTestId("plan-link-result-lk2");
    expect(ok.textContent).toContain("执行中");
    expect(ok.textContent).not.toContain("未执行");
  });
});

describe("线上 body 逐字段（断 JSON 本体，不钉「发过请求」）", () => {
  it("⑧ 加关联：POST body 恰好 {project_id,subject_type,subject_id,env_id}，不夹带 plan_id；成功后重拉列表与状态", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-link-create"));
    await screen.findByTestId("plan-picker-type");
    // 默认 api_case：等 api-cases 清单落地后点选 c1（正对照在下一条的搜索筛选里）
    await waitFor(() => expect(screen.getByTestId("plan-picker-row-c1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-picker-row-c1"));
    openSelectByTestId("plan-picker-env");
    await clickOption("预发环境");
    fireEvent.click(screen.getByTestId("plan-picker-submit"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST"
      && c.url.startsWith("/api/v1/plans/p1/case-links"))).toBe(true));
    const c = calls.find((x) => x.method === "POST" && x.url.startsWith("/api/v1/plans/p1/case-links"))!;
    expect(c.body).toEqual({ project_id: "p1", subject_type: "api_case",
      subject_id: "c1", env_id: "e2" }); // 恰四键；plan_id 在路径不在 body，混进来必红
    await waitFor(() => expect(gets("/case-links").length).toBeGreaterThan(1));
    await waitFor(() => expect(gets("/plans/p1/status").length).toBeGreaterThan(1)); // 分母变了
  });

  it("⑧ 后端 409 原话逐字回显在选择器里，弹窗不关可改可重试", async () => {
    mockBackend({ linkCreateFail: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-link-create"));
    await screen.findByTestId("plan-picker-id");
    fireEvent.change(screen.getByTestId("plan-picker-id"), { target: { value: "c9" } });
    fireEvent.click(screen.getByTestId("plan-picker-submit"));
    await waitFor(() => expect(screen.getByTestId("plan-picker-save-error")).not.toBeNull());
    expect(screen.getByTestId("plan-picker-save-error-text").textContent).toBe(BACKEND_409_LINK);
    expect(screen.getByTestId("plan-picker-id")).not.toBeNull(); // 失败不关窗
  });

  it("⑧ env 改绑 PATCH 只带 env_id；清空 PATCH 只带 clear_env——两个键永不同时在场", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-env-edit-lk1")).not.toBeNull());
    // 改绑：lk1 当前未覆盖 → 选「预发环境」
    openSelectByTestId("plan-link-env-edit-lk1");
    await clickOption("预发环境");
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.url).toContain("/plans/p1/case-links/lk1");
    expect(p.body).toEqual({ project_id: "p1", env_id: "e2" }); // 恰两键
    // 清空：lk2 当前覆盖 e1 → 点下拉的 clear
    fireEvent.mouseDown(screen.getByTestId("plan-link-env-edit-lk2")
      .querySelector(".ant-select-clear") as Element);
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").length).toBe(2));
    const pc = calls.filter((c) => c.method === "PATCH")[1];
    expect(pc.url).toContain("/plans/p1/case-links/lk2");
    expect(pc.body).toEqual({ project_id: "p1", clear_env: true }); // 恰两键，env_id 不在
    for (const c of calls.filter((x) => x.method === "PATCH")) {
      const b = c.body as Record<string, unknown>;
      expect("env_id" in b && "clear_env" in b).toBe(false); // 422「不能同时给」由构造堵死
    }
  });

  it("⑧ 摘除：DELETE 带 JSON body {project_id}（后端从 body 读）；确认后重拉列表与状态", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-remove-lk1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-link-remove-lk1"));
    fireEvent.click(await screen.findByTestId("plan-link-remove-ok"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE"
      && c.url.startsWith("/api/v1/plans/p1/case-links/lk1"))).toBe(true));
    const d = calls.find((c) => c.method === "DELETE")!;
    expect(d.body).toEqual({ project_id: "p1" }); // 只断「发过 DELETE」= 没断 body
    await waitFor(() => expect(gets("/case-links").length).toBeGreaterThan(1));
  });
});

describe("计划缺陷区块（D207 只读聚合）", () => {
  it("⑲ 缺陷行按状态词表人话上屏，标题是真链接且点了真去 /defects/:id", async () => {
    mockBackend();
    await renderSettled();
    expect(screen.getByTestId("plan-detail-bugs")).not.toBeNull();
    // 状态用缺陷域词表渲染，不把 in_process 原文丢给用户（R112 只对词表外的值兜底）。
    expect(screen.getByTestId("plan-bug-status-bg1").textContent).toBe("处理中");
    expect(screen.getByTestId("plan-bug-status-bg2").textContent).toBe("已解决");
    const row = screen.getByTestId("plan-bug-row-bg1");
    expect(row.tagName).toBe("A");
    expect(row.textContent).toBe("登录接口 500");
    // 处理人：有名字画名字；（无 id）画「—」，不编名字——由行渲染覆盖。
    expect(screen.getByTestId("plan-detail-bugs").textContent).toContain("张三");
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId("defect-probe")).not.toBeNull());
  });
});

describe("报告区块（6c 落地后行名是真链接；快照列照画）", () => {
  it("⑨ 报告行**是真链接且点了真去 /plan-reports/r1**（6b 钉「不是链接」与名列同批翻——路由在场，catch-all 弹回工作台已不存在）", async () => {
    // 6a ⑬/6b ⑨ 的翻面先例：app.tsx 已挂 `{path:"plan-reports/:id"}`，入口与这条 pin 必须
    // 同一提交翻——只翻一半要么留下「能点但弹回工作台」的假门，要么留下钉死路的空断言。
    mockBackend();
    await renderSettled();
    const cell = screen.getByTestId("plan-report-row-r1");
    expect(cell.tagName).toBe("A");
    // 正对照（点击**前**断言——点击即卸载，之后这些 testid 都不在 DOM 里）：翻成链接≠列没数据。
    const passCell = screen.getByTestId("plan-report-pass-r1");
    expect(passCell.getAttribute("data-rate")).toBe("0.6");
    expect(passCell.textContent).toContain("60%");
    // 环单独钉一次：上面 toContain("60%") 由旁边那个 `<span>{ratePct}</span>` 单独满足，
    // 环被改成 passed/total 现算（66.7→67）时它照绿——和状态卡 V1 同一个洞，变异 V3 实测。
    expect(within(passCell).getByTestId("report-pass-rate").getAttribute("data-percent")).toBe("60");
    expect(screen.getByTestId("plan-report-status-r1").textContent).toBe("已完成");
    fireEvent.click(cell);
    await waitFor(() => expect(screen.getByTestId("report-probe")).not.toBeNull());
  });

  it("生成报告：POST body 恰好 {project_id}，成功后报告列表重拉（不本地插行）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-generate")).not.toBeNull());
    const before = gets("/plans/p1/reports").length;
    fireEvent.click(screen.getByTestId("plan-report-generate"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST"
      && c.url.startsWith("/api/v1/plans/p1/reports"))).toBe(true));
    const c = calls.find((x) => x.method === "POST" && x.url.includes("/plans/p1/reports"))!;
    expect(c.body).toEqual({ project_id: "p1" });
    await waitFor(() => expect(gets("/plans/p1/reports").length).toBeGreaterThan(before));
  });
});

describe("分页与请求形状（⑩⑪⑭）", () => {
  it("⑩ 链接侧 total=137 →「共 137 条」；每条请求 current 在场、cursor 永不在场", async () => {
    mockBackend();
    await renderSettled();
    expect(pager().textContent).toContain("共 137 条"); // 行数 3 ≠ 总数
    expect(gets("/case-links").length).toBeGreaterThan(0);
    for (const c of gets("/case-links")) {
      const q = new URLSearchParams(c.url.slice(c.url.indexOf("?") + 1));
      expect(q.get("current")).toBe("1");
      expect(q.get("size")).toBe("50");
    }
    expect(gets("/case-links").some((c) => c.url.includes("cursor="))).toBe(false);
  });

  it("⑩ 报告侧响应缺 total 键 → 该分页器整块不渲染（DOM 里只剩关联与缺陷两个）", async () => {
    mockBackend();
    await renderSettled();
    // D207：链接侧 + 计划缺陷侧各有 total，报告侧缺 total 键故不渲染。
    expect(screen.getAllByTestId("list-pager")).toHaveLength(2);
    expect(screen.getByTestId("plan-report-row-r1")).not.toBeNull(); // 正对照：不是整节没渲染
  });

  it("⑩ 点第 3 页：恰好一条 current=3（无 cursor），行是替换不是追加", async () => {
    mockBackend();
    await renderSettled();
    const before = gets("/case-links").length;
    clickPage(3);
    await waitFor(() => expect(gets("/case-links").length).toBe(before + 1));
    const last = gets("/case-links").at(-1)!;
    const q = new URLSearchParams(last.url.slice(last.url.indexOf("?") + 1));
    expect(q.get("current")).toBe("3");
    expect(q.has("cursor")).toBe(false);
    await waitFor(() => expect(screen.getByTestId("plan-link-row-lkZ")).not.toBeNull());
    expect(screen.queryByTestId("plan-link-row-lk1")).toBeNull(); // append 变异这里 lk1 还在
  });

  it("⑭ 时间只走 fmtTime：+08:00 → 上海墙钟逐字对，缺值「—」（slice 变异会红）", async () => {
    mockBackend();
    await renderSettled();
    expect(screen.getByTestId("plan-detail-created").textContent).toBe("2026-11-20 10:30:00");
    expect(screen.getByTestId("plan-detail-updated").textContent).toBe("—");
    expect(screen.getAllByTestId("plan-link-created").map((n) => n.textContent))
      .toEqual(["2026-11-19 08:00:00", "—", "—"]);
  });
});

describe("选择器诚实（⑮：不许把「读不到/没搜到」演成「没有」）", () => {
  it("⑮ api_case 无服务端 keyword：搜索框旁自报「在本页已加载的 N 条里筛」，客户端过滤生效", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-link-create"));
    await waitFor(() => expect(screen.getByTestId("plan-picker-row-c1")).not.toBeNull());
    expect(screen.getByTestId("plan-picker-filter-note").textContent).toContain("在本页已加载的 1 条里筛");
    expect(screen.getByTestId("plan-picker-filter-note").textContent).toContain("后端不支持按名搜索");
    // 正对照 + 过滤腿：命中关键词留下，不命中明说「筛不到 ≠ 不存在」
    fireEvent.change(screen.getByTestId("plan-picker-search"), { target: { value: "登录" } });
    expect(screen.getByTestId("plan-picker-row-c1")).not.toBeNull();
    fireEvent.change(screen.getByTestId("plan-picker-search"), { target: { value: "zzz不存在的名字" } });
    expect(screen.queryByTestId("plan-picker-row-c1")).toBeNull();
    expect(screen.getByTestId("plan-picker-list").textContent).toContain("没有匹配项");
    // 诚实标签整句在场（筛不到 ≠ 不存在 说的是这句话）
    expect(screen.getByTestId("plan-picker-filter-note").textContent).toContain("筛不到 ≠ 不存在");
    // 请求形状正对照：api-cases 全程只一条（客户端过滤不许再打后端）
    expect(gets("/api-cases").length).toBe(1);
  });

  it("⑮ scenario 支持后端搜索：keyword 真随请求上线（诚实标签同样在场）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-link-create"));
    await screen.findByTestId("plan-picker-type");
    openSelectByTestId("plan-picker-type");
    await clickOption("场景（scenario）");
    await waitFor(() => expect(screen.getByTestId("plan-picker-row-s1")).not.toBeNull());
    fireEvent.change(screen.getByTestId("plan-picker-search"), { target: { value: "结算" } });
    await waitFor(() => expect(gets("/scenarios").at(-1)!.url).toContain("keyword="));
    expect(screen.getByTestId("plan-picker-filter-note").textContent).toContain("场景支持后端搜索");
  });

  it("⑮ 缺 api:case:read：类型明说「读不到清单 ≠ 没有」，ID 通路同屏可用", async () => {
    useAuth.setState({ project: { ...PROJECT, my_perms: [
      "testplan:plan:read", "testplan:link:read", "testplan:link:create",
      "testplan:link:update", "testplan:link:delete", "env:config:read", "-system:*"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-link-create"));
    await waitFor(() => expect(screen.getByTestId("plan-picker-perm-note")).not.toBeNull());
    expect(screen.getByTestId("plan-picker-perm-note").textContent).toContain("api:case:read");
    expect(screen.getByTestId("plan-picker-perm-note").textContent).toContain("不代表项目里没有");
    // 空列表不许冒充「没有用例」：清单区根本没渲染
    expect(screen.queryByTestId("plan-picker-list")).toBeNull();
    expect(screen.getByTestId("plan-picker-id")).not.toBeNull(); // ID 出口在
    expect(gets("/api-cases").length).toBe(0); // 没权限就不打这一枪
    // ID 通路走通：手填 id 挂入，body 恰三键（没选环境就不带 env_id 键）
    fireEvent.change(screen.getByTestId("plan-picker-id"), { target: { value: "c42" } });
    fireEvent.click(screen.getByTestId("plan-picker-submit"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST"
      && c.url.startsWith("/api/v1/plans/p1/case-links"))).toBe(true));
    const c = calls.find((x) => x.method === "POST" && x.url.startsWith("/api/v1/plans/p1/case-links"))!;
    expect(c.body).toEqual({ project_id: "p1", subject_type: "api_case", subject_id: "c42" });
  });
});

describe("归档（终态）与返回（⑯⑰）", () => {
  it("⑯ 归档：确认文案说无反归档；POST body 恰好 {project_id}；徽标翻、把手消失、/status 重取", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-archive")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-detail-archive"));
    const ok = await screen.findByTestId("plan-detail-archive-ok");
    expect(document.body.textContent).toContain("没有反归档入口");
    fireEvent.click(ok);
    await waitFor(() => expect(calls.some((c) => c.method === "POST"
      && c.url.endsWith("/plans/p1/archive"))).toBe(true));
    const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/archive"))!;
    expect(c.body).toEqual({ project_id: "p1" });
    await waitFor(() => expect(
      screen.getByTestId("plan-detail-archived-tag").textContent).toBe("已归档"));
    expect(screen.queryByTestId("plan-detail-archive")).toBeNull(); // 终态：把手随状态退场
    await waitFor(() => expect(gets("/plans/p1/status").length).toBe(2)); // 现算态跟着重取
  });

  it("⑰ 返回计划列表：点了真回 /plans（6b 路由落地的另一半）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-status-card")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-detail-back"));
    await waitFor(() => expect(screen.getByTestId("list-probe")).not.toBeNull());
  });

  it("页面契约（⑱）：page-plan-detail + PageHead 标题「计划详情」（nav.spec 同源）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("page-plan-detail")).not.toBeNull());
    expect(document.querySelector(".tp-page-title")?.textContent).toBe("计划详情");
  });

  it("⑬ env 诚实：未覆盖渲染「沿用对象默认」；缺 env:config:read 时 :update 角色也不摆空下拉", async () => {
    useAuth.setState({ project: { ...PROJECT, my_perms: [
      "testplan:plan:read", "testplan:link:read", "testplan:link:update", "-system:*"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-link-env-lk1")).not.toBeNull());
    expect(screen.getByTestId("plan-link-env-lk1").textContent).toContain("沿用对象默认");
    expect(screen.getByTestId("plan-link-env-lk2").textContent).toContain("e1"); // 无 env 读位画短 id
    expect(screen.queryByTestId("plan-link-env-edit-lk1")).toBeNull(); // 空下拉 = 假门
    expect(gets("/envs").length).toBe(0); // 摆不出下拉就连清单都不拉
    expect(screen.getByTestId("plan-detail-reload")).not.toBeNull(); // 正对照
  });
});

describe("D206 执行人 / 排序 / 批量摘除", () => {
  it("执行人：未指派 → 下拉选成员 → POST assign 逐字段，页面就地换名字", async () => {
    mockBackend();
    await renderSettled();
    const sel = screen.getByTestId("plan-link-executor-edit-lk1");
    expect(sel.textContent).toContain("未指派");

    openSelectByTestId("plan-link-executor-edit-lk1");
    await clickOption("李四");
    await waitFor(() => {
      const c = calls.find((c) => c.method === "POST" && c.url.endsWith("/case-links/assign"));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", link_ids: ["lk1"], executor_id: "u2" });
    });
    await waitFor(() => expect(sel.textContent).toContain("李四"));
  });

  it("排序：跨页（total 137）不摆把手；整页时才出现，上移 → POST sort 覆盖全部 id", async () => {
    mockBackend();
    await renderSettled();
    // 跨页时后端会 422 incomplete_sort（只排前 50 条 = 假门），所以把手必须缺席
    expect(screen.queryByTestId("plan-link-up-lk2")).toBeNull();

    cleanup();
    mockBackend({ linksOnOnePage: true });
    renderPage();
    const up = await screen.findByTestId("plan-link-up-lk2");
    fireEvent.click(up);
    await waitFor(() => {
      const c = calls.find((c) => c.method === "POST" && c.url.endsWith("/case-links/sort"));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", link_ids: ["lk2", "lk1", "lk9"] });
    });
  });

  it("批量摘除：勾选前不摆按钮；勾选后确认 → POST batch-delete 只带选中 id", async () => {
    mockBackend({ linksOnOnePage: true });
    await renderSettled();
    expect(screen.queryByTestId("plan-link-batch-remove")).toBeNull();

    const headerBox = document.querySelector("thead .ant-checkbox-input") as HTMLInputElement;
    fireEvent.click(headerBox);
    await waitFor(() => expect(screen.getByTestId("plan-link-batch-remove")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-link-batch-remove"));
    // 只能认「批量摘除」这一个 confirm：Modal.confirm portal 在 cleanup 外，
    // 前面用例可能留下别的 danger 模态，按类选择会点到别人的 OK（实测踩过）。
    const modal = await waitFor(() => {
      const m = Array.from(document.querySelectorAll(".ant-modal-confirm"))
        .find((el) => el.textContent?.includes("批量摘除"));
      expect(m).not.toBeUndefined();
      return m as HTMLElement;
    });
    fireEvent.click(modal.querySelector(".ant-btn-dangerous") as Element);
    await waitFor(() => {
      const c = calls.find((c) => c.method === "POST" && c.url.endsWith("/case-links/batch-delete"));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", link_ids: ["lk1", "lk2", "lk9"] });
    });
  });
});

describe("D210 报告改名 / 删除", () => {
  it("重命名：确认后 PATCH /plan-reports/r1 恰好 {project_id, name}，成功后重取报告列表", async () => {
    mockBackend();
    await renderSettled();
    const before = gets("/plans/p1/reports").length;
    fireEvent.click(screen.getByTestId("plan-report-rename-r1"));
    const modal = await waitFor(() => {
      const m = Array.from(document.querySelectorAll(".ant-modal-confirm"))
        .find((el) => el.textContent?.includes("重命名报告"));
      expect(m).not.toBeUndefined();
      return m as HTMLElement;
    });
    fireEvent.change(within(modal).getByTestId("plan-report-rename-input"), {
      target: { value: " 新标题 " },
    });
    fireEvent.click(modal.querySelector(".ant-btn-primary") as Element);
    await waitFor(() => {
      const c = calls.find((c) => c.method === "PATCH" && c.url.includes("/plan-reports/r1"));
      expect(c).toBeTruthy();
      // trim 后的名，且不带 report_id 之类多余键
      expect(c!.body).toEqual({ project_id: "p1", name: "新标题" });
    });
    await waitFor(() => expect(gets("/plans/p1/reports").length).toBeGreaterThan(before));
  });

  it("删除：确认后 DELETE /plan-reports/r1 带 {project_id}，成功后重取列表", async () => {
    mockBackend();
    await renderSettled();
    const before = gets("/plans/p1/reports").length;
    fireEvent.click(screen.getByTestId("plan-report-remove-r1"));
    const modal = await waitFor(() => {
      const m = Array.from(document.querySelectorAll(".ant-modal-confirm"))
        .find((el) => el.textContent?.includes("删除报告"));
      expect(m).not.toBeUndefined();
      return m as HTMLElement;
    });
    fireEvent.click(modal.querySelector(".ant-btn-dangerous") as Element);
    await waitFor(() => {
      const c = calls.find((c) => c.method === "DELETE" && c.url.includes("/plan-reports/r1"));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1" });
    });
    await waitFor(() => expect(gets("/plans/p1/reports").length).toBeGreaterThan(before));
  });

  it("缺 :update/:delete 位（READONLY 只有 *:read）→ 两个钮都不渲染，不演禁用假门", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-row-r1")).not.toBeNull()); // 读门在，报告照看
    expect(screen.queryByTestId("plan-report-rename-r1")).toBeNull();
    expect(screen.queryByTestId("plan-report-remove-r1")).toBeNull();
  });
});

// ── D218：功能用例的结论历史（Drawer + 服务端页码分页）──────────────────────────
describe("D218 功能用例结论历史", () => {
  it("打开历史：current=1&size=10、newest-first、共 12 条；翻第 2 页再发 current=2", async () => {
    mockBackend({ functionalLinks: true });
    renderPage();
    // 本腿的关联列表只有一条功能用例（没有 lk1），所以等它自己的行，不复用等 lk1 的 helper
    fireEvent.click(await screen.findByTestId("plan-func-history-lkF"));
    expect(await screen.findByTestId("plan-func-history-table")).toBeTruthy();
    const histCalls = () => calls.filter((c) => c.url.includes("/history"));
    await waitFor(() => expect(histCalls().length).toBe(1));
    expect(histCalls()[0].url).toContain("current=1");
    expect(histCalls()[0].url).toContain("size=10");
    expect(histCalls()[0].url).toContain("project_id=p1");
    // newest-first：第 12 次改判在第 1 页，第 1 次不在（服务端真的切了页）
    expect(await screen.findByText("第 12 次改判")).toBeTruthy();
    expect(screen.queryByText("第 1 次改判")).toBeNull();
    expect(document.body.textContent).toContain("共 12 条");
    fireEvent.click(document.querySelector(".ant-pagination-item-2 a") as Element);
    await waitFor(() => expect(histCalls().length).toBe(2));
    expect(histCalls()[1].url).toContain("current=2");
    expect(await screen.findByText("第 1 次改判")).toBeTruthy();
    expect(screen.queryByText("第 12 次改判")).toBeNull();
  });
});


// ── D225：执行计划（投递回执）────────────────────────────────────────────
describe("D225 执行计划", () => {
  it("POST body 恰好 {project_id, plan_id}；回执逐条列结果；状态与关联各重取一次", async () => {
    mockBackend();
    renderPage();
    const statusBefore = calls.filter((c) => c.url.includes("/plans/p1/status")).length;
    const linksBefore = calls.filter((c) => c.url.includes("/case-links")).length;
    fireEvent.click(await screen.findByTestId("plan-detail-execute"));

    const modal = await screen.findByTestId("plan-execute-modal");
    await waitFor(() => expect(within(modal).getByText("已投递 1 条，2 条未投递")).not.toBeNull());
    const post = calls.find((c) => c.url === "/api/v1/plans/p1/execute" && c.method === "POST");
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ project_id: "p1", plan_id: "p1" });
    // 跳过原因是后端原话，不是前端编的「不支持」
    expect(within(modal).getByText(/接口用例尚无独立执行引擎/)).not.toBeNull();
    expect(within(modal).getByText(/功能用例是人工执行/)).not.toBeNull();
    expect(within(modal).getByText("结算主链路")).not.toBeNull();
    // 投递后状态卡与关联表都要重取（不是本地插一行）
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/plans/p1/status")).length)
      .toBeGreaterThan(statusBefore));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/case-links")).length)
      .toBeGreaterThan(linksBefore));
    // 关闭把手的唯一契约是「存在且点了不炸」；AntD 的关层是动画 + 卸载的混合行为，
    // 断 DOM 是否消失会把实现细节钉死（rc-motion 版本一变就红）。
    fireEvent.click(screen.getByTestId("plan-execute-close"));
    expect(screen.getByTestId("plan-execute-close")).toBeTruthy();
  });

  it("归档计划不摆执行钮（后端 409 的假门）", async () => {
    mockBackend({ archivedPlan: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-detail-status-card")).not.toBeNull());
    expect(screen.queryByTestId("plan-detail-execute")).toBeNull();
    expect(screen.queryByTestId("plan-detail-archive")).toBeNull();
  });
});

// ── D231：计划关注 ─────────────────────────────────────────────────────────
describe("D231 关注（两问都照抄后端回执）", () => {
  it("① 关注钮 body 恰为 {project_id}；followed 与 follower_count 跟着回执走（不本地 ±1）", async () => {
    mockBackend();
    await renderSettled();
    expect(screen.getByTestId("plan-detail-follower-count").textContent).toContain("0 人关注");
    const btn = screen.getByTestId("plan-detail-follow");
    expect(btn.getAttribute("data-followed")).toBe("false");

    fireEvent.click(btn);
    await waitFor(() => expect(calls.some(
      (c) => c.url === "/api/v1/plans/p1/follow" && c.method === "POST")).toBe(true));
    const req = calls.find((c) => c.url === "/api/v1/plans/p1/follow");
    expect(req!.body).toEqual({ project_id: "p1" });
    // 桩给的是 count=3（不是 0+1），页面必须显示 3——本地 +1 的人会显示 1。
    await waitFor(() => expect(screen.getByTestId("plan-detail-follow")
      .getAttribute("data-followed")).toBe("true"));
    expect(screen.getByTestId("plan-detail-follower-count").textContent).toContain("3 人关注");

    // 再点：followed 已 true → 走 unfollow；回执 count=2 照抄。
    fireEvent.click(screen.getByTestId("plan-detail-follow"));
    await waitFor(() => expect(calls.some(
      (c) => c.url === "/api/v1/plans/p1/unfollow" && c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("plan-detail-follow")
      .getAttribute("data-followed")).toBe("false"));
    expect(screen.getByTestId("plan-detail-follower-count").textContent).toContain("2 人关注");
  });

  it("② READONLY：关注钮不渲染（写位 :update），「N 人关注」是读信息照常在场", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    renderPage();
    // READONLY 没有 env:config:read，envs 腿本来就不发——不用 renderSettled 的全腿断言。
    await waitFor(() => expect(screen.getByTestId("plan-detail-follower-count")).not.toBeNull());
    expect(screen.queryByTestId("plan-detail-follow")).toBeNull();
    expect(screen.getByTestId("plan-detail-follower-count").textContent).toContain("0 人关注");
  });
});