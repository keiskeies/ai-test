/**
 * 最小 CDP（Chrome DevTools Protocol）客户端。零 npm 依赖：
 * Node ≥22 自带全局 `WebSocket` 与 `fetch`，浏览器用子进程起 ——
 * 这是"npm registry 不可达"与"Web 端做不了"之间那一步被推翻后剩下的全部需求
 * （证据与教训记在 docs/14 §4.11）。
 *
 * 三个决定各自对应一个会假装成功的失败：
 *
 *  1. **端口从 stderr 的 `DevTools listening on ws://…` 读，不用固定端口。**
 *     固定端口在并发跑两个 run 时后起的那个连到**前一个 run 的浏览器**上，
 *     两边都"能跑"，只是互相看见对方的页面 —— 那是最难查的一类假绿/假红
 *     （docs/06 §1 把"隔离粒度"列为 P2 第一件事，同一个理由）。
 *     `--remote-debugging-port=0` 让 Chrome 自己挑，再从 stderr 认地址。
 *
 *  2. **每个 target 一条 flatten session（`Target.attachToTarget{flatten:true}`）。**
 *     flatten 模式下所有会话共用这一条 WebSocket，命令与事件都带 `sessionId`。
 *     所以一个 browser 进程能服务很多 run（docs/06 §1 的"共享 browser + 独立 context"），
 *     而客户端不需要为每个页面开一条连接。
 *
 *  3. **收帧一律走 `TextDecoder('utf-8')`。** Node 的 WebSocket 给的是
 *     Buffer/ArrayBuffer；直接 String() 会按 latin1 解，中文变乱码。
 *     ⚠ 但**别把这条当成"中文问题的解药"** —— docs/14 §4.11 记着我自己就把它
 *     当成过一次：那次乱码的真因是夹具里裸 `data:text/html,<h1>中文</h1>`
 *     没百分号编码，改解码方式**一个字符都没变**。改完必须确认观测值真的动了。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Node 22 起 WebSocket 是全局的，但 @types/node 只把它挂在 node:http 上（不是 globalThis）。
// 从 node:http 取比给这个服务端包塞 lib:DOM 干净 —— 后者会把 document/window 也带进来。
import { WebSocket } from 'node:http';

/** CDP 响应。error 原样带出，不在这里翻译成中文 —— 那是调用方的事 */
export interface CdpResponse<T = unknown> {
  id: number;
  sessionId?: string;
  result?: T;
  error?: { code: number; message: string; data?: string };
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

const WSDecoder = new TextDecoder('utf-8');
/**
 * WebSocket 帧 -> 文本。**必须显式过 UTF-8**：Node 给的是 Buffer/ArrayBuffer，
 * 直接 String(buf) 按 latin1 解，中文变乱码。
 * （但别把它当"中文问题的万能解"—— docs/14 §4.11 记着我有一次乱码的真因
 *  是夹具 URL 没百分号编码，改这里一个字符都不会变。）
 */
function asText(d: unknown): string {
  if (typeof d === 'string') return d;
  if (d instanceof ArrayBuffer) return WSDecoder.decode(new Uint8Array(d));
  if (ArrayBuffer.isView(d)) return WSDecoder.decode(d as Uint8Array);
  // 认不出形态就**明说**，不要 String(d) 静默给个 "[object Object]"：
  // 那会变成"页面文本读出来永远是同一串"，然后断言双方都拿到同一个假值
  throw new Error(`CDP 帧形态不认识：${Object.prototype.toString.call(d)}`);
}

/**
 * 从 Chrome 的 stderr 里认 ws 地址。
 * 匹配不到就**必须报错**而不是退回默认端口：退回默认端口正是上面第 1 条
 * 那个"连到别人的浏览器"的场景，而那件事没有任何报错。
 */
export function parseDevtoolsUrl(errText: string): string | undefined {
  return errText.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
}

export interface LaunchOptions {
  /** 浏览器可执行文件。缺省读 ATEST_BROWSER_BIN */
  bin?: string;
  /** 额外 Chrome 参数。**不要**在这里塞 --remote-debugging-port，由本模块管理 */
  args?: string[];
  /** 等 ws 地址出现的上限。默认 30s（冷启动 + 首屏杀软扫描在 CI 上能到十几秒） */
  readyTimeoutMs?: number;
  /** headless。默认 true */
  headless?: boolean;
}

/**
 * 起一个浏览器进程并连上它。返回的 `close()` 会等进程真退出，并删掉本次的
 * 临时 profile —— 不等进程退出就留下占着端口的进程，下一个 run 的成败
 * 取决于上一个死没死；不删 profile 则是每次 run 留一个几百 MB 的目录。
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<BrowserHandle> {
  const bin = opts.bin ?? process.env.ATEST_BROWSER_BIN;
  if (!bin) {
    throw new Error(
      '找不到浏览器可执行文件。设 ATEST_BROWSER_BIN=<chrome/chromium 路径>，或在环境配置里给 browserBin。'
      + '（本包不自动探测安装路径：静默挑一个浏览器，等于让"用的是哪个浏览器版本"变成不可复现的事）',
    );
  }
  /*
   * **必须自带 user-data-dir**。原先这里只写了句"隔离用临时 profile"却没传这个开关 ——
   * 那是本仓反复出现的那类缺陷：**注释声明的性质，代码里没有**。
   * 后果不是"隔离差一点"：不传的话 Chrome 用的是**调用者本人的默认 profile**，
   * 于是用例直接拿到他已登录的会话（假绿：用例以为"登录成功"，其实是人的 cookie），
   * 而用例跑完写入的 cookie/localStorage 落进**他真实的浏览器配置**里。
   * docs/06 §1 把"一个 run 一个独立 context、绝不共享"列为 P2 第一件事，就是这个理由。
   *
   * mkdtemp 而不是固定目录：并发两个 run 用同一个 profile 会被 Chrome 自己拒掉
   * （"profile 已被占用"），表现成随机的启动失败。
   */
  const profile = await mkdtemp(join(tmpdir(), 'atest-browser-'));
  const args = [
    `--user-data-dir=${profile}`,
    // port=0：让 Chrome 挑端口，地址从 stderr 认（理由见文件头第 1 条）
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    ...(opts.headless === false ? [] : ['--headless=new']),
    ...(opts.args ?? []),
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
  /*
   * **必须挂 error 处理器**（这条是测试逼出来的，不是我想到的）：
   * spawn 对"二进制不存在"是**异步**报 error 的，而 ChildProcess 是 EventEmitter ——
   * 没人听 error 时它是一个 uncaughtException，**整个进程当场没**。
   * 症状是"我把 ATEST_BROWSER_BIN 写错了一个字母，于是 runner 崩了、
   * 所有用例一起没了，日志里只有一句 spawn ENOENT"。
   * 这里收下来变成**正常的 reject**：只有这一次 run 失败，报错还点名是哪个开关写错了。
   */
  let spawnError: Error | undefined;
  proc.on('error', (e) => { spawnError = e; });
  const limit = opts.readyTimeoutMs ?? 30_000;
  const t0 = Date.now();
  let url: string | undefined;
  while (!url) {
    if (spawnError) {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `起浏览器失败：${spawnError.message}（二进制=${bin}）。`
        + '路径来自 ATEST_BROWSER_BIN 或环境配置的 browserBin。',
      );
    }
    if (proc.exitCode !== null) {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
      throw new Error(`浏览器进程提前退出（code=${proc.exitCode}）：${stderr.slice(0, 400) || '（stderr 为空）'}`);
    }
    url = parseDevtoolsUrl(stderr);
    if (url) break;
    if (Date.now() - t0 > limit) {
      proc.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
      throw new Error(`等浏览器 DevTools 地址超时 ${limit}ms。stderr 尾部：${stderr.slice(-400) || '（空）'}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    const conn = await CdpConnection.connect(url);
    return new BrowserHandle(conn, proc, profile);
  } catch (e) {
    // 连接失败也要收进程与目录：这条路径上"启动失败"是**预期的**（比如二进制路径写错），
    // 而启动失败还留一个浏览器进程 = 每试错一次漏一个
    await killAndWait(proc);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 起了浏览器的调用方拿到的句柄。`close()` 保证**先关连接、再等进程退出、最后删 profile**：
 * 只关连接会留下进程；不等进程退出则端口还占着，下一个 run 的成败取决于上一个的调度。
 */
export class BrowserHandle {
  constructor(
    private readonly conn: CdpConnection,
    private readonly proc: ChildProcess,
    private readonly profile: string,
  ) {}

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResponse<T>> {
    return this.conn.send<T>(method, params, sessionId);
  }
  onEvent(fn: (e: CdpEvent) => void): () => void { return this.conn.onEvent(fn); }
  get isClosed(): boolean { return this.conn.isClosed; }
  /** 浏览器进程 id。并发排查时要知道是哪个进程（僵尸进程是这一层最容易漏的东西） */
  get pid(): number | undefined { return this.proc.pid; }

  async close(): Promise<void> {
    await this.conn.close();
    await killAndWait(this.proc);
    await rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** SIGTERM 后等退出，等不到再 SIGKILL。返回而不是忽略，是为了让调用方能发现"关不掉" */
async function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const t0 = Date.now();
  while (proc.exitCode === null && Date.now() - t0 < 5_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

/**
 * 一条到 browser 端点的 CDP 连接。
 *
 * 命令按 id 配对；事件按 (sessionId, method) 分发给订阅者。
 * 事件订阅是**必须有的**：docs/06 §3 的 `expectResponse`（"点了查询，等那个接口回来"）
 * 靠的是 Network.responseReceived，而它只能在事件里拿到。
 */
export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, (r: CdpResponse) => void>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {}

  static async connect(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const conn = new CdpConnection(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连 CDP 超时 ${timeoutMs}ms：${url}`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`连不上 CDP：${url}`)); }, { once: true });
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: CdpResponse & CdpEvent;
      try { msg = JSON.parse(asText(ev.data)); } catch { return; }
      if (typeof msg.id === 'number' && conn.pending.has(msg.id)) {
        conn.pending.get(msg.id)!(msg);
        conn.pending.delete(msg.id);
      } else if (typeof msg.method === 'string') {
        for (const l of conn.listeners) l({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
      }
    });
    // 连接被对端关掉时，**在飞的命令必须立刻失败**。
    // 不这么做的话它们会一直挂着，表现为"这条用例卡住不动"而不是"浏览器没了" ——
    // 与本仓 call 成环那次同一种形状：没有报错，只是不再返回。
    ws.addEventListener('close', () => {
      conn.closed = true;
      for (const [, reject] of conn.pending) reject({ id: -1, error: { code: -32000, message: 'CDP 连接已关闭' } });
      conn.pending.clear();
    });
    return conn;
  }

  /**
   * 发一条命令。**error 不抛，原样返回**：
   * 定位阶梯要靠"这一级失败了，试下一级"来走，抛异常会让阶梯变成一次性失败。
   */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResponse<T>> {
    if (this.closed) return Promise.resolve({ id: -1, error: { code: -32000, message: 'CDP 连接已关闭' } });
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, (r) => resolve(r as CdpResponse<T>));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      // 超时兜底。CDP 有"命令永不回"的情形（页面在导航中挂住 renderer），
      // 而本仓的教训是：没有超时的 await 会让整个 run 静默挂死（docs/14 §4.10）
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ id, error: { code: -32001, message: `CDP 命令超时：${method}` } });
        }
      }, 30_000).unref?.();
    });
  }

  onEvent(fn: (e: CdpEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get isClosed(): boolean { return this.closed; }

  async close(): Promise<void> {
    this.closed = true;
    try { this.ws.close(); } catch { /* 已关 */ }
    this.listeners.clear();
  }
}
