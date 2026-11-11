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
 * ## 为什么"取消"这一栏在这里是空的
 *
 * 用户侧的取消走的是**进程信号**：Ctrl-C → `installSignalHandlers` 置标志 →
 * 引擎 `checkAbort` → run 目录里那几份产物照写、teardown 照跑、租约照还（signals.ts 整段讲的是这条链）。
 * 一个 `POST /api/run/:id/cancel` **现在不给**，因为那需要 `AbortFlag` 能从外部注入，
 * 而 `installSignalHandlers` 只认信号 —— 造那条路要改 CLI 内部，
 * 而"改了之后中断到底会不会落齐那几份产物"是 docs/15 §3.7 那一轮的事。
 * **宁可这一栏空着并写清楚，也不要给一个装作能取消的端点。**
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { DEFAULT_CONFIG, findConfig, loadScenarioFile, main, type Io } from '@atest/cli';
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
  /** 覆盖 io.out（测试要断言 CLI 打了什么；默认写 stderr，因为 stdout 归 JSON 用） */
  onOutput?: (s: string) => void;
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
async function runCommand(argv: string[], cwd: string, collect: string[]): Promise<number> {
  const io: Io = {
    out: (s) => collect.push(s),
    err: (s) => collect.push(s),
    cwd,
    // 环境**原样透传**。这里有一个必须守住的点：密钥只从 ATEST_SECRET_* 环境变量来，
    // 所以浏览器不需要、也拿不到任何密钥值 —— 它连"有哪些 ref"都不必知道。
    env: process.env as Record<string, string | undefined>,
  };
  return main(argv, io);
}

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
      let body: { scenario?: string; env?: string; inputs?: Record<string, unknown> };
      try {
        body = raw === '' ? {} : JSON.parse(raw) as typeof body;
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      if (!body.scenario) return json(res, 400, { error: '缺少 scenario（场景 id 或 IR 文件路径）' });
      if (!/^[A-Za-z0-9._/@-]+$/.test(body.scenario)) return json(res, 400, { error: 'scenario 含不允许的字符' });
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
      const next = queue.then(() => runCommand(argv, cwd, collected)).catch((e: Error) => {
        collected.push(`内部错误：${e.stack ?? e.message}`);
        return 9;
      });
      queue = next;
      const code = await next;
      // 输出原样回传。这里**不解析摘要去算结论** —— report.html 与 manifest 里有权威的那一份。
      return json(res, code === 0 ? 200 : 201, { exitCode: code, output: collected.join('\n') });
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
