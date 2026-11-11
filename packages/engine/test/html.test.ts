/**
 * `report.html` 的两条判据，都是**跑一次真引擎**再解析产物，不是比对字符串：
 *
 *  1. **它是合法 HTML**（用 Python 的 html.parser 做独立解析器，与
 *     junit.test.ts 用 CPython 解析 XML 同一条理由：自己写的转义自己验是循环论证）。
 *     标签错位不是"难看"，是**整页渲染被改写** —— 一个没闭合的 `<table>`
 *     会把后面所有步骤吞进单元格，人看到的就是一个"少了三步"的报告，
 *     而那看起来像"那三步没跑"。
 *  2. **不可信内容只能当文字**。断言摘要里会出现服务端响应原文、错误消息、
 *     页面文本 —— 能控制 API 响应的人就能往"人会用浏览器打开的 HTML"里塞标签。
 *     页脚写着"零脚本"，那必须是真的。
 *
 * 第 2 条的坑在于**很容易测了个假目标**：响应体压根不内嵌（只在 artifacts/ 里指名），
 * 所以往响应体里塞 payload 会得到"页面里没有 <script>"这种**因为压根没渲染而成立**的
 * 假阳性（我第一次就是这么测的）。真正会进 HTML 的是 stepId / assertionSummary /
 * 场景名 / keyContext 的值，payload 必须塞进这些地方。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { run, scen, b, res, type StepDraft } from './helpers.js';
import { toHtmlReport, toJUnitXml, EVIDENCE_FILES, EVIDENCE_MEMBERS } from '../src/index.js';
import type { StepResult } from '@atest/ir';

/** 造一份只含给定 artifactIds 的报告并渲染。多个测试要"看链接长什么样"，共用一份 */
function renderWithArtifacts(ids: string[]): string {
  return toHtmlReport({
    runId: 'r', status: 'pass', startedAt: 0, durMs: 0,
    results: [{
      stepId: 's', kind: 'noop', status: 'pass', durMs: 0, retry: 0, healed: false,
      nonReplayable: false, costUsd: 0, keyContext: {}, artifactIds: ids,
    }],
    events: [], outputs: {}, costUsd: 0,
    tally: { pass: 1, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 }, summary: 'pass',
  }, {});
}

/** 用 Python 的 HTMLParser 检查结构，返回标签计数、错误列表、以及**解析器真看到的属性** */
function inspect(html: string): {
  unclosed: string[]; errors: string[]; tags: Record<string, number>;
  attrs: Array<[string, string, string]>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'atest-html-'));
  const f = join(dir, 'r.html');
  writeFileSync(f, html, 'utf8');
  const script = `
import sys, json, html.parser
VOID = {'meta','br','link','img','input','hr'}
class P(html.parser.HTMLParser):
    def __init__(s):
        super().__init__(); s.stack=[]; s.err=[]; s.tags={}; s.attrs=[]
    def handle_starttag(s, t, a):
        s.tags[t] = s.tags.get(t, 0) + 1
        # convert_charrefs=True（默认）时属性值已实体解码，所以这里看到的是**真值**：
        # 若转义漏了，属性值里就会带着裸引号/尖括号，或者多出一条真属性
        for k, v in a: s.attrs.append((t, k, v if v is not None else ''))
        if t not in VOID: s.stack.append(t)
    def handle_endtag(s, t):
        if t in VOID: return
        if not s.stack: s.err.append("extra_close:" + t)
        elif s.stack[-1] != t: s.err.append("mismatch:want_" + s.stack[-1] + "_got_" + t)
        else: s.stack.pop()
p = P(); p.feed(open(${JSON.stringify(f)}, encoding='utf-8').read())
print(json.dumps({'unclosed': p.stack, 'errors': p.err[:8], 'tags': p.tags, 'attrs': p.attrs}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

test('报告是合法 HTML，且真的零脚本', async () => {
  const report = await run(scen([
    { ...b('a1'), kind: 'set', assign: { n: 1 } } as StepDraft,
    { ...b('a2'), kind: 'assert', against: '$n', expr: '$n == 1' } as StepDraft,
    { ...b('a3'), kind: 'assert', against: '$n', expr: '$n > 99' } as StepDraft,
  ] as StepDraft[]));
  const html = toHtmlReport(report, { suiteId: 'scn.test', scenarioName: 'n', summary: report.summary });
  const out = inspect(html);
  assert.deepEqual(out.unclosed, [], `未闭合标签：${out.unclosed.join(',')}\n${html}`);
  assert.deepEqual(out.errors, [], `标签错位：${out.errors.join(' | ')}`);
  // "零脚本"是页脚上写了对用户的承诺，所以它必须是构造性质而不是"我们转义了"
  assert.equal(out.tags.script ?? 0, 0, '报告里出现了 <script>');
  assert.equal(out.tags.details ?? 0, 0 + 0 + 3, '三条步骤该有三个原生 <details>（展开靠 HTML 而非 JS）');
});

test('注入 payload 只能以文字出现（摘要 / 场景名 / keyContext 三个入口）', async () => {
  // 这四个是**真会进 HTML** 的位置。响应体不在其中（它只在 artifacts/ 里指名）
  const PAYLOAD = `<img src=x onerror="alert('pwned')">`;
  const report = await run(scen([
    { ...b('a1'), kind: 'set', assign: { n: 1 } } as StepDraft,
    { ...b('a2'), kind: 'assert', against: '$n', expr: '$n > 99' } as StepDraft,
  ] as StepDraft[]));
  // stepId **不是**注入面，而且不是因为我们转义了它：IR 的 StepIdSchema 只允许
  // [A-Za-z0-9_-]，塞 payload 会在 defineScenario 那一步就被拒（实测：
  // 「步骤 id 只能是字母/数字/下划线/连字符」）。所以这里只测真会进 HTML 的三处。
  // 场景名与断言摘要也塞一份（summary 走 opts，keyContext 手工造一行结果）
  const evil: StepResult = {
    stepId: 'k1', kind: 'noop', status: 'fail', durMs: 1, retry: 0, healed: false, nonReplayable: false,
    costUsd: 0, artifactIds: [], assertionSummary: `服务端说：${PAYLOAD}`,
    keyContext: { body: PAYLOAD, 'weird"key': 'v' },
  };
  const html = toHtmlReport(
    { ...report, results: [...report.results, evil], summary: `${report.summary} ${PAYLOAD}` },
    { suiteId: 'scn.test', scenarioName: `名字里也有 ${PAYLOAD}`, summary: `${report.summary} ${PAYLOAD}` },
  );

  // 判据 1：结构仍然合法（payload 没把标签结构改掉）
  const out = inspect(html);
  assert.deepEqual(out.unclosed, [], `结构被 payload 破坏：${out.unclosed.join(',')}`);
  assert.deepEqual(out.errors, [], `结构被 payload 破坏：${out.errors.join(' | ')}`);
  // 判据 2：img 计数为 0 —— 转义漏一处这里就会多出一个真 img 标签
  assert.equal(out.tags.img ?? 0, 0, `payload 变成了真标签：\n${html.slice(0, 2000)}`);
  assert.equal(out.tags.script ?? 0, 0);
  // 判据 3：内容**还在**（作为文字）。只验"没变成标签"不够 ——
  // 静默把摘要吞掉会让人以为"这一步没产摘要"，那是另一个失真
  assert.ok(html.includes('&lt;img src=x onerror='), 'payload 应当以转义后的文字保留');
  assert.ok(html.includes('服务端说：'), '断言摘要必须仍然可见');
});

test('链接只指向包内成员；形态不对的 id 只列名不给链接', async () => {
  const HEX_A = 'a'.repeat(64);
  const evil: StepResult[] = [
    { stepId: 'ok', kind: 'noop', status: 'pass', durMs: 1, retry: 0, healed: false, nonReplayable: false, costUsd: 0, keyContext: {}, artifactIds: [HEX_A] },
    // 一个"看着像 id"的字符串。若直接拼进 href，它就是攻击者可控的链接目标
    { stepId: 'bad', kind: 'noop', status: 'pass', durMs: 1, retry: 0, healed: false, nonReplayable: false, costUsd: 0, keyContext: {}, artifactIds: ['javascript:alert(1)'] },
    { stepId: 'bad2', kind: 'noop', status: 'pass', durMs: 1, retry: 0, healed: false, nonReplayable: false, costUsd: 0, keyContext: {}, artifactIds: ['../../etc/passwd'] },
  ];
  const report = await run(scen([{ ...b('a'), kind: 'set', assign: { n: 1 } } as StepDraft]));
  const html = toHtmlReport({ ...report, results: [...report.results, ...evil] }, {});
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
  for (const h of hrefs) {
    assert.match(h, /^\.\/(artifacts\/[0-9a-f]{64}|manifest\.json|junit\.xml|trace\.jsonl|summary\.txt|report\.html)$/,
      `链接越界：${h}\n全部：${hrefs.join(' ')}`);
  }
  assert.ok(hrefs.some((h) => h === `./artifacts/${HEX_A}`), '合法的内容寻址 id 该给出链接');
  assert.match(html, /形态不是内容寻址 id/, '被拒的 id 要**说明为什么没链接**，静默少一个链接会让人以为是渲染 bug');
});

test('白名单是精确相等 + hex 形态，字符串没有第二条路进成员名', () => {
  // 这条测试第一版是**假的**，被变异检查抓出来的：把成员名的正则转义整段删掉，
  // 六条测试全绿。查下去发现不是转义碰巧没被用到，而是 memberHref 的调用方
  // 要么喂 `artifacts/<id>`、要么喂 EVIDENCE_FILES 常量，**没有任何输入能打到
  // 成员名那一支** —— 一条测"转义对不对"的测试在这里永远零覆盖。
  // 处置是改构造（Set 精确相等，见 html.ts 的 SAFE_MEMBERS），让"忘了转义"
  // 这个失败模式**不存在**，然后这条测试改成钉住现在的两个真实面：
  //  1. 结果里的字符串**冒充成员名**：artifactId='manifest.json' 会被调用方
  //     拼成 'artifacts/manifest.json'，两支都不命中 → 无链接。
  //     （这是 memberHref 注释里那句"分工"的真身，不写测试它就只是一句注释。）
  //  2. 成员名那一支**唯一合法入口**是 EVIDENCE_FILES 常量本身（页脚链接），
  //     所以测试直接钉"页脚四条链接都在、且形态全合法"。
  const html = renderWithArtifacts([
    'a'.repeat(64),
    'manifest.json', // 想直接指包内成员：拼完前缀后必须落空
    '../manifest.json',
    'artifacts/../manifest.json',
    'artifacts/' + 'b'.repeat(63) + 'g', // 63 位 + 非 hex：hex 形态必须拒绝
    'ARTIFACTS/' + 'b'.repeat(64),       // 大小写：前缀比较区分大小写
  ]);
  assert.ok(html.includes(`./artifacts/${'a'.repeat(64)}`), '合法 id 该给出链接');
  const hrefs = [...html.matchAll(/href="\.\/([^"]*)"/g)].map((m) => m[1]!);
  for (const h of hrefs) {
    assert.ok(
      /^artifacts\/[0-9a-f]{64}$/.test(h) || ['manifest.json', 'junit.xml', 'trace.jsonl', 'summary.txt', 'report.html'].includes(h),
      `非法成员名出现在链接里：${h}`,
    );
  }
  // 被拒的那几个**列名但不给链接**（静默消失会让人以为是渲染 bug）
  assert.equal((html.match(/形态不是内容寻址 id/g) ?? []).length, 5,
    '5 个非法形态都该被拒并各自说明原因');
  // 页脚链接来自 EVIDENCE_FILES 常量（成员名支的唯一入口），必须四个都在
  for (const m of ['manifest.json', 'junit.xml', 'trace.jsonl', 'summary.txt']) {
    assert.ok(hrefs.includes(m), `页脚缺同包链接 ${m}`);
  }
});

test('keyContext 在页面上已脱敏（与 JUnit 同一套规则，同一次运行）', async () => {
  // 这条测试是**变异检查补出来的**：把 html.ts 里的 redactForDisk 调用删掉，
  // 原来那 6 条测试全绿 —— 也就是"报告里躺着明文密钥"这个后果没人守着。
  // 而 html.ts 的注释里恰恰写着"在这里脱敏而不是指望调用方传已脱敏的对象"，
  // 一句写在注释里的纪律 + 一条测不出它的测试，比没写更危险（它会让人以为有闸）。
  //
  // 判据取**与 JUnit 对同一份 RunReport 的输出相比**，理由两条：
  //  - 只验"HTML 里没有明文"可能测了个假目标（这个场景本来就没产密钥）；
  //  - 只验占位符存在，又分不清"HTML 自己脱了"还是"两边都靠上游"。
  //    两边同源同规则才是这里要的性质：**密钥只在序列化那一刻被处理一次**。
  const SECRET = 'p@ssw0rd-actual-value';
  const report = await run(scen([
    { ...b('a1'), kind: 'set', assign: { n: 1 } } as StepDraft,
  ] as StepDraft[]));
  const leaky: StepResult = {
    stepId: 'k1', kind: 'noop', status: 'fail', durMs: 1, retry: 0, healed: false, nonReplayable: false,
    costUsd: 0, artifactIds: [],
    // 字段名命中规则表（password），值形态也命中（JWT 三段）—— 两条规则各测一头
    keyContext: { password: SECRET, body: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop' },
  };
  const withLeak = { ...report, results: [...report.results, leaky] };
  const html = toHtmlReport(withLeak, {});
  const junit = toJUnitXml(withLeak, {});

  for (const [name, out] of [['html', html], ['junit', junit]] as const) {
    assert.ok(!out.includes(SECRET), `${name} 里出现了明文口令`);
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0'), `${name} 里出现了未脱敏的 JWT`);
    assert.match(out, /已脱敏\(\d+ 字符\)|\[已脱敏\]/, `${name} 里既无明文也无占位符 —— 那是把字段静默吞了，比泄露更难发现`);
  }
  // 长度要留着（"这个字段是空的还是有值"是排障关键信息，而长度不泄露内容）。
  // 这条只在 HTML 上验：它证明 HTML 走的是 redactForDisk 而不是"整段抹掉"这种偷懒实现
  assert.ok(html.includes(`已脱敏(${SECRET.length} 字符)`), '脱敏后应保留长度');
});

test('非内容寻址的 id 在页面上明说，而不是截成"看着像 sha"的样子', async () => {
  // 同样是变异检查补出来的：把 shortId 的形态校验删掉（统一 slice(0,12)），
  // 原来那条测试照样绿 —— 因为它只验"没有链接"，没验**列出来的那段名字长什么样**。
  // 而截断后的 `javascript:a` 摆在 <code> 里，与一个真 sha 前缀**长得一样**，
  // 人拿着它去 artifacts/ 下找会找不到，并怀疑是清理任务删了 —— 把"形态不对"
  // 伪装成"文件丢了"是指向错误下一步动作的那类失真。
  const html = renderWithArtifacts(['javascript:alert(1)']);
  assert.match(html, /<code>非内容寻址 id<\/code>/, '要直说形态不对');
  assert.ok(!html.includes('javascript:a'), '不能把非 id 字符串截成看着像 sha 的样子');
});

test('属性位置不接收不可信文本（转义纪律的**构造性**防线）', async () => {
  // 这条**杀不掉**"htmlAttr 不转引号"那个变异体，而且这是如实的：
  // 现在没有任何不可信字符串进属性位置 —— href 过白名单（memberHref），
  // title 取的是 STATE 表里的中文，class 取的是表里的 token。
  // 所以"漏转义引号"在今天**没有可达输入**，为它写一条测试只能靠把 payload
  // 硬塞进属性，而那需要改产品代码去制造一个洞 —— 那是为了让测试好看而放水。
  //
  // 于是这里守的是**让 h2 变得有危害的那次改动**：哪天有人写
  // `title="${esc(r.assertionSummary)}"`（esc 不转引号！），属性就能提前闭合。
  // 那一行 diff 会让下面这个扫描立刻变红，而它现在为绿是因为构造成立，
  // 不是因为转义正确 —— 这两种"绿"必须分清，所以注释写在这。
  const MARK = 'pwned" onerror="x';
  const report = await run(scen([{ ...a1Draft() }] as StepDraft[]));
  const evil: StepResult = {
    stepId: 'k1', kind: 'noop', status: 'fail', durMs: 1, retry: 0, healed: false, nonReplayable: false,
    costUsd: 0, artifactIds: [], assertionSummary: MARK, keyContext: { note: MARK },
  };
  const html = toHtmlReport(
    { ...report, results: [...report.results, evil] },
    { scenarioName: MARK, summary: MARK, suiteId: MARK },
  );
  /*
   * 判据走**真解析器**而不是正则。这条是踩出来的：第一版我拿
   * `/([A-Za-z-]+)="([^"]*)"/g` 扫整份文档，结果它**红了** —— 不是产品有问题，
   * 是判据有问题：esc 有意不转 `"`（正文里的引号不危险），所以 payload
   * 作为**文字**留在 <dd> 里时，那段 `pwned" onerror="x` 在原文上长得就像一条属性。
   * 正则分不清"属性"与"长得像属性的正文"，HTMLParser 分得清。
   * （判据写错的这条比产品写错更难查，因为报错信息看起来像在指控产品有漏洞。）
   */
  const out = inspect(html);
  for (const [tag, name, value] of out.attrs) {
    assert.ok(!value.includes('pwned'), `${tag}[${name}] 的属性值里出现了 payload —— 它从正文跑进属性了：${value}`);
    assert.ok(!name.includes('onerror') && !name.startsWith('on'),
      `解析器看到了事件处理器属性 ${tag}[${name}] —— 属性被提前闭合过`);
  }
  // 内容本身仍然以文字在页面上（不是被吞掉）。吞掉也是一种"没有漏洞"，
  // 但那会让人以为"这类内容不进报告"，是另一种失真 —— 所以两头都要钉。
  assert.ok(html.includes('pwned'), 'payload 应作为文字保留');
});

/** 一条最小可通过的场景步骤（多条测试共用，避免每处重抄一遍 set） */
function a1Draft(): StepDraft {
  return { ...b('a1'), kind: 'set', assign: { n: 1 } } as StepDraft;
}

test('页脚的同包链接与 EVIDENCE_MEMBERS 同步（加成员不用改三处）', async () => {
  // 这条钉的是**派生**这件事本身。页脚那份清单原先是手抄的四个名字，
  // 而本轮加 report.html 时它就少了一格 —— 症状不是报错，是"页面上少一个链接"，
  // 与它同类的还有 CLI 那句 `evidence show` 的用法提示（同样手抄、同样漏了 html）。
  // 现在两处都从 EVIDENCE_MEMBERS 派生，所以判据必须是"成员集合 == 页面链接集合"，
  // 而不是"这四个名字在不在"（后者对手抄和派生给出同样的绿，等于没测）。
  const report = await run(scen([{ ...a1Draft() }] as StepDraft[]));
  const html = toHtmlReport(report, {});
  const hrefs = new Set([...html.matchAll(/href="\.\/([^"]*)"/g)].map((m) => m[1]!));
  // 除自己以外的全部成员都要有链接
  const want = EVIDENCE_MEMBERS.filter((n) => n !== EVIDENCE_FILES.html);
  for (const m of want) assert.ok(hrefs.has(m), `页脚缺同包链接 ${m}（成员清单与渲染脱节了）`);
  assert.ok(!hrefs.has(EVIDENCE_FILES.html), '不该给本页自己做一个链接');
  // 反向：页面上不该出现成员清单之外的链接（防止有人往 hrefs 里加硬编码项）
  for (const h of hrefs) {
    assert.ok(EVIDENCE_MEMBERS.includes(h), `页脚出现了不在成员清单里的链接：${h}`);
  }
  /*
   * **这条测试的边界要说清**（两步变异实测出来的）：
   *  - 把页脚退回手抄的四个名字，测试**仍然绿** —— 因为今天那四个恰好就是全部成员，
   *    两种写法在这一刻行为相同。所以它**不是在验"代码是派生的"**。
   *  - 再往 EVIDENCE_FILES 加第 6 个成员（模拟"下次加成员忘了改页脚"），测试**变红**。
   * 也就是说它守的是**漂移发生的那一刻**，而不是"写法必须派生"。
   * 这正是我要的那条：派生只是手段，"加了成员页面自动跟上"才是要的性质。
   * 别把它读成"已经保证不会有人手抄"—— 那种性质只能靠不导出可写的清单来保证。
   */
});

test('六态之外的状态不会静默借用别人的颜色', async () => {
  // stateOf 的兜底分支（未知状态）在真实 RunReport 里不可达（status 是 zod 枚举），
  // 但它**写着**，所以要么它有用、要么它是死代码 —— docs/14 §4.7 说的是后者要删。
  // 这条测试的作用是把它钉成"有行为的兜底"：未知状态要显示**原词**并落到中性 token，
  // 而不是映射到 pass 的绿（把未知当通过是本仓禁止的那类读法）。
  const weird: StepResult = {
    stepId: 'w1', kind: 'noop', status: 'exploded' as StepResult['status'], durMs: 0, retry: 0,
    healed: false, nonReplayable: false, costUsd: 0, keyContext: {}, artifactIds: [],
  };
  const report = await run(scen([{ ...b('a'), kind: 'set', assign: { n: 1 } } as StepDraft]));
  const html = toHtmlReport({ ...report, results: [weird] }, {});
  assert.ok(html.includes('exploded'), '未知状态要原样显示，不要猜一个中文标签');
  assert.ok(!/st-pass[^"]*"[^>]*>✓ exploded/.test(html), '未知状态不能借 pass 的绿与勾');
});

test('healed 不显示成绿（六态色 + 图标 + 文字三重编码）', async () => {
  // docs/13 §2：自愈必须与通过可辨 —— "自愈当通过"是 docs/00 §5.6 明令禁止的读法。
  // 只验 CSS 变量名不够（那会随重构漂移），所以验**页面上有中文状态名**：
  // 灰度打印与色盲用户能读到的就是这一层
  const healedRow: StepResult = {
    stepId: 'tap1', kind: 'tap', status: 'healed', durMs: 5, retry: 0, healed: true, nonReplayable: false,
    costUsd: 0, keyContext: {}, artifactIds: [], assertionSummary: '靠新定位器通过',
  };
  const report = await run(scen([{ ...b('a'), kind: 'set', assign: { n: 1 } } as StepDraft]));
  const html = toHtmlReport({ ...report, results: [...report.results, healedRow] }, {});
  assert.match(html, /自愈待审/, 'healed 要有自己的中文状态名');
  assert.match(html, /st-healed/, 'healed 要用自己的色 token，不能借 pass 的绿');
  // 六态各自要有**图标 + 中文**（不只是颜色）。判据是"页面上真找得到这些字符串"：
  // 只验 CSS 变量名会随重构漂移，而灰度打印/色盲用户能读到的正是文字那一层。
  // 造一行结果走一次真渲染，比导私有常量强 —— 导出的那张表没被用到也会绿。
  const rows: StepResult[] = (['pass', 'fail', 'error', 'healed', 'skipped', 'triaged'] as const).map((status) => ({
    stepId: `s_${status}`, kind: 'noop', status, durMs: 0, retry: 0, healed: false, nonReplayable: false,
    costUsd: 0, keyContext: {}, artifactIds: [],
  }));
  const all = toHtmlReport({ ...report, results: rows }, {});
  const seen = [...all.matchAll(/<td class="st st-[a-z]+[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]!.trim());
  assert.equal(seen.length, 6, `六行状态都该渲染出来，实际 ${seen.length}：${seen.join(' | ')}`);
  assert.equal(new Set(seen).size, 6, `状态必须互不相同（图标+文字三重编码），实际：${seen.join(' | ')}`);
  for (const one of seen) assert.match(one, /^[^\x00-\x7f]+|[!✓⚕⊘◐]/, `状态缺图标或缺文字：${one}`);
});

test('容器步骤不出行、子场景另起一段且明说不计数', async () => {
  const report = await run(scen([
    { ...b('seq1'), kind: 'sequence', steps: [{ ...b('inner'), kind: 'set', assign: { n: 1 } } as StepDraft] } as StepDraft,
  ] as StepDraft[]));
  const html = toHtmlReport(report, {});
  // 判据是**与 JUnit 同一个答案**，而不是"我以为容器会藏子步骤"。
  // report.ts 过滤看的是 `isContainer(r.kind)`：seq1 的 kind 是 sequence => 不出行；
  // inner 的 kind 是 set，它是**叶子**，JUnit 里照样有一条 testcase。
  // 我第一版断言写的是"inner 不该出行"，那是我在给页面定一条比 JUnit 更严的规则 ——
  // 那样两边用例数就对不上了，正是这个文件别处警告的那个症状。
  assert.ok(!html.includes('<code>seq1</code>'), '容器自己不该出行（kind=sequence）');
  assert.ok(html.includes('<code>inner</code>'), '容器里的叶子步骤要出行 —— JUnit 里有它');
  // 直接把两份产物的用例数对到一起：这是"同一个答案"唯一可信的证法
  const junitNames = [...toJUnitXml(report).matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  const htmlNames = [...html.matchAll(/<code>([A-Za-z0-9_-]+)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(htmlNames)].filter((n) => junitNames.includes(n)).sort(),
    junitNames.filter((n) => n !== report.runId).sort(),
    `HTML 与 JUnit 的行不一致。HTML=${htmlNames.join(',')} JUnit=${junitNames.join(',')}`);

  const child = scen([{ ...b('c_inner'), kind: 'set', assign: { z: 1 } } as StepDraft], { id: 'sub.child' });
  const childReport = toHtmlReport({
    ...report,
    /*
     * status/tally/costUsd/durMs 是本轮 ChildRun 新加的字段（证据清单的 children 要用，
     * 见 interpreter.ts 那条注释：从 results 反推会丢 resultBoundary 与 setupBroke）。
     * 这里如实照子场景的实况填。calledById 用**父**场景 id —— scen() 造的父场景
     * 恒为 'scn.test'，所以这个夹具里父子 id 会撞；这条测试判的是
     * "子场景那一段自证不双算"，与作用域查找无关，撞了也不影响它。
     * （真正管作用域的夹具在 call.test.ts，那里父子 id 是分开的。）
     */
    childRuns: [{
      callStepId: 'k1', ref: 'sub@1', scenario: child, results: [res(report, 'inner')],
      status: 'pass', tally: { pass: 1, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 },
      costUsd: 0, durMs: 0, calledById: 'scn.test',
    }],
  }, {});
  assert.match(childReport, /不计入上面的用例数/, '子场景那一段必须自证不双算，否则页面用例数与 CI 对不上');
});

test('被中断的 run：横幅不绿，且页面上有"被中断"的文字（第四个消费者）', async () => {
  /*
   * 同一个假绿在这一轮被修了四处：退出码、summary.txt 首行、manifest.status + 文件名、
   * 然后是**这个页面** —— 而它是人第一个看的。
   * 改动前 `bannerKind = bad.length ? '' : attn.length ? 'warn' : 'ok'`
   * 对一次"已完成步骤全过、第 3 步被砍"的 run 给出 `ok`：一道绿条。
   *
   * 两条判据各管一半：**颜色**（banner 的 class）与**文字**（徽章）。
   * 只验颜色等于没验 —— 灰度打印、色盲用户、把截图贴进聊天窗口都丢掉颜色那层，
   * 这与上面 healed 那条的三重编码是同一条纪律。
   */
  const report = await run(scen([{ ...b('a'), kind: 'set', assign: { n: 1 } } as StepDraft]));
  assert.equal(report.status, 'pass', '夹具要拿一份"已完成步骤全过"的报告，否则测的是别的东西');

  const cut = toHtmlReport({ ...report, aborted: { kind: 'timeout', reason: '运行超时（1000ms）' } }, {});
  assert.match(cut, /class="banner warn"/, '被中断的横幅不该是绿的');
  assert.ok(!/class="banner ok"/.test(cut), cut.slice(0, 400));
  assert.match(cut, /被中断/, '文字也要说出来（颜色会丢）');
  assert.match(cut, /运行超时/, '成因要写在页面上，别让人再去翻 summary');
  // **状态胶囊仍然是"通过"**：那是已完成步骤的结论，改成"执行异常"就是伪装成某一步坏了
  assert.match(cut, /st-pass[^>]*>✓ 通过/, 'report.status 不该被中断改写（见 RunReport.aborted）');

  // 对照组：正常 run 不挂徽章、横幅照旧绿（否则"被中断"这个信号会因为到处都是而失效）
  const clean = toHtmlReport(report, {});
  assert.match(clean, /class="banner ok"/, '正常 run 的横幅该是绿的');
  assert.ok(!/被中断/.test(clean), '没中断时页面上不该出现这个词');
});
