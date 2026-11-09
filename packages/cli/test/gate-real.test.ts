/**
 * 门禁判定的**真实 IR 侧**契约测试。
 *
 * 与 gate.test.ts 的分工：那边手写 results 数组、直接调判定函数，快且能造出
 * 引擎其实产不出的形状；这边**跑真的 runScenario**，把报告原样喂给 gateAfterRun。
 * 两边都要有，因为只有这边能证明"引擎真的会产出那种 results" ——
 * 手写 results 的最大风险是**测了一个现实中不存在的形状**，测试全绿而洞还在原地。
 *
 * 本文件钉的三个洞都是先用手写 results **推不出来**、跑真引擎才看见的：
 *  1. 容器步骤自己报的 fail/error 进不了退出码（parallel 被运行时闸拒 => 0）；
 *  2. 叶子全是 skipped 时"1 个断言全部通过"+ 0；
 *  3. 叶子全是 assertLlm 时同样 0（判"是"时 status 是 pass，光看状态拦不住）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { deterministicClock, runScenario, TransportError } from '@atest/engine';

import { EXIT } from '../src/exit.js';
import { gateAfterRun } from '../src/gate.js';

function scen(body: StepDraft[], extra: Partial<ScenarioDraft> = {}): Scenario {
  return defineScenario({
    schemaVersion: '1', id: 'scn.gate', name: 'gate fixture', tags: [],
    env: { environmentRef: 'unit' }, body, frozen: true, provenance: { origin: 'human' },
    ...extra,
  } as ScenarioDraft);
}

/**
 * 跑真引擎再进门禁判定。
 *
 * 返回**两份**文本，用途不同，别混：
 *  - `why`：带实际 results 行的诊断串，只用于**失败信息**（不然"码不对"这种失败没法查）；
 *  - `said`：只有 gateAfterRun 给的 reason 文本，**断言一律用它**。
 *
 * 这条分界是被变异检查逼出来的，而且是我这个会话自己写的坑：先前只有 why，
 * 断言写成 `assert.match(g.why, /p0/)`（本行是 sed 批量改名前原文，别照着改名后的版本读），
 * 而 why 里拼了 `[p0/parallel=error ...]` 这串
 * 实际结果 —— 于是"理由里点名了 p0"这条断言**恒真**，把消息里的名字删掉都照样绿。
 * 变异集里那条（"orphan 的 error 不加进理由文本"）就是靠它才survived 的。
 * 这正是 docs/08 §3 记的那个缺陷类的又一例：**测试通过的原因与它想验的东西无关**。
 */
async function run1(s: Scenario, adapters: unknown = {}): Promise<{ code: number; said: string; why: string; attn: string[] }> {
  const report = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: adapters as never });
  const d = gateAfterRun({ scenario: s, report, ci: true, allowUnfrozen: false });
  const said = d.reasons.join(' / ');
  const rows = report.results.map((r) => `${r.stepId}/${r.kind}=${r.status}`).join(' ');
  return { code: d.code, said, why: `[${rows}] ${said}`, attn: d.attention };
}

const okAssert = (id: string): StepDraft =>
  ({ id, kind: 'assert', against: '$st', jsonPath: { $: { eq: 200 } } }) as StepDraft;
const seed = (v: unknown): StepDraft => ({ id: 'seed', kind: 'set', assign: { st: v } }) as StepDraft;
/** 会触发 PARALLEL 变量竞态运行时闸的两支：同名写 + 另一支推帧 */
const racingPair = (): StepDraft => ({
  id: 'p0', kind: 'parallel',
  steps: [
    { id: 'b0', kind: 'forEach', items: 'st', as: 'row', maxIterations: 3, steps: [{ id: 'w0', kind: 'set', assign: { shared: 1 } }] },
    { id: 'b1', kind: 'set', assign: { shared: 2 } },
  ],
}) as StepDraft;

// ── 洞 1：容器自己报的错必须进退出码 ──────────────────────────────────────

test('parallel 被运行时闸拒 + 旁边两条会过的断言 => 不能是 0（此前实测 0，还说"2 个断言全部通过"）', async () => {
  const g = await run1(scen([seed(200), okAssert('c0'), racingPair()]));
  assert.equal(g.code, EXIT.RUNTIME, `容器自己报的 error 必须落到"没测成"。实际：${g.why}`);
  // 钉**计数**而不是只钉"名字出现过"：光匹配 p0 会恒真 —— 就算第一行的计数与名单
  // 都漏了它，第二行"其中 1 个是控制流步骤自己报的错（p0）"里还有 p0。
  // （变异「orphan 的 error 不加进理由文本」就是这么活下来的。）
  assert.match(g.said, /1 个步骤\*\*出错\*\*.*p0/, `第一条错误摘要里就要带上它。实际理由：${g.said}`);
});

test('if 的 condition 是坏表达式 => 容器 error 要进退出码，不能被旁边的绿断言掩盖', async () => {
  const g = await run1(scen([
    seed(200), okAssert('c0'),
    { id: 'i0', kind: 'if', condition: '1 +', then: [okAssert('t0')], else: [] } as StepDraft,
  ]));
  assert.equal(g.code, EXIT.RUNTIME, `实际：${g.why}`);
  assert.match(g.said, /i0/);
});

test('容器传递子步骤的失败时**不重复计数**：一次循环失败只算 1 个失败', async () => {
  const g = await run1(scen([
    seed(200),
    { id: 'f0', kind: 'forEach', items: 'st', as: 'row', maxIterations: 3, steps: [{ id: 'bad', kind: 'assert', against: '$st', jsonPath: { $: { eq: 999 } } }] } as StepDraft,
  ]));
  assert.equal(g.code, EXIT.TEST_FAILED, `实际：${g.why}`);
  assert.match(g.said, /1 个断言失败/, `叶子有同状态结论时容器那份不该再数一遍。实际：${g.why}`);
});

test('triage 只降级"断言过严"，不降级"容器压根没跑到子步骤"', async () => {
  const g = await run1(scen([seed(200), okAssert('c0'), racingPair()], { tags: ['triage'] }));
  assert.notEqual(g.code, EXIT.OK, `带 triage 的场景不能因为"标签降级"而什么都没验还拿 0。实际：${g.why}`);
});

// ── 洞 2：全是 skipped 不等于全通过 ───────────────────────────────────────

test('唯一一条断言被守卫跳过 => 不能报 0，也不能说"1 个断言全部通过"（此前两者都发生）', async () => {
  const g = await run1(scen([
    { id: 'c9', kind: 'assert', when: '1 == 2', against: '$st', jsonPath: { $: { eq: 200 } } } as StepDraft,
  ]));
  assert.equal(g.code, EXIT.INVALID, `实际：${g.why}`);
  assert.doesNotMatch(g.said, /全部通过/, '一条都没跑，就不该出现"通过"字样');
  assert.match(g.said, /when/, '要指出去哪一步查原因');
});

test('场景里**有一条真跑过**的断言 + 一条被跳过 => 仍然 0，但要把跳过的那条说出来', async () => {
  const g = await run1(scen([seed(200), okAssert('c0'), {
    id: 'c1', kind: 'assert', when: '1 == 2', against: '$st', jsonPath: { $: { eq: 200 } },
  } as StepDraft]));
  assert.equal(g.code, EXIT.OK, `有确定性结论时不该拦整个场景。实际：${g.why}`);
  assert.match(g.said, /另有 1 个 skipped/, `跳过的必须可见，否则就是被偷偷计入。实际：${g.why}`);
});

// ── 零迭代循环：skipped 有两种成因，下一步动作相反 ──────────────────────────

test('唯一的断言在"一次都没进"的循环体里 => INVALID，且不能让人去查 when 守卫', async () => {
  /*
   * docs/08 登记的 LOOP_CEILING_HIT 同族另一半。改动前实测：体里那条断言**连一行
   * results 都没有**，所以门禁看不见它 —— 有体外断言时退出码 0、理由"1 条断言全部通过"。
   * 引擎侧现在补 skipped 行（control.test.ts 钉那半边），这边钉**门禁真的读到了**：
   * 补行而门禁不读，就又是本仓那个老毛病"字段有了、没人读"。
   *
   * 第二条断言是这条测试的全部价值所在：**两种 skipped 的排查方向相反**。
   * 守卫不成立要去看 when；循环体没跑要去看"数据为什么是空的"。
   * 沿用那句"常见成因是 when"会把人送去查一个根本没写守卫的步骤 ——
   * 而这句话在改动前对所有 skipped 都是对的，所以它不是错在措辞，是错在只有一种成因时才对。
   */
  const g = await run1(scen([
    seed(200),
    { id: 'w', kind: 'while', condition: 'false', maxIterations: 5,
      steps: [{ id: 'body', kind: 'assert', against: '$st', jsonPath: { $: { eq: 200 } } }] } as StepDraft,
  ]));
  assert.equal(g.code, EXIT.INVALID, `循环体一次没进 => 本次没有任何结论。实际：${g.why}`);
  assert.match(g.said, /循环体一次都没进/, `要说清是没跑循环体。实际：${g.why}`);
  assert.doesNotMatch(g.said, /守卫 when 不成立/, '这个场景没有 when，指过去就是误导');
});

test('体外有真断言 + 循环体一次没进 => 仍是 0，但那句必须说出是没跑循环体', async () => {
  /*
   * **这才是现实里最常见的那一半**：数据驱动用例取回空列表，体外还有一条真断言撑着。
   * 退出码是 0（有确定性结论，拦整个场景是误拦），所以绿灯理由那行话是**唯一的提示**。
   * 只说"另有 1 个 skipped"是不够的：CI 日志里每天都能看到 skipped，
   * 而"空数据导致整段没验"和"某条守卫今天不成立"是完全不同的处置。
   */
  const g = await run1(scen([
    seed(200), okAssert('c0'),
    { id: 'w', kind: 'while', condition: 'false', maxIterations: 5,
      steps: [{ id: 'body', kind: 'assert', against: '$st', jsonPath: { $: { eq: 200 } } }] } as StepDraft,
  ]));
  assert.equal(g.code, EXIT.OK, `体外有真结论时不该拦。实际：${g.why}`);
  assert.match(g.said, /skipped（循环体一次都没进）/, `绿灯理由要点名成因。实际：${g.why}`);
  // 不再加一条 doesNotMatch(/全部通过$/) 之类的"反向"断言：理由串以
  // "（不算通过，也不算失败）"收尾，那个正则在实现对不对都恒不匹配 ——
  // 恒过的断言与恒真的断言是同一种东西，写它不如不写。
});

test('when 守卫与"循环体没跑"同时出现 => 两句都要说，不能只报一种', async () => {
  // 混合形状。只报一种的话，另一种就又被静默了 —— 而这条测试防的正是
  // "把分支写成 if/else 二选一"那种看起来更干净的实现。
  const g = await run1(scen([
    seed(200),
    { id: 'g', kind: 'assert', when: '1 == 2', against: '$st', jsonPath: { $: { eq: 200 } } } as StepDraft,
    { id: 'w', kind: 'while', condition: 'false', maxIterations: 5,
      steps: [{ id: 'body', kind: 'assert', against: '$st', jsonPath: { $: { eq: 200 } } }] } as StepDraft,
  ]));
  assert.equal(g.code, EXIT.INVALID, `实际：${g.why}`);
  assert.match(g.said, /循环体一次都没进/, `实际：${g.why}`);
  assert.match(g.said, /守卫 when 不成立/, `实际：${g.why}`);
});

// ── 洞 3：report-only 断言不配单独撑起一个绿灯 ────────────────────────────

/** 一条 report-only 的语义断言。gatePolicy 默认 report-only（ir/src/asserts.ts） */
const llmAssert = (id: string, gatePolicy?: 'report-only' | 'blocking'): StepDraft =>
  ({ id, kind: 'assertLlm', question: '这个返回值符合业务预期吗', evidenceFrom: '$st', ...(gatePolicy ? { gatePolicy } : {}) }) as unknown as StepDraft;

/** 一律判"是"的 judge —— 模拟"LLM 盖章通过"这个危险方向 */
const llmYes = { llm: { async judge() { return { passed: true, evidence: 'ok', costUsd: 0 }; } } };
/** 当 adapters 用时要 cast：AdapterRegistry 其它字段是必填的，这里只给得起 llm */
const asAdapters = (o: object) => o as never;

test('场景只有 report-only 的 assertLlm（模型判"是"，status=pass）=> 不能当门禁用例拿 0', async () => {
  const s = scen([seed(200), llmAssert('l0')]);
  // 先钉住**前提**：这条 assertLlm 在引擎里确实产 status=pass。
  // 不钉的话，"引擎哪天改成返回 triaged"这条测试会照样绿 —— 而那时它测的已经不是本洞了。
  const probe = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: asAdapters(llmYes) });
  const leaf = probe.results.find((r) => r.stepId === 'l0');
  assert.equal(leaf?.status, 'pass', `前提变了：report-only 的 assertLlm 判"是"时不再是 pass（实际 ${leaf?.status}），本测试的靶子要重找`);

  const g = await run1(s, asAdapters(llmYes));
  assert.equal(g.code, EXIT.INVALID, `report-only 断言判"是"不配让 CI 绿。实际：${g.why}`);
  assert.match(g.said, /gatePolicy.*blocking/, '要给出路（显式 blocking 或补确定性断言），否则人只会把断言改成假的硬断言');
});

test('显式写了 gatePolicy:"blocking" 的 assertLlm 算门禁结论（不能被"按 kind 一律排除"误伤）', async () => {
  const g = await run1(scen([seed(200), llmAssert('l0', 'blocking')]), asAdapters(llmYes));
  assert.equal(g.code, EXIT.OK, `人显式要求进门禁，门禁就得认。实际：${g.why}`);
});

// ── call 的子场景：门禁要看**实际跑了什么**，不是"IR 里声明了什么" ──────────
/*
 * 这一段是本轮改 call 时重写的。**旧的那一条测试已经失去鉴别力**：
 * 它断言"只有一个 call 的场景不该被判空场景"，而旧的豁免（`hasCallStep`：IR 里声明了
 * call 就放行）与新判据（看 report.childRuns 里实际跑出来的 IR 与 results）
 * **都让它通过** —— 我把 gate.ts 整个退回旧豁免跑过一次，它照样绿。
 * 那正是 docs/08 §3 记的缺陷类「测试通过的原因和它想验的东西无关」，
 * 而这次是我自己上一轮留下的。所以下面每一条都**至少有一个形状能把新旧判据分开**。
 */

/** 一个只有 call 的父场景 + 把 ref 固定解析到 child 的适配器 */
function withCall(child: Scenario, extraAdapters: Record<string, unknown> = {}): { parent: Scenario; adapters: unknown } {
  const parent = scen([{ id: 'c1', kind: 'call', scenarioRef: 'scn.child', args: { st: 1 } } as unknown as StepDraft]);
  return { parent, adapters: { callScenario: async () => child, ...extraAdapters } };
}

/**
 * 子场景统一带一条自己的 seed。
 *
 * 不是因为 call.args 传不进去（传得进，`childVars` 的 inputs 就是 args 解析出来的），
 * 而是为了让子场景里的断言**不依赖父侧传什么**：父传 st=1 而 okAssert 要 eq:200 的话，
 * 子场景会 fail，测的就不是"门禁怎么判"而是"fixture 有没有对齐"了。
 * 我第一版就是这么错的（三条测试一起红，红的理由还都看着像门禁的 bug）。
 */
const childWith = (steps: StepDraft[]) => scen([seed(200), ...steps], { id: 'scn.child' });

test('call 的子运行会被记进报告（这是新判据唯一的依据，所以先单独钉住它）', async () => {
  const child = childWith([okAssert('childAssert')]);
  const { parent, adapters } = withCall(child);
  const rep = await runScenario({ scenario: parent, clock: deterministicClock(7), adapters: adapters as never });

  assert.ok(!rep.results.some((r) => r.stepId === 'childAssert'),
    '前提：子结果**仍然不并进**父的 results（并进 JUnit 是另一件事，见 docs/08 那条未闭环）');
  assert.equal(rep.childRuns?.length, 1, '子运行没记进来的话，门禁就只能退回"声明即放行"那个旧豁免');
  const c = rep.childRuns?.[0];
  assert.equal(c?.callStepId, 'c1', '要能说出是哪一步的调用，否则提示里没法定位');
  assert.ok(c?.results.some((r) => r.stepId === 'childAssert'), '子场景自己的 results 要原样带着');
  // IR 必须一起带 —— 只有 results 判不了 report-only（判"是"时 status 就是 pass）
  assert.ok(JSON.stringify(c?.scenario).includes('scn.child'), 'gatePolicy 住在 IR 里，不带 IR 就等于没带判据');
});

test('子场景只有一条 report-only 的 assertLlm => 不能靠 call 绕过洞 3（旧的声明即放行会让它绿）', async () => {
  // **这条是本轮最要紧的一条**：洞 3 本来已经修好了（场景只有 report-only assertLlm
  // 时判 INVALID），但"只有一个 call、断言都在子场景里"这个形状从另一道门把它重开了 ——
  // 旧豁免只看"IR 里有没有 call"，而它拿不到子场景的 IR，所以看不见那条是 report-only。
  const { parent, adapters } = withCall(childWith([llmAssert('childLlm')]), llmYes);

  // 先钉前提：子场景里那条 assertLlm 确实跑成了 pass（否则这条测的就不是洞 3 了）
  const probe = await runScenario({ scenario: parent, clock: deterministicClock(7), adapters: adapters as never });
  assert.equal(probe.childRuns?.[0]?.results.find((r) => r.stepId === 'childLlm')?.status, 'pass',
    '前提变了：report-only 的 assertLlm 判"是"时不再是 pass，本测试的靶子要重找');

  const g = await run1(parent, adapters);
  assert.equal(g.code, EXIT.INVALID,
    'LLM 盖章不该让"只有一个 call"的场景绿。这是父场景 + 子场景两层都要过的判据。实际：' + g.why);
  assert.match(g.said, /gatePolicy.*blocking/, '要给出路，否则人只会把子场景里的断言改成假的硬断言');
});

test('子场景的断言全部被守卫跳过 => 判空场景（"声明了 call"不等于"验到了东西"）', async () => {
  // 旧豁免的第二个洞：call 存在就一直放行，于是"全 call 且子场景全跳过"永远绿。
  // 新判据问的是跑出来的东西，所以这种形状照样拦。
  const { parent, adapters } = withCall(childWith([
    { id: 'cs', kind: 'assert', when: '1 == 2', against: '$st', jsonPath: { $: { eq: 1 } } } as StepDraft,
  ]));
  const g = await run1(parent, adapters);
  assert.equal(g.code, EXIT.INVALID, `子场景一条都没跑成，父侧就没有任何结论。实际：${g.why}`);
  assert.doesNotMatch(g.said, /全部通过/);
});

test('子场景有真断言 => 放行，但**不计进本场景的用例数**（那句话要和 JUnit 对得上）', async () => {
  const { parent, adapters } = withCall(childWith([okAssert('a1'), okAssert('a2')]));
  const g = await run1(parent, adapters);
  assert.equal(g.code, EXIT.OK, `子场景给出了确定性结论，父场景不该被判空。实际：${g.why}`);
  // 父场景自己一条断言都没有 => 不能说"2 条断言全部通过"（JUnit 的 tests 是 1，
  // 那个 1 是 call 步骤本身）。本文件的注释一直警告"CI 退出码与报告里的用例数对不上"，
  // 这句理由就是那种对不上的一个入口。
  assert.match(g.said, /本场景自身没有断言/, `父侧零断言时要把话说成实话。实际：${g.said}`);
  assert.match(g.said, /2 条结论全部来自 call 子场景/);
  assert.doesNotMatch(g.said, /^2 条断言全部通过/, '虚报的用例数比不报更难查');
});

test('三层嵌套（断言只在最里层）=> 不能被判空场景', async () => {
  // 这条钉的是 childRuns 的**扁平**合并。只记直接子层的话，父侧看到的是
  // "c1 调了 scn.child，而 scn.child 的 results 里只有一个 call、没有断言" => 判空，
  // 而真相是断言在孙子层跑过了。那是**误拦合法用例**，比漏拦更糟。
  const grand = scen([seed(200), okAssert('g1')], { id: 'scn.grand' });
  const child = scen([{ id: 'c2', kind: 'call', scenarioRef: 'scn.grand', args: { st: 1 } } as unknown as StepDraft], { id: 'scn.child' });
  const parent = scen([{ id: 'c1', kind: 'call', scenarioRef: 'scn.child', args: { st: 1 } } as unknown as StepDraft]);
  const adapters = { callScenario: async (ref: string) => (ref === 'scn.child' ? child : grand) };

  const rep = await runScenario({ scenario: parent, clock: deterministicClock(7), adapters: adapters as never });
  assert.ok(rep.childRuns?.some((c) => c.results.some((r) => r.stepId === 'g1')),
    '孙子层的运行没扁平并进来的话，深层复用的用例会被当成空场景');

  const g = await run1(parent, adapters);
  assert.equal(g.code, EXIT.OK, `实际：${g.why}`);
});

test('父子同名断言时各按**自己那份 IR** 判 gatePolicy（混成一个集合会拿错判据）', async () => {
  // 形状很自然：父场景写了一条 blocking 的 assertLlm，子场景里也有一条叫同名但是
  // report-only 的。如果 reportOnly 是全场一个 Set，子侧那条会把父侧那条**顶掉**，
  // 于是人拿到"你的断言没计入结论"，去查一个本来就写对了的 gatePolicy。
  const child = childWith([llmAssert('shared')]);
  const parent = scen([
    seed(200), llmAssert('shared', 'blocking'),
    { id: 'c1', kind: 'call', scenarioRef: 'scn.child', args: { st: 1 } } as unknown as StepDraft,
  ] as StepDraft[]);
  const adapters = { callScenario: async () => child, ...llmYes };

  const g = await run1(parent, adapters);
  assert.equal(g.code, EXIT.OK,
    `父侧显式写了 blocking，就必须算结论 —— 不能被子场景里同名的 report-only 顶掉。实际：${g.why}`);
});

test('窄性对照：报告没记子运行时（手写 fixture）仍保留宽容，不误拦', async () => {
  // childRuns === undefined 与 [] 必须可区分，这条钉的就是 undefined 那一半：
  // 手写 results 的调用方、别的引擎实现，都不该因为门禁多要一样东西就被判空场景。
  // 而 [] 那一半（记了、确实一个 call 都没跑）不给宽容 —— 由上面几条覆盖。
  const s = scen([{ id: 'c1', kind: 'call', scenarioRef: 'scn.child', args: {} } as unknown as StepDraft]);
  const report = {
    runId: 'r', status: 'pass', startedAt: 0, durMs: 1,
    results: [{ stepId: 'c1', kind: 'call', status: 'pass', durMs: 1, retry: 0, healed: false, nonReplayable: false, keyContext: {}, costUsd: 0, artifactIds: [] }],
    events: [], outputs: {}, costUsd: 0, tally: { pass: 1, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 }, summary: '',
  } as never;
  const d = gateAfterRun({ scenario: s, report, ci: true, allowUnfrozen: false });
  assert.equal(d.code, EXIT.OK, `数据缺失时的让步是给"没记"的，不是给 call 写法的。理由：${d.reasons.join(' / ')}`);
});

test('窄性对照：http 步骤连不上（error）时报 5 而不是 3 —— 病因不能被"没有结论"这个后果盖住', async () => {
  // 这条是把我第一次实现时的顺序错误钉住的。当时"没有一条断言结论"那条闸放在
  // error/fail 之前，于是"http 打不通 + 一条断言"拿到 3 与一句"你没用例"，
  // 而真相是环境没通（5，CI 该重试一次）。e2e 的 init 契约测试先撞到它。
  const g = await run1(scen([
    { id: 'g', kind: 'http', request: { method: 'GET', url: 'http://127.0.0.1:9/x' } } as StepDraft,
    { id: 'a', kind: 'assert', against: '$.step.g.resp.status', jsonPath: { $: { eq: 200 } } } as StepDraft,
  ]));
  assert.equal(g.code, EXIT.RUNTIME, `没适配器/连不上是"没测成"，不是"用例是空的"。实际：${g.why}`);
  assert.match(g.said, /出错/, `实际：${g.why}`);
});

// ── 窄性对照：上面三条闸都不能顺手把正常场景拦掉 ──────────────────────────

test('窄性对照：正常的确定性全绿场景仍然是 0，且理由里不掺"未计入结论"的噪音', async () => {
  const g = await run1(scen([seed(200), okAssert('c0'), okAssert('c1')]));
  assert.equal(g.code, EXIT.OK, `实际：${g.why}`);
  assert.doesNotMatch(g.said, /未计入结论|没有任何断言结论/, '没有异常就别出话，否则真信号会被噪音淹掉');
});

// ── flake：重试之后才通过的步骤 ───────────────────────────────────────────

/*
 * 这一组存在的理由是**本轮那次修复自己造成的洞**：以前一次 flake 会在 results 里
 * 留下 `h:error, h:pass` 两行，红得很吵（虽然吵得没道理：整体状态被一次
 * 已经恢复的失败判成 error）。修好之后**只剩一行 pass**——
 * 也就是说"重跑即通过"这件事从报告里**彻底消失**了。
 *
 * 撤掉噪音而不补上信号，等于把 flake 从"看起来坏了"改成"看起来很好"，
 * 而 flake 治理的第一件事是**让它被看见**（docs/08 §3）。
 * 所以这里钉的是：不改变退出码（重试的存在意义就是吸收抖动，判红等于白重试），
 * 但**必须出现在 reasons 与 attention 里**，点名步骤与"第几次才过"。
 */
const flakyAdapters = (failUntil: number): unknown => ({
  http: {
    async send() {
      flakySends++;
      if (flakySends < failUntil) throw new TransportError('network', 'ECONNREFUSED');
      return { status: 200, headers: {}, body: { st: 200 }, bodyText: '{"st":200}', bytes: 9, truncated: false, durationMs: 2 };
    },
  },
});
let flakySends = 0;

test('一次 flake 之后全绿：退出码仍是 0，但那一步必须被点名', async () => {
  flakySends = 0;
  const g = await run1(scen([
    seed(200),
    { id: 'g', kind: 'http', request: { method: 'GET', url: 'http://x/a' }, retry: { count: 2 } } as StepDraft,
    okAssert('c0'),
  ]), flakyAdapters(2));
  assert.equal(flakySends, 2, '重试没发生的话，下面几条断言验的是一件没发生的事');
  assert.equal(g.code, EXIT.OK, `重试吸收了抖动，不该判红（否则配 retry 毫无意义）。实际：${g.why}`);
  assert.match(g.said, /重试之后|重试后才通过/, `理由里必须说清这一步是重试过的。实际：${g.why}`);
  assert.match(g.said, /\bg\b/, `要点名是哪个步骤。实际：${g.why}`);
  assert.equal(g.attn.length, 1, `要进待确认清单（与 healed 同一处置）。实际：${JSON.stringify(g.attn)}`);
  assert.match(g.attn[0]!, /第 2 次才通过/);
});

test('没有任何重试的正常场景**不许**出现这句（窄性对照）', async () => {
  const g = await run1(scen([seed(200), okAssert('c0')]));
  assert.equal(g.code, EXIT.OK);
  assert.doesNotMatch(g.said, /重试/, '没有 flake 就别出话，否则真信号被噪音淹掉');
  assert.deepEqual(g.attn, []);
});

test('flake 那句排在真正的失败原因**之后**，不抢话', async () => {
  flakySends = 0;
  const g = await run1(scen([
    // st=500 而断言要 200 => 一条**真红**的断言
    seed(500),
    { id: 'g', kind: 'http', request: { method: 'GET', url: 'http://x/a' }, retry: { count: 2 } } as StepDraft,
    okAssert('c0'),
  ]), flakyAdapters(2));
  assert.equal(g.code, EXIT.TEST_FAILED, `有真失败就是 1，flake 那句不能把它盖掉。实际：${g.why}`);
  const iFail = g.said.indexOf('断言失败');
  const iFlaky = g.said.indexOf('重试');
  assert.ok(iFail >= 0, `先要说断言失败。实际：${g.why}`);
  assert.ok(iFlaky > iFail, 'flake 是"这次绿得有多脆"，不该抢在真正的失败原因前面');
});
