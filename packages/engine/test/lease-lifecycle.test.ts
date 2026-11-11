/**
 * 设备租约的生命周期（`docs/15` §3.1）。
 *
 * **这一组测的四件事，改动前全都不成立**（逐条对应 §3.1 那张表里的行）：
 *  1. 异常/中断路径不还租约 —— 原来 `release` 在 `try` 的最后一行，`catch` 那一支不经过它；
 *  2. 第二个 `device` 步裸覆盖前一个 —— 前一台设备从此没人还；
 *  3. `release` 的 `ctx.target` 写死 `'android'` —— 跑 iOS/鸿蒙时指着另一个平台还；
 *  4. `leaseMs` 与 `expiresAt` 没有任何读者 —— 过期不可见，步骤照发照执行。
 *
 * **时间怎么控制**：`helpers.run()` 用的是 `deterministicClock`，它的 `now()` 只在
 * `sleep` 时前进，而本文件要的是"租约已经过期"这个**起始状态**，不是"跑着跑着过期"。
 * 所以这里直接调 `runScenario` 并自带一个可拨的时钟 —— 不是嫌 helpers 不好，是它没有
 * 暴露时钟这件事对这类测试是硬阻塞。**如果以后要测的时序场景多起来，该给
 * `RunOverrides` 加一个 `clock`，而不是每个文件各自造一个。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runScenario, deterministicClock, type AdapterRegistry, type Clock, type ExecContext } from '../src/index.js';
import { defineScenario, type Scenario, type StepDraft } from '@atest/ir';

const b = (id: string) => ({ id });
const dev = (id: string, target: 'android' | 'ios' | 'harmony' = 'android', over: Record<string, unknown> = {}): StepDraft =>
  ({ ...b(id), kind: 'device', target, require: { requires: [] }, ...over }) as StepDraft;
const tap = (id: string): StepDraft =>
  ({ ...b(id), kind: 'tap', target: { intent: '登录', primary: { by: 'testid', value: 'x' } } }) as StepDraft;

const scen = (body: StepDraft[], extra: Record<string, unknown> = {}): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.lease', name: 'lease', env: { environmentRef: 'unit' }, body, ...extra,
  } as never);

/** 每次 lease 发一个新 id，好让"还的是哪一个"可断言 */
function spyDevice(opt: {
  expiresAt?: number | (() => number);
  renewTo?: number | undefined;
  failRelease?: boolean;
} = {}) {
  const calls: Array<{ m: string; id?: string; target?: string }> = [];
  let n = 0;
  const exp = () => (typeof opt.expiresAt === 'function' ? opt.expiresAt() : (opt.expiresAt ?? 0));
  const device = {
    async lease(_r: unknown, ctx: ExecContext, leaseMs?: number) {
      n++;
      calls.push({ m: 'lease', id: `L${n}`, target: ctx.target });
      lastLeaseMs = leaseMs;
      return { id: `L${n}`, deviceRef: `dev-${n}`, expiresAt: exp() };
    },
    async renew(l: { id: string }, ctx: ExecContext) {
      calls.push({ m: 'renew', id: l.id, target: ctx.target });
      if (opt.renewTo === undefined) throw new Error('池子空了，续不了');
      return { expiresAt: opt.renewTo };
    },
    async release(l: { id: string }, ctx: ExecContext) {
      calls.push({ m: 'release', id: l.id, target: ctx.target });
      if (opt.failRelease) throw new Error('设备农场 500');
    },
    async app() { calls.push({ m: 'app' }); return {}; },
    async snapshot() { return { kind: 'hierarchy' as const, data: '<h/>', sha: 's' }; },
    // perform 要记进 calls：**"那个设备步到底有没有发出去"是这一族测试的关键判据**
    // （拦下之后不该发、续租成功之后该发）。我第一版没记，于是
    // `calls.some(c => c.m === 'perform')` 恒为 false，那条断言把"通过"误判成"没执行"。
    async perform() { calls.push({ m: 'perform' }); return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async resolve() { return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
  };
  let lastLeaseMs: number | undefined;
  return { adapters: { device } as unknown as AdapterRegistry, calls, leaseMsSeen: () => lastLeaseMs };
}

/** 可拨时钟：起点与 deterministicClock 一致，时间由测试自己推 */
function dialClock(startMs = 1_700_000_000_000): Clock & { advance(ms: number): void; at(): number } {
  let t = 0;
  return {
    now: () => startMs + t,
    mono: () => t,
    sleep: async (ms: number) => { t += ms; },
    random: () => 0.5,
    mode: 'frozen',
    advance: (ms: number) => { t += ms; },
    at: () => startMs + t,
  };
}

const runWith = (body: StepDraft[], adapters: AdapterRegistry, clock: Clock, extra: Record<string, unknown> = {}) =>
  runScenario({ scenario: scen(body, extra), adapters, clock, runId: 'r' });

test('leaseMs 真的传给 adapter（改动前 adapter 压根收不到这个参数）', async () => {
  const d = spyDevice();
  const r = await runWith([dev('d', 'android', { leaseMs: 45_000 }), tap('t')], d.adapters, deterministicClock());
  assert.equal(d.leaseMsSeen(), 45_000, `adapter 应收到 IR 上写的 45000，实际 ${d.leaseMsSeen()}`);
  assert.equal(r.status, 'pass');
});

test('租约中途过期 → 先续租；续上了就照常跑（不是"过期就红"）', async () => {
  /*
   * 时间是这样前进的：`dialClock` 的 `now()` 跟着 `sleep` 走，而解释器的 `sleep` 步骤
   * 就调 `clock.sleep(s.ms)`（interpreter 的 sleep 分支）。所以"跑着跑着过期"用一个
   * sleep 步就能造出来，不需要在测试里外挂一个 `advance()` ——
   * 外挂版本我第一版写了，结果它只推进测试自己的时钟变量、**没有真的让第二次 run
   * 接着第一次的状态**（那是另一个 runId、另一份 stepCtx），断言最后落在
   * `d.calls.some(lease)` 这种"夹具动过"的话上，等于什么都没测。
   */
  const base = 1_700_000_000_000;
  const d = spyDevice({ expiresAt: base + 60_000, renewTo: base + 600_000 });
  const r = await runWith(
    [dev('d'), { id: 's', kind: 'sleep', ms: 120_000 } as StepDraft, tap('t')],
    d.adapters, dialClock(),
  );
  const renew = d.calls.filter((c) => c.m === 'renew');
  assert.equal(renew.length, 1, `过期只该续一次：${JSON.stringify(d.calls)}`);
  assert.equal(renew[0]!.id, 'L1', '续的是当前这把租约，不是新建一把');
  assert.ok(r.events.some((e) => e.kind === 'lease.renewed'), '续上了要说得出来（改期是审计事实）');
  assert.equal(r.status, 'pass', `续上之后设备步照跑：${r.summary}`);
  assert.ok(d.calls.some((c) => c.m === 'perform'), '续租成功后那个 tap 要真的执行');
});

test('租约过期且续租失败 → error + env-unavailable，**不是 fail**', async () => {
  // 归因方向是这条的重点：设备没了是环境/调度问题，报 fail 会让值班人去查产品 bug
  const base = 1_700_000_000_000;
  const clock = dialClock(base);
  const d = spyDevice({ expiresAt: () => base + 1_000, renewTo: undefined });
  clock.advance(5_000); // 一进来就已经过了到期时间
  const r = await runWith([dev('d'), tap('t')], d.adapters, clock);
  const t = r.results.find((x) => x.stepId === 't');
  assert.equal(t?.status, 'error', `过期且续租不到应当 error：${t?.status} / ${t?.assertionSummary}`);
  assert.equal(t?.cause, 'env-unavailable', '归因必须是环境，不是产品 bug');
  assert.ok(d.calls.some((c) => c.m === 'renew'), '先试过续租，再报错');
  assert.ok(!d.calls.some((c) => c.m === 'perform'), '拦下之后不该已经把那个设备步发出去');
  assert.ok(r.events.some((e) => e.kind === 'lease.lost'), '续租失败要说得出是哪把租约丢的');
  /*
   * **`renewable = false` 那一支刻意不写成测试。**
   * 这个字段在 `LeaseSchema` 里默认 true（ir/src/targets.ts），而引擎唯一的赋值处
   * 写死 `renewable: true`（interpreter 的 device case）—— 全仓没有任何路径能造出
   * false。写一条"renewable=false 时不去续租"的测试只能在测试里手造一个 Lease 对象，
   * 那就是**在断言自己造的夹具**，绿灯毫无信息量，正是 docs/14 §4.3 第三个子类
   * （判据有人读、没有生产者）。该记的地方是 docs/15 §3.1 那一行，不是测试文件。
   */
});

test('expiresAt = 0 表示"这个 adapter 不报租期"，**不当成 1970 年已过期**', async () => {
  // 现有假 DeviceExec 全返回 0；把 0 当过期会让它们全红，
  // 而真正的原因是 `expiresAt` 是必填 number，老实实现没有别的写法。
  const d = spyDevice({ expiresAt: 0 });
  const r = await runWith([dev('d'), tap('t')], d.adapters, dialClock());
  assert.equal(r.status, 'pass', `0 应当是"不判"，实际 ${r.summary}`);
});

test('正常路径归还设备，且 ctx.target 用租约自己的而不是写死 android', async () => {
  for (const target of ['android', 'ios', 'harmony'] as const) {
    const d = spyDevice();
    await runWith([dev('d', target), tap('t')], d.adapters, deterministicClock());
    const rel = d.calls.filter((c) => c.m === 'release');
    assert.equal(rel.length, 1, `${target}: 应当恰好还一次，实际 ${JSON.stringify(d.calls)}`);
    assert.equal(rel[0]!.target, target, `${target} 场景里 release 的 ctx.target 被写成了 ${rel[0]!.target}`);
  }
});

test('抛异常的路径也归还设备（改动前 catch 那一支直接跳过 release）', async () => {
  /*
   * 原本想用 `maxCostUsd: 0` 制造中断，**而那条场景压根没被中断（run=pass）**：
   * 成本熔断只在 addCost 里判，一个 tap 步骤不产生成本 —— 我以为是"异常路径"，
   * 实际是"一切正常"，那样这条测试会绿得毫无意义。
   * 换成**真的中断**：第一条设备步执行时把 signal 翻成 aborted，下一条步开头的
   * checkAbort 就抛 RunAborted，走到 run 的 catch → finally。
   */
  const calls: Array<{ m: string; id?: string; target?: string }> = [];
  const signal = { aborted: false };
  const device = {
    async lease() { calls.push({ m: 'lease', id: 'L1' }); return { id: 'L1', deviceRef: 'dev-1', expiresAt: 0 }; },
    async renew() { return { expiresAt: 0 }; },
    async release(l: { id: string }) { calls.push({ m: 'release', id: l.id }); },
    async app() { return {}; },
    async snapshot() { return { kind: 'hierarchy' as const, data: '<h/>', sha: 's' }; },
    async perform() { signal.aborted = true; return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async resolve() { return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
  };
  const r = await runScenario({
    scenario: scen([dev('d'), tap('t1'), tap('t2')]),
    adapters: { device } as unknown as AdapterRegistry, clock: deterministicClock(), runId: 'r', signal,
  });
  assert.ok(signal.aborted, '夹具本身要真的触发了中断，否则这条什么都没测');
  // 中断的**判据用事件而不是 r.status**：被取消的 run 今天把 status 报成 `pass`
  // （下面那条 error 事件的 `aborted:true` 是唯一信号）。这是本轮测出来的另一个缺陷，
  // 由 `interruption.test.ts` 单独钉 —— 这条只负责"异常路径也要还设备"。
  assert.ok(
    r.events.some((e) => e.kind === 'error' && (e.data as { aborted?: boolean } | undefined)?.aborted === true),
    `夹具本身要真的走到中断，否则 release 断言是空的：${JSON.stringify(r.events.map((e) => e.kind))}`,
  );
  const rel = calls.filter((c) => c.m === 'release');
  assert.equal(rel.length, 1, `异常路径也要还设备，且只还一次：${JSON.stringify(calls)}`);
});

test('release 自己抛异常：不静默，说进日志；也不把整份报告变成运行异常', async () => {
  const d = spyDevice({ failRelease: true });
  const r = await runWith([dev('d'), tap('t')], d.adapters, deterministicClock());
  assert.equal(r.status, 'pass', `清理失败不该改写"被测功能对不对"的结论：${r.summary}`);
  const warns = r.events.filter((e) => e.kind === 'log.emitted' && String(JSON.stringify(e.data)).includes('没能归还'));
  assert.equal(warns.length, 1, `泄漏要说得出声：${JSON.stringify(r.events.filter((e) => e.kind === 'log.emitted'))}`);
});

test('第二个 device 步先归还前一台（改动前是裸赋值，前一台从此没人还）', async () => {
  const d = spyDevice();
  const r = await runWith([dev('d1'), tap('t1'), dev('d2'), tap('t2')], d.adapters, deterministicClock());
  assert.equal(r.status, 'pass', r.summary);
  const rel = d.calls.filter((c) => c.m === 'release').map((c) => c.id);
  assert.deepEqual(rel, ['L1', 'L2'], `两台都要还，实际还了 ${JSON.stringify(rel)}（调用序 ${JSON.stringify(d.calls)}）`);
});

/*
 * ── parallel 的分支**各自一个租约槽**（改前是共享一个） ─────────────────────
 *
 * 这一段的小标题从前写的是「分支共享同一个 stepCtx，所以它们也共享那**一个**租约槽」，
 * 那是**改动前**的事实，而下面几条测试断的已经是改动后的行为 —— 标题留在旧事实上，
 * 读的人会以为这几条测试在钉一个"共享"的语义（正好与实现相反）。
 *
 * 这条测试是先写失败、后改代码的。本轮此前我在 docs/15 §3.1 里写的是
 * "`parallel` 那一支今天压根不共享 `stepCtx`，因为 `runStep(c, …, branch, branchWindow)`
 * 里没有 stepCtx 参数" —— **那句是错的**，错在"从调用参数表推结论"：
 * `runStep` 是 `runScenario` 内部的闭包（interpreter 里 `const runStep = async (…)` 那一行），
 * 它读的 `stepCtx` 来自**外层作用域**而不是形参，所以"没有形参"根本推不出"不共享"。
 * 实测（`.scratch/probe-parallel-lease.mts`，改动前）：租约在 setup、parallel 两支各一个裸 tap
 * → 调用序 `lease → perform → perform → release`，两支**都跑通了**。
 *
 * 那时候"共享"看着还挺合理（两支用同一台设备，符合"一个场景一台"的直觉），
 * 但它让上面那条"第二个 device 步先还前一个"的修法在并发下失效 ——
 * 两个 device 步并发跑，都看到"手上已有租约"，于是各自还掉**同一个** id，
 * 而自己新拿的那台**谁都不还**。实测（`.scratch/probe-parallel-race.mts`，改动前）：
 *   lease 2 次、release 1 次、收尾在手上 1 台，而报告是 `p:pass`、整场 pass。
 * **一份全绿的报告漏掉一台真机**，这在设备农场里是持续累积的资源泄漏，
 * 而且没有任何一行字说它漏了 —— 与本仓那一族"看起来有防护，实际漏一个"同形。
 *
 * 现在每支一个 `newLeaseSlot(slot.lease)`（ interpreter 的 parallel 分支里那一行）：
 * 借来的那台照旧看得见（`owns: false`，不还），分支自己申请的在**分支结束**时还。
 * 于是"共享"这件事在语义上被取消 —— 下面那条"裸 tap 恒为 error"就是它的直接后果。
 */

/** 带延迟的设备农场：`inflight()` 是"拿走了还没还"的台数，用来抓泄漏本身 */
function farm() {
  const calls: string[] = [];
  let n = 0;
  let inflight = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const device = {
    /*
     * 真设备农场有网络延迟，这个 await 才是"并发能不能被观察到"的关键：
     * 没有它，两支的 lease 之间不会交错，测试会在 bug 存在时照样绿。
     *
     * **id 必须在 await 之前定好**（我第一版写的是 `await wait(5); return { id: \`L${n}\` }`），
     * 那个版本会自己骗自己：两支并发进来时 `n` 已经都被加到 2，两支各自 await 完
     * 拿到的都是 `L2` —— 于是归还序列打成 `release:L2, release:L2`，
     * 看起来像"引擎把同一台还了两遍、另一台没还"，而**引擎其实是对的**
     * （另写一份把 id 在 await 前定死的探针，序列就是干净的 `release L1 / release L2`）。
     * 夹具造假 id 的坏处不只是误报：它会让人去修一个不存在的缺陷。
     * 真实设备池发号一定是"申请成功那一刻"就定下的，不会等网络回来再重新数一遍。
     */
    async lease() {
      n++; inflight++;
      const id = `L${n}`;
      calls.push(`lease:${id}`);
      await wait(5);
      return { id, deviceRef: id.replace('L', 'dev-'), expiresAt: 0 };
    },
    async renew() { calls.push('renew'); return { expiresAt: 0 }; },
    async release(l: { id: string }) { inflight--; calls.push(`release:${l.id}`); await wait(1); },
    async app() { calls.push('app'); return {}; },
    async snapshot() { return { kind: 'hierarchy' as const, data: '<h/>', sha: 's' }; },
    async perform() { calls.push('perform'); await wait(2); return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async resolve() { return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
  };
  return { adapters: { device } as unknown as AdapterRegistry, calls, inflight: () => inflight };
}

const seq = (id: string, steps: StepDraft[]): StepDraft =>
  ({ ...b(id), kind: 'sequence', steps }) as StepDraft;
const par = (id: string, steps: StepDraft[], over: Record<string, unknown> = {}): StepDraft =>
  ({ ...b(id), kind: 'parallel', steps, ...over }) as StepDraft;
/** 只挑某一类适配器调用，按顺序取 id */
const idsOf = (calls: string[], verb: string): string[] =>
  calls.filter((c) => c.startsWith(`${verb}:`)).map((c) => c.slice(verb.length + 1));

test('parallel 两支各自 device：两台**都要还，且还的是自己那台**（改动前 lease 2 次只 release 1 次，而报告是 pass）', async () => {
  const f = farm();
  const r = await runScenario({
    scenario: scen([par('p', [seq('seqA', [dev('dA'), tap('tA')]), seq('seqB', [dev('dB'), tap('tB')])], { failFast: false })]),
    adapters: f.adapters, clock: deterministicClock(), runId: 'r',
  });
  const leases = idsOf(f.calls, 'lease');
  assert.deepEqual(leases, ['L1', 'L2'], `两支各拿一台：${JSON.stringify(f.calls)}`);
  /*
   * 判据是"**还的 id 集合 == 拿的 id 集合**"，不是"release 调了几次"。
   * 只数次数的话，"把同一台还两遍、另一台不还"这种修法能拿满分 ——
   * 而那种修法在真农场里意味着：一台被重复标记已还（可能已经发给别人了），
   * 另一台永远占着。计数相同而归属错误，是这一族最典型的假绿形状。
   */
  assert.deepEqual(idsOf(f.calls, 'release').slice().sort(), ['L1', 'L2'],
    `每台都得被它那一次申请还掉。调用序 ${JSON.stringify(f.calls)}`);
  assert.equal(f.inflight(), 0, `收尾时手上不该还有设备（漏的那台在农场里会被一直占着）：${f.inflight()}`);
  // 结论也得对：漏还的时候今天恰恰是全场 pass，所以这句不是冗余
  assert.equal(r.status, 'pass', r.summary);
});

test('parallel 一支 device + 一支裸 tap → 裸 tap 那支**恒为 error**，且不牵连归还（改前是"看调度运气"）', async () => {
  /*
   * 这条断言的是本轮修法的**第二个后果**，而且是最容易看漏的那个。
   *
   * 改动前：两支共用一个租约槽，于是"裸 tap 那支有没有租约"取决于**谁先跑到**
   * —— 先跑就 error，排在 device 那支后面就 pass。实测两种都出现过
   * （`.scratch/probe-parallel-b.mts` 连跑可见）。那是同一份冻结场景给出两种结论，
   * 直接违反 docs/02 §9 要的确定性，也正是 `useIdentity` 在 parallel 里被拒的同一个理由。
   *
   * 改动后：分支各有自己的槽，借来的那台初值为"外层手上那台"（顶层没有就是没有），
   * 所以这一形状**恒为 error** —— 与 lint 对同一形状的判定终于一致
   * （`RESOURCE_LEASE_MISSING/error@tB`，探针 `.scratch/probe-parallel-lint.mts`）。
   *
   * **为什么这是"修对了"而不是"变得更严了"**：error 那句说的是"没租约"，
   * 而这份 IR 确实没给这一支租约；以前的 pass 才是假的
   * （那台设备其实是**另一支**在用的，两支并发操作同一台机器）。
   * 换句话说：这次改动把一个 flaky 的假绿换成了一个稳定的、说得清的 error。
   */
  const f = farm();
  const r = await runScenario({
    scenario: scen([par('p', [seq('seqA', [dev('dA'), tap('tA')]), tap('tB')], { failFast: false })]),
    adapters: f.adapters, clock: deterministicClock(), runId: 'r',
  });
  const tB = r.results.find((x) => x.stepId === 'tB');
  assert.equal(tB?.status, 'error', `裸 tap 那支该稳定 error，不该看调度运气：${tB?.status}｜${tB?.assertionSummary}`);
  assert.match(tB?.assertionSummary ?? '', /缺少 device 租约/);
  // 借来/自取的归还不能因为这一支失败就走错路：申请了一次就还一次
  assert.deepEqual(idsOf(f.calls, 'release'), ['L1'],
    `申请一台就该还一台，不因别的分支失败而多还或少还：${JSON.stringify(f.calls)}`);
  assert.equal(f.inflight(), 0);
  // 整场 error：分支里有一个"没测成"的 error 步，容器汇成 fail、场景汇成 error
  // （docs/02 §9 的口径 —— error 意味着先修用例/环境，此时别的结论都不可信）。
  // 我第一版这里写的是 fail，理由是"分支失败汇成 fail"，**只对了一半**：
  // 分支里的 tB 本身是 error 而不是 fail，error 会一路顶到场景级。
  assert.equal(r.status, 'error', `${r.summary}｜这一形状该被读成"用例写错了（这一支没租约）"，且结论不可信`);
});

test('租约在 setup、parallel 两支裸 tap → 两支共享同一台且只 lease 一次', async () => {
  /*
   * 钉的是"分支**共享**外层租约"这件事本身（我原先写反了的那条）。
   * 共享是有意为之的行为：一个场景一台设备，分支不该各占一台。
   * 所以这里断言的是 `lease 恰好 1 次` + `perform 2 次`，
   * 而不是"两支都 error 说缺租约"。以后若改成分支各占一台，这条会红，
   * 而那次改动要同时回答 docs/15 §3.1 末段"设备从哪来"的问题。
   */
  const f = farm();
  const r = await runScenario({
    scenario: scen([par('p', [tap('t1'), tap('t2')], { failFast: false })], { setup: [dev('d')] }),
    adapters: f.adapters, clock: deterministicClock(), runId: 'r',
  });
  assert.equal(f.calls.filter((c) => c.startsWith('lease')).length, 1, `分支应共享 setup 那台，不该各租一台：${JSON.stringify(f.calls)}`);
  assert.equal(f.calls.filter((c) => c === 'perform').length, 2, `两支都该真跑出去：${JSON.stringify(f.calls)}`);
  assert.equal(f.calls.filter((c) => c.startsWith('release')).length, 1, '共享的那台只还一次');
  assert.equal(r.status, 'pass', r.summary);
});

/*
 * ── 嵌套 parallel：分支槽的祖先是"当前这一层"，不是"最外面那层" ──────────────
 *
 * 修完"分支共用一个槽"之后，分支槽写成 `newLeaseSlot(runSlot.lease)` ——
 * 顶层形状下它对，嵌套一层就错了：`dispatch` 层层把 `slot` 传下去，
 * 唯独 `case 'parallel'` 从闭包里读 `runSlot`，等于**跳过中间那一层**。
 *
 * 为什么只有嵌套能暴露它：顶层时 `slot === runSlot`，两种写法逐字节相同。
 * 而 `slot` 是**必填形参**这一点完全帮不上忙 —— 编译器只要求"这里出现 slot"，
 * 不要求"引用的是传进来的那个 slot"。上一轮删默认值时我在注释里写的是
 * "留默认值等于把坑原地留着"，**而坑的另一半是：即便没有默认值，写错变量名照样过**，
 * 这一族只能靠测试守，不能靠签名守。
 */

test('外层分支自己申请了租约，内层 parallel 的裸 tap 继承**外层那一支**那台（不是整场的）', async () => {
  /*
   * 形状：parallel P 的 A 支 = sequence[ device dA, parallel Q[ 裸 tap tInner ] ]，
   * 顶层没有租约。改动前（`.scratch/probe-nested-parallel.mts`）实测：
   *   调用序 ["lease L1","release L1"]，tInner = error「执行设备步骤前缺少 device 租约」
   *   —— 内层那一支去读 runSlot（顶层，空的），看不见它外层分支刚拿到的 L1。
   * 而 lint 对同一形状**不报** tInner（只报 P 的另一支 tB，那条本来就该报），
   * 也就是静态侧认为"外层分支的租约对内层有效"。两边必须同一个口径，
   * 而这里运行侧是错的那一方：内层步骤确实在外层刚申请到的那台上跑才讲得通。
   */
  const f = farm();
  const r = await runScenario({
    scenario: scen([par('p', [seq('brA', [dev('dA'), par('Q', [tap('tInner')], { failFast: false })]), tap('tB')], { failFast: false })]),
    adapters: f.adapters, clock: deterministicClock(), runId: 'r',
  });
  const tInner = r.results.find((x) => x.stepId === 'tInner');
  assert.equal(tInner?.status, 'pass', `内层该继承外层分支那台，而不是"没租约"：${tInner?.status}｜${tInner?.assertionSummary}`);
  assert.equal(f.calls.filter((c) => c === 'perform').length, 1,
    `只有 tInner 真跑出去了（tB 那一支没租约，该被拦下）：${JSON.stringify(f.calls)}`);
  // 只 lease 一台：tInner 用的是外层那台，不该再申请
  assert.deepEqual(idsOf(f.calls, 'lease'), ['L1'], `内层继承而非重复申请：${JSON.stringify(f.calls)}`);
  // tB 那一支仍然是 error（外层没有租约给它），这条不能因为"内层修好了"被顺带放宽
  assert.equal(r.results.find((x) => x.stepId === 'tB')?.status, 'error',
    'P 的另一支依然没有租约：修内层不该把这一支一起放行');
});

test('嵌套 parallel 各支自己申请：还的是自己那台，内层还完外层那台还在手上', async () => {
  /*
   * 形状：P 的两支都是 sequence[ device, parallel Q[ device, 裸 tap ] ] —— 四层深。
   *
   * **先记一条实测把我原先的说法打掉的事实。** 我本来以为"少传一层 slot"会表现为
   * "内层还了外层那台的 id、于是同一台被还两遍"，写注释时顺手这么写了。**探针
   * （`.scratch/probe-nested-b.mts`）跑出来不是**：少传一层时调用序是
   * `lease L1..L4 / release L3,L4,L1,L2`、收尾 inflight=0 —— **归还一条都没坏**，
   * 症状只有内层那两个裸 tap 恒 error。也就是说下面这组 release 归属断言
   * 对本轮那个缺陷是**瞎的**，本条真正抓到它的是最后那句 `r.status`。
   *
   * 那这组归属断言是不是白写的？三个已知错法（mutate/lease-slot.json T1/T8/T9）
   * 全都被"内层裸 tap 跑不起来"这一症状先抓住，所以它们今天一次也没响过。
   * 它们守的是**另一族**修法：把嵌套折叠成"整场共用一台"的实现会让
   * `leased.length` 变成 1、把"漏还"写错的实现会让集合不等 ——
   * 那些形状今天不存在，但**这一族的形状是"计数对而归属错"**（见上面那条测试的同款理由），
   * 只能靠 id 集合而不是计数来看见。
   *
   * **与上一条测试的分工**：第 12 条只有一支自备租约（另一支该 error），
   * 这条是**每支都自备**（全场该 pass）。少一层就多一层少一层的形状测不出来，
   * 而"全绿"这件事本身在并发+嵌套下才是一次真检验。
   */
  const f = farm();
  const br = (tag: string): StepDraft =>
    seq(`br${tag}`, [dev(`d${tag}`), par(`q${tag}`, [dev(`d${tag}i`), tap(`t${tag}`)], { failFast: false })]);
  const r = await runScenario({
    scenario: scen([par('p', [br('A'), br('B')], { failFast: false })]),
    adapters: f.adapters, clock: deterministicClock(), runId: 'r',
  });
  const leased = idsOf(f.calls, 'lease');
  assert.equal(leased.length, 4, `四台（每支外层一台 + 每支内层一台）：${JSON.stringify(f.calls)}`);
  const released = idsOf(f.calls, 'release');
  assert.deepEqual(released.slice().sort(), leased.slice().sort(),
    `还的 id 集合 == 拿的 id 集合：lease ${JSON.stringify(leased)} / release ${JSON.stringify(released)}`);
  /*
   * "每个 id 恰好还一次"这句看着与上一句重复（集合相等 + 数量相等就蕴含了），
   * **但它的分量在报错信息上**：集合那句红了只说"集合不对"，
   * 而"同一个 id 出现两次"直接指出是**归属错**而不是漏还 —— 这两种错的修法完全相反
   * （漏还该补一次 release，归属错该删一次），值班人按前者改会把事情改坏。
   */
  assert.equal(new Set(released).size, released.length,
    `每个 id 只该被还一次（还两遍 = 那台可能已发给别人）：${JSON.stringify(released)}`);
  assert.equal(f.inflight(), 0, `收尾不该攥着设备：${f.inflight()}`);
  assert.equal(r.status, 'pass', r.summary);
});

