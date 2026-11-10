/**
 * 环境指纹的测试。
 *
 * 这个文件存在的意义比一般单测更具体：`EnvFingerprintSchema` 定义了**很久**而
 * 全仓没有任何构造点，只有 baseline.ts 认真比较它的三个字段。
 * 也就是说"性能基线的可比性判据"一直缺一个前提，而缺的方式是
 * **类型上齐、运行时没人填** —— 本仓记账最多的那一类。
 * 所以这里的判据重点不在"字段填了没"，而在**两次 run 拿去比会不会得出错误结论**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildEnvFingerprint } from '../src/fingerprint.js';
import { deterministicClock, liveClock } from '@atest/engine';
import { evaluatePerfGate } from '@atest/ir';

const base = {
  environmentRef: 'staging', env: {}, envRevision: 7, clock: liveClock(),
};
/** 冻结时钟：指纹里的 clockMode 要跟着时钟实例，不是跟着 env 里写了什么 */
const frozen = { ...base, clock: deterministicClock(42), randomSeed: 42 };

test('必填三件套每次都齐（schema 要求，缺一个就是装配缺陷）', () => {
  const f = buildEnvFingerprint(base);
  assert.equal(f.environmentRef, 'staging');
  assert.equal(f.envRevision, 7);
  assert.ok(f.platform, 'platform 必须非空（两次 run 比较的第一维）');
  assert.ok(f.runnerVersion, 'runnerVersion 缺省也要有个如实的值，不能 undefined');
});

test('envRevision 缺省是 0，**不是**一个会变的值', () => {
  /*
   * 这条看着像"给个默认值"的小事，实际决定性能门禁的生死：
   * 缺省填 Date.now() 之类，会让**每次 run 的指纹都不同**，
   * 于是 envDiffForPerf 永远报"环境不同"、基线永远不可用，
   * 然后有人把整个性能门禁关掉（docs/09 §4.3 记的就是这种结局）。
   * 0 的语义是"两次都没声明修订"—— 比较结果一致，这才诚实。
   */
  const a = buildEnvFingerprint({ ...base, envRevision: undefined });
  const b = buildEnvFingerprint({ ...base, envRevision: undefined });
  assert.equal(a.envRevision, 0);
  assert.deepEqual(a, b, '同一输入两次必须给出**完全相同**的指纹（可比较的前提）');
});

test('Web 的视口/DPR 来自 adapter 的实际生效值，不是 env 里的声明', () => {
  const f = buildEnvFingerprint({
    ...base,
    web: { meta: { viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' } },
  });
  assert.equal(f.viewport, '1440x900');
  assert.equal(f.deviceScaleFactor, 2, 'DPR 单独一维：1440x900@1 与 @3 的截图完全不可比');
  assert.equal(f.locale, 'zh-CN');
  assert.equal(f.timezone, 'Asia/Shanghai');
  // DPR=1 时**不写这一栏**（写了会让"没设 DPR"与"设成 1"两种历史 run 判成不同）
  const one = buildEnvFingerprint({ ...base, web: { meta: { viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } } } });
  assert.equal(one.deviceScaleFactor, undefined);
  assert.equal(one.viewport, '1280x720');
});

test('没起浏览器时 Web 那几维**缺着**，不给空串或假值', () => {
  /*
   * 缺与"记了但值不同"在比较时是两种结论：
   * 空串会让 API 场景与 Web 场景比出"视口不同（'' vs '1280x720'）"，
   * 而真相是"其中一次压根没有视口这一维"。
   */
  const f = buildEnvFingerprint(base);
  assert.equal(f.viewport, undefined);
  assert.equal(f.locale, undefined);
  assert.equal(f.timezone, undefined);
});

test('locale/时区可以从 env 取（没有 Web 也要能记 i18n 维度）', () => {
  // docs/06 §5：定位器是语言相关的，跑 locale 不同的两次结果不可比
  const f = buildEnvFingerprint({ ...base, env: { locale: 'en-US', timezoneId: 'UTC' } });
  assert.equal(f.locale, 'en-US');
  assert.equal(f.timezone, 'UTC');
  // 非字符串**当没配**，不 String(1) 那种"看着能用"的转换
  const g = buildEnvFingerprint({ ...base, env: { locale: 1 } });
  assert.equal(g.locale, undefined);
  // adapter 的实际值优先于 env 声明（声明可能与生效值不一致）
  const h = buildEnvFingerprint({ ...base, env: { locale: 'en-US' }, web: { meta: { viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, locale: 'zh-CN' } } });
  assert.equal(h.locale, 'zh-CN', '指纹要说实际生效的那个');
});

test('clockMode 跟的是时钟实例，不看 env 里写了什么', () => {
  assert.equal(buildEnvFingerprint(base).clockMode, 'live');
  const f = buildEnvFingerprint(frozen);
  assert.equal(f.clockMode, 'frozen', '声明与实况不一致时要报实况');
  assert.equal(f.randomSeed, 42, '确定性时钟 + 给了 seed 才记种子（回放要用）');
  // live 时钟下记 seed 是误导：那个值压根没参与本次运行
  const live = buildEnvFingerprint({ ...base, randomSeed: 42 });
  assert.equal(live.randomSeed, undefined);
});

test('appSha 只认字符串；缺省时不写这一栏', () => {
  assert.equal(buildEnvFingerprint({ ...base, env: { appSha: 'abc123' } }).appSha, 'abc123');
  assert.equal(buildEnvFingerprint(base).appSha, undefined);
  // baseline.ts 的 envDiffForPerf 有一句"appSha 相同 => 不存在回归"，
  // 两侧都缺时**不能**被判成"版本相同"，否则每次比较都会误报"该更新基线"
  const a = buildEnvFingerprint(base);
  const b = buildEnvFingerprint(base);
  assert.ok(!a.appSha && !b.appSha, '两侧都缺 appSha 是合法状态，比较侧要能区分"都缺"与"相同"');
});

test('字段类型漂了会**报错**，而不是写出一份比不了的指纹', () => {
  /*
   * 校验不是为了好看：这个结构唯一的用途是拿两次 run 比。
   * 一次 viewport 写成数字 1440、一次写成 "1440x900"，比较结果是"视口不同"，
   * 而人会花半天找"谁改了视口" —— 没人改，是类型漂了。
   * 这里用 ts-expect-error 造一个类型错的输入：**注释掉校验的话这行会变红**，
   * 也就是说这条同时钉住了"我们确实在校验"。
   */
  const bad = { ...base, envRevision: 'seven' } as unknown as Parameters<typeof buildEnvFingerprint>[0];
  assert.throws(() => buildEnvFingerprint(bad), /环境指纹不合法/, '类型不对必须当场报');
  // 报错只给字段路径，**不给值**：指纹里可能带 appSha 等内部标识，而它会进 CI 日志
  try { buildEnvFingerprint(bad); } catch (e) {
    assert.ok(!String((e as Error).message).includes('seven'), `报错不该回显实际值：${(e as Error).message}`);
  }
});

test('建出来的指纹**真的能满足性能门禁的前置**（这条是整个改动的存在理由）', () => {
  /*
   * 为什么要跨包测这一条：EnvFingerprintSchema 定义了很久而全仓没人构造它，
   * 而 baseline.ts 的 envDiffForPerf 一直在读 env.environmentRef/platform/appSha
   * 做可比性判断 —— 也就是说"这次 p95 比基线差 20%"这句话在实现上**永远缺一个前提**，
   * 而缺的方式是类型上齐、运行时没人填（本仓记账最多的那一类）。
   *
   * 只测"字段填了没"证明不了这点：填齐了但形状不被门禁接受，一样跑不通。
   *
   * ⚠ 两侧 appSha **都留空**。写这条测试时我以为"两侧 appSha 相同"最像同环境，
   * 结果门禁明确拒绝判定：baseline.ts 里写着"同版本之间不存在回归，应更新基线"
   * 并返回 incomparable。那是刻意的（同一版本自己与自己比不出退化），
   * 所以"可比"的正例要构造在**没有版本信息**这一侧。
   */
  const mk = (over: Partial<Parameters<typeof buildEnvFingerprint>[0]> = {}) =>
    buildEnvFingerprint({ ...base, ...over });
  const sample = (env: ReturnType<typeof buildEnvFingerprint>) => ({
    // id/projectId 是 BaselineSample 的必填外键（本包不知道数据库存在，只声明形状）。
    // 少这两个字段 npm test 照样绿 —— 它用 --import tsx，**不做类型检查**，
    // 是 typecheck:test 抓到我的（这正是要分开跑那两个命令的理由）
    id: 'bl-1', projectId: 'p1', scenarioId: 'scn.perf', targetKey: '', sourceRunId: 'r1',
    metrics: { p95Ms: 100, errorRate: 0, samples: 5_000 },
    runStatus: 'pass', env,
    // runnerCount 必填：参数类型是 BaselineSample（**输出**类型），
    // schema 上的 .default(1) 在输出类型里是必填 —— 这是那个类型最容易踩的一点：
    // 输入可以省、输出不能省。用 z.input<> 才看得到"可省"那一面
    load: { runnerSpec: '8c16g', runnerCount: 1, vus: 100, durationMs: 60_000 },
    takenAt: 0, pinned: false,
  });
  const metrics = { p95Ms: 200, errorRate: 0, samples: 5_000 };

  const ok = evaluatePerfGate(metrics, sample(mk()), undefined, mk());
  assert.notEqual(ok.unknownWhy, 'incomparable', `同环境两次必须可比：${ok.reasons.join('；')}`);
  assert.ok(ok.verdict === 'fail' || ok.verdict === 'warn', `200ms vs 基线 100ms 该判退化，实际 ${ok.verdict}`);

  /*
   * **反向**：环境不同必须挡住。少了这一半，上面那条是空的 ——
   * 一个把 envDiffForPerf 结果整个丢掉的实现也能通过它。
   * 用 environmentRef 造差异：那才是 envDiffForPerf 真的在比的一维
   * （我先拿 envRevision 造，测出来根本没触发 —— 它不在比较范围内，
   * 因为"固定环境修订"影响的是取哪个环境的数据，不是性能形态）。
   */
  const diff = evaluatePerfGate(metrics, sample(mk()), undefined, mk({ environmentRef: 'prod' }));
  assert.equal(diff.unknownWhy, 'incomparable', '环境不同时应判不可比，而不是硬给一个退化结论');
  assert.match(diff.reasons.join(''), /环境/);
});
