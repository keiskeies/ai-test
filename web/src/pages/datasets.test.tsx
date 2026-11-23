// 数据集页的角色门控测试（一期 DoD 第 3 条 UI 面补洞）。
// 三个门（datasets.tsx:22-24）：api:dataset:create → [新建]；api:dataset:delete → 行删除列；
// create|update → 网格行删除列。全部是「隐藏不是禁用」（同 uiElements.tsx 头部口径）。
// 三条钉：READONLY 写控件不在 DOM；PROJECT_ADMIN 都在；换显式 my_perms 让新建回来
// （证明按钮跟权限位走，不跟 role 字符串走）。
// 第二轮补三钉：ds-held（:111 scenario_held 守卫的锁标记 + :120 删除文案分叉）、
// ds-editor（:178 sel===null 两侧 + 内部有序内容）、ds-paste-modal（okText=导入、
// 确认导入的 payload 逐字段进 PATCH、取消不发请求）。
// 第二十三轮补四处「文案 > 代码」差集钉：列表取失败不报 0（failed 态，仿 reports.tsx）、
// 2000 行封顶进 toast/预览（PasteResult.capped）、删除气泡按 used_by 分叉（后端必 409）、
// 重复列名的真实后果是「保存被拦下」而不是「后者覆盖前者」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigProvider } from "antd";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import DatasetsPage from "./datasets";
import { useAuth } from "../auth/store";

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

const ITEMS = [
  { id: "d1", project_id: "p1", name: "订单参数", columns: ["order_id", "status"],
    rows: [["1", "PAID"], ["2", "NEW"]], row_count: 2, used_by: 0, scenario_held: false },
];

// d2：used_by 照旧 0，但被未回收场景扣着（scenario_held）→ 只有它该带锁（:111 守卫）
const HELD_ITEMS = [
  ...ITEMS,
  { id: "d2", project_id: "p1", name: "退款参数", columns: ["refund_id"],
    rows: [["7"], ["8"], ["9"]], row_count: 3, used_by: 0, scenario_held: true },
];

// 第 3 个数据格溢出：解析要截掉（:34），截没截在保存请求体里见真章。
// 粘进来的值（a/b、7/8）与 d1 自带的（order_id/1）刻意不同名，导入覆盖没覆盖一眼可辨。
const PASTE_TSV = "a\tb\n7\tX\n8\tY\tZ";

// d1 被 2 条活用例绑着：后端 data_set_delete 对 used_by≥1 必 409（case_services.py:518-529），
// 删除气泡必须在点之前就说「会被拦下」，而不是许诺一个发生不了的「失去数据源」。
const USED_ITEMS = [
  { ...ITEMS[0], used_by: 2 },
  { ...ITEMS[0], id: "d2", name: "退款参数", used_by: 0 },
];

// 2001 行 = MAX_ROWS+1：第 2001 行被 csv.ts 的封顶砍掉，页面必须播报（静默改数据比报错更糟）
const BIG_TSV = "k\tv\n" + Array.from({ length: 2001 }, (_, i) => i + "\tx").join("\n");
// 列头重复：后端 _validate_table 按「列名不能重复」422，这样的表存不回去
const DUP_TSV = "a\ta\n1\t2\n3\t4";

// calls 带 body：粘贴导入→保存的请求体必须逐字段可查（ds-paste-modal 钉 payload）。
const calls: { url: string; method: string; body?: unknown }[] = [];

// D223：数据集页工具栏要的 /filter-meta（形状与后端 filter_registry 一致）。
// supported_view_types 必须含 dataset，否则工具栏画成「本页不支持」——
// 那会把「桩没 mock 到」演成「功能不存在」。
const DATASET_META = {
  view_type: "dataset",
  fields: [
    { field: "name", label: "数据集名称", kind: "text",
      ops: ["CONTAINS", "EQUALS", "IN", "NOT_CONTAINS", "NOT_EQUALS", "NOT_IN"] },
    { field: "created_at", label: "创建时间", kind: "time",
      ops: ["EQUALS", "GT", "LT", "BETWEEN", "NOT_EQUALS"] },
  ],
  supported_view_types: ["dataset"],
  view_label: "数据集",
  operators: [], labels: {}, kinds: {}, unavailable: {},
};

function mockBackend(items = ITEMS, opts: { listFails?: boolean } = {}) {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const resp = (json: unknown) =>
      ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
    if (url.includes("/filter-meta")) return resp(DATASET_META);
    if (url.includes("/saved-views")) return resp([]);
    if (url.includes("/datasets?") && method === "GET") {
      if (opts.listFails) throw new TypeError("Failed to fetch"); // 断网/挂断在 fetch 层，同真实网络错误
      return resp({ items, next_cursor: null });
    }
    if (url.includes("/datasets/") && method === "PATCH") {
      return resp({ ok: true }); // save() 不读响应体，给个壳即可
    }
    if (url.endsWith("/delete") && method === "POST") {
      return resp({ ok: true }); // remove() 只关心成没成
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

/** 弹层离开动画在 jsdom 不保证完成：用 querySelectorAll + find 取「目标那一条」，
 *  不吃上一个气泡可能残留的旧节点。 */
function popTitles(): string[] {
  return Array.from(document.querySelectorAll(".ant-popconfirm-title"))
    .map((el) => el.textContent ?? "");
}

function toastText(): string {
  return Array.from(document.querySelectorAll(".ant-message")).map((n) => n.textContent).join("|");
}

/** 只读本用例新出现的 toast（静态 message 跨用例残留，同 MembersTab.test.tsx 的口径）：
 *  jsdom 里 notice 节点只增不减，按「快照定位 + 截尾」取增量是确定性的。 */
function toastSince(base: string): () => string {
  return () => {
    const t = toastText();
    const i = t.indexOf(base);
    return i >= 0 ? t.slice(i + base.length) : t;
  };
}

// 两字按钮被 antd 插气口（「导 入」），去空白再比。
const norm = (s: string | null) => (s ?? "").replace(/\s+/g, "");

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("datasets 权限门（create/update/delete 三处隐藏）", () => {
  it("READONLY：[新建] 与行删除都不在 DOM；点行仍可打开查看（读面不动）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    expect(screen.queryByTestId("ds-new")).toBeNull();
    expect(screen.queryByTestId("ds-del")).toBeNull();
    // 读面：行照开，编辑器（只读查看）出现
    fireEvent.click(screen.getByTestId("ds-row"));
    await waitFor(() => expect(screen.getByTestId("ds-name")).not.toBeNull());
    // 网格行删除列（canUpdate||canCreate）也不渲染（aria-label 只到「删第N行」）
    expect(screen.queryByLabelText("删第1行")).toBeNull();
  });

  it("PROJECT_ADMIN：新建在、行删除在、打开后网格行删除在", async () => {
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-new")).not.toBeNull());
    // ds-del 挂在行内，而「ds-new 在场」只证明权限门同步渲染过——列表还在飞时它已在 DOM。
    // 等待点挪到行内容本体（同文件另两条用例的 ds-rows-tag 姿势）。
    await screen.findByTestId("ds-rows-tag");
    expect(screen.getByTestId("ds-del")).not.toBeNull();
    fireEvent.click(screen.getByTestId("ds-row"));
    await waitFor(() => expect(screen.getByTestId("ds-cell-0-0")).not.toBeNull());
    expect(screen.getByLabelText("删第1行")).not.toBeNull();
  });

  it("换显式 my_perms（dataset read+create，无 delete）：新建回来、删除依旧不在——跟位走", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY",
      my_perms: ["api:dataset:read", "api:dataset:create", "-system:*"] } });
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-new")).not.toBeNull());
    expect(screen.queryByTestId("ds-del")).toBeNull();
  });
});

// ds-held（datasets.tsx:111-115 锁标记）：守卫是 r.scenario_held——used_by=0 也可能被
// 未回收场景扣着（:105-106 的注释：缺了它删除徽标会说谎）。两侧：held 行有且仅有 1 把锁、
// 另一行没有；全 false 时 0 把。用户可见后果在删除气泡分叉：held 行「现在删不掉」，
// used_by>0 行「删除会被拦下」（后端 data_set_delete 必 409），used_by=0 行「没有未回收
// 用例绑着它 + 回收站绑定恢复前需重新绑定」（D124：旧句「不影响任何用例」对回收绑定是假话）。
describe("ds-held：scenario_held 锁标记与删除后果（:111/:120）", () => {
  it("ds-held：held 行恰好 1 把锁且挂在退款参数行（used_by 同为 0 的普通行没锁）；删除气泡对 held 行说「现在删不掉」，对 used_by=0 普通行说「没有未回收用例绑着它」并点明回收站绑定恢复前需重新绑定，确认才发 1 次 delete（只发 d2）", async () => {
    mockBackend(HELD_ITEMS);
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ds-row")).toHaveLength(2));
    // 有的一侧：全表只有 held 行这把锁，且它在 d2（退款参数）行内而不是 d1 行内
    const locks = screen.getAllByTestId("ds-held");
    expect(locks).toHaveLength(1);
    const rows = screen.getAllByTestId("ds-row");
    expect(rows[1].textContent).toContain("退款参数");
    expect(within(rows[1]).getByTestId("ds-held")).toBe(locks[0]);
    expect(within(rows[0]).queryByTestId("ds-held")).toBeNull();
    expect(rows[0].textContent).toContain("订单参数");

    // 锁的用户可见后果：held 行的删除气泡换文案——明说「现在删不掉」（徽标 0 也不说谎）；
    // 按钮不被前端吞掉，确认仍发 delete POST（真正拦下的是后端 409）。
    expect(popTitles()).toHaveLength(0); // 没点开前没有气泡
    const delBtns = screen.getAllByTestId("ds-del");
    expect(delBtns).toHaveLength(2);
    fireEvent.click(delBtns[1]);
    await waitFor(() => expect(
      popTitles().some((t) => t.includes("退款参数") && t.includes("还被场景引用") && t.includes("现在删不掉")),
    ).toBe(true));
    const postCount = () => calls.filter((c) => c.method === "POST" && c.url.includes("/delete")).length;
    expect(postCount()).toBe(0); // 没确认就一条 delete 都没有
    // 气泡钮序：[取消][删除]（ok 在右，antd Popconfirm 结构）
    fireEvent.click(document.querySelector(".ant-popconfirm-buttons")!.querySelectorAll("button")[1]!);
    await waitFor(() => expect(postCount()).toBe(1));
    const body = calls.find((c) => c.url.includes("/datasets/d2/delete"))!.body as Record<string, unknown>;
    expect(body).toEqual({ project_id: "p1" }); // 删的是 d2，body 带 project_id
    expect(calls.some((c) => c.url.includes("/datasets/d1/delete"))).toBe(false);

    // 无的一侧（文案分叉）：used_by=0 的普通行气泡说的是真后果——没有未回收绑定，
    // 但回收站里绑它的用例恢复时会 409 dataset_missing，得先重新绑定（D124）。
    fireEvent.click(screen.getAllByTestId("ds-del")[0]!);
    await waitFor(() => expect(
      popTitles().some((t) => t.includes("订单参数") && t.includes("没有未回收用例绑着它")
        && t.includes("回收站") && t.includes("重新绑定")),
    ).toBe(true));
    const plain = popTitles().find((t) => t.includes("订单参数"))!;
    expect(plain).not.toContain("删不掉");
    expect(plain).not.toContain("失去数据源"); // 旧的假话不许回来：used_by=0 时根本没有未回收绑定可失去
    expect(plain).not.toContain("不影响任何用例"); // D124 旧假话：对回收绑定为假，不许回来
    expect(plain).not.toMatch(/\d+\s*条/); // 前端拿不到回收绑定数，不许编「N 条」
  });

  it("ds-held 无的一侧：后端 scenario_held 全 false 时整页 0 把锁", async () => {
    mockBackend(ITEMS);
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    expect(screen.queryAllByTestId("ds-held")).toHaveLength(0);
  });

  it("ds-editor：未选中没有编辑器（只有占位 Empty）→ 点行出现（名称载入、网格在工具条后、变量名提示收尾）→ 点「关闭」回占位；新建（0 列）编辑器换成 Alert 且加行钮消失", async () => {
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    // 无的一侧：sel===null → 只有占位提示，编辑器整体不在 DOM
    expect(screen.queryByTestId("ds-editor")).toBeNull();
    expect(screen.getByText("左侧选一个数据集，或新建一个")).not.toBeNull();

    // 有的一侧：点行 → 编辑器出现，且它拥有的内容按文档序：工具条 → 网格 → 变量名提示
    fireEvent.click(screen.getByTestId("ds-row"));
    const editor = await screen.findByTestId("ds-editor");
    const nameInput = within(editor).getByTestId("ds-name");
    expect((nameInput as HTMLInputElement).value).toBe("订单参数"); // 打开载入的是被点的行
    expect(within(editor).getByTestId("ds-paste")).not.toBeNull();
    expect(within(editor).getByTestId("ds-save")).not.toBeNull();
    expect(screen.queryByText("还没有列：点「粘贴表格」从 Excel/CSV 贴进来（首行=列名），或者手动加列")).toBeNull();
    // 网格在编辑器内部：2 行 × 2 列 + 行删除钮，单元格值来自 d1.rows
    const cell = within(editor).getByTestId("ds-cell-0-0");
    expect((cell as HTMLInputElement).value).toBe("1");
    expect(within(editor).queryByTestId("ds-cell-2-0")).toBeNull(); // 2 行封顶，不多渲染
    expect(within(editor).getAllByRole("button", { name: /删第/ })).toHaveLength(2);
    // antd 给两字按钮插气口（「加 行」），getByText("加行") 永远查不到——按去空白比。
    expect(within(editor).queryAllByRole("button")
      .some((b) => (b.textContent ?? "").replace(/\s+/g, "") === "加行")).toBe(true); // columns>0 → 加行钮（:188）
    // 顺序：名称 < 粘贴 < 保存 < 首个单元格 < 变量名提示（把 :182-202 的版式钉住）
    const hint = within(editor).getByText(/列名就是变量名/);
    const all = Array.from(editor.querySelectorAll("*"));
    const idx = (el: Element) => all.indexOf(el);
    expect(idx(within(editor).getByTestId("ds-paste"))).toBeGreaterThan(idx(nameInput));
    expect(idx(within(editor).getByTestId("ds-save"))).toBeGreaterThan(idx(within(editor).getByTestId("ds-paste")));
    expect(idx(cell)).toBeGreaterThan(idx(within(editor).getByTestId("ds-save")));
    expect(idx(hint)).toBeGreaterThan(idx(cell));

    // 关编辑器：点「关闭」→ 回到占位，编辑器整体卸载（同一两侧守卫的反向）
    fireEvent.click(within(editor).getByRole("button", { name: /关\s*闭/ }));
    await waitFor(() => expect(screen.queryByTestId("ds-editor")).toBeNull());
    expect(screen.getByText("左侧选一个数据集，或新建一个")).not.toBeNull();

    // 新建（0 列）：编辑器在，但网格位换成 Alert、加行钮消失（:188/:192 的容器内分叉）。
    // 「消失」这一侧才是有牙的腿：摘掉 `columns.length > 0 &&` 只会让这里红；
    // 上面「有的一侧」那条恒绿，是搭车断言，别当独立证据。
    fireEvent.click(screen.getByTestId("ds-new"));
    const fresh = await screen.findByTestId("ds-editor");
    expect(within(fresh).queryByTestId("ds-cell-0-0")).toBeNull();
    expect(within(fresh).getByText("还没有列：点「粘贴表格」从 Excel/CSV 贴进来（首行=列名），或者手动加列")).not.toBeNull();
    expect(within(fresh).queryAllByRole("button")
      .some((b) => (b.textContent ?? "").replace(/\s+/g, "") === "加行")).toBe(false);
  });
});

// 对话框页脚的裸按钮：okText/cancelText 只能从渲染后的 footer 取证（okButtonProps 的
// data-testid 会被 antd 的 cloneElement 吞掉，落不到 DOM——同 UserImportWizard 的页脚口径）。
const footerButtons = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-footer button"));

  it("ds-paste-modal：okText 是「导入」——确认后粘贴的列/行（截断溢出格）逐字段进 PATCH body；取消则窗关、零写入、编辑器还是原值、重开是空框", async () => {
    mockBackend();
    // motion:false：destroyOnHidden 的窗在 jsdom 里 leave 动画不完成、节点赖着不走
    // （同 CaseList.test.tsx:77 记过的坑），关掉才能真断「卸载了」。
    render(
      <MemoryRouter>
        <ConfigProvider theme={{ token: { motion: false } }}>
          <DatasetsPage />
        </ConfigProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    fireEvent.click(screen.getByTestId("ds-row"));
    await screen.findByTestId("ds-editor");

    // 弹窗是 open={pasteOpen} + destroyOnHidden：没点「粘贴表格」时整个对话框不挂载，
    // 这一点先钉住，否则下面「关窗 = 卸载」那条等于没测（一直就没挂过）。
    expect(screen.queryByTestId("ds-paste-modal")).toBeNull();
    // 取消的一侧先走一遍：只填文本不确认 → [取消] 关窗、不发任何写请求、编辑器原值
    fireEvent.click(screen.getByTestId("ds-paste"));
    expect(screen.getByTestId("ds-paste-modal")).not.toBeNull(); // 开窗：testid 落在对话框根上
    expect(screen.queryByTestId("ds-paste-preview")).toBeNull(); // 空文本没有预览
    fireEvent.change(screen.getByTestId("ds-paste-text"), { target: { value: PASTE_TSV } });
    await waitFor(() => expect(screen.getByTestId("ds-paste-preview").textContent)
      .toContain("解析出 2 行 × 2 列"));
    expect(screen.getByTestId("ds-paste-preview").textContent).toContain("第 2 行比列头长");
    const ok = footerButtons().find((b) => norm(b.textContent) === "导入")!; // okText=「导入」（两字被 antd 空格成「导 入」，去空白再比）
    expect(footerButtons().some((b) => norm(b.textContent) === "取消")).toBe(true);
    expect((ok as HTMLButtonElement).disabled).toBe(false); // 解析出列才可点
    fireEvent.click(footerButtons().find((b) => norm(b.textContent) === "取消")!);
    await waitFor(() => expect(screen.queryByTestId("ds-paste-text")).toBeNull()); // destroyOnHidden：关=卸载
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0); // 取消不发请求
    expect((screen.getByTestId("ds-name") as HTMLInputElement).value).toBe("订单参数");
    expect((screen.getByTestId("ds-cell-0-0") as HTMLInputElement).value).toBe("1");
    // 重开是空框（onCancel 后 pasteText 归零，:186 打开也重置）
    fireEvent.click(screen.getByTestId("ds-paste"));
    await waitFor(() => expect((screen.getByTestId("ds-paste-text") as HTMLTextAreaElement).value).toBe(""));
    expect(footerButtons().some((b) => norm(b.textContent) === "导入")).toBe(true);

    // 确认的一侧：重粘 → 点「导入」→ 网格换成解析结果 → 保存的 PATCH body 逐字段
    fireEvent.change(screen.getByTestId("ds-paste-text"), { target: { value: PASTE_TSV } });
    await waitFor(() => expect(screen.getByTestId("ds-paste-preview").textContent)
      .toContain("解析出 2 行 × 2 列"));
    fireEvent.click(footerButtons().find((b) => norm(b.textContent) === "导入")!);
    await waitFor(() => expect(screen.queryByTestId("ds-paste-text")).toBeNull()); // 导入即收窗
    expect((screen.getByTestId("ds-cell-0-0") as HTMLInputElement).value).toBe("7"); // 解析行覆盖旧 rows
    expect(screen.queryByTestId("ds-cell-2-0")).toBeNull();
    fireEvent.change(screen.getByTestId("ds-name"), { target: { value: "订单参数" } });
    fireEvent.click(screen.getByTestId("ds-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain("/datasets/d1");
    expect(patch.body).toEqual({
      project_id: "p1", name: "订单参数", dataset_id: "d1",
      columns: ["a", "b"],          // 列头是粘贴首行
      rows: [["7", "X"], ["8", "Y"]], // 溢出格「Z」被截断——body 里见真章
    });
    // okText 不再重申：窗已关（destroyOnHidden），页脚不在 DOM——它在 :262 与
    // 上面那次真实点击里已经钉过两次，这里再查一次只会恒假。
  });

// ── 第二十三轮 A：文案许诺了代码没做的事，四处逐条补钉 ──────────────────────────

describe("列表取失败 ≠ 没有数据集（load 的 failed 态）", () => {
  it("列表请求挂掉：空态说「没取到」而不是「还没有数据集」，页头不许把 0 当测量值", async () => {
    mockBackend(ITEMS, { listFails: true });
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    // ds-empty 是 Table 空态常驻壳：请求还在飞时它先画「还没有数据集」，失败文案要等
    // catch 把 failed 置上才换上（延迟探针 40ms 下实测读到旧文案）——等内容本身。
    const empty = await screen.findByTestId("ds-empty");
    await waitFor(() => expect(empty.textContent).toContain("数据集列表没取到"));
    expect(empty.textContent).not.toContain("还没有数据集");
    expect(screen.getByText("数据集（—）")).not.toBeNull(); // 「—」= 没查到，不是 0 条
    expect(screen.queryByText("数据集（0）")).toBeNull();
  });

  it("成功的一侧：正常加载仍然报「还没有数据集/数据集（N）」，失败话术不串台", async () => {
    mockBackend(ITEMS);
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    expect(screen.queryByTestId("ds-empty")).toBeNull(); // 有数据：没有空态可言
    expect(screen.getByText(/数据集（1）/)).not.toBeNull();
    expect(document.body.textContent).not.toContain("没取到");
    // 空列表但请求成功：这才是「还没有数据集」该出现的场合
    cleanup();
    mockBackend([]);
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    const empty = await screen.findByTestId("ds-empty");
    expect(empty.textContent).toContain("还没有数据集");
    expect(empty.textContent).not.toContain("没取到");
    expect(screen.getByText("数据集（0）")).not.toBeNull();
  });
});

describe("2000 行封顶不许静默（PasteResult.capped 的两处播报）", () => {
  it("粘 2001 行：预览警告「第 2001 行起没有导入」，导入 toast 也带同一句", async () => {
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    fireEvent.click(screen.getByTestId("ds-new"));
    await screen.findByTestId("ds-editor");
    const toastBase = toastText();
    fireEvent.click(screen.getByTestId("ds-paste"));
    fireEvent.change(screen.getByTestId("ds-paste-text"), { target: { value: BIG_TSV } });
    // 预览一侧：解析行数是砍后的 2000，且必须伴随「第 2001 行起没有导入」
    await waitFor(() => expect(screen.getByTestId("ds-paste-preview").textContent)
      .toContain("解析出 2000 行 × 2 列"));
    expect(screen.getByTestId("ds-paste-preview").textContent).toContain("第 2001 行起没有导入");
    // 导入一侧：成功 toast 里也得有这句，否则 3000 行的消失依旧无人认领
    fireEvent.click(footerButtons().find((b) => norm(b.textContent) === "导入")!);
    const since = toastSince(toastBase);
    await waitFor(() => expect(since()).toContain("超过 2000 行，第 2001 行起没有导入"));
    expect(since()).toContain("2000 行 × 2 列");
  });
});

describe("删除气泡按 used_by 分叉（后端 used_by≥1 必 409）", () => {
  it("used_by=2 的气泡说「2 条用例绑着它，删除会被拦下」；used_by=0 的气泡说「没有未回收用例绑着它」并点明回收站绑定恢复前需重新绑定——两句不许互换", async () => {
    mockBackend(USED_ITEMS);
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("ds-row")).toHaveLength(2));
    const rows = screen.getAllByTestId("ds-row");
    expect(rows[0].textContent).toContain("订单参数"); // used_by=2
    expect(rows[1].textContent).toContain("退款参数"); // used_by=0

    fireEvent.click(screen.getAllByTestId("ds-del")[0]!);
    await waitFor(() => expect(
      popTitles().some((t) => t.includes("订单参数") && t.includes("2 条用例绑着它") && t.includes("删除会被拦下")),
    ).toBe(true));
    // 许诺一个发生不了的后果 = 假话：409 之下没有用例「失去数据源」
    expect(popTitles().find((t) => t.includes("订单参数"))!).not.toContain("失去数据源");

    fireEvent.click(screen.getAllByTestId("ds-del")[1]!);
    await waitFor(() => expect(
      popTitles().some((t) => t.includes("退款参数") && t.includes("没有未回收用例绑着它")
        && t.includes("回收站") && t.includes("重新绑定")),
    ).toBe(true));
    const free = popTitles().find((t) => t.includes("退款参数"))!;
    expect(free).not.toContain("被拦下"); // 0 引用侧不许吓唬用户
    expect(free).not.toContain("失去数据源");
    expect(free).not.toContain("不影响任何用例"); // D124 旧假话：回收绑定恢复会 409，不许承诺「不影响」
    expect(free).not.toMatch(/\d+\s*条/); // 回收绑定数前端拿不到，不许编「N 条」
  });
});

// ── D223：数据集页的 D47-a 三件套（视图保存 / 高级搜索 / 列设置） ─────────────
describe("数据集 D223 高级搜索与列设置", () => {
  const lastListUrl = (): string => [...calls].reverse()
    .find((c) => c.method === "GET" && c.url.includes("/datasets?"))!.url;
  const listQuery = (): URLSearchParams => new URL(lastListUrl(), "http://x").searchParams;

  it("空条件不拼 filter；应用「数据集名称包含 参数」后下一次列表请求带条件 JSON", async () => {
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    // 空条件整个参数不上线（不是 filter=）
    expect(listQuery().has("filter")).toBe(false);
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "参数" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listQuery().get("filter")).toBeTruthy());
    // 字段名来自后端 meta 的第一项（name），前端不自列字段
    expect(JSON.parse(listQuery().get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "参数" }],
    });
  });

  it("列设置勾掉「引用」只藏那一列（名称表头原样）", async () => {
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    const thead = (): string => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("引用");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "引用"]);
    fireEvent.click(boxes[labels.indexOf("引用")]);
    await waitFor(() => expect(thead()).not.toContain("引用"));
    expect(thead()).toContain("名称");
  });
});

describe("重复列名的后果是「存不回去」，不是「后者覆盖前者」", () => {
  it("粘重复列名：预览 Alert 与导入 toast 都说「保存会被拦下：列名不能重复」，旧覆盖话术消失", async () => {
    mockBackend();
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("ds-rows-tag")).not.toBeNull());
    fireEvent.click(screen.getByTestId("ds-new"));
    await screen.findByTestId("ds-editor");
    const toastBase = toastText();
    fireEvent.click(screen.getByTestId("ds-paste"));
    fireEvent.change(screen.getByTestId("ds-paste-text"), { target: { value: DUP_TSV } });
    await waitFor(() => expect(screen.getByTestId("ds-paste-preview").textContent)
      .toContain("列名重复：a"));
    expect(screen.getByTestId("ds-paste-preview").textContent).toContain("保存会被拦下：列名不能重复");
    expect(screen.getByTestId("ds-paste-preview").textContent).not.toContain("后者覆盖前者");
    fireEvent.click(footerButtons().find((b) => norm(b.textContent) === "导入")!);
    const since = toastSince(toastBase);
    await waitFor(() => expect(since()).toContain("重复列名（a）"));
    expect(since()).toContain("保存会被拦下：列名不能重复");
    expect(since()).not.toContain("后者覆盖前者");
  });
});
