/**
 * 重试与 flake 归因。
 *
 * **这个文件存在的理由是一条实测到的假绿**（本轮之前，下面前四条用例**全部不存在**，
 *  而把 withRetry 里"撤掉被取代的尝试"整段删掉，780 条测试**一条都不红**）：
 *
 * 一个"第 1 次连不上、第 2 次成功"的步骤 —— 这就是 flaky 的定义形状 ——
 * 当时的实际输出是
 *      发请求=2  运行状态=error  结果=[h:error, h:pass]
 * 一个步骤留下**两行自相矛盾的结论**，四个后果全落在"红绿可不可信"上：
 *  1. 整体状态是 `gate.some(r => r.status === 'error')` —— **重试成功的步骤
 *     仍然把整个 run 判成 error**，于是 flake 表现为永远修不完的红灯；
 *  2. JUnit 一行一个 `<testcase>`，同一步骤重复贡献 tests；
 *  3. `countsTowardPassRate` 把 error 与 pass **都**算进分母，
 *     一次 flake 同时抬高分子和分母，通过率"在动"但没有含义；
 *  4. 门禁的 leaves 里两条矛盾结论并存，人先花时间怀疑报告坏了而不是查 flake。
 *
 * 修法是**撤掉没被采纳的那一行**，同时把过程并进保留的那一行（`keyContext.flakyOf`）：
 * 撤行是为了让**结论**唯一，不是为了销毁过程 —— 所以这里同时钉"过程还在"
 * （trace 里仍是一次尝试一条 step.finished）。
 *
 * 与 `executor.test.ts` 里那条"预编译形态不重试"的分工：那边钉的是
 * **两条路径刻意不一致**这件事（压测里重试会把一次故障算成两次负载），
 * 这边钉的是功能形态的重试语义本身。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseStepResults, toJUnitXml } from '../src/report.js';
import { TransportError, type AdapterRegistry } from '../src/adapters.js';
import { b, res, run, scen, type StepDraft } from './helpers.js';
import { countsTowardPassRate, IrValidationError } from '@atest/ir';
import type { RunReport } from '../src/index.js';

/** 撤掉那些尝试的摘要。keyContext 是 record(string, unknown)，所以读侧必须自己收窄类型 */
type FlakyOf = Array<{ attempt: number; status: string; waitedMs: number; cause?: string; summary?: string }>;
/** 读不到就直接失败：直接 cast 再 .length 的话，"字段压根没写"会表现成 TypeError，读不出结论 */
const flakyOfOf = (r: { keyContext: Record<string, unknown> }): FlakyOf => {
  const v = r.keyContext.flakyOf;
  assert.ok(Array.isArray(v), `keyContext.flakyOf 不是数组（实际 ${JSON.stringify(v)}）—— 撤掉的尝试没留下过程记录`);
  return v as FlakyOf;
};

/**
 * 前 `failUntil - 1` 次**传输层失败**、之后成功的 http adapter。
 *
 * 抛的是 TransportError 而不是普通 Error —— 这是**本轮修正之后才需要**的写法：
 * 以前引擎按 `cause === 'network'` 判可重试，而 cause 永远不可能是 network
 * （FAILURE_CAUSE 里就没这个词），所以抛什么都是一次不重试；
 * 现在引擎读的是 TransportError 带来的种类，普通 Error 仍然不重试。
 * 换句话说：**把 retryOn 修好的那一步，同时让"随便抛个错也能重试"的假测试失效了** ——
 * 这正是想要的方向（假测试该红）。
 *
 * `sends()` 是**真实发送次数**：光看结果状态分不出"重试发生了"与"配置没生效"，
 * 而这一族缺陷的症状恰好是后者伪装成前者。
 */
function flakyHttp(failUntil: number, kind: 'network' | 'timeout' = 'network'): { adapters: AdapterRegistry; sends: () => number } {
  let n = 0;
  const adapters = {
    http: {
      async send() {
        n++;
        if (n < failUntil) throw new TransportError(kind, `ECONNREFUSED #${n}`);
        return { status: 200, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 5 };
      },
    },
  } as unknown as AdapterRegistry;
  return { adapters, sends: () => n };
}

/** 会重试的 http 步骤。GET 是幂等的，所以允许重发（见 engine 的 resendsSafely） */
const retried = (id: string, count = 2, over: Record<string, unknown> = {}): StepDraft =>
  ({ ...b(id), kind: 'http', request: { method: 'GET', url: 'http://x/a' }, retry: { count, ...over } } as StepDraft);

describe('重试成功的步骤：结论必须唯一', () => {
  test('一次 flake 只留一行，且整体状态是 pass 而不是 error', async () => {
    const { adapters, sends } = flakyHttp(2); // 第 1 次抛，第 2 次成
    const r = await run(scen([retried('h')]), { adapters });
    assert.equal(sends(), 2, '重试本身要真的发生（否则下面几条都在验一件没发生的事）');
    assert.deepEqual(r.results.map((x) => x.stepId), ['h'], '一个步骤只能有一行结论');
    assert.equal(res(r, 'h').status, 'pass');
    assert.equal(r.status, 'pass', '重试用尽前就通过了，整体状态不能是 error —— 那正是"flake 变成长期红灯"的成因');
    assert.equal(r.tally.error, 0, '失败的那次尝试不该留在 tally 里');
  });

  test('retry 计数记的是"额外尝试了几次"，且落在保留的那一行上', async () => {
    const r = await run(scen([retried('h', 3)]), { adapters: flakyHttp(3).adapters });
    assert.equal(res(r, 'h').retry, 2, '第 3 次才过 => 额外尝试 2 次');
  });

  test('被撤掉的尝试的过程进 keyContext.flakyOf，带得上一次为什么失败', async () => {
    const r = await run(scen([retried('h', 3)]), { adapters: flakyHttp(3).adapters });
    const of = flakyOfOf(res(r, 'h'));
    assert.equal(of.length, 2, '撤掉两次就该有两条摘要');
    assert.deepEqual(of.map((x) => x.attempt), [1, 2], 'attempt 是第几次尝试（从 1 起），不是行号');
    assert.ok(of.every((x) => x.status === 'error' && x.cause === 'env-unavailable'), '每次尝试的归因要留着，否则"为什么 flake"还得重跑才知道');
    assert.match(of[0]!.summary ?? '', /ECONNREFUSED #1/, '第 1 次与第 2 次的错不同，摘要不区分就没法定位');
  });

  test('耗时按尝试求和、含 backoff 等待，不只保留最后一次', async () => {
    // 只保留最后一次的话，配了 count=3/baseMs=500 的用例会在 JUnit 里报 time=0.005
    // 而整个 run 报 1s —— 人只会说"数字不准"，而"这一步很慢"正是 flake 的主要症状。
    const r = await run(scen([retried('h', 3, { backoff: 'fixed', baseMs: 500 })]), { adapters: flakyHttp(3).adapters });
    assert.equal(res(r, 'h').durMs, 1000, '两次重试各等 500ms，两次失败尝试自身耗时 0（确定性时钟只在 sleep 上前进）');
  });

  test('通过率分母里这一步只算一次', async () => {
    const r = await run(scen([retried('h')]), { adapters: flakyHttp(2).adapters });
    const counted = r.results.filter((x) => countsTowardPassRate(x.status));
    assert.equal(counted.length, 1, '一次 flake 不该同时抬高分子和分母');
    assert.equal(counted[0]!.status, 'pass');
  });

  test('JUnit 的 tests 对这一步只出一个 testcase', async () => {
    const r = await run(scen([retried('h')]), { adapters: flakyHttp(2).adapters });
    const xml = toJUnitXml(r as RunReport);
    assert.equal((xml.match(/name="h"/g) ?? []).length, 1, '同一步骤重复出 testcase 会让看板的用例数与 CI 退出码对不上');
    assert.doesNotMatch(xml, /<failure|<error/, '重试通过的步骤不该在 JUnit 里留红');
  });

  test('撤行不销毁过程：trace 里仍是一次尝试一条 step.finished', async () => {
    const r = await run(scen([retried('h')]), { adapters: flakyHttp(2).adapters });
    assert.equal(r.events.filter((e) => e.kind === 'step.finished' && e.stepId === 'h').length, 2,
      'results 是结论、trace 是过程。撤掉结论行不等于让过程不可审计');
  });

  test('重试用尽仍失败：保留的是最后一次尝试的结论，且 retry 记满', async () => {
    const { adapters, sends } = flakyHttp(99); // 永远连不上
    const r = await run(scen([retried('h', 2)]), { adapters });
    assert.equal(sends(), 3, 'count=2 => 首发 + 2 次重试');
    assert.deepEqual(r.results.map((x) => x.stepId), ['h'], '失败也只有一个结论行');
    const x = res(r, 'h');
    assert.equal(x.status, 'error');
    assert.equal(x.retry, 2);
    assert.equal(flakyOfOf(x).length, 2, '前面几次失败的原因同样要能看到');
    assert.match(x.assertionSummary ?? '', /#3/, '摘要要是**最后一次**的错，不是第一次的');
  });
});

describe('不该重试的东西', () => {
  test('断言失败（fail）不重试：那是被测系统的答案，不是抖动', async () => {
    // 造一个**真的 fail**：请求正常回来但是 500，由 assert 步骤判红。
    // 之前这条写的是"这条压根不发请求"，于是它只证明了"没发请求的步骤不重试"，
    // 而那跟 fail 会不会被重试无关。
    let n = 0;
    const adapters = {
      http: { async send() { n++; return { status: 500, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 1 }; } },
    } as unknown as AdapterRegistry;
    const r = await run(scen([
      { ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a' }, retry: { count: 2 } } as StepDraft,
      { ...b('a'), kind: 'assert', against: '$.step.h', status: 200, retry: { count: 2 } } as StepDraft,
    ]), { adapters });
    assert.equal(n, 1, '请求只该发一次。判据是 worthRetrying 要求 status==="error"，而 fail 不是 error');
    assert.equal(res(r, 'h').retry, 0, 'http 步骤自己是 pass（500 是被测系统的答案，判红是 assert 的事），更不该重试');
    assert.equal(res(r, 'a').retry, 0, '断言失败重跑一次也是同一个答案');
    assert.equal(res(r, 'a').status, 'fail');
  });

  test('配置错误（adapter 没注册）不重试：重试一万次也不会好', async () => {
    /*
     * 这条以前是"已知缺陷"（`status5xx` 靠一条 alias 映射到 env-unavailable，
     * 于是等价于"任何 error 都重试"，白重试 3 次），现在是**修复后的期望**。
     * 判据的变化很关键：以前问"cause 是不是 env-unavailable"（配置缺失与目标挂了
     * 共用一个值，分不开），现在问"是不是传输层失败"（配置错误压根不是传输层失败）。
     */
    const r = await run(scen([retried('h', 3)]), { adapters: {} });
    assert.equal(r.results.length, 1);
    assert.equal(res(r, 'h').retry, 0, '"http adapter 未注册"没有传输种类，不进重试');
    assert.match(res(r, 'h').assertionSummary ?? '', /未注册/);
  });

  test('非幂等方法（POST）即使传输层失败也一次都不重发', async () => {
    /*
     * 这是本轮唯一一条**安全边界**而不是正确性的用例：docs/05 §4 说 POST 永不自动重试，
     * 因为重复下单级事故的 symptoms 是一次成功的 200，谁都看不见。
     * 判据必须在引擎这一层 —— 决定重发的就是这个循环，adapter 只看得见自己那一次。
     */
    const { adapters, sends } = flakyHttp(99);
    const r = await run(scen([{ ...b('p'), kind: 'http', request: { method: 'POST', url: 'http://x/a', body: { a: 1 } }, retry: { count: 3 } } as StepDraft]), { adapters });
    assert.equal(sends(), 1, `POST 发了 ${sends()} 次请求`);
    assert.equal(res(r, 'p').retry, 0);
  });

  test('超时按 timeout 分类，能单独配只重试超时', async () => {
    const { adapters, sends } = flakyHttp(2, 'timeout');
    const only = await run(scen([retried('h', 2, { retryOn: ['timeout'] })]), { adapters });
    assert.equal(sends(), 2, '超时种类要能被单独选中');
    assert.equal(res(only, 'h').status, 'pass');
    assert.equal(flakyOfOf(res(only, 'h'))[0]!.status, 'error');
  });

  test('skipped 的步骤不重试（守卫不成立是确定答案）', async () => {
    const { adapters, sends } = flakyHttp(2);
    const r = await run(scen([{ ...retried('h'), when: '1 == 2' } as StepDraft]), { adapters });
    assert.equal(sends(), 0);
    assert.equal(res(r, 'h').status, 'skipped');
    assert.equal(res(r, 'h').retry, 0);
  });

  test('count=0 时一次都不重试（即便传输层一直失败）', async () => {
    const { adapters, sends } = flakyHttp(99);
    await run(scen([retried('h', 0)]), { adapters });
    assert.equal(sends(), 1);
  });
});

describe('场景级 config.retries 真的能生效（以前在任何组合下都产生不了一次重试）', () => {
  /*
   * 以前的写法是 `s.retry?.count ?? scenario.config.retries.count`，看着像
   * "步骤没写就吃场景级"，实际吃不到：Zod 对**存在的** retry 对象会补齐全部缺省字段，
   * 所以 `retry: { retryOn: ['timeout'] }`（只写想改的那项，最自然的写法）
   * 落地时 count 已经是 0，那条 `??` 永不触发。实测当时**任何**组合都是发 1 次。
   * 现在逐项合并，见 engine 的 retryPolicyOf。
   */
  const step = (stepRetry?: Record<string, unknown>): StepDraft =>
    ({ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a' }, ...(stepRetry ? { retry: stepRetry } : {}) } as StepDraft);
  const cfg = { retries: { count: 2, backoff: 'none' as const, baseMs: 0, maxMs: 1000, retryOn: ['network'] as ('network' | 'timeout')[] } };

  test('步骤完全不写 retry => 吃场景级 count', async () => {
    const { adapters, sends } = flakyHttp(3);
    const r = await run(scen([step()], { config: cfg as never }), { adapters });
    assert.equal(sends(), 3);
    assert.equal(res(r, 'h').retry, 2);
  });

  test('步骤只写 retryOn 也吃场景级 count（这正是以前失效的那种写法）', async () => {
    const { adapters, sends } = flakyHttp(3);
    await run(scen([step({ retryOn: ['network'] })], { config: cfg as never }), { adapters });
    assert.equal(sends(), 3, '部分覆盖不该把另一部分静默清零');
  });

  test('步骤写的 count 覆盖场景级，而不是相加', async () => {
    const { adapters, sends } = flakyHttp(99);
    await run(scen([step({ count: 1 })], { config: { retries: { ...cfg.retries, count: 5 } } as never }), { adapters });
    assert.equal(sends(), 2, 'count 是上限而不是增量：场景 5 + 步骤 1 若相加就是 7 次请求');
  });

  test('backoff:"none" 真的不等待（以前会走 fixed 那条，白等 baseMs）', async () => {
    const { adapters } = flakyHttp(3);
    const r = await run(scen([retried('h', 2, { backoff: 'none', baseMs: 500 })]), { adapters });
    assert.equal(res(r, 'h').durMs, 0, 'schema 收了三个值就得有三个分支；配了不等待却每轮等 500ms，flake 治理里的"快速重试"写不出来');
    assert.deepEqual(flakyOfOf(res(r, 'h')).map((x) => x.waitedMs), [0, 0]);
  });
});

describe('容器上的 retry：运行时**不重跑**（配套 lint 的 RETRY_ON_CONTAINER）', () => {
  /*
   * lint 那条拒的是"写了不生效"，但**lint 与解释器是两条独立的路**：
   * `atest run` 不保证先跑过 lint（CI 里可以只调 run）。所以"容器不重跑"这件事
   * 必须由解释器自己的测试钉住，否则它只是"目前恰好如此"。
   *
   * 为什么不干脆支持块级重试（两个理由，都在 lint 那条的注释里详述）：
   *  (1) 块里的 POST 会被再发一次 —— 而"POST 永不自动重试"这条边界是按步骤看的；
   *  (2) 上一轮尝试留在 results 里的**子步骤行**撤不掉，会变成同 id 两份结论。
   */
  const seq = (steps: StepDraft[]): StepDraft => ({ ...b('blk'), kind: 'sequence', steps, retry: { count: 2 } } as StepDraft);

  test('容器里的请求失败时不重跑整个块', async () => {
    const { adapters, sends } = flakyHttp(99);
    const r = await run(scen([seq([{ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a' } } as StepDraft])]), { adapters });
    assert.equal(sends(), 1, `块被重跑了：真实发出 ${sends()} 次请求（容器的结论行不带传输种类，所以一次都不该重试）`);
    assert.equal(res(r, 'blk').retry, 0);
  });

  test('块里是 POST 时更不会重发（这条是安全边界，不是风格）', async () => {
    const { adapters, sends } = flakyHttp(99);
    await run(scen([seq([{ ...b('p'), kind: 'http', request: { method: 'POST', url: 'http://x/a', body: { a: 1 } } } as StepDraft])]), { adapters });
    assert.equal(sends(), 1, '重复下单级事故的形状：症状是一次成功的 200，报告里看不见');
  });

  test('块被拒后不留重复行（撤行只撤容器那一行，子行在下一层）', async () => {
    const { adapters } = flakyHttp(99);
    const r = await run(scen([seq([{ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a' } } as StepDraft])]), { adapters });
    assert.deepEqual(r.results.map((x) => x.stepId), ['h', 'blk'],
      '一次尝试：子步骤一行 + 容器一行。出现重复 stepId 就是"同一结论两份"那个症状回来了');
  });
});

describe('retryOn 的取值范围（写了做不了的值会被 schema 拒，而不是静默当一个空配置）', () => {
  /*
   * 这三条钉的是**schema 层面**的行为，与上面那些"运行时重不重试"是两件事：
   * 本轮从 retryOn 删掉了 status5xx / assert-fail / locator-stale（理由见
   * values.ts 的 RetrySchema 注释与 git 历史）。删值之后**唯一的防线**是
   * "作者写了会被拒" —— 如果 schema 仍然收下来，那就退回到本轮修掉的那个洞：
   * 配置静默无效，而用户以为自己配了容错。
   */
  test('写 status5xx 直接被拒（而不是静默当一个空配置）', () => {
    /*
     * **本轮之前**这里只断言"被拒"，不断言文案。原因记得很清楚：
     * 我第一版加了 `assert.match(错误, /network|timeout/)`，测试当场红 ——
     * 作者实际看到的是 `body.0 → Invalid input`，字段名与合法值都在 zod 的 error 里
     * （`path: retry.retryOn.0` + `values:["network","timeout"]`），
     * 被 ir/index.ts 的 humanize() 丢了。那条断言**证伪的是我的注释，不是 schema 的行为**，
     * 所以当时决定"不把弱文案钉进断言：钉了就得在修好的那天回来改测试"。
     *
     * **现在就是那天**：humanize 会下钻 union 的每分支 issue（ir/src/humanize.ts），
     * 所以那句文案断言补回来了。判据细节在 ir/test/humanize.test.ts，
     * 这里只守"从 defineScenario 抛出来的那句话里能读到字段名与合法值"——
     * 那是**作者真正看到的那一层**，ir 包自己绿了不代表这层接上了。
     *
     * 顺带更正这段注释原先记的两个数（写的"28 个分支各报一遍、173 条 issue"，
     * 实测是 39 个分支、162 条分支级 issue）—— 数字错了不影响当时的结论，
     * 但一条"劝人别重测"的注释把数记错，比没数更坏。
     */
    assert.throws(
      () => scen([retried('h', 2, { retryOn: ['status5xx'] })]),
      (e: unknown) => {
        assert.ok(e instanceof IrValidationError, `应是 IrValidationError，实际 ${(e as Error).name}`);
        const msg = (e as IrValidationError).errors.map((x) => `${x.path} ${x.message}`).join(' | ');
        assert.match(msg, /retryOn/, `报错要点出出错字段：${msg}`);
        assert.match(msg, /network/, `要列出合法值，否则作者还是不知道能填什么：${msg}`);
        return true;
      },
    );
  });

  test('写 assert-fail / locator-stale 同样被拒', () => {
    for (const bad of ['assert-fail', 'locator-stale']) {
      assert.throws(() => scen([retried('h', 1, { retryOn: [bad] })]), IrValidationError, `${bad} 应被拒`);
    }
  });

  test('network / timeout 仍然合法（别把在用的两个也一起拒了）', () => {
    assert.doesNotThrow(() => scen([retried('h', 1, { retryOn: ['network'] })]));
    assert.doesNotThrow(() => scen([retried('h', 1, { retryOn: ['timeout', 'network'] })]));
  });
});

describe('fail 步骤的 cause：是封闭枚举（归因口径不能是自由字符串）', () => {
  /*
   * 以前 FailStepSchema 的 cause 是 z.string()，解释器再 `as` 进 StepResult.cause。
   * 于是 cause:'拼错了' 能过 IR 校验、能跑、能写进证据包，而 StepResultSchema
   * 的 cause 是封闭枚举 => 磁盘写得出、读不回（实测 parseStepResults 抛 ZodError）。
   * 更要紧的是看板：按 cause 分组时 `env` / `env-unavailable` / `环境问题`
   * 会被算成三个桶，而没有任何东西会响。
   */
  const failStep = (cause: string): StepDraft =>
    ({ ...b('f'), kind: 'fail', reason: '故意失败', cause } as StepDraft);

  test('写一个不是 FAILURE_CAUSE 的值 -> IR 校验直接拒', () => {
    assert.throws(() => scen([failStep('环境问题')]), IrValidationError);
    assert.throws(() => scen([failStep('env')]), IrValidationError, '少写了 -unavailable 也要拒，否则看板多一个桶');
  });

  test('合法值照收（含本轮仍无引擎产出点的那三个）', () => {
    // flaky / data-conflict / locator-stale 目前**没有任何引擎产出点**，
    // 但 fail 步骤是作者**手工归因**的入口，所以它们在 IR 侧仍然必须可写
    // （跨运行的 flaky 判定要等 P1 的看板层，见 docs/08）。
    for (const c of ['product-bug', 'case-stale', 'env-unavailable', 'locator-stale', 'data-conflict', 'flaky', 'untriaged']) {
      assert.doesNotThrow(() => scen([failStep(c)]), `${c} 必须可写`);
    }
  });

  test('跑完之后这一行的 cause 能原样读回（写盘与读盘是同一套值）', async () => {
    const r = await run(scen([failStep('data-conflict')]));
    const row = r.results[0]!;
    assert.equal(row.cause, 'data-conflict');
    assert.doesNotThrow(() => parseStepResults([JSON.parse(JSON.stringify(row))]));
  });
});
