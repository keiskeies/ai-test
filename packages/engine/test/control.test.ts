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

  test('items 指向不存在的变量 => error，不能静默迭代 0 次', async () => {
    // 与下面 while 撞上限那条同一条原则：**"看起来正常结束了"是最贵的静默**。
    // 实测改动前：`items:'$list'` 与 `items:'list'` 两种写法都是 `loop=pass` + "迭代 0 次"
    // + 场景整体 pass —— 数据驱动用例最典型的失效方式（变量名拼错 → 整段没跑 → 绿）。
    // 注意 `$list` 也一样：`$` 前缀不会让未定义变成异常，expr 求值一样给 undefined。
    for (const items of ['$list', 'list']) {
      const r = await run(scen([
        { ...b('loop'), kind: 'forEach', items, as: 'x', maxIterations: 5,
          steps: [{ ...b('n'), kind: 'noop' }] },
      ]));
      assert.equal(r.status, 'error', `items=${items} 时不该是绿的`);
      assert.equal(res(r, 'loop').status, 'error', `items=${items}`);
      assert.equal(res(r, 'loop').cause, 'case-stale',
        'cause 必须是用例问题而不是环境问题，否则值班人去查一个好好的环境');
      assert.equal(r.results.filter((x) => x.stepId === 'n').length, 0, '循环体一步都不该跑');
    }
  });

  test('items 是**真实存在的空数组**仍然合法迭代 0 次（不能把上一条的错误码当成"零迭代一律错"）', async () => {
    // 这条是上一条的**窄性对照**。少了它，"未定义要报错"就会被实现成"空数组也报错"，
    // 而空列表在数据驱动里完全合法（这一批恰好没数据）。
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { rows: [] } },
      { ...b('loop'), kind: 'forEach', items: '$rows', as: 'x', maxIterations: 5,
        steps: [{ ...b('n'), kind: 'noop' }] },
    ]));
    assert.equal(r.status, 'pass', '空数组是合法输入，不是用例错误');
    assert.equal(res(r, 'loop').status, 'pass');
  });

  test('items 是显式 null 时仍按空表处理（undefined 与 null 的区别就是这条判据的全部依据）', async () => {
    // 这条不是凑数：**"只管 undefined、不管 null" 是本判据的唯一立足点**，
    // 而它一度只是注释里的一句话 —— 变异「把 null 也当错误」当场活下来证明了这点。
    // 立场：undefined 的含义窄到只剩"这个名字压根不存在"（多半是拼错），
    // 而 null 是人显式写进去的**一个值**，`set rows = null` 之后迭代它，
    // 说"没数据"比说"用例写错了"更贴近事实。真要收口成"null 也算错"，
    // 得连这条测试与 resolve.ts 的注释一起改，别只改实现。
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { rows: null } },
      { ...b('loop'), kind: 'forEach', items: '$rows', as: 'x', maxIterations: 5,
        steps: [{ ...b('n'), kind: 'noop' }] },
    ]));
    assert.equal(r.status, 'pass', '显式 null 是合法的空数据，不是用例错误');
    assert.equal(res(r, 'loop').status, 'pass');
  });

  test('while 条件第一次就为假 => 循环体在结果里记 skipped，而不是从报告里消失', async () => {
    /*
     * 这条盯的是 docs/08 登记的 `LOOP_CEILING_HIT` 同族另一半：撞上限有事件，
     * **一次都没进**却什么都不留。改动前实测（体内一条断言、体外一条真断言）：
     * 场景 pass、退出码 0、门禁理由写着「1 条断言全部通过」，
     * 而体里那条断言压根没跑 —— 报告里连它的行都没有，所以谁也不会去查它。
     *
     * **为什么不满足于「发一条 lint 事件」**：门禁不读 events（gateAfterRun 里
     * 一处 events 都没有），而预编译形态压根没有事件通道。两个理由各自都足以
     * 让"有事件"变成"只有人眼能看见"，所以这里钉的是 **results 里有一行**。
     */
    const r = await run(scen([
      { ...b('seed'), kind: 'set', assign: { n: 5 } },
      { ...b('w'), kind: 'while', condition: '$n < 3', maxIterations: 5,
        steps: [{ ...b('body'), kind: 'assert', against: '$n', jsonPath: { $: { eq: 5 } } }] },
    ]));
    assert.equal(res(r, 'body').status, 'skipped', '没跑的循环体步骤必须有一行 skipped');
    assert.match(res(r, 'body').assertionSummary ?? '', /一次都没进循环/,
      '要能说出为什么没跑，否则一个孤零零的 skipped 和没有它一样难查');
    assert.ok(
      r.events.some((e) => e.kind === 'lint.reported' && e.data?.code === 'LOOP_BODY_NEVER_RUN'),
      '同时要有 lint 事件（给人看的通路），但它不能是唯一的通路',
    );
  });

  test('空数据/零次循环的容器自己仍报 pass，补的行是 skipped 而不是 fail', async () => {
    // **窄性对照**，两边都得钉住，少一边就会被实现反掉：
    //  - 容器报 skipped/fail 会改场景状态与通过率分母（空数据是合法输入，不是用例错误，
    //    与上面「真实存在的空数组仍然合法迭代 0 次」同一条立场）；
    //  - 补的行报 fail 就是「没跑」被算成「跑坏了」—— 把数据问题报成产品 bug。
    // 更深的一层：forEach/while 的循环体一遇到非 pass/healed 就 return，
    // 所以嵌套时内层报 skipped 会**静默截掉外层剩下的轮次**。
    // kind 直接放在条目上而不是嵌进 step 里：嵌一层之后 `${c.kind}` 在类型上就是错的，
    // 而 `npm test` 用 tsx 跑、**不做类型检查**，这种错只有 typecheck:test 看得见。
    const cases = [
      { id: 'w', kind: 'while', step: { condition: 'false', maxIterations: 5 } },
      { id: 'f', kind: 'forEach', step: { items: '$rows', as: 'x', maxIterations: 5 } },
    ] as const;
    for (const c of cases) {
      const r = await run(scen([
        { ...b('seed'), kind: 'set', assign: { rows: [] } },
        { ...b(c.id), kind: c.kind, ...c.step, steps: [{ ...b('body'), kind: 'noop' }] } as never,
      ]));
      assert.equal(res(r, c.id).status, 'pass', `${c.kind} 容器自己不该因为零迭代变色`);
      assert.equal(r.status, 'pass', `${c.kind}：整段场景不该因为零迭代变红`);
      assert.equal(res(r, 'body').status, 'skipped', `${c.kind}：没跑要留痕`);
    }
  });

  test('零迭代只补循环体的**顶层**步骤，不重建没跑的子树', async () => {
    // 与 parallel 给 failFast 分支补 skipped 同一做法：目的是让「这次少验了什么」
    // 在报告里有一行可指，而不是按 IR 铺出一整棵没执行过的树 —— 后者会让
    // JUnit 的用例数随 IR 嵌套深度虚增，而那些层其实连求值都没发生过。
    const r = await run(scen([
      { ...b('w'), kind: 'while', condition: 'false', maxIterations: 3, steps: [
        { ...b('top'), kind: 'if', condition: 'true', then: [{ ...b('deep'), kind: 'noop' }], else: [] },
      ] },
    ]));
    assert.equal(res(r, 'top').status, 'skipped');
    assert.equal(r.results.find((x) => x.stepId === 'deep'), undefined,
      'if 里面那层不该被铺出来（它连条件都没求值过）');
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

  test('table 提供数据驱动的行集合；省略 as 时写进 $table', async () => {
    const r = await run(scen([
      { ...b('t'), kind: 'table', rows: [{ sku: { expr: '"A"' } }, { sku: { expr: '"B"' } }] },
      { ...b('a'), kind: 'assert', against: '$table', jsonPath: { $: { minLength: 2 } } },
    ]));
    assert.equal(r.status, 'pass', r.summary);
  });

  /*
   * 这条测试原先的**标题**写着「dataSource + table」，但正文里只有一个 table 步骤
   * 加一个 assert —— 压根没有 dataSource。于是 `dataSource.as` 没人读（真实缺陷）
   * 它一次也抓不到，而标题会让人以为这块测过了。
   * 这就是本仓那个缺陷类的**测试侧镜像**：测试通过的原因与它想验的东西无关。
   * 现在真的走一遍 dataSource（配一个假 db adapter）。
   */
  test('dataSource 的行集合写进 as 指定的变量', async () => {
    let seen = '';
    const r = await run(scen([
      { ...b('d'), kind: 'dataSource', as: 'orders', source: { type: 'mysql', sql: 'select id from t', datasource: 'main' } },
      { ...b('a'), kind: 'assert', against: '$orders', jsonPath: { $: { minLength: 1 } } },
    ]), { adapters: { db: { async query(ds, sql) { seen = `${ds}:${sql}`; return [{ id: 1 }]; } } } });
    assert.equal(r.status, 'pass', r.summary);
    assert.equal(seen, 'main:select id from t', 'datasource/sql 要真的传进 adapter，否则"外部数据驱动"没有输入');
  });

  test('as 生效：写了 as 就不是 $table（原先 as 声明了没人读，两个 table 互相覆盖）', async () => {
    const r = await run(scen([
      { ...b('t1'), kind: 'table', as: 'users', rows: [{ n: 1 }, { n: 2 }] },
      { ...b('t2'), kind: 'table', rows: [{ n: 3 }] },
      { ...b('a1'), kind: 'assert', against: '$users', jsonPath: { $: { minLength: 2 } } },
      // 省略 as 的那一支写进默认名 $table —— 两条**不该互相覆盖**
      { ...b('a2'), kind: 'assert', against: '$table', jsonPath: { $: { minLength: 1 } } },
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
