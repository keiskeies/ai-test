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
import { CONTEXT_LIMITS, SECRET_PLACEHOLDER, redactForDisk } from './redact.js';

/** 单一策略在 redact.ts。这里只是**再导出**，不是又写一份 ——
 *  两份脱敏规则各自演化的后果见 redact.ts 顶部。 */
export { SECRET_PLACEHOLDER } from './redact.js';

export class VarError extends Error {
  constructor(message: string, public readonly varName: string) {
    super(`${message}（变量：${varName}）`);
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
 * 把 `scenario.inputs[].default` 兜进运行输入。
 *
 * **这行代码之前是不存在的**，后果不是"少一个便利功能"而是行为与声明相反：
 * IR 里写 `inputs:[{name:"q", default:"DEF"}]`，作者以为不传就是 DEF，
 * 实际得到的是 `引用未定义（变量：$q）`；而 UI 的表单按 IR 的 default 预填了值，
 * 于是**从 UI 跑能过、从 CI 跑必炸** —— 同一份 IR 两种行为，
 * 正是 docs/00 §6.6 里 Apifox GUI↔CLI 那类分裂的具体形态。
 *
 * 这是本仓反复出现的「schema 有字段、执行侧没人读」缺陷类的第 5 例
 * （前 4 例：maxCostUsdPerResolve、wait.onTimeout:'error'、assertPerf.maxRegressionRatio、
 * Match.unordered —— 见 docs/08 §3 的清扫方法）。
 *
 * 三条语义决定：
 *  1. **只有"根本没传这个键"才用 default**，`{q: undefined}` 也算传了。
 *     区分不出来就会出现"传 null 想清掉默认值，结果又被兜回 DEF"。
 *  2. default **不做类型校验**。IR 的 ParamDef.type 由 lint/解析期保证，
 *     运行期再校一遍是在信任边界内又建一道更弱的信任边界。
 *  3. default 与传入值**同放一层**（都在 run.inputs 下），不做"外层遮蔽内层"：
 *     二者不是两个来源的同名冲突，而是同一个输入的两个取值，
 *     分两层会让 `$.run.inputs` 的遍历结果出现重名键。
 */
export function applyInputDefaults(defs: readonly InputDef[] | undefined, given: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(given ?? {}) };
  if (!defs) return out;
  for (const d of defs) {
    if (!d || typeof d.name !== 'string') continue;
    if (!(d.name in out)) out[d.name] = d.default;
  }
  return out;
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

export class VarSpace {
  private frames: Frame[] = [{ name: 'global', vars: new Map() }];
  /** 步骤导出。$ref 引用 $.step.<id> 走这里，而不是普通变量 */
  private stepExports = new Map<string, Record<string, unknown>>();
  private runRoot: Record<string, unknown> = {};
  private envMap: Record<string, unknown> = {};
  /** 引擎解析密钥用；对 Agent 永不可见 */
  private secretResolver: ((ref: string) => string) | undefined;
  private writes: { name: string; frame: string; scopeId?: string }[] = [];
  private loopStack: unknown[] = [];

  /**
   * @param inputDefs `scenario.inputs`（声明带 default 的那一份）。传了就把 default 兜进去，
   *   见 {@link applyInputDefaults} —— 不传就等于声明了 default 也没人兜。
   */
  constructor(init: {
    inputs?: Record<string, unknown>;
    inputDefs?: readonly InputDef[];
    env?: Record<string, unknown>;
    secretResolver?: (ref: string) => string;
  } = {}) {
    this.runRoot = { inputs: applyInputDefaults(init.inputDefs, init.inputs), outputs: {} };
    this.envMap = init.env ?? {};
    this.secretResolver = init.secretResolver;
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
    const known = this.has(head) || head in this.inputs || head in this.envMap;
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
