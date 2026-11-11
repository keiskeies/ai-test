/**
 * 屏幕那个**取消按钮**的载体测试（真 Chrome + 真 app.ts + 桩服务端）。
 *
 * ## 它只补一件事：按钮真的接上了 `run-job.ts`
 *
 * 判据本身（id 形状、四档措辞、409 不重试）在 `run-job.test.ts` 里，node 里跑，
 * 不起浏览器 —— 那些是契约，跟画成什么按钮无关。
 * 这一条测的是**接线**，而接线坏了 node 侧一条都不会红：
 *  - `app.ts` 的 `runIt` 忘了带 `jobId` => 服务端那一格永远 `cancellable:false`，
 *    契约测试全绿，人点按钮永远 404。**这一格是那条链上唯一能被观测的位置。**
 *  - 按钮挂在了"run 结束"那一刻（`submitRun` 阻塞，等它回等于白挂）=> 按钮出现了
 *    却没有可取消的东西。
 *  - 取消的是**另一条** job（同屏多条 run 时按文字找按钮）=> 停错。
 * 这三条各在 node / 静态审查里都看不见。
 *
 * ## 为什么服务端是桩，而这是对的
 *
 * `tooling/lint-layers.mjs` 不许 packages/web 依赖 packages/server（测试目录只豁免
 * node 内置那一条）。更重要的是判据：**这一格要证的是前端发了什么**。
 * 真起服务端的话，"前端有没有带 jobId"会变成"服务端会不会登记 job"，
 * 一次红有两处可疑，归因就分了。桩只记录请求，判定交给记录本身。
 *
 * ## 桩为什么把 `/api/run` 挂着不回
 *
 * 因为"跑动中"是这个按钮存在的唯一理由。若 `/api/run` 立刻返回，按钮在能点之前
 * 就已经被 `cancelBtn.remove()` 摘掉了 —— 那夹具测的是"按钮不出现"，
 * 而它绿着的时候谁都会以为测的是别的。挂住 + 由测试自己决定何时放开，
 * "跑动中"就是**构造出来的**，不是赌时序赌赢的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { browserTest, evalOnce, evalWait, evalWaitGone, openPage, serveSite, type Site } from './browser-harness.js';

const SCENARIO = {
  schemaVersion: '1', id: 'scn.ui', name: 'UI 夹具', frozen: false,
  env: { environmentRef: 'unit' },
  body: [{ id: 'a', kind: 'noop' }],
};

interface Stub {
  site: Site;
  /** 收到的 /api/run 请求体（解析过的） */
  runs: Array<Record<string, unknown>>;
  /** 收到的 /api/cancel 的 jobId，按到达顺序 */
  cancels: string[];
  /** 放开那一条挂着的 /api/run */
  release: (body: Record<string, unknown>) => void;
  close(): Promise<void>;
}

async function stubSite(): Promise<Stub> {
  const runs: Array<Record<string, unknown>> = [];
  const cancels: string[] = [];
  let pending: { res: ServerResponse; release: (b: Record<string, unknown>) => void } | undefined;
  const site = await serveSite({
    // 发**仓库里那份真 index.html**：import map 是前端唯一的 HTML，
    // 夹具自己手写一份的话，线上那份写坏了这里也测不出来
    index: { file: 'packages/web/static/index.html' },
    api: (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
      const p = url.pathname;
      if (p === '/api/scenario' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(SCENARIO, null, 2));
        return true;
      }
      if (p === '/api/run' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          runs.push(body);
          // **挂着不回**，直到测试调 release。见文件头那段
          let done = false;
          pending = {
            res,
            release: (b: Record<string, unknown>) => {
              if (done) throw new Error('夹具：同一条 /api/run 被放开两次');
              done = true;
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(b));
            },
          };
        });
        return true;
      }
      if (p === '/api/cancel' && req.method === 'POST') {
        cancels.push(url.searchParams.get('jobId') ?? '');
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jobId: url.searchParams.get('jobId'), state: 'running', actedOn: true, alreadyCancelled: false }));
        return true;
      }
      return false;
    },
  });
  return {
    site, runs, cancels,
    release: (b) => {
      if (!pending) throw new Error('夹具：还没有 /api/run 到达，没有可放开的响应');
      const p = pending; pending = undefined;
      p.release(b);
    },
    close: () => site.close(),
  };
}

const click = (sel: string): string => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'NO_NODE'; el.click(); return 'OK'; })()`;

/* 找不到浏览器时的跳过由 `browserTest` 本身承担（test.skip 在报告里显式标成 skipped，
   而 harness 另外往 stderr 写了一行原因）。这里刻意**不再**补一条"已跳过"的测试：
   那会让同一件事出现两种写法，而其中一种在 --test-reporter 的报告里长得像通过。 */

browserTest('点"运行"就真的挂出取消按钮，点它就以**提交时那个 jobId**打到 /api/cancel', async () => {
  const s = await stubSite();
  const { cdp, kill } = await openPage(s.site);
  try {
    await cdp.send('Page.navigate', { url: `${s.site.url}#/scenario/scn.ui` });
    await evalWait(cdp, `document.querySelector('#run-btn')`, 20_000);

    // ── 1. 点运行：按钮必须在 **run 还挂着** 的时候就出现 ──
    assert.equal(await evalOnce(cdp, click('#run-btn')), 'OK');
    await evalWait(cdp, `document.querySelector('[id^="cancel-"]')`, 5_000);
    assert.equal(s.runs.length, 1, '点了运行而桩没收到 /api/run：前端那一格根本没发请求');

    const jobId = s.runs[0]!.jobId;
    assert.equal(typeof jobId, 'string', `提交体里没有 jobId（${JSON.stringify(s.runs[0])}）。`
      + '没有 jobId，服务端那一格就只能回 cancellable:false，屏幕上这个按钮点了永远没用 —— '
      + '而 run-job.test.ts 里那条"提交带 jobId"是绿的，因为它测的是模块，不是这个按钮');

    // ── 2. 取消按钮**认得出自己那条 job**：id 里带的就是提交出去的 jobId ──
    assert.ok(await evalOnce(cdp, `!!document.querySelector(${JSON.stringify(`#cancel-${jobId}`)})`),
      `挂出的按钮 id 不对着提交出去的 jobId（${jobId}）。同屏多条 run 时，`
      + '按钮只能靠 id 认自己那条 —— 靠文字认的话"取消中…"一变就认错');

    assert.equal(await evalOnce(cdp, click(`#cancel-${jobId}`)), 'OK');
    await evalWait(cdp, `document.querySelector('#cancel-${jobId}').textContent === '已请求取消'`, 5_000);

    // ── 3. 真的打到了 /api/cancel，且带的是**同一个** jobId ──
    assert.deepEqual(s.cancels, [String(jobId)],
      `/api/cancel 收到的 jobId 与提交时那个不是一套（收到 ${JSON.stringify(s.cancels)}，提交 ${String(jobId)}）。`
      + '取消错对象比没有取消更坏：人以为停的是自己刚跑的那条');

    // ── 4. 屏幕上那句话是 run-job 给的那一句，**没被 app 覆盖成"已取消"** ──
    const note = String(await evalOnce(cdp, `document.querySelector(${JSON.stringify(`#job-${jobId}`)}).textContent`));
    assert.match(note, /取消已送达/, `提示语不对：${note}`);
    assert.match(note, /下一步开头/, `跑动中那一档必须说"下一步开头停下"：${note}`);
    assert.match(note, new RegExp(String(jobId)),
      `那句话里没带 jobId（${note}）。同屏可能有多条 run，不说哪条就等于误导`);
    assert.doesNotMatch(note, /已取消(?!）)/,
      `"${note}" 里那句"已取消"是三档里没有任何一档为真的断言。app.ts 不许覆盖 requestCancel 的措辞`);

    // ── 5. run 结束后按钮自己消失（留着它就是一张"点了没东西可停"的空按钮）──
    s.release({ exitCode: 0, output: 'done', jobId });
    await evalWaitGone(cdp, `document.querySelector('#cancel-${jobId}')`, 5_000);
    assert.match(
      String(await evalOnce(cdp, `document.querySelector(${JSON.stringify(`#job-${jobId}`)}).textContent`)),
      /退出码 0/, 'run 结束后那一句要落到结论上，不能停在"取消已送达"');
  } finally {
    kill();
    await s.close();
  }
});

browserTest('跑动中点"校验"不会把取消按钮从屏幕上抹掉', async () => {
  /*
   * 这条测的是**载体被另一个功能的正常重绘干掉**这一类失效 —— app.ts 里 runCheck 用
   * `statusLine.replaceChildren(...)` 画校验结论，而"改完文本顺手点一下校验"是真会发生的
   * 动作，那时一条 run 常常还在跑。第一版里跑动状态就挂在 statusLine 上，于是那次
   * replaceChildren 会把取消按钮连同它那条 job 一起删掉：屏幕上什么都不剩，人只会
   * 以为"取消这个功能坏了"。现在它挂在另一行（runLine），这条钉住。
   *
   * 判据不用"按钮还在" alone —— 校验本身是异步的（checkIr 里要过引擎），
   * 所以正着断言"校验结论已经画出来了"**并且**"按钮还在同一时刻还在"。
   * 只断言后者会绿于一种错法：校验根本没跑完。
   */
  const s = await stubSite();
  const { cdp, kill } = await openPage(s.site);
  try {
    await cdp.send('Page.navigate', { url: `${s.site.url}#/scenario/scn.ui` });
    await evalWait(cdp, `document.querySelector('#run-btn')`, 20_000);
    assert.equal(await evalOnce(cdp, click('#run-btn')), 'OK');
    await evalWait(cdp, `document.querySelector('[id^="cancel-"]')`, 5_000);
    const jobId = s.runs[0]!.jobId;

    assert.equal(await evalOnce(cdp, click('#check-btn')), 'OK');
    // 校验这一格**自己画完了**（它是异步的：等它画完再断言按钮，否则"按钮还在"
    // 只证明校验还没轮到重绘，什么也没测）
    await evalWait(cdp, `document.querySelector('#status-line').children.length > 0`, 20_000);
    assert.ok(await evalOnce(cdp, `!!document.querySelector(${JSON.stringify(`#cancel-${jobId}`)})`),
      '点校验把取消按钮抹掉了：跑动状态不许和校验结论共用一行');
    assert.ok(await evalOnce(cdp, `!!document.querySelector(${JSON.stringify(`#job-${jobId}`)})`),
      '跑动中那句话（带着 jobId）也被抹掉了：人此后看不见这条 job 的存在，连它还在跑都不知道');
    // 而且这时取消**还能用** —— 载体在不在，最终要看它还能不能打到服务端
    const before = s.cancels.length;
    assert.equal(await evalOnce(cdp, click(`#cancel-${jobId}`)), 'OK');
    await evalWait(cdp, `document.querySelector('#cancel-${jobId}').textContent === '已请求取消'`, 5_000);
    assert.equal(s.cancels.length, before + 1, '按钮挂在屏幕上却没接上：那是画出来的装饰');

    s.release({ exitCode: 0, output: 'done', jobId });
  } finally {
    kill();
    await s.close();
  }
});

browserTest('取消没生效时按钮要能再点（报成"已请求取消"会逼人以为停了）', async () => {
  /*
   * 404 那一档在真界面上是会出现的：`/api/run` 先读请求体才登记 job，
   * 点完运行**立刻**点取消就可能抢在它前面。此时界面上如果显示"已请求取消"，
   * 人就以为停下了，而那条 run 会一路跑完（里面可能有 POST/下单/删除）。
   * 所以这一格要的是：话要说"服务端还不认"，按钮要**可以再点**。
   */
  let releaseRun: ((b: Record<string, unknown>) => void) | undefined;
  const site = await serveSite({
    index: { file: 'packages/web/static/index.html' },
    api: (req, res, url) => {
      const p = url.pathname;
      if (p === '/api/scenario') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(SCENARIO)); return true; }
      if (p === '/api/run') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          let done = false;
          releaseRun = (b: Record<string, unknown>) => {
            if (done) throw new Error('夹具：同一条 /api/run 被放开两次');
            done = true;
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(b));
          };
        });
        return true;
      }
      if (p === '/api/cancel') {
        res.writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: '没有登记过这个 jobId（从未提交，或结束后被后续 job 挤出了表）' }));
        return true;
      }
      return false;
    },
  });
  const { cdp, kill } = await openPage(site);
  try {
    await cdp.send('Page.navigate', { url: `${site.url}#/scenario/scn.ui` });
    await evalWait(cdp, `document.querySelector('#run-btn')`, 20_000);
    assert.equal(await evalOnce(cdp, click('#run-btn')), 'OK');
    await evalWait(cdp, `document.querySelector('[id^="cancel-"]')`, 5_000);

    assert.equal(await evalOnce(cdp, click(`[id^="cancel-"]`)), 'OK');
    await evalWait(cdp, `document.querySelector('[id^="cancel-"]').textContent === '取消没生效'`, 5_000);

    const btnId = String(await evalOnce(cdp, `document.querySelector('[id^="cancel-"]').id`));
    const jobId = btnId.replace(/^cancel-/, '');
    const note = String(await evalOnce(cdp, `document.querySelector(${JSON.stringify(`#job-${jobId}`)}).textContent`));
    assert.match(note, /服务端还不认|没送出去/, `404 要说清是哪一种，不能含糊：${note}`);
    assert.doesNotMatch(note, /已取消(?!）)/, `"${note}"：取消没生效却显示"已取消"，人会以为那条 run 停了`);
    // 可以再点：404 是**慢一拍**的常态，禁用按钮等于逼人先去刷新页面
    assert.equal(await evalOnce(cdp, `document.querySelector(${JSON.stringify(`#${btnId}`)}).disabled`), false,
      '取消没生效之后按钮还是禁用的，人只能刷新页面 —— 而刷新会把正在跑的那条 job 的提示一起清掉');

    releaseRun?.({ exitCode: 0, output: 'done', jobId });
    await evalWaitGone(cdp, `document.querySelector('[id^="cancel-"]')`, 5_000);
  } finally {
    kill();
    await site.close();
  }
});
