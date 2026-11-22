// 系统设置页（§11.4.27）——一期 DoD 判据第 3 条「UI 面」（1E T9 补账）的角色门控用例。
// 本页是「审计可见性」的界面证据（§11.4.26）：审计 Tab 的双闸门 = is_system_admin 且
// system:audit:read（settings.tsx:24）——两个方向都要钉：
//   ① READONLY/MEMBER/PROJECT_ADMIN 都看不到审计与平台用户 Tab（前两者按位、第三者被 isSysAdmin 拦）；
//   ② 系统管理员看得到审计 Tab，点开真的拉 GET /audit；
//   ③ 成员管理按钮跟 my_perms 走不跟 role 字符串走（READONLY 角色 + 显式 project:member:manage → 按钮回来）。
// 期望值从 perms.ts ROLE_PATTERNS 字面量 + settings.tsx 的 isSysAdmin 双闸推导，非同义反复。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import SettingsPage from "./settings";
import { useAuth } from "../auth/store";

function setUser(isSysAdmin: boolean) {
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: isSysAdmin, status: "active" },
    ready: true,
  });
}

function mockBackend(auditRows: unknown[] = []) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/members")
      ? { items: [{ id: "m1", project_id: "p1", user_id: "u1", role_code: "READONLY", account: "a", name: "张三" }] }
      : url.includes("/roles")
        ? { items: [{ code: "READONLY", name: "只读" }, { code: "MEMBER", name: "成员" }] }
        : { items: auditRows, next_cursor: null };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function renderPage() {
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>);
}

beforeEach(() => {
  cleanup();
  setUser(false);
  useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal",
    my_role: "PROJECT_ADMIN", my_perms: ["*"] } });
  mockBackend();
});

describe("设置页 Tab 角色门控（判据第 3 条 UI 面 / §11.4.26 审计可见性）", () => {
  it("READONLY：审计/平台用户 Tab 不在，成员 Tab 在且无「添加成员」钮（*:read 不含 member:manage）", async () => {
    setUser(false);
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal",
      my_role: "READONLY", my_perms: ["*:read", "-system:*"] } });
    renderPage();
    await screen.findByTestId("tab-members");
    expect(screen.queryByRole("tab", { name: "审计日志" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "平台用户" })).toBeNull();
    expect(screen.queryByTestId("member-add")).toBeNull();
    // 角色列降级成静态 Tag（不是 Select）——同一权限位的第二处证据。
    // tab-members 是常驻壳（MembersTab.tsx:134 无条件渲染），Tag 要等 /members 的
    // 行数据落地才画——只等壳在延迟探针下真实读到空表（getByTestId 抛）。等内容。
    await screen.findByTestId("member-role-static");
    expect(screen.getByTestId("member-role-static")).not.toBeNull();
  });

  it("MEMBER（-*:manage 拒 member:manage）：同样没有审计 Tab 与成员管理钮", async () => {
    setUser(false);
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal",
      my_role: "MEMBER", my_perms: ["*", "-*:delete", "-*:manage", "-system:*"] } });
    renderPage();
    await screen.findByTestId("tab-members");
    expect(screen.queryByRole("tab", { name: "审计日志" })).toBeNull();
    expect(screen.queryByTestId("member-add")).toBeNull();
  });

  it("项目管理员（非平台管理员）：能管成员，但审计 Tab 被 isSysAdmin 闸拦住（位有也不给看）", async () => {
    setUser(false);
    renderPage(); // PROJECT + my_perms ["*"]：system:audit:read 位是有的
    await screen.findByTestId("tab-members");
    expect(screen.getByTestId("member-add")).not.toBeNull(); // project:member:manage 命中 *
    expect(screen.queryByRole("tab", { name: "审计日志" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "平台用户" })).toBeNull();
  });

  it("系统管理员：审计 Tab 在，点开真的拉 GET /audit", async () => {
    setUser(true); // is_system_admin → patternsForProject 短路 ["*"]
    const calls = mockBackend([{
      id: "a1", ts: "2026-11-16T01:00:00+00:00", user_id: "u1", user_name: "张三",
      entry: "http", action: "env_create", target: "p1", ok: true, diff: null,
    }]);
    renderPage();
    const tab = await screen.findByRole("tab", { name: "审计日志" });
    fireEvent.click(tab);
    await screen.findByTestId("tab-audit");
    // tab-audit 是常驻壳，AuditTab 挂载后自己再发 GET /audit——行文本要等响应落地。
    await waitFor(() => expect(screen.getByTestId("audit-action").textContent).toBe("env_create"));
    expect(calls.some((u) => u.includes("/audit?"))).toBe(true);
  });

  it("成员钮跟 my_perms 走：READONLY 角色 + 服务端显式 project:member:manage → 钮回来", async () => {
    // 服务端 my_perms 优先（perms.ts:45）：显式位补上，role 字符串写 READONLY 也照样给按钮；
    // 审计仍旧没有——那是 isSysAdmin 闸，与位集无关，两件事在同一个用例里分得清。
    setUser(false);
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal",
      my_role: "READONLY", my_perms: ["*:read", "project:member:manage"] } });
    renderPage();
    await screen.findByTestId("tab-members");
    expect(screen.getByTestId("member-add")).not.toBeNull();
    // member-role（可管时的 Select）长在 /members 的行里，行数据后到——等内容再数。
    await waitFor(() => expect(screen.getByTestId("member-role")).not.toBeNull());
    expect(screen.queryByRole("tab", { name: "审计日志" })).toBeNull();
  });
});

// ── settings-body / settings-tabs（settings.tsx:59/64）补账 ──────────────────
// settings-body 的钉法：有序内容逐字（「当前项目「X」·我的角色 Y」——name 与 my_role
// 接错一根、或 isSysAdmin 条件后缀翻反，toBe 立刻红）+ 段落必须先于 Tabs 出现（顺序换
// 掉即红）。settings-tabs 的钉法：① testid 落在 Tabs 根（同时罩住 tab 栏与面板，挪到
// 段落上就红）；② destroyInactiveTabPane 是真销毁——切走的 pane 从 DOM 消失（不是
// -tabpane-hidden 挂着），再切回是重新挂载并重新拉数（请求计数 +1，藏起来的 pane 不会）；
// ③ Tab 集合由权限推导：非管理员 my_perms ["*"] 也只有「项目成员/角色」两枚（三个平台
// Tab 全被 isSysAdmin 闸掉，含此前从没被断言过的「模型配置」），系统管理员五枚全在且有序。

/** 当前 Tab 栏的标签序列（按 DOM 顺序——items 数组顺序就是它，增删/换序都会红）。 */
function tabLabels(): string[] {
  return screen.getAllByRole("tab").map((t) => t.textContent ?? "");
}

describe("settings-body：有序内容与条件后缀（settings.tsx:59-65）", () => {
  it("settings-body：抬头逐字 = 当前项目名 + my_role（字段接错即红），且段落先于 Tab 栏；非平台管理员没有「（平台管理员）」后缀", async () => {
    setUser(false);
    renderPage();
    const body = await screen.findByTestId("settings-body");
    // 逐字钉 :61 的模板串：{project.name} 与 {project.my_role} 互换、少个「·」都红。
    // 注：本行的期望值随「生码 → 中文名」的展示改动更新（PROJECT_ADMIN → 项目管理员，
    // 词表来自 shared/roleName.ts）——这是可见文案的翻译，不是放宽业务断言：
    // 项目名与角色仍是逐字比对，字段接错/后缀翻反照样红。
    const head = body.querySelector(".ant-typography") as HTMLElement;
    expect(head.textContent).toBe("当前项目「履约」·我的角色 项目管理员");
    // 有序内容：body 的第一个直接子节点是抬头段，第二个是 Tabs（顺序倒装即红）
    expect(body.children[0]).toBe(head);
    expect(body.children[1].className).toContain("ant-tabs");
    // 条件假腿：is_system_admin=false → 「（平台管理员）」一个字都不许出现（写死永远红）
    expect(body.textContent).not.toContain("平台管理员");
  });

  it("settings-body：系统管理员 → 同一抬头多出「（平台管理员）」后缀（条件真腿，写死没有也红）", async () => {
    setUser(true); // is_system_admin → patternsForProject 短路 ["*"]
    renderPage();
    const body = await screen.findByTestId("settings-body");
    const head = body.querySelector(".ant-typography") as HTMLElement;
    expect(head.textContent).toBe("当前项目「履约」·我的角色 项目管理员（平台管理员）");
  });
});

describe("settings-tabs：根挂点 / destroyInactiveTabPane 真销毁 / Tab 集合按权限（settings.tsx:34-64）", () => {
  it("settings-tabs：testid 就在 Tabs 根上（tab 栏与面板都在它罩内）", async () => {
    renderPage();
    await screen.findByTestId("tab-members");
    const root = screen.getByTestId("settings-tabs");
    expect(root.className).toContain("ant-tabs"); // 挪到抬头段/外层 div 上即红
    expect(within(root).getAllByRole("tab").length).toBeGreaterThan(0); // 罩住 tab 栏
    expect(within(root).getByTestId("tab-members")).not.toBeNull(); // 罩住面板
  });

  it("settings-tabs（destroyInactiveTabPane）：未点开的 Tab 内容不在 DOM；切走的 pane 从 DOM 消失；切回是重挂载并重新拉数（不是隐藏复用）", async () => {
    const calls = mockBackend();
    renderPage();
    await screen.findByTestId("tab-members");
    // 初始只挂 members 一块：roles/audit 的面板 DOM 压根不存在（不是 display:none）
    expect(screen.queryByTestId("tab-roles")).toBeNull();
    expect(screen.queryByTestId("tab-audit")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "角色" }));
    await screen.findByTestId("tab-roles");
    // 切走的一刻：上一块 pane 整个从 DOM 摘掉——摘掉 destroyInactiveTabPane 后
    // 它会以 .ant-tabs-tabpane-hidden 留在原地，本行 waitFor 超时红。
    await waitFor(() => expect(screen.queryByTestId("tab-members")).toBeNull());
    // 重挂载的行为证据（DOM 缺席之外再加一手）：RolesTab 每次激活都重新拉权限树。
    // 隐藏式 pane 只会在首挂时拉一次，计数停在 1。
    const treeGets = () => calls.filter((u) => u.includes("/role-perm-tree")).length;
    await waitFor(() => expect(treeGets()).toBe(1));

    fireEvent.click(screen.getByRole("tab", { name: "项目成员" }));
    await waitFor(() => expect(screen.queryByTestId("tab-roles")).toBeNull());
    expect(await screen.findByTestId("tab-members")).not.toBeNull(); // 切回：重新挂载

    fireEvent.click(screen.getByRole("tab", { name: "角色" }));
    await screen.findByTestId("tab-roles");
    await waitFor(() => expect(treeGets()).toBe(2)); // 第二次激活 = 第二次请求（销毁重建的铁证）
  });

  it("settings-tabs：非平台管理员即使 my_perms=[\"*\"] 也只有 项目成员/角色 两枚——平台用户/审计日志/模型配置都被 isSysAdmin 闸掉", async () => {
    setUser(false);
    renderPage(); // PROJECT_ADMIN + ["*"]：system:* 与 model:cfg:* 位「有」，但 isSysAdmin=false
    await screen.findByTestId("tab-members");
    // 有序全量集合：多一枚少一枚换序都红（「模型配置」此前从未被断过，摘掉它的 isSysAdmin 闸这里红）
    expect(tabLabels()).toEqual(["项目成员", "角色"]);
  });

  it("settings-tabs：系统管理员 → 五枚 Tab 全在且按 items 顺序（平台用户/审计日志/模型配置 的 isSysAdmin 真腿）", async () => {
    setUser(true); // patternsForProject 短路 ["*"]：model:cfg:read 也命中
    renderPage();
    await screen.findByTestId("tab-members");
    expect(tabLabels()).toEqual(["项目成员", "平台用户", "审计日志", "模型配置", "角色"]);
    // Tab 在 ≠ 内容在：destroyInactiveTabPane 下未激活的平台用户面板不预先挂载
    expect(screen.queryByTestId("tab-users")).toBeNull();
  });

  it("平台用户 Tab：selfId 真的从 auth 传到 UsersTab——自己那一行没有启停把手", async () => {
    // 后端 user_status 对 user_id == ctx.user_id 必 400（user_services.py:89-90），所以
    // 「自己的行给一个停用钮」= 一次注定被拒的点击。settings.tsx 传的是 user?.id ?? ""，
    // 这条把它改成任何常量（含 ""）都红：两行都会长出把手。
    setUser(true);
    mockBackend([
      { id: "u1", account: "a", name: "张三", email: null, is_system_admin: true, status: "active" },
      { id: "u9", account: "other", name: "别人", email: null, is_system_admin: false, status: "active" },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "平台用户" }));
    await screen.findByTestId("tab-users");
    await screen.findAllByTestId("user-account");
    const toggles = await screen.findAllByTestId("user-toggle");
    expect(toggles).toHaveLength(1);
    const row = toggles[0].closest("tr") as HTMLElement;
    expect(row.textContent).toContain("别人");
    expect(row.textContent).not.toContain("张三");
  });
});
