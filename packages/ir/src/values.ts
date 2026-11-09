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
    /**
     * 只在**这一层观测得到的瞬时故障**上重试。
     *
     * **为什么只有两个值**（以前这里有五个：另有 status5xx / assert-fail / locator-stale）：
     * 那三个是"schema 收下了而运行时从不产生"的字段 —— 写它的人以为配了重试，
     * 实际一次都不会重发，症状与"没配"完全相同。逐个为什么做不了：
     *  - `assert-fail`：重跑一个 assert 步骤就是拿**同一份数据**再判一次，
     *     结果必然相同。要救 5xx 那种抖动，重试的单位得是"请求 + 它的断言"，
     *     而这里的重试单位是单个步骤 —— 那是重试**范围**的设计改动（docs/08 已登记）。
     *  - `status5xx`：同上。而且 http 步骤对任何**收到的响应**都判 pass
     *     （500 是被测系统的答案，判红是 assert 的事），所以步骤状态永远不是 error，
     *     而重试的前置条件就是 error。
     *     以前它靠一条 alias 勉强能用：`k==='status5xx' ? cause==='env-unavailable'`，
     *     于是它**等价于"任何 error 都重试"** —— 实测连"http adapter 未注册"
     *     这种重试一万次也不会好的配置错误也照重试 3 次。
     *  - `locator-stale`：定位失败发生在 adapter 里，引擎只拿到"定不到/置信度低"；
     *     而重Resolve 同一个页面不会变好，那是 wait 的职责（docs/02 §3）。
     *
     * 删值而不是留值加注释，是因为**被拒的写法会响**：IR 里写 `retryOn:["status5xx"]`
     * 现在得到一条列出合法值的 schema 错误，而不是一个静默的空配置。
     *
     * **POST/PATCH 不受这里控制**：非幂等方法一律不自动重发
     * （engine 的 resendsSafely，docs/05 §4），配了也白配。
     */
    retryOn: z
      .array(z.enum(['network', 'timeout']))
      .default(['network', 'timeout']),
  })
  .strict();
export type Retry = z.infer<typeof RetrySchema>;

/**
 * 步骤上的 retry：**只写想覆盖的那几项**，其余继承场景级 `config.retries`。
 *
 * **为什么需要第二个 schema 而不是直接用 RetrySchema.optional()**：
 * Zod 对**存在的**对象会补齐它自己所有缺省字段。于是
 * `retry: { retryOn: ['timeout'] }`（最自然的"只改一项"写法）解析出来是
 * `{count:0, backoff:'fixed', baseMs:500, …}` —— **没写的 count 变成 0**，
 * 而引擎那句 `s.retry?.count ?? scenario.config.retries.count` 里的 `??`
 * 就永远不触发。实测当时**任何**配置组合下 config.retries 都产生不了一次重试。
 * （`z.partial()` 也救不了：实测它同样吃 default。已验。）
 *
 * **不在此处重抄一遍约束**：从 RetrySchema 的 shape 派生
 * （`unwrap()` 剥掉 default、保留 min/max/enum，实测 parse(99) 仍报 too_big）。
 * 手写一份"看着一样但没有 default"的 schema 就是本仓反复立档的那个缺陷类 ——
 * 两份边界，改一处漏一处，而且漏了不会红。
 *
 * 类型上的连带好处：`RetryOverride` 全字段可选，
 * 所以引擎里 `o?.count ?? d.count` 那句是**类型强制**的，
 * 不象以前 `retry?: Retry` 配 `as Partial<Retry>` 的 cast ——
 * cast 把"其实读不到"这件事从编译期错误变成了运行时静默。
 */
export const RetryOverrideSchema: z.ZodType<RetryOverride> = z
  .object(
    // 每项先 unwrap（剥 default、留边界）再 optional。cast 到 z.ZodType 会让
    // **推断出来的**输出类型全变成 `{}`，所以整个 schema 要显式标注
    // z.ZodType<RetryOverride> —— 少了那个标注，引擎里 `o?.count ?? d.count`
    // 会拿到 `{}` 而不是 number|undefined，编译期就拦住（这次真的拦住了，见 git 历史）。
    Object.fromEntries(
      Object.entries(RetrySchema.shape).map(([k, v]) => {
        const u = v as unknown as { unwrap?: () => z.ZodType };
        return [k, (u.unwrap?.() ?? (v as unknown as z.ZodType)).optional()];
      }),
    ),
  )
  .strict();
/** 全字段可选的 retry 覆盖。手写成 mapped type 而不是 z.infer，是为了让"可选"这件事写在类型里而不是依赖推断 */
export type RetryOverride = { [K in keyof Retry]?: Retry[K] };

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
