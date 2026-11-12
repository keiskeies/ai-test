/**
 * 会话 cookie 的**装配那一格**（`buildAuthLayer` 里那句 `new HttpClient({ cookies })`）。
 *
 * ## 为什么语义测试在 adapter-http，而这份在 cli
 * 判据本身（域/路径/过期/谁覆盖谁）在 `packages/adapter-http/test/cookies.test.ts`，
 * 那份**自己 new 了一个 HttpClient**。自己 new 就等于绕过了真正要问的那一句：
 * **生产路径上那个 client 到底有没有 jar？**
 * 那一行写在 `cli/src/wiring.ts` 的 `buildAuthLayer` 里，而 `packages/web` 与
 * `packages/adapter-http` 都不许 import `cli`（依赖方向，lint-layers 管着），
 * 所以载体只能落在 cli —— 不是随手挑的目录。
 *
 * ## 这份文件钉的是两件事，第二件更要紧
 *  1. 装配出来的 client **带着一个 jar**，所以登录后第二个请求真的带上会话；
 *  2. **两次装配之间不串会话。** 这一条盯的是"`new CookieJar` 写在函数体里还是模块顶层"。
 *     提到顶层看起来只是省一次分配，而 `packages/server` 是常驻进程 ——
 *     于是上一条用例登录的身份会带进下一条用例，而且**只要 job 顺序不变就一直绿**。
 *     那是本仓登记过很多次的假绿形状（"每一层各自都对，而它们对同一件事的假设互不相容"），
 *     而它在这一格上连"每一层"都没有：就是一行作用域。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { runScenario, deterministicClock, type AdapterRegistry } from '@atest/engine';
import { defineScenario, type ScenarioDraft } from '@atest/ir';
import { asHttpExec } from '@atest/adapter-http';

import { buildAuthLayer, DocRegistry } from '../src/wiring.js';

/** 空注册表：这一族不关心 spec，只关心 client 有没有 jar。用真的空实例而不是假对象 */
async function emptyRegistry(): Promise<DocRegistry> {
  return DocRegistry.load([]);
}

/** 会种 cookie 的本地服务，并记下每个请求收到的 Cookie 头 */
async function startCookieServer(): Promise<{
  addr: string; seen: Array<{ path: string; cookie?: string }>; close: () => Promise<void>;
}> {
  const seen: Array<{ path: string; cookie?: string }> = [];
  const srv = createServer((req, res) => {
    seen.push({ path: req.url ?? '', cookie: req.headers.cookie });
    if (req.url === '/login') res.setHeader('Set-Cookie', ['sid=abc123; Path=/; HttpOnly']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    addr: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    seen,
    close: async () => { await new Promise<void>((r) => srv.close(() => r())); },
  };
}

const loginThenMe: ScenarioDraft = ({
  schemaVersion: '1', id: 'scn.wire', name: '装配会话', env: { environmentRef: 'unit' },
  body: [
    { id: 'login', kind: 'http', request: { method: 'POST', url: '/login' } },
    { id: 'me', kind: 'http', request: { method: 'GET', url: '/me' } },
  ],
} as unknown) as ScenarioDraft;

/** 走**生产装配**建一次 client，然后跑一条"登录后再取一次"的场景 */
async function runThroughAssembly(addr: string, reg: DocRegistry): Promise<void> {
  const auth = buildAuthLayer({
    registry: reg, env: { baseUrl: addr }, environmentRef: 'unit',
    now: () => 1_700_000_000_000, envVars: {},
  });
  const adapters: AdapterRegistry = { http: asHttpExec(auth.client) };
  const r = await runScenario({
    scenario: defineScenario(loginThenMe), adapters,
    clock: deterministicClock(1), env: { baseUrl: addr },
  });
  assert.equal(r.status, 'pass', r.summary);
}

test('生产装配出来的 client 带着会话：登录后第二个请求真的带上 sid', async () => {
  const { addr, seen, close } = await startCookieServer();
  try {
    await runThroughAssembly(addr, await emptyRegistry());
    assert.equal(seen.length, 2, `请求条数不对：${seen.map((s) => s.path).join(', ')}`);
    assert.equal(seen[0]!.cookie, undefined, '登录请求自己带上了 cookie');
    assert.equal(seen[1]!.cookie, 'sid=abc123',
      '第二个请求没带上会话。**这一条红 = `buildAuthLayer` 里那句没把 jar 交给 client**，'
      + '而 adapter-http 那 35 条语义测试会全绿 —— 它们自己 new 的 client 当然带着 jar');
  } finally { await close(); }
});

test('两次装配之间不串会话（常驻服务里每条用例各自一个会话）', async () => {
  const { addr, seen, close } = await startCookieServer();
  try {
    const reg = await emptyRegistry();
    await runThroughAssembly(addr, reg);
    assert.equal(seen[1]!.cookie, 'sid=abc123', '第一次就没带上，那第二次的读数没有意义');
    seen.length = 0;
    await runThroughAssembly(addr, reg);
    assert.equal(seen.length, 2, `第二次的请求条数不对：${seen.map((s) => s.path).join(', ')}`);
    /*
     * **判漏的那一格是第二次 run 的 /login，不是 /me。**
     * 我第一版断的是 `seen[1] === undefined`（"第二个请求不许带 cookie"），
     * 而那是**我把判据写反了**：第二次 run 的 /login 自己会种一条新 cookie，
     * 它自己的 /me 带上 sid 是**正确行为**，实测本机就是 `sid=abc123`。
     * 真正只有"串了会话"才会非空的是 /login —— 那时 jar 里已经躺着上一次 run 的 sid。
     * 顺序也别在意**端口**：两个 server 各占一个端口，而 cookie 的归属**不含端口**，
     * 所以"跨 run 不串"这件事只有 host 参与判定，端口帮不上忙。
     */
    assert.equal(seen[0]!.cookie, undefined,
      '第二次 run 的**登录请求**带上了会话。**这一条红 = `new CookieJar` 被提到了模块顶层**'
      + '（或任何别名的进程级状态）。后果不是"这条测试红"而是：`packages/server` 上前后两个 job'
      + '共用身份，而只要顺序不变就一直绿');
    // 顺带钉住"每次装配都能建立**自己的**会话"：只有 /login 干净而 /me 也不带，
    // 那说明 jar 根本没生效，上面那条断言会以另一种方式一直绿
    assert.equal(seen[1]!.cookie, 'sid=abc123', '第二次装配没建立自己的会话');
  } finally { await close(); }
});
