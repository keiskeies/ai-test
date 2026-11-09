/**
 * 引用语言（JSONPath + 表达式）与等待语义。
 *
 * 这两块是 IR 的「语法层」，出问题时用户的感受是「我明明写对了却报错」，
 * 所以这里的用例大多是**边界与报错文案**，不只是正常路径。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  query, queryOne, parsePath, parseRef, setPath, PathError,
  compileExpr, evalBool, validateExpr,
  checkShape, evalMatch, lintScenario,
} from '../src/index.js';
import { parseScenario } from '@atest/ir';
import { b, scen, run, res } from './helpers.js';

describe('JSONPath 子集', () => {
  test('取值 / 通配 / 递归 / 引号键 / 未命中', () => {
    const data = { data: { list: [{ id: 1 }, { id: 2 }], 'odd-key': 'v' } };
    assert.equal(queryOne(data, '$.data.list[1].id'), 2);
    assert.deepEqual(query(data, '$.data.list[*].id').values, [1, 2]);
    assert.equal(queryOne(data, '$.data["odd-key"]'), 'v');
    assert.deepEqual(query(data, '$..id').values, [1, 2]);
    assert.equal(queryOne(data, '$.nope.deep'), undefined);
  });

  test('$name 与 $.name 等价（与表达式同一套引用语言）', () => {
    const d = { a: { b: 1 } };
    assert.deepEqual(parsePath('$a.b'), parsePath('$.a.b'));
    assert.equal(queryOne(d, '$a.b'), 1);
  });

  test('多命中默认报错，不静默取第一个（静默取第一个 = 偶发错断言）', () => {
    assert.throws(() => queryOne({ a: [{ b: 1 }, { b: 2 }] }, '$.a[*].b'), /命中 2 个值/);
    assert.equal(queryOne({ a: [{ b: 1 }, { b: 2 }] }, '$.a[*].b', { allowAmbiguous: true }), 1);
  });

  test('拒绝切片与过滤语法（通用库的任意表达式是静态分析的敌人）', () => {
    assert.throws(() => parsePath('$.a[1:3]'), PathError);
    assert.throws(() => parsePath('$.a[?(@.x>1)]'), /不支持的下标/);
    assert.throws(() => parsePath('a.b'), /\$/);
    assert.throws(() => parsePath('$..'), /键名/);
  });

  test('parseRef 解出来源（UI 的 VarChip 与来源审计靠它）', () => {
    assert.deepEqual(parseRef('$.step.mk.resp.data.id'), { scope: 'step', stepId: 'mk', rest: '.resp.data.id' });
    assert.equal(parseRef('$.run.inputs.sku').scope, 'run');
    assert.equal(parseRef('$.env.baseUrl').scope, 'env');
    assert.equal(parseRef('$.secret.db_pwd').scope, 'secret');
    assert.equal(parseRef('$loopItem').scope, undefined);
  });

  test('setPath 支持深层写入与数组下标', () => {
    const o: Record<string, unknown> = {};
    setPath(o, '$.a.b[0].c', 7);
    assert.deepEqual(o, { a: { b: [{ c: 7 }] } });
  });
});

describe('表达式引擎', () => {
  const ctx = { root: {}, vars: { n: 5, list: [1, 2, 3], name: 'Tom', user: { age: 30 } } };

  test('算术与优先级', () => {
    assert.equal(compileExpr('1 + 2 * 3').eval(ctx), 7);
    assert.equal(compileExpr('(1 + 2) * 3').eval(ctx), 9);
    assert.equal(compileExpr('7 % 4').eval(ctx), 3);
    assert.equal(compileExpr('-3 + 1').eval(ctx), -2);
  });

  test('比较、逻辑、字符串', () => {
    assert.equal(compileExpr('$n > 3 and $n < 10').eval(ctx), true);
    assert.equal(compileExpr('$n > 3 && $n > 100').eval(ctx), false);
    assert.equal(compileExpr('not (1 == 2)').eval(ctx), true);
    assert.equal(compileExpr('$name + "!"').eval(ctx), 'Tom!');
    assert.equal(compileExpr('"a" in ["a", "b"]').eval(ctx), true);
    assert.equal(compileExpr('$name == "Tom"').eval(ctx), true);
    assert.equal(compileExpr('$name != "Tom"').eval(ctx), false);
  });

  test('函数库覆盖聚合与判空', () => {
    assert.equal(compileExpr('count($list)').eval(ctx), 3);
    assert.equal(compileExpr('sum($list)').eval(ctx), 6);
    assert.equal(compileExpr('avg($list)').eval(ctx), 2);
    assert.equal(compileExpr('min($list)').eval(ctx), 1);
    assert.equal(compileExpr('max($list)').eval(ctx), 3);
    assert.equal(compileExpr('upper($name)').eval(ctx), 'TOM');
    assert.equal(compileExpr('len($name)').eval(ctx), 3);
  });

  test('点号路径进对象', () => {
    assert.equal(compileExpr('$user.age').eval(ctx), 30);
    assert.equal(compileExpr('$.user.age').eval(ctx), 30);
  });

  test('短路：右值有错也不求值', () => {
    assert.equal(evalBool('false and ($nope.x > 1)', ctx), false);
    assert.equal(evalBool('true or ($nope.x > 1)', ctx), true);
  });

  test('语法错误在编译期给出人话（这份文案直接喂给 Agent 的 repair 重试）', () => {
    assert.match(validateExpr('1 +') ?? '', /意外|期望|操作数/);
    assert.match(validateExpr('(1 < 2') ?? '', /\)/);
    assert.match(validateExpr('lenght($name)') ?? '', /未知函数/, '拼错函数名必须在静态校验就报出来');
    assert.equal(validateExpr('$a.b == 1'), null, '合法表达式必须返回 null，不能返回空串之外的东西');
  });

  test('编译一次执行多次；refs 静态可查（压测预编译的前提，docs/09 §4.2）', () => {
    const c = compileExpr('$a + $b');
    assert.deepEqual([...c.refs].sort(), ['$a', '$b']);
    assert.equal(c.pure, true, '纯表达式才可预编译');
    assert.equal(c.eval({ root: { a: 1, b: 2 } }), 3);
    assert.equal(c.eval({ root: { a: 10, b: 2 } }), 12, '同一编译产物换上下文');
    assert.equal(compileExpr('now()').pure, false, 'now() 不纯：冻结时钟时必须知道');
  });

  test('同一表达式复用编译缓存（返回同一对象）', () => {
    assert.equal(compileExpr('$x == 1'), compileExpr('$x == 1'));
  });
});

describe('Match 子句与 shape', () => {
  const m = (o: object) => o as Parameters<typeof evalMatch>[1];

  test('每个子句失败都给出具体原因（不是笼统的「断言失败」）', () => {
    assert.equal(evalMatch(5, m({ eq: 5 }), true, () => 0).ok, true);
    assert.match(evalMatch(5, m({ eq: 6 }), true, () => 0).why ?? '', /6/);
    assert.match(evalMatch('x', m({ type: 'number' }), true, () => 0).why ?? '', /number/);
    assert.match(evalMatch([1], m({ minLength: 3 }), true, () => 0).why ?? '', /3|最小/);
    assert.match(evalMatch(null, m({ notNull: true }), true, () => 0).why ?? '', /空|null/);
    assert.match(evalMatch('abc', m({ matches: '^\\d+$' }), true, () => 0).why ?? '', /正则|匹配/);
    assert.match(evalMatch(undefined, m({ eq: 1 }), false, () => 0).why ?? '', /未命中/);
  });

  test('模糊 vs 精确：exact 是显式 opt-in（lint 靠它抓过拟合）', () => {
    assert.equal(evalMatch('Order created OK', m({ contains: 'created' }), true, () => 0).ok, true);
    assert.equal(evalMatch('Order created OK', m({ exact: 'Order created OK' }), true, () => 0).ok, true);
    assert.equal(evalMatch('Order created OK!', m({ exact: 'Order created OK' }), true, () => 0).ok, false);
  });

  test('shape 判定表', () => {
    const cases: [string, unknown, boolean][] = [
      ['uuid', '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b', true],
      ['uuid', 'ORD-1', false],
      ['snowflake', '1234567890123456789', true],
      ['datetime', '2026-01-02T03:04:05Z', true],
      ['datetime', '昨天', false],
      ['phone-cn', '13800000000', true],
      ['phone-cn', '23800000000', false],
      ['idcard-cn', '110101199003071234', true],
    ];
    for (const [shape, v, want] of cases) {
      const r = checkShape(v, shape);
      assert.equal(r.ok, want, `shape=${shape} v=${String(v)}`);
      if (!r.ok) assert.ok(r.why, '不通过时必须说明为什么');
    }
  });

  test('nearNow 用注入的时间源，不读墙上时间（否则冻结时钟后仍会漂移）', () => {
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    // 冻结在 t：应当通过
    assert.equal(evalMatch(t, m({ nearNow: { withinMs: 1000 } }), true, () => t).ok, true);
    // 冻结在一年后：同一条断言必须失败。若实现偷读 Date.now()，这两次结果会一样
    assert.equal(evalMatch(t, m({ nearNow: { withinMs: 1000 } }), true, () => t + 31_536_000_000).ok, false);
  });

  test('shape 未知时明确报错，不是静默通过', () => {
    const r = checkShape('x', 'not-a-real-shape');
    assert.equal(r.ok, false);
    assert.match(r.why ?? '', /shape|未知/);
  });
});

describe('等待：条件而非时长（docs/02 §3）', () => {
  test('条件已满足 → 零延时', async () => {
    const r = await run(scen([
      { ...b('x'), kind: 'set', assign: { ready: true } },
      { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: '$ready' }, timeoutMs: 5000, pollMs: 100, onTimeout: 'fail' },
    ]));
    assert.equal(res(r, 'w').status, 'pass');
    assert.equal(res(r, 'w').keyContext.waitedMs, 0, '冻结时钟下已满足就一步都不等');
  });

  test('永不满足 → 等满 timeout 后按 onTimeout 处理', async () => {
    const r = await run(scen([
      { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: 'false' }, timeoutMs: 600, pollMs: 100, onTimeout: 'fail' },
    ]));
    assert.equal(res(r, 'w').status, 'fail');
    assert.match(res(r, 'w').assertionSummary ?? '', /等待超时/);
    assert.equal(res(r, 'w').keyContext.waitedMs, 600, '既不睡过超时点，也不能提前放弃');
  });

  test('onTimeout=continue 是显式选择（默认 fail）', async () => {
    const r = await run(scen([
      { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: 'false' }, timeoutMs: 200, pollMs: 100, onTimeout: 'continue' },
      { ...b('after'), kind: 'noop' },
    ]));
    assert.equal(res(r, 'w').status, 'pass');
    assert.match(res(r, 'w').assertionSummary ?? '', /continue/);
    assert.equal(res(r, 'after').status, 'pass');
  });

  test('条件求值报错立即返回，不伪装成超时（最难查的一类 flake）', async () => {
    const r = await run(scen([
      { ...b('w'), kind: 'wait', condition: { type: 'dbRow', sql: 'SELECT 1', datasource: 'default', expect: 'row' }, timeoutMs: 50_000, pollMs: 100, onTimeout: 'fail' },
    ]));
    assert.equal(res(r, 'w').status, 'fail');
    assert.match(res(r, 'w').assertionSummary ?? '', /求值报错/, '要明说是配置错了，不是「还没好」');
    assert.ok((res(r, 'w').keyContext.waitedMs as number) < 1000, '没有 db adapter 应立刻返回，而不是干等 50 秒');
  });

  test('复合条件 allOf / anyOf / noneOf', async () => {
    const ok = await run(scen([
      { ...b('x'), kind: 'set', assign: { a: true, b: false } },
      { ...b('w'), kind: 'wait', timeoutMs: 1000, pollMs: 50, onTimeout: 'fail',
        condition: { allOf: [{ type: 'expr', expr: '$a' }, { anyOf: [{ type: 'expr', expr: '$b' }, { type: 'expr', expr: '1 == 1' }] }, { noneOf: [{ type: 'expr', expr: '$b' }] }] } },
    ]));
    assert.equal(res(ok, 'w').status, 'pass');
    const bad = await run(scen([
      { ...b('w'), kind: 'wait', timeoutMs: 100, pollMs: 50, onTimeout: 'fail', condition: { noneOf: [{ type: 'expr', expr: '1 == 1' }] } },
    ]));
    assert.equal(res(bad, 'w').status, 'fail');
  });

  test('dbRow 条件走注入的 db adapter（引擎不碰网络）', async () => {
    let sql = '';
    const r = await run(scen([
      { ...b('w'), kind: 'wait', timeoutMs: 2000, pollMs: 50, onTimeout: 'fail',
        condition: { type: 'dbRow', sql: 'SELECT * FROM orders WHERE id = 1', datasource: 'main', expect: 'row' } },
    ]), { adapters: { db: { async query(ds, q) { sql = `${ds}:${q}`; return [{ id: 1 }]; } } } });
    assert.equal(res(r, 'w').status, 'pass');
    assert.match(sql, /main:SELECT/);
  });

  test('httpStatus 条件复用已导出的响应', async () => {
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { resp: { status: 201 } } },
      { ...b('w'), kind: 'wait', condition: { type: 'httpStatus', ref: '$.step.mk.resp', in: [200, 201] }, timeoutMs: 500, pollMs: 50, onTimeout: 'fail' },
    ]));
    assert.equal(res(r, 'w').status, 'pass');
  });

  test('想写 wait{duration:3000} 会被 IR 直接拒绝（等待必须是条件）', () => {
    const r = parseScenario({
      schemaVersion: '1', id: 't', name: 't', env: { environmentRef: 'u' }, targets: ['api'],
      body: [{ id: 'w', kind: 'wait', duration: 3000, condition: { type: 'expr', expr: 'true' }, timeoutMs: 1000, pollMs: 100, onTimeout: 'fail' }],
    });
    assert.equal(r.ok, false, 'schema 是 strict 的，duration 这个字段根本不该存在');
    assert.ok(r.errors.some((e) => e.message.includes('duration')), `错误要点名 duration：${JSON.stringify(r.errors)}`);
  });

  test('干等只能用 sleep，且它被 lint 警告', async () => {
    const s = scen([{ ...b('s'), kind: 'sleep', ms: 10 }]);
    assert.ok(lintScenario(s).some((i) => i.code === 'SLEEP_USED'));
    const r = await run(s);
    assert.equal(r.durMs, 10, '冻结时钟：sleep 只推进逻辑时间');
  });
});
