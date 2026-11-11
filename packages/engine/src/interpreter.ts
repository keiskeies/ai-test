/**
 * 场景解释器（docs/02 + docs/01 §2）。
 *
 * 三条硬约束在本文件的体现：
 *  1. **不 import 任何 node 内置模块**（由 tooling/lint-layers.mjs 在 CI 强制）——
 *     所以时钟、网络、设备、存储全部从外部注入。这是「本地/CI/服务端/GUI 校验必然一致」
 *     的技术保证，也是 Postman↔Newman、Apifox GUI↔CLI 分叉的根因所在。
 *  2. **等待是条件不是时长**：wait 节点走 poll 循环；sleep 才用 clock.sleep。
 *  3. **状态语义**：环境问题 → error，断言不成立 → fail，自愈 → healed（不算绿），
 *     前置不满足 → skipped。红绿可信是平台被不弃用的前提。
 */
import type { Step, Scenario, Lease, ForEachStep, WhileStep, Retry, FlakyAttempt } from '@atest/ir';
import { countsTowardPassRate, FLAKY_OF_KEY, LEASE_REQUIRED, STEP_TARGET, parallelHazards, walk, hintOnTimeout, type StepResult, type StepStatus, type TraceEvent } from '@atest/ir';
import { compileExpr, evalBool, truthy } from './expr.js';
import { queryOne, query, PathError } from './jsonpath.js';
import { VarError, VarSpace } from './vars.js';
import { causeOfError, EnvMissing } from './errors.js';
import { TransportError, type AdapterRegistry, type Clock, type ExecContext, type ExecTarget, type ResolveResult } from './adapters.js';
import { evaluateAssertions } from './assertions.js';
import { resolveValue as resolveValueShared, strMap, iterItems, flattenTimes, looseEq, locatorGate, chargeResolve, LocatorBudgetError, type ValueScope } from './resolve.js';
import { waitUntil, NoConditionAdapter } from './wait.js';
import { ResponseLedger, ResponseWindow } from './responses.js';
import { CONTEXT_LIMITS, redactForDisk } from './redact.js';

export interface RunOptions {
  scenario: Scenario;
  /** 上层输入 */
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  envRevision?: number;
  secretResolver?: (ref: string) => string;
  adapters: AdapterRegistry;
  clock: Clock;
  runId?: string;
  /** 成本上限（美元）。超出即中断并落盘证据，不是事后台账（docs/03 §2） */
  maxCostUsd?: number;
  signal?: { aborted: boolean };
  /**
   * 已经在调用链上的场景 id（**由 call 分支自己维护并往下传**，调用方不用填）。
   *
   * 存在的全部理由：`call` 成环时**什么都不会发生**。实测 A→B→A：
   * 每一层都在 `await` 下一层，所以既不会栈溢出、也不会超时，进程只是永远转下去
   * —— CI 表现为"这条用例卡住一小时后被 kill"，本地表现为"run 不返回"。
   *
   * lint 里的 `DEPENDENCY_CYCLE` 挡不住它：那条规则要 `ctx.scenarioGraph`，
   * 而**没有任何调用方填过这个字段**（只有 lint 自己的测试在用）。
   * 也就是说它是"看着有一道闸、实际闸没接线"的又一个实例。运行期这道闸不依赖
   * 谁先跑过 lint，也不依赖文件系统里有没有整张依赖图（resolver 只解析得到
   * 它被问到的那几个 ref）。
   *
   * 按**场景 id** 判而不是按 ref 判：`A@1 → B@1 → A@2` 也是环
   * （版本不同不代表不再互相调用），按 ref 判会漏这一条。
   */
  callStack?: string[];
  /**
   * 页面内响应的观测账（见文件内 responseLedger 那条与 responses.ts 的 ResponseLedger）。
   *
   * **调用方一般不用填**：只有 `call` 分支需要把父 run 的账传进子场景，
   * 因为页面内的响应流是**同一个流**（同一个浏览器会话），而子场景默认从 0 起账
   * 会把"父在前面步骤发过的接口"算成子里的命中 => 假绿。
   * 不传就是新账，这对独立运行（CLI 一次一个场景）是正确的。
   */
  responseLedger?: ResponseLedger;
}

/**
 * 一次 `call` 实际跑了什么。
 *
 * 为什么要把这个单独记出来，而不是"把子结果并进 results"就算完：
 * 门禁判"哪些 assertLlm 是 report-only"靠的是**读 IR 里的 gatePolicy**，
 * 而子场景的 IR **不在父场景的 IR 里**（它是 CallResolver 在运行时解析出来的）。
 * 于是只把子结果并进 results 会重新打开一个已经修掉的假绿：
 * 子场景里只有一条 report-only 的 assertLlm、模型盖了个章 => 门禁把它当成阻断性结论 => CI 绿。
 * 光有 results 判不出来（report-only 的 assertLlm 判"是"时 status 就是 pass），
 * **必须把"跑的是哪份 IR"一起带出来**。
 *
 * `scenario` 存的是解析后的那份子 IR —— 不是引用字符串，因为"引用哪个 id"回答不了
 * "它当时声明的 gatePolicy 是什么"。
 */
export interface ChildRun {
  /** 发起这次调用的 call 步骤 id（父侧的坐标，用于把话说清是哪一步） */
  callStepId: string;
  ref: string;
  scenario: Scenario;
  /** 子场景**自己**那份报告里的 results（stepId 是子场景内的原始 id，不加前缀） */
  results: StepResult[];
  /*
   * 下面四项来自**子场景自己的 RunReport**（call 分支手里正好握着 `rep`，
   * 存的是它当时的原值，不是父侧从 results 反推的第二手数据）。
   *
   * **为什么要把这些抄进 ChildRun**：证据清单（EvidenceManifest.children）要给
   * 机器消费者"这次 run 跑了哪几个子场景、各自几个 pass/fail"。
   * 反推有两条死路：tally 能从 results 数出来，但**数不出 resultBoundary** ——
   * teardown 的步骤会被算进子场景的通过率分母，而子场景自己明确不把 teardown
   * 计入整体状态（interpreter 里 gate 那段）；两个"看起来等价"的算法迟早分叉。
   * status 更是反推不出来：`setupBroke`（前置崩了升级成 error）这件事
   * 只存在于子 run 的过程里，光看 results 只能得到"有一步 error"。
   */
  status: StepStatus;
  tally: RunReport['tally'];
  costUsd: number;
  durMs: number;
  /**
   * **在哪个场景的 body 里**被调起的（父场景 id，不是 ref）。
   *
   * childRuns 是扁平的（A→B→C 时 B、C 都在 A 的列表里），没有这根链就
   * **重建不出调用树** —— 而扁平与树形各有所需：门禁要扁平（不递归就能看全
   * "整棵树有没有真断言"），证据消费者要能回答"C 是谁叫起来的"。
   * 存 id 而不是存整个父 IR：children 列表里每个场景自己就带着 IR，
   * 一根引用就够拼回去了。
   */
  calledById: string;
}

export interface RunReport {
  runId: string;
  status: StepStatus;
  startedAt: number;
  durMs: number;
  results: StepResult[];
  /**
   * 本场景（含任意深度）通过 `call` 跑过的每个子场景。**扁平**：
   * 孙子层的 run 也在这一层里，每条带着它**自己的** IR 与 results。
   * 扁平是为了让门禁不必递归就能看全"整棵调用树里有没有一条真断言"；
   * 深层嵌套（A→B→C，断言全在 C）如果只记直接子层，就会被判成"空场景"而误拦。
   *
   * **可选**：`undefined` = "这份报告没记这件事"（手写 fixture、旧调用方），
   * 与 `[]`（记了，且确实一个 call 都没跑）必须可区分 ——
   * 前者门禁只能保留旧的宽容，后者可以照实判"没验任何东西"。
   */
  childRuns?: ChildRun[];
  /** 追加式事件流。真实运行时同时进 Redis Stream 与 trace.jsonl */
  events: TraceEvent[];
  outputs: Record<string, unknown>;
  costUsd: number;
  /** 通过率计算所需的分桶（healed 计入分母不计入分子，docs/12/13） */
  tally: { pass: number; fail: number; error: number; healed: number; skipped: number; triaged: number };
  /**
   * **这次运行是被中断的**（外部取消 / 运行超时 / 成本熔断），带原因。
   *
   * **为什么需要这个字段**（它以前不存在）：中断时 `status` 是 `pass`。
   * 三个来源都从 `checkAbort`/`addCost` 抛 `RunAborted`，被 run 的 catch 收成
   * 一条 `error` 事件（`data.aborted === true`）然后**照常走完汇总**，
   * 于是"跑到第 2 步被人按了 Ctrl-C"与"10 步全过"在 `status`、退出码、
   * JUnit 计数、summary 文本上是同一个形状：
   *
   * ```
   * results = seed:pass,a1:pass,s:pass   status = pass   EXIT = 0
   * reasons = ["1 条断言全部通过"]
   * ```
   *
   * 而 `EXIT.ABORTED = 10` 早就写在退出码表里、`CI_HINT` 里也印着"10 被中断"，
   * 全仓**没有一个生产者**（`grep ABORTED` 只有定义与 WORSE_ORDER 排序）。
   * 这是 docs/14 §4.3 子类 **(c)「读了、也判了，但没有生产者」**换到**对外 API**
   * 这一层上的复现：以前是"IR 字段有、引擎判了、adapter 不报数"，这里是"码表有名额、
   * 门禁判了、执行侧没人返回"。**同一子类、不同表面，所以不另立编号**（理由见 §4.3 表下那段）。
   *
   * **为什么不改 `status`**：StepStatus 是六态，被中断的 run 里那几步的结论
   * 各自仍然成立（它们真的过了）。把整体状态改成 error/skipped 会伪装成
   * "某一步坏了"，而真实情况是"这份报告是不完整的"。所以这是一个**关于报告**
   * 的字段，不是关于某一步的状态。
   *
   * **可选**（`undefined` = 这份报告没记这件事）与 `childRuns` 同一条理由：
   * 手写 fixture 与别的引擎实现要给"我不知道"留出位置，
   * 门禁对"记了且没中断"与"压根没记"的处置不同。
   */
  aborted?: { kind: AbortKind; reason: string };
  /** 人类可读摘要，报告与 CI 评论用 */
  summary: string;
}

/**
 * 「故意发不合法请求」的策略（docs/05 §3）。请求侧 schema 校验对它们**只记事件不拦**：
 * 这些用例的全部价值就在于看后端拒不拒绝一个坏请求。
 *  - boundary 算：边界外那一半本来就越界。
 *  - authMatrix **不算**：它发的是合法 body，只是 token 不对 —— 请求体校验照样该做。
 *  - notFound 不算：不存在的 id 仍是合法字符串。
 */
const NEGATIVE_STRATEGIES = new Set(['requiredMissing', 'typeViolation', 'negativeFuzz', 'boundary']);

/**
 * 被中断（外部取消 / 运行超时 / 成本熔断）。
 *
 * `kind` 是给门禁与人看的**分类**，不是给人读的句子（那在 `message` 里）。
 * 三个来源必须分开：值班人对这三件事的动作毫无重叠 ——
 *  取消 → 有人主动停的，一般不用管；
 *  超时 → 用例跑太久，要查是环境慢还是 `timeoutMs` 定小了；
 *  成本 → 熔断生效，要查是哪一步在花钱（多半是视觉兜底）。
 * 只有一个 `aborted: true` 布尔的话，这三种在报表里是同一行，
 * 而 docs/08 那份失败看板要按原因分组 —— 同一种原因被写成一个桶就是没有信息。
 */
export type AbortKind = 'cancelled' | 'timeout' | 'cost';

class RunAborted extends Error {
  constructor(readonly kind: AbortKind, message: string) {
    super(message);
  }
}
/* EnvMissing 搬去 errors.ts 了：它原先是本文件的私有类，于是外层那个
 * "按异常类型定归因"的判据**看不见它**（跨不到模块私有），只能靠 errSummary 认它，
 * 归因则一路落到兜底那格。搬过去挂上 NotWiredError 之后，"环境里没配 baseUrl"
 * 与"没接 device adapter"才得到同一个归因 —— 它们的下一步动作本来就是同一个。 */

/**
 * 事件入参：kind 必须是 TraceEvent['kind'] 字面量。
 * 用 string 会把事件流变成垃圾场 —— 报表和 trace 查看器都靠这套枚举。
 */
type EmitIn = {
  kind: TraceEvent['kind'];
  stepId?: string;
  status?: TraceEvent['status'];
  runStatus?: TraceEvent['runStatus'];
  durMs?: number;
  cause?: TraceEvent['cause'];
  data?: Record<string, unknown>;
  path?: string[];
};

/** 步骤级执行上下文。租约继承走这里，不用全局状态。 */
interface StepCtx {
  watchers: { rules: { match: Record<string, string | undefined>; action: string; maxTimes: number; hit: number }[] }[];
}

/**
 * 一个**租约槽位** = "当前这一层作用域手上那台设备" + "这台是不是我申请的"。
 *
 * ## 为什么要有这个类型（它不是把 `stepCtx.lease` 换个名字）
 *
 * 租约原本挂在 `runScenario` 的闭包变量上，而 `runStep` / `runChildren` 都是那个作用域里的
 * **闭包** —— 所以 `parallel` 的分支虽然看起来"各跑各的"（调用点
 * `runStep(c, path, branch, branchWindow)` 里确实没有 stepCtx 形参），实际**共享同一个租约槽**。
 * 共享本身是对的（一个场景一台设备，分支不该各占一台），但它让"第二个 device 步先还前一个"
 * 那条修法在并发下失效：两支各带一个 `device` 时，两个 device 步都看到"手上已有租约"，
 * 于是**各自去还同一个 id，而自己新拿的那台谁都不还**。实测：`lease 2 次 / release 1 次`，
 * 收尾手上还攥着一台真机，而报告是 `p:pass`、整场 pass。
 *
 * ## 为什么要 `owns` 这个位（不共享的话就不用问这个问题）
 *
 * 槽位可以是**上层传下来**的（`parallel` 给分支预置外层那台）。借来的租约**不该由借方释放**：
 * 否则一支分支跑完就把父场景正在用的设备还回池子，父后面所有设备步骤跑在一台已被别人
 * 领走的机器上，而报告的证据与结论看起来连贯。所以分支槽位继承租约时 `owns: false`，
 * 分支里那个 `device` 步新申请的才是 `owns: true`。
 *
 * ## 为什么是一个布尔而不是 `Set<Lease>`（我第一版写的就是 Set，理由是假的）
 *
 * 我原先写 `own: Set<Lease>`，注释说"同一层申请过多台时布尔会说谎"。**不会**：
 * 释放判据只问"**当前**这个租约是不是我申请的"，而"当前"永远只有一个对象 ——
 * 第二个 device 步把旧的还掉、换上新的之后，新的确实是自己申请的，布尔照样为真。
 * Set 还额外制造了一个坑：续租那一步会把租约**重建**成
 * `{ ...lease, expiresAt }`（见 runStep 里续租那段），对象身份变了而 id 没变，
 * 存对象的 Set 在续租之后就查不回当前租约了 —— 得额外写一行 delete/add 去喂它，
 * 而那一行的存在本身就是"这个数据结构选错了"的信号。**换成布尔之后那行没了。**
 */
interface LeaseSlot {
  lease?: Lease;
  /** 当前这个租约是本槽位**自己申请**的（true）还是上层借来的（false）。借来的不还 */
  owns: boolean;
}

/** 开一个新槽位。`from` 是上层传下来的那台（借来的，所以 `owns: false`） */
const newLeaseSlot = (from?: Lease): LeaseSlot => ({ lease: from, owns: false });

export async function runScenario(opts: RunOptions): Promise<RunReport> {
  const { scenario, adapters, clock } = opts;
  const runId = opts.runId ?? `run_${clock.now().toString(36)}`;
  // inputDefs 传 scenario.inputs：声明了 default 的输入要能被兜住，
  // 否则 IR 里的 default 是个没人读字段（详见 vars.ts 的 applyInputDefaults）
  const rootVars = new VarSpace({ inputs: opts.inputs, inputDefs: scenario.inputs, env: opts.env, secretResolver: opts.secretResolver });
  const events: TraceEvent[] = [];
  const results: StepResult[] = [];
  /**
   * 本场景通过 `call` 跑过的子场景（**含任意深度**，见 RunReport.childRuns）。
   * 与 addCost 同一套做法：它是 runScenario 作用域里的闭包，dispatch 的 call 分支
   * 直接往这里记，不需要把参数一路透传下去 —— 透传版的漏传是本仓那个
   * 「字段在 IR 里、注释讲得很对、执行侧没人接」缺陷类的又一个入口。
   */
  const childRuns: ChildRun[] = [];
  /**
   * 本次运行的调用链，**含自己**（见 RunOptions.callStack）。
   * 根运行就是 `[scenario.id]`；子场景拿到 `[...父链, 子的 id]`。
   * 含自己是让"场景 call 自身"与"A→B→A"共用同一条判据，不用各写一遍。
   */
  const callStack = opts.callStack?.length ? opts.callStack : [scenario.id];
  let seq = 0;
  let costUsd = 0;
  const maxCost = opts.maxCostUsd ?? scenario.config.maxCostUsd;
  const startedAt = clock.now();
  const t0 = clock.mono();

  const emit = (e: EmitIn): void => {
    const ev: TraceEvent = { seq: seq++, ts: new Date(clock.now()).toISOString(), mono: clock.mono(), path: [], data: {}, ...e };
    events.push(ev);
  };

  /**
   * 当前身份（docs/05 §2 的"多租户/多身份"）。
   *
   * 语义是"**从这一步起，同一序列里后续的步骤都用它**"（与 SQL 的 SET 一样是语句，
   * 不是块），所以它是一个会被改的值，而不是靠路径算出来的作用域。
   *
   * 两条防串的规定：
   *  1. **容器退出时复位**（见 runChildren 的 finally）：`forEach` 里某次迭代切了身份，
   *     不该把后续迭代一起带跑 —— 那会让"第 3 次迭代用了第 2 次的身份"这种结果
   *     完全依赖执行顺序，而顺序是不可见的。
   *  2. **parallel 的分支里禁止切身份**（见 case 'parallel'）：分支共享同一个变量，
   *     交错执行下"谁先切"决定后面看到谁 —— 而权限矩阵用例（A 的资源 B 读不到）
   *     要的恰恰是隔离，串了会**双双通过**。宁可当场报错，也不给一个随并发度变的答案。
   */
  let currentIdentity: string | undefined = scenario.identity;

  /**
   * 这批步骤里（含任意深度）有没有 useIdentity。
   *
   * 必须在**进入并行之前**静态判定，不能"运行时发现有人改了身份就报错"：
   * 交错执行下报错与否取决于调度顺序，而一个随并发度出现的 error
   * 会被当成 flaky 重试掉，正好把要防的东西藏起来。
   */
  const containsIdentitySwitch = (steps: Step[]): boolean => {
    let hit = false;
    walk(steps, (s) => { if (s.kind === 'useIdentity') hit = true; });
    return hit;
  };

  /**
   * 这一步该用哪个身份。**只有这一处公式**，http 与 openapiCall 共用。
   *
   * 为什么要有这个函数：两个入口原先各写一份，各错一处 ——
   *  - openapiCall 算出了 authIntent 却没塞进 send()（**算了不用**）；
   *  - http 读的是 `scenario.identity`（场景级静态值）而不是 currentIdentity，
   *    于是 useIdentity 切完之后它还是拿开头的身份 ——
   *    "切换身份"那一步自己变绿了，后面的请求一个都没变。
   * 两处都是本仓那个老毛病：字段在 IR 里、注释把它讲得很对、执行侧没人接。
   * 合成一处之后，"两个入口对同一件事各写一份、其中一份写错"不再可表达。
   *
   * 步骤上的 identity 优先于场景级：权限矩阵用例常在 forEach 里切，
   * 而整个场景也可能声明一个默认身份。
   */
  const identityFor = (stepIdentity: string | undefined): string | undefined => stepIdentity ?? currentIdentity;

  const ctxBase = {
    runId,
    env: opts.env ?? {},
    secret: (ref: string) => opts.secretResolver?.(ref) ?? `«unresolved:${ref}»`,
    clock,
    emit: (e: EmitIn) => emit({ kind: e.kind as TraceEvent['kind'], stepId: e.stepId, durMs: e.durMs, data: e.data }),
    saveArtifact: async (kind: string, data: Uint8Array | string, stepId: string) => {
      // id **由存储侧算，引擎不自己编**。
      // 早先这里是 `art_${shaish(...).slice(0,12)}_${kind}` —— shaish 是把 32 位 FNV-1a
      // 重复四遍拼成 64 个十六进制字符的**伪 sha256**，看着像、实际只有 2^32 的空间。
      // 更糟的是它**压根没存任何东西**就返回了一个 id：StepResult.artifactIds 里
      // 躺着一串永远取不到内容的哈希，而 evidence 包看起来是完整的。
      // 内容寻址的"址"必须由真正落地的那一方给出，否则引擎与存储各自算一遍，
      // 迟早算出两个不同的值（一边按 UTF-16 码元哈希、一边按 UTF-8 字节哈希）。
      if (!adapters.artifactStore) {
        // **拒绝而不是给个假 id**。返回 id 的话 StepResult.artifactIds 里会躺着一串
        // 取不到内容的哈希，evidence 包看起来完整、实际是空的 —— 而空证据包在
        // 三天后的排查里表现为"平台没存东西"，没人会想到是存储没接。
        throw new EnvMissing(`未配置证据存储（adapters.artifactStore 缺失），无法为步骤 "${stepId}" 保存 ${kind} 证据`);
      }
      const id = await adapters.artifactStore.save(kind, data, stepId);
      emit({ kind: 'artifact.saved', stepId, data: { id, kind, bytes: typeof data === 'string' ? byteLen(data) : data.byteLength } });
      return id;
    },
    capabilities: (t: string) => adapters.capabilities?.(t),
  };

  /**
   * 给 adapter 的执行上下文。`stepId` 是**后加的**：见 adapters.ts 里 ExecContext.stepId
   * 那条注释（adapter 自己编步骤 id 会把证据记到错误的步骤名下）。
   * 传不传是**逐调用点决定**的，不是统一塞一个：
   *  - 步骤内调用 => 传 s.id；
   *  - runWatchers（步骤之间跑，不属于任何步骤）=> 传 'watcher'，与它 emit 时用的同一个合成坐标；
   *  - run 结束时的租约释放 => 不传（那一刻真没有步骤，编一个就是撒谎）。
   */
  const execCtx = (target: ExecContext['target'], stepId?: string): ExecContext => ({ ...ctxBase, target, stepId });

  /**
   * 自动证据（响应体等）的落盘入口。没配存储时**记事件并跳过**，
   * 与 ctxBase.saveArtifact（用例显式要求，没存储就抛）的区别见 makeAutoEvidence。
   */
  const autoEvidence = makeAutoEvidence({
    hasStore: Boolean(adapters.artifactStore),
    emit,
    artifactIdFor: (kind, data, stepId) => ctxBase.saveArtifact(kind, data, stepId),
  });

  /** 成本熔断。超出即中断 run —— 静默跳过会让预算形同虚设 */
  const addCost = (n: number): void => {
    costUsd += n;
    // 单位跟着字段名走（maxCostUsd → 美元）。写了 ¥ 的话，人会把 docs/03 里按美元定的
    // 预算数直接填进来，熔断阈值当场差一个汇率
    if (costUsd > maxCost) throw new RunAborted('cost', `成本上限超出：$${costUsd.toFixed(4)} > $${maxCost.toFixed(4)}，已中断`);
  };

  const stepCtx: StepCtx = { watchers: [] };
  /**
   * 这一**层运行**（一个场景 = 一层 `call`）自己的租约槽。setup / body / teardown
   * 三段都跑在它上面，所以外层 setup 里申请的租约在 body 里可见 —— 那是既有行为。
   *
   * 只有 `parallel` 的分支会从**某一层槽位**派生新槽位（见 `case 'parallel'` 那段），
   * 而那里派生的祖先是"当前这一层的 slot"，不必然是本槽 —— 嵌套 parallel 时两者不同。
   */
  const runSlot = newLeaseSlot();

  /**
   * **清理阶段暂停中断判定**。只在"运行已经被打断、现在是在收尾"时置真，见 finally 里那段。
   *
   * 为什么必须暂停而不是直接跑 teardown：`checkAbort` 是**每一步开头**读的，
   * 而打断的条件在清理期间**仍然成立** ——
   *  · `signal.aborted` 还是 true（人按的那一下不会自己复位）；
   *  · `clock.mono() - t0 > timeoutMs` 还是成立（时间只会更远）；
   *  · 成本已经超了（超了就是超了）。
   * 所以不暂停的话，teardown 的**第一步**就再抛一次 RunAborted，清理一条也跑不完 ——
   * 那正是本轮实测到的旧行为（`teardown 跑了吗 = false`）。
   *
   * 暂停的范围是**这一道闸**，不是"清理期间不会失败"：
   *  · `addCost` 的熔断照抛（清理不该把钱再花一遍，那正是预算存在的理由）；
   *  · 每一步/adapter 自己的超时照用（http client 有自己的 AbortController），
   *    所以"清理挂死"是有界的，不会因为我们暂停了 run 级超时就没界；
   *  · CLI 侧第二次同名信号会直接终止进程（signals.ts），人永远有逃生门。
   */
  let cleanupPhase = false;

  const checkAbort = (): void => {
    if (cleanupPhase) return;
    if (opts.signal?.aborted) throw new RunAborted('cancelled', '外部取消');
    if (clock.mono() - t0 > scenario.config.timeoutMs) throw new RunAborted('timeout', `运行超时（${scenario.config.timeoutMs}ms）`);
  };

  /** 守望规则执行（docs/00 §5.5）：在步骤之间弹掉干扰弹窗，容器级生效 */
  const runWatchers = async (slot: LeaseSlot): Promise<void> => {
    if (!stepCtx.watchers.length || !adapters.device) return;
    /*
     * **端从这一层的槽位读，不写死 `'android'`**（本轮改；探针
     * `.scratch/probe-watcher.mts`；永久落点是 `adapter-contract.test.ts` 里
     * 「守望按**这一层租约的端**点屏幕」与「守望读**申请那台的那一层**」两条）。
     * 原先这两处写死，而守望点的是**真机**：
     * ios 场景里一次 run 报出两个端 ——
     *   snapshot@android、perform@android，而紧挨着的那一步 tap 是 perform@ios。
     * 与 §3.1 里 `release` 写死 `'android'` 是同一个根（运行时的端从步骤种类
     * 现推 / 干脆写死，而不是从租约读），而这两处比 release 更糟：release 只在
     * 收尾出现一次，守望是**每步之后**都跑，等于每一轮都按错误的端去点一次屏幕。
     *
     * 为什么这一处以前从未暴露：`adapter-web` 与 `adapter-http` 都不读 `ctx.target`，
     * 而 ADB adapter 还没写（docs/14）。所以这是个确实存在、还没有消费者的坏值 ——
     * "没人读"从来不能推出"值是对的"（同一句话见 adapters.ts 的 ExecTarget）。
     *
     * 端取**这一层**的槽位而不是 runSlot：守望跟着触发它的那一步走，
     * 与 §3.3 那个嵌套 parallel 的教训同一条 —— 祖先那一层不等于这一层。
     * 没有租约时是 `'any'`（守望规则在 device 步之前注册、但可能先于任何租约跑）。
     */
    const target = platformOf(slot);
    for (const w of stepCtx.watchers) {
      for (const rule of w.rules) {
        if (rule.hit >= rule.maxTimes) continue;
        const snap = await adapters.device.snapshot(execCtx(target, 'watcher'));
        const hit = matchesHierarchy(snap.data, rule.match);
        if (!hit) continue;
        rule.hit++;
        emit({ kind: 'step.finished', stepId: 'watcher', status: 'pass', data: { action: rule.action, matched: hit, hitCount: rule.hit } });
        if (rule.action === 'click' && hit) {
          await adapters.device.perform({ op: 'click' }, { handle: hit, resolvedBy: 'watcher', rung: 1, confidence: 1, nonReplayable: false }, execCtx(target, 'watcher'));
        }
      }
    }
  };

  /**
   * 页面内响应的观测账（引擎侧）。见 `responses.ts` 的 `ResponseLedger`：
   * 它存在的唯一理由是"开窗起点不能是会话开头"，否则上一步发过的接口
   * 会让下一步的 `wait{response}` 立刻假绿。
   *
   * `opts.responseLedger` 让**子场景与父场景共用同一本账**（call 分支透传）。
   * 不给的话子场景从 0 起账，而流是同一个流 —— 于是"父场景第 2 步发过的接口"
   * 在子场景里算命中，正是那个假绿换了个地方活着。
   */
  const responseLedger = opts.responseLedger ?? new ResponseLedger();

  /**
   * 给一步造观测窗口。**在 runStep 的调用方造、以入参往下传**，两件事各有理由：
   *
   *  - 起点取"本步开始时"而不是"会话开头"：上一步发过的接口不该让本步的等待假绿。
   *  - **在 withRetry 之外造**：一次重试的多次尝试必须共用一个窗口。
   *    每次尝试各开一个的话，第一次尝试读到的条目会被账位划到窗口之外，
   *    于是 `wait{allOf[接口A, 接口B]}` 第一次拿到 A 没拿到 B => 重试 =>
   *    **第二次连 A 也看不见了** => 配了重试反而更难过。
   *  - **不放在闭包变量里**：`parallel` 的分支各自跑自己的步骤，共享一个闭包变量的话
   *    后进的那支会覆盖先进的那支的起点，A 支的等待会拿到 B 支的窗口起点。
   *    做成入参之后"忘了传"是编译错误，而不是又一条静默的分叉。
   */
  const newResponseWindow = (): ResponseWindow =>
    new ResponseWindow(responseLedger.snapshot(), (cursorAfter) => responseLedger.observe(cursorAfter));

  /** 单个步骤的执行。返回 StepResult，异常一律在此收敛成 error 状态。 */
  const runStep = async (s: Step, path: string[], vars: VarSpace, window: ResponseWindow, slot: LeaseSlot): Promise<StepResult> => {
    checkAbort();
    for (const w of stepCtx.watchers) void w;
    const stepStart = clock.mono();
    emit({ kind: 'step.started', stepId: s.id, path });

    /*
     * 守卫：条件不成立 → skipped（不是 pass，也不是 fail）。
     *
     * **求值报错绝不能落到"条件不成立"那一格**。改动前这句 catch 是
     * `catch (e) { … cause: 'env-unavailable' }` —— 归因写死了，但更糟的是
     * 它上面那句 `let ok = false`：`evalBool` 里**不抛异常、只返回 undefined**
     * 的写法照样把 `ok` 留在 false，于是步骤记成 `skipped`。实测（`.scratch/probe-guard-green.mts`，
     * 永久落点是 `docs/14` §5「`when` 守卫里的假绿」那一行 —— 这件事**至今没修**，
     * 所以没有测试钉它，钉了就等于宣称它修好了）：
     *  `when: '$.n['`（下标没闭合）=> 这步 **skipped**、整场 **pass**、退出码相关
     *  的 tally 是 `{pass:1, skipped:1}`、**lint 一句没响**。
     * 一句写坏的路径读起来像"条件不成立、这步不该跑"，而 `executor.ts` 里
     * 那句注释恰恰写着"拼错的守卫条件伪装成'这步没跑'是最难查的假绿" ——
     * 它说预编译形态刻意不在这里抓、让外层记 error，**实测两种形态都是 skipped**，
     * 那个防护并不存在（两种形态都从 `expr.ts` 的 `catch { return undefined }` 拿到 undefined）。
     *
     * ⚠ **"lint 没响"只对 `$.` 路径这一族成立，别读成"lint 不查表达式"**：
     * 同一位子上 `when: '1 +'` 是**有** lint 的（`EXPR_SYNTAX` 实测报"意外记号 末尾"）。
     * 差别在 `validateExpr` 只遍历 AST 查未知函数名，**`$.` 引用节点从不校验路径本体**，
     * 而它 catch 里那句 `e instanceof PathError` 是永远为假的一支（parse 不解析路径内部）。
     * 所以那条假绿**有两层**（运行期那个吞 + 静态闸这一层），只修运行期的话
     * 运行时会红而 lint 照旧静默 —— 两层都要修，明细与实测在 docs/14 §5 那一行。
     *
     * 那条假绿本轮**没修**（要改的是表达式引擎那个吞异常的地方，另记 docs/14 §5），
     * 这里只把"真抛出来的那部分"归对因：`when: '1 +'` 与 `when: 'nopefn(1)'`
     * 报 case-stale，落点是 `packages/engine/test/error-cause.test.ts`。
     */
    if (s.when) {
      let ok = false;
      try { ok = evalBool(s.when, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now }); }
      catch (e) { return finish(s, path, 'error', stepStart, errSummary(e), { cause: causeOfError(e) }); }
      if (!ok) return finish(s, path, 'skipped', stepStart, `守卫条件不成立：${s.when}`);
    }

    // 租约：需要设备的步骤若上下文无租约 → error（RESOURCE_LEASE_MISSING 应在 lint 阶段就拦住）
    if (LEASE_REQUIRED.includes(s.kind) && !slot.lease && s.kind !== 'manualHandoff') {
      if (!adapters.device) return finish(s, path, 'error', stepStart, '设备执行器未注册（device adapter 缺失）', { cause: 'env-unavailable' });
      return finish(s, path, 'error', stepStart, '执行设备步骤前缺少 device 租约', { cause: 'env-unavailable' });
    }

    /*
     * **到期先续、续不动才报 env-unavailable**（`docs/15` §3.1）。
     *
     * 为什么判在这里而不是 `case 'device'` 里：到期发生在**中间某个设备步**，
     * 而那条步走的是 tap/app/input，压根不经过 device 那个 case。
     *
     * `expiresAt` 是 0 / 非法的时候**不判**，理由不是"照顾测试"（虽然现有那几个
     * 假 DeviceExec 确实返回 0），而是 **0 是"这个 adapter 不报到期时间"的唯一可表达值**：
     * `DeviceExec.lease()` 的返回里 `expiresAt` 是必填 number，一个不想管租期的
     * 实现没有别的写法。把它当"1970 年就已过期"会让所有老实报 0 的实现直接不可用，
     * 那是拿类型缺陷当缺陷修。**要说清这是宽容**：租期纪律今天只对"报了真实到期时间"
     * 的 adapter 生效，而**仓库里一个这样的 adapter 都还没有**（docs/15 §3.1 整节的
     * 取证都标着"缺 device adapter"）。所以这条现在能防的是"将来有人写了带租期的
     * adapter 之后忘了处理过期"，不是"今天正在漏"。
     */
    if (slot.lease && adapters.device) {
      const exp = Date.parse(slot.lease.expiresAt);
      if (Number.isFinite(exp) && exp > 0 && clock.now() >= exp) {
        /*
         * 续租**必须自己吞异常**。这一坨在 dispatch 的 try 之外（它要在进步骤之前拦），
         * 所以 renew 抛出来会一路撞到 run 的 catch —— 症状是"整份报告变成一条
         * `__run__: error`"，前面所有步骤的结论虽然还在、但整体状态被一次设备农场
         * 500 改写成运行异常。本轮写第一版时就是这个形状，是测试把它测出来的：
         * 期望"这一步 error"，实际拿到 `undefined`（那一步压根没进 results）。
         */
        let renewed: { expiresAt: number } | undefined;
        if (slot.lease.renewable) {
          try {
            renewed = await adapters.device.renew({ id: slot.lease.id }, execCtx(slot.lease.target as ExecContext['target'], s.id));
          } catch (e) {
            renewed = undefined;
            emit({ kind: 'lease.lost', stepId: s.id, data: { lease: slot.lease.id, device: slot.lease.deviceRef, reason: errSummary(e) } });
          }
        }
        if (renewed === undefined) {
          return finish(s, path, 'error', stepStart,
            `device 租约已过期${slot.lease.renewable ? '且续租失败' : '（该租约 renewable=false）'}：${slot.lease.deviceRef}`,
            { cause: 'env-unavailable', keyContext: { lease: slot.lease.id, expiresAt: slot.lease.expiresAt, now: clock.now() } });
        }
        /*
         * 续租会**重建**租约对象（`{ ...slot.lease, expiresAt }`），id 不变而身份变了。
         * 槽位上的 `owns` 与这件事无关，所以这里只动 `lease` —— 也正因如此，
         * "这租约是不是我申请的"这个判据不能存对象（否则每次续租都要记得换进去）。
         */
        slot.lease = { ...slot.lease, expiresAt: new Date(renewed.expiresAt).toISOString() };
        emit({ kind: 'lease.renewed', stepId: s.id, data: { lease: slot.lease.id, expiresAt: slot.lease.expiresAt } });
      }
    }

    try {
      const outcome = await dispatch(s, path, vars, window, slot);
      // 守望在步骤之后跑一次，处理「上一步触发的弹窗」
      await runWatchers(slot);
      return finish(s, path, outcome.status, stepStart, outcome.summary, {
        cause: outcome.cause, resolvedBy: outcome.resolvedBy, rung: outcome.rung,
        confidence: outcome.confidence, healed: outcome.healed, nonReplayable: outcome.nonReplayable,
        keyContext: outcome.keyContext, costUsd: outcome.costUsd ?? 0,
        // 不传就得留空数组：finish 的默认已经是 []，这里只在有证据时覆盖
        ...(outcome.artifactIds?.length ? { artifactIds: outcome.artifactIds } : {}),
      });
    } catch (e) {
      if (e instanceof RunAborted) throw e;
      /*
       * **定位超预算要走 fail 而不是 error**：让 LocatorBudgetError 落到
       * error 分支的话，退出码变成 5，而 CI_HINT 教 CI"5 → 标 error 重试一次"。
       * 那一次重试会**把同一笔开销再花一遍**：一个"防止 LLM 定位把预算烧穿"的闸门，
       * 反过来变成烧穿预算的加速器。这是本文件里唯一一处"状态选错会放大它本该拦住的损失"。
       *
       * cause 一律交给 `causeOfError`（`errors.ts`）。改动前这里是
       * `overBudget ? 'case-stale' : e instanceof AssertionFailure ? 'product-bug'
       *  : e instanceof VarError ? 'case-stale' : 'env-unavailable'`，两个毛病：
       *  1. **兜底那格是"编一个像样的答案"**：没登记的新错误类一律报"环境不可用"，
       *     值班人去查一个不存在的环境问题、CI 白重试一次。现在兜底是 `untriaged`
       *     （"没人认领"），它是 FAILURE_CAUSE 里本来就有的合法值，含义就是它字面意思。
       *  2. `AssertionFailure` **全仓没有任何 throw 点**（本轮 grep 过 src+test+tooling，
       *     只有这里的三处引用与 errSummary 里的一处），所以那两个分支是到不了-code
       *     （docs/14 §4.7 那条"到不了的防护分支"）。断言不成立在这里是**返回值**
       *     （`outcome.status === 'fail'`），从来不是异常。删掉之后 fail/error 的
       *     分界只剩"超预算 → fail，其余 → error"，与实测行为一字未变。
       */
      const overBudget = e instanceof LocatorBudgetError;
      const status: StepStatus = overBudget ? 'fail' : 'error';
      return finish(s, path, status, stepStart, errSummary(e), {
        cause: causeOfError(e),
        keyContext: {
          errorName: (e as Error).name,
          stack: firstFrames(e),
          /*
           * 超预算的两个数原样带进 keyContext：人和看板都要靠它们决定下一步动作
           * （"是定位器选贵了，还是价格表涨了"）。这里没有敏感值 —— 两个数都是
           * 人自己在 IR 里写的 / adapter 自己报的成本，不是被测系统的数据。
           */
          ...(overBudget ? { spentUsd: e.spentUsd, budgetUsd: e.budgetUsd, ...(e.resolvedBy ? { resolvedBy: e.resolvedBy } : {}), ...(e.rung ? { rung: e.rung } : {}) } : {}),
          /*
           * 传输层失败的**种类**走 keyContext，不扩 FAILURE_CAUSE。
           *
           * 我一开始直接把 cause 写成 'network' / 'timeout'，那是**运行时会炸的**：
           * 那两个词在 retryOn 的枚举里，**不在** FAILURE_CAUSE 里，
           * 而 StepResultSchema 是 strict + 封闭枚举 —— 磁盘写得出、parseStepResults 读不回，
           * 症状是"证据包里的这一步整条被丢"，比归错类更隐蔽。
           * 为什么不把两个词加进 FAILURE_CAUSE：那个枚举是**triage 与 flake 看板的分组口径**，
           * 加值等于改磁盘格式与所有看板分组；而"这一步为什么没测成"的人话归因
           * 就是 env-unavailable（连不上=环境不可用），细分种类是**重试判据**要用的，
           * 不是归因口径。所以：归因照旧，种类另带一个字段。
           */
          ...(e instanceof TransportError ? { [TRANSPORT_KEY]: e.kind } : {}),
          /*
           * 等待条件缺的是哪个槽位，进 keyContext 而不是只活在摘要里。
           *
           * 两个字段在 wait.ts 的错对象上，这里只是搬到结构化那一份里 ——
           * **摘要给人读，keyContext 给看板分组**：CI 那一侧要能一句
           * `jq '.results[] | select(.keyContext.missingAdapters) | .stepId'`
           * 把"这一场里有几步是压根没接线"列出来，而按摘要正则匹配中文
           * 是本仓最脆的那种依赖（文案本仓改过很多次，见 mutate 集 I3 那条等价记录）。
           * 没有敏感值：槽位名与条件类型都是 IR 里的字面词，不是被测系统的数据。
           */
          ...(e instanceof NoConditionAdapter
            ? { missingAdapters: e.triedAdapters, waitCondition: e.conditionType }
            : {}),
        },
      });
    }
  };

  const finish = (
    s: Step, path: string[], status: StepStatus, at: number, summary?: string,
    extra: Partial<StepResult> = {},
  ): StepResult => {
    const r: StepResult = {
      stepId: s.id, kind: s.kind, status, durMs: clock.mono() - at, retry: 0,
      assertionSummary: summary, costUsd: 0, healed: false, nonReplayable: false,
      artifactIds: [], keyContext: {}, ...extra,
      cause: extra.cause ?? (status === 'fail' ? 'product-bug' : status === 'error' ? 'untriaged' : undefined),
    };
    results.push(r);
    emit({ kind: 'step.finished', stepId: s.id, path, status, durMs: r.durMs, data: { summary, ...(extra.keyContext ?? {}) } });
    // 失败传播由调用方按 onError 决定；这里只负责记录
    return r;
  };

  /**
   * 循环体一次都没跑时，给体内**顶层步骤**各补一条 skipped。
   *
   * **为什么不满足于"发一条 lint 事件"**（这是本轮真正的那件事）：
   * 实测过 `while` 一次没进 + 体外一条真断言的形状 => 场景 `pass`、退出码 0、
   * 理由写着"1 条断言全部通过"，而体里那条断言**压根没跑**。
   * lint 事件（`LOOP_CEILING_HIT` 那一族）拦不住它，有两个原因，缺一不可都致命：
   *  1. **门禁不读 events**（`gateAfterRun` 里一处 `events` 都没有）—— 事件只能给人看，
   *     不能改变退出码，所以"有事件"与"门禁知道"是两件事；
   *  2. 预编译形态**没有事件通道**（executor.ts 的 `emit: () => {}`），
   *     所以发事件这件事天然只能修一半，而分叉的表现是"功能形态有提示、压测形态静默"。
   * 补进 `results` 是让**同一个事实**同时被 JUnit（`<skipped>`）、通过率分母
   * （skipped 不计入分母，docs/02 §9）与门禁看到，而不是只写进一条日志。
   *
   * **为什么容器自己仍报 pass 而不是 skipped**：`forEach`/`while` 的循环体一遇到
   * 非 pass/healed 就 `return o`（本文件两处 `o.status !== 'pass' && o.status !== 'healed'`），
   * 所以嵌套时内层报 skipped 会**静默截掉外层循环剩下的轮次**。
   * 实测过这个形状（forEach 3 项、体内 parallel 分支全跳过）：外层确实继续跑完了，
   * 但那是因为 parallel 的 skipped 是**在容器自己那一层**收掉的；
   * 我不想赌"没人写过嵌套 while"，所以状态不变，只加行。
   * （parallel 那边报 skipped 是安全的，因为它没有"剩下没跑的轮次"这个概念。）
   *
   * **只补顶层，不递归补孙层**：与上面 parallel 补 failFast 分支同一做法 ——
   * 目的是让"这次运行少验了什么"在报告里**有一行可指**，不是重建整棵没跑的子树。
   * 补的都是 skipped 而不是 fail：没跑不等于跑坏了，报 fail 就是把环境/数据问题算成产品 bug
   * （docs/02 §9 那套状态语义在这里同样成立）。
   */
  const noteNeverRun = (s: ForEachStep | WhileStep, path: string[], why: string): void => {
    // keyContext 里带结构化的成因，而不是只写进 assertionSummary 那句话：
    // 门禁要区分"循环体没跑"与"守卫 when 不成立"，而**跨包匹配一句话的前缀**
    // 是迟早会断的耦合（改个措辞就悄悄退化，而且没有任何编译期东西会发现）。
    for (const c of s.steps) finish(c, [...path, s.id], 'skipped', clock.mono(), `未执行：${why}`, { keyContext: { neverRun: why } });
    emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'LOOP_BODY_NEVER_RUN', detail: `${s.kind} ${why}` } });
  };

  /**
   * 找到 r 在 results 里的位置并换掉它（找不到就什么都不做）。
   *
   * **为什么按对象身份找而不是 `results[results.length - 1]`**：
   * 我一开始以为"最后一条"在并行下会指错 —— 两次尝试之间隔着
   * `await clock.sleep(backoff)`，另一支完全能在这段 sleep 里 push 自己的行。
   * **实测不成立**（两支并行、b1 首次抛错后 backoff，b2 在 sleep 期间跑完）：
   * 回填点紧跟在 `await fn()` 之后、中间没有 await，所以那一条就是本步骤刚 push 的。
   * 改成身份查找**不是修那个不存在的 bug**，而是不把正确性押在
   * "回填点与 push 之间永远没有 await"这条没人会记得的不变量上 ——
   * 将来谁在 withRetry 里加一次 await（比如重试前重新取租约），
   * 位置假设就会静默变成"改别人的结论"，而那种错只会表现为偶发的报告错乱。
   *
   * 顺带说明为什么这里不担心 lastIndexOf 找不到：r 由 finish 推进数组，
   * 只可能被 dropResult 撤掉（撤掉后就不再回填），所以找不到只会发生在
   * 已经不该写的情形，静默返回副本是安全的。
   */
  const replaceResult = (r: StepResult, patch: Partial<StepResult>): StepResult => {
    const next = { ...r, ...patch };
    const i = results.lastIndexOf(r);
    if (i >= 0) results[i] = next;
    return next;
  };

  /** 丢掉一次**没采纳**的尝试的行（见 withRetry 里"为什么必须丢"）。 */
  const dropResult = (r: StepResult): void => {
    const i = results.lastIndexOf(r);
    if (i >= 0) results.splice(i, 1);
  };

  /**
   * 这一步这次失败**值不值得再发一次**。
   *
   * 三条前置，缺一不可：
   *  1. **状态是 error**（没测成）。fail 是被测算出的答案，重跑同一份数据必然同答案；
   *     pass/healed 更不用说的。
   *  2. **种类命中 retryOn**。比的是 keyContext 里那个**传输种类**，
   *     不再是 cause —— 以前比的是 `cause === 'network'`，
   *     而 cause 永远不可能等于 network（它在 FAILURE_CAUSE 里就没有），
   *     所以**默认 retryOn 从来没重试过一次**（实测：count=3 + 默认 retryOn => 发 1 次）。
   *  3. **重发是安全的**（resendsSafely）：POST/PATCH 一律不重发。
   *     判据必须在这里而不是 adapter 里 —— 决定重发的是这个循环。
   *
   * 抛错与"正常返回 error"两条路都算：传输层抛 TransportError，
   * runStep 的 catch 会把它收敛成 error 行并把种类塞进 keyContext，
   * 所以下面只看行上的字段就够，不必分情况。
   */
  const worthRetrying = (s: Step, r: StepResult): boolean => {
    if (r.status !== 'error' || !resendsSafely(s)) return false;
    const kinds = retryPolicyOf(s).retryOn;
    const kind = r.keyContext?.[TRANSPORT_KEY];
    return typeof kind === 'string' && kinds.includes(kind as 'network' | 'timeout');
  };

  /**
   * 带重试的包装。
   *
   * **为什么这里要自己合并 config.retries，而不是靠 schema 的默认值**：
   * 以前是 `s.retry?.count ?? scenario.config.retries.count` ——
   * 看着像"步骤没写就吃场景级"，实际吃不到：
   * Zod 对**存在的** `retry` 对象会补齐它所有缺省字段，所以
   * `retry: { retryOn: [...] }`（只写想覆盖的那项，最自然的写法）落地时
   * `count` 已经是 0，`?? ` 那条兜底**永远不触发**。
   * 实测：场景级写 `count: 3`，无论步骤上写什么、还是不写，
   * **发请求次数都是 1** —— 也就是说 config.retries 这个配置项
   * 在任何组合下都产生不了一次重试。
   * （步骤完全不写 retry 时能吃到场景级 count，但那时 retryOn 用的是
   *  schema 的默认 ['network','timeout']，而场景级写的 retryOn 又被忽略 ——
   *  两种形状各漏一半，正是 docs/04 §10 那条"同一概念两套形状"的后遗症。）
   *
   * 现在**显式表示"没写"**：count/backoff/baseMs/maxMs/retryOn 逐项
   * 从步骤取、取不到退回场景级，`retry: {}` 这种空对象也不再吞掉整条场景配置。
   */
  const retryPolicyOf = (s: Step): Retry => {
    // s.retry 的类型就是"每项可选"（RetryOverride），所以这里逐项 ?? 是**类型强制**的。
    // 以前它是 `s.retry as Partial<Retry>`：步骤上的 retry 其实是**已补默认值**的
    // Retry，那次 cast 把"count 其实永远是 0"从编译期错误变成了运行时静默。
    const d = scenario.config.retries;
    const o = s.retry;
    return {
      count: o?.count ?? d.count,
      backoff: o?.backoff ?? d.backoff,
      baseMs: o?.baseMs ?? d.baseMs,
      maxMs: o?.maxMs ?? d.maxMs,
      retryOn: o?.retryOn ?? d.retryOn,
    };
  };

  const withRetry = async (s: Step, path: string[], fn: () => Promise<StepResult>): Promise<StepResult> => {
    const policy = retryPolicyOf(s);
    const max = policy.count;
    let last: StepResult | undefined;
    /** 被后续尝试取代掉的尝试（连同那次重试前等了多久）。信息不能凭空消失，见 flakyOf。 */
    const superseded: Array<{ r: StepResult; waitedMs: number }> = [];
    for (let attempt = 0; attempt <= max; attempt++) {
      last = await fn();
      if (last.status === 'pass' || !worthRetrying(s, last) || attempt === max) break;
      /*
       * **被取代的尝试必须从 results 里撤掉**。以前它留在数组里，一个步骤就留下
       * N 行（实测 `h:error, h:pass` 两行），四个后果全在"红绿可不可信"这条线上：
       *  1. 整体状态是 `gate.some(r => r.status === 'error')` ——
       *     **重试成功的那一步仍然把整个 run 判成 error**（实测确认），
       *     "重跑即通过"这个 flaky 的定义形状在这里变成永远修不完的红灯；
       *  2. JUnit 一行一个 <testcase>，tests 计数被同一步骤重复贡献（压测尤其失真）；
       *  3. 通过率分母 countsTowardPassRate 把 error 与 pass **都**算进去，
       *     于是一次 flake 同时抬高分子和分母，指标看着"有在动"但没有含义；
       *  4. 门禁的 leaves 里同一步骤两条自相矛盾的结论，人先要花时间怀疑报告坏了。
       *
       * **撤掉不等于丢掉信息**：attempt 计数、每一次尝试的 status/cause/摘要
       * 都并进最后那一行（flakyOf），所以"第 2 次才过"与"第 1 次是 500 还是连不上"
       * 在报告与证据里仍可查。这与 docs/08 里"少验了什么要有一行可指"是同一条纪律 ——
       * 撤行是为了让**结论**唯一，不是为了销毁过程。
       *
       * 成本与耗时同理**求和而不是丢弃**：那几次尝试真的花了钱、真的占用了时间。
       * 只保留最后一次有两个后果 —— sum(rows.costUsd) 对不上 run 级 costUsd，
       * 以及"这一步很慢"这个 flake 的**主要症状**从报告里消失。
       *
       * **重试前的 backoff 等待也算进这一步的 durMs**。一开始我没算，理由是
       * "等待不是工作"；但 durMs 的用途是 JUnit 的 per-testcase time，
       * 而人看那个数字是为了找慢用例 —— 配了 count=3 / baseMs=2000 的用例
       * 报 time=0.005 而整个 run 报 6s，人只会说"JUnit 数字不准"然后去看别的。
       * （perf 断言不受影响：它读的是 adapter 自己量的 response.durationMs，
       *  见 assertions.ts 的 payload.durationMs 分支，不是 StepResult.durMs。）
       */
      const waitedMs = backoffMs(policy, attempt);
      superseded.push({ r: last, waitedMs });
      dropResult(last);
      await clock.sleep(waitedMs);
    }
    if (superseded.length) {
      // keyContext 是被 strict schema 收下的唯一扩展位（StepResultSchema 是 .strict()，
      // 顶层加字段等于改磁盘格式），所以 flaky 的成因走这里。
      last = replaceResult(last!, {
        retry: superseded.length,
        durMs: last!.durMs + superseded.reduce((n, x) => n + x.r.durMs + x.waitedMs, 0),
        costUsd: last!.costUsd + superseded.reduce((n, x) => n + x.r.costUsd, 0),
        keyContext: { ...last!.keyContext, [FLAKY_OF_KEY]: superseded.map((x, i) => flakyOf(x.r, i + 1, x.waitedMs)) },
      });
    }
    return last!;
  };

  interface Outcome {
    status: StepStatus; summary?: string; cause?: StepResult['cause'];
    resolvedBy?: string; rung?: number; confidence?: number; healed?: boolean; nonReplayable?: boolean;
    keyContext?: Record<string, unknown>; costUsd?: number;
    /** 本步骤产出的证据 id。**由 dispatch 交回来**，不在 finish 里凭空造：
     *  证据是否真落盘取决于存储侧，finish 无从知道，在那里填等于编造。 */
    artifactIds?: string[];
  }

  /**
   * @param slot 这一批步骤跑在**哪个租约槽**上。**必填、无默认值**，
   *   而且这个默认值是本轮**先写上去又删掉**的：写成 `slot: LeaseSlot = runSlot`
   *   看起来无害（顶层调用少打一个字），但它让"`dispatch` 里新增一处嵌套 `runChildren`
   *   忘了传 slot"这件事**编译得过而行为静默回落到外层槽** —— 那正是本轮刚修的缺陷的形状
   *   （分支共用了本该独立的槽位）。留默认值等于把同一个坑原地留着等人再踩一次。
   *   顶层那三处（setup/body/teardown）显式写 `runSlot`，一眼能看出"这三段共用一层槽"。
   */
  const runChildren = async (steps: Step[], path: string[], vars: VarSpace, slot: LeaseSlot): Promise<Outcome> => {
    const rs: StepResult[] = [];
    // 身份在**每个序列**入口快照、出口复位（理由见 currentIdentity 的注释）。
    // finally 是必须的：中途 return（子步骤失败且 onError 不是 continue）
    // 是常态而不是异常路径，只在正常结束复位等于"失败的场景里身份泄漏"。
    const identityBefore = currentIdentity;
    try {
      for (const c of steps) {
        /*
         * **每步一个新窗口，同一步的多次重试共用它**。
         * 新窗口 => 起点是此刻的账位（上一步消费过的响应不再算命中）；
         * 共用 => 重试不会因为"上一次尝试已经把它们读走了"而看不见。
         * 顺序上必须在 withRetry **外面**建，见 newResponseWindow 的注释。
         */
        const window = newResponseWindow();
        const r = await withRetry(c, path, () => runStep(c, path, vars, window, slot));
        rs.push(r);
        if (r.status === 'fail' || r.status === 'error') {
          if (c.onError === 'continue') continue;
          if (c.onError === 'retry') { /* withRetry 已处理，走到这里说明重试用尽 */ }
          return { status: r.status, summary: `${c.name ?? c.id}: ${r.assertionSummary ?? ''}`.trim(), cause: r.cause };
        }
      }
    } finally {
      currentIdentity = identityBefore;
    }
    const healed = rs.some((r) => r.healed);
    return { status: healed ? 'healed' : 'pass', summary: `${rs.length} 个子步骤` };
  };

  const dispatch = async (s: Step, path: string[], vars: VarSpace, window: ResponseWindow, slot: LeaseSlot): Promise<Outcome> => {
    switch (s.kind) {
      // ── 控制流 ────────────────────────────────────────────────
      case 'sequence': return runChildren(s.steps, [...path, s.id], vars, slot);
      case 'if': {
        const ok = evalBool(s.condition, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now });
        return runChildren(ok ? s.then : s.else, [...path, s.id], vars, slot);
      }
      case 'switch': {
        const value = compileExpr(s.value).eval({ root: vars.asExprRoot(), vars: vars.visible(), now: clock.now });
        for (const c of s.cases) {
          if (looseEq(value, resolveValue(c.is, vars))) return runChildren(c.steps, [...path, s.id], vars, slot);
        }
        return runChildren(s.default, [...path, s.id], vars, slot);
      }
      case 'forEach': {
        const items = iterItems(compileExpr(s.items).eval({ root: vars.asExprRoot(), vars: vars.visible(), now: clock.now }));
        const cap = Math.min(items.length, s.maxIterations);
        if (items.length > s.maxIterations) {
          emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'LOOP_TRUNCATED', detail: `数据 ${items.length} 条被 maxIterations=${s.maxIterations} 截断` } });
        }
        for (let i = 0; i < cap; i++) {
          const depth = vars.pushIteration(s.as, items[i], s.indexAs, i);
          const o = await runChildren(s.steps, [...path, s.id], vars, slot);
          vars.popTo(depth); // 按深度回退：子步骤若没配对 pop（失败提前返回），迭代变量也不会漏出去
          if (o.status !== 'pass' && o.status !== 'healed') return o;
        }
        if (cap === 0) noteNeverRun(s, path, '迭代 0 次（items 是空集合）');
        return { status: 'pass', summary: `迭代 ${cap} 次${cap ? '' : '，循环体一条未执行'}` };
      }
      case 'while': {
        let i = 0;
        while (i < s.maxIterations) {
          checkAbort();
          if (!evalBool(s.condition, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now })) break;
          const depth = vars.push('while');
          const o = await runChildren(s.steps, [...path, s.id], vars, slot);
          vars.popTo(depth);
          if (o.status !== 'pass' && o.status !== 'healed') return o;
          i++;
        }
        if (i === s.maxIterations && evalBool(s.condition, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now })) {
          emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'LOOP_CEILING_HIT', detail: `达到上限 ${s.maxIterations}，条件仍为真` } });
        }
        if (i === 0) noteNeverRun(s, path, '条件第一次就为假，一次都没进循环');
        return { status: 'pass', summary: `循环 ${i} 次${i ? '' : '，循环体一条未执行'}` };
      }
      case 'repeat': return runChildren(flattenTimes(s.times, s.steps), [...path, s.id], vars, slot);
      case 'parallel': {
        // **分支里不许切身份**。身份是共享的可变量，分支交错执行时
        // "谁先切"决定另一边看到谁 —— 而用 parallel 跑多身份恰恰是权限矩阵的
        // 常见写法（"A 和 B 同时读同一份资源"）。那种写法会**双双通过**：
        // 两个分支最后用的是同一个身份，断言"读不到"的那条自然也过。
        // 与其给一个随并发度变化的答案，不如当场说清该怎么写（拆成两条场景，
        // 或把分支改成 sequence 把切换收在分支内部 —— 后者仍然会竞态，所以一律拒）。
        const racing = s.steps.filter((c) => containsIdentitySwitch([c]));
        if (racing.length) {
          return {
            status: 'error', cause: 'case-stale',
            summary: `parallel 的分支里有 useIdentity（${racing.map((c) => c.id).join('、')}）。并行分支共享身份状态，结果会随调度顺序变化。`,
            keyContext: { hint: '每个身份写一条独立场景，或用 parallelGroup/concurrencySafe 让调度器串行化' },
          };
        }
        /*
         * **每支一份局部作用域**。
         *
         * 这里原先的做法是"跑之前静态拒掉两种会串的写法"，那是临时盾牌：
         * 它只覆盖我**想到的**那两种交错，而根因（帧栈全局共享一条）还在，
         * 于是第三个形态照样漏 —— 探针实测：B 支一句 `set mineOnly = 42`，
         * 那时栈顶恰好是 A 支 forEach 的迭代帧，值写进 A 的帧、跟着 A 一起弹掉，
         * B 那步报 pass，`$mineOnly` 永远查不到。闸抓不到它（两支不同名、无共享写、
         * B 也没提 A 的循环项）。继续加宽就是第 4 条、第 5 条规则加下去，
         * 而每加一条都在把 parallel 能写的形状收窄。
         *
         * 现在的做法（VarSpace.forkBranch）：**global 帧按引用共享，各支只给自己加帧**。
         * 于是
         *  - 分支里新声明的名字落在本支帧里，别人看不见，也不会被别人的 popTo 弹掉；
         *  - "写 parallel **之前**已声明的名字"（累加器写法，docs/02 §5 推荐的那个）
         *    照旧写进共享的 global 帧，行为一个字节没改 —— 这条是实测出来的，
         *    预先 `set mineOnly = 0` 之后同样的并发就不丢值了；
         *  - 步骤导出各支一份 Map，两支 saveAs 同名从"谁后跑谁算"变成物理上不可能。
         * parallel 结束后各支的本地写入按**声明顺序**并回 global（顺序理由见下面 scopes）。
         */
        /*
         * 静态闸**收窄到只剩一条**：两支写同一个名字（判据见 ir 的 parallelHazards）。
         * 原来那两条里的"一支压帧、另一支提到那个循环项"已经由上面的分支作用域修掉了，
         * 再靠闸去追根因就是无限加宽 —— 见上一条注释。
         */
        const hazards = parallelHazards(s.steps);
        if (hazards.length) {
          const what = hazards.map((h) => `"${h.name}" 被 ${h.branches.join(' / ')} 同时写`).join('；');
          return {
            status: 'error', cause: 'case-stale',
            summary: `parallel 的分支之间变量会串：${what}`,
            keyContext: { hint: '给各分支用不同的变量名，或把这几支拆成顺序步骤 / 独立场景' },
          };
        }
        /*
         * 并发池。**原先写的是 `s.steps.slice(0, s.maxConcurrency)`** ——
         * 那是本仓那个缺陷类的第 9 例，而且比"字段没人读"更坏一级：
         * 分支压根没执行，场景照样 pass，summary 还说"并行 5 支"（用的是 s.steps.length）。
         * maxConcurrency 默认 4，所以任何 5 支以上的并行**每次都会静默丢尾巴**。
         * 被丢的是用例这件事没有任何地方看得见：结果里没有那些 stepId，
         * 报告里那一支是"通过"，覆盖率按分支数算 —— 全线一致地谎报。
         * 现在按池调度：谁先跑完谁补下一支，一支不漏；没来得及起跑的分支
         * 只可能在 failFast 提前中止时出现，那时**逐个补记为 skipped**，
         * 而不是从结果里消失（"没跑"必须能在报告里被读出来）。
         */
        const BAD = new Set(['fail', 'error']);
        const OK = new Set(['pass', 'healed']);
        const left = [...s.steps];
        const done: PromiseSettledResult<StepResult>[] = [];
        /* 分支局部作用域，按**分支 id**存。
         * 用 Map 而不是"跑完就合并"：合并必须按 s.steps 的**声明顺序**做，
         * 不能按完成顺序 —— 按完成顺序的话，两支各自新声明同名变量时，
         * 谁赢取决于谁先跑完，同一份冻结场景就能给出不同结果，
         * 直接把 M7 的"跑 20 次断言结果完全一致"破掉（而且是最难查的那种：
         * 重跑一次可能正好对，于是被当成 flaky 重试掉）。 */
        const scopes = new Map<string, VarSpace>();
        let stop = false;
        let abort: unknown;
        /** 一支 worker：跑完一支就补下一支，直到没活可补或 failFast 拉闸。
         *  共享数组的 shift/push 都发生在 await 之外，JS 单线程下不会交错破坏。 */
        const worker = async (): Promise<void> => {
          while (!stop) {
            const c = left.shift();
            if (!c) break;
            const branch = vars.forkBranch(c.id);
            scopes.set(c.id, branch);
            try {
              /*
               * 分支步骤**各开自己的窗口**（与 runChildren 同一做法）。
               * 并发分支共享一个窗口的话，两支会互相把对方 poll 到的条目算进自己的命中，
               * 症状是"A 支的等待被 B 支发的接口满足了" —— 那是一条假绿，
               * 而且只在并发时出现（单跑必过），正是本仓最难查的那一类。
               * 账位（ledger）是共享的，但用的是 max 而非求和，所以两支读到同一批条目
               * 不会把账推到流前面（见 ResponseLedger 的"为什么是 max"）。
               */
              const branchWindow = newResponseWindow();
              /*
               * 分支各开**自己的租约槽**，初值是**这一层**手上那台（可能没有）。
               *
               * 这里读的是形参 `slot` 而不是闭包里的 `runSlot`，差别只在**嵌套 parallel**：
               * `parallel` 里的一支自己申请了租约、里面又套一层 parallel 时，内层的分支
               * 该继承**外层那一支**的那台，而不是整场运行的 `runSlot`（那里可能根本没有）。
               * 写成 `runSlot.lease` 时实测（`.scratch/probe-nested-parallel.mts`；
               * 永久落点 `lease-lifecycle.test.ts`「外层分支自己申请了租约，内层 parallel 的裸 tap
               * 继承**外层那一支**那台」，静态侧同一形状由 `lease-scope.test.ts` 的 L6 钉住）：
               * 内层那个裸 tap 报「缺少 device 租约」，而**同一形状 lint 判它该通过** ——
               * 静态闸与运行事实又不一致了，这是本仓最贵的那一族缺陷，
               * 而它在这轮"修完了"之后原地又出现了一次（形状不同：这次是**少传一层**，
               * 上次是**多共享一层**）。`slot` 是必填形参的意义正在这里：
               * 编译器能逼每个容器写 `slot`，但**逼不了它写对 `slot`**。
               *
               * 这是本轮的缺陷修复，原先没有这一行 —— 分支通过闭包共用同一个租约变量，
               * 于是两支各带一个 `device` 时，两个 device 步都看到"手上已有租约"，
               * 各自去还**同一个** id，而自己新拿的那台谁都不还：
               * 实测 `lease 2 次 / release 1 次`，收尾手上攥着一台真机，报告却是 `p:pass`。
               *
               * 借来的那台 `owns: false`，所以分支里的 device 步**不会**把它还掉
               * （还了就等于把上层正在用的设备扔回池子），而是另拿一台、跑完还自己那台。
               *
               * **顺带把一个隐性的不确定性变成确定结论**：一支 `device` + 一支裸 `tap`
               * 这种形状，今天的结果取决于调度 —— 裸 tap 那支先跑就 error，后跑就 pass
               * （实测两种都出现过）。分支各自有槽之后它**恒为 error**，
               * 而 lint 对同一形状本来就报 `RESOURCE_LEASE_MISSING/error@tB`
               * （探针 `.scratch/probe-parallel-lint.mts`；永久落点运行侧是
               * `lease-lifecycle.test.ts`「一支 device + 一支裸 tap → **恒为 error**」，
               * 静态侧是 `lease-scope.test.ts` 的 L1）—— 两边终于同一个口径，
               * 而且不再 flaky。**"分支之间共享设备"不是一种可承诺的语义**，
               * 与 parallel 分支之间变量"谁后写谁赢"是同一条判断（见上面 scopes 那段注释）。
               */
              const branchSlot = newLeaseSlot(slot.lease);
              const r = await withRetry(c, [...path, s.id], () => runStep(c, [...path, s.id], branch, branchWindow, branchSlot));
              /*
               * 分支自己申请的租约，在**分支结束**时归还 —— 不能等整场跑完，
               * 因为槽位是分支局部的，出了这一支再没人能引用它，那就是又一种"没人还"。
               * 借来的那台**不在这条路径上**（owns=false），由申请它的那一层负责。
               * 归还失败不改变这一支的结论（清理失败不该改写"功能对不对"，
               * 与 runScenario 收尾那段同一个口径），但要说进日志。
               */
              if (branchSlot.lease && branchSlot.owns) {
                const held = branchSlot.lease;
                branchSlot.lease = undefined;
                branchSlot.owns = false;
                try {
                  await adapters.device!.release({ id: held.id }, execCtx(held.target as ExecContext['target'], s.id));
                } catch (e) {
                  emit({ kind: 'log.emitted', stepId: s.id, data: { level: 'warn', message: `分支 ${c.id} 结束时没能归还它自己申请的 ${held.id} @ ${held.deviceRef}，这台可能被一直占着：${errSummary(e)}` } });
                }
              }
              done.push({ status: 'fulfilled', value: r });
            } catch (e) {
              // RunAborted（外部取消/超时）必须能掀翻整个 run，不能被吞成"这支失败了"——
              // 吞掉的后果是取消之后其余分支还在往被测系统发请求。
              if (e instanceof RunAborted) { abort = e; stop = true; break; }
              done.push({ status: 'rejected', reason: e });
            }
            /*
             * **唯一的拉闸点**，写成"扫一遍已完成的分支"而不是在 try/catch 两边各写一次
             * `stop = true`。理由不是风格：抛错那条路**今天压根到不了** —— runStep 把除
             * RunAborted 以外的异常全收敛成 error 结果（interpreter.ts 的 catch），
             * 所以在 catch 里写的 stop 是一行永远执行不到的代码，变异它测试不会红，
             * 于是它会一直"看起来有防护"。判据落在可达的那一侧，两种失败就都覆盖了。
             *
             * **skipped 不算失败**：守卫不成立的分支不该把同批其他分支全拉停
             * （那会让"未执行"的规模由调度顺序决定，正是这个缺陷类最怕的 flaky 形态）。
             */
            if (s.failFast && done.some((d) => d.status !== 'fulfilled' || BAD.has(d.value.status))) stop = true;
          }
        };
        // min(...) 而不是直接 maxConcurrency：少开压根不会醒的 worker，
        // 免得将来有人往 worker 里加"每支都做一次"的副作用时凭空多出 N 次。
        await Promise.all(Array.from({ length: Math.min(s.maxConcurrency, s.steps.length) }, () => worker()));
        if (abort) throw abort;
        /*
         * 收尾合并：按**声明顺序**把各支的局部写入并回外层作用域。
         *
         * 为什么在并发池这里收、而不是在 VarSpace 里自己收：合并顺序是"parallel 的
         * 分支列表顺序"这个**IR 层面的事实**，VarSpace 不知道分支列表长什么样，
         * 让它自己收就只能按完成顺序 —— 见上面 scopes 的注释，那会破确定性。
         * 用 s.steps 而不是 done：done 是完成顺序。
         */
        for (const c of s.steps) {
          const b = scopes.get(c.id);
          if (b?.hasLocalWrites()) vars.adoptFrom(b);
        }
        // 没起跑的分支（只可能在 failFast 拉闸后出现）补进结果里记 skipped。
        // **必须补**：从结果里消失的分支在报告里等于"不存在"，
        // 而这条分支本来要跑的断言恰恰是这次运行唯一没验的那部分。
        for (const c of left) finish(c, [...path, s.id], 'skipped', clock.mono(), '未执行（failFast：同批已有分支失败）');
        const bad = done.find((r) => r.status !== 'fulfilled' || BAD.has(r.value.status));
        if (bad) {
          const why = bad.status === 'rejected' ? errSummary(bad.reason) : bad.value.assertionSummary;
          return { status: 'fail', summary: `并行分支中有失败：${why ?? '未知'}` };
        }
        // 只**全部**没成功才报 skipped。一支守卫没成立、四支通过的场景，
        // 那四支是真验过了；整只容器报 skipped 会把它们从通过率的分母里一起抹掉
        // （skipped 不计入分母，见 docs/02 §9），比原来"全算 pass"更失真。
        const ran = done.filter((r) => r.status === 'fulfilled');
        const allIdle = !ran.some((r) => OK.has((r as PromiseFulfilledResult<StepResult>).value.status));
        const notRun = done.filter((r) => r.status === 'fulfilled' && r.value.status === 'skipped').length + left.length;
        let tail = `并行 ${s.steps.length} 支`;
        if (notRun) tail += `，未执行 ${notRun} 支${left.length ? '（failFast 提前中止）' : '（分支自身守卫不成立）'}`;
        return { status: allIdle ? 'skipped' : 'pass', summary: tail };
      }
      case 'call': {
        /*
         * 解析器缺失必须**独立**报错。以前写的是
         * `if (!adapters.http && !('callScenario' in adapters))` —— `&&` 意味着
         * 只要注册了 http adapter 就跳过这条，于是"没注入解析器"这个接线错误
         * 一路走到下一行的方法调用，变成 `adapters.callScenario is not a function`
         * （实测：一个纯 call 步骤 + 只有 http 适配器的 run => error / 那句 TypeError）。
         * 那句会作为**被测产品**的 env-unavailable 结论进报告与门禁，
         * 而真相是"平台没接线"——两者下一步动作完全不同。
         */
        if (!adapters.callScenario) return { status: 'error', summary: '子场景解析器未注入（adapters.callScenario 缺失），无法执行 call 步骤', cause: 'env-unavailable' };
        const child = await adapters.callScenario(s.scenarioRef);
        // 解析不到不是"跳过"。skip 会让这一步从通过率分母里消失，
        // 于是"引用了一个不存在的版本"的场景可以一路全绿 —— 它压根没测任何东西。
        if (!child) return { status: 'error', summary: `子场景解析不到：${s.scenarioRef}（不存在、未冻结、或当前身份无权限）`, cause: 'env-unavailable' };
        /*
         * **环必须在跑之前挡掉**。不挡的实测行为是"什么都不会发生"：
         * A→B→A 时每一层都在 await 下一层，既不栈溢出也不报错，进程永远转 ——
         * CI 里表现为这条用例卡死到被 kill，日志里连一行异常都没有。
         *
         * lint 的 DEPENDENCY_CYCLE 靠 `ctx.scenarioGraph`，而那个字段
         * 除了 lint 自己的测试**没有任何调用方填过**，所以它今天挡不住任何东西。
         * 判据按场景 id 而不是 ref：`A@1 → B@1 → A@2` 也是环。
         */
        if (callStack.includes(child.id)) {
          return {
            status: 'error',
            summary: `call 依赖成环：${[...callStack, child.id].join(' → ')}（步骤 ${s.id} 引用 ${s.scenarioRef}）`,
            cause: 'case-stale',
            keyContext: { callChain: callStack, ref: s.scenarioRef },
          };
        }
        const childVars = new VarSpace({
          inputs: Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, resolveValue(v, vars)])),
          // 子场景自己的 inputs 声明：call.args 没给全时由子场景的 default 兜。
          // 用 child.inputs 而不是父场景的 —— default 属于被调用方
          inputDefs: child.inputs,
          env: opts.env, secretResolver: opts.secretResolver,
        });
        const rep = await runScenarioIn({ scenario: child, vars: childVars, adapters, clock, emit: (e: EmitIn) => emit({ kind: e.kind as TraceEvent['kind'], stepId: e.stepId, status: e.status as TraceEvent['status'], durMs: e.durMs, data: e.data, path: [...path, s.id] }), addCost, secretResolver: opts.secretResolver, envRevision: opts.envRevision, callStack: [...callStack, child.id], responseLedger, signal: opts.signal });
        /**
         * 把"这次 call 跑的是哪份 IR、跑出什么"记进父报告。
         *
         * **扁平合并而不是嵌套**：`rep.results` 是子场景自己那一层，
         * `rep.childRuns` 是它下面所有层（各自的 IR 与各自的 results）。
         * 只记直接子层的话，A→B→C 而断言全在 C 时会判成"这个场景没验任何东西"——
         * 那是**误拦合法用例**，比漏拦更糟，也正是这里选扁平的原因。
         *
         * 顺序上放在 assignTo 之前之后都一样，但**必须在这个 case 的每个 return 之前**：
         * 少记一条，门禁就会把一个真的跑过断言的场景当成空场景拦下。
         */
        childRuns.push({
          callStepId: s.id, ref: s.scenarioRef, scenario: child, results: rep.results,
          status: rep.status, tally: rep.tally, costUsd: rep.costUsd, durMs: rep.durMs,
          calledById: scenario.id,
        });
        /*
         * 孙子层**原样搬上来**，一个字段都不重写。
         * 它们的 calledById/status/tally 是**它自己那一层**push 时填的
         * （B 调 C 时，B 填的就是 calledById:'B' + C 自己的 tally），
         * 到这里改写就等于拿父的口径去覆盖子的实况。
         */
        childRuns.push(...(rep.childRuns ?? []));
        /*
         * **子场景被中断时，call 这一步不能报 pass**。
         *
         * 子场景自己有 `config.timeoutMs`，所以"子里被砍、父侧一切正常"是可达的：
         * `rep.status` 在被打断时仍然是 pass（见 RunReport.aborted 那段），
         * 于是父侧这一步会 `return {status:'pass'}` —— 一份**中间被砍断**的子场景
         * 在父报告里是一条干净的通过。这是同一个缺陷在第二层上的复现，
         * 而它比父侧更难发现（父的 summary 看起来完全正常）。
         *
         * 归 env-unavailable 而不是 fail：被砍不是被测产品的结论，
         * 与"子场景解析不到"同一处置。
         * 同时把中断**记到父报告上**（`interruption`）：整份报告确实是不完整的，
         * 门禁该给"被中断"而不是"运行异常"。
         */
        if (rep.aborted) {
          interruption ??= { kind: rep.aborted.kind, reason: `子场景 ${s.id} ${rep.aborted.reason}` };
          return { status: 'error', summary: `子场景 ${child.name} 被中断：${rep.aborted.reason}`, cause: 'env-unavailable', keyContext: { callStepId: s.id, abortKind: rep.aborted.kind } };
        }
        if (s.assignTo) vars.set(s.assignTo, rep.outputs);
        if (rep.status === 'fail' || rep.status === 'error') return { status: rep.status, summary: `子场景 ${child.name}: ${rep.summary}`, cause: rep.results.find((r) => r.cause)?.cause };
        return { status: 'pass', summary: `子场景 ${child.name}` };
      }

      // ── 等待 ──────────────────────────────────────────────────
      case 'wait': {
        const r = await waitUntil({
          predicate: s.condition, timeoutMs: s.timeoutMs, pollMs: s.pollMs, backoff: s.backoff,
          clock,
          evalExpr: (e) => evalBool(e, { root: vars.asExprRoot(), vars: vars.visible(), now: clock.now }),
          resolveRef: (ref) => vars.resolveRef(ref).value,
          adapters, ctx: execCtx(targetOf(s, slot), s.id),
          // 等待循环里的每次付费定位都往上汇。不传的话编译不过（WaitDeps 里
          // 这是必填字段），因为"忘接成本"的症状是**总账不动、熔断永不触发**，
          // 而那正是这条预算存在的理由。
          addCost,
          // 响应观测：数据只有浏览器看得见，引擎只判"哪个算命中"。
          // 传 undefined 是合法的（没起浏览器），但谓词里有 response 条件就会报错。
          network: adapters.network, window,
          // 新窗口观测。**基线取在等待开始这一刻**（与动作步骤那侧不同，
          // 那边必须取 perform 之前，见 expectNewPage 那段）。
          /*
           * 基线 = 取数这一刻的计数（= 这条等待开始的时候）。
           *
           * **这里无条件取，而动作步骤那侧是声明了才取**（见 wantsNewPage）。
           * 不对称的原因是**条件化在这一侧要付的代价完全不同**，不是因为
           * "读一次很贵"也不是因为"读一次免费"（count() 在 Web 端只是一个
           * 本地整数读，两边都几乎不要钱）：
           *  - 动作侧的条件就是 `s.expectNewPage` 本身，我本来要读它来决定
           *    要不要做这项检查，所以顺带省掉一次取数是**零额外判据**；
           *  - 这一侧要条件化，就得**遍历谓词树**判断"里面有没有 newPage 条件"，
           *    而那正是 `NoNetworkObserver` 那条注释里已经否决过的做法 ——
           *    新增一种需要窗口/网络的条件时没人会回来加一项，漏加的那一种
           *    恰好退回"被吞成超时"。多一份判据的代价远大于省一次本地读。
           */
          newPage: adapters.newPage, newPageBaseline: adapters.newPage?.count() ?? 0,
          /*
           * `wait{dbRow}.vars` 的绑定。**用与 `db` 步完全同一个 strMap +
           * 同一个 resolveValue**，不是"另写一份看着一样的"：
           * 一条 SQL 写在 `db` 步里与写在 `wait{dbRow}` 里，占位必须同语义
           *（同一套 {path}/{expr}/{gen}/字面量、同样跳过 null、同样 stringify 数组）。
           * 两处各写一份，就会有一个时刻两条路对同一个 IR 给出不同绑定 ——
           * 那是本仓最贵的那类缺陷（"两边数不一样"）。
           *
           * 传的是**这一层的 `vars`**（parallel 分支作用域），不是 rootVars。
           * 用 rootVars 的话分支里 set 的变量在等待里查不到，
           * 症状又是一次"引用未定义" —— §3.3 那族"少继承一层"的又一个入口。
           */
          resolveSqlVars: (v) => strMap(v, (x) => resolveValue(x, vars)),
        });
        if (!r.satisfied) {
          /*
           * **求值报错不是一条超时**，所以这一支必须在下面三支持续走之前分掉。
           *
           * 改前这里只分"满足/不满足"两态，于是 `waitedMs=0 / polls=1` 的那一次
           * 求值中止与等满 2000ms 的真超时给出**逐字节相同**的摘要
           * 「等待超时（2000ms）」（实测 `.scratch/probe-dbrow2.mts`）。
           * 值班人拿到"等满了 2 秒"就会去查"2 秒内为什么没出现"（查产品、查异步落库），
           * 而真相是那条 SQL 压根没被数据库接受 —— 两条路指向完全不同的下一步。
           *
           * **`onTimeout: 'continue'` 在这一支里不再产出 pass**（改前是 pass，
           * 且整场结论 `pass`，实测 `.scratch/probe-dbrow4.mts`）：
           * continue 的语义是"**等不到**也继续"，那是作者对**产品事实**的容忍；
           * 而"这条条件一次都没跑成"是**平台/用例事实**，作者从没容忍过它 ——
           * 他连"跑不跑得起来"都没被问过。让它 pass 就是
           * "一次查询都没发出去，报告说这一步过了"。与 NoConditionAdapter 同一个界线。
           *
           * cause 仍是 env-unavailable，**不改成 case-stale**：报错文本分不清
           * "IR 里那条 SQL 写错了"与"数据库当时连不上"，而这两者的下一步动作不同。
           * 分得清的四种（`dbRow`/`uiPredicate`/`template`/`uiIdle` 缺 adapter）
           * 已经在 wait.ts 里升级成 `NoConditionAdapter` 直接外抛，走不到这里；
           * 剩下的靠摘要里原样带出的那句原始报错定位。
           * 在这里现猜一个 cause，就又是一次"给一个自己分不清的事编个像样的答案"。
           */
          if (r.evalError) {
            const why = `等待条件一次都没求成（第 ${r.polls} 轮、等了 ${r.waitedMs}ms 就中止）：${r.evalError}`;
            const kctx = { waitedMs: r.waitedMs, polls: r.polls, evalError: r.evalError, condition: r.describe };
            if (s.onTimeout === 'continue') return { status: 'error', cause: 'env-unavailable', summary: `onTimeout=continue 用不上：${why}（continue 说的是"等不到也继续"，不是"没条件也继续"）`, keyContext: kctx };
            return { status: 'error', cause: 'env-unavailable', summary: why, keyContext: kctx };
          }
          /*
           * `hintOnTimeout` 只在这三支里加（不是加进 describePredicate）。
           * 见 waits.ts 那个函数的注释：describePredicate 同时进"等待满足"的成功摘要，
           * 过了的等待后面挂一句"你可能选错了字段"是纯噪音。
           * 对 newPage 条件以外的谓词，它返回空串，所以这里对所有真超时的 wait 步骤
           * 统一调，而不需要"先判断这是不是 newPage 等待"—— 又一次少一个判据。
           * （上面那一支不调它：那一支连"等什么"都没走到。）
           */
          const hint = hintOnTimeout(s.condition);
          /*
           * `continue` 那一支也要带 keyContext，**与下面两支同一个形状**。
           * 从前它是三支里唯一不带的一份，而"这轮 pass"不等于"没什么可记的"：
           * 看板要问"这一场有多少条等待其实是等满超时后被放过的"，
           * 靠的是 `jq '.results[] | select(.keyContext.waitedMs)'`，
           * 而 continue 那几行压根没有这个键 —— 于是那个数**恰好漏掉全部被容忍的超时**，
           * 报出来的数字看着像"几乎没有超时"，是最舒服也最害人的一种低估
           *（docs/08 §3 那一族：少一件东西看起来像什么都没少）。
           * 只补这两个键、不补 evalError/polls：那一支走不到 evalError，
           * 而 polls 在三支里都没进过磁盘格式，别为一条测试方便加字段。
           */
          if (s.onTimeout === 'continue') return { status: 'pass', summary: `等待超时但按 onTimeout=continue 继续：${r.describe}${hint}`, keyContext: { waitedMs: r.waitedMs, condition: r.describe } };
          // IR 的 onTimeout 有三个合法取值（waits.ts 的 WaitOptionsSchema.onTimeout：fail/continue/error）。
          // **这里刻意不写行号**：这一句从前写的是 `waits.ts:79`，而它指的那一行在
          // 本轮之前就已经漂了（79 行是 WaitPredicateSchema 的 z.union）。行号是注释里
          // 最容易烂掉的一种引用，改一个名字不会有人回来同步。
          // 早先这里只分 'continue' 与"其余"，于是 **error 是个永远走不到的 schema 取值**：
          // 用户显式要求"等不到就算环境问题"，却拿到一个 fail ——
          // fail 的含义是"产品有 bug"，值班人会去查一个不存在的功能问题。
          if (s.onTimeout === 'error') return { status: 'error', summary: `等待超时（${s.timeoutMs}ms），按 onTimeout=error 判为环境问题：${r.describe}${hint}`, cause: 'env-unavailable', keyContext: { waitedMs: r.waitedMs, condition: r.describe } };
          return { status: 'fail', summary: `等待超时（${s.timeoutMs}ms）：${r.describe}${hint}`, cause: 'env-unavailable', keyContext: { waitedMs: r.waitedMs, condition: r.describe } };
        }
        return { status: 'pass', summary: `等待满足（${r.waitedMs}ms）：${r.describe}`, keyContext: { waitedMs: r.waitedMs } };
      }
      case 'sleep':
        await clock.sleep(s.ms);
        return { status: 'pass', summary: `等待 ${s.ms}ms（lint 会警告裸 sleep）` };

      // ── 变量 ──────────────────────────────────────────────────
      case 'set': {
        for (const [k, v] of Object.entries(s.assign)) vars.setDeep(k, resolveValue(v, vars));
        vars.exportStep(s.id, vars.visible());
        return { status: 'pass', summary: `赋值 ${Object.keys(s.assign).join(', ')}` };
      }
      case 'table': {
        const rows = s.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, resolveValue(v, vars)])));
        // 以前写死 'table'：`as` 声明了却没人读，两个 table 步骤互相覆盖同一个变量。
        // schema 的默认值就是 'table'，所以省略 as 的场景行为一字未变。
        vars.set(s.as, rows);
        vars.exportStep(s.id, { rows });
        return { status: 'pass', summary: `${rows.length} 行数据表 -> $${s.as}` };
      }
      case 'extract': {
        const src = vars.resolveRef(s.from);
        if (!src.found) return { status: 'error', summary: `extract 源未找到：${s.from}`, cause: 'case-stale' };
        const got: Record<string, unknown> = {};
        for (const rule of s.rules) {
          let v: unknown;
          if (rule.mode === 'jsonpath') v = queryOne(src.value, rule.path, { allowAmbiguous: false });
          else if (rule.mode === 'regex') {
            // regex 是给**非 JSON 响应体**用的（HTML/文本接口在国内很常见，见 IR 注释）。
            // 直接 String(响应对象) 会得到 "[object Object]"，于是正则永远不匹配、
            // 报「提取失败」，用户以为是正则写错了 —— 所以按 bodyText → 字符串 body 取值。
            const s0 = src.value as { bodyText?: string; body?: unknown } | undefined;
            const text = typeof s0?.bodyText === 'string' ? s0.bodyText
              : typeof s0?.body === 'string' ? s0.body
              : typeof src.value === 'string' ? src.value
              : s0 && 'body' in s0 ? JSON.stringify(s0.body)
              : JSON.stringify(src.value);
            let re: RegExp;
            try { re = new RegExp(rule.path, 's'); }
            catch (e) { return { status: 'error', summary: `正则本身不合法：${(e as Error).message}`, cause: 'case-stale', keyContext: { pattern: rule.path } }; }
            const m = text.match(re);
            v = m ? (rule.group ? m[rule.group] : m[1] ?? m[0]) : undefined;
            if (v === undefined && rule.required) {
              // 不匹配时把正则在**哪段文本**上试过的也交出去，否则用户只能盲改
              return { status: 'error', summary: `提取失败（regex）：${rule.path} 未匹配`, cause: 'case-stale', keyContext: { from: s.from, pattern: rule.path, sample: preview(text) } };
            }
          } else if (rule.mode === 'header') {
            const hs = (src.value as { headers?: Record<string, unknown> } | undefined)?.headers;
            v = hs?.[rule.path.toLowerCase()] ?? queryOne(src.value, `$.headers.${rule.path}`);
          }
          else v = extractFromAria(String((src.value as { data?: string })?.data ?? ''), rule.path);
          if (v === undefined && rule.required) {
            return { status: 'error', summary: `提取失败（${rule.mode}）：${rule.path}`, cause: 'case-stale', keyContext: { from: s.from, sample: preview(src.value) } };
          }
          vars.set(rule.var, v);
          got[rule.var] = v;
        }
        vars.exportStep(s.id, got);
        return { status: 'pass', summary: `提取 ${Object.keys(got).join(', ')}`, keyContext: redactForDisk(got, 0, CONTEXT_LIMITS) as Record<string, unknown> };
      }
      case 'dataSource': {
        if (!adapters.db) return { status: 'error', summary: 'dataSource 需要 db adapter', cause: 'env-unavailable' };
        if (s.source.type !== 'mysql') return { status: 'error', summary: `P0 仅支持 mysql 数据源（收到 ${s.source.type}）`, cause: 'env-unavailable' };
        /*
         * 第三个参数从前是写死的 `{}` —— 与 `wait{dbRow}` 那个洞同源同修法。
         * 这一处的害法略有不同：dataSource 是**数据驱动的入口**，它的 SQL
         * 十有八九要带条件（"只取这一批要跑的行"），而拿到 `{}` 之后
         * 作者只有两条路：查全表再在 forEach 里筛（慢，且把过滤逻辑挪进用例），
         * 或者自己拼字符串 —— 后者会把一条只读查询变成任意读取。
         */
        const rows = await adapters.db.query(s.source.datasource, s.source.sql, strMap(s.source.vars, (v) => resolveValue(v, vars)), execCtx('api', s.id));
        /*
         * `leaseRows` 默认 true，而**行租约一行代码都没有** —— 那比"没这个字段"更坏：
         * 写用例的人以为两个并发 run 不会抢到同一行，实际会。字段保留（P1 实现时接线），
         * 但每次都在报告里说出来，而不是让它静默地"看起来已启用"。
         */
        if (s.leaseRows) {
          emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'ROW_LEASE_NOT_IMPLEMENTED', detail: 'leaseRows=true，但行租约尚未实现：两个并发 run 可能取到同一行（P1 补）' } });
        }
        vars.set(s.as, rows);
        vars.exportStep(s.id, { rows, count: rows.length });
        return { status: 'pass', summary: `数据源 ${rows.length} 行 -> $${s.as}` };
      }
      case 'script':
        return { status: 'error', summary: 'script 节点在 P0 被禁用（沙箱未实现；它会绕过静态闸）', cause: 'env-unavailable' };

      // ── API ───────────────────────────────────────────────────
      case 'http': {
        if (!adapters.http) return { status: 'error', summary: 'http adapter 未注册', cause: 'env-unavailable' };
        const headers = strMap(s.request.headers, (v) => resolveValue(v, vars));
        const query_ = strMap(s.request.query, (v) => resolveValue(v, vars));
        const url = buildUrl(resolveUrl(s.request.url, ctxBase.env), query_);
        const res = await adapters.http.send({
          method: s.request.method, url, headers, body: s.request.body === undefined ? undefined : resolveValue(s.request.body, vars),
          timeoutMs: s.timeoutMs ?? 30_000, maxBytes: s.maxResponseBytes, followRedirects: s.followRedirects,
          // 只交**引用与身份**，不交值。原先这里是
          // `headers.authorization = 'Bearer ' + ctxBase.secret(s.auth)` ——
          // 引擎由此同时知道了方案（Bearer 是硬编码的，于是 apiKey/basic 写不出来）
          // 和密钥真值（真值在引擎内存里，就能顺着任意一次 keyContext 流到磁盘）。
          // 现在怎么带、带不带、值从哪取，全在 adapter 的 auth 层（docs/05 §2）。
          //
          // 身份取 currentIdentity，**不是 scenario.identity**：后者是场景级的静态值，
          // 于是 useIdentity 切完之后这一行还是拿开头的身份 ——
          // "切身份"那一步自己变绿了，后面的请求却一个没变。
          // 与 openapiCall 用同一个表达式，就是为了两个入口不再各写一份。
          auth: s.auth || identityFor(s.identity)
            ? { ref: s.auth, identity: identityFor(s.identity) }
            : undefined,
        }, execCtx('api', s.id));
        // bodyText 一并导出：regex 提取需要原始文本（HTML/文本接口）。见 extract 的 regex 分支。
        const exports = { resp: { status: res.status, body: res.body, bodyText: res.bodyText, headers: res.headers, durationMs: res.durationMs }, status: res.status, body: res.body };
        vars.exportStep(s.id, exports);
        if (s.saveAs) vars.set(s.saveAs, res.body);
        /*
         * **响应体落证据**，与 openapiCall 那条路同一做法（理由完整写在那一侧：
         * 无条件存、存 bodyText 而非 body、保留策略归存储层）。
         *
         * 这一句以前**只在 openapiCall 里有**。实测（接了 DiskArtifactStore 跑一条
         * 普通 http 步骤拿到 200）：`artifactIds=[]`、磁盘上按 stepId 查到 **0 条**，
         * 而 ARTIFACT_STORE_MISSING 事件也是 0 条 —— 意思是"没配存储"那句警告
         * 压根不会响，因为代码根本没走到需要警告的地方。
         * 症状是 **evidence.zip 看起来正常打开、只有元数据，而里面没有响应体**，
         * 对**手写 http 步骤**的用户（最常见的第一条用例，见 wiring.ts 那条
         * "http adapter 无条件注册"的注释讲的同一个盲区）；走 spec 的用户一切正常，
         * 于是这个洞被"能复现的人少"长期掩盖。本仓这一类的第三例
         * （另两例：confidenceGate 只在解释器、autoEvidence 只修一条路径）。
         */
        const artifactId = await autoEvidence(s.id, 'http-response', res.bodyText);
        return {
          status: 'pass',
          summary: `${s.request.method} ${res.status} ${fmtMs(res.durationMs)}`,
          keyContext: { status: res.status, bytes: res.bytes, truncated: res.truncated },
          ...(artifactId ? { artifactIds: [artifactId] } : {}),
        };
      }
      case 'openapiCall': {
        if (!adapters.http) return { status: 'error', summary: 'http adapter 未注册', cause: 'env-unavailable' };
        const op = await adapters.http.resolveOperation({ docRef: s.docRef, operationId: s.operationId, method: s.method, path: s.path });
        if (op.deprecated) emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'DEPRECATED_OPERATION', detail: s.operationId ?? `${op.method} ${op.urlTemplate}` } });
        const params = strMap(s.pathParams, (v) => resolveValue(v, vars));
        let url = op.urlTemplate;
        for (const [k, v] of Object.entries(params)) {
          // 只替换真实出现的占位符；没出现说明 pathParams 写错了名字 ——
          // 静默忽略会得到"参数没生效但请求照样 200"的用例，所以要响
          const tpl = `{${k}}`;
          if (!url.includes(tpl)) {
            return { status: 'error', summary: `pathParams 里的 "${k}" 不在 ${op.urlTemplate} 的占位符里（拼错了？接口变了？）`, cause: 'case-stale' };
          }
          url = url.replace(tpl, encodeURIComponent(String(v)));
        }
        // 剩余未填占位符必须报错：把 `{id}` 原样发出去得到的是 404，查不到原因
        const leftover = url.match(/\{([^}/]+)\}/g);
        if (leftover) return { status: 'error', summary: `URL 里还有未填的参数：${leftover.join('、')}`, cause: 'case-stale' };
        const qs = strMap(s.queryParams, (v) => resolveValue(v, vars));
        const headers = strMap(s.headers, (v) => resolveValue(v, vars));
        // identity 交给 adapter 解析，**引擎不再自己查密钥**。
        // 原先这里写 `ctxBase.secret('identity:' + s.identity)`，而 CLI 的
        // secretResolver 只认 `secret:<ref>` 形态：'identity:admin' 归一出来是空串，
        // 取回占位符，然后 `if (!tok.startsWith('«'))` 安静地不加头 ——
        // 于是"切了身份"的用例其实一直在用默认身份跑，
        // 而"权限矩阵"那类用例（A 的资源 B 不能读）会**双方都拿到同一个身份**，
        // 表现为"权限测试全绿"，而它压根没测到权限。这是 docs/08 §3 那个缺陷类的又一例。
        //
        // **无条件带上**，不再以"有没有身份"为条件：这个对象的主体是
        // docRef/operationId/method/path —— adapter 拿它去 spec 里查这个 operation
        // 声明了哪个 securityScheme。而绝大多数 operation 都声明了 security、
        // 又由 env 的凭证表决定用哪个 ref，跟"这次有没有切身份"毫无关系。
        // 早先那个 `idForThisCall ? … : undefined` 的写法等于把"没切身份"当成
        // "这个 operation 是公开接口"，于是所有走 spec 的正常请求都变成匿名请求。
        const authIntent = {
          identity: identityFor(s.identity),
          docRef: s.docRef,
          // 三个都**优先取解析后的值**，步骤上声明的那个只作兜底。
          // adapter 拿 method + path 去 spec 里定位这个 operation、读它的 security，
          // 而 IR 里 method/path 是 optional（大多数用例只写 operationId）——
          // 交下来 undefined 等于让 adapter 定位不到，于是"按 spec 自动加鉴权"
          // 对这类用例整个失效，而且失效方式是"没加头"，看起来像后端不要鉴权。
          operationId: op.operationId ?? s.operationId,
          method: op.method ?? s.method,
          path: op.urlTemplate ?? s.path,
        };

        // 请求侧 schema 校验（IR 的 validateRequest 默认 true）。
        // **但对负向策略只记事件不拦**：requiredMissing / typeViolation / negativeFuzz
        // 的用意就是发一个不合法的请求去看后端拒不拒绝（docs/05 §3）。
        // 在这里一律拦，等于把最有价值的一类用例（后端缺参数校验）全部作废 ——
        // 而且废得很安静：用例会变成"跳过"，覆盖率看着还挺高。
        const bodyForSend = s.body === undefined ? undefined : resolveValue(s.body, vars);
        if (s.validateRequest && adapters.http.validateRequest && !NEGATIVE_STRATEGIES.has(s.strategy ?? '')) {
          const v = await adapters.http.validateRequest({ docRef: s.docRef, operationId: op.operationId }, bodyForSend);
          if (!v.ok) {
            if (v.violations.length) emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'REQUEST_SCHEMA_MISMATCH', detail: v.violations.join('; ') } });
            return {
              status: 'error', cause: 'case-stale',
              // 发出去之前挡下来：本地的"少了 amount 字段"比后端的"400 原因未知"有用得多
              summary: `请求体不符合 spec（发送前拦截）：${v.violations.join('; ') || '结构不符'}`,
            };
          }
        } else if (s.validateRequest && !adapters.http.validateRequest) {
          // 用户要求校验但 adapter 没实现 —— 不能当成"校验通过"
          emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'VALIDATE_REQUEST_UNAVAILABLE', detail: 'http adapter 未实现 validateRequest，本步未做请求校验' } });
        }
        const res = await adapters.http.send({
          method: op.method, url: buildUrl(resolveUrl(url, ctxBase.env), qs), headers,
          body: bodyForSend,
          timeoutMs: s.timeoutMs ?? 30_000, maxBytes: 10_000_000, followRedirects: false,
          // 就是上面那个 authIntent。它原先算完就被丢在这里不用了 ——
          // 而它上面的注释正好在讲"为什么必须交给 adapter"。
          // 这类 bug 读代码看不出来（变量确实"被使用"了，用在上一行的字面量里），
          // 只有断言"send 收到的第二参里有它"才拦得住。
          auth: authIntent,
        }, execCtx('api', s.id));
        // 响应侧符合性检查：**只在环境显式声明 spec 可信时做**，且**只上报**。
        // 两条都来自 docs/05 §1.1，弄反任何一条都会烧掉红绿的可信度：
        //  - 默认开 -> schema 与实现的小出入刷红几千次 -> 团队关掉整个门禁；
        //  - 判失败 -> "文档与实现谁错了"混进"功能坏了"里 -> 所有红灯都被当成误报。
        if (ctxBase.env.specAuthoritative === true && adapters.http.validateResponse) {
          const v = await adapters.http.validateResponse({ docRef: s.docRef, operationId: op.operationId }, res.status, res.body);
          // 不带 status：这不是步骤的状态，也不该进 tally。
          // （曾经写成 status: 'healed' —— healed 在六态机里意思是"定位自愈待人审"，
          //  借来表示"文档不符"会让自愈队列里混进一堆跟定位无关的东西。）
          if (!v.ok) emit({ kind: 'lint.reported', stepId: s.id, data: { code: 'RESPONSE_SCHEMA_MISMATCH', detail: v.violations.join('; '), reportOnly: true } });
        }
        vars.exportStep(s.id, { resp: { status: res.status, body: res.body, bodyText: res.bodyText, headers: res.headers, durationMs: res.durationMs }, status: res.status, body: res.body, strategy: s.strategy });
        if (s.saveAs) vars.set(s.saveAs, res.body);
        // **响应体落证据**。这一句之前不存在：saveArtifact 端口定义了却没人调用，
        // 于是 evidence.zip 里**没有响应体** —— 而失败排查第一个要看的就是它。
        // M6 的判据是"一次失败 run 产出可独立打开的 evidence.zip"，
        // 一个不含响应的证据包只是四份元数据，打开它什么也查不出来。
        //
        // 为什么在这里**无条件存**（而不是"失败才存"）：
        // 步骤级"失败"经常不在 http 这一步 —— 200 回来后由 assert 步骤判红。
        // 按"这步没过才存"就会正好漏掉那些响应体。
        // 保留策略**归存储层**（它能看磁盘、能按 run 收尾清理），
        // 不在引擎里加 if：引擎只负责说"这是证据"。
        //
        // 存的是 bodyText（**原始文本**）而不是 body（已 JSON.parse 的对象）：
        // 重新 stringify 出来的东西和线上发的字节不再相等（键序、空格、数字精度、
        // 未引号化的 key 全可能变），而"后端到底发了什么字节"常常就是问题本身。
        const artifactId = await autoEvidence(s.id, 'http-response', res.bodyText);
        return {
          status: 'pass',
          summary: `${op.method} ${res.status} ${fmtMs(res.durationMs)}`,
          // 传输细节走 keyContext：step.finished 事件会把它带进 trace.jsonl，
          // 这正是 docs/05 §4 要的"截断要在 trace 里标 truncated"的落点。
          // （早先这信息由 adapter 自己发一条 kind:'http' 的事件承载，
          //  而那个 kind 不合法、trace 读回时被丢弃 —— 等于这条要求静默失效。）
          keyContext: { status: res.status, strategy: s.strategy, bytes: res.bytes, ...(res.truncated ? { truncated: true } : {}) },
          ...(artifactId ? { artifactIds: [artifactId] } : {}),
        };
      }

      // ── Web / 设备（P2/P4 实现，此处保证语义与状态正确）────────
      case 'navigate': case 'act': case 'capture': case 'tap': case 'input': case 'swipe': case 'key': case 'app': case 'logcat': {
        const uiOrDev = s.kind === 'navigate' || s.kind === 'act' || s.kind === 'capture' ? adapters.ui : adapters.device;
        if (!uiOrDev) return { status: 'error', summary: `${s.kind} 需要 ${s.kind === 'navigate' || s.kind === 'act' || s.kind === 'capture' ? 'ui' : 'device'} adapter`, cause: 'env-unavailable' };
        const locator = 'locator' in s ? s.locator : 'target' in s ? s.target : undefined;
        let resolved: ResolveResult = { resolvedBy: 'n/a', rung: 0, confidence: 1, nonReplayable: false, handle: '' };
        if (locator && 'resolve' in uiOrDev) {
          resolved = await (uiOrDev as { resolve: (l: unknown, c: ExecContext) => Promise<ResolveResult> }).resolve(locator, execCtx(targetOf(s, slot), s.id));
          emit({ kind: 'locator.resolved', stepId: s.id, data: { ...resolved } });
        }
        /*
         * **单次定位的预算由引擎审**（`LocatorSpec.maxCostUsdPerResolve`，schema 默认 $0.02）。
         *
         * 这个字段以前**全仓没有任何地方读它**（grep 只命中 schema 那一行），
         * 而执行侧连一个顶替的常数都没有 —— 比 `confidenceGate` 那条更彻底：
         * 那条至少有个写死的 0.99 顶着、行为"看起来像按门限判"，这条是
         * **人在 IR 里配了预算，花多少都不管**。docs/03 §2 把 step 级预算写成
         * 引擎的"一等运行时能力"（超 step 就该降级到便宜档位），实现上那一层没接过。
         *
         * 判据与记账都在 `chargeResolve`（resolve.ts，等待循环也调那一份）。
         * 超预算抛 `LocatorBudgetError`，由 `runStep` 的 catch 收成
         * `fail` + `case-stale` —— 为什么不是 `error` 写在那一族的注释里
         * （一句话：`error` 走退出码 5，而 CI_HINT 教 CI"5 → 重试一次"，
         *  那会把同一笔已经花掉的钱再花一遍）。
         *
         * 这里**只审不降**：真正"降到便宜档位"是 adapter 阶梯内部的事
         * （它有便宜档位可用时压根走不到贵的那一档）。引擎这层的价值是
         * **兜住 adapter 没兜住的情况**，并把超支变成看得见的红灯，
         * 而不是静默接受一份超出声明的账单。
         *
         * 超支那一步的钱已经 `addCost` 进总账了（先记账再判，见 chargeResolve），
         * 异常路径下这一步自己的 `results` 行 costUsd 会是 0 —— 这是**故意的**：
         * 那一步没验成任何东西，把整笔花费记在它名下会让"这一步值多少钱"
         * 与"这次定位失败花了多少"两件事混成一个数。总账才是真数，
         * 明细在 keyContext.spentUsd（异常里带的），JUnit/HTML 都读得到。
         */
        chargeResolve(resolved.costUsd ?? 0, locator, addCost, { resolvedBy: resolved.resolvedBy, rung: resolved.rung });
        /*
         * **接住 perform 的返回值**。原先是 `await ....perform(...)` 直接丢掉，
         * 于是 adapter 在动作里落的证据（capture 的截图、tap 后的 hierarchy）
         * 没有任何通道进 StepResult.artifactIds —— 真跑一次 Web 的 capture 步骤，
         * evidence 清单里那个前缀是 `未归属:shot`。
         * 归属不该由"adapter 有没有自己 emit 过一条事件"决定，
         * 那是兜底路径；正常路径是**谁产的谁带回来**。
         */
        /*
         * 新窗口的**基线必须取在 perform 之前**。这是这条断言唯一容易写错的地方：
         * 取在 perform 之后的话，`window.open()` 这种"点击当场把窗口建好"的
         * 最快、也最常见的情形会被算成"基线之前就有了，不算"，于是等满超时 ——
         * 一条**假红**，而人会去查一个其实正常工作的弹窗。
         * （`expectResponse` 那边不需要这一行：它用的是 window 对象，
         *  起点在本步开始时就已经定好了，见 newResponseWindow。）
         *
         * **只在真的声明了时才取数**。以前是无条件取，于是每个 act 步骤
         * （绝大多数根本不声明这个字段）都多一次跨进程观测：
         * 白做的功还是小事，要紧的是"一个没声明的字段悄悄改变了执行路径"
         * 正是本仓反复在防的那个形状。测试里那条 `calls === 0` 就是它的闸。
         */
        const wantsNewPage = s.kind === 'act' && s.expectNewPage;
        const newPageBaselineBefore = wantsNewPage ? (adapters.newPage?.count() ?? 0) : 0;
        /*
         * **`hoverThen` 声明了就必须真的做第二件事，而它今天没人做。**
         *
         * 这不是"少一个功能"：`act{action:'hover', hoverThen:'click'}` 的实际行为是
         * hover 完就停、**步骤 pass**。作者声明了一个动作、平台一个都没做、还报绿 ——
         * 与 `expectNewPage` 本轮修掉的那条同族同方向（docs/14 §4.3 子类 (a)）。
         * 而它比 `expectNewPage` 更隐蔽：默认值是 `'none'`，
         * 所以"声明了 click"与"没声明"**跑起来一模一样**，连一个可疑的信号都没有。
         *
         * 为什么在这里拦而不是"实现掉"：docs/06 §2 要这个字段的场景是
         * "hover **A** 才出现 **B**、再点 **B**" —— 两个元素，而 `act` 只有**一个** locator。
         * 也就是说这个字段**按现有 schema 表达不了它自己的动机**，
         * 硬做出来只能做"对同一个元素 hover 完再点它自己"，
         * 那**恰好覆盖不了下拉菜单** —— 一个看似实现、实则语义不符的功能，
         * 比不实现更容易让人以为验到了。语义要先定（见 docs/06 §2），本轮先把假绿堵住。
         *
         * **归因是 error 而不是 fail**：产品没做错任何事，是**平台**没实现这一步。
         * 判 fail + product-bug 会让人去提一个"点击不生效"的 bug。
         * 沿用 `script` 步骤那一处（本文件 "script 节点在 P0 被禁用"）的形状：
         * **未实现的功能一律 error，不静默 pass**。
         * 退出码会是 RUNTIME(5) 而不是 ENV(4)（门禁把所有 error 统一按"没测成、可重试一次"处理），
         * 所以那句"可重试"是白花的 —— 但**红**是重要的那一半：
         * 静态那一半在 `lint.ts` 的 `HOVER_THEN_NOT_IMPLEMENTED`（error 级，
         * 跑之前就 exit 3，一个浏览器都不用起）。**两层都要**：
         * `atest run` 默认不跑 lint（那是 commands.ts 里刻意的设计），
         * 只有静态那一半的话直接 run 仍然是绿的。
         */
        if (s.kind === 'act' && s.hoverThen !== 'none') {
          return {
            status: 'error',
            summary: `act 声明了 hoverThen:'${s.hoverThen}'，但"hover 完紧接着做第二件事"尚未实现 —— `
              + '这一步只做了 hover，第二件事**一个都没做**（把它算成通过就是假绿）。'
              + '且 IR 的 act 只有一个 locator，而该字段要的场景（hover A 才出现 B、再点 B）需要两个元素，'
              + '所以不能靠"顺手实现一下"了结：语义未定，明细见 docs/06 §2 与 docs/08 §3',
            cause: 'env-unavailable',
            keyContext: { hoverThen: s.hoverThen, action: s.action },
          };
        }
        const performed = 'perform' in uiOrDev
          ? await (uiOrDev as { perform: (o: unknown, t: unknown, c: ExecContext) => Promise<{ artifactIds?: string[] } | void> })
            .perform(opOf(s), resolved, execCtx(targetOf(s, slot), s.id))
          : undefined;
        /*
         * **动作步骤上的两个"声明了就必须发生"的检查：`expectResponse`（docs/06 §3）
         * 与 `expectNewPage`。** 两个字段以前都是"IR 有、执行侧没人读"：
         * `expectResponse` 被 `opOf` 丢掉所以 adapter 压根拿不到，
         * `expectNewPage` 连读的人都没有 —— 实测 `expectNewPage: true` 的步骤
         * **在什么都没打开时也判 pass、退出码 0**。而这两条断言的价值恰恰是抓
         * "点了查询但接口没发"与"点了导出但弹窗被拦截"，静默通过等于反向保证。
         *
         * 两条都走 `waitUntil` + 与 wait 步骤**同一个条件判据**，不是各写一份：
         * 动作步骤自己判一次的话就有两处决定"什么算满足"，
         * 迟早出现"同一个声明在等待里算过、在动作步骤里不算"。
         *
         * **两条都必须能单独让这一步失败，且不能互相跳过。**
         * 这里原先只有一条 `if (expectPattern !== undefined) { …; return … }`。
         * 那个 return 会让"在它后面再加一条检查"的写法**在两个字段同时声明时静默失效**
         * —— 我这次差点就这么加，而测试会因为"只声明 expectNewPage"的用例全绿，
         * 看不出来两个一起声明时那条检查根本没跑。
         * 所以下面是**各自把结论收进 notes/failed，最后一次性判**。
         *
         * 归因：没等到都是 **fail + product-bug**，不是 error。
         * 与定位超预算那条相反，这里没有"已经花掉的钱再花一遍"的风险
         * （error 走退出码 5，而 CI_HINT 教 CI 重试一次），
         * 而"点了按钮但那个接口没发/那个窗口没开"就是被测产品与用例声明不符。
         * **接线缺失是另一件事**：没配 `adapters.network` / `adapters.newPage` 时
         * `NoNetworkObserver` / `NoNewPageObserver` 会从 waitUntil 抛出来，
         * 落到 error + env-unavailable（"去查平台"），不背产品 bug 这个名。
         */
        const expectPattern = s.kind === 'navigate' || s.kind === 'act' ? s.expectResponse : undefined;
        const notes: string[] = [];
        const ctxExtra: Record<string, unknown> = {};
        /*
         * 是**数组**而不是一个 `let failed`（我第一版写的是后者配 `??=`）：
         * 两个字段可以同时声明、也可以同时不满足，那种时候只留第一条摘要
         * 就是把第二条的诊断信息扔掉 —— 人会修好接口那一条、再跑一次，
         * 然后才看见"哦窗口也没开"。一次报全比省一行代码值钱。
         *
         * cause 取**第一条**：今天两条都判 product-bug，所以根本没有排序问题。
         * 将来若有第二条的 cause 不同（比如 case-stale），**别沿用这个位置顺序** ——
         * 那时要先定"哪个归因更该出现在门禁/JUnit 的 cause 列"，
         * 而那是一次口径决定，不该由数组顺序代劳。
         */
        const notMet: Array<{ cause: NonNullable<StepResult['cause']>; summary: string }> = [];

        if (expectPattern !== undefined) {
          const pattern = expectPattern;
          const r = await waitUntil({
            predicate: { type: 'response', urlPattern: pattern },
            // 默认 10s 与 wait 步骤同一档（不新造一个数）。作者写了 timeoutMs 就用他的。
            timeoutMs: s.timeoutMs ?? 10_000,
            clock, evalExpr: () => { throw new Error('response 条件不该走表达式求值'); },
            resolveRef: () => undefined, adapters, ctx: execCtx(targetOf(s, slot), s.id),
            addCost, network: adapters.network, window,
            newPage: adapters.newPage, newPageBaseline: newPageBaselineBefore,
            // 这里的谓词是本函数内部造的 `{type:'response'}`，永远到不了 dbRow 那一支。
            // 给一个**会抛**的实现而不是 `() => ({})`：字段是必填的，而"返回空表"
            // 会让将来有人在这里塞进 dbRow 条件时静默拿到未绑定的 SQL（= §3.2 那个洞复活）。
            resolveSqlVars: () => { throw new Error('expectResponse 的内部谓词不该走到 SQL 绑定'); },
          });
          const hits = window.matchCount(pattern);
          if (!r.satisfied || hits === 0) {
            notMet.push({
              cause: 'product-bug',
              summary: `${s.kind} 声明了 expectResponse "${pattern}"，但窗口内 ${window.seenCount} 条响应里没有它`
                + `（等了 ${r.waitedMs}ms / ${r.polls} 次轮询）`,
            });
          }
          // 命中数与状态进 keyContext（会进 JUnit 的 context= 与 HTML 报告）。
          // **不走 emit 一条 lint.reported 事件**：门禁不读 events（这条纪律见
          // interpreter 里 noteNeverRun 的注释），发一条"看着像提醒、实际谁也不读"的
          // 事件正是本仓禁止的那种装饰；而 LintCode 那一族是要配 LINT_DOCS 与文档的，
          // 为一个纯信息项加一条码会把"lint 码 = 需要人处理的事"这个口径弄浑。
          // 另外这里**不给 URL**：URL 可能带 token/手机号，而 redactForDisk 的
          // 值形态规则判不出查询串里的密钥（只认 JWT/AKIA/sk-/Bearer 形状）。
          // 状态码不是敏感值，够定位问题了。
          notes.push(`expectResponse "${pattern}" 命中 ${hits} 条（状态 ${window.matchedStatuses(pattern).join('/')}）`);
          ctxExtra.expectResponse = pattern;
          ctxExtra.expectResponseHits = hits;
          ctxExtra.expectResponseStatuses = window.matchedStatuses(pattern);
        }

        if (wantsNewPage) {
          const r = await waitUntil({
            predicate: { type: 'newPage' },
            timeoutMs: s.timeoutMs ?? 10_000,
            clock, evalExpr: () => { throw new Error('newPage 条件不该走表达式求值'); },
            resolveRef: () => undefined, adapters, ctx: execCtx(targetOf(s, slot), s.id),
            addCost, network: adapters.network, window,
            newPage: adapters.newPage, newPageBaseline: newPageBaselineBefore,
            // 同 expectResponse 那处：内部谓词是 `{type:'newPage'}`，到不了 SQL 绑定
            resolveSqlVars: () => { throw new Error('expectNewPage 的内部谓词不该走到 SQL 绑定'); },
          });
          const opened = (adapters.newPage?.count() ?? 0) - newPageBaselineBefore;
          if (!r.satisfied || opened <= 0) {
            notMet.push({
              cause: 'product-bug',
              summary: `${s.kind} 声明了 expectNewPage，但等 ${r.waitedMs}ms / ${r.polls} 次轮询后`
                + '页面没有新开任何标签页或窗口（弹窗被拦截？按钮压根没绑 window.open？'
                + '还是这个动作本来就不该开新窗口 —— 那就把这个字段去掉）',
            });
          }
          notes.push(`expectNewPage 新开 ${opened} 个窗口`);
          ctxExtra.expectNewPage = true;
          ctxExtra.newPagesOpened = opened;
        }

        if (notMet.length) {
          return {
            status: 'fail', cause: notMet[0]!.cause,
            summary: notMet.map((f) => f.summary).join('；'),
            keyContext: ctxExtra,
          };
        }
        if (notes.length) return { status: 'pass', summary: `${s.kind} ${notes.join('；')}`, keyContext: ctxExtra };
        /*
         * **置信度门取人在 IR 里写的那个值**（`LocatorSpec.confidenceGate`，schema 默认 0.85）。
         *
         * 这里原先写的是 `confidence < 0.99 ? 'healed' : 'pass'` —— 一个与声明无关的常数，
         * 而 `confidenceGate` 全仓**没有任何地方读它**（`grep` 只命中 schema 与 lint 测试的 fixture）。
         * 那就是本仓立过多次的那个缺陷类「schema 有字段、执行侧没人读」的又一例，
         * 而且方向是**假绿**：写 `confidenceGate: 1.0`（"只接受完全匹配"）的人，
         * 在 confidence=0.99 时按 0.99 判成 pass，按他自己写的门限则尚未毕业。
         * 实测（device adapter 返回 0.99）：`gate=1.0` => `tap=pass`、退出码 **0**、
         * attention 空、`tally.healed=0`。
         *
         * **status 与 healed 必须同源**。以前一个看 0.99、一个看 `rung >= 6`，
         * 于是能产出 `status:'pass'` + `healed:true` 这种组合，而下游两处都只看 status：
         * `tally` 按 `status==='healed'` 计数、门禁的 `healed` 集合也是按 status 过滤的，
         * 于是那个旗标**在报告里等于不存在**（实测同上）。
         * 阶梯掉到第 6 级以后本来就写着"必须被看见，否则自愈会慢慢把用例改成永远通过"，
         * 而它当时是看不见的。
         *
         * **取不到 locator 时不需要兜底常数**：`app`/`logcat` 的 target 可选，
         * 那种情况下 `resolved` 是上面的合成默认值（confidence 1、rung 0），
         * `1 < gate` 对任何 gate ≤ 1 都为假 => pass。所以这里**不再抄一份 0.85**，
         * 免得 schema 改默认值时又多一个不会跟着改的地方。
         */
        const gate = locatorGate(locator);
        // 掉级（rung>=6）与低于门限是同一件事的两种说法："这次不是靠便宜可信的路径过的"，
        // 所以合成一个判据而不是两个字段各算一遍 —— 分开算就是上面那个洞的成因。
        const needsReview = resolved.confidence < gate || resolved.rung >= 6;
        return {
          status: needsReview ? 'healed' : 'pass',
          summary: `${s.kind} ${resolved.resolvedBy}${resolved.confidence ? ` (${resolved.confidence.toFixed(2)})` : ''}`
            + (resolved.confidence < gate ? `，低于声明的置信度门 ${gate}` : ''),
          resolvedBy: resolved.resolvedBy, rung: resolved.rung || undefined, confidence: resolved.confidence,
          nonReplayable: resolved.nonReplayable,
          healed: needsReview,
          // adapter 这次动作产的证据。**去重**：内容寻址下同内容同 id，
          // 而重试/循环会让同一次动作跑两遍，重复 id 进 artifactIds 会让
          // 证据包与 JUnit 里"这一步产了几份证据"这个数虚高
          ...(performed?.artifactIds?.length
            ? { artifactIds: [...new Set(performed.artifactIds)] }
            : {}),
        };
      }
      case 'device': {
        if (!adapters.device) return { status: 'error', summary: 'device adapter 未注册（P4）', cause: 'env-unavailable' };
        /*
         * **第二个 device 步先还前一个**（docs/15 §3.1：原来是裸赋值）。
         *
         * 为什么"报错"而不是"静默换设备"：换设备会让**前面那些步骤跑在另一台机器上**，
         * 而报告的证据与结论看起来是连贯的一整条。还掉旧的是唯一能让"两步各要一台设备"
         * 这件事成立的读法。
         *
         * 还旧租约用**旧租约自己的 target**，不是写死 'android'（同 §3.1 那一行）。
         *
         * ## `slot.owns` 那道闸是本轮加的（并发下会漏还真机）
         *
         * 借来的租约（`parallel` 分支从外层拿到的那一台）**不由这里释放**：
         * 那是上层正在用的设备，还回池子之后上层剩下的步骤会跑在一台已被别人领走的机器上，
         * 而报告看起来连贯。所以"手上有一台"**不足以**成为释放的理由，还得是"这台是我拿的"。
         * 不释放的同时**照旧新拿一台**（下面那两行），于是"外层一台 + 本层另一台"这种
         * 双设备用例（两台手机对聊）今天是能写的 —— 这一点算这次修法的**副作用收益**，
         * 而原来那段注释说的"IR 今天表达不了同时持两台"从此不再成立（改口记在 docs/15 §3.1）。
         * 另拿一台这件事要说进日志：它意味着这次 run 同时占着两台真机，
         * 静默做和大声做在设备农场里是完全不同的两件事。
         */
        if (slot.lease && slot.owns) {
          const prev = slot.lease;
          slot.lease = undefined;
          slot.owns = false;
          try {
            await adapters.device.release({ id: prev.id }, execCtx(prev.target as ExecContext['target'], s.id));
            emit({ kind: 'log.emitted', stepId: s.id, data: { level: 'info', message: `旧租约 ${prev.id} @ ${prev.deviceRef} 已被第二个 device 步替换并归还` } });
          } catch (e) {
            // 还不掉不拦新租约：拦了会把"第二个 device 步"变成必然失败，
            // 而泄漏这件事已经由这句日志说出去了（漏在明处 vs 假在暗处）。
            // **用 log.emitted 而不是新造一个 lint code**：TraceEventKind 里没有
            // lease.released，LINT_DOCS 里也没有 LEASE_RELEASE_FAILED —— 在这儿随手
            // 造一个"看起来有出处的码"，就是本仓反复记的那族"有码没登记"。
            emit({ kind: 'log.emitted', stepId: s.id, data: { level: 'warn', message: `替换租约时旧租约没还掉（${prev.id} @ ${prev.deviceRef}），这台设备可能一直被占着：${errSummary(e)}` } });
          }
        } else if (slot.lease) {
          emit({ kind: 'log.emitted', stepId: s.id, data: { level: 'info', message: `本层另申请一台设备；上层传下来的租约 ${slot.lease.id} @ ${slot.lease.deviceRef} 保留不动（由申请它的那一层归还）` } });
        }
        const l = await adapters.device.lease(s.require, execCtx(s.target, s.id), s.leaseMs);
        slot.lease = { id: l.id, deviceRef: l.deviceRef, target: s.target, state: 'leased', acquiredAt: new Date(clock.now()).toISOString(), expiresAt: new Date(l.expiresAt).toISOString(), holder: runId, renewable: true };
        // 这台是本槽位自己拿的 —— 于是"收尾时由谁还"这件事有了唯一答案（见 LeaseSlot.owns）
        slot.owns = true;
        emit({ kind: 'lease.acquired', stepId: s.id, data: { device: l.deviceRef, lease: l.id, leaseMs: s.leaseMs } });
        return { status: 'pass', summary: `设备 ${l.deviceRef}` };
      }
      case 'watcher': {
        stepCtx.watchers.push({ rules: s.rules.map((r) => ({ ...r, hit: 0 })) });
        return { status: 'pass', summary: `守望 ${s.rules.length} 条规则（容器级生效）` };
      }
      case 'manualHandoff': {
        emit({ kind: 'manual.started', stepId: s.id, data: { reason: s.reason, recordActions: s.recordActions } });
        if (!adapters.device) return { status: 'skipped', summary: `人工介入跳过（无 device adapter）：${s.reason}` };
        return { status: 'skipped', summary: `等待人工接管：${s.reason}` };
      }
      case 'useIdentity': {
        /**
         * 这一步原先是 `return { status: 'pass', summary: '切换身份 X' }` —— **什么都没切**。
         * IR 里有字段、解释器回了个 pass，写"权限矩阵"用例的人会看到全绿，
         * 而所有请求都在用同一个身份发。这是本仓反复出现的"schema 有字段、执行侧没人读"
         * 的最坏一例：前几例至少会失败，这一例**报告成功**。
         *
         * 现在它真的改 currentIdentity。身份值本身仍不进变量空间（Agent 读到 token
         * 就能把它写进生成的用例里提交，docs/03 §5），只有名字进 trace。
         * 具体取哪个凭证由 adapter 按 (docRef, identity) 查凭证表。
         */
        const from = currentIdentity;
        currentIdentity = s.identity;
        return {
          status: 'pass',
          summary: `切换身份 ${from ?? '(默认)'} → ${s.identity}`,
          // preserveSession=false 的含义是"别把上一个身份的会话带过来"。
          // 会话（cookie jar / storageState）在 adapter 侧，这里只能把要求带出去。
          keyContext: { identity: s.identity, preserveSession: s.preserveSession, secrets: s.secrets.length },
        };
      }

      // ── 断言与横切 ─────────────────────────────────────────────
      case 'assert': case 'assertPage': case 'assertUi': case 'assertLlm': case 'assertPerf': {
        // 传的是**分支作用域**那一份（dispatch 的 vars 形参），不是 vars：
        // 断言里 `$xxx` 读的是这一支看得见的变量。写成 vars 的话，
        // "parallel 分支里断言自己那一支刚算出来的值"会读到共享帧那份或干脆读不到。
        const r = await evaluateAssertions(s, { vars, adapters, ctx: execCtx(targetOf(s, slot), s.id), clock, addCost, emit: (e) => emit({ kind: e.kind as TraceEvent['kind'], stepId: e.stepId, data: e.data }) });
        vars.exportStep(s.id, { assertion: r });
        return r;
      }
      case 'db': {
        if (!adapters.db) return { status: 'error', summary: 'db adapter 未注册', cause: 'env-unavailable' };
        const rows = await adapters.db.query(s.datasource, s.sql, strMap(s.vars, (v) => resolveValue(v, vars)), execCtx('api', s.id));
        if (s.assignTo) vars.set(s.assignTo, rows);
        vars.exportStep(s.id, { rows, count: rows.length });
        return { status: 'pass', summary: `DB ${rows.length} 行` };
      }
      case 'log':
        emit({ kind: 'log.emitted', stepId: s.id, data: { level: s.level, message: interpolate(s.message, vars) } });
        return { status: 'pass', summary: 'log' };
      case 'fail':
        // 不再需要 `as StepResult['cause']`：FailStepSchema.cause 现在就是 FailureCause。
        // 留着那个 cast 的话，将来把 schema 侧放宽成 z.string() 也不会红 ——
        // 而它放宽一次，非法归因就能一路写进证据包（StepResultSchema 读不回来）。
        return { status: 'fail', summary: s.reason, cause: s.cause ?? 'product-bug' };
      case 'noop':
        return { status: 'pass', summary: 'noop' };
      default:
        return { status: 'error', summary: `未知步骤类型 ${(s as Step).kind}`, cause: 'env-unavailable' };
    }
  };

  /*
   * 值求值走**共享实现**（resolve.ts）。第二种执行形态（压测预编译）也调它 ——
   * 两条路径必须逐字节同语义，否则"功能全绿、压测报退化"能查三天。
   *
   * `vars` 是必填、**没有默认值**：给了默认值，"忘了用分支作用域"就编译得过去，
   * 于是 parallel 分支里的一句表达式悄悄读到共享作用域 —— 表现是并发用例偶发失败、
   * 单跑必过，正是这一串改动要消灭的那类 bug。让编译器管比写在注释里可靠。
   */
  const rootScope: ValueScope = { vars: rootVars, clock };
  const resolveValue = (v: unknown, vars: VarSpace): unknown =>
    resolveValueShared(v, vars === rootVars ? rootScope : { vars, clock });
  function interpolate(text: string, vars: VarSpace): string {
    return text.replace(/\$[A-Za-z_][\w.[\]-]*/g, (m) => {
      try { const r = vars.resolveRef(m); return r.found ? String(r.value ?? '') : `⟨未定义:${m}⟩`; } catch { return `⟨错误:${m}⟩`; }
    });
  }
  const tally = { pass: 0, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 } as RunReport['tally'];
  /**
   * setup 是否失败 / body 是否跑过 / teardown 结果的起始下标。
   * resultBoundary 用来把 teardown 的结果排除在**整体状态**之外 —— 但**不排除**出
   * 通过率分母：清理没做干净是真问题，藏起来只会让环境越来越脏。
   */
  let setupPhaseFailed = false;
  let bodyRan = false;
  let resultBoundary = -1; // -1 = 还没进 teardown
  /**
   * 被中断时记下**分类与原因**，最后放进 `RunReport.aborted`。
   * 用局部变量而不是只在 catch 里 emit：事件流是**追加式**的，
   * 任何读报告的人都要先扫一遍 events 才能知道"这次是不是跑完了"，
   * 而"这次跑完了没"是报告的**头部**事实（门禁、摘要文字、JUnit 计数都读它）。
   */
  let interruption: { kind: AbortKind; reason: string } | undefined;
  /**
   * teardown **有没有开跑**（不是"有没有跑完"）。唯一用途：让 finally 知道要不要补跑它。
   *
   * 判据是"开跑"而不是"跑完"，因为 finally 里再跑一遍 teardown 的代价是**第二次副作用**
   * （DELETE 两次、释放两次锁、GC 两遍），而"跑完没有"这件事 td.status 已经报出来了。
   */
  let teardownStarted = false;

  /**
   * 跑 teardown。**两条路共用这一个实现**（正常走完 body 之后 / 被中断之后在 finally 里补），
   * 因为「teardown 默认必跑（含 data GC）」是 IR 侧的契约，而契约有两份实现时
   * 迟早只改其中一处 —— 本文件为这类漂移记过不止一次账。
   *
   * **本轮之前只有第一条路**，实测（body 中途被取消，teardown 里一条清理步骤）：
   *
   * ```
   * status = pass   results = seed:pass, slow:pass   teardown 跑了吗 = false
   * ```
   *
   * 后果不是"少跑几步"这么轻：**环境里留下了这次 run 造的数据，而没有任何一行说它留下了** ——
   * `TEARDOWN_FAILED` 挂在 try 里所以也不发，于是"清理没做"在报告、trace、证据包里零痕迹。
   * 与 docs/08「少验了什么要有一行可指」正好相反，而按一次 Ctrl-C 是最常见的取消场景。
   *
   * 三条实现约束，都在被测（`interruption.test.ts` 后半那三条）：
   *  1. **`cleanupPhase = true`**（见 `checkAbort` 上那段）。不置的话 teardown 第一步
   *     就被 run 级超时/取消再拦一次，这条修复等于没做 —— 我第一版就是这个形状。
   *     顺带这也让"信号在清理中途才到"不再打断清理（契约是无条件必跑）。
   *  2. **`teardownStarted` 一置就不重跑**：清理步骤不保证幂等（DELETE 两次会 404，
   *     那把一次正常清理变成假失败）。
   *  3. **它自己抛也不能冒出去**：清理失败不该把已产出的结论改写成运行异常
   *     （与「teardown 失败不进整体状态」同一条判断）。但**不静默** —— 照发
   *     `TEARDOWN_FAILED`，不新造码的理由见下面租约那段。
   *     能走到 catch 的只有成本熔断（run 级超时这道闸已暂停，其它异常在 runStep
   *     里就收成 error 结果了）：熔断**照生效**，因为"清理不该把钱再花一遍"正是预算存在的理由。
   *     那时也如实记 `aborted`（这次 run 确实没走完），只是不覆盖已有的中断成因。
   */
  const runTeardown = async (why: 'normal' | 'interrupted'): Promise<void> => {
    if (!scenario.teardown.length || teardownStarted) return;
    teardownStarted = true;
    cleanupPhase = true;
    try {
      const td = await runChildren(scenario.teardown, ['teardown'], rootVars, runSlot);
      if (td.status === 'fail' || td.status === 'error') {
        emit({ kind: 'lint.reported', data: { code: 'TEARDOWN_FAILED', detail: `清理未成功，可能留脏数据：${td.summary}` } });
      }
    } catch (e) {
      if (e instanceof RunAborted) interruption ??= { kind: e.kind, reason: e.message };
      emit({
        kind: 'lint.reported',
        data: {
          code: 'TEARDOWN_FAILED',
          detail: `${why === 'interrupted' ? '运行被中断，收尾清理也没做完' : '清理中途出错'}，可能留脏数据：${errSummary(e)}`,
        },
      });
    } finally {
      // 交还给"正常路径"的语义。此处之后已经没有业务步骤，但**不留在 true**：
      // 一道永久关掉的闸是将来会咬人的地雷（谁在 return 之前加一步带 checkAbort 的收尾逻辑，
      // 就会拿到一个"永不超时"的 run）。
      cleanupPhase = false;
    }
  };

  try {
    emit({ kind: 'run.started', data: { scenario: scenario.id, mode: scenario.mode, frozen: scenario.frozen, env: scenario.env.environmentRef } });
    // setup 失败 = error（前置不成立，不是产品缺陷）
    const setup = await runChildren(scenario.setup, ['setup'], rootVars, runSlot);
    if (setup.status === 'fail' || setup.status === 'error') {
      setupPhaseFailed = true;
      emit({ kind: 'run.finished', status: 'error', data: { phase: 'setup', detail: setup.summary } });
    } else {
      bodyRan = true;
      const body = await runChildren(scenario.body, ['body'], rootVars, runSlot);
      emit({ kind: 'run.finished', status: body.status, data: { detail: body.summary } });
    }
    // teardown 默认必跑（含 data GC）。它的失败**不进整体状态**：
    // 清理炸了是环境问题，而整体状态回答的是「被测功能对不对」。
    // 混在一起会让一次 cleanup 500 掩盖掉 body 的结论，或把绿的场景判成红的。
    // 记 resultBoundary 以便最后算状态时把 teardown 的结果排除在外。
    resultBoundary = results.length;
    await runTeardown('normal');
    for (const o of scenario.outputs) {
      const r = rootVars.resolveRef(o.from);
      if (r.found) rootVars.setOutput(o.name, r.value);
    }
  } catch (e) {
    const aborted = e instanceof RunAborted;
    /*
     * **赋值而不是 ??=**：这里的是**真的把 run 打断**的那一次，
     * 比中途某个子场景被砍（上面 call 分支里记的）更该出现在报告头部。
     *
     * `reason` 用 `message` 而不是 `errSummary(e)`：后者会给所有 Error 加一个
     * `Error: ` 前缀（对未知异常有意义：能分出 "TypeError: xxx" 这种我们的 bug），
     * 而 RunAborted 是我们自己抛的三句话，摘要与证据里就会变成
     * 「被中断（Error: 运行超时（1000ms））」—— 一句给人读的成因开头挂个类名，
     * 会让人以为是一次真异常。events 里那条仍然用 errSummary（机读侧格式统一）。
     */
    if (aborted) interruption = { kind: (e as RunAborted).kind, reason: (e as RunAborted).message };
    emit({ kind: 'error', status: aborted ? 'skipped' : 'error', data: { message: errSummary(e), aborted } });
    if (!aborted) results.push({ stepId: '__run__', kind: 'noop', status: 'error', durMs: clock.mono() - t0, retry: 0, healed: false, nonReplayable: false, costUsd: 0, artifactIds: [], keyContext: {}, assertionSummary: errSummary(e), cause: causeOfError(e) });
    /*
     * **位置在 push 之后**，这一点是有意的：`__run__` 那条 error 必须落在
     * resultBoundary **之前**，否则整体状态就不再是 error（异常被"洗白"成
     * 一条不进结论的清理记录）。而 finally 里补跑的 teardown 落在 boundary
     * **之后**，正好被排除在整体状态之外 —— 与正常路径同一条语义。
     *
     * 已设过（正常路径进 try 后半段才抛）就不动，避免把 boundary 往后挪、
     * 把已经跑完的 teardown 结果重新算进结论。
     */
    if (resultBoundary < 0) resultBoundary = results.length;
  } finally {
    /*
     * **中断路径也要跑 teardown**（本轮补；判据与三条实现约束写在 `runTeardown` 上，
     * 那里也记着本轮实测到的旧行为 `teardown 跑了吗 = false`）。
     *
     * 放在 finally 而不是 catch 里，是因为下面还要还租约，而**顺序有实质差别**：
     * 清理步骤自己要用设备（`adb shell rm`、关 App、清购物车），
     * 先把租约还掉，就等于把它自己的清理废掉了。所以这一行必须在租约那段之前。
     *
     * 正常路径已经跑过（`teardownStarted` 为真），这里靠那个标记直接跳过 ——
     * 清理步骤不保证幂等，DELETE 两次会 404，那会把一次正常清理报成假失败。
     */
    await runTeardown('interrupted');
    /*
     * **释放放在 finally**（docs/15 §3.1：原来它在 try 的最后一行，于是
     * `catch` 那一支 —— 中断、成本熔断、任何抛出的异常 —— 都不还设备）。
     *
     * 三个细节都是必须的，少一个就换一个坏法：
     *  1. **target 用租约自己的**，不是写死 `'android'`。同一份引擎跑 iOS/鸿蒙时
     *     还租约的 `ctx.target` 会指着另一个平台（`release` 里按 target 选设备的
     *     实现会还不存在的那台）。
     *  2. **先取出来再置空**，让"已发起释放"这件事只有一个真相；否则释放本身抛异常时
     *     `runSlot.lease` 还在，看起来像没试过。
     *  3. **这里不能让它冒出去**：try 已经产出结论了，一次 cleanup 失败不该把整份报告
     *     变成运行异常。但也不能静默 —— 用 log.emitted 说出去（**不新造 lint code**：
     *     `LINT_DOCS` 里没有这个码，`TraceEventKind` 里也没有 `lease.released`；
     *     造一个"看着有出处的码"就是本仓反复记的那族"有码没登记"）。
     */
    /*
     * 这里读的是 `runSlot`（这一层运行自己的槽），**不需要问 `owns`**：
     * runSlot 从 `newLeaseSlot()` 起，初值没有租约，所以里面那台必然是本层自己申请的。
     * `parallel` 的分支槽才有"借来的"这一说（`newLeaseSlot(slot.lease)`，owns=false），
     * 而分支槽的归还在分支结束时做，走不到这里。
     * 把这条不变式写在这里而不是加一句 `&& runSlot.owns`：
     * 加上去就等于承认"runSlot 可能装着借来的租约"，而今天没有那条路径 ——
     * **为不存在的路径写守卫，会让下一个人以为那条路径存在。**
     */
    const lease = runSlot.lease;
    if (lease && adapters.device) {
      runSlot.lease = undefined;
      runSlot.owns = false;
      try {
        await adapters.device.release({ id: lease.id }, execCtx(lease.target as ExecContext['target']));
        // 成功就**留在 undefined**，不写回一个 state:'released' 的租约：
        // "已经还了"与"手上还有个租约（只是标成还了）"是两件事，
        // 后者会让任何后来读到 runSlot.lease 的代码再还一次。
        // 失败也**不写回**：finally 之后没有任何代码读它，写回等于造一个没人读的字段
        // （同一个文件里刚因为同样的理由删掉一个 orderIdx）。失败由下面那句日志说出去。
      } catch (e) {
        emit({ kind: 'log.emitted', data: { level: 'warn', message: `没能归还设备 ${lease.deviceRef}（租约 ${lease.id}），这台可能被一直占着：${errSummary(e)}` } });
      }
    }
  }

  for (const r of results) if (r.status in tally) tally[r.status as keyof typeof tally]++;
  const counted = tally.pass + tally.fail + tally.error + tally.healed;
  const rate = counted ? Math.round((tally.pass / counted) * 100) : 100;
  // 整体状态只看 setup+body（resultBoundary 之前）：teardown 的失败通过 TEARDOWN_FAILED
  // 事件与 tally 暴露，但不得改写「被测功能对不对」这个结论。
  const gate = resultBoundary < 0 ? results : results.slice(0, resultBoundary);
  // setup 失败一律升级为 error：前置不成立时被测系统根本没被真正测到，
  // 报 fail 会让值班人去查一个不存在的产品 bug（docs/02 §6 状态机语义）。
  const setupBroke = setupPhaseFailed && !bodyRan;
  const status: StepStatus = setupBroke ? 'error'
    : gate.some((r) => r.status === 'error') ? 'error'
    : gate.some((r) => r.status === 'fail') ? 'fail'
    : tally.healed > 0 ? 'healed' : 'pass';

  return {
    // childRuns **只在跑过 call 时给**。给个空数组会让"这份报告没记这件事"
    // （手写 fixture、别的实现）与"确实一个 call 都没跑"看起来一样，
    // 而门禁对这两件事的处置不同（前者只能保留旧的宽容，后者可以照实判）。
    runId, status, startedAt, durMs: clock.mono() - t0, results, events,
    ...(childRuns.length ? { childRuns } : {}),
    // 与 childRuns 同样"没有就不写"：`undefined`（没记）与"记了、没中断"要可区分，
    // 门禁对前者的宽容同上面那条注释。
    ...(interruption ? { aborted: interruption } : {}),
    outputs: rootVars.outputs, costUsd, tally,
    // **摘要文字里也要带"被中断"**。理由不是"信息更全"：`summary` 会原样进
    // 证据包的 summary.txt 与 CI 日志，而那里读的是**文字**不是 status 字段
    // （status 在被中断时仍然是 pass，见 RunReport.aborted 那段）。
    // 只在被中断时加这一段，不影响"两次运行字节一致"那条契约测试。
    summary: `${interruption ? `被中断（${interruption.reason}）· ` : ''}${status} · ${counted} 步计入通过率 · ${rate}% 通过 · ${tally.healed} 自愈待审 · $${costUsd.toFixed(4)}`,
  };
}

// ── 辅助 ─────────────────────────────────────────────────────────────────

/** 幂等方法（docs/05 §4）。只有它们能被自动重发；POST/PATCH 永不。 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * keyContext 里携带"传输失败种类"的字段名。
 *
 * 写成常量而不是散在两处的字面量：写的一侧是 runStep 的 catch，
 * 读的一侧是 worthRetrying。两边打错一个字母的表现是**永不重试**，
 * 与"没配重试"同症状，谁也不会怀疑到这儿。
 * （为什么不进 FAILURE_CAUSE：见 runStep catch 里那段注释。）
 */
const TRANSPORT_KEY = 'transportKind';

/**
 * 这一步的请求**能不能重发**。
 *
 * 判据放在引擎这一层而不是 adapter 里，是因为"重不发"必须由**做重发决定的那一层**
 * 执行：重试循环是引擎的 withRetry，adapter 只看得见自己这一次。
 * 以前 adapter 内部对幂等方法偷偷 retry 2 次（`retries ?? 2`），于是
 * IR 写 `count: 0`（明确不要重试）时实测仍然真实发出 **3 次** fetch。
 *
 * **拿不到 method 就当不能重发**（openapiCall 的 method 是 optional，
 * 靠 spec 解析才知道）：方向选保守的一边，因为这里错的代价不对称 ——
 * 少重试只是"这次抖动没被救回来"（还有红灯会报），
 * 多重试一个 POST 是重复下单，而它的症状是一次成功的 200，谁都看不见。
 * 要在那个形状上开重试，就得按 docs/05 §4 说的显式 `retry` + `idempotencyKey`，
 * 而不是让引擎猜 method。
 */
function resendsSafely(s: Step): boolean {
  if (s.kind !== 'http' && s.kind !== 'openapiCall') return true; // 不发请求的步骤，重试不涉及业务副作用
  const m = (s.kind === 'http' ? s.request.method : s.method) ?? '';
  return m !== '' && IDEMPOTENT_METHODS.has(m.toUpperCase());
}

/**
 * 第 attempt 次重试**之前**要等多久。
 *
 * `none` 以前会走到 fixed 那条分支（`backoff === 'exponential' ? … : baseMs`），
 * 于是"我配了不等待"变成"每轮白等 baseMs（默认 2000ms）"：
 * 一个 count=3 的用例在 CI 里凭空多花 6 秒，而 flake 治理里
 * "重试要快"正是配 none 的唯一动机。schema 收了三个值，就得有三个分支。
 */
function backoffMs(retry: Retry | undefined, attempt: number): number {
  const base = retry?.baseMs ?? 2000;
  if (retry?.backoff === 'exponential') return Math.min(base * 2 ** attempt, retry.maxMs ?? 10_000);
  return retry?.backoff === 'none' ? 0 : base;
}

/**
 * 一次**没被采纳**的尝试的摘要（挂在最终那行的 `keyContext.flakyOf` 上）。
 *
 * 只带四件事：第几次、状态、归因、摘要。**刻意不带** keyContext 与 artifactIds：
 *  - keyContext 里是响应体片段、表达式实际值这类"数据"，而 flakyOf 是要进
 *    每一步每一行的常设字段，把失败尝试的数据复制一份到成功行上，等于给脱敏
 *    多开一条没人审的路径（脱敏是在序列化那一刻做的，字段越少越守得住）；
 *  - 失败尝试落盘的证据由存储层按 run 收尾统一保留策略处理，
 *    不在这里点名 —— 在这里点名会让"这一步通过了"的行背上一步没通过的证据 id。
 */
/** 撤掉的尝试在 keyContext[FLAKY_OF_KEY] 里的形状。类型见 ir 的 FlakyAttempt（读侧与写侧共用一份）。 */
function flakyOf(r: StepResult, attempt: number, waitedMs: number): FlakyAttempt {
  return { attempt, status: r.status, waitedMs, ...(r.cause ? { cause: r.cause } : {}), ...(r.assertionSummary ? { summary: r.assertionSummary } : {}) };
}

/*
 * 这里原本有一行 `class AssertionFailure extends Error {}`，本轮删掉：
 * **全仓没有任何 throw 点**（src / test / tooling 全 grep 过，只剩 runStep 的
 * 两个分支与 errSummary 的一处判据在"用"它），而那两个分支因此永远走不到 ——
 * docs/14 §4.7 那条"到不了的防护分支"讲的正是这种。断言不成立在本文件里是
 * **返回值**（`outcome.status === 'fail'`），从来不是异常，所以这个类不是
 * "暂时没人抛、将来会有"，是从一开始就接错了一件事。
 * 留着它的代价不是多一行代码，是**读代码的人会以为 fail 有一条异常路径**，
 * 于是去 trace 里找那条不存在的路径。
 */

/**
 * 耗时写进**人读摘要**时的固定格式。
 *
 * 不格式化会出两件坏事：
 *  1. 摘要里出现 `POST 201 4.305087999999955ms`。CI 日志与 PR 评论里这是噪音，
 *     而且没人能扫一眼比较两次运行。
 *  2. 更要紧的：**证据不再可比**。trace.jsonl 是逐行 JSON，summary 字段里
 *     一个 17 位浮点数意味着同一个场景跑两次，trace 的字节必然不同 ——
 *     M7 的"同一冻结场景跑 20 次断言结果一致"以及
 *     `diff <(unzip -p a.zip trace.jsonl) <(unzip -p b.zip trace.jsonl)` 全部失效。
 *     真实耗时本身是波动的，这一点改不了；能改的是**别把波动的位数扩散到
 *     本来该稳定的字段里**。要精确耗时的场景走 durMs 数值字段（那里如实保留）。
 */
export function fmtMs(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return `${v.toFixed(1)}ms`;
}

function buildUrl(base: string, qs: Record<string, string>): string {
  const entries = Object.entries(qs);
  if (!entries.length) return base;
  const usp = new URLSearchParams(entries.map(([k, v]) => [k, v]));
  return `${base}${base.includes('?') ? '&' : '?'}${usp.toString()}`;
}
/**
 * 拼最终 URL。IR 里只写 path（或以 `{envVar}` 开头的显式绝对地址），
 * 域名一律来自环境配置 —— docs/05 §1：spec 的 servers 几乎总是错的或写死某测试域，
 * 所以**连 spec 的 servers 都不用**，环境是唯一事实源。
 *
 * 相对地址 + 环境没配 baseUrl = 直接 error（env-unavailable），
 * 不是"那就原样发出去"：相对 URL 交给 fetch 会得到 Invalid URL 或打到平台自己的域名上，
 * 两种都比一条明确的"环境没配 baseUrl"难查。
 */
function resolveUrl(url: string, env: Record<string, unknown>): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = typeof env.baseUrl === 'string' ? env.baseUrl : typeof env.baseUrlTemplate === 'string' ? env.baseUrlTemplate : undefined;
  if (!base) throw new EnvMissing(`环境（${JSON.stringify(Object.keys(env))}）里没有 baseUrl，而用例地址是相对路径 "${url}"。IR 不写死域名是刻意的（docs/05 §1）`);
  return base.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}
/**
 * 平台那一维（android / ios / harmony），从**这一层槽位上的租约**读。
 *
 * 单独成一个函数只为了一个理由：`targetOf` 与守望（`runWatchers`）需要同一个答案，
 * 而守望那侧没有步骤可查表。两处各写一份 `ctx.lease?.target ?? 'any'`
 * 就是本仓反复记的那族"两处各一份，迟早只更新其中一处"。
 *
 * 注意它**只回答平台**：`'api'` / `'web'` 这两档不在租约里（租约只有真机），
 * 那两档要走 `STEP_TARGET`，见 `targetOf`。
 *
 * 传进来的一直是**当前那一层**的槽位而不是闭包里的 `runSlot` —— 这不是顺手，
 * 而是 §3.3 那个嵌套 parallel 缺陷（`newLeaseSlot(runSlot.lease)` 少继承一层）
 * 的同一件事：这一族代码只能靠"谁把哪个变量传进来"来保证正确，而编译器管不了
 * （`slot` 是必填形参，只能逼调用方传个槽位，逼不了它传对那一个）。
 */
function platformOf(ctx: LeaseSlot): ExecTarget {
  return ctx.lease?.target ?? 'any';
}

function targetOf(s: Step, ctx: LeaseSlot): ExecTarget {
  /**
   * **这一步属于哪一端。**
   *
   * 三档（api / web / 平台）里前两档**去读 IR 那张权威表** `STEP_TARGET`，
   * 只有平台那一维现推 —— 因为 `STEP_TARGET` 把 android/ios/harmony 合成一档
   * `'mobile'`（`deriveTargets` 靠读 `s.target` 再细分），而运行时恰恰需要那个细分。
   * 所以这里是"查表 + 读租约"，**不是**整份换成 `deriveTargets(scenario.body)`：
   * 那是场景级的集合，回答不了"这一步在哪台平台上"（docs/15 §3.4 的"修法有一处
   * 不能 delegate"那句）。
   *
   * **缺陷的形状**（docs/15 §3.4）：原先这里不查表，重抄了两份清单 ——
   * `['navigate','act','capture']` 与 `['http','openapiCall','db']`，
   * 而 IR 那张表**已经和它对不上**：表里 `assertPage: 'web'`，抄的那份没有它，
   * 于是 assertPage 落到"其余"那一支、没有租约 ⇒ `?? 'android'`
   * （**P3：纯 Web 场景里 assertPage 那一步的 `ctx.target` 就是 `'android'`**）；
   * 表里 `db: 'any'`，抄的那份写死 `'api'`。重抄一份就是本仓记过多次的
   * "两处各一份，迟早只更新其中一处"。
   *
   * **哪些行今天走不到（探针实测，`.scratch/probe-targetof.mts` +
   * `.scratch/probe-targetof-mobile.mts`，两次分别灌 Web 形状与移动/混合形状；
   * 永久落点是变异集 `tooling/mutate/exec-target.json` 的 M6 ——
   * 它把 `s.kind === 'device'` 那一行整行删掉，跑出来**没有任何测试变红**，
   * 这就是"这一行今天走不到"的可重跑形式）：**
   * 实测走到过这个函数的 kind 一共九个（两次的并集）——
   * navigate / act / capture / assertPage（web 档）
   * 与 app / tap / assertUi / wait / assert（有租约那侧）。**没有** device，也
   * **没有** http / openapiCall / db：
   *  - `case 'device'` 自己用 `execCtx(s.target, s.id)`，续租用
   *    `execCtx(slot.lease.target, …)`，替换旧租约用 `execCtx(prev.target, …)`；
   *    （**这里故意不写行号** —— 写第一轮就发现自己标的三处里两处已经被本轮的
   *    改动挪走了。行号是第三份会漂的副本，函数名 + 实参才是查得到的坐标。）
   *  - http / openapiCall / db 三处在 `execCtx('api', s.id)` 处直接给端。
   * 所以 `device` 那一行与 `world === 'api'` 那一支**都是死支**。
   *
   * 留着它们，并且要说清这与上面 `finally` 那段里"为不存在的路径写守卫，会让下一个人
   * 以为那条路径存在"**不是同一件事**：那条禁的是为**不可能的状态**加条件
   * （例：`runSlot && runSlot.owns` —— 今天没有任何路径会让 runSlot 装着借来的租约）。
   * 这两行不是条件守卫，是这个**全函数**对那两个 kind 的**答案**：
   * `targetOf(device 步)` 的正确回答是 IR 里那个 `s.target`，而不是"槽位里碰巧
   * 那台"（`STEP_TARGET['device']` 是 `'mobile'`，查表会把平台洗掉）；
   * `targetOf(http 步)` 的正确答案是 `'api'`。删掉它们不会改变今天任何一次输出，
   * 改变的是**这个函数以后答什么** —— 而本轮改它的唯一理由正是"别再自己猜 kinds，
   * 去读那张表"（docs/15 §3.4）。
   *
   * 下一轮如果要清死支，先问"这个函数还会不会被新调用点用到"；答"不会"就连
   * 整个函数一起收（调用点各写各的），别只删中间一行 —— 只删一行会让
   * 这个映射**看起来**完整、实际缺两行。
   *
   * 兜底 `'any'` 而不是 `'android'`：算不出端就说算不出（取值含义见 `ExecTarget`）。
   */
  if (s.kind === 'device') return s.target;
  const world = STEP_TARGET[s.kind];
  if (world === 'web') return 'web';
  if (world === 'api') return 'api';
  // mobile 档与 any 档都走这里：平台那一维的唯一实现在 platformOf
  return platformOf(ctx);
}
function opOf(s: Step): unknown {
  if (s.kind === 'act') return { op: s.action, value: s.value };
  if (s.kind === 'navigate') return { op: 'navigate', url: s.url, waitUntil: s.waitUntil };
  if (s.kind === 'input') return { op: 'fill', value: s.value };
  if (s.kind === 'swipe') return { op: 'swipe', to: s.to ?? [0, 0] };
  if (s.kind === 'key') return { op: 'press', key: s.key };
  if (s.kind === 'capture') return { op: 'snapshot' };
  return { op: 'click' };
}
function extractFromAria(text: string, needle: string): string | undefined {
  const m = text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]?\\s*(\\S+)', 'm'));
  return m?.[1];
}
function matchesHierarchy(xml: string, match: Record<string, string | undefined>): string | null {
  if (match.text) { const m = xml.match(new RegExp(`[^<>]*text="${esc(match.text)}"[^<>]*`)); if (m) return m[0]; }
  if (match.textContains) { const m = xml.match(new RegExp(`[^<>]*text="[^"]*${esc(match.textContains)}[^"]*"[^<>]*`)); if (m) return m[0]; }
  if (match.matches) { const m = xml.match(new RegExp(match.matches, 'm')); if (m) return m[0]; }
  return null;
}
function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function preview(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
function errSummary(e: unknown): string {
  /*
   * 这一串是"**消息本身是不是一句完整的话**"的判据，与 `causeOfError` 那个
   * "这是谁的错"的判据**不是同一件事**，所以刻意没有合并：
   *  `ExprError` 的消息是完整句子但**不在这个名单里** —— 于是它带着
   *  `ExprError: ` 前缀出去，而那前缀对语法错是有用的（一眼看出是表达式引擎报的）。
   *  合并成一份会逼着两边取同一个立场，而它们本来立场不同。
   *
   * 名单里没有 `AssertionFailure`：那个类**没有任何 throw 点**（本轮 grep 过
   *  src+test+tooling），已从本文件删除。
   */
  if (e instanceof PathError || e instanceof VarError || e instanceof EnvMissing) return e.message;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
function firstFrames(e: unknown): string {
  const st = (e as Error)?.stack ?? '';
  return st.split('\n').slice(1, 4).join(' | ').slice(0, 400);
}
/** 内容寻址用的轻量 hash（真实现要用 crypto，但引擎不许 import node:） */
/**
 * 引擎**自动**产证据（响应体、提取前的原始文本…）的统一出口。
 *
 * 与 ctx.saveArtifact 的区别是错误处理，而这个区别是刻意的：
 *  - `ctx.saveArtifact` 是**用例显式要求**存的证据，没存储就抛 —— 用户要的东西给不了，
 *    必须炸在步骤上，不能悄悄没存。
 *  - 这里（自动证据）没存储时**记一条事件然后跳过，不判步骤失败**：
 *    "没接证据盘"是部署配置问题，不该让每个 HTTP 步骤变红，
 *    否则第一次接平台的人看到的是"所有用例都 error"，
 *    而真实原因（没配 artifactStore）藏在摘要里。
 *    但**绝不静默**：没证据的话 M6 那个 evidence.zip 会是个只有元数据的空壳，
 *    而它看起来是打开成功的 —— 所以每个 run 至少要吼一声。
 */
function makeAutoEvidence(opts: {
  hasStore: boolean; emit: (e: EmitIn) => void; artifactIdFor: (kind: string, data: string, stepId: string) => Promise<string>;
}) {
  let warned = false;
  const warnOnce = (stepId: string): void => {
    if (warned) return;
    warned = true;
    // 只报一次：一个 200 步的套件会刷出 200 条同样的事件，把人淹掉
    opts.emit({ kind: 'lint.reported', stepId, data: { code: 'ARTIFACT_STORE_MISSING', detail: '未配置证据存储（adapters.artifactStore），本次运行的响应体等自动证据**没有落盘**，evidence 包将只含元数据' } });
  };
  return async (stepId: string, kind: string, data: string): Promise<string | undefined> => {
    if (!opts.hasStore) { warnOnce(stepId); return undefined; }
    return opts.artifactIdFor(kind, data, stepId);
  };
}

/**
 * UTF-8 字节数。**不用 string.length**：那是 UTF-16 码元数，
 * 一个中文响应体会把 3 字节算成 1 字节，于是 10MB 上限实际放行约 30MB，
 * docs/05 §4 那条"失控导出接口撑爆证据盘"的防线在中文接口上静默失效。
 */
function byteLen(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** 子场景执行入口（call 节点用）。与主流程共用 emit/adapters 以保成本与事件的连续性。 */
async function runScenarioIn(a: {
  scenario: Scenario; vars: VarSpace; adapters: AdapterRegistry; clock: Clock;
  emit: (e: EmitIn) => void;
  /**
   * 成本往父报告上汇总。**只有这一个"环境类"入参是必要的**：
   * 原先这里还挂着 `ctxBase`、`execCtx`、`stepCtx`、`depth` 四个，函数体里**一个都没读**
   * （本轮逐个 grep 实测：`a.ctxBase` / `a.execCtx` / `a.stepCtx` / `a.depth` 各 0 次命中）。
   *
   * **其中 `stepCtx` 那一个是本轮缺陷的直接成因**：`call` 那一行的实参老老实实写着
   * `stepCtx`，于是任何人（包括我）读那一行都会得出"父的 stepCtx 传进子运行了"，
   * 进而以为父的 device 租约在子里可见 —— 而 `runScenarioIn` 的函数体压根不碰它。
   * **"看起来传了"比"根本没这个参数"坏得多**：前者需要读完整条链路才能推翻，
   * 后者一眼就知道要自己做。docs/15 §3.1 里那句"parallel 那一支压根不共享 stepCtx"
   * 就是这么写错的（同一个推理错误：从调用参数表推行为）。
   *
   * 删掉而不是留一句"未使用"的注释：留着就是等下一个人去"接上"它，
   * 而租约该不该跨 `call` 是一个**没定的产品问题**（选项 A/B 见 docs/15 §3.1 末段），
   * 不该由一个死参数的引力替它决定。
   */
  addCost: (n: number) => void;
  /**
   * 密钥解析器，**必须从父运行带下来**。这里以前硬编码 `secretResolver: undefined`。
   *
   * 后果（实测）：子场景里 `$secret.pw` 拿到的是占位符 `«secret:未暴露»`，
   * 而**步骤状态照样是 pass** —— 请求带着占位符发出去了，登录接口大概率 401，
   * 于是这一步被归因成产品问题（或更糟： mock 环境下真的通过了）。
   * 真值永远取不到，人看到的却是一个绿灯 + 一个说不清的失败，
   * 而"缺哪个变量"这句本该在跑之前就直说的话压根没说。
   *
   * 顺带说清**为什么值仍然是安全的**：解析出的真值只进 `resolveValue` 的返回值
   * （也就是"发出去的那一跳"），Agent 上下文、trace、keyContext、证据一律走
   * redactForDisk，看不到它。这里透传的是**解析能力**，不是值。
   */
  secretResolver?: (ref: string) => string;
  /**
   * 环境名之外的运行配置。`envRevision` 以前没往下传，
   * 于是子场景的证据里"这次跑的是第几版环境"是空的 —— 回放时无法复现。
   */
  envRevision?: number;
  /** 调用链（见 RunOptions.callStack）。不透传就等于环检测只在**最外层**生效 */
  callStack: string[];
  /**
   * 父 run 的响应观测账。**必填**（不像上面几个可选项）。
   *
   * 理由与上面 secretResolver 那条坑同源：可选参数一旦"忘了传也编译得过"，
   * 漏传的症状是子场景从 0 起账 —— 而页面内的响应流是**同一个流**（同一个浏览器会话），
   * 于是"父在前面步骤里发过的接口"会在子里的 wait{response} 里算命中，即假绿。
   * 这里让它必填，"忘了接"回到编译错误，而不是留一条要靠测试去追的静默分叉。
   */
  responseLedger: ResponseLedger;
  /**
   * 取消标志。**类型上必填、值可以为 undefined** —— 这个组合是故意的，
   * 抄的是上面 `responseLedger` 那条的做法：可选参数（`signal?:`）一旦"忘了写也编译得过"，
   * 漏写的症状不是报错，而是**人按了 Ctrl-C、子场景把剩下的步骤照样跑完**。
   *
   * **改动前实测**（子里 6 条 sleep，第 3 条后翻 flag）：
   * `子场景跑了 = s1,s2,s3,s4,s5,s6`，而父报告同时写着 `aborted = 外部取消`。
   * 子场景的 body 里可能是 POST/下单/删除（docs/02 §5 的不可逆动作纪律），
   * 而"取消"这件事的全部意义就是**从此不再产生副作用**。视觉兜底那档还在逐步花钱。
   *
   * 顶层那次 run 没有标志（CLI 还没装处理器、或服务端直接调引擎）时传 undefined 是对的，
   * 所以这里收 `| undefined`；必填的部分只是"**你得在场说一句话**"。
   */
  signal: RunOptions['signal'];
}): Promise<RunReport> {
  const rep = await runScenario({
    scenario: a.scenario, inputs: a.vars.inputs, env: a.vars.env,
    secretResolver: a.secretResolver, envRevision: a.envRevision, callStack: a.callStack,
    responseLedger: a.responseLedger,
    // **原样传对象**，不传 `a.signal.aborted`（取一次快照的话，取消发生在运行中间就永远读不到）
    ...(a.signal ? { signal: a.signal } : {}),
    adapters: a.adapters, clock: a.clock,
    /*
     * 子场景**不单独设预算**，但成本照常往上汇总（`addCost`）。
     * MAX_SAFE_INTEGER 不是"子场景可以随便花钱"，而是"熔断由谁做"的选择：
     * 由父做。父在 addCost 里累计后触发，于是熔断点仍然是"这一次 run 一共花了多少"，
     * 而不是"某个子场景恰好花了多少"——后者会让一条贵子场景在深层被单独掐掉，
     * 报出来像个偶发环境错误。
     */
    maxCostUsd: Number.MAX_SAFE_INTEGER,
  });
  a.addCost(rep.costUsd);
  for (const e of rep.events) a.emit({ kind: e.kind, stepId: e.stepId, status: e.status, durMs: e.durMs, data: e.data, path: e.path });
  return rep;
}

export { countsTowardPassRate };
