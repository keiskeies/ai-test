/**
 * 场景解释器（docs/02 + docs/01 §2）。
 *
 * 三条硬约束在本文件的体现：
 *  1. **不 import 任何 node 内置模块**（由 tooling/lint-layers.mjs 在 CI 强制）——
 *     所以时钟、网络、设备、存储全部从外部注入。这是「本地/CI/服务端/GUI 校验必然一致」
 *     的技术保证，也是 Postman↔Newman、Apifox GUI↔CLI 分叉的根因所在。
 *  2. **等待是条件不是时长**：wait 节点走 poll 循环；sleep 才用 clock.sleep。
 *  3. **状态语义**：环境问题 → error，断言不成立 → fail，自愈 → healed（不算绿），
 *     前置不满足 → skipped。红绿可信是平台被不弃用的前提。
 */
import type { Step, Scenario, Lease } from '@atest/ir';
import { countsTowardPassRate, LEASE_REQUIRED, walk, type StepResult, type StepStatus, type TraceEvent } from '@atest/ir';
import { compileExpr, evalBool, truthy } from './expr.js';
import { queryOne, query, PathError } from './jsonpath.js';
import { VarError, VarSpace } from './vars.js';
import type { AdapterRegistry, Clock, ExecContext } from './adapters.js';
import { evaluateAssertions } from './assertions.js';
import { resolveValue as resolveValueShared, toIterable, flattenTimes, looseEq, type ValueScope } from './resolve.js';
import { waitUntil } from './wait.js';
import { CONTEXT_LIMITS, redactForDisk } from './redact.js';

export interface RunOptions {
  scenario: Scenario;
  /** 上层输入 */
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  envRevision?: number;
  secretResolver?: (ref: string) => string;
  adapters: AdapterRegistry;
  clock: Clock;
  runId?: string;
  /** 成本上限（美元）。超出即中断并落盘证据，不是事后台账（docs/03 §2） */
  maxCostUsd?: number;
  signal?: { aborted: boolean };
}

export interface RunReport {
  runId: string;
  status: StepStatus;
  startedAt: number;
  durMs: number;
  results: StepResult[];
  /** 追加式事件流。真实运行时同时进 Redis Stream 与 trace.jsonl */
  events: TraceEvent[];
  outputs: Record<string, unknown>;
  costUsd: number;
  /** 通过率计算所需的分桶（healed 计入分母不计入分子，docs/12/13） */
  tally: { pass: number; fail: number; error: number; healed: number; skipped: number; triaged: number };
  /** 人类可读摘要，报告与 CI 评论用 */
  summary: string;
}

/**
 * 「故意发不合法请求」的策略（docs/05 §3）。请求侧 schema 校验对它们**只记事件不拦**：
 * 这些用例的全部价值就在于看后端拒不拒绝一个坏请求。
 *  - boundary 算：边界外那一半本来就越界。
 *  - authMatrix **不算**：它发的是合法 body，只是 token 不对 —— 请求体校验照样该做。
 *  - notFound 不算：不存在的 id 仍是合法字符串。
 */
const NEGATIVE_STRATEGIES = new Set(['requiredMissing', 'typeViolation', 'negativeFuzz', 'boundary']);

class RunAborted extends Error {}
/** 环境缺配置（如没配 baseUrl）。区别于"用例错了"：它该让人去改环境，不是改用例。 */
class EnvMissing extends Error {}

/**
 * 事件入参：kind 必须是 TraceEvent['kind'] 字面量。
 * 用 string 会把事件流变成垃圾场 —— 报表和 trace 查看器都靠这套枚举。
 */
type EmitIn = {
  kind: TraceEvent['kind'];
  stepId?: string;
  status?: TraceEvent['status'];
  runStatus?: TraceEvent['runStatus'];
  durMs?: number;
  cause?: TraceEvent['cause'];
  data?: Record<string, unknown>;
  path?: string[];
};

/** 步骤级执行上下文。租约继承走这里，不用全局状态。 */
interface StepCtx {
  lease?: Lease;
  watchers: { rules: { match: Record<string, string | undefined>; action: string; maxTimes: number; hit: number }[] }[];
}

export async function runScenario(opts: RunOptions): Promise<RunReport> {
  const { scenario, adapters, clock } = opts;
  const runId = opts.runId ?? `run_${clock.now().toString(36)}`;
  // inputDefs 传 scenario.inputs：声明了 default 的输入要能被兜住，
  // 否则 IR 里的 default 是个没人读字段（详见 vars.ts 的 applyInputDefaults）
  const vars = new VarSpace({ inputs: opts.inputs, inputDefs: scenario.inputs, env: opts.env, secretResolver: opts.secretResolver });
  const events: TraceEvent[] = [];
  const results: StepResult[] = [];
  let seq = 0;
  let costUsd = 0;
  const maxCost = opts.maxCostUsd ?? scenario.config.maxCostUsd;
  const startedAt = clock.now();
  const t0 = clock.mono();

  const emit = (e: EmitIn): void => {
    const ev: TraceEvent = { seq: seq++, ts: new Date(clock.now()).toISOString(), mono: clock.mono(), path: [], data: {}, ...e };
    events.push(ev);
  };

  /**
   * 当前身份（docs/05 §2 的"多租户/多身份"）。
   *
   * 语义是"**从这一步起，同一序列里后续的步骤都用它**"（与 SQL 的 SET 一样是语句，
   * 不是块），所以它是一个会被改的值，而不是靠路径算出来的作用域。
   *
   * 两条防串的规定：
   *  1. **容器退出时复位**（见 runChildren 的 finally）：`forEach` 里某次迭代切了身份，
   *     不该把后续迭代一起带跑 —— 那会让"第 3 次迭代用了第 2 次的身份"这种结果
   *     完全依赖执行顺序，而顺序是不可见的。
   *  2. **parallel 的分支里禁止切身份**（见 case 'parallel'）：分支共享同一个变量，
   *     交错执行下"谁先切"决定后面看到谁 —— 而权限矩阵用例（A 的资源 B 读不到）
   *     要的恰恰是隔离，串了会**双双通过**。宁可当场报错，也不给一个随并发度变的答案。
   */
  let currentIdentity: string | undefined = scenario.identity;

  /**
   * 这批步骤里（含任意深度）有没有 useIdentity。
   *
   * 必须在**进入并行之前**静态判定，不能"运行时发现有人改了身份就报错"：
   * 交错执行下报错与否取决于调度顺序，而一个随并发度出现的 error
   * 会被当成 flaky 重试掉，正好把要防的东西藏起来。
   */
  const containsIdentitySwitch = (steps: Step[]): boolean => {
    let hit = false;
    walk(steps, (s) => { if (s.kind === 'useIdentity') hit = true; });
    return hit;
  };

  /**
   * 这一步该用哪个身份。**只有这一处公式**，http 与 openapiCall 共用。
   *
   * 为什么要有这个函数：两个入口原先各写一份，各错一处 ——
   *  - openapiCall 算出了 authIntent 却没塞进 send()（**算了不用**）；
   *  - http 读的是 `scenario.identity`（场景级静态值）而不是 currentIdentity，
   *    于是 useIdentity 切完之后它还是拿开头的身份 ——
   *    "切换身份"那一步自己变绿了，后面的请求一个都没变。
   * 两处都是本仓那个老毛病：字段在 IR 里、注释把它讲得很对、执行侧没人接。
   * 合成一处之后，"两个入口对同一件事各写一份、其中一份写错"不再可表达。
   *
   * 步骤上的 identity 优先于场景级：权限矩阵用例常在 forEach 里切，
   * 而整个场景也可能声明一个默认身份。
   */
  const identityFor = (stepIdentity: string | undefined): string | undefined => stepIdentity ?? currentIdentity;

  const ctxBase = {
    runId,
    env: opts.env ?? {},
    secret: (ref: string) => opts.secretResolver?.(ref) ?? `«unresolved:${ref}»`,
    clock,
    emit: (e: EmitIn) => emit({ kind: e.kind as TraceEvent['kind'], stepId: e.stepId, durMs: e.durMs, data: e.data }),
    saveArtifact: async (kind: string, data: Uint8Array | string, stepId: string) => {
      // id **由存储侧算，引擎不自己编**。
      // 早先这里是 `art_${shaish(...).slice(0,12)}_${kind}` —— shaish 是把 32 位 FNV-1a
      // 重复四遍拼成 64 个十六进制字符的**伪 sha256**，看着像、实际只有 2^32 的空间。
      // 更糟的是它**压根没存任何东西**就返回了一个 id：StepResult.artifactIds 里
      // 躺着一串永远取不到内容的哈希，而 evidence 包看起来是完整的。
      // 内容寻址的"址"必须由真正落地的那一方给出，否则引擎与存储各自算一遍，
      // 迟早算出两个不同的值（一边按 UTF-16 码元哈希、一边按 UTF-8 字节哈希）。
      if (!adapters.artifactStore) {
        // **拒绝而不是给个假 id**。返回 id 的话 StepResult.artifactIds 里会躺着一串
        // 取不到内容的哈希，evidence 包看起来完整、实际是空的 —— 而空证据包在
        // 三天后的排查里表现为"平台没存东西"，没人会想到是存储没接。
        throw new EnvMissing(`未配置证据存储（adapters.artifactStore 缺失），无法为步骤 "${stepId}" 保存 ${kind} 证据`);
      }
      const id = await adapters.artifactStore.save(kind, data, stepId);
      emit({ kind: 'artifact.saved', stepId, data: { id, kind, bytes: typeof data === 'string' ? byteLen(data) : data.byteLength } });
      return id;
    },
    capabilities: (t: string) => adapters.capabilities?.(t),
  };

  const execCtx = (target: ExecContext['target']): ExecContext => ({ ...ctxBase, target });

  /**
   * 自动证据（响应体等）的落盘入口。没配存储时**记事件并跳过**，
   * 与 ctxBase.saveArtifact（用例显式要求，没存储就抛）的区别见 makeAutoEvidence。
   */
  const autoEvidence = makeAutoEvidence({
    hasStore: Boolean(adapters.artifactStore),
    emit,
    artifactIdFor: (kind, data, stepId) => ctxBase.saveArtifact(kind, data, stepId),
  });

  /** 成本熔断。超出即中断 run —— 静默跳过会让预算形同虚设 */
  const addCost = (n: number): void => {
    costUsd += n;
    // 单位跟着字段名走（maxCostUsd → 美元）。写了 ¥ 的话，人会把 docs/03 里按美元定的
    // 预算数直接填进来，熔断阈值当场差一个汇率
    if (costUsd > maxCost) throw new RunAborted(`成本上限超出：$${costUsd.toFixed(4)} > $${maxCost.toFixed(4)}，已中断`);
  };

  const stepCtx: StepCtx = { watchers: [] };

  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw new RunAborted('外部取消');
    if (clock.mono() - t0 > scenario.config.timeoutMs) throw new RunAborted(`运行超时（${scenario.config.timeoutMs}ms）`);
  };

  /** 守望规则执行（docs/00 §5.5）：在步骤之间弹掉干扰弹窗，容器级生效 */
  const runWatchers = async (): Promise<void> => {
    if (!stepCtx.watchers.length || !adapters.device) return;
    for (const w of stepCtx.watchers) {
      for (const rule of w.rules) {
        if (rule.hit >= rule.maxTimes) continue;
        const snap = await adapters.device.snapshot(execCtx('android'));
        const hit = matchesHierarchy(snap.data, rule.match);
        if (!hit) continue;
        rule.hit++;
        emit({ kind: 'step.finished', stepId: 'watcher', status: 'pass', data: { action: rule.action, matched: hit, hitCount: rule.hit } });
        if (rule.action === 'click' && hit) {
          await adapters.device.perform({ op: 'click' }, { handle: hit, resolvedBy: 'watcher', rung: 1, confidence: 1, nonReplayable: false }, execCtx('android'));
        }
      }
    }
  };

  /** 单个步骤的执行。返回 StepResult，异常一律在此收敛成 error 状态。 */
  const runStep = async (s: Step, path: string[]): Promise<StepResult> => {
    checkAbort();
    for (const w of stepCtx.watchers) void w;
    const stepStart = clock.mono();
    emit({ kind: 'step.started', stepId: s.id, path });

    // 守卫：条件不成立 → skipped（不是 pass，也不是 fail）
    if (s.when) {
      let ok = false;
      try { ok = evalBool(s.when, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now }); }
      catch (e) { return finish(s, path, 'error', stepStart, errSummary(e), { cause: 'env-unavailable' }); }
      if (!ok) return finish(s, path, 'skipped', stepStart, `守卫条件不成立：${s.when}`);
    }

    // 租约：需要设备的步骤若上下文无租约 → error（RESOURCE_LEASE_MISSING 应在 lint 阶段就拦住）
    if (LEASE_REQUIRED.includes(s.kind) && !stepCtx.lease && s.kind !== 'manualHandoff') {
      if (!adapters.device) return finish(s, path, 'error', stepStart, '设备执行器未注册（device adapter 缺失）', { cause: 'env-unavailable' });
      return finish(s, path, 'error', stepStart, '执行设备步骤前缺少 device 租约', { cause: 'env-unavailable' });
    }

    try {
      const outcome = await dispatch(s, path);
      // 守望在步骤之后跑一次，处理「上一步触发的弹窗」
      await runWatchers();
      return finish(s, path, outcome.status, stepStart, outcome.summary, {
        cause: outcome.cause, resolvedBy: outcome.resolvedBy, rung: outcome.rung,
        confidence: outcome.confidence, healed: outcome.healed, nonReplayable: outcome.nonReplayable,
        keyContext: outcome.keyContext, costUsd: outcome.costUsd ?? 0,
        // 不传就得留空数组：finish 的默认已经是 []，这里只在有证据时覆盖
        ...(outcome.artifactIds?.length ? { artifactIds: outcome.artifactIds } : {}),
      });
    } catch (e) {
      if (e instanceof RunAborted) throw e;
      const status: StepStatus = e instanceof AssertionFailure ? 'fail' : 'error';
      return finish(s, path, status, stepStart, errSummary(e), {
        cause: e instanceof AssertionFailure ? 'product-bug' : e instanceof VarError ? 'case-stale' : 'env-unavailable',
        keyContext: { errorName: (e as Error).name, stack: firstFrames(e) },
      });
    }
  };

  const finish = (
    s: Step, path: string[], status: StepStatus, at: number, summary?: string,
    extra: Partial<StepResult> = {},
  ): StepResult => {
    const r: StepResult = {
      stepId: s.id, kind: s.kind, status, durMs: clock.mono() - at, retry: 0,
      assertionSummary: summary, costUsd: 0, healed: false, nonReplayable: false,
      artifactIds: [], keyContext: {}, ...extra,
      cause: extra.cause ?? (status === 'fail' ? 'product-bug' : status === 'error' ? 'untriaged' : undefined),
    };
    results.push(r);
    emit({ kind: 'step.finished', stepId: s.id, path, status, durMs: r.durMs, data: { summary, ...(extra.keyContext ?? {}) } });
    // 失败传播由调用方按 onError 决定；这里只负责记录
    return r;
  };

  /** 带重试的包装 */
  const withRetry = async (s: Step, path: string[], fn: () => Promise<StepResult>): Promise<StepResult> => {
    const max = s.retry?.count ?? scenario.config.retries.count;
    let last: StepResult | undefined;
    for (let attempt = 0; attempt <= max; attempt++) {
      last = await fn();
      const retryable = last.status === 'error' && (s.retry?.retryOn ?? ['network', 'timeout']).some((k) => (last?.cause ?? '') === (k === 'status5xx' ? 'env-unavailable' : k));
      if (last.status === 'pass' || last.status === 'healed' || !retryable || attempt === max) {
        if (attempt > 0) results[results.length - 1] = { ...last, retry: attempt };
        return last;
      }
      const backoff = s.retry?.backoff === 'exponential'
        ? Math.min((s.retry?.baseMs ?? 2000) * 2 ** attempt, s.retry?.maxMs ?? 10_000)
        : (s.retry?.baseMs ?? 2000);
      await clock.sleep(backoff);
    }
    return last!;
  };

  interface Outcome {
    status: StepStatus; summary?: string; cause?: StepResult['cause'];
    resolvedBy?: string; rung?: number; confidence?: number; healed?: boolean; nonReplayable?: boolean;
    keyContext?: Record<string, unknown>; costUsd?: number;
    /** 本步骤产出的证据 id。**由 dispatch 交回来**，不在 finish 里凭空造：
     *  证据是否真落盘取决于存储侧，finish 无从知道，在那里填等于编造。 */
    artifactIds?: string[];
  }

  const runChildren = async (steps: Step[], path: string[]): Promise<Outcome> => {
    const rs: StepResult[] = [];
    // 身份在**每个序列**入口快照、出口复位（理由见 currentIdentity 的注释）。
    // finally 是必须的：中途 return（子步骤失败且 onError 不是 continue）
    // 是常态而不是异常路径，只在正常结束复位等于"失败的场景里身份泄漏"。
    const identityBefore = currentIdentity;
    try {
      for (const c of steps) {
        const r = await withRetry(c, path, () => runStep(c, path));
        rs.push(r);
        if (r.status === 'fail' || r.status === 'error') {
          if (c.onError === 'continue') continue;
          if (c.onError === 'retry') { /* withRetry 已处理，走到这里说明重试用尽 */ }
          return { status: r.status, summary: `${c.name ?? c.id}: ${r.assertionSummary ?? ''}`.trim(), cause: r.cause };
        }
      }
    } finally {
      currentIdentity = identityBefore;
    }
    const healed = rs.some((r) => r.healed);
    return { status: healed ? 'healed' : 'pass', summary: `${rs.length} 个子步骤` };
  };

  const dispatch = async (s: Step, path: string[]): Promise<Outcome> => {
    switch (s.kind) {
      // ── 控制流 ────────────────────────────────────────────────
      case 'sequence': return runChildren(s.steps, [...path, s.id]);
      case 'if': {
        const ok = evalBool(s.condition, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now });
        return runChildren(ok ? s.then : s.else, [...path, s.id]);
      }
      case 'switch': {
        const value = compileExpr(s.value).eval({ root: vars.asExprRoot(), vars: vars.visible(), now: clock.now });
        for (const c of s.cases) {
          if (looseEq(value, resolveValue(c.is))) return runChildren(c.steps, [...path, s.id]);
        }
        return runChildren(s.default, [...path, s.id]);
      }
      case 'forEach': {
        const items = toIterable(compileExpr(s.items).eval({ root: vars.asExprRoot(), vars: vars.visible(), now: clock.now }));
        const cap = Math.min(items.length, s.maxIterations);
        if (items.length > s.maxIterations) {
          emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'LOOP_TRUNCATED', detail: `数据 ${items.length} 条被 maxIterations=${s.maxIterations} 截断` } });
        }
        for (let i = 0; i < cap; i++) {
          const depth = vars.pushIteration(s.as, items[i], s.indexAs, i);
          const o = await runChildren(s.steps, [...path, s.id]);
          vars.popTo(depth); // 按深度回退：子步骤若没配对 pop（失败提前返回），迭代变量也不会漏出去
          if (o.status !== 'pass' && o.status !== 'healed') return o;
        }
        return { status: 'pass', summary: `迭代 ${cap} 次` };
      }
      case 'while': {
        let i = 0;
        while (i < s.maxIterations) {
          checkAbort();
          if (!evalBool(s.condition, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now })) break;
          const depth = vars.push('while');
          const o = await runChildren(s.steps, [...path, s.id]);
          vars.popTo(depth);
          if (o.status !== 'pass' && o.status !== 'healed') return o;
          i++;
        }
        if (i === s.maxIterations && evalBool(s.condition, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now })) {
          emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'LOOP_CEILING_HIT', detail: `达到上限 ${s.maxIterations}，条件仍为真` } });
        }
        return { status: 'pass', summary: `循环 ${i} 次` };
      }
      case 'repeat': return runChildren(flattenTimes(s.times, s.steps), [...path, s.id]);
      case 'parallel': {
        // **分支里不许切身份**。身份是共享的可变量，分支交错执行时
        // "谁先切"决定另一边看到谁 —— 而用 parallel 跑多身份恰恰是权限矩阵的
        // 常见写法（"A 和 B 同时读同一份资源"）。那种写法会**双双通过**：
        // 两个分支最后用的是同一个身份，断言"读不到"的那条自然也过。
        // 与其给一个随并发度变化的答案，不如当场说清该怎么写（拆成两条场景，
        // 或把分支改成 sequence 把切换收在分支内部 —— 后者仍然会竞态，所以一律拒）。
        const racing = s.steps.filter((c) => containsIdentitySwitch([c]));
        if (racing.length) {
          return {
            status: 'error', cause: 'case-stale',
            summary: `parallel 的分支里有 useIdentity（${racing.map((c) => c.id).join('、')}）。并行分支共享身份状态，结果会随调度顺序变化。`,
            keyContext: { hint: '每个身份写一条独立场景，或用 parallelGroup/concurrencySafe 让调度器串行化' },
          };
        }
        /*
         * 并发池。**原先写的是 `s.steps.slice(0, s.maxConcurrency)`** ——
         * 那是本仓那个缺陷类的第 9 例，而且比"字段没人读"更坏一级：
         * 分支压根没执行，场景照样 pass，summary 还说"并行 5 支"（用的是 s.steps.length）。
         * maxConcurrency 默认 4，所以任何 5 支以上的并行**每次都会静默丢尾巴**。
         * 被丢的是用例这件事没有任何地方看得见：结果里没有那些 stepId，
         * 报告里那一支是"通过"，覆盖率按分支数算 —— 全线一致地谎报。
         * 现在按池调度：谁先跑完谁补下一支，一支不漏；没来得及起跑的分支
         * 只可能在 failFast 提前中止时出现，那时**逐个补记为 skipped**，
         * 而不是从结果里消失（"没跑"必须能在报告里被读出来）。
         */
        const BAD = new Set(['fail', 'error']);
        const OK = new Set(['pass', 'healed']);
        const left = [...s.steps];
        const done: PromiseSettledResult<StepResult>[] = [];
        let stop = false;
        let abort: unknown;
        /** 一支 worker：跑完一支就补下一支，直到没活可补或 failFast 拉闸。
         *  共享数组的 shift/push 都发生在 await 之外，JS 单线程下不会交错破坏。 */
        const worker = async (): Promise<void> => {
          while (!stop) {
            const c = left.shift();
            if (!c) break;
            try {
              const r = await withRetry(c, [...path, s.id], () => runStep(c, [...path, s.id]));
              done.push({ status: 'fulfilled', value: r });
            } catch (e) {
              // RunAborted（外部取消/超时）必须能掀翻整个 run，不能被吞成"这支失败了"——
              // 吞掉的后果是取消之后其余分支还在往被测系统发请求。
              if (e instanceof RunAborted) { abort = e; stop = true; break; }
              done.push({ status: 'rejected', reason: e });
            }
            /*
             * **唯一的拉闸点**，写成"扫一遍已完成的分支"而不是在 try/catch 两边各写一次
             * `stop = true`。理由不是风格：抛错那条路**今天压根到不了** —— runStep 把除
             * RunAborted 以外的异常全收敛成 error 结果（interpreter.ts 的 catch），
             * 所以在 catch 里写的 stop 是一行永远执行不到的代码，变异它测试不会红，
             * 于是它会一直"看起来有防护"。判据落在可达的那一侧，两种失败就都覆盖了。
             *
             * **skipped 不算失败**：守卫不成立的分支不该把同批其他分支全拉停
             * （那会让"未执行"的规模由调度顺序决定，正是这个缺陷类最怕的 flaky 形态）。
             */
            if (s.failFast && done.some((d) => d.status !== 'fulfilled' || BAD.has(d.value.status))) stop = true;
          }
        };
        // min(...) 而不是直接 maxConcurrency：少开压根不会醒的 worker，
        // 免得将来有人往 worker 里加"每支都做一次"的副作用时凭空多出 N 次。
        await Promise.all(Array.from({ length: Math.min(s.maxConcurrency, s.steps.length) }, () => worker()));
        if (abort) throw abort;
        // 没起跑的分支（只可能在 failFast 拉闸后出现）补进结果里记 skipped。
        // **必须补**：从结果里消失的分支在报告里等于"不存在"，
        // 而这条分支本来要跑的断言恰恰是这次运行唯一没验的那部分。
        for (const c of left) finish(c, [...path, s.id], 'skipped', clock.mono(), '未执行（failFast：同批已有分支失败）');
        const bad = done.find((r) => r.status !== 'fulfilled' || BAD.has(r.value.status));
        if (bad) {
          const why = bad.status === 'rejected' ? errSummary(bad.reason) : bad.value.assertionSummary;
          return { status: 'fail', summary: `并行分支中有失败：${why ?? '未知'}` };
        }
        // 只**全部**没成功才报 skipped。一支守卫没成立、四支通过的场景，
        // 那四支是真验过了；整只容器报 skipped 会把它们从通过率的分母里一起抹掉
        // （skipped 不计入分母，见 docs/02 §9），比原来"全算 pass"更失真。
        const ran = done.filter((r) => r.status === 'fulfilled');
        const allIdle = !ran.some((r) => OK.has((r as PromiseFulfilledResult<StepResult>).value.status));
        const notRun = done.filter((r) => r.status === 'fulfilled' && r.value.status === 'skipped').length + left.length;
        let tail = `并行 ${s.steps.length} 支`;
        if (notRun) tail += `，未执行 ${notRun} 支${left.length ? '（failFast 提前中止）' : '（分支自身守卫不成立）'}`;
        return { status: allIdle ? 'skipped' : 'pass', summary: tail };
      }
      case 'call': {
        if (!adapters.http && !('callScenario' in adapters)) return { status: 'error', summary: '子场景解析器未注入（CallResolver）', cause: 'env-unavailable' };
        const sub = (adapters as unknown as { callScenario: (ref: string) => Promise<Scenario> }).callScenario(s.scenarioRef);
        const child = await sub;
        const childVars = new VarSpace({
          inputs: Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, resolveValue(v)])),
          // 子场景自己的 inputs 声明：call.args 没给全时由子场景的 default 兜。
          // 用 child.inputs 而不是父场景的 —— default 属于被调用方
          inputDefs: child.inputs,
          env: opts.env, secretResolver: opts.secretResolver,
        });
        const rep = await runScenarioIn({ scenario: child, vars: childVars, adapters, clock, emit: (e: EmitIn) => emit({ kind: e.kind as TraceEvent['kind'], stepId: e.stepId, status: e.status as TraceEvent['status'], durMs: e.durMs, data: e.data, path: [...path, s.id] }), ctxBase, execCtx, addCost, stepCtx, depth: 0 });
        if (s.assignTo) vars.set(s.assignTo, rep.outputs);
        if (rep.status === 'fail' || rep.status === 'error') return { status: rep.status, summary: `子场景 ${child.name}: ${rep.summary}`, cause: rep.results.find((r) => r.cause)?.cause };
        return { status: 'pass', summary: `子场景 ${child.name}` };
      }

      // ── 等待 ──────────────────────────────────────────────────
      case 'wait': {
        const r = await waitUntil({
          predicate: s.condition, timeoutMs: s.timeoutMs, pollMs: s.pollMs, backoff: s.backoff,
          clock,
          evalExpr: (e) => evalBool(e, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now }),
          resolveRef: (ref) => vars.resolveRef(ref).value,
          adapters, ctx: execCtx(targetOf(s, stepCtx)),
        });
        if (!r.satisfied) {
          if (s.onTimeout === 'continue') return { status: 'pass', summary: `等待超时但按 onTimeout=continue 继续：${r.describe}` };
          // IR 的 onTimeout 有三个合法取值（waits.ts:79 fail/continue/error），
          // 早先这里只分 'continue' 与"其余"，于是 **error 是个永远走不到的 schema 取值**：
          // 用户显式要求"等不到就算环境问题"，却拿到一个 fail ——
          // fail 的含义是"产品有 bug"，值班人会去查一个不存在的功能问题。
          if (s.onTimeout === 'error') return { status: 'error', summary: `等待超时（${s.timeoutMs}ms），按 onTimeout=error 判为环境问题：${r.describe}`, cause: 'env-unavailable', keyContext: { waitedMs: r.waitedMs, condition: r.describe } };
          return { status: 'fail', summary: `等待超时（${s.timeoutMs}ms）：${r.describe}`, cause: 'env-unavailable', keyContext: { waitedMs: r.waitedMs, condition: r.describe } };
        }
        return { status: 'pass', summary: `等待满足（${r.waitedMs}ms）：${r.describe}`, keyContext: { waitedMs: r.waitedMs } };
      }
      case 'sleep':
        await clock.sleep(s.ms);
        return { status: 'pass', summary: `等待 ${s.ms}ms（lint 会警告裸 sleep）` };

      // ── 变量 ──────────────────────────────────────────────────
      case 'set': {
        for (const [k, v] of Object.entries(s.assign)) vars.setDeep(k, resolveValue(v));
        vars.exportStep(s.id, vars.visible());
        return { status: 'pass', summary: `赋值 ${Object.keys(s.assign).join(', ')}` };
      }
      case 'table': {
        const rows = s.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, resolveValue(v)])));
        vars.set('table', rows);
        vars.exportStep(s.id, { rows });
        return { status: 'pass', summary: `${rows.length} 行数据表` };
      }
      case 'extract': {
        const src = vars.resolveRef(s.from);
        if (!src.found) return { status: 'error', summary: `extract 源未找到：${s.from}`, cause: 'case-stale' };
        const got: Record<string, unknown> = {};
        for (const rule of s.rules) {
          let v: unknown;
          if (rule.mode === 'jsonpath') v = queryOne(src.value, rule.path, { allowAmbiguous: false });
          else if (rule.mode === 'regex') {
            // regex 是给**非 JSON 响应体**用的（HTML/文本接口在国内很常见，见 IR 注释）。
            // 直接 String(响应对象) 会得到 "[object Object]"，于是正则永远不匹配、
            // 报「提取失败」，用户以为是正则写错了 —— 所以按 bodyText → 字符串 body 取值。
            const s0 = src.value as { bodyText?: string; body?: unknown } | undefined;
            const text = typeof s0?.bodyText === 'string' ? s0.bodyText
              : typeof s0?.body === 'string' ? s0.body
              : typeof src.value === 'string' ? src.value
              : s0 && 'body' in s0 ? JSON.stringify(s0.body)
              : JSON.stringify(src.value);
            let re: RegExp;
            try { re = new RegExp(rule.path, 's'); }
            catch (e) { return { status: 'error', summary: `正则本身不合法：${(e as Error).message}`, cause: 'case-stale', keyContext: { pattern: rule.path } }; }
            const m = text.match(re);
            v = m ? (rule.group ? m[rule.group] : m[1] ?? m[0]) : undefined;
            if (v === undefined && rule.required) {
              // 不匹配时把正则在**哪段文本**上试过的也交出去，否则用户只能盲改
              return { status: 'error', summary: `提取失败（regex）：${rule.path} 未匹配`, cause: 'case-stale', keyContext: { from: s.from, pattern: rule.path, sample: preview(text) } };
            }
          } else if (rule.mode === 'header') {
            const hs = (src.value as { headers?: Record<string, unknown> } | undefined)?.headers;
            v = hs?.[rule.path.toLowerCase()] ?? queryOne(src.value, `$.headers.${rule.path}`);
          }
          else v = extractFromAria(String((src.value as { data?: string })?.data ?? ''), rule.path);
          if (v === undefined && rule.required) {
            return { status: 'error', summary: `提取失败（${rule.mode}）：${rule.path}`, cause: 'case-stale', keyContext: { from: s.from, sample: preview(src.value) } };
          }
          vars.set(rule.var, v);
          got[rule.var] = v;
        }
        vars.exportStep(s.id, got);
        return { status: 'pass', summary: `提取 ${Object.keys(got).join(', ')}`, keyContext: redactForDisk(got, 0, CONTEXT_LIMITS) as Record<string, unknown> };
      }
      case 'dataSource': {
        if (!adapters.db) return { status: 'error', summary: 'dataSource 需要 db adapter', cause: 'env-unavailable' };
        if (s.source.type !== 'mysql') return { status: 'error', summary: `P0 仅支持 mysql 数据源（收到 ${s.source.type}）`, cause: 'env-unavailable' };
        const rows = await adapters.db.query(s.source.datasource, s.source.sql, {}, execCtx('api'));
        vars.set('rows', rows);
        vars.exportStep(s.id, { rows, count: rows.length });
        return { status: 'pass', summary: `数据源 ${rows.length} 行` };
      }
      case 'script':
        return { status: 'error', summary: 'script 节点在 P0 被禁用（沙箱未实现；它会绕过静态闸）', cause: 'env-unavailable' };

      // ── API ───────────────────────────────────────────────────
      case 'http': {
        if (!adapters.http) return { status: 'error', summary: 'http adapter 未注册', cause: 'env-unavailable' };
        const headers = strMap(s.request.headers, resolveValue);
        const query_ = strMap(s.request.query, resolveValue);
        const url = buildUrl(resolveUrl(s.request.url, ctxBase.env), query_);
        const res = await adapters.http.send({
          method: s.request.method, url, headers, body: s.request.body === undefined ? undefined : resolveValue(s.request.body),
          timeoutMs: s.timeoutMs ?? 30_000, maxBytes: s.maxResponseBytes, followRedirects: s.followRedirects,
          // 只交**引用与身份**，不交值。原先这里是
          // `headers.authorization = 'Bearer ' + ctxBase.secret(s.auth)` ——
          // 引擎由此同时知道了方案（Bearer 是硬编码的，于是 apiKey/basic 写不出来）
          // 和密钥真值（真值在引擎内存里，就能顺着任意一次 keyContext 流到磁盘）。
          // 现在怎么带、带不带、值从哪取，全在 adapter 的 auth 层（docs/05 §2）。
          //
          // 身份取 currentIdentity，**不是 scenario.identity**：后者是场景级的静态值，
          // 于是 useIdentity 切完之后这一行还是拿开头的身份 ——
          // "切身份"那一步自己变绿了，后面的请求却一个没变。
          // 与 openapiCall 用同一个表达式，就是为了两个入口不再各写一份。
          auth: s.auth || identityFor(s.identity)
            ? { ref: s.auth, identity: identityFor(s.identity) }
            : undefined,
        }, execCtx('api'));
        // bodyText 一并导出：regex 提取需要原始文本（HTML/文本接口）。见 extract 的 regex 分支。
        const exports = { resp: { status: res.status, body: res.body, bodyText: res.bodyText, headers: res.headers, durationMs: res.durationMs }, status: res.status, body: res.body };
        vars.exportStep(s.id, exports);
        if (s.saveAs) vars.set(s.saveAs, res.body);
        return { status: 'pass', summary: `${s.request.method} ${res.status} ${fmtMs(res.durationMs)}`, keyContext: { status: res.status, bytes: res.bytes, truncated: res.truncated } };
      }
      case 'openapiCall': {
        if (!adapters.http) return { status: 'error', summary: 'http adapter 未注册', cause: 'env-unavailable' };
        const op = await adapters.http.resolveOperation({ docRef: s.docRef, operationId: s.operationId, method: s.method, path: s.path });
        if (op.deprecated) emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'DEPRECATED_OPERATION', detail: s.operationId ?? `${op.method} ${op.urlTemplate}` } });
        const params = strMap(s.pathParams, resolveValue);
        let url = op.urlTemplate;
        for (const [k, v] of Object.entries(params)) {
          // 只替换真实出现的占位符；没出现说明 pathParams 写错了名字 ——
          // 静默忽略会得到"参数没生效但请求照样 200"的用例，所以要响
          const tpl = `{${k}}`;
          if (!url.includes(tpl)) {
            return { status: 'error', summary: `pathParams 里的 "${k}" 不在 ${op.urlTemplate} 的占位符里（拼错了？接口变了？）`, cause: 'case-stale' };
          }
          url = url.replace(tpl, encodeURIComponent(String(v)));
        }
        // 剩余未填占位符必须报错：把 `{id}` 原样发出去得到的是 404，查不到原因
        const leftover = url.match(/\{([^}/]+)\}/g);
        if (leftover) return { status: 'error', summary: `URL 里还有未填的参数：${leftover.join('、')}`, cause: 'case-stale' };
        const qs = strMap(s.queryParams, resolveValue);
        const headers = strMap(s.headers, resolveValue);
        // identity 交给 adapter 解析，**引擎不再自己查密钥**。
        // 原先这里写 `ctxBase.secret('identity:' + s.identity)`，而 CLI 的
        // secretResolver 只认 `secret:<ref>` 形态：'identity:admin' 归一出来是空串，
        // 取回占位符，然后 `if (!tok.startsWith('«'))` 安静地不加头 ——
        // 于是"切了身份"的用例其实一直在用默认身份跑，
        // 而"权限矩阵"那类用例（A 的资源 B 不能读）会**双方都拿到同一个身份**，
        // 表现为"权限测试全绿"，而它压根没测到权限。这是 docs/08 §3 那个缺陷类的又一例。
        //
        // **无条件带上**，不再以"有没有身份"为条件：这个对象的主体是
        // docRef/operationId/method/path —— adapter 拿它去 spec 里查这个 operation
        // 声明了哪个 securityScheme。而绝大多数 operation 都声明了 security、
        // 又由 env 的凭证表决定用哪个 ref，跟"这次有没有切身份"毫无关系。
        // 早先那个 `idForThisCall ? … : undefined` 的写法等于把"没切身份"当成
        // "这个 operation 是公开接口"，于是所有走 spec 的正常请求都变成匿名请求。
        const authIntent = {
          identity: identityFor(s.identity),
          docRef: s.docRef,
          // 三个都**优先取解析后的值**，步骤上声明的那个只作兜底。
          // adapter 拿 method + path 去 spec 里定位这个 operation、读它的 security，
          // 而 IR 里 method/path 是 optional（大多数用例只写 operationId）——
          // 交下来 undefined 等于让 adapter 定位不到，于是"按 spec 自动加鉴权"
          // 对这类用例整个失效，而且失效方式是"没加头"，看起来像后端不要鉴权。
          operationId: op.operationId ?? s.operationId,
          method: op.method ?? s.method,
          path: op.urlTemplate ?? s.path,
        };

        // 请求侧 schema 校验（IR 的 validateRequest 默认 true）。
        // **但对负向策略只记事件不拦**：requiredMissing / typeViolation / negativeFuzz
        // 的用意就是发一个不合法的请求去看后端拒不拒绝（docs/05 §3）。
        // 在这里一律拦，等于把最有价值的一类用例（后端缺参数校验）全部作废 ——
        // 而且废得很安静：用例会变成"跳过"，覆盖率看着还挺高。
        const bodyForSend = s.body === undefined ? undefined : resolveValue(s.body);
        if (s.validateRequest && adapters.http.validateRequest && !NEGATIVE_STRATEGIES.has(s.strategy ?? '')) {
          const v = await adapters.http.validateRequest({ docRef: s.docRef, operationId: op.operationId }, bodyForSend);
          if (!v.ok) {
            if (v.violations.length) emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'REQUEST_SCHEMA_MISMATCH', detail: v.violations.join('; ') } });
            return {
              status: 'error', cause: 'case-stale',
              // 发出去之前挡下来：本地的"少了 amount 字段"比后端的"400 原因未知"有用得多
              summary: `请求体不符合 spec（发送前拦截）：${v.violations.join('; ') || '结构不符'}`,
            };
          }
        } else if (s.validateRequest && !adapters.http.validateRequest) {
          // 用户要求校验但 adapter 没实现 —— 不能当成"校验通过"
          emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'VALIDATE_REQUEST_UNAVAILABLE', detail: 'http adapter 未实现 validateRequest，本步未做请求校验' } });
        }
        const res = await adapters.http.send({
          method: op.method, url: buildUrl(resolveUrl(url, ctxBase.env), qs), headers,
          body: bodyForSend,
          timeoutMs: s.timeoutMs ?? 30_000, maxBytes: 10_000_000, followRedirects: false,
          // 就是上面那个 authIntent。它原先算完就被丢在这里不用了 ——
          // 而它上面的注释正好在讲"为什么必须交给 adapter"。
          // 这类 bug 读代码看不出来（变量确实"被使用"了，用在上一行的字面量里），
          // 只有断言"send 收到的第二参里有它"才拦得住。
          auth: authIntent,
        }, execCtx('api'));
        // 响应侧符合性检查：**只在环境显式声明 spec 可信时做**，且**只上报**。
        // 两条都来自 docs/05 §1.1，弄反任何一条都会烧掉红绿的可信度：
        //  - 默认开 -> schema 与实现的小出入刷红几千次 -> 团队关掉整个门禁；
        //  - 判失败 -> "文档与实现谁错了"混进"功能坏了"里 -> 所有红灯都被当成误报。
        if (ctxBase.env.specAuthoritative === true && adapters.http.validateResponse) {
          const v = await adapters.http.validateResponse({ docRef: s.docRef, operationId: op.operationId }, res.status, res.body);
          // 不带 status：这不是步骤的状态，也不该进 tally。
          // （曾经写成 status: 'healed' —— healed 在六态机里意思是"定位自愈待人审"，
          //  借来表示"文档不符"会让自愈队列里混进一堆跟定位无关的东西。）
          if (!v.ok) emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'RESPONSE_SCHEMA_MISMATCH', detail: v.violations.join('; '), reportOnly: true } });
        }
        vars.exportStep(s.id, { resp: { status: res.status, body: res.body, bodyText: res.bodyText, headers: res.headers, durationMs: res.durationMs }, status: res.status, body: res.body, strategy: s.strategy });
        if (s.saveAs) vars.set(s.saveAs, res.body);
        // **响应体落证据**。这一句之前不存在：saveArtifact 端口定义了却没人调用，
        // 于是 evidence.zip 里**没有响应体** —— 而失败排查第一个要看的就是它。
        // M6 的判据是"一次失败 run 产出可独立打开的 evidence.zip"，
        // 一个不含响应的证据包只是四份元数据，打开它什么也查不出来。
        //
        // 为什么在这里**无条件存**（而不是"失败才存"）：
        // 步骤级"失败"经常不在 http 这一步 —— 200 回来后由 assert 步骤判红。
        // 按"这步没过才存"就会正好漏掉那些响应体。
        // 保留策略**归存储层**（它能看磁盘、能按 run 收尾清理），
        // 不在引擎里加 if：引擎只负责说"这是证据"。
        //
        // 存的是 bodyText（**原始文本**）而不是 body（已 JSON.parse 的对象）：
        // 重新 stringify 出来的东西和线上发的字节不再相等（键序、空格、数字精度、
        // 未引号化的 key 全可能变），而"后端到底发了什么字节"常常就是问题本身。
        const artifactId = await autoEvidence(s.id, 'http-response', res.bodyText);
        return {
          status: 'pass',
          summary: `${op.method} ${res.status} ${fmtMs(res.durationMs)}`,
          // 传输细节走 keyContext：step.finished 事件会把它带进 trace.jsonl，
          // 这正是 docs/05 §4 要的"截断要在 trace 里标 truncated"的落点。
          // （早先这信息由 adapter 自己发一条 kind:'http' 的事件承载，
          //  而那个 kind 不合法、trace 读回时被丢弃 —— 等于这条要求静默失效。）
          keyContext: { status: res.status, strategy: s.strategy, bytes: res.bytes, ...(res.truncated ? { truncated: true } : {}) },
          ...(artifactId ? { artifactIds: [artifactId] } : {}),
        };
      }

      // ── Web / 设备（P2/P4 实现，此处保证语义与状态正确）────────
      case 'navigate': case 'act': case 'capture': case 'tap': case 'input': case 'swipe': case 'key': case 'app': case 'logcat': {
        const uiOrDev = s.kind === 'navigate' || s.kind === 'act' || s.kind === 'capture' ? adapters.ui : adapters.device;
        if (!uiOrDev) return { status: 'error', summary: `${s.kind} 需要 ${s.kind === 'navigate' || s.kind === 'act' || s.kind === 'capture' ? 'ui' : 'device'} adapter`, cause: 'env-unavailable' };
        const locator = 'locator' in s ? s.locator : 'target' in s ? s.target : undefined;
        let resolved = { resolvedBy: 'n/a', rung: 0, confidence: 1, nonReplayable: false, handle: '' };
        if (locator && 'resolve' in uiOrDev) {
          resolved = await (uiOrDev as { resolve: (l: unknown, c: ExecContext) => Promise<typeof resolved> }).resolve(locator, execCtx(targetOf(s, stepCtx)));
          emit({ kind: 'locator.resolved', stepId: s.id, data: { ...resolved } });
        }
        if ('perform' in uiOrDev) await (uiOrDev as { perform: (o: unknown, t: unknown, c: ExecContext) => Promise<void> }).perform(opOf(s), resolved, execCtx(targetOf(s, stepCtx)));
        return {
          status: resolved.confidence < 0.99 ? 'healed' : 'pass',
          summary: `${s.kind} ${resolved.resolvedBy}${resolved.confidence ? ` (${resolved.confidence.toFixed(2)})` : ''}`,
          resolvedBy: resolved.resolvedBy, rung: resolved.rung || undefined, confidence: resolved.confidence,
          nonReplayable: resolved.nonReplayable,
          healed: resolved.rung >= 6, // 阶梯 6 级以上说明便宜路径没命中，标记待人审
        };
      }
      case 'device': {
        if (!adapters.device) return { status: 'error', summary: 'device adapter 未注册（P4）', cause: 'env-unavailable' };
        const l = await adapters.device.lease(s.require, execCtx(s.target));
        stepCtx.lease = { id: l.id, deviceRef: l.deviceRef, target: s.target, state: 'leased', acquiredAt: new Date(clock.now()).toISOString(), expiresAt: new Date(l.expiresAt).toISOString(), holder: runId, renewable: true };
        emit({ kind: 'lease.acquired', stepId: s.id, data: { device: l.deviceRef, lease: l.id } });
        return { status: 'pass', summary: `设备 ${l.deviceRef}` };
      }
      case 'watcher': {
        stepCtx.watchers.push({ rules: s.rules.map((r) => ({ ...r, hit: 0 })) });
        return { status: 'pass', summary: `守望 ${s.rules.length} 条规则（容器级生效）` };
      }
      case 'manualHandoff': {
        emit({ kind: 'manual.started', stepId: s.id, data: { reason: s.reason, recordActions: s.recordActions } });
        if (!adapters.device) return { status: 'skipped', summary: `人工介入跳过（无 device adapter）：${s.reason}` };
        return { status: 'skipped', summary: `等待人工接管：${s.reason}` };
      }
      case 'useIdentity': {
        /**
         * 这一步原先是 `return { status: 'pass', summary: '切换身份 X' }` —— **什么都没切**。
         * IR 里有字段、解释器回了个 pass，写"权限矩阵"用例的人会看到全绿，
         * 而所有请求都在用同一个身份发。这是本仓反复出现的"schema 有字段、执行侧没人读"
         * 的最坏一例：前几例至少会失败，这一例**报告成功**。
         *
         * 现在它真的改 currentIdentity。身份值本身仍不进变量空间（Agent 读到 token
         * 就能把它写进生成的用例里提交，docs/03 §5），只有名字进 trace。
         * 具体取哪个凭证由 adapter 按 (docRef, identity) 查凭证表。
         */
        const from = currentIdentity;
        currentIdentity = s.identity;
        return {
          status: 'pass',
          summary: `切换身份 ${from ?? '(默认)'} → ${s.identity}`,
          // preserveSession=false 的含义是"别把上一个身份的会话带过来"。
          // 会话（cookie jar / storageState）在 adapter 侧，这里只能把要求带出去。
          keyContext: { identity: s.identity, preserveSession: s.preserveSession, secrets: s.secrets.length },
        };
      }

      // ── 断言与横切 ─────────────────────────────────────────────
      case 'assert': case 'assertPage': case 'assertUi': case 'assertLlm': case 'assertPerf': {
        const r = await evaluateAssertions(s, { vars, adapters, ctx: execCtx(targetOf(s, stepCtx)), clock, addCost, emit: (e) => emit({ kind: e.kind as TraceEvent['kind'], stepId: e.stepId, data: e.data }) });
        vars.exportStep(s.id, { assertion: r });
        return r;
      }
      case 'db': {
        if (!adapters.db) return { status: 'error', summary: 'db adapter 未注册', cause: 'env-unavailable' };
        const rows = await adapters.db.query(s.datasource, s.sql, strMap(s.vars, resolveValue), execCtx('api'));
        if (s.assignTo) vars.set(s.assignTo, rows);
        vars.exportStep(s.id, { rows, count: rows.length });
        return { status: 'pass', summary: `DB ${rows.length} 行` };
      }
      case 'log':
        emit({ kind: 'log.emitted', stepId: s.id, data: { level: s.level, message: interpolate(s.message) } });
        return { status: 'pass', summary: 'log' };
      case 'fail':
        return { status: 'fail', summary: s.reason, cause: (s.cause as StepResult['cause']) ?? 'product-bug' };
      case 'noop':
        return { status: 'pass', summary: 'noop' };
      default:
        return { status: 'error', summary: `未知步骤类型 ${(s as Step).kind}`, cause: 'env-unavailable' };
    }
  };

  // 变量与值的解析入口
  // 值求值走**共享实现**（resolve.ts）。第二种执行形态（压测预编译）也调它 ——
  // 两条路径必须逐字节同语义，否则"功能全绿、压测报退化"能查三天。
  const valueScope: ValueScope = { vars, clock };
  const resolveValue = (v: unknown): unknown => resolveValueShared(v, valueScope);
  function interpolate(text: string): string {
    return text.replace(/\$[A-Za-z_][\w.[\]-]*/g, (m) => {
      try { const r = vars.resolveRef(m); return r.found ? String(r.value ?? '') : `⟨未定义:${m}⟩`; } catch { return `⟨错误:${m}⟩`; }
    });
  }
  const tally = { pass: 0, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 } as RunReport['tally'];
  /**
   * setup 是否失败 / body 是否跑过 / teardown 结果的起始下标。
   * resultBoundary 用来把 teardown 的结果排除在**整体状态**之外 —— 但**不排除**出
   * 通过率分母：清理没做干净是真问题，藏起来只会让环境越来越脏。
   */
  let setupPhaseFailed = false;
  let bodyRan = false;
  let resultBoundary = -1; // -1 = 还没进 teardown

  try {
    emit({ kind: 'run.started', data: { scenario: scenario.id, mode: scenario.mode, frozen: scenario.frozen, env: scenario.env.environmentRef } });
    // setup 失败 = error（前置不成立，不是产品缺陷）
    const setup = await runChildren(scenario.setup, ['setup']);
    if (setup.status === 'fail' || setup.status === 'error') {
      setupPhaseFailed = true;
      emit({ kind: 'run.finished', status: 'error', data: { phase: 'setup', detail: setup.summary } });
    } else {
      bodyRan = true;
      const body = await runChildren(scenario.body, ['body']);
      emit({ kind: 'run.finished', status: body.status, data: { detail: body.summary } });
    }
    // teardown 默认必跑（含 data GC）。它的失败**不进整体状态**：
    // 清理炸了是环境问题，而整体状态回答的是「被测功能对不对」。
    // 混在一起会让一次 cleanup 500 掩盖掉 body 的结论，或把绿的场景判成红的。
    // 记 resultBoundary 以便最后算状态时把 teardown 的结果排除在外。
    resultBoundary = results.length;
    if (scenario.teardown.length) {
      const td = await runChildren(scenario.teardown, ['teardown']);
      if (td.status === 'fail' || td.status === 'error') {
        emit({ kind: 'lint.reported', data: { code: 'TEARDOWN_FAILED', detail: `清理未成功，可能留脏数据：${td.summary}` } });
      }
    }
    for (const o of scenario.outputs) {
      const r = vars.resolveRef(o.from);
      if (r.found) vars.setOutput(o.name, r.value);
    }
    if (stepCtx.lease && adapters.device) await adapters.device.release({ id: stepCtx.lease.id }, execCtx('android'));
  } catch (e) {
    const aborted = e instanceof RunAborted;
    emit({ kind: 'error', status: aborted ? 'skipped' : 'error', data: { message: errSummary(e), aborted } });
    if (!aborted) results.push({ stepId: '__run__', kind: 'noop', status: 'error', durMs: clock.mono() - t0, retry: 0, healed: false, nonReplayable: false, costUsd: 0, artifactIds: [], keyContext: {}, assertionSummary: errSummary(e), cause: 'env-unavailable' });
  }

  for (const r of results) if (r.status in tally) tally[r.status as keyof typeof tally]++;
  const counted = tally.pass + tally.fail + tally.error + tally.healed;
  const rate = counted ? Math.round((tally.pass / counted) * 100) : 100;
  // 整体状态只看 setup+body（resultBoundary 之前）：teardown 的失败通过 TEARDOWN_FAILED
  // 事件与 tally 暴露，但不得改写「被测功能对不对」这个结论。
  const gate = resultBoundary < 0 ? results : results.slice(0, resultBoundary);
  // setup 失败一律升级为 error：前置不成立时被测系统根本没被真正测到，
  // 报 fail 会让值班人去查一个不存在的产品 bug（docs/02 §6 状态机语义）。
  const setupBroke = setupPhaseFailed && !bodyRan;
  const status: StepStatus = setupBroke ? 'error'
    : gate.some((r) => r.status === 'error') ? 'error'
    : gate.some((r) => r.status === 'fail') ? 'fail'
    : tally.healed > 0 ? 'healed' : 'pass';

  return {
    runId, status, startedAt, durMs: clock.mono() - t0, results, events,
    outputs: vars.outputs, costUsd, tally,
    summary: `${status} · ${counted} 步计入通过率 · ${rate}% 通过 · ${tally.healed} 自愈待审 · $${costUsd.toFixed(4)}`,
  };
}

// ── 辅助 ─────────────────────────────────────────────────────────────────

class AssertionFailure extends Error {}

/**
 * 耗时写进**人读摘要**时的固定格式。
 *
 * 不格式化会出两件坏事：
 *  1. 摘要里出现 `POST 201 4.305087999999955ms`。CI 日志与 PR 评论里这是噪音，
 *     而且没人能扫一眼比较两次运行。
 *  2. 更要紧的：**证据不再可比**。trace.jsonl 是逐行 JSON，summary 字段里
 *     一个 17 位浮点数意味着同一个场景跑两次，trace 的字节必然不同 ——
 *     M7 的"同一冻结场景跑 20 次断言结果一致"以及
 *     `diff <(unzip -p a.zip trace.jsonl) <(unzip -p b.zip trace.jsonl)` 全部失效。
 *     真实耗时本身是波动的，这一点改不了；能改的是**别把波动的位数扩散到
 *     本来该稳定的字段里**。要精确耗时的场景走 durMs 数值字段（那里如实保留）。
 */
export function fmtMs(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return `${v.toFixed(1)}ms`;
}

function strMap(o: Record<string, unknown> | undefined, resolve: (v: unknown) => unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    const r = resolve(v);
    if (r !== undefined && r !== null) out[k] = typeof r === 'string' ? r : JSON.stringify(r);
  }
  return out;
}
function buildUrl(base: string, qs: Record<string, string>): string {
  const entries = Object.entries(qs);
  if (!entries.length) return base;
  const usp = new URLSearchParams(entries.map(([k, v]) => [k, v]));
  return `${base}${base.includes('?') ? '&' : '?'}${usp.toString()}`;
}
/**
 * 拼最终 URL。IR 里只写 path（或以 `{envVar}` 开头的显式绝对地址），
 * 域名一律来自环境配置 —— docs/05 §1：spec 的 servers 几乎总是错的或写死某测试域，
 * 所以**连 spec 的 servers 都不用**，环境是唯一事实源。
 *
 * 相对地址 + 环境没配 baseUrl = 直接 error（env-unavailable），
 * 不是"那就原样发出去"：相对 URL 交给 fetch 会得到 Invalid URL 或打到平台自己的域名上，
 * 两种都比一条明确的"环境没配 baseUrl"难查。
 */
function resolveUrl(url: string, env: Record<string, unknown>): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = typeof env.baseUrl === 'string' ? env.baseUrl : typeof env.baseUrlTemplate === 'string' ? env.baseUrlTemplate : undefined;
  if (!base) throw new EnvMissing(`环境（${JSON.stringify(Object.keys(env))}）里没有 baseUrl，而用例地址是相对路径 "${url}"。IR 不写死域名是刻意的（docs/05 §1）`);
  return base.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}
function targetOf(s: Step, ctx: StepCtx): ExecContext['target'] {
  if (s.kind === 'device') return s.target;
  if (['navigate', 'act', 'capture'].includes(s.kind)) return 'web';
  if (['http', 'openapiCall', 'db'].includes(s.kind)) return 'api';
  return (ctx.lease?.target as ExecContext['target']) ?? 'android';
}
function opOf(s: Step): unknown {
  if (s.kind === 'act') return { op: s.action, value: s.value };
  if (s.kind === 'navigate') return { op: 'navigate', url: s.url, waitUntil: s.waitUntil };
  if (s.kind === 'input') return { op: 'fill', value: s.value };
  if (s.kind === 'swipe') return { op: 'swipe', to: s.to ?? [0, 0] };
  if (s.kind === 'key') return { op: 'press', key: s.key };
  if (s.kind === 'capture') return { op: 'snapshot' };
  return { op: 'click' };
}
function extractFromAria(text: string, needle: string): string | undefined {
  const m = text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]?\\s*(\\S+)', 'm'));
  return m?.[1];
}
function matchesHierarchy(xml: string, match: Record<string, string | undefined>): string | null {
  if (match.text) { const m = xml.match(new RegExp(`[^<>]*text="${esc(match.text)}"[^<>]*`)); if (m) return m[0]; }
  if (match.textContains) { const m = xml.match(new RegExp(`[^<>]*text="[^"]*${esc(match.textContains)}[^"]*"[^<>]*`)); if (m) return m[0]; }
  if (match.matches) { const m = xml.match(new RegExp(match.matches, 'm')); if (m) return m[0]; }
  return null;
}
function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function preview(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
function errSummary(e: unknown): string {
  if (e instanceof PathError || e instanceof VarError || e instanceof AssertionFailure || e instanceof EnvMissing) return e.message;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
function firstFrames(e: unknown): string {
  const st = (e as Error)?.stack ?? '';
  return st.split('\n').slice(1, 4).join(' | ').slice(0, 400);
}
/** 内容寻址用的轻量 hash（真实现要用 crypto，但引擎不许 import node:） */
/**
 * 引擎**自动**产证据（响应体、提取前的原始文本…）的统一出口。
 *
 * 与 ctx.saveArtifact 的区别是错误处理，而这个区别是刻意的：
 *  - `ctx.saveArtifact` 是**用例显式要求**存的证据，没存储就抛 —— 用户要的东西给不了，
 *    必须炸在步骤上，不能悄悄没存。
 *  - 这里（自动证据）没存储时**记一条事件然后跳过，不判步骤失败**：
 *    "没接证据盘"是部署配置问题，不该让每个 HTTP 步骤变红，
 *    否则第一次接平台的人看到的是"所有用例都 error"，
 *    而真实原因（没配 artifactStore）藏在摘要里。
 *    但**绝不静默**：没证据的话 M6 那个 evidence.zip 会是个只有元数据的空壳，
 *    而它看起来是打开成功的 —— 所以每个 run 至少要吼一声。
 */
function makeAutoEvidence(opts: {
  hasStore: boolean; emit: (e: EmitIn) => void; artifactIdFor: (kind: string, data: string, stepId: string) => Promise<string>;
}) {
  let warned = false;
  const warnOnce = (stepId: string): void => {
    if (warned) return;
    warned = true;
    // 只报一次：一个 200 步的套件会刷出 200 条同样的事件，把人淹掉
    opts.emit({ kind: 'lint.reported', stepId, data: { code: 'ARTIFACT_STORE_MISSING', detail: '未配置证据存储（adapters.artifactStore），本次运行的响应体等自动证据**没有落盘**，evidence 包将只含元数据' } });
  };
  return async (stepId: string, kind: string, data: string): Promise<string | undefined> => {
    if (!opts.hasStore) { warnOnce(stepId); return undefined; }
    return opts.artifactIdFor(kind, data, stepId);
  };
}

/**
 * UTF-8 字节数。**不用 string.length**：那是 UTF-16 码元数，
 * 一个中文响应体会把 3 字节算成 1 字节，于是 10MB 上限实际放行约 30MB，
 * docs/05 §4 那条"失控导出接口撑爆证据盘"的防线在中文接口上静默失效。
 */
function byteLen(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** 子场景执行入口（call 节点用）。与主流程共用 emit/adapters 以保成本与事件的连续性。 */
async function runScenarioIn(a: {
  scenario: Scenario; vars: VarSpace; adapters: AdapterRegistry; clock: Clock;
  emit: (e: EmitIn) => void;
  ctxBase: unknown; execCtx: (t: ExecContext['target']) => ExecContext; addCost: (n: number) => void; stepCtx: StepCtx; depth: number;
}): Promise<RunReport> {
  const rep = await runScenario({
    scenario: a.scenario, inputs: a.vars.inputs, env: a.vars.env, secretResolver: undefined,
    adapters: a.adapters, clock: a.clock, maxCostUsd: Number.MAX_SAFE_INTEGER,
  });
  a.addCost(rep.costUsd);
  for (const e of rep.events) a.emit({ kind: e.kind, stepId: e.stepId, status: e.status, durMs: e.durMs, data: e.data, path: e.path });
  return rep;
}

export { countsTowardPassRate };
