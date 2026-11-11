/**
 * **等待条件里的表达式，跑之前就要报** —— 静态闸对谓词树那一族的行为。
 *
 * ## 为什么单独一个文件（而不是并进 `expr-strict.test.ts`）
 *
 * 那个文件里的静态闸测的是**步骤字段**那一族（`when` / `condition` / `items` /
 * `switch.value`），判据是 `isExprField(kind, field)`。而 `wait` 步的 `condition`
 * 在上面那一查里**必然是空的** —— 它不是字符串，是一棵谓词树
 * （`WaitPredicateSchema`：条件 | allOf | anyOf | noneOf）。
 * 改动前静态闸扫到 `wait` 就到此为止，于是 `{type:'expr', expr:'1 +'}` 写坏了
 * **lint 与 dry-run 一声不响**，只能等跑起来才由运行时报。实测改前：
 *
 * ```
 * lint(wait{expr:'1 +'}) => 0 条 EXPR_SYNTAX
 * run (同一份场景)       => error + case-stale   ← 运行期那一半早就修好了
 * ```
 *
 * "运行时会红而跑之前不报"在本平台不是小事：**主力产出者是 LLM**，
 * 而 lint 是它唯一能在提交前拿到反馈的那道闸（docs/02 §5、docs/14 §5）。
 * 运行期那一半的钉子在 `error-cause.test.ts`（"等待条件里表达式语法错同归因"
 * 那一条）与 `lang.test.ts`（谓词树求值），**不在本文件重复**；
 * 本文件全部条目测的都是"跑之前"那一段。
 *
 * ## 为什么判据不能写成 `if (c.type === 'expr')`
 *
 * 那是本仓抄了十几轮的"N 份手抄清单"，而且比手抄更隐蔽：今天它对
 * （八种条件里确实只有 `expr` 这一种带表达式字段），**所以任何测试都抓不到
 * 它哪天不再对**。现在这一查用 `isExprConditionField(type, field)`，
 * 那张表由 `WaitConditionSchema` 派生（`ir/src/waits.ts`），与步骤那一族
 * 共用同一个 `deriveExprFields`。表自己的钉子（含"整张表扫空了"那个自检）在
 * `ir/test/wait-expr-fields.test.ts`；**本文件钉的是接线**：
 * lint 那一遍真的遍历了谓词树、真的用了这张表、以及对不误伤。
 *
 * ## 每一组都配反方向
 *
 * 漏报与误报是两个独立方向，而这个闸是 **error 级**（`--strict` 与 `atest lint`
 * 的退码判据就是 error 数）：误报的代价从来不是多一条红字，
 * 是大家把整道闸关掉，于是其余规则一起失效。
 * 所以下面既钉"三种嵌套深度都报得出"，也钉"是字符串但不是表达式的字段一律不碰"
 * （`dbRow.sql` 里那句 `WHERE a = $1 -- x` 是最狠的一条探针：含 `$`、含括号、
 * 含 `--`，长得什么都像）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dryRun, lintScenario } from '../src/index.js';
import { WaitConditionSchema, defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

const scen = (body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.test', name: 'test scenario',
    env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);
/** 只留本轮这一族那条 code，别把场景里其它 finding（sleep 警告之类）算进来 */
const lint = (body: StepDraft[]) =>
  lintScenario(scen(body), {}).filter((f) => f.code === 'EXPR_SYNTAX');
const dry = (body: StepDraft[]) =>
  dryRun(scen(body)).issues.filter((i) => i.code === 'EXPR_SYNTAX');

/** 一条 wait 步骤。超时给足但短，因为这个入口根本不执行、只为让 IR 合法 */
const w = (id: string, condition: unknown, extra: Record<string, unknown> = {}): StepDraft =>
  ({ id, kind: 'wait', condition, timeoutMs: 500, pollMs: 50, onTimeout: 'fail', ...extra } as StepDraft);

const loc = { intent: '订单按钮', primary: { by: 'testid', value: 'order' } };
/** 写坏的引用（与 `expr-strict.test.ts` 同一族形态，走的是"路径本体"那一查） */
const BROKEN_PATH = ['$.n[', '$.a.b[', '$.', '$..'];

describe('漏报方向：谓词树的每一种深度里，写坏的表达式都要被静态闸抓到', () => {
  test('顶层 {type:"expr"}：语法错与写坏的引用各报一条（改前 0 条）', () => {
    for (const e of ['1 +', 'not', 'nopefn(1)', ...BROKEN_PATH]) {
      const f = lint([w('a', { type: 'expr', expr: e })]);
      assert.equal(f.length, 1, `expr: ${JSON.stringify(e)} => ${f.length} 条：${f.map((x) => x.message).join(' | ') || '（无）'}`);
      assert.equal(f[0]!.level, 'error', '级别要与步骤那一族一致：这里报的都是运行时会抛的东西');
      assert.equal(f[0]!.stepId, 'a', `finding 要指到那个 wait 步骤本身：${f[0]!.stepId}`);
      // 消息要说出**是哪个条件的哪个字段**。只说"表达式语法错误"的话，
      // 一步里有 when 与 condition 两处时，人分不清改哪个。
      assert.match(f[0]!.message, /等待条件 expr 的 expr/, `消息没点名条件与字段：${f[0]!.message}`);
    }
  });
  test('anyOf / allOf / noneOf 的内层条件同样抓到（三个键共用遍历，只修顶层等于没修）', () => {
    const trees: Array<[string, unknown]> = [
      ['anyOf', { anyOf: [{ type: 'expr', expr: '$.a' }, { type: 'expr', expr: '1 +' }] }],
      ['allOf', { allOf: [{ type: 'expr', expr: '$.a' }, { type: 'expr', expr: '$.n[' }] }],
      ['noneOf', { noneOf: [{ type: 'expr', expr: '1 ==' }] }],
      // 混排两层：真实场景里等待条件常常是这个形状（lang.test.ts 里就有 allOf+anyOf+noneOf）
      ['allOf>noneOf', { allOf: [{ type: 'expr', expr: '$.a' }, { anyOf: [{ type: 'expr', expr: '$b' }, { noneOf: [{ type: 'expr', expr: '$.n[' }] }] }] }],
    ];
    for (const [name, cond] of trees) {
      const f = lint([w('a', cond)]);
      assert.equal(f.length, 1, `${name} 内层那条坏表达式没抓到（${f.length} 条）—— 遍历只走了顶层？`);
    }
  });
  test('内层有两条坏的，就报两条（遍历不许在第一条处停下）', () => {
    const f = lint([w('a', { anyOf: [{ type: 'expr', expr: '1 +' }, { type: 'expr', expr: '$.n[' }] })]);
    assert.equal(f.length, 2, `实际 ${f.length} 条：${f.map((x) => x.message).join(' | ')}`);
  });
  test('wait 步骤自己的 when 也照报（步骤那一族与条件那一族互不顶替）', () => {
    /*
     * 两条判据是**两个调用点**。写这块代码时最容易"顺手只补 condition 那一侧"，
     * 于是 `when` 那一侧的覆盖看起来由本文件证明了、其实没有。
     * 这条同时钉住"消息前缀不同"：when 那条说的是 `when 表达式语法错误`，
     * 不带"等待条件"四个字 —— 前缀写串的话人会在条件树里找一个不存在的表达式。
     */
    const f = lint([w('a', { type: 'expr', expr: '1 == 1' }, { when: '$.n[' })]);
    assert.equal(f.length, 1, `实际 ${f.length} 条：${f.map((x) => x.message).join(' | ')}`);
    assert.match(f[0]!.message, /^when 表达式语法错误/, `前缀指错了地方：${f[0]!.message}`);
  });
  test('dry-run 与 lint 同时报、条数一致（判据只有一份，不许一处报一处不报）', () => {
    const bodies: StepDraft[][] = [
      [w('a', { type: 'expr', expr: '1 +' })],
      [w('a', { allOf: [{ type: 'expr', expr: '$.n[' }] })],
      [w('a', { type: 'dbRow', sql: 'SELECT 1', expect: 'row' })],
    ];
    for (const body of bodies) {
      const l = lint(body);
      const d = dry(body);
      assert.equal(l.length, d.length, `lint ${l.length} 条而 dry-run ${d.length} 条 = 两处各写了一份判据`);
      if (l.length) {
        assert.deepEqual(d.map((x) => x.message), l.map((x) => x.message), '两处消息主体不同 = 两份报错文案');
      }
    }
  });
});

describe('误报方向：是字符串但不是表达式的字段，一个都不许碰', () => {
  test('dbRow.sql / response.urlPattern / uiPredicate.state 都不报（含 `$`、含 `--`、含括号也不报）', () => {
    /*
     * `WHERE a = $1 -- x` 是这一组里最值钱的探针：它含 `$`、含 `(`、含 `--`、
     * 含字符串引号，形状上"什么都像"，而它是**给数据库看的 SQL 文本**。
     * 从前 `dryRun` 那份手抄清单里有个 `value`，就是被这一类字段咬过
     * （`expr-strict.test.ts` 里 `价格 3$` 那一条钉的是同一族毛病）。
     * 而 SQL 这一处更糟：报出来的话人会去改 SQL 的写法，而 SQL 没写错。
     */
    const probes: Array<[string, unknown]> = [
      ['dbRow.sql', { type: 'dbRow', sql: 'SELECT count(*) FROM t WHERE a = $1 AND b LIKE "%x" -- 注释', datasource: 'default', expect: 'row' }],
      ['dbRow.vars 的字面量值', { type: 'dbRow', sql: 'SELECT 1', expect: 'row', vars: { oid: '$100 起' } }],
      ['response.urlPattern', { type: 'response', urlPattern: '/api/v1/$id/orders[0]' }],
      ['uiPredicate.state', { type: 'uiPredicate', target: loc, state: 'visible' }],
      ['template.expect', { type: 'template', target: loc, expect: 'hit' }],
      ['httpStatus 的 ref 与 in', { type: 'httpStatus', ref: '$.step.nope.resp', in: [200, 201] }],
      ['uiIdle.quietMs', { type: 'uiIdle', quietMs: 400 }],
      ['newPage（无字段）', { type: 'newPage' }],
    ];
    for (const [name, cond] of probes) {
      const f = lint([w('a', cond)]);
      assert.deepEqual(f.map((x) => x.message), [], `${name} 被当表达式校验了：${f.map((x) => x.message).join(' | ')}`);
      assert.deepEqual(dry([w('a', cond)]).map((x) => x.message), [], `${name} 在 dry-run 里被报了`);
    }
  });
  test('合法表达式一律不报（含"取不到值"的那些 —— 那是等待的地基，不是错误）', () => {
    /*
     * `$.order.id > 0` 在数据还没落库时取到 undefined => 条件不成立 => 再等一轮。
     * 静态闸要是把它报了，等于宣布"一条正常的异步等待写错了"。
     * 与 `expr-strict.test.ts` 里"值不存在不是错误"是同一条性质，
     * 那里钉的是 `when`，这里钉的是等待条件 —— 两处都要有人钉，
     * 因为这两处**是两次不同的调用**，一次改动可以只修一半。
     */
    for (const e of ['$.a', '$a', '$a.b', '$.a[0]', '$.order.id > 0', 'len(name) > 0', 'count($.x) > 0', '$.a-b', '1 == 1', 'not true']) {
      const f = lint([w('a', { type: 'expr', expr: e })]);
      assert.equal(f.length, 0, `${JSON.stringify(e)} 被报了：${f[0]?.message}`);
    }
  });
  test('schema 里每一种等待条件都写过合法形态，全部零 finding（新增条件而没人验过，这里会红）', () => {
    /*
     * 这一条是"扫描没扫空"的**执行侧**自检。`ir/test/wait-expr-fields.test.ts`
     * 钉的是派生表本身不为空；这里钉的是"这八种条件写出来都能过闸"。
     * 万一将来加一种条件、它的某个 string 字段被派生误认成表达式，
     * 表那一侧的自检不一定红（它比的是 schema 与表，两者一起错就一起绿），
     * 而这条**按合法写法写一遍就红** —— 两个方向不重复。
     */
    const all: StepDraft[] = [
      w('c1', { type: 'httpStatus', ref: '$.step.h.resp', in: [200] }),
      w('c2', { type: 'expr', expr: '$.a > 0' }),
      w('c3', { type: 'dbRow', sql: 'SELECT 1', expect: 'row' }),
      w('c4', { type: 'uiPredicate', target: loc, state: 'gone' }),
      w('c5', { type: 'template', target: loc, expect: 'miss' }),
      w('c6', { type: 'uiIdle', quietMs: 200 }),
      w('c7', { type: 'response', urlPattern: '/api/x' }),
      w('c8', { type: 'newPage' }),
    ];
    /*
     * 数量自检。**不许写成 `assert.equal(all.length, 8)`** —— 那是拿我自己刚写的
     * 字面量断言我自己刚写的字面量，恒成立、零信息（本仓那条缺陷类的孪生写法）。
     * 有内容的版本是：条件类型清单取自 schema 本体，再要求本条**逐个都写过**。
     * 于是"往 WaitConditionSchema 加一种条件而没人验过它过不过闸"会红在这里。
     */
    const inSchema = ((WaitConditionSchema as unknown as {
      options: Array<{ def?: { shape?: { type?: { value?: string } } } }>;
    }).options).map((o) => o.def?.shape?.type?.value).filter((x): x is string => typeof x === 'string');
    assert.ok(inSchema.length >= 4, `schema 里只认出 ${inSchema.length} 种条件：这条自检本身不可信`);
    const written = all.map((s) => (s as unknown as { condition: { type: string } }).condition.type);
    assert.deepEqual(inSchema.filter((t) => !written.includes(t)), [],
      '这些等待条件本条没写过合法形态，上面那条"零 finding"对它们来说是空的');
    const f = lint(all);
    assert.deepEqual(f.map((x) => `${x.stepId}:${x.message}`), [], '合法等待条件被静态闸拒了');
  });
});

describe('这条闸抓的是"跑之前"那一段（与运行期那一半是两层，不是一层）', () => {
  test('报的级别与判据：error 级，且**不看运行时机**（allOf 短路也照报）', () => {
    /*
     * `allOf` 短路时后面的条件**这一次执行根本不会被求值**，所以"报了而运行时
     * 一次都没抛"是可能的。要说清这不是误报：表达式本身确实写坏了，
     * 数据一变它就抛 —— 这是静态闸比单次执行**看得全**，与"把合法写法拦下来"
     * 是两件事（后者才是误报，上面那一整块钉的就是它）。
     *
     * 反过来说清这条弱在哪：它**不**保证"报了就等于这次一定会红"。
     * 所以级别是 error 而不是"直接拒绝执行"之外的什么东西 —— `--strict` 拦下的
     * 是"写坏了的用例"，不是"这次一定失败"。
     */
    const f = lint([w('a', { allOf: [{ type: 'expr', expr: '1 == 1' }, { type: 'expr', expr: '$.n[' }] })]);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.level, 'error');
    assert.match(f[0]!.message, /引用路径写坏/, '路径写坏的那一支要说清是哪个 ref');
  });
  test('fix 建议与步骤那一族同一条（两处各写一份文案，就会各自漂移）', () => {
    const a = lint([w('a', { type: 'expr', expr: '1 +' })])[0]!;
    const b = lint([{ id: 'z', kind: 'noop', when: '1 +' } as StepDraft])[0]!;
    assert.ok(a.fix && a.fix.length > 0, '等待条件那条没给 fix');
    assert.equal(a.fix, b.fix, '同一句写坏的表达式在两个位置给出不同建议 = 两份文案');
  });
});
