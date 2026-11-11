/**
 * 取消那条路**端到端**：真服务端 + 真 CLI + 真引擎 + 一个能卡住的靶服务。
 *
 * ## 为什么单独开这个文件（而不往 evidence-http.test.ts 里加两条）
 *
 * 那个文件测的是"产物点得开"，夹具形状是**先跑完、再起服务端**。取消要的形状正相反：
 * **服务端正在跑、而人正在同时操作它**。所以夹具得能"握住一条 run"
 * （靶服务不返回响应），并且能在 run 进行中发第二个 HTTP 请求。
 *
 * ## 这一族测试要防的那一件事
 *
 * 取消的代码**看起来**已经全了：端点有、标志有、`checkAbort` 有、退出码 10 有。
 * 而"看起来全"在这个仓里从来不是证据 —— docs/14 §3 那一族的定义正是
 * "每一段各自都在，中间没人接"。所以逐段钉，每段都写清"少了它会看见什么"：
 *
 *  1. **排队中被取消 => 一个请求都不发**。docs/02 §5 不可逆动作纪律在这一格上的形状。
 *  2. **跑动中被取消 => 退出码 10 + 包里写 cancelled + teardown 照跑 + 后面的步骤不发**。
 *  3. **注入了 `io.abortSignal` 的宿主里，信号仍然砍得动**（两条来源是**或**）。
 *     合成写坏成"只认注入的那个"时，服务端上的 Ctrl-C 静默失效 —— 而 CLI 自己的
 *     测试**永远不注入**那个字段（`signal.test.ts` 走纯信号路径），所以那些测试
 *     **一条都不会红**。这一格只有这里能测。
 *  4. **取消不会砍错对象**（id 撞上活的 job 报 409，不静默覆盖）。
 *  5. **"取消一个刚跑完的 run"既不被报成错误、也不被报成取消成功**。
 *
 * ## 靶服务为什么自己写而不用 `startMockServer`
 *
 * mock 的能力是"按 spec 立刻回一份合规响应"，而这里要的是**握住响应不放**
 * （把人操作那几秒撑开）。那是夹具的时序控制，不是被测能力。
 * 顺带一条：`hits` 由夹具自己记，"一个请求都没发"这句断言才不依赖被测方的计数。
 *
 * ## 时序：为什么"先 await 取消、再放开握手"就够，不需要在请求处理器里发信号
 *
 * 我先前写的是靶服务在**回响应之前**反向 POST 一次取消，怕的是"标志置位晚于第 2 步开头"。
 * 那个担心是多余的，而那套机械是有代价的（夹具自己发请求、自己判成功，出错时归因先落到夹具上）：
 * 只要测试 `await` 完 `POST /api/cancel` 再放开响应，标志在**放开那一刻之前**就已置位，
 * 而引擎只可能在放开之后才走到第 2 步开头。顺序由 await 保证，不由时序赌。
 *
 * ## 服务端为什么能在**本进程**里被 SIGINT 砍到
 *
 * `startServer` 与 `main()` 同进程（见 server 文件头"一层翻译"），所以 `cmdRun`
 * 装的信号处理器就在测试进程里。第 5 条据此在 run 进行中 `process.emit('SIGINT')` ——
 * 与"运维对着这个服务按 Ctrl-C"是同一条代码路径。用 emit 不用 kill：后者会真打死测试进程。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EXIT, HANDLED_SIGNALS } from '@atest/cli';
import { readZipEntries } from '@atest/store';

import { FINISHED_KEEP, startServer, type RunningServer } from '../src/index.js';

/* ── 夹具 ───────────────────────────────────────────────────────────────── */

interface Res { status: number; body: Record<string, unknown>; text: string }

interface Harness {
  dir: string;
  srv: RunningServer;
  /** 靶服务收到的路径，按到达顺序。"一个请求都不发"就断这里 */
  hits: string[];
  /** 放开那个被握住的响应 */
  release(): void;
  post(path: string, body?: unknown): Promise<Res>;
  get(path: string): Promise<Res>;
  /** 等靶服务收到某个路径。轮询而不是 sleep：短了 flaky，长了拖慢整套 */
  waitHit(path: string): Promise<void>;
  /** 等表里出现某个 job 且到达某个状态。见 test 1 里"为什么不能直接读 /api/jobs" */
  waitJob(jobId: string, state: string): Promise<void>;
  /** 取消 + 放开 + 等 run 回来。三步在每条"跑动中取消"的用例里都是同一串，所以合成一个 */
  cancelThenRelease(jobId: string, run: Promise<Res>): Promise<Res>;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-srv-cancel-'));

  // ── 靶服务：`/hold` 握住不回，其余立刻 200
  const hits: string[] = [];
  let gate: (() => void) | undefined;
  const range: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    hits.push(path);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (path !== '/hold') { res.end('{"ok":true}'); return; }
    // 握住：run 会停在第 1 步里，直到测试调 release()
    void new Promise<void>((r) => { gate = r; }).then(() => res.end('{"ok":true}'));
  });
  await new Promise<void>((r) => range.listen(0, '127.0.0.1', r));
  const rangeUrl = `http://127.0.0.1:${(range.address() as AddressInfo).port}`;

  // ── 一个最小项目。**baseUrl 只能从环境文件来**：`/api/run` 不转发它（只转发 env / inputs），
  //    所以"把场景指到靶服务"这件事必须在盘上做，而这正好也是真实用户的做法。
  await mkdir(join(dir, 'env'), { recursive: true });
  await mkdir(join(dir, 'cases'), { recursive: true });
  await writeFile(join(dir, 'atest.json'), JSON.stringify({
    irDir: 'cases', envDir: 'env', evidenceDir: 'evidence', defaultEnv: 'local',
  }), 'utf8');
  await writeFile(join(dir, 'env', 'local.json'), JSON.stringify({ baseUrl: rangeUrl }), 'utf8');
  const scen = (id: string, body: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({
    schemaVersion: '1', id, name: id, env: { environmentRef: 'unit' }, body, ...extra,
  });
  // 长的那条：第 1 步会被握住；`/after-cancel` 是"取消之后不该再出现"的部分；td 是"该照跑"的部分
  await writeFile(join(dir, 'cases', 'slow.json'), scen('slow', [
    { id: 's1', kind: 'http', request: { method: 'GET', url: '/hold' } },
    { id: 's2', kind: 'http', request: { method: 'GET', url: '/after-cancel' } },
    { id: 's3', kind: 'assert', against: '$.step.s1.resp', status: 200 },
  ], { teardown: [{ id: 'td', kind: 'set', assign: { cleaned: true } }] }), 'utf8');
  // 排队用的那条：靶点是 `/queued-hit`，"一个请求都不发"就数这个名字
  await writeFile(join(dir, 'cases', 'quick.json'), scen('quick', [
    { id: 'q1', kind: 'http', request: { method: 'GET', url: '/queued-hit' } },
    { id: 'q2', kind: 'assert', against: '$.step.q1.resp', status: 200 },
  ]), 'utf8');
  // 最短的那条：不发任何请求、立刻结束，用来造"取消一个刚结束的 job"
  await writeFile(join(dir, 'cases', 'short.json'), scen('short', [
    { id: 'p1', kind: 'set', assign: { n: 1 } },
    { id: 'p2', kind: 'assert', against: '$n', expr: '$n == 1' },
  ]), 'utf8');

  // ── 被测服务端
  const srv = await startServer({ cwd: dir, port: 0 });

  const parse = async (res: Response): Promise<Res> => {
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 断言里用 text 原样报 */ }
    return { status: res.status, body, text };
  };
  const post = async (path: string, body?: unknown): Promise<Res> => parse(await fetch(`${srv.url}${path}`,
    body === undefined ? { method: 'POST' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  // `get` 要像 `post` 一样是个**局部常量**：写成下面对象字面量里的方法，
  // waitJob 里那句 `get(...)` 就闭不到它（实测报 `get is not defined`，
  // 而它长得像被测服务端坏了）。
  const get = async (path: string): Promise<Res> => parse(await fetch(`${srv.url}${path}`));

  return {
    dir, srv, hits,
    release() { const g = gate; gate = undefined; g?.(); },
    post,
    get,
    async waitHit(path: string) {
      const t0 = Date.now();
      for (;;) {
        if (hits.includes(path)) return;
        if (Date.now() - t0 > 20_000) throw new Error(`等不到靶服务收到 ${path}。已收到：${hits.join(', ') || '无'}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async waitJob(jobId, state) {
      const t0 = Date.now();
      let last = '';
      for (;;) {
        const r = await get('/api/jobs');
        const items = (r.body.items ?? []) as Array<{ jobId: string; state: string }>;
        last = items.map((j) => `${j.jobId}:${j.state}`).join(', ') || '空';
        if (items.some((j) => j.jobId === jobId && j.state === state)) return;
        if (Date.now() - t0 > 20_000) throw new Error(`等不到 ${jobId} 进入 ${state}。当前：${last}`);
        await new Promise((r2) => setTimeout(r2, 20));
      }
    },
    async cancelThenRelease(jobId, run) {
      const c = await post(`/api/cancel?jobId=${jobId}`);
      // 夹具自检：这一刀没砍到活着的 run 的话，下面所有"被取消了"的断言
      // 其实是在测"正常跑完"，那才是本文件最坏的失败模式
      assert.equal(c.status, 200, `夹具：取消 ${jobId} 失败。${c.text}`);
      assert.equal(c.body.actedOn, true, `夹具：取消 ${jobId} 没有作用对象。${c.text}`);
      /*
       * **放开**握住的响应，然后才等 run。这一行我第一版漏了，而症状很有欺骗性：
       * 名字写着 release、断言也全对，run 却挂在靶服务里直到 http 那侧 30s 超时，
       * 于是退出码是 5（运行异常）而不是 10，报出来像"取消没生效"。
       * 顺序也是判据的一部分：**先取消、再放开**，标志才可能在第 2 步开头之前置好位。
       */
      gate?.();
      gate = undefined;
      return run;
    },
    async close() {
      gate?.();                                  // 别让靶服务挂着连接不放
      await new Promise<void>((r) => range.close(() => r()));
      await srv.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const num = (o: Record<string, unknown>, k: string): number | undefined => o[k] as number | undefined;

/** 证据目录里那个**唯一** run 目录的包内成员 */
async function memberOf(evidenceDir: string, member: string): Promise<{ zipName: string; text: string }> {
  const names = (await readdir(evidenceDir)).filter((n) => n !== 'artifacts');
  assert.equal(names.length, 1, `证据目录下应只有一个 run 目录，实际 ${names.join(',')}`);
  const runDir = join(evidenceDir, names[0]!);
  const zipName = (await readdir(runDir)).find((n) => n.startsWith('evidence.') && n.endsWith('.zip'));
  assert.ok(zipName, `${runDir} 下没有 evidence*.zip：${(await readdir(runDir)).join(',')}`);
  const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zipName!))));
  const e = entries.find((x) => x.name === member);
  assert.ok(e, `包里没有 ${member}：${entries.map((x) => x.name).join(',')}`);
  return { zipName: zipName!, text: new TextDecoder().decode(e.data) };
}

/* ── 1. 排队中被取消 ─────────────────────────────────────────────────────── */

test('排队中的 job 被取消：一个请求都不发，退出码 10，也不留下 run 目录', async () => {
  /*
   * 这是这一格最重要的一条，也最容易被"反正引擎会停"糊过去。
   * 只靠引擎那个 `checkAbort` 的话，被取消的 job 轮到时**照样装配**（连库、起浏览器）
   * 并跑到第一步开头 —— 而场景第一步可能就是下单。所以判据不是"退出码对"，
   * 是**靶服务一个请求都没收到**。
   */
  const h = await harness();
  try {
    // 先占住串行队列：slow 的第 1 步握住不回，于是 quick 只能排队
    const slowRun = h.post('/api/run', { scenario: 'slow', jobId: 'slow1' });
    await h.waitHit('/hold');

    const quickRun = h.post('/api/run', { scenario: 'quick', jobId: 'quick1' });
    // 排队这件事要**看得见**。不然"它还没跑"与"服务把它吞了"在界面上一模一样。
    // 必须先 waitJob 再读：`/api/run` 是**先 await 完请求体**才 `jobs.add` 的，
    // 于是那个 job 进表落在下一个事件循环轮次之后，直接读会看到空表
    // （我第一版就是这么写的，报出来的错长得像 `/api/jobs` 自己写坏了）
    await h.waitJob('quick1', 'queued');
    const jobs = await h.get('/api/jobs');
    const listed = jobs.body.items as Array<{ jobId: string; state: string }>;
    assert.deepEqual(
      listed.map((j) => `${j.jobId}:${j.state}`).sort(),
      ['quick1:queued', 'slow1:running'],
      `/api/jobs 要能区分排队与在跑：${JSON.stringify(listed)}`,
    );

    const c = await h.post('/api/cancel?jobId=quick1');
    assert.equal(c.status, 200, c.text);
    assert.equal(c.body.state, 'queued', '取消那一刻它还在排队，这件事要说得出');
    assert.equal(c.body.actedOn, true, '排队中的 job 也算"取消有作用对象"—— 它因此压根不会开工');

    // 放开 slow（它自己在跑，被信号之外的那条路砍），队列才会走到 quick
    const slowResp = await h.cancelThenRelease('slow1', slowRun);
    assert.equal(num(slowResp.body, 'exitCode'), EXIT.ABORTED, `夹具：slow 该被取消。${slowResp.text}`);

    const quickResp = await quickRun;
    // ① 正题：一个请求都没发
    assert.equal(h.hits.filter((x) => x === '/queued-hit').length, 0,
      `排队中被取消的 job 不许发任何请求（不可逆动作纪律）：${h.hits.join(', ')}`);
    // ② 退出码。"被挡在开工前"与"跑了一半被砍"共用 ABORTED，而它俩的区别由下面那句话给
    assert.equal(num(quickResp.body, 'exitCode'), EXIT.ABORTED, quickResp.text);
    /*
     * ③ **这一条才是钉住服务端这道闸的**，而它一开始并不长这样。
     *
     * 我原先写的是 `match(output, /一个请求都没发/)`，然后拿它做负控
     * （把 `claimStart` 里那句取消判定删掉）—— **测试照样绿**。
     * 原因是 `cmdRun` 循环开头自己还有一道 `if (abortSignal.aborted) skip`，
     * 而它会打「本次运行被取消：N 个场景**一个请求都没发**」。
     * 于是"请求数为 0 / 码为 10 / 没有 run 目录"这三件事**两道闸各自都能独立做到**，
     * 拿它们当判据等于"夹具分不出两种实现"（docs/08 §3 那一族的第二个亚种）。
     *
     * 两者唯一分得开的地方是**这句话是谁说的**：
     *  · 这道闸生效 => `main` 一次都不调，输出里只有服务端自己那一句；
     *  · 这道闸坏了 => `main` 被调，「已跳过 …」与收尾那句 CI 码表一定跟着来。
     * 所以正向验自己那句、反向验 cmdRun 那几句**不出现**。
     * （这不是"顺便测个字符串"：「已跳过」是 main 被调用之后才会有的声音，
     *   它的缺席就是"一次都没开工"的证据。）
     */
    assert.match(String(quickResp.body.output), /开工前已被取消/, quickResp.text);
    assert.doesNotMatch(String(quickResp.body.output), /已跳过/,
      '输出里有 cmdRun 那句「已跳过」= main 被调用了，服务端这道开工前的闸没生效');
    assert.doesNotMatch(String(quickResp.body.output), /退出码：0 全绿/,
      '同上：那句 CI 码表提示只由 main 的收尾打印');
    // ④ 开工前取消的那条**不产生 run 目录**（一次都没开始，没有 report 可写），
    //    所以证据目录里只剩 slow 那一个 run。少这一句的话，
    //    "它其实跑了、只是没产物"这种形状就没人管。
    const dirs = (await readdir(join(h.dir, 'evidence'))).filter((n) => n !== 'artifacts');
    assert.equal(dirs.length, 1, `开工前取消的 job 不该留下 run 目录，实际：${dirs.join(',')}`);
  } finally { await h.close(); }
});

/* ── 2. 跑动中被取消 ─────────────────────────────────────────────────────── */

test('跑动中被取消：退出码 10、包写 aborted/cancelled、teardown 照跑、后面的步骤不发请求', async () => {
  const h = await harness();
  try {
    const run = h.post('/api/run', { scenario: 'slow', jobId: 'r1' });
    await h.waitHit('/hold');
    const resp = await h.cancelThenRelease('r1', run);

    assert.equal(resp.status, 201, resp.text);
    assert.equal(num(resp.body, 'exitCode'), EXIT.ABORTED, `实际码 ${num(resp.body, 'exitCode')}。${resp.text}`);
    assert.equal(resp.body.jobId, 'r1');
    assert.equal(resp.body.cancelRequested, true, '这一刀确实来自 /api/cancel');

    // 取消**之后**的步骤没跑：第 2 步那个靶点一次都不该出现
    assert.equal(h.hits.filter((x) => x === '/after-cancel').length, 0,
      `第 2 步还在发请求，说明取消没停在步与步之间：${h.hits.join(', ')}`);

    const zip = await memberOf(join(h.dir, 'evidence'), 'manifest.json');
    // 包名要说被中断（人只 ls 也要看得懂）
    assert.match(zip.zipName, /^evidence\..+\.aborted\.zip$/, `包名：${zip.zipName}`);
    const manifest = JSON.parse(zip.text) as { aborted?: { kind?: string }; status?: string };
    assert.equal(manifest.aborted?.kind, 'cancelled', JSON.stringify(manifest.aborted));
    // status 保持**已完成步骤**的结论（设计，不是漏写；见 RunReport.aborted）
    assert.equal(manifest.status, 'pass');

    const junit = (await memberOf(join(h.dir, 'evidence'), 'junit.xml')).text;
    assert.ok(!junit.includes('name="s2"'), `取消后的步骤不许进 JUnit：${junit}`);
    // teardown **跑了**。这条是"第一次信号为什么不能当场死掉"那整段理由在这一格上的复现
    assert.match(junit, /name="td"/, `清理必须跑完，否则环境里留下没人认领的脏数据。junit=${junit}`);
  } finally { await h.close(); }
});

/* ── 3. 取消的对象不会错 ─────────────────────────────────────────────────── */

test('jobId 撞上还没结束的 job：409，且不静默覆盖（覆盖了会砍错人）', async () => {
  /*
   * 覆盖了会怎样：后一个人提交同名 job，前一个人点取消 => **砍掉的是后一个人的 run**。
   * 取消错对象比不能取消坏得多，所以这一格宁可不给跑。
   */
  const h = await harness();
  try {
    const first = h.post('/api/run', { scenario: 'slow', jobId: 'same' });
    await h.waitHit('/hold');

    // 撞名的那条用 quick：它**会**发请求，所以"被拒了还照跑"能被 hits 抓到
    const dup = await h.post('/api/run', { scenario: 'quick', jobId: 'same' });
    assert.equal(dup.status, 409, `同名且未结束的 job 要拒。${dup.text}`);
    assert.match(dup.text, /占用/);
    assert.equal(h.hits.filter((x) => x === '/queued-hit').length, 0,
      `409 拒绝了却照跑 = 假拒：${h.hits.join(', ')}`);

    // 原来那条仍然砍得动 —— 证明表里留下的还是**它**，不是被换掉的空壳
    const resp = await h.cancelThenRelease('same', first);
    assert.equal(num(resp.body, 'exitCode'), EXIT.ABORTED, resp.text);
  } finally { await h.close(); }
});

/* ── 4. 取消的落点要说真话 ───────────────────────────────────────────────── */

test('取消一个刚跑完的 job：200 + actedOn:false，既不报错误也不报"取消成功"', async () => {
  /*
   * 两半都要钉：
   *  · 回 409 的话，人手慢一拍点按钮会被读成"取消失败"，于是去按第二下；
   *  · 回 `accepted:true` 的话（我第一版就是这么写的），字面意思是"你的取消被受理"，
   *    而真相是"没东西可取消"。一个词同时表达"第一次收到"与"真的砍到了东西"，
   *    而这两半在 state=done 时**恰好相反** —— 所以它们必须是两个字段。
   */
  const h = await harness();
  try {
    const done = await h.post('/api/run', { scenario: 'short', jobId: 'done1' });
    assert.equal(num(done.body, 'exitCode'), 0, done.text);

    const c = await h.post('/api/cancel?jobId=done1');
    assert.equal(c.status, 200, `已结束也回 200，不然慢一拍的按钮像取消失败。${c.text}`);
    assert.equal(c.body.state, 'done');
    assert.equal(c.body.actedOn, false, '"有没有 run 因为这一下停下"要如实为 false');
    assert.equal(c.body.alreadyCancelled, false, '这是第一次对它点取消');
    assert.equal('accepted' in c.body, false, '不许再有一个词同时表达"第一次收到"和"砍到了东西"');
  } finally { await h.close(); }
});

test('取消一个从未提交过的 jobId：404，而且不说它"已经结束"', async () => {
  /*
   * 上一版的文案是「没有这个 job（或它已经结束了）」—— 那是**假归因**：
   * 压根没登记过的 id 走同一句话，人会以为"我提交过、它跑完了"，
   * 而真相常常是"我那个请求没提交成功 / 我把 id 拼错了"。
   */
  const h = await harness();
  try {
    const c = await h.post('/api/cancel?jobId=never-submitted');
    assert.equal(c.status, 404, c.text);
    assert.match(c.text, /登记|从未提交/);
    assert.doesNotMatch(c.text, /已经(结束|跑完)/, '没登记过 ≠ 跑完了，两件事不能共用一句话');
    // id 会进日志、也可能进文件名，形状这一关照旧收紧
    for (const bad of ['', '..', 'a/b', '../x', 'x'.repeat(65), '_lead']) {
      const r = await h.post(`/api/cancel?jobId=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `jobId "${bad}" 该被形状检查拦下。${r.text}`);
    }
  } finally { await h.close(); }
});


test('提交侧也拦坏 jobId：否则那条 job 取消不掉，而按钮只回 400', async () => {
  /*
   * **入口那一侧也要钉，而这条是补出来的**：我原先只在 cancel 上探坏 id，
   * 于是把 `/api/run` 里那句形状检查删掉之后，本文件**一条都不红**。
   * 后果不是理论上的：坏 id 一旦登记进表，cancel 那一侧同一张正则就**永远拒绝**它 ——
   * 于是那条 job 变成"跑起来了但谁也取消不了"，而人手里那个按钮按下去是 400。
   * （它不会变成路径穿越：证据目录名来自引擎算的 runId，不来自 jobId。
   *   所以这一格买的是"取消的落点必须可达"，不是防穿越 —— 别把它当那道闸写。）
   */
  const h = await harness();
  try {
    for (const bad of ['a/b', '../x', '..', '_lead', 'x'.repeat(65)]) {
      const r = await h.post('/api/run', { scenario: 'short', jobId: bad });
      assert.equal(r.status, 400, `提交侧也该拦下 jobId "${bad}"。${r.text}`);
      assert.match(r.text, /jobId/);
    }
    // 拦下了就**不该登记进表**（登记了却拒绝执行 = 表里多一条取消不掉的僵尸）
    const jobs = await h.get('/api/jobs');
    assert.deepEqual(jobs.body.items, [], `被拒的 jobId 不该出现在表里：${JSON.stringify(jobs.body.items)}`);
  } finally { await h.close(); }
});

test('不给 jobId 就照常跑，但明说不可取消（而不是回一个拿不到的 id）', async () => {
  /*
   * `POST /api/run` 阻塞到 run 结束才回，所以**服务端造的 id 送不出去**（见端点那段）。
   * 少了 `cancellable:false` 这个载体，"我忘了传 jobId"在前端与"取消没生效"一模一样。
   */
  const h = await harness();
  try {
    const r = await h.post('/api/run', { scenario: 'short' });
    assert.equal(num(r.body, 'exitCode'), 0, r.text);
    assert.equal(r.body.cancellable, false, r.text);
    assert.equal('jobId' in r.body, false, '不可取消时不许回一个假的 jobId');
  } finally { await h.close(); }
});

test('jobId 被复用后，淘汰不会把**新那条**从表里删掉（否则它 404、取消不掉）', async () => {
  /*
   * 形状：CI 拿构建号当 jobId 是正常用法，于是同一个 id 会"结束 → 再提交 → 再结束"。
   * 我第一版的淘汰记的是 **id 队列**：同一个 id 被 push 两次，而表里那个键
   * 此时指向的是**后来那一条**，于是淘汰老记录时删掉的是新 job。
   * 症状离被测功能很近、离真因很远："我刚提交的那条按取消是 404"，
   * 而看起来像取消功能坏了，不像淘汰逻辑坏了。
   *
   * 判据用 FINISHED_KEEP 现算而不是写死 50：那个上限改了之后，写死的测试会
   * 安静地不再越过边界（本仓对会漂的数的规矩是现算，不重述）。
   */
  const h = await harness();
  try {
    // 先攒满 FINISHED_KEEP 条已结束的（都发一次真 run，走真收尾）
    for (let i = 0; i < FINISHED_KEEP; i++) {
      const r = await h.post('/api/run', { scenario: 'short', jobId: `b${i}` });
      assert.equal(r.body.exitCode, 0, `第 ${i} 条没跑成：${r.text}`);
    }
    // 复用一个已经结束的 id（`add` 允许 —— 只有**还没结束**的同名 job 才 409）
    const again = await h.post('/api/run', { scenario: 'short', jobId: 'b0' });
    assert.equal(again.body.exitCode, 0, `复用 id 被拒了：${again.text}`);

    // 此刻淘汰刚发生。被淘汰的该是**最老那条记录**，而不是被复用的那一条
    const jobs = await h.get('/api/jobs');
    const items = jobs.body.items as Array<{ jobId: string; state: string }>;
    const mine = items.find((j) => j.jobId === 'b0');
    assert.ok(mine, '复用了 id 的那条 job 必须还在表里（它刚结束，正是"我刚那个 job 怎么样了"要答的那条）');
    assert.equal(mine!.state, 'done');

    // 而它必须**仍然点得动取消**：表里没有 → 404 → 人只能 kill 进程
    const c = await h.post('/api/cancel?jobId=b0');
    assert.equal(c.status, 200, `刚复用过的 job 按取消却是 ${c.status}：${c.text}`);
    assert.equal(c.body.actedOn, false, '它已经结束了，这一下没有作用对象');
    // 表不会无界长（淘汰确实还在工作，只是不再删错人）
    assert.ok(items.length <= FINISHED_KEEP, `表里留了 ${items.length} 条，上限应是 ${FINISHED_KEEP}`);
  } finally { await h.close(); }
});

/* ── 5. 两条取消来源是「或」 ─────────────────────────────────────────────── */

test('宿主注入了取消位时，Ctrl-C 仍然砍得动（合成写成 OR，不是二选一）', async () => {
  /*
   * `cmdRun` 把信号与 `io.abortSignal` 合成一个标志交给下游。写坏成"只认注入的那个"
   * 之后会发生什么：服务端宿主里 Ctrl-C **静默失效** —— 而 CLI 自己的测试永远不注入
   * 那个字段，所以那些测试一条都不会红。这正是"每个消费者各自正确、而假设互不相容"
   * 的形状，也只有走服务端这一格能测到（CLI 侧的 io.abortSignal 是测试手搓的）。
   *
   * 做法：run 在飞（靶服务握住响应）期间对本进程 emit SIGINT。
   * `startServer` 与 `main()` 同进程，处理器就在场。用 emit 不用 kill：后者会打死测试进程。
   */
  const h = await harness();
  const before = HANDLED_SIGNALS.map((s) => process.listeners(s).length);
  try {
    const run = h.post('/api/run', { scenario: 'slow', jobId: 'sig1' });
    await h.waitHit('/hold');
    (process.emit as (n: string, a?: unknown) => boolean)('SIGINT', 'SIGINT');
    h.release();
    const resp = await run;

    assert.equal(num(resp.body, 'exitCode'), EXIT.ABORTED,
      `信号砍不断注入了 abortSignal 的 run —— 合成大概被写成了"只认注入的那个"。${resp.text}`);
    assert.match(String(resp.body.output), /收到 SIGINT/, '第一次按键要有反馈，否则人会再按一次');
    // 归因不能骗人：这一刀来自信号，所以端点那条**没有**下过刀
    assert.equal(resp.body.cancelRequested, false, '"是不是 /api/cancel 砍的"要如实为 false');
    // 泄漏哨兵：cmdRun 的 finally 必须把它那套摘干净（常驻进程里漏摘 = 进程对 Ctrl-C 免疫）
    assert.deepEqual(HANDLED_SIGNALS.map((s) => process.listeners(s).length), before,
      'run 结束后信号处理器要摘干净');
  } finally { await h.close(); }
});

test('重复取消同一个 job：第二次看得见，不被当成"取消没生效"', async () => {
  const h = await harness();
  try {
    const run = h.post('/api/run', { scenario: 'slow', jobId: 'twice' });
    await h.waitHit('/hold');
    const first = await h.post('/api/cancel?jobId=twice');
    assert.equal(first.body.alreadyCancelled, false, first.text);
    const second = await h.post('/api/cancel?jobId=twice');
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.alreadyCancelled, true,
      '第二下要看得见"之前已经取消过"，否则它与"取消没生效"长得一模一样');
    h.release();
    const resp = await run;
    assert.equal(num(resp.body, 'exitCode'), EXIT.ABORTED, resp.text);
    assert.equal(resp.body.cancelRequested, true);
  } finally { await h.close(); }
});
