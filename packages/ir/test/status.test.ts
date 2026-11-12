/**
 * `isPassing` —— "这一步算不算通过"的唯一判据。
 *
 * ## 这份文件为什么现在才有
 *
 * 它不是"补个测试"，是**一个函数从测试不可达到可达**的记录。
 * 本轮之前 `isPassing` 全仓只有**一处引用 = 它自己那句声明**（`git grep -c isPassing HEAD` 得 1），
 * 于是它的函数体**没有任何一条测试路径走到**：把它改成恒真、或把 `healed` 也算成通过，
 * 一整套测试一个红都不会出 —— 而那**不是测试写得差，是压根没人调用它**。
 * 本轮把两处手抄的 `status === 'pass'`（`ir/trace.ts` 的 `isFlakyPass`、
 * `engine/interpreter.ts` 的重试循环）接回这个函数之后，它才第一次落在测试能看见的路上。
 *
 * ⚠ 接线本身**不是**这条测试的理由 —— 那两处接线行为完全等价（`isPassing` 就是
 * `status === 'pass'`），接完测试仍然全绿、仍然抓不到任何事。
 * 真正让它可机检的是下面那条 `healed`：`mutate/passing-wiring.json` 里
 * "把 healed 也算通过"那一条**先被判为未抓到**，才暴露出这个判据一个断言都没有。
 * 顺序很重要：**是变异检查发现的缺口，不是我想出来要补的。**
 *
 * ## 为什么在这里逐个状态过一遍，而不是只写 healed 那一条
 *
 * 因为这个函数是**通过率与归因的共同分界**：`isFlakyPass`（gate 的"重试之后才通过"、
 * JUnit 的 `attn="flaky-recovered"`、HTML 的"第 N 次才通过"）与引擎的重试循环都读它。
 * 少列一个状态，下一个动 `STEP_STATUS` 的人就不会再回来补这张表 ——
 * 而漏掉的那一格长得和"已经覆盖了"一模一样。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isPassing, STEP_STATUS, type StepStatus } from '../src/index.js';

describe('isPassing：通过/不通过的那一条线', () => {
  test('六个状态里只有 pass 算通过（逐个过一遍，漏一格看不出来）', () => {
    const passing = STEP_STATUS.filter(isPassing);
    assert.deepEqual(passing, ['pass'], `算通过的状态应当只有 pass，实际是 ${JSON.stringify(passing)}`);
  });

  test('healed **不**算通过（未毕业的自愈不许显示成绿）', () => {
    /*
     * 这条就是上面说的那个缺口。`STEP_STATUS` 里 `healed` 那格的注释写着
     * "**不许显示成绿**（docs/00 §5.6）"，而改前这句话在 `isPassing` 这一侧
     * **一个断言都没有**：把 `return status === 'pass'` 改成
     * `return status === 'pass' || status === 'healed'`，全仓测试全绿。
     *
     * 危害不是"颜色不对"这么轻：`isFlakyPass` 读这个判据，而它的三条产出都是
     * **"看一眼但不用改"那一类**标记（JUnit 里那条 `attn=` 的注释就是这么写的）。
     * 把 healed 混进去，一次**还没毕业**的自愈会被标成 `flaky-recovered` ——
     * 看板上它和"重跑一次就过"的纯抖动同色同级，而这两件事的处理动作相反：
     * 后者可以放，前者要有人去审那次自愈。
     */
    assert.equal(isPassing('healed'), false, '未毕业的自愈算通过 = 把它显示成绿');
  });

  test('skipped / triaged 不算通过，也不算在这一栏里（它们由 countsTowardPassRate 管）', () => {
    /*
     * 这两个是**另一个判据**的地盘：`countsTowardPassRate` 排除 `triaged` 与 `skipped`
     * （它们不该影响通过率分母），而 `isPassing` 回答的是"这一步绿不绿"。
     * 两条线分开写在这里，是为了让"顺手把两个函数合成一个"这种改法当场变红 ——
     * 合成一个的话要么把 skipped 显示成绿，要么把 triaged 拉进分母。
     */
    assert.equal(isPassing('skipped'), false);
    assert.equal(isPassing('triaged'), false);
    assert.equal(isPassing('fail'), false);
    assert.equal(isPassing('error'), false);
  });

  test('判据对 STEP_STATUS 全集都有定义（新增状态时这条会逼人来表态）', () => {
    /*
     * 新增一个状态时，`STEP_STATUS.filter(isPassing)` 不会报错，它只会**默默把它算成不通过**。
     * 那条默认可能正好是错的（比如将来加一个 'healed-graduated'，它该算通过）。
     * 这一条不判对错 —— 它只保证**每个状态都被点名过**，
     * 于是加状态的人必须回来动这张表，而不是让默认值替他决定。
     */
    const seen = new Set<string>();
    for (const s of STEP_STATUS) {
      const v: unknown = isPassing(s as StepStatus);
      assert.equal(typeof v, 'boolean', `${s} 上 isPassing 没返回布尔`);
      seen.add(s);
    }
    assert.equal(seen.size, STEP_STATUS.length, '有状态被跳过');
  });
});
