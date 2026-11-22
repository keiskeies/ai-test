// UI 用例详情页的角色门控测试（一期 DoD 第 3 条 UI 面补洞）。
// 门在 uiCaseDetail.tsx:39-40（ui:case:update / ui:case:debug）与 :208（env:config:* 透传）：
// 文件头 :13 写明口径「无 ui:case:update → 保存/调试/新建/行操作一个都不渲染（隐藏不是禁用）」。
// 三条钉：READONLY 下 [保存]/[调试]/[+ 添加命令] 都不在 DOM、名称框 disabled；
// PROJECT_ADMIN 下都在；换显式 my_perms（update 有 debug 无）只让保存回来——跟位走不跟 role 走。
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

import UiCaseDetailPage from "./uiCaseDetail";
import { useAuth } from "../auth/store";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

const CASE = {
  id: "c1", project_id: "p1", module_id: null, name: "登录用例", priority: "P1",
  enabled: true, steps: [{ id: "u1", type: "open", input: "https://a.example.com" }],
  env_id: null, owner_id: null, project_public: true, status: "normal",
  step_count: 1, last_run_at: null, last_run_status: null, updated_by: null,
  created_at: null, updated_at: null, issues: [],
};

function mockBackend(opts: { envs?: Array<Record<string, unknown>>; caseStatus?: number } = {}) {
  const envs = opts.envs ?? [{ id: "e1", project_id: "p1", name: "测试环境", position: 0,
    config: null }];
  const state = { patched: [] as Record<string, unknown>[] };
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const resp = (json: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => json }) as unknown as Response;
    if (url.startsWith("/api/v1/ui-cases/c1?") && method === "GET") {
      if (opts.caseStatus) {
        const s = opts.caseStatus;
        return resp({ code: s === 404 ? "not_found" : "boom", message: "演示 " + s,
          details: s === 403 ? { perm: "ui:case:read", project_id: "p1" } : null }, s);
      }
      return resp(CASE);
    }
    if (url === "/api/v1/ui-cases/c1" && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.patched.push(body);
      // 像后端一样回显库里改后的值（priority/env_id/steps 都取 body）：
      // 保存后 dirty 收回走的就是这份回包（:142 用它重建 savedJson）
      return resp({ ...CASE, priority: body.priority, env_id: body.env_id ?? null,
        steps: body.steps ?? CASE.steps });
    }
    if (url.includes("/ui-elements?") && method === "GET") {
      return resp({ items: [], next_cursor: null });
    }
    if (url.includes("/envs?") && method === "GET") {
      return resp({ items: envs, next_cursor: null });
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return state;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/ui/cases/c1"]}>
      <Routes>
        <Route path="/ui/cases/:id" element={<UiCaseDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("uiCaseDetail 权限门（update/debug 隐藏不是禁用）", () => {
  it("READONLY：保存/调试/添加命令都不在 DOM，名称框 disabled，环境成只读文案", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("case-name")).not.toBeNull());
    expect(screen.queryByTestId("ui-case-save")).toBeNull();
    expect(screen.queryByTestId("ui-case-debug")).toBeNull();
    expect(screen.queryByTestId("cmd-add")).toBeNull();
    expect((screen.getByTestId("case-name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("环境只读")).not.toBeNull();
  });

  it("PROJECT_ADMIN：保存/调试/添加命令都在，名称框可用", async () => {
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("ui-case-save")).not.toBeNull());
    expect(screen.getByTestId("ui-case-debug")).not.toBeNull();
    expect(screen.getByTestId("cmd-add")).not.toBeNull();
    expect((screen.getByTestId("case-name") as HTMLInputElement).disabled).toBe(false);
  });

  it("换显式 my_perms（ui:case:update 有、debug 无）：保存回来、调试仍不在——跟位走不跟 role 走", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY",
      my_perms: ["ui:case:read", "ui:case:update", "-system:*"] } });
    mockBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("ui-case-save")).not.toBeNull());
    expect(screen.queryByTestId("ui-case-debug")).toBeNull();
    fireEvent.change(screen.getByTestId("case-name"), { target: { value: "登录用例改" } });
    expect((screen.getByTestId("case-name") as HTMLInputElement).value).toBe("登录用例改");
  });

  it("详情失败分三类：403 走权限空页、404 说「已被回收或从未存在」、500 只说没取到", async () => {
    // 旧实现把三种并成一句「不存在、已被回收，或没有读取权限」，而 403 根本走不到那句
    // （上面 :187 的 forbidden 分支先早退）——等于每次 5xx 都替用户喊一遍「你没权限」。
    mockBackend({ caseStatus: 500 });
    renderPage();
    const fail = await screen.findByTestId("ui-case-detail-failed");
    expect(fail.textContent).toContain("这条用例没取到（后端没回「不存在」，也还没到没权限那步）");
    expect(screen.queryByTestId("ui-case-detail-missing")).toBeNull();
    cleanup();
    mockBackend({ caseStatus: 404 });
    renderPage();
    expect((await screen.findByTestId("ui-case-detail-missing")).textContent)
      .toContain("后端回「不存在」：这条 UI 用例已被回收或从未存在");
    expect(screen.queryByTestId("ui-case-detail-failed")).toBeNull();
    cleanup();
    mockBackend({ caseStatus: 403 });
    renderPage();
    expect(await screen.findByTestId("perm-empty")).not.toBeNull();
    expect(screen.queryByTestId("ui-case-detail-missing")).toBeNull();
    expect(screen.queryByTestId("ui-case-detail-failed")).toBeNull();
  });
});

// ── 第二十轮：ui-case-meta / case-priority 把手行为补测（审计轴③）──────────────
// meta 行钉「这一排是什么」：容器形状（Space/wrap/8px 间距/10px 底距）、三件控件的
// 在场与源码序、无 update 权时整排禁编辑而不是摘控件。priority 钉受控回环与 PATCH body。
describe("ui-case-meta / case-priority 把手行为", () => {
  function clickOption(label: string): void {
    const dds = document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
    const dd = dds[dds.length - 1] as HTMLElement;
    const el = Array.from(dd.querySelectorAll(".ant-select-item-option-content"))
      .find((n) => n.textContent === label) as HTMLElement;
    fireEvent.click(el);
  }

  it("case-priority：库里 P1 画 P1（不是 P2 兜底）；改 P0 → PATCH body.priority=P0；保存成功钮文案收回", async () => {
    // 杀什么：:204 摘 value={priority}（受控失联）→ 选择框回落 useState 初值 P2，首断言红；
    // 摘 onChange={setPriority} → 点 P0 后选中值不动，waitFor P0 超时红；
    // :139 body 的 priority 换成写死 → PATCH body 断言红。
    const state = mockBackend();
    renderPage();
    await waitFor(() => expect(
      (screen.getByTestId("case-name") as HTMLInputElement).value).toBe("登录用例"));
    const sel = screen.getByTestId("case-priority");
    expect(sel.tagName).toBe("DIV"); // testid 挂在 rc-select 根（与 adb 侧同款把手）
    // :204 的内联宽逐字钉在这枚节点自己的 style 上（style={{ width: 96 }}）
    expect(sel.style.width).toBe("96px");
    // value={priority} ← :80 setPriority(c.priority)：fixture 是 P1；P2 是 :48 的 useState
    // 兜底值——若回填链断了画的就是 P2。P0/P3 此刻只在收起的下拉里，textContent 判据成立。
    expect(sel.textContent).toContain("P1");
    expect(sel.textContent).not.toContain("P2");
    // 点开：:32 PRIO_OPTIONS 四档原样出，顺序即选项序
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    const optionTexts = () => Array.from(document.querySelectorAll(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option"))
      .map((n) => n.textContent);
    await waitFor(() => expect(optionTexts()).toEqual(["P0", "P1", "P2", "P3"]));
    clickOption("P0");
    // 选中回填 = onChange={setPriority} 写进受控 value（不是「点了个寂寞」）
    await waitFor(() => expect(sel.textContent).toContain("P0"));
    // 改档即脏（dirty :64-67 把 priority 算进去了）：保存钮文案跟手
    expect(screen.getByTestId("ui-case-save").textContent).toContain("有未保存修改");
    fireEvent.click(screen.getByTestId("ui-case-save"));
    await waitFor(() => expect(state.patched.length).toBe(1));
    // :138-141 PATCH /ui-cases/c1 的 body：priority 是改后的 P0，其余字段没被带歪
    expect(state.patched[0]).toMatchObject({
      project_id: "p1", name: "登录用例", priority: "P0", steps_set: true, env_set: true,
    });
    // 双侧之「保存成功后收回」：回包 priority=P0 写回 savedJson（:142）→ dirty 归 false，
    // 文案从「保存（有未保存修改）」收回「保存」——改档/保存两条腿各钉一侧
    await waitFor(() =>
      expect(screen.getByTestId("ui-case-save").textContent).not.toContain("有未保存修改"));
  });

  it("ui-case-meta：名字→优先级→环境三件按源码序同排（Space/wrap/8px 间距/10px 底距）；无 update 权整排禁编辑不是摘控件", async () => {
    // 杀什么：:201 摘 wrap → flexWrap 断言红；size={8} 改成别的数 → rowGap 红；
    // 摘 marginBottom:8 → 底距红；把 EnvSelect 挪出 Space → 源码序红；
    // :206 的 canUpdate 三元换成恒真 → 环境成可编辑下拉（「环境只读」缺席）红。
    mockBackend();
    const { unmount } = renderPage();
    const meta = await waitFor(() => {
      const n = screen.getByTestId("ui-case-meta");
      expect(n.querySelector('[data-testid="case-name"]')).not.toBeNull();
      return n;
    });
    expect(document.querySelectorAll('[data-testid="ui-case-meta"]')).toHaveLength(1);
    expect(meta.tagName).toBe("DIV");
    expect(meta.className).toContain("ant-space");
    // :201 的容器属性：wrap→内联 flexWrap:wrap；size={8}→行列 gap 都是 8px；marginBottom:8
    expect(meta.style.flexWrap).toBe("wrap");
    expect(meta.style.columnGap).toBe("8px");
    expect(meta.style.rowGap).toBe("8px");
    expect(meta.style.marginBottom).toBe("8px");
    // 三件按源码序 name(:202)→priority(:204)→env(:207)，且都在这一排内（挪出/换位即红）
    const kids = ["case-name", "case-priority", "env-select"]
      .map((id) => meta.querySelector(`[data-testid="${id}"]`) as HTMLElement);
    for (const k of kids) expect(k).not.toBeNull();
    for (let i = 1; i < kids.length; i++) {
      expect(kids[i - 1].compareDocumentPosition(kids[i])
        & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    // 环境那件不是幽灵：默认选中的就是 /envs 回包里的第一个（EnvPanel 的 position 排序默认位）
    // /envs 是独立于 case 详情的一只 GET：上面的门只等到 case-name，EnvPanel 要等 envs 落地
    // 才会自动选第一位，在飞时画的是占位符「还没有环境」（EnvPanel.tsx:74-81 vs :91）。
    // 同 scenes.test.tsx:1037-1039 对同一窗口的处理。
    await waitFor(() =>
      expect(meta.querySelector('[data-testid="env-select"]')!.textContent).toContain("测试环境"));
    // 同排右侧的写入口在场（对照腿在下面：无 update 权时它们整块消失）
    expect(meta.querySelector('[data-testid="ui-case-save"]')).not.toBeNull();
    expect(meta.querySelector('[data-testid="ui-case-debug"]')).not.toBeNull();
    // 对照腿（D47「隐藏不是禁用」在 meta 这一排的另一半，与上一条只差 my_perms 一位）：
    // 三件控件照在场但整排禁编辑；环境那件换成「环境只读」文案（三元 :206-211）
    unmount();
    useAuth.setState({ project: READONLY_PROJECT });
    renderPage();
    const roMeta = await waitFor(() => {
      const n = screen.getByTestId("ui-case-meta");
      expect(n.querySelector('[data-testid="case-name"]')).not.toBeNull();
      return n;
    });
    expect((roMeta.querySelector('[data-testid="case-name"]') as HTMLInputElement).disabled).toBe(true);
    expect(roMeta.querySelector('[data-testid="case-priority"]')!.className).toContain("ant-select-disabled");
    expect(roMeta.querySelector('[data-testid="env-select"]')).toBeNull();
    expect(roMeta.textContent).toContain("环境只读");
    expect(roMeta.querySelector('[data-testid="ui-case-save"]')).toBeNull();
    expect(roMeta.querySelector('[data-testid="ui-case-debug"]')).toBeNull();
  });
});

describe("环境下拉在 UI 用例页改口（headersApply={false} 的宿主接线）", () => {
  it("Tooltip 说「UI 运行只取这里的变量」，不承诺公共请求头——摘掉 :209 的 headersApply={false} 这条即红", async () => {
    // EnvPanel.test.tsx 的 ①b 只钉组件两分支本身；本页传不传 headersApply 是另一件事：
    // 摘掉这个 prop，组件仍绿（默认 true 分支有测试），但 UI 页重新对零效果的配置做承诺。
    mockBackend();
    renderPage();
    await screen.findByTestId("env-select");
    const node = screen.getByTestId("env-select");
    fireEvent.mouseOver(node);
    fireEvent.mouseEnter(node);
    const tips = () => Array.from(
      document.querySelectorAll(".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner"),
    ).map((n) => n.textContent).join("|");
    await waitFor(() => {
      expect(tips()).toContain("UI 运行只取这里的变量：UI 执行核没有请求头概念，公共请求头不会注入");
    }, { timeout: 4000 });
    expect(tips()).not.toContain("公共请求头来自这里");
  });
});
