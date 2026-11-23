// 项目成员 Tab（§11.4.27 Tab1）此前是全仓库唯一「零自有测试」的设置页组件：三个写动作
// （添加/改角色/移出）删掉 put/del 调用八道门禁照样全绿——1G 台账 D63/D112 同类的
// 「有实现、无测试」面。钉十三组契约（字段名/词表以后端为准，不照前端猜）：
// ① 列表请求口径 GET /projects/{pid}/members（routes.py:123，无 query）+ 渲染规则：
//    「我」Tag 只跟 user_id===selfId（MembersTab.tsx:87）、account=null 回落
//    user_id.slice(0,8)（:86）、name=null 画「—」；字段逐字 = MemberOut（schemas.py:214-220）；
// ② canManage=false：添加/移出/角色下拉一律不在 DOM（§11.5.1 藏把手而非置灰），
//    角色列画静态 Tag，查不到的 role_code 原样回显（roleName :81 的 ?? 回落）；
// ③ 角色数据源 = GET /roles 内置（routes.py:97，词表 roles.py:8-13）+ GET
//    /custom-roles?project_id=..&size=200（role_services.py:68-81）并进下拉、自定义带
//    「（自定义）」后缀、按 code 去重（MembersTab.tsx:42）；
// ④ /custom-roles 403 不拦成员页：表照常出、下拉只剩内置（:37-41 的内层 try/catch 是刻意的）；
// ⑤ 开弹窗即 search("")：GET /project-member-candidates?project_id=&q=&size=20
//    （project_services.py:328 + MemberCandidateIn schemas.py:231-236，q 默认 ""，空串合法）、
//    打字二次查询、is_member 标「（已在项目）」（MemberCandidateOut :239-243）；
//    不选人点[加入项目] → message.warning(先选一个用户) 且 PUT 数=0（:60 先于任何请求）；
// ⑥ 添加：PUT /projects/{pid}/members/{uid}（routes.py:128），body 逐字 =
//    MemberIn {role_code}（schemas.py:210，uid 在 path 不进 body）；成功 toast+关窗+重拉+
//    onChanged?.()（外层靠它刷 my_perms，哑了按钮就陈旧）；
// ⑦ 添加失败：窗不关、onChanged 不叫，就地重试能成；
// ⑧ 改角色：同一 PUT 端点 + onChanged；失败仍 await load()（:78「失败也重拉」，
//    行内绝不乐观翻转），后端中文 message 上屏、原始 code 不上屏（client.ts:96-102）；
// ⑨ 移出：Popconfirm 取消零请求零重拉；确认 DELETE /projects/{pid}/members/{uid}
//    无 body（routes.py:133-136 的 handler 没有 payload 位，client.ts:117-118 的
//    del(url) 不带 body 与之对齐），随后重拉 + onChanged；
// ⑩ members GET 500 → 「成员列表没取到」Alert（silent:true 不该有 toast）；
// ⑪ 添加弹窗文案与「加入项目」实动作对齐：点确定 = 按角色下拉当前值（默认 MEMBER）落库授权，
//    已在项目的人是改角色不是「无副作用重加」（PUT 对已存在行整体覆盖 role_code，
//    project_services.py:280）；列表 403 与传输失败分句——403 是「你已不是成员」的稳定结论，
//    不许劝「点刷新重试」（routes.py:123 → ensure_member → forbidden）；
// ⑫ 取失败不许摊成空态：表体 500 说「没取到」而不是「还没有成员」；弹窗候选查失败
//    说「候选用户没取到」而不是「没有匹配的用户」（catch 里 setCands([]) 让两者同形）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
import MembersTab from "./MembersTab";
import type { CandidateRow, MemberRow, RoleRow } from "../api/api";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// 与后端内置角色表 roles.py:8-13 逐字对齐（/roles 的 RoleOut 词表，schemas.py:223）
const BUILTIN: RoleRow[] = [
  { code: "SYSTEM_ADMIN", name: "系统管理员", perms: ["*"] },
  { code: "PROJECT_ADMIN", name: "项目管理员", perms: ["*", "-system:*"] },
  { code: "MEMBER", name: "测试工程师", perms: ["*", "-*:delete", "-*:manage", "-system:*"] },
  { code: "READONLY", name: "只读", perms: ["*:read"] },
];

// 字段逐字 = MemberOut（schemas.py:214-220）
const M_SELF: MemberRow = { id: "m1", project_id: "p1", user_id: "u1",
  role_code: "PROJECT_ADMIN", account: "admin", name: "管理员" };
const M_LI: MemberRow = { id: "m2", project_id: "p1", user_id: "u2",
  role_code: "MEMBER", account: "lisi", name: "李四" };
// account/name 双 null：钉 :86 的 slice(0,8) 回落与姓名「—」
const M_ANON: MemberRow = { id: "m3", project_id: "p1", user_id: "u_deadbeefcafe9876",
  role_code: "READONLY", account: null, name: null };
const ANON_HEAD = "u_deadbe"; // "u_deadbeefcafe9876".slice(0, 8) 逐字

// GET /custom-roles 的 CustomRoleOut 形状（role_services.py:74-81 出参）
const CUSTOM = [{ code: "role_api", project_id: "p1", name: "接口专员",
  perms: ["api:case:read"], template_code: "MEMBER" }];

const CANDS: CandidateRow[] = [
  { id: "u2", account: "lisi", name: "李四", is_member: true },
  { id: "u9", account: "zhangsan", name: "张三", is_member: false },
];

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// D245：高级搜索三件套的依赖。字段与后端 MEMBER_LIST_FILTER 同名同 kind。
const FILTER_META = {
  view_type: "member", view_label: "项目成员",
  supported_view_types: ["member"],
  fields: [
    { field: "account", label: "账号", kind: "text",
      ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS"] },
    { field: "role_code", label: "角色", kind: "enum",
      ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
  ],
  unavailable: {},
};

interface Call { url: string; method: string; body?: string }
type Resp = { status: number; body: unknown };

/** membersResp/customResp/putResp/delResp 是「该端点第 1/2/… 次请求的回执」序列：
 * 数组耗尽后回 2xx——「失败不关窗 → 就地重试能成」这条契约要求桩能按次序变脸。
 * candResp 同理管候选查找：catch 里 setCands([]) 让「查失败」和「查到了但没匹配」
 * 在 notFoundContent 上长一个样，没有注入失败的桩就永远证不了这两句话不一样。 */
function mockBackend(members: MemberRow[], over: {
  customItems?: typeof CUSTOM; candidates?: CandidateRow[];
  membersResp?: Resp[]; customResp?: Resp[]; putResp?: Resp[]; delResp?: Resp[];
  candResp?: Resp[];
} = {}): Call[] {
  const calls: Call[] = [];
  const take = (seq: Resp[] | undefined, i: number, okBody: Resp): Resp =>
    seq && i < seq.length ? seq[i] : okBody;
  let nMembers = 0;
  let nCustom = 0;
  let nCand = 0;
  let nPut = 0;
  let nDel = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    // D245：ListToolbar 挂载即拉元数据与个人视图（未 mock 会 throw，整页红成取数失败）
    if (url.includes("/filter-meta?")) return res(200, FILTER_META);
    if (url.includes("/saved-views?")) return res(200, []);
    // 前缀 /api/v1 来自 client.ts:77 的统一拼装
    if (method === "GET" && url.startsWith("/api/v1/projects/p1/members")) {
      const r = take(over.membersResp, nMembers++, { status: 200, body: { items: members } });
      return res(r.status, r.body);
    }
    if (method === "GET" && url === "/api/v1/roles") return res(200, { items: BUILTIN });
    if (method === "GET" && url.startsWith("/api/v1/custom-roles?")) {
      const r = take(over.customResp, nCustom++,
        { status: 200, body: { items: over.customItems ?? [], next_cursor: null } });
      return res(r.status, r.body);
    }
    if (method === "GET" && url.startsWith("/api/v1/project-member-candidates?")) {
      const r = take(over.candResp, nCand++, { status: 200, body: {
        items: over.candidates ?? CANDS, next_cursor: null } });
      return res(r.status, r.body);
    }
    if (method === "PUT" && /^\/api\/v1\/projects\/p1\/members\/[^/]+$/.test(url)) {
      const r = take(over.putResp, nPut++, { status: 200, body: members[0] });
      return res(r.status, r.body);
    }
    if (method === "DELETE" && /^\/api\/v1\/projects\/p1\/members\/[^/]+$/.test(url)) {
      const r = take(over.delResp, nDel++, { status: 200, body: { ok: true } });
      return res(r.status, r.body);
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

const memGets = (c: Call[]) => c.filter((x) => x.method === "GET" && x.url === "/api/v1/projects/p1/members");
const candGets = (c: Call[]) => c.filter((x) => x.method === "GET" && x.url.startsWith("/api/v1/project-member-candidates?"));
const puts = (c: Call[]) => c.filter((x) => x.method === "PUT" && x.url.startsWith("/api/v1/projects/p1/members/"));
const dels = (c: Call[]) => c.filter((x) => x.method === "DELETE" && x.url.startsWith("/api/v1/projects/p1/members/"));

/** motion:false 同 UsersTab.test.tsx:86-93：rc-motion 的 leave 动画在 jsdom 里不完成，
 * destroyOnClose 的弹窗关掉后节点永远留在 DOM，「成功/失败后窗关不关」就断言不了。 */
function renderTab(over: {
  canManage?: boolean; canSaveView?: boolean; selfId?: string; onChanged?: () => void;
} = {}) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MembersTab projectId="p1" canManage={over.canManage ?? true}
        canSaveView={over.canSaveView ?? true} canDeleteView={over.canSaveView ?? true}
        selfId={over.selfId ?? "u1"} onChanged={over.onChanged} />
    </ConfigProvider>,
  );
}

function toastText(): string {
  return Array.from(document.querySelectorAll(".ant-message")).map((n) => n.textContent).join("|");
}

/** 只读本用例新出现的 toast：静态 message 的 holder 挂在自建 root 上，读不到我们
 * ConfigProvider 的 motion:false，destroyOnClose 的 leave 动画在 jsdom 里永不完成，
 * 上一条测试的 notice 节点会留在 DOM 里且新文案追加在同一节点尾部——直接对全局
 * toastText() 做 not.toContain 会被残留文案假红。jsdom 里节点只增不减（动画不完成），
 * 所以按「快照定位 + 截尾」取增量是确定性的。 */
function toastSince(base: string): () => string {
  return () => {
    const t = toastText();
    const i = t.indexOf(base);
    return i >= 0 ? t.slice(i + base.length) : t;
  };
}

/** antd Select 靠 mousedown 在 selector 上展开（RequestEditor.test.tsx:49-53 同款）。 */
function openDropdown(node: HTMLElement): void {
  fireEvent.mouseDown(node.querySelector(".ant-select-selector")!);
}

const visibleOptions = () => Array.from(document.querySelectorAll(
  ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")) as HTMLElement[];
const visibleOptionTexts = () => visibleOptions().map((o) => o.textContent ?? "");

/** 在展开的下拉里按 label 点子项：先等浮层里出现该文案再点，不等=红（不静默跳过）。 */
async function clickOption(label: string): Promise<void> {
  await waitFor(() => {
    expect(visibleOptionTexts().some((t) => t.includes(label))).toBe(true);
  });
  fireEvent.click(visibleOptions().find((o) => (o.textContent ?? "").includes(label))!);
}

beforeEach(() => {
  cleanup();
  message.destroy();
});

afterEach(() => cleanup());

describe("① 列表请求口径 + 渲染规则", () => {
  it("GET /projects/p1/members 无 query；我 Tag 只跟 selfId；account 空回落 user_id 前 8 位；name 空画 —", async () => {
    const calls = mockBackend([M_SELF, M_LI, M_ANON]);
    renderTab();
    await screen.findAllByTestId("member-account");
    // routes.py:123 的 list_members 没有任何 query 位
    expect(memGets(calls)[0].url).toBe("/api/v1/projects/p1/members");
    expect(memGets(calls)[0].method).toBe("GET");

    const accounts = screen.getAllByTestId("member-account").map((n) => n.textContent);
    // M_ANON.account=null → user_id.slice(0,8)（:86 的 ?? 回落）
    expect(accounts).toEqual(["admin", "lisi", ANON_HEAD]);
    expect(screen.getByText("李四")).not.toBeNull();
    expect(screen.getByText("—")).not.toBeNull(); // M_ANON 的 null 姓名

    // 「我」只出现在 user_id===selfId("u1") 那行（:87）
    const me = screen.getAllByText("我");
    expect(me).toHaveLength(1);
    expect(me[0].className).toContain("ant-tag-blue");
    // 三行 × 角色下拉 + 移出钮（canManage=true 的把手齐全）
    expect(screen.getAllByTestId("member-role")).toHaveLength(3);
    expect(screen.getAllByTestId("member-remove")).toHaveLength(3);
    expect(screen.getByTestId("member-add")).not.toBeNull();
  });

  it("空成员列表：表体画空态文案「还没有成员」逐字（:131 locale.emptyText 的唯一钉——没这条的话文案被改成「暂无数据」也全绿，线上文案成了无人认领的孤儿）", async () => {
    mockBackend([]);
    renderTab();
    // load() 落地后 rows=[] 才走 emptyText；findByText 等异步完成，顺带钉 loading 态不长挂
    expect(await screen.findByText("还没有成员", {}, { timeout: 2000 })).not.toBeNull();
  });
});

describe("② 只读面（§11.5.1：藏把手，不是置灰）", () => {
  it("canManage=false：添加/移出/角色下拉全不在 DOM，角色列画静态 Tag，查不到的 code 原样回显", async () => {
    const GONE: MemberRow = { id: "m9", project_id: "p1", user_id: "u9",
      role_code: "role_gone", account: "ghost", name: "幽灵" };
    mockBackend([M_SELF, GONE]);
    renderTab({ canManage: false });
    await screen.findAllByTestId("member-account");
    expect(screen.queryByTestId("member-add")).toBeNull();
    expect(screen.queryByTestId("member-role")).toBeNull();
    expect(screen.queryByTestId("member-remove")).toBeNull();
    // member-role-static 的「项目管理员」不是 members 响应给的，是另一腿 GET /roles
    // （roleName :88 查 roles）——只等 member-account 壳会读到 roles 未到时的
    // ?? 回落原码「PROJECT_ADMIN」（延迟探针下真实翻红过）。等内容本身。
    await screen.findByText("项目管理员");
    // roleName()（:81）命中画名字；"role_gone" 不在角色表 → ?? 回落原样画 code
    const tags = screen.getAllByTestId("member-role-static");
    expect(tags.map((t) => t.textContent)).toEqual(["项目管理员", "role_gone"]);
  });
});

describe("③/④ 角色数据源合并与容错", () => {
  it("内置在前 + 自定义带「（自定义）」后缀 + 撞 code 去重（后端自定义永远撞不了内置，正是要钉住这条）", async () => {
    // 后端自定义 code 是小写（role_services.py:100 的正则），这里故意回一条撞内置 MEMBER
    // 的数据来证明 :42 的去重分支真的在挡事（不是「构造上恒真、断言恒绿」的死代码）。
    mockBackend([M_SELF, M_LI], { customItems: [...CUSTOM,
      { code: "MEMBER", project_id: "p1", name: "撞码项", perms: [], template_code: "READONLY" }] });
    renderTab();
    await screen.findAllByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    openDropdown(screen.getByTestId("member-new-role"));
    await waitFor(() => expect(visibleOptions().length).toBeGreaterThan(0));
    // 选项集恰好这五项：内置四枚原样在前、role_api 带后缀在后、撞码的「撞码项」被滤掉
    expect(visibleOptionTexts()).toEqual(
      ["系统管理员", "项目管理员", "测试工程师", "只读", "接口专员（自定义）"]);
  });

  it("custom-roles 403：成员表照常出行，下拉只剩内置四枚（内层 try/catch 不许被删）", async () => {
    mockBackend([M_SELF, M_LI], { customResp: [
      { status: 403, body: { code: "forbidden", message: "没有权限执行该操作", details: {} } },
    ] });
    renderTab();
    await screen.findAllByTestId("member-account"); // 表照常出
    expect(screen.getAllByTestId("member-account")).toHaveLength(2);
    expect(screen.queryByText("成员列表没取到")).toBeNull(); // 内层失败不升格为页级失败
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    openDropdown(screen.getByTestId("member-new-role"));
    await waitFor(() => expect(visibleOptions().length).toBeGreaterThan(0));
    expect(visibleOptionTexts()).toEqual(["系统管理员", "项目管理员", "测试工程师", "只读"]);
  });
});

describe("⑤ 添加：搜索口径 + 不选人零写入", () => {
  it("开弹窗即 q= 空查一次，打字 q=li 再查；is_member 标「（已在项目）」；不选人点加入 → 警告且零 PUT", async () => {
    const calls = mockBackend([M_LI]);
    renderTab();
    await screen.findByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    // :122 打开即 search("")；MemberCandidateIn.q 默认 ""（schemas.py:235）——空串必须照常发
    await waitFor(() => expect(candGets(calls).length).toBe(1));
    expect(candGets(calls)[0].url)
      .toBe("/api/v1/project-member-candidates?project_id=p1&q=&size=20");
    // 先展开再打字：rc-select 在已展开态下 mouseDown 会收起，展开动作不能放在 change 之后
    openDropdown(screen.getByTestId("member-candidate"));
    const input = screen.getByTestId("member-candidate")
      .querySelector(".ant-select-selection-search-input")!;
    fireEvent.change(input, { target: { value: "li" } });
    await waitFor(() => expect(candGets(calls).some((c) => c.url.includes("&q=li&"))).toBe(true));

    await waitFor(() => expect(visibleOptions().length).toBe(2));
    // 已在项目的标出来（:142 的 is_member 后缀），不在的裸「账号 · 姓名」
    expect(visibleOptionTexts()).toEqual(["lisi · 李四（已在项目）", "zhangsan · 张三"]);

    fireEvent.click(screen.getByTestId("member-add-ok"));
    await waitFor(() => expect(toastText()).toContain("先选一个用户"));
    expect(puts(calls)).toHaveLength(0); // :60 的 picked 守卫先于任何请求
    expect(screen.queryByTestId("member-modal")).not.toBeNull(); // 窗不关，接着选
  });
});

describe("⑥/⑦ 添加写路径", () => {
  it("选人+选自定义角色 → PUT path 带 uid、body 逐字 {role_code} → toast 已添加成员 + 关窗 + 重拉 + onChanged 恰一次", async () => {
    const calls = mockBackend([M_LI], { customItems: CUSTOM });
    const onChanged = vi.fn();
    renderTab({ onChanged });
    await screen.findByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    openDropdown(screen.getByTestId("member-candidate"));
    await clickOption("zhangsan · 张三");
    openDropdown(screen.getByTestId("member-new-role"));
    await clickOption("接口专员（自定义）");
    const getsBefore = memGets(calls).length;
    fireEvent.click(screen.getByTestId("member-add-ok"));

    await waitFor(() => expect(puts(calls).length).toBe(1));
    // uid 在 path（routes.py:128-130），body 逐字 = MemberIn {role_code}（schemas.py:210-211），
    // 没有多余的 user_id/project_id 位
    expect(puts(calls)[0].url).toBe("/api/v1/projects/p1/members/u9");
    expect(JSON.parse(puts(calls)[0].body!)).toEqual({ role_code: "role_api" });
    await waitFor(() => expect(toastText()).toContain("已添加成员"));
    await waitFor(() => expect(screen.queryByTestId("member-modal")).toBeNull());
    await waitFor(() => expect(memGets(calls).length).toBe(getsBefore + 1)); // 成功后必重拉
    // onChanged 在 await load() 之后才叫，重拉计数+1 时未必已触发——单独 waitFor
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1)); // 外层刷 my_perms 的把手
  });

  it("加入失败：后端中文 message 上屏、窗不关、onChanged 不叫；就地点第二次加入能成", async () => {
    const calls = mockBackend([M_LI], { putResp: [
      { status: 404, body: { code: "not_found", message: "角色不存在", details: {} } },
      { status: 200, body: M_LI },
    ] });
    const onChanged = vi.fn();
    renderTab({ onChanged });
    await screen.findByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    const since = toastSince(toastText()); // 前面用例的残留 toast 不计入本用例断言
    openDropdown(screen.getByTestId("member-candidate"));
    await clickOption("zhangsan · 张三");
    fireEvent.click(screen.getByTestId("member-add-ok"));

    await waitFor(() => expect(since()).toContain("角色不存在"));
    expect(since()).not.toContain("not_found"); // 原始 code 不上屏（client.ts:99）
    expect(screen.queryByTestId("member-modal")).not.toBeNull(); // 失败不关窗：改完就地重试
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("member-add-ok"));
    await waitFor(() => expect(puts(calls).length).toBe(2));
    await waitFor(() => expect(since()).toContain("已添加成员"));
    await waitFor(() => expect(screen.queryByTestId("member-modal")).toBeNull());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});

describe("第二十三轮：同一个 PUT 的两条分支要说两句活", () => {
  /** 角色下拉当前选中的 label 文案（rc-select 把选中值渲染进 .ant-select-selection-item）。 */
  const roleLabel = (testid: string) =>
    screen.getByTestId(testid).querySelector(".ant-select-selection-item")?.textContent ?? "";

  it("候选 is_member=true：toast 说「角色已覆盖为「只读」」，不许说「已添加成员」", async () => {
    // 后端同一个 PUT 两条分支：无行则建（project_services.py:274-276），
    // 有行则整体覆盖 role_code（:277-280）。对已在项目的人喊「已添加」是把覆盖说成新增。
    const calls = mockBackend([M_SELF, M_LI]);
    renderTab();
    await screen.findAllByTestId("member-account");
    const since = toastSince(toastText());
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    openDropdown(screen.getByTestId("member-candidate"));
    await clickOption("lisi · 李四（已在项目）");
    openDropdown(screen.getByTestId("member-new-role"));
    await clickOption("只读");
    fireEvent.click(screen.getByTestId("member-add-ok"));
    await waitFor(() => expect(puts(calls).length).toBe(1));
    expect(puts(calls)[0].url).toBe("/api/v1/projects/p1/members/u2");
    expect(JSON.parse(puts(calls)[0].body!)).toEqual({ role_code: "READONLY" });
    await waitFor(() => expect(since()).toContain("该成员的角色已覆盖为「只读」"));
    expect(since()).not.toContain("已添加成员");
  });

  it("候选 is_member=false：还是「已添加成员」，不许套「覆盖」那句", async () => {
    const calls = mockBackend([M_SELF, M_LI]);
    renderTab();
    await screen.findAllByTestId("member-account");
    const since = toastSince(toastText());
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    openDropdown(screen.getByTestId("member-candidate"));
    await clickOption("zhangsan · 张三");
    fireEvent.click(screen.getByTestId("member-add-ok"));
    await waitFor(() => expect(puts(calls).length).toBe(1));
    await waitFor(() => expect(since()).toContain("已添加成员"));
    expect(since()).not.toContain("已覆盖");
  });

  it("上一次把角色改成只读，关掉再开：下拉回到测试工程师（文案承诺的「每次打开都是 MEMBER」）", async () => {
    mockBackend([M_SELF, M_LI]);
    renderTab();
    await screen.findAllByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    openDropdown(screen.getByTestId("member-new-role"));
    await clickOption("只读");
    await waitFor(() => expect(roleLabel("member-new-role")).toBe("只读"));
    // destroyOnClose 只重建弹窗内容，role 是父组件 state：少一句 setRole 就停在只读
    fireEvent.click(await screen.findByRole("button", { name: /^取\s*消$/ }, { timeout: 2000 }));
    await waitFor(() => expect(screen.queryByTestId("member-modal")).toBeNull());
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    expect(roleLabel("member-new-role")).toBe("测试工程师");
  });
});

describe("⑧ 改角色", () => {
  it("行内下拉改 READONLY → PUT /members/u2 body {role_code:READONLY} + toast 角色已更新 + 重拉 + onChanged", async () => {
    const calls = mockBackend([M_SELF, M_LI]);
    const onChanged = vi.fn();
    renderTab({ onChanged });
    await screen.findAllByTestId("member-role");
    const getsBefore = memGets(calls).length;
    openDropdown(screen.getAllByTestId("member-role")[1]); // 第二行 = 李四 u2
    await clickOption("只读");
    await waitFor(() => expect(puts(calls).length).toBe(1));
    expect(puts(calls)[0].url).toBe("/api/v1/projects/p1/members/u2");
    expect(JSON.parse(puts(calls)[0].body!)).toEqual({ role_code: "READONLY" });
    await waitFor(() => expect(toastText()).toContain("角色已更新"));
    await waitFor(() => expect(memGets(calls).length).toBe(getsBefore + 1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("改角色失败：中文 message 上屏、code 不上屏、不叫 onChanged，但仍重拉列表（:78 失败也重拉，行内不乐观翻转）", async () => {
    const calls = mockBackend([M_SELF, M_LI], { putResp: [
      { status: 404, body: { code: "not_found", message: "角色不存在", details: {} } },
    ] });
    const onChanged = vi.fn();
    renderTab({ onChanged });
    await screen.findAllByTestId("member-role");
    const since = toastSince(toastText()); // 上一条用例的「角色已更新」残留不算数
    const getsBefore = memGets(calls).length;
    openDropdown(screen.getAllByTestId("member-role")[1]);
    await clickOption("只读");
    await waitFor(() => expect(puts(calls).length).toBe(1));
    await waitFor(() => expect(memGets(calls).length).toBe(getsBefore + 1));
    expect(since()).toContain("角色不存在");
    expect(since()).not.toContain("not_found");
    expect(since()).not.toContain("角色已更新");
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("⑨ 移出（Popconfirm 二确）", () => {
  it("取消 = 什么都不发：DELETE 零条，也不许偷偷重拉", async () => {
    const calls = mockBackend([M_SELF, M_LI]);
    const onChanged = vi.fn();
    renderTab({ onChanged });
    await screen.findAllByTestId("member-remove");
    const getsBefore = memGets(calls).length;
    fireEvent.click(screen.getAllByTestId("member-remove")[1]);
    expect(await screen.findByText("把该成员移出项目？", {}, { timeout: 2000 })).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /^取\s*消$/ }, { timeout: 2000 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(dels(calls)).toHaveLength(0);
    expect(memGets(calls)).toHaveLength(getsBefore);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("确认：DELETE /members/u2 无 body（routes.py:133 的 handler 没有入参位）→ toast 已移出 + 重拉 + onChanged", async () => {
    const calls = mockBackend([M_SELF, M_LI]);
    const onChanged = vi.fn();
    renderTab({ onChanged });
    await screen.findAllByTestId("member-remove");
    const getsBefore = memGets(calls).length;
    fireEvent.click(screen.getAllByTestId("member-remove")[1]);
    fireEvent.click(await screen.findByTestId("member-remove-ok"));
    await waitFor(() => expect(dels(calls).length).toBe(1));
    expect(dels(calls)[0].url).toBe("/api/v1/projects/p1/members/u2");
    // del(url) 不传 body（client.ts:117-118）：body 必须压根不存在，而不是 "{}"
    expect(dels(calls)[0].body).toBeUndefined();
    await waitFor(() => expect(toastText()).toContain("已移出"));
    await waitFor(() => expect(memGets(calls).length).toBe(getsBefore + 1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});

describe("⑩ 列表失败的页级反馈", () => {
  it("members GET 500 → 「成员列表没取到」Alert 出现（silent 请求，不该有 toast）", async () => {
    mockBackend([M_SELF], { membersResp: [
      { status: 500, body: { code: "internal_error", message: "服务器开小差了", details: {} } },
    ] });
    renderTab();
    expect(await screen.findByText("成员列表没取到", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.getByText(/可能是网络不通，点「刷新」重试/)).not.toBeNull();
    expect(toastText()).not.toContain("服务器开小差了"); // :31 是 silent:true
  });
});

// 弹窗文案必须说出 [加入项目] 的真实动作：PUT /projects/{pid}/members/{uid} 带角色下拉
// 当前值（默认 MEMBER），后端对已存在行整体覆盖 role_code（project_services.py:280）——
// 「改了角色即可」把授权+覆盖动作说成了无副作用的挑选，是「文案承诺 > 代码交付」。
describe("⑪ 添加弹窗文案 = 真实动作", () => {
  it("弹窗正文逐字披露：点「加入项目」= 按角色下拉当前值（默认 MEMBER）授权，已在项目者确定即覆盖原角色", async () => {
    mockBackend([M_LI]);
    renderTab();
    await screen.findByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    // 变异靶：把这句改回「已有权限的人可以直接选…改了角色即可」旧句 → 本断言红
    expect(screen.getByText(
      "按账号或姓名搜索平台用户。点「加入项目」即把该人设为下方「角色」下拉当前选中的角色（每次打开都是 MEMBER）；已在项目的人点确定会覆盖其原角色（后端只在「降级唯一的项目管理员」时拦下，平台管理员不受这条限制）。",
    )).not.toBeNull();
    expect(screen.queryByText(/已有权限的人可以直接选/)).toBeNull();
    // 「每次打开都是 MEMBER」是第二十三轮补的半句：role 是父组件 state，
    // 上一个用例改成只读后不重置就与文案对不上，所以这两句必须一起改、一起钉。
    expect(screen.queryByText(/（默认 MEMBER）/)).toBeNull();
    // 「唯一的项目管理员除外，后端会拦下」是一句过头的豁免断言：set_member 只在
    // 「role_code 从 PROJECT_ADMIN 降级」时才调 _require_another_admin，且
    // exempt_system_admin=True 让平台管理员整个跳过这道门（project_services.py:233-238、
    // :277-280）。旧句会在「把平台管理员改成只读」明明能成的场合吓住人。
    expect(screen.queryByText(/唯一的项目管理员除外/)).toBeNull();
  });
});

// 单一 catch 把 403（ensure_member 拒绝：已不是成员，刷新永远不改结论）和断网
// 混成一句「或角色刚被改动，点刷新重试」——403 被翻译成了错的因果。
// 分句口径同 schedules.tsx:362/535：只有 ApiErr.status===403 才配喊权限。
describe("⑫ 列表失败横幅按状态码分句", () => {
  it("members GET 403 → 横幅说「你已不是本项目成员/没有读取权限，刷新不会改变结论」，不许出现「点「刷新」重试」式安慰；传输失败仍说网络不通+重试", async () => {
    mockBackend([M_SELF], { membersResp: [
      { status: 403, body: { code: "forbidden", message: "无此项目权限", details: {} } },
    ] });
    renderTab();
    expect(await screen.findByText("成员列表没取到", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.getByText("你已不是本项目成员或没有读取权限，刷新不会改变结论")).not.toBeNull();
    expect(screen.queryByText(/点「刷新」重试/)).toBeNull();

    cleanup();
    // 传输失败：members GET 直接 reject（fetch 抛 TypeError，不是 ApiErr）
    mockBackend([M_SELF]);
    const base = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/projects/p1/members") throw new TypeError("Failed to fetch");
      return base(input, init);
    }) as unknown as typeof fetch;
    renderTab();
    expect(await screen.findByText("成员列表没取到", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.getByText(/可能是网络不通，点「刷新」重试/)).not.toBeNull();
    expect(screen.queryByText(/你已不是本项目成员/)).toBeNull();
  });
});

// 第二十三轮：两处「取失败摊成空态」。
// ① 表体：首拉 500 时 rows 本就是空，这一格和「项目里真没人」长得一模一样，
//    而 :215 那条正对照证明 2xx 空数组才配说「还没有成员」。
// ② 弹窗候选：search() 的 catch 里 setCands([]) 之后，notFoundContent 那句
//    「没有匹配的用户」是对一个根本没成功的查询下的结论——用户会一直改关键字，
//    而真正的原因是请求没成。分句只到「没取到」为止，不自创原因（silent 请求，
//    client 不 toast，页面是唯一的信息出口）。
describe("⑬ 取失败不许摊成空态（表体 + 弹窗候选）", () => {
  it("members GET 500 且无缓存行：表体说「成员列表没取到…」，「还没有成员」一个字不出现", async () => {
    mockBackend([M_SELF], { membersResp: [
      { status: 500, body: { code: "internal_error", message: "服务器开小差了", details: {} } },
    ] });
    renderTab();
    expect(await screen.findByText("成员列表没取到，以上方的加载失败提示为准", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.queryByText("还没有成员")).toBeNull();
  });

  it("候选查 500：下拉说「候选用户没取到」而不是「没有匹配的用户」；重查成功后回到候选项本身", async () => {
    // candResp 只给一条 500：序列耗尽后回 2xx 的缺省体就是 CANDS，所以第二次查询
    // 天然「恢复」——桩的按次序变脸正好演一遍抖动。
    const calls = mockBackend([M_LI], { candResp: [
      { status: 500, body: { code: "internal_error", message: "网关 500", details: {} } },
    ] });
    renderTab();
    await screen.findByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    await waitFor(() => expect(candGets(calls).length).toBe(1));
    openDropdown(screen.getByTestId("member-candidate"));
    expect(await screen.findByText("候选用户没取到，重新输入可重试", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.queryByText("没有匹配的用户")).toBeNull();

    // 重查成功：失败句必须收掉（searchFailed 每次 search 开头归零），否则一次抖动
    // 会永久贴在这只下拉上，把「真的没匹配」也一并说成失败。
    const input = screen.getByTestId("member-candidate").querySelector("input")!;
    fireEvent.change(input, { target: { value: "li" } });
    await waitFor(() => expect(candGets(calls).length).toBe(2));
    await waitFor(() => expect(screen.queryByText("候选用户没取到，重新输入可重试")).toBeNull());
    expect(screen.queryByText("没有匹配的用户")).toBeNull(); // 有候选项，两句话都不该出现
    await waitFor(() => expect(visibleOptionTexts().some((t) => t.includes("lisi"))).toBe(true));
  });

  it("候选查成功但零条：还是「没有匹配的用户」，不许蹭失败句（正对照）", async () => {
    mockBackend([M_LI], { candidates: [] });
    renderTab();
    await screen.findByTestId("member-account");
    fireEvent.click(screen.getByTestId("member-add"));
    await screen.findByTestId("member-modal");
    openDropdown(screen.getByTestId("member-candidate"));
    expect(await screen.findByText("没有匹配的用户", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.queryByText(/候选用户没取到/)).toBeNull();
  });
});

// ── D245：高级搜索 + 列设置（三件套铺到项目成员）────────────────────────────
describe("D245 高级搜索 + 列设置（三件套铺到项目成员）", () => {
  const listCalls = (calls: Call[]) => calls.filter((c) =>
    c.method === "GET" && c.url.startsWith("/api/v1/projects/p1/members"));
  const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";

  it("空条件不拼 filter；应用「账号包含 li」后重查且请求带条件 JSON", async () => {
    // 变异靶：load 不接 advFilter（重查请求无 filter）· 空条件也拼 filter=
    const calls = mockBackend([M_SELF, M_LI, M_ANON]);
    renderTab();
    await waitFor(() => expect(screen.getByText("lisi")).toBeTruthy());
    expect(listCalls(calls)[0].url).toBe("/api/v1/projects/p1/members");
    const before = listCalls(calls).length;
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    // 字段名来自后端 meta 的第一项（account），前端不自列字段
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "li" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listCalls(calls).length).toBe(before + 1));
    const last = listCalls(calls)[listCalls(calls).length - 1];
    const q = new URL(last.url, "http://t.test").searchParams;
    expect(JSON.parse(q.get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "account", operator: "CONTAINS", value: "li" }],
    });
  });

  it("列设置勾掉「姓名」只藏那一列（其余表头原样）", async () => {
    // 变异靶：columns 不包 applyColumnPrefs（勾了没反应）· key 与 CHOICES 漂移（藏错列）
    mockBackend([M_SELF, M_LI, M_ANON]);
    renderTab();
    await waitFor(() => expect(screen.getByText("lisi")).toBeTruthy());
    expect(thead()).toContain("姓名");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["账号", "姓名", "角色"]);
    fireEvent.click(boxes[labels.indexOf("姓名")]);
    await waitFor(() => expect(thead()).not.toContain("姓名"));
    expect(thead()).toContain("角色");
  });
});
