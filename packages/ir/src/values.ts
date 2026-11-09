/**
 * 值、引用、参数与通用配置。
 *
 * 设计约束（docs/02 §5）：变量引用必须是**显式表达式**，不是隐式字符串插值。
 * 理由：隐式 `${var}` 让「未定义变量检测」「来源审计」「跨端来源可视化」三件事
 * 全都没有下手的地方 —— 而这三件都是本平台的核心能力。
 */
import { z } from 'zod';

/** 变量名：允许点号分层，但禁止出现在 secret.* / env.* 保留前缀下（由 lint 校验） */
export const VarNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][\w.-]*$/, '变量名只能由字母/数字/下划线/点号组成，且不能以数字或点号开头');

/** JSONPath 风格引用。求值实现在 @atest/engine（ir 只定义形状，保持纯数据）。 */
export const RefSchema = z
  .string()
  .min(2)
  .regex(/^\$/, '引用必须以 $ 开头，例如 $.step.createOrder.resp.data.id');

/** 计算表达式（JSONata 子集，见 docs/02 §5）。 */
export const ExprSchema = z.string().min(1);

/**
 * 值 = 字面量 | 引用 | 表达式 | 生成器。
 * 四者互斥由引擎在求值时判定（互斥性靠 union 的顺序，不靠 schema 硬约束，
 * 因为 `{ path: "$.x" }` 与字面量对象在结构上可能重叠 —— 见 docs/02 §5 的注意事项）。
 */
const RefValue = z.object({ path: RefSchema }).strict();
const ExprValue = z.object({ expr: ExprSchema }).strict();
const GenValue = z
  .object({
    gen: z.enum(['int', 'float', 'string', 'bool', 'email', 'phone', 'idcard', 'uuid', 'oid', 'date', 'datetime', 'timestamp', 'oneOf', 'password']),
    /** 生成器参数：min/max/length/values/pattern 等，由引擎按 gen 类型解释 */
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const LiteralSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.lazy(() => LiteralSchema)),
  z.record(z.string(), z.lazy(() => LiteralSchema)),
]);

export const ValueSchema = z.union([RefValue, ExprValue, GenValue, LiteralSchema]);
export type Value = z.infer<typeof ValueSchema>;
export type RefValue = z.infer<typeof RefValue>;
export type ExprValue = z.infer<typeof ExprValue>;
export type GenValue = z.infer<typeof GenValue>;

export function isRefValue(v: unknown): v is RefValue {
  return typeof v === 'object' && v !== null && 'path' in v && typeof (v as RefValue).path === 'string';
}
export function isExprValue(v: unknown): v is ExprValue {
  return typeof v === 'object' && v !== null && 'expr' in v && typeof (v as ExprValue).expr === 'string';
}
export function isGenValue(v: unknown): v is GenValue {
  return typeof v === 'object' && v !== null && 'gen' in v && typeof (v as GenValue).gen === 'string';
}

/**
 * 密钥引用。**引擎在发出请求那一刻才解析成真实值**；
 * 对 Agent 上下文永远呈现不透明占位符（docs/02 §5、docs/03 §5）。
 * 原因很硬：Agent 能读到密钥，就能把它 echo 进生成的用例正文里提交上去。
 */
export const SecretRefSchema = z
  .string()
  .regex(/^secret:[A-Za-z0-9_-]+$/, '密钥必须是不透明引用，形如 secret:<opaque_ref>');
export type SecretRef = z.infer<typeof SecretRefSchema>;

/**
 * 被测目标端。**定义在 values.ts（叶子模块）里**：targets.ts 需要 TargetRef、
 * values.ts 需要 TargetKind，谁先定义都会造成 ESM 循环初始化错误
 * （ReferenceError: Cannot access '…' before initialization）。
 * targets.ts 再导出它，对外 API 不变。
 */
export const TargetKindSchema = z.enum(['api', 'web', 'android', 'ios', 'harmony']);
export type TargetKind = z.infer<typeof TargetKindSchema>;

/**
 * 目标端引用。既用于步骤所属端，也用于 secret 的解析作用域
 * （同一份凭证在 api 与 web 会话里可能需要不同值）。
 */
export const TargetRefSchema = z.enum(['any', ...TargetKindSchema.options]);
export type TargetRef = z.infer<typeof TargetRefSchema>;

export const RetrySchema = z
  .object({
    count: z.int().min(0).max(10).default(0),
    backoff: z.enum(['none', 'fixed', 'exponential']).default('fixed'),
    baseMs: z.int().min(0).max(60_000).default(500),
    maxMs: z.int().min(100).max(120_000).default(10_000),
    /** 仅在网络级/瞬时错误上重试。**POST 默认永不自动重试**（docs/05 §4） */
    retryOn: z
      .array(z.enum(['network', 'timeout', 'status5xx', 'assert-fail', 'locator-stale']))
      .default(['network', 'timeout']),
  })
  .strict();
export type Retry = z.infer<typeof RetrySchema>;

export const ParamDefSchema = z
  .object({
    name: VarNameSchema,
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']).default('string'),
    required: z.boolean().default(false),
    default: ValueSchema.optional(),
    /** 允许集合，供表单渲染与 Agent 生成交互时使用 */
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    description: z.string().max(500).optional(),
  })
  .strict();
export type ParamDef = z.infer<typeof ParamDefSchema>;

export const OutputDefSchema = z
  .object({
    name: z.string().min(1).max(64),
    from: RefSchema,
    description: z.string().max(500).optional(),
  })
  .strict();
export type OutputDef = z.infer<typeof OutputDefSchema>;
