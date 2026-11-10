/**
 * M6：报告的**序列化出口** —— trace.jsonl / JUnit XML / evidence 清单。
 *
 * 这个文件的定位是**序列化那一刻**，不是展示层。区别是本质的：
 * 脱敏放在展示层等于磁盘上还留着明文，任何人拿到 artifact 就拿到了密钥；
 * 放在这里才是"落盘的东西本身不含密钥"（docs/02 §5）。
 *
 * 引擎仍然不许 import node 内置模块 —— 本文件全是纯字符串/对象变换，
 * 真 IO 在 packages/store。这样 CI、本地 CLI、服务端 worker 三条路径
 * 产出的报告**必然逐字节一致**，不会出现"本地能打开、CI 打不开"。
 */
import type { StepResult, TraceEvent } from '@atest/ir';
import type { RunReport } from './interpreter.js';
import { StepResultSchema, TraceEventSchema, CONTAINER_KINDS, flakyAttempts, isFlakyPass } from '@atest/ir';


// 脱敏策略在 redact.ts（唯一一份）。本文件不重复定义 —— 那个文件顶部记着
// "两份规则各自演化"的具体后果。注意原始证据走 redactArtifactText
// 且**默认不 keepRaw**（store 侧决定），本文件只管结构化数据。
import { redactForDisk } from './redact.js';

/** 容器判定。数组来自 ir（唯一权威），Set 只为把每次查找变 O(1) */
const CONTAINER_SET = new Set<string>(CONTAINER_KINDS);
const isContainer = (kind: string): boolean => CONTAINER_SET.has(kind);


// ── trace.jsonl ───────────────────────────────────────────────────────────

/**
 * 事件流 → JSONL 文本。
 *
 * 为什么要单独的追加式文本，而不是只用 DB 里的 steps 表：
 * **crash 后仍可分析**（docs/09 §1）。进程被 OOM killer 干掉时，
 * 内存里那份 RunReport 和"跑完再写库"的事务一起消失了，
 * 而 tail 到一半的 trace.jsonl 还能告诉你卡在哪一步。
 * 这也是 M7 确定性验证的原始素材：两次运行的 trace 逐行 diff 即可。
 *
 * 每行一个 JSON。JSON.stringify 会把换行转义成 \n，
 * 所以**不会有半行**——除非进程正好写在半行上被打断；
 * 读侧要能容忍最后一行残缺（见 parseTraceJsonl）。
 */
export function toTraceJsonl(events: TraceEvent[]): string {
  // 逐行 stringify 而不是整体 stringify：一行坏（循环引用）只丢一行，
  // 不至于让整份 trace 变成 "TypeError: Converting circular structure to JSON"
  const lines: string[] = [];
  for (const e of events) {
    try {
      lines.push(JSON.stringify(redactForDisk(e)));
    } catch {
      lines.push(JSON.stringify({ seq: e.seq, ts: e.ts, mono: e.mono, kind: 'error', data: { detail: '该事件无法序列化' } }));
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * 读回 JSONL。**最后一行可能被截断**（进程被打断），
 * 静默丢弃截断行并把"丢了几行"交出去 —— 假装文件完整是最坏的：
 * 人会拿一份少了尾巴的 trace 去推断"最后一步没跑"。
 */
export function parseTraceJsonl(text: string): { events: TraceEvent[]; truncatedTail: boolean; invalidLines: number } {
  const events: TraceEvent[] = [];
  let invalid = 0;
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = TraceEventSchema.parse(JSON.parse(lines[i]!));
      events.push(parsed);
    } catch {
      invalid++;
      // 只允许最后一行是"截断"。中间行解析失败是**文件损坏**，得单独报出来
      if (i !== lines.length - 1) continue;
      return { events, truncatedTail: true, invalidLines: invalid };
    }
  }
  return { events, truncatedTail: false, invalidLines: invalid };
}

// ── JUnit XML ─────────────────────────────────────────────────────────────

/**
 * 六态 → JUnit 四桶。这是整个 M6 最需要想清楚的一段，
 * 因为 JUnit 只有 pass/failure/error/skipped，而我们有六个状态。
 * **映射错一个，CI 的红绿就开始说谎**（docs/02 §6、docs/README 原则 7）。
 *
 * | 我们的状态 | JUnit | 理由 |
 * |---|---|---|
 * | pass | 通过 | — |
 * | fail | `<failure>` | 断言不成立 = 被测系统的问题。Jenkins 的 failure 正是这个语义 |
 * | error | `<error>` | 用例/环境跑不起来 ≠ 产品有 bug。分开才能让人不去查不存在的功能问题 |
 * | healed | **`<failure>`** | **关键**。JUnit 没有"软失败"这一桶。healed 是"自愈成功但未人审"，
 *   按"自愈 = 软失败 + 人审 diff"的设计，未审的自愈**不该让 CI 变绿**。
 *   映射成通过会造出"绿色构建点错按钮"那个经典事故（docs/00 §5.6）；
 *   映射成 skipped 更糟 —— 会被统计成"没跑"，看起来比红还无害 |
 * | skipped | `<skipped>` | 守卫不成立/前置未满足 |
 * | triaged | `<skipped>` + 属性 | 人已判定非产品 bug。不算失败也不该算通过：
 *   它表示"这一步跑出了东西，人看过了"。放进 pass 会把已知问题洗成健康 |
 *
 * healed/triaged 都额外带 `attn` 属性，便于看板与 CI 评论把它们单独列出来，
 * 而不是只在失败信息里躺着一行文案。
 */
function junitBucket(r: StepResult): 'pass' | 'failure' | 'error' | 'skipped' {
  switch (r.status) {
    case 'fail': return 'failure';
    case 'error': return 'error';
    case 'healed': return 'failure';
    case 'skipped': case 'triaged': return 'skipped';
    default: return 'pass';
  }
}

/**
 * XML 1.0 里**合法**的字符判定。
 *
 * 这条不是洁癖，是 JUnit 出口最常见的翻车点：
 * 响应体/页面文本/logcat 里出现 0x00–0x08 这类控制字符极其常见
 * （二进制字段、某些设备的 logcat、被截断的多字节字符）。
 * 直接写进去，XML 就**不合法**，Jenkins/GitLab 解析失败会**整份报告丢弃** ——
 * 于是构建看起来"没有测试报告"，而不是"有测试失败"。
 * 少一次红警比错一次红警更坏：没有任何信号进来。
 */
function xmlSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const okChar = c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
    // 非法字符替换成可见的占位（不是删掉）：删掉会让"哪个字段有问题"看不出来，
    // 而这类字符本身就是排查线索（多半是二进制塞进了文本字段）
    out += okChar && !Object.is(c, 0) ? ch : `\\u${c.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/** 属性与文本的转义**不一样**：属性里的引号必须转，否则属性提前闭合，
 *  后面的内容会变成标签 —— 那已经不是"报告难看"，是**注入**：
 *  测试名里塞 `" onclick="...` 会改写报告结构。 */
function xmlAttr(s: string): string {
  return xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlText(s: string): string {
  return xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface JUnitOptions {
  /** <testsuite name>。默认用场景 id */
  suiteName?: string;
  /** 类名分组（JUnit 的 classname，很多 CI 用它聚合）。默认用场景 id */
  classname?: string;
  /**
   * 未审自愈与已 triage 要不要判 fail。默认 **true**。
   *
   * 关掉它的唯一正当场景是把 JUnit 当纯展示导出；
   * 一旦接进门禁就关掉，等于把"healed 不算绿"这条原则在出口处作废 ——
   * 而这是最容易悄悄发生的地方，因为改动发生在"只是个导出器"的文件里。
   */
  failOnAttention?: boolean;
}

/**
 * call 步骤失败时，把**子场景里真正出问题的那一步**找出来。
 *
 * 为什么需要：call 步骤的摘要长这样
 * `子场景 下单：fail · 3 步计入通过率 · 67% 通过` —— 它说的是"子里有东西坏了"，
 * 而值班人要的是"哪一步坏了"。以前只能去 trace.jsonl 里按 path 翻。
 *
 * 只**报**、不**数**：子场景的结论仍然不进 tests 计数（一次子场景失败在父侧
 * 由 call 步骤带上来，见 CONTAINER_KINDS 与 gate.ts 的同一条理由），
 * 这里只是把父侧那一条 failure 的正文写清楚。
 * "什么算一条用例"全仓只有一个答案，这个函数不新增第二个。
 *
 * 往下钻而不是只报直接子层：A→B→C 而断言在 C 时，B 里 failing 的那行是它自己的
 * call 步骤，只报一层会停在"下单流程这个子场景挂了"。钻到最深那一层才是根因所在。
 * visited 防环（IR 的自引用在 lint 里有 CALL_SELF_REFERENCE 规则，但报告器不能
 * 靠"lint 一定跑过"来保证自己不死循环）。
 */
function childFailureOf(report: RunReport, callStepId: string): string | undefined {
  const chain = report.childRuns ?? [];
  const visited = new Set<string>();
  let stepId: string | undefined = callStepId;
  let out: string | undefined;
  while (stepId && !visited.has(stepId)) {
    visited.add(stepId);
    const entry = chain.find((c) => c.callStepId === stepId);
    if (!entry) break;
    // 只认 fail/error。不写 `find((r) => r.cause)`：
    // 那样一个**已通过的**步骤只要带着 cause（例如带归因的 fail→重试后 pass 的残留）
    // 就会被当成根因，把人说向一个没坏的地方。
    const bad = entry.results.find((r) => r.status === 'fail' || r.status === 'error');
    if (!bad) break;
    out = `${entry.scenario.id}/${bad.stepId}=${bad.status}${bad.cause ? `(${bad.cause})` : ''}${bad.assertionSummary ? ` ${bad.assertionSummary}` : ''}`;
    // 这一行自己就是 call => 根因还在下面一层
    stepId = bad.kind === 'call' ? bad.stepId : undefined;
  }
  return out;
}

/**
 * RunReport → JUnit XML。
 *
 * 三个容易做错、做错就"解析失败而不是显示失败"的点：
 *  1. **`time` 单位是秒**，不是毫秒。写成毫秒时 Jenkins 显示"耗时 8000s"，
 *     更糟的是有些解析器会当非法值而拒绝整个 suite。
 *  2. **tests / failures / errors / skipped 必须自洽**（sum == tests）。
 *     不一致时 GitLab 会显示"0/0"，CI 于是永远绿。
 *  3. 容器步骤与叶子步骤**只报叶子**：一个 forEach 报 3 条会让人以为有 3 个用例，
 *     而计数对不上真实用例数时，"覆盖率"这种数字就全废了。
 */
export function toJUnitXml(report: RunReport, opts: JUnitOptions = {}): string {
  const failOnAttention = opts.failOnAttention ?? true;
  const name = opts.suiteName ?? report.runId;
  const classname = opts.classname ?? name;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  let failures = 0;
  let errors = 0;
  let skipped = 0;

  const bodies: string[] = [];
  for (const r of report.results) {
    // 容器步骤不出 testcase：它们承载的是控制流结论，不是业务结论。
    // 报出去的话 tests 计数会大于真实用例数，看板的"用例数/覆盖率"全废。
    if (isContainer(r.kind)) continue;
    let bucket = junitBucket(r);
    // healed 默认按 failure 计（见上表）。failOnAttention=false 时降到 pass 并留属性，
    // 这样"纯展示导出"也不会丢信息。
    if (r.status === 'healed' && !failOnAttention) bucket = 'pass';
    if (r.status === 'triaged' && !failOnAttention) bucket = 'pass';
    if (bucket === 'failure') failures++;
    else if (bucket === 'error') errors++;
    else if (bucket === 'skipped') skipped++;

    const attrs = [
      `classname="${xmlAttr(classname)}"`,
      `name="${xmlAttr(r.stepId)}"`,
      // 秒，保留 3 位。毫秒是最常见的实现错误
      `time="${(Math.max(0, r.durMs) / 1000).toFixed(3)}"`,
    ];
    if (r.status === 'healed') attrs.push('attn="healed-unreviewed"');
    if (r.status === 'triaged') attrs.push('attn="triaged"');
    /*
     * **重试之后才通过的步骤也要留痕**。撤行修复之后这种步骤的状态就是 pass，
     * 光看 bucket 一条都拦不住（与 healed 需要单独一个 attn 是同一个理由）。
     * 不进 <failure>：JUnit 里 failure 会计数并让 job 变红，
     * 而重试吸收抖动正是 retry 存在的意义 —— 判红等于叫别人别配 retry。
     * 属性名复用 attn，让 CI 侧一条 grep 就能拉出"所有需要看一眼但不用改的"。
     */
    if (isFlakyPass(r)) attrs.push(`attn="flaky-recovered" attempts="${flakyAttempts(r).length + 1}"`);
    if (r.resolvedBy) attrs.push(`resolvedBy="${xmlAttr(r.resolvedBy)}"`);

    const open = `<testcase ${attrs.join(' ')}>`;
    if (bucket === 'pass') { bodies.push(`  <testcase ${attrs.join(' ')} />`); continue; }
    if (bucket === 'skipped') {
      bodies.push(`  ${open}<skipped message="${xmlAttr(r.assertionSummary ?? r.status)}" /></testcase>`);
      continue;
    }
    const tag = bucket;
    // type 用 cause：CI 界面通常把它单独显示成一行，写"product-bug"/"case-stale"
    // 比写 "AssertionError" 有用 —— 前者直接告诉值班人该找谁
    const childBad = r.kind === 'call' && (bucket === 'failure' || bucket === 'error')
      ? childFailureOf(report, r.stepId)
      : undefined;
    const detail = [
      `step=${r.stepId}`, `kind=${r.kind}`, `status=${r.status}`,
      r.cause ? `cause=${r.cause}` : '', r.assertionSummary ?? '',
      // 只有父侧这一条的正文里出现子场景步骤 id：**不另开 testcase**，
      // 所以 CI 侧按 `<testcase>` 数的"用例数"不会被子场景虚增
      childBad ? `根因在子场景步骤：${childBad}` : '',
      Object.keys(r.keyContext ?? {}).length ? `context=${JSON.stringify(redactForDisk(r.keyContext ?? {}))}` : '',
      r.artifactIds.length ? `artifacts=${r.artifactIds.join(',')}` : '',
    ].filter(Boolean).join('\n');
    bodies.push(`  ${open}<${tag} type="${xmlAttr(r.cause ?? tag)}" message="${xmlAttr(oneLine(r.assertionSummary ?? ''))}">${xmlText(detail)}</${tag}></testcase>`);
  }

  const total = report.results.filter((r) => !isContainer(r.kind)).length;
  lines.push(`<testsuites tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(Math.max(0, report.durMs) / 1000).toFixed(3)}">`);
  lines.push(`  <testsuite name="${xmlAttr(name)}" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(Math.max(0, report.durMs) / 1000).toFixed(3)}" timestamp="${new Date(report.startedAt).toISOString()}">`);
  lines.push(...bodies);
  lines.push(`    <system-out>${xmlText(report.summary)}</system-out>`);
  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}



function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 500);
}

// ── evidence 包清单 ───────────────────────────────────────────────────────

/** evidence.zip 里的固定成员。**写死顺序与名字**，因为它是要被人解压后直接看的：
 *  名字一变，所有指向它的文档、CI 评论模板、看板链接全都要跟着改。 */
export const EVIDENCE_FILES = {
  trace: 'trace.jsonl',
  junit: 'junit.xml',
  manifest: 'manifest.json',
  summary: 'summary.txt',
  artifactsDir: 'artifacts',
} as const;

export interface EvidenceManifest {
  runId: string;
  status: string;
  startedAt: string;
  durMs: number;
  /** 场景与版本指纹。缺 provenance 时 CI 要拒绝（M7），这里先如实记下来 */
  scenario: { id: string; name: string; versionId?: string; frozen: boolean; irSha?: string };
  tally: RunReport['tally'];
  costUsd: number;
  /**
   * 每个证据的 kind / 字节 / sha256 / 所属步骤。内容寻址，同内容同 id。
   *
   * **这一栏是"这次 run 声明了什么"，不是"zip 里有什么"** —— 两者可以不一致，
   * 差异由 `missing` 解释。写成后者会出这种事：磁盘上的证据被清理任务收走之后，
   * 清单变成"这个场景没产证据"，而真相是"产了、现在取不到"。
   * 人拿着包排查时，这两个结论指向完全不同的下一步动作（查平台 vs 查清理策略）。
   *
   * `bytes` 可选：磁盘上的文件已经取不到、且本进程没写过它（回放/换进程）时无从得知。
   * **宁可不写，也不写 0** —— 0 字节是个合法值，会被读成"响应体是空的"。
   */
  artifacts: Array<{ id: string; kind: string; stepId?: string; bytes?: number; sha256: string }>;
  /**
   * 声明了但**没能装进包**的证据 id（被清理、写盘失败、磁盘故障）。
   *
   * 必须进包，不能只留在 CLI 的 stderr：evidence.zip 是**给别人下载**的东西，
   * 拿到包的人看不到 CI 那行"注意：有 N 个证据取不到"，于是他只会看到
   * "artifacts 里没有这一步的响应体"，最自然的结论是"平台没存"。
   */
  missing?: string[];
  /** 脱敏策略。**必须写进包里**：拿到包的人要能知道"内容被改过、按什么规则改的"，
   *  否则证据不能当事故复盘的依据（"你怎么证明响应体没被动过"） */
  redaction: { keyRules: 'applied'; valueRules: 'applied'; rawArtifacts: 'unmodified'; note: string };
  /** 引擎与 IR 版本。回放不一致时第一个要看的就是这个 */
  versions: { engine: string; ir: string };
}

/** 清单序列化。脱敏在这里做（而不是在上游），因为清单**就是要落盘** */
export function manifestJson(m: EvidenceManifest): string {
  return `${JSON.stringify(redactForDisk(m), null, 2)}\n`;
}

/** 人类可读摘要。给 CI 日志和 PR 评论用，不进机器解析路径 */
export function summaryText(report: RunReport, m: EvidenceManifest): string {
  const t = report.tally;
  const counted = t.pass + t.fail + t.error + t.healed;
  const rate = counted ? Math.round((t.pass / counted) * 100) : 100;
  const bad = report.results.filter((r) => r.status === 'fail' || r.status === 'error');
  const attn = report.results.filter((r) => r.status === 'healed' || r.status === 'triaged');
  const lines = [
    `运行 ${report.runId} — ${report.status}`,
    `场景 ${m.scenario.id} · ${m.scenario.frozen ? '已冻结' : '未冻结（CI 不应执行）'} · ${(report.durMs / 1000).toFixed(1)}s`,
    `计入 ${counted} 步：${t.pass} 通过 / ${t.fail} 失败 / ${t.error} 错误 / ${t.healed} 自愈待审 / ${t.skipped} 跳过 — ${rate}%`,
    // 币种符号统一用 $：字段就叫 costUsd，docs/03 §2 的预算也是按美元定的。
    // 标 ¥ 要么是在撒谎（数值没换算），要么就得引入汇率换算 —— 两个都比少一个符号糟
    `成本 $${report.costUsd.toFixed(4)}`,
  ];
  if (bad.length) lines.push('', `需要处理（${bad.length}）：`, ...bad.map((r) => `  ✗ ${r.stepId} [${r.status}${r.cause ? ` ${r.cause}` : ''}] ${r.assertionSummary ?? ''}`));
  // 自愈单独列一段：它不该混在失败里（会让人以为功能坏了），也不该看不见
  if (attn.length) lines.push('', `需要人审（${attn.length}）：`, ...attn.map((r) => `  ~ ${r.stepId} [${r.status}] ${r.assertionSummary ?? ''}`));
  return `${lines.join('\n')}\n`;
}

/** 步骤结果数组的运行时校验（读磁盘上的旧报告时用；版本漂移要在这里挡，不要在深处炸） */
export function parseStepResults(raw: unknown): StepResult[] {
  return (Array.isArray(raw) ? raw : []).map((x) => StepResultSchema.parse(x));
}
