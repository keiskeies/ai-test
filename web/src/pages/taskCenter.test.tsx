// 任务中心（D196）：概览/列表/停止/重跑/只读门。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;

import TaskCenterPage from "./taskCenter";
import { useAuth } from "../auth/store";
import type { TaskRow } from "../api/taskcenter";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
const READONLY = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

function row(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id, project_id: "p1", subject_type: "scenario", subject_id: "s1",
    subject_name: "场景" + id, env_name: "默认", trigger: "manual", status: "queued",
    elapsed_ms: null, error: null, created_by: "u1", created_by_name: "张三",
    created_at: "2026-11-23T10:00:00+08:00", started_at: null, finished_at: null,
    cancel_requested: false, queue_position: 1, can_stop: true, can_rerun: false, ...over,
  };
}

const calls: { url: string; method: string; body: unknown }[] = [];

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ url, method, body });
    if (url.includes("/task-center/summary")) {
      return resp(200, { total: 2, queued: 1, running: 0, passed: 1, failed: 0,
        error: 0, cancelled: 0, active: 1, pass_rate: 100, avg_elapsed_ms: 1200 });
    }
    // D239：高级搜索三件套的依赖（元数据 / 个人视图 / 触发人候选）
    if (url.includes("/filter-meta?")) {
      return resp(200, {
        view_type: "task_center", view_label: "任务中心",
        supported_view_types: ["task_center"],
        fields: [
          { field: "subject_name", label: "任务名称", kind: "text",
            ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS"] },
          { field: "status", label: "状态", kind: "enum",
            ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
          { field: "subject_type", label: "任务类型", kind: "enum",
            ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
          { field: "trigger", label: "触发方式", kind: "enum",
            ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
          { field: "elapsed_ms", label: "耗时（ms）", kind: "number",
            ops: ["EQUALS", "GT", "LT", "BETWEEN", "EMPTY", "NOT_EMPTY"] },
          { field: "created_by", label: "触发人", kind: "id", ops: ["EQUALS", "IN"] },
          { field: "created_at", label: "创建时间", kind: "time",
            ops: ["BETWEEN", "GT", "LT"] },
        ],
        unavailable: {},
      });
    }
    if (url.includes("/saved-views?")) {
      return resp(200, []);
    }
    if (/\/projects\/p1\/members/.test(url)) {
      return resp(200, { items: [{ user_id: "u1", account: "zhangsan", name: "张三" }] });
    }
    if (url.includes("/task-center/queue")) {
      return resp(200, { available: true, queue_length: 1, items: [row("r1")] });
    }
    if (/\/task-center\/tasks\?/.test(url) && method === "GET") {
      return resp(200, { items: [row("r1"), row("r2", { status: "passed", can_stop: false,
        can_rerun: true, queue_position: null, elapsed_ms: 500 })], next_cursor: null, total: 2 });
    }
    if (/\/task-center\/tasks\/batch-stop$/.test(url) && method === "POST") {
      // D237：回执分账三桶；这里只回一条停掉，前端按 stopped/skipped/failed 拼文案。
      return resp(200, { ok: true, stopped: 1, skipped: 0, stopped_ids: ["r1"],
        skipped_ids: [], failed: [] });
    }
    if (/\/task-center\/tasks\/r1\/stop$/.test(url) && method === "POST") {
      return resp(200, { ok: true, status: "queued" });
    }
    if (/\/task-center\/tasks\/r2\/rerun$/.test(url) && method === "POST") {
      return resp(200, { run_id: "r9", status: "queued" });
    }
    if (/\/task-center\/tasks\/r1\?/.test(url) && method === "GET") {
      return resp(200, { ...row("r1"), stats: { total: 2 }, step_counts: { pass: 1 } });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});
afterEach(cleanup);

function renderPage(): void {
  render(<MemoryRouter><TaskCenterPage /></MemoryRouter>);
}

describe("任务中心", () => {
  it("渲染概览与任务行", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("场景r1")).toBeTruthy());
    expect(screen.getByTestId("task-summary").textContent).toContain("100");
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByTestId("task-stop")).toBeTruthy();
    expect(screen.getByTestId("task-rerun")).toBeTruthy();
  });

  it("停止：POST 后重拉", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("task-stop")).toBeTruthy());
    fireEvent.click(screen.getByTestId("task-stop"));
    await waitFor(() => expect(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary")).toBeTruthy());
    fireEvent.click(document.querySelector(".ant-modal-confirm-btns .ant-btn-primary") as HTMLElement);
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/task-center\/tasks\/r1\/stop$/.test(x.url));
      expect(c).toBeTruthy();
    });
  });

  it("READONLY：停止/重跑都不在 DOM", async () => {
    useAuth.setState({ project: READONLY });
    renderPage();
    await waitFor(() => expect(screen.getByText("场景r1")).toBeTruthy());
    expect(screen.queryByTestId("task-stop")).toBeNull();
    expect(screen.queryByTestId("task-rerun")).toBeNull();
    expect(screen.queryByTestId("task-batch-stop")).toBeNull(); // D237：批量入口同样受写位管
    expect(document.querySelector(".ant-table-tbody .ant-checkbox-input")).toBeNull();
  });

  // ── D237：批量停止 ────────────────────────────────────────────────────────
  it("勾选可停任务后按钮可用；确认发一条 batch-stop 带 run_ids", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("场景r1")).toBeTruthy());
    const btn = screen.getByTestId("task-batch-stop") as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // 没勾选 = 不可点（不是点了没反应）

    const boxes = document.querySelectorAll(".ant-table-tbody .ant-checkbox-input");
    expect(boxes.length).toBe(2);
    expect((boxes[1] as HTMLInputElement).disabled).toBe(true); // r2 已结束，不可勾
    fireEvent.click(boxes[0]);

    await waitFor(() => expect((screen.getByTestId("task-batch-stop") as HTMLButtonElement).disabled)
      .toBe(false));
    expect(screen.getByTestId("task-batch-stop").textContent).toContain("1");

    fireEvent.click(screen.getByTestId("task-batch-stop"));
    // Modal.confirm 是静态弹层：上一条用例留下的运行中弹层也在 body 里，必须按标题收窄，
    // 否则会点到上一条的「停止」并把它再发一次（实测踩过）。
    const titles = await screen.findAllByText("停止选中的 1 个任务？");
    const modal = titles[0].closest(".ant-modal") as HTMLElement;
    fireEvent.click(within(modal).getByRole("button", { name: /批量停止/ }));
    await waitFor(() => {
      const c = calls.find((x) => x.method === "POST" && /\/task-center\/tasks\/batch-stop$/.test(x.url));
      expect(c).toBeTruthy();
      expect(c!.body).toEqual({ project_id: "p1", run_ids: ["r1"] });
    });
    // 成功之后重拉列表（selection 清空，按钮回到不可点）
    await waitFor(() => expect(
      (screen.getByTestId("task-batch-stop") as HTMLButtonElement).disabled).toBe(true));
  });

  // ── D239：高级搜索 + 列设置 ───────────────────────────────────────────────
  const taskReqs = () => calls.filter((x) => x.method === "GET" && /\/task-center\/tasks\?/.test(x.url));

  it("D239 空条件不拼 filter；应用「任务名称包含 登录」后列表请求带条件 JSON", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("场景r1")).toBeTruthy());
    expect(taskReqs()[0].url).not.toContain("filter="); // 空条件整个参数不上线（不是 filter=）
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(taskReqs().length).toBe(2));
    // 字段名来自后端 meta 的第一项（subject_name），前端不自列字段
    const raw = new URL(taskReqs()[1].url, "http://x").searchParams.get("filter");
    expect(JSON.parse(raw!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "subject_name", operator: "CONTAINS", value: "登录" }],
    });
  });

  it("D239 列设置勾掉「触发人」只藏那一列（其余表头原样）", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("场景r1")).toBeTruthy());
    const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("触发人");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["任务", "类型", "触发", "状态", "排队位次", "耗时", "触发人", "创建时间"]);
    fireEvent.click(boxes[labels.indexOf("触发人")]);
    await waitFor(() => expect(thead()).not.toContain("触发人"));
    expect(thead()).toContain("创建时间");
  });
});
