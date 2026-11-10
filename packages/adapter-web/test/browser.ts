/**
 * 真浏览器测试的公共夹具。
 *
 * 单独成文件的理由是本仓那条老教训：**同一件事有两份实现就会有一份漂移**。
 * "找一个浏览器二进制"这件事如果被 cdp.test.ts 与 ui.test.ts 各写一遍，
 * 某天只改了一边的搜索顺序，另一边就会悄悄跑到旧版本的 Chrome 上，
 * 然后出现"同一个套件里一半测试跑 1217、一半跑 1181"。
 *
 * 跳过策略与 cdp.test.ts 一致，也放在这里统一：
 *  - 本地找不到浏览器 => **大声跳过**（stderr 一行）；
 *  - `ATEST_REQUIRE_BROWSER=1`（流水线）=> 变成失败。
 * 静默跳过等于"web 端坏了也没人知道"，硬失败又让没装浏览器的机器上
 * `npm test` 整体不可用 —— 两个都不可接受。
 */
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * 找浏览器。**只在测试里**找；产品侧故意不自动探测
 * （静默挑一个浏览器，等于让"用的是哪个版本"变成不可复现的事）。
 */
export function findBrowser(): string | undefined {
  const fromEnv = process.env.ATEST_BROWSER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const roots = [
    join(homedir(), 'Library', 'Caches', 'ms-playwright'), // 本机实测存在
    '/Applications',
  ];
  const wants = [
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names: string[] = [];
    try { names = readdirSync(root).sort().reverse(); } catch { continue; }
    // **降序**取最新：升序会拿到最旧的，然后某天旧 rev 被清掉，
    // 测试从"稳定通过"变成"偶发找不到浏览器"
    for (const n of names) {
      for (const w of wants) {
        for (const p of [join(root, n, 'chrome-mac-x64', w), join(root, n, w)]) {
          if (existsSync(p)) return p;
        }
      }
    }
  }
  return undefined;
}

export const BROWSER = findBrowser();
const REQUIRE = process.env.ATEST_REQUIRE_BROWSER === '1';
if (!BROWSER && REQUIRE) {
  test('ATEST_REQUIRE_BROWSER=1 但找不到浏览器', () => {
    throw new Error('流水线说必须有浏览器，那就不能跳过。检查镜像里装了 Chrome/Chromium，或把路径写进 ATEST_BROWSER_BIN');
  });
} else if (!BROWSER) {
  // 跳过声明放在**这里**而不是各测试文件里各写一遍：两个文件都跳过时打两行，
  // 人会以为是两个不同的问题；而将来第三个文件忘了写，就变成"静默跳过"
  process.stderr.write('[adapter-web] 没找到 Chrome/Chromium：真浏览器的测试全部跳过。'
    + '设 ATEST_BROWSER_BIN 可跑；流水线设 ATEST_REQUIRE_BROWSER=1 会让跳过变成失败。\n');
}

/** 需要真浏览器的测试用它。找不到时是 test.skip */
export const browserTest = BROWSER && existsSync(BROWSER) ? test : test.skip;

/** 浏览器路径。只在 browserTest 里用，所以这里的断言只是把 undefined 变成一条明确失败 */
export function browserBin(): string {
  if (!BROWSER) throw new Error('内部错误：browserBin() 只能在 browserTest 里调用');
  return BROWSER;
}

/**
 * 夹具页面。**经本地 http 服务，不用 data: URL**。
 *
 * 这不是口味问题：适配器的 navigate 只放行 http(s)（`data:` 能造出带任意脚本的文档，
 * 属于执行语义）。要是为了测试方便在适配器上给 `data:` 开口子，
 * 那就是**为了让测试跑通而放宽安全边界** —— 顺序错了。
 * 所以这里起一个 127.0.0.1 的服务把夹具当普通页面发。
 *
 * 附带两个好处：
 *  - localStorage / cookie 需要非 opaque 源，`data:` 下**根本没法测会话隔离**；
 *  - `charset=utf-8` 走响应头，比在 URL 里塞 charset 更接近真实被测系统
 *    （docs/14 §4.11 那次"中文变乱码"的真因就是夹具 URL 没编码）。
 */
let server: Server | undefined;
let serverUrl = '';
const PAGES = new Map<string, string>();

export async function fixtureUrl(html: string): Promise<string> {
  if (!server) {
    server = createServer((req, res) => {
      const id = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
      const body = PAGES.get(id);
      if (body === undefined) { res.statusCode = 404; res.end('no such fixture'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('夹具服务没拿到端口');
    serverUrl = `http://127.0.0.1:${addr.port}/`;
    /*
     * **必须 unref**。这是个真实的坑，不是收尾洁癖：监听中的 socket 是 active handle，
     * 事件循环不空 -> 进程不退出 -> **测试全绿但命令永不返回**。
     * 第一版就是这样，写的是 `process.on('exit', close)` —— 那个处理器压根轮不到执行，
     * 因为进程从来没 exit。CI 上表现为"这条用例卡到被 kill"，日志里一个异常都没有
     * （docs/14 §4.10 记的就是这一类形状）。
     * unref 之后服务只在还有浏览器要它时才活着，测试跑完自然散场。
     */
    server.unref();
  }
  const id = `p${PAGES.size}`;
  PAGES.set(id, html);
  return `${serverUrl}${id}`;
}

/**
 * data: 形式的夹具。**只给传输层测试用**（cdp.test.ts 直接发 CDP 命令，
 * 不经过适配器的导航白名单）。
 * 用途是钉住"送进去的中文与读回来的逐字符相同"那条 —— 那次的真因就是
 * data URL 没百分号编码，所以这个形态本身要留着测。
 * 端口层测试一律用 fixtureUrl（原因见上）。
 */
export const fixture = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
