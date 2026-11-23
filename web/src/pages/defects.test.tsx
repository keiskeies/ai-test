// 缺陷管理页（D191）组件测试。fetch 全 mock（plans.test.tsx 同法）。
// 钉的几条：
// ① 权限位缺位时写钮**不在 DOM**（不是禁用）——READONLY 看不到新建/删除；
// ② 列表请求的字段名与后端 defect_list 对齐（recycled 切换真下推）；
// ③ 新建 POST body 逐字段（title/priority/handle_user_id/tags）；
// ④ 删除是 POST + body（后端口径：写操作不用 GET）；
// ⑤ 回收站视图画删除人/删除时间两列，正常视图不画（画了就是说谎）；
// ⑥ 详情页保存 PATCH 带上 description_set/handle_user_set 两个声明位；
// ⑦ 评论提交走 POST comments，回复带 parent_id。
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
// antd 的 Modal.confirm 用 getComputedStyle；jsdom 已有，但 ScrollTo 没有
window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;

import DefectsPage from "./defects";
import DefectDetailPage from "./defectDetail";
import { useAuth } from "../auth/store";
import type { DefectComment, DefectRow } from "../api/defect";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

function row(id: string, over: Partial<DefectRow> = {}): DefectRow {
  return {
    id, num: id === "d1" ? 100001 : 100002, project_id: "p1", template_id: "tpl1",
    title: "缺陷" + id, description: null, status: "new", priority: "P2",
    handle_user_id: null, handle_user_name: null, tags: [], custom_fields: {}, recycled: false,
    created_by: "u1", created_by_name: "张三", updated_by: "u1", updated_by_name: "张三",
    created_at: "2026-11-22T10:30:00+08:00", updated_at: "2026-11-22T10:30:00+08:00",
    delete_user: null, delete_user_name: null, delete_time: null,
    link_count: 0, comment_count: 0, follower_count: 0, followed: false, ...over,
  };
}

const ROWS = [row("d1", { title: "登录失败", status: "in_process", priority: "P0", tags: ["回归"] }),
              row("d2", { title: "支付超时", comment_count: 2, link_count: 1 })];

// D216：缺陷页工具栏要的 /filter-meta（形状与后端 filter_registry 一致）。这里只留
// 本文件断言用到的两个字段：条件是「页面照 meta 渲染」，不是「前端自列字段」，
// 因此 mock 少给字段不影响被测契约；supported_view_types 必须含 defect。
const DEFECT_META = {
  view_type: "defect",
  fields: [
    { field: "title", label: "标题", kind: "text",
      ops: ["CONTAINS", "EMPTY", "EQUALS", "NOT_CONTAINS", "NOT_EQUALS", "NOT_EMPTY"] },
    { field: "status", label: "状态", kind: "enum",
      ops: ["EMPTY", "EQUALS", "IN", "NOT_EQUALS", "NOT_EMPTY", "NOT_IN"] },
  ],
  supported_view_types: ["defect"],
  view_label: "缺陷管理",
  operators: [], labels: {}, kinds: {}, unavailable: {},
};

const calls: { url: string; method: string; body: unknown }[] = [];

function resp(status: number, json: unknown): Response {
  return {
    ok: status < 400, status,
    json: async () => JSON.parse(JSON.stringify(json)) as unknown,
  } as unknown as Response;
}

// D267：缺陷页会拉项目状态图；默认给内置五态（与常量同字），个别用例可覆盖成自定义图。
const DEFAULT_FLOW = {
  project_id: "p1", customized: false, start_key: "new",
  statuses: [
    { key: "new", name: "新建", is_start: true, is_end: false },
    { key: "in_process", name: "处理中", is_start: false, is_end: false },
    { key: "resolved", name: "已解决", is_start: false, is_end: true },
    { key: "rejected", name: "已拒绝", is_start: false, is_end: true },
    { key: "closed", name: "已关闭", is_start: false, is_end: true },
  ],
  transitions: [
    { from_key: "new", to_key: "in_process" },
    { from_key: "in_process", to_key: "resolved" },
    { from_key: "in_process", to_key: "rejected" },
    { from_key: "resolved", to_key: "closed" },
  ],
};

function mockBackend(rows: DefectRow[] = ROWS, flow: Record<string, unknown> = DEFAULT_FLOW) {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.includes("/defect-statuses")) return resp(200, flow);
    if (url.includes("/filter-meta")) return resp(200, DEFECT_META);
    if (url.includes("/saved-views")) return resp(200, []);
    if (url.includes("/projects/p1/members")) {
      return resp(200, { items: [{ user_id: "u2", account: "li", name: "李四" }] });
    }
    if (url.includes("/templates?") && method === "GET") {
      return resp(200, { items: [{ id: "tpl1", project_id: "p1", scene: "bug",
        name: "系统默认（缺陷）", description: null, internal: true, is_default: true,
        sort: 0, field_count: 0, created_at: null, updated_at: null }] });
    }
    if (/\/templates\/tpl1(\?|$)/.test(url) && method === "GET") {
      return resp(200, { id: "tpl1", project_id: "p1", scene: "bug", name: "系统默认（缺陷）",
        description: null, internal: true, is_default: true, sort: 0, field_count: 0,
        created_at: null, updated_at: null, fields: [] });
    }
    if (url.includes("/defect-link-candidates")) {
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const type = q.get("case_type");
      const items = type === "functional_case"
        ? [{ id: "fc1", name: "登录成功", status: "normal" }]
        : [{ id: "s1", name: "结算场景", status: "normal" }];
      return resp(200, { items, total: items.length });
    }
    if (url.includes("/defect-links") && method === "POST") {
      const ids = ((body ?? {}) as { case_ids?: string[] }).case_ids ?? [];
      return resp(201, { created: ids.length, skipped: 0 });
    }
    // 详情/评论/关联要先于列表判断
    if (/\/defects\/d1\/comments(\?|$)/.test(url) && method === "GET") {
      const c: DefectComment = { id: "c1", defect_id: "d1", parent_id: null, content: "复现了",
        reply_user_id: null, reply_user_name: null, created_by: "u2", created_by_name: "李四",
        created_at: "2026-11-22T11:00:00+08:00", updated_at: null, children: [] };
      return resp(200, { items: [c], total: 1 });
    }
    if (/\/defects\/d1\/case-links(\?|$)/.test(url) && method === "GET") {
      return resp(200, { items: [{ id: "l1", defect_id: "d1", case_type: "scenario", case_id: "s1",
        case_name: "结算场景", case_exists: true, created_by: "u1", created_at: null }], total: 1 });
    }
    if (/\/defects\/d1\/comments(\?|$)/.test(url) && method === "POST") {
      return resp(201, { id: "c9", defect_id: "d1", parent_id: body.parent_id, content: body.content,
        reply_user_id: null, reply_user_name: null, created_by: "u1", created_by_name: "张三",
        created_at: null, updated_at: null, children: [] });
    }
    if (/\/defects\/d1\/follow(\?|$)/.test(url) && method === "POST") {
      return resp(200, { following: true, follower_count: 1 });
    }
    if (/\/defects\/d1(\?|$)/.test(url) && method === "GET") {
      return resp(200, rows[0]);
    }
    if (/\/defects\/d1(\?|$)/.test(url) && method === "PATCH") {
      return resp(200, { ...rows[0], ...body });
    }
    if (/\/defects\/d1\/delete(\?|$)/.test(url) && method === "POST") return resp(200, { ok: true, affected: 1 });
    if (/\/defects\/d1\/restore(\?|$)/.test(url) && method === "POST") return resp(200, { ...rows[0], recycled: false });
    if (/\/defects\?/.test(url) && method === "GET") {
      const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const recycled = q.get("recycled") === "true";
      const items = recycled
        ? rows.map((r) => ({ ...r, recycled: true, delete_user: "u1", delete_user_name: "张三",
            delete_time: "2026-11-22T12:00:00+08:00" }))
        : rows;
      return resp(200, { items, next_cursor: null, total: items.length });
    }
    if (url.endsWith("/defects") && method === "POST") {
      return resp(201, { ...row("d9"), ...body });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

afterEach(cleanup);
beforeEach(() => {
  cleanup();
  localStorage.clear();
  mockBackend();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

function listReqs(): typeof calls {
  return calls.filter((c) => c.method === "GET" && /\/defects\?/.test(c.url));
}

function renderList(): void {
  render(<MemoryRouter><DefectsPage /></MemoryRouter>);
}

describe("缺陷列表", () => {
  it("渲染行、状态中文与总条数；写钮按权限出现", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录失败")).toBeTruthy());
    expect(screen.getByText("支付超时")).toBeTruthy();
    expect(screen.getByText("处理中")).toBeTruthy();
    expect(screen.getByTestId("list-pager").textContent).toContain("共 2 条");
    expect(screen.getByTestId("defect-new")).toBeTruthy();
    expect(screen.getAllByTestId("defect-del").length).toBe(2);
    expect(listReqs()).toHaveLength(1);
    expect(listReqs()[0].url).not.toContain("recycled=true");
  });

  it("D267：状态列按项目状态图渲染自定义名（不是内置词表），且请求带 project_id", async () => {
    mockBackend(ROWS, {
      ...DEFAULT_FLOW,
      customized: true,
      statuses: DEFAULT_FLOW.statuses.map((s) => (s.key === "in_process" ? { ...s, name: "正在处理" } : s)),
    });
    renderList();
    await waitFor(() => expect(screen.getByText("正在处理")).toBeTruthy());
    expect(screen.queryByText("处理中")).toBeNull();
    const flowReq = calls.find((c) => c.method === "GET" && c.url.includes("/defect-statuses"));
    expect(flowReq?.url).toContain("project_id=p1");
  });

  it("READONLY：新建/删除/编辑都不在 DOM", async () => {
    useAuth.setState({ project: READONLY });
    renderList();
    await waitFor(() => expect(screen.getByText("登录失败")).toBeTruthy());
    expect(screen.queryByTestId("defect-new")).toBeNull();
    expect(screen.queryByTestId("defect-del")).toBeNull();
    expect(screen.queryByTestId("defect-edit")).toBeNull();
  });

  it("切回收站：请求下推 recycled=true，并画删除人/删除时间", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录失败")).toBeTruthy());
    fireEvent.click(screen.getByTestId("defect-recycled"));
    await waitFor(() => expect(listReqs().some((c) => c.url.includes("recycled=true"))).toBe(true));
    await waitFor(() => expect(screen.getByText("删除人")).toBeTruthy());
    expect(screen.getByText("删除时间")).toBeTruthy();
    expect(screen.queryByTestId("defect-del")).toBeNull();
    expect(screen.getAllByTestId("defect-restore").length).toBe(2);
  });

  it("新建：POST body 逐字段", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录失败")).toBeTruthy());
    fireEvent.click(screen.getByTestId("defect-new"));
    // 模板/字段是弹窗打开后异步拉的；等列表 + 详情两次请求都回来再保存
    await waitFor(() => expect(calls.some((c) => c.url.includes("/templates?"))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/templates/tpl1"))).toBe(true));
    fireEvent.change(screen.getByTestId("defect-field-title"), { target: { value: "新缺陷" } });
    fireEvent.click(screen.getByTestId("defect-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/defects"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ project_id: "p1", title: "新缺陷", priority: "P2", tags: [] });
    });
  });

  it("删除：POST + body（不是 GET）", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录失败")).toBeTruthy());
    fireEvent.click(screen.getAllByTestId("defect-del")[0]);
    const ok = await screen.findByRole("button", { name: "放入回收站" });
    fireEvent.click(ok);
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/defects\/d1\/delete$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", defect_id: "d1" });
    });
  });

  it("D216 空条件不拼 filter；应用「标题包含 登录」后下一次列表请求带条件 JSON", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录失败")).toBeTruthy());
    expect(listReqs()[0].url).not.toContain("filter="); // 空条件整个参数不上线（不是 filter=）
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listReqs().length).toBe(2));
    // 字段名来自后端 meta 的第一项（title），前端不自列字段
    const raw = new URL(listReqs()[1].url, "http://x").searchParams.get("filter");
    expect(JSON.parse(raw!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "title", operator: "CONTAINS", value: "登录" }],
    });
  });

  it("D216 列设置勾掉「标签」只藏那一列（其余表头原样）", async () => {
    renderList();
    await waitFor(() => expect(screen.getByText("登录失败")).toBeTruthy());
    const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("标签");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["ID", "标题", "状态", "优先级", "标签", "自定义字段",
      "处理人", "关联用例", "评论", "关注", "更新人", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("标签")]);
    await waitFor(() => expect(thead()).not.toContain("标签"));
    expect(thead()).toContain("优先级");
  });
});

describe("缺陷详情", () => {
  beforeEach(() => {
    mockBackend([row("d1", { title: "登录失败", status: "in_process", tags: ["回归"] })]);
  });

  function renderDetail(): void {
    render(
      <MemoryRouter initialEntries={["/defects/d1"]}>
        <Routes><Route path="/defects/:id" element={<DefectDetailPage />} /></Routes>
      </MemoryRouter>,
    );
  }

  it("渲染评论与关联用例；保存 PATCH 带声明位；关注走 POST", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId("defect-detail-title").textContent).toBe("登录失败"));
    expect(screen.getByText("复现了")).toBeTruthy();
    expect(screen.getByText("结算场景")).toBeTruthy();

    fireEvent.click(screen.getByTestId("defect-detail-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "PATCH" && /\/defects\/d1(\?|$)/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1", title: "登录失败", description_set: true,
        handle_user_set: true, status: "in_process", tags: ["回归"],
      });
    });

    fireEvent.click(screen.getByTestId("defect-detail-follow"));
    await waitFor(() => {
      expect(calls.some((x) => x.method === "POST" && /\/defects\/d1\/follow(\?|$)/.test(x.url))).toBe(true);
    });
  });

  it("关联弹层支持「功能用例」（D207）：选中后候选请求带 case_type=functional_case", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId("defect-link-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("defect-link-add"));
    const trigger = screen.getByTestId("defect-link-type")
      .querySelector(".ant-select-selector") as HTMLElement;
    fireEvent.mouseDown(trigger);
    const opt = await screen.findByText("功能用例", {
      selector: ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content",
    });
    fireEvent.click(opt);
    await waitFor(() => {
      expect(calls.some((x) => x.method === "GET"
        && x.url.includes("/defect-link-candidates")
        && x.url.includes("case_type=functional_case"))).toBe(true);
    });
  });

  it("评论提交：POST comments；回复带 parent_id", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByTestId("defect-comment-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("defect-comment-input"), { target: { value: "我也遇到了" } });
    fireEvent.click(screen.getByTestId("defect-comment-submit"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/defects\/d1\/comments(\?|$)/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({ project_id: "p1", content: "我也遇到了", parent_id: null });
    });
  });
});
