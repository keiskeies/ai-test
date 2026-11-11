/**
 * 断言求值（docs/02 §4）。
 * 三条原则在这里执行：结构化优先、模糊默认、语义不参与门禁。
 */
import type { Match, Step } from '@atest/ir';
import type { StepResult, TraceEvent } from '@atest/ir';
// STEP_TARGET 是**值**导入（不是 type）：它是"kind → 端"那张表的唯一权威，
// 这里要真的读它。lint 侧读的是同一份（lint.ts 的 deriveTargets/STEP_TARGET），
// 所以"这条断言属于哪一端"这件事全仓只有一个答案。
import { STEP_TARGET } from '@atest/ir';
import { query, queryOne, PathError } from './jsonpath.js';
import { compileExpr } from './expr.js';
import { causeOfError } from './errors.js';
import type { AdapterRegistry, Clock, ExecContext } from './adapters.js';

export interface AssertOutcome {
  status: StepResult['status'];
  summary?: string;
  cause?: StepResult['cause'];
  keyContext?: Record<string, unknown>;
  costUsd?: number;
}

interface Deps {
  vars: { resolveRef(p: string): { found: boolean; value: unknown }; asExprRoot(): Record<string, unknown>; visible(): Record<string, unknown> };
  /**
   * 值形态求值（与引擎 `resolve.ts` 的 `resolveValue` 同一个实现，由解释器注入）。
   *
   * **必填、不给默认值**：给了默认值，"忘了接这一线"就编译得过去，而它对应的失效
   * 是静默的 —— `assertPage.contains` 在 IR 里是 `ValueSchema`，改动前这里
   * 从来没调用过任何求值，于是 `{expr:'len($.list) > 0'}` 会**整个对象**
   * 交给 adapter，而步骤判 pass。实测数据与完整推理见 `evalUiAssert` 上方那段。
   */
  resolveValue: (v: unknown) => unknown;
  adapters: AdapterRegistry;
  ctx: ExecContext;
  clock: Clock;
  addCost: (n: number) => void;
  emit: (e: { kind: string; stepId?: string; data?: Record<string, unknown> }) => void;
}

/**
 * 单个 Match 子句求值。
 *
 * `now` 是**注入的时间源**（必填，不给默认值）：nearNow 这类断言必须走它。
 * 给一个 `= Date.now` 的默认值等于把漏洞写进签名里 —— 每个忘记传参的调用点
 * 都会安静地读墙上时间，于是「冻结时钟后结果可复现」这条只在有人记得传参时成立。
 * 强迫每个调用点自己写 `() => 0` 或 `clock.now`，正是我们要的摩擦。
 */
export function evalMatch(actual: unknown, m: Match, present: boolean, now: () => number): { ok: boolean; why?: string } {
  if (m.ignore) return { ok: true };
  if (!present) return { ok: false, why: '路径未命中（该字段不存在）' };
  if (m.notNull && (actual === null || actual === undefined)) return { ok: false, why: '期望非空，实际为空' };
  if (m.isNull && actual !== null && actual !== undefined) return { ok: false, why: `期望 null，实际 ${JSON.stringify(actual)?.slice(0, 40)}` };
  if (m.type) {
    const t = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;
    if (t !== m.type) return { ok: false, why: `期望类型 ${m.type}，实际 ${t}` };
  }
  if (typeof m.exact !== 'undefined') {
    if (String(actual) !== String(m.exact)) return { ok: false, why: `期望精确等于 ${JSON.stringify(m.exact)}，实际 ${JSON.stringify(actual)?.slice(0, 60)}` };
  }
  if (typeof m.eq === 'number' && Number(actual) !== m.eq) return { ok: false, why: `期望 ${m.eq}，实际 ${String(actual)}` };
  if (typeof m.gt === 'number' && !(Number(actual) > m.gt)) return { ok: false, why: `期望 > ${m.gt}，实际 ${String(actual)}` };
  if (typeof m.gte === 'number' && !(Number(actual) >= m.gte)) return { ok: false, why: `期望 >= ${m.gte}，实际 ${String(actual)}` };
  if (typeof m.lt === 'number' && !(Number(actual) < m.lt)) return { ok: false, why: `期望 < ${m.lt}，实际 ${String(actual)}` };
  if (typeof m.lte === 'number' && !(Number(actual) <= m.lte)) return { ok: false, why: `期望 <= ${m.lte}，实际 ${String(actual)}` };
  if (typeof m.contains === 'string') {
    const hay = typeof actual === 'string' ? actual : JSON.stringify(actual) ?? '';
    if (!hay.includes(m.contains)) return { ok: false, why: `期望包含 "${m.contains}"` };
  }
  if (typeof m.matches === 'string') {
    if (!new RegExp(m.matches, m.regexFlags ?? 's').test(String(actual ?? ''))) return { ok: false, why: `不匹配正则 ${m.matches}` };
  }
  if (m.shape) {
    const r = checkShape(actual, m.shape);
    if (!r.ok) return r;
  }
  if (typeof m.minLength === 'number') {
    const len = Array.isArray(actual) ? actual.length : String(actual ?? '').length;
    if (len < m.minLength) return { ok: false, why: `长度 ${len} < 最小 ${m.minLength}` };
  }
  if (typeof m.maxLength === 'number') {
    const len = Array.isArray(actual) ? actual.length : String(actual ?? '').length;
    if (len > m.maxLength) return { ok: false, why: `长度 ${len} > 最大 ${m.maxLength}` };
  }
  if (m.isArray && !Array.isArray(actual)) return { ok: false, why: '期望数组' };
  if (m.each && Array.isArray(actual)) {
    for (let i = 0; i < actual.length; i++) {
      const r = evalMatch(actual[i], m.each, true, now);
      if (!r.ok) return { ok: false, why: `[${i}] ${r.why}` };
    }
  }
  if (m.nearNow) {
    const t = typeof actual === 'number' ? actual : Date.parse(String(actual));
    if (!Number.isFinite(t)) return { ok: false, why: '不是可比时间' };
    const diff = Math.abs(now() - t);
    if (diff > m.nearNow.withinMs) return { ok: false, why: `与当前时间差 ${diff}ms > ${m.nearNow.withinMs}ms` };
  }
  return { ok: true };
}

const SHAPE_RE: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  oid: /^[0-9a-f]{24}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  'phone-cn': /^1[3-9]\d{9}$/,
  'idcard-cn': /^\d{17}[\dXx]$/,
  url: /^https?:\/\/\S+$/,
  hex: /^(0x)?[0-9a-fA-F]+$/,
  digits: /^\d+$/,
  snowflake: /^\d{15,19}$/,
};

export function checkShape(v: unknown, shape: string): { ok: boolean; why?: string } {
  if (shape === 'nonEmpty') return v && String(v).length ? { ok: true } : { ok: false, why: '期望非空字符串' };
  const re = SHAPE_RE[shape];
  if (!re) return { ok: false, why: `未知结构模式 ${shape}` };
  if (v === null || v === undefined) return { ok: false, why: `期望 ${shape} 形态，实际为空` };
  return re.test(String(v)) ? { ok: true } : { ok: false, why: `不符合 ${shape} 形态：${String(v).slice(0, 40)}` };
}

/** 结构化断言求值 */
export function evalStructAssert(payload: { against: string; status?: number | number[]; jsonPath?: Record<string, Match>; expr?: string; exprExpected?: boolean; durationMs?: { gte?: number; lte?: number; eq?: number } }, deps: Deps): AssertOutcome {
  const src = deps.vars.resolveRef(payload.against);
  if (!src.found) return { status: 'error', summary: `断言源未找到：${payload.against}`, cause: 'case-stale' };
  const value = src.value as Record<string, unknown>;
  const failures: string[] = [];
  const checked: string[] = [];

  if (payload.status !== undefined) {
    const actual = Number(value?.status ?? value);
    const want = Array.isArray(payload.status) ? payload.status : [payload.status];
    checked.push('status');
    if (!want.includes(actual)) failures.push(`HTTP 状态期望 ${want.join('/')}，实际 ${actual}`);
  }
  if (payload.durationMs) {
    const d = Number(value?.durationMs ?? NaN);
    const c = payload.durationMs;
    checked.push('durationMs');
    if (Number.isNaN(d)) failures.push('缺少 durationMs');
    else if (c.lte !== undefined && d > c.lte) failures.push(`耗时 ${d}ms > ${c.lte}ms`);
    else if (c.gte !== undefined && d < c.gte) failures.push(`耗时 ${d}ms < ${c.gte}ms`);
  }
  const body = value?.body ?? value;
  for (const [path, clause] of Object.entries(payload.jsonPath ?? {})) {
    checked.push(path);
    try {
      const r = query(body, path.startsWith('$') ? path : `$.${path}`);
      if (r.values.length === 0) {
        const one = evalMatch(undefined, clause, false, deps.clock.now);
        if (!one.ok) failures.push(`${path}: ${one.why}`);
        continue;
      }
      for (let i = 0; i < r.values.length; i++) {
        const one = evalMatch(r.values[i], clause, true, deps.clock.now);
        if (!one.ok) { failures.push(`${r.paths[i] ?? path}: ${one.why}`); break; }
      }
    } catch (e) {
      /*
       * 这里**以前**写的是 `cause: 'case-stale'` —— 数值上恰好与 `causeOfError` 相同，
       * 但它是那条判据的**第五份手抄**（详见 errors.ts 顶部那张表），
       * 而且正是它让"同一条写坏的 `$.` 路径"在 assert 里是"用例过期"、
       * 在 set 里是"环境不可用"。改成调判据之后，**这里不再持有分类立场**，
       * 只保留本地那个"要不要把异常咽成返回值"的决定（那是本函数的事，不是判据的事）。
       *
       * 判据仍是 `instanceof PathError` 而**不是** `causeOfError(e) === 'case-stale'`：
       * 这一处吞的是"断言里那条路径写坏了"这一件具体的事，
       * 换成后者会把 ExprError / 超预算也一起咽进"断言路径错误"这句摘要里，
       * 摘要就开始说谎（`payload.expr` 的语法错走不到这里，它有自己的分支）。
       */
      if (e instanceof PathError) return { status: 'error', summary: `断言路径错误：${e.message}`, cause: causeOfError(e) };
      throw e;
    }
  }
  if (payload.expr) {
    checked.push('expr');
    const got = compileExpr(payload.expr).eval({ root: deps.vars.asExprRoot(), vars: deps.vars.visible(), now: () => deps.clock.now() });
    const want = payload.exprExpected ?? true;
    if (Boolean(got) !== want) failures.push(`表达式 ${payload.expr} 期望 ${want}，实际 ${got}`);
  }

  if (failures.length) {
    return {
      status: 'fail',
      summary: failures.join('；'),
      cause: 'product-bug',
      keyContext: { checked, failures, actualStatus: value?.status, actualBodyPreview: preview(body) },
    };
  }
  return { status: 'pass', summary: `断言通过（${checked.length || 1} 项）`, keyContext: { checked } };
}

/** 语义断言。report-only 时**绝不返回 fail**，只返回 triaged（docs/02 §4） */
export async function evalLlmAssert(payload: { question: string; evidenceFrom: string; gatePolicy: 'report-only' | 'blocking' | 'triage'; requireEvidenceQuote: boolean }, deps: Deps): Promise<AssertOutcome> {
  const src = deps.vars.resolveRef(payload.evidenceFrom);
  if (!src.found) return { status: 'error', summary: `语义断言证据源未找到：${payload.evidenceFrom}`, cause: 'case-stale' };
  if (!deps.adapters.llm) {
    deps.emit({ kind: 'lint.reported', data: { code: 'LLM_ADAPTER_MISSING', detail: '语义断言未执行（无 llm adapter）' } });
    return { status: 'skipped', summary: '语义断言跳过（无 llm adapter）' };
  }
  const r = await deps.adapters.llm.judge(
    { question: payload.question, evidence: src.value, requireQuote: payload.requireEvidenceQuote },
    deps.ctx,
  );
  deps.addCost(r.costUsd);
  const gate = payload.gatePolicy;
  if (r.passed) return { status: 'pass', summary: `语义判定：是（$${r.costUsd.toFixed(4)}）`, keyContext: { evidence: r.evidence }, costUsd: r.costUsd };
  if (gate === 'blocking') return { status: 'fail', summary: `语义判定：否（已设为门禁，需人复核）`, cause: 'product-bug', keyContext: { evidence: r.evidence }, costUsd: r.costUsd };
  // report-only / triage：不影响门禁
  return { status: 'triaged', summary: `语义判定：否（report-only，不计入通过率）`, keyContext: { evidence: r.evidence }, costUsd: r.costUsd };
}

/**
 * 界面断言（依赖 ui/device adapter 的 assertUi）。
 *
 * **选哪个 adapter 由步骤 kind 定，不再 `ui ?? device`**（docs/15 §3.6）。
 * 那行回退合起来看是容错，拆开看是"静默换执行对象"：
 * `assertPage`（web 档）在没有 ui 时会被 **device** 顶上，
 * 于是同一条断言在 Chrome 里查 ARIA、和在安卓上查 uiautomator 树，
 * **语义完全不是一回事，而结论都叫 pass**（实测：两侧 adapter 齐时打 UI、
 * 只给 device 时打 DEVICE，两次都是 `pass`）。
 * `assertUi`（mobile 档）方向相反且**更常踩**：混合场景两个 adapter 都在时，
 * 原先永远打 **UI** —— 移动端的断言被浏览器执行了。
 *
 * 判据取 `STEP_TARGET`（IR 里那张 kind → 端 的唯一权威表，lint 也用它），
 * 不在这里重抄一份清单 —— 抄一份就是本仓记过多次的"两处各一份，迟早只更新其中一处"。
 *
 * **刻意没有顺手改 `wait.ts` 那三处同形状的 `??`**：
 * `uiPredicate` / `template` / `uiIdle` 这三种等待条件在 schema 里**不带端**
 * （`STEP_TARGET.wait === 'any'`，条件对象里也没有 world/snapshotKind 字段），
 * 所以那里"该用哪一个"今天**在 IR 里根本没有答案** —— 硬选一个等于替 schema 做决定，
 * 而那个决定（要不要给 wait 条件加端字段、默认哪一档）是设计问题不是缺陷修复。
 * 已登记为待决，见 docs/15 §3.6 末段。
 *
 * ## `contains` / `expected` 要先过值形态求值（本轮）
 *
 * 这两个字段在 IR 里是 `ValueSchema`（四种形态都合法），而改动前这里
 * **把步骤对象整个 `as` 一下就交给 adapter**，一个字段都没求值。实测改前：
 * `assertPage{assertKind:'text', contains:{expr:'len($.list) > 0'}}`
 * => 该步 **pass**，adapter 收到的 `contains` 是 `{"expr":"…"}` **这个对象本身**。
 * 与 `act.value` 那一处同一个根（schema 承诺了、执行侧没做 —— docs/14 的缺陷类 (a)），
 * 所以修在同一个机制上而不是只修动作那一半：只修一处造出的症状是
 * "动作步骤里的 `{expr}` 生效、断言里的不生效"，而两处字段同名同形。
 *
 * **只碰这两个 ValueSchema 字段**：`ariaYaml` / `target` / `previousFrameRef`
 * 在 schema 里分别是 `z.string()` / `z.string()` / `RefSchema`，
 * 求值它们会把合法字面量喂进表达式编译器（反方向的错，与 `navigate.url` 同理）。
 */
export async function evalUiAssert(s: Step, deps: Deps): Promise<AssertOutcome> {
  const raw = s as unknown as { assertKind: string; target?: string; contains?: unknown; expected?: unknown; ariaYaml?: string };
  const world = STEP_TARGET[s.kind];
  const wantUi = world === 'web';
  const adapter = wantUi ? deps.adapters.ui : deps.adapters.device;
  const portName = wantUi ? 'ui' : 'device';
  if (!adapter || !('assertUi' in adapter)) {
    /*
     * 报错点名"缺的是哪一个 adapter"，并且**不再提另一个**。
     * 旧文案写的是 `ui/device`，那等于告诉排查人"另一个也行" ——
     * 而这条修复的全部内容就是"另一个不行"。
     *
     * **值求值排在这道闸之后**（本轮把求值加在这里，位置是选出来的）：
     * 放在前面的话，`contains:{expr:'写坏了'}` 又恰好没配 adapter 时，
     * 先抛出的是 ExprError，于是这一步的归因变成"表达式写坏了"，
     * 而该说的是"平台没配 adapter"。**两道闸的先后决定报错里哪句是真话。**
     */
    return {
      status: 'error',
      summary: `${s.kind} 属于 ${wantUi ? 'Web' : '移动端'}，需要 ${portName} adapter 提供 assertUi（本场景没有它；另一个 adapter 顶不上 —— 两者查的是不同的树）`,
      cause: 'env-unavailable',
    };
  }
  const p = {
    ...raw,
    contains: raw.contains === undefined ? undefined : deps.resolveValue(raw.contains),
    expected: raw.expected === undefined ? undefined : deps.resolveValue(raw.expected),
  };
  const r = await (adapter as unknown as { assertUi: (p: unknown, c: ExecContext) => Promise<{ passed: boolean; actual: unknown; expected: unknown }> }).assertUi(p, deps.ctx);
  if (!r.passed) {
    const negative = p.assertKind === 'absent' || p.assertKind === 'templateMiss';
    return {
      status: 'fail',
      summary: `界面断言不成立（${p.assertKind}）：期望 ${JSON.stringify(r.expected)?.slice(0, 60)}，实际 ${JSON.stringify(r.actual)?.slice(0, 60)}`,
      // 否定断言失败要格外可疑：视觉模型倾向过度报告存在（docs/10 §4）
      cause: negative ? 'untriaged' : 'product-bug',
      keyContext: { actual: r.actual, expected: r.expected, negative },
    };
  }
  return { status: 'pass', summary: `界面断言通过（${p.assertKind}）` };
}

export async function evaluateAssertions(s: Step, deps: Deps): Promise<AssertOutcome> {
  switch (s.kind) {
    case 'assert': return evalStructAssert(s as unknown as Parameters<typeof evalStructAssert>[0], deps);
    case 'assertLlm': return evalLlmAssert(s as unknown as Parameters<typeof evalLlmAssert>[0], deps);
    case 'assertPage': case 'assertUi': return evalUiAssert(s, deps);
    case 'assertPerf': {
      const p = s as unknown as { against: string; percentile: number; lte?: number; maxRegressionRatio?: number; errorRateLte?: number };
      const src = deps.vars.resolveRef(p.against);
      if (!src.found) return { status: 'error', summary: `性能指标源未找到：${p.against}`, cause: 'case-stale' };
      const metrics = src.value as Record<string, number>;
      const pctl = Number(metrics[`p${p.percentile}`] ?? metrics.p95 ?? NaN);
      if (!Number.isFinite(pctl)) return { status: 'error', summary: `缺少 p${p.percentile} 指标（性能断言需要 adapter 产出分位数）`, cause: 'env-unavailable' };
      const fails: string[] = [];
      if (p.lte !== undefined && pctl > p.lte) fails.push(`p${p.percentile}=${pctl}ms > ${p.lte}ms`);
      if (p.errorRateLte !== undefined && (metrics.errorRate ?? 0) > p.errorRateLte) fails.push(`错误率 ${(metrics.errorRate ?? 0).toFixed(4)} > ${p.errorRateLte}`);
      if (p.maxRegressionRatio !== undefined) {
        // **写了阈值却没拿到基线，必须报错而不是跳过**。
        // 早先是 `&& metrics.baselinePctl` —— 基线缺失时整条判据静默不跑，
        // 断言照样 pass。于是"性能回归门禁"在基线表为空的那半年里
        // 一直在绿灯放行，而看板上一片绿，没人知道它拦过什么（0 次）。
        // 这与 docs/09 §4.3 里"没基线 -> unknown"是同一条原则：
        // 判不出来要说判不出来，不能给通过。
        const bPctl = Number(metrics.baselinePctl ?? NaN);
        if (!Number.isFinite(bPctl) || bPctl <= 0) {
          return {
            status: 'error',
            summary: `声明了 maxRegressionRatio=${p.maxRegressionRatio}，但指标里没有有效的 baselinePctl（当前 ${String(metrics.baselinePctl ?? '缺失')}）。性能回归判据没有跑 —— 这不是通过`,
            cause: 'case-stale',
            keyContext: { metrics },
          };
        }
        const ratio = (pctl - bPctl) / bPctl;
        if (ratio > p.maxRegressionRatio) fails.push(`相对基线退化 ${(ratio * 100).toFixed(1)}% > 阈值 ${(p.maxRegressionRatio * 100).toFixed(0)}%`);
      }
      return fails.length
        ? { status: 'fail', summary: fails.join('；'), cause: 'product-bug', keyContext: { metrics } }
        : { status: 'pass', summary: `p${p.percentile}=${pctl}ms`, keyContext: { metrics } };
    }
    default:
      return { status: 'error', summary: `不是断言节点：${s.kind}`, cause: 'env-unavailable' };
  }
}

function preview(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

export type { TraceEvent };
