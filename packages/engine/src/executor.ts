/**
 * M0.6：`StepExecutor` 接口分离 —— 功能形态 vs 预编译形态（docs/09 §4.2）。
 *
 * 一句话动机：**压测必须整体绕开解释器**。否则测出来的天花板是我们自己的
 * 事件发射 + 证据落盘 + 表达式重复解析，不是被测系统的（docs/09 §4.2）。
 * 而在解释器里加 `if (perfMode)` 是这类系统最常见的腐化点：一条分支管两套语义，
 * 最后谁也不敢动。所以这里是**两个实现**，共用同一份求值/断言语义。
 *
 * 关键设计：**语义共用靠"调同一个函数"，不靠"两份写得很像的代码"**。
 * 值求值走 resolve.ts 的 resolveValue，断言走 assertions.ts 的 evalStructAssert，
 * 迭代/相等/展开语义也在 resolve.ts，变量空间直接用 vars.ts 的 VarSpace。
 * 本文件只负责**调度与预编译**，不复算任何判定 —— 一旦分叉，症状是
 * "功能回归全绿、压测报退化 25%"，能查三天，而且最后大概率归因成"后端偶发"。
 *
 * 剩下唯一没法共用的是**调度**（runChildren 是 async 的、带重试与事件，
 * 这里必须同步且无副作用）。所以那四条规则（onError / healed / skipped / 容器记账）
 * 在这里逐条抄写并在注释里指回解释器的出处，由 executor.test.ts 的等价性测试
 * 逐 stepId 对齐 —— **是测试在防分叉，不是"看起来一样"**。
 *
 * 本文件不 import node 内置模块（分层检查强制），所以它能进 Worker 也能进浏览器，
 * 这既是约束也是收益：预编译计划在 UI 里就能编译并给出 ops 预估。
 */
import type { Scenario, Step, StepStatus } from '@atest/ir';
import { compileExpr, truthy } from './expr.js';
import { evalStructAssert } from './assertions.js';
import { VarError, VarSpace, type InputDef, type VarSpace as VarSpaceT } from './vars.js';
import { PathError } from './jsonpath.js';
import { flattenTimes, looseEq, resolveValue, iterItems, type ValueScope } from './resolve.js';
import type { AdapterRegistry, Clock, ExecContext } from './adapters.js';

/** docs/09 §4.2 里那个接口。两种形态实现同一个形状。 */
export interface StepExecutor {
  readonly form: 'functional' | 'precompiled';
  run(input: ExecInput): Promise<ExecOutcome>;
}

export interface ExecInput {
  scenario: Scenario;
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  /** 每次调用的变量空间独立（压测的每个虚拟用户一份） */
  clock: Clock;
  adapters?: AdapterRegistry;
  signal?: { aborted: boolean };
}

/**
 * 两种形态共用的**最小结论形状**。
 * 刻意不含 events / artifactIds / costUsd / summary：预编译形态压根不产这些东西。
 * 把它们写进接口，实现者就会为了"接口完整"造出假事件 —— 那是把证据链做成样子。
 * 功能形态的完整报告是 interpreter 的 RunReport，别在这里替代它。
 */
export interface ExecOutcome {
  status: StepStatus;
  /** 逐步结论，**含容器节点自身**（解释器对每个被执行的步骤都记一条，容器不例外）。
   *  `error` 仅在 status==='error' 时有值：压测形态不产 evidence，但"哪一步坏了、为什么"
   *  必须留得下来，否则压测报告里的一堆 error 无从下手。 */
  steps: Array<{ stepId: string; status: StepStatus; healed: boolean; error?: string }>;
  outputs: Record<string, unknown>;
  /** 求值/结构问题（≠ 断言失败）。"用例跑不了"和"用例没过"必须能分开 */
  error?: string;
}

/** 不支持的步骤。抛出来而不是降级。 */
export class PrecompileRefused extends Error {
  constructor(message: string, public readonly stepId: string, public readonly kind: string) {
    super(message);
    this.name = 'PrecompileRefused';
  }
}

/** 计划上下文。一次迭代一份，压测里每个 VU 各一份。 */
export interface PlanContext {
  inputs?: Record<string, unknown>;
  /**
   * `scenario.inputs` 那一份**声明**（带 default）。由 compilePlan 在编译期闭包进来，
   * 不是每次迭代传：default 是场景的属性，不是某一次迭代的属性。
   * 预编译形态若漏了它，同一条用例在解释器里能靠 default 跑通、在压测形态里报
   * 「引用未定义」—— 那就是 M0.6 等价性判据要拦的那种分叉。
   */
  inputDefs?: readonly InputDef[];
  env?: Record<string, unknown>;
  clock: Clock;
  adapters?: AdapterRegistry;
  aborted?(): boolean;
}

/**
 * 预编译产物。一次编译、多次执行。
 *
 * 支持的是**纯计算 + 断言子集**：sequence / if / switch / forEach / while / repeat /
 * set / assert / wait{expr} / noop。其余一律 PrecompileRefused。
 *
 * **为什么拒绝而不是"跳过不支持的步骤"**：跳过的话压测跑的其实是另一条用例，
 * 而它会产出一份完整、好看、和真实负载无关的曲线。这是最难发现的故障类型。
 */
export interface PrecompiledPlan {
  readonly form: 'precompiled';
  /** 单次迭代的节点条数（循环体算一条）。压测前用它估每 VU 成本 */
  readonly ops: number;
  /** 计划引用到的外部表达式/引用，供"每迭代独立"的隔离检查 */
  readonly refs: string[];
  /** 被拒绝过的 kind 列表。空表示全量支持 */
  readonly refused: Array<{ stepId: string; kind: string; why: string }>;
  run(ctx: PlanContext): ExecOutcome;
}

/** 运行中被中止（signal.aborted）。与"求值报错"分开，前者不该记成 error。 */
class ExecAborted extends Error {}

// ── 预编译 ────────────────────────────────────────────────────────────────

/**
 * 编译后的节点。同步求值（压测的热路径不能有待机状态），返回本步裁决。
 * 注意**只记自己那一步的结论**：容器节点被覆盖成"先跑子树、再记自己"，
 * 顺序与解释器的 finish 一致（子步骤先入 results，父步骤后入）。
 */
interface FastNode {
  (st: FastState): StepStatus;
  /** 出错时的处理策略。调度按它决定是否继续，**必须在编译期固化**：
   *  运行时再查 step 对象，等于预编译形态还在读 IR —— 那 ops 预估就不准了 */
  onError: 'fail' | 'continue' | 'retry';
  id: string;
}

/** 未挂元信息的节点。compileCore 只产这个，由 compileStep 统一包装。 */
type RawNode = (st: FastState) => StepStatus;

const mk = (id: string, onError: 'fail' | 'continue' | 'retry', fn: RawNode): FastNode => {
  const n = ((st: FastState) => fn(st)) as FastNode;
  n.onError = onError;
  n.id = id;
  return n;
};

/**
 * 一次迭代的可变状态。
 * 变量空间**直接用 VarSpace**（就是解释器用的那个类），不是自己写一个 Map：
 * 引用解析、作用域、循环变量销毁，全部与解释器同源。
 * 这是"两条路径不分叉"的真正保证 —— 比"两份实现写得很像"强得多。
 */
class FastState {
  readonly vars: VarSpaceT;
  /** 与 ExecOutcome.steps 同一个类型：error 字段留给"哪一步坏了、为什么" */
  readonly steps: ExecOutcome['steps'] = [];
  private readonly scope: ValueScope;
  constructor(private readonly ctx: PlanContext) {
    this.vars = new VarSpace({ inputs: ctx.inputs, inputDefs: ctx.inputDefs, env: ctx.env });
    this.scope = { vars: this.vars, clock: ctx.clock };
  }
  aborted(): boolean {
    return this.ctx.aborted?.() ?? false;
  }
  resolve(v: unknown): unknown {
    return resolveValue(v, this.scope);
  }
  /** 表达式求值。root/vars/now 三件套的铺法与解释器逐字一致 */
  evalExpr(src: string): unknown {
    return compileExpr(src).eval({ root: this.vars.asExprRoot(), vars: this.vars.visible(), now: this.ctx.clock.now });
  }
  /**
   * 记一步结论并返回它。
   * `healed` 与 `status` 都带出去：解释器的 StepResult 里这两个字段**不是一回事**
   * （status 是六态之一，healed 是"这一步发生过自愈"的旗标，参与整段归约）。
   * 把 healed 折进 status 丢掉一个维度，等价性测试就没法比对它了。
   */
  add(s: Step | { id: string }, status: StepStatus): StepStatus {
    this.steps.push({ stepId: s.id, status, healed: status === 'healed' });
    return status;
  }
  /** 结构断言：直接调解释器用的同一个 evalStructAssert */
  assert(s: Step): StepStatus {
    const ctx: ExecContext = {
      target: 'api', runId: 'precompiled', env: this.ctx.env ?? {}, secret: () => '', clock: this.ctx.clock,
      // 预编译形态**不产证据**（这正是它快的那个原因）。
      // saveArtifact 直接抛而不是返回 ''：返回空串会让调用方以为存成功了，
      // 然后往 artifactIds 里塞一个空字符串 —— 静默的假证据。
      emit: () => {}, saveArtifact: async () => { throw new Error('预编译形态不产证据（压测热路径跳过证据落盘）'); }, capabilities: () => undefined,
    };
    const r = evalStructAssert(s as unknown as Parameters<typeof evalStructAssert>[0], {
      vars: this.vars, adapters: this.ctx.adapters ?? {}, ctx, clock: this.ctx.clock,
      addCost: () => {}, emit: () => {},
    });
    // 解释器对 assert 步骤还做一步 exportStep(s.id, { assertion: r })，
    // 让断言结果可被下游 `$steps.<id>.assertion` 引用。这里不导：
    // 预编译形态没有证据链，导了也查不到，不如不留一个"看起来能引用"的空壳。
    return this.add(s, r.status);
  }
}

/**
 * IR -> 预编译计划。
 * @throws PrecompileRefused 只要有任何一步不在支持子集内
 */
export function compilePlan(scenario: Scenario): PrecompiledPlan {
  const refused: Array<{ stepId: string; kind: string; why: string }> = [];
  const refs = new Set<string>();
  let ops = 0;

  const refuse = (s: Step, why: string): never => {
    // 记录后再抛：调用方可能想拿到"哪些步骤不支持"的清单（UI 要显示"这条用例
    // 不能压测，卡在这 3 步"），只抛异常那份信息就丢了。
    refused.push({ stepId: s.id, kind: s.kind, why });
    throw new PrecompileRefused(`预编译形态不支持步骤 "${s.id}"（kind=${s.kind}）：${why}`, s.id, s.kind);
  };

  const compileList = (steps: Step[]): FastNode[] => steps.map(compileStep);

  /** 包装成"跑完子树后替容器自己记一条"。解释器对每个被执行的步骤都记，容器不例外 */
  const asContainer = (id: string, inner: (st: FastState) => StepStatus): RawNode => (st) => st.add({ id }, inner(st));

  function compileStep(s: Step): FastNode {
    ops++;
    if (s.when) {
      const cond = s.when;
      const node = compileCore(s);
      // 守卫：条件不成立 → skipped。**不是 pass 也不是 fail**（docs/02 §6 状态机）。
      // 求值报错时解释器记 error，这里让它抛出 —— run() 顶层统一收敛成 error，
      // 但注意**不能吞成 skipped**：拼错的守卫条件伪装成"这步没跑"是最难查的假绿。
      // 守卫：条件不成立 -> skipped。**不是 pass 也不是 fail**（docs/02 §6 状态机）。
      // 求值报错**不在这里抓**：runSeq 的统一 catch 会记成"这一步 error"，
      // 与解释器 runStep 的外层 try/catch 完全同构。这里自己抓一遍会有两个坑：
      // 一是漏掉某种异常类型（我就是先漏了 ExprError），二是与外层重复记账。
      return mk(s.id, s.onError, (st) => {
        if (!truthyEval(st, cond)) { st.steps.push({ stepId: s.id, status: 'skipped', healed: false }); return 'skipped'; }
        return node(st);
      });
    }
    return mk(s.id, s.onError, compileCore(s));
  }

  function compileCore(s: Step): RawNode {
    switch (s.kind) {
      case 'set': {
        // 值解析仍走共享的 resolveValue（每次迭代），但**键名在编译期就固定成数组**，
        // 省掉解释器里每步的 Object.entries + 分配。真正的"表达式一次编译多次执行"
        // 要靠给 resolveValue 加编译期缓存层（见 resolve.ts 顶部注释），
        // 而不是在这里另写一套求值。
        const assigns = Object.entries(s.assign);
        return (st) => {
          for (const [k, v] of assigns) st.vars.setDeep(k, st.resolve(v));
          st.vars.exportStep(s.id, st.vars.visible());
          return st.add(s, 'pass');
        };
      }
      case 'assert':
        // 判定 100% 交给 evalStructAssert（与解释器同一个函数）。
        // 预编译在这里省的是：不再走 evaluateAssertions 的 kind 分发与 async 包装。
        return (st) => st.assert(s);
      case 'noop':
        return (st) => st.add(s, 'pass');
      case 'sequence': {
        const kids = compileList(s.steps);
        return asContainer(s.id, (st) => runSeq(kids, st));
      }
      case 'if': {
        const cond = s.condition;
        const then = compileList(s.then);
        const els = compileList(s.else);
        return asContainer(s.id, (st) => runSeq(truthyEval(st, cond) ? then : els, st));
      }
      case 'switch': {
        const valueSrc = s.value;
        refs.add(valueSrc);
        const cases = s.cases.map((c) => ({ is: c.is, nodes: compileList(c.steps) }));
        const def = compileList(s.default);
        return asContainer(s.id, (st) => {
          const v = st.evalExpr(valueSrc);
          for (const c of cases) if (looseEq(v, st.resolve(c.is))) return runSeq(c.nodes, st);
          return runSeq(def, st);
        });
      }
      case 'forEach': {
        const itemsSrc = s.items;
        refs.add(itemsSrc);
        const kids = compileList(s.steps);
        const as = s.as;
        const indexAs = s.indexAs;
        const cap = s.maxIterations;
        return asContainer(s.id, (st) => {
          const items = iterItems(st.evalExpr(itemsSrc));
          const n = Math.min(items.length, cap);
          for (let i = 0; i < n; i++) {
            const depth = st.vars.pushIteration(as, items[i], indexAs, i);
            const r = runSeq(kids, st);
            st.vars.popTo(depth); // 按深度回退，失败提前返回也不漏变量（同解释器）
            // 截断行为、以及 healed 继续迭代，都与解释器一致
            if (r !== 'pass' && r !== 'healed') return r;
          }
          // 同 while：空数据时循环体一行都没跑，两种形态都得在 results 里留痕
          if (n === 0) for (const k of s.steps) st.add(k, 'skipped');
          return 'pass';
        });
      }
      case 'while': {
        const cond = s.condition;
        refs.add(cond);
        const kids = compileList(s.steps);
        const cap = s.maxIterations;
        return asContainer(s.id, (st) => {
          let i = 0;
          while (i < cap) {
            if (st.aborted()) throw new ExecAborted();
            if (!truthyEval(st, cond)) break;
            // **每轮压一帧**（解释器 while 分支有 vars.push('while')）。
            // 漏掉的话循环体内 set 的临时变量会留在全局帧，跨轮次互相可见 ——
            // 于是"功能形态每轮干净、压测形态第二轮读到上一轮的残留"。
            const depth = st.vars.push('while');
            const r = runSeq(kids, st);
            st.vars.popTo(depth);
            if (r !== 'pass' && r !== 'healed') return r;
            i++;
          }
          // 顶到上限且条件仍为真 = 疑似死循环。解释器在这里发 LOOP_CEILING_HIT 事件；
          // 预编译形态没有事件通道，**但结论必须一致**，所以只判一致性、不改状态。
          //
          // 一次都没进循环时**必须补 skipped 行**，而且不能只照抄"发个事件"那条路：
          // 这个形态压根没有事件通道（`emit: () => {}`），所以"发事件"那种修法在这里
          // 天然是空的，分叉的表现就是"功能形态有提示、压测形态静默"。
          // 补行是两种形态**共用同一个载体**（results）的唯一做法，也才谈得上等价。
          if (i === 0) for (const k of s.steps) st.add(k, 'skipped');
          return 'pass';
        });
      }
      case 'repeat': {
        // 与解释器同一条路：展开成 times 份（id 加 #i）再跑
        const kids = compileList(flattenTimes(s.times, s.steps));
        return asContainer(s.id, (st) => runSeq(kids, st));
      }
      case 'wait': {
        const p = s.condition as Record<string, unknown>;
        if (typeof p.expr !== 'string') {
          throw refuse(s, `等待条件 type=${String(p.type ?? '?')} 需要 adapter（网络/设备）。压测里等一个外部条件等于在测自己的调度，请去掉这类等待`);
        }
        const src = p.expr;
        refs.add(src);
        const onTimeout = s.onTimeout;
        // **同步形态**：条件成立 → pass；不成立 → 直接按超时办（不空转轮询）。
        // 轮询是 async + clock.sleep，而热路径必须同步；且压测里"等一个外部条件"
        // 测的是我们自己的调度（上面拒绝外部等待条件的同一条理由）。
        // 前提：压测用的表达式谓词在负载下结果稳定（数据已预置），否则等价性不成立。
        //
        // onTimeout='error' 是 IR 的第三个合法取值（waits.ts:79）。早期版本只写了
        // fail/continue，于是"环境没就绪"会被判成"产品有 bug" ——
        // 值班人会被叫去查一个不存在的问题。三态都在这儿显式落地。
        return (st) => {
          if (truthyEval(st, src)) return st.add(s, 'pass');
          const status: StepStatus = onTimeout === 'continue' ? 'pass' : onTimeout === 'error' ? 'error' : 'fail';
          // continue 时解释器记的也是 pass（interpreter 的 wait 分支），保持一致
          return st.add(s, status);
        };
      }
      case 'http': case 'openapiCall':
        // 诚实说明为什么还没做：请求对象的构造目前长在解释器里
        // （interpreter 的 http 分支），要复用就得先把它抽成共享出口。
        // 那是 P7 的正题，不是 M0.6 的 —— 现在**拒绝**比写一份"看着能用"的假 HTTP 好。
        throw refuse(s, '请求对象构造尚未从解释器抽出共享出口（P7 的前置）。M0.6 只验证"表达式预编译"这个前提，不含真实施压');
      case 'extract':
        throw refuse(s, '提取与解释器共用实现（regex/ariaText/header 四种模式）。压测用例请用 inputs 传入这些值');
      case 'table': case 'dataSource':
        throw refuse(s, '数据源/数据表要产出多行并驱动迭代，与 forEach 的变量帧语义耦合，尚未支持');
      case 'sleep':
        throw refuse(s, '压测里的裸 sleep 测的是自己的调度而不是被测系统（lint 的 SLEEP_USED 同源理由）');
      case 'call':
        throw refuse(s, '子场景要重建变量空间与事件路径，预编译形态尚未支持');
      case 'parallel':
        throw refuse(s, '并发子步骤的变量写回串行化只在解释器里实现');
      case 'db': case 'script': case 'log': case 'fail':
        throw refuse(s, '有副作用或需要证据落盘');
      case 'assertLlm': case 'assertPage': case 'assertUi': case 'assertPerf':
        throw refuse(s, '需要 adapter。压测里塞 LLM/界面断言会把 LLM 延迟算进被测系统的 p95');
      case 'manualHandoff': case 'capture': case 'device': case 'app':
      case 'tap': case 'input': case 'swipe': case 'key': case 'watcher': case 'logcat':
      case 'navigate': case 'act': case 'useIdentity':
        throw refuse(s, '界面/设备/身份步骤，压测形态不适用');
    }
    // 走到这里说明加了新 kind 但忘了在上面分类。**默认拒绝**而不是默认支持：
    // 新 kinds 被静默当成可压测，等于压测报告悄悄漏掉了那几步。
    throw refuse(s, '未归类的 kind（executor.ts 的白名单没覆盖它）');
  }

  // **setup / teardown 也走同一道拒绝闸**。漏掉它们是典型的"半条路径被预编译"：
  // 主体是快的、前置是慢的，压测数字于是混合了两条路径，而报告上看不出来。
  // 现在拒绝（而不是悄悄不编译），P7 抽共享出口时一起放开。
  for (const s of [...scenario.setup, ...scenario.teardown]) {
    throw refuse(s, 'setup/teardown 尚未纳入预编译（前置失败的归约规则与主体不同：升级为 error）');
  }
  const body = compileList(scenario.body);
  const outputs = scenario.outputs.map((o) => ({ name: o.name, from: o.from }));

  return {
    form: 'precompiled',
    get ops() { return ops; },
    get refs() { return [...refs]; },
    refused,
    run(ctx: PlanContext): ExecOutcome {
      // default 在**编译期**从 scenario 闭包进来（见 PlanContext.inputDefs）
      const st = new FastState({ ...ctx, inputDefs: ctx.inputDefs ?? scenario.inputs });
      try {
        const r = runSeq(body, st);
        for (const o of outputs) {
          const v = st.vars.resolveRef(o.from);
          if (v.found) st.vars.setOutput(o.name, v.value);
        }
        // **整体状态由逐步结论归约**，公式抄自解释器末尾那段：
        // error > fail > healed > pass。直接用 runSeq 的返回值当整体状态是错的 ——
        // 那只看最后一段序列，前面某步的 error 会被后面一个 pass 盖掉，
        // 压测报告于是显示"全绿"，而里面藏着 N 条求值失败。
        return { status: reduceStatus(st.steps, r), steps: st.steps, outputs: st.vars.outputs };
      } catch (e) {
        if (e instanceof ExecAborted) {
          return { status: 'skipped', steps: st.steps, outputs: st.vars.outputs, error: '执行被中止（signal.aborted）' };
        }
        // 与解释器同一条分界：引用未定义/路径错误是 error（用例本身有问题），不是 fail
        if (e instanceof PathError || e instanceof VarError) {
          return { status: 'error', steps: st.steps, outputs: st.vars.outputs, error: e.message };
        }
        throw e;
      }
    },
  };
}

/**
 * 整体状态归约（与 interpreter 末尾同一优先级：error > fail > healed > pass）。
 *
 * **刻意没有"全 skipped 就整体 skipped"这一档** —— 我一开始加了它，直觉上很合理，
 * 但解释器没有，于是"守卫全不成立"的用例在功能形态是 pass、在压测形态是 skipped。
 * 而解释器不加它是有道理的（docs/02 §6）：整体状态回答的是"被测功能对不对"，
 * 一步没跑不等于功能不对 —— 它应该由 lint/覆盖率那条线暴露
 * （"这条用例一条都没跑还全绿"是覆盖率问题，不是红绿问题）。
 * 真要让 CI 拦住空跑的，是 gate 那一层的"用例执行数 == 声明数"检查，M6 落地。
 */
function reduceStatus(steps: Array<{ status: StepStatus; healed: boolean }>, seqResult: StepStatus): StepStatus {
  if (steps.some((s) => s.status === 'error')) return 'error';
  if (steps.some((s) => s.status === 'fail')) return 'fail';
  if (steps.some((s) => s.healed) || seqResult === 'healed') return 'healed';
  return 'pass';
}

/**
 * 序列调度 —— **必须是解释器 runChildren 的同一套规则**，四条都得对上：
 *
 *  1. `fail`/`error` 中断，但 **`onError:'continue'` 的那一步继续往下走**。
 *     漏掉这条的话，配了 continue 的能在功能形态里跑完 5 步、在压测形态里只跑 1 步，
 *     于是压测报告测的是另一条用例（且曲线照样好看）。
 *  2. 任一步 healed 则整段判 `healed`，**不算 pass**（docs/02 §6 六态机）。
 *  3. `skipped` 不中断、也不改整体结论。
 *  4. 容器节点自己也占一条结论记录，且**记在子步骤之后**
 *     （解释器的 finish 在 dispatch 返回后才 push）。顺序错位的话，
 *     等价性测试按 stepId 逐条对齐时会在嵌套用例上对不上 —— 而"少记/晚记"在功能上
 *     完全无害，最容易一路漏到线上。
 */
function runSeq(kids: FastNode[], st: FastState): StepStatus {
  let healed = false;
  for (const k of kids) {
    if (st.aborted()) throw new ExecAborted();
    let r: StepStatus;
    try {
      r = k(st);
    } catch (e) {
      if (e instanceof ExecAborted) throw e;
      // **任何**求值异常都收敛成"这一步 error 并留下记录"，对齐解释器 runStep 的 try/catch：
      // 它把 VarError / PathError / ExprError（语法错、未知函数）一律记成 error 状态。
      // 早先这里只抓前两种，于是 `when: '1 +'` 这类**表达式语法错**在预编译形态里
      // 直接抛出 run()：调用方拿到一个异常而不是一份结论，
      // 更糟的是**没有"哪一步坏了"这条记录** —— 压测里几千个 VU 同时炸，
      // 屏幕上只有一句 ExprError，谁也说不清是哪一步。
      if (e instanceof Error) {
        st.steps.push({ stepId: k.id, status: 'error', healed: false, error: e.message });
        r = 'error';
      } else throw e; // 非 Error 的抛出物不猜语义，继续上抛
    }
    if (r === 'fail' || r === 'error') {
      if (k.onError === 'continue') continue;
      // 'retry' 在解释器里由 withRetry 处理；预编译形态**刻意不重试**：
      // 压测里重试会把一次故障算成两次负载，吞吐曲线就假了。
      // 这也是两条路径的**已知且刻意**的差异，等价性测试里明确写出来，
      // 而不是假装两边一致 —— 悄悄不一致的注释比没有注释更坏。
      return r;
    }
    if (r === 'healed') healed = true;
  }
  return healed ? 'healed' : 'pass';
}

// 真值判定直接调 expr.js 的 truthy（经 evalBool 同一条路）—— 与解释器同一个函数。
// 自己写 `!!v && !isEmptyArray` 看着等价，但 truthy() 里对空串/0/null 的处理
// 只要有一处不同，两条路径就会在边界输入上分叉。
function truthyEval(st: FastState, src: string): boolean {
  return truthy(st.evalExpr(src));
}

// ── 功能形态：把解释器包成 StepExecutor ─────────────────────────────────────

/**
 * 功能形态 = 解释器。薄薄一层包装，**不复制任何逻辑**。
 * 存在它是为了让调用方能拿同一个 `StepExecutor` 类型切换两种形态，
 * 而不是到处 `if (form === ...)`。
 */
export function functionalExecutor(run: (input: ExecInput) => Promise<{ status: StepStatus; results: Array<{ stepId: string; status: StepStatus; healed?: boolean; assertionSummary?: string }>; outputs: Record<string, unknown> }>): StepExecutor {
  return {
    form: 'functional',
    async run(input) {
      const r = await run(input);
      return {
        status: r.status,
        // healed 旗标与 status 是两个维度（解释器的 StepResult 就是两个字段），这里都要带出来。
        // error 取 assertionSummary：**只用于"有没有错"的对比，不比对文案** ——
        // 两条路径的报错措辞本就该各自演化（一条面向人读、一条只要可定位），
        // 把文案写进等价性判据会让测试变成一个谁也不敢改的字符串快照。
        steps: r.results.map((x) => ({ stepId: x.stepId, status: x.status, healed: x.healed ?? x.status === 'healed', ...(x.status === 'error' ? { error: x.assertionSummary ?? '' } : {}) })),
        outputs: r.outputs,
      };
    },
  };
}

/** 预编译形态。编译失败（PrecompileRefused）在这里透传给调用方。 */
export function precompiledExecutor(plan: PrecompiledPlan): StepExecutor {
  return { form: 'precompiled', run: async (input) => plan.run({ inputs: input.inputs, env: input.env, clock: input.clock, adapters: input.adapters, aborted: () => input.signal?.aborted ?? false }) };
}
