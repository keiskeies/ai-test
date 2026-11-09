/**
 * M6 判据之一：**JUnit XML 能被外部解析器正确解析，且六态映射不撒谎**。
 *
 * 为什么用 Python 的 XML 解析器当判据，而不是自己写断言比对字符串：
 * "能被 Jenkins/GitLab 解析"这条，用我们自己写的导出器的输出去验自己的导出器，
 * 是循环论证 —— 我们输出什么它就"解析"什么。
 * 这里把 XML 交给一个**完全独立的实现**（CPython 的 expat），它说非法就是非法。
 * 同理"count 自洽"这类判据也在解析后的 DOM 上算，不在字符串上算。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { b, run, scen, type StepDraft } from './helpers.js';
import { toJUnitXml, type RunReport } from '../src/index.js';
import type { StepResult } from '@atest/ir';

/** 交给 CPython 解析。返回结构化结果，解析失败时把它的报错原样抛出 */
/**
 * 返回类型里每个字段都必须写出来。
 * 早先漏了 `time`（python 侧其实一直在输出它），于是"time 单位是秒"那条断言
 * 在 `out.time` 上编译不过 —— 而 node --test 用 tsx 跑，**不做类型检查**，
 * 所以它一路绿灯，直到有人单独跑 typecheck:test 才暴露。
 * 这个文件就是"测试文件也要进 tsc"的理由：判据写在类型对不上的字段上，
 * 拼错字段名的断言等于没有断言（它恒为 undefined == undefined）。
 */
function parseXml(xml: string): {
  tests: number; failures: number; errors: number; skipped: number;
  /** suite 上的 time 属性，字符串原样返回：单位与格式正是要验的东西，
   *  在这里 Number() 掉就把 "8" 与 "8000" 变成同一个值了 */
  time: string | null;
  cases: Array<{ name: string; bucket: string; attn: string; type: string; text: string }>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'atest-junit-'));
  const file = join(dir, 'junit.xml');
  writeFileSync(file, xml, 'utf8');
  const script = `
import json, sys, xml.etree.ElementTree as ET
t = ET.parse(${JSON.stringify(file)})
root = t.getroot()
suite = root.find('testsuite') if root.tag == 'testsuites' else root
cases = []
for tc in suite.iter('testcase'):
    bucket = 'pass'
    for tag in ('failure', 'error', 'skipped'):
        if tc.find(tag) is not None: bucket = tag
    node = tc.find('failure') if tc.find('failure') is not None else (tc.find('error') if tc.find('error') is not None else tc.find('skipped'))
    cases.append({'name': tc.get('name'), 'bucket': bucket, 'attn': tc.get('attn') or '',
                  'type': (node.get('type') if node is not None else ''), 'text': (node.text or '') if node is not None else ''})
out = {'tests': int(suite.get('tests')), 'failures': int(suite.get('failures')),
       'errors': int(suite.get('errors')), 'skipped': int(suite.get('skipped') or 0),
       'time': suite.get('time'), 'cases': cases}
print(json.dumps(out))
`;
  const stdout = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

/** 手工造 RunReport。用真实 runScenario 造不出 healed/triaged（那要 P2 的自愈与人工 triage） */
function rep(results: Array<Partial<StepResult> & { stepId: string; status: StepResult['status'] }>, over: Partial<RunReport> = {}): RunReport {
  const full: StepResult[] = results.map((r) => ({
    kind: 'assert', durMs: 1200, retry: 0, healed: r.status === 'healed', nonReplayable: false,
    assertionSummary: `${r.stepId} 的摘要`, keyContext: {}, costUsd: 0, artifactIds: [], ...r,
  } as StepResult));
  const tally = { pass: 0, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 };
  for (const r of full) tally[r.status as keyof typeof tally]++;
  return {
    runId: 'run_x', status: 'fail', startedAt: Date.UTC(2026, 0, 2, 3, 4, 5), durMs: 8000,
    results: full, events: [], outputs: {}, costUsd: 0.02, tally, summary: 'fail · 摘要', ...over,
  };
}

test('XML 合法（外部解析器不报语法错）', () => {
  const r = rep([{ stepId: 'a', status: 'pass' }, { stepId: 'b', status: 'fail' }]);
  const out = parseXml(toJUnitXml(r));
  assert.equal(out.tests, 2);
});

test('计数自洽：tests == failures + errors + skipped + 通过数', () => {
  const r = rep([
    { stepId: 'p', status: 'pass' }, { stepId: 'f', status: 'fail' },
    { stepId: 'e', status: 'error' }, { stepId: 's', status: 'skipped' },
  ]);
  const out = parseXml(toJUnitXml(r));
  const passed = out.cases.filter((c) => c.bucket === 'pass').length;
  assert.equal(out.tests, out.failures + out.errors + out.skipped + passed, 'sum != tests 时 GitLab 显示 0/0，CI 于是永远绿');
  assert.equal(out.failures, 1);
  assert.equal(out.errors, 1);
  assert.equal(out.skipped, 1);
});

test('fail -> <failure>，error -> <error>（两者必须分开）', () => {
  const out = parseXml(toJUnitXml(rep([{ stepId: 'f', status: 'fail', cause: 'product-bug' }, { stepId: 'e', status: 'error', cause: 'env-unavailable' }])));
  // by[id]! 而不是 by.f：名字来自 XML 属性，取不到就该红，
  // 而不是拿到 undefined 再和字符串比出一个"看起来像样"的失败
  const by = new Map(out.cases.map((c) => [c.name, c]));
  assert.equal(by.get('f')!.bucket, 'failure');
  assert.equal(by.get('e')!.bucket, 'error');
  assert.equal(by.get('f')!.type, 'product-bug', 'type 用 cause：CI 界面把它单独显示一行，"product-bug" 直接告诉值班人找谁');
  assert.equal(by.get('e')!.type, 'env-unavailable');
});

test('healed 默认判 <failure>（JUnit 没有软失败这一桶，绝不能映射成通过）', () => {
  const out = parseXml(toJUnitXml(rep([{ stepId: 'h', status: 'healed' }])));
  const h = out.cases[0]!;
  assert.equal(h.bucket, 'failure', 'healed = 自愈成功但未人审。映射成 pass 就是"绿色构建点错按钮"那个经典事故');
  assert.equal(h.attn, 'healed-unreviewed', '但要用 attn 属性区分开：它不是产品 bug，是要人审');
  assert.equal(out.failures, 1);
});

test('failOnAttention=false 时 healed 降为通过但仍带 attn 标记（纯展示导出不丢信息）', () => {
  const out = parseXml(toJUnitXml(rep([{ stepId: 'h', status: 'healed' }]), { failOnAttention: false }));
  assert.equal(out.cases[0]!.bucket, 'pass');
  assert.equal(out.cases[0]!.attn, 'healed-unreviewed');
  assert.equal(out.failures, 0);
});

test('triaged 判 <skipped>：不算失败也不该算通过', () => {
  const out = parseXml(toJUnitXml(rep([{ stepId: 't', status: 'triaged' }])));
  assert.equal(out.cases[0]!.bucket, 'skipped', '放进 pass 会把已知问题洗成健康');
  assert.equal(out.cases[0]!.attn, 'triaged');
});

test('容器步骤不产出 testcase（否则 tests 大于真实用例数）', () => {
  const out = parseXml(toJUnitXml(rep([
    { stepId: 'fe', status: 'pass', kind: 'forEach' as StepResult['kind'] },
    { stepId: 'a', status: 'pass' }, { stepId: 'b', status: 'pass' },
  ])));
  assert.equal(out.tests, 2, 'forEach 不算一条用例');
  assert.deepEqual(out.cases.map((c) => c.name).sort(), ['a', 'b']);
});

test('time 单位是秒（写成毫秒是最常见的实现错误）', () => {
  const out = parseXml(toJUnitXml(rep([{ stepId: 'a', status: 'pass', durMs: 1500 }])));
  assert.equal(out.time, '8.000', 'suite 8000ms -> 8.000');
  // 单条也验：1500ms -> 1.500
  assert.match(toJUnitXml(rep([{ stepId: 'a', status: 'pass', durMs: 1500 }])), /name="a" time="1\.500"/);
});

test('负 durMs 不产出 time="-1"（部分解析器会拒绝整个 suite）', () => {
  const xml = toJUnitXml(rep([{ stepId: 'a', status: 'pass', durMs: -5 }]));
  assert.match(xml, /time="0\.000"/);
});

test('控制字符被转义而不是写进去（写进去会让整份报告被丢弃）', () => {
  // 0x00-0x08 在 XML 1.0 里**不合法**。响应体/logcat 里出现它们极常见
  const xml = toJUnitXml(rep([{ stepId: 'a', status: 'fail', assertionSummary: 'bad \u0000\u0007 char' }]));
  // 外部解析器必须还能解析
  const out = parseXml(xml);
  assert.equal(out.cases[0]!.bucket, 'failure');
  // 判据：XML 里不能再有裸控制字符（\x00 与 \x07 是样本里那两个），
  // 它们已被转义成 \u0000 这种可见文本 —— 保留可读线索而不是删掉，
  // 删掉会让人看不出"哪个字段混进了二进制"，而那本身就是排查线索。
  // 合法控制字符（tab/LF/CR）不受影响，XML 本来就允许。
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml), 'XML 里出现了裸控制字符，外部解析器会拒绝整份报告');
  assert.match(xml, /\\u0000/);
});

test('测试名里的引号与尖括号不能改写报告结构（注入）', () => {
  const evil = `x" onclick="alert(1)`;
  const xml = toJUnitXml(rep([{ stepId: evil, status: 'fail' }]));
  const out = parseXml(xml);
  assert.equal(out.cases[0]!.name, evil, '解析回来的名字必须**原样**，说明它没能逃出属性');
  assert.ok(!('onclick' in (out.cases[0] as Record<string, unknown>)), '属性被闭合就会产生第二个属性');
});

test('中文与被截断的多字节字符不破坏 XML', () => {
  const xml = toJUnitXml(rep([{ stepId: 'a', status: 'fail', assertionSummary: '订单金额应为 ¥100（含 emoji ）' }]));
  const out = parseXml(xml);
  assert.match(out.cases[0]!.text, /订单金额/);
});

test('artifacts 与 keyContext 出现在失败详情里，且 keyContext 已脱敏', () => {
  const out = parseXml(toJUnitXml(rep([{
    stepId: 'login', status: 'fail', artifactIds: ['aaaa', 'bbbb'],
    keyContext: { password: 'hunter2xyz', url: 'https://x/login' },
  }])));
  const text = out.cases[0]!.text;
  assert.match(text, /artifacts=aaaa,bbbb/);
  assert.match(text, /url/);
  assert.ok(!text.includes('hunter2xyz'), 'keyContext 里的凭证字段绝不能原样进 JUnit —— CI 日志是明文');
});

test('空 results 也产出合法 XML（空套件在 CI 里是"没跑到"，不能是解析失败）', () => {
  const out = parseXml(toJUnitXml(rep([])));
  assert.equal(out.tests, 0);
  assert.equal(out.failures, 0);
});

test('真实运行（跑过的场景）也能导出可解析的 JUnit', async () => {
  const s = scen([
    { ...b('v'), kind: 'set', assign: { n: 1 } },
    { ...b('ok'), kind: 'assert', against: '$n', expr: '$n == 1' },
    { ...b('bad'), kind: 'assert', against: '$n', expr: '$n > 99' },
  ] as StepDraft[]);
  const r = await run(s);
  const out = parseXml(toJUnitXml(r, { suiteName: 'scn.test' }));
  assert.ok(out.tests >= 2, '真实运行的步骤都该在里面');
  assert.equal(out.failures, 1, 'bad 那步是 fail');
});
