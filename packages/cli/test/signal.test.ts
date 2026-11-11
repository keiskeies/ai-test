/**
 * 信号接线的单元测试（`signals.ts`）。
 *
 * **为什么这一族必须存在**：`exit.ts` 的 `ABORTED = 10` 从写下那天起没有生产者，
 * 而 `runOptions.signal` 也没有生产者 —— 「契约有名额、执行侧没人兑现」
 * （docs/14 §4.3 子类 (c)「读了、也判了，但没有生产者」换到对外 API 这层上的复现）。
 * 本轮把管道接上之后，管道本身就要有测试：
 * 否则下一次它被改回"只置标志不摘处理器"或者"第二次按没反应"，没人会知道。
 *
 * **不起子进程**。理由与 gate.test.ts 同源：走 spawn 测到的是 argv 拼接与 signal(2) 时序，
 * 而不是"第二次同名信号必须先摘处理器再打死自己"这条判据。
 * 自我终止走 `selfKill` 注入（那个缝就是为了这条测试才存在的）。
 *
 * ⚠ 本文件里**没有一条测试**用默认的 selfKill —— 那会真的把测试进程打死。
 *   新增用例时先传 `selfKill`，再写别的。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readZipEntries } from '@atest/store';

import { main } from '../src/main.js';
import { EXIT } from '../src/exit.js';
import type { Io } from '../src/commands.js';
import { HANDLED_SIGNALS, installSignalHandlers, type HandledSignal } from '../src/signals.js';

/** 与 e2e.test.ts 同一份：结论走 stdout，告警走 stderr。这里几乎只关心 stderr */
function ioCapture(): Io & { stdout: string[]; stderr: string[] } {
  const out = { stdout: [] as string[], stderr: [] as string[] };
  return {
    ...out,
    out: (s: string) => { out.stdout.push(s); },
    err: (s: string) => { out.stderr.push(s); },
    get cwd() { return process.cwd(); },
    env: {},
  } as Io & { stdout: string[]; stderr: string[] };
}

/**
 * 发一个信号，**模仿真信号**：Node 会把信号名作为第一个实参传给处理器。
 *
 * 为什么用 `process.emit` 而不是 `process.kill(process.pid, sig)`：
 * 后者会走真信号路径，第二次同名信号时我们的处理器会把进程打死 ——
 * 那不是测试，那是自杀。`emit` 只调用处理器，不触发默认终止行为。
 */
function fire(sig: HandledSignal): void {
  // emit 的签名按事件名收窄，接不到我们这套字面量联合；这里**只是测试里发事件**，
  // 用一次 cast 比给生产代码加宽类型合适（生产代码只认 process.on 那三个名字）。
  (process.emit as (name: string, arg?: unknown) => boolean)(sig, sig);
}

/** 三个信号的处理器数快照。用来证明"装了确实摘了"，也证明"没动别人的" */
function counts(): number[] {
  return HANDLED_SIGNALS.map((s) => process.listeners(s).length);
}

test('restore() 之后三个信号的处理器数**回到基线**（漏摘就是每跑一个命令留一套）', () => {
  const base = counts();
  const a = installSignalHandlers({ selfKill: () => { } });
  for (let i = 0; i < HANDLED_SIGNALS.length; i++) {
    assert.equal(process.listeners(HANDLED_SIGNALS[i]!).length, base[i]! + 1, `${HANDLED_SIGNALS[i]} 应该多一个`);
  }
  a.restore();
  assert.deepEqual(counts(), base, 'restore 之后处理器数必须一字不差回到基线');
});

test('第二个同名信号：selfKill 之前**处理器已经摘掉**（不摘就打死不了自己）', () => {
  /*
   * 这条测的是**顺序**，不是"调没调"。
   *
   * 反过来的话（先 kill 再摘）：处理器还在场，`process.kill(self,'SIGINT')`
   * 只会再跑一次这个回调 → `state.aborted` 已经是 true → 又 kill → **无限递归**，
   * 表现为"按第二下也没反应"，正是这一族缺陷里最难用肉眼发现的一种
   * （没有任何错误信息，只有"没反应"）。
   */
  const base = counts();
  const seen: Array<{ at: number[]; killed: HandledSignal | null }> = [];
  const h = installSignalHandlers({
    selfKill: (sig) => { seen.push({ at: counts(), killed: sig }); },
  });
  try {
    fire('SIGINT');
    assert.equal(seen.length, 0, '第一次信号不该自我终止（要留给清理）');
    assert.equal(h.signal.aborted, true);
    fire('SIGINT');
    assert.equal(seen.length, 1, '第二次同名信号要自我终止');
    assert.equal(seen[0]!.killed, 'SIGINT', '用同名信号打死自己：换成 SIGINT 会把成因改掉');
    // 判据：自我终止那一刻，**我们**那套处理器已经不在场了
    assert.deepEqual(seen[0]!.at, base, 'selfKill 时处理器必须已经摘掉，否则 kill 自己等于又叫一次回调');
  } finally { h.restore(); }
  assert.deepEqual(counts(), base);
});

test('异名信号（先 TERM 再 INT）**不**自我终止：CI runner 的"TERM 然后 INT"是同一句话', () => {
  /*
   * 这条是有主见的判据，不是"顺手多测一格"。
   *
   * CI runner 取消任务时常见的正是"先 SIGTERM，几秒后补一个 SIGINT"，
   * 那是**同一句"停下"说了两遍**，不是"别收拾了"。而人手按两下 Ctrl-C 才是后者。
   * 如果两个不同名信号就算"第二次"，代价是**每次 CI 取消都丢掉清理** ——
   * 恰好丢掉本轮为它写整段注释的那个东西（证据包、teardown、租约归还）。
   */
  const base = counts();
  let killed: HandledSignal | null = null;
  const notes: Array<{ sig: HandledSignal; same: boolean }> = [];
  const h = installSignalHandlers({
    selfKill: (s) => { killed = s; },
    onAbort: ({ sig, sameSignal }) => { notes.push({ sig, same: sameSignal }); },
  });
  try {
    fire('SIGTERM');
    fire('SIGINT');
    fire('SIGHUP');
    assert.equal(killed, null, `异名信号不该打死自己（实际被 ${killed} 打死）`);
    assert.equal(h.signal.aborted, true, '但取消这件事已经生效');
    assert.equal(h.signal.sig(), 'SIGTERM', '成因记**最先**那个：CI 取消与人工 Ctrl-C 要分得开');
    assert.equal(h.signal.count(), 3);
    // sameSignal 只在"已中断 + 同名"时为真。命令侧靠它决定打不打"放弃清理"那句话，
    // 判错就会对着人说不实话（进程其实还会活到清理跑完）
    assert.deepEqual(notes, [
      { sig: 'SIGTERM', same: false },
      { sig: 'SIGINT', same: false },
      { sig: 'SIGHUP', same: false },
    ], JSON.stringify(notes));
  } finally { h.restore(); }
});

test('同名第三次仍然打死自己（人不只按两下）', () => {
  const base = counts();
  let killed = 0;
  const h = installSignalHandlers({ selfKill: () => { killed++; } });
  try {
    fire('SIGINT'); fire('SIGINT'); fire('SIGINT');
    // 只要**每次**同名都尝试终止：第一次尝试已经把处理器摘了，
    // 之后的 fire 压根进不到处理器 —— 所以 killed 是 1 而不是 2，
    // 而这一条钉的是"多按不会把进程留在半死半活的状态"
    assert.equal(killed, 1, JSON.stringify({ killed, counts: counts() }));
    assert.deepEqual(counts(), base, '自我终止后不该留下任何处理器');
  } finally { h.restore(); }
});

test('onAbort 抛异常**不影响**取消，也不挡住自我终止', () => {
  /*
   * onAbort 是调用方给的（命令侧拿它打"正在收尾"那句话）。
   * 它抛的话，轻则取消这件事没被记上，重则一次 Ctrl-C 变成 uncaughtException ——
   * 于是"有人按了取消"在报告里长得像"平台自己坏了"。一次取消不该让工具看起来有 bug。
   */
  const base = counts();
  let killed: HandledSignal | null = null;
  const h = installSignalHandlers({
    onAbort: () => { throw new Error('打印失败（比如 stdout 已经关了）'); },
    selfKill: (s) => { killed = s; },
  });
  try {
    assert.doesNotThrow(() => fire('SIGINT'), 'onAbort 抛出去就是 uncaughtException');
    assert.equal(h.signal.aborted, true, '取消本身必须已经生效');
    fire('SIGINT');
    assert.equal(killed, 'SIGINT', '第一次抛过，第二次仍要能终止');
  } finally { h.restore(); }
});

test('restore() 只摘**自己**那一套，不动别人的处理器', () => {
  /*
   * 用 removeAllListeners 的实现"看起来更干净"，实际是把别人的（测试框架、宿主、
   * 将来的 watch 模式）一起清掉 —— 症状从"多一个处理器"变成"别人的功能莫名失效"，
   * 而现场看起来是**少**了一个处理器，更难查。
   */
  const base = counts();
  const foreign = (): void => { };
  process.on('SIGINT', foreign);
  const h = installSignalHandlers({ selfKill: () => { } });
  try {
    assert.equal(process.listeners('SIGINT').length, base[0]! + 2);
  } finally { h.restore(); }
  try {
    assert.equal(process.listeners('SIGINT').length, base[0]! + 1, '宿主那个要还在');
    assert.ok(process.listeners('SIGINT').includes(foreign), '被清掉的那个不会再报错，只会静默失效');
  } finally { process.removeListener('SIGINT', foreign); }
  assert.deepEqual(counts(), base);
});

test('restore() 调两次不抛（finally 一次 + 外层再兜一次是常见写法）', () => {
  const base = counts();
  const h = installSignalHandlers({ selfKill: () => { } });
  h.restore();
  assert.doesNotThrow(() => h.restore());
  assert.deepEqual(counts(), base);
});

test('signal.aborted 是**读到那一刻**的值，不是装配时的快照', () => {
  /*
   * 引擎在**每一步开头**读它（interpreter.ts 的 checkAbort）。
   * 如果实现给的是 `{ aborted: state.aborted }`（取了一次值），
   * 那这条管道**永远读不到 true**，而症状与"压根没接线"一字不差 ——
   * 正是本轮修的那个缺陷在另一层上的复现，所以要钉住。
   * wiring.ts 里"传对象而不是传布尔"那段注释讲的也是这件事。
   */
  const base = counts();
  const h = installSignalHandlers({ selfKill: () => { } });
  try {
    assert.equal(h.signal.aborted, false);
    assert.equal(h.signal.sig(), undefined, '没收到信号时不要给一个编出来的信号名');
    // 取一次引用，之后**不再重新取**：证明读的是对象上的实时值
    const ref = h.signal;
    fire('SIGTERM');
    assert.equal(ref.aborted, true, '拿到的那个对象必须能反映之后的信号');
    assert.equal(ref.sig(), 'SIGTERM');
  } finally { h.restore(); }
});

test('信号名认不出来时按**已收到的那个**处理，而不是抛', () => {
  /*
   * 处理器实参的形态由 Node/OS 决定，不由我们决定。这里模拟"第一个实参不是信号名"
   * 的那种 Node 行为：判据不该依赖它（依赖了就是"处理器里抛异常"的入口，
   * 而那代价是取消路径整个失效）。
   */
  const base = counts();
  let killed: HandledSignal | null = null;
  const h = installSignalHandlers({ selfKill: (s) => { killed = s; } });
  try {
    process.emit('SIGINT', undefined);       // 没有名字
    assert.equal(h.signal.aborted, true);
    process.emit('SIGINT', { odd: true });   // 名字位置放了个对象
    assert.equal(killed, 'SIGINT', `认不出名字也要能终止，实际 killed=${String(killed)}`);
  } finally { h.restore(); }
});

/*
 * ── 端到端：一次真信号穿过 cmdRun ────────────────────────────────────────
 *
 * 上面九条测的是**这个模块**。它们全绿也证明不了 `atest run` 真的接了它 ——
 * 而"下半截没人接"正是本仓那一族缺陷的本名（`runOptions.signal` 之前没有生产者，
 * 而 `EXIT.ABORTED` 之前没有返回它的路径）。所以这一条走 `main()`。
 *
 * **信号怎么在 run 中途发**：夹具自己起一个 http 服务，在**请求处理器里**
 * `process.emit('SIGINT', …)`。cmdRun 的处理器在那一刻正好在场，
 * 于是取消发生在"第 1 步进行中"，与真人按键同一时刻的形状。
 * 用 emit 而不是 `process.kill(self)`：后者会真打死测试进程。
 */

test('run 中途收到 SIGINT：退出码 10、证据包说 cancelled、后面的场景一步都不跑', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-signal-'));
  // 一个只会回 200 的服务，顺手在**请求到达时**发信号
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    fire('SIGINT');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // 场景 1：一条会打服务的步骤 + 两条它后面的断言 + 一条清理
    const one = join(dir, 'one.json');
    await writeFile(one, JSON.stringify({
      schemaVersion: '1', id: 'scn.sig1', name: '中途取消', env: { environmentRef: 'unit' },
      body: [
        { id: 'g', kind: 'http', request: { method: 'GET', url: '/slow' } },
        { id: 'a1', kind: 'assert', against: '$.step.g.resp', status: 200 },
        { id: 'a2', kind: 'assert', against: '$.step.g.resp', status: 200 },
      ],
      teardown: [{ id: 'td', kind: 'set', assign: { cleaned: true } }],
    }), 'utf8');
    // 场景 2：一个本来会**真的发请求**的场景，用来证明它压根没跑
    const two = join(dir, 'two.json');
    await writeFile(two, JSON.stringify({
      schemaVersion: '1', id: 'scn.sig2', name: '不该被跑到', env: { environmentRef: 'unit' },
      body: [
        { id: 'h2', kind: 'http', request: { method: 'POST', url: '/place-order' } },
        { id: 'a9', kind: 'assert', against: '$.step.h2.resp', status: 200 },
      ],
    }), 'utf8');

    const before = counts();
    const io = ioCapture();
    const code = await main(['run', one, two, '--env-var', `baseUrl=${addr}`,
                             '--evidence-dir', join(dir, 'ev'), '--run-id', 'sig1'], io);

    // 夹具自检：请求真的到了（否则信号压根没发，下面全是在测"正常跑完"）
    assert.ok(hits.length >= 1, `服务一个请求都没收到，那次"中途取消"是假的：${io.stderr.join(' | ')}`);
    // 泄漏哨兵：cmdRun 的 finally 必须把它那套摘干净
    assert.deepEqual(counts(), before, 'cmdRun 结束后信号处理器要摘干净（漏摘会把后面的命令当成被取消的 run）');

    // ① 退出码。这是 `EXIT.ABORTED` 在这个仓库里**第一次**由真实路径产生
    assert.equal(code, EXIT.ABORTED, `实际 ${code}。stderr: ${io.stderr.join(' | ')}`);
    // ② 第一次按键要有反馈（没反馈 = 人会再按一次，而第二次是"放弃清理"）
    assert.match(io.stderr.join('\n'), /收到 SIGINT/, io.stderr.join(' | '));
    // ③ 后面的场景**明说**没跑，而不是静默少一行
    assert.match(io.stderr.join('\n'), /scn\.sig2|two\.json/, '跳过的场景要能被点名');
    assert.match(io.stderr.join('\n'), /一步都没跑/);

    // ④ 场景 1 的产物：aborted 要走到**证据包**里，而不只是退出码
    const runDir = join(dir, 'ev', 'sig1');
    const zipName = (await readdir(runDir)).find((n) => n.startsWith('evidence.') && n.endsWith('.zip'));
    assert.ok(zipName, `${runDir} 下没有 evidence*.zip：${(await readdir(runDir)).join(',')}`);
    assert.match(zipName!, /^evidence\.sig1\.aborted\.zip$/, `文件名要说被中断：${zipName}`);
    const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zipName!))));
    const text = (n: string) => new TextDecoder().decode(entries.find((e) => e.name === n)!.data);
    const manifest = JSON.parse(text('manifest.json'));
    assert.equal(manifest.aborted?.kind, 'cancelled', `CLI 这条路的成因是取消：${JSON.stringify(manifest.aborted)}`);
    // status 仍是已完成步骤的结论（设计，不是遗漏，见 RunReport.aborted）
    assert.equal(manifest.status, 'pass');

    // ⑤ 取消**之后**的步骤没跑：a1/a2 一步都不该在 JUnit 里
    const junit = text('junit.xml');
    assert.ok(!junit.includes('name="a1"'), `信号在第 1 步里到达，a1 不该被执行：${junit}`);
    // ⑥ 而 teardown **跑了** —— 这条测的是"环境里不留没人认领的脏数据"，
    //    也是"为什么第一次信号不能当场死掉"的全部理由（interpreter 的 runTeardown）
    assert.match(junit, /name="td"/, `清理必须跑完。junit = ${junit}`);

    // ⑦ 场景 2 一个请求都没发（它的 body 里是一个 POST /place-order —— 真下单）
    assert.equal(hits.filter((u) => u === '/place-order').length, 0,
      '被取消之后不该再有第二个场景发请求：那是不可逆动作');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/*
 * ── 取消落在**两个场景之间**：退出码只能由"被跳过的场景"给 ──────────────────
 *
 * 上一条测的是"run 中间被砍"，那条里 `report.aborted` 有值，
 * 所以退出码 10 由**门禁**给（gate.ts 读 report.aborted）。
 * 于是 cmdRun 里那句 `skippedByCancel ? EXIT.ABORTED : EXIT.OK` **没有测试** ——
 * 本机实测：把它整条删掉（`worseExit(worst, EXIT.OK)`），上面十条**全绿**。
 * 而那正是本仓最熟的形状：一段代码写着、注释详尽、没有任何一条测试经过它。
 *
 * 要走到那条分支，必须让**每个跑起来的场景都完整跑完**（自己的 gate 给 0），
 * 而取消只作用在**后面的场景**上。所以把信号放在场景 1 的**最后一个步骤**里：
 * 引擎在每一步**开头**读 signal（interpreter 的 checkAbort），最后一步之后
 * 再没有检查点，于是场景 1 的报告是**完整的**（aborted 不该有值 ——
 * 它确实一步没少），被砍掉的只有场景 2。
 *
 * 顺带钉住一件容易搞错的事：**这种 run 的证据包不该叫 aborted**。
 * 一次完整的 run 因为"后面还有别的场景"就被改名成 aborted，
 * 是把"批次的处境"写进"单个场景的结论" —— 与 status 不改写是同一条判断。
 */
test('取消落在场景之间：跑完的那个仍是 pass，退出码 10 **只**来自被跳过的场景', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atest-signal2-'));
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    fire('SIGINT');       // 此刻正处在场景 1 的最后一步里
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const one = join(dir, 'one.json');
    await writeFile(one, JSON.stringify({
      schemaVersion: '1', id: 'scn.gap1', name: '最后一步才被取消', env: { environmentRef: 'unit' },
      body: [
        { id: 'seed', kind: 'set', assign: { n: 1 } },
        // 断言放在**前面**：场景 1 要拿得到一个真实的通过结论（否则它的 gate 会给
        // "没有断言"那个码，10 就不再是这条测试唯一要问的东西）
        { id: 'a1', kind: 'assert', against: '$n', expr: '$n == 1' },
        { id: 'g', kind: 'http', request: { method: 'GET', url: '/last' } },
      ],
      teardown: [{ id: 'td', kind: 'set', assign: { cleaned: true } }],
    }), 'utf8');
    const two = join(dir, 'two.json');
    await writeFile(two, JSON.stringify({
      schemaVersion: '1', id: 'scn.gap2', name: '不该被跑到', env: { environmentRef: 'unit' },
      body: [{ id: 'h2', kind: 'http', request: { method: 'POST', url: '/place-order' } }],
    }), 'utf8');

    const io = ioCapture();
    const code = await main(['run', one, two, '--env-var', `baseUrl=${addr}`,
                             '--evidence-dir', join(dir, 'ev'), '--run-id', 'gap1'], io);

    // 夹具自检：信号**真的**发出去了，而且是在场景 1 的最后一步里发的。
    // 少了这两句，本条可能只是在测"两个场景都跑完 => 退出码是别的什么"。
    assert.equal(hits.filter((u) => u === '/last').length, 1, `那次取消没发到：${io.stderr.join(' | ')}`);
    assert.match(io.stderr.join('\n'), /收到 SIGINT/, io.stderr.join(' | '));

    // ① 跑完的那个场景**自己**是干净的：产物叫 pass，teardown 也跑了
    const runDir = join(dir, 'ev', 'gap1');
    const zipName = (await readdir(runDir)).find((n) => n.startsWith('evidence.') && n.endsWith('.zip'));
    assert.match(zipName ?? '', /^evidence\.gap1\.pass\.zip$/,
      `场景 1 一步没少，包名不该是 aborted：${zipName}。stderr: ${io.stderr.join(' | ')}`);
    const entries = readZipEntries(new Uint8Array(await readFile(join(runDir, zipName!))));
    const junit = new TextDecoder().decode(entries.find((e) => e.name === 'junit.xml')!.data);
    assert.match(junit, /name="g"/, `最后一步要真的跑完：${junit}`);
    assert.match(junit, /name="td"/, `收尾清理也要跑完：${junit}`);

    // ② 而**批次**的退出码仍然是 10。这是本条的全部判据：
    //    场景 1 给的是 0，所以这个 10 只能来自"有个场景被跳过"这件事。
    assert.equal(code, EXIT.ABORTED,
      `实际 ${code}。删掉 cmdRun 里 skippedByCancel 那条即可复现本仓原来的形状：一次取消在流水线里是绿灯`);
    assert.match(io.stderr.join('\n'), /scn\.gap2|two\.json/);
    assert.match(io.stderr.join('\n'), /一步都没跑/);
    assert.equal(hits.filter((u) => u === '/place-order').length, 0, '被跳过的场景不该发一个请求');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

