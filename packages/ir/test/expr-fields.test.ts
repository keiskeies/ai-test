/**
 * `EXPR_STEP_FIELDS`（"这个字段是表达式吗"的**唯一一份定义**）自己的测试。
 *
 * ## 为什么要给一张派生表写测试
 *
 * 它是从 zod schema 派生的，看起来"派生出来的东西不会错"。**会错，而且错的形状
 * 正是本仓反复那一种**：派生代码看不见 schema 里新增的字段，于是那道闸
 * 对新字段静默失效 —— 与它要替换的那两份手抄清单（`lint.ts` 抄两个字段名、
 * `dryrun.ts` 抄四个）**坏法完全相同**，只是换了一个更体面的来源。
 *
 * 所以核心那条测试**不用 zod 的 introspection**，而是**用正则直接读 steps.ts 的源码**，
 * 找每一处 `字段名: ExprSchema`，再要求派生表里有它。两份来源独立
 * （正则扫文本 vs zod 走 `.def.shape`），任何一份单独坏掉都会红。
 * 拿派生表跟"另一份手抄的同样清单"比是同义反复 —— 那个毛病我在
 * `kind-tables.test.ts` 里已经犯过一次并记在那儿了。
 *
 * ## 它同时挡住的三个真实失效
 *  1. 新增 `字段: ExprSchema` 而派生表看不到（比如塞进嵌套对象里）=> 漏报，红。
 *  2. 派生代码把 `ValueSchema`（要填进输入框的字面量）当表达式 => 误报，红
 *     （`act.value` / `input.value` 是这条的钉子；`EXPR_SYNTAX` 是 error 级，
 *     误报会让合法场景被 `--strict` 拒掉）。
 *  3. `Base` 里那个共有的 `when` 丢了 => 所有步骤的守卫条件同时失去静态校验，红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test } from 'node:test';

import { EXPR_STEP_FIELDS, STEP_KINDS, StepSchema, isExprField, type Step } from '../src/index.js';
import { assertScannerWorks, stripComments } from './src-text.js';

const ALL = STEP_KINDS as readonly Step['kind'][];
const SRC = readFileSync(join(import.meta.dirname, '../src/steps.ts'), 'utf8');
/** 剥掉注释的同一份源码。**所有按位置切片的扫描都走它**（含下面那条 `Base.when` 的断言：
 *  拿 SRC 判的话，一段写着 `when: ExprSchema.optional()` 的注释就能伪造出"字段还在"）。 */
const CODE = stripComments(SRC);

test('每一个 kind 都在表里（少一个 = 那种步骤的 when 与它自己的表达式字段**全部**没有静态校验）', () => {
  const missing = ALL.filter((k) => EXPR_STEP_FIELDS[k] === undefined);
  assert.deepEqual(missing, [], `这些 kind 压根不在派生表里：${missing.join('、')} —— 派生代码走空了它们`);
  const bogus = Object.keys(EXPR_STEP_FIELDS).filter((k) => !ALL.includes(k as Step['kind']));
  assert.deepEqual(bogus, [], `表里有不存在的 kind（拼错不报错，只会静默少管）：${bogus.join('、')}`);
});

test('**独立来源核对**：正则从 steps.ts 源码里找到的每一处 `字段: ExprSchema`，表里都得有', () => {
  /*
   * 步骤 schema 的写法在本仓是统一的：`const XxxStepSchema = z.object({ kind: z.literal('if'), … })`，
   * 有的写成一行、有的换行。所以先按 `const …StepSchema` 切块，块内找 kind 与 ExprSchema 字段。
   * 这是**文本**判据，与派生表用的 zod 结构判据完全无关 —— 两个独立来源对不上才有信息量。
   *
   * **注释先剥掉**（理由与 `wait-expr-fields.test.ts` 里同一条一样，那边本轮真的被
   * 一段散文里的假想字段绊过一次：正则是哑的，读不出代码与散文）。
   * 本文件今天没有这种巧合，但**"今天没有"不是一条判据** —— 这个文件的注释里
   * 恰好也写着 `ExprSchema` 若干次，只差一个冒号就不会红。
   */
  const blocks: Array<{ kind: string; fields: string[] }> = [];
  // 扫描器自己的自检：剥完注释后仍要认得出这两个**必然存在**的写法。
  // 没有这一步，"剥多了把真字段也吃掉"会让下面那条恒通过（`src-text.ts` 里那条
  // "不许放宽断言、要改扫描器"的规矩就是给这一刻准备的）。
  assertScannerWorks(CODE, [/const IfStepSchema\s*=/, /kind:\s*z\.literal\('if'\)/]);
  const starts = [...CODE.matchAll(/const \w*StepSchema\s*=/g)];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.index!;
    // 切片的源必须与 matchAll 的源同一个，否则下标错位（踩过，见另一个文件里那条注释）
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : CODE.length;
    const text = CODE.slice(from, to);
    const kind = /kind:\s*z\.literal\('([\w]+)'\)/.exec(text)?.[1];
    if (!kind) continue;
    const fields = [...text.matchAll(/(\w+)\s*:\s*ExprSchema(?:\.optional\(\))?/g)].map((m) => m[1]!);
    blocks.push({ kind, fields });
  }
  // 扫描本身要有效：扫不到东西时下面那条会恒通过，而恒通过的护栏比没有护栏更糟。
  assert.ok(blocks.length >= 25, `只认出 ${blocks.length} 个步骤 schema 块 —— steps.ts 的写法变了，这个正则该改了`);
  const kinds = new Set(blocks.map((b) => b.kind));
  assert.ok(kinds.has('if') && kinds.has('forEach') && kinds.has('switch'),
    '认出的块里没有 if/forEach/switch，说明正则没真扫到步骤 schema');

  const missed: string[] = [];
  for (const { kind, fields } of blocks) {
    if (!ALL.includes(kind as Step['kind'])) continue; // 非步骤的 schema 块（WaitStepSchema 等）
    for (const f of fields) {
      if (!isExprField(kind, f)) missed.push(`${kind}.${f}`);
    }
  }
  assert.deepEqual(missed, [], `源码里写着 ExprSchema 而派生表不认：${missed.join('、')} => 这些字段写坏了没人静态校验`);
});

test('Base 里那个共有的 when 在**每一个** kind 上都在表里（丢了 = 所有守卫条件同时失去静态校验）', () => {
  // `when` 定义在 `Base` 里、由 `...Base` 摊进每个步骤，所以上面那条按块扫的正则
  // 看不见它（块里没有 `when: ExprSchema`）。它必须单独立一条：
  // 一旦有人把 `Base.when` 改名或挪走，派生表会静默地在所有 kind 上少一个字段。
  assert.match(CODE, /when:\s*ExprSchema\.optional\(\)/, 'steps.ts 里 `Base.when` 的写法变了：同步改这条与派生逻辑');
  const missing = ALL.filter((k) => !isExprField(k, 'when'));
  assert.deepEqual(missing, [], `这些 kind 没有 when：${missing.join('、')}`);
});

test('**不许过度管**：`ValueSchema` 那族（要填进输入框的字面量）一律不算表达式', () => {
  /*
   * 这是误报方向的钉子，比上面几条更要紧。`act.value` 是"往输入框里填什么"，
   * `P@ssw0rd!` / `a,b` / `价格 3$` 都是合法值；把它们当表达式喂 `validateExpr`
   * 会得到 `EXPR_SYNTAX`（**error 级**），于是合法场景被 `--strict` 与 `atest lint` 拒掉。
   * 而误报的真实代价从来不是多一条黄字，是大家把 lint 关掉，
   * 于是那道闸里其余规则一起失效。
   */
  for (const kind of ['act', 'input'] as const) {
    assert.ok(isExprField(kind, 'when'), `${kind}.when 必须是表达式`);
    assert.ok(!isExprField(kind, 'value'), `${kind}.value 是 ValueSchema（填进输入框的字面量），不许当表达式校验`);
  }
  // 反向：真表达式必须认得，否则这一条就成了"全都 false"的假测试。
  assert.ok(isExprField('switch', 'value'), 'switch.value 是 ExprSchema，必须认得');
  assert.ok(isExprField('forEach', 'items'), 'forEach.items 是 ExprSchema，必须认得');
  assert.ok(isExprField('if', 'condition') && isExprField('while', 'condition'), 'if/while.condition 必须认得');
});

test('派生表是冻结的（它能被改一个字段名就绕过整道闸，所以要挡写）', () => {
  assert.ok(Object.isFrozen(EXPR_STEP_FIELDS), '表本体没冻结：运行期被改一个字段名，静态闸就静默换边');
  const some = EXPR_STEP_FIELDS.if;
  assert.ok(some && Object.isFrozen(some), '每个 kind 的字段数组没冻结');
});

test('StepSchema 是 union 且派生表认到的 kind 数与它一致（换成 discriminatedUnion 之类要同步改派生）', () => {
  const opts = (StepSchema as unknown as { options?: unknown[] }).options;
  assert.ok(Array.isArray(opts), 'StepSchema 不再是 union：EXPR_STEP_FIELDS 的派生逻辑要跟着改（这条会红得很有用）');
  assert.equal(Object.keys(EXPR_STEP_FIELDS).length, new Set(opts.map((o) =>
    (o as { def?: { shape?: { kind?: { value?: string } } } }).def?.shape?.kind?.value).filter(Boolean)).size,
    'union 成员数与表里的 kind 数不等：有成员没被派生认到');
});
