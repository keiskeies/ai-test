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

import { lintScenario, toReport, LINT_DOCS, isNearMiss, graphGapSummary, type LintCode, type LintContext, type ScenarioGraph, type ScenarioGraphGap } from '../src/index.js';
import * as irSchema from '@atest/ir';
import { ZodType } from 'zod';
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
  test('…`$.sku` 这种点号写法也算被用到（改前误报）', () => {
    /*
     * 旧判据里有 `stepsText.includes('$' + name)`，而 `"$.sku"` 中**没有** `$sku`
     * 这个子串（中间隔着点）。于是"步骤里只用 `$.sku` 引用输入"这种最常见的写法
     * 每轮都收到一句"声明了但没有任何步骤使用"，让人去删一个真在用的输入。
     * 运行期是认的：`resolveRef('$.sku')` 落到 `lookup` → 帧 → inputs → env。
     * （这一条是本轮量出来的**改前就在**的误报 —— 它本来不会被注意到，
     *   是 default 之间互相引用也写成 `$.base` 之后才撞出来的。）
     */
    const c = codes([{ ...b('a'), kind: 'set', assign: { v: '$.sku' } }], {}, { inputs: [{ name: 'sku', type: 'string', required: true }] });
    assert.ok(!c.includes('INPUT_UNUSED'), JSON.stringify(c));
  });
  test('…被另一条 default 引用也算被用到', () => {
    /* `default` 现在会被求值，所以 `{name:'b'}` 只被 `a` 的 default 引用是**合法用法**。
     * 只搜三段步骤的话这里会误报，而照那句提示去删就会把 a 的 default 弄坏。
     * 步骤里引用的是 a（不是 b）—— 否则 a 自己也"声明了没用"，那条真该报的会混进来，
     * 这条测试就分不清报的是哪一个了。 */
    const c = codes([{ ...b('a'), kind: 'set', assign: { v: '$.a' } }], {}, {
      inputs: [{ name: 'b', type: 'string' }, { name: 'a', type: 'string', default: { path: '$.b' } }],
    });
    assert.ok(!c.includes('INPUT_UNUSED'), JSON.stringify(c));
  });
  test('…输入自己的声明不算被自己用到（那个恒真 bug 不许回来）', () => {
    /*
     * 反向的牙：把 inputs 的 default 放进被搜文本之后，
     * "搜整个 IR"那种写法会再次恒为真（声明里就带 name）。
     * 这里没有任何地方引用 unusedOne，必须报。
     */
    const c = codes([{ ...b('a'), kind: 'noop' }], {}, {
      inputs: [{ name: 'unusedOne', type: 'string', default: 'unusedOne' }],
    });
    assert.ok(c.includes('INPUT_UNUSED'), JSON.stringify(c));
  });
  test('DEPENDENCY_CYCLE：inputs 的 default 互引成环（静态侧，error）', () => {
    const i = find([{ ...b('a'), kind: 'noop' }], 'DEPENDENCY_CYCLE', {}, {
      inputs: [{ name: 'x', type: 'string', default: { path: '$y' } }, { name: 'y', type: 'string', default: { path: '$x' } }],
    });
    assert.ok(i, '互引成环没报');
    assert.equal(i!.level, 'error', '这种场景必然跑不起来，warning 等于让 CI 放过一份空报告');
    assert.match(i!.message, /x/);
    assert.match(i!.message, /y/, '只点名一个的话，人会去改那一条而另一条还是环');
    assert.equal(i!.stepId, undefined);
  });
  test('DEPENDENCY_CYCLE：不构成环的 default 引用不报', () => {
    const c = codes([{ ...b('a'), kind: 'noop' }], {}, {
      inputs: [{ name: 'x', type: 'string', default: { path: '$y' } }, { name: 'y', type: 'string', default: 'lit' }],
    });
    assert.ok(!c.includes('DEPENDENCY_CYCLE'), JSON.stringify(c));
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
    assert.ok(lintScenario(scen(body as never), { scenarioGraph: { edges: { 'scn.test': ['other'], other: ['scn.test'] } } }).some((i) => i.code === 'DEPENDENCY_CYCLE'));
  });
  test('…无环时不报', () => {
    const body: StepDraft[] = [{ ...b('c'), kind: 'call', scenarioRef: 'other', args: {} }];
    assert.ok(!lintScenario(scen(body as never), { scenarioGraph: { edges: { 'scn.test': ['other'], other: [] } } }).some((i) => i.code === 'DEPENDENCY_CYCLE'));
  });

  /*
   * 下面四条是本轮把这张图从 `Record<string, string[]>` 换成 `ScenarioGraph` 时加的，
   * 每条对应一次**实测**（不是推演）。前两条尤其要紧：它们防的不是"漏报环"，
   * 而是"**图给了、规则跑了、而它其实什么都没看见**"——那种失效比没接更坏，
   * 因为接的人会以为它在工作。
   */
  test('图按 **ref** 键（带 @version）时仍然成环：键的归一化在这一侧做', () => {
    /*
     * 本轮实测过的静默失效：`visit` 从 `scenario.id`（`scn.test`）起跳，
     * 而调用方给的是 `'scn.test@1'` 这种带版本的键时，**第一跳就查不到出边** ——
     * 于是环真在、图也给全了，规则一声不响。
     * 修法有两个方向（要求调用方必须切干净 / 这一侧自己归一化），选后者：
     * "调用方会不会切分"这件事没法在编译期保证，而这一侧一行代码就能保证。
     */
    const body: StepDraft[] = [{ ...b('c'), kind: 'call', scenarioRef: 'other@1', args: {} }];
    const g: ScenarioGraph = { edges: { 'scn.test@1': ['other@1'], 'other@1': ['scn.test@1'] } };
    const hit = lintScenario(scen(body as never), { scenarioGraph: g }).find((i) => i.code === 'DEPENDENCY_CYCLE');
    assert.ok(hit, '带 @version 的键必须被归一化后照样查出环');
    // 归一化不许漏进**给人看的那句话**：链条写 id，不写 ref
    assert.ok(!hit!.message.includes('@'), `成环链条不该带着没切分的 ref：${hit!.message}`);
  });

  test('自环只报 SELF_REFERENCING_CALL 一条，不双报', () => {
    /*
     * 改前实测：`scn.test` call `scn.test` 时 DEPENDENCY_CYCLE 与
     * SELF_REFERENCING_CALL **一起响**。同一条 IR 上的一个坏被报成两条，
     * 读的人会以为是两处要改（而修法是同一个）。
     * 留 SELF_REFERENCING 那条因为它更具体：带 stepId、说得出"无限递归"。
     */
    const got = codes([{ ...b('c'), kind: 'call', scenarioRef: 'scn.test@1', args: {} }], {
      scenarioGraph: { edges: { 'scn.test': ['scn.test'] } },
    });
    assert.equal(got.filter((c) => c === 'SELF_REFERENCING_CALL').length, 1);
    assert.ok(!got.includes('DEPENDENCY_CYCLE'), `自环不该再报第二条：${got.join(',')}`);
  });

  test('同一个环经两条路径撞上只报一条；**两个不同的环必须报两条**', () => {
    /*
     * 两个方向都要钉，因为它们坏的方向相反：
     *  - **不判重**：同一个环从两条路径各报一遍，读的人以为有两个问题；
     *  - **判得太狠**：两个真实的环合成一条，那就是**少报**（本仓那一族的正面形态）。
     *
     * 第一个 fixture：{a,b} 这一个环，可以走 m→a→b→a，也可以走 m→c→a→b→a。
     * 去重的键取"环上那些 id 排序后的串"，所以两条路径算出同一个键。
     * 第二个 fixture：{a,b} 与 {a,c} 是两个**节点集不同**的环，键必然不同 → 两条。
     */
    const one: ScenarioGraph = { edges: { 'scn.test': ['m'], m: ['a', 'c'], a: ['b'], b: ['a'], c: ['a'] } };
    const body: StepDraft[] = [{ ...b('c'), kind: 'call', scenarioRef: 'm', args: {} }];
    const gotOne = lintScenario(scen(body as never), { scenarioGraph: one }).filter((i) => i.code === 'DEPENDENCY_CYCLE');
    assert.equal(gotOne.length, 1, `同一个环报了 ${gotOne.length} 条：${gotOne.map((i) => i.message).join(' | ')}`);

    const two: ScenarioGraph = { edges: { 'scn.test': ['a'], a: ['b', 'c'], b: ['a'], c: ['a'] } };
    const gotTwo = lintScenario(scen(body as never), { scenarioGraph: two }).filter((i) => i.code === 'DEPENDENCY_CYCLE');
    assert.equal(gotTwo.length, 2, `两个不同的环只报了 ${gotTwo.length} 条（判重判过头 = 少报）：${gotTwo.map((i) => i.message).join(' | ')}`);
  });

  test('图不完整时报 CALL_GRAPH_INCOMPLETE，而不是安静地"没环"', () => {
    /*
     * 这一条是整张 `ScenarioGraph` 形状改造的**存在理由**。
     * 裸 Record 的接口下"没看全"与"确认无环"是同一个输出，于是报告上的
     * 「✓ 通过」会被读成"环检测跑过了"。这里钉的是**缺口的可见性**，
     * 所以断言分三面：报了、是 warning（不许拦执行）、话说清了缺从哪儿开始。
     */
    const body: StepDraft[] = [{ ...b('c'), kind: 'call', scenarioRef: 'ghost@1', args: {} }];
    const withGap = lintScenario(scen(body as never), { scenarioGraph: { edges: { 'scn.test': ['ghost'] }, gaps: [{ from: 'scn.test', ref: 'ghost@1' }] } });
    const gap = withGap.find((i) => i.code === 'CALL_GRAPH_INCOMPLETE');
    assert.ok(gap, '解析不到 ref 时必须说出来');
    assert.equal(gap!.level, 'warning', '是 warning 不是 error：解析不到有正当原因（部分 checkout / 子场景在别的仓），定成 error 会让人去关规则');
    assert.match(gap!.message, /判不出/, '要说清"这里往后的环判不出"，而不是只说"图不全"');
    // **正向对照**：完整的图不许有这条（否则上面那两句是恒真的）
    const clean = lintScenario(scen(body as never), { scenarioGraph: { edges: { 'scn.test': ['other'], other: [] } } });
    assert.ok(!clean.some((i) => i.code === 'CALL_GRAPH_INCOMPLETE'), '图完整时不该报缺口');
    // 触上限是另一种缺口，也要说出来
    const trunc = lintScenario(scen(body as never), { scenarioGraph: { edges: { 'scn.test': ['a'] }, truncated: 3 } });
    assert.match(trunc.find((i) => i.code === 'CALL_GRAPH_INCOMPLETE')!.message, /节点上限/);
    // `gaps: []`（键**在**而长度为 0）不算不完整。这条钉的是 `graphComplete` 里那句
    // `!(g.gaps?.length ?? 0)`：写成 `!g.gaps` 的话，空数组是 truthy，
    // 每一次完整的 lint 都会带上一条"图不完整" —— 而那条 warning 一旦常开，
    // 下一次真不完整时就没人看了（本项目对"恒常出现的告警"记过多次账）
    const emptyGaps = lintScenario(scen(body as never), { scenarioGraph: { edges: { 'scn.test': [] }, gaps: [] } });
    assert.ok(!emptyGaps.some((i) => i.code === 'CALL_GRAPH_INCOMPLETE'), 'gaps 是空数组时不该报（键在不在不等于完不完整）');
  });

  test('缺口按**原因**分说：文件不存在 ≠ 文件在而 IR 读不出（两种修法不同）', () => {
    /*
     * 本轮量到的真实错归因：子场景文件在而里面那份 IR 不合法时，话说成
     * 「1 个 call 目标**解析不到**」，于是人去查那个 ref 存不存在、拼没拼错 ——
     * 而真相是文件一直在，要修的是文件里的内容。**这一格还比"缺文件"更要紧：
     * 环可能正藏在那个读不出来的文件里。**
     *
     * 判据交给 `graphGapSummary`（独立实现），所以这里是一行断言而不是"跑一次真命令"。
     * 两侧都要断：只断"读不出那种说了读不出"，实现退化成"永远说读不出"也能过关。
     */
    const missing = graphGapSummary([{ from: 'scn.a', ref: 'x@1', reason: 'not-found' }]);
    const invalid = graphGapSummary([{ from: 'scn.a', ref: 'x@1', reason: 'invalid-ir', detail: 'body.0.kind 不是合法值' }]);
    assert.match(missing.lines[0]!, /找不到/);
    assert.ok(!missing.lines[0]!.includes('读不出'), '文件不存在时不许提"IR 读不出"（那是另一种修法）');
    assert.match(invalid.lines[0]!, /读不出/);
    assert.match(invalid.lines[0]!, /body\.0\.kind/, 'detail 要带上，否则"读不出"还是没有下文');
    assert.ok(!invalid.lines[0]!.includes('找不到'), '文件在时不许说"找不到" —— 那句话会让人去查 ref 拼没拼错');
    // 修法也必须分岔：给"文件在"的人一句"把子场景放进 irDir"，他会去改 ref
    assert.match(invalid.fixes.join(''), /内容/, '修 IR 的理由要说清修的是**内容**');
    assert.ok(!invalid.fixes.join('').includes('irDir'), '不许给"文件在"的人一个搬文件的动作');
    assert.match(missing.fixes.join(''), /irDir/);
  });

  test('生产方没记原因时，**不许**说成"文件找不到"（那是凭空捏造的归因）', () => {
    /*
     * `reason` 在类型上是可选的（引擎里手拼的夹具图分辨不出原因）。
     * 我第一版写的是 `gaps.filter(g => g.reason !== 'invalid-ir')` → 归到"找不到文件"，
     * 于是"没记原因"被说成了"文件不存在"。那种句子的害处与"说错"同级：
     * 人会照做（去查 ref），而真相可能压根不是这件事。
     * 现在认不出来就照实说认不出来，而且**不给修法**。
     */
    const unknown = graphGapSummary([{ from: 'scn.a', ref: 'x@1' }]);
    assert.match(unknown.lines[0]!, /没记下原因/);
    assert.ok(!unknown.lines[0]!.includes('找不到'), '不许把"没记原因"并入"文件不存在"');
    assert.ok(!unknown.lines[0]!.includes('读不出'), '也不许并入另一种');
    assert.deepEqual(unknown.fixes, [], '认不出原因时不给修法（不承诺一个不知道能不能做的动作）');
    // 未知键同理：reason 的值来自类型，但外部生产方给的字符串不可信
    const weird = graphGapSummary([{ from: 'scn.a', ref: 'x@1', reason: 'whatever' as 'not-found' }]);
    assert.match(weird.lines[0]!, /没记下原因/, '认不出的 reason 落到兜底那一格，不许悄悄复用别的原因的措辞');
  });

  test('多种原因同时在场：**每种一句，且 message 里说了的原因 fix 里必须有**', () => {
    /*
     * 后半句是这条测试的重点，也是我把措辞与修法放进**同一张表**的原因。
     * 第一版分两处算"本次有哪些原因"（message 用分桶、fix 用 `gaps.filter(…)`），
     * 那时"message 里出现了 invalid-ir 而 fix 里没提"只需要有人改一处就能诞生 ——
     * 半截建议比没建议更坏：人以为已经看完修法了。
     * 所以这里不是逐条点死文案，而是断**两个集合恒等**这个不变式。
     */
    const gaps = [
      { from: 'scn.a', ref: 'bad1@1', reason: 'invalid-ir' as const, detail: '不是合法 JSON' },
      { from: 'scn.a', ref: 'bad2@1', reason: 'invalid-ir' as const },
      { from: 'scn.a', ref: 'ghost@1', reason: 'not-found' as const },
      { from: 'scn.a', ref: 'mystery@1' },
    ];
    const { lines, fixes } = graphGapSummary(gaps, 4);
    assert.equal(lines.length, 4, `三种原因 + 触上限 = 四句：\n${lines.join('\n')}`);
    assert.match(lines.join(''), /2 处/);
    assert.match(lines.join(''), /例如 bad1@1/, '多于一个时要点样本（一个时不写"例如"）');
    assert.match(lines.join(''), /节点上限/);
    // 不变式：**message 里出现的每一类有修法的缺口，fix 里都得有一句**
    const fixText = fixes.join('；');
    assert.match(fixText, /文件在而 IR 不合法的那 2 处/);
    assert.match(fixText, /文件不存在的那 1 处/);
    assert.match(fixText, /达到节点上限的那 4 处/);
    assert.equal(fixes.length, 3, `没记原因那一类不该有修法，所以是 3 句：\n${fixText}`);
    // 多的那类排在前面（读的人只会认真读第一句）
    assert.match(lines[0]!, /^2 处/, `最多的原因该排第一：\n${lines.join('\n')}`);
  });

  test('detail 里混进密钥形态时**不许原样进日志**（那句话源自别人写的文件）', () => {
    /*
     * `detail` 是 CLI 解析器从磁盘上那份文件的报错里取的，而 `JSON.parse`
     * 会带上出错位置附近的**原文**。这句话要进 lint 输出与 CI 日志，那是要落盘的文字，
     * 所以我不能假设它永远无害 —— 与散文那三个出口（`esc`/`xmlSafe`/`plainSafe`）同一条约束。
     */
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const { lines } = graphGapSummary([{ from: 'scn.a', ref: 'bad@1', reason: 'invalid-ir', detail: `不是合法 JSON，附近有 "${jwt}"` }]);
    assert.ok(!lines[0]!.includes(jwt), `JWT 不许出现在结论里：${lines[0]}`);
    assert.match(lines[0]!, /JWT:已脱敏/, '要留痕（说明确实脱过一次），不能悄悄删掉');
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
    /*
     * 这里原先是一份**手抄的字符串数组**，而它已经飘了：
     * `RETRY_ON_CONTAINER` 有规则、有测试（本文件 404 行那一段），却不在这份名单里 ——
     * 只是 dirty() 那个夹具恰好不触发它，所以名单一直没被证伪。
     * 这正是本仓反复那一族：**同一个事实两处记，其中一处就会过期**。
     * 改成从 `LINT_DOCS` 取（它是 `Record<LintCode, string>`，
     * 少一个键就编译不过 —— 于是"登记"这件事由类型系统兜着，名单不再需要人记得更新）。
     * 本轮加 `HOVER_THEN_NOT_IMPLEMENTED` 时就是靠那条编译错误发现必须同时补 doc 的。
     */
    const KNOWN = new Set<string>(Object.keys(LINT_DOCS));
    // 27 = 本文件写下的这一刻 LINT_DOCS 的键数。**这条下限不是拿来卡"不许删码"的**
    // （删码是合法操作，改这里就行），它防的是另一件事：Object.keys 因为
    // import 路径指错/循环依赖拿到一个空对象时，下面那个 for 循环会**恒通过**
    // —— "名单永远成立"正是本仓那一族缺陷的形状（同 mutate.mjs 里 noTestsIn 的教训）。
    assert.ok(KNOWN.size >= 27, `LINT_DOCS 只解析出 ${KNOWN.size} 个键，这不对 —— 名单本身没内容，下面的循环是空转`);
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

describe('SQL_PLACEHOLDER_UNBOUND（SQL 里有 $ 而这一步压根没绑任何值）', () => {
  /*
   * docs/15 §3.2 的**静态那一半**。运行时那一半本轮已经修好（如实报错，
   * 不再伪装成超时），所以这条定 **warning** 而不是 error ——
   * 与 HOVER_THEN_NOT_IMPLEMENTED 相反，区别就在运行时的形状：
   * hoverThen 不实现会**判 pass**（假绿，必须拦在跑之前），
   * 而这一条运行时会自己报 error。把已有场景全部照旧注释写出来的那种写法
   * 定成 error，等于用一次 lint 变更把别人的 CI 全停掉，
   * 去换一个运行时本来就会说的错。**静态闸该拦运行时看不见的错。**
   *
   * 判据是「vars 是空的」而不是「$x 在 vars 里没有同名键」——
   * 后者要先规定"$x 指 vars.x"，而**全仓从没有地方规定过 SQL 里的 $ 是什么语法**
   *（MySQL 的具名占位是 ? / %(x)s，$ 连标准都不是）。
   * 定那个约定就是"引擎现猜"那一族，只是猜的人换成了 lint。
   */
  const waitRow = (cond: Record<string, unknown>): StepDraft =>
    ({ ...b('w'), kind: 'wait', timeoutMs: 1000, pollMs: 100, onTimeout: 'fail', condition: cond } as StepDraft);

  test('wait{dbRow}.sql 带 $ 而没写 vars => 提醒', () => {
    const i = find([waitRow({ type: 'dbRow', sql: 'SELECT 1 WHERE id = $oid', datasource: 'main' })], 'SQL_PLACEHOLDER_UNBOUND');
    assert.ok(i, '不提醒的话，作者会照着旧注释以为 $oid 会自动绑');
    assert.equal(i!.level, 'warning', '运行时已如实报错，这条只是提前说 —— 不该有能力停掉别人的 CI');
    assert.equal(i!.stepId, 'w');
    assert.match(i!.fix ?? '', /vars/, '修法要指向那个新字段，否则人只会去删掉 $');
    assert.match(i!.fix ?? '', /拼接/, '要顺手挡住那条看起来更简单的路（字符串拼 SQL）');
  });

  test('三处 SQL 各自都查（wait / dataSource / db），不只 wait', () => {
    /*
     * 三处的字段同名、错法同源，所以三处都要响。只查 wait 的话
     * 症状是"等待里的 SQL 会被提醒、db 步里的不会"，而那两处写错的方式一模一样。
     */
    assert.ok(codes([
      { ...b('d'), kind: 'dataSource', source: { type: 'mysql', sql: 'SELECT * FROM t WHERE a = $a', datasource: 'main' } },
    ] as StepDraft[]).includes('SQL_PLACEHOLDER_UNBOUND'), 'dataSource 没查');
    assert.ok(codes([
      { ...b('d'), kind: 'db', datasource: 'main', sql: 'SELECT * FROM t WHERE a = $a' },
    ] as StepDraft[]).includes('SQL_PLACEHOLDER_UNBOUND'), 'db 步没查');
  });

  test('复合谓词里的 dbRow 也查（不能只查顶层条件）', () => {
    const c = codes([waitRow({ allOf: [
      { type: 'expr', expr: '1 == 1' },
      { type: 'dbRow', sql: 'SELECT 1 WHERE id = $oid', datasource: 'main' },
    ] })]);
    assert.ok(c.includes('SQL_PLACEHOLDER_UNBOUND'), '只查顶层的话 allOf 里那条永远没人提醒');
  });

  test('SQL 用 ? 占位 + 绑了 vars = 正确写法，不报', () => {
    const c = codes([waitRow({ type: 'dbRow', sql: 'SELECT 1 WHERE id = ?', datasource: 'main', vars: { oid: { path: '$oid' } } })]);
    assert.ok(!c.includes('SQL_PLACEHOLDER_UNBOUND'), '正确写法被拦 => 人会把 lint 关掉，那是一条规则换全部规则');
  });

  test('SQL 里写 $oid 而 vars 也绑了 oid —— 仍然要报', () => {
    /*
     * 这一条是**被自己的变异集问出来的**（tooling/mutate/wait-not-wired.json 的 L5）。
     * 我第一版的判据是"vars 是空的"，于是这个形状**恰好漏掉**：
     * 作者既写了 `$oid` 也写了 `vars:{oid:…}`，看着什么都没缺，
     * 而 MySQL 收到的还是那句带 `$oid` 的 SQL —— 这是最主流的那个错法，
     * 因为 IR 的旧注释说的正是"`$var` 占位由引擎绑定"。
     *
     * 所以判据只剩一条：**`$x` 不是本 IR 规定过的占位写法，引擎也不做 `$` 替换**。
     * 而**不能**反过来判"`$oid` 在 vars 里有没有同名键"（那等于我替 MySQL
     * 规定了 `$` 是占位语法 —— 它的具名占位其实是 `?` / `%(x)s`）。
     */
    const i = find([waitRow({ type: 'dbRow', sql: 'SELECT 1 WHERE id = $oid', datasource: 'main', vars: { oid: { path: '$oid' } } })], 'SQL_PLACEHOLDER_UNBOUND');
    assert.ok(i, '绑了 vars 就闭嘴，等于把最主流的错法放行');
    assert.ok(!/一个 vars 都没绑/.test(i!.message ?? ''),
      `vars 已绑时不该再说"一个都没绑"：${i!.message}`);
  });

  test('vars 一个都没绑时，摘要里要补那一句（同一条错里更常见的一种）', () => {
    const i = find([waitRow({ type: 'dbRow', sql: 'SELECT 1 WHERE id = $oid', datasource: 'main' })], 'SQL_PLACEHOLDER_UNBOUND');
    assert.match(i!.message ?? '', /一个 vars 都没绑/);
  });

  test('对照：SQL 里没有 $ 的普通查询不报', () => {
    const c = codes([waitRow({ type: 'dbRow', sql: 'SELECT count(*) FROM orders', datasource: 'main' })]);
    assert.ok(!c.includes('SQL_PLACEHOLDER_UNBOUND'), '每条 dbRow 都报 => 与 SLEEP_USED 那种精准提醒混在一起，没人再看');
  });

  test('对照：qdrant 那种没有 SQL 的数据源不参与', () => {
    const c = codes([
      { ...b('d'), kind: 'dataSource', source: { type: 'qdrant', collection: 'c', query: '向量 $q', limit: 5 } },
    ] as StepDraft[]);
    assert.ok(!c.includes('SQL_PLACEHOLDER_UNBOUND'), 'query 是检索词不是 SQL，那里的 $ 没有任何绑定语义');
  });
});

describe('HOVER_THEN_NOT_IMPLEMENTED（声明了第二件事而平台一件都不做，所以要响）', () => {
  /*
   * 这条守的是**本轮新登记的一条假绿**（docs/08 §3 有整行明细）。
   * `act{action:'hover', hoverThen:'click'}` 的真实行为是 hover 完就停、**步骤 pass**：
   * 作者声明了一个动作、平台一个都没做、报告写绿。
   *
   * 它与 `expectNewPage` 同族（docs/14 §4.3 子类 (a)「schema 有字段、执行侧没人读」），
   * 而**比它更隐蔽**：hoverThen 的默认值是 'none'，所以
   * "声明了 click" 与 "压根没声明" 跑起来**一模一样**，连一个可疑信号都不留。
   *
   * **为什么不顺手把它实现掉**（这条注释必须留，否则下一个人一定会去做）：
   * docs/06 §2 给的动机场景是"hover **A** 才出现 **B**、再点 **B**" —— 两个元素，
   * 而 IR 的 act 只有**一个** locator。按现有 schema 只能做成
   * "对同一个元素 hover 完再点它自己"，那**恰好覆盖不了下拉菜单**。
   * 一个语义不符、看着像实现了的功能，比不实现更容易让人以为验到了。
   */
  const actHover = (over: Record<string, unknown> = {}): StepDraft =>
    ({
      id: 'a', kind: 'act',
      locator: { intent: '菜单', primary: { by: 'testid', value: 'menu' } },
      action: 'hover', ...over,
    } as StepDraft);

  test('hoverThen:"click" => error 级，且修法要说"改成两个显式步骤"', () => {
    const i = find([actHover({ hoverThen: 'click' })], 'HOVER_THEN_NOT_IMPLEMENTED');
    assert.ok(i, '声明了 hoverThen 而 lint 不响 => 这一步会静默 pass（本轮修的就是这个）');
    assert.equal(i!.level, 'error',
      'warning 会被无视，而这一格失效的方向是**假绿**。error 让 CI 在跑之前就停（exit 3），'
      + '一个浏览器都不用起');
    assert.equal(i!.stepId, 'a');
    assert.match(i!.message ?? '', /pass|假绿/, 'message 要说清后果，不能只说"未实现"');
    assert.match(i!.fix ?? '', /两个显式步骤/, '要给一个今天就能用的绕法，否则人会把字段删掉——那等于把需求也删了');
  });

  test('hoverThen:"fill" 同样报（枚举里两个非默认取值都得响）', () => {
    assert.ok(codes([actHover({ hoverThen: 'fill' })]).includes('HOVER_THEN_NOT_IMPLEMENTED'),
      '只判 === "click" 的实现会让另一半静默通过 —— 枚举的每个非默认取值都是一条路');
  });

  test('对照：hoverThen 不写（默认 none）不报', () => {
    const c = codes([actHover()]);
    assert.ok(!c.includes('HOVER_THEN_NOT_IMPLEMENTED'),
      '默认值就报 => 每个 hover 步骤都被拦，症状是"照文档写的用例 lint 说不许写"');
  });

  test('对照：action 不是 hover 但写了 hoverThen 也报（别把规则绑在 action 上）', () => {
    /*
     * 这条近邻守卫是我写规则时**自己差点写错**的方向：
     * 直觉会把判据写成 `s.action === 'hover' && s.hoverThen !== 'none'`，
     * 于是 `{action:'click', hoverThen:'click'}` 这种（语义上奇怪但 IR 收得下）
     * 的写法会静默通过 —— 而它的失效方向和 hover 那一格**完全相同**：
     * 声明了第二件事、平台不做、判 pass。**要拦的是"声明了 hoverThen"，不是"在 hover"**。
     */
    assert.ok(codes([actHover({ action: 'click', hoverThen: 'click' })]).includes('HOVER_THEN_NOT_IMPLEMENTED'));
  });

  test('setup / teardown 里的 act 同样查（与 RETRY_ON_CONTAINER 同一条理由）', () => {
    const s = scen([{ ...b('h'), kind: 'noop' }] as never[], {
      setup: [actHover({ hoverThen: 'click' })] as never[],
    } as never);
    assert.ok(lintScenario(s).some((i) => i.code === 'HOVER_THEN_NOT_IMPLEMENTED' && i.stepId === 'a'),
      '只查 body 的话"前置里点了一次不会发生的操作"照样静默 —— 前置里 hover 出菜单再点是很常见的写法');
  });
});

/*
 * ## RESERVED_KEY_REWRITE —— path / expr / gen 是 IR 的保留键名
 *
 * 这一组的判据重心在**下半截**：三种写错都要报，以及（更要紧的）
 * 三种合法写法不许报。误报的代价不是"多一条黄字"，是大家把 lint 关掉，
 * 于是本文件其余二十几条规则一起失效 —— 所以下面"不许命中"的用例
 * 与"必须命中"的用例同样重要，缺任何一半，这条规则都不算被钉住。
 *
 * 为什么这条规则的运行时对照面在 value-forms.test.ts 而不是这里：
 * lint 只负责"在跑之前就响"，而"跑起来到底存下了什么"由那边判。
 * 两边同问 `isValueForm` 那一个判据（lint 侧第 (3) 种形状用的就是它），
 * 所以"运行时报错的场景 lint 必报"这件事是结构性的，不靠两边各抄一份清单。
 */
const reserved = (assign: unknown) =>
  lintScenario(scen([{ ...b('mk'), kind: 'set', assign } as StepDraft as never]))
    .filter((i) => i.code === 'RESERVED_KEY_REWRITE');

describe('保留键名写错（RESERVED_KEY_REWRITE）', () => {
  test('path 拼成 pathh + 值是 $ 开头 -> 报，且说清"引用没生效"', () => {
    const i = reserved({ row: { pathh: '$.step.s' } })[0];
    assert.ok(i, '把 path 拼错一个字母必须报 —— schema 收得下（值位置允许任意字面量），不报就是静默');
    assert.equal(i!.level, 'warning', 'warning 不 error：业务对象恰好撞保留键名是合法写法，error 会让 run --strict 拒跑跑得通的场景');
    assert.match(i!.message, /按字面量存进变量空间|没生效/, '必须说清"实际存下了什么"，只说"键名可疑"会被当成无害的命名提醒');
    assert.match(i!.fix ?? '', /path/, 'fix 要给出该用的键名');
    assert.equal(i!.stepId, 'mk', '要指到步骤，否则两百步的场景里没人找得到那行');
  });
  test('expr 拼成 expr2 + 值像表达式 -> 报', () => {
    assert.ok(reserved({ row: { expr2: '1+1' } }).length > 0);
  });
  test('gen 拼成 gien / gene / gn + 值是合法种类 -> 报', () => {
    // 这三种是"多一个字母 / 少一个字母"那一族，都在 isNearMiss 的契约内（差一位）。
    // 这里以前写的是 `geean`，而它与 gen 差**两位**，本来就不该报 ——
    // 是我把测试写错了，不是规则漏了（用一个规则不该覆盖的写法去测"必须命中"，
    // 得到红了会去改判据，那就把误报面白白放宽了一档）。
    for (const k of ['gien', 'gene', 'gn']) {
      assert.ok(reserved({ row: { [k]: 'uuid' } }).length > 0, `${k} 该报`);
    }
  });
  test('相邻两位调换也算：paht / gne -> 报（编辑距离是 2，靠对调那一支抓到）', () => {
    // 人打字最容易错的就是相邻两位调换，而它**不在**"增/删/换"那三路里
    assert.ok(reserved({ row: { paht: '$.step.s' } }).length > 0, 'paht 该报');
    assert.ok(reserved({ row: { gne: 'uuid' } }).length > 0, 'gne 该报');
  });
  test('种类拼错 {gen:"uuidd"} -> 报，且 fix 列出全部可用种类', () => {
    const i = reserved({ row: { gen: 'uuidd' } })[0];
    assert.ok(i);
    assert.match(i!.message, /uuidd/);
    assert.match(i!.fix ?? '', /uuid/);
    assert.match(i!.fix ?? '', /区分大小写/, '尾随空格与大小写是这一族最常见的两种错法，fix 要直说');
  });
  test('with 拼成 widh -> 报，并说清整个 {gen:…} 会按字面量存下', () => {
    const i = reserved({ row: { gen: 'int', widh: { min: 1 } } })[0];
    assert.ok(i, '`with` 拼错时生成器整个没了，而这一步照样 pass —— 必须报');
    assert.match(i!.message, /按字面量存下|参数也没生效/);
  });

  // ── 以下是**不许误报**的对照组 ────────────────────────────────
  test('合法写法一律不报：引用 / 表达式 / 生成器（含带 with 的）', () => {
    for (const v of [{ path: '$.step.mk' }, { expr: '1+1' }, { gen: 'uuid' }, { gen: 'int', with: { min: 1, max: 9 } }]) {
      assert.deepEqual(reserved({ row: v }), [], `${JSON.stringify(v)} 是合法形态，不该报`);
    }
  });
  test('业务对象恰好用了保留键名 -> 不报（这是 IR 明确允许的写法）', () => {
    // `{gen:'widget', size:'L'}` 运行时按字面量整存，是完全合法的业务对象。
    // 上一版这条规则按"有 gen 键 + 种类不认识"判，对着它报了"种类 widget 不存在" ——
    // 一个误报，而它报的理由（"schema 会收下"）倒是真的，所以特别容易被当成真问题留下。
    // 现在判据换成 isValueForm(obj)==='gen'，与运行时同一个问题、同一个答案。
    assert.deepEqual(reserved({ row: { gen: 'widget', size: 'L' } }), []);
    assert.deepEqual(reserved({ row: { path: 'src/a.ts', lang: 'ts' } }), []);
    assert.deepEqual(reserved({ cfg: { expr: '红色', unit: 'px' } }), []);
  });
  test('extract 的规则形状 {var,path} 不被误报（每条 extract 都有 path 键）', () => {
    const c = lintScenario(scen([
      getStep('h'),
      { ...b('x'), kind: 'extract', from: '$.step.h.resp', rules: [{ var: 'id', path: '$.id' }] },
    ] as never[])).filter((i) => i.code === 'RESERVED_KEY_REWRITE');
    assert.deepEqual(c.map((i) => i.message), [], 'extract 的 path 是正牌 IR 字段，两个键也不该被认成"引用写错"');
  });
  test('len / gen 只差一个字母，但 len 不报（首字母不同这一条挡住的就是它）', () => {
    /*
     * 值刻意用 'uuid' 而不是 'abc'：判据是"键近保留键 **且** 值像那个形态"两条件同时成立才报，
     * 值随便是个不像种类的词时，第二条本来就把整条拦住了 —— 那样的对照组
     * 对"首字母相同"这一支**没有区分度**（变异集 R8 拿掉首字母条件照样全绿，就是这么活下来的）。
     * 只有值也踩上形态特征，报不报才只由首字母那一支决定。
     */
    assert.deepEqual(reserved({ row: { len: 'uuid' } }), [], 'len 是常见字段名，不该因为与 gen 差一个字母就被说成生成器');
    assert.deepEqual(reserved({ row: { len: 'abc' } }), []);
  });
  test('值不像那个形态时不报：引用位要 $ 开头，表达式位要像表达式', () => {
    // 三种形态各测一条"键名踩线但值不像"的：判据是两条件同时成立，
    // 所以每一支的第二个条件都得有对照组 —— 只测其中一支时，另两支的条件被拿掉没人知道
    // （变异集 R9 改的是 path 那一支的条件，而这里原先只有 expr 的对照组，于是它活了下来）。
    assert.deepEqual(reserved({ row: { pathh: 'src/a.ts' } }), [], '值不以 $ 开头 -> 不像引用');
    assert.deepEqual(reserved({ row: { expr2: '红色' } }), [], '值不含运算符 -> 不像表达式');
    assert.deepEqual(reserved({ row: { geean: ' widget ' } }), [], '值不是种类名也不是种类的近邻 -> 不像生成器');
    // 而值踩上线时照报（证明这几条对照组不是靠"整条规则不工作"通过的）
    assert.ok(reserved({ row: { pathh: '$.step.s' } }).length > 0);
    assert.ok(reserved({ row: { expr2: '1+1' } }).length > 0);
  });
  test('业务对象 {gen:"uuid", width:100} 不报 —— width 与 with 近邻，但值不是对象', () => {
    /*
     * 这一条是规则写完**当场实测出来的误报**，不是设想的：本平台测的是界面，
     * width / height 这类字段名到处都是，而 `width` 与 `with` 只差两个字母。
     * 上一版形状 (2) 只判"有 gen 键 + 伴随键近 with"，于是
     * `{gen:'uuid', width:100}`（运行时按字面量整存的合法业务对象）
     * 吃了一条"with 拼错了"的假 warning。修法不是给 width 开特例，
     * 是补上第二条件"值必须是对象"—— 判据来自 schema：`GenValue.with` 是
     * `z.record(...)`，真的 with 值本来就是对象。
     */
    assert.deepEqual(reserved({ row: { gen: 'uuid', width: 100 } }), []);
    assert.deepEqual(reserved({ row: { gen: 'uuid', height: 30 } }), []);
    // 而真的拼错照报（值这次是对象）
    assert.ok(reserved({ row: { gen: 'int', widh: { min: 1 } } }).length > 0);
  });
  test('一个错只报一条（种类与伴随键同时写坏时不许刷屏）', () => {
    const n = reserved({ row: { gen: 'uuidd', widh: { min: 1 } } }).length;
    assert.equal(n, 1, `本该一条，实际 ${n} 条`);
  });

  /*
   * ## 误报面的**活**护栏：拿真判据去扫真 schema
   *
   * RESERVED_KEY_REWRITE 的成立前提是"合法 IR 不会被报"。这个前提**不能写成注释里的
   * 一句结论** —— 近邻判据每放宽一档（本轮就从"增删换"加到了"含对调"），
   * 上一次扫描的结论就自动失效，而注释不会红。所以这里让**导出的** `isNearMiss`
   * 去扫 `@atest/ir` 导出的**那些 schema 对象本身**：
   * 判据放宽到能命中任何一个正牌字段名，这条就红。
   *
   * 扫描用的是 schema 对象而不是"抄一份字段名清单"—— 后者会退化成
   * "两份清单是否抄得一样"（本文件 380 行那段记的就是这个坑：手抄的码名单飘了）。
   */
  // 判据的靶子键。前三个从 ir 的 VALUE_KEY_FORM 取而不是在这里抄一遍 ——
  // 这条测试的职责是"合法字段别被撞"，而它自己撞上一份手抄清单就太讽刺了
  // （本文件 380 行那段记的正是手抄名单飘掉的事故）。
  // `with` 不在 VALUE_KEY_FORM 里（它是生成器的**伴随**键，不是形态键），所以只能列在这里。
  const RESERVED: string[] = [...Object.keys(irSchema.VALUE_KEY_FORM as Record<string, unknown>), 'with'];

  test('IR 的正牌字段名没有一个撞在近邻面上', () => {
    const keys = new Set<string>();
    const seen = new Set<unknown>();
    // zod v4：对象schema 的字段在 .shape，union/optional/默认值等包装在 ._def 里。
    // 这里不追求覆盖每一个 zod 组合子，追求的是"路径够深 + 覆盖到 shape"，
    // 而**够不够**由下面那条自检判（少一条自检，这个循环可以空转而全绿）
    const walk = (sch: unknown, depth: number): void => {
      if (!sch || typeof sch !== 'object' || depth > 10 || seen.has(sch)) return;
      seen.add(sch);
      const o = sch as { shape?: Record<string, unknown>; _def?: Record<string, unknown> };
      if (o.shape && typeof o.shape === 'object') {
        for (const [k, v] of Object.entries(o.shape)) { keys.add(k); walk(v, depth + 1); }
      }
      const d = o._def;
      if (d) {
        for (const key of ['innerType', 'type', 'left', 'right', 'in', 'element', 'valueType']) walk(d[key], depth + 1);
        const opts = d['options'] ?? d['values'];
        if (Array.isArray(opts)) for (const x of opts) walk(x, depth + 1);
      }
    };
    for (const exp of Object.values(irSchema)) if (exp instanceof ZodType) walk(exp, 0);

    // 自检 ①：名单本身非空。空的下面那个 for 恒通过 —— 正是本仓点名的"名单永远成立"形状
    assert.ok(keys.size > 100, `只扫到 ${keys.size} 个字段名，这个扫描不可信，下面的循环是空转`);
    // 自检 ②：四个靶子键自己必须在名单里（不在 = 根本没走到那几个 schema）
    for (const t of RESERVED) assert.ok(keys.has(t), `名单里没有 ${t}，说明没扫到 GenValue/RefValue/ExprValue`);
    // 自检 ③：判据坏掉（恒 false）时，这四个 must-fire 会立刻露馅
    for (const [typo, target] of [['pathh', 'path'], ['paht', 'path'], ['pth', 'path'], ['widh', 'with']] as const) {
      assert.ok(isNearMiss(typo, target), `判据抓不到 ${typo}，"零命中"不可信`);
    }

    const hits = [...keys].filter((k) => RESERVED.some((t) => k !== t && isNearMiss(k, t)));
    assert.deepEqual(hits, [], `这些正牌 IR 字段会被 RESERVED_KEY_REWRITE 误报：${hits.join(', ')}`);
  });
});
