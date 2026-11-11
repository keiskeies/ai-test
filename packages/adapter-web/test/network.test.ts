/**
 * 页面内请求的响应流（引擎的 `wait{response}` / `expectResponse` 的**数据源**）。
 *
 * ## 为什么这个文件必须存在，而不是只有引擎侧那 18 条
 *
 * 引擎侧的测试全用**假流**（`responses.test.ts` 的 `fakeStream`）。
 * 假流只能证明"**如果**有人按契约供数，判据对不对"——它证明不了**有人供数**。
 *
 * 这不是假设：本仓刚记过一例（docs/14 §4.3 的第三个子类）——
 * `maxCostUsdPerResolve` 的引擎侧审计接上了、测试全绿，
 * 而**没有任何 adapter 报那个数**，所以闸门一次都没触发过。
 * 那份教训里我写的自查动作是"回头 grep 真实现"，这里就是那次自查的直接产物：
 * **观测口必须在真浏览器上跑一次，看到真数字进了流**，否则本轮就是同一个错误重演一遍。
 *
 * ## 这里判的是"流里真有什么"，不是"页面发过请求"
 *
 * 每条都断**具体是哪一条响应、什么状态码**，因为这一层的失效方式是
 * "流是空的 / 少了一条 / 下标错位"，而那三种都不会让页面报错 ——
 * 它们只会让引擎等不到，最后表现为一次看起来正常的超时（正是本轮修掉的那个形状）。
 *
 * ## 夹具流里不只有的我们要的东西（第一版就栽在这）
 *
 * 真浏览器的流里还有**文档本身**与 **favicon**。所以：
 *  - 断言一律先 `apiOnly()` 过滤，否则"流里非空"这种判据会被 favicon 满足；
 *  - **等的是具体 URL，不是条数**。我第一版写的是"等到有 n 条"，
 *    结果第一条（文档）一到就返回，fetch 还没落地，三条测试假红。
 *    这跟本仓在业务测试里反对固定 sleep 是同一条理由的另一个方向：
 *    **等一个恰好与真实事件不同形的东西**。
 */
import assert from 'node:assert/strict';

import { createWebAdapter } from '../src/ui.js';

import { browserBin, browserTest, fixtureUrl, stubCtx } from './browser.js';

type Adapter = Awaited<ReturnType<typeof createWebAdapter>>;
type Row = { url: string; status: number };

async function withPage<T>(html: string, fn: (a: Adapter) => Promise<T>): Promise<T> {
  const a = await createWebAdapter({ bin: browserBin() });
  const { ctx } = stubCtx();
  try {
    await a.ui.perform({ op: 'navigate', url: await fixtureUrl(html), waitUntil: 'load' }, null, ctx);
    return await fn(a);
  } finally {
    await a.close();
  }
}

/**
 * 等到流里出现**含该子串**的条目，最多 ms 毫秒；超时就把当前全量交回。
 *
 * 不用固定 sleep：那正是本仓在"等待"上立过的那条纪律
 * （每一个 delay:3000 都是一颗未来的 flake）。
 * 超时不抛错而交回全量 —— 因为**没等到本身就是要报告的现象**（"没人供数"），
 * 断言那句会把它连同流里的实际内容一起打出来，比一个裸超时信息有用得多。
 */
async function waitForUrl(a: Adapter, pattern: string, ms = 5_000): Promise<Row[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await a.responsesSince(0);
    if (got.some((r) => r.url.includes(pattern))) return got;
    if (Date.now() > deadline) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 只看我们发过的那些（文档与 favicon 由浏览器决定要不要有，不参与断言） */
const apiOnly = (rs: readonly Row[]): Row[] => rs.filter((r) => r.url.includes('/api/'));

/**
 * 等到流**安静**（两次读数相同且间隔 250ms），返回那个总数。
 *
 * 为什么需要它：**这条是被实测打出来的，不是想出来的。** 第一版在这里
 * 直接取"等到 /api/query 出现时的总条数"当游标，然后断"since=该游标 之后为空"。
 * 三次跑红一次 —— 因为 Chrome 的 **favicon 请求会在文档之后才落地**，
 * 于是那条"新条目"出现在我取完游标之后，"之后为空"当然不成立。
 *
 * 那次红**不是产品的 bug，是我在断浏览器的时序而不是断我们的代码**。
 * 修法不是给 favicon 加白名单（那是为了让测试跑通而缩小被测面），
 * 而是先把流取到安静：**安静之后再取游标，"之后为空"才是对我们的判据**。
 */
async function settle(a: Adapter, ms = 3_000): Promise<number> {
  const deadline = Date.now() + ms;
  let prev = (await a.responsesSince(0)).length;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = (await a.responsesSince(0)).length;
    if (now === prev) return now;
    prev = now;
  }
  return prev;
}

browserTest('页面发的请求真的进了响应流（本轮的关键一条：确认**有生产者**）', async () => {
  await withPage('<script>fetch("/api/query").then(() => fetch("/api/other"));</script>', async (a) => {
    await waitForUrl(a, '/api/query');
    const got = apiOnly(await waitForUrl(a, '/api/other'));
    assert.ok(got.length >= 2, `响应流里只有 ${got.length} 条：${JSON.stringify(got)}。`
      + '这就是"引擎侧接上了但没人供数"的那个形状 —— 它不会报错，只会让所有 wait{response} 超时');
    // 断**具体是哪两个**，不是断"非空"：流里躺着 favicon 也算非空
    assert.ok(got.some((r) => r.url.includes('/api/query')), `没等到 /api/query：${got.map((r) => r.url).join(' ')}`);
    assert.ok(got.some((r) => r.url.includes('/api/other')), `没等到 /api/other：${got.map((r) => r.url).join(' ')}`);
    assert.ok(got.every((r) => r.status >= 100), '状态码必须是真状态码，不能是 0/-1 那种"还没有响应"的占位值');
  });
});

browserTest('状态码是从真响应里来的（夹具回 500 就是 500，不是恒 200）', async () => {
  await withPage('<script>fetch("/api/query?status=500");</script>', async (a) => {
    const hit = apiOnly(await waitForUrl(a, '/api/query')).find((r) => r.url.includes('/api/query'));
    assert.ok(hit, `没看到 /api/query：${JSON.stringify(apiOnly(await a.responsesSince(0)))}`);
    assert.equal(hit.status, 500,
      '状态筛选（等 [200] 而实际 500）全靠这个数是真的。恒 200 的实现会把"接口报错"等成"接口成功"= 假绿');
  });
});

browserTest('下标是绝对的：since 之前的不再给出，且不因新数据到来而回退', async () => {
  await withPage('<script>fetch("/api/query");</script>', async (a) => {
    await waitForUrl(a, '/api/query');
    const total = await settle(a);
    // 取走全部之后，since = 当前总数 应当什么都拿不到
    assert.deepEqual(await a.responsesSince(total), [],
      'since 之后应当是空的。这里非空说明窗口起点形同虚设 —— 上一步消费过的响应会被下一步再算命中（假绿）');
    // 再来一个请求，下标应当**继续往前走**而不是从 0 重来
    await a.eval('fetch("/api/third")');
    await waitForUrl(a, '/api/third');
    const only = apiOnly(await a.responsesSince(total));
    assert.ok(only.length > 0, '新请求没有以"比旧游标更靠后"的下标出现');
    assert.ok(only.every((r) => r.url.includes('/api/third')),
      `since 之后应当只有新的：${only.map((r) => r.url).join(' ')}。`
      + '旧响应被重新给出 = 下标被重排，引擎会把上一步的响应当成本次动作触发的（假绿）');
    // 重复读同一个 since 要给出同样的结果（一次 poll 里 anyOf 的两个分支读同一份）
    assert.deepEqual(await a.responsesSince(total), only, '同一个 since 两次读给出不同条目 —— 读取有副作用');
  });
});

browserTest('导航不把下标清零（同一会话内单调，跨页仍连续）', async () => {
  await withPage('<script>fetch("/api/query");</script>', async (a) => {
    await waitForUrl(a, '/api/query');
    // 先取到安静再取游标，理由见 settle()：favicon 会在文档之后才落地
    const before = await settle(a);
    await a.ui.perform(
      { op: 'navigate', url: await fixtureUrl('<script>fetch("/api/after-nav");</script>'), waitUntil: 'load' }, null, stubCtx().ctx);
    // **从旧游标往后等**：这同时验了"导航后下标还在往前走"与"新页面的请求进得来"
    const deadline = Date.now() + 5_000;
    let fresh: Row[] = [];
    for (;;) {
      fresh = apiOnly(await a.responsesSince(before));
      if (fresh.some((r) => r.url.includes('/api/after-nav'))) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fresh.some((r) => r.url.includes('/api/after-nav')),
      `导航后的请求没有以"比导航前更靠后"的下标出现。整个流：${JSON.stringify(await a.responsesSince(0))}`);
    assert.ok(!fresh.some((r) => r.url.includes('/api/query')),
      '导航后把上一个页面的响应当成"新的"给出了 —— 下标被重排，引擎会把旧响应当成本次动作触发的（假绿）');
  });
});

browserTest('没发过的接口不在流里（而不是有一条凭空出现的）', async () => {
  await withPage('<p>静默页面</p>', async (a) => {
    // **等流安静**而不是等一个固定时长：负向断言最怕的就是"等得不够所以看着是空的"，
    // 那种红/绿与时序有关，与产品无关（settle 的注释里记的就是这个形状的一次真红）
    await settle(a);
    // 静默页面仍可能有 Chrome 自己的请求（favicon）。所以判据不是"长度为 0"，
    // 而是"没有我们没发过的 API 路径" —— 断长度为 0 会得到一条依赖浏览器实现细节的脆测试
    assert.deepEqual(apiOnly(await a.responsesSince(0)), [], '没发过接口却出现在流里');
  });
});

browserTest('请求被中断时流里干干净净（没有凭空冒出的占位条目）', async () => {
  /*
   * 断的是**不出现**，不是"出现且状态为 0"。原因在 CDP 的语义：
   * `Network.responseReceived` 只在真拿到响应头时才发；请求挂掉/被取消时
   * 某些版本会带 `status: 0` 补一条。那种条目如果进了流，
   * `wait{response}` 等 `/api/missing` 就会命中它 => **把加载失败等成成功**（假绿）。
   *
   * **诚实标注这条测到哪**：它测的是"真 Chrome 在请求被中断时不往流里塞东西"，
   * 也就是**这一版浏览器的行为**。它**测不到** session.ts 里 `status <= 0` 那个过滤本身 ——
   * 本机 Chrome 压根不产 status 0 的条目，所以把那个过滤删掉这条也不会红。
   * 那个过滤是**纵深防御**（防别的版本/别的取消路径），要证它只能在假流上测，
   * 而假流的条目是我自己照着过滤条件写的，等于自证。
   * 记在这里而不是假装它被守住了：一个"看着守住了其实没有"的性质，
   * 与本轮修掉的"测试全绿但没人供数"是同一类要摊开的账。
   */
  await withPage('<script>fetch("/api/missing?abort=1");</script>', async (a) => {
    await settle(a); // 同理：负向断言要等安静，否则"没看到"可能只是"没等到"
    const got = await a.responsesSince(0);
    assert.ok(!got.some((r) => r.status <= 0), `流里出现了占位状态：${JSON.stringify(got)}`);
    assert.ok(!got.some((r) => r.url.includes('/api/missing')),
      `被中断的请求进了流：${JSON.stringify(got)}`);
  });
});
