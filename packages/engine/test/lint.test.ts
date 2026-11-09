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
import { CONTAINER_KINDS } from '@atest/ir';
import { b, scen, getStep, tapStep, run, res, type StepDraft } from './helpers.js';

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

describe('PARALLEL_VAR_RACE（lint 与运行时闸必须同一个结论）', () => {
  /*
   * 这条规则的存在理由不是"多一条检查"，而是**把引擎那道运行时闸提前到写的时候**：
   * 判据直接调 ir 的 parallelHazards()，与解释器 `case 'parallel'` 用的是同一份。
   * 所以本文件的判据落在**两者是否始终一致**上，而不只是"lint 会不会报"——
   * 一条说"没问题"而引擎照样拒的 lint，比没有 lint 更坏（先信它、再白跑一遍，
   * 而 parallel 之前的 POST 已经发出去了）。
   *
   * 因此下面既有"该响的响 / 不该响的不响"（每条 lint 规则的常规判据），
   * 也有一条把**同一批 IR 同时喂给 lintScenario 与 runScenario** 的对照测试
   * —— 那条才是"不许各写一份判据"的守卫：谁把 lint 侧改成自己算，它就红。
   */
  const par = (id: string, steps: StepDraft[], over: object = {}): StepDraft =>
    ({ ...b(id), kind: 'parallel', failFast: true, maxConcurrency: 2, steps, ...over }) as StepDraft;
  const setStep = (id: string, name: string, v: number): StepDraft => ({ ...b(id), kind: 'set', assign: { [name]: v } });
  const race = (body: readonly unknown[], extra: object = {}): ReturnType<typeof lintScenario> =>
    lintScenario(scen(body as never[], extra as never)).filter((i) => i.code === 'PARALLEL_VAR_RACE');

  test('两支写同一个变量 -> error 级命中，且指到 parallel 容器而不是某一支', () => {
    const i = race([par('p', [setStep('k0', 'shared', 1), setStep('k1', 'shared', 2)])])[0];
    assert.ok(i, '两支撞名必须报');
    assert.equal(i!.level, 'error', '必须是 error：warning 的话 `atest lint` 通过、CI 照跑，到那一步才吃运行时错误');
    assert.equal(i!.stepId, 'p', '要指到并行容器 —— 撞名是分支之间的事，指到某一支会让人去改那一步的变量名而漏掉另一支');
    // fix 要**能照做**。只 assert 非空等于给实现留了"随便写点什么"的活路 ——
    // 邻居规则也都是 match 内容（SLEEP_USED 匹配 wait、HARDCODED_SECRET 匹配 secret:）
    assert.match(i!.fix ?? '', /不同的名字|拆成 sequence|独立场景/, 'fix 必须给出具体动作，否则读者的下一步是关规则');
    assert.ok(i!.doc);
  });
  test('报错要说清撞的是哪个名字、哪几支（只说"有竞态"等于让人自己找）', () => {
    const i = race([par('p', [setStep('k0', 'total', 1), setStep('k1', 'total', 2)])])[0];
    assert.match(i!.message, /total/);
    assert.match(i!.message, /k0.*k1|k1.*k0/);
  });
  test('三支写同一个名字也报（判据不是"恰好两支"）', () => {
    const found = race([par('p', [setStep('k0', 'w', 1), setStep('k1', 'w', 2), setStep('k2', 'w', 3)])]);
    assert.equal(found.length, 1, `一个撞名报一条，实际 ${found.length} 条`);
    assert.match(found[0]!.message, /k0.*k1.*k2/);
  });
  test('各支写各自不同的名字 -> 不报（没有这条对照组，"把所有 parallel 都拒掉"的实现也全绿）', () => {
    assert.deepEqual(race([par('p', [setStep('k0', 'fromA', 1), setStep('k1', 'fromB', 2)])]).length, 0);
  });
  test('只有一支 -> 不报（没有"另一个分支"可串）', () => {
    assert.equal(race([par('p', [setStep('k0', 'solo', 1)])]).length, 0);
  });
  test('两支各带 forEach、循环项名字不同 -> 不报（没有这条对照组，"把所有带循环的 parallel 都拒掉"的实现也全绿）', () => {
    // 名字**不同**而不是相同：同名那一例的正确答案随"分支之间怎么隔离作用域"而变
    // （共享一条帧栈时要报 frame-shadow，每支一份局部帧时不报），
    // 而"闸不许误报到把功能废掉"这条判据不该跟着它一起翻 —— 用不同名，
    // 两种作用域模型下答案都是"放行"，这条对照组才稳。
    const c = race([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      par('p', [
        { ...b('k0'), kind: 'forEach', items: 'list', as: 'rowA', steps: [{ ...b('n0'), kind: 'noop' }] },
        { ...b('k1'), kind: 'forEach', items: 'list', as: 'rowB', steps: [{ ...b('n1'), kind: 'noop' }] },
      ]),
    ]);
    assert.equal(c.length, 0, '误报的代价是把 parallel 废掉 —— 分支里带循环是并发最主要的用法');
  });
  test('分支里嵌套的写也算（判据要 walk 到底，只看直接子步骤等于闸形同虚设）', () => {
    const found = race([par('p', [
      { ...b('k0'), kind: 'sequence', steps: [{ ...b('k0a'), kind: 'set', assign: { deep: 1 } }] },
      { ...b('k1'), kind: 'sequence', steps: [{ ...b('k1a'), kind: 'set', assign: { deep: 2 } }] },
    ])]);
    assert.equal(found.length, 1, '嵌套里的同名写漏了就不报');
  });
  test('setup / teardown 里的 parallel 一样要查（解释器对这三段都真跑分支）', () => {
    const body: StepDraft[] = [{ ...b('body'), kind: 'noop' }];
    const racing = [par('p', [setStep('k0', 'shared', 1), setStep('k1', 'shared', 2)])];
    assert.equal(race(body, { setup: racing }).length, 1, 'setup 里的撞名漏了');
    assert.equal(race(body, { teardown: racing }).length, 1, 'teardown 里的撞名漏了');
  });
  test('failFast=false 照样报（那个开关换不掉竞态，只是换一种不可复现的方式）', () => {
    assert.equal(race([par('p', [setStep('k0', 'shared', 1), setStep('k1', 'shared', 2)], { failFast: false })]).length, 1);
  });

  /*
   * **本文件最要紧的一条**：同一批 IR 形状同时喂给 lint 与引擎，两边的结论必须逐个相同。
   *
   * 为什么要有它，而不是只测 lint 自己：这条规则的全部价值是"与引擎不许 disagree"，
   * 而"lint 有没有调用引擎那份判据"这件事，只看 lint 侧的实现是测不出来的 ——
   * 有人在 lint 里另抄一份判据，两边今天都对、测试全绿，然后各自漂移，
   * 最后的表现正是本条要防的"lint 放行、运行时拒"。把两边的输出直接对齐，
   * 抄一份（哪怕抄得一模一样）也会在任何一个形状上被照出来。
   *
   * 形状是**两边各自的对照组**：前三条引擎放行、后四条引擎拒。
   */
  const shapes: [string, () => ReturnType<typeof scen>][] = [
    ['两支各写不同名字', () => scen([par('p', [setStep('k0', 'a', 1), setStep('k1', 'b', 2)])])],
    ['单支', () => scen([par('p', [setStep('k0', 'a', 1)])])],
    ['两支各带 forEach 且循环项同名', () => scen([
      { ...b('seed'), kind: 'set', assign: { list: [1, 2] } },
      par('p', [
        { ...b('k0'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n0'), kind: 'noop' }] },
        { ...b('k1'), kind: 'forEach', items: 'list', as: 'item', steps: [{ ...b('n1'), kind: 'noop' }] },
      ]),
    ])],
    ['两支写同一个名字', () => scen([par('p', [setStep('k0', 'shared', 1), setStep('k1', 'shared', 2)])])],
    ['嵌套 sequence 里写同名', () => scen([par('p', [
      { ...b('k0'), kind: 'sequence', steps: [{ ...b('k0a'), kind: 'set', assign: { deep: 1 } }] },
      { ...b('k1'), kind: 'sequence', steps: [{ ...b('k1a'), kind: 'set', assign: { deep: 2 } }] },
    ])])],
    ['三支写同一个名字', () => scen([par('p', [setStep('k0', 'w', 1), setStep('k1', 'w', 2), setStep('k2', 'w', 3)], { maxConcurrency: 3 })])],
    ['failFast=false 两支同名', () => scen([par('p', [setStep('k0', 'shared', 1), setStep('k1', 'shared', 2)], { failFast: false })])],
  ];
  test('与解释器逐个形状对照：lint 报 <=> 引擎拒（判据必须是同一份）', async () => {
    for (const [label, mk] of shapes) {
      // 一份 IR 只造一次：造两次的话 lint 与引擎读的是两个对象，
      // "同一份 IR 两边结论相同"这件事就没在测同一份东西了
      const s = mk();
      const flagged = race(s.body).length > 0;
      const r = await run(s);
      const refused = res(r, 'p').status === 'error';
      assert.equal(flagged, refused, `${label}：lint=${flagged ? '报' : '放行'} 而引擎=${refused ? '拒' : '放行'}，两边判据分叉了`);
    }
  });

  test('撞名场景在 CLI 眼里必须是不通过（error 而不是 warning 的实际后果）', () => {
    const rep = toReport(lintScenario(scen([par('p', [setStep('k0', 'shared', 1), setStep('k1', 'shared', 2)])] as never[])));
    assert.equal(rep.ok, false, 'warning 的话 `atest lint` 退出码是 0，CI 会照样把场景跑到那一步');
    assert.ok(rep.errors.some((e) => e.code === 'PARALLEL_VAR_RACE'));
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
    const KNOWN = new Set(['ASSERT_FREE_STEP','ASSERT_FREE_SCENARIO','SLEEP_USED','LOOP_UNBOUNDED','VAR_UNDEFINED','DEPENDENCY_CYCLE','LITERAL_OVERFIT','HARDCODED_SECRET','RESOURCE_LEASE_MISSING','TEARDOWN_DIRTY','CROSS_TARGET_MISSING_WAIT','STEP_BUDGET_EXCEEDED','EXPR_SYNTAX','DUPLICATE_STEP_ID','CLEARDATA_VS_PRESERVE_SESSION','PIXEL_ASSERT_ON_NONHIERARCHY','NEGATIVE_ASSERT_VISION_BASED','TEMPLATE_NOT_UNIQUE','TEMPLATE_NO_ROI','LLM_ASSERT_RATIO_HIGH','VISION_STEP_IN_CI_GATE','DEPRECATED_OPERATION','SELF_REFERENCING_CALL','INPUT_UNUSED','PARALLEL_VAR_RACE']);
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

describe('RETRY_ON_CONTAINER（容器上的 retry 现在什么都不做，所以要响）', () => {
  /*
   * 这条规则是本轮**改动的副产品**，而它存在的理由正是本仓反复写的那句话：
   * 静默失效的配置比报错的配置坏得多。
   *
   * 改动前容器 retry 是"能做"的，但做法是"子步骤报 error => 容器报 error =>
   * status5xx 那条 alias 命中 => 整个块重跑"，于是 parallel 分支里的 POST
   * 会被再发一次，而"POST 永不自动重试"（docs/05 §4）那条边界是按步骤看的，
   * 看不见"POST 在某个块里"。改动后重试要求"这一行带传输种类"，
   * 容器那一行永远不带 —— 于是容器 retry **静默变成空操作**。
   * 不修成"能重试"是故意的（重跑块会重发 POST、上一轮的子步骤行撤不掉），
   * 但**放着不响**就等于把一个会做危险事的配置换成一个骗人的配置。
   */
  const hit = (body: readonly unknown[], extra: object = {}) =>
    lintScenario(scen(body as never[], extra as never)).filter((i) => i.code === 'RETRY_ON_CONTAINER');
  const withRetry = (step: StepDraft): StepDraft => ({ ...step, retry: { count: 2 } } as StepDraft);

  /** 每种容器一个**能过 schema** 的最小形状（容器都要求至少 1 个子步骤，空的不合法） */
  const child: StepDraft = { ...b('n'), kind: 'noop' };
  const CONTAINERS: ReadonlyArray<[string, StepDraft]> = [
    ['sequence', { ...b('c'), kind: 'sequence', steps: [child] }],
    ['if', { ...b('c'), kind: 'if', condition: '$x', then: [child], else: [] }],
    ['switch', { ...b('c'), kind: 'switch', value: '$x', cases: [{ is: { expr: 'true' }, steps: [child] }], default: [] }],
    ['forEach', { ...b('c'), kind: 'forEach', items: '[1]', as: 'i', maxIterations: 2, steps: [child] }],
    ['while', { ...b('c'), kind: 'while', condition: 'false', maxIterations: 2, steps: [child] }],
    ['repeat', { ...b('c'), kind: 'repeat', times: 1, steps: [child] }],
    ['parallel', { ...b('c'), kind: 'parallel', failFast: true, maxConcurrency: 1, steps: [child] }],
  ] as const;

  for (const [kind, step] of CONTAINERS) {
    test(`${kind} 上写 retry.count>0 -> error`, () => {
      const i = hit([{ ...step, retry: { count: 1 } }])[0];
      assert.ok(i, `${kind} 带 retry 必须报 —— 它是"用户以为配了容错，其实一次都不会重试"`);
      assert.equal(i!.level, 'error', 'warning 会被 `atest lint` 放过、CI 照跑，而这份配置永远不会生效');
      assert.equal(i!.stepId, 'c', '要指到写 retry 的那个容器');
      assert.match(i!.message, /不再生效|不会生效|已.*失效/, '要说清"写了不等于生效"，只说"不支持"会让人以为是老版本问题');
      assert.match(i!.fix ?? '', /幂等|GET/, 'fix 必须给出**能照做**的替代：把 retry 挪到块内那条幂等请求上');
      assert.ok(i!.doc);
    });
  }

  test('七种容器都被覆盖（新增容器 kind 时这条会提醒补上面那张表）', () => {
    assert.deepEqual(CONTAINERS.map(([k]) => k).sort(), [...CONTAINER_KINDS].sort(),
      'CONTAINER_KINDS 加了一种而这里没加 => 那种容器的 retry 静默失效而无人报');
  });

  test('普通步骤上的 retry 不许被这条规则误伤', () => {
    // 这条是**反向**守卫：判据必须是"容器"，否则本轮刚修好的步骤级重试
    // 会被自己的 lint 拦在门外，症状是"照文档配了重试，lint 说不许配"。
    const i = hit([withRetry(getStep('h'))]);
    assert.deepEqual(i, [], 'http 步骤上的 retry 是**唯一有效**的写法，报它就是报正确答案');
  });

  test('retry.count=0（默认值）不报：没写就等于没配', () => {
    assert.deepEqual(hit([{ ...b('c'), kind: 'sequence', steps: [] }]), []);
  });

  test('setup / teardown 里的容器同样查（与 PARALLEL_VAR_RACE 同一条理由）', () => {
    const s = scen([{ ...b('h'), kind: 'noop' }] as never[], {
      setup: [{ ...b('s1'), kind: 'sequence', steps: [], retry: { count: 1 } }] as never[],
    } as never);
    assert.ok(lintScenario(s).some((i) => i.code === 'RETRY_ON_CONTAINER' && i.stepId === 's1'),
      '只查 body 的话"前置里配了个不会生效的重试"照样静默');
  });
});
