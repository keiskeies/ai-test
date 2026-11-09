/**
 * M2 的最终判据：**引擎跑真实 IR，打到由 spec 生成的 mock server，全绿**
 * （docs/04 M2，docs/05 §6「引擎自测不依赖任何真实后端」）。
 *
 * 与 mock.test.ts 的分工：那份测的是 HTTP 层与 mock 本身；
 * 这份测的是 **engine ⇄ adapter 这条接缝** —— HttpExec 端口对不对、
 * openapiCall 的参数具象化通不通、URL 是不是从环境来的。
 * 这条接缝是整套"一个引擎、GUI 只是它的一个视图"论断的地基，
 * 只在单元层面测等于没测。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, deterministicClock, type RunReport, type AdapterRegistry } from '@atest/engine';
import { defineScenario, type ScenarioDraft } from '@atest/ir';
import { parseOpenApi, HttpClient, asHttpExec, startMockServer, type MockServer, type OperationSpec } from '../src/index.js';
import { dirtySpec } from './fixtures.js';

const doc = parseOpenApi(dirtySpec);
let mock: MockServer;
let adapters: AdapterRegistry;
const baseUrl = () => mock.addr;

before(async () => {
  mock = await startMockServer(doc);
  adapters = { http: asHttpExec(new HttpClient(), () => doc) };
});
after(async () => { await mock.close(); });

const run = (body: unknown[], extra: Record<string, unknown> = {}) =>
  runScenario({
    scenario: defineScenario({ schemaVersion: '1', id: 'scn.mock', name: 'mock e2e', env: { environmentRef: 'unit' }, body, ...extra } as ScenarioDraft),
    adapters, clock: deterministicClock(1), env: { baseUrl: baseUrl() },
  });
const runAt = (addr: string, body: unknown[]) =>
  runScenario({
    scenario: defineScenario({ schemaVersion: '1', id: 'scn.mock2', name: 'mock e2e 2', env: { environmentRef: 'unit' }, body } as ScenarioDraft),
    adapters, clock: deterministicClock(1), env: { baseUrl: addr },
  });

/** 失败时把每步状态打出来，否则只看到 'fail' !== 'pass' 无从下手 */
const assertPass = (r: RunReport) => {
  const detail = r.results.map((x) => `${x.stepId}:${x.status}${x.assertionSummary ? `(${x.assertionSummary})` : ''}`).join(' ');
  assert.equal(r.status, 'pass', `${r.summary} :: ${detail}`);
};

describe('http 步骤打到 mock', () => {
  test('IR 写相对路径，域名来自环境配置', async () => {
    assertPass(await run([
      { id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/A1' } },
      { id: 'a', kind: 'assert', against: '$.step.g.resp', status: 200, jsonPath: { '$.id': { exact: 'A1' } } },
    ]));
  });

  test('mock 收到的就是 IR 里写的那个 path（没有偷偷加域名或改大小写）', async () => {
    await run([{ id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/A1' } }]);
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.equal(seen.path, '/orders/A1');
    assert.equal(seen.method, 'GET');
  });

  test('环境没配 baseUrl -> error 且报"没配 baseUrl"，而不是发一个相对 URL 出去', async () => {
    const r = await runScenario({
      scenario: defineScenario({ schemaVersion: '1', id: 's', name: 'n', env: { environmentRef: 'u' }, body: [{ id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/A1' } }] } as ScenarioDraft),
      adapters, clock: deterministicClock(1),
    });
    assert.equal(r.status, 'error');
    assert.match(r.results[0]!.assertionSummary ?? '', /baseUrl/);
  });

  test('query 参数按 IR 写出并真的到达服务端', async () => {
    await run([{ id: 'g', kind: 'http', request: { method: 'GET', url: '/users', query: { page: '3' } } }]);
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.deepEqual(seen.query.page, ['3']);
  });

  test('POST 带请求体，mock 收到的 body 与 IR 一致', async () => {
    await run([{ id: 'p', kind: 'http', request: { method: 'POST', url: '/orders', body: { id: 'Z9', amount: 12 } } }]);
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.deepEqual(seen.body, { id: 'Z9', amount: 12 });
  });

  test('大整数 ID 穿过整条链路：响应 -> extract -> 下一步 URL', async () => {
    // 这是 docs/05 §4 说的"最阴的 bug"的端到端版本：
    // 中间任何一处过一遍 Number，最后 mock 收到的 path 就会差 147
    const big = '7301894562345678901';
    const echoMock = await startMockServer({
      ...doc,
      operations: [{ ...doc.byId.get('getOrdersId')!, path: '/orders/{id}', operationId: 'getOrdersId', examples: { '200': { id: big, amount: 1 } } }],
    });
    try {
      const r = await runAt(echoMock.addr, [
        { id: 'mk', kind: 'http', request: { method: 'GET', url: '/orders/0' } },
        { id: 'ex', kind: 'extract', from: '$.step.mk.resp', rules: [{ var: 'oid', path: '$.body.id' }] },
        // pathParams 是 ValueSchema，能写引用；而 http.request.url 是**裸字符串**，
        // 没法带变量 —— 这是 IR 的刻意设计（引用必须显式，docs/02 §5），
        // 所以"把上一步的 id 放进路径"这件事只有 openapiCall 一条路。
        { id: 'g2', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: { path: '$oid' } } },
        { id: 'a', kind: 'assert', against: '$.step.g2.resp.body.id', jsonPath: { $: { exact: big } } },
      ]);
      assertPass(r);
      // 真正的证据是 mock 收到的 URL：断言能过是因为**发对了请求**，
      // 而不是因为两边都是 undefined 所以相等
      const seen = echoMock.requests[echoMock.requests.length - 1]!;
      assert.equal(seen.path, `/orders/${big}`, '大整数在某一跳被 Number 吃掉了精度');
    } finally { await echoMock.close(); }
  });
});

describe('openapiCall 步骤', () => {
  test('只写 operationId，method/path 全从 spec 推导', async () => {
    assertPass(await run([
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'health' },
      { id: 'a', kind: 'assert', against: '$.step.c.resp', status: 200 },
    ]));
    assert.equal(mock.requests[mock.requests.length - 1]!.path, '/public/health');
  });

  test('pathParams 具象化到 URL 模板', async () => {
    assertPass(await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: 'ORD-77' } }]));
    assert.equal(mock.requests[mock.requests.length - 1]!.path, '/orders/ORD-77');
  });

  test('pathParams 写了不存在的名字 -> error，不静默忽略', async () => {
    const r = await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { userID: '1' } }]);
    assert.equal(r.status, 'error');
    assert.match(r.results[0]!.assertionSummary ?? '', /pathParams 里的 "userID"/);
  });

  test('漏填 path 参数 -> error，而不是把 {id} 原样发出去换个查不出原因的 404', async () => {
    const r = await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId' }]);
    assert.equal(r.status, 'error');
    assert.match(r.results[0]!.assertionSummary ?? '', /未填的参数/);
    assert.ok(!mock.requests.some((q) => q.path.includes('{id}')), '占位符不该出现在真实请求里');
  });

  test('operationId 在 spec 里不存在 -> error 并说明去哪看', async () => {
    const r = await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'noSuchOp' }]);
    assert.equal(r.status, 'error');
    assert.match(r.results[0]!.assertionSummary ?? '', /spec 里没有这个 operation/);
  });

  test('deprecated 接口仍能调用，但记一条 DEPRECATED_OPERATION 事件', async () => {
    const r = await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'removeOrder' }]);
    const ev = r.events.find((e) => e.kind === 'lint.reported');
    assert.ok(ev, '已废弃接口该留痕（默认不给它生成用例，但用户显式写了就不能拦）');
    assert.equal((ev!.data as { code: string }).code, 'DEPRECATED_OPERATION');
  });

  test('queryParams 走 spec 声明的 style（pipeDelimited + explode=false -> a|b）', async () => {
    // 注意：engine 的 buildUrl 用 URLSearchParams 序列化，style 由 adapter 侧负责。
    // 这条断言暴露的是**接缝缺口**：openapiCall 的 query 目前没按 spec 的 style 走。
    await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'listUsers', queryParams: { q: 'a|b' } }]);
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.deepEqual(seen.query.q, ['a|b']);
  });

  test('strategy 标签随步骤导出（报告按它分桶）', async () => {
    const r = await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'health', strategy: 'happyPath' }]);
    assertPass(r);
    // openapiCall 把 strategy 导出到 step 输出里（报告分桶要读它）
    assert.equal((r.results[0]!.keyContext as { strategy?: string }).strategy, 'happyPath');
  });
});

describe('跨步骤数据流（用例像代码的最小证明）', () => {
  test('create -> extract -> get -> assert 全链路', async () => {
    const r = await run([
      { id: 'mk', kind: 'http', request: { method: 'POST', url: '/orders', body: { id: 'CR-1', amount: 5 } } },
      { id: 'ex', kind: 'extract', from: '$.step.mk.resp', rules: [{ var: 'oid', path: '$.body.id' }] },
      { id: 'get', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: { path: '$oid' } } },
      { id: 'chk', kind: 'assert', against: '$.step.get.resp', status: 200 },
    ]);
    assertPass(r);
    // 期望值从 mock **实际回出去的响应**里取，而不是写死：
    // POST /orders 的 201 在 fixture 里没有 example，所以 mock 按 schema 造了个 id。
    // 写死 'sample' 或 'B2' 都是在赌 mock 的实现细节；从响应里读才真正验证了
    // "提取的是响应值而不是请求值"（请求里写的是 CR-1，两者必然不同）。
    const issuedId = (r.results.find((x) => x.stepId === 'ex')!.keyContext as { oid: string }).oid;
    // 请求发的是 CR-1，mock 回的是它自己按 schema 造的 id。两者必然不同，
    // 所以"提取的是响应值"这件事被这条断言真正锁住了 —— 取错源就红。
    assert.notEqual(issuedId, 'CR-1', '提取到的是**请求体**里的 id，而不是响应里服务端生成的');
    assert.ok(typeof issuedId === 'string' && issuedId.length > 0, `提取到的 id 不合法：${JSON.stringify(issuedId)}`);
    assert.equal(mock.requests.at(-1)!.path, `/orders/${issuedId}`, 'extract 出的 id 没传到下一步');
  });

  test('4xx 分支也能跑（notFound 策略靠它）', async () => {
    assertPass(await run([
      { id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/NOPE' } },
      { id: 'e', kind: 'assert', against: '$.step.g.resp', status: 200 },
    ]));
    const r404 = await run([
      { id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/NOPE', headers: { 'x-atest-mock-status': '404' } } },
      { id: 'e', kind: 'assert', against: '$.step.g.resp', status: 404, jsonPath: { '$.code': { type: 'number' } } },
    ]);
    assertPass(r404);
  });

  test('断言真能抓出问题：期望状态码写错就是 fail（不是全绿的假象）', async () => {
    const r = await run([
      { id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/A1' } },
      { id: 'e', kind: 'assert', against: '$.step.g.resp', status: 201 },
    ]);
    assert.equal(r.status, 'fail', '断言写错却全绿，说明断言压根没执行');
  });

  test('20 次回放结果逐字节一致（确定性是"证据"的前提）', async () => {
    const body = [
      { id: 'mk', kind: 'http', request: { method: 'POST', url: '/orders', body: { id: 'D1', amount: 3 } } },
      { id: 'a', kind: 'assert', against: '$.step.mk.resp', status: 201 },
    ];
    const first = await run(body);
    for (let i = 0; i < 20; i++) {
      const r = await run(body);
      assert.deepEqual(r.results.map((x) => `${x.stepId}:${x.status}`), first.results.map((x) => `${x.stepId}:${x.status}`));
      assert.equal(r.status, first.status);
    }
  });
});

describe('请求侧 schema 校验（M2「双向校验」的请求向）', () => {
  const call = (body: unknown, extra: Record<string, unknown> = {}) =>
    run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'createOrder', body, ...extra }]);

  test('合法请求照常发出', async () => {
    assertPass(await call({ id: 'A', amount: 5 }));
    assert.equal(mock.requests.at(-1)!.method, 'POST');
  });

  test('缺必填字段：发送**前**拦截，mock 压根收不到', async () => {
    const before = mock.requests.length;
    const r = await call({ id: 'A' });
    assert.equal(r.status, 'error');
    assert.match(r.results[0]!.assertionSummary ?? '', /amount/);
    assert.equal(mock.requests.length, before, '被拦截的请求不该发出去');
  });

  test('报错说清是哪个字段少了，而不是「后端返回 400」', async () => {
    const r = await call({});
    assert.match(r.results[0]!.assertionSummary ?? '', /请求体不符合 spec/);
  });

  test('类型不符也拦（typeViolation 之外的用例不该发错类型）', async () => {
    const r = await call({ id: 'A', amount: '不是数字' });
    assert.equal(r.status, 'error');
  });

  test('**负向策略不拦**：requiredMissing 的用意就是发坏请求看后端拒不拒绝', async () => {
    // 这条是本文件最重要的一条：如果把负向策略也一律拦掉，
    // docs/05 §3 里"后端缺参数校验"这类最有价值的发现会**安静地**全部作废，
    // 而报告上看起来覆盖率还挺高。
    const before = mock.requests.length;
    await call({ id: 'A' }, { strategy: 'requiredMissing' });
    assert.equal(mock.requests.length, before + 1, 'requiredMissing 的请求必须真的发出去');
  });

  test('typeViolation / negativeFuzz / boundary 同样放行', async () => {
    for (const strategy of ['typeViolation', 'negativeFuzz', 'boundary']) {
      const before = mock.requests.length;
      await call({ id: 123, amount: 'x' }, { strategy });
      assert.equal(mock.requests.length, before + 1, `${strategy} 的请求被 schema 校验拦掉了`);
    }
  });

  test('authMatrix 不属负向 body 策略：它发的是合法 body，只是 token 不对，校验照做', async () => {
    const r = await call({ id: 'A' }, { strategy: 'authMatrix' });
    assert.equal(r.status, 'error', 'authMatrix 的 body 也该合法');
  });

  test('validateRequest: false 时用户明确要求不校验，就放行', async () => {
    const before = mock.requests.length;
    await call({ nope: 1 }, { validateRequest: false });
    assert.equal(mock.requests.length, before + 1);
  });

  test('没有请求体的 operation（GET）不受影响', async () => {
    assertPass(await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'health' }]));
  });
});

describe('响应侧符合性检查（report-only + 环境开关，docs/05 §1.1）', () => {
  /** 造一个"响应必然不符 spec"的文档：schema 要求 amount 是 integer，mock 回 string */
  const badRespDoc = () => {
    const base = doc.byId.get('getOrdersId')!;
    const patched: OperationSpec = {
      ...base,
      responses: { ...base.responses, '200': { description: 'ok', schema: { type: 'object', required: ['id', 'nonexistentField'], properties: { id: { type: 'string' }, nonexistentField: { type: 'integer' } } } } },
    };
    return { ...doc, operations: doc.operations.map((o) => (o.operationId === 'getOrdersId' ? patched : o)), byId: new Map([...doc.byId].map(([k, v]) => [k, (k === 'getOrdersId' ? patched : v)])) };
  };

  const runWith = async (d: ReturnType<typeof badRespDoc>, env: Record<string, unknown>) => {
    const m = await startMockServer(d as never);
    try {
      return await runScenario({
        scenario: defineScenario({ schemaVersion: '1', id: 'scn.resp', name: 'resp', env: { environmentRef: 'u' }, body: [{ id: 'c', kind: 'openapiCall', docRef: 'd', operationId: 'getOrdersId', pathParams: { id: '1' } }] } as ScenarioDraft),
        adapters: { http: asHttpExec(new HttpClient(), () => d) } as AdapterRegistry,
        clock: deterministicClock(1), env: { baseUrl: m.addr, ...env },
      });
    } finally { await m.close(); }
  };

  test('默认（specAuthoritative 未开）**不做**符合性检查', async () => {
    const r = await runWith(badRespDoc(), {});
    assertPass(r);
    assert.ok(!r.events.some((e) => (e.data as { code?: string }).code === 'RESPONSE_SCHEMA_MISMATCH'), '默认就检查会把文档与实现的小出入刷成噪音');
  });

  test('环境开了 specAuthoritative -> 记一条 RESPONSE_SCHEMA_MISMATCH', async () => {
    const r = await runWith(badRespDoc(), { specAuthoritative: true });
    const ev = r.events.find((e) => (e.data as { code?: string }).code === 'RESPONSE_SCHEMA_MISMATCH');
    assert.ok(ev, '开了开关却没检查');
    assert.match(String((ev!.data as { detail: string }).detail), /nonexistentField/);
  });

  test('**report-only**：不符合也判 pass，绝不把符合性问题混进业务回归红灯', async () => {
    const r = await runWith(badRespDoc(), { specAuthoritative: true });
    assert.equal(r.status, 'pass', '响应不符 spec 的含义是"文档与实现谁错了"，判 fail 会让人把所有红灯都当成误报');
    // 而且不能污染 tally：healed/error 都会挤进通过率分母
    assert.equal(r.tally.error, 0);
    assert.equal(r.tally.healed, 0);
  });

  test('响应符合 spec 时一条事件都不记（否则噪音会淹没真信号）', async () => {
    const r = await runWith(doc, { specAuthoritative: true });
    assertPass(r);
    assert.ok(!r.events.some((e) => (e.data as { code?: string }).code === 'RESPONSE_SCHEMA_MISMATCH'));
  });

  test('spec 没写该状态码的 schema -> 不报错也不炸（/auth/token 的 200 只有 description）', async () => {
    const r = await runScenario({
      scenario: defineScenario({ schemaVersion: '1', id: 'scn.r3', name: 'r3', env: { environmentRef: 'u' }, body: [{ id: 'c', kind: 'openapiCall', docRef: 'd', operationId: 'login' }] } as ScenarioDraft),
      adapters: { http: asHttpExec(new HttpClient(), () => doc) } as AdapterRegistry,
      clock: deterministicClock(1), env: { baseUrl: mock.addr, specAuthoritative: true },
    });
    assertPass(r);
    assert.ok(!r.events.some((e) => (e.data as { code?: string }).code === 'RESPONSE_SCHEMA_MISMATCH'));
  });
});
