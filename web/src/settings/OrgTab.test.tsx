// 组织 Tab（D269）组件测试。
// 钉：① 列表渲染成员/项目计数；② 新建组织的 POST body；③ 成员抽屉读/加/移；
// ④ 项目抽屉读/归档/移出（归档体是 target_project_id）；⑤ 搜索把 q 带进 body；
// ⑥ 取列表失败显示错误条。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import OrgTab from "./OrgTab";

const calls: { url: string; method: string; body: unknown }[] = [];

const ALL_CAPS = [
  "system:org:update",
  "system:org:member:manage",
  "system:org:project:manage",
  "system:org:group:manage",
  "system:org:defect:manage",
];
const ORG = {
  id: "o1", name: "研发中心", code: "rd", description: "主研发组织", status: "normal",
  member_count: 2, project_count: 1, my_role: "SYSTEM_ADMIN", my_perms: ALL_CAPS,
  created_at: null,
};
const MEMBER = {
  id: "om1", org_id: "o1", user_id: "u1", role_code: "ORG_ADMIN",
  account: "u1", name: "张三",
};
const PROJ = { id: "p1", name: "项目A", description: null, status: "normal" };
const PROJ2 = { id: "p2", name: "项目B", description: null, status: "normal" };
// D270：列表按场景换 my_role（系统管理员 / 组织管理员 / 组织成员）。
let orgRows: (typeof ORG)[] = [ORG];

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  orgRows = [ORG];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/system/orgs/query")) {
      const q = (body as { q?: string } | undefined)?.q ?? "";
      if (q === "boom") return resp(500, { code: "boom", message: "组织查询炸了", details: {} });
      return resp(200, { items: orgRows });
    }
    if (url.endsWith("/system/orgs") && method === "POST") {
      return resp(201, { ...ORG, id: "o9", ...body, member_count: 1, project_count: 0 });
    }
    if (url.endsWith("/system/orgs/members/query")) return resp(200, { items: [MEMBER] });
    if (url.endsWith("/system/orgs/members/set")) {
      return resp(200, { ...MEMBER, id: "om9", role_code: body.role_code, account: body.account });
    }
    if (url.endsWith("/system/orgs/members/remove")) return resp(200, { ok: true });
    if (url.endsWith("/system/orgs/projects/query")) return resp(200, { items: [PROJ] });
    if (url.includes("/projects?") && method === "GET") return resp(200, { items: [PROJ, PROJ2] });
    if (url.endsWith("/system/orgs/projects/assign")) {
      return resp(200, { ...PROJ2, id: body.target_project_id });
    }
    if (url.endsWith("/system/orgs/projects/remove")) return resp(200, { ok: true });
    if (url.endsWith("/system/orgs/groups/query")) return resp(200, { items: [] });
    // D271：组织状态流模板读口（抽屉里 DefectFlowTab 以 orgId 模式拉图）
    if (url.endsWith("/system/orgs/defect-flow/get")) {
      return resp(200, {
        org_id: "o1", customized: false, start_key: "new",
        statuses: [
          { key: "new", name: "新建", is_start: true, is_end: false },
          { key: "closed", name: "已关闭", is_start: false, is_end: true },
        ],
        transitions: [{ from_key: "new", to_key: "closed" }],
      });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

/** 点 Popconfirm 的确认键：行内触发器本身也叫「移出」，只能按弹层里的 primary 按钮定位。 */
async function confirmPopover() {
  const btn = await waitFor(() => {
    const el = document.querySelector(".ant-popover:not(.ant-popover-hidden) .ant-btn-primary");
    if (!el) throw new Error("Popconfirm 未展开");
    return el as HTMLElement;
  });
  fireEvent.click(btn);
}

describe("组织 Tab", () => {
  it("渲染组织行与计数；搜索把 q 带进 body", async () => {
    render(<OrgTab isSysAdmin />);
    const row = await screen.findByTestId("org-row-o1");
    expect(row.textContent).toContain("研发中心");
    expect(row.textContent).toContain("rd");
    expect(row.textContent).toContain("2");

    const search = screen.getByTestId("org-search");
    fireEvent.change(search, { target: { value: "boom" } });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/query") && (c.body as { q?: string }).q === "boom",
    )).toBe(true));
    expect(await screen.findByTestId("org-error")).toBeTruthy();
  });

  it("新建组织：POST body 带 name/code/description", async () => {
    render(<OrgTab isSysAdmin />);
    await screen.findByTestId("org-row-o1");
    fireEvent.click(screen.getByTestId("org-create"));
    fireEvent.change(screen.getByTestId("org-name"), { target: { value: "测试组织" } });
    fireEvent.change(screen.getByTestId("org-code"), { target: { value: "test-org" } });
    fireEvent.change(screen.getByTestId("org-desc"), { target: { value: "说明" } });
    fireEvent.click(await screen.findByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(calls.some(
      (c) => c.method === "POST" && c.url.endsWith("/system/orgs")
        && (c.body as { name?: string }).name === "测试组织",
    )).toBe(true));
    const created = calls.find((c) => c.url.endsWith("/system/orgs") && c.method === "POST")!;
    expect(created.body).toMatchObject({ name: "测试组织", code: "test-org", description: "说明" });
  });

  it("成员抽屉：列表回显；添加带 account+role_code；移出带 user_id", async () => {
    render(<OrgTab isSysAdmin />);
    fireEvent.click(await screen.findByTestId("org-members-o1"));
    expect(await screen.findByTestId("org-member-drawer")).toBeTruthy();
    expect(await screen.findByText("张三")).toBeTruthy();

    fireEvent.change(screen.getByTestId("org-member-account"), { target: { value: "u2" } });
    fireEvent.click(screen.getByTestId("org-member-add"));
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/members/set")
        && (c.body as { account?: string; role_code?: string }).account === "u2",
    )).toBe(true));
    const added = calls.find((c) => c.url.endsWith("/system/orgs/members/set"))!;
    expect(added.body).toMatchObject({ org_id: "o1", account: "u2", role_code: "ORG_MEMBER" });

    fireEvent.click(screen.getByTestId("org-member-remove-u1"));
    await confirmPopover();
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/members/remove")
        && (c.body as { user_id?: string }).user_id === "u1",
    )).toBe(true));
  });

  it("项目抽屉：列表、归档（target_project_id）、移出", async () => {
    render(<OrgTab isSysAdmin />);
    fireEvent.click(await screen.findByTestId("org-projects-o1"));
    expect(await screen.findByTestId("org-project-drawer")).toBeTruthy();
    expect(await screen.findByText("项目A")).toBeTruthy();

    // 打开下拉选「项目B」（展开与选择必须分两步：rc-select 在展开态 mouseDown 会收起）
    const sel = screen.getByTestId("org-project-select");
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText("项目B"));
    fireEvent.click(screen.getByTestId("org-project-assign"));
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/projects/assign")
        && (c.body as { target_project_id?: string }).target_project_id === "p2",
    )).toBe(true));

    fireEvent.click(screen.getByTestId("org-project-remove-p1"));
    await confirmPopover();
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/projects/remove")
        && (c.body as { target_project_id?: string }).target_project_id === "p1",
    )).toBe(true));
  });

  it("D270 组织管理员（非系统管理员）：可管成员/改资料，但没有新建/删除组织", async () => {
    orgRows = [{ ...ORG, my_role: "ORG_ADMIN", my_perms: ALL_CAPS }];
    render(<OrgTab isSysAdmin={false} />);
    await screen.findByTestId("org-row-o1");
    expect(screen.queryByTestId("org-create")).toBeNull();
    expect(screen.queryByTestId("org-delete-o1")).toBeNull();
    expect(screen.getByTestId("org-members-o1")).toBeTruthy();
    expect(screen.getByTestId("org-edit-o1")).toBeTruthy();
    expect(screen.getByTestId("org-groups-o1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("org-groups-o1"));
    expect(await screen.findByTestId("org-group-drawer")).toBeTruthy();
  });

  it("D270 组委派的成员：只有 member 位 → 只出现「成员」钮", async () => {
    orgRows = [{ ...ORG, my_role: "ORG_MEMBER", my_perms: ["system:org:member:manage"] }];
    render(<OrgTab isSysAdmin={false} />);
    await screen.findByTestId("org-row-o1");
    expect(screen.getByTestId("org-members-o1")).toBeTruthy();
    expect(screen.queryByTestId("org-edit-o1")).toBeNull();
    expect(screen.queryByTestId("org-groups-o1")).toBeNull();
    expect(screen.queryByTestId("org-create")).toBeNull();
  });

  it("D270 组织成员：只读——没有成员/编辑/删除钮，项目抽屉也不给归档与移出", async () => {
    orgRows = [{ ...ORG, my_role: "ORG_MEMBER", my_perms: [] }];
    render(<OrgTab isSysAdmin={false} />);
    await screen.findByTestId("org-row-o1");
    expect(screen.queryByTestId("org-create")).toBeNull();
    expect(screen.queryByTestId("org-members-o1")).toBeNull();
    expect(screen.queryByTestId("org-edit-o1")).toBeNull();
    expect(screen.queryByTestId("org-delete-o1")).toBeNull();

    fireEvent.click(screen.getByTestId("org-projects-o1"));
    expect(await screen.findByTestId("org-project-drawer")).toBeTruthy();
    expect(await screen.findByText("项目A")).toBeTruthy();
    expect(screen.queryByTestId("org-project-select")).toBeNull();
    expect(screen.queryByTestId("org-project-assign")).toBeNull();
    expect(screen.queryByTestId("org-project-remove-p1")).toBeNull();
  });

  it("D271 状态流：持 defect 位才出现「状态流」钮，抽屉按 orgId 拉组织模板", async () => {
    render(<OrgTab isSysAdmin />);
    await screen.findByTestId("org-row-o1");
    fireEvent.click(screen.getByTestId("org-flow-o1"));
    expect(await screen.findByTestId("defect-flow-tab")).toBeTruthy();
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/defect-flow/get")
        && (c.body as { org_id?: string }).org_id === "o1",
    )).toBe(true));
    expect(await screen.findByTestId("defect-flow-default")).toBeTruthy();
  });

  it("D271 只有 member 位：不出现「状态流」钮", async () => {
    orgRows = [{ ...ORG, my_role: "ORG_MEMBER", my_perms: ["system:org:member:manage"] }];
    render(<OrgTab isSysAdmin={false} />);
    await screen.findByTestId("org-row-o1");
    expect(screen.queryByTestId("org-flow-o1")).toBeNull();
  });
});
