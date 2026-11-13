/**
 * 内置压测后端：`press()` **真发请求**，打到由 spec 生成的 mock，产出真 `PerfMetrics`。
 *
 * ## 这个文件补的是哪一格：其余几份都到不了的地方
 *  - `load-plan.test.ts` —— IR -> 计划（纯数据，不发请求）；
 *  - `load-parity.test.ts` —— 两个调度器构造出的请求逐字节相同（**记录用的假传输**）；
 *  - `load-k6.test.ts` —— 生成出来的 k6 文本 + 真预lude 端到端（node 垫片）。
 * 于是"这份计划用真 fetch 打出去会产出什么样的**数**"在那三份里一次都没被执行到：
 * `press()` 与 `measuredLoad()` 是这条路上唯一**没有调用方**的两个导出
 * （`npm run lint` 的 dead-exports 当场点名）。"没有调用方"在这一族缺陷里不等于"没被用到"，
 * 它通常等于"没被跑过"。本文件先把它跑过；CLI 那条接线是下一步。
 *
 * ## 最要紧的几条都是**反向**的
 * "能打出一堆观测"这种正向断言，只要 fetch 通就成立，它证明不了 press() 做过事。
 * 只有 press() 能给出的证据是**它没做的那件事**：
 *  1. 传输层失败（连不上的端口）**必须是一条观测**（status 0 + failed）。
 *     不记的话"施压机断网"会产出一份 `errorRate: 0` 的漂亮报告。
 *  2. **0 条观测必须抛**，而不是产出 `errorRate: 0`。
 *  3. 一个 VU 抛错时**所有 VU 都要真的停住**（`Promise.allSettled`）press() 才抛。
 *     用 `Promise.all` 的话其余 VU 完全不知道、继续施压；调用方 catch 住错误重试一次
 *     就变成**两场压测重叠**（本仓"409 不重发"那条铁律的同一个形状）。
 *     这一条只能从 mock 的请求计数器上量出来，函数层的单测量不出。
 *
 * ## 时间口径
 * 除"冻结时钟必须配上限"那三条之外全部用 **live 时钟 + 真 mock**：冻结时钟的 `mono()`
 * 只在 `sleep()` 时前进，用它测出来的窗口/迭代数与真请求耗时不同数量级，没有意义。
 * 而那三条**只能**用冻结时钟写（要证的正是"这个时钟永远不到点"）。
 *
 * ## 一个**已知够不着**的读数（写在这里而不是等下一个人去猜）
 * `applyLoadResponse` 在响应被 `maxBytes` 截断时留的那句话进的是 `st.notes`，
 * 而 notes **每轮清空**、press() 只把 `ok:false` 的 notes 收进 `failureReasons` ——
 * 于是"响应被截断过"这件事**到不了 PressResult**，报告上只会看到下游断言没过。
 * 下面的截断测试断的是**当前真实现**（断言没过 + 错误率不受影响），
 * 那句缺失的成因登记在 docs/14，不在测试里假装它已经通了。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { defineScenario, type LoadProfile, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { deterministicClock } from '@atest/engine';
import { parseOpenApi, type ParsedDoc } from '../src/openapi/parse.js';
import { startMockServer, type MockServer } from '../src/mock/mock.js';
import { compileLoadPlan, type LoadDocLookup, type LoadPlan } from '../src/load/plan.js';
import { measuredLoad, press, requestFailed, LoadPressFailure, type PressOptions, type PressResult } from '../src/load/press.js';
import { dirtySpec } from './fixtures.js';

const b = (id: string) => ({ id });

/** mock 与编译器共用同一份文档，这样"spec 里有的"与"mock 会答的"不可能对不上 */
function makeLookup(d: ParsedDoc): LoadDocLookup {
  return {
    operation: async ({ docRef, operationId, method, path }) => {
      void docRef;
      const op = d.operations.find(
        (o) => (operationId !== undefined && o.operationId === operationId) || (method && path && o.method === method && o.path === path),
      );
      if (!op) return undefined;
      return {
        method: op.method, urlTemplate: op.path,
        params: op.params.map((p) => ({ name: p.name, in: p.in as 'path' | 'query', ...(p.style !== undefined ? { style: p.style } : {}), ...(p.explode !== undefined ? { explode: p.explode } : {}) })),
        ...(op.operationId !== undefined ? { operationId: op.operationId } : {}),
      };
    },
  };
}

const doc = parseOpenApi(dirtySpec);
const lookup = makeLookup(doc);

/** 超大响应用的那份 spec：600KB 的 example，够越过 1024 的上限、又不拖慢测试 */
const BIG = 'a'.repeat(600_000);
const bigDoc = parseOpenApi({
  openapi: '3.1.0', info: { title: 'big', version: '1' },
  paths: {
    '/big': {
      get: {
        operationId: 'getBig',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'string' } } }, example: { data: BIG } } },
          },
        },
      },
    },
  },
} as never);
const bigLookup = makeLookup(bigDoc);

const LOAD: LoadProfile = {
  vus: 2, durationMs: 4_000, rampUpMs: 0, thinkMs: 0, maxRequests: 0, failureStatus: [], maxIterationsPerVu: 0,
};

const scen = (body: StepDraft[], extra: Record<string, unknown> = {}, id = 'scn.press'): Scenario =>
  defineScenario({
    schemaVersion: '1', id, name: 'press e2e', env: { environmentRef: 'unit' },
    load: LOAD, inputs: [], body, ...extra,
  } as unknown as ScenarioDraft);

/** 一条 happyPath：本地求值 + openapiCall + extract + assert + 容器里的两条 http */
const BODY: StepDraft[] = [
  { ...b('cfg'), kind: 'set', assign: { n: 2 } },
  { ...b('call'), kind: 'openapiCall', docRef: 'shop.yaml', operationId: 'getOrdersId', pathParams: { id: 'A1' }, saveAs: 'called' },
  { ...b('ex'), kind: 'extract', from: '$.step.call.resp', rules: [{ var: 'got', path: '$.id', mode: 'jsonpath', required: false }] },
  { ...b('ok'), kind: 'assert', against: '$.step.call.resp', status: 200 },
  { ...b('rp'), kind: 'repeat', times: 2, steps: [{ ...b('fe'), kind: 'http', request: { method: 'GET', url: '/public/health' } }] },
];

let mock: MockServer;
let bigMock: MockServer;

before(async () => {
  mock = await startMockServer(doc);
  bigMock = await startMockServer(bigDoc);
});
after(async () => {
  await mock.close();
  await bigMock.close();
});

/** 起压。默认对着真 mock、真 fetch、live 时钟、每 VU 两轮 */
function run(plan: LoadPlan, over: Partial<PressOptions> = {}): Promise<PressResult> {
  return press({
    plan, vus: LOAD.vus, durationMs: LOAD.durationMs, baseUrl: mock.addr, maxIterationsPerVu: 2,
    ...over,
  });
}

/** 计数器快照差：同一个 mock 在本文件里是共享的，绝对数会随测试顺序漂 */
const seen = (m: MockServer, pred: (q: { method: string; path: string }) => boolean) => m.requests.filter(pred).length;
function counter(m: MockServer, pred: (q: { method: string; path: string }) => boolean): () => number {
  const n0 = seen(m, pred);
  return () => seen(m, pred) - n0;
}

const emptyPlan = (): LoadPlan => ({
  scenarioId: 'p', nodes: [], setup: [], teardown: [], inputDefs: [], dynamicIterations: false, staticOps: 0,
});

describe('端到端：同一份计划用真 fetch 打出去', () => {
  test('跑通，metrics 里是**真打出来的**数', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const one = counter(mock, (q) => q.path === '/orders/A1');
    const two = counter(mock, (q) => q.path === '/public/health');
    const r = await run(plan);
    assert.equal(r.model, 'closed', '施压模型要一路带到报告里（拿闭合模型的 rps 比开环工具会得到假结论）');
    // 每 VU 每轮 = 1 个 openapiCall + 2 个 http（repeat 2 次）；2 VU × 2 轮 = 12
    assert.equal(r.metrics.samples, 12, JSON.stringify(r.iterationsPerVu));
    assert.equal(r.metrics.errorRate, 0);
    assert.equal(r.setupRequests, 0, '这条没有 setup');
    assert.equal(r.teardownRequests, 0, '也没有 teardown');
    assert.deepEqual(r.iterationsPerVu, [2, 2]);
    assert.equal(r.stoppedEarly, 2, '两个 VU 都是撞到迭代上限收工的（到点不算提前结束）');
    assert.deepEqual(r.failureReasons, [], r.failureReasons.join('; '));
    // **服务端确实收到过**这些请求（mock 自己的计数器，不是 press 的说法）
    assert.equal(one(), 4);
    assert.equal(two(), 8);
  });

  test('rps 用**实测窗口**算，而窗口不是从参数抄来的', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const r = await run(plan);
    assert.equal(r.metrics.rps, (r.metrics.samples / r.windowMs) * 1000);
    assert.notEqual(r.windowMs, LOAD.durationMs, '窗口恰好等于名义 4000ms 意味着 windowMs 是抄的参数（爬坡/收尾场景会虚高）');
  });

  test('观测的**粒度是请求**而不是迭代；分位数真的算出来了', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const r = await run(plan);
    for (const k of ['p50Ms', 'p95Ms', 'p99Ms'] as const) {
      assert.equal(typeof r.metrics[k], 'number', `${k} 没算出来：${JSON.stringify(r.metrics)}`);
      assert.ok(Number.isFinite(r.metrics[k]!) && r.metrics[k]! >= 0, `${k}=${r.metrics[k]}`);
    }
    assert.ok((r.metrics.p99Ms ?? 0) >= (r.metrics.p50Ms ?? 0), '分位数之间不许倒挂');
    assert.equal(r.metrics.samples, 12, '样本数 = 请求数（3 请求 × 2 VU × 2 轮），不是迭代数 4');
  });

  test('setup 的请求**不计入指标**，但数量要如实报（每 VU 各一次）', async () => {
    const plan = await compileLoadPlan(scen(
      [{ ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } }],
      { setup: [{ ...b('login'), kind: 'http', request: { method: 'GET', url: '/users' } }] },
    ), lookup);
    const setups = counter(mock, (q) => q.path === '/users');
    const r = await run(plan);
    assert.equal(setups(), 2);
    assert.equal(r.setupRequests, 2);
    assert.equal(r.metrics.samples, 4, '2 VU × 2 轮 × 1 请求；setup 那两条不在里面（算进去会让短跑的 rps 虚高）');
  });

  test('teardown **每个 VU 各清一次**，清的是 setup 给的那个对象', async () => {
    const plan = await compileLoadPlan(scen(
      [{ ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } }],
      {
        setup: [{ ...b('login'), kind: 'http', request: { method: 'GET', url: '/users' } }],
        teardown: [{ ...b('del'), kind: 'http', request: { method: 'DELETE', url: '/orders/A1' } }],
      },
    ), lookup);
    const dels = counter(mock, (q) => q.method === 'DELETE');
    const r = await run(plan);
    assert.equal(dels(), 2, '与 k6 的"整个压测一次"是**刻意的不同**（那边没有每 VU 收尾钩子），见 emit-k6 文件头');
    assert.equal(r.setupRequests, 2, 'setup 打了 2 个（每 VU 一次）');
    assert.equal(r.teardownRequests, 2, '收尾**单独计数**。从前 setupRequests 把 teardown 也数进去，报成 4 —— 而排查"登录是不是每轮重跑"看的就是那个数');
  });

  test('取消：施压立刻停，但每个 VU 仍然收尾一次（取消 ≠ 把垃圾留下）', async () => {
    const flag = { aborted: false };
    const plan = await compileLoadPlan(scen(
      [{ ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } }],
      { teardown: [{ ...b('del'), kind: 'http', request: { method: 'DELETE', url: '/orders/A1' } }] },
    ), lookup);
    const dels = counter(mock, (q) => q.method === 'DELETE');
    const r = await run(plan, {
      maxIterationsPerVu: 50, durationMs: 30_000, signal: flag,
      onRequest: () => { flag.aborted = true; },
    });
    assert.equal(r.cancelled, true);
    assert.equal(dels(), 2);
    assert.equal(r.metrics.samples, 2, '第一轮跑完就取消了，不许继续施压');
  });

  test('inputs 的 default 在压测里也生效（同一条 IR 不许两种行为）', async () => {
    const plan = await compileLoadPlan(
      defineScenario({
        schemaVersion: '1', id: 'scn.press.input', name: 'n', env: { environmentRef: 'unit' },
        load: LOAD, inputs: [{ name: 'q', type: 'string', default: 'DEF-Q' }],
        body: [{ ...b('u'), kind: 'http', request: { method: 'GET', url: '/users', query: { q: { path: '$q' } } } }],
      } as unknown as ScenarioDraft),
      lookup,
    );
    await run(plan, { maxIterationsPerVu: 1 });
    assert.deepEqual(mock.requests.at(-1)?.query.q, ['DEF-Q'], '报"引用未定义（变量：$q）"就是计划里没带 inputDefs');
  });
});

describe('失败与错误率：press 自己那一段判据', () => {
  test('未匹配的路由 -> 4xx 算失败，并留下一句**带状态码**的成因', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('bad'), kind: 'http', request: { method: 'GET', url: '/nope' } },
    ]), lookup);
    const r = await run(plan, { maxIterationsPerVu: 1 });
    assert.equal(r.metrics.samples, 2);
    assert.equal(r.metrics.errorRate, 1);
    assert.deepEqual(r.failureReasons, ['HTTP 404（2 次）'], '错误率旁边必须有个成因，否则"错误率 100%"这句话没法排查');
    // 次数**必须等于失败请求数**。修之前这里是 `HTTP 404（4 次）`：makeSend 按观测记一次，
    // 迭代结束后那次 notes 扫描又记一次。"偶发 2 个"与"普遍 4 个"是两个不同的结论。
    assert.equal(r.failureReasons[0], 'HTTP 404（2 次）');
  });

  test('4xx 默认就算失败：401/403/404 成批出现正是负载压出来的，不许算成"后端正常应答"', async () => {
    /*
     * 这条**推翻了我自己写在 schema 注释里的一句话**。`LoadProfileSchema.failureStatus`
     * 原本写着"压测的错误率判据默认把 4xx 算成功（后端正常应答了），而 429 与 401
     * 恰恰是最想抓的两类" —— 与实现相反（实测：默认口径下一条 404 的 errorRate 就是 1）。
     * 危险的从来不是那句措辞，是它的**推论**：照着写的人会以为不声明就抓不到 429，
     * 于是给每条场景都加一栏，或者以为默认口径漏了而去改默认值。两处注释本轮都改了。
     */
    const plan = await compileLoadPlan(scen([
      { ...b('rate'), kind: 'http', request: { method: 'GET', url: '/public/health', headers: { 'x-atest-mock-status': '401' } } },
    ]), lookup);
    const r = await run(plan, { maxIterationsPerVu: 1 });
    assert.equal(r.metrics.errorRate, 1, '不声明 failureStatus 也要抓到 401（token 在并发下过期正是这一类）');
    assert.deepEqual(r.failureReasons, ['HTTP 401（2 次）']);
  });

  test('failureStatus 真正的用途：把落在**成功区间**里的 302 捞回来（过载时鉴权失效会跳登录页）', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('redir'), kind: 'http', request: { method: 'GET', url: '/public/health', headers: { 'x-atest-mock-status': '302' } } },
    ]), lookup);
    const silent = await run(plan, { maxIterationsPerVu: 1 });
    assert.equal(silent.metrics.errorRate, 0, '默认口径下 3xx 是"后端正常应答了"');
    assert.equal(silent.metrics.samples, 2, '非空自检：默认那一轮真打出了请求，否则上面那个 0 是空的');
    const counted = await run(plan, { maxIterationsPerVu: 1, failureStatus: [302] });
    assert.equal(counted.metrics.errorRate, 1, 'docs/05 §4 点名的"302 到登录页被误判成功"，在压测形态就藏在这一格');
    assert.deepEqual(counted.failureReasons, ['HTTP 302（2 次）']);
  });

  test('传输层失败**也是一条观测**（status 0），否则断网会产出一份错误率 0 的报告', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('dead'), kind: 'http', timeoutMs: 2_000, request: { method: 'GET', url: '/' } },
    ]), lookup);
    const r = await run(plan, { baseUrl: 'http://127.0.0.1:1', maxIterationsPerVu: 1 });
    assert.equal(r.metrics.samples, 2, '连不上也要有样本');
    assert.equal(r.metrics.errorRate, 1);
    assert.equal(r.failureReasons.length, 1, r.failureReasons.join('; '));
    assert.match(r.failureReasons[0] ?? '', /ECONNREFUSED|fetch failed|Failed to connect/);
  });

  test('超时也算一条观测：timeoutMs 比 mock 的响应还短时不许漏计', async () => {
    // /slow 不在 dirtySpec 里，所以拿真 server 手动挂起：用一个只 accept 不响应的 server
    const { createServer } = await import('node:http');
    const srv = createServer(() => { /* 永不响应 */ });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const plan = await compileLoadPlan(scen([
        { ...b('t'), kind: 'http', timeoutMs: 100, request: { method: 'GET', url: '/' } },
      ]), lookup);
      const r = await run(plan, { baseUrl: `http://127.0.0.1:${port}`, maxIterationsPerVu: 1 });
      assert.equal(r.metrics.samples, 2);
      assert.equal(r.metrics.errorRate, 1);
      assert.match(r.failureReasons[0] ?? '', /AbortError|abort/, `超时没记成观测：${r.failureReasons.join('; ')}`);
    } finally {
      srv.close();
    }
  });

  test('一个 VU 抛错 -> **所有 VU 真的停住**之后才抛（不许出现两场压测重叠）', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } },
    ]), lookup);
    let sent = 0;
    const n0 = mock.requests.length;
    await assert.rejects(
      run(plan, {
        durationMs: 60_000, maxIterationsPerVu: 10_000,
        // 第 3 个请求处炸掉施压机自己：抛这个错的 VU 之外，还有另一个 VU 正在施压
        onRequest: () => { sent++; if (sent === 3) throw new Error('注入：施压机自己炸了'); },
      }),
      /注入：施压机自己炸了/,
    );
    const after = mock.requests.length;
    assert.ok(after > n0, '非空自检：这一轮真的打出过请求，否则下面那条"不再涨"是恒真的');
    // 抛完之后等一个宏任务：请求数**不许**再涨。
    // Promise.all 的写法在这里会继续涨一大截 —— press() 已经抛了而场上还在打，
    // 调用方 catch 住错误重试一次就是两场压测重叠。
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(mock.requests.length, after, `press 已抛而场上还在打请求（${after} -> ${mock.requests.length}）`);
  });

  test('0 条观测 -> 抛，且带着排查方向（不是 errorRate: 0 的漂亮对象）', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('never'), kind: 'http', when: '$nothing > 1', request: { method: 'GET', url: '/public/health' } },
    ]), lookup);
    const n0 = mock.requests.length;
    await assert.rejects(
      run(plan, { durationMs: 50, maxIterationsPerVu: 2, clock: deterministicClock(1) }),
      /一个请求都没发出去[\s\S]*都被 when 跳过/,
    );
    assert.equal(mock.requests.length, n0);
  });

  test('取消在第一个请求之前：仍然抛（CLI 必须把 aborted 当正常收尾，而不是当故障）', async () => {
    // 这条断的是**当前实现的交互后果**：取消导致 0 观测 -> 聚合侧那句"0 条无从谈起"先说话。
    // 不写成"应该返回 cancelled 的结果"是因为那需要一个 0 样本的 PerfMetrics 对象，
    // 而那个对象正是聚合侧拒绝造的东西。处置放在 CLI（它有 signal，也认得出取消）。
    const plan = await compileLoadPlan(scen([
      { ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } },
    ]), lookup);
    await assert.rejects(
      run(plan, { signal: { aborted: true }, durationMs: 5_000, maxIterationsPerVu: 0 }),
      (e) => e instanceof LoadPressFailure && /一个请求都没发出去[\s\S]*已被取消/.test((e as Error).message),
    );
  });

  test('请求数上限**在迭代中间**也生效：说好的数不许超调（超调量会进 rps 的分母）', async () => {
    // 每轮 3 个请求、2 个 VU：只在迭代开头检查的话，maxRequests=5 会打出 5+3=8 个
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const r = await run(plan, { maxRequests: 5, maxIterationsPerVu: 0, durationMs: 30_000, clock: deterministicClock(1) });
    assert.ok(r.metrics.samples <= 6, `超调了：${r.metrics.samples} 个观测 > 上限 5 + 一轮 3`);
    assert.ok(r.metrics.samples >= 5, `一个上限内的请求都没打够：${r.metrics.samples}`);
    assert.ok(r.stoppedEarly >= 1, '撞到上限要算"提前结束"');
  });
});

describe('冻结时钟：这条路上唯一能一处卡死的写法要当场报错', () => {
  test('冻结时钟 + 没有任何上限 -> 抛，且**一个请求都不发**', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const n0 = mock.requests.length;
    await assert.rejects(
      press({ plan, vus: 1, durationMs: 60_000, baseUrl: mock.addr, clock: deterministicClock(1) }),
      (e) => e instanceof LoadPressFailure && /maxIterationsPerVu/.test((e as Error).message),
    );
    assert.equal(mock.requests.length, n0, '抛之前已经打出请求 = 判据发生在发请求之后，那时循环已经开始了');
  });

  test('给了 maxIterationsPerVu 就放行（冻结时钟不是禁用品，它快且可重放）', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const r = await run(plan, { clock: deterministicClock(1), maxIterationsPerVu: 1, vus: 1 });
    assert.deepEqual(r.iterationsPerVu, [1]);
    assert.equal(r.metrics.samples, 3);
  });

  test('给了 maxRequests 也放行', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const r = await run(plan, { clock: deterministicClock(1), maxRequests: 3, maxIterationsPerVu: 0, durationMs: 60_000 });
    assert.ok(r.metrics.samples >= 1);
  });
});

describe('响应体上限：不接就等于压测一晚上攒的是 OOM', () => {
  test('maxResponseBytes 真截断（读的是流，不是先缓冲整个体）', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('big'), kind: 'http', maxResponseBytes: 1024, request: { method: 'GET', url: '/big' } },
    ]), lookup);
    const r = await run(plan, { baseUrl: bigMock.addr, maxIterationsPerVu: 1 });
    assert.equal(r.metrics.samples, 2);
    assert.equal(r.metrics.errorRate, 0, '截断是施压侧的限制，不是后端的错 —— 计入错误率会让人去查后端');
    // 600KB 的体 + 1024 的上限。readCapped 走 res.body 的 reader：
    // 写成 res.text() 的话这里会先缓冲 600KB 再判长度，正是本函数要防的那件事。
    // 那条写法下**这条断言仍然绿** —— 它的症状是内存，不是结果。上限本身由下面那条钉住。
    assert.ok(r.windowMs < 5_000, '截断后不该把整个体读完');
  });

  test('截断之后断言必然没过，而**错误率不受影响**；成因里能看到的是断言那句而不是截断那句', async () => {
    /*
     * 这条断的是**当前实现的可见范围**，不是"应该看到什么"。
     * `applyLoadResponse` 在截断时留的那句"响应被 N 字节截断"进的是 `st.notes`，
     * 而且 `ok: status<400` → 在这条 200 的场景里是 `ok:true`，
     * 于是它**到不了 PressResult.failureReasons**（那里只收 ok:false 的）。
     * 所以报告上"错误率没变而断言没过"的旁边，看不到那句真正的成因
     * —— 正是那段注释许诺过的反面（"那才是下游断言没过时该看到的原因"）。
     * 登记在 docs/14：截断那句要能进报告。这里先把现状钉住，别让它假装已经通了。
     */
    const plan = await compileLoadPlan(scen([
      { ...b('big'), kind: 'http', maxResponseBytes: 1024, request: { method: 'GET', url: '/big' } },
      { ...b('ck'), kind: 'assert', against: '$.step.big.resp', jsonPath: { '$.data': { notNull: true } } },
    ]), lookup);
    const r = await run(plan, { baseUrl: bigMock.addr, maxIterationsPerVu: 1 });
    assert.equal(r.metrics.errorRate, 0, '截断与"断言没过"都不该进错误率（错误率的单位是请求，不是用例结论）');
    assert.equal(r.metrics.samples, 2, '非空自检');
    assert.equal(r.failureReasons.length, 1, r.failureReasons.join('; '));
    assert.match(r.failureReasons[0] ?? '', /\$\.data/, `看到的应该是断言没过那句：${r.failureReasons[0]}`);
    assert.doesNotMatch(r.failureReasons[0] ?? '', /截断/, '当前实现里截断那句到不了这里（已知缺口，见本条开头）');
  });

  test('上限放宽后同一个体能读完并解析出 body（上限不是"一律不读"）', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('big'), kind: 'http', maxResponseBytes: 10_000_000, request: { method: 'GET', url: '/big' } },
      { ...b('ck'), kind: 'assert', against: '$.step.big.resp', status: 200, jsonPath: { '$.data': { notNull: true } } },
    ]), lookup);
    const r = await run(plan, { baseUrl: bigMock.addr, maxIterationsPerVu: 1 });
    assert.deepEqual(r.failureReasons, [], r.failureReasons.join('; '));
  });
});

describe('指纹与判据本身', () => {
  test('measuredLoad：durationMs 用**实测窗口**，runnerSpec 用调用方给的标签', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    const o: PressOptions = { plan, vus: 3, durationMs: 4_000, baseUrl: mock.addr, maxIterationsPerVu: 1 };
    const r = await press(o);
    const fp = measuredLoad(o, r, 'ci-8c16g x1');
    assert.equal(fp.runnerSpec, 'ci-8c16g x1', '机器规格只能调用方给（本层不碰 node:os，口径也要与历史基线手写一致）');
    assert.equal(fp.runnerCount, 1, '本后端永远单进程；拿它比十机基线要被 incomparableReasons 拦下');
    assert.equal(fp.vus, 3);
    assert.equal(fp.connections, 3);
    assert.equal(fp.durationMs, r.windowMs);
    assert.notEqual(fp.durationMs, o.durationMs, '拿名义时长当指纹 = 被取消的三秒场次能合法进基线');
  });

  test('用例自己写的失败进成因、不算取消', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } },
      { ...b('f'), kind: 'fail', reason: '这条用例自己写着要失败' },
    ]), lookup);
    const r = await run(plan, { maxIterationsPerVu: 1 });
    assert.equal(r.cancelled, false, 'cancelled 只看外部标志：把"用例写坏"报成"被人取消了"会 redirect 排查方向');
    assert.match(r.failureReasons[0] ?? '', /这条用例自己写着要失败/);
  });

  test('本地提示（ok:true 的 notes）不混进失败成因', async () => {
    // forEach 撞上限留的那句是 ok:true。它若进 failureReasons，
    // 报告的"失败原因"里会混进一堆与错误率无关的本地提示，而错误率旁边那句话就找不到了。
    const plan = await compileLoadPlan(scen([
      { ...b('cfg'), kind: 'set', assign: { rows: [1, 2, 3, 4] } },
      { ...b('fe'), kind: 'forEach', items: '$rows', as: 'r', maxIterations: 2, steps: [{ ...b('q'), kind: 'http', request: { method: 'GET', url: '/public/health', query: { r: { path: '$r' } } } }] },
    ]), lookup);
    const r = await run(plan, { maxIterationsPerVu: 2, vus: 1 });
    assert.deepEqual(r.failureReasons, [], r.failureReasons.join('; '));
    assert.equal(r.metrics.samples, 4, '每轮只跑前 2 条（上限），2 轮 = 4 个请求');
    assert.deepEqual([...new Set(mock.requests.slice(-4).map((q) => q.query.r?.[0]))].sort(), ['1', '2']);
  });

  test('requestFailed 是失败判据的唯一出处（两侧都问它）', () => {
    const r = (status: number, extra: { transportError?: string } = {}) => ({ status, headers: {}, bodyText: '', ms: 1, ...extra });
    assert.equal(requestFailed(r(0, { transportError: 'x' }), []), true);
    assert.equal(requestFailed(r(204), []), false);
    assert.equal(requestFailed(r(199), []), true, '1xx 不是最终响应（本仓 mock 那边实测过它会挂住客户端）');
    assert.equal(requestFailed(r(302), []), false, '默认口径下 3xx 算应答，要抓它用 failureStatus');
    assert.equal(requestFailed(r(302), [302]), true);
    assert.equal(requestFailed(r(404), []), true);
    assert.equal(requestFailed(r(429), []), true, '4xx **默认就失败** —— schema 注释从前说反了，本轮改掉');
    assert.equal(requestFailed(r(500), []), true);
    assert.equal(requestFailed(r(999), []), true);
  });

  test('setup 没过 -> 整场压测停下，而不是留下一条"全是 401"的曲线', async () => {
    const plan = await compileLoadPlan(scen(
      [{ ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } }],
      { setup: [{ ...b('bad'), kind: 'http', request: { method: 'GET', url: '/nope' } }] },
    ), lookup);
    const body = counter(mock, (q) => q.path === '/public/health');
    await assert.rejects(
      run(plan, { durationMs: 30_000, maxIterationsPerVu: 50 }),
      (e) => e instanceof LoadPressFailure && /setup 没过/.test((e as Error).message),
    );
    assert.equal(body(), 0, 'setup 失败后一个业务请求都不该发出去（后面全打在没准备的状态上）');
  });

  test('压测形态不产证据：saveArtifact 抛而不是返回空串（返回空串=让人以为存成功了）', async () => {
    // assert 节点那条路上会去 ctx.saveArtifact（只有需要落盘的断言才走）。
    // 这里用一条普通断言确认压测路径**不碰**它：热路径跳过落盘是设计，碰了才是问题。
    const plan = await compileLoadPlan(scen([
      { ...b('one'), kind: 'http', request: { method: 'GET', url: '/public/health' } },
      { ...b('ck'), kind: 'assert', against: '$.step.one.resp', status: 200 },
    ]), lookup);
    const r = await run(plan, { maxIterationsPerVu: 1 });
    assert.deepEqual(r.failureReasons, []);
  });
});
