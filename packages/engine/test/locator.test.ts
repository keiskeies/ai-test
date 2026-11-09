/**
 * 定位器解析结果 → 步骤结论 的契约（`interpreter.ts` 的 tap/act/navigate 那一支）。
 *
 * 这一块原先**一条测试都没有**（`grep confidence packages/engine/test` 只命中一个
 * lint fixture），所以缺陷是以"没人碰过这条路径"的方式活着的：
 *  - `confidenceGate` 在 schema 里默认 0.85、允许 0.5–1.0，而**全仓没有一处读它**；
 *    执行侧拿写死的 `0.99` 判 —— 写 `confidenceGate: 1.0`（"只接受完全匹配"）的人，
 *    0.99 就按他自己的门限判尚未毕业，实际拿到的却是 pass + 退出码 0（实测）。
 *  - `status`（看 0.99）与 `healed` 旗标（看 `rung>=6`）各算各的，于是能产出
 *    `status:'pass'` + `healed:true`，而 tally 与门禁**都只按 status 过滤**，
 *    那个旗标在报告里等于不存在 —— 掉到阶梯第 6 级以后"必须被看见"的东西看不见。
 *
 * 所以这里的判据全是**成对**的：门内/门外各测一次，只写一边就会被"恒 pass"
 * 或"恒 healed"两种反掉的实现各自骗过。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runScenario, deterministicClock, type AdapterRegistry } from '../src/index.js';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

/**
 * device adapter 桩。resolve 返回**指定的** confidence/rung，其余是最小合法实现。
 * `release` 必须有：teardown 缺它会往报告里塞一条 `__run__=error`，
 * 把要测的结论盖掉（我第一版就栽在这，三条探针全 error，差点去查引擎）。
 */
function stubDevice(confidence: number, rung: number): AdapterRegistry {
  return {
    device: {
      async lease() { return { id: 'L1', deviceRef: 'emulator-1', expiresAt: Date.now() + 600_000 }; },
      async release() { /* no-op */ },
      async resolve() { return { resolvedBy: rung >= 6 ? 'visual' : 'testid', rung, confidence, nonReplayable: false, handle: 'h' }; },
      async perform() { /* no-op */ },
      async capabilities() { return { snapshotKind: 'uiautomator', locatorBy: ['id', 'testid'], templateMatch: true }; },
    },
  } as unknown as AdapterRegistry;
}

/** device 租约 + 一条 tap。confidenceGate 由入参控制（schema 默认 0.85）。 */
function scen(gate: number | undefined, extraBody: StepDraft[] = []): Scenario {
  const body: StepDraft[] = [
    { id: 'd', kind: 'device', target: 'android' } as StepDraft,
    {
      id: 't', kind: 'tap',
      target: { intent: '金币图标', ...(gate === undefined ? {} : { confidenceGate: gate }), primary: { by: 'id', value: 'coin' } },
    } as StepDraft,
    ...extraBody,
  ];
  return defineScenario({
    schemaVersion: '1', id: 'scn.loc', name: 'locator fixture', tags: [],
    env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);
}

async function tap(gate: number | undefined, confidence: number, rung = 7) {
  const r = await runScenario({ scenario: scen(gate), clock: deterministicClock(7), adapters: stubDevice(confidence, rung) });
  const x = r.results.find((y) => y.stepId === 't');
  assert.ok(x, `tap 步骤没进 results（实际：${r.results.map((y) => y.stepId).join(', ')}）`);
  return x!;
}

describe('confidenceGate 真的参与判定', () => {
  test('低于声明门限 => healed，不是 pass（实测改动前这是 pass）', async () => {
    // 1.0 是 schema 允许的上限，语义是"只接受完全匹配"。
    // 写死 0.99 的实现下：0.99 < 0.99 为假 => pass、退出码 0、attention 空 —— 假绿。
    const x = await tap(1.0, 0.99);
    assert.equal(x.status, 'healed', '按人写的门限还没毕业，不该报 pass');
    assert.match(x.assertionSummary ?? '', /置信度门/, '要能说出是被门限拦的，否则和掉级自愈分不开');
  });

  test('达到声明门限 => pass，不能一律 healed（另一半，防"恒 healed"）', async () => {
    const x = await tap(0.85, 0.9, 1); // rung 1 = 便宜路径直接命中
    assert.equal(x.status, 'pass', '门内且没掉级，报 healed 就是把正常用例拉去人审');
    assert.equal(x.healed, false);
  });

  test('门限取的是**这条 locator 自己的**值，不是某个全局常数', async () => {
    // 同一个 confidence，两条场景给出不同结论，才算证明 gate 是从 locator 上读的。
    // （只测"低于时 healed"不够：把 gate 写成常数 0.99 也能过那一半。）
    const strict = await tap(0.98, 0.9, 1);
    const loose = await tap(0.85, 0.9, 1);
    assert.equal(strict.status, 'healed');
    assert.equal(loose.status, 'pass');
  });

  test('没写 confidenceGate 时按 schema 默认 0.85 判，而不是 0.99', async () => {
    // schema 的 default 在 defineScenario 时就填上了，所以执行侧读到的一直是数；
    // 这条钉的是"默认值语义没被执行侧改写"：默认 0.85 下 0.9 必须在门内。
    const x = await tap(undefined, 0.9, 1);
    assert.equal(x.status, 'pass', '0.9 在默认门 0.85 之内；若执行侧偷偷用 0.99，这里就是 healed');
  });
});

describe('uiPredicate 的「在不在」也读同一个门（两个方向阈值相反）', () => {
  /*
   * 这块**原先一条测试都没有**（`grep -rn uiPredicate packages 下所有 test 目录` 命中 0 处），
   * 而我改动它之前它用的是写死的 `0.5` —— 恰好是 confidenceGate 的 schema 下限，
   * 也就是最宽松的那个值，而 `c.target` 一路把人写的门限传到这里然后被丢掉。
   *
   * **两个方向的阈值必须相反，这是本节存在的全部理由**：
   *  - 问"在不在"：低于门限的匹配不算数（收紧 => 多等一会儿或超时，方向安全）；
   *  - 问"走了没"（gone）：**任何匹配都算还在**。若这里也按门限判"在"，
   *    一个 0.6 的弱匹配会被判成"已经消失" => **等待提前成功**，
   *    toast/Loading 消失那类用例要的正是这种假绿。
   * 代价是最坏情况多等到超时（红，看得见），比悄悄绿了便宜。
   */
  const pred = (state: 'visible' | 'gone', gate: number): StepDraft => ({
    id: 'w', kind: 'wait', timeoutMs: 100, pollMs: 50,
    condition: { type: 'uiPredicate', state, target: { intent: '加载中', confidenceGate: gate, primary: { by: 'id', value: 'loading' } } },
  }) as StepDraft;

  async function runPred(state: 'visible' | 'gone', gate: number, confidence: number, handle: string) {
    const adapters = {
      device: {
        async resolve() { return { resolvedBy: 'visual', rung: 7, confidence, nonReplayable: false, handle }; },
        async capabilities() { return { snapshotKind: 'uiautomator', locatorBy: ['id'], templateMatch: true }; },
      },
    } as unknown as AdapterRegistry;
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.pred', name: 'p', tags: [], env: { environmentRef: 'unit' },
      body: [pred(state, gate)],
    } as ScenarioDraft);
    const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters });
    const x = r.results.find((y) => y.stepId === 'w')!;
    return x;
  }

  test('visible：低于门限的匹配不算"在"（会等到超时，而不是立刻满足）', async () => {
    const x = await runPred('visible', 0.9, 0.6, 'h');
    assert.equal(x.status, 'fail', '0.6 < 门 0.9 => 不该算命中。改动前用 0.5 判，这一步直接满足');
  });

  test('visible：达到门限 => 满足（另一半，防"恒 fail"）', async () => {
    const x = await runPred('visible', 0.9, 0.95, 'h');
    assert.equal(x.status, 'pass', x.assertionSummary ?? '');
  });

  test('gone：弱匹配仍算"还在"，不许因低于门限就判成已消失', async () => {
    // 这条钉的是相反的那个方向：0.6 低于门 0.9，但**问的是消失**，
    // 所以必须按"还在"办 => 等待不满足 => fail。
    // 如果实现图省事两个方向共用一个阈值，这一条会拿到 pass —— 那是 fail-open。
    const x = await runPred('gone', 0.9, 0.6, 'h');
    assert.equal(x.status, 'fail', '有 handle 就说明 adapter 还看得见它，判"已消失"是提前成功');
  });

  test('gone：adapter 完全找不到 => 满足', async () => {
    const x = await runPred('gone', 0.9, 0, '');
    assert.equal(x.status, 'pass', x.assertionSummary ?? '');
  });
});

describe('status 与 healed 同源：pass+healed 这种组合不许再出现', () => {
  test('门内但掉级到第 7 级 => healed（以前是 pass+healed=true，下游两条通路都看不见）', async () => {
    // 这组参数是那个洞的**最小现场**：0.99 >= 门 0.85（门内），但掉到阶梯第 7 级。
    // 改动前：status = (0.99 < 0.99) => pass，旗标 = (7>=6) => true。
    // 而 tally 与门禁的 healed 集合**都按 status 过滤** => 这个 true 谁也不读，
    // 实测 `tally.healed=0`、attention 空、退出码 0。
    // （不写成 `if (status==='pass') assert(...)` 那种条件断言：行为一旦不发生它就静默通过，
    //   而"不发生"正是它当年漏过去的方式。）
    const r = await runScenario({ scenario: scen(0.85), clock: deterministicClock(7), adapters: stubDevice(0.99, 7) });
    const t = r.results.find((y) => y.stepId === 't')!;
    assert.equal(t.status, 'healed', '掉级到第 7 级必须让 status 自己变色，而不是只置一个没人读的旗标');
    assert.equal(t.healed, true);
  });

  test('掉级到阶梯第 6 级 => healed 且计入 tally（"必须被看见"不再是空话）', async () => {
    // confidence 满分也拦：掉级本身说明便宜可信的路径没命中，用例行为可能已经变了。
    const r = await runScenario({ scenario: scen(0.85), clock: deterministicClock(7), adapters: stubDevice(1, 6) });
    assert.equal(r.results.find((y) => y.stepId === 't')!.status, 'healed');
    assert.equal(r.tally.healed, 1, 'tally 按 status 计数，status 不同源这里就是 0（实测改动前为 0）');
  });
});
