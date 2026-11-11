/**
 * 静态闸（docs/02 §7）—— AI 生成的 IR 必须先穿过它。
 *
 * 为什么这是产品级要点而不是代码质量工具：本平台的核心卖点是
 * 「一句话生成用例」，而 LLM 生成用例的头号失败模式是
 * **产出几百条可读、只断 status==200、永远绿、什么都抓不住的用例**（docs/00 §6.1）。
 * 因为 IR 是结构化数据而非不透明脚本，这些检查才写得出来 ——
 * 已知没有任何竞品做「无断言用例 lint」（docs/00 §4.4）。
 */
import type { ParallelHazard, Scenario, Step, StepResult, WaitPredicate } from '@atest/ir';
import { CONTAINER_KINDS, LEASE_REQUIRED, STATE_MUTATING, STEP_TARGET, ScenarioSchema, deriveTargets, eachValuePosition, isExprConditionField, isExprField, iterConditions, parallelHazards, scenarioIdOfRef, walk } from '@atest/ir';
import { parsePath, parseRef, PathError } from './jsonpath.js';
import { validateExpr } from './expr.js';
import { redactSecretText } from './redact.js';
import { detectDefaultCycles } from './vars.js';
import { HIERARCHY_ONLY_ASSERTS, PIXEL_CAPABLE_ASSERTS, VarRefPattern, GEN_KINDS, isValueForm } from '@atest/ir';

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
  | 'HOVER_THEN_NOT_IMPLEMENTED' | 'SQL_PLACEHOLDER_UNBOUND' | 'RESERVED_KEY_REWRITE'
  | 'REQUEST_PART_NOT_IMPLEMENTED' | 'CALL_GRAPH_INCOMPLETE' | 'REF_PATH_SYNTAX';

/**
 * `call` 调用图，给 `DEPENDENCY_CYCLE` 用。
 *
 * ## 为什么不是裸的 `Record<string, string[]>`
 *
 * 因为它**没法表达"我没看全"**。裸 Record 加一句"缺省时跳过环检测"的形状下，
 * 调用方只有一种方式说话："给了图" 或 "没给图"。而真实的第三种情形最常见 ——
 * **图给了，但里面缺边**（子场景解析不到、或走到节点上限没继续展开）。
 * 那种情形下报告写着「✓ 通过」，读的人以为"环检测跑过了、没环"，
 * 实际是"环检测压根没看到那一条"。这是本仓那一族的又一格：
 * **一个结论缺了"我是怎么得出来的"这一半，看起来就和完整的结论一样**。
 *
 * 所以完整性**不是**一个可以漏填的说明字段，而是这张图**类型上必须携带**的信息：
 * 生产方只能靠 `gaps` / `truncated` 表达不完整，而"完不完整"由下面那个
 * `graphComplete()` 现算 —— 不在类型里存一个 `complete: boolean`，
 * 因为那会有第二份事实（`gaps: [{…}]` 配 `complete: true` 是自相矛盾的，
 * 而自相矛盾的两个字段迟早出现）。
 */
export interface ScenarioGraph {
  /** 场景 id → 它直接 call 的场景 id。**键与值都不许带 `@version`**（`scenarioIdOfRef`） */
  edges: Record<string, string[]>;
  /**
   * 没能展开的 ref。每一条都意味着"从这里往下的环判不出"。
   *
   * `reason` 不是装饰，是**修法**的分岔：`not-found` 是"这个 ref 指向的东西不在"，
   * `invalid-ir` 是"文件在而里面那份 IR 读不出"（往往还带一句是哪一处读不出）。
   * 混成一句"解析不到"的话，本轮实测过人拿着后者去查文件名拼没拼错。
   */
  gaps?: Array<{ from: string; ref: string; reason?: 'not-found' | 'invalid-ir'; detail?: string }>;
  /** 触到节点上限而未继续展开的 ref 数 */
  truncated?: number;
}

/**
 * 这张图是否覆盖了入口场景能触达的全部 ref。
 *
 * 判据**只在这一处**：lint 侧那条"图不完整"的规则、以及任何将来要决定
 * "这份结论能不能当门禁依据"的人，都问这同一个函数。抄第二遍的代价是
 * 两处对"完整"的定义漂移，而漂移的表现是"lint 说完整、另一个消费者说不完整"。
 */
export const graphComplete = (g: ScenarioGraph): boolean =>
  !(g.gaps?.length ?? 0) && !(g.truncated ?? 0);

/** `ScenarioGraph.gaps` 的一条 */
export type ScenarioGraphGap = NonNullable<ScenarioGraph['gaps']>[number];

/**
 * 一条缺口里**只关于原因**的那一半（`Pick` 而不是重抄字段：多一个字段就跟着多一个）。
 *
 * 生产方需要单独递这一半：解析器知道某个 ref 为什么解析不出来，
 * 但**不知道是谁发起的 call**（那是遍历侧才有的事实），所以它没法产出完整的 gap。
 * 给它一个"必须填 from"的类型，它就会去编一个 —— 而编出来的 `from` 会被打印成归因。
 */
export type ScenarioGraphGapCause = Pick<ScenarioGraphGap, 'reason' | 'detail'>;

/**
 * 一种缺口原因的**措辞**与**修法**，成对放在一起。
 *
 * 写成一张表而不是两处各写一遍（措辞在模板里、修法在 if 链里），是因为
 * "本次有哪些原因"这个集合**只该被算一次**：我第一版就是把它算了两遍
 * （message 用分桶、fix 用 `gaps.filter(g => g.reason === …)`），
 * 于是"message 里出现了 invalid-ir 而 fix 里没提"这种半截建议
 * 只需要有人改一处不改另一处就能诞生 —— 而那正是本仓记账最多的那一族。
 * 现在两者从同一次分桶里长出来，结构上无法只对一半。
 *
 * `label` 是**给修法那一句用的短名**，与 `text` 分开是有意的：
 * `text` 是接在「N 处 call」后面的**谓语**，要能独立读通；`label` 嵌在
 * 「……的那 N 处：」中间，长的措辞会让那句变成绕口令
 * （第一版直接复用整句，量出来是「那个找不到被 call 的那个文件的：把子场景放进 irDir…」
 *  —— 一个句子里两个"那个"，读的人已经放弃了）。
 *
 * ⚠ `text` 起头不能是名词：「1 处 call **目标文件在**而…」会被读成
 * "call 目标文件"这个名词再加一个"在"，读到后半句才回头（本轮实测到的）。
 * 所以三条谓语都以"的"或动词起头，数量词的宾语始终是"处 call"。
 */
const GAP_CAUSE: Record<string, { text: string; label: string; fix?: string }> = {
  'not-found': {
    text: '的文件找不到',
    label: '文件不存在',
    fix: '把子场景放进 irDir，或改掉 ref（`atest run` 运行时同样解析不到，会报 env-unavailable）',
  },
  'invalid-ir': {
    text: '的文件在、而那份 IR 读不出',
    label: '文件在而 IR 不合法',
    fix: '要修的是文件的**内容**（别去改 ref，文件本来就在）：`atest lint <那个文件>` 会指出具体哪一处不合法',
  },
  // `reason` 在类型上可选：不是每个生产方都能分辨原因（引擎里手工拼的夹具图就分辨不了）。
  // **把"没记原因"并入"找不到文件"是在说谎** —— 那句话会让人去查 ref 拼没拼错。
  // 所以认不出来时照实说认不出来，并且**不给修法**（不承诺一个不知道能不能做的动作）。
  '': { text: '没被展开（生产方没记下原因）', label: '没记下原因' },
};
const GAP_CAUSE_UNKNOWN = GAP_CAUSE['']!;
/** 触到节点上限那一类缺口。与 gaps 同进同出，理由见 `graphGapSummary` 里那句注释 */
const GAP_TRUNCATED = { text: '达到节点上限，没继续展开', label: '达到节点上限', fix: '把调用树拆浅一点（公共步骤抽成第三个场景让双方 call 它）' };

/** `graphGapSummary` 的产物：一桶一句话，以及**与这些桶同源**的修法 */
export interface GraphGapSummary {
  /** 每种原因一句（同类合并计数，每类点一个样本），多的那类在前 */
  lines: string[];
  /** 只覆盖 `lines` 里真的出现过的那些原因；没修法的原因不硬编一句 */
  fixes: string[];
}

/**
 * 调用图的缺口 → 结论那一句 + 修法那一句。
 *
 * ## 为什么这是一处独立导出的判据，而不是 lint 规则里的字符串拼接
 *
 * 这一族缺陷的正面对面是："schema 有字段、执行侧没人读"。本轮我先犯的正是它的镜像：
 * `reason`/`detail` 加在了类型上，而措辞长在规则体内部 —— 于是"`invalid-ir` 这个值
 * 到底有没有被用上"只能靠**跑一次真命令**来验（要临时项目、真文件系统、一个恰好不合法的
 * 子 IR）。措辞成为独立函数之后，那件事是一行断言；规则体里剩下的只是"要不要说话"，
 * 那是另一条规则该管的事。**判据尽量交给独立实现**（docs/08 §3）。
 *
 * ## 为什么必须分桶
 *
 * 三种缺口的修法本来就不同：少文件是"去看那个 ref 对不对"，IR 读不出是"去修那个文件"
 * （本轮实测过人拿着后者去查文件名拼没拼错），触上限是"把调用树拆浅"。
 * 合成一句"有 N 处没展开"等于三句都没说。
 *
 * ## 为什么每桶只点一个样本、以及为什么仍然报总数
 *
 * 一个没 checkout 的目录就能造出几十个缺口，全列出来这一条会挤成一堵墙，
 * 而人真正要修的是第一个。总数照报 —— "几个"决定了这件事值不值得管。
 *
 * ## `detail` 过一遍值形态脱敏
 *
 * 跑在**拼完整段之后**而不是每个片段上（与 `report.ts` 的 `plainSafe` 同一个做法：
 * 将来新加一行天然带着这道处理）。生产方（CLI 的解析器）已经只取首行了，这里再过一遍
 * 是纵深防御而不是重复：`detail` 源自**磁盘上别人写的文件**，而 `JSON.parse` 的报错
 * 会带上出错位置附近的原文 —— 我不能假设那种内容永远无害。这句话要进 lint 输出与
 * CI 日志，那是要落盘的文字（同一族约束见 docs/02 §6 与散文那三个出口）。
 */
export function graphGapSummary(
  gaps: readonly ScenarioGraphGap[],
  truncated = 0,
): GraphGapSummary {
  const buckets = new Map<string, { n: number; sample: ScenarioGraphGap }>();
  for (const g of gaps) {
    const hit = buckets.get(g.reason ?? '');
    if (hit) hit.n++;
    else buckets.set(g.reason ?? '', { n: 1, sample: g });
  }
  /*
   * 触上限**并进同一张桶表**而不是在末尾各拼一句：两类缺口都要出现在 lines，
   * 也都要（或都不要）出现在 fixes。分两处写就要在两个地方各判一次 `truncated`，
   * 而"结论里说了触上限、修法里没提"正是这张表存在的理由要防的那种半截话。
   * （触上限那一条没有 `sample`，所以 lines 那一侧要能容纳"没有样本"的行。）
   */
  type Row = { n: number; cause: { text: string; label: string; fix?: string }; sample?: ScenarioGraphGap };
  const rows: Row[] = [...buckets.entries()]
    .map(([reason, v]) => ({ ...v, cause: GAP_CAUSE[reason] ?? GAP_CAUSE_UNKNOWN }))
    // 多的那类排前面：读的人只会认真读第一句
    .sort((a, b) => b.n - a.n);
  if (truncated) rows.push({ n: truncated, cause: GAP_TRUNCATED });
  return {
    lines: rows.map(({ n, cause, sample }) =>
      redactSecretText(sample
        ? `${n} 处 call ${cause.text}（${n > 1 ? '例如 ' : ''}${sample.ref}，由 ${sample.from} 发起${sample.detail ? `；${sample.detail}` : ''}）`
        : `${n} 处 call ${cause.text}`),
    ),
    // 遍历同一批 rows，所以"说了的原因"与"给了修法的原因"不可能是两个集合
    fixes: rows.flatMap(({ n, cause }) => (cause.fix ? [`${cause.label}的那 ${n} 处：${cause.fix}`] : [])),
  };
}

export interface LintContext {
  /** 已导入资源的快照能力。缺省时跳过依赖资源的检查（CLI 单独 lint 一个文件时的正常状态） */
  snapshotKinds?: Record<string, 'aria' | 'hierarchy' | 'pixels' | 'none'>;
  /** 已知的 call 调用图（用于环检测）。缺省时跳过环检测 */
  scenarioGraph?: ScenarioGraph;
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

/**
 * 两个词是否"差一个字母"（增/删/换其一），或**相邻两位调换**（`path` -> `paht`）。
 *
 * 为什么还要额外要求**首字母相同**：纯编辑距离在三个字母的词上太宽松 ——
 * `len` 与 `gen` 距离正好 1，而 `len` 是本仓表达式函数清单里的常见词、
 * 也可能是业务字段名。首字母相同这条排掉的是"两个不相干的短词偶然相近"，
 * 保留的是真实 typo 族（相邻键误触、漏敲一个、多敲一个 —— 都不动首字母）。
 * 长度差限制在 1：`path` -> `pth` 那种跳着漏敲本就不在这一条的靶子里（它离保留键太远，
 * 报出来更像是猜），宁可漏报也不要让作者怀疑 lint 在瞎猜。
 *
 * **对调那一支是编辑距离覆盖不到的**：`paht` 与 `path` 的编辑距离是 2（换两次），
 * 而它恰是人打字最常见的一种错法，所以单列。放宽判据要付出的代价是误报面变宽，
 * 而这里能放宽是因为有一道**活**的护栏在：本函数是导出的，
 * `packages/engine/test/lint.test.ts` 里「IR 的正牌字段名没有一个撞在近邻面上」
 * 那条会用它去扫**真的 IR schema**（不是扫一份抄下来的字段清单），
 * 一份合法 IR 会被这条规则报 = 那条测试红。
 * ⚠ 所以放宽这个判据之前不用"记得去重跑一遍测绘"——测试自己会红。
 * 这条规则的误报代价见 RESERVED_KEY_REWRITE 那段。
 */
export function isNearMiss(a: string, b: string): boolean {
  if (a === b || a[0] !== b[0] || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    // 对调：找第一处不同，若是"a[i]==b[i+1] 且 a[i+1]==b[i] 且两边余下部分相同"就算
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true;
  }
  // 只关心"最多差一个"，所以不需要完整矩阵：逐位比，遇到第一处不同就分三路试
  let j = 0;
  while (j < a.length && j < b.length && a[j] === b[j]) j++;
  if (j >= Math.min(a.length, b.length)) return Math.abs(a.length - b.length) <= 1; // 前缀相同，只差尾巴
  const rest = (s: string, from: number): string => s.slice(from);
  return rest(a, j + 1) === rest(b, j + 1) // 替换
    || rest(a, j + 1) === rest(b, j)       // a 多一个
    || rest(a, j) === rest(b, j + 1);      // b 多一个
}

/**
 * 这个值像不像"作者本意是写第 reserved 那种形态"。
 *
 * **这一条是整条规则里防止误报的关键**，不是修饰：形状判据（键名相近）单独用会命中
 * 每一个 `{var:'id', path:'$.id'}` 之外的业务对象。要求值也对得上，
 * 报出来的才是"你八成想写引用但打错了"，而不是"你的字段名长得像保留键"。
 *  `expr` 用"含运算符或 $"：`ExprSchema` 是 `z.string().min(1)`，任何非空串都合法，
 * 所以形态本身给不出信息，只能从内容上找证据（`{expr2:'1+1'}` 中，`{expr2:'红色'}` 不中）。
 */
function looksLikeForm(reserved: 'path' | 'expr' | 'gen', vs: string | undefined, kinds: ReadonlySet<string>): boolean {
  if (vs === undefined || vs.length === 0) return false;
  if (reserved === 'path') return vs.startsWith('$');
  // 运算符/空格任一即算"像表达式"。`ExprSchema` 是 `z.string().min(1)`，任何非空串都合法，
  // 所以形态本身给不出信息，只能从内容上找：`{expr2:'1+1'}` 中、`{expr2:'红色'}` 不中
  if (reserved === 'expr') return /[$()+\-*/<>=!&| ]/.test(vs);
  return kinds.has(vs) || [...kinds].some((k) => isNearMiss(vs, k));
}

/**
 * IR 子树里**每一个对象节点**，连同路径与最近的步骤 id。
 *
 * 为什么单开：本文件里有两条规则都是"按对象的**键名**判"（明文凭证、保留键撞名），
 * 而遍历 IR 这件事本身有讲究 —— 步骤 id 要从沿途的 `id` 字段上捡（报错得指到步骤）、
 * 数组下标要进路径、标量要停。`findHardcodedSecrets` 原先自带这一整套，
 * 新规则再抄一遍就是"两份遍历各自演化"：以后有人改路径格式或改 stepId 捡法，
 * 只会改到他正在看的那一条。
 */
function iterObjects(node: unknown, stepId: string | undefined, path: string, visit: (obj: Record<string, unknown>, stepId: string | undefined, path: string) => void): void {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      const id = (v as { id?: unknown })?.id;
      iterObjects(v, typeof id === 'string' ? id : stepId, `${path}[${i}]`, visit);
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  visit(obj, stepId, path);
  for (const [k, v] of Object.entries(obj)) {
    const id = (v as { id?: unknown })?.id;
    iterObjects(v, typeof id === 'string' ? id : stepId, `${path}.${k}`, visit);
  }
}

/** 深度遍历 IR，把「凭证字段名 + 明文值」的位置连同样例值一起交出来。 */
function findHardcodedSecrets(scenario: unknown): { stepId?: string; path: string; key: string; sample: string }[] {
  const out: { stepId?: string; path: string; key: string; sample: string }[] = [];
  iterObjects(scenario, undefined, '$', (obj, stepId, path) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') continue;
      const isRef = SAFE_VALUE_RE.test(v) || v.includes('$') || v.includes('{{');
      if (CREDENTIAL_FIELD_RE.test(k) && v.length >= 4 && !isRef) {
        // 只交出前 4 个字符。整条明文出现在报错里，等于把密钥贴进 CI 日志
        out.push({ stepId, path: `${path}.${k}`, key: k, sample: `${v.slice(0, 3)}…(${v.length} 字符)` });
      }
    }
  });
  return out;
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
  REQUEST_PART_NOT_IMPLEMENTED: 'docs/02 §2、docs/14 §5',  // fixture 仓库是 P1；本轮只保证它不再静默发一个少附件的请求
  SQL_PLACEHOLDER_UNBOUND: 'docs/15 §3.2',
  RESERVED_KEY_REWRITE: 'docs/02 §5、docs/14 §5',
  VAR_UNDEFINED: 'docs/02 §5',
  DEPENDENCY_CYCLE: 'docs/02 §2',
  // 不是"某条 IR 坏了"，是"这条检查没看完"。归到 docs/02 §2 那张表旁边，
  // 因为它存在的理由就是让 DEPENDENCY_CYCLE 的"没报"读起来不像"确认没有"
  CALL_GRAPH_INCOMPLETE: 'docs/02 §2、docs/14 §6',
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
  REF_PATH_SYNTAX: 'docs/02 §5',
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

/** 租约游标走到某一步时"手上有没有租约"这件事的**作用域**判据（见 walkLease） */
type LeaseCursor = { has: boolean };

/**
 * 按**运行时的作用域**走一遍租约，报出所有"这一刻手上没有租约"的设备步骤。
 *
 * ## 为什么不能用 `walk()` + 一个扁平游标
 *
 * `walk` 是深度优先的扁平遍历，配上"先前见过 device 就算有租约"的游标，
 * 对**分支语义**会给出与运行事实相反的判定（三处，实测见 `docs/15` §3.3）：
 *  - `parallel`：两支并发，分支内部申请的租约**不跨分支**（每支一个槽，见
 *    `interpreter.ts` 的 `LeaseSlot`），而扁平游标会认为"A 支的 device 喂到了 B 支"；
 *  - `if` / `switch`：`then` 与 `else` 只会走一边、`cases[i]` 与 `default` 只会走一边，
 *    而扁平游标会认为"上一个分支里的 device 喂到了下一个分支"。
 *
 * ## 三条规则各自的形状
 *
 *  | 容器 | 子步骤之间 | 传给子步骤的游标 | 容器之后的游标 |
 *  | --- | --- | --- | --- |
 *  | `sequence` / `forEach` / `while` / `repeat` | 顺序，前一步的效果可见 | 逐段传递 | 最后一段的结果 |
 *  | `if` | `then` 与 `else` **互斥** | 两段各拿**进入前**那份 | 取"两段都没有"那种（保守） |
 *  | `switch` | `cases[i]` 与 `default` **互斥** | 同上 | 同上 |
 *  | `parallel` | 分支之间**并发**，互不可见 | 每支各拿进入前那份 | 同上 |
 *
 * "容器之后取最保守的一种"是必须的：`if { then: [device] } else { … }` 走 else 那一边时，
 * 出了 if 之后**确实没有租约**，所以后面不能有裸设备步。反过来如果取"有"，
 * 就会放行一份"一半路径没租约"的 IR —— 那正是本仓那一族"看起来有防护，实际漏一个"。
 * 宁可多问一句（作者可以把租约提到容器之前，那本来就是更清楚的写法）。
 *
 * ## 一处**故意**的宽松（不是遗漏）
 *
 * `parallel` 里"分支借来的那台"（分支槽的初值 `slot.lease`）在运行时是**进入容器时手上那台**，
 * 而这里传的就是同一个游标，两边一致。唯一的差别在**并发可见性**：
 * 运行时的分支槽是在 `worker()` 里 `newLeaseSlot(slot.lease)` 现取的，
 * 所以"一支先 device、另一支后跑"时后者**能**看到前者那台（实测过这个不确定性）。
 * 这里**不**跟着那个不确定性走 —— 于是这一形状会被判 error 而运行时可能跑通。
 * 这是**假阳性方向**的错，而它比反向错好：假阳性让人加一步 `device`（多加一次申请，
 * 结果不变），假阴性则让一份 lint 全绿的 IR 在 CI 里偶发红。
 * **而且那个"可能跑通"本身不该被依赖**：它由调度顺序决定，同一份冻结场景两种结论，
 * 违反 docs/02 §9 的确定性要求。判它 error 是在把一个 flaky 的写法挡在门外，不是误伤。
 *
 * @param has 进入这一步时手上有没有租约
 * @param report 每发现一个"没租约的设备步"调一次；`inBranch` 是"它处在某个互斥/并发分支里"
 */
function walkLease(s: Step, has: boolean, report: (bad: { id: string; kind: string; inBranch: boolean }) => void, inBranch = false): LeaseCursor {
  let cur: LeaseCursor = { has };
  // 叶子：判"这一刻有没有"，device 把自己变成"有"
  if (LEASE_REQUIRED.includes(s.kind) && !cur.has) report({ id: s.id, kind: s.kind, inBranch });
  if (s.kind === 'device') cur = { has: true };
  if (!CONTAINER_KINDS.includes(s.kind)) return cur;

  const children = (key: string): Step[] => {
    const v = (s as unknown as Record<string, unknown>)[key];
    return Array.isArray(v) ? (v as Step[]) : [];
  };
  /*
   * 把子步骤切成"**互不可见的段**"。注意 `parallel` 的一段是 `steps` 里的**一个元素**
   * （一支分支），不是整个 `steps` 数组 —— 我第一版把它当成一个数组，于是两支被当成
   * 一段顺序执行，"A 支的 device 喂给 B 支"这个误判**原地留着没修掉**（实测 P4 形状
   * 照样放行）。判据写错最难发现的地方就在这：它对大部分形状是对的，
   * 只有跨分支那一种坏，而那恰好是这条规则存在的理由。
   */
  const groups: Step[][] =
    s.kind === 'switch'
      // switch 的子步骤分两处：cases[i].steps（每个 case 一个数组）与 default
      ? [...((s as unknown as { cases?: { steps?: Step[] }[] }).cases ?? []).map((cs) => cs.steps ?? []), children('default')]
      : s.kind === 'if'
        ? [children('then'), children('else')]
        : s.kind === 'parallel'
          ? children('steps').map((one) => [one])
          : [children('steps')];

  /*
   * `if` / `switch` / `parallel` 的这几段**互斥或并发**：段与段之间互相看不见，
   * 所以每段都从"进入容器前"那份游标起算，段内才是顺序传递。
   * 顺序容器（sequence / forEach / while / repeat）只有一段，于是自然退化成"整段顺序走"。
   */
  const exclusive = s.kind === 'if' || s.kind === 'switch' || s.kind === 'parallel';
  const entry = cur.has;
  const outs: boolean[] = [];
  for (const g of groups) {
    let c: LeaseCursor = { has: entry };
    for (const child of g) c = walkLease(child, c.has, report, exclusive ? true : inBranch);
    outs.push(c.has);
  }

  if (!exclusive) {
    cur = { has: outs[0] ?? cur.has };
    return cur;
  }
  /*
   * 容器之后"有没有"：
   *  - `parallel`：**只认进入前那台**。分支是在自己的槽里拿的（见 interpreter 的 `LeaseSlot`），
   *    并且分支结束时已经自己还掉了，所以容器之后手上还是原来那台（可能就是没有）。
   *  - `if` / `switch`：**每一段都有**才算有。只有一条路径拿得到时，后面那个裸设备步
   *    就是"看条件运气的 error" —— 与 parallel 那两支看调度运气是同一种坏。
   *    这条会多问一句（把 device 提到容器之前即可，那本来也是更清楚的写法），
   *    属于**假阳性方向**的错，比反向（放行一份偶发红的 IR）便宜得多。
   *    `groups` 在这里不可能为空（schema 上 then/cases/steps 都是 min(1)），
   *    但 `outs.every` 对空数组恒真，所以空的情况要单独挡住 —— 宁缺毋滥的方向反过来
   *    就是"没有子步骤可查时不该声称有租约"。
   */
  cur = { has: s.kind === 'parallel' ? entry : groups.length > 0 && outs.every(Boolean) };
  return cur;
}

/**
 * 运行时会 `exportStep(...)` 的步骤类型 —— **`$.step.<id>.*` 引用能不能成立，就看这一份**。
 *
 * ## 为什么这一份必须显式，且必须被测试钉住
 *
 * lint 原先只登记 `extract` / `http` / `openapiCall` 三种，于是**`set` 步骤被引用的
 * 时报「该步骤不存在」**，而它明明在那儿。实测的夹具：
 * `[{kind:'set',id:'login',assign:{resp:…}}, {kind:'assert',against:'$.step.login.resp'}]`
 * —— `atest run` 全绿（退出码 0），同一条 `atest run --strict` 退出码 3 拒绝执行。
 * 静态闸与执行器对同一份 IR 给出**相反**的结论，而错的是静态闸那一侧：
 * `set` 在 `interpreter.ts` 里确实 `vars.exportStep(s.id, vars.visible())`。
 *
 * 漏掉的后果不只是"多一条假报错"。`--strict` 是 CI 常用档，被假报错挡住的场景
 * 有两种下场：作者改不掉就**去掉 --strict**（那条闸从此在 CI 里消失），
 * 或者为了绕报把 `set` 换成一个打真请求的 `http` —— 两种都比没有 lint 更糟。
 *
 * ## 这份清单的来源
 *
 * 逐条对着 `interpreter.ts` 的 `case` 分支数出来的，不是从"我觉得哪些步骤有输出"推的。
 * **`packages/engine/test/lint-step-exports.test.ts` 会从解释器源码里把 `exportStep(`
 * 的调用点重新推一遍并比对** —— 手抄清单与实现分叉是这个仓反复记过的那一族
 * （`values.ts` 的 `GEN_KINDS` 那段讲的就是同一件事：两份手抄清单，改一处漏一处，
 * 症状是"schema 收下、运行时返回 undefined、步骤判 pass 而变量是空的"）。
 * 新增一个会 `exportStep` 的步骤类型而没同步这里，那条测试红。
 */
export const STEP_KINDS_THAT_EXPORT = [
  'set', 'table', 'extract', 'dataSource', 'http', 'openapiCall',
  'assert', 'assertPage', 'assertUi', 'assertLlm', 'assertPerf', 'db',
] as const satisfies readonly Step['kind'][];

/** 查表用的那份（成员判定是 O(1)，且判据只有这一份） */
const EXPORTS_STEP = new Set<string>(STEP_KINDS_THAT_EXPORT);

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
  /** 步骤 id → 它的 kind。只为了报错时能说出"是哪一类步骤不产出输出"。 */
  const stepKind = new Map<string, string>();
  let order = 0;

  const collectDefs = (s: Step): void => {
    order++;
    stepExportOrder.set(s.id, order);
    stepKind.set(s.id, s.kind);
    // **存在性**（这个 id 能不能被 `$.step.<id>` 引用）对所有会导出的种类都登记，
    // 名字集合只在**运行时的导出形状是闭合且已知的**那几种里填。
    // 填不出来时留空集：下面那条按名检查写的是 `if (exports.size && …)`，
    // 空集 = "存在但不按名判"，正是我们要的保守档。
    //
    // `set` 为什么不填 assign 的键名：运行时导出的是 `vars.visible()`
    // （那一刻看得见的**全部**变量），不只是它自己赋的那几个。
    // 只登记 assign 键名的话，`$.step.<set 步骤>.<前面某步算出的变量>`
    // 运行时成立、静态侧报 warning —— 那是**假阳性**，而假阳性的代价
    // 这一格自己就写过：「误报会让人关 lint」。
    if (EXPORTS_STEP.has(s.kind)) stepExports.set(s.id, stepExports.get(s.id) ?? new Set());
    if (s.kind === 'set') for (const k of Object.keys(s.assign)) { defined.add(k.split('.')[0]!); }
    if (s.kind === 'extract') { const set = stepExports.get(s.id)!; for (const r of s.rules) { defined.add(r.var); set.add(r.var); } }
    if (s.kind === 'http' || s.kind === 'openapiCall') {
      const set = stepExports.get(s.id)!;
      for (const k of ['resp', 'status', 'body']) set.add(k);
      if (s.kind === 'http' && s.saveAs) defined.add(s.saveAs);
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
          if (!stepExportOrder.has(info.stepId)) {
            // 这一支现在**只在步骤 id 真的不存在时**进（存在性由上面 stepExportOrder 判，
            // 它对所有步骤都登记）。改之前用的是 stepExports，那是"有没有导出"，
            // 于是"存在但不导出的步骤"（noop/log/fail…）会被报成「该步骤不存在」——
            // 那句话是假的，而人会照着假话去改 id 拼写，改不动。
            push({ code: 'VAR_UNDEFINED', level: 'error', stepId: s.id, message: `引用了步骤 "${info.stepId}" 的输出，但该步骤不存在`, fix: `确认 id 拼写，或在 ${s.id} 之前加入该步骤`, doc: 'docs/02 §5' });
          } else if (!stepExports.has(info.stepId)) {
            // 步骤在，但它**不产出可引用的输出**（noop / log / fail / sleep / tap…）。
            // 运行时的表现是 `步骤 "x" 尚无输出`（error，cause=case-stale），
            // 所以静态侧报 error 是与执行器同向，不是新增严格度。
            push({
              code: 'VAR_UNDEFINED', level: 'error', stepId: s.id,
              message: `引用了步骤 "${info.stepId}" 的输出，但步骤类型 ${stepKind.get(info.stepId)} 不产出可引用的输出`,
              fix: `改用有输出的步骤（${STEP_KINDS_THAT_EXPORT.join(' / ')}），或引用变量本身而不是 $.step 引用`,
              doc: 'docs/02 §5',
            });
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
    /*
     * 表达式语法。**字段名从 schema 派生**（`isExprField`），不是在这里抄一份：
     * 这一处从前手抄了 `condition` 与 `when` 两个，而 `forEach.items` / `switch.value`
     * 同样是 `ExprSchema` —— 于是它们写坏了**没有任何生产可达的静态闸报**
     * （`dryRun` 查 items，但它生产里零调用方）。明细 docs/14 §5 那一行。
     *
     * 与 `dryRun` 同问这一个判据，所以"lint 报了而 dry-run 不报"这种分叉
     * 结构上不存在（本轮之前就存在过，而且是双向的）。
     */
    for (const key of Object.keys(s)) {
      if (!isExprField(s.kind, key)) continue;
      const v = (s as Record<string, unknown>)[key];
      if (typeof v !== 'string') continue;
      const e = validateExpr(v);
      if (e) push({ code: 'EXPR_SYNTAX', level: 'error', stepId: s.id, message: `${key} 表达式语法错误：${e}`, fix: EXPR_SYNTAX_FIX });
    }
    /*
     * `wait` 的 `condition` 上面对那一查**必然是空的** —— `isExprField('wait','condition')`
     * 为假，因为那个字段不是字符串而是一棵谓词树（`WaitPredicateSchema`）。
     * 从前它就到这里为止，于是 `{type:'expr', expr:'1 +'}` 写坏了静态闸一声不响，
     * 只能等跑起来才由运行时报（运行期那一半本轮之前已经修好了：`error` + `case-stale`，
     * 不是"超时"）。缺的是"跑之前就报"这一半，而本平台的主力产出者是 LLM。
     *
     * 两个零件都现成、都不是新写的判据：
     *  - 遍历谓词树用 `iterConditions()`（`waits.ts` 里那个，本文件上面的 SQL 那一查
     *    已经在用它，所以"加一种条件忘了更新遍历"这件事早就是同文件两处编辑）；
     *  - "哪一种条件的哪个字段是表达式"用 `isExprConditionField()`，**从
     *    `WaitConditionSchema` 派生**（`waits.ts`），与步骤那一族共用 `deriveExprFields`。
     *
     * 刻意**不**在这里写 `if (c.type === 'expr')` 那种分派：那正是本仓抄了十几轮的
     * "N 份手抄清单"，而且它比手抄更隐蔽 —— 今天它对（只有 expr 这一种条件带表达式），
     * 所以任何测试都抓不到它哪天不再对。
     *
     * 级别与步骤那一族一致：**error**。理由是判据同一个 —— `validateExpr` 与运行时
     * 用同一个 `parsePath` / 同一个编译器（见 `expr.ts` 与 `expr-strict.test.ts`
     * 里那条等价测试），所以这里报的表达式在**真走到它**时必然抛。
     * "必然"两字要说清边界：`allOf` 短路时后面的条件不会被求值，那种场景
     * 静态报而运行期一次都没抛 —— 但那是**静态闸比单次执行看得全**，不是误报：
     * 表达式本身确实写坏了，下一轮数据变了它就会抛。
     * 与 `act.value` 填 `价格 3$` 那一族方向不同（那是 ValueSchema 的字面量，
     * 当表达式校验才是真误报），这里没有那一类合法写法被拦的风险。
     */
    if (s.kind === 'wait') {
      for (const cond of iterConditions(s.condition as WaitPredicate)) {
        const o = cond as Record<string, unknown>;
        const type = typeof o.type === 'string' ? o.type : undefined;
        if (!type) continue;
        for (const field of Object.keys(o)) {
          if (!isExprConditionField(type, field)) continue;
          const v = o[field];
          if (typeof v !== 'string') continue;
          const e = validateExpr(v);
          if (e) push({ code: 'EXPR_SYNTAX', level: 'error', stepId: s.id, message: `等待条件 ${type} 的 ${field} 表达式语法错误：${e}`, fix: EXPR_SYNTAX_FIX });
        }
      }
    }
    /*
     * `request.files` 非空 => **error**（不是 warning）。
     *
     * 判据是"这一栏非空"这一件事，不涉及值、不涉及 fixture 存不存在 ——
     * 因为要报的**不是**"你的 fixture 有问题"，是"平台没有 multipart 这条路"。
     * 层级选 error 的理由与 `HOVER_THEN_NOT_IMPLEMENTED` 同一条（下面那段就是它）：
     * 改前这一栏**连读都没人读**，所以一条"上传发票"的用例是
     * **附件一个没发出去而步骤判 pass**。假绿必须拦在跑之前。
     *
     * 与 `formData` 的区别要说清（不然下一个人会把两条读成同一条）：
     * `formData` 本轮**真的接上了**（`strMap` -> `send({form})` -> adapter 的
     * `URLSearchParams`，端口与 adapter 那一半本来就在），所以它**没有** lint 规则 ——
     * 有规则反而会把合法写法拒掉。`files` 这一条拦的是**下一轮实现完就要删掉**的东西，
     * 那句写在 fix 里，免得它变成一条永久挂着没人敢动的规则。
     *
     * 走的是 checkRefs 这个 walk，也就是 **setup + body + teardown 三段都查**
     * （上面 hoverThen 那段论证过为什么必须是三段：解释器对三段都真跑，
     * 而"前置里先上传一个附件"正是最常见的位置）。
     */
    if (s.kind === 'http' && s.request.files.length > 0) {
      push({
        code: 'REQUEST_PART_NOT_IMPLEMENTED', level: 'error', stepId: s.id,
        message: `http 请求声明了 ${s.request.files.length} 个文件（${s.request.files.map((f) => f.field).join('、')}），multipart 上传尚未实现，且 fixtureRef 没有任何解析器 —— 这一步现在不会发出请求（改前是照发，附件全丢而步骤判 pass）`,
        fix: '暂时把附件内容当字符串走 JSON body / formData；真做上传要先把 fixtureRef 变成"能解析出字节流的东西"（那是 P1 的 fixture 仓库），再给 HttpExec.send 加 files 与 multipart 编码',
      });
    }
  };
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => checkRefs(s));

  /*
   * ## 值形态位置里的 `{expr}` / `{path}` 写坏了 —— 上面两查**对它们是空的**
   *
   * 上面那两查走的是 `isExprField(kind, field)` / `isExprConditionField(type, field)`，
   * 而这两张派生表说的都是"**这个字段是字符串表达式**"。值形态（`ValueSchema`）
   * 不是那一种：它是 `{expr:"…"}` 这样一个**对象**，字符串藏在里面。
   * 于是 `assign:{v:{expr:'1 +'}}`、`query:{q:{expr:'1 +'}}`、
   * `body:{deep:{inner:{expr:'1 +'}}}` 这些位置写坏了，**静态闸一条都不报**
   * （**改前实测**：把 `engine/test/value-form-syntax.test.ts` 表格里那些位置各放一个
   *  坏表达式，逐个喂给从 HEAD 单独 build 出来的 `lintScenario`（用 git worktree 拉的
   *  一份干净 HEAD），**每一个位置的相关 finding 都是 0 条** —— 不是拿"我以为改前没有"
   *  当读数，这些夹具现在都在那个测试文件里，改前的读数可以照原样复现），
   * 只能等跑到那一步由运行期抛 `error` + `case-stale`。
   *
   * 缺的就是"跑之前就报"这一半，而这一半对本平台不是锦上添花：
   * IR 的主力产出者是 LLM（docs/00 §6.1），而"表达式写半个"恰是它最常见的坏法之一。
   *
   * ## 为什么这一条不用位置清单，而用 `eachValuePosition`（schema 与数据成对走）
   *
   * 值形态能嵌在 record / 数组 / 任意深嵌套对象里（`rows:[{k:{expr:…}}]`、
   * `body:{a:{b:{c:[{d:{path:…}}]}}}`），**任何"列一张字段名表"的写法都列不全**，
   * 而列不全的表现是漏报 —— 漏报与"这一处合法"在报告上逐字相同。
   * 本仓那份 20 格的 `resolved` 清单就是现成样本：它写的时候是对的，而它漏了两格
   * （`wait.condition.dbRow.vars` 与 `inputs[].default`），因为那份遍历**不进 `z.lazy`**，
   * 于是整棵谓词树压根不在它的扫描结果里，而"没扫到"与"扫了没问题"输出一样。
   *
   * 走 schema 与数据成对，新增一个值形态字段不需要"记得来登记"，它天然被走到。
   * 完整性由 `engine/test/value-form-syntax.test.ts` 里那条**独立走一遍 schema 图**的
   * 自检钉着（两份走法必须认出同一批位置 —— 一条恒通过的护栏比没有护栏更糟）。
   *
   * ## 值位置**以下**还要再按数据走一层，判据换成运行期的 `isValueForm`
   *
   * `resolveValue` 对字面量对象是 `Object.fromEntries(entries.map(resolveValue))`，
   * **递归进任意深度**（实测：`body:{deep:{inner:{expr:'1 +'}}}` 运行期就是 error）。
   * 所以只在校验"schema 说这是 ValueSchema 的那一格"会漏掉它下面那片同样被求值的地方。
   * 下面那一趟没有 schema 可依（值形态以下是 `LiteralSchema` 的
   * `record(string, Literal)`，schema 不再给信息），于是**借用运行时那一条判据**
   * `isValueForm` —— 两边同问一个函数，"lint 报了而运行时不当它是引用"这种分叉
   * 在结构上写不出来（`RESERVED_KEY_REWRITE` 那段记过它一次真实代价）。
   *
   * ## 两个 code，每个只管一件事
   *
   *  `{expr}` 复用 `EXPR_SYNTAX`：判据同一个（`validateExpr` 与运行期共用同一个
   *  编译器）、修法同一句（`EXPR_SYNTAX_FIX` 那张函数清单），换个码就是把同一句话
   *  抄两遍。`{path}` 用新的 `REF_PATH_SYNTAX`：**不能**复用 `EXPR_SYNTAX`，
   *  那句 fix 讲的是表达式语言，而引用写坏的人需要的是"以 `$` 开头 / 下标只许
   *  数字、`*`、引号键名"——给错修法的报错等于没有修法。
   *
   * `gen` 的**种类**不在这里判：那是 `RESERVED_KEY_REWRITE` 已经在判的（同为 warning），
   * 两处各判会报两遍。
   *
   * ## 级别取 error，而"必抛"的边界要说清
   *
   * 与上面两查同一条论证：判据与运行期同一个，所以报出来的表达式在**真走到它**时必抛。
   * 边界照旧要说白：`if` 的假分支、`allOf` 短路后面的条件、`forEach` 空数据，
   * 那些位置静态报而单次执行一次都不会抛 —— 那是**静态闸比一次执行看得全**，
   * 不是误报（表达式本身确实写坏了，下一轮数据变了它就抛）。
   *
   * ⚠ **`inputs[].default` 曾经是一个例外，现在不是了。**
   * 它在 schema 里是货真价实的 `ValueSchema`（四种形态都收），而**改前**
   * `applyInputDefaults` 只是原样塞进变量空间、不求值：实测
   * `inputs:[{name:'who',default:{expr:'1 + 2'}}]` ⇒ 下游 `$.who` 拿到的是
   * **对象本身**、发出去的 body 里就是 `{"expr":"1 + 2"}`，而**步骤判 pass**。
   * 那时本条规则对它**单独措辞**并降级到 warning（说"运行期会抛"是假话，
   * 而 error 会让人以为修好语法就能用）。求值侧本轮接上了（`VarSpace` 构造期，
   * 三个真入口各接一次，见 `vars.ts` 的 `applyInputDefaults`），于是那条例外、
   * 那段特殊措辞、以及两处 `unevaluated ?` 分支**整条删掉**：
   * 现在 default 里写坏的表达式/引用与任何其它值形态位置同码同级别，
   * 因为"真走到它就必抛"这句话在它身上也成立了。
   * 保留这段历史记录的理由：一个例外被删掉这件事如果没写下来，
   * 下一个人会以为这一格从来没被特殊对待过，从而看不出"级别曾经取决于求值侧"
   * 这条约定存在过 —— 而它还可能因为别的位置再次需要这条约定。
   */
  {
    eachValuePosition(ScenarioSchema, scenario, ({ value, path, stepId }) => {
      const form = isValueForm(value);
      if (!form || form === 'gen') return; // gen 的种类由 RESERVED_KEY_REWRITE 判，两处各判会报两遍
      const key = form === 'ref' ? 'path' : 'expr';
      const text = (value as Record<string, unknown>)[key];
      if (typeof text !== 'string') return;
      const bare = path.replace(/^\$\.?/, '');

      /*
       * **报错里不许带源码**。值形态所在的位置正是请求体与表单 ——
       * 也就是明文凭证最常出现的地方（`HARDCODED_SECRET` 整条规则的存在就是证据），
       * 而 lint 的输出会进 CI 日志，读者比仓库的读者宽。
       * 上面 `condition` / `when` 那一查回显源码是**可以**的（表达式里放凭证不是常规写法），
       * 这一查不行。
       *
       * 做法是**把手上那个源串从消息里挖掉**而不是正则猜：
       * 解析器的消息形如 `意外记号 "末尾"（表达式：1 +）`，
       * 而 expr.ts 还会把 PathError 再包一层（`引用路径写坏：X（中括号未闭合（路径：X））`），
       * 嵌套括号用正则剥会剥错。我们知道那个串的**原文**，直接整段替换，
       * 剥不干净的可能性不存在。再叠一层 `redactSecretText` 兜"源码之外别处混进来的密钥"。
       */
      const scrub = (msg: string): string =>
        redactSecretText(msg.split(text).join('«表达式源码已省略»')).slice(0, 200);

      if (form === 'expr') {
        const e = validateExpr(text);
        if (!e) return;
        push({
          code: 'EXPR_SYNTAX', level: 'error', stepId,
          message: `值形态里的表达式语法错误（${bare}）：${scrub(e)}`,
          fix: EXPR_SYNTAX_FIX,
        });
        return;
      }
      try {
        parsePath(text);
      } catch (e) {
        push({
          code: 'REF_PATH_SYNTAX', level: 'error', stepId,
          message: `值形态里的引用写坏了（${bare}）：${scrub(e instanceof PathError ? e.message : '?')}`,
          fix: '引用以 $ 开头；下标只许数字、`*` 或引号键名（`$[0]` / `$["带 空格"]`），变量作用域见 docs/02 §5',
        });
      }
    });
  }

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
    // 顺序按**运行顺序**拼：setup → body → teardown。
    // 判据用 deriveTargets(三层) 而不是 scenario.targets —— 后者是从 body 推的
    // （`ir/index.ts` 里 `targets: deriveTargets(draft.body)`），
    // 于是"body 里没有移动端步骤、只有 setup 里有"这种场景那个 .some() 根本不成立，
    // 上面的遍历修好了也仍然漏（手工验过：只改遍历时，只有这种场景会红）。
    const three = [...scenario.setup, ...scenario.body, ...scenario.teardown];
    const needsDevice = deriveTargets(three).some((t) => ['android', 'ios', 'harmony'].includes(t));
    if (needsDevice) {
      // 三层是**一次连续运行**，游标必须一路传下去：setup 里申请的设备在 body 里还在手上
      // （这正是 §3.3 那张探针表里 A 那一格修的东西）。逐层各自起 false 会把它重新变成误报。
      let carry: LeaseCursor = { has: false };
      /*
       * **`parallel` 的分支之间不传租约** —— 这条改动是运行时那个租约槽修法的**另一半**，
       * 单独改任何一半都会造出一条新的"静态闸与运行事实不一致"（本仓最贵的那一族）。
       *
       * 原先的判据是一个**扁平游标** `leaseAcquiredAt`：整条 walk 上只要先前见过一个
       * `device`，后面所有位置的裸设备步都算有租约。顺序无关的容器（parallel）配上
       * 顺序相关的游标，就会给出与运行事实矛盾的判定，实测（`.scratch/probe-parallel-lint.mts`；
       * 永久落点 `lease-scope.test.ts` 的 L1「两种声明顺序同判」——
       * 那条一次覆盖两个顺序，正是为了钉住"取决于书写顺序"这个病）：
       *
       * | 分支声明顺序 | 旧 lint | 运行时（本轮修法后） |
       * | --- | --- | --- |
       * | `[device,tap]` 在前、裸 `tap` 在后 | **放行** | 裸 tap 那支 error「缺少 device 租约」 |
       * | 裸 `tap` 在前、`[device,tap]` 在后 | error@裸tap | 同上（error） |
       *
       * 也就是说旧判据**让同一件事取决于分支的书写顺序**，而其中一种顺序是假的：
       * 一份 lint 全绿的 IR 跑起来必红。运行时现在是确定且对的（每支一个槽，
       * 见 `interpreter.ts` 的 LeaseSlot），所以**这边要跟上**，而不是把那边拉回来。
       *
       * 判据因此改成**作用域感知**：分支继承进来的是"进入容器时手上那台"，
       * 分支内部申请的只对自己那一段可见。这条与解释器的差别见下面 walkLease 的注释。
       */
      for (const st of three) {
        carry = walkLease(st, carry.has, (bad) =>
          push({
            code: 'RESOURCE_LEASE_MISSING', level: 'error', stepId: bad.id,
            message: bad.inBranch
              ? `设备步骤 ${bad.kind} 在容器分支里，而进入这个容器时没有租约（**兄弟分支 / 另一条 case 里的 device 不算**，分支之间不共享设备）`
              : `设备步骤 ${bad.kind} 之前没有 device 租约`,
            fix: bad.inBranch
              ? '给这一支自己加一步 { kind:"device", require:{…} }；或把租约提到容器之前（那样各分支共享同一台）'
              : '在场景开头加 { kind:"device", require:{…} } 申请租约',
          }));
      }
    }
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

  /**
   * SQL 里出现 `$` + 标识符 => 提醒。（docs/15 §3.2。运行时那一半已经如实报错，
   * 这条是**迁移提示**。）
   *
   * **判据只有一条：`$x` 不是本 IR 规定过的任何占位写法，而引擎不做任何 `$` 替换。**
   * 这是当下为真的一件事，不需要我发明约定。反面做法是去判
   * "`$x` 在 vars 里有没有同名键" —— 那要先规定"`$x` 指 vars.x"，
   * 而 MySQL 的具名占位是 `?` / `%(x)s`，`$` 连标准都不是（Postgres 还有 `$$引用$$`）。
   * 定那个约定就是"引擎现猜"那一族，只不过这次猜的人换成了 lint。
   *
   * **判据刻意不看 `vars` 空不空**（第一版看，被自己的变异集问出来的）：
   * 只看"vars 空"的话，最主流的那个错法恰好漏掉 ——
   * `WHERE id = $oid` 配上 `vars:{oid:…}` **不报**，而 MySQL 照样拒这条 SQL。
   * 现在只要 SQL 里有 `$x` 就提醒，"vars 一个都没绑"降级成摘要里的一句补充，
   * 因为那确实是同一条错里更常见的一种，但它不是判据。
   *
   * **warning 而不是 error**，与 HOVER_THEN_NOT_IMPLEMENTED 相反，区别在运行时形状：
   * hoverThen 不实现会**判 pass**（假绿，所以必须拦在跑之前），
   * 而这一条运行时会**如实报 error**。已有场景全部照旧注释「$var 占位由引擎绑定」写的，
   * 定成 error 等于用一次 lint 变更把别人的 CI 全停掉，去换一个运行时本来就会说的错。
   * **静态闸该拦的是运行时看不见的错。**
   *
   * 误报面：SQL 字符串字面量里真出现 `$字母`（`'$foo'`）、Postgres 的 `$$引用$$`。
   * 这一类由摘要里那句"若是字面量请忽略"承担，代价是 warning 被无视一次；
   * 反过来收紧判据（要求 vars 为空）漏掉的是主流错法，两害取其轻。
   */
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => {
    const sqls: Array<{ where: string; sql: unknown; vars: unknown }> = [];
    if (s.kind === 'wait') {
      for (const c of iterConditions(s.condition as WaitPredicate)) {
        const cc = c as { type?: string; sql?: unknown; vars?: unknown };
        if (cc.type === 'dbRow') sqls.push({ where: 'wait{dbRow}', sql: cc.sql, vars: cc.vars });
      }
    }
    if (s.kind === 'dataSource' && s.source.type === 'mysql') {
      sqls.push({ where: 'dataSource(mysql)', sql: s.source.sql, vars: s.source.vars });
    }
    /*
     * `db` 步也在内。它的 vars 一直存在（`.default({})`），所以"能不能绑"
     * 从来没坏过 —— 坏的是**作者以为 SQL 里的 `$x` 会自动绑**这件事，
     * 而三处 SQL 给人的直觉一样（字段同名、注释同源）。
     * 漏掉这一处的话，症状变成"等待里的 SQL 会被提醒、db 步里的不会"。
     */
    if (s.kind === 'db') sqls.push({ where: 'db', sql: s.sql, vars: s.vars });
    for (const one of sqls) {
      if (typeof one.sql !== 'string') continue;
      const hits = [...one.sql.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]);
      if (hits.length === 0) continue;
      const bound = one.vars && typeof one.vars === 'object' ? Object.keys(one.vars as object).length : 0;
      push({
        code: 'SQL_PLACEHOLDER_UNBOUND', level: 'warning', stepId: s.id,
        message: `${one.where}.sql 里出现了 ${hits.map((h) => `$${h}`).slice(0, 3).join('、')} —— `
          + '引擎**不做任何 `$` 替换**，这句会原样发给数据库'
          + (bound === 0 ? '，而且这一步一个 vars 都没绑' : '')
          + '。多半直接被拒（表现为一次报错或超时）；少数数据库把 $ 当合法字符，那就是查了个不是你想要的东西',
        fix: '值写进同级的 vars（如 vars:{oid:{path:"$oid"}}），SQL 里用数据库自己的占位（MySQL 是 ? 或 %(oid)s）。'
          + '不要改成字符串拼接：拼进 SQL 的值会改变语句本身。'
          + '若这个 $ 本来就是字面量里的字符（如 \'$100\'、$$引用$$），请忽略本条',
      });
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
  for (const hit of findHardcodedSecrets(scenario)) {
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

  /*
   * ## RESERVED_KEY_REWRITE —— `path` / `expr` / `gen` 是 IR 的**保留键名**
   *
   * 判据的出发点是一条 schema 层面的事实（本轮实测）：`ValueSchema` 的 union 里含
   * `LiteralSchema`，而它的 `record(string, Literal)` 让**任何 JSON 对象都是一个合法字面量**。
   * 所以"引用写错"永远不会被 schema 拒 —— 写错的形态按字面量静静存下，
   * 引用/生成器压根没生效，而步骤判 pass。三族实测（数据在 docs/14 §5 那一行）：
   *  - `assign:{row:{pathh:'$.step.s'}}`（`path` 少个字母）→ set=pass，存下的是那个对象本身；
   *  - `{gen:'uuidd'}`（种类多个 d）→ set=pass 而**变量是空的**，下游 `notNull` 才响，
   *    而那句读起来像"被测系统返回了空数据"，排查方向就此指到被测系统那边去；
   *  - `{gen:'int', widh:{min:1}}`（`with` 拼错）→ 生成器整个没了。
   *
   * **运行时那半本轮也修了**（未知 gen 种类抛 VarError，见 `resolve.ts` 的 `generate`），
   * 但那是**跑起来、且那一步真被执行**才响。静态闸在 `atest lint` / `run --strict` /
   * CI 生成期就响，而本平台的主力产出者是 LLM（docs/00 §6.1），拼错键名恰是它的常见病 ——
   * 所以这一条属于 docs/02 §7 那张表里的 P1 静态闸。
   *
   * 级别取 **warning** 不取 error，理由要说清：形状 (1)(2) 里"业务对象恰好用了保留键名"
   * 是**合法写法**（IR 没禁止字面量对象里有 `gen` 这个键），error 会让 `run --strict`
   * 拒跑一个本来跑得通的场景。而那种误报的代价不是"多一条红"，是**大家把闸关掉**，
   * 于是本文件全部规则一起失效（本仓为这件事已经付过一次学费，见 CREDENTIAL_FIELD_RE 那段）。
   *
   * ## 三种形状都带**第二条件**，否则就是词汇巧合而不是证据
   *
   * 只看"键名像保留键"会大面积误报，两个反例是本仓里现成的：
   *  - `extract` 的规则本来就是 `{var:'id', path:'$.id'}` —— 每条 extract 都满足"有个 path 键";
   *  - `len` 与 `gen` 只差一个字母，而 `len` 是常见业务字段名。
   * 所以每种形状都额外要求**值也长得像那个形态**（引用得 `$` 开头、gen 的值得是个种类名），
   * 或者要求那个伴随键是 `with` 的近似拼写。两条"不许误报"的用例写在
   * `packages/engine/test/lint.test.ts` 的 RESERVED_KEY_REWRITE 那一组里。
   */
  {
    const kinds = new Set<string>(GEN_KINDS);
    const nodes: Array<{ obj: Record<string, unknown>; stepId?: string; path: string }> = [];
    iterObjects(scenario, undefined, '$', (obj, stepId, path) => { nodes.push({ obj, stepId, path }); });
    for (const { obj, stepId, path } of nodes) {
      const at = (k: string): string => `${path}.${k}`;
      for (const [k, v] of Object.entries(obj)) {
        const vs = typeof v === 'string' ? v : undefined;

        /*
         * (3) 运行时**会**把这对象当生成器（`isValueForm` 说 gen），而种类不在清单里。
         *
         * 判据用的是 `isValueForm` 而不是"这个对象有个 gen 键"，这不是写法偏好而是
         * 少了它会误报：`{gen:'widget', size:'L'}`（业务对象恰好用了 gen 键）运行时按
         * 字面量整存，是完全合法的写法，上一版这里按"有 gen 键 + 种类不认识"判，
         * 于是对着一个合法业务对象报"种类 widget 不存在"。
         * 现在两边同问一个判据，**lint 与运行时会说同一句话**：运行时报错的场景
         * 这里必报，运行时当字面量的场景这里必不报。
         */
        if (k === 'gen' && vs !== undefined && isValueForm(obj) === 'gen' && !kinds.has(vs)) {
          push({
            code: 'RESERVED_KEY_REWRITE', level: 'warning', stepId,
            message: `生成器种类 "${vs}"（${at('gen')}）不存在 —— schema 会收下（值位置允许任意字面量），运行时那一步会报错，但在跑之前就该修`,
            fix: `可用种类：${GEN_KINDS.join(' / ')}（区分大小写、不许带空格）`,
          });
          continue;
        }

        // (1) 保留键的近似拼写 + 值确实像那个形态
        const reserved = (['path', 'expr', 'gen'] as const).find(
          (r) => k !== r && isNearMiss(k, r) && looksLikeForm(r, vs, kinds),
        );
        if (reserved) {
          const what = reserved === 'path' ? '引用' : reserved === 'expr' ? '表达式' : '生成器';
          push({
            code: 'RESERVED_KEY_REWRITE', level: 'warning', stepId,
            // "你以为得到了什么"与"实际存下了什么"两句都要有：只说"键名可疑"的话，
            // 作者会当成无害的命名提醒，而实际后果是${what}没生效
            message: `键 "${k}"（${at(k)}）不是 IR 的键，但它与保留键 "${reserved}" 只差一点、值又长得像${what} —— 这个对象会**整个按字面量存进变量空间**，${what}压根没生效`,
            fix: `改成 {${reserved}: …}；若这本来是个业务对象，换个键名别撞保留键`,
          });
          continue;
        }

        /*
         * (2) `gen` 对、伴随键是 `with` 的近似拼写 -> 对象不再合法，整个 {gen:…} 按字面量存下
         *
         * **第二条件是"值必须是对象"**，与形状 (1) 同一个道理（键名相近只是词汇巧合，
         * 还得值也对得上才算证据），而且这条尤其必要：本平台测的是界面，
         * `width` / `height` 这类字段名到处都是，而 `width` 与 `with` 正好差两个字母
         * （实测 `{gen:'uuid', width:100}` 上一版会被报成"with 拼错"——
         * 一个合法业务对象吃了一条假 warning，而这正是让人关掉 lint 的那种报错）。
         * 判据不是我自己定的：`GenValue.with` 在 schema 里是 `z.record(...)`，
         * 所以"真正的 with 值是对象"是 schema 说了的，这里是照它判。
         * 残留：`{gen:'uuid', width:{a:1}}`（业务上给 width 塞了个对象）仍会报。
         * 接受这一条残留 —— 它同时满足"撞 gen 键 + 伴随键近 with + 值是对象"三个条件，
         * 已经不像巧合；而收紧到排除它，就得反过来放宽别的条件。
         */
        if (k === 'gen' && Object.keys(obj).length === 2) {
          const sibling = Object.keys(obj).find((x) => x !== 'gen');
          const sv = sibling === undefined ? undefined : obj[sibling];
          const isObj = typeof sv === 'object' && sv !== null && !Array.isArray(sv);
          if (sibling && sibling !== 'with' && isObj && isNearMiss(sibling, 'with')) {
            push({
              code: 'RESERVED_KEY_REWRITE', level: 'warning', stepId,
              message: `键 "${sibling}"（${at(sibling)}）像是生成器参数 "with" 的拼写错误 —— 带这个键的对象不再是生成器，**整个 {gen:…} 会按字面量存下**，参数也没生效`,
              fix: '把参数放进 "with" 里，例如 {gen:"int", with:{min:1, max:9}}',
            });
          }
        }
      }
    }
  }

  // 成本上限
  const cap = ctx.maxCostUsd ?? 2;
  if (scenario.config.maxCostUsd > cap) {
    push({ code: 'STEP_BUDGET_EXCEEDED', level: 'warning', message: `maxCostUsd=${scenario.config.maxCostUsd} 超过项目上限 ${cap}`, fix: '拆分场景，或把视觉兜底改成本地模型（docs/03 §1）' });
  }

  /*
   * **call 环检测**。`ctx.scenarioGraph` 是"每个场景 id → 它 call 的场景 id"，
   * 由调用方给（`cli/commands.ts` 的 `buildScenarioGraph`：沿 resolver 走**可达闭包**，
   * 不扫全仓 —— 理由写在那儿）。
   *
   * 三条判据都不是显然的，每条都有它防的事：
   *
   *  1. **键与边一律先过 `scenarioIdOfRef`**。本轮实测过一个静默失效：图按
   *     **ref** 键（`'scn.a@1'`）而遍历从 `scenario.id`（`'scn.a'`）起跳时，
   *     第一跳就查不到出边，于是**图给了、环真在、规则一声不响**。
   *     那种失效比"没接"更坏：接了的人以为它在工作。所以这里不要求调用方切分干净
   *     —— 归一化在这一侧做，调用方给 `@` 带不带版本都同一个答案。
   *  2. **按 id 而不是 ref**：`A@1 → B@1 → A@2` 也是环（`interpreter.ts` 那段
   *     运行时环检测说的就是它），而运行时的判据比静态闸严没用 —— 静态闸的意义是
   *     "一个请求都不发就知道这条 IR 坏了"，它比运行时松一寸，CI 就多做一次真调用。
   *  3. **自环不双报**（`scn.x` call `scn.x` 时只留 SELF_REFERENCING_CALL）。
   *     实测改前那种形状会同时报两条：同一条 IR 的两个坏其实是一个坏，
   *     报两条会让人以为是两处要改（而修法是同一个）。SELF_REFERENCING 那条更具体
   *     （它带 stepId 与"无限递归"这句话），所以留它。
   */
  if (ctx.scenarioGraph) {
    /*
     * **先说"这张图不全"，再谈有没有环。**
     *
     * 缺一条边和"确认没有环"在裸 Record 的形状下是同一个输出（都没有 DEPENDENCY_CYCLE），
     * 于是报告上的「✓ 通过」会被读成"环检测跑过了"。这一条把那个缺口变成看得见的东西。
     * 定成 **warning 而不是 error**：解析不到某个 ref 有很多正当原因（部分 checkout、
     * 子场景在另一个仓、权限），把它变成 error 会让人去删掉那条 call 或者关掉规则 ——
     * 而规则一旦被关，真环也没人管了。warning 的语义正好是"这条结论的可信度有限"。
     *
     * **不点名是哪个环**（我们不知道），只点名**从哪儿开始看不见的**。
     *
     * 判"完不完整"走 `graphComplete()` 而不是在这里重写一遍 `gaps.length || truncated`：
     * 这条规则与"这份 lint 结论能不能当门禁依据"问的是同一个问题，
     * 两处各写一遍迟早只改一处（本仓为这类漂移记过多次账）。
     */
    if (!graphComplete(ctx.scenarioGraph)) {
      /*
       * 结论与修法**同源于一次分桶**（`graphGapSummary`，那里写着为什么不许分两遍算）。
       * 这里只负责"要不要说话"与"说什么级别"。
       */
      const { lines, fixes } = graphGapSummary(ctx.scenarioGraph.gaps ?? [], ctx.scenarioGraph.truncated ?? 0);
      push({
        code: 'CALL_GRAPH_INCOMPLETE', level: 'warning',
        message: `调用图不完整：${lines.join('；')} —— 从这里往下的 call 环**判不出**，所以"没有环"这个结论只覆盖已展开的那部分`,
        // 兜底那句**不许是空的**：修不了也要说清"这个结论的可信度有限"，
        // 否则 fix 一格空着，读的人以为没什么要做的
        fix: `${fixes.length ? `${fixes.join('；')}` : '确认那些 ref 真的能被解析（`atest run` 运行时同样解析不到，会报 env-unavailable）'}（docs/02 §2）`,
      });
    }
    const edges = new Map<string, string[]>();
    for (const [k, vs] of Object.entries(ctx.scenarioGraph.edges)) {
      const id = scenarioIdOfRef(k);
      edges.set(id, [...(edges.get(id) ?? []), ...vs.map(scenarioIdOfRef)]);
    }
    const seenCycles = new Set<string>();
    const stack = new Set<string>([scenario.id]);
    const visit = (id: string, chain: string[]): void => {
      for (const next of edges.get(id) ?? []) {
        // 自环由 SELF_REFERENCING_CALL 报（带 stepId，话说得更准），这里不重复
        if (next === scenario.id && chain.length === 1) continue;
        if (stack.has(next)) {
          // 同一个环只在**第一次撞上它**时报：dfs 换个入口会再次撞上同一个环，
          // 而"成环"是一条事实，报三遍读起来像三个问题（seenCycles 的键是环上各 id 排序后拼出的串，
          // 于是无论从哪个入口绕进来都只报一次）
          const key = [...chain.slice(chain.indexOf(next) + 1), next].sort().join('>');
          if (seenCycles.has(key)) continue;
          seenCycles.add(key);
          push({ code: 'DEPENDENCY_CYCLE', level: 'error', message: `call 依赖成环：${[...chain, next].join(' → ')}`, fix: '把公共步骤抽成第三个场景让双方 call 它' });
          continue;
        }
        stack.add(next); visit(next, [...chain, next]); stack.delete(next);
      }
    };
    visit(scenario.id, [scenario.id]);
  }
  for (const s of allSteps) {
    // 切分只走 scenarioIdOfRef：判据不许有第二份，理由在那个函数的注释里
    if (s.kind === 'call' && scenarioIdOfRef(s.scenarioRef) === scenario.id) {
      push({ code: 'SELF_REFERENCING_CALL', level: 'error', stepId: s.id, message: '场景 call 自身（无限递归）', fix: '抽公共步骤到独立场景' });
    }
  }

  // 声明了却没用的输入。
  // 判据必须是**步骤正文里有没有引用它**，不能拿整个 IR 文本 substring 匹配 ——
  // 输入自己的声明（`{"name":"sku",…}`）就包含这个名字，所以旧写法恒为真，
  // 这条规则从来没报过。同时不再只查 required=false：声明了不用的必填输入
  // 更糟（它强迫每个调用方提供一个没人看的参数）。
  /*
   * 被搜的文本 = 三段步骤 **+ 各条 default**。
   *
   * 加 default 这一半是本轮"default 会被求值"带来的：`{name:'b'}` 只被
   * `{name:'a', default:{path:'$b'}}` 引用的写法从此是**合法用法**，
   * 而只搜步骤正文就会把它报成"声明了但没有任何步骤使用"——
   * 一句假话，让人去删掉一个真在用的输入（删了之后 a 的 default 直接求不出值）。
   * 仍然不含输入**自己的声明**（`name`/`type`/`required` 那些键），
   * 否则就退回旧的那个恒真 bug。
   */
  const stepsText = JSON.stringify([
    ...scenario.setup, ...scenario.body, ...scenario.teardown,
    ...scenario.inputs.map((p) => p.default),
  ]);
  /*
   * ⚠ **`$.name` 这一种写法以前不被认出来，于是这条规则会误报。**
   * 旧判据是 `stepsText.includes('$' + name)`，而 `"$.who"` 里**没有** `$who`
   * 这个子串（中间隔着点），于是"步骤里只用 `$.who` 引用输入"的场景
   * 每轮都收到一句"声明了但没有任何步骤使用"，让人去删一个真在用的输入。
   * 运行期是认的：`resolveRef('$.who')` 走 root 不在 run/env/step/secret 时的
   * 兜底分支 → `lookup('who')` → 帧 → inputs → env（实测见 `.scratch` 探针，
   * `assign:{got:'$.who'}` 与场景 `outputs` 都读到值）。
   * 这是**改前就在**的误报，本轮因为它多了一个触发面（default 引用另一个输入
   * 也是 `$.base` 这种写法）而顺手修掉。
   */
  for (const p of scenario.inputs) {
    const n = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const used = new RegExp(`\\$\\.?((run\\.)?inputs\\.)?${n}\\b`).test(stepsText)
      || new RegExp(`"${n}"\\s*:`).test(stepsText);
    if (!used) {
      push({ code: 'INPUT_UNUSED', level: 'warning', stepId: undefined, message: `输入参数 "${p.name}" 声明了但没有任何步骤使用${p.required ? '（而且是必填 —— 每个调用方都被迫提供它）' : ''}`, fix: `删掉它，或在步骤里用 $.run.inputs.${p.name} / $${p.name} 引用`, doc: 'docs/02 §5' });
    }
  }

  /*
   * `inputs[].default` 互引成环 —— 静态侧的那一道。
   *
   * 判据不在这里，在 `vars.ts` 的 `detectDefaultCycles`（拓扑排序与这条规则共用同一份
   * 边集；为什么必须共用、以及为什么"求值侧也判一次"不算重复，理由写在那个字段的注释上）。
   *
   * 级别取 **error**，与 `DEPENDENCY_CYCLE`（call 图成环）同一条论证：这种场景**必然**
   * 跑不起来，而它坏的方式是"任何一步都没跑到、inputs 就求不出值"，
   * 于是真跑出来的是一份 `status='error'` 而步骤表为空的报告 ——
   * 归因指向"平台坏了"而不是"这两条 default 互为依赖"。
   * 降成 warning 等于让 CI 放过一份注定空的报告。
   *
   * ⚠ **静态这一条比一次执行看得全，而这句话要说白**：调用方**把组内每一个都显式传入**时，
   * 一次真跑根本不会去求这些 default，于是不会抛。但静态上它仍然是坏的写法 ——
   * 那几条 default 成了"永远不许生效"的死字，而任何一次少传一个就整组求不出值。
   * 与假分支里的坏表达式同一种取舍（静态闸报的是"这份 IR 写坏了"，不是"这次会抛"）。
   * 消息里因此带上"只要有一个没被传入"这个条件，不假装它无条件必抛。
   *
   * `stepId` 留空：这是场景级的事实，不属于任何步骤，而伪造一个步骤 id
   * 会让人去那个步骤里找（那里什么都没有）。
   */
  for (const group of detectDefaultCycles(scenario.inputs)) {
    // 一个名字要说"引用了它自己"，不能说"互相引用"（同一个理由见 applyInputDefaults 里那格）
    const shape = group.length === 1
      ? `inputs[].default "${group[0]}" 引用了它自己`
      : `inputs 的 default 互相引用：${group.join(' ↔ ')}`;
    push({
      code: 'DEPENDENCY_CYCLE',
      level: 'error',
      message: `${shape}。只要其中**任何一个没被显式传入**，`
        + '这一组就求不出值（default 在**任何步骤跑之前**求值，所以它只能引用显式传入的输入、环境变量，或不构成环的其它 default）',
      fix: group.length === 1
        ? `把 ${group[0]} 的 default 改成不引用自己（字面量 / 环境变量 / 独立生成器），或者把它改成必填、由调用方传`
        : '把其中一条的 default 改成不引用组内其它输入（字面量 / 环境变量 / 独立生成器），或者把它们改成必填、由调用方传',
      doc: 'docs/02 §2',
    });
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
