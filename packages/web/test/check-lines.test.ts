/**
 * `check-lines.ts` 里那几句**句子**本身。纯 node，不起浏览器。
 *
 * ## 为什么句子的载体不许只放在浏览器测试里
 *
 * `browserTest` 在没有 Chrome 的机器上是 `test.skip`，而 node:test 对全跳过的文件
 * 给 pass 0 / fail 0 / **退出码 0**（`tooling/mutate.mjs` 的 `noTestsIn` 挡的就是这个形状）。
 * 所以"角标那句话有没有说谎"这种判据如果只写在 `dry-run-check.test.ts` 里，
 * 它守没守住取决于一台机器的 `/Applications` 里躺着什么。
 * 分工因此是：**句子在这里测，接线在浏览器测**（那边断"屏幕上真的出现了这句"）。
 *
 * ## 这一族判据的共同形状：一句话的**范围**要比它字面承诺的窄
 *
 * 改前的「引擎没报任何问题」在缺必填输入的当口是假话（`dryRun` 也是引擎，
 * 而它刚报了一条 error），而它旁边那张卡正好写着「缺少必填输入：who」。
 * 下面每一条都在钉"这句话只许在它那一查里被读成通过"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkStatusLines, EMPTY_STATIC_GATE, missingInputHint, SECRET_ROUTE_HINT, STATIC_GATE_PASS, staticGateCardTitle } from '../src/check-lines.js';
import type { CheckResult } from '../src/check.js';
import type { LintCode, LintIssue } from '@atest/engine';

const issue = (level: LintIssue['level'], code: LintCode, message = 'x'): LintIssue => ({ level, code, message });
/** 一份"过 schema、静态闸干净、只缺一个必填输入"的读数形状（内容取自实测夹具，见 dry-run-check.test.ts） */
const cleanMissing = (over: Partial<CheckResult> = {}): CheckResult => ({
  parsed: true, issues: [],
  dry: { ok: false, errors: [issue('error', 'VAR_UNDEFINED', '缺少必填输入：who')], warnings: [],
    issues: [issue('error', 'VAR_UNDEFINED', '缺少必填输入：who')], summary: '✗',
    missingInputs: ['who'], exprSummaries: [], estimate: { steps: 2, minMs: 100, needsDevice: false, targets: ['api'] } },
  canonical: '{}', irSha: 'a'.repeat(64), ...over,
});
const texts = (r: CheckResult): string[] => checkStatusLines(r).map((l) => l.text);

test('缺必填输入时，状态行上**必须有两枚徽章**：静态闸那枚之外还要有一枚说输入', () => {
  /*
   * 这条钉的是本轮补上的那一格。改前只有一枚绿徽章，而那条场景在本地
   * 根本跑不起来 —— 唯一说真话的是屏幕下面一张卡，只扫一眼角标的人会直接走开。
   * "绿徽章 + 红卡片"能接受，"绿徽章 + 没有第二个信号"不能：
   * 那让人以为整个校验只有一个结论。
   */
  const lines = checkStatusLines(cleanMissing());
  const badges = lines.filter((l) => l.kind === 'badge');
  assert.ok(badges.length >= 2, `缺必填输入而状态行只有 ${badges.length} 枚徽章：那句"通过"旁边没有反向信号`);
  assert.ok(badges.some((b) => b.kind === 'badge' && b.status === 'fail' && /必填输入/.test(b.text)),
    `没有一枚徽章说得出"缺输入"这件事：${JSON.stringify(badges.map((b) => b.text))}`);
  // 反向对照：**不缺**输入时那枚徽章必须消失（否则它是一条常驻噪音，会被当成背景）
  const okLines = checkStatusLines(cleanMissing({
    dry: { ...cleanMissing().dry!, ok: true, errors: [], issues: [], missingInputs: [] },
  })).filter((l) => l.kind === 'badge');
  assert.ok(!okLines.some((b) => /必填输入/.test(b.text)),
    `不缺输入而徽章还在：${JSON.stringify(okLines.map((b) => b.text))}。常驻的红徽章等于没有红徽章`);
});

test('静态闸那句"通过"**点名自己的范围**（不让人拿它去质疑一个绿的 CI）', () => {
  /*
   * CI 的退码判据是 `lintScenario` 的 error 数，不含 dry-run 那条「缺少必填输入」。
   * 屏幕上那句不带范围的"通过/不通过"会让人拿着红徽章去怀疑 CI，
   * 而那时说谎的是屏幕，**受损的是 CI 的可信度** —— 那比少一个提示严重。
   */
  const t = texts(cleanMissing());
  const pass = t.find((x) => /静态闸/.test(x));
  assert.ok(pass, `状态行上没有一句点名"静态闸"：${JSON.stringify(t)}`);
  assert.match(pass!, /CI/, `"${pass}" 没说清自己与 CI 的关系：这一查的口径就是 CI 退码的口径，不写出来会被拿去对比`);
  assert.equal(STATIC_GATE_PASS, pass, '常量与实际画出来的那句不是同一串（有人在页面里又拼了一份）');
});

test('静态闸的**空态**那句不许说"引擎没报任何问题"（那是句假话，本轮就是来治它的）', () => {
  /*
   * 精确的反向钉子：`dryRun` 也在 `@atest/engine` 里，所以"引擎没报任何问题"
   * 在 dryRun 报了一条 error 的当口是假的。这一条是**字符串级**的钉子 ——
   * 它丑，而它比一条语义断言有用，因为这类谎就是这样一句一句漂回来的。
   */
  assert.doesNotMatch(EMPTY_STATIC_GATE, /引擎没报任何问题/,
    '空态那句又写成"引擎没报任何问题"了：输入完备性也是引擎的一查，那条 error 报的时候这句就是假话');
  assert.match(EMPTY_STATIC_GATE, /静态闸/, '空态那句要点名它只覆盖了静态闸：' + EMPTY_STATIC_GATE);
  // 最后那句"有一查没跑"是既有的载体（跨场景调用图浏览器拿不到），别顺手删掉
  assert.match(EMPTY_STATIC_GATE, /没跑/, '那句"有一查在这里压根没跑"要留着，否则"没报环"会被读成"查过、没有环"');
});

test('卡片标题也点名静态闸 —— 而且它在**有 finding 的时候**同样要说真话', () => {
  /*
   * 标题与空态那句**不是一个契约**，所以分成两条测试而不是并排两句断言：
   * 空态那句只在"零 finding"时出现，而**标题每次都在**。
   * `dryRun` 唯一报了一条 error 时，屏幕上那张卡的标题是「静态闸报错（0 条）」——
   * 那一句是当着"引擎报错（0 条）"与旁边那句「缺少必填输入：who」一起被读的，
   * 空态测试结构上**够不到**这一格（它进不去那个分支）。
   *
   * （这一格是量出来的：M6 与 M7 两条变异原本落在**同一条测试**上，
   *  我在 spec 的 `_why` 里写的"两处独立漂、各钉一处才分得清是谁掉的"当时**是假的**。
   *  要么承认它们共用一个载体、要么把契约拆开 —— 选了拆开，因为这两句话的
   *  **可见条件本来就不同**，共用一条测试是把两个契约塞进一个断言里。
   *  §4.5 第 12 条讲的就是这种句子：先跑，再写。）
   */
  assert.match(staticGateCardTitle(0), /静态闸/, `零 finding 时标题又自称"引擎报错"了：${staticGateCardTitle(0)}`);
  assert.match(staticGateCardTitle(3), /静态闸/, `有 finding 时标题也不许扩到整个引擎：${staticGateCardTitle(3)}`);
  assert.doesNotMatch(staticGateCardTitle(3), /引擎/, '标题里的"引擎"会把 dryRun 那一查也算进这 3 条里：' + staticGateCardTitle(3));
  assert.match(staticGateCardTitle(3), /3/, `条数没进标题：${staticGateCardTitle(3)}`);
});

test('缺输入的卡片**说清上哪儿填**，同时给出密钥该走的那条路', () => {
  /*
   * 两句都要，缺一句就是半条路：
   *  · 只说"缺少必填输入"——人会去点「运行」，而 `runIt` 永远不传 inputs；
   *  · 只说"命令行传 --input who=<值>"——人会顺手把口令填进去，
   *    而 argv 会被 `ps aux`、shell 历史、CI 命令日志收走（本仓因此从不提供
   *    `--secret <值>` 这种旗标）。既然这里主动给了那条命令，就必须同时给出密钥的路。
   */
  const hint = missingInputHint(['who', 'qty']);
  assert.match(hint, /--input who=<值>.*--input qty=<值>/, `没逐个点名：${hint}`);
  assert.match(hint, /运行/, `要说出"屏幕上那个运行按钮不会替你补上"，否则人会去点它：${hint}`);
  assert.match(SECRET_ROUTE_HINT, /ps aux|shell 历史/, `密钥警告要说清**为什么**：${SECRET_ROUTE_HINT}`);
  assert.match(SECRET_ROUTE_HINT, /secret:/, '要给出替代路径，不能只说不要：' + SECRET_ROUTE_HINT);
  // ⚠ 这条是给我自己写的：hint 里带着变量名，所以"卡片点名了谁"那种断言
  //    必须去问 <code> 元素，不能对整张卡的文本匹配 —— 否则匹配上的是这句说明
  assert.match(hint, /who/, '前提：这句提示里**含有**变量名。下面浏览器测试里"卡片点名 who"那条因此必须问 <code> 而不是整张卡');
});

test('IR 不合法时，状态行只说那一件（不画一枚假装"IR 没问题"的徽章）', () => {
  /*
   * `checkIr` 在 schema 没过时交的是 `issues: []`（那是一份残缺对象，lint 判不了）。
   * 直接照静态闸那套画会得到一枚绿徽章 + "通过" —— 那是把"没查"画成"查过且过了"，
   * 本仓那一族缺陷的第三种写法。所以 parsed=false 走的是另一条形。
   */
  const lines = checkStatusLines({ parsed: false, parseError: '缺少必填键 body', issues: [] });
  assert.equal(lines.length, 1, `不合法时还要画别的？${JSON.stringify(lines)}`);
  assert.equal(lines[0]!.kind, 'error', 'IR 不合法必须是 error 形，不能是徽章');
  assert.match(lines[0]!.text, /缺少必填键 body/, 'zod 那句原样带出，不重排版（重排一次就是第二份报错）');
});

test('irSha 取不到时那一格给的是**原因**，不是空白也不是假 hash', () => {
  // 这条不新增判据，只是把 check.ts 里那条纪律接上载体：句子在纯模块里就该在这测
  const t = texts(cleanMissing({ irSha: undefined, irShaError: '这个上下文里没有 Web Crypto' }));
  assert.ok(t.some((x) => /Web Crypto/.test(x)), `原因没出现在状态行上：${JSON.stringify(t)}`);
  assert.ok(!t.some((x) => /irSha a{6}/.test(x)), '取不到 hash 却还画着 hash');
});
