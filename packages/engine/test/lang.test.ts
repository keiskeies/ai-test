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
import { canonicalScenario, parseScenario } from '@atest/ir';
import { b, loc, scen, run, res } from './helpers.js';
import type { AdapterRegistry } from '../src/index.js';

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
    /*
     * **pass 的那一行也要留下"它其实等满了"的证据。**
     *
     * 三条超时分支里 continue 那一支从前是唯一不带 keyContext 的，
     * 而"这轮过了"被当成"没什么可记的"。后果不在这一行，在**聚合那一层**：
     * 看板问"这一场有多少等待其实是等满超时后被放过的"，靠 `keyContext.waitedMs` 数，
     * 于是那个统计**恰好漏掉全部被容忍的超时** —— 报出来像"几乎没有超时"。
     * 这是 docs/08 §3 那一族（少一件东西看起来像什么都没少）在**统计口径**上的形状，
     * 而且它只会往好的方向偏，所以没人会怀疑它。
     *
     * 断言写成"与 fail 那一支同形"而不是"等于 200"：这里要钉的是
     * **三支共用一个形状**，具体数值由上面那条 fail 的测试守（它断 waitedMs === 600）。
     */
    assert.equal(res(r, 'w').keyContext?.waitedMs, 200,
      'continue 那一支也要带 waitedMs，否则"被容忍的超时"在看板上恒为 0');
    assert.ok(typeof res(r, 'w').keyContext?.condition === 'string' && res(r, 'w').keyContext!.condition !== '',
      '等什么也要带上，与 fail/error 两支同形（三支持有的字段必须一致，否则聚合要按分支写）');
  });

  test('条件求值报错立即返回，不伪装成超时（最难查的一类 flake）', async () => {
    /*
     * 这一条**改前断言的是 fail**，而 fail 正是它自己要反对的那件事：
     * fail 的语义是"被测产品答错了"，而这里被测产品压根没被问过一句话。
     * 现在缺 adapter 的那四种条件在 wait.ts 里升级成 NoConditionAdapter 外抛，
     * 落到 runStep 的 error 分支（"去查平台/用例"），不再由 onTimeout 决定形状。
     *
     * 夹具用"db 在场但那条 SQL 被拒"而不是"压根没有 db"：后者现在走外抛那条路
     *（下面两条测试专门守它），这一条要守的是**通用的求值报错**那一路 ——
     * 真实场景就是 SQL 里有个没绑定的 `$` 占位（docs/15 §3.2）。
     */
    const r = await run(scen([
      { ...b('w'), kind: 'wait', condition: { type: 'dbRow', sql: 'SELECT * FROM o WHERE id = $oid', datasource: 'default', expect: 'row' }, timeoutMs: 50_000, pollMs: 100, onTimeout: 'fail' },
    ]), { adapters: { db: { async query() { throw new Error('syntax error near "$oid"'); } } } });
    const w = res(r, 'w');
    assert.equal(w.status, 'error', `实际 ${w.status} / ${(w.assertionSummary ?? '').slice(0, 90)}`);
    assert.match(w.assertionSummary ?? '', /syntax error/, '要把数据库那句原话交出去');
    assert.ok((w.keyContext?.waitedMs as number) < 1000, '报错应立刻返回，而不是干等 50 秒');
  });

  test('缺 adapter 的等待说"没接线"，绝不说"等待超时"（四种条件逐个）', async () => {
    /*
     * 四种条件、四处判定点，**逐个跑**而不是抽一个代表：
     * 这四行在 wait.ts 里是四个不相邻的 `if`，改前全是裸 Error，
     * 于是全被"求值报错也继续等"那句收成一次普通超时。抽一个代表的话，
     * 漏掉的那三种可以悄悄写回 `throw new Error(...)` —— 而它们各自的
     * `??` 选择器还不一样（`ui ?? device` / `device ?? ui` / `ui ?? device`），
     * 恰好是"抄三遍然后其中一遍不一样"的那个形状。
     *
     * **先证它跑到了那一步**（断言摘要里点得出条件名）：
     * 只断言 `status === 'error'` 的话，一条压根没进 evalCondition 的
     * 坏 IR 也能过 —— 本仓那种"空断言"第三次出现的形状。
     */
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ['dbRow', { type: 'dbRow', sql: 'SELECT 1', datasource: 'main', expect: 'row' }, ['db']],
      ['uiPredicate', { type: 'uiPredicate', state: 'visible', target: loc() }, ['ui', 'device']],
      ['template', { type: 'template', expect: 'hit', minConfidence: 0.8, target: loc() }, ['ui', 'device']],
      ['uiIdle', { type: 'uiIdle', quietMs: 10 }, ['ui', 'device']],
    ];
    for (const [type, condition, slots] of cases) {
      const r = await run(scen([
        { ...b('w'), kind: 'wait', condition: condition as never, timeoutMs: 30_000, pollMs: 100, onTimeout: 'fail' },
      ]));
      const w = res(r, 'w');
      assert.equal(w.status, 'error', `${type}: 实际 ${w.status} / ${(w.assertionSummary ?? '').slice(0, 90)}`);
      assert.equal(w.cause, 'env-unavailable', `${type}: 归因要是"环境缺失"，不是产品 bug`);
      assert.match(w.assertionSummary ?? '', new RegExp(type), `${type}: 摘要没点出自己的条件名，可能压根没跑到那一步`);
      assert.match(w.assertionSummary ?? '', /adapters\./, `${type}: 要说出缺的是哪个 adapter 槽位，否则人只能猜`);
      /*
       * 槽位清单**逐个条件各自断言**，而且断的是数组本身（顺序也断）：
       * 这是给看板分组用的那一份，摘要里的中文不是判据（文案本仓改过很多次）。
       *
       * **这一组数组本轮改过一次向**，而改它之前先要说清原来那句话说了什么：
       * 原注释写的是"顺序 = 代码里 `??` 的顺序，template 那一条是 ['device','ui']
       * 而另两条相反 —— 两处的意图本来就不同（模板匹配优先在设备端做）"。
       * 那句"意图"从来**没有实现**，而且实现不了：`template` 走的是 `resolve()`
       * 而不是某个像素专用口，所以那一档"优先设备"换来的不是"在设备上跑模板匹配"，
       * 是"**去问另一个世界的界面树**"。两个槽位都在场时它真的会这么做
       * （**改前实测**：`.scratch/probe-which.mts`；永久形态是
       *  `wait-world.test.ts` 里「template 不再"优先设备"」那条），而这正是本轮修掉的东西。
       *
       * 原注释还预测了今天：「那一天的改动需要有人在测试里改一个数组，
       * 也就是需要有人想过这件事」。现在就是那一天 —— 三个数组现在同序，
       * 而"同序"不是随手对齐：它是"三处走同一个判据 `resolveWaitWorld`"的**结果**，
       * 那个判据由 `wait-world.test.ts` 那 15 条盯着。
       * 断顺序这件事本身**保留**：将来真要给某个条件加一档优先，
       * 仍然需要有人在测试里改一个数组。
       */
      assert.deepEqual(w.keyContext?.missingAdapters, slots, `${type}: 缺的槽位清单`);
      assert.equal(w.keyContext?.waitCondition, type, `${type}: 条件类型要单独可得，别只嵌在文案里`);
      assert.ok(!/等待超时/.test(w.assertionSummary ?? ''),
        `${type}: 不能出现"等待超时" —— 那会把一次都没查成说成等了一会儿没等到`);
      assert.ok(!/30000/.test(w.assertionSummary ?? ''),
        `${type}: 更不该把 30s 这个超时值印出来（那是"配了多久"，不是"发生了什么"）`);
      /*
       * **不许套"求值报错／一次都没求成"那个框**，这条不是抠文案，是抠下一步动作：
       * 那两句话的主语是"你的条件文本"（SQL 写错了、表达式不合法），
       * 而这里主语是"你的场景没有这个槽位"。人被指向前者会去改 IR 里那句 SQL，
       * 改一百遍也没用 —— 该加的是 adapter，或者换一个 targets。
       * 这也是 `NoConditionAdapter` 要**外抛**而不是留在 catch 里的全部理由：
       * 留着它也能拿到 error + env-unavailable，但那句话会被包进错误的框里。
       */
      assert.ok(!/求值报错|一次都没求成/.test(w.assertionSummary ?? ''),
        `${type}: 没接线不该说成求值报错。实际 ${(w.assertionSummary ?? '').slice(0, 120)}`);
      assert.equal(w.keyContext?.evalError, undefined,
        `${type}: evalError 的既定含义是"中止于一次求值异常"；缺槽位压根没走到求值那一步，别混进同一本账`);
    }
  });

  test('槽位**在场而那个口没有**：仍然说"没接线"，不许退回超时（三种界面条件逐个）', async () => {
    /*
     * 与上一条**不是重复**，而是它漏掉的那一半 —— 而且这一半是我自己写漏的：
     * 上一条的夹具是"压根没有 ui/device"，那条路今天由 `resolveWaitWorld` 拦下；
     * 而 `if (!('resolve' in a))` 这三行要的是**另一种现场**：槽位在场，
     * 只是这一个口没有。上一条跑不到这三行，所以把这三行改成裸 `Error`
     * **全仓没有任何测试变红**（变异集 wait-not-wired 的 W3/W4/W5 第一轮就是这么活的）。
     *
     * 为什么这个现场值得单独测，而不是当成"顺手覆盖到"：
     * 它是真实可达的 —— `capabilities()` 那一天、或者有人写一个只读快照的
     * 观察型 adapter 时，槽位就在场而 `resolve` 不在。到那时这三行是唯一的闸。
     *
     * 判据与上一条同一组（error + env-unavailable + 不出现"等待超时"），
     * 因为坏法的表现也同一组：裸 Error 落到兜底 `untriaged`，
     * 随即被 `waitUntil` 那句"求值报错也再等一轮"收成一次普通超时 + product-bug。
     */
    const cases: Array<[string, Record<string, unknown>]> = [
      ['uiPredicate', { type: 'uiPredicate', state: 'visible', target: loc() }],
      ['template', { type: 'template', expect: 'hit', minConfidence: 0.8, target: loc() }],
      ['uiIdle', { type: 'uiIdle', quietMs: 10 }],
    ];
    for (const [type, condition] of cases) {
      // 一个"只有 snapshot 没有 resolve"的槽位（uiIdle 反过来用只有 resolve 的那个），
      // 目的是让**选择器成功而口缺失** —— 两个都用同一种空对象的话，
      // uiIdle 那一支会在同一个地方挂掉而看不出它判的是 snapshot 口。
      const slot = type === 'uiIdle'
        ? { async resolve() { return { resolvedBy: 'css', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; } }
        : { async snapshot() { return { kind: 'aria', data: '', sha: 'x' }; } };
      const r = await run(scen([
        { ...b('w'), kind: 'wait', condition: condition as never, timeoutMs: 30_000, pollMs: 100, onTimeout: 'fail' },
      ]), { adapters: { ui: slot as never } });
      const w = res(r, 'w');
      assert.equal(w.status, 'error', `${type}: 实际 ${w.status} / ${(w.assertionSummary ?? '').slice(0, 90)}`);
      assert.equal(w.cause, 'env-unavailable', `${type}: 归因是"环境缺这个口"，不是产品 bug`);
      assert.match(w.assertionSummary ?? '', new RegExp(type), `${type}: 摘要没点出自己的条件名，可能压根没跑到那一步`);
      assert.ok(!/等待超时/.test(w.assertionSummary ?? ''),
        `${type}: 不许被"再等一轮"收成超时 —— 那会把"这个口没有"说成"等了一会儿没等到"`);
      /*
       * `missingAdapters` 仍然是 `['ui','device']` 那一档的清单，
       * 而**这里刻意不断言它是别的**：那句报错此刻写着"没有 ui adapter"，
       * 措辞不准（槽位在场，只是这一个口没有），而 `wait.ts` 里明写了
       * **刻意不拆成第二个错名**（两条路的下一步是同一句话：去看接线）。
       * 所以这一条钉的是"别退回超时"，不是"措辞要精确到这个口"。
       */
      assert.deepEqual(w.keyContext?.missingAdapters, ['ui', 'device'], `${type}: 缺的槽位清单`);
      assert.equal(w.keyContext?.waitCondition, type, `${type}: 条件类型要单独可得`);
    }
  });

  test('onTimeout=continue 不能把"一次都没查成"洗成 pass（改前整场 pass）', async () => {
    /*
     * 本仓目前最贵的一个假绿，实测在 `.scratch/probe-dbrow4.mts`：
     *   onTimeout=fail → fail；continue → **pass**；error → error；整场结论 **pass**。
     * 也就是"一个没有任何 db adapter 的 wait{dbRow}"，整场报绿、退出码 0，
     * 而它一次数据库查询都没发出去过。
     *
     * 界线：**onTimeout 管的是"等不到怎么办"，不是"没法等怎么办"**。
     * 前者是产品事实（作者可以容忍，继续往下走），后者是平台事实
     *（往下走只会让后面每一步都建立在一个没验证的前置上）。
     * 作者写下 continue 时，从没被问过"连条件都跑不起来也要继续吗"。
     *
     * 两个来源各一条（缺 adapter 外抛 / 求值报错带 evalError），因为它们
     * 汇合的是**同一个结论**（不产出 pass），而代码路径是两条不同的支路。
     */
    const bodies: Array<[string, AdapterRegistry]> = [
      ['缺 db adapter', {}],
      ['db 在但 SQL 被拒', { db: { async query() { throw new Error('syntax error near "$oid"'); } } }],
    ];
    for (const [what, adapters] of bodies) {
      const r = await run(scen([
        { ...b('w'), kind: 'wait', condition: { type: 'dbRow', sql: 'SELECT 1', datasource: 'main', expect: 'row' }, timeoutMs: 30_000, pollMs: 100, onTimeout: 'continue' },
        { ...b('after'), kind: 'noop' },
      ]), { adapters });
      const w = res(r, 'w');
      assert.notEqual(w.status, 'pass', `${what}: continue 不该把没跑成变成通过`);
      assert.equal(w.status, 'error', `${what}: 实际 ${w.status} / ${(w.assertionSummary ?? '').slice(0, 90)}`);
      assert.equal(r.status, 'error', `${what}: 整场结论不能是 ${r.status}`);
    }
  });

  test('等待条件里引用未定义 => case-stale，与 db 步/extract 同一归因', async () => {
    /*
     * 这一条守的是**cause 的一致性**，不是 status —— 两种写法改前都是 error，
     * 只有归因不同：同一个"引用了一个没有输出的步骤"的用例错误，
     * 写在 wait 条件里报 env-unavailable（"去查平台"），写在 db 步的 vars 里
     * 报 case-stale（"用例本身写错了"）。实测 `.scratch/probe-varref.mts`。
     *
     * env-unavailable 不只是难听：CI_HINT 教 CI 对 error **重试一次**，
     * 而一个不存在的引用不会因为重试而出现。更要紧的是看板按 cause 分组，
     * 这一类会被记进"环境问题"那一堆，于是真正的环境问题被稀释掉。
     *
     * 做法是 wait.ts 把 VarError **原样外抛**，让解释器 catch 里那一句
     * `VarError -> case-stale` 定归因（这条契约写在 resolve.ts 顶部）。
     * 不在这里现推归因：同一件事两处各写一份判据，就是本仓反复记账的那个形状。
     */
    const r = await run(scen([
      { ...b('w'), kind: 'wait', condition: { type: 'httpStatus', ref: '$.step.nope.resp', in: [200] }, timeoutMs: 3000, pollMs: 100, onTimeout: 'fail' },
    ]));
    const w = res(r, 'w');
    assert.equal(w.status, 'error');
    assert.equal(w.cause, 'case-stale', `实际 ${w.cause} —— 引用写错是用例问题，不是环境问题`);
    assert.ok((w.keyContext?.waitedMs as number | undefined) === undefined || (w.keyContext.waitedMs as number) < 1000,
      '引用不存在不会因为多等几轮而出现，不该干等');
    // 对照组：同一个未定义引用走 extract，归因必须一致
    const c = await run(scen([
      { ...b('e'), kind: 'extract', from: '$.step.nope.resp', rules: [{ mode: 'jsonpath', path: '$.a', var: 'x', required: true }] },
    ]));
    assert.equal(res(c, 'e').cause, w.cause, '同一个用例错误在两条路径上必须同一个归因');
  });

  test('真·超时与"第 1 轮就中止"必须在报告上分得开（同一个字段两种真相）', async () => {
    /*
     * 这一条是 evalError 那个字段的**存在理由**，而且它测的不是文案是**形状**：
     * 两条路都 `satisfied: false`，都得给出一个 waitedMs，改前解释器只看这一个
     * 布尔量，于是 waitedMs=0 / polls=1 那次也印「等待超时（2000ms）」。
     *
     * 所以两边都断言 **waitedMs 与轮询次数**，不只断言摘要文本 ——
     * 摘要文案本仓常改（`等待超时` 这个词就改过好几次），而
     * "等满了"与"一轮都没等"这两个数是不会改的判据。
     */
    const timed = await run(scen([
      { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: 'false' }, timeoutMs: 600, pollMs: 100, onTimeout: 'fail' },
    ]));
    const tw = res(timed, 'w');
    assert.equal(tw.status, 'fail');
    assert.equal(tw.keyContext.waitedMs, 600, '真超时应当等满');
    assert.match(tw.assertionSummary ?? '', /等待超时/, '真超时当然要说超时');

    // 同一超时值、同样等满，但条件是 dbRow 且 db 在场而 SQL 被拒 => 走 evalError 那一支
    const blew = await run(scen([
      { ...b('w'), kind: 'wait', condition: { type: 'dbRow', sql: 'SELECT $oid', datasource: 'main', expect: 'row' }, timeoutMs: 600, pollMs: 100, onTimeout: 'fail' },
    ]), { adapters: { db: { async query() { throw new Error('syntax error near $oid'); } } } });
    const bw = res(blew, 'w');
    assert.equal(bw.status, 'error');
    assert.ok((bw.keyContext.waitedMs as number) < 600, '一次都没等成，不该记成等满');
    assert.equal(bw.keyContext.polls, 1, '第 1 轮就中止，polls 必须是 1');
    assert.match(bw.keyContext.evalError as string, /syntax error near \$oid/, '原始报错要原样在 keyContext 里，别只活在摘要里');
    assert.ok(!/等待超时/.test(bw.assertionSummary ?? ''), `实际 ${(bw.assertionSummary ?? '').slice(0, 120)}`);
    assert.match(bw.assertionSummary ?? '', /syntax error near \$oid/, '值班人要能直接看见那句数据库的话');
  });

  test('求值报错时 onTimeout=fail 也不再产出 fail + 空转的 hint（三条 onTimeout 各自归因）', async () => {
    for (const onTimeout of ['fail', 'continue', 'error'] as const) {
      const r = await run(scen([
        { ...b('w'), kind: 'wait', condition: { type: 'dbRow', sql: 'SELECT 1', datasource: 'main', expect: 'row' }, timeoutMs: 5_000, pollMs: 100, onTimeout },
      ]));
      const w = res(r, 'w');
      assert.equal(w.status, 'error', `onTimeout=${onTimeout} 应当都是 error（这一次跑不起来，onTimeout 无从置喙）`);
      assert.equal(w.cause, 'env-unavailable', `onTimeout=${onTimeout}`);
    }
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

  test('dbRow.vars 真的绑上去（IR 注释承诺过的那件事）', async () => {
    /*
     * docs/15 §3.2。改前这个字段**压根不存在**，而 sql 的注释写着
     * 「$var 占位由引擎绑定」—— 那句话描述了一件没有任何实现做过的事。
     * 照着写的人拿到的是：数据库拒绝那条 SQL，错被等待循环收成"这一轮还没满足"，
     * 最后端出一句「等待超时」。
     *
     * 断言的是**adapter 收到的那张表**，不是步摘要 —— 摘要是 pass 也说明不了
     * 绑定值对（它只说明"查到行了"，而 stub 可以无视 SQL 返回行）。
     */
    /*
     * 类型跟 DbExec 端口一致（`vars: Record<string, unknown>`）而不是引擎内部那份
     * `Record<string, string>`：测试断的是 **adapter 实际收到的那张表**，按端口形状接，
     * 才不会把「端口以后放宽了」这种事遮在一次类型转换里。（下面几条同形状的夹具同此。）
     */
    let got: Record<string, unknown> | undefined;
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { oid: 'A-7' } },
      { ...b('w'), kind: 'wait', timeoutMs: 2000, pollMs: 50, onTimeout: 'fail',
        condition: { type: 'dbRow', sql: 'SELECT 1 WHERE id = $oid', datasource: 'main',
          vars: { oid: { path: '$oid' }, flag: { expr: '1 + 1' } } } },
    ]), { adapters: { db: { async query(_ds, _sql, v) { got = v; return [{ id: 1 }]; } } } });
    assert.equal(res(r, 'w').status, 'pass');
    // {path} 与 {expr} 两种值形态都要到（不是"只有字面量能传"）
    assert.deepEqual(got, { oid: 'A-7', flag: '2' }, `实际 ${JSON.stringify(got)}`);
  });

  test('绑定值为 null/undefined 时不落键，而不是落成字符串 "null"', async () => {
    /*
     * 这条与 `db` 步共用 strMap，所以它守的是**三处**调用点。
     * 落成 `'null'` 的话，`WHERE x = 'null'` 是一条合法的、永远查不到行的查询 ——
     * 症状是"条件永不满足"，与本轮刚修掉的假超时只差一个引号。
     */
    let got: Record<string, unknown> | undefined;
    await run(scen([
      { ...b('mk'), kind: 'set', assign: { nothing: null } },
      { ...b('w'), kind: 'wait', timeoutMs: 500, pollMs: 50, onTimeout: 'continue',
        condition: { type: 'dbRow', sql: 'SELECT 1', vars: { keep: 'yes', drop: { path: '$nothing' } } } },
    ]), { adapters: { db: { async query(_ds, _sql, v) { got = v; return []; } } } });
    assert.deepEqual(got, { keep: 'yes' }, `实际 ${JSON.stringify(got)}`);
  });

  test('一次等待从头到尾问的是同一个问题：{gen} 不每轮换一个值', async () => {
    /*
     * 这一条守的是 onceSqlVars 那个"每条条件只求值一次"的缓存，
     * 而它**不是优化，是判据**。没有缓存的话，一次 400ms / pollMs=50 的等待
     * 会拿五个不同的 uuid 去查数据库，而摘要说「数据库出现匹配行（default）」——
     * 它从没查过最后那一个。作者写 `{gen: uuid}` 想要的显然是
     * "查我刚下单生成的那个订单号"，不是"随便查五个订单号，命中任何一个都算过"。
     *
     * 判据能成立的前提是 uuid 真的每次不同（`resolve.ts` 里它走 rnd()，
     * 每调一次推进一步随机态）。所以**先断言轮询确实发生了多次**：
     * 只跑一轮的话"值都相同"是空断言 —— 本仓那个"空断言"形状第四次出现的机会，
     * 靠这一句堵住。
     */
    const seen: string[] = [];
    const r = await run(scen([
      { ...b('w'), kind: 'wait', timeoutMs: 400, pollMs: 50, onTimeout: 'continue',
        condition: { type: 'dbRow', sql: 'SELECT 1', vars: { k: { gen: 'uuid' } } } },
    ]), { adapters: { db: { async query(_ds, _sql, v) { seen.push(String(v.k)); return []; } } } });
    /*
     * 前提用 **adapter 被调了几次** 来断，而不是 keyContext.polls：
     * 前者是"确实查了这么多次"的直接证据（引擎说几轮不算数，adapter 收到几次才算），
     * 也免得为了让测试好写而给报告添字段。
     */
    assert.ok(seen.length >= 3, `这条测试的前提是多轮轮询，实际查了 ${seen.length} 次（前提不成立时下面那句是空断言）`);
    assert.equal(new Set(seen).size, 1, `绑定值在一条等待里必须恒定，实际有 ${new Set(seen).size} 个：${seen.join(' / ')}`);
  });

  test('一棵 allOf 树里的两个 dbRow 各用各的绑定（不共用一份）', async () => {
    /*
     * 缓存的键是**条件对象本身**，不是类型名。按类型名缓存的话，
     * 后求值的那个条件会拿到先头那个的绑定值 —— 两条 SQL 都查得到东西，
     * 但查的都是同一个参数，症状是"两个条件明明各写各的却行为一致"。
     */
    const got: Array<Record<string, unknown>> = [];
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { a: 'AAA', b: 'BBB' } },
      { ...b('w'), kind: 'wait', timeoutMs: 500, pollMs: 50, onTimeout: 'fail',
        condition: { allOf: [
          { type: 'dbRow', sql: 'SELECT 1', vars: { p: { path: '$a' } } },
          { type: 'dbRow', sql: 'SELECT 2', vars: { p: { path: '$b' } } },
        ] } },
    ]), { adapters: { db: { async query(_ds, _sql, v) { got.push(v); return [{ x: 1 }]; } } } });
    assert.equal(res(r, 'w').status, 'pass');
    assert.deepEqual(got, [{ p: 'AAA' }, { p: 'BBB' }], `实际 ${JSON.stringify(got)}`);
  });

  test('dataSource 的 mysql.source.vars 也绑（同一处缺陷的第三个调用点）', async () => {
    /*
     * §3.2 列的三个 `db.query` 调用点里，这是第二个漏网的。
     * 它的害法与 wait 那个不同：dataSource 是**数据驱动的入口**，
     * SQL 十有八九要带条件，拿不到绑定的话作者只有两条路 ——
     * 查全表再在 forEach 里筛（把过滤逻辑挪进用例），或自己拼字符串
     *（把一条只读查询变成任意读取）。后者才是真正不能留的那条。
     */
    let got: Record<string, unknown> | undefined;
    const r = await run(scen([
      { ...b('mk'), kind: 'set', assign: { tag: 'p0' } },
      { ...b('ds'), kind: 'dataSource',
        source: { type: 'mysql', sql: 'SELECT * FROM t WHERE tag = ?', datasource: 'main', vars: { tag: { path: '$tag' } } } },
    ]), { adapters: { db: { async query(_ds, _sql, v) { got = v; return [{ id: 1 }]; } } } });
    assert.equal(res(r, 'ds').status, 'pass');
    assert.deepEqual(got, { tag: 'p0' }, `实际 ${JSON.stringify(got)}`);
  });

  test('绑定值里的引用不存在 => case-stale，且不干等（不等满超时）', async () => {
    const r = await run(scen([
      { ...b('w'), kind: 'wait', timeoutMs: 30_000, pollMs: 100, onTimeout: 'fail',
        condition: { type: 'dbRow', sql: 'SELECT 1', vars: { oid: { path: '$nope' } } } },
    ]), { adapters: { db: { async query() { return []; } } } });
    const w = res(r, 'w');
    assert.equal(w.status, 'error');
    assert.equal(w.cause, 'case-stale', '引用拼错是用例问题。三处 db.query 与等待条件必须同一个归因');
    assert.ok((w.keyContext?.waitedMs as number | undefined) === undefined || (w.keyContext.waitedMs as number) < 1000,
      '一个不存在的引用不会因为多等几轮而出现');
  });

  test('不写 vars 的既有场景：canonicalScenario 逐字节不变（这是修 bug 不是磁盘迁移）', () => {
    /*
     * `vars` 取 `.optional()` 而不是 `.default({})`，靠的是量出来的差别：
     * default 会把 zod 补出来的空对象**物化**进规范串，让每一个已有 dbRow 场景
     * 的 irSha 都变（历史版本指纹全部作废、证据指向查不到的哈希）；
     * optional 在不写时不落键，因为 stable() 会丢 undefined。
     *
     * 这条测试**钉住那个选择**：以后有人"顺手"把它改成 .default({}) 图省事
     *（少一个 undefined 分支、少一个 `?? {}`），这条会当场红，
     * 而那时候需要有人先想过"版本表里那些指纹怎么办"。
     */
    const s = scen([
      { ...b('w'), kind: 'wait', timeoutMs: 1000, pollMs: 50, onTimeout: 'fail',
        condition: { type: 'dbRow', sql: 'SELECT 1', datasource: 'main', expect: 'row' } },
    ]);
    const cond = canonicalScenario(s);
    assert.ok(!/vars/.test(cond), `省略 vars 时规范串里不该出现这个键：${cond.slice(0, 200)}`);
    // 写了就该出现（否则上一句是"字段压根没进 schema"那种空断言）
    const s2 = scen([
      { ...b('w'), kind: 'wait', timeoutMs: 1000, pollMs: 50, onTimeout: 'fail',
        condition: { type: 'dbRow', sql: 'SELECT 1', datasource: 'main', expect: 'row', vars: { a: 'x' } } },
    ]);
    assert.match(canonicalScenario(s2), /"vars":\{"a":"x"\}/);
    assert.notEqual(canonicalScenario(s), canonicalScenario(s2), '写与不写必须是两个不同的 irSha');
  });

  test('dataSource 省略 vars 时规范串同样逐字节不变（第二个哈希现场）', () => {
    /*
     * 与上一条同性质，**分开写而不是抽一个循环**：这两个字段的哈希中性
     * 是两个独立的磁盘决定 —— 一个场景可以只有 dataSource 没有 dbRow，
     * 反过来也是。合成一条的话，改坏其中一个而测试夹具恰好带另一个字段时，
     * 那条测试会因为它自己的形状而绿。
     *
     * 这条是补 B7 那个 survived 的：变异集跑出"dataSource.vars 改 .default({})
     * 无人红"之后才发现我只给 dbRow 那条写了钉住的测试，
     * dataSource 那一处只在注释里断言了同样的性质 ——
     * **注释里的断言不算断言**（它不会红，而人会相信它）。
     */
    const bare = scen([{ ...b('ds'), kind: 'dataSource', source: { type: 'mysql', sql: 'SELECT 1', datasource: 'main' } }]);
    assert.ok(!/vars/.test(canonicalScenario(bare)),
      '省略 vars 时规范串不该出现这个键');
    const withVars = scen([{ ...b('ds'), kind: 'dataSource', source: { type: 'mysql', sql: 'SELECT 1', datasource: 'main', vars: { t: 'p0' } } }]);
    assert.match(canonicalScenario(withVars), /"vars":\{"t":"p0"\}/,
      '写了就该落进去（否则上一句是"字段压根没进 schema"那种空断言）');
    assert.notEqual(canonicalScenario(bare), canonicalScenario(withVars));
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
