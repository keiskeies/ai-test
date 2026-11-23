// 模型卡片墙（§11.4.23，1E T8）vitest：能力 ✓/✗/? 徽标、默认★、向量隐藏位 + [维度探测]、
// 以及最重的一条——unknown ≠ ✗ 的渲染区分（后端把「没测出来」存成 null，前端若渲染成
// ✗ 就是第二道假门）。探测按钮打真请求路径 + 落库后重拉，[设为默认] 走 PATCH。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ModelTab, { capTri, type ModelCfg } from "./ModelTab";
import { tpv } from "../theme";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

function cfg(over: Partial<ModelCfg> = {}): ModelCfg {
  return {
    id: "m1", name: "fundgpt-coder-next", model_type: "CHAT", protocol: "OPENAI_COMPAT",
    base_url: "http://127.0.0.1:9000/v1", model_name: "fundgpt-coder-next",
    api_key_masked: "****7890", context_window: 32768, max_output: 4096,
    supports_thinking: false, thinking_levels: null, supports_vision: false,
    supports_tools: true, temperature_default: null, enabled: true, is_default: false,
    embed_dimensions: null, thinking_default: null, probe_result: null, ...over,
  };
}

const PROBED = cfg({
  is_default: true, probe_result: {
    ok: true, latency_ms: 412, capabilities: { tools: true, thinking: false, vision: null },
  },
});
const EMBED = cfg({
  id: "m2", name: "bge-向量", model_type: "EMBEDDING", model_name: "bge-m3",
  embed_dimensions: 1024, probe_result: { ok: true, latency_ms: 90, capabilities: {}, dimensions: 1024 },
});

function mockFetch(items: ModelCfg[], usage: unknown = null, listFail: boolean | number = false) {
  const calls: { url: string; method: string; body?: string }[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
    if (url.includes("/model-usage")) {
      // 用量旁路：null = 请求失败（403/网络都算）——卡片必须退化成「—」而不是 0
      if (usage === null) {
        return { ok: false, status: 403, json: async () => ({ code: "forbidden", message: "拒绝" }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => usage } as unknown as Response;
    }
    // listFail：true=403，数字=该状态码（卡片墙本体必须出「没取到」专属告警，不装空态）
    if (listFail && url.includes("/model-cfgs?")) {
      const status = typeof listFail === "number" ? listFail : 403;
      return { ok: false, status, json: async () => ({ code: "boom", message: "拒绝" }) } as unknown as Response;
    }
    // D248：登记与删除的写口各自记账，回包只要求形状能过 client 的 json 解析
    if (url.endsWith("/model-cfgs") && (init?.method ?? "GET").toUpperCase() === "POST") {
      return { ok: true, status: 201, json: async () => ({ ...items[0], id: "m9" }) } as unknown as Response;
    }
    if ((init?.method ?? "").toUpperCase() === "DELETE") {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }
    // D260：关键字搜索按后端口径（name / model_name / base_url 三列、大小写不敏感）
    // 现筛——否则「前端把 keyword 送出去了」和「回包收窄后只剩命中卡片」测不开。
    if (url.includes("/model-cfgs?")) {
      const q = new URLSearchParams(url.split("?")[1]);
      const kw = (q.get("keyword") ?? "").toLowerCase();
      const hit = kw
        ? items.filter((m) => [m.name, m.model_name, m.base_url]
          .some((s) => s.toLowerCase().includes(kw)))
        : items;
      return { ok: true, status: 200, json: async () => ({ items: hit, next_cursor: null }) };
    }
    return { ok: true, status: 200, json: async () => ({ items, next_cursor: null }) };
  }) as unknown as typeof fetch;
  return calls;
}

function usageOut(
  models: Array<{ model_id: string; usage_sessions: number }>,
  users: unknown[] = [], sessions: unknown[] = [],
) {
  return {
    scope: { project_id: null }, filters: { project_id: null, model_id: null, days: null },
    totals: { sessions: 0, usage_sessions: 0, turns: 0,
      input_tokens: null, output_tokens: null, total_tokens: null },
    users, sessions,
    models: models.map((m) => ({ model_id: m.model_id, model_name: "x", sessions: m.usage_sessions,
      usage_sessions: m.usage_sessions, turns: 0,
      input_tokens: null, output_tokens: null, total_tokens: null })),
  };
}

beforeEach(() => cleanup());

describe("capTri（三态判定纯函数）", () => {
  it("探测记了账：true/false 照收，null = unknown（不是回落列值）", () => {
    expect(capTri(PROBED, "tools")).toBe(true);
    expect(capTri(PROBED, "thinking")).toBe(false);
    expect(capTri(PROBED, "vision")).toBeNull(); // 列值 supports_vision=false，但探测说「没测出来」
  });
  it("没探测：回落列值（人工勾选也是信息，不装 unknown）", () => {
    expect(capTri(cfg({ supports_tools: true }), "tools")).toBe(true);
    expect(capTri(cfg({ supports_vision: false }), "vision")).toBe(false);
  });
  it("向量模型思考/视觉位不出三态（渲染层同样隐藏它们）", () => {
    expect(capTri(EMBED, "thinking")).toBeNull();
    expect(capTri(EMBED, "vision")).toBeNull();
  });
});

describe("卡片墙渲染（徽标 / 默认★ / unknown≠✗）", () => {
  it("✓ 绿勾、✗ 红叉、? 灰问号三者 data-state 互不相同——unknown 渲染成 ✗ 就是假门", async () => {
    mockFetch([PROBED]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    const tools = screen.getByTestId("model-cap-tools");
    const thinking = screen.getByTestId("model-cap-thinking");
    const vision = screen.getByTestId("model-cap-vision");
    expect(tools.getAttribute("data-state")).toBe("yes");
    expect(tools.textContent).toContain("✓");
    expect(thinking.getAttribute("data-state")).toBe("no");
    expect(thinking.textContent).toContain("✗");
    // unknown：状态不同 + 字形不同（? 而非 ✗）+ 不共用 ✗ 的红色语义
    expect(vision.getAttribute("data-state")).toBe("unknown");
    expect(vision.textContent).toContain("?");
    expect(vision.textContent).not.toContain("✗");
    expect(screen.getByText("默认★")).not.toBeNull();
    expect(screen.getByTestId("model-probe-line").textContent).toContain("412ms");
  });
});

describe("向量卡片（隐藏思考/视觉 + 维度位 + 维度探测钮）", () => {
  it("思考/视觉徽标整卡缺席，显示维度与 [维度探测] 文案", async () => {
    mockFetch([EMBED]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-cap-thinking")).toBeNull();
    expect(screen.queryByTestId("model-cap-vision")).toBeNull();
    expect(screen.getByTestId("model-cap-tools")).not.toBeNull();
    expect(screen.getByTestId("model-embed-dims").textContent).toContain("1024");
    expect(screen.getByTestId("model-probe-btn").textContent).toContain("维度探测");
  });
});

describe("用量行（D39 §6.8「用量 N 会话」——只认真实回执计数）", () => {
  it("有 usage 回执：卡片显示真实会话数", async () => {
    mockFetch([cfg({ id: "m1" })], usageOut([{ model_id: "m1", usage_sessions: 34 }]));
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    // load()（ModelTab.tsx:106-120）分两次提交：:108 列表先到卡片就无条件画出来了，
    // :118 的 /model-usage 是后到的旁路——读「34 会话」必须等内容到货，不能等壳。
    await waitFor(() => expect(screen.getByTestId("model-usage-line").textContent).toContain("34 会话"));
  });

  it("0 条回执 / 用量请求失败：都画「—」——0 冒充「已统计」就是假读数", async () => {
    mockFetch([cfg({ id: "m1" })], usageOut([{ model_id: "m1", usage_sessions: 0 }]));
    const { unmount } = render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.getByTestId("model-usage-line").textContent).toContain("—");
    unmount();

    mockFetch([cfg({ id: "m1" })]); // usage=null → /model-usage 回 403
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.getByTestId("model-usage-line").textContent).toContain("—");
    // 用量旁路失败不许拖垮卡片墙本体
    expect(screen.getByTestId("model-probe-line")).not.toBeNull();
  });
});

describe("接线（[连通性测试] 真调用 + 逐能力展开 + [设为默认]）", () => {
  it("点 [连通性测试] → POST /probe → 重拉列表并展开逐能力徽标", async () => {
    const calls = mockFetch([PROBED]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    const before = calls.length;
    fireEvent.click(screen.getByTestId("model-probe-btn"));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/model-cfgs/m1/probe") && c.method === "POST")).toBe(true);
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(before + 1)); // 探完必重拉（徽标跟落库走）
    expect(await screen.findByTestId("model-probe-expanded")).not.toBeNull();
  });

  it("[设为默认] → PATCH is_default；默认★卡上该钮缺席", async () => {
    const calls = mockFetch([PROBED, cfg({ id: "m3", name: "gpt-x" })]);
    render(<ModelTab canManage />);
    await screen.findAllByTestId("model-card");
    const btns = screen.getAllByTestId("model-set-default");
    expect(btns).toHaveLength(1); // 默认★的 PROBED 不给出钮
    fireEvent.click(btns[0]);
    await waitFor(() => {
      const p = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/model-cfgs/m3"));
      expect(p?.body).toContain('"is_default":true');
    });
  });

  it("canManage=false：编辑/设为默认不渲染（门禁永远在后端，前端只是不给门把手）", async () => {
    mockFetch([cfg({ id: "m4", name: "只读可见" })]);
    render(<ModelTab canManage={false} />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-set-default")).toBeNull();
    expect(screen.queryByTestId("model-edit-btn")).toBeNull();
    expect(screen.getByTestId("model-probe-btn")).not.toBeNull(); // :read 权限就能探测
  });
});

// ── 第十八轮 A：卡片补位 + 编辑弹窗 18 个零引用把手 ─────────────────────────
// 口径：只看「把手按下去之后 PATCH body 变没变」——存在性断言一律不算数。

/** testid 可能落 <input> 也可能落 wrapper（antd 版本细节，PropsPanel.test 同款口径）。 */
function inputOf(testid: string): HTMLInputElement {
  const n = screen.getByTestId(testid);
  return (n.tagName === "INPUT" ? n : n.querySelector("input")) as HTMLInputElement;
}
const okBtn = () => document.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLElement;
type Call = { url: string; method: string; body?: string };
function patchBodyOf(calls: Call[], id: string): Record<string, unknown> {
  const c = calls.find((x) => x.method === "PATCH" && x.url.endsWith("/model-cfgs/" + id));
  expect(c?.body, "没发出 PATCH /model-cfgs/" + id).toBeTruthy();
  return JSON.parse(c!.body!) as Record<string, unknown>;
}
const patchCalls = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");
const listGets = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.url.includes("/model-cfgs?"));
/**
 * 上一次 PATCH 的收尾真的跑完了吗？save() 的收尾是 setEditing(null) → await load()
 * （ModelTab.tsx:156-157），而弹窗是 {editing && form && <Modal/>} 画的（:283）——
 * 那句迟到的 setEditing(null) 会把刚重开的弹窗整个卸掉。calls 是在**派发**时记账的，
 * 所以「baseline 之后又多出一次列表 GET」= load() 已经起跑 = :156 必然已应用。
 * 不用 OK 按钮的 ant-btn-loading 当门：弹窗关着时那棵子树不重渲染，类名冻在 LOADING。
 */
async function settledAfterPatch(calls: Call[], baseline: number): Promise<void> {
  await waitFor(() => expect(listGets(calls).length).toBeGreaterThan(baseline));
}
async function openEdit(): Promise<void> {
  fireEvent.click(await screen.findByTestId("model-edit-btn"));
  await screen.findByTestId("model-edit-modal");
}

describe("卡片补位（停用签 / 默认思考档 / 列表失败 / 用量双表）", () => {
  it("「停用」签只在 enabled=false 的卡上出现——enabled 写反两头红", async () => {
    mockFetch([cfg({ enabled: true })]);
    const { unmount } = render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-disabled-tag")).toBeNull();
    unmount();
    mockFetch([cfg({ enabled: false })]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.getByTestId("model-disabled-tag").textContent).toContain("停用");
  });

  it("默认思考档签：思考开+有默认档才出；无默认档 / 向量卡一律缺席", async () => {
    mockFetch([cfg({ supports_thinking: true, thinking_default: "medium" })]);
    const { unmount } = render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.getByTestId("model-thinking-default").textContent).toContain("默认思考档 medium");
    unmount();
    mockFetch([cfg({ supports_thinking: true, thinking_default: null })]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-thinking-default")).toBeNull();
    unmount();
    // 思考**关**着但历史里留着默认档：也不画。这条不是凑数——生产码是
    // `c.supports_thinking && c.thinking_default` 两个条件，删掉前半个（只留 default）
    // 只有这一种数据能抓出来，上面两态（都真 / default 为空）都判不出。
    mockFetch([cfg({ supports_thinking: false, thinking_default: "medium" })]);
    const { unmount: unmountOff } = render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-thinking-default")).toBeNull();
    unmountOff();
    // 向量卡：列值带着思考默认也不画（思考位整列隐藏，§11.4.23）
    mockFetch([cfg({ id: "m2", model_type: "EMBEDDING", supports_thinking: true, thinking_default: "medium" })]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-thinking-default")).toBeNull();
  });

  it("列表 403：出「模型列表没取到」专属告警，绝不降级成「还没有登记模型」空态", async () => {
    mockFetch([cfg()], null, true);
    render(<ModelTab canManage />);
    expect((await screen.findByTestId("model-load-failed")).textContent).toContain("模型列表没取到");
    // 失败态≠空态：没有 !failed 守卫（:239）就会画出「还没有登记模型」骗人
    expect(screen.queryByText(/还没有登记模型/)).toBeNull();
    // 403 那一支必须点名权限位：这条页只对 model:cfg:read 的人挂载，取不到就是权限被收走
    expect(screen.getByTestId("model-load-failed").textContent).toContain("model:cfg:read");
  });

  it("列表 500：同一张告警改口说「与权限无关」，不许蹭权限", async () => {
    mockFetch([cfg()], null, 500);
    render(<ModelTab canManage />);
    const el = await screen.findByTestId("model-load-failed");
    expect(el.textContent).toContain("请求没成功或后端没应答");
    expect(el.textContent).not.toContain("model:cfg:read");
    expect(screen.queryByText(/还没有登记模型/)).toBeNull();
  });

  it("用量双表：行文案带真实计数、tokens null 画「—」；users/sessions 全空整块缺席", async () => {
    mockFetch([cfg()], usageOut([], [
      { user_id: "u1", user_name: "张三", sessions: 2, turns: 5,
        input_tokens: null, output_tokens: 1234, total_tokens: 1234 },
      { user_id: "u2", user_name: "李四", sessions: 1, turns: 1,
        input_tokens: null, output_tokens: null, total_tokens: null },
    ], [
      { session_id: "s1", title: "下单链路", user_id: "u1", user_name: "张三", project_id: "p1",
        model_id: "m1", model_name: "gpt-x", turns: 3,
        input_tokens: null, output_tokens: null, total_tokens: null },
      { session_id: "s2", title: "无模型会话", user_id: "u2", user_name: "李四", project_id: "p1",
        model_id: null, model_name: null, turns: 2,
        input_tokens: null, output_tokens: null, total_tokens: 88 },
    ]));
    const { unmount } = render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    // 双表挂在 :256 的 usage && … 条件上：usage 是 load() 的第二个请求（:118），
    // 卡片壳（第一个请求）先到——等表真出现再读行，findByTestId 等的就是这个内容。
    const users = (await screen.findByTestId("model-usage-users")).textContent ?? "";
    expect(users).toContain("张三 · 会话 2 · 轮次 5 · tokens 1234");
    expect(users).toContain("李四 · 会话 1 · 轮次 1 · tokens —"); // null ≠ 0（不冒充已统计）
    const sessions = screen.getByTestId("model-usage-sessions").textContent ?? "";
    expect(sessions).toContain("下单链路 · 张三 · 轮次 3 · tokens — · gpt-x");
    expect(sessions).toContain("无模型会话 · 李四 · 轮次 2 · tokens 88");
    expect(sessions).not.toContain("null"); // model_name null 不许拖出字面量
    unmount();
    // 只有 models 行、users/sessions 全空 → 双表整块不渲染（:243 条件）
    mockFetch([cfg()], usageOut([{ model_id: "m1", usage_sessions: 2 }]));
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    // 缺席断言也要先等内容到货：usage 还没回时表本来就还没长出来，那时「查不到」是假绿。
    // 卡片用量行画「2 会话」= 这份 usage 已进 state，此时表缺席才真的说明是条件拦的。
    await waitFor(() => expect(screen.getByTestId("model-usage-line").textContent).toContain("2 会话"));
    expect(screen.queryByTestId("model-usage-users")).toBeNull();
    expect(screen.queryByTestId("model-usage-sessions")).toBeNull();
  });
});

describe("编辑弹窗开合（model-edit-modal）", () => {
  it("标题带模型名、Key 位 placeholder 回显掩码；[取消] 关弹窗且一个 PATCH 都不发", async () => {
    const calls = mockFetch([cfg()]);
    render(<ModelTab canManage />);
    await openEdit();
    expect(screen.getByText("编辑 · fundgpt-coder-next")).not.toBeNull();
    expect(inputOf("model-f-key").placeholder).toContain("现值 ****7890 · 留空保留");
    fireEvent.click(document.querySelector(
      ".ant-modal-footer .ant-btn:not(.ant-btn-primary)") as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId("model-edit-modal")).toBeNull());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("编辑弹窗载荷（每个把手按下去，PATCH body 必须变）", () => {
  it("名称/base_url/模型名 三框改写 → body 三键各归各位（框接错线立刻红）", async () => {
    const calls = mockFetch([cfg()]);
    render(<ModelTab canManage />);
    await openEdit();
    fireEvent.change(inputOf("model-f-name"), { target: { value: "改名模型" } });
    fireEvent.change(inputOf("model-f-base"), { target: { value: "http://10.0.0.9:9000/v1" } });
    fireEvent.change(inputOf("model-f-model"), { target: { value: "qwen-max" } });
    fireEvent.click(okBtn());
    await waitFor(() => expect(patchCalls(calls).length).toBe(1));
    expect(patchBodyOf(calls, "m1")).toMatchObject({
      cfg_id: "m1", name: "改名模型",
      base_url: "http://10.0.0.9:9000/v1", model_name: "qwen-max",
    });
  });

  it("API Key 留空 = body 里没有 api_key 键（§4.8 保留旧值）；填了才随 body 走", async () => {
    const calls = mockFetch([cfg()]);
    render(<ModelTab canManage />);
    await openEdit();
    const g0 = listGets(calls).length; // 基线要在按下 OK **之前**取：delay 0 下收尾 GET 已同拍派发
    fireEvent.click(okBtn()); // 整表原样保存
    await waitFor(() => expect(patchCalls(calls).length).toBe(1));
    expect("api_key" in patchBodyOf(calls, "m1")).toBe(false);
    // 重开填新值：必须出现且是新值，不是掩码
    // PATCH 的收尾是 setEditing(null) → await load()（ModelTab.tsx:156-157）：弹窗是
    // {editing && form && <Modal/>} 画的（:283），迟到的那句 setEditing(null) 会把刚重开的
    // 弹窗整个卸掉（实测 okBtn() 读到 null）。等收尾跑完再重开。
    await settledAfterPatch(calls, g0);
    fireEvent.click(screen.getByTestId("model-edit-btn"));
    await screen.findByTestId("model-edit-modal");
    // 重开 ≠ 上一次提交落定：save()（ModelTab.tsx:142-159）的 setBusy 要等 PATCH 后的
    // await load() 跑完才释放，confirmLoading 期间 rc-button 直接吞点击——不等就位
    // 就再按 OK，这第二次 PATCH 根本不会发出去（满载下实测停在 1）。
    await waitFor(() => expect(okBtn().className).not.toContain("ant-btn-loading"));
    fireEvent.change(inputOf("model-f-key"), { target: { value: "sk-new-123" } });
    fireEvent.click(okBtn());
    await waitFor(() => expect(patchCalls(calls).length).toBe(2));
    const second = JSON.parse(patchCalls(calls).at(-1)!.body!) as Record<string, unknown>;
    expect(second.api_key).toBe("sk-new-123");
  });

  it("上下文/最大输出/温度 改写 → body 三数值各归各位（互换即红）", async () => {
    const calls = mockFetch([cfg({ temperature_default: 0.7 })]);
    render(<ModelTab canManage />);
    await openEdit();
    const ctx = inputOf("model-f-ctx");
    expect(ctx.value).toBe("32768");
    fireEvent.change(ctx, { target: { value: "65536" } });
    fireEvent.blur(ctx);
    const out = inputOf("model-f-out");
    expect(out.value).toBe("4096");
    fireEvent.change(out, { target: { value: "8192" } });
    fireEvent.blur(out);
    const temp = inputOf("model-f-temp");
    expect(temp.value).toBe("0.7");
    fireEvent.change(temp, { target: { value: "1.5" } });
    fireEvent.blur(temp);
    fireEvent.click(okBtn());
    await waitFor(() => expect(patchCalls(calls).length).toBe(1));
    expect(patchBodyOf(calls, "m1")).toMatchObject({
      context_window: 65536, max_output: 8192, temperature_default: 1.5,
    });
  });

  it("温度清空 → body 是 temperature_default:null 不是 0（「没配温度」≠「0 度」）", async () => {
    const calls = mockFetch([cfg({ temperature_default: 0.7 })]);
    render(<ModelTab canManage />);
    await openEdit();
    const temp = inputOf("model-f-temp");
    fireEvent.change(temp, { target: { value: "" } });
    fireEvent.blur(temp); // antd InputNumber 的提交时机（CommandParams.test 同款）
    fireEvent.click(okBtn());
    await waitFor(() => expect(patchCalls(calls).length).toBe(1));
    const body = patchBodyOf(calls, "m1");
    expect("temperature_default" in body).toBe(true);
    expect(body.temperature_default).toBeNull();
  });

  it("思考关→档位多选禁用且预置档也不发送（body levels=null）；拨开后可选 medium 入 body", async () => {
    const calls = mockFetch([cfg({ thinking_levels: ["low"] })]); // 关思考但列里存着旧档
    render(<ModelTab canManage />);
    await openEdit();
    expect(screen.getByTestId("model-f-levels").className).toContain("ant-select-disabled");
    expect(screen.getByTestId("model-f-thinking").className).not.toContain("ant-switch-checked");
    const g0 = listGets(calls).length; // 同上：基线取在按下 OK 之前
    fireEvent.click(okBtn());
    await waitFor(() => expect(patchCalls(calls).length).toBe(1));
    const off = patchBodyOf(calls, "m1");
    expect(off.supports_thinking).toBe(false);
    expect(off.thinking_levels).toBeNull(); // :141 关思考强制 null，旧档不许偷渡
    // 拨开思考：档位解禁 → 选 medium → 随 body 走
    // 同 API Key 那条：迟到的 setEditing(null)（:156）会卸掉重开的弹窗，先等收尾落定
    await settledAfterPatch(calls, g0);
    fireEvent.click(screen.getByTestId("model-edit-btn"));
    await screen.findByTestId("model-edit-modal");
    fireEvent.click(screen.getByTestId("model-f-thinking"));
    await waitFor(() => expect(
      screen.getByTestId("model-f-levels").className,
    ).not.toContain("ant-select-disabled"));
    fireEvent.mouseDown(screen.getByTestId("model-f-levels")
      .querySelector(".ant-select-selector") as Element);
    const opt = await waitFor(() => {
      const o = Array.from(document.querySelectorAll(
        ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content"))
        .find((n) => (n.textContent ?? "") === "medium");
      expect(o, "档位下拉没有 medium").toBeTruthy();
      return o as Element;
    });
    fireEvent.click(opt);
    // 同 API Key 那条：第一次 save 的 busy 在 await load() 之后才释放，
    // OK 还挂着 ant-btn-loading 时点下去是空点——等释放再按。
    await waitFor(() => expect(okBtn().className).not.toContain("ant-btn-loading"));
    fireEvent.click(okBtn());
    await waitFor(() => expect(patchCalls(calls).length).toBe(2));
    const on = JSON.parse(patchCalls(calls).at(-1)!.body!) as Record<string, unknown>;
    expect(on.supports_thinking).toBe(true);
    // 预置 ["low"] + 新选 medium：多选真把选项写进了 form（不是恒 null/恒 []）
    expect(on.thinking_levels).toEqual(["low", "medium"]);
  });

  it("工具/视觉/启用 三开关各拨一次 → body 三个布尔同时翻到对面", async () => {
    const calls = mockFetch([cfg()]); // tools=on, vision=off, enabled=on
    render(<ModelTab canManage />);
    await openEdit();
    expect(screen.getByTestId("model-f-tools").className).toContain("ant-switch-checked");
    expect(screen.getByTestId("model-f-vision").className).not.toContain("ant-switch-checked");
    expect(screen.getByTestId("model-f-enabled").className).toContain("ant-switch-checked");
    for (const id of ["model-f-tools", "model-f-vision", "model-f-enabled"]) {
      fireEvent.click(screen.getByTestId(id));
    }
    fireEvent.click(okBtn());
    await waitFor(() => expect(patchCalls(calls).length).toBe(1));
    expect(patchBodyOf(calls, "m1")).toMatchObject({
      supports_tools: false, supports_vision: true, enabled: false,
    });
  });

  it("向量模型弹窗：思考/档位/视觉三控件整体缺席；工具与启用仍可拨并入 body", async () => {
    const calls = mockFetch([EMBED]);
    render(<ModelTab canManage />);
    await openEdit();
    for (const id of ["model-f-thinking", "model-f-levels", "model-f-vision"]) {
      expect(screen.queryByTestId(id), id + " 不该出现在向量弹窗（§11.4.23）").toBeNull();
    }
    fireEvent.click(screen.getByTestId("model-f-tools"));
    fireEvent.click(screen.getByTestId("model-f-enabled"));
    fireEvent.click(okBtn());
    await waitFor(() => expect(
      calls.some((c) => c.method === "PATCH" && c.url.endsWith("/model-cfgs/m2"))).toBe(true));
    expect(patchBodyOf(calls, "m2")).toMatchObject({ supports_tools: false, enabled: false });
  });
});

// ── D248：模型配置中心补「登记 / 删除」两个后端早已具备的写口 ─────────────────
describe("D248 登记与删除", () => {
  it("canCreate=false 不摆登记钮；填完三必填 → POST /model-cfgs 带默认能力位", async () => {
    mockFetch([cfg()]);
    const { unmount } = render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-create-btn")).toBeNull(); // 没位就没有门把手
    unmount();

    const calls = mockFetch([cfg()]);
    render(<ModelTab canManage canCreate />);
    await screen.findByTestId("model-card");
    fireEvent.click(screen.getByTestId("model-create-btn"));
    await screen.findByTestId("model-create-modal");
    fireEvent.change(inputOf("model-c-name"), { target: { value: "新模型" } });
    fireEvent.change(inputOf("model-c-base"), { target: { value: "http://127.0.0.1:9100/v1" } });
    fireEvent.change(inputOf("model-c-model"), { target: { value: "qwen-max" } });
    fireEvent.click(okBtn());

    await waitFor(() => expect(
      calls.some((c) => c.method === "POST" && c.url.endsWith("/model-cfgs"))).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!) as Record<string, unknown>;
    // 默认能力位与空 Key 都必须显式随行——少发一条后端就按自己的默认兜，
    // 「界面看到默认」与「后端落库默认」一旦分叉就是两套口径。
    expect(body).toMatchObject({
      name: "新模型", base_url: "http://127.0.0.1:9100/v1", model_name: "qwen-max",
      model_type: "CHAT", protocol: "OPENAI_COMPAT", api_key: "",
      context_window: 32768, max_output: 4096,
      supports_tools: true, supports_thinking: false, thinking_levels: null,
      supports_vision: false, enabled: true, is_default: false,
    });
    await waitFor(() => expect(screen.queryByTestId("model-create-modal")).toBeNull());
    // 登记成功后必须重拉列表（新卡不是凭空画出来的）
    await waitFor(() => expect(
      calls.filter((c) => c.method === "GET" && c.url.includes("/model-cfgs?")).length).toBeGreaterThan(1));
  });

  it("三必填空着点登记 → 一个 POST 都不发；切向量后思考/档位/视觉控件整卡缺席", async () => {
    const calls = mockFetch([cfg()]);
    render(<ModelTab canManage canCreate />);
    await screen.findByTestId("model-card");
    fireEvent.click(screen.getByTestId("model-create-btn"));
    await screen.findByTestId("model-create-modal");
    fireEvent.click(okBtn());
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.mouseDown(screen.getByTestId("model-c-type").querySelector(".ant-select-selector")!);
    fireEvent.click(await screen.findByText("向量"));
    await waitFor(() => expect(screen.queryByTestId("model-c-thinking")).toBeNull());
    expect(screen.queryByTestId("model-c-levels")).toBeNull();
    expect(screen.queryByTestId("model-c-vision")).toBeNull();
    expect(screen.getByTestId("model-c-tools")).not.toBeNull(); // 工具位对向量模型仍成立
  });

  it("canDelete：确认后 DELETE /model-cfgs/{id}；无位不摆删除", async () => {
    mockFetch([cfg()]);
    const { unmount } = render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    expect(screen.queryByTestId("model-delete-btn")).toBeNull();
    unmount();

    const calls = mockFetch([cfg()]);
    render(<ModelTab canManage canDelete />);
    await screen.findByTestId("model-card");
    fireEvent.click(screen.getByTestId("model-delete-btn"));
    const ok = await waitFor(() => {
      const b = document.querySelector(".ant-popconfirm-buttons .ant-btn-primary") as HTMLElement | null;
      expect(b, "Popconfirm 确定钮没出现").toBeTruthy();
      return b!;
    });
    fireEvent.click(ok);
    await waitFor(() => expect(
      calls.some((c) => c.method === "DELETE" && c.url.endsWith("/model-cfgs/m1"))).toBe(true));
    // 删除后同样必须重拉（卡不能留在墙上冒充还在）
    await waitFor(() => expect(
      calls.filter((c) => c.method === "GET" && c.url.includes("/model-cfgs?")).length).toBeGreaterThan(1));
  });
});

// ── 差集「fixture ↔ 后端 Out schema」：探测失败红态 ───────────────────────────
// 后端 model_cfg/services.py:193-195 把 {"ok", "latency_ms", "capabilities",
// "dimensions", "error", "checked_at"} 原样落库；probe.py 不可达路径回
// ok=False + error=「<异常类>: <原文>」——「●失败 · <error 原文>」在生产真能出现。
// 既有 fixture（PROBED/EMBED）只给 ok:true 或 null，:200-202 的失败红字/error 拼接/
// `?? 0` 三支在门禁⑥里从没执行过。这里逐支补断，不动 PROBED/EMBED。

describe("探测失败红态（ModelTab.tsx:198-203 的 ok=false / error 缺席 / latency 缺席三支）", () => {
  it("probe_result.ok=false + error 有原文：model-probe-line 画红色「●失败」并原样带上 error——原文静默吞就是假门", async () => {
    mockFetch([cfg({ probe_result: { ok: false, latency_ms: 0, error: "连接被拒绝", capabilities: {} } })]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    const line = screen.getByTestId("model-probe-line");
    expect(line.textContent).toContain("●失败");
    expect(line.textContent).toContain("连接被拒绝"); // error 原话不许吞
    expect(line.textContent).not.toContain("●OK");
    // 红色语义也钉住：●失败 那一格的着色就是 error 语义色（把失败涂成 OK 绿同样是谎）。
    // 期望值是 tpv.func.error 而不是某个红 hex：着色写在 React 内联样式里，必须是 var()
    // 才跟着主题走（深色下的 error 红是提亮过的另一支）。钉的仍是「失败必须是红的那一支」，
    // 不是放宽：换成任何非 error 语义色照样红。
    const failDot = [...line.querySelectorAll("span")].find((s) => s.textContent === "●失败");
    expect(failDot, "●失败 不是独立着色节点").toBeTruthy();
    expect((failDot as HTMLElement).style.color).toBe(tpv.func.error);
  });

  it("失败但 error 缺席 / latency_ms 缺席：完整文案精确等于「探测●失败 0ms」——不出现孤零零的「·」，缺席延迟画 0ms", async () => {
    // 键整个缺席（不是 error:null——那走的是同一假腿，但键缺席才是 probe 老行形的形状）
    mockFetch([cfg({ probe_result: { ok: false, capabilities: {} } })]);
    render(<ModelTab canManage />);
    await screen.findByTestId("model-card");
    const line = screen.getByTestId("model-probe-line");
    // 精确整句：拆掉 pr.error ? ... : "" 的守卫改成 " · " + pr.error，这里会多出一截
    // 「 · undefined」直接红（只断「不含 undefined」的话，摘守卫渲染成空串照样存活）。
    expect(line.textContent).toBe("探测●失败 0ms");
    // 「·」出现次数显式数一遍：error 缺席段不许留下孤零零的分隔符
    expect((line.textContent ?? "").split("·").length - 1).toBe(0);
    // 同一句里的 0ms 钉的正是 pr.latency_ms ?? 0 那一支：latency_ms 键缺席 → 画 0
    expect(line.textContent).toContain(" 0ms");
  });
});

describe("D260 关键字搜索（模型池三列）", () => {
  it("回车/点搜索才发请求：GET 带 keyword，回包收窄后只剩命中卡片；零命中出带词的专属空态", async () => {
    const calls = mockFetch([PROBED, EMBED]);
    render(<ModelTab canManage />);
    await screen.findAllByTestId("model-card");
    const input = screen.getByTestId("model-search") as HTMLInputElement;

    // 只改输入框不发请求（边敲边发会把卡片墙打成连连看）
    fireEvent.change(input, { target: { value: "bge" } });
    expect(calls.filter((c) => c.url.includes("/model-cfgs?")).length).toBe(1);
    fireEvent.click(document.querySelector(".ant-input-search-button")!);

    await waitFor(() => {
      const url = calls.filter((c) => c.url.includes("/model-cfgs?")).at(-1)!.url;
      expect(decodeURIComponent(url)).toContain("keyword=bge");
    });
    await waitFor(() => expect(screen.getAllByTestId("model-card")).toHaveLength(1));
    expect(screen.getByText("bge-向量")).toBeTruthy();

    fireEvent.change(input, { target: { value: "没有这个" } });
    fireEvent.click(document.querySelector(".ant-input-search-button")!);
    expect(await screen.findByText(/没有匹配「没有这个」的模型/)).not.toBeNull();
    expect(screen.queryAllByTestId("model-card")).toHaveLength(0);
  });
});
