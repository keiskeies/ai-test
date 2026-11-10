/**
 * CDP 客户端的两类测试，分得很开，因为它们的**可信度来源**不同：
 *
 *  A. **纯函数与失败路径**（不需要浏览器，永远跑）：stderr 里认地址、
 *     没给二进制时的报错。这两条是本模块最容易写错、又最不会因为"浏览器能跑"
 *     而被发现的部分 —— 端口认错会连到**别人的**浏览器（假绿），
 *     而它跑得越好越没人怀疑。
 *
 *  B. **真浏览器端到端**（需要 Chrome/Chromium，见下面的解析规则）：
 *     起进程 → flatten 会话 → 导航 → AX 树 → 事件。
 *     这一类**不能自己骗自己**：CDP 的响应形态（`nodes[].role.value`、
 *     flatten 的 sessionId、事件带不带 sessionId）我是**实测**出来的，
 *     拿 fake 去测只能证明"我按自己的想象写了两遍"。
 *
 * B 类在找不到浏览器时的处置是**大声跳过 + CI 里可强制失败**：
 * 静默跳过等于"web 端坏了也没人知道"，那正是本仓那个"下半截没人接"的缺陷类；
 * 而硬失败又会让没装浏览器的机器上 `npm test` 整体不可用。两个都不能接受，
 * 所以：跳过时打一行到 stderr，且 `ATEST_REQUIRE_BROWSER=1` 下改为失败
 * （服务端/流水线设它，本地默认跳过）。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { launchBrowser, parseDevtoolsUrl } from '../src/cdp.js';

// ── A. 纯函数与失败路径 ───────────────────────────────────────────────────

test('从 stderr 认 DevTools 地址：只认那一行，别把端口写死', () => {
  const line = 'DevTools listening on ws://127.0.0.1:53395/devtools/browser/4faa12f2';
  assert.equal(parseDevtoolsUrl(line), 'ws://127.0.0.1:53395/devtools/browser/4faa12f2');
  // 真实 stderr 是混着一堆别的输出的，地址不一定在第一行
  assert.ok(parseDevtoolsUrl(`Some noise\n${line}\nmore`), '地址在中间行时也要认得到');
  // 认不到必须返回 undefined（调用方据此报错），**不能返回一个默认地址**：
  // 退回固定端口的话，并发跑的第二个 run 会连到第一个 run 的浏览器上，
  // 两边都能"跑通"，只是互相看见对方的页面 —— 最难查的那类假绿
  assert.equal(parseDevtoolsUrl('nothing here'), undefined);
  assert.equal(parseDevtoolsUrl(''), undefined);
});

test('没给浏览器路径时的报错要点名该设哪个变量（而不是 ENOENT 或静默挑一个）', async () => {
  const saved = process.env.ATEST_BROWSER_BIN;
  delete process.env.ATEST_BROWSER_BIN;
  try {
    await assert.rejects(() => launchBrowser(), (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /ATEST_BROWSER_BIN/, '要指名开关名，否则人只会去搜"为什么起不来"');
      // 并且**不能**去 spawn：spawn 一个不存在的路径给的是 ENOENT，
      // 那条报错里没有"该设哪个变量"，等于把一次配置问题伪装成环境问题
      return true;
    });
  } finally {
    if (saved !== undefined) process.env.ATEST_BROWSER_BIN = saved;
  }
});

test('二进制路径写错时是**这一次 run 失败**，不是整个进程没了', async () => {
  // 这条是**测试逼出来的缺陷**，不是我先想到再写的测试。
  // 第一版实现里没有 proc.on('error')：spawn 对"二进制不存在"是异步发 error 的，
  // 而 ChildProcess 是 EventEmitter —— 没人听就成了 uncaughtException，
  // **整个进程当场没**。真实症状：把 ATEST_BROWSER_BIN 打错一个字母，
  // runner 崩掉、这一批用例全没，日志里只有一句裸的 spawn ENOENT。
  await assert.rejects(
    () => launchBrowser({ bin: '/nonexistent/definitely-not-a-browser-atest', readyTimeoutMs: 1500 }),
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      assert.match(m, /起浏览器失败/, `报错要说清是起浏览器这一步：${m}`);
      // 点名开关名：只说 ENOENT 的话人会去查系统、查权限，而真相是配置里一行路径写错
      assert.match(m, /ATEST_BROWSER_BIN/, `报错要点名该改哪个开关：${m}`);
      assert.ok(m.includes('/nonexistent/definitely-not-a-browser-atest'), '要把写错的那个值带出来');
      return true;
    },
  );
  // 走到这里就说明进程没被带崩 —— 上面若是 uncaughtException，这条测试根本到不了结尾
});

// ── B. 真浏览器 ────────────────────────────────────────────────────────────

/**
 * 找浏览器。**只在测试里**找；产品侧故意不自动探测
 * （静默挑一个浏览器，等于让"用的是哪个版本"变成不可复现的事）。
 */
function findBrowser(): string | undefined {
  const fromEnv = process.env.ATEST_BROWSER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const roots = [
    // playwright 的缓存（本机实测存在，是这台开发机上唯一现成的 Chromium 系）
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    '/Applications',
  ];
  const wants = [
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // ms-playwright 下有多个 chromium-<rev>，按版本号**降序**取最新：
    // 升序会拿到最旧的那个，然后某天旧 rev 被清掉，测试从"稳定通过"变成"偶发找不到浏览器"
    let names: string[] = [];
    try { names = readdirSync(root).sort().reverse(); } catch { continue; }
    for (const n of names) {
      for (const w of wants) {
        const p = join(root, n, 'chrome-mac-x64', w);
        if (existsSync(p)) return p;
        const p2 = join(root, n, w);
        if (existsSync(p2)) return p2;
      }
    }
  }
  return undefined;
}

const BROWSER = findBrowser();
const REQUIRE = process.env.ATEST_REQUIRE_BROWSER === '1';
if (!BROWSER && REQUIRE) {
  // 强制模式下**必须失败**：CI 上"跳过"与"通过"在汇总里长得一样，
  // 而 web adapter 一旦静默不再被跑，它就等于不存在
  test('ATEST_REQUIRE_BROWSER=1 但找不到浏览器', () => {
    assert.fail('流水线说必须有浏览器，那就不能跳过。检查镜像里装了 Chrome/Chromium，'
      + '或把路径写进 ATEST_BROWSER_BIN');
  });
} else if (!BROWSER) {
  process.stderr.write('[adapter-web] 没找到 Chrome/Chromium：真浏览器的 4 条测试跳过。'
    + '设 ATEST_BROWSER_BIN 可跑；流水线设 ATEST_REQUIRE_BROWSER=1 会让跳过变成失败。\n');
}

const browserTest = BROWSER && existsSync(BROWSER) ? test : test.skip;

/** 夹具页面。**必须带 charset=utf-8**：裸 data URL 里的中文会被按非 UTF-8 解，
 *  断言双方都拿到乱码时更是"全绿但读的是乱码"（docs/14 §4.11 那条实测） */
const fixture = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

browserTest('起浏览器 → flatten 会话 → 导航 → AX 树里能拿到中文的 role+name', async () => {
  const b = await launchBrowser({ bin: BROWSER });
  try {
    assert.ok(b.pid, '要拿得到进程 id（排查僵尸进程时唯一的坐标）');
    const t = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    assert.ok(t.result?.targetId, `建 target 失败：${JSON.stringify(t.error)}`);
    const a = await b.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.result!.targetId, flatten: true });
    const sid = a.result!.sessionId;
    assert.ok(sid, `attach 失败：${JSON.stringify(a.error)}`);

    await b.send('Page.enable', {}, sid);
    // 中文是**故意的**：这条同时守着"WebSocket 帧按 UTF-8 解"和"夹具带 charset"
    await b.send('Page.navigate', { url: fixture('<button aria-label="提交订单">go</button><p>合计 12.00</p>') }, sid);
    await new Promise((r) => setTimeout(r, 400));

    const ax = await b.send<{ nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> }>(
      'Accessibility.getFullAXTree', {}, sid);
    const btn = (ax.result?.nodes ?? []).find((n) => n.role?.value === 'button');
    assert.ok(btn, `AX 树里没有 button：${JSON.stringify(ax.error)}`);
    assert.equal(btn!.name?.value, '提交订单',
      'accessible name 必须由浏览器算出中文字面值 —— role+name 是 docs/06 §2 的首选定位法');
  } finally {
    await b.close();
  }
});

browserTest('导航未完成时 Page 事件真的推过来（expectResponse 靠的就是这个）', async () => {
  const b = await launchBrowser({ bin: BROWSER });
  try {
    const t = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const a = await b.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.result!.targetId, flatten: true });
    const sid = a.result!.sessionId;
    const seen: string[] = [];
    b.onEvent((e) => { if (e.sessionId === sid) seen.push(e.method); });
    await b.send('Page.enable', {}, sid);
    await b.send('Page.navigate', { url: fixture('<p>x</p>') }, sid);
    await new Promise((r) => setTimeout(r, 500));
    // 断"有导航事件"**并且**"事件带着对的 sessionId"。
    // 后者是本仓那种"机制在但没接对"的位置：只断前者， sessionId 全丢也能过
    assert.ok(seen.includes('Page.frameNavigated'), `没收到导航事件：${seen.slice(0, 6).join(',')}`);
  } finally {
    await b.close();
  }
});

browserTest('连接关掉之后在飞的命令必须失败，而不是永远挂着', async () => {
  // docs/14 §4.10 那条教训的正面实现：没有报错、只是不再返回，
  // 在 CI 里表现为"这条用例卡到被 kill"，日志里一个异常都没有。
  const b = await launchBrowser({ bin: BROWSER });
  const t = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const a = await b.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.result!.targetId, flatten: true });
  const inflight = b.send('Runtime.evaluate', { expression: '1+1' }, a.result!.sessionId);
  await b.close();
  const r = await Promise.race([
    inflight,
    new Promise<null>((res) => setTimeout(() => res(null), 3000)),
  ]);
  assert.ok(r !== null, '关连接后命令永不返回（那就是"静默挂死"，CI 里等于用例卡住）');
  assert.ok(r!.error, '关连接后应当拿到 error 而不是一个空 result');
});

browserTest('evaluate 取回的中文与送进去的逐字符相同（两次独立往返）', async () => {
  // **这条测试存在的唯一理由**是它能证伪一个我自己犯过的诊断。
  // 我曾把"中文变乱码"归因于 WebSocket 帧按 latin1 解，改了 TextDecoder 去验，
  // 结果一个字符都没变 —— 真因是夹具 URL 没百分号编码。
  // 上面那条 navigate 只验"最后是对的"，抓不到那种"改了不该改的东西然后侥幸通过"。
  // 这条把两头都钉住：送进去的字面值 == 浏览器里读回来的字面值，
  // 而且**同时**验一次纯 DOM 往返（不经 URL），这样 URL 编码那一层出问题时会分得清是谁坏了。
  const b = await launchBrowser({ bin: BROWSER });
  try {
    const t = await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const a = await b.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.result!.targetId, flatten: true });
    const sid = a.result!.sessionId;
    await b.send('Page.enable', {}, sid);
    await b.send('Runtime.enable', {}, sid);
    const want = '合计 12.00 元（含税）';

    // 路 A：经 URL 注入（真用例会走的路）
    await b.send('Page.navigate', { url: fixture(`<p id=v>${want}</p>`) }, sid);
    await new Promise((r) => setTimeout(r, 400));
    const viaUrl = await b.send<{ result?: { value?: string } }>(
      'Runtime.evaluate', { expression: 'document.getElementById("v").textContent', returnByValue: true }, sid);
    assert.equal(viaUrl.result?.result?.value, want, '经 URL 注入的中文被改写了');

    // 路 B：不经 URL，直接写 DOM。与路 A **分开判**，坏了才分得清是哪一层
    await b.send('Page.navigate', { url: 'about:blank' }, sid);
    await new Promise((r) => setTimeout(r, 200));
    await b.send('Runtime.evaluate', { expression: `document.body.innerHTML='<p id=v>${want}</p>'` }, sid);
    const viaDom = await b.send<{ result?: { value?: string } }>(
      'Runtime.evaluate', { expression: 'document.getElementById("v").textContent', returnByValue: true }, sid);
    assert.equal(viaDom.result?.result?.value, want, '不经 URL 的中文也被改写 —— 那是解码层坏了，不是夹具的事');
  } finally {
    await b.close();
  }
});
