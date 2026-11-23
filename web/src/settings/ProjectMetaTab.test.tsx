// 项目设置 · 模板与字段（D192）组件测试。
// 钉：① 列表渲染；② 新建字段的 POST body；③ 新建模板带字段；④ 只读时写钮不在 DOM；
// ⑤ D247 两表各接三件套（选视图 → filter 参数重查；列设置只藏勾掉的那列）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import ProjectMetaTab from "./ProjectMetaTab";

const calls: { url: string; method: string; body: unknown }[] = [];

const FIELD = {
  id: "f1", project_id: "p1", scene: "bug", name: "严重程度", field_key: "severity",
  type: "select", description: null, sort: 0, internal: false,
  options: [{ value: "s1", label: "致命" }], template_count: 1,
  created_at: null, updated_at: null,
};
const TEMPLATE = {
  id: "t1", project_id: "p1", scene: "bug", name: "系统默认（缺陷）", description: null,
  internal: true, is_default: true, sort: 0, field_count: 1, created_at: null, updated_at: null,
};

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

// D247：工具栏元数据。两页都登记（supported_view_types），字段照后端白名单的真实形状给。
const FILTER_META = {
  operators: ["CONTAINS", "EQUALS"],
  labels: { CONTAINS: "包含", EQUALS: "等于" },
  kinds: { text: ["CONTAINS", "EQUALS"] },
  unavailable: {},
  supported_view_types: ["template", "custom_field"],
  view_label: "模板",
  fields: [
    { field: "name", label: "模板名称", kind: "text", ops: ["CONTAINS", "EQUALS"] },
    { field: "internal", label: "系统内置", kind: "bool", ops: ["EQUALS", "NOT_EQUALS"] },
  ],
};

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.includes("/filter-meta?")) return resp(200, FILTER_META);
    if (url.includes("/saved-views?")) return resp(200, []);
    if (url.includes("/templates?") && method === "GET") return resp(200, { items: [TEMPLATE] });
    if (url.includes("/custom-fields?") && method === "GET") return resp(200, { items: [FIELD] });
    if (url.endsWith("/custom-fields") && method === "POST") {
      return resp(201, { ...FIELD, id: "f9", ...body });
    }
    if (url.endsWith("/templates") && method === "POST") {
      return resp(201, { ...TEMPLATE, id: "t9", internal: false, is_default: false, ...body, fields: [] });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

function renderTab(canWrite = true): void {
  render(<ProjectMetaTab projectId="p1" canCreate={canWrite} canUpdate={canWrite}
    canDelete={canWrite} canSaveView={canWrite} canDeleteView={canWrite} />);
}

describe("模板与字段", () => {
  it("渲染模板/字段列表", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText("系统默认（缺陷）")).toBeTruthy());
    expect(screen.getByText("严重程度")).toBeTruthy();
    expect(screen.getByText("severity")).toBeTruthy();
  });

  it("新建字段：POST body 逐字段", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText("严重程度")).toBeTruthy());
    fireEvent.click(screen.getByTestId("pm-field-new"));
    fireEvent.change(screen.getByTestId("pm-field-name"), { target: { value: "影响版本" } });
    fireEvent.change(screen.getByTestId("pm-field-key"), { target: { value: "affected_version" } });
    fireEvent.click(screen.getByTestId("pm-field-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/custom-fields"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1", scene: "bug", name: "影响版本",
        field_key: "affected_version", type: "input", options: [],
      });
    });
  });

  it("新建模板：带勾选字段与必填", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText("严重程度")).toBeTruthy());
    fireEvent.click(screen.getByTestId("pm-template-new"));
    fireEvent.change(screen.getByTestId("pm-template-name"), { target: { value: "缺陷模板B" } });
    // 模板弹窗里的字段表：把「严重程度」行勾进模板
    const hits = screen.getAllByText("严重程度");
    const row = hits[hits.length - 1].closest("tr")!;
    const boxes = row.querySelectorAll("input[type=checkbox]");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]); // 必填
    fireEvent.click(screen.getByTestId("pm-template-save"));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && x.url.endsWith("/templates"));
      expect(c).toBeTruthy();
      expect(c!.body).toMatchObject({
        project_id: "p1", scene: "bug", name: "缺陷模板B",
        fields: [{ field_id: "f1", required: true, sort: 0 }],
      });
    });
  });

  it("只读：新建/编辑/删除都不在 DOM", async () => {
    renderTab(false);
    await waitFor(() => expect(screen.getByText("严重程度")).toBeTruthy());
    expect(screen.queryByTestId("pm-field-new")).toBeNull();
    expect(screen.queryByTestId("pm-template-new")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.queryByText("删除")).toBeNull();
  });

  // —— D247：两表各接三件套 --------------------------------------------------------
  it("选中模板视图 → 条件作为 filter 重查模板表；字段表不被牵连", async () => {
    const view = {
      id: "v1", project_id: "p1", view_type: "template", name: "只看系统模板",
      conditions: { search_mode: "AND", conditions: [
        { field: "internal", operator: "EQUALS", value: true }] },
      pos: 0, updated_at: null,
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url, method: "GET", body: undefined });
      if (url.includes("/filter-meta?")) return resp(200, FILTER_META);
      // 视图按页隔离：模板页有这条视图，字段页没有
      if (url.includes("/saved-views?")) {
        return resp(200, url.includes("view_type=template") ? [view] : []);
      }
      if (url.includes("/templates?")) return resp(200, { items: [TEMPLATE] });
      if (url.includes("/custom-fields?")) return resp(200, { items: [FIELD] });
      throw new Error("未 mock 的请求: " + url);
    }) as unknown as typeof fetch;

    renderTab();
    await waitFor(() => expect(screen.getByText("系统默认（缺陷）")).toBeTruthy());

    const sel = screen.getAllByTestId("lt-view")[0];
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText("只看系统模板"));

    await waitFor(() => {
      const last = calls.filter((c) => c.url.includes("/templates?")).at(-1)!;
      expect(last.url).toContain("filter=");
      expect(decodeURIComponent(last.url)).toContain('"field":"internal"');
    });
    // 条件不串页：字段表这一次重查不带模板页的条件
    const lastField = calls.filter((c) => c.url.includes("/custom-fields?")).at(-1)!;
    expect(lastField.url).not.toContain("filter=");
  });

  it("列设置取消「更新时间」→ 只藏这一列（key 与 cols 逐字对齐）", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText("系统默认（缺陷）")).toBeTruthy());
    const header = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(header()).toContain("更新时间");

    fireEvent.click(screen.getAllByTestId("lt-cols")[0]);
    const panel = await screen.findByTestId("lt-col-panel");
    fireEvent.click(within(panel).getByText("更新时间").closest("label")!);

    await waitFor(() => expect(header()).not.toContain("更新时间"));
    // 别的列不受牵连（收窄只作用于勾掉的那一列）
    expect(header()).toContain("字段数");
  });
});
