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
import { ExprSchema, RefSchema, RetryOverrideSchema, SecretRefSchema, ValueSchema, VarNameSchema, deriveExprFields, type RetryOverride } from './values.js';
import { LocatorSpecSchema, type LocatorSpec } from './locator.js';
import { WaitOptionsSchema, WaitPredicateSchema, type WaitPredicate } from './waits.js';
import { FailureCauseSchema } from './status.js';

// ── 公共字段 ────────────────────────────────────────────────────────────────
const Base = {
  /** 运行内唯一 id。Agent 生成时必须稳定（变量引用形如 $.step.<id>.resp） */
  id: z.string().min(1).max(64).regex(/^[\w-]+$/, '步骤 id 只能是字母/数字/下划线/连字符'),
  /** 人类可读名。UI 步骤表与 VarChip 显示的是它，不是 id */
  name: z.string().min(1).max(200).optional(),
  /** 守卫：让任何节点可被条件跳过，因此不必为每个分支包一层 if（抄 Maestro when:） */
  when: ExprSchema.optional(),
  timeoutMs: z.int().min(100).max(1_800_000).optional(),
  /**
   * 步骤级重试**覆盖**。刻意不是 `RetrySchema.optional()`：
   * 那个 schema 会把它自己的默认值全填上，于是"只写 retryOn"的步骤
   * 带着 count=0 落地，场景级 `config.retries` 被静默清零。
   * 理由与派生方式见 values.ts 的 RetryOverrideSchema 注释。
   */
  retry: RetryOverrideSchema.optional(),
  onError: z.enum(['fail', 'continue', 'retry']).default('fail'),
  tags: z.array(z.string().max(40)).default([]),
  note: z.string().max(2000).optional(),
};

export interface StepBase {
  id: string;
  name?: string;
  when?: string;
  timeoutMs?: number;
  retry?: RetryOverride;
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
  .object({
    kind: z.literal('table'),
    ...Base,
    rows: z.array(z.record(z.string(), ValueSchema)).min(1),
    /*
     * 行集合**写进哪个变量**（不是"每行绑到什么名字"）。
     *
     * 这个字段原先声明了但执行侧一行没读（本仓那个缺陷类的实例）：解释器写死
     * `vars.set('table', rows)`，于是 `as:'users'` 静默无效，而两个 table 步骤
     * 会互相覆盖同一个 `table` 变量。
     *
     * **默认值刻意取 `'table'`（而不是原来的 `'row'`）**：省略 `as` 的场景
     * 行为必须一字不变（现在有一个测试断的就是 `$table`）。
     * 原来那个 `'row'` 读起来像"每行绑到 row"，但本 IR 里**没有**这个语义的容身之处
     * —— 逐行是 forEach 的活（`items` + `as`），table/dataSource 只负责产出一个数组。
     * 名字与语义错配大概就是它一直没人接线的原因。
     */
    as: VarNameSchema.default('table'),
  })
  .strict();
const DataSourceStepSchema = z
  .object({
    kind: z.literal('dataSource'),
    ...Base,
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('file'), path: z.string() }).strict(),
      z
        .object({
          type: z.literal('mysql'),
          sql: z.string(),
          datasource: z.string().default('default'),
          /**
           * 具名占位的绑定值，形状与判据同 `db` 步与 `wait{dbRow}` 的 `vars`
           * （三处共用引擎里同一个 `strMap` + 同一个 `resolveValue`）。
           *
           * **为什么数据源的 SQL 也要能绑**：这个节点的存在理由就是"数据驱动"，
           * 而数据驱动最常见的形状是"先按条件把这一批要跑的行查出来"。
           * 不绑的话它只能查全表再靠 forEach 筛，那既慢又把筛选逻辑挪到用例里。
           *
           * `.optional()` 而**不是** `.default({})`：后者会把 zod 补的默认值
           * 物化进 `canonicalScenario`，让**每一个已有 dataSource 场景的 irSha 都变**
           *（历史版本的指纹全部作废）。`.optional()` 在不写时逐字节不变，
           * 理由是 `stable()` 丢 `undefined`。同 waits.ts 里 dbRow.vars 那条，
           * 那里附了探针读数 —— 这一字之差决定这是"修 bug"还是"一次磁盘迁移"。
           */
          vars: z.record(z.string(), ValueSchema).optional(),
        })
        .strict(),
      z.object({ type: z.literal('qdrant'), collection: z.string(), query: z.string(), limit: z.int().min(1).max(500).default(50) }).strict(),
    ]),
    /** 同 table.as：写进哪个变量。默认 `'rows'` 与既有行为一致（省略时照旧写 $rows） */
    as: VarNameSchema.default('rows'),
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
/**
 * `openapiCall.strategy` 的合法值集合。单独成一个 schema 是为了下面
 * `CALL_STRATEGIES` 能从**同一个来源**读出名单（`.options`）。
 */
const OpenApiCallStrategySchema = z.enum(['happyPath', 'requiredMissing', 'boundary', 'typeViolation', 'enumExhaustive', 'authMatrix', 'notFound', 'idempotency', 'contract', 'perfSmoke', 'statefulSequence', 'negativeFuzz']);

/**
 * `openapiCall.strategy` 的合法值。**从 schema 上取而不是另写一份名单**：
 * 抄一份出来就会有人只改一处，而"名单只在一处"这件事是
 * `engine/src/lint.ts` 的 `coverageDelta` 那条键编码判据的前提
 * （拼接键只在 strategy 含 `|` 时才可能撞两个组合，
 * 载体是 `ir/test/strategy-enum.test.ts`）。
 */
export const CALL_STRATEGIES: readonly string[] = OpenApiCallStrategySchema.options;

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
    /** 生成用例的策略标签，报告按它分桶（docs/05 §3）。合法值见 CALL_STRATEGIES */
    strategy: OpenApiCallStrategySchema.optional(),
    validateRequest: z.boolean().default(true),
    saveAs: VarNameSchema.optional(),
    identity: z.string().optional(),
  })
  .strict();

// Web
/**
 * `expectResponse` 的匹配串（navigate 与 act 两处共用**同一个 schema**，
 * 与 waits.ts 的 `urlPattern` 同一口径：子串包含，见 engine/src/responses.ts）。
 *
 * **为什么 min(1)**：空串在子串匹配下 `url.includes('')` **恒为真**，
 * 于是 `expectResponse: ''` 会匹配窗口里的**任何**一条响应 ——
 * 一条"我声明了要等某个接口"的断言变成"只要页面发过任何东西就算过"，
 * 是标准的假绿形状。`urlPattern` 那边本来就写着 min(1)，
 * 这两处曾经一个是 min(1)、一个是什么都收 —— 同一概念两套约束。
 */
const ExpectResponseSchema = z.string().min(1).max(2000).optional();

// Web
const NavigateStepSchema = z
  .object({ kind: z.literal('navigate'), ...Base, url: z.string().min(1), waitUntil: z.enum(['load', 'dom', 'idle']).default('load'), expectResponse: ExpectResponseSchema })
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
    /**
     * 断言这一步**新开了一个标签页/窗口**（不是"页面变了"，见 waits.ts 的 newPage）。
     *
     * 基线取在 **perform 之前**，所以"点击当场开窗"这种最快的情形不会漏。
     *
     * **什么时候别用它**：按钮做的是**下载**而不是开窗。实测（真 Chrome）
     * `<a download>` 一个 target 都不产生 —— 于是这条会等满超时判 fail + product-bug，
     * 而产品其实正常工作。"点导出按钮"看着像这个字段的典型场景，
     * 恰恰**下载型**的导出要用 `expectResponse`（等那个导出接口）而不是它；
     * 开窗型的（在线预览、报表新窗口）才是这里。
     * 两种都可能出现时，先断接口、别断窗口。
     */
    expectNewPage: z.boolean().default(false),
    expectResponse: ExpectResponseSchema,
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
const FailStepSchema = z.object({
  kind: z.literal('fail'), ...Base, reason: z.string().min(1).max(1000),
  /**
   * 作者指定的失败归因。**是封闭枚举而不是 z.string()**。
   *
   * 以前这里是 `z.string().optional()`，而解释器把它原样 cast 进
   * `StepResult.cause`（`s.cause as StepResult['cause']`）—— 于是
   * `{kind:'fail', cause:'拼错了'}` 能过 IR 校验、能跑、能落进证据包，
   * 而 StepResultSchema 的 cause 是封闭枚举：**磁盘写得出、读不回**。
   * （实测：跑完的 results[0].cause === "拼错了不是枚举值"，
   *  parseStepResults 那一步抛 ZodError。）
   *
   * 更实际的危害是归因数据本身：docs/08 那份 flake/失败看板要按 cause 分组，
   * 一个自由字符串意味着同一种原因能被写成 `env` / `env-unavailable` / `环境问题`
   * 三种，看板把它们算成三个桶，而**没有任何东西会响**。
   * 归因口径是分类字段，分类字段就该是枚举 —— 收紧到 FAILURE_CAUSE 本身。
   */
  cause: FailureCauseSchema.optional(),
}).strict();
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

/*
 * ── **"这个字段是表达式吗"只许有一处定义** ─────────────────────────────────
 *
 * 静态闸必须知道这件事，而它从前是**两份手抄的字段名清单**：
 *   `lint.ts` 抄了 `condition`、`when` 两个；
 *   `dryrun.ts` 抄了 `condition`、`when`、`value`、`items` 四个。
 * 两份**同时**坏，且坏的方向相反（都实测过，明细 docs/14 §5 那一行）：
 *  - **漏报**：`forEach.items` 与 `switch.value` 是真的 `ExprSchema`，而
 *    `lint` 一个都不查 —— 于是写坏了**没有任何生产可达的静态闸报它**。
 *    （这里从前写的是「`dryRun` 查 items，但它生产里零调用方」—— 那句在
 *    `web/src/check.ts` 落地之后就是假的，本轮改掉；`dryRun` 今天的调用方与
 *    载体见 `packages/web/test/dry-run-check.test.ts`。）
 *  - **误报**：`act.value` / `input.value` 是 `ValueSchema`，即**要填进输入框的
 *    字面量**，而 `dryRun` 把它当表达式喂给 `validateExpr`。改前实测
 *    （`.scratch/probe-value-field2.mts`）：`价格 3$` →
 *    「value 表达式错误：尾部有多余内容 "3"」、`$100 起`、`cost: $1,000` 同样报，
 *    而 `EXPR_SYNTAX` 是 **error 级**，`--strict` / `atest lint` 的退码判据正是 error 数。
 *    改后这一族由 `packages/engine/test/expr-strict.test.ts` 里「往输入框里填的字面量
 *    里带 `$` 也不许被当表达式校验」那条钉着（误报方向），漏报方向由同文件
 *    「dry-run 与 lint 管的字段**现在一致**」那条（它逐个字段要求两道闸同报，
 *    退回手抄清单就红）+ 本文件 `expr-fields.test.ts` 那组钉。
 *
 * 所以这份从 **schema 派生**：`ExprSchema` 用在哪些字段，问 schema 而不是问我的记性。
 * 判据用**对象同一性**（`unwrap(f) === ExprSchema`）而不是"它是不是 string" ——
 * IR 里 `string` 字段几十个（`url`、`note`、`sql`、`name`），按类型筛会把
 * `url: 'a b'` 这类合法值判成表达式写坏，那比原来那两份清单更错。
 *
 * **派生本体在 `values.ts` 的 `deriveExprFields()`，这里只是调用一次。**
 * 从前这段就在本文件里，而等待条件那一族（判别键是 `type` 不是 `kind`）
 * 需要一模一样的遍历 —— 复制一份的成本是零、分叉的代价是"步骤里的表达式有人管、
 * 等待条件里的没人管"，正是上面那两段手抄清单的坏法。所以判据搬去叶子模块，
 * 两族各自在这里与 `waits.ts` 里派生一张表。
 *
 * ⚠ **两个已知边界**（都是"派生不到"，不是"派生错了"，所以宁可少报也不猜）：
 *  1. 只走一层 `shape`。嵌套对象里的 `ExprSchema` 不会被找到 —— 实际存在的那一处是
 *     `http.request.body` 等**值位置**上的 `{expr: "…"}`（`ExprValue`，不是步骤字段）。
 *     它的**运行期**本轮已经通了（`resolveValue` 会求值它，写坏了就 error），
 *     缺的只是"跑之前就报"那一半；已登记 docs/14 §5。
 *  2. `WaitPredicateSchema` 是 `z.lazy(union)`，谓词树本身要有人遍历才拿得到条件
 *     （`iterConditions`），派生表给的是"**哪一种条件**的哪个字段是表达式"。
 *     lint 侧把两者接起来，见 `lint.ts` 里 `EXPR_CONDITION_FIELDS` 那一处。
 *
 * 与 `CHILD_KEYS` / `CONTAINER_KINDS` 同处一地的理由一样：**这份清单错了会同时
 * 影响 lint 与 dry-run 两道闸**，而它们各自抄一份的时候，正是这两道闸给出
 * 不同答案的那两年。
 */

/**
 * kind → 该步骤里**是表达式**的字段名（含所有步骤共有的 `when`）。
 *
 * 派生而不是手写，理由见上面那段。运行时算一次并冻结：本文件已经是 ESM 求值顺序
 * 敏感的地方（见 `childSteps()` 那里的 `z.lazy`），但这段只碰 `StepSchema.options`
 * 与各自的 `def.shape`，不触发任何校验，所以放在 `StepSchema` 之后是安全的。
 */
export const EXPR_STEP_FIELDS: Readonly<Partial<Record<Step['kind'], readonly string[]>>> =
  deriveExprFields(StepSchema as unknown as z.ZodTypeAny, 'kind') as Readonly<Partial<Record<Step['kind'], readonly string[]>>>;

/** 这个步骤的这个字段是不是表达式。**lint 与 dry-run 同问这一个函数**。 */
export function isExprField(kind: string, field: string): boolean {
  return EXPR_STEP_FIELDS[kind as Step['kind']]?.includes(field) ?? false;
}

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

/**
 * 会**产出断言结论**的步骤 kind。
 *
 * 与 CONTAINER_KINDS 同处一地、同一条理由：多个消费方要同一个答案（CI 退出码要问
 * "这次真断言了什么"，JUnit/看板将来要问"一条用例对应哪个节点"），各写一份必然漂移。
 *
 * 单列一张表而不是用 `kind.startsWith('assert')`：前缀匹配看着等价，实则把
 * "名字像断言"当成"是断言"。表在这里，新增一个断言形态就得同时改表，
 * 而 ir/test 里有一条测试**拿前缀去对照这张表** —— 两边不一致当天就红，
 * 于是"加了 assert 形态忘了加表"不会静默。
 *
 * 注意 assertLlm 也在表里。它是不是**算数**由 gatePolicy 决定（report-only 不算），
 * 那是"这条结论能不能当门禁依据"的判断，与本表"它是不是断言"是两件事；
 * 把 assertLlm 从本表剔掉会让 report-only 变成"压根不是断言"，
 * 于是"场景里只有 report-only 断言"会被读成"这场景没写断言"，走错另一条分支。
 */
export const ASSERTION_KINDS: readonly Step['kind'][] = [
  'assert', 'assertLlm', 'assertPerf', 'assertPage', 'assertUi',
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


/** parallel 分支之间的一条冲突。 */
export type ParallelHazard = { kind: 'shared-write'; name: string; branches: string[] };

/**
 * 静态查出 parallel 分支之间**只剩这一条**要拒的写法：两支写同一个名字。
 *
 * 这里原先有两条判据：除这条之外还有一条"一支压帧、另一支提到那个循环项名字"
 * （帧栈全局共享一条，A 支的 popTo 会把 B 支刚压的帧一起弹掉）。
 * 那条现在已经由引擎侧修掉了 —— 每条分支有自己的局部帧栈
 * （engine 的 `VarSpace.forkBranch`，global 帧按引用共享），
 * 各支的帧互相看不见，也弹不掉对方的。
 *
 * **为什么不顺手再加几条**：这类闸是盾牌不是修复。第三条形态
 * "B 支一句 `set mineOnly = 42`，那时栈顶恰好是 A 支的迭代帧"就是前两条抓不到的
 * （两支不同名、无共享写、B 也没提 A 的循环项），探针实测值跟着 A 的帧一起被弹掉、
 * B 那步还报 pass。靠加规则追根因，就是第 4 条第 5 条加下去，
 * 而每加一条都在把 parallel 能写的形状收窄 —— 一个用不了的功能跟没有功能一样，
 * 只是多了个报错。
 *
 * **留下的这一条仍然要拒，但理由换了**（这条注释比规则本身重要，别照抄旧的）：
 * 同名写分两种，都得拒 ——
 *  - 写**外层已声明**的名字：帧是共享的那一层，谁后写谁赢，是真竞态；
 *  - 两支各自**新声明**同名：运行时各支互不干扰（局部帧），但 parallel 之后
 *    要把两份都并回外层，只能挑一份。挑声明在前的那一支**是确定的**，
 *    可"确定"不等于"对" —— 作者的意图是两份都要，静默丢一份等于替用户猜。
 *    确定的错答案比随机的错答案更难被发现，所以照样拒。
 * 两种情况判据相同（两支写了同一个名字），所以这里不需要知道外层有什么。
 */
export function parallelHazards(branches: Step[]): ParallelHazard[] {
  const out: ParallelHazard[] = [];
  if (branches.length < 2) return out;

  const owners = new Map<string, string[]>();
  branches.forEach((b) => {
    for (const n of writtenNames([b])) owners.set(n, [...(owners.get(n) ?? []), b.id]);
  });
  for (const [name, bs] of owners) if (bs.length > 1) out.push({ kind: 'shared-write', name, branches: bs });
  return out;
}


