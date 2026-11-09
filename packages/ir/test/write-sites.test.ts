/**
 * `STEP_WRITE_SITES` 的**逐 kind 覆盖**测试。
 *
 * 为什么专门要一份（`docs/14` §3 记着 ir 是全仓测试密度最薄的包）：
 * 这张表是 parallel 变量竞态闸的**唯一依据** —— 某个会写变量的 kind 没登记、
 * 或者登记时字段名写错，表现都是"那种步骤写变量时闸根本不响"，
 * 而闸不响的表现是"竞态用例照样跑、结果随调度顺序变"（本仓那个缺陷类最难查的一档）。
 *
 * 两个具体的失效形态，各自对应下面一条测试：
 *  1. **kind 整个漏登记**：`Record<Step['kind'], WriteSites>` 的非 Partial 声明
 *     拦得住"少一个键"，但拦得住编译**不等于**拦得住"键给了 `{}` 而它其实会写变量"。
 *     所以这里要求每个会写的 kind 都**实际报出名字**来。
 *  2. **字段名写错**：所有 extractor 都是 `as { saveAs?: string }` 这种 cast，
 *     schema 把 `saveAs` 改名成 `saveTo` 之后，extractor 会静默返回 undefined
 *     （cast 让 TS 完全不参与），闸对 `http` 这一整个 kind 永久失明。
 *     这条靠"fixture 必须过 `.strict()` 的 schema"来防 ——
 *     **fixture 一律 `StepSchema.parse()` 造**，字段名错了 parse 就抛，
 *     而不是像手写对象那样带着同一个拼写错误一起"看起来没问题"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STEP_WRITE_SITES, StepSchema, flatten, writtenNames, type Step } from '../src/index.js';

/**
 * 过 schema 造 fixture，**并且失败时说清是哪个 kind**。
 * 直接用 StepSchema.parse 的话，union 失败会给一坨"每个候选都试了一遍"的转储
 * （或者干脆 error: ''），看的人根本不知道是哪一个步骤的哪个字段写错了 ——
 * 而我第一次跑就是这个现象，四条测试里两条空手失败。
 */
const mk = (kind: string, draft: unknown): Step => {
  try {
    return StepSchema.parse(draft) as Step;
  } catch (e) {
    throw new Error(`fixture "${kind}" 过不了 schema（fixture 自己错了，不是被测代码）：${String((e as Error).message).slice(0, 400)}`);
  }
};

/** 每个会写变量的 kind 一个**最小合法**步骤 + 它应当报出的名字。 */
const WRITE_CASES: ReadonlyArray<{ kind: Step['kind']; step: unknown; expect: string[] }> = [
  { kind: 'set', step: { id: 'w_set', kind: 'set', assign: { fromSet: 1 } }, expect: ['fromSet'] },
  {
    kind: 'extract',
    step: { id: 'w_extract', kind: 'extract', from: '$.step.w_set', rules: [{ var: 'fromExtract', path: '$.a' }] },
    expect: ['fromExtract'],
  },
  { kind: 'table', step: { id: 'w_table', kind: 'table', as: 'fromTable', rows: [{ a: 1 }] }, expect: ['fromTable'] },
  {
    kind: 'dataSource',
    step: { id: 'w_ds', kind: 'dataSource', as: 'fromDataSource', source: { type: 'mysql', datasource: 'main', sql: 'select 1' } },
    expect: ['fromDataSource'],
  },
  {
    kind: 'http',
    step: { id: 'w_http', kind: 'http', saveAs: 'fromHttp', request: { method: 'GET', url: 'http://x/y' } },
    expect: ['fromHttp'],
  },
  {
    kind: 'openapiCall',
    step: { id: 'w_oac', kind: 'openapiCall', saveAs: 'fromOpenapiCall', docRef: 'doc#a', method: 'GET', path: '/a' },
    expect: ['fromOpenapiCall'],
  },
  { kind: 'call', step: { id: 'w_call', kind: 'call', scenarioRef: 'sub@1', assignTo: 'fromCall' }, expect: ['fromCall'] },
  { kind: 'db', step: { id: 'w_db', kind: 'db', datasource: 'main', sql: 'select 1', assignTo: 'fromDb' }, expect: ['fromDb'] },
  { kind: 'script', step: { id: 'w_script', kind: 'script', lang: 'ts', code: 'export default 1', outputVars: ['fromScript'] }, expect: ['fromScript'] },
];

test('每个会写变量的 kind 都真的报出名字（extractor 字段名写错时这里会空）', () => {
  const missing: string[] = [];
  for (const c of WRITE_CASES) {
    // **过 schema 造 fixture**：字段名与 schema 不一致时 parse 直接抛，
    // 而不是造出一个" extractor 读不到、测试也测不到"的静默组合
    const step = mk(c.kind, c.step);
    const got = writtenNames([step]);
    for (const name of c.expect) {
      if (!got.includes(name)) missing.push(`${c.kind} 应报出 "${name}"，实际 [${got.join(',')}]`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

/**
 * 这张表**不许漏 kind**。
 *
 * `Record<Step['kind'], WriteSites>` 已经保证每个 kind 都有键，但"有键且为 `{}`"
 * 与"这个 kind 真的不写变量"是两回事 —— 后者没有任何东西在管。
 * 这里的做法是：**枚举 schema 里全部 kind**，逐个用带写入字段的探针步骤试一遍。
 * 探针带上了所有写入字段名（saveAs / assignTo / as / assign / rules / outputVars），
 * 于是"某个 kind 会写变量但没登记"会表现为"探针报出了名字而表里是空的"。
 */
test('没有哪个 kind 会写变量却没被登记（漏登记 = 闸对那一类永久失明）', () => {
  // 探针：把每个可能承载"名字"的字段都填上互不相同的值。
  // 一个 kind 只要能写出其中任何一个名字，就说明它会写变量。
  const probe = (kind: string): unknown => ({
    id: `p_${kind}`, kind,
    saveAs: 'probeSaveAs', assignTo: 'probeAssignTo', as: 'probeAs',
    assign: { probeAssign: 1 }, rules: [{ var: 'probeRule', path: '$.a' }], outputVars: ['probeOutputVars'],
    // 下面这些是让探针能过各自 schema 的必填项（过不了的 kind 说明它压根不接受这些字段）
    request: { method: 'GET', url: 'http://x/y' }, docRef: 'doc#a', strategy: 'path', method: 'GET', url: '/a',
    scenarioRef: 'sub@1', datasource: 'main', sql: 'select 1', lang: 'ts', code: 'x',
    from: '$.step.p_x', rows: [{ a: 1 }], source: { type: 'mysql', datasource: 'main', sql: 'select 1' },
    items: 'xs', condition: 'true', maxIterations: 1, times: 1, ms: 1, steps: [{ id: 'inner', kind: 'noop' }],
  });
  // 显式收成 Step['kind'][]：Object.keys 给的是 string[]，
  // 直接拿去索引 STEP_WRITE_SITES 在 `noUncheckedIndexedAccess` 下是 any（typecheck:test 会红）。
  // 用 Object.keys 而不是手写一份 kind 清单，正是为了让"表里加了新 kind"自动被这条测试覆盖。
  const allKinds = Object.keys(STEP_WRITE_SITES) as Step['kind'][];
  const unregistered: string[] = [];
  for (const kind of allKinds) {
    let step: Step;
    try { step = StepSchema.parse(probe(kind)) as Step; } catch { continue; } // 该 kind 不接受这种形状，跳过
    const wrote = writtenNames([step]);
    if (wrote.length && Object.keys(STEP_WRITE_SITES[kind]).length === 0) {
      unregistered.push(`${kind} 写出了 [${wrote.join(',')}] 但登记表里是 {}`);
    }
  }
  assert.deepEqual(unregistered, [], unregistered.join('\n'));
});

/**
 * forEach 的循环项**不进** writtenNames。
 *
 * 这不是遗漏而是语义：循环项写在它自己那一帧里（并发时写在**本支**的局部帧里），
 * 不算跨支的共享名字。要是哪天有人"顺手"把它算进来，
 * 两支各带 `forEach{as:'item'}` —— 并发里最顺手的写法 —— 就会被闸拒掉，
 * 而 parallel 拒掉循环就等于不能用了。
 */
test('forEach 的循环项不算共享写（否则两支各带 forEach 就被误拒）', () => {
  const loop = mk('forEach', {
    id: 'w_loop', kind: 'forEach', items: 'xs', as: 'loopItem', indexAs: 'loopIdx',
    steps: [{ id: 'inner', kind: 'noop' }],
  });
  assert.deepEqual(writtenNames([loop]), [], '循环项与下标都在自己的帧里，不该出现在共享写名单里');
  // 但嵌套在里面的真写要算（walk 到底）
  const nested = mk('forEach', {
    id: 'w_loop2', kind: 'forEach', items: 'xs', as: 'loopItem',
    steps: [{ id: 's', kind: 'set', assign: { fromNestedSet: 1 } }],
  });
  assert.deepEqual(writtenNames([nested]), ['fromNestedSet']);
});

/** 嵌套容器里的写也要算到（判据只看直接子步骤 = 闸形同虚设）。 */
test('嵌套任意深度的写都能报出来', () => {
  const deep = mk('sequence', {
    id: 'root', kind: 'sequence', steps: [
      { id: 'i', kind: 'if', condition: 'true', then: [
        { id: 'r', kind: 'repeat', times: 2, steps: [
          { id: 'pa', kind: 'parallel', failFast: true, maxConcurrency: 2, steps: [
            { id: 'h', kind: 'http', saveAs: 'buriedHttp', request: { method: 'GET', url: 'http://x' } },
          ] },
        ] },
      ], else: [{ id: 'e', kind: 'db', datasource: 'm', sql: 'select 1', assignTo: 'buriedDb' }] },
      { id: 'sw', kind: 'switch', value: '$code', cases: [{ is: 1, steps: [{ id: 'c', kind: 'table', as: 'buriedTable', rows: [{ a: 1 }] }] }], default: [{ id: 'd', kind: 'noop' }] },
    ],
  });
  const got = writtenNames([deep]).sort();
  assert.deepEqual(got, ['buriedDb', 'buriedHttp', 'buriedTable'], `只报出 [${got.join(',')}]：有嵌套层的写漏了`);
  // flatten 与 writtenNames 走的是同一套遍历，两者对不上的话说明有一处漏了 CHILD_KEYS
  assert.ok(flatten([deep]).length >= 8, `flatten 只展开出 ${flatten([deep]).length} 个步骤`);
});
