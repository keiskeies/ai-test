/**
 * 步骤节点全集（docs/02 §2）。
 *
 * 设计约束：
 *  - 控制流节点**显式存在**，不藏在脚本里（否则静态闸无从下手）。
 *  - 每个循环都有硬上限（无界 AI 循环 = 不可回放 + 成本失控，抄 Maestro whileTrue:{max}）。
 *  - 断言是独立节点类型，不是脚本副产物（否则「无断言用例 lint」写不出来）。
 *  - 三端同构：API/Web/Mobile 共用一份变量空间 —— 调研认定的第一空白点。
 *
 * 关于类型：zod 无法推断「递归 schema」的类型（TS7022）。因此本文件把步骤分成两半：
 *   - 叶子步骤（无子步骤）：类型由 zod 推断，拿到全部精确类型；
 *   - 容器步骤（有子步骤）：类型手写（只有 7 个），递归处用 z.lazy + 显式注解。
 * 校验行为不受影响；类型定义反而更明确。这是 zod 递归 schema 的标准处理方式。
 */
import { z } from 'zod';
import type { ZodType } from 'zod';
import { LlmAssertPayloadSchema, PerfAssertPayloadSchema, StructAssertPayloadSchema, UiAssertPayloadSchema } from './asserts.js';
import { DeviceRequirementSchema, SessionSchema, TargetKindSchema } from './targets.js';
import { ExprSchema, RefSchema, RetrySchema, SecretRefSchema, ValueSchema, VarNameSchema, type Retry } from './values.js';
import { LocatorSpecSchema, type LocatorSpec } from './locator.js';
import { WaitOptionsSchema, WaitPredicateSchema, type WaitPredicate } from './waits.js';

// ── 公共字段 ────────────────────────────────────────────────────────────────
const Base = {
  /** 运行内唯一 id。Agent 生成时必须稳定（变量引用形如 $.step.<id>.resp） */
  id: z.string().min(1).max(64).regex(/^[\w-]+$/, '步骤 id 只能是字母/数字/下划线/连字符'),
  /** 人类可读名。UI 步骤表与 VarChip 显示的是它，不是 id */
  name: z.string().min(1).max(200).optional(),
  /** 守卫：让任何节点可被条件跳过，因此不必为每个分支包一层 if（抄 Maestro when:） */
  when: ExprSchema.optional(),
  timeoutMs: z.int().min(100).max(1_800_000).optional(),
  retry: RetrySchema.optional(),
  onError: z.enum(['fail', 'continue', 'retry']).default('fail'),
  tags: z.array(z.string().max(40)).default([]),
  note: z.string().max(2000).optional(),
};

export interface StepBase {
  id: string;
  name?: string;
  when?: string;
  timeoutMs?: number;
  retry?: Retry;
  onError: 'fail' | 'continue' | 'retry';
  tags: string[];
  note?: string;
}

/**
 * 递归子步骤字段。显式注解打断 zod 的推断递归。
 *
 * 必须是 `z.array(StepSchema)` 而不是 `StepSchema` —— 这个函数返回的是**列表**，
 * 早先写成裸 StepSchema 时，所有容器步骤（while/if/forEach/…）都解析不过，
 * 报的是「expected object, received array」，测试里才暴露出来。
 * lazy 包一层是为了推迟对后面定义的 *StepSchema 的引用（ESM 求值顺序）。
 */
const childSteps = (): ZodType<Step[]> => z.lazy(() => z.array(StepSchema) as unknown as ZodType<Step[]>);
const childStepList = (min = 0): ZodType<Step[]> => {
  const s = childSteps();
  return min > 0
    ? (s.refine((v) => v.length >= min, { message: `至少需要 ${min} 个子步骤` }) as unknown as ZodType<Step[]>)
    : s;
};

// ── 容器步骤（类型手写）─────────────────────────────────────────────────────
export interface SequenceStep extends StepBase { kind: 'sequence'; steps: Step[] }
export interface IfStep extends StepBase { kind: 'if'; condition: string; then: Step[]; else: Step[] }
export interface SwitchStep extends StepBase { kind: 'switch'; value: string; cases: { is: unknown; steps: Step[] }[]; default: Step[] }
export interface ForEachStep extends StepBase { kind: 'forEach'; items: string; as: string; indexAs?: string; maxIterations: number; steps: Step[] }
export interface WhileStep extends StepBase { kind: 'while'; condition: string; maxIterations: number; steps: Step[] }
export interface RepeatStep extends StepBase { kind: 'repeat'; times: number; steps: Step[] }
export interface ParallelStep extends StepBase { kind: 'parallel'; steps: Step[]; failFast: boolean; maxConcurrency: number }
export type ControlStep = SequenceStep | IfStep | SwitchStep | ForEachStep | WhileStep | RepeatStep | ParallelStep;

const SequenceStepSchema = z.object({ kind: z.literal('sequence'), ...Base, steps: childStepList() }).strict();
const IfStepSchema = z.object({ kind: z.literal('if'), ...Base, condition: ExprSchema, then: childStepList(1), else: childStepList() }).strict();
const SwitchStepSchema = z
  .object({
    kind: z.literal('switch'),
    ...Base,
    value: ExprSchema,
    cases: z.array(z.object({ is: ValueSchema, steps: childStepList(1) }).strict()).min(1),
    default: childStepList(),
  })
  .strict();
const ForEachStepSchema = z
  .object({
    kind: z.literal('forEach'),
    ...Base,
    items: ExprSchema,
    as: VarNameSchema,
    indexAs: VarNameSchema.optional(),
    maxIterations: z.int().min(1).max(100_000).default(1000),
    steps: childStepList(1),
  })
  .strict();
/** maxIterations 必填、无默认值 —— LOOP_UNBOUNDED 是 error 级 lint */
const WhileStepSchema = z.object({ kind: z.literal('while'), ...Base, condition: ExprSchema, maxIterations: z.int().min(1).max(10_000), steps: childStepList(1) }).strict();
const RepeatStepSchema = z.object({ kind: z.literal('repeat'), ...Base, times: z.int().min(1).max(1000), steps: childStepList(1) }).strict();
const ParallelStepSchema = z
  .object({ kind: z.literal('parallel'), ...Base, steps: childStepList(1), failFast: z.boolean().default(true), maxConcurrency: z.int().min(1).max(32).default(4) })
  .strict();

// ── 叶子步骤（类型由 zod 推断）──────────────────────────────────────────────
const CallStepSchema = z
  .object({
    kind: z.literal('call'),
    ...Base,
    scenarioRef: z.string().min(1),
    args: z.record(z.string(), ValueSchema).default({}),
    assignTo: VarNameSchema.optional(),
  })
  .strict();
const WaitStepSchema = z.object({ kind: z.literal('wait'), ...Base, condition: WaitPredicateSchema, ...WaitOptionsSchema.shape }).strict();
/** 逃生舱口。存在但被 lint 警告（SLEEP_USED）：IR 里 wait 没有 duration 字段 */
const SleepStepSchema = z.object({ kind: z.literal('sleep'), ...Base, ms: z.int().min(0).max(120_000) }).strict();

const nonEmptyRecord = <T extends z.ZodTypeAny>(v: T) =>
  z.record(z.string(), v).refine((r) => Object.keys(r).length > 0, { message: '至少需要一个键' });

const SetStepSchema = z.object({ kind: z.literal('set'), ...Base, assign: nonEmptyRecord(ValueSchema) }).strict();
const ExtractStepSchema = z
  .object({
    kind: z.literal('extract'),
    ...Base,
    from: RefSchema,
    rules: z
      .array(
        z
          .object({
            var: VarNameSchema,
            path: z.string().min(1),
            /** regex 用于非 JSON 响应体（HTML/文本接口在国内很常见）；header 用于取响应头 */
            mode: z.enum(['jsonpath', 'regex', 'ariaText', 'header']).default('jsonpath'),
            group: z.int().min(0).optional(),
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const TableStepSchema = z
  .object({ kind: z.literal('table'), ...Base, rows: z.array(z.record(z.string(), ValueSchema)).min(1), as: VarNameSchema.default('row') })
  .strict();
const DataSourceStepSchema = z
  .object({
    kind: z.literal('dataSource'),
    ...Base,
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('file'), path: z.string() }).strict(),
      z.object({ type: z.literal('mysql'), sql: z.string(), datasource: z.string().default('default') }).strict(),
      z.object({ type: z.literal('qdrant'), collection: z.string(), query: z.string(), limit: z.int().min(1).max(500).default(50) }).strict(),
    ]),
    as: VarNameSchema.default('row'),
    /** 行租约：防两个 run 抢同一行 */
    leaseRows: z.boolean().default(true),
  })
  .strict();
/** 逃生舱口。P0 禁用（docs/04）：沙箱有独立工作量，且它是不透明块会绕过静态闸 */
const ScriptStepSchema = z
  .object({
    kind: z.literal('script'),
    ...Base,
    lang: z.literal('ts'),
    code: z.string().min(1).max(20_000),
    inputRefs: z.array(RefSchema).default([]),
    outputVars: z.array(VarNameSchema).default([]),
  })
  .strict();

// API
const HttpRequestSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    url: z.string().min(1),
    headers: z.record(z.string(), ValueSchema).default({}),
    query: z.record(z.string(), ValueSchema).default({}),
    body: ValueSchema.optional(),
    formData: z.record(z.string(), ValueSchema).default({}),
    files: z.array(z.object({ field: z.string(), fixtureRef: z.string() }).strict()).default([]),
  })
  .strict();
const HttpStepSchema = z
  .object({
    kind: z.literal('http'),
    ...Base,
    request: HttpRequestSchema,
    auth: SecretRefSchema.optional(),
    identity: z.string().optional(),
    saveAs: VarNameSchema.optional(),
    /** 默认不跟随重定向：跟随会让「302 到登录页」被误判成功（docs/05 §4 经典假绿） */
    followRedirects: z.boolean().default(false),
    maxResponseBytes: z.int().min(1024).max(50_000_000).default(10_000_000),
  })
  .strict();
const OpenApiCallStepSchema = z
  .object({
    kind: z.literal('openapiCall'),
    ...Base,
    docRef: z.string().min(1),
    operationId: z.string().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
    path: z.string().optional(),
    pathParams: z.record(z.string(), ValueSchema).default({}),
    queryParams: z.record(z.string(), ValueSchema).default({}),
    headers: z.record(z.string(), ValueSchema).default({}),
    body: ValueSchema.optional(),
    /** 生成用例的策略标签，报告按它分桶（docs/05 §3） */
    strategy: z
      .enum(['happyPath', 'requiredMissing', 'boundary', 'typeViolation', 'enumExhaustive', 'authMatrix', 'notFound', 'idempotency', 'contract', 'perfSmoke', 'statefulSequence', 'negativeFuzz'])
      .optional(),
    validateRequest: z.boolean().default(true),
    saveAs: VarNameSchema.optional(),
    identity: z.string().optional(),
  })
  .strict();

// Web
const NavigateStepSchema = z
  .object({ kind: z.literal('navigate'), ...Base, url: z.string().min(1), waitUntil: z.enum(['load', 'dom', 'idle']).default('load'), expectResponse: z.string().optional() })
  .strict();
const ActStepSchema = z
  .object({
    kind: z.literal('act'),
    ...Base,
    locator: LocatorSpecSchema,
    action: z.enum(['click', 'fill', 'select', 'hover', 'press', 'scroll', 'drag', 'clear']),
    value: ValueSchema.optional(),
    /** hover 才能出现的元素需原子组合，否则两步必然 flaky（docs/06 §2） */
    hoverThen: z.enum(['click', 'fill', 'none']).default('none'),
    expectNewPage: z.boolean().default(false),
    expectResponse: z.string().optional(),
    /** 点击前可交互性检查：被遮挡/disabled 直接进自愈而非干等 30s */
    hitTargetCheck: z.boolean().default(true),
  })
  .strict();
const CaptureStepSchema = z
  .object({
    kind: z.literal('capture'),
    ...Base,
    mode: z.enum(['screenshot', 'har', 'pdf', 'snapshot']),
    on: z.enum(['always', 'failure', 'manual']).default('failure'),
    region: z.enum(['viewport', 'full', 'element']).default('viewport'),
    target: LocatorSpecSchema.optional(),
  })
  .strict();

// 设备与移动端
const DeviceStepSchema = z
  .object({
    kind: z.literal('device'),
    ...Base,
    target: z.enum(['android', 'ios', 'harmony']),
    require: DeviceRequirementSchema.default({ requires: [] }),
    leaseMs: z.int().min(30_000).max(7_200_000).default(600_000),
    /** 后续步骤隐式继承租约（docs/08 §3 未决问题，先按继承实现并允许显式关闭） */
    inheritToChildren: z.boolean().default(true),
    allowManualHandoff: z.boolean().default(true),
  })
  .strict();
const AppStepSchema = z
  .object({
    kind: z.literal('app'),
    ...Base,
    action: z.enum(['install', 'launch', 'stop', 'clearData', 'current', 'push', 'wake', 'unlock']),
    package: z.string().optional(),
    apkRef: z.string().optional(),
    activity: z.string().optional(),
    /** 与 preserveSession 互斥，引擎 dry-run 检查（docs/07 §5） */
    grantAllPermissions: z.boolean().default(false),
  })
  .strict();
const TapStepSchema = z
  .object({
    kind: z.literal('tap'),
    ...Base,
    target: LocatorSpecSchema,
    mode: z.enum(['uiautomator', 'scrcpy', 'adb', 'w3c']).default('uiautomator'),
    /** 等动画结束再断言（docs/07 §3） */
    waitIdle: z.boolean().default(true),
  })
  .strict();
const InputStepSchema = z
  .object({
    kind: z.literal('input'),
    ...Base,
    target: LocatorSpecSchema.optional(),
    value: ValueSchema,
    /** 中文/Unicode 必须走 scrcpy INJECT_TEXT 或 ADB-IME（docs/07 §3） */
    mode: z.enum(['scrcpy', 'adb-ime', 'w3c', 'adb-input']).default('scrcpy'),
    clearFirst: z.boolean().default(true),
    keepKeyboard: z.boolean().default(false),
  })
  .strict();
const SwipeStepSchema = z
  .object({ kind: z.literal('swipe'), ...Base, from: z.tuple([z.number(), z.number()]).optional(), to: z.tuple([z.number(), z.number()]).optional(), durationMs: z.int().min(50).max(5000).default(300) })
  .strict();
const KeyStepSchema = z.object({ kind: z.literal('key'), ...Base, key: z.string().min(1), target: LocatorSpecSchema.optional() }).strict();
/** 弹窗守望。作用域是容器级而非全局，保证可回放（docs/00 §5.5） */
const WatcherStepSchema = z
  .object({
    kind: z.literal('watcher'),
    ...Base,
    rules: z
      .array(
        z
          .object({
            match: z.object({ text: z.string().optional(), textContains: z.string().optional(), matches: z.string().optional() }).strict(),
            action: z.enum(['click', 'dismiss', 'back', 'fail']).default('click'),
            maxTimes: z.int().min(1).max(20).default(3),
          })
          .strict(),
      )
      .min(1),
    scopeSteps: z.array(z.string()).optional(),
  })
  .strict();
const LogcatStepSchema = z
  .object({ kind: z.literal('logcat'), ...Base, filter: z.string().optional(), assertContains: z.string().optional(), captureBugreportOnCrash: z.boolean().default(false) })
  .strict();

// 断言与横切（注意：UI 断言的判别字段是 assertKind，避免与步骤 kind 冲突）
const StructAssertStepSchema = z.object({ kind: z.literal('assert'), ...Base, ...StructAssertPayloadSchema.shape }).strict();
const LlmAssertStepSchema = z.object({ kind: z.literal('assertLlm'), ...Base, ...LlmAssertPayloadSchema.shape }).strict();
const PerfAssertStepSchema = z.object({ kind: z.literal('assertPerf'), ...Base, ...PerfAssertPayloadSchema.shape }).strict();
const AssertPageStepSchema = z.object({ kind: z.literal('assertPage'), ...Base, ...UiAssertPayloadSchema.shape }).strict();
const AssertUiStepSchema = z.object({ kind: z.literal('assertUi'), ...Base, ...UiAssertPayloadSchema.shape }).strict();
const DbStepSchema = z
  .object({
    kind: z.literal('db'),
    ...Base,
    datasource: z.string().default('default'),
    sql: z.string().min(1),
    vars: z.record(z.string(), ValueSchema).default({}),
    assignTo: VarNameSchema.optional(),
    /** 写操作会被 lint 标注并要求 teardown */
    readOnly: z.boolean().default(true),
  })
  .strict();
const LogStepSchema = z.object({ kind: z.literal('log'), ...Base, level: z.enum(['info', 'warn', 'error']).default('info'), message: z.string().max(2000) }).strict();
const FailStepSchema = z.object({ kind: z.literal('fail'), ...Base, reason: z.string().min(1).max(1000), cause: z.string().optional() }).strict();
const NoopStepSchema = z.object({ kind: z.literal('noop'), ...Base }).strict();
/** 人工介入：自动化停、人接管、完成后交还。接管动作可被录制用于蒸馏成 IR（docs/07 §4） */
const ManualHandoffStepSchema = z
  .object({
    kind: z.literal('manualHandoff'),
    ...Base,
    reason: z.string().min(1).max(500),
    timeoutMs: z.int().min(1000).max(3_600_000).default(300_000),
    resumeOn: z.enum(['human-confirm', 'snapshot-match', 'timeout']).default('human-confirm'),
    recordActions: z.boolean().default(true),
  })
  .strict();
const UseIdentityStepSchema = z.object({ kind: z.literal('useIdentity'), ...Base, ...SessionSchema.shape }).strict();

const LEAF_SCHEMAS = [
  CallStepSchema, WaitStepSchema, SleepStepSchema, SetStepSchema, ExtractStepSchema, TableStepSchema, DataSourceStepSchema, ScriptStepSchema,
  HttpStepSchema, OpenApiCallStepSchema,
  NavigateStepSchema, ActStepSchema, CaptureStepSchema,
  DeviceStepSchema, AppStepSchema, TapStepSchema, InputStepSchema, SwipeStepSchema, KeyStepSchema, WatcherStepSchema, LogcatStepSchema,
  StructAssertStepSchema, LlmAssertStepSchema, PerfAssertStepSchema, AssertPageStepSchema, AssertUiStepSchema,
  DbStepSchema, LogStepSchema, FailStepSchema, NoopStepSchema, ManualHandoffStepSchema, UseIdentityStepSchema,
];
const CONTROL_SCHEMAS = [SequenceStepSchema, IfStepSchema, SwitchStepSchema, ForEachStepSchema, WhileStepSchema, RepeatStepSchema, ParallelStepSchema];

/** 叶子步骤类型：由 zod 推断，保留全部精确类型 */
export type LeafStep = z.infer<(typeof LEAF_SCHEMAS)[number]>;
/** 步骤 = 叶子 | 容器 */
export type Step = LeafStep | ControlStep;

/**
 * 递归 schema 的类型只能显式给出（见文件头注释）。
 * 校验行为完全由 zod 决定（各成员 schema 自身的 strict/refine 全部生效），
 * 这里只是把 TS 的类型断言到位。用 union 而非 discriminatedUnion 是为了避开
 * zod v4 对递归成员的类型不变性限制 —— 分派开销差异在本场景可忽略。
 */
const ALL_STEP_SCHEMAS = [...LEAF_SCHEMAS, ...CONTROL_SCHEMAS];
export const StepSchema: ZodType<Step> = z.union(ALL_STEP_SCHEMAS as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]]) as unknown as ZodType<Step>;

/** 所有步骤 kind 的字面量集合（trace/报表用它，不能依赖 StepSchema.shape） */
export const STEP_KINDS = [
  'sequence','if','switch','forEach','while','repeat','parallel','call','wait','sleep',
  'set','extract','table','dataSource','script','http','openapiCall',
  'navigate','act','capture',
  'device','app','tap','input','swipe','key','watcher','logcat',
  'assert','assertLlm','assertPerf','assertPage','assertUi',
  'db','log','fail','noop','manualHandoff','useIdentity',
] as const satisfies readonly Step['kind'][];

export const WaitStepType = WaitStepSchema;
export type WaitStepInput = z.input<typeof WaitStepSchema>;
export type { WaitPredicate, LocatorSpec };

/** 步骤类型 → 所属目标端。用于 lint（跨端检查）、UI 图标、能力校验（docs/09 §1.1 约束 3）。 */
export const STEP_TARGET: Record<Step['kind'], 'api' | 'web' | 'mobile' | 'any'> = {
  sequence: 'any', if: 'any', switch: 'any', forEach: 'any', while: 'any', repeat: 'any', parallel: 'any',
  call: 'any', wait: 'any', sleep: 'any', set: 'any', extract: 'any', table: 'any', dataSource: 'any', script: 'any',
  http: 'api', openapiCall: 'api',
  navigate: 'web', act: 'web', assertPage: 'web', capture: 'web',
  device: 'mobile', app: 'mobile', tap: 'mobile', input: 'mobile', swipe: 'mobile', key: 'mobile',
  watcher: 'mobile', logcat: 'mobile', assertUi: 'mobile',
  assert: 'any', assertLlm: 'any', assertPerf: 'any', db: 'any', log: 'any', fail: 'any', noop: 'any',
  manualHandoff: 'mobile', useIdentity: 'any',
};

/**
 * 容器步骤的 kind（承载控制流结论，不是业务结论）。
 *
 * 放在这里而不是各消费方各写一份，是因为**这份清单错了会同时污染两个对外契约**：
 * JUnit 的 tests 计数（多报容器会让"用例数/覆盖率"全废）与 CI 的退出码
 * （把容器的 fail 当成一条失败用例，一次循环失败会数出 N 次）。
 * 原先 engine/report.ts 与 cli/gate.ts 各有一份，后者还多写了个根本不存在的
 * kind `retry`（retry 是步骤上的字段，不是 kind）—— 那属于"看起来在过滤，实际漏一个"。
 *
 * 与 CHILD_KEYS 的关系：CHILD_KEYS 是**遍历入口**（哪些字段可能藏子步骤），
 * 本表是**语义分类**（哪些 kind 不该被当成一条用例）。两者刻意不合并：
 * `call` 有子场景但不是容器结论，`assert` 没子步骤却是结论。合并会把这两个
 * 正交的问题搅在一起，然后有人开始往 CHILD_KEYS 里加 assert。
 */
export const CONTAINER_KINDS: readonly Step['kind'][] = [
  'sequence', 'if', 'switch', 'forEach', 'while', 'repeat', 'parallel',
];

/** 需要设备租约的步骤（RESOURCE_LEASE_MISSING 规则的依据） */
export const LEASE_REQUIRED: Step['kind'][] = ['app', 'tap', 'input', 'swipe', 'key', 'logcat', 'assertUi', 'manualHandoff'];

/** 会改动被测状态的步骤（无 teardown 则 lint 警告） */
export const STATE_MUTATING: Step['kind'][] = ['http', 'openapiCall', 'db', 'app', 'act'];

/** 容器的子步骤字段名。静态闸遍历的唯一入口。 */
const CHILD_KEYS = ['steps', 'then', 'else', 'default'] as const;

/** 遍历（含嵌套与 switch 分支）。lint / dry-run / 变量分析都建立在它之上。 */
export function walk(steps: Step[], visit: (s: Step, path: string[]) => void, path: string[] = []): void {
  for (const s of steps) {
    const here = [...path, s.id];
    visit(s, here);
    const c = s as unknown as Record<string, unknown>;
    for (const key of CHILD_KEYS) {
      const v = c[key];
      if (Array.isArray(v)) walk(v as Step[], visit, here);
    }
    const cases = c.cases;
    if (Array.isArray(cases)) {
      for (const cs of cases as { steps?: Step[] }[]) if (cs.steps) walk(cs.steps, visit, here);
    }
  }
}

/** 所有子步骤（含自身）的扁平列表 */
export function flatten(steps: Step[]): Step[] {
  const out: Step[] = [];
  walk(steps, (s) => out.push(s));
  return out;
}

/**
 * 会往变量空间**压作用域帧**的步骤。
 *
 * 只有这两种（已核对解释器：全仓只有 `pushIteration`(forEach) 与 `push('while')`(while)
 * 两处调用 `vars.push`）。这个清单的意义是**它决定 parallel 分支安不安全**：
 * 帧栈是整个 VarSpace 共享的一条，分支里压了帧，别的支持分支的读写就会看到它。
 */
export const FRAME_PUSHING_KINDS: Step['kind'][] = ['forEach', 'while'];

/** 往变量空间**写名字**的步骤 → 写的是哪个字段。 */
export interface WriteSites {
  /** 写单个名字（saveAs / assignTo / as / 循环项） */
  single?: (s: Step) => string | undefined;
  /** 写一批名字（set.assign 的键、extract.rules[].var、script.outputVars） */
  many?: (s: Step) => string[];
}

/**
 * **每个会写变量的步骤 kind 都必须在这里出现**。
 *
 * 类型标成 `Record<Step['kind'], WriteSites>`（而不是 Partial）是刻意的：
 * 以后加一个会写变量的步骤，若没在这里登记，`tsc` 直接报"缺属性"。
 * 因为这条表是 parallel 那条静态闸的唯一依据，**漏一个 kind 就等于闸失效**，
 * 而闸失效的表现是"竞态用例照样跑、结果随调度顺序变" —— 正是本仓那个缺陷类
 * 最难查的一种（它只在并发下出现，重跑一次还可能正好对）。
 * 不写变量的 kind 显式给 `{}`，让"这个 kind 不写变量"这件事也是被声明过的。
 */
export const STEP_WRITE_SITES: Record<Step['kind'], WriteSites> = {
  set: { many: (s) => Object.keys((s as { assign?: Record<string, unknown> }).assign ?? {}) },
  extract: { many: (s) => ((s as { rules?: { var: string }[] }).rules ?? []).map((r) => r.var) },
  table: { single: (s) => (s as { as?: string }).as },
  dataSource: { single: (s) => (s as { as?: string }).as },
  forEach: {
    // 循环项与下标都在**分支自己压的帧**里，所以不算"共享名字"（见 forEachWritesOuterName）
    many: (s) => {
      const x = s as { as?: string; indexAs?: string };
      return [x.as, x.indexAs].filter((v): v is string => typeof v === 'string');
    },
  },
  http: { single: (s) => (s as { saveAs?: string }).saveAs },
  openapiCall: { single: (s) => (s as { saveAs?: string }).saveAs },
  call: { single: (s) => (s as { assignTo?: string }).assignTo },
  db: { single: (s) => (s as { assignTo?: string }).assignTo },
  script: { many: (s) => (s as { outputVars?: string[] }).outputVars ?? [] },
  // 明确不写变量的 kind：留空是为了让"漏登记"编译不过
  sequence: {},
  if: {},
  switch: {},
  while: {},
  repeat: {},
  parallel: {},
  wait: {},
  sleep: {},
  navigate: {},
  act: {},
  capture: {},
  device: {},
  app: {},
  tap: {},
  input: {},
  swipe: {},
  key: {},
  watcher: {},
  logcat: {},
  assert: {},
  assertLlm: {},
  assertPerf: {},
  assertPage: {},
  assertUi: {},
  log: {},
  fail: {},
  noop: {},
  manualHandoff: {},
  useIdentity: {},
};

/** 一个步骤（含其子树）写进**共享作用域**的名字。forEach 的循环项写在自己的帧里，不计入。 */
export function writtenNames(steps: Step[]): string[] {
  const out = new Set<string>();
  walk(steps, (s) => {
    const sites = STEP_WRITE_SITES[s.kind];
    // forEach 只写循环项/下标，两者都落在它自己那一帧；其余 kind 写的都是共享作用域
    if (s.kind === 'forEach') return;
    if (sites.single) {
      const n = sites.single(s);
      if (n) out.add(n);
    }
    for (const n of sites.many?.(s) ?? []) out.add(n);
  });
  return [...out];
}

/** 子树里有没有压帧的步骤（forEach/while）。压帧的分支在并发下不安全。 */
export function pushesFrame(steps: Step[]): boolean {
  let hit = false;
  walk(steps, (s) => {
    if (FRAME_PUSHING_KINDS.includes(s.kind)) hit = true;
  });
  return hit;
}

/**
 * forEach 声明在**自己那一帧**里的名字（循环项与下标）。
 *
 * 它们不进 writtenNames（那些算的是共享作用域），但对 parallel 的静态闸必须单独看：
 * 帧栈是整个 VarSpace 共享的一条，A 支压的帧会被同时运行的 B 支查到。
 */
export function loopVarNames(steps: Step[]): string[] {
  const out = new Set<string>();
  walk(steps, (s) => {
    if (s.kind !== 'forEach') return;
    const x = s as unknown as { as?: string; indexAs?: string };
    if (x.as) out.add(x.as);
    if (x.indexAs) out.add(x.indexAs);
  });
  return [...out];
}

/**
 * 一个分支里**提到**了哪些标识符。用 JSON 词法切，不做引用解析。
 *
 * 这是**过近似**：注释、同名的普通字段都会算进来。方向选过近似是因为这里是
 * **安全闸** —— 漏判的代价是"竞态用例照样跑、结果随调度顺序变"（本仓那个缺陷类
 * 最难查的一种），误判的代价只是一句"这两个分支请改成顺序执行"。
 */
export function mentionedNames(steps: Step[]): Set<string> {
  const out = new Set<string>();
  /*
   * 先按"标识符字符（含 $）"整段切，再**按 $ 二次切分**。
   *
   * 少了第二次切分就抓不到引用：`against:"$item"` 会被第一段正则切成**一个**
   * token `$item`（$ 本来就在字符类里），于是循环项 `item` 永远不在集合里，
   * "另一支只是读它"这一路静默漏判 —— 而这一路正是探针里实测会串的那条。
   * `$.item` 反倒能过（点号把两段分开了），所以只测点号形态会以为正则没问题。
   */
  for (const m of JSON.stringify(steps).matchAll(/[A-Za-z0-9_$]+/g)) {
    for (const part of m[0].split('$')) if (part) out.add(part);
  }
  return out;
}

/** parallel 分支之间的一条冲突。 */
export type ParallelHazard =
  | { kind: 'shared-write'; name: string; branches: string[] }
  | { kind: 'frame-shadow'; name: string; from: string; into: string[] };

/**
 * 静态查出 parallel 分支之间**已经证实会串**的两种写法。
 *
 * 为什么要静态拒而不是"运行时加锁/做合并策略"：
 *  - 变量空间是一条共享的帧栈（`VarSpace.frames`），并发子步骤各自 push/pop 同一条栈。
 *    两支各有 forEach 时，A 支的 `popTo(depth)` 会把 B 支刚压的帧一起弹掉，
 *    而 `lookup` 是从栈顶往下找 —— 探针实测：A 支的断言读到了 B 支的循环项值，
 *    B 支随后"变量未定义"。这不是命名冲突，是作用域栈被并发写坏了。
 *  - 同一名字被两支写（`saveAs` 撞 `saveAs`）则是**完成顺序谁后谁算**，
 *    同一份冻结场景能给出 pass 也能给出 fail —— 直接破 M7 的
 *    "同一冻结场景跑 20 次，断言结果完全一致"。
 * 真正的解法是给每个分支一份独立作用域（要贯穿 36 处 `vars.` 调用），记在 docs/08 作为 P1；
 * 在那之前，宁可在执行前说清"这两支不能并发"，也不要跑出一个随调度顺序变的答案。
 *
 * **刻意窄**：只拒这两条。把"任何两支里有任何一支带 forEach"一起拒掉，
 * 会让 parallel 在真实场景里几乎不可用（分支里十有八九有循环），
 * 而一个用不了的功能跟没有功能一样，只是多了个报错。
 */
export function parallelHazards(branches: Step[]): ParallelHazard[] {
  const out: ParallelHazard[] = [];
  if (branches.length < 2) return out;
  const names = branches.map((b) => writtenNames([b]));

  // 1) 两支写同一个共享名字
  const owners = new Map<string, string[]>();
  branches.forEach((b, i) => {
    for (const n of names[i] ?? []) owners.set(n, [...(owners.get(n) ?? []), b.id]);
  });
  for (const [name, bs] of owners) if (bs.length > 1) out.push({ kind: 'shared-write', name, branches: bs });

  // 2) 一支压帧、另一支提到了那个循环项名字（共享栈上会互相遮蔽）
  branches.forEach((b) => {
    const looped = loopVarNames([b]);
    if (!looped.length) return;
    const mine = new Set([b.id]);
    const victims = branches
      .filter((o) => !mine.has(o.id))
      .filter((o) => looped.some((n) => mentionedNames([o]).has(n)))
      .map((o) => o.id);
    for (const n of looped) if (victims.length) out.push({ kind: 'frame-shadow', name: n, from: b.id, into: victims });
  });
  return out;
}


