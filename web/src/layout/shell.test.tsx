// D105 自助改密入口的钉（shell 头像菜单 + ChangePasswordModal）：
// ① 菜单项「修改密码」对**任何已登录用户**可见——包括项目角色只有 ["*:read"] 的 READONLY。
//    这条反向钉住门禁口径：后端自助改密走平台级基础位 {"auth:*"}（core/service.py:213），
//    项目 perms 词表根本不保证含 auth:password:self；谁以后改成 can(perms,…) 这条先红（假门）。
// ② 未登录（user=null 的兜底态，正常被 RequireAuth 挡住）不渲染该项。
// ③ 点开弹窗：三字段齐全；两次新密码不一致 / 新密码不足 8 位 → 字段级人话报错，且**不发请求**。
// ④ 成功：POST /auth/password 且 body 恰好 {old_password,new_password}（确认位不上送）；
//    成功 toast「密码已修改」；弹窗关闭。
// ⑤ 403 bad_credentials → 中文「旧密码不正确」，原始 code 不许出现在页面上，弹窗保持打开可重试。
// ⑥ 其它错误（500）→ 后端中文 message 原样上屏，不许静默。
// ⑦ 仍未开放的模块（mcp/skills 零路由零后端代码）的 Tooltip 说「未开放（计划X期）」，
//    不许说「X期开放」——后者把排期断言成已交付，违 shell.tsx 的诚实原则。
//    D183 步 6a：plans 已翻成真页面（/plans），它不再属于这条；新形状（入口与断言同批翻，
//    口径同 nav.spec.mjs 的 wb-pilot-generate 先例）钉在下面的「nav-plans 已翻成正常入口」。
// ⑧ 项目切换器的空下拉分两条来路：取失败说「没取到」，真 0 个项目才留 antd 缺省句。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
import zhCN from "antd/locale/zh_CN";
import { MemoryRouter, Route, Routes } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import Shell from "./shell";

// ProLayout 用 matchMedia 判断断点；jsdom 没有 matchMedia，桌面断点查询会落到「移动端」,
// 侧栏菜单整棵不渲染（实测：nav-mcp/nav-plans 找不到，而真浏览器 1440 一切正常）。
// 这里给一个「桌面」桩：matches=false 即不命中 max-width 查询。
beforeAll(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })));
});
afterAll(() => { vi.unstubAllGlobals(); });
import { useAuth } from "../auth/store";
import { setToken } from "../api/client";

const USER = { id: "u1", account: "zhangsan", name: "张三", email: null,
  is_system_admin: false, status: "active" };
// 项目角色 READONLY 的真实生效模式：只有 *:read——后端对自助改密照样放行（{"auth:*"}），
// 所以菜单项必须在。这就是「按项目 perms 门禁 = 假门」的反例样本。
const READONLY_PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "READONLY", my_perms: ["*:read"] };

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** motion:false 同 CaseList.test.tsx:77-84：rc-motion 的 leave 动画在 jsdom 里不完成，
 * destroyOnHidden 的弹窗关掉后节点会永远留在 DOM，「成功/关窗就卸载」这条断言测不了。
 * locale 跟 App.tsx:107 一致：缺省 emptyText（切换器空下拉的「暂无数据」）由它决定，
 * 不给 locale 就会渲染英文 "No data"，那条正对照会假红。 */
function renderShell() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }} locale={zhCN}>
      <MemoryRouter><Shell /></MemoryRouter>
    </ConfigProvider>,
  );
}

/** 头像菜单是 hover 触发：mouseOver 后等 150ms 的 mouseEnterDelay 弹层才挂出来。 */
async function openUserMenu() {
  const trigger = screen.getAllByTestId("user-menu").at(-1)!;
  fireEvent.mouseOver(trigger);
  return screen.findByTestId("menu-change-password", {}, { timeout: 2000 });
}

async function fill(pwOld: string, pwNew: string, pwConfirm: string) {
  fireEvent.change(screen.getByTestId("pwd-field-old"), { target: { value: pwOld } });
  fireEvent.change(screen.getByTestId("pwd-field-new"), { target: { value: pwNew } });
  fireEvent.change(screen.getByTestId("pwd-field-confirm"), { target: { value: pwConfirm } });
}

async function clickOk() {
  fireEvent.click(await screen.findByTestId("pwd-change-ok", {}, { timeout: 2000 }));
}

function toastText(): string {
  return Array.from(document.querySelectorAll(".ant-message")).map((n) => n.textContent).join("|");
}

beforeEach(() => {
  cleanup();
  message.destroy();
  setToken("t"); // client 的 refresh 分支要求有 token；本组测试的桩不返回 401，不会触发刷新
  useAuth.setState({ user: USER, project: READONLY_PROJECT, ready: true });
});

describe("D105 入口门禁", () => {
  it("READONLY（perms 只有 *:read）也看得到「修改密码」——门禁不是 can(项目 perms)", async () => {
    renderShell();
    expect(await openUserMenu()).not.toBeNull();
  });

  it("未登录兜底态（user=null）不渲染该项", async () => {
    useAuth.setState({ user: null, project: null, ready: true });
    renderShell();
    const trigger = screen.getAllByTestId("user-menu").at(-1)!;
    fireEvent.mouseOver(trigger);
    // 退出登录项照常渲染（证明弹层真打开了，不是没弹所以查不到）
    await screen.findByTestId("logout", {}, { timeout: 2000 });
    expect(screen.queryByTestId("menu-change-password")).toBeNull();
  });
});

describe("ChangePasswordModal 校验与提交", () => {
  it("点开菜单项 → 弹窗出现三字段", async () => {
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    renderShell();
    fireEvent.click(await openUserMenu());
    expect(await screen.findByTestId("pwd-change-modal", {}, { timeout: 2000 })).not.toBeNull();
    screen.getByTestId("pwd-field-old");
    screen.getByTestId("pwd-field-new");
    screen.getByTestId("pwd-field-confirm");
  });

  it("两次新密码不一致 → 字段报错且不发改密请求", async () => {
    const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => res(200, { items: [] }));
    global.fetch = f as unknown as typeof fetch;
    renderShell();
    fireEvent.click(await openUserMenu());
    await screen.findByTestId("pwd-change-modal", {}, { timeout: 2000 });
    await fill("OldPass@9", "FreshPass@9", "FreshPass@0");
    await clickOk();
    expect(await screen.findByText("两次输入的新密码不一致", {}, { timeout: 2000 })).not.toBeNull();
    expect(f.mock.calls.filter((c) => String(c[0]).includes("/auth/password"))).toHaveLength(0);
    expect(screen.queryByTestId("pwd-change-modal")).not.toBeNull(); // 弹窗不关，可改后重试
  });

  it("新密码不足 8 位 → 人话报错且不发请求（与后端 min_length=8 对齐）", async () => {
    const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => res(200, { items: [] }));
    global.fetch = f as unknown as typeof fetch;
    renderShell();
    fireEvent.click(await openUserMenu());
    await screen.findByTestId("pwd-change-modal", {}, { timeout: 2000 });
    await fill("OldPass@9", "short", "short");
    await clickOk();
    expect(await screen.findByText("至少 8 位", {}, { timeout: 2000 })).not.toBeNull();
    expect(f.mock.calls.filter((c) => String(c[0]).includes("/auth/password"))).toHaveLength(0);
  });

  it("成功：POST /auth/password，body 恰好 {old_password,new_password}，toast「密码已修改」，弹窗关闭", async () => {
    const f = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes("/auth/password") ? res(200, { ok: true }) : res(200, { items: [] }));
    global.fetch = f as unknown as typeof fetch;
    renderShell();
    fireEvent.click(await openUserMenu());
    await screen.findByTestId("pwd-change-modal", {}, { timeout: 2000 });
    await fill("OldPass@9", "FreshPass@9", "FreshPass@9");
    await clickOk();
    await waitFor(() => expect(toastText()).toContain("密码已修改"), { timeout: 2000 });
    const call = f.mock.calls.find((c) => String(c[0]) === "/api/v1/auth/password");
    expect(call).toBeTruthy();
    expect(String(call![0])).toBe("/api/v1/auth/password");
    const body = JSON.parse(String((call![1] as RequestInit | undefined)?.body));
    expect(body).toEqual({ old_password: "OldPass@9", new_password: "FreshPass@9" });
    await waitFor(() => expect(screen.queryByTestId("pwd-change-modal")).toBeNull(), { timeout: 2000 });
  });

  it("403 bad_credentials → 中文「旧密码不正确」，原始 code 不上屏，弹窗保持打开", async () => {
    const f = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes("/auth/password")
        ? res(403, { code: "bad_credentials", message: "旧密码不正确", details: {} })
        : res(200, { items: [] }));
    global.fetch = f as unknown as typeof fetch;
    renderShell();
    fireEvent.click(await openUserMenu());
    await screen.findByTestId("pwd-change-modal", {}, { timeout: 2000 });
    await fill("WrongPass@9", "FreshPass@9", "FreshPass@9");
    await clickOk();
    await waitFor(() => expect(toastText()).toContain("旧密码不正确"), { timeout: 2000 });
    expect(toastText()).not.toContain("bad_credentials");
    expect(screen.queryByTestId("pwd-change-modal")).not.toBeNull();
  });

  it("其它失败（500）→ 后端中文 message 原样上屏，不静默", async () => {
    const f = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes("/auth/password")
        ? res(500, { code: "internal", message: "服务内部错误", details: {} })
        : res(200, { items: [] }));
    global.fetch = f as unknown as typeof fetch;
    renderShell();
    fireEvent.click(await openUserMenu());
    await screen.findByTestId("pwd-change-modal", {}, { timeout: 2000 });
    await fill("OldPass@9", "FreshPass@9", "FreshPass@9");
    await clickOk();
    await waitFor(() => expect(toastText()).toContain("服务内部错误"), { timeout: 2000 });
    expect(screen.queryByTestId("pwd-change-modal")).not.toBeNull();
  });
});

describe("未开放模块的诚实标注", () => {
  it("MCP/Skills 两个 disabled 入口的 Tooltip 说「未开放（计划X期）」——零路由零后端代码的模块不许写「X期开放」断言已交付", async () => {
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    renderShell();
    // Tooltip 挂在 testid span 的内层 span 上（shell.tsx:175），事件只到得着监听器的节点；
    // hover 手法同 EnvPanel.test.tsx:286-294（mouseOver+mouseEnter 两件，mouseLeave 不发 ⇒ 浮层留在 DOM）
    // ProLayout 的 defaultOpenAll 在挂载后才落 openKeys（一轮 effect），首个 tick 菜单项
    // 可能还没进 DOM——用 findBy 等到它出现，不赌同步渲染（真浏览器无此问题）。
    for (const id of ["nav-mcp", "nav-skills"]) {
      const node = (await screen.findByTestId(id)).querySelector("span")!;
      fireEvent.mouseOver(node);
      fireEvent.mouseEnter(node);
    }
    const visibleTips = () => Array.from(
      document.querySelectorAll(".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner"),
    ).map((n) => n.textContent).join("|");
    await waitFor(() => {
      expect(visibleTips()).toContain("未开放（计划二期）");
    }, { timeout: 4000 });
    // 「X期开放」把排期说成已交付状态；「未开放（计划X期）」不含这两个子串
    expect(visibleTips()).not.toContain("二期开放");
    // D183 步 6a：plans 已是真页面——「三期」这个批次文案随 note 一起退场。
    // 反向钉：翻过去的入口不许留着旧 Tooltip 冒充未交付（下面「nav-plans 已翻成正常入口」
    // 钉正向形状，这条钉反向缺席；两条都靠 renderShell 的真实菜单，不是空扫出来的绿）。
    expect(visibleTips()).not.toContain("未开放（计划三期）");
  });
});

// ── D183 步 6a：nav-plans 从 disabled+「未开放（计划三期）」翻成正常入口 ─────────
// 当年钉 disabled 是为了防「三期开放」式假承诺（排期被断言成已交付）；6a 兑现了入口
// （路由 /plans + 真页面），继续钉 disabled 就成了反向的谎（把已交付说成没交付）。
// 入口与断言同批翻（nav.spec.mjs 的 wb-pilot-generate 先例），新形状钉三件事：
// ① 叶子可点（不是 disabled 灰条）；
// ② 点了真去 /plans——探针路由接住 Outlet，「入口是真的」落在导航事实上，不靠 testid；
// ③ 没有 note 就一个字都不多：hover 不弹任何 Tooltip，也不许换成一句自夸的新文案。
describe("D183 步 6a nav-plans 已翻成正常入口", () => {
  it("叶子 enabled、hover 零 Tooltip（旧「未开放」与新自夸都不许有）", async () => {
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    renderShell();
    const node = await screen.findByTestId("nav-plans");
    // 正对照：它确实在菜单里且没有 disabled 类（翻过去 ≠ 摘掉整个入口）
    await waitFor(() => expect(screen.getByTestId("nav-mcp")).not.toBeNull());
    expect(node).not.toBeNull();
    const item = node.closest("li")!;
    expect(item.className).not.toContain("ant-menu-item-disabled");
    fireEvent.mouseOver(node);
    fireEvent.mouseEnter(node);
    // 等一帧 hover 触发窗口（Tooltip mouseEnterDelay 0.1s），再量「一个浮层都不许有」；
    // 同文件上一用例刚证明过 hover 未开放项能让浮层出现，选择器不是哑的。
    await new Promise((r) => setTimeout(r, 350));
    const tips = Array.from(
      document.querySelectorAll(".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner"),
    ).map((n) => n.textContent).join("|");
    expect(tips).toBe("");
  });

  it("点了真去 /plans：ROUTES 里挂的是 /plans，Outlet 被探针接住", async () => {
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Shell />}>
            <Route path="plans" element={<div data-testid="plans-route-probe">/plans</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("nav-plans", {}, { timeout: 2000 }));
    expect(await screen.findByTestId("plans-route-probe", {}, { timeout: 2000 })).not.toBeNull();
  });
});

// ── D165 nav-notify 按系统管理员身份显隐（§11.5.1 隐藏非禁用）──────────────────
// 通知渠道是平台级配置：后端 build_ctx（core/service.py:205-213）对非系统管理员恒
// {"auth:*"} ⇒ 五端点全 403。PROJECT_ADMIN 的 ["*","-system:*"] 盖得住 notify:channel:*，
// 按项目 perms 画门是假门（demo_pm 看得见入口，进去恒 403）。路由本身不藏（D47 家族）。
describe("D165 nav-notify：非系统管理员隐藏、系统管理员在场", () => {
  it("PROJECT_ADMIN（非系统管理员，demo_pm 场景）：侧栏无 nav-notify，其余入口照常在", async () => {
    useAuth.setState({
      user: { ...USER, is_system_admin: false },
      project: { ...READONLY_PROJECT, my_role: "PROJECT_ADMIN", my_perms: ["*", "-system:*"] },
    });
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    renderShell();
    // 正对照：菜单真的渲染出来了（同组的 settings/cron 在场），不是整棵树没挂
    await waitFor(() => expect(screen.getByTestId("nav-settings")).not.toBeNull());
    expect(screen.getByTestId("nav-cron")).not.toBeNull();
    expect(screen.queryByTestId("nav-notify")).toBeNull();
  });

  it("READONLY（非系统管理员）同样无 nav-notify——门看身份不看项目角色高低", async () => {
    // beforeEach 即 READONLY + is_system_admin:false
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    renderShell();
    await waitFor(() => expect(screen.getByTestId("nav-settings")).not.toBeNull());
    expect(screen.queryByTestId("nav-notify")).toBeNull();
  });

  it("系统管理员：nav-notify 在场（正对照，防「对谁都藏」的镜像假绿）", async () => {
    useAuth.setState({ user: { ...USER, is_system_admin: true } });
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    renderShell();
    await waitFor(() => expect(screen.getByTestId("nav-notify")).not.toBeNull());
  });
});

// 项目切换器的空下拉有两条来路：真的一个项目都没有 vs 这次没取到。
// .catch(() => undefined) 时代两条都露 antd 缺省的「暂无数据」——对正坐在项目里的人
// 说「你没有项目」，既自相矛盾又不给原因（文案不许比代码多说一句，也不许少说一句）。
describe("项目切换器的空下拉分两条来路（shell.tsx:110-127）", () => {
  /** 展开顶栏那只下拉：mousedown 到 selector 上（RequestEditor.test.tsx:49 同款）。 */
  function openSwitcher(): void {
    const sel = screen.getByTestId("project-switcher").querySelector(".ant-select-selector")!;
    fireEvent.mouseDown(sel);
  }

  it("取项目列表 500 → 下拉里是「项目列表没取到…」那句，antd 的「暂无数据」一个字不出现", async () => {
    global.fetch = vi.fn(async () => res(500, { code: "http_500", message: "服务开小差了", details: {} })) as unknown as typeof fetch;
    renderShell();
    await waitFor(() => expect(screen.getByTestId("project-switcher")).not.toBeNull());
    openSwitcher();
    expect(await screen.findByText(
      "项目列表没取到，可能是网络不通——当前项目照常可用，重新进入本页可重试", {}, { timeout: 2000 },
    )).not.toBeNull();
    expect(screen.queryByText("暂无数据")).toBeNull();
  });

  it("取成功但 0 个项目：仍画 antd 缺省「暂无数据」，不许蹭失败句（正对照）", async () => {
    useAuth.setState({ project: null }); // 真·没项目的人
    global.fetch = vi.fn(async () => res(200, { items: [] })) as unknown as typeof fetch;
    renderShell();
    await waitFor(() => expect(screen.getByTestId("project-switcher")).not.toBeNull());
    openSwitcher();
    // findAll：antd 的 Empty 同时画 SVG <title> 与 .ant-empty-description，两处各一份文案
    expect((await screen.findAllByText("暂无数据", {}, { timeout: 2000 })).length).toBeGreaterThan(0);
    expect(screen.queryByText(/项目列表没取到/)).toBeNull();
  });
});
