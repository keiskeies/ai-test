/**
 * kind 分类表自身的自洽测试。
 *
 * 这两张表（CONTAINER_KINDS / ASSERTION_KINDS）错了不会有任何编译错误 ——
 * 它们是 `readonly Step['kind'][]`，少写一项只是类型范围更窄，运行时静默。
 * 而它们直接决定**JUnit 的用例数**与 **CI 的退出码**，错的表现是"绿得不对"。
 * 所以表要有人对着 STEP_KINDS 逐条核，而不是靠 review 时肉眼看。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ASSERTION_KINDS, CONTAINER_KINDS, STEP_KINDS, StepSchema, flatten, type Step } from '../src/index.js';

const ALL = STEP_KINDS as readonly Step['kind'][];

test('ASSERTION_KINDS 覆盖所有名字以 assert 开头的 kind（漏一个 = 那种断言不参与"这次有没有断言"的判断）', () => {
  const byPrefix = ALL.filter((k) => k.startsWith('assert'));
  const missing = byPrefix.filter((k) => !ASSERTION_KINDS.includes(k));
  assert.deepEqual(missing, [], `新增断言形态却没进 ASSERTION_KINDS：${missing.join('、')}。补表，别改这条测试`);
});

test('两张表互斥：既是容器又是断言的步骤会让"用例数"与"结论数"两个口径同时错', () => {
  const both = ASSERTION_KINDS.filter((k) => CONTAINER_KINDS.includes(k));
  assert.deepEqual(both, [], `同时出现在两张表里：${both.join('、')}`);
});

test('两张表都不含 STEP_KINDS 里没有的 kind（写错字不会报错，只会静默少算）', () => {
  for (const [name, table] of [['CONTAINER_KINDS', CONTAINER_KINDS], ['ASSERTION_KINDS', ASSERTION_KINDS]] as const) {
    const bogus = (table as readonly string[]).filter((k) => !ALL.includes(k as Step['kind']));
    assert.deepEqual(bogus, [], `${name} 里有不存在的 kind：${bogus.join('、')}`);
  }
});

test('CONTAINER_KINDS 里每个 kind 真的能装子步骤，且 walk 真的会走进去', () => {
  // 这条才是有信息量的那版。我先前写的是"拿一张手抄的同样清单比一遍" ——
  // 那是同义反复，把表改错它照样绿（抄的那份会跟着一起改错）。
  //
  // 容器的定义性特征是**能装子步骤且 walk 会走进去**。两头都钉：
  //  - 表里加了个装不了子步骤的 kind => 它自己的结论会被当成用例，子步骤数对不上；
  //  - schema 加了子步骤字段但 CHILD_KEYS 没加 => walk 走不进去，
  //    里面的断言对 lint / 变量分析 / 退出码**全部隐形**（这才是真灾难：
  //    PARALLEL_VAR_RACE 之类的规则压根看不见那段代码）。
  const child = { id: 'inner', kind: 'assert', against: '$x', jsonPath: { $: { eq: 1 } } };
  const cases: Array<[Step['kind'], unknown]> = [
    ['sequence', { id: 's', kind: 'sequence', steps: [child] }],
    ['if', { id: 'i', kind: 'if', condition: '1 == 1', then: [child], else: [] }],
    ['switch', { id: 'sw', kind: 'switch', value: 'x', cases: [{ is: 1, steps: [child] }], default: [] }],
    ['forEach', { id: 'f', kind: 'forEach', items: 'xs', as: 'x', maxIterations: 3, steps: [child] }],
    ['while', { id: 'w', kind: 'while', condition: '1 == 1', maxIterations: 3, steps: [child] }],
    ['repeat', { id: 'r', kind: 'repeat', times: 2, steps: [child] }],
    ['parallel', { id: 'p', kind: 'parallel', steps: [child] }],
  ];
  const listed = new Set<Step['kind']>(CONTAINER_KINDS);
  for (const [kind, step] of cases) {
    assert.ok(listed.has(kind), `${kind} 能装子步骤却不在 CONTAINER_KINDS 里：它的结论会被当成一条用例计数`);
    // **必须先过 schema**。不校验的话，字段名写错的 fixture 照样能 flatten 出 2 个节点
    // （walk 只认字段名，不认 schema），这条测试就在测一个 IR 里根本不可能存在的对象 ——
    // 而它恰恰会在这种假对象上通过、在真对象上失败，等于白写。
    // 报错要说清是哪个 kind：StepSchema 是 union，失败时给一坨"每个候选都试过"的转储
    // （write-sites.test.ts 的 mk() 同一教训）。
    let parsed: Step;
    try {
      parsed = StepSchema.parse(step) as Step;
    } catch (e) {
      throw new Error(`fixture "${kind}" 过不了 schema（fixture 自己错了，不是被测代码）：${String((e as Error).message).slice(0, 400)}`);
    }
    const flat = flatten([parsed]);
    assert.equal(flat.length, 2, `${kind} 的子步骤对 walk 隐形了（flatten 只看到 ${flat.length} 个）：CHILD_KEYS 缺这个 kind 的子字段`);
    assert.equal(flat[1]!.kind, 'assert', `${kind} 遍历到的第二个节点应该是里面那条 assert`);
  }
  // 反向：表里不该有"装不了子步骤"的 kind
  for (const k of listed) {
    assert.ok(cases.some(([ck]) => ck === k), `CONTAINER_KINDS 里的 ${k} 没有任何测试覆盖它真的能装子步骤`);
  }
});
