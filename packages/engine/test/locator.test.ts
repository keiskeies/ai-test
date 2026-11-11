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

describe('maxCostUsdPerResolve：单次定位的预算真的有人审（schema 默认 $0.02）', () => {
  /*
   * **这个字段以前全仓没有任何地方读它**（grep 只命中 `locator.ts:136` 那一行 schema），
   * 而且比上一节那条 `confidenceGate` 更彻底：那条至少有个写死的 `0.99` 顶在位子上、
   * 行为"看起来像按门限判"，这一条是**连顶替的常数都没有** ——
   * 人在 IR 里写了预算，实际花多少都不管。docs/03 §2 把它写成引擎的一等运行时能力
   * （"超 step → 该步降级到更便宜档位"），而实现上那一层从来没接通过。
   *
   * 接的方式：**adapter 报数**（`ResolveResult.costUsd`，价格表在它那边）、
   * **引擎判**（resolve.ts 的 `chargeResolve`，人写的上限只有引擎读得到）。
   * 让 adapter 自己判超限顺手降级，等于把"价格表与 IR 对不对得上"也藏进 adapter。
   *
   * 三条最要紧的判据（其余是配套）：
   *  1. **超预算判 fail 不判 error**。`error` 走退出码 5，而 `CI_HINT` 教 CI
   *     "5 → 标 error 重试一次" —— 那会把一笔**已经花掉**的钱再花一遍，
   *     也就是这个闸门反过来变成烧穿预算的加速器。所以状态本身是判据，
   *     不只是"报错文案好不好看"。
   *  2. **等待循环里超预算必须停止轮询**。超支在语义上长得像"条件还没满足"，
   *     实现上一旦让它被当成 false 继续轮，一个 10s/500ms 的等待就是 20 次付费定位。
   *     所以这里的判据是 **resolve 次数 == 1**，不是"最终状态对不对"
   *     —— 状态对而轮询没停，是这条缺陷的原始形状。
   *  3. **钱要进总账**。超支那次照样花掉了，漏记会让场景级 `maxCostUsd` 熔断
   *     读到的账本永远比真实花费少（而报告照样写"成本 $0.0000"）。
   */

  /** 一条 tap，`maxCostUsdPerResolve` 由入参控制（undefined = 吃 schema 默认 0.02） */
  const tapScen = (budget: number | undefined): Scenario => defineScenario({
    schemaVersion: '1', id: 'scn.cost', name: 'cost fixture', tags: [],
    env: { environmentRef: 'unit' },
    body: [
      { id: 'd', kind: 'device', target: 'android' } as StepDraft,
      {
        id: 't', kind: 'tap',
        target: {
          intent: '金币图标', primary: { by: 'id', value: 'coin' },
          ...(budget === undefined ? {} : { maxCostUsdPerResolve: budget }),
        },
      } as StepDraft,
    ],
  } as ScenarioDraft);

  /** 每次 resolve 花 `costUsd`，并把调用次数暴露出来（钱是 adapter 报的，所以由它记账） */
  function paidDevice(costUsd: number | undefined, rung = 7): { adapters: AdapterRegistry; calls: () => number } {
    let n = 0;
    const adapters = {
      device: {
        async lease() { return { id: 'L1', deviceRef: 'emulator-1', expiresAt: 0 }; },
        async release() { /* no-op */ },
        async resolve() {
          n++;
          return { resolvedBy: 'visual', rung, confidence: 0.99, nonReplayable: false, handle: 'h', ...(costUsd === undefined ? {} : { costUsd }) };
        },
        async perform() { /* no-op */ },
        async capabilities() { return { snapshotKind: 'uiautomator', locatorBy: ['id'], templateMatch: true }; },
      },
    } as unknown as AdapterRegistry;
    return { adapters, calls: () => n };
  }

  test('超过步骤声明的预算 => fail（不是 error），且归因 case-stale', async () => {
    // 0.021 > 默认 0.02：只超一个最小可辨的量，防止实现里偷偷用了"差一个数量级才报"这种宽容
    const { adapters, calls } = paidDevice(0.021);
    const r = await runScenario({ scenario: tapScen(undefined), clock: deterministicClock(7), adapters });
    const x = r.results.find((y) => y.stepId === 't')!;
    assert.equal(calls(), 1, 'resolve 要真的发生过，否则下面三条都在验一件没发生的事');
    assert.equal(x.status, 'fail', '判 error 就进退出码 5，而 CI_HINT 教 CI 重试一次 = 把这笔钱再花一遍');
    assert.equal(x.cause, 'case-stale', '定位法选贵了是用例问题。product-bug 会让人去查一个不存在的功能 bug');
    assert.match(x.assertionSummary ?? '', /maxCostUsdPerResolve/, '要能说出是被哪条预算拦的');
    // 总账里有这笔钱（钱真的花掉了，不因为"判失败"就当没发生）
    assert.ok(r.costUsd >= 0.021, `场景总账没记这笔超支（实际 $${r.costUsd}）—— 漏记会让 maxCostUsd 熔断读到一本偏小的账`);
  });

  test('在预算之内 => 正常通过，不许"恒 fail"（另一半）', async () => {
    const { adapters, calls } = paidDevice(0.019);
    const r = await runScenario({ scenario: tapScen(undefined), clock: deterministicClock(7), adapters });
    assert.equal(calls(), 1);
    // 0.99 在默认门 0.85 内，但 rung=7 掉级 => healed。这里判的是"没被预算拦"：
    // healed 与 fail 的区别就是预算判据有没有触发
    assert.equal(r.results.find((y) => y.stepId === 't')!.status, 'healed');
    assert.ok(r.costUsd >= 0.019, '门内的花费同样要进总账');
  });

  test('恰好等于预算 => 不拦（`>` 而不是 `>=`）', async () => {
    // 预算 0.02 是人自己声明"这个价我接受"，报红灯就是把人的声明改严
    const { adapters } = paidDevice(0.02);
    const r = await runScenario({ scenario: tapScen(undefined), clock: deterministicClock(7), adapters });
    assert.equal(r.results.find((y) => y.stepId === 't')!.status, 'healed');
  });

  test('预算 0 是合法声明：adapter 报任何正数都拦', async () => {
    // schema 允许 min(0)，语义是"这一步一分钱都不许花在定位上"
    const { adapters } = paidDevice(0.0001);
    const r = await runScenario({ scenario: tapScen(0), clock: deterministicClock(7), adapters });
    assert.equal(r.results.find((y) => y.stepId === 't')!.status, 'fail');
  });

  test('adapter 没报 costUsd => 一律不拦（缺数不等于免费，但更不等于超支）', async () => {
    /*
     * 现在没有任何 adapter 报这个数（`ResolveResult.costUsd` 是本轮加的可选字段）。
     * 若把 undefined 当 0 之外的任何处理，**接上线的那一步就会把所有现存用例判红** ——
     * 而下一个人手上的修法是把预算判据整段删掉（本仓最怕的那种"修法"）。
     * 所以这一半必须钉住：没报数 = 没得审 = 绿。
     */
    const { adapters, calls } = paidDevice(undefined);
    const r = await runScenario({ scenario: tapScen(undefined), clock: deterministicClock(7), adapters });
    assert.equal(calls(), 1);
    assert.equal(r.results.find((y) => y.stepId === 't')!.status, 'healed');
  });

  test('上限取的是**这一步自己的**声明，不是某个全局常数', async () => {
    // 同一笔花费，两条场景给出不同结论，才算证明它是从 locator 上读的
    // （只测"超了会 fail"不够：把上限写成常数 0.02 也能过那一半）
    const strict = await runScenario({ scenario: tapScen(0.01), clock: deterministicClock(7), adapters: paidDevice(0.015).adapters });
    const loose = await runScenario({ scenario: tapScen(0.02), clock: deterministicClock(7), adapters: paidDevice(0.015).adapters });
    assert.equal(strict.results.find((y) => y.stepId === 't')!.status, 'fail');
    assert.equal(loose.results.find((y) => y.stepId === 't')!.status, 'healed');
  });

  /*
   * ── 等待循环：这条预算**唯一会被重复触发**的地方 ──────────────────
   *
   * 一个走视觉档的 `uiPredicate` / `template` 等待，每 poll 一次就是一次完整定位。
   * 本轮之前 `wait.ts` 的两个 resolve 点既不记账也不审预算 ——
   * 也就是说"单次定位上限"这个闸门，在最容易烧钱的那条路径上恰好不存在。
   *
   * **超支那条的判据是 resolve 次数 == 1**：超支在语义上长得像"条件还没满足"，
   * 一旦实现让它被当成 false 继续轮询，最终状态可能照样是 fail（超时也是 fail），
   * 而钱已经花了 20 次。**只看状态会给出一个假绿**，所以这里必须数次数。
   * （实测过那个变异：删掉 waitUntil 里"超预算直接往外抛"那一句 => 轮询 20 次，
   *  这一条变红而其它 18 条全绿。）
   */
  /**
   * @param cond 造哪种等待条件（`uiPredicate` 走 visible，`template` 走 hit）
   * @param satisfied 适配器要不要让条件**第一次就满足**。这决定轮询次数：
   *   true => 1 次；false => 一直轮到超时（用来验"逐轮记账"，见下面第二条）。
   */
  async function runWait(
    cond: 'uiPredicate' | 'template',
    budget: number | undefined,
    costUsd: number,
    satisfied: boolean,
    timeoutMs = 1_000,
    pollMs = 500,
  ) {
    let n = 0;
    // confidence 一分为二：satisfied 时给 0.99（两个条件的门都过得了：
    // uiPredicate 吃 confidenceGate 默认 0.85，template 吃 minConfidence 默认 0.8），
    // 不满足时给 0.5（两个门都过不了 => 条件恒不成立，只能靠超时结束）
    const confidence = satisfied ? 0.99 : 0.5;
    const adapters = {
      device: {
        async resolve() {
          n++;
          return { resolvedBy: 'visual', rung: 7, confidence, nonReplayable: false, handle: 'h', costUsd };
        },
        async capabilities() { return { snapshotKind: 'uiautomator', locatorBy: ['id'], templateMatch: true }; },
      },
    } as unknown as AdapterRegistry;
    const target = {
      intent: '加载中', primary: { by: 'id', value: 'loading' },
      ...(budget === undefined ? {} : { maxCostUsdPerResolve: budget }),
    };
    const condition = cond === 'uiPredicate'
      ? { type: 'uiPredicate', state: 'visible', target }
      : { type: 'template', target, expect: 'hit' };
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.waitcost', name: 'w', tags: [], env: { environmentRef: 'unit' },
      body: [{ id: 'w', kind: 'wait', timeoutMs, pollMs, condition } as StepDraft],
    } as ScenarioDraft);
    const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters });
    return { x: r.results.find((y) => y.stepId === 'w')!, n, cost: r.costUsd };
  }

  test('等待里超预算 => 第一次 poll 就停，不再重复付费（本文件最重要的一条）', async () => {
    // satisfied:true 很要紧：条件本来第一次就能满足，所以"轮询 1 次"这件事
    // **只能**是预算让它停的，与"条件一直不满足所以只轮了一次"分不开的话判据就废了
    const { x, n, cost } = await runWait('uiPredicate', 0.02, 0.021, true);
    assert.equal(n, 1, `等待轮询了 ${n} 次。超支被当成"条件不成立"继续轮 = 把单次超支变成 ${n} 次`);
    assert.equal(x.status, 'fail', '与步骤那一支同一状态：不能进退出码 5');
    assert.equal(x.cause, 'case-stale');
    // 只记了一次钱。轮询没停的话这里会是 n * 0.021
    assert.ok(cost < 0.03, `等待把超支重复记进总账了：$${cost}`);
  });

  test('等待里每次 poll 都记一次账（逐轮，不是只记首轮）', async () => {
    /*
     * 0.003 在默认预算 0.02 内，所以闸门不响；条件恒不成立（confidence 0.5 过不了门），
     * 于是一直轮到 1s 超时。deterministicClock 只在 sleep 上推进，
     * 1000ms/500ms 的形状是 poll@0、poll@500、poll@1000 => **3 次**。
     *
     * 这条与上一条合起来才说明"记账"与"审预算"是**两件事**：
     * 只审不记 = 状态对但账本空（场景级 maxCostUsd 永不触发）；
     * 只记不审 = 账对但闸门空。任缺一条，另一条都会给出误导性的绿。
     *
     * 判据写成 `>= 3 * 0.003` 而不是恰好相等：轮询次数由等待循环决定，
     * 我不想让这条测试同时承担"轮询节奏不许变"的职责（那是 wait.test 的事）。
     */
    const { x, n, cost } = await runWait('uiPredicate', undefined, 0.003, false);
    assert.equal(n, 3, '1s 超时 / 500ms 轮询 = 3 次定位');
    assert.equal(x.status, 'fail', '条件恒不成立 => 超时 fail（预算内的钱不该改变结论）');
    assert.ok(cost >= 3 * 0.003 - 1e-9, `逐轮花费没全进总账（${n} 轮应付 $${n * 0.003}，实际 $${cost}）`);
  });

  test('template 条件同样记账并审预算（第二个 resolve 点，不是顺手接的）', async () => {
    /*
     * 这一条存在的理由是**上一轮那条经验**：`wait.ts` 里有两个 resolve 点，
     * 只接一个的话，症状是"uiPredicate 那类用例有闸门、图像模板那类没有" ——
     * 与 confidenceGate 当年"解释器 0.99、wait 0.5"的分叉一模一样。
     * 所以两个点各要一条，**不能靠一条覆盖两支**。
     */
    const over = await runWait('template', 0.02, 0.021, true);
    assert.equal(over.n, 1);
    assert.equal(over.x.status, 'fail');
    assert.equal(over.x.cause, 'case-stale');
    const ok = await runWait('template', undefined, 0.004, true);
    assert.equal(ok.x.status, 'pass', '预算内且模板命中 => 正常满足');
    assert.ok(ok.cost >= 0.004, '模板那一档的花费也要进总账');
  });
});
