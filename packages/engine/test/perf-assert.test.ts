/**
 * `assertPerf` 的行为（docs/09 §4.3）。
 *
 * **这个文件之前不存在，而 assertPerf 里那条"相对基线退化"的判据正是因此坏的**：
 * 原实现写的是 `if (p.maxRegressionRatio !== undefined && metrics.baselinePctl)` ——
 * 基线缺失时整条判据静默不跑，断言照样 pass。
 * 于是性能回归门禁在基线表为空的半年里一直绿灯放行，看板上一片绿，
 * 而它实际拦下的次数是 0。没人会发现，因为"门禁没拦"和"代码没问题"长得一模一样。
 *
 * 这就是"schema 里有这个字段"和"这个字段被读了"的区别（本仓的反复出现的缺陷类别，
 * 见 docs/08 §3）。测试是唯一的分界线。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { b, res, run, scen, type StepDraft } from './helpers.js';

/** 一份指标 + 一条性能断言。指标用 set 造，避免依赖真实压测 adapter。 */
const perfCase = (metrics: Record<string, unknown>, over: Record<string, unknown> = {}): ReturnType<typeof scen> =>
  scen([
    { ...b('m'), kind: 'set', assign: { metrics } },
    { ...b('p'), kind: 'assertPerf', against: '$metrics', percentile: 95, ...over } as StepDraft,
  ] as StepDraft[]);

test('p95 超过绝对阈值判 fail', async () => {
  const r = await run(perfCase({ p95: 300 }, { lte: 200 }));
  assert.equal(res(r, 'p').status, 'fail');
  assert.match(res(r, 'p').assertionSummary ?? '', /p95=300ms > 200ms/);
});

test('p95 在阈值内判 pass', async () => {
  const r = await run(perfCase({ p95: 100 }, { lte: 200 }));
  assert.equal(res(r, 'p').status, 'pass');
});

test('错误率超阈值判 fail', async () => {
  const r = await run(perfCase({ p95: 100, errorRate: 0.05 }, { errorRateLte: 0.01 }));
  assert.equal(res(r, 'p').status, 'fail');
  assert.match(res(r, 'p').assertionSummary ?? '', /错误率/);
});

test('分位数缺失 -> error（不是 fail：这是"测不到"，不是"被测系统坏了"）', async () => {
  const r = await run(perfCase({ somethingElse: 1 }, { lte: 200 }));
  assert.equal(res(r, 'p').status, 'error');
  assert.match(res(r, 'p').assertionSummary ?? '', /缺少 p95 指标/);
});

test('写了 maxRegressionRatio 但没有基线 -> error，绝不 pass', async () => {
  const r = await run(perfCase({ p95: 300 }, { maxRegressionRatio: 0.2 }));
  const step = res(r, 'p');
  assert.equal(step.status, 'error', '判据没跑就不能给通过。这是本文件存在的理由');
  assert.match(step.assertionSummary ?? '', /性能回归判据没有跑/);
  assert.equal(step.cause, 'case-stale', '是用例/基线配置的问题，不是产品 bug');
  assert.notEqual(step.status, 'pass');
});

test('基线为 0 也不算有效基线（否则算出无穷大退化或除零）', async () => {
  // null/undefined 不是合法的 IR 字面量（LiteralSchema 不收），所以坏值只测能进 IR 的那些；
  // "压根没这个键"单独立一条 —— 那才是真实里最常见的一种（基线表为空）。
  for (const bad of [0, -1, 'abc']) {
    const r = await run(perfCase({ p95: 300, baselinePctl: bad }, { maxRegressionRatio: 0.2 }));
    assert.equal(res(r, 'p').status, 'error', `baselinePctl=${String(bad)}`);
  }
  const missing = await run(perfCase({ p95: 300 }, { maxRegressionRatio: 0.2 }));
  assert.equal(res(missing, 'p').status, 'error', '缺键同样要报错');
});

test('相对基线退化超阈值 -> fail，并带出百分比', async () => {
  const r = await run(perfCase({ p95: 150, baselinePctl: 100 }, { maxRegressionRatio: 0.2 }));
  assert.equal(res(r, 'p').status, 'fail');
  assert.match(res(r, 'p').assertionSummary ?? '', /相对基线退化 50\.0% > 阈值 20%/);
});

test('相对基线未超阈值 -> pass', async () => {
  const r = await run(perfCase({ p95: 110, baselinePctl: 100 }, { maxRegressionRatio: 0.2 }));
  assert.equal(res(r, 'p').status, 'pass');
});

test('变快了不判 fail（负退化率不超阈值）', async () => {
  const r = await run(perfCase({ p95: 50, baselinePctl: 100 }, { maxRegressionRatio: 0.2 }));
  assert.equal(res(r, 'p').status, 'pass');
});

test('没写 maxRegressionRatio 时不因缺基线而报错（没要求就不拦）', async () => {
  const r = await run(perfCase({ p95: 100 }, { lte: 200 }));
  assert.equal(res(r, 'p').status, 'pass');
});
