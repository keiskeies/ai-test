/**
 * 界面类等待条件**问的是哪一世界**（`world`）在引擎侧的落地。
 *
 * ## 这一档的缺陷形状
 * `wait.ts` 里那三处选 adapter 的代码从前各写各的：`uiPredicate`/`uiIdle` 是
 * `ui ?? device`，`template` 反过来是 `device ?? ui`。**改前实测**（`.scratch/probe-which.mts`；
 * 永久形态是本文件里「template 不再优先设备」那条）：两个槽位都在场时，
 * 同一棵 `allOf` 树里 `uiPredicate` 落到浏览器而 `template` 落到手机屏幕。
 * 那不是风格问题 —— 一次等待问了两个世界，摘要里看不出区别，
 * 而**另一世界的"没找到"会被当成这一世界的结论**。
 *
 * ## 为什么判据一律是"哪一路被调用了"
 * 不读引擎内部变量、不看摘要里的中文：假 adapter 各自**记账**，
 * 断的是"哪一路的 resolve/snapshot 被调了几次"。摘要文案本仓改过很多次（`mutate` 集
 * I3 那条等价记录就是为这件事写的），而"谁被调用"是契约、文案不是。
 *
 * ## 最重要的一条是第一条
 * 「说不清就报错」这件事，**光报错不算做到**：`waitUntil` 有一句
 * 「求值报错就当成还没满足、再等一轮」，那句本身是对的（一次数据抖动不该让整步红），
 * 而任何**新加的**求值期异常若没在 `ERROR_CAUSE_RULES` 里登记，就会被它吞成
 * 一次普通超时 + `fail` + product-bug —— 把"IR 少写一个字段"说成"被测产品没做到"。
 * 所以第一条断的是**归因与摘要里没有"超时"这个词**，而不是只断 status。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run, scen, b, loc, res, type StepDraft } from './helpers.js';
import type { AdapterRegistry } from '../src/adapters.js';

/**
 * 两路探针各自记账。
 *
 * `resolve` 返回一个**必然命中**的结果（confidence 1 + 有 handle），
 * 这样"这一步 pass"就不是判据的一部分 —— 判据只有"哪一路被调了"。
 * 反过来说：如果夹具让两路都定不到，那"落到哪一路"与"结果如何"就混在一起了，
 * 那种夹具坏了测试也不会红（本仓那种空测试的形状）。
 */
function spyWorlds(opts: { ui?: boolean; device?: boolean; snapshotSha?: string }) {
  const calls: string[] = [];
  const hit = { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' };
  const mk = (name: string) => ({
    async perform() {},
    async resolve() { calls.push(`${name}.resolve`); return hit; },
    // uiIdle 要连续两次快照一致才判"空闲"，所以 sha 必须稳定
    async snapshot() { calls.push(`${name}.snapshot`); return { kind: 'aria', data: '', sha: opts.snapshotSha ?? 'same' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  });
  const adapters: AdapterRegistry = {};
  if (opts.ui) adapters.ui = mk('ui') as never;
  if (opts.device) adapters.device = mk('device') as never;
  return { adapters, calls };
}

const UI_PRED = (over: Record<string, unknown> = {}) => ({ type: 'uiPredicate', state: 'visible', target: loc(), ...over });
const TEMPLATE = (over: Record<string, unknown> = {}) => ({ type: 'template', expect: 'hit', minConfidence: 0.8, target: loc(), ...over });
const UI_IDLE = (over: Record<string, unknown> = {}) => ({ type: 'uiIdle', quietMs: 10, ...over });

const waitStep = (condition: Record<string, unknown>, over: Record<string, unknown> = {}): StepDraft =>
  ({ ...b('w'), kind: 'wait', condition, timeoutMs: 2_000, pollMs: 100, ...over }) as StepDraft;

/** 跑一条只含这一步等待的场景 */
async function oneWait(condition: Record<string, unknown>, adapters: AdapterRegistry, over: Record<string, unknown> = {}) {
  const r = await run(scen([waitStep(condition, over)]), { adapters });
  return { r, w: res(r, 'w') };
}

test('两个槽位都在场而条件没写 world：**报错，不猜**，且归因是"用例写错"不是"环境不可用"', async () => {
  /*
   * 这一条同时钉三件事，缺一件就有一种坏法过关：
   *  1. **不猜**：两路探针一次都不许被调（"挑一个"的坏法在这里必红，
   *     而挑哪一个都由 `??` 的顺序决定 —— 那是装配顺序，不是用例作者的意思）；
   *  2. **别被"再等一轮"吞掉**：归因必须是 `case-stale`。
   *     判成 `env-unavailable` 会让人去配一个**已经配好的东西**（两个 adapter 都在场）；
   *     而**没在 ERROR_CAUSE_RULES 里登记**的话，它会落到兜底 `untriaged`
   *     并被 `waitUntil` 吞成一次普通超时 —— 那时 status 也是 fail/error，
   *     只有摘要与归因说得出区别，所以下面两句"不许出现超时字样"是判据不是抠文案；
   *  3. 摘要要点出自己的条件名，否则"压根没跑到那一步"的坏 IR 也能过关。
   */
  const { adapters, calls } = spyWorlds({ ui: true, device: true });
  const { w } = await oneWait(UI_PRED(), adapters);
  assert.deepEqual(calls, [], `说不清时一路都不该被调用：${JSON.stringify(calls)}`);
  assert.equal(w.status, 'error', `该是 error（一次都没问成），实际 ${w.status}`);
  assert.equal(w.cause, 'case-stale', `归因要是"用例自己写错"，不是环境缺失`);
  const sum = w.assertionSummary ?? '';
  assert.match(sum, /uiPredicate/, '摘要要点了出是哪一件条件');
  assert.match(sum, /world/, '要说出缺的是 world 这个字段，否则人只会去查 adapter');
  assert.ok(!/等待超时/.test(sum), `不许出现"等待超时"（那会把"一次都没问"说成"问了没等到"）：${sum}`);
  assert.equal(w.keyContext?.waitWorldAmbiguous, true, '结构化那一份也要可得（看板按它分组）');
  assert.equal(w.keyContext?.missingAdapters, undefined,
    '两个 adapter 都在场，**不许**被归进"平台没接线"那一栏（下一步动作相反）');
});

for (const [name, cond] of [
  ['uiPredicate', UI_PRED()],
  ['template', TEMPLATE()],
  ['uiIdle', UI_IDLE()],
] as Array<[string, Record<string, unknown>]>) {
  test(`world: "web" 时**只问浏览器**，另一路一次都不调（${name}）`, async () => {
    /*
     * 「只问一路」是这一族修复的全部内容，所以另一路的**零调用**是主判据。
     * 只断"这一路被调了"不够 —— 那对"两路都问、取第一个答案"这种坏法也成立，
     * 而那种坏法恰好就是本轮改掉的东西（一次等待问了两个世界）。
     *
     * 零调用由那句 `deepEqual(唯一的根, ['ui'])` **一句**承担，不另加
     * `!calls.some(c => c.startsWith('device.'))`：前一句已经排除了任何别的根，
     * 加第二句只是把同一个判据抄两遍（本仓那一族"两处各一份、迟早只更新一处"
     * 连测试里的一处都不豁免）。
     * 我第一版就是抄了两遍，而抄错的那一遍正好错了 `template` 那一条
     * （写成"不许调 ui"），**红的是测试自己**：一个多余断言的真实代价当场兑现。
     */
    const { adapters, calls } = spyWorlds({ ui: true, device: true });
    const { w } = await oneWait({ ...cond, world: 'web' }, adapters);
    assert.equal(w.status, 'pass', `这一步该跑通：${(w.assertionSummary ?? '').slice(0, 120)}`);
    assert.ok(calls.length >= 1, '先证它真问了一路，否则下面那句"只问了它"是空断言');
    assert.deepEqual([...new Set(calls.map((c) => c.split('.')[0]))], ['ui'],
      `只该问 ui（另一路零调用）：${JSON.stringify(calls)}`);
  });

  test(`world: "mobile" 时**只问设备**，另一路一次都不调（${name}）`, async () => {
    const { adapters, calls } = spyWorlds({ ui: true, device: true });
    const { w } = await oneWait({ ...cond, world: 'mobile' }, adapters);
    assert.equal(w.status, 'pass', `这一步该跑通：${(w.assertionSummary ?? '').slice(0, 120)}`);
    assert.ok(calls.length >= 1, '先证它真问了一路');
    assert.deepEqual([...new Set(calls.map((c) => c.split('.')[0]))], ['device'],
      `只该问 device（另一路零调用）：${JSON.stringify(calls)}`);
  });
}

test('template 不再"优先设备"：三处选择器现在同一个判据（本轮那个方向不一致的正面证据）', async () => {
  /*
   * 这一条是**本轮那次方向变更**自己的落点，也是 `lang.test.ts` 里那个
   * `['device','ui']` 数组改向的另一半。原注释写的是"模板匹配优先在设备端做"，
   * 而那个意图**从来没有实现**：两个槽位都在场时它确实优先设备，
   * 但那不是"在设备端做模板匹配"，那是"顺带用设备端的**界面树**做模板匹配" ——
   * `template` 走的是 `resolve()`，不是某个像素专用口，所以那一档优先
   * 换来的是**问错世界**，不是"在设备上跑"。
   *
   * 三条并排断言才是这条的意思：**同一份装配下三个条件落在同一世界上**。
   * 分开写三条各自单测的话，"两个一致、第三个反着"这种坏法要有人**同时**看三条才看得出。
   */
  const { adapters, calls } = spyWorlds({ ui: true, device: true });
  const r = await run(scen([
    waitStep({ ...UI_PRED(), world: 'web' }),
    { ...b('w2'), kind: 'wait', condition: { ...TEMPLATE(), world: 'web' }, timeoutMs: 2_000, pollMs: 100 },
    { ...b('w3'), kind: 'wait', condition: { ...UI_IDLE(), world: 'web' }, timeoutMs: 2_000, pollMs: 100 },
  ] as StepDraft[]), { adapters });
  assert.equal(res(r, 'w').status, 'pass');
  assert.equal(res(r, 'w2').status, 'pass');
  assert.equal(res(r, 'w3').status, 'pass');
  const roots = [...new Set(calls.map((c) => c.split('.')[0]))];
  assert.deepEqual(roots, ['ui'], `三个条件都声明 web，就该只问 ui：${JSON.stringify(calls)}`);
});

test('world 写了而那一档没接：**说"另一档顶不上"，不说"一个都没有"**', async () => {
  /*
   * 报错的**事实内容**是这一条的全部。`NoConditionAdapter` 那句「而本场景一个都没有」
   * 对所有现存调用点是真话，而这里它**假**：ui 在场。复用它的症状不是崩溃，
   * 是一句会让人白跑的报错 —— 排查人去配浏览器，而浏览器早配好了，
   * 真相是那条 IR 写了 `world: "mobile"`。
   * 所以断言的两面：说了"顶不上"，**并且**不许说"一个都没有"。
   */
  const { adapters, calls } = spyWorlds({ ui: true });
  const { w } = await oneWait({ ...UI_PRED(), world: 'mobile' }, adapters);
  assert.equal(w.status, 'error');
  assert.equal(w.cause, 'env-unavailable', '这一步确实是接线问题（该接 device 那一路）');
  assert.deepEqual(calls, [], '另一路不许顶包');
  const sum = w.assertionSummary ?? '';
  assert.match(sum, /顶不上/, `要说清"另一个在场而它不行"：${sum}`);
  assert.ok(!/一个都没有/.test(sum), `ui 明明在场，不许说"一个都没有"：${sum}`);
  assert.match(sum, /mobile/, '要点名作者声明的是哪一世界');
  // 结构化那一份：看板要能按"缺哪一世界"分组，而不是混在"缺槽位"里查不出原因
  assert.deepEqual(w.keyContext?.missingAdapters, ['device']);
  assert.equal(w.keyContext?.waitWorld, 'mobile');
});

test('只有一路在场时**不必写 world**（向后兼容的全部含义）', async () => {
  /*
   * 纯 Web 场景与纯设备场景今天都不写这个字段，改动前后必须**逐字相同**。
   * 这一条挡住两种"修好一半"的坏法：
   *  - 把 world 改成必填 ⇒ 所有现存用例全红（那是迁移不是修复）；
   *  - 只在 ambiguous 分支里判 ⇒ 单路场景也可能被莫名要求写 world。
   */
  for (const [which, expected] of [['ui', 'ui'], ['device', 'device']] as Array<[string, string]>) {
    const { adapters, calls } = spyWorlds({ ui: which === 'ui', device: which === 'device' });
    for (const cond of [UI_PRED(), TEMPLATE(), UI_IDLE()]) {
      const { w } = await oneWait(cond, adapters);
      assert.equal(w.status, 'pass', `${which} 单路 + ${cond.type}：${(w.assertionSummary ?? '').slice(0, 100)}`);
      assert.deepEqual([...new Set(calls.map((c) => c.split('.')[0]))], [expected],
        `${which} 单路时 ${cond.type} 该落到 ${expected}：${JSON.stringify(calls)}`);
      calls.length = 0;
    }
  }
});

test('两路都不在时仍是 NoConditionAdapter 那句「一个都没有」（这句**在这条下**是真话）', async () => {
  const { w } = await oneWait(UI_PRED(), {});
  assert.equal(w.status, 'error');
  assert.equal(w.cause, 'env-unavailable');
  assert.match(w.assertionSummary ?? '', /一个都没有/);
  assert.deepEqual(w.keyContext?.missingAdapters, ['ui', 'device']);
  assert.equal(w.keyContext?.waitCondition, 'uiPredicate');
});

test('摘要里要带"问的是哪一世界"，pass 与超时**两条路都带**', async () => {
  /*
   * 载体是 `describe`（这一步唯一两条路都会带上的那句话，见 wait.ts 那段理由）。
   * 一个事实有字段、有判据、而**没有面向人的载体** = docs/08 §3 那一格，
   * 所以这里断的是**摘要文本**（这一处文本就是产品，不是判据的替代品）。
   *
   * 两条路都要：超时那一支才是**查错方向最贵**的地方 —— 拿到
   * 「等待超时：界面元素可见（web）」人会去查页面，「（mobile）」会去查设备，
   * 而没有那个词时**两条都像是真的**。
   */
  const ok = spyWorlds({ ui: true, device: true });
  const a = await oneWait({ ...UI_PRED(), world: 'web' }, ok.adapters);
  assert.match(a.w.assertionSummary ?? '', /问的是 web/, `pass 摘要要带世界：${a.w.assertionSummary}`);

  /*
   * 超时那一支要造出来：探针**在场但定不到**（resolve 返回没有 handle 的结果），
   * 于是 `uiPredicate` 恒不满足、等满超时。
   * 不用"不配 adapter"造超时 —— 那走的是 NoConditionAdapter 那一支，
   * 一次都没问，压根没有"问过哪个世界"可说（那是上面那条的内容）。
   */
  const miss = {
    async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 0, nonReplayable: true, handle: undefined }; },
    async snapshot() { return { kind: 'aria', data: '', sha: 'x' }; },
    async perform() {},
    async assertUi() { return { passed: false, actual: '', expected: '' }; },
  };
  const { w } = await oneWait({ ...UI_PRED(), world: 'mobile' }, { device: miss as never }, { onTimeout: 'fail' });
  assert.equal(w.status, 'fail', `该是等满超时的 fail：${w.status} / ${w.assertionSummary}`);
  assert.match(w.assertionSummary ?? '', /等待超时/, '这条走的就是超时那一支');
  assert.match(w.assertionSummary ?? '', /问的是 mobile/, `超时摘要也要带世界：${w.assertionSummary}`);
});

test('没问过任何界面时，摘要**逐字不变**（这条不许给所有等待加噪音）', async () => {
  /*
   * 纯 `expr` / `response` / `dbRow` 那些等待不该多出"（问的是 …）"这一截。
   * 少了这条，"无条件在摘要尾巴上挂一个词"也能过上面那组测试 ——
   * 而那会把所有等待的摘要弄长，并把"这一条其实没问界面"这件事抹平。
   */
  const { adapters } = spyWorlds({ ui: true });
  const { w } = await oneWait({ type: 'expr', expr: '1 == 1' }, adapters);
  // 断言的 message 位不许直接放一个 optional 字段（`string | undefined` 过不了重载，
  // 而 npm test 不做类型检查、只有 typecheck:test 看得见）。
  assert.equal(w.status, 'pass', `纯表达式等待要能过：${w.assertionSummary}`);
  assert.ok(!/问的是/.test(w.assertionSummary ?? ''),
    `没问界面时不该出现那句话：${w.assertionSummary}`);
});

test('一棵 allOf 里两个世界各自声明 ⇒ 两个世界**都问、都列出来**', async () => {
  /*
   * 混合场景的合法写法（IR 那一侧也有对应一条），也是"记成一个值"的坏法的落点：
   * 收成 `let world` 会让第二个覆盖第一个，摘要说"问的是 mobile"而它两个都问过。
   * 那是本仓最贵的那一族：**报告说的比发生过的少**。
   */
  const { adapters, calls } = spyWorlds({ ui: true, device: true });
  const { w } = await oneWait({ allOf: [{ ...UI_PRED(), world: 'web' }, { ...UI_IDLE(), world: 'mobile' }] }, adapters);
  assert.equal(w.status, 'pass', `两个世界各自声明时这一件要能过：${w.assertionSummary}`);
  assert.ok(calls.some((c) => c.startsWith('ui.')), 'web 那一支要问到');
  assert.ok(calls.some((c) => c.startsWith('device.')), 'mobile 那一支要问到');
  assert.match(w.assertionSummary ?? '', /web \+ mobile/, `两个世界都要列出来：${w.assertionSummary}`);
});

test('一棵树里**有一件**说不清就整件说不清（不许只回答其余那些）', async () => {
  /*
   * `allOf` 短路 + 逐条件选择器，这里有一种坏法："第一件问到了 web，
   * 第二件说不清就跳过它" —— 那时摘要说"问的是 web"、这一步还可能 pass，
   * 而有一件条件**从没被问过**。那是"少一件东西看起来像什么都没少"的又一格。
   */
  const { adapters, calls } = spyWorlds({ ui: true, device: true });
  const { w } = await oneWait({ allOf: [{ ...UI_PRED(), world: 'web' }, UI_IDLE()] }, adapters);
  assert.equal(w.cause, 'case-stale');
  assert.ok(!calls.some((c) => c.startsWith('device.')), '说不清那一件不许被随机落到 device');
  assert.match(w.assertionSummary ?? '', /uiIdle/, '要点名是**哪一件**说不清');
});

/* ---------------------------------------------------------------------------
 * ## 后半族：选中的世界要**跟着 ctx 一起交给 adapter**
 *
 * `ExecContext.target` 由解释器按 `targetOf(step)` 算，而 `STEP_TARGET.wait` 是
 * `'any'` —— 所以光把探针选对是不够的：条件里明明写着 `world: "web"`，
 * adapter 收到的 ctx 仍然报 `'any'`（纯 Web）或**租约上那个平台**（混合场景里
 * 一句"问浏览器"的探针，转述出去却是 `'ios'`）。
 * 那是本轮修完"选错探针"之后的**下一格**：IR 有这个事实、探针也用对了，
 * 而面向 adapter 的那个载体没跟上 —— 与已修掉的 assertPage P3（docs/15 §3.4）同形。
 *
 * 判据一律是**adapter 亲眼收到的那个字符串**，不是引擎内部的变量：
 * 这一族要防的正是"内部对了、转述出去错了"，读内部变量恰好看不见它。
 * ------------------------------------------------------------------------- */

/** 探针记录自己**收到的 ctx.target**（不是被调了几次 —— 上面那些已经管那个了） */
/**
 * 探针记录自己**收到的 ctx**（不是被调了几次 —— 上面那些已经管那个了）。
 *
 * 按 `ctx.stepId` 分桶而不是记一个平铺数组：等待那一步的 target 正是被测对象，
 * 而夹具里前面那个 `device` 步也会打到同一个探针。平铺数组要么把两步混在一起，
 * 要么逼夹具自检去断"我看到过 ios"—— 而修复生效后 ios **本来就该消失**，
 * 那种自检会把好实现判成失败（我这第一版就是这么红的）。
 * `ctx.stepId` 是引擎自己填的（`execCtx(target, s.id)`），不是测试编的坐标。
 */
function spyTargets() {
  const seen = new Map<string, string[]>();
  const hit = { resolvedBy: 'testid' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' };
  const note = (ctx: { target: string; stepId?: string }) => {
    const k = ctx.stepId ?? '(无步骤坐标)';
    seen.set(k, [...(seen.get(k) ?? []), ctx.target]);
  };
  const mk = () => ({
    async perform() {},
    async resolve(_l: unknown, ctx: { target: string; stepId?: string }) { note(ctx); return hit; },
    async snapshot(ctx: { target: string; stepId?: string }) { note(ctx); return { kind: 'aria', data: '', sha: 'same' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  });
  let leased = 0;
  const device = {
    ...mk(),
    async lease() { leased++; return { id: 'L1', deviceRef: 'dev-1', expiresAt: 0 }; },
    async release() {},
  };
  /** 等待那一步（id `w`）收到的端。取不到就直接失败 —— "探针没被调"不能算通过 */
  const atWait = (m: Map<string, string[]>): string[] => {
    const got = m.get('w');
    assert.ok(got && got.length >= 1, '等待那一步一次都没打到探针，那"它收到哪个端"是空测试');
    return got;
  };
  return {
    seen,
    atWait: () => atWait(seen),
    // 租约真拿到了没有。**没拿到时 ctx.target 是 'any'，混合那条就静默退化成
    // 纯 Web 那条的副本** —— 看着是两条覆盖，实际是一条。所以这是个夹具自检。
    leased: () => leased,
    ui: mk() as never,
    device: device as never,
  };
}

const devStep = (target: 'ios' | 'android'): StepDraft =>
  ({ ...b('d'), kind: 'device', target, require: { requires: [] } }) as StepDraft;

test('world: "web" 时 adapter 收到的 ctx.target 是 web，不是 any（纯 Web 场景）', async () => {
  /*
   * 改前实测的形状：`platformOf` 只看租约，等待步骤没有租约 ⇒ `'any'`，
   * 而**这一步的 IR 明明写着 `world: "web"`**。写 `any` 不是"保守"，
   * 是把手里确定的事实说成不确定 —— docs/09 §1.1 那条"能力探测决定路由"落地那天，
   * 第一个读 ctx.target 的代码就从这里拿到一个假的不确定。
   */
  const t = spyTargets();
  const adapters: AdapterRegistry = { ui: t.ui, device: t.device };
  await oneWait({ ...UI_PRED(), world: 'web' }, adapters);
  assert.deepEqual([...new Set(t.atWait())], ['web'], `adapter 该收到 web：${JSON.stringify(t.atWait())}`);
});

test('混合场景里 world: "web" 的探针不许收到租约那个平台（ios）', async () => {
  /*
   * 这一条是上面那条的**要害**：纯 Web 场景里 ctx.target 是 `'any'`，
   * 说错的方向是"少说"；而混合场景里它是**一个真实的另一端**（`'ios'`）。
   * 那句"ios"会一路走进能力探测、走进 adapter 的分支选择，
   * 而作者问的是浏览器 —— **两个方向的错，只有这一个形状能暴露**。
   *
   * 夹具必须真拿到租约（`device` 步在前），否则 ctx.target 是 `'any'`，
   * 这条就退化成上面那条的副本而看起来像两条覆盖。
   */
  const t = spyTargets();
  const adapters: AdapterRegistry = { ui: t.ui, device: t.device };
  const r = await run(scen([devStep('ios'), waitStep({ ...UI_PRED(), world: 'web' })]), { adapters });
  assert.equal(res(r, 'd').status, 'pass', '租约这一步要真跑通，否则下面断的是另一个问题');
  assert.ok(t.leased() >= 1, '夹具自检：租约没拿到的话 ctx.target 是 any，这条会退化成上一条的副本');
  assert.deepEqual([...new Set(t.atWait())], ['web'],
    `拿到 ios 租约之后，问浏览器那一支仍该收到 web：${JSON.stringify(t.atWait())}`);
});

test('world: "mobile" 时 ctx 原样透传租约平台（ios），这里**不许**由引擎编一个', async () => {
  /*
   * `web` 那一档改写 ctx 是因为 `ExecTarget` 里就有 `'web'` 这个确定值；
   * `mobile` 对应 android/ios/harmony 三个真实端，**只有租约知道是哪个**，
   * 从 `world` 这一侧填任何一个都是编。所以这条断的是"没动"，
   * 而它必须跑在有租约的场景里 —— 没租约时它是 `'any'`，那是诚实的算不出。
   */
  const t = spyTargets();
  const adapters: AdapterRegistry = { ui: t.ui, device: t.device };
  await run(scen([devStep('ios'), waitStep({ ...UI_PRED(), world: 'mobile' })]), { adapters });
  assert.ok(t.leased() >= 1, '夹具自检：没有租约就没有真实端可透传，这条要测的东西不存在');
  assert.deepEqual([...new Set(t.atWait())], ['ios'], `该原样透传租约那个端：${JSON.stringify(t.atWait())}`);
});

test('没写 world 而只有浏览器在场时，ctx 也跟着判成 web（推出来的也要转述）', async () => {
  /*
   * 第三条判据（只有一档在场就用它）推出来的世界**同样是个事实**：
   * 探针是浏览器那一路，那 adapter 就该知道自己在被当浏览器问。
   * 只给"作者写了 world"那条路补 ctx，等于把同一个事实按来源分成两等待遇，
   * 而 adapter 分不清这两者。
   */
  const t = spyTargets();
  await oneWait(UI_PRED(), { ui: t.ui } as AdapterRegistry);
  assert.deepEqual([...new Set(t.atWait())], ['web'], `推断出的世界也要交给 adapter：${JSON.stringify(t.atWait())}`);
});

test('uiIdle 的两次快照都带同一个 ctx（不许第一次带 web、第二次带 any）', async () => {
  /*
   * 这一支是**两次** snapshot 调用，所以多一种坏法：只给第一次换 ctx。
   * 两次 sha 比较这件事看不出区别（结果照样 pass），只有 adapter 侧看得见。
   */
  const t = spyTargets();
  await oneWait({ ...UI_IDLE(), world: 'web' }, { ui: t.ui, device: t.device } as AdapterRegistry);
  const got = t.atWait();
  assert.equal(got.length, 2, `uiIdle 该问两次快照，实际 ${got.length} 次`);
  assert.deepEqual([...new Set(got)], ['web'], `两次都该带 web：${JSON.stringify(got)}`);
});
