/**
 * 界面断言**打到哪个 adapter**（docs/15 §3.6）。
 *
 * 缺陷的形状不是"选错了"，是**选错了而两边都 pass**：
 * `evalUiAssert` 原先写 `adapters.ui ?? adapters.device`，于是
 *  - `assertPage`（web 档）在没有 ui 时被 **device** 顶上 —— 同一条断言，
 *    一次在 Chrome 里查 ARIA、一次在安卓上查 uiautomator 树，**两次都 pass**；
 *  - `assertUi`（mobile 档）在两个 adapter 都在时**永远打 UI** ——
 *    这一半更常踩，因为混合场景（web + app）本来两个 adapter 都在。
 *
 * `docs/14` §4.3 那一族里 (b)"读了但用错"讲的是**值**错，这条是**执行对象**错。
 * 判据取 IR 的 `STEP_TARGET`（kind → 端 的唯一权威表），不在此重抄清单。
 *
 * **夹具的关键**：两个假 adapter 必须**都能**返回 pass。
 * 如果让"错的那一个"返回 fail，测试就变成在验"谁返回 fail"，
 * 而真实缺陷恰恰是**两个都会返回 pass** —— 那时"结论 pass"这条断言毫无信息量，
 * 必须断言的是**被调用的那一个是谁**（记账比对）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run, scen, b, res, type StepDraft } from './helpers.js';
import { evalUiAssert } from '../src/index.js';
import type { ExecContext } from '../src/adapters.js';

/** 一个只会"通过"的 UI/device 假实现，但**记下自己被叫到过** */
function spyWorld(name: string, calls: string[], extra: Record<string, unknown> = {}) {
  return {
    async assertUi(_p: unknown, _ctx: ExecContext) { calls.push(name); return { passed: true, actual: 'a', expected: 'b' }; },
    async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async snapshot() { return { kind: 'aria' as const, data: '', sha: 'x' }; },
    async perform() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async app() { return null; },
    ...extra,
  };
}

const deviceLease = {
  async lease() { return { id: 'L1', deviceRef: 'em-1', expiresAt: 0 }; },
  async renew() { return { expiresAt: 0 }; },
  async release() { /* noop */ },
};

const ap = (id: string): StepDraft =>
  ({ ...b(id), kind: 'assertPage', assertKind: 'text', contains: '你好' }) as StepDraft;
const au = (id: string): StepDraft =>
  ({ ...b(id), kind: 'assertUi', assertKind: 'text', contains: '你好' }) as StepDraft;
const dev = (id: string): StepDraft => ({ ...b(id), kind: 'device', target: 'android', require: { requires: [] } }) as StepDraft;

test('assertPage（Web 档）两个 adapter 都在时打 **ui**，不打 device', async () => {
  const calls: string[] = [];
  const r = await run(scen([ap('a1')]), {
    adapters: { ui: spyWorld('ui', calls) as never, device: spyWorld('device', calls, deviceLease) as never },
  });
  assert.deepEqual(calls, ['ui'], `Web 档的断言该打 ui：${JSON.stringify(calls)}`);
  assert.equal(res(r, 'a1').status, 'pass');
});

test('**assertUi（移动端档）两个 adapter 都在时打 device，不打 ui**（改前打的是 ui）', async () => {
  /*
   * 这一条是本次修复里**最值钱的一条**：混合场景两个 adapter 都在是常态，
   * 所以"移动端的断言被浏览器执行了"这条一直在发生，而它一直 pass。
   * 改前的实测调用序就是 `UI`（探针 .scratch/probe-uiassert.mts 第 3 行）。
   */
  const calls: string[] = [];
  const r = await run(scen([dev('d'), au('a1')]), {
    adapters: { ui: spyWorld('ui', calls) as never, device: spyWorld('device', calls, deviceLease) as never },
  });
  assert.deepEqual(calls, ['device'], `移动端档的断言该打 device：${JSON.stringify(calls)}`);
  assert.equal(res(r, 'a1').status, 'pass');
});

test('assertPage 而**没有 ui**：error 且**不许 device 顶上**（改前是被 device 顶上并且 pass）', async () => {
  const calls: string[] = [];
  const r = await run(scen([ap('a1')]), {
    adapters: { device: spyWorld('device', calls, deviceLease) as never },
  });
  assert.deepEqual(calls, [], '缺的就是那个 adapter，另一个一次都不该被叫到');
  const x = res(r, 'a1');
  assert.equal(x.status, 'error', `顶不上就该 error，不该 pass：${x.status}｜${x.assertionSummary}`);
  assert.equal(x.cause, 'env-unavailable', '归因是"环境缺件"，不是产品 bug');
  assert.match(x.assertionSummary ?? '', /ui/, `报错要点名缺 ui：${x.assertionSummary}`);
  /*
   * 报错里**不许再把另一个 adapter 写成备选**（旧文案是"需要 ui/device adapter"）。
   * 那三个字符等于告诉排查人"另一个也行"，而这条修复的全部内容就是"另一个不行"。
   * 这一句断言看着苛刻，但它防的正是"下一个人把文案改回更宽松的那版"
   * —— 文案改回去通常伴随实现一起改回去，因为读起来更"通用"。
   */
  assert.ok(!/ui\s*\/\s*device|device\s*\/\s*ui/.test(x.assertionSummary ?? ''),
    `报错不许把另一个 adapter 列成备选：${x.assertionSummary}`);
});

test('assertUi 而**没有 device**（只有 ui）：error，且不许 ui 顶上', async () => {
  /*
   * 与上一条成**镜像对照**，但**不能**照上一条那样走 runScenario ——
   * 我第一版就是这么写的，而它是**空转的**：`assertUi` 在 LEASE_REQUIRED 里，
   * 没有 device adapter 就拿不到租约，那一步在**租约闸**上被拦下，
   * 报错恰好也说"缺 device adapter"（那是 adapter-contract.test.ts 钉的行为）。
   * 于是 status/cause/文案三条断言**全部因为别的原因成立**，
   * adapter 选择那段代码一次都没执行 —— 把它改回 `ui ?? device` 这条照样绿。
   *
   * 想干净地判"选择器不串台"，只能绕开租约闸直接调 evalUiAssert。
   * （真实链路里这一格永远被租约闸先挡住，所以这条是**防御性**的：
   *  它守的是"将来租约闸放宽 / 或有人从别处调这个函数"时不退回旧行为。）
   */
  const calls: string[] = [];
  const out = await evalUiAssert(au('a1') as never, {
    adapters: { ui: spyWorld('ui', calls) as never },
    ctx: { target: 'android', runId: 'r' } as never,
  } as never);
  assert.deepEqual(calls, [], '缺 device 时不该由 ui 代跑');
  assert.equal(out.status, 'error', `移动端断言没有设备时该 error 而不是被浏览器代跑：${out.status}`);
  assert.match(out.summary ?? '', /device/, `报错要点名缺 device：${out.summary}`);
});

test('两端各自的断言在**同一个混合场景**里互不串台', async () => {
  /*
   * 上面四条都是单断言场景。这条把两条断言放进**同一次运行**：
   * 真实缺陷是"选择器每次独立求值但都用同一个 ??",
   * 所以两条断言在同一次运行里会**都打到 ui**（device 那条被静默代跑）。
   * 逐条单测能各自通过而这一条红，是因为单测里常常只有一个 adapter 在场。
   */
  const calls: string[] = [];
  const both = { ui: spyWorld('ui', calls) as never, device: spyWorld('device', calls, deviceLease) as never };
  const r = await run(scen([dev('d'), ap('webOne'), au('appOne')]), { adapters: both });
  assert.deepEqual(calls, ['ui', 'device'], `两条断言各打各的世界：${JSON.stringify(calls)}`);
  assert.equal(res(r, 'webOne').status, 'pass');
  assert.equal(res(r, 'appOne').status, 'pass');
});
