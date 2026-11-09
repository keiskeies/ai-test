/**
 * 静态闸（docs/02 §7）—— AI 生成的 IR 必须先穿过它。
 *
 * 为什么这是产品级要点而不是代码质量工具：本平台的核心卖点是
 * 「一句话生成用例」，而 LLM 生成用例的头号失败模式是
 * **产出几百条可读、只断 status==200、永远绿、什么都抓不住的用例**（docs/00 §6.1）。
 * 因为 IR 是结构化数据而非不透明脚本，这些检查才写得出来 ——
 * 已知没有任何竞品做「无断言用例 lint」（docs/00 §4.4）。
 */
import type { Scenario, Step, StepResult } from '@atest/ir';
import { LEASE_REQUIRED, STATE_MUTATING, STEP_TARGET, walk } from '@atest/ir';
import { parsePath, parseRef, PathError } from './jsonpath.js';
import { validateExpr } from './expr.js';
import { HIERARCHY_ONLY_ASSERTS, PIXEL_CAPABLE_ASSERTS, VarRefPattern } from '@atest/ir';

export type LintLevel = 'error' | 'warning';

export interface LintIssue {
  code: LintCode;
  level: LintLevel;
  stepId?: string;
  message: string;
  /** 可直接照做的修法。报错质量决定用户是否会真的修 */
  fix?: string;
  doc?: string;
}

export type LintCode =
  | 'ASSERT_FREE_STEP' | 'ASSERT_FREE_SCENARIO' | 'SLEEP_USED' | 'LOOP_UNBOUNDED'
  | 'VAR_UNDEFINED' | 'DEPENDENCY_CYCLE' | 'LITERAL_OVERFIT' | 'HARDCODED_SECRET'
  | 'RESOURCE_LEASE_MISSING' | 'TEARDOWN_DIRTY' | 'CROSS_TARGET_MISSING_WAIT'
  | 'STEP_BUDGET_EXCEEDED' | 'EXPR_SYNTAX' | 'DUPLICATE_STEP_ID' | 'CLEARDATA_VS_PRESERVE_SESSION'
  | 'PIXEL_ASSERT_ON_NONHIERARCHY' | 'NEGATIVE_ASSERT_VISION_BASED' | 'TEMPLATE_NOT_UNIQUE'
  | 'TEMPLATE_NO_ROI' | 'LLM_ASSERT_RATIO_HIGH' | 'VISION_STEP_IN_CI_GATE' | 'DEPRECATED_OPERATION'
  | 'SELF_REFERENCING_CALL' | 'INPUT_UNUSED';

export interface LintContext {
  /** 已导入资源的快照能力。缺省时跳过依赖资源的检查（CLI 单独 lint 一个文件时的正常状态） */
  snapshotKinds?: Record<string, 'aria' | 'hierarchy' | 'pixels' | 'none'>;
  /** 已知的 call 目标（用于环检测）。缺省时跳过环检测 */
  scenarioGraph?: Record<string, string[]>;
  /** 步骤 id → 该步骤目标界面的快照种类（更细粒度） */
  stepSnapshotKind?: Record<string, string>;
  maxCostUsd?: number;
  /** 本场景已覆盖的组合（覆盖增量预览用，由调用方算好传入） */
  coverageDelta?: { newCombinations: number; generated: number };
}

/**
 * 值形态判据：不管键叫什么，出现这些形状就是凭证。
 * （另一类判据是**键名**，见 CREDENTIAL_FIELD_RE —— 两类各有必要：
 *  攻击者/新手会把口令放进名为 `pw` 或 `note` 的字段，也会给 JWT 起个无害的键名。）
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/, 'JWT'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API Key（sk- 前缀）'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, '私钥'],
];

/**
 * 键名判据。**不能**用扫序列化文本的老写法：`JSON.stringify` 出来是
 * `"password":"hunter2"`，`password` 后面紧跟的是引号而不是冒号，
 * 于是 `(password|…)\s*[:=]\s*` 这种写法永远匹配不上 —— 一条安全规则
 * 静默全量放行，是所有 bug 里最糟的一种（它让「有 lint」变成错觉）。
 *
 * 与 redact() 的 SECRET_KEY_RE 有意不同：那个还包含 phone/idCard（PII，
 * 属于脱敏范畴），这里只认「能拿来认证的东西」（PII 写死是 LITERAL_OVERFIT 的活）。
 */
const CREDENTIAL_FIELD_RE = /^(password|passwd|pwd|pass|secret|secretKey|token|accessToken|access_token|refreshToken|apiKey|api_key|apikey|appSecret|accessKey|access_key|clientSecret|client_secret|authorization|auth|credential|privateKey)$/i;

/** 允许出现在凭证字段里的值：密钥引用、变量引用、模板占位。其余字面量一律算硬编码。 */
const SAFE_VALUE_RE = /^(secret:[A-Za-z0-9_-]+)$/;

/** 深度遍历 IR，把「凭证字段名 + 明文值」的位置连同样例值一起交出来。 */
function findHardcodedSecrets(node: unknown, stepId: string | undefined, path: string, out: { stepId?: string; path: string; key: string; sample: string }[]): void {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      const id = (v as { id?: unknown })?.id;
      findHardcodedSecrets(v, typeof id === 'string' ? id : stepId, `${path}[${i}]`, out);
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const isRef = (v as unknown) !== undefined && (SAFE_VALUE_RE.test(v) || v.includes('$') || v.includes('{{'));
      if (CREDENTIAL_FIELD_RE.test(k) && v.length >= 4 && !isRef) {
        // 只交出前 4 个字符。整条明文出现在报错里，等于把密钥贴进 CI 日志
        out.push({ stepId, path: `${path}.${k}`, key: k, sample: `${v.slice(0, 3)}…(${v.length} 字符)` });
      }
    } else {
      const id = (v as { id?: unknown })?.id;
      findHardcodedSecrets(v, typeof id === 'string' ? id : stepId, `${path}.${k}`, out);
    }
  }
}

/** 疑似「唯一值」的字段名。出现字面量就该改用生成器（docs/11 Q6） */
const UNIQUE_FIELD_RE = /(uuid|guid|orderId|orderNo|traceId|requestId|serialNo|idNo|identity|mobile|phone|email|token|session)/i;
/** 疑似「不该精确断言」的字段名。LLM 最容易在这里过拟合（docs/00 §6.3） */
const VOLATILE_FIELD_RE = /(id|uuid|guid|time|date|timestamp|at$|created|updated|seq|nonce|sign|checksum|total$|amount|price|count)/i;

/**
 * 每条规则的文档出处。**类型是 Record<LintCode, string>，所以新增规则时必须在此登记**
 * —— 漏写会编译不过。
 *
 * 为什么做成中心表而不是每条 push 各写一遍：报错可溯源是设计约定（docs/12 §4.4：
 * 「为什么红」必须能在 30 秒内查到设计意图），而散落的字面量必然出现漏写与漂移。
 * 单条规则想指向更精确的小节，仍可在 push 里显式传 doc 覆盖这里。
 */
export const LINT_DOCS: Record<LintCode, string> = {
  ASSERT_FREE_STEP: 'docs/00 §4.4、docs/05 §3',
  ASSERT_FREE_SCENARIO: 'docs/11 §2.2',
  SLEEP_USED: 'docs/02 §3',
  LOOP_UNBOUNDED: 'docs/02 §2',
  VAR_UNDEFINED: 'docs/02 §5',
  DEPENDENCY_CYCLE: 'docs/02 §2',
  LITERAL_OVERFIT: 'docs/02 §4、docs/00 §6.3',
  HARDCODED_SECRET: 'docs/02 §5、docs/03 §5',
  RESOURCE_LEASE_MISSING: 'docs/07 §2',
  TEARDOWN_DIRTY: 'docs/05 §5',
  CROSS_TARGET_MISSING_WAIT: 'docs/02 §7',
  STEP_BUDGET_EXCEEDED: 'docs/03 §1、docs/03 §2',
  EXPR_SYNTAX: 'docs/02 §5',
  DUPLICATE_STEP_ID: 'docs/02 §5',
  CLEARDATA_VS_PRESERVE_SESSION: 'docs/07 §5',
  PIXEL_ASSERT_ON_NONHIERARCHY: 'docs/10 §5',
  NEGATIVE_ASSERT_VISION_BASED: 'docs/10 §4',
  TEMPLATE_NOT_UNIQUE: 'docs/10 §2',
  TEMPLATE_NO_ROI: 'docs/10 §2',
  LLM_ASSERT_RATIO_HIGH: 'docs/10 §4、docs/03 §4',
  VISION_STEP_IN_CI_GATE: 'docs/10 §5',
  DEPRECATED_OPERATION: 'docs/05 §1',
  SELF_REFERENCING_CALL: 'docs/02 §2',
  INPUT_UNUSED: 'docs/02 §5',
};

/** 表达式语法错误的修法。两处（condition / when）共用，避免文案漂移 */
const EXPR_SYNTAX_FIX = '支持：字面量、$.路径、算术、比较、and/or/not、in，以及 count/sum/avg/min/max/len/contains/matches 等函数';

export function lintScenario(scenario: Scenario, ctx: LintContext = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  // doc 缺省时从 LINT_DOCS 兜上，保证「每条报错都有出处」是无条件的性质，
  // 不依赖每位作者都记得写。
  const push = (i: LintIssue): void => { issues.push({ ...i, doc: i.doc ?? LINT_DOCS[i.code] }); };

  const allSteps: Step[] = [];
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => allSteps.push(s));

  // ── 步骤 id 唯一性（变量引用靠它，重复会导致引用歧义）───────────────
  const seen = new Map<string, number>();
  for (const s of allSteps) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
  for (const [id, n] of seen) {
    if (n > 1) push({ code: 'DUPLICATE_STEP_ID', level: 'error', stepId: id, message: `步骤 id "${id}" 出现 ${n} 次`, fix: '步骤 id 必须运行内唯一，否则 $.step  引用会产生歧义' });
  }

  // ── 变量定义/引用（未定义检测）────────────────────────────────────
  const defined = new Set<string>();
  for (const p of scenario.inputs) defined.add(p.name);
  defined.add('run'); defined.add('env'); defined.add('secret'); defined.add('outputs');
  const refsAt: { ref: string; stepId: string; definedAtOrder: number; useOrder: number }[] = [];
  const stepExportOrder = new Map<string, number>();
  const stepExports = new Map<string, Set<string>>();
  let order = 0;

  const collectDefs = (s: Step): void => {
    order++;
    stepExportOrder.set(s.id, order);
    if (s.kind === 'set') for (const k of Object.keys(s.assign)) { defined.add(k.split('.')[0]!); }
    if (s.kind === 'extract') { const set = stepExports.get(s.id) ?? new Set(); for (const r of s.rules) { defined.add(r.var); set.add(r.var); } stepExports.set(s.id, set); }
    if (s.kind === 'http' || s.kind === 'openapiCall') {
      const set = stepExports.get(s.id) ?? new Set<string>(['resp', 'status', 'body']);
      if (s.kind === 'http' && s.saveAs) defined.add(s.saveAs);
      stepExports.set(s.id, set);
    }
    if (s.kind === 'db' && s.assignTo) defined.add(s.assignTo);
    if (s.kind === 'call' && s.assignTo) defined.add(s.assignTo);
    if (s.kind === 'forEach') defined.add(s.as), defined.add(s.indexAs ?? ''), defined.delete('');
    if (s.kind === 'table') defined.add('rows'), defined.add(s.as);
    if (s.kind === 'dataSource') defined.add('rows');
    if (s.kind === 'script') for (const v of s.outputVars) defined.add(v);
  };

  // 先按文档顺序收集定义（同一层的 forEach 变量在子步骤里才可见，这里按保守处理：
  // 只要在整个场景里出现过定义就不报未定义 —— 宁可漏报也不误报，误报会让人关 lint）
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => collectDefs(s));

  const checkRefs = (s: Step): void => {
    const strings: string[] = [];
    const collect = (v: unknown, depth = 0): void => {
      if (depth > 5 || v === null || v === undefined) return;
      if (typeof v === 'string') { if (v.includes('$')) strings.push(v); return; }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const x of v) collect(x, depth + 1); return; }
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // 只对可能承载引用的字段做检查，避免把 JSONPath 断言键误当引用
        if (['jsonPath', 'ariaYaml'].includes(k)) continue;
        collect(x, depth + 1);
      }
    };
    collect(s);
    for (const str of strings) {
      // 必须同时吃 `$name` 与 `$.name`：早先只写 `\$[A-Za-z_]` 时，`$.step.x` 因为
      // $ 后面是点号而**一个都匹配不上**，于是「引用不存在的步骤」「前向引用」
      // 这两类检查实际上从未执行过 —— 静态闸看起来有 24 条规则，实际少两条且无声。
      for (const m of str.matchAll(VarRefPattern)) {
        const ref = m[0];
        let info;
        try { info = parseRef(ref); } catch { continue; }
        if (info.scope === 'step' && info.stepId) {
          if (!stepExports.has(info.stepId)) {
            push({ code: 'VAR_UNDEFINED', level: 'error', stepId: s.id, message: `引用了步骤 "${info.stepId}" 的输出，但该步骤不存在`, fix: `确认 id 拼写，或在 ${s.id} 之前加入该步骤`, doc: 'docs/02 §5' });
          } else if ((stepExportOrder.get(info.stepId) ?? 0) > (stepExportOrder.get(s.id) ?? 0)) {
            push({ code: 'VAR_UNDEFINED', level: 'error', stepId: s.id, message: `引用 ${ref} 早于该步骤的执行顺序`, fix: '把引用它的步骤移到被引用步骤之后（或改用 call 子场景返回值）', doc: 'docs/02 §5' });
          } else if (info.rest) {
            // rest 形如 `.resp.data.id`（parseRef 保留了前导点），所以**必须先去掉点号**
            // 再取头段 —— 否则 split 出来是空串，于是每个合法的 `$.step.x.resp` 引用
            // 都会被报成「步骤 x 未见导出 ""」。
            const head = info.rest.replace(/^[.$]+/, '').split(/[.[]/)[0]!;
            const exports = stepExports.get(info.stepId)!;
            if (exports.size && !exports.has(head) && !['resp', 'status', 'body'].includes(head)) {
              push({ code: 'VAR_UNDEFINED', level: 'warning', stepId: s.id, message: `引用 ${ref}，但步骤 ${info.stepId} 未见导出 "${head}"`, fix: `该步骤实际导出：${[...exports].join(', ') || '(未知)'}` });
            }
          }
        } else if (info.scope === undefined && info.rest) {
          const head = info.rest.split(/[.[]/)[0]!;
          if (head && !defined.has(head)) {
            push({ code: 'VAR_UNDEFINED', level: 'error', stepId: s.id, message: `引用了未定义变量 ${ref}`, fix: '用 set/extract/inputs 声明它；变量作用域见 docs/02 §5' });
          }
        }
        refsAt.push({ ref, stepId: s.id, definedAtOrder: 0, useOrder: 0 });
      }
    }
    // 表达式语法
    if ('condition' in s && typeof s.condition === 'string') {
      const e = validateExpr(s.condition);
      if (e) push({ code: 'EXPR_SYNTAX', level: 'error', stepId: s.id, message: `condition 表达式语法错误：${e}`, fix: EXPR_SYNTAX_FIX });
    }
    if (s.when) {
      const e = validateExpr(s.when);
      if (e) push({ code: 'EXPR_SYNTAX', level: 'error', stepId: s.id, message: `when 表达式语法错误：${e}`, fix: EXPR_SYNTAX_FIX });
    }
  };
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => checkRefs(s));

  // ── 逐步骤规则 ──────────────────────────────────────────────────
  let leaseAcquiredAt = -1;
  let hasSleep = false;
  let llmAsserts = 0;
  let totalAsserts = 0;
  let mutating = false;
  let orderIdx = 0;
  const mutatingSteps: Step[] = [];

  walk(scenario.body, (s, path) => {
    orderIdx++;
    void path;
    // 无断言步骤：零断言且无任何下游消费者 → no-op（docs/00 §4.4，20 行检查打头号为失败模式）
    if (['http', 'openapiCall'].includes(s.kind)) {
      const id = s.id;
      const asserted = allSteps.some((a) =>
        ['assert', 'assertLlm', 'assertPage', 'assertUi', 'assertPerf'].includes(a.kind) &&
        JSON.stringify(a).includes(`step.${id}`),
      );
      const consumed = allSteps.some((a) => a.id !== id && JSON.stringify(a).includes(`step.${id}`) && a.kind !== 'http' && a.kind !== 'openapiCall');
      if (!asserted && !consumed) {
        push({
          code: 'ASSERT_FREE_STEP', level: 'error', stepId: id,
          message: `${s.kind} 步骤没有任何断言，也没有被下游引用 —— 它永远绿，什么都抓不住`,
          fix: '加 assert 节点（status/jsonPath），或让后续步骤 extract/引用它的响应',
          doc: 'docs/00 §4.4、docs/05 §3',
        });
      }
    }
    if (s.kind === 'sleep') { hasSleep = true; push({ code: 'SLEEP_USED', level: 'warning', stepId: s.id, message: `使用裸 sleep(${s.ms}ms)：每个固定延时都是一颗未来的 flake + 一次套件变慢`, fix: '改用 wait{condition,timeoutMs,pollMs}；IR 里 wait 没有 duration 字段是有意的', doc: 'docs/02 §3' }); }
    if (s.kind === 'while' && s.maxIterations > 500) push({ code: 'LOOP_UNBOUNDED', level: 'warning', stepId: s.id, message: `while 上限 ${s.maxIterations} 偏大`, fix: '有界循环是可回放的前提；上限应来自业务语义而非随手写个大数' });
    if (s.kind === 'device') leaseAcquiredAt = orderIdx;
    if (LEASE_REQUIRED.includes(s.kind) && leaseAcquiredAt < 0 && scenario.targets.some((t) => ['android', 'ios', 'harmony'].includes(t))) {
      push({ code: 'RESOURCE_LEASE_MISSING', level: 'error', stepId: s.id, message: `设备步骤 ${s.kind} 之前没有 device 租约`, fix: '在场景开头加 { kind:"device", require:{…} } 申请租约' });
    }
    if (s.kind === 'app' && s.action === 'clearData') {
      // 与 preserveSession 互斥（docs/07 §5）
      const keeps = allSteps.some((a) => a.kind === 'useIdentity' && a.preserveSession);
      if (keeps) push({ code: 'CLEARDATA_VS_PRESERVE_SESSION', level: 'error', stepId: s.id, message: 'app.clearData 与会话复用（preserveSession）互斥：清数据会踢掉登录态，后续步骤必然卡在登录页', fix: '要么不清数据，要么在 setup 里显式登录后再清' });
    }
    if (STATE_MUTATING.includes(s.kind)) { mutating = true; mutatingSteps.push(s); }
    if (s.kind === 'openapiCall' && s.strategy === 'contract') {
      // 符合性检查必须走独立车道（docs/00 §6.2）
    }
    if (s.kind === 'assertLlm') { llmAsserts++; totalAsserts++; }
    if (['assert', 'assertPage', 'assertUi'].includes(s.kind)) totalAsserts++;

    // 字面量过拟合检测（LITERAL_OVERFIT）
    if (s.kind === 'assert') {
      for (const [p, clause] of Object.entries(s.jsonPath ?? {})) {
        const field = p.split('.').pop() ?? p;
        const exact = (clause as { exact?: unknown }).exact;
        if (exact === undefined) continue;
        const looksVolatile = VOLATILE_FIELD_RE.test(field);
        const looksLiteral = typeof exact === 'string' ? /\d{6,}|[0-9a-f]{8}-|\d{4}-\d{2}-\d{2}/.test(exact) : typeof exact === 'number' && String(exact).length > 8;
        if (looksVolatile && looksLiteral) {
          push({
            code: 'LITERAL_OVERFIT', level: 'warning', stepId: s.id,
            message: `对疑似易变字段 "${field}" 做了精确相等断言（${JSON.stringify(exact)}）—— 极可能是从唯一一条样本响应里过拟合出来的`,
            fix: '改用 shape（uuid/snowflake/datetime…）或 matches 正则；确实要精确就加注释说明理由',
            doc: 'docs/02 §4、docs/00 §6.3',
          });
        }
      }
    }
    // 像素世界断言合法性（docs/10 §5）
    // 触发条件不能要求 snapshotKinds 一定存在：调用方只给 stepSnapshotKind
    // （「就这一步的目标是自绘界面」）是混合场景里最常见的用法，
    // 那种情况下这两条规则理应照样生效。
    if ((s.kind === 'assertUi' || s.kind === 'assertPage') && (ctx.snapshotKinds || ctx.stepSnapshotKind)) {
      const kind = ctx.stepSnapshotKind?.[s.id] ?? inferSnapshotKind(s, ctx);
      const assertKind = (s as unknown as { assertKind: string }).assertKind;
      if (kind === 'pixels' && HIERARCHY_ONLY_ASSERTS.includes(assertKind)) {
        push({ code: 'PIXEL_ASSERT_ON_NONHIERARCHY', level: 'error', stepId: s.id, message: `目标是自绘界面（pixels），不能用层级断言 ${assertKind}`, fix: `像素世界可用的断言：${PIXEL_CAPABLE_ASSERTS.join(' / ')}`, doc: 'docs/10 §5' });
      }
      if (kind === 'pixels' && assertKind === 'absent') {
        push({ code: 'NEGATIVE_ASSERT_VISION_BASED', level: 'error', stepId: s.id, message: '像素世界的「不存在」不能靠视觉模型判定（模型倾向过度报告存在）', fix: '用成对判据：上一帧 templateHit + 本帧 templateMiss', doc: 'docs/10 §4' });
      }
    }
    // 模板唯一性 / ROI
    // device 节点的 target 是平台枚举（字符串），不是定位器 —— 必须先过对象判定
    const rawLoc: unknown = 'locator' in s ? (s as { locator?: unknown }).locator
      : 'target' in s ? (s as { target?: unknown }).target : undefined;
    const loc = rawLoc && typeof rawLoc === 'object' && 'intent' in (rawLoc as object)
      ? (rawLoc as { compiledTo?: { kind: string; occurrences: number; nearText?: string; roi?: unknown }; replayable: boolean })
      : undefined;
    if (loc?.compiledTo?.kind === 'template') {
      const t = loc.compiledTo;
      if ((t.occurrences ?? 0) > 1 && !t.nearText) push({ code: 'TEMPLATE_NOT_UNIQUE', level: 'error', stepId: s.id, message: `模板在全帧命中 ${t.occurrences} 次且无邻近文本消歧 —— 会静默点到第一个`, fix: '补 nearText，或改用带 index 的实例定位', doc: 'docs/10 §2' });
      if (!t.roi) push({ code: 'TEMPLATE_NO_ROI', level: 'warning', stepId: s.id, message: '模板无 ROI（全帧多尺度搜索）', fix: '记录 bbox 外扩 30–50% 的 ROI，否则耗时到 10²ms 级' });
    }
    if (loc && !loc.replayable && scenario.frozen) {
      push({ code: 'VISION_STEP_IN_CI_GATE', level: 'error', stepId: s.id, message: '不可回放步骤（纯视觉坐标）出现在已冻结场景里 —— 冻结意味着可进 CI', fix: '把该步骤编译成模板指纹，或改用层级定位', doc: 'docs/10 §5' });
    }
  });

  // ── 场景级规则 ──────────────────────────────────────────────────
  if (totalAsserts === 0) {
    push({ code: 'ASSERT_FREE_SCENARIO', level: 'error', message: '整个场景没有任何断言 —— 它永远绿，属于信誉负债而非资产', fix: '至少加一个 status / jsonPath / ARIA 结构断言', doc: 'docs/11 §2.2' });
  }
  if (llmAsserts && totalAsserts && llmAsserts / totalAsserts > 0.5) {
    push({ code: 'LLM_ASSERT_RATIO_HIGH', level: 'warning', message: `语义断言占比 ${Math.round((llmAsserts / totalAsserts) * 100)}% —— 该场景红绿含义与结构化场景完全不同`, fix: '报告需标注此事实；能结构化的断言（DB 行、接口响应、ARIA）优先', doc: 'docs/10 §4' });
  }
  if (mutating && scenario.teardown.length === 0) {
    push({ code: 'TEARDOWN_DIRTY', level: 'warning', message: '有写操作但无 teardown —— 会留脏数据，且数据驱动迭代会互踩', fix: '加 teardown（调用删除接口或 db 清理），或显式设 config.dirty=true 并接受独占并行组', doc: 'docs/05 §5' });
  }
  if (!hasSleep) { /* 无 sleep 是好事，不需要提示 */ }

  // 跨端等待缺失：API 写 → UI/设备读 之间没有 wait（docs/02 §7）
  const flat = allSteps;
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i]!;
    if (!['http', 'openapiCall'].includes(a.kind)) continue;
    const writes = a.kind === 'http' ? ['POST', 'PUT', 'PATCH', 'DELETE'].includes(a.request.method) : true;
    if (!writes) continue;
    for (let j = i + 1; j < flat.length; j++) {
      const b = flat[j]!;
      if (['tap', 'input', 'assertUi', 'assertPage', 'act'].includes(b.kind)) {
        const between = flat.slice(i + 1, j);
        if (!between.some((x) => x.kind === 'wait')) {
          push({ code: 'CROSS_TARGET_MISSING_WAIT', level: 'warning', stepId: b.id, message: `接口写（${a.id}）之后直接读界面（${b.id}），中间没有 wait`, fix: '加 wait{condition:{type:"dbRow"|"uiIdle"|…}} —— 异步落库/渲染不会自己等你', doc: 'docs/02 §3' });
        }
        break;
      }
    }
  }

  // 密钥硬编码（HARDCODED_SECRET）
  const text = JSON.stringify(scenario, null, 0);
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) push({ code: 'HARDCODED_SECRET', level: 'error', message: `疑似硬编码凭证（${label}）`, fix: '改用 secret:<opaque_ref>；引擎在发请求那一刻才解析，Agent 上下文永远看不到真实值', doc: 'docs/02 §5、docs/03 §5' });
  }
  for (const hit of (() => { const out: { stepId?: string; path: string; key: string; sample: string }[] = []; findHardcodedSecrets(scenario, undefined, '$', out); return out; })()) {
    push({
      code: 'HARDCODED_SECRET', level: 'error', stepId: hit.stepId,
      message: `字段 "${hit.key}"（${hit.path}）里写了明文凭证 ${hit.sample}`,
      fix: '改成 secret:<opaque_ref>。引擎在发出请求那一刻才解析真值，Agent 上下文与 trace 落盘只见占位符',
      doc: 'docs/02 §5、docs/03 §5',
    });
  }
  // 唯一值字面量（迁移与生成的常见病灶）
  for (const m of text.matchAll(/"(uuid|orderId|orderNo|traceId|mobile|phone|email|idNo)"\s*:\s*"([^"]{4,})"/gi)) {
    if (!m[2]?.includes('$') && !m[2]?.includes('{')) {
      push({ code: 'LITERAL_OVERFIT', level: 'warning', message: `疑似唯一字段 "${m[1] ?? ''}" 写死了具体值 "${(m[2] ?? '').slice(0, 24)}"`, fix: '改用 {gen:"uuid"} 之类的生成器或 inputs 传入，否则换个环境必失败', doc: 'docs/05 §5' });
    }
  }

  // 成本上限
  const cap = ctx.maxCostUsd ?? 2;
  if (scenario.config.maxCostUsd > cap) {
    push({ code: 'STEP_BUDGET_EXCEEDED', level: 'warning', message: `maxCostUsd=${scenario.config.maxCostUsd} 超过项目上限 ${cap}`, fix: '拆分场景，或把视觉兜底改成本地模型（docs/03 §1）' });
  }

  // call 环检测
  if (ctx.scenarioGraph) {
    const stack = new Set<string>([scenario.id]);
    const visit = (id: string, chain: string[]): void => {
      for (const next of ctx.scenarioGraph?.[id] ?? []) {
        if (stack.has(next)) { push({ code: 'DEPENDENCY_CYCLE', level: 'error', message: `call 依赖成环：${[...chain, next].join(' → ')}`, fix: '把公共步骤抽成第三个场景让双方 call 它' }); continue; }
        stack.add(next); visit(next, [...chain, next]); stack.delete(next);
      }
    };
    visit(scenario.id, [scenario.id]);
  }
  for (const s of allSteps) {
    if (s.kind === 'call' && s.scenarioRef.split('@')[0] === scenario.id) {
      push({ code: 'SELF_REFERENCING_CALL', level: 'error', stepId: s.id, message: '场景 call 自身（无限递归）', fix: '抽公共步骤到独立场景' });
    }
  }

  // 声明了却没用的输入。
  // 判据必须是**步骤正文里有没有引用它**，不能拿整个 IR 文本 substring 匹配 ——
  // 输入自己的声明（`{"name":"sku",…}`）就包含这个名字，所以旧写法恒为真，
  // 这条规则从来没报过。同时不再只查 required=false：声明了不用的必填输入
  // 更糟（它强迫每个调用方提供一个没人看的参数）。
  const stepsText = JSON.stringify([...scenario.setup, ...scenario.body, ...scenario.teardown]);
  for (const p of scenario.inputs) {
    const used = new RegExp(`\\$\\.(run\\.)?inputs\\.${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(stepsText)
      || new RegExp(`"${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`).test(stepsText)
      || stepsText.includes(`$${p.name}`);
    if (!used) {
      push({ code: 'INPUT_UNUSED', level: 'warning', stepId: undefined, message: `输入参数 "${p.name}" 声明了但没有任何步骤使用${p.required ? '（而且是必填 —— 每个调用方都被迫提供它）' : ''}`, fix: `删掉它，或在步骤里用 $.run.inputs.${p.name} / $${p.name} 引用`, doc: 'docs/02 §5' });
    }
  }

  return dedupe(issues);
}

function inferSnapshotKind(s: Step, ctx: LintContext): string | undefined {
  const ref = 'target' in s && typeof (s as { target?: unknown }).target === 'string' ? (s as { target: string }).target : undefined;
  void ref;
  // 简化：整场景只有一个主目标时用它；混合场景需要 stepSnapshotKind 显式提供
  const kinds = Object.values(ctx.snapshotKinds ?? {});
  return kinds.length === 1 ? kinds[0] : undefined;
}

function dedupe(issues: LintIssue[]): LintIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.stepId ?? ''}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface LintReport {
  ok: boolean;
  errors: LintIssue[];
  warnings: LintIssue[];
  issues: LintIssue[];
  summary: string;
}

export function toReport(issues: LintIssue[]): LintReport {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  return {
    ok: errors.length === 0,
    errors, warnings, issues,
    summary: errors.length ? `✗ ${errors.length} 个错误 / ${warnings.length} 个警告` : `✓ 通过（${warnings.length} 个警告）`,
  };
}

/** 覆盖增量预览（docs/00 §6.1：抑制过度生成的唯一有效手段） */
export interface CoverageKey { operationId: string; strategy: string }

export function coverageDelta(generated: CoverageKey[], existing: CoverageKey[]): { newCombinations: number; duplicates: CoverageKey[]; total: number } {
  const have = new Set(existing.map((k) => `${k.operationId}|${k.strategy}`));
  const fresh = new Set<string>();
  const duplicates: CoverageKey[] = [];
  for (const k of generated) {
    const key = `${k.operationId}|${k.strategy}`;
    if (have.has(key) || fresh.has(key)) duplicates.push(k);
    else fresh.add(key);
  }
  return { newCombinations: fresh.size, duplicates, total: generated.length };
}

export { parsePath, PathError };
