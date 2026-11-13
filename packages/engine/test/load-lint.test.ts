/**
 * 压测静态闸（docs/09 §4.2 那句「IR 压测子集校验（静态闸新增一组规则）」）。
 *
 * ## 这个文件的主角**不是**那六条规则，而是**遍历判据表那两条**
 *
 * 六条规则各命中一次是常规做法（本文件里也有）。但 LOAD_* 这一组真正的风险不在
 * "某条规则写错了"，在**两份判据分叉**：判据表在 `ir/src/load.ts`，
 * 消费它的是这里的静态闸与 `adapter-http/src/load/plan.ts` 的编译器。
 * 分叉的两种坏法都不报错：
 *  - 表说 refuse 而编译器有分支 -> 静态闸拦住一条其实能压的用例（作者关掉 --strict）；
 *  - 表说 flow 而编译器**没有**分支 -> 静态闸放行，编译器当场抛一句"不支持"，
 *    用户被挡在跑之后（这是 docs/08 §3(e) 那一族：有载体、没有生产者）。
 * 所以这里把整张 `LOAD_STEP_SUPPORT` 走一遍，每个 `press`/`flow`/`once` 的 kind
 * **都真编译一次**。新增一个 kind 而忘了让某一侧跟上，红的就是这个 test。
 *
 * ## 夹具一律过 schema，否则断言验的是 zod 而不是闸
 *
 * 本文件第一版在这条上红了 6 次，而**6 次全是夹具的错、闸一次都没被跑到**：
 * `retry:{backoffMs}`（真字段叫 `backoff`）、`wait` 少 `condition`、
 * `{type:'dbRow'}` 少 `sql`。`scen()` 里的 `defineScenario` 先抛
 * 「场景不合法」，那条 `assert.ok(issue)` 就成了"闸没报"的假指控 ——
 * 更坏的方向是反过来：夹具哪天悄悄不合法了，"闸报了"那条断言也会因为
 * 抛在别处而**永远红不到**判据上。
 * 所以现在所有 wait 谓词从 `VALID_PREDICATE` 取，而**每条先过一遍 StepSchema**
 * （下面那条自检测试）。这一条自检不是礼节：它保证"闸抓到了 dbRow"这句话
 * 描述的是一个**真能进 lint 的场景**，而不是一份只存在于测试文件里的假 IR。
 *
 * ## 为什么不"从源码扫 switch 分支"
 * `lint-step-exports.test.ts` 用的是源码扫描，那是因为它对撞的两边有一边
 * （解释器的 switch）**没法便宜地跑起来**。这里不同：编译器是个纯函数
 * （IR + lookup 进、JSON 计划出），跑它比扫它便宜，而且跑出来的结论是行为的结论。
 * 判据与被检物之间因此没有第三份手抄。
 *
 * ## ⚠ 本文件**看不见**"表里少一行"，这一点是量出来的
 *
 * 下面所有遍历都是 `for (const [x] of Object.entries(表))`：表少一格，循环少跑一格，
 * 本文件全绿。**实测**（把 `LOAD_WAIT_SUPPORT.template` 那一格删掉后重跑）：
 * 本文件 22/22 绿，而 `ir/test/load-wait-keys.test.ts` 当场红。
 * 所以那一格由 ir 包里那根**从 schema 往表对撞**的钉子负责，本文件只负责
 * "表里有的那些，闸的判据对不对"。别把这两件事都算在本文件头上 ——
 * 以为遍历过了就等于覆盖过了，是这一族缺陷的上一级成因。
 * （kind 那一侧不受此限制，因为 `SAMPLE_STEP` 与 `LOAD_STEP_SUPPORT` 的键集
 * 在文件末尾**双向对撞**，少一行会红；谓词那一侧没有这份平行夹具，故只能靠 schema。）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintScenario, type LintCode, type LintContext } from '../src/index.js';
import {
  LOAD_STEP_SUPPORT, LOAD_WAIT_SUPPORT, MIN_SAMPLES_MS, StepSchema, WAIT_COMBINATORS,
  WaitConditionSchema, waitNeedsExternalAdapter, type Scenario, type Step, type StepDraft,
} from '@atest/ir';
import { b, scen, type StepDraft as Draft } from './helpers.js';

const LOAD = { vus: 10, durationMs: 60_000 };

const codesOf = (body: Draft[], extra: object = {}, ctx: LintContext = {}): LintCode[] =>
  lintScenario(scen(body as never[], { load: LOAD, ...extra } as never), ctx).map((i) => i.code);
const findOf = (body: Draft[], code: LintCode, extra: object = {}) =>
  lintScenario(scen(body as never[], { load: LOAD, ...extra } as never)).find((i) => i.code === code);

/** 一个能压的最小 body（http + 断言）。各条规则在它上面加/减一步 */
const pressStep = (id = 'q'): Draft => ({ ...b(id), kind: 'http', request: { method: 'GET', url: '/orders' } });
const assertStep = (id = 'a'): Draft => ({ ...b(id), kind: 'assert', against: '$.step.q.resp', jsonPath: { '$.id': { notNull: true } } });
const pressBody = (): Draft[] => [pressStep(), assertStep()];

/** 一个能过 schema 的定位器（界面类谓词与 UI 断言的夹具要用）。`primary` 是必需的 */
const LOC = { intent: '下单按钮', primary: { by: 'css', value: '.submit' } } as const;

/**
 * 每一种 wait 谓词的**合法**写法，键与 `WaitConditionSchema` 的判别字面量一致。
 *
 * **不从 schema 派生这份键名**是有意的：派生会得到一堆 `{}` 占位，
 * 而占位夹具正是上面那族假红的来源。键名与 schema 的对撞在
 * `ir/test/load-wait-keys.test.ts`（那边直接从 `WaitConditionSchema.options` 取字面量），
 * 这里只保证"每个类型都有一份真能过 schema 的写法"，由下面那条自检测试守着。
 */
const VALID_PREDICATE: Record<string, unknown> = {
  httpStatus: { type: 'httpStatus', ref: '$.step.q.resp', in: [200] },
  expr: { type: 'expr', expr: '$.ok' },
  dbRow: { type: 'dbRow', sql: 'select 1', datasource: 'd' },
  uiPredicate: { type: 'uiPredicate', target: LOC, state: 'visible' },
  template: { type: 'template', target: LOC, expect: 'hit' },
  uiIdle: { type: 'uiIdle', quietMs: 100 },
  response: { type: 'response', urlPattern: '/orders' },
  newPage: { type: 'newPage' },
};

/** 表里 refuse 的谓词类型（不写死列表：从表本身取，加了新 refuse 类型自动进来） */
const refusedPredicates = Object.entries(LOAD_WAIT_SUPPORT).filter(([, t]) => t.support === 'refuse').map(([k]) => k);

const waitStep = (id: string, cond: unknown): Draft => ({ ...b(id), kind: 'wait', condition: cond, timeoutMs: 1000 });

describe('夹具自检：报错前必须先确认夹具合法（否则断言验的是 zod）', () => {
  test('VALID_PREDICATE 的每一种谓词都能过 StepSchema', () => {
    const schemaTypes = new Set(
      (WaitConditionSchema as unknown as { options: { shape: { type: { value: string } } }[] }).options.map((o) => o.shape.type.value),
    );
    // 双向：schema 里每个类型都有夹具，且夹具里没有已经改名的死键
    assert.deepEqual(
      [...schemaTypes].sort(), [...Object.keys(VALID_PREDICATE)].sort(),
      '夹具表与 WaitConditionSchema 分叉（加了谓词类型而这里没补，或 schema 改了名）',
    );
    for (const [type, cond] of Object.entries(VALID_PREDICATE)) {
      const r = StepSchema.safeParse({ ...b('w'), kind: 'wait', condition: cond, timeoutMs: 1000 });
      assert.ok(r.success, `谓词夹具 ${type} 不合法：${r.error?.issues.map((i) => `${i.path.join('.')} → ${i.message}`).join('; ')}`);
    }
  });

  test('refuse 档的每一种谓词都有夹具（否则下面那条遍历是空转）', () => {
    assert.ok(refusedPredicates.length > 0, 'LOAD_WAIT_SUPPORT 里一个 refuse 都没有？表被清空了');
    for (const t of refusedPredicates) assert.ok(VALID_PREDICATE[t], `谓词 ${t} 是 refuse 而这里没有合法夹具`);
  });

  test('SAMPLE_STEP 里每一份夹具都过 StepSchema', () => {
    // 同上一条的理由，作用在 kind 那一侧：`{...b('bad'), kind}` 那种"只给 kind"的写法
    // 会在 wait/db/device 上得到 schema 报错，于是 LOAD 断言全在验 zod。
    for (const [kind, step] of Object.entries(SAMPLE_STEP)) {
      const r = StepSchema.safeParse(step);
      assert.ok(r.success, `kind=${kind} 的夹具不合法：${r.error?.issues.map((i) => `${i.path.join('.')} → ${i.message}`).join('; ')}`);
    }
  });
});

describe('LOAD_* 静态闸：每条规则各命中一次 + 近邻不误报', () => {
  test('LOAD_STEP_UNSUPPORTED：refuse 档的每个 kind 都报，且消息带着那张表的 why', () => {
    // 遍历而不是挑几个：refuse 档有 20 多个住户，"只测 navigate"会让
    // 后来加进 refuse 的那个 kind 永远没被证明能报出来
    for (const [kind, t] of Object.entries(LOAD_STEP_SUPPORT)) {
      if (t.support !== 'refuse') continue;
      const sample = SAMPLE_STEP[kind];
      assert.ok(sample, `refuse 档的 ${kind} 没有夹具（补一份，别跳过——跳过=这一格没人验）`);
      const issue = findOf([...pressBody(), sample], 'LOAD_STEP_UNSUPPORTED');
      assert.ok(issue, `${kind} 在表里是 refuse，静态闸却没报（表与闸分叉）`);
      assert.equal(issue!.stepId, SAMPLE_STEP_ID, `${kind} 的报错没指到那一步`);
      assert.equal(issue!.level, 'error');
      assert.match(issue!.message, new RegExp(t.why.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${kind} 的报错没带上表里那句 why`);
    }
  });

  test('…而 refuse 档的步骤在**没有 load 块**的场景里一个都不报', () => {
    // 这条是本文件最重要的一条**反向**断言。lint 踩过的坑就是把"不能压测"
    // 报在一条正常功能用例上（docs/08 §3 记过假报错的代价：作者关掉 --strict，
    // 整条闸在 CI 里消失）。db/while/parallel/call 在日常用例里全是正当写法。
    // 遍历整张 refuse 表而不是只测 db：少测一个 kind 就是留一格"日常写法被误报"的盲区。
    for (const [kind, t] of Object.entries(LOAD_STEP_SUPPORT)) {
      if (t.support !== 'refuse') continue;
      const sample = SAMPLE_STEP[kind];
      assert.ok(sample, `${kind} 没有夹具`);
      const codes = lintScenario(scen([...pressBody(), sample] as never[])).map((i) => i.code);
      assert.ok(!codes.includes('LOAD_STEP_UNSUPPORTED'), `没有 load 块的场景里 ${kind} 被压测判据评判了`);
      assert.ok(!codes.includes('LOAD_NO_PRESS_STEP'), `${kind} 的场景把"没有请求"也报出来了（pressBody 应该带 http）`);
    }
  });

  test('LOAD_STEP_UNSUPPORTED：refuse 档的步骤藏在 forEach 里面也报（走整棵树，不是只看顶层）', () => {
    const issue = findOf(
      [...pressBody(), { ...b('f'), kind: 'forEach', items: '$rows', as: 'r', steps: [{ ...b('bad'), kind: 'db', sql: 'select 1', datasource: 'd' }] }],
      'LOAD_STEP_UNSUPPORTED',
    );
    assert.ok(issue, '嵌在容器里的 refuse 步骤必须也看得见');
    assert.equal(issue!.stepId, 'bad');
  });

  test('LOAD_STEP_UNSUPPORTED：wait 的谓词要外部能力时报，而 {expr} 那种不报', () => {
    const bad = findOf([...pressBody(), waitStep('w', VALID_PREDICATE.dbRow)], 'LOAD_STEP_UNSUPPORTED');
    assert.ok(bad, 'wait{dbRow} 在压测里判不了，必须报');
    assert.equal(bad!.stepId, 'w');
    // 合法谓词不该被这一条牵连
    const clean = codesOf([...pressBody(), waitStep('w2', VALID_PREDICATE.expr)]);
    assert.ok(!clean.includes('LOAD_STEP_UNSUPPORTED'), 'wait{expr} 是本地求值，压测里完全成立');
  });

  test('LOAD_STEP_UNSUPPORTED：三种复合键里藏的 refuse 谓词逐个都报', () => {
    // 本仓这个位置以前走的是 ['allOf','anyOf','not']，而 schema 里的第三种是 noneOf、
    // 根本没有 not —— 探针量出来 {noneOf:[{type:'dbRow'}]} 返回 undefined（闸放行），
    // 而运行期那一侧对整棵 noneOf 落到"判不了 -> 当假"，onTimeout:'continue' 下
    // 就是**静默当成没等**。所以三种键**逐个**测，一个都不代一个。
    for (const combinator of WAIT_COMBINATORS) {
      const nested = findOf(
        [...pressBody(), waitStep('w', { [combinator]: [VALID_PREDICATE.expr, VALID_PREDICATE.dbRow] })],
        'LOAD_STEP_UNSUPPORTED',
      );
      assert.ok(nested, `藏在 ${combinator} 里的 dbRow 也必须报（这个键的遍历漏了就是静默放行）`);
      assert.equal(nested!.stepId, 'w');
    }
  });

  test('复合键**全合法**时不报（否则上面那条"每次都报"是恒真的好消息）', () => {
    for (const combinator of WAIT_COMBINATORS) {
      const codes = codesOf([...pressBody(), waitStep('w', { [combinator]: [VALID_PREDICATE.expr, VALID_PREDICATE.httpStatus] })]);
      assert.ok(!codes.includes('LOAD_STEP_UNSUPPORTED'), `${combinator} 里全是本地谓词，闸不该报（恒报与恒不报同样是坏判据）`);
    }
  });

  test('LOAD_STEP_DEGRADED：wait 是警告（能压而测的件事不一样）', () => {
    const i = findOf([...pressBody(), waitStep('w', VALID_PREDICATE.expr)], 'LOAD_STEP_DEGRADED');
    assert.ok(i);
    assert.equal(i!.level, 'warning', 'wait 不是不能用，是语义降级 —— 报 error 等于禁掉一种正当写法');
  });

  test('LOAD_RETRY_IGNORED：步骤级与场景级两个位置都报，且是 error', () => {
    // 字段名是 backoff（不是 backoffMs）。本文件第一版写了 backoffMs 而被
    // schema.strict() 拒掉，于是这两条断言一次都没跑到闸上。
    const step = findOf([{ ...pressStep(), retry: { count: 2, backoff: 'fixed', baseMs: 100 } }, assertStep()], 'LOAD_RETRY_IGNORED');
    assert.ok(step);
    assert.equal(step!.level, 'error', '重试会把一次故障算成两次负载，静默忽略等于曲线不真');
    const cfg = findOf(pressBody(), 'LOAD_RETRY_IGNORED', { config: { retries: { count: 3, backoff: 'exponential', baseMs: 2000, maxMs: 10_000, retryOn: ['network'] } } });
    assert.ok(cfg, 'config.retries 也要报（场景级重试同样会重复计负载）');
    assert.ok(!codesOf(pressBody()).includes('LOAD_RETRY_IGNORED'), 'retry.count=0（默认）不该报');
  });

  test('LOAD_NO_PRESS_STEP：一条请求都不打的压测场景报，而 http / openapiCall 两种都算压', () => {
    const i = findOf([{ ...b('n'), kind: 'noop' }, assertStep()], 'LOAD_NO_PRESS_STEP');
    assert.ok(i);
    // 反向：openapiCall 也是 press 档。只认 http 的闸会把最常见的压测写法报掉
    assert.ok(!codesOf([{ ...b('c'), kind: 'openapiCall', docRef: 'd', operationId: 'op' }, assertStep()]).includes('LOAD_NO_PRESS_STEP'));
  });

  test('LOAD_NOT_CONCURRENCY_SAFE：作者自己声明不能并发时就别压', () => {
    const i = findOf(pressBody(), 'LOAD_NOT_CONCURRENCY_SAFE', { config: { concurrencySafe: false } });
    assert.ok(i);
    assert.equal(i!.level, 'error');
  });

  test(`LOAD_SHORT_RUN：短于统计下限（${MIN_SAMPLES_MS}ms）报警告而不是拦下`, () => {
    const i = findOf(pressBody(), 'LOAD_SHORT_RUN', { load: { ...LOAD, durationMs: 5000 } });
    assert.ok(i, '5 秒的 p95 由个位数样本决定，得说一句');
    assert.equal(i!.level, 'warning', '开发时拿 5 秒跑一把看曲线是正当需求，平台不该拦');
    assert.ok(!codesOf(pressBody(), { load: { ...LOAD, durationMs: MIN_SAMPLES_MS } }).includes('LOAD_SHORT_RUN'), '刚好到下限就不该报');
  });
});

describe('判据表与静态闸不许分叉（遍历整张表）', () => {
  test('表里每个 press/flow/once 的 kind 都**不被** LOAD_STEP_UNSUPPORTED 报', () => {
    // 方向 1：表说能用而闸报 -> 合法 IR 被 --strict 拒之门外
    for (const [kind, t] of Object.entries(LOAD_STEP_SUPPORT)) {
      if (t.support === 'refuse') continue;
      const sample = SAMPLE_STEP[kind];
      if (!sample) continue; // openapiCall 之类需要真 lookup 的由 adapter-http/test/load-plan.test.ts 覆盖
      const codes = codesOf([...pressBody(), sample]);
      assert.ok(!codes.includes('LOAD_STEP_UNSUPPORTED'), `${kind} 在表里是 ${t.support}，静态闸却报不支持（表与闸分叉）`);
    }
  });

  test('表里每个 refuse 的 kind 都被报（方向 2：闸漏报比没有闸更坏）', () => {
    for (const [kind, t] of Object.entries(LOAD_STEP_SUPPORT)) {
      if (t.support !== 'refuse') continue;
      const sample = SAMPLE_STEP[kind];
      assert.ok(sample, `${kind} 没有夹具`);
      assert.ok(findOf([...pressBody(), sample], 'LOAD_STEP_UNSUPPORTED'), `${kind} 在表里是 refuse 而闸没说话`);
    }
  });

  test('LOAD_WAIT_SUPPORT 里 refuse 的每个谓词类型都被闸拦住', () => {
    for (const type of refusedPredicates) {
      const issue = findOf([...pressBody(), waitStep('w', VALID_PREDICATE[type])], 'LOAD_STEP_UNSUPPORTED');
      assert.ok(issue, `谓词 ${type} 在表里是 refuse，闸没报`);
    }
  });

  test('表里 once 的谓词类型不被拦（只降级）', () => {
    for (const [type, t] of Object.entries(LOAD_WAIT_SUPPORT)) {
      if (t.support !== 'once' || !VALID_PREDICATE[type]) continue;
      const codes = codesOf([...pressBody(), waitStep('w', VALID_PREDICATE[type])]);
      assert.ok(!codes.includes('LOAD_STEP_UNSUPPORTED'), `谓词 ${type} 是 once 而闸把它当不支持`);
    }
  });

  test('表里**没有**的谓词类型按"要外部能力"处理（判不准时宁可少报支持）', () => {
    // 这一格不能靠 IR 场景走：`WaitConditionSchema` 的 discriminatedUnion 会在
    // schema 那一层就拒掉未知 type（实测报 "Invalid discriminator value"），
    // 于是"将来加了新谓词而 LOAD_WAIT_SUPPORT 少一行"这个形状**到不了 lint**。
    // 所以这一条直接打判据函数本身 —— 它才是那一格的实现，而且它收 unknown。
    // 与 `ir/test/load-wait-keys.test.ts`（schema ↔ 表 键集对撞）是两种守法：
    // 那条防"加了类型忘了登记"，这条防"登记逻辑本身把未知当成支持"。
    assert.equal(waitNeedsExternalAdapter({ type: 'someFuturePredicate' }), 'someFuturePredicate');
    assert.equal(waitNeedsExternalAdapter(VALID_PREDICATE.expr), undefined);
    assert.equal(waitNeedsExternalAdapter(VALID_PREDICATE.dbRow), 'dbRow');
    // 深层嵌套也要看见（顶层 allOf 全合法而第三层是 refuse）
    assert.equal(
      waitNeedsExternalAdapter({ allOf: [{ anyOf: [{ type: 'expr', expr: '1' }, { noneOf: [VALID_PREDICATE.newPage] }] }] }),
      'newPage', '嵌在两层的 noneOf 里面的 newPage 必须被看见',
    );
  });

  test('每条 LOAD_* 规则都有出处（LINT_DOCS）', async () => {
    const { LINT_DOCS } = await import('../src/lint.js');
    for (const code of ['LOAD_STEP_UNSUPPORTED', 'LOAD_STEP_DEGRADED', 'LOAD_RETRY_IGNORED', 'LOAD_NO_PRESS_STEP', 'LOAD_NOT_CONCURRENCY_SAFE', 'LOAD_SHORT_RUN'] as const) {
      assert.ok(LINT_DOCS[code], `${code} 没有文档出处`);
    }
  });
});

const SAMPLE_STEP_ID = 'sample';

/**
 * 给一个 kind 造一份**能过 schema** 的夹具（id 一律 `sample`）。
 *
 * 这份表**只列得有意义的成员**，而 `kind` 的覆盖完整性由下面那条
 * `kind 表与 LOAD_STEP_SUPPORT 覆盖对撞` 的测试钉住：新增 kind 而这里没加夹具，
 * 红的就是那条（不是"for 循环少跑一格"这种静默空转）。
 *
 * 为什么每个 kind 都得有一份合法夹具（而不是 `{...b('bad'), kind}` 一把梭）：
 * 假夹具会带着 schema 报错进 lint，那条 LOAD 断言就变成在验 zod 而不是验闸 ——
 * 本文件第一版的 6 次红全是这一族。
 */
const SAMPLE_STEP: Record<string, Draft> = {
  // press
  http: { ...b(SAMPLE_STEP_ID), kind: 'http', request: { method: 'GET', url: '/orders' } },
  openapiCall: { ...b(SAMPLE_STEP_ID), kind: 'openapiCall', docRef: 'doc.yaml', operationId: 'listOrders' },
  // flow
  sequence: { ...b(SAMPLE_STEP_ID), kind: 'sequence', steps: [pressStep('p2'), assertStep('a2')] },
  if: { ...b(SAMPLE_STEP_ID), kind: 'if', condition: '1', then: [pressStep('p3'), assertStep('a3')], else: [] },
  switch: { ...b(SAMPLE_STEP_ID), kind: 'switch', value: '$mode', cases: [{ is: 'a', steps: [pressStep('p4'), assertStep('a4')] }], default: [] },
  forEach: { ...b(SAMPLE_STEP_ID), kind: 'forEach', items: '$rows', as: 'r', steps: [pressStep('p5'), assertStep('a5')] },
  while: { ...b(SAMPLE_STEP_ID), kind: 'while', condition: '1', maxIterations: 3, steps: [pressStep('p7')] },
  repeat: { ...b(SAMPLE_STEP_ID), kind: 'repeat', times: 2, steps: [pressStep('p6'), assertStep('a6')] },
  parallel: { ...b(SAMPLE_STEP_ID), kind: 'parallel', steps: [pressStep('p8')] },
  set: { ...b(SAMPLE_STEP_ID), kind: 'set', assign: { k: 1 } },
  extract: { ...b(SAMPLE_STEP_ID), kind: 'extract', from: '$.step.q.resp', rules: [{ var: 'v', path: '$.id' }] },
  table: { ...b(SAMPLE_STEP_ID), kind: 'table', rows: [{ a: 1 }], as: 'rows' },
  dataSource: { ...b(SAMPLE_STEP_ID), kind: 'dataSource', source: { type: 'file', path: 'd.json' } },
  script: { ...b(SAMPLE_STEP_ID), kind: 'script', lang: 'ts', code: 'return 1' },
  call: { ...b(SAMPLE_STEP_ID), kind: 'call', scenarioRef: 'scn.child' },
  log: { ...b(SAMPLE_STEP_ID), kind: 'log', level: 'info', message: 'hi' },
  fail: { ...b(SAMPLE_STEP_ID), kind: 'fail', reason: 'x' },
  noop: { ...b(SAMPLE_STEP_ID), kind: 'noop' },
  sleep: { ...b(SAMPLE_STEP_ID), kind: 'sleep', ms: 10 },
  assert: assertStep(SAMPLE_STEP_ID),
  assertLlm: { ...b(SAMPLE_STEP_ID), kind: 'assertLlm', question: '页面是否显示成功？', evidenceFrom: '$.step.q.resp' },
  assertPerf: { ...b(SAMPLE_STEP_ID), kind: 'assertPerf', against: '$.step.q.resp', lte: 500 },
  assertPage: { ...b(SAMPLE_STEP_ID), kind: 'assertPage', assertKind: 'visible', target: '下单成功' },
  assertUi: { ...b(SAMPLE_STEP_ID), kind: 'assertUi', assertKind: 'visible', target: '下单成功' },
  db: { ...b(SAMPLE_STEP_ID), kind: 'db', sql: 'select 1', datasource: 'd' },
  // once
  wait: waitStep(SAMPLE_STEP_ID, VALID_PREDICATE.expr),
  // refuse：Web / 设备
  navigate: { ...b(SAMPLE_STEP_ID), kind: 'navigate', url: 'http://x/' },
  act: { ...b(SAMPLE_STEP_ID), kind: 'act', locator: LOC, action: 'click' },
  capture: { ...b(SAMPLE_STEP_ID), kind: 'capture', mode: 'screenshot' },
  device: { ...b(SAMPLE_STEP_ID), kind: 'device', target: 'android' },
  app: { ...b(SAMPLE_STEP_ID), kind: 'app', action: 'launch', package: 'com.x' },
  tap: { ...b(SAMPLE_STEP_ID), kind: 'tap', target: LOC },
  input: { ...b(SAMPLE_STEP_ID), kind: 'input', value: 'abc' },
  swipe: { ...b(SAMPLE_STEP_ID), kind: 'swipe', from: [1, 1], to: [1, 9] },
  key: { ...b(SAMPLE_STEP_ID), kind: 'key', key: 'enter' },
  watcher: { ...b(SAMPLE_STEP_ID), kind: 'watcher', rules: [{ match: { text: '允许' }, action: 'dismiss' }] },
  logcat: { ...b(SAMPLE_STEP_ID), kind: 'logcat', filter: 'x' },
  useIdentity: { ...b(SAMPLE_STEP_ID), kind: 'useIdentity', identity: 'admin' },
  manualHandoff: { ...b(SAMPLE_STEP_ID), kind: 'manualHandoff', reason: '需要人工过验证码' },
};

/**
 * kind 覆盖对撞：`LOAD_STEP_SUPPORT` 与 `SAMPLE_STEP` 的键集必须一模一样。
 *
 * 上面那些遍历测试全是 `for (const [kind] of Object.entries(LOAD_STEP_SUPPORT))`，
 * 而它们对"夹具缺失"的处理方式决定这一切是否成立：
 * refuse 档缺夹具 = **那格静默不验**（方向 2 是 `assert.ok(findOf(...))`，
 * 少了夹具就少一次调用，测试仍然全绿）。所以缺夹具必须由一条**独立的对撞**
 * 变成红的，而不是靠遍历里的 `if (!sample) continue` 混过去。
 * （wait 那份夹具用 `SAMPLE_STEP_ID`，与 pressBody 的 `q` 不冲突。）
 */
describe('夹具表与判据表的键集对撞', () => {
  test('SAMPLE_STEP 覆盖 LOAD_STEP_SUPPORT 的每一个 kind，且不多不少', () => {
    const supported = Object.keys(LOAD_STEP_SUPPORT).sort();
    const sampled = Object.keys(SAMPLE_STEP).sort();
    const missing = supported.filter((k) => !sampled.includes(k));
    const extra = sampled.filter((k) => !supported.includes(k));
    assert.deepEqual(missing, [], `这些 kind 在表里而夹具表没有（对应遍历测试正在空转）：${missing.join(', ')}`);
    assert.deepEqual(extra, [], `夹具表里有而判据表没有的 kind（kind 被改名了？）：${extra.join(', ')}`);
  });

  test('夹具表不为空（空表会让上面两条一起变成恒真）', () => {
    assert.ok(Object.keys(SAMPLE_STEP).length >= 30, `夹具表只剩 ${Object.keys(SAMPLE_STEP).length} 个 kind`);
  });
});

/** 让 TS 知道本文件也用得上 Scenario / Step 类型（避免"导入了没用"的假信号） */
export type _Used = Scenario | Step;
