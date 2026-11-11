/**
 * **这条测试是整个前端架构的载体**：浏览器里 import 真的 `@atest/ir` + `@atest/engine`，
 * 并让 `lintScenario` 在浏览器里真的报出一条 issue。
 *
 * ## 为什么值得为它写一个 CDP 客户端
 *
 * docs/01 §8.2 那句"引擎必须能在浏览器里跑只读校验，否则 GUI 就得维护第二套校验逻辑"
 * 是前端整个技术方向的支点。而它在**装打包器之前**只是一个论断：
 * `lint-layers` 拦住了 node 内置依赖（必要条件），但裸名解析（`'zod'`、`'@atest/ir'`）
 * 靠不靠 import map 通、dist 那份 NodeNext 产物在浏览器里是不是合法 ESM、
 * zod 有没有把某个 node 依赖带进来 —— 这三件事任何一件崩了，方向整体作废。
 *
 * 而这类"看起来满足了约束"的断言，本仓的账是：**没跑过的约束等于没有约束**
 * （docs/08 §3 那一族的反面写法）。所以这里不是"跑通了写个注释"，
 * 而是把它做成一条会红的测试：哪天有人给 ir/engine 加了一个 node 依赖、
 * 或者换了模块格式、或者把 import map 改错，这条测试红。
 *
 * ## 为什么在这里手写 CDP，而不用 @atest/adapter-web
 *
 * `tooling/lint-layers.mjs` 给 packages/web 定的规则是"只许依赖 ir + engine"，
 * 而**测试目录只豁免 node 内置模块那一条，不豁免依赖方向**（那条例外的注释就写在那儿）。
 * 所以这里 import 不了 adapter-web。这不是不便，是这条测试**更该在 web 这一侧**的理由：
 * 它验的是"web 这一侧的东西能不能在浏览器里跑"，夹具依赖一个上层包的话，
 * 上层包坏了会让这条测试红，而红的含义会被误读成"浏览器加载不了了"。
 *
 * 用到的 CDP 面就三个方法（`Page.enable` / `Page.navigate` / `Runtime.evaluate`，
 * 外加一个 `Runtime.enable` 让求值有上下文），加上 WebSocket 收发，
 * 比引入一层抽象更贵一点、比"没有这条测试"便宜很多。
 *
 * ## 跳过策略与 adapter-web 一致
 *
 * 找不到浏览器 => 大声跳过；`ATEST_REQUIRE_BROWSER=1` => 变成失败。
 * 静默跳过等于"前端在浏览器里坏了也没人知道"，而硬失败会让没装 Chrome 的机器
 * 上整个 `npm test` 不可用（docs/08 §3 那条"error 意味着没测成"的同一条口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFile, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/* ═══ 找浏览器。与 adapter-web/test/browser.ts 同一套搜索顺序 ═══
   （刻意**复制**而不是 import：那边在 adapter-web 包里，本包的依赖规则不许碰它。
     两处的搜索顺序如果哪天分叉，症状是"一边能跑一边跳过" —— 所以顺序只有四条、
     而且都在下面的 wants 里，抄错的面积比抄一段带缓存逻辑的代码小。） */
function findBrowser(): string | undefined {
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

const BROWSER = findBrowser();
const REQUIRE = process.env.ATEST_REQUIRE_BROWSER === '1';
if (!BROWSER && REQUIRE) {
  test('ATEST_REQUIRE_BROWSER=1 但找不到浏览器', () => { throw new Error('流水线说必须有浏览器，那就不能跳过'); });
} else if (!BROWSER) {
  process.stderr.write('[web] 没找到 Chrome/Chromium：浏览器加载 ir/engine 的那条测试跳过。设 ATEST_BROWSER_BIN 可跑。\n');
}
const browserTest = BROWSER ? test : test.skip;

/* ═══ 静态服务：只发这四棵子树，只发 .js/.json/.html ═══ */
const MIME: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const ROOTS: Array<[string, string]> = [
  ['/pkg/ir/', 'packages/ir/dist'],
  ['/pkg/engine/', 'packages/engine/dist'],
  ['/pkg/zod/', 'node_modules/zod'],
  ['/app/', 'packages/web/dist'],
];

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (pathname === '/') {
      const html = `<!doctype html><meta charset="utf-8"><script type="importmap">
{"imports":{"zod":"/pkg/zod/index.js","@atest/ir":"/pkg/ir/index.js","@atest/engine":"/pkg/engine/index.js","@atest/web/":"/app/"}}
</script><script type="module">
// 判据用引擎自己的回答，不用"import 没抛"：后者连"模块加载了但没行为"都分不清
try {
  const ir = await import('@atest/ir');
  const eng = await import('@atest/engine');
  const app = await import('@atest/web/check.js');
  // 一份自引用的 default：静态侧必然报 DEPENDENCY_CYCLE（场景内那一查，不需要调用图）
  const scen = ir.defineScenario({
    schemaVersion: '1', id: 'scn.browser', name: 'b', env: { environmentRef: 'unit' },
    inputs: [{ name: 'who', type: 'string', default: { path: '$who' } }],
    body: [{ id: 'a', kind: 'noop' }],
  });
  const checked = await app.checkIr(JSON.stringify(scen));
  globalThis.__probe = {
    ok: true,
    statusEnum: ir.STEP_STATUS,
    lintCodes: eng.lintScenario(scen).map((i) => i.code),
    // checkIr 是我们自己那一层的封装：它的 issue 数与 canonical 也得是浏览器算出来的
    checkCodes: checked.issues.map((i) => i.code),
    canonicalHead: (checked.canonical ?? '').slice(0, 16),
    irSha: checked.irSha ?? checked.irShaError,
  };
} catch (e) {
  globalThis.__probe = { ok: false, error: String((e && e.stack) || e) };
}
</script>`;
      res.writeHead(200, { 'content-type': MIME['.html']! }).end(html);
      return;
    }
    const hit = ROOTS.find(([pre]) => pathname.startsWith(pre));
    if (!hit) { res.writeHead(403).end('forbidden'); return; }
    const rel = normalize(pathname.slice(hit[0].length - 1)).split(sep).filter((s) => s !== '..' && s !== '.').join('/');
    if (extname(rel) !== '.js' && extname(rel) !== '.json') { res.writeHead(403).end('ext forbidden'); return; }
    readFile(join(ROOT, hit[1], rel), (e, buf) => {
      if (e) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' }).end(buf);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    r({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((res2) => server.close(() => res2())) });
  }));
}

/* ═══ 最小 CDP 客户端 ═══
   刻意**只**有 send/close：这个夹具要的是"发一个方法、拿一个返回值"，
   事件流里 send 的应答之外的那一半（Page.loadEventFired 之类）在这里没用 ——
   等页面里的 module 跑完靠的是轮询 evalWait（那段是 await import，本来也没有
   对应的事件可等）。事件分发器一旦写出来，下一个用例就会开始依赖它，
   而它今天没有任何东西在守。所以留一个明确的形状：无事件、无重连、单页面。 */
interface Cdp { send<T>(method: string, params?: Record<string, unknown>): Promise<T>; close(): void }

async function connect(wsUrl: string): Promise<Cdp> {
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
async function waitForDevtools(port: number): Promise<string> {
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

/** 等 Runtime.evaluate 之前页面里的 module 跑完（那段是 await import，没有事件可等） */
async function evalWait(cdp: Cdp, expression: string, timeoutMs = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const v = r.result?.value;
    if (v !== undefined && v !== null) return v;
    if (Date.now() > deadline) throw new Error(`等不到表达式给出值：${expression}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

browserTest('浏览器里 import 真 ir/engine，并由引擎自己报出 issue', async () => {
  const site = await serve();
  const profile = mkdtempSync(join(tmpdir(), 'atest-web-probe-profile-'));
  // **自己的临时 profile**（docs/06 那条：Web adapter 必须用自己的 --user-data-dir，
  // 不复用日常浏览器会话 —— 这里同理，别去碰用户那份 Chrome 配置）
  const port = 9333 + (process.pid % 200);
  let child: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    child = spawn(BROWSER!, [
      `--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
    ], { stdio: 'ignore' });
    const wsUrl = await waitForDevtools(port);
    cdp = await connect(wsUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: site.url });

    const got = await evalWait(cdp, 'globalThis.__probe') as {
      ok: boolean; error?: string; statusEnum?: string[]; lintCodes?: string[]; checkCodes?: string[]; canonicalHead?: string; irSha?: string;
    };

    assert.equal(got.ok, true, `浏览器里加载/执行失败：${got.error}`);
    // 1) 六态枚举来自 IR —— 这条是"前端没有第二套状态表"（docs/13 §6）的机制性证据
    assert.deepEqual(got.statusEnum, ['pass', 'fail', 'error', 'healed', 'skipped', 'triaged'],
      '浏览器里拿到的 STEP_STATUS 与 Node 侧不是同一份');
    // 2) 引擎真的**跑出了结果**，不是"import 成功但什么都没发生"
    assert.ok(got.lintCodes?.includes('DEPENDENCY_CYCLE'), `引擎在浏览器里没报出那条自引用环：${JSON.stringify(got.lintCodes)}`);
    // 3) 我们那一层的封装也在浏览器里跑通（canonical + Web Crypto 的 sha）
    assert.ok(got.checkCodes?.includes('DEPENDENCY_CYCLE'), `checkIr 在浏览器里没报出问题：${JSON.stringify(got.checkCodes)}`);
    assert.ok(typeof got.canonicalHead === 'string' && got.canonicalHead.length > 0, 'canonical 序列化在浏览器里给空串');
    // sha 取不到时是**原因**而不是 undefined —— 这条测的是"取不到要说什么"那条纪律
    assert.ok(/^[0-9a-f]{64}$/.test(String(got.irSha)) || /Web Crypto/.test(String(got.irSha)),
      `irSha 那一格既不是 hash 也不是原因：${got.irSha}`);
  } finally {
    cdp?.close();
    child?.kill('SIGKILL');
    await site.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
