/**
 * 被中断的 run 必须**自己说出**"我没跑完"（`RunReport.aborted`）。
 *
 * **改动前的实际形状**（本机跑真 runScenario 测出来的，引号里是原始输出）：
 * 三场景的 run，第二条 http 里把 signal 翻成 aborted：
 *
 * ```
 * results = seed:pass,a1:pass,s:pass   status = "pass"
 * events  = run.started,step.started,step.finished,…,error{"aborted":true}
 * ```
 *
 * 三个中断来源（外部取消 / 运行超时 / 成本熔断）全都从 `checkAbort`/`addCost`
 * 抛 `RunAborted`，被 run 的 catch 收成一条事件后**照常汇总**，于是
 * "第 2 步就被人按了 Ctrl-C"与"10 步全过"在 `status` / `summary` /
 * JUnit 计数 / CLI 退出码上是同一个形状。`EXIT.ABORTED = 10` 定义在退出码表里、
 * `CI_HINT` 里印着"10 被中断"，而**全仓没有一个生产者** ——
 * docs/14 §4.3 子类 **(c)「读了、也判了，但没有生产者」**换到**对外 API** 这层上的复现
 * （码表有名额、门禁判了、执行侧没人返回）。**同一子类、不同表面，不另立编号。**
 *
 * **为什么不改 `status`**：被中断的 run 里已完成的那几步结论各自仍然成立
 * （它们真的过了）。把整体状态改成 error 会伪装成"某一步坏了"，
 * 而实情是"这份报告不完整"。所以这是**关于报告**的事实，用 `aborted` 字段承载；
 * 下面第 1 条测试钉的正是"`status` 保持原样"这件事 —— 它不是遗留，是设计。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runScenario, deterministicClock, type AdapterRegistry, type Clock } from '../src/index.js';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

const b = (id: string) => ({ id });
const assertStep = (id: string): StepDraft => ({ ...b(id), kind: 'assert', against: '$n', expr: '$n == 1' } as StepDraft);
const seed = (): StepDraft => ({ ...b('seed'), kind: 'set', assign: { n: 1 } } as StepDraft);
const sleep = (id: string, ms: number): StepDraft => ({ ...b(id), kind: 'sleep', ms } as StepDraft);

const scen = (body: StepDraft[], extra: Partial<ScenarioDraft> = {}): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.int', name: 'int', env: { environmentRef: 'unit' },
    setup: [seed()], body, ...extra,
  } as ScenarioDraft);

/** 只在 sleep 时前进的时钟；`onSleep` 让测试能在"运行中途"改外部状态（翻 signal 等） */
function clockWith(onSleep?: (ms: number) => void): Clock {
  let t = 0;
  return {
    now: () => 1_700_000_000_000 + t,
    mono: () => t,
    sleep: async (ms: number) => { t += ms; onSleep?.(ms); },
    random: () => 0.5,
    mode: 'frozen',
  };
}

test('外部取消 → aborted.kind = cancelled，且 status **保持已完成步骤的结论**', async () => {
  const flag = { aborted: false };
  const r = await runScenario({
    scenario: scen([assertStep('a1'), sleep('s', 10), assertStep('a2')]),
    adapters: {}, clock: clockWith(() => { flag.aborted = true; }),
    runId: 'r', signal: flag,
  });
  // 夹具自检：中断**真的发生在中途**（第一断言跑过、第二断言没跑到）。
  // 少了这一句，"aborted 有值"可能来自别的成因，而这条测试测的是"中途被砍"。
  assert.ok(flag.aborted, '夹具没真的取消');
  assert.equal(r.results.some((x) => x.stepId === 'a1'), true, '夹具要让第一条断言先跑过');
  assert.equal(r.results.some((x) => x.stepId === 'a2'), false, '夹具要让第二条断言压根没跑');

  assert.equal(r.aborted?.kind, 'cancelled', JSON.stringify(r.aborted));
  assert.match(r.aborted!.reason, /外部取消/);
  // **status 不变**（见文件头）：已完成的一步确实过了
  assert.equal(r.status, 'pass');
  // 但**文字必须说出被中断**：summary 会原样进证据包 summary.txt 与 CI 日志，
  // 而那里人读的是文字，`status: pass` 在那儿就是一句假话
  assert.match(r.summary, /被中断/);
});

test('运行超时 → kind = timeout（与"有人取消"分开：值班人的动作不同）', async () => {
  // timeoutMs 的 IR 下限是 1000，所以用 sleep 5000 越过它（确定性时钟不真等）
  const r = await runScenario({
    scenario: scen([sleep('s', 5_000), assertStep('a2')], { config: { timeoutMs: 1_000 } } as Partial<ScenarioDraft>),
    adapters: {}, clock: deterministicClock(), runId: 'r',
  });
  assert.equal(r.aborted?.kind, 'timeout', JSON.stringify(r.aborted));
  assert.match(r.aborted!.reason, /运行超时/);
  assert.equal(r.results.some((x) => x.stepId === 'a2'), false, '超时之后的断言不该被执行');
});

test('成本熔断 → kind = cost。熔断点由**整次 run** 定，不是某一步自己判', async () => {
  /*
   * 成本只有一个来路：adapter 在 resolve() 里报 `costUsd`（视觉兜底那类档位）。
   * 用 maxCostUsd: 0 是**错**的写法 —— 我第一版就这么写，结果那条场景压根没被中断
   * （`addCost` 只在真有成本时调用，一个不花钱的步骤不会触发熔断），
   * 于是"kind === 'cost'"这个断言在任何实现下都成立。
   *
   * 第二版栽在另一个坑上：夹具给的是 `{ui}`，而 **tap 走的是 device adapter**
   * （interpreter 里只有 navigate/act/capture 用 ui），于是那步直接
   * `error / "tap 需要 device adapter"`，resolve 压根没被调用、成本为 0。
   * 所以夹具必须**自检**：下面先断言"成本真的记上了"。
   */
  const device = {
    async lease() { return { id: 'L1', deviceRef: 'dev-1', expiresAt: 0 }; },
    async renew() { return { expiresAt: 0 }; },
    async release() { },
    async app() { return {}; },
    async snapshot() { return { kind: 'hierarchy', data: '<h/>', sha: 's' }; },
    async perform() { return; },
    async resolve() {
      return { resolvedBy: 'vision', rung: 9, confidence: 0.4, nonReplayable: true, handle: 'h', costUsd: 0.9 };
    },
  };
  const r = await runScenario({
    scenario: scen([
      { ...b('d'), kind: 'device', target: 'android', require: { requires: [] } } as StepDraft,
      { ...b('t'), kind: 'tap', target: { intent: '登录', primary: { by: 'testid', value: 'x' } } } as StepDraft,
      assertStep('a2'),
    ]),
    adapters: { device } as unknown as AdapterRegistry, clock: deterministicClock(), runId: 'r', maxCostUsd: 0.1,
  });
  // 夹具自检：钱**真的**记上了（否则熔断分支不可达，这条测试是空的）
  assert.ok(r.costUsd > 0.1, `前提不成立：成本没记上，$${r.costUsd}。夹具要让 resolve 真的被调用`);
  assert.equal(r.aborted?.kind, 'cost', JSON.stringify(r.aborted));
  assert.match(r.aborted!.reason, /成本上限/);
  assert.equal(r.results.some((x) => x.stepId === 'a2'), false);
});

test('没被中断的正常 run **不带 aborted 字段**（而不是带一个空对象）', async () => {
  /*
   * 这条是本文件唯一"什么都没坏"的测试，而它最要紧：
   * 如果实现写成 `aborted: interruption ?? {kind:…, reason:''}`，
   * 上面几条**一条都不会红**（它们只判 aborted 有没有值），
   * 而门禁那边 `if (report.aborted)` 会把每一次正常运行都判成被中断。
   * `undefined`（没记）与"记了、没中断"要可区分 —— 与 childRuns 同一条理由。
   */
  const r = await runScenario({
    scenario: scen([assertStep('a1')]), adapters: {}, clock: deterministicClock(), runId: 'r',
  });
  assert.equal(r.aborted, undefined, JSON.stringify(r.aborted));
  assert.ok(!('aborted' in r), '没中断时这个键要**压根不在**对象上（不是 undefined 值占位）');
  assert.equal(r.status, 'pass');
  assert.ok(!/被中断/.test(r.summary), r.summary);
});

test('子场景自己被 timeoutMs 砍断时，call 步骤**不能报 pass**', async () => {
  /*
   * 同一个缺陷在第二层上的复现：子场景有**自己的** config.timeoutMs，
   * 于是"子里被砍、父侧一切正常"是可达的 —— 改动前实测
   * `parent results = c1:pass,a9:pass`、`child status = pass`，
   * 一份中间被砍断的子场景在父报告里是一条干净的通过。
   * 这条比父侧更难发现，因为父的 summary 看起来完全正常。
   */
  const sub = defineScenario({
    schemaVersion: '1', id: 'scn.sub', name: '子场景', env: { environmentRef: 'unit' },
    config: { timeoutMs: 1_000 },
    body: [sleep('slow', 5_000), assertStep('a2')],
  } as ScenarioDraft);
  const parent = scen([{ ...b('c1'), kind: 'call', scenarioRef: 'scn.sub@1' } as StepDraft, assertStep('a9')]);

  const r = await runScenario({
    scenario: parent,
    adapters: { callScenario: async (ref: string) => (ref.startsWith('scn.sub') ? sub : undefined) } as unknown as AdapterRegistry,
    clock: deterministicClock(), runId: 'r',
  });
  const c1 = r.results.find((x) => x.stepId === 'c1');
  assert.equal(c1?.status, 'error', `子里被砍，call 这步不该是 ${c1?.status}`);
  assert.equal(c1?.cause, 'env-unavailable', '被砍不是被测产品的结论，归环境');
  // 父报告也要如实说不完整（否则人看父的 summary 会以为一切正常）
  assert.equal(r.aborted?.kind, 'timeout');
  assert.match(r.aborted!.reason, /c1/, '成因里要点名是哪个 call');
  assert.equal(r.results.some((x) => x.stepId === 'a9'), false, 'call 报错之后不该继续跑后面的断言');
});

test('取消发生在**子场景中间**时，子场景剩下的步骤不许再跑（`signal` 要透传进子运行）', async () => {
  /*
   * 上一条测的是"子里被**自己的** timeoutMs 砍"，那条走的是子里那道闸，
   * 所以它压根碰不到 `opts.signal` 有没有往下传这件事。
   *
   * **改动前实测**（探针在 body 里放 6 条 sleep，第 3 条之后把 flag 翻 true）：
   *
   * ```
   * 子场景跑了 = s1,s2,s3,s4,s5,s6   父 results = seed:pass, c1:pass   aborted = 外部取消
   * ```
   *
   * 也就是**人已经按了 Ctrl-C，子场景把剩下的三步照样跑完**。
   * 这不是"少优化一处"：子场景的 body 里可能是 POST/下单/删除
   * （docs/02 §5 的不可逆动作纪律），"取消"的全部意义就是**从此不再产生副作用**，
   * 而深层 `call` 里的那一半副作用照发。顺带还有钱 —— 视觉兜底那档每一步都在花钱。
   *
   * 为什么这个洞能活着：`runScenarioIn` 的入参里 `secretResolver`、`envRevision`、
   * `callStack`、`responseLedger` **一个个都补过**（每个都对应一条实测后果，
   * `responseLedger` 那条注释写的就是"可选参数一旦忘了传也编译得过"），
   * 而 `signal` 是最后一个没补的。**同一个签名漏同一个字段**，
   * 说明"这是不是必须透传"这件事从来没有被当成一个问题问过。
   */
  const flag = { aborted: false };
  const sub = defineScenario({
    schemaVersion: '1', id: 'scn.sub', name: '子场景', env: { environmentRef: 'unit' },
    body: [sleep('s1', 10), sleep('s2', 10), sleep('s3', 10), sleep('s4', 10), sleep('s5', 10)],
  } as ScenarioDraft);
  const parent = scen([{ ...b('c1'), kind: 'call', scenarioRef: 'scn.sub@1' } as StepDraft, assertStep('a9')]);

  // 在第 3 步（累计 30ms）之后翻 flag：s1-s3 该跑完，s4/s5 不该跑。
  // 累加而不是看单次 ms —— clockWith 给的是**这一步**睡了多久（每条都是 10）
  let slept = 0;
  const r = await runScenario({
    scenario: parent,
    adapters: { callScenario: async (ref: string) => (ref.startsWith('scn.sub') ? sub : undefined) } as unknown as AdapterRegistry,
    clock: clockWith((ms) => { slept += ms; if (slept >= 30) flag.aborted = true; }),
    runId: 'r', signal: flag,
  });
  const child = (r.childRuns ?? []).find((c) => c.callStepId === 'c1');
  const ran = (child?.results ?? []).map((x) => x.stepId);
  // 夹具自检：取消**确实发生在子场景中间**（否则这条只是在测"父侧会停"，那是旧行为）
  assert.ok(ran.includes('s1') && ran.includes('s3'), `前三步该跑完，实际 ${ran.join(',')}`);
  assert.ok(!ran.includes('s4') && !ran.includes('s5'),
    `取消之后子场景还跑了 ${ran.join(',')}。透传失败时这一步必红`);

  assert.equal(r.aborted?.kind, 'cancelled', JSON.stringify(r.aborted));
  // 父侧那一步不能是 pass：它**没有完整跑完**（剩下的步骤是被取消掉的）
  const c1 = r.results.find((x) => x.stepId === 'c1');
  assert.equal(c1?.status, 'error', `子里被取消，call 这步不该是 ${c1?.status}`);
  assert.equal(c1?.cause, 'env-unavailable', '被取消不是被测产品的结论，归环境');
  assert.equal(r.results.some((x) => x.stepId === 'a9'), false, '取消之后父侧剩下的步骤也不该跑');
});

/*
 * ── 被中断之后，teardown 还跑不跑 ─────────────────────────────────────────
 *
 * IR 那边写的是「teardown 默认必跑（含 data GC）」，而本轮之前它只挂在 try 的后半段 ——
 * **中断、成本熔断、任何抛出的异常都会跳过它**。本机实测（body 中途取消，teardown 一条清理步骤）：
 *
 * ```
 * status = pass   results = seed:pass, slow:pass   teardown 跑了吗 = false
 * ```
 *
 * 后果不是"少跑几步"这么轻：**环境里留下了这次 run 造的数据，而没有任何一行说它留下了**。
 * `TEARDOWN_FAILED` 也挂在 try 里，所以那条事件同样不发 ——
 * "清理没做"在报告、trace、证据包里**零痕迹**，与 docs/08「少验了什么要有一行可指」正相反。
 * 而按一次 Ctrl-C 是最常见的取消场景。下面四条各钉这个缺陷的一个面。
 */

const tdFail = (): StepDraft => ({ ...b('td'), kind: 'assert', against: '$n', expr: '$n == 999' } as StepDraft);
const tdOk = (): StepDraft => ({ ...b('td'), kind: 'set', assign: { cleaned: true } } as StepDraft);

test('被取消的 run 里 teardown **照跑**（清理不留脏数据是这个字段的唯一用途）', async () => {
  const flag = { aborted: false };
  const r = await runScenario({
    scenario: scen([assertStep('a1'), sleep('s', 10), assertStep('a2')], { teardown: [tdOk()] } as Partial<ScenarioDraft>),
    adapters: {}, clock: clockWith(() => { flag.aborted = true; }), runId: 'r', signal: flag,
  });
  // 夹具自检：确实是被中断的（否则这条测试只是在测"正常路径会跑 teardown"，那是旧行为）
  assert.equal(r.aborted?.kind, 'cancelled', JSON.stringify(r.aborted));
  assert.equal(r.results.some((x) => x.stepId === 'a2'), false, '夹具要让 a2 没跑到');

  const td = r.results.find((x) => x.stepId === 'td');
  assert.ok(td, `中断后 teardown 必须跑。results = ${r.results.map((x) => `${x.stepId}:${x.status}`).join(',')}`);
  assert.equal(td!.status, 'pass', JSON.stringify(td));
});

test('超时砍断的 run 里 teardown 也照跑（暂停的是**整道 run 级闸**，不只是取消）', async () => {
  /*
   * 这条是唯一能测出"只处理 signal、忘了处理 timeout"的实现。
   *
   * 中断之后 `clock.mono() - t0 > timeoutMs` **持续成立**（时间只会更远），
   * 所以只把 `opts.signal?.aborted` 那支绕开的话，teardown 第一步照样被
   * run 级超时抛死 —— 症状与"压根没修"一字不差，而取消那条测试**照样是绿的**。
   * 这就是为什么两种中断成因要各测一遍：它们共用一个 checkAbort，
   * 而"暂停清理期的闸"这件事必须对整个闸做。
   */
  const r = await runScenario({
    scenario: scen([sleep('s', 5_000), assertStep('a2')], {
      config: { timeoutMs: 1_000 }, teardown: [tdOk()],
    } as Partial<ScenarioDraft>),
    adapters: {}, clock: deterministicClock(), runId: 'r',
  });
  assert.equal(r.aborted?.kind, 'timeout', JSON.stringify(r.aborted));
  assert.ok(r.results.some((x) => x.stepId === 'td'),
    `超时之后清理期仍被 run 级超时拦住了。results = ${r.results.map((x) => `${x.stepId}:${x.status}`).join(',')}`);
});

test('中断后清理步骤自己失败时**不改整体结论**，但要发 TEARDOWN_FAILED（脏数据要有一行可指）', async () => {
  const flag = { aborted: false };
  const r = await runScenario({
    scenario: scen([assertStep('a1'), sleep('s', 10), assertStep('a2')], { teardown: [tdFail()] } as Partial<ScenarioDraft>),
    adapters: {}, clock: clockWith(() => { flag.aborted = true; }), runId: 'r', signal: flag,
  });
  // 夹具自检：清理**真的**跑了且**真的**失败了（否则这条测的是"清理没跑"，与判据无关）
  const td = r.results.find((x) => x.stepId === 'td');
  assert.equal(td?.status, 'fail', `夹具要让清理失败：${JSON.stringify(td)}`);

  // 整体状态不因清理失败变红（"被测功能对不对"与"清理做干净没"是两个问题，
  // 混起来会让一次 cleanup 500 掩盖 body 的结论 —— 与未中断时同一条判断）
  assert.equal(r.status, 'pass', r.summary);
  // 但也不能静默：TEARDOWN_FAILED 是唯一说得出"可能留脏数据"的一行
  const ev = r.events.find((e) => (e.data as { code?: string } | undefined)?.code === 'TEARDOWN_FAILED');
  assert.ok(ev, `该有 TEARDOWN_FAILED。events = ${r.events.map((e) => e.kind).join(',')}`);
});

test('teardown **只跑一次**（清理步骤不保证幂等，DELETE 两次会 404）', async () => {
  /*
   * 补跑逻辑写在 finally 里，而 finally 在**正常路径上也会跑**。
   * 少一个"跑过了就别再跑"的标记的话，正常场景的每条清理都做两遍：
   * 表现不是报错，而是"DELETE 第二次返回 404 => 这一步 fail => TEARDOWN_FAILED"，
   * 一次完全正常的 run 因此长期挂着"可能留脏数据"的告警 ——
   * 告警一多就没人看，等它哪天报的是真问题时已经没人信了。
   */
  const r = await runScenario({
    scenario: scen([assertStep('a1')], { teardown: [tdOk()] } as Partial<ScenarioDraft>),
    adapters: {}, clock: deterministicClock(), runId: 'r',
  });
  // 夹具自检：正常路径**没**被中断（否则这条测的是中断路径的"跑到了"，不是"只跑一次"）
  assert.ok(!('aborted' in r), JSON.stringify(r.aborted));
  const tds = r.results.filter((x) => x.stepId === 'td');
  assert.equal(tds.length, 1, `teardown 跑了 ${tds.length} 次，应当只有 1 次`);
});

