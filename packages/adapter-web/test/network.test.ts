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
/**
 * `idx` 曾经不在这里（只有 url + status），而"下标是绝对的"那条测试断的**就是它**。
 * 类型上少一个字段而测试照样跑，是因为它当时压根没读 `idx` ——
 * 于是那条测试用"条数"当游标，把一个**时序**性质当成了下标性质来断，满载时随机红。
 * 补上字段是让"这个测试在断什么"这件事回到类型上。
 */
type Row = { url: string; status: number; idx: number };

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
 * 等到流**安静**（两次读数相同且间隔 250ms），返回**当前最大下标**。
 *
 * 为什么需要它：**这条是被实测打出来的，不是想出来的。** 第一版在这里
 * 直接取"等到 /api/query 出现时的总条数"当游标，然后断"since=该游标 之后为空"。
 * 三次跑红一次 —— 因为 Chrome 的 **favicon 请求会在文档之后才落地**，
 * 于是那条"新条目"出现在我取完游标之后，"之后为空"当然不成立。
 *
 * 那次红**不是产品的 bug，是我在断浏览器的时序而不是断我们的代码**。
 * 修法不是给 favicon 加白名单（那是为了让测试跑通而缩小被测面），
 * 而是先把流取到安静：**安静之后再取游标，"之后为空"才是对我们的判据**。
 *
 * **返回的是下标而不是条数**（本轮改的）。以前返回 `length`，而调用方拿它当
 * `responsesSince()` 的参数 —— 那等于**假设"条数 == 最大下标"**，
 * 而两者只在"从未淘汰过任何条目"时相等：缓冲有上限（`RESPONSE_CAP`），
 * 淘汰之后条数就落后于下标。这个耦合今天碰不到（一个夹具只有几条响应，
 * 离 5000 条远得很），但它是一颗要等很久才炸、且炸成"少给候选"的雷。
 * 取最大下标在任何情况下都是对的游标，也更贵不了多少。
 */
async function settle(a: Adapter, ms = 3_000): Promise<number> {
  const deadline = Date.now() + ms;
  const maxIdx = async () => (await a.responsesSince(0)).reduce((m, r) => Math.max(m, r.idx), 0);
  let prev = await maxIdx();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await maxIdx();
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

browserTest('下标是绝对的：看过的不再给出，新的只会往后加（**这一条重写过一次，理由见注释**）', async () => {
  /*
   * **第一版是错的，而它在满载时随机红。** 它写的是
   * "settle 之后取游标 => `responsesSince(游标)` 为空"，
   * 全量套件里 1007 条并发跑时红了：那条多出来的是 **favicon**，
   * 它在 settle 判定"安静"**之后**才落地，于是它确实是**新数据**（下标也确实更大）。
   *
   * 也就是说那条断言写的不是"下标是绝对的"，而是"**浏览器从此不再发任何请求**" ——
   * 一个我根本不该主张的性质。而它的失效方式正是本仓最反对的那种：
   * **在断被测对象的时序，而不是断我们的判据**（同 settle() 那次红的定性）。
   *
   * 真正要守的那条与时间无关，所以换成三条这样的：
   *  1. **看过的绝不再给出**（按 idx 比对，不看条数）—— 这是引擎游标的全部依赖，
   *     破了它，上一步消费过的响应会被下一步算成命中（假绿）；
   *  2. **新读到的每一项下标都严格大于游标**，且新请求真的在里面；
   *  3. **重复读同一游标是"只追加"的**：前缀逐条相同（同 idx、同 url），
   *     长度只许变长。这既守"读取无副作用"，也守"下标不被重排"，
   *     而它**允许**中间来了 favicon —— 上一条那种写法不允许，所以它是错的。
   *
   * 少了 `settle()`：安静本来就不是这些性质的前提，加了它反而说明当时没想清要断什么。
   */
  await withPage('<script>fetch("/api/query");</script>', async (a) => {
    await waitForUrl(a, '/api/query');
    const seen = await a.responsesSince(0);
    assert.ok(seen.length > 0, '先确认流里有东西，否则下面三条都是空断言');
    // 游标 = **看过的最大下标**，不是条数。两者只在没淘汰时相等，
    // 而"用条数当下标"本身就是一个会随缓冲上限变化的耦合
    const cursor = seen.reduce((m, r) => Math.max(m, r.idx), 0);
    assert.ok(cursor > 0, `下标应当从 1 起，最大却是 ${cursor}`);
    const seenIdx = new Set(seen.map((r) => r.idx));

    await a.eval('fetch("/api/third")');
    const after = await waitForUrl(a, '/api/third');
    const fresh = after.filter((r) => r.idx > cursor);
    assert.ok(fresh.length > 0, '新请求没有以"比旧游标更靠后"的下标出现');
    /*
     * 这里原本写的是 `fresh.every((r) => r.url.includes('/api/third'))`，
     * 满载时它红了，而**它红的方向和被测代码无关**：多出来那条又是 favicon，
     * 落地时间在游标之后，所以它是**合法的新条目**。
     * 那句断言真正主张的是"游标之后浏览器只发我这一个请求"——
     * 与本文件开头反对的是同一件事，而我一边在注释里写"别断浏览器的时序"、
     * 一边在下一行写了个断浏览器时序的判据。这说明**光有纪律不够，
     * 判据得写成"与时间无关的形状"**：只问"旧的会不会回来"，不问"会不会有别的"。
     * 换成"新的那一条在不在里面"（要它必须在），旧条目回不回交给下面那条 idx 比对。
     */
    assert.ok(fresh.some((r) => r.url.includes('/api/third')),
      '新请求没有出现在游标之后');

    // 第 1 条：看过的绝不再给出
    const overlap = fresh.filter((r) => seenIdx.has(r.idx));
    assert.deepEqual(overlap, [],
      '已消费过的响应被再次给出 = 窗口起点形同虚设，上一步的接口会被下一步算成命中（假绿）');

    // 第 3 条：只追加。允许新的进来，**不允许前缀变**
    const again = await a.responsesSince(cursor);
    assert.ok(again.length >= fresh.length, '同一游标第二次读反而变短了 = 有东西被丢掉或读取有副作用');
    for (let i = 0; i < fresh.length; i++) {
      assert.equal(again[i]!.idx, fresh[i]!.idx, `第 ${i} 条的下标在两次读之间变了 = 下标被重排`);
      assert.equal(again[i]!.url, fresh[i]!.url, `第 ${i} 条的内容在两次读之间变了 = 下标指向的东西会漂移`);
    }
    // 下标在整份流上严格递增（淘汰会留空洞，但不会倒退）
    for (let i = 1; i < again.length; i++) {
      assert.ok(again[i]!.idx > again[i - 1]!.idx,
        `下标非递增：${again[i - 1]!.idx} -> ${again[i]!.idx}`);
    }
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
