/**
 * 浏览器测试的共用夹具：找浏览器、起静态服务、最小 CDP 客户端。
 *
 * ## 为什么抽出来
 *
 * 本来只有 `browser-modules.test.ts` 一份。第二条（`browser-run-button.test.ts`）
 * 要用的东西和它**一字不差**：浏览器搜索顺序、WebSocket 收发、等调试端口、等求值给值。
 * 同一个包里抄第二份，就是这个仓记过一整族的那个失效 —— 副本会漂，而漂了的症状
 * 是"一边能跑一边跳过"（两份的浏览器搜索顺序差一条时，没人会觉得是夹具的问题）。
 * 抄过去还只是贵；抄错了才是贵。
 *
 * 注意与 `adapter-web/test/browser.ts` 的关系：那边那份浏览器搜索**刻意没被复用**，
 * 因为 `tooling/lint-layers.mjs` 不许 packages/web 依赖 adapter-web，
 * 而**测试目录只豁免"不许用 node 内置模块"这一条，不豁免依赖方向**。
 * 所以本包自己留一份四条的搜索顺序，两处（这里与那边）分叉的后果写在下面 wants 的注释上。
 */
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync, readFile, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/* ═══ 找浏览器。与 adapter-web/test/browser.ts 同一套搜索顺序，四条，不多 ═══ */
export function findBrowser(): string | undefined {
  const fromEnv = process.env.ATEST_BROWSER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const roots = [join(homedir(), 'Library', 'Caches', 'ms-playwright'), '/Applications'];
  const wants = [
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root).sort().reverse(); } catch { continue; }
    for (const n of names) {
      for (const w of wants) for (const p of [join(root, n, 'chrome-mac-x64', w), join(root, w)]) {
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

export const BROWSER = findBrowser();
const REQUIRE = process.env.ATEST_REQUIRE_BROWSER === '1';
if (!BROWSER && REQUIRE) {
  test('ATEST_REQUIRE_BROWSER=1 但找不到浏览器', () => { throw new Error('流水线说必须有浏览器，那就不能跳过'); });
} else if (!BROWSER) {
  process.stderr.write('[web] 没找到 Chrome/Chromium：浏览器侧的测试跳过。设 ATEST_BROWSER_BIN 可跑。\n');
}
/** 找不到浏览器 => 大声跳过；`ATEST_REQUIRE_BROWSER=1` => 变成失败。静默跳过等于"前端在浏览器里坏了也没人知道" */
export const browserTest = BROWSER ? test : test.skip;

/* ═══ 静态服务 ═══ */
const MIME: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' };
export const STATIC_ROOTS: Array<[string, string]> = [
  ['/pkg/ir/', 'packages/ir/dist'],
  ['/pkg/engine/', 'packages/engine/dist'],
  ['/pkg/zod/', 'node_modules/zod'],
  ['/app/', 'packages/web/dist'],
];

export interface SiteOpts {
  /** 首页。给字符串就当 HTML 内联；给 {file} 就发仓库里那份真文档 */
  index: { html: string } | { file: string };
  /**
   * `/api/…` 的桩。返回 true 表示已处理。
   * 之所以是桩而不是真起 `@atest/server`：依赖方向（web 不许 import server），
   * 也因为这一格要测的是**前端**发了什么 —— 真服务端会把"前端有没有带 jobId"
   * 变成"服务端会不会登记 job"，红的含义就分了。
   */
  api?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => boolean;
}

export interface Site { url: string; close(): Promise<void> }

export function serveSite(o: SiteOpts): Promise<Site> {
  const indexHtml = 'html' in o.index ? o.index.html : readFileSync(join(ROOT, o.index.file), 'utf8');
  const server: Server = createServer((req, res) => {
    const raw = req.url ?? '/';
    const url = new URL(raw, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': MIME['.html']! }).end(indexHtml);
      return;
    }
    if (pathname.startsWith('/api/')) {
      if (o.api?.(req, res, url)) return;
      // 没写桩的 api 路由**大声 404**，不静默 403：前端多打了一条路由时，
      // 403 会被读成"安全层拦了"，而真相是夹具不认识它
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`no stub for ${req.method} ${pathname}`);
      return;
    }
    const hit = STATIC_ROOTS.find(([pre]) => pathname.startsWith(pre));
    if (!hit) { res.writeHead(403).end('forbidden'); return; }
    const rel = normalize(pathname.slice(hit[0].length - 1)).split(sep).filter((s) => s !== '..' && s !== '.').join('/');
    if (extname(rel) !== '.js' && extname(rel) !== '.json') { res.writeHead(403).end('ext forbidden'); return; }
    readFile(join(ROOT, hit[1], rel), (e, buf) => {
      if (e) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' }).end(buf);
    });
  });
  /*
   * 开着不回的响应（测"跑动中"时必须这样）会让 `server.close()` 一直不 resolve，
   * 于是夹具的 finally 挂住 => 整条测试超时 => 失败归因变成"超时"而不是"这条判据红了"。
   * 所以自己记下 socket，close 时拆掉。
   */
  const socks = new Set<import('node:net').Socket>();
  server.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    r({
      url: `http://127.0.0.1:${port}/`,
      close: () => new Promise<void>((res2) => { for (const s of socks) s.destroy(); socks.clear(); server.close(() => res2()); }),
    });
  }));
}

/* ═══ 最小 CDP 客户端 ═══
   刻意**只**有 send/close：这个夹具要的是"发一个方法、拿一个返回值"，
   事件流里 send 的应答之外的那一半（Page.loadEventFired 之类）在这里没用 ——
   等页面里的东西就绪靠的是轮询（evalWait / waitFor），本来也没有对应的事件可等。
   事件分发器一旦写出来，下一个用例就会开始依赖它，而它今天没有任何东西在守。 */
export interface Cdp { send<T>(method: string, params?: Record<string, unknown>): Promise<T>; close(): void }

export async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('CDP 连接失败')); });
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
    // 只有带 id 的才是对 send 的应答；事件帧直接丢掉（见上面那段）
    if (msg.id === undefined) return;
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result);
  };
  return {
    send: <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((r, j) => {
        const id = ++seq;
        waiting.set(id, { resolve: r as (v: unknown) => void, reject: j });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

/**
 * 等 Chrome 的调试端口起来，并返回**页面目标**自己的 ws 地址。轮询最多 ~15s。
 *
 * 必须是页面级端点而不是 `/json/version` 那个 browser 级端点：browser 端点上
 * 没有 `Runtime` / `Page` 域，发过去是 `'Runtime.enable' wasn't found`
 * （第一版就是这么炸的）。`--headless=new` 启动时会带一个 about:blank 页面，
 * 直接接上它再 navigate，比 `Target.createTarget` + `Target.attachToTarget`
 * 少一层 sessionId 路由 —— 这个客户端只需要"能驱动那一个页面"。
 */
export async function waitForDevtools(port: number): Promise<string> {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome 调试端口 15s 内没起来（或没给出页面目标）');
}

/** 求值一次，取 returnByValue 的值（不做轮询） */
export async function evalOnce(cdp: Cdp, expression: string): Promise<unknown> {
  const r = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`页面里求值抛了：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n表达式：${expression}`);
  return r.result?.value;
}

/** 轮询到表达式给出**真值**（不是 undefined/null）。等页面渲染完、等某个 DOM 出现，都走这里 */
export async function evalWait(cdp: Cdp, expression: string, timeoutMs = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evalOnce(cdp, expression);
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`等不到表达式给出值：${expression}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * 轮询到表达式给出**假值**（用于"某样东西应该消失了"这一类断言）。
 * 不写这一条的话，"按钮该消失"只能用一次性的 `evalOnce` 赌时序：
 * 赌赢了是绿，赌输了是红，而红的含义是"慢"而不是"错"。
 */
export async function evalWaitGone(cdp: Cdp, expression: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evalOnce(cdp, expression);
    if (!v) return;
    if (Date.now() > deadline) throw new Error(`等不到它消失：${expression}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 起浏览器 + 接 CDP + 开两个域 + 导航。返回的东西交给调用方在 finally 里关掉 */
export async function openPage(site: Site): Promise<{ cdp: Cdp; kill: () => void }> {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const profile = mkdtempSync(join(tmpdir(), 'atest-web-probe-profile-'));
  // **自己的临时 profile**（docs/06 那条：Web adapter 必须用自己的 --user-data-dir，
  // 不复用日常浏览器会话 —— 这里同理，别去碰用户那份 Chrome 配置）
  const port = 9333 + (process.pid % 200);
  const child = spawn(BROWSER!, [
    `--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    const cdp = await connect(await waitForDevtools(port));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: site.url });
    return { cdp, kill: () => { cdp.close(); child.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }); } };
  } catch (e) {
    child.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true });
    throw e;
  }
}
