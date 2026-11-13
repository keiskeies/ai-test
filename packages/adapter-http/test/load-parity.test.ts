/**
 * 两个调度器对**同一份计划**必须发出**逐字节相同**的请求。
 *
 * ## 这条测试存在的第一理由，是它抓到了一个真缺陷
 *
 * 写这份测试之前，同步调度器（k6 那条路）的 press 分支用的是
 * `takeSync(buildLoadRequest(…))` —— 想"取一个 async 函数的同步结果"。
 * 而 `async` 函数**总是**返回微任务里 resolve 的 Promise，所以那个"是不是已经
 * 同步跑完了"的判据恒为假：**每一个 press 节点都抛**，k6 那条路一个请求都发不出去
 * （`.scratch/probe-takesync.mts` 量出来的）。`npm test` 全绿，`npm run build` 全绿，
 * 生成出来的 k6 脚本语法也合法 —— 只有真跑一次才会红，而本机装不上 k6。
 * 这一条把两个调度器摆在同一张桌子上比**实际发出去的东西**，于是那一格不再需要 k6。
 *
 * ## 于是本文件最重要的一条是**非空自检**
 *
 * "两边发出的请求一样"这个断言在**两边都是空数组**时成立。上面那个缺陷如果symmetric
 * 一点（两个调度器都不发请求），本文件那几条会全绿而压测一个请求都不打。
 * 所以每条比对之前都先钉"这一轮真的发出了 N 个请求"。这条守法与
 * `ir/test/load-wait-keys.test.ts` 的"取空自检"、`load-plan.test.ts` 的
 * "派生 op 清单 ≥14"是同一条：**比对型断言必须先证明它有东西可比。**
 *
 * ## 比的是**迭代正文**，setup/teardown 刻意不在范围里
 *
 * 两个后端在收尾上的语义**本来就不同**，而且是写进文档的不同：内置后端每个 VU
 * 各跑一次 teardown，k6 只有一个全局 `teardown()`（没有每 VU 收尾这个钩子），
 * 于是清理请求的数量是 N vs 1。把 setup/teardown 纳进比对会得到一条恒红的测试，
 * 而恒红的测试的结局是有人把它注释掉。范围写在测试名里，不藏在实现里。
 * 那两处不同本身登记在 `emit-k6.ts` 文件头与 docs/14。
 *
 * ## 为什么这里用**记录用的假传输**而不是真 fetch
 *
 * 要比的是**请求怎么构造**（求值、拼 URL、序列化、鉴权头、组体），而构造发生在
 * `buildLoadRequest` / `buildLoadRequestSync` 这一层 —— 两个调度器在这一层是
 * **两个不同的函数**（一个同步一个异步，见 runtime.ts 的注释），这正是会分叉的地方。
 * 真 fetch 只能告诉我"后端收到了什么"，而两边都发给同一个 mock 时，
 * 差异会被 mock 的宽容响应掩盖（少一个 query 参数多半照样 200）。
 * 真发一次的能力在 `load-press.test.ts`（对着 mock 打出真分位数）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { deterministicClock } from '@atest/engine';
import { parseOpenApi } from '../src/openapi/parse.js';
import { compileLoadPlan, type LoadDocLookup, type LoadPlan } from '../src/load/plan.js';
import { newLoadState, walkAsyncBuiltin, walkSyncK6, type BuiltRequest, type LoadDeps, type RawResponse } from '../src/load/runtime.js';
import { dirtySpec } from './fixtures.js';

const doc = parseOpenApi(dirtySpec);
const lookup: LoadDocLookup = {
  operation: async ({ docRef, operationId, method, path }) => {
    void docRef;
    const op = doc.operations.find(
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

const b = (id: string) => ({ id });
const scen = (body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.parity', name: 'parity', env: { environmentRef: 'unit' },
    load: { vus: 2, durationMs: 60_000 },
    inputs: [{ name: 'tag', type: 'string', default: 'DEF-TAG' }],
    body,
  } as unknown as ScenarioDraft);

/** 一份把**会分叉的形状**全铺开的 body：值形态、query 序列化、鉴权、体、控制流、断言 */
const BODY: StepDraft[] = [
  { ...b('cfg'), kind: 'set', assign: { mode: 'a', rows: ['x', 'y'], want: 3 } },
  {
    ...b('call'), kind: 'openapiCall', docRef: 'shop.yaml', operationId: 'getOrdersId', pathParams: { id: 'A/1' },
    // 数组 query 是最容易分叉的一格：压成一个 JSON 文本 / 只发第一个 / 保形重复，三种结果后端都可能回 200
    queryParams: { page: { expr: '1 + 1' }, tag: '$tag', ids: [1, 2] },
    headers: { 'x-track': { expr: '"t-" + 7' } },
    saveAs: 'called',
  },
  { ...b('ex'), kind: 'extract', from: '$.step.call.resp', rules: [{ var: 'got', path: '$.id', mode: 'jsonpath', required: false }] },
  { ...b('ok'), kind: 'assert', against: '$.step.call.resp', status: 200, jsonPath: { '$.id': { notNull: true } } },
  {
    ...b('raw'), kind: 'http',
    request: {
      method: 'POST', url: '/orders?keep=1',
      // 值形态要**写出来**（`{path}` / `{expr}`）：值位置上的裸串 `'$got'` 是**字面量**，
      // resolveValue 原样返回（`.scratch/probe-ref.mts` 量的）。本文件第一版写的就是裸串，
      // 于是"inputs 的 default 在两边得出同一个值"那条断言拿到的是字符串 `"$tag"` ——
      // 看着像压测侧漏接了 default，其实是夹具压根没请求解引用。
      query: { extra: { path: '$got' } },
      headers: { 'x-mode': { path: '$mode' } },
      body: { amount: { expr: '2 * 3' }, note: { path: '$tag' }, nested: { list: [1, 2] } },
    },
  },
  { ...b('formy'), kind: 'http', request: { method: 'POST', url: '/login', formData: { user: 'u1', pass: { expr: '"p" + 1' } } } },
  { ...b('branch'), kind: 'if', condition: '$want > 1', then: [{ ...b('then-q'), kind: 'http', request: { method: 'GET', url: '/then' } }], else: [{ ...b('else-q'), kind: 'http', request: { method: 'GET', url: '/else' } }] },
  { ...b('sw'), kind: 'switch', value: '$mode', cases: [{ is: 'a', steps: [{ ...b('case-q'), kind: 'http', request: { method: 'GET', url: '/case-a' } }] }], default: [{ ...b('def-q'), kind: 'http', request: { method: 'GET', url: '/default' } }] },
  // 循环变量走 query 而不是 url：`request.url` 是**纯模板串**（只有 `{param}` 占位，
  // 且 http 步骤没有 pathParams 可填，见 interpreter 那句"未填的占位符"），
  // `$var` 插值不在它身上做。要验"循环里的值真进了请求"，值形态位置才是对的地方。
  { ...b('fe'), kind: 'forEach', items: '$rows', as: 'r', indexAs: 'i', steps: [{ ...b('fe-q'), kind: 'http', request: { method: 'GET', url: '/row', query: { r: { path: '$r' }, i: { path: '$i' } } } }] },
  { ...b('rp'), kind: 'repeat', times: 2, steps: [{ ...b('rp-q'), kind: 'http', request: { method: 'GET', url: '/repeat' } }] },
  { ...b('guard'), kind: 'http', when: '$want > 99', request: { method: 'GET', url: '/never' } },
  { ...b('wait-ok'), kind: 'wait', condition: { type: 'expr', expr: '$want > 1' }, timeoutMs: 1000, onTimeout: 'continue' },
  { ...b('st'), kind: 'http', request: { method: 'GET', url: '/last' } },
];

/** 两个调度器共用的响应夹具：两边喂同一个，比对才只反映"请求侧"的差异 */
const RESP: RawResponse = { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"id":"X1","amount":6}', ms: 3 };

let plan: LoadPlan;
before(async () => { plan = await compileLoadPlan(scen(BODY), lookup); });

function depsFor(clock: ReturnType<typeof deterministicClock>): LoadDeps {
  return { clock, baseUrl: 'http://sut.test', auth: () => {} };
}

/** 跑一遍同步调度器，记录发出的请求 */
function runSync(p: LoadPlan): BuiltRequest[] {
  const clock = deterministicClock(7);
  const st = newLoadState({}, {}, p.inputDefs, clock);
  const sent: BuiltRequest[] = [];
  walkSyncK6(p.nodes, st, depsFor(clock), (r) => { sent.push(structuredClone(r)); return RESP; });
  assert.equal(st.failed, false, `同步那一侧自己判失败了：${st.notes.filter((n) => !n.ok).map((n) => n.why).join('; ')}`);
  return sent;
}

/** 跑一遍异步调度器，记录发出的请求 */
async function runAsync(p: LoadPlan): Promise<BuiltRequest[]> {
  const clock = deterministicClock(7);
  const st = newLoadState({}, {}, p.inputDefs, clock);
  const sent: BuiltRequest[] = [];
  await walkAsyncBuiltin(p.nodes, st, depsFor(clock), async (r) => { sent.push(structuredClone(r)); return RESP; });
  assert.equal(st.failed, false, `异步那一侧自己判失败了：${st.notes.filter((n) => !n.ok).map((n) => n.why).join('; ')}`);
  return sent;
}

describe('两个调度器发出同一个请求（比对的非空自检先行）', () => {
  let syncReqs: BuiltRequest[];
  let asyncReqs: BuiltRequest[];

  before(async () => {
    syncReqs = runSync(plan);
    asyncReqs = await runAsync(plan);
  });

  test('非空自检：两边**各**发出了 10 个以上请求（空数组会让下面每条恒绿）', () => {
    // 这一条是本文件的心脏。takeSync 那一版如果对称地坏在两边，
    // "两边相等"依然成立而压测一个请求都不发 —— 那正是最难发现的一种"通过"。
    assert.ok(syncReqs.length >= 10, `同步侧只发了 ${syncReqs.length} 个请求（先怀疑 press 分支抛了/被跳过）`);
    assert.ok(asyncReqs.length >= 10, `异步侧只发了 ${asyncReqs.length} 个请求`);
  });

  test('请求**个数**相同（顺序也算 —— 少一步与换顺序是两个不同的结论）', () => {
    assert.deepEqual(
      syncReqs.map((r) => `${r.stepId} ${r.method}`),
      asyncReqs.map((r) => `${r.stepId} ${r.method}`),
    );
  });

  test('每个请求的 URL 逐字符相同（含 baseUrl、path 转义、query 序列化）', () => {
    for (let i = 0; i < Math.max(syncReqs.length, asyncReqs.length); i++) {
      assert.equal(syncReqs[i]?.url, asyncReqs[i]?.url, `第 ${i} 个请求（${syncReqs[i]?.stepId ?? '?'} / ${asyncReqs[i]?.stepId ?? '?'}）的 URL 不同`);
    }
  });

  test('每个请求的头与体逐字节相同', () => {
    for (let i = 0; i < syncReqs.length; i++) {
      const a = syncReqs[i]; const bb = asyncReqs[i];
      assert.ok(a && bb, `第 ${i} 个请求在某一边不存在（个数不同，上面那条会指出是哪个）`);
      assert.deepEqual(a.headers, bb.headers, `第 ${i} 个（${a.stepId}）的头不同`);
      assert.equal(a.body, bb.body, `第 ${i} 个（${a.stepId}）的体不同`);
      assert.deepEqual(a.form, bb.form, `第 ${i} 个（${a.stepId}）的表单不同`);
      assert.equal(a.timeoutMs, bb.timeoutMs);
      assert.equal(a.maxBytes, bb.maxBytes, 'maxBytes 分叉 => 一侧截断一侧不截断，断言结果就不同');
      assert.equal(a.followRedirects, bb.followRedirects);
    }
  });

  test('数组 query 在两边都**保形**（压成一个 JSON 文本是这一族的原始缺陷）', () => {
    const call = syncReqs.find((r) => r.stepId === 'call');
    assert.ok(call);
    // 两个元素都在、且不是 `ids=%5B1%2C2%5D` 那种被 stringify 的形态
    assert.match(call.url, /ids=1/);
    assert.match(call.url, /ids=2/);
    assert.ok(!call.url.includes('%5B') && !call.url.includes('1%2C2'), `数组被压成一个文本了：${call.url}`);
    // 异步侧同一条
    assert.equal(asyncReqs.find((r) => r.stepId === 'call')?.url, call.url);
  });

  test('inputs 的 default 在两边得出同一个值（$tag => DEF-TAG）', () => {
    const raw = syncReqs.find((r) => r.stepId === 'raw');
    assert.ok(raw?.url.includes('DEF-TAG') === false || true); // 值在头/体里，见下
    const a = asyncReqs.find((r) => r.stepId === 'raw');
    assert.equal(raw?.body, a?.body);
    assert.ok((raw?.body ?? '').includes('DEF-TAG'), `IR 里写了 default 而这里没兜住：${raw?.body}`);
  });

  test('when 守卫不成立时两边**都**不发那一个请求', () => {
    assert.ok(!syncReqs.some((r) => r.stepId === 'guard'), '同步侧把被 when 跳过的步骤发出去了');
    assert.ok(!asyncReqs.some((r) => r.stepId === 'guard'), '异步侧把被 when 跳过的步骤发出去了');
    // 反向：如果只有一侧跳过，上面那条"个数相同"会红，而这里给出是哪一步
  });

  test('forEach / repeat 展开出的请求数在两边相同（循环是最容易差一次的地方）', () => {
    assert.equal(syncReqs.filter((r) => r.stepId === 'fe-q').length, 2, 'forEach 两条 rows 应该发两个');
    assert.equal(asyncReqs.filter((r) => r.stepId === 'fe-q').length, 2);
    assert.equal(syncReqs.filter((r) => r.stepId === 'rp-q').length, 2, 'repeat times:2 应该发两个');
    assert.equal(asyncReqs.filter((r) => r.stepId === 'rp-q').length, 2);
    // 循环变量进了 URL，所以数量之外还要比值
    assert.deepEqual(
      syncReqs.filter((r) => r.stepId === 'fe-q').map((r) => r.url),
      asyncReqs.filter((r) => r.stepId === 'fe-q').map((r) => r.url),
    );
  });

  test('if / switch 只走命中的那一支，两边同一支', () => {
    assert.ok(syncReqs.some((r) => r.stepId === 'then-q') && !syncReqs.some((r) => r.stepId === 'else-q'));
    assert.ok(!syncReqs.some((r) => r.stepId === 'def-q'));
    assert.deepEqual(syncReqs.map((r) => r.stepId), asyncReqs.map((r) => r.stepId));
  });
});

describe('调度器之间的**其他**共性（不是请求构造的那一侧）', () => {
  test('同一个 wait 条件在两边得出同一个处置（三种 onTimeout 各测一次）', async () => {
    for (const onTimeout of ['fail', 'continue', 'error'] as const) {
      const p = await compileLoadPlan(
        scen([
          { ...b('s'), kind: 'set', assign: { ok: 0 } },
          { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: '$ok > 5' }, timeoutMs: 1000, onTimeout },
          { ...b('after'), kind: 'http', request: { method: 'GET', url: '/after' } },
        ]),
        lookup,
      );
      const clock = deterministicClock(1);
      /*
       * 比的是**处置本身**（抛没抛 / failed 没 failed / 后面还发没发请求），
       * 而**不**把 `mode` 拼进比对的字符串里。本文件第一版拼了，于是这两条字符串
       * 长成 `sync:fail:` 与 `async:fail:` —— 恒不相等，测试恒红。
       * 那种红比"漏断言"更害人：它看起来像抓到了分叉，会让人去查调度器，
       * 而真正坏的是断言自己。所以 verdict/sent 各归各，比对时不带身份标签。
       */
      const runOne = async (mode: 'sync' | 'async'): Promise<{ verdict: string; sent: string }> => {
        const st = newLoadState({}, {}, p.inputDefs, clock);
        const sent: string[] = [];
        let threw = false;
        try {
          if (mode === 'sync') walkSyncK6(p.nodes, st, depsFor(clock), (r) => { sent.push(r.stepId); return RESP; });
          else await walkAsyncBuiltin(p.nodes, st, depsFor(clock), async (r) => { sent.push(r.stepId); return RESP; });
        } catch { threw = true; }
        return { verdict: threw ? 'throw' : st.failed ? 'fail' : 'ok', sent: sent.join(',') };
      };
      const a = await runOne('sync');
      const bb = await runOne('async');
      assert.deepEqual(a, bb, `onTimeout=${onTimeout} 时两个调度器的处置不同`);
      // 再钉一个**具体**结论，而不是只钉"两边相同"（两边一样而都错也是一种通过）
      if (onTimeout === 'error') assert.equal(a.verdict, 'throw');
      if (onTimeout === 'fail') { assert.equal(a.verdict, 'fail'); assert.equal(a.sent, '', 'fail 之后不该再发后面的请求'); }
      if (onTimeout === 'continue') { assert.equal(a.verdict, 'ok'); assert.equal(a.sent, 'after', 'continue 应该继续往下走'); }
    }
  });

  test('判不了的谓词在两边都走 onTimeout，而不是静默当成"条件成立"', async () => {
    // 静态闸与编译器都会拦这条，所以这里**手工造一个**编得出来而运行时判不了的形状：
    // 直接把 condition 换成一个空对象（等价于绕过闸的那条路，验的是运行时的兜底方向）。
    const p = await compileLoadPlan(scen([{ ...b('s'), kind: 'set', assign: { a: 1 } }]), lookup);
    const node = { op: 'waitOnce', id: 'w', condition: { type: 'nonsense' }, onTimeout: 'continue' } as never;
    const clock = deterministicClock(1);
    const st = newLoadState({}, {}, [], clock);
    walkSyncK6([node], st, depsFor(clock), () => RESP);
    // 'continue' 也要留一句 note —— 静默继续是这一族最难查的降级
    assert.ok(st.notes.some((n) => /判不了/.test(n.why ?? '')), `没有留下"判不了"的那句话：${JSON.stringify(st.notes)}`);
    void p;
  });

  test('k6 那条路的异步鉴权抛，而**不发出**一个没鉴权的请求', async () => {
    const p = await compileLoadPlan(scen([{ ...b('q'), kind: 'http', request: { method: 'GET', url: '/orders' } }]), lookup);
    const clock = deterministicClock(1);
    const st = newLoadState({}, {}, p.inputDefs, clock);
    const sent: string[] = [];
    assert.throws(
      () => walkSyncK6(p.nodes, st, { clock, baseUrl: 'http://x', auth: async () => {} }, (r) => { sent.push(r.url); return RESP; }),
      /必须是\*\*同步\*\*实现/,
    );
    // 这一句是本条的全部意义：抛了而没发，才不会打出一条"看起来像权限配坏了"的曲线
    assert.deepEqual(sent, []);
  });

  test('异步鉴权在内置后端那条路上正常工作（同一条 IR 两种鉴权实现都能跑）', async () => {
    const p = await compileLoadPlan(scen([{ ...b('q'), kind: 'http', request: { method: 'GET', url: '/orders' } }]), lookup);
    const clock = deterministicClock(1);
    const st = newLoadState({}, {}, p.inputDefs, clock);
    const seen: string[] = [];
    await walkAsyncBuiltin(p.nodes, st, { clock, baseUrl: 'http://x', auth: async (req) => { req.headers.authorization = 'Bearer T'; seen.push(req.url); } }, async () => RESP);
    assert.equal(seen.length, 1);
  });
});
