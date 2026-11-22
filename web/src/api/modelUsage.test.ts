// 模型用量 API 壳（modelUsage.ts）的单测。node 环境跑（vitest.config.ts 的默认环境）：
// 本文件不碰 DOM、不碰 React，网络边界收在 ./client 的 get 上（vi.mock 整模块换桩，
// 真 client 不加载 → antd 静态 message 不碰 document，机制同 ChangePasswordModal.test.tsx:39-40
// 的 vi.hoisted + vi.mock）。钉三件事：
//   ① stats 的查询串拼装：days/modelId/projectId → days/model_id/project_id（camelCase→
//      snake_case 逐个点名，映射错了用量过滤会静默失效）；无参时不带裸 `?`；
//      days:0 不丢——守卫是 `q.days != null` 而非真值判断，`if (q.days)` 会把「今天 0 天
//      窗口」这种合法入参吞掉，这条断言就是这个写法存在的全部理由；{ silent: true }
//      必须原样递给 get（用量面板拉取失败不许弹 toast）；
//   ② 出参形状归一：缺组按空数组/文档化默认值补齐（防传输层事故把渲染层炸穿），
//      但有数据时逐组原样透传（不许把归一函数误读成「永远返回空」）；
//   ③ byModel 只认 model_id：契约是「查不到 = 用量接口没取到，调用方画「—」」，
//      松匹配（比如按 model_name）会凭空捏造用量数字，必须钉死。
// 【不证明什么】真 fetch / 错误信封 / silent 抑制 toast 的链路在 client.ts，
// 由 api/client.test.ts 钉；这里只钉到 get 的调用参数为止。
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
}));
vi.mock("./client", () => ({ get: api.get }));

import { modelUsageApi, type ModelUsageOut, type ModelUsageRow } from "./modelUsage";

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(async () => ({}));
});

/** get 被调时的第一个实参（完整 path，含查询串）。 */
function getPath(): string {
  return api.get.mock.calls[0][0] as string;
}

const row = (over: Partial<ModelUsageRow> = {}): ModelUsageRow => ({
  model_id: "m1", model_name: "模型一", sessions: 2, usage_sessions: 1, turns: 3,
  input_tokens: 10, output_tokens: 5, total_tokens: 15, ...over,
});

describe("stats：查询串拼装", () => {
  it("三参数映射到 snake_case，顺序按 set 调用序", async () => {
    await modelUsageApi.stats({ days: 7, modelId: "m1", projectId: "p1" });
    // URLSearchParams.toString 按插入序输出，插入序即 stats 里三次 set 的源码序——
    // 逐键断言之外把整串也钉住，键序漂了（比如后端按序缓存）也能红。
    expect(getPath()).toBe("/model-usage?days=7&model_id=m1&project_id=p1");
    const q = new URLSearchParams(getPath().split("?")[1]);
    expect(q.get("days")).toBe("7");
    expect(q.get("model_id")).toBe("m1");
    expect(q.get("project_id")).toBe("p1");
  });

  it("无参：path 恰好 /model-usage，不带裸 ?", async () => {
    await modelUsageApi.stats();
    expect(getPath()).toBe("/model-usage");
  });

  it("days:0 不丢：守卫是 != null，不是真值", async () => {
    await modelUsageApi.stats({ days: 0 });
    expect(getPath()).toBe("/model-usage?days=0");
  });

  it("每次调用都带 { silent: true }", async () => {
    await modelUsageApi.stats({ days: 7 });
    expect(api.get.mock.calls[0][1]).toEqual({ silent: true });
    await modelUsageApi.stats();
    expect(api.get.mock.calls[1][1]).toEqual({ silent: true });
  });
});

describe("stats：出参形状归一", () => {
  it("空响应 {} → 三组补空数组，scope/filters/totals 给文档化默认", async () => {
    api.get.mockResolvedValueOnce({});
    const out = await modelUsageApi.stats();
    expect(out.users).toEqual([]);
    expect(out.sessions).toEqual([]);
    expect(out.models).toEqual([]);
    expect(out.scope).toEqual({ project_id: null });
    expect(out.filters).toEqual({ project_id: null, model_id: null, days: null });
    expect(out.totals).toEqual({
      sessions: 0, usage_sessions: 0, turns: 0,
      input_tokens: null, output_tokens: null, total_tokens: null,
    });
  });

  it("有数据时逐组原样透传，归一不许踩数据", async () => {
    const raw: ModelUsageOut = {
      scope: { project_id: null },
      filters: { project_id: "p1", model_id: "m1", days: 7 },
      totals: { sessions: 4, usage_sessions: 3, turns: 9,
        input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      users: [{ user_id: "u1", user_name: "阿明", sessions: 2, turns: 5,
        input_tokens: 60, output_tokens: 30, total_tokens: 90 }],
      sessions: [{ session_id: "s1", title: "回归", user_id: "u1", user_name: "阿明",
        project_id: "p1", model_id: "m1", model_name: "模型一", turns: 5,
        input_tokens: 60, output_tokens: 30, total_tokens: 90 }],
      models: [row()],
    };
    api.get.mockResolvedValueOnce(raw);
    const out = await modelUsageApi.stats();
    expect(out).toEqual(raw);
    // 透传按引用：归一只补缺，不重新造对象（新造就谈不上「覆盖数据」，但也说明
    // 这里没有做白名单式挑选——后端新增字段现在会原样带出来）。
    expect(out.models).toBe(raw.models);
    expect(out.totals).toBe(raw.totals);
  });

  it("部分缺组按组独立补：有 users 不救 models", async () => {
    api.get.mockResolvedValueOnce({ models: [row()] });
    const out = await modelUsageApi.stats();
    expect(out.models).toHaveLength(1);
    expect(out.users).toEqual([]);
    expect(out.sessions).toEqual([]);
  });
});

describe("byModel：只按 model_id 认行", () => {
  const out = (models: ModelUsageRow[]): ModelUsageOut => ({
    scope: { project_id: null },
    filters: { project_id: null, model_id: null, days: null },
    totals: { sessions: 0, usage_sessions: 0, turns: 0,
      input_tokens: null, output_tokens: null, total_tokens: null },
    users: [], sessions: [], models,
  });

  it("命中返回该行本体", () => {
    const m = row({ model_id: "m1" });
    expect(modelUsageApi.byModel(out([row({ model_id: "other" }), m]), "m1")).toBe(m);
  });

  it("查不到的 id 返回 undefined（调用方据此画「—」）", () => {
    expect(modelUsageApi.byModel(out([row()]), "nope")).toBeUndefined();
    expect(modelUsageApi.byModel(out([]), "m1")).toBeUndefined();
  });

  it("不许松匹配到 model_name：名字撞 id 也不算命中", () => {
    // 契约「查不到 = 用量接口没取到」：若 find 条件松到 model_name === id，
    // 这行会被当成 m1 的用量端上来，凭空捏造数字。
    const out2 = out([row({ model_id: "other", model_name: "m1" })]);
    expect(modelUsageApi.byModel(out2, "m1")).toBeUndefined();
  });
});
