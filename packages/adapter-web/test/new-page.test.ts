/**
 * 新窗口观测（`expectNewPage` / `wait{newPage}` 的**数据源**）。
 *
 * ## 为什么这一层非在真浏览器上跑
 *
 * 判据的核心是 `openerId === 本会话的 targetId` 那一句。
 * 它在假夹具上**等于我自己写自己测**：夹具里根本没有"别的页面开的窗口"这种东西，
 * 除非我手工造一条 —— 而造的时候我当然会照着过滤条件写。
 *
 * 真浏览器的价值恰恰是**噪声不是我造的**。实测（探针）：`Target.setDiscoverTargets`
 * 一开就会收到整个浏览器的 target 事件，包括别的 browserContext 的
 * `chrome://newtab/`、两个 Chrome 扩展的 service_worker、以及本会话自己那个
 * `about:blank`。**"数一切新出现的 page target"这种写法会恒真** ——
 * 一条永远过的断言比不实现更坏，因为它会让人以为自己验了弹窗。
 * 所以下面每条都带一个"不该算数"的对照。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createWebAdapter } from '../src/ui.js';
import { launchBrowser } from '../src/cdp.js';

import { browserBin, browserTest, fixtureUrl, stubCtx } from './browser.js';

type Adapter = Awaited<ReturnType<typeof createWebAdapter>>;

/** 轮询到计数变化或超时。**不用固定 sleep**（同 network.test.ts 那条纪律） */
async function untilChange(a: Adapter, baseline: number, ms = 3_000): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const n = a.newPage?.count() ?? -1;
    if (n > baseline) return n;
    if (Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 点一个选择器命中的元素（真鼠标序列，与适配器同一个路径） */
async function clickSel(a: Adapter, sel: string): Promise<void> {
  const { ctx } = stubCtx();
  await a.ui.perform({ op: 'click' }, await a.ui.resolve(
    { intent: sel, primary: { by: 'css', value: sel }, fallbacks: [], confidenceGate: 0.5, replayable: true }, ctx,
  ), ctx);
}

/**
 * 一个"点开新窗口"的页面。三种写法都要覆盖：
 * 它们走的是 Chrome 里**不同**的代码路径（导航拦截 vs window.open 的两种参数形态），
 * 只测一种的实现会在另一种上假红 —— 而假红会让人把这个字段关掉。
 */
const PAGE = `<a id=link href="/second" target=_blank>link</a>
<button id=wo>window.open</button>
<button id=same>同页跳转</button>
<button id=nothing>什么都不做</button>
<script>
document.getElementById('wo').onclick = () => window.open('/second');
document.getElementById('same').onclick = () => window.open('/second', '_self');
document.getElementById('nothing').onclick = () => { window.__fired = true; };
</script>`;

async function withNewPageFixture<T>(fn: (a: Adapter, url: string) => Promise<T>): Promise<T> {
  // /second 必须**真的存在**：404 的 target 也算"新窗口建好了"（targetCreated 在
  // 网络请求之前就发），所以这里不需要它回什么，但也不能让它变成一个跨站请求
  // （外站会把测试挂在网络上 —— 本机 registry 不可达，外网也不该依赖）。
  const srv = createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end(String(q.url ?? '/').startsWith('/second') ? '<p>second</p>' : PAGE);
  });
  await new Promise<void>((rz) => srv.listen(0, '127.0.0.1', rz));
  const port = (srv.address() as { port: number }).port;
  const second = `http://127.0.0.1:${port}/second`;
  const pageUrl = await fixtureUrl(PAGE);
  const a = await createWebAdapter({ bin: browserBin() });
  try {
    await a.ui.perform({ op: 'navigate', url: pageUrl, waitUntil: 'load' }, null, stubCtx().ctx);
    return await fn(a, second);
  } finally {
    await a.close();
    srv.close(); srv.unref();
  }
}

browserTest('新窗口端口在真浏览器上存在（不是恒 undefined）', async () => {
  await withNewPageFixture(async (a) => {
    // 这条看着像废话，但它是那一族缺陷的**唯一直接解药**：
    // 端口如果因为 discovery 没开而没挂上，下面所有测试都会以
    // "-1 !== baseline" 的形态红，而看不出是"没数到"还是"没接上"
    assert.ok(a.newPage, 'adapter 没挂 newPage —— Target.setDiscoverTargets 没开成功');
    assert.equal(typeof a.newPage.count(), 'number');
  });
});

browserTest('<a target=_blank> 真的被数到', async () => {
  await withNewPageFixture(async (a) => {
    const before = a.newPage!.count();
    await clickSel(a, '#link');
    const after = await untilChange(a, before);
    assert.ok(after > before, `点击 target=_blank 之后计数没动（${before} -> ${after}）`);
  });
});

browserTest('window.open() 真的被数到（与 a[target] 是不同代码路径）', async () => {
  await withNewPageFixture(async (a) => {
    const before = a.newPage!.count();
    await clickSel(a, '#wo');
    const after = await untilChange(a, before);
    assert.ok(after > before, `window.open() 之后计数没动（${before} -> ${after}）。`
      + '只覆盖 <a target=_blank> 的实现会在这里假红，而人会以为这个字段不可靠');
  });
});

browserTest('一次开窗只加 **1**（不是 2）—— 子页面那条 targetInfoChanged 也带 openerId', async () => {
  /*
   * **这条是补 W2 那个漏网的**，而漏网的原因是我把一件事记错了。
   *
   * 我原先写的是"同页跳转靠 openerId 挡住，所以 method 名那道闸冗余"，
   * 依据是"把判据放宽成 created 与 changed 都算，七条一条都没红"。
   * 前半句没错（**本页**那条 infoChanged 确实不带 openerId），
   * 但"冗余"是错的 —— 探针实测（`.scratch` 里那次，结论必须迁进测试）：
   *
   *   [本页开的] targetCreated      type=page openerId=<本页> url=""
   *   [本页开的] targetInfoChanged  type=page openerId=<本页> url="…/second"
   *
   * 也就是**子页面**导航到真实 URL 时那条 infoChanged **带着指回本页的 openerId**。
   * 所以"created 与 changed 都算"会让一次开窗**加 2**。
   * 七条测试抓不到它，是因为每条问的都是 `after > before` ——
   * **一个"有没有"的断言，永远看不见"多算了几次"**。
   *
   * 为什么多算要紧（不是洁癖）：`expectNewPage` 的判据是 `count() > 基线`，
   * 加 1 还是加 2 今天都不改结论。但它一旦多算，
   * "这一步开了几个窗口"这种显而易见的下一档需求就建立在一个错数上；
   * 而**没有一条测试能发现数已经错了** —— 那正是本仓反复出现的
   * "字段有人读、读得对，但值本身没人核对形状"。
   *
   * 顺带这一条也是 W3 的对照：它同时要求加的不是 0，
   * 所以"把 type 过滤删了导致扩展的 service_worker 也被算进来"会在这里显形
   * （如果那种 target 真的带 openerId 的话 —— 本机实测**不带**，
   * 所以 W3 仍然记 equivalent，见 tooling/mutate/new-page-web.json）。
   */
  await withNewPageFixture(async (a) => {
    const before = a.newPage!.count();
    await clickSel(a, '#wo');
    const grown = await untilChange(a, before);
    assert.ok(grown > before, '先确认观测口活着，否则下面的"正好 +1"是空断言');
    // 再等一会儿：子页面的 targetInfoChanged 比 targetCreated 晚到，
    // 不等的话多算那个破坏会来不及显形（这条测试的全部价值就在"等"上）
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(a.newPage!.count(), before + 1,
      `一次 window.open 之后计数加了 ${a.newPage!.count() - before}。`
      + '子页面导航时的 targetInfoChanged **也带 openerId 指回本页**（实测），'
      + '所以"created 与 changed 都算"会加 2 —— method 名那道闸不是冗余的');
  });
});

browserTest('什么都没开的点击**不**被数到（假绿方向，本轮修的那一条）', async () => {
  await withNewPageFixture(async (a) => {
    const before = a.newPage!.count();
    await clickSel(a, '#nothing');
    // 确认点击**真的生效了**，否则"计数没动"可能只是因为压根没点到
    assert.equal(await a.eval('window.__fired === true'), true, '点击没生效，那这条测试什么都没测');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(a.newPage!.count(), before,
      '什么都没开却被数到了 => `expectNewPage` 会变成一条永远过的断言');
  });
});

browserTest('同页跳转（window.open(url, "_self")）**不**算新窗口', async () => {
  /*
   * 实测这一条走的是 `targetInfoChanged` 而**不是** `targetCreated`，
   * 而且**那条不带 openerId**（本页不是被谁"打开"的），所以第一道闸就把它挡掉了。
   *
   * **但这不等于 method 名那道闸没用** —— 我在这儿翻过一次，留下来免得重复：
   * 我先把"created 与 changed 都算"这个破坏手工跑了一遍，七条一条都没红，
   * 于是记成"两道闸重叠、method 名冗余"。那个结论是**从测试的盲区里推出来的**，
   * 而那七条问的全是 `after > before`：一次开窗加 2 也一样"红了没人看见、绿了全过"。
   * 探针随后实测到子页面那条 `targetInfoChanged` **确实带 openerId 指回本页**，
   * 所以放宽之后一次开窗**加 2** —— 见上面"一次开窗只加 1"那条测试。
   *
   * 所以两道闸**都要留**。真正要记的是推错的那一步：
   * "改坏了而测试没红"只允许推出"测试不够"，**不允许推出"这段代码没用"**。
   */
  await withNewPageFixture(async (a) => {
    const before = a.newPage!.count();
    await clickSel(a, '#same');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(a.newPage!.count(), before, '同页跳转被算成新窗口了');
    // 而且跳转**确实发生了**（不然这条又是"什么都没测"）
    // 确认跳转**真的发生了**。少了这一句，"计数没动"可能只是因为
    // 按钮压根没点到 —— 那是一条永远绿的测试（本仓缺陷类 (b) 的形状）
    const jumped = await a.ui.assertUi({ assertKind: 'url', expected: 'second' } as never, stubCtx().ctx);
    assert.equal(jumped.passed, true, '同页跳转没发生，那这条测试什么都没测');
  });
});

browserTest('别的浏览器上下文开的窗口不算在本页头上（噪声不是我造的）', async () => {
  /*
   * **这条是整个判据的存在理由**，也是唯一一条"噪声来自 Chrome 而不是我的夹具"的：
   * 同一个浏览器进程里起第二个会话（第二个 BrowserContext + 第二个 target），
   * 让它开一个新标签页。如果判据只是"数一切新出现的 page target"，
   * 这边会跟着涨 —— 于是 A 用例开的窗口会让 B 用例的 `expectNewPage` 通过，
   * 那正是 docs/06 §1 列的"用例 A 做的事让用例 B 假绿"这一族。
   */
  const browser = await launchBrowser({ bin: browserBin() });
  try {
    const a = await createWebAdapter({ browser });
    const b = await createWebAdapter({ browser });
    try {
      const pageUrl = await fixtureUrl(PAGE);
      const { ctx } = stubCtx();
      await a.ui.perform({ op: 'navigate', url: pageUrl, waitUntil: 'load' }, null, ctx);
      await b.ui.perform({ op: 'navigate', url: pageUrl, waitUntil: 'load' }, null, ctx);

      const beforeA = a.newPage!.count();
      const beforeB = b.newPage!.count();
      // 让 **B** 开一个窗口
      await b.ui.perform({ op: 'click' }, await b.ui.resolve(
        { intent: 'b', primary: { by: 'css', value: '#wo' }, fallbacks: [], confidenceGate: 0.5, replayable: true }, ctx,
      ), ctx);
      // **各用各的基线**（我第一版把 beforeA 传给了 B 的轮询：
      // 两个计数都从 0 起所以当时看不出来，而它会在任何"两边起点不同"的
      // 实现里变成一条随机红的测试 —— 断错了变量的测试比没断更坏）
      const afterB = await untilChange(b, beforeB);
      assert.ok(afterB > beforeB, 'B 自己都没数到，那这条在测什么（先确认观测口活着）');

      // A 应当**没有**跟着涨。给它一点时间：target 事件是浏览器级广播，
      // 漏判的方向是"A 也涨了"，所以等一会儿再读只会更严
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(a.newPage!.count(), beforeA,
        '别的上下文开的窗口被算进本会话了 => 并发用例之间会互相制造假绿');
    } finally {
      await a.close(); await b.close();
    }
  } finally {
    await browser.close();
  }
});

browserTest('导航之后仍然数得到新窗口（targetId 不随导航变化）', async () => {
  /*
   * 判据认的是 openerId === targetId。而 `Page.frameNavigated` 会清掉句柄缓存 ——
   * 如果 targetId 也跟着变了，之前注册的那个判据就永久失效，
   * 症状是"第一个页面能测弹窗，点了登录跳到主页之后就测不到了"。
   * 实测 targetId **不**随导航变化，这条把它钉住。
   */
  await withNewPageFixture(async (a) => {
    const before = a.newPage!.count();
    await a.ui.perform({ op: 'navigate', url: await fixtureUrl(PAGE), waitUntil: 'load' }, null, stubCtx().ctx);
    await clickSel(a, '#link');
    const after = await untilChange(a, before);
    assert.ok(after > before, `导航之后计数没动（${before} -> ${after}）—— targetId 或监听被导航弄丢了`);
  });
});
