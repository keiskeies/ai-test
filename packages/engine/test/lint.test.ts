/**
 * 静态闸（M3）。判据：**每条 lint 规则各命中一次**。
 *
 * 这条判据不是覆盖率洁癖。lint 是本平台对抗「AI 生成的用例看着像真的」的唯一硬闸：
 * 一条从没被任何用例触发过的规则，等于一条写错了也没人知道的规则。
 * 每条规则还各自断言**不该命中的近邻**不误报 —— 误报的代价是把 lint 关掉，
 * 那时全部规则一起失效。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintScenario, toReport, type LintCode, type LintContext } from '../src/index.js';
import { b, scen, getStep, tapStep, type StepDraft } from './helpers.js';

const codes = (body: StepDraft[], ctx: LintContext = {}, extra: object = {}): LintCode[] =>
  lintScenario(scen(body as never[], extra as never), ctx).map((i) => i.code);
const find = (body: StepDraft[], code: LintCode, ctx: LintContext = {}, extra: object = {}) =>
  lintScenario(scen(body as never[], extra as never), ctx).find((i) => i.code === code);

describe('断言存在性（竞品都没做的那两条）', () => {
  test('ASSERT_FREE_STEP：请求既没断言也没人消费 = 永远绿的 no-op', () => {
    const i = find([getStep('h')], 'ASSERT_FREE_STEP');
    assert.ok(i);
    assert.equal(i!.level, 'error');
    assert.equal(i!.stepId, 'h');
  });
  test('…但被下游 extract 消费就不报（消费也是一种校验）', () => {
    const c = codes([
      getStep('h'),
      { ...b('x'), kind: 'extract', from: '$.step.h.resp', rules: [{ var: 'id', path: '$.id' }] },
    ]);
    assert.ok(!c.includes('ASSERT_FREE_STEP'));
  });
  test('ASSERT_FREE_SCENARIO：整场景零断言', () => assert.ok(codes([{ ...b('n'), kind: 'noop' }]).includes('ASSERT_FREE_SCENARIO')));
  test('…有一条断言就不报', () => {
    const c = codes([getStep('h'), { ...b('a'), kind: 'assert', against: '$.step.h.resp', jsonPath: { '$.id': { notNull: true } } }]);
    assert.ok(!c.includes('ASSERT_FREE_SCENARIO'));
  });
});

describe('时间：等待必须是条件', () => {
  test('SLEEP_USED', () => {
    const i = find([{ ...b('s'), kind: 'sleep', ms: 5 }], 'SLEEP_USED');
    assert.ok(i);
    assert.match(i!.fix ?? '', /wait/);
  });
  test('LOOP_UNBOUNDED：上限大得离谱的 while', () =>
    assert.ok(codes([{ ...b('w'), kind: 'while', condition: 'true', maxIterations: 9999, steps: [{ ...b('n'), kind: 'noop' }] }]).includes('LOOP_UNBOUNDED')));
  test('…合理上限不误报', () => {
    const c = codes([{ ...b('w'), kind: 'while', condition: 'true', maxIterations: 20, steps: [{ ...b('n'), kind: 'noop' }] }]);
    assert.ok(!c.includes('LOOP_UNBOUNDED'));
  });
});

describe('变量与引用', () => {
  test('VAR_UNDEFINED：引用没声明过的变量', () => {
    const i = find([{ ...b('a'), kind: 'set', assign: { z: { path: '$.nothere' } } }], 'VAR_UNDEFINED');
    assert.ok(i);
    assert.ok(i!.fix);
  });
  test('VAR_UNDEFINED：引用不存在的步骤', () =>
    assert.ok(codes([{ ...b('b'), kind: 'assert', against: '$.step.ghost.resp', jsonPath: { '$.x': { notNull: true } } }]).includes('VAR_UNDEFINED')));
  test('VAR_UNDEFINED：引用后面才执行的步骤（前向引用）', () => {
    const i = find([
      { ...b('early'), kind: 'assert', against: '$.step.later.resp', jsonPath: { '$.x': { notNull: true } } },
      getStep('later'),
      { ...b('ok'), kind: 'assert', against: '$.step.later.resp', jsonPath: { '$.x': { notNull: true } } },
    ], 'VAR_UNDEFINED');
    assert.ok(i);
    assert.equal(i!.stepId, 'early', '报错要指到出错那一步，而不是被引用的那一步');
  });
  test('…inputs 里声明过的不算未定义', () => {
    const c = codes([{ ...b('a'), kind: 'assert', against: '$sku' }], {}, { inputs: [{ name: 'sku', type: 'string', required: true }] });
    assert.ok(!c.includes('VAR_UNDEFINED'));
  });
  test('…run/env/secret 保留前缀不算未定义', () => {
    const c = codes([
      { ...b('a1'), kind: 'assert', against: '$.run.inputs.sku' },
      { ...b('a2'), kind: 'assert', against: '$.env.baseUrl' },
      { ...b('a3'), kind: 'assert', against: '$.secret.db_pwd' },
    ]);
    assert.ok(!c.includes('VAR_UNDEFINED'), JSON.stringify(codes([{ ...b('a1'), kind: 'assert', against: '$.run.inputs.sku' }])));
  });
  test('EXPR_SYNTAX：condition 写坏', () => {
    const i = find([{ ...b('i'), kind: 'if', condition: '1 +', then: [{ ...b('n'), kind: 'noop' }], else: [] }], 'EXPR_SYNTAX');
    assert.ok(i);
    assert.equal(i!.stepId, 'i');
  });
  test('EXPR_SYNTAX：函数名拼错也要在生成期报出来', () =>
    assert.ok(codes([{ ...b('i'), kind: 'if', condition: 'lenght($a) > 1', then: [{ ...b('n'), kind: 'noop' }], else: [] }]).includes('EXPR_SYNTAX')));
  test('DUPLICATE_STEP_ID', () => assert.ok(codes([{ ...b('dup'), kind: 'noop' }, { ...b('dup'), kind: 'noop' }]).includes('DUPLICATE_STEP_ID')));
  test('INPUT_UNUSED：声明了却不用的输入', () =>
    assert.ok(codes([{ ...b('n'), kind: 'noop' }], {}, { inputs: [{ name: 'unusedParam', type: 'string', required: false }] }).includes('INPUT_UNUSED')));
  test('…被用到的输入不误报', () => {
    const c = codes([{ ...b('a'), kind: 'assert', against: '$sku' }], {}, { inputs: [{ name: 'sku', type: 'string', required: true }] });
    assert.ok(!c.includes('INPUT_UNUSED'));
  });
});

describe('断言质量', () => {
  test('LITERAL_OVERFIT：对易变字段写 exact', () => {
    const i = find([
      { ...b('mk'), kind: 'set', assign: { resp: { body: { createdAt: '2026-01-02T03:04:05Z' } } } },
      { ...b('a'), kind: 'assert', against: '$.step.mk.resp', jsonPath: { '$.createdAt': { exact: '2026-01-02T03:04:05Z' } } },
    ], 'LITERAL_OVERFIT');
    assert.ok(i, '对时间字段写 exact，三天后必炸');
    assert.equal(i!.stepId, 'a');
  });
  test('…稳定业务字段不误报（误报会让人关 lint）', () => {
    const c = codes([
      { ...b('mk'), kind: 'set', assign: { resp: { body: { status: 'PAID' } } } },
      { ...b('a'), kind: 'assert', against: '$.step.mk.resp', jsonPath: { '$.status': { exact: 'PAID' } } },
    ]);
    assert.ok(!c.includes('LITERAL_OVERFIT'));
  });
  test('…同一字段用 shape/matches 就不报（这正是推荐的修法）', () => {
    const c = codes([
      { ...b('mk'), kind: 'set', assign: { resp: { body: { createdAt: '2026-01-02T03:04:05Z' } } } },
      { ...b('a'), kind: 'assert', against: '$.step.mk.resp', jsonPath: { '$.createdAt': { shape: 'datetime' } } },
    ]);
    assert.ok(!c.includes('LITERAL_OVERFIT'));
  });
  test('LLM_ASSERT_RATIO_HIGH：满屏语义断言等于没有断言', () =>
    assert.ok(codes([
      { ...b('p'), kind: 'set', assign: { a: 'x' } },
      { ...b('j1'), kind: 'assertLlm', question: 'aaaa', evidenceFrom: '$a' },
      { ...b('j2'), kind: 'assertLlm', question: 'bbbb', evidenceFrom: '$a' },
    ]).includes('LLM_ASSERT_RATIO_HIGH')));
});

describe('安全', () => {
  test('HARDCODED_SECRET：明文口令', () => {
    const i = find([{ ...b('mk'), kind: 'set', assign: { cfg: { password: 'super-secret-1' } } }], 'HARDCODED_SECRET');
    assert.ok(i);
    assert.match(i!.fix ?? '', /secret:/);
    assert.ok(i!.stepId, '必须指到具体步骤，否则 200 步的场景里没人能找到那行');
  });
  test('…JWT 也被抓', () =>
    assert.ok(codes([{ ...b('mk'), kind: 'set', assign: { h: { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.abc' } } }]).includes('HARDCODED_SECRET')));
  test('…写成 secret: 引用就放行（这是唯一的正解）', () => {
    const c = codes([
      { ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x' }, auth: 'secret:api_token' },
      { ...b('a'), kind: 'assert', against: '$.step.h.resp', jsonPath: { '$.ok': { notNull: true } } },
    ]);
    assert.ok(!c.includes('HARDCODED_SECRET'));
  });
});

describe('资源与环境', () => {
  test('RESOURCE_LEASE_MISSING：没租设备就点屏幕', () => {
    const i = find([tapStep('t'), { ...b('a'), kind: 'assert', against: '$.run' }], 'RESOURCE_LEASE_MISSING');
    assert.ok(i);
    assert.match(i!.fix ?? '', /device/);
  });
  test('…先申请租约就不报', () => {
    const c = codes([
      { ...b('d'), kind: 'device', target: 'android' },
      tapStep('t'),
      { ...b('a'), kind: 'assert', against: '$.run' },
    ]);
    assert.ok(!c.includes('RESOURCE_LEASE_MISSING'));
  });
  test('TEARDOWN_DIRTY：有写操作却没有清理', () =>
    assert.ok(codes([
      { ...b('w'), kind: 'http', request: { method: 'POST', url: 'http://x/o', body: { a: 1 } } },
      { ...b('a'), kind: 'assert', against: '$.step.w.resp', jsonPath: { '$.id': { notNull: true } } },
    ]).includes('TEARDOWN_DIRTY')));
  test('CROSS_TARGET_MISSING_WAIT：API 写完直接读界面', () =>
    assert.ok(codes([
      { ...b('api'), kind: 'http', request: { method: 'POST', url: 'http://x/o', body: { a: 1 } } },
      { ...b('ui'), kind: 'assertUi', assertKind: 'text', contains: 'ORD-1' },
      { ...b('a'), kind: 'assert', against: '$.step.api.resp', jsonPath: { '$.id': { notNull: true } } },
    ]).includes('CROSS_TARGET_MISSING_WAIT')));
  test('CLEARDATA_VS_PRESERVE_SESSION：清数据与保留会话互斥', () =>
    assert.ok(codes([
      { ...b('cl'), kind: 'app', action: 'clearData' },
      { ...b('id'), kind: 'useIdentity', identity: 'u1', preserveSession: true },
      { ...b('a'), kind: 'assert', against: '$.run' },
    ]).includes('CLEARDATA_VS_PRESERVE_SESSION')));
  test('STEP_BUDGET_EXCEEDED：场景预算超项目上限', () =>
    assert.ok(codes([{ ...b('n'), kind: 'noop' }], { maxCostUsd: 2 },
      { config: { timeoutMs: 60000, maxCostUsd: 99, retries: { count: 0, backoff: 'fixed', baseMs: 0, maxMs: 1000, retryOn: ['network'] }, concurrencySafe: true, dirty: false } }
    ).includes('STEP_BUDGET_EXCEEDED')));
});

describe('像素世界（docs/10 §5）', () => {
  const tapAt = (id: string, compiled: Record<string, unknown>, replayable = true): StepDraft => ({
    ...b(id), kind: 'tap',
    target: { intent: '金币图标', confidenceGate: 0.85, maxCostUsdPerResolve: 0.02, replayable, compiledTo: compiled },
  });
  const tpl = { kind: 'template', imageRef: 'art://tpl/x', confidence: 0.8, scaleRange: [0.9, 1.1], occurrences: 3, theme: 'default', recordedAt: '2026-01-01T00:00:00Z' };

  test('TEMPLATE_NOT_UNIQUE：满屏同款图标必须给 roi/nearText', () =>
    assert.ok(codes([tapAt('t', tpl), { ...b('a'), kind: 'assert', against: '$.run' }]).includes('TEMPLATE_NOT_UNIQUE')));
  test('TEMPLATE_NO_ROI：整屏匹配在长列表上必然错位', () =>
    assert.ok(codes([tapAt('t', tpl), { ...b('a'), kind: 'assert', against: '$.run' }]).includes('TEMPLATE_NO_ROI')));
  test('…occurrences=1 且带 roi 就不报', () => {
    const unique = { ...tpl, occurrences: 1, roi: [0.1, 0.2, 0.3, 0.1] };
    const c = codes([tapAt('t', unique), { ...b('a'), kind: 'assert', against: '$.run' }]);
    assert.ok(!c.includes('TEMPLATE_NOT_UNIQUE'), JSON.stringify(c));
    assert.ok(!c.includes('TEMPLATE_NO_ROI'));
  });
  test('VISION_STEP_IN_CI_GATE：不可回放步骤不得进冻结场景', () =>
    assert.ok(codes(
      [tapAt('t', { kind: 'vision', strategy: 'pure-coordinate', nonReplayable: true }, false), { ...b('a'), kind: 'assert', against: '$.run' }],
      {}, { frozen: true },
    ).includes('VISION_STEP_IN_CI_GATE')));
  test('PIXEL_ASSERT_ON_NONHIERARCHY：对像素目标写层级谓词是类型错误', () =>
    assert.ok(codes(
      [{ ...b('a1'), kind: 'assertUi', assertKind: 'visible' }],
      { snapshotKinds: { 'screen.main': 'pixels' }, stepSnapshotKind: { a1: 'pixels' } },
    ).includes('PIXEL_ASSERT_ON_NONHIERARCHY')));
  test('NEGATIVE_ASSERT_VISION_BASED：视觉模型倾向过度报告「存在」', () =>
    assert.ok(codes(
      [{ ...b('a2'), kind: 'assertUi', assertKind: 'absent' }],
      { stepSnapshotKind: { a2: 'pixels' } },
    ).includes('NEGATIVE_ASSERT_VISION_BASED')));
});

describe('依赖关系', () => {
  test('SELF_REFERENCING_CALL：场景调用自己', () =>
    assert.ok(codes([{ ...b('c'), kind: 'call', scenarioRef: 'scn.test', args: {} }]).includes('SELF_REFERENCING_CALL')));
  test('DEPENDENCY_CYCLE：跨场景成环', () => {
    const body: StepDraft[] = [{ ...b('c'), kind: 'call', scenarioRef: 'other', args: {} }];
    assert.ok(lintScenario(scen(body as never), { scenarioGraph: { 'scn.test': ['other'], other: ['scn.test'] } }).some((i) => i.code === 'DEPENDENCY_CYCLE'));
  });
  test('…无环时不报', () => {
    const body: StepDraft[] = [{ ...b('c'), kind: 'call', scenarioRef: 'other', args: {} }];
    assert.ok(!lintScenario(scen(body as never), { scenarioGraph: { 'scn.test': ['other'], other: [] } }).some((i) => i.code === 'DEPENDENCY_CYCLE'));
  });
});

describe('报错质量（这条比规则数量更重要）', () => {
  // 故意写坏一份 IR，把尽量多的规则一次触发。
  // 注意**不能**在 describe 体里直接 lint：describe 体在文件加载时就执行，
  // 一份解析不过的 IR 会让整个文件加载失败（连带同文件其余用例全不跑）。
  const dirty = (): ReturnType<typeof lintScenario> => lintScenario(scen([
    getStep('h'),
    { ...b('s'), kind: 'sleep', ms: 5 },
    { ...b('w'), kind: 'while', condition: 'true', maxIterations: 9000, steps: [{ ...b('n'), kind: 'noop' }] },
    { ...b('i'), kind: 'if', condition: '1 +', then: [{ ...b('m'), kind: 'noop' }], else: [] },
    { ...b('mk'), kind: 'set', assign: { cfg: { password: 'hunter2-hunter2' } } },
  ] as never[]));

  test('每条 error 都必须给「可直接照做的修法」和设计文档出处', () => {
    const issues = dirty();
    assert.ok(issues.length > 0, '这份 IR 本该触发多条规则');
    for (const i of issues) {
      assert.ok(i.message.length > 8, `${i.code} 的 message 太随意：${i.message}`);
      assert.ok(i.fix, `${i.code} 缺 fix —— 没有修法的报错只会让人猜`);
      assert.ok(i.doc, `${i.code} 缺 doc —— 设计意图要能查到`);
    }
  });
  test('规则码必须是已登记的枚举（防止拼错的码静默失效）', () => {
    const issues = dirty();
    const KNOWN = new Set(['ASSERT_FREE_STEP','ASSERT_FREE_SCENARIO','SLEEP_USED','LOOP_UNBOUNDED','VAR_UNDEFINED','DEPENDENCY_CYCLE','LITERAL_OVERFIT','HARDCODED_SECRET','RESOURCE_LEASE_MISSING','TEARDOWN_DIRTY','CROSS_TARGET_MISSING_WAIT','STEP_BUDGET_EXCEEDED','EXPR_SYNTAX','DUPLICATE_STEP_ID','CLEARDATA_VS_PRESERVE_SESSION','PIXEL_ASSERT_ON_NONHIERARCHY','NEGATIVE_ASSERT_VISION_BASED','TEMPLATE_NOT_UNIQUE','TEMPLATE_NO_ROI','LLM_ASSERT_RATIO_HIGH','VISION_STEP_IN_CI_GATE','DEPRECATED_OPERATION','SELF_REFERENCING_CALL','INPUT_UNUSED']);
    for (const i of issues) assert.ok(KNOWN.has(i.code), `未登记的 LintCode: ${i.code}`);
  });
  test('toReport 只在有 error 时判不通过（warning 不拦人）', () => {
    const warnOnly = toReport(lintScenario(scen([{ ...b('s'), kind: 'sleep', ms: 5 }, { ...b('a'), kind: 'assert', against: '$.run' }] as StepDraft[] as never[])));
    const errs = toReport(dirty());
    assert.equal(errs.ok, false);
    assert.ok(errs.summary.includes('错误'));
    assert.ok(warnOnly.errors.length <= errs.errors.length);
  });
});

describe('干净场景必须零 error（误报会让整套 lint 被关掉）', () => {
  test('一条写得正确的 API 场景', () => {
    const s = scen([
      getStep('get', 'http://x/api/list'),
      { ...b('a'), kind: 'assert', against: '$.step.get.resp', status: 200, jsonPath: { '$.data.list': { isArray: true } } },
    ] as never[], { teardown: [{ ...b('td'), kind: 'noop' }] } as never);
    const rep = toReport(lintScenario(s));
    assert.deepEqual(rep.errors.map((e) => `${e.code}@${e.stepId ?? '-'}`), [], rep.summary);
    assert.equal(rep.ok, true);
  });
});
