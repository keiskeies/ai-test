// §11.4.13 ElementPicker 此前零覆盖：8 个 testid 全由 testIdBase 拼出（非字面量），覆盖率扫描
// 看不见；CommandParams.test.tsx 只从宿主侧钉过。这里补组件自身：testIdBase 隔离、onPick
// (id, 整行) 三条产路、受控双向、请求面、空态、就地新建。手法照抄同目录 + ListMode.test.tsx。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
import type { ReactElement } from "react";
Object.defineProperty(window, "matchMedia", { writable: true, value: (q: string) => ({
  matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) });
import ElementPicker from "./ElementPicker";
import { RECENT_KEY } from "./recentElements";
import { useAuth } from "../auth/store";
const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };
// 形状 = UiElementOut（schema.d.ts:4201）的必填位；mock 原样回传，toEqual 钉的就是它
const EL = { id: "e1", project_id: "p1", name: "登录按钮", locator_type: "css",
  locator: "#login-btn", project_public: true, status: "normal" };
const EL2 = { ...EL, id: "e2", name: "用户名框", locator: "#uname", locator_type: "id" };
interface Call { url: string; method: string; body?: Record<string, unknown> }
/** GET 回传入参行；POST 造 e9 并追加进行表（建完 load() 重拉才看得见）；其余端点炸出来。 */
function mockNet(items: unknown[] = []): Call[] {
  return mockNetWith({ items });
}
/** 可变体：listFail 让 GET 回给定状态码；cursor 让首页带游标（=还有后页没看）。 */
function mockNetWith(o: { items?: unknown[]; listFail?: number; cursor?: string | null } = {}): Call[] {
  const items = o.items ?? [];
  const calls: Call[] = []; const rows = [...items];
  const resp = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (method === "GET" && url.startsWith("/api/v1/ui-elements?")) {
      if (o.listFail) return resp({ code: "e", message: "拒绝" }, o.listFail);
      return resp({ items: rows, next_cursor: o.cursor ?? null });
    }
    if (method === "POST" && url === "/api/v1/ui-elements") {
      const c = { ...EL, id: "e9", name: body?.name, locator_type: body?.locator_type, locator: body?.locator };
      rows.push(c); return resp(c, 201);
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}
const wrap = (el: ReactElement) => <ConfigProvider theme={{ token: { motion: false } }}>{el}</ConfigProvider>;
function renderPick(props: { value?: string | null; testIdBase?: string } = {}) {
  const onPick = vi.fn();
  render(wrap(<ElementPicker value={props.value} onPick={onPick} testIdBase={props.testIdBase} />)); return onPick;
}
const sel = (id = "-select") => screen.getByTestId("el-pick" + id).closest(".ant-select")!;
const openSel = (id = "-select") => fireEvent.mouseDown(sel(id).querySelector(".ant-select-selector")!);
beforeEach(() => {
  cleanup(); localStorage.clear();
  useAuth.setState({ project: PROJECT, ready: true,
    user: { id: "usr1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" } });
  mockNet();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("① testIdBase 契约（prop 存在的全部理由，此前无人钉）", () => {
  it("双实例各占各号：pk-a/pk-b 各管各的 id 与候选项，el-pick-* 一条都不在", async () => {
    mockNet([EL]);
    render(wrap(<><ElementPicker onPick={vi.fn()} testIdBase="pk-a" /><ElementPicker
      onPick={vi.fn()} testIdBase="pk-b" /></>));
    // getByTestId 命中多条会自己抛 ⇒ base 写死撞号时这条立刻红
    for (const b of ["pk-a", "pk-b"]) expect(screen.getByTestId(b + "-select")).not.toBeNull();
    expect(screen.queryAllByTestId("pk-a-new-toggle")).toHaveLength(1); // 把手也吃 base
    expect(screen.queryByTestId("el-pick-select")).toBeNull();
    fireEvent.mouseDown(screen.getByTestId("pk-b-select").closest(".ant-select")!.querySelector(".ant-select-selector")!);
    expect(await screen.findByTestId("pk-b-option")).not.toBeNull(); // 候选项也吃 base
    expect(screen.queryByTestId("el-pick-option")).toBeNull();
  });
  it("默认 base 的 id 全清单：待机 4 个 + 新建表单 6 个；把手展开即让位给表单", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ id: "e1", name: "登录按钮" }]));
    mockNet([EL]); renderPick();
    // 最近组 = recent ∩ rows：GET 回来前不渲染；没点过的 e2 不在
    await screen.findByTestId("el-pick-recent");
    expect(screen.getByTestId("el-pick-recent-e1")).not.toBeNull();
    expect(screen.queryAllByTestId("el-pick-recent-e2")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("el-pick-new-toggle"));
    for (const id of ["-new-form", "-new-name", "-new-type", "-new-locator", "-new-ok", "-new-cancel"])
      expect(screen.getByTestId("el-pick" + id)).not.toBeNull();
    expect(screen.queryByTestId("el-pick-new-toggle")).toBeNull(); // 两入口并存形态不存在
    expect(screen.queryByTestId("el-pick-select")).not.toBeNull(); // 收起的只是新建
  });
});
describe("② onPick 实参形状（错一个形态其它测试全绿）", () => {
  it("搜索点选：一次 (id, 整行 UiElementOut)，并顶到最近使用第一位", async () => {
    const calls = mockNet([EL]); const onPick = renderPick();
    await waitFor(() => expect(calls).toHaveLength(1));
    openSel();
    fireEvent.change(sel().querySelector("input")!, { target: { value: "登录" } });
    fireEvent.click(await screen.findByText(/登录按钮/)); // 选项文本含类型:表达式，正则子串
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toBe("e1"); // 行对象整个给出去，宿主免去二次查名
    expect(onPick.mock.calls[0][1]).toEqual(EL);
    expect(JSON.parse(String(localStorage.getItem(RECENT_KEY)))).toEqual([{ id: "e1", name: "登录按钮" }]);
  });
  it("最近按钮：已回收条目不显示；value 命中项 primary；点它回传整行且零写请求", async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify([
      { id: "gone", name: "被回收的元素" }, { id: "e1", name: "登录按钮" }]));
    const calls = mockNet([EL, EL2]); const onPick = renderPick({ value: "e1" });
    const btn = await screen.findByTestId("el-pick-recent-e1");
    expect(screen.queryByTestId("el-pick-recent-gone")).toBeNull(); // recent ∩ rows
    expect(btn.className).toContain("ant-btn-primary"); // type = value===r.id ? primary : default
    fireEvent.click(btn);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][1]).toEqual(EL);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});
describe("③ 受控与清空", () => {
  it("父改 value 即换显示（双向受控）；未选 placeholder；占位项点是 no-op；不挂 allowClear ⇒ 无清空入口", async () => {
    mockNet([EL, EL2]); const onPick = vi.fn();
    const tree = (v: string | null) => <ElementPicker value={v} onPick={onPick} />;
    const { rerender } = render(wrap(tree("e1")));
    await waitFor(() => expect(sel().textContent).toContain("登录按钮"));
    expect(sel().querySelector(".ant-select-clear")).toBeNull(); // 没传 allowClear ⇒ 已选后无法清回 null
    rerender(wrap(tree("e2")));
    expect(sel().textContent).toContain("用户名框"); // 父改 value 立刻跟，不是初始值
    expect(sel().textContent).not.toContain("登录按钮");
    rerender(wrap(tree(null)));
    expect(sel().textContent).toContain("搜索并选择元素库元素"); // 未选 = placeholder 非裸 id
    rerender(wrap(tree("zz")));
    expect(sel().textContent).toContain("元素 zz（库中未找到）"); // 占位项：选中项与下拉项各一份
    openSel(); const ph = (await screen.findAllByText(/库中未找到/)).at(-1)!;
    expect(screen.queryAllByTestId("el-pick-option")).toHaveLength(2); // -option 只标库里的行
    fireEvent.click(ph); // rows.find("zz") 落空 ⇒ 静默不发 onPick（宿主显示名与 id 脱钩）
    expect(onPick).toHaveBeenCalledTimes(0);
  });
});
describe("④ 请求面、空态与权限边界", () => {
  it("无项目：disabled + 等待项目上下文… + 零请求；有项目恰好一条 GET（无 q）；空库/不匹配文案分叉", async () => {
    useAuth.setState({ project: null }); const calls = mockNet(); renderPick();
    expect(sel().className).toContain("ant-select-disabled"); // 「等待项目上下文…」
    expect(document.body.textContent).toContain("等待项目上下文…");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0); // pid 缺失的早退真的不发请求
    cleanup(); useAuth.setState({ project: PROJECT });
    mockNet([]); renderPick(); openSel(); // 空库下拉：notFoundContent 空态分支
    expect(await screen.findByText("元素库还是空的，就地新建一个")).not.toBeNull();
    cleanup();
    const calls2 = mockNet([EL]); renderPick();
    await waitFor(() => expect(calls2).toHaveLength(1));
    expect(calls2[0].method).toBe("GET");
    expect(calls2[0].url).toBe("/api/v1/ui-elements?project_id=p1&size=200"); // 搜索是客户端过滤
    openSel(); fireEvent.change(sel().querySelector("input")!, { target: { value: "查无此名" } });
    expect(await screen.findByText("没有匹配的元素")).not.toBeNull();
  });
  it("清单没取到 → 不说「元素库还是空的」，也不给选中值贴「库中未找到」", async () => {
    // 空表 + 失败态：旧实现只剩 rows.length===0 这一条证据，会把一次 500 说成库是空的，
    // 并把已选中的元素标成「库中未找到」（替一次网络故障下结论）。
    mockNetWith({ listFail: 500 });
    renderPick({ value: "e1" });
    openSel();
    expect(await screen.findByText(/元素库没取到（不是库是空的）/)).not.toBeNull();
    expect(screen.queryByText(/元素库还是空的/)).toBeNull();
    expect(screen.queryByText(/库中未找到/)).toBeNull();
  });
  it("403 → 说没权限，不说库空、也不喊「重新打开再拉一次」", async () => {
    mockNetWith({ listFail: 403 });
    renderPick();
    openSel();
    expect(await screen.findByText(/没有读取元素库的权限/)).not.toBeNull();
    expect(screen.queryByText(/元素库还是空的/)).toBeNull();
    expect(screen.queryByText(/没取到/)).toBeNull();
  });
  it("带游标（还有后页）→ 「没有匹配」降级成「前 200 个里没有」", async () => {
    mockNetWith({ items: [EL], cursor: "c200" });
    renderPick();
    openSel();
    await screen.findByTestId("el-pick-option"); // 等首屏清单落地（带游标也算取到）
    fireEvent.change(sel().querySelector("input")!, { target: { value: "查无此名" } });
    expect(await screen.findByText(/前 200 个元素里没有匹配的/)).not.toBeNull();
    expect(screen.queryByText(/^没有匹配的元素$/)).toBeNull();
  });
  it("超管 + 无项目：新建把手照给（canCreate 只看权限），但提交是彻底静默的 no-op", async () => {
    useAuth.setState({ project: null,
      user: { id: "u9", account: "r", name: "超管", email: null, is_system_admin: true, status: "active" } });
    const calls = mockNet(); const warn = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    renderPick();
    fireEvent.click(screen.getByTestId("el-pick-new-toggle"));
    fireEvent.change(screen.getByTestId("el-pick-new-name"), { target: { value: "无项目也想建" } });
    fireEvent.change(screen.getByTestId("el-pick-new-locator"), { target: { value: "#x" } });
    fireEvent.click(screen.getByTestId("el-pick-new-ok"));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0); // submitCreate 的 !pid 早退：不发请求
    expect(warn).toHaveBeenCalledTimes(0); // 也不解释 ⇒ 按钮可达但点了像没点（见 FINDING）
  });
});
describe("⑤ 就地新建：门与 payload", () => {
  it("必填门零 POST；回车提交 POST body 逐字（trim、显式 null）→ 自动选中 + 重拉 + 记最近 + 收起", async () => {
    const calls = mockNet([]);
    const warn = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    const ok = vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    const onPick = renderPick();
    fireEvent.click(screen.getByTestId("el-pick-new-toggle"));
    fireEvent.click(screen.getByTestId("el-pick-new-ok"));
    expect(warn).toHaveBeenCalledWith("元素名必填");
    fireEvent.change(screen.getByTestId("el-pick-new-name"), { target: { value: " 提交按钮 " } });
    fireEvent.click(screen.getByTestId("el-pick-new-ok"));
    expect(warn).toHaveBeenCalledWith("定位表达式必填");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0); // 两条门都纯前端
    fireEvent.change(screen.getByTestId("el-pick-new-locator"), { target: { value: " #submit " } });
    fireEvent.keyDown(screen.getByTestId("el-pick-new-locator"), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/v1/ui-elements");
    expect(post.body).toEqual({ project_id: "p1", name: "提交按钮", locator_type: "css",
      locator: "#submit", module_id: null, comment: null, project_public: true });
    expect(onPick.mock.calls[0][0]).toBe("e9"); // 建完直接选中（e2e ③）
    expect(onPick.mock.calls[0][1]).toMatchObject({ id: "e9", name: "提交按钮" });
    expect(ok).toHaveBeenCalledWith("元素已创建并选中");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2); // 建完 load() 重拉
    expect(JSON.parse(String(localStorage.getItem(RECENT_KEY)))).toEqual([{ id: "e9", name: "提交按钮" }]);
    expect(screen.queryByTestId("el-pick-new-form")).toBeNull();
    expect(await screen.findByTestId("el-pick-recent-e9")).not.toBeNull();
  });
  it("取消：清名称/表达式但**不**重置类型（重开仍是 xpath）；类型词表 5 种逐字（R100/D2）", async () => {
    mockNet([]); renderPick();
    fireEvent.click(screen.getByTestId("el-pick-new-toggle"));
    fireEvent.change(screen.getByTestId("el-pick-new-name"), { target: { value: "半途而废" } });
    openSel("-new-type");
    await screen.findByText("xpath");
    expect(Array.from(document.querySelectorAll(".ant-select-item-option-content"))
      .map((n) => n.textContent)).toEqual(["id", "css", "xpath", "text", "name"]);
    fireEvent.click(screen.getByText("xpath", { selector: ".ant-select-item-option-content" }));
    fireEvent.click(screen.getByTestId("el-pick-new-cancel"));
    expect(screen.queryByTestId("el-pick-new-form")).toBeNull();
    fireEvent.click(screen.getByTestId("el-pick-new-toggle"));
    for (const t of ["-new-name", "-new-locator"])
      expect((screen.getByTestId("el-pick" + t) as HTMLInputElement).value).toBe("");
    expect(sel("-new-type").textContent).toContain("xpath"); // 跨次残留，见 FINDING
  });
});
