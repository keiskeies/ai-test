/**
 * `atest` 的子命令实现（M6 第四个交付物）。
 *
 * 每个命令的形态统一：解析开关 → 装配 → 执行 → **把结论与产物路径打出来** → 返回退出码。
 * 打印走 stdout（结论）与 stderr（告警与进度）两条道，
 * 因为 CI 里经常有人 `atest run ... > result.txt` 只留结论；
 * 告警混进 stdout 会让那份文件变成没法机器解析的东西。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  EVIDENCE_FILES, lintScenario, runScenario, toHtmlReport, toJUnitXml, toReport, toTraceJsonl, summaryText,
  type AdapterRegistry, type RunReport, type ScenarioGraph, type ScenarioGraphGapCause, EVIDENCE_MEMBERS
} from '@atest/engine';
import { callSites, defineScenario, scenarioIdOfRef, type Scenario, type ScenarioDraft } from '@atest/ir';
import { buildEvidencePackage, readEvidenceMember, readZipEntries, writeEvidencePackage } from '@atest/store';

import { formatErrors, type ParsedArgs } from './args.js';
import { CI_HINT, EXIT } from './exit.js';
import { buildEnvFingerprint } from './fingerprint.js';
import { gateAfterRun, gateBeforeRun, isTriage } from './gate.js';
import { generateScenarios, renderScenarioJson, strategyOf, STRATEGIES, GENERATED_STRATEGY_IDS } from './gen.js';
import { findConfig, resolveEnvFile, resolveScenarioPath, writeConfig, DEFAULT_CONFIG, CONFIG_FILE, type ProjectConfig } from './paths.js';
import {
  assemble, buildAuthLayer, CliError, DocRegistry, loadScenarioFile, makeClock, startLocalMock, buildEnv, secretEnvKey,
} from './wiring.js';
import { authCheckExit, checkAuth } from './authcheck.js';
import { installSignalHandlers, type AbortFlag } from './signals.js';

export interface Io {
  out(s: string): void;
  err(s: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
}

/**
 * `call` 步骤的子场景解析器：把 `scenarioRef`（`id@version`）换成磁盘上另一份 IR。
 *
 * **以前 CLI 压根没接这个端口** —— 引擎里的 `call` 分支早就写全了（子变量空间、
 * 成本汇总、childRuns…），而 `atest run` 从来装配不出解析器，于是任何带 `call` 的
 * 场景都跑不了。这类"下半截没人接"是本仓反复出现的缺陷类，之所以一直没暴露：
 * 所有 e2e 用例都是单文件场景，`call` 只在引擎的单测里被手工注入过。
 *
 * 三个刻意的选择：
 *  1. **解析失败返回 undefined，不抛**。引擎据此报 env-unavailable 并带上 ref，
 *     比这里抛一个 CliError 好：那时错误发生在装配期，人只知道"某个 ref 有问题"，
 *     而运行期报错带着**是哪一步**的 call 失败了。
 *     （只有 `--scenario -` 这种没目录可搜的情况除外，那种在装配期就能说清。）
 *  2. **缓存按 ref**。同一个子场景被 call 十次只解析一次；也顺带让
 *     "同一份 IR 的两次 call 用的是同一棵对象"这件事成立（引擎按 id 判环，
 *     但缓存避免每次重读磁盘，间接少一批 IO 失败面）。
 *  3. **子场景的 frozen 不在这里判**。CI 只跑 frozen 场景这条闸由 gateBeforeRun
 *     在**入口场景**上判；子场景是入口场景的一部分，它的 frozen 与否跟着入口走。
 *     在这里再判一次会出现"父冻结、子没冻结 => 整条跑不了"，
 *     而作者压根没打算单独跑那个子场景。
 */
export function makeCallResolver(o: {
  cfg: ProjectConfig | undefined;
  cwd: string;
  /**
   * 入口场景**所在的目录**。`--scenario /somewhere/else/x.json` 时子场景
   * 往往和它放在一起，而项目配置指向的是另一个仓库根 —— 只搜配置根会找不到。
   */
  scenarioDir?: string;
  /**
   * 解析失败的**原因**按 ref 记在这里（可选；不传就什么都不记，`run` 那条路径正是这样）。
   *
   * ## 为什么要区分原因，而不是"反正都失败了"
   *
   * `lint` 要把它写进 `CALL_GRAPH_INCOMPLETE`，而"文件不存在"与"文件里的 IR 不合法"
   * 是两种修法。本轮实测过混成一件事的代价：子 IR 不合法时话说成"1 个 call 目标**解析不到**"，
   * 于是人去查那个 ref 存不存在、拼没拼错 —— 而真相是文件一直在，里面那份 IR 读不出。
   *
   * ## 为什么是**一张按 ref 键的表**而不是一个"最后一次失败"的回调
   *
   * 两个原因，第二个是硬的：
   *  1. 回调只能传"刚刚失败的那一个"，而缺口由**遍历侧**组装（只有它知道是谁发起的）。
   *     于是遍历要能问"这个 ref 为什么失败"，那就得有一张表。
   *  2. 解析器**按 ref 缓存**：同一个坏 ref 被 call 两次，第二次命中缓存、压根不再解析，
   *     所以 onGap 只响一次。用"最后一次"当原因的话，第二个缺口会挂上别的 ref 的原因 ——
   *     那是**凭空捏造的归因**，比没有原因更坏。表天然没这个问题（键就是 ref）。
   *
   * ⚠ 表是**只增不改**的：不做失效、不做删除，因为一次 lint/run 期间磁盘上的 IR 视为不变
   *   （与缓存同一个前提）。缓存会跟着进程一起没，表也一样 —— 别把它当跨调用的缓存用。
   */
  gapLog?: Map<string, ScenarioGraphGapCause>;
/*
 * 返回类型不是 `AdapterRegistry['callScenario']` 而是它的 NonNullable：
 * 那个端口是**可选属性**，类型里带着 undefined，而这个工厂永远不会返回 undefined。
 * 挂着可选类型的话，每个"我确实拿到了一个解析器"的调用点都得自己再收窄一次
 * （本轮加 buildScenarioGraph 时就是这样，编译报错报在调用点上，读起来像
 *  是那个新函数写错了 —— 真相是这个函数的返回值说得比实际宽）。
 */
}): NonNullable<AdapterRegistry['callScenario']> {
  const cache = new Map<string, Promise<Scenario | undefined>>();
  return (ref: string) => {
    const hit = cache.get(ref);
    if (hit) return hit;
    // 切分只走 scenarioIdOfRef。这行从前是手写的 `ref.split('@')[0]!` ——
    // 而 `scenarioIdOfRef` 的注释里明写着"别让用户各写一遍"，它自己却被抄了一份，
    // 还是在这个文件里（同一族"判据有唯一支点而被抄两处"，本轮由 ref-split.test.ts
    // 那条扫源码的测试抓出来）。抄的那份今天行为相同，改天版本语义落地时
    // 只改 IR 那一处，这里就会安静地继续按 id 找 —— 而没有任何东西会红。
    const id = scenarioIdOfRef(ref);
    /*
     * **`@version` 今天不参与解析**，只按 id 找文件 —— `sub.login@2` 与 `sub.login@1`
     * 落到同一个文件。这是**已知缺口**而不是设计：平台还没有版本表（证据包里的
     * `versionId` 同样还是 `undefined`，见 docs/14 §5），本地文件系统里
     * "一个 id 一个文件"就是当前唯一的版本形态。
     *
     * 之所以**不**在这里报错或忽略整个 ref：作者写 `@2` 说明他心里有"版本"这个概念，
     * 今天静默忽略它比告诉他"版本还不参与解析"坏得多 —— 他会以为 CI 跑的是第 2 版。
     * **而"告诉他"这一半本轮已经接上了**：不在这里报，而是由解释器发
     * `CALL_VERSION_IGNORED` 那条运行期提醒（`interpreter.ts` 的 call 分支），
     * 于是它同时进 `report.html` / `junit.xml` / `summary.txt` 三个出口。
     * 为什么不在这里报：这里只有 ref 字符串，不知道**是哪一步**的 call 在要它，
     * 而装配期抛错会让整场跑不了 —— 那条提醒的取舍（照跑 + 说清楚）在解释器那边写着。
     *
     * 版本表落地时要一起改的还有 call 的解析与证据里的 versionId，别只改这一处。
     */
    const p = (async () => {
      // resolveScenarioPath 内部已经按 [cfg.irDir, cfg.root, 递归按内部 id 找] 搜过，
      // 所以带 cfg 调一次就覆盖整个项目；没配置时退到 cwd，最后再退到入口文件旁边。
      // 不写成"对每个根各调一次带 cfg"：那会把同一批目录搜三遍，纯浪费 IO。
      const attempts: Array<{ cfg: ProjectConfig | undefined; cwd: string }> = [
        { cfg: o.cfg, cwd: o.cwd },
        // 入口文件在旁边：--scenario /tmp/x.json 而子场景和它放一起（没项目配置时
        // 第一条退到 cwd，通常就够；有配置时这条覆盖"场景放在项目外"的情况）
        ...(o.scenarioDir && o.scenarioDir !== o.cwd ? [{ cfg: o.cfg, cwd: o.scenarioDir }] : []),
      ];
      /*
       * **"文件找不到"与"文件在而那份 IR 读不出"必须分开报**，混成一件事的后果本轮实测过：
       * 子场景 IR 不合法时，缺口话说成"1 个 call 目标**解析不到**（例如 X）"，
       * 于是人去查 X 存不存在、拼没拼错 —— 而真相是那个文件里的 IR 本身不合法。
       * 这一格还比"缺文件"更要紧：**环可能正藏在那个读不出来的文件里**。
       *
       * 原因只进 `gapLog`、不进返回值：端口的返回类型是 `Scenario | undefined`
       * （引擎据此报 env-unavailable），改它等于改引擎契约。
       *
       * ⚠ **detail 只取首行**是有意的：这句话会进 CI 日志，而校验失败最常见的对象是
       * 登录请求 —— 整段 zod 清单搬进 lint 的输出，就等于把实际值往磁盘上写
       * （同一族约束：ajv 那处刻意不输出 `er.data`、`HARDCODED_SECRET` 只打印长度）。
       * 首行是"共 N 处问题 / 不是合法 JSON"这一类**不含值**的概括句；
       * 真正带值的那些行（`body.3.target → …`）留在作者直接 `atest lint <那个文件>` 时看。
       * 即便如此，输出侧还有一道 `redactSecretText`（engine 的 `graphGapSummary`）——
       * 纵深防御：这一格的内容来自**外部文件**，我不能假设它永远只有一行无害文字。
       */
      let invalid: string | undefined;
      for (const a of attempts) {
        try {
          const path = await resolveScenarioPath(a.cfg, id, a.cwd);
          try {
            return (await loadScenarioFile(path)).scenario;
          } catch (e) {
            /*
             * 取首行**并去掉结尾的冒号**：那行往往写着「…共 N 处问题：」，
             * 冒号后面是要被我们丢掉的清单。留着它，这句话就以一个"接下来还有内容"
             * 的记号结尾而后面什么都没有 —— 读的人会等那个不来的下文。
             */
            const first = (e as Error).message.split('\n').find((l) => l.trim())?.trim() ?? String(e);
            invalid = first.replace(/[:：]\s*$/, '');
            // 这一份读不出，换下一个候选根：别处可能还有一份同 id 的能读
          }
        } catch { /* 这个根下没找到，换下一个 */ }
      }
      /*
       * 只记 `reason`/`detail`，**不记 `from`** —— 解析器不知道是谁发起的这条 call
       * （它只被问"这个 ref 有没有 IR"），编一个 `from` 会被打印成归因。
       * `detail` 只取首行：这句话会进 CI 日志，而校验失败最常见的对象是登录请求，
       * 整段清单搬进来就等于把实际值往磁盘上写（同一族约束见 ajv 那处刻意不输出 data）。
       */
      o.gapLog?.set(ref, invalid ? { reason: 'invalid-ir', detail: invalid } : { reason: 'not-found' });
      return undefined;
    })();
    cache.set(ref, p);
    return p;
  };
}

/**
 * `buildScenarioGraph` 的默认节点上限。
 *
 * 为什么要有上限而不是"走到走不动为止"：**环**。`A↔B` 时，"解析过就不再解析"
 * 这一条确实让它停得住，但那道护栏一旦哪天被改松（改成按 ref 去重、或加一层
 * `@version` 感知），无上限的遍历就变成**永远不返回的 lint**。一条静态检查
 * 卡死的后果比漏报一个环更糟：人会去掉这条检查，然后连"它以前能查出来"这件事都忘了。
 * 200 个节点是一棵真实调用树很难达到的规模（用例复用得再深也到不了），
 * 触到上限时**报"图不完整"而不是静默**（`CALL_GRAPH_INCOMPLETE`）。
 */
export const DEFAULT_MAX_CALL_NODES = 200;

/**
 * 沿 `call` 走**可达闭包**，产出 `DEPENDENCY_CYCLE` 要的调用图。
 *
 * ## 为什么不扫全仓（这条推翻了 docs/14 §5 原先登记的"填它要先把整棵调用图从文件系统扫出来"）
 *
 * 环检测要的不是"全仓所有的边"，而是**从入口场景能走到的那些边**。
 * 一条不在可达范围内的环，无论多环，都跟这条用例无关；而可达的那些边
 * 用 `makeCallResolver` **本来就有的能力**一跳一跳问得到 —— 不需要 readdir、
 * 不需要新端口、不需要 engine 反过来依赖文件系统（那违反 `lint-layers`）。
 *
 * ## 完整性是返回值的**一部分**，不是旁证
 *
 * 解析不到的 ref 进 `gaps`、触上限进 `truncated`。这两个字段不是诊断信息：
 * 报告写「✓ 通过」而图缺了一条边时，"没有环"是个**超出证据的结论**。
 * 所以调用方拿到图之后要判 `graphComplete()`，而不是"有没有 DEPENDENCY_CYCLE"。
 *
 * ## 边记的是 IR 写的话，不是"我查到的"
 *
 * 解析失败的 ref，它的边**照样记录**（IR 上确实写着 call 它），缺口另外记一条。
 * 那样 `edges` 始终是"作者写了什么"的忠实投影 —— 而"我能不能看懂它"在 gaps 里。
 * 混在一起（解析失败就不记边）会让图悄悄变小，而悄悄变小的图正是这条函数要防的东西。
 */
export async function buildScenarioGraph(
  scenario: Scenario,
  /** 就是 makeCallResolver 的返回值。用 NonNullable 包一层是因为
   *  `AdapterRegistry['callScenario']` 取自**可选属性**，类型里带着 undefined ——
   *  而这里没有"没注入解析器"这一档：没图就别调本函数。 */
  resolveRef: NonNullable<AdapterRegistry['callScenario']>,
  opts: {
    maxNodes?: number;
    /**
     * 某个 ref **为什么**解析不出来 —— 由 `makeCallResolver` 的 `onGap` 边解析边记下来，
     * 这里按 ref 取。
     *
     * 为什么不让解析器自己把缺口塞进图：`reason` 来自"文件找不到"还是"IR 读不出"，
     * 只有解析器知道；而**它是谁发起的**只有这里的遍历知道。两边各持一半事实，
     * 所以缺口由这里组装、原因从那里取。
     *
     * ⚠ 这一格**只能按 ref 查，不能"记住最后一次 onGap"**：解析器按 ref 缓存，
     * 同一个坏 ref 被 call 两次时 onGap 只响一次（第二次命中缓存，压根没重新解析）。
     * 用"最后一次"的话，第二个缺口会挂上别的 ref 的原因 —— 那是**凭空捏造的归因**，
     * 比没有原因更坏（本轮就是被一句错归因送去做无用功的，见 docs/14 §6 第 18 条）。
     */
    gapReasonOf?: (ref: string) => ScenarioGraphGapCause | undefined;
  } = {},
): Promise<ScenarioGraph> {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_CALL_NODES;
  const edges = new Map<string, string[]>();
  const link = (from: string, sites: ReturnType<typeof callSites>): void => {
    const list = edges.get(from) ?? [];
    for (const c of sites) if (!list.includes(c.id)) list.push(c.id);
    edges.set(from, list);
  };
  const gaps: NonNullable<ScenarioGraph['gaps']> = [];
  // 入口自己占一个额度：否则 maxNodes=1 时下面那句判据永远不触发，
  // 而"节点上限"这个概念在测试里就永远没有可达的那条分支。
  const expanded = new Set<string>([scenario.id]);
  const queue: Scenario[] = [scenario];
  let truncated = 0;
  link(scenario.id, callSites(scenario));
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of callSites(cur)) {
      // 已展开过的、以及**环上的祖先**都从这里跳过：边已经记下了（上面那轮 link），
      // 不重复展开正是让 A↔B 停得住的那一条
      if (expanded.has(c.id)) continue;
      if (expanded.size >= maxNodes) { truncated++; continue; }
      const child = await resolveRef(c.ref);
      // 解析不到 = "从这里往下的环判不出"。不当成环（它可能只是没 checkout），
      // 也不能当"没有环"—— 所以进 gaps，由 lint 侧的 CALL_GRAPH_INCOMPLETE 说话
      if (!child) {
        const why = opts.gapReasonOf?.(c.ref);
        gaps.push({
          from: cur.id,
          ref: c.ref,
          ...(why?.reason ? { reason: why.reason } : {}),
          ...(why?.detail ? { detail: why.detail } : {}),
        });
        continue;
      }
      expanded.add(c.id);
      link(child.id, callSites(child));
      /*
       * **ref 里的 id 与解析到的那份 IR 的内部 id 不一致时，两个键都要挂上出边。**
       * 这不是假想：`resolveScenarioPath` 先按**文件名**试 `<id>.json`，
       * 而 paths.ts 里写着"文件名与 id 不一致是常态：改名后 id 常留旧的"。
       * 只按内部 id 挂的话，图里会有一条指向 `scn.b` 的边而 `scn.b` 那一格是空的 ——
       * 遍历到那里当叶子收工，于是"经由那条边才看得见"的环全部漏报，
       * 而**图看起来是完整的**（gaps 里没有它，因为解析成功了）。
       * 那正是本函数开头声称要防的形状，所以在这里补掉。
       */
      if (child.id !== c.id) link(c.id, callSites(child));
      queue.push(child);
    }
  }
  return {
    edges: Object.fromEntries(edges),
    ...(gaps.length ? { gaps } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

export interface CommandResult {
  code: number;
  /** 短结论。测试与 --json 都读它，所以它必须稳定（人看的长文本走 io.out） */
  summary?: string;
}

// ── atest run ─────────────────────────────────────────────────────────────

/**
 * 跑一个（或多个）场景，产出 trace.jsonl / junit.xml / evidence.zip。
 *
 * 这里有一处**故意没有做的事**：不在 run 里顺便 lint。
 * 看起来更友好，实际后果是 lint 的 error 与运行结果混在同一个退出码里，
 * 于是"IR 写得不对"与"产品坏了"都是 exit 1。要 lint 就显式跑 `atest lint`，
 * 或在自己的 CI 步骤里先跑它（`run` 的 --strict 只把 lint error 提升为拒绝执行，
 * 仍然用 EXIT.INVALID 区分开）。
 */
export async function cmdRun(a: ParsedArgs, io: Io): Promise<CommandResult> {
  const files = a.positionals;
  if (!files.length) {
    throw new CliError('run 需要一个场景：atest run <场景 id 或 IR 文件路径>', EXIT.USAGE, '不知道写什么就先 `atest init` 再 `atest gen --doc shop=<openapi.json>`');
  }

  const ci = flag(a, 'ci');
  const cfg = await findConfig(io.cwd);
  const clock = makeClock(str(a, 'clock'), a.flags.seed === undefined ? undefined : Number(a.flags.seed));

  const envName = str(a, 'env') ?? cfg?.defaultEnv;
  // 这里原本是 `!str(a, 'local')` —— str() 只认字符串值，布尔开关恒返回 undefined，
  // 于是 --local 也 mandatory 要环境，等于这个开关白加。
  // 布尔与带值两类 flag 的取值函数不同，混用不会报错只会静默失效，
  // 所以取完值就断言一次：flag() 与 str() 对同一个开关不可能同时有值
  if (!envName && !a.multi['env-var']?.length && !flag(a, 'local')) {
    throw new CliError('没有环境。用 --env staging（读 env/staging.json）或 --env-var baseUrl=http://127.0.0.1:8080', EXIT.USAGE);
  }
  const envFile = envName ? await resolveEnvFile(cfg, envName, io.cwd) : undefined;
  const env = buildEnv(envFile, a.multi['env-var'] ?? []);

  const registry = await DocRegistry.load(a.multi.doc ?? []);
  const evidenceDir = str(a, 'evidence-dir') ?? cfg?.evidenceDir ?? join(io.cwd, DEFAULT_CONFIG.evidenceDir);

  /*
   * **接信号**（Ctrl-C / CI runner 的 cancel）。这一段以前不存在，于是
   * `exit.ts` 的 `ABORTED = 10` 与 `CI_HINT` 里那句「10 被中断」是**没有生产者的契约**，
   * 而 `report.aborted` 只在中断来自超时/熔断时才可能出（外部取消那条路压根走不到引擎）。
   * 判据与"为什么第一次只置标志、第二次才真死"全在 signals.ts。
   *
   * 装在**命令**这一层而不是 runOne 里：多个场景共用一个标志，
   * 这样在第 1 个场景上按的 Ctrl-C 会跳过第 2、3 个（runOne 里装的话，
   * 每个场景都会重新"允许被取消"，而人按的那一下只作用于当时那个场景 ——
   * 那恰好是人在取消一批用例时最不想要的行为）。
   */
  const signals = installSignalHandlers({
    onAbort: ({ sig, sameSignal }) => {
      // 同步一句、立刻打。信号栈里不能 await，而**什么都不打**的表现是
      // "按了没反应，还得多等几秒才知道有没有生效" —— 于是人会再按一次。
      if (sameSignal) {
        // 第二次同名：signals.ts 马上要把进程打死。这里**只说已经发生的事**，
        // 不说"正在收尾"那种假进度（进程不会活到收尾）。
        io.err(`再次收到 ${sig}：立即终止，**放弃**证据包、teardown 与设备归还。`);
        return;
      }
      io.err(`收到 ${sig}：正在收尾（已完成的步骤会照常产出证据包，teardown 与设备归还也要跑完）。`);
      io.err('  再按一次同样的键**立刻终止**，代价是：没有证据包、没有 teardown、设备租约不归还。');
    },
  });

  const results: CommandResult[] = [];
  // 显式类型：EXIT.OK 是字面量 0，不标注的话 worst 被推成 0，后面赋别的码就报
  // "number 不能赋给 0" —— 那个报错会让人以为 worseExit 写错了，其实是推断问题
  let worst: number = EXIT.OK;
  /** 被取消挡掉的场景数。**必须进退出码**，否则"取消"在流水线里是绿的（见 exitAfterCancelledBatch） */
  let skippedByCancel = 0;
  try {
    for (const f of files) {
      if (signals.signal.aborted) {
        skippedByCancel++;
        // 明说"没跑"，而不是静默 break：静默的话输出里只有前几个场景的结论，
        // 而人以为这批跑完了（docs/14 §4.3 那一族"少跑了的东西不留一行"）
        io.err(`已跳过 ${f}：本次运行已被 ${signals.signal.sig() ?? '信号'}取消，它**一步都没跑**。`);
        continue;
      }
      const one = await runOne({ file: f, a, io, ci, cfg, clock, env, registry, evidenceDir, signal: signals.signal });
      results.push(one);
      // 取"更坏"的那个码。顺序按语义严重程度而不是数值大小：
      // USAGE/INVALID 比 TEST_FAILED 更要紧（先修配置再谈测试结果），
      // 但数值上 1 < 3，直接 Math.max 会让 IR 不合法被一次测试失败盖掉
      worst = worseExit(worst, one.code);
    }
  } finally {
    // **必须摘**（三条理由见 InstalledSignals.restore 的注释：处理器累加、
    // 同进程后续用例会被误中断、进程期间对 Ctrl-C 免疫）。
    // 放 finally：runOne 抛异常（配置缺失那几条 CliError）时也要摘。
    signals.restore();
  }
  /*
   * **被取消挡掉的场景必须进退出码**。走现成的 `worseExit` 而不是新写一条比较：
   * WORSE_ORDER 里 ABORTED 排在 TEST_FAILED/RUNTIME 之后、USAGE/INVALID/ENV 之前，
   * 正是这里要的语义（"有一步测出产品坏了"之后又被取消 => 说取消这件事；
   * 而"用法本身就错"仍然是更要紧的那条）。复用同一张表也保证不会出现
   * 第二份"谁更坏"的答案 —— 那是本仓反复记的漂移。
   *
   * 不这么做的形状（本轮之前的 cmdRun）：循环 `break` 出去，worst 里只有
   * 已完成那几个的码，全绿时就是 **0** —— 一次"取消"在流水线里留下一个绿灯，
   * 而且是**最安静的那种假绿**：连一个红步骤都没有。
   */
  worst = worseExit(worst, skippedByCancel ? EXIT.ABORTED : EXIT.OK);
  if (skippedByCancel) {
    io.err(`本次运行被取消：${skippedByCancel} 个场景**一个请求都没发**（它们没进 results，所以也不在证据包与 JUnit 里）。`);
  }
  if (files.length > 1) {
    io.out('');
    io.out(`共 ${results.length} 个场景：` + results.map((r) => r.summary ?? '?').join(' | '));
  }
  io.err('');
  io.err(CI_HINT);
  return { code: worst, summary: results.map((r) => r.summary ?? '').join(' ') };
}

async function runOne(o: {
  file: string; a: ParsedArgs; io: Io; ci: boolean;
  cfg: Awaited<ReturnType<typeof findConfig>>; clock: ReturnType<typeof makeClock>;
  env: Record<string, unknown>; registry: DocRegistry; evidenceDir: string;
  /** 取消标志（cmdRun 装的信号处理器给的那个）。必传：漏掉就等于这条路径没接线 */
  signal: AbortFlag;
}): Promise<CommandResult> {
  const { io, a, ci } = o;
  const path = await resolveScenarioPath(o.cfg, o.file, io.cwd);
  const { scenario } = await loadScenarioFile(path);

  if (flag(a, 'strict')) {
    /*
     * 这条分支以前调的是 `lintScenario(scenario)`，**第二个参数压根不传**。
     * 本轮接上调用图之后这件事才变得可观察：`DEPENDENCY_CYCLE` 是 error 级、
     * 要图才响，而 `--strict` 恰恰是 CI 会用的那一档（`atest lint` 是本地手跑）。
     * 传了图之后它响在这里的意思是"**一个请求都不发**就拒绝执行" —— 静态闸的全部价值。
     * 不传的话，环要等到运行时那条 callStack 才发现，那时装配都做完了。
     *
     * 说准一点，免得这段话被读成"--strict 以前所有 ctx 规则都是静默的"：
     * 本轮实测过 `STEP_BUDGET_EXCEEDED`，它读 `ctx.maxCostUsd ?? 2`，
     * 不传 ctx 时**照样响**（用默认上限 2）。所以"不传 ctx"≠"ctx 规则全不跑"，
     * 而是"读了 ctx 里那几个**没有默认值**的字段（图、快照能力）的规则不跑"。
     *
     * 也**不**把 run 的 `--max-cost` 喂给这里的 ctx：同一个开关名在两条命令里
     * 是两个意思（run 那边是"本次运行的成本硬停"，lint 那边 help 写着是
     * "步骤成本预算，喂给 STEP_BUDGET_EXCEEDED"）。把它们接起来看着像顺手修，
     * 实际是把两个语义并成一个 —— 那是产品决策，不是这一轮的活。
     */
    const ctx = await lintCtxFor(scenario, o.cfg, io.cwd, dirname(path), {});
    const rep = toReport(lintScenario(scenario, ctx));
    if (!rep.ok) {
      io.err(`--strict：lint 有 ${rep.errors.length} 个错误，拒绝执行：`);
      for (const e of rep.errors.slice(0, 10)) io.err(`  [${e.code}] ${e.stepId ?? ''} ${e.message}`);
      return { code: EXIT.INVALID, summary: `${scenario.id}: lint 拒绝` };
    }
    // 警告也要打。`--strict` 只按 error 拦执行，但"图不完整"这类话不说出来，
    // 读日志的人会以为这次静态闸看的是全的（CALL_GRAPH_INCOMPLETE 存在的全部理由）
    for (const w of rep.warnings) io.err(`  （--strict 警告，不拦执行）[${w.code}] ${w.stepId ?? ''} ${w.message}`);
  }

  // 执行**前**的闸。frozen/provenance 不满足时连一个请求都不发：
  // 场景里可能有 POST/下单/删除，先跑完再说"这次不算"等于把副作用做了
  const gate0 = gateBeforeRun({ scenario, ci, allowUnfrozen: flag(a, 'allow-unfrozen') });
  for (const r of gate0.reasons) io.err(r);
  if (gate0.refused) return { code: gate0.code, summary: `${scenario.id}: 拒绝执行` };

  // 装配前先把**能确定的配置缺失**拦掉。
  // 不拦会得到引擎那句 "http adapter 未注册" —— 那是我们的内部术语，用户看不出
  // 自己少敲了 --doc；而且它以"运行异常"的身份进退出码，于是流水线照 CI_HINT
  // **重试一次**（配置缺失重试一万次也不会好）。
  // 放在执行前而不是事后按 cause 反推：那时配置缺失与"目标临时挂掉"已经分不开
  // —— 两者的 cause 都是 env-unavailable（见 gate.ts 里那段注释）。
  requireAdapters(scenario, o.registry, flag(a, 'local'));

  // --local：对本地 mock 跑。它的价值是"clone 完第一条命令就能产出证据包"，
  // 所以**必须大声说明这不是真实后端**，否则一次 mock 全绿会被当成"接口没问题"
  let mock;
  if (flag(a, 'local')) {
    if (o.registry.empty()) throw new CliError('--local 需要先导入 spec：--local --doc shop=<openapi.json>', EXIT.USAGE);
    mock = await startLocalMock(o.registry, []);
    o.env.baseUrl = mock.addr;
    io.err(`已对本地 mock 运行（${mock.addr}）。**这不是真实后端**：本次结果只证明"用例能跑通"，不证明产品行为。`);
  }

  const inputs = parseInputs(a.multi.input ?? []);
  /*
   * envRevision **算一次，两处共用**（装配与指纹都要它）。
   * 各算一遍的话，将来某处加了"从环境文件里读默认修订"而另一处没加，
   * 就会出现 run 记录里是 7、指纹里是 0 —— 而指纹的唯一用途就是两次 run 对比，
   * 这种不一致的表现是"基线永远判环境不同"，离这两行很远。
   */
  const envRevision = str(a, 'env-revision') ? Number(a.flags['env-revision']) : undefined;
  const assembled = await assemble({
    scenario, env: o.env, registry: o.registry,
    // 子场景解析器。`path` 可能在项目外（--scenario /tmp/x.json），
    // 所以把入口文件所在目录也交给它当搜索根
    callScenario: makeCallResolver({ cfg: o.cfg, cwd: io.cwd, scenarioDir: dirname(path) }),
    evidenceDir: join(o.evidenceDir, 'artifacts'),
    clock: o.clock,
    envRevision,
    inputs,
    runId: str(a, 'run-id'),
    maxCostUsd: str(a, 'max-cost') ? Number(a.flags['max-cost']) : undefined,
    /*
     * 把取消标志交给装配层。**这一行曾经不存在**，而它是整条管道上最后一段缺口：
     * `cmdRun` 装了处理器、`assemble` 有 `signal` 入参、`runOptions` 会原样透传、
     * 引擎的 `checkAbort` 每步都读 —— 中间这一跳没人接，于是每一层单独看都是对的，
     * 而端到端恒读不到 true（本机实测：证据包文件名 `evidence.sig1.pass.zip`，
     * 退出码却是 10，因为那个 10 来自"后面的场景被跳过"，不是来自这次中断的 run）。
     *
     * 退出码对、产物说"正常通过"，是这个缺陷类里最难发现的一种形状：
     * 只看退出码会以为接线成功了，只看文件名会以为是 store 的问题。
     * 所以这一行由 signal.test.ts 第 10 条**端到端**钉住，而不是由任何单元测试钉
     * —— 单元测试测的是相邻两层，恰好测不到"这两层之间有没有接上"。
     */
    signal: o.signal,
  });
  for (const w of assembled.warnings) io.err(w);

  let report: RunReport;
  try {
    report = await runScenario(assembled.runOptions);
  } finally {
    await mock?.close();
    /*
     * Web adapter 必须关。不关的代价不是"泄漏一点内存"这么抽象：
     * 每次 run 留一个 Chrome 进程 + 一个 mkdtemp 出来的临时 profile（几百 MB），
     * 而症状是"CI 机器跑到第 30 条用例开始变慢 / 磁盘涨"，离原因两步远。
     * 放 finally 而不是成功路径之后：用例失败时**更要**关 —— 失败的 run 往往
     * 正被人连着重跑几十次。
     */
    await assembled.web?.close();
  }

  // 产物先组装（下面既要用 manifest 打摘要，也要写包）。
  // 顺序上"先组包再打摘要"而不是反过来：摘要与包里的 summary.txt 必须是同一份文字，
  // 各算一遍迟早不一致，而人只会拿其中一份去追问"到底哪个数对"
  const pkg = await buildEvidencePackage({
    scenario, report, store: assembled.store,
    /*
     * 环境指纹。**每次都建**，不是"Web 场景才建" ——
     * 平台/被测版本/时钟模式这几维对 API 用例同样关键（同一份 IR 在
     * linux 容器与 mac 上跑，性能数字本来就不可比）。
     * Web 那几维在没起浏览器时自然缺着（字段都是 optional），
     * 缺与"记了但值不同"在比较时是两种结论，不能混。
     */
    envFingerprint: buildEnvFingerprint({
      environmentRef: scenario.env.environmentRef,
      env: o.env,
      envRevision,
      ...(assembled.web ? { web: assembled.web } : {}),
      clock: o.clock,
      ...(str(a, 'seed') ? { randomSeed: Number(a.flags['seed']) } : {}),
    }),
    // 不再按"有没有 provenance"决定给不给：irSha 由存储层无条件算，
    // 这里只负责传版本 id（P1 才有，现在多半是 undefined，如实缺着）
    provenance: { versionId: str(a, 'version-id') },
    junit: { suiteName: scenario.id, classname: scenario.id },
  });
  io.out(summaryText(report, pkg.manifest));

  const gate = gateAfterRun({ scenario, report, ci, allowUnfrozen: flag(a, 'allow-unfrozen') });
  for (const r of gate.reasons) io.err(r);
  if (gate.attention.length) {
    io.err('');
    io.err(`待确认清单（${gate.attention.length}）：`);
    for (const x of gate.attention.slice(0, 20)) io.err(`  · ${x}`);
    if (gate.attention.length > 20) io.err(`  …另有 ${gate.attention.length - 20} 条`);
  }

  // 产物。三样都写：trace 给机器/复盘，junit 给 CI，zip 给"下载给别人看"
  const outDir = join(o.evidenceDir, safeRunId(report.runId));
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, EVIDENCE_FILES.trace), toTraceJsonl(report.events), 'utf8');
  await writeFile(join(outDir, EVIDENCE_FILES.junit), toJUnitXml(report, { suiteName: scenario.id, classname: scenario.id }), 'utf8');
  await writeFile(join(outDir, EVIDENCE_FILES.html), toHtmlReport(report, {
    suiteId: scenario.id, scenarioName: scenario.name, frozen: scenario.frozen, summary: report.summary,
  }), 'utf8');
  // 第四个参数：被砍断的 run 的文件名要写 aborted，不能写 pass（见 writeEvidencePackage）。
  // 只传"有没有中断"这个事实，**状态词由 store 侧定**，否则同一个词两处各拼一遍。
  const written = await writeEvidencePackage(outDir, report.runId, report.status, pkg.bytes, Boolean(report.aborted));
  io.out('');
  io.out(`产物：\n  ${join(outDir, EVIDENCE_FILES.html)}\n  ${join(outDir, EVIDENCE_FILES.junit)}\n  ${join(outDir, EVIDENCE_FILES.trace)}\n  ${written.path}`);
  io.out(`  证据包 sha256=${written.sha256}`);
  if (pkg.missing.length) io.err(`注意：有 ${pkg.missing.length} 个证据在磁盘上已经取不到了（被清理或写盘失败），包里少它们：${pkg.missing.join('、')}`);
  if (flag(a, 'print-junit')) io.out(toJUnitXml(report, { suiteName: scenario.id }));

  return { code: gate.code, summary: `${scenario.id}: ${report.status}` };
}

/**
 * 场景里的 `openapiCall` 需要 spec 文档，缺就**当场说清缺哪个开关**。
 *
 * 只管 openapiCall，**不管纯 http 步骤**：http 不需要 spec，
 * 早先这里连 http 一起拦（配合 assemble 里"有 spec 才注册 adapter"那个条件），
 * 结果是"手写一条 GET"这个最普通的动作报"没有可用的 http adapter"。
 * 判据回到 IR 的事实上：只有 openapiCall 要靠文档解析 operationId/URL 模板。
 */
export function requireAdapters(scenario: Scenario, registry: DocRegistry, local: boolean): void {
  if (local) return; // --local 自己会起 mock 并注册 http
  if (!registry.empty()) return;
  const refs = new Set<string>();
  const scan = (list: readonly unknown[]): void => {
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue;
      const st = raw as Record<string, unknown>;
      if (st.kind === 'openapiCall' && typeof st.docRef === 'string') refs.add(st.docRef);
      // 容器步骤的子步骤也算：循环体里的 openapiCall 一样要解析 operation
      for (const key of ['steps', 'then', 'else', 'default']) {
        const v = st[key];
        if (Array.isArray(v)) scan(v);
      }
      const cases = st.cases;
      if (Array.isArray(cases)) for (const c of cases as Array<Record<string, unknown>>) if (Array.isArray(c.steps)) scan(c.steps);
    }
  };
  scan([...scenario.setup, ...scenario.body, ...scenario.teardown]);
  if (!refs.size) return;
  // 放在执行**前**而不是事后按 cause 反推：那时"缺 spec"与"目标临时挂掉"的 cause
  // 都是 env-unavailable，已经分不开（见 gate.ts 的注释）。
  // 也不让它走到引擎那句 "http adapter 未注册 / 需要文档登记表" —— 那是内部术语，
  // 而且会以"运行异常"的身份进退出码，让流水线去重试一个永远好不了的配置错误。
  throw new CliError(
    `场景 ${scenario.id} 用了 openapiCall，但本次运行没有导入任何 spec`,
    EXIT.ENV,
    `加：${[...refs].map((r) => `--doc ${r}=<openapi.json>`).join(' ')}`,
  );
}

/**
 * runId → 能当目录名/文件名的形态。
 *
 * **清洗字符集不够，还必须显式拒掉 `.` 与 `..`。** 这不是理论问题，实测过：
 * `atest run <场景> --run-id ..` 一路跑到底，`safeRunId('..')` 原样返回 `..`
 * （`.` 恰好是 `[A-Za-z0-9._-]` 里的合法字符），于是
 * `join(evidenceDir, '..')` = **项目根**，四份产物直接落在仓库根上：
 * `trace.jsonl` / `junit.xml` / `report.html` / `evidence....pass.zip`。
 * 后果不是"文件难看"而是**这些文件会被 git 收走**：`.gitignore` 忽略的是
 * `evidence/` 与 `*.trace.jsonl`，而 `report.html`、`junit.xml`、
 * `evidence....pass.zip` 三个名字一个都不在其中 —— 证据包含**真实响应体**
 * （可能带未脱敏 PII），就这么进了一次普通提交。
 * `--run-id` 的说明写着"CI 里用构建号"，也就是说它的值本来就是人/流水线给的，
 * 手滑打两个点完全在正常操作范围内，所以这一格必须自己防，不能靠"没人会这么写"。
 *
 * 判据写成"整个名字是不是保留段"，而不是继续收紧字符集：
 * `..` 是**合法字符组成的非法名字**，按字符永远判不住，而按名字判一次就完。
 */
function safeRunId(s: string): string {
  const safe = s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'run';
  // 清洗之后还要再判一次：`...` 不在保留段里，但它 join 出来同样是往上跳
  return safe === '.' || safe === '..' || /^\.+$/.test(safe) ? `_${safe}` : safe;
}

/**
 * 退出码的"更坏"顺序。按语义而不是数值：
 * USAGE/INVALID 要盖过 TEST_FAILED —— 配置不对时先说配置不对。
 */
const WORSE_ORDER: number[] = [EXIT.OK, EXIT.TEST_FAILED, EXIT.ABORTED, EXIT.RUNTIME, EXIT.ENV, EXIT.INVALID, EXIT.USAGE];
export function worseExit(a: number, b: number): number {
  const ra = WORSE_ORDER.indexOf(a);
  const rb = WORSE_ORDER.indexOf(b);
  // 表外的码（比如将来新增的）按数值兜底，而不是当作最轻
  if (ra < 0 || rb < 0) return Math.max(a, b);
  return ra >= rb ? a : b;
}

function parseInputs(list: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new CliError(`--input 要写成 name=value，实际是 "${kv}"`, EXIT.USAGE);
    const k = kv.slice(0, eq);
    const raw = kv.slice(eq + 1);
    // 先试 JSON：`--input qty=3`、`--input items=[1,2]`、`--input admin=true`。
    // 为什么不是"一律当字符串"：IR 的 inputs 是**有类型的**（ParamDef.type），
    // 全塞字符串会让 `$qty > 1` 这类表达式在比较字符串，得到与作者预期不同的结论
    // 且不报错 —— 那是最难查的一类假绿/假红。
    // 也不"一律 JSON.parse"：`--input name=3x` 会抛，而它明显是个字符串。
    try { out[k] = JSON.parse(raw); } catch { out[k] = raw; }
  }
  return out;
}

// ── atest lint ────────────────────────────────────────────────────────────

/** lintScenario 的第二个参数。**取类型而不是手抄一份字段**：手抄的那份会过期（本仓的老账） */
type LintCtx = Parameters<typeof lintScenario>[1];


/**
 * 给**某一个**场景造 lint 的 ctx（含调用图）。
 *
 * 为什么是"逐场景"造而不是循环外造一次共用：图是**从入口场景往外走**出来的，
 * `atest lint a b` 里 a 与 b 的可达集通常不同。共用的话要么把两个入口都塞进
 * 同一个闭包（多解析一批压根不参与这条判定的场景，白做 IO），
 * 要么就得让"图的覆盖范围"变成一个与入口无关的说法 —— 而它不是。
 */
async function lintCtxFor(
  scenario: Scenario,
  cfg: ProjectConfig | undefined,
  cwd: string,
  /** 入口场景所在目录（`--scenario /somewhere/x.json` 时子场景常放在它旁边） */
  scenarioDir: string,
  opts: { maxCost?: number },
): Promise<LintCtx> {
  const ctx: LintCtx = {};
  if (opts.maxCost !== undefined) ctx.maxCostUsd = opts.maxCost;
  /*
   * 与 run 用**同一个** resolver：如果 lint 自己另写一套 ref→文件的逻辑，
   * 就会出现"lint 说没有环而 run 报解析不到"或反过来 —— 两个判据两份实现的老账。
   *
   * `gapLog` 是原因的唯一去处：resolver 只认 ref，遍历只认"谁发起"，
   * 缺口由这一处把两边拼起来（为什么非要一张表而不是一个回调，写在 `gapLog` 那一格）。
   */
  const gapLog = new Map<string, ScenarioGraphGapCause>();
  ctx.scenarioGraph = await buildScenarioGraph(scenario, makeCallResolver({ cfg, cwd, scenarioDir, gapLog }), {
    gapReasonOf: (ref) => gapLog.get(ref),
  });
  return ctx;
}

export async function cmdLint(a: ParsedArgs, io: Io): Promise<CommandResult> {
  if (!a.positionals.length) throw new CliError('lint 需要目标：atest lint <场景 id 或文件路径>[…]', EXIT.USAGE);
  const cfg = await findConfig(io.cwd);
  const registry = await DocRegistry.load(a.multi.doc ?? []);
  const maxCost = str(a, 'max-cost') ? Number(a.flags['max-cost']) : undefined;

  let bad = false;
  for (const f of a.positionals) {
    const path = await resolveScenarioPath(cfg, f, io.cwd);
    const { scenario } = await loadScenarioFile(path);
    const ctx = await lintCtxFor(scenario, cfg, io.cwd, dirname(path), { ...(maxCost === undefined ? {} : { maxCost }) });
    const issues = lintScenario(scenario, ctx);
    const rep = toReport(issues);
    // 逐条打印：code + 位置 + 一句"为什么这是问题"。
    // 只打 code 的话，人要去查文档才知道 LITERAL_OVERFIT 是什么意思，
    // 而查文档这个动作会让一半人直接关掉这条规则
    for (const i of issues) {
      io.out(`${i.level === 'error' ? '✗' : '!'} [${i.code}]${i.stepId ? ` ${i.stepId}` : ''}：${i.message}`);
      // fix 一定要打出来。lint 报"这里可能有问题"而不给修法，
      // 读者的下一步动作就是去关规则 —— 报错质量决定规则是否真的被修（LintIssue.fix 的注释也是这个意思）
      if (i.fix) io.out(`    修法：${i.fix}`);
    }
    io.out(`${scenario.id}：${rep.summary}`);
    if (!rep.ok) bad = true;
    // 生成物提示：gen 出的场景带 triage，lint 与门禁对它都该松一档，
    // 但**要说明白**，否则人会以为"lint 绿 = 这批用例质量没问题"
    if (isTriage(scenario)) io.err(`  （该场景带 tag triage：首轮待确认，不参与门禁。确认后去掉标签）`);
    if (registry.empty() && scenario.body.some((s) => s.kind === 'openapiCall')) {
      io.err('  提示：场景用了 openapiCall 而本次没导入 spec，依赖 spec 的检查（operationId 是否存在、必填字段齐不齐）跳过了。加 --doc <docRef>=<file>');
    }
  }
  return { code: bad ? EXIT.INVALID : EXIT.OK, summary: bad ? 'lint 有错误' : 'lint 通过' };
}

// ── atest gen ─────────────────────────────────────────────────────────────

/**
 * 从 OpenAPI 生成场景 IR。**模板展开，不是 AI**（理由见 gen.ts 文件头）。
 *
 * 默认**只打印清单不写盘**。这是有意的：
 * 生成器最坏的一次输出是"默默往仓库里写了 40 个文件"，
 * 而人会先看到一片 untracked，然后 `git add .`，然后这 40 个文件进主干。
 * `--write` 才落盘，且落盘前把要写什么全列出来。
 */
export async function cmdGen(a: ParsedArgs, io: Io): Promise<CommandResult> {
  const specs = a.multi.doc ?? [];
  if (!specs.length) {
    throw new CliError('gen 需要一份 OpenAPI 文档：atest gen --doc shop=./spec/openapi.json', EXIT.USAGE, 'docRef 名字（这里的 shop）要与 IR 里 openapiCall.docRef 一致');
  }
  const cfg = await findConfig(io.cwd);
  const registry = await DocRegistry.load(specs);
  const outDir = str(a, 'out') ?? cfg?.irDir ?? join(io.cwd, DEFAULT_CONFIG.irDir);
  // 读规范名 strategy（--strategies 是别名，解析后同样落在 multi.strategy 上）
  const strategies = a.multi.strategy?.length ? a.multi.strategy : ['happyPath'];
  // 策略名写错**必须当场报错**。交给 generateScenarios 收集成 warning 是不够的：
  // `--straegy boundary` 会静默生成一堆 happyPath，而清单看起来完全正常 ——
  // 少生成的那一半没人会去数
  const unknownStrategies = strategies.filter((x) => x !== 'all' && !strategyOf(x));
  if (unknownStrategies.length) {
    throw new CliError(
      `没有这些策略：${unknownStrategies.join('、')}`, EXIT.USAGE,
      `可用：all（= ${GENERATED_STRATEGY_IDS.join(', ')}）；另有暂不生成的 ${STRATEGIES.filter((x) => x.notGenerated).map((x) => x.id).join(', ')}`,
    );
  }
  const envRef = str(a, 'env') ?? cfg?.defaultEnv ?? 'default';

  const all: { file: string; draft: ScenarioDraft }[] = [];
  const allWarnings: string[] = [];

  for (const name of registry.names()) {
    const doc = registry.get(name)!;
    const res = generateScenarios(doc, {
      strategies, envRef, docRef: name,
      only: a.multi.only, skip: a.multi.skip,
      happyOnly: flag(a, 'happy-only'),
      idPrefix: str(a, 'id-prefix') ?? (registry.names().length > 1 ? name : undefined),
      pathParamVar: str(a, 'path-param-var'),
    });
    all.push(...res.scenarios.map((s) => ({ file: s.file, draft: s.draft })));
    allWarnings.push(...res.warnings.map((w) => `[${name}] ${w}`));
    io.out(`${name}：可生成 ${res.scenarios.length} 个场景，跳过 ${res.skipped.length} 个（specHash=${res.specHash}）`);
    // 跳过清单必须打出来。静默少生成会让"覆盖 100%"变成错觉
    for (const s of res.skipped.slice(0, 15)) io.err(`  · ${s.operationId} / ${s.strategy}：${s.reason}`);
    if (res.skipped.length > 15) io.err(`  …另有 ${res.skipped.length - 15} 条`);
  }
  for (const w of allWarnings) io.err(`提示：${w}`);
  if (!all.length) return { code: EXIT.ENV, summary: '没生成任何东西' };

  // 先校验再写。**生成出不合法的 IR 是生成器的 bug**，
  // 让它进磁盘的后果是"用户第一次跑 lint 就红一片"，而锅看起来在用户那边
  const drafts: Scenario[] = [];
  for (const s of all) {
    try { drafts.push(defineScenario(s.draft)); }
    catch (e) {
      io.err(`内部错误：生成的 ${s.file} 不是合法 IR —— ${(e as Error).message}`);
      io.err('这是生成器的缺陷，请连 spec 一起报出来。已中止，未写任何文件。');
      return { code: EXIT.RUNTIME, summary: '生成器产出不合法 IR' };
    }
  }

  io.out('');
  io.out(`将写入 ${all.length} 个文件到 ${outDir}（当前是预览，加 --write 才落盘）：`);
  for (const s of all) io.out(`  ${join(outDir, s.file)}`);

  if (!flag(a, 'write')) {
    io.err('');
    io.err('未写盘。确认清单没问题后加 --write。');
    return { code: EXIT.OK, summary: `预览 ${all.length} 个` };
  }

  await mkdir(outDir, { recursive: true });
  let writtenNew = 0;
  let skippedExists = 0;
  for (const s of all) {
    const p = join(outDir, s.file);
    const body = renderScenarioJson(s.draft);
    if (flag(a, 'check')) {
      // --check 用在 CI：验证"重新生成没有差异"，即生成器与手写改动没有漂移。
      // spec 改了而用例没重新生成，是生成式用例集腐烂的主要方式
      const cur = await readIfExists(p);
      if (cur === undefined) { io.err(`CI 检查失败：${p} 不存在。生成物没提交，或 spec 新增了 operation`); skippedExists++; }
      else if (cur !== body) { io.err(`CI 检查失败：${p} 与重新生成的结果不一致。要么重跑 atest gen --write 并提交，要么这个改动是手写的（那就别让它被 gen 覆盖）`); skippedExists++; }
      continue;
    }
    if (!flag(a, 'force')) {
      const cur = await readIfExists(p);
      // **不覆盖已有文件**，除非 --force。有人会在生成的用例上手写补充断言，
      // 一次无心的 gen --write 会把它连同人的工作一起抹掉，而 git 里可能还没提交
      if (cur !== undefined && cur !== body) {
        io.err(`已存在且内容不同，跳过：${p}（要覆盖用 --force；在手写过的用例上重新生成前，先 diff 一下）`);
        skippedExists++;
        continue;
      }
      if (cur === body) { skippedExists++; continue; } // 字节相同，连写都不用
    }
    await writeFile(p, body, 'utf8');
    writtenNew++;
  }
  if (flag(a, 'check')) {
    return skippedExists
      ? { code: EXIT.INVALID, summary: `${skippedExists} 个文件与生成结果不一致` }
      : { code: EXIT.OK, summary: '生成物与 spec 一致' };
  }
  io.out('');
  io.out(`写入 ${writtenNew} 个新文件，未改动 ${skippedExists} 个。`);
  io.err('下一步：');
  io.err(`  1. atest run --env <环境> --doc <docRef>=<spec 文件> <场景 id>`);
  io.err(`  2. 首轮请只看带 tag triage 的那批（requiredMissing/typeViolation/negativeFuzz），确认真缺陷后去掉标签`);
  io.err('  3. 人审过再改 frozen=true，才能进 CI');
  return { code: EXIT.OK, summary: `写入 ${writtenNew} 个` };
}

async function readIfExists(p: string): Promise<string | undefined> {
  try { return await readFile(p, 'utf8'); } catch { return undefined; }
}

// ── atest agent ───────────────────────────────────────────────────────────

/**
 * `atest agent` —— 自然语言 → 场景 IR（M4/M5）。
 *
 * **本环境不可用，而且这里不做任何假装。** 判据是"一句话导入 swagger 生成 20 条场景"，
 * 它需要 tool-calling 模型；当前模型组返回
 * `400 tool_choice requires at least one available tool`（docs/04 末行记着）。
 *
 * 为什么把"不可用"写成一个正经命令而不是"还没有这个命令"：
 * `agent` 在 docs/04 的 M6 交付清单里，用户会照着文档敲。
 * 一个报"command not found"的 CLI 会让人怀疑整个工具没做；
 * 而这条命令会**说清缺什么、现在能用什么替代、以及替代方案的差别在哪**。
 *
 * 它同时把请求参数校验做全了 —— 等模型组可用时，
 * 只需要替换 runAgentTurn 这一个函数体，开关契约不用重做一遍。
 */
export async function cmdAgent(a: ParsedArgs, io: Io): Promise<CommandResult> {
  const goal = a.positionals.join(' ').trim();
  if (!goal) throw new CliError('agent 需要一句话目标：atest agent "下单后库存应该减一" ', EXIT.USAGE);

  // 这些开关是 M4/M5 的契约。现在就把它们接上并校验，将来实现时不需要重新发明一遍
  const maxTurns = a.flags['max-turns'] === undefined ? 8 : Number(a.flags['max-turns']);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) {
    throw new CliError(`--max-turns 要是 1..50 的整数，实际是 "${a.flags['max-turns']}"`, EXIT.USAGE);
  }
  const budget = a.flags['max-cost-usd'] === undefined ? 0.5 : Number(a.flags['max-cost-usd']);
  if (!Number.isFinite(budget) || budget < 0) throw new CliError(`--max-cost-usd 要是非负数，实际是 "${a.flags['max-cost-usd']}"`, EXIT.USAGE);
  if (flag(a, 'yes')) {
    throw new CliError('--yes（跳过人工确认）在 Agent 模式下不被接受', EXIT.USAGE,
      'Agent 会发真请求、可能触发写操作。不可逆动作必须过人（docs/02 §5 的白名单约束），这条不开关');
  }

  io.out(`目标：${goal}`);
  io.out(`预算：最多 ${maxTurns} 轮、\$${budget}`);
  io.err('');
  io.err('Agent 模式当前不可用：模型组不支持 tool call。');
  io.err('  网关报错原文：400 "tool_choice requires at least one available tool"');
  io.err('  这不是配置能绕过的问题（换 base-url 也没用），需要换支持 function calling 的模型组。');
  io.err('');
  io.err('现在能做的（差别要说清）：');
  io.err('  atest gen --doc shop=<openapi.json> --strategies all   # 确定性生成，覆盖 docs/05 §3 的 6 种策略');
  io.err('    与 agent 的差别：gen 是模板展开，不会读接口描述去推断业务语义，');
  io.err('    也生成不出跨接口的状态链（statefulSequence）—— 那正是 agent 的价值所在。');
  io.err('  atest lint <场景>  +  atest run --strict              # 静态闸与执行，这两条完全可用');
  return { code: EXIT.ENV, summary: 'agent 不可用（模型组不支持 tool call）' };
}

// ── atest init / evidence ─────────────────────────────────────────────────

export async function cmdInit(a: ParsedArgs, io: Io): Promise<CommandResult> {
  const root = io.cwd;
  const path = await writeConfig(root, {
    ...(str(a, 'ir-dir') ? { irDir: str(a, 'ir-dir') as string } : {}),
    ...(str(a, 'env-dir') ? { envDir: str(a, 'env-dir') as string } : {}),
    ...(str(a, 'env') ? { defaultEnv: str(a, 'env') as string } : {}),
  });
  const dirs = [str(a, 'ir-dir') ?? DEFAULT_CONFIG.irDir, str(a, 'env-dir') ?? DEFAULT_CONFIG.envDir, DEFAULT_CONFIG.evidenceDir];
  for (const d of dirs) await mkdir(join(root, d), { recursive: true });
  io.out(`已写 ${path}`);
  io.out(`已建目录：${dirs.join('、')}`);
  io.err(`注意：${DEFAULT_CONFIG.evidenceDir}/ 含真实响应体（可能带未脱敏 PII），已在 .gitignore 里 —— 若这是新仓库，先确认 .gitignore 有它再提交。`);
  io.err('下一步：');
  io.err(`  1. 写 ${str(a, 'env-dir') ?? DEFAULT_CONFIG.envDir}/${str(a, 'env') ?? 'dev'}.json，形如 {"baseUrl":"https://api.dev.internal"}`);
  io.err('  2. atest gen --doc shop=<openapi.json> --write');
  io.err('  3. atest run <场景 id> --doc shop=<openapi.json>');
  return { code: EXIT.OK, summary: `已初始化 ${root}` };
}

/**
 * `evidence show` 的用法提示里那份成员清单。**从 EVIDENCE_MEMBERS 派生**而不是手抄：
 * 手抄那份在本轮加 report.html 时就漏了一格，症状是"人不知道能 show 它"，
 * 不报错、不变红 —— 与它同类的还有 html 报告里那份白名单与页脚链接。
 */
function memberHint(): string {
  return `${EVIDENCE_MEMBERS.join(' / ')} / ${EVIDENCE_FILES.artifactsDir}/<sha256>`;
}

export async function cmdEvidence(a: ParsedArgs, io: Io): Promise<CommandResult> {
  const sub = a.positionals[0];
  const file = a.positionals[1];
  if (!sub || !file) {
    throw new CliError('用法：atest evidence show <evidence.zip> [成员名] | atest evidence list <evidence.zip>', EXIT.USAGE,
      `成员名可选：${memberHint()}。拿不准就先跑 list`);
  }
  if (sub === 'list') {
    const names = await listMembers(file);
    for (const n of names) io.out(n);
    return { code: EXIT.OK, summary: `${names.length} 个成员` };
  }
  if (sub !== 'show') throw new CliError(`evidence 没有子命令 ${sub}（可用：show / list）`, EXIT.USAGE);
  const name = a.positionals[2] ?? EVIDENCE_FILES.summary;
  io.out(await readEvidenceMember(file, name));
  return { code: EXIT.OK, summary: name };
}

async function listMembers(path: string): Promise<string[]> {
  const buf = await readFile(path);
  return readZipEntries(new Uint8Array(buf)).map((e) => `${e.name}  (${e.data.byteLength} 字节)`);
}

// ── atest auth-check ──────────────────────────────────────────────────────

/**
 * 逐 securityScheme × 逐身份验证凭证（docs/05 §2）。
 *
 * 那条文档说这个命令"性价比高于任何 AI 功能"，理由是具体的：
 * "生成用例跑出来全是 401" 是 API 平台的第一体验杀手，而它的原因九成在环境配置，
 * 一次 401 让人查两小时产品代码，比任何一次生成质量不够都更劝退。
 *
 * 本函数**只做输入装配与打印**，判读全在 authcheck.ts ——
 * 那样"500 算凭证被接受"这类判断能被直接测试，不需要起真后端。
 */
export async function cmdAuthCheck(a: ParsedArgs, io: Io): Promise<CommandResult> {
  const specs = a.multi.doc ?? [];
  if (!specs.length) {
    throw new CliError(
      'auth-check 需要至少一份 OpenAPI 文档：atest auth-check --doc shop=./spec/openapi.json --env staging',
      EXIT.USAGE,
      '没有 spec 就无从知道"哪个接口要哪种鉴权"。这时只能用 atest run 跑一条带 auth 字段的用例去看真实响应',
    );
  }
  const envName = str(a, 'env');
  if (!envName && !a.multi['env-var']?.length) {
    throw new CliError('没有环境。凭证是按环境配的，所以这里必须指定：--env staging', EXIT.USAGE);
  }
  const cfg = await findConfig(io.cwd);
  const envFile = envName ? await resolveEnvFile(cfg, envName, io.cwd) : undefined;
  const env = buildEnv(envFile, a.multi['env-var'] ?? []);
  const registry = await DocRegistry.load(specs);

  const auth = buildAuthLayer({
    registry, env,
    environmentRef: envName ?? 'inline',
    now: () => Date.now(),
    // io.env 而不是 process.env：Io 是这套 CLI 唯一的注入点，
    // 测试里传一个假的进来，不用改全局再记得还原
    envVars: io.env,
  });
  for (const n of auth.notes) io.err(`env 的 auth 段：${n}`);
  // 缺失密钥在**探测之前**就说一遍。等到探测时报"需要鉴权但没有凭证"，
  // 用户看到的是结论而拿不到"该设哪个变量"，而后者才是这条命令的价值
  if (auth.missingSecrets.size) {
    io.err(`以下凭证引用没有解析到值：`);
    for (const ref of auth.missingSecrets) io.err(`  · ${ref} → 设环境变量 ${secretEnvKey(ref)}`);
    io.err('  （真值只从环境变量取。写进 env 文件会被提交，写进命令行会被 ps/CI 日志记走）');
  }

  const identities: Array<{ label: string; identity?: string }> = [{ label: '(默认)' }];
  for (const idt of auth.table.identities()) identities.push({ label: idt, identity: idt });

  const sample = str(a, 'sample') === undefined ? 1 : Number(str(a, 'sample'));
  if (!Number.isInteger(sample) || sample < 1 || sample > 20) {
    throw new CliError(`--sample 要是 1..20 的整数，实际是 "${str(a, 'sample')}"`, EXIT.USAGE,
      '它是**每个身份**探几个只读接口。默认 1 就够了：这条命令验的是凭证有效性，不是接口覆盖率');
  }

  const result = await checkAuth({
    hook: auth.hook, table: auth.table, registry, env, identities,
    sampleLimit: sample,
    send: async (req) => {
      const r = await auth.client.send({
        method: req.method, url: req.url, headers: req.headers,
        timeoutMs: req.timeoutMs, maxBytes: 64 * 1024,
        // 不跟重定向：跟到登录页会拿到一个 200 的 HTML，
        // 于是"凭证有效"的结论是从一个登录表单页推出来的
        followRedirects: false,
      });
      return { status: r.status, body: r.body, error: r.error };
    },
  });

  // 逐行打。列而不是段落：这条命令的输出会被贴进工单和聊天记录，
  // 而"哪个身份的哪个接口是什么结论"要能一眼对上
  for (const r of result.rows) {
    /**
     * 符号。回落的行即使凭证有效也打 **~** 而不是 ✓：
     * 那个符号会被扫读，"✓ 但下面跟一行小字"有一半概率只被看到符号。
     * 但**只在 ok 上降级** —— 一行既是问题又带回落时仍然是 ✗，
     * 把它降成 ~ 等于把一个真问题藏成"未判定"。
     */
    const isProblem = r.outcome === 'rejected' || r.outcome === 'needs-config';
    const mark = isProblem ? '✗' : r.outcome === 'ok' && !r.warning ? '✓' : '~';
    // docRef 占一列：同一个 `GET /orders` 在两份 spec 上用的是不同桶的凭证，
    // 不打出来时两行结论不同而目标相同，读起来像"同一个接口一会儿好一会儿坏"
    io.out(`${mark} ${r.docRef.padEnd(10)} ${r.identity.padEnd(10)} ${r.target.padEnd(26)} ${r.outcome.padEnd(13)} ${r.detail}`);
    // 告警单独一行且用 ⚠：它是"这行绿得有条件"的意思，混进 detail 尾部会被扫过去
    if (r.warning) io.out(`    ⚠ ${r.warning}`);
    if (r.hint) io.out(`    修法：${r.hint}`);
  }
  io.out('');
  io.out(result.summary);
  io.out('说明：~ 是**未判定**（连不上/没得探），不是"没问题"也不是"有问题"。');
  io.err('');
  io.err(CI_HINT);
  return { code: authCheckExit(result), summary: result.summary };
}

// ── 开关取值的统一入口 ─────────────────────────────────────────────────────

export function str(a: ParsedArgs, k: string): string | undefined {
  const v = a.flags[k];
  return typeof v === 'string' ? v : undefined;
}
export function flag(a: ParsedArgs, k: string): boolean {
  return a.flags[k] === true;
}

export { formatErrors, CONFIG_FILE };
