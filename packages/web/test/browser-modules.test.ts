/**
 * **这条测试是整个前端架构的载体**：浏览器里 import 真的 `@atest/ir` + `@atest/engine`，
 * 并让 `lintScenario` 在浏览器里真的报出一条 issue。
 *
 * ## 为什么值得为它写一个 CDP 客户端
 *
 * docs/01 §8.2 那句"引擎必须能在浏览器里跑只读校验，否则 GUI 就得维护第二套校验逻辑"
 * 是前端整个技术方向的支点。而它在**装打包器之前**只是一个论断：
 * `lint-layers` 拦住了 node 内置依赖（必要条件），但裸名解析（`'zod'`、`'@atest/ir'`）
 * 靠不靠 import map 通、dist 那份 NodeNext 产物在浏览器里是不是合法 ESM、
 * zod 有没有把某个 node 依赖带进来 —— 这三件事任何一件崩了，方向整体作废。
 *
 * 而这类"看起来满足了约束"的断言，本仓的账是：**没跑过的约束等于没有约束**
 * （docs/08 §3 那一族的反面写法）。所以这里不是"跑通了写个注释"，
 * 而是把它做成一条会红的测试：哪天有人给 ir/engine 加了一个 node 依赖、
 * 或者换了模块格式、或者把 import map 改错，这条测试红。
 *
 * ## 为什么在这里手写 CDP，而不用 @atest/adapter-web
 *
 * `tooling/lint-layers.mjs` 给 packages/web 定的规则是"只许依赖 ir + engine"，而
 * **测试目录只豁免 node 内置模块那一条，不豁免依赖方向**（那条例外的注释就写在那儿）。
 * 所以这里 import 不了 adapter-web。这不是不便，是这条测试**更该在 web 这一侧**的理由：
 * 它验的是"web 这一侧的东西能不能在浏览器里跑"，夹具依赖一个上层包的话，
 * 上层包坏了会让这条测试红，而红的含义会被误读成"浏览器加载不了了"。
 *
 * 夹具本身（找浏览器、静态服务、CDP 客户端）在 `./browser-harness.ts`，
 * 与 `browser-run-button.test.ts` 共用一份 —— 同一包里抄两份搜索顺序会漂，
 * 漂了的症状是"一边能跑一边跳过"。用到的 CDP 面只有四个方法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { browserTest, evalWait, openPage, serveSite } from './browser-harness.js';

test('夹具自己：serveSite 对没写桩的 /api 路由大声 404（不静默 403）', async () => {
  /*
   * 夹具也是代码，也要有自己的载体。这一格守的是夹具的一条口径：**没写桩的 api 路由
   * 要回 404 并写上路由名**，而不是落到静态那侧的 403。403 会被读成"安全层拦了"，
   * 而真相常常是"前端新加了一条路由，夹具还不知道" —— 那时正确的红是"404 里没有这条路由"，
   * 不是一片被拒的 403。这条测试红了，意味着下一次夹具坏掉会被误诊。
   */
  const site = await serveSite({ index: { html: '<!doctype html><p>x</p>' } });
  try {
    const res = await fetch(`${site.url}api/never-stubbed`);
    assert.equal(res.status, 404, '没写桩的 api 路由不该被当成静态资源处理');
    assert.match(await res.text(), /no stub.*never-stubbed/s, '404 里要带上是哪条路由，否则排查靠猜');
  } finally { await site.close(); }
});

test('夹具自己：被挂住的响应不会让 close() 吊死', async () => {
  /*
   * 测"跑动中"的夹具**必须**把 `/api/run` 挂着不回，而挂着的响应会让 `server.close()`
   * 永远不 resolve（node 的 close 等在途连接上）。那时的表现是夹具的 finally 挂住、
   * 整条测试超时 —— 失败归因从"这条判据红了"变成"超时"，而超时这种红谁都见过是机器慢。
   * harness 自己记下 socket 并在 close 时拆掉；这条测的就是那一段真的生效，
   * 并且给一个明确的时间上限（不是" eventually 会回"）。
   */
  let releaseLate: (() => void) | undefined;
  const site = await serveSite({
    index: { html: '<!doctype html><p>x</p>' },
    api: (_req, res) => {
      // 挂着：写个头、不 end，模拟一条还没跑完的 run
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":true}');
      releaseLate = () => res.end();
      return true;
    },
  });
  const inflight = fetch(`${site.url}api/run`, { method: 'POST' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  const closedInTime = await Promise.race([
    site.close().then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 3_000)),
  ]);
  releaseLate?.();
  await inflight;
  assert.ok(closedInTime, 'close() 被一条挂着的响应吊住了：harness 那一段拆 socket 的代码没生效');
});

browserTest('浏览器里 import 真 ir/engine，并由引擎自己报出 issue', async () => {
  const site = await serveSite({
    index: { html: `<!doctype html><meta charset="utf-8"><script type="importmap">
{"imports":{"zod":"/pkg/zod/index.js","@atest/ir":"/pkg/ir/index.js","@atest/engine":"/pkg/engine/index.js","@atest/web/":"/app/"}}
</script><script type="module">
// 判据用引擎自己的回答，不用"import 没抛"：后者连"模块加载了但没行为"都分不清
try {
  const ir = await import('@atest/ir');
  const eng = await import('@atest/engine');
  const app = await import('@atest/web/check.js');
  // 一份自引用的 default：静态侧必然报 DEPENDENCY_CYCLE（场景内那一查，不需要调用图）
  const scen = ir.defineScenario({
    schemaVersion: '1', id: 'scn.browser', name: 'b', env: { environmentRef: 'unit' },
    inputs: [{ name: 'who', type: 'string', default: { path: '$who' } }],
    body: [{ id: 'a', kind: 'noop' }],
  });
  const checked = await app.checkIr(JSON.stringify(scen));
  globalThis.__probe = {
    ok: true,
    statusEnum: ir.STEP_STATUS,
    lintCodes: eng.lintScenario(scen).map((i) => i.code),
    // checkIr 是我们自己那一层的封装：它的 issue 数与 canonical 也得是浏览器算出来的
    checkCodes: checked.issues.map((i) => i.code),
    canonicalHead: (checked.canonical ?? '').slice(0, 16),
    irSha: checked.irSha ?? checked.irShaError,
  };
} catch (e) {
  globalThis.__probe = { ok: false, error: String((e && e.stack) || e) };
}
</script>`,
    },
  });
  // profile 由 openPage 自己开、自己收（临时 --user-data-dir，绝不碰用户那份 Chrome 配置）
  const { cdp, kill } = await openPage(site);
  try {
    const got = await evalWait(cdp, 'globalThis.__probe') as {
      ok: boolean; error?: string; statusEnum?: string[]; lintCodes?: string[]; checkCodes?: string[]; canonicalHead?: string; irSha?: string;
    };

    assert.equal(got.ok, true, `浏览器里加载/执行失败：${got.error}`);
    // 1) 六态枚举来自 IR —— 这条是"前端没有第二套状态表"（docs/13 §6）的机制性证据
    assert.deepEqual(got.statusEnum, ['pass', 'fail', 'error', 'healed', 'skipped', 'triaged'],
      '浏览器里拿到的 STEP_STATUS 与 Node 侧不是同一份');
    // 2) 引擎真的**跑出了结果**，不是"import 成功但什么都没发生"
    assert.ok(got.lintCodes?.includes('DEPENDENCY_CYCLE'), `引擎在浏览器里没报出那条自引用环：${JSON.stringify(got.lintCodes)}`);
    // 3) 我们那一层的封装也在浏览器里跑通（canonical + Web Crypto 的 sha）
    assert.ok(got.checkCodes?.includes('DEPENDENCY_CYCLE'), `checkIr 在浏览器里没报出问题：${JSON.stringify(got.checkCodes)}`);
    assert.ok(typeof got.canonicalHead === 'string' && got.canonicalHead.length > 0, 'canonical 序列化在浏览器里给空串');
    // sha 取不到时是**原因**而不是 undefined —— 这条测的是"取不到要说什么"那条纪律
    assert.ok(/^[0-9a-f]{64}$/.test(String(got.irSha)) || /Web Crypto/.test(String(got.irSha)),
      `irSha 那一格既不是 hash 也不是原因：${got.irSha}`);
  } finally {
    kill();
    await site.close();
  }
});
