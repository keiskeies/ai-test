// D267 缺陷状态流转配置页：默认图展示、整份保存、恰好一个起始态、重置、错误上屏。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DefectFlowTab from "./DefectFlowTab";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

interface Call { url: string; method: string; body?: string }

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

function mockFetch(opts: { saveFails?: boolean } = {}) {
  const calls: Call[] = [];
  let current = DEFAULT_FLOW;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    const res = (status: number, data: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => data }) as unknown as Response;
    if (url.includes("/defect-statuses/reset")) {
      current = DEFAULT_FLOW;
      return res(200, DEFAULT_FLOW);
    }
    if (url.endsWith("/defect-statuses") && method === "POST") {
      if (opts.saveFails) {
        return res(422, { code: "invalid_flow", message: "必须恰好有一个起始状态（当前 0 个）" });
      }
      const body = JSON.parse(String(init?.body));
      current = {
        project_id: body.project_id, customized: true, start_key: body.statuses.find((s: { is_start: boolean }) => s.is_start).key,
        statuses: body.statuses, transitions: body.transitions,
      };
      return res(200, current);
    }
    if (url.includes("/defect-statuses")) return res(200, current);
    return res(200, { items: [] });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => cleanup());

describe("默认图与保存", () => {
  it("默认图：内置默认标签 + 五态 + 起始开关在「新建」，可流转到按边渲染", async () => {
    mockFetch();
    render(<DefectFlowTab projectId="p1" />);
    expect(await screen.findByTestId("defect-flow-default")).not.toBeNull();
    for (const name of ["新建", "处理中", "已解决", "已拒绝", "已关闭"]) {
      expect(screen.getByDisplayValue(name)).not.toBeNull();
    }
    const starts = screen.getAllByTestId(/^defect-flow-start-/);
    expect(starts).toHaveLength(5);
    expect(starts[0].getAttribute("aria-checked")).toBe("true");
    expect(starts[1].getAttribute("aria-checked")).toBe("false");
    // 多选在收窄容器里只摊开第一个已选值：钉住「有且仅有 in_process 一条出边」。
    const toSelects = screen.getAllByTestId(/^defect-flow-to-/);
    expect(toSelects[0].textContent).toContain("in_process / 处理中");
    expect(toSelects[0].textContent).not.toContain("resolved");
    expect(toSelects[0].textContent).not.toContain("closed");
  });

  it("改名保存：整份 POST，statuses/transitions 一字不差，回填后标「自定义」", async () => {
    const calls = mockFetch();
    render(<DefectFlowTab projectId="p1" />);
    await screen.findByTestId("defect-flow-default");
    fireEvent.change(screen.getByDisplayValue("新建"), { target: { value: "待办" } });
    fireEvent.click(screen.getByTestId("defect-flow-save"));
    expect(await screen.findByTestId("defect-flow-customized")).not.toBeNull();
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/defect-statuses"));
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post!.body));
    expect(body.project_id).toBe("p1");
    expect(body.statuses[0]).toEqual({ key: "new", name: "待办", is_start: true, is_end: false });
    expect(body.statuses).toHaveLength(5);
    expect(body.transitions).toEqual(DEFAULT_FLOW.transitions);
  });

  it("添加状态并设为起始：旧起始自动让位（恰好一个起始态）", async () => {
    const calls = mockFetch();
    render(<DefectFlowTab projectId="p1" />);
    await screen.findByTestId("defect-flow-default");
    fireEvent.click(screen.getByTestId("defect-flow-add"));
    const keyInputs = screen.getAllByPlaceholderText("小写 slug");
    const nameInputs = screen.getAllByPlaceholderText("状态名");
    fireEvent.change(keyInputs[keyInputs.length - 1], { target: { value: "archived" } });
    fireEvent.change(nameInputs[nameInputs.length - 1], { target: { value: "已归档" } });
    const starts = screen.getAllByTestId(/^defect-flow-start-/);
    fireEvent.click(starts[starts.length - 1]);
    fireEvent.click(screen.getByTestId("defect-flow-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.method === "POST")!.body));
    const startRows = body.statuses.filter((s: { is_start: boolean }) => s.is_start);
    expect(startRows).toEqual([{ key: "archived", name: "已归档", is_start: true, is_end: false }]);
    expect(body.statuses.find((s: { key: string }) => s.key === "new").is_start).toBe(false);
  });

  it("保存失败：后端中文 message 原样上屏，不假装成功", async () => {
    mockFetch({ saveFails: true });
    render(<DefectFlowTab projectId="p1" />);
    await screen.findByTestId("defect-flow-default");
    fireEvent.click(screen.getByTestId("defect-flow-save"));
    const alert = await screen.findByTestId("defect-flow-error");
    expect(alert.textContent).toContain("必须恰好有一个起始状态");
  });
});

describe("重置", () => {
  it("Popconfirm 确认后 POST reset，标签回「内置默认」", async () => {
    const calls = mockFetch();
    render(<DefectFlowTab projectId="p1" />);
    await screen.findByTestId("defect-flow-default");
    fireEvent.click(screen.getByTestId("defect-flow-reset"));
    fireEvent.click(await screen.findByRole("button", { name: /确\s*认\s*恢\s*复/ }));
    expect(await screen.findByTestId("defect-flow-default")).not.toBeNull();
    expect(calls.some((c) => c.url.includes("/defect-statuses/reset") && c.method === "POST")).toBe(true);
  });
});

// D271：同一组件复用为组织模板（orgId 模式 → /system/orgs/defect-flow/*）。
describe("D271 组织模板模式", () => {
  const ORG_FLOW = {
    org_id: "o1", customized: false, start_key: "new",
    statuses: [
      { key: "new", name: "新建", is_start: true, is_end: false },
      { key: "closed", name: "已关闭", is_start: false, is_end: true },
    ],
    transitions: [{ from_key: "new", to_key: "closed" }],
  };

  it("orgId 模式：读/存都走组织口，重置文案是「删除模板」", async () => {
    const calls: Call[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
      const res = (status: number, data: unknown) =>
        ({ ok: status >= 200 && status < 300, status, json: async () => data }) as unknown as Response;
      if (url.includes("/system/orgs/defect-flow/save")) {
        const body = JSON.parse(String(init?.body));
        return res(200, { ...ORG_FLOW, customized: true, statuses: body.statuses,
          transitions: body.transitions });
      }
      if (url.includes("/system/orgs/defect-flow/reset")) {
        return res(200, ORG_FLOW);
      }
      return res(200, ORG_FLOW);
    }) as unknown as typeof fetch;

    render(<DefectFlowTab orgId="o1" />);
    expect(await screen.findByTestId("defect-flow-tab")).toBeTruthy();
    expect(await screen.findByTestId("defect-flow-default")).toBeTruthy();
    expect(screen.getByText("组织缺陷状态流模板")).toBeTruthy();
    expect(screen.getByTestId("defect-flow-reset").textContent).toContain("删除模板");

    fireEvent.click(screen.getByTestId("defect-flow-save"));
    await waitFor(() => expect(calls.some(
      (c) => c.url.includes("/system/orgs/defect-flow/save") && c.method === "POST",
    )).toBe(true));
    const post = calls.find((c) => c.url.includes("/system/orgs/defect-flow/save"))!;
    const body = JSON.parse(String(post.body));
    expect(body.org_id).toBe("o1");
    expect(body.statuses).toHaveLength(2);
  });
});
