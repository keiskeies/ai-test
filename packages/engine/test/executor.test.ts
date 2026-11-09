/**
 * M0.6 的核心判据：**功能形态与预编译形态逐步等价**（docs/09 §4.2）。
 *
 * 为什么这个文件比 executor.ts 本身重要：预编译形态的正确性没法靠"读一遍"确认 ——
 * 它跑得快、返回 pass、outputs 也对，看起来完全正常。它只在**调度规则的边角**上
 * 与解释器分叉（onError='continue'、healed 归约、循环帧销毁、容器记账），
 * 而分叉的症状出现在压测报告上："功能回归全绿、压测报退化 25%"，
 * 排查会一路归因到"后端偶发"。所以这里的写法是**同一条 IR 跑两遍、逐条对齐**，
 * 让分叉在提交前就炸，而不是在别人的看板上线上炸。
 *
 * 对齐的维度刻意受限（见 norm 的注释）：比的是**步骤顺序 + 状态 + healed + outputs**，
 * 不比报错文案（措辞该各自演化）、不比事件/耗时/成本（预编译形态压根不产）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { b, run, scen, type StepDraft } from './helpers.js';
import {
  compilePlan, functionalExecutor, precompiledExecutor, PrecompileRefused,
  deterministicClock, type ExecOutcome,
} from '../src/index.js';
import type { Scenario as ScenarioT } from '@atest/ir';

/**
 * 归一化成可对比的形状。
 * 刻意**不**包含：durMs / events / costUsd / assertionSummary 文案 / retry / artifactIds。
 * 前三个预编译形态压根不产（那是它存在的理由）；文案对比会把测试变成字符串快照，
 * 谁也不敢改报错措辞，最后有人直接放宽整条断言 —— 测试就死了。
 */
function norm(o: ExecOutcome): string {
  return JSON.stringify({
    status: o.status,
    steps: o.steps.map((s) => [s.stepId, s.status, s.healed ? 'H' : '-']),
    outputs: o.outputs,
  });
}

/** 同一条 IR，两种形态，各跑一次。时钟各自新建（同源 seed），避免上一遍用过影响下一遍。 */
async function both(s: ScenarioT, inputs?: Record<string, unknown>, env?: Record<string, unknown>): Promise<{ a: ExecOutcome; c: ExecOutcome }> {
  const a = await functionalExecutor(async (i) => {
    const r = await run(s, { inputs: i.inputs, env: i.env });
    return { status: r.status, results: r.results, outputs: r.outputs };
  }).run({ scenario: s, inputs, env, clock: deterministicClock(42) });
  const plan = compilePlan(s);
  const c = await precompiledExecutor(plan).run({ scenario: s, inputs, env, clock: deterministicClock(42) });
  return { a, c };
}

/** 主判据。失败时把两边逐步并排打出来 —— 只说"字符串不等"会让人对着几十个字符干瞪眼。 */
async function same(s: ScenarioT, inputs?: Record<string, unknown>, env?: Record<string, unknown>): Promise<ExecOutcome> {
  const { a, c } = await both(s, inputs, env);
  if (norm(a) !== norm(c)) {
    const ids = [...new Set([...a.steps.map((x) => x.stepId), ...c.steps.map((x) => x.stepId)])];
    const rows = ids.map((id) => {
      const f = a.steps.filter((x) => x.stepId === id).map((x) => x.status + (x.healed ? '/H' : '')).join('+') || '—';
      const g = c.steps.filter((x) => x.stepId === id).map((x) => x.status + (x.healed ? '/H' : '')).join('+') || '—';
      return `  ${f === g ? ' ' : '!'} ${id.padEnd(14)} 功能=${f.padEnd(12)} 预编译=${g}`;
    });
    assert.fail(`两种形态结论不一致\n整体：功能=${a.status} 预编译=${c.status}\n${rows.join('\n')}\n功能 outputs=${JSON.stringify(a.outputs)}\n预编译 outputs=${JSON.stringify(c.outputs)}`);
  }
  return a;
}

// ── 逐个支持种类的等价性 ────────────────────────────────────────────────────

test('set + assert 基本等价', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { n: 1, t: { expr: '2' } } },
    { ...b('a'), kind: 'assert', against: '$n', expr: '$n > 0' },
  ] as StepDraft[]);
  const r = await same(s);
  assert.equal(r.status, 'pass');
});

test('if 的两个分支都验', async () => {
  const mk = (flag: unknown) => scen([
    { ...b('v'), kind: 'set', assign: { flag } },
    { ...b('i'), kind: 'if', condition: '$flag', then: [{ ...b('t'), kind: 'noop' } as StepDraft], else: [{ ...b('e'), kind: 'noop' } as StepDraft] },
  ] as StepDraft[]);
  assert.deepEqual((await same(mk(true))).steps.map((x) => x.stepId), ['v', 't', 'i']);
  assert.deepEqual((await same(mk(false))).steps.map((x) => x.stepId), ['v', 'e', 'i']);
});

test('switch 命中 case / 落到 default 都等价', async () => {
  const mk = (k: string) => scen([
    { ...b('v'), kind: 'set', assign: { k } },
    { ...b('sw'), kind: 'switch', value: '$k', cases: [{ is: { expr: '"a"' }, steps: [{ ...b('ca'), kind: 'noop' } as StepDraft] }], default: [{ ...b('cd'), kind: 'noop' } as StepDraft] },
  ] as StepDraft[]);
  assert.deepEqual((await same(mk('a'))).steps.map((x) => x.stepId), ['v', 'ca', 'sw']);
  assert.deepEqual((await same(mk('zzz'))).steps.map((x) => x.stepId), ['v', 'cd', 'sw']);
});

/**
 * 循环变量销毁的**可观察**判据：循环结束后引用它必须报"未定义"（error）。
 *
 * 这条是被变异测试逼出来的：我第一版只写"两种形态结论一致"，
 * 于是把 while 的 push('while')/popTo 帧整段删掉，测试照样 35/35 全绿 ——
 * 因为泄漏的变量对**两边的结论没有任何影响**。一个不咬人的测试比没有测试更糟：
 * 它给出虚假的安全感，而下一个人会以为这条已经覆盖了。
 * 判据必须是"泄漏了就报错"，而不是"两边一样"。
 */
const leakCheck = (loopVar: string, tailId: string): StepDraft => ({
  // onError:'continue' 让多个探针能同时跑（第一个报 error 会中断后续，
  // 于是第二个探针压根没执行、查不到状态 —— 这是测试自身的坑，踩过一次）
  ...b(tailId), kind: 'set', assign: { leaked: { path: `$${loopVar}` } }, onError: 'continue',
} as StepDraft);

test('forEach 的迭代变量与销毁等价', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { list: [1, 2, 3], sum: 0 } },
    { ...b('fe'), kind: 'forEach', items: '$list', as: 'x', indexAs: 'i', maxIterations: 10, steps: [
      { ...b('acc'), kind: 'set', assign: { sum: { expr: '$sum + $x' } } },
    ] as StepDraft[] },
    { ...b('fin'), kind: 'set', assign: { total: { expr: '$sum' } } },
    leakCheck('x', 'leakItem'), leakCheck('i', 'leakIdx'),
  ] as StepDraft[], { outputs: [{ name: 'total', from: '$total' }, { name: 'idx', from: '$i' }] });
  const r = await same(s);
  // 真正的判据不只是"两边一致"，还得**值是对的**：两边一起错也算等价（docs/00 §5.9 的教训）
  assert.equal(r.outputs.total, 6, '1+2+3。两边一致还不够，值本身也得对');
  assert.equal(r.steps.filter((x) => x.stepId === 'acc').length, 3);
  // 迭代变量与索引都要随迭代帧一起销毁。这里是 pass 就说明它们泄漏到了全局帧 ——
  // 表现为"循环结束后 $x 还在"，安静污染后续断言（vars.ts 的 popTo 注释记的就是这个坑）。
  assert.equal(r.steps.find((x) => x.stepId === 'leakItem')?.status, 'error', '$x 泄漏到循环外了');
  assert.equal(r.steps.find((x) => x.stepId === 'leakIdx')?.status, 'error', '$i 泄漏到循环外了');
});

test('forEach 的 items 未定义时，两种形态都得报 error 而不是各自静默 0 次', async () => {
  // 这条存在的理由不是"再验一次未定义会错"（control.test.ts 已经钉了行为与 cause），
  // 而是**两种执行形态不能在这一条上分叉**：iterItems 是 resolve.ts 里共用的，
  // 但"抛出后怎么收敛成一步 error"两边是各自实现的（解释器 runStep 的 catch /
  // runSeq 的统一 catch）。分叉的表现是"功能回归全绿、压测形态悄悄跳过整段循环"。
  const s = scen([
    { ...b('fe'), kind: 'forEach', items: '$nosuch', as: 'x', maxIterations: 5,
      steps: [{ ...b('n'), kind: 'noop' }] },
  ] as StepDraft[]);
  const r = await same(s);
  // 一致还不够，得**两边都是 error**：两边一起静默也算"等价"（同上一条注释里那条教训）
  assert.equal(r.status, 'error', `两边一致但都放过了：status=${r.status}`);
  assert.equal(r.steps.find((x) => x.stepId === 'fe')?.status, 'error');
  assert.equal(r.steps.filter((x) => x.stepId === 'n').length, 0, '循环体一步都不该跑');
});

test('forEach 截断行为一致（maxIterations 小于数据量）', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { list: [1, 2, 3, 4, 5], sum: 0 } },
    { ...b('fe'), kind: 'forEach', items: '$list', as: 'x', maxIterations: 2, steps: [
      { ...b('acc'), kind: 'set', assign: { sum: { expr: '$sum + $x' } } },
    ] as StepDraft[] },
    { ...b('fin'), kind: 'set', assign: { total: { expr: '$sum' } } },
  ] as StepDraft[], { outputs: [{ name: 'total', from: '$total' }] });
  const r = await same(s);
  assert.equal(r.outputs.total, 3, '截断成前 2 条：1+2=3。两边都得是 3');
});

test('while 每轮独立作用域（循环内临时变量不跨轮残留）', async () => {
  // 这条专门盯 while 的 push('while')/popTo。
  // 漏压帧的话 tmp 留在全局帧，第二轮 `$vars.tmp` 已存在 —— 两条路径会在这里分叉。
  const s = scen([
    { ...b('v'), kind: 'set', assign: { i: 0, seen: 0 } },
    { ...b('wh'), kind: 'while', condition: '$i < 3', maxIterations: 10, steps: [
      { ...b('tmp'), kind: 'set', assign: { tmp: { expr: '$i * 10' } } },
      { ...b('nx'), kind: 'set', assign: { i: { expr: '$i + 1' }, seen: { expr: '$seen + 1' } } },
    ] as StepDraft[] },
    { ...b('fin'), kind: 'set', assign: { total: { expr: '$seen' } } },
    leakCheck('tmp', 'leak'),
  ] as StepDraft[], { outputs: [{ name: 'total', from: '$total' }] });
  const r = await same(s);
  assert.equal(r.outputs.total, 3);
  assert.equal(r.steps.filter((x) => x.stepId === 'tmp').length, 3, '每轮都要记一条 tmp');
  // 这一条才是"每轮独立作用域"的判据。少了 while 分支里的 push/popTo，
  // tmp 会留在全局帧，这一步就变成 pass —— 变异测试实测过。
  assert.equal(r.steps.find((x) => x.stepId === 'leak')?.status, 'error', '循环内 set 的临时变量必须随轮次销毁');
});

test('while 顶到 maxIterations 时状态一致（不静默死循环）', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { i: 0 } },
    { ...b('wh'), kind: 'while', condition: 'true', maxIterations: 4, steps: [
      { ...b('nx'), kind: 'set', assign: { i: { expr: '$i + 1' } } },
    ] as StepDraft[] },
  ] as StepDraft[]);
  const r = await same(s);
  assert.equal(r.steps.filter((x) => x.stepId === 'nx').length, 4);
});

test('零迭代时两种形态都必须补 skipped 行（不许只在功能形态留痕）', async () => {
  /*
   * 随机属性测试**确实**会造出 `condition:'false'` 的 while，所以这条看起来是重复的。
   * 但它不是：属性测试挂掉时说的是"seed=17 两边不一致"，
   * 而这里要防的失效恰好不是不一致 —— 是**两种形态一起把留痕删掉**，
   * 那种改法属性测试照样全绿（两边都空，norm 相等）。
   * 实测过：把两侧留痕同时抹掉，232 条引擎测试全绿。
   * 所以这条钉的是「**两边都各有一行**」，而不是「两边一样」。
   *
   * 这也是本仓那条老毛病的第三种长相：`LOOP_CEILING_HIT` 只发事件，
   * 而预编译形态没有事件通道（`emit: () => {}`）——
   * "发事件"这种修法在压测形态里天然是空的，功能形态回归全绿、压测形态静默。
   */
  for (const [name, loop] of [
    ['while', { kind: 'while', condition: 'false', maxIterations: 3 }],
    ['forEach', { kind: 'forEach', items: '$rows', as: 'x', maxIterations: 3 }],
  ] as const) {
    const s = scen([
      { ...b('v'), kind: 'set', assign: { rows: [] } },
      { ...b('L'), ...loop, steps: [{ ...b('body'), kind: 'noop' } as StepDraft] } as StepDraft,
    ] as StepDraft[]);
    const { a, c } = await both(s);
    for (const [form, out] of [['功能', a], ['预编译', c]] as const) {
      assert.equal(out.steps.find((x) => x.stepId === 'body')?.status, 'skipped',
        `${name}/${form} 形态：零迭代时循环体必须在 results 里留一行`);
    }
    await same(s);
  }
});

test('repeat 展开后的 id 与计数等价', async () => {
  const s = scen([
    { ...b('rp'), kind: 'repeat', times: 3, steps: [{ ...b('n'), kind: 'noop' } as StepDraft] },
  ] as StepDraft[]);
  const r = await same(s);
  assert.equal(r.steps.filter((x) => x.stepId.startsWith('n')).length, 3, 'flattenTimes 给 id 加 #i，两边同一条路');
});

test('when 守卫不成立记 skipped（不是 pass 也不是 fail）', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { flag: false } },
    { ...b('g'), kind: 'noop', when: '$flag' },
    { ...b('after'), kind: 'noop' },
  ] as StepDraft[]);
  const r = await same(s);
  assert.equal(r.steps.find((x) => x.stepId === 'g')?.status, 'skipped');
  assert.equal(r.status, 'pass', 'skipped 不改整体结论');
});

test('when 守卫条件求值报错 -> 两边都记这一步为 error（语法错与未定义变量分别验）', async () => {
  // **未定义变量**在两条路径里都是 undefined -> 条件假 -> skipped（引擎刻意不抛，
  // "值是 undefined 合法"；拦住它的是 lint 的 VAR_UNDEFINED，不是运行时）。
  const undef = scen([{ ...b('g'), kind: 'noop', when: '$nope_missing > 1' }]);
  const u = await same(undef);
  assert.equal(u.steps.find((x) => x.stepId === 'g')?.status, 'skipped');
  assert.equal(u.status, 'pass', '一步没跑不等于功能不对 —— 空跑该由覆盖率那条线暴露（docs/02 §6）');

  // **语法错**必须两边都记成"这一步 error"。预编译早期版本让它直接抛出 run()：
  // 整体状态确实也是 error，但没有"哪一步坏了"这条记录 —— 压测里几千 VU 同时炸时，
  // 屏幕上只剩一句 ExprError，谁也定位不到步骤。
  for (const bad of ['1 +', '$((', 'nope_fn(1)']) {
    const s2 = scen([{ ...b('g2'), kind: 'noop', when: bad }]);
    const r2 = await same(s2);
    assert.equal(r2.steps.find((x) => x.stepId === 'g2')?.status, 'error', `语法错 ${bad} 应记 error`);
    assert.equal(r2.status, 'error');
  }
});

test('wait{expr} 满足时 pass', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { ready: true } },
    { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: '$ready' }, timeoutMs: 100, pollMs: 50 },
  ] as StepDraft[]);
  const r = await same(s);
  assert.equal(r.steps.find((x) => x.stepId === 'w')?.status, 'pass');
});

test('wait{expr} 不满足时按 onTimeout 三态落地', async () => {
  for (const [onTimeout, want] of [['fail', 'fail'], ['continue', 'pass'], ['error', 'error']] as const) {
    const s = scen([
      { ...b('v'), kind: 'set', assign: { ready: false } },
      { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: '$ready' }, timeoutMs: 100, pollMs: 50, onTimeout } as StepDraft,
      { ...b('tail'), kind: 'noop' },
    ] as StepDraft[]);
    const r = await same(s);
    assert.equal(r.steps.find((x) => x.stepId === 'w')?.status, want, `onTimeout=${onTimeout}`);
    // continue 记 pass、fail 中断后续 —— 两边都得一样
    // fail 与 error 都中断后续（只有 continue 往下走）；continue 记的是 pass
    assert.equal(r.steps.some((x) => x.stepId === 'tail'), onTimeout === 'continue', `onTimeout=${onTimeout} 时尾步是否执行`);
  }
});

// ── 调度规则：与 runChildren 逐条对上 ──────────────────────────────────────

test("onError='continue' 的步骤失败后继续往下跑（两边一致）", async () => {
  // 漏了这条的话：配了 continue 的用能在功能形态跑完 5 步、在压测形态只跑 1 步，
  // 于是压测报告测的是另一条用例，而曲线照样好看。这是最难发现的故障类型。
  const mk = (onError: 'continue' | 'fail'): StepDraft => ({
    ...b('bad'), kind: 'assert', against: '$nope_missing', onError,
  } as StepDraft);
  for (const onError of ['continue', 'fail'] as const) {
    const s = scen([mk(onError), { ...b('tail'), kind: 'noop' }] as StepDraft[]);
    const { a, c } = await both(s);
    const tailRan = (o: ExecOutcome) => o.steps.some((x) => x.stepId === 'tail');
    assert.equal(tailRan(a), onError === 'continue', `功能形态 onError=${onError}`);
    assert.equal(tailRan(c), onError === 'continue', `预编译形态 onError=${onError}`);
    assert.equal(norm(a), norm(c), `onError=${onError} 两边整体不一致`);
  }
});

test('失败步骤后面的步骤不执行，整体状态为 fail', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { n: 1 } },
    { ...b('bad'), kind: 'assert', against: '$n', expr: 'n > 99' },
    { ...b('tail'), kind: 'noop' },
  ] as StepDraft[]);
  const r = await same(s);
  assert.equal(r.status, 'fail');
  assert.ok(!r.steps.some((x) => x.stepId === 'tail'));
});

test('整体状态由逐步结论归约：error 不被后面的 pass 盖掉', async () => {
  // 直接用序列返回值当整体状态会错在这里：某步 error 后面的 pass 把它盖掉，
  // 压测报告于是显示"全绿"，里面藏着 N 条求值失败。
  const s = scen([
    { ...b('bad'), kind: 'assert', against: '$nope_missing' },
  ] as StepDraft[]);
  const { a, c } = await both(s);
  assert.equal(a.status, 'error');
  assert.equal(norm(a), norm(c));
});

test('sequence/if/switch 容器自身也占一条结论，且记在子步骤之后', async () => {
  const s = scen([
    { ...b('seq'), kind: 'sequence', steps: [{ ...b('c1'), kind: 'noop' } as StepDraft, { ...b('c2'), kind: 'noop' } as StepDraft] },
  ] as StepDraft[]);
  const r = await same(s);
  assert.deepEqual(r.steps.map((x) => x.stepId), ['c1', 'c2', 'seq'], '父在子之后（解释器 finish 在 dispatch 返回后才 push）');
});

// ── outputs ───────────────────────────────────────────────────────────────

test('outputs 两边一致，含从步骤导出里取值', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { gift: 'gold' } },
  ] as StepDraft[], { outputs: [{ name: 'g', from: '$gift' }] });
  const r = await same(s);
  assert.equal(r.outputs.g, 'gold');
});

// ── 拒绝清单：不支持的必须点名拒绝，不能被跳过 ────────────────────────────

const REFUSED: Array<[string, StepDraft]> = [
  ['http', { ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/y' } }],
  ['extract', { ...b('e'), kind: 'extract', from: '$x', rules: [{ var: 'v', path: '$.a' }] } as StepDraft],
  ['sleep', { ...b('s'), kind: 'sleep', ms: 10 }],
  ['call', { ...b('c'), kind: 'call', scenarioRef: 'other' } as StepDraft],
  ['parallel', { ...b('p'), kind: 'parallel', steps: [{ ...b('n'), kind: 'noop' } as StepDraft], maxConcurrency: 2 } as StepDraft],
  ['db', { ...b('d'), kind: 'db', datasource: 'main', sql: 'select 1' }],
  ['assertLlm', { ...b('l'), kind: 'assertLlm', question: '这个响应看起来对吗', evidenceFrom: '$x' } as StepDraft],
  ['tap', { ...b('t'), kind: 'tap', target: { intent: '按钮', primary: { by: 'testid', value: 'x' } } }],
  ['table', { ...b('tb'), kind: 'table', rows: [{ a: '{{lit:1}}' }] } as StepDraft],
];

for (const [kind, step] of REFUSED) {
  test(`预编译必须**点名拒绝** ${kind}（而不是静默跳过）`, () => {
    const s = scen([step]);
    let err: unknown;
    try { compilePlan(s); } catch (e) { err = e; }
    assert.ok(err instanceof PrecompileRefused, `${kind} 应抛 PrecompileRefused，实际 ${String(err)}`);
    assert.equal((err as PrecompileRefused).kind, kind);
    assert.equal((err as PrecompileRefused).stepId, (step as { id: string }).id);
  });
}

test('setup/teardown 里的步骤同样过拒绝闸（不许"半条路径被预编译"）', () => {
  // 主体是快的、前置是慢的 -> 压测数字混合两条路径，而报告上看不出来。
  const s = scen([{ ...b('n'), kind: 'noop' }], { setup: [{ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/y' } }] as StepDraft[] });
  assert.throws(() => compilePlan(s), (e: unknown) => e instanceof PrecompileRefused && e.stepId === 'h');
});

test('refused 清单带出被拒步骤，供 UI 显示"这条用例卡在哪几步"', () => {
  const s = scen([{ ...b('n'), kind: 'noop' }, { ...b('s1'), kind: 'sleep', ms: 1 }] as StepDraft[]);
  try { compilePlan(s); assert.fail('本该拒绝'); } catch (e) {
    assert.ok(e instanceof PrecompileRefused);
    // 抛出路径只带 stepId/kind；完整 refused 清单挂在 plan 上给 UI 用，
    // 而拒绝是**第一个就抛**的，所以这里只能拿到那一个 —— 这是刻意的：
    // "把整棵树的错误攒齐再报"要求编译器不提前抛，那样合法用例也编译不过。
    assert.equal(e.stepId, 's1');
    assert.equal(e.kind, 'sleep');
    assert.match(e.message, /压测里的裸 sleep/);
  }
});

test('ops 计数与循环体只算一次（压测成本预估用）', () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { list: [1, 2, 3] } },
    { ...b('fe'), kind: 'forEach', items: 'list', as: 'x', maxIterations: 9, steps: [{ ...b('n'), kind: 'noop' } as StepDraft] },
  ] as StepDraft[]);
  const plan = compilePlan(s);
  // set / forEach(容器) / 循环体 noop / repeat? 无 -> 3 条。循环体只算一条：
  // 迭代次数是运行期的事，编译期报"循环体几条"才对得上"每迭代成本"这个用途。
  assert.equal(plan.ops, 3);
});

test('refs 收出外部表达式，供"每迭代独立"的隔离检查', () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { list: [1] } },
    { ...b('fe'), kind: 'forEach', items: 'list', as: 'x', maxIterations: 3, steps: [{ ...b('n'), kind: 'noop' } as StepDraft] },
    { ...b('wh'), kind: 'while', condition: 'x < 2', maxIterations: 3, steps: [{ ...b('m'), kind: 'noop' } as StepDraft] },
  ] as StepDraft[]);
  const refs = compilePlan(s).refs;
  assert.deepEqual(refs.sort(), ['list', 'x < 2']);
});

// ── 两个形态**刻意**不同的地方：写清楚，别假装一致 ─────────────────────────

test('预编译形态不重试（压测里重试会把一次故障算成两次负载）', () => {
  // 这是与解释器的**已知差异**，不是 bug：withRetry 只在解释器里。
  // 把它写成显式记录，是因为"悄悄不一致的注释比没有注释更坏"。
  const s = scen([{ ...b('n'), kind: 'noop', retry: { count: 3, retryOn: ['network'] } } as StepDraft]);
  const plan = compilePlan(s);
  assert.equal(plan.run({ clock: deterministicClock(1) }).steps.length, 1, 'pass 的步骤本来就不重试；重试语义属 P7');
});

test('两次 run 的变量空间互不污染（压测里每 VU 一份）', () => {
  // 表达式方言里没有 ===（比较运算符只有 == != > >= < <=，== 走共享的 looseEq）
  const s = scen([{ ...b('v'), kind: 'set', assign: { n: 1 } }, { ...b('a'), kind: 'assert', against: '$n', expr: '$n == 1' }] as StepDraft[]);
  const plan = compilePlan(s);
  const r1 = plan.run({ clock: deterministicClock(1) });
  const r2 = plan.run({ clock: deterministicClock(1) });
  assert.equal(r1.status, 'pass');
  assert.equal(r2.status, 'pass', '第二次跑不该看到第一次的残留变量而改变结论');
  assert.deepEqual(r1.steps, r2.steps);
});

test('aborted 后返回 skipped 而不是 error', async () => {
  const s = scen([{ ...b('v'), kind: 'set', assign: { n: 1 } }, { ...b('n2'), kind: 'noop' }] as StepDraft[]);
  const plan = compilePlan(s);
  const r = plan.run({ clock: deterministicClock(1), aborted: () => true });
  assert.equal(r.status, 'skipped');
  assert.match(r.error ?? '', /中止/);
});

// ── 随机场景对齐：手写的用例只覆盖我想到的分叉，属性测试覆盖我没想到的 ──────

/** 确定性 LCG。不用 Math.random：属性测试失败必须能原样复现 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** 造随机但合法的步骤树（只在已支持的子集里造） */
function randStep(r: () => number, depth: number, ids: string[]): StepDraft {
  const id = `s${ids.length}`;
  ids.push(id);
  const pick = (n: number) => Math.floor(r() * n);
  const kids = (k: number) => Array.from({ length: k }, () => randStep(r, depth + 1, ids));
  const leaf: StepDraft[] = [
    { ...b(id), kind: 'set', assign: { [`v${ids.length}`]: pick(2) } },
    { ...b(id), kind: 'noop' },
  ];
  if (depth >= 2 || pick(3) === 0) return leaf[pick(leaf.length)]!;
  const kinds = ['sequence', 'if', 'forEach', 'while', 'repeat', 'switch'] as const;
  const k = kinds[pick(kinds.length)]!;
  const onError = pick(5) === 0 ? 'continue' : 'fail';
  switch (k) {
    case 'sequence': return { ...b(id), kind: 'sequence', steps: kids(2), onError } as StepDraft;
    case 'if': return { ...b(id), kind: 'if', condition: pick(2) ? 'true' : 'false', then: kids(1), else: kids(1), onError } as StepDraft;
    case 'switch': return { ...b(id), kind: 'switch', value: 'true', cases: [{ is: { expr: 'true' }, steps: kids(1) }], default: kids(1), onError } as StepDraft;
    case 'forEach': return { ...b(id), kind: 'forEach', items: '[1, 2]', as: 'x', maxIterations: 1, steps: kids(1), onError } as StepDraft;
    case 'while': return { ...b(id), kind: 'while', condition: 'false', maxIterations: 2, steps: kids(1), onError } as StepDraft;
    case 'repeat': return { ...b(id), kind: 'repeat', times: 2, steps: [{ ...b(`${id}_i`), kind: 'noop' } as StepDraft], onError } as StepDraft;
  }
}

test('属性：随机步骤树两种形态逐步等价（40 例）', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const ids: string[] = [];
    const steps = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randStep(r, 0, ids));
    const s = scen(steps);
    const { a, c } = await both(s);
    assert.equal(norm(a), norm(c), `seed=${seed} 两种形态不一致\n功能=${JSON.stringify(a.steps)}\n预编译=${JSON.stringify(c.steps)}`);
  }
});

test('预编译形态确实不产生事件/证据（这是它存在的理由，别退化成假事件）', () => {
  const s = scen([{ ...b('v'), kind: 'set', assign: { n: 1 } }] as StepDraft[]);
  const out = compilePlan(s).run({ clock: deterministicClock(1) });
  assert.deepEqual(Object.keys(out).sort().filter((k) => k !== 'status' && k !== 'steps' && k !== 'outputs'), []);
});
