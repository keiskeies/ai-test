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
import type { AdapterRegistry, ExecContext } from '../src/adapters.js';

/**
 * 记下每次引擎调 UiExec 时的 (方法, ctx.stepId, ctx.target)。
 *
 * **target 是本轮加进来的**（docs/15 §3.4 末尾那条待办）。原先这个夹具只记 stepId，
 * 于是下面 `assertPage` 那条测试**没红过**——不是因为值对，是因为压根没断它：
 * 纯 Web 场景里 assertPage 那一步的 `ctx.target` 实测就是 `'android'`（P3）。
 * "字段有人传、没人断"与"字段有人传、没人读"是同一族缺陷的两半，
 * 而夹具不记 = 测试不可能看见，这条教训比那个 bug 本身值钱。
 */
function spyUi() {
  const calls: Array<{ m: string; stepId?: string; target: string }> = [];
  const ui = {
    async perform(_o: unknown, _t: unknown, ctx: ExecContext) { calls.push({ m: 'perform', stepId: ctx.stepId, target: ctx.target }); },
    async snapshot(ctx: ExecContext) { calls.push({ m: 'snapshot', stepId: ctx.stepId, target: ctx.target }); return { kind: 'aria', data: '', sha: 'x' }; },
    async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h1' }; },
    async assertUi(_p: unknown, ctx: ExecContext) { calls.push({ m: 'assertUi', stepId: ctx.stepId, target: ctx.target }); return { passed: true, actual: '', expected: '' }; },
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
    { m: 'perform', stepId: 'nav1', target: 'web' },
    { m: 'perform', stepId: 'act1', target: 'web' },
  ], `ctx.stepId / ctx.target 不对，或调用序列变了：${JSON.stringify(calls)}`);
});

test('capture 步骤的 adapter 也拿得到 stepId（它自己产证据，没这个只能编）', async () => {
  const { ui, calls } = spyUi();
  const r = await run(scen([{ ...b('cap1'), kind: 'capture', mode: 'screenshot', on: 'always' } as StepDraft]),
    { adapters: { ui } });
  assert.deepEqual(calls, [{ m: 'perform', stepId: 'cap1', target: 'web' }]);
  assert.equal(r.results.find((x) => x.stepId === 'cap1')?.status, 'pass');
});

test('算不出端时 ctx.target 是 any，不是编一个 android（这条钉的是"新取值是有决定的"）', async () => {
  /*
   * 形状：纯 Web 场景里一步 `wait{uiPredicate}`。IR 里 `wait: 'any'`
   * —— 等待条件不带世界信息（同一件事在 §3.6 里是"wait.ts 那三处 `??` 刻意没改"
   * 那条待办），所以引擎**确实不知道**这一步属于哪一端。
   *
   * **改前它报 'android'**（`?? 'android'` 兜底），改后报 `'any'`。
   * 这条测试存在的理由不是"any 这个值多对"，而是：**联合里多了一个成员而没有任何
   * 测试产出它，那这个成员就是不可证伪的** —— 下一个人看到 'any' 会分不清
   * 那是"设计如此"还是"某处漏填了"。所以这里把它钉成决定，并且把另一条路写明白：
   * **如果哪天决定给等待条件补上世界字段**（schema 层的事，§3.6 记着"未决"），
   * 这条测试会红，那时该改的是这里 —— 而不是让 'any' 悄悄变成一个没人认领的值。
   */
  const seen: string[] = [];
  const ui = {
    // perform 在这个端口上是 `void | PerformResult`（动作不回报定位结果），
    // 这里不返回任何东西 —— 这条测试要看的是 resolve 收到哪个端。
    async perform() {},
    async resolve(_l: unknown, ctx: ExecContext) { seen.push(ctx.target); return { resolvedBy: 'css' as const, rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async snapshot() { return { kind: 'aria', data: '', sha: 'x' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  };
  const r = await run(scen([
    { ...b('nav1'), kind: 'navigate', url: 'http://x/' } as StepDraft,
    {
      ...b('w1'), kind: 'wait', timeoutMs: 1_000, pollMs: 50,
      condition: { type: 'uiPredicate', state: 'visible', target: { intent: '在', primary: { by: 'css', value: '#a' }, fallbacks: [], confidenceGate: 0.5, replayable: true } },
    } as StepDraft,
  ] as StepDraft[]), { adapters: { ui } });
  assert.equal(r.results.find((x) => x.stepId === 'w1')?.status, 'pass', '这一步本身要跑通，否则"传了什么端"是另一个问题');
  assert.ok(seen.length >= 1, '等待条件必须真调到 resolve，否则这条又是空测试');
  assert.deepEqual([...new Set(seen)], ['any'],
    `没有租约、IR 又说这一步不属于任何端时，该报 any 而不是编一个真实端：${JSON.stringify(seen)}`);
});

test('assertLlm 送给模型的 ctx 同样是 any（第二种形状，单独一条以便各自归因）', async () => {
  /*
   * `evalLlmAssert` 是把 `deps.ctx` **原样递给 llm adapter** 的，所以这一步的端
   * 会跟着 prompt 一起出去。探针扫过 IR 里所有 `STEP_TARGET === 'any'` 且会碰
   * adapter 的 kind，产出 any 的就是这两支（wait 与 assertLlm）；
   * `assert` / `assertPerf` 两个分支只读变量、压根不碰 deps.ctx。
   *
   * **为什么不并进上面那条**：上面那条守的是"哪天给等待条件补上世界字段"这个
   * 可能的 schema 改动，而那条改动**不该连带弄红 assertLlm 这一半** ——
   * 两条测试共享一句断言时，一半变红会掩盖另一半仍然成立（与 wiring-web.test.ts
   * 里 setup/teardown 分两句同一条理由）。
   *
   * `evidenceFrom` 必须指向**真跑过的步骤**：指 `$.step.不存在` 时这一步会在
   * 变量解析处就 error，judge 一次都不被调用 —— 那又是一条空测试的形状。
   */
  const seen: string[] = [];
  const llm = {
    async judge(_r: unknown, ctx: ExecContext) { seen.push(ctx.target); return { passed: true, evidence: 'x', costUsd: 0 }; },
  };
  const r = await run(scen([
    { ...b('st1'), kind: 'set', assign: { note: { type: 'literal', value: 'hello' } } } as StepDraft,
    { ...b('al1'), kind: 'assertLlm', question: '这段证据支持结论吗', evidenceFrom: '$.step.st1' } as StepDraft,
  ] as StepDraft[]), { adapters: { llm } });
  assert.equal(r.results.find((x) => x.stepId === 'al1')?.status, 'pass',
    `judge 必须真被调到：${JSON.stringify(r.results.map((x) => [x.stepId, x.status, x.assertionSummary]))}`);
  assert.deepEqual(seen, ['any'], `assertLlm 送出去的端：${JSON.stringify(seen)}`);
});

test('assertPage（Web 侧的界面断言）的 ctx.stepId 是所在步骤、ctx.target 是 web', async () => {
  const { ui, calls } = spyUi();
  await run(scen([
    { ...b('p1'), kind: 'assertPage', assertKind: 'url', expected: 'x' } as StepDraft,
  ] as StepDraft[]), { adapters: { ui } });
  /*
   * **target 这一半是 docs/15 §3.4 的 P3，本轮之前它一直是 'android'。**
   * 形状很朴素：一个再普通不过的纯 Web 场景，只有 ui adapter，没有跨端、
   * 没有配置问题 —— 而 `ExecContext.target` 写着 `'android'`。
   * 原因是 `targetOf` 重抄了一份 web 清单（`['navigate','act','capture']`）漏了
   * assertPage，于是它落到"其余"那一支，没有租约 ⇒ `?? 'android'`。
   *
   * **为什么这条要在已有的 stepId 断言上加，而不是新写一条**（§3.4 原话）：
   * 新写一条的话，"漏 target"仍然躲在一条没人会特意去跑的测试里 ——
   * 上面那条 stepId 测试每天在跑、一直绿，而它旁边就是这个 bug。
   */
  assert.deepEqual(calls.filter((c) => c.m === 'assertUi'), [{ m: 'assertUi', stepId: 'p1', target: 'web' }],
    `assertPage 的 ctx 应为所在步骤且属于 web 端：${JSON.stringify(calls)}`);
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

test('守望（watcher）按**这一层租约的端**点屏幕，不写死 android', async () => {
  /*
   * 这是 §3.4 那个根（"运行时的端从步骤种类现推、或干脆写死"）的**第二处**，
   * 而且比 release 那处更常触发：守望在**每一步之后**都跑。
   * 改前实测（`.scratch/probe-watcher.mts`，ios 场景 + 一条会命中的规则）：
   *   snapshot@android、perform@android —— 而紧挨着的那一步 tap 是 perform@ios。
   * **同一次 run、同一台真机，报告里出现两个端。**
   *
   * 判据用 ios 而不是 android 是**必须**的：这条测试要防的就是"写死 android"，
   * 而 android 场景里写死与读租约**同解** —— 用 android 写的话这条是空测试
   * （同一族教训见 ui-assert-world.test.ts 里那条被判空的反例镜像）。
   *
   * 两条断言分开：snapshot 与 perform 是两个**独立调用点**（守望里那两行
   * `execCtx(target, 'watcher')`），合成一句 `every(...)` 的话，只修其中一个也能过。
   */
  const seen: string[] = [];
  const lease = { id: 'L1', deviceRef: 'ios-1', expiresAt: new Date(Date.now() + 600_000).toISOString() };
  const device = {
    async lease() { return lease; },
    async renew() { return { expiresAt: lease.expiresAt }; },
    async release() {},
    async snapshot(ctx: ExecContext) { seen.push(`snapshot@${ctx.target}`); return { kind: 'hierarchy', data: '<node text="允许" resource-id="ok"/>', sha: 'x' }; },
    async perform(_o: unknown, _t: unknown, ctx: ExecContext) { seen.push(`perform@${ctx.target}`); },
    async app() { return null; },
    async resolve() { return { resolvedBy: 'id', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  };
  const r = await run(scen([
    { ...b('d1'), kind: 'device', target: 'ios' } as StepDraft,
    // 规则要**真命中** snapshot 返回的 hierarchy，否则 perform 那一处压根不会被调到，
    // 于是"只修 snapshot 不修 perform"这种半吊子改法能混过去
    { ...b('w1'), kind: 'watcher', rules: [{ match: { textContains: '允许' }, action: 'click', maxTimes: 1 }] } as StepDraft,
    { ...b('t1'), kind: 'tap', target: { intent: '点', primary: { by: 'id', value: 'x' } } } as StepDraft,
  ] as StepDraft[]), { adapters: { device } as unknown as AdapterRegistry });
  assert.equal(r.status, 'pass', `场景本身要跑通：${JSON.stringify(r.results.map((x) => [x.stepId, x.status, x.assertionSummary]))}`);
  /*
   * 次数不是一眼能看出来的，所以记下来：d1 之后那次守望**直接 return**
   * （watcher 还没注册），w1 之后那次才是唯一真正跑了一轮守望的地方 ——
   * 于是这个场景里 snapshot 恰好 1 次、守望的 perform 恰好 1 次
   * （t1 那一步自己也会 perform，所以下面用前缀过滤，别拿 seen.length 当次数）。
   * 这里断"出现过的每一次都是 ios"而不是断次数：次数是另一件事（§3.4 管不着）。
   */
  /*
   * **两个调用点分开断，而且先各断"出现过"** —— 这条测试第一版是空的，形状值得记：
   * 我把 hierarchy 数据写成 `<node textContains="允许"/>`，而 matchesHierarchy 匹配的是
   * 字面量 `text="…"`（它拿 match 的键当语义、不当属性名），规则**压根没命中**，
   * 于是 perform 一次都没被调用；而当时那句 `watcherCalls.length >= 2`
   * 被两次 snapshot 就凑满了 —— 断言全绿，而我要守的那个 perform 调用点没被碰过。
   * 这正是 ui-assert-world.test.ts 里那条被判空的反例镜像的同一个形状：
   * **一条断言可以因为完全无关的原因成立**。那边是"run 压根走不到 adapter 选择器"，
   * 这边是"规则压根没命中，perform 没被调用，于是断它的端等于断空气"。
   * 共同的解法是**先证"它跑了"，再证"它跑对了"** —— 顺序反了就是空测试。
   */
  const snaps = seen.filter((s) => s.startsWith('snapshot@'));
  const performs = seen.filter((s) => s.startsWith('perform@'));
  assert.ok(snaps.length >= 1, `守望至少要 snapshot 一次，否则这条测试什么都没跑：${JSON.stringify(seen)}`);
  assert.ok(performs.length >= 1, `规则必须真命中 hierarchy，否则 perform 那个调用点没被守到：${JSON.stringify(seen)}`);
  assert.deepEqual([...new Set(snaps.map((s) => s.split('@')[1]))], ['ios'],
    `ios 场景里守望的 snapshot 每次都该是 ios：${JSON.stringify(snaps)}`);
  assert.deepEqual([...new Set(performs.map((s) => s.split('@')[1]))], ['ios'],
    `ios 场景里守望的 perform 每次都该是 ios（这处改前写死 android）：${JSON.stringify(performs)}`);
});

test('混合场景里 web 步仍报 web，**不被在场那台设备的租约覆盖**', async () => {
  /*
   * M3 守的是**优先级**：表与租约谁说了算。
   * 形状很自然 —— 一台安卓 + 一个浏览器（App 内 H5 那类用例的最小形状），
   * 然后断一句页面。这一步的端是**页面**，与手上有没有手机无关。
   *
   * 为什么单独立一条而不是在 assertPage 那条上加个租约：上面那条是**纯 Web** 场景，
   * 压根没有租约，所以它只守得住"没租约时报 web"；而"有租约时**也**报 web"
   * 是另一个方向（`world === 'web' && !ctx.lease` 这种写法前一半全绿、后一半全错）。
   * 两个方向各一条 —— 与 ui-assert-world.json 里 W1/W2 同一条理由。
   */
  const { ui, calls } = spyUi();
  const lease = { id: 'L1', deviceRef: 'em-1', expiresAt: new Date(Date.now() + 600_000).toISOString() };
  const device = {
    async lease() { return lease; },
    async renew() { return { expiresAt: lease.expiresAt }; },
    async release() {},
    async snapshot() { return { kind: 'hierarchy', data: '<h/>', sha: 'x' }; },
    async perform() { return { resolvedBy: 'id', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async app() { return null; },
    async resolve() { return { resolvedBy: 'id', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  };
  const r = await run(scen([
    { ...b('d1'), kind: 'device', target: 'android' } as StepDraft,
    { ...b('p1'), kind: 'assertPage', assertKind: 'text', contains: 'x' } as StepDraft,
  ] as StepDraft[]), { adapters: { ui, device: device as unknown as AdapterRegistry['device'] } });
  assert.equal(r.results.find((x) => x.stepId === 'p1')?.status, 'pass',
    `这一步要真跑到 adapter：${JSON.stringify(r.results.map((x) => [x.stepId, x.status, x.assertionSummary]))}`);
  const ap = calls.filter((c) => c.m === 'assertUi');
  assert.equal(ap.length, 1, `assertPage 该恰好调一次 ui：${JSON.stringify(calls)}`);
  assert.equal(ap[0]!.target, 'web',
    '手上有安卓租约不改变"这一步属于页面"（IR 里 assertPage 就是 web 档）');
});

test('守望读**申请那台的那一层**：租约在并行分支里时，整场那一层是空的', async () => {
  /*
   * M4 守的是 §3.3 那一族在**本轮新代码**上的重演：`platformOf(slot)` 写成
   * `platformOf(runSlot)` 会怎样？
   *
   * 形状必须让"这一层"与"整场"**不是同一个槽位**，否则这条又是空测试 ——
   * 上一轮嵌套 parallel 那个缺陷就是这么藏的（`slot` 与 `runSlot` 都是合法的
   * LeaseSlot，编译器分不出）。所以这里把 device 步放进并行分支里：
   * 那台落在**分支槽**上，而 `runSlot` 从头到尾没有租约。
   *   正确：snapshot@ios（分支那一层那台）
   *   M4 ：snapshot@any （整场那层没租约 ⇒ 兜底）
   * 两种都不是 android，所以这条**同时**也是 M5 的第二个形状。
   */
  const seen: string[] = [];
  const lease = { id: 'L1', deviceRef: 'ios-1', expiresAt: new Date(Date.now() + 600_000).toISOString() };
  const device = {
    async lease() { return lease; },
    async renew() { return { expiresAt: lease.expiresAt }; },
    async release() {},
    async snapshot(ctx: ExecContext) { seen.push(`snapshot@${ctx.target}`); return { kind: 'hierarchy', data: '<node text="允许"/>', sha: 'x' }; },
    async perform(_o: unknown, _t: unknown, ctx: ExecContext) { seen.push(`perform@${ctx.target}`); },
    async app() { return null; },
    async resolve() { return { resolvedBy: 'id', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async assertUi() { return { passed: true, actual: '', expected: '' }; },
  };
  const r = await run(scen([
    {
      // 分支要包一层 sequence（与 lease-lifecycle.test.ts 里
      // par('p', [seq('seqA', [...])]) 同一形状）
      ...b('par1'), kind: 'parallel', steps: [
        { ...b('brA'), kind: 'sequence', steps: [
          { ...b('d1'), kind: 'device', target: 'ios' } as StepDraft,
          // 守望**在分支里、拿到租约之后**注册。放在 parallel 之前会多出一次
          // "顶层、还没有任何租约"的守望（那是正确的 any，不是缺陷 ——
          // 第一版就是把那次算进来，于是这条以自己的正确输出而红）。
          // 现在的位置让守望只在分支那两步之后跑，那两次**都必须**是 ios。
          { ...b('w1'), kind: 'watcher', rules: [{ match: { textContains: '允许' }, action: 'click', maxTimes: 4 }] } as StepDraft,
          { ...b('t1'), kind: 'tap', target: { intent: '点', primary: { by: 'id', value: 'x' } } } as StepDraft,
        ] } as StepDraft,
      ],
    } as StepDraft,
  ] as StepDraft[]), { adapters: { device: device as unknown as AdapterRegistry['device'] } });
  const snaps = seen.filter((s) => s.startsWith('snapshot@'));
  assert.equal(r.status, 'pass', `场景要跑通，否则"报哪个端"是另一个问题：${JSON.stringify(r.results.map((x) => [x.stepId, x.status, x.assertionSummary]))}`);
  /*
   * **不能断"每一次都是 ios"**（第一版就是这么写的，于是它以自己的正确输出而红）。
   * 守望在每个步骤之后都跑一次，**包括 parallel 这个容器步自己**：那一轮跑在
   * 顶层槽位上，而分支那台**已经还掉了** —— 于是那是正确的 `'any'`。
   * （顺带可见：容器里注册的守望在分支结束后仍然生效，而它脚下的租约没了。
   *  那是守望的生命周期问题，不归 §3.4 管，这里不动它，只是别再把它当缺陷断掉。）
   *
   * 真正判别 M4/M5 的是这两句：
   *  - **至少有一次是 ios**：M4（读整场那一层）会把它**全部**变成 any，一个 ios 都不剩；
   *  - **任何一次都不是 android**：M5（写死）正是把分支里那几次变成 android。
   */
  assert.ok(snaps.includes('snapshot@ios'),
    `分支里那两步之后的守望必须读到分支那台（M4 会把它们全变成 any）：${JSON.stringify(seen)}`);
  assert.ok(!seen.some((x) => x.endsWith('@android')),
    `守望一次都不该报 android（这处改前正是写死 android）：${JSON.stringify(seen)}`);
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
