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

  /*
   * 地址里**手写**的占位符（`url: '/users?tag={t}'`）与模板里的占位符是同一件事：
   * `http` 步骤压根没有 pathParams 这个字段，所以它永远填不上。
   *
   * ⚠ 这一条是本轮**补出来的缺陷**，改前的行为是**这一步 pass**：
   * `composeUrl` 只在 path 那半段扫占位符（`fillPath` 只吃 pathPart），
   * 手写 query 段是"原样保留作者写的字节"那一条规则带过去的，于是 `{t}`
   * 一路发到线上，而 mock 回 200 —— 步骤绿灯，测的却是一个字面量 `{t}` 的查询。
   * 与旁边那条"漏填 path 参数"的判据同一条：**占位符不许出现在真实请求里**。
   * 修法在 compose.ts：扫占位符的范围改成整段模板，保留字节的规则不变。
   */
  test('手写 query 段里的占位符也要拦（改前：字面量 {t} 发出去而步骤 pass）', async () => {
    const before = mock.requests.length;
    const r = await run([{ id: 'g', kind: 'http', request: { method: 'GET', url: '/users?tag={t}' } }]);
    assert.equal(r.status, 'error', `占位符没填上却判过了：${r.results[0]!.assertionSummary}`);
    assert.match(r.results[0]!.assertionSummary ?? '', /未填的占位符.*\{t\}/s);
    assert.equal(mock.requests.length, before, '一个字节都不该发出去 —— 发出去的请求里带着字面量 {t}');
  });

  test('手写占位符不因 query 里给了同名而豁免（否则字面量与真值各发一份）', async () => {
    /*
     * 看起来"贴心"的那版实现是：`query: {t:'V'}` 里给了同名，就当填好了。
     * 但手写那段是**原样保留**的（作者写的字节我们不重排也不重编码），
     * 填不进去 —— 真发出去的是 `?tag={t}&t=V`：**字面量与真值各发一份**，
     * 服务端两个键都收到，比一个都不填更难查。所以判据写成"一律报"，
     * 而这一条就是守"别有人回来加那个同名豁免"。
     */
    const before = mock.requests.length;
    const r = await run([{ id: 'g', kind: 'http', request: { method: 'GET', url: '/users?tag={t}', query: { t: 'V' } } }]);
    assert.equal(r.status, 'error', `同名豁免漏进来了：${r.results[0]!.assertionSummary}`);
    assert.equal(mock.requests.length, before);
  });

  test('手写 query 段与参数表的 query 用 & 相接，且手写那段不被重编码', async () => {
    /*
     * 这是 composeUrl 里那段"三分支拼尾巴"的载体（有手写 × 有参数表 / 只有手写 /
     * 只有参数表）。改前引擎用的是 `base.includes('?') ? '&' : '?'`，
     * 收敛到 composeUrl 之后这条能力**必须原样还在**，而它当时没有任何测试钉着 ——
     * 少钉的话，把三分支压成一个嵌套三元、接出 `?a=1?b=2` 也能全绿，
     * 而后端把第二个 `?` 之后整段当成**一个键**。
     * 手写那段里的 `%20` 刻意不重编码：作者写的就是他要的字节（重编码会把它变成 %2520）。
     */
    await run([{ id: 'g', kind: 'http', request: { method: 'GET', url: '/users?tag=a%20b', query: { page: 3 } } }]);
    const seen = mock.requests[mock.requests.length - 1]!;
    // 断的是**原始字节**（mock 记的 `url`），不是 `path` —— `path` 只有 pathname，
    // 拿它断"两段有没有接对"会永远断不到那段 query。
    assert.match(seen.url, /^\/users\?tag=a%20b&page=3$/, `两段没接对：${seen.url}`);
    assert.deepEqual(seen.query.tag, ['a b'], '手写的 %20 要按原意解出空格，不是 %2520');
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

  /*
   * 下面三条把**路径参数的字节**钉在真实链路上。它们原先长在 `mock.ts` 的
   * `buildUrlFor` 上，而那个函数**从来没有生产侧调用者**（`git log -S` 追到首个提交，
   * 它一直是测试自用的 helper），所以那三条断的是**一个没有生产代码会构造的字符串**
   * —— 它们红过、绿过，而真实链路上的编码从头到尾没人看过（本轮实测：
   * `pathParams 具象化到 URL 模板` 用的是 `ORD-77`，一个纯 ASCII，编码与否看不出来）。
   * 挪到这里之后，跑的是 `resolveUrl` + `composeUrl` + fetch + mock 收包这一整套。
   *
   * ⚠ 断言一律看 `seen.url`（mock 记的**原始字节**），不看 `seen.query`/`seen.path` 的
   * 解码结果：`parseQuery` 会解 %XX，于是 `%7C` 与字面量 `|` 解出来是**同一个值**，
   * 拿解码值断"分隔符有没有被编掉"永远断不到。
   */
  test('路径参数里的斜杠被编码后**仍然路由到同一个 operation**', async () => {
    /*
     * 这一条同时管两件事，而第二件是重点：
     *  - 字节：`a/b` 必须是 `a%2Fb`。不编码会多出一整段路径，`/orders/a/b` 是**另一个接口**；
     *  - 路由：编码之后 mock 还得能命中 `/orders/{id}` 并回 200。
     * 只断字节的写法太松 —— 把编码改成把 `/` 删掉也能过字节断言，但那已经不是这个接口了。
     * `mock.ts` 的 matchPath 拿**未解码**的段比，参数段是 `*`，所以 `%2F` 不会劈段；
     * 不编码的话段数变 3，`pat.length !== actual.length` 直接不命中 → 404。
     */
    assertPass(await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: 'a/b' } }]));
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.equal(seen.url, '/orders/a%2Fb', `斜杠没编码就凭空多出一段路径：${seen.url}`);
    assert.equal(seen.path, '/orders/a%2Fb', 'mock 按编码后的段命中，段数没变');
  });

  test('路径参数里的非 ASCII 被编码（服务端按原始字节匹配）', async () => {
    assertPass(await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: '张三' } }]));
    assert.equal(mock.requests[mock.requests.length - 1]!.url, '/orders/%E5%BC%A0%E4%B8%89');
  });

  test('查询段：元素里的 `&` 必须编，而 style 分隔符留字面量', async () => {
    /*
     * 改前 `mock.ts` 内联那一份对同一个值发的是 `?q=a%26b%7Cc`（把 `|` 也编掉了）。
     * 两个方向都要钉：`&` 不编会**把一个参数劈成两个**（第二个键是垃圾），
     * `|` 编掉则后端收到一个名叫 q、值为 `a&b|c` 的**单**参数，
     * 而规范表里那是两个值 —— 后端多半照旧回 200，于是用例绿灯跑着另一个查询。
     */
    assertPass(await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'listUsers', queryParams: { q: ['a&b', 'c'], page: 2 } }]));
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.equal(seen.url, '/users?q=a%26b|c&page=2', `分隔符或元素编错了：${seen.url}`);
    assert.deepEqual(seen.query.q, ['a&b|c'], '解码后是一个含分隔符的值（分隔符是字面量这一事实的旁证）');
  });

  test('baseUrl 带尾斜杠时不拼出双斜杠（真实链路：resolveUrl 那一层）', async () => {
    /*
     * `buildUrlFor` 上原先有一条同样的断言，而它测的是**没人走的**那一份拼接。
     * 生产侧的拼接在 `engine/interpreter.ts` 的 `resolveUrl`，它有两处调用点、
     * 覆盖 http 与 openapiCall 两种步骤。
     *
     * ⚠ 这里原本写的是"改前**没有任何一条测试断过**拼出来的绝对 URL 长什么样"，
     * 那是 over-claim（在 HEAD 的工作树里 grep 过：`auth.test.ts` 有两条断的是
     * **鉴权层自己改过**的绝对 URL —— 一个断 `r.url`、一个断 `a.url`，
     * 两者都发生在 adapter 内部，baseUrl 怎么拼进去的它们看不见）。
     * 量下来成立的判据更窄，但也正是这一格：**HEAD 上没有任何一个测试文件里
     * 存在同时含 `sent` 与 `url` 的行**（逐文件 `git show HEAD:<f> | grep sent | grep url`，
     * 全部为空 —— 这个判据比"断 `sent[i].url`"更宽，它连读取后转手断言的写法也一起排除了）。
     * 所以这条仍是净新增覆盖面，不是搬家 —— 只是净新增的是"baseUrl→最终 URL"
     * 这一格，不是"绝对 URL 从没人看过"。
     *
     * 双斜杠不是洁癖问题：`//orders/A1` 是**协议相对 URL**，
     * 交给 fetch 会打到 `orders` 这个域名上（或报 Invalid URL），
     * 而用例里写的明明是自己配好的 baseUrl。
     */
    for (const base of [mock.addr, `${mock.addr}/`]) {
      assertPass(await runAt(base, [{ id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/A1' } }]));
      const seen = mock.requests[mock.requests.length - 1]!;
      assert.equal(seen.path, '/orders/A1', `baseUrl="${base}" 拼错了：路径收到 ${seen.path}`);
    }
  });

  test('baseUrl 带**两个**尾斜杠时也只去掉多余的那些（两个消费者曾经不一致）', async () => {
    /*
     * 为什么单列一条：`resolveUrl` 去的是 `/\/$/`（**只去一个**），
     * `auth-check` 去的是 `/\/+$/`（去全部）。一个尾斜杠时两者输出相同，
     * 所以上面那条**测不出这个分叉** —— 它只喂了单斜杠。
     * 实测 `baseUrl: 'http://h//'` 时引擎打 `http://h//orders/A1`（路径里留一个空段，
     * 多数路由下那是另一个路径，会 404），而 auth-check 打 `http://h/orders/A1`。
     * **两边各自都"对"**，而同一个接口在两条命令里是两个地址 ——
     * 现象会是"auth-check 说没问题，跑起来 404"，而这两条命令看起来都没错。
     * 现在两处都走 `joinBaseUrl`，这一条钉住取的是"去全部"那一侧。
     */
    assertPass(await runAt(`${mock.addr}//`, [{ id: 'g', kind: 'http', request: { method: 'GET', url: '/orders/A1' } }]));
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.equal(seen.path, '/orders/A1', `两个尾斜杠只去掉了一个，路径里留着空段：${seen.path}`);
  });

  test('baseUrl 带尾斜杠时 openapiCall 也一样（两处调用点共用 resolveUrl，别只测一处）', async () => {
    assertPass(await runAt(`${mock.addr}/`, [
      { id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: 'A1' } },
    ]));
    assert.equal(mock.requests[mock.requests.length - 1]!.path, '/orders/A1');
  });

  /*
   * 这个夹具同时踩中**两个**错：模板要 `{id}` 而表里给的是 `userID`
   * —— 于是"没填上 id"（missing）与"给了个不存在的名字"（unknown）是**同一个笔误**的两面。
   *
   * ⚠ 这里原先只断言 unknown 那半句，而改前的代码确实只报那一半（它先逐个替换
   * 占位符、撞上不认识的名字就 return，所以"剩下的 `{id}`"那条检查根本走不到）。
   * 统一走 composeUrl 之后 missing 先 return，于是这条测试红了 ——
   * **两个方向都比"只报一个"糟**：报 missing 的人去补 `id`（留下一个没用的键），
   * 报 unknown 的人去删 `userID`（留下一个没填的占位符），两种改法都能让这一步不再报错，
   * 而请求照样是坏的。所以两条**一起说**：判据是两条独立的，一条都不能被另一条挤掉。
   */
  test('pathParams 写了不存在的名字 -> error，不静默忽略', async () => {
    const r = await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { userID: '1' } }]);
    assert.equal(r.status, 'error');
    const msg = r.results[0]!.assertionSummary ?? '';
    assert.match(msg, /pathParams 里的 "userID"/, '错名字要说得出（静默忽略 = "参数没生效而请求照样 200"）');
    assert.match(msg, /未填的参数：\{id\}/, '同一个笔误的另一半也要说，否则人只会修一半');
    /*
     * 第三句「多半是同一个名字写错了两边 —— 改名，而不是补一个键或删一个键」是
     * **这一格真正的防错设计**：前两句各自都指向一个"能让这一步不再报错"的错修法
     * （补一个键 / 删一个键），只有这句说的是对修法。
     *
     * ⚠ 它一开始只写在实现里、**没有载体**，而这是本轮用变异量出来的而不是想到的：
     * 把 `both` 改成恒 false（等于删掉这句）跑一遍 `npm run mutate`，那一条判 caught=否；
     * 再把下面那条正向断言拿掉、整个 `npm test` 重跑一遍，**没有任何一条行为测试红**
     * （红的只有 mutate 自己那条"锚点必须在工作区出现"的自检，而它红是因为临时变异
     *  把 url-compose.json 自己的锚点破坏了，与这句文案无关）。
     * 也就是说这句后来被人删掉也不会有任何一层会报 —— 这正是 docs/08 §3(e)
     * 「有生产者、没有载体」那一格在**报错文案**上的形态：文案由代码产、由人读，
     * 而中间那层"有没有人守着它"是空的。
     *
     * 判据是"两边同时非空"，所以反向由下面那条只有一个错的用例负责：不许退化成无条件后缀。
     */
    assert.match(msg, /同一个名字写错了两边/, '两边同时错时要说清"改名"，否则两条各自都指向一个错修法');
  });

  test('只有 unknown 一个错时，不加"两边同时出现"那句（判据不是无条件后缀）', async () => {
    // id 填对了、另外多给一个 userID：只有 unknown 非空。
    // 这时候那句"同一个名字写错了两边"是**假话**（并没有哪个名字两边写错），
    // 而假话的代价是作者照着它去改名，改完还是坏的。
    const r = await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: 'A1', userID: '1' } }]);
    assert.equal(r.status, 'error');
    const msg = r.results[0]!.assertionSummary ?? '';
    assert.match(msg, /pathParams 里的 "userID"/);
    assert.doesNotMatch(msg, /同一个名字写错了两边/, `只有一个错却说了"两边"：${msg}`);
    assert.doesNotMatch(msg, /未填的参数/, '填对了就不该出现在报错里');
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
    /*
     * ⚠ **这一条原先是假的，而且是本仓 docs/08 §3 记过的那个形状**（"fixture 让两种
     * 不同实现算出同一个值"）：改前喂的是字符串 `'a|b'`，而字符串在**两种实现下都
     * 原样变成 `q=a|b`** —— 按 spec style 走是这样，用 `URLSearchParams` 手拼也是这样。
     * 于是标题写着"走 spec 声明的 style"，断言却与 style 无关，**改前改后都绿**。
     * 那行注释当时也确实承认了缺口（"openapiCall 的 query 目前没按 spec 的 style 走"），
     * 但一条恒真的测试配一句承认缺口的注释，比一条会红的测试更容易让缺口活下来 ——
     * 因为看板上它是绿的。
     *
     * 换成**数组**才分得开两种实现（fixture 里 `/users` 的 `q` 正是
     * `array<string>` + `pipeDelimited` + `explode:false`）：
     *  - 按 spec：`q=a|b`
     *  - 手拼（改前）：`q=%5B%22a%22%2C%22b%22%5D` —— 整个 JSON 数组当一个值发出去，
     *    后端按 `|` 切分只切出一个带方括号引号的垃圾值，而它照回 200。
     */
    await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'listUsers', queryParams: { q: ['a', 'b'] } }]);
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.deepEqual(seen.query.q, ['a|b'], `spec 声明 pipeDelimited+explode=false，mock 收到的却是 ${JSON.stringify(seen.query.q)}（原始 URL ${seen.url}）`);
  });

  test('数组查询参数不许被 JSON 化成一个值（IR 里写数组是合法的）', async () => {
    /*
     * 这一条守的是**上一条守不到的那一半**。上一条的期望 `['a|b']` 里只有一个键；
     * 而 IR 的 `queryParams` 是 `record(string, Value)`，`Value` 允许数组，
     * 数组在未声明 style 的参数上（fixture 里 `/users` 的 path 级 `page` 之外，
     * 还有 `q` 在 path 级是 string、被 operation 级覆盖前那种）默认按
     * `form + explode=true` 展开成**重复键** —— 这是规范表 5.1 第一格。
     * 手拼那条路给出的是 `?tag=%5B%22a%22%2C%22b%22%5D`，一个值；
     * 按规范走给出的是两个值。判据直接取 mock 解出来的**值数组长度**，
     * 不比较字节 —— 编码细节由 style.test.ts 那一大表守，这里只判"分成了几个参数"。
     */
    await run([{ id: 'c', kind: 'openapiCall', docRef: 'shop', operationId: 'listUsers', queryParams: { page: [1, 2] } }]);
    const seen = mock.requests[mock.requests.length - 1]!;
    assert.deepEqual(seen.query.page, ['1', '2'], `数组该展开成重复键，实际收到 ${JSON.stringify(seen.query.page)}（原始 URL ${seen.url}）`);
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
