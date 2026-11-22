// ProjectGate（项目作用域页的统一外壳，§11.5.1）的组件侧单测。此前 vitest 侧零 import：
// 横幅只在 api.test.tsx 里被「经 ApiPage→ProjectGate」顺带摸过三次，本文件自己的默认导出
// 从没被接走（audit-test-debt.mjs 轴②命中）。钉的是外壳自己的三件事：
//   ① 未选项目 → 只画诚实引导（no-project / no-project-goto），点它去 "/"，
//      **children 一个都不渲染**（不拿假数据演页面）；
//   ② 选了项目 → children 原样渲染；
//   ③ 只读横幅的唯一信号是 isReadOnlyPatterns(patternsForProject(project, user?.is_system_admin))：
//      既不是单个权限位，也不是 my_role 字符串。这一组是重点，故把三个反例逐个钉齐：
//      · 生效模式里还有一条写得起（`*` / `x:*` / `:update` 词尾）→ 无横幅；
//      · 生效模式全只读 → 横幅出现，且文案把 project.my_role 插进去；
//      · my_role 是空串/null → 文案落「未分配」，不许画 "undefined"/空引号。
//      外加两条「gate 不看 role 字符串」的正证：my_role=READONLY 但服务端 my_perms=["*"]
//      → 无横幅；my_role=PROJECT_ADMIN 但 my_perms=["*:read"] → 有横幅（且横幅里写的是
//      PROJECT_ADMIN——文案只陈述 role 字面，判定却完全由 patterns 决定）。
//      以及一条系统管理员：is_system_admin=true 时 patternsForProject 直接返回 ["*"]
//      （perms.ts:44，在 my_perms 之前），所以挂在只读项目里的平台管理员不横幅。
// 【不证明什么】
//   · 各页面「只读时按钮隐藏」的把手归各页自己的测试（api/adbCases/reportDetail 等），
//     本外壳只管那一条横幅，不参与任何门禁（perms.ts:57 的注释写明了这一点）。
//   · patterns 怎么从后端角色模板算出来、my_perms 的下发形状，是后端与 store.bootstrap 的事；
//     这里直接 setState 灌项目快照，只验外壳的消费口径。
//   · 「未知角色且无 my_perms → patterns 为空 → 不横幅」这条空集语义在 perms.ts 已验，
//     本文件只在注释里记一句，不重测 perms 单元测试的地盘。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// useNavigate 换成可断言的 spy（adbDevices.test.tsx:9-15 同款）：要钉「点按钮真的 nav('/')」，
// MemoryRouter 不给调用记录。其余导出走真实现——本文件用了真的 MemoryRouter 兜底上下文。
const navSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navSpy,
}));

import ProjectGate, { PageHead } from "./ProjectGate";
import { useAuth } from "../auth/store";
import type { ProjectOut, UserOut } from "../auth/store";

const USER: UserOut = { id: "u1", account: "zhangsan", name: "张三", email: null,
  is_system_admin: false, status: "active" };

/** 项目快照：my_perms 缺省 undefined（= 旧快照没下发，走前端角色兜底表），显式传 null 也照传。 */
function project(over: Partial<ProjectOut> & { my_perms?: string[] | null } = {}): ProjectOut {
  return { id: "p1", name: "履约", description: null, status: "normal",
    my_role: "READONLY", ...over } as ProjectOut;
}

/** 认证态一律驱动真 store（shell.test.tsx:75 同款），不 mock ../auth/store。 */
function signIn(user: UserOut | null, proj: ProjectOut | null): void {
  useAuth.setState({ user, project: proj, ready: true });
}

function renderGate() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ProjectGate>
        <div data-testid="gate-child">页面本体</div>
      </ProjectGate>
    </ConfigProvider>,
  );
}

function banner(): HTMLElement | null {
  return screen.queryByTestId("readonly-banner");
}

beforeEach(() => {
  cleanup();
  navSpy.mockReset();
  localStorage.clear(); // store 的 setProject 会写 tp_project，别把上一例的快照带过来
});

afterEach(() => cleanup());

describe("① 未选项目：诚实引导，不演页面", () => {
  it("project=null → 只画引导，children 不渲染，且没有横幅", () => {
    signIn(USER, null);
    renderGate();
    expect(screen.getByTestId("no-project")).not.toBeNull();
    expect(screen.getByTestId("no-project").textContent).toContain("先在工作台选项目");
    // children 一个字节都不许出现：外壳不许「先渲染页面、后面再补一句没项目」
    expect(screen.queryByTestId("gate-child")).toBeNull();
    expect(banner()).toBeNull();
  });

  it("点[去工作台选项目] → nav('/')（导航由 useNavigate 做，不是 <a href>）", () => {
    signIn(USER, null);
    renderGate();
    screen.getByTestId("no-project-goto").click();
    expect(navSpy).toHaveBeenCalledTimes(1);
    expect(navSpy).toHaveBeenCalledWith("/");
  });
});

describe("② 选了项目 → children 原样渲染", () => {
  it("有项目就渲染子内容（引导整块消失）", () => {
    signIn(USER, project({ my_role: "PROJECT_ADMIN", my_perms: ["*"] }));
    renderGate();
    expect(screen.getByTestId("gate-child").textContent).toBe("页面本体");
    expect(screen.queryByTestId("no-project")).toBeNull();
    expect(navSpy).not.toHaveBeenCalled();
  });
});

describe("③ 只读横幅：信号是生效模式，不是单个权限位、也不是 role 字符串", () => {
  it("(a) 模式里有一条写得起（* / x:* / :update 词尾）→ 三种写法都无横幅", () => {
    // 前缀通配必含 create
    signIn(USER, project({ my_role: "READONLY", my_perms: ["*"] }));
    const { unmount } = renderGate();
    expect(screen.getByTestId("gate-child")).not.toBeNull();
    expect(banner()).toBeNull();
    unmount();

    // `x:*` 前缀通配同理
    signIn(USER, project({ my_role: "READONLY", my_perms: ["case:*"] }));
    renderGate();
    expect(banner()).toBeNull();
    unmount();

    // 精确写位（WRITE_TAIL 的 :update 词尾）+ 一堆读位，也判可写
    signIn(USER, project({ my_role: "READONLY", my_perms: ["case:read", "api:def:read", "case:update"] }));
    renderGate();
    expect(banner()).toBeNull();
  });

  it("(a-补) MEMBER 式「* 减掉 delete/manage」不是只读：单个权限位反推只读会误判的正例", () => {
    // my_perms 里带着一串显式拒绝，但 `*` 还在 → 写得起 → 不横幅（perms.ts:68 拒绝位不贡献写入能力）
    signIn(USER, project({ my_role: "MEMBER", my_perms: ["*", "-*:delete", "-*:manage", "-system:*"] }));
    renderGate();
    expect(banner()).toBeNull();
  });

  it("(b) 全只读模式 → 横幅出现，文案逐字插进 project.my_role", () => {
    signIn(USER, project({ my_role: "READONLY", my_perms: ["*:read", "-system:*"] }));
    renderGate();
    const b = banner();
    expect(b).not.toBeNull();
    expect(b!.textContent).toContain(
      "当前项目角色「READONLY」在本项目没有任何编辑权限，页面为只读。",
    );
    // 只陈述事实：不许出现「联系管理员」这类许诺（ProjectGate.tsx:36 的注释）
    expect(b!.textContent).not.toContain("联系管理员");
    // 横幅与 children 共存：只读是提示，不是把页面换成假门
    expect(screen.getByTestId("gate-child")).not.toBeNull();
    expect(screen.queryByTestId("no-project")).toBeNull();
  });

  it("(c) my_role 为空串/null → 落「未分配」，不许画 undefined 或空引号", () => {
    signIn(USER, project({ my_role: "", my_perms: ["*:read"] }));
    const { unmount } = renderGate();
    expect(banner()!.textContent).toContain("当前项目角色「未分配」在本项目没有任何编辑权限");
    expect(banner()!.textContent).not.toContain("undefined");
    unmount();

    // 服务端真给 null（角色被清掉）时同口径
    signIn(USER, project({ my_role: null as unknown as string, my_perms: ["*:read"] }));
    renderGate();
    expect(banner()!.textContent).toContain("「未分配」");
    expect(banner()!.textContent).not.toContain("undefined");
  });

  it("不看 role 字符串①：my_role=READONLY 但服务端 my_perms=[\"*\"] → 无横幅", () => {
    // 角色名是「只读」而生效模式是全通配（自定义角色/改过模板）——按字符串判就会撒谎
    signIn(USER, project({ my_role: "READONLY", my_perms: ["*"] }));
    renderGate();
    expect(banner()).toBeNull();
  });

  it("不看 role 字符串②：my_role=PROJECT_ADMIN 但 my_perms=[\"*:read\"] → 有横幅，文案仍写 PROJECT_ADMIN", () => {
    signIn(USER, project({ my_role: "PROJECT_ADMIN", my_perms: ["*:read"] }));
    renderGate();
    expect(banner()).not.toBeNull();
    // 判定走 patterns，文案照抄 my_role 字面：两句各管各的，都不许被对方带跑
    expect(banner()!.textContent).toContain("当前项目角色「PROJECT_ADMIN」在本项目没有任何编辑权限");
  });

  it("平台管理员挂在只读项目里 → 无横幅（patternsForProject 先认 is_system_admin）", () => {
    // perms.ts:44：is_system_admin 直接返回 ["*"]，在 my_perms 之前——所以平台管理员即使
    // 项目快照写着 READONLY + ["*:read"] 也判可写。这里钉的是外壳吃到的是这个口径。
    signIn({ ...USER, is_system_admin: true }, project({ my_role: "READONLY", my_perms: ["*:read"] }));
    renderGate();
    expect(screen.getByTestId("gate-child")).not.toBeNull();
    expect(banner()).toBeNull();
  });

  it("user=null（bootstrap 还没回来）时按非系统管理员判 → 只读快照照常横幅", () => {
    // user?.is_system_admin 的可选链不许把判定炸成不横幅
    signIn(null, project({ my_role: "READONLY", my_perms: ["*:read"] }));
    renderGate();
    expect(banner()).not.toBeNull();
  });
});

describe("PageHead（同文件的具名外壳件）", () => {
  it("标题落在 tp-page-title，extra 进右槽，中间是撑开的占位", () => {
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <PageHead title="接口管理" extra={<button data-testid="head-extra">新建</button>} />
      </ConfigProvider>,
    );
    const head = document.querySelector(".tp-page-head");
    expect(head).not.toBeNull();
    expect(head!.querySelector(".tp-page-title")!.textContent).toBe("接口管理");
    expect(screen.getByTestId("head-extra")).not.toBeNull();
  });
});
