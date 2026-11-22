// CaseList 回收 409「被场景引用」（D86）——用例侧。接口侧同形状的用例在
// pages/api.test.tsx（共用 ScenarioRefsBlockModal，两处都要各自钉住接线）。
// 手法照抄 uiElements/notifyChannels：global.fetch 全 mock。
// 三条最要紧的钉：
// ① 409 拦截弹窗点名引用场景与命中步骤（旧代码 `catch { /* toast */ }` 把 details 全丢了）；
// ② reason=missing_scenario_read → 说明需要 scenario:read 且 **不给 force**
//    （后端 case_services.py:269 对 hidden 连 force 一起拦，摆按钮 = 假门）；
// ③ 点 force → 第二个请求 body 里 force === true（fetch 调用序列断言，不只看 UI）。
// 正对照：200 正常删除仍删成功、success 照常、列表刷新。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider, message } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import CaseList from "./CaseList";
import type { ApiDef, CaseRow } from "./api";

const DEF: ApiDef = {
  id: "d1", project_id: "p1", module_id: null, name: "查询订单", method: "GET",
  path: "/order/{id}", request: null, status: "complete", version: 1,
  owner_id: null, project_public: true,
};
function caseRow(over: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "c1", project_id: "p1", definition_id: "d1", name: "已支付订单", priority: "P0",
    request: null, assertions: [], dataset_id: null, sort: 1, status: "normal",
    effective_request: { method: "GET", url: "https://x.test/order/1" } as never, ...over,
  };
}

const SCENARIOS = [
  { scenario_id: "s1", scenario_name: "下单主链路", step_keys: ["k1", "k2"] },
  { scenario_id: "s2", scenario_name: "回归集", step_keys: ["k9"] },
];

type DelBehavior = "blocked" | "hidden" | "ok" | "blocked_then_ok";

function mockBackend(rows: CaseRow[], deleteBehavior: DelBehavior, fullCount = 2) {
  let deleteTried = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.includes("/api-cases/c1/delete")) {
      deleteTried += 1;
      if (deleteBehavior === "ok" || (deleteBehavior === "blocked_then_ok" && deleteTried > 1)) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }
      // 用例侧 details 顶层键是 case_id（case_services._blocked:114），接口侧才是 definition_id
      const details = deleteBehavior === "hidden"
        ? { case_id: "c1", count: 3, scenarios: [], reason: "missing_scenario_read" }
        : { case_id: "c1", count: fullCount, scenarios: SCENARIOS };
      return { ok: false, status: 409, json: async () => ({
        code: "referenced_by_scenario", message: "该用例被引用，不能回收", details,
      }) } as unknown as Response;
    }
    // 这行被「按标记删 W4 探针」连带删过一次，留下 :64/:65 的孤儿三元分支 → esbuild 在 :64
    // 报 Unexpected "?"、整个文件不收集（门禁⑥ 的 numFailedTests=0 因此是假绿）。按 HEAD 原形恢复。
    return { ok: true, status: 200, json: async () => (url.includes("/api-cases?")
      ? { items: rows, next_cursor: null }
      : { items: [], next_cursor: null }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});
// 本仓 vitest 未开 globals → RTL 自动 cleanup 没挂上（PlanListCard.test.tsx:10 同款注释）
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderList(rows: CaseRow[], deleteBehavior: DelBehavior, fullCount = 2) {
  mockBackend(rows, deleteBehavior, fullCount);
  // motion:false —— rc-motion 的 leave 动画在 jsdom 里不完成，destroyOnHidden 的弹窗
  // 关掉后节点会永远留在 DOM，「关掉弹窗」这条断言就测不了（与 motion 开关无关的
  // 生产行为，这里只是让卸载在测试里落得到）。
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <CaseList def={DEF} envId={null} perms={["*"]} />
    </ConfigProvider>,
  );
}

/** 走行内 Popconfirm：图标钮（aria-label 回收<名>）→ 气泡里的 [回收]
 * （antd 两字按钮自动空格成「回 收」，正则容忍）。 */
async function confirmRecycle() {
  fireEvent.click(await screen.findByLabelText("回收已支付订单"));
  fireEvent.click(await screen.findByRole("button", { name: /^回\s*收$/ }));
}
function deleteBodies(): Record<string, unknown>[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes("/api-cases/c1/delete"))
    .map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
}
function listGets(): number {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).includes("/api-cases?")).length;
}

describe("CaseList 回收 409「被场景引用」（D86）", () => {
  it("409 明细可见：弹窗点名每个引用场景与命中步骤", async () => {
    renderList([caseRow()], "blocked");
    await screen.findByTestId("case-row");
    await confirmRecycle();
    const box = await screen.findByTestId("case-scenario-block");
    expect(box.textContent).toContain("下单主链路");
    expect(box.textContent).toContain("k1、k2");
    expect(box.textContent).toContain("回归集");
    expect(box.textContent).toContain("k9");
    expect(box.textContent).toContain("回收不会删除用例");
    expect(box.textContent).toContain("restore 后原样回来");
    expect(box.querySelector("a")?.getAttribute("href")).toBe("#/scene/s1");
  });

  it("count 大于列出条数 → 说明「等 N 个场景」", async () => {
    renderList([caseRow()], "blocked", 7);
    await screen.findByTestId("case-row");
    await confirmRecycle();
    expect((await screen.findByTestId("case-scenario-block")).textContent).toContain("等 7 个场景");
  });

  it("明细被隐瞒（reason=missing_scenario_read）→ 说明需要 scenario:read，且不给 force 按钮", async () => {
    renderList([caseRow()], "hidden");
    await screen.findByTestId("case-row");
    await confirmRecycle();
    const box = await screen.findByTestId("case-scenario-block");
    expect(screen.getByTestId("case-scenario-block-hidden").textContent).toContain("scenario:read");
    expect(box.textContent).toContain("3");
    expect(box.textContent).toContain("未回收场景引用");
    // 旧缺陷回归钉：details 不许再化成一句 toast，也不许退化成「没人引用」
    expect(screen.queryByText(/还没有|无引用/)).toBeNull();
    // 后端对 hidden 连 force 一起拦 → UI 压根不摆这扇假门
    expect(screen.queryByTestId("case-scenario-block-force")).toBeNull();
  });

  it("点 [仍要回收] → 第二个请求 body force === true（fetch 调用序列断言）", async () => {
    renderList([caseRow()], "blocked_then_ok");
    await screen.findByTestId("case-row");
    await confirmRecycle();
    await screen.findByTestId("case-scenario-block");
    fireEvent.click(await screen.findByTestId("case-scenario-block-force"));
    await waitFor(() => expect(deleteBodies().length).toBe(2));
    expect("force" in deleteBodies()[0]).toBe(false);
    expect(deleteBodies()[1].force).toBe(true);
    expect(deleteBodies()[1].project_id).toBe("p1");
    await waitFor(() => expect(screen.queryByTestId("case-scenario-block")).toBeNull());
  });

  it("正对照：200 正常删除仍然删成功——body 不带 force、success 照常、列表刷新", async () => {
    const spy = vi.spyOn(message, "success").mockImplementation(() => ({}) as never);
    renderList([caseRow()], "ok");
    await screen.findByTestId("case-row");
    const before = listGets();
    await confirmRecycle();
    await waitFor(() => expect(deleteBodies().length).toBe(1));
    expect(deleteBodies()[0]).toEqual({ project_id: "p1" });
    await waitFor(() => expect(spy.mock.calls.some((c) => String(c[0]).includes("用例已放入回收站"))).toBe(true));
    expect(screen.queryByTestId("case-scenario-block")).toBeNull();
    await waitFor(() => expect(listGets()).toBeGreaterThan(before));
    spy.mockRestore();
  });
});

// ── 覆盖列（CaseList.tsx:336-341）两条腿逐字钉 ────────────────────────────────
// 实现口径（真实字面量抄自 CaseList.tsx:21-26，改动生产常量这里必红）：
//   OVERLAY_KEYS = [method, url, params, headers, auth, body, timeout_ms]
//   KEY_LABEL = { method:"方法", url:"URL", params:"参数", headers:"请求头",
//                 auth:"认证", body:"Body", timeout_ms:"超时" }
//   keys = OVERLAY_KEYS.filter(k => k in (r.request ?? {}))
//   有键 → Tag case-overlay：keys.map(k => KEY_LABEL[k]).join("/")
//   无键 → 蓝色 Tag case-inherit「全继承」；request 为 null/undefined 时
//   由 `?? {}` 守卫兜成空对象，同样走全继承腿。
describe("CaseList 覆盖列：case-overlay 键序/标签/分隔符 与 case-inherit 全继承", () => {
  function rowWithRequest(req: Record<string, unknown> | null | undefined): CaseRow {
    return caseRow({ id: "cx", name: "覆盖行", request: req as Record<string, unknown> | null });
  }

  it("命中键按 OVERLAY_KEYS 定序、KEY_LABEL 定名、\"/\" 拼接：request 键乱序塞入也只出 OVERLAY_KEYS 顺序", async () => {
    // 插入序刻意倒着写：若实现退化成 Object.keys(request) 顺序，第一条必红
    renderList([rowWithRequest({ timeout_ms: 10, body: {}, url: "/x", method: "POST" })], "ok");
    expect((await screen.findByTestId("case-overlay")).textContent).toBe("方法/URL/Body/超时");
    expect(screen.queryByTestId("case-inherit")).toBeNull();

    cleanup();
    renderList([rowWithRequest({ headers: {}, params: {} })], "ok");
    expect((await screen.findByTestId("case-overlay")).textContent).toBe("参数/请求头");

    cleanup();
    renderList([rowWithRequest({ auth: {} })], "ok");
    expect((await screen.findByTestId("case-overlay")).textContent).toBe("认证"); // 单键无分隔符
  });

  it("request 为空对象/null/undefined 都走「全继承」腿：?? {} 守卫兜住 null 与缺键", async () => {
    for (const req of [{}, null, undefined] as const) {
      cleanup();
      renderList([rowWithRequest(req)], "ok");
      const tag = await screen.findByTestId("case-inherit");
      expect(tag.textContent).toBe("全继承");
      expect(tag.className).toContain("ant-tag-blue"); // 蓝标是 inherit 腿的样式钉
      expect(screen.queryByTestId("case-overlay")).toBeNull();
    }
  });
});

// ── 调试 422 前置失败进结果面板（第二十二轮修复 3）─────────────────────────────
// 注释承诺的「缺变量/不可执行这类前置失败」在后端是两条码：validation_error
// （services.py:432，details.var）与 validation_failed（services.py:397，不可执行）。
// 旧守卫只认前者，「不可执行」落回裸 toast，面板与下一步话术永远出不来。
// 纯 UI 造不出「无有效请求」的用例（保存拒空 URL、api.tsx 必带请求对象），
// 所以按 legacy/agent 建的草稿定义的真实应答直接 stub /api-debug。
function mockDebugFail(code: string, msg: string, details: unknown) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api-debug")) {
      return { ok: false, status: 422, json: async () => ({ code, message: msg, details }) } as unknown as Response;
    }
    if (url.includes("/api-cases?")) {
      return { ok: true, status: 200, json: async () => ({ items: [caseRow()], next_cursor: null }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function debugOnceStubbed(code: string, msg: string, details: unknown) {
  mockDebugFail(code, msg, details);
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <CaseList def={DEF} envId={null} perms={["*"]} />
    </ConfigProvider>,
  );
  fireEvent.click(await screen.findByTestId("case-debug"));
}

describe("调试 422 前置失败：面板 + 下一步，且不挂「让 Pilot 分析」", () => {
  it("validation_failed（不可执行）→ 面板出现且带后端原话", async () => {
    await debugOnceStubbed("validation_failed", "用例不可执行：定义无请求对象且用例未覆盖 url", null);
    const panel = await screen.findByTestId("case-debug-panel");
    expect(panel.textContent).toContain("用例不可执行：定义无请求对象且用例未覆盖 url");
  });

  it("validation_failed 无 var → 下一步给「编辑用例补上 URL」（旧守卫下整句都不存在）", async () => {
    await debugOnceStubbed("validation_failed", "用例不可执行：定义无请求对象且用例未覆盖 url", null);
    const panel = await screen.findByTestId("case-debug-panel");
    expect(panel.textContent).toContain("编辑用例补上 URL（或给接口定义补上请求对象）");
  });

  it("validation_error + details.var → 原有「绑数据集/定义变量」话术保持", async () => {
    await debugOnceStubbed("validation_error", "缺少变量：token", { var: "token" });
    const panel = await screen.findByTestId("case-debug-panel");
    expect(panel.textContent).toContain("缺少变量：token");
    expect(panel.textContent).toContain("绑一个数据集（执行时取首行供给变量）或在环境/全局配置里定义 token");
    // var 腿不许顺带带上不可执行的下一步
    expect(panel.textContent).not.toContain("编辑用例补上 URL");
  });

  it("前置失败不挂「让 Pilot 分析」：请求根本没发出去，草稿会写成「发了没回」的假话", async () => {
    await debugOnceStubbed("validation_failed", "用例不可执行：定义无请求对象且用例未覆盖 url", null);
    await screen.findByTestId("case-debug-panel");
    expect(screen.queryByTestId("debug-ask-pilot")).toBeNull();
  });

  it("非前置族的错误码（server_error）→ 面板不出现，仍归 toast 管", async () => {
    await debugOnceStubbed("server_error", "后端炸了", null);
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .some((c) => String(c[0]).includes("/api-debug"))).toBe(true));
    // 给 catch 一个落定窗口后仍然没有面板（不是时序慢）
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("case-debug-panel")).toBeNull();
  });
});

// ── 第二十三轮：列表取失败不许摊成「还没有用例」 ──
// 旧实现 `catch { setRows([]); }` + silent:true：GET 500/403 与「查到了 0 条」画同一张空态，
// 后端炸了会被读成「这个接口的用例被删空了」。第 7 处同款（datasets/reports/runs/scenes/
// api/adbCases 前六处已改）。Tab 计数同源：api.tsx:706 的「用例(N)」直接吃 onCount 的数。
function mockList(status: number | "fail_then_ok", code = "server_error") {
  let tries = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api-cases?")) {
      tries += 1;
      const fail = typeof status === "number" ? true : tries === 1;
      if (fail) {
        return { ok: false, status: typeof status === "number" ? status : 500,
          json: async () => ({ code, message: "列表取不到", details: {} }) } as unknown as Response;
      }
      // 成功分支的 json 行也被「按标记删探针」吃掉过（同上注）。取法由用例钉死：
      // 「回收站视图失败 → 下一次加载成功」在切回收站后 await case-row，故成功必须回一条。
      return { ok: true, status: 200,
        json: async () => ({ items: [caseRow()], next_cursor: null }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
  }) as unknown as typeof fetch;
}
function renderFailing(status: number | "fail_then_ok", code?: string,
  onCount?: (n: number | null) => void) {
  mockList(status, code);
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <CaseList def={DEF} envId={null} perms={["*"]} onCount={onCount} />
    </ConfigProvider>,
  );
}

describe("第二十三轮：用例列表取失败要说「没取到」", () => {
  it("500：亮横幅 + 空态改口，不许出现「还没有用例」；横幅没有 ×（× = 把失败抹成空列表）", async () => {
    renderFailing(500);
    const bar = await screen.findByTestId("case-load-error");
    expect(bar.textContent).toContain("用例列表没取到");
    expect(bar.textContent).toContain("可能是网络不通或后端没起");
    expect(screen.queryByText("还没有用例")).toBeNull();
    expect(document.querySelector(".ant-alert-close-icon")).toBeNull();
  });

  it("403：说「刷新不会改变结论」，不许翻译成「网络不通」", async () => {
    renderFailing(403, "forbidden");
    const bar = await screen.findByTestId("case-load-error");
    expect(bar.textContent).toContain("没有读取这个接口用例的权限");
    expect(bar.textContent).toContain("刷新不会改变结论");
    expect(bar.textContent).not.toContain("网络不通");
  });

  it("Tab 计数：失败后最后一次报的是 null，不是 0（api.tsx 收到 null 就只写「用例」）", async () => {
    const counts: (number | null)[] = [];
    renderFailing(500, "server_error", (n) => counts.push(n));
    await screen.findByTestId("case-load-error");
    expect(counts[counts.length - 1]).toBeNull();
  });

  it("回收站视图失败：说「回收站没取到」，不许说「回收站是空的」", async () => {
    renderFailing(500);
    await screen.findByTestId("case-load-error");
    fireEvent.click(screen.getByTestId("case-recycled-toggle"));
    expect(await screen.findByText("回收站列表没取到")).not.toBeNull();
    expect(screen.queryByText("回收站是空的")).toBeNull();
    expect(screen.getByText("回收站没取到，以上方的加载失败提示为准")).not.toBeNull();
  });

  it("下一次加载成功 → 横幅归零（failed 每次 load 先清，否则一次失败永远挂着）", async () => {
    renderFailing("fail_then_ok");
    await screen.findByTestId("case-load-error");
    fireEvent.click(screen.getByTestId("case-recycled-toggle"));
    await screen.findByTestId("case-row");
    expect(screen.queryByTestId("case-load-error")).toBeNull();
    expect(screen.queryByText("回收站没取到，以上方的加载失败提示为准")).toBeNull();
  });

  it("正对照：取成功不亮横幅，计数报真实条数", async () => {
    const counts: (number | null)[] = [];
    mockList("fail_then_ok");
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return { ok: true, status: 200, json: async () => ({ items: [caseRow()], next_cursor: null }) } as unknown as Response;
    });
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <CaseList def={DEF} envId={null} perms={["*"]} onCount={(n) => counts.push(n)} />
      </ConfigProvider>,
    );
    await screen.findByTestId("case-row");
    expect(screen.queryByTestId("case-load-error")).toBeNull();
    expect(counts[counts.length - 1]).toBe(1);
  });
});

// ── 第三十三轮：数据集那腿取失败，不许把每行都标成「已删除」 ──
// 旧实现 `catch { setDatasets([]); }` + silent:true：/datasets 炸了 dsName 就是空表，
// 而列渲染写的是 dsName[id] ?? "已删除" —— 一次网络故障当场宣布「N 条用例的数据集都被删了」，
// 这是对数据的假陈述（不是降级）。dsDenied 单列：缺 api:dataset:read 重拉也不会有，
// 说「网络不通」会把权限问题误导成等一会儿就好。
function mockDs(dsStatus: number | "fail_then_ok") {
  let dsTries = 0;
  const DS_OK = { items: [
    { id: "ds1", project_id: "p1", name: "订单参数", columns: ["id"], rows: [["1"]], row_count: 1 },
  ], next_cursor: null };
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/datasets?")) {
      dsTries += 1;
      const fail = typeof dsStatus === "number" ? true : dsTries === 1;
      if (fail) {
        return { ok: false, status: typeof dsStatus === "number" ? dsStatus : 500,
          json: async () => ({ code: "server_error", message: "数据集取不到", details: {} }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => DS_OK } as unknown as Response;
    }
    // 用例列表照常成功：本轴只动数据集这条腿
    return { ok: true, status: 200,
      json: async () => ({ items: [caseRow({ dataset_id: "ds1" })], next_cursor: null }) } as unknown as Response;
  }) as unknown as typeof fetch;
}
function renderWithDs(dsStatus: number | "fail_then_ok") {
  mockDs(dsStatus);
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <CaseList def={DEF} envId={null} perms={["*"]} />
    </ConfigProvider>,
  );
}

describe("第三十三轮：数据集取失败不许说成「已删除」", () => {
  it("500：数据集标签说「没取到」，不许宣布「已删除」", async () => {
    renderWithDs(500);
    const tag = await screen.findByTestId("case-dataset-tag");
    expect(tag.textContent).toBe("数据集没取到");
    expect(tag.textContent).not.toContain("已删除");
  });

  it("403：说缺 api:dataset:read，不许翻译成「网络不通」式的「没取到」", async () => {
    renderWithDs(403);
    const tag = await screen.findByTestId("case-dataset-tag");
    expect(tag.textContent).toBe("无数据集读取权限");
  });

  it("正对照：数据集取成功且 id 在里面 → 画真实名字", async () => {
    mockDs("fail_then_ok");
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/datasets?")) {
        return { ok: true, status: 200, json: async () => ({ items: [
          { id: "ds1", project_id: "p1", name: "订单参数", columns: ["id"], rows: [["1"]], row_count: 1 },
        ], next_cursor: null }) } as unknown as Response;
      }
      return { ok: true, status: 200,
        json: async () => ({ items: [caseRow({ dataset_id: "ds1" })], next_cursor: null }) } as unknown as Response;
    });
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <CaseList def={DEF} envId={null} perms={["*"]} />
      </ConfigProvider>,
    );
    const tag = await screen.findByTestId("case-dataset-tag");
    expect(tag.textContent).toBe("订单参数");
  });

  it("正对照：数据集取成功但 id 不在回包 → 仍说「已删除」（这才是真信号）", async () => {
    mockDs("fail_then_ok");
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/datasets?")) {
        return { ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) } as unknown as Response;
      }
      return { ok: true, status: 200,
        json: async () => ({ items: [caseRow({ dataset_id: "ds-missing" })], next_cursor: null }) } as unknown as Response;
    });
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <CaseList def={DEF} envId={null} perms={["*"]} />
      </ConfigProvider>,
    );
    const tag = await screen.findByTestId("case-dataset-tag");
    expect(tag.textContent).toBe("已删除");
  });
});
