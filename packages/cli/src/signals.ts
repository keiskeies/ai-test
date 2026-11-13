/**
 * 进程信号接线：Ctrl-C 与「退出码 10 / 证据包里的 `aborted`」之间**那一段管道**。
 *
 * ## 为什么这个文件是本轮才出现的
 *
 * `exit.ts` 从第一天就写着 `ABORTED: 10`，注释是「被信号打断（我们主动响应 SIGINT 时用这个）」；
 * `CI_HINT` 里印着「10 被中断」；`WORSE_ORDER` 给它排了序。而**全仓没有任何一条路径返回它，
 * 也没有任何人注册过信号处理器** —— 本轮之前各包 src 里 `process.on` 零命中，
 * 而 `runOptions.signal` **没有生产者**（引擎里那句 `opts.signal?.aborted` 恒读不到 true）。
 * 这是 docs/14 §4.3 子类 **(c)「读了、也判了，但没有生产者」换到对外 API 这层上的复现**：
 * 以前是"IR 字段有、引擎判了、adapter 不报数"，这里是"码表有名额、门禁判了、执行侧没人返回"。
 * **同一子类、不同表面，所以不另立编号**（§4.3 表下那段讲的是为什么硬编号有害）。
 *
 * ## 第一次信号：只置标志，不终止
 *
 * Node 只要看到「SIGINT 有处理器」，就把默认行为（立刻以 130 死掉）换成
 * 「跑我们的回调，然后**继续活着**」。这里顺势把"活着"用满，只做一个动作：把 `aborted` 翻成 true。
 * 后面全部交给**已经写好的**那条链：
 *
 * ```
 * checkAbort() 抛 RunAborted('cancelled')  → RunReport.aborted
 *   → 门禁 EXIT.ABORTED(10)                → run 目录那几份产物照写
 *   → teardown 照跑                        → 设备租约在 finally 里归还
 * ```
 *
 * **为什么不当场死**（这是"Ctrl-C 应该立刻结束"这个直觉里唯一错的部分）。当场死的话四件事全不发生：
 *  1. **没有产物** —— 人按了一次 Ctrl-C，那次 run 在磁盘上不留痕迹，重跑要重花钱；
 *  2. **没有 `report.aborted`** —— 门禁读不到东西，10 就又变回那个没人返回的码；
 *  3. **没有 teardown** —— 环境里留下脏数据，而没有任何一行说它留下了；
 *  4. **不还租约** —— 手工按一次 Ctrl-C 就白占一台真机。docs/15 §3.1 那几条测试
 *     证明的是"引擎内部中断会还"，恰好证明不了真人在敲的这条路径（它此前压根走不到）。
 *
 * ## 第二次同一个信号：不再讲道理，自我终止
 *
 * "我就想现在走"是真需求（清理里可能有一次会超时 30s 的真请求）。所以**第二个同名信号**
 * 到了就摘掉处理器、用同名信号打死自己，进程以 `128+signum`（SIGINT=130 / SIGTERM=143 / SIGHUP=129）终止。
 *
 * 摘掉是**必须**的一步，不是清理习惯：处理器在场期间进程对该信号免疫，
 * 不摘的话 `process.kill(process.pid, sig)` 只会再跑一次这个回调，**按多少下都出不去**。
 *
 * 那些 `128+n` 码在 `RESERVED_EXIT` 里不许我们自己返回，而它们的含义正好是
 * "被信号终止、没清理干净" —— 这次名副其实，因为清理确实被半路放弃了。
 * 这就是 `exit.ts` 那条注释要分的两件事：**10 = 我清理干净了，130 = 我没有**。
 *
 * **换一种信号不算"第二次"**（第一次 SIGTERM、接着 SIGINT 不算）。CI runner 取消任务时
 * 常见的正是"先 TERM 再 INT"，那是**同一句话说了两遍**（"停下"），不是"别收拾了"；
 * 而人手按两下 Ctrl-C 才是后者。把它们混成一个触发条件，代价是**每次 CI 取消都丢掉清理**
 * —— 恰好丢掉本轮为它写这一整段的那个东西。
 *
 * ## 处理器里没有 await、没有 spawn、没有第二遍 run
 *
 * 处理器在信号栈里同步执行。任何"再跑一遍/换个进程跑"的想法都会**重新发一次场景请求** ——
 * 里面有 POST/下单/删除（docs/02 §5 的不可逆动作纪律），一次取消绝不该产生第二遍副作用。
 * 清理期间的等待靠的是"第二次同名按键"这个逃生门。
 */

/** 我们主动接的信号。SIGQUIT 刻意不接：它的语义是"给我 core dump"，不是"停一下" */
export const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/**
 * 引擎要的形态（`RunOptions.signal`）。
 *
 * **刻意不用 `AbortSignal`**，两条理由都是硬的：
 *  1. 那个类型在 lib.dom 与 @types/node 里**不是同一个声明**（`reason` /
 *     `throwIfAborted` / `addEventListener` 的签名都不一样），而 engine 的编译里有 DOM
 *     没 node（`tooling/lint-layers.mjs` 禁止它碰任何内置模块），跨这个边界传
 *     `AbortSignal` 迟早撞类型；
 *  2. 判据本身只需要一个布尔量（`interpreter.ts` 的 `checkAbort` 每步开头读一次）。
 *     把 `AbortSignal` 写进契约等于顺手把 `abort()` 事件、`reason`、`AbortController`
 *     一整套语义拉进来，而"谁在哪个微任务里 abort"比一个布尔量难解释得多。
 *
 * 名字沿用 `signal` 是让**意图**一眼可认。它是**结构性**的：调用方手写
 * `{ aborted: true }` 就过类型，那正是这个接口该有的宽度（也因此不必导出 class
 * —— 一个 getter 就够，多一个类只是多一个能被伪造的东西）。
 */
export interface AbortFlag {
  readonly aborted: boolean;
  /** 最先到的那个信号。没收到信号时 undefined */
  sig(): HandledSignal | undefined;
  /** 收到过几次信号（含被忽略的异名信号）。>=2 且同名意味着"人不等了" */
  count(): number;
}

/** {@link createAbortFlag} 的返回值 */
export interface AbortSource {
  /** 交给引擎/命令侧读的那一份 */
  readonly flag: AbortFlag;
  /**
   * 从**进程外**触发取消。返回 `true` = 这是第一次（调用方据此决定要不要打"正在收尾"）。
   *
   * 不叫 `abort` 而叫 `cancel`：`abort` 在这个仓里已经有含义了 —— 引擎那边的
   * `RunAborted`、报告里的 `aborted` 字段，而那些**包含**超时与成本熔断砍断。
   * 这一格只会由"人主动要求停下"触发，名字要分得开。
   */
  cancel(): boolean;
}

/**
 * 一个**不由信号驱动**的取消标志。给常驻宿主用（服务端 `POST /api/cancel?jobId=…` 取消某一条 run）。
 *
 * ## 为什么要单独有一个，而不是给 installSignalHandlers 加个入参
 *
 * 那条路的自我终止语义（第二次同名按键 => 摘处理器 + `process.kill(self)`）**在
 * 常驻进程里是错的**：服务端上"再点一次取消"绝不能把整个服务打死，那会同时砍掉
 * 正在清理的 teardown、没还的设备租约，以及别人的那条 run。所以这里刻意
 * **没有** count 的同名判定、没有 selfKill、没有 restore —— 少写的这三样都是
 * 有意不带，不是没写完。
 *
 * ## 为什么 `flag` 与 `cancel` 分两个东西，而不是直接返回一个带 setter 的对象
 *
 * 引擎与命令侧**只该读**，写它的能力只该在宿主手里。合成一个对象的话，
 * 任何拿到 `signal` 的代码都能取消别人的 run —— 而这个对象会一路传进
 * `runOne`、wiring、以及将来所有装配点。
 * （`AbortFlag` 本身是结构性的，手写 `{ aborted: true }` 仍然过类型 ——
 * 那条立场不变，见上面那段；这一格挡的是"顺手能写到活的那个对象上"，
 * 不是"有人伪造一份新的"。）
 *
 * `sig()` 恒为 undefined：它不是信号。命令侧那句提示因此走 fallback，
 * 而不是把 HTTP 取消说成"被信号取消" —— 那是把人引向"是不是有人 kill 了进程"的假归因。
 */
export function createAbortFlag(): AbortSource {
  const state = { aborted: false, count: 0 };
  return {
    flag: {
      get aborted() { return state.aborted; },
      sig: () => undefined,
      count: () => state.count,
    },
    cancel() {
      state.count++;
      if (state.aborted) return false;
      state.aborted = true;
      return true;
    },
  };
}

export interface SignalOptions {
  /**
   * 每次信号都调（第一次、第二次…）。只许做**同步的字符串输出** —— 在信号栈里。
   *
   * `sameSignal` 是"这一次与最先那个同名"。**必须由本模块给，不能让调用方自己数**：
   * 命令侧要打出"立即终止、放弃清理"这句话，而那句话**只在同名时**才为真
   * （异名信号不会自我终止，见文件头那条 CI runner 的论证）。
   * 让 cmdRun 自己拿 `sig === signal.sig()` 判，就会出现"两处对同一件事各判一次、
   * 迟早只改其中一处"—— 而这里的两处**必须同步**，否则打出去的那句关于"要不要清理"的话
   * 与实际行为不一致，人对着那句话决定要不要再按一下。
   */
  onAbort?(info: { sig: HandledSignal; count: number; sameSignal: boolean }): void;
  /**
   * 第二次同名信号时**怎么真的死掉**。默认 `process.kill(process.pid, sig)`。
   *
   * 是个可注入的缝，只有一个理由：**测试不能真把自己打死**。
   * 传一个记一笔就走的假实现，于是"第二次同名信号 → 摘处理器 + 自我终止"
   * 这件事能在进程内被断言（见 signal.test.ts），不必起子进程再 signal(2) 一个真 CLI。
   */
  selfKill?(sig: HandledSignal): void;
}

export interface InstalledSignals {
  signal: AbortFlag;
  /**
   * 摘掉处理器。**必须调用**（`finally { restore() }`）。
   *
   * 先把一条**实测**记在这里，因为它一度把我引向一个错结论：
   * `node --test` 给**每个测试文件**起一个子进程（两个文件里打印 `process.pid`
   * 得到 91768 / 91769），所以"漏一个处理器会污染同一次 `npm test` 里别的用例文件"
   * 这个说法**不成立**。真正需要摘的三条理由都在**同一个进程内**：
   *  1. `process.on` 是**累加**的：同进程跑 N 次命令留 N 套处理器，
   *     第 11 套起 Node 打 MaxListenersExceededWarning 把 CI 日志弄脏，
   *     而那种告警会被读成"测试框架的问题"忽略掉；
   *  2. 处理器在场期间进程对 Ctrl-C **免疫**。命令跑完还留着，等于让宿主进程
   *     在命令之外的所有时间里杀不掉 —— 只能 kill -9，那是**比不接信号更坏**的行为。
   *     这条在平台落地后会立刻变成真问题：`cmdRun` 是要被服务端在**常驻进程**里调的；
   *  3. 更坏的是泄漏的那套**还会咬人** —— 它带着"第二次同名就自我终止"的逻辑，
   *     于是任何一次第二次按键会 `process.kill(self)`，而那时在跑的是**另一条命令**
   *     （它的清理与产物一样都不会有），外加打一句"正在收尾"的假进度。
   *
   * 只摘自己那个（`removeListener` 按引用摘）。**不用 `removeAllListeners`**：
   * 那会把别人（测试框架、宿主、将来的 watch 模式）装的一起清掉 ——
   * 把"我留了泄漏"变成"我弄坏了别人的功能"，后者更难查，因为现场看起来是**少**了一个处理器。
   */
  restore(): void;
}

/**
 * 信号名 → 编号。**唯一用途**是"自我终止那一步没成功时给一个正确的 128+n"。
 * 表里只有我们接的三个信号：查不到就没有兜底码，**不编一个数** ——
 * 128+错编号得到的码会指向另一个信号，那比一个通用码更误导人。
 */
const SIGNAL_NUMBER: Record<HandledSignal, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/**
 * 装上信号处理器，返回 `{ signal, restore }`。
 *
 * 返回一个对象而不是裸的 restore 函数：命令侧**两个都要用**（`signal` 交给引擎、
 * `restore` 交给 finally），拆开返回让"用了 A 忘了 B"是显眼的事 ——
 * 而"装了不摘"是本模块唯一能犯的严重错误（理由见 {@link InstalledSignals.restore}）。
 */
export function installSignalHandlers(o: SignalOptions = {}): InstalledSignals {
  // 信号是进程级的。本包（cli）**不受** lint:layers 的内置模块禁令约束（那张表只管
  // ir/engine 两个包，实测见 tooling/lint-layers.mjs 的 LAYER_RULES），所以这道守卫
  // 不是为了过检查。它防的是别的宿主：这条装配路径哪天跑到 worker/浏览器壳里，
  // `process` 是个 ReferenceError，那会让"装配一次运行"整个炸掉 ——
  // 少一个信号处理器（顶多不能被优雅取消）远好过炸。
  if (typeof process === 'undefined' || typeof process.addListener !== 'function') {
    return { signal: { aborted: false, sig: () => undefined, count: () => 0 }, restore: () => { } };
  }
  const state = { aborted: false, count: 0, sig: undefined as HandledSignal | undefined };
  const signal: AbortFlag = {
    // getter 而不是快照：引擎在**每一步开头**读它，值必须是读那一刻的。
    // （装配时取一次快照的话，这条管道永远读不到 true，
    //  症状与"压根没接线"一字不差 —— 见 wiring.ts 里传 signal 那段。）
    get aborted() { return state.aborted; },
    sig: () => state.sig,
    count: () => state.count,
  };
  /**
   * 默认的自我终止。
   *
   * 后面那句 `process.exitCode` 是**兜底**，而且**必须挂在这个实现上**，
   * 不能挂在 handler 里：handler 不知道 selfKill 是真货还是测试给的假货 ——
   * 我第一版就是写在 handler 里，结果整套单元测试（用假 selfKill）
   * 跑完全绿而**文件退出码 130**，`node --test` 把整个文件判失败。
   * 那个形状本身就说明了归属：**"杀死自己"与"万一没杀死就带码退出"是同一个人的活**。
   *
   * 真货什么时候会走到那行？正常情况到不了（信号一到进程就没了）。写它是因为
   * 默认行为可能被**别人**改掉：若某个库在我们之后又装了一个同名处理器，
   * `process.kill(self)` 就只是又叫一次回调，进程会活着往下走。
   * 那时带着 `128+n` 离开，也比安静跑完报 0 好 —— 后者正是本文件在防的那个假绿。
   */
  const selfKill = o.selfKill ?? ((s: HandledSignal) => {
    // kill 自己失败（非 root 容器里被安全策略拦掉这类极端情况）也不能把异常冒到
    // handler 外面 —— 处理器里抛异常 = uncaughtException，一次取消会被报成"平台内部错误"。
    try { process.kill(process.pid, s); } catch { /* 靠下面那个退出码离开 */ }
    process.exitCode = 128 + SIGNAL_NUMBER[s];
  });

  let off = false;
  const restore = (): void => {
    if (off) return; // 摘两次不抛：`finally` 一次 + 外层再兜一次是常见写法
    off = true;
    for (const name of HANDLED_SIGNALS) process.removeListener(name, handler);
  };

  /**
   * 处理器**每次信号都跑**（不像某些实现只认第一次）—— 第二次的语义完全不同：
   * "我不等清理了"。所以它不能被 `if (aborted) return` 吞掉。
   *
   * 形参是 `unknown[]` 而不是 `(sig: Signals)`：实参形态由 Node/OS 决定，不由我们决定。
   * 关键在于**处理器里抛异常的代价不对**：轻则 uncaughtException 把结论换成
   * "平台内部错误"（一次取消不该让工具看起来有 bug），重则把正在收尾的清理路径整个带走。
   * 所以对形态宽容、对自己那几行调用兜底。
   */
  function handler(...args: unknown[]): void {
    // 认不出来的信号名当 SIGINT 处理，而不是抛也不是忽略：能进到这里说明这个信号
    // 是我们注册过的那三个之一（只给 HANDLED_SIGNALS 装处理器）。写这一行是为了
    // **不假设** Node 传回来的第一个实参一定是名字字符串。
    const first = args[0];
    const sig = (HANDLED_SIGNALS as readonly unknown[]).includes(first) ? (first as HandledSignal) : (state.sig ?? 'SIGINT');
    state.count++;
    // 只在**已经收到过信号**时才谈"同名"：第一次时 state.sig 还是 undefined，
    // 那时同不同名没有意义（也就不会被自我终止用到 —— 见下面 `!state.aborted` 那道闸）。
    const same = state.aborted && state.sig === sig;
    // onAbort 只负责"让人看见"。它抛了不能影响 aborted（已经是 true），也不能挡住自我终止：
    // 吞掉的后果是少打一句话，让它冒出去的后果是清理路径没了 / 想死死不掉。
    try { o.onAbort?.({ sig, count: state.count, sameSignal: same }); } catch { /* 见上 */ }

    if (!state.aborted) {
      state.aborted = true;
      state.sig = sig;
      return;
    }
    if (!same) return; // 异名信号 = 同一句"停下"的第二遍，不是"别收拾了"（见文件头）
    // 第二次同名：先摘自己，再打死自己。**顺序不能反** —— 处理器还在场时
    // kill 自己只会再跑一次这个回调，永远出不去。
    restore();
    // 默认实现自带"没杀死就带码退出"的兜底（见 selfKill 那段）；
    // 注入的假货不需要 —— 它**本来就该**活着返回，让测试能继续断言。
    selfKill(sig);
  }

  // 用 `addListener` / `removeListener` 这一对**别名**而不是 `on`：`on` 撞上 IR 的字段名
  // `CaptureStepSchema.on`（截屏时机），`process.on` 会被 tooling/unread-fields.mjs 的
  // "成员访问 = 强证据"判成"那个字段有人读了"，于是它的豁免被报成"已过期"，
  // 而按工具提示删掉豁免之后，那条字段将来真被漏接时扫描器会闭嘴 ——
  // **写一行信号代码，把别人的闸拆了**。两个名字是 EventEmitter 的官方别名，行为一字不差。
  for (const name of HANDLED_SIGNALS) process.addListener(name, handler);
  return { signal, restore };
}

/**
 * 命令侧那一段"信号 + 宿主注入的合成"，**从 cmdRun 里搬出来的**（不是重写一遍）。
 *
 * ## 为什么要搬出来
 * cmdRun 里原来有二十行做三件事：装处理器、与 `io.abortSignal` 合成一个、
 * 给出"是谁取消的"那句话。`atest load` 需要**一模一样**的三件事，而它是最需要
 * 正确取消的一条路（一场压测正在以几千 rps 打被测系统，"停下"必须真停下）。
 * 抄第二份的后果本仓记过很多次，这一处的具体坏法是：改了合成逻辑（比如将来
 * 注入那份也带 sig）而 load 那份没改，于是 load 把 HTTP 取消说成"被信号取消"。
 *
 * ## 留在调用方的只有**措辞**
 * 那两句话在 run 与 load 里确实该不一样（一条丢的是证据包与设备租约，
 * 一条丢的是分位数与没收掉的 mock），所以打印由调用方的 `onAbort` 负责。
 * **判据（合成、归因）一条都不在调用方** —— 那才是会漂的东西。
 */
export function installCommandSignals(o: {
  /** 宿主注入的那一份（服务端 `POST /api/cancel`）。CLI 自己**永远不给** */
  injected?: AbortFlag;
  /** 每次信号都调，只许同步输出。措辞归命令侧，见上 */
  onAbort: (info: { sig: HandledSignal; second: boolean }) => void;
}): { signal: AbortFlag; abortedBy: () => string; restore: () => void } {
  const signals = installSignalHandlers({
    onAbort: ({ sig, sameSignal }) => o.onAbort({ sig, second: sameSignal }),
  });
  const injected = o.injected;
  /*
   * `sig()` 只可能来自信号那一份（注入的那个恒 undefined，见 createAbortFlag），
   * 所以归因这句话要自己拼 —— 直接读 `signal.sig()` 会把 HTTP 取消说成"被信号取消"，
   * 那是把人引向"谁 kill 了进程"的假归因。
   */
  const abortedBy = (): string => signals.signal.sig() ?? (injected?.aborted ? '外部请求' : '信号');
  const signal: AbortFlag = injected
    ? {
      get aborted() { return signals.signal.aborted || injected.aborted; },
      sig: () => signals.signal.sig(),
      count: () => signals.signal.count() + injected.count(),
    }
    : signals.signal;
  return { signal, abortedBy, restore: signals.restore };
}
