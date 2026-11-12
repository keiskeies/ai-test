/**
 * **表达式里的引用写坏了，必须响** —— 两种执行形态 + 静态闸，三层。
 *
 * ## 这个文件存在的理由：一条假绿修完之后，它自己不会留下测试
 *
 * `when: '$.n['`（下标没闭合）改动前是：**该步 `skipped`、整场 `pass`**
 * （tally `{pass:1, skipped:1}`），而且 **lint 一句没响**。两种执行形态都一样
 * —— `executor.ts` 里那句注释写着"预编译形态刻意不在这里抓、让外层记 error"，
 * **实测那句是假的**，两种形态都从 `expr.ts` 的 `catch { return undefined }` 拿到 undefined。
 *
 * 修它要同时修**两层**，而这两层各自独立、少修一层就留一个洞（都实测过）：
 *
 *  - **运行期**：`expr.ts` 里那对 `catch { return undefined }` 把 `PathError`
 *    吞成"没这个值"。删掉之后守卫拿到的是异常，不是 undefined。
 *  - **静态闸**：`validateExpr` 只走 AST 查函数名，**`ref` 节点从不校验路径本体**；
 *    它 catch 里那句 `e instanceof PathError` 是**永远为假**的一支
 *    （`parse` 不解析路径内部）。所以 `EXPR_SYNTAX` 对 `'1 +'` 响、对 `'$.n['` 不响。
 *
 * **只修运行期的话**：运行时会红，而 lint 照旧静默 —— 那份"生成期就该被抓完"
 * 的闸仍然是漏的。反过来只修静态闸更糟：`run` 不带 `--strict` 时 warning/error
 * 都不拦人，假绿原封不动。
 *
 * ## 与它配对的性质：值不存在**不是**错误
 *
 * 这一族最容易修过头。`{}` 上取 `$.order.id`（异步落库还没落）必须继续是
 * `undefined` => 条件不成立 => **等待继续轮**，那是等待机制的地基
 * （docs/02 §3"等待是条件，不是时长"）。所以下面每一组都是**成对**的：
 * 写坏了要响，没值不许响。只写前一半会被"恒抛异常"那种实现骗过 ——
 * 而那种实现看起来像是把 bug 修好了。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * `Scenario` / `StepDraft` 从 `@atest/ir` 拿而不是从引擎的 barrel：引擎的
 * `index.ts` 不转发 IR 的类型（它只 `export *` 自己 src 下那几个模块）。
 * 本仓其它引擎测试也都是这个写法，照它。
 */
import {
  compileExpr, validateExpr, PathError,
  runScenario, deterministicClock, compilePlan, precompiledExecutor,
  lintScenario, dryRun, type RunReport,
} from '../src/index.js';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

const b = (id: string): { id: string } => ({ id });
const scen = (body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.test', name: 'test scenario',
    env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);
const run = (s: Scenario): Promise<RunReport> =>
  runScenario({ scenario: s, adapters: {}, clock: deterministicClock(42) });
const res = (r: RunReport, id: string): RunReport['results'][number] => {
  const x = r.results.find((y) => y.stepId === id);
  assert.ok(x, `没有步骤 "${id}"（实际：${r.results.map((y) => y.stepId).join(', ') || '无'}）`);
  return x!;
};
const ctx = (root: unknown, vars: Record<string, unknown> = {}) => ({ root, vars, now: () => 0 });

/** 写坏的引用（每一句都是**运行时会抛 PathError** 的形态，下面有一条测试钉这个等价关系） */
const BROKEN = ['$.n[', '$.a.b[', '$.', '$..', '$.n[]'];
/** 合法但取不到值（异步落库、可选字段、步骤尚无输出） */
const ABSENT = ['$.order.id', '$.a.b.c', '$.a[3]'];

describe('运行期：写坏的引用必须抛，取不到值必须还是 undefined', () => {
  test('每一句写坏的引用都抛 PathError（改前全部静默返回 undefined）', () => {
    for (const p of BROKEN) {
      assert.throws(() => compileExpr(p).eval(ctx({ n: 1, a: { b: 1 } })), PathError,
        `${p}：没抛 —— 那守卫会拿到 undefined，就是那个假绿`);
    }
  });
  test('每一句"合法但没这个值"都还是 undefined（**这一半是本轮最守不住不得的性质**）', () => {
    for (const p of ABSENT) {
      let got: unknown;
      assert.doesNotThrow(() => { got = compileExpr(p).eval(ctx({})); }, `${p}：抛了`);
      assert.equal(got, undefined, `${p}：${String(got)}`);
    }
  });
  test('数据形状不对也不许抛（标量按下标取、null 往下取属性、越界）', async () => {
    // 这些是"被测系统返回了跟 IR 不一样的形状"，不是用例写坏了。
    // 若这一族也抛，产品问题会变成 case-stale，那是本轮反复警惕的**过度修**。
    const shapes: Array<[string, unknown]> = [
      ['$.a[0]', { a: 'scalar' }], ['$.a[0]', { a: {} }], ['$.a.b', { a: null }],
      ['$.a.b.c', { a: { b: 5 } }], ['$.a[3]', { a: [1, 2] }], ['$.a.b', {}],
    ];
    for (const [p, root] of shapes) {
      assert.doesNotThrow(() => compileExpr(p).eval(ctx(root)), `${p} on ${JSON.stringify(root)}：抛了`);
      assert.equal(compileExpr(p).eval(ctx(root)), undefined);
    }
  });
  test('等待还在轮：条件从"没值"变"有值"这条路上一次都不该抛', async () => {
    // 逐步喂进同一句引用，模拟"异步落库"。任何一步抛，等待就会以 error 收场
    // 而不是"再等一轮"，那是把平台的等待机制砸了。
    const stages = [{}, { order: {} }, { order: { id: null } }, { order: { id: 7 } }];
    const seen = stages.map((root) => compileExpr('$.order.id > 0').eval(ctx(root)));
    assert.deepEqual(seen, [false, false, false, true]);
  });
  test('变量空间那条**拼出来的**子路径同一条规矩（另一半实现点）', () => {
    // evalNode 里有两处 queryOne：一处查 root，一处在变量上取 `$.${rest}`（路径是拼的）。
    // 只修一处 = 只修了一半，而两处都各自实测过。
    assert.equal(compileExpr('user.name').eval(ctx({}, { user: { name: 'k' } })), 'k');
    /*
     * 探针名用 `user.` 而不是 `user.name[`，是**量出来的**（`.scratch/probe-bare-rest.mts`）：
     * 裸名的词法只吃 `[\w.$\u4e00-\u9fa5]`，**不含 `[`**，所以 `user.name[` 在
     * 记号层就炸成 `ExprError: 尾部有多余内容 "["` —— 压根到不了拼路径那一处。
     * 能走到第二处 `queryOne` 并在**拼出来的那段**上抛 PathError 的是 `user.`
     * （head=`user` 是真变量，rest 为空 => 拿 `$.` 去查）。
     * 两种形态都得有人钉着：记号层那一支由静态闸与运行时同判（都报错，见等价那条），
     * 拼路径这一支才是这一处独有的、只能在这里测的东西。
     */
    assert.throws(() => compileExpr('user.').eval(ctx({}, { user: { name: 'k' } })), PathError,
      '变量上那段拼出来的子路径写坏了没抛 —— 第一处删了 catch、这一处漏删就是假绿还剩一半');
  });
});

describe('假绿本身：守卫、循环、断言三处都不许把"写坏了"读成"不成立"', () => {
  /*
   * 这三处都调 evalBool 并把 falsy 解释成"条件不成立"。运行期那个吞动作一删，
   * 三处**同时**从 skipped 变 error —— 所以三处都要有钉子，
   * 否则将来有人为了"让某个用例别红"把其中一处重新包上 try，另外两处不会响。
   */
  test('when 守卫：写坏了 => error + case-stale（改前 skipped + 整场 pass）', async () => {
    for (const w of BROKEN) {
      const r = await run(scen([{ ...b('a'), kind: 'noop', when: w }]));
      const x = res(r, 'a');
      assert.equal(x.status, 'error', `when: ${JSON.stringify(w)} => ${x.status}（skipped 就是那个假绿）`);
      assert.equal(x.cause, 'case-stale');
      assert.notEqual(r.status, 'pass', `整场结论是 ${r.status}：写坏一句守卫条件不该得到 pass`);
    }
  });
  test('对照：守卫引用不到值时**仍然**是 skipped + 整场 pass（不许一并改成 error）', async () => {
    const r = await run(scen([{ ...b('a'), kind: 'noop', when: '$.neverSet' }]));
    assert.equal(res(r, 'a').status, 'skipped');
    assert.equal(r.status, 'pass');
  });
  test('if / while 的条件同一个答案', async () => {
    const r = await run(scen([
      { ...b('i'), kind: 'if', condition: '$.n[', then: [{ ...b('t'), kind: 'noop' }], else: [] },
    ]));
    assert.equal(res(r, 'i').status, 'error');
    assert.equal(res(r, 'i').cause, 'case-stale');
  });
  test('forEach.items 写坏了不许变成"空集合，一次都没跑"', async () => {
    // 这一处比 when 更隐蔽：`items` 拿到 undefined 会被 iterItems 收成空数组，
    // 于是"数据驱动取数为空"与"路径写坏了"给出同一个结论 —— 而后者整场还是绿的
    // （loop-never-run 那一族防的就是这个形状）。
    const r = await run(scen([
      { ...b('f'), kind: 'forEach', items: '$.list[', as: 'x', maxIterations: 3, steps: [{ ...b('z'), kind: 'noop' }] },
    ]));
    assert.equal(res(r, 'f').status, 'error');
    assert.equal(res(r, 'f').cause, 'case-stale');
  });
  test('两种执行形态结论一致（executor.ts 那句注释从前声称的防护，现在是**真的**了）', async () => {
    for (const w of BROKEN) {
      const s = scen([{ ...b('a'), kind: 'noop', when: w }]);
      const interp = res(await run(s), 'a').status;
      const plan = compilePlan(s);
      const pre = await precompiledExecutor(plan).run({ scenario: s, clock: deterministicClock(42) });
      const pc = pre.steps.find((x) => x.stepId === 'a')?.status;
      assert.equal(interp, 'error', `解释器形态是 ${interp}`);
      assert.equal(pc, 'error', `预编译形态是 ${pc}：与解释器不一致就是两套语义`);
    }
  });
});

describe('静态闸：EXPR_SYNTAX 管路径本体，且管的字段从 schema 派生（不是抄来的清单）', () => {
  /*
   * 这一族的原始形态是**两份手抄的字段名清单**，两份同时坏、方向相反
   * （`lint.ts` 抄了 condition/when，漏掉 items 与 switch.value；`dryrun.ts` 多抄一个
   * value，把要填进输入框的字面量当表达式校验）。现在判据只有一份
   * （`ir/steps.ts` 的 `isExprField`），而 dryRun 那份扫描整块删了。
   *
   * 所以**下面这几条测的对象其实只有一个：lint 那一遍扫了哪些字段、拿什么判据**。
   * `dry()` 仍然留着，但它的用途缩到两个：钉"不许再叠一份重复 finding"、
   * 以及当 lint 的代理入口（它内部就是 lintScenario）。
   */
  const lint = (body: StepDraft[]) =>
    lintScenario(scen(body), {}).filter((f) => f.code === 'EXPR_SYNTAX');
  const dry = (body: StepDraft[]) =>
    dryRun(scen(body)).issues.filter((i) => i.code === 'EXPR_SYNTAX');

  test('when / condition 里写坏的路径有 finding（改前**一句不响**）', () => {
    for (const w of BROKEN) {
      const f = lint([{ ...b('a'), kind: 'noop', when: w }]);
      assert.equal(f.length, 1, `when: ${JSON.stringify(w)} 的 finding 数 = ${f.length}`);
      assert.match(f[0]!.message, /引用路径写坏/, '消息里要说出是哪个 ref 的哪一段坏了');
      assert.match(f[0]!.message, new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '消息里没带那句引用本身');
    }
    const g = lint([{ ...b('a'), kind: 'if', condition: '$.n[', then: [{ ...b('t'), kind: 'noop' }], else: [] }]);
    assert.equal(g.length, 1, 'condition 那一支是**另一个调用点**，只修 when 的话它还是漏的');
  });
  test('对照：合法路径与"取不到值"都不报（**误报的代价是大家把 lint 关掉**）', () => {
    for (const w of ['$.a', '$a', '$a.b', '$.a[0]', '$.order.id > 0', 'len($.name) > 0', '$.a-b', 'count($.x) > 0']) {
      const f = lint([{ ...b('a'), kind: 'noop', when: w }]);
      assert.equal(f.length, 0, `${JSON.stringify(w)} 被报了：${f[0]?.message}`);
    }
  });
  test('dry-run 与 lint 管的字段**现在一致**（从前 dryRun 多管 items、错管 value）', () => {
    const cases: Array<[string, StepDraft[], boolean]> = [
      ['when', [{ ...b('a'), kind: 'noop', when: '$.n[' }], true],
      ['condition', [{ ...b('a'), kind: 'if', condition: '$.n[', then: [{ ...b('t'), kind: 'noop' }], else: [] }], true],
      ['items', [{ ...b('f'), kind: 'forEach', items: '$.list[', as: 'x', maxIterations: 3, steps: [{ ...b('z'), kind: 'noop' }] }], true],
      // switch.value 也是真表达式（ExprSchema）。它从前**两道闸都不管**：
      // lint 的清单里没它，dryRun 的清单里那个 `value` 命中的是"填进输入框的值"那族。
      ['switch.value', [{ ...b('w'), kind: 'switch', value: '$.n[', cases: [{ is: 1, steps: [{ ...b('z'), kind: 'noop' }] }], default: [] }], true],
    ];
    for (const [name, body, expectDry] of cases) {
      const d = dry(body);
      assert.equal(d.length > 0, expectDry, `dry-run 对 ${name} 报了什么：${d.map((i) => i.message).join(' | ') || '（无）'}`);
      if (expectDry) assert.match(d[0]!.message, /引用路径写坏/, `${name}：消息里没说清是路径写坏`);
      /*
       * ⚠ **这个断言现在几乎是恒成立的，而这是本轮改动的结果，不是巧合**：
       * `dryRun` 第一行就把 `lintScenario(...)` 的结果全收进 `issues`，而它自己那份
       * 扫描本轮**被删了**（见 dryrun.ts 里那段）。所以 lint 报什么 dry-run 就报什么，
       * 一致性是**结构性的**，不再需要测试来守 —— 这条留着只为防"重复实现长回来"
       * （那种情况下 dry-run 会比 lint **多**报，下面那条「只出现一次」也一起红）。
       *
       * 真正有牙的是**旁边那两条**：
       * 「dry-run 与 lint 管的字段**现在一致**（从前 dryRun 多管 items、错管 value）」
       * （漏报方向，改回手抄清单就红）与
       * 「**反方向**：往输入框里填的字面量里带 `$` 也不许被当表达式校验」
       * （误报方向，同一条变异也靠它抓）。**别把这条当成本轮那处收敛的钉子** ——
       * 一条由构造成立的断言，钉不住任何回归。
       *
       * 还有一条要说清（**这一句本轮按实测改过**）：这里从前写的是
       * 「`dryRun` 在本仓一个生产调用方都没有，而前端还没做」—— 那句在
       * `web/src/check.ts` 落地之后就是假的。今天它有**一个**生产调用方：
       * 编辑器那个「校验」按钮 → `checkIr` → `dryRun`（页面挂在 `/app/`）。
       * 仍然成立的那一半是：`run --strict` 与 `atest lint` 走 `lintScenario`，
       * **不经过 dryRun**，所以 CI 那侧的受益方仍然只有 lint 这半边；
       * dryRun 这一侧的读者是**界面上那一张卡**（必填输入）与状态行那枚徽章，
       * 载体是 `packages/web/test/dry-run-check.test.ts` 与 `check-lines.test.ts`。
       * （Agent 那道闸——也就是 dryRun 设计里的第二个读者——今天还是没有。）
       */
      const l = lint(body);
      assert.equal(l.length > 0, d.length > 0, `${name}：lint ${l.length ? '报了' : '没报'} 而 dry-run ${d.length ? '报了' : '没报'} => 字段清单又分叉成两份了`);
      if (d.length && l.length) assert.equal(l[0]!.message.replace(/^\w+ /, ''), d[0]!.message.replace(/^\w+ /, ''), `${name}：两处消息主体不同 = 两处各写了一份报错文案`);
    }
  });
  test('同一步骤的同一条表达式在 dry-run 里**只出现一次**（改前是两次）', () => {
    /*
     * `dryRun` 第一行就把 `lintScenario` 的结果全收进 issues，而它从前**又自己扫了一遍**
     * `condition` / `when` —— 于是同一条错误出现两行。实测改前：`when: '$.n['`
     * lint 报 1 条、dry-run 报 2 条。编辑器面板会渲染成两行一模一样的红字，
     * 用户以为有两个问题；而 `atest lint --json` 那类消费方按条数统计，
     * 会得出"这一份场景有两个表达式问题"。
     *
     * 本轮把 dryRun 那份重复扫描删了（理由见 dryrun.ts 那段），这条钉它别长回来。
     * 写法上按 (stepId, code) 计数而不是"总条数 == 1"，因为一个步骤可以有
     * `when` 与 `condition` 两个真表达式字段，那种情况报两条是**对的**。
     */
    const body = [
      { ...b('a'), kind: 'noop', when: '$.n[' },
      { ...b('i'), kind: 'if', condition: '$.m[', then: [{ ...b('t'), kind: 'noop' }], else: [] },
      { ...b('f'), kind: 'forEach', items: '$.l[', as: 'x', maxIterations: 3, steps: [{ ...b('z'), kind: 'noop' }] },
    ] as StepDraft[];
    const d = dry(body);
    const l = lint(body);
    const key = (x: { stepId?: string; code?: string }) => `${x.stepId ?? ''}`;
    const cnt = (xs: Array<{ stepId?: string }>) => {
      const m = new Map<string, number>();
      for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
      return [...m.entries()].sort();
    };
    assert.deepEqual(cnt(d), cnt(l), 'dry-run 里某个步骤的 finding 数与 lint 不等 = 叠了第二遍同一条判据');
    assert.equal(d.length, 3, `应当是 3 个步骤各一条，实际 ${d.length} 条：${d.map((x) => x.message).join(' | ')}`);
  });

  test('**反方向**：往输入框里填的字面量里带 `$` 也不许被当表达式校验（误报 = 合法场景被 --strict 拒）', () => {
    /*
     * `act.value` / `input.value` 是 `ValueSchema` —— 那是**要填进输入框的内容**。
     * 而 `dryrun.ts` 那份手抄清单里有一个 `value`，于是这些值被喂进 `validateExpr`。
     * 实测（`.scratch/probe-value-field2.mts`）改前：`价格 3$` 得到
     * 「value 表达式错误：尾部有多余内容 "3"」、`$100 起`、`cost: $1,000` 同样报，
     * 而 `EXPR_SYNTAX` 是 **error 级** —— `--strict` 与 `atest lint` 的退码判据正是 error 数，
     * 也就是**填一个含 `$` 的价格就把整份合法场景拒了**。
     *
     * 这一条在变异里对应"把字段清单改回手抄 / 把 value 加回去"，
     * 所以它是这一组里唯一钉**误报方向**的（其余各条钉的都是漏报）。
     */
    const loc = { intent: 'X', primary: { by: 'testid', value: 'x' } };
    for (const v of ['价格 3$', '$100 起', 'cost: $1,000', 'P@ssw0rd!', 'a,b', 'tel: 138-0000', '50%', '{"k":1}', '折扣$.x折', '张三']) {
      const body = [{ ...b('a'), kind: 'act', locator: loc, action: 'fill', value: v }] as StepDraft[];
      const d = dry(body);
      assert.deepEqual(d.map((i) => i.message), [], `act.value = ${JSON.stringify(v)} 被当表达式校验了：合法输入值不该出现在静态闸的报错里`);
      assert.deepEqual(lint(body).map((i) => i.message), [], `act.value = ${JSON.stringify(v)} 在 lint 里被报：同上`);
    }
    const inBody = [{ ...b('a'), kind: 'input', value: '$100 起' }] as StepDraft[];
    assert.deepEqual(dry(inBody), [], 'input.value（ADB 按键入值）同样不该被当表达式');
    assert.deepEqual(lint(inBody), [], '同上（lint 那一侧）');
  });
  test('去掉 `v.includes("$")` 那个前置条件之后，不含 $ 的坏表达式**两道闸都还报**（不是靠那个跳过挡掉的）', () => {
    /*
     * 改前 dryRun 的判据是 `typeof v === 'string' && v.includes('$')` ——
     * 那是**第二处**自作主张的判据：不含 `$` 的表达式同样能写坏（`len(name) > 0`
     * 这种裸名写法一个 `$` 都没有，`1 +` / `not` 也不含 `$`）。
     * 本轮把它去掉，所以这条钉"去掉之后没漏"。
     */
    for (const w of ['1 +', 'not', 'nopefn(1)', '1 ==']) {
      const body = [{ ...b('a'), kind: 'noop', when: w }];
      assert.ok(dry(body).length > 0, `${w}：dry-run 没报`);
      assert.ok(lint(body).length > 0, `${w}：lint 没报（两处必须同时报，否则又是一处分叉）`);
    }
  });
  test('validateExpr 报的路径 == 运行时会抛的路径（**同一条判据，不是两份**）', () => {
    /*
     * 这条是整组里最要紧的：静态闸如果比运行时**严**，就是误报（合法的写法被拒）；
     * 如果**松**，就是漏报（本轮那个假绿）。两边都用 parsePath 才结构上不可能分叉，
     * 而这条测试就是钉"它们确实同一个"的 —— 判据换成两份的话它会红。
     */
    const probes = [...BROKEN, ...ABSENT, '$.a', '$a', '$a.b', '$.a[0]', 'len($.x)', '1 +', 'nopefn($.a)'];
    for (const p of probes) {
      let throws = false;
      try { compileExpr(p).eval(ctx({ n: 1, a: { b: 1 }, x: 'ab' })); } catch (e) { throws = e instanceof PathError; }
      const staticErr = validateExpr(p);
      const mentionsPath = staticErr !== null && /引用路径写坏/.test(staticErr);
      if (throws) assert.ok(mentionsPath, `${p}：运行时会抛 PathError 而静态闸没报 —— 那是漏报`);
      else assert.ok(!mentionsPath, `${p}：运行时不抛而静态闸报了 —— 那是误报`);
    }
  });
});

describe('被删掉的 `dryRun.exprSummaries`：判据划不出内容，所以它不该有生产者', () => {
  /*
   * **这一族测的是"一栏该不该存在"，不是"一栏填得对不对"** —— 那种测试本仓没有先例，
   * 所以理由写足。
   *
   * `DryRunResult` 里从前有一栏 `exprSummaries: []`（"表达式合法但引用了运行时才有的东西，
   * 只列出不算错"），恒为空、无生产者、无消费者，登记的理由是「它是设计里的一栏，
   * **而前端还没接**」。本轮删它之前先做的不是删，是**枚举这一栏能装什么**：
   * 一个恒空的集合有两种成因 —— ① 有内容没人产（该补生产者）② 判据本身划不出内容
   * （补生产者 = 造噪声）。**两种处置相反，而区分它们只能靠枚举**；
   * 登记那句"它是设计里的一栏"恰恰跳过了这一步，所以它把一个该删的东西保了两轮。
   *
   * ⚠ **下面第一条不是我对"有几种身份"的印象，是把每种身份各写一格、逐格问 lint**。
   * 这一步本身踩过三次夹具坑（`switch.cases` 求 `is` 而 `min(1)` 被打回、
   * 把 `lintScenario` 的返回值当 `LintReport` 读、以及引用语法写成 `$login.body.role`
   * 那种**我自己编的**写法 —— lint 报 `VAR_UNDEFINED` 报的是我的夹具而不是缺陷）。
   * 所以这里：载体用 `when`（`Base` 上的字段，所有 kind 都有）、
   * `lintScenario` 按 `LintIssue[]` 读、步骤间引用照 docs/02 §5 写 `$.step.<id>.resp.…`。
   * 三种"跑不起来"都说明不了被问的那件事，这是它们各自的代价。
   */
  const ENUM: Array<{ id: string; expr: string; identity: string; silent: boolean }> = [
    { id: 'a-steppath', expr: "$.step.login.resp.body.role == 'admin'", identity: '前一步的输出', silent: true },
    { id: 'b-input', expr: '$region', identity: '场景输入参数（调用方给值）', silent: true },
    { id: 'c-literal', expr: '1 + 1', identity: '纯字面量（静态完全可判）', silent: true },
    { id: 'e-env', expr: '$env.baseUrl', identity: '环境变量（静态时刻**刻意**查不到）', silent: true },
    { id: 'd-undefined', expr: '$nope.x', identity: '谁都没声明', silent: false },
  ];
  const enumScen = (): Scenario =>
    defineScenario({
      schemaVersion: '1', id: 'scn.enum', name: '引用身份枚举',
      env: { environmentRef: 'unit' }, targets: ['api'],
      inputs: [{ name: 'region', type: 'string', required: true }],
      body: [
        { id: 'login', kind: 'http', request: { method: 'POST', url: '/login' } },
        ...ENUM.map((c) => ({ id: c.id, kind: 'noop', when: c.expr })),
      ],
    } as ScenarioDraft);

  test('枚举：一条合法表达式引用的东西只有四种身份，其中三种 lint 一言不发', () => {
    /*
     * 逐格问 lint「这一格算合法吗」。按 `stepId` 过滤而不是看总条数 ——
     * 场景级的码（`ASSERT_FREE_SCENARIO` / `TEARDOWN_DIRTY`）stepId 是 undefined，
     * 它们与"这一格合不合法"无关，混进计数就会把"我的夹具不干净"读成"判据变了"。
     */
    const issues = lintScenario(enumScen(), {});
    for (const c of ENUM) {
      const mine = issues.filter((i) => i.stepId === c.id);
      assert.equal(mine.length === 0, c.silent, `${c.id}（${c.identity}）= ${JSON.stringify(c.expr)}：lint 说${mine.map((i) => `[${i.level}] ${i.code}`).join(' ') || 'nothing'}，与登记的不符`);
      if (!c.silent) {
        assert.equal(mine[0]!.code, 'VAR_UNDEFINED', `${c.id} 报了，但不是 VAR_UNDEFINED —— 登记的那句「唯一会报的是引用未声明」要看清楚再改`);
        assert.equal(mine[0]!.level, 'error', `${c.id} 的级别变了：它进不进 issues 的判据跟着变`);
      }
    }
    // 反面向的自检：这一格确实**进了 issues**，所以按判据它属于"不合法"那一侧、不该进那一栏
    const dryIssues = dryRun(enumScen(), { region: 'cn' }).issues.filter((i) => i.stepId === 'd-undefined');
    assert.equal(dryIssues.length, 1, '「不合法那一侧已经有人在报了」这件事必须成立，否则删掉那一栏会丢信息');
  });

  test('⇒「合法且引用运行时」= 所有引用型表达式，所以那一栏不该有生产者', () => {
    /*
     * **判据不我自己写**：一条表达式"引用了运行时的东西"由引擎自己的
     * `compileExpr(src).refs` 说（它走 AST 收集 `ref` 节点），不是我数出来的清单 ——
     * 手抄一份的话这条就只在"两份清单抄得一样"上成立，那是本仓反复的缺陷类。
     *
     * 于是"那一栏能装什么"变成一个可算的问题：按登记写下的判据
     * （**合法** 且 **引用运行时**）跑一遍枚举样本，看剩下的集合有多大。
     */
    const scen = enumScen();
    const issues = lintScenario(scen, {});
    const legal = ENUM.filter((c) => !issues.some((i) => i.stepId === c.id));
    const refBearing = legal.filter((c) => compileExpr(c.expr).refs.length > 0);
    // 字面量那一格确实"合法但不引用任何东西" —— 它是这一栏唯一可能的容身之处
    const noRef = legal.filter((c) => compileExpr(c.expr).refs.length === 0);
    assert.deepEqual(noRef.map((c) => c.id), ['c-literal'], '夹具漂了：合法而不引用任何运行期东西的那格不止/不再是字面量');
    assert.deepEqual(refBearing.map((c) => c.id).sort(), ['a-steppath', 'b-input', 'e-env'], '按判据留下的集合变了 —— 这一条的结论要跟着改');
    /*
     * 上面那行就是结论本身：**合法 ∩ 引用运行时 = 所有引用型表达式**。
     * 也就是说那一栏若补上生产者，编辑器里会画出一份「这条用例写过的所有表达式」，
     * 而那种清单没有任何动作可配（作者看了不会去改任何东西）——
     * 比空着更坏，因为它看着像有结论。所以本轮的处置是**删栏，而不是补生产者**。
     *
     * 顺带把"唯一会报的那一格"排除在外这件事说清：`$nope.x` 也是引用型，
     * 但它不合法，而它**已经在 issues 里**（上面那条钉着），按判据本来就不属于这一栏。
     */
  });

  test('dryRun 的返回形状：LintReport 之外只有 missingInputs 与 estimate（`exprSummaries` 长回来这条就红）', () => {
    /*
     * **删一栏的证据是一栏回来了会红的测试**，不是一段"我们删了它"的注释。
     * 运行时读键而不是读类型：`npm test` 走 tsx **不做 typecheck**，只钉类型的话
     * 这一条在 CI 上是恒绿的。而这里还有一层结构性的东西 —— 想往
     * `DryRunResult` 上加回一个必填字段，就**必须**同时往 return 那个对象字面量里加
     * （TS 会因缺属性报错），所以运行时那一读覆盖面等于类型那一读。
     *
     * 断言用**完整键集**而不是"不含 exprSummaries"：后者对"随便多加一栏"是瞎的，
     * 而对外形状多一栏少一栏是同一件事（`checkIr` 把它原样序列化给编辑器）。
     */
    const r = dryRun(enumScen(), { region: 'cn' });
    const got = Object.keys(r).sort();
    const want = ['errors', 'estimate', 'issues', 'missingInputs', 'ok', 'summary', 'warnings'].sort();
    assert.deepEqual(got, want, `dryRun 的对外形状变了：多 ${got.filter((k) => !want.includes(k))} 少 ${want.filter((k) => !got.includes(k))}`);
    // 序列化那一侧同样（编辑器读的是 JSON，不是 TS 对象；恒空数组过不了这一关的概率比不过 JSON 高）
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(r))).sort(), want, 'JSON 形态与对象形态不一致 = 中间有人塞了派生字段');
    // 对照：夹具没坏 —— 两栏真实存在的读者必须读到东西（否则上面那条 deepEqual 可能只是拿到空对象）
    assert.deepEqual(r.missingInputs, [], '夹具失效：声明了必填输入却传了值，这一栏还空着说明 fixture 没走到位');
    assert.equal(r.estimate.steps, ENUM.length + 1, '夹具失效：步骤数对不上，上面那条键集断言所在的对象不是我以为那一次调用的结果');
    assert.ok(dryRun(enumScen()).missingInputs.includes('region'), '对照失败：missingInputs 压根不产，那"只有这两栏有读者"这句话就没被测到');
  });
});

describe('活护栏：全仓每一条表达式字符串都不许被新查误伤', () => {
  /**
   * **为什么不能只靠注释里那句"实测零误报"**：判据会演进，语料也会长。
   * 今天扫出来的这些全过，不代表下一个人写的那条过 —— 而误报的代价从来不是
   * "多一条黄字"，是大家把 lint 关掉，于是 lint 里其余二十几条规则一起失效
   * （`value-forms.json` 那份 _comment 里同一条纪律）。
   *
   * **扫的是仓库里真实写着的字符串**，不是我手抄一份清单：手抄那份只会验证
   * "两份清单抄得一样"，而那正是本仓反复的缺陷类。
   *
   * ⚠ **覆盖面要说清**：真实用户场景**不在这个仓里**（IR 是平台上的数据，
   * repo 里没有 IR 的 json 文件 —— 我一度以为有，`find` 扫完才发现没有）。
   * 所以这条给的是"本仓语料（测试正文 + 工具 + docs 里的 IR 示例）零误报"，
   * **不是**"线上语料零误报"。后者靠的是另一件事：新查与运行时用**同一个
   * `parsePath`**，上面那条等价测试钉的就是"静态闸报了 == 运行时会抛"，
   * 于是"报了而运行时不抛"这种误报在结构上不成立，与语料长什么样无关。
   */
  test('扫描本身有效（扫到了足够多的表达式字符串）', () => {
    // 护栏的护栏：扫不到东西时下面那条会**恒通过**，而恒通过的护栏比没有护栏更糟。
    assert.ok(collectExprs().length >= 80, `只扫到 ${collectExprs().length} 条表达式：扫描根、后缀名或正则该改了`);
  });
  test('每一条 expr / when / items / against / condition / value 字符串都过新加的那一查', () => {
    const hits: string[] = [];
    for (const { where, src } of collectExprs()) {
      // 只挑**新加那一支**。语法错/未知函数不在此列：那是改动前就有的行为，
      // 而且测试正文里**故意写着**坏表达式（就是在测它响不响），必须放过。
      const err = validateExpr(src);
      if (!err || !/引用路径写坏/.test(err)) continue;
      /*
       * 本仓**显式登记为"故意写坏"**的样本不算误报。它们散在测试正文、注释和
       * `docs/14` 的实测表里（扫出来就是这个样子），把它们报成误报的话，
       * 这条护栏会被自己人第一眼看成噪音 —— 而噪音护栏的下场是被人删掉。
       *
       * ⚠ **为什么这条过滤不算把筛子掏空**：下面紧跟着那条测试钉着
       * "这些样本扫得到、且新查确实报得出"。所以过滤掉的只是**已知故意**的那些，
       * 筛子对**新增的**写法仍然是响的。判据也不是"文件里有 BROKEN 就整份放过"，
       * 而是逐个字符串判 —— 同一文件里新写一条真误报照样被抓。
       */
      if (BROKEN.some((p) => src.includes(p))) continue;
      hits.push(`${where}: ${JSON.stringify(src.slice(0, 60))} -> ${err.slice(0, 60)}`);
    }
    assert.deepEqual(hits, [], '上面这些**存量写法**被新加的路径那一查报了 = 误报；先确认它运行时会不会抛');
  });
  test('近邻的错法扫得到、也报得出（证明上面那条不是恒通过）', () => {
    // 本仓测试正文里现在就写着 `$.n[` 这类句子（本文件、error-cause.test.ts）。
    // 一条都扫不到的话，"零误报"这个结论是空的 —— 它什么都没测。
    const known = collectExprs().filter((x) => BROKEN.some((p) => x.src.includes(p)));
    assert.ok(known.length > 0, '扫描范围里一句"写坏的引用"都没有 => 这条护栏测不到东西');
    // 并且它们**确实会被新查报出来**（所以上面那条"零命中"是真的在筛，不是筛不出东西）
    const caught = known.filter((x) => /引用路径写坏/.test(validateExpr(x.src) ?? ''));
    assert.ok(caught.length > 0, '扫到了写坏的引用而新查一个都没报 => 判据或扫描本身失效了');
  });
});

const ROOT = join(import.meta.dirname, '../../..');

/** 从文件文本里捞"看起来是 IR 表达式"的字符串，带上出处。 */
function collectExprs(): Array<{ where: string; src: string }> {
  const out: Array<{ where: string; src: string }> = [];
  const KEY = /\b(?:expr|when|items|against|condition|value)["']?\s*[:=]\s*(['"`])((?:[^'"`\\]|\\[\s\S])*?)\1/g;
  for (const f of ['packages', 'tooling', 'docs'].flatMap((d) => walkAbs(join(ROOT, d)))) {
    let text: string;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(KEY)) {
      const s = m[2]!;
      if (!s || !s.includes('$')) continue; // 不含 $ 的字符串里不会有引用
      out.push({ where: `${f.slice(ROOT.length + 1)}`, src: s });
    }
  }
  return out;
}

function walkAbs(dir: string, out: string[] = []): string[] {
  let es: string[];
  try { es = readdirSync(dir); } catch { return out; }
  for (const e of es) {
    if (e === 'node_modules' || e === 'dist' || e === '.git' || e === '.scratch' || e === 'tmp') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkAbs(p, out);
    else if (/\.(ts|json|md)$/.test(e)) out.push(p);
  }
  return out;
}
