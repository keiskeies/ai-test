// D38 权限空页的钉：
// ① 后端回了权限位（details.perm 或 message 原话「缺少权限：<位>」）→ 文案出现那个原名；
// ② 后端没回 → 不出现任何编造的位名（页面上不得有 `x:y` 形式的位字符串）——猜位名 = 假门；
// ③ [复制申请文案] 复制的文本含权限位与项目名；
// ④ 三条真实路径接了两条真渲染：详情 403（直接敲 URL / 列表点进来同落点）与
//    环境管理「项目全局配置」Tab 403，都渲染 PermEmpty 而不是空白/裸 403。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import PermEmpty, { backendPermOf, permApplyText } from "./PermEmpty";
import { ApiErr } from "../api/client";
import { useAuth } from "../auth/store";
import { GlobalConfig } from "../api/EnvPanel";
import UiCaseDetailPage from "../pages/uiCaseDetail";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "READONLY", my_perms: ["*:read"] };

beforeEach(() => {
  cleanup();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("backendPermOf：位名只认后端原话", () => {
  it("details.perm 有 → 原样透传（后端补 details 后的正式通路）", () => {
    const e = new ApiErr("insufficient_permission", "缺少权限", 403, { perm: "ui:case:update" });
    expect(backendPermOf(e)).toBe("ui:case:update");
    const e2 = new ApiErr("insufficient_permission", "缺少权限", 403, { perms: ["adb:case:run"] });
    expect(backendPermOf(e2)).toBe("adb:case:run");
  });
  it("details 没有但 message 是后端 require 的原话 → 提原名", () => {
    const e = new ApiErr("insufficient_permission", "缺少权限：env:config:update", 403);
    expect(backendPermOf(e)).toBe("env:config:update");
  });
  it("后端没回位（forbidden/其它 message/非 ApiErr）→ null，前端一个位都不猜", () => {
    expect(backendPermOf(new ApiErr("forbidden", "无此项目权限", 403))).toBeNull();
    expect(backendPermOf(new ApiErr("insufficient_permission", "缺少权限", 403, {}))).toBeNull();
    expect(backendPermOf(new ApiErr("boom", "缺少权限：编的", 500))).toBeNull();
    expect(backendPermOf(new Error("x"))).toBeNull();
    expect(backendPermOf(null)).toBeNull();
  });
});

describe("组件文案与申请文案", () => {
  it("① 后端回了位 → 文案出现那个原名（details.perm 打桩）", () => {
    const e = new ApiErr("insufficient_permission", "无此项目权限", 403, { perm: "iam:role:create" });
    render(<PermEmpty error={e} projectName="履约" context="查看角色" />);
    expect(screen.getByTestId("perm-empty-lock")).not.toBeNull();
    expect(screen.getByTestId("perm-empty-desc").textContent).toContain("iam:role:create");
  });

  it("② 后端没回位 → 不指名道姓，且页面上没有任何编造的 `x:y` 位字符串", () => {
    const e = new ApiErr("forbidden", "无此项目权限", 403);
    render(<PermEmpty error={e} projectName="履约" context="查看某页" />);
    const desc = screen.getByTestId("perm-empty-desc").textContent ?? "";
    expect(desc).toContain("当前账号缺少访问该项的权限");
    // 位名形如 module:action:x——全文不许出现，出现即前端编了位名（假门）
    expect(screen.getByTestId("perm-empty").textContent).not.toMatch(/[A-Za-z_]+:[A-Za-z_*]+/);
  });

  it("③ 复制的申请文案含权限位与项目名；无位时含项目名且不含位", () => {
    expect(permApplyText("ui:case:read", "履约", "查看 UI 用例")).toContain("ui:case:read");
    expect(permApplyText("ui:case:read", "履约")).toContain("履约");
    expect(permApplyText(null, "履约")).not.toMatch(/[A-Za-z_]+:[A-Za-z_*]+/);

    const writeText = vi.fn(async (_t: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const e = new ApiErr("insufficient_permission", "缺少权限：ui:case:read", 403);
    render(<PermEmpty error={e} projectName="履约" context="查看该 UI 用例" />);
    fireEvent.click(screen.getByTestId("perm-empty-copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
    const t = writeText.mock.calls[0][0];
    expect(t).toContain("ui:case:read");
    expect(t).toContain("履约");
  });
});

describe("④ 真实路径落地（至少两条）", () => {
  it("路径①②：直接敲 URL / 列表点进详情撞 403 → 详情路由渲染 PermEmpty（后端 message 原话的位名出现在页面上）", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/ui-cases/c1?")) {
        return { ok: false, status: 403, json: async () => ({
          code: "insufficient_permission", message: "缺少权限：ui:case:read", details: {} }) } as unknown as Response;
      }
      return { ok: false, status: 403, json: async () => ({ code: "forbidden", message: "无此项目权限", details: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;    render(
      <MemoryRouter initialEntries={["/ui/cases/c1"]}>
        <Routes><Route path="/ui/cases/:id" element={<UiCaseDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("perm-empty")).not.toBeNull());
    expect(screen.getByTestId("perm-empty-desc").textContent).toContain("ui:case:read");
    expect(screen.getByTestId("perm-empty-copy")).not.toBeNull();
    // 不再是裸的「用例加载失败」Alert
    expect(screen.queryByTestId("ui-case-detail-missing")).toBeNull();
  });

  it("路径③：环境管理「项目全局配置」Tab 被 403 → Tab 内渲染 PermEmpty（指名的 details.perm 打桩）", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 403,
      json: async () => ({ code: "insufficient_permission", message: "缺少权限",
        details: { perm: "env:config:read" } }),
    }) as unknown as Response) as unknown as typeof fetch;
    render(<GlobalConfig projectId="p1" canManage={false} />);
    await waitFor(() => expect(screen.getByTestId("perm-empty")).not.toBeNull());
    expect(screen.getByTestId("perm-empty-desc").textContent).toContain("env:config:read");
  });
});

// ── 第二十六轮：复制失败的出路必须给得出 ──
// 旧实现的两句话都喊「请手动选择文案」，可 text 只进 clipboard，渲染树里从没画过它——
// 失败时让用户去选一段屏幕上不存在的东西，是做不到的动作。内网 HTTP 部署下
// navigator.clipboard 就是 undefined（CodeEditor.tsx 的部署前提），这条路不是边角。
// 新实现：失败才把申请文案摊成可选中的段落（perm-empty-fallback），话指着它说。
describe("第二十六轮：剪贴板失败把申请文案摊在屏幕上", () => {
  const err403 = new ApiErr("insufficient_permission", "缺少权限：ui:case:read", 403);
  const WANT_MISSING = "当前浏览器不支持剪贴板，申请文案已显示在下方，可选中后自行复制";
  const WANT_REJECT = "复制失败，申请文案已显示在下方，可选中后自行复制";

  it("navigator.clipboard 缺失：摊出块的正文逐字等于申请文案，且是可读段落不是按钮 title", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<PermEmpty error={err403} projectName="履约" context="查看该 UI 用例" />);
    // 没点复制之前不许摊（成功只弹 toast 的既有契约，摊出只属于失败态）
    expect(screen.queryByTestId("perm-empty-fallback")).toBeNull();
    fireEvent.click(screen.getByTestId("perm-empty-copy"));
    expect(await screen.findByText(WANT_MISSING, {}, { timeout: 2000 })).not.toBeNull();
    const block = screen.getByTestId("perm-empty-fallback");
    // 逐字：摊出来的就是本来要进剪贴板的那句（含后端位名与项目名）
    expect(block.textContent).toBe(permApplyText("ui:case:read", "履约", "查看该 UI 用例"));
    // 「可选中」的反证：正文是块级文字节点自身（antd 画成 div），不是 button/title 选不中的载体
    expect(block.tagName).toBe("DIV");
    expect(block.getAttribute("title")).toBeNull();
    expect((block as HTMLElement).style.userSelect).toBe("text");
    expect(block.closest("button")).toBeNull();
  });

  it("writeText reject（用户拒权限）：摊出块出现且文案不再是做不到的「手动选择文案」", async () => {
    const writeText = vi.fn(async (_t: string): Promise<void> => { throw new Error("NotAllowedError"); });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PermEmpty error={err403} projectName="履约" context="查看该 UI 用例" />);
    fireEvent.click(screen.getByTestId("perm-empty-copy"));
    expect(await screen.findByText(WANT_REJECT, {}, { timeout: 2000 })).not.toBeNull();
    expect(document.body.textContent).not.toContain("手动选择文案");
    expect(screen.getByTestId("perm-empty-fallback").textContent)
      .toBe(permApplyText("ui:case:read", "履约", "查看该 UI 用例"));
  });

  it("正向对照：复制成功只弹 toast，页面上不摊文案（既有契约）", async () => {
    const writeText = vi.fn(async (_t: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<PermEmpty error={err403} projectName="履约" context="查看该 UI 用例" />);
    fireEvent.click(screen.getByTestId("perm-empty-copy"));
    expect(await screen.findByText("申请文案已复制，发给项目管理员即可", {}, { timeout: 2000 })).not.toBeNull();
    await waitFor(() => expect(screen.queryByTestId("perm-empty-fallback")).toBeNull());
  });
});
