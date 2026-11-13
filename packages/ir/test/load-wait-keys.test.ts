/**
 * `LOAD_WAIT_SUPPORT` 的键集与 schema 现取的谓词清单对撞。
 *
 * ## 这一格为什么必须有一根独立的钉子（而不是靠 engine 那边那套遍历）
 *
 * `engine/test/load-lint.test.ts` 会遍历 `LOAD_WAIT_SUPPORT` 每个成员各测一次。
 * 那个遍历**结构上看不见缺失的成员**：它是 `for (const [type] of Object.entries(表))`，
 * 表里少一行，循环就少跑一格，测试全绿。而"少一行"恰恰是这一族真实发生过的形状：
 * `ir/src/load.ts` 的复合键从前手抄成 `['allOf','anyOf','not']` —— `not` 在
 * `WaitPredicateSchema` 里不存在，真实存在的 `noneOf` **没有任何一个读者**，
 * 于是 `{noneOf:[{type:'dbRow'}]}` 静默走过压测静态闸（`.scratch/probe-noneof.mts` 量出来的），
 * 运行期再落到"判不了 -> 当假"，`onTimeout:'continue'` 下**静默当成没等**，
 * 压测照跑照出曲线。
 *
 * 所以要一根**从 schema 往表对撞**（方向与遍历相反）的守卫。这与
 * `wait-worlds.test.ts` / `wait-expr-fields.test.ts` 是同一个手法，
 * 放在 ir 包里而不是 engine 包里，是因为被守卫的那张表与 schema 在同一个包里：
 * "加一种等待条件"与"登记它能不能压"应当是**一次能看见的两处编辑**。
 *
 * ## 三条恒绿陷阱，每条配自检
 *  1. 取空：union 换成 `z.lazy(...)` 会让 `.options` 变 undefined，
 *     下面每个深比对会在两个空数组之间成立。所以先断清单非空。
 *  2. 表**多**出一格（历史里的 `not` 就是这个形状）：只断"schema 有而表没有"会放过它，
 *     而多出来那格是**活的地雷** —— 它让读表的人以为那种键存在（本轮就是这么错的）。
 *     所以两个方向都断，并且额外钉一句 `not` 不在表里。
 *  3. 复合键那一格如果没有任何运行期读者，本文件只是在验一张死表。
 *     `waitNeedsExternalAdapter` 是它的读者（本文件下面那几条验这个读者真的在用它），
 *     见 docs/08 §3(f)「有载体、没有生产者」。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  LOAD_WAIT_SUPPORT, WAIT_COMBINATORS, WaitConditionSchema, WaitPredicateSchema,
  waitNeedsExternalAdapter,
} from '../src/index.js';

/** 判别字面量，取自 union 本体（与 `wait-worlds.test.ts` 同一取法） */
const CONDITION_TYPES = ((WaitConditionSchema as unknown as { options: Array<{ def?: { shape?: { type?: { value?: string } } } }> }).options)
  .map((o) => o.def?.shape?.type?.value)
  .filter((x): x is string => typeof x === 'string')
  .sort();

/**
 * 复合键，从 `WaitPredicateSchema` 现取。
 *
 * 它是 `z.lazy(getter)`，所以要多解一层：`def.getter()` 出内层 union，
 * 内层的第一个成员是 `WaitConditionSchema`（判别联合），后三个才是 `{allOf}` /
 * `{anyOf}` / `{noneOf}` —— **取法本身要说明**，否则下一次 zod 升级把
 * `_zod.def.options` 改名时，这个函数会安静地返回空数组（见下面那条非空自检）。
 * 带 `type` 判别键的成员是谓词本身，不算复合键。
 */
const COMBINATOR_KEYS = (() => {
  const inner = ((WaitPredicateSchema as unknown as { def?: { getter?: () => unknown } }).def?.getter)?.() as
    { _zod?: { def?: { options?: unknown[] } } } | undefined;
  const options = inner?._zod?.def?.options ?? [];
  const out: string[] = [];
  for (const o of options) {
    const shape = (o as { _zod?: { def?: { shape?: unknown } } })._zod?.def?.shape;
    const fields = typeof shape === 'function' ? (shape as () => Record<string, unknown>)() : (shape as Record<string, unknown> | undefined);
    if (!fields || 'type' in fields) continue; // 判别联合那一支不是复合键
    out.push(...Object.keys(fields));
  }
  return out.sort();
})();

describe('LOAD_WAIT_SUPPORT 的键集与 schema 对撞（漏一格就是静默放行）', () => {
  test('从 schema 取出的两份清单都非空（取空会让下面每条恒绿）', () => {
    assert.ok(CONDITION_TYPES.length >= 8, `只取出 ${CONDITION_TYPES.length} 个条件类型，先怀疑取法而不是怀疑表`);
    assert.ok(COMBINATOR_KEYS.length >= 3, `只取出 ${COMBINATOR_KEYS.length} 个复合键，先怀疑取法`);
  });

  test('取法本身对得上 WAIT_COMBINATORS（本文件的复合键取法若失效，这一条先红）', () => {
    assert.deepEqual(COMBINATOR_KEYS, [...WAIT_COMBINATORS].sort(),
      '从 WaitPredicateSchema 取出的复合键与 waits.ts 的 WAIT_COMBINATORS 不一致 —— '
      + '要么加/改了复合键而 WAIT_COMBINATORS 没跟上，要么 zod 内部形状变了导致这里的取法失效');
  });

  test('schema 里每一种谓词/复合键，都在 LOAD_WAIT_SUPPORT 里有一格', () => {
    const all = [...CONDITION_TYPES, ...COMBINATOR_KEYS].sort();
    const missing = all.filter((t) => !(t in LOAD_WAIT_SUPPORT));
    assert.deepEqual(missing, [],
      `这些谓词类型在 schema 里而 LOAD_WAIT_SUPPORT 没有：${missing.join(', ')}。\n`
      + '  漏登记的后果**不是**"少一条优化"：waitNeedsExternalAdapter 对表里没有的类型按'
      + '"要外部能力"处理，于是那条 wait 在压测里被拒（看得见，还好）；'
      + '而漏的是**复合键**时，那一层根本没人遍历（本轮的 noneOf 就是这个形状），'
      + '静态闸放行 + 运行期判不了当假。请补表，并想清楚它属于 once 还是 refuse。');
  });

  test('表里不多出 schema 没有的键（历史上那一格叫 not，它是活地雷不是笔误）', () => {
    const all = new Set([...CONDITION_TYPES, ...COMBINATOR_KEYS]);
    const extra = Object.keys(LOAD_WAIT_SUPPORT).filter((k) => !all.has(k));
    assert.deepEqual(extra, [],
      `LOAD_WAIT_SUPPORT 里有 schema 不认识的键：${extra.join(', ')}。`
      + '读表的人会以为那种谓词/复合键存在（本轮就是照着 not 写了遍历），请删掉或改成真名字');
  });

  test('not 不在表里（钉住那个具体错误，防止改名改回来）', () => {
    assert.ok(!('not' in LOAD_WAIT_SUPPORT), 'schema 里没有 not 这一支，表里也不该有');
    assert.ok(!WAIT_COMBINATORS.includes('not' as never), '同上');
  });
});

describe('复合键那一格有真读者（不是死表，docs/08 §3(f)）', () => {
  test('三种复合键各自都被 waitNeedsExternalAdapter 遍历到', () => {
    // 断的是**行为**：把 dbRow 藏进每一种键里，都要被指出来。
    // 上面那几条键集对撞只保证"表里有这一行"，不保证有人读它。
    for (const k of WAIT_COMBINATORS) {
      assert.equal(waitNeedsExternalAdapter({ [k]: [{ type: 'expr', expr: '1' }, { type: 'dbRow', sql: 'select 1' }] }), 'dbRow',
        `${k} 里藏的 dbRow 没被看见`);
    }
  });

  test('复合键命中一种就不再去看别的键（三选一的语义，别写成"取最后一个"）', () => {
    // 全合法的一棵树必须返回 undefined。恒返回 undefined 的实现对这条是坏的，
    // 所以上面那条和这条要一起成立才算"真的在遍历"。
    assert.equal(waitNeedsExternalAdapter({ allOf: [{ type: 'expr', expr: '1' }] }), undefined);
    assert.equal(waitNeedsExternalAdapter({ anyOf: [{ type: 'expr', expr: '1' }, { type: 'httpStatus', ref: '$.step.q.resp', in: [200] }] }), undefined);
    assert.equal(waitNeedsExternalAdapter({ noneOf: [{ type: 'uiPredicate', target: { intent: 'x', primary: { by: 'css', value: 'a' } } }] }), 'uiPredicate');
  });

  test('深度嵌套也走到底（只走一层的实现会在第二层停下）', () => {
    assert.equal(
      waitNeedsExternalAdapter({ allOf: [{ anyOf: [{ type: 'expr', expr: '1' }, { noneOf: [{ type: 'newPage' }] }] }] }),
      'newPage');
  });

  test('表里 refuse 的每一种谓词都被指出来，once 的都不被指出（两方向）', () => {
    // 这条把"表的取值"与"判据的输出"接起来：表说 refuse => 必须报，表说 once => 必须不报。
    // 少了反方向，`return t` 无条件返回也能过上面所有测试。
    const fixtures: Record<string, unknown> = {
      expr: { type: 'expr', expr: '1' },
      httpStatus: { type: 'httpStatus', ref: '$.step.q.resp', in: [200] },
      dbRow: { type: 'dbRow', sql: 'select 1' },
      uiPredicate: { type: 'uiPredicate', target: { intent: 'x', primary: { by: 'css', value: 'a' } } },
      uiIdle: { type: 'uiIdle' },
      template: { type: 'template', target: { intent: 'x', primary: { by: 'css', value: 'a' } } },
      response: { type: 'response', urlPattern: '/x' },
      newPage: { type: 'newPage' },
    };
    for (const [type, t] of Object.entries(LOAD_WAIT_SUPPORT)) {
      const f = fixtures[type];
      if (!f) continue; // 复合键没有单节点夹具（上面两条覆盖它们）
      const hit = waitNeedsExternalAdapter(f);
      if (t.support === 'refuse') assert.equal(hit, type, `${type} 在表里是 refuse，判据却没报`);
      else assert.equal(hit, undefined, `${type} 在表里是 once，判据却报它要外部能力`);
    }
  });
});
