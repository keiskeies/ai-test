/**
 * 等待策略（docs/02 §3）—— 「等待」是条件，不是时长。
 *
 * 这是调研认定的第二个空白点（docs/00 §4.2）：**没有任何现有平台有「等待策略」节点，
 * 全都是固定时长 sleep**。Apifox 的「等待」就是延时。而每个 delay:3000 都是一颗
 * 未来的 flake + 一次套件变慢。所以 IR 里**没有 wait.duration 字段**，
 * 需要干等只能显式写 sleep 节点，且被 lint 警告。
 */
import { z } from 'zod';
import { ExprSchema, RefSchema, ValueSchema, deriveExprFields } from './values.js';
import { LocatorSpecSchema } from './locator.js';

/** 单个条件 */
export const WaitConditionSchema = z.discriminatedUnion('type', [
  /** 某步骤的 HTTP 状态命中 */
  z.object({ type: z.literal('httpStatus'), ref: RefSchema, in: z.array(z.int()).min(1) }).strict(),
  /** 纯表达式（变量间比较、聚合） */
  z.object({ type: z.literal('expr'), expr: ExprSchema }).strict(),
  /**
   * 数据库某行出现/消失。**MySQL 已在栈里，这是白送的差异化能力**，
   * 且解决「API 下单 → 异步落库 → UI 验证」这条最常见跨端链路的等待问题。
   */
  z
    .object({
      type: z.literal('dbRow'),
      /**
       * 只读 SQL。变量**不写在 SQL 里**，写在下面的 `vars` 里，由 adapter 绑定
       * （禁止字符串拼接：拼进 SQL 的值会改变语句本身，一个 `' OR 1=1 --`
       * 就把一条只读查询变成任意读取）。
       *
       * **这一句从前写的是「$var 占位由引擎绑定」** —— 那句话描述了一件
       * 没有任何实现做过的事（`wait.ts` 那两处 `db.query` 传的都是 `{}`），
       * 而它比"没这个功能"更害人：人会照着它写 `WHERE id = $oid`，
       * 数据库拒绝那条 SQL，那个错被等待循环收成"这一轮还没满足"，
       * 最后端出一句「等待超时」。详见 docs/15 §3.2。
       */
      sql: z.string().min(1),
      datasource: z.string().default('default'),
      expect: z.enum(['row', 'noRow', 'scalarTruth']).default('row'),
      /**
       * SQL 里具名占位的绑定值，形状与判据**与 `db` 步的 `vars` 完全一致**
       * （同一个 `strMap` + 同一个 `resolveValue`，见 engine 的 resolve.ts）。
       *
       * **为什么这里不新造一套**：`db` 步早就有这个名字一样的字段，
       * 语义也已经定在那儿（值可以是 `{path}`/`{expr}`/`{gen}`/字面量，
       * 求值成字符串后交给 adapter 绑）。两处各定一份，就是"同一个 IR 概念
       * 在两个位置有两种含义" —— 而那正是本仓反复记账的那个形状。
       *
       * **`.optional()` 而不是 `.default({})`，是量出来的不是选出来的**：
       * `canonicalScenario` 会把 zod 补出来的默认值**物化**进规范串
       *（`.default({})` 让每一个已有 `dbRow` 场景的 `irSha` 都变，
       *  等于把全部历史版本的指纹作废），而 `stable()` 会丢掉 `undefined`，
       * 所以 `.optional()` 在**不写这个字段时逐字节不变**（探针实测）。
       * 这一字之差把"修一个 bug"与"一次磁盘格式迁移"分开了。
       */
      vars: z.record(z.string(), ValueSchema).optional(),
    })
    .strict(),
  /** 界面谓词（要求目标是 aria/hierarchy 世界） */
  z
    .object({
      type: z.literal('uiPredicate'),
      target: LocatorSpecSchema,
      state: z.enum(['visible', 'attached', 'enabled', 'gone']).default('visible'),
    })
    .strict(),
  /** 模板命中/未命中（像素世界的等价物，docs/10 §4） */
  z
    .object({
      type: z.literal('template'),
      target: LocatorSpecSchema,
      expect: z.enum(['hit', 'miss']).default('hit'),
      minConfidence: z.number().min(0).max(1).default(0.8),
    })
    .strict(),
  /** Detox 式「app 空闲」门控。安卓端动画未结束就 dump 是 flake 主因之一 */
  z.object({ type: z.literal('uiIdle'), quietMs: z.int().min(0).max(5000).default(400) }).strict(),
  /** 等某个接口回来（docs/06 §3：Web 侧最有价值的等待） */
  z
    .object({
      type: z.literal('response'),
      urlPattern: z.string().min(1),
      status: z.array(z.int()).optional(),
    })
    .strict(),
  /**
   * 等页面**新开一个标签页/窗口**（docs/06 §3 的 `expectNewPage` 那一族的等待形态）。
   *
   * **起点是"这条等待开始的那一刻"**，与 `response` 那一支不同（那边的窗口起点是
   * 上一步开始时消费到的位置，见 engine/src/responses.ts）。差异是有意的：
   * 新窗口是**异步且滞后**于点击的，所以"点完再等"通常刚好来得及；
   * 而接口响应可能就在两步之间落地，起点晚一点就会漏。
   *
   * **留下的那一点风险要说清**：如果窗口在"上一步点击"与"本步开始等待"之间
   * 就已经建好了，这条会一直等到超时（假红，看得见）。
   * 那种写法应当直接用动作步骤上的 `expectNewPage: true` —— 它的基线取在
   * **perform 之前**，结构上不会漏。报错文案里会把这句说出来，
   * 否则下一次红的是"我不知道该改哪里"。
   */
  z.object({ type: z.literal('newPage') }).strict(),
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

/**
 * 条件类型 → 该条件里**是表达式**的字段名。今天只有 `{type:'expr', expr}` 一个。
 *
 * **派生而不是手写**（判据与步骤那一族同一个：`values.ts` 的 `deriveExprFields`，
 * 判别键换成 `type`）。手抄这一条的坏法与 `lint.ts` 从前抄 `['condition','when']`
 * 完全一样：往 `WaitConditionSchema` 加一种带表达式的条件（比如
 * `{type:'scalarTruth', exprEq: ExprSchema}`），静态闸就对新条件静默失效，
 * 而这份表看着仍然"是从 schema 派生的"。
 *
 * **它给的是"哪一种条件的哪个字段"，不是"谓词树里有哪些表达式"** ——
 * 后者要靠 `iterConditions()` 遍历（本文件下面那个）。两者在 `lint.ts` 里接起来。
 *
 * 守着它的是 `ir/test/wait-expr-fields.test.ts`：一条用
 * `WaitConditionSchema.options.length` 自检扫描没扫空，一条逐成员核对表与源码一致。
 */
export const EXPR_CONDITION_FIELDS: Readonly<Record<string, readonly string[]>> =
  deriveExprFields(WaitConditionSchema as unknown as z.ZodTypeAny, 'type');

/** 这一族条件的这个字段是不是表达式。**lint 用它，别自己列字段名**。 */
export function isExprConditionField(type: string, field: string): boolean {
  return EXPR_CONDITION_FIELDS[type]?.includes(field) ?? false;
}

/** 复合条件：至少保留一层 anyOf/allOf/noneOf，便于 Agent 生成与人类阅读 */
export const WaitPredicateSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    WaitConditionSchema,
    z.object({ allOf: z.array(WaitPredicateSchema).min(1) }).strict(),
    z.object({ anyOf: z.array(WaitPredicateSchema).min(1) }).strict(),
    z.object({ noneOf: z.array(WaitPredicateSchema).min(1) }).strict(),
  ]),
);
export type WaitPredicate = z.infer<typeof WaitPredicateSchema>;

/** 等待的通用参数。poll 有下限，避免把被测系统打死。 */
export const WaitOptionsSchema = z
  .object({
    timeoutMs: z.int().min(100).max(600_000).default(10_000),
    pollMs: z.int().min(50).max(30_000).default(500),
    backoff: z.enum(['none', 'linear', 'exponential']).default('exponential'),
    onTimeout: z.enum(['fail', 'continue', 'error']).default('fail'),
  })
  .strict();
export type WaitOptions = z.infer<typeof WaitOptionsSchema>;

/** 供 UI 文案与 lint 提示复用的元信息 */
export function describePredicate(p: WaitPredicate): string {
  if (!p || typeof p !== 'object') return String(p);
  const o = p as Record<string, unknown>;
  if ('allOf' in o) return `(所有条件成立) ${o.allOf as unknown[]}`.slice(0, 80);
  if ('anyOf' in o) return `(任一条件成立) ${o.anyOf as unknown[]}`.slice(0, 80);
  if ('noneOf' in o) return `(所有条件都不成立) ${o.noneOf as unknown[]}`.slice(0, 80);
  const t = o.type as string;
  if (t === 'dbRow') return `数据库出现匹配行（${(o.datasource as string) ?? 'default'}）`;
  if (t === 'uiPredicate') return `界面元素${o.state === 'gone' ? '消失' : '可见'}`;
  if (t === 'uiIdle') return '界面空闲（动画结束）';
  if (t === 'template') return `图像模板${o.expect === 'miss' ? '未命中' : '命中'}`;
  if (t === 'response') return `等待接口 ${o.urlPattern}`;
  if (t === 'newPage') return '等待页面新开一个标签页/窗口';
  if (t === 'httpStatus') return `接口状态 ∈ ${JSON.stringify(o.in)}`;
  if (t === 'expr') return `表达式为真：${String(o.expr).slice(0, 40)}`;
  return t ?? '条件';
}

/**
 * 谓词树里**是否**出现了 `newPage` 条件。
 *
 * **为什么这里可以遍历谓词树，而 `wait.ts` 里那句"有没有需要网络的条件"
 * 刻意不遍历**（见那边 `NoNetworkObserver` 的注释）：
 * 那边遍历的结果决定**判据**（要不要抛错），漏一种条件类型就等于
 * 把它退回"被吞成超时"，所以那条路只能在求值时判真实走到的分支。
 * 这里遍历的结果只决定**一句提示文案**，漏了最坏是"这句话没说全"，
 * 不会改变任何结论。**代价与收益不对称的地方，判据和文案就该用不同强度的实现。**
 *
 * 放在本文件而不是解释器里，是为了让"加一种等待条件"和"更新这个遍历"
 * 变成**同一个文件里的两处编辑** —— 跨包的"忘了回来加一项"才是那族缺陷的成因。
 */
function mentionsNewPage(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (o.type === 'newPage') return true;
  for (const k of ['allOf', 'anyOf', 'noneOf']) {
    const kids = o[k];
    if (Array.isArray(kids) && kids.some(mentionsNewPage)) return true;
  }
  return false;
}

/**
 * 摊平谓词树，逐个条件交出来。**放在本文件**（与 mentionsNewPage 同一处理由）：
 * 加一种等待条件与更新这个遍历应当在**同一个文件里**，跨包的"忘了回来加一项"
 * 才是那族缺陷的成因。
 *
 * 与 mentionsNewPage 一样，**它的结果只用于文案与 lint 提示，不用于判据** ——
 * 需要判据的那类"谓词里有没有 X 条件"仍然在求值时判真实走到的分支
 *（见 engine 的 wait.ts 里 NoNetworkObserver 那段）。
 * 强度不同是因为代价不对称：这里漏一种条件类型，最坏是"少提醒一句"。
 */
export function iterConditions(p: WaitPredicate): WaitCondition[] {
  if (!p || typeof p !== 'object') return [];
  const o = p as Record<string, unknown>;
  // 三种复合键互斥（WaitPredicateSchema 是 discriminatedUnion 式的三选一），
  // 所以命中任一个就可以直接返回，不需要"再往下看看有没有别的键"。
  for (const k of ['allOf', 'anyOf', 'noneOf']) {
    const kids = o[k];
    if (Array.isArray(kids)) return kids.flatMap((kid) => iterConditions(kid as WaitPredicate));
  }
  return [p as WaitCondition];
}

/**
 * 超时文案里要说的那句。**它是文案不是判据**（见 mentionsNewPage 的注释）。
 *
 * 为什么要有：`wait{newPage}` 的起点是"等待开始的那一刻"，所以窗口如果在
 * "上一步点击"与"本步开始等待"之间就建好了，这条会等到超时（假红）。
 * 那种情况该用的是动作步骤上的 `expectNewPage: true`（基线取在 perform 之前）。
 * 少了这句话，超时报出来只有"等待页面新开一个标签页/窗口"，
 * 人会去查产品为什么没弹窗，而真正要改的是**这个字段选错了**。
 *
 * **只有超时的时候加**（`hintOnTimeout` 由解释器在 `!r.satisfied` 那两支调），
 * 不加进 `describePredicate`：那个函数同时进"等待满足"的成功摘要，
 * 一条过了的等待后面挂一句"你可能用错字段了"是纯噪音，
 * 而噪音会让人开始跳过摘要 —— 摘要的价值就在于它每一句都可能有用。
 */
export function hintOnTimeout(p: WaitPredicate): string {
  return mentionsNewPage(p)
    ? '。若窗口在上一步点击时就已建好，这条会一直等到超时 —— 那种写法应改用动作步骤上的 expectNewPage:true，它的基线取在动作之前'
    : '';
}

/** 供 ValueSchema 之外的地方复用：断言里也可能要比较 Value */
export { ValueSchema };
