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
 * 生成器种类。**这一份是唯一来源**：下面的 `GenValue` 从它派生 enum，
 * 引擎 `resolve.ts` 的 `generate()` 从它派生"合法种类"集合。
 *
 * 为什么不能像以前那样把 14 个词直接写在 `z.enum([...])` 里：那样 IR 说"合法种类是这 14 个"、
 * 引擎的 switch 说"我认识这 14 个"，**是两份手抄的清单**。它们一旦分叉（改一处漏一处），
 * 后果是 schema 收下、运行时 `default:` 返回 undefined、**步骤判 pass 而变量是空的** ——
 * 而"空值"在断言里长得像业务数据空，一路查到被测系统那边去。本轮实测过这个形状
 * （`{gen:'uuidd'}`：set=pass、变量为空），永久落点是
 * `packages/engine/test/value-forms.test.ts` 里「拼错的 gen 种类要报错」那组。
 */
export const GEN_KINDS = ['int', 'float', 'string', 'bool', 'email', 'phone', 'idcard', 'uuid', 'oid', 'date', 'datetime', 'timestamp', 'oneOf', 'password'] as const;
export type GenKind = (typeof GEN_KINDS)[number];

/**
 * 值 = 字面量 | 引用 | 表达式 | 生成器。
 * 四者互斥由引擎在求值时判定（互斥性靠 union 的顺序，不靠 schema 硬约束，
 * 因为 `{ path: "$.x" }` 与字面量对象在结构上可能重叠 —— 见 docs/02 §5 的注意事项）。
 */
const RefValue = z.object({ path: RefSchema }).strict();
const ExprValue = z.object({ expr: ExprSchema }).strict();
const GenValue = z
  .object({
    gen: z.enum(GEN_KINDS),
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
  return isValueForm(v) === 'ref';
}
export function isExprValue(v: unknown): v is ExprValue {
  return isValueForm(v) === 'expr';
}
export function isGenValue(v: unknown): v is GenValue {
  return isValueForm(v) === 'gen';
}

/**
 * 三种"非字面量"值的**键形状表**：保留键是什么、除保留键外还允许什么键。
 *
 * ## 为什么要有这张表
 *
 * "哪个键把对象变成引用/表达式/生成器"这件事，改动前在本仓**抄了三份**：
 *  1. 这里的 `z.object({ path })` / `{ expr }` / `{ gen, with? }`（形状）；
 *  2. 引擎 `resolve.ts` 里 `typeof o.path === 'string' && Object.keys(o).length === 1`（求值时判）；
 *  3. 引擎 `lint.ts` 里如果要报"键名拼错的近邻"，就得再抄一遍 `{path,expr,gen}` 这个词表。
 *
 * 三份手抄必然分叉，而分叉的后果本仓已经记过好几轮（docs/08 §3 那一族"两处规则各自演化"）。
 * 所以这里把键形状从**已经写好的 schema 上派生**出来（`shape` 直接读），
 * 运行时与 lint 都读这一份。派生而非重抄的关键收益：往 `GenValue` 加一个可选键，
 * 这里自动跟着变，不需要"记得去改第二处"。
 *
 * ## `allowed` 为什么是派生而不是写死
 *
 * `RefValue` / `ExprValue` 除了保留键**什么都不许有**（`.strict()`，一个键），
 * `GenValue` 许 `with`。这不是我定的规则，是 schema 里本来就这么写的 ——
 * 而它恰好解释了本轮那个缺陷：`{gen:'int', with:{min:1}}` 是**合法的两个键**，
 * 所以 `gen` 那一支的运行时守卫**不能**照抄 `path` 的 `keys === 1`。
 * 手写一份"看着像"的规则就会把它写错，而派生不会。
 */
const VALUE_FORMS = {
  ref: { reserved: 'path', schema: RefValue },
  expr: { reserved: 'expr', schema: ExprValue },
  gen: { reserved: 'gen', schema: GenValue },
} as const;

/** 保留键 -> 它属于哪一种值形态。`path -> 'ref'`、`gen -> 'gen'` */
export const VALUE_KEY_FORM: Readonly<Record<string, keyof typeof VALUE_FORMS>> = Object.freeze(
  Object.fromEntries(Object.entries(VALUE_FORMS).map(([form, d]) => [d.reserved, form as keyof typeof VALUE_FORMS])) as Record<string, keyof typeof VALUE_FORMS>,
);

/** 某种值形态除保留键外还允许的键（`gen` 有 `with`，另两种没有） */
const FORM_ALLOWED: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(VALUE_FORMS).map(([form, d]) => [
      d.reserved,
      Object.keys((d.schema as unknown as { shape: Record<string, unknown> }).shape).filter((k) => k !== d.reserved),
    ]),
  ),
);

/**
 * 这个对象是不是**按 IR 约定**的引用/表达式/生成器；不是则返回 undefined（= 字面量）。
 *
 * 判据是"**只含保留键 + 该形态允许的伴随键**"，与引擎求值时那一版同一条规则
 * （引擎侧 `resolveValue` 现在也调这里，两边不可能分叉）。
 * 保留键的值还必须是字符串 —— 与 schema 一致，`{path: 123}` 是字面量对象。
 *
 * ## 这一段解释了一件事：为什么 `{"path":"src/a.ts"}` 会**报错**而不是当字面量
 *
 * `resolve.ts` 里那句注释（"否则 `{"path": "src/a.ts"}` 这种普通对象会被误判成引用"）
 * 说的是 `keys === 1` 这道闸的动机，但**单键恰恰过不了这道闸** —— 闸只挡得住
 * `{"path":"src/a.ts","extra":1}` 那种两个键的。本轮实测：单键那个是
 * `set=error`（`PathError`：引用必须以 `$` 开头），两键那个才是 `set=pass`（真字面量）。
 * 也就是说：**IR 的约定是"保留了这三个键名"，不是"这三个键名随便用"**。
 * 注释与事实不符这点已在本轮改掉；约定本身没动 —— 动它才是大改（会牵动所有已冻结场景的 irSha）。
 */
export function isValueForm(v: unknown): keyof typeof VALUE_FORMS | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length === 0) return undefined;
  const reserved = keys.find((k) => k in VALUE_KEY_FORM);
  // 混合键（如 `{path:'$.a', extra:1}`）里的保留键**不算**形态键：那是业务对象，
  // 让作者拿到"字段 extra 不是 with"这种报错反而是误导（他本来就不是在写引用）
  if (!reserved || keys.length > 2) return undefined;
  if (keys.length === 2 && !FORM_ALLOWED[reserved]?.includes(keys.find((k) => k !== reserved)!)) return undefined;
  const val = (v as Record<string, unknown>)[reserved];
  if (typeof val !== 'string') return undefined;
  // gen 的形态键还要求种类合法吗？**不要求**，刻意不要求：
  // 种类拼错要在**运行时**报（引擎那边有种类清单），lint 那边报近邻；
  // 这里若也判一份清单，就成了第四份手抄清单 —— 正是这张表要消灭的东西。
  return VALUE_KEY_FORM[reserved];
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

/*
 * ── "这一族 schema 里，哪些字段是表达式"的**唯一一份派生实现** ──────────────
 *
 * 为什么在这里而不是各自的使用处：同一条派生规则要被**两族** schema 用 ——
 * 步骤（判别键 `kind`，`steps.ts`）与等待条件（判别键 `type`，`waits.ts`）。
 * 各写一份就是本仓记过十几轮的那个形状（"一件事抄 N 份，每份各错过一次"），
 * 而这一条尤其容易分叉：两族的写法看着一样（union → 成员 → `def.shape` →
 * 找 `ExprSchema`），复制粘贴零成本，分叉之后表现是"步骤里的表达式有静态校验、
 * 等待条件里的没有"—— 与本文件上面 `isValueForm` 那段修掉的是同一个毛病。
 *
 * 放在 values.ts 是因为 `ExprSchema` 就定义在这里，而本模块是 IR 的叶子
 * （不 import 任何同层模块），两族 schema 都能 import 它而不造成循环。
 *
 * 判据用**对象同一性**（剥掉 optional/nullable/default 之后 `=== ExprSchema`），
 * 不是"它是不是 string"：IR 里 string 字段几十个（`url`、`note`、`sql`、`name`、
 * `urlPattern`），按类型筛会把 `url: 'a b'` 这类合法值判成表达式写坏。
 * 这条判据不是理论选择 —— `dryrun.ts` 那份手抄清单就是因为把 `value`
 * （`ValueSchema`，往输入框填的字面量）当表达式而误报，实测数据在
 * `docs/14` §5 与 `steps.ts` 里那段注释上。
 */

/** 剥掉 optional / nullable / default 包装，拿到最里面那个 schema 实例。 */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as unknown as { def?: { innerType?: z.ZodTypeAny } }).def;
  return def?.innerType ? unwrapSchema(def.innerType) : schema;
}

/**
 * 从一个 union 派生「判别值 → 该成员里是表达式的字段名」。
 *
 * 两个方向的失效都要防，而它们不对称：
 *  - **漏一个成员** = 那一族的表达式写坏了没人静态报（静默，本仓最常见那类）；
 *  - **多算一个字段** = 合法场景被 `--strict` 拒（误报，代价是**大家把整道闸关掉**，
 *    于是那道闸里其余规则一起失效）。
 * 所以这里宁缺毋滥：认不出判别值的成员**整条跳过**而不是猜一个键。
 *
 * **调用方要自己保证扫不到的东西会红**（本函数做不到 —— 它看不见"该有几个成员"）。
 * 两处调用方各自立了这条自检：`ir/test/expr-fields.test.ts` 用正则读源码文本，
 * `ir/test/wait-expr-fields.test.ts` 用 `WaitConditionSchema.options.length`。
 * 一个恒通过的护栏比没有护栏更糟，理由同文件里写了多次。
 */
export function deriveExprFields(
  union: z.ZodTypeAny,
  discriminator: string,
): Readonly<Record<string, readonly string[]>> {
  const out = new Map<string, string[]>();
  const options = (union as unknown as { options?: z.ZodTypeAny[] }).options ?? [];
  for (const opt of options) {
    const shape = (opt as unknown as { def?: { shape?: Record<string, z.ZodTypeAny> } }).def?.shape;
    if (!shape) continue;
    // 判别值通常是 z.literal（值直接挂在 .value 上）；z.enum 之类把它挂在 .def.value 上。
    const disc = shape[discriminator] as unknown as { value?: unknown; def?: { value?: unknown } } | undefined;
    const key = disc?.value ?? disc?.def?.value;
    if (typeof key !== 'string') continue;
    const fields = Object.entries(shape)
      .filter(([, v]) => v !== undefined && unwrapSchema(v) === (ExprSchema as unknown as z.ZodTypeAny))
      .map(([k]) => k);
    out.set(key, fields);
  }
  const rec: Record<string, readonly string[]> = {};
  for (const [k, v] of out) rec[k] = Object.freeze([...v]);
  return Object.freeze(rec) as Readonly<Record<string, readonly string[]>>;
}

/*
 * ── 「这个数据位置在 schema 里是不是 `ValueSchema`」的**唯一一份遍历** ──────────
 *
 * ## 为什么不是又一张位置清单
 *
 * 本仓为"哪些字段是表达式/引用"抄过三份清单，而清单这一族记录的还是**步骤顶层字段**
 * （`EXPR_STEP_FIELDS`）。值形态（`ValueSchema`）比它难一层：值能嵌在
 * record / 数组 / 嵌套对象里（`query:{q:{…}}`、`rows:[{k:{…}}]`、`body:{a:{b:{…}}}`），
 * 所以"列一张字段名表"这条路今天列不全，而**列不全的表现是漏报**——
 * 漏报与"这一处合法"在报告上逐字相同。`engine/test/value-positions.test.ts` 里那份
 * 20 格清单就是这一族的现成样本：它自己写的时候是对的，而它**漏了两格**
 * （`wait.condition.dbRow.vars` 与 `inputs[].default`），漏的原因见下面第 2 条。
 *
 * 所以这里不给清单，给**遍历**：拿 schema 与数据**成对**走，走到
 * `unwrap(...) === ValueSchema` 的那个位置就把值交出去。新增一个值形态字段
 * 不需要"记得来登记"，因为它天然被走到 —— 这正是清单做不到的那件事。
 *
 * ## 三条会让"自称完整的遍历"静默不完整的形状（本函数逐条处理）
 *  1. **包装层**。`optional` / `nullable` / `default` 都把真 schema 藏在 `def.innerType`，
 *     不剥就认不出 `=== ValueSchema`（`db.vars` 是 `.optional()`，`query` 是 `.default({})`）。
 *  2. **`z.lazy`**。子步骤列表、谓词树都是 lazy，藏在 `def.getter()`。
 *     早先那份遍历**根本不进 lazy**，于是 `wait` 的谓词树整棵不在扫描结果里，
 *     而"没扫到"与"扫了没问题"给的是同一个答案。这里进去，且只在一处认停。
 *  3. **union 成员**。`ValueSchema` 自己就是 union，而 `assertPage`/`assertUi`
 *     的 payload 也是 union —— 只走第一个成员等于漏报。
 *
 * ## 停机条件（防死循环，而且要说清防的是什么）
 * 步骤树是**递归**的：`sequence.steps` → `z.lazy(array(union(…步骤…)))` → 绕回 StepSchema。
 * 所以走到"就是 StepSchema 的那个数组元素"时**不展开它**，而是交给 `onStep`
 * 由调用方按数据侧的实际步骤recurse —— 数据侧天然是有限树，走不到环。
 *
 * ## 为什么这个函数住在 ir 而不是 engine
 * 它读的是 zod 内部形状（`def.type` / `def.shape` / `def.getter`），而这只有
 * schema 的**定义方**才该依赖 —— engine 依赖它等于把"zod 版本内部结构"这条
 * 依赖线穿过分层闸（`tooling/lint-layers.mjs`）。`isValueForm` 同理住在这里。
 */

/** `eachValuePosition` 交出来的一个值形态位置。 */
export interface ValuePosition {
  /** 那个位置上的**数据**（值形态位置上的东西一律是 JSON 形状，不含 undefined） */
  value: unknown;
  /** 人读的坐标，如 `http.request.query.q`、`table.rows[0].k`、`wait.condition.dbRow.vars.v` */
  path: string;
  /** 最近一层步骤的 id（顶层字段如 `inputs[0].default` 没有它）。报错要点名是谁 */
  stepId?: string;
  /**
   * 这个位置上 schema 声明的类型。今天恒为 `'value'`（只有值形态会被交出），
   * 留着这一格是因为调用方需要一个**能核对**的东西：
   * 若遍历坏到把非值形态的字段也交出来，测试就能拿它响，而不是靠"看起来报得对"。
   */
  kind: 'value';
}

/** 剥掉 optional / nullable / default / lazy，拿到最里面那个 schema 实例。 */
function unwrapDeep(schema: unknown): unknown {
  const def = (schema as { def?: { innerType?: unknown; getter?: () => unknown } } | null)?.def;
  if (def?.innerType) return unwrapDeep(def.innerType);
  // lazy 也在这里剥：调用方要的是"这一格是什么类型"，而 lazy 只是延迟构造。
  // 步骤树那个 lazy 绕回 StepSchema 自身，**递归深度靠下面 holdsValue 的 depth 上限挡**，
  // 不靠"认不出 lazy"挡 —— 认不出 lazy 正是早那份扫描漏掉整棵谓词树的原因。
  if (def?.getter) {
    try {
      return unwrapDeep(def.getter());
    } catch {
      return schema; // getter 只在 schema 图完整时可用；取不到就按原样
    }
  }
  return schema;
}

type ZodDef = { type?: string; shape?: Record<string, unknown>; valueType?: unknown; element?: unknown; options?: unknown[] };
const defOf = (s: unknown): ZodDef | undefined => (unwrapDeep(s) as { def?: ZodDef } | null)?.def;

/** union 成员的判别键。IR 里三种判别键都在用（步骤 `kind`、条件 `type`、断言 `assertKind`）。 */
const DISCRIMS = ['kind', 'type', 'assertKind'] as const;

/** 成员 m 对判别键 key 要求的那个字面量值；这个成员没有这个判别键则 undefined。 */
function memberDiscrim(m: unknown, key: string): string | undefined {
  const lit = defOf(m)?.shape?.[key] as { value?: unknown; def?: { value?: unknown } } | undefined;
  const v = lit?.value ?? lit?.def?.value;
  return typeof v === 'string' ? v : undefined;
}

/**
 * 这一格（往任意深度走）装不装得下一个 `ValueSchema`。
 *
 * 用途是**剪枝**，而剪枝在这里不是性能问题：整棵场景树里绝大多数子树
 * （`locator`、`retry`、`capabilities`……）压根不可能出现值形态，
 * 不剪就会把非值形态的字段也交出去 —— 那正是 `dryrun` 早年把 `url`
 * 当表达式校验而误报的同一个形状（判据从"字段叫什么名"错成"字段装得下什么"）。
 *
 * ⚠ **`depth` 上限不是性能保险，是防死循环**：步骤树是递归的
 * （`sequence.steps` → `z.lazy(array(union(…步骤…)))` → 绕回 `StepSchema`），
 * 而 `unwrapDeep` 会把那个 lazy 展开，于是 object 分支顺着 `steps` 字段
 * 会**永远走下去**。这里靠深度上限截断是**安全**的：能被这个上限挡住而漏掉的
 * 只有"嵌套超过 24 层 schema 才出现"的值位置，而 IR 里没有那种形状
 * （值形态最深处是 `request.body`，而 body 以下是 `record(string, Literal)`，
 * schema 不再往下给结构）。数据侧的递归走的是下面另一条路，
 * 那里数据是有限树，不受这个上限影响 —— 这点要说清，**截断数据侧就是静默漏报**。
 */
function holdsValue(schema: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  const u = unwrapDeep(schema);
  if (u === (ValueSchema as unknown)) return true;
  const d = defOf(schema);
  if (!d) return false;
  switch (d.type) {
    case 'record':
      return holdsValue(d.valueType, depth + 1);
    case 'array':
      return holdsValue(d.element, depth + 1);
    case 'object':
      return Object.values(d.shape ?? {}).some((v) => holdsValue(v, depth + 1));
    default:
      // union / intersection：任一成员装得下就算
      return Array.isArray(d.options) && d.options.some((o) => holdsValue(o, depth + 1));
  }
}

/**
 * 成对走 schema 与数据，把每个 `ValueSchema` 位置上的值交出来。
 *
 * 步骤树**不需要特殊处理**：步骤 union 的每个成员都带 `kind` 字面量，
 * 下面那套"按判别值筛成员"的通法天然会把 `sequence.steps[3]` 走到它自己的成员上，
 * 于是嵌套步骤、容器里的 `set`、谓词树里的 `dbRow.vars` 全都自动覆盖。
 * （早先那份遍历需要给谓词树单开一条 `iterConditions` 路，就是因为它只走一层 shape。）
 *
 * 误报与漏报的代价不对称，所以判据往"不误报"一侧靠：
 * **带判别键而数据的判别值不匹配的 union 成员，整条不走** ——
 * 否则一份 `assertPage` 的数据会被塞进 `assertUi` 的 schema 里走一遍，
 * 于是同一个位置报两次、或在不该报的字段上报。
 */
export function eachValuePosition(
  rootSchema: unknown,
  rootData: unknown,
  onValue: (pos: ValuePosition) => void,
  /** 走查根坐标，默认 `$`。给调用方留的：自检要拿它比对路径 */
  rootPath = '$',
): void {
  /**
   * 值位置**以下**按数据走。schema 到这里就没信息了（值形态以下是
   * `LiteralSchema` 的 `record(string, Literal)`），所以唯一正确的判据是
   * **运行时那一条** `isValueForm` —— 拿同一个判据，静态与运行期就不可能分叉
   * （分叉一次的代价见 lint 里 `RESERVED_KEY_REWRITE` 那段：两边各判一份，
   * 于是"lint 报了而运行时不当它是引用"）。
   *
   * 为什么必须往下走（本轮实测定的，不是想当然）：`resolveValue` 对字面量对象是
   * `Object.fromEntries(entries.map(resolveValue))` —— **递归进任意深度**，
   * 所以 `body:{deep:{inner:{expr:'1 +'}}}` 运行期是 error（实测），
   * 而只在"schema 说这是 ValueSchema 的那一格"停手就看不见它。
   *
   * 只交出 `isValueForm` 认得出的那些节点（= 运行期真会求值的），
   * 字面量原样带过，交出去由调用方判它的文本坏没坏。
   */
  const walkValueData = (data: unknown, path: string, stepId: string | undefined, depth: number): void => {
    if (depth > 64 || data === undefined) return;
    if (Array.isArray(data)) {
      data.forEach((v, i) => walkValueData(v, `${path}[${i}]`, stepId, depth + 1));
      return;
    }
    if (typeof data !== 'object' || data === null) return;
    if (isValueForm(data) !== undefined) {
      onValue({ value: data, path, stepId, kind: 'value' });
      return; // 形态对象内部不再有值形态（`{expr:'…'}` 里那个字符串就是最终文本）
    }
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      walkValueData(v, `${path}.${k}`, stepId, depth + 1);
    }
  };

  const walk = (schema: unknown, data: unknown, path: string, stepId: string | undefined, depth: number): void => {
    if (depth > 64 || data === undefined || schema === undefined || schema === null) return;
    if ((unwrapDeep(schema) as unknown) === (ValueSchema as unknown)) {
      // 值位置本身可能是裸字面量（`query:{q:'abc'}`）—— 那种没有文本可校，
      // 但统一交给 walkValueData：它认得形态就交，认不出就往下钻，两种都覆盖。
      walkValueData(data, path, stepId, depth);
      return;
    }
    const d = defOf(schema);
    if (!d) return;

    switch (d.type) {
      case 'record': {
        if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
        if (!holdsValue(d.valueType)) return;
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          walk(d.valueType, v, `${path}.${k}`, stepId, depth + 1);
        }
        return;
      }
      case 'array': {
        if (!Array.isArray(data) || !holdsValue(d.element)) return;
        data.forEach((v, i) => walk(d.element, v, `${path}[${i}]`, stepId, depth + 1));
        return;
      }
      case 'object': {
        if (typeof data !== 'object' || data === null) return;
        const obj = data as Record<string, unknown>;
        /*
         * 步骤坐标。**必须同时有 `kind`** 才算一步 —— 只认 `id` 的话，
         * 场景对象自己那个 `id`（IR 必填）会被当成步骤 id，
         * 于是顶层字段（`inputs[0].default`）的报错会挂在一个压根不存在的步骤上，
         * 点"跳到该步骤"会跳空。本轮实测到过。
         */
        const isStep = typeof obj.kind === 'string';
        const sid = isStep && typeof obj.id === 'string' ? obj.id : stepId;
        for (const [f, sub] of Object.entries(d.shape ?? {})) {
          const v = obj[f];
          if (v === undefined) continue;
          if (DISCRIMS.includes(f as (typeof DISCRIMS)[number])) continue;
          if (!holdsValue(sub)) continue;
          walk(sub, v, `${path}.${f}`, sid, depth + 1);
        }
        return;
      }
      default: {
        const options = Array.isArray(d.options) ? d.options : [];
        if (!options.length) return;
        const obj = typeof data === 'object' && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : undefined;
        for (const m of options) {
          // 只排除**明确不匹配**的成员；成员没有判别键时不排除（宁可多走也不漏）
          const clash = DISCRIMS.some((k) => {
            const want = memberDiscrim(m, k);
            return want !== undefined && obj !== undefined && typeof obj[k] === 'string' && obj[k] !== want;
          });
          if (clash) continue;
          if (!holdsValue(m)) continue;
          walk(m, data, path, stepId, depth + 1);
        }
        return;
      }
    }
  };
  walk(rootSchema, rootData, rootPath, undefined, 0);
}

/**
 * `holdsValue` 的对外面。**只给完整性自检用**（它要拿独立的 schema 走法对撞本模块），
 * 生产侧一律走 `eachValuePosition`，不要拿它自己拼一套遍历 —— 那就是清单分叉的开始。
 */
export const schemaHoldsValueSchema = holdsValue;

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
     * 现在会被 schema 拒掉，而不是静默当一个空配置。
     * （**拒到什么程度，本轮重新测过一遍**，因为这段注释原先记的三个数有两个是错的：
     *  写的是"173 条 issue、28 个分支各报一遍、其中 39 条提到 retryOn"，
     *  实测是 **39 个分支（= 步骤 union 的全部成员）、162 条分支级 issue、
     *  39 条提到 retryOn（即每个分支都提）**。
     *  当时把 28 与 39 记反了方向，还顺手把一个"递归下钻后的总数"当成"分支级总数"——
     *  两个数都真，但说的不是同一件事，而这段注释的作用恰恰是让人不去重测。
     *
     * 现在作者看到的是
     *  `body.0.retry.retryOn.0 "retryOn" 的第 1 项 不是合法值。可取："network" | "timeout"`
     * —— 字段名与合法值都在了。旧实现给的是 `body.0 → Invalid input`
     *  （它把 union 的每分支 issue 整个丢了）。**这条以前写的是"得到一条列出合法值的
     *  schema 错误"，那是错的**，被 engine/test/retry.test.ts:293 那条测试当场证伪；
     *  本轮把 humanize 修好，让那句话变成真的（经过与判据见 ir/test/humanize.test.ts
     *  与 docs/14 §4.13）。）
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
