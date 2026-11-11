/**
 * `EXPR_CONDITION_FIELDS`（等待条件那一族的"哪个字段是表达式"）自己的测试。
 *
 * ## 为什么单独一个文件
 *
 * 步骤那一族的同一张表在 `expr-fields.test.ts`，而它钉不住这一族：
 * 两张表来自同一个 `deriveExprFields`，喂的 union 与判别键不同
 * （`StepSchema`/`kind` vs `WaitConditionSchema`/`type`）。
 * 派生代码正确不代表**喂进去的参数**正确 —— 判别键写成 `'kind'` 的话
 * 这一族会得到一张**空表**，而空表不报错、只让静态闸静默失效（= 本轮修的那个洞
 * 换个位置复活）。所以这一族必须有自己的钉子。
 *
 * ## 三条"恒通过"的陷阱，每条都配了自检
 *  1. 扫空的自检：`WaitConditionSchema.options.length` 必须真的是 8 那个量级。
 *     union 换成 `z.lazy(...)` 之类让 `.options` 变 undefined 时，
 *     `deriveExprFields` 会**返回空表**而不是抛 —— 没有这条自检，下面几条全绿。
 *  2. **反方向**（不许过度管）：`dbRow.sql` / `response.urlPattern` 都是 string，
 *     把它们算进表达式就是误报，代价是整道闸被人关掉。
 *  3. 表是冻结的。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { WaitConditionSchema, isExprConditionField, EXPR_CONDITION_FIELDS } from '../src/index.js';
import { assertScannerWorks, stripComments } from './src-text.js';

const SRC = readFileSync(join(import.meta.dirname, '../src/waits.ts'), 'utf8');
/*
 * **注释要先剥掉**，否则正则会把散文里的假想字段当成正字段。这不是假设：
 * 本文件要核对的那张表，它自己的注释里就举了一个不存在的
 * `{type:'scalarTruth', exprEq: ExprSchema}`，第一版扫描照着它报了错。
 * 完整经过与"为什么这条判据因此弱在哪"写在 `src-text.ts` 里。
 */
const CODE = stripComments(SRC);
/** 条件类型清单，取自 schema 本体（与派生表两个独立来源：一个是 union 成员，一个是字段判据） */
const CONDITION_TYPES = ((WaitConditionSchema as unknown as { options: Array<{ def?: { shape?: { type?: { value?: string } } } }> }).options)
  .map((o) => o.def?.shape?.type?.value)
  .filter((x): x is string => typeof x === 'string');

test('扫描本身有效：union 成员数与认出的类型数一致（不一致 = .options 拿不到，下面几条会恒通过）', () => {
  const opts = (WaitConditionSchema as unknown as { options?: unknown[] }).options;
  assert.ok(Array.isArray(opts), 'WaitConditionSchema 不再是能取到 .options 的 union：deriveExprFields 会返回空表，本轮那个洞会静默复活');
  // 8 是当前实测值。**写成 >= 4 而不是 === 8**：加一种条件是正常演进，
  // 而这条要挡的是"扫不到东西"，不是"数量变了"（把每次提交都可能动的数写死，
  // 是本仓在别处反复批评的那种写法）。
  assert.ok(CONDITION_TYPES.length >= 4, `只认出 ${CONDITION_TYPES.length} 种等待条件（union 里有 ${(opts as unknown[]).length} 个成员）—— 判别键写法变了？`);
  assert.equal(CONDITION_TYPES.length, (opts as unknown[]).length, '有成员认不出 type 判别值：那一族的表达式字段会静默不进表');
  for (const t of ['expr', 'dbRow', 'uiPredicate', 'response']) {
    assert.ok(CONDITION_TYPES.includes(t), `认出的类型里没有 ${t}，上面的数量断言不可信`);
  }
});

test('每一种等待条件都在表里（少一个 = 那种条件的表达式字段从此没有静态校验）', () => {
  const missing = CONDITION_TYPES.filter((t) => EXPR_CONDITION_FIELDS[t] === undefined);
  assert.deepEqual(missing, [], `这些条件类型压根不在派生表里：${missing.join('、')}`);
  const bogus = Object.keys(EXPR_CONDITION_FIELDS).filter((t) => !CONDITION_TYPES.includes(t));
  assert.deepEqual(bogus, [], `表里有不存在的条件类型（拼错不报错，只会静默少管）：${bogus.join('、')}`);
});

test('**独立来源核对**：waits.ts 源码里写在条件对象上的每一处 `字段: ExprSchema`，表里都得有', () => {
  /*
   * 与 `expr-fields.test.ts` 同一条方法论：不用 zod introspection，改用**正则读源码文本**。
   * 两个来源独立（文本 vs zod 结构），任何一份单独坏掉都会红。
   * 拿派生表跟"另一份手抄清单"比是同义反复 —— 那个毛病记在 `kind-tables.test.ts`。
   */
  assert.match(CODE, /export const WaitConditionSchema = z\.discriminatedUnion/, 'waits.ts 里 WaitConditionSchema 的写法变了：同步改这条与派生调用');
  // 扫描器自己的自检：剥完注释后仍要认得出这两个**必然存在**的写法，
  // 否则下面的 missed 会因为"什么都没扫到"而恒通过。
  assertScannerWorks(CODE, [/type: z\.literal\('expr'\)/, /expr: ExprSchema/]);
  const starts = [...CODE.matchAll(/type: z\.literal\('([\w]+)'\)/g)];
  assert.ok(starts.length >= 4, `只认出 ${starts.length} 个条件字面量 —— waits.ts 写法变了，这个正则该改了`);
  const missed: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.index!;
    // 切片的源**必须是 CODE**：`starts` 的下标是在 CODE 上算出来的，
    // 拿它去切 SRC 会得到错位的文本（第一版就是这么错的 —— 于是它把
    // 注释里的假想字段算进相邻成员名下，报出一条压根不存在的 `dbRow.expr`。
    // 一次错位不会红，只会让断言在**错的东西**上成立，这正是本仓那条缺陷类）
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : CODE.length;
    const text = CODE.slice(from, to);
    const type = starts[i]![1]!;
    // 只认**同一层**写在条件对象里的 ExprSchema（`( … ).strict()` 之前不再跨层）
    for (const m of text.matchAll(/(\w+)\s*:\s*ExprSchema(?:\.optional\(\))?/g)) {
      if (!isExprConditionField(type, m[1]!)) missed.push(`${type}.${m[1]}`);
    }
  }
  assert.deepEqual(missed, [], `源码里写着 ExprSchema 而派生表不认：${missed.join('、')} => 这些字段写坏了没人静态校验`);
});

test('**不许过度管**：条件里那些"是字符串但不是表达式"的字段一律不算', () => {
  /*
   * 这一条比上面几条更要紧。`dbRow.sql` / `response.urlPattern` / `uiPredicate.state`
   * 都是 `z.string()`，把它们喂进 validateExpr 会得到 error 级 EXPR_SYNTAX，
   * 于是合法场景被 `--strict` 与 `atest lint` 拒掉 —— 而误报的真实代价从来不是
   * 多一条红字，是大家把整道闸关掉，其余规则一起失效。
   */
  assert.ok(isExprConditionField('expr', 'expr'), 'expr 条件的 expr 必须认得（否则本条就成了"全都 false"的假测试）');
  assert.ok(!isExprConditionField('dbRow', 'sql'), 'dbRow.sql 是 SQL 文本，不是表达式');
  assert.ok(!isExprConditionField('dbRow', 'datasource'), 'dbRow.datasource 不是表达式');
  assert.ok(!isExprConditionField('response', 'urlPattern'), 'response.urlPattern 是 URL 片段，不是表达式');
  assert.ok(!isExprConditionField('uiPredicate', 'state'), 'uiPredicate.state 是枚举词，不是表达式');
  assert.ok(!isExprConditionField('httpStatus', 'ref'), 'httpStatus.ref 是 RefSchema（引用不是表达式；引用另有 VAR_UNDEFINED 那一查）');
  // 不存在的类型/字段必须是 false 而不是抛或 undefined 参与比较
  assert.equal(isExprConditionField('不存在', 'expr'), false);
});

test('派生表是冻结的', () => {
  assert.ok(Object.isFrozen(EXPR_CONDITION_FIELDS), '表本体没冻结：运行期被改一个字段名，静态闸就静默换边');
  const some = EXPR_CONDITION_FIELDS.expr;
  assert.ok(some && Object.isFrozen(some), '每个条件类型的字段数组没冻结');
});
