// 1E T5 导出下载触达例（计划门禁「vitest 下载触达例」）。手法同 adbCases.test.tsx：
// fetch 全 mock 到 client 的 fetch 层、useAuth.setState 注项目/权限。
// 只钉导出这一件事（页面其余部分是既有契约，不重测）：
// ① [导出] 按 api:def:read 出现（回收站视图不出现）；
// ② 点击 → POST /api-export → 返回的 OpenAPI3 文档被存成 blob 并触发 <a download> 点击；
// ③ notes 非空时不假装干净（出 warning 口径的 message，不静默吞）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider, Modal, message } from "antd";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import ApiPage from "./api";
import { useAuth } from "../auth/store";
import { ApiErr } from "../api/client";
import { sceneApi } from "../api/scene";
import { STATUSES, TRIGGERS } from "../shared/runVocab";
import type { ApiDef } from "../api/api";
import type { ModNode } from "../api/ModuleTree";

// 一期 DoD 判据第 3 条 UI 面（1E T9 补账）用的行夹具：行内 [删除] 钮要先有行才谈得上。
function def(over: Partial<ApiDef> = {}): ApiDef {
  return {
    id: "d1", project_id: "p1", module_id: null, name: "查询订单", method: "GET",
    path: "/order/{id}", request: null, status: "complete", version: 1,
    owner_id: null, project_public: true, ...over,
  };
}

const DOC = {
  openapi: "3.0.1", info: { title: "TestPilot 接口导出", version: "1.0" },
  servers: [{ url: "https://api.x.test" }],
  paths: { "/order/{id}": { get: { summary: "查询订单" } } },
  components: { schemas: {} },
};

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

/**
 * D47-b 步4b 的**服务端形状**桩：真按 query 参数过滤（module_ids 重复键 / keyword /
 * recycled）、按 current/size 切片、报 total；每次调用现拷一份全新响应体（真 fetch 每次
 * 解析出新的对象图——同引用交两次会把「取数落地把 load 依赖改脏 → 无限回路」的回路
 * 吃成假绿，reports/runs 转换都为这个付过学费）。
 * keyword 的大小写不敏感是**后端 SQL LIKE 的性质**，桩照抄这个契约；测试钉的是
 * 「我们把 keyword 原样送上线」，不是「浏览器替后端做了小写化」。
 * 返回 listUrls/detailUrls：列表与按 id 取回的调用序列，深链与页码的「恰好一次」全靠它数。
 */
function serverMock(rows: ApiDef[], opts: { tree?: ModNode[]; recycled?: ModNode[]; details?: ApiDef[] } = {}) {
  const listUrls: string[] = [];
  const detailUrls: string[] = [];
  const resp = (json: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api-modules")) {
      return resp({ tree: opts.tree ?? [], recycled: opts.recycled ?? [] });
    }
    if (/\/api-definitions\?/.test(url)) {
      listUrls.push(url);
      const q = new URL(url, "http://x").searchParams;
      const size = Number(q.get("size") ?? "50");
      const current = Number(q.get("current") ?? "1");
      const kw = (q.get("keyword") ?? "").toLowerCase();
      const mids = q.getAll("module_ids");
      const wantRecycled = q.get("recycled") === "true";
      const hit = rows.filter((d) => {
        if ((d.status === "recycled") !== wantRecycled) return false;
        if (mids.length && !mids.includes(d.module_id ?? "__none")) return false;
        if (kw && !(d.name.toLowerCase().includes(kw) || d.path.toLowerCase().includes(kw))) return false;
        return true;
      });
      return resp({ items: hit.slice((current - 1) * size, (current - 1) * size + size),
        next_cursor: null, total: hit.length });
    }
    if (/\/api-definitions\/[^/?]/.test(url)) {
      detailUrls.push(url);
      const id = decodeURIComponent(url.split("/api-definitions/")[1].split("?")[0]);
      const one = (opts.details ?? rows).find((d) => d.id === id);
      return one ? resp(one)
        : resp({ code: "not_found", message: "接口不存在", details: null }, 404);
    }
    return resp({ items: [], next_cursor: null, tree: [], recycled: [], scopes: {} });
  }) as unknown as typeof fetch;
  return { listUrls, detailUrls };
}
function lastListQ(h: { listUrls: string[] }): URLSearchParams {
  return new URL(h.listUrls[h.listUrls.length - 1], "http://x").searchParams;
}
/** rc-input 的 Enter 有 keyLockRef：一次 keyDown 后锁住，到 keyUp 才放行——连按两次
 *  keyDown（中间只有 change）第二次会被静默吞掉。提交 Enter 一律按这对来。 */
function pressEnter(el: HTMLElement): void {
  fireEvent.keyDown(el, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(el, { key: "Enter", code: "Enter" });
}

function mockBackend(notes: string[] = []) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api-export")) {
      return { ok: true, status: 200, json: async () => ({ openapi: DOC, exported: 1, notes }) } as unknown as Response;
    }
    // 页面其余拉取一律给空页：导出触达例不重测列表（那是既有契约）
    return { ok: true, status: 200, json: async () => ({
      items: [], next_cursor: null, tree: [], recycled: [], scopes: {},
    }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  cleanup();
  // Modal.confirm 的静态弹窗挂在 body 独立 root 上，cleanup 拆不掉（notifyChannels.test.tsx:122
  // 同款）：不清就把上一条残留的「接口放入回收站？」撞进下一条的 findByRole("dialog") 里，
  // 报「Found multiple elements」。
  Modal.destroyAll();
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
  mockBackend();
  // jsdom 没有 createObjectURL：桩掉并记录 Blob（下载触达的证明点）
  (URL as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
});

describe("接口列表页导出（1E T5）", () => {
  it("点 [导出] → POST /api-export → blob 落盘触发 <a download> 点击", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const btn = await screen.findByTestId("api-export");
    // D47-b 绊线放在**全文件最早挂载列表**的用例上（runs.test.tsx 同法，实测理由）：
    // 「取数落地把自己写的 state 塞回 load 依赖」这种回路，若绊线只在后面的页码块里，
    // 前面每条用例都带着一个不停发请求的后台回路跑完——整文件被拖垮、最后仍由页码块
    // 报红，但红得又慢又难归因。放在最前面 = 回路第一条就红，且只红一条。
    await new Promise((r) => setTimeout(r, 300));
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).filter((u) => u.includes("/api-definitions?"))).toHaveLength(1);
    fireEvent.click(btn);
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    // 打了导出端点、带了 project
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/api-export"))).toBe(true);
    const body = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => String(c[0]).includes("/api-export"))?.[1]?.body as string;
    expect(JSON.parse(body).project_id).toBe("p1");
    // blob 内容就是后端给的 OpenAPI3 文档（可被导入向导吃回的那份，不是截图不是占位）
    const blobArg = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(await blobArg.text()).toContain('"openapi": "3.0.1"');
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("无 api:def:read 权限时 [导出] 不在 DOM（隐藏不是禁用）", async () => {
    // 服务端口径 my_perms 优先于内置角色表（perms.ts:45），所以给一个不含 :read 的显式 perms
    // 就能演「无读权限」——角色填 READONLY 也没用，它那张 `*:read` 表压根不会被查到。
    useAuth.setState({
      user: { id: "u2", account: "b", name: "李四", email: null, is_system_admin: false, status: "active" },
      project: { ...PROJECT, my_role: "READONLY", my_perms: ["api:def:update"] }, ready: true,
    });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("page-api");
    expect(screen.queryByTestId("api-export")).toBeNull();
  });

  it("notes 非空 → 出如实报 message，不静默", async () => {
    const warnSpy = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    mockBackend(["「草稿接口」没有请求（草稿），未导出（如实报）"]);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("api-export"));
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(String(warnSpy.mock.calls[0][0])).toContain("草稿接口");
    warnSpy.mockRestore();
    clickSpy.mockRestore();
  });
});

// ── 行勾选导出（1E T5 补完的另一半）：批量条 [导出选中] 必须把 ids 原样带进请求体 ──
// 钉的是 §13 纪律 1 的假门反例：「勾了 3 条点导出、后端其实没收到 ids 悄悄全量」。
// 摘掉 exportDefs 里的 definition_ids 展开，第一条用例必红。
describe("接口列表行勾选导出（1E T5 补完）", () => {
  function mockRowsBackend(rows: ApiDef[]) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api-export")) {
        return { ok: true, status: 200, json: async () => ({ openapi: DOC, exported: rows.length, notes: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
        ? { items: rows, next_cursor: null }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  function exportBodies(): Record<string, unknown>[] {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("/api-export"))
      .map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
  }
  function rowBoxes(): HTMLElement[] {
    return Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row input[type="checkbox"]'));
  }

  it("勾选 2 行 → [导出选中] 的 definition_ids 恰好是这 2 个 id", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mockRowsBackend([def({ id: "d1" }), def({ id: "d2", name: "创建订单" }), def({ id: "d3", name: "取消订单" })]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    expect((await screen.findAllByTestId("api-row")).length).toBe(3);
    // 未选中：批量条与 [导出选中] 都不在 DOM（不是禁用糊弄，是没有这个入口）
    expect(screen.queryByTestId("api-batch-bar")).toBeNull();
    expect(screen.queryByTestId("api-export-selected")).toBeNull();
    const boxes = rowBoxes();
    expect(boxes.length).toBe(3);
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    expect((await screen.findByTestId("api-batch-bar")).textContent).toContain("已选 2 项");
    fireEvent.click(screen.getByTestId("api-export-selected"));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const bodies = exportBodies();
    expect(bodies.length).toBe(1);
    expect(bodies[0].project_id).toBe("p1");
    // 恰好是那 2 个：既不多半条（全量假门）也不少半条
    expect([...(bodies[0].definition_ids as string[])].sort()).toEqual(["d1", "d3"]);
    clickSpy.mockRestore();
  });

  it("勾选后点顶栏 [全量导出]：请求体仍不带 definition_ids（两入口各管各的口径）", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mockRowsBackend([def({ id: "d1" }), def({ id: "d2", name: "创建订单" })]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    expect((await screen.findAllByTestId("api-row")).length).toBe(2);
    fireEvent.click(rowBoxes()[0]);
    fireEvent.click(screen.getByTestId("api-export")); // 全量按钮：有勾选也不许偷带 ids
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const bodies = exportBodies();
    expect(bodies.length).toBe(1);
    expect("definition_ids" in bodies[0]).toBe(false);
    clickSpy.mockRestore();
  });

  it("未选中：[全量导出] 走后端缺省全量分支（请求体无 definition_ids 键）", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mockRowsBackend([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    expect(screen.queryByTestId("api-export-selected")).toBeNull();
    fireEvent.click(screen.getByTestId("api-export"));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const bodies = exportBodies();
    expect(bodies.length).toBe(1);
    expect("definition_ids" in bodies[0]).toBe(false);
    clickSpy.mockRestore();
  });
});

// ── 一期 DoD 判据第 3 条「UI 面」（1E T9 补账）：本页 × 4 角色的按钮门控 ──────────
// 期望值一律从 perms.ts ROLE_PATTERNS 的字面量推导（不是「页面藏了就断言藏」的同义反复）：
//   PROJECT_ADMIN ["*","-system:*"]            → api:def:{create,read,delete} 全有
//   MEMBER ["*","-*:delete","-*:manage","-system:*"] → create/read 有、delete 被 -*:delete 拒
//   READONLY ["*:read","-system:*"]            → 只有 :read（导出按 read 位！）
// 前三条走 my_perms 缺省 → 前端内置表兜底路（patternsForProject 回落分支）；
// 最后一条证明按钮跟 my_perms 走、不跟写死的 role 字符串走。
describe("接口页角色门控（判据第 3 条 UI 面）", () => {
  function mockRows(items: ApiDef[]) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
        ? { items, next_cursor: null }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("内置表 PROJECT_ADMIN：新建/导入/导出/行内删除全在", async () => {
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "PROJECT_ADMIN" } });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row"); // 行到位才谈得上行内按钮
    expect(screen.getByTestId("api-new")).not.toBeNull();
    expect(screen.getByTestId("api-import")).not.toBeNull();
    expect(screen.getByTestId("api-export")).not.toBeNull();
    expect(screen.getByTestId("api-delete")).not.toBeNull();
  });

  it("内置表 READONLY：新建/导入/删除不在 DOM；导出仍显示（api:def:read 命中 *:read）", async () => {
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "READONLY" } });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    expect(screen.queryByTestId("api-new")).toBeNull();
    expect(screen.queryByTestId("api-import")).toBeNull();
    expect(screen.queryByTestId("api-delete")).toBeNull();
    expect(screen.getByTestId("api-export")).not.toBeNull();
  });

  it("内置表 MEMBER：可新建/导出，但 -*:delete 拒掉行内删除", async () => {
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "MEMBER" } });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    expect(screen.getByTestId("api-new")).not.toBeNull();
    expect(screen.getByTestId("api-export")).not.toBeNull();
    expect(screen.queryByTestId("api-delete")).toBeNull();
  });

  it("按钮跟着 my_perms 走不是 role 字符串：READONLY + 显式 api:def:create → 新建回来", async () => {
    // 服务端 my_perms 优先（perms.ts:45）：显式补一个 create 位，READONLY 角色名下按钮就该出现；
    // 同时不给 delete，行内删除仍旧不在——同一帧里两个方向都钉住。
    useAuth.setState({
      project: { id: "p1", name: "履约", description: null, status: "normal",
        my_role: "READONLY", my_perms: ["*:read", "api:def:create"] },
    });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    expect(screen.getByTestId("api-new")).not.toBeNull();
    expect(screen.queryByTestId("api-delete")).toBeNull();
  });
});

// ── §11.5.1 违例修复一：详情抽屉的 [编辑] 是权限入口，按 api:def:update 隐藏（不是禁用）──
// 断言的是「不在 DOM」：disabled 的钮点不动但仍在骗人，蓝图明文要的是消失。
describe("详情抽屉 [编辑] 的写权限门（§11.5.1）", () => {
  function mockRows(items: ApiDef[]) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
        ? { items, next_cursor: null }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("READONLY（内置表）：详情里 [编辑] 不在 DOM", async () => {
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "READONLY" } });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("api-row"));
    await screen.findByTestId("api-detail-drawer");
    expect(screen.queryByTestId("detail-edit")).toBeNull();
    // 同帧对照：详情本身进得去（只读可见），缺的只是写入口
    expect(screen.getByTestId("detail-tab-def")).not.toBeNull();
  });

  it("有 api:def:update 的角色：[编辑] 在 DOM 且能打开编辑器", async () => {
    // my_perms 显式只给 update：钉的是「门看 api:def:update 这一位」，不是看 role 字符串
    useAuth.setState({
      project: { id: "p1", name: "履约", description: null, status: "normal",
        my_role: "READONLY", my_perms: ["*:read", "api:def:update"] },
    });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("api-row"));
    const btn = await screen.findByTestId("detail-edit");
    expect(btn.getAttribute("disabled")).toBeNull(); // 是渲染出来的钮，不是 disabled 糊弄
    fireEvent.click(btn);
    // 全屏编辑器（width:100%）里能敲名字的输入框出现 = 编辑器真的开了
    expect(await screen.findByTestId("def-name")).not.toBeNull();
  });

  it("保存钮裁决钉死：新建流程里保存是可达的表单控件（渲染且不禁用）", async () => {
    // 只给 api:def:create 一位。此断言把两种回归钉红：把钮改成「canUpdate 才渲染」
    // （新建的人丢保存）或「可达但 disabled」（§11.5.1 禁止的灰钮糊弄）。
    useAuth.setState({
      project: { id: "p1", name: "履约", description: null, status: "normal",
        my_role: "READONLY", my_perms: ["api:def:create"] },
    });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("api-new"));
    const save = await screen.findByTestId("api-save");
    expect(save.getAttribute("disabled")).toBeNull();
  });
});

// ── D69：详情抽屉第三个 Tab「场景引用」（§11.4.3 Tabs [定义][用例(4)][场景引用(2)]）──
// mock 打在 sceneApi.references 上（消费端契约：带 definition_id 的引用查询）；
// 后端 GET /scenario-references 的真实响应只有 items[{scenario_id,scenario_name,step_keys}]
// ——没有「明细隐瞒」字段（该端点自己 require scenario:read，无权是 403 走错误分支），
// 所以这里钉两种必须可区分的空态：items 真空 →「还没有场景引用」；拉失败 → 错误原话+重试。
// 变异钉：① 摘掉 tab 按钮/守卫 → tab 断言红；② 把失败态与真空态渲染成同一种 → 错误态用例红。
describe("接口详情「场景引用」Tab（D69，§11.4.3）", () => {
  function mockRows(items: ApiDef[]) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
        ? { items, next_cursor: null }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  async function openDetail() {
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("api-row"));
    await screen.findByTestId("api-detail-drawer");
  }

  it("tab 存在且能切；切过去才带 definition_id 请求；成功后列出场景与 #/scene/ 链接", async () => {
    const spy = vi.spyOn(sceneApi, "references").mockResolvedValue({
      items: [
        { scenario_id: "s1", scenario_name: "下单主链路", step_keys: ["k1", "k2"] },
        { scenario_id: "s2", scenario_name: "回归集", step_keys: [] },
      ],
    });
    await openDetail();
    // 计数风格与 用例(N) 一致：还没拿到数之前不显示括号
    expect(screen.getByTestId("detail-tab-refs").textContent).toBe("场景引用");
    // 没切 tab 之前不发引用请求（惰性取数，不是开抽屉就全量拉）
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("detail-tab-refs"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ project_id: "p1", definition_id: "d1" });
    // 两条引用都列出来，名字可点（hash 路由 #/scene/:id），命中步骤 key 如实附上
    const refs = await screen.findAllByTestId("detail-ref");
    expect(refs.length).toBe(2);
    expect(refs[0].textContent).toContain("下单主链路");
    expect(refs[0].textContent).toContain("k1、k2");
    expect(refs[0].querySelector("a")?.getAttribute("href")).toBe("#/scene/s1");
    // 拿到数之后 tab 回填计数
    expect(screen.getByTestId("detail-tab-refs").textContent).toBe("场景引用(2)");
    // 「无引用」空态不许混进来
    expect(screen.queryByTestId("detail-refs-empty")).toBeNull();
    spy.mockRestore();
  });

  it("items 真空 → 说「还没有场景引用」并回填 (0)；这不是失败态", async () => {
    const spy = vi.spyOn(sceneApi, "references").mockResolvedValue({ items: [] });
    await openDetail();
    fireEvent.click(screen.getByTestId("detail-tab-refs"));
    const empty = await screen.findByTestId("detail-refs-empty");
    expect(empty.textContent).toContain("还没有场景引用");
    expect(screen.queryByTestId("detail-refs-error")).toBeNull();
    expect(screen.getByTestId("detail-tab-refs").textContent).toBe("场景引用(0)");
    spy.mockRestore();
  });

  it("拉失败（如 403）→ 错误原话 + 重试入口可见，绝不画成「还没有场景引用」", async () => {
    // 「查不到是谁」要说出口：错误态画成空列表就是会让人误删的假安慰（§13 纪律 1）
    const spy = vi.spyOn(sceneApi, "references")
      .mockRejectedValue(new ApiErr("forbidden", "缺少权限：scenario:read", 403));
    await openDetail();
    fireEvent.click(screen.getByTestId("detail-tab-refs"));
    const err = await screen.findByTestId("detail-refs-error");
    expect(err.textContent).toContain("缺少权限：scenario:read");
    expect(screen.queryByTestId("detail-refs-empty")).toBeNull();
    // 失败不回填计数：tab 仍是裸「场景引用」，不装作数过了
    expect(screen.getByTestId("detail-tab-refs").textContent).toBe("场景引用");
    // 重试钮真的再发一次请求（不是死钮）
    expect(spy).toHaveBeenCalledTimes(1);
    fireEvent.click(within(err).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    spy.mockRestore();
  });
});

// ── §11.5.1 违例修复二：只读角色顶部横幅（挂在 ProjectGate，所有项目页共用这一份）──
describe("只读横幅（§11.5.1，经 ApiPage→ProjectGate 渲染）", () => {
  function mockRows(items: ApiDef[]) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
        ? { items, next_cursor: null }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("READONLY：横幅出现，文案点出角色与「只读」", async () => {
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "READONLY" } });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const banner = await screen.findByTestId("readonly-banner");
    expect(banner.textContent).toContain("READONLY");
    expect(banner.textContent).toContain("只读");
  });

  it("PROJECT_ADMIN：横幅不在 DOM", async () => {
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "PROJECT_ADMIN" } });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    expect(screen.queryByTestId("readonly-banner")).toBeNull();
  });

  it("MEMBER：横幅不在 DOM（缺 delete 位不等于只读——单权限位反推会误判的正例）", async () => {
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "MEMBER" } });
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    expect(screen.queryByTestId("readonly-banner")).toBeNull();
  });
});

// ── D86：回收 409「被场景引用」必须摆到用户面前 ────────────────────────────────
// 后端 services._blocked_definition 把引用者、命中步骤、force 出口全拼进了错误体；
// 旧前端 `catch { /* toast */ }` 把这些全丢了。这里钉三件事：
// ① 409 拦截弹窗点名「场景名」+ 步骤 keys（不是只剩一句 toast）；
// ② reason=missing_scenario_read（明细被隐瞒）→ 照实说需要 scenario:read，且 **不给 force**
//    （后端 services.py:243 对 hidden 连 force 一起拦，摆按钮就是假门）；
// ③ 点 force 的第二步：第二个请求 body 里 force === true —— 用 fetch 调用序列断言，不只看 UI。
// 正对照：200 正常删除仍走通（不带 force 键、success 照常、列表刷新）。
describe("接口回收 409「被场景引用」（D86）", () => {
  const SCENARIOS = [
    { scenario_id: "s1", scenario_name: "下单主链路", step_keys: ["k1", "k2"] },
    { scenario_id: "s2", scenario_name: "回归集", step_keys: ["k9"] },
  ];
  // deleteBehavior：blocked=完整明细 409；hidden=明细被隐瞒 409；
  // ok=直接 200；blocked_then_ok=首次 409、force 重试 200（fullCount 决定 count 是否 > 列出条数）
  function mockDelete(deleteBehavior: "blocked" | "hidden" | "ok" | "blocked_then_ok", fullCount = 2) {
    let deleteTried = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/api-definitions/d1/delete")) {
        deleteTried += 1;
        if (deleteBehavior === "ok" || (deleteBehavior === "blocked_then_ok" && deleteTried > 1)) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
        }
        const details = deleteBehavior === "hidden"
          ? { definition_id: "d1", count: 3, scenarios: [], reason: "missing_scenario_read" }
          : { definition_id: "d1", count: fullCount, scenarios: SCENARIOS };
        return { ok: false, status: 409, json: async () => ({
          code: "referenced_by_scenario", message: "该接口的用例被引用，不能回收", details,
        }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions?")
        ? { items: [def()], next_cursor: null }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  function deleteBodies(): Record<string, unknown>[] {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("/api-definitions/d1/delete"))
      .map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
  }
  function listGets(): number {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("/api-definitions?")).length;
  }
  // motion:false —— rc-motion 的 leave 动画在 jsdom 里不完成，destroyOnHidden 的
  // 弹窗关掉后节点会永远留在 DOM，「force 成功后弹窗关掉」这条断言就测不了。
  function renderApiPage() {
    return render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><ApiPage /></MemoryRouter>
      </ConfigProvider>);
  }
  async function confirmRecycle() {
    fireEvent.click(await screen.findByTestId("api-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "放入回收站" }));
  }

  it("409 明细可见：弹窗点名每个引用场景与命中步骤，不是只剩一句 toast", async () => {
    mockDelete("blocked");
    renderApiPage();
    await screen.findByTestId("api-row");
    await confirmRecycle();
    const box = await screen.findByTestId("api-scenario-block");
    expect(box.textContent).toContain("下单主链路");
    expect(box.textContent).toContain("k1、k2");
    expect(box.textContent).toContain("回归集");
    expect(box.textContent).toContain("k9");
    // force 第二步的语义文案（来自后端 message 的口径，不许改）
    expect(box.textContent).toContain("回收不会删除用例");
    expect(box.textContent).toContain("restore 后原样回来");
    // 场景名可点（hash 路由 #/scene/:id），不是死文本
    expect(box.querySelector("a")?.getAttribute("href")).toBe("#/scene/s1");
  });

  it("count 大于列出条数 → 说明「等 N 个场景」（后端只回前 5 条明细）", async () => {
    mockDelete("blocked", 7);
    renderApiPage();
    await screen.findByTestId("api-row");
    await confirmRecycle();
    const box = await screen.findByTestId("api-scenario-block");
    expect(box.textContent).toContain("等 7 个场景");
  });

  it("明细被隐瞒（reason=missing_scenario_read）→ 照实说需要 scenario:read，且不给 force 按钮", async () => {
    mockDelete("hidden");
    renderApiPage();
    await screen.findByTestId("api-row");
    await confirmRecycle();
    const box = await screen.findByTestId("api-scenario-block");
    // 数量照报 + 「明细被隐瞒」说出口，不许退化成「没人引用」
    expect(screen.getByTestId("api-scenario-block-hidden").textContent).toContain("scenario:read");
    expect(box.textContent).toContain("3");
    expect(box.textContent).toContain("未回收场景引用");
    // 后端对 hidden 连 force 一起拦：摆一个按下去仍 409 的按钮是假门，必须压根没有
    expect(screen.queryByTestId("api-scenario-block-force")).toBeNull();
  });

  it("前端半边：无 scenario:read 时哪怕后端回了明细也按 hidden 口径走（notifyChannels 双保险同尺）", async () => {
    // 权限快照可能滞后于服务端：后端按当时的 perms 给了明细，前端这一侧没有
    // scenario:read 仍不许列名字/摆 force（照 notifyChannels.tsx:474 的
    // details_hidden || !maySeeSchedule 双保险口径）。
    useAuth.setState({
      project: { id: "p1", name: "履约", description: null, status: "normal",
        my_role: "READONLY", my_perms: ["api:def:read", "api:def:delete"] },
    });
    mockDelete("blocked");
    renderApiPage();
    await screen.findByTestId("api-row");
    await confirmRecycle();
    await screen.findByTestId("api-scenario-block");
    expect(screen.getByTestId("api-scenario-block-hidden").textContent).toContain("scenario:read");
    // 明细即便到了前端也不列出、更不给 force
    expect(screen.queryByTestId("api-scenario-block-item")).toBeNull();
    expect(screen.queryByTestId("api-scenario-block-force")).toBeNull();
  });

  it("点 [仍要回收] → 第二个请求 body force === true（fetch 调用序列断言）", async () => {
    mockDelete("blocked_then_ok");
    renderApiPage();
    await screen.findByTestId("api-row");
    await confirmRecycle();
    await screen.findByTestId("api-scenario-block");
    fireEvent.click(await screen.findByTestId("api-scenario-block-force"));
    await waitFor(() => expect(deleteBodies().length).toBe(2));
    // 第一步不带 force 键；第二步带 force:true（同一端点、同 project）
    expect("force" in deleteBodies()[0]).toBe(false);
    expect(deleteBodies()[1].force).toBe(true);
    expect(deleteBodies()[1].project_id).toBe("p1");
    // force 成功后弹窗关掉（不是留着让人再点一次）
    await waitFor(() => expect(screen.queryByTestId("api-scenario-block")).toBeNull());
  });

  it("正对照：200 正常删除仍然删成功——body 不带 force、success 照常、列表刷新", async () => {
    const spy = vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    mockDelete("ok");
    renderApiPage();
    await screen.findByTestId("api-row");
    const before = listGets();
    await confirmRecycle();
    await waitFor(() => expect(deleteBodies().length).toBe(1));
    expect(deleteBodies()[0]).toEqual({ project_id: "p1" });
    // 「已发出 delete 请求」≠「响应已回来」：success toast 在响应 resolve 之后才弹，
    // 满载时这里读到空 spy 是真空窗（延迟探针 40ms 下实测红过）——等 toast 本身。
    await waitFor(() => expect(spy.mock.calls.some((c) => String(c[0]).includes("已放入回收站"))).toBe(true));
    expect(screen.queryByTestId("api-scenario-block")).toBeNull();
    await waitFor(() => expect(listGets()).toBeGreaterThan(before));
    spy.mockRestore();
  });
});

// ── D79 可自决半条：列表补「负责人」「更新时间」两列（蓝图 :1376）────────────────
// 名字来自后端 join app_user 的 owner_name（前端拉成员表换名字在权限上是错的）；
// 时间走 shared/timefmt 的东八区换算——这里钉**具体钟点**而不是形状正则（ledger R68：
// 截 ISO/形状正则对「早 8 小时」完全无感，是「绿但错」的形状）。
// 2026-11-15T03:24:05+00:00 → 东八区只能是 11:24（列宽折秒，与 adbCases 同款口径）。
describe("接口列表「负责人 / 更新时间」两列（D79，蓝图 :1376）", () => {
  function mockRows(items: ApiDef[]) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
        ? { items, next_cursor: null }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("表头两列都在，且排在「状态」之后、「最近结果」之前", async () => {
    mockRows([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    const heads = Array.from(document.querySelectorAll(".ant-table-thead th")).map((th) => th.textContent);
    const iOwner = heads.indexOf("负责人");
    const iUpd = heads.indexOf("更新时间");
    expect(iOwner).toBeGreaterThan(-1);
    expect(iUpd).toBeGreaterThan(-1);
    expect(heads.indexOf("状态")).toBeLessThan(iOwner);
    expect(iUpd).toBeLessThan(heads.indexOf("最近结果"));
  });

  it("有负责人 → 画后端回填的名字；owner_id 为 null → 画「—」", async () => {
    mockRows([
      def({ id: "d1", name: "有人管", owner_id: "u-owner-1", owner_name: "王五" }),
      def({ id: "d2", name: "没人管", owner_id: null, owner_name: null }),
    ]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    expect((await screen.findAllByTestId("api-row")).length).toBe(2);
    const cells = await screen.findAllByTestId("api-row-owner");
    expect(cells.map((c) => c.textContent)).toEqual(["王五", "—"]);
  });

  it("owner_id 有值但名字查不到（账号已删）→ 说「已删除 <短id>」，绝不画成「—」", async () => {
    // 查不到人 ≠ 没人负责：画「—」会把悬空负责人伪装成空缺（§13 纪律 1）
    mockRows([def({ owner_id: "u-deleted-0123456789", owner_name: null })]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const cell = await screen.findByTestId("api-row-owner");
    expect(cell.textContent).toBe("已删除 u-delete");
  });

  it("updated_at 画成东八区具体钟点：UTC 03:24:05 → 11:24（不是截断的 03:24）", async () => {
    mockRows([def({ updated_at: "2026-11-15T03:24:05+00:00" })]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const cell = await screen.findByTestId("api-row-updated");
    expect(cell.textContent).toBe("2026-11-15 11:24");
  });

  it("updated_at 缺失 → 画「—」，不画假时刻", async () => {
    mockRows([def({ updated_at: null })]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const cell = await screen.findByTestId("api-row-updated");
    expect(cell.textContent).toBe("—");
  });
});

// ── D80：「最近结果」hover 必须带 时间 + 环境（蓝图 :1376）──────────────────────
// 数据通路：GET /runs?subject_id=&size=1 → Badge{at,env} → Tooltip。后端
// _base_out 确实回填 env_name/created_at（execution/services.py `def _base_out` = 110，
// env_name 在 112、created_at 在 114；⚠ 别引 :103-109 —— 那是 _base_out **上面**一段
// 「执行进程中断」的收尾，行号一漂就点到无关代码，实读二字也就白写了）。
// 钉三件事：① 时间走 fmtTime 的具体钟点（R68：形状正则/截断对早 8 小时无感）；
// ② 缺哪个少哪个——env_name/created_at 为 null 时整段不出现，绝不出现「null」字样；
// ③ 徽标文本本身不变（e2e api.spec.mjs:63/96/107 按 toHaveText("200") 认，只许 hover 变胖）。
describe("最近结果 hover 时间与环境（D80，蓝图 :1376）", () => {
  function mockRun(row: Record<string, unknown> | null) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = url.includes("/runs?")
        ? { items: row ? [row] : [], next_cursor: null }
        : url.includes("/api-definitions")
          ? { items: [def()], next_cursor: null }
          : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} };
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  const runRow = {
    id: "r1", subject_type: "api_definition", subject_id: "d1", subject_name: "查询订单",
    env_name: "测试环境", trigger: "debug", status: "passed", status_code: 200, elapsed_ms: 42,
    error: null, created_at: "2026-11-15T03:24:05+00:00", created_by_name: "张三",
  };

  it("hover = 触发词 · 耗时 · 东八区钟点 · 环境；徽标文本仍是状态码", async () => {
    mockRun(runRow);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const badge = await screen.findByTestId("run-badge");
    // e2e 契约先行：hover 变胖不许动徽标文本（api.spec.mjs:96 toHaveText("200")）
    expect(badge.textContent).toBe("200");
    // antd Tooltip：hover 目标元素后文案进 DOM（rc-trigger 异步渲染，findBy 等）
    fireEvent.mouseEnter(badge);
    const tip = await screen.findByText("✎调试 · 42ms · 2026-11-15 11:24 · 测试环境");
    // UTC 03:24:05 → 东八区只能是 11:24（R68 钉具体钟点，不钉形状）
    expect(tip.textContent).toContain("11:24");
  });

  it("env_name/created_at 为 null（不带环境的调试）→ 整段消失，绝不出现「null」字样", async () => {
    mockRun({ ...runRow, env_name: null, created_at: null });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const badge = await screen.findByTestId("run-badge");
    fireEvent.mouseEnter(badge);
    // 精确整串：多一个「 · null」都会红——「环境：null」与编一个假时刻同罪（§13 纪律 1）
    const tip = await screen.findByText("✎调试 · 42ms");
    expect(tip.textContent).not.toContain("null");
  });
});

// ── 第二十六轮：徽标不许自带触发词/状态副本（api.tsx 私有 TRIGGER_LABEL 的三处漂移）──
// 「最近结果」曾在本文件站点外那份 api.tsx 里手写词表，与权威表 shared/runVocab 漂出
// 三种实测病：agent 本页叫「✦Agent」而 runs 页/后端通知模板（notify/template.py）都叫
// Pilot；死键 case 是当年 422 事故（execution/services.py:34-35 R46：后端 pattern 没有
// case）；T9 的 queued/running/cancelled（services.py:23 六态，enqueue/runner 真写）在此
// 画成英文生码。现徽标改吃 TRIGGERS/STATUSES。断言从**导入的词表对象拼期望**——钉死
// runVocab 里的中文常量是 runVocab.test.ts 的职责，本层只钉「api 页真的吃了它」。
describe("最近结果徽标吃 shared/runVocab（私有触发词表已删）", () => {
  function mockRun(row: Record<string, unknown>) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = url.includes("/runs?")
        ? { items: [row], next_cursor: null }
        : url.includes("/api-definitions")
          ? { items: [def()], next_cursor: null }
          : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} };
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  const base = {
    id: "r1", subject_type: "api_definition", subject_id: "d1", subject_name: "查询订单",
    env_name: null, status_code: 200, elapsed_ms: 42, error: null,
    created_at: null, created_by_name: "张三",
  };

  it("trigger=agent → Tooltip 是 runVocab 的 Pilot 词条，旧副本「✦Agent」绝迹", async () => {
    mockRun({ ...base, trigger: "agent", status: "passed" });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const badge = await screen.findByTestId("run-badge");
    fireEvent.mouseEnter(badge);
    // 期望串由 TRIGGERS.agent 拼出：改词表它自动跟着走；api.tsx 退回私有副本即红。
    const tip = await screen.findByText(TRIGGERS.agent.icon + TRIGGERS.agent.label + " · 42ms");
    expect(tip.textContent).not.toContain("Agent");
  });

  it("trigger=webhook（reserved 只裁筛选项，徽标不裁，口径 runVocab.ts:20-24）→ 照词表画，不降级成 ? 生码", async () => {
    mockRun({ ...base, trigger: "webhook", status: "passed" });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const badge = await screen.findByTestId("run-badge");
    fireEvent.mouseEnter(badge);
    const tip = await screen.findByText(TRIGGERS.webhook.icon + TRIGGERS.webhook.label + " · 42ms");
    // 旧副本没有 webhook 键 → 只能画原文；查 SELECTABLE_TRIGGERS 会降级成 "? webhook"。
    expect(tip.textContent).not.toContain("?");
    expect(tip.textContent).not.toBe("webhook · 42ms");
  });

  it("status=queued + status_code null（enqueue 写的半截态）→ 徽标文本与颜色都取自 STATUSES，不再画生码 queued", async () => {
    mockRun({ ...base, trigger: "debug", status: "queued", status_code: null });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const badge = await screen.findByTestId("run-badge");
    expect(badge.textContent).toBe(STATUSES.queued.label);
    expect(badge.textContent).not.toBe("queued");
    // 颜色同源：旧三元只认 passed/failed，queued 落 default 是巧合，不是吃了词表——
    // 钉 ant-tag-<color> 类名，词表改色这里跟着走。
    expect(badge.className).toContain("ant-tag-" + STATUSES.queued.color);
  });
});

// ── D81（[保存为用例] 半条）：详情-定义 Tab 响应面板旁的用例创建入口（蓝图 :1379）──
// 前提逐条对上：dbg != null 才出现（没跑过调试就没有可存的请求，摆死按钮是假门）；
// 无 api:case:create 不渲染（D47 隐藏派）。payload 口径钉 CaseList.save() 新建分支
// 的覆盖层语义：request=null（全继承）、assertions=[]（追加断言真 0 条，
// 「没校验」不许画成「全过」）、dataset_id=null（调试没有数据集概念）。
// 成功后：POST /api-cases 一次 → 自动切「用例」Tab → CaseList 拉列表 → Tab 文案回填 (1)。
describe("详情-定义 Tab [保存为用例]（D81，蓝图 :1379）", () => {
  const DBG = {
    run_id: "r9", ok: true, passed: true, status: 200, headers: {}, body_text: "{}",
    truncated: false, body_size: 2, elapsed_ms: 15, error: null, assertions: [], env_name: null,
  };
  // caseRows：/api-cases GET 返回的行（创建成功后切 Tab 时第二次 GET 给 1 行，
  // 模拟「后端真的多了一条」——Tab 计数从 CaseList.onCount 来，不是前端自加）。
  function mockDetail(caseRows: Array<Record<string, unknown>> = [], defOver: Partial<ApiDef> = {}) {
    let createTried = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api-cases") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ items: createTried ? caseRows : [], next_cursor: null }) } as unknown as Response;
      }
      if (url.includes("/api-cases") && method === "POST") {
        createTried += 1;
        return { ok: true, status: 200, json: async () => ({ id: "c-new" }) } as unknown as Response;
      }
      if (url.includes("/api-debug")) {
        return { ok: true, status: 200, json: async () => DBG } as unknown as Response;
      }
      if (url.includes("/api-definitions")) {
        return { ok: true, status: 200, json: async () => ({ items: [def(defOver)], next_cursor: null }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => (
        { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("/api-cases") && String(c[1]?.method ?? "") === "POST")
      .map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
  }
  async function openDetailAndDebug() {
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("api-row"));
    await screen.findByTestId("api-detail-drawer");
  }

  it("调试前钮不在 DOM；调试后出现；点钮弹预填定义名的 Modal", async () => {
    mockDetail();
    await openDetailAndDebug();
    // 没跑过调试：入口压根不存在（不是 disabled 糊弄）
    expect(screen.queryByTestId("detail-save-case")).toBeNull();
    fireEvent.click(screen.getByTestId("detail-run"));
    const btn = await screen.findByTestId("detail-save-case");
    fireEvent.click(btn);
    const input = await screen.findByTestId("save-case-name");
    // 预填定义名（name 必填 min_length=1，给用户改，不是静默生成）
    expect((input as HTMLInputElement).value).toBe("查询订单");
  });

  it("改名创建 → POST /api-cases 的 body 是全继承口径；自动切用例 Tab 且计数回填 (1)", async () => {
    const caseBodies = mockDetail([{
      id: "c-new", project_id: "p1", definition_id: "d1", name: "已支付订单", priority: "P2",
      request: null, assertions: [], dataset_id: null, sort: 0, status: "normal",
      effective_request: { method: "GET", url: "/order/1" },
    }]);
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    const input = await screen.findByTestId("save-case-name");
    fireEvent.change(input, { target: { value: "已支付订单" } });
    fireEvent.click(screen.getByTestId("detail-save-case-ok"));
    await waitFor(() => expect(caseBodies().length).toBe(1));
    const body = caseBodies()[0];
    expect(body).toEqual({
      project_id: "p1", definition_id: "d1", name: "已支付订单", priority: "P2",
      request: null, assertions: [], dataset_id: null,
    });
    // 当场可见：不用手动刷新就落在「用例」Tab，行来自后端 GET，计数来自 CaseList.onCount
    await screen.findByTestId("case-row");
    await waitFor(() => expect(screen.getByTestId("detail-tab-case").textContent).toContain("用例(1)"));
    // 弹窗关掉（不是留着让人再点一次造重复）
    expect(screen.queryByTestId("save-case-modal")).toBeNull();
  });

  it("弹窗文案按接口自带断言数说话：有断言就不许说「未校验」", async () => {
    // 后端把用例断言**追加**在接口断言之后一起判（case_services.py:37-41），不是替换。
    // 所以「追加 0 条」在接口自带断言的场合绝不等于「未校验」——
    // 那是一句假门话（§13 纪律 1），必须按实际条数报。
    mockDetail([], {
      request: { method: "GET", url: "/order/{id}",
        assertions: [{ type: "status", expected: 200 }, { type: "json_path", path: "$.id", expected: "1" }] },
    });
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    const modal = await screen.findByTestId("save-case-modal");
    expect(modal.textContent).toContain("接口自带 2 条");
    expect(modal.textContent).toContain("= 2 条");
    expect(modal.textContent).not.toContain("未校验");
  });

  it("接口无自带断言时才说「未校验」——这条是上一条的正对照", async () => {
    mockDetail(); // def() 的 request 是 null → 接口 0 条断言
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    const modal = await screen.findByTestId("save-case-modal");
    expect(modal.textContent).toContain("未校验");
    expect(modal.textContent).not.toContain("接口自带");
  });

  // ── D132：「保存为用例」弹窗报的断言条数不剔未启用，而引擎一条都不判 ──
  // 后端 shared/assertions.py:158 对 `enabled is False` 的行 continue——不执行、不产结果行
  // （D78 反假绿语义，test_assertions.py 钉死）。编辑器里 `-assert-enabled-` 开关关掉一行，
  // 它就真不判；弹窗若仍按总行数说「判 N 条」，文案承诺就兑现不了（§13 文案承诺→兑现）。

  it("D132 混合态：关掉一条后「判几条」必须只数启用的，未启用单独点名", async () => {
    mockDetail([], {
      request: { method: "GET", url: "/order/{id}", assertions: [
        { type: "status_code", expected: 200, enabled: true },
        { type: "json_path_equals", path: "$.id", expected: "1", enabled: false },
      ] },
    });
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    const modal = await screen.findByTestId("save-case-modal");
    // 旧口径 filter((a)=>a.type) 会数成 2 →「自带 2 条 / = 2 条」。引擎实际只判 1 条，
    // 弹窗必须报 1：只数 enabled !== false 的行。
    expect(modal.textContent).toContain("启用 1 条");
    expect(modal.textContent).toContain("= 1 条");
    expect(modal.textContent).not.toContain("自带 2 条");
    expect(modal.textContent).not.toContain("= 2 条");
    // 未启用的 1 条不许静默吞掉：必须点名「不执行也不判」，否则用户以为它还在兜底。
    expect(modal.textContent).toContain("另有 1 条未启用，引擎不执行也不判");
  });

  it("D132 全关态：接口全是停用断言 = 0 条被引擎判，必须说「未校验」而不是「判 N 条」", async () => {
    mockDetail([], {
      request: { method: "GET", url: "/order/{id}", assertions: [
        { type: "status_code", expected: 200, enabled: false },
        { type: "body_contains", expected: "ok", enabled: false },
      ] },
    });
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    const modal = await screen.findByTestId("save-case-modal");
    // 旧口径 defAssertCount=2 → 走「自带 2 条」分支，且 not「未校验」——两头都反了。
    // 引擎逐行 continue，一条都不产结果行，调试面板画「未校验」，弹窗必须同一句话。
    expect(modal.textContent).toContain("启用 0 条");
    expect(modal.textContent).toContain("另有 2 条未启用，引擎不执行也不判");
    expect(modal.textContent).toContain("未校验");
    expect(modal.textContent).not.toContain("自带 2 条");
    expect(modal.textContent).not.toContain("= 2 条");
  });

  it("D132 无停用行时口径不变——老文案「接口自带 N 条」仍在（防把混合态改成唯一态）", async () => {
    mockDetail([], {
      request: { method: "GET", url: "/order/{id}", assertions: [
        { type: "status_code", expected: 200 },
        { type: "json_path_equals", path: "$.id", expected: "1", enabled: true },
      ] },
    });
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    const modal = await screen.findByTestId("save-case-modal");
    // 缺键 = 启用（D78），enabled: true 也是启用 → 都计入「自带 2 条」，且不得出现停用句式。
    expect(modal.textContent).toContain("接口自带 2 条");
    expect(modal.textContent).not.toContain("未启用");
  });

  it("名字清空 → 不发请求，出「用例名不能为空」", async () => {
    const caseBodies = mockDetail();
    const warnSpy = vi.spyOn(message, "warning").mockImplementation(() => ({}) as never);
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    fireEvent.change(await screen.findByTestId("save-case-name"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("detail-save-case-ok"));
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("用例名不能为空"))).toBe(true);
    expect(caseBodies().length).toBe(0);
    warnSpy.mockRestore();
  });

  it("4xx 诚实路径：后端原话进 toast，弹窗不关（可改名重试）", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api-cases") && method === "POST") {
        return { ok: false, status: 422, json: async () => ({
          code: "validation_error", message: "用例名重复", details: {} }) } as unknown as Response;
      }
      if (url.includes("/api-debug")) {
        return { ok: true, status: 200, json: async () => DBG } as unknown as Response;
      }
      if (url.includes("/api-definitions")) {
        return { ok: true, status: 200, json: async () => ({ items: [def()], next_cursor: null }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => (
        { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const errSpy = vi.spyOn(message, "error").mockImplementation(() => ({}) as never);
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    fireEvent.click(await screen.findByTestId("detail-save-case"));
    fireEvent.click(await screen.findByTestId("detail-save-case-ok"));
    // client.ts 非 silent 请求自己 toast 后端信封 message（ApiErr.message），这里钉原话到了屏
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith("用例名重复"));
    // 弹窗保持打开：失败不许把用户的名字一起吞掉
    expect(screen.queryByTestId("save-case-modal")).not.toBeNull();
    errSpy.mockRestore();
  });

  it("有 api:debug:run 无 api:case:create：调试成功后入口仍不在 DOM（门独立于调试位，隐藏不是禁用）", async () => {
    // 显式 perms 单独钉这一位：给足 api:debug:run（dbg 会真落成非 null，
    // 「调试过才有钮」这一半闸门已满足），只缺 api:case:create——
    // 若把 canCreateCase 从渲染条件里摘掉，这条必红。
    useAuth.setState({
      project: { id: "p1", name: "履约", description: null, status: "normal",
        my_role: "READONLY", my_perms: ["*:read", "api:debug:run"] },
    });
    mockDetail();
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    // dbg 确实落成了非 null（调试面板换成有结果的样子）——闸门的另一半已经过了
    await screen.findByText("15 ms");
    expect(screen.queryByTestId("detail-save-case")).toBeNull();
    // 同帧对照：定义 Tab 进得去（只读可见），缺的只是写入口
    expect(screen.getByTestId("detail-def")).not.toBeNull();
  });

  it("有 api:case:create 无 api:def:update：入口照常出现（门看 case:create 位，不看角色串）", async () => {
    useAuth.setState({
      project: { id: "p1", name: "履约", description: null, status: "normal",
        my_role: "READONLY", my_perms: ["*:read", "api:debug:run", "api:case:create"] },
    });
    mockDetail();
    await openDetailAndDebug();
    fireEvent.click(screen.getByTestId("detail-run"));
    expect(await screen.findByTestId("detail-save-case")).not.toBeNull();
    // 同帧反向对照：没有 api:def:update，[编辑] 依旧不在
    expect(screen.queryByTestId("detail-edit")).toBeNull();
  });
});

// ── 第十八轮 D：api.tsx 七个零引用把手补测（审计轴③）───────────────────────────
// 每个把手都钉「行为」而不是「在 DOM」：删除/反转那行 production 代码必须有断言变红。
// 夹具按「错 fixture 陷阱」反推设计：搜索词/用例数按行 id 区分（错误分支给不同可见值），
// 同一 it 里多次 render 之间一律 cleanup()（getByTestId 撞双节点）。
describe("把手行为补测（api-search / api-project / api-clear-selection / def-module / def-public / detail-delete / detail-cases）", () => {
  function node(id: string, name: string, children: ModNode[] = []): ModNode {
    return { id, parent_id: null, name, sort: 0, status: "normal", count: 0, children };
  }
  // 一套全端点 mock：tree 喂模块树与 def-module 选项；cases 只挂在 d5 上
  // （按 URL 里的 definition_id 区分——若 mock 对任何 definition_id 都回同一份，
  // 「请求带错 id」与「Tab 计数写死」都能绿，就是 wrong-fixture 陷阱）。
  function mockFull(opts: {
    items?: ApiDef[]; tree?: ModNode[]; cases?: Array<Record<string, unknown>>;
  }) {
    const { items = [], tree = [], cases = [] } = opts;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = url.includes("/api-modules")
        ? { tree, recycled: [] }
        : url.includes("/api-cases")
          ? { items: url.includes("definition_id=d5") ? cases : [], next_cursor: null }
          : url.includes("/api-definitions")
            ? { items, next_cursor: null }
            : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} };
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  function callsTo(part: string): string[] {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).filter((u) => u.includes(part));
  }
  function postBodiesTo(part: string): Record<string, unknown>[] {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes(part) && String(c[1]?.method ?? "").toUpperCase() === "POST")
      .map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
  }
  function rowBoxes(): HTMLElement[] {
    return Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row input[type="checkbox"]'));
  }
  function rowLinks(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".ant-table-tbody .ant-table-row")).map(
      (tr) => tr.querySelector('[data-testid="api-row"]') as HTMLElement);
  }
  // rc-select 的选项渲染在 body 末尾的浮层里；同页可能残留上一个已关的浮层，取最后一个
  function lastDropdown(): HTMLElement {
    const dds = Array.from(document.querySelectorAll(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden)"));
    return dds[dds.length - 1] as HTMLElement;
  }
  function optionContents(): (string | null)[] {
    return Array.from(lastDropdown().querySelectorAll(".ant-select-item-option-content"))
      .map((n) => n.textContent);
  }
  function clickOption(label: string): void {
    const el = Array.from(lastDropdown().querySelectorAll(".ant-select-item-option-content"))
      .find((n) => n.textContent === label) as HTMLElement;
    fireEvent.click(el);
  }

  it("api-search：打字零请求，Enter/放大镜/清空各提交恰好一条 keyword= 请求；「共 N 条」只跟服务端 total", async () => {
    // D47-b 步4b 契约（替换旧的「本地小写化子串过滤」）：本页不再在浏览器里过滤，
    // 大小写不敏感是后端 SQL LIKE 的性质（桩照抄该契约）。这里钉三件事：
    // ① 打字只动输入框，一条请求都不发；② 提交（Enter/放大镜/清空）各恰好一条请求，
    // keyword 原样（trim 后）上线；③ 「共 N 条」来自服务端 total，不是屏上行数现攒。
    const h = serverMock([
      def({ id: "d1", name: "查询订单", path: "/order/{id}" }),
      def({ id: "d2", name: "创建支付单", path: "/pay/create" }),
      def({ id: "d3", name: "退款查询 REFUND", path: "/refund/query" }),
    ]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    expect((await screen.findAllByTestId("api-row")).length).toBe(3);
    const search = screen.getByTestId("api-search");
    // 把手是 type=search 的输入框本体（data-testid 挂在 Input.Search 上穿透到 input）
    expect(search.tagName).toBe("INPUT");
    expect(search.getAttribute("placeholder")).toBe("搜索接口名或路径");
    expect(search.closest(".ant-input-search")).not.toBeNull();
    const base = h.listUrls.length;
    // ① 打字 = 零请求（这是与服务端契约最硬的一条腿：打字若仍本地过滤，行集当场就红）
    fireEvent.change(search, { target: { value: " 查询 " } });
    await new Promise((r) => setTimeout(r, 120));
    expect(h.listUrls.length).toBe(base);
    expect(screen.getAllByTestId("api-row")).toHaveLength(3); // 行集纹丝不动
    // ② Enter 提交恰好一条，keyword 带着原样（trim 掉两端空白）上线
    pressEnter(search);
    await waitFor(() => expect(h.listUrls.length).toBe(base + 1));
    expect(lastListQ(h).get("keyword")).toBe("查询");
    expect(lastListQ(h).get("current")).toBe("1");
    await waitFor(() => expect(screen.getAllByTestId("api-row")).toHaveLength(2));
    // 「共 2 条」出自 total；旧的游标脚注「后面还有没取的」随页码模式一起退役
    expect(screen.getByTestId("list-pager").textContent).toContain("共 2 条");
    expect(document.body.textContent).not.toContain("后面还有没取的");
    // 大写路径词提交：浏览器不再小写化，但 keyword 照原样上线（大小写是后端的事）
    fireEvent.change(search, { target: { value: "/PAY/" } });
    const at = h.listUrls.length;
    pressEnter(search);
    await waitFor(() => expect(h.listUrls.length).toBe(at + 1));
    expect(lastListQ(h).get("keyword")).toBe("/PAY/");
    await waitFor(() => expect(screen.getAllByTestId("api-row")).toHaveLength(1));
    // ③ 放大镜钮 = 另一个提交口。词换成大写 REFUND（**新值才必然触发请求**——提交同值会被
    // React 合并，那是「筛选没变」的正确行为，不是提交口失灵）。大写原样上线：
    // 浏览器不再小写化，大小写不敏感是后端 SQL LIKE 的性质。
    fireEvent.change(search, { target: { value: "REFUND" } });
    const icon = (search.closest(".ant-input-search") as HTMLElement)
      .querySelector(".ant-input-search-button") as HTMLElement;
    const at2 = h.listUrls.length;
    fireEvent.click(icon);
    await waitFor(() => expect(h.listUrls.length).toBe(at2 + 1));
    expect(lastListQ(h).get("keyword")).toBe("REFUND");
    await waitFor(() => expect(screen.getAllByTestId("api-row")).toHaveLength(1));
    // ④ allowClear 清空也是提交口：一条不带 keyword 的请求，全量 + 「共 3 条」回来
    const at3 = h.listUrls.length;
    const wrap = search.closest(".ant-input-affix-wrapper") as HTMLElement;
    const clearIcon = wrap.querySelector(".ant-input-clear-icon");
    expect(clearIcon).not.toBeNull();
    fireEvent.click(clearIcon!);
    await waitFor(() => expect((search as HTMLInputElement).value).toBe(""));
    await waitFor(() => expect(h.listUrls.length).toBe(at3 + 1));
    expect(lastListQ(h).has("keyword")).toBe(false);
    await waitFor(() => expect(screen.getAllByTestId("api-row")).toHaveLength(3));
    expect(screen.getByTestId("list-pager").textContent).toContain("共 3 条");
    // ⑤ 纯空白提交 = 提交「不过滤」：生效关键词本来就是空，kw 同值合并 → 零新请求、
    // 永不上线 keyword（若空白被当成关键词拼进参数，这里的「has=false」与上一条一起兜住）
    fireEvent.change(search, { target: { value: "   " } });
    const at5 = h.listUrls.length;
    pressEnter(search);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.listUrls.length).toBe(at5);
    expect(lastListQ(h).has("keyword")).toBe(false);
  });

  it("api-project：顶栏 Tag 画当前项目名且挂「当前项目：<名>」Tooltip；换项目当场跟着变；无项目时不在 DOM", async () => {
    mockFull({ items: [def()] });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    const tag = screen.getByTestId("api-project");
    expect(tag.textContent).toBe("履约");
    fireEvent.mouseEnter(tag);
    await screen.findByText("当前项目：履约");
    // 换项目：Tag 文本是 {project.name} 活值，不是写死/不是别的字段
    cleanup();
    useAuth.setState({ project: { ...PROJECT, name: "履约二期" } });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("page-api");
    expect(screen.getByTestId("api-project").textContent).toBe("履约二期");
    // project 为 null：PageHead 走 `: null` 分支，Tag 压根不在（工作台壳之外没有幽灵项目名）
    cleanup();
    useAuth.setState({ project: null });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("no-project");
    expect(screen.queryByTestId("api-project")).toBeNull();
  });

  it("api-clear-selection：点「取消选择」批量条整体消失、行复选框归零；再勾还能回来（不是点坏页面）", async () => {
    mockFull({ items: [def({ id: "d1" }), def({ id: "d2", name: "创建订单" }), def({ id: "d3", name: "取消订单" })] });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    fireEvent.click(rowBoxes()[0]);
    fireEvent.click(rowBoxes()[2]);
    expect((await screen.findByTestId("api-batch-bar")).textContent).toContain("已选 2 项");
    const clear = screen.getByTestId("api-clear-selection");
    expect(clear.textContent).toBe("取消选择");
    fireEvent.click(clear);
    // 整条批量条消失（不是「已选 0 项」空转）：计数、[导出选中]、本钮一起没
    await waitFor(() => expect(screen.queryByTestId("api-batch-bar")).toBeNull());
    expect(screen.queryByTestId("api-clear-selection")).toBeNull();
    expect(screen.queryByTestId("api-export-selected")).toBeNull();
    // selected 状态真的清空（rowSelection 受控回填），不是只把条藏了
    expect(rowBoxes().map((b) => (b as HTMLInputElement).checked)).toEqual([false, false, false]);
    // 正对照：清空不是把勾选功能点坏——再勾 1 条，批量条与 [导出选中] 复原
    fireEvent.click(rowBoxes()[1]);
    await screen.findByTestId("api-batch-bar");
    expect(screen.getByTestId("api-export-selected")).not.toBeNull();
  });

  it("def-module：选项 = flatten(tree)（子模块缩进在内）；选中后随 [保存] 以 module_id 进 POST body", async () => {
    mockFull({ tree: [node("m-a", "订单域"), node("m-b", "结算域"), node("m-c", "对账", [node("m-c-1", "日切")])] });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("page-api");
    fireEvent.click(await screen.findByTestId("api-new"));
    const sel = await screen.findByTestId("def-module");
    // value={form.module_id ?? undefined}：未选模块的新建画 placeholder「未分类」
    expect(sel.querySelector(".ant-select-selection-item")).toBeNull();
    expect(sel.querySelector(".ant-select-selection-placeholder")?.textContent).toBe("未分类");
    // 选项来自页面自己 load 回来的那棵树（flatten 摊平、层级用全角空格缩进）
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    await waitFor(() => expect(optionContents()).toEqual(["订单域", "结算域", "对账", "　日切"]));
    clickOption("结算域");
    // 选中回填选择框 = value 真的经 form.module_id 流进 Select
    await waitFor(() => expect(sel.querySelector(".ant-select-selection-item")?.textContent).toBe("结算域"));
    // 名与路径必填：填上才发得出新建 POST（223-226 的新建分支）
    fireEvent.change(screen.getByTestId("def-name"), { target: { value: "新接口" } });
    fireEvent.change(screen.getByTestId("def-path"), { target: { value: "/x" } });
    fireEvent.click(screen.getByTestId("api-save"));
    await waitFor(() => expect(postBodiesTo("/api-definitions").length).toBe(1));
    expect(postBodiesTo("/api-definitions")[0])
      .toMatchObject({ project_id: "p1", name: "新接口", path: "/x", module_id: "m-b" });
  });

  it("def-module allowClear：清空回落「未分类」，保存 body 的 module_id 是 null（键在、值为 null）", async () => {
    mockFull({ tree: [node("m-a", "订单域"), node("m-b", "结算域")] });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("page-api");
    fireEvent.click(await screen.findByTestId("api-new"));
    const sel = await screen.findByTestId("def-module");
    fireEvent.mouseDown(sel.querySelector(".ant-select-selector")!);
    await waitFor(() => expect(optionContents()).toEqual(["订单域", "结算域"]));
    clickOption("结算域");
    await waitFor(() => expect(sel.querySelector(".ant-select-selection-item")?.textContent).toBe("结算域"));
    // allowClear：rc-select 的清空钮在有值时挂 .ant-select-clear，mousedown 触发 onChange(undefined)
    fireEvent.mouseEnter(sel);
    await waitFor(() => expect(sel.querySelector(".ant-select-clear")).not.toBeNull());
    fireEvent.mouseDown(sel.querySelector(".ant-select-clear")!);
    await waitFor(() => expect(sel.querySelector(".ant-select-selection-item")).toBeNull());
    expect(sel.querySelector(".ant-select-selection-placeholder")?.textContent).toBe("未分类");
    fireEvent.change(screen.getByTestId("def-name"), { target: { value: "未分类接口" } });
    fireEvent.change(screen.getByTestId("def-path"), { target: { value: "/y" } });
    fireEvent.click(screen.getByTestId("api-save"));
    await waitFor(() => expect(postBodiesTo("/api-definitions").length).toBe(1));
    const body = postBodiesTo("/api-definitions")[0];
    // v ?? null：清掉「?? null」后 module_id 成 undefined，JSON 序列化键整个消失 → 这条先红
    expect("module_id" in body).toBe(true);
    expect(body.module_id).toBeNull();
  });

  it("def-module 编辑回填：既有接口 module_id=m-b 经详情 [编辑] 打开编辑器，选择框直接画模块名「结算域」", async () => {
    // 杀 AP14：删掉 476 行 value={form.module_id ?? undefined}（受控值失联）后，
    // 编辑既有接口时选择框回落到 placeholder「未分类」——新建流 module_id 起步就是
    // null，两条既有 def-module 测试永远看不到这条回填，正是本条要补的洞。
    mockFull({
      items: [def({ id: "d9", name: "既有结算接口", module_id: "m-b" })],
      tree: [node("m-a", "订单域"), node("m-b", "结算域")],
    });
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><ApiPage /></MemoryRouter>
      </ConfigProvider>);
    await screen.findByTestId("api-row");
    // 编辑既有定义的路：行 → 详情抽屉 → [编辑] → 编辑器（def-name 在场）
    fireEvent.click(screen.getByTestId("api-row"));
    await screen.findByTestId("api-detail-drawer");
    fireEvent.click(await screen.findByTestId("detail-edit"));
    const nameInput = await screen.findByTestId("def-name");
    // 同帧对照：表单回填整条链走通（name 也来自 target），排除「编辑器压根没开」假阳性
    expect((nameInput as HTMLInputElement).value).toBe("既有结算接口");
    const sel = await screen.findByTestId("def-module");
    // 受控 value 命中 flatten(tree) 的选项 → 选择框画 label「结算域」而不是 id 或空
    await waitFor(() => expect(sel.querySelector(".ant-select-selection-item")?.textContent).toBe("结算域"));
    // placeholder 不许同时在场：未回填时这里会是「未分类」
    expect(sel.querySelector(".ant-select-selection-placeholder")?.textContent).not.toBe("未分类");
  });

  it("def-public：编辑既有接口整块不在 DOM；新建流初值 checked，点掉后以 project_public:false 入 POST", async () => {
    mockFull({ items: [def({ id: "d9", name: "私有接口", project_public: false })] });
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><ApiPage /></MemoryRouter>
      </ConfigProvider>);
    await screen.findByTestId("api-row");
    // editing !== "new"：编辑器开了（def-name 在）但开关整块不在（479 行的 editing === "new" 门）
    fireEvent.click(screen.getByTestId("api-row"));
    await screen.findByTestId("api-detail-drawer");
    fireEvent.click(await screen.findByTestId("detail-edit"));
    await screen.findByTestId("def-name");
    expect(screen.queryByTestId("def-public")).toBeNull();
    // 新建流：出现且初值 checked（form.project_public 缺省 true 经 checked= 画出）
    cleanup();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><ApiPage /></MemoryRouter>
      </ConfigProvider>);
    fireEvent.click(await screen.findByTestId("api-new"));
    const sw = await screen.findByTestId("def-public");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.className).toContain("ant-switch-checked");
    // 点一下：受控 checked 跟着 form.project_public 翻转（摘 checked= 或反转 onChange 都红）
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(sw.className).not.toContain("ant-switch-checked");
    // 状态进 payload：关掉后创建 → body 里 project_public 是 false（不是 true、不是缺键）
    fireEvent.change(screen.getByTestId("def-name"), { target: { value: "私有新接口" } });
    fireEvent.change(screen.getByTestId("def-path"), { target: { value: "/p" } });
    fireEvent.click(screen.getByTestId("api-save"));
    await waitFor(() => expect(postBodiesTo("/api-definitions").length).toBe(1));
    expect(postBodiesTo("/api-definitions")[0])
      .toMatchObject({ project_id: "p1", name: "私有新接口", project_public: false });
  });

  it("detail-delete：详情抽屉 [回收站] 走二次确认 → POST /api-definitions/d7/delete 带 project 不带 force，成功后抽屉关；MEMBER 无此入口", async () => {
    const spy = vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    const renderApi = () => render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><ApiPage /></MemoryRouter>
      </ConfigProvider>);
    mockFull({ items: [def({ id: "d7", name: "待回收接口" })] });
    renderApi();
    await screen.findByTestId("api-row");
    fireEvent.click(screen.getByTestId("api-row"));
    await screen.findByTestId("api-detail-drawer");
    const del = await screen.findByTestId("detail-delete");
    expect(del.textContent).toBe("回收站");
    fireEvent.click(del);
    // 与列表侧同一个 removeDef 二次确认（Modal.confirm okText），不是点下即删
    fireEvent.click(await screen.findByRole("button", { name: "放入回收站" }));
    await waitFor(() => expect(postBodiesTo("/api-definitions/d7/delete").length).toBe(1));
    // body 恰好 {project_id}：不带 force（force 只许从 409 拦截弹窗进来）
    expect(postBodiesTo("/api-definitions/d7/delete")[0]).toEqual({ project_id: "p1" });
    // 成功回执 + 抽屉关掉（doRemoveDef 的 detail?.id === d.id → setDetail(null)）
    await waitFor(() => expect(spy.mock.calls.some((c) => String(c[0]).includes("已放入回收站"))).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("api-detail-drawer")).toBeNull());
    spy.mockRestore();
    // 门控同帧对照：MEMBER（内置表 -*:delete 拒 delete、update 仍放行）详情里没这个钮，
    // 但 [编辑] 在——钉的是 524 行 canDelete 这一位，不是整个 extra 区。
    cleanup();
    useAuth.setState({ project: { id: "p1", name: "履约", description: null, status: "normal", my_role: "MEMBER" } });
    renderApi();
    await screen.findByTestId("api-row");
    fireEvent.click(screen.getByTestId("api-row"));
    await screen.findByTestId("api-detail-drawer");
    expect(screen.queryByTestId("detail-delete")).toBeNull();
    expect(screen.getByTestId("detail-edit")).not.toBeNull();
  });

  it("detail-cases：切「用例(N)」Tab 才带 definition_id 拉 /api-cases；行数与 Tab 计数跟真实数据走", async () => {
    mockFull({
      items: [def({ id: "d5", name: "带用例的接口" }), def({ id: "d6", name: "没用例的接口" })],
      cases: [
        { id: "c1", project_id: "p1", definition_id: "d5", name: "正常下单", priority: "P0",
          request: null, assertions: [], dataset_id: null, sort: 0, status: "normal" },
        { id: "c2", project_id: "p1", definition_id: "d5", name: "重复下单", priority: "P1",
          request: null, assertions: [], dataset_id: null, sort: 1, status: "normal" },
      ],
    });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    // 没开抽屉没切 Tab：一条 /api-cases 都不发（tab === "case" 守卫 + CaseList 惰性挂载）
    expect(callsTo("/api-cases").length).toBe(0);
    // 先开没用例的 d6：计数是后端给的真实 0（写死/从列表长度反推都会在这红）
    fireEvent.click(rowLinks()[1]);
    await screen.findByTestId("api-detail-drawer");
    fireEvent.click(screen.getByTestId("detail-tab-case"));
    await waitFor(() => expect(screen.getByTestId("detail-tab-case").textContent).toBe("用例(0)"));
    const panel = screen.getByTestId("detail-cases");
    expect(within(panel).queryAllByTestId("case-row").length).toBe(0);
    expect(callsTo("/api-cases")[0]).toContain("definition_id=d6");
    // 换 d5：行、计数、请求参数三处一起跟到「d5 有 2 条」
    fireEvent.click(rowLinks()[0]);
    await waitFor(() => expect(screen.getByTestId("detail-tab-case").textContent).toBe("用例(2)"));
    const p5 = screen.getByTestId("detail-cases");
    expect(within(p5).getAllByTestId("case-row").map((r) => r.textContent)).toEqual(["正常下单", "重复下单"]);
    // 参数化取数：两条 GET 各带自己的 definition_id（def.id 被换成别的值这红）
    expect(callsTo("/api-cases").length).toBe(2);
    expect(callsTo("/api-cases").some((u) => u.includes("definition_id=d5"))).toBe(true);
  });

  // ── 第五道差集（前端 fixture ↔ 后端 ApiDefinitionOut）：模块列 Tag 的「有值」分支 ──
  // 上面 :1135 那条带 module_id=m-b 的行断的是**编辑器选择框回填**，不是列——api.tsx:450-452
  // 的 truthy 分支（<Tag>{moduleName.get(id) ?? "已回收模块"}</Tag>）全文件没钉过。
  // 行锁定走 tr[data-row-key]（rowKey="id"，api.tsx:419），防「模块名恰好画在侧栏树」的假绿。
  it("模块列：module_id=m-b 且树里有 → 列画「结算域」；树里查不到的 id → 画「已回收模块」，都不画裸 id", async () => {
    mockFull({
      items: [
        def({ id: "d1", name: "有主接口", module_id: "m-b" }),
        def({ id: "d2", name: "孤儿接口", module_id: "m-zombie" }),
      ],
      // 树刻意非空：树为空时空 map 也能碰出回落文案，钉不出「查不到」这个语义
      tree: [node("m-a", "订单域"), node("m-b", "结算域")],
    });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    const tr = (id: string) => {
      const el = document.querySelector<HTMLElement>('tr[data-row-key="' + id + '"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    };
    // ① 命中：列画模块名，不是 id（侧栏树也有「结算域」，必须 within 行才不是假绿）
    expect(within(tr("d1")).getByText("结算域")).not.toBeNull();
    expect(tr("d1").textContent).not.toContain("m-b");
    // ② 查不到：回落「已回收模块」——模块被回收后列表不许画裸 uuid
    expect(within(tr("d2")).getByText("已回收模块")).not.toBeNull();
    expect(tr("d2").textContent).not.toContain("m-zombie");
  });
});

// 第八道差集第二十三轮（api.tsx）：本页取数是 silent:true 且 catch 里只有一句
// 「toast 已在 client 里弹」——那句注释本身就是假话，接口列表 500 后页面只剩
// 「还没有接口，点右上角新建」，把挂掉的请求演成实测零条。脚注同病：Page 没有 total
// （api.ts:76），只取一页 size=200 却写「共 N 条」。
// D47-b 步4b：脚注的账由服务端 total（ListPager）接手；「共」字有了后端作证。
// 失败语义换页码档：陈旧行 + 新 current 同屏 = 两把尺子量同一页，失败必须清行清 total
// （旧「失败不清行」的世界随本地过滤一起退役）。变异：catch 不 setDefs([]) → 第二、三条红。
describe("接口列表取数失败摊开说 + 「共 N 条」由服务端 total 作证", () => {
  function mockList(opts: { fail?: boolean } = {}): void {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api-definitions") && opts.fail) {
        return { ok: false, status: 500,
          json: async () => ({ code: "db_error", message: "接口库挂了", details: null }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
        ? { items: [def(), def({ id: "d2", name: "退款登记" })], next_cursor: null, total: 45 }
        : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  async function twoRows(): Promise<void> {
    await waitFor(() => expect(screen.getAllByTestId("api-row")).toHaveLength(2));
  }

  it("首屏 500：Alert 带后端原文，空态改口，脚注不报数", async () => {
    mockList({ fail: true });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const alert = await screen.findByTestId("api-def-load-error");
    expect(document.body.textContent).toContain("接口库挂了");
    expect(document.body.textContent).toContain("接口列表没取到");
    expect(document.body.textContent).not.toContain("还没有接口，点右上角新建");
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    // 失败也没有 total：分页器整块不渲染，不许挂假「共 0 条」
    expect(screen.queryByTestId("list-pager")).toBeNull();
    // 不给 ×：关掉这条 = 空态改口成「还没有接口」，把挂掉的请求演成实测零条
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
  });

  it("点 [刷新] 挂了：清行清 total（页码模式不留两把尺子），Alert 与「计数不作数」都在", async () => {
    // 页码模式（D47-b）：陈旧行 + 新 current 同屏就是「我在第几页」的两把尺子，
    // 与后端禁 cursor+current 同罪——失败清行，故障仍由 Alert + 空态改口摊开说。
    mockList();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await twoRows();
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500,
      json: async () => ({ code: "db_error", message: "接口库挂了", details: null }),
    })) as unknown as typeof fetch;
    fireEvent.click(screen.getByTestId("api-reload"));
    await screen.findByTestId("api-def-load-error");
    expect(screen.queryByTestId("api-row")).toBeNull();
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    expect(screen.queryByTestId("list-pager")).toBeNull(); // 陈旧「共 45 条」不留在空表下
    expect(document.body.textContent).toContain("接口列表没取到");
  });

  it("「共 45 条」来自响应 total 而不是屏上行数；成功路径脚注不再报本地计数", async () => {
    // 45 vs 屏上 2 行：数字对不上正是「total 只从响应来、不由行数现攒」的证明；
    // 旧的「本页取到 N 条（单页上限 200，后面还有没取的）」整句退役——页码模式下
    // 下一页永远点得到，那半句是假话。
    mockList();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await twoRows();
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    expect(document.body.textContent).not.toContain("单页上限 200");
    expect(document.body.textContent).not.toContain("后面还有没取的");
    expect(document.body.textContent).not.toContain("共 2 条"); // 本地行数不许冒充「共」
  });
});

// ── 第二十六轮：文案承诺 → 兑现 差集四处（本文件逐站钉死）───────────────────────
// (A) 徽标 silent catch 留空 → 「没取到」被 BadgeCell 画成肯定的「未运行」（故障演成缺席）；
// (B) 空态「点右上角新建」指着一个 canCreate=false 时压根不在 DOM 的钮；
// (C) 详情「仅自己可见」与 visibility.py:13-25（项目管理员全见私有行）相反；
// (D) removeDef 承诺「点名是哪些场景」，services.py:236 hidden 分支只报数不点名。
// 变异即回退各站点那一处字面量，对应 it 必须红。

describe("行徽标「运行记录没取到」与「未运行」分两句话（R26 站点 A）", () => {
  // 按 subject_id 分路由：d1 可整体失败（reject=网络/异常；500=回 5xx），d2 恒真空。
  // 失败行与真空行同屏，才能钉「两种空态可区分」不是各测各的。
  function mockRuns(d1Mode: "reject" | "500") {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?")) {
        if (url.includes("subject_id=d1")) {
          if (d1Mode === "reject") throw new Error("network down");
          return { ok: false, status: 500,
            json: async () => ({ code: "db_error", message: "运行库挂了", details: null }) } as unknown as Response;
        }
        return { ok: true, status: 200,
          json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
      }
      if (url.includes("/api-definitions")) {
        return { ok: true, status: 200, json: async () => ({
          items: [def({ id: "d1", name: "取数失败行" }), def({ id: "d2", name: "真空行" })],
          next_cursor: null }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => (
        { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("某行 /runs 请求失败 → 该行改口「运行记录没取到」且不是 run-badge；真空行仍说「未运行」", async () => {
    mockRuns("reject");
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const rows = await screen.findAllByTestId("api-row");
    expect(rows.map((r) => r.textContent)).toEqual(["取数失败行", "真空行"]);
    const unk = await screen.findByTestId("run-badge-unknown");
    // 整串钉死「运行记录没取到」：回退 BadgeCell 的 unknown 分支或 catch 里的落态，本条必红
    expect(unk.textContent).toBe("运行记录没取到");
    // 失败不许冒充真徽标：run-badge 是 e2e（api.spec.mjs）认状态码的把手，一条都不许有
    expect(screen.queryByTestId("run-badge")).toBeNull();
    // 失败行的单元格不许是「未运行」，同帧真空行仍要肯定地说「未运行」（两句话不许并一句）
    const cells = Array.from(document.querySelectorAll(".ant-table-tbody .ant-table-cell"));
    const unkCell = unk.closest("td") as HTMLElement;
    expect(unkCell.textContent).toBe("运行记录没取到");
    expect(unkCell.textContent).not.toContain("未运行");
    const emptyCell = cells.find((td) => td.textContent === "未运行");
    expect(emptyCell).toBeDefined();
    expect(emptyCell!.textContent).toBe("未运行");
  });

  it("某行 /runs 回 500 → 同一句「运行记录没取到」，Tooltip 不指定是哪种失败", async () => {
    // reject 与 500 同落 unknown：silent catch 里前端分不清是网络断了、500 还是 403，
    // Tooltip 只说「可能是请求失败或无权查看」——精确整串，改写成断言某一种就红。
    mockRuns("500");
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    const unk = await screen.findByTestId("run-badge-unknown");
    expect(unk.textContent).toBe("运行记录没取到");
    expect(screen.queryByTestId("run-badge")).toBeNull();
    fireEvent.mouseEnter(unk);
    await screen.findByText(
      "这一行的运行记录没取到（可能是请求失败或无权查看），刷新后重试——不能把它当成「未运行」");
  });
});

// 站点 B/C/D 共用的权限与行夹具：my_perms 显式给（服务端口径优先，perms.ts:45）
function permsProject(myPerms: string[]) {
  return { id: "p1", name: "履约", description: null, status: "normal",
    my_role: "READONLY", my_perms: myPerms };
}
function oneRow(items: ApiDef[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return { ok: true, status: 200, json: async () => (url.includes("/api-definitions")
      ? { items, next_cursor: null }
      : { items: [], next_cursor: null, tree: [], recycled: [], scopes: {} }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

it("无新建权限的空态不再指路：「还没有接口（你没有新建权限）」，且 [新建接口] 与那句指路话同屏消失（R26 站点 B）", async () => {
  // 「点右上角新建」指向的钮在 canCreate && !inRecycled 之后（api.tsx :360）：
  // 指路话必须跟钮共存亡，句式照 uiCases.tsx:180 / adbCases.tsx:146 已上线的诚实形状。
  // canCreate=true 的正对照是同文件既有 it「游标为空才写「共 2 条」」那组（PROJECT_ADMIN → 「共 2 条」），
  // 真分支「还没有接口，点右上角新建」的契约由既有 :1230 反向断言 + e2e api.spec.mjs:12 钉住。
  useAuth.setState({ project: permsProject(["api:def:read"]) });
  oneRow([]);
  render(<MemoryRouter><ApiPage /></MemoryRouter>);
  expect((await screen.findByText("还没有接口（你没有新建权限）")).textContent)
    .toBe("还没有接口（你没有新建权限）");
  expect(screen.queryByTestId("api-new")).toBeNull();
  expect(document.body.textContent).not.toContain("点右上角新建");
});

it("详情抽屉 project_public:false → 「私有（仅自己与项目管理员可见）」，不说死的「仅自己可见」（R26 站点 C）", async () => {
  // visibility.py:13-25 _is_project_admin（系统管理员 / api:*:delete / *:delete）全见私有行；
  // 同文件 :512 开关文案「关掉后仅自己与项目管理员可见」才是同一口径。
  oneRow([def({ project_public: false })]);
  render(<MemoryRouter><ApiPage /></MemoryRouter>);
  fireEvent.click(await screen.findByTestId("api-row"));
  await screen.findByTestId("api-detail-drawer");
  expect(document.body.textContent).toContain("私有（仅自己与项目管理员可见）");
  expect(document.body.textContent).not.toContain("仅自己可见");
  // 同帧正对照：公开行仍走「项目公开」，这次改动没碰那条
  cleanup();
  oneRow([def({ project_public: true })]);
  render(<MemoryRouter><ApiPage /></MemoryRouter>);
  fireEvent.click(await screen.findByTestId("api-row"));
  await screen.findByTestId("api-detail-drawer");
  expect(document.body.textContent).toContain("项目公开");
});

it("回收确认文案不再承诺「点名是哪些场景」（引用明细要 scenario:read，R26 站点 D）", async () => {
  // services.py:236 hidden 分支只报数量刻意不点名；后端两条分支都给得出的下限才是可兑现的承诺。
  oneRow([def({ id: "d1", name: "待回收接口" })]);
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter><ApiPage /></MemoryRouter>
    </ConfigProvider>);
  await screen.findByTestId("api-row");
  fireEvent.click(screen.getByTestId("api-delete"));
  const dialog = await screen.findByRole("dialog");
  // 新句整串钉死：把 removeDef 的 content 改回旧文案（或任意删掉 scenario:read 半句）都红
  expect(dialog.textContent).toContain(
    "其未回收用例若被场景引用会拒绝回收，并给出引用情况（引用明细要 scenario:read 才看得到）。");
  expect(dialog.textContent).not.toContain("点名是哪些场景");
  // D131：后端 services.py:275 只置定义 recycled，用例一行都不动。旧句「跟着接口一起进
  // 回收站」承诺了后端没做的事（用例不进回收站、正常列表里还在，只是回收期间 404 不可用）。
  // 新句整串钉死：把 content 改回旧句、或删掉「也不会跟着进回收站」半句，都红。
  expect(dialog.textContent).toContain(
    "「待回收接口」的用例不会删，也不会跟着进回收站：接口回收期间它们不可用，恢复接口后原样回归。");
  expect(dialog.textContent).not.toContain("跟着接口一起进回收站");
});

// 第二十六轮变异取证跑出的缺口：E1（摘掉 <ModuleTree loadError={loadError}/> 的接线）
// 17 条腿里唯一的两个 GREEN 之一——组件自己 M1~M3 钉得住「给了 loadError 就说人话」，
// 但没人钉「页面把 loadError 给了它」。不接线的后果具体在回收站视图：树与列表在同一把
// Promise.all 里（api.tsx:175）失败时一起停，recycledTree 留在初始 []，
// ModuleTree.tsx:191 于是画一句「回收站是空的」——把挂掉的请求演成实测零条。
describe("列表失败要传进模块树：回收站栏不许说「回收站是空的」（R26 站点 E 接线）", () => {
  it("首屏 500 后切回收站：这一栏说「回收站没取到…空着不等于真的没有」，不说「回收站是空的」", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 500,
      json: async () => ({ code: "db_error", message: "接口库挂了", details: null }),
    })) as unknown as typeof fetch;
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-def-load-error");
    fireEvent.click(await screen.findByTestId("module-recycled-toggle"));
    const tip = await screen.findByTestId("module-tree-load-error");
    expect(tip.textContent).toContain("回收站没取到");
    expect(tip.textContent).toContain("空着不等于真的没有");
    expect(document.body.textContent).not.toContain("回收站是空的");
  });
});

// ── D180 切回收站的竞态窗口（api.tsx）──────────────────────────────────────
// 点击同步翻 inRecycled，行要等下一次 Promise.all 回包才换。那一格里活行会挂上回收站
// 模板：脚注说「回收站视图」，行尾长出 恢复/彻底删除（给活接口一个物理删除钮）。
// 回 500 的旧「永久态」（留行）随 D47-b 页码模式的失败清行退役，②改钉「清行后模板照旧不翻」。
// 普通跑法量不到在途窗口，故把带 recycled=true 的那次 GET 挂成手工 deferred。
// 半 1（脚注/空态读 shownRecycled）由 ①②③ 钉，半 2（行身份认 r.status）由 ④ 钉。
// 本页没有「删除人」列，说谎面只有模板与两钮。
describe("D180 切回收站：模板滞后于数据，不是滞后于点击", () => {
  const ok = (json: unknown, status = 200): Response =>
    ({ ok: status < 400, status, json: async () => json }) as unknown as Response;
  function deferredResp() {
    let resolve!: (r: Response) => void;
    const promise = new Promise<Response>((r) => { resolve = r; });
    return { promise, resolve };
  }
  /** 模块树立即回（带一个真模块，顺带钉「回收站视图」脚注前的「（选中模块）」不受影响），
   *  带 recycled=true 的列表挂在 deferred 上；正常列表给一条活接口。
   *  liveRows 可换：⑤ 要的是「初始列表本来就空」那一格——表里有行时 antd 不渲染 Empty，
   *  空态那条腿（api.tsx:437）在本文件里一次都没进过分支（leg1 变异本轮实测杀不死）。 */
  function mockRacyList(liveRows: ApiDef[] | null = null) {
    const dfd = deferredResp();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api-modules")) {
        return ok({ tree: [{ id: "m1", parent_id: null, name: "交易域", sort: 1,
          status: "normal", count: 1, children: [] }], recycled: [] });
      }
      if (url.includes("/envs?")) return ok({ items: [], next_cursor: null });
      if (url.includes("recycled=true")) return dfd.promise;
      if (url.includes("/api-definitions")) {
        return ok({ items: liveRows ?? [def({ id: "d1", name: "活接口", status: "complete",
          owner_id: "u9", owner_name: "最后编辑的老李", updated_at: "2026-11-01T02:34:56+00:00" })],
        next_cursor: null });
      }
      if (url.includes("/recent-runs") || url.includes("/runs")) return ok({ items: [], next_cursor: null });
      throw new Error("未 mock 的请求: " + url);
    }) as unknown as typeof fetch;
    return dfd;
  }
  const recycledCalls = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes("/api-definitions") && String(c[0]).includes("recycled=true")).length;
  const rowTr = (id: string): HTMLElement => {
    const tr = document.querySelector<HTMLElement>('tr[data-row-key="' + id + '"]');
    expect(tr).not.toBeNull();
    return tr as HTMLElement;
  };

  it("① 点回收站 + 列表在途：活行不提前挂回收站模板（无彻底删除/无「回收站视图」字样）", async () => {
    const dfd = mockRacyList();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1)); // 显式前提：请求已在途
    expect(screen.queryByTestId("api-purge")).toBeNull();
    expect(screen.queryByTestId("api-restore")).toBeNull();
    expect(document.body.textContent).not.toContain("回收站视图");
    // 活行照常留着正常视图的把手（不是被隐藏掉就当没发生）
    expect(within(rowTr("d1")).getByTestId("api-detail")).not.toBeNull();
    // inRecycled 的本职照旧：钮说的是「请求要什么」
    // 切换钮改为图标钮（2026-11-22 设计改版），文案搬到 aria-label；可访问名与语义不变。
    expect(screen.getByTestId("module-recycled-toggle").getAttribute("aria-label")).toBe("退出回收站");
    dfd.resolve(ok({ items: [], next_cursor: null }));
    // 闸门用「回收站视图」而不是「回收站是空的」：后者模块树那一栏在点击当场就说了
    // （桩里 recycled 恒 []），慢网络下它先绿 = 断言赶在列表回包之前跑（本轮探针实测红过）。
    await waitFor(() => expect(document.body.textContent).toContain("回收站视图"));
  });

  it("② 点回收站 + 回 500（页码模式 = 清行）：活行下桌，模板与回收站字样都不翻，加载失败提示照常", async () => {
    // D47-b 步4b 改了失败语义：页码模式下失败清行清 total（陈旧行 + inRecycled 的新请求
    // 是两把尺子）。D180 的不变量仍然全在：模板只跟成功走——行没了，「回收站视图」字样、
    // 彻底删除/恢复两钮、「回收站是空的」空态都一个不许出现，谎面从根上没了。
    const dfd = mockRacyList();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(ok({ code: "db_error", message: "接口库挂了", details: null }, 500));
    await screen.findByTestId("api-def-load-error");
    expect(document.body.textContent).toContain("接口库挂了");
    await waitFor(() => expect(screen.queryByTestId("api-row")).toBeNull()); // 页码模式清行
    expect(screen.queryByTestId("api-purge")).toBeNull();
    expect(screen.queryByTestId("api-restore")).toBeNull();
    expect(document.body.textContent).not.toContain("回收站视图");
    expect(document.body.textContent).not.toContain("回收站是空的"); // 失败不演空回收站
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
  });

  it("③ 成功落回回收站：两钮照常出现、脚注改口（正向对照，防「永远不显示」也全绿）", async () => {
    const dfd = mockRacyList();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(ok({ items: [def({ id: "d9", name: "被回收的接口", status: "recycled" })],
    next_cursor: null }));
    await waitFor(() => expect(screen.getByTestId("api-purge")).not.toBeNull());
    expect(screen.getByTestId("api-restore")).not.toBeNull();
    expect(document.body.textContent).toContain("回收站视图");
  });

  it("④ 混合数据正对照：回收批次里混 status:complete 的行 → 该行只有详情/回收站把手，没有彻底删除", async () => {
    // 后端正常不给混合数据（列表按 status 过滤），这条钉的是半 2：行身份逐行认 r.status。
    const dfd = mockRacyList();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1));
    dfd.resolve(ok({ items: [
      def({ id: "d-real", name: "真回收接口", status: "recycled" }),
      def({ id: "d-mixed", name: "混进来的活接口", status: "complete" }),
    ], next_cursor: null }));
    await waitFor(() => expect(screen.getByTestId("api-purge")).not.toBeNull());
    expect(within(rowTr("d-real")).queryByTestId("api-purge")).not.toBeNull();
    expect(within(rowTr("d-mixed")).queryByTestId("api-purge")).toBeNull();
    expect(within(rowTr("d-mixed")).queryByTestId("api-restore")).toBeNull();
    expect(within(rowTr("d-mixed")).getByTestId("api-detail")).not.toBeNull();
  });

  it("⑤ 空态那条腿：项目里本来就没接口 + 回收站请求在途 → 空态说「还没有接口」，不说「回收站是空的」", async () => {
    // leg1（空态模板 shownRecycled→inRecycled）在本文件里曾经杀不死：①②③④ 的初始列表
    // 恒带一行活接口，antd 有行就不渲染 Empty，那条腿一次都没进过分支。
    // 只查表格自己那份空态：模块树那一栏在点击当场就会说「回收站是空的」（桩里 recycled 恒 []），
    // 拿整页文本当断言会被兄弟组件满足（本轮探针实测红过的同一种假把手）。
    const dfd = mockRacyList([]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector(".ant-table-placeholder")).not.toBeNull());
    const emptyDesc = () => document
      .querySelector(".ant-table-placeholder .ant-empty-description")?.textContent ?? "";
    expect(emptyDesc()).toContain("还没有接口");
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    await waitFor(() => expect(recycledCalls()).toBe(1)); // 已在途
    expect(emptyDesc()).not.toContain("回收站是空的");
    dfd.resolve(ok({ items: [], next_cursor: null }));
    // 正对照：真取回空回收站后同一句必须改口，否则这条腿只是「永远不说」
    await waitFor(() => expect(emptyDesc()).toContain("回收站是空的"));
  });
});

// ── D134（api 站点，台账「复用 D134」）：空态按真实筛选态归因 ─────────────────────
// 旧空态拿未过滤的 defs.length 当尺子：只选模块、没输关键词而列表空时，怪「换个关键词」。
// 新三腿：有关键词怪关键词；只剩模块筛选怪模块；都没有走「还没有接口」。
// D47-b 步4b：过滤整体搬到服务端，空表 = 后端在当前条件下真没给行；归因仍读**已提交**
// 的筛选（kw 不是输入框现值）。桩按 keyword/module 真过滤，文案与请求参数得一起对才绿。
// 变异即红：归因链读 qText（打字未提交的关键词会抢锅）→ 第二条红；两分支文案对调 → 对应条红。
describe("D134 空态按真实筛选态归因（api.tsx）", () => {
  function node(id: string, name: string): ModNode {
    return { id, parent_id: null, name, sort: 0, status: "normal", count: 0, children: [] };
  }
  const emptyDesc = () => document
    .querySelector(".ant-table-placeholder .ant-empty-description")?.textContent ?? "";
  async function selectModule(name: string): Promise<void> {
    const title = await waitFor(() => {
      const t = Array.from(document.querySelectorAll(".ant-tree-title"))
        .find((n) => (n.textContent ?? "").includes(name));
      if (!t) throw new Error("树里还没有「" + name + "」");
      return t;
    });
    fireEvent.click(title.closest(".ant-tree-node-content-wrapper") as HTMLElement);
  }

  it("只选模块、没输关键词：怪模块不怪关键词（桩真按 module_ids 过滤，行集与归因一起对）", async () => {
    const h = serverMock([def({ id: "d1", name: "订单查询", module_id: null })],
      { tree: [node("m1", "空的模块")] });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    expect((await screen.findAllByTestId("api-row")).length).toBe(1);
    await selectModule("空的模块");
    await waitFor(() => expect(screen.queryByTestId("api-row")).toBeNull());
    // 请求侧正对照：module_ids 真上了线（m1 没有子孙，重复键就只有它自己）
    expect(lastListQ(h).getAll("module_ids")).toEqual(["m1"]);
    expect(emptyDesc()).toBe("这个模块下没有接口（换个模块或看「未分类」）");
    expect(document.body.textContent).not.toContain("没有匹配的接口");
  });

  it("有关键词时仍怪关键词：模块半句不许抢走关键词半句", async () => {
    serverMock([def({ id: "d1", name: "订单查询", module_id: null })],
      { tree: [node("m1", "空的模块")] });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    fireEvent.change(screen.getByTestId("api-search"), { target: { value: "查无此接口" } });
    pressEnter(screen.getByTestId("api-search"));
    await waitFor(() => expect(screen.queryByTestId("api-row")).toBeNull());
    expect(emptyDesc()).toBe("没有匹配的接口，换个关键词试试");
    expect(document.body.textContent).not.toContain("这个模块下没有接口");
  });
});

// ── D47-a 续（api 站点接线）：三件套不能只自说自话 ────────────────────────────────
// ListToolbar.test.tsx 测的是组件自己（它往外回报什么）；这一节测的是**页面拿回报去做什么**
// ——组件测全绿而页面忘记接线的形态，正是「面板能填、按钮能点、列表一动不动」的假把手。
// ① 高级搜索的条件必须出现在打到 /api-definitions 的 filter= 参数里（本地 visible 过滤不算筛）；
// ② 枚举字段的候选值来自页面词表（METHODS）：工具栏自己不认识 GET/POST；
// ③ 列设置勾掉一列 → 表头那一列真消失，且偏好落盘（组件只回报，落盘是 useColumnPrefs）；
// ④ 高级搜索筛空时，空态怪高级搜索且排在关键词之前（D134 归因链新增的那条腿）。
// 变异即红：filterQuery 不进 URL → ①②红；valueOptions 不传 → ②红；applyColumnPrefs 不套
// 或 API_COL_CHOICES 的 key 与列 key 对不上 → ③红；hasAdv 分支删掉/挪到关键词之后 → ④红。
describe("D47-a api 页接线：条件真打进请求，列设置真改表头", () => {
  // 后端 filter_meta 的桩。字段/操作符只在这一份里出现：页面若自己藏了一份字段表，
  // 改这里就能看出它其实没在用后端给的那份。
  const META = {
    operators: ["CONTAINS", "EQUALS", "IN"],
    labels: { CONTAINS: "包含", EQUALS: "等于", IN: "属于" },
    kinds: { text: ["CONTAINS"], enum: ["IN"] },
    unavailable: {},
    supported_view_types: ["api"],
    view_label: "接口管理",
    fields: [
      { field: "name", label: "接口名称", kind: "text", ops: ["CONTAINS"] },
      { field: "method", label: "请求方法", kind: "enum", ops: ["IN"] },
    ],
  };

  /** rowsForFiltered=false 时带 filter 的请求回空表（用来演「筛没了」那一格）。 */
  function mockPage(items: ApiDef[], rowsForFiltered = true) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/filter-meta")
        ? META
        : url.includes("/saved-views")
          ? []
          : url.includes("/api-modules")
            ? { tree: [], recycled: [] }
            : url.includes("/api-definitions")
              ? { items: url.includes("filter=") && !rowsForFiltered ? [] : items, next_cursor: null }
              : { items: [], next_cursor: null, scopes: {} };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  function defCalls(): string[] {
    return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0])).filter((u) => u.includes("/api-definitions"));
  }
  /** 最近一条列表请求里的 filter 参数；没带 = null（不是 {}，两者要能分开）。 */
  function sentFilter(): unknown {
    const hits = defCalls();
    const raw = new URL(hits[hits.length - 1], "http://x").searchParams.get("filter");
    return raw === null ? null : JSON.parse(raw);
  }
  async function openPanel(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByTestId("lt-search"));
    return screen.findByTestId("lt-panel");
  }
  /** 浮层挂在 body 末尾，同页可能残留上一个已关的浮层 → 取最后一个（同 1004 段那批把手）。 */
  function lastDropdown(): HTMLElement {
    const dds = Array.from(document.querySelectorAll(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden)"));
    return dds[dds.length - 1] as HTMLElement;
  }
  /** 展开指定 testid 的 Select 并等候选落地，返回候选文案（口径同 reports.filters.test.tsx:111：
   *  AntD 的 Select 认 mouseDown，fireEvent.click 打在外层 wrapper 上压根不展开浮层）。 */
  async function openOptions(testid: string): Promise<(string | null)[]> {
    const sel = screen.getByTestId(testid).querySelector(".ant-select-selector") as HTMLElement;
    fireEvent.mouseDown(sel);
    await waitFor(() => {
      if (!lastDropdown()?.querySelector(".ant-select-item-option-content")) {
        throw new Error("浮层里一个候选都没有");
      }
    });
    return Array.from(lastDropdown().querySelectorAll(".ant-select-item-option-content"))
      .map((n) => n.textContent);
  }
  async function pickOption(testid: string, label: string): Promise<void> {
    await openOptions(testid);
    fireEvent.click(Array.from(lastDropdown().querySelectorAll(".ant-select-item-option-content"))
      .find((n) => n.textContent === label) as HTMLElement);
  }
  async function addCondition(): Promise<HTMLElement> {
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    return within(panel).findByTestId("lt-cond-row");
  }
  const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
  const emptyDesc = () => document
    .querySelector(".ant-table-placeholder .ant-empty-description")?.textContent ?? "";
  /** 从条件条进面板（条件已生效时入口上写的是摘要，testid 不变）。 */
  const clearBtn = () => screen.getByTestId("lt-clear");

  beforeEach(() => { localStorage.clear(); });

  it("没筛就不带 filter 参数（空筛选拼一条 filter= 是骗人的参数）", async () => {
    mockPage([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    expect(sentFilter()).toBeNull();
  });

  it("高级搜索应用 → 打到 /api-definitions 的请求带后端那套 JSON，并重新拉列表", async () => {
    mockPage([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    const before = defCalls().length;
    const row = await addCondition();
    fireEvent.change(within(row).getByTestId("lt-val-text"), { target: { value: "订单" } });
    fireEvent.click(screen.getByTestId("lt-apply"));
    await waitFor(() => expect(defCalls().length).toBeGreaterThan(before));
    expect(sentFilter()).toEqual({
      search_mode: "AND", conditions: [{ field: "name", operator: "CONTAINS", value: "订单" }],
    });
  });

  it("枚举字段的候选来自页面词表（METHODS）→ 按数组发给后端", async () => {
    mockPage([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    await addCondition();
    await pickOption("lt-cond-field", "请求方法");
    // 页面给了候选 → 走多选下拉；候选就是 src/api/req.ts 的 METHODS，工具栏自己不认识方法名
    const opts = await openOptions("lt-val-multi");
    expect(opts).toContain("GET");
    expect(opts).toContain("DELETE");
    await pickOption("lt-val-multi", "GET");
    fireEvent.click(screen.getByTestId("lt-apply"));
    await waitFor(() => expect(sentFilter()).toEqual({
      search_mode: "AND", conditions: [{ field: "method", operator: "IN", value: ["GET"] }],
    }));
  });

  it("列设置勾掉「方法」→ 表头那一列真消失（入口是工具条 lt-cols）", async () => {
    mockPage([def()]);
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findAllByTestId("api-row");
    expect(thead()).toContain("方法");                 // 正对照：不是「本来就没有」
    // 2026-11-22：列设置从 ProTable options.setting 搬回工具条。options.setting 会让
    // ProTable 在卡片顶边自造一条只装一个齿轮的空工具栏（实测 1124×48，齿轮正好压在
    // 「接口」列表头上方），而项目里别处一律 options={false}。搬回来的另一头是这条孤
    // 栏必须真的消失，否则变成「两个入口 + 一条孤栏」，比原来更糟。
    expect(document.querySelector(".ant-pro-table-list-toolbar-container")).toBeNull();
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    // 面板列的是 API_COL_CHOICES 那七个可藏列；操作列不进来——它带着恢复/彻底删除的
    // 入口，被勾掉等于把回收站的出口藏起来。
    expect(boxes).toHaveLength(7);
    expect(within(panel).queryByText("操作")).toBeNull();
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["接口", "方法", "模块", "状态", "负责人", "更新时间", "最近结果"]);
    const byLabel = (t: string) => boxes[labels.indexOf(t)];
    fireEvent.click(byLabel("方法"));
    await waitFor(() => expect(thead()).not.toContain("方法"));
    expect(screen.queryByTestId("api-method")).toBeNull();
    expect(thead()).toContain("状态");                  // 只藏点名的那一列
    // 偏好落工具条这一套的键（useColumnPrefs 写盘）；键在即「设置被记住」接上了
    expect(localStorage.getItem("tp.listCols.api")).toContain("method");
  });

  it("高级搜索筛空 → 空态怪高级搜索；再输关键词也不抢走这句（归因链它在前）", async () => {
    mockPage([def()], false);                            // 带 filter 的请求回空表
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    const row = await addCondition();
    fireEvent.change(within(row).getByTestId("lt-val-text"), { target: { value: "订单" } });
    fireEvent.click(screen.getByTestId("lt-apply"));
    await waitFor(() => expect(emptyDesc()).toContain("高级搜索"));
    fireEvent.change(screen.getByTestId("api-search"), { target: { value: "查无此接口" } });
    expect(emptyDesc()).toContain("高级搜索");
    expect(document.body.textContent).not.toContain("没有匹配的接口，换个关键词试试");
    // 空态让人「点上方条件条可清空」→ 那句指的路必须真能走通，否则是假门
    fireEvent.click(screen.getByTestId("lt-search"));
    fireEvent.click(await clearBtn());
    await waitFor(() => expect(sentFilter()).toBeNull());
  });

});

// ── D47-b 步4b：页码模式的前端半边（api.tsx）──────────────────────────────────
// 三件事各有一具被防住的谎：
// ① 模块点击把「节点 + 全部子孙」以**重复键** module_ids 上线（与步4a 的子树徽标配套），
//    且从第 7 页点也要 current=1——停在第 7 页换模块，落的是新条件下无关的切片；
// ② 点一次页码恰好一条 current=N（D127 换皮：load 把响应写回的 state 塞进自己依赖就是
//    无限回路），换档位必回第 1 页（AntD 钳过的页码不许替页面做主）；
// ③ 深链 ?def= 在第一页没这条时**恰好一次** GET /api-definitions/{id}——页码模式下
//    「第一页没有」不再等于「没有这条」，但也不许每帧都去按 id 敲门。
describe("D47-b 步4b 页码模式：module_ids 子树 / 页码漏斗 / 深链按 id 补取", () => {
  function node(id: string, name: string, children: ModNode[] = []): ModNode {
    return { id, parent_id: null, name, sort: 0, status: "normal", count: 0, children };
  }
  const TREE = [node("m-a", "订单域", [node("m-a-1", "子单", [node("m-a-1-1", "孙单")])]), node("m-b", "结算域")];
  /** 分页版桩：current/size 真切片，行集按页号规律生成（p<页>-<序>），total=137 → 7 页，
   *  够测「从第 7 页换筛选」与「停在第 3 页换档位」。 */
  function mockPages(): void {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api-modules")) return { ok: true, status: 200,
        json: async () => ({ tree: TREE, recycled: [] }) } as unknown as Response;
      if (url.includes("/api-definitions?")) {
        const q = new URL(url, "http://x").searchParams;
        const cur = q.get("current") ?? "1";
        const rows = cur === "7"
          ? [def({ id: "p7-1", name: "第7页接口" }), def({ id: "p7-2", name: "第7页接口2" })]
          : Array.from({ length: 20 }, (_, i) =>
            def({ id: "p" + cur + "-" + i, name: "第" + cur + "页接口" + i }));
        return { ok: true, status: 200, json: async () => ({ items: rows, next_cursor: null, total: 137 }) } as unknown as Response;
      }
      return { ok: true, status: 200,
        json: async () => ({ items: [], next_cursor: null, scopes: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  const listUrls = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0])).filter((u) => u.includes("/api-definitions?"));
  /** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
  function clickPage(n: number): void {
    fireEvent.click(screen.getByTestId("list-pager")
      .querySelector(`.ant-pagination-item-${n} a`) as Element);
  }
  async function pickPagerSize(prefix: string): Promise<void> {
    const sel = screen.getByTestId("list-pager").querySelector(
      ".ant-pagination-options-size-changer .ant-select-selector",
    ) as HTMLElement;
    fireEvent.mouseDown(sel);
    const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
    await waitFor(() => expect(Array.from(document.querySelectorAll(contents))
      .some((n) => (n.textContent ?? "").startsWith(prefix))).toBe(true));
    fireEvent.click(Array.from(document.querySelectorAll(contents))
      .find((n) => (n.textContent ?? "").startsWith(prefix)) as Element);
  }
  async function selectModule(name: string): Promise<void> {
    const title = await waitFor(() => {
      const t = Array.from(document.querySelectorAll(".ant-tree-title"))
        .find((n) => (n.textContent ?? "").includes(name));
      if (!t) throw new Error("树里还没有「" + name + "」");
      return t;
    });
    fireEvent.click(title.closest(".ant-tree-node-content-wrapper") as HTMLElement);
  }

  it("点「订单域」：module_ids 以重复键带上节点+全部子孙，一个兄弟都不多", async () => {
    const h = serverMock([def({ id: "d1", name: "孙单里的接口", module_id: "m-a-1-1" })],
      { tree: TREE });
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await screen.findByTestId("api-row");
    const before = h.listUrls.length;
    await selectModule("订单域");
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    // 重复键（getAll 能拿回数组 = URL 上真是 module_ids=..&module_ids=..），
    // 集合恰好 = {m-a, m-a-1, m-a-1-1}：m-b 混进来是子树收集写错，漏 m-a-1-1 是漏子孙。
    expect([...q.getAll("module_ids")].sort()).toEqual(["m-a", "m-a-1", "m-a-1-1"]);
    expect(q.get("current")).toBe("1");
  });

  it("停在第 7 页点模块 → 下一条请求 current=1 且带子树 module_ids（筛选漏斗的回页）", async () => {
    mockPages();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("api-row")).toHaveLength(20));
    clickPage(7);
    await waitFor(() => expect(listUrls()[listUrls().length - 1]).toContain("current=7"));
    expect(screen.getByTestId("list-pager")
      .querySelector(".ant-pagination-item-7.ant-pagination-item-active")).toBeTruthy();
    const before = listUrls().length;
    await selectModule("订单域");
    await waitFor(() => expect(listUrls().length).toBe(before + 1));
    const q = new URL(listUrls()[listUrls().length - 1], "http://x").searchParams;
    expect(q.get("current")).toBe("1"); // 正对照：确实从第 7 页被漏斗拍回第 1 页
    expect([...q.getAll("module_ids")].sort()).toEqual(["m-a", "m-a-1", "m-a-1-1"]); // 且筛选真上了线
  });

  it("点第 2 页恰好一条 current=2（D127 换皮）；停在第 3 页换 50/页 → size=50&current=1", async () => {
    mockPages();
    render(<MemoryRouter><ApiPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("api-row")).toHaveLength(20));
    await new Promise((r) => setTimeout(r, 300));
    expect(listUrls()).toHaveLength(1); // 页码块自带的 D127 绊线（文件级绊线在导出节）
    const before = listUrls().length;
    clickPage(2);
    await waitFor(() => expect(listUrls().length).toBe(before + 1));
    expect(listUrls()[listUrls().length - 1]).toContain("current=2");
    await waitFor(() => expect(screen.getAllByTestId("api-row").map((n) => n.textContent))
      .toEqual(expect.arrayContaining(["第2页接口0"])));
    // 换档位：AntD 自己会钳一个页码带过来，不转发它——线上一条 current=1 才算数
    clickPage(3);
    await waitFor(() => expect(listUrls()[listUrls().length - 1]).toContain("current=3"));
    const at = listUrls().length;
    await pickPagerSize("50");
    await waitFor(() => expect(listUrls().length).toBe(at + 1));
    const q = new URL(listUrls()[listUrls().length - 1], "http://x").searchParams;
    expect(q.get("size")).toBe("50");
    expect(q.get("current")).toBe("1");
    // 任何一条请求都不带 cursor：current+cursor 同传后端直接 400
    expect(listUrls().some((u) => new URL(u, "http://x").searchParams.has("cursor"))).toBe(false);
  });

  it("深链 ?def=d9（第一页没有）：按 id 恰好一次 GET，抽屉开的是 fetch-by-id 的行", async () => {
    const h = serverMock([def({ id: "d1", name: "第一页接口" })], {
      details: [def({ id: "d9", name: "藏在第 4 页的接口", path: "/deep/9" })],
    });
    render(<MemoryRouter initialEntries={["/api?def=d9"]}><ApiPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("api-detail-drawer")).not.toBeNull());
    // 标题在 Drawer header（api-detail-drawer 是内容区）；抽屉体里画的是 path
    expect(document.querySelector(".ant-drawer-title")?.textContent).toContain("藏在第 4 页的接口");
    expect(screen.getByTestId("api-detail-drawer").textContent).toContain("/deep/9");
    expect(h.detailUrls).toHaveLength(1);
    expect(h.detailUrls[0]).toContain("/api-definitions/d9?project_id=p1");
    // latch：等一切落地后再观察一拍，第二次按 id 敲门不许出现
    await new Promise((r) => setTimeout(r, 200));
    expect(h.detailUrls).toHaveLength(1);
  });

  it("深链 ?def=d9 且按 id 也取不到：抽屉不开，不编行，client 把后端原话 toast 出去", async () => {
    const errSpy = vi.spyOn(message, "error").mockImplementation(() => ({}) as never);
    const h = serverMock([def({ id: "d1", name: "第一页接口" })]);
    render(<MemoryRouter initialEntries={["/api?def=d9"]}><ApiPage /></MemoryRouter>);
    await waitFor(() => expect(h.detailUrls).toHaveLength(1));
    expect(screen.queryByTestId("api-detail-drawer")).toBeNull();
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith("接口不存在"));
    expect(document.body.textContent).not.toContain("藏在第 4 页的接口"); // 没有行就是没有行
    errSpy.mockRestore();
  });

  it("深链命中已加载行：走本地命中，一次按 id 的请求都不发", async () => {
    const h = serverMock([def({ id: "d1", name: "第一页接口" })]);
    render(<MemoryRouter initialEntries={["/api?def=d1"]}><ApiPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("api-detail-drawer")).not.toBeNull());
    expect(document.querySelector(".ant-drawer-title")?.textContent).toContain("第一页接口");
    expect(h.detailUrls).toHaveLength(0);
  });

  it("深链打开后手动关掉：URL 上还挂着 ?def=，之后再刷新列表也不许把抽屉顶回来（latch 的本体）", async () => {
    // 这条是 deepRef 这个 latch **唯一**的可观察后果：消费过一次之后，defs 再变也不许重开抽屉。
    // 没有它，F9（把 latch 摘掉）活得好好的——页面看起来完全正常，代价是用户每次刷新列表
    // 刚关掉的抽屉都被查询串复活一次，而且没人知道自己是被什么打开的。
    // 「latch 存在」不可测，「关掉后不复活」可测：钉的是后者。
    const h = serverMock([def({ id: "d1", name: "第一页接口" })]);
    render(<MemoryRouter initialEntries={["/api?def=d1"]}><ApiPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("api-detail-drawer")).not.toBeNull());
    fireEvent.click(document.querySelector(".ant-drawer-close") as Element);
    await waitFor(() => expect(screen.queryByTestId("api-detail-drawer")).toBeNull());
    // 制造一次 defs 变化（换了一批全新对象的响应 = 真 fetch 每次的样子）
    const at = h.listUrls.length;
    fireEvent.click(screen.getByTestId("api-reload"));
    await waitFor(() => expect(h.listUrls.length).toBe(at + 1));
    await new Promise((r) => setTimeout(r, 200)); // 让 effect 有机会跑第二遍
    expect(screen.queryByTestId("api-detail-drawer")).toBeNull();
    expect(h.detailUrls).toHaveLength(0); // 也不该改而去敲按 id 的那条
  });
});
