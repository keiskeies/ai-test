// CommandPalette（Ctrl+K 全局查找，§11.4.19/R51）组件侧单测。此前 vitest 侧零 import（audit-test-debt.mjs 命中；
// e2e/palette.spec.mjs 走真后端摸 testid 可见性，但「选中哪一行 → 哪个 kind/id 进 gotoPalette → nav 收到什么」
// 的逐行契约没有测试边）。paletteNav.test.ts 已钉死 kind→落点表，这里只钉组件侧：请求 URL（nav_device 当 kind
// 传会 422）、缺可选键形状、行↔落点绑定、↑↓ 环形算术、关闭三通路。手法：ListMode.test.tsx + CaseList.test.tsx
// （fetch 桩）+ ProjectGate.test.tsx:40（useNavigate 换 spy）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
// useNavigate 换 spy（ProjectGate.test.tsx:40 同款 vi.hoisted）：逐字抓 nav 收到的落点。
const navSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navSpy,
}));
import CommandPalette from "./CommandPalette";
import { useAuth } from "../auth/store";
import type { ProjectOut } from "../auth/store";
import type { SearchAssetItem } from "../api/search";
const item = (over: Partial<SearchAssetItem>): SearchAssetItem => ({ id: "x", name: "n", ...over });
/** 八组各一条（键序与 GROUPS 一致；nav_device 是本地项、不进 payload）。 */
const FULL = {
  definitions: [item({ id: "d1", name: "查询订单", method: "GET", path: "/order/{id}" })],
  cases: [item({ id: "c1", name: "已支付订单", definition_id: "d9", definition_name: "创建订单" })],
  scenarios: [item({ id: "s1", name: "下单主链路", priority: "P0" })],
  ui_elements: [item({ id: "e1", name: "提交按钮" })],
  ui_cases: [item({ id: "u1", name: "冒烟UI", priority: "P1" })],
  adb_cases: [item({ id: "k1", name: "ADB冒烟", priority: "P2" })],
  schedules: [item({ id: "t1", name: "夜间回归" })],
  notify_channels: [item({ id: "n1", name: "钉钉渠道" })],
};
/** 出参桩：必填五键恒在场（缺了是渲染崩溃而不是「无匹配」），只让要演的键缺席。 */
function outJson(over: Partial<typeof FULL> = {}): Record<string, unknown> {
  return { definitions: [], cases: [], scenarios: [], ui_elements: [], ui_cases: [], ...over };
}
/** 宿主外壳（shell.tsx:250）同款受控包装：onClose 真的收 open——「选定即关」是组件+宿主的合力契约。 */
function Harness({ open: initial = true }: { open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return <ConfigProvider theme={{ token: { motion: false } }}>
    <CommandPalette open={open} onClose={() => setOpen(false)} />
  </ConfigProvider>;
}
/** 300ms 防抖 + promise 链一次 flush。 */
async function tick(ms = 350): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
function overlay(): HTMLElement { return screen.getByTestId("palette-overlay"); }
const rowsOf = (kind: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="palette-item"][data-kind="${kind}"]`));
const groups = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="palette-group"]'));
async function typeKw(kw: string): Promise<void> {
  fireEvent.change(screen.getByTestId("palette-input"), { target: { value: kw } });
  await tick();
}
function stubFetch(json: unknown, fail = false): void {
  global.fetch = vi.fn(async () => {
    return { ok: !fail, status: fail ? 500 : 200, json: async () => json } as unknown as Response;
  }) as unknown as typeof fetch;
}
beforeEach(() => {
  localStorage.clear();
  navSpy.mockReset();
  useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "OWNER" } as unknown as ProjectOut });
  stubFetch(outJson(FULL));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("CommandPalette（Ctrl+K 浮层）", () => {
  it("open=false 什么都不画；未打字零请求，只给引导文案", () => {
    render(<Harness open={false} />);
    expect(screen.queryByTestId("palette-overlay")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    cleanup();
    render(<Harness />);
    expect(screen.getByTestId("palette-input")).toBeTruthy();
    expect(overlay().textContent).toContain("输入关键词开始搜索");
    // D145 的口径边界：放行只针对**失败态**。空闲态不新增常驻行——引导语已经写了
    // 「搜『设备』可打开设备卡片墙」，再钉一行是把浮层开场变成一张导航卡。
    expect(document.querySelectorAll('[data-testid="palette-item"]')).toHaveLength(0);
  });
  it("打字只发一个请求：GET /api/v1/search-assets?project_id=p1&q=订单，不带 kind（nav_device 当 kind 传会 422）", async () => {
    render(<Harness />);
    await typeKw("  订单  ");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]), "http://x");
    expect(url.pathname).toBe("/api/v1/search-assets");
    expect(url.searchParams.get("project_id")).toBe("p1");
    expect(url.searchParams.get("q")).toBe("订单"); // 发后端前去首尾空白
    expect(url.searchParams.get("kind")).toBeNull();
  });
  it("后端缺 adb_cases/schedules/notify_channels 三键（旧后端混部）：三组画「无匹配」，设备项照挂，不画整页「没有匹配」", async () => {
    stubFetch(outJson({ definitions: FULL.definitions }));
    render(<Harness />);
    await typeKw("订单");
    expect(screen.queryByTestId("palette-empty")).toBeNull(); // 有命中 → 不画空态
    await waitFor(() => expect(rowsOf("definition")).toHaveLength(1));
    for (const g of ["adb_case", "schedule", "notify_channel"]) {
      expect(groups().find((n) => n.getAttribute("data-kind") === g)!.textContent).toContain("无匹配");
    }
    expect(rowsOf("nav_device")).toHaveLength(1);
  });
  it("满结果：组序与 GROUPS 一致（九组）；默认 active 只有第一行", async () => {
    render(<Harness />);
    await typeKw("五");
    await waitFor(() => expect(groups().map((g) => g.getAttribute("data-kind"))).toEqual([
      "definition", "case", "scenario", "ui_element", "ui_case",
      "adb_case", "schedule", "notify_channel", "nav_device",
    ]));
    expect(document.querySelectorAll('[data-testid="palette-item"][data-active="true"]')).toHaveLength(1);
    expect(rowsOf("definition")[0].getAttribute("data-active")).toBe("true");
  });
  it("逐行点选的 (行→落点) 绑定 + 选定即关闭：kind/id 对错行只有这里看得见", async () => {
    render(<Harness />);
    await typeKw("五");
    const checks: Array<[string, string]> = [
      ["definition", "/api?def=d1"], ["case", "/api?def=d9&tab=case"],
      ["scenario", "/scene/s1"], ["ui_element", "/ui/elements?q=e1"],
      ["ui_case", "/ui/cases/u1"], ["adb_case", "/adb/cases/k1"],
      ["schedule", "/schedules?q=t1"], ["notify_channel", "/notify/channels?q=n1"],
      ["nav_device", "/adb/devices"],
    ];
    for (const [kind, to] of checks) {
      await waitFor(() => expect(rowsOf(kind)).toHaveLength(1));
      fireEvent.click(rowsOf(kind)[0]);
      expect(navSpy).toHaveBeenLastCalledWith(to); // pick 剥 "#" 前缀后交给 nav
      expect(screen.queryByTestId("palette-overlay")).toBeNull(); // onClose → 宿主收窗
      cleanup(); // 换新实例模拟宿主重开（onClose 走真 setState）
      render(<Harness />);
      await typeKw("五");
    }
    expect(navSpy).toHaveBeenCalledTimes(9);
  });
  it("↑↓ 环形移动只动 data-active；Enter 开 active 行；Esc 挂 window（不押焦点在输入框）", async () => {
    render(<Harness />);
    await typeKw("五");
    await waitFor(() => expect(document.querySelectorAll('[data-testid="palette-item"]')).toHaveLength(9));
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="palette-item"]'));
    expect(items).toHaveLength(9);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(items[2].getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(items[1].getAttribute("data-active")).toBe("true");
    for (let i = 0; i < 8; i++) fireEvent.keyDown(input, { key: "ArrowDown" }); // 1+8 ≡ 0 (mod 9)
    expect(items[0].getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navSpy).toHaveBeenCalledWith("/api?def=d1");
    expect(screen.queryByTestId("palette-overlay")).toBeNull();
    cleanup();
    render(<Harness />); // Esc 在 window 上：焦点不在输入框（body）也关得掉
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("palette-overlay")).toBeNull();
  });
  it("搜索失败 ≠ 没有匹配：错误画「暂时搜不到」而非空态模板；换词恢复；空白词零请求", async () => {
    let fail = false;
    global.fetch = vi.fn(async () => ({
      ok: !fail, status: fail ? 500 : 200,
      json: async () => outJson({ definitions: FULL.definitions }),
    })) as unknown as typeof fetch;
    render(<Harness />);
    await typeKw("订单");
    expect(screen.queryByTestId("palette-error")).toBeNull();
    fail = true;
    fireEvent.change(screen.getByTestId("palette-input"), { target: { value: "订单啊" } });
    await tick();
    expect((await screen.findByTestId("palette-error")).textContent).toContain("暂时搜不到「订单啊」");
    expect(screen.queryByTestId("palette-empty")).toBeNull(); // 「搜不了」不许演成「没有匹配」
    // D145：搜索挂了只说明「这一路搜索」挂了，设备页读的是另一把位 ⇒ 入口必须留着。
    // 摘掉它就是把浮层做成 D144 那种「失败态没有出口」。
    expect(rowsOf("nav_device")).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="palette-item"][data-kind="definition"]')).toHaveLength(0);
    fail = false; // 失败位不许粘在浮层上：换词即恢复
    await typeKw("订单");
    expect(screen.queryByTestId("palette-error")).toBeNull();
    await waitFor(() => expect(rowsOf("definition")).toHaveLength(1));
    fireEvent.change(screen.getByTestId("palette-input"), { target: { value: "   " } });
    await tick();
    expect(global.fetch).toHaveBeenCalledTimes(3); // 空白词不再打后端
    expect(screen.queryByTestId("palette-empty")).toBeNull(); // out 归零 → 回引导态
    expect(overlay().textContent).toContain("输入关键词开始搜索");
  });
  it("八个搜索组全空、只剩设备本地项 → 画「没有匹配」而不是拿设备项装出结果", async () => {
    stubFetch(outJson());
    render(<Harness />);
    await typeKw("查无此项");
    expect((await screen.findByTestId("palette-empty")).textContent).toContain("没有匹配「查无此项」");
    // 搜索成功且八组全空：设备项仍在（空态下它是最初也是唯一一行），但不许算进「有结果」
    expect(rowsOf("nav_device")).toHaveLength(1);
    for (const g of ["definition", "case", "scenario", "ui_element", "ui_case", "adb_case", "schedule", "notify_channel"]) {
      expect(rowsOf(g), g + " 组不该有行").toHaveLength(0);
    }
  });
  it("幕布本体 mousedown 关窗；窗体内部同样的 mousedown 不误关", () => {
    render(<Harness />);
    fireEvent.mouseDown(overlay().firstElementChild as Element); // 居中的白色窗体
    expect(screen.getByTestId("palette-overlay")).toBeTruthy();
    fireEvent.mouseDown(overlay()); // 幕布本体（e.target === currentTarget）
    expect(screen.queryByTestId("palette-overlay")).toBeNull();
  });
});

// ── 第二十三轮：「搜不了」的三种原因各说各的话 ──
// 原实现只有一个 errored 布尔，403 也被演成「搜索服务没回应，稍后再试」。业主照着这句话
// 反复按 Ctrl+K，而缺的是权限位或成员身份——重试永远不会变成能搜。后端两条 403 来路
// 的 code 不同（core/service.py:209 forbidden / :57 insufficient_permission），
// 所以前端分得出来，也就没有理由不说。
describe("CommandPalette 的三种「搜不了」", () => {
  /** 后端错误信封桩：{code,message,details} + 状态码（client.api 就按这个形状造 ApiErr）。 */
  function stubErr(code: string, status: number): void {
    global.fetch = vi.fn(async () => ({
      ok: false, status,
      json: async () => ({ code, message: "后端原话", details: { perm: "search:read" } }),
    })) as unknown as typeof fetch;
  }

  it("403 insufficient_permission：说「没有全局查找权限」，不喊稍后再试", async () => {
    stubErr("insufficient_permission", 403);
    render(<Harness />);
    await typeKw("订单");
    const box = await screen.findByTestId("palette-error");
    expect(box.textContent).toContain("当前角色在本项目没有全局查找权限");
    expect(box.textContent).toContain("search:read");
    expect(box.textContent).not.toContain("稍后再试"); // 权限问题不许演成临时故障
    expect(screen.queryByTestId("palette-empty")).toBeNull();
  });
  it("403 forbidden（非成员/项目不可用，走 require 之前那条）：说换项目，不说加权限位", async () => {
    stubErr("forbidden", 403);
    render(<Harness />);
    await typeKw("订单");
    const box = await screen.findByTestId("palette-error");
    expect(box.textContent).toContain("已经读不到这个项目的数据");
    expect(box.textContent).not.toContain("search:read"); // 不是缺位，别把业主导向加权限
    expect(box.textContent).not.toContain("稍后再试");
  });
  it("500 才是「稍后再试」：权限两句话不许串台", async () => {
    stubErr("internal_error", 500);
    render(<Harness />);
    await typeKw("订单");
    const box = await screen.findByTestId("palette-error");
    expect(box.textContent).toContain("暂时搜不到「订单」");
    expect(box.textContent).toContain("稍后再试");
    expect(box.textContent).not.toContain("没有全局查找权限");
    // 刚说 Complete 就喊「输入关键词开始搜索」，是同一块浮层里的第二句谎
    expect(overlay().textContent).not.toContain("输入关键词开始搜索");
  });
  it("422（关键词超 100 字被入参模型当面拒）：说「截短一点再搜」，不许演成没回应/稍后再试", async () => {
    // search/services.py:57 `q: Field(min_length=1, max_length=100)`——粘一段日志
    // （≥101 字）拿 422：服务答了并明确拒了，不是「没回应」；喊「稍后再试」指向的
    // 重试同样长度再发一次还是 422，永远走不通。可执行的出口只有一个：截短关键词。
    const long = "订".repeat(101);
    stubErr("validation_error", 422);
    render(<Harness />);
    await typeKw(long);
    const box = await screen.findByTestId("palette-error");
    expect(box.textContent).toContain("搜索关键词太长了（上限 100 字），截短一点再搜");
    expect(box.textContent).not.toContain("没回应"); // 答了并拒了 ≠ 没回应
    expect(box.textContent).not.toContain("稍后再试"); // 原样重试还是 422
    expect(box.textContent).not.toContain("权限"); // 422 与权限无关，不许把 403 的句子掺进来
    expect(box.textContent).toContain("搜不了"); // 超长只回显截断片段，不整段糊屏
    expect(box.textContent).not.toContain(long);
  });
  it("没选项目：明说「搜不了」并给出路，且不假装引导打字（零请求）", async () => {
    useAuth.setState({ project: null });
    render(<Harness />);
    fireEvent.change(screen.getByTestId("palette-input"), { target: { value: "订单" } });
    await tick();
    expect((await screen.findByTestId("palette-no-project")).textContent).toContain("全局查找搜不了");
    expect(overlay().textContent).not.toContain("输入关键词开始搜索"); // 死路不许写成邀请
    expect(global.fetch).not.toHaveBeenCalled(); // 请求根本发不出去
  });
  it("D145·失败态：搜索组与组头没了，设备入口留着（缺位≠设备页也读不到）", async () => {
    stubErr("insufficient_permission", 403);
    render(<Harness />);
    await typeKw("订单");
    await screen.findByTestId("palette-error");
    // 八组一行不许有：那是在失败态上叠一层「每组都查过了、都没有」的普查假话
    expect(document.querySelectorAll('[data-testid="palette-item"]:not([data-kind="nav_device"])')).toHaveLength(0);
    expect(groups().map((g) => g.getAttribute("data-kind"))).toEqual(["nav_device"]);
    // 组头也不许留着「无匹配」×8：同上，只留设备这一组（它确实有一条）
    expect(groups()[0].textContent).toContain("设备");
    expect(rowsOf("nav_device")).toHaveLength(1);
  });
  it("D145·422（关键词超长）：设备入口同样留着——查询根本没执行，牵连不到设备页", async () => {
    stubErr("validation_error", 422);
    render(<Harness />);
    await typeKw("订".repeat(101));
    await screen.findByTestId("palette-error");
    expect(rowsOf("nav_device")).toHaveLength(1);
    expect(groups()).toHaveLength(1);
  });
  it("D145·403 forbidden（整个项目读不到）：设备入口必须撤掉——递入口就是许兑现不了的诺", async () => {
    // 这条是上面两条的反面，也是「一律保留」那种写法的正对照：设备页打的正是这个项目
    // （adbDevices.tsx:272 `project_id: pid`），项目读不到时进去只有 403。
    // 与 :306「没项目时不许喊『输入关键词开始搜索』」同一条尺：死路不许写成邀请。
    stubErr("forbidden", 403);
    render(<Harness />);
    await typeKw("订单");
    await screen.findByTestId("palette-error");
    expect(document.querySelectorAll('[data-testid="palette-item"]')).toHaveLength(0);
    expect(groups()).toHaveLength(0);
  });
  it("D145·失败后行表塌成一行的那一刻 active 归零：否则 Enter 静默失灵", async () => {
    // 满结果 9 行、active=0（definition 那条）。打字改词后失败，行表只剩设备一行；
    // 若不归零，先按 5 次 ↓ 让 active 指到第 6 行，塌成一行后 flat[5] 是 undefined
    // ⇒ Enter 走 `if (flat[active])` 直接什么都不做，键盘通路当场断掉。
    stubFetch(outJson(FULL));
    render(<Harness />);
    await typeKw("订单");
    await waitFor(() => expect(document.querySelectorAll('[data-testid="palette-item"]')).toHaveLength(9));
    for (let i = 0; i < 5; i += 1) {
      fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "ArrowDown" });
    }
    stubErr("internal_error", 500);
    await typeKw("订单啊");
    await screen.findByTestId("palette-error");
    expect(rowsOf("nav_device")[0].getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter" });
    expect(navSpy).toHaveBeenCalledWith("/adb/devices");
  });
  it("失败后清空关键词：错误位跟着归零，不许画「搜不了「」」", async () => {
    stubErr("internal_error", 500);
    render(<Harness />);
    await typeKw("订单");
    await screen.findByTestId("palette-error");
    fireEvent.change(screen.getByTestId("palette-input"), { target: { value: "" } });
    await tick();
    expect(screen.queryByTestId("palette-error")).toBeNull(); // 关键词都没了，「搜不了」是句空话
    expect(overlay().textContent).toContain("输入关键词开始搜索");
  });
  it("打字后 300ms 内删空：不许卡在转圈（防抖被取消，.finally 就不会跑）", async () => {
    // 真缺陷（HEAD 就有）：非空关键词那轮 effect 已 setLoading(true)，删空这轮直接 return，
    // 而上一轮 cleanup 的 clearTimeout 让请求根本没发 → .finally 永不执行 → loading 永远 true。
    // 后果是浮层只剩一个转圈的图标：请求零发、框里没字、没有任何出口，只能关掉重开。
    stubFetch(outJson(FULL));
    render(<Harness />);
    const input = screen.getByTestId("palette-input");
    fireEvent.change(input, { target: { value: "订" } });
    fireEvent.change(input, { target: { value: "" } }); // 防抖窗口内删空
    await tick(800);
    expect(document.querySelectorAll(".ant-spin")).toHaveLength(0);
    expect(overlay().textContent).toContain("输入关键词开始搜索");
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("关掉再开（同一实例）：上一次的「搜不了」与关键词都不许漏进下一次", async () => {
    // 诚实标注：现宿主（shell.tsx:250）每次唤起都 +nonce 当 key 强制重建，所以 :80 的
    // open 重置在生产里是第二道保险，不是唯一通路。本用例钉的是**组件自己的契约**
    // （open false→true 必须归零），用真受控、可再开的宿主把这条契约变成可测的——
    // 否则它就只是一句「反正宿主会重建」的无证承诺，宿主哪天不重建，谁也没红过。
    const toggle = { set: (_: boolean) => {} };
    function Host() {
      const [open, setOpen] = useState(true);
      toggle.set = setOpen;
      return <ConfigProvider theme={{ token: { motion: false } }}>
        <CommandPalette open={open} onClose={() => setOpen(false)} />
      </ConfigProvider>;
    }
    stubErr("insufficient_permission", 403);
    render(<Host />);
    await typeKw("订单");
    await screen.findByTestId("palette-error");
    act(() => toggle.set(false)); // 关：同 Host、同实例
    expect(screen.queryByTestId("palette-overlay")).toBeNull();
    stubFetch(outJson(FULL)); // 恢复供给，才分得出「陈旧错误」与「新结果」谁在屏上
    act(() => toggle.set(true)); // 重开
    expect(await screen.findByTestId("palette-input")).toBeTruthy();
    expect((screen.getByTestId("palette-input") as HTMLInputElement).value).toBe(""); // 关键词归零
    expect(screen.queryByTestId("palette-error")).toBeNull(); // 上次的 403 不许跟过来
    expect(overlay().textContent).toContain("输入关键词开始搜索");
  });
});

// ── 第二十三轮：无权的两组不许说「无匹配」 ──
// 后端对 schedule / notify_channel 用的是「整组开关」而不是 403（search/services.py:200 /
// :217：缺 schedule:task:read / notify:channel:read → 该组返回空数组，注释原话是
// 「一组 403 会把其余七组一起带走」）。前端拿到的空数组与「查过了确实没有」在数据上
// 不可区分，于是组头的「无匹配」就成了对一组根本没查的资产说假话——而它的下一句
// （换个词再试）在这条路上永远走不通。判据用 auth/perms 的同一把尺（与后端
// match_perm 逐语义对齐），不猜。
describe("第二十三轮：缺权限的组说「没有参与搜索」", () => {
  /** 立当前项目的生效权限位（服务端 my_perms 是事实源，前端兜底表只在缺席时用）。 */
  function withPerms(perms: string[] | null | undefined, sysAdmin = false): void {
    useAuth.setState({
      user: { id: "u1", account: "a", name: "n", email: null, is_system_admin: sysAdmin, status: "active" },
      project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "OWNER",
        ...(perms === undefined ? {} : { my_perms: perms }) } as unknown as ProjectOut,
    });
  }
  const groupText = (kind: string) =>
    groups().find((n) => n.getAttribute("data-kind") === kind)!.textContent ?? "";

  it("缺两把位：两组各自说「没有参与搜索」，余下六组仍说无匹配", async () => {
    withPerms(["search:read", "api:def:read"]);
    stubFetch(outJson());
    render(<Harness />);
    await typeKw("订单");
    await screen.findByTestId("palette-empty");
    expect(groupText("schedule")).toContain("本角色缺 schedule:task:read，这一组没有参与搜索");
    expect(groupText("notify_channel")).toContain("本角色缺 notify:channel:read，这一组没有参与搜索");
    expect(groupText("schedule")).not.toContain("无匹配");
    expect(groupText("case")).toContain("无匹配"); // 搜过的组不许被顺嘴改口
  });
  it("整块空态不许把没搜的组算进「都没有」；只有真缺的那一组进注记", async () => {
    withPerms(["search:read", "schedule:task:read"]); // 只缺渠道那把
    stubFetch(outJson());
    render(<Harness />);
    await typeKw("查无此项");
    const empty = await screen.findByTestId("palette-empty");
    expect(empty.textContent).toContain("没有匹配「查无此项」");
    // 注记整段逐字钉：把它写成「把 GROUPS 全列一遍」的过报变异，只有逐字比出来才红。
    const note = (empty.textContent ?? "").slice((empty.textContent ?? "").indexOf("；其中 "));
    expect(note).toBe("；其中 通知渠道 因缺权限没有参与搜索，不算查过");
    expect(groupText("schedule")).toContain("无匹配");
  });
  it("有权限时一个字都不许多说（正向对照，防把「无匹配」整条改掉）", async () => {
    withPerms(["*", "-system:*"]);
    stubFetch(outJson());
    render(<Harness />);
    await typeKw("查无此项");
    const empty = await screen.findByTestId("palette-empty");
    expect(groupText("schedule")).toContain("无匹配");
    expect(groupText("notify_channel")).toContain("无匹配");
    expect(empty.textContent).not.toContain("没参与搜索");
  });
  it("my_perms 缺席（未知角色的无情报兜底）：不猜权限，沿用「无匹配」", async () => {
    withPerms(undefined); // 保留 my_role=OWNER（未知角色）→ patternsForProject 返回 []
    stubFetch(outJson());
    render(<Harness />);
    await typeKw("订单");
    await screen.findByTestId("palette-empty");
    expect(groupText("schedule")).toContain("无匹配");
    expect(groupText("schedule")).not.toContain("没有参与搜索");
  });
  it("READONLY 兜底表：*:read 盖得住两把读位 → 不许出现「没有参与搜索」的假告警", async () => {
    useAuth.setState({
      user: { id: "u1", account: "a", name: "n", email: null, is_system_admin: false, status: "active" },
      project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "READONLY" } as unknown as ProjectOut,
    });
    stubFetch(outJson());
    render(<Harness />);
    await typeKw("订单");
    await screen.findByTestId("palette-empty");
    expect(overlay().textContent).not.toContain("没有参与搜索");
  });
  it("系统管理员：走 is_system_admin 的 *，不许被项目位的空清单带偏", async () => {
    // 这条钉的是**接线**（调色板确实把 is_system_admin 传给了 patternsForProject），
    // 不是在描述线上载荷：后端 perms_for:66 给系统管理员的一律是 {"*"}，
    // 所以「是管理员但 my_perms 不含那两把位」这个形状现实中不出现——
    // 但把 is_system_admin 参数漏掉，只有这个形状能红（其余形状两条分支都说「无匹配」）。
    withPerms(["search:read"], true);
    stubFetch(outJson());
    render(<Harness />);
    await typeKw("订单");
    await screen.findByTestId("palette-empty");
    expect(overlay().textContent).not.toContain("没有参与搜索");
  });
});

// ── 第二十三轮：空闲引导语的名单也要过同一把权限闸 ──
// 组头改了「这一组没有参与搜索」（:190 groupUnsearched）而引导语照旧把八组列成
// 「输入关键词就能搜到」，是同一段浮层里的第二句谎：缺 notify:channel:read 的角色
// 按这句话打字，永远等不到通知渠道那一组。修法只有一条——名单复用同一个判据。
describe("第二十三轮：空闲引导语不许承诺没参与的组", () => {
  function withPerms(perms: string[]): void {
    useAuth.setState({
      user: { id: "u1", account: "a", name: "n", email: null, is_system_admin: false, status: "active" },
      project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "OWNER",
        my_perms: perms } as unknown as ProjectOut,
    });
  }

  it("缺两把位：引导语逐字收回那两个组，并补一句「不会出现在结果里」", async () => {
    withPerms(["search:read", "api:def:read"]);
    render(<Harness />);
    const footer = overlay().textContent ?? "";
    expect(footer).toBe(
      "输入关键词开始搜索——接口定义、用例、场景、元素、UI 用例、ADB 用例，搜「设备」可打开设备卡片墙。"
      + " 定时任务 / 通知渠道 你的角色没有读权限，不会出现在结果里。");
    // 「一路直达」把权限条件说没了，也是旧句最硬的特征串
    expect(footer).not.toContain("一路直达");
    expect(global.fetch).not.toHaveBeenCalled(); // 引导语不该顺手发一次搜索
  });
  it("八组都有位（正向对照）：名单齐、注记一个字都不许多说", async () => {
    withPerms(["*", "-system:*"]);
    render(<Harness />);
    expect(overlay().textContent).toBe(
      "输入关键词开始搜索——接口定义、用例、场景、元素、UI 用例、ADB 用例、定时任务、通知渠道，"
      + "搜「设备」可打开设备卡片墙。");
  });
});

// ── 第二十六轮：输入框 placeholder 也要过同一把权限闸 ──
// placeholder 曾静态列全八类（含「定时任务 / 通知渠道」），而同层浮层下面已承认
// 「你的角色没有读权限，不会出现在结果里」（后端对缺位的组整组返回空，services.py:200/:217）。
// 引导语收了口、placeholder 没跟上，是同一段浮层里的两句相反的话。修法与引导语同一条：
// 名单复用 groupUnsearched 筛后的同一份（searchableLabels）。
describe("第二十六轮：placeholder 不许承诺搜不到的组", () => {
  function withPerms(perms: string[]): void {
    useAuth.setState({
      user: { id: "u1", account: "a", name: "n", email: null, is_system_admin: false, status: "active" },
      project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "OWNER",
        my_perms: perms } as unknown as ProjectOut,
    });
  }
  const placeholder = () => (screen.getByTestId("palette-input") as HTMLInputElement).placeholder;

  it("缺 schedule/notify 读权限的自定义角色：placeholder 不含「定时任务」「通知渠道」，按键说明保留", () => {
    withPerms(["search:read", "api:def:read"]);
    render(<Harness />);
    expect(placeholder()).not.toContain("定时任务");
    expect(placeholder()).not.toContain("通知渠道");
    // 参与搜索的组照常承诺，按键说明（↑↓/Enter/Esc）一个字不丢
    expect(placeholder()).toBe("搜接口定义 / 用例 / 场景 / 元素 / UI 用例 / ADB 用例（↑↓ 选择，Enter 打开，Esc 关闭）");
  });
  it("八组都有位（正向对照）：placeholder 逐类列全八类", () => {
    withPerms(["*", "-system:*"]);
    render(<Harness />);
    expect(placeholder()).toBe(
      "搜接口定义 / 用例 / 场景 / 元素 / UI 用例 / ADB 用例 / 定时任务 / 通知渠道（↑↓ 选择，Enter 打开，Esc 关闭）");
  });
});

// ── 第二十三轮：open 归零必须独立于空关键词那条兜底 ──
// PAL⑪ 那条变异（把 :92 的 setErrKind(null) 摘掉）在 :287 的重开用例里是绿的：
// 重开后关键词是空的，:104 的空关键词分支顺手把错误位清了，两道保险互相遮蔽。
// 要让这道独立可红，得给一个 :104 接不上的形状——**重开时已经没有项目**：
// 那条 effect 第一行 `!project` 就 return，错误位只能靠 open 归零。
// 诚实标注：钉的是组件自己的契约（宿主 shell.tsx:250 每次唤起 +nonce 重建，生产里
// 这是第二道保险），与 :287 那条同手法，不是在描述一条线上必现的载荷。
describe("第二十三轮：重开时归零错误位不押在空关键词兜底上", () => {
  it("搜挂 → 关掉 → 项目没了 → 再开：不许画上一轮的「搜不了」，只许说没项目", async () => {
    const toggle = { set: (_: boolean) => {} };
    function Host() {
      const [open, setOpen] = useState(true);
      toggle.set = setOpen;
      return <ConfigProvider theme={{ token: { motion: false } }}>
        <CommandPalette open={open} onClose={() => setOpen(false)} />
      </ConfigProvider>;
    }
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ code: "internal_error", message: "后端原话" }) })) as unknown as typeof fetch;
    render(<Host />);
    await typeKw("订单");
    await screen.findByTestId("palette-error");
    act(() => toggle.set(false));
    useAuth.setState({ project: null });
    act(() => toggle.set(true));
    expect(screen.queryByTestId("palette-error")).toBeNull();
    expect(screen.getByTestId("palette-no-project")).toBeTruthy();
    // 两块不许同时在场：一边喊「搜不了「订单」」一边说「还没有选定项目」是浮层自己打架。
    // 特征串只能取「搜不了「订单」」——「还没有选定项目，全局查找搜不了」那句本身也含「搜不了」。
    expect(overlay().textContent).not.toContain("搜不了「订单」");
    expect(global.fetch).toHaveBeenCalledTimes(1); // 重开没有偷偷补一发请求
  });
});
