/**
 * 值的四种形态（字面量 / 引用 / 表达式 / 生成器）**边界**。
 *
 * ## 这一组测试钉的是什么
 *
 * `docs/14` §5 记着一条老账："引用写错键名会静默变成字面量"。它难写测试的地方在于
 * **失效方向是"看起来没事"**：schema 收下（`ValueSchema` 含 `LiteralSchema`，
 * 而它的 `record(string, Literal)` 让任何 JSON 对象都是合法字面量）、步骤判 pass、
 * 生成器返回 undefined、变量是空的。所以要钉的不是"报错文案对不对"，而是
 * **三种"不该静默"的写法不再静默**，以及**四种"该照字面量走"的写法仍照字面量走**。
 *
 * ## 判据一律落在"存下来的到底是什么"上
 *
 * 这一点是本轮踩坑换来的：一开始我用 `notNull` 判，结果 `{gen:'widget',size:'L'}`
 * 在**改动前的坏代码**上也能过 —— 因为坏代码把那个对象按字面量存下了，非空自然成立。
 * 所以现在业务对象那几条判的是**字段还在不在**（`$.size` 等于 `'L'`），
 * 空变量那几条判的是**这一步必须 error**。用能被缺陷证伪的判据，而不是
 * "改前改后都绿"的判据（那种测试只是装饰）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isValueForm, GEN_KINDS } from '@atest/ir';
import { resolveValue, generate, GenKindError, VarError, deterministicClock, VarSpace, type ValueScope } from '../src/index.js';
import { b, run, scen, type StepDraft } from './helpers.js';

const scope = (): ValueScope => ({ vars: new VarSpace({}), clock: deterministicClock(42) });

/** 一步 set + 一步对变量做断言，跑完取这两步的结论 */
async function assignAndProbe(assign: Record<string, unknown>, probe: StepDraft) {
  const r = await run(scen([{ ...b('g'), kind: 'set', assign }, probe]));
  return { g: r.results.find((x) => x.stepId === 'g')!, n: r.results.find((x) => x.stepId === 'n') };
}

describe('形态判据 isValueForm（运行时与 lint 共用同一份）', () => {
  test('单键的三种保留键各认成对应形态', () => {
    assert.equal(isValueForm({ path: '$.a' }), 'ref');
    assert.equal(isValueForm({ expr: '1+1' }), 'expr');
    assert.equal(isValueForm({ gen: 'uuid' }), 'gen');
  });
  test('{gen, with} 是**两个键**但仍是生成器 —— 这条就是 gen 那一支不能照抄 keys===1 的原因', () => {
    assert.equal(isValueForm({ gen: 'int', with: { min: 1, max: 9 } }), 'gen');
  });
  test('多一个键的业务对象不算形态（{path,…} / {gen,…} 都是字面量）', () => {
    // 业务字段恰好叫 gen / path 是合法写法。改动前 `{gen:'widget', size:'L'}`
    // 会被 gen 分支整个吞掉 —— 业务对象连 size 都没了
    assert.equal(isValueForm({ gen: 'widget', size: 'L' }), undefined);
    assert.equal(isValueForm({ path: 'src/a.ts', lang: 'ts' }), undefined);
    assert.equal(isValueForm({ expr: '1+1', x: 1 }), undefined);
  });
  test('with 之外的第二个键不许把 {gen} 认成生成器（with 拼错不再被当成生成器）', () => {
    assert.equal(isValueForm({ gen: 'int', widh: { min: 1 } }), undefined);
  });
  test('保留键的值不是字符串时是字面量对象（与 schema 同口径）', () => {
    assert.equal(isValueForm({ path: 123 }), undefined);
    assert.equal(isValueForm({}), undefined);
    assert.equal(isValueForm(['a']), undefined);
    assert.equal(isValueForm(null), undefined);
  });
  test('种类拼错**仍认成 gen 形态**（种类合法性由 generate 判，这里不重复一份清单）', () => {
    // 若这里也判一份种类清单，就成了 GEN_KINDS 的第二份手抄 —— 正是这张表要消灭的东西
    assert.equal(isValueForm({ gen: 'uuidd' }), 'gen');
  });
});

describe('生成器种类：拼错要响，不许返回 undefined', () => {
  /** 改动前是 `default: return undefined`，于是步骤判 pass 而变量是空的 */
  const BAD_KINDS = ['uuidd', 'uuid ', 'UUId', 'intt', 'widget', ''];
  for (const kind of BAD_KINDS) {
    test(`种类 "${kind}" 抛 GenKindError（而不是返回 undefined）`, () => {
      assert.throws(
        () => generate(kind, {}, deterministicClock(42)),
        (e: unknown) => e instanceof GenKindError && e.kind === kind,
      );
    });
  }
  test('报错句子读得通、且列出的种类就是 schema 会收下的那些', () => {
    // 先前这里得到的是 `未知生成器种类 "uuidd"（变量：gen（可用：…））` ——
    // VarError 的后缀把**键名**当成了变量名，一句自己都读不通的报错
    const e = (() => { try { generate('uuidd', {}, deterministicClock(42)); return undefined; } catch (x) { return x as Error; } })();
    assert.ok(e);
    assert.equal(e!.message, `未知生成器种类 "uuidd"。可用：${GEN_KINDS.join(' / ')}（区分大小写、不许带空格）`);
    assert.ok(!e!.message.includes('变量：'), `报错不该出现"变量："这个后缀：${e!.message}`);
    // 清单与 schema enum 同源，所以不会出现"叫作者用一个 parse 阶段不认的种类"
    for (const k of GEN_KINDS) assert.ok(e!.message.includes(k), `清单里少了 ${k}`);
  });
  test('GenKindError 是 VarError 的子类 —— 两条执行路径靠这条归因', () => {
    // 不再是 VarError 的话，解释器会把它落到 env-unavailable、预编译那条落到 throw，
    // 同一个错在两种执行形态下归因不同（本仓那一族"挪个位置换行为"的老坑）
    assert.ok(new GenKindError('uuidd') instanceof VarError);
  });
  test('全部合法种类仍各自产得出值（防 switch 漏 case）', () => {
    for (const kind of GEN_KINDS) {
      const w = kind === 'oneOf' ? { values: ['x'] } : {};
      assert.notEqual(generate(kind, w, deterministicClock(42)), undefined, `${kind} 没返回值`);
    }
  });
});

describe('端到端：写错的三种不再静默', () => {
  test('{gen:"uuidd"} -> 这一步 error，归因是用例自己的问题而不是环境问题', async () => {
    const { g } = await assignAndProbe({ row: { gen: 'uuidd' } }, { ...b('n'), kind: 'noop' });
    assert.equal(g.status, 'error');
    // cause 必须是 case-stale。落到 env-unavailable 的话，值班人会去查一个不存在的环境问题，
    // 而 CI 的提示语还会叫它"标 error 重试一次"（白重试）
    assert.equal(g.cause, 'case-stale');
    assert.match(g.assertionSummary ?? '', /未知生成器种类/);
  });
  test('种类拼错时，下游断言不会再被拿到（错误在这一步就停住）', async () => {
    const { n } = await assignAndProbe(
      { row: { gen: 'uuidd' } },
      { ...b('n'), kind: 'assert', against: '$row', jsonPath: { $: { notNull: true } } },
    );
    // 改动前这里是 set=pass + 断言 fail"$: 期望非空，实际为空" ——
    // 那句读起来像"被测系统返回了空数据"，排查方向就此指到被测系统那边去
    assert.equal(n, undefined, '出错之后不该继续跑下游步骤');
  });
  test('{gen:"widget"}（种类压根不存在）也响', async () => {
    const { g } = await assignAndProbe({ row: { gen: 'widget' } }, { ...b('n'), kind: 'noop' });
    assert.equal(g.status, 'error');
  });
});

describe('业务对象恰好用了保留键名时，仍整个按字面量存下', () => {
  test('业务对象 {gen:"widget", size:"L"} 原样存下，字段一个不少', async () => {
    const { g, n } = await assignAndProbe(
      { row: { gen: 'widget', size: 'L' } },
      // 判据**不能**是 notNull：改动前那个坏代码也是非空的（它把整个对象按字面量存下了）。
      // 判字段还在不在，才能区分"业务对象完整存下"与"被 gen 分支吞成空值"
      { ...b('n'), kind: 'assert', against: '$row', jsonPath: { '$.size': { exact: 'L' }, '$.gen': { exact: 'widget' } } },
    );
    assert.equal(g.status, 'pass');
    assert.equal(n!.status, 'pass', `断言本该通过，实际：${n!.assertionSummary ?? '(无摘要)'}`);
  });
  test('业务对象 {path:"src/a.ts", lang:"ts"} 不被当成引用', async () => {
    const { g, n } = await assignAndProbe(
      { row: { path: 'src/a.ts', lang: 'ts' } },
      { ...b('n'), kind: 'assert', against: '$row', jsonPath: { '$.lang': { exact: 'ts' } } },
    );
    assert.equal(g.status, 'pass');
    assert.equal(n!.status, 'pass', `断言本该通过，实际：${n!.assertionSummary ?? '(无摘要)'}`);
  });
  test('嵌套位置也走同一判据（数组里的业务对象）', () => {
    assert.deepEqual(
      resolveValue({ list: [{ gen: 'widget', size: 'L' }] }, scope()),
      { list: [{ gen: 'widget', size: 'L' }] },
    );
  });
});

describe('合法形态没被新判据误伤', () => {
  test('合法生成器 {gen:"int", with:{min:7,max:7}} 仍是生成器', async () => {
    const { g, n } = await assignAndProbe(
      { row: { gen: 'int', with: { min: 7, max: 7 } } },
      { ...b('n'), kind: 'assert', against: '$row', jsonPath: { $: { eq: 7 } } },
    );
    assert.equal(g.status, 'pass');
    assert.equal(n!.status, 'pass', `断言本该通过，实际：${n!.assertionSummary ?? '(无摘要)'}`);
  });
  test('合法引用 {path:"$.step.s"} 仍生效', async () => {
    const r = await run(scen([
      { ...b('s'), kind: 'set', assign: { src: '真值' } },
      { ...b('g'), kind: 'set', assign: { row: { path: '$.step.s.src' } } },
      { ...b('n'), kind: 'assert', against: '$row', jsonPath: { $: { exact: '真值' } } },
    ]));
    assert.equal(r.results.find((x) => x.stepId === 'n')!.status, 'pass');
  });
});

describe('两种执行形态同语义（功能回归 ⇄ 预编译压测）', () => {
  test('种类拼错在两条路径上都是 error，且摘要一字不差', async () => {
    const s = scen([{ ...b('g'), kind: 'set', assign: { row: { gen: 'uuidd' } } }]);
    const functional = await run(s);
    const f = functional.results.find((x) => x.stepId === 'g')!;
    assert.equal(f.status, 'error');
    // 预编译那条：executor.ts 按 instanceof VarError 归 error，摘要走同一条 errSummary。
    // 注意读的是 steps[0].error —— 这条路径的摘要在**步骤**上，整体 outcome 只有 status
    // （两个形态的结果类型本来不同：RunReport 用 assertionSummary，ExecOutcome 用 error。
    // 这里刻意把两边的**文案**放在一起比，因为"同一个错在两种形态下说法不同"
    // 会让看板与 CI 提示语只对上一边）
    const { compilePlan, precompiledExecutor } = await import('../src/index.js');
    const c = await precompiledExecutor(compilePlan(s)).run({ scenario: s, clock: deterministicClock(42) });
    assert.equal(c.status, 'error');
    assert.equal(c.steps.find((x) => x.stepId === 'g')?.error, f.assertionSummary);
  });
});

describe('回归护栏：请求体等其它 resolveValue 消费点同判据', () => {
  test('请求体里的业务对象原样发出，业务字段不被形态判据吞掉', async () => {
    // resolveValue 是**所有**值位置的唯一求值入口（headers/query/body/rows/sql vars/args），
    // 所以判据改动的影响面远不止 set 步骤。这里挑最典型的那一处验一遍：
    // 业务请求体里恰好有个键叫 gen 的对象，必须原样出现在发出去的 body 里。
    let sent: unknown;
    const adapters = {
      http: {
        async send(req: { body: unknown }) {
          sent = req.body;
          return { status: 200, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 1 };
        },
      },
    } as never;
    const r = await run(
      scen([{ ...b('h'), kind: 'http', request: { method: 'POST', url: 'http://x/a', body: { payload: { gen: 'widget', size: 'L' } } } }]),
      { adapters },
    );
    assert.equal(r.results.find((x) => x.stepId === 'h')!.status, 'pass');
    assert.deepEqual(sent, { payload: { gen: 'widget', size: 'L' } });
  });
  test('请求体里真写错种类时也是 error，不会把 undefined 发出去', async () => {
    let sent: unknown = '从没发过';
    const adapters = {
      http: {
        async send(req: { body: unknown }) {
          sent = req.body;
          return { status: 200, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 1 };
        },
      },
    } as never;
    const r = await run(
      scen([{ ...b('h'), kind: 'http', request: { method: 'POST', url: 'http://x/a', body: { token: { gen: 'uuidd' } } } }]),
      { adapters },
    );
    assert.equal(r.results.find((x) => x.stepId === 'h')!.status, 'error');
    // 这条是"发出去之前就该停住"的护栏：改动前它会带着一个 undefined 字段真发出去，
    // 被测系统收到什么完全 unpredictable，而平台上看到的是 pass
    assert.equal(sent, '从没发过', '求值失败的请求不该发出');
  });
});
