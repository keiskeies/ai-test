/**
 * 扫描跑完后要落的第一份测试（本轮先草在 .scratch/，因为测试文件在 `npm test`
 * 的 glob 里，而变异扫描正逐条 spec 跑 `npm test` —— 现在加进去等于给还没跑的
 * spec 塞进它们没预期的用例，红绿就不再回答那份 spec 想问的问题）。
 *
 * 钉的是 `docs/15` §3.3 末尾那张探针表。四条**一条都不能省**，理由写在各自注释里。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lintScenario, toReport } from '../src/index.js';
import { b, scen, tapStep, type StepDraft } from './helpers.js';

const dev = (id: string): StepDraft => ({ ...b(id), kind: 'device', target: 'android' } as StepDraft);
const assertion = (): StepDraft =>
  ({ ...b('a1'), kind: 'assert', against: '$.run', jsonPath: { '$.x': { notNull: true } } }) as StepDraft;

const codes = (body: StepDraft[], extra: object = {}) =>
  lintScenario(scen(body as never[], extra as never)).map((i) => i.code);

describe('RESOURCE_LEASE_MISSING 的遍历范围（docs/15 §3.3 探针 A/A′/B/C）', () => {
  test('A0 **对照**：device 与 tap 都在 body → 不报', () => {
    // 没有这条，下面三句"不报/报"全都不成立：夹具错了也能得到同样的输出。
    const c = codes([dev('d'), tapStep('t'), assertion()]);
    assert.ok(!c.includes('RESOURCE_LEASE_MISSING'));
  });

  test('A device 在 setup、tap 在 body → **不报**（现状是误报，且会拦 CI）', () => {
    const items = lintScenario(scen([tapStep('t'), assertion()] as never, { setup: [dev('d')] } as never));
    const hit = items.find((i) => i.code === 'RESOURCE_LEASE_MISSING');
    assert.ok(!hit, `setup 里的租约对 body 有效（运行时实测：tap=pass），报它就是假阳性：${hit?.message}`);
    // 这一句才是"为什么要修"的分量：error 级 → atest lint 退 3 / run --strict 拒绝执行
    assert.ok(toReport(items).ok, '这条场景真能跑通，lint 必须放行');
  });

  test('C tap 在 setup 而租约在 body 之后 → **要报**（现状是漏报）', () => {
    // setup 先于 body 跑，所以 setup 里那个 tap 那一刻**真的**没有租约。
    // 而 targets 含 android（body 里有 device），排除了"targets 只看 body"那一半原因，
    // 所以这条红了只能是因为遍历没走 setup —— 这才是干净的判据。
    const c = codes([dev('d'), tapStep('t2'), assertion()], { setup: [tapStep('t1')] });
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'));
  });

  test('B tap **只**在 setup（body 里没有任何移动端步骤）→ 要报', () => {
    // 这条钉的是修法的一半：前置条件从 `scenario.targets.some(...)` 换成
    // `deriveTargets([...三层]).some(...)`。只修 walk 不修这里的话，A 与 C 照过
    // （它们的 body 里有 device，targets 因此含 android，那个 .some() 本来就成立），
    // **只有这条会红** —— 它就是"这条修法不是冗余"的证据。
    const c = codes([assertion()], { setup: [tapStep('t1')] });
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'),
      'body 里没有移动端步骤 ⇒ scenario.targets 是空的，但 setup 里那个 tap 确实需要租约');
  });

  test('反向：全场无租约、tap 在 body → 仍然要报（别把闸修成永不响）', () => {
    const c = codes([tapStep('t'), assertion()]);
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'));
  });
});

/*
 * ── 分支作用域：判据从"扁平游标"改成"作用域感知"（与运行时的租约槽同一次改动）──────
 *
 * 旧判据是一条整场单调的游标："先前见过一个 device，后面所有位置都算有租约"。
 * 配上线程无关的容器就会给出与运行事实相反的判定，实测（`.scratch/probe-parallel-lint.mts`）：
 *
 * | 形状（parallel 的分支声明顺序） | 旧 lint | 运行时 |
 * | --- | --- | --- |
 * | `[device,tap]` 在前、裸 `tap` 在后 | **放行** | 裸 tap 那支 error「缺少 device 租约」 |
 * | 裸 `tap` 在前、`[device,tap]` 在后 | error | 同上 |
 *
 * 也就是说**同一件事取决于分支怎么写**，而其中一种是假的：一份 lint 全绿的 IR 跑起来必红。
 * 下面四条钉的就是新判据的四个面：并发隔离、继承外层、互斥容器、以及"别修过头"。
 * **这四条在旧实现下第一条就红**（不是"新加的所以先红"，是旧判据真的放行了一份必红的 IR）。
 */

const dev2 = (id: string): StepDraft => ({ ...b(id), kind: 'device', target: 'android' } as StepDraft);
const seqOf = (id: string, steps: StepDraft[]): StepDraft => ({ ...b(id), kind: 'sequence', steps }) as StepDraft;
const parOf = (id: string, steps: StepDraft[]): StepDraft => ({ ...b(id), kind: 'parallel', steps }) as StepDraft;
const ifOf = (id: string, then: StepDraft[], els: StepDraft[]): StepDraft =>
  ({ ...b(id), kind: 'if', condition: '$.n == 1', then, else: els }) as StepDraft;

describe('RESOURCE_LEASE_MISSING 的分支作用域（parallel / if / switch）', () => {
  test('L1 parallel：兄弟分支里的 device **不算**自己的租约 —— 两种声明顺序同判', () => {
    /*
     * 一条测试覆盖**两个顺序**，因为"取决于书写顺序"正是被修掉的病。
     * 只测一个顺序的话，"把游标改回顺序相关"这种改动能让这条绿着过去。
     */
    const bareFirst = codes([parOf('p', [tapStep('tB'), seqOf('sA', [dev2('dA'), tapStep('tA')])])]);
    const devFirst = codes([parOf('p', [seqOf('sA', [dev2('dA'), tapStep('tA')]), tapStep('tB')])]);
    assert.ok(bareFirst.includes('RESOURCE_LEASE_MISSING'), '裸 tap 那支该报');
    assert.ok(devFirst.includes('RESOURCE_LEASE_MISSING'),
      'device 那支**声明在前面**也要报：分支是并发的，A 支的租约喂不到 B 支（旧实现正是在这里放行了一份必红的 IR）');
  });

  test('L2 parallel：租约在 parallel **之前** → 两支共享同一台，不报', () => {
    /*
     * L1 的**反向对照**。没有它，"parallel 分支一律报"这种荒唐修法能骗过 L1。
     * 运行时同口径：分支槽的初值是**当前这一层**手上那台（`slot.lease`），也就是进入容器时
     * 手上那台（见 interpreter 里 `newLeaseSlot(slot.lease)`，`lease-lifecycle.test.ts`
     * 的"租约在 setup、parallel 两支裸 tap"那条实测它确实只 lease 一次）。
     */
    const c = codes([dev2('d'), parOf('p', [tapStep('t1'), tapStep('t2')])]);
    assert.ok(!c.includes('RESOURCE_LEASE_MISSING'), `外层已有租约，两支都该被放行：${JSON.stringify(c)}`);
  });

  test('L3 parallel 之后手上还是**原来那台**：分支里拿的不算（各支一个槽，出支即还）', () => {
    const c = codes([parOf('p', [seqOf('sA', [dev2('dA'), tapStep('tA')])]), tapStep('after')]);
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'),
      `parallel 里申请的租约出了容器就不在了，容器后那个裸 tap 必须报：${JSON.stringify(c)}`);
  });

  test('L4 if/switch：只有一条路径拿到租约 → 容器之后不算有', () => {
    /*
     * 与 parallel 同一条判断："只有每条路径都有"才是稳的。
     * `if { then:[device] }` 走 else 那一边时，出了 if 手上什么都没有 ——
     * 放行它就是放行一份"看条件运气的 error"。
     * 这条会多问一句（把 device 提到 if 之前即可），那是**假阳性方向**的错，
     * 比反向便宜得多：假阳性让人多加一步申请，结果不变；假阴性让 CI 偶发红。
     */
    const onlyThen = codes([ifOf('i', [dev2('d'), tapStep('tIn')], [tapStep('tElse')]), tapStep('after')]);
    assert.ok(onlyThen.includes('RESOURCE_LEASE_MISSING'),
      `then 里那台在走 else 时不存在，after 那个裸 tap 该报：${JSON.stringify(onlyThen)}`);
    // 反向对照：两条路径都有 → 不报（别把闸做成"if 之后一律报"）
    const bothWays = codes([
      ifOf('i', [dev2('dT'), tapStep('tIn')], [dev2('dE'), tapStep('tElse')]),
      tapStep('after'), assertion(),
    ]);
    assert.ok(!bothWays.includes('RESOURCE_LEASE_MISSING'),
      `两支都自备租约时 after 该被放行：${JSON.stringify(bothWays)}`);
  });

  test('L4b 只有 then 拿到租约、else 是空的 → 容器之后仍算**没有**（变异 S6 就死在这）', () => {
    /*
     * 上面 L4 那条**抓不到 `every` → `some` 这个变异**，我写完才发现：
     * L4 的场景里 else 有一个裸 tap，它在"进入容器时没租约"那条判据下**无论如何都会报**，
     * 于是 `includes('RESOURCE_LEASE_MISSING')` 恒真 —— 那句断言对这个变异是**空转**的。
     * （而它照样是有效测试，只是抓的不是这一件事；两件事分两条写才看得清各自在钉什么。）
     *
     * 要干净地判这一条，场景里**除了容器之后那个裸 tap 之外不能有别的裸设备步**，
     * 这样"报不报"就只由"容器之后有没有"这一个判据决定：
     *  - `every`（对的）：then 有、else 没有 → 之后算没有 → 报；
     *  - `some`（错的）：有一条路径有就算有 → 之后算有 → 不报，一份"走 else 必红"的 IR 放行。
     */
    const c = codes([ifOf('i', [dev2('d')], []), tapStep('after'), assertion()]);
    assert.ok(c.includes('RESOURCE_LEASE_MISSING'),
      `else 是空的（走它就是没租约），after 那个裸 tap 必须报：${JSON.stringify(c)}`);
  });

  test('L5 顺序容器不受影响：sequence / forEach 里前后照旧相连（别修过头）', () => {
    const c = codes([seqOf('sq', [dev2('d'), tapStep('tIn')]), tapStep('after'), assertion()]);
    assert.ok(!c.includes('RESOURCE_LEASE_MISSING'),
      `sequence 里拿的租约出了 sequence 还在手上（顺序执行，不是并发）：${JSON.stringify(c)}`);
  });

  test('L6 嵌套 parallel：内层继承**外层那一支**的租约，不是整场的', () => {
    /*
     * 静态侧早就写对了（`walkLease` 递归时把分支的 entry 一路传下去），
     * 而**运行侧**写错了：分支槽写成 `newLeaseSlot(runSlot.lease)`，
     * 嵌套一层就跳过中间那一层，实测内层那个裸 tap 报「缺少 device 租约」
     * （`.scratch/probe-nested-parallel.mts`），而这里的 lint 判它**该通过**。
     *
     * 所以这条当时是绿的 —— 它**不是**抓出缺陷的那条（抓它的是
     * `lease-lifecycle.test.ts` 里"外层分支自己申请了租约…"那条）。
     * 它钉的是**另一侧**：把 lint 改成"内层不继承外层分支"的话这条会红，
     * 而那次改动必须同时改运行侧。两侧口径不能各走各的 ——
     * 本仓最贵的缺陷族就是"静态闸与运行事实不一致"，**两个方向都贵**：
     * 静态松=放行一份必红的 IR，静态紧=拦掉一份能跑的合法写法。
     */
    const everyBranchSelfEnough = codes([parOf('P', [
      seqOf('brA', [dev2('dA'), parOf('Q', [tapStep('tInner'), assertion()])]),
      seqOf('brB', [dev2('dB'), tapStep('tB'), assertion()]),
      assertion(),
    ])]);
    assert.ok(!everyBranchSelfEnough.includes('RESOURCE_LEASE_MISSING'),
      `每支都自备租约、内层继承外层那一支 → 全场该放行：${JSON.stringify(everyBranchSelfEnough)}`);

    // 反向对照：外层那一支**没有**租约时，内层那个裸 tap 要报。
    // 没有这半句，"内层一律继承"这种荒唐修法能骗过上面那半句（与 L2/L1 成对同理）。
    const noOuter = codes([parOf('P', [seqOf('brA', [parOf('Q', [tapStep('tInner')])]), assertion()])]);
    assert.ok(noOuter.includes('RESOURCE_LEASE_MISSING'),
      `外层分支自己没拿到租约，内层无从继承：${JSON.stringify(noOuter)}`);
  });
});
