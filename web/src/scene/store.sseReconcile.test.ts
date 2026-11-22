// D150：SSE 断流的一次性对账（store.noteStreamDown）。病根：shared/sse.ts 咽掉流错误、
// 1500ms 静默重连、刷新失败无声停手——流真死透时 run 永远停在 running，UI 无限呼吸
// 「运行中」（finishRun 全仓零调用者，终态只从 SSE run_end 这一条路收敛）。
// 裁定形状①（这里逐条钉死）：不常驻轮询、不超时杀长场景；连续第 3 次断流（三击惯例，
// notify/hooks.py ALERT_THRESHOLD=3 同源）⇒ 发且只发一次 run 状态取数（reportApi.get，
// 与 reportDetail 轮询终态同一 api 模块——mock 模块边界即钉「复用」这件事）。
// ① 3 连断 ⇒ 恰一次取数；② 终态（run 级词表 passed/failed/error/cancelled，非 step 级
//    pass/fail）⇒ 走 finishRun：phase=done、finalStatus/stats 落地；
// ③ 非终态 ⇒ run 状态一字不动，且计数已归零：downs 4..5 不再发，第 6 下（重置后的第
//    3 下）才发第 2 次，7..8 保持 2 次——防 fetch 风暴的正/负对照一对；
// ④ 正对照：2 连断 ⇒ 零取数（阈值没到不许发）；在途期间第 4..6 下也不许再发（同轮单在途）；
// ⑤ 世代门（deferred 手工竞态，手法照 store.assetsPaging.test.ts）：run A 的迟到终态
//    响应在 run B 开始后落地 ⇒ B 一字不动；正对照：B 自己的 3 连断照常对账收敛；
// ⑥ 任一成功帧归零：down→down→帧→down→down 永远攒不满 3；
// ⑦ 非 running 会话（idle/starting/done、无 runId）断流零取数——没有可兜的。
// 手法：reportApi 整体换成 deferred 桩（每次调用弹一个可控 promise）；store 是模块单例，
// beforeEach 显式归零 run 态防串腿。jsdom：client.ts 读 localStorage 要那个全局。
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneStore } from "./store";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/report", () => ({ reportApi: { get: h.get } }));

let calls: Array<[string, string]> = [];
/** 每次 noteStreamDown 触发的取数对应一个 deferred：什么时候回、回什么都由测试定。 */
let queue: Array<{ p: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

/** 微任务排空：.then/.catch/.finally 一层一个 tick，给足 8 个。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const down = () => useSceneStore.getState().noteStreamDown();
const run = () => useSceneStore.getState().run;
const nFetch = () => calls.length;

function seedRun(over: Record<string, unknown> = {}): void {
  useSceneStore.setState({
    projectId: "p1", scenarioId: "s1",
    run: { open: true, trigger: "manual", runId: "run-A", phase: "running", errorText: null,
      finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false,
      downStrikes: 0, ...over },
  } as never);
}

beforeEach(() => {
  calls = [];
  queue = [];
  h.get.mockReset().mockImplementation((pid: string, runId: string) => {
    calls.push([pid, runId]);
    const d = deferred();
    queue.push(d);
    return d.p;
  });
  seedRun();
});

// 在途标记 reconcilingRunId 是模块级、活得比单测久：每条用例结束时把没回话的 deferred
// 全部 reject 排干（.catch/.finally 走完后标记归零），否则上一条遗留的在途会假挡下一条。
// 这本身就是「同轮单在途」门的镜像证明。
afterEach(async () => {
  for (const d of queue) d.reject(new Error("drain"));
  await settle();
});

describe("D150 阈值：3 连断 ⇒ 恰一次取数", () => {
  it("downs 1..2 零取数，第 3 下取恰一次（参数=现成 reportApi.get(pid, runId)，非另搓 URL）；第 4 下不再发", async () => {
    down(); down();
    expect(nFetch()).toBe(0); // 正对照的镜像腿：阈值没到，一次都不许发
    expect(run().downStrikes).toBe(2);
    down();
    expect(nFetch()).toBe(1);
    expect(calls[0]).toEqual(["p1", "run-A"]); // 复用 reportApi 模块边界：只传 pid+runId
    expect(run().downStrikes).toBe(0); // 第 3 击消费掉：无论结果如何都从 0 重攒
    down(); // 第 4 下 = 新一轮第 1 击
    expect(nFetch()).toBe(1);
    expect(run().downStrikes).toBe(1);
  });
});

describe("D150 终态：取到 run 级终态 ⇒ finishRun 收敛", () => {
  it("3 连断后取回 failed+stats ⇒ phase=done、finalStatus=failed、stats 落地（run_end 同款收敛）", async () => {
    const stats = { total: 4, pass: 2, fail: 1, skip: 0, error: 0, cancelled: 1 };
    down(); down(); down();
    expect(nFetch()).toBe(1);
    queue[0].resolve({ status: "failed", stats });
    await settle();
    const r = run();
    expect(r.phase).toBe("done");
    expect(r.finalStatus).toBe("failed");
    expect(r.stats).toEqual(stats);
    expect(r.errorText).toBeNull(); // 对账不是发起失败：errorText 不许被顺手写上
  });

  it("终态词表是 run 级四词（passed/failed/error/cancelled）；step 级 pass/fail 与 running 都不算终态", async () => {
    for (const [status, terminal] of [
      ["passed", true], ["cancelled", true], ["running", false], ["queued", false],
      ["pass", false], ["fail", false], // step 级词表混进来就会把还在跑的场景判死——必须不算
    ] as Array<[string, boolean]>) {
      seedRun();
      calls = []; queue = [];
      down(); down(); down();
      queue[0].resolve({ status, stats: null });
      await settle();
      if (terminal) {
        expect(run().phase, status).toBe("done");
        expect(run().finalStatus, status).toBe(status);
      } else {
        expect(run().phase, status).toBe("running");
        expect(run().finalStatus, status).toBeNull();
      }
    }
  });
});

describe("D150 非终态：run 状态不动 + 计数重置后下一窗再取一次（不风暴）", () => {
  it("取回 running ⇒ 一字不动；downs 4..5 不发，第 6 下发第 2 次；7..8 保持 2 次", async () => {
    down(); down(); down();
    expect(nFetch()).toBe(1);
    queue[0].resolve({ status: "running", stats: null });
    await settle();
    const before = run();
    expect(before.phase).toBe("running");
    expect(before.finalStatus).toBeNull();
    expect(before.runId).toBe("run-A");
    expect(before.stats).toBeNull();
    // 计数在发请求时就归零了（不等服务端回话）：非终态响应也不追加、不倒扣
    expect(run().downStrikes).toBe(0);
    down(); down(); // 第 4、5 下 = 重置后的第 1、2 击
    expect(nFetch()).toBe(1);
    expect(run().downStrikes).toBe(2);
    down(); // 第 6 下 = 重置后的第 3 击 ⇒ 再取恰一次
    expect(nFetch()).toBe(2);
    expect(calls[1]).toEqual(["p1", "run-A"]);
    down(); down(); // 7、8 下：够不着阈值，保持 2 次——不是每断必fetch 的风暴
    expect(nFetch()).toBe(2);
  });

  it("在途期间不叠发：fetch#1 未回时连断 3 下也只有一次在途；回话后重新攒满再发", async () => {
    down(); down(); down(); // fetch#1 在途（deferred 未回）
    expect(nFetch()).toBe(1);
    down(); down(); down(); // 同轮单在途门挡住第 3 击：不叠发
    expect(nFetch()).toBe(1);
    expect(run().downStrikes).toBe(2); // 被挡的那下不计数（没消费掉对账机会）
    queue[0].resolve({ status: "running", stats: null });
    await settle();
    down(); // 在途落定后的第 3 击 ⇒ 恰发第 2 次
    expect(nFetch()).toBe(2);
  });

  it("对账取数失败（网络/500）：run 状态不动���也不留残余计数；再攒满 3 击可重试", async () => {
    down(); down(); down();
    queue[0].reject(new Error("boom"));
    await settle();
    expect(run().phase).toBe("running");
    expect(run().finalStatus).toBeNull();
    expect(run().downStrikes).toBe(0); // 失败路同样清零：取数失败≠证实还活着，但也不留半截计数
    down(); down();
    expect(nFetch()).toBe(1);
    down();
    expect(nFetch()).toBe(2); // 重试通道是活的
  });
});

describe("D150 世代门：迟到响应与断流计数都不许串轮", () => {
  it("run A 对账在途 → 换 run B → 迟到的 A 终态落地 ⇒ B 一字不动；正对照：B 自己 3 连断照常收敛", async () => {
    down(); down(); down(); // A 的对账在途
    expect(nFetch()).toBe(1);
    // 在途期间发起新一轮 B（beginRun+attachRun 换 runId，run 对象整体作废）
    useSceneStore.getState().beginRun("manual");
    useSceneStore.getState().attachRun("run-B");
    expect(run().runId).toBe("run-B");
    expect(run().downStrikes).toBe(0); // 换轮即清零：A 攒的计数不带进 B
    queue[0].resolve({ status: "passed", stats: { total: 1 } }); // 迟到的 A 终态
    await settle();
    const b = run();
    expect(b.phase).toBe("running"); // 迟到的旧轮终态不许 reconcile 新轮
    expect(b.finalStatus).toBeNull();
    expect(b.stats).toBeNull();
    expect(b.runId).toBe("run-B");
    // 正对照：门不是永远关着——B 自己的 3 连断照常取数、自己的终态照常收敛
    down(); down(); down();
    expect(nFetch()).toBe(2);
    expect(calls[1]).toEqual(["p1", "run-B"]); // 取的是当前轮的 id，不是 A 的
    queue[1].resolve({ status: "cancelled", stats: { total: 2 } });
    await settle();
    expect(run().phase).toBe("done");
    expect(run().finalStatus).toBe("cancelled");
  });
});

describe("D150 计数归零的两个来源：成功帧 / 换轮", () => {
  it("旧形状 run 快照没带 downStrikes 字段（NaN 防御）：首击计 1 不假跳阈值", async () => {
    // SceneEditor.test.tsx 那类 setState 用 spread 覆盖 run、不带新字段——undefined+1=NaN，
    // NaN<3 为 false 会**跳过计数直接发请求**。??0 兜住这条：缺字段按 0 起算。
    useSceneStore.setState({
      run: { open: true, trigger: "manual", runId: "run-A", phase: "running", errorText: null,
        finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false },
    } as never); // 故意漏 downStrikes：模拟旧快照
    down();
    expect(nFetch()).toBe(0); // 没 ??0 的话这里 NaN 直接发请求 = 红
    expect(run().downStrikes).toBe(1);
    down(); down();
    expect(nFetch()).toBe(1); // 攒满 3 击照常对账：防御读没把门焊死
  });

  it("down→down→(帧到达)→down→down 永远攒不满：零取数；帧后真再断满 3 击照常取（正对照）", async () => {
    down(); down();
    useSceneStore.getState().applyRunEvent({ seq: 1, type: "step/running", payload: { key: "n1" } });
    expect(run().downStrikes).toBe(0); // 任一成功帧 = 流是活的，连续计数归零
    expect(run().events).toHaveLength(1); // 归零不吞帧：投影照常
    down(); down();
    expect(nFetch()).toBe(0);
    down();
    expect(nFetch()).toBe(1); // 正对照：归零不是关门，再攒满照发
  });

  it("非 running 会话零兜底：idle/starting/done/无 runId 各断满 3 击都零取数", () => {
    for (const over of [
      { phase: "idle", runId: null }, { phase: "starting", runId: null },
      { phase: "done", runId: "run-A", finalStatus: "passed" },
    ]) {
      seedRun(over);
      calls = [];
      down(); down(); down();
      expect(nFetch(), JSON.stringify(over)).toBe(0);
      expect(run().downStrikes, JSON.stringify(over)).toBe(0); // 门在最前：计数都不许攒
    }
  });
});
