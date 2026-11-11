/**
 * **循环"没干完"必须在报告里看得见** —— 截断与撞上限这两种情形，
 * 改前与"干完了"给出**逐字节相同**的报告。
 *
 * ## 改前实测（同一份 IR，只差数据量 / 只差条件何时变假）
 *
 * ```
 * forEach  数据 2 条 / 上限 2    => 该步 pass，摘要「迭代 2 次」，整场「100% 通过」
 * forEach  数据 5 条 / 上限 2    => 该步 pass，摘要「迭代 2 次」，整场「100% 通过」  ← 逐字相同
 * while    自然结束（刚好 3 次）  => 该步 pass，摘要「循环 3 次」
 * while    跑满 3 次而条件仍为真  => 该步 pass，摘要「循环 3 次」                    ← 逐字相同
 * ```
 *
 * 唯一的区别是一条 `lint.reported` 事件。而"发一条事件就算说过了"这句话
 * 在本仓**已经有过两次否决**，两次都是同一个理由：
 *  - `gateAfterRun` 里一处 `events` 都没有 —— 门禁不读它（这条纪律写在
 *    `interpreter.ts` 里 `LOOP_BODY_NEVER_RUN` 那一段的注释上，也写在
 *    `control.test.ts` 那条测试的注释里："**为什么不满足于发一条 lint 事件**"）；
 *  - HTML 报告不渲染事件（`html.ts` 里 `events` 零命中，本文件有一条钉子守着，
 *    因为"HTML 报告里有没有"这句话不该靠读代码相信）；
 *  - **预编译形态压根没有事件通道**（`emit: () => {}`）。这一条最狠：
 *    在那个形态里连"只有人眼能看见"都做不到，事件是**一个字都不剩**。
 *
 * 所以本文件全部条目测的都是 **results / ExecOutcome.steps 这一层**，不是事件。
 * 事件那一侧由 `control.test.ts` 与 `executor.test.ts` ExistingCoverage 守着，不重复。
 *
 * ## 为什么状态还是 pass（而这不是"降级"）
 *
 * 上限常常是**故意的**：`while` 当"最多轮询 N 次"、`forEach` 当"只抽前 10 条冒烟"。
 * 把撞上限判成 error 会把这两种正常写法变成用例错误；`while` 那一支更坏 ——
 * 有界轮询后面通常跟着一条真断言，那才是"产品有没有 bug"的判据，
 * 把轮询本身判 error 等于**用一个用例错误盖掉一个产品结论**。
 * 这与 `docs/14` §5 那格 `onTimeout:'fail'`（状态与归因谁让位）是同一个未决问题，
 * 本文件不替它做决定，只钉"必须看得见"这一半。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { b, run, scen, type StepDraft } from './helpers.js';
import { compilePlan, functionalExecutor, precompiledExecutor, deterministicClock, type ExecOutcome } from '../src/index.js';
import type { Scenario as ScenarioT } from '@atest/ir';

const rows = (n: number[]) => ({ ...b('v'), kind: 'set', assign: { list: n } }) as StepDraft;
const each = (cap: number): StepDraft =>
  ({ ...b('fe'), kind: 'forEach', items: '$list', as: 'x', maxIterations: cap, steps: [{ ...b('body'), kind: 'noop' } as StepDraft] }) as StepDraft;
/** while：每轮 n++，条件 n<stop。跑满 cap 次而条件仍真 = 撞上限 */
const bounded = (stop: number, cap: number): StepDraft[] => [
  { ...b('v'), kind: 'set', assign: { n: 0 } } as StepDraft,
  { ...b('wh'), kind: 'while', condition: `$n < ${stop}`, maxIterations: cap,
    steps: [{ ...b('inc'), kind: 'set', assign: { n: { expr: '$n + 1' } } } as StepDraft] } as StepDraft,
];

const sum = (r: { results: Array<{ stepId: string; assertionSummary?: string }> }, id: string): string =>
  r.results.find((x) => x.stepId === id)?.assertionSummary ?? '';

/** 两种形态各跑一次（与 executor.test.ts 的 both 同法，这里只要 note 那一栏） */
async function bothForms(s: ScenarioT): Promise<{ a: ExecOutcome; c: ExecOutcome }> {
  const a = await functionalExecutor(async (i) => {
    const r = await run(s, { inputs: i.inputs, env: i.env });
    return { status: r.status, results: r.results, outputs: r.outputs };
  }).run({ scenario: s, clock: deterministicClock(42) });
  const c = await precompiledExecutor(compilePlan(s)).run({ scenario: s, clock: deterministicClock(42) });
  return { a, c };
}
const noteOf = (o: ExecOutcome, id: string): string | undefined => o.steps.find((x) => x.stepId === id)?.note;

describe('漏报方向：截断与撞上限必须在两种形态的结论里都说出来', () => {
  test('forEach 数据多于上限：两种形态各自都要有一句，且**逐字相同**', async () => {
    /*
     * "各自都要有"与"两边一样"是两条独立的判据，缺一不可：
     * 只断"一样"，两侧一起不说也成立（改前正是这样 —— 两边都不说，所以两边一样）；
     * 只断"各自都有"，两侧措辞分叉看不出来。所以下面是三条断言而不是一个 deepEqual。
     */
    const { a, c } = await bothForms(scen([rows([1, 2, 3, 4, 5]), each(2)] as StepDraft[]));
    const [na, nc] = [noteOf(a, 'fe'), noteOf(c, 'fe')];
    assert.ok(na && na.length > 0, '功能形态的结论里没有这一句（改前：只有事件，而门禁/HTML 都不读事件）');
    assert.ok(nc && nc.length > 0, '预编译形态的结论里没有这一句（改前：这个形态压根没有事件通道，所以那半件事一个字都不剩）');
    assert.equal(na, nc, `两种形态措辞分叉：功能=${JSON.stringify(na)} 预编译=${JSON.stringify(nc)}`);
    assert.match(na!, /3 条/, '要说出**少了几条**，只说"被截断"等于让人数一遍数据');
  });

  test('while 跑满上限而条件仍为真：两种形态各自都要有，且说清"活没干完"', async () => {
    const { a, c } = await bothForms(scen(bounded(10, 3)) as ScenarioT);
    const [na, nc] = [noteOf(a, 'wh'), noteOf(c, 'wh')];
    assert.ok(na && na.length > 0, '功能形态没说');
    assert.ok(nc && nc.length > 0, '预编译形态没说');
    assert.equal(na, nc);
    assert.match(na!, /上限/, '要说出是**被上限切断**，不是"跑完了"（下面那条 notEqual 才管"和自然结束区分得开"）');
    /*
     * 刻意**不**钉"条件仍为真"那四个字。理由有两条，第二条更要紧：
     *  1. 它由"撞上上限"已经蕴含（不为真就自然结束了），信息量是 0
     *     —— 与本轮从 keyContext 里删掉 conditionStillTrue 同一条判断；
     *  2. 钉一句话的前缀正是本仓在 noteNeverRun 那里写过的那类耦合。
     *     **本轮变异集实测到它真会咬人**：把 resolve.ts 的措辞改掉，
     *     这一条就红，而行为一个字没变。
     */
  });

  test('**核心那条**：截断与"数据刚好等于上限"、撞上限与"刚好自然结束"，摘要必须**不同**', async () => {
    /*
     * 这条就是改前的实测失效本身：两组场景各自 pass、各自摘要逐字相同，
     * 于是"3 条数据从没被迭代过"这件事在报告上**不存在**。
     * 断言写成"两个字符串不相等"而不是"其中一个含关键词"，是因为后者在
     * "两句都写了但意思一样"时也会通过 —— 而意思一样正是原来的毛病。
     */
    const full = await run(scen([rows([1, 2]), each(2)] as StepDraft[]));
    const cut = await run(scen([rows([1, 2, 3, 4, 5]), each(2)] as StepDraft[]));
    assert.equal(sum(full, 'fe'), '迭代 2 次', '没截断时摘要要**保持原样**（反方向：不许给每条 forEach 都加一句噪音）');
    assert.notEqual(sum(cut, 'fe'), sum(full, 'fe'), `截断与未截断逐字相同：${sum(cut, 'fe')}`);

    const done = await run(scen(bounded(3, 3)) as ReturnType<typeof scen>);
    const ceiling = await run(scen(bounded(10, 3)) as ReturnType<typeof scen>);
    assert.equal(sum(done, 'wh'), '循环 3 次', '自然结束时也保持原样');
    assert.notEqual(sum(ceiling, 'wh'), sum(done, 'wh'), `撞上限与自然结束逐字相同：${sum(ceiling, 'wh')}`);
    // 两边跑的次数确实一样 —— 否则"摘要不同"只是因为多跑了几轮，测的就不是这件事
    assert.equal(done.results.filter((x) => x.stepId === 'inc').length, 3);
    assert.equal(ceiling.results.filter((x) => x.stepId === 'inc').length, 3);
  });

  test('结构化那一栏也在（门禁与前端不许去匹配句子前缀）', async () => {
    /*
     * 与 noteNeverRun 那条同一个理由：**跨包匹配一句话的前缀是迟早会断的耦合**
     * （改个措辞就悄悄退化，而且没有任何编译期东西会发现）。
     * 这里断的是 keyContext 里的计数，数字错了就是错的，与措辞无关。
     */
    const r = await run(scen([rows([1, 2, 3, 4, 5]), each(2)] as StepDraft[]));
    const k = r.results.find((x) => x.stepId === 'fe')?.keyContext?.truncated as Record<string, number> | undefined;
    assert.ok(k, 'keyContext.truncated 没有 —— 那消费侧只能去匹配句子');
    assert.deepEqual(k, { ran: 2, total: 5, cap: 2 }, `计数不对：${JSON.stringify(k)}`);
  });
});

describe('误报方向：合法写法一句不许多说', () => {
  /*
   * 每条给的是**期望的完整摘要**，而不是"不许出现『上限』两个字"这种否定式正则。
   * 三个理由：
   *  1. 本条要证的本来就是「摘要**逐字**不变」，那就得逐字钉；
   *  2. 否定式正则是**fail-open** 的：将来有人改了措辞，那几个词不再出现，
   *     这条断言就悄悄变成永真 —— 而它守的正是"别多说"，多说了也看不见；
   *     （本轮变异集实测到措辞改正则的代价：resolve.ts 改一句措辞，
   *    `loop-truncated` 里三条钉子一起红，而那三条想说的都是"有没有说出少了几条"。）
   *  3. 与措辞无关的那一半由 keyContext.truncated 单独守（下面第二条断言）。
   * 期望值写在这里而不是从 truncatedByCap/hitCeiling 反推：那两个函数**就是**
   * 被测的东西，拿它们的输出当判据是自我满足的那种假测试。
   */
  const cases: Array<[string, StepDraft[], string, string]> = [
    ['数据刚好等于上限', [rows([1, 2]), each(2)], 'fe', '迭代 2 次'],
    ['数据少于上限', [rows([1]), each(2)], 'fe', '迭代 1 次'],
    ['自然结束', bounded(2, 5) as StepDraft[], 'wh', '循环 2 次'],
    ['一次都没进循环（空数据）', [rows([]), each(2)], 'fe', '迭代 0 次，循环体一条未执行'],
  ];
  test('未截断 / 数据少于上限 / 自然结束 => 零 keyContext、摘要逐字不变', async () => {
    for (const [name, body, id, want] of cases) {
      const r = await run(scen(body));
      assert.equal(r.results.find((x) => x.stepId === id)?.keyContext?.truncated, undefined,
        `${name} 被当成截断了：${JSON.stringify(r.results.find((x) => x.stepId === id)?.keyContext)}`);
      assert.equal(sum(r, id), want, `${name} 的摘要多了一句或被改写了`);
      assert.equal(r.status, 'pass', `${name} 该照常 pass：${r.summary}`);
    }
  });

  test('"一次都没进循环"仍走 LOOP_BODY_NEVER_RUN 那一栏，不冒充截断', async () => {
    /*
     * 两个形状的修法容易合并成一句"反正都要留痕"。它们必须分开：
     * 空数据与"跑了一段被切断"是两种结论，前者多半是数据准备没做，
     * 后者是上限设小了 —— 让人去查错的那一件就是归错因。
     */
    const r = await run(scen([rows([]), each(2)] as StepDraft[]));
    assert.equal(r.results.find((x) => x.stepId === 'fe')?.keyContext?.truncated, undefined);
    assert.ok(r.events.some((e) => e.data?.code === 'LOOP_BODY_NEVER_RUN'), '空数据该走"一次都没进循环"那一族');
    assert.equal(r.results.find((x) => x.stepId === 'body')?.status, 'skipped', '循环体那一行仍在（那是 control.test.ts 立的规矩）');
  });

  test('HTML 报告确实渲染这句话，但**不给容器加表格行**（计数口径的两条腿）', async () => {
    /*
     * 这条同时钉两件**互相拉扯**的事，分开写会各漏一半：
     *  1. 那句话必须在页面上（否则本轮的修复只到 JSON 层为止）；
     *  2. 它**不能以表格行的形式**出现 —— 容器不是用例，`toJUnitXml` 里没有它的
     *     testcase，页面多一行就等于页面用例数与 CI 对不上（本文件开头那段
     *     "最难查的那类不一致"）。
     *
     * 为什么第 2 腿要专门写：**现有那条「容器步骤不出行」的钉子抓不到反方向。**
     * 它的判据是 `htmlNames.filter(n => junitNames.includes(n))`，
     * "页面多出来一行"正好被这个 filter 吃掉 —— 我第一版把带话的容器渲染成表格行，
     * 它全绿，而 `fe` 确实多出了一行。又一条"测试通过的原因和它想验的东西无关"。
     * 所以下面是**双向**判据，而且行 id 只从 `<tr>` 里取（整篇扫 `<code>`
     * 会把提示带、页脚里的代码片段一起算进来，那既会假红也会假绿）。
     */
    const { toHtmlReport, toJUnitXml } = await import('../src/index.js');
    const r = await run(scen([rows([1, 2, 3, 4, 5]), each(2)] as StepDraft[]));
    const html = toHtmlReport(r, {});
    assert.match(html, /3 条/, '报告里没说少了几条 —— 那这一轮的修复只到 JSON 层为止');
    assert.match(html, /有 1 处循环的结论不完整/, '提示带里的计数不对（它得数得准，否则人按它去数要查几处会数错）');

    const rowIds = [...html.matchAll(/<tr[^>]*>.*?<code>([A-Za-z0-9_-]+)<\/code>/g)].map((m) => m[1]!);
    const junit = toJUnitXml(r);
    const caseIds = [...junit.matchAll(/<testcase[^>]*\sname="([^"]+)"/g)].map((m) => m[1]!);
    assert.deepEqual([...rowIds].sort(), [...caseIds].sort(),
      `页面表格行与 JUnit 用例不一致。行=${rowIds.join(',')} 用例=${caseIds.join(',')} —— `
      + '容器被当成用例渲染出来了（页面用例数会和 CI 对不上）就是这里');
    assert.ok(!/<tr[^>]*>[\s\S]{0,400}?<code>fe<\/code>/.test(html), 'forEach 自己出行 = 容器进了用例数');
    assert.equal(/tests="(\d+)"/.exec(junit)?.[1], String(caseIds.length), '夹具前提：JUnit 的 tests 数就是 testcase 条数');
  });

  test('call 子场景里被截断的循环，也要出现在页面上（判据不许只覆盖主表）', async () => {
    /*
     * 本轮差点写成"先扫 report.results 挑出带话的容器"。那个集合**不覆盖**
     * childRuns 的 results，于是"子场景里的循环被截断"又会只在一侧可见 ——
     * 正是这块代码要避免的那件事。这条就是那条路的堵法。
     */
    const { toHtmlReport } = await import('../src/index.js');
    const child = scen([rows([1, 2, 3, 4, 5]), each(2)] as StepDraft[], { id: 'sub.loop' });
    const r = await run(scen([{ ...b('k1'), kind: 'call', scenarioRef: 'sub.loop@1' } as StepDraft]), {
      adapters: { callScenario: async (ref: string) => (ref.startsWith('sub.loop') ? child : undefined) },
    });
    assert.ok((r.childRuns ?? []).length > 0, '夹具前提：子场景要真跑过（否则下面扫的是主表，测的不是这件事）');
    const inChild = (r.childRuns ?? []).some((c) => c.results.some((x) => x.stepId === 'fe' && x.keyContext?.truncated));
    assert.ok(inChild, '夹具前提：截断确实发生在**子场景**里，而不是父场景');
    const html = toHtmlReport(r, {});
    assert.match(html, /3 条/, '子场景里那句话没上页面 —— 判据只覆盖了主表');
    const rowIds = [...html.matchAll(/<tr[^>]*>.*?<code>([A-Za-z0-9_-]+)<\/code>/g)].map((m) => m[1]!);
    assert.ok(!rowIds.includes('fe'), '子场景的容器也不许出行（子场景那段自成一套用例数）');
  });

  test('嵌套循环里「外层数据为空」也上页面，且标题不许说成"没跑完数据"', async () => {
    /*
     * 两个理由各占一半：
     *  1. **载体**：实测 `kc={"neverRun":…}` 挂在**内层容器** fe2 上，而它也是容器 ——
     *     只挂 `truncated` 的话这一整类还是上不了页面（本轮注释里就写错过一次，
     *     写的是"它留下的痕迹是循环体那些 skipped 行，叶子本来就出行"，嵌套下不成立）。
     *  2. **措辞**：数据本来就有 0 条，"没跑完数据"是**假话**（没有该跑而没跑的数据）。
     *     所以标题只能取两类的共同弱命题"结论不完整"，具体哪一类由每行自己的摘要说。
     */
    const { toHtmlReport } = await import('../src/index.js');
    const r = await run(scen([
      { ...b('out'), kind: 'set', assign: { outer: [] } } as StepDraft,
      { ...b('fe1'), kind: 'forEach', items: '$outer', as: 'x', maxIterations: 3, steps: [
        { ...b('fe2'), kind: 'forEach', items: '$x', as: 'y', maxIterations: 3, steps: [
          { ...b('deep'), kind: 'noop' } as StepDraft] } as StepDraft] } as StepDraft,
    ] as StepDraft[]));
    const inner = r.results.find((x) => x.stepId === 'fe2')!;
    assert.equal(inner.kind, 'forEach', '夹具前提：痕迹必须挂在**内层容器**上，否则这条测的不是嵌套');
    const html = toHtmlReport(r, {});
    assert.match(html, /迭代 0 次/, 'neverRun 那句没上页面 —— 提示带只认 truncated');
    assert.match(html, /有 1 处循环的结论不完整/, '计数不对：外层 fe1 自己 pass 且无 keyContext，不该被数进去（数成 2 处就会让人以为有两处要查）');
    assert.ok(!/没跑完数据/.test(html), '外层数据本来就有 0 条，"没跑完数据"是假话');
    assert.match(html, /结论不完整/, '仍要说"这个结论不能当全信用"');
  });

  test('没截断时，那条提示带**整个不出现**（反方向：不许给每个 run 都加一段噪音）', async () => {
    /*
     * 否定式断言是 fail-open 的：提示带的措辞一旦改掉，`!/…/.test(html)`
     * 就变成**永真**，这条钉子从此什么也不守，而它看起来还是绿的。
     * 所以这里带一个**正对照**：同一份判据先在"真该出现"的那份页面上成立，
     * 再要求它在干净的页面上不成立。只断后半句 = 只测了"什么都没匹配到"。
     */
    const { toHtmlReport } = await import('../src/index.js');
    const hasBand = (h: string): boolean => /处循环的结论不完整/.test(h);
    const dirty = toHtmlReport(await run(scen([rows([1, 2, 3, 4, 5]), each(2)] as StepDraft[])), {});
    assert.ok(hasBand(dirty), '判据本身失效了（提示带改名或整段没了）—— 那下面那条否定式断言是永真，不再是判据');
    assert.ok(!hasBand(toHtmlReport(await run(scen([rows([1, 2]), each(2)] as StepDraft[])), {})),
      '数据刚好等于上限的 run 页面上多了一段提示');
    assert.ok(!hasBand(toHtmlReport(await run(scen(bounded(2, 5) as StepDraft[])), {})), '自然结束的 run 多了一段提示');
  });
});
