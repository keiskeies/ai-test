/**
 * **错误 → 归因（cause）** 这一族。
 *
 * ## 为什么单独成文件
 *
 * `docs/14` §5 登记这一条时写的是"`PathError` / `ExprError` 被归成 env-unavailable"，
 * 读起来像缺口是两个类没登记。量下来不是：**同一条判据抄在五处、五处互相矛盾**
 * —— `assertions.ts` 早就把 PathError 判成 case-stale，而解释器判 env-unavailable，
 * 于是同一条写坏的 `$.` 路径换个位置就换个归因（下面那组"换位置"的测试钉的就是这个）。
 * 所以这个文件钉的是三件事，顺序即重要性：
 *
 *  1. **不许过度修**：真·环境问题（缺 adapter、缺 baseUrl）必须**还是** env-unavailable。
 *     把用例错判成环境问题是"难查"；反过来把环境问题判成"用例过期"会让人去改
 *     一条没坏的用例 —— 后者会**改掉好东西**，所以这一组放在最前、也写得最全。
 *  2. **同一个错换位置，归因不许变**（那是本轮真正修的东西）。
 *  3. **兜底那格**：没登记的新错误类得到 `untriaged`（"没人认领"），
 *     而不是一个看起来能直接行动的错答案。
 *
 * 第 3 条不止是注释里的立场：文件末尾那组会扫 `@atest/engine` **实际导出的每一个错误类**，
 * 逐个要求它要么被表覆盖、要么在名单里写明"为什么到不了判据"。理由与
 * `match-keys.test.ts` 扫 evalMatch 源码、`lint.test.ts` 扫真 zod schema 同一口径：
 * 判据每放宽一档，上一次的扫描结论就自动失效，而注释不会红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import * as engine from '../src/index.js';
import {
  causeOfError, ERROR_CAUSE_RULES, NotWiredError, EnvMissing,
  VarError, PathError, ExprError, TransportError, LocatorBudgetError,
  GenKindError, NoConditionAdapter, NoNewPageObserver,
  parseStepResults, toHtmlReport, deterministicClock, runScenario, type RunReport,
} from '../src/index.js';
import { FAILURE_CAUSE, defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
// NoNetworkObserver 直接从模块拿而不走 barrel：`responses.ts` 整个文件**没被 barrel 导出**
// （见下面那条"barrel 看不见的错误类"的护栏 —— 那是一个真实存在的盲区，不是笔误）。
import { NoNetworkObserver } from '../src/responses.js';

const b = (id: string): { id: string } => ({ id });
const scen = (body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.test', name: 'test scenario',
    env: { environmentRef: 'unit' }, body,
  } as ScenarioDraft);
const run = (s: Scenario, adapters: unknown = {}): Promise<RunReport> =>
  runScenario({ scenario: s, adapters: adapters as never, clock: deterministicClock(42) });
const res = (r: RunReport, id: string): RunReport['results'][number] => {
  const x = r.results.find((y) => y.stepId === id);
  assert.ok(x, `没有步骤 "${id}" 的结果（实际：${r.results.map((y) => y.stepId).join(', ') || '无'}）`);
  return x!;
};

/** 一句写坏的 `$.` 路径 / 一句写坏的表达式。同一个字符串放进不同位置，归因必须一致。 */
const BAD_PATH = 'nope';
const BAD_EXPR = '1 +';

describe('不许过度修：真·环境问题必须还是 env-unavailable', () => {
  /*
   * 本轮改的是判据的兜底与两个类的归属，最容易犯的错是**顺手把另一族也挪了**。
   * 所以这一组不是"抽查几个"，而是把 engine 里所有真·环境失效的入口逐个点名：
   * 每一条都对应一个具体的排查动作（去接 adapters.db / 去配 baseUrl），
   * 归因一旦跑偏，值班人就会去做另一个动作。
   */
  test('等待条件要 db adapter 而本场景一个都没有 -> env-unavailable', async () => {
    const r = await run(scen([
      { ...b('a'), kind: 'wait', condition: { type: 'dbRow', sql: 'SELECT 1', datasource: 'main', expect: 'row' }, timeoutMs: 500, pollMs: 50, onTimeout: 'fail' },
    ]));
    const x = res(r, 'a');
    assert.equal(x.cause, 'env-unavailable', `实际 ${x.cause}：缺 adapter 判成用例过期，会有人去改那条没坏的 SQL`);
    assert.match(x.assertionSummary ?? '', /adapters\.db|一个都没有/);
  });
  test('没配 baseUrl 而用例写相对路径 -> env-unavailable（EnvMissing 靠继承才被表看见）', async () => {
    const r = await run(scen([{ ...b('a'), kind: 'http', request: { method: 'GET', url: '/relative/path' } }]));
    const x = res(r, 'a');
    assert.equal(x.status, 'error');
    assert.equal(x.cause, 'env-unavailable', `实际 ${x.cause}：这条**改前也是 env-unavailable**，靠的是那个私有三元里显式列了 EnvMissing；搬进表后靠的是它是 NotWiredError 的子类 —— 换的是判据写法，不是答案`);
  });
  test('缺 device adapter -> env-unavailable', async () => {
    const r = await run(scen([{ ...b('a'), kind: 'app', action: 'launch', package: 'com.x' }]));
    assert.equal(res(r, 'a').cause, 'env-unavailable');
  });
  test('http 传输失败 -> env-unavailable，且传输种类另带一个键', async () => {
    const r = await run(scen([{ ...b('a'), kind: 'http', request: { method: 'GET', url: 'http://x/y' } }]), {
      http: { async send() { throw new TransportError('network', 'ECONNREFUSED'); } },
    });
    const x = res(r, 'a');
    assert.equal(x.cause, 'env-unavailable');
    // 细分种类**不在** FAILURE_CAUSE 里（那枚举是给归因看板分组的，只有 7 格），
    // 它走 keyContext，重试判据读的是那个键而不是 cause。
    assert.equal(x.keyContext.transportKind, 'network');
  });
  test('真·等满超时的归因：`fail` + `product-bug`（这一格登记过"两栏打脸"，本轮做了决定）', async () => {
    /*
     * 这一格从前是一条**钉子**，钉的是"不许被顺手改掉"，而它自己写着：
     * "哪天有人改了它，这条会红，那时他去看上面那段话，就知道要连带改哪三处测试与哪个登记"。
     * 本轮就是那个"哪天"。改前的实测读数（本轮重跑了一次，与登记一致）：
     *   onTimeout='fail'  -> status='fail'  + cause='env-unavailable'   ← 两栏互相打脸
     *   onTimeout='error' -> status='error' + cause='env-unavailable'   ← 作者要的，自洽
     *
     * **决定与它的依据**：`onTimeout` 那三个取值本身就是作者对"等不到算什么"的表态。
     * 想要"算环境问题"的取值就叫 `'error'`（上面那一支），所以选 `'fail'` 的人说的不是环境，
     * 是"这件事没发生，产品就不对"。平台在他明确选了 fail 之后替他改口成环境问题，
     * 正是本仓那一族缺陷的反方向写法：**作者写了一个值，执行侧给出另一个值的结论**。
     *
     * 登记当时给的**两条不改的理由，本轮逐条查过，两条今天都不成立**（这句必须留档，
     * 因为"当时不改"当时是对的 —— 依据烂了才轮得到改）：
     *  1. "被 lang / new-page / responses 三个文件的等待测试钉着" —— 那几处的
     *     `cause === 'env-unavailable'` 钉的是**另一支**（缺 adapter、一次都没问成，
     *     摘要里刻意不出现"等待超时"）。真超时那一支只有这一条测试钉着。本轮改完，
     *     那三组仍全绿（它们绿着才是"改动没越界"的证据，不是靠我读代码说没越界）。
     *  2. "改归因等于改看板分组这个磁盘格式，得连历史抖动的可比性一起考虑" ——
     *     `failure_signatures` 只在 docs/01 的表设计里，`packages/store` 里没有实现，
     *     **今天没有任何一份落盘的归因历史可比**。等有了一份，再回来考虑它。
     *
     * 顺带一条本轮查出来的：这一格其实是**engine 里唯一一处 `fail` 却不归因 product-bug**
     * 的地方（`finish()` 对 fail 的默认归因就是它）。那份显式覆盖是"从前只分
     * continue / 其余"那版代码的残留，三态补齐之后它就孤立了。所以修法是**删覆盖**，
     * 不是加判据。
     *
     * ⚠ 这一改**不动退出码**：`gate.ts` 明写"刻意不按 cause 细分退出码"（理由是
     *   env-unavailable 同时覆盖"没配 adapter"与"环境连不上"，一分就共用一个码）。
     *   所以别把这条测试读成"超时现在换了一个 CI 结论"，它换的是报告上那行归因。
     */
    const r = await run(scen([
      { ...b('a'), kind: 'wait', condition: { type: 'expr', expr: 'false' }, timeoutMs: 300, pollMs: 50, onTimeout: 'fail' },
    ]));
    const x = res(r, 'a');
    assert.equal(x.status, 'fail');
    assert.equal(x.cause, 'product-bug',
      `实际 ${x.cause}：作者选的是 fail（"等不到就是产品不对"），归因不能反过来写"去查环境"。`
      + '想要那个结论的取值是 onTimeout:\'error\'，它在下面那一条测试里有自己的落点');
    assert.match(x.assertionSummary ?? '', /等待超时/);

    /*
     * 反方向的一半：三支里**只有这一支**的归因跟着状态走。另两支各钉一条，
     * 因为把三态压成"看起来都一样"是这一族最常见的回归写法
     * （`error` 那一支当年就是因为和 fail 混在一起才登记的）。
     */
    const e = res(await run(scen([
      { ...b('a'), kind: 'wait', condition: { type: 'expr', expr: 'false' }, timeoutMs: 300, pollMs: 50, onTimeout: 'error' },
    ])), 'a');
    assert.equal(e.status, 'error', 'onTimeout=error 的状态不许跟着变');
    assert.equal(e.cause, 'env-unavailable', '作者显式要求"等不到算环境问题"，这一支自洽，一个字节都不许动');

    const c = res(await run(scen([
      { ...b('a'), kind: 'wait', condition: { type: 'expr', expr: 'false' }, timeoutMs: 300, pollMs: 50, onTimeout: 'continue' },
    ])), 'a');
    assert.equal(c.status, 'pass');
    assert.equal(c.cause, undefined, 'continue 是 pass，没有归因这一栏');

    /*
     * **"一次都没问成"那一支必须还是 error + env-unavailable**，而且摘要里不许出现
     * "等待超时"。这一条和上面那一条是本轮改动最容易互相越界的地方：
     * 两处都在 wait 分支里、都返回归因，把缺 adapter 也一起改成 product-bug 的话，
     * 值班人会去查一个没坏的功能（而那条 SQL 压根没被执行过）。
     */
    const n = res(await run(scen([
      { ...b('a'), kind: 'wait', condition: { type: 'dbRow', sql: 'SELECT 1', datasource: 'main', expect: 'row' }, timeoutMs: 300, pollMs: 50, onTimeout: 'fail' },
    ])), 'a');
    assert.equal(n.status, 'error', '缺 adapter 不是超时，不许跟着本轮这一改变成 fail');
    assert.equal(n.cause, 'env-unavailable', '缺的是平台的口，归因就该是环境');
    assert.ok(!/等待超时/.test(n.assertionSummary ?? ''), `"${n.assertionSummary}"：把"一次都没问"说成"问了没等到"`);
  });
});

describe('同一个错换位置，归因不许变（登记里只记了一个位置）', () => {
  /*
   * 判据是 cause 而不是 status：这几种写法**改前 status 全都一样**（都是 error），
   * 只有归因不同 —— 而断言摘要里那句人话也差不多。只断 status 的测试对这一族
   * 完全没有区分度，所以这一整组的断言只写 cause。
   */
  const positions: Array<[string, StepDraft[]]> = [
    ['set 的 assign.path', [{ ...b('a'), kind: 'set', assign: { r: { path: BAD_PATH } } }]],
    /*
     * 这一格写得绕，两个坑都是实测出来的（`.scratch/probe-cause-pos2.mts`）：
     *  1. `against: '$'` **过不了 schema**（RefSchema 有 min(2)），场景压根建不出来；
     *     而能过的 `$.x` / `$.step.s.vars` 在"源本身取不到"时会先报
     *     「断言源未找到」，走不到 jsonPath 那一支 —— 于是测的不是这一格。
     *  2. `nope` **是一条合法路径**（查不到值 ≠ 路径写坏），它产出的是
     *     "期望非空，实际为空"那种读起来像被测系统返回了空数据的失败。
     *     真正"路径写坏"的形态是 `nope(`（解析期抛 PathError）。
     * 所以这里必须是"能取到源 + 路径真的坏"这两个条件同时成立，否则这一格
     * 测的是"断言没匹配上"，与归因无关。
     */
    ['assert 的 jsonPath', [
      { ...b('s'), kind: 'set', assign: { x: 1 } },
      { ...b('a'), kind: 'assert', against: '$.x', jsonPath: { 'nope(': { notNull: true } } },
    ]],
    ['set 的 assign.expr', [{ ...b('a'), kind: 'set', assign: { r: { expr: BAD_EXPR } } }]],
    ['when 守卫', [{ ...b('a'), kind: 'noop', when: BAD_EXPR }]],
    ['forEach.items', [{ ...b('a'), kind: 'forEach', items: BAD_EXPR, as: 'x', maxIterations: 2, steps: [{ ...b('z'), kind: 'noop' }] }]],
  ];
  test('五处全是 case-stale', async () => {
    for (const [where, body] of positions) {
      const r = await run(scen(body));
      const x = res(r, 'a');
      assert.equal(x.status, 'error', `${where}：实际 ${x.status}`);
      assert.equal(x.cause, 'case-stale', `${where}：实际 ${x.cause}（同一句写坏的东西换个位置就换个归因）`);
    }
  });
  test('等待条件里表达式语法错同归因（wait 这条路登记里没记）', async () => {
    const r = await run(scen([
      { ...b('a'), kind: 'wait', condition: { type: 'expr', expr: BAD_EXPR }, timeoutMs: 500, pollMs: 50, onTimeout: 'fail' },
    ]));
    // 改前这里是 env-unavailable：waitUntil 把异常吞成 evalError 字符串，
    // 再由解释器那个三元无条件判成环境。现在是 case-stale，与 set 里那句同答案。
    assert.equal(res(r, 'a').cause, 'case-stale');
  });
  test('等待条件里引用未定义仍是 case-stale（那条老契约不许被本轮换掉）', async () => {
    const r = await run(scen([
      { ...b('a'), kind: 'wait', condition: { type: 'httpStatus', ref: '$.step.nope.resp', in: [200] }, timeoutMs: 3000, pollMs: 100, onTimeout: 'fail' },
    ]));
    assert.equal(res(r, 'a').cause, 'case-stale');
  });
  test('超过 maxCostUsdPerResolve 是用例自己声明的预算，不是环境', async () => {
    // 这一条是本轮**新加**的归因（原先根本没有类可登记，它落默认分支）。
    // 归错的代价很具体：报告说"环境不可用"，于没人去改那个写小了 10 倍的预算数。
    assert.equal(causeOfError(new LocatorBudgetError(0.2, 0.02)), 'case-stale');
  });
});

describe('causeOfError：那张表本身的每一条', () => {
  test('用例自己写错的那一族 -> case-stale', () => {
    assert.equal(causeOfError(new VarError('引用未定义', '$.a')), 'case-stale');
    assert.equal(causeOfError(new PathError('引用必须以 $ 开头', BAD_PATH)), 'case-stale');
    assert.equal(causeOfError(new ExprError('意外记号', BAD_EXPR)), 'case-stale');
  });
  test('子类跟着父类那一族走（GenKindError 是 VarError 的子类）', () => {
    // 判"覆盖"这件事只有 instanceof 知道，所以表里登记父类就够，不必逐个登记子类。
    assert.equal(causeOfError(new GenKindError('uuidd')), 'case-stale');
  });
  test('平台没接线 / 环境缺配置 -> env-unavailable', () => {
    assert.equal(causeOfError(new NotWiredError('占位')), 'env-unavailable');
    assert.equal(causeOfError(new EnvMissing('没有 baseUrl')), 'env-unavailable');
    assert.equal(causeOfError(new NoConditionAdapter('dbRow', ['db'])), 'env-unavailable');
    assert.equal(causeOfError(new NoNetworkObserver()), 'env-unavailable');
    assert.equal(causeOfError(new NoNewPageObserver()), 'env-unavailable');
  });
  test('返回值恒是 FAILURE_CAUSE 里的词（cause 是磁盘上的封闭枚举，不是自由字符串）', () => {
    for (const e of [new VarError('m', 'v'), new PathError('m', 'p'), new Error('x'), {}, null, undefined, 'str', 7]) {
      const c = causeOfError(e);
      assert.ok((FAILURE_CAUSE as readonly string[]).includes(c), `${String(e)} 得到 "${c}"，不在枚举里 => 磁盘写得出、读不回`);
    }
  });
  test('表里没有重复的类，也没有空 why（那一列是人看的下一步动作）', () => {
    const bases = ERROR_CAUSE_RULES.map((r) => r.base);
    assert.equal(new Set(bases).size, bases.length, '同一个类登记两档归因 => 答案取决于表里的行序');
    for (const r of ERROR_CAUSE_RULES) {
      assert.ok(r.why.length > 20, `${r.base.name} 的 why 太空，这一列的用处是让人知道下一步做什么`);
      assert.ok((FAILURE_CAUSE as readonly string[]).includes(r.cause), `${r.base.name} 的归因不在枚举里`);
    }
  });
});

describe('兜底那格：没登记的新错误类不许被编一个像样的答案', () => {
  /*
   * 改动前兜底是 `env-unavailable`。"新增一个错误类忘了回来登记"于是**静默**：
   * 用例错误被报成"环境不可用"，值班人去查一个不存在的环境问题，
   * 而 CI 照 exit.ts 的 CI_HINT（"5 → 标 error 重试一次"）白重试一遍
   * —— 用例里那条路径不会因为重试而变合法。
   */
  class SomethingNewError extends Error {}
  test('一个全新的错误类 -> untriaged，不是 env-unavailable', () => {
    assert.equal(causeOfError(new SomethingNewError('x')), 'untriaged');
  });
  test('adapter 抛上来的裸 Error / TypeError 也是 untriaged（本轮刻意接受的降级）', () => {
    // 改前是 env-unavailable。要拿到正确归因，得让 adapter 改抛 @atest/engine 的类；
    // 在那之前宁可报"没归因"，不要报"环境问题"这种会让人去查环境的错答案。
    assert.equal(causeOfError(new Error('boom')), 'untriaged');
    assert.equal(causeOfError(new TypeError('x is not a function')), 'untriaged');
  });
  test('非 Error 的抛出物不猜语义', () => {
    for (const v of [undefined, null, 'string', 42, { name: 'VarError' }]) {
      assert.equal(causeOfError(v), 'untriaged', `${String(v)} 不该被认成任何已登记族`);
    }
  });
});

describe('cause 落盘与展示：新常态 untriaged 不能变成裸英文词', () => {
  /** 引擎真产出的 untriaged（adapter 抛裸 Error 是它最常见的来源） */
  const untriagedRun = async (): Promise<RunReport> =>
    run(scen([{ ...b('a'), kind: 'http', request: { method: 'GET', url: 'http://x/y' } }]), {
      http: { async send() { throw new Error('boom'); } },
    });

  test('untriaged 能原样读回磁盘（写盘与读盘是同一套值）', async () => {
    const row = res(await untriagedRun(), 'a');
    assert.equal(row.cause, 'untriaged');
    assert.doesNotThrow(() => parseStepResults([JSON.parse(JSON.stringify(row))]),
      'cause 是 strict schema 上的封闭枚举：新格子没进枚举就是"写得进、读不回"，读盘时才炸');
  });
  test('报告里不印裸枚举词，且每个归因都有中文说法（扫枚举，不抄名单）', async () => {
    for (const cause of FAILURE_CAUSE) {
      const html = toHtmlReport({
        runId: 'r', status: 'error', startedAt: 0, durMs: 0, events: [], outputs: {}, costUsd: 0,
        tally: { pass: 0, fail: 0, error: 1, healed: 0, skipped: 0, triaged: 0 }, summary: 'e',
        results: [{
          stepId: 's', kind: 'http', status: 'error', durMs: 0, retry: 0, healed: false,
          nonReplayable: false, costUsd: 0, keyContext: {}, artifactIds: [], cause,
        }],
      } as never, {});
      // 判据取自**渲染出来的那一格文本**，不是"CAUSE_LABEL 里有没有这个键"：
      // 后者要么导出那份词表（导出它就多一个对外可写的第二份真相），
      // 要么读源码字符串（只能证明字在文件里，证明不了它被渲染出来）。
      const cell = html.match(/归因<\/dt><dd><span class="st[^"]*">([^<]*)</);
      assert.ok(cell, `${cause}：报告里找不到归因那一格（渲染改了？那这一整条测试就什么都测不到了）`);
      assert.notEqual(cell[1]!, cause, `${cause} 原样显示在报告里 —— 等于没告诉值班人下一步做什么`);
      assert.match(cell[1]!, /[一-鿿]/, `${cause} 的标签里没有中文：下一步动作要靠中文那半句给出`);
      // 标签里**可以**出现枚举词本身（`flaky → 看历史抖动` 就是对的写法：
      // flaky 在这个行业里是术语，翻成"抖动"反而没人搜得到）。
      // 所以判据不能写成 `!html.includes(cause)` —— 那样这条测试会因为它写得太对而红。
    }
    const html = toHtmlReport(await untriagedRun(), {});
    assert.match(html, /没归因/, 'untriaged 从"刚失败那一瞬间"变成了常规出口，报告必须说清它的下一步动作');
  });
});

describe('活护栏：@atest/engine 导出的每一个错误类都在那张表上', () => {
  /**
   * **刻意没登记**的类，以及为什么。每条都要写清"为什么到不了判据"，
   * 因为这个名单每加一项都要有人信服一次；写不出理由的那一项就是漏登记。
   */
  const DELIBERATELY_UNREGISTERED: Record<string, string> = {
    PrecompileRefused: '编译期抛（compilePlan 里），压根不在步骤执行路径上，runStep 的 catch 看不见它',
  };

  const exported = Object.entries(engine)
    .filter(([, v]) => typeof v === 'function' && (v as { prototype?: unknown }).prototype instanceof Error)
    .map(([k]) => k);

  test('扫描本身有效（导出的错误类扫到了、且不是空集）', () => {
    // 这三条是护栏的护栏：扫不到东西时下面那条会**恒通过**，
    // 而"恒通过的护栏"比没有护栏更糟 —— 它让所有人以为这件事有人看着。
    assert.ok(exported.length >= 10, `只扫到 ${exported.length} 个导出错误类：barrel 改了或筛选条件失效`);
    for (const must of ['VarError', 'PathError', 'ExprError', 'TransportError', 'NotWiredError', 'LocatorBudgetError']) {
      assert.ok(exported.includes(must), `${must} 没被扫到 => 扫描条件本身坏了，下面那条测试是假的`);
    }
  });
  test('每个导出的错误类：要么被表里某一条覆盖，要么在名单里写明理由', () => {
    const unregistered: string[] = [];
    for (const name of exported) {
      const Ctor = (engine as unknown as Record<string, new (...a: never[]) => Error>)[name]!;
      // 与 causeOfError **用同一个 instanceof**，而不是比类名：子类靠父类那条被覆盖。
      const covered = ERROR_CAUSE_RULES.some((r) => Object.create(Ctor.prototype) instanceof (r.base as never));
      if (!covered && !(name in DELIBERATELY_UNREGISTERED)) unregistered.push(name);
    }
    assert.deepEqual(unregistered, [], '这些错误类会静默落到兜底归因，去 errors.ts 的表里登记它们（或在此写明为什么到不了判据）');
  });
  test('barrel 看不见的错误类也得在表上（那条护栏有盲区，所以补这一条）', () => {
    /*
     * 上面那条扫的是 `Object.entries(engine)`，也就是**从 barrel 可达**的类。
     * 而 `responses.ts` 整个文件没被 `index.ts` 导出，于是 `NoNetworkObserver`
     * 不在那个集合里 —— 它照样会被 throw、照样要归因，只是那条护栏**看不见它**。
     * "护栏的覆盖面 = 某个模块的导出面"这件事本身就是本仓反复的那类缺陷：
     * 覆盖面应由"有哪些东西要管"决定，不该由"哪个文件碰巧被 re-export"决定。
     *
     * 所以这里改成扫 src 里的类声明，父类链在源码里走。它比 instanceof 弱
     * （跨文件继承靠名字对名字），但**覆盖面是全集**，两条一起才没有洞。
     */
    const dir = join(import.meta.dirname, '../src');
    const declared = new Map<string, string>(); // 类名 -> 父类名
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f === 'index.ts' || f === 'env.d.ts') continue;
      const src = readFileSync(join(dir, f), 'utf8');
      /*
       * `abstract` 那个修饰符**曾经不在正则里**，而它不是排版问题。
       * 本轮给 `NoConditionAdapter` / `MissingWaitWorldAdapter` 抽了一个共同祖先
       * `WaitAdapterGap`（abstract），于是这条走链的护栏从那一格起**断链**：
       * `reachesBase('NoConditionAdapter')` 走到 `WaitAdapterGap` 就拿不到父类、
       * 返回 false —— 它红了，而红得**正是它该红的方式**：
       * 那条链自己说了"我走不通时这条测试就退化成比类名"。
       * 换句话说**护栏当场演示了自己为什么存在**。
       * 修的是正则而不是把祖先改成非 abstract：将来任何抽象中间层都会踩同一个洞，
       * 而那个洞的症状是"子类漏登记照样绿"。
       */
      for (const m of src.matchAll(/^export (?:abstract )?class (\w+)[^\n{]*extends (\w+)/gm)) {
        if (m[1] && m[2]) declared.set(m[1], m[2]);
      }
    }
    // 护栏的护栏：扫不到东西 / 扫不到那个已知的盲区类，下面那条就是恒通过
    assert.ok(declared.size >= 10, `只扫到 ${declared.size} 个导出类声明：正则该改了`);
    /*
     * 期望值是 `WaitAdapterGap` 而不是 `NotWiredError` —— 那是本轮抽祖先之后的真值。
     * 这一格仍然是一个**已知具体值**的哨兵（它的职责是"父类是从源码读出来的吗"），
     * 换成两个都接受就等于没断。
     */
    assert.equal(declared.get('NoConditionAdapter'), 'WaitAdapterGap', '父类链扫描失效了（NoConditionAdapter 的父类不是从源码里读出来的）');
    // 抽象祖先自己也要在图上，否则所有子类从它那一跳起全部断链
    assert.equal(declared.get('WaitAdapterGap'), 'NotWiredError', '抽象祖先没进图（正则漏了 abstract？）');

    const bases = new Set(ERROR_CAUSE_RULES.map((r) => r.base.name));
    const reachesBase = (name: string): boolean => {
      let cur = declared.get(name);
      for (let hop = 0; cur && cur !== 'Error' && hop < 8; hop++) {
        if (bases.has(cur)) return true;
        cur = declared.get(cur);
      }
      return false;
    };
    // 链本身在干活：NoConditionAdapter 自己**不是**表里的条目，只有走到 NotWiredError 才算覆盖。
    // 没有这一条，"名字恰好在表上"这种巧合会让下面那条恒通过。
    assert.ok(!bases.has('NoConditionAdapter') && reachesBase('NoConditionAdapter'),
      '父类链没走通：这条测试就退化成"比类名"，子类漏登记照样绿');

    const missed: string[] = [];
    for (const name of declared.keys()) {
      if (!/Error$/.test(name)) continue; // 中断类（*Aborted）不产归因，由下面那条单独管
      if (bases.has(name) || reachesBase(name)) continue;
      if (name in DELIBERATELY_UNREGISTERED) continue;
      missed.push(name);
    }
    assert.deepEqual(missed, [], '这些错误类在 src 里、会被 throw，但不在归因表上，也不在名单里');
  });
  test('名单不养僵尸：条目对应的类若已不存在，这条就该删', () => {
    for (const name of Object.keys(DELIBERATELY_UNREGISTERED)) {
      assert.ok(exported.includes(name), `名单里的 ${name} 已经不在导出里了 —— 僵尸名单会让下一次扫描漏掉真问题`);
    }
  });
  test('被中断的 run 不产出任何带归因的错误行（私有中断类走的是行为，不是源码字面）', async () => {
    /*
     * RunAborted / ExecAborted 是**私有**类，两条扫描护栏都够不着它们。
     * 所以这里不读源码找类声明（那只能证明"字还在文件里"），而是直接跑一次
     * 一开始就被砍断的 run，看结果里**有没有** cause 为 untriaged 的行：
     * 中断不是"某一步失败了"，它不该带着任何归因进入归因看板。
     * 万一有人把这两个类之一交给了 runStep 的 catch，这一条会红 ——
     * 而那正好是"一次取消变成一条看起来合法的用例错误"的形态。
     */
    const r = await runScenario({
      scenario: scen([
        { ...b('a'), kind: 'set', assign: { x: 1 } },
        { ...b('b'), kind: 'set', assign: { y: 2 } },
      ]),
      adapters: {}, clock: deterministicClock(42), signal: { aborted: true },
    });
    for (const x of r.results) {
      assert.notEqual(x.cause, 'untriaged', `步骤 ${x.stepId} 拿到了兜底归因：中断被当成"某一步失败了"`);
    }
  });
});
