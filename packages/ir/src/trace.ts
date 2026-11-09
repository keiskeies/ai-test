/**
 * Trace 事件模型（docs/01 §6 证据布局、docs/06 §7 回放对齐）。
 *
 * 两条铁律：
 *  1. **单一单调时钟源** + 每事件带 `seq`。否则「视频显示第 12 步而 trace 说第 9 步」（docs/00 §6.11）。
 *  2. 事件是**追加式**的，同一批事件既进 Redis Stream（实时）也镜像进 trace.jsonl
 *     （crash 后仍可分析）。二者形状相同，故在此定义一次。
 */
import { z } from 'zod';
import { FailureCauseSchema, RunStatusSchema, StepStatusSchema } from './status.js';
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
