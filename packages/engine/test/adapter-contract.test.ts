/**
 * ExecContext 的**契约**测试：adapter 拿到的上下文里，那些它必须回传给引擎的字段
 * （现在是 stepId），值必须由引擎在调用那一刻填对。
 *
 * 为什么单独立一个文件而不是塞进 control.test.ts：这条不属于"某个步骤的语义"，
 * 属于**引擎与 adapter 之间那份接口的形状**。它的缺陷类是
 * 「接口有字段、执行侧没人填」—— 与 IR 字段没人读同族，只是这次漏在 adapter 端口上。
 *
 * 判据一律用**假 adapter 记账**（把收到的 ctx 存下来再断言），不去读引擎内部变量：
 * 内部变量改名测试就跟着改，那测的是实现不是契约。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run, scen, b, loc, type StepDraft } from './helpers.js';
import type { ExecContext } from '../src/adapters.js';

/** 记下每次引擎调 UiExec 时的 (方法, ctx.stepId) */
function spyUi() {
  const calls: Array<{ m: string; stepId?: string }> = [];
  const ui = {
    async perform(_o: unknown, _t: unknown, ctx: ExecContext) { calls.push({ m: 'perform', stepId: ctx.stepId }); },
    async snapshot(ctx: ExecContext) { calls.push({ m: 'snapshot', stepId: ctx.stepId }); return { kind: 'aria', data: '', sha: 'x' }; },
    async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h1' }; },
    async assertUi(_p: unknown, ctx: ExecContext) { calls.push({ m: 'assertUi', stepId: ctx.stepId }); return { passed: true, actual: '', expected: '' }; },
  };
  return { ui, calls };
}

test('navigate/act 步骤里 adapter 拿到的 ctx.stepId 是各自那一步的 id', async () => {
  const { ui, calls } = spyUi();
  await run(scen([
    { ...b('nav1'), kind: 'navigate', url: 'http://x/' } as StepDraft,
    { ...b('act1'), kind: 'act', action: 'click', locator: loc() } as StepDraft,
  ] as StepDraft[]), { adapters: { ui } });
  /*
   * **两条都记成 perform，不是 navigate + perform。** 我第一版是照着接口声明写的
   * "第一条该调 navigate"，它红了 —— 红的是我的假设，不是代码：解释器把 navigate
   * 也走 `perform({op:'navigate'})`（interpreter.ts 的 opOf），而接口上那个
   * `UiExec.navigate()` **零调用方**。按 docs/14 §4.7 那种东西要删，
   * 所以本轮把它从 UiExec 上删掉了（没有任何实现存在，删是安全的）。
   * 这条测试保留下来当**看门人**：将来若真要把 navigate 拆成独立方法，
   * 它会红，逼来人连同这里的期望序列一起改，而不是留下两套派发方式。
   *
   * stepId 要**各自等于自己那一步**：只断"非空"不够 —— 两条都填 'nav1' 也能过，
   * 而那时证据会全记到第一步名下（evidence.ts 那个按 stepId 反查的缺陷的另一半）。
   */
  assert.deepEqual(calls, [
    { m: 'perform', stepId: 'nav1' },
    { m: 'perform', stepId: 'act1' },
  ], `ctx.stepId 不对或调用序列变了：${JSON.stringify(calls)}`);
});

test('capture 步骤的 adapter 也拿得到 stepId（它自己产证据，没这个只能编）', async () => {
  const { ui, calls } = spyUi();
  const r = await run(scen([{ ...b('cap1'), kind: 'capture', mode: 'screenshot', on: 'always' } as StepDraft]),
    { adapters: { ui } });
  assert.deepEqual(calls, [{ m: 'perform', stepId: 'cap1' }]);
  assert.equal(r.results.find((x) => x.stepId === 'cap1')?.status, 'pass');
});

test('assertPage（Web 侧的界面断言）的 ctx.stepId 也是所在步骤', async () => {
  const { ui, calls } = spyUi();
  await run(scen([
    { ...b('p1'), kind: 'assertPage', assertKind: 'url', expected: 'x' } as StepDraft,
  ] as StepDraft[]), { adapters: { ui } });
  assert.deepEqual(calls.filter((c) => c.m === 'assertUi'), [{ m: 'assertUi', stepId: 'p1' }],
    `assertPage 的 ctx.stepId 应为所在步骤：${JSON.stringify(calls)}`);
});

test('assertUi 是**移动端**那一档，无租约时被拦（这条记的是名字与归属相反这件事）', async () => {
  /*
   * 我原先把这条写成"assertUi 该带 stepId"，结果它压根不调 adapter ——
   * 查出来是**我用错了 kind**，不是引擎错了：STEP_TARGET 里
   * `assertPage: 'web'`、`assertUi: 'mobile'`，而 assertUi 在 LEASE_REQUIRED 里。
   * 也就是说 Web 端的界面断言叫 assertPage；名字更"通用"的那个反而是移动端的。
   * 这个命名是个陷阱（我踩了，而下一个人踩之前会先写一条像上面那样的测试），
   * 所以这里把行为钉住而不是改掉 kind：无租约 => error，且**说的是缺 device adapter**，
   * 不是含糊的"断言失败"。
   */
  const { ui, calls } = spyUi();
  const r = await run(scen([{ ...b('a1'), kind: 'assertUi', assertKind: 'url', expected: 'x' } as StepDraft]),
    { adapters: { ui } });
  const x = r.results.find((y) => y.stepId === 'a1');
  assert.equal(x?.status, 'error', 'assertUi 没有设备租约就该 error');
  assert.match(x!.assertionSummary ?? '', /device/, `报错要点名缺的是 device adapter：${x!.assertionSummary}`);
  assert.deepEqual(calls, [], '被租约闸拦下时不该已经调过 adapter');
});

test('步骤之外的事不编 stepId：收尾释放租约时它是 undefined', async () => {
  // **反向**判据。加了 stepId 之后最容易写错的方向不是"漏填"而是"到处都填一个";
  // 步骤外的事（守望规则在步骤之间跑、run 收尾释放租约）真没有步骤坐标，
  // 填个 'lease' 之类的假 id，证据与事件里就会冒出一个并不存在的步骤。
  const seen: Array<string | undefined> = [];
  const device = {
    async lease(_r: unknown, ctx: ExecContext) { seen.push(ctx.stepId); return { id: 'lease-1', deviceRef: 'em-1', expiresAt: 0 }; },
    async renew() { return { expiresAt: 0 }; },
    async release(_a: { id: string }, ctx: ExecContext) { seen.push(ctx.stepId); },
    async snapshot(ctx: ExecContext) { seen.push(ctx.stepId); return { kind: 'hierarchy', data: '', sha: 'x' }; },
    async perform() {},
    async app() { return null; },
    async resolve() { return { resolvedBy: 'id', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  };
  await run(scen([
    { ...b('d1'), kind: 'device', target: 'android' } as StepDraft,
  ] as StepDraft[]), { adapters: { device } });
  assert.equal(seen[0], 'd1', 'lease 是在 d1 这一步里发的，该带上它');
  assert.ok(seen.includes(undefined), 'release 那一刻没有步骤，stepId 必须是 undefined');
  assert.ok(!seen.some((s) => s !== undefined && s !== 'd1'),
    `冒出不在场景里的步骤 id：${JSON.stringify(seen)}`);
});

test('adapter 在动作里产的证据必须进 StepResult.artifactIds（否则归属落到"未归属"）', async () => {
  /*
   * 这条是被**真跑一次 Web capture 步骤**逼出来的：evidence 清单里那个前缀是
   * `stepId: "未归属:shot"`。`未归属` 本来是兜底给"忘了带 id 的 adapter"的标签，
   * 但因为 perform 返回 void、id 没有任何通道回来，它成了**正常路径的唯一标签** ——
   * 每一张 Web 截图都被标成归属不明，而那一步明明知道自己是谁。
   *
   * 判据用假 adapter 记账是**不够**的（它只能证明"我传了什么"），
   * 所以这里断的是**引擎交出去的那份 StepResult**：那才是 evidence.ts 读的东西。
   */
  const ui = {
    async perform(_o: unknown, _t: unknown, ctx: ExecContext) {
      const id = await ctx.saveArtifact('screenshot', 'PNGDATA', ctx.stepId ?? '?');
      return { artifactIds: [id, id] }; // 故意重复：同一次动作产同内容两次
    },
    async snapshot() { return { kind: 'aria', data: '', sha: 'x' }; },
    async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h1' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  };
  // 必须给 artifactStore：ctx.saveArtifact 在没存储时是**故意抛**的
  // （返回假 id 会让证据包看起来完整而实际取不到东西），所以少了它这一步直接 error，
  // 我要断的 artifactIds 压根不会被填 —— 那时测试会以"0 !== 1"失败，
  // 看起来像合并逻辑坏了，实际是夹具缺一个端口。
  const artifactStore = { async save() { return 'a'.repeat(64); }, async load() { return undefined; } };
  const r = await run(scen([{ ...b('cap9'), kind: 'capture', mode: 'screenshot', on: 'always' } as StepDraft]), { adapters: { ui, artifactStore } });
  const x = r.results.find((y) => y.stepId === 'cap9');
  // 先判状态：夹具缺端口时这一步会 error，那时 artifactIds 为空是**另一个原因**，
  // 不加这条的话报错会把人引向"合并逻辑写错了"
  assert.equal(x?.status, 'pass', `步骤本身要成功才有归属可谈：${x?.assertionSummary}`);
  assert.equal(x?.artifactIds.length, 1, `该带回 1 个 id（重复的要并掉）：${JSON.stringify(x?.artifactIds)}`);
  assert.match(String(x?.artifactIds[0] ?? ''), /^[0-9a-f]{64}$/, '必须是存储给的真 id，不是 adapter 编的');
  // **反向**：一条不产证据的动作不该凭空多出 artifactIds
  const quiet = { ...ui, async perform() { return; } };
  const r2 = await run(scen([{ ...b('cap8'), kind: 'capture', mode: 'screenshot', on: 'always' } as StepDraft]), { adapters: { ui: quiet, artifactStore } });
  assert.deepEqual(r2.results.find((y) => y.stepId === 'cap8')?.artifactIds ?? [], [],
    'perform 返回 void 时不该有 artifactIds（那是"没产证据"，与"产了没说"由兜底前缀区分）');
});
