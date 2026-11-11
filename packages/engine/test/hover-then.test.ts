/**
 * `act.hoverThen` 的运行时闸（静态那一半在 `lint.ts` 的 HOVER_THEN_NOT_IMPLEMENTED）。
 *
 * ## 这一族要守的东西：又一条实测到的假绿
 *
 * `hoverThen` 在 IR 里存在、有 `.default('none')`、被 zod 校验，而**全仓没有任何地方读它**
 * （`grep` 只命中 schema 自己那一行与豁免表）。所以改动前：
 *
 *   act{action:'hover', hoverThen:'click'}  => hover 完就停、**第二件事一件都没做**、步骤 pass
 *
 * docs/06 §2 要这个字段的原话是"hover 与被悬停元素的生命周期绑定，
 * 一旦触发 navigation 就丢失。IR 里需要 `hoverThen` 原子组合节点，
 * 否则用户会写出必然 flaky 的两步"。今天既没有原子节点，也没有第二步 ——
 * 剩下的那个 hover 什么都改变不了，而报告写绿。
 *
 * ## 它比 `expectNewPage` 更难发现，这一点决定了处理方式
 *
 * `expectNewPage` 的默认值是 `false`，一眼能看出"我打开了一个开关"；
 * `hoverThen` 的默认值是 `'none'`，于是**声明 `'click'` 与压根没声明跑起来一模一样**，
 * 连一个可疑信号都不留。这类字段不会有人去查，因为它从不"出问题"。
 *
 * ## 为什么不顺手实现掉（下一个人一定会想做，所以写在这）
 *
 * 动机场景是"hover **A** 才出现 **B**、再点 **B**" —— 两个元素，
 * 而 `act` 只有**一个** `locator`。按现有 schema 只能做成
 * "对同一个元素 hover 完再点它自己"，那**恰好覆盖不了下拉菜单**。
 * 一个语义不符、看起来"实现了"的功能，比不实现更容易让人以为验到了。
 * 所以本轮只堵假绿，语义待定（docs/06 §2 记了那两个候选方向）。
 *
 * ## 为什么 lint 之外还要这一层（本文件存在的理由）
 *
 * `atest run` **默认不跑 lint**（commands.ts 写明是刻意设计：否则 lint error 与
 * 产品失败压成同一个退出码）。只有静态那条规则的话，直接 `atest run` 的人
 * 看到的仍然是绿色 —— 那这条登记本身就成了新的"写了但没人执行"。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runScenario, deterministicClock, type AdapterRegistry } from '../src/index.js';
import { defineScenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

function stubUi() {
  const performed: unknown[] = [];
  return {
    performed,
    registry: {
      ui: {
        async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
        async perform(op: unknown) { performed.push(op); },
        async snapshot() { return { kind: 'aria' as const, data: '', sha: 'x' }; },
        async assertUi() { return { passed: true, actual: 1, expected: 1 }; },
      },
    } as unknown as AdapterRegistry,
  };
}

const hover = (over: Record<string, unknown> = {}): StepDraft =>
  ({
    id: 'a', kind: 'act',
    locator: { intent: '菜单', primary: { by: 'testid', value: 'menu' } },
    action: 'hover', timeoutMs: 500, ...over,
  } as StepDraft);

async function run(body: StepDraft[], adapters: AdapterRegistry) {
  const s = defineScenario({
    schemaVersion: '1', id: 'scn.hoverthen', name: 'r', tags: [], env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);
  return runScenario({ scenario: s, clock: deterministicClock(3), adapters });
}

describe('hoverThen 声明了就必须真的做第二件事（改动前：静默只 hover，判 pass）', () => {
  test('hoverThen:"click" => error，**绝不 pass**（这就是本轮修的那条假绿本身）', async () => {
    const ui = stubUi();
    const r = await run([hover({ hoverThen: 'click' })], ui.registry);
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'error',
      `这是那条假绿本身。实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.equal(r.status, 'error', '整个 run 也不能是 pass —— 一次都没测的东西不该让门禁过');
  });

  test('归因是 env-unavailable 而**不是** product-bug', async () => {
    /*
     * 产品没做错任何事，是**平台**没实现这一步。
     * 判 fail + product-bug 会让人去提一个"菜单点击不生效"的 bug，
     * 而被测产品从头到尾正常工作 —— 这是本仓反复在防的错归因方向。
     */
    const ui = stubUi();
    const r = await run([hover({ hoverThen: 'click' })], ui.registry);
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.cause, 'env-unavailable', `实际 ${x?.cause}`);
    assert.match(x?.assertionSummary ?? '', /未实现|hoverThen/, '摘要要说清是"没实现"，不是"失败了"');
    // 而且要给出路，否则人只能把字段删掉——那等于把需求一起删了
    assert.match(x?.assertionSummary ?? '', /docs\/06|locator|两个/, '要指到能查的地方');
  });

  test('对照：hoverThen 不写（默认 none）=> 正常 hover 并 pass（防"恒 error"）', async () => {
    const ui = stubUi();
    const r = await run([hover()], ui.registry);
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'pass', `默认值被拦的话，每个 hover 步骤都跑不了。实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.equal(ui.performed.length, 1, 'hover 本身要真的执行了');
  });

  test('拦在 **perform 之前**：不会先把 hover 做一次再报错', async () => {
    /*
     * 这条守的是位置。放在 perform 之后的话，被拦下的那一步仍然会
     * **真的动一次页面**（hover 可能触发 lazy load、埋点、菜单展开），
     * 然后才报错 —— 一个"没执行"的步骤留下一半副作用，
     * 而人看到 error 会以为什么都没发生。
     */
    const ui = stubUi();
    await run([hover({ hoverThen: 'click' })], ui.registry);
    assert.deepEqual(ui.performed, [],
      `声明了做不到的组合却仍然动了页面：${JSON.stringify(ui.performed)}`);
  });

  test('hoverThen:"fill" 同样拦（枚举的每个非默认取值都是一条路）', async () => {
    const ui = stubUi();
    const r = await run([hover({ hoverThen: 'fill', value: 'x' })], ui.registry);
    assert.equal(r.results.find((y) => y.stepId === 'a')?.status, 'error');
  });

  test('action 不是 hover 但声明了 hoverThen 也拦（判据是"声明了"，不是"在 hover"）', async () => {
    /*
     * 我写这条规则时**自己先写错成了** `action === 'hover' && hoverThen !== 'none'`，
     * 直觉上很自然（"这是 hover 的字段"）。但 `{action:'click', hoverThen:'click'}`
     * 是 IR 收得下的写法，而它的失效方向与 hover 那一格**完全相同**：
     * 声明了第二件事、平台不做、判 pass。
     * **要拦的是那个字段被声明，不是它碰巧配在哪个动作上。**
     */
    const ui = stubUi();
    const r = await run([hover({ action: 'click', hoverThen: 'click' })], ui.registry);
    assert.equal(r.results.find((y) => y.stepId === 'a')?.status, 'error',
      '绑在 action 上的判据会让这一半静默通过');
  });

  test('setup 里的 act 同样拦（解释器对三段都真跑）', async () => {
    const ui = stubUi();
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.hoverthen.setup', name: 'r', tags: [], env: { environmentRef: 'unit' },
      setup: [hover({ hoverThen: 'click' })],
      body: [{ id: 'n', kind: 'noop' }],
    } as unknown as ScenarioDraft);
    const r = await runScenario({ scenario: s, clock: deterministicClock(3), adapters: ui.registry });
    assert.equal(r.results.find((y) => y.stepId === 'a')?.status, 'error',
      '前置里"hover 出菜单再点一下"是很常见的写法，只查 body 就会漏在那');
  });
});
