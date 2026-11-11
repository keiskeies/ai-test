/**
 * 值形态位置（`ValueSchema`）里写坏的 `{expr}` / `{path}` —— 静态闸要说得出。
 *
 * ## 这一族测试存在的理由：改前这些位置写坏了是**零 finding**
 *
 * `EXPR_SYNTAX` 那两查（步骤字段 / 等待条件字段）走的是
 * `isExprField(kind, field)` —— 那张派生表说的是"**这个字段是字符串表达式**"。
 * 而值形态是一个 `{expr:'…'}` **对象**，字符串藏在里面，所以那些位置
 * 在两查的射程之外。本轮实测（改前）：在下面表格列出的每一个位置各放一个坏表达式，
 * `lintScenario` 全部返回 0 条相关 finding，只能等跑到那一步由运行期抛
 * `error` + `case-stale`。缺的是"提交前就报"这一半，
 * 而 IR 的主力产出者是 LLM（docs/00 §6.1），"表达式写半个"恰是它常见病。
 *
 * ## 为什么这一族要有一条"对撞"式的自检
 *
 * 生产侧的遍历器（`ir` 的 `eachValuePosition`）如果漏了某个位置，
 * **本文件里所有"这个位置会报"的测试都照样绿** —— 它们测的都是"覆盖到的位置报不报"，
 * 没有一个测"有没有漏掉的位置"。这正是本仓最贵的那一族（守卫恒通过），
 * 而且这里连"扫到 N 个"那种阈值断言都不管用：`>= 12` 挡不住"少扫一半"。
 *
 * 所以下面的自检**不复用生产遍历器**，而是从 schema 图**现生成样例数据**、
 * 顺手记下"我往哪些格子里放了哨兵"，再断言生产侧对每一格都真的走到。
 * 两份走法独立，分叉才可能响 —— 与 `expr-fields.test.ts` 拿源码文本对撞
 * 是同一个思路（殊途同归：都拒绝"用被测物自己证明自己"）。
 * 为什么期望侧是"生成数据"而不是"列一份 schema 路径名单"，
 * 在那一节开头记着（第一版就是名单，被两个问题否掉了）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ScenarioSchema, StepSchema, ValueSchema, eachValuePosition, isExprField } from '@atest/ir';
import { lintScenario, type LintIssue } from '../src/index.js';
import { b, scen, type StepDraft } from './helpers.js';

const LOC = { intent: '输入框', primary: { by: 'testid', value: 'q' } } as never;

/** 只留与值形态相关的两个 code（别的规则命中与否不是本文件的课题） */
const formIssues = (body: StepDraft[], extra: object = {}): LintIssue[] =>
  lintScenario(scen(body as never[], extra as never))
    .filter((i) => i.code === 'EXPR_SYNTAX' || i.code === 'REF_PATH_SYNTAX')
    .filter((i) => i.message.includes('值形态') || i.message.includes('default'));

/** 值形态位置上放一个坏表达式（`1 +` 语法必坏，与运行期同判据） */
const BAD_EXPR = { expr: '1 +' };
const BAD_PATH = { path: '$.x.y[' };

describe('值形态里的坏表达式：逐个位置钉', () => {
  /*
   * 每条都是一个位置 + 一个坏形态。列成表而不是散成十个 test，是因为
   * **这一族的缺陷形状就是"只修了被测到的那两处"**（`docs/14` §4.3 记过它），
   * 表 + 后面那条完整性自检才是对的形状。
   */
  const SITES: Array<[string, StepDraft[]]> = [
    ['set.assign.*', [{ ...b('a'), kind: 'set', assign: { v: BAD_EXPR } }]],
    ['act.value', [{ ...b('a'), kind: 'act', locator: LOC, action: 'fill', value: BAD_EXPR }]],
    ['input.value', [{ ...b('a'), kind: 'input', target: LOC, value: BAD_EXPR }]],
    ['assertPage.contains', [{ ...b('a'), kind: 'assertPage', assertKind: 'text', contains: BAD_EXPR }]],
    ['assertPage.expected', [{ ...b('a'), kind: 'assertPage', assertKind: 'count', expected: BAD_EXPR }]],
    ['assertUi.contains', [{ ...b('a'), kind: 'assertUi', assertKind: 'text', contains: BAD_EXPR }]],
    ['table.rows[].*', [{ ...b('a'), kind: 'table', rows: [{ k: BAD_EXPR }], as: 't' }]],
    ['switch.cases[].is', [{ ...b('a'), kind: 'switch', value: '1', cases: [{ is: BAD_EXPR, steps: [{ ...b('n'), kind: 'noop' }] }], default: [{ ...b('n2'), kind: 'noop' }] }]],
    ['call.args.*', [{ ...b('a'), kind: 'call', scenarioRef: 'sub', args: { k: BAD_EXPR } }]],
    ['db.vars.*', [{ ...b('a'), kind: 'db', datasource: 'd', sql: 'select 1 where a = :v', vars: { v: BAD_EXPR } }]],
    ['http.request.query.*', [{ ...b('a'), kind: 'http', request: { method: 'GET', url: 'http://x/', query: { q: BAD_EXPR } } }]],
    ['http.request.body（嵌套内）', [{ ...b('a'), kind: 'http', request: { method: 'POST', url: 'http://x/', body: { deep: { inner: BAD_EXPR } } } }]],
    ['http.request.formData.*', [{ ...b('a'), kind: 'http', request: { method: 'POST', url: 'http://x/', formData: { f: BAD_EXPR } } }]],
    ['openapiCall.body', [{ ...b('a'), kind: 'openapiCall', docRef: 'd', operationId: 'op', body: { b: BAD_EXPR } }]],
    /*
     * 下面两格是本轮**新覆盖**的：`wait` 的谓词树挂在 `z.lazy(...)` 上，
     * 而改前那份手工维护的覆盖清单遍历不进 lazy，于是整棵谓词树压根
     * 不在扫描结果里 —— "没扫到"与"扫了没问题"给出的是同一个答案。
     * `dataSource` 的 mysql `vars` 同族（藏在 discriminatedUnion 成员里）。
     */
    ['wait{dbRow}.vars.*', [{ ...b('a'), kind: 'wait', timeoutMs: 200, pollMs: 50, condition: { type: 'dbRow', datasource: 'd', sql: 'select 1 where a = :v', expect: 'row', vars: { v: BAD_EXPR } } }]],
    ['dataSource{mysql}.vars.*', [{ ...b('a'), kind: 'dataSource', source: { type: 'mysql', sql: 'select 1 where a = :v', vars: { v: BAD_EXPR } }, as: 'r' }]],
  ];

  for (const [name, body] of SITES) {
    test(`${name}：坏 {expr} 被报 EXPR_SYNTAX / error`, () => {
      const hit = formIssues(body).find((i) => i.code === 'EXPR_SYNTAX');
      assert.ok(hit, `${name} 写坏表达式而静态闸零 finding —— 那正是本轮要修的静默`);
      assert.equal(hit!.level, 'error', `${name} 这一格的级别不是 error，run --strict 拦不住`);
      assert.equal(hit!.stepId, 'a', `${name} 的报错没点出是哪个步骤`);
    });
  }

  test('坏 {path} 报 REF_PATH_SYNTAX，而**不**复用 EXPR_SYNTAX', () => {
    /*
     * 两个 code 各管一件事：`EXPR_SYNTAX` 的 fix 讲的是表达式语言函数清单，
     * 而引用写坏的人需要的是"以 $ 开头 / 下标只许数字、*、引号键名"。
     * 给错修法的报错等于没有修法。
     */
    const hit = formIssues([{ ...b('a'), kind: 'set', assign: { v: BAD_PATH } }]).find((i) => i.code === 'REF_PATH_SYNTAX');
    assert.ok(hit);
    assert.equal(hit!.level, 'error');
    assert.match(hit!.fix ?? '', /\$/);
    assert.doesNotMatch(hit!.fix ?? '', /count\/sum\/avg/, '引用的修法里不该出现表达式函数清单');
  });

  test('坏形态在**容器里的子步骤**上，stepId 要指到最里层那一步', () => {
    /*
     * 报错点名点错人，比不点名更坏：作者会去查外层那个 sequence。
     * 遍历器带的是"最近一层带 kind+id 的对象"，这条钉的就是它。
     */
    const inner = { ...b('deep'), kind: 'set', assign: { v: BAD_EXPR } };
    const mid = { ...b('seq2'), kind: 'sequence', steps: [inner] };
    const outer = { ...b('seq1'), kind: 'sequence', steps: [mid] };
    const hit = formIssues([outer as StepDraft]).find((i) => i.code === 'EXPR_SYNTAX');
    assert.equal(hit?.stepId, 'deep', '三层容器里的坏表达式被归给了外层步骤');
  });

  test('值位置**以下**任意深度（数组 + 对象交错四层）也报', () => {
    /*
     * `resolveValue` 对字面量对象是 `entries.map(resolveValue)` —— 递归进任意深度，
     * 所以 `body:{a:{b:{c:[{d:{expr:坏}}]}}}` 运行期是 error。
     * 静态侧若只校"schema 说这是 ValueSchema 的那一格"就看不见它（本轮实测定的）。
     */
    const body = [{ ...b('a'), kind: 'http', request: { method: 'POST', url: 'http://x/', body: { a: { b: { c: [{ d: BAD_EXPR }] } } } } }];
    const hit = formIssues(body as StepDraft[]).find((i) => i.code === 'EXPR_SYNTAX');
    assert.ok(hit, '值位置下面的嵌套形态没被走到');
    assert.match(hit!.message, /body\.a\.b\.c\[0\]\.d/, `坐标没指到最深处：${hit?.message}`);
  });

  test('写在 **setup / teardown** 里的坏形态同样报', () => {
    /*
     * 前置里放坏表达式的概率不比 body 低 —— 登录、造数都在 setup，而那里的表达式
     * 往往最复杂（要从上一步响应里抠 token）。而这三条步骤流是三个**独立**字段，
     * 写规则时只喂 `scenario.body` 是一个极其自然的错法：那种写法下 body 全绿、
     * setup 里的坏表达式静默，而"跑一遍"也发现不了（前置失败会让整场 error，
     * 看起来像环境问题而不是用例问题）。
     */
    for (const flow of ['setup', 'teardown'] as const) {
      const issues = lintScenario(
        scen([{ ...b('live'), kind: 'set', assign: { v: 'x' } }] as never[], {
          [flow]: [{ ...b('a'), kind: 'set', assign: { v: BAD_EXPR } }],
        } as never),
      ).filter((i) => i.code === 'EXPR_SYNTAX');
      assert.equal(issues.length, 1, `${flow} 里的坏表达式报了 ${issues.length} 条（应为 1）`);
      assert.equal(issues[0]!.stepId, 'a', `${flow} 里的报错没点出步骤`);
    }
  });

  test('同一个坏形态**只报一条**（新旧两查不许重叠）', () => {
    /*
     * 两查（上面那两查走 `isExprField` 那张字符串表达式表，这一查走 schema 的
     * 值形态位置）若重叠，作者会在同一格上看到两条措辞不同的话，
     * 而其中一条讲的还是另一套判据 —— 那会让人怀疑整道闸。
     * 结构上的不重叠由下面那条测试钉，这一条钉的是**实际输出**。
     */
    const one = (body: StepDraft[]) =>
      lintScenario(scen(body as never[])).filter((i) => i.code === 'EXPR_SYNTAX' || i.code === 'REF_PATH_SYNTAX');
    assert.equal(one([{ ...b('a'), kind: 'set', assign: { v: BAD_EXPR } }]).length, 1, 'set.assign 被报了不止一条');
    assert.equal(one([{ ...b('a'), kind: 'db', datasource: 'd', sql: 'select 1', vars: { v: BAD_EXPR } }]).length, 1, 'db.vars 被报了不止一条');
    /*
     * `assertPage` 与 `assertUi` 恰好用**同样两个字段名**（contains / expected）。
     * 于是"按判别值筛 union 成员"那道剪枝一旦拿掉，一份 assertPage 的数据会被
     * 塞进 assertUi 的 schema 再走一遍，同一格报两条 —— 这一格是那道剪枝
     * **唯一有同名撞上的地方**，所以拿它当样本（`set.assign` / `db.vars` 都抓不到这种重复）。
     */
    assert.equal(one([{ ...b('a'), kind: 'assertPage', assertKind: 'text', contains: BAD_EXPR }]).length, 1, 'assertPage.contains 被 union 的别的成员重复报了一遍');
    // 引用与表达式各一格的场景
    assert.equal(one([{ ...b('a'), kind: 'set', assign: { v: BAD_EXPR, w: BAD_PATH } }]).length, 2, '同一格里两个坏形态该报两条');
  });
});

describe('不许误报：合法写法一个都不许多报', () => {
  /*
   * 误报的代价不是"多一条红"，是**大家把整道闸关掉**（本仓为此付过学费，
   * 见 lint.ts 里 CREDENTIAL_FIELD_RE 与 RESERVED_KEY_REWRITE 那两段）。
   * 所以这一组与上面同等重要。
   */
  test('好引用 / 好表达式 / gen / 裸字面量都不报', () => {
    const good: StepDraft[] = [
      { ...b('a'), kind: 'set', assign: { v: { path: '$who' }, e: { expr: '$n + 1' }, g: { gen: 'int', with: { min: 1, max: 9 } }, s: 'plain', n: 5 } },
      { ...b('h'), kind: 'http', request: { method: 'POST', url: 'http://x/', body: { deep: { inner: { path: '$who' } } }, query: { q: 'a b' } } },
    ];
    assert.deepEqual(formIssues(good, { inputs: [{ name: 'who', type: 'string' }] }), [], '合法值形态被报了');
  });

  test('业务对象撞保留键名（{path,lang}）不报 —— 它压根不是引用', () => {
    /*
     * 判据借的是运行期那一条 `isValueForm`：混合键不算形态键。
     * 所以"这个字段是 ValueSchema"不足以决定要不要校验，
     * **同一格上"这个对象是不是形态"才是**。这条与上一条合起来才挡住误报。
     */
    const body: StepDraft[] = [{ ...b('a'), kind: 'set', assign: { v: { path: 'src/a.ts', lang: 'ts' } } }];
    assert.deepEqual(formIssues(body), []);
  });

  test('`{path:"$.x.y[", note:1}` 这种混合键**不报**，而这是设计不是漏报', () => {
    /*
       * 运行期也不把它当引用（`isValueForm` 因混合键返回 undefined），
       * 于是静态侧若报了就是"lint 说要抛而运行期不当它是引用"那种分叉。
       * 残留的那一格（作者其实想写引用而多打了键）由 `RESERVED_KEY_REWRITE`
       * 的近邻判据管，不归这里。登记见 docs/14 §5。
     */
    const body: StepDraft[] = [{ ...b('a'), kind: 'set', assign: { v: { path: '$.x.y[', note: 1 } } }];
    assert.deepEqual(formIssues(body), []);
  });

  test('gen 的种类写坏由 RESERVED_KEY_REWRITE 管，这里**不重复报**', () => {
    /* 两处各报同一个事实，作者会看到两条措辞不同的话，而它们是同一件事。 */
    const body: StepDraft[] = [{ ...b('a'), kind: 'set', assign: { v: { gen: 'uuidd' } } }];
    assert.deepEqual(formIssues(body), [], '坏 gen 种类被值形态这一查重报了一遍');
  });

  test('字符串**不是**值形态的位置不被当表达式校验（url / sql / note）', () => {
    /*
     * 这条打的是"图省事把所有字符串都丢进 validateExpr"那种实现：
     * `url: 'a b'` 会报"表达式语法错误"，比原来的漏报更坏。
     * 上面 `dryrun` 就因为把 `act.value` 当表达式而误报过。
     */
    const body: StepDraft[] = [
      { ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a b?c=1 2' } },
      { ...b('d'), kind: 'db', datasource: 'd', sql: 'select * from t where a = 1 and b in (1,2', assignTo: 'r' },
      { ...b('l'), kind: 'log', level: 'info', message: 'count( 未闭合' },
    ];
    assert.deepEqual(formIssues(body), [], '非值形态的字符串被当表达式校验了');
  });
});

describe('inputs[].default：语法坏了要说，而措辞与任何其它值形态位置一致', () => {
  /*
   * 这一格曾经钉的是**相反**的约定，读代码的人会觉得它自相矛盾，所以把历史留在这里：
   *
   * `inputs[].default` 在 schema 里一直是货真价实的 `ValueSchema`（四种形态都收），
   * 而运行期**曾经不求值它** —— `applyInputDefaults` 只是 `out[d.name] = d.default`。
   * 那时"这里写坏了运行期必抛"是**假话**，所以规则对它单独措辞 + 降到 warning
   * （error 会让人以为"把语法修好就能用"，而那恰恰不成立）。
   *
   * 求值侧现在接上了（`VarSpace` 构造期，三个真入口各接一次），
   * "真走到它就必抛"这句话在 default 上也成立，于是那条例外**整条删掉**：
   * 同一个判据、同一个 code、同一个 error 级别。
   * 这里保留的三条断言因此是**新约定的牙**：级别必须是 error，
   * 而消息里不许再出现"不被求值"那套话 —— 那句话说出来就是假话了，
   * 而一句过期的安慰话比不安慰更坏（人会因此不去修）。
   */
  const withDefault = (def: unknown) =>
    lintScenario(scen([{ ...b('a'), kind: 'set', assign: { v: { path: '$who' } } }] as never[], { inputs: [{ name: 'who', type: 'string', default: def }] } as never))
      .filter((i) => i.code === 'EXPR_SYNTAX' || i.code === 'REF_PATH_SYNTAX');

  test('default 里的坏表达式被报，而级别是 error（求值侧已接上）', () => {
    const hit = withDefault(BAD_EXPR)[0];
    assert.ok(hit, 'inputs[].default 里的坏表达式没报');
    assert.equal(hit!.level, 'error', 'default 现在会在构造变量空间时被求值，坏语法必然抛 —— 报 warning 就是让人放过它');
    assert.doesNotMatch(hit!.message, /不被求值/, '那句话已经过期：default 现在被求值，留着它就是在骗人');
    /*
     * 顶层字段**没有对应的步骤**，所以 stepId 必须留空。
     * 遍历器认步骤坐标的判据是"这个对象有 kind"，而场景对象自己也有 `id` ——
     * 只认 `id` 的话这一条会挂在一个压根不存在的步骤上，报告上点"跳到该步骤"跳空。
     * 本轮实测到过那个形状（遍历器第一版把场景 id 当成了步骤 id）。
     */
    assert.equal(hit!.stepId, undefined, `顶层字段的报错挂在了步骤 ${hit!.stepId} 上`);
  });

  test('default 里的坏引用同样报 error', () => {
    const hit = withDefault(BAD_PATH)[0];
    assert.ok(hit);
    assert.equal(hit!.code, 'REF_PATH_SYNTAX');
    assert.equal(hit!.level, 'error');
    assert.doesNotMatch(hit!.message, /不被求值/);
  });

  test('default 是合法字面量时不报', () => {
    assert.deepEqual(withDefault('z'), []);
  });

  test('default 是合法值形态时也不报（语法好、也能求值）', () => {
    /*
     * 反方向的牙：别把"这里能写值形态"又当成"值形态本身可疑"。
     * 修之前这一条恰好也是空的，而它当时**没有意义**（不求值，报不报都不影响行为）；
     * 现在它有意义 —— 它保证这一查不会因为"是个对象"就误报。
     */
    assert.deepEqual(withDefault({ expr: '1 + 2' }), []);
    assert.deepEqual(withDefault({ path: '$.run.inputs.other' }), []);
    assert.deepEqual(withDefault({ gen: 'int', with: { min: 1, max: 9 } }), []);
  });
});

describe('报错不许把源码带进日志', () => {
  /*
   * 值形态所在的位置正是**请求体与表单** —— 明文凭证最常出现的地方
   * （`HARDCODED_SECRET` 整条规则的存在就是证据），而 lint 输出会进 CI 日志，
   * 读者比仓库的读者宽。上面 `condition`/`when` 那一查回显源码是可以的
   * （表达式里放凭证不是常规写法），这一查不行。
   */
  test('坏表达式里带的密钥形态被脱敏，且原文一个字节都不出现', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wWgFWFOEjXk';
    const body: StepDraft[] = [{ ...b('a'), kind: 'set', assign: { v: { expr: `token == "${jwt}" &&` } } }];
    const msg = formIssues(body).map((i) => `${i.message} ${i.fix ?? ''}`).join('\n');
    assert.ok(msg.length > 0, '先确认这条真的报了（否则下面的"不含密钥"是空断言）');
    assert.ok(!msg.includes(jwt), '报错里出现了密钥原文');
    assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(msg), `报错里还有一个像 JWT 的东西：${msg}`);
  });

  test('普通口令原文也不出现（值形态位置就是表单位置）', () => {
    const body: StepDraft[] = [{ ...b('a'), kind: 'http', request: { method: 'POST', url: 'http://x/', formData: { pwd: { expr: 'password == "hUnter2-secre7" &&' } } } }];
    const msg = formIssues(body).map((i) => i.message).join('\n');
    assert.ok(msg.length > 0, '先确认这条真的报了');
    assert.ok(!msg.includes('hUnter2-secre7'), '报错里回显了表单里的明文口令');
  });

  test('坏引用的消息里也不带原文', () => {
    const body: StepDraft[] = [{ ...b('a'), kind: 'set', assign: { v: { path: '$.orders[0].creditCard=4111111111111111[' } } }];
    const msg = formIssues(body).map((i) => i.message).join('\n');
    assert.ok(msg.length > 0, '先确认这条真的报了');
    assert.ok(!msg.includes('4111111111111111'), '报错里回显了引用原文');
  });
});

/* ── 完整性自检：生产遍历器不许漏位置 ───────────────────────────────── */

/*
 * ## 为什么这一族非得有一条"对撞"式的自检
 *
 * 上面每一个 test 测的都是"**覆盖到的**位置报不报"。而这一族的缺陷形状恰好是
 * **漏位置**：`eachValuePosition` 少认一格，那一格就静默，而本文件里
 * **没有一个 test 会红** —— 它们全都在自己那几格上验到了正确行为。
 * 连"扫到 ≥ N 个"这种阈值断言也挡不住（`>= 12` 与"少扫一半"不矛盾）。
 *
 * 所以这里换成**两份独立走法对撞**：
 *  - **期望侧**：不复用生产遍历器，自己从 schema 图现生成一份样例数据，
 *    并在生成的同时记下"我往哪些格子里放了哨兵"；
 *  - **实际侧**：把同一份数据交给 `eachValuePosition`，收它交出来的坐标。
 * 两份逻辑互不复用，分叉才可能响 —— 与 `expr-fields.test.ts` 拿源码文本对撞
 * 是同一思路：拒绝"用被测物自己证明自己"。
 *
 * ## 为什么期望侧是"生成数据"而不是"列一份 schema 路径名单"
 *
 * 第一版是后者，两个问题叠在一起把它否了（都实测过，不是推想）：
 *  1. **路径是笛卡尔积**。步骤 union 有几十个成员，`sequence.steps` 又绕回整个
 *     步骤 union（`z.lazy`），`if` 有三条步骤数组、`switch` 有 case + default，
 *     把"所有 schema 路径"枚举出来是指数级的 —— 第一版直接跑到超时。
 *  2. **两个坐标系**。schema 侧叫 `body[].request.query.*`，数据侧叫
 *    `body[0].request.query.q`，中间那层"`.*` 换成真实键名"的映射只能手写死，
 *    于是"自检红"有三种原因（遍历器漏 / 映射表错 / 夹具没铺到），
 *    而**只有第一种是要修的**。
 * 生成数据把两件事一起消掉：**数据本身就是那条路径的实例**，
 * 期望坐标与数据同源、逐段对齐，不需要映射表。
 * 代价是期望侧自己也可能漏 —— 所以下面还有三条元测试专门盯它。
 */

type ZodDef = {
  type?: string;
  shape?: Record<string, unknown>;
  valueType?: unknown;
  element?: unknown;
  options?: unknown[];
  innerType?: unknown;
  getter?: () => unknown;
  value?: unknown;
  values?: unknown[];
};

/** 剥 optional / nullable / default / lazy（与生产侧同一个动机：要的是"这一格是什么类型"） */
function unwrapZod(s: unknown): unknown {
  const d = (s as { def?: ZodDef })?.def;
  if (d?.innerType) return unwrapZod(d.innerType);
  if (d?.getter) {
    try {
      return unwrapZod(d.getter());
    } catch {
      return s;
    }
  }
  return s;
}
const zodDef = (s: unknown): ZodDef | undefined => (unwrapZod(s) as { def?: ZodDef } | null)?.def;

/** 判别键由 schema 自己要求，样例里必须填对，否则数据与 schema 对不上 */
const DISCRIM_FIELDS = new Set(['kind', 'type', 'assertKind']);
/** 判别字面量 / enum 的第一个取值 */
function literalOf(s: unknown): unknown {
  const d = zodDef(s) as (ZodDef & { def?: { value?: unknown } }) | undefined;
  return d?.value ?? d?.def?.value ?? d?.values?.[0];
}

/** 生成器交出的一个候选：数据 + 我在数据里放哨兵的那些**数据坐标** */
interface Sample {
  data: unknown;
  slots: string[];
}

/** 哨兵 record 的键名（生成器与期望坐标同源，故天然一致） */
const SLOT_KEY = 'vk';

/**
 * 从 schema 现生成一份样例数据，并顺手记下"哪些格子上放了值形态哨兵"。
 *
 * union 交出**多个候选**（每个成员一个），调用方逐个对撞 ——
 * 这既是覆盖率（每一个 kind 全都过一遍），也是**量**的控制：
 * 一个候选里每个 union 位置只取一个成员，而不是把成员组合起来。
 *
 * 递归结构（步骤 union、等待条件 union）遇到本支已走过的实例就停手，
 * 于是嵌套步骤只展开**一层**容器：`sequence.steps[0]` 会走，
 * `sequence.steps[0].steps[0]` 不会。**这一层是够的**：容器与叶子走的是
 * 同一条 object 分支判据，"走到容器字段"与"没走到"在一层内就能区分。
 */
function sampleFrom(schema: unknown, path: string, branch: Set<unknown>, depth = 0): Sample[] {
  if (depth > 8) return [];
  const u = unwrapZod(schema);
  if (u === ValueSchema) {
    // 哨兵取 {path}：合法（解析得过）且文本可校，两样都要
    return [{ data: { path: '$who' }, slots: [path] }];
  }
  if (u === null || typeof u !== 'object' || branch.has(u)) return [];
  const nb = new Set(branch).add(u);
  const d = zodDef(schema);
  if (!d) return [];
  if (d.type === 'record') {
    return sampleFrom(d.valueType, `${path}.${SLOT_KEY}`, nb, depth + 1).map((a) => ({ data: { [SLOT_KEY]: a.data }, slots: a.slots }));
  }
  if (d.type === 'array') {
    return sampleFrom(d.element, `${path}[0]`, nb, depth + 1).map((a) => ({ data: [a.data], slots: a.slots }));
  }
  if (d.type === 'object') {
    let acc: Sample[] = [{ data: {}, slots: [] }];
    for (const [f, sub] of Object.entries(d.shape ?? {})) {
      if (DISCRIM_FIELDS.has(f)) {
        const v = literalOf(sub);
        if (v !== undefined) for (const a of acc) (a.data as Record<string, unknown>)[f] = v;
        continue;
      }
      const alts = sampleFrom(sub, `${path}.${f}`, nb, depth + 1).slice(0, 2);
      // 装不下值形态的字段**整个不进数据**：这一族的对撞只比值形态坐标，
      // 铺一堆无关注入只是让报错更难读（env / capabilities / fingerprint 等）
      if (!alts.length) continue;
      const next: Sample[] = [];
      for (const base of acc) {
        for (const a of alts) next.push({ data: { ...(base.data as object), [f]: a.data }, slots: [...base.slots, ...a.slots] });
        if (next.length > 32) break; // 控量；单个候选内部各字段仍是笛卡尔积的前 32
      }
      acc = next.slice(0, 32);
    }
    return acc;
  }
  if (Array.isArray(d.options)) {
    const all: Sample[] = [];
    for (const o of d.options) all.push(...sampleFrom(o, path, nb, depth + 1));
    const byData = new Map<string, Sample>();
    for (const a of all) {
      const k = JSON.stringify(a.data);
      if (!byData.has(k) || byData.get(k)!.slots.length < a.slots.length) byData.set(k, a);
    }
    return [...byData.values()].sort((x, y) => y.slots.length - x.slots.length).slice(0, 6);
  }
  return [];
}

/** 走一遍并把坐标收起来 */
const visit = (schema: unknown, data: unknown): string[] => {
  const out: string[] = [];
  eachValuePosition(schema, data, (p) => out.push(p.path));
  return out;
};

/**
 * 同一格**只许被交出来一次**。
 *
 * 这不是洁癖：union 那道"按判别值筛成员"的剪枝一旦失效，一份 `assertPage` 的
 * 数据就会被塞进 `assertUi` 的 schema 再走一遍，同一格交两次（本轮实测：
 * `["$.body[0].contains","$.body[0].contains"]`）。而 `lintScenario` 末尾
 * 有一句 `dedupe()`，于是**lint 的输出看不出这件事** —— 我拿这个变异试过，
 * 相关 finding 仍是 1 条。所以这一格只能钉在遍历器自己身上：
 * 换一个没有 dedupe 的调用方（比如以后 CLI 直接问"这个场景里有几处值形态"）
 * 就会拿到双份，而"少扫"与"多扫"在报告上都是看不见的。
 */
const assertNoDuplicateSlots = (visited: string[], where: string): void => {
  const dup = visited.filter((p, i) => visited.indexOf(p) !== i);
  assert.deepEqual([...new Set(dup)], [], `${where}：这些格子被交出来了不止一次（union 剪枝失效的形状）`);
};

/** 步骤 union 的成员（判据是 schema 结构，不抄一份 kind 名单 —— 抄了就又是漂移源） */
const STEP_MEMBERS: unknown[] = (() => {
  const d = zodDef(StepSchema);
  return Array.isArray(d?.options) ? d!.options! : [];
})();
const kindOf = (m: unknown): string => String(literalOf(zodDef(m)?.shape?.kind));

describe('期望侧自己也要有牙（防"自检恒绿"）', () => {
  /*
   * 上面说"两份独立走法对撞"，而**新写的那一份同样可能是空的或恒真的**。
   * 本仓最贵的教训就是守卫恒通过（docs/14 §4.2），所以期望侧配三条元测试。
   */
  test('生成器真的认得出值形态格（不是一句恒返回空的摆设）', () => {
    const setMember = STEP_MEMBERS.find((m) => kindOf(m) === 'set');
    assert.ok(setMember, '步骤 union 里没有 set，那这一族的对撞全在空转');
    const best = sampleFrom(setMember, '$', new Set()).sort((a, b) => b.slots.length - a.slots.length)[0];
    assert.deepEqual(best?.slots ?? [], [`$.assign.${SLOT_KEY}`], `生成器没在最显然的那一格放上哨兵：${JSON.stringify(best?.slots)}`);
  });

  test('对撞本身会红：期望侧数得出格子而实际侧走不到时，比较式两边不等', () => {
    /*
     * 上一条形如"把格子裁掉，看会不会红"的做法是**无效**的：格子一裁，
     * 期望侧（也从 schema 生成）跟着变瞎，两侧一起是 0，比较照样平 —— 这正是
     * "用被测物证明自己"的另一种形态。所以这里**只裁实际侧的 schema**、
     * 期望侧仍用原 schema 生成，复现的才是真实缺陷形状
     * 「schema 里有这一格，而遍历器没走到」。
     */
    const setMember = STEP_MEMBERS.find((m) => kindOf(m) === 'set')!;
    const data = { kind: 'set', id: 'a', assign: { [SLOT_KEY]: { path: '$who' } } };
    const pruned = { def: { type: 'object', shape: { ...(zodDef(setMember) as ZodDef).shape!, assign: { def: { type: 'string' } } } } };
    assert.deepEqual(visit(pruned, data), [], '夹具不成立：裁过的 schema 仍被走到了，那这条元测试是空跑的');
    const expected = sampleFrom(setMember, '$', new Set()).flatMap((a) => a.slots);
    assert.ok(expected.includes(`$.assign.${SLOT_KEY}`), '期望侧也数不出这一格，那主自检是恒绿的');
  });

  test('生成器不认的 schema 节点类型，确实装不下值形态', () => {
    /*
     * 生成器只认 record / array / object / union 四种内部形状。
     * 明天有人写 `z.tuple([ValueSchema, z.string()])`，这一族会**静默**漏掉那一格
     * —— 而漏的位置连元测试也不响（元测试走的也是生成器）。
     * 所以这一条**不看类型名**：顺着一切"看起来像 zod schema"的属性做可达性搜索，
     * 断言"生成器不认的那些类型"里没有任何一个能抵达 `ValueSchema`。
     * 本轮实测：IR 里 tuple 6 处、unknown 1 处、null 1 处，全部不可达，
     * 于是今天这一格是安全的；而**哪天多了个装值形态的 tuple，这条会先红**。
     */
    const looksLikeSchema = (v: unknown): boolean =>
      v !== null && typeof v === 'object' && (v as { def?: unknown }).def !== undefined;
    const reachesValue = (root: unknown): boolean => {
      const seen = new Set<unknown>();
      let frontier: unknown[] = [root];
      for (let d = 0; d < 40 && frontier.length; d++) {
        const next: unknown[] = [];
        for (const n of frontier) {
          if (n === ValueSchema) return true;
          if (seen.has(n)) continue;
          seen.add(n);
          for (const bag of [n, (n as { def?: unknown }).def]) {
            if (bag === null || typeof bag !== 'object') continue;
            for (const v of Object.values(bag)) if (looksLikeSchema(v)) next.push(v);
          }
        }
        frontier = next;
      }
      return false;
    };
    const typeName = (s: unknown): string => String((unwrapZod(s) as { def?: ZodDef })?.def?.type ?? '(none)');
    const nodes = new Map<string, unknown[]>();
    const collect = (s: unknown, depth: number): void => {
      if (depth > 30 || s === null || typeof s !== 'object' || s === ValueSchema) return;
      const t = typeName(s);
      const list = nodes.get(t) ?? [];
      nodes.set(t, list);
      if (list.includes(s)) return;
      list.push(s);
      const d = zodDef(s);
      if (!d) return;
      const kids: unknown[] = [];
      if (d.valueType) kids.push(d.valueType);
      if (d.element) kids.push(d.element);
      if (d.shape) kids.push(...Object.values(d.shape));
      if (Array.isArray(d.options)) kids.push(...d.options);
      kids.push(...((d as unknown as { items?: unknown[] }).items ?? []));
      for (const k of kids) collect(k, depth + 1);
    };
    collect(ScenarioSchema, 0);
    const HANDLED = new Set(['record', 'array', 'object', 'union', 'lazy', 'optional', 'nullable', 'default', '(none)']);
    const blind = [...nodes.entries()].filter(([t]) => !HANDLED.has(t));
    assert.ok(blind.length >= 4, `只归类出 ${blind.length} 种未处理类型，这一条大概是空跑的`);
    for (const [t, list] of blind) {
      assert.deepEqual(list.filter(reachesValue), [],
        `类型 ${t} 里有节点能抵达 ValueSchema，而生成器不认这个类型 ⇒ 值形态会被静默漏掉`);
    }
  });
});

describe('生产遍历器对每个步骤 kind 的每个值形态格都真的走到', () => {
  test('步骤 kind 一个不漏（对撞的前提：成员解得出来）', () => {
    const kinds = STEP_MEMBERS.map(kindOf);
    assert.ok(kinds.length >= 30, `步骤 union 只解出 ${kinds.length} 个成员，覆盖面不足`);
    assert.equal(new Set(kinds).size, kinds.length, '步骤 kind 有重名，对撞会把两个 kind 算成一格');
  });

  for (const m of STEP_MEMBERS) {
    const kind = kindOf(m);
    test(`${kind}：期望的每一格都被走到，且不多走`, () => {
      const candidates = sampleFrom(m, '$', new Set());
      assert.ok(candidates.length > 0, `${kind} 一个候选都生成不出来，这一格是空测试`);
      for (const cand of candidates) {
        const visited = visit(m, cand.data);
        assertNoDuplicateSlots(visited, kind);
        assert.deepEqual(cand.slots.filter((s) => !visited.includes(s)), [],
          `${kind}：schema 说这些格子能写值形态而遍历器没走到（漏一格就是一格静默）`);
        assert.deepEqual(visited.filter((s) => !cand.slots.includes(s)), [],
          `${kind}：遍历器交出了 schema 上没有的格子（那不是覆盖，是误报的来源）`);
      }
    });
  }

  test('经由**整个步骤 union** 走，与经由成员走，交出的格子必须一模一样', () => {
    /*
     * 上面那一轮每个 kind 都是拿**成员**当根走的，于是 union 那一层
     * "按判别值筛成员"的剪枝压根没被走到 —— 而它正是"同一格被交两遍"
     * 唯一会发生的地方。本轮实测：`value` 由 act 与 input 共用、
     * `contains` / `expected` 由 assertPage 与 assertUi 共用，剪枝拿掉之后
     * 一份 assertPage 的数据会被塞进 assertUi 的 schema 再走一遍，
     * 于是同一个坐标交两次（`["$.body[0].contains","$.body[0].contains"]`）。
     *
     * 这件事**在 lint 的输出上看不见** —— `lintScenario` 末尾有一句 `dedupe()`，
     * 我拿这个变异实测过，相关 finding 仍是 1 条。所以只能钉在遍历器自己身上：
     * 换一个没有 dedupe 的消费方就会拿到双份。
     *
     * 判据用"两个方向相等"而不是"不许有重复"：后者在没有任何 kind 撞字段名时
     * 会静默恒通过（我第一版就是这么写的，改坏剪枝仍全绿），
     * 而前者**要求 union 这条路本身走对**，剪枝一拿掉，撞名的那三个 kind 立刻红。
     */
    const collisions: string[] = [];
    for (const m of STEP_MEMBERS) {
      const kind = kindOf(m);
      for (const cand of sampleFrom(m, '$', new Set())) {
        const viaMember = visit(m, cand.data);
        const viaUnion = visit(StepSchema, cand.data);
        assertNoDuplicateSlots(viaUnion, `${kind}（经 union）`);
        assert.deepEqual([...viaUnion].sort(), [...viaMember].sort(),
          `${kind}：经由 union 与经由成员走出的格子不同 —— union 那一层的剪枝有问题（重复报或漏走）`);
      }
      // 顺带记下哪些 kind 真的共用字段名（防这一整轮在"无人撞名"时静默失去意义）
      const fields = Object.entries(zodDef(m)?.shape ?? {}).filter(([, s]) => unwrapZod(s) === ValueSchema).map(([f]) => f);
      for (const other of STEP_MEMBERS) {
        if (other === m) continue;
        const ofields = Object.entries(zodDef(other)?.shape ?? {}).filter(([, s]) => unwrapZod(s) === ValueSchema).map(([f]) => f);
        if (fields.some((f) => ofields.includes(f))) collisions.push(`${kind} ↔ ${kindOf(other)}`);
      }
    }
    assert.ok(collisions.length > 0,
      '没有两个步骤 kind 共用同一个值形态字段名，那上面那条 union 对照是恒成立的空测试');
  });

  test('场景层（inputs[].default + setup/body/teardown 三条步骤流）也对得上', () => {
    /*
     * 步骤层过了不等于场景层过了：`inputs[].default` 不在任何步骤里，
     * 而 setup / body / teardown 是三个**独立**字段。漏掉任意一条流，
     * 那条流里的坏表达式就永远静默 —— 本轮先只填了 body，就是被这条抓出来的
     * （写死的夹具铺不全，而生成器天然铺满）。
     */
    const candidates = sampleFrom(ScenarioSchema, '$', new Set());
    assert.ok(candidates.length > 0, '场景层一个候选都生成不出来');
    const flowsCovered = new Set<string>();
    let sawInputDefault = false;
    for (const cand of candidates) {
      const data = cand.data as Record<string, unknown>;
      for (const flow of ['setup', 'body', 'teardown']) {
        if (Array.isArray(data[flow]) && (data[flow] as unknown[]).length > 0) flowsCovered.add(flow);
      }
      if (cand.slots.some((s) => s.startsWith('$.inputs'))) sawInputDefault = true;
      const visited = visit(ScenarioSchema, cand.data);
      assertNoDuplicateSlots(visited, '场景层');
      assert.deepEqual(cand.slots.filter((s) => !visited.includes(s)), [], '场景层漏了格子');
      assert.deepEqual(visited.filter((s) => !cand.slots.includes(s)), [], '场景层多走了格子');
    }
    assert.deepEqual([...flowsCovered].sort(), ['body', 'setup', 'teardown'],
      '候选里没铺齐三条步骤流，那这一条对 setup/teardown 是空的（夹具问题，但它同样会漏报）');
    assert.ok(sawInputDefault, '候选里没有 inputs[].default 那一格，顶层字段就没被对撞覆盖');
  });
});

describe('两查的位置集合在结构上不相交', () => {
  test('没有任何字段既是字符串表达式字段、又是值形态位置', () => {
    /*
     * 上面"只报一条"那条测的是我手上这几个样本。这一条测的是**全部**：
     * 逐步骤成员看 shape，问"这个字段 unwrap 之后是不是 ExprSchema"与
     * "是不是 ValueSchema"，两问同时为真的就是重叠格。
     * 本轮实测：交集为空，所以两个 code 不会在同一格上各报一遍。
     * 它同时也是一条**前向闸** —— 哪天有人把一个字段从 `ExprSchema` 改成
     * `ValueSchema`（或反之）而没协调两查，这条先响，而不是让 CI 里
     * 多出一条重复报错由人去发现。
     */
    const overlap: string[] = [];
    for (const m of STEP_MEMBERS) {
      const kind = kindOf(m);
      for (const [f, sub] of Object.entries(zodDef(m)?.shape ?? {})) {
        const u = unwrapZod(sub);
        if (u === ValueSchema && isExprField(kind, f)) overlap.push(`${kind}.${f}`);
      }
    }
    assert.deepEqual(overlap, [], '这些字段两查都会报，作者会在同一格上看到两条不同的话');
    // 而这一条本身不能是空跑的：值形态字段确实存在
    const valueFields = STEP_MEMBERS.flatMap((m) =>
      Object.entries(zodDef(m)?.shape ?? {}).filter(([, s]) => unwrapZod(s) === ValueSchema).map(([f]) => `${kindOf(m)}.${f}`));
    assert.ok(valueFields.length >= 5, `只认出 ${valueFields.length} 个顶层值形态字段，上面那条大概是空跑的`);
  });
});
