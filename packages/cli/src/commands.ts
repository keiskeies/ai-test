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
  EVIDENCE_FILES, lintScenario, runScenario, toJUnitXml, toReport, toTraceJsonl, summaryText,
  type AdapterRegistry, type RunReport,
} from '@atest/engine';
import { defineScenario, type Scenario, type ScenarioDraft } from '@atest/ir';
import { buildEvidencePackage, readEvidenceMember, readZipEntries, writeEvidencePackage } from '@atest/store';

import { formatErrors, type ParsedArgs } from './args.js';
import { CI_HINT, EXIT } from './exit.js';
import { gateAfterRun, gateBeforeRun, isTriage } from './gate.js';
import { generateScenarios, renderScenarioJson, strategyOf, STRATEGIES, GENERATED_STRATEGY_IDS } from './gen.js';
import { findConfig, resolveEnvFile, resolveScenarioPath, writeConfig, DEFAULT_CONFIG, CONFIG_FILE, type ProjectConfig } from './paths.js';
import {
  assemble, buildAuthLayer, CliError, DocRegistry, loadScenarioFile, makeClock, startLocalMock, buildEnv, secretEnvKey,
} from './wiring.js';
import { authCheckExit, checkAuth } from './authcheck.js';

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
}): AdapterRegistry['callScenario'] {
  const cache = new Map<string, Promise<Scenario | undefined>>();
  return (ref: string) => {
    const hit = cache.get(ref);
    if (hit) return hit;
    const id = ref.split('@')[0]!;
    /*
     * **`@version` 今天被忽略**，只按 id 找文件 —— `sub.login@2` 与 `sub.login@1`
     * 落到同一个文件。这是**已知缺口**而不是设计：平台还没有版本表（证据包里的
     * `versionId` 同样还是 `undefined`，见 docs/14 §5），本地文件系统里
     * "一个 id 一个文件"就是当前唯一的版本形态。
     *
     * 之所以**不**在这里报错或忽略整个 ref：作者写 `@2` 说明他心里有"版本"这个概念，
     * 今天静默忽略它比告诉他"版本还不参与解析"坏得多 —— 他会以为 CI 跑的是第 2 版。
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
      for (const a of attempts) {
        try {
          const path = await resolveScenarioPath(a.cfg, id, a.cwd);
          return (await loadScenarioFile(path)).scenario;
        } catch { /* 换下一个。找不到最终由引擎报"解析不到 + ref"，那里知道是哪一步 */ }
      }
      return undefined;
    })();
    cache.set(ref, p);
    return p;
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

  const results: CommandResult[] = [];
  // 显式类型：EXIT.OK 是字面量 0，不标注的话 worst 被推成 0，后面赋别的码就报
  // "number 不能赋给 0" —— 那个报错会让人以为 worseExit 写错了，其实是推断问题
  let worst: number = EXIT.OK;
  for (const f of files) {
    const one = await runOne({ file: f, a, io, ci, cfg, clock, env, registry, evidenceDir });
    results.push(one);
    // 取"更坏"的那个码。顺序按语义严重程度而不是数值大小：
    // USAGE/INVALID 比 TEST_FAILED 更要紧（先修配置再谈测试结果），
    // 但数值上 1 < 3，直接 Math.max 会让 IR 不合法被一次测试失败盖掉
    worst = worseExit(worst, one.code);
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
}): Promise<CommandResult> {
  const { io, a, ci } = o;
  const path = await resolveScenarioPath(o.cfg, o.file, io.cwd);
  const { scenario } = await loadScenarioFile(path);

  if (flag(a, 'strict')) {
    const rep = toReport(lintScenario(scenario));
    if (!rep.ok) {
      io.err(`--strict：lint 有 ${rep.errors.length} 个错误，拒绝执行：`);
      for (const e of rep.errors.slice(0, 10)) io.err(`  [${e.code}] ${e.stepId ?? ''} ${e.message}`);
      return { code: EXIT.INVALID, summary: `${scenario.id}: lint 拒绝` };
    }
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
  const assembled = await assemble({
    scenario, env: o.env, registry: o.registry,
    // 子场景解析器。`path` 可能在项目外（--scenario /tmp/x.json），
    // 所以把入口文件所在目录也交给它当搜索根
    callScenario: makeCallResolver({ cfg: o.cfg, cwd: io.cwd, scenarioDir: dirname(path) }),
    evidenceDir: join(o.evidenceDir, 'artifacts'),
    clock: o.clock,
    envRevision: str(a, 'env-revision') ? Number(a.flags['env-revision']) : undefined,
    inputs,
    runId: str(a, 'run-id'),
    maxCostUsd: str(a, 'max-cost') ? Number(a.flags['max-cost']) : undefined,
  });
  for (const w of assembled.warnings) io.err(w);

  let report: RunReport;
  try {
    report = await runScenario(assembled.runOptions);
  } finally {
    await mock?.close();
  }

  // 产物先组装（下面既要用 manifest 打摘要，也要写包）。
  // 顺序上"先组包再打摘要"而不是反过来：摘要与包里的 summary.txt 必须是同一份文字，
  // 各算一遍迟早不一致，而人只会拿其中一份去追问"到底哪个数对"
  const pkg = await buildEvidencePackage({
    scenario, report, store: assembled.store,
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
  const written = await writeEvidencePackage(outDir, report.runId, report.status, pkg.bytes);
  io.out('');
  io.out(`产物：\n  ${join(outDir, EVIDENCE_FILES.junit)}\n  ${join(outDir, EVIDENCE_FILES.trace)}\n  ${written.path}`);
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

function safeRunId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'run';
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

export async function cmdLint(a: ParsedArgs, io: Io): Promise<CommandResult> {
  if (!a.positionals.length) throw new CliError('lint 需要目标：atest lint <场景 id 或文件路径>[…]', EXIT.USAGE);
  const cfg = await findConfig(io.cwd);
  const registry = await DocRegistry.load(a.multi.doc ?? []);
  const ctx: Parameters<typeof lintScenario>[1] = {};
  if (str(a, 'max-cost')) ctx.maxCostUsd = Number(a.flags['max-cost']);

  let bad = false;
  for (const f of a.positionals) {
    const path = await resolveScenarioPath(cfg, f, io.cwd);
    const { scenario } = await loadScenarioFile(path);
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

export async function cmdEvidence(a: ParsedArgs, io: Io): Promise<CommandResult> {
  const sub = a.positionals[0];
  const file = a.positionals[1];
  if (!sub || !file) {
    throw new CliError('用法：atest evidence show <evidence.zip> [成员名] | atest evidence list <evidence.zip>', EXIT.USAGE,
      `成员名可选：${EVIDENCE_FILES.manifest} / ${EVIDENCE_FILES.junit} / ${EVIDENCE_FILES.trace} / ${EVIDENCE_FILES.summary} / artifacts/<sha256>`);
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
