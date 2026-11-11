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

describe('静态闸：EXPR_SYNTAX 现在也管路径本体（只修运行期的话这一组全红）', () => {
  /*
   * 两道闸**分开测**，因为它们不是同一份代码：
   *  - `lintScenario` 只看 `condition` 与 `when`（lint.ts 里两处 `validateExpr`）；
   *  - `dryRun` 自己再扫一遍 `condition / when / value / items` 四个字段。
   * 合成一个 `findings()` 就查不出"dry-run 扫了而 lint 没扫"这种半拉子 ——
   * 而那正是 `items` 这一族的形状（下面那条钉它）。
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
  test('dry-run 也响，且**管的字段比 lint 宽**（但它今天没有生产调用方 —— 别把这条读成"CI 会拦"）', () => {
    // `items` 在 lint 里压根不查，只有 dryRun 查。这一条同时钉住两件事：
    // "这一族没被漏掉" + "两道闸覆盖面不同这件事本身别在改代码时被人抹平"。
    const cases: Array<[string, StepDraft[], boolean]> = [
      ['when', [{ ...b('a'), kind: 'noop', when: '$.n[' }], true],
      ['condition', [{ ...b('a'), kind: 'if', condition: '$.n[', then: [{ ...b('t'), kind: 'noop' }], else: [] }], true],
      ['items', [{ ...b('f'), kind: 'forEach', items: '$.list[', as: 'x', maxIterations: 3, steps: [{ ...b('z'), kind: 'noop' }] }], true],
    ];
    for (const [name, body, expectDry] of cases) {
      const d = dry(body);
      assert.equal(d.length > 0, expectDry, `dry-run 对 ${name} 报了什么：${d.map((i) => i.message).join(' | ') || '（无）'}`);
      if (expectDry) assert.match(d[0]!.message, /引用路径写坏/, `${name}：消息里没说清是路径写坏`);
    }
    /*
     * ⚠ **这条测的是"引擎里那个函数会报"，不是"CI 会拦"**，两者差得很远：
     * `dryRun` 在本仓**一个生产调用方都没有**（`grep -rn dryRun packages tooling`
     * 除了自己的定义与这条测试只剩 `dist/` 里的产物）。它的定位是"编辑器常驻面板
     * + Agent 的第三道闸"（dryrun.ts 文件头），而前端还没做。`run --strict` 走的是
     * `lintScenario`（commands.ts），**不经过 dryRun**。
     * 所以 `items` 写坏了，**今天生产里没有任何静态闸报它** —— 只有本轮修好的运行期
     * 那一半兜着（该步 error + case-stale）。别把这条测试读成"items 有人静态管着"。
     * lint 不查 items 也不是"漏了一行"那么轻：那一串的字段名是手抄的，
     * 抄这件事本身的后果见 docs/14 §5「dryRun 那份字段名清单」那一行。
     */
    const itemsLint = lint([{ ...b('f'), kind: 'forEach', items: '$.list[', as: 'x', maxIterations: 3, steps: [{ ...b('z'), kind: 'noop' }] }]);
    assert.equal(itemsLint.length, 0, 'lint 现在开始管 items 了：把上面那条的期望与这里一起改掉');
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
