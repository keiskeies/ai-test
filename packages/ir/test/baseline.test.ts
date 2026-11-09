/**
 * baseline 模型的行为测试（docs/09 §4.3）。
 *
 * 这个文件里最值钱的不是"退化 20% 会 fail"，而是那几条 **unknown** 路径：
 * 没基线、不可比、样本不足、同版本。性能门禁最常见的死法不是判错，
 * 而是拿一次不可比的跑当基线 -> 每次发布都报退化 -> 三周后有人把门禁关掉。
 * 所以"判不出来时明确说判不出来"必须是被测行为，而不是注释里的愿望。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BaselineSampleSchema, LoadFingerprintSchema, MIN_SAMPLES_MS, PerfGateThresholdsSchema,
  PerfMetricsSchema, evaluatePerfGate, incomparableReasons, pickBaseline, promoteRefused,
  type BaselineSample, type LoadFingerprint, type PerfMetrics,
} from '../src/index.js';

const env = { environmentRef: 'staging', envRevision: 3, runnerVersion: '1.0', platform: 'linux', clockMode: 'frozen' } as const;

const load = (over: Partial<LoadFingerprint> = {}): LoadFingerprint =>
  LoadFingerprintSchema.parse({ runnerSpec: '8c16g', vus: 100, durationMs: 60_000, dataVolume: 10_000, ...over });

const metrics = (over: Partial<PerfMetrics> = {}): PerfMetrics =>
  PerfMetricsSchema.parse({ p50Ms: 20, p95Ms: 100, p99Ms: 200, rps: 500, errorRate: 0, samples: 30_000, ...over });

const sample = (over: Partial<BaselineSample> = {}): BaselineSample =>
  BaselineSampleSchema.parse({
    id: 'bl1', projectId: 'p1', scenarioId: 'scn1', sourceRunId: 'r1',
    metrics: metrics(), runStatus: 'pass', env, load: load(), takenAt: 1_700_000_000_000, ...over,
  });

/** 默认门槛（docs/09 §4.3：p95 退化 20% / 错误率 0.1%） */
const T = PerfGateThresholdsSchema.parse({});

// ── 判据本身 ───────────────────────────────────────────────────────────────

test('p95 退化 20% 以内判 pass', () => {
  const r = evaluatePerfGate(metrics({ p95Ms: 110 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.regressions.p95, 0.1);
});

test('p95 退化超过 20% 判 fail，且原因里带具体百分比', () => {
  const r = evaluatePerfGate(metrics({ p95Ms: 130 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'fail');
  assert.match(r.reasons.join('\n'), /p95：退化 30\.0% > 阈值 20%/);
});

test('等于阈值算 pass（边界只有一处定义）', () => {
  const r = evaluatePerfGate(metrics({ p95Ms: 120 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'pass', 'r > lim 才超标。两处比较点会各自取符号，所以判定点只能有一个');
});

test('变快了不报退化（退化比例可为负）', () => {
  const r = evaluatePerfGate(metrics({ p95Ms: 50, p50Ms: 10 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'pass');
  assert.ok((r.regressions.p95 ?? 0) < 0);
});

test('p50 阈值更严：p95 没超而 p50 超 -> fail', () => {
  // p50 涨 = 整条路径变慢，多半是代码/依赖变了；默认阈值 10% 比 p95 的 20% 严
  const r = evaluatePerfGate(metrics({ p95Ms: 115, p50Ms: 25 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'fail');
  assert.match(r.reasons.join('\n'), /p50：退化 25\.0%/);
});

test('错误率是绝对判据，与基线无关', () => {
  const r = evaluatePerfGate(metrics({ errorRate: 0.02 }), sample({ metrics: metrics({ errorRate: 0.02 }) }), load(), env, T);
  assert.equal(r.verdict, 'fail', '基线自己错误率就高，相对值会把问题掩盖掉');
  assert.match(r.reasons.join('\n'), /错误率 2\.00% > 阈值 0\.10%/);
});

test('吞吐只 warn，不 fail（第一版就 fail 的阈值会被立刻关掉）', () => {
  const r = evaluatePerfGate(metrics({ rps: 400 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'warn');
  assert.match(r.reasons.join('\n'), /吞吐/);
});

test('吞吐涨了不算退化', () => {
  const r = evaluatePerfGate(metrics({ rps: 900 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'pass');
});

test('延迟与吞吐同时超标时取最严重的一档（fail 不被 warn 盖掉）', () => {
  const r = evaluatePerfGate(metrics({ p95Ms: 400, rps: 100 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'fail');
});

// ── unknown：整个模型最有价值的部分 ───────────────────────────────────────

test('没有基线 -> unknown，绝不是 pass', () => {
  const r = evaluatePerfGate(metrics(), undefined, load(), env, T);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.unknownWhy, 'no-baseline');
  // 这条是"新场景上线头三个月没有门禁而没人知道"的唯一防线
  assert.notEqual(r.verdict, 'pass');
});

test('指纹不可比 -> unknown 并逐项列出原因', () => {
  for (const [why, over] of [
    ['施压机规格', { runnerSpec: '16c32g' }],
    ['并发数', { vus: 500 }],
    ['时长', { durationMs: 120_000 }],
    ['节点数', { runnerCount: 3 }],
  ] as const) {
    const r = evaluatePerfGate(metrics(), sample(), load(over), env, T);
    assert.equal(r.verdict, 'unknown', why);
    assert.equal(r.unknownWhy, 'incomparable');
    assert.match(r.reasons.join('\n'), new RegExp(why));
  }
});

test('数据量是"同一条 SQL 慢十倍"的头号外因，必须进可比性检查', () => {
  assert.deepEqual(incomparableReasons(load({ dataVolume: 10_000 }), load({ dataVolume: 9_000_000 })), [
    '数据量不同（10000 vs 9000000）',
  ]);
  // 一边没填 = 填报缺失，也算不可比：拿"未记录"当"相同"会让差异静默通过
  assert.match(incomparableReasons(load({ dataVolume: undefined }), load()).join('\n'), /未记录/);
  // 两边都没填则不拦（否则所有没接数据量统计的项目都跑不了门禁）
  assert.doesNotMatch(incomparableReasons(load({ dataVolume: undefined }), load({ dataVolume: undefined })).join('\n'), /数据量/);
});

test('同一被测版本之间不存在"回归" -> unknown 而不是 pass', () => {
  const r = evaluatePerfGate(metrics({ p95Ms: 400 }), sample({ env: { ...env, appSha: 'abc' } }), load(), { ...env, appSha: 'abc' }, T);
  assert.equal(r.verdict, 'unknown');
  // 原因是"该更新基线"，而不是给个绿灯把人打发走
  assert.match(r.reasons.join('\n'), /应更新基线/);
});

test('样本量为 0 的运行不能判通过（压根没打出请求）', () => {
  const r = evaluatePerfGate(metrics({ samples: 0 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'fail');
  assert.match(r.reasons.join('\n'), /样本量为 0/);
});

test('本次跑坏了 优先于 没基线（顺序错了能让坏流水线连绿一周）', () => {
  // 样本为 0 又没基线时，若先判"没基线"就会返回 unknown。
  // unknown 在多数 CI 配置里不阻断，于是"施压脚本启动即崩"能连续一周不被发现。
  const r = evaluatePerfGate(metrics({ samples: 0 }), undefined, load(), env, T);
  assert.equal(r.verdict, 'fail');
});

test('本次样本远少于基线 -> unknown（分位数不可比）', () => {
  const r = evaluatePerfGate(metrics({ samples: 100 }), sample(), load(), env, T);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reasons.join('\n'), /远少于基线/);
});

test('指标缺测时跳过该项并写明"不是通过"', () => {
  const base = sample({ metrics: { errorRate: 0, samples: 30_000 } });
  const r = evaluatePerfGate(metrics({ p50Ms: undefined, p95Ms: undefined, p99Ms: undefined, rps: undefined }), base, load(), env, T);
  assert.equal(r.verdict, 'pass');
  assert.match(r.reasons.join('\n'), /p95：基线或本次缺测，跳过该项/);
  // 缺测不能被当成 0：否则"没测到 p95"会算出 -100% 的"巨大改善"
  assert.equal(r.regressions.p95, undefined);
});

test('基线分位数为 0 时不算退化比例（除零不是无穷改善）', () => {
  const base = sample({ metrics: { p95Ms: 0, p50Ms: 0, errorRate: 0, samples: 1000 } });
  const r = evaluatePerfGate(metrics(), base, load(), env, T);
  assert.equal(r.regressions.p95, undefined);
});

// ── 谁有资格当基线 ────────────────────────────────────────────────────────

test('healed 的 run 不能当基线（基线被悄悄下调是最隐蔽的失效）', () => {
  assert.match(promoteRefused({ runStatus: 'healed', load: load(), metrics: metrics() }).join('\n'), /healed/);
  assert.deepEqual(promoteRefused({ runStatus: 'pass', load: load(), metrics: metrics() }), []);
  assert.match(promoteRefused({ runStatus: 'fail', load: load(), metrics: metrics() }).join('\n'), /fail/);
});

test('短跑不能当基线（p95 由个位数样本决定，抖动就能"退化 30%"）', () => {
  assert.ok(MIN_SAMPLES_MS > 0);
  assert.match(promoteRefused({ runStatus: 'pass', load: load({ durationMs: 5_000 }), metrics: metrics() }).join('\n'), /样本量不足/);
});

test('pinned 的手动基线绕开自动入选条件，但不绕开可比性检查', () => {
  const bad = { runStatus: 'healed', load: { durationMs: 1 }, metrics: { samples: 0 }, pinned: true };
  assert.deepEqual(promoteRefused(bad), [], '人有意钉的那次（比如上线前那次）不该被自动规则否掉');
  // 而可比性照旧要过：拿另一台机器跑的 pinned 基线判本次，一样会把门禁作死
  const pinned = sample({ runStatus: 'healed', pinned: true, load: load({ runnerSpec: 'tiny-laptop' }) });
  assert.equal(pickBaseline([pinned])?.id, 'bl1');
  assert.equal(evaluatePerfGate(metrics(), pinned, load(), env, T).verdict, 'unknown');
});

test('pickBaseline：pinned 优先，其次最近一次合格的（不是平均值）', () => {
  const old = sample({ id: 'old', takenAt: 1, pinned: true });
  const recent = sample({ id: 'new', takenAt: 9 });
  const healed = sample({ id: 'healed', runStatus: 'healed', takenAt: 99 });
  assert.equal(pickBaseline([healed, recent, old])?.id, 'old', 'pinned 优先于更新的合格跑');
  assert.equal(pickBaseline([healed, recent])?.id, 'new');
  assert.equal(pickBaseline([healed]), undefined, '全不合格 = 没有基线，走 unknown');
});

test('最新合格跑而不是平均值：平均值会把一次故障摊进基线', () => {
  // 平均值方案的后果：一次 p95=2000ms 的故障跑进基线后，
  // 正常 p95=100 会变成"改善 95%"，而真退化到 300 却"没超阈值"。
  const a = sample({ id: 'a', takenAt: 1, metrics: metrics({ p95Ms: 100 }) });
  const b = sample({ id: 'b', takenAt: 2, metrics: metrics({ p95Ms: 120 }) });
  assert.equal(pickBaseline([a, b])?.id, 'b');
});

// ── schema 自身的严格性 ───────────────────────────────────────────────────

test('错误率 > 1 被 schema 拒掉（0..1 是比率，不是百分数）', () => {
  assert.throws(() => PerfMetricsSchema.parse({ errorRate: 5, samples: 1 }));
  assert.equal(PerfMetricsSchema.parse({ errorRate: 0.5 }).errorRate, 0.5);
});

test('指纹字段拼错不会被静默忽略（.strict()）', () => {
  assert.throws(() => LoadFingerprintSchema.parse({ runnerSpec: '8c16g', vus: 10, durationMs: 60_000, vus2: 10 }));
});

test('默认阈值就是文档里那三行数字', () => {
  assert.equal(T.maxP95Regression, 0.2);
  assert.equal(T.maxErrorRate, 0.001);
  assert.equal(T.minRpsRatio, 0.9);
});
