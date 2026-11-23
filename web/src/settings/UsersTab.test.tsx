// 用户管理 Tab（§11.4.27 Tab2）此前全仓库对它唯一的引用断言是 e2e 的「Tab 挂出来了」，
// 四个写动作零断言——1G 台账 D63 同类的「有实现、无测试」面：删掉 post(...) 门禁仍全绿。
// 钉十条契约（字段名/约束/状态词表以后端 schemas.py 为准，不照前端猜）：
// ① 列表列画法 + 状态徽标语义（active=绿「启用」/其它=红「停用」，null 邮箱画「—」，类型列逐行绑定，空表画「还没有用户」）；
// ② 新建 → POST /system/users，body 字段逐字 = UserCreateIn（schemas.py:36）；成功 toast+关窗+重拉；
// ③ 校验不过不发请求（字段级红字 + POST 数=0；min 8 / pattern 镜像后端，不自创规则）；
// ④ D171：编辑弹窗预填本人 name/email，PATCH body 送 UserUpdateIn 认的字段
//    （改密码带 password；只改资料不带 password 键——留空是「不改」不是「重置」）；成功关窗；
// ⑤ 启停 → POST /system/users/{id}/status body {user_id,status}（词表 active|disabled=UserStatusIn），
//    Popconfirm 取消 = 什么都不发；
// ⑥ 错误面：后端中文 message 原样上屏、原始 code 不上屏、失败不关窗可重试、启停失败也重拉（徽标不乐观翻转）；
// ⑦ 门把手门禁（can* 全关时入口消失）+ next_cursor 的 [加载更多] 翻页接线；
// ⑧ 列表失败面（silent GET 不弹 toast）：Alert「用户列表没取到」+ 失败清空旧行（reset 口径）+ 重试成功恢复；
// ⑨ 批量导入向导导入成功 → 列表重拉：父子接线（UsersTab 的 onImported={refresh}）由真向导驱动；
// ⑩ 第二十三轮：启停把手按后端三种结局分句（自己的行不给钮 / 管理员行预告「最后一个」拦截 /
//    失败态的空表说「没取到」而不是「还没有用户」）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfigProvider, message } from "antd";
import UsersTab from "./UsersTab";
import type { UserRow } from "../api/api";
import type { UserImportCommitOut, UserImportPreviewOut } from "../api/userImport";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// D171：后端 UserOut 已吐 created_at，UserRow（api.ts）与生成的 schema.d.ts（D149）未跟上——
// 本地镜像同 UsersTab.tsx 的 UserRowOut，不动生成物。
type Row = UserRow & { created_at?: string | null };

const ADMIN: Row = { id: "u1", account: "admin", name: "管理员", email: null,
  is_system_admin: true, status: "active", created_at: "2026-01-02T03:04:05+00:00" };
const LI: Row = { id: "u2", account: "lisi", name: "李四", email: "li@x.com",
  is_system_admin: false, status: "disabled", created_at: "2025-12-31T16:00:00+00:00" };
// 分句测试要一条「普通用户 + active」的行：ADMIN 是管理员行、LI 是停用方向，
// 「管理员那句不加」只有在 active 的普通用户行上才断言得了。
const ZHANG: Row = { id: "u3", account: "wangwu", name: "王五", email: null,
  is_system_admin: false, status: "active" };

// ⑨ 接线测试用的向导回执，只取「导入成功一条」这一条腿；向导状态机本身的账在
// UserImportWizard.test.tsx，这里不重验，只验它和 UsersTab 之间的线没断。
const IMPORT_PREVIEW: UserImportPreviewOut = {
  new_count: 1, conflict_count: 0,
  items: [{ line: 2, account: "zhaoliu", name: "赵六", email: null, exists: false }],
  errors: [],
};
const IMPORT_COMMIT: UserImportCommitOut = {
  ok: true, created: 1, skipped: 0, failed: 0, failures: [], skipped_detail: [],
};

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// D244：高级搜索三件套的依赖。字段与后端 USER_LIST_FILTER 同名同 kind。
const FILTER_META = {
  view_type: "user", view_label: "平台用户",
  supported_view_types: ["user"],
  fields: [
    { field: "account", label: "账号", kind: "text",
      ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS"] },
    { field: "status", label: "状态", kind: "enum",
      ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
    { field: "is_system_admin", label: "平台管理员", kind: "bool",
      ops: ["EQUALS", "NOT_EQUALS"] },
  ],
  unavailable: {},
};

interface Call { url: string; method: string; body?: string }
type Resp = { status: number; body: unknown };

/** createResp/pwResp/toggleResp/listResp 是「该端点第 1/2/… 次请求的回执」序列：
 * 数组耗尽后回 2xx——「失败不关窗 → 就地重试能成」这条契约要求桩能按次序变脸。
 * listResp 是后补的：列表 GET 此前恒 2xx，UsersTab 的 catch→failed 分支在测试里根本不可达。 */
function mockBackend(rows: UserRow[], over: {
  firstCursor?: string | null; moreRows?: UserRow[];
  createResp?: Resp[]; pwResp?: Resp[]; toggleResp?: Resp[]; listResp?: Resp[];
} = {}): Call[] {
  const calls: Call[] = [];
  const take = (seq: Resp[] | undefined, i: number, okBody: Resp): Resp =>
    seq && i < seq.length ? seq[i] : okBody;
  let nCreate = 0;
  let nPw = 0;
  let nToggle = 0;
  let nList = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    // D244：ListToolbar 挂载即拉元数据与个人视图（未 mock 会 throw，整页红成取数失败）
    if (url.includes("/filter-meta?")) return res(200, FILTER_META);
    if (url.includes("/saved-views?")) return res(200, []);
    if (method === "GET" && url.startsWith("/api/v1/system/users?")) {
      const page = url.includes("cursor=")
        ? { items: over.moreRows ?? [], next_cursor: null }
        : { items: rows, next_cursor: over.firstCursor ?? null };
      const r = take(over.listResp, nList++, { status: 200, body: page });
      return res(r.status, r.body);
    }
    if (method === "POST" && url === "/api/v1/system/users") {
      const r = take(over.createResp, nCreate++, { status: 201, body: rows[0] });
      return res(r.status, r.body);
    }
    if (method === "PATCH" && url.startsWith("/api/v1/system/users/")) {
      const r = take(over.pwResp, nPw++, { status: 200, body: rows[0] });
      return res(r.status, r.body);
    }
    if (method === "POST" && /\/system\/users\/[^/]+\/status$/.test(url)) {
      const r = take(over.toggleResp, nToggle++, { status: 200, body: rows[0] });
      return res(r.status, r.body);
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

const createPosts = (c: Call[]) => c.filter((x) => x.method === "POST" && x.url === "/api/v1/system/users");
const statusPosts = (c: Call[]) => c.filter((x) => x.method === "POST" && x.url.endsWith("/status"));
const pwPatches = (c: Call[]) => c.filter((x) => x.method === "PATCH" && x.url.startsWith("/api/v1/system/users/"));
const listGets = (c: Call[]) => c.filter((x) => x.method === "GET" && x.url.startsWith("/api/v1/system/users?"));

/** motion:false 同 shell.test.tsx:40-45：rc-motion 的 leave 动画在 jsdom 里不完成，
 * destroyOnClose 的弹窗关掉后节点永远留在 DOM，「成功/失败后窗关不关」就断言不了。 */
function renderTab(over: {
  canCreate?: boolean; canUpdate?: boolean; canDisable?: boolean; selfId?: string;
} = {}) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <UsersTab projectId="p1" canCreate={over.canCreate ?? true} canUpdate={over.canUpdate ?? true}
        canDisable={over.canDisable ?? true} selfId={over.selfId ?? ""} />
    </ConfigProvider>,
  );
}

function toastText(): string {
  return Array.from(document.querySelectorAll(".ant-message")).map((n) => n.textContent).join("|");
}

/** 校验不过时必须「就地返回」，不许把 validateFields 的 rejection 抛给 `void create()`。
 * 这里**不是**吞掉 rejection 让测试变绿，而是把它收集起来断言为空：一旦有人把
 * UsersTab.create/resetPassword 里的 try-catch 删掉（改回 `await form.validateFields()`），
 * 这条就会红。仓库里的正确写法参照 ChangePasswordModal.tsx:24-29。
 * 为什么用 process 监听而不是 window：vitest 的 node 环境里未处理 rejection 落在 process 上，
 * 且 vitest 自带一个 unhandledRejection 监听器会直接把测试判失败——它只看「有没有别的监听器」
 * （同事件监听器 >1 即不上报），所以这里加一个自己的监听器既是收集也是不让位给默认报错路径。 */
async function expectNoUnhandledRejection(fn: () => Promise<void> | void): Promise<void> {
  const seen: unknown[] = [];
  const collect = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", collect);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 0)); // 给 rejection 到达 process 的时间
  } finally {
    process.off("unhandledRejection", collect);
  }
  if (seen.length > 0) {
    throw new Error("校验失败路径漏出了未处理 rejection（validateFields 的 reject 没就地吞掉）："
      + seen.map((e) => String(e)).join("; "));
  }
}

beforeEach(() => {
  cleanup();
  message.destroy();
});

afterEach(() => cleanup());

describe("① 列表渲染", () => {
  it("账号/类型/状态列画法：平台管理员金标、active 绿「启用」、非 active 红「停用」、null 邮箱画 —", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-account");
    // 请求口径：GET /system/users?size=50（PAGE=50 是后端 UserListIn 的默认页）。
    // D244：ListToolbar 也往 calls 记账，取「列表请求」要按端点族收窄，不能取 calls[0]。
    expect(listGets(calls)[0].url).toBe("/api/v1/system/users?size=50");
    expect(listGets(calls)[0].method).toBe("GET");

    const accounts = screen.getAllByTestId("user-account").map((n) => n.textContent);
    expect(accounts).toEqual(["admin", "lisi"]);
    // 「姓名/邮箱」列没有 testid——按列值断言，删列就红
    expect(screen.getByText("李四")).not.toBeNull();
    expect(screen.getByText("li@x.com")).not.toBeNull();
    expect(screen.getByText("—")).not.toBeNull(); // ADMIN 的 null 邮箱

    // 类型列必须逐行绑定：is_system_admin 是带权限语义的列，此前「getByTestId + getByText」
    // 各查各的存在性，把 gold/普通两个 Tag 分支整体互换仍全绿——行内断言才钉得住。
    const rowOf = (account: string) => {
      const cell = screen.getAllByTestId("user-account").find((n) => n.textContent === account);
      if (!cell) throw new Error("行没画出来: " + account);
      return within(cell.closest("tr") as HTMLElement);
    };
    const adminTag = rowOf("admin").getByTestId("user-admin");
    expect(adminTag.textContent).toBe("平台管理员");
    expect(adminTag.className).toContain("ant-tag-gold");
    const normalTag = rowOf("lisi").getByText("普通用户");
    expect(normalTag.className).not.toContain("ant-tag-gold");
    expect(rowOf("lisi").queryByTestId("user-admin")).toBeNull(); // 金标不许挂到普通用户行

    const tags = screen.getAllByTestId("user-status");
    expect(tags.map((t) => t.textContent)).toEqual(["启用", "停用"]);
    expect(tags[0].className).toContain("ant-tag-green");
    expect(tags[1].className).toContain("ant-tag-red");
  });

  it("D171 创建时间列：行内渲染 created_at（UTC→展示时区），缺字段的行画「—」不画假时刻", async () => {
    mockBackend([ADMIN, LI, ZHANG]);
    renderTab();
    const created = await screen.findAllByTestId("user-created");
    // 逐行绑定（同类型/状态列的教训）：按账号找到那一行，断言那一格的文本。
    // 2026-01-02T03:04:05+00:00 → Asia/Shanghai = 11:04:05（shared/timefmt 口径）。
    const rowOf = (account: string) => {
      const cell = screen.getAllByTestId("user-account").find((n) => n.textContent === account);
      if (!cell) throw new Error("行没画出来: " + account);
      return within(cell.closest("tr") as HTMLElement);
    };
    expect(rowOf("admin").getByTestId("user-created").textContent).toBe("2026-01-02 11:04:05");
    expect(rowOf("lisi").getByTestId("user-created").textContent).toBe("2026-01-01 00:00:00");
    // ZHANG 桩里没有 created_at：缺 = 画「—」，不许渲染成 1970 或 undefined
    expect(rowOf("wangwu").getByTestId("user-created").textContent).toBe("—");
    expect(created).toHaveLength(3);
  });

  it("空表：emptyText「还没有用户」上屏（此前所有桩位都塞了行，空态零覆盖）", async () => {
    mockBackend([]);
    renderTab();
    expect(await screen.findByText("还没有用户", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.queryByTestId("user-account")).toBeNull(); // 没行也没幽灵 testid
  });
});

describe("② 新建用户", () => {
  it("填表 → POST /system/users，body 逐字=UserCreateIn；成功 toast + 关窗 + 列表重拉", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-account");
    fireEvent.click(screen.getByTestId("user-create"));
    await screen.findByTestId("user-form");
    fireEvent.change(screen.getByTestId("user-field-account"), { target: { value: "zhangsan" } });
    fireEvent.change(screen.getByTestId("user-field-name"), { target: { value: "张三" } });
    fireEvent.change(screen.getByTestId("user-field-email"), { target: { value: "z@x.com" } });
    fireEvent.change(screen.getByTestId("user-field-password"), { target: { value: "Passw0rd!" } });
    fireEvent.click(screen.getByTestId("user-field-admin"));
    const getsBefore = listGets(calls).length;
    fireEvent.click(await screen.findByTestId("user-create-ok"));

    await waitFor(() => expect(createPosts(calls).length).toBe(1));
    // 字段名与 UserCreateIn（schemas.py:36-41）逐字对齐，多余的确认位不许混进来
    expect(JSON.parse(createPosts(calls)[0].body!)).toEqual({
      account: "zhangsan", name: "张三", email: "z@x.com",
      password: "Passw0rd!", is_system_admin: true,
    });
    await waitFor(() => expect(toastText()).toContain("用户已创建，请把密码转告本人"));
    await waitFor(() => expect(screen.queryByTestId("user-modal")).toBeNull());
    await waitFor(() => expect(listGets(calls).length).toBe(getsBefore + 1)); // 成功后必重拉
  });
});

describe("③ 校验不过不发请求", () => {
  it("密码 7 位 / 账号带非法字符 / 姓名留空 → 三条字段级红字，POST /system/users 一条不发", async () => {
    const calls = mockBackend([ADMIN]);
    renderTab();
    await screen.findAllByTestId("user-account");
    fireEvent.click(screen.getByTestId("user-create"));
    await screen.findByTestId("user-form");
    fireEvent.change(screen.getByTestId("user-field-account"), { target: { value: "bad account!" } });
    fireEvent.change(screen.getByTestId("user-field-password"), { target: { value: "short" } });
    await expectNoUnhandledRejection(async () => {
      fireEvent.click(await screen.findByTestId("user-create-ok"));
    });
    // 三条红字逐字对照 UsersTab 的 rules（min 8 镜像 UserCreateIn.password min_length=8，
    // pattern 镜像其 pattern——前端规则只能是后端规则的镜像，不许自创）
    expect(await screen.findByText("至少 8 位", {}, { timeout: 2000 })).not.toBeNull();
    expect(await screen.findByText("只能有字母数字 _ . -", {}, { timeout: 2000 })).not.toBeNull();
    expect(await screen.findByText("请输入姓名", {}, { timeout: 2000 })).not.toBeNull();
    expect(createPosts(calls)).toHaveLength(0);
    expect(screen.queryByTestId("user-modal")).not.toBeNull(); // 红字留在原地改，窗不许关
  });

  it("重置密码弹窗同样：7 位新密码只出红字，PATCH 一条不发（对齐 UserUpdateIn.password min_length=8）", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-pw");
    fireEvent.click(screen.getAllByTestId("user-pw")[0]);
    await screen.findByTestId("pw-field");
    fireEvent.change(screen.getByTestId("pw-field"), { target: { value: "short" } });
    await expectNoUnhandledRejection(async () => {
      fireEvent.click(await screen.findByTestId("pw-ok"));
    });
    expect(await screen.findByText("至少 8 位", {}, { timeout: 2000 })).not.toBeNull();
    expect(pwPatches(calls)).toHaveLength(0);
    expect(screen.queryByTestId("pw-modal")).not.toBeNull();
  });
});

describe("④ 编辑用户（D171：name + email + password 三项，对齐 UserUpdateIn）", () => {
  it("user-pw → 弹窗带本人姓名并预填其 name/email → 改密码后 PATCH body = {name,email,password} → toast + 关窗", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-pw");
    // 第二行是李四（disabled 态也要能编辑）
    fireEvent.click(screen.getAllByTestId("user-pw")[1]);
    const modal = await screen.findByTestId("pw-modal");
    expect(modal.textContent).toContain("编辑用户 · 李四");
    // 预填 = 本人当前值：删掉 initialValues 这两条先红（不是空串、不是 undefined）
    expect((screen.getByTestId("pw-field-name") as HTMLInputElement).value).toBe("李四");
    expect((screen.getByTestId("pw-field-email") as HTMLInputElement).value).toBe("li@x.com");
    fireEvent.change(screen.getByTestId("pw-field-name"), { target: { value: "李四改" } });
    fireEvent.change(screen.getByTestId("pw-field-email"), { target: { value: "li-new@x.com" } });
    fireEvent.change(screen.getByTestId("pw-field"), { target: { value: "FreshPass@9" } });
    fireEvent.click(await screen.findByTestId("pw-ok"));
    await waitFor(() => expect(pwPatches(calls).length).toBe(1));
    expect(pwPatches(calls)[0].url).toBe("/api/v1/system/users/u2");
    // body 逐字 {name,email,password}：user_id 是路由投影从 path 注入的（service.py:352-360），不许混进 body；
    // 只 PATCH password 的旧画法（body 只有 {password}）在这条必须红。
    expect(JSON.parse(pwPatches(calls)[0].body!)).toEqual({
      name: "李四改", email: "li-new@x.com", password: "FreshPass@9",
    });
    await waitFor(() => expect(toastText()).toContain("密码已重置，请转告本人尽快修改"));
    await waitFor(() => expect(screen.queryByTestId("pw-modal")).toBeNull());
    // 表单 reset 在两处各做了一次（成功路径 + 打开弹窗的按钮，且 Modal 是 destroyOnHidden），
    // 本条测不出删掉哪一处才致命——reset 双重覆盖，别让这条冒充它可变异杀死。
  });

  it("密码留空 = 只改资料：PATCH body 没有 password 键（后端 None 分支不触哈希）", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-pw");
    fireEvent.click(screen.getAllByTestId("user-pw")[1]);
    await screen.findByTestId("pw-field");
    fireEvent.change(screen.getByTestId("pw-field-name"), { target: { value: "只改名" } });
    fireEvent.click(await screen.findByTestId("pw-ok"));
    await waitFor(() => expect(pwPatches(calls).length).toBe(1));
    const body = JSON.parse(pwPatches(calls)[0].body!);
    expect(body).toEqual({ name: "只改名", email: "li@x.com" });
    expect("password" in body).toBe(false); // password:"" 会被 UserUpdateIn 的 min_length=8 打 422
    await waitFor(() => expect(toastText()).toContain("用户资料已更新"));
  });

  it("姓名清空 → 字段级红字「请输入姓名」，PATCH 一条不发（name 在后端可选、在这里必填：PATCH 语义是「不带=不改」，前端送空串=绕过 min_length=1）", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-pw");
    fireEvent.click(screen.getAllByTestId("user-pw")[1]);
    await screen.findByTestId("pw-field");
    fireEvent.change(screen.getByTestId("pw-field-name"), { target: { value: "" } });
    await expectNoUnhandledRejection(async () => {
      fireEvent.click(await screen.findByTestId("pw-ok"));
    });
    expect(await screen.findByText("请输入姓名", {}, { timeout: 2000 })).not.toBeNull();
    expect(pwPatches(calls)).toHaveLength(0);
  });
});

describe("⑤ 启用/停用（Popconfirm 二确 + 词表对齐 UserStatusIn）", () => {
  /** antd 两字按钮自动空格成「确 定」（CaseList.test.tsx:91 同款正则容忍）。 */
  async function popButton(re: RegExp) {
    return screen.findByRole("button", { name: re }, { timeout: 2000 });
  }

  it("取消 = 什么都不发：气泡里点[取消]，status 请求一条不增", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-toggle");
    fireEvent.click(screen.getAllByTestId("user-toggle")[0]);
    // 二次确认文案先钉住：停用方向必须说清后果。第一行是平台管理员，所以带那句
    // 「最后一个可用管理员」预告（分句本身的正/反对照在下面第二十三轮那一组）。
    expect(await screen.findByText(
      "停用后该账号无法登录；若这是最后一个可用的平台管理员，后端会拦下这一步",
      {}, { timeout: 2000 },
    )).not.toBeNull();
    fireEvent.click(await popButton(/^取\s*消$/));
    await new Promise((r) => setTimeout(r, 50));
    expect(statusPosts(calls)).toHaveLength(0);
    expect(listGets(calls)).toHaveLength(1); // 也不许偷偷重拉
  });

  it("active 行：确定 → POST /users/u1/status body {user_id,status:'disabled'} + toast「已停用」+ 重拉", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-toggle");
    const toggles = screen.getAllByTestId("user-toggle");
    expect(toggles.map((t) => t.textContent)).toEqual(["停用", "启用"]); // 钮向跟着当前状态走
    fireEvent.click(toggles[0]);
    fireEvent.click(await popButton(/^确\s*定$/));
    await waitFor(() => expect(statusPosts(calls).length).toBe(1));
    expect(statusPosts(calls)[0].url).toBe("/api/v1/system/users/u1/status");
    // body 逐字 {user_id,status}：词表 active|disabled（UserStatusIn.pattern），status 放 body 不放 query
    expect(JSON.parse(statusPosts(calls)[0].body!)).toEqual({ user_id: "u1", status: "disabled" });
    await waitFor(() => expect(toastText()).toContain("已停用"));
    expect(listGets(calls).length).toBe(2); // 落库后必重拉，徽标不乐观翻转
  });

  it("disabled 行：确定 → status='active' + toast「已启用」（同一钮反向）", async () => {
    const calls = mockBackend([ADMIN, LI]);
    renderTab();
    await screen.findAllByTestId("user-toggle");
    fireEvent.click(screen.getAllByTestId("user-toggle")[1]);
    expect(await screen.findByText("恢复该账号登录", {}, { timeout: 2000 })).not.toBeNull();
    fireEvent.click(await popButton(/^确\s*定$/));
    await waitFor(() => expect(statusPosts(calls).length).toBe(1));
    expect(statusPosts(calls)[0].url).toBe("/api/v1/system/users/u2/status");
    expect(JSON.parse(statusPosts(calls)[0].body!)).toEqual({ user_id: "u2", status: "active" });
    await waitFor(() => expect(toastText()).toContain("已启用"));
  });
});

describe("第二十三轮：启停把手按后端三种结局分句（user_services.py:89-98）", () => {
  /** 行内定位：同页两行都有 user-toggle，按账号找到那一行的把手。 */
  function toggleOf(account: string): HTMLElement {
    const cell = screen.getAllByTestId("user-account").find((n) => n.textContent === account);
    if (!cell) throw new Error("行没画出来: " + account);
    const btn = (cell.closest("tr") as HTMLElement).querySelector('[data-testid="user-toggle"]');
    if (!btn) throw new Error("该行没有启停把手: " + account);
    return btn as HTMLElement;
  }

  it("自己那一行不给启停把手：后端 user_id == ctx.user_id 必 400，确认框是注定被拒的点击", async () => {
    mockBackend([ADMIN, LI]);
    renderTab({ selfId: "u1" });
    await screen.findAllByTestId("user-account");
    // 自己的行：重置密码还在（PATCH 不禁自己），只有启停钮收掉
    expect(screen.getAllByTestId("user-pw").length).toBe(2);
    const toggles = screen.getAllByTestId("user-toggle");
    expect(toggles.map((t) => t.textContent)).toEqual(["启用"]);
    expect(() => toggleOf("admin")).toThrow();
  });

  it("selfId 为空串（拿不到本人 id 的旧快照）：把手照常给，不因为「空 == 空」把整列收掉", async () => {
    mockBackend([LI]);
    renderTab({ selfId: "" });
    await screen.findAllByTestId("user-account");
    expect(screen.getAllByTestId("user-toggle").length).toBe(1);
  });

  it("管理员行的停用确认带「最后一个可用管理员会被拦下」；普通用户行不加这句", async () => {
    mockBackend([ADMIN, ZHANG]);
    renderTab();
    await screen.findAllByTestId("user-toggle");
    fireEvent.click(toggleOf("admin"));
    // 逐字：整串标题 = 通用后果 + 管理员那一句预告。列表这一行看不出是不是最后一个，
    // 所以只能是「若…会拦下」，不许写成「这个账号删不掉」那种肯定句。
    expect(await screen.findByText(
      "停用后该账号无法登录；若这是最后一个可用的平台管理员，后端会拦下这一步",
      {}, { timeout: 2000 },
    )).not.toBeNull();
    expect(screen.queryByText(/^停用后该账号无法登录$/)).toBeNull();
  });

  it("普通用户的 active 行：确认只有通用那句，不带管理员预告", async () => {
    mockBackend([ADMIN, ZHANG]);
    renderTab();
    await screen.findAllByTestId("user-toggle");
    fireEvent.click(toggleOf("wangwu"));
    expect(await screen.findByText("停用后该账号无法登录", {}, { timeout: 2000 })).not.toBeNull();
    expect(document.body.textContent).not.toContain("最后一个可用的平台管理员");
  });
});

describe("⑥ 错误面（client.ts 信封口径：中文 message 上屏，code 不上屏）", () => {
  it("403 建用户：后端中文 message 原样 toast，原始 code 不上屏，弹窗不关且可重试成", async () => {
    const calls = mockBackend([ADMIN], { createResp: [
      { status: 403, body: { code: "forbidden", message: "没有权限执行该操作", details: {} } },
      { status: 201, body: ADMIN },
    ] });
    renderTab();
    await screen.findAllByTestId("user-account");
    fireEvent.click(screen.getByTestId("user-create"));
    await screen.findByTestId("user-form");
    fireEvent.change(screen.getByTestId("user-field-account"), { target: { value: "zhangsan" } });
    fireEvent.change(screen.getByTestId("user-field-name"), { target: { value: "张三" } });
    fireEvent.change(screen.getByTestId("user-field-password"), { target: { value: "Passw0rd!" } });
    fireEvent.click(await screen.findByTestId("user-create-ok"));
    await waitFor(() => expect(toastText()).toContain("没有权限执行该操作"));
    expect(toastText()).not.toContain("forbidden");
    expect(screen.queryByTestId("user-modal")).not.toBeNull(); // 失败不关窗：改完就地重试

    fireEvent.click(screen.getByTestId("user-create-ok"));
    await waitFor(() => expect(createPosts(calls).length).toBe(2));
    await waitFor(() => expect(toastText()).toContain("用户已创建"));
    await waitFor(() => expect(screen.queryByTestId("user-modal")).toBeNull());
  });

  it("400 重置密码（最后一个管理员）：中文 message 上屏、code 不上屏、窗不关", async () => {
    const calls = mockBackend([ADMIN], { pwResp: [
      { status: 400, body: { code: "invalid_input", message: "这是最后一个可用的系统管理员", details: {} } },
    ] });
    renderTab();
    await screen.findAllByTestId("user-pw");
    fireEvent.click(screen.getByTestId("user-pw"));
    await screen.findByTestId("pw-field");
    fireEvent.change(screen.getByTestId("pw-field"), { target: { value: "FreshPass@9" } });
    fireEvent.click(await screen.findByTestId("pw-ok"));
    await waitFor(() => expect(toastText()).toContain("这是最后一个可用的系统管理员"));
    expect(toastText()).not.toContain("invalid_input");
    expect(pwPatches(calls)).toHaveLength(1);
    expect(screen.queryByTestId("pw-modal")).not.toBeNull();
  });

  it("400 启停「不能禁用自己的账号」：中文 message 上屏、code 不上屏，且失败后仍重拉（徽标不乐观翻转）", async () => {
    // selfId 留空 = 本页拿不到本人 id（旧快照），把手照给，于是这句 400 仍在。
    // 第⑩组把自己的行的把手收掉后，正常会话已点不出这条——留它是因为服务端错误面
    // 不因为前端藏了把手就改画法（后端仍是唯一门禁）。
    const calls = mockBackend([ADMIN], { toggleResp: [
      { status: 400, body: { code: "invalid_input", message: "不能禁用自己的账号", details: {} } },
    ] });
    renderTab();
    await screen.findAllByTestId("user-toggle");
    fireEvent.click(screen.getByTestId("user-toggle"));
    fireEvent.click(await screen.findByRole("button", { name: /^确\s*定$/ }, { timeout: 2000 }));
    await waitFor(() => expect(toastText()).toContain("不能禁用自己的账号"));
    expect(toastText()).not.toContain("invalid_input");
    // catch 分支也要 load(true)：POST 之后必须再来一次 GET，否则「失败不重拉、徽标乐观翻转」
    // 与「失败重拉以服务端为准」在测试里长一个样——成功侧的重拉第⑤组已钉，失败侧此前没人头账。
    await waitFor(() => expect(statusPosts(calls).length).toBe(1));
    expect(listGets(calls).length).toBe(2);
    // 重拉拿回的还是 active：行徽标/钮向没被那次失败的 POST 带跑
    expect(screen.getByTestId("user-status").textContent).toBe("启用");
    expect(screen.getByTestId("user-toggle").textContent).toBe("停用");
  });
});

describe("⑦ 门把手门禁 + 加载更多", () => {
  it("can* 全 false：新建/批量导入/重置密码/启停全不给（门禁在后端，前端只是不给把手）", async () => {
    mockBackend([ADMIN, LI]);
    renderTab({ canCreate: false, canUpdate: false, canDisable: false });
    await screen.findAllByTestId("user-account");
    expect(screen.queryByTestId("user-create")).toBeNull();
    expect(screen.queryByTestId("user-batch-import")).toBeNull();
    expect(screen.queryByTestId("user-pw")).toBeNull();
    expect(screen.queryByTestId("user-toggle")).toBeNull();
  });

  it("next_cursor 有值 → [加载更多] 出现；点击后带 cursor 请求并把下页拼进列表", async () => {
    const calls = mockBackend([ADMIN], { firstCursor: "u1", moreRows: [LI] });
    renderTab();
    const more = await screen.findByTestId("users-more");
    fireEvent.click(more);
    await waitFor(() => expect(
      calls.some((c) => c.method === "GET" && c.url.includes("cursor=u1")),
    ).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId("user-account").length).toBe(2));
    await waitFor(() => expect(screen.queryByTestId("users-more")).toBeNull()); // 下页无 cursor，钮收掉
  });
});

describe("⑧ 列表失败面（silent GET 失败：只有 Alert，不许冒 toast）", () => {
  it("首拉成功 → [刷新] 失败：Alert「用户列表没取到」上屏且旧行清空 → 再 [刷新] 成功：行回来、Alert 消失", async () => {
    const ok = { status: 200, body: { items: [ADMIN, LI], next_cursor: null } };
    const calls = mockBackend([ADMIN, LI], { listResp: [
      ok,
      { status: 500, body: { code: "http_500", message: "服务开小差了", details: {} } },
      ok,
    ] });
    renderTab();
    await screen.findAllByTestId("user-account");
    // 前缀不锚 ^：ReloadOutlined 图标的 aria-label（reload）会并进按钮的可及名
    const refresh = () => screen.getByRole("button", { name: /刷\s*新$/ });
    fireEvent.click(refresh());
    // 显式 timeout：dtl 默认只等 1s，实测全量 pytest 与 ⑥ 同跑时这条在 1s 内等不到第 2 次 GET
    // （报「expected 1 to be 2」，单跑同文件 21/21 绿）——取证环境的负载，不是产品缺陷。
    await waitFor(() => expect(listGets(calls).length).toBe(2), { timeout: 3000 });

    expect(await screen.findByText("用户列表没取到", {}, { timeout: 2000 })).not.toBeNull();
    expect(screen.getByText("可能是网络不通，点「刷新」重试")).not.toBeNull();
    // catch 里的 reset 分支：失败必须清空旧行——留着上一批旧数据装新快照，比报错更坏
    await waitFor(() => expect(screen.queryByTestId("user-account")).toBeNull(), { timeout: 3000 });
    // load 是 silent:true：列表失败只画 Alert，不许再弹一条 toast（⑥ 的口径只管非 silent 端点）
    expect(toastText()).not.toContain("服务开小差了");

    fireEvent.click(refresh()); // 第 3 次 GET 回 2xx（序列耗尽前恰好排回 ok）
    await waitFor(() => expect(listGets(calls).length).toBe(3));
    await waitFor(() => expect(screen.getAllByTestId("user-account").length).toBe(2));
    expect(screen.queryByText("用户列表没取到")).toBeNull();
  });

  it("首拉就失败：空表那一格说「没取到」而不是「还没有用户」——失败不许摊成空", async () => {
    mockBackend([], { listResp: [
      { status: 500, body: { code: "http_500", message: "服务开小差了", details: {} } },
    ] });
    renderTab();
    expect(await screen.findByText("用户列表没取到，以上方的加载失败提示为准", {}, { timeout: 2000 })).not.toBeNull();
    // 「还没有用户」= 平台真没人，这句在失败态是一句肯定句假话；上面那条 2xx 空表就是它的正对照
    expect(screen.queryByText("还没有用户")).toBeNull();
  });
});

describe("⑨ 批量导入 → 列表重拉（UsersTab 182 行 onImported={refresh} 的父子接线）", () => {
  it("走真向导导入成功 → 列表真多一次 GET：把 onImported 改成 () => undefined 这条必须红", async () => {
    const calls = mockBackend([ADMIN, LI]);
    // 补桩向导的两条导入端点（URL 口径同 UserImportWizard.test.tsx:51-58）。不 vi.mock 子组件：
    // 真向导在 UsersTab 的渲染树里跑完三步，才能证明「子调用回调 → 父真的重拉」这根线在，
    // 而不是各自文件里各证半截（uiw-* 在这条之前于本文件零出现）。
    const base = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const jsonBody = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (method === "POST" && url.endsWith("/system/users/import-preview")) return jsonBody(IMPORT_PREVIEW);
      if (method === "POST" && url.endsWith("/system/users/import-commit")) return jsonBody(IMPORT_COMMIT);
      return base(input, init); // 列表 GET 仍走本页 mockBackend 的账本
    }) as unknown as typeof fetch;

    renderTab();
    await screen.findAllByTestId("user-account");
    fireEvent.click(screen.getByTestId("user-batch-import"));
    fireEvent.change(await screen.findByTestId("uiw-text"), { target: { value: "账号,姓名\nzhaoliu,赵六\n" } });
    fireEvent.click(screen.getByTestId("uiw-parse"));
    await screen.findByTestId("uiw-counts");
    fireEvent.change(screen.getByTestId("uiw-password"), { target: { value: "Import@123" } });
    const getsBefore = listGets(calls).length;
    fireEvent.click(screen.getByTestId("uiw-commit"));

    // 先钉「导入真的做成了」再钉重拉：否则任何一条 POST 失败都可能让下面的 GET 断言假绿/假红
    expect((await screen.findByTestId("uiw-receipt")).textContent).toContain("成功 1 · 跳过 0 · 失败 0");
    await waitFor(() => expect(listGets(calls).length).toBe(getsBefore + 1));
  });
});

// ── D244：高级搜索 + 列设置（三件套铺到平台用户）────────────────────────────
describe("D244 高级搜索 + 列设置（三件套铺到平台用户）", () => {
  const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";

  it("空条件不拼 filter；应用「账号包含 admin」后重查且请求带条件 JSON", async () => {
    // 变异靶：load 不接 advFilter（重查请求无 filter）· 空条件也拼 filter=
    const calls = mockBackend([ADMIN, LI, ZHANG]);
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("user-account").length).toBe(3));
    expect(listGets(calls)[0].url).not.toContain("filter=");
    const before = listGets(calls).length;
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    // 字段名来自后端 meta 的第一项（account），前端不自列字段
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "admin" } });
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listGets(calls).length).toBe(before + 1));
    const last = listGets(calls)[listGets(calls).length - 1];
    const q = new URL(last.url, "http://t.test").searchParams;
    expect(JSON.parse(q.get("filter")!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "account", operator: "CONTAINS", value: "admin" }],
    });
  });

  it("列设置勾掉「邮箱」只藏那一列（其余表头原样）", async () => {
    // 变异靶：columns 不包 applyColumnPrefs（勾了没反应）· key 与 CHOICES 漂移（藏错列）
    const calls = mockBackend([ADMIN, LI, ZHANG]);
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("user-account").length).toBe(3));
    expect(calls.some((c) => c.url.includes("/filter-meta?"))).toBe(true);
    expect(thead()).toContain("邮箱");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["账号", "姓名", "邮箱", "创建时间", "类型", "状态"]);
    fireEvent.click(boxes[labels.indexOf("邮箱")]);
    await waitFor(() => expect(thead()).not.toContain("邮箱"));
    expect(thead()).toContain("创建时间");
  });
});
