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
import { deterministicClock, runScenario } from '@atest/engine';

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
async function run1(s: Scenario, adapters: unknown = {}): Promise<{ code: number; said: string; why: string }> {
  const report = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: adapters as never });
  const d = gateAfterRun({ scenario: s, report, ci: true, allowUnfrozen: false });
  const said = d.reasons.join(' / ');
  const rows = report.results.map((r) => `${r.stepId}/${r.kind}=${r.status}`).join(' ');
  return { code: d.code, said, why: `[${rows}] ${said}` };
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

// ── 洞 3：report-only 断言不配单独撑起一个绿灯 ────────────────────────────

/** 一条 report-only 的语义断言。gatePolicy 默认 report-only（ir/src/asserts.ts） */
const llmAssert = (id: string, gatePolicy?: 'report-only' | 'blocking'): StepDraft =>
  ({ id, kind: 'assertLlm', question: '这个返回值符合业务预期吗', evidenceFrom: '$st', ...(gatePolicy ? { gatePolicy } : {}) }) as unknown as StepDraft;

/** 一律判"是"的 judge —— 模拟"LLM 盖章通过"这个危险方向 */
const llmYes = { llm: { async judge() { return { passed: true, evidence: 'ok', costUsd: 0 }; } } } as never;

test('场景只有 report-only 的 assertLlm（模型判"是"，status=pass）=> 不能当门禁用例拿 0', async () => {
  const s = scen([seed(200), llmAssert('l0')]);
  // 先钉住**前提**：这条 assertLlm 在引擎里确实产 status=pass。
  // 不钉的话，"引擎哪天改成返回 triaged"这条测试会照样绿 —— 而那时它测的已经不是本洞了。
  const probe = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: llmYes });
  const leaf = probe.results.find((r) => r.stepId === 'l0');
  assert.equal(leaf?.status, 'pass', `前提变了：report-only 的 assertLlm 判"是"时不再是 pass（实际 ${leaf?.status}），本测试的靶子要重找`);

  const g = await run1(s, llmYes);
  assert.equal(g.code, EXIT.INVALID, `report-only 断言判"是"不配让 CI 绿。实际：${g.why}`);
  assert.match(g.said, /gatePolicy.*blocking/, '要给出路（显式 blocking 或补确定性断言），否则人只会把断言改成假的硬断言');
});

test('显式写了 gatePolicy:"blocking" 的 assertLlm 算门禁结论（不能被"按 kind 一律排除"误伤）', async () => {
  const g = await run1(scen([seed(200), llmAssert('l0', 'blocking')]), llmYes);
  assert.equal(g.code, EXIT.OK, `人显式要求进门禁，门禁就得认。实际：${g.why}`);
});

// ── call 例外：断言在子场景里时，父侧看不见 ≠ 没有断言 ────────────────────

test('场景只有一个 call（断言全在子场景里）=> 不能被"零断言"误拦', async () => {
  // 前提钉死：call 的子结果**确实不回流**父报告（runScenarioIn 只回流 cost 与 events）。
  // 这个例外是为了迁就那个事实而开的口子；哪天子结果并进来了，这条测试与
  // gate.ts 里的 hasCallStep 要一起删掉 —— 否则"全 call 且子场景全跳过"永远绿。
  const child = scen([{ id: 'childAssert', kind: 'assert', against: '$st', jsonPath: { $: { eq: 1 } } } as StepDraft], { id: 'scn.child' });
  const parent = scen([{ id: 'c1', kind: 'call', scenarioRef: 'scn.child', args: { st: 1 } } as unknown as StepDraft]);
  const adapters = { callScenario: async () => child } as never;

  const probe = await runScenario({ scenario: parent, clock: deterministicClock(7), adapters });
  assert.ok(!probe.results.some((r) => r.stepId === 'childAssert'),
    '前提变了：子场景结果已并回父报告，gate.ts 的 hasCallStep 例外该删了（连带这条测试）');

  const g = await run1(parent, adapters);
  assert.equal(g.code, EXIT.OK, `子场景里有断言，父侧看不见不该判"空场景"。实际：${g.why}`);
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
