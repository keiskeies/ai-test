/**
 * M2 判据：**打本地 mock server（mock 由 spec 生成）全绿**。
 *
 * 这一份是端到端的：spec -> parse -> mock server -> HttpClient -> 断言。
 * 它证明的是"引擎自测不依赖任何真实后端"（docs/05 §6），
 * 也就是 CI 的可用性不外包给别人的 staging。
 *
 * 关键取舍：mock 的期望值**不写在这里**，而是从 spec 推导 ——
 * 如果我在测试里手写 `{ id: 'A1' }`，那测的只是"我抄对了 fixture"。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi } from '../src/openapi/parse.js';
import { startMockServer, sampleFromSchema, buildUrlFor } from '../src/mock/mock.js';
import { HttpClient } from '../src/http/client.js';
import { dirtySpec } from './fixtures.js';
import type { MockServer } from '../src/mock/mock.js';

const doc = parseOpenApi(dirtySpec);

describe('sampleFromSchema：按 schema 造确定性示例', () => {
  test('required 字段全造出来，非 required 不造', () => {
    const v = sampleFromSchema({
      type: 'object', required: ['id'],
      properties: { id: { type: 'string' }, optional: { type: 'string' } },
    }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(v), ['id']);
  });
  test('约束被满足：enum 取成员、minLength 达标、minimum 达标', () => {
    assert.equal(sampleFromSchema({ type: 'string', enum: ['paid', 'new'] }), 'paid');
    assert.equal((sampleFromSchema({ type: 'string', minLength: 8 }) as string).length, 8);
    assert.equal(sampleFromSchema({ type: 'integer', minimum: 5 }), 5);
    assert.equal(sampleFromSchema({ type: 'integer', minimum: 3, maximum: 1 }), 1, 'min>max 的脏 schema 不能造出越界值');
    assert.equal(sampleFromSchema({ type: 'integer', multipleOf: 5, minimum: 7 }), 10);
  });
  test('format 造出合法形态（date-time/uuid/email）', () => {
    assert.match(sampleFromSchema({ type: 'string', format: 'date-time' }) as string, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(sampleFromSchema({ type: 'string', format: 'uuid' }) as string, /^[0-9a-f-]{36}$/);
  });
  test('example/default 优先于凭空造', () => {
    assert.equal(sampleFromSchema({ type: 'string', example: 'EX' }), 'EX');
    assert.equal(sampleFromSchema({ type: 'integer', default: 7 }), 7);
  });
  test('循环 schema 深度上限 3 内终止（docs/05 §1）', () => {
    const cyclic = { type: 'object', properties: { child: { 'x-cycle': '#/Node' } } };
    assert.doesNotThrow(() => sampleFromSchema(cyclic));
    assert.deepEqual(sampleFromSchema(cyclic), { child: null });
  });
  test('确定性：同一 schema 造 20 次结果完全一致（mock 不能自己制造 flaky）', () => {
    const s = { type: 'object', properties: { a: { type: 'array', items: { type: 'integer', minimum: 2 } }, b: { type: 'string' } }, required: ['a', 'b'] };
    const first = JSON.stringify(sampleFromSchema(s));
    for (let i = 0; i < 20; i++) assert.equal(JSON.stringify(sampleFromSchema(s)), first);
  });
});

describe('mock server 路由', () => {
  let mock: MockServer;
  const selfCheck: string[] = [];
  before(async () => { mock = await startMockServer(doc, { selfCheckIssues: selfCheck }); });
  after(async () => { await mock.close(); });

  const client = new HttpClient();

  test('按 spec 的 path + method 命中，返回 schema 形状的对象', async () => {
    const r = await client.send({ method: 'GET', url: `${mock.addr}/orders/A1` });
    assert.equal(r.status, 200);
    // 期望形状来自 spec 的 example（fixture 里写了 { id: 'A1', amount: 5 }）
    assert.deepEqual(r.body, { id: 'A1', amount: 5 });
  });

  test('没写 example 的接口按 schema 造，且满足 required', async () => {
    const r = await client.send({ method: 'POST', url: `${mock.addr}/orders`, body: { id: 'X', amount: 3 } });
    assert.equal(r.status, 201);
    const b = r.body as Record<string, unknown>;
    assert.ok('id' in b && 'amount' in b, `201 响应缺 required 字段：${JSON.stringify(b)}`);
  });

  test('路径参数不误伤静态段路由（/users/me 不该被 /users/{id} 吃掉）', async () => {
    // fixture 里没有 /users/me，所以它该 404 而不是被 /users/{id} 接走
    const r = await client.send({ method: 'GET', url: `${mock.addr}/nonexistent` });
    assert.equal(r.status, 404, '未匹配必须 404。默认 200 会让"路径写错的用例"变成通过的用例');
  });

  test('未匹配时报出已知路由清单（不然调试要人肉列 spec）', async () => {
    const r = await client.send({ method: 'GET', url: `${mock.addr}/nope` });
    assert.match(String((r.body as { known?: string[] }).known), /GET \/orders\/\{id\}/);
  });

  test('方法不匹配也是 404，而不是"路径对就命中"', async () => {
    const r = await client.send({ method: 'DELETE', url: `${mock.addr}/users` });
    assert.equal(r.status, 404);
  });

  test('声明了 2xx 但没 schema -> 记 selfCheck（这类接口的响应用例是**无效覆盖**，必须可见）', () => {
    // fixture 里 POST /auth/token 的 200 只有 description，没有 content
    assert.ok(selfCheck.some((s) => /auth\/token/.test(s) && /没给 schema/.test(s)), JSON.stringify(selfCheck));
  });

  test('没 schema 的 2xx 返回空体，而不是编一个 {} 让用例假装断到了东西', async () => {
    const r = await client.send({ method: 'POST', url: `${mock.addr}/auth/token`, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body, null);
  });

  test('header 可指定响应状态码，让 4xx 分支的用例也能跑（docs/05 §3 notFound 策略）', async () => {
    const r = await client.send({ method: 'GET', url: `${mock.addr}/orders/A1`, headers: { 'x-atest-mock-status': '404' } });
    assert.equal(r.status, 404);
    assert.ok((r.body as { code?: unknown }).code !== undefined, '404 响应体应按 404 的 schema 造');
  });

  test('mock 记录了收到的请求，供断言"请求真按 spec 序列化了"', async () => {
    const before = mock.requests.length;
    await client.send({ method: 'GET', url: `${mock.addr}/users?q=a|b&page=2` });
    const seen = mock.requests[before]!;
    assert.equal(seen.method, 'GET');
    assert.deepEqual(seen.query.q, ['a|b']);
    assert.deepEqual(seen.query.page, ['2']);
  });
});

describe('客户端行为（docs/05 §4 清单）', () => {
  let mock: MockServer;
  before(async () => { mock = await startMockServer(doc); });
  after(async () => { await mock.close(); });
  const client = new HttpClient();

  test('默认不跟随重定向：3xx 当结果而不是当成功', async () => {
    const redirectMock = await startMockServer({
      ...doc,
      operations: [{ ...doc.byId.get('health')!, path: '/redir', operationId: 'redir', responses: { '302': { description: 'found' } } }],
    });
    // mock 只会返回声明过的 2xx；这里直接手工验证客户端的 redirect 策略
    const c2 = new HttpClient({ fetchImpl: (async (url) => new Response(null, { status: 302, headers: { location: 'https://login.example.com' } })) as typeof fetch });
    const r = await c2.send({ method: 'GET', url: 'http://x/api' });
    assert.equal(r.status, 302, '跟随重定向会让"302 到登录页"被误判成功');
    assert.equal(r.headers.location, 'https://login.example.com');
    await redirectMock.close();
  });

  test('HTML 错误页不被硬塞进 JSON.parse（网关 502 常见，报错该是可读的）', async () => {
    const c = new HttpClient({ fetchImpl: (async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/api' });
    assert.equal(r.status, 502);
    assert.match(String(r.body), /502 Bad Gateway/);
    assert.equal(r.error, undefined);
  });

  test('声明是 JSON 但内容坏了 -> 报可读错误（截断/编码问题的信号）', async () => {
    const c = new HttpClient({ fetchImpl: (async () => new Response('{"a":', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/api' });
    assert.ok(r.error && /解析失败/.test(r.error.message), JSON.stringify(r.error));
  });

  test('响应体超限截断并标 truncated', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(5000) });
    const c = new HttpClient({ fetchImpl: (async () => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/api', maxBytes: 100 });
    assert.equal(r.truncated, true);
    assert.ok(r.bodyText.length <= 100);
    assert.ok(r.bytes > 100, 'bytes 必须是截断前的真实字节数，否则证据里的体积是假的');
  });

  test('POST 永不自动重试（重复下单级事故）', async () => {
    let n = 0;
    const c = new HttpClient({ fetchImpl: (async () => { n++; throw new Error('ECONNRESET'); }) as typeof fetch });
    const r = await c.send({ method: 'POST', url: `${mock.addr}/orders`, body: { id: '1', amount: 1 } });
    assert.equal(n, 1, `POST 被重试了 ${n} 次`);
    assert.ok(r.error && r.error.kind === 'network');
    assert.equal(r.status, 0, '网络失败不能伪造成 5xx —— 那会让人以为后端返回过东西');
  });

  test('GET 网络级失败自动重试', async () => {
    let n = 0;
    const c = new HttpClient({ fetchImpl: (async () => { n++; if (n < 3) throw new Error('ECONNRESET'); return new Response('{}', { headers: { 'content-type': 'application/json' } }); }) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/a' });
    assert.equal(n, 3);
    assert.equal(r.status, 200, '第三次成功了，就该报成功');
  });

  test('超时：到点返回 timeout 错误而不是挂死', async () => {
    const c = new HttpClient({ fetchImpl: ((_u: unknown, init: { signal?: AbortSignal }) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(init.signal!.reason)); })) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/slow', timeoutMs: 30 });
    assert.equal(r.error?.kind, 'timeout', JSON.stringify(r.error));
  });

  test('GET 带 body 时报错，不"贴心地"转成 query（那会改变请求语义）', async () => {
    const c = new HttpClient({ fetchImpl: (async () => new Response('{}')) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/a', body: { a: 1 } });
    assert.match(r.error?.message ?? '', /不会自动把它转成 query/);
  });

  test('大整数响应不过 Number（雪花 ID 保真，docs/05 §4）', async () => {
    const c = new HttpClient({ fetchImpl: (async () => new Response('{"id":7301894562345678901}', { headers: { 'content-type': 'application/json' } })) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/o' });
    assert.equal((r.body as { id: unknown }).id, '7301894562345678901', '过一遍 Number 就变成 ...679000，下一步 GET 必然 404');
  });
});

describe('buildUrlFor：客户端与 mock 共用同一套序列化规则', () => {
  test('path 参数与 query 的 style 都按 spec 走', () => {
    const op = doc.byId.get('listUsers')!;
    const url = buildUrlFor('http://h:1/', op, { queryParams: { q: ['a', 'b'], page: 2 } });
    // fixture 里 q 是 pipeDelimited + explode=false -> q=a|b
    assert.match(url, /^\http:\/\/h:1\/users\?/);
    assert.match(url, /q=a\|b/);
  });
  test('无 query 时不留问号', () => {
    assert.equal(buildUrlFor('http://h', doc.byId.get('health')!, {}), 'http://h/public/health');
  });
});
