// ADB 用例列表页（§11.5.5）的组件测试（1D T9）。手法与 adbDevices.test.tsx 同款：
// fetch 全 mock 到 client 的 fetch 层、useAuth.setState 注项目/权限。
// 钉四件最容易坏的事：
// ① 「默认设备」列的两态（serial 原文 / 「任一空闲」）——执行策略不显示 = 用户不知道会打到哪台机器；
// ② 权限隐藏不是禁用：无 adb:case:create/delete 时按钮不在 DOM；
// ③ 回收站视图：恢复/彻底删除按权限出现，purge 必须逐字输名才放行；
// ④ 拉取失败出 Alert（「加载失败」），不画「还没有用例」的空态骗人。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Modal } from "antd";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import AdbCasesPage from "./adbCases";
import { useAuth } from "../auth/store";
import type { AdbCaseOut } from "../api/adbCase";

function adbCase(over: Partial<AdbCaseOut> = {}): AdbCaseOut {
  return {
    id: "c1", project_id: "p1", module_id: null, name: "登录冒烟", priority: "P1",
    enabled: true, steps: [], default_device: null, owner_id: null, project_public: true,
    status: "normal", step_count: 0, last_run_at: null, last_run_status: null,
    updated_by: null, created_at: null, updated_at: "2026-11-16T10:00:00+08:00", issues: [], ...over,
  };
}

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

// D217：ADB 页工具栏要的 /filter-meta（形状与后端 filter_registry 一致）。
// supported_view_types 必须含 adb_case，否则工具栏按「本页不支持」画——那会把
// 「桩没 mock 到」演成「功能不存在」。
const ADB_META = {
  view_type: "adb_case",
  fields: [
    { field: "name", label: "名称", kind: "text",
      ops: ["CONTAINS", "EMPTY", "EQUALS", "NOT_CONTAINS", "NOT_EQUALS", "NOT_EMPTY"] },
    { field: "priority", label: "优先级", kind: "enum",
      ops: ["EMPTY", "EQUALS", "IN", "NOT_EQUALS", "NOT_EMPTY"] },
  ],
  supported_view_types: ["adb_case"],
  view_label: "ADB 用例",
  operators: [], labels: {}, kinds: {}, unavailable: {},
};

// D47-b 步5a：记录本轮桩见过的所有列表 GET URL——D127 绊线「挂载稳定后恰好一条请求」
// 与「点一次页码恰好一条」都数它（runs.test.tsx 同款）。
let listUrls: string[] = [];

/** 从列表 URL 取 query（同 runs.test.tsx :138 的取法）。 */
function qsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

/** 每次调用现拷一份响应体（D127 桩纪律，runs.test.tsx :80-86 同款理由）：真 fetch 每次
 *  解析出一棵全新对象图，桩把同一对象反复交出，「响应→新 rows→load 换身份→effect 重跑」
 *  的无限回路就会藏进桩里（步3b 实测：线上必现、测试全绿）。桩不许比真接口更好说话。 */
const deepResp = (json: unknown, status = 200) =>
  ({ ok: status < 400, status,
    json: async () => JSON.parse(JSON.stringify(json)) as unknown }) as unknown as Response;

function mockBackend(pages: { normal: AdbCaseOut[]; recycled: AdbCaseOut[]; total?: number | null },
  opts: { failList?: boolean } = {}) {
  listUrls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/filter-meta")) return deepResp(ADB_META);
    if (url.includes("/saved-views")) return deepResp([]);
    if (url.includes("/projects/") && url.includes("/members")) {
      return deepResp({ items: [{ user_id: "u9", account: "lisi", name: "李四" }], next_cursor: null });
    }
    if (url.includes("/adb-cases?")) {
      if (opts.failList) {
        return deepResp({ code: "db_error", message: "库挂了", details: null }, 500);
      }
      listUrls.push(url);
      // 桩按真实 query 参数切片（current/size/recycled）：永远交出同一批行，
      // 「点第 2 页行没换」这类 bug 就测不出（桩纪律，runs.test.tsx 同款）。
      const q = qsOf(url);
      const pool = q.get("recycled") === "true" ? pages.recycled : pages.normal;
      const cur = Number(q.get("current") ?? "1");
      const size = Number(q.get("size") ?? "20");
      const items = pool.slice((cur - 1) * size, (cur - 1) * size + size);
      return deepResp(pages.total === undefined
        ? { items, next_cursor: null }
        : { items, next_cursor: null, total: pages.total });
    }
    throw new Error("未 mock 的请求: " + url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cleanup();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("ADB 用例列表", () => {
  it("默认设备列两态 + 负责人查名 + 最近结果词表；页标题契约", async () => {
    mockBackend({ normal: [
      adbCase(),
      adbCase({ id: "c2", name: "安装巡检", default_device: "192.168.1.21:5555",
        owner_id: "u9", last_run_status: "failed", enabled: false }),
    ], recycled: [] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    // 两行都挂同名 testid：用 findAll（getByTestId 遇到多匹配会抛）
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(2));
    // D47-b 步5a：D127 绊线放在**全文件最早挂载列表**的这条用例上（runs/reports 同法，
    // 实测理由见计划 §六）：「取数落地把自己写的 rows 塞回 load 依赖」这种无限回路，
    // 若绊线只在后面的页码块里，前面每条用例都带着不停发请求的后台回路跑完——整文件
    // 从秒级拖到分钟级、最后仍由页码块报红，红得又慢又难归因。放最前 = 回路第一条就红，
    // 且只红一条。顺带钉①：挂载首发恰好 current=1&size=20、任何一条不带 cursor。
    await new Promise((r) => setTimeout(r, 300));
    expect(listUrls).toHaveLength(1);
    const q0 = qsOf(listUrls[0]);
    expect(q0.get("current")).toBe("1");
    expect(q0.get("size")).toBe("20");
    expect(q0.has("cursor")).toBe(false);
    // 契约：根 testid + PageHead 标题（nav.spec.mjs 的断言面）
    expect(screen.getByTestId("page-adb-cases")).not.toBeNull();
    expect(document.querySelector(".tp-page-title")?.textContent).toBe("ADB 用例");
    // 任一空闲 vs 指定 serial
    expect(screen.getByTestId("page-adb-cases").textContent).toContain("任一空闲");
    expect(screen.getByTestId("page-adb-cases").textContent).toContain("192.168.1.21:5555");
    // 负责人查名（不是 uuid）；最近结果走 STATUSES（failed=断言失败）
    expect(document.body.textContent).toContain("李四");
    expect(document.body.textContent).toContain("断言失败");
    expect(document.body.textContent).toContain("未运行");
  });

  it("只读成员：新建按钮不渲染（隐藏不是禁用），空态话术换成「你没有新建权限」", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] } });
    mockBackend({ normal: [], recycled: [] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    // 等加载落定（空态话术出现）再钉按钮
    await waitFor(() => expect(document.body.textContent).toContain("你没有新建权限"));
    expect(screen.queryByTestId("adb-case-new")).toBeNull();
    expect(document.body.textContent).toContain("你没有新建权限");
  });

  it("回收站视图：恢复/彻底删除按权限出现；彻底删除要逐字输名才放行", async () => {
    // 夹具如实给 status:"recycled"：recycled=true 那一页后端只会回回收行
    // （case_services.py:120 按 status 过滤）——D180 后按钮逐行认 status，夹具说谎这里先红。
    const dead = adbCase({ id: "c9", name: "旧用例", status: "recycled" });
    mockBackend({ normal: [], recycled: [dead] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-case-recycled")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-case-restore-c9")).not.toBeNull());
    expect(screen.getByTestId("adb-case-purge-c9")).not.toBeNull();

    // 打开彻底删除：名字没输对之前「我已确认」按钮必须 disabled
    fireEvent.click(screen.getByTestId("adb-case-purge-c9"));
    await waitFor(() => expect(screen.getByTestId("adb-case-purge-confirm")).not.toBeNull());
    const ok = screen.getByTestId("adb-case-purge-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("adb-case-purge-confirm"), { target: { value: "旧用例" } });
    await waitFor(() => expect((screen.getByTestId("adb-case-purge-ok") as HTMLButtonElement).disabled).toBe(false));
  });

  it("回收站两列（§11.4.18）：删除人显人名不显 id、删除时间走换算；正常视图两列不出现", async () => {
    // updated_by 是 UUID：正常视图把它当「删除人」渲染是说谎（那是最后编辑人），
    // 所以这列只在 inRecycled 挂上（列定义处的守卫是这条钉的靶子）。
    const dead = adbCase({ id: "c9", name: "被删的用例", status: "recycled",
      updated_by: "u-deleter-uuid", updated_by_name: "回收的老王",
      updated_at: "2026-11-16T10:00:00+08:00" });
    const alive = adbCase({ id: "c1", name: "活着的用例",
      updated_by: "u-editor-uuid", updated_by_name: "还在编辑的老王",
      updated_at: "2026-11-16T09:00:00+08:00" });
    mockBackend({ normal: [alive], recycled: [dead] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    // 正常视图：列不在 DOM（testid 缺失 + 人名不露出，id 更不许冒充人名）
    expect(screen.queryByTestId("adb-case-row-deleter")).toBeNull();
    expect(screen.queryByTestId("adb-case-row-delat")).toBeNull();
    expect(document.body.textContent).not.toContain("回收的老王");

    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-case-restore-c9")).not.toBeNull());
    // 回收站视图：人名来自 updated_by_name（不是 id 的切片/变形），时间换算成东八区
    expect(screen.getByTestId("adb-case-row-deleter").textContent).toBe("回收的老王");
    expect(screen.getByTestId("adb-case-row-delat").textContent).toBe("2026-11-16 10:00");
    // 查不到人 = 后端给 null → 画「—」，绝不把 updated_by 的 UUID 摊到界面上
    expect(document.body.textContent).not.toContain("u-deleter-uuid");
  });

  it("拉取失败 = Alert「用例列表加载失败」，不许画「还没有用例」骗人", async () => {
    mockBackend({ normal: [], recycled: [] }, { failList: true });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-case-load-error")).not.toBeNull());
    expect(screen.getByTestId("adb-case-load-error").textContent).toContain("库挂了");
    // catch 清行，所以脚注必须闭嘴：一行都没有时「共 0 条」是拿故障演实测零
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    expect(document.body.textContent).not.toContain("共 0 条");
  });

  it("最近结果 error：ADB 运行没有 HTTP 请求，贴「执行失败」而不是 runVocab 的「请求失败」", async () => {
    // error 在 adb 侧只有「没跑成」来源（debug_services.py _run_status:275-289 /
    // _finish_error:331-371，如「用例不可执行：默认设备…不在可用设备里」），
    // 「请求失败」是把 HTTP 词表贴到 adb 上撒谎；颜色仍走 STATUSES.error（红）不漂移。
    mockBackend({ normal: [adbCase({ last_run_status: "error" })], recycled: [] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    expect(document.body.textContent).toContain("执行失败");
    expect(document.body.textContent).not.toContain("请求失败");
    expect(document.querySelector(".ant-tag-red")?.textContent).toBe("执行失败");
  });

  it("列表加载失败时 Table 空态不许说「还没有 ADB 用例」（Alert 是唯一诚实陈述）", async () => {
    // 孪生口径 adbDevices.tsx:520 的 `&& !loadError` 守卫：失败≠测得为零。
    mockBackend({ normal: [], recycled: [] }, { failList: true });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-case-load-error")).not.toBeNull());
    expect(document.body.textContent).not.toContain("还没有 ADB 用例");
    // 不给 ×：脚注（:214）也读 loadError，关掉这条会把「没取到」擦成「共 0 条」。
    expect(screen.getByTestId("adb-case-load-error").querySelector(".ant-alert-close-icon")).toBeNull();
  });

  it("「任一空闲」脚注讲真话：锁第一台未被占用（未回收且启用）的设备，心跳离线不剔除", async () => {
    // 后端 any-idle 池 = _usable_devices（debug_services.py:103-109）只看 status=normal
    // + enabled=1，对心跳在线与否全盲；而 adbDevices 卡片把离线画灰——旧句「锁一台空闲
    // 设备」用卡片语义（在线+未占用）承诺执行语义（仅未回收+启用），灰设备照被锁。
    mockBackend({ normal: [adbCase()], recycled: [] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    expect(document.body.textContent).toContain(
      "「任一空闲」= 执行时锁第一台未被占用（未回收且启用）的设备");
    expect(document.body.textContent).toContain("心跳离线不剔除它");
    expect(document.body.textContent).not.toContain("空闲设备");
  });

  it("D217 空条件不拼 filter；应用「名称包含 登录」后下一次列表请求带条件 JSON", async () => {
    mockBackend({ normal: [adbCase()], recycled: [] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    expect(qsOf(listUrls[0]).has("filter")).toBe(false); // 空条件整个参数不上线（不是 filter=）
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "登录" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listUrls.length).toBe(2));
    // 字段名来自后端 meta 的第一项（name），前端不自列字段
    expect(JSON.parse(qsOf(listUrls[1]).get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "登录" }],
    });
  });

  it("D217 列设置勾掉「默认设备」只藏那一列（其余表头原样）", async () => {
    localStorage.clear();
    mockBackend({ normal: [adbCase()], recycled: [] });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("默认设备");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "优先级", "默认设备", "启用", "最近结果", "负责人", "更新时间"]);
    fireEvent.click(boxes[labels.indexOf("默认设备")]);
    await waitFor(() => expect(thead()).not.toContain("默认设备"));
    expect(thead()).toContain("启用");
  });
});

// 第八道差集第二十三轮（adbCases.tsx 脚注）：旧世界 Page 没有 total、单页 size=200，
// 「共 N 条」只有游标能证实。**D47-b 步5a 换口径**：本页接页码分页，「共 N 条」改由
// 服务端 total 经 ListPager 说出，游标那两条腿（「后面还有没取的」）随游标世界有意退役
// ——页码模式下下一页永远点得到，「还有没取的」不再是脚注能说的事（接口页步4b 同判）。
// 旧 describe「脚注的共要有游标作证」的两条用例按新现实改写成下面这组，不静默删除。
describe("页码分页 ListPager（D47-b 步5a）：共 N 只认服务端 total，请求形状可指认", () => {
  interface ListBackend { total?: number | null; cursor?: string | null; fail?: boolean }
  /** 可翻故障的列表桩（runs.test.tsx BackendOpts 句柄同款）：挂载后翻 fail 模拟
   *  「上一秒还好、这一秒取不到」。total===undefined 时响应不带 total 键（游标式真实形状）。 */
  function mockList(b: ListBackend = { total: 2 }): ListBackend {
    listUrls = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/filter-meta")) return deepResp(ADB_META);
      if (url.includes("/saved-views")) return deepResp([]);
      if (url.includes("/members")) return deepResp({ items: [], next_cursor: null });
      if (b.fail) return deepResp({ code: "db_error", message: "库挂了", details: null }, 500);
      listUrls.push(url);
      const q = qsOf(url);
      const cur = Number(q.get("current") ?? "1");
      const size = Number(q.get("size") ?? "20");
      const pool = [adbCase({ id: "a1" }), adbCase({ id: "a2", name: "退款链路" })];
      const items = pool.slice((cur - 1) * size, (cur - 1) * size + size);
      const body: Record<string, unknown> = { items, next_cursor: b.cursor ?? null };
      if (b.total !== undefined) body.total = b.total;
      return deepResp(body);
    }) as unknown as typeof fetch;
    return b;
  }
  /** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
  function pager(): HTMLElement {
    return screen.getByTestId("list-pager");
  }
  function clickPage(n: number): void {
    fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
  }
  /** 表内行 id = 当前表格真实渲染的行（替换/追加语义只能从 DOM 看出来）。 */
  const rowKeys = () => Array.from(document.querySelectorAll("tbody tr[data-row-key]"))
    .map((tr) => tr.getAttribute("data-row-key"));
  async function lastQuery(before: number): Promise<URLSearchParams> {
    await waitFor(() => expect(listUrls.length).toBe(before + 1));
    return qsOf(listUrls[listUrls.length - 1]);
  }

  it("② 点第 2 页 → 恰好一条 current=2（D127 换皮：多一条都红），行是替换不是追加", async () => {
    // 取数落地若把 load 的依赖改脏（items 进依赖），setRows → load 换身份 → effect 重跑 →
    // 多一条重置请求把第 2 页掀回第 1 页。数请求条数：点一次页码 = 总 2 条，多一条都红。
    const many = (n: number) => Array.from({ length: n }, (_, i) => adbCase({ id: "a" + (i + 1) }));
    mockBackend({ normal: many(45), recycled: [], total: 45 });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(20));
    await new Promise((r) => setTimeout(r, 300));
    expect(listUrls).toHaveLength(1); // 挂载恰好一条（绊线的页码版复读，兜 ② 自身的前提）
    clickPage(2);
    const q = await lastQuery(1);
    expect(q.get("current")).toBe("2");
    expect(q.has("cursor")).toBe(false); // 后端 current+cursor 同传必 400
    // 替换语义：第 1 页 20 行必须下桌，屏上只剩第 21~40 行（append 变异会在这里数出 40 行）
    await waitFor(() => expect(rowKeys()).toEqual(
      Array.from({ length: 20 }, (_, i) => "a" + (i + 21))));
    expect(pager().querySelector(".ant-pagination-item-2.ant-pagination-item-active")).toBeTruthy();
    // 迟到的重置请求也要抓到：替换落地后请求总数仍恰好 2
    expect(listUrls).toHaveLength(2);
  });

  it("③ 停在第 2 页点回收站 → recycled=true 与 current=1 一起上线（唯一写入口的回页）", async () => {
    // 变异靶：toggleRecycled 里摘掉 setCurrent(1) → current 停在 2，回收集只有 1 行，
    // 第 2 页切片是空的——「切回收站把数据切没了」。正向对照（回收行真落地）同条钉住。
    const many = (n: number) => Array.from({ length: n }, (_, i) => adbCase({ id: "a" + (i + 1) }));
    mockBackend({ normal: many(45),
      recycled: [adbCase({ id: "z9", status: "recycled" })], total: 45 });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(20));
    clickPage(2);
    const landed = await lastQuery(1);
    expect(landed.get("current")).toBe("2"); // 正对照：确实停在第 2 页，回页才有东西可回
    const before = listUrls.length;
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    const q = await lastQuery(before);
    expect(q.get("recycled")).toBe("true");
    expect(q.get("current")).toBe("1");
    await waitFor(() => expect(screen.getByTestId("adb-case-restore-z9")).not.toBeNull());
    expect(rowKeys()).toEqual(["z9"]); // 回收集按 current=1 切出来就是这一行
  });

  it("④ 响应 total=45 而行数 2：「共 45 条」只跟服务端 total；游标非空不再改口（旧 hasMore 腿退役）", async () => {
    // 数字与屏上行数对不上正是「total 不许由行数现攒」的证明（runs 同款）。
    // 游标非空旧世界改口「后面还有没取的」——页码模式下 next_cursor 对界面零影响。
    mockList({ total: 45, cursor: "c2" });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(2));
    expect(pager().textContent).toContain("共 45 条");
    expect(document.body.textContent).not.toContain("共 2 条"); // 行数不是总数
    expect(document.body.textContent).not.toContain("后面还有没取的"); // 游标不再驱动文案
  });

  it("⑤ 刷新失败清行清 total：旧「共 45 条」随空表一起下桌", async () => {
    // adbCases 失败清行本来就有；页码模式补上「清 total」——空表上挂陈旧「共 N 条」
    // 是第二句谎（与 uiCases 孪生页同口径，api.tsx 步4b 同款理由）。
    const b = mockList({ total: 45 });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(pager().textContent).toContain("共 45 条"));
    b.fail = true;
    fireEvent.click(screen.getByTestId("adb-case-recycled")); // 无刷新钮，切视图同样重跑 load()
    await screen.findByTestId("adb-case-load-error");
    expect(screen.queryAllByTestId("adb-case-row-name")).toHaveLength(0);
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 45 条");
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
  });

  it("⑥ 响应没有 total 键（后端游标式形状）→ 页脚整块不渲染，不报「共 0 条」", async () => {
    mockList({ total: undefined });
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(2));
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 0 条");
    expect(document.body.textContent).not.toContain("共 2 条");
  });
});

// ── D180（第二十四轮）：与 adbDevices.test.tsx 同款——回收列组跟「已到货的数据」
// （shownRecycled），恢复/彻底删除逐行认 r.status。竞态用手工 deferred 定格。
describe("D180 回收站模板跟数据：点击与取数之间不给活行套回收列", () => {
  const alive = adbCase({ id: "c1", name: "活着的用例", updated_by: "u-editor-uuid",
    updated_by_name: "最后编辑的老王", updated_at: "2026-11-16T09:00:00+08:00" });
  const dead = adbCase({ id: "c9", name: "被删的用例", status: "recycled",
    updated_by: "u-deleter-uuid", updated_by_name: "回收的老王",
    updated_at: "2026-11-16T10:00:00+08:00" });
  const stray = adbCase({ id: "c8", name: "混进来的活用例",
    updated_by: "u-stray-uuid", updated_by_name: "混进来的编辑者",
    updated_at: "2026-11-16T09:30:00+08:00" });

  /** 正常页按 liveRows（缺省 [alive]，①②③④ 的既有行为不动）；recycled=true 那一页按 mode：hold=手工 deferred / fail=500 / ok=直接给。 */
  function mockRecycledFetch(recycledItems: AdbCaseOut[], mode: "hold" | "fail" | "ok" = "ok",
    liveRows: AdbCaseOut[] | null = null) {
    listUrls = [];
    let release: ((r: Response) => void) | null = null;
    let gets = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/filter-meta")) return deepResp(ADB_META);
      if (url.includes("/saved-views")) return deepResp([]);
      if (url.includes("/members")) {
        return deepResp({ items: [{ user_id: "u9", account: "lisi", name: "李四" }], next_cursor: null });
      }
      if (url.includes("/adb-cases?")) {
        if (url.includes("recycled=true")) {
          gets += 1;
          if (mode === "fail") {
            return deepResp({ code: "db_error", message: "回收站取挂了", details: null }, 500);
          }
          return new Promise<Response>((r) => {
            if (mode === "hold") release = r;
            else r(deepResp({ items: recycledItems, next_cursor: null }));
          });
        }
        listUrls.push(url);
        return deepResp({ items: liveRows ?? [alive], next_cursor: null });
      }
      throw new Error("未 mock 的请求: " + url);
    }) as unknown as typeof fetch;
    return { recycledGets: () => gets, release: () => release!(deepResp({
      items: recycledItems, next_cursor: null,
    })) };
  }

  it("点击回收站 + refetch 在途：活行保持正常模板，脚注不预告「回收站视图」", async () => {
    const ctl = mockRecycledFetch([dead], "hold");
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    // deferred 门：回收站请求已发出未 resolve——页面上是「新旗标 + 旧数据」。
    await waitFor(() => expect(ctl.recycledGets()).toBe(1));
    expect(screen.queryByTestId("adb-case-row-deleter")).toBeNull();
    expect(screen.queryByTestId("adb-case-row-delat")).toBeNull();
    expect(screen.queryByTestId("adb-case-purge-c1")).toBeNull();
    expect(screen.queryByTestId("adb-case-restore-c1")).toBeNull();
    // 「删除人」列头整组不在（不是渲染了空单元格）
    expect(document.body.textContent).not.toContain("删除人");
    expect(document.body.textContent).not.toContain("最后编辑的老王");
    expect(document.body.textContent).not.toContain("回收站视图");
    // 活行拿的是正常视图的删除入口（负断言的正对照：操作列在场且是删除）
    expect(screen.getByTestId("adb-case-del")).not.toBeNull();
    // 放行：同一段查询此刻必须查得到——负断言不长在永不渲染的分支上
    ctl.release();
    await waitFor(() => expect(screen.getByTestId("adb-case-restore-c9")).not.toBeNull());
    expect(screen.getByTestId("adb-case-row-deleter")).not.toBeNull();
  });

  it("点击回收站 + refetch 500：清行照旧，但模板不跟着翻；Alert/空态陈述原样保留", async () => {
    mockRecycledFetch([dead], "fail");
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    const alert = await screen.findByTestId("adb-case-load-error");
    expect(alert.textContent).toContain("回收站取挂了");
    expect(screen.queryByTestId("adb-case-row-deleter")).toBeNull();
    expect(document.body.textContent).not.toContain("删除人");
    // 失败不翻 shownRecycled：脚注按旧数据说话
    expect(document.body.textContent).not.toContain("回收站视图");
    // 既有失败口径原样：清行 + 脚注闭嘴 + 空态说「未取到」不说「回收站是空的」
    expect(document.body.textContent).toContain("本次列表加载失败，本行计数不作数");
    expect(document.body.textContent).toContain("用例列表未取到");
    expect(document.body.textContent).not.toContain("回收站是空的");
  });

  it("成功切进回收站：删除人照旧出（人名不是 UUID）+ 删除时间走 fmtTime（正对照）", async () => {
    mockRecycledFetch([dead], "ok");
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-case-restore-c9")).not.toBeNull());
    expect(screen.getByTestId("adb-case-row-deleter").textContent).toBe("回收的老王");
    expect(screen.getByTestId("adb-case-row-delat").textContent).toBe("2026-11-16 10:00");
    expect(document.body.textContent).not.toContain("u-deleter-uuid");
    expect(document.body.textContent).toContain("回收站视图");
  });

  it("混数据：回收列表里 status:normal 的行没有删除人/彻底删除，真回收行两样都有", async () => {
    mockRecycledFetch([dead, stray], "ok");
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-case-restore-c9")).not.toBeNull());
    expect(screen.getByTestId("adb-case-purge-c9")).not.toBeNull();
    expect(screen.getByTestId("adb-case-row-deleter").textContent).toBe("回收的老王");
    // 混进来的活行：删除人/删除时间格是空的（列头在但不给它编「删除人」），操作列
    // 只有正常视图那个「删除」，没有恢复/彻底删除
    expect(screen.getAllByTestId("adb-case-row-deleter")).toHaveLength(1);
    expect(screen.queryByTestId("adb-case-purge-c8")).toBeNull();
    expect(screen.queryByTestId("adb-case-restore-c8")).toBeNull();
    expect(document.body.textContent).not.toContain("混进来的编辑者");
    expect(screen.getByTestId("adb-case-del")).not.toBeNull();
  });

  it("⑤ 空态那条腿：项目里本来就没用例 + 回收站请求在途 → 空态说「还没有 ADB 用例」，不说「回收站是空的」", async () => {
    // 补的腿：①②③④ 的初始列表恒带一行活用例，有行 ⇒ antd 不渲染 Empty ⇒
    // adbCases.tsx:154 那条 ternary 从没进过分支，leg1 变异（shownRecycled→inRecycled）
    // 在本文件里杀不死。要量到它必须让**初始**列表就是空的。
    // 只查表格自己那份空态（.ant-table-placeholder 圈住）：整页文本会被别的 Empty 满足，
    // 断言就门不住任何东西（scenes/api 同轮探针实测过的假把手）。
    const ctl = mockRecycledFetch([], "hold", []);
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector(".ant-table-placeholder")).not.toBeNull());
    const emptyDesc = () => document
      .querySelector(".ant-table-placeholder .ant-empty-description")?.textContent ?? "";
    expect(emptyDesc()).toContain("还没有 ADB 用例");
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    await waitFor(() => expect(ctl.recycledGets()).toBe(1)); // 已在途
    expect(emptyDesc()).not.toContain("回收站是空的");
    ctl.release();
    // 正对照：真取回空回收站后同一句必须改口，否则这条腿只是「永远不说」
    await waitFor(() => expect(emptyDesc()).toContain("回收站是空的"));
  });
});

// ── D273：ADB 用例批量回收/恢复（正常视图批量回收，回收站批量恢复）────────────
// adbCases 现有 mockBackend 只给 GET（列表/filter-meta），批量要走 POST，这里自带一个
// 覆盖 fetch 的小桩：POST /adb-cases/batch-* 记录 body；GET 列表按 recycled 切片。
describe("adbCases 批量回收/恢复（D273）", () => {
  let posts: { url: string; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    cleanup();
    // Modal.confirm 静态弹窗挂 body 独立 root，cleanup 管不到——上一用例的确认框会串场
    Modal.destroyAll();
    document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
    useAuth.setState({
      user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
      project: PROJECT, ready: true,
    });
  });

  function mockBatch(normal: AdbCaseOut[], recycled: AdbCaseOut[]) {
    posts = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/adb-cases/batch-")) {
        posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return deepResp({ ok: true });
      }
      if (url.includes("/filter-meta")) return deepResp(ADB_META);
      if (url.includes("/saved-views")) return deepResp([]);
      if (url.includes("/adb-cases?")) {
        const q = qsOf(url);
        return deepResp({ items: q.get("recycled") === "true" ? recycled : normal, next_cursor: null });
      }
      return deepResp({ items: [] });
    }) as unknown as typeof fetch;
  }
  function boxes(): HTMLElement[] {
    return Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row input[type="checkbox"]'));
  }

  it("勾 2 行 → 批量回收：POST batch-delete 带 case_ids；成功后清选择", async () => {
    mockBatch([adbCase({ id: "c1" }), adbCase({ id: "c2" }), adbCase({ id: "c3" })], []);
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(3));
    expect(screen.queryByTestId("adb-case-batch-bar")).toBeNull();
    fireEvent.click(boxes()[0]);
    fireEvent.click(boxes()[1]);
    expect((await screen.findByTestId("adb-case-batch-bar")).textContent).toContain("已选 2 项");
    fireEvent.click(screen.getByTestId("adb-case-batch-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "放入回收站" }));
    await waitFor(() => expect(posts.some((p) => p.url.includes("batch-delete"))).toBe(true));
    const call = posts.find((p) => p.url.includes("batch-delete"))!;
    expect(call.body.project_id).toBe("p1");
    expect([...(call.body.case_ids as string[])].sort()).toEqual(["c1", "c2"]);
    await waitFor(() => expect(screen.queryByTestId("adb-case-batch-bar")).toBeNull());
  });

  it("回收站视图勾行 → 批量恢复：POST batch-restore 带 case_ids", async () => {
    mockBatch([], [adbCase({ id: "c9", status: "recycled" }), adbCase({ id: "c8", status: "recycled" })]);
    render(<MemoryRouter><AdbCasesPage /></MemoryRouter>);
    await waitFor(() => expect(document.body.textContent).toContain("还没有 ADB 用例"));
    fireEvent.click(screen.getByTestId("adb-case-recycled"));
    await waitFor(() => expect(screen.getAllByTestId("adb-case-row-name")).toHaveLength(2));
    fireEvent.click(boxes()[0]);
    expect(await screen.findByTestId("adb-case-batch-restore")).not.toBeNull();
    fireEvent.click(screen.getByTestId("adb-case-batch-restore"));
    const m = await waitFor(() => {
      const el = document.querySelector(".ant-modal-confirm") as HTMLElement | null;
      if (!el) throw new Error("确认框未出现");
      return el;
    });
    fireEvent.click(within(m).getByRole("button", { name: /^恢\s*复$/ }));
    await waitFor(() => expect(posts.some((p) => p.url.includes("batch-restore"))).toBe(true));
    expect((posts.find((p) => p.url.includes("batch-restore"))!.body.case_ids as string[]).length).toBeGreaterThan(0);
  });
});
