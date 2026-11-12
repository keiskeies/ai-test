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
import { startMockServer, sampleFromSchema } from '../src/mock/mock.js';
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

/*
 * mock **不能被用例里的一个坏字节打死**。
 *
 * 这一组是新加的，因为它守的是一件本轮才量出来的事：`handle` 是 async 而它被
 * `void handle(...)` 调，所以它抛出的任何东西都是一个没人接的 Promise ——
 * 表现不是"这条用例红"，而是**一个字节都不回、客户端一直挂到超时**，
 * 最后报成 `HTTP 请求失败：timeout`。改前两条真实可达的输入：
 *  - `url: '/orders/A1?x=100%'`：`decodeURIComponent('100%')` 抛 URIError（实测 30044ms 挂死）；
 *  - header `x-atest-mock-status: 000`：过了 `/^\d{3}$/` 却 `writeHead(0)` 抛
 *    ERR_HTTP_INVALID_STATUS_CODE（实测挂死）。
 * 两处都不是"平台写的值"，是**用例作者手写的值**，所以一定会再发生。
 *
 * ⚠ 这一组的断言刻意全部是"**多久之内、拿到什么**"而不是"不抛"：
 * 判据若是 `assert.doesNotThrow`，那么"改了实现但还是会挂"这一种回归**测不出来**，
 * 而挂死恰恰是这两种输入的原始症状。
 */
describe('mock 面对坏输入也要回一个响应（不能把错报成 timeout）', () => {
  let mock: MockServer;
  before(async () => { mock = await startMockServer(doc); });
  after(async () => { await mock.close(); });
  const client = new HttpClient({ defaultTimeoutMs: 3000 });

  test('URL 里带不合法的百分号转义：照旧拿到响应，而不是挂到超时', async () => {
    /*
     * `100%` 少两位十六进制 —— 手写"百分比"这类值时极易写出。
     * 期望值不是"报一个漂亮的错"，而是**跟真实后端一样**：不合法就按字面留着。
     * 实测 node 自己的 `querystring.parse`、WHATWG 的 `URLSearchParams`、
     * Express 底下的 qs 三者都不抛（`parse('x=100%')` 给 `{x:'100%'}`），
     * 所以"mock 抛、后端不抛"是 mock 单方面制造的分歧。
     */
    const r = await client.send({ method: 'GET', url: `${mock.addr}/orders/A1?x=100%` });
    assert.equal(r.error, undefined, `挂死或报错都说明解码没兜住：${r.error?.message}`);
    assert.equal(r.status, 200);
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.deepEqual(seen.query.x, ['100%'], '不合法的转义按字面留着，与后端一致');
  });

  test('裸 `+` 在 query 里解成空格（与所有 form 解析器一致）', async () => {
    /*
     * 平台自己发的查询串里**永远不会有裸 `+`**（`style.ts` 的 `encQ` 把它编成 `%2B`），
     * 所以裸 `+` 只可能来自手写的 url。改前那一份把 `+` 原样留着，而任何真实
     * form 解析器都把它读成空格 —— 于是"手写的 url"这一格里 mock 与后端看到的值不同，
     * 用例在 mock 上绿、到真后端上查的是另一个值。
     */
    await client.send({ method: 'GET', url: `${mock.addr}/orders/A1?q=a+b` });
    assert.deepEqual(mock.requests[mock.requests.length - 1]!.query.q, ['a b']);
  });

  test('重复键仍然解成两个值（换解码器不能把重复键吃掉）', async () => {
    await client.send({ method: 'GET', url: `${mock.addr}/orders/A1?id=1&id=2` });
    assert.deepEqual(mock.requests[mock.requests.length - 1]!.query.id, ['1', '2']);
  });

  test('`?__proto__=x` 要**记成一个键**，而不是改掉那个对象的 prototype', async () => {
    /*
     * 这不是理论形状：`decode` 之后的键直接进 `requests[].query`，而用例就断在那里。
     * `out[k] = ...` 那种写法对 `__proto__` 走的是 setter —— 实测 `Object.keys` 是空的、
     * `getPrototypeOf(out)` 变成一个数组。于是请求里明明带了 `__proto__=x`，
     * 而**记到的那个键不存在**：断"这个参数没收到"的用例就此变绿。
     * 谎报"没收到"比崩掉糟得多 —— 崩了有人会查，绿着没人查。
     */
    await client.send({ method: 'GET', url: `${mock.addr}/orders/A1?__proto__=x` });
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.ok(Object.prototype.hasOwnProperty.call(seen.query, '__proto__'), '请求里带了这个键，就必须记下来');
    assert.deepEqual(seen.query.__proto__, ['x']);
    assert.equal(Object.getPrototypeOf(seen.query), Object.prototype, '一个请求不许改对象的 prototype');
  });

  test('普通 query 仍然等于一个普通字面量（防"为了 __proto__ 把原型换掉"那种修法）', async () => {
    /*
     * 避开 `__proto__` 的另一条常见写法是 `Object.create(null)`，
     * 而那会让 `deepEqual(seen.query, { q: ['a'] })` **因为原型不同而红** ——
     * 于是所有人被迫改断言写法。这一条就是钉"别用那招"。
     */
    await client.send({ method: 'GET', url: `${mock.addr}/orders/A1?q=a` });
    assert.deepEqual(mock.requests[mock.requests.length - 1]!.query, { q: ['a'] });
  });

  for (const bad of ['000', '100', '199']) {
    test(`header 指定不可用的状态码 ${bad}：回 400 说清哪个值，而不是让 writeHead 抛`, async () => {
      /*
       * 三个数都过改前那道 `/^\d{3}$/`，而两种坏法不同（都实测过）：
       * `000` 走到 `writeHead(0)` → **抛** `ERR_HTTP_INVALID_STATUS_CODE`，
       * 抛进没人接的 void → 一个字节都不回；
       * `100`/`199` 是 1xx，`writeHead` **不抛**，客户端却**永远等不到最终响应**
       * （raw 客户端实测两者各挂满 700ms 无响应）。后者更难查：一层错都不报。
       */
      const r = await client.send({ method: 'GET', url: `${mock.addr}/public/health`, headers: { 'x-atest-mock-status': bad } });
      assert.equal(r.status, 400, `不可用的状态码必须在这一格拦下：实得 ${r.status}`);
      const b = r.body as { error?: string; value?: string };
      assert.equal(b.error, 'bad_mock_status');
      assert.equal(b.value, bad, '要把作者写的那个值原样说出来，否则他还得回去数一遍 header');
    });
  }

  test('四位的 header 也拦，而不是当"没写这个 header"（改前：静默忽略 → 回默认 2xx = 假绿）', async () => {
    /*
     * `1000` 与 `000` 的坏法**不同**，所以它得单独一条：
     *  - `000` 过了 `/^\d{3}$/`，走到 `writeHead(0)` 抛 → 挂死（上面那条管）；
     *  - `1000` 过不了 `/^\d{3}$/`，于是改前的代码把整个 header **当作没写**，
     *    回默认的 2xx。实测改前拿到的就是 200。
     * 后者比挂死更危险：用例断"这个接口该报错"，拿到一个漂亮的 200，
     * 于是它绿着测了一件**根本没发生**的事（docs/08 §3 的最贵的一种绿）。
     *
     * ⚠ 我一开始把这条的理由写成"`writeHead(1000)` 会被静默截断成 200"，**那是错的**：
     * 实测 `writeHead(1000)` 和 `writeHead(0)` 一样老实抛 `ERR_HTTP_INVALID_STATUS_CODE`。
     * 症状（1000 → 200）是真的，成因记错了地方 —— 记错的话下一个读代码的人会去防 writeHead
     * 而漏掉真正的宽判据。这条断言的价值因此是"拦在进 writeHead **之前**"，
     * 与它是抛还是被忽略无关。
     */
    const r = await client.send({ method: 'GET', url: `${mock.addr}/public/health`, headers: { 'x-atest-mock-status': '1000' } });
    assert.equal(r.status, 400, `四位数被当作"没写这个 header"了（那会回默认 2xx，一条该红的用例就此变绿）：实得 ${r.status}`);
    assert.equal((r.body as { value?: string }).value, '1000');
  });

  test('合法的状态码照旧可用（这一组别把正路一起拦死）', async () => {
    const r = await client.send({ method: 'GET', url: `${mock.addr}/orders/A1`, headers: { 'x-atest-mock-status': '404' } });
    assert.equal(r.status, 404);
  });
});

describe('兜底层：handle 里抛出任何东西时，也要回一个 500 而不是挂死', () => {
  /*
   * 这一条不是为了测 500，是为了让 `void handle(...).catch(...)` 那层兜底
   * **有一个人看着**。先把话说清：本轮拿九个 wire 级输入去试
   * （孤立代理项 `%ED%A0%80` 分别放在值上/键上/路径上、空键、`&&&`、`%25`、`%00`、
   * CRLF 注入、3000 个键的超长 query），**一个都抛不出来了** —— 前两处根因修掉之后，
   * 解码这一路已经打不到 throw。（超长 query 那格回 431，那是 node 自己的
   * http server 在 `handle` **之前**就拒了，与这层兜底无关，所以它不算载体。）
   *
   * 所以这层兜底守的**不是**任意字节，而是**程序内构造的 ParsedDoc**：
   * 本仓的测试、以及任何拿 `parseOpenApi` 的结果再改一手的调用方都会这么构造，
   * 而 `handle` 里有两处 `JSON.stringify`，一个自引用的 example 就够它抛
   * `TypeError: Converting circular structure to JSON`（实测 22ms 回 500，
   * 而**去掉兜底**时同一格是 3000ms 读到 timeout）。
   *
   * ⚠ 这条测试**不是**在说"循环 example 是正常用法"，它也不是 JSON spec 写得出来的形状。
   * 它是这层兜底目前**唯一可达**的入口。留着它的理由是 docs/08 §3 那一族：
   * 一个没有载体的分支看起来像没写，下一个来清理的人会把它删掉；
   * 而这层兜底防的恰恰是"下一次有人往 handle 里加了一行会抛的代码" ——
   * 那一次不会先来改这条测试。
   */
  test('handle 内部抛异常 -> 500 里带着成因，而不是让客户端读到 timeout', async () => {
    const circ: Record<string, unknown> = { id: 'A1' };
    circ['self'] = circ; // 自引用：JSON.stringify 必抛
    const badDoc = {
      ...doc,
      operations: doc.operations.map((op) =>
        op.path === '/orders/{id}' ? { ...op, examples: { ...op.examples, '200': circ } } : op,
      ),
    };
    const m = await startMockServer(badDoc);
    try {
      const r = await new HttpClient({ defaultTimeoutMs: 3000 }).send({ method: 'GET', url: `${m.addr}/orders/A1` });
      assert.equal(r.error, undefined, `兜底没接住的话，这里读到的是 timeout：${r.error?.message}`);
      assert.equal(r.status, 500);
      const b = r.body as { error?: string; message?: string };
      assert.equal(b.error, 'mock_internal_error');
      assert.match(String(b.message), /circular/, '要把抛的东西原样带出来，否则读到的还是"一个 500，不知道为什么"');
    } finally { await m.close(); }
  });
});

describe('unmatchedStatus 配错时**起服务就抛**（不留到某个请求里挂死）', () => {
  for (const bad of [0, 100, 1.5, 1000]) {
    test(`unmatchedStatus=${bad} -> 构造期 RangeError`, async () => {
      await assert.rejects(() => startMockServer(doc, { unmatchedStatus: bad }), RangeError);
    });
  }
  test('合法值照常起服务', async () => {
    const m = await startMockServer(doc, { unmatchedStatus: 418 });
    try {
      const r = await new HttpClient().send({ method: 'GET', url: `${m.addr}/nope` });
      assert.equal(r.status, 418);
    } finally { await m.close(); }
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

  test('GET 网络级失败**这一层也不重试**：次数只在引擎那一处定', async () => {
    /*
     * 这条以前断言的是 n===3（本层偷偷重试 2 次），而那是**两层叠乘**的另一半：
     * 引擎的 withRetry 在外面，于是 IR 写 `retry:{count:0}`（明确不要重试）时
     * 实测仍发 3 次 fetch，写 `count:2` 时发 9 次（3×3）。
     * 压测里这意味着吞吐曲线是真实负载的 3 倍，而且**报告里看不出来** ——
     * results 只有引擎那 3 行，本层那 6 次请求在哪个数字里都不在。
     *
     * docs/05 §4 那条"幂等 + 网络级才自动重试"的**边界没变**，变的是**归谁**：
     * 幂等判据在 engine 的 resendsSafely，次数在 IR 的 retry.count，
     * 于是"重不重试、几次"在 IR 里看得见、在报告里数得出（keyContext.flakyOf）。
     * 已同步改写 docs/05 §4 那一行，免得下一个人照着"自动重试"再在本层加一次。
     */
    let n = 0;
    const c = new HttpClient({ fetchImpl: (async () => { n++; if (n < 3) throw new Error('ECONNRESET'); return new Response('{}', { headers: { 'content-type': 'application/json' } }); }) as typeof fetch });
    const r = await c.send({ method: 'GET', url: 'http://x/a' });
    assert.equal(n, 1, '一次 send 就是一次 fetch。要重试请在 IR 上写 retry.count');
    assert.equal(r.error?.kind, 'network', '失败要原样带出分类，让引擎决定重不重试');
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

/*
 * 这里**曾经有一整个 describe**，标题写着「客户端与 mock 共用同一套序列化规则」。
 * 那句话在它存在的大部分时间里是假的：`mock.ts` 里那份 `buildUrlFor` 把 styleParam
 * 的结果内联抄了一遍，路径段**一个字节都不编**（`{id}=a/b` 发出 `/orders/a/b`，
 * 多出一整段路径），查询段却改用 `encodeURIComponent`，于是连规范里该留字面量的 `,`
 * 也被编成 `%2C` —— 同一份文件里同时犯"该编的没编"和"不该编的编了"两个**相反方向**的错。
 * 逐字节对比的实测结果记在 `openapi/compose.ts` 文件头那张分叉表里。
 *
 * 本轮把这个 describe 连同 `buildUrlFor` 一起删了，而**不是因为断言写错了** ——
 * 四条断言的期望值全对。删它的理由是它们接的是一根没通电的线：`buildUrlFor`
 * 从首个提交起就没有生产侧调用者（`git log -S` 追过），mock server 按路径段匹配请求、
 * 自己不组成 URL。四条"会红会绿"的断言因此**不构成任何覆盖面**，
 * 而它们的存在会让下一个来查"路径编码有没有人守"的人搜一眼就走开。
 * 这是 docs/08 §3 那族里最费钱的一种：登记文本描述错字段 / 测试标题描述没发生的事，
 * 与"有载体、没有生产者"叠在一起。
 *
 * 四条断言已逐个搬到真有生产代码走的路径上：
 *  - 按 spec 查 style、`?` 的四格接法 → `test/compose.test.ts`（直接断 `composeUrl` 返回值）；
 *  - 路径编码、查询分隔符、baseUrl 拼接 → `test/engine-e2e.test.ts`（断 mock 收到的**原始字节**）。
 * `mock.test.ts` 从这里开始只测 mock 自己那部分：路由、造数据、坏输入下也要回响应。
 */
