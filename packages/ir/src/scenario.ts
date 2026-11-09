/**
 * 场景（Scenario）—— 用例的唯一真相源（docs/02 §1）。
 */
import { z } from 'zod';
import { OutputDefSchema, ParamDefSchema, RetrySchema } from './values.js';
import { StepSchema, type Step } from './steps.js';
import { TargetKindSchema } from './targets.js';
import type { TargetKind } from './values.js';
import { STEP_TARGET, walk } from './steps.js';

export const SCHEMA_VERSION = '1';

/**
 * 确定性边界。CI 触发时若 frozen=false，引擎**拒绝执行**
 * （docs/00 §4.3：这条把 Agent 对话入口与 CI 门禁安全隔开）。
 */
export const ProvenanceSchema = z
  .object({
    origin: z.enum(['human', 'agent', 'imported', 'distilled']),
    /** 蒸馏/生成用的 prompt 版本 hash（docs/03 §4：prompt 变更影响可重现性，必须可见） */
    promptHash: z.string().optional(),
    modelId: z.string().optional(),
    seed: z.number().int().optional(),
    /** 生成时依据的 spec 版本（OpenAPI 文档 hash / 页面画像 hash），用于 spec 漂移检测 */
    specHash: z.string().optional(),
    generatedAt: z.string().optional(),
    /** 迁移来源（docs/11 §3 双向链接） */
    sourceCaseId: z.string().optional(),
    sourceSystem: z.enum(['zentao', 'jira-xray', 'jira-zephyr', 'testrail', 'excel', 'doc']).optional(),
    /** AI 充实的置信度（docs/11 §4） */
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ScenarioConfigSchema = z
  .object({
    timeoutMs: z.int().min(1000).max(7_200_000).default(600_000),
    /** 成本上限（美元）。超出即中断 run 并落盘证据，不是事后台账（docs/03 §2） */
    maxCostUsd: z.number().min(0).max(1000).default(0.5),
    /**
     * 场景级默认重试策略。步骤级 retry 覆盖它。
     *
     * 这里**必须**复用 RetrySchema：早先它是一个手写的精简版（只有
     * count/backoff/baseMs），于是同一个概念有两种形状 —— 步骤上能写 retryOn
     * 「只在 5xx 重试」，写在场景级就被 strict 直接拒绝，用户只能一步步重复写。
     * 精简的收益（少两个字段）远小于「同一语义两套语法」的长期税。
     */
    retries: RetrySchema.default({ count: 0, backoff: 'exponential', baseMs: 2000, maxMs: 10_000, retryOn: ['network', 'timeout'] }),
    /** 同组内互斥（共享 fixture 时） */
    parallelGroup: z.string().optional(),
    /** 数据驱动迭代间能否并行。有写操作且无 teardown 时 lint 会要求 false */
    concurrencySafe: z.boolean().default(true),
    /** 是否会产生脏数据（docs/05 §5） */
    dirty: z.boolean().default(false),
  })
  .strict();
export type ScenarioConfig = z.infer<typeof ScenarioConfigSchema>;

export const ScenarioSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    tags: z.array(z.string().max(40)).default([]),
    /**
     * 由步骤推导后冗余存储，供检索与能力校验（docs/02 §1）。
     *
     * 允许为空：纯逻辑场景（只做 set/assert，或专供 call 复用的数据准备）确实
     * 不触碰任何被测端，写个 `['api']` 去满足 min(1) 是在撒谎 —— 能力校验会因此
     * 以为它要打接口。「必须声明目标端」是 lint 提示（TARGETS_EMPTY），
     * 不是 schema 硬约束：硬约束会让合法场景根本解析不过。
     */
    targets: z.array(TargetKindSchema).default([]),
    /** 显式切换（已确认决策）：脚本模式确定性回放 / Agent 模式自主探索 */
    mode: z.enum(['script', 'agent']).default('script'),
    /** 冻结后才可进 CI */
    frozen: z.boolean().default(false),
    inputs: z.array(ParamDefSchema).default([]),
    outputs: z.array(OutputDefSchema).default([]),
    env: z
      .object({
        environmentRef: z.string().min(1),
        /** 固定到某个环境修订（极少用；默认运行时解析并记进 run） */
        pinRevision: z.int().optional(),
      })
      .strict(),
    identity: z.string().optional(),
    setup: z.array(StepSchema).default([]),
    body: z.array(StepSchema).min(1),
    teardown: z.array(StepSchema).default([]),
    config: ScenarioConfigSchema.default({
      timeoutMs: 600_000,
      maxCostUsd: 0.5,
      retries: { count: 0, backoff: 'exponential', baseMs: 2000, maxMs: 10_000, retryOn: ['network', 'timeout'] },
      concurrencySafe: true,
      dirty: false,
    }),
    provenance: ProvenanceSchema.optional(),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

/** 从步骤推导目标端集合（IR 里 targets 是冗余字段，推导函数是它的唯一权威来源）。 */
export function deriveTargets(steps: Step[]): TargetKind[] {
  const set = new Set<TargetKind>();
  walk(steps, (s) => {
    const t = STEP_TARGET[s.kind];
    if (t === 'api') set.add('api');
    else if (t === 'web') set.add('web');
    else if (t === 'mobile') {
      const kind = (s as { target?: unknown }).target;
      set.add(kind === 'ios' ? 'ios' : kind === 'harmony' ? 'harmony' : 'android');
    }
  });
  return [...set];
}

export const ScenarioVersionMetaSchema = z
  .object({
    ver: z.int().min(1),
    irSha: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
    origin: ProvenanceSchema.shape.origin,
    /** 由自愈回写产生的版本会带上 diff 摘要，供审校队列展示（docs/00 §5.6） */
    healedFromVersion: z.int().optional(),
  })
  .strict();
export type ScenarioVersionMeta = z.infer<typeof ScenarioVersionMetaSchema>;
