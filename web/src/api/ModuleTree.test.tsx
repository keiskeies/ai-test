// 1G 收尾：ModuleTree 组件层单测——补 audit-test-debt 轴② 的最后缺口。
// 此前全仓对该文件唯一的运行时引用是 0 处（pages/api.tsx:16 是页面侧，测试侧只有
// shared/moduleTree.test.ts:8 的 `import type { ModNode }`——type-only 边在尺子里算 0）。
// 本文件把默认导出真正挂进 DOM 钉行为：动词/端点/body 逐字以 ModuleTree.tsx 为准，
// toast 与回执拼句断的是 antd message 落地后的真实文案。
// 覆盖契约（file:line 均指 ModuleTree.tsx）：
// ① 正常态树渲染：__all 根行（allLabel 默认「全部接口」）、count 徽标、深层缩进、
//    叶子 noop switcher；回收站态不画 __all/不画 count 标/标题切「回收站」。
// ② 权限门全按「藏」不按「禁」（§11.5.1，同 EnvPanel.test.tsx ⑨）：
//    canCreate 关→[新建]与菜单「新建子模块」消失；canManage 关→回收站把手与
//    「重命名/放入回收站」消失；双关→行内菜单钮整个不存在；回收站里恢复/彻底删除钮消失。
// ③ 新建：POST {base} body {project_id, parent_id, name}（root 位 parent_id=null）；
//    空名 toast「名称不能为空」一条请求不发；连点保存 saving 守卫只发一条。
// ④ 重命名：PATCH {base}/{id} body {project_id, name}，弹窗预填原名；
//    名字没改照样 PATCH（现状 pin，无脏检查）。
// ⑤ 软删两步：Modal.confirm「模块进回收站？」→ POST {base}/{id}/delete body {project_id}；
//    [取消] 零请求；删中的正是选中项 → onSelect(null) 复位，删的不是选中项 → 不动选中。
// ⑥ 回收站把手：onToggleRecycled(!inRecycled) + onSelect(null) 一次调用里都发生；
//    空回收站画 Empty「回收站是空的」。恢复 → POST {base}/{id}/restore。
// ⑦ 彻底删除（§11.4.18）：确认钮 disabled 到 purgeName 逐字等于模块名（!== 严格比较，
//    带尾空格都算不等）→ POST {base}/{id}/purge body {project_id, confirm_name}；
//    回执拼句走 purgeDetachedClauses——R112/R122 缺陷家族在**组件侧**的回归：
//    detached_elements/detached_cases 漏一个键 toast 就说错话（纯函数侧已由
//    shared/moduleTree.test.ts 钉死，这里钉的是 ModuleTree.tsx:102 真的接上了它）；
//    失败保持弹窗打开、不 onChanged。
// ⑧ 场景树复用（1B T17）：apiBase/noun/allLabel 三个 override 各自改端点前缀、
//    回执名词、__all 文案。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, Modal, message } from "antd";
import ModuleTree from "./ModuleTree";
import type { ModNode } from "./ModuleTree";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（EnvPanel.test.tsx:44 同款，每个文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// ── 后端桩：client.ts 走裸 fetch（api 前缀 client.ts:77），按 URL+method 分流 ──
interface Call { url: string; method: string; body?: string }
type Resp = { status: number; body: unknown };

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** purgeResp/pages 是「该端点第 N 次回执」序列（耗尽停最后一项）。 */
function mockBackend(over: { purgeResp?: Resp[] } = {}): Call[] {
  const calls: Call[] = [];
  let nPurge = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    if (method === "POST" && url.endsWith("/purge")) {
      const seq = over.purgeResp ?? [{ status: 200, body: { purged_modules: 2, detached_definitions: 5 } }];
      const r = seq[Math.min(nPurge, seq.length - 1)];
      nPurge++;
      return res(r.status, r.body);
    }
    if (method === "POST" || method === "PATCH") return res(200, { ok: true });
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

const posts = (c: Call[], re: RegExp) => c.filter((x) => x.method === "POST" && re.test(x.url));
const patches = (c: Call[], re: RegExp) => c.filter((x) => x.method === "PATCH" && re.test(x.url));

/** 实测（jsdom + antd 5.22）：afterEach 的 message.destroy() 并不把已画的
 *  .ant-message-notice 从 body 摘掉（EnvPanel.test.tsx:121 的 toastText 只做
 *  toContain，累计无害；本文件有 not.toContain 断言，累计就是假红）。
 *  每用例开头给存量 notice 拍快照，newToasts 只认新长出来的那些。 */
let staleNotices: Set<Element> = new Set();
function snapshotToasts(): void {
  staleNotices = new Set(document.querySelectorAll(".ant-message-notice"));
}
function newToasts(): string {
  return Array.from(document.querySelectorAll(".ant-message-notice"))
    .filter((n) => !staleNotices.has(n))
    .map((n) => n.textContent ?? "")
    .join("|");
}

// ── fixtures：3 层嵌套（支付域>对账>日切）+ 独立根，一次覆盖多根/深层/叶子 ──
function node(id: string, name: string, count: number, children: ModNode[] = []): ModNode {
  return { id, parent_id: null, name, sort: 0, status: "normal", count, children };
}
const TREE: ModNode[] = [
  node("m1", "支付域", 3, [node("m2", "对账", 2, [node("m3", "日切", 1)])]),
  node("m4", "交易域", 0),
];
const RECYCLED: ModNode[] = [node("r9", "旧域", 0, [node("r10", "旧子", 0)])];

type TreeProps = ComponentProps<typeof ModuleTree>;

function renderTree(over: Partial<TreeProps> = {}) {
  const props: TreeProps = {
    projectId: "p1",
    tree: TREE,
    recycled: RECYCLED,
    inRecycled: false,
    onToggleRecycled: vi.fn(),
    selected: null,
    onSelect: vi.fn(),
    onChanged: vi.fn(),
    canManage: true,
    canCreate: true,
    ...over,
  };
  // motion:false（EnvPanel.test.tsx:132 同款）：jsdom 里 rc-motion 不完成，
  // Modal/Dropdown 开关断言会失真。
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ModuleTree {...props} />
    </ConfigProvider>
  );
}

/** 反选分支要 state 驱动（pages/api.tsx:324 真实用法：selected 来自 setModuleId），
 *  所以把 onSelect 回灌进 selected——组件受控高亮才会真的指在被点的行上。 */
function ControlledPage({ onSelect }: { onSelect: (id: string | null) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <span data-testid="sel">{sel === null ? "null" : sel}</span>
      <ModuleTree
        projectId="p1"
        tree={TREE}
        recycled={RECYCLED}
        inRecycled={false}
        onToggleRecycled={vi.fn()}
        selected={sel}
        onSelect={(id) => {
          setSel(id);
          onSelect(id);
        }}
        onChanged={vi.fn()}
        canManage
        canCreate
      />
    </ConfigProvider>
  );
}

/** rc-tree 标题在 .ant-tree-title；行容器是 .ant-tree-treenode。名字唯一才敢这么找。 */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const title = Array.from(container.querySelectorAll(".ant-tree-title"))
    .find((n) => (n.textContent ?? "").includes(name));
  if (!title) throw new Error(`树里没有「${name}」，现有：` +
    Array.from(container.querySelectorAll(".ant-tree-title")).map((n) => n.textContent).join("/"));
  return title.closest(".ant-tree-treenode") as HTMLElement;
}

/** antd Dropdown trigger=["hover"]：React 的 onMouseEnter 由 mouseover 衍生
 *  （StepListEditor.test.tsx:214 三件套注释同款），且 mouseEnterDelay≈0.15s。 */
async function openNodeMenu(name: string): Promise<void> {
  const btn = screen.getByLabelText("模块菜单-" + name);
  fireEvent.pointerOver(btn);
  fireEvent.mouseOver(btn);
  fireEvent.mouseEnter(btn);
  await waitFor(() => {
    expect(visibleMenuItems().length).toBeGreaterThan(0);
  }, { timeout: 4000 });
}

const visibleMenuItems = () => Array.from(document.querySelectorAll<HTMLElement>(
  ".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item"));

const menuItem = (text: string) =>
  visibleMenuItems().find((n) => (n.textContent ?? "").includes(text)) ?? null;

async function clickMenuItem(text: string): Promise<void> {
  const el = menuItem(text);
  if (!el) throw new Error(`菜单里没有「${text}」，现有：` + visibleMenuItems().map((n) => n.textContent).join("/"));
  fireEvent.click(el);
  await new Promise((r) => setTimeout(r, 30));
}

async function modalButton(re: RegExp): Promise<HTMLElement> {
  return screen.findByRole("button", { name: re }, { timeout: 2000 });
}

beforeEach(() => {
  cleanup();
  message.destroy();
  // Modal.confirm 二确挂在 body 自己的 root 里，RTL cleanup 拆不掉
  // （EnvPanel.test.tsx:172 注释同款）：残留会把下条用例的查询撞成 multiple。
  Modal.destroyAll();
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
  snapshotToasts();
});

afterEach(() => {
  cleanup();
  message.destroy();
  Modal.destroyAll();
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
});

describe("① 正常态/回收站态的渲染面", () => {
  it("默认导出挂进 DOM：__all 行 + 三行模块 + 计数徽标 + 标题「模块」", () => {
    mockBackend();
    const { container } = renderTree();
    expect(screen.getByTestId("module-tree")).not.toBeNull();
    expect(screen.getByTestId("module-all").textContent).toBe("全部接口");
    for (const n of ["支付域", "对账", "日切", "交易域"]) {
      expect(rowByName(container, n)).toBeTruthy();
    }
    // 徽标 = ModNode.count 原样（直属口径，见 shared/moduleTree.ts:20 注释）
    expect(rowByName(container, "支付域").querySelector(".ant-tag")!.textContent).toBe("3");
    expect(rowByName(container, "交易域").querySelector(".ant-tag")!.textContent).toBe("0");
    // countTip 没传时徽标不带 data-testid（ModuleTree.tsx:117-123 两个分支的差集）
    expect(screen.queryByTestId("module-count-支付域")).toBeNull();
  });

  it("深层嵌套：indent 数 = 深度-1；父节点可展开、叶子 switcher 是 noop", () => {
    mockBackend();
    const { container } = renderTree();
    expect(rowByName(container, "支付域").querySelectorAll(".ant-tree-indent-unit")).toHaveLength(0);
    expect(rowByName(container, "对账").querySelectorAll(".ant-tree-indent-unit")).toHaveLength(1);
    expect(rowByName(container, "日切").querySelectorAll(".ant-tree-indent-unit")).toHaveLength(2);
    // defaultExpandAll（ModuleTree.tsx:184）生效：深层节点不用点就在 DOM 里
    expect(rowByName(container, "支付域").querySelector(".ant-tree-switcher_open")).not.toBeNull();
    expect(rowByName(container, "日切").querySelector(".ant-tree-switcher-noop")).not.toBeNull();
  });

  it("回收站态：不画 __all、不画计数徽标、标题切「回收站」、按钮切「退出回收站」", () => {
    mockBackend();
    const { container } = renderTree({ inRecycled: true, canCreate: true });
    expect(screen.queryByTestId("module-all")).toBeNull();
    // 实测 DOM：<span class="ant-typography"><strong>回收站</strong></span>——
    // getByText 默认不让 .ant-typography 赢（文本被 strong 隔开），认 strong 本体。
    expect(screen.getByText("回收站", { selector: "strong" }).textContent).toBe("回收站");
    expect(screen.queryByTestId("module-create")).toBeNull(); // inRecycled 连新建钮也藏（:163）
    // 2026-11-22 设计改版：回收站切换从整行文字钮降为标题行的图标钮，文案移到
    // aria-label（可访问名不变）。契约仍是「切到回收站态后，这把钮说自己是退出」。
    expect(screen.getByTestId("module-recycled-toggle").getAttribute("aria-label")).toBe("退出回收站");
    expect(rowByName(container, "旧域").querySelectorAll(".ant-tag")).toHaveLength(0);
  });

  it("空回收站画 Empty「回收站是空的」；空正常树仍画 __all 行", () => {
    mockBackend();
    const { container } = renderTree({ inRecycled: true, recycled: [] });
    expect(screen.getByText("回收站是空的")).not.toBeNull();
    expect(container.querySelector(".ant-tree")).toBeNull();
    cleanup();

    renderTree({ tree: [] });
    expect(screen.getByTestId("module-all")).not.toBeNull();
    expect(screen.queryByText("回收站是空的")).toBeNull();
  });

  // 第二十六轮：回收站那句「是空的」此前只有两个输入（nodes 空 + inRecycled），
  // 而父页取树失败时 recycled 就停在初始 [] —— 于是故障也能凑齐这两个条件，
  // 把「没取到」演成「实测零条」（父页刷新失败刻意不清行，首屏就挂时无行可清）。
  it("取树失败：空回收站不说「回收站是空的」，改说这一栏不作数", () => {
    mockBackend();
    renderTree({ inRecycled: true, recycled: [], loadError: "网络不通" });
    expect(screen.queryByText("回收站是空的")).toBeNull();
    const tip = screen.getByTestId("module-tree-load-error");
    expect(tip.textContent).toContain("回收站没取到");
    expect(tip.textContent).toContain("空着不等于真的没有");
    cleanup();

    // 刷新才挂：下面还是上次取到的行，话要跟着改成「下面是上次取到的」
    renderTree({ inRecycled: true, loadError: "网络不通" });
    expect(screen.getByTestId("module-tree-load-error").textContent).toContain("下面是上次取到的");
    expect(screen.queryByText("回收站是空的")).toBeNull();
    cleanup();

    // 没传 loadError 的调用方（adbCases/uiCases 那两棵树）行为不变
    renderTree({ inRecycled: true, recycled: [] });
    expect(screen.queryByTestId("module-tree-load-error")).toBeNull();
    expect(screen.getByText("回收站是空的")).not.toBeNull();
  });

  it("countTip 传入时徽标带 data-testid 并浮出说明（R122 计数口径解释）", async () => {
    mockBackend();
    renderTree({ countTip: "只统计直属模块" });
    const tag = screen.getByTestId("module-count-支付域");
    expect(tag.textContent).toBe("3");
    fireEvent.mouseOver(tag);
    await waitFor(() => {
      const tip = document.querySelector(".ant-tooltip:not(.ant-tooltip-hidden) .ant-tooltip-inner");
      expect(tip?.textContent).toBe("只统计直属模块");
    }, { timeout: 4000 });
  });
});

describe("② 权限门：藏，不是禁（§11.5.1）", () => {
  it("canCreate=false：[新建] 消失、菜单只剩「重命名/放入回收站」", async () => {
    mockBackend();
    renderTree({ canCreate: false });
    expect(screen.queryByTestId("module-create")).toBeNull();
    await openNodeMenu("支付域");
    expect(menuItem("新建子模块")).toBeNull();
    expect(menuItem("重命名")).toBeTruthy();
    expect(menuItem("放入回收站")).toBeTruthy();
  });

  it("canManage=false：回收站把手消失、菜单只剩「新建子模块」（disabled 项一个都不许有）", async () => {
    mockBackend();
    renderTree({ canManage: false });
    expect(screen.queryByTestId("module-recycled-toggle")).toBeNull();
    expect(screen.getByTestId("module-create")).not.toBeNull();
    await openNodeMenu("支付域");
    expect(menuItem("重命名")).toBeNull();
    expect(menuItem("放入回收站")).toBeNull();
    expect(menuItem("新建子模块")).toBeTruthy();
    // 「藏」不是「禁」：出现任何 disabled 菜单项都算违反规则
    expect(document.querySelectorAll(
      ".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-disabled")).toHaveLength(0);
  });

  it("双关：行内菜单钮整个不存在（DOM 里数得出来）", () => {
    mockBackend();
    const { container } = renderTree({ canManage: false, canCreate: false });
    expect(container.querySelectorAll("button[aria-label^='模块菜单-']")).toHaveLength(0);
    expect(screen.queryByTestId("module-create")).toBeNull();
    expect(screen.queryByTestId("module-recycled-toggle")).toBeNull();
  });

  it("回收站里 canManage=false：恢复/彻底删除钮消失；=true 时两枚都在", () => {
    mockBackend();
    const { container, unmount } = renderTree({ inRecycled: true, canManage: false });
    expect(container.querySelectorAll("button[aria-label^='恢复-']")).toHaveLength(0);
    expect(screen.queryByTestId("module-purge-旧域")).toBeNull();
    unmount();

    renderTree({ inRecycled: true, canManage: true });
    expect(screen.getByLabelText("恢复-旧域")).not.toBeNull();
    expect(screen.getByLabelText("恢复-旧子")).not.toBeNull();
    expect(screen.getByTestId("module-purge-旧子")).not.toBeNull();
  });
});

describe("③ 新建（根 / 子模块）", () => {
  it("[新建] → 弹窗「新建模块」→ POST /api-modules body {project_id,parent_id:null,name} + toast + onChanged", async () => {
    const calls = mockBackend();
    const onChanged = vi.fn();
    renderTree({ onChanged });
    fireEvent.click(screen.getByTestId("module-create"));
    const input = await screen.findByTestId("module-name");
    fireEvent.change(input, { target: { value: "  新域  " } }); // trim 在 submitPrompt:55
    fireEvent.click(await modalButton(/^保\s*存$/));

    await waitFor(() => expect(posts(calls, /^\/api\/v1\/api-modules$/)).toHaveLength(1));
    expect(JSON.parse(posts(calls, /^\/api\/v1\/api-modules$/)[0].body!))
      .toEqual({ project_id: "p1", parent_id: null, name: "新域" });
    await waitFor(() => expect(newToasts()).toContain("模块已创建"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("菜单「新建子模块」→ parent_id=该节点 id，弹窗标题切「新建子模块」", async () => {
    const calls = mockBackend();
    renderTree();
    await openNodeMenu("对账");
    await clickMenuItem("新建子模块");
    const input = await screen.findByTestId("module-name");
    fireEvent.change(input, { target: { value: "月结" } });
    fireEvent.click(await modalButton(/^保\s*存$/));
    await waitFor(() => expect(posts(calls, /^\/api\/v1\/api-modules$/)).toHaveLength(1));
    expect(JSON.parse(posts(calls, /^\/api\/v1\/api-modules$/)[0].body!))
      .toEqual({ project_id: "p1", parent_id: "m2", name: "月结" });
  });

  it("名字留空点保存 → toast「名称不能为空」，一条请求不发、窗不关", async () => {
    const calls = mockBackend();
    renderTree();
    fireEvent.click(screen.getByTestId("module-create"));
    await screen.findByTestId("module-name");
    fireEvent.click(await modalButton(/^保\s*存$/));
    await waitFor(() => expect(newToasts()).toContain("名称不能为空"));
    expect(calls).toHaveLength(0);
    expect(screen.getByTestId("module-name")).not.toBeNull();
  });

  it("保存连点两次 → saving 守卫(:54)只发一条 POST", async () => {
    const calls = mockBackend();
    renderTree();
    fireEvent.click(screen.getByTestId("module-create"));
    const input = await screen.findByTestId("module-name");
    fireEvent.change(input, { target: { value: "X" } });
    const ok = await modalButton(/^保\s*存$/);
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(newToasts()).toContain("模块已创建"));
    expect(posts(calls, /^\/api\/v1\/api-modules$/)).toHaveLength(1);
  });
});

describe("④ 重命名", () => {
  it("菜单「重命名」→ PATCH /api-modules/m2 body {project_id,name} + toast「已重命名」+ onChanged", async () => {
    const calls = mockBackend();
    const onChanged = vi.fn();
    renderTree({ onChanged });
    await openNodeMenu("对账");
    await clickMenuItem("重命名");
    const input = (await screen.findByTestId("module-name")) as HTMLInputElement;
    expect(input.value).toBe("对账"); // setPrompt 预填原名（:136）
    fireEvent.change(input, { target: { value: "对账中心" } });
    fireEvent.click(await modalButton(/^保\s*存$/));

    await waitFor(() => expect(patches(calls, /^\/api\/v1\/api-modules\/m2$/)).toHaveLength(1));
    expect(JSON.parse(patches(calls, /^\/api\/v1\/api-modules\/m2$/)[0].body!))
      .toEqual({ project_id: "p1", name: "对账中心" });
    expect(posts(calls, /^\/api\/v1\/api-modules$/)).toHaveLength(0); // 改名不许走创建动词
    await waitFor(() => expect(newToasts()).toContain("已重命名"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("预填原名一字不改直接保存 → 照样 PATCH（无脏检查，现状 pin）", async () => {
    const calls = mockBackend();
    renderTree();
    await openNodeMenu("支付域");
    await clickMenuItem("重命名");
    const input = (await screen.findByTestId("module-name")) as HTMLInputElement;
    expect(input.value).toBe("支付域");
    fireEvent.click(await modalButton(/^保\s*存$/));
    await waitFor(() => expect(patches(calls, /\/m1$/)).toHaveLength(1));
  });
});

describe("⑤ 软删进回收站（两步确认 + 选中复位守卫）", () => {
  it("菜单「放入回收站」→ 二确讲清后果 → POST /api-modules/m4/delete body {project_id} + toast + onChanged", async () => {
    const calls = mockBackend();
    const onChanged = vi.fn();
    renderTree({ onChanged });
    await openNodeMenu("交易域");
    await clickMenuItem("放入回收站");
    // 删请求在二确确认前一条都不许发
    expect(posts(calls, /\/delete$/)).toHaveLength(0);
    expect(await screen.findByText("模块进回收站？", { selector: ".ant-modal-confirm-title" })).not.toBeNull();
    // content 里点名资产名词「接口不会被删」（noun 默认值 :44）
    expect(document.querySelector(".ant-modal-confirm-content")!.textContent).toContain("接口不会被删");
    fireEvent.click(await modalButton(/放入回收站/));

    await waitFor(() => expect(posts(calls, /\/api-modules\/m4\/delete$/)).toHaveLength(1));
    expect(JSON.parse(posts(calls, /\/delete$/)[0].body!)).toEqual({ project_id: "p1" });
    await waitFor(() => expect(newToasts()).toContain("已放入回收站"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("二确点[取消] → delete 零条、onChanged 不触发", async () => {
    const calls = mockBackend();
    const onChanged = vi.fn();
    renderTree({ onChanged });
    await openNodeMenu("交易域");
    await clickMenuItem("放入回收站");
    await screen.findByText("模块进回收站？", { selector: ".ant-modal-confirm-title" });
    fireEvent.click(await modalButton(/^取\s*消$/));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(calls, /\/delete$/)).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("删中的正是选中项 → onSelect(null) 复位；删的不是选中项 → 选中不动（:79 守卫）", async () => {
    mockBackend();
    const onSelectA = vi.fn();
    renderTree({ selected: "m4", onSelect: onSelectA });
    await openNodeMenu("交易域");
    await clickMenuItem("放入回收站");
    fireEvent.click(await modalButton(/放入回收站/));
    await waitFor(() => expect(onSelectA).toHaveBeenCalledWith(null));

    cleanup();
    message.destroy();
    Modal.destroyAll();
    document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());

    mockBackend();
    const onSelectB = vi.fn();
    renderTree({ selected: "m1", onSelect: onSelectB }); // 选中在支付域，删交易域
    await openNodeMenu("交易域");
    await clickMenuItem("放入回收站");
    fireEvent.click(await modalButton(/放入回收站/));
    await waitFor(() => expect(newToasts()).toContain("已放入回收站"));
    expect(onSelectB).not.toHaveBeenCalled(); // 无守卫就变成：删谁都把选中打回「全部」
  });
});

describe("⑥ 回收站把手与恢复", () => {
  it("把手一次点击 = onToggleRecycled(翻转值) + onSelect(null)", () => {
    mockBackend();
    const onToggleRecycled = vi.fn();
    const onSelect = vi.fn();
    renderTree({ onToggleRecycled, onSelect, selected: "m1" });
    fireEvent.click(screen.getByTestId("module-recycled-toggle"));
    expect(onToggleRecycled).toHaveBeenCalledWith(true);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("恢复「旧子」→ POST /api-modules/r10/restore body {project_id} + toast「已恢复」+ onChanged", async () => {
    const calls = mockBackend();
    const onChanged = vi.fn();
    renderTree({ inRecycled: true, onChanged });
    fireEvent.click(screen.getByLabelText("恢复-旧子"));
    await waitFor(() => expect(posts(calls, /\/api-modules\/r10\/restore$/)).toHaveLength(1));
    expect(JSON.parse(posts(calls, /\/restore$/)[0].body!)).toEqual({ project_id: "p1" });
    await waitFor(() => expect(newToasts()).toContain("已恢复"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("⑦ 彻底删除：手输名字守卫 + 回执拼句", () => {
  it("确认钮 disabled 到 purgeName 逐字相等：前缀/尾空格都不放行，逐字后 POST purge body {project_id,confirm_name}", async () => {
    const calls = mockBackend();
    const onChanged = vi.fn();
    const onSelect = vi.fn();
    renderTree({ inRecycled: true, selected: "r9", onChanged, onSelect });
    fireEvent.click(screen.getByTestId("module-purge-旧域"));
    await screen.findByTestId("module-purge-confirm");

    const ok = screen.getByTestId("module-purge-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(true); // :210 disabled: purgeName !== purge.name
    const input = screen.getByTestId("module-purge-confirm") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "旧" } }); // 前缀不放行
    expect(ok.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "旧域 " } }); // 尾空格不放行（!== 严格比较）
    expect(ok.disabled).toBe(true);
    fireEvent.click(ok); // disabled 上连点也不许发请求
    expect(posts(calls, /\/purge$/)).toHaveLength(0);

    fireEvent.change(input, { target: { value: "旧域" } });
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);
    await waitFor(() => expect(posts(calls, /\/api-modules\/r9\/purge$/)).toHaveLength(1));
    // confirm_name 送的是模块本名（state.purge.name），不是输入框现值
    expect(JSON.parse(posts(calls, /\/purge$/)[0].body!))
      .toEqual({ project_id: "p1", confirm_name: "旧域" });
    await waitFor(() => expect(newToasts()).toContain("已彻底删除 2 个模块，5 个接口转为未分类"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(null); // 删的正是选中项 → 复位（:106）
  });

  it("回执缺陷家族回归（R112/R122）：UI 树 detached_elements+detached_cases 两侧都进 toast", async () => {
    mockBackend({ purgeResp: [{
      status: 200,
      body: { purged_modules: 1, detached_elements: 1, detached_cases: 2 },
    }] });
    renderTree({ inRecycled: true, apiBase: "/scenario-modules", noun: "元素", allLabel: "全部资产" });
    fireEvent.click(screen.getByTestId("module-purge-旧域"));
    await screen.findByTestId("module-purge-confirm");
    fireEvent.change(screen.getByTestId("module-purge-confirm"), { target: { value: "旧域" } });
    fireEvent.click(screen.getByTestId("module-purge-ok"));
    // 只认 detached_definitions/scenarios 的旧链会把这句算成 0（moduleTree.ts:66 注释的缺陷）
    await waitFor(() => expect(newToasts()).toContain(
      "已彻底删除 1 个模块，1 个元素转为未分类，2 条 UI 用例转为未分类"));
  });

  it("回执没有任何转出键 → toast 恰好「已彻底删除 2 个模块」，不挂空从句", async () => {
    mockBackend({ purgeResp: [{ status: 200, body: { purged_modules: 2 } }] });
    renderTree({ inRecycled: true });
    fireEvent.click(screen.getByTestId("module-purge-旧域"));
    await screen.findByTestId("module-purge-confirm");
    fireEvent.change(screen.getByTestId("module-purge-confirm"), { target: { value: "旧域" } });
    fireEvent.click(screen.getByTestId("module-purge-ok"));
    await waitFor(() => expect(newToasts()).toContain("已彻底删除 2 个模块"));
    expect(newToasts()).not.toContain("转为未分类");
  });

  it("服务端拒绝（confirm_name 硬校验在侧）→ 弹窗保持打开、不 onChanged、不关窗", async () => {
    const calls = mockBackend({ purgeResp: [{ status: 400, body: { code: "name_mismatch", message: "确认名不匹配" } }] });
    const onChanged = vi.fn();
    renderTree({ inRecycled: true, onChanged });
    fireEvent.click(screen.getByTestId("module-purge-旧域"));
    await screen.findByTestId("module-purge-confirm");
    fireEvent.change(screen.getByTestId("module-purge-confirm"), { target: { value: "旧域" } });
    fireEvent.click(screen.getByTestId("module-purge-ok"));
    await waitFor(() => expect(newToasts()).toContain("确认名不匹配"));
    // catch 注释说「保持弹窗打开」（:108）——用户能改名重试或取消
    expect(screen.getByTestId("module-purge-confirm")).not.toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(posts(calls, /\/purge$/)).toHaveLength(1);
  });

  it("彻底删除弹窗[取消] → 零请求；重开时确认框回到未输入态（:152 setPurgeName('')）", async () => {
    const calls = mockBackend();
    renderTree({ inRecycled: true });
    fireEvent.click(screen.getByTestId("module-purge-旧域"));
    await screen.findByTestId("module-purge-confirm");
    fireEvent.change(screen.getByTestId("module-purge-confirm"), { target: { value: "旧域" } });
    fireEvent.click(await modalButton(/^取\s*消$/));
    expect(posts(calls, /\/purge$/)).toHaveLength(0);
    fireEvent.click(screen.getByTestId("module-purge-旧域"));
    expect((screen.getByTestId("module-purge-confirm") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("module-purge-ok") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("⑧ 场景树复用（apiBase/noun/allLabel）与选中回调", () => {
  it("apiBase/noun/allLabel 三个 override 各改各的：端点前缀、回执名词、__all 文案", async () => {
    const calls = mockBackend();
    const { container } = renderTree({ apiBase: "/scenario-modules", noun: "场景", allLabel: "全部场景" });
    expect(screen.getByTestId("module-all").textContent).toBe("全部场景");
    fireEvent.click(screen.getByTestId("module-create"));
    fireEvent.change(await screen.findByTestId("module-name"), { target: { value: "S" } });
    fireEvent.click(await modalButton(/^保\s*存$/));
    await waitFor(() => expect(posts(calls, /^\/api\/v1\/scenario-modules$/)).toHaveLength(1));
    // 软删也换前缀
    await openNodeMenu("支付域");
    await clickMenuItem("放入回收站");
    fireEvent.click(await modalButton(/放入回收站/));
    await waitFor(() => expect(posts(calls, /^\/api\/v1\/scenario-modules\/m1\/delete$/)).toHaveLength(1));
    // 二确文案里的名词跟着 noun 走
    expect(document.querySelector(".ant-modal-confirm-content")!.textContent).toContain("场景不会被删");
    expect(container.querySelector(".ant-tree")).not.toBeNull();
  });

  it("点模块行 onSelect(id)；点 __all 或再次点已选中行 → onSelect(null)（:189-192 的 keys 归一）", () => {
    mockBackend();
    const onSelect = vi.fn();
    const { container } = renderTree({ onSelect });
    fireEvent.click(rowByName(container, "对账").querySelector(".ant-tree-node-content-wrapper")!);
    expect(onSelect).toHaveBeenLastCalledWith("m2");

    onSelect.mockClear();
    fireEvent.click(screen.getByTestId("module-all"));
    expect(onSelect).toHaveBeenLastCalledWith(null); // key==="__all" 归一（:191）
  });

  it("受控页面里再点已选中行 → rc-tree 反选 → onSelect(null)：keys=[] 分支", () => {
    mockBackend();
    // 反选要求 selectedKeys 真的指在该行上——真实调用方（pages/api.tsx）是 state 驱动，
    // 直接 render 固定 selected=null 时 rc-tree 永远不认识「已选中」，反选分支不可达。
    const onSelect = vi.fn();
    const { container } = render(
      <ControlledPage onSelect={onSelect} />
    );
    fireEvent.click(rowByName(container, "交易域").querySelector(".ant-tree-node-content-wrapper")!);
    expect(onSelect).toHaveBeenLastCalledWith("m4");
    onSelect.mockClear();
    fireEvent.click(rowByName(container, "交易域").querySelector(".ant-tree-node-content-wrapper")!);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("selected 受控高亮只落在一行（selectedKeys :183）", () => {
    mockBackend();
    const { container } = renderTree({ selected: "m4" });
    const selected = container.querySelectorAll(".ant-tree-node-selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("交易域");
  });
});
