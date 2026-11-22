// LoginPage 的组件测试：login.tsx 此前零测试 import（audit-test-debt.mjs 榜眼）。
// 钉的是登录页「不能做错的四件事」：
// ① 必填门禁：账号/密码空着点提交 → 各自出校验话术，一次请求都不发（不发就是零副作用）；
// ② 提交形状：真走 auth/store.login → client.post —— POST /api/v1/auth/login，
//    body 逐字 {account, password}（参数换位 = 拿密码当账号提交，别处测不出来）；
// ③ 成功落地：token 进 localStorage（tp_token）、login 响应里的 user 进 useAuth、
//    nav("/", {replace:true}) 恰一次——三样缺一样都是「登录了但没进去/没进去但登录了」；
// ④ 失败面：401 → toast「账号或密码错误」逐字（client 的统一 toast，不是静默 no-op）、
//    留在登录页（不 nav、不改 hash）、绝不触发 /auth/refresh（自循环防线在 client.test.ts，
//    这里只钉登录页这条调用路径没绕过去）。外加 loading 半截态。
// 手法：navSpy 照 adbDevices/ProjectGate（vi.hoisted + importOriginal 局部 mock）；
// fetch 桩照 client.test.ts；认证走真 store + 真 client（ProjectGate.test.tsx:59 口径，
// 不 mock auth/store——mock 了就把本文件要钉的「落到 store」本身也 mock 掉了）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const navSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navSpy,
}));

import LoginPage from "./login";
import { getToken } from "../api/client";
import { useAuth, type UserOut } from "../auth/store";

const USER: UserOut = { id: "u1", account: "zhangsan", name: "张三", email: null,
  is_system_admin: false, status: "active" };

const res = (status: number, body: unknown) => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
});

function renderLogin(): void {
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <LoginPage />
    </ConfigProvider>,
  );
}

/** 填表（testid 直接落在 <input> 上，同 CommandParams.test.tsx:156 的读法）。 */
function fill(account = "zhangsan", password = "pw-1"): void {
  fireEvent.change(screen.getByTestId("login-account") as HTMLInputElement, { target: { value: account } });
  fireEvent.change(screen.getByTestId("login-password") as HTMLInputElement, { target: { value: password } });
}

const bodyOf = (opts: RequestInit | undefined): unknown => JSON.parse(String(opts?.body));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cleanup();
  navSpy.mockReset();
  localStorage.clear();
  useAuth.setState({ user: null, project: null, ready: false });
  fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) => res(200, { token: "tok-1", user: USER }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("必填门禁", () => {
  it("空表提交：两个字段各出校验话术，零请求零导航", async () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("login-submit"));
    expect(await screen.findByText("请输入账号")).toBeTruthy();
    expect(await screen.findByText("请输入密码")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
    expect(getToken()).toBeNull();
  });
});

describe("提交形状与成功落地", () => {
  it("POST /api/v1/auth/login 带逐字 {account,password}；token+user 落进 auth 侧；nav('/',{replace}) 恰一次", async () => {
    renderLogin();
    fill();
    fireEvent.click(screen.getByTestId("login-submit"));
    await waitFor(() => expect(navSpy).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/login");
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit)).toEqual({ account: "zhangsan", password: "pw-1" });
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    // 认证落地的三处：localStorage 的 access token、内存 store 的 user、导航目标
    expect(getToken()).toBe("tok-1");
    expect(useAuth.getState().user).toEqual(USER);
    expect(navSpy.mock.calls[0][0]).toBe("/");
    expect(navSpy.mock.calls[0][1]).toEqual({ replace: true });
  });

  it("请求未落地期间提交钮进 loading（防连点双击提交）", async () => {
    let release: (r: unknown) => void = () => {};
    fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) =>
      new Promise((r) => { release = r; }));
    vi.stubGlobal("fetch", fetchMock);
    renderLogin();
    fill();
    fireEvent.click(screen.getByTestId("login-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("login-submit").className).toContain("ant-btn-loading"));
    expect(navSpy).not.toHaveBeenCalled();
    release(res(200, { token: "tok-2", user: USER }));
    await waitFor(() => expect(navSpy).toHaveBeenCalledTimes(1));
    expect(getToken()).toBe("tok-2");
  });
});

describe("失败面（401）", () => {
  it("toast 后端原话逐字、留在登录页、hash 不动、零 refresh 请求、token 不落盘", async () => {
    const toast = vi.spyOn(message, "error");
    fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) =>
      res(401, { code: "bad_credentials", message: "账号或密码错误", details: {} }));
    vi.stubGlobal("fetch", fetchMock);
    renderLogin();
    fill("zhangsan", "wrong");
    fireEvent.click(screen.getByTestId("login-submit"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("账号或密码错误"));
    expect(navSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("login-heading").textContent).toBe("TestPilot");
    expect(getToken()).toBeNull();
    expect(useAuth.getState().user).toBeNull();
    expect(location.hash).not.toBe("#/login"); // 已在登录页：登录 401 不该再改 hash
    // 登录自身的 401 不触发 refresh 自循环（形状同 client.test.ts，这里是页面侧的第二道）
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("refresh"))).toHaveLength(0);
  });
});

describe("页面骨架", () => {
  it("标题/两个输入位/提交钮/不开放注册声明都在场；密码框是 password 型", () => {
    renderLogin();
    expect(screen.getByTestId("login-heading").textContent).toBe("TestPilot");
    expect((screen.getByTestId("login-account") as HTMLInputElement).type).toBe("text");
    expect((screen.getByTestId("login-password") as HTMLInputElement).type).toBe("password");
    expect((screen.getByTestId("login-account") as HTMLInputElement).autocomplete).toBe("username");
    expect((screen.getByTestId("login-password") as HTMLInputElement).autocomplete).toBe("current-password");
    // antd 给两字按钮插全角空格（「登 录」）：去空白再比，钉的是「按钮上有字且是登录」
    expect((screen.getByTestId("login-submit").textContent ?? "").replace(/\s/g, "")).toBe("登录");
    expect(document.body.textContent).toContain("平台不开放注册");
  });
});
