/**
 * 一次 Web 会话的全部机制：进程/上下文隔离、查询、页面内原语、快照。
 * **不含 UiExec 端口**（那在 ui.ts）—— 分开的理由是这一层的每个函数都只在真浏览器上
 * 才有对错可言，而端口那层的对错大部分是"归因与状态"，判据不同、测试也不同。
 *
 * 零第三方依赖，全走 cdp.ts。三条与"会假装成功"对着干的纪律：
 *
 *  1. **一个 adapter 一个 BrowserContext**（`Target.createBrowserContext`）。
 *     cookie / localStorage / IndexedDB / service worker 全在 context 这层隔离。
 *     docs/06 §1 把"绝不共享 context"列为 P2 第一件事，理由是"用例 A 登录、
 *     用例 B 意外继承 A 的会话 → 假绿"。浏览器进程**可以**共享（传入 browser）：
 *     context 创建约 100ms，每 run 起一个 Chrome 在 20 并发时会 OOM。
 *  2. **外部内容只走 CDP 参数，不进 JS 表达式**。CSS 走 `DOM.querySelector(nodeId, selector)`、
 *     XPath 走 `DOM.performSearch(query)` —— 两个都是入参，由浏览器按选择器语法解析，
 *     压根不进 JS 解析器。页面里执行的表达式全是本文件写死的常量（FN 表）；
 *     要带值就用 `Runtime.callFunctionOn` 的 `arguments`。
 *  3. **导航使句柄失效**。`Page.frameNavigated` 一到就清缓存：拿旧 nodeId 去点，
 *     Chrome 可能把 id 复用成另一个节点，那是"点了另一个元素然后报绿"。
 */
import type { ObservedResponse } from '@atest/engine';

import type { BrowserHandle, CdpEvent } from './cdp.js';
import { launchBrowser } from './cdp.js';
import { ResponseBuffer } from './response-buffer.js';

export interface SessionOptions {
  bin?: string;
  /** 复用已起的浏览器。**传进来就不由本会话关**：谁的进程谁关， */
  browser?: BrowserHandle;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  locale?: string;
  timezoneId?: string;
  headless?: boolean;
  actionTimeoutMs?: number;
}

export interface Session {
  readonly browser: BrowserHandle;
  readonly ownedBrowser: boolean;
  readonly sessionId: string;
  readonly targetId: string;
  readonly viewport: { width: number; height: number; deviceScaleFactor: number };
  readonly dialogs: Array<{ type: string; message: string; accepted: boolean }>;
  readonly pageErrors: Array<{ kind: string; text: string }>;
  /**
   * 页面内请求的响应流（供引擎的 `wait{response}` / `expectResponse` 判"那个接口回来了没"）。
   *
   * **绝对下标语义**：`responsesSince(s)` 返回下标 > s 的条目，下标从 1 起单调追加，
   * 永不因清理而回退。引擎侧靠它开窗（起点 = 上一步消费到的位置），
   * 所以这里**绝不能**把下标重新从 0 排 —— 那会让引擎把旧响应当新的（假绿）。
   */
  responsesSince(s: number): Promise<ObservedResponse[]>;
  /**
   * "由**本页面**打开的新标签页"的计数（IR 的 `act{expectNewPage:true}` 靠它）。
   *
   * 只有一个递增整数，**刻意不返回页面列表**：判据是"这一步期间有没有多出一个"，
   * 而列表里的 URL 会进 keyContext/摘要/trace —— `?token=` 这种查询串
   * `redactForDisk` 判不出来（只认 JWT/AKIA/sk-/Bearer 形状）。
   * 需要跳到那个新页面去断言属另一件事（要做就该有个显式的 switch-target 动作，
   * 而不是让计数顺手带出地址）。
   *
   * **判据为什么必须带 openerId**（实测，不是推演）：`Target.setDiscoverTargets`
   * 一开就会收到**整个浏览器**的 target 事件，本机实测包括别的 browserContext 的
   * `chrome://newtab/`、两个 Chrome 扩展的 service_worker、以及本会话自己那个
   * `about:blank`。所以"数一切新出现的 page target"会**恒真** ——
   * `expectNewPage` 变成一条永远过的断言，比不实现更坏。
   * 实测三种写法（`<a target=_blank>` / `window.open()` / `window.open(u,'_blank')`）
   * 的 `targetCreated` 都带 `openerId === 本会话的 targetId`；
   * 而 `window.open(u,'_self')`（同页跳转）**不发** `targetCreated`，只有 `targetInfoChanged`，
   * 且**那条不带 openerId** —— 所以同页跳转在第一道闸就被挡掉。
   *
   * **但 method 名那道闸不是冗余的**（这里曾写着"冗余"，是错的，下面是实测）：
   * 一次真开窗产生**两条**都带 `openerId === 本页` 的事件 ——
   * `targetCreated`（url 还是空的）与随后子页面导航到真实 URL 的 `targetInfoChanged`。
   * 所以"created 与 changed 都算"会让一次开窗**加 2**。
   * 我先前是从"放宽后七条一条都没红"推出"冗余"的，那步推理不成立：
   * 那七条问的全是 `after > before`，**"有没有"的断言看不见"多算了几次"**。
   * 补了 new-page.test.ts 里"一次开窗只加 1"那条，这个破坏现在会被抓住。
   *
   * 两道闸挡的是**不同**的失效方向：openerId 挡"别人的窗口算到我头上"，
   * 只认 created 挡"同一个窗口的后续状态变化被反复计数"，以及
   * （本页自己那条 infoChanged 带上 openerId 的那天）"本页每次导航都算开窗"。
   *
   * `type === 'page'` 那一档**目前没有生产者**：探针找过三种 `window.open` 写法、
   * `window.open('about:blank')` 和**下载**（`<a download>`，"点导出按钮"是本字段主场景），
   * 由本页打开的事件全是 `page`，下载压根不产生 target，扩展的 service_worker 不带 openerId。
   * 留着是因为它是 TargetInfo 上最便宜的不变量，但**别把它记成"已验证挡住了什么"** ——
   * 见 tooling/mutate/new-page-web.json 的 W3（记的是 equivalent）。
   *
   * 判据里的"本页"用的是接口上已有的 `targetId`（导航不会换 targetId）。
   */
  newPageCount(): number;
  /**
   * 这个会话**能不能**观测到新开的页面（`Target.setDiscoverTargets` 开成功了没）。
   *
   * **为什么要把这种"我自己行不行"的事暴露出来**：不能的话，adapter 那边就
   * **不挂** `adapters.newPage` 这个端口，引擎于是报 env-unavailable。
   * 反过来如果照常挂上一个恒 0 的计数器，`expectNewPage` 会等满超时判
   * fail + product-bug —— 把"平台看不见窗口事件"说成"被测产品没弹窗"。
   * 一个装作能观测的探针，比没有探针危险：后者的报错是对的。
   */
  readonly newPageObserves: boolean;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** 失败转异常的那一个（send 刻意不抛，阶梯要"这一级失败试下一级"） */
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  query(loc: { strategy: 'css' | 'xpath'; selector: string }): Promise<number[]>;
  callOn<T>(nodeId: number, fn: string, args?: unknown[]): Promise<T | undefined>;
  box(nodeId: number): Promise<{ x: number; y: number; w: number; h: number }>;
  text(nodeId: number): Promise<string>;
  aria(): Promise<{ text: string; nodes: AxNode[] }>;
  pageText(): Promise<string>;
  evalPage<T>(expression: string): Promise<T | undefined>;
  url(): Promise<string>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array>;
  waitLoaded(waitUntil: 'load' | 'dom' | 'idle', url: string): Promise<void>;
  /**
   * 注册"导航发生了"的回调（端口层用它让已发出的句柄失效）。
   * **必须是接口方法**：早先它是一个模块级函数往返回对象上挂属性，
   * 而闭包读的是自己那个变量 —— 挂上去没人读，于是"导航后句柄失效"这件事
   * 根本没发生，且**看起来发生了**。接口方法让编译器替我盯住这条连线。
   */
  onNavigate(fn: () => void): void;
  close(): Promise<void>;
}

/**
 * `Accessibility.getFullAXTree` 响应里**本仓真正读的那几个字段**。
 *
 * ⚠ 运行时拿到的是 CDP 那个**完整**节点（上面是 `send<{nodes: AxNode[]}>` 一个 cast，
 * 没有投影），所以这个 interface 的作用是**声明"我们依赖哪几个字段"**，
 * 而不是描述对象上有什么。因此多写一个没人读的字段不是"信息更全"，是
 * **一句假的依赖声明** —— 下一个人会以为 AX→DOM 的映射已经接上了。
 * 原先这里写着 `backendDOMNodeId?: number`（CDP 确实返回它），而全仓零读者：
 * `tooling/dead-iface-fields.mjs` 报出来的第二个真死字段，本轮删掉。
 * 真要做"AX 节点 → DOM 节点"那一步时，连同它的消费者一起加回来。
 */
export interface AxNode {
  nodeId?: string; parentId?: string; ignored?: boolean;
  role?: { value?: string }; name?: { value?: string };
  childIds?: string[];
}

/**
 * 页面里执行的表达式。**全是本文件写死的常量**，见文件头第 2 条。
 * 注释里写清"为什么不是更简单的那一种"，因为每一处都有人会因为省事而改回去。
 */
export const FN = {
  /** 中心点是否真落在这个元素上。返回原因而不是布尔：报错要能指认是谁盖的 */
  hitTest: `function(){
    const r = this.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, why: 'zero-size' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { ok: false, why: 'offscreen' };
    const top = document.elementFromPoint(x, y);
    if (!top) return { ok: false, why: 'no-element-at-point' };
    if (top === this || this.contains(top) || top.contains(this)) return { ok: true };
    return { ok: false, why: 'occluded', by: top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') };
  }`,
  visible: `function(){
    const r = this.getBoundingClientRect(); const s = getComputedStyle(this);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  }`,
  text: `function(){ return (this.innerText ?? this.textContent ?? '').replace(/\\s+/g, ' ').trim(); }`,
  focus: `function(){ this.scrollIntoView({ block: 'center', inline: 'center' }); this.focus(); return document.activeElement === this; }`,
  /** 改 value 之后必须派发事件：只赋值的话被测前端的 onChange/onInput 压根不跑，
   *  "选了省市区之后联动加载城市列表"这类用例会绿着跳过被测逻辑 */
  setValue: `function(v){ this.value = v; this.dispatchEvent(new Event('input', { bubbles: true })); return this.value; }`,
  selectValue: `function(v){ const s = this; s.value = v;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; }`,
  enabled: `function(){ return !this.disabled && !this.readOnly; }`,
  box: `function(){ const r = this.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }`,
} as const;

/** 页面里求值。表达式抛异常时 CDP 给的是 exceptionDetails **而不是 error** ——
 *  send 那道闸拦不到它。原样返回会变成一个裸 undefined：调用方看不出
 *  "表达式压根没跑成"和"跑了、值真是 undefined"（本仓那一类"没有报错、只是值不对"）。
 *  所以在这里转成异常，并把异常文本带出来。 */
/** Runtime.evaluate 的响应体（CDP result 那一层） */
export interface EvalOut<T> { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }

export function evalValue<T>(r: EvalOut<T>): T | undefined {
  const d = r.exceptionDetails;
  if (d) throw new Error(`页面内求值抛错：${d.exception?.description ?? d.text ?? '（无详情）'}`);
  return r.result?.value;
}

export const KEY_MAP: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 }, Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Space: { key: ' ', code: 'Space', vk: 32 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

/**
 * CDP 的 NodeId 从 1 起，**0 不是合法值**。查询返回 0 意味着"引用了未登记的节点"
 * （上面 queryXPath 那条）。这里宁可直接报错，也不把 0 交回上层：
 * 交回去的话 resolve 会拿着它正常返回一个句柄，坏消息推迟到 click 时才出现，
 * 而那时的报错（"节点已失效"）指错了原因。
 */
function validNodes(ids: number[], how: string): number[] {
  const bad = ids.filter((n) => !Number.isInteger(n) || n <= 0);
  if (bad.length) {
    throw new Error(`CDP ${how} 查询返回了非法 nodeId（${bad.join(',')}）。`
      + '通常是 DOM 快照未登记就先查询 —— 这是查询层的问题，不是页面或定位器的问题');
  }
  return ids;
}

export async function createSession(opts: SessionOptions = {}): Promise<Session> {
  const ownedBrowser = !opts.browser;
  const browser = opts.browser ?? await launchBrowser({ bin: opts.bin, headless: opts.headless });
  const vp = {
    width: opts.viewport?.width ?? 1280, height: opts.viewport?.height ?? 720,
    deviceScaleFactor: opts.viewport?.deviceScaleFactor ?? 1,
  };
  const timeout = opts.actionTimeoutMs ?? 30_000;
  const dialogs: Array<{ type: string; message: string; accepted: boolean }> = [];
  const pageErrors: Array<{ kind: string; text: string }> = [];

  const fail = (what: string, err: unknown): never => {
    throw new Error(`${what}失败：${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: string }).message) : JSON.stringify(err)}`);
  };

  // disposeOnDetach：detach 之后 Chrome 自己回收 context。不依赖每条异常路径都记得
  // 调 disposeTarget —— 漏一条就是每 run 漏一个 context，症状是"跑到第 20 条用例变慢"
  const ctx = await browser.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true });
  if (!ctx.result?.browserContextId) fail('建 BrowserContext（隔离单位）', ctx.error);
  const contextId = ctx.result!.browserContextId;
  const tgt = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
  if (!tgt.result?.targetId) fail('建页面 target', tgt.error);
  const targetId = tgt.result!.targetId;
  const att = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  if (!att.result?.sessionId) fail('attach 页面', att.error);
  const sessionId = att.result!.sessionId;

  const send = <T,>(method: string, params: Record<string, unknown> = {}) =>
    browser.send<T & Record<string, never>>(method, params, sessionId)
      .then((r) => { if (r.error) fail(`CDP ${method}`, r.error); return r.result as T; });
  /** 与 send 同一件事，但**不抛**：阶梯要靠"这一级失败就试下一级" */
  const trySend = <T,>(method: string, params: Record<string, unknown> = {}) =>
    browser.send<T>(method, params, sessionId);

  let rootId: number | undefined;
  const navigateHandlers = new Set<() => void>();
  /*
   * 页面内请求的响应流（引擎的 wait{response} / expectResponse 靠它）。
   *
   * 缓冲逻辑（绝对下标 + 淘汰丢旧）在 response-buffer.ts，**那里有测试**：
   * 淘汰只在第 5001 条响应时发生，真浏览器测试到不了那个数，
   * 所以那两条不变量在浏览器层面是**抓不到**的（我做变异检查时确认过：
   * 把"丢最旧"改成"丢最新"、把下标改成跟着数组长度走，六条真浏览器测试全绿）。
   * 留在这里的只有**只有真浏览器能判**的那一条：`status <= 0` 不收。
   *
   * 收**全部**响应类型（Document/XHR/Fetch/Script/Image…），不按类型筛：
   * 与 Playwright 的 waitForResponse 同口径（它也不筛），而 pattern 是子串匹配，
   * 写 `/api/query` 的人本来就不会命中图片。按类型筛会引入
   * "我明明在 DevTools 里看到这个请求回来了，为什么等不到"这种新失真。
   */
  const responses = new ResponseBuffer();
  /** 由**本页**打开的新标签页计数（见 newPageCount 的注释：只有整数，不存 URL） */
  let newPages = 0;
  const offEvent = browser.onEvent((e: CdpEvent) => {
    /*
     * **target 事件必须在下面那句 sessionId 过滤之前处理。**
     * 不是风格问题：`Target.*` 是浏览器级的，实测 `e.sessionId` 是 **undefined**，
     * 所以放到过滤之后的话这里**一条都收不到** —— 而"收不到"的表现是
     * `expectNewPage` 永远判"没开新窗口"（假红），看起来像被测产品没弹窗。
     * "该在过滤前"这件事本身没有编译器管，所以写在这。
     */
    if (e.method === 'Target.targetCreated') {
      const info = (e.params as { targetInfo?: Record<string, unknown> } | undefined)?.targetInfo;
      // 三个条件缺一不可（每条都对应实测到的一种噪声，见 newPageCount 注释）：
      // 是新 target（不是 infoChanged）、是 page（不是 service_worker/扩展）、
      // 且**是本页打开的**（openerId 指向我们）。
      if (info?.type === 'page' && info.openerId === targetId) newPages++;
    }
    if (e.sessionId !== sessionId) return;
    if (e.method === 'Page.javascriptDialogOpening') {
      // 默认接受**并记录**。不注册 handler 的话 Chrome 会一直等一个不会来的响应，
      // 整个 renderer 挂住，症状是"用例卡死、日志里什么都没有"（docs/06 §1）
      const p = e.params as { type?: string; message?: string } | undefined;
      dialogs.push({ type: String(p?.type ?? 'unknown'), message: String(p?.message ?? ''), accepted: true });
      void trySend('Page.handleJavaScriptDialog', { accept: true, promptText: '' }).catch(() => {});
    }
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> } | undefined;
      if (p?.type === 'error') {
        pageErrors.push({ kind: 'console', text: (p.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' ') });
      }
    }
    if (e.method === 'Runtime.exceptionThrown') {
      const d = (e.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined)?.exceptionDetails;
      pageErrors.push({ kind: 'exception', text: String(d?.exception?.description ?? d?.text ?? '') });
    }
    if (e.method === 'Page.frameNavigated') { rootId = undefined; navigateHandlers.forEach((f) => f()); }
    if (e.method === 'Network.responseReceived') {
      /*
       * 只收**已经有确定状态码**的那一条。CDP 在这一步之前会先发
       * `Network.requestWillBeSent`（那时还没有响应），而 -1 不是任何接口给的答案：
       * 收进来会让 `status: [200]` 这类筛选永远对不上，
       * 而 `wait{response}`（不筛状态）会**提前**判"接口回来了" —— 那时响应头都没到。
       */
      const p = e.params as { response?: { url?: string; status?: number } } | undefined;
      const url = p?.response?.url;
      const status = p?.response?.status;
      // status 缺失/为 0 一律不收：0 是 CDP 给"尚未收到响应头/被阻断"的占位值，
      // 把它当"接口回来了"是 fail-open 方向（等待满足 = 绿），最危险的那个方向。
      if (typeof url !== 'string' || typeof status !== 'number' || status <= 0) return;
      responses.push(url, status);
    }
  });

  await send('Page.enable'); await send('Runtime.enable');
  await send('DOM.enable'); await send('Network.enable');
  /*
   * 开 target 发现，否则**一个 target 事件都收不到**（实测：不开时点
   * `<a target=_blank>`、`window.open()`、`window.open(u,'_blank')` 三种写法，
   * 新增事件数都是 **0**）。这是浏览器级的调用，所以走 `browser.send` 而不是
   * 本会话的 `send`（后者会带上 sessionId，而 discovery 是全局开关）。
   *
   * **失败时把能力关掉而不是留个恒 0 的计数器**：
   * `newPageObserves` 为 false 的话 adapter 不挂 `newPage` 端口，
   * 引擎于是报 env-unavailable（"去查平台"）。
   * 如果反过来让它恒 0，`expectNewPage` 会等满超时然后判 fail + product-bug
   * —— 把"我们看不见窗口事件"说成"被测产品没弹窗"，正是本仓反复在防的那种错归因。
   */
  const discovery = await browser.send('Target.setDiscoverTargets', { discover: true });
  const newPageObserves = !discovery.error;
  await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor, mobile: false });
  // locale / tz 覆盖失败只记不抛：值不被 Chrome 认时让整个 adapter 起不来，
  // 比"这一项没生效"更糟，而且报错里根本看不出是它
  if (opts.locale) await send('Emulation.setLocaleOverride', { locale: opts.locale }).catch(() => {});
  if (opts.timezoneId) await send('Emulation.setTimezoneOverride', { timezoneId: opts.timezoneId }).catch(() => {});

  async function root(): Promise<number> {
    if (rootId !== undefined) return rootId;
    // pierce:true 让 shadow DOM 进树。不带的话 Web Components 里的元素**一个都查不到**，
    // 而阶梯会安静降级到手写 css —— 又是"看起来能用"
    const r = await send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1, pierce: true });
    rootId = r.root.nodeId;
    return rootId;
  }

  async function queryCss(selector: string): Promise<number[]> {
    const r = await trySend<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: await root(), selector });
    if (r.error) throw new Error(`CSS 选择器不合法：${selector}（${r.error.message}）`);
    return validNodes(r.result?.nodeIds ?? [], 'css');
  }

  async function queryXPath(query: string): Promise<number[]> {
    /*
     * **必须先 getDocument**（真浏览器测出来的）。原先这里不调 root()，
     * 于是"会话里第一个查询是 XPath"时（text/role+name/label 定位法都是 XPath）
     * DOM.performSearch 返回的 nodeId 是 **0** —— 它引用的是 DOM agent 还没登记的节点。
     * 后果分两段，都很难查：
     *  - resolve() 拿着 0 号句柄**正常返回**了（阶梯只看命中数），于是
     *    StepResult 里写着 "text 定位成功"，而那个句柄指向不存在的东西；
     *  - 到 click 时才炸，报的是"节点已失效"—— 一句把根因（查询层没登记节点）
     *    说成"中途导航了，重试就好"的假诊断。
     * 只调一次 getDocument 就登记好了；queryCss 本来就在调，所以走 testid 的用例
     * 一直是对的 —— **两条代码路径只有一条有这一步**，正是那类"下半截没人接"。
     */
    await root();
    const s = await trySend<{ searchId: string; resultCount: number }>('DOM.performSearch', { query, includeShadowDOM: true });
    if (s.error || !s.result?.searchId) throw new Error(`XPath 查询失败：${query}（${s.error?.message ?? '无 searchId'}）`);
    try {
      if (s.result.resultCount === 0) return [];
      const r = await trySend<{ nodeIds: number[] }>('DOM.getSearchResults', { searchId: s.result.searchId, fromIndex: 0, toIndex: s.result.resultCount });
      return validNodes(r.result?.nodeIds ?? [], 'xpath');
    } finally {
      // 不 discard 就是每查一次在 browser 进程里留一个结果集。
      // 单独 catch：收尾失败不该把已经拿到的结果判成查询失败
      await trySend('DOM.discardSearchResults', { searchId: s.result.searchId }).catch(() => {});
    }
  }

  async function callOn<T>(nodeId: number, fn: string, args: unknown[] = []): Promise<T | undefined> {
    const node = await trySend<{ object: { objectId?: string } }>('DOM.resolveNode', { nodeId });
    if (node.error || !node.result?.object?.objectId) return undefined;
    const r = await trySend<EvalOut<T>>('Runtime.callFunctionOn', {
      objectId: node.result.object.objectId, functionDeclaration: fn, declaration: false, returnByValue: true,
      // 值走 arguments，不进表达式 —— 见文件头第 2 条
      arguments: args.map((v) => ({ value: v as never })),
    });
    if (r.error) throw new Error(`页面内求值失败：${r.error.message}`);
    // 同样过 evalValue：写死的那几个函数里 getBoundingClientRect 之类也可能抛
    // （节点已从文档上摘掉时），吞成 undefined 的话表现是"可交互性检查无法执行"，
    // 而真正的原因是元素被移除了 —— 两条报错指向的处置完全不同
    return evalValue<T>(r.result as EvalOut<T>);
  }

  async function screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
    const r = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: vp.deviceScaleFactor } } : {}) });
    return Uint8Array.from(Buffer.from(r.data, 'base64'));
  }

  async function waitLoaded(waitUntil: 'load' | 'dom' | 'idle', url: string): Promise<void> {
    const t0 = Date.now();
    // **不用 networkIdle**（docs/06 §3：有轮询/长连接的页面永远不空闲，flake 制造机）。
    // 'idle' 实现为"body 规模连续两次采样不变"：有界、确定性，长轮询页也能收敛。
    // 它不等价于"所有接口都回来了" —— 那要靠 expectResponse，别拿这个冒充。
    const readState = async (): Promise<string> =>
      evalValue<string>(await send<EvalOut<string>>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })) ?? 'loading';
    for (;;) {
      const v = await readState();
      if (v === 'complete' || (waitUntil === 'dom' && v !== 'loading')) break;
      if (Date.now() - t0 > timeout) throw new Error(`等页面加载超时 ${timeout}ms：${url}（readyState=${v}）`);
      await new Promise((r) => setTimeout(r, 50));
    }
    if (waitUntil === 'idle') {
      let prev = '';
      for (let i = 0; i < 20; i++) {
        const size = String(evalValue<number>(await send<EvalOut<number>>('Runtime.evaluate', { expression: 'document.body ? document.body.innerHTML.length : 0', returnByValue: true })) ?? 0);
        if (prev !== '' && size === prev) return;
        prev = size;
        await new Promise((r2) => setTimeout(r2, 100));
        if (Date.now() - t0 > timeout) return; // 稳不下来的页面到此为止，**不无限等**
      }
    }
  }

  return {
    browser, ownedBrowser, sessionId, targetId, viewport: vp, dialogs, pageErrors,
    send, call: send,
    query: (loc) => (loc.strategy === 'css' ? queryCss(loc.selector) : queryXPath(loc.selector)),
    callOn,
    box: async (n) => {
      const b = await callOn<{ x: number; y: number; w: number; h: number }>(n, FN.box);
      if (!b) throw new Error('拿不到元素位置（节点可能已被导航替换）');
      return b;
    },
    text: async (n) => (await callOn<string>(n, FN.text)) ?? '',
    aria: async () => {
      const r = await send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {});
      return { text: renderAria(r.nodes ?? []), nodes: r.nodes ?? [] };
    },
    pageText: async () => evalValue<string>(await send<EvalOut<string>>('Runtime.evaluate', {
      expression: "document.body ? (document.body.innerText ?? document.body.textContent ?? '').replace(/\\s+/g,' ').trim() : ''",
      returnByValue: true,
    })) ?? '',
    evalPage: async <T,>(expression: string) =>
      evalValue<T>(await send<EvalOut<T>>('Runtime.evaluate', { expression, returnByValue: true })),
    url: async () => evalValue<string>(await send<EvalOut<string>>('Runtime.evaluate', { expression: 'location.href', returnByValue: true })) ?? '',
    screenshot, waitLoaded,
    responsesSince: async (s) => responses.since(s),
    newPageCount: () => newPages,
    newPageObserves,
    onNavigate: (fn) => { navigateHandlers.add(fn); },
    close: async () => {
      offEvent();
      // 只 detach 自己的 target/context；共享来的 browser 进程**不能关**
      // （关了会把同机另外 19 个在跑的用例一起带走）
      await trySend('Page.disable').catch(() => {});
      await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      await browser.send('Target.disposeTarget', { targetId }).catch(() => {});
      await browser.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
      if (ownedBrowser) await browser.close();
    },
  };

  /**
   * ARIA 快照渲染成 `[ref=eN]` 那套文本（docs/06 §2）。
   * getFullAXTree 给的是**扁平表 + childIds**，按数组顺序输出会丢层级 ——
   * 于是"合计在表格里"与"合计在弹窗里"在模型眼里长得一样。
   */
  function renderAria(nodes: AxNode[]): string {
    const byId = new Map<string, AxNode>();
    for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n);
    const lines: string[] = [];
    let seq = 0;
    const seen = new Set<string>();
    const walk = (n: AxNode, d: number): void => {
      if (n.nodeId) { if (seen.has(n.nodeId)) return; seen.add(n.nodeId); }
      const role = n.role?.value;
      const name = n.name?.value;
      const shown = !n.ignored && !!role && role !== 'none';
      // generic/none 不占行但**仍下钻**（它们只是没有语义，孩子里有可能有），
      // 且不加深缩进 —— 否则一层 <div> 就把层级整体推歪，diff 会全是缩进噪声
      if (shown) lines.push(`${'  '.repeat(d)}- ${role}${name ? ` "${name}"` : ''} [ref=e${++seq}]`);
      const nd = shown ? d + 1 : d;
      for (const c of n.childIds ?? []) { const cn = byId.get(c); if (cn) walk(cn, nd); }
    };
    // 森林（跨 frame 的 AX 树会挂在同一个响应里）：只走第一棵树会让别的 frame
    // **整块消失**，而快照看起来是完整的
    const roots = nodes.filter((n) => n.parentId === undefined);
    for (const r of roots.length ? roots : nodes.slice(0, 1)) walk(r, 0);
    return lines.join('\n');
  }
}
