/**
 * `atest` 的入口：命令表 + 分发 + 顶层错误处理。
 *
 * 顶层错误处理是这里唯一需要小心的地方。规则：
 *  - **CliError 打一句人话 + 提示**，不打堆栈。它是"你用法不对"，堆栈对用户无意义，
 *    而且会把内部文件路径喷进 CI 日志（那些日志经常是公开的）。
 *  - **其它异常打完整堆栈**并走 EXIT.RUNTIME。那是我们的 bug，藏起来会让人以为
 *    "工具不稳定"而不是"这个场景触发了一个具体缺陷"，后者才能被修。
 *  - **绝不 process.exit() 在命令执行中途**。命令侧只返回码，由这里统一退出。
 *
 * 本文件不做任何业务判断 —— 判断全在 gate.ts / gen.ts 这类纯模块里，
 * 这样"流水线为什么红"这件事可以被直接调用测试，不需要起子进程。
 */
import { cmdAgent, cmdAuthCheck, cmdEvidence, cmdGen, cmdInit, cmdLint, cmdRun, type CommandResult, type Io } from './commands.js';
import { formatErrors, parseArgv, type CommandSpec } from './args.js';
import { CI_HINT, EXIT } from './exit.js';
import { GENERATED_STRATEGY_IDS, STRATEGIES } from './gen.js';
import { CliError } from './wiring.js';
import { LINT_DOCS } from '@atest/engine';

export const COMMANDS: CommandSpec[] = [
  {
    name: 'run',
    summary: '执行场景，产出 trace.jsonl / junit.xml / evidence.zip',
    usage: 'atest run <场景 id 或 IR 文件路径>[…] [开关]',
    detail: [
      '场景可以写 id（按 atest.json 的 irDir 找）或直接写文件路径。多个场景依次跑，退出码取最坏的一个。',
      '环境是必填的：--env staging 读 env/staging.json，或 --env-var baseUrl=http://… 临时给。',
    ].join('\n'),
    flags: [
      { name: 'env', alias: 'e', value: true, metavar: 'staging', desc: '环境名（读 <envDir>/<名字>.json）或环境文件路径' },
      { name: 'env-var', value: true, repeatable: true, metavar: 'k=v', desc: '覆盖单个环境值，可重复。值按字符串给' },
      { name: 'env-revision', value: true, metavar: '7', desc: '固定环境修订号（记进 run，用于复现）' },
      { name: 'doc', value: true, repeatable: true, metavar: 'name=path', desc: '导入 OpenAPI 文档。IR 里 openapiCall.docRef 要用这个名字' },
      { name: 'input', value: true, repeatable: true, metavar: 'name=value', desc: '场景输入。先按 JSON 解析（qty=3、admin=true、items=[1,2]），解析不了才当字符串' },
      { name: 'ci', desc: 'CI 模式：frozen=false 或缺 provenance 时**拒绝执行**（一个请求都不发）' },
      { name: 'allow-unfrozen', desc: '配合 --ci：允许跑未冻结场景。会显式告警并记进证据包，结果不能当门禁依据' },
      { name: 'strict', desc: '先跑静态闸，有 error 就不执行（退出码 3，与"测试失败"区分开）' },
      { name: 'local', desc: '对本地 mock（由 spec 生成）运行。**只证明用例能跑通**，不证明产品行为' },
      { name: 'clock', value: true, metavar: 'live|deterministic', desc: '时钟。deterministic + --seed 才能得到可复现结果（M7）' },
      { name: 'seed', value: true, metavar: '42', desc: '确定性时钟的种子' },
      { name: 'evidence-dir', value: true, metavar: 'dir', desc: '产物目录。默认取 atest.json 的 evidenceDir' },
      { name: 'run-id', value: true, metavar: 'id', desc: '指定 runId（CI 里用构建号，便于把证据和构建对上）' },
      { name: 'max-cost', value: true, metavar: '0.5', desc: '本次运行的成本上限（美元）。超出即中断并落盘已有证据' },
      { name: 'version-id', value: true, metavar: 'v12', desc: '场景版本号，记进证据包清单' },
      { name: 'print-junit', desc: '把 JUnit XML 也打到 stdout（有些 CI 用 --judge 方式直接吃 stdout）' },
    ],
  },
  {
    name: 'lint',
    // 条数从 LINT_DOCS 现算而不是写死：这个 enum 加一条规则而 help 里的数字没动，
    // 用户按数字去数规则、数不出来就开始怀疑 help，而 help 是**唯一**告诉他有几道的地方。
    summary: `静态闸（${Object.keys(LINT_DOCS).length} 条规则，docs/02 §7）：不执行任何东西`,
    usage: 'atest lint <场景 id 或文件路径>[…] [开关]',
    detail: 'CI 里建议放在 run 之前一步。lint 有 error 的退出码是 3，与"测出失败"（1）不同，便于流水线分开提示。',
    flags: [
      { name: 'doc', value: true, repeatable: true, metavar: 'name=path', desc: '导入 OpenAPI。不给则跳过依赖 spec 的那几条检查' },
      { name: 'max-cost', value: true, metavar: '0.5', desc: '步骤成本预算（喂给 STEP_BUDGET_EXCEEDED）' },
    ],
  },
  {
    name: 'gen',
    summary: '从 OpenAPI 文档生成场景 IR（确定性模板展开，不是 AI）',
    usage: 'atest gen --doc <docRef>=<openapi.json> [开关]',
    detail: [
      '策略见 docs/05 §3。默认只生成 happyPath；--strategies all 展开全部可用策略。',
      '默认**只打印清单不写盘**：生成器默默往仓库写几十个文件，下一句 git add . 就让它们进主干。',
      '同一份 spec 重复生成产出**字节完全相同**的文件（输出里没有时间戳），所以 git diff 干净。',
    ].join('\n'),
    flags: [
      { name: 'doc', value: true, repeatable: true, metavar: 'name=path', desc: 'OpenAPI 文档（JSON 形态）。**必填**' },
      // 规范名用单数 strategy（对齐 docs/05 的"策略标签"说法），复数收作别名。
      // 这里一度改成只认复数，理由是"`--strategy` 会被最近匹配提示过来" ——
      // **那个理由是错的，而且我是被一个写错的测试带着改的**：
      // 实测 strategy→strategies 编辑距离 3，超出提示阈值（阈值 2），
      // 于是最自然的那次拼写**不再被提示、也不再生效**，只剩一句"见 --help"。
      // 别名是显式声明的（--help 只列一次、内部只有一个规范名），
      // 不会造成"同一概念两套写法各写各的"那种漂移。
      { name: 'strategy', alias: 'strategies', value: true, repeatable: true, metavar: 'happyPath|all|…', desc: `可重复。all = 全部可生成策略（${GENERATED_STRATEGY_IDS.length} 种；另 ${STRATEGIES.length - GENERATED_STRATEGY_IDS.length} 种需运行期/人工信息）` },
      { name: 'happy-only', desc: '只生成 happyPath（等价于默认，用于覆盖 --strategies all）' },
      { name: 'only', value: true, repeatable: true, metavar: 'operationId', desc: '只为这些 operation 生成' },
      { name: 'skip', value: true, repeatable: true, metavar: 'operationId', desc: '跳过这些 operation' },
      { name: 'env', alias: 'e', value: true, metavar: 'staging', desc: '写进 IR 的 environmentRef' },
      { name: 'out', value: true, metavar: 'dir', desc: '输出目录。默认取 atest.json 的 irDir' },
      { name: 'id-prefix', value: true, metavar: 'shop', desc: '场景 id 前缀。多份 spec 时用来避免同名（默认自动用 docRef）' },
      { name: 'path-param-var', value: true, metavar: 'orderId', desc: '把 path 参数提升为运行时输入 $orderId，CI 可 --input 覆盖而不改用例' },
      { name: 'write', desc: '真的写盘。不加只预览清单' },
      { name: 'force', desc: '覆盖已存在的生成文件。**会抹掉别人在手写用例上加的断言**，先 diff 再用' },
      { name: 'check', desc: 'CI 用：重新生成并与磁盘上的比对，不一致则退出码 3（spec 改了而用例没重新生成 = 用例集腐烂）' },
    ],
  },
  {
    name: 'agent',
    summary: '自然语言 → 场景 IR（M4/M5）。当前模型组不支持 tool call，不可用',
    usage: 'atest agent "<一句话目标>" [开关]',
    detail: '命令存在且开关已定，但会明确报"不可用"并给出替代路径。不是 command not found。',
    flags: [
      { name: 'max-turns', value: true, metavar: '8', desc: '最多几轮 tool call（1..50）' },
      { name: 'max-cost-usd', value: true, metavar: '0.5', desc: '成本上限' },
      { name: 'dry-run', desc: '只生成 IR 不执行' },
      { name: 'yes', desc: '**不提供**：跳过人工确认在 Agent 模式下不被接受（不可逆动作必须过人）' },
    ],
  },
  {
    name: 'init',
    summary: '在当前目录建 atest.json 与用例/环境目录',
    usage: 'atest init [开关]',
    detail: '没有配置文件也完全能跑（所有路径显式传）。init 的价值是把路径固定下来，让 gen 写的和 run 读的是同一个目录。',
    flags: [
      { name: 'ir-dir', value: true, metavar: 'cases', desc: '用例目录（默认 cases）' },
      { name: 'env-dir', value: true, metavar: 'env', desc: '环境目录（默认 env）' },
      { name: 'env', alias: 'e', value: true, metavar: 'dev', desc: '缺省环境名' },
    ],
  },
  {
    name: 'auth-check',
    summary: '逐个鉴权方案 × 逐个身份验证凭证；不跑用例就知道会不会 401',
    usage: 'atest auth-check --doc <docRef>=<openapi.json> --env <环境> [开关]',
    detail: [
      'docs/05 §2：「生成用例跑出来全是 401」是 API 平台的第一体验杀手，而原因九成在环境配置。',
      '探测**只走 GET/HEAD**：一条诊断命令在 CI 里产生业务副作用（下单/删除）不可接受。',
      '没有只读接口时报"未探测"并说明原因，绝不退而去 POST 一个接口。',
      '',
      '结论分五种，刻意不合并：ok / rejected（配了但后端不认）/ needs-config（压根没配）/ unreachable（不知道）/ not-probed（没探）。',
      '三者的修法毫无重叠，合成一句"鉴权失败"会让人三件事都做一遍。',
      '500 与 404 算 ok：请求进到业务代码了，说明网关放行 —— 报成鉴权问题会让人换一份好凭证然后继续 500。',
    ].join('\n'),
    flags: [
      { name: 'doc', value: true, repeatable: true, metavar: 'name=path', desc: 'OpenAPI 文档。**必填** —— 没 spec 就不知道哪个接口要哪种鉴权' },
      { name: 'env', alias: 'e', value: true, metavar: 'staging', desc: '环境名。凭证是按环境配的，所以必须指定（或 --env-var 临时给）' },
      { name: 'env-var', value: true, repeatable: true, metavar: 'k=v', desc: '覆盖单个环境值，可重复。baseUrl 是必需的' },
      { name: 'sample', value: true, metavar: '1', desc: '每个身份探几个只读接口（1..20，默认 1）。验凭证不需要接口覆盖率' },
    ],
  },
  {
    name: 'evidence',
    summary: '查看已产出的证据包（不用解压）',
    usage: 'atest evidence <show|list> <evidence.zip> [成员名]',
    detail: '成员名可选：manifest.json / junit.xml / trace.jsonl / summary.txt / artifacts/<sha256>',
    flags: [],
  },
];

export async function main(argv: string[], io: Io): Promise<number> {
  const parsed = parseArgv(argv, COMMANDS);

  if (parsed.errors.length) {
    // 参数有错**一律不执行任何东西**。两个码本来是同一个（USAGE），
    // 上面曾经写成 some(...) ? USAGE : USAGE 这种形式 —— 看着像在做区分，实际没有。
    // 保留显式的单值返回，别让下一个读的人以为有条件分支的语义
    io.err(formatErrors(parsed.errors));
    io.err(`开关一览：atest ${parsed.args.command || '<命令>'} --help`);
    return EXIT.USAGE;
  }
  if (!parsed.spec) return printHelp(io, undefined);
  if (parsed.args.help) return printHelp(io, parsed.spec.name);

  try {
    const r: CommandResult = await dispatch(parsed.args, io);
    return r.code;
  } catch (e) {
    if (e instanceof CliError) {
      io.err(e.message);
      if (e.hint) io.err(`提示：${e.hint}`);
      return e.code;
    }
    // 非预期异常：**打全堆栈**。这是我们的 bug，信息量比"出错了"重要得多。
    // 但也把命令名与场景带上 —— 三个月后拿到一份只有堆栈的报障，没人能复现
    io.err(`atest ${parsed.args.command} 内部错误：${(e as Error).message}`);
    if ((e as Error).stack) io.err((e as Error).stack as string);
    io.err('这不是你的用例的问题（用例问题会给出具体规则名与位置）。请把上面这段连同复现命令一起报出来。');
    return EXIT.RUNTIME;
  }
}

async function dispatch(a: Parameters<typeof cmdRun>[0], io: Io): Promise<CommandResult> {
  switch (a.command) {
    case 'run': return cmdRun(a, io);
    case 'lint': return cmdLint(a, io);
    case 'gen': return cmdGen(a, io);
    case 'agent': return cmdAgent(a, io);
    case 'init': return cmdInit(a, io);
    case 'evidence': return cmdEvidence(a, io);
    case 'auth-check': return cmdAuthCheck(a, io);
    default: throw new CliError(`没有这个命令：${a.command}`, EXIT.USAGE, 'atest --help');
  }
}

/** 帮助文本。手写成表而不是表格库：输出要对齐中文（宽度 2），一上库就得处理这个 */
function printHelp(io: Io, only?: string): number {
  if (!only) {
    io.out('atest —— 测试平台的命令行入口（本地与 CI 跑同一个引擎）');
    io.out('');
    io.out('用法：atest <命令> [开关]');
    io.out('');
    for (const c of COMMANDS) io.out(`  ${c.name.padEnd(10)}${c.summary}`);
    io.out('');
    io.out('  每个命令的开关：atest <命令> --help');
    io.out('');
    io.out(CI_HINT);
    return EXIT.OK;
  }
  const c = COMMANDS.find((x) => x.name === only);
  if (!c) return EXIT.USAGE;
  io.out(`atest ${c.name} —— ${c.summary}`);
  io.out('');
  io.out(`用法：${c.usage}`);
  if (c.detail) { io.out(''); for (const line of c.detail.split('\n')) io.out(line); }
  if (c.flags.length) {
    io.out('');
    io.out('开关：');
    for (const f of c.flags) {
      const left = `--${f.name}${f.alias ? `, -${f.alias}` : ''}${f.value ? `=${f.metavar ?? '<值>'}` : ''}`;
      // 中文按宽度 2 算，否则 --help 在有中文的行上必然错位
      io.out(`  ${padDisplay(left, 34)}${f.desc}`);
    }
  }
  io.out('');
  io.out(CI_HINT);
  return EXIT.OK;
}

function padDisplay(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, width - w));
}
