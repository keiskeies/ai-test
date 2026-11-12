/**
 * **散文**（`assertionSummary` / `report.summary`）落盘时的值形态脱敏。
 *
 * ## 为什么单开一个文件
 *
 * 仓里原来有两条脱敏钉子，判据都是 **keyContext**（结构化那条路）：
 *  - `html.test.ts`「keyContext 在页面上已脱敏」；
 *  - `store/evidence.test.ts`「喂进真密钥：解开的包里搜不到它」。
 * 两条都绿着，而**散文那条路一个消费者都没有**。实测改动前的同一次 run：
 *
 * ```
 * 断言摘要 = $.data: 期望精确等于 "nope"，实际 "AKIAIOSFODNN7EXAMPLE"
 * report.html   含明文 AKIA   junit.xml  含明文 AKIA   summary.txt  含明文 AKIA
 * trace.jsonl   干净（它走 redactForDisk）
 * ```
 *
 * 也就是"证据包搜不到密钥"这句话只对了一半 —— 而证据包是**给多人下载**的。
 * 最典型的来路不是人手写密钥进用例（那条 lint 会拦），而是**断言把实际值抄进摘要**：
 * `assertions.ts` 里 `exact` / `eq` / `gt` 那一族全都写 `实际 ${String(actual)}`，
 * 而 `actual` 十有八九来自响应体。后端把 AWS key 放在叫 `data` 的字段里，
 * 一句普通的"这个字段应该等于 X"就把密钥抄进了三个磁盘成员。
 * （`REQUEST_SCHEMA_MISMATCH` 那条更直白：摘要就是 `violations.join('; ')`，
 *  而 adapter 的 violation 文案带实际值 —— 那一步压根还没发消息就 error 了，
 *  摘要却把值抄满，并且这条**不是** report-only，它必定进磁盘。）
 *
 * ## 三个出口都要过，所以判据是"三份产物逐个查"
 *
 * `html.ts` 的 `esc`、`report.ts` 的 `xmlSafe`、`summaryText` 的 `plainSafe`。
 * 只查一份的话，另外两份漏了没人知道 —— 那正是本轮之前的情形（一份干净、三份漏）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { b, scen, run, stubHttp, type StepDraft } from './helpers.js';
import { toHtmlReport, toJUnitXml, toTraceJsonl, summaryText, redactSecretText, type AdapterRegistry, type EvidenceManifest } from '../src/index.js';

/** 真 AWS access key 形态（值形态规则表里第二条）。不是编的形状：AKIA + 16 位大写 */
const AKIA = 'AKIAIOSFODNN7EXAMPLE';
/** 一条**无辜**的实际值：用来证明"这一列确实渲染出来了"（见下面那条正向对照） */
const BENIGN = 'benign-actual-value-123';

/**
 * 一次真引擎运行：一条 http 拿到带密钥的响应体，一条断言把两个响应字段当实际值比。
 *
 * **不用手搭 StepResult**：手搭的那份"泄漏"是我自己塞进去的，
 * 而这里要钉的性质是**正常跑一条用例就会泄漏**。响应体 -> 断言的 `actual`
 * -> `assertionSummary` -> 三个磁盘成员，这一整条链都得是真的。
 *
 * 两个值必须在**同一条断言**里（一开始写成两条，第二条压根没跑 ——
 * 断言失败会短路后面的步骤，于是"无辜值"根本没进任何产物，
 * 正向对照红了一条才发现）。`jsonPath` 里两格都不成立时，摘要是一句
 * `$.data: … 实际 "…"；$.note: … 实际 "…"` —— 密钥与无辜值走的是同一句话，
 * 这正是这里要的：**同一条摘要里，一半该脱、一半不该脱**。
 */
async function leakyRun() {
  const body = `{"data":"${AKIA}","note":"${BENIGN}"}`;
  const report = await run(
    scen([
      { ...b('hit'), kind: 'http', request: { method: 'GET', url: 'http://x/a' } } as StepDraft,
      { ...b('v'), kind: 'assert', against: '$.step.hit.body', jsonPath: { data: { exact: 'nope' }, note: { exact: 'nope' } } } as StepDraft,
    ]),
    {
      // `satisfies AdapterRegistry` 而不是两个 `as never`：cast 掉之后，端口加必选方法
      // 时这里编译照过、运行时才炸，而本文件的失败会写着"产物里有明文"——
      // 一个形状问题伪装成脱敏问题（本轮 HttpExec 加 composeUrl 时正是这个现象）
      adapters: {
        http: stubHttp(async () => ({
          status: 200, headers: {}, body: JSON.parse(body), bodyText: body, bytes: body.length, truncated: false, durationMs: 2,
        })),
        // 给一个 store，免得 ARTIFACT_STORE_MISSING 那句把"这条 run 正常吗"混进来
        artifactStore: { async save() { return 'a'.repeat(64); }, async load() { return undefined; } },
      } satisfies AdapterRegistry,
    },
  );
  // 夹具自检（三条，缺一条后面那些断言就可能测在假目标上）：
  //  1. 断言**真的**因为"实际值不等于期望"而失败 —— 否则摘要压根不带实际值，
  //     "产物里没有明文"会因为"本来就没有"而成立，那是假绿的标准形状；
  const sum = report.results[1]!.assertionSummary ?? '';
  assert.match(sum, /实际/, `夹具要让摘要带上实际值：${sum}`);
  //  2. 带进摘要的那个值**真的**是密钥形态（而不是"我以为是密钥形态"）；
  assert.match(sum, new RegExp(AKIA), '夹具要让带进摘要的那个值真的是密钥形态');
  //  3. 无辜值**也**在这条摘要里（否则正向对照测的是"没渲染"而不是"没脱"）。
  assert.match(sum, new RegExp(BENIGN), `夹具要让无辜值与密钥同处一条摘要：${sum}`);
  return report;
}

/** 最小清单。summaryText 只读 scenario.id / frozen，给这两格就够（其余留空不影响被测那一列） */
const manifest = {
  schemaVersion: '1', runId: 'r', scenario: { id: 'scn.test', frozen: false },
  generatedAt: '', members: [], artifacts: [], children: [], totals: { artifacts: 0, bytes: 0, missing: 0 },
} as unknown as EvidenceManifest;

/** 三个落盘出口 + trace（trace 是**已知的对照组**：它一直是对的） */
function outlets(report: Awaited<ReturnType<typeof leakyRun>>): Array<[string, string]> {
  return [
    ['report.html', toHtmlReport(report, { suiteId: 'scn.test', summary: report.summary })],
    ['junit.xml', toJUnitXml(report, { suiteName: 'scn.test' })],
    ['summary.txt', summaryText(report, manifest)],
    ['trace.jsonl', toTraceJsonl(report.events)],
  ];
}

describe('散文落盘脱敏：三个出口逐个查（一份干净不等于干净）', () => {
  test('断言摘要里的密钥形态不出现在任何一份产物里', async () => {
    const report = await leakyRun();
    for (const [name, text] of outlets(report)) {
      assert.ok(!text.includes(AKIA), `${name} 里出现了未脱敏的 AWS key：证据包是给多人下载的，而 CI 日志人人可读`);
      assert.match(text, /AWS Access Key/, `${name} 里既无明文也无占位符 —— 那是把整段静默吞了，比泄露更难发现（"这个字段是空的还是有值"是排障关键）`);
    }
  });

  test('正向对照：同一份摘要里**不是密钥**的那个实际值照旧可见', async () => {
    // 上面那条可以靠"摘要压根没渲染出来"而成立 —— 那正是本仓写过的
    // "测试通过的原因和它想验的东西无关"。所以这里反过来验：
    // 同一条链路上的另一个值**必须**出现在下面每一份产物里。
    // 它成立，"没有 AKIA"才只可能是脱敏的结果，而不是"这一列没渲染"。
    const report = await leakyRun();
    for (const [name, text] of outlets(report)) {
      assert.ok(text.includes(BENIGN), `${name} 里连无辜的实际值都看不见 —— 那上面那条"没泄漏"是因为没渲染，测的是个假目标`);
    }
  });

  test('CLI 打给用户的那份摘要同样不带走密钥', async () => {
    // summary.txt 与 io.out(summaryText(...)) 是同一个字符串（cli/commands.ts 里
    // 只有一次调用），所以这条测的是**同一条出口**的另一个消费者：
    // CI 日志会把它整段印出来，而 CI 命令日志的留存范围比证据包更大
    const report = await leakyRun();
    const stdout = summaryText(report, manifest);
    assert.ok(!stdout.includes(AKIA));
    assert.match(stdout, /AWS Access Key/);
    assert.ok(stdout.includes(BENIGN), '无辜值仍在 = 这一行确实渲染了');
  });
});

describe('幂等：同一段文字穿过两道出口不会被二次改写', () => {
  test('redactSecretText 对已脱敏的文本是恒等的', () => {
    // html.ts 的 detailOf 先对 keyContext 跑 redactForDisk，再整段过 esc；
    // report.ts 的 JUnit 正文先 JSON.stringify(redactForDisk(keyContext)) 再过 xmlText。
    // 也就是说**占位符本身会再进一次值形态规则**。若占位符的写法撞上某条规则
    // （比如里面含 `eyJ…` 或 `sk-…`），得到的是 «JWT:«JWT:已脱敏»:已脱敏» 这种套娃，
    // 更坏的是"长度信息被吃掉"（html.test.ts 专门钉了"脱敏后应保留长度"）。
    const cases = [
      `实际 ${AKIA}`,
      '令牌 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop 已发出',
      '头 Authorization: Bearer ' + 'a'.repeat(40),
      'key sk-abcdefghijklmnopqrstuvwx',
      '-----BEGIN RSA PRIVATE KEY-----',
      '什么密钥都没有的一行',
    ];
    for (const s of cases) {
      const once = redactSecretText(s);
      assert.equal(redactSecretText(once), once, `二次脱敏改写了文本：${once}`);
    }
  });

  test('keyContext 的字段名脱敏结果再过一次文本规则也不变', () => {
    // 这是**两条规则通路之间唯一的接缝**。redactForDisk 的字段名占位是
    // `«字段 password 已脱敏(11 字符)»` —— 里面有"password"这个词，
    // 而值形态规则表恰好不认字段名（它只认 JWT/AKIA/sk-/私钥/Bearer 五种形态），
    // 所以过第二次是安全的。这条测试钉的就是"恰好"这两个字：
    // 将来往 SECRET_VALUE_RES 里加一条会命中那句中文的规则，这里会先红，
    // 而不是让页面上出现套娃占位符。
    const s = JSON.stringify({ password: 'p@ss-actual', token: AKIA });
    const once = redactSecretText(s);
    assert.equal(redactSecretText(once), once);
    assert.ok(!once.includes(AKIA));
  });

  test('无辜文本一字节不动（脱敏不许顺手改写普通摘要）', () => {
    // 反过来的一半：如果值形态规则误伤普通中文/路径/数字，
    // 报告会开始**说谎**（"实际 200" 变成 "实际 «…»"，人会去查一个不存在的安全问题）
    const plain = [
      'GET 200 2.0ms',
      '$.data: 期望精确等于 "nope"，实际 "benign-actual-value-123"',
      '迭代 2 次，但数据有 5 条 —— 3 条从未被迭代过（撞 maxIterations 上限）',
      '断言通过（3 项）',
    ];
    for (const s of plain) assert.equal(redactSecretText(s), s, `无辜文本被改写：${s}`);
  });
});
