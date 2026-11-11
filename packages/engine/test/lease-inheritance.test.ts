/**
 * `device.inheritToChildren`：字段名、默认值、注释三样一起描述了一个**没人实现**的语义
 * （`docs/15` §3.1 末段）。
 *
 * ## 这份文件钉的是"今天是什么样"，不是"应该是什么样"
 *
 * 它是一份**特征测试（characterization test）**，不是验收测试。区别很重要：
 * 验收测试红了说明代码坏了；这份红了说明**有人改了 `call` 的租约语义**，
 * 而那次改动必须同时回答下面"三条否决"里的至少一条 —— 否则它是把一个想清楚了的
 * 二选一（A 改字段 / B 真继承）悄悄走成了第三条没人选过的路。
 *
 * **为什么不直接把"继承"实现了**（我一开始就是想顺手透传，测完才知道不能）：见
 * `docs/15` §3.1 末段那三条否决理由（lint 与运行时会当场对不上 / 子场景的 `finally`
 * 会把父正在用的设备还回池子 / `parallel` 分支必须不继承而 IR 只有一个布尔字段）。
 * 这里只把**判据**钉住，二选一本身是产品决定，不该由一份测试替它做。
 *
 * ## 为什么这条必须落成测试，而不能停在临时探针里
 *
 * 探针脚本在 `.scratch/`，而 `.scratch/` 在 `.gitignore` 里 —— 也就是说
 * "我实测过父租约不跨 call"这句话**在仓库里没有任何可执行的后盾**，
 * 下一个人读到 docs 里那句结论时只能选择信我。这正是本仓那一族缺陷的正面写法：
 * **结论要能被别人一键推翻，否则它不是结论，是传闻。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lintScenario,
  runScenario,
  deterministicClock,
  type AdapterRegistry,
  type ExecContext,
} from '../src/index.js';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { b } from './helpers.js';

const seed = (): StepDraft => ({ ...b('seed'), kind: 'set', assign: { n: 1 } }) as StepDraft;
const dev = (id: string, over: Record<string, unknown> = {}): StepDraft =>
  ({ ...b(id), kind: 'device', target: 'android', require: { requires: [] }, ...over }) as StepDraft;
const tap = (id: string): StepDraft =>
  ({ ...b(id), kind: 'tap', target: { intent: '登录', primary: { by: 'testid', value: 'x' } } }) as StepDraft;
const call = (id: string, ref: string): StepDraft =>
  ({ ...b(id), kind: 'call', scenarioRef: ref }) as StepDraft;

const sc = (id: string, body: StepDraft[], extra: Record<string, unknown> = {}): Scenario =>
  defineScenario({
    schemaVersion: '1', id, name: id, env: { environmentRef: 'unit' }, body, ...extra,
  } as never);

/** 记 lease/renew/release/perform 的调用序，好让"那个设备步到底有没有发出去"可断言 */
function spyDevice() {
  const calls: string[] = [];
  let n = 0;
  const device = {
    async lease(_r: unknown, ctx: ExecContext) {
      n++;
      calls.push(`lease:L${n}@${ctx.target}`);
      return { id: `L${n}`, deviceRef: `dev-${n}`, expiresAt: 0 };
    },
    async renew(l: { id: string }) { calls.push(`renew:${l.id}`); return { expiresAt: 0 }; },
    async release(l: { id: string }) { calls.push(`release:${l.id}`); },
    async app() { calls.push('app'); return {}; },
    async snapshot() { return { kind: 'hierarchy' as const, data: '<h/>', sha: 's' }; },
    async perform() { calls.push('perform'); return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async resolve() { return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
  };
  return { adapters: { device } as unknown as AdapterRegistry, calls };
}

/** 父 setup 拿租约 + call 一个 body 只有裸 tap 的子场景 */
function parentChild(childBody: StepDraft[], deviceOver: Record<string, unknown> = {}) {
  const sub = sc('scn.sub', childBody, { setup: [seed()] });
  const parent = sc('scn.parent', [call('c1', 'scn.sub@1')], { setup: [seed(), dev('d', deviceOver)] });
  const d = spyDevice();
  const run = () =>
    runScenario({
      scenario: parent,
      adapters: {
        ...d.adapters,
        callScenario: async (ref: string) => (ref.startsWith('scn.sub') ? sub : undefined),
      } as unknown as AdapterRegistry,
      clock: deterministicClock(),
      runId: 'r',
    });
  return { d, run, sub, parent };
}

const resultsOf = (r: { results: Array<{ stepId: string; status: string }> }) =>
  r.results.map((x) => `${x.stepId}:${x.status}`).join(',');

test('父场景 setup 里的租约**不跨 call 边界**：子里那个裸 tap 压根没发出去', async () => {
  const { d, run } = parentChild([tap('t')]);
  const r = await run();
  const child = (r.childRuns ?? []).find((c) => c.callStepId === 'c1');
  assert.ok(child, 'call 应当在 childRuns 里留痕');

  /*
   * 改动前的实测输出就是这三行（探针 `.scratch/probe-child-lease.mts`，工作区代码）：
   *   adapter 调用序列 = ["lease:L1@android", "release:L1"]
   *   父 = seed:pass, d:pass, c1:error
   *   子 = seed:pass, t:error（"执行设备步骤前缺少 device 租约"）
   * 注意序列里**没有 perform**：不是"perform 失败了"，是**那一步没被执行**。
   */
  assert.deepEqual(
    d.calls,
    ['lease:L1@android', 'release:L1'],
    `父拿一台、还一台，子里那个 tap 一次都没发出去。序列变了 = call 的租约语义被改了，请连带读 docs/15 §3.1 末段：${JSON.stringify(d.calls)}`,
  );
  assert.equal(
    resultsOf(child!),
    'seed:pass,t:error',
    `子里的裸 tap 应是 error（无租约）：${resultsOf(child!)}`,
  );
  assert.match(
    /*
     * 字段是 `assertionSummary`，不是 `summary`。写错的那个名字**编译得过**，
     * 因为 tsx 只剥类型不做检查，而 `results` 的元素类型里两个字段都可选
     * —— 于是断言会拿着 `undefined` 去 match 并红成"消息不对"，
     * 看起来像实现有问题。这条注释是省下一个人三十分钟的。
     */
    child!.results.find((x) => x.stepId === 't')!.assertionSummary ?? '',
    /缺少 device 租约/,
    '报错要指名"缺租约"，而不是含糊的"设备步骤失败"',
  );
  // 子里 error → call 这一步 error → 整场 error。**不是 fail**：没测成 ≠ 产品错（docs/08 §3）
  assert.equal(resultsOf(r), 'seed:pass,d:pass,c1:error',
    `父侧：自己的租约拿到了（d:pass），但 call 这步该把子里的 error 带上来：${resultsOf(r)}`);
  assert.equal(r.status, 'error', `${r.summary}｜没测成不能被算成测出问题`);
});

test('`inheritToChildren: false` 与不写这个字段**输出完全一致** —— 因为它没有任何读者', async () => {
  /*
   * 这条是整份文件里唯一直接冲着那个字段去的断言。
   *
   * 为什么值得单独一条：字段是 `z.boolean().default(true)`，注释写着
   * "后续步骤隐式继承租约……先按继承实现并允许显式关闭"。一个读 IR 的人据此会写
   * `inheritToChildren: false` 并**以为**自己关掉了继承。而真实的误导方向更坏：
   * 他以为"默认继承"，于是父子各写一个 device 步时会担心"是不是占了两台设备"，
   * **实情是必须占两台**（否则子场景直接 error，见上一条）。
   *
   * 断言写成"两次输出逐字相同"而不是"都是 error"，是因为后者在"字段真被实现了、
   * 只是默认值判反了"的情况下也会成立。**相同才是"没人读"的证据。**
   */
  const off = parentChild([tap('t')], { inheritToChildren: false });
  const def = parentChild([tap('t')]);
  const [a, c] = [await off.run(), await def.run()];
  assert.deepEqual(off.d.calls, def.d.calls, `显式 false 应与默认值同效（同效 = 没读者）：${JSON.stringify(off.d.calls)} vs ${JSON.stringify(def.d.calls)}`);
  assert.equal(resultsOf(a), resultsOf(c), '父侧结论也应一致');
  assert.equal(JSON.stringify(a.childRuns), JSON.stringify(c.childRuns), '子侧报告应逐字一致');
});

test('子场景自己拿租约就能跑通 —— 今天**唯一**能用的写法（不是"绕过"，是现状的全部）', async () => {
  /*
   * 没有这条，上面两条只证明"某种形状失败"，不证明"换一种形状就成功"。
   * 只有两者同时成立，结论才是**语义**（租约不跨 call）而不是**故障**（call 里设备坏了）。
   */
  const { d, run } = parentChild([dev('d2'), tap('t')]);
  const r = await run();
  const child = (r.childRuns ?? []).find((c) => c.callStepId === 'c1')!;
  assert.equal(r.status, 'pass', `${r.summary}｜子场景自己申请租约就该跑通`);
  assert.equal(resultsOf(child), 'seed:pass,d2:pass,t:pass', resultsOf(child));
  assert.deepEqual(d.calls, ['lease:L1@android', 'lease:L2@android', 'perform', 'release:L2', 'release:L1'],
    `两层各拿各的、各还各的，且**里层先还**（perform 必须在里面那次 lease 之后 —— 它证明"那一步真的发出去了"，与第一条里序列中根本没有 perform 正好对照）。顺序变了要连带看"还的是不是自己那台"：${JSON.stringify(d.calls)}`);
});

test('lint 与运行时**今天同口径**：裸 tap 在子里，lint 也判 error（所以只改运行时会造出假阳性）', async () => {
  /*
   * 这条是"为什么不顺手透传"的第一条否决理由的**证据**，不是复述。
   *
   * 只改运行时的话：子场景那个裸 tap 会跑通，而 `atest lint` 仍以 error 级
   * （RESOURCE_LEASE_MISSING）拒掉同一份 IR → `atest lint` 退 3、`run --strict` 拒绝执行。
   * 于是"静态闸拒掉一个运行时能跑的写法"，而拒它的理由（"之前没有 device 租约"）
   * 与运行事实矛盾 —— 正是 `docs/14` §6 第一条刚修掉的那个方向，不该反方向再造一条。
   */
  const sub = sc('scn.sub', [tap('t')], { setup: [seed()] });
  const items = lintScenario(sub);
  const hit = items.find((i) => i.code === 'RESOURCE_LEASE_MISSING');
  assert.ok(hit, '子场景里那条裸 tap 现在被 lint 判死（lint 与运行时口径一致）');
  assert.equal(hit!.level, 'error', `是 error 级才会拦 CI：${hit!.level}`);
});

test('`Lease.state` 四态**连适配器都收不到**：renew/release 收到的对象只有 `id`', async () => {
  /*
   * `Lease.state` 的类型是四态（`leased` / `renewing` / `expired` / `released`），
   * 而全仓只有一处赋值、只写 `'leased'`（`interpreter.ts` 里 `stepCtx.lease = {…}` 那行）。
   *
   * **这条断言的是"它出不了这个进程"**，而不是"它只有一个值"——后者我在第一次写的时候
   * 写成了一个循环遍历事件名的空转断言（无论实现怎么改都会绿），那正是本仓反复在防的
   * "看起来有防护，实际漏一个"，所以我把它删了重写成这句可推翻的话：
   * 适配器侧 `renew(lease)` / `release(lease)` 拿到的实参**键集合是 `{id}`**。
   * 于是四态既不在报告里、也不在 trace 里（trace 只有 `lease.acquired` /
   * `lease.renewed` / `lease.lost` 三个**事件**，且 `lease.lost` 的载荷里也只有
   * `lease`/`device`/`reason`），更不到 Agent 眼前。
   *
   * **为什么这算"仍未接"而不是"没问题"**：一个字段如果只有生产者、没有任何消费者能观察它，
   * 那它对未来所有读代码的人都是**活的误导**（读到 `state: 'expired'` 会以为引擎会拦过期租约，
   * 而拦过期靠的是 `expiresAt` 那一段独立逻辑，与 state 无关）。
   * 真要让它有用，得先决定谁读它：报告？trace 里补 `lease.released`？还是直接删掉三态。
   * **这条红了 = 有人把整个 lease 传给适配器了**，那时要连带检查的是密钥与 PII
   * 有没有跟着 `deviceRef` 一起流进适配器日志（`redactForDisk` 在序列化那一步，不在这里）。
   */
  const seen: Array<Record<string, unknown>> = [];
  const sub = sc('scn.sub', [dev('d2'), tap('t')]);
  const parent = sc('scn.parent', [call('c1', 'scn.sub@1')], { setup: [dev('d')] });
  const device = {
    async lease() { return { id: 'L1', deviceRef: 'dev-1', expiresAt: 0 }; },
    async renew(l: Record<string, unknown>) { seen.push(l); return { expiresAt: 0 }; },
    async release(l: Record<string, unknown>) { seen.push(l); },
    async app() { return {}; },
    async snapshot() { return { kind: 'hierarchy' as const, data: '<h/>', sha: 's' }; },
    async perform() { return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async resolve() { return { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
  };
  const r = await runScenario({
    scenario: parent,
    adapters: { device, callScenario: async (ref: string) => (ref.startsWith('scn.sub') ? sub : undefined) } as unknown as AdapterRegistry,
    clock: deterministicClock(), runId: 'r',
  });
  assert.equal(r.status, 'pass', r.summary);
  assert.ok(seen.length >= 2, `两层各还一次，至少该看到 2 次适配器调用：${seen.length}`);
  for (const arg of seen) {
    assert.deepEqual(Object.keys(arg).sort(), ['id'],
      `适配器只该收到 id。多出来的键意味着租约内部字段（state / holder / acquiredAt）开始外流，先确认没有跟着敏感值：${JSON.stringify(arg)}`);
  }
});
