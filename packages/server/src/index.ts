/**
 * 后台的服务端 —— **一层翻译，不是一层逻辑**。
 *
 * ## 这一层存在的唯一理由，与它严禁做的事
 *
 * 前端要"跑一条场景"、要"看一次 run 的产物"、要"看场景列表"。这三件事
 * CLI 全会做（`atest run` / `atest lint` / 磁盘上的 `evidence/<runId>/`）。
 * 所以这里**只做 HTTP 形态 ↔ 命令形态的翻译**：
 *
 * ```
 * POST /api/run   →  main(['run', …], io)      ← 与 CLI 测试同一个入口
 * GET  /api/runs  →  读 evidence/<runId>/manifest.json
 * GET  /api/scenario?id=…  →  读 irDir/<id>.json（原样，不重新校验）
 * ```
 *
 * **严禁在这里写任何判定**：不判冻结、不判门禁、不算通过率、不重组报告结构。
 * 每写一条，就多一份"CLI 与平台各一套真相"的候选 —— 而那正是 docs/01 §8.2
 * 花整节篇幅防的形状（那次是 GUI↔执行器，这次是 HTTP↔CLI）。
 * 判据都在 cli/engine 那一侧，而它们**已经被测试钉过**；这里再算一遍，
 * 算错的那一半没有任何测试会红。
 *
 * ## 一个进程只跑一条 run（串行队列）
 *
 * 不是保守，是被一个具体的东西逼的：`cmdRun` 自己调 `installSignalHandlers`。
 * 两条 run 并发就会**装两遍 SIGINT 处理器**，于是按一次 Ctrl-C 会同时取消两条 ——
 * 而屏幕上那句"已取消"只会出现一次，人以为只砍了一条。
 * Node 默认 `maxListeners=11`，跑到第 12 条还会喷一条 MaxListenersExceededWarning
 * 到 stderr，长得像我们自己的 bug。
 *
 * 顺带第二条理由更硬：**并发两条 run 会互相踩被测环境**（同一个账号、同一份数据），
 * 而那表现为"用例自己漂了"。平台侧的并发执行是 P4 设备租约那一轮的活，
 * 不是这一层能顺手给的能力。
 *
 * ## 取消：这一格给的是**入口**，判据全在 CLI/引擎那一侧
 *
 * `POST /api/cancel?jobId=…` 置一个标志（{@link createAbortFlag}），剩下的路与
 * Ctrl-C **同一条**：标志 → 引擎 `checkAbort` 每步开头读 → `RunAborted('cancelled')`
 * → 退出码 10 + 产物照写 + teardown 照跑 + 租约照还。这一层**不新增任何中断判定**
 * （文件头那条禁令在这里同样成立）：它只把"外面来的一句取消"翻译成 `Io.abortSignal`，
 * 由 `cmdRun` 与信号那个标志做 OR 合成后交给引擎。
 *
 * 曾经这一栏是**刻意空着**的，理由是"取消需要 `AbortFlag` 能从外部注入，而那时只能由信号驱动"。
 * 那个前提本轮被拆掉了（signals.ts 的 `createAbortFlag`），于是那段注释变成了一行
 * 承诺不存在功能的假话 —— 正是 docs/14 §3 那一族（schema/注释里有、执行侧没人做）
 * 在**注释**这一面上的形状：代码改对了，没人回头改那段说"这里做不到"的话。
 *
 * 仍然做不到的是**取消排队中的 job 时把它的排队位次让出来**：串行队列里它仍占着
 * 一格，只是开工前发现被取消就**一个请求都不发**地结束（见下面 JobBoard 那段）。
 * 让位要重排队列结构，而那是并发执行那一轮（P4 设备租约）的活。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  createAbortFlag, DEFAULT_CONFIG, EXIT, findConfig, loadScenarioFile, main,
  type AbortFlag, type AbortSource, type Io,
} from '@atest/cli';
import { EVIDENCE_FILES } from '@atest/engine';
import { readRunMember } from '@atest/store';
import { readIfFile, resolveEvidence, resolveStatic, type StaticRoot } from './files.js';

/** 请求体上限。IR 是文本，几十 KB 顶天；这个数的作用是"失控的请求体不许吃掉内存" */
const MAX_BODY = 512 * 1024;

export interface ServeOptions {
  /** 项目根（找 atest.json 的起点）。默认 process.cwd() */
  cwd?: string;
  /** 端口。0 = 让系统挑（测试要用它，别写死 8787 然后两个测试抢同一格） */
  port?: number;
  /**
   * 静态根。**默认不给**，于是这个服务端一个文件都不发。
   * 由 `bin/serve.mjs` 那种入口按仓库布局显式装配 —— 不在这里猜仓库结构，
   * 因为猜出来的根一旦多算一格（比如整个仓库根），
   * 漏一条扩展名规则就把 `env/*.json` 发出去了。
   */
  staticRoots?: readonly StaticRoot[];
  /*
   * **这里从前有一个 `onOutput?: (s: string) => void`**，注释写着"覆盖 io.out
   * （测试要断言 CLI 打了什么）"。本轮删掉 —— 它**一个引用都没有**
   * （全仓只有这一行声明本身），而它承诺的那件事**已经由另一条路做完了**：
   * `runCommand` 自己建一个 `collect: string[]` 塞进 `io.out`/`io.err`，
   * 随 `/api/run` 的响应以 `output` 字段发回，浏览器画成「CLI 输出」那张卡。
   * 所以这不是"少一个功能"，是**一个看起来像接口的空头承诺**：
   * 下一个人看见 `ServeOptions` 里有这一栏，会以为传个函数就能截获输出，
   * 传了之后**安静地什么都没发生**（`ServeOptions` 是 `.strict()` 之外的普通
   * interface，多余属性编译不报，运行时也没人读）。docs/08 §3 缺陷类 (a)。
   *
   * 判据与载体：`tooling/dead-iface-fields.mjs`（它当时报出的唯一一个零提及字段就是这个），
   * 断言"CLI 输出真的到了响应里"的测试在 `test/cancel-http.test.ts`（读 `.output`）。
   * ⚠ 真要"改 io.out"的话，改 `runCommand` 那个 `collect`，别加回这一栏。
   */
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** 读尽请求体。超限直接拒，不"截断后继续"（截断的 JSON 会以语法错误报给用户，归因错到别处） */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).byteLength;
    if (size > MAX_BODY) return undefined;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const text = (res: ServerResponse, code: number, body: string, contentType = 'text/plain; charset=utf-8'): void => {
  res.writeHead(code, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

/** 静态资源的 MIME。只覆盖白名单里那几个扩展名，其余不发 */
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * 跑一条命令，收全部 stdout/stderr 与退出码。
 *
 * **不 try/catch 掉异常**：`main` 的顶层错误处理已经把 CliError 变成人话 + 退出码，
 * 这里再兜一层会把"我们的 bug"降级成"一个 500"。异常照直冒到请求处理器最外层，
 * 那里统一记一条带栈的日志（而**不**把栈发给浏览器 —— 它会带内部路径）。
 */
async function runCommand(argv: string[], cwd: string, collect: string[], abortSignal?: AbortFlag): Promise<number> {
  const io: Io = {
    out: (s) => collect.push(s),
    err: (s) => collect.push(s),
    cwd,
    // 环境**原样透传**。这里有一个必须守住的点：密钥只从 ATEST_SECRET_* 环境变量来，
    // 所以浏览器不需要、也拿不到任何密钥值 —— 它连"有哪些 ref"都不必知道。
    env: process.env as Record<string, string | undefined>,
    ...(abortSignal ? { abortSignal } : {}),
  };
  return main(argv, io);
}

/* ═══ 正在跑的 job：取消用的那张表 ═══════════════════════════════════════
 *
 * ## 为什么取消走"注入一个标志"，而不是给这个进程发 SIGINT
 *
 * 信号是**进程级**的，而这一格想取消的是"某一个 job"。发 SIGINT 的话：
 *  · 正在清理（teardown / 归还租约）的那条会被第二次同名信号直接打死 ——
 *    `installSignalHandlers` 的第二次按键语义是"放弃清理 + 自我终止"，
 *    那正好是**最不该在常驻服务里发生**的事（进程一死，别人的请求也一起没了）；
 *  · 而且它挡不住**排队中**的那条（见下），那是更重要的一半。
 *
 * ## 排队中的 job 被取消 => 一个请求都不许发
 *
 * 串行队列意味着"提交"与"开始"之间可以隔很久。那时取消如果只是置个标志，
 * 引擎那侧 `checkAbort` 会在**第一步开头**抛，于是场景仍会被装配、
 * 而装配里包含连库、起浏览器这类动作。更坏的是它已经排到了队里、
 * 人以为"取消了就是没跑"。所以 {@link JobBoard.claimStart} 在**开工前**读一次标志：
 * 取消掉的 job 直接出队，`main` 一次都不调。
 * 理由是 docs/02 §5 那条不可逆动作纪律 —— 一次取消绝不该产生第二遍副作用，
 * 而"根本没开始"是唯一干净的答案。
 */
interface Job {
  readonly id: string;
  readonly source: AbortSource;
  /** 排队中 / 正在跑 / 已结束。取消只对前两者有意义，而三者要分得开 */
  state: 'queued' | 'running' | 'done';
}

/**
 * 已结束那条只留最近这么多条，够回答"我刚那个 job 怎么样了"，又不会无界长。
 *
 * **导出的唯一理由是测试要按它循环**（`cancel-http.test.ts` 那条淘汰用例）。
 * 不导出的话测试只能写死 50，而这个数一改测试就悄悄失效 —— 本仓对"会漂的数"
 * 的规矩是现算，不重述。
 */
export const FINISHED_KEEP = 50;

class JobBoard {
  private readonly jobs = new Map<string, Job>();
  private readonly finished: Job[] = [];

  /** 登记。id 撞上一个**还没结束**的 job 时返回 undefined（调用方报 409） */
  add(id: string): Job | undefined {
    const prev = this.jobs.get(id);
    if (prev && prev.state !== 'done') return undefined;
    const job: Job = { id, source: createAbortFlag(), state: 'queued' };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job | undefined { return this.jobs.get(id); }

  /**
   * 表里**当前还留着**的所有 job，含最近结束的那批（{@link FINISHED_KEEP} 条以内）。
   *
   * 刻意不过滤掉 `done`：这一格的读者是"我刚那个 job 怎么样了"，而那个 job
   * 恰恰常常**已经结束**。过滤的话它就从列表里消失，看起来像"没有这个 job"，
   * 与"取消没生效"是同一种读感。每条都带 `state`，要只看活着的由调用方筛。
   */
  all(): readonly Job[] { return [...this.jobs.values()]; }

  /**
   * **占下开工权**：没被取消且还在排队 => 置为 running 并返回 true；否则 false。
   *
   * 名字刻意是动词而不是 `startable(job)` 那种形容词 —— 它**会改 state**。
   * 一个叫"能不能开工"的函数偷偷把状态改成"在跑"，读调用点的人看不出来，
   * 于是"多调一次""顺手删掉一处"这类改动不会引起警觉。
   * 我给这一段写负控时正是被它咬了一口：一个变异同时删掉了"取消闸"与
   * "queued→running"两件事，报出来的失败指向 `/api/jobs`，看着像测试写错了，
   * 其实是我把两个行为绑在了一次调用里（docs/08 §3 说的"变异删得比被测行为多"）。
   *
   * 顺带把状态机写死在这里：只允许 `queued → running`。`done` 也返回 false，
   * 于是"一个已结束的 job 被再次开工"（等于把同一个场景**跑第二遍**，
   * docs/02 §5 的不可逆动作纪律）在这张表的层面就不成立，而不靠调用点自觉。
   */
  claimStart(job: Job): boolean {
    if (job.state !== 'queued' || job.source.flag.aborted) return false;
    job.state = 'running';
    return true;
  }

  /**
   * 收尾。**调用方在 finally 里调一次**，所以这里不需要幂等守卫 ——
   * 写一个"防重复调用"的判断，等于承认有两个调用点，而那时该修的是调用点。
   * 表里那条**已结束**的 job 留在 map 里一小会儿（够回答"我刚那个 job 怎么样了"），
   * 超过 {@link FINISHED_KEEP} 条才淘汰；还活着的永不被淘汰。
   *
   * 淘汰按**对象身份**而不是按 id。第一版记的是 id 队列，而 `add` 允许 id 复用
   * （CI 拿构建号当 jobId 是正常用法），于是同一个 id 会被 push 两次：
   * 淘汰第一条时 `jobs.get(id)` 拿到的是**后来那一条**，于是被删掉的是新 job，
   * 留下的是老的僵尸 —— 症状恰好是"我刚提交的那条取消不掉（404）"，
   * 而它离"取消"这个功能越近，越难被怀疑是淘汰逻辑干的。
   * `finished` 因此存 Job 本身，删之前比对同一性。
   */
  finish(job: Job): void {
    job.state = 'done';
    this.finished.push(job);
    while (this.finished.length > FINISHED_KEEP) {
      const old = this.finished.shift()!;
      // 只在表里那条**就是它**时删。不是的话说明这个 id 已经被后来的 job 接走，
      // 那条老的已经不在表里了，什么都不该做
      if (this.jobs.get(old.id) === old) this.jobs.delete(old.id);
    }
  }
}

/**
 * job id 的形状。刻意收紧：它会进日志、进 `/api/jobs` 的响应、进取消的 query。
 *
 * **它不进文件名** —— 证据目录名来自引擎算的 runId，与 jobId 无关
 * （这一点在 `cancel-http.test.ts` 里有一条断言钉着）。把这句话写死在这里，
 * 是因为我先前那句注释写的是"也可能进文件名"，那是**假的**，而假在这格的危害是：
 * 读的人会把 `JOB_ID` 当成 `/evidence/` 那道路径闸，于是哪天有人"顺手放宽一点"
 * 就以为后面还有兜底。它买的是两件别的事：日志与响应里不出现控制字符/换行，
 * 以及取消那一侧用的是**同一张**正则（两侧不一致会让坏 id 登记进表却永远取消不掉）。
 */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 列出证据目录。**读 manifest.json，不重算任何东西**。
 *
 * 单个 manifest 坏了怎么办：**如实标出来**（`broken: true` + 那一句错），
 * 而不是跳过那一格。跳过的表现是"这次 run 不存在"，
 * 而真相是"存在、但我读不出"—— 后者才是要不要找人来看的信号。
 * 这也和 store 那边 `missing` 的处置同一条口径（声明了但取不到，必须说出来）。
 *
 * ## 走 readRunMember，不走裸 readFile
 *
 * 因为磁盘上**不一定有散装那一份**：本轮之前写侧只把 trace/junit/report/zip
 * 放进 run 目录，manifest.json 只在 evidence.zip 里 —— 于是这一格
 * `readFile` 恒失败、`continue` 恒命中，**运行记录列表对每一次历史 run 都是空的**，
 * 而它自己的单测全绿（测的是"坏 manifest 要标 broken"，
 * 没有一条测"一次真跑完之后这里能列出东西"）。
 * 现在散装那份由 `writeEvidenceMembers` 补上了，但**已经躺在盘上的老证据包**
 * 仍然只有包里那份 —— 那些 run 该照样出现在列表里，而不是"看起来没跑过"。
 *
 * ## 读不出时仍然跳过，而且这是对的
 *
 * 上面那句"不许跳过"要与这句一起读。跳过只发生在**压根读不到 manifest** 时，
 * 而那个时候它**确实不是一次 run** —— 证据目录里躺着 `<evidenceDir>/artifacts/`
 * （内容寻址存储，见 cli 的 assemble），它没有 manifest，
 * 把它列成一条 run 会凭空多一条空记录。
 * 判据因此是"能不能读到 manifest"：**读不到 = 不是 run；读到但解不开 = 坏 run（标 broken）**。
 */
async function listRuns(evidenceDir: string): Promise<unknown[]> {
  let names: string[] = [];
  try { names = await readdir(evidenceDir); } catch { return []; }
  const out: unknown[] = [];
  for (const name of names.sort()) {
    const buf = await readRunMember(join(evidenceDir, name), EVIDENCE_FILES.manifest);
    if (!buf) continue;
    try {
      const m = JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>;
      out.push({ dir: name, manifest: m });
    } catch (e) {
      out.push({ dir: name, broken: true, error: (e as Error).message });
    }
  }
  return out;
}

export async function startServer(o: ServeOptions = {}): Promise<RunningServer> {
  const cwd = resolve(o.cwd ?? process.cwd());
  const roots = o.staticRoots ?? [];
  /**
   * 串行队列。每条 run 排到上一条结束为止 —— 理由见文件头"一个进程只跑一条 run"。
   * 用 promise 链而不是队列结构：并发请求一多，自己写队列会多出一堆要测的状态。
   */
  let queue: Promise<unknown> = Promise.resolve();
  /** 正在跑/排队中的 job。取消按这里的 id 找落点（见 JobBoard 那段） */
  const jobs = new JobBoard();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const cfg = await findConfig(cwd);
    const evidenceDir = cfg?.evidenceDir ?? join(cwd, DEFAULT_CONFIG.evidenceDir);

    // ── 场景列表 / 单份 IR ────────────────────────────────────────────────
    if (p === '/api/scenarios' && req.method === 'GET') {
      const irDir = cfg?.irDir ?? join(cwd, DEFAULT_CONFIG.irDir);
      let names: string[] = [];
      try { names = await readdir(irDir); } catch { names = []; }
      const items: unknown[] = [];
      for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
        try {
          const { scenario } = await loadScenarioFile(join(irDir, name));
          items.push({ file: name, id: scenario.id, name: scenario.name, frozen: scenario.frozen, targets: scenario.targets, steps: scenario.body.length });
        } catch (e) {
          items.push({ file: name, broken: true, error: (e as Error).message });
        }
      }
      return json(res, 200, { items });
    }
    if (p === '/api/scenario' && req.method === 'GET') {
      const idOrPath = url.searchParams.get('id') ?? '';
      if (!idOrPath) return json(res, 400, { error: '缺少 id' });
      const irDir = cfg?.irDir ?? join(cwd, DEFAULT_CONFIG.irDir);
      // 只接受 `<id>.json` 这一种形态：路径由这里拼，不接受调用方给的相对/绝对路径。
      // 否则这一格就变成"读仓库里任意 JSON"的口子（env/*.json 也是 JSON）。
      const file = `${idOrPath.replace(/[^A-Za-z0-9._-]/g, '')}.json`;
      const buf = await readIfFile(join(irDir, file));
      // 报错里**不带绝对路径**。带上的话浏览器（以及任何看到这条响应的人）
      // 就知道这台机器的目录结构，而这一格本来能读的是"场景目录里有什么"
      const hint = `找不到场景 ${idOrPath}（场景目录下没有 ${file}）`;
      if (!buf) return json(res, 404, { error: hint });
      return text(res, 200, buf.toString('utf8'), 'application/json; charset=utf-8');
    }

    // ── 跑一条场景 ────────────────────────────────────────────────────────
    if (p === '/api/run' && req.method === 'POST') {
      const raw = await readBody(req);
      if (raw === undefined) return json(res, 413, { error: `请求体超过 ${MAX_BODY} 字节` });
      let body: { scenario?: string; env?: string; inputs?: Record<string, unknown>; jobId?: string };
      try {
        body = raw === '' ? {} : JSON.parse(raw) as typeof body;
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      if (!body.scenario) return json(res, 400, { error: '缺少 scenario（场景 id 或 IR 文件路径）' });
      if (!/^[A-Za-z0-9._/@-]+$/.test(body.scenario)) return json(res, 400, { error: 'scenario 含不允许的字符' });
      /*
       * jobId **由调用方给**，这不是省事，是被这条 API 的形状逼的：`POST /api/run`
       * 要等 run 跑完才回，服务端自己造的 id **在 run 结束前没有任何途径送到调用方手里**。
       * 而取消恰恰是"run 还没结束时"才需要的动作。
       * （要让它变成服务端造 id + 立刻回 202、结果另取，那是把这条改成异步任务队列，
       *  连带前端的"运行中…"状态、输出回传、以及 evidenceDir 的归属都要重排 —— 不是
       *  这一格能顺手给的能力，且改了要写进 docs/15，不能在这里偷偷换契约。）
       *
       * 不给 jobId 就**照常跑，但不可取消**。响应里那个 `cancellable` 是这件事的载体：
       * 少了它，"我发了 jobId 吗/我拼错了吗"在前端看起来与"取消没生效"一模一样。
       */
      const jobId = body.jobId;
      if (jobId !== undefined && !JOB_ID.test(jobId)) {
        return json(res, 400, { error: 'jobId 只允许字母数字与 . _ -，且不能以分隔符开头' });
      }
      let job: Job | undefined;
      if (jobId !== undefined) {
        job = jobs.add(jobId);
        // 撞上**还没结束**的 job：不能静默覆盖。覆盖了会让先那个人按同一个 id
        // 取消掉后一个人的 run —— 取消错了对象比不能取消坏得多。
        if (!job) return json(res, 409, { error: `jobId ${jobId} 正在被另一个 run 占用` });
      }
      const argv = ['run', body.scenario, ...(body.env ? ['--env', body.env] : [])];
      for (const [k, v] of Object.entries(body.inputs ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(k)) return json(res, 400, { error: `input 名不合法：${k}` });
        argv.push('--input', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
      const collected: string[] = [];
      /*
       * 排队。**接龙的 promise 必须在 await 之前就地换掉**，不能等这条跑完再换：
       * 若在 await 之后赋值，两个几乎同时到达的请求会都 `.then` 到**同一个旧尾巴**上，
       * 于是它们并发开跑 —— 而这一格存在的理由正是"不许并发"（两条 run 会互相踩
       * 被测环境，还会把 SIGINT 处理器装两遍）。写成 `queue = next` 之后，
       * 第 n 条排的是第 n-1 条的尾巴，串行性由赋值顺序本身保证。
       */
      const next = queue.then(() => {
        // **开工前**再读一次取消位：排队期间被取消的 job 一个请求都不该发。
        // 只靠引擎里那个 `checkAbort` 的话，装配（连库、起浏览器）照做、
        // 场景照进队列的"已开始"状态，而人以为"取消了就是没跑"。
        if (job && !jobs.claimStart(job)) {
          collected.push('该 job 在开工前已被取消：一个请求都没发。');
          return EXIT.ABORTED;
        }
        return runCommand(argv, cwd, collected, job?.source.flag);
      }).catch((e: Error) => {
        collected.push(`内部错误：${e.stack ?? e.message}`);
        return 9;
      }).finally(() => { if (job) jobs.finish(job); });
      queue = next;
      const code = await next;
      // 输出原样回传。这里**不解析摘要去算结论** —— report.html 与 manifest 里有权威的那一份。
      /*
       * 回的是 `cancelRequested`（"有没有人对这条 job 点过取消"），**不是** `cancelled`。
       * 我先前写的是 `cancelled: flag.aborted`，那个词在这里是假的，两种假法都出得来：
       *  · 取消来在最后一步之后 => 标志为真、run 其实**跑完了**，于是"被取消了"；
       *  · run 被**超时/成本熔断**砍断而没人点取消 => 用同一个词得报 false，
       *    而人看退出码 10 会以为矛盾。
       * 这一格只知道"有没有人点过"。**结论在 manifest.aborted.kind 里**（那里才分
       * cancelled / timeout / cost），这一层不去重算 —— 文件头那条禁令在这里同样成立。
       */
      return json(res, code === 0 ? 200 : 201, {
        exitCode: code, output: collected.join('\n'),
        ...(jobId !== undefined ? { jobId, cancelRequested: job!.source.flag.aborted } : { cancellable: false }),
      });
    }

    /*
     * ── 取消一条正在跑（或还在排队）的 run ────────────────────────────────
     *
     * 为什么不是 `POST /api/run/:id/cancel`：这里的路径段是**调用方给的字符串**，
     * 而这一格的存在理由之一就是不接受调用方给的路径片段（见 `/evidence/` 那一格
     * 与 `/api/scenario` 各自的注释）。取消要的是同一格判据 —— 走 query 参数并
     * 按 JOB_ID 收紧，与 `jobId` 的入口同一处、同一张表。
     *
     * 语义是**请求取消**，不是"已取消"：置位之后，正在跑的那条会在**下一步开头**
     * 停下（引擎 `checkAbort` 每步读一次），已经发出去的请求不会被追回 ——
     * 追回就等于"半个 POST"，而那正是不可逆动作纪律不要的东西。
     * 所以这里回的是"收到了"，最终结论在 run 自己的响应与证据包里（`aborted.kind`）。
     */
    if (p === '/api/cancel' && req.method === 'POST') {
      const jobId = url.searchParams.get('jobId') ?? '';
      if (!JOB_ID.test(jobId)) return json(res, 400, { error: 'jobId 缺失或形状不合法' });
      const job = jobs.get(jobId);
      if (!job) return json(res, 404, { error: `没有登记过 jobId ${jobId}（从未提交，或结束后被后续 job 挤出了表）` });
      /*
       * 已经结束的 job 也回 200，不回 409："取消一个刚跑完的 run"在人手点按钮的
       * 节奏里是**常态**（按钮慢了一拍），把它报成错误会让人以为自己的取消失败了，
       * 转而去按第二下。
       *
       * 回的两个事实刻意**不合成一个 `accepted`**。我先前写的是
       * `accepted: first`（first = 这是第一次取消），于是"取消一条刚跑完的 run"
       * 会拿到 `accepted: true` —— 字面意思是"你的取消被受理了"，而真相是"没东西可取消"。
       * 一个字段同时想表达"第一次收到"和"真的砍到了东西"，两个读者各读一半，
       * 而这两半在**这一格**（state=done）恰好相反，所以拆成两格各说一件事：
       *  · `wasRunning` —— 有没有一个 run 因为这一下而停下；
       *  · `alreadyCancelled` —— 之前是否已经取消过（重复点按钮要看得见，
       *    否则第二下与"取消没生效"长得一模一样）。
       * 位的读取在 `cancel()` **之前**：置位之后再读就恒为 true，那个字段就废了。
       */
      const alreadyCancelled = job.source.flag.aborted;
      job.source.cancel();
      /*
       * `actedOn`（而不是 `wasRunning`）：这个名字说的是"这一下砍到了东西吗"，
       * 而 `wasRunning` 说的是"当时有东西在跑吗" —— 排队中的 job 后者为假，
       * 但它的取消**确实有作用**（它因此压根不会开工），报成 false 会让人以为
       * "排队的那条取消不掉"，转而去按第二下 / 去 kill 进程。
       * 所以判据是"取消有没有对象"= 它还没结束，而不是"它是不是正在跑"。
       */
      return json(res, 200, { jobId, state: job.state, actedOn: job.state !== 'done', alreadyCancelled });
    }

    /** 排队/在跑的那几条。给前端显示"有几条在跑"，也让"取消错了 id"看得见 */
    if (p === '/api/jobs' && req.method === 'GET') {
      return json(res, 200, {
        items: [...jobs.all()].map((j) => ({ jobId: j.id, state: j.state, cancelled: j.source.flag.aborted })),
      });
    }

    // ── run 列表与产物（回**相对**路径：绝对路径会把这台机器的目录结构发进浏览器） ──
    if (p === '/api/runs' && req.method === 'GET') return json(res, 200, { items: await listRuns(evidenceDir) });
    if (p === '/api/project' && req.method === 'GET') {
      const rel = (abs: string): string => {
        const r = abs.startsWith(cwd) ? abs.slice(cwd.length).replace(/^[\\/]/, '') : abs;
        return r === '' ? '.' : r;
      };
      return json(res, 200, {
        hasConfig: cfg !== undefined,
        irDir: rel(cfg?.irDir ?? join(cwd, DEFAULT_CONFIG.irDir)),
        envDir: rel(cfg?.envDir ?? join(cwd, DEFAULT_CONFIG.envDir)),
        evidenceDir: rel(evidenceDir),
        ...(cfg?.defaultEnv ? { defaultEnv: cfg.defaultEnv } : {}),
      });
    }

    const ev = /^\/evidence\/([^/]+)\/(.+)$/.exec(p);
    if (ev && req.method === 'GET') {
      const runId = decodeURIComponent(ev[1]!);
      const member = decodeURIComponent(ev[2]!);
      // 白名单这一关照旧由 resolveEvidence 把（它同时管 runId 的保留段与成员名，
      // 判据与 report.html 那一侧同族）。**过了白名单不等于磁盘上就有**：
      // `artifacts/<sha>` 只在 evidence.zip 里（写侧刻意不散装再写一份，
      // 理由在 store 的 writeEvidenceMembers），所以真正回答这个请求的是
      // readRunMember —— 它先看散装那份，没有再进包里。
      // 这一格改前只读磁盘文件，于是**报告里每一个证据链接都是 404**，
      // 而 resolveEvidence 的单测全绿（它测的是"这个名字允许被读"，不是"读得到"）。
      const abs = resolveEvidence(evidenceDir, runId, member);
      if (!abs) return text(res, 404, 'not found');
      const buf = await readRunMember(join(evidenceDir, runId), member);
      if (!buf) return text(res, 404, 'not found');
      const ext = abs.slice(abs.lastIndexOf('.'));
      return res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': buf.byteLength,
        // 证据含真实响应体。禁 sniff 与缓存到别的源，且不给任何跨源读取的口子。
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      }).end(buf) as unknown as void;
    }

    // ── 静态资源（含浏览器要 import 的 ir/engine/zod） ──────────────────
    if (req.method === 'GET' || req.method === 'HEAD') {
      const hit = resolveStatic(p, roots);
      if (hit) {
        const buf = await readIfFile(hit.absolute);
        if (buf) {
          const ext = hit.absolute.slice(hit.absolute.lastIndexOf('.')).toLowerCase();
          return res.writeHead(200, {
            'content-type': MIME[ext] ?? 'application/octet-stream',
            'content-length': buf.byteLength,
            'x-content-type-options': 'nosniff',
            // 这些是本地磁盘上的真代码（引擎本体）。缓存只在本进程存活期内有意义，
            // 而"改了没生效"会变成一种查不出来的假结果，所以一律 no-store。
            'cache-control': 'no-store',
          }).end(req.method === 'HEAD' ? undefined : buf) as unknown as void;
        }
      }
    }

    return text(res, 404, `not found: ${p}`);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      // 栈只进服务端日志。发给浏览器的那一句不带路径 —— 内部路径本身就是信息。
      console.error('[server] 请求处理异常：', e.stack ?? e.message);
      if (!res.headersSent) json(res, 500, { error: '服务端内部错误，详见服务端日志' });
    });
  });

  await new Promise<void>((r) => server.listen(o.port ?? 8787, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((r, rej) => server.close((e) => (e ? rej(e) : r()))),
  };
}

/**
 * 供入口脚本装配静态根：把仓库里**该给浏览器的那几棵子树**列出来。
 *
 * ## 第一版少了一格，而且少的正是"入口"那一格
 *
 * 只有 `/app/` 与三棵 `/pkg/*` 的话，`index.html` **一个 URL 都到不了**：
 * 它在 `packages/web/static/`，而 `/app/` 指的是 `packages/web/dist/`。
 * 表现是打开页面 404 —— 也就是"这套前端根本没法启动"，
 * 而所有单元测试都是绿的（它们测的是解析函数，不是"这套根装配起来够不够用"）。
 * 所以 `/` 这一格是必需的，而它的扩展名集合**只有 .html**：
 * 挂在仓库根附近的前缀最容易出事，把集合收到只剩一个扩展名，
 * 漏一条规则的后果就从"发出 env/*.json"变成"发出一个 html"。
 *
 * 顺序也不靠手写：`resolveStatic` 自己按前缀长度降序排，
 * 所以这里写 `/` 在最前面不影响 `/app/` 优先命中。
 */
export function defaultStaticRoots(repoRoot: string, webDist: string): StaticRoot[] {
  const code = new Set(['.js', '.mjs', '.json', '.css', '.html', '.map', '.svg']);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(repoRoot, p));
  return [
    // 入口文档单独一棵根，且**只发 .html**。见上面那段。
    { urlPrefix: '/', dir: abs('packages/web/static'), extensions: new Set(['.html']), why: '前端入口文档（只有 index.html）' },
    { urlPrefix: '/app/', dir: webDist, extensions: code, why: '前端自己的模块' },
    { urlPrefix: '/pkg/ir/', dir: abs('packages/ir/dist'), extensions: new Set(['.js']), why: 'IR 本体（浏览器直接跑，docs/01 §8.2）' },
    { urlPrefix: '/pkg/engine/', dir: abs('packages/engine/dist'), extensions: new Set(['.js']), why: '引擎本体（同上）' },
    { urlPrefix: '/pkg/zod/', dir: abs('node_modules/zod'), extensions: new Set(['.js']), why: 'IR 的运行时依赖' },
  ];
}
