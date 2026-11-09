/**
 * 执行器抽象 + 时钟/随机数注入（docs/09 §4.2）。
 *
 * 为什么 StepExecutor 是接口而不是解释器里的 if 分支：
 *   压测形态必须**整体绕开解释器**（预编译表达式、复用请求对象、跳过 per-step 证据落盘），
 *   否则测出来的是自己 IO 的天花板（docs/09 §4.2）。在解释器里加 `if (perfMode)`
 *   是这类系统最常见的架构腐化点。
 */

/** 引擎对外的唯一副作用出口。所有网络/设备/DB 访问都经这里。 */
export interface ExecContext {
  target: 'api' | 'web' | 'android' | 'ios' | 'harmony';
  runId: string;
  /** 环境（已解析到具体修订） */
  env: Record<string, unknown>;
  /** 密钥解析。只有 adapter 拿得到；Agent 上下文永远拿不到（docs/02 §5） */
  secret(ref: string): string;
  clock: Clock;
  /** 事件发射。引擎同时镜像到 trace.jsonl（crash 后仍可分析） */
  emit(e: EmitInput): void;
  /** 证据存储。返回 artifact id，绝不把大对象塞进变量空间 */
  saveArtifact(kind: string, data: Uint8Array | string, stepId: string): Promise<string>;
  /** 能力探测结果。Agent 生成期与静态闸都读它（docs/09 §1.1 约束 3） */
  capabilities(target: string): { snapshotKind: string; locatorBy: string[]; templateMatch: boolean } | undefined;
}

export interface EmitInput {
  kind: string;
  stepId?: string;
  status?: string;
  durMs?: number;
  data?: Record<string, unknown>;
}

/** HTTP 能力（api adapter 实现） */
export interface HttpExec {
  send(req: {
    method: string; url: string; headers: Record<string, string>;
    body?: unknown; form?: Record<string, string>; timeoutMs: number; maxBytes: number; followRedirects: boolean;
  }, ctx: ExecContext): Promise<{
    status: number; headers: Record<string, string>; body: unknown; bodyText: string;
    durationMs: number; bytes: number; truncated: boolean;
  }>;
  /** OpenAPI 参数具象化 + 请求侧 schema 校验 */
  resolveOperation(ref: { docRef: string; operationId?: string; method?: string; path?: string }): Promise<{
    /** 解析到的 operationId。缺失时的稳定别名算法见 docs/05 §1（必须是纯函数） */
    operationId?: string;
    method: string; urlTemplate: string; requiredBodyFields: string[]; deprecated: boolean; strategyHint?: string;
  }>;
  /**
   * 请求侧 schema 校验（IR 的 `validateRequest`，M2 的"双向校验"里的请求向）。
   *
   * 为什么在**发出去之前**校验：请求体不符合 spec 时后端的行为是不可预期的 ——
   * 可能 400、可能静默丢弃未知字段、可能 200 但存了半条数据。
   * 用例于是拿到一个"看起来通过"的结果，而它测的根本不是那个接口。
   * 本地挡下来还有一条好处：报错是"你的请求少了 amount 字段"，
   * 而不是"后端回了个 400，原因未知"。
   *
   * 不实现（返回 undefined）时引擎跳过并留一条事件，**不当成通过**。
   */
  validateRequest?(ref: { docRef: string; operationId?: string }, body: unknown): Promise<{ ok: boolean; violations: string[] }>;
  /**
   * 响应侧 schema 校验（docs/05 §1.1 的「符合性检查」）。
   *
   * 语义与请求侧**完全不同**，两条都不能弄反：
   *  1. 只在 `env.specAuthoritative === true` 时调用。默认关 —— docs/00 §6.2 的教训是
   *     "默认开"会让 schema 与实现的小出入刷红几千次，然后团队关掉整个门禁。
   *  2. 结果**只上报不判失败**（引擎侧走 emit，不改 step.status）。
   *     响应不符 spec 的含义是"文档与实现谁错了"，不是"功能坏了"，
   *     混进业务回归的红灯里会让人把所有红灯都当成"又是文档不准"，从而漏掉真 bug。
   */
  validateResponse?(ref: { docRef: string; operationId?: string }, status: number, body: unknown): Promise<{ ok: boolean; violations: string[] }>;
}

export interface UiExec {
  navigate(url: string, waitUntil: string, ctx: ExecContext): Promise<void>;
  perform(op: unknown, target: unknown, ctx: ExecContext): Promise<void>;
  snapshot(ctx: ExecContext): Promise<{ kind: string; data: string; sha: string }>;
  /** 返回实际使用的定位策略与级别，供 flaky 治理统计（docs/00 §5.11） */
  resolve(locator: unknown, ctx: ExecContext): Promise<{ resolvedBy: string; rung: number; confidence: number; nonReplayable: boolean; handle: string }>;
  assertUi(payload: unknown, ctx: ExecContext): Promise<{ passed: boolean; actual: unknown; expected: unknown }>;
}

export interface DeviceExec {
  lease(req: unknown, ctx: ExecContext): Promise<{ id: string; deviceRef: string; expiresAt: number }>;
  renew(lease: { id: string }, ctx: ExecContext): Promise<{ expiresAt: number }>;
  release(lease: { id: string }, ctx: ExecContext): Promise<void>;
  app(action: string, args: Record<string, unknown>, ctx: ExecContext): Promise<unknown>;
  snapshot(ctx: ExecContext): Promise<{ kind: string; data: string; sha: string }>;
  perform(op: unknown, target: unknown, ctx: ExecContext): Promise<void>;
  resolve(locator: unknown, ctx: ExecContext): Promise<{ resolvedBy: string; rung: number; confidence: number; nonReplayable: boolean; handle: string }>;
  /** DB 行等待条件也归到 adapter 侧（引擎不碰网络） */
  query?(sql: string, vars: Record<string, unknown>, ctx: ExecContext): Promise<unknown[]>;
}

/** 注册表。引擎只认这个，不认 Playwright/Appium。 */
export interface AdapterRegistry {
  http?: HttpExec;
  ui?: UiExec;
  device?: DeviceExec;
  db?: { query(datasource: string, sql: string, vars: Record<string, unknown>, ctx: ExecContext): Promise<unknown[]> };
  llm?: { judge(req: unknown, ctx: ExecContext): Promise<{ passed: boolean; evidence?: unknown; costUsd: number }> };
  capabilities?(target: string): { snapshotKind: string; locatorBy: string[]; templateMatch: boolean } | undefined;
}

/**
 * 时钟与随机数注入点。
 * 金样测试与压测要冻结它们，否则「回放」只是一段视频而不是证据（docs/00 §5.9）。
 */
export interface Clock {
  now(): number;
  /** 单调时钟（毫秒，非负、单调不减）。时长计算一律用它，不用墙上时间 */
  mono(): number;
  /** 可控睡眠。测试里是立即返回 */
  sleep(ms: number): Promise<void>;
  random(): number;
  mode: 'live' | 'frozen' | 'recorded';
}

/** 真实时钟。Node 侧由 adapter/CLI 注入，engine 自身不调任何 node API。 */
export function liveClock(): Clock {
  const start = Date.now();
  return {
    now: () => Date.now(),
    mono: () => Date.now() - start,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: () => Math.random(),
    mode: 'live',
  };
}

/** 确定性时钟：mono 按 sleep 累加、random 用可复现 LCG。测试与压测预编译形态用。 */
export function deterministicClock(seed = 1): Clock {
  let s = seed >>> 0;
  let t = 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return {
    now: () => 1_700_000_000_000 + t,
    mono: () => t,
    sleep: async (ms) => { t += ms; },
    random: rnd,
    mode: 'frozen',
  };
}
