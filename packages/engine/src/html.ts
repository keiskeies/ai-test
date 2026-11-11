/**
 * RunReport → **自包含单文件 HTML**（evidence 包里的 `report.html`）。
 *
 * 为什么要有这份而不是只给 JUnit + trace.jsonl：
 * JUnit 是给 CI 解析器读的，trace 是给机器/复盘读的，summary.txt 只有六行。
 * 一次失败 run 现在要人 `unzip -p … | grep` 才能看到"哪一步坏了、期望什么、实际什么"，
 * 而 docs/12 §4.2 把这件事叫"产品信任所在" —— 用户 3 秒判断"不是 UI 坏了，是数据没落库"，
 * 靠的是把断言的期望值/实际值/来源步骤/响应体**摆在同一屏**。
 *
 * 三条约束决定了它长这样，都是被环境或既有纪律逼出来的，不是审美选择：
 *
 *  1. **零 JavaScript**。详情全部用原生 `<details>`。这不是洁癖：
 *     本报告里会出现**服务端响应的原文**（断言摘要、失败原因、错误消息），
 *     能控制 API 响应的人就能往一个"人会用浏览器打开的 HTML"里塞标签。
 *     没有 JS 意味着"脚本注入"这一整类问题**在构造上不存在**，
 *     而不是"我们转义得很小心"——转义纪律会漏，构造不会。
 *     顺带三个副作用都是好处：邮件客户端、CI 的 artifact 预览器、`file://` 双击
 *     三处表现一致（它们大多禁 JS），文件小到能贴进 IM，离线内网零外部请求。
 *  2. **不引任何外部资源**（字体/CSS/图标一律不请求）。内网与断网环境必须能打开，
 *     而 `<link>` 挂一个 CDN 的报告在离网机器上会长久转圈 —— 那是"打不开"，
 *     比"不好看"严重得多。
 *  3. **不把证据原件嵌进来**。响应体只在包内已存在的 `artifacts/<sha256>` 里，
 *     本页只**指名字**（sha 前 12 位）。嵌进来等于在第二个位置复制一份真实响应体
 *     —— 那会绕开 artifacts 的单一出口，让"密钥只在一个地方被脱敏过"这句话失效。
 *
 * 视觉 token 取自 docs/13：紧凑档 13px/32px、六态语义色为第一色彩系统、
 * **色 + 图标 + 文字三重编码**（灰度打印与色盲用户不能丢信息），
 * `healed` 用青不用绿（"自愈当通过"是 docs/00 §5.6 明令禁止的读法）。
 */
import type { RunReport } from './interpreter.js';
import type { StepResult } from '@atest/ir';
import { CONTAINER_KINDS, ASSERTION_KINDS, flakyAttempts, isFlakyPass } from '@atest/ir';
import { redactForDisk, redactSecretText } from './redact.js';
import { advisoryItems, advisoriesHidden, collectAdvisories } from './advisories.js';
import { EVIDENCE_FILES, EVIDENCE_MEMBERS, type EvidenceManifest } from './report.js';

export interface HtmlOptions {
  /**
   * 场景 id（标题与页脚用）。缺省用 runId。
   *
   * **为什么不叫 `scenarioId`**（改名有具体理由，不是口味）：那个词在 IR 里
   * 是 `BaselineSampleSchema.scenarioId` 的字段名，而 tooling/unread-fields.mjs
   * 的判据是词法的 —— `opts.scenarioId` 是一处 **member** 强证据，而这个名字
   * 全局只声明过一次，于是扫描器判"基线表那个字段有人读了"，把仍然需要的
   * P7 豁免报成"已过期"。更坏的是 `--evidence` 会给出
   * `BaselineSampleSchema.scenarioId <- packages/engine/src/html.ts:266`
   * —— 一条**指着一个毫不相关的入参**的"证据"。抽查证据的人按图索骥打开 html.ts
   * 看到的却是渲染标题，那比没有行号更坏（行号错了比没有行号更坏，同一句理由）。
   *
   * 叫 suiteId 是**沿用本模块既有说法**：report.ts 的 JUnitOptions.suiteName
   * 表示的就是"场景 id 在报告里怎么显示"。同一层的东西用同一个词，
   * 顺带也让字段名不再撞上高频标识符 —— 这正是 unread-baseline 里
   * `_ceiling_comment` 说的"收紧判不出桶的唯一正当办法"。
   */
  suiteId?: string;
  scenarioName?: string;
  /** 运行摘要（RunReport.summary 由 CLI 传入；缺省时页面上不显示那一行） */
  summary?: string;
  /** 冻结状态。frozen=false 必须在页面上看得见 —— 未冻结的 run 不能当 CI 依据 */
  frozen?: boolean;
}

const CONTAINER_SET = new Set<string>(CONTAINER_KINDS);

/**
 * 六态的**图标 + 中文名**。
 *
 * 表放在这里而不是只写 CSS 颜色，是 docs/13 §2 那条硬规定：
 * **色 + 图标 + 文字三重编码**，色盲用户、灰度打印、截图转发都不能丢信息。
 * 只写颜色的实现会在黑白打印时把六种状态压成一种。
 */
const STATE: Record<string, { icon: string; label: string; v: string }> = {
  pass: { icon: '✓', label: '通过', v: '--pass' },
  fail: { icon: '✗', label: '失败', v: '--fail' },
  error: { icon: '!', label: '执行异常', v: '--error' },
  healed: { icon: '⚕', label: '自愈待审', v: '--healed' },
  skipped: { icon: '⊘', label: '跳过', v: '--skipped' },
  triaged: { icon: '◐', label: '待人工确认', v: '--triaged' },
  stale: { icon: '⟳', label: '可能过期', v: '--stale' },
};
const stateOf = (s: string): { icon: string; label: string; v: string } =>
  STATE[s] ?? { icon: '·', label: s, v: '--skipped' };

/**
 * 归因的中文说法。值班人看这个决定"找谁"，所以措辞要能直接指向下一步动作。
 * 词表与 ir 的 FAILURE_CAUSE 封闭枚举一致；没列出来的原样显示（不猜）。
 *
 * `untriaged` 这一条本轮加：它从前只出现在"刚失败、还没人看"那一瞬间，
 * 而 `errors.ts` 把归因判据的**兜底**从 env-unavailable 换成它之后，
 * 它成了"新错误类没登记"的常规出口。那时报告里印一个裸的英文枚举词
 * 是不够用的 —— 这一张表的用处就是让人知道下一步做什么，
 * 而这一格的下一步动作很具体：看那句原始报错，然后去 errors.ts 登记这个类。
 */
const CAUSE_LABEL: Record<string, string> = {
  'product-bug': '产品缺陷 → 提 BUG',
  'case-stale': '用例过期 → 改用例',
  'env-unavailable': '环境不可用 → 查环境/重试',
  'locator-stale': '定位失效 → 重新录定位器',
  'data-conflict': '数据冲突 → 查数据/租约',
  flaky: 'flaky → 看历史抖动，别急着改代码',
  untriaged: '没归因 → 看下面那句原始报错，并在 engine/src/errors.ts 登记这个错误类',
};

/**
 * HTML 文本转义 + **值形态脱敏**。这两个职责合在一个函数里是刻意的，理由分两半：
 *
 * ## 转义：只转 `& < >`
 *
 * 属性值另走 htmlAttr（多转引号）—— 与 report.ts 里 xmlText/xmlAttr 分两个函数是
 * 同一条理由：**属性里的引号会提前闭合属性，后面的内容就变成标签**，
 * 那已经不是"报告难看"而是注入。
 *
 * ## 脱敏：本轮补的，改动前这里**只转义不脱敏**
 *
 * 本文件原来只在 `keyContext` 那一格调 `redactForDisk`（有条测试钉着），
 * 而**散文**那一列 —— `assertionSummary`、`report.summary`、容器提示带里那句 ——
 * 一个都没脱。实测后果：一次本地 schema 校验拦截（`请求体不符合 spec（发送前拦截）：
 * $.password 实际 <真 token>`）把真 JWT 与真 AWS key **原样写进 report.html**，
 * 同一次 run 的 `trace.jsonl` 反倒是干净的。`html.test.ts` 那条脱敏钉子查的是
 * keyContext，所以它绿着、页面漏着 —— 正是 docs/08 §3 那个测试侧镜像
 * （**测试通过的原因和它想验的东西无关**）。
 *
 * 放在 `esc` 而不是各个调用点：本文件有 **十余处** 文本出口（行摘要、详情块、
 * 失败区、待审区、提示带、页脚），漏一处就等于没有。这条与"转义也必须在这"
 * 是同一条判断 —— 一个函数是所有文本的唯一通路，性质就只能在它身上成立。
 *
 * **不做字段名规则**：那是结构化数据才有的概念（`redactForDisk` 负责 keyContext，
 * 那条路照旧走）。这里做的是值形态（JWT / AKIA / sk- / 私钥 / Bearer），
 * 对散文是充分的那一半：一句中文里没人能"给字段改名"。
 */
function esc(s: string): string {
  return redactSecretText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function htmlAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * URL 白名单。**唯一的链接目标是包内成员**，所以只允许两种形态：
 * `artifacts/<64hex>` 与那几个固定成员名。
 *
 * 成员名从 EVIDENCE_FILES **取**而不是手抄一遍：加一个成员而忘了加进白名单，
 * 表现是"页面上那个链接点不动"（静默少一个入口），比报错难发现。
 *
 * 为什么不"过滤掉 javascript: 就算安全"：那是黑名单。`data:` 一样能执行
 * （`<a href="data:text/html,<script>…">` 在多数浏览器里点开会当同源文档跑），
 * 相对路径 `..%2F` 能指到包外。docs/03 §5 的注入防线里早就写了
 * `javascript:`/`data:` 一律禁止 —— 白名单是唯一不需要"每次都想全"的写法。
 *
 * **为什么这里是 Set + 精确 hex，而不是原来那条拼出来的大正则**（改动有具体理由）：
 * 原版把成员名 `.replace(/[.*+?…]/g,'\\$&')` 转义后再拼进 alternation，
 * 于是"正确性"依赖**每个成员名都过了转义**这件事。变异检查证明了这个依赖有多脆：
 * 把那段 .replace 整个删掉，六条测试**全绿** —— 因为 memberHref 的调用方
 * 要么喂 `artifacts/<id>`（永远走不到成员名那一支），要么喂 EVIDENCE_FILES 常量，
 * **没有任何输入能打到那一支**，转义对错的是一段到不了的代码。
 * 一个"要靠记住转义、且错了也没人发现"的白名单，比一个"结构上不可能宽松"的白名单差。
 * Set.has 是精确字符串相等，**没有元字符这个概念**，也就没有"忘了转义"这个失败模式。
 */
const SAFE_MEMBERS = new Set<string>(EVIDENCE_MEMBERS);
const ARTIFACT_PREFIX = `${EVIDENCE_FILES.artifactsDir}/`;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 成员名的绝对上界（防失控：id 是从结果里取的字符串，不能假定它一定是 id）。
 * 注意两支的**分工**：成员名走精确相等，证据 id 走 hex 形态 + 目录前缀，
 * 所以结果里的字符串**没有办法**指到 manifest.json 这类包内成员上
 * （artifactId='manifest.json' 会先被拼成 'artifacts/manifest.json'，两支都不命中）。
 */
function memberHref(target: string): string | undefined {
  if (SAFE_MEMBERS.has(target)) return `./${target}`;
  if (target.startsWith(ARTIFACT_PREFIX) && HEX64.test(target.slice(ARTIFACT_PREFIX.length))) return `./${target}`;
  return undefined;
}

/** 展示用的短 sha。取不到安全形态时返回 undefined，由调用方决定显示什么 */
function shortId(id: string): string {
  return /^[0-9a-f]{64}$/.test(id) ? id.slice(0, 12) : '非内容寻址 id';
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** 样式。全部走 CSS 变量：docs/13 §6「自研组件只消费 token，不写 hex」 */
const CSS = `
:root{
  --font:13px; --row:32px; --ctrl:28px;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px;
  --text:#0f172a; --text-2:#475569; --text-3:#64748b;
  --bg:#ffffff; --bg-2:#f8fafc; --bg-3:#f1f5f9; --line:#e2e8f0;
  --pass:#15803d; --fail:#b91c1c; --error:#c2410c; --healed:#0e7490;
  --skipped:#475569; --triaged:#a16207; --stale:#6d28d9; --brand:#2563eb;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --text:#e2e8f0; --text-2:#94a3b8; --text-3:#64748b;
    --bg:#0b1120; --bg-2:#111827; --bg-3:#1f2937; --line:#334155;
    --pass:#4ade80; --fail:#f87171; --error:#fb923c; --healed:#22d3ee;
    --skipped:#94a3b8; --triaged:#fbbf24; --stale:#a78bfa; --brand:#60a5fa;
  }
}
*{box-sizing:border-box}
body{margin:0;padding:var(--s4);background:var(--bg);color:var(--text);
  font:var(--font)/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:16px;margin:0 0 var(--s2)}
h2{font-size:14px;margin:var(--s5) 0 var(--s2);color:var(--text-2);font-weight:600}
code,.mono{font-family:var(--mono);font-size:12px}
a{color:var(--brand)}
.wrap{max-width:1180px;margin:0 auto}
.banner{border-left:3px solid var(--fail);background:var(--bg-2);padding:var(--s3);
  border-radius:4px;margin-bottom:var(--s3)}
.banner.ok{border-left-color:var(--pass)}
.banner.warn{border-left-color:var(--error)}
.meta{color:var(--text-2);display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:center}
.badge{display:inline-flex;align-items:center;gap:var(--s1);padding:0 var(--s2);
  border-radius:999px;font-size:12px;border:1px solid var(--line);background:var(--bg-2)}
.chip{display:inline-flex;align-items:center;gap:var(--s1);font-size:12px;color:var(--text-2)}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-size:12px;color:var(--text-3);font-weight:600;
  padding:0 var(--s2);height:28px;border-bottom:1px solid var(--line)}
td{padding:0 var(--s2);height:var(--row);border-bottom:1px solid var(--line);vertical-align:middle}
tr.nest td:first-child{padding-left:var(--s5);color:var(--text-2)}
.st{font-weight:600;white-space:nowrap}
.st-pass{color:var(--pass)} .st-fail{color:var(--fail)} .st-error{color:var(--error)}
.st-healed{color:var(--healed)} .st-skipped{color:var(--skipped)}
.st-triaged{color:var(--triaged)} .st-stale{color:var(--stale)}
td.fail-bar{box-shadow:inset 3px 0 0 var(--fail)}
td.error-bar{box-shadow:inset 3px 0 0 var(--error)}
td.healed-bar{box-shadow:inset 3px 0 0 var(--healed)}
details{margin:0}
summary{cursor:pointer;color:var(--text-2);list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸ ";color:var(--text-3)}
details[open]>summary::before{content:"▾ "}
.body{background:var(--bg-2);border:1px solid var(--line);border-radius:4px;
  padding:var(--s3);margin:var(--s2) 0}
.kv{display:grid;grid-template-columns:minmax(96px,auto) 1fr;gap:var(--s1) var(--s3)}
.kv dt{color:var(--text-3)}
.kv dd{margin:0;overflow-wrap:anywhere}
pre{margin:0;font-family:var(--mono);font-size:12px;white-space:pre-wrap;
  overflow-wrap:anywhere;background:var(--bg-3);padding:var(--s2);border-radius:4px;
  max-height:340px;overflow:auto}
.attn{border-left:3px solid var(--healed)}
.hint{color:var(--text-3);font-size:12px}
ul{margin:var(--s2) 0 0;padding-left:var(--s5)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:var(--s2);margin-top:var(--s3)}
.card{border:1px solid var(--line);border-radius:4px;padding:var(--s2) var(--s3);background:var(--bg-2)}
.card b{display:block;font-size:18px;font-variant-numeric:tabular-nums}
.foot{margin-top:var(--s5);padding-top:var(--s3);border-top:1px solid var(--line);color:var(--text-3)}
`;

/** 一条结果的详情块（`<details>` 展开后的内容） */
function detailOf(r: StepResult): string {
  const rows: Array<[string, string]> = [];
  if (r.assertionSummary) rows.push(['摘要', `<span class="mono">${esc(r.assertionSummary)}</span>`]);
  if (r.cause) {
    rows.push(['归因', `<span class="st st-${stateOf(r.status).v.replace('--', '')}">${esc(CAUSE_LABEL[r.cause] ?? r.cause)}</span>`]);
  }
  if (r.retry > 0) rows.push(['重试', `${r.retry} 次后才得到这个结论`]);
  if (r.resolvedBy) rows.push(['定位方式', `<code>${esc(r.resolvedBy)}</code>`]);
  if (r.rung !== undefined) rows.push(['定位阶梯', `第 ${r.rung} 级`]);
  if (r.confidence !== undefined) rows.push(['置信度', r.confidence.toFixed(2)]);
  if (r.nonReplayable) rows.push(['可回放', '<b>不可</b>（视觉/坐标类结果，永不进 CI）']);
  if (r.costUsd > 0) rows.push(['成本', `$${r.costUsd.toFixed(4)}`]);
  for (const f of flakyAttempts(r)) {
    rows.push([`第 ${f.attempt} 次尝试（等 ${f.waitedMs}ms）`, `<span class="mono">${esc(`${f.status}${f.cause ? ` ${f.cause}` : ''}${f.summary ? ` ${f.summary}` : ''}`)}</span>`]);
  }
  const keys = Object.keys(r.keyContext ?? {});
  if (keys.length) {
    // 与磁盘上其他结构化字段同一套规则（字段名 + 值形态）。
    // 在这里脱敏而不是指望调用方传一个已脱敏的对象：**序列化那一刻**才是防线，
    // 显示层与上游"应该会脱敏"的假设是本仓反复出现的那类失效。
    const scrubbed = redactForDisk(r.keyContext ?? {});
    rows.push(['关键上下文', `<pre>${esc(JSON.stringify(scrubbed, null, 2))}</pre>`]);
  }
  if (r.artifactIds.length) {
    const items = r.artifactIds.map((id) => {
      const href = memberHref(`${EVIDENCE_FILES.artifactsDir}/${id}`);
      // 名字照样给（即使形态不像内容寻址 id）：让人能回答"那次产了 3 件里少的
      // 是哪一件"。但形态不对时**不给链接**，否则就是让结果里的字符串决定 href。
      return `<li><code>${esc(shortId(id))}</code>${href ? ` · <a href="${htmlAttr(href)}">artifacts/${esc(shortId(id))}</a>` : ' <span class="hint">（形态不是内容寻址 id，只列名不给链接）</span>'}</li>`;
    });
    rows.push(['证据', `<ul>${items.join('')}</ul><div class="hint">原件在包内 <code>${EVIDENCE_FILES.artifactsDir}/</code> 下（本页不内嵌，避免同一份响应体存在第二个位置）</div>`]);
  }
  if (!rows.length) return '';
  return `<div class="body"><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}

/** 一行步骤。容器不出行（与 JUnit 的 CONTAINER_KINDS 过滤同一个答案） */
function rowOf(r: StepResult, scoped: boolean): string {
  const st = stateOf(r.status);
  const bar = r.status === 'fail' ? ' fail-bar' : r.status === 'error' ? ' error-bar' : r.status === 'healed' ? ' healed-bar' : '';
  const detail = detailOf(r);
  const attrs: string[] = [];
  if (isFlakyPass(r)) attrs.push(`flaky（第 ${flakyAttempts(r).length + 1} 次才通过）`);
  if (r.healed) attrs.push('自愈改写');
  // 摘要直接放在行上：排障时第一眼看的就是这列，多点一次展开是纯摩擦
  const summary = r.assertionSummary ? `<div class="hint mono">${esc(r.assertionSummary.slice(0, 160))}</div>` : '';
  const inner = detail ? `<details><summary>详情</summary>${detail}</details>` : '';
  const cells = [
    `<td class="st st-${st.v.replace('--', '')}${bar}" title="${htmlAttr(st.label)}">${st.icon} ${esc(st.label)}</td>`,
    `<td><code>${esc(r.stepId)}</code>${summary}${inner}</td>`,
    `<td class="hint">${esc(r.kind)}</td>`,
    `<td style="text-align:right" class="hint">${esc(fmtMs(r.durMs))}</td>`,
    `<td class="hint">${attrs.length ? esc(attrs.join(' · ')) : ''}</td>`,
  ];
  return `<tr class="${scoped ? 'nest' : ''}">${cells.join('')}</tr>`;
}

/**
 * RunReport → 单文件 HTML。
 *
 * 计数口径与 JUnit **必须一致**：容器不算用例、子场景的结果不重复数
 * （一次子场景失败由 call 步骤带上来）。"什么算一条用例"全仓只有一个答案，
 * 这里多给一个数字就会让页面上的用例数和 CI 里的对不上 —— 那是最难查的那类不一致。
 */
export function toHtmlReport(report: RunReport, opts: HtmlOptions = {}): string {
  const id = opts.suiteId ?? report.runId;
  const leaf = report.results.filter((r) => !CONTAINER_SET.has(r.kind));
  /*
   * 容器**自己那句话**要说出来，但**不能靠给容器加一行表格**来说 —— 这一点本轮
   * 先做错了一次，值得写下来。
   *
   * 上面那个 leaf 过滤是对的，而且有一条测试明确钉着它（`html.test.ts`「容器步骤不出行」），
   * 因为它守的是**计数口径与 JUnit 一致** —— 容器不算用例。但它顺带把容器自己的
   * 结论也从页面上抹掉了，而这两件事本来不相干：`forEach` / `while` 会自己记一句
   * 结论（迭代被截断、撞上限、循环体一次没跑），那句话以前**只进 JSON 与证据包，
   * 进不了人第一个看的那个页面**。
   *
   * 我第一版的解法是"只渲染**带着话**的容器"（把它们放进表里）。**实测否掉了它**：
   * 一份 5 条数据 / 上限 2 的 forEach，表里出现 `fe` 这一行，而
   * `toJUnitXml` 的 testsuite 是 `tests="3"`、testcase 是 `v,body,body` ——
   * `fe` 在 CI 那一侧根本不是一条用例。页面行数与 CI 用例数对不上，正是这个文件
   * 开头那段"最难查的那类不一致"。而且**现有那条钉子抓不到我**：它的判据是
   * `htmlNames.filter(n => junitNames.includes(n))`，只查"JUnit 有的页面必须有"，
   * 反方向（页面多出来的行）被那个 filter 吃掉了 —— 又一条"测试通过的原因和它
   * 想验的东西无关"。所以本文件另加一条正反双向的钉子，而不是靠它。
   *
   * 结论：**表里照旧只有叶子**（`rowsOf` 与 HEAD 逐字同口径），容器那句话走
   * 表格上方的一条独立提示带 —— 它不是行，所以不参与任何计数；
   * 同时也**不进 `bad` / `attn` / `assertions` / `counted`** 那四个计数与分区，
   * 动一个就会让页面用例数与 CI 对不上。容器自己记的 fail/error 该不该进
   * "失败"那一区是另一个问题（退出码那一侧已经算了，见 docs/08 §3 那一行），这里不顺手改。
   *
   * 判据取**结构化字段**而不是去匹配摘要里的"上限"两个字 —— 匹配句子前缀正是本仓
   * 在 noteNeverRun 那里写过的那类耦合（改个措辞就悄悄退化，而且没有任何编译期
   * 东西会发现）。两个键都要：
   *  - `truncated`：迭代被截断 / 撞上限（容器自己 pass，但结论不完整）；
   *  - `neverRun`：循环体一次没跑。**这一条我以前在注释里写错过一次**，
   *    写的是"它留下的痕迹是循环体那些 skipped 行，而叶子本来就出行" ——
   *    实测**嵌套循环不成立**：外层数据为空时，标记挂在**内层容器**上
   *    （`kc={"neverRun":"迭代 0 次…"}`，实测于一份两层 forEach 的场景），
   *    那一行同样是容器，同样进不了表。
   *
   * 扫描范围**含 call 子场景的 results**：主表与子场景各写一遍判据，迟早只改一处
   * —— 本仓那族毛病的标准形状。
   */
  const unfinished = [report, ...(report.childRuns ?? [])]
    .flatMap((rs) => rs.results)
    .filter((r) => CONTAINER_SET.has(r.kind)
      && ((r.keyContext?.truncated) !== undefined || (r.keyContext?.neverRun) !== undefined));
  const bad = leaf.filter((r) => r.status === 'fail' || r.status === 'error');
  const attn = leaf.filter((r) => r.status === 'healed' || r.status === 'triaged' || isFlakyPass(r));
  const assertions = leaf.filter((r) => (ASSERTION_KINDS as readonly string[]).includes(r.kind));
  const counted = report.tally.pass + report.tally.fail + report.tally.error + report.tally.healed;
  const rate = counted ? Math.round((report.tally.pass / counted) * 100) : 100;

  // 顶部横幅：先给结论，再给细节。状态用 class 编码（色）+ 图标 + 中文，三重
  /*
   * **被中断时横幅不能是绿的**（`bad.length ? '' : attn.length ? 'warn' : 'ok'` 那一行
   * 在本轮之前对一次被砍断的 run 给出 `ok`，也就是一道绿条）。
   * 这是同一个假绿的**第四个消费者**：退出码（已修）、summary.txt 首行、
   * manifest.status、文件名，然后是这个页面 —— 而这个页面是**人第一个看的**。
   *
   * 只把横幅染色不够（色弱、黑白打印、截图发给别人都会丢掉这条信息），
   * 所以同时挂一个文字徽章。而**不改 `st`（那个状态胶囊）**：
   * `report.status` 说的是"已完成步骤的结论"，那是真的 pass，改成 error 就是伪装成某一步坏了
   * —— 与 RunReport.aborted 上那段同一条判断。
   */
  const bannerKind = bad.length ? '' : (attn.length || report.aborted) ? 'warn' : 'ok';
  const st = stateOf(report.status);
  const banner = `<div class="banner ${bannerKind}">
    <h1><span class="st st-${st.v.replace('--', '')}">${st.icon} ${esc(st.label)}</span> · ${esc(opts.scenarioName ?? id)}</h1>
    <div class="meta">
      <span class="mono">${esc(id)}</span>
      <span class="hint">${esc(report.runId)}</span>
      <span class="hint">${esc(new Date(report.startedAt).toISOString())}</span>
      <span class="hint">${esc(fmtMs(report.durMs))}</span>
      <span class="hint">${rate}% 通过率（分母 ${counted}）</span>
      <span class="badge">${opts.frozen ? '已冻结' : '<b>未冻结</b>（CI 不应执行）'}</span>
      ${report.aborted ? `<span class="badge"><b>被中断</b>（${esc(report.aborted.reason)}）：后面的步骤没执行</span>` : ''}
    </div>
    ${opts.summary ? `<div class="hint">${esc(opts.summary)}</div>` : ''}
  </div>`;

  const cards = [
    ['通过', report.tally.pass, 'pass'], ['失败', report.tally.fail, 'fail'], ['异常', report.tally.error, 'error'],
    ['自愈待审', report.tally.healed, 'healed'], ['跳过', report.tally.skipped, 'skipped'], ['待确认', report.tally.triaged, 'triaged'],
  ].map(([k, n, v]) => `<div class="card"><span class="st st-${v}">${stateOf(String(v)).icon} ${esc(String(k))}</span><b>${esc(String(n))}</b></div>`).join('');

  // 声明必须在使用之前：childBlocks 里的模板串是**立即求值**的，
  // 把 head 放在它后面就是 TDZ ReferenceError（一跑到 call 子场景就炸，而不是编译期报错）。
  const head = `<thead><tr><th style="width:104px">状态</th><th>步骤 / 摘要</th><th style="width:110px">类型</th><th style="width:72px;text-align:right">耗时</th><th style="width:190px">备注</th></tr></thead>`;

  /**
   * 一个结果列表 -> 表格行。**与 HEAD 逐字同口径：只有叶子出行。**
   *
   * 主表与 call 子场景**共用这一个函数**（两块各写一遍过滤，迟早只改一处 ——
   * 本仓那族毛病的标准形状），但共用的是"只渲染叶子"这条判据本身，
   * 容器那句话不从这里走（理由见上面 `unfinished` 那一大段）。
   */
  const rowsOf = (rs: StepResult[], scoped: boolean) =>
    rs.filter((r) => !CONTAINER_SET.has(r.kind)).map((r) => rowOf(r, scoped)).join('');

  const stepRows = rowsOf(report.results, false);
  const childBlocks = (report.childRuns ?? []).map((c) => {
    const rows = rowsOf(c.results, true);
    return `<h2>call 子场景 · <span class="mono">${esc(c.scenario.id)}</span> <span class="hint">← 步骤 <span class="mono">${esc(c.callStepId)}</span>（不计入上面的用例数）</span></h2>
      <table>${head}${rows}</table>`;
  }).join('');

  const attnList = attn.length
    ? `<h2>需要人审（${attn.length}）</h2><div class="body attn"><ul>${attn.map((r) => {
        const why = r.status === 'healed' ? '靠自愈通过，定位器/等待策略被改过'
          : r.status === 'triaged' ? '待人工确认（首轮策略）'
            : `重试 ${flakyAttempts(r).length} 次后才通过（抖动）`;
        return `<li><code>${esc(r.stepId)}</code> — ${esc(why)}${r.assertionSummary ? ` <span class="hint mono">${esc(r.assertionSummary.slice(0, 120))}</span>` : ''}</li>`;
      }).join('')}</ul></div>`
    : '';

  const badList = bad.length
    ? `<h2>需要处理（${bad.length}）</h2><div class="body">${bad.map((r) => {
        const st2 = stateOf(r.status);
        return `<div class="kv" style="margin-bottom:var(--s3)"><dt><span class="st st-${st2.v.replace('--', '')}">${st2.icon}</span></dt><dd><code>${esc(r.stepId)}</code> <span class="hint">${esc(r.kind)}</span>${r.cause ? ` <span class="hint">${esc(CAUSE_LABEL[r.cause] ?? r.cause)}</span>` : ''}<div class="mono">${esc(r.assertionSummary ?? '')}</div></dd></div>`;
      }).join('')}</div>`
    : '';


  /*
   * 同包文件的链接。**从 EVIDENCE_MEMBERS 派生**而不是手抄一份清单 ——
   * 手抄那份就漏过一格：加 report.html 的时候，页脚这四个名字里少写了一个成员，
   * 症状是"页面上少一个链接、没人报错"（本仓那个"下半截没人接"的缺陷类）。
   * 唯一的过滤是**不给自己做链接**（本页就是 report.html，链到自己纯属噪声）。
   */
  const siblingLinks = EVIDENCE_MEMBERS
    .filter((n) => n !== EVIDENCE_FILES.html)
    .map((n) => memberHref(n))
    .filter((x): x is string => Boolean(x));

  const foot = `<div class="foot">
    <div class="hint">断言结论 ${assertions.length} 条 · 叶子步骤 ${leaf.length} 条 · 成本 $${report.costUsd.toFixed(4)}</div>
    <div class="hint">同包文件：${siblingLinks.map((l) => `<a href="${htmlAttr(l)}">${esc(l.replace('./', ''))}</a>`).join(' · ')}</div>
    <div class="hint">本页零脚本、零外部请求；证据原件不内嵌，只按 <code>${EVIDENCE_FILES.artifactsDir}/&lt;sha256&gt;</code> 指名。
    字段级密钥在**写盘那一刻**已按字段名 + 值形态双规则脱敏。</div>
  </div>`;

  /*
   * 「活没干完」那条提示带。**放在横幅下面、数字卡片上面** —— 一次"全绿但少跑了
   * 3 条数据"的 run，页面上原来**一个字的痕迹都没有**，而它是人第一个看的那一页；
   * 放在步骤表里则等于没放（表就在第二屏，且截断的循环自己不出行）。
   *
   * **标题只说"结论不完整"，不说"没跑完数据"**。第一版写的是后者，而它对
   * `neverRun` 那一支是**假话**：数据本来就有 0 条，没有"该跑而没跑"的数据，
   * 实情是循环体一次都没进（多半是上一步的数据准备没做）。两类的成因不同、
   * 该去查的东西也不同，所以标题取两者共同的弱命题，具体是哪一类由每一行
   * 自己的 `assertionSummary` 说（"迭代 2 次，但数据有 5 条…" / "迭代 0 次…"）。
   *
   * **不加 `role="note"`**。第一版写了，而 `npm run lint` 把它报出来了：字段覆盖扫描器
   * 按"字段名的裸词命中"判"有没有人读"，`role` 是 `LocatorRuleSchema.role` 的裸词命中，
   * 于是那个 IR 字段**从此算不出有没有人读**（本轮实测：234 > 登记的 233，门禁变红）。
   * 这不是扫描器的毛病 —— 它明说了"HTML 里的字面词"是它的已知极限 —— 是我这个属性
   * **本来就不需要**：整页零脚本、零 ARIA，信息已经由 `<b>` 里那句中文陈述句承载，
   * 读屏软件读到的就是那句话。为一个用不上的属性去抬高 ceiling，等于花掉真预算买假收益。
   *
   * **不改 `bannerKind`**：把撞上限染成琥珀色，是在替"上限是不是故意的"这个问题
   * 做决定（`while` 当"最多轮询 N 次"、`forEach` 当"只抽前 10 条冒烟"都是正常写法），
   * 而那一格的状态/归因让位问题是 docs/14 §5 登记着的未决项，本轮只解决"必须看得见"。
   */
  const unfinishedList = unfinished.length
    ? `<div class="body attn"><b>有 ${unfinished.length} 处循环的结论不完整（状态仍是"通过"，但活没干完）</b>`
      + `<ul>${unfinished.map((r) => `<li><code>${esc(r.stepId)}</code> <span class="hint mono">${esc(r.assertionSummary ?? '')}</span></li>`).join('')}</ul></div>`
    : '';

  /*
   * **运行期提醒**那一条带（`lint.reported` 事件的人读出口）。
   *
   * 与上面那条**故意分开、不合并成一条带**：两条说的是不同的事 ——
   * `unfinished` 说的是"某几个循环少跑了"（有步骤坐标、是**这次运行**的事实），
   * 这一条说的是"某道闸压根没生效"或"某个特性还没实现"（多半与运行配置有关，
   * 而且常常没有步骤坐标，例如 `ARTIFACT_STORE_MISSING` 是整场一次）。
   * 合成一条会得到一句两头都不准确的话，而本文件上一版就犯过这个错
   * （提示带标题写"没跑完数据"，对 `neverRun` 那一支是假话）。
   *
   * **不进 `bad` / `attn` / `assertions` / `counted` 那四个计数与分区，也不出行**：
   * 与 `unfinishedList` 同一条纪律 —— 页面上的用例数必须与 CI 数出来的相等。
   * 这里连步骤行都不产生（提醒不是用例），所以行/`<testcase>` 双向那条钉子
   * 天然不受影响；有测试专门钉这一点。
   *
   * **数据源是 `report.events`，只此一处**：子场景的事件在 `call` 分支里已经
   * 原样中继到父事件流（interpreter 的 `for (const e of rep.events) a.emit(...)`，
   * 实测带 `path: ["body","c1"]`），所以这里**不需要**再扫一遍
   * `childRuns` —— 扫了会双计（同一件事算两次），那是"多报"，
   * 而多报会让提示带变成噪声、进而被人整个关掉。
   * 反过来，**不能改用 childRuns 里的 results 当源**：绝大多数 code 不落 results，
   * 那等于回到"没人看得见"。
   *
   * **按 code 筛而不是按 code 白名单筛**（在 advisories.ts 里按 kind 筛）：
   * 新增一条 emit 天然进得了页面。白名单的话，"加了 emit 忘了登记"的表现是
   * 这条提醒静默不上页面 —— 正是这一族缺陷的标准形状。
   *
   * **detail 走 esc**：它是 adapter 写的字符串（`violations.join('; ')` 那条路），
   * 属于不可信内容，既要转义（这条带在 `<body>` 顶部，注入成功就是整页改写）
   * 也要值形态脱敏（校验失败最常见的对象是登录请求）。esc 两个都做。
   */
  const advisories = collectAdvisories(report.events);
  const items = advisoryItems(advisories);
  const hidden = advisoriesHidden(advisories);
  const advisoryList = items.length
    ? `<div class="body attn"><b>运行期提醒 ${items.length} 条${hidden ? `（还有 ${hidden} 条没列出，全文在 trace.jsonl）` : ''}——不影响红绿，但每一条说的都是"结论有水分"或"某道闸压根没生效"</b>`
      + `<ul>${items.map((a) => `<li><code>${esc(a.code)}</code> <span class="hint mono">${esc(a.text)}</span></li>`).join('')}</ul></div>`
    : '';

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'">
<title>${esc(st.icon)} ${esc(opts.scenarioName ?? id)} · ${esc(report.runId)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">
${banner}
${unfinishedList}
${advisoryList}
<div class="grid">${cards}</div>
${badList}
${attnList}
<h2>步骤（${leaf.length}）</h2>
<table>${head}${stepRows}</table>
${childBlocks}
${foot}
</div></body></html>
`;
}
