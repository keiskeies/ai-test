/**
 * Trace 事件模型（docs/01 §6 证据布局、docs/06 §7 回放对齐）。
 *
 * 两条铁律：
 *  1. **单一单调时钟源** + 每事件带 `seq`。否则「视频显示第 12 步而 trace 说第 9 步」（docs/00 §6.11）。
 *  2. 事件是**追加式**的，同一批事件既进 Redis Stream（实时）也镜像进 trace.jsonl
 *     （crash 后仍可分析）。二者形状相同，故在此定义一次。
 */
import { z } from 'zod';
import { FailureCauseSchema, RunStatusSchema, StepStatusSchema, type FailureCause, type StepStatus } from './status.js';
import { STEP_KINDS } from './steps.js';

export const TraceEventKind = [
  'run.started',
  'run.finished',
  'step.started',
  'step.finished',
  'assert.evaluated',
  'locator.resolved',
  'heal.attempted',
  'llm.called',
  'lease.acquired',
  'lease.renewed',
  'lease.lost',
  'manual.started',
  'manual.finished',
  'artifact.saved',
  'log.emitted',
  'lint.reported',
  'error',
] as const;
export type TraceEventKindT = (typeof TraceEventKind)[number];

export const TraceEventSchema = z
  .object({
    /** 运行内严格递增，供断点续传与回放对齐 */
    seq: z.int().min(0),
    /** 墙上时间（ISO），用于人阅读 */
    ts: z.string(),
    /** 单调时钟毫秒（performance.now 语义），用于算差值。**不要用 ts 算时长** */
    mono: z.number(),
    kind: z.enum(TraceEventKind),
    stepId: z.string().optional(),
    /** 容器路径，用于时间旅行视图定位 */
    path: z.array(z.string()).default([]),
    status: StepStatusSchema.optional(),
    runStatus: RunStatusSchema.optional(),
    cause: FailureCauseSchema.optional(),
    durMs: z.number().min(0).optional(),
    retry: z.int().min(0).optional(),
    /** 事件载荷。刻意宽松：证据细节由各 kind 自行扩展，避免引擎每加一种事件就改 schema */
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** 运行记录的环境指纹（Meticulous 式确定性注入，docs/00 §5.9） */
export const EnvFingerprintSchema = z
  .object({
    environmentRef: z.string(),
    envRevision: z.int(),
    /** 被测系统版本（前端构建号 / APK versionCode / 后端 git sha） */
    appSha: z.string().optional(),
    /** 执行环境 */
    runnerVersion: z.string(),
    platform: z.string(),
    /** UI 类运行的关键参数：变了结果就不可比 */
    viewport: z.string().optional(),
    deviceScaleFactor: z.number().optional(),
    locale: z.string().optional(),
    timezone: z.string().optional(),
    /** 确定性注入的实际生效值（冻结或记录的种子） */
    clockMode: z.enum(['frozen', 'recorded', 'live']).default('live'),
    randomSeed: z.number().int().optional(),
    /** LLM 配置指纹（同一场景换模型，结果含义可能不同） */
    llmProfileHash: z.string().optional(),
  })
  .strict();
export type EnvFingerprint = z.infer<typeof EnvFingerprintSchema>;

/**
 * 步骤结果。`resolvedBy`/`rung`/`healed` 是 flaky 治理与成本归因的数据源，
 * 必须结构化存下来而不是塞进日志文本（docs/00 §5.11 定位器健康度）。
 */
export const StepResultSchema = z
  .object({
    stepId: z.string(),
    kind: z.enum(STEP_KINDS),
    status: StepStatusSchema,
    cause: FailureCauseSchema.optional(),
    durMs: z.number().min(0),
    retry: z.int().min(0).default(0),
    /** 实际使用的定位策略（"testid" / "fingerprint:0.93" / "template:0.88"） */
    resolvedBy: z.string().optional(),
    rung: z.int().min(1).max(9).optional(),
    confidence: z.number().min(0).max(1).optional(),
    /** 自愈改写：软失败，不算绿，需人审 diff（docs/00 §5.6） */
    healed: z.boolean().default(false),
    nonReplayable: z.boolean().default(false),
    /** 断言摘要（不含大响应体，那些进 artifacts） */
    assertionSummary: z.string().max(2000).optional(),
    /** 失败时的关键上下文，用于「3 秒判断是不是真 bug」（docs/12 §4.2） */
    keyContext: z.record(z.string(), z.unknown()).default({}),
    costUsd: z.number().min(0).default(0),
    artifactIds: z.array(z.string()).default([]),
  })
  .strict();
export type StepResult = z.infer<typeof StepResultSchema>;

/**
 * 一次**没被采纳**的重试尝试的摘要。引擎把它写进最终那行的
 * `keyContext[FLAKY_OF_KEY]`（见 engine 的 withRetry）。
 *
 * **为什么在这里定义而不是 engine 侧写个字符串字面量**：
 * 写的一侧是 engine，读的一侧是 cli 的门禁与 engine 的 JUnit 出口 ——
 * 跨包匹配一个字符串字面量是本仓反复写的那类耦合（改个措辞就悄悄退化，
 * 而且没有任何编译期东西会发现）。key 与**读法**放在一起，两边 import 同一份。
 *
 * 为什么不进 StepResultSchema 的顶层：那是磁盘格式（strict），
 * 加字段等于改证据包 schema；而 flaky 的过程记录天生是**可选的额外信息**，
 * keyContext 就是这个"可选"的既定承载位。
 */
export interface FlakyAttempt {
  /** 第几次尝试（从 1 起；重试成功的那一步，最后一次不在这个列表里） */
  attempt: number;
  status: StepStatus;
  /** 这次重试**之前**等了多久（backoff）。0 表示没等 */
  waitedMs: number;
  cause?: FailureCause;
  summary?: string;
}

/** keyContext 里承载重试过程的字段名。只经 flakyAttempts() 读，别手写字面量。 */
export const FLAKY_OF_KEY = 'flakyOf';

/**
 * 读出一个步骤被撤掉的尝试。不是数组 / 缺字段的一律当"没有"，
 * 因为 keyContext 是 `record(string, unknown)`：手写 fixture、
 * 旧版本写的证据包、别的引擎实现都可能压根没这个键，
 * 而"读不到"在这里是**合法状态**（= 这一步没重试过），不是异常。
 *
 * **`r.keyContext` 本身也可能没有**（`?.` 不是防御性编程的噪音，是实测逼出来的）：
 * schema 里它是 `.default({})`，但那个 default 只对**过 schema 的对象**生效 ——
 * 门禁测试里的 StepResult 是手写字面量 + `as StepResult`，压根没这个属性。
 * 第一版这里写的是 `r.keyContext[FLAKY_OF_KEY]`，于是 25 条门禁测试
 * 全挂在 `Cannot read properties of undefined`：**门禁自己抛异常**意味着
 * 调用方拿不到退出码，比误报或漏报都糟。类型说"必填"不构成保证，
 * 因为 cast 能造出类型上必填而运行时没有的东西。
 */
export function flakyAttempts(r: { keyContext?: Record<string, unknown> }): FlakyAttempt[] {
  const v = r.keyContext?.[FLAKY_OF_KEY];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is FlakyAttempt =>
    typeof x === 'object' && x !== null && typeof (x as { attempt?: unknown }).attempt === 'number');
}

/**
 * 这一步**是靠重试才通过的**吗。
 *
 * 判据刻意不是 `retry > 0`：那个字段在失败的步骤上也会 >0（重试用尽），
 * 而"重试用尽仍失败"该由 error/fail 那条路说，不该在 flake 清单里出现第二次。
 * 也不看 status：撤行之后 flaky 的步骤状态就是 pass，
 * 光看状态一条都拦不住 —— 这与 assertLlm 那个"pass 也拦不住 report-only"是同一个形状。
 */
export function isFlakyPass(r: { status: StepStatus; keyContext?: Record<string, unknown> }): boolean {
  return r.status === 'pass' && flakyAttempts(r).length > 0;
}
