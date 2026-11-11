/**
 * `dryRun().estimate` 那一栏：它给前端画的是「约 N 步 · 要/不要设备 · 端 x/y」。
 *
 * ## 这份文件存在的理由：那一栏此前**一个断言都没有**
 *
 * `docs/14` §5 里 `deriveTargets` 那一格写了几十行关于 `estimate.needsDevice` 的判据分析
 * （"它确实在读那个被污染的字段""同样只 .some(...)""读的人还不存在"），
 * 而本轮 grep 过：**全仓没有任何一条测试断过 `estimate` 的任何一个字段**
 * （`grep -rn estimate <各包>/test/` 只命中那条登记自己在注释里的复述）。
 * 于是那份分析无论对不对，都没有可推翻它的东西 —— 这正是 docs/08 §3 那个缺陷类里
 * "(f) 有生产者、没有载体" 的形状：字段有类型、有注释、有读者（前端真在画它），
 * 唯独没有一个会让它红的东西。而注释写错的时候，它比没注释更误导人。
 *
 * ## 本轮改动把那一栏的两个缺陷都现出来了
 *
 * | 字段 | 改前 | 现在 | 为什么 |
 * |---|---|---|---|
 * | `needsDevice` | `scenario.targets.some(是移动端)` | `deriveNeedsDevice(三层)` | 两个独立毛病，见下面两条测试 |
 * | `targets` | 含替 mobile 步骤**猜**出来的那一端 | 只有 `device` 说得出的那些端 | 纯 iOS 场景此前画成「端 ios / android」 |
 *
 * `needsDevice` 那两个毛病值得分开钉，因为**修法不同**：
 *  1. 它读的是 `scenario.targets` 那个**冗余字段**，而那个字段只从 `body` 推
 *     （`ir/index.ts` 的 `withDerivedTargets`）—— 所以"setup 里申请设备、body 里点屏幕"
 *     这个**最常见**的移动端写法答"不要设备"；
 *  2. 判据本身来自**端集合**，而端集合里今天只有 `device` 会发言 ——
 *     漏写 `device` 步的场景答"不要设备"，而它百分百跑不起来。
 * 只修 1（改成现算三层）会把 2 留下；只修 2 会把 1 留下。所以下面是两条测试、两个形状。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dryRun } from '../src/index.js';
import { b, scen, tapStep, type StepDraft } from './helpers.js';

const assertion = (): StepDraft =>
  ({ ...b('a1'), kind: 'assert', against: '$.run', jsonPath: { '$.x': { notNull: true } } }) as StepDraft;
const dev = (target: 'android' | 'ios' | 'harmony' = 'android'): StepDraft =>
  ({ ...b('d'), kind: 'device', target, require: { requires: [] } }) as StepDraft;
const getStep = (): StepDraft =>
  ({ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/y' } }) as StepDraft;

const est = (body: StepDraft[], extra: Record<string, unknown> = {}) =>
  dryRun(scen(body as never[], extra as never)).estimate;

describe('estimate.needsDevice：要说的是"这台机器要不要"，不是"哪个端"', () => {
  test('缺陷 1：device 在 setup、tap 在 body（**最常见的移动端写法**）→ 要设备', () => {
    /*
     * 这一条是本轮量出来的第二个读数（探针 `.scratch/probe-irsha-migration.mts` 的 D 段）：
     * 改前 `scenario.targets` 对这个形状是 `[]`（那个冗余字段只看 body，而 body 里
     * 只有一个现在正确地不报端的 `tap`），于是面板上写着**「不要设备」**，
     * 而那份场景要一台 iOS 机。
     *
     * 为什么这个形状比"随便一个移动端场景"更值得单列：它**不是边界情况**。
     * docs/15 §3.3 那张探针表的 A 格就是它，而 `device` 放 setup 是文档推荐的写法
     * （teardown 之前一定还得上机器）。所以这个假答案覆盖了绝大多数真场景。
     */
    const e = est([tapStep('t'), assertion()], { setup: [dev('ios')] });
    assert.equal(e.needsDevice, true,
      'setup 里申请了设备而面板说"不要设备" => 判据读了那个只从 body 推的冗余字段');
    // 顺带把"这一栏的另一个字段"也对一下：它此刻应当是 ["ios"]（device 说得出的那个端）
    assert.deepEqual(e.targets, ['ios'],
      `端集合要的是"哪一端"。实际 ${JSON.stringify(e.targets)}`);
  });

  test('缺陷 2：漏写 device 步的裸 tap → 仍然要设备（这一格是"派生判据"的漏洞）', () => {
    /*
     * 与上面那条的区别很关键：这里**一个 device 步都没有**，所以任何"从端集合派生"
     * 的写法都会答 false —— 而它要设备（运行时会报「缺少 device 租约」，
     * lint 也报 RESOURCE_LEASE_MISSING）。
     * **一个从派生集合算出来的判据，答不了"这个派生为什么为空"**，
     * 而"为空"在 IR 里往往恰恰就是缺陷本身。
     */
    const e = est([tapStep('t'), assertion()]);
    assert.equal(e.needsDevice, true,
      '要设备与"有没有哪个步骤报了平台"是两件事；从端集合派生 needsDevice 会把漏写 device 当成不需要设备');
    assert.deepEqual(e.targets, [],
      '而端集合此刻是空的 —— 这两个读数**必须同时成立**，只有前者就退化成那个静默缺陷');
  });

  test('对照：纯 API 与纯 Web 场景不要设备（不许把它修成恒真）', () => {
    /*
     * 上面两条都要求 true，所以只有它们的话，`needsDevice = true` 这种改动能全绿通过。
     * 恒真的代价很实际：`atest` 的前端会对着一条纯接口用例说"要设备"，
     * 而用户真的会去插一台安卓机。
     */
    assert.equal(est([getStep(), assertion()]).needsDevice, false, '纯 http 场景不要设备');
    assert.equal(est([{ ...b('n'), kind: 'navigate', url: 'https://x/' }, assertion()]).needsDevice, false,
      '纯 web 场景不要设备（浏览器不是"设备"，那是另一格）');
  });

  test('容器里的移动端步骤也算要设备（parallel / sequence 里的 tap）', () => {
    const e = est([
      { ...b('p'), kind: 'parallel', steps: [tapStep('t')] },
      assertion(),
    ]);
    assert.equal(e.needsDevice, true, 'parallel 分支里的 tap 一样要机器');
    const e2 = est([
      { ...b('s'), kind: 'sequence', steps: [getStep()] },
      assertion(),
    ]);
    assert.equal(e2.needsDevice, false, '而容器里有 http 不等于要设备');
  });
});

describe('estimate.targets：只列**说得出**的端，不许替步骤猜', () => {
  test('纯 iOS 场景只列 ios（改前会多出一个 android，而屏幕上就画着它）', () => {
    /*
     * 改前的读数：`["ios","android"]`。多的那个来自 `tap` —— 它的 `target` 是**定位器**
     * （点哪个元素），跟平台无关，而旧判据把"读不出平台的 mobile 步骤"一律当 android。
     * 这一栏在 `packages/web/src/app.ts` 里是 `est.targets.join('/')`，
     * 所以那个猜出来的端**是给人看的**：一份从没要过安卓机的用例写着「端 ios / android」，
     * 而读的人会以为这条用例要在两台机器上跑。（docs/08 §3 (d)：一个事实有字段、
     * 有测试、却没有面向人的载体 —— 这里反过来：载体有，而**事实是编的**。）
     */
    const e = est([dev('ios'), tapStep('t'), assertion()]);
    assert.deepEqual(e.targets, ['ios'], `实际 ${JSON.stringify(e.targets)}`);
    assert.equal(e.needsDevice, true);
  });

  test('一个元素引用叫 ios，不会让场景声称要 iOS 设备', () => {
    /*
     * `assertUi.target` 是**字符串引用**（指向哪一步的输出），schema 是 `z.string()`，
     * 所以 `target: 'ios'`（"那个叫 ios 的元素"）完全合法。改前它被读成平台，
     * 于是 `deriveTargets` = `["ios"]` 而**这份场景压根没有 device 步**。
     * 现在报空 —— 而 needsDevice 仍为 true（它确实要机器）。
     */
    const e = est([{ ...b('a'), kind: 'assertUi', assertKind: 'visible', target: 'ios' }]);
    assert.deepEqual(e.targets, [], '一个元素名不该变成一台设备');
    assert.equal(e.needsDevice, true, '而"要机器"这件事不受影响：它确实要');
  });

  test('api 与 web 混合场景两个端都列（这一栏不是只给移动端用的）', () => {
    const e = est([getStep(), { ...b('n'), kind: 'navigate', url: 'https://x/' }, assertion()]);
    assert.deepEqual([...e.targets].sort(), ['api', 'web']);
    assert.equal(e.needsDevice, false);
  });
});

describe('estimate 的其余两栏（顺手钉住：这一栏此前零覆盖，不能只修一半）', () => {
  test('steps 数的是**三层含容器内**的全部步骤，不是顶层条数', () => {
    /*
     * 这一格和 needsDevice 是同一条判据问题（"只走 body / 只看顶层"），
     * 而它错了的话面板上那句「大概要跑多久」就整体偏小 ——
     * 那会让人以为一条场景几十秒能跑完。顺手钉住的理由：本轮已经在这块地上
     * 踩过两次"顶层 vs 三层"，第三次不该再靠读代码发现。
     */
    const e = est([
      { ...b('s'), kind: 'sequence', steps: [getStep(), tapStep('t')] },
      assertion(),
    ], { setup: [dev()], teardown: [{ ...b('l'), kind: 'log', message: 'm' }] });
    // setup 1 + body(容器 1 + 内含 2) + 断言 1 + teardown 1 = 6
    assert.equal(e.steps, 6, '容器自己也算一步（它就是会被执行的一个节点），里面的两步也算');
    assert.equal(e.minMs, 6 * 50);
  });

  test('minMs 恒等于 steps × 50 这件事是**有意的**，写成断言防"顺手加权"', () => {
    /*
     * 看着像一条没用的断言，但它挡的是一个具体的坏法：给 http 步 +200ms、
     * 给设备步 +2s 之类。那种加权**看起来**让预估更准，而它引入一张没人校准过的
     * 权重表，而这一栏的用途只是"这条大概要跑多久"的量级提示。
     * 真要精确预估，那是 dryRun 与真跑的历史数据对账（P1 看板的事），不是在这里猜系数。
     */
    for (const body of [[getStep()], [getStep(), assertion()], [dev(), tapStep('t')]]) {
      const e = est(body);
      assert.equal(e.minMs, e.steps * 50, `${e.steps} 步却给出 ${e.minMs}ms：系数表从哪来的？`);
    }
  });
});
