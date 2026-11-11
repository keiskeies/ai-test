/**
 * 变量空间与作用域（docs/02 §5）。
 *
 * 作用域（内层遮蔽外层，退出即销毁）：
 *   run.inputs              # 上层输入（外部传入，类型化）
 *     ← scenario.inputs     # 场景自身输入
 *       ← forEach.as / call.args
 *         ← step.exports    # extract / set / saveAs 产出
 *   run.outputs             # 显式声明的下层输出
 *   env.<name>              # 只读，运行时按 env_revision 解析
 *   secret.<ref>            # ★ 只能被引擎解析，永不进入 Agent 上下文
 *
 * secret 的处理是安全机制而非便利：Agent 能读到密钥，就能把它 echo 进生成的
 * 用例正文里提交上去（docs/00 §6.8）。因此本类在**序列化/导出时**一律把
 * secret.* 换成不透明占位符，真实值只在 adapter 发请求那一刻取。
 */
import { PathError, parsePath, queryOne, setPath } from './jsonpath.js';
import { compileExpr } from './expr.js';
import { CONTEXT_LIMITS, SECRET_PLACEHOLDER, redactForDisk, redactSecretText } from './redact.js';
// 值形态判据取自 ir —— **与运行期求值、lint 三处同一个函数**，
// 这里若自己再手写一遍"什么算引用/表达式"，就是本仓反复那一族"三份手抄各错一次"。
import { isValueForm } from '@atest/ir';

/** 单一策略在 redact.ts。这里只是**再导出**，不是又写一份 ——
 *  两份脱敏规则各自演化的后果见 redact.ts 顶部。 */
export { SECRET_PLACEHOLDER } from './redact.js';

export class VarError extends Error {
  constructor(message: string, public readonly varName: string) {
    // varName 为空时**不拼那个后缀**。留空是为了让子类（resolve.ts 的 GenKindError）
    // 能复用 VarError 的归因（两条执行路径都按 instanceof VarError 归"用例自己的问题"）
    // 而不被塞进一句"（变量：gen）" —— gen 是**键名**不是变量名，
    // 而一句自己都读不通的报错会让人怀疑整条报错的可信度。
    // 现有调用方全部传非空 varName，所以这一改动对它们一字未变。
    super(varName ? `${message}（变量：${varName}）` : message);
    this.name = 'VarError';
  }
}

/** scenario.inputs 里我们关心的那部分。刻意不用 ir 的类型（引擎不反向依赖 schema 细节） */
export interface InputDef {
  name: string;
  default?: unknown;
  required?: boolean;
}

/**
 * 求值器注入点 —— **由调用方把 `resolve.ts` 的 `resolveValue` 交进来**，而不是这里 import。
 *
 * 为什么不让 `vars.ts` 直接 `import { resolveValue } from './resolve.js'`：
 * `resolve.ts` 顶层有 `class GenKindError extends VarError`，也就是**模块加载期**就要读到
 * `vars.ts` 的 `VarError`。让 vars 反过来 import resolve 就成一个模块环，
 * 而模块环的表现取决于两侧谁先被加载：从 `index.js` 进是好的，
 * 单独 `import { VarSpace } from '../src/vars.js'` 可能就是 `Class extends value undefined`。
 * 这类"换个入口就炸"的东西没法靠测试穷举（每条入口路径都得测一遍才知道有没有炸），
 * 所以挡在结构上：**本文件不 import resolve**。
 *
 * 传进来的仍然是 `resolve.ts` 里那**同一份** `resolveValue`，所以"两条执行形态共用一份
 * 求值"这件事没有因此多出第二个版本。第二个入参是**正在构造中的那一台变量空间**：
 * 求值 default 要走的正是它自己（`$other` 与 `$run.inputs.other` 都得命中已求出的那些），
 * 由构造器把自己交进来，调用方因此不需要知道"构造到一半的 VarSpace 能不能用"这件事。
 */
export type DefaultValueResolver = (def: InputDef, space: VarSpace) => unknown;

/**
 * 把 `scenario.inputs[].default` 兜进运行输入，**并把值形态求值掉**。
 *
 * **这个函数之前是不存在的**，后果不是"少一个便利功能"而是行为与声明相反：
 * IR 里写 `inputs:[{name:"q", default:"DEF"}]`，作者以为不传就是 DEF，
 * 实际得到的是 `引用未定义（变量：$q）`；而 UI 的表单按 IR 的 default 预填了值，
 * 于是**从 UI 跑能过、从 CI 跑必炸** —— 同一份 IR 两种行为，
 * 正是 docs/00 §6.6 里 Apifox GUI↔CLI 那类分裂的具体形态。
 *
 * 这是本仓反复出现的「schema 有字段、执行侧没人读」缺陷类的第 5 例
 * （前 4 例：maxCostUsdPerResolve、wait.onTimeout:'error'、assertPerf.maxRegressionRatio、
 * Match.unordered —— 见 docs/08 §3 的清扫方法）。
 *
 * ## 第二阶段（本轮）：default 里写的 `{expr}` / `{path}` / `{gen}` 也要求值
 *
 * 上一轮把 default 兜住了，但只是**原样**塞进去。`{expr:'1 + 2'}` 到了下游
 * 还是那个对象本身，发出去的 body 里就是 `{"expr":"1 + 2"}`，而**步骤判 pass**、
 * 退出码 0（改前实测见 docs/14 §5 那一行）。判据是 `ParamDefSchema.default` 是
 * 货真价实的 `ValueSchema`（四种形态都收），而执行侧只 `out[d.name] = d.default`
 * —— 同一个缺陷类，这次是**字段读到了、值没求值**。
 *
 * ## 为什么是定点迭代而不是"按声明顺序来一遍"
 *
 * default 之间可以互相引用（`{path:'$other'}`）。按声明顺序单趟的话，
 * `b` 引用 `a` 能成、`a` 引用 `b` 就永远报"引用未定义"，
 * 而**"改一下 inputs 的书写顺序就能跑通"正是本文件通篇在反对的那类行为**
 * （同一份 IR 挪个位置就换语义）。所以每轮只处理"现在求得出"的那些，
 * 求出的写回 `target`（也就是活着的 `run.inputs`）成为后续几轮的可见值，直到某轮没有进展。
 *
 * 关键的一条：**没求出来的 default 一个字都不写进 target**。可见的只有"显式传入的 +
 * 已求完的"，于是引用一个还没求出来的输入自然得到 `引用未定义`（下一轮再试），
 * 而**不可能**拿到那个 `{expr:…}` 半成品 —— 半成品外泄正是本轮在修的那个缺陷，
 * 把它当中间状态用等于换种方式留着它。
 *
 * 没有进展而仍有剩下的就是**互引成环**，抛而不是死循环：单看 `a`、`b` 各自都是合法 IR，
 * 只有合起来才不成立，所以报出来必须点名这一组，否则人只会去改其中一个。
 *
 * ## 语义决定（沿用旧的那三条，未改）
 *  1. **只有"根本没传这个键"才用 default**，`{q: undefined}` 也算传了。
 *     区分不出来就会出现"传 null 想清掉默认值，结果又被兜回 DEF"。
 *  2. default **不做类型校验**。IR 的 ParamDef.type 由 lint/解析期保证，
 *     运行期再校一遍是在信任边界内又建一道更弱的信任边界。
 *  3. default 与传入值**同放一层**（都在 run.inputs 下），不做"外层遮蔽内层"：
 *     二者不是两个来源的同名冲突，而是同一个输入的两个取值，
 *     分两层会让 `$.run.inputs` 的遍历结果出现重名键。
 *
 * @param target 已经装着**显式传入的**那些输入的对象；求出来的 default 就地写回它，
 *   返回值就是它。构造器把准备挂上 `run.inputs` 的那个对象交进来，
 *   于是"求出来"与"下游看得见"是同一个动作，没有第二份清单需要同步。
 * @param resolve 求值器。**不传就是上一轮的行为（原样塞）**，而生产路径不会走到那一支：
 *   `VarSpace` 的类型要求"传了 `inputDefs` 就必须给求值器"（见构造器的 init 联合类型），
 *   漏一个入口不是"少个优化"而是**编译不过**。留着这一支只为"只要兜底、不求值"的夹具。
 */
export function applyInputDefaults(
  target: Record<string, unknown>,
  defs: readonly InputDef[] | undefined,
  resolve?: (def: InputDef) => unknown,
): Record<string, unknown> {
  if (!defs?.length) return target;
  // 待求的按**声明顺序**起排（拓扑排序的入队顺序也用它，于是同一份 IR 的求值顺序
  // 与 `{gen:…}` 取值确定 —— 顺序随机会让两次运行的默认值不同，破 M7 的确定性断言）
  const pending = defs.filter((d) => d && typeof d.name === 'string' && !(d.name in target));
  if (!resolve) {
    for (const d of pending) target[d.name] = d.default;
    return target;
  }

  // 名字 → 它依赖哪些**同样待求的** default。只连这一类边：
  // 依赖显式传入的输入（已在 target 里）与依赖 env 都不需要等。
  const pendingNames = new Set(pending.map((d) => d.name));
  const deps = new Map(pending.map((d) => [d.name, defaultValueDeps(d, pendingNames)]));

  const order: InputDef[] = [];
  // 注意**不**去掉自引用那条边：`{path:'$self'}` 排不完，于是自然落进下面那一格，
  // 拿到"点名这一组"的报错。若把它当"无依赖"先求，得到的是一句"引用未定义（变量：$self）",
  // 而人会去查"我没传这个输入吗"—— 它传了，就在下一行。
  const waitingOn = new Map(pending.map((d) => [d.name, [...deps.get(d.name)!]]));
  // Kahn，队列按声明顺序种子化：先入队的先求，可解的图里每个节点恰好出队一次
  let ready = pending.filter((d) => waitingOn.get(d.name)!.length === 0);
  const done = new Set<string>();
  while (ready.length) {
    const next: InputDef[] = [];
    for (const d of ready) {
      order.push(d);
      done.add(d.name);
      for (const other of pending) {
        if (done.has(other.name) || other.name === d.name) continue;
        const w = waitingOn.get(other.name)!;
        if (!w.includes(d.name)) continue;
        w.splice(w.indexOf(d.name), 1);
        if (w.length === 0) next.push(other);
      }
    }
    ready = next;
  }
  /*
   * 排不完就是**互引成环**（`a` 引 `b`、`b` 引 `a`，或自引 `$who`）。
   *
   * 为什么这一格值得单独判而不是"求值时抛引用未定义"：**单看每一条 default 都是合法 IR**，
   * 只有合起来才不成立。留给求值侧的话，症状是"引用未定义（变量：$b）"，
   * 人会去查"我没传 b 吗"，而 b 明明声明了 —— 本仓反复那类"把结构问题说成值问题"。
   * 这里能点名整组，并且说清 default 求值发生在任何步骤之前（所以引用步骤产出也是同一类错）。
   *
   * ⚠ **一个名字的情况要说"自引用"，不能说"互相引用"。** 我第一版对
   * `default:{path:'$who'}` 报的是「互相引用、求不出值（who）」—— 只点名了一个名字却说"互相"，
   * 人会去找"和谁互相"，而答案就在自己这一行。这一格是实测出来的（`.scratch` 探针），
   * 不是推想：单元素那一组在拓扑排序里和真环落在同一个桶，而它们的**人话**不一样。
   */
  if (order.length !== pending.length) {
    const cyclic = pending.filter((d) => !done.has(d.name)).map((d) => d.name);
    const shape = cyclic.length === 1
      ? `inputs[].default "${cyclic[0]}" 引用了它自己，求不出值`
      : `inputs 的 default 互相引用、求不出值（${cyclic.join(' ↔ ')}）`;
    throw new VarError(
      `${shape}。default 在**任何步骤跑之前**求值，`
      + '所以只许引用显式传入的输入、环境变量，或不构成环的其它 default',
      cyclic.join(','),
    );
  }

  for (const d of order) target[d.name] = resolve(d);
  return target;
}

/**
 * 一条 default 依赖哪些输入名（拓扑排序的边）。**lint 侧也用它**（见下面"为什么导出"）。
 *
 * 走的是**值形态那一棵树**：`resolveValue` 对非值形态的对象/数组会递归下去，
 * 所以 `{tag:'x', n:{expr:'$base + 1'}}` 里的 `$base` 也算依赖 ——
 * 少递归一层就是"少一条边"，而少一条边的后果是**排序可能把依赖方排在前头**，
 * 于是拿到 `undefined`（表达式对缺失引用返回 undefined，不抛）。
 * 那正是这一族最难查的形状：值错了而状态是 pass。
 *
 * 两条刻意的取舍：
 *  - **只认落在 `pendingNames` 里的名字**。`$env.baseUrl`、`$sku`（显式传入的输入）
 *    都不需要等，连边只会让图无缘无故出现"排不完"的假环。
 *  - **表达式解析不了就当没有依赖**，而不是在这里抛。语法错要由求值那一侧报，
 *    那里知道是**哪一条输入**的 default 坏了；在这里抛就只能说"某条 default 语法错"。
 *    排序对一条本来就会失败的 default 是否精确，没有意义。
 */
function defaultValueDeps(def: InputDef, pendingNames: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const addRef = (ref: unknown): void => {
    if (typeof ref !== 'string') return;
    let segs: { kind: string; value?: string | number }[];
    try {
      segs = parsePath(ref) as unknown as typeof segs;
    } catch {
      return; // 写坏的路径由求值侧报错，这里不抢
    }
    const head = segs[0];
    if (head?.kind !== 'key' || typeof head.value !== 'string') return;
    // `$.run.inputs.<name>` 与裸名 `<name>` 两种写法指同一个输入（可见性一致性，见 asExprRoot），
    // 所以两种都要认；而 `$.run.outputs.x` / `$.step.x` 不是输入依赖
    if (head.value === 'run') {
      if (segs[1]?.value === 'inputs' && typeof segs[2]?.value === 'string') {
        const n = segs[2].value;
        if (pendingNames.has(n)) out.add(n);
      }
      return;
    }
    if (pendingNames.has(head.value)) out.add(head.value);
  };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 24 || v === null || typeof v !== 'object') return;
    const form = isValueForm(v);
    if (form === 'ref') return addRef((v as Record<string, unknown>).path);
    // expr 的引用从 AST 上取（`compileExpr().refs`），不拿正则猜：
    // `'$a + $b'` 与 `'x$a'`（字符串字面量里的）在词法层不是一回事，
    // 而漏一条边比多一条边的后果严重得多（见上面那段）。
    if (form === 'expr') {
      const src = (v as Record<string, unknown>).expr;
      if (typeof src === 'string') {
        try {
          for (const r of compileExpr(src).refs) addRef(r);
        } catch {
          /* 语法错：交给求值侧报，见函数头 */
        }
      }
      return;
    }
    if (form) return; // gen 不引用任何东西
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(def.default, 0);
  return out;
}

/**
 * `inputs[].default` 之间互相引用而成的环，按**强连通分组**返回（每组一组名字）。
 *
 * 静态侧（`lint.ts` 的 `DEPENDENCY_CYCLE`）用它，于是"这一组互为依赖"这件事
 * 只有**一份判据**：排序用什么边、报环就用什么边。两处各判过一次的话，
 * 就会出现"lint 说有环而求值侧求出来了"或反过来 —— 而这两种结论在 CI 上
 * 是两种完全不同的处理（前者改 IR，后者查平台）。`isValueForm` 在
 * `RESERVED_KEY_REWRITE` 那段记过一次同形态的真实代价。
 *
 * ## 为什么这一族要报 error 而不是"留给求值时抛引用未定义"
 *
 * 环里的**每一条 default 单看都是合法 IR**（`a` 引用 `b`、`b` 引用 `a`，两句都合规），
 * 只有合起来才不成立。留给求值侧的话，症状是一句"引用未定义（变量：$b）"，
 * 而人会去查"我没传 b 吗"—— 他传了，就在下一行。这是本仓反复那类"把结构问题说成值问题"。
 *
 * ## 为什么求值侧自己也在判（`applyInputDefaults` 里那一格），两处不算重复
 *
 * 与 `lint.ts` 顶部 `call` 环那条同一个论证：`run` 不跑 lint（`--strict` 是可选的）、
 * 引擎以 bundle 形态给前端做实时校验时没人强制 lint、`call` 的子场景是运行时才取回来的。
 * lint 负责"写的时候早知道、并且能拦下 CI"，运行期那道负责"绕过 lint 也不会跑出错误答案"。
 * **两边都必须能点名整组**，所以共用 {@link defaultValueDeps} 那一份边集。
 */
export function detectDefaultCycles(defs: readonly InputDef[]): string[][] {
  const names = new Set(defs.filter((d) => d && typeof d.name === 'string').map((d) => d.name));
  /*
   * 边集**含自边**（`{name:'who', default:{path:'$who'}}`），于是单元素环也会被报出来。
   *
   * 这一点曾经反着做（把自引用从边里剔掉，理由是"运行期抛引用未定义才是那句真话"），
   * 而那是错的：求值侧的拓扑排序**刻意保留**自边（见 applyInputDefaults 里那段），
   * 于是"lint 说干净、真跑报 inputs 求不出值"这一对分叉就是这么来的 ——
   * 本仓记过不止一次的那类"两道闸给相反答案"。现在两侧同一份边集、同一个结论。
   */
  const edges = new Map<string, Set<string>>();
  for (const d of defs) {
    if (!d || !names.has(d.name)) continue;
    edges.set(d.name, defaultValueDeps(d, names));
  }
  /*
   * Tarjan 强连通分量，**显式栈**而不是递归。
   *
   * 为什么不用递归 DFS：递归那版的栈深上界是"输入个数"，而 `ScenarioSchema.inputs`
   * 是 `z.array(...)`、**没有 `.max()`**（"schema 没 cap"这件事在
   * `packages/engine/test/` 里另有记录），于是一份几千个输入的 IR 就能把递归打穿；
   * 而它会在**求值侧先炸**（构造期），那份环报错又被 interpreter 包成
   * "这一轮 inputs 坏了" —— 深度问题伪装成语义问题，正是这一族最难查的形状。
   * 迭代版的开销只有一个与输入数成正比的数组，和 lint 里其它规则同一量级。
   * 代价是多二十行：换来的是"输入多到几千条"不再需要作者避开。
   */
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  type Frame = { name: string; it: IterableIterator<string> };
  const visit = (start: string): void => {
    if (index.has(start)) return;
    const work: Frame[] = [{ name: start, it: edges.get(start)!.values() }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const f = work[work.length - 1]!;
      const nxt = f.it.next();
      if (!nxt.done) {
        const m = nxt.value;
        if (!index.has(m)) {
          index.set(m, counter);
          low.set(m, counter);
          counter += 1;
          stack.push(m);
          onStack.add(m);
          work.push({ name: m, it: edges.get(m)!.values() });
        }
        if (onStack.has(m)) low.set(f.name, Math.min(low.get(f.name)!, index.get(m)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.name, Math.min(low.get(parent.name)!, low.get(f.name)!));
      if (low.get(f.name) === index.get(f.name)) {
        const group: string[] = [];
        for (;;) {
          const top = stack.pop()!;
          onStack.delete(top);
          group.push(top);
          if (top === f.name) break;
        }
        /*
         * 一组要报出来的条件：**多于一个点**（互引），或者**单个点带自边**（自引用）。
         * 只判 `group.length > 1` 会把自引用整类漏掉 —— 强连通分量算法对自环给出的
         * 组大小就是 1，而"一个点的组"同时也确实是"压根不在任何环上"的那些点的形状。
         * 区分两者只能看它有没有指向自己的那条边，不能看组大小。
         */
        const only = group.length === 1 ? group[0] : undefined;
        const selfLoop = only !== undefined && (edges.get(only)?.has(only) ?? false);
        if (group.length > 1 || selfLoop) cycles.push(group.reverse());
      }
    }
  };
  // 起点按声明顺序（Set 保持插入序），于是报出来的那一组的名字顺序也是 IR 里的顺序
  for (const n of names) visit(n);
  return cycles;
}

/**
 * 作用域帧。**退帧即销毁**（docs/02 §5）：循环体内新建的临时变量不会泄漏到循环外。
 *
 * 因此累加器必须在循环**之前**声明（`set total = 0` 然后循环内 `set total = $total + …`）：
 * set 的写语义是「写到已声明它的那一帧」，所以循环内的赋值天然写在外层帧上，
 * 累加生效，而循环内新建的名字照样随帧销毁。不需要第二套「上提」语义。
 */
interface Frame {
  name: string;
  vars: Map<string, unknown>;
}

/**
 * `VarSpace` 的构造参数。
 *
 * 拆成两个分支只为了一件事：**传了 `inputDefs` 就必须传 `resolveDefault`**。
 * 这不是排版偏好 —— default 的求值有三个真入口（解释器根 / `call` 子场景 /
 * 预编译计划），而类型上不分开的漏法是"某个入口少传一个键"，
 * TS 一声不响，症状是那个入口把 `{expr:…}` 原样当值发出去、步骤判 pass。
 * 上一轮 default 兜底靠注释与自觉接，结论就在 {@link applyInputDefaults} 顶上那段。
 * （第四个 `new VarSpace` 调用点 `dryrun.ts` 刻意不带 `inputDefs`，因此落在
 * 第一分支、编译得过：它的实例当场丢弃、`inputs` 是面板已预填过的实参。理由在原地。）
 */
export type VarSpaceInit = {
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  secretResolver?: (ref: string) => string;
} & (
  | { inputDefs?: undefined; resolveDefault?: undefined }
  | {
      inputDefs: readonly InputDef[];
      /** 第二个入参是**正在构造中的这一台**（构造器把自己交进来），见 {@link DefaultValueResolver} */
      resolveDefault: DefaultValueResolver;
    }
);

/**
 * default 求值失败时的消息措辞。
 *
 * **不许把 default 里那个值本身带进消息**。default 与请求体是同一类位置 ——
 * 写死口令/密钥的正是这些地方（`HARDCODED_SECRET` 整条规则的存在就是证据），
 * 而这条消息会一路进 CI 日志与 junit。做法与 lint 那条同一条：**拿手上那个源串整段挖掉**
 * （解析器的消息会把源码原样回带，形如 `意外记号 "末尾"（表达式：1 +）`），
 * 再叠 `redactSecretText` 兜"源码之外别处混进来的密钥"。**顺序不可换**：
 * 先脱敏的话，一条不是任何已知密钥形状的明文口令会照样漏过去
 * （变异集 value-form-lint 的 W5 测的就是这个顺序）。
 */
/**
 * `default` 求值失败。消息**已过脱敏 + 已挖掉源码片段**（见 scrubDefaultValueError），
 * 所以任何载体（CI 日志 / HTML 报告 / 失败落盘）都能直接放它。
 */
export class DefaultValueError extends VarError {
  /** 出错的输入名（同时是 VarError.varName，也就是报错后缀里那个名字） */
  readonly inputName: string;
  /** 原因那条消息本身，供需要自己拼标题的载体用（lint issue、dry-run） */
  readonly reason: string;
  constructor(inputName: string, reason: string) {
    super(`inputs[].default "${inputName}" 求值失败：${reason}`, inputName);
    this.name = 'DefaultValueError';
    this.inputName = inputName;
    this.reason = reason;
  }
}

function scrubDefaultValueError(def: InputDef, e: unknown): string {
  const raw = e instanceof Error ? e.message : '?';
  const src = (def.default as Record<string, unknown> | undefined)?.expr;
  const path = (def.default as Record<string, unknown> | undefined)?.path;
  let msg = raw;
  // 只挖**字符串**那两种形态（expr / path）。gen 与字面量没有"源码"可言，
  // 而把对象 JSON 化再拿去替换会误伤消息里不相干的片段。
  for (const s of [src, path]) {
    if (typeof s === 'string' && s.length) msg = msg.split(s).join('«表达式源码已省略»');
  }
  return redactSecretText(msg).slice(0, 200);
}

export class VarSpace {
  private frames: Frame[] = [{ name: 'global', vars: new Map() }];
  /** 步骤导出。$ref 引用 $.step.<id> 走这里，而不是普通变量 */
  private stepExports = new Map<string, Record<string, unknown>>();
  private runRoot: Record<string, unknown> = {};
  private envMap: Record<string, unknown> = {};
  /** 引擎解析密钥用；对 Agent 永不可见 */
  private secretResolver: ((ref: string) => string) | undefined;
  private writes: { name: string; frame: string; scopeId?: string }[] = [];
  /**
   * `default` 正在求值的那一段窗口（见构造器）。窗口内 `$secret.*` 直接拒。
   * 它必须是**状态而不是靠调用方自觉**：漏一次就等于把密钥值写进 `run.inputs`，
   * 而那一层会进 `asExprRoot()` 与 `snapshotForAgent()`。
   */
  private resolvingDefaults = false;
  /** forkBranch 给自己加的那一帧在本实例 frames 里的下标；根实例为 -1 */
  private ownIndex = -1;

  /**
   * `inputDefs` 与 `resolveDefault` **成对必填**：传了声明就必须给求值器。
   *
   * 为什么要把这件事做成类型约束而不是注释：default 的求值要接**三个真入口**
   * （解释器根 / `call` 子场景 / 预编译计划），而漏掉任何一个的症状是
   * "解释器模式能跑、预编译模式静默把 `{expr:…}` 当值发出去" —— 正是本仓反复那一族
   * （同一个概念两条路，只修一条）。上一轮 `default` 兜底就是靠注释与自觉接的，
   * 而那一轮的结论是"注释说了没人读"。类型说"不给就编译不过"，漏不了。
   * 第四个 `new VarSpace` 的调用点（`dryrun.ts`）**刻意不接**：它的实例当场丢弃、
   * 而它的 `inputs` 是面板已按 default 预填过的实参，理由写在原处注释里。
   *
   * 求值器要 clock，而 clock 是运行时的东西，所以留在调用方那一侧的闭包里
   * （`resolveValue(def.default, { vars, clock })`），本类不持有 clock。
   */
  constructor(init: VarSpaceInit = {}) {
    // 顺序有实质差别：env / secretResolver 必须先就位，因为求 default 时
    // `$env.baseUrl` 是合法引用；而 runRoot.inputs 必须是**同一个对象**，
    // 于是先建对象再挂上去 —— 反过来（先 apply 再挂）的话，
    // 求值过程中引用 `$run.inputs.另一个输入` 会看不到本轮已经求出来的那些。
    this.envMap = init.env ?? {};
    this.secretResolver = init.secretResolver;
    const target: Record<string, unknown> = { ...(init.inputs ?? {}) };
    this.runRoot = { inputs: target, outputs: {} };
    const defs = init.inputDefs;
    if (!defs?.length || !init.resolveDefault) {
      applyInputDefaults(target, defs);
      return;
    }
    const resolve = init.resolveDefault;
    // 拓扑排序在**写任何一个值之前**就跑完（见 applyInputDefaults），所以"有环"这种情况
    // 不会留下半个求好的 inputs —— 要么全求出来，要么一个都没写。
    this.resolvingDefaults = true;
    try {
      applyInputDefaults(target, defs, (def) => {
        try {
          return resolve(def, this);
        } catch (e) {
          // 补上"是哪一条输入"。底下那层（表达式/引用/生成器）只知道值长什么样，
          // 不知道它挂在哪个输入名上，于是原样抛出会得到一句没有主语的报错。
          // 消息本身还要过一遍脱敏 + 挖掉源码，理由见 scrubDefaultValueError。
          // 用 DefaultValueError 而不是裸 VarError：interpreter 那一侧要能认出
          // "这是 IR 里的一条 default 写坏了"，而不是把它当成引擎内部故障
          // （CLI 的顶层 catch 会把后者说成"这不是你的用例的问题，请报 bug"）。
          throw new DefaultValueError(def.name, scrubDefaultValueError(def, e));
        }
      });
    } finally {
      this.resolvingDefaults = false;
    }
  }

  /*
   * 给一条 parallel 分支切一份**局部作用域**。
   *
   * 要解决的问题（探针 packages/engine/test/scope.test.ts 里钉着）：帧栈整个 VarSpace
   * 只有一条，并发分支各自 push/pop 同一条栈。分支 B 里一句 `set mineOnly = 42`
   * 走到 set→declare，写的是**当时栈顶那一帧** —— 而那时栈顶可能是分支 A 的 forEach
   * 刚压的迭代帧。A 的迭代结束时 popTo 把那一帧弹掉，B 写进去的值跟着一起没了：
   * B 那一步报 pass，`$mineOnly` 却永远查不到。三支都是 set + 各自循环的写法
   * 在真实场景里太常见（并发拉列表再各自断言），不该指望作者避开。
   *
   * 三条设计决定：
   *  1. **global 帧按引用共享**，各分支只给自己加那**一帧**。于是"写一个 parallel
   *     之前就已声明的名字"（累加器写法，docs/02 §5 明确推荐的）仍然直接写进共享帧，
   *     行为一个字节没变；只有"分支里新声明的名字"才落在分支本地。
   *     这一条是实测出来的：预先声明 `mineOnly = 0` 之后同样的并发就不丢了。
   *  2. **各分支不再共享步骤导出**。原先两支的 `saveAs` 撞名是"谁后跑谁算"，
   *     同一份冻结场景能给 pass 也能给 fail —— 直接破 M7 的确定性断言。
   *     隔离之后两支各写各的 Map，**交错不再决定值**，但那条静态闸我**没有删**：
   *     两支写同一个名字这件事，隔离只解决了"运行中互不干扰"，
   *     没解决"收尾要合并成一份"（见第 3 条），所以照样拒。
   *     闸现在只剩这一条判据（另一条"一支压帧、另一支提到同名循环项"才是真被隔离修掉的）。
   *  3. **收尾合并**。`adoptFrom` 把分支本地帧里的名字提到**外层栈顶那一帧**
   *     （不是 global —— parallel 常在 forEach 里，提到 global 等于让循环内的并发漏到循环外）。
   *     于是分支里新声明的名字在 parallel **之后**可读 —— 这是刻意的：不合并的话
   *     并发写法只能读预先声明的名字，等于用隔离换个新功能不能写，
   *     而"每支各算一个结果、parallel 之后统一断言"恰恰是并发最主要的用法。
   *     判据用 `has()`（**只看帧**，不看 inputs/env），理由见 adoptFrom 的注释。
   *     两支同名时**先并的赢**，而并的顺序是分支**声明顺序**（不是完成顺序）——
   *     这保证确定性，但"确定"不等于"对"（作者两份都想要），所以那种写法由闸拒掉。
   *
   * 用 Object.assign 而不是逐字段列一遍来构造：以后给 VarSpace 加字段会自动带上。
   * 逐字段列的话，漏一个 `secretResolver` 就是"parallel 分支里密钥解析静默失效" ——
   * 又是本仓那个缺陷类（字段在、没人接），而且只在并发下出现。
   */
  forkBranch(label: string): VarSpace {
    const branch = Object.assign(Object.create(VarSpace.prototype) as VarSpace, this) as VarSpace;
    /*
     * 帧表**复制数组本身**，里面的帧对象按引用带走。
     *
     * 为什么不裁成"只带 global"：parallel 常常写在 forEach 里面（"每条数据并发跑一遍"），
     * 裁成只带 global 会让分支看不到那层迭代帧，于是分支里 `set item.x` 这种
     * "写外层已声明的名字"落不回迭代帧，反而写进分支本地 —— 帧弹掉就丢，
     * 正是这次要修的那个缺陷的另一个版本。修一个 bug 换一个同形的 bug 不算修好。
     * 带上引用是安全的：分支只在**自己复制时的长度之上** push，
     * popTo 的 depth 永远 >= 自己那个下标，摸不到复制来的帧。
     */
    const inherited = this.frames.length;
    (branch as unknown as { frames: Frame[] }).frames = [...this.frames];
    // 步骤导出**必须各支一份**。共享的话两支 saveAs 同名仍是"谁后写谁算"，
    // 那正是本条要消灭的竞态；共享一个 Map 等于把它从变量空间挪到导出表里藏起来。
    (branch as unknown as { stepExports: Map<string, Record<string, unknown>> }).stepExports = new Map();
    (branch as unknown as { ownIndex: number }).ownIndex = inherited;
    // 写入历史各记一份，合并时由 adoptFrom 搬进主表；
    // 不搬的话 UI 的「谁改了这个值」在并发用例里会缺一半记录
    (branch as unknown as { writes: { name: string; frame: string; scopeId?: string }[] }).writes = [];
    branch.push(`branch:${label}`);
    return branch;
  }

  /**
   * 这一支有没有留下需要并回主实例的东西。
   * 只看帧变量不够：一支只做 `http saveAs` 的话一帧都没写，但导出必须合并 ——
   * 漏判的表现是"parallel 之后 $.step.<分支内 id> 说尚无输出"，一个只在并发下出现的假失败。
   */
  hasLocalWrites(): boolean {
    if (this.ownIndex < 0) return false; // 根实例从不被合并；不挡的话它任何一步之后都返回 true
    if (this.stepExports.size) return true;
    for (let i = Math.max(1, this.ownIndex); i < this.frames.length; i++) if (this.frames[i]!.vars.size) return true;
    return false;
  }

  /**
   * 把分支本地的写入并回主实例。见 {@link forkBranch} 第 3 条。
   * 只并"global 里查不到"的名字；分支自己的步骤导出整体并回来（stepId 全局唯一，不会撞）。
   */
  adoptFrom(branch: VarSpace): void {
    const self = this as unknown as { frames: Frame[]; writes: { name: string; frame: string; scopeId?: string }[] };
    const b = branch as unknown as { frames: Frame[]; writes: { name: string; frame: string }[]; ownIndex: number; stepExports: Map<string, Record<string, unknown>> };
    /*
     * 并回**外层栈顶那一帧**，不是 global 帧。
     *
     * parallel 常常写在 forEach 里面（"每条数据并发跑一遍"）。写进 global 的话，
     * 分支里新声明的名字会被提到循环外面 —— 而循环体外层根本不该看见它，
     * docs/02 §5 的语义是"帧退栈即销毁"。提到 global 等于让循环里的并发
     * 污染循环外的变量空间，那正是这次要修的缺陷的镜像版本（一个是值凭空消失，
     * 一个是值凭空多出来活着出去）。
     */
    const target = self.frames[self.frames.length - 1]!;
    for (let i = Math.max(1, b.ownIndex); i < b.frames.length; i++) {
      for (const [k, v] of b.frames[i]!.vars) {
        /*
         * 判据用 **has（只看帧）**，不是 knows（帧+inputs+env）。
         * 理由不是"哪个更方便"，而是**并行必须与顺序同语义**：
         * 顺序执行时 `set token = "x"` 而 token 只存在于 env/inputs，
         * 走的是 declare —— 在当前帧新建一个遮蔽它的变量，之后读 `$token` 得到 "x"。
         * 若这里用 knows，env 里有 token 就跳过合并，于是**同一步写在 parallel 里
         * 会被静默丢弃、写在 parallel 外却生效** —— 同一份 IR 挪个位置就换行为，
         * 正是本仓反复出现的那类"看着一样、实际两套语义"。
         * 用 has 之后两种情形都是"帧里遮蔽 env"，一致。
         * 另一支/外层已声明的情况照样挡住：那时它就在某一层**帧**里，has 为真。
         */
        if (this.has(k)) continue; // 外层或先并的分支已有：不覆盖（先声明者赢，顺序固定 → 结果确定）
        target.vars.set(k, v);
      }
    }
    for (const [id, exp] of b.stepExports) this.stepExports.set(id, { ...this.stepExports.get(id), ...exp });
    self.writes.push(...b.writes);
    // 搬空，避免同一条写入被并两次（分支失败后又被合并一次的 paths）
    b.writes.length = 0;
    for (let i = Math.max(1, b.ownIndex); i < b.frames.length; i++) b.frames[i]!.vars.clear();
  }

  /** 这个名字在不在任何一层（帧 / 上层输入 / env）。可见性判据只有这一处。 */
  knows(name: string): boolean {
    return this.has(name) || name in this.inputs || name in this.envMap;
  }

  // ── 作用域栈 ────────────────────────────────────────────────────────────
  push(name: string): number {
    this.frames.push({ name, vars: new Map() });
    return this.frames.length - 1;
  }
  pop(): void {
    if (this.frames.length <= 1) throw new VarError('作用域栈已空，无法 pop', name0(this.frames));
    this.frames.pop();
  }
  /**
   * 丢弃某一帧及其以上。
   *
   * 为什么需要它而不是简单 pop()：循环容器压入迭代帧后，**子步骤自己也可能压帧**
   * （嵌套 forEach/while）。子步骤正常情况会配对 pop，但失败提前返回时未必，
   * 于是一句裸 pop() 可能弹出子步骤的帧，把 item/idx 泄漏到循环外 ——
   * 表现为「循环结束后 $item 还在」，一个安静污染后续断言的 bug。
   * 记下压栈时的深度、按深度回退，就不依赖子步骤的配对纪律。
   */
  popTo(depth: number): void {
    if (depth < 1) throw new VarError('popTo 不能回退到全局帧以下', `depth=${depth}`);
    while (this.frames.length - 1 >= depth) this.frames.pop();
  }
  /** 循环项：一次压入多个变量。返回压栈深度，供 popTo 使用 */
  pushLoop(vars: Record<string, unknown>, name = 'loop'): number {
    const depth = this.push(name);
    for (const [k, v] of Object.entries(vars)) this.declare(k, v);
    return depth;
  }
  pushIteration(loopVar: string, value: unknown, indexVar: string | undefined, index: number): number {
    return this.pushLoop({ [loopVar]: value, ...(indexVar ? { [indexVar]: index } : {}) }, 'forEach');
  }

  // ── 读写 ────────────────────────────────────────────────────────────────
  /** 在当前帧声明（遮蔽外层，退出即销毁） */
  declare(name: string, value: unknown): void {
    const frame = this.frames[this.frames.length - 1]!;
    frame.vars.set(name, value);
    this.writes.push({ name, frame: frame.name });
  }

  /** 赋值：已存在则写到它所在帧（保持「上游输出、下游读取」语义），否则写当前帧 */
  set(name: string, value: unknown): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i]!.vars.has(name)) {
        this.frames[i]!.vars.set(name, value);
        this.writes.push({ name, frame: this.frames[i]!.name });
        return;
      }
    }
    this.declare(name, value);
  }

  has(name: string): boolean {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.vars.has(name)) return true;
    return false;
  }

  /**
   * 按作用域链查变量。**帧变量遮蔽上层输入遮蔽环境变量** —— 与 asExprRoot
   * 的铺值顺序严格一致，否则 `$sku` 在断言里和表达式里会取到不同东西。
   */
  lookup(name: string): unknown {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.vars.has(name)) return f.vars.get(name);
      // 支持 loopRow.id 这种「头段在帧里、余下走路径」
      if (name.includes('.') || name.includes('[')) {
        const head = name.split('.')[0]!.replace(/\[.*$/, '');
        if (f.vars.has(head)) {
          try { return queryOne(f.vars.get(head), '$' + name.slice(head.length)); } catch { return undefined; }
        }
      }
    }
    // 帧里没有 → 上层输入，再环境变量
    for (const scope of [this.inputs, this.envMap]) {
      if (name in scope) return scope[name];
      const head = name.split('.')[0]!.replace(/\[.*$/, '');
      if (head in scope) {
        try { return queryOne(scope[head], '$' + name.slice(head.length)); } catch { return undefined; }
      }
    }
    return undefined;
  }

  /**
   * 解析任意 `$.` 引用。这是 IR 里所有 RefSchema 的唯一求值入口。
   * 故意在这里区分「未定义」与「值为 undefined」——前者是错误（VAR_UNDEFINED），后者合法。
   */
  resolveRef(ref: string): { found: boolean; value: unknown } {
    const segs = parsePath(ref);
    if (!segs.length) return { found: false, value: undefined };
    const rootSeg = segs[0];
    if (rootSeg?.kind !== 'key') throw new VarError('引用必须以 $. 开头', ref);
    const root = rootSeg.value as string;
    const restPath = '$' + segs.slice(1).map(segStr).join('');

    if (root === 'secret') {
      /*
       * **求值 `inputs[].default` 期间一律拒**。这是本轮引入的新风险，不是旧行为：
       * 修之前 default 是原样塞进变量空间的，`{path:'$secret.pw'}` 根本走不到这里；
       * 修之后它会走通，于是密钥真值被写进 `run.inputs.pw` ——
       * 而那一层会进 `asExprRoot()`（任何表达式都能 `$pw` 拿到）、进 `visible()`、
       * 并且是 `snapshotForAgent()` 里 `__run.inputs` 那一栏的输入。
       * 那条规则的原文是"密钥真值只在发请求那一刻存在"，而 default 求值发生在
       * **任何请求之前**，所以这不是"多一层脱敏"能补的，只能拒。
       *
       * 拒而不是"存进去但脱敏"：那样 `$.run.inputs.pw` 在使用点上是错的，
       * 一个恒错的引用比一条明确的报错坏得多（人会去查被测系统）。
       * 也不带 ref 之外的任何信息 —— 不带值、不带长度。
       */
      if (this.resolvingDefaults) {
        throw new VarError(
          'inputs[].default 里不许引用密钥（`$secret.*`）。default 在任何请求之前求值，'
          + '而密钥真值只在那一刻之后存在；把密钥写进变量空间会让它出现在表达式根与 Agent 上下文里',
          ref,
        );
      }
      const ref2 = '$' + segs.slice(1).map(segStr).join('');
      const name = ref2.replace(/^\$\./, '').replace(/^\$/, '');
      return { found: true, value: this.secretResolver ? this.secretResolver(`secret:${name}`) : SECRET_PLACEHOLDER };
    }
    if (root === 'env') {
      const v = queryOne(this.envMap, restPath.replace(/^\$/, '$'));
      return { found: v !== undefined, value: v };
    }
    if (root === 'run') {
      const v = queryOne(this.runRoot, restPath.replace(/^\$/, '$'));
      return { found: v !== undefined, value: v };
    }
    if (root === 'step') {
      // $.step.<id>.<rest> —— 注意 rest 要从第 3 段起算，否则会把 id 当成键去查
      const idSeg = segs[1];
      if (idSeg?.kind !== 'key') throw new VarError('$.step 后必须跟步骤 id', ref);
      const exports = this.stepExports.get(idSeg.value as string);
      if (!exports) throw new VarError(`步骤 "${idSeg.value}" 尚无输出（未执行、已失败、或尚未轮到它）`, ref);
      const sub = '$' + segs.slice(2).map(segStr).join('');
      const v = queryOne(exports, sub);
      return { found: v !== undefined, value: v };
    }
    if (root === 'outputs') {
      const v = queryOne(this.runRoot.outputs ?? {}, restPath.replace(/^\$/, '$'));
      return { found: v !== undefined, value: v };
    }
    // 其余当作变量名（可能带路径），走作用域链。
    // 注意**不能**抹掉首个点号：`$.row.score` 的变量名是 `row.score`，
    // 早先写成 replace(/^\./,'') 会拼成 `rowscore`，于是深层引用永远查不到。
    const name = root + segs.slice(1).map(segStr).join('');
    const head = name.split('.')[0]!.replace(/\[.*$/, '');
    // 变量、上层输入、环境变量三处任一存在即算「已定义」，与 asExprRoot 的可见性一致
    const known = this.knows(head);
    // 「未定义」才是错误；「值是 undefined」合法（docs/02 §5），故 found 只看名字存不存在
    return { found: known, value: this.lookup(name) };
  }

  /** 步骤导出。引擎在步骤成功后调用；失败步骤不导出（引用它会得到清晰报错） */
  exportStep(stepId: string, exports: Record<string, unknown>): void {
    this.stepExports.set(stepId, { ...this.stepExports.get(stepId), ...exports });
  }

  stepExportsOf(stepId: string): Record<string, unknown> | undefined {
    return this.stepExports.get(stepId);
  }

  /** run.outputs.<name> ← 显式声明的下层输出 */
  setOutput(name: string, value: unknown): void {
    const out = (this.runRoot.outputs ??= {}) as Record<string, unknown>;
    out[name] = value;
  }

  get inputs(): Record<string, unknown> {
    return (this.runRoot.inputs ?? {}) as Record<string, unknown>;
  }
  get outputs(): Record<string, unknown> {
    return (this.runRoot.outputs ?? {}) as Record<string, unknown>;
  }
  get env(): Record<string, unknown> {
    return this.envMap;
  }

  /**
   * 表达式求值的 root：让 `$.a.b` 直接命中变量。
   *
   * inputs / env 也铺到顶层，所以 `$sku`、`$baseUrl` 能直接写。
   * 理由是**可见性一致性**：`resolveRef` 让 `$sku` 命中输入，若表达式里必须写
   * `$run.inputs.sku`，同一变量在两种语法下行为不同，用户只能背规则。
   * 顺序上 inputs 先铺、帧变量后铺，因此**局部变量遮蔽同名输入**（符合预期）。
   */
  asExprRoot(): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...this.envMap, ...this.inputs };
    for (const f of this.frames) for (const [k, v] of f.vars) merged[k] = v;
    merged.step = Object.fromEntries(this.stepExports);
    merged.run = this.runRoot;
    merged.env = this.envMap;
    return merged;
  }

  /** 写入历史（UI 的 VarChip 溯源与「谁改了这个值」） */
  get writeLog(): readonly { name: string; frame: string }[] {
    return this.writes;
  }

  /**
   * 供 Agent 上下文 / 报告 / trace 落盘使用的**脱敏视图**。
   * 任何把变量空间交给模型或写进磁盘的路径都必须经过它。
   */
  snapshotForAgent(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < this.frames.length; i++) {
      // 走 redact.ts 那一份策略（键名 + 值形态 + 深度上限）。
      // 这个视图是**交给模型**的，所以值形态判据尤其重要：
      // 一个把 token 放在 data 字段里的响应，按字段名的规则拦不住，
      // 于是密钥会进 Agent 上下文 —— 而 Agent 能把它 echo 进生成的用例正文里提交上去。
      for (const [k, v] of this.frames[i]!.vars) out[k] = redactForDisk(v, 0, CONTEXT_LIMITS);
    }
    out.__run = { inputs: redactForDisk(this.inputs, 0, CONTEXT_LIMITS), outputs: redactForDisk(this.outputs, 0, CONTEXT_LIMITS) };
    out.__env = redactForDisk(this.envMap, 0, CONTEXT_LIMITS);
    return out;
  }

  /** 深度写入某变量的嵌套路径（set 节点支持 assign: {"row.score": 1}） */
  setDeep(name: string, value: unknown): void {
    if (!name.includes('.')) return this.set(name, value);
    const existing = this.lookup(name.split('.')[0]!);
    if (existing && typeof existing === 'object') {
      const holder = structuredCloneish(existing) as Record<string, unknown>;
      setPath(holder, '$' + name.slice(name.indexOf('.')), value);
      this.set(name.split('.')[0]!, holder);
      return;
    }
    const holder: Record<string, unknown> = {};
    setPath(holder, '$' + name.slice(name.indexOf('.')), value);
    this.set(name.split('.')[0]!, holder);
  }

  /** 当前可见变量（调试面板用） */
  visible(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.frames) for (const [k, v] of f.vars) out[k] = v;
    return out;
  }
}

function segStr(s: { kind: string; value?: string | number }): string {
  if (s.kind === 'key') return `.${s.value}`;
  if (s.kind === 'index') return `[${s.value}]`;
  if (s.kind === 'wildcard') return '[*]';
  return '..';
}

function name0(frames: Frame[]): string {
  return frames[frames.length - 1]?.name ?? '(空)';
}



function structuredCloneish<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// PathError 只从 jsonpath.ts 导出（index.ts 的星号导出会带上它），本模块只 import 使用。
