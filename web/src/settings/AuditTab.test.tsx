// 审计双栏 JSON 对照（§11.4.27）：模态渲染 before/after 两栏 + 差异键高亮，
// 以及 AuditTab 的 [diff] 钮只在带 before/after 的行上可点、区间控件把
// ts_from/ts_to（纯日期，Shanghai 日历日归界在后端）带进请求。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AuditTab from "./AuditTab";
import AuditDiffModal, { diffRows, hasComparison } from "./AuditDiffModal";
import type { AuditRow } from "../api/api";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const DIFF_ROW: AuditRow = {
  id: "a1", ts: "2026-11-16T01:00:00+00:00", user_id: "u1", user_name: "陈",
  entry: "http", action: "api_import_commit", target: "p1", ok: true,
  diff: {
    overwrite: "d1", name: "创建订单接口",
    before: { method: "POST", path: "/orders", version: 1 },
    after: { method: "POST", path: "/orders", version: 2 },
  },
};
const PLAIN_ROW: AuditRow = {
  id: "a2", ts: "2026-11-16T02:00:00+00:00", user_id: "u1", user_name: "王",
  entry: "schedule", action: "env_create", target: "p1", ok: true, diff: { produced: [] },
};

function mockAudit() {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    // 操作人下拉的数据源（与 MembersTab 加人同一条查找口）
    if (url.includes("/project-member-candidates")) {
      return { ok: true, status: 200, json: async () => ({
        items: [{ id: "u9", account: "alice", name: "Alice", is_member: true }], next_cursor: null }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [DIFF_ROW, PLAIN_ROW], next_cursor: null }) };
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => cleanup());

/** /audit 按状态码失败；操作人下拉那条口恒 200（筛选项是可选件，不该把整页变成报错）。
 *  reject=true 时 fetch 直接 reject —— 后端没起/断网是传输层失败，抛的不是 ApiErr。 */
function mockAuditFail(auditStatus: number, opts: { reject?: boolean } = {}) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/project-member-candidates")) {
      return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) };
    }
    if (opts.reject) throw new TypeError("Failed to fetch");
    return { ok: false, status: auditStatus, json: async () => ({
      code: auditStatus === 403 ? "forbidden" : "internal",
      message: "服务内部错误", details: {} }) };
  }) as unknown as typeof fetch;
}

/** /audit 恒返空页（用于「真查到了 0 条」的正向对照：无筛选 / 带筛选两态）。 */
function mockAuditEmpty() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/project-member-candidates")) {
      return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) };
  }) as unknown as typeof fetch;
}

/** 点「入口=HTTP」把任一筛选置为活跃（手法同 AU02 测：mouseDown + 未隐藏的弹层里点 option）。 */
async function pickEntryHttp() {
  const sel = screen.getByTestId("audit-filter-entry");
  fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
  await waitFor(() => expect(
    document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")).not.toBeNull());
  const dd = document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)") as HTMLElement;
  const opt = Array.from(dd.querySelectorAll(".ant-select-item-option-content"))
    .find((n) => n.textContent === "HTTP") as HTMLElement;
  fireEvent.click(opt);
}

const CENSUS = "这段时间没有写操作被记录（只读查询不进审计，这是设计如此）";
const NO_MATCH = "当前筛选条件下没有匹配的记录";
const NOT_FETCHED = "审计记录没取到，这次列表是空的——原因见上方提示";
const PERMISSION = "审计只有系统管理员能读；若你刚被改动角色，请重新登录";
const NETWORK = "可能是网络不通或后端没起，点「刷新」重试";
const bodyText = () => document.body.textContent ?? "";

describe("diffRows（双栏行构造：顶层键并集 + 差异判定）", () => {
  it("同键不同值 → changed；同值 → 不变；单侧键 → changed 且缺侧画 —", () => {
    const rows = diffRows({ a: 1, b: "x", only_b: true }, { a: 2, b: "x", only_a: null });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "only_a", "only_b"]);
    expect(rows.find((r) => r.key === "a")?.changed).toBe(true);
    expect(rows.find((r) => r.key === "b")?.changed).toBe(false);
    expect(rows.find((r) => r.key === "only_a")?.changed).toBe(true);
    expect(rows.find((r) => r.key === "only_a")?.before).toBe("—");
    expect(rows.find((r) => r.key === "only_b")?.after).toBe("—");
  });
  it("嵌套对象按键级 JSON 比较：内容不同即 changed", () => {
    const rows = diffRows({ request: { body: { a: 1 } } }, { request: { body: { a: 2 } } });
    expect(rows[0].changed).toBe(true);
  });
  it("hasComparison：只有同时带 before/after 才算有对照物", () => {
    expect(hasComparison(DIFF_ROW.diff)).toBe(true);
    expect(hasComparison(PLAIN_ROW.diff)).toBe(false);
    expect(hasComparison(null)).toBe(false);
  });
});

describe("AuditDiffModal（双栏并排 + 差异键高亮）", () => {
  it("两栏都渲染，差异键（version）高亮、相同键（method）不高亮", () => {
    render(<AuditDiffModal diff={DIFF_ROW.diff} action="api_import_commit" onClose={() => {}} />);
    expect(screen.getByTestId("audit-diff-modal")).not.toBeNull();
    const before = screen.getByTestId("audit-diff-before-version");
    const after = screen.getByTestId("audit-diff-after-version");
    expect(before.textContent).toContain("1");
    expect(after.textContent).toContain("2");
    // 高亮 = 差异行挂 changed 类 + 单元格带底色（红/绿两色，不引 diff 库）
    expect(before.getAttribute("style")).toContain("background");
    expect(after.getAttribute("style")).toContain("background");
    const same = screen.getByTestId("audit-diff-before-method");
    expect(same.getAttribute("style") ?? "").not.toContain("background");
    expect(screen.getByTestId("audit-diff-summary").textContent).toContain("1 个差异键");
  });
});

describe("AuditTab 接线（[diff] 钮 + 时间区间 + 定时入口）", () => {
  it("带 before/after 的行 [diff] 可点开模态；没有对照物的行钮置灰", async () => {
    mockAudit();
    render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-diff")).toHaveLength(2));
    const [withDiff, without] = screen.getAllByTestId("audit-diff");
    expect((without as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(withDiff);
    expect(await screen.findByTestId("audit-diff-modal")).not.toBeNull();
    expect(screen.getByTestId("audit-diff-before-version").textContent).toContain("1");
  });

  it("选日期区间 → 请求带 YYYY-MM-DD 的 ts_from/ts_to；入口选项含「定时」", async () => {
    const calls = mockAudit();
    render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toContain("/audit?");
    // 入口筛选词表含 schedule→定时（§11.4.27 筛选条「全部|Web|Pilot|定时」的定时位）
    // audit-entry 是逐行画的 Tag（AuditTab.tsx:85）：上面那条 waitFor 只等到请求发出，
    // 慢后端下行还在回包路上，getAll 会抓到空数组。门要钉在行上（同隔壁 [diff] 用例等
    // getAllByTestId("audit-diff") 有 2 条那样）。
    await waitFor(() => expect(screen.getAllByTestId("audit-entry").length).toBeGreaterThan(0));
    const opts = screen.getAllByTestId("audit-entry").map((n) => n.textContent);
    expect(opts).toContain("定时");
    // 区间控件在筛选条上（RangePicker 把 data-testid 摊在两个 input 上，所以是复数；
    // 真实选日交互交给 e2e：jsdom 里 DatePicker 弹层不可靠）
    expect(screen.getAllByTestId("audit-filter-range").length).toBeGreaterThanOrEqual(2);
  });

  it("「动作」框回车 → 立刻重查且请求带 action=：这条钉的是 useEffect 依赖里必须有 action", async () => {
    const calls = mockAudit();
    render(<AuditTab projectId="p1" />);
    // 只数 /audit 请求：操作人下拉的数据源是另一条口，别把它算成「多查了一次」
    await waitFor(() => expect(calls.filter((u) => u.includes("/audit?"))).toHaveLength(1));
    const box = screen.getByTestId("audit-filter-action");
    fireEvent.change(box, { target: { value: "env_create" } });
    fireEvent.keyDown(box, { key: "Enter", code: "Enter", keyCode: 13 });
    // Input.Search 的 onSearch 只在回车/点钮时触发（不是每敲一键查一次），
    // 所以这里一次 change+Enter 应当恰好多一次带 action 的请求。
    await waitFor(() => expect(calls.some((u) => u.includes("action=env_create"))).toBe(true));
  });

  it("「动作」框是真受控 + 点 × 连已生效筛选一起清：清空后重查不再带 action（D128）", async () => {
    const calls = mockAudit();
    render(<AuditTab projectId="p1" />);
    const audits = () => calls.filter((u) => u.includes("/audit?"));
    await waitFor(() => expect(audits()).toHaveLength(1));

    // 打字只改草稿：回车前一条新请求都不许发（「回车/点钮才查」的业主裁定）
    const box = screen.getByTestId("audit-filter-action") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "env_create" } });
    expect(audits()).toHaveLength(1);
    expect(box.value).toBe("env_create"); // 受控值：框里显示的就是草稿

    // 回车生效 → 恰好多一条带 action 的请求
    fireEvent.keyDown(box, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(audits()).toHaveLength(2));
    expect(audits().at(-1)).toContain("action=env_create");

    // 点 × → 框清空，且已生效的 action 一并撤销：重查恰多一条、不再带 action（D128）
    const clearBtn = document.querySelector(".ant-input-clear-icon") as HTMLElement;
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn);
    await waitFor(() => expect(audits()).toHaveLength(3));
    expect(audits().at(-1)).not.toContain("action=");
    expect(box.value).toBe("");
    // 表没被清成空：mock 恒返两行，重查照常渲染
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
  });

  it("操作人筛选：数据源来自项目内用户查找；选中后请求带 user_id=，清空后不再带（§11.5.1）", async () => {
    const calls = mockAudit();
    render(<AuditTab projectId="p1" />);
    // 首屏：审计列表 + 操作人下拉数据源各发一次
    await waitFor(() => expect(calls.some((u) => u.includes("/audit?"))).toBe(true));
    await waitFor(() => expect(calls.some((u) => u.includes("/project-member-candidates?"))).toBe(true));
    const cand = calls.find((u) => u.includes("/project-member-candidates?"))!;
    expect(cand).toContain("project_id=p1");

    // 展开操作人下拉，选项里是真实用户（账号 · 姓名）
    const sel = screen.getByTestId("audit-filter-user");
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    const opt = await screen.findByText("alice · Alice");
    expect(opt).not.toBeNull();

    // 选中 → 新一次 /audit 请求必须带 user_id（断言请求串，不看组件内部状态）
    const auditBefore = calls.filter((u) => u.includes("/audit?")).length;
    fireEvent.click(opt);
    await waitFor(() => expect(calls.filter((u) => u.includes("/audit?")).length).toBe(auditBefore + 1));
    expect(calls.filter((u) => u.includes("/audit?")).at(-1)).toContain("user_id=u9");

    // allowClear 清空 → 后续请求不再带 user_id（筛选可撤销，组合状态不粘滞）
    fireEvent.mouseLeave(sel);
    const clearBtn = sel.querySelector(".ant-select-clear") as HTMLElement;
    expect(clearBtn).not.toBeNull();
    fireEvent.mouseDown(clearBtn);
    await waitFor(() => {
      const last = calls.filter((u) => u.includes("/audit?")).at(-1)!;
      expect(calls.filter((u) => u.includes("/audit?")).length).toBeGreaterThan(auditBefore + 1);
      expect(last).not.toContain("user_id=");
    });
  });

  // 游标分页：cursor 是 load 的 useCallback 闭包值，漏进依赖数组的 bug 在 jsdom 里量不到
  // （effect 只重跑一次），但「点一次钮 append 恰一页且请求带上一页游标」这条腿在 jsdom 里成立。
  it("「加载更多」有下一页才出现，点一次 append 恰好一页且请求带上一页游标", async () => {
    // 按 cursor 分页的 mock：第一页 A 两行 + 游标 c1，第二页 B 单行 + 无游标。
    // 两页 id/action 全不同，append 错页、重复首屏、丢游标都会给出不同的可见值。
    const rowsA: AuditRow[] = [
      { ...DIFF_ROW, id: "pg1-a", action: "api_import_commit" },
      { ...PLAIN_ROW, id: "pg1-b", action: "env_create" },
    ];
    const rowsB: AuditRow[] = [
      { ...PLAIN_ROW, id: "pg2-a", action: "ui_case_delete", entry: "agent" },
    ];
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/project-member-candidates")) {
        return { ok: true, status: 200, json: async () => ({
          items: [{ id: "u9", account: "alice", name: "Alice", is_member: true }], next_cursor: null }) };
      }
      // 生产请求是相对路径（"/audit?..."），不能 new URL(相对串)——按参数名探测游标
      const hasCursor = url.includes("/audit?") && url.includes("cursor=");
      return { ok: true, status: 200, json: async () => (
        hasCursor ? { items: rowsB, next_cursor: null } : { items: rowsA, next_cursor: "c1" }) };
    }) as unknown as typeof fetch;

    render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
    // 「加载更多」只在响应带 next_cursor 时存在（cursor && 分支）
    const more = await screen.findByTestId("audit-more");
    const auditBefore = calls.filter((u) => u.includes("/audit?")).length;

    fireEvent.click(more);
    // append 语义：2 → 3，新行是第二页的；若 production 是 setItems(r.items)（整体替换）
    // 这里会停在 2，若 reset 判断反了同样是 2。
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(3));
    const actions = screen.getAllByTestId("audit-action").map((n) => n.textContent);
    expect(actions).toEqual(["api_import_commit", "env_create", "ui_case_delete"]);
    // load(false) 必须把上一页留下的游标带上（缺了它后端永远重发第一页）
    expect(calls.filter((u) => u.includes("/audit?")).length).toBe(auditBefore + 1);
    expect(calls.filter((u) => u.includes("/audit?")).at(-1)).toContain("cursor=c1");
    // 第二页 next_cursor=null → 钮自己消失（若 next_cursor 没被响应更新，它还留着且会再查一次）
    expect(screen.queryByTestId("audit-more")).toBeNull();
  });

  it("换筛选 = 整表替换：新页行集独立成表，上一页的行必须从 DOM 消失（AU02）", async () => {
    // 杀 AU02：47 行 setItems(prev => next===null ? r.items : [...prev, ...r.items]) 里
    // 的三元被改成无条件 [...prev, ...r.items] 时，「加载更多」与「按钮消失」两测照绿
    // ——只有「带筛选重查必须替换」这条能看见：条件 query 下旧页行若残留，行数为 3 不为 1。
    const rowsA: AuditRow[] = [
      { ...DIFF_ROW, id: "pa-1", action: "alpha_only_page_a" },
      { ...PLAIN_ROW, id: "pa-2", action: "beta_only_page_a" },
    ];
    const rowsB: AuditRow[] = [
      { ...PLAIN_ROW, id: "pb-1", action: "gamma_only_page_b", entry: "agent" },
    ];
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/project-member-candidates")) {
        return { ok: true, status: 200, json: async () => ({
          items: [{ id: "u9", account: "alice", name: "Alice", is_member: true }], next_cursor: null }) };
      }
      // 按查询参数分流：无 entry= 给页 A 两行，带 entry=http 给页 B 单行（两页 id/action 全不同）
      const filtered = url.includes("/audit?") && url.includes("entry=http");
      return { ok: true, status: 200, json: async () => (
        filtered ? { items: rowsB, next_cursor: null } : { items: rowsA, next_cursor: null }) };
    }) as unknown as typeof fetch;

    render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
    expect(document.querySelector('[data-audit-id="pa-1"]')).not.toBeNull();

    // 点「入口=HTTP」→ useEffect 依赖 entry 变化 → load(true)（next=null）→ 必须走替换分支
    const sel = screen.getByTestId("audit-filter-entry");
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    await waitFor(() => expect(
      document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")).not.toBeNull());
    const dd = document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)") as HTMLElement;
    const opt = Array.from(dd.querySelectorAll(".ant-select-item-option-content"))
      .find((n) => n.textContent === "HTTP") as HTMLElement;
    fireEvent.click(opt);
    await waitFor(() => expect(calls.some((u) => u.includes("entry=http"))).toBe(true));
    // 替换语义：表里恰好只剩页 B 那 1 行；页 A 的两行（尤其 pa-1）必须从 DOM 消失。
    // 无条件 append 的变异体这里是 3 行且 pa-1 还在 → 两条断言先后红。
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(1));
    expect(document.querySelector('[data-audit-id="pa-1"]')).toBeNull();
    expect(document.querySelector('[data-audit-id="pa-2"]')).toBeNull();
    expect(screen.getAllByTestId("audit-action").map((n) => n.textContent))
      .toEqual(["gamma_only_page_b"]);
  });

  it("next_cursor=null（单页/空列表）→ 「加载更多」不渲染：空 mock 上永远量不出这条", async () => {
    // mockAudit 恒返 next_cursor:null —— 与上一测的 c1 相反方向，两个 fixture 一起
    // 才把 cursor && 分支钉住：删分支 → 这里多出一个钮；反成 !cursor → 首屏就出现钮、点它翻车。
    mockAudit();
    render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
    expect(screen.queryByTestId("audit-more")).toBeNull();
  });

  it("筛选条承载全部五个筛选控件，且整棵筛选子树都在它内部", () => {
    // mock 只影响请求，不进断言；本测钉的是 audit-filters 这层容器的**包含关系**与词表，
    // 把 <Space> 拆掉/摘 testid 即红。
    mockAudit();
    render(<AuditTab projectId="p1" />);
    const filters = screen.getByTestId("audit-filters");
    for (const id of ["audit-filter-range", "audit-filter-user", "audit-filter-entry",
      "audit-filter-ok", "audit-filter-action"]) {
      // 用生产容器 node.contains(...) 而不是 CSS 后代选择器：容器一拆，contains 即 false
      for (const child of screen.getAllByTestId(id)) {
        expect(filters.contains(child)).toBe(true);
      }
    }
    // 词表：结果 = 成功/失败（ok=true/false 映射），入口 = HTTP/Pilot/定时（ENTRIES 词表）
    fireEvent.mouseDown(screen.getByTestId("audit-filter-ok")
      .querySelector(".ant-select-selector")!);
    expect(screen.queryByText("成功")).not.toBeNull();
    expect(screen.queryByText("失败")).not.toBeNull();
    fireEvent.mouseDown(screen.getByTestId("audit-filter-entry")
      .querySelector(".ant-select-selector")!);
    for (const w of ["HTTP", "Pilot", "定时"]) expect(screen.queryByText(w)).not.toBeNull();
  });

  it("[细节] 卡体 = 被点那一行的 diff JSON；[收起] 关整张卡", async () => {
    mockAudit();
    render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
    // 未开卡：body/close/card 都不在 DOM（openRow && 分支）
    expect(screen.queryByTestId("audit-detail-body")).toBeNull();
    expect(screen.queryByTestId("audit-detail-close")).toBeNull();

    // 点第二行（PLAIN_ROW，diff={produced:[]}）的 [细节]
    const detailBtns = screen.getAllByTestId("audit-detail");
    expect(detailBtns).toHaveLength(2);
    fireEvent.click(detailBtns[1]);
    const body = await screen.findByTestId("audit-detail-body");
    // 卡体是 openRow.diff 的 JSON.stringify(_,null,2)——内容按行区分：
    // 若生产把 openRow.diff 换成 items[0].diff（写死首行），这里会拿到 version 而不是 produced。
    expect(body.textContent).toContain("produced");
    expect(body.textContent).not.toContain("version");
    const card = screen.getByTestId("audit-detail-card");
    expect(card.textContent).toContain("细节 · env_create");
    // 收起钮就在卡上，且点它 → 整卡（含 body）卸载；处理器挪走 → click 无效果即红
    const close = screen.getByTestId("audit-detail-close");
    expect(card.contains(close)).toBe(true);
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId("audit-detail-card")).toBeNull());
    expect(screen.queryByTestId("audit-detail-body")).toBeNull();
  });

  it("卡体永远跟着最后一次 [细节] 的行走，收起后换行再开即换内容", async () => {
    mockAudit();
    const { unmount } = render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("audit-detail")[0]);
    const body = await screen.findByTestId("audit-detail-body");
    expect(body.textContent).toContain("version");
    expect(body.textContent).not.toContain("produced");
    expect(screen.getByTestId("audit-detail-card").textContent).toContain("细节 · api_import_commit");
    fireEvent.click(screen.getByTestId("audit-detail-close"));
    await waitFor(() => expect(screen.queryByTestId("audit-detail-card")).toBeNull());
    // openRow 若没被收起清干净，下一行开卡会残留上一张 → toContain 两向互斥，残留即红
    fireEvent.click(screen.getAllByTestId("audit-detail")[1]);
    await waitFor(() => expect(screen.getAllByTestId("audit-detail-body")).toHaveLength(1));
    const again = screen.getByTestId("audit-detail-body");
    expect(again.textContent).toContain("produced");
    expect(again.textContent).not.toContain("version");
    unmount();

    // 同一次 mount 里点第一行 → 第二行（不收起直接换）：卡体必须跟着换
    render(<AuditTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("audit-detail")[0]);
    await screen.findByTestId("audit-detail-body");
    fireEvent.click(screen.getAllByTestId("audit-detail")[1]);
    await waitFor(() => expect(screen.getByTestId("audit-detail-body").textContent).toContain("produced"));
    // 卡头标题也跟着换行（"细节 · " + openRow.action）
    expect(screen.getByTestId("audit-detail-card").textContent).toContain("细节 · env_create");
  });
});

describe("审计空态与报错分句的诚实性（文案不许比代码多说一句）", () => {
  it("取失败（500）→ 空态说「没取到」并指向上方提示；「没有写操作被记录」的普查句必须消失", async () => {
    // 旧文案的谎：fetch 失败也渲染「这段时间没有写操作被记录」——「没取到」≠「查到了 0 条」。
    // 正向断言 + not.toContain 双向钉：只查新句的话，两句同时渲染的变异体照样绿。
    mockAuditFail(500);
    render(<AuditTab projectId="p1" />);
    await screen.findByText("审计日志没取到");
    expect(bodyText()).toContain(NOT_FETCHED);
    expect(bodyText()).not.toContain("这段时间没有写操作被记录");
  });

  it("真取到 0 条且无筛选 → 设计说明句仍在（正向对照：不是把无条件句换了个词）", async () => {
    mockAuditEmpty();
    render(<AuditTab projectId="p1" />);
    await screen.findByText(CENSUS);
    expect(bodyText()).not.toContain(NOT_FETCHED);
    expect(bodyText()).not.toContain(NO_MATCH);
  });

  it("带筛选取到 0 条 → 只说「当前筛选条件下没有匹配的记录」，全局普查句收回", async () => {
    mockAuditEmpty();
    render(<AuditTab projectId="p1" />);
    // 首屏无筛选：普查句是对的，必须在
    await screen.findByText(CENSUS);
    await pickEntryHttp();
    await screen.findByText(NO_MATCH);
    expect(bodyText()).not.toContain("这段时间没有写操作被记录");
    expect(bodyText()).not.toContain(NOT_FETCHED);
  });

  it("403 → 权限/重新登录句，且不许出现网络句（错误类要说对）", async () => {
    mockAuditFail(403);
    render(<AuditTab projectId="p1" />);
    await screen.findByText("审计日志没取到");
    expect(bodyText()).toContain(PERMISSION);
    expect(bodyText()).not.toContain("可能是网络不通");
  });

  it("500 → 网络句，且不许出现「重新登录」（本 Tab 挂载前读权限已核过，重登是死路）", async () => {
    mockAuditFail(500);
    render(<AuditTab projectId="p1" />);
    await screen.findByText("审计日志没取到");
    expect(bodyText()).toContain(NETWORK);
    expect(bodyText()).not.toContain("重新登录");
  });

  it("传输层失败（fetch reject，抛的不是 ApiErr）→ 按网络句处理，不喊权限", async () => {
    mockAuditFail(0, { reject: true });
    render(<AuditTab projectId="p1" />);
    await screen.findByText("审计日志没取到");
    expect(bodyText()).toContain(NETWORK);
    expect(bodyText()).not.toContain("重新登录");
  });
});

describe("操作人下拉：名单没取到不许说成「没有匹配的用户」（第三十三轮）", () => {
  const OPS_FAIL = "操作人名单没取到（不是项目里没人）";
  const OPS_DENIED = "这个项目里没有成员名单读取权限";
  const OPS_EMPTY = "没有匹配的用户";

  /** 「操作人」那条口按模式作答，/audit 恒 200 两行——本页只该在筛选源上失声，整页照旧可用。 */
  function mockOps(mode: "fail500" | "fail403" | "ok_empty" | "fail_then_ok" | "fail_then_empty" | "never") {
    const calls: string[] = [];
    let candN = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/project-member-candidates")) {
        candN += 1;
        // 永不 resolve：让「还在途」这一格可观测，否则「搜索中…」那条腿谁都不杀
        if (mode === "never") return new Promise<never>(() => { /* 挂在途 */ });
        if (mode === "fail403") {
          return { ok: false, status: 403, json: async () => ({ code: "forbidden", message: "没有权限", details: {} }) };
        }
        if (mode === "fail500"
          || ((mode === "fail_then_ok" || mode === "fail_then_empty") && candN === 1)) {
          return { ok: false, status: 500, json: async () => ({ code: "internal", message: "服务内部错误", details: {} }) };
        }
        if (mode === "ok_empty" || (mode === "fail_then_empty" && candN > 1)) {
          return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) };
        }
        return { ok: true, status: 200, json: async () => ({
          items: [{ id: "u9", account: "alice", name: "Alice", is_member: true }], next_cursor: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [DIFF_ROW, PLAIN_ROW], next_cursor: null }) };
    }) as unknown as typeof fetch;
    return calls;
  }

  /** 展开「操作人」下拉并回读弹层文字：notFoundContent 只存在于弹层，不在控件上。 */
  async function opsDropdownText() {
    const sel = screen.getByTestId("audit-filter-user");
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    await waitFor(() => expect(
      document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")).not.toBeNull());
    return (document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)") as HTMLElement).textContent ?? "";
  }

  /** 在 showSearch 的输入框里打字 → antd 发 onSearch → 再打一条候选请求（重试用）。 */
  async function typeOps(q: string) {
    fireEvent.change(screen.getByTestId("audit-filter-user").querySelector("input")!, { target: { value: q } });
  }

  it("候选口 500 → 弹层说「没取到」并明写不是没人，且整页不许因此变成报错", async () => {
    mockOps("fail500");
    render(<AuditTab projectId="p1" />);
    await screen.findAllByTestId("audit-action");
    expect(bodyText()).not.toContain("审计日志没取到");
    const dd = await opsDropdownText();
    expect(dd).toContain(OPS_FAIL);
    expect(dd).not.toContain(OPS_EMPTY);
  });

  it("候选口 403 → 说项目级没权限，不许喊「重新输入可重试」（重输拿不到本来就没有的权限）", async () => {
    mockOps("fail403");
    render(<AuditTab projectId="p1" />);
    await screen.findAllByTestId("audit-action");
    const dd = await opsDropdownText();
    expect(dd).toContain(OPS_DENIED);
    expect(dd).not.toContain("重新输入");
    expect(dd).not.toContain(OPS_EMPTY);
  });

  // 正对照：真查到 0 条才配说「没有匹配的用户」。缺它时「一律说没取到」也全绿，等于没测。
  it("正对照：候选口 200 且 items 为空 → 仍说「没有匹配的用户」，不许蹭「没取到」", async () => {
    mockOps("ok_empty");
    render(<AuditTab projectId="p1" />);
    await screen.findAllByTestId("audit-action");
    const dd = await opsDropdownText();
    expect(dd).toContain(OPS_EMPTY);
    expect(dd).not.toContain(OPS_FAIL);
    expect(dd).not.toContain(OPS_DENIED);
  });

  it("失败后重新输入即恢复：旗标不许粘滞（否则一次抖动把下拉永久判死）", async () => {
    mockOps("fail_then_ok");
    render(<AuditTab projectId="p1" />);
    await screen.findAllByTestId("audit-action");
    expect(await opsDropdownText()).toContain(OPS_FAIL);
    typeOps("ali");
    await waitFor(() => expect(screen.queryByText("alice · Alice")).not.toBeNull());
    expect(bodyText()).not.toContain(OPS_FAIL);
  });

  // 上一轮的变异体（入口不清零旗标）能活过上面那条：成功后弹层根本不放 notFoundContent，
  // 粘滞旗标没处显形。这条让「第二次查询真的查到 0 条」，notFoundContent 才重新上场说话。
  it("失败后重新输入且真查到 0 条 → 说「没有匹配的用户」，不许被上一次失败粘住", async () => {
    mockOps("fail_then_empty");
    render(<AuditTab projectId="p1" />);
    await screen.findAllByTestId("audit-action");
    expect(await opsDropdownText()).toContain(OPS_FAIL);
    typeOps("zzz");
    await waitFor(() => expect(bodyText()).toContain(OPS_EMPTY));
    expect(bodyText()).not.toContain(OPS_FAIL);
  });

  it("请求在途时展开 → 说「搜索中…」，不许先替这次查询下结论", async () => {
    mockOps("never");
    render(<AuditTab projectId="p1" />);
    const dd = await opsDropdownText();
    expect(dd).toContain("搜索中…");
    expect(dd).not.toContain(OPS_EMPTY);
    expect(dd).not.toContain(OPS_FAIL);
  });
});
