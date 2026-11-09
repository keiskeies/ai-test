/**
 * 断言（docs/02 §4）—— 三条原则：结构化优先、模糊默认、语义不参与门禁。
 *
 * 为什么「模糊默认」：LLM（和人）最容易从唯一一条样本响应里过拟合出字面断言
 * —— 时间戳、ID、顺序、浮点精度（docs/00 §6.3）。Karate 的 #ignore/#notnull
 * 词汇表就是为此存在。所以本 schema 把类型/模式断言做成默认，
 * **精确相等必须留下 exact 痕迹**，于是「AI 过拟合了一条字面断言」在 IR diff 里肉眼可见。
 */
import { z } from 'zod';
import { ExprSchema, RefSchema, ValueSchema } from './values.js';

/** 结构模式：替代具体值。id/uuid/date 形态字段应当用它而不是字面量。 */
export const SHAPES = [
  'nonEmpty', 'uuid', 'oid', 'date', 'datetime', 'email', 'phone-cn', 'idcard-cn', 'url', 'hex', 'digits', 'snowflake',
] as const;
export type Shape = (typeof SHAPES)[number];

/**
 * 单个 JSONPath 位置的断言子句。
 * Match 自引用（`each: Match`），zod 无法推断递归类型 → 类型手写、schema 显式注解。
 */
export interface Match {
  eq?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  /** 相对当前时间的偏移断言（时间戳专用，替代字面时间） */
  nearNow?: { withinMs: number };
  /** ★ 显式精确相等。lint 据此检查它是否出现在疑似 id/时间戳字段上（LITERAL_OVERFIT） */
  exact?: number | string;
  contains?: string;
  matches?: string;
  regexFlags?: string;
  shape?: Shape;
  minLength?: number;
  maxLength?: number;
  isArray?: boolean;
  /**
   * 每个元素都满足同一组子句
   *
   * 这里**原有过一个 `unordered?: boolean`（"忽略顺序比较"），现已删除**。
   * 删的原因不是"没实现"，是**它在这个子句形状里压根没有自洽的含义**：
   * Match 是"某个 JSONPath 上的单个值要满足什么"，不是"两个列表比一比" ——
   * 没有"期望数组"可比，也就没有"顺序"可忽略。而 evalMatch 从来没读过它。
   * 后果很坏：写了 `unordered: true` 的人以为自己拿到了无序比较，
   * 实际拿到的是逐元素 each（本来就与顺序无关）或一个都不比的 exact，
   * 于是用例**随机判失败**，而 schema 全程点头说这写法合法。
   *
   * 现在 strict() 会直接拒掉这个键（报"未知键"），比默默忽略诚实。
   * 真要无序比较，得先给 Match 加"期望值列表"这一维，那是 P2 编辑器的题；
   * 别一上来先加个没人读的布尔值。
   */
  each?: Match;
  notNull?: boolean;
  isNull?: boolean;
  /** 显式忽略该字段：等于声明「我知道这里有值但我不 care」（Karate #ignore） */
  ignore?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
}

/**
 * Match 的 schema 对象本体（未擦除类型的那一份）。
 *
 * 为什么单独拿出来：`MatchSchema` 因为 `each` 自引用（z.lazy）必须擦成
 * `z.ZodType<Match>`，一擦就**看不见 `.shape`** —— 于是"这个子句有哪些键"
 * 这件事在类型层面消失了，只能靠人手抄一份清单。而"哪些键存在"恰恰是
 * 要拿来和"引擎读了哪些键"对账的东西（见 match-schema.test.ts），
 * 抄一份就等于把对账变成了"两份清单是否抄得一样"。
 * 所以这里保留对象本体，把键名以值的形式导出去。
 */
const MatchObject = z
  .object({
    eq: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    nearNow: z.object({ withinMs: z.int().min(0) }).strict().optional(),
    exact: z.union([z.number(), z.string()]).optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
    regexFlags: z.string().max(4).optional(),
    shape: z.enum(SHAPES).optional(),
    minLength: z.int().min(0).optional(),
    maxLength: z.int().min(1).optional(),
    isArray: z.boolean().optional(),
    each: z.lazy(() => MatchSchema).optional(),
    notNull: z.boolean().optional(),
    isNull: z.boolean().optional(),
    ignore: z.boolean().optional(),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional(),
  })
  .strict();

export const MatchSchema = MatchObject as unknown as z.ZodType<Match>;

/**
 * Match 的全部键名（值形式，来自 schema 本体而不是手抄）。
 *
 * 存在的唯一理由：给 match-schema.test.ts 做"schema 里的键 ⇄ evalMatch 读的键"对账。
 * 那条测试是 `unordered` 那类缺陷的防线 —— schema 收下一个键而执行侧从不读它，
 * 症状是"用户以为自己配置了某个行为，其实那个行为不存在"。
 */
export const MATCH_KEYS: readonly string[] = Object.keys(MatchObject.shape).sort();

/** 数值/时长的断言子句（durationMs 用） */
export const NumericClauseSchema: z.ZodType<{
  eq?: number; gt?: number; gte?: number; lt?: number; lte?: number; notNull?: boolean;
}> = z
  .object({
    eq: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    notNull: z.boolean().optional(),
  })
  .strict();

/**
 * 结构化断言的载荷。`against` 指向被检对象（响应 / 快照 / 变量 / 步骤结果）。
 */
export const StructAssertPayloadSchema = z
  .object({
    against: RefSchema,
    /** HTTP 状态（仅 API 类断言对象有意义） */
    status: z.union([z.int(), z.array(z.int())]).optional(),
    durationMs: NumericClauseSchema.optional(),
    /** JSONPath → 子句 */
    jsonPath: z.record(z.string(), MatchSchema).default({}),
    /** 表达式断言（跨字段比较、聚合） */
    expr: ExprSchema.optional(),
    /** 表达式必须为真 */
    exprExpected: z.boolean().default(true),
  })
  .strict();
export type StructAssertPayload = z.infer<typeof StructAssertPayloadSchema>;

/**
 * 语义断言（LLM 判定）。**默认 report-only，永不影响 pass/fail**。
 *
 * 两条硬规矩（docs/02 §4）：
 *  1. 要参与门禁必须显式写 gatePolicy:"blocking"，且 UI 上二次确认；
 *  2. 同一个模型不得在同一步既执行又判定（judge 由引擎另选 model/prompt）。
 * 视觉模型倾向过度报告「存在」，所以否定断言一律走结构化路径（docs/10 §4）。
 */
export const LlmAssertPayloadSchema = z
  .object({
    question: z.string().min(4).max(1000),
    /** 必须给证据来源，不接受「凭感觉判断」 */
    evidenceFrom: RefSchema,
    /** 模型必须回引原文/坐标，便于确定性复核 */
    requireEvidenceQuote: z.boolean().default(true),
    gatePolicy: z.enum(['report-only', 'blocking', 'triage']).default('report-only'),
    /** 判定用的 task group（默认 assertJudge，与 codeGen 用不同模型） */
    judgeGroup: z.string().default('assertJudge'),
  })
  .strict();
export type LlmAssertPayload = z.infer<typeof LlmAssertPayloadSchema>;

/** 性能基线断言（docs/09 §4.3）：阈值 over 分位数 + 基线对比 */
export const PerfAssertPayloadSchema = z
  .object({
    against: RefSchema,
    percentile: z.union([z.literal(50), z.literal(90), z.literal(95), z.literal(99)]).default(95),
    lte: z.number().optional(),
    /** 相对基线的最大可接受退化比例（0.2 = p95 退化 20% 则 fail） */
    maxRegressionRatio: z.number().min(0).max(10).optional(),
    baselineRef: z.string().optional(),
    errorRateLte: z.number().min(0).max(1).optional(),
  })
  .strict();
export type PerfAssertPayload = z.infer<typeof PerfAssertPayloadSchema>;

/**
 * 界面断言。谓词是否合法取决于目标的 snapshotKind（docs/09 §1.2、docs/10 §5 lint）。
 * 判别字段刻意叫 assertKind 而不是 kind —— 步骤本身已用 kind 做判别式。
 */
export const UI_ASSERT_KINDS = [
  'ariaYaml', 'text', 'visible', 'absent', 'count', 'url', 'title', 'attribute',
  'templateHit', 'templateMiss', 'ocrValue', 'regionDiff',
] as const;

export const UiAssertPayloadSchema = z
  .object({
    assertKind: z.enum(UI_ASSERT_KINDS),
    target: z.string().optional(),
    contains: ValueSchema.optional(),
    expected: ValueSchema.optional(),
    /** ariaYaml 结构断言：可含通配（docs/06 §4） */
    ariaYaml: z.string().optional(),
    /** 像素世界专用：成对判据（上一帧命中 + 本帧未命中）才是可靠的「消失」（docs/10 §4） */
    previousFrameRef: RefSchema.optional(),
    /** 区域 diff 的忽略区（归一化） */
    ignoreRegions: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).default([]),
  })
  .strict();
export type UiAssertPayload = z.infer<typeof UiAssertPayloadSchema>;

/** 层级谓词类断言：对 pixels 目标写这些 = 类型错误，静态闸报 error（docs/10 §5） */
export const HIERARCHY_ONLY_ASSERTS: readonly string[] = ['ariaYaml', 'visible', 'absent', 'count', 'attribute'];
/** 像素世界可用的断言 */
export const PIXEL_CAPABLE_ASSERTS: readonly string[] = ['templateHit', 'templateMiss', 'ocrValue', 'regionDiff', 'text'];
