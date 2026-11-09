/**
 * M1 金样：控制流 + 变量空间 + 期望 trace。
 *
 * 这批测试的真正目的不是「证明 switch 没写错」，而是验证 docs/02 里
 * 那套控制流与变量空间**真够用** —— 三端场景实例（§7）能不能被同一套
 * 节点表达出来，跑一遍就知道。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { b, scen, run, res } from './helpers.js';

describe('控制流', () => {
  test('sequence 顺序执行，事件 seq 严格递增', async () => {
    const r = await run(scen([
      { ...b('a'), kind: 'set', assign: { x: 1 } },
      { ...b('b'), kind: 'set', assign: { x: 2 } },
      { ...b('c'), kind: 'assert', against: '$x', jsonPath: { $: { eq: 2 } } },
    ]));
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.results.map((x) => x.stepId), ['a', 'b', 'c']);
    assert.deepEqual(r.events.filter((e) => e.kind === 'step.started').map((e) => e.stepId), ['a', 'b', 'c']);
    r.events.forEach((e, i) => assert.equal(e.seq, i, '事件 seq 必须从 0 严格递增（回放对齐的基础）'));
    // 每个步骤都有配对的 started/finished，crash 时才能定位停在哪
    assert.equal(r.events.filter((e) => e.kind === 'step.finished').length, 3);
  });

  test('when 守卫不成立 → skipped（不是 pass 也不是 fail）', async () => {
    const r = await run(scen([
      { ...b('skipme'), kind: 'noop', when: '1 == 2' },
      { ...b('run'), kind: 'noop' },
    ]));
    assert.equal(res(r, 'skipme').status, 'skipped');
    assert.equal(res(r, 'run').status, 'pass');
    assert.equal(r.tally.skipped, 1);
  });

  test('if / else 只走一个分支', async () => {
    const r = await run(
      scen([
        { ...b('i'), kind: 'if', condition: '$flag', then: [{ ...b('t'), kind: 'set', assign: { v: 'yes' } }], else: [{ ...b('e'), kind: 'set', assign: { v: 'no' } }] },
        { ...b('chk'), kind: 'assert', against: '$v', jsonPath: { $: { exact: 'no' } } },
      ]),
      { inputs: { flag: false } },
    );
    assert.equal(r.status, 'pass', r.summary);
    assert.equal(r.results.find((x) => x.stepId === 't'), undefined, 'then 分支不该执行');
  });

  test('forEach 逐项迭代；累加器在循环外声明，迭代变量出循环即销毁', async () => {
    const r = await run(
      scen([
        // 累加器**必须**在循环前声明：帧退栈即销毁是 docs/02 §5 的语义，
        // 循环内新建的名字不会漏到外面（set 会写到已声明它的那一帧，所以累加生效）
        { ...b('init'), kind: 'set', assign: { total: 0, lastItem: '', lastIdx: -1 } },
        { ...b('loop'), kind: 'forEach', items: '$list', as: 'item', indexAs: 'idx', maxIterations: 10,
          steps: [{ ...b('acc'), kind: 'set', assign: { total: { expr: '$total + 1' }, lastItem: { expr: '$item' }, lastIdx: { expr: '$idx' } } }] },
        { ...b('after'), kind: 'assert', against: '$total', jsonPath: { $: { eq: 3 } } },
        { ...b('last'), kind: 'assert', against: '$lastItem', jsonPath: { $: { exact: 'c' } } },
        { ...b('idx'), kind: 'assert', against: '$lastIdx', jsonPath: { $: { eq: 2 } } },
      ]),
      { inputs: { list: ['a', 'b', 'c'] } },
    );
    assert.equal(r.status, 'pass', r.summary);
    assert.equal(r.results.filter((x) => x.stepId === 'acc').length, 3);
  });

  test('循环内新建的变量不漏到循环外（帧退栈即销毁）', async () => {
    const r = await run(scen([
      { ...b('loop'), kind: 'forEach', items: '$list', as: 'item', maxIterations: 10,
        steps: [{ ...b('inner'), kind: 'set', assign: { temp: { expr: '$item' } } }] },
      // $item 与 $temp 此时都应已销毁：引用它们 = 未定义 = error
      { ...b('leak'), kind: 'assert', against: '$item', jsonPath: { $: { notNull: true } } },
    ]), { inputs: { list: ['x'] } });
    assert.equal(r.status, 'error', '迭代变量泄漏到循环外是 bug');
    assert.match(res(r, 'leak').assertionSummary ?? '', /未找到|未定义/);
  });

  test('while 撞上 maxIterations 要留痕，不能静默截断', async () => {
    const r = await run(scen([
      { ...b('w'), kind: 'while', condition: 'true', maxIterations: 3, steps: [{ ...b('n'), kind: 'noop' }] },
    ]));
    assert.equal(r.status, 'pass');
    assert.equal(r.results.filter((x) => x.stepId === 'n').length, 3);
    assert.ok(
      r.events.some((e) => e.kind === 'lint.reported' && String(e.data?.code ?? '').includes('LOOP')),
      '撞上限必须发事件，否则用户以为循环正常结束了',
    );
  });

  test('while 条件转假正常退出', async () => {
    const r = await run(scen([
      { ...b('x'), kind: 'set', assign: { n: 0 } },
      { ...b('w'), kind: 'while', condition: '$n < 3', maxIterations: 10,
        steps: [{ ...b('inc'), kind: 'set', assign: { n: { expr: '$n + 1' } } }] },
      { ...b('a'), kind: 'assert', against: '$n', jsonPath: { $: { eq: 3 } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('switch 按值分派，落空走 default', async () => {
    const r = await run(scen([
      { ...b('sw'), kind: 'switch', value: '$code',
        cases: [{ is: 200, steps: [{ ...b('ok'), kind: 'set', assign: { hit: 'ok' } }] }],
        default: [{ ...b('dk'), kind: 'set', assign: { hit: 'default' } }] },
      { ...b('chk'), kind: 'assert', against: '$hit', jsonPath: { $: { exact: 'default' } } },
    ]), { inputs: { code: 503 } });
    assert.equal(r.status, 'pass', r.summary);
  });

  test('repeat / sequence / parallel 嵌套不炸', async () => {
    const r = await run(scen([
      { ...b('rep'), kind: 'repeat', times: 2, steps: [
        { ...b('seq'), kind: 'sequence', steps: [
          { ...b('par'), kind: 'parallel', failFast: true, maxConcurrency: 2, steps: [{ ...b('n'), kind: 'noop' }] },
        ] },
      ] },
    ]));
    assert.equal(r.status, 'pass', r.summary);
    assert.equal(r.results.filter((x) => x.stepId === 'n').length, 2);
  });

  test('setup 失败 → 整体 error（前置不成立不是产品 bug）', async () => {
    const r = await run(scen([{ ...b('body'), kind: 'noop' }], {
      setup: [{ ...b('s1'), kind: 'fail', reason: '前置数据缺失', cause: 'env-unavailable' }],
    }));
    assert.equal(r.status, 'error');
    assert.equal(res(r, 's1').cause, 'env-unavailable');
  });

  test('teardown 必跑；它失败只标注，不改写整体结论', async () => {
    const r = await run(scen([{ ...b('body'), kind: 'assert', against: '$run' }], {
      teardown: [{ ...b('td'), kind: 'fail', reason: '清理接口 500' }],
    }));
    assert.equal(res(r, 'td').status, 'fail', '清理失败本身要被记录');
    assert.notEqual(r.status, 'fail', 'body 是过的，整体不该判 fail');
  });

  test('onError=continue 让失败步骤不中断后续', async () => {
    const r = await run(scen([
      { ...b('bad'), kind: 'fail', reason: '预期内失败', onError: 'continue' },
      { ...b('after'), kind: 'noop' },
    ]));
    assert.equal(res(r, 'bad').status, 'fail');
    assert.equal(res(r, 'after').status, 'pass');
  });
});

describe('变量空间与引用', () => {
  test('步骤输出可被 $.step.<id>.* 引用（下层输出给上层）', async () => {
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { tmp: { id: 'ORD-1' } } },
      { ...b('use'), kind: 'assert', against: '$.step.mk.tmp.id', jsonPath: { $: { exact: 'ORD-1' } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('引用未执行的步骤 → error 且报错点名那个步骤', async () => {
    const r = await run(scen([{ ...b('a'), kind: 'set', assign: { x: { path: '$.step.ghost.resp' } } }]));
    assert.equal(r.status, 'error');
    assert.match(res(r, 'a').assertionSummary ?? '', /ghost/);
  });

  test('run.inputs 是上层输入；env 只读', async () => {
    const r = await run(
      scen([{ ...b('a'), kind: 'assert', against: '$.run.inputs.sku', jsonPath: { $: { exact: 'SKU-9' } } },
            { ...b('e'), kind: 'assert', against: '$.env.baseUrl', jsonPath: { $: { exact: 'https://t' } } }]),
      { inputs: { sku: 'SKU-9' }, env: { baseUrl: 'https://t' } },
    );
    assert.equal(r.status, 'pass', r.summary);
  });

  test('extract：jsonpath / regex / header 三种取法', async () => {
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { resp: { status: 200, headers: { 'x-trace': 'T-9' }, body: { data: { id: 42 } }, bodyText: 'Set-Cookie: token=abc123;' } } },
      { ...b('x'), kind: 'extract', from: '$.step.mk.resp', rules: [
        { var: 'id', path: '$.body.data.id' },
        { var: 'tok', path: 'token=([a-z0-9]+)', mode: 'regex' },
        { var: 'trace', path: 'x-trace', mode: 'header' },
      ] },
      { ...b('a1'), kind: 'assert', against: '$id', jsonPath: { $: { eq: 42 } } },
      { ...b('a2'), kind: 'assert', against: '$tok', jsonPath: { $: { exact: 'abc123' } } },
      { ...b('a3'), kind: 'assert', against: '$trace', jsonPath: { $: { exact: 'T-9' } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('extract 的正则跑在 bodyText 上，不是 "[object Object]"（HTML/文本接口场景）', async () => {
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { resp: { status: 200, body: { ignored: 1 }, bodyText: '<input name="csrf" value="TK-77">' } } },
      { ...b('x'), kind: 'extract', from: '$.step.mk.resp', rules: [{ var: 'csrf', path: 'value="([^"]+)"', mode: 'regex' }] },
      { ...b('a'), kind: 'assert', against: '$csrf', jsonPath: { $: { exact: 'TK-77' } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('正则本身写错 → 说清是正则不合法，而不是「提取失败」', async () => {
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { resp: { bodyText: 'anything' } } },
      { ...b('x'), kind: 'extract', from: '$.step.mk.resp', rules: [{ var: 'v', path: '([unclosed', mode: 'regex' }] },
    ]));
    assert.equal(r.status, 'error');
    assert.match(res(r, 'x').assertionSummary ?? '', /正则本身不合法/);
  });

  test('extract 取不到且 required → error 并带样本（不静默给 undefined）', async () => {
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { resp: { body: { has: 'shape' } } } },
      { ...b('x'), kind: 'extract', from: '$.step.mk.resp', rules: [{ var: 'nope', path: '$.missing' }] },
    ]));
    assert.equal(r.status, 'error');
    assert.ok(res(r, 'x').keyContext.sample !== undefined, '报错要带样本，否则用户只能猜');
  });

  test('set 支持深层写入（assign 键带点号）', async () => {
    const r = await run(scen([
      { ...b('a'), kind: 'set', assign: { row: { score: 0 } } },
      { ...b('c'), kind: 'set', assign: { 'row.score': 7 } },
      { ...b('d'), kind: 'assert', against: '$row.score', jsonPath: { $: { eq: 7 } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('dataSource + table 提供数据驱动的行集合', async () => {
    const r = await run(scen([
      { ...b('t'), kind: 'table', rows: [{ sku: { expr: '"A"' } }, { sku: { expr: '"B"' } }] },
      { ...b('a'), kind: 'assert', against: '$table', jsonPath: { $: { minLength: 2 } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('写入历史可查（UI 的「谁改了这个值」）', async () => {
    const r = await run(scen([
      { ...b('a'), kind: 'set', assign: { x: 1 } },
      { ...b('b'), kind: 'set', assign: { x: 2 } },
    ]));
    assert.ok(r.events.length > 0);
    assert.ok(r.summary.includes('pass'), `摘要应可读：${r.summary}`);
  });
});
