// 计划报告详情页（D183 步 6c）组件测试。fetch 全 mock，手法照 planDetail.test.tsx（6b，最新同族）。
// 这份文件防的谎，逐条编号：
// ① 无 testplan:report:read → 闸门一句人话，**任何请求一条都不发**（详情与 /items 都没发过，
//    门在 effect 上，不在渲染里）；
// ② 失败四态分岔：403 → PermEmpty（位名只认后端原话）；404 与 410 → 后端原话逐字上屏
//    （不翻译、不 closable、**不摆重试**——不存在不是暂时）；transient → 非 closable 错误条 +
//    重试钮真重发；
// ③ 无第二算式：两个率与六个计数渲染值逐字 == fixture（fixture 特意让 naive 除法对不上——
//    pass 2/6=33% vs 0.6、exec 4/6=67% vs 0.75；页面里任何复算必红，判据 2 到前端的形状）；
//    环钉在 PassRing 自己的 data-percent 上（外壳只挂原值 data-rate，6b V1 变异的教训）；
// ④ 快照不回查实时：表格行喂自 /items 分页窗口，**不喂**详情内联 items（fixture 里二者故意
//    不同——喂错必红）；页面全程不发 /plans/*/status，也不 join 资产表；
// ⑤ {executed:false, executing:true, result:"none"} → 画「执行中」**不画「未执行」**
//    （result 对没跑过的行恒是 none，必须先问 executing，口径同 6b③）；
// ⑥ 词表外 status 渲染原文（planDisplayMeta，R112：不回落友好标签）；
// ⑦ 缺 testplan:report:delete → 删除钮**不渲染**（不是禁用）；有 :delete 才在；
// ⑧ 删除线上 body 恰好 {project_id}；确认文案只说后端答过的事实（级联只按 report_id）；
//    删成功导航回所属计划详情——原地不留「已删除」假状态；
// ⑨ 明细分页请求形状：current/size 在场、**cursor 键永不在场**、total=137 行数≠总数
//    （total=items.length 在「共 137 条」露馅）、翻页恰好一条且是替换不是追加；
//    /items 响应缺 total 键 → 分页器整块不渲染；
// ⑩ 挂载扇出的 D127 绊线：详情与 /items 各恰好一条，300ms 观察窗后仍各一条；
// ⑪ 明细节单独挂：错误条上屏 + 空表文案指向错误条（把「取不到」演成「没有」是 6b 同款谎）；
// ⑫ 时间只走 fmtTime（+08:00 ISO → 上海墙钟逐字对，slice/toLocaleString 变异会红）；
// ⑬ env 诚实：env_id=null 渲染「沿用对象默认」不是「无环境」；有 id 画短 id 不编名；
// ⑭ 返回所属计划 / 所属计划链接真导航（探针页手法，6b ⑰ 同款）；
// ⑮ 页面契约：page-plan-report-detail + PageHead 标题「计划报告详情」（nav.spec 钉的同一对）。
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

import PlanReportDetailPage from "./planReportDetail";
import { useAuth } from "../auth/store";
import type { components } from "../api/schema";

type PlanReportItemOut = components["schemas"]["PlanReportItemOut"];

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

// 头 fixture（判据 2 的引信）：naive 除法 pass=2/6=33%、exec=4/6=67%，
// 后端给的是 0.6 / 0.75——页面复算必被 ③ 抓到。六个计数也是 naive 拼不出的组合。
function report(over: Record<string, unknown> = {}) {
  return { id: "r1", project_id: "p1", plan_id: "p1", name: "结算回归 报告",
    status: "completed", total: 6, passed: 2, failed: 1, executed: 4, executing: 1,
    not_executed: 2, pass_rate: 0.6, execute_rate: 0.75, created_by: "u1",
    created_at: "2026-11-20T12:00:00+08:00", updated_at: null,
    // 详情内联 items 故意与 /items 窗口**不同源**（④）：表格喂错必红。
    items: [{ id: "INLINE_ONLY", report_id: "r1", link_id: "lkX", subject_type: "api_case",
      subject_id: "cX", subject_name: "不该出现在表里的内联行", env_id: null,
      executed: true, executing: false, result: "passed", created_at: null, updated_at: null }],
    ...over };
}

function item(id: string, over: Partial<PlanReportItemOut> = {}): PlanReportItemOut {
  return { id, report_id: "r1", link_id: "lk-" + id, subject_type: "api_case", subject_id: "c1",
    subject_name: "登录用例", env_id: "e1", executed: true, executing: false, result: "passed",
    created_at: null, updated_at: null, ...over };
}

// 明细 fixture：it1 正常 passed；it2 {executed:false, executing:true, result:"none"}——
// 「跑着≠没跑过」那条谎的形状（⑤）；it9 env_id=null（⑬「沿用对象默认」腿）+ failed。
const IT1 = item("it1", { created_at: "2026-11-20T12:00:00+08:00" });
const IT2 = item("it2", { subject_id: "c2", subject_name: "下单用例", executed: false,
  executing: true, result: "none" });
const IT9 = item("it9", { subject_id: "c9", subject_name: "退款用例", env_id: null,
  result: "failed" });
/** 词表外的**结论**值（⑥b）：后端哪天加第五态，或这条明细被别的写入方写了个没见过的串。
 *  只在 `weirdResult` 腿里出现——默认腿的行数被 ⑨/⑩ 数着，不能多塞。 */
const IT8 = item("it8", { subject_id: "c8", subject_name: "对账用例", result: "awaiting_review" });
const ITEMS_TOTAL = 137; // 行数 3 ≠ 总数：total=items.length 在「共 137 条」露馅

const calls: { url: string; method: string; body: unknown }[] = [];

/** 后端原话：独特到不可能被硬编码——前端翻译/硬编码必被 toBe 抓。 */
const NOT_FOUND_RAW = "报告不存在（跨项目与不存在同码同文，码 0xd183c4）";
const GONE_RAW = "报告已被回收（410 腿，码 0xd183c5）";

interface Opts {
  /** GET /plan-reports/{id} 的状态码覆盖（403/404/410/503…）。 */
  reportStatus?: number;
  /** 首次 GET /plan-reports/{id} 失败、之后成功（transient 重试腿）。 */
  reportFailOnce?: boolean;
  /** GET /items 的状态码覆盖（明细节失败腿）。 */
  itemsStatus?: number;
  /** /items 响应**去掉 total 键**（分页器整块不渲染腿）。 */
  itemsNoTotal?: boolean;
  /** 报告 fixture 的 status 字段覆盖（词表外值腿）。 */
  displayStatus?: string;
  /** 明细某行的 `result` 给一个**词表外**的值（⑥b 腿：结论侧的 R112，变异 V5 实测补的）。 */
  weirdResult?: boolean;
  /** 空报告：全零计数 + 两率 0.0 + 空 items（③b 腿，后端口径空报告是 0% 不是 100%）。 */
  emptyReport?: boolean;
  /** D230：导出端点状态码覆盖（失败腿）。 */
  exportStatus?: number;
}

/** D230 导出载体 fixture：内容独特到不可能被前端现拼（透传不等于字面相等即红）。 */
const EXPORT_HTML = "<!DOCTYPE html><html><body><h1>计划报告 · 结算回归 报告</h1>"
  + "<div>后端渲染的快照明细</div></body></html>";
const EXPORT_FILENAME = "结算回归 报告-2026-11-20.html";
/** 最近一次 createObjectURL 收到的 Blob（jsdom 没有真实下载，落地动作只能押在这里）。 */
let lastBlob: Blob | null = null;

function mockBackend(over: Opts = {}) {
  calls.length = 0;
  let reportFailed = false;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const resp = (status: number, json: unknown) => ({
      ok: status < 400, status,
      // 深拷同 planDetail.test.tsx:152：桩不许比真 fetch 更好说话。
      json: async () => JSON.parse(JSON.stringify(json)) as unknown,
    }) as unknown as Response;
    if (url.startsWith("/api/v1/plan-reports/r1/items")) {
      if (over.itemsStatus) {
        return resp(over.itemsStatus, { code: "items_unavailable",
          message: "明细服务暂不可用：DB 连接超时", details: {} });
      }
      const cur = Number(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("current") ?? "1");
      if (over.emptyReport) return resp(200, { items: [], next_cursor: null, total: 0 });
      const items = cur === 3 ? [item("itZ", { subject_name: "第三页明细" })]
        : over.weirdResult ? [IT1, IT2, IT9, IT8] : [IT1, IT2, IT9];
      // ⑨ 的另一半：缺 total 键 → 分页器整块不渲染（正对照是默认腿的「共 137 条」在场）。
      return resp(200, over.itemsNoTotal
        ? { items, next_cursor: null }
        : { items, next_cursor: null, total: ITEMS_TOTAL });
    }
    if (url.startsWith("/api/v1/plan-reports/r1/export") && method === "GET") {
      if (over.exportStatus) {
        return resp(over.exportStatus, { code: "export_failed",
          message: "导出失败：storage 不可写", details: {} });
      }
      return resp(200, { filename: EXPORT_FILENAME, media_type: "text/html; charset=utf-8",
        content: EXPORT_HTML, item_count: ITEMS_TOTAL });
    }
    if (url.startsWith("/api/v1/plan-reports/r1") && method === "DELETE") {
      return resp(200, { ok: true });
    }
    if (url.startsWith("/api/v1/plan-reports/r1?") && method === "GET") {
      if (over.reportStatus) {
        const s = over.reportStatus;
        const msg = s === 403 ? "缺少权限：testplan:report:read"
          : s === 410 ? GONE_RAW : NOT_FOUND_RAW;
        return resp(s, { code: s === 403 ? "insufficient_permission" : s === 410 ? "gone" : "not_found",
          message: msg, details: s === 403 ? { perm: "testplan:report:read" } : { report_id: "r1" } });
      }
      if (over.reportFailOnce && !reportFailed) {
        reportFailed = true;
        return resp(503, { code: "report_unavailable", message: "报告服务暂不可用：DB 连接超时",
          details: {} });
      }
      return resp(200, report(over.emptyReport
        ? { total: 0, passed: 0, failed: 0, executed: 0, executing: 0, not_executed: 0,
            pass_rate: 0, execute_rate: 0, status: "not_started", items: [] }
        : over.displayStatus ? { status: over.displayStatus } : {}));
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

// vitest 无 globals ⇒ RTL 自动 cleanup 不注册：两头各清一次（planDetail.test.tsx 同款）。
afterEach(cleanup);
beforeEach(() => {
  cleanup();
  localStorage.clear();
  lastBlob = null;
  // jsdom 不实现 createObjectURL：下载落地只能在这里押（revoke 同步清掉无副作用）。
  Object.defineProperty(URL, "createObjectURL", {
    writable: true, value: (b: Blob) => { lastBlob = b; return "blob:d230"; },
  });
  Object.defineProperty(URL, "revokeObjectURL", { writable: true, value: () => {} });
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

function renderPage(entry = "/plan-reports/r1"): void {
  // 探针路由：⑭ 的两条导航与 ⑧ 删后回跳都要能断「点了落在哪」（页面本体由本文件其余用例钉）。
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/plan-reports/:id" element={<PlanReportDetailPage />} />
        <Route path="/plans/:id" element={<div data-testid="plan-probe">计划探针</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const gets = (frag: string) => calls.filter((c) => c.method === "GET" && c.url.includes(frag));

/** 渲染 + 等首屏扇出落地 + D127 绊线：300ms 观察窗后**每个端点恰好一条**（⑩）。 */
async function renderSettled(): Promise<void> {
  renderPage();
  await waitFor(() => expect(screen.getByTestId("plan-report-item-row-it1")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 300));
  expect(gets("/plan-reports/r1?")).toHaveLength(1);
  expect(gets("/plan-reports/r1/items")).toHaveLength(1);
}

function pager(): HTMLElement {
  return screen.getByTestId("list-pager");
}
function clickPage(n: number): void {
  fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
}

describe("权限门（无 read 零请求；缺 delete 不渲染删除钮）", () => {
  it("① 无 testplan:report:read：闸门句在场，且**一条请求都不发**（详情与明细都没发过）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER", my_perms: ["testplan:plan:read"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-detail-no-read")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("plan-report-detail-overview")).toBeNull();
    expect(calls).toHaveLength(0); // 门在 effect：连 GET 都没发过，不是发了不画
  });

  it("⑦ 缺 testplan:report:delete：删除钮**不渲染**（不是禁用）；概览与明细照常（正对照）", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER",
      my_perms: ["testplan:report:read", "-system:*"] } });
    mockBackend();
    await renderSettled();
    expect(screen.queryByTestId("plan-report-detail-delete")).toBeNull();
    // 正对照：读到了内容、刷新在——缺席不是整页没渲染
    expect(screen.getByTestId("plan-report-detail-overview")).not.toBeNull();
    expect(screen.getByTestId("plan-report-detail-reload")).not.toBeNull();
  });
});

describe("失败四态（403 权限页 / 404·410 原话不重试 / transient 可重试）", () => {
  it("② 404：后端原话逐字上屏，页面不崩、没有重试钮（不存在不是暂时）", async () => {
    mockBackend({ reportStatus: 404 });
    renderPage();
    const alert = await screen.findByTestId("plan-report-detail-not-found");
    expect(screen.getByTestId("plan-report-detail-not-found-text").textContent).toBe(NOT_FOUND_RAW); // toBe：翻译必红
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull(); // × = 消证按钮，不许有
    expect(screen.queryByTestId("plan-report-detail-retry")).toBeNull();
    expect(screen.queryByTestId("plan-report-detail-overview")).toBeNull();
  });

  it("② 410：同一条诚实路（原话逐字、不重试）——410 单独一支，防哪天只认 404", async () => {
    mockBackend({ reportStatus: 410 });
    renderPage();
    const alert = await screen.findByTestId("plan-report-detail-not-found");
    expect(screen.getByTestId("plan-report-detail-not-found-text").textContent).toBe(GONE_RAW);
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
    expect(screen.queryByTestId("plan-report-detail-retry")).toBeNull();
  });

  it("② 403：撞后端门禁走 PermEmpty（位名只认后端原话）", async () => {
    mockBackend({ reportStatus: 403 });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("perm-empty")).not.toBeNull());
    expect(screen.getByTestId("perm-empty-desc").textContent).toContain("testplan:report:read");
    expect(screen.queryByTestId("plan-report-detail-overview")).toBeNull();
  });

  it("② transient 503：非 closable 错误条 + 原话；点重试真重发并落地", async () => {
    mockBackend({ reportFailOnce: true });
    renderPage();
    const alert = await screen.findByTestId("plan-report-detail-load-error");
    expect(alert.textContent).toContain("报告服务暂不可用：DB 连接超时");
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
    fireEvent.click(screen.getByTestId("plan-report-detail-retry"));
    await waitFor(() => expect(screen.getByTestId("plan-report-detail-overview")).not.toBeNull());
    expect(gets("/plan-reports/r1?")).toHaveLength(2); // 正对照：重试真发了第二条，不是白渲染
  });
});

describe("数字直读详情头（判据 2/3：无第二算式）", () => {
  it("③ 两个率与六个计数逐字 == fixture：naive pass=33%/exec=67% 的复算必红；环跟率走", async () => {
    mockBackend();
    await renderSettled();
    const pr = screen.getByTestId("plan-report-detail-pass-rate");
    expect(pr.getAttribute("data-rate")).toBe("0.6"); // 后端原值，不是 2/6
    expect(pr.textContent).toBe("60%"); // naive 除法给 33% —— 这里必红
    const er = screen.getByTestId("plan-report-detail-execute-rate");
    expect(er.getAttribute("data-rate")).toBe("0.75");
    expect(er.textContent).toBe("75%"); // naive executed/total 给 67% —— 这里必红
    // 「环跟率走」钉在**环自己画的那个数**上（6b V1 教训：钉外壳=钉副本，变异照绿）。
    const ring = within(screen.getByTestId("plan-report-detail-pass-ring"))
      .getByTestId("report-pass-rate");
    expect(ring.getAttribute("data-percent")).toBe("60"); // naive 除法给 33
    expect(ring.textContent).toBe("60%");
    expect(screen.getByTestId("plan-report-detail-pass-ring").getAttribute("data-rate")).toBe("0.6");
    // 六个计数逐字 == fixture（fixture 是 naive 拼不出的组合：total6/p2/f1/ex4/ig1/ne2）
    expect(screen.getByTestId("plan-report-detail-total").textContent).toBe("6");
    expect(screen.getByTestId("plan-report-detail-executed").textContent).toBe("4");
    expect(screen.getByTestId("plan-report-detail-executing").textContent).toBe("1");
    expect(screen.getByTestId("plan-report-detail-not-executed").textContent).toBe("2");
    expect(screen.getByTestId("plan-report-detail-passed").textContent).toBe("2");
    expect(screen.getByTestId("plan-report-detail-failed").textContent).toBe("1");
  });

  it("③b 空报告：0.0 照画 0%（空真不是结论），环也归 0", async () => {
    // 后端口径（PlanReportOut docstring）：空报告两率 0.0 不是 1.0。
    mockBackend({ emptyReport: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-detail-pass-rate")).not.toBeNull());
    expect(screen.getByTestId("plan-report-detail-pass-rate").textContent).toBe("0%"); // 不是 100% 也不是「-」
    expect(screen.getByTestId("plan-report-detail-execute-rate").textContent).toBe("0%");
    expect(within(screen.getByTestId("plan-report-detail-pass-ring"))
      .getByTestId("report-pass-rate").getAttribute("data-percent")).toBe("0");
  });

  it("⑥ 词表外 status 渲染原文（R112：不回落友好标签）", async () => {
    mockBackend({ displayStatus: "awaiting_approval" });
    renderPage();
    await waitFor(() => expect(
      screen.getByTestId("plan-report-detail-status").textContent).toBe("awaiting_approval"));
  });

  it("⑥b 词表外 **result** 也渲染原文（结论侧的 R112，和 status 同一把锁）", async () => {
    // 为什么单独一条：⑥ 只钉了 **status** 那一侧的兜底，`ItemResultCell` 里那份
    // `LINK_RESULTS[it.result] ?? {label: it.result}` **没人钉过**——把兜底改成
    // `?? LINK_RESULTS.none`（未知结论一律画「未执行」），21 例照全绿。
    // 这是我自己跑变异（V5）测出来的洞，不是 agent 报的：见台账第六十七轮 §三附。
    // 撒谎的形状很具体：一个没跑完就被判成「未执行」，和 ⑤ 是同一类谎的反面。
    mockBackend({ weirdResult: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-item-row-it8")).not.toBeNull());
    const cell = screen.getByTestId("plan-report-item-result-it8");
    expect(cell.textContent).toContain("awaiting_review"); // 生码原样上屏
    expect(cell.textContent).not.toContain("未执行"); // 绝不回落成认识的话
    expect(cell.getAttribute("data-result")).toBe("awaiting_review");
    // 正对照：同屏的词表内行照常画友好标签（不是整列退化成了原文）
    expect(screen.getByTestId("plan-report-item-result-it1").textContent).toContain("通过");
  });

  it("④ 表格喂自 /items 分页窗口，不喂详情内联 items；全程不回查实时状态", async () => {
    mockBackend();
    await renderSettled();
    // /items fixture 的行在；详情内联那份不同源（INLINE_ONLY），喂错它就会出现
    expect(screen.getByTestId("plan-report-item-row-it1")).not.toBeNull();
    expect(screen.queryByTestId("plan-report-item-row-INLINE_ONLY")).toBeNull();
    // 快照不回查实时：/plans 系一条都不发（详情与明细都不 join 实时态/资产表）
    expect(calls.filter((c) => c.url.includes("/plans/"))).toHaveLength(0);
  });
});

describe("明细诚实（⑤⑬⑪⑫）", () => {
  it("⑤ {executed:false, executing:true} → 执行中，且**不是**未执行（result 恒是 none）", async () => {
    mockBackend();
    await renderSettled();
    const cell = screen.getByTestId("plan-report-item-result-it2");
    expect(cell.getAttribute("data-result")).toBe("none"); // 后端原值在场……
    expect(cell.getAttribute("data-executing")).toBe("true"); // ……executing 必须先过一遍
    expect(cell.textContent).toContain("执行中");
    expect(cell.textContent).not.toContain("未执行"); // 正在跑被贴「未执行」= 本页最贵的谎
    // 正对照：全页只有 it2 一处「执行中」徽标，it1（executing:false）没有被顺带画上
    expect(screen.getAllByTestId("plan-report-item-executing")).toHaveLength(1);
  });

  it("⑬ env 诚实：env_id=null 渲染「沿用对象默认」不是「无环境」；有 id 画短 id 不编名", async () => {
    mockBackend();
    await renderSettled();
    expect(screen.getByTestId("plan-report-item-env-it9").textContent).toContain("沿用对象默认");
    expect(screen.getByTestId("plan-report-item-env-it9").textContent).not.toContain("无环境");
    expect(screen.getByTestId("plan-report-item-env-it1").textContent).toContain("e1"); // 生码直读
  });

  it("⑪ 明细单独挂：错误条上屏，空表文案指向错误条——取不到不许演成没有", async () => {
    mockBackend({ itemsStatus: 503 });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-detail-items-error")).not.toBeNull());
    expect(screen.getByTestId("plan-report-detail-items-error").textContent)
      .toContain("明细服务暂不可用：DB 连接超时");
    const items = screen.getByTestId("plan-report-detail-items").textContent ?? "";
    expect(items).toContain("原因见上方错误条"); // 不是「这份报告没有明细」
    expect(items).not.toContain("快照就是空的"); // 失败腿不许走空快照文案
    expect(screen.getByTestId("plan-report-detail-overview")).not.toBeNull(); // 正对照：头照常
  });

  it("⑫ 时间只走 fmtTime：+08:00 → 上海墙钟逐字对，缺值「—」（slice 变异会红）", async () => {
    mockBackend();
    await renderSettled();
    expect(screen.getByTestId("plan-report-detail-created").textContent).toBe("2026-11-20 12:00:00");
    expect(screen.getByTestId("plan-report-detail-updated").textContent).toBe("—");
    // 三行明细全钉：it1 有值走 fmtTime 换算，it2/it9 缺值画「—」（不是空串、不是编时刻）
    expect(screen.getAllByTestId("plan-report-item-created").map((n) => n.textContent))
      .toEqual(["2026-11-20 12:00:00", "—", "—"]);
  });
});

describe("分页与请求形状（⑨⑩）", () => {
  it("⑨ total=137 →「共 137 条」；每条请求 current/size/project_id 在场、cursor 永不在场", async () => {
    mockBackend();
    await renderSettled();
    expect(pager().textContent).toContain("共 137 条"); // 行数 3 ≠ 总数
    expect(gets("/plan-reports/r1/items").length).toBeGreaterThan(0);
    for (const c of gets("/plan-reports/r1/items")) {
      const q = new URLSearchParams(c.url.slice(c.url.indexOf("?") + 1));
      expect(q.get("current")).toBe("1");
      expect(q.get("size")).toBe("50");
      expect(q.get("project_id")).toBe("p1");
    }
    expect(gets("/plan-reports/r1/items").some((c) => c.url.includes("cursor="))).toBe(false);
  });

  it("⑨ 点第 3 页：恰好一条 current=3（无 cursor），行是替换不是追加", async () => {
    mockBackend();
    await renderSettled();
    const before = gets("/plan-reports/r1/items").length;
    clickPage(3);
    await waitFor(() => expect(gets("/plan-reports/r1/items").length).toBe(before + 1));
    const last = gets("/plan-reports/r1/items").at(-1)!;
    const q = new URLSearchParams(last.url.slice(last.url.indexOf("?") + 1));
    expect(q.get("current")).toBe("3");
    expect(q.has("cursor")).toBe(false);
    await waitFor(() => expect(screen.getByTestId("plan-report-item-row-itZ")).not.toBeNull());
    expect(screen.queryByTestId("plan-report-item-row-it1")).toBeNull(); // append 变异这里 it1 还在
  });

  it("⑨ /items 响应缺 total 键 → 分页器整块不渲染（行照画 = 正对照）", async () => {
    mockBackend({ itemsNoTotal: true });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-item-row-it1")).not.toBeNull());
    expect(screen.queryByTestId("list-pager")).toBeNull(); // 「共 0 条」假象不许有
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("plan-report-item-row-it1")).not.toBeNull();
  });
});

describe("删除（⑦⑧：只说后端答过的事实，删后不留假状态）", () => {
  it("⑧ 确认文案含级联原话口径；DELETE body 恰好 {project_id}；成功后导航回所属计划", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-detail-delete")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-report-detail-delete"));
    const ok = await screen.findByTestId("plan-report-detail-delete-ok");
    // 只许说 plan_report_delete 答过的事实：物理删不可恢复、同事务删头+明细、级联只按 report_id。
    expect(document.body.textContent).toContain("物理删除，不可恢复");
    expect(document.body.textContent).toContain("别的报告的明细一根毫毛不动");
    fireEvent.click(ok);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE"
      && c.url.startsWith("/api/v1/plan-reports/r1"))).toBe(true));
    const d = calls.find((c) => c.method === "DELETE")!;
    expect(d.body).toEqual({ project_id: "p1" }); // 只断「发过 DELETE」= 没断 body
    // 善后=回所属计划详情；原地「已删除」假状态不许存在（探针在场即已离开本页）
    await waitFor(() => expect(screen.getByTestId("plan-probe")).not.toBeNull());
  });
});

describe("导航与页面契约（⑭⑮）", () => {
  it("⑭ 返回所属计划：点了真回 /plans/{plan_id}（plan_id 从详情头来，不硬编码）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-detail-overview")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-report-detail-back"));
    await waitFor(() => expect(screen.getByTestId("plan-probe")).not.toBeNull());
  });

  it("⑭ 概览里的所属计划短链也真导航（同一个 plan_id）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("plan-report-detail-plan-link")).not.toBeNull());
    fireEvent.click(screen.getByTestId("plan-report-detail-plan-link"));
    await waitFor(() => expect(screen.getByTestId("plan-probe")).not.toBeNull());
  });

  it("页面契约（⑮）：page-plan-report-detail + PageHead 标题「计划报告详情」（nav.spec 同源）", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("page-plan-report-detail")).not.toBeNull());
    expect(document.querySelector(".tp-page-title")?.textContent).toBe("计划报告详情");
  });
});

// D230 导出：页面只做落地——请求形状（project_id 在场）、内容逐字透传（不在前端拼/补数）、
// 文件名用后端给的（不自己命名）、明细条数照后端原话。
describe("导出报告（D230 ⑧）", () => {
  it("⑧ 点导出：GET export 端点 + Blob 内容逐字等于后端 content + 成功话术带后端文件名与条数", async () => {
    mockBackend();
    await renderSettled();
    expect(lastBlob).toBeNull(); // 正对照：没点之前不许有落地动作

    fireEvent.click(screen.getByTestId("plan-report-detail-export"));

    await waitFor(() => expect(gets("/plan-reports/r1/export")).toHaveLength(1));
    const call = gets("/plan-reports/r1/export")[0];
    expect(call.url).toContain("project_id=p1");
    await waitFor(() => expect(lastBlob).not.toBeNull());
    // 逐字透传：前端拼一个空壳或改一个字节，size 就对不上
    expect(lastBlob!.type).toBe("text/html; charset=utf-8");
    expect(lastBlob!.size).toBe(new Blob([EXPORT_HTML]).size);
    await waitFor(() => expect(document.body.textContent)
      .toContain("已导出 " + ITEMS_TOTAL + " 条明细（" + EXPORT_FILENAME + "）"));
  });

  it("⑧ 导出失败：不落地文件（没有假下载），错误走 client 原话", async () => {
    mockBackend({ exportStatus: 500 });
    await renderSettled();
    fireEvent.click(screen.getByTestId("plan-report-detail-export"));
    await waitFor(() => expect(gets("/plan-reports/r1/export")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(lastBlob).toBeNull();
    expect(document.body.textContent).toContain("导出失败：storage 不可写");
  });
});
