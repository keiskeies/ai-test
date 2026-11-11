/**
 * 静态闸（docs/02 §7）—— AI 生成的 IR 必须先穿过它。
 *
 * 为什么这是产品级要点而不是代码质量工具：本平台的核心卖点是
 * 「一句话生成用例」，而 LLM 生成用例的头号失败模式是
 * **产出几百条可读、只断 status==200、永远绿、什么都抓不住的用例**（docs/00 §6.1）。
 * 因为 IR 是结构化数据而非不透明脚本，这些检查才写得出来 ——
 * 已知没有任何竞品做「无断言用例 lint」（docs/00 §4.4）。
 */
import type { ParallelHazard, Scenario, Step, StepResult } from '@atest/ir';
import { CONTAINER_KINDS, LEASE_REQUIRED, STATE_MUTATING, STEP_TARGET, deriveTargets, parallelHazards, walk } from '@atest/ir';
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
  | 'SELF_REFERENCING_CALL' | 'INPUT_UNUSED' | 'PARALLEL_VAR_RACE' | 'RETRY_ON_CONTAINER'
  | 'HOVER_THEN_NOT_IMPLEMENTED';

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
  RETRY_ON_CONTAINER: 'docs/05 §4',
  HOVER_THEN_NOT_IMPLEMENTED: 'docs/06 §2',
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
  PARALLEL_VAR_RACE: 'docs/08 §3、docs/02 §5',
};

/**
 * 一条 hazard 的报错文案。**判据本身不在这里** —— 这里只把 ir 的 `ParallelHazard`
 * 翻译成人话，判据永远是 `parallelHazards()` 那一份（lint 侧一条都不自己判）。
 *
 * 为什么写成 kind 三元 + 兜底，而不是 `Record<ParallelHazard['kind'], …>` 那种
 * "漏一个 kind 就编译不过"的中心表（本仓的 `LINT_DOCS` / `STEP_WRITE_SITES` 都是那个形态）：
 * 闸的判据集合正在动 —— 曾有的 `frame-shadow` 已随"每支一份局部作用域"退场，
 * 中心表会把这种**收窄**也变成 lint 侧的编译错误（登记了一个已经不存在的 kind），
 * 于是 lint 与 ir 必须同一轮改，而这两处本来就该各自演进。
 * 兜底分支只用两种 hazard 都有的 `name`，所以两种 union 形态都能编译。
 * 代价是"新增 kind 忘了写文案"不会编译报错 —— 但那种情况下报出来的是**兜底那句**
 * （仍然带名字、仍然指到容器），不是静默漏报；而 LintCode 层的登记仍由
 * `LINT_DOCS: Record<LintCode, string>` 强制，新增码不登记照样编译不过。
 */
const raceText = (h: ParallelHazard): { message: string; fix: string } =>
  h.kind === 'shared-write'
    ? {
      // 两种同名写在 IR 上长得一模一样（两支都写这个名字），所以文案要把两种后果都说出来：
      // 名字在 parallel 之前就有 -> 写的是同一份，谁后写谁赢；两支各自新声明 -> 不 flaky，
      // 但收尾合并只能留一份。只写"结果随调度顺序变"的话，后一种作者会想
      // "我这条不 flaky 啊"然后把这条报错划掉。
      message: `parallel 的分支 ${h.branches.join(' / ')} 都往 "${h.name}" 写 —— 若它在 parallel 之前就已声明，那是"谁后写谁赢"的真竞态；若是两支各自新声明，收尾合并只能留一份，丢哪一份由分支声明顺序决定而不是你的意图`,
      fix: `给各分支改用互不相同的名字（saveAs / assign 的键 / assignTo / outputVars）。要汇总结果就各写各的、在 parallel 之后用一条 set 合并；或把这几支拆成 sequence 顺序执行`,
    }
    : {
      message: `parallel 的分支之间存在变量冲突，涉及 "${h.name}"`,
      fix: '给各分支改用互不相同的变量名，或把这几支拆成 sequence 顺序执行 / 独立场景',
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

  /*
   * **租约规则单开一次遍历，走三层**（缺陷与取证见 `docs/15` §3.3 末尾那张探针表）。
   *
   * 它原先在下面的"逐步骤规则"里，而那一块走的是 `walk(scenario.body, …)` ——
   * 于是两个方向都坏，且都已实测：
   *  - `device` 在 `setup`、`tap` 在 `body` → **误报**，而该场景运行时真跑通
   *    （`tap` = pass、`lease → release` 各一次）。error 级 → `atest lint` 退 3 /
   *    `run --strict` 拒绝执行，也就是**能跑的合法写法被静态闸拒了**；
   *  - `tap` 只在 `setup`（那一刻真的没有租约）→ **漏报**，错误挪到运行时才以
   *    `env-unavailable` 现形，归因指向"没配 device adapter"而不是"IR 少一步租约"。
   *
   * **为什么只把这一条挪出来，而不是把整块改成三层**：那块里还有 10 条规则，
   * 其中 `orderIdx` 参与的判据要跟着重定义顺序，而"teardown 里一个裸 sleep 该不该
   * 和 body 里一个同罪"是**产品问题不是 bug**（`docs/15` §3.3 那条 ⚠ 写的就是这个）。
   * 把未决的产品问题夹在一个缺陷修复里一起做，做完就没人再来分开判了。
   */
  {
    let leaseAcquiredAt = -1;
    let idx = 0;
    // 顺序按**运行顺序**拼：setup → body → teardown。
    // 判据用 deriveTargets(三层) 而不是 scenario.targets —— 后者是从 body 推的
    // （`ir/index.ts` 里 `targets: deriveTargets(draft.body)`），
    // 于是"body 里没有移动端步骤、只有 setup 里有"这种场景那个 .some() 根本不成立，
    // 上面的遍历修好了也仍然漏（手工验过：只改遍历时，只有这种场景会红）。
    const needsDevice = deriveTargets([...scenario.setup, ...scenario.body, ...scenario.teardown])
      .some((t) => ['android', 'ios', 'harmony'].includes(t));
    walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => {
      idx++;
      if (s.kind === 'device') leaseAcquiredAt = idx;
      if (LEASE_REQUIRED.includes(s.kind) && leaseAcquiredAt < 0 && needsDevice) {
        push({ code: 'RESOURCE_LEASE_MISSING', level: 'error', stepId: s.id, message: `设备步骤 ${s.kind} 之前没有 device 租约`, fix: '在场景开头加 { kind:"device", require:{…} } 申请租约' });
      }
    });
  }

  // ── 逐步骤规则 ──────────────────────────────────────────────────
  // 租约规则搬走了，连着 `leaseAcquiredAt` 与它唯一的使用者 `orderIdx` 一起
  // （新那一遍里用 `idx`，它只需在本规则自己的遍历里单调）。
  // 这里**不留**一个没人读的计数器：留着一个与判据脱钩的 orderIdx，
  // 下一个人要么以为还有规则用它，要么照着它再加一条顺序相关的判据而不自知。
  let hasSleep = false;
  let llmAsserts = 0;
  let totalAsserts = 0;
  let mutating = false;
  const mutatingSteps: Step[] = [];

  walk(scenario.body, (s, path) => {
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
    // 租约规则**不在这里**：它在上面那个走三层的独立遍历里。
    // 留在这里的话会与新那一遍各报一次（body 里的设备步），且 setup 里的租约仍然看不见。
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

  /*
   * ── parallel 分支之间的变量竞态 ────────────────────────────────
   *
   * **判据直接调 ir 的 parallelHazards()，也就是解释器 `case 'parallel'` 用的那一份**。
   * 抄一份过来（哪怕一开始一模一样）都必然漂移，而漂移的方向是可预见的：改判据的人只改
   * 引擎那一处（那边有 parallel.test.ts / scope.test.ts 盯着），lint 这份悄悄落后，
   * 于是 `atest lint` 说"没问题"、CI 放行、跑到那一步才被运行时闸拒掉。
   * 那比没有这条 lint 更坏：先信了 lint、再白跑一遍，而"白跑"在真实环境里意味着
   * parallel 之前的 POST/下单已经发出去了。
   *
   * **级别是 error，不是 warning。这条不是风格选择，是实测出来的**：
   *  - `run` 默认**不** lint（commands.ts 里写明是故意的：不把"IR 不对"与"产品坏了"
   *    压成同一个退出码）。所以 warning 的实际后果是 `atest lint` 通过、`atest run` 照跑。
   *  - 而"照跑"之后**不一定红**。实测一份"先一条断言、再一个撞名的 parallel"的场景：
   *    运行摘要打到 `运行 … — error`、`计入 3 步：… 1 错误`，
   *    紧跟着一句 `2 个断言全部通过。`，**退出码是 0**。
   *    原因在 cli/gate.ts 的 gateAfterRun：errors/fails 都从 `leaves`
   *    （`!CONTAINER_KINDS.includes(kind)`）里筛，而 `parallel` 是容器 ——
   *    那道运行时闸记的 error **根本不进退出码判定**。
   *    同一份场景把那条断言拿掉才落到 EXIT.INVALID(3)（走的是"0 个叶子步骤"那条分支）。
   *    这条缺陷已单独上报，不在本轮修（gate.ts 不在我的改动范围内）。
   *  - 所以现状是：**运行时那道闸拦得住"跑出错误答案"，但拦不住"CI 变绿"**。
   *    lint 这一条是撞名场景目前**唯一**能给出非零退出码的入口
   *    （`atest lint` 或 `atest run --strict`，两者都落 EXIT.INVALID(3)，
   *    那一档的提示正好是"这是配置/用例问题，不是产品问题"）。
   *    降成 warning 就等于把这个场景放回"全绿但有一步压根没测"的状态 ——
   *    正是本仓反复记的那类"用例被丢了而报告显示它过了"。
   * 同族的 SELF_REFERENCING_CALL / DEPENDENCY_CYCLE 也是"执行必然坏"所以是 error；
   * 区别只在于它们没有运行时闸，而这条有（而且那道闸在退出码上是哑的）。
   *
   * **运行时那道闸为什么不因为这里有 lint 就删掉**：
   *  1. 上面第 1 条：`run` 不 lint，`--strict` 是可选的；
   *  2. `call` 的子场景是运行时由 CallResolver 取回来的（interpreter 的 call 分支），
   *     被 lint 过的父文件不代表子场景干净；
   *  3. engine 还以浏览器 bundle 的形态给前端做实时校验（browser.test.ts 守的就是这个），
   *     调用方**可以**先 lint，但没人强制它 lint。
   * 一句话：lint 负责"写的时候早知道"（并且是唯一能拦下 CI 的那一环），
   * 运行时闸负责"绕过 lint 也不会跑出错误答案"。两个职责不重叠，删哪个都留一个洞。
   *
   * 遍历走 setup+body+teardown 而不是只 body：解释器对这三段都真跑 parallel 分支，
   * 只查 body 等于"前置里并发准备数据时撞名"照样漏到运行时。
   */
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => {
    if (s.kind !== 'parallel') return;
    // **刻意不看 failFast**：两支写同一个名字，failFast=true 给出"哪支先输由交错顺序决定"，
    // false 给出"谁后完成谁算" —— 都不能重跑两次拿同一个答案。把同一条缺陷按一个
    // 与语义无关的开关切成两种严重度，只会让人以为改开关能绕过它。
    for (const h of parallelHazards(s.steps)) {
      push({ code: 'PARALLEL_VAR_RACE', level: 'error', stepId: s.id, ...raceText(h) });
    }
  });

  /*
   * **容器上的 retry 现在什么都不做**，所以要响。
   *
   * （为什么单开一次 walk 而不是并进上面那条 parallel 规则：两条规则遍历同三段
   *  看着可以合一次，但合了之后它们**共享同一个回调**，将来谁改另一条的回调形状
   *  就会连带改到这条 —— 而 mutate 集里有两条 spec 的锚点横跨 parallel 规则的
   *  walk 头两行，我第一次就是插在中间把那条 spec 弄哑的。规则各占一次遍历，
   *  锚点就只会因为**自己这条**的改动而失效。）
   *
   * 以前它是**能做**的，而且做得很危险：容器的结论是从子步骤递上来的，
   * 子步骤报 env-unavailable 时容器也报 env-unavailable，于是 `status5xx` 那条
   * alias（等价于"任何 error 都重试"）会**把整个容器重跑一遍** ——
   * 包括里面的 POST。而"POST 永不自动重试"（docs/05 §4）这条安全边界
   * 是按步骤看的，它看不见"POST 在某个 parallel 分支里"。
   *
   * 本轮把重试判据改成"必须有传输层种类"之后，容器**天然不再重试**
   * （容器那一行不带 transportKind，见 engine 的 worthRetrying）。
   * 这是**故意的**：重跑一个块意味着重跑它的所有子步骤，两个后果
   *  (1) 块里的 POST 会被再发一次（重复下单级事故，症状是一次成功的 200）；
   *  (2) 上一次尝试留在 results 里的**子步骤行**撤不掉 ——
   *      撤行只撤容器自己那一行，子行在下一层，撤了会连"这一轮跑过"一起消失，
   *      不撤就是"同一个步骤 id 两份结论"（正是本轮修掉的那个症状）。
   *
   * 所以：不做，但**要响**。写成 error 而不是 warning，理由是它不是风格问题 ——
   * 一个静默失效的重试配置就是"用户以为自己配了容错，其实没有"，
   * 而那正是本仓反复立档的缺陷类；而且它的替代写法（把 retry 挪到块里那条
   * 幂等请求上）是一行的事，拒得起。
   *
   * 登记在 docs/08：真要支持块级重试，得先有"子树里全是幂等请求"的判定
   * 加上整棵子树的行回滚，那是重试**范围**的设计改动，与 retryOn 那三个
   * 删掉的值同源（见 values.ts 的 RetrySchema 注释）。
   */
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => {
    if (!CONTAINER_KINDS.includes(s.kind) || (s.retry?.count ?? 0) <= 0) return;
    push({
      code: 'RETRY_ON_CONTAINER', level: 'error', stepId: s.id,
      message: `${s.kind} 上写了 retry.count=${s.retry?.count}，但**容器级重试已不再生效**：重跑一个块会重发块里的 POST，且上一次尝试的子步骤行撤不掉（会变成同 id 两份结论）`,
      fix: '把 retry 挪到块内**那条幂等请求**上（GET/HEAD/OPTIONS/PUT/DELETE）；块里若有 POST，重试要显式配 idempotencyKey 后再议（docs/05 §4）',
      doc: 'docs/05 §4、docs/08 §3',
    });
  });

  /*
   * **`hoverThen` 声明了但平台不会做**（error 级，不是 warning）。
   *
   * 为什么是 error：这一格失效的方向是**假绿** —— `act{action:'hover', hoverThen:'click'}`
   * 今天的行为是 hover 完就停、**步骤 pass**。warning 会被无视，而假绿不能。
   * 为什么默认值 `'none'` 反而让它更隐蔽：声明了 `'click'` 与压根没声明
   * **跑起来一模一样**，连一个可疑信号都不留（docs/14 §4.3 子类 (a) 里
   * 比 `expectNewPage` 更难发现的一例 —— 那条至少名字看起来是个开关）。
   *
   * 为什么不在这里顺手实现：`act` 只有**一个** locator，而 docs/06 §2 给的动机场景是
   * "hover A 才出现 B、再点 B" —— **两个**元素。按现有 schema 只能做成
   * "对同一个元素 hover 完再点它自己"，那恰好覆盖不了下拉菜单。
   * 一个语义不符、看着像实现了的功能，比不实现更容易让人以为验到了。
   * 语义定了之前，先把假绿堵住。
   *
   * **判据不绑 `action === 'hover'`**：要拦的是"声明了 hoverThen"，
   * 不是"正在 hover"。写成 `action==='hover' && hoverThen!=='none'` 的话，
   * `{action:'click', hoverThen:'click'}`（IR 收得下）会静默通过，
   * 而它的失效方向与 hover 那一格**完全相同**。
   *
   * 单独一个 walk，而且走 **setup + body + teardown**：这条不需要 path / orderIdx /
   * 任何跨步骤状态，所以并进上面那个只走 body 的 walk 只是"少写一行"，
   * 代价是前置/后置里的 act 静默逃过（**我第一版就是这么放的**，
   * 是 `setup / teardown 里的 act 同样查` 那条测试把它测红的）。
   * 本文件 PARALLEL_VAR_RACE 那处的注释写的就是同一条理由：
   * **解释器对这三段都真跑**（前置里"hover 出菜单再点一下"尤其常见）。
   *
   * **静态这一半拦得住 CI，拦不住直接 `atest run`**（run 默认不跑 lint，
   * 那是 commands.ts 里刻意的设计：否则 lint error 与运行结果压成同一个退出码）。
   * 所以解释器里还有一道同名的运行时拦（interpreter.ts 的 hoverThen 那一处）——
   * **两层守同一个假绿，不是重复**：一层管"跑之前就能确定的配置问题"
   * （`atest lint` / `run --strict` 落 EXIT.INVALID(3)，一个浏览器都不用起），
   * 一层管"没跑 lint 就跑了的人"。只留静态那层，这条登记就又变成一处
   * "写了但没人执行"。（同族的 PARALLEL_VAR_RACE 在 420 行附近把这套
   * "为什么 lint 与运行时闸都要留"论证完整写过，包括那道运行时闸在退出码上是哑的这件事。）
   */
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => {
    if (s.kind !== 'act' || s.hoverThen === 'none') return;
    push({
      code: 'HOVER_THEN_NOT_IMPLEMENTED', level: 'error', stepId: s.id,
      message: `act 声明了 hoverThen:'${s.hoverThen}'，但"hover 完紧接着做第二件事"未实现 —— 这一步只会做 hover，第二件事一个都不做，而步骤会判 pass（假绿）`,
      fix: '暂时改成两个显式步骤（hover + 第二个动作），并接受它比原子组合更容易 flaky；'
        + '真要原子做，得先给 act 加第二个 locator —— 现有 schema 只有一个，'
        + '而该字段的动机场景（hover A 才出现 B、再点 B）需要两个元素',
      doc: 'docs/06 §2',
    });
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
