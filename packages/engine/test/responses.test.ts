/**
 * `wait{response}` 与 `expectResponse`（docs/06 §3「点了查询，等那个接口回来」）。
 *
 * ## 这个文件存在的理由：这条等待从落地那天起一次都没工作过
 *
 * 改动前它长这样（`wait.ts`）：
 * ```ts
 * return d.evalExpr(`__responses != null && count(filter(__responses, "url =~ '${c.urlPattern}'")) > 0`);
 * ```
 * 两层都是坏的，而**第二层把第一层藏住了**：
 *  1. `__responses` **全仓没有任何地方往里写**（grep 只命中这一行读它的代码）=> 条件恒假。
 *  2. 就算手工把 `__responses` 塞进变量空间，那条表达式**自己也跑不通**：
 *     本仓表达式语言不用单引号做字符串字面量。实测每 poll 都抛
 *     `引用必须以 $ 开头（路径：url =~ '/api/query'）`，被"求值报错也继续等"收成超时。
 *
 * 实测的旧行为（`.scratch` 探针跑真引擎）：无论怎么配，都是
 * `fail` + `env-unavailable` + 摘要「等待超时：等待接口 /api/query」——
 * 与"被测页面确实没发那个请求"**逐字节相同**。
 * **接线缺失与产品行为给出同一个结论**，是这条缺陷唯一的、也是最贵的性质：
 * 人会去查一个可能压根不存在的接口问题，而没人会去查平台。
 *
 * ## 这里每条测试的判据方向
 *
 *  - 「不匹配时必须 fail」与「匹配时必须 pass」**成对**出现。
 *    只写一边会被"恒 fail"或"恒 pass"两种实现各自骗过 ——
 *    而本轮修的那个洞恰好就是"恒 fail"这一种，它当年看起来和"产品没发请求"一模一样。
 *  - 最关键的一条是 **"上一步消费过的响应不能让下一步的等待满足"**（窗口起点），
 *    以及**"没接观测口要报错而不是超时"**（方向：让人查接线，不是查产品）。
 *  - `expectResponse` 与 `wait{response}` 各测一遍：它们**共用同一个判据**，
 *    但入口是两处代码。只测一个的话，另一个人加动作步骤那侧的分支时可以整段写错。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runScenario, deterministicClock, type AdapterRegistry, type ObservedResponse } from '../src/index.js';
import { defineScenario, IrValidationError, type ScenarioDraft, type StepDraft } from '@atest/ir';

/**
 * 假的响应流。**下标从 1 起、只增不减**（与 adapter-web 的契约一致）。
 *
 * 用它而不是"直接返回一个固定数组"：窗口起点这件事只能靠
 * "adapter 按 since 过滤"来观测。固定返回全量的话，
 * 引擎里那本账（ResponseLedger）写错也测不出来 ——
 * 而"账写错"的表现正是本轮要防的那个假绿。
 */
function fakeStream(initial: Array<{ url: string; status: number }> = []) {
  /*
   * 每条带**绝对下标**（从 1 起），与真 adapter（adapter-web 的 ResponseBuffer）同语义。
   * 刻意不用"数组位置当下标"：那样就测不出淘汰留下的空洞，
   * 而引擎按条数推进游标的那个错（我第一版就是这么写的）只在有空洞时显形。
   */
  const all: ObservedResponse[] = initial.map((r, i) => ({ ...r, idx: i + 1 }));
  /** 下一条的下标。**独立于数组长度** —— 与真 adapter 同语义：淘汰之后下标不回退。
   *   （写成 `all[all.length - 1].idx + 1` 也能跑，但那个式子在数组被 evict 空之后
   *    取不到元素，而且它把"下标"定义成"数组末尾 + 1"，正是产品侧要避免的那个定义。） */
  let seq = all.length;
  let calls = 0;
  return {
    observer: {
      async responsesSince(since: number): Promise<ObservedResponse[]> {
        calls++;
        // 严格大于：since 是"已经消费到的那一条"
        return all.filter((r) => r.idx > since).map((r) => ({ ...r }));
      },
    },
    /** 模拟"页面又发了一个请求" */
    push(url: string, status = 200) { all.push({ url, status, idx: ++seq }); },
    /**
     * 模拟 adapter 的**内存上限淘汰**：丢掉最旧的 k 条，**下标不重排**（留空洞）。
     * "不重排"是这条夹具的全部价值 —— 真 adapter 也宁可留空洞，
     * 因为重排会让引擎把旧响应当成新的（假绿）。
     */
    evict(k: number) { all.splice(0, Math.min(k, all.length)); },
    get calls() { return calls; },
    get total() { return all.length; },
  };
}

const uiStub: AdapterRegistry = {
  ui: {
    async resolve() { return { resolvedBy: 'testid', rung: 1, confidence: 1, nonReplayable: false, handle: 'h' }; },
    async perform() { /* no-op */ },
    async snapshot() { return { kind: 'aria', data: '', sha: 'x' }; },
    async assertUi() { return { passed: true, actual: 1, expected: 1 }; },
  },
} as unknown as AdapterRegistry;

/** 带网络观测口的注册表。timeoutMs 短一点：deterministicClock 只在 sleep 上推进，不会真等 */
function adaptersWith(stream: ReturnType<typeof fakeStream>): AdapterRegistry {
  return { ...uiStub, network: stream.observer } as unknown as AdapterRegistry;
}

const waitResp = (urlPattern: string, over: Record<string, unknown> = {}): StepDraft =>
  ({ id: 'w', kind: 'wait', timeoutMs: 1_000, pollMs: 50, condition: { type: 'response', urlPattern }, ...over } as StepDraft);

/** 一条最小的 act 步骤（三个 describe 共用，所以放在模块级 —— 放在其中一个里面
 *  的话，别处引用它会在**运行时**才炸，而 assert.throws 会把那个 ReferenceError
 *  当成"抛了个错"报成语义不符的失败。我第一版就是这么写的，报错是
 *  `The error is expected to be an instance of "IrValidationError". Received "ReferenceError"`）*/
const act = (over: Record<string, unknown> = {}): StepDraft =>
  ({
    id: 'a', kind: 'act',
    locator: { intent: '查询', primary: { by: 'testid', value: 'q' } },
    action: 'click', timeoutMs: 1_000, ...over,
  } as StepDraft);

async function runWait(stream: ReturnType<typeof fakeStream>, body: StepDraft[]) {
  const s = defineScenario({
    schemaVersion: '1', id: 'scn.resp', name: 'r', tags: [], env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);
  const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: adaptersWith(stream) });
  const x = r.results.find((y) => y.stepId === 'w');
  assert.ok(x, `wait 步骤没进 results（实际：${r.results.map((y) => y.stepId).join(', ')}）`);
  return x!;
}

describe('wait{response}：真的能等到了（改动前恒超时）', () => {
  test('窗口里有匹配的响应 => 满足（改动前：恒 fail）', async () => {
    const stream = fakeStream([{ url: 'https://x/api/query', status: 200 }]);
    const x = await runWait(stream, [waitResp('/api/query')]);
    assert.equal(x.status, 'pass', `改动前这一步恒 fail（摘要"等待接口 /api/query"）。实际：${x.assertionSummary}`);
    assert.ok(stream.calls >= 1, '要真的问过 adapter，否则上面那条 pass 是凭空来的');
  });

  test('没有匹配的响应 => 超时 fail（另一半，防"恒 pass"）', async () => {
    const stream = fakeStream([{ url: 'https://x/api/other', status: 200 }]);
    const x = await runWait(stream, [waitResp('/api/query')]);
    assert.equal(x.status, 'fail');
    assert.match(x.assertionSummary ?? '', /等待接口/, '摘要要说清在等哪个接口');
  });

  /** 带状态白名单的等待条件（waitResp 只带 urlPattern，这里补上 status 那一维） */
  const waitRespStatus = (urlPattern: string, status: number[]): StepDraft =>
    ({ id: 'w', kind: 'wait', timeoutMs: 1_000, pollMs: 50, condition: { type: 'response', urlPattern, status } } as StepDraft);

  test('status 筛选：url 对上但状态不在白名单 => 不算命中', async () => {
    const stream = fakeStream([{ url: 'https://x/api/query', status: 500 }]);
    const x = await runWait(stream, [waitRespStatus('/api/query', [200, 201])]);
    assert.equal(x.status, 'fail', '500 不该被 [200,201] 选中。写成"url 命中就算"的话，报错接口会被等成"成功"');
  });

  test('status 筛选：状态对上 => 命中（另一半，防"恒 fail"）', async () => {
    const stream = fakeStream([{ url: 'https://x/api/query', status: 201 }]);
    const x = await runWait(stream, [waitRespStatus('/api/query', [200, 201])]);
    assert.equal(x.status, 'pass', x.assertionSummary ?? '');
  });

  test('status: [] 按\"不筛状态\"处理（钉死空数组的含义，不给它留两种读法）', async () => {
    /*
     * `waits.ts` 的 status 是 `z.array(z.int()).optional()` —— 没有 default，
     * 所以 `[]` 在 IR 里是**写得出来**的（Agent 生成时"没有状态约束"很容易落成 []）。
     * 两种读法都说得通：白名单为空 => 什么都不匹配（严格），或 => 不设限（宽容）。
     * **这里选宽容并把它钉住**，因为选严格的话症状是
     * "我什么都没写限制，它却永远等不到" —— 又一颗"配置静默无效"的雷。
     *
     * 选哪种不是重点，**重点是别再让它有两种读法**：
     * 本轮变异集里这条原本是标 `equivalent`（意思是"没测试覆盖到"），
     * 那等于把一个真实的语义分叉记成"测不出来"。标成有测试守着才是对的处置。
     */
    const stream = fakeStream([{ url: 'https://x/api/query', status: 500 }]);
    const x = await runWait(stream, [waitRespStatus('/api/query', [])]);
    assert.equal(x.status, 'pass', `空 status 白名单应当等于不设限。实际 ${x.status} / ${x.assertionSummary}`);
  });

  /*
   * **本轮最想守住的一条**：窗口起点。
   *
   * 两个 wait 等同一个 pattern。第一条把那条响应消费掉（账推进），
   * 第二条就**不该**再看见它 —— 否则"我刚做的那个动作触发了这个接口"这条断言
   * 变成"这个会话里某个时候发过这个接口"，也就是它承诺的那件事的反面。
   *
   * 如果引擎里那本账（ResponseLedger）写错、或每次开窗都从 0 开始，
   * 第二条会拿到 pass —— 而**这个 pass 看起来完全合理**（"确实有个 /api/query 回来了"）。
   * 这就是为什么必须用"按 since 过滤"的假流：直接返回全量的夹具**结构上测不出这条**。
   */
  test('上一步消费过的响应不能让下一步的等待满足（假绿方向）', async () => {
    /*
     * **本轮最想守住的一条。**
     *
     * 同一个场景里两条 wait 等同一个 pattern，流里只有一条 /api/query。
     * 第一条应当满足；第二条**必须超时** —— 否则
     * "我刚做的那个动作触发了这个接口"这条断言就变成了
     * "这个会话里某个时候发过这个接口"，也就是它承诺的那件事的反面。
     *
     * 判据是**第二条的结论**，不是夹具的条数（我第一版在这写的是
     * `assert.equal(stream.total, 1)` —— 那是在断言夹具，引擎怎么写都照样绿）。
     * 引擎里那本账（ResponseLedger）写错、或每次开窗都从 0 开始的话，
     * 第二条会拿到 pass，而**那个 pass 看起来完全合理**（"确实有个 /api/query 回来了"）。
     *
     * 这条也只有配"按 since 过滤"的假流才测得出来：
     * 直接返回全量的夹具**结构上**测不到窗口起点。
     */
    const stream = fakeStream([{ url: 'https://x/api/query', status: 200 }]);
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.win', name: 'r', tags: [], env: { environmentRef: 'unit' },
      body: [waitResp('/api/query'), { ...waitResp('/api/query'), id: 'w2' } as StepDraft],
    } as ScenarioDraft);
    const r = await runScenario({
      scenario: s, clock: deterministicClock(7), adapters: adaptersWith(stream),
    });
    const first = r.results.find((y) => y.stepId === 'w');
    const second = r.results.find((y) => y.stepId === 'w2');
    assert.equal(first?.status, 'pass', `第一条应当满足，否则下面那条在验一件没发生的事。实际 ${first?.status} / ${first?.assertionSummary}`);
    assert.equal(second?.status, 'fail', `第二条不该再看见同一条响应。实际 ${second?.status} / ${second?.assertionSummary}`);
  });

  test('第二条 wait 等**新**发生的响应 => 满足', async () => {
    /*
     * 上一条的另一半：窗口不能是"只看不见旧的、也看不见新的"。
     * 假流在两次 poll 之间多推一条（模拟动作触发的请求落地）。
     */
    let pushed = false;
    const stream = fakeStream([{ url: 'https://x/api/query', status: 200 }]);
    const inner = stream.observer;
    const wrapped = {
      async responsesSince(since: number) {
        // 第一次 poll 之后才出现的新响应：这是 wait 唯一能等到它的机会
        if (!pushed) { pushed = true; stream.push('/api/newer', 200); }
        return inner.responsesSince(since);
      },
    };
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.resp2', name: 'r', tags: [], env: { environmentRef: 'unit' },
      body: [waitResp('/api/newer')],
    } as ScenarioDraft);
    const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: { ...uiStub, network: wrapped } as unknown as AdapterRegistry });
    assert.equal(r.results.find((y) => y.stepId === 'w')!.status, 'pass',
      '等待期间落地的响应必须看得见，否则这条等待只能靠运气（先有响应才能等到）');
  });

  test('命中的响应不一定是窗口里**最后**一条', async () => {
    /*
     * 页面在业务接口之后还会发埋点/心跳，所以"等的那个接口"经常不是最新的。
     * 这条的存在让"窗口只留最新一条"这类优化当场变红 ——
     * 而那种优化看起来无害（省内存），且**只在这类页面上**才错。
     */
    const stream = fakeStream([
      { url: 'https://x/api/query', status: 200 },
      { url: 'https://x/collect.gif', status: 200 },
    ]);
    const x = await runWait(stream, [waitResp('/api/query')]);
    assert.equal(x.status, 'pass', '埋点在业务接口之后落地，不能因此看不见前者');
  });

  test('adapter 淘汰过旧条目后，已被消费的那条不能再次算命中（游标按**下标**而非条数）', async () => {
    /*
     * 这条是 ObservedResponse.idx 这个字段存在的**全部理由**，也是它与我第一版写法的分歧点。
     *
     * 我第一版让引擎"游标 += 本批条数"。这在**切片连续**时与"取最大下标"完全等价，
     * 所以 17 条测试全绿 —— 而它默认了一个 adapter 并不给的性质。
     * adapter 有内存上限：淘汰最旧的若干条之后，切片开头有空洞，
     * 于是"条数"比"真实推进到的位置"**少**，游标落到流的后面。
     * 下一步开窗用的起点就是这个落后的数 => 上一步**已经消费过**的响应
     * 被再报一次 => 那条"我刚做的动作触发了这个接口"的等待被一条旧响应满足（假绿）。
     *
     * 夹具里那两行 `evict(2)` 是这条能跑起来的关键：不淘汰就永远没有空洞，
     * 没有空洞就两种写法等价、这条测不出任何东西（我写之前先确认了这点，
     * 见下面把 poll 改回 += 的验证）。
     */
    const stream = fakeStream([
      { url: 'https://x/old1', status: 200 },
      { url: 'https://x/old2', status: 200 },
      { url: 'https://x/keep1', status: 200 },
      { url: 'https://x/api/query', status: 200 },
      { url: 'https://x/collect.gif', status: 200 },
    ]);
    // 模拟 adapter 已经淘汰了最旧两条（下标 1、2 不在了，3/4/5 还在）
    stream.evict(2);
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.evict', name: 'r', tags: [], env: { environmentRef: 'unit' },
      body: [waitResp('/api/query'), { ...waitResp('/api/query'), id: 'w2' } as StepDraft],
    } as ScenarioDraft);
    const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: adaptersWith(stream) });
    const first = r.results.find((y) => y.stepId === 'w');
    const second = r.results.find((y) => y.stepId === 'w2');
    assert.equal(first?.status, 'pass', `第一条应当命中。实际 ${first?.status} / ${first?.assertionSummary}`);
    assert.equal(second?.status, 'fail',
      `第二条不该再看见同一条 /api/query（它已被第一条消费）。实际 ${second?.status} / ${second?.assertionSummary}。`
      + '如果这里是 pass，说明游标按条数推进：淘汰留下的空洞让它落后于真实的流');
  });

  test('没配 adapters.network => error + env-unavailable（**不是**超时 fail）', async () => {
    /*
       * 这条是本轮改动的"方向性"判据：接线缺失必须说成**接线缺失**。
       *
       * 改动前它给的是 fail + "等待超时：等待接口 X" —— 一句把平台问题
       * 说成产品行为的诊断，而且是**最常见**的那类误诊来源（人会去翻 Network 面板）。
       * 现在抛 NoNetworkObserver => runStep 的 error 分支 => env-unavailable。
       *
       * 为什么不是 fail：fail 的意思是"被测产品答错了"。
       * 为什么不是装配期就报错（CLI 那种 CliError/EXIT.ENV）：
       * 引擎不知道调用方是谁 —— CLI 可以装配期拦，把引擎当库用的服务端 worker 不能，
       * 所以引擎这一层的正确姿势是"跑到这里、如实说缺什么"。
       */
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.nonet', name: 'r', tags: [], env: { environmentRef: 'unit' },
      body: [waitResp('/api/query')],
    } as ScenarioDraft);
    const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: uiStub });
    const x = r.results.find((y) => y.stepId === 'w')!;
    assert.equal(x.status, 'error', `实际 ${x.status} / ${(x.assertionSummary ?? '').slice(0, 80)}`);
    assert.equal(x.cause, 'env-unavailable');
    assert.match(x.assertionSummary ?? '', /adapters\.network|没配/, '要直说缺的是观测口，不要说"等待超时"');
    assert.ok(!/等待超时/.test(x.assertionSummary ?? ''), '不能同时说"超时"——那会把人指回产品侧');
  });

  test('复合条件里的两个 response 分支共用一次拉取（不互相吃掉）', async () => {
    /*
     * anyOf[A, B]：如果每个分支自己 poll 一次并推进游标，
     * 先求值的那支会把条目**吃掉**，另一支永远看不见 ——
     * 症状是"只写一个接口能过、写两个反而过不了"，
     * 而这类"两个各自都对、合起来错"的形状单测分支是测不出来的。
     *
     * 用 anyOf 而不是 allOf 是为了让判据干净：allOf 需要两条响应，
     * 那时"合起来过不了"也可能是数据问题；anyOf 只要一条，
     * 且**两条分支各命中一条不同的响应**，吃掉任何一条都会红。
     */
    const stream = fakeStream([{ url: 'https://x/api/a', status: 200 }]);
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.any', name: 'r', tags: [], env: { environmentRef: 'unit' },
      body: [{
        id: 'w', kind: 'wait', timeoutMs: 1_000, pollMs: 50,
        condition: { anyOf: [
          { type: 'response', urlPattern: '/api/a' },
          { type: 'response', urlPattern: '/api/never' },
        ] },
      } as StepDraft],
    } as ScenarioDraft);
    const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters: adaptersWith(stream) });
    assert.equal(r.results.find((y) => y.stepId === 'w')!.status, 'pass');
  });

  test('匹配是子串而不是正则（`a.c` 不匹配 `abc`）', async () => {
    /*
     * 口径本身要钉住：子串是 Playwright `waitForResponse(str)` 的口径。
     * 选它的理由写在 responses.ts（正则要防 IR 里的 ReDoS，glob 与 URL 里的 `*` 撞）。
     * 但**选了子串就得钉住它**，否则有人"顺手改成正则"，
     * 于是 IR 里一个写着 `a.c` 的 pattern 会突然匹配 `abc` ——
     * 那类改动不会有人回来改这条等待的文档。
     */
    const dot = await runWait(fakeStream([{ url: 'https://x/abc', status: 200 }]), [waitResp('a.c')]);
    assert.equal(dot.status, 'fail', '子串口径下 "a.c" 不该匹配 "abc"');
    const hit = await runWait(fakeStream([{ url: 'https://x/a.c', status: 200 }]), [waitResp('a.c')]);
    assert.equal(hit.status, 'pass');
  });
});

describe('expectResponse（动作步骤那侧的同一个判据）', () => {
  async function runAct(stream: ReturnType<typeof fakeStream> | undefined, over: Record<string, unknown> = {}) {
    const s = defineScenario({
      schemaVersion: '1', id: 'scn.act', name: 'a', tags: [], env: { environmentRef: 'unit' },
      body: [act(over)],
    } as ScenarioDraft);
    const adapters = stream ? adaptersWith(stream) : uiStub;
    const r = await runScenario({ scenario: s, clock: deterministicClock(7), adapters });
    const x = r.results.find((y) => y.stepId === 'a')!;
    return { x, r };
  }

  test('点了按钮且那个接口回来了 => pass（改动前：字段没人读，恒 pass）', async () => {
    const { x } = await runAct(fakeStream([{ url: 'https://x/api/query', status: 200 }]), { expectResponse: '/api/query' });
    assert.equal(x.status, 'pass');
    // 摘要要点名命中的是什么。"pass + 一句 act testid (1.00)" 不足以让人相信它等过接口
    assert.match(x.assertionSummary ?? '', /expectResponse/, `实际：${x.assertionSummary}`);
    assert.match(x.assertionSummary ?? '', /命中/);
  });

  test('点了按钮但那个接口没回来 => fail + product-bug', async () => {
    const { x } = await runAct(fakeStream([{ url: 'https://x/api/other', status: 200 }]), { expectResponse: '/api/query' });
    assert.equal(x.status, 'fail', '改动前这个字段**全仓没人读**，所以这一步恒 pass');
    assert.equal(x.cause, 'product-bug', '"点了按钮但接口没发出来"是被测产品的行为与用例声明不符。env-unavailable 会让人去查接线');
  });

  test('不写 expectResponse => 行为一字未变（别把没声明的步骤变成要等接口）', async () => {
    const { x } = await runAct(fakeStream([]));
    assert.equal(x.status, 'pass');
  });

  test('没接观测口时抛环境错误，而不是"接口没回来"', async () => {
    const { x } = await runAct(undefined, { expectResponse: '/api/query' });
    assert.equal(x.status, 'error');
    assert.equal(x.cause, 'env-unavailable');
    assert.match(x.assertionSummary ?? '', /adapters\.network|没配/);
  });

  test('命中的响应**不给 URL**（URL 里可能带 token/手机号）', async () => {
    /*
     * 判据取"页面/摘要里找不到那串带密钥的 URL"，而不是"验实现了脱敏函数"：
     * redactForDisk 的值形态规则**判不出查询串里的密钥**（只认 JWT/AKIA/sk-/Bearer 形状），
     * 所以 `?token=abc123` 这种会原样穿过脱敏。唯一的稳做法是**根本不产 URL**。
     */
    const secretUrl = 'https://x/api/query?token=abc123supersecret';
    const { x, r } = await runAct(fakeStream([{ url: secretUrl, status: 200 }]), { expectResponse: '/api/query' });
    assert.equal(x.status, 'pass');
    const dumped = JSON.stringify(x.keyContext) + (x.assertionSummary ?? '') + JSON.stringify(r.events);
    assert.ok(!dumped.includes('abc123supersecret'), `URL 的查询串进了报告：${dumped.slice(0, 200)}`);
  });
});

describe('expectResponse 的形状约束（空串会匹配一切）', () => {
  test('expectResponse: "" 被 IR 拒 —— 子串口径下空串恒匹配任何响应', () => {
    /*
     * 这不是风格问题：`url.includes('')` 恒为真，
     * 于是"我声明了要等某个接口"变成"页面只要发过任何东西就算过"。
     * `waits.ts` 的 urlPattern 本来就写着 min(1)，两处曾经一套约束不一样。
     */
    assert.throws(() => defineScenario({
      schemaVersion: '1', id: 'scn.empty', name: 'e', tags: [], env: { environmentRef: 'unit' },
      body: [act({ expectResponse: '' })],
    } as unknown as ScenarioDraft), IrValidationError);
  });

  test('navigate 上的 expectResponse 同样受 min(1) 约束（同一个 schema，不是各写一遍）', () => {
    // 两处共用 ExpectResponseSchema。分开写的话其中一处被放宽是无声的
    assert.throws(() => defineScenario({
      schemaVersion: '1', id: 'scn.empty2', name: 'e', tags: [], env: { environmentRef: 'unit' },
      body: [{ id: 'n', kind: 'navigate', url: 'https://x/', expectResponse: '' } as StepDraft],
    } as unknown as ScenarioDraft), IrValidationError);
    assert.doesNotThrow(() => defineScenario({
      schemaVersion: '1', id: 'scn.ok', name: 'e', tags: [], env: { environmentRef: 'unit' },
      body: [{ id: 'n', kind: 'navigate', url: 'https://x/', expectResponse: '/api' } as StepDraft],
    } as unknown as ScenarioDraft));
  });
});
