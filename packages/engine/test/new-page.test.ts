/**
 * `expectNewPage` / `wait{newPage}`（页面新开标签页/窗口）。
 *
 * ## 这一族要守的东西：一条**实测到的假绿**
 *
 * 改动前 `expectNewPage` 在 IR 里存在、有 `.default(false)`、被 zod 校验，
 * 而**全仓没有任何地方读它**（`grep` 只命中 schema 与豁免表）。实测：
 *
 *   act{action:'click', expectNewPage:true} + 一个什么都没打开的点击
 *     => 步骤结论 pass，cause 无，run 结论 pass，退出码 0
 *
 * 而这条断言存在的价值恰恰是抓"点了导出按钮但弹窗被拦截"。
 * 静默通过不只是"少一个功能"，是**反向保证**：作者以为验了，实际没验。
 * （同一形状的第 N 例，见 docs/14 §4.3。这次连"会报错"都没有 ——
 *  文档原先还写着"没实现的会报错，不会静默降级"，那句是错的。）
 *
 * ## 成对写，且**基线那一条单独立一条**
 *
 * 与 `responses.test.ts` 同一条纪律：「不满足时必须 fail」与「满足时必须 pass」
 * 成对出现，只写一边会被"恒 fail"或"恒 pass"各自骗过。
 * 而**最关键的一条是"窗口在 perform 期间就建好 => 仍算命中"**：
 * 基线取在 perform 之后的话，`window.open()` 这种点击当场建窗的最快情形
 * 会被判成"基线之前就有"，于是等满超时 —— 一条假红，
 * 而人会去查一个其实正常工作的弹窗。那条基线的位置**没有任何类型能表达**，
 * 所以只能靠这条测试钉住。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runScenario, deterministicClock, type AdapterRegistry } from '../src/index.js';
import { defineScenario, IrValidationError, type ScenarioDraft, type StepDraft } from '@atest/ir';

/**
 * 新窗口计数器。两个**都必须能模拟**的形态，各对应一类抓不到的错：
 *
 *  - `openOnPerformTimes`：点击**当场**开窗（真实浏览器里 `window.open()`
 *    就是在点击的同步路径里建好 target 的）。少了这个形态就测不出
 *    "基线取在 perform 之后"那个错（会假红）。
 *    写成**次数**而不是布尔：「第一步开了、第二步没开」是窗口起点那条
 *    假绿测试的唯一写法，布尔的话两步都开，第二条拿到 pass 是**对的**，
 *    测试就白写了（我第一版就是布尔，它当场把这件事暴露出来）。
 *  - `openAfterCalls`：等待期间**异步**落地（弹窗动画/延迟脚本）。
 *    少了这个形态就只能测"等之前已经有"，而那是本条等待判**不命中**的情形。
 */
function fakeWindows(opts: { openOnPerformTimes?: number; openAfterCalls?: number; alreadyOpen?: number } = {}) {
  // alreadyOpen：**取基线之前就存在**的窗口数。它模拟"上一步点完、这一步才开始等"，
  // 是"窗口起点"那条判据唯一能造出的假绿素材 —— 实现若把基线写成 0，
  // 这些旧窗口会被算成本步新开的（pass），而正确答案是超时（fail）。
  let n = opts.alreadyOpen ?? 0;
  let calls = 0;
  let performBudget = opts.openOnPerformTimes ?? 0;
  return {
    observer: {
      count() {
        calls++;
        // 第 N 次取数时才出现：模拟"等待开始之后页面才把窗口开出来"
        if (opts.openAfterCalls === calls) n++;
        return n;
      },
    },
    /** 由 perform 调：点击真的触发了 window.open（受次数预算限制） */
    openOnPerform() { if (performBudget-- > 0) n++; },
    get count() { return n; },
    get calls() { return calls; },
  };
}

/** ui 桩。perform 会按夹具的预算"真的开一个窗口"（模拟点击生效） */
function adaptersWith(windows: ReturnType<typeof fakeWindows> | undefined): AdapterRegistry {
  return {
    ui: {
      async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
      async perform() { windows?.openOnPerform(); },
      async snapshot() { return { kind: 'aria', data: '', sha: 'x' }; },
      async assertUi() { return { passed: true, actual: 1, expected: 1 }; },
    },
    ...(windows ? { newPage: windows.observer } : {}),
  } as unknown as AdapterRegistry;
}

const act = (over: Record<string, unknown> = {}): StepDraft =>
  ({
    id: 'a', kind: 'act',
    locator: { intent: '导出', primary: { by: 'testid', value: 'export' } },
    action: 'click', timeoutMs: 500, ...over,
  } as StepDraft);

const waitNewPage = (over: Record<string, unknown> = {}): StepDraft =>
  ({ id: 'w', kind: 'wait', timeoutMs: 500, pollMs: 50, condition: { type: 'newPage' }, ...over } as StepDraft);

async function run(body: StepDraft[], adapters: AdapterRegistry) {
  const s = defineScenario({
    schemaVersion: '1', id: 'scn.np', name: 'r', tags: [], env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);
  return runScenario({ scenario: s, clock: deterministicClock(3), adapters });
}

describe('expectNewPage：声明了就必须真的开一个窗口（改动前恒 pass）', () => {
  test('什么都没开 => fail + product-bug（改动前：pass，退出码 0）', async () => {
    const w = fakeWindows();
    const r = await run([act({ expectNewPage: true })], adaptersWith(w));
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'fail',
      `这是本轮修的那个假绿本身。实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.equal(x?.cause, 'product-bug',
      '"点了但没弹窗"是被测产品与声明不符。报 env-unavailable 会让人去查接线，'
      + '报 case-stale 会让人删掉一条写对了的断言');
    assert.match(x?.assertionSummary ?? '', /弹窗被拦截|没有新开/, '摘要要给出下一步动作的候选');
  });

  test('点击确实开了窗口 => pass（另一半，防"恒 fail"）', async () => {
    const w = fakeWindows({ openOnPerformTimes: 1 });
    const r = await run([act({ expectNewPage: true })], adaptersWith(w));
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'pass', `点击开了窗口就该过。实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.equal(x?.keyContext?.newPagesOpened, 1, '命中数要进 keyContext（会进 JUnit 与 HTML 报告）');
  });

  /**
   * **基线位置唯一能被观测的地方。**
   *
   * 假窗口的"开"发生在 perform **里面**（真实浏览器就是这样：
   * `window.open()` 在点击的同步路径里建好 target）。
   * 如果实现把基线取在 perform **之后**，那条窗口就成了"基线之前就有"，
   * 于是这一步等满超时判 fail —— **假红**，而人会去查一个正常工作的弹窗。
   * 这个位置错没有任何类型或 lint 能表达（两边都是"取一次 count"），
   * 所以这条测试是它唯一的守门人。
   */
  test('窗口在 perform 期间就建好 => 仍算命中（基线必须取在 perform 之前）', async () => {
    const w = fakeWindows({ openOnPerformTimes: 1 });
    const r = await run([act({ expectNewPage: true, timeoutMs: 200 })], adaptersWith(w));
    const x = r.results.find((y) => y.stepId === 'a');
    // **只有 status 这一条断言是有判别力的**（我一开始还加了一条"durMs < 200"，
    // 随后删掉：那是在断时钟而不是断行为 —— 判据读不到那次开窗的话
    // status 就已经是 fail 了，多一条按时间的断言只会偶发假红）。
    assert.equal(x?.status, 'pass',
      '基线若取在 perform 之后，这条会等满 200ms 然后 fail。'
      + `实际 ${x?.status} / ${x?.assertionSummary}`);
  });

  test('上一步开过的窗口不能让下一步的 expectNewPage 满足（假绿方向）', async () => {
    /*
     * 与 responses.test.ts 里那条同构，也是**本轮最想守住的一条**。
     * 计数器只增不减，所以"基线 = 本步 perform 之前"必须逐步重取；
     * 谁把它写成"会话开始时的 0"，第二条就会拿到 pass，
     * 而**那个 pass 看起来完全合理**（"确实开过窗口啊"）。
     */
    // 预算给 1：**只有第一次点击会开窗**。给 2 的话第二步自己开了一个，
    // 那第二条拿到 pass 是对的，这条测试就什么都没守（我第一版栽在这上面）。
    const w = fakeWindows({ openOnPerformTimes: 1 });
    const r = await run([act({ expectNewPage: true }), { ...act({ expectNewPage: true }), id: 'a2' } as StepDraft], adaptersWith(w));
    const first = r.results.find((y) => y.stepId === 'a');
    const second = r.results.find((y) => y.stepId === 'a2');
    assert.equal(first?.status, 'pass', `第一条该过，否则下面那条在验一件没发生的事。实际 ${first?.status}`);
    assert.equal(second?.status, 'fail',
      `第二条不该再看见同一个窗口。实际 ${second?.status} / ${second?.assertionSummary}`);
  });

  test('没接 adapters.newPage => error + env-unavailable（**不是** fail + product-bug）', async () => {
    /*
     * 归因的方向盘。没接线时如果照常判 fail，报告会说"被测产品没弹窗"，
     * 值班人会去查一个可能完全正常的导出按钮。
     * 所以 adapter 那边观测不到时**整个端口不给**（见 adapter-web/ui.ts），
     * 而这里靠"端口缺失"报环境问题。
     */
    const r = await run([act({ expectNewPage: true, timeoutMs: 200 })], adaptersWith(undefined));
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'error', `实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.equal(x?.cause, 'env-unavailable');
    assert.match(x?.assertionSummary ?? '', /adapters\.newPage|新窗口/, '要说出缺的是哪个口');
    assert.ok(!/超时/.test(x?.assertionSummary ?? ''),
      '摘要不该写"等待超时" —— 那会把"没有数据源"说成"等了一会儿没等到"');
  });

  test('不写 expectNewPage => 行为一字未变（别把普通点击变成要等窗口）', async () => {
    const w = fakeWindows();
    const r = await run([act()], adaptersWith(w));
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'pass', `实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.ok(!('newPagesOpened' in (x?.keyContext ?? {})), '没声明就不该产相关字段');
    assert.equal(w.calls, 0, '没声明却去取计数 = 每个点击都多一次观测（白做的功，也是"字段默默改变行为"）');
  });

  test('expectNewPage: false 与不写同义（默认值不能是第三种行为）', async () => {
    const w = fakeWindows();
    const r = await run([act({ expectNewPage: false })], adaptersWith(w));
    assert.equal(r.results.find((y) => y.stepId === 'a')?.status, 'pass');
    assert.equal(w.calls, 0);
  });
});

describe('两个声明同时存在时，谁都不许被静默跳过', () => {
  /*
   * **这一族是本轮改结构的原因，不是顺手加的。**
   * 以前这里只有 expectResponse 一个块，块尾是 `return {...}`。
   * 我一开始打算"在它后面再加一个 if 判新窗口" —— 那个 return 会让新块
   * **在两个字段同时声明时压根不执行**，而所有"只声明 expectNewPage"的测试
   * 照样全绿：结构缺陷藏在"两个都写"这个没人测的组合里。
   * 所以判据必须是**同时声明**的场景，而且两条的摘要都要在。
   */
  test('两个都不满足 => 两条诊断都在（不是只报第一条）', async () => {
    const w = fakeWindows();
    const r = await run([act({ expectNewPage: true, expectResponse: '/api/export', timeoutMs: 200 })],
      { ...(adaptersWith(w) as object), network: { async responsesSince() { return []; } } } as unknown as AdapterRegistry);
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'fail');
    assert.match(x?.assertionSummary ?? '', /expectResponse/, `少了接口那条：${x?.assertionSummary}`);
    assert.match(x?.assertionSummary ?? '', /expectNewPage/, `少了窗口那条：${x?.assertionSummary}`);
  });

  test('接口回来了但窗口没开 => 仍然 fail（旧结构会在这里静默 pass）', async () => {
    /*
     * 这条是上一版的**回归哨兵**：老结构里 expectResponse 一命中就 return pass，
     * 后面的窗口检查根本轮不到 —— 于是"接口对了、弹窗被拦截"这种
     * 完全真实的缺陷会被判成通过。
     */
    const w = fakeWindows();
    const r = await run([act({ expectNewPage: true, expectResponse: '/api/export', timeoutMs: 200 })],
      {
        ...(adaptersWith(w) as object),
        network: { async responsesSince(s: number) { return s < 1 ? [{ idx: 1, url: 'http://x/api/export', status: 200 }] : []; } },
      } as unknown as AdapterRegistry);
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'fail',
      '接口命中不等于这一步做完了 —— 窗口那条声明也必须判。实际 '
      + `${x?.status} / ${x?.assertionSummary}`);
    assert.match(x?.assertionSummary ?? '', /expectNewPage/);
  });

  test('两个都满足 => pass，两条结论都进摘要', async () => {
    const w = fakeWindows({ openOnPerformTimes: 1 });
    const r = await run([act({ expectNewPage: true, expectResponse: '/api/export', timeoutMs: 200 })],
      {
        ...(adaptersWith(w) as object),
        network: { async responsesSince(s: number) { return s < 1 ? [{ idx: 1, url: 'http://x/api/export', status: 200 }] : []; } },
      } as unknown as AdapterRegistry);
    const x = r.results.find((y) => y.stepId === 'a');
    assert.equal(x?.status, 'pass', `实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.match(x?.assertionSummary ?? '', /expectResponse/);
    assert.match(x?.assertionSummary ?? '', /expectNewPage/);
  });
});

describe('wait{newPage} 条件', () => {
  test('等待期间**异步**落地的窗口 => 等得到', async () => {
    /*
     * 取基线之后才出现的那一个（弹窗动画、延迟 200ms 的脚本都会这样）。
     * 少了这个形态就只能测"等之前已经有了"，而那恰好是本条等待判**不命中**
     * 的情形 —— 只测不命中的那一半，"恒 fail"的实现也能全绿。
     */
    const w = fakeWindows({ openAfterCalls: 2 });
    const r = await run([waitNewPage()], adaptersWith(w));
    const x = r.results.find((y) => y.stepId === 'w');
    assert.equal(x?.status, 'pass', `实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.ok(w.calls >= 2, '要真的 poll 过第二次，否则上面那条 pass 是凭空来的');
  });

  test('对照：同样 alreadyOpen=1，**动作步骤**上声明就能过（两种起点不能互换）', async () => {
    /*
     * 上一条的另一半，也是这两种起点必须并存的理由：
     * 同一个"等待开始前窗口就已经开好了"的现实，
     *  - `wait{newPage}` 判**不命中**（它只能从等待开始时往后看），
     *  - `act{expectNewPage}` 判**命中**吗？**也不** —— 它的基线在 perform 之前，
     *    而窗口是 perform 之前就有的，所以同样不命中。
     * 差别不在这一条上，而在"点击当场开窗"那一条（见上面 openOnPerformTimes 那组）：
     * 那边 wait 会漏、act 不会。**这里钉的是"基线不等于 0"**：
     * 实现若把基线写成常量 0，alreadyOpen=1 会让两条都假绿。
     */
    const w = fakeWindows({ alreadyOpen: 1 });
    const r = await run([act({ expectNewPage: true, timeoutMs: 200 })], adaptersWith(w));
    assert.equal(r.results.find((y) => y.stepId === 'a')?.status, 'fail',
      '会话里早就开过窗口 ≠ 这一步动作开了窗口。基线写成 0 的实现会在这里判 pass');
  });

  test('一直没开 => 超时 fail（另一半，防"恒 pass"）', async () => {
    const w = fakeWindows();
    const r = await run([waitNewPage()], adaptersWith(w));
    const x = r.results.find((y) => y.stepId === 'w');
    assert.equal(x?.status, 'fail', `实际 ${x?.status}`);
    assert.match(x?.assertionSummary ?? '', /标签页|窗口/, '摘要要说清在等什么');
  });

  test('等待开始**之前**就开好的窗口不算命中（起点是本条等待开始时）', async () => {
    /*
     * 这一条是**明知故犯的假红方向**，写进测试是为了把边界钉住：
     * wait 的基线取在等待开始时，所以"上一步点完、这一步才等"这种写法
     * 如果窗口在这两步之间就建好了，会等满超时。
     * 那种需求应当用动作步骤上的 expectNewPage（基线取在 perform 之前，
     * 上面那一条就是它）。
     * 宁可红得看得见，也不让"等过了"与"本来就有"分不清 —— 后者是假绿。
     */
    const w = fakeWindows({ alreadyOpen: 1 });
    const r = await run([waitNewPage()], adaptersWith(w));
    const x = r.results.find((y) => y.stepId === 'w');
    assert.equal(x?.status, 'fail',
      `开窗早于等待时不该算命中。实际 ${x?.status} / ${x?.assertionSummary}`);
    /*
     * **同一个形状，第二件事也要钉住：报错要说出该改哪里。**
     * `waits.ts` 里那句注释本来写着"报错文案里会把这句说出来"，而我去核的时候
     * 发现它**没有** —— 实际的摘要只有"等待超时（500ms）：等待页面新开一个标签页/窗口"。
     * 那就是本仓最反对的那种注释：**声称有一个机制，而没有对应实现**
     * （缺陷类 (a) 反过来用在文档上）。现在补了 `hintOnTimeout`，这条就是它的闸。
     *
     * 为什么值一条测试：这个形态是**假红**（产品正常、字段选错了），
     * 而摘要只说"没等到新窗口"的话，值班人会去查"产品为什么不弹窗"，
     * 真要改的却是把 `wait{newPage}` 换成 `expectNewPage:true`。
     * **一句说错方向的提示比不给提示更省一天**，这话反过来说才对：
     * 少这句提示，人花掉的时间正好花在不会被改的东西上。
     */
    assert.match(x?.assertionSummary ?? '', /expectNewPage/,
      '超时摘要要指出该改用动作步骤上的 expectNewPage，否则人会去查一个其实正常的弹窗');
  });

  test('提示只在**超时**时出现，且**只**在谓词含 newPage 时出现（防"每句摘要都挂着它"）', async () => {
    /*
     * 另一半。第一版把这句拼进 `describePredicate` 的时候，
     * 它同时进了"等待满足（…）：<describe>"那条**成功**摘要 ——
     * 一条过了的等待后面挂着"你可能选错字段了"是纯噪音，
     * 而噪音的代价不是难看，是**人开始跳过摘要**，
     * 摘要的价值恰恰在"每一句都可能正是要看的那句"。
     * 第二半（非 newPage 谓词拿不到这句）守的是"别给所有等待都挂上"：
     * `hintOnTimeout` 对不含 newPage 的谓词返回空串，这条把那个契约钉住。
     *
     * 下面的 `openAfterCalls: **2**` 不是随手写的：夹具里**取基线那一次读就算第 1 次调用**，
     * 写 1 会让窗口恰好落在基线上、永远超不过它。我先写成 1，于是这条的
     * **前置条件自己先红了**（"先确认这条真的过了"那句）。这种红比断言红有用：
     * 它说明测试压根没跑到它想验的那一段 —— 而它要是静默跳过，
     * 下面两句 `!/expectNewPage/` 就都是**永远成立**的空断言。
     */
    const opened = fakeWindows({ openAfterCalls: 2 });
    const okRun = await run([waitNewPage()], adaptersWith(opened));
    const ok = okRun.results.find((y) => y.stepId === 'w');
    assert.equal(ok?.status, 'pass', `先确认这条真的过了，否则下面的"不含提示"是空断言`);
    assert.ok(!/expectNewPage/.test(ok?.assertionSummary ?? ''),
      `成功的等待摘要里不该有那句提示：${ok?.assertionSummary}`);

    /*
     * 不含 newPage 的谓词超时：不该被塞进这句（否则会误导成"我是不是该开弹窗"）。
     * 选 `uiPredicate{state:'gone'}` 是有原因的：ui 桩的 resolve **恒返回一个句柄**，
     * 所以"gone"永远不满足 => 必然超时。
     * （我先用的是 `uiIdle`，它在这套桩下**立刻满足** —— 桩的 snapshot 恒给同一个 sha ——
     *  于是这条也是前置条件红。两次都是同一个教训：**负向断言之前必须先证"它真的没满足"。**）
     */
    const r = await run(
      [{
        id: 'w', kind: 'wait', timeoutMs: 200, pollMs: 50,
        condition: {
          type: 'uiPredicate', state: 'gone',
          target: { intent: 'gone', primary: { by: 'css', value: '#x' }, fallbacks: [], confidenceGate: 0.5, replayable: true },
        },
      } as StepDraft],
      adaptersWith(fakeWindows()),
    );
    const x = r.results.find((y) => y.stepId === 'w');
    assert.ok(x && x.status !== 'pass', `这条得先真的超时，否则"没被塞提示"什么都没测。实际 ${x?.status}`);
    assert.ok(!/expectNewPage/.test(x.assertionSummary ?? ''),
      `uiIdle 的超时摘要里出现了弹窗提示：${x.assertionSummary}`);
  });

  test('没接观测口 => error + env-unavailable，且不被吞成超时', async () => {
    const r = await run([waitNewPage({ timeoutMs: 200 })], adaptersWith(undefined));
    const x = r.results.find((y) => y.stepId === 'w');
    assert.equal(x?.status, 'error', `实际 ${x?.status} / ${x?.assertionSummary}`);
    assert.equal(x?.cause, 'env-unavailable');
  });
});

describe('观测口的形状：只有计数，没有 URL', () => {
  test('NewPageObserver 只有 count()，任何结论里都不出现新页面的地址', async () => {
    /*
     * 这一条守的是**接口形状**而不是某个实现：只要端口上只有 count()，
     * 就没有任何一条路径能把新页面的 URL 带进 keyContext/摘要/trace。
     * 而 URL 是 must-not-land-there 的那类值（`?token=` 这种查询串
     * redactForDisk 判不出来 —— 值形态规则只认 JWT/AKIA/sk-/Bearer）。
     * 断"整份 run 结果里没有 http"比断"某个字段没填"结实：
     * 后者只挡住我想到那一处写法。
     */
    const w = fakeWindows({ openOnPerformTimes: 1 });
    const r = await run([act({ expectNewPage: true })], adaptersWith(w));
    assert.equal(Object.keys(w.observer).join(','), 'count', '端口只该有 count()');
    const dumped = JSON.stringify(r.results);
    assert.ok(!/https?:\/\//.test(dumped), `结果里出现了 URL：${dumped.slice(0, 200)}`);
  });
});

describe('expectNewPage 只在 act 上（navigate 上没有这个语义）', () => {
  test('navigate 写 expectNewPage 被 IR 拒（strict 生效，不会静默忽略）', () => {
    assert.throws(() => defineScenario({
      schemaVersion: '1', id: 'scn.np3', name: 'r', tags: [], env: { environmentRef: 'unit' },
      body: [{ id: 'n', kind: 'navigate', url: 'http://x/', expectNewPage: true } as StepDraft],
    } as ScenarioDraft), IrValidationError);
  });
});
