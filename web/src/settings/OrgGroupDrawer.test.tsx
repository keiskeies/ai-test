// 组织用户组抽屉（D270）组件测试。
// 钉：① 列表渲染管理位标签；② 新建组把 perms 带进 body；③ 编辑组改 perms；
// ④ 组员读/加/移；⑤ 删组确认。
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

import OrgGroupDrawer from "./OrgGroupDrawer";

const calls: { url: string; method: string; body: unknown }[] = [];
const ORG = {
  id: "o1", name: "研发中心", code: "rd", description: null, status: "normal",
  member_count: 2, project_count: 1, my_role: "ORG_ADMIN",
  my_perms: ["system:org:update", "system:org:member:manage",
    "system:org:project:manage", "system:org:group:manage"],
  created_at: null,
};
const GROUP = {
  id: "g1", org_id: "o1", name: "用例评审组",
  description: "评审用", perms: ["system:org:member:manage"], member_count: 1, created_at: null,
};
const GMEMBER = { id: "gm1", group_id: "g1", user_id: "u1", account: "u1", name: "张三" };

function resp(status: number, json: unknown): Response {
  return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/system/orgs/groups/query")) return resp(200, { items: [GROUP] });
    if (url.endsWith("/system/orgs/groups") && method === "POST") {
      return resp(201, { ...GROUP, id: "g9", name: body.name, perms: body.perms });
    }
    if (url.endsWith("/system/orgs/groups/update")) {
      return resp(200, { ...GROUP, name: body.name ?? GROUP.name, perms: body.perms ?? GROUP.perms });
    }
    if (url.endsWith("/system/orgs/groups/delete")) return resp(200, { ok: true });
    if (url.endsWith("/system/orgs/groups/members/query")) return resp(200, { items: [GMEMBER] });
    if (url.endsWith("/system/orgs/groups/members/set")) {
      return resp(200, { ...GMEMBER, id: "gm9", account: body.account });
    }
    if (url.endsWith("/system/orgs/groups/members/remove")) return resp(200, { ok: true });
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
});

afterEach(cleanup);

async function confirmPopover() {
  const btn = await waitFor(() => {
    const el = document.querySelector(".ant-popover:not(.ant-popover-hidden) .ant-btn-primary");
    if (!el) throw new Error("Popconfirm 未展开");
    return el as HTMLElement;
  });
  fireEvent.click(btn);
}

function renderDrawer(onChanged = () => {}) {
  return render(<OrgGroupDrawer org={ORG} onClose={() => {}} onChanged={onChanged} />);
}

describe("组织用户组抽屉", () => {
  it("渲染用户组与管理位标签", async () => {
    renderDrawer();
    expect(await screen.findByTestId("org-group-drawer")).toBeTruthy();
    expect(await screen.findByText("用例评审组")).toBeTruthy();
    expect(screen.getByText("管组织成员")).toBeTruthy();
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/groups/query")
        && (c.body as { org_id?: string }).org_id === "o1",
    )).toBe(true));
  });

  it("新建用户组：名称与勾选的管理位进 body", async () => {
    const onChanged = vi.fn();
    renderDrawer(onChanged);
    fireEvent.click(await screen.findByTestId("org-group-create"));
    fireEvent.change(await screen.findByTestId("org-group-name"), { target: { value: "项目运维组" } });
    fireEvent.click(screen.getByText("管项目归属"));
    fireEvent.click(await screen.findByRole("button", { name: /保\s*存/ }));
    await waitFor(() => {
      const hit = calls.find((c) => c.url.endsWith("/system/orgs/groups") && c.method === "POST");
      expect(hit).toBeTruthy();
      const body = hit!.body as { name: string; perms: string[]; description: string | null };
      expect(body.name).toBe("项目运维组");
      expect(body.perms).toEqual(["system:org:project:manage"]);
      expect(body.description).toBeNull();
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("编辑用户组：带上当前管理位与说明", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId("org-group-edit-g1"));
    expect((await screen.findByTestId("org-group-name") as HTMLInputElement).value).toBe("用例评审组");
    fireEvent.click(screen.getByText("改组织资料"));
    fireEvent.click(await screen.findByRole("button", { name: /保\s*存/ }));
    await waitFor(() => {
      const hit = calls.find((c) => c.url.endsWith("/system/orgs/groups/update"));
      expect(hit).toBeTruthy();
      const body = hit!.body as { group_id: string; perms: string[] };
      expect(body.group_id).toBe("g1");
      expect(body.perms.sort()).toEqual(
        ["system:org:member:manage", "system:org:update"].sort(),
      );
    });
  });

  it("组员：读取、加入、移出", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId("org-group-members-g1"));
    expect(await screen.findByTestId("org-group-member-drawer")).toBeTruthy();
    expect(await screen.findByText("张三")).toBeTruthy();

    fireEvent.change(screen.getByTestId("org-group-member-account"), { target: { value: "u2" } });
    fireEvent.click(screen.getByTestId("org-group-member-add"));
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/groups/members/set")
        && (c.body as { account?: string }).account === "u2",
    )).toBe(true));

    fireEvent.click(await screen.findByTestId("org-group-member-remove-u1"));
    await confirmPopover();
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/groups/members/remove")
        && (c.body as { user_id?: string }).user_id === "u1",
    )).toBe(true));
  });

  it("删除用户组走确认弹层", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByTestId("org-group-delete-g1"));
    await confirmPopover();
    await waitFor(() => expect(calls.some(
      (c) => c.url.endsWith("/system/orgs/groups/delete")
        && (c.body as { group_id?: string }).group_id === "g1",
    )).toBe(true));
  });
});
