// 角色 Tab（§11.4.21 / D37）vitest。三条判据 + 两条纯函数钉：
// ① 内置模板卡上永远没有 [编辑]/[删除]（前端不给门把手，门禁在后端 403）；
// ② 自定义角色卡上有 [编辑]/[删除]；
// ③ 勾一个权限位保存 → PATCH body 里就是这个位（真实 fetch 拦截，不是快照自嗨）；
// 另钉树的数据源永远是后端 role_perm_tree 的响应（前端不内置任何位清单）。
// 第十八轮补轴③ 四个零引用把手：tab-roles（整页容器）/ roles-load-failed（错误态双极性）/
// role-create-btn（点击开建抽屉 → POST 体）/ role-f-name（受控值 → PATCH name 与空名守卫）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import RolesTab, { leavesOnly, toCheckedKeys, type PermTreeNode } from "./RolesTab";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const NODES: PermTreeNode[] = [
  { key: "api", title: "api", children: [
    { key: "api:case:read", title: "api:case:read" },
    { key: "api:case:create", title: "api:case:create" },
  ] },
  { key: "env", title: "env", children: [
    { key: "env:config:read", title: "env:config:read" },
  ] },
];
const TEMPLATES = [
  { code: "READONLY", name: "只读", perms: ["*:read"] },
  { code: "MEMBER", name: "测试工程师", perms: ["*", "-*:delete"] },
];

function mockFetch(
  calls: { url: string; method: string; body?: string }[],
  items: unknown[] = [],
  fail: "" | "tree" | "roles" = "",
) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
    const isTree = url.includes("/role-perm-tree");
    // fail 开关："tree"/"roles" 让对应请求 500（组件是 silent 的，不弹 toast 只置 failed）
    if ((fail === "tree" && isTree) || (fail === "roles" && !isTree)) {
      return { ok: false, status: 500,
        json: async () => ({ code: "boom", message: "后端挂了" }) } as unknown as Response;
    }
    const body = isTree ? { nodes: NODES, templates: TEMPLATES } : { items, next_cursor: null };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const CUSTOM = [{ code: "role_abc", project_id: "p1", name: "接口专员",
  perms: ["api:case:read"], template_code: "READONLY" }];

function renderTab(over: { canCreate?: boolean; canUpdate?: boolean; canDelete?: boolean } = {}) {
  return render(<RolesTab projectId="p1" canCreate={over.canCreate ?? true}
    canUpdate={over.canUpdate ?? true} canDelete={over.canDelete ?? true} />);
}

beforeEach(() => cleanup());

describe("纯函数（勾选 ⇄ perms）", () => {
  it("leavesOnly：父节点 key（前缀族）不进提交体", () => {
    expect(leavesOnly(["api", "api:case:read", "env"], NODES)).toEqual(["api:case:read"]);
  });
  it("toCheckedKeys：模式串按 matchPerm 展开成实际放行的叶子（复制模板不虚树）", () => {
    expect(toCheckedKeys(["env:config:read"], NODES)).toEqual(["env:config:read"]);
    expect(toCheckedKeys(["*:read"], NODES)).toEqual(["api:case:read", "env:config:read"]);
    expect(toCheckedKeys(["*", "-*:delete"], NODES).length).toBe(3);
  });
});

describe("内置模板卡 vs 自定义卡（①②）", () => {
  it("内置卡：有 [从模板复制]、永远没有 [编辑]/[删除]", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls);
    renderTab();
    await screen.findAllByTestId("role-tpl-card");
    expect(screen.getAllByTestId("role-clone-btn").length).toBe(TEMPLATES.length);
    expect(screen.queryByTestId("role-edit-btn")).toBeNull();
    expect(screen.queryByTestId("role-delete-btn")).toBeNull();
  });

  it("自定义卡：有 [编辑]/[删除]；canUpdate/canDelete=false 时都不给", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM);
    renderTab();
    await screen.findByTestId("role-custom-card");
    expect(screen.getByTestId("role-edit-btn")).not.toBeNull();
    expect(screen.getByTestId("role-delete-btn")).not.toBeNull();
    cleanup();
    mockFetch(calls, CUSTOM);
    renderTab({ canUpdate: false, canDelete: false });
    await screen.findByTestId("role-custom-card");
    expect(screen.queryByTestId("role-edit-btn")).toBeNull();
    expect(screen.queryByTestId("role-delete-btn")).toBeNull();
  });
});

describe("树的数据源（防硬编码命门的前端半边）", () => {
  it("树上的叶子逐字来自后端 role-perm-tree 响应；内置位清单不出现在组件源码可枚举处", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls);
    renderTab();
    await screen.findAllByTestId("role-tpl-card");
    // 请求打的是后端端点（数据源 = 服务端投影，不是本地常量）
    expect(calls.some((c) => c.url.includes("/role-perm-tree?project_id=p1"))).toBe(true);
    // 树在编辑抽屉里——打开抽屉断言叶子逐字来自响应
    fireEvent.click(screen.getAllByTestId("role-clone-btn")[0]);
    await screen.findByTestId("role-perm-tree");
    for (const fam of NODES) {
      expect(screen.getAllByText(fam.key).length).toBeGreaterThan(0);
      for (const c of fam.children ?? []) {
        expect(screen.getAllByText(c.title).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("接线（③ 勾选保存 → PATCH body 就是这个位）", () => {
  it("编辑自定义角色 → 勾 env:config:read → PATCH body 含该位且不含未勾的位", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM);
    renderTab();
    await screen.findByTestId("role-custom-card");
    fireEvent.click(screen.getByTestId("role-edit-btn"));
    await screen.findByTestId("role-drawer");
    // 点树上的 env:config:read 勾选框（checkbox 是标题的兄弟节点，挂在 treenode 容器下）
    const title = [...screen.getAllByText("env:config:read")]
      .find((el) => el.closest(".ant-tree-treenode"));
    const treeNode = title!.closest(".ant-tree-treenode")!;
    fireEvent.click(treeNode.querySelector(".ant-tree-checkbox")!);
    fireEvent.click(screen.getByTestId("role-save-btn"));
    await waitFor(() => {
      const p = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/custom-roles/role_abc"));
      expect(p).toBeTruthy();
      expect(p!.body).toContain("env:config:read");
      expect(p!.body).toContain("api:case:read"); // 原本勾着的位保留
      expect(p!.body).not.toContain("api:case:create"); // 没勾的不进 body
    });
    const p = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/custom-roles/role_abc"))!;
    expect(JSON.parse(p!.body!).perms).toEqual(["api:case:read", "env:config:read"]);
  });

  it("删除 → POST /custom-roles/{code}/delete", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM);
    renderTab();
    await screen.findByTestId("role-custom-card");
    fireEvent.click(screen.getByTestId("role-delete-btn"));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST"
        && c.url.endsWith("/custom-roles/role_abc/delete"))).toBe(true);
    });
  });
});

describe("轴③ 把手（第十八轮补：tab-roles / roles-load-failed / role-create-btn / role-f-name）", () => {
  it("tab-roles：整页容器把模板卡、新建钮、自定义卡都包在里面；失败态的 Alert 也在里面", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM);
    renderTab();
    const root = await screen.findByTestId("tab-roles");
    // 容器 = 整页外壳：两个标题 + 模板卡 + 新建钮 + 自定义卡都在它内部
    expect(within(root).getByText("内置模板（只读）")).not.toBeNull();
    expect(within(root).getByText("自定义角色")).not.toBeNull();
    // tab-roles 是常驻壳（RolesTab.tsx:133 无条件渲染），模板卡与自定义卡分别
    // 来自 /role-perm-tree 与 /custom-roles 两条响应——壳先挂上，内容后到
    //（延迟探针下 getAllByTestId("role-custom-card") 真实翻红过）。各等内容。
    await within(root).findAllByTestId("role-tpl-card");
    expect(within(root).getAllByTestId("role-tpl-card").length).toBe(TEMPLATES.length);
    await within(root).findAllByTestId("role-custom-card");
    expect(within(root).getAllByTestId("role-custom-card").length).toBe(CUSTOM.length);
    expect(within(root).getByTestId("role-create-btn")).not.toBeNull();
    // 把手没被挪到某个内层 div（挪进模板行 → 自定义卡就落在容器外，这里红）
    expect(screen.getByTestId("role-custom-card")
      .closest('[data-testid="tab-roles"]')).toBe(root);
    cleanup();
    // 失败态：Alert 同样长在容器里（不是渲染到壳外）
    mockFetch(calls, CUSTOM, "tree");
    renderTab();
    const root2 = await screen.findByTestId("tab-roles");
    // 失败态 Alert 是请求 rejected 之后才挂的——等它，别等壳。
    await waitFor(() => expect(within(root2).getByTestId("roles-load-failed")).not.toBeNull());
  });

  it("空列表按权限分叉：能建说「复制模板开始裁剪」，只能看就说清没入口", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, []);
    renderTab({ canCreate: false });
    expect(await screen.findByText("还没有自定义角色。你只能看：新建要 iam:role:create，这页上没有可点的入口")).not.toBeNull();
    cleanup();
    mockFetch(calls, []);
    renderTab({ canCreate: true });
    expect(await screen.findByText("还没有自定义角色——从上方模板复制一个开始裁剪")).not.toBeNull();
  });

  it("roles-load-failed：树请求失败 → Alert 在场（原话逐字）且模板卡/空态都清零", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM, "tree");
    renderTab();
    const alert = await screen.findByTestId("roles-load-failed");
    expect(within(alert).getByText("角色数据没取到（权限树/自定义角色列表请求失败）")).not.toBeNull();
    expect(screen.queryByTestId("role-tpl-card")).toBeNull();
    expect(screen.queryByTestId("role-custom-card")).toBeNull();
    // failed 时不再挂 Empty（roles.length===0 && !failed）
    expect(screen.queryByText("还没有自定义角色——从上方模板复制一个开始裁剪")).toBeNull();
    expect(calls.some((c) => c.url.includes("/role-perm-tree?project_id=p1"))).toBe(true);
  });

  it("roles-load-failed：自定义角色列表失败（树成功）也翻同一分支；成功路径 Alert 不在场", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM, "roles");
    renderTab();
    await screen.findByTestId("roles-load-failed");
    // 树是好的 → 模板卡照旧在场：红的是「列表」这条腿，不是整页
    expect(screen.getAllByTestId("role-tpl-card").length).toBe(TEMPLATES.length);
    expect(screen.queryByTestId("role-custom-card")).toBeNull();
    cleanup();
    // 反极性：两个请求都成功 → Alert 与其文案都不许出现在 DOM 里
    mockFetch(calls, CUSTOM);
    renderTab();
    await screen.findByTestId("role-custom-card");
    expect(screen.queryByTestId("roles-load-failed")).toBeNull();
    expect(screen.queryByText("角色数据没取到（权限树/自定义角色列表请求失败）")).toBeNull();
    expect(screen.getByText("接口专员")).not.toBeNull();
  });

  it("role-create-btn：点击开「新建」抽屉（模板 READONLY、树初始不勾）→ POST body 就是那三样；canCreate=false 不给钮", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM);
    renderTab();
    await screen.findByTestId("role-custom-card");
    fireEvent.click(screen.getByTestId("role-create-btn"));
    await screen.findByText("新建自定义角色（从模板复制）");
    await screen.findByTestId("role-perm-tree");
    // onClick 传的是 initPerms: [] → 抽屉打开时一棵树都没勾（且是新建态，不是编辑态）
    expect(document.querySelectorAll(".ant-tree-checkbox-checked").length).toBe(0);
    expect(screen.getByText("模板 READONLY · 勾选即裁剪（任意裁剪 + 任意勾选，计划 D37 假设 4）")).not.toBeNull();
    // 杀 RT12：109 行 POST body 的 name: name.trim()——输入带前后空白，body 必须是 trim 过的。
    // 去掉 body 里的 .trim()：body 成 " 接口测试专员 "，与下面 toEqual 精确匹配失配即红
    //（104 行守卫的 trim 与此无关：它只管空不空，管不了进 body 的那份带不带空白）。
    fireEvent.change(screen.getByTestId("role-f-name"), { target: { value: "  接口测试专员  " } });
    const title = [...screen.getAllByText("api:case:create")]
      .find((el) => el.closest(".ant-tree-treenode"));
    fireEvent.click(title!.closest(".ant-tree-treenode")!.querySelector(".ant-tree-checkbox")!);
    fireEvent.click(screen.getByTestId("role-save-btn"));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/custom-roles"))).toBe(true);
    });
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/custom-roles"))!;
    expect(JSON.parse(post.body!)).toEqual({
      project_id: "p1", name: "接口测试专员", template_code: "READONLY", perms: ["api:case:create"],
    });
    cleanup();
    // 反极性：canCreate=false → 新建钮整个不给（门把手在前端就得没有）
    mockFetch(calls, CUSTOM);
    renderTab({ canCreate: false });
    await screen.findByTestId("role-custom-card");
    expect(screen.queryByTestId("role-create-btn")).toBeNull();
  });

  it("role-f-name：受控值 = 编辑时预载角色名；空/空白名只警告不发请求；改名逐字进 PATCH body", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    mockFetch(calls, CUSTOM);
    renderTab();
    await screen.findByTestId("role-custom-card");
    fireEvent.click(screen.getByTestId("role-edit-btn"));
    const input = await screen.findByTestId("role-f-name");
    // 把手落在真正的 <input> 上，且 value={name} 受控（initName 预载既有角色名）
    expect(input.tagName).toBe("INPUT");
    expect((input as HTMLInputElement).value).toBe("接口专员");
    // 空白名：save 里 !name.trim() 拦下 → 只弹警告，一个 PATCH 都不许发
    fireEvent.change(input, { target: { value: "   " } });
    expect((screen.getByTestId("role-f-name") as HTMLInputElement).value).toBe("   ");
    fireEvent.click(screen.getByTestId("role-save-btn"));
    expect(await screen.findByText("角色名不能为空")).not.toBeNull();
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(0);
    expect(screen.getByTestId("role-drawer")).not.toBeNull(); // 抽屉没关，用户还能改
    // 正常改名 → trim 后的名字进 PATCH 体（perms 未被这步动过）。
    // 杀 RT17：113 行 PATCH body 的 name: name.trim()——输入带前后空白，toEqual 精确
    // 匹配逼 body 必须等于 trim 值；摘掉 .trim() 后 body 带 "  " 前后缀即红。
    fireEvent.change(screen.getByTestId("role-f-name"), { target: { value: "  改名后的接口专员  " } });
    fireEvent.click(screen.getByTestId("role-save-btn"));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/custom-roles/role_abc"))).toBe(true);
    });
    const p = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/custom-roles/role_abc"))!;
    expect(JSON.parse(p.body!)).toEqual({
      project_id: "p1", name: "改名后的接口专员", perms: ["api:case:read"],
    });
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(1);
  });
});
