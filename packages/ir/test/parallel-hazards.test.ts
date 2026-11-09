/**
 * `parallelHazards()` 的**边界表**：什么会被拒、什么必须放行。
 *
 * 立这个文件的直接原因是我自己在 `docs/14` 里写下过一句**归错对象的口径**：
 * 「`writtenNames` 是过近似（对分支 JSON 取词，注释与同名字段都算），会误拒」。
 *
 * **要紧的不是"这句错了"，而是它错在哪**（我第一版把它写成"这个实现从来不存在"，
 * 那也是错的 —— 查了 `git log -S` 才发现，别再信任何一个版本，包括这段）：
 * JSON 取词**真的存在过**，`2844da4` 里就有 `for (const m of JSON.stringify(steps)
 * .matchAll(/[A-Za-z0-9_$]+/g))`，只是它在**同文件另一个函数** `mentionedNames()` 里，
 * 服务于第二条判据"一支压帧、另一支提到那个循环项名字"。时间线（都在 11-09，同一次重构）：
 *   19:16 `1933405` 把第二条判据退掉、`mentionedNames` 一起删了；
 *   19:18 `facc092` 我写下上面那句，**两分钟后**，把刚删掉那个机制记到了留下的函数身上。
 * 所以这不是凭空编造，是**快重构时把真实的机制安到了错的名字上** ——
 * 而它比凭空编造更难被发现，因为"这文件里有 JSON 取词"整段时间里都是真的。
 *
 * `writtenNames` 从来只读**声明的写入字段**（`assign` 的键 / `saveAs` / `assignTo` /
 * `as` / `rules[].var` / `outputVars`），不扫表达式、不扫值、不扫注释。实测三条反例：
 * 两支都只读 `$x` 不报、两支 set 的**值**里出现同名文本不报、两支 condition 提同名不报。
 * 结论"闸会过度拒止"本身是对的（见下面 PATH-INSENSITIVE 那组），
 * 但**理由是错的**，于是那个真实存在的过度拒止被记在一个已经不存在的机制上，
 * 下一个人会去改一个不存在的东西。
 *
 * 所以这里钉两件事：
 *  1. **放行侧**（下面 READS 那组）：把"读不算写"从口头承诺变成会红的测试。
 *     这组是那句错口径的**反例** —— 谁哪天把判据改成扫文本，这组当场红。
 *  2. **拒止侧**：真正的过近似在哪一处（PATH-INSENSITIVE 那组），
 *     以及它是**明知故犯**还是疏漏。
 *
 * 与 `engine/test/scope.test.ts` 的分工：那边跑真引擎，验"拒/放"在运行时成立；
 * 这边直接调 `parallelHazards`，钉的是**判据本身**的边界，快且能造出运行时不易构造的形状。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StepSchema, parallelHazards, writtenNames, type Step } from '../src/index.js';

/** 过 schema 造分支（与 write-sites.test.ts 同一条纪律：fixture 错了要当场抛，别静默造出个假形状） */
const branch = (draft: unknown): Step => {
  try {
    return StepSchema.parse(draft) as Step;
  } catch (e) {
    throw new Error(`fixture 过不了 schema（fixture 自己错了，不是被测代码）：${String((e as Error).message).slice(0, 300)}`);
  }
};
const haz = (a: unknown, b: unknown): string[] => parallelHazards([branch(a), branch(b)]).map((h) => h.name);
const noop = { id: 'n', kind: 'noop' };

describe('放行侧：读同名不算写（这条是"writtenNames 扫 JSON 取词"那句错口径的反例）', () => {
  const READS: ReadonlyArray<[string, unknown, unknown]> = [
    ['两支都读 $x，各写各的',
      { id: 'a', kind: 'set', assign: { outA: { expr: '$x + 1' } } },
      { id: 'b', kind: 'set', assign: { outB: { expr: '$x + 2' } } }],
    ['两支的 set **值**里出现同名文本（值是数据，不是变量名）',
      { id: 'a', kind: 'set', assign: { outA: 'x' } },
      { id: 'b', kind: 'set', assign: { outB: 'x' } }],
    ['两支 condition 提同一个名字',
      { id: 'a', kind: 'if', condition: '$flag', then: [{ id: 'a1', kind: 'set', assign: { p: 1 } }], else: [] },
      { id: 'b', kind: 'if', condition: '$flag', then: [{ id: 'b1', kind: 'set', assign: { q: 2 } }], else: [] }],
    ['两支 extract 从同一个源读，各写各的 var',
      { id: 'a', kind: 'extract', from: '$.step.src', rules: [{ var: 'fromA', path: '$.a' }] },
      { id: 'b', kind: 'extract', from: '$.step.src', rules: [{ var: 'fromB', path: '$.a' }] }],
    ['两支 forEach 的循环项同名（都在各自那帧里，物理上互不可见）',
      { id: 'a', kind: 'forEach', items: '[1]', as: 'row', maxIterations: 2, steps: [noop] },
      { id: 'b', kind: 'forEach', items: '[1]', as: 'row', maxIterations: 2, steps: [noop] }],
  ] as const;

  for (const [name, a, b] of READS) {
    test(`放行：${name}`, () => {
      assert.deepEqual(haz(a, b), [], `${name} 不该被拒。判据只认**声明的写入字段**，读/值/注释都不算`);
    });
  }
});

describe('拒止侧：真会串的两种同名', () => {
  test('拒：两支写**外层已声明**的同名（谁后写谁赢，作用域救不了）', () => {
    assert.deepEqual(haz(
      { id: 'a', kind: 'set', assign: { total: 1 } },
      { id: 'b', kind: 'set', assign: { total: 2 } },
    ), ['total']);
  });

  test('拒：两支在**嵌套容器里**写同名（判据要 walk 到底，不能只看直接子步骤）', () => {
    assert.deepEqual(haz(
      { id: 'a', kind: 'forEach', items: '[1]', as: 'i', maxIterations: 2, steps: [{ id: 'a1', kind: 'set', assign: { shared: 1 } }] },
      { id: 'b', kind: 'if', condition: '$c', then: [{ id: 'b1', kind: 'set', assign: { shared: 2 } }], else: [] },
    ), ['shared']);
  });

  test('拒：两支 saveAs 同名（收尾合并只能留一份）', () => {
    assert.deepEqual(haz(
      { id: 'a', kind: 'http', request: { method: 'GET', url: 'http://x/a' }, saveAs: 'resp' },
      { id: 'b', kind: 'http', request: { method: 'GET', url: 'http://x/b' }, saveAs: 'resp' },
    ), ['resp']);
  });
});

describe('明知故犯的过近似：判据是路径不可感的', () => {
  /*
   * 两支的 `if` 条件互补（`$flag` / `!$flag`）时，运行时**只有一支会写** `x`，
   * 合并也只有一份 —— 这条本该放行，实测是**拒**（lint 报 error，解释器同样 error）。
   *
   * **为什么不修**：要放行它，得证明两支的守卫互斥，而 IR 里守卫是表达式字符串。
   * 只认"字面量取反"那种最浅的形状（`x` vs `!x`）会做出一个**看起来像修复的盾牌**：
   * 作者写 `$flag` / `$notFlag`（另一个 set 算出来的互补值）照样被拒，
   * 而文档里会写着"已支持互斥守卫"。本仓对这类盾牌的态度见 parallelHazards 的注释
   * （"这类闸是盾牌不是修复…每加一条都在把 parallel 能写的形状收窄"）——
   * 放宽判据与收紧判据是同一回事：**做半截比不做更坏**。
   * 现状的代价是可控的：改名或拆成 sequence 都是一行的事，而 fix 文案就写着这两条。
   *
   * 这条测试钉的是**当前立场**，不是"这样对"。真要收口，得先有跨表达式的互斥判定，
   * 那时这条测试要改成断言放行。
   */
  test('两支守卫互补 => 仍然拒（路径不可感；已知的过度拒止，不是 bug）', () => {
    assert.deepEqual(haz(
      { id: 'a', kind: 'if', condition: '$flag', then: [{ id: 'a1', kind: 'set', assign: { x: 1 } }], else: [] },
      { id: 'b', kind: 'if', condition: '!$flag', then: [{ id: 'b1', kind: 'set', assign: { x: 2 } }], else: [] },
    ), ['x'], '若哪天这变成放行，说明加了互斥判定 —— 那条改动要连带改这条测试与上面的注释');
  });

  test('call 的子场景写什么**不算**这条分支的写入（子场景是另一个变量空间）', () => {
    /*
     * 这不是漏，是**对的**：`case 'call'` 用 `new VarSpace({...})` 给子场景一份全新的空间，
     * 子的 `set` 落不进父的帧，只有 `assignTo` 会回流（interpreter.ts 的 call 分支）。
     * 所以 writtenNames 对 call 只报 assignTo 恰好是完整答案。
     * 记在这里是因为它长得**很像**一个漏（"子的写入它看不见！"），
     * 而我确实先把它当成漏、读了 call 分支才否掉 —— 别再查一遍。
     */
    const call = branch({ id: 'a', kind: 'call', scenarioRef: 'sub@1' });
    assert.deepEqual(writtenNames([call]), [], 'call 没有 assignTo 时不写任何父作用域的名字');
    const withAssign = branch({ id: 'a', kind: 'call', scenarioRef: 'sub@1', assignTo: 'res' });
    assert.deepEqual(writtenNames([withAssign]), ['res']);
  });
});
