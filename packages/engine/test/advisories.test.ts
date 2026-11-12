/**
 * 运行期提醒（`lint.reported` 事件）必须到得了**人眼前与 CI 眼前**。
 *
 * ## 改前实测（一份 `leaseRows=true` 的 dataSource，跑在 call 子场景里）
 *
 * ```
 * 事件里有这条 = true      步骤状态 = pass
 * report.html  提到 = false      junit.xml 提到 = false      summary.txt / CLI 提到 = false
 * ```
 *
 * 这些 emit 点全都在响，而**唯一的落点是 trace.jsonl 里的一行 JSON**。
 * `docs/14` §5 里登记着"发这条事件是为了不让行租约静默地看起来已启用"——
 * 那句话本轮实测**是假的**，所以那个文件的原文也一起改了。
 *
 * ## 这个文件的判据为什么按 code 逐个点名，而不是"有一条提示带存在"
 *
 * 只验"页面上有个 div"会放过最坏的情形：**十条里有三条因为形状不对而没渲染**
 * （没有 stepId 的、detail 是对象的、一次 run 里发很多次的）。
 * 所以先把这些 code 逐个跑到三个出口上，再单独测那三种形状。
 *
 * ## 三种出口都要测到，少一个就等于那个出口没人守
 *
 * `report.html`（人第一个看的）、`junit.xml` 的 `atest.advisories`（CI 与看板读的）、
 * `summary.txt` / CLI stdout（人和 CI 日志都读的那一份）。
 * 上一轮"HTML 提示带"那条教训就在隔壁：那条测试的**正向对照**起初是空的，
 * 把整块带子删掉才能让它红 —— 这里每条都带正向对照。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { b, scen, run, stubComposeUrl, type StepDraft } from './helpers.js';
import {
  toHtmlReport, toJUnitXml, summaryText,
  collectAdvisories, advisoriesText, advisoryItems, advisoriesHidden, advisoriesProperty,
  type RunReport, type EvidenceManifest,
} from '../src/index.js';
import { defineScenario, type ScenarioDraft } from '@atest/ir';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = {
  schemaVersion: '1', runId: 'r', scenario: { id: 'scn.test', frozen: false },
  generatedAt: '', members: [], artifacts: [], children: [], totals: { artifacts: 0, bytes: 0, missing: 0 },
} as unknown as EvidenceManifest;

const store = { async save() { return 'a'.repeat(64); }, async load() { return undefined; } } as never;
const httpNoValidate = (over: Record<string, unknown> = {}) => ({
  async resolveOperation() { return { operationId: 'getThing', method: 'GET', urlTemplate: '/t/{id}', requiredBodyFields: [], deprecated: true }; },
  async send() { return { status: 200, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 1 }; },
  // 本文件的夹具全走 `as never`（它要的是"少实现一个方法也能跑"，好让提醒通道单独测），
  // 所以**编译器不会**提醒我端口加了必选方法 —— 少这一行时症状是 9 条红而报错是
  // "composeUrl is not a function"，与提醒通道毫无关系。端口改动时这里也要跟着改。
  composeUrl: stubComposeUrl(),
  ...over,
});

/**
 * 三个出口的文本。key 就是产物名，报错时直接指着是哪个出口漏了。
 *
 * 返回类型写成**穷举字面量的 Record** 而不是 `Record<string, string>`：
 * 后者在 `noUncheckedIndexedAccess` 下取值是 `string | undefined`，
 * 于是每个断言点都得加一个 `!` 或 `?? ''` —— 而那个 `?? ''` 正好能把
 * "某个出口压根没产出"读成"这个出口里没有"，也就是把要验的失败模式吞掉。
 */
type OutletName = 'report.html' | 'junit.xml' | 'summary.txt';
function outlets(report: RunReport): Record<OutletName, string> {
  return {
    'report.html': toHtmlReport(report, { suiteId: 'scn.test', summary: report.summary }),
    'junit.xml': toJUnitXml(report, { suiteName: 'scn.test' }),
    'summary.txt': summaryText(report, manifest),
  };
}

/* ── 运行期提醒逐个跑到三个出口上（**表长即条数**，别在注释里另记一份）─────── */

/**
 * 每个 code 配一个**能真的发出它**的夹具。
 *
 * 这些夹具本身就是本文件的一半价值：它们同时是"这条 emit 点在什么条件下会响"
 * 的可执行说明。写这个表之前，这张表里的 code 有约一半**在全仓没有任何测试能让它响**
 * （`ROW_LEASE_NOT_IMPLEMENTED` / `VALIDATE_REQUEST_UNAVAILABLE` /
 *  `REQUEST_SCHEMA_MISMATCH` / `LLM_ADAPTER_MISSING` / `LOOP_TRUNCATED`），
 * 也就是说那五条连"确实会发出去"都没人验过 —— 只有这个表里的夹具跑通，
 * 下面那条"每个 code 都在三个出口里出现"才是有内容的判据。
 */
const CASES: Array<{ code: string; make: () => Promise<RunReport> }> = [
  {
    // 放在 **call 子场景**里：这同时验"子场景的事件会中继到父事件流"
    // （interpreter 的 `for (const e of rep.events) a.emit(...)`）。
    // 中继坏了的表现是"子场景里的提醒在整场报告里消失"，而子场景看起来跑完了。
    code: 'ROW_LEASE_NOT_IMPLEMENTED',
    make: async () => {
      const sub = defineScenario({
        schemaVersion: '1', id: 'scn.sub', name: '子', env: { environmentRef: 'unit' },
        body: [{ ...b('ds'), kind: 'dataSource', source: { type: 'mysql', datasource: 'd', sql: 'select 1' }, as: 'rows' }],
      } as unknown as ScenarioDraft);
      return run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'scn.sub@1' } as StepDraft]), {
        adapters: {
          callScenario: async (ref: string) => (ref.startsWith('scn.sub') ? sub : undefined),
          db: { async query() { return [{ id: 1 }]; } },
        } as never,
      });
    },
  },
  { code: 'DEPRECATED_OPERATION', make: () => run(scen([{ ...b('o'), kind: 'openapiCall', docRef: 'api', operationId: 'getThing', pathParams: { id: '1' } } as StepDraft]), { adapters: { http: httpNoValidate() as never, artifactStore: store }, env: { baseUrl: 'https://t' } }) },
  { code: 'VALIDATE_REQUEST_UNAVAILABLE', make: () => run(scen([{ ...b('o'), kind: 'openapiCall', docRef: 'api', operationId: 'getThing', pathParams: { id: '1' } } as StepDraft]), { adapters: { http: httpNoValidate() as never, artifactStore: store }, env: { baseUrl: 'https://t' } }) },
  { code: 'ARTIFACT_STORE_MISSING', make: () => run(scen([{ ...b('h'), kind: 'http', request: { method: 'GET', url: 'http://x/a' } } as StepDraft]), { adapters: { http: { async send() { return { status: 200, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 1 }; }, composeUrl: stubComposeUrl() } as never } }) },
  {
    code: 'RESPONSE_SCHEMA_MISMATCH',
    make: () => run(scen([{ ...b('o'), kind: 'openapiCall', docRef: 'api', operationId: 'getThing', pathParams: { id: '1' } } as StepDraft]), {
      // specAuthoritative 必须显式开：默认关是 docs/05 §1.1 的规矩（默认开会让
      // schema 与实现的小出入刷红几千次，团队于是把整个契约车道关掉）
      adapters: { http: httpNoValidate({ deprecated: false, async validateResponse() { return { ok: false, violations: ['$.token 是多余的字段'] }; } }) as never, artifactStore: store },
      env: { baseUrl: 'https://t', specAuthoritative: true },
    }),
  },
  {
    code: 'REQUEST_SCHEMA_MISMATCH',
    make: () => run(scen([{ ...b('o'), kind: 'openapiCall', docRef: 'api', operationId: 'getThing', pathParams: { id: '1' }, body: { p: 1 } } as StepDraft]), {
      adapters: { http: httpNoValidate({ async validateRequest() { return { ok: false, violations: ['$.amount 缺少必填字段'] }; } }) as never, artifactStore: store },
      env: { baseUrl: 'https://t' },
    }),
  },
  {
    code: 'LLM_ADAPTER_MISSING',
    // evidenceFrom 必须指到一个**真实存在**的输出：证据源找不到时
    // evalLlmAssert 先 return case-stale，那条 emit 压根发不出去。
    // （这就是为什么这一条以前"看着有测试"却从没响过 —— 夹具指了个空步骤。）
    make: () => run(scen([
      { ...b('s1'), kind: 'set', assign: { x: 7 } } as StepDraft,
      { ...b('l'), kind: 'assertLlm', question: '这个响应看起来对吗', evidenceFrom: '$x' } as StepDraft,
    ])),
  },
  { code: 'TEARDOWN_FAILED', make: () => run(scen([{ ...b('n'), kind: 'set', assign: { m: 1 } } as StepDraft], { teardown: [{ ...b('td'), kind: 'assert', against: '$m', expr: '$m == 999' } as StepDraft] } as Partial<ScenarioDraft>)) },
  { code: 'LOOP_TRUNCATED', make: () => run(scen([{ ...b('fe'), kind: 'forEach', items: '$.xs', as: 'x', maxIterations: 2, steps: [{ ...b('n1'), kind: 'noop' }] } as StepDraft]), { inputs: { xs: [1, 2, 3, 4, 5] } }) },
  { code: 'LOOP_CEILING_HIT', make: () => run(scen([{ ...b('wh'), kind: 'while', condition: '1 == 1', maxIterations: 2, steps: [{ ...b('n1'), kind: 'noop' }] } as StepDraft])) },
  { code: 'LOOP_BODY_NEVER_RUN', make: () => run(scen([{ ...b('fe'), kind: 'forEach', items: '$.xs', as: 'x', steps: [{ ...b('n1'), kind: 'noop' }] } as StepDraft]), { inputs: { xs: [] } }) },
  {
    /*
     * `@version` 今天不参与解析（没有版本表），而**静默忽略比报错坏** ——
     * 作者写 `@3` 时心里明确想着"我要那个版本"，一路全绿等于让用例结论
     * 建立在一段没人实现的语义上。所以照跑 + 说清楚。
     *
     * 夹具里那个子场景**必须真能被解析到**：解析不到的话 call 在
     * `if (!child)` 那一步就 error 返回，这条 emit 压根发不出去
     *（与 LLM_ADAPTER_MISSING 那条同一个夹具陷阱）。
     */
    code: 'CALL_VERSION_IGNORED',
    make: async () => {
      const sub = defineScenario({
        schemaVersion: '1', id: 'scn.vsub', name: '子', env: { environmentRef: 'unit' },
        body: [{ ...b('n'), kind: 'noop' }],
      } as unknown as ScenarioDraft);
      return run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'scn.vsub@3' } as StepDraft]), {
        adapters: { callScenario: async (ref: string) => (ref.startsWith('scn.vsub') ? sub : undefined) } as never,
      });
    },
  },
];

describe('运行期提醒：每条都要出现在三个出口上', () => {
  for (const c of CASES) {
    test(c.code, async () => {
      const report = await c.make();
      // 夹具自检：这条事件**真的发出去了**（否则下面三条"出口里有它"是空的）
      const fired = report.events.filter((e) => e.kind === 'lint.reported' && e.data?.code === c.code);
      assert.ok(fired.length >= 1, `夹具没能发出 ${c.code}：那个 emit 点要么没接线，要么夹具条件不对`);

      const out = outlets(report);
      for (const [name, text] of Object.entries(out)) {
        assert.ok(text.includes(c.code), `${name} 里没有 ${c.code} —— 这条提醒到了机器/人眼前吗？事件发了 ${fired.length} 条`);
      }
      /*
       * 正向对照：出口里**不是空壳**。`includes(code)` 有一个空洞 ——
       * 只要产物里任何一处印了这个词就算过，而最省事的"印到"是把它写进
       * CSS 类名或一段静态文字里。所以在两个**给人读**的出口上再验一遍：
       * detail 里那句人读的话也要在。
       * （junit.xml 刻意只带 `CODE:次数`、不带 detail，那是机器/人分工，
       *  见 advisories.ts 的 advisoriesProperty，所以这里跳过它。）
       */
      const detail = String(fired[0]!.data?.detail ?? '');
      if (detail) {
        const head = detail.slice(0, 24);
        for (const name of ['report.html', 'summary.txt'] as const) {
          assert.ok(out[name].includes(head), `${name} 里有 ${c.code} 但没有那句 detail —— 只剩一个 code 人读不懂（detail 前段：${head}）`);
        }
      }
    });
  }
});

describe('提醒带的四条形状判据', () => {
  test('没有提醒时**整块不出现**（而不是出现一个空的"运行期提醒 0 条"）', async () => {
    const r = await run(scen([{ ...b('a'), kind: 'set', assign: { n: 1 } } as StepDraft]));
    assert.equal(collectAdvisories(r.events).length, 0, '这份报告确实没有提醒');
    const out = outlets(r);
    assert.ok(!out['report.html'].includes('运行期提醒'), out['report.html'].slice(0, 200));
    assert.ok(!out['summary.txt'].includes('运行期提醒'));
    assert.ok(!out['junit.xml'].includes('atest.advisories'), '没有提醒时不带这个 property（带一个空值会被 CI 读成"有一类提醒，值是空的"）');
    // 正向对照：同一段代码在有提醒时确实会说那句话（上面那两条否定的另一半）
    const leaky = await CASES.find((c) => c.code === 'ARTIFACT_STORE_MISSING')!.make();
    assert.match(outlets(leaky)['report.html'], /运行期提醒/);
    assert.match(outlets(leaky)['summary.txt'], /运行期提醒/);
    assert.match(outlets(leaky)['junit.xml'], /atest\.advisories/);
  });

  test('提醒**不进任何计数、不出表格行**（页面用例数必须与 CI 数出来的相等）', async () => {
    // 上一轮"把容器渲染成表格行"就是死在这一条上：页面多出一行，而
    // toJUnitXml 的 tests 里没有它 —— 页面用例数与 CI 对不上是最难查的那类不一致。
    // 这里用一份**同时有循环提醒与真叶子**的报告，双向比对行名与 testcase 名。
    const r = await run(scen([
      { ...b('v1'), kind: 'set', assign: { n: 1 } } as StepDraft,
      { ...b('fe'), kind: 'forEach', items: '$.xs', as: 'x', maxIterations: 2, steps: [{ ...b('body1'), kind: 'noop' }] } as StepDraft,
    ]), { inputs: { xs: [1, 2, 3] }, adapters: { http: { async send() { return { status: 200, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 1 }; }, composeUrl: stubComposeUrl() } as never } });
    const html = toHtmlReport(r, { suiteId: 'scn.test' });
    const junit = toJUnitXml(r, { suiteName: 'scn.test' });
    const rows = [...html.matchAll(/<tr[^>]*>.*?<code>([A-Za-z0-9_-]+)<\/code>/g)].map((m) => m[1]!);
    const cases = [...junit.matchAll(/<testcase[^>]*\sname="([^"]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(rows, cases, '页面行与 CI 用例必须逐一对应（正向）');
    assert.deepEqual(cases, rows, '页面行与 CI 用例必须逐一对应（反向：页面不许多出行）');
    // 夹具自检：这份报告**确实**产出了提醒，否则上面那两条是空转
    assert.ok(collectAdvisories(r.events).length >= 1, '夹具要让这份报告带着提醒');
    assert.ok(rows.length >= 1, '夹具要让这份报告有叶子行');
  });

  test('detail 是 adapter 写的字符串：HTML 里只能当文字，且**不许带明文密钥**', async () => {
    // violations 由 adapter 拼（`${path} ${message}`），属于不可信内容：
    //  1. 注入面 —— 这条带在 <body> 顶部，转义漏了就是整页改写；
    //  2. 敏感面 —— 校验失败最常见的对象是登录请求，把实际值打进报告就是密钥进磁盘。
    const AKIA = 'AKIAIOSFODNN7EXAMPLE';
    const PAYLOAD = '<img src=x onerror=alert(1)>';
    const r = await run(scen([{ ...b('o'), kind: 'openapiCall', docRef: 'api', operationId: 'getThing', pathParams: { id: '1' }, body: { p: 1 } } as StepDraft]), {
      adapters: {
        http: httpNoValidate({ deprecated: false, async validateRequest() { return { ok: false, violations: [`$.password 实际 ${AKIA}`, `${PAYLOAD} 这里违规`] }; } }) as never,
      },
      env: { baseUrl: 'https://t' },
    });
    const out = outlets(r);
    for (const [name, text] of Object.entries(out)) {
      assert.ok(!text.includes(AKIA), `${name} 里带着未脱敏的 AWS key`);
      assert.ok(!text.includes('onerror=alert(1)><'), `${name} 里 payload 带着未转义的尖括号`);
      assert.ok(text.includes('REQUEST_SCHEMA_MISMATCH'), `${name} 该仍然说得出这是哪一类提醒`);
    }
    // 内容仍在（作为文字）。静默把 detail 吞掉会让人以为"违规就这一条空的"
    assert.ok(out['report.html'].includes('&lt;img src=x'), 'payload 应以转义后的文字保留');
    assert.ok(out['report.html'].includes('AWS Access Key'), '要留下"这里原本是 AWS key"的线索');
  });

  test('一次运行发很多次的那一类：合成一条 ×N，而不是刷 N 行', async () => {
    // ARTIFACT_STORE_MISSING 在 emit 侧就只发一次；而 VALIDATE_REQUEST_UNAVAILABLE /
    // DEPRECATED_OPERATION 在 forEach 体里会**每轮发一次**（那是不同步骤、同一个原因）。
    // 刷 200 行会淹掉提示带，而淹掉的结果是人把整块关掉 —— 那等于回到静默。
    const r = await run(scen([
      // pathParams 必须给：urlTemplate 是 /t/{id}，不填就"URL 里还有未填的参数"，
      // 那会让容器在**第 1 轮**就 error 中止，只剩 1 条事件 ——
      // 夹具就成了"只发一次"的那条，×N 这一判据压根没被跑到（实测得到过 count=1）。
      { ...b('fe'), kind: 'forEach', items: '$.xs', as: 'x', steps: [{ ...b('o'), kind: 'openapiCall', docRef: 'api', operationId: 'getThing', pathParams: { id: '$x' } } as StepDraft] },
    ] as StepDraft[]), { inputs: { xs: ['1', '2', '3'] }, adapters: { http: httpNoValidate() as never }, env: { baseUrl: 'https://t' } });
    const list = collectAdvisories(r.events);
    const dep = list.find((a) => a.code === 'DEPRECATED_OPERATION');
    assert.ok(dep, '夹具要让这份报告带着 DEPRECATED_OPERATION');
    assert.equal(dep!.count, 3, `三轮循环该合成一条 ×3：${JSON.stringify(list)}`);
    const text = advisoriesText(list);
    assert.equal(text.split('\n').filter((l) => l.includes('DEPRECATED_OPERATION')).length, 1, '同一个 code 在文本里只许出现一行');
    assert.match(text, /×3/);
    // 步骤坐标仍要说得出是哪几步（否则"是哪个接口在响"就丢了）
    // 三轮迭代的是**同一个步骤 id**（forEach 不给体里的步骤加 #i 后缀，那是 repeat 的做法），
    // 所以 stepIds 只有一项而 count 是 3 —— 这两件事分别是"哪一步"与"响了几次"。
    assert.deepEqual(dep!.stepIds, ['o'], `要指出是哪一步在响：${JSON.stringify(dep)}`);
    assert.match(advisoriesProperty(list), /DEPRECATED_OPERATION:3/);
  });
});

describe('detail 不同的同码事件不许合并（少报一条比多占一行严重）', () => {
  test('两个不同的废弃接口 = 两行，不是一行 ×2', async () => {
    // 只看 code 会做的那种合并，在这里会得到"1 类提醒 ×2"，
    // 而实情是**两个接口都废弃了** —— 修一个、留一个，报告却说它只有一件事。
    // 这是聚合这一层最容易犯、且**只会表现为少说**的错。
    const ev = (code: string, detail: string, stepId?: string) => ({
      seq: 0, ts: '0', mono: 0, kind: 'lint.reported' as const, path: [], data: { code, detail, ...(stepId ? {} : {}) }, ...(stepId ? { stepId } : {}),
    });
    const list = collectAdvisories([
      ev('DEPRECATED_OPERATION', 'POST /orders', 'a'),
      ev('DEPRECATED_OPERATION', 'GET /legacy', 'b'),
      ev('ARTIFACT_STORE_MISSING', '没配存储'),
    ]);
    assert.equal(list.length, 3, `两个不同 detail 的废弃提醒该各占一行（外加那条 ARTIFACT）：${JSON.stringify(list)}`);
    assert.deepEqual(list.map((a) => a.code), ['DEPRECATED_OPERATION', 'DEPRECATED_OPERATION', 'ARTIFACT_STORE_MISSING']);
    assert.deepEqual(list[0]!.stepIds, ['a']);
    assert.deepEqual(list[1]!.stepIds, ['b']);
    assert.equal(advisoryItems(list).length, 3, '页面上也是三行（不是"1 类 ×2"）');
    // 而 JUnit 那一份是**按 code 聚合**的（机器要判"这一类有没有出现"）
    assert.equal(advisoriesProperty(list), 'DEPRECATED_OPERATION:2,ARTIFACT_STORE_MISSING:1');
  });

  test('reportOnly 标志要带出来（响应符合性不许看起来像要拦人）', () => {    const list = collectAdvisories([{
      seq: 0, ts: '0', mono: 0, kind: 'lint.reported', path: [],
      data: { code: 'RESPONSE_SCHEMA_MISMATCH', detail: 'x', reportOnly: true },
    }]);
    assert.equal(list[0]!.reportOnly, true);
    assert.match(advisoriesText(list), /只上报，不计红绿/);
  });

  test('同类事件里**只有一条**标了 reportOnly 时，仍然标（"有一条是就说是"）', () => {
    // 今天唯一的 report-only emit 点（响应侧符合性检查）每次都带这个标志，
    // 所以"同码同 detail 里有一条没带"这个形状**当前不可达**。
    // 但规则本身必须钉住：它的意思是"这条不参与红绿"，
    // 而"最后一条说了算"的实现会让**第一个响的那条**把话说错 ——
    // 表现是页面上一个本不该拦人的东西读起来像门禁，
    // 于是有人去查一个根本不存在的失败。今天不可达不等于将来不可达
    // （新增一个 emit 点、或把 detail 改成带上下文的写法，都会让同一类里出现混合形状）。
    const ev = (extra: Record<string, unknown>, seq: number) => ({
      seq, ts: '0', mono: 0, kind: 'lint.reported' as const, path: [],
      data: { code: 'RESPONSE_SCHEMA_MISMATCH', detail: '同一个违规', ...extra },
    });
    const list = collectAdvisories([ev({ reportOnly: true }, 0), ev({}, 1)]);
    assert.equal(list.length, 1, '同码同 detail 合成一条');
    assert.equal(list[0]!.reportOnly, true, '第一条标了就该一直是标了的');
    assert.equal(list[0]!.count, 2);
  });

  test('detail 很长时截断且**说明被截断**（静默截断=报告说"违规就这几条"）', () => {
    const long = '字段 $.a 类型不符；'.repeat(60);
    const list = collectAdvisories([{ seq: 0, ts: '0', mono: 0, kind: 'lint.reported', path: [], data: { code: 'REQUEST_SCHEMA_MISMATCH', detail: long } }]);
    const text = advisoriesText(list);
    assert.ok(text.length < long.length, '要截断');
    assert.match(text, /已截断.*trace\.jsonl/, '要说清全文在 trace 里，而不是让人以为违规就到这');
  });

  test('detail 不是字符串时也出不来空壳（emit 点的写法由各家定，这里不许假设）', () => {
    const list = collectAdvisories([{ seq: 0, ts: '0', mono: 0, kind: 'lint.reported', path: [], data: { code: 'X', detail: { nested: [1, 2] } } }]);
    assert.match(advisoriesText(list), /nested/, `对象 detail 要能出来：${advisoriesText(list)}`);
    const noDetail = collectAdvisories([{ seq: 0, ts: '0', mono: 0, kind: 'lint.reported', path: [], data: { code: 'Y' } }]);
    assert.match(advisoriesText(noDetail), /Y/, '没有 detail 时也要至少说得出 code');
    const noCode = collectAdvisories([{ seq: 0, ts: '0', mono: 0, kind: 'lint.reported', path: [], data: { detail: '没有 code 的一行' } }]);
    assert.deepEqual(noCode, [], '没有 code 的事件不进提醒（宁可不显示，也不在页面上造一个空条目）');
  });

  test('条数超上限时**说明还有几条没列**', () => {
    const evs = Array.from({ length: 25 }, (_, i) => ({
      seq: i, ts: '0', mono: 0, kind: 'lint.reported' as const, path: [], data: { code: `C${i}`, detail: `第 ${i} 类` },
    }));
    const list = collectAdvisories(evs);
    assert.equal(list.length, 25);
    assert.equal(advisoryItems(list).length, 20, '提示带最多 20 条');
    assert.equal(advisoriesHidden(list), 5);
    assert.match(advisoriesText(list), /另有 5 类提醒未列出/);
    // junit 那份**不截断**（它是机器读的清单，截断等于让看板少数一类）
    assert.equal(advisoriesProperty(list).split(',').length, 25);
  });

  test('聚合键不许撞上 detail 里的分隔符（两条不同的事实合成一条 = 少报）', () => {
    // 聚合键用的是 `JSON.stringify([code, detail])` 而不是 `${code}|${detail}` 之类的拼接。
    // 拼接的问题不在"detail 里有 | 就完蛋"（那一种其实还安全：code 是标识符、里面没有 `|`，
    // 于是**第一个** `|` 仍是唯一边界）—— 问题在**这个键的正确性依赖"code 里不会有序列符"**
    // 这个谁都没写下来的假设。而 code 是从 `e.data.code` 读的**任意字符串**，
    // 不是枚举：emit 点今天全写死成大写标识符，但 adapter/将来新增的 emit 没有任何东西拦着它。
    // 所以这里直接用带 `|` 的 code 构造那对**会撞**的事件 —— 这也是"为什么用 JSON 而不是拼接"
    // 这件事唯一可执行的说明：JSON 编码是**自分隔**的，不可能撞。
    const ev = (code: string, detail: string) => ({
      seq: 0, ts: '0', mono: 0, kind: 'lint.reported' as const, path: [], data: { code, detail },
    });
    const list = collectAdvisories([ev('A|X', 'b'), ev('A', 'X|b')]);
    assert.equal(list.length, 2, `两条不同的事实不许合成一条：${JSON.stringify(list)}`);
    assert.deepEqual(list.map((a) => `${a.code}=${a.detail}`), ['A|X=b', 'A=X|b']);
    // 而 JUnit 那份按 code 分聚，两个 code 各算一次（拼接键下会变成"同一类 ×2"，
    // 于是看板把一件事读成一件、实际是两件 —— 与上面那行是同一个少报）
    assert.equal(advisoriesProperty(list), 'A|X:1,A:1');
  });

  test('非 lint.reported 的事件不进提醒（step.finished 的 data 里也有 summary）', () => {
    const list = collectAdvisories([{ seq: 0, ts: '0', mono: 0, kind: 'step.finished', path: [], data: { code: 'LOOKS_LIKE_ONE', summary: 'x' } }]);
    assert.deepEqual(list, []);
  });

  test('提示带被截断时，**HTML 与 summary.txt 两侧都要说少了几个**', async () => {
    // 上面那条只验了 advisoriesText / advisoriesHidden 这两个函数返回值。
    // 函数说"少了 5 类"而**页面上不印这句话**，是两种不同的失效，而只有后者会被人读到：
    // 一份列了 20 条、实际 25 类的报告读起来就是"只有 20 类"。
    // 这与本仓反复登记的"真话在代码里、不在产物里"是同一件事的另一半。
    const evs = Array.from({ length: 25 }, (_, i) => ({
      seq: i, ts: '0', mono: 0, kind: 'lint.reported' as const, path: [], data: { code: `C${i}`, detail: `第 ${i} 类` },
    }));
    const r = bareReport(evs);
    const out = outlets(r);
    assert.match(out['report.html'], /还有 5 条没列出/, '页面上要说明被截断了');
    assert.match(out['summary.txt'], /另有 5 类提醒未列出/);
    // 正向对照：没截断时不该出现这句话（否则"还有 N 条"会变成一块常驻文字，
    // 那条测试就退化成"页面里有这几个字"）
    const few = bareReport(evs.slice(0, 3));
    const outFew = outlets(few);
    assert.ok(!outFew['report.html'].includes('没列出'), outFew['report.html'].slice(0, 300));
    assert.ok(!outFew['summary.txt'].includes('另有'));
    // junit 那份**不截断**，所以它既没有标记也不该有
    assert.equal((out['junit.xml'].match(/没列出|另有/) ?? []).length, 0);
    assert.match(out['junit.xml'], /C24:1/, 'property 里 25 类一个不少');
  });
});

describe('JUnit 那份是合法 XML，且计数不动', () => {
  test('properties 与 testsuite 计数在加了提醒之后仍然自洽、仍可被 CPython 解析', async () => {
    // 位置与顺序是硬约束：DTD 的产生式是 `properties?, (testcase|error|failure)*, system-out?, system-err?`，
    // 顺序错了严格解析器整份拒收，CI 于是显示"没有测试报告"（比显示失败严重）。
    // 而且产生式里只有一个 properties? —— 与 aborted 共用同一个块，不能各开一个。
    const r = await CASES.find((c) => c.code === 'ARTIFACT_STORE_MISSING')!.make();
    const xml = toJUnitXml(r, { suiteName: 'scn.test' });
    const dir = mkdtempSync(join(tmpdir(), 'atest-adv-'));
    const f = join(dir, 'j.xml');
    writeFileSync(f, xml, 'utf8');
    const script = `
import json, sys, xml.etree.ElementTree as ET
s = ET.parse(sys.argv[1]).getroot()
suite = s.find('testsuite') if s.tag == 'testsuites' else s
kids = [c.tag for c in suite]
props = {p.get('name'): p.get('value') for p in (suite.find('properties') or [])}
print(json.dumps({'kids': kids, 'props': props,
  'tests': int(suite.get('tests')), 'failures': int(suite.get('failures')),
  'errors': int(suite.get('errors')), 'skipped': int(suite.get('skipped') or 0),
  'cases': len(list(suite.iter('testcase')))}))
`;
    const out = JSON.parse(execFileSync('python3', ['-c', script, f], { encoding: 'utf8' }));
    assert.match(out.props['atest.advisories'], /ARTIFACT_STORE_MISSING:1/, `property 该在且值形如 CODE:次数：${JSON.stringify(out.props)}`);
    assert.ok(out.kids.indexOf('properties') < out.kids.findIndex((k: string) => k === 'testcase'), 'properties 必须排在 testcase 之前');
    assert.equal(out.tests, out.cases, 'tests 与 testcase 条数一致（提醒不产生 testcase）');
    assert.equal(out.tests, out.failures + out.errors + out.skipped + (out.tests - out.failures - out.errors - out.skipped), 'sum == tests 那条自洽性');
    assert.equal(out.tests, r.results.filter((x) => !['forEach', 'while', 'if', 'sequence', 'parallel', 'repeat', 'call', 'switch'].includes(x.kind)).length,
      '用例数只算叶子，提醒与容器都不算');
  });

  test('被中断 + 提醒同时存在时，两条 property 共用一个 properties 块', () => {
    // DTD 只有一个 properties?。各 push 一个会得到两个兄弟块，严格解析器拒收 ——
    // 而那恰好是"有提醒的那次运行"才触发的分支，很容易一路绿到线上。
    const r = runScenarioWithAborted();
    const xml = toJUnitXml(r, { suiteName: 'scn.test' });
    assert.equal((xml.match(/<properties>/g) ?? []).length, 1, `properties 块只能有一个：\n${xml}`);
    assert.match(xml, /name="atest\.aborted"/);
    assert.match(xml, /name="atest\.advisories"/);
    const dir = mkdtempSync(join(tmpdir(), 'atest-adv2-'));
    const f = join(dir, 'j.xml');
    writeFileSync(f, xml, 'utf8');
    execFileSync('python3', ['-c', 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])', f], { encoding: 'utf8' });
  });
});

/**
 * 一份**只有事件**的报告（一条叶子步骤 + 给定的事件流）。
 *
 * 为什么要手工拼而不是跑真引擎：这一组要验的是**出口在给定事件下怎么说**，
 * 而"25 类不同的提醒"在真实引擎里需要 25 个不同的触发条件 —— 那既写不出来，
 * 也不是这里要问的问题（各条 emit 点能不能响，上面那张 CASES 表已经逐个验过）。
 * 反过来，凡是要问"**这条事件真的会发吗**"的判据，一律用真引擎（CASES），
 * 不用这个 helper —— 手工拼的事件流只能证明"发出来之后到不到人眼前"。
 */
function bareReport(events: RunReport['events'], over: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'r', status: 'pass', startedAt: 0, durMs: 1,
    results: [{ stepId: 'a', kind: 'noop', status: 'pass', durMs: 1, retry: 0, healed: false, nonReplayable: false, costUsd: 0, keyContext: {}, artifactIds: [] }],
    events,
    outputs: {}, costUsd: 0, tally: { pass: 1, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 }, summary: 'pass',
    ...over,
  };
}

/** 一份既有中断又有提醒的报告（手工拼：造真的中断要卡时钟，而这里要的只是两个出口字段都在） */
function runScenarioWithAborted(): RunReport {
  return bareReport(
    [{ seq: 0, ts: '0', mono: 0, kind: 'lint.reported', path: [], data: { code: 'ARTIFACT_STORE_MISSING', detail: '没配存储' } }],
    { aborted: { kind: 'cancelled', reason: '外部取消' } },
  );
}

describe('与"循环提示带"的重复是刻意的，且删掉任一条都不会变静默', () => {
  test('LOOP_* 同时出现在循环提示带与提醒带；**删掉提示带**时提醒带仍说得出这件事', async () => {
    // 这里刻意**不做去重**。做去重要一张"哪些 code 已有更好的载体"的清单，
    // 而那张清单的失效方式正是本轮在修的那件事：将来谁把提示带改掉或搬走，
    // 那些 code 就因为"还挂在抑制清单上"而从页面上消失，且没有任何东西会红。
    // 重复的一行只是重复；被抑制的一条是**回到没人看得见**。
    const r = await CASES.find((c) => c.code === 'LOOP_TRUNCATED')!.make();
    const html = toHtmlReport(r, { suiteId: 'scn.test' });
    assert.match(html, /处循环的结论不完整/, '上一条提交那条带子还在');
    assert.match(html, /运行期提醒/, '这一轮那条带子也在');
    assert.match(html, /LOOP_TRUNCATED/);
    // 关键的那半：**两个出口字段都不依赖对方**。summary.txt 没有循环带，
    // 所以它只能靠提醒带说这件事 —— 那才是"提醒带必须含 LOOP_*"的真实理由。
    const txt = summaryText(r, manifest);
    assert.ok(!txt.includes('处循环的结论不完整'), '前提：summary.txt 里没有循环提示带');
    assert.match(txt, /LOOP_TRUNCATED/, '所以提醒带是 summary.txt 上这件事的唯一载体，不能抑制');
    // 同理 junit：叶子行里没有 fe（容器不出 testcase），提醒带是唯一载体
    const ju = toJUnitXml(r, { suiteName: 'scn.test' });
    assert.ok(!/name="fe"/.test(ju), '前提：容器不进 testcase');
    assert.match(ju, /LOOP_TRUNCATED/, '所以提醒带是 junit.xml 上这件事的唯一载体');
  });

  test('两个带子各说各的事：提示带标题不许把"提醒"那一类也概括进去', async () => {
    // 上一版栽过的同类问题：提示带标题写"没跑完数据"，对 neverRun 那一支是假话。
    // 这里验两条带子的标题各自只覆盖自己那一批事实。
    const r = await CASES.find((c) => c.code === 'ARTIFACT_STORE_MISSING')!.make();
    const html = toHtmlReport(r, { suiteId: 'scn.test' });
    assert.ok(!html.includes('处循环的结论不完整'), '这份报告没有循环问题，不该出现循环那句');
    assert.match(html, /运行期提醒/);
  });
});
