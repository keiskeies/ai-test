/**
 * UiExec 端口实现（docs/04 M3、docs/06 §2/§4）。机制都在 session.ts，这里只做
 * "把 IR 的意图变成机制调用 + 把结果归因成引擎要的形状"。
 *
 * 四个方法各自那个"会假装成功"的位置：
 *
 *  1. **resolve 命中多个**。静默取第一个 = "每行都 0.97 分时点了隔壁行"（docs/00 §8）。
 *     这里默认**严格**：命中数 ≠ 1 不算命中，继续走阶梯，耗尽则报错并带出每级的结果。
 *     要选第 n 个必须在 IR 里写 `index: n` —— 那是作者显式声明的消歧，
 *     与"我替你猜第一个"是两件事。（locator.ts 拒实现 nth 也是同一条理由。）
 *  2. **可交互性**。visible ≠ 可点（docs/06 §2）。点击前用 `elementFromPoint(中心)`
 *     验一次，被遮罩/sticky header 盖住时**立刻报错**，不干等 30s 超时
 *     （干等的症状是把"被遮住"误导成"元素还没出现"）。
 *  3. **capture 的证据归属**。`ctx.saveArtifact(kind, data, stepId)` 要 stepId，
 *     而 `ctx.stepId` 是引擎在调用那一刻填的。**留空时宁可报错也不自己编** ——
 *     编出来的 id 会进 artifact.saved 与 StepResult.artifactIds，
 *     于是证据包把 A 步的截图记在 B 步名下。
 *  4. **断言做不了就报错，不用更弱的匹配器冒充**。`ariaYaml` 需要 YAML 解析
 *     （npm registry 不可达，没有 yaml 依赖）：拿"整段文本 includes"冒充它，
 *     症状是"ARIA 结构断言"在缩进/层级全错的情况下也报绿。
 */
import { createHash } from 'node:crypto';

import type { ExecContext, ObservedResponse, PerformResult, UiExec } from '@atest/engine';
import type { LocatorSpec, Operation, UiAssertPayload } from '@atest/ir';

import { BadLocator, UnsupportedLocator, confidenceOf, ladder, rungOf, translate, xpathStr } from './locator.js';
import { FN, KEY_MAP, createSession, type Session } from './session.js';

export interface WebAdapterOptions {
  bin?: string;
  /** 复用已起的浏览器进程。**传进来就不由本 adapter 关**（关了会带走同机其他在跑的用例） */
  browser?: Session['browser'];
  testidAttr?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  locale?: string;
  timezoneId?: string;
  headless?: boolean;
  actionTimeoutMs?: number;
}

export interface WebAdapter {
  readonly ui: UiExec;
  readonly dialogs: Session['dialogs'];
  readonly pageErrors: Session['pageErrors'];
  readonly meta: { viewport: Session['viewport']; locale?: string; timezoneId?: string };
  /**
   * 页面内请求的响应流（透传 Session 的同名方法，语义见那边：
   * **绝对下标、只增不减**，供引擎的 `wait{response}` / `expectResponse` 开窗）。
   *
   * 挂在 adapter 上而不是挂在 UiExec 端口上，与 `eval` 同一条理由：
   * 端口是引擎唯一能看见的东西，而"取一批响应"这件事**不该被步骤层直接调** ——
   * 引擎侧唯一的入口是 wait 条件与 expectResponse 那两处（共用同一个匹配判据）。
   * 挂进端口的话，下一个加 UI 动作的人会顺手拿它自己判命中，
   * 于是"什么算命中"就有了第二份实现（本仓那一族）。
   */
  responsesSince(s: number): Promise<ObservedResponse[]>;
  /**
   * 在被测页里求值。端口（UiExec）上**刻意没有**这一项：
   * IR 里唯一像"执行代码"的步骤是 `script`，而引擎直接拒掉它
   * （interpreter.ts:917「沙箱未实现；它会绕过静态闸」）。
   * 如果 UiExec 上挂一个 eval，引擎就能把 script 步骤接上来 ——
   * 那等于 adapter 提供了一条让"沙箱未实现"这句判断作废的旁路，
   * 而静态闸从此管不到页面里跑了什么。所以它只挂在 adapter 上，**不在端口上**。
   *
   * 现在需要它的只有两方，且都在"建会话"而不是"跑用例"这一侧：
   * 夹具造 cookie/localStorage，以及将来 docs/06 §5 的登录态抓取。
   */
  eval(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

/** 定位句柄。resolve 与 perform 是两次调用，中间可能导航 —— 所以要能识别句柄已失效 */
interface Handle {
  nodeId: number;
  selector: string;
  by: string;
  rung: number;
  confidence: number;
  occurrences: number;
}

/** 阶梯走完仍没命中。带出每一级试过的查询与结果，否则人只能盲改定位器 */
class LocatorMiss extends Error {
  constructor(msg: string) { super(msg); this.name = 'LocatorMiss'; }
}
/** 这一档 Web 端没实现。**报错而不是用一个更弱的匹配器**（见文件头第 4 条） */
class UnsupportedAssert extends Error {
  constructor(kind: string, hint: string) { super(`Web 端不支持断言 "${kind}"：${hint}`); this.name = 'UnsupportedAssert'; }
}

export async function createWebAdapter(opts: WebAdapterOptions = {}): Promise<WebAdapter> {
  const s = await createSession(opts);
  const handles = new Map<string, Handle>();
  let seq = 0;
  // 导航后旧 nodeId 可能指向另一个元素，**清空而不是装作还能用**
  s.onNavigate(() => handles.clear());

  const expect = async (h: Handle): Promise<void> => {
    const r = await s.callOn<{ ok: boolean; why?: string; by?: string }>(h.nodeId, FN.hitTest);
    if (!r) throw new Error(`可交互性检查无法执行（节点已失效，需重新定位）：${h.by} ${h.selector}`);
    if (r.ok) return;
    const why = r.why === 'occluded' ? `被 ${r.by ?? '另一个元素'} 遮住`
      : r.why === 'offscreen' ? '中心点在视口外'
        : r.why === 'zero-size' ? '尺寸为 0（常见于被折叠、或虚拟滚动只渲染了壳）'
          : (r.why ?? '未知');
    throw new Error(`元素不可交互：${why}。定位=${h.by} ${h.selector}`);
  };

  const ui: UiExec = {
    async resolve(locator: unknown, _ctx: ExecContext) {
      const spec = locator as LocatorSpec;
      const steps = ladder(spec.primary, spec.fallbacks ?? []);
      if (!steps.length) throw new BadLocator('定位器没有任何可执行的规则（primary 与 fallbacks 都空）');
      const tried: string[] = [];
      for (const rule of steps) {
        if (rule.scope && rule.scope !== 'page') {
          // 跨 frame 还没做。**报错而不是在 page 文档里照查**：在错误的文档里查
          // 一个 frame 元素只会 miss，然后阶梯安静降级到手写 css —— 假能用
          tried.push(`${rule.by}: scope=${rule.scope} 未实现`);
          continue;
        }
        let located;
        try { located = translate(rule, opts.testidAttr ?? 'data-testid'); }
        catch (e) {
          if (e instanceof UnsupportedLocator) { tried.push(`${rule.by}: ${e.message}`); continue; }
          throw e; // BadLocator 是写错了，试下一级只会把配置错误伪装成"没找到"
        }
        let nodes: number[];
        try { nodes = await s.query(located); }
        catch (e) { tried.push(`${rule.by} ${located.selector}：${(e as Error).message}`); continue; }
        const want = rule.index ?? 0;
        if (nodes.length === 0) { tried.push(`${rule.by} ${located.selector}：0 命中`); continue; }
        if (rule.index === undefined && nodes.length > 1) {
          tried.push(`${rule.by} ${located.selector}：${nodes.length} 命中（非唯一，要在 IR 里写 index）`);
          continue;
        }
        if (nodes.length <= want) { tried.push(`${rule.by} ${located.selector}：index=${want} 越界（共 ${nodes.length} 个）`); continue; }
        const nodeId = nodes[want]!;
        const h: Handle = { nodeId, selector: located.selector, by: rule.by, rung: rungOf(rule.by), confidence: confidenceOf(rule.by), occurrences: nodes.length };
        const id = `h${++seq}`;
        handles.set(id, h);
        // nonReplayable 恒 false：能走到这里说明用的是**查询**而不是坐标，
        // 查询在任何一次运行里都会重新求值（纯坐标才是不可回放的，docs/10 §5）
        return { resolvedBy: rule.by, rung: h.rung, confidence: h.confidence, nonReplayable: false, handle: id };
      }
      throw new LocatorMiss(`定位失败：阶梯 ${steps.length} 级都没拿到唯一元素。试过：${tried.join('；')}`);
    },

    async perform(op: unknown, target: unknown, ctx: ExecContext) {
      const o = op as Operation & { op: string; value?: unknown; url?: string; waitUntil?: 'load' | 'dom' | 'idle'; key?: string; dir?: string; amount?: number };
      const h = (t: unknown): Handle => {
        const id = (t as { handle?: string } | null)?.handle;
        if (!id) throw new Error(`动作 ${o.op} 缺少定位句柄（resolve 没返回 handle）`);
        const found = handles.get(id);
        if (!found) throw new Error(`定位句柄已失效（中途发生过导航），需重新定位：${id}`);
        return found;
      };
      switch (o.op) {
        case 'navigate': {
          const url = String(o.url ?? '');
          /*
           * **协议白名单，正向匹配**。这里不照抄 http 那一层的 SSRF allowlist
           * （那是引擎与 http adapter 的纪律，抄一份就是两份会漂移的清单），
           * 但导航有**执行**语义：`javascript:` 会在那段 JS 里跑起来，
           * `data:` 能造出一个带任意脚本的文档。所以只放 http/https，
           * 其余一律拒 —— 用黑名单的话，`view-source:`、`blob:` 这类会一个一个漏。
           */
          if (!/^https?:\/\//i.test(url)) {
            throw new Error(`navigate 只接受 http(s) 地址，收到 "${url.slice(0, 40)}"。`
              + '（javascript:/data: 是执行语义不是导航语义；文件与其他协议未开放）');
          }
          // 用 s.call 而不是裸 send：send 刻意不抛（阶梯要能试下一级），
          // 而导航失败**必须**打断这一步 —— 不然 waitLoaded 会去等一个没在导航的页面，
          // 症状是"about:blank 加载完了，用例继续往下跑"，那是一条假绿链路
          await s.call('Page.navigate', { url });
          await s.waitLoaded(o.waitUntil ?? 'load', url);
          return;
        }
        case 'click': {
          const hh = h(target);
          await expect(hh);
          const b = await s.box(hh.nodeId);
          const x = b.x + b.w / 2, y = b.y + b.h / 2;
          // 真鼠标序列，不用 element.click()：后者绕过 hover/pointerdown 与事件委托，
          // 被测前端的下拉、拖拽手柄、埋点那些逻辑压根不跑 —— 绿得没有意义
          await s.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await s.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
          await s.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          return;
        }
        case 'fill': {
          const hh = h(target);
          await expect(hh);
          const enabled = await s.callOn<boolean>(hh.nodeId, FN.enabled);
          if (enabled === false) throw new Error(`元素是 disabled/readonly，不能输入。定位=${hh.by} ${hh.selector}`);
          const value = String(o.value ?? '');
          const focused = await s.callOn<boolean>(hh.nodeId, FN.focus);
          if (!focused) throw new Error(`无法聚焦元素，不能输入（打到别处会得到"填进去了"的假结论）。定位=${hh.by} ${hh.selector}`);
          // clearFirst（IR 默认 true）：先 JS 清空，再走真实输入路径。
          // 只 insertText = 追加；只 JS 赋值 = 被测前端收不到逐字符 input，
          // 依赖 input 事件做校验/联想的组件就测不到
          await s.callOn(hh.nodeId, FN.setValue, ['']);
          if (value) {
            // Input.insertText 走文本插入路径，中文与 emoji 都能进；
            // 逐字符 dispatchKeyEvent 在中文上会丢字（与 docs/07 的 ADB-IME 同一个坑）
            await s.call('Input.insertText', { text: value });
          }
          return;
        }
        case 'select': {
          const hh = h(target);
          const got = await s.callOn<string>(hh.nodeId, FN.selectValue, [String(o.value ?? '')]);
          // 赋值后回读比对：option 里没这个值时 .value 会变成空串，
          // 不比对就是"选了一个不存在的选项"然后报绿
          if (String(o.value ?? '') !== '' && got !== String(o.value)) {
            throw new Error(`select 赋值后回读不一致（值 "${o.value}" 不在选项里？）：实际 "${got}"。定位=${hh.by} ${hh.selector}`);
          }
          return;
        }
        case 'press': {
          const key = String(o.key ?? '');
          const k = KEY_MAP[key];
          if (!k) throw new Error(`未收录的按键 "${key}"。已知：${Object.keys(KEY_MAP).join(' / ')}`);
          await s.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
          await s.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
          return;
        }
        case 'hover': {
          const hh = h(target);
          const b = await s.box(hh.nodeId);
          await s.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + b.w / 2, y: b.y + b.h / 2 });
          return;
        }
        case 'scroll': {
          // scroll 是页面级动作，不依赖定位器（IR 里 act 的 locator 必填，
          // 但 scroll 的语义是"把页面滚动"，所以故意不读 target）
          const dir = o.dir ?? 'down';
          const amount = o.amount ?? 400;
          const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
          const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
          await s.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.viewport.width / 2, y: s.viewport.height / 2 });
          await s.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.viewport.width / 2, y: s.viewport.height / 2, deltaX: dx, deltaY: dy });
          return;
        }
        case 'snapshot': {
          // capture 步骤走这里。**证据归属见文件头第 3 条**：
          // stepId 缺失时报错，不自己编一个
          const stepId = ctx.stepId;
          if (!stepId) {
            throw new Error('截图需要步骤坐标（ctx.stepId），引擎没给。'
              + '这里不自己编 id：编出来的 id 会进 artifact.saved 与 StepResult.artifactIds，'
              + '证据包就会把这一步的截图记到别的步骤名下');
          }
          const shot = await s.screenshot();
          const id = await ctx.saveArtifact('screenshot', shot, stepId);
          /*
           * **这里原本还自己 emit 了一条 artifact.saved，删掉了。**
           * 引擎的 ctxBase.saveArtifact 内部已经发过一条（interpreter.ts:237），
           * 而它带的是 `data.id`；我那条写的是 `data.artifactId`。
           * 后果不是"多一条日志"：evidence.ts 的兜底枚举读的是 `data.id`，
           * 所以我那条**永远不会被读到** —— 它看起来在做证据归属，实际什么都没做，
           * 而真正的归属靠引擎那条兜住了。写侧发一种字段名、读侧认另一种，
           * 坏数据永远到不了写它的人眼前（与 EmitInput.kind 那个注释记的是同一件事）。
           */
          // 把 id 带回给引擎（PerformResult.artifactIds）。
          // **不带回的话证据包会把这个截图标成 `未归属:shot`** —— 那是兜底给
          // "忘了带 id 的 adapter"用的标签，正常路径不该长期住在兜底里。
          return { artifactIds: [id] };
        }
        default:
          throw new Error(`Web 端不支持动作 "${o.op}"`);
      }
    },

    async snapshot(ctx: ExecContext) {
      const { text } = await s.aria();
      // sha 用**引擎看到的同一份文本**算：uiIdle 条件比较的就是这两个 sha
      // （wait.ts 的 uiIdle：连续两次快照 sha 相同才算静默）。
      // 拿另一份字节算会出现"页面上还在变、sha 却相等"
      void ctx;
      return { kind: 'aria', data: text, sha: createHash('sha256').update(text, 'utf8').digest('hex') };
    },

    async assertUi(payload: unknown, _ctx: ExecContext) {
      const p = payload as UiAssertPayload;
      const failWith = (actual: unknown): { passed: boolean; actual: unknown; expected: unknown } =>
        ({ passed: false, actual, expected: p.expected ?? p.contains ?? p.ariaYaml ?? null });
      const wantText = (): unknown => p.contains ?? p.expected;
      switch (p.assertKind) {
        case 'url': {
          const url = await s.url();
          const want = String(wantText() ?? '');
          // 子串匹配而不是全等：真实 URL 带 query/hash，要求全等等于让人把 token 写进用例
          return url.includes(want) ? { passed: true, actual: url, expected: want } : failWith(url);
        }
        case 'title': {
          const title = (await s.evalPage<string>('document.title')) ?? '';
          const want = String(wantText() ?? '');
          return title.includes(want) ? { passed: true, actual: title, expected: want } : failWith(title);
        }
        case 'text': {
          const body = await s.pageText();
          const want = String(wantText() ?? '');
          return body.includes(want) ? { passed: true, actual: body.slice(0, 200), expected: want } : failWith(body.slice(0, 200));
        }
        case 'count': {
          // target 是**定位器 id 的引用**（IR 里是字符串），这里能拿到的是文本，
          // 所以按"页面文本里出现几次"计。**这不是元素计数** ——
          // 所以摘要里明说是文本计数，别让人以为它数的是节点
          const body = await s.pageText();
          const want = String(wantText() ?? '');
          const n = want ? body.split(want).length - 1 : 0;
          const exp = Number(p.expected ?? NaN);
          const ok = Number.isFinite(exp) ? n === exp : n > 0;
          return ok ? { passed: true, actual: n, expected: p.expected ?? '>0' } : failWith(n);
        }
        case 'visible':
        case 'absent': {
          /*
           * 这两档走的是**文本探针**，不是定位器解析。原因与 attribute 一样：
           * `UiAssertPayload.target` 是字符串（定位器 id 的引用），适配器拿不到 LocatorSpec，
           * 所以没法复用 resolve 那条阶梯。
           * 这不是"等价实现"，是**更弱的一档**：它回答的是"页面上有没有这段文字"，
           * 不是"那个元素可见吗"。所以命中的文本要出现在 actual 里，
           * 让人一眼看出判据是文本级的。**别把它当元素可见性断言用** ——
           * 一个 display:none 的元素里的文字，innerText 拿不到（这里因此不误报），
           * 但"文字在、元素被遮住"这种情况它会报"可见"（这里因此会误报）。
           * 真正要元素级判据，得等 IR 收 LocatorSpec。
           *
           * **absent 是负向断言**，判据写成"确实查不到"而不是"查询报错了"：
           * 查询语法错也必须是 error 往上抛，不能算"元素不存在" ——
           * 那等于把一个写错的定位器变成一条通过的负向断言。
           */
          const needle = String(p.target ?? p.contains ?? p.expected ?? '');
          if (!needle) throw new UnsupportedAssert(p.assertKind, '需要 target 或 contains 指明查什么');
          // 值过 xpathStr（同 locator.ts）：把 `'` 直接拼进 XPath 就能改写查询本身，
          // 而这里判的是**负向**断言 —— 查询被改写成命中 0 个时，
          // "元素不存在"会因此报绿。转义在这一档不是洁癖，是判据的一部分
          const hits = await s.query({ strategy: 'xpath', selector: `//*[contains(normalize-space(),${xpathStr(needle)})]` });
          const found = hits.length > 0;
          const passed = p.assertKind === 'absent' ? !found : found;
          return passed ? { passed: true, actual: `${hits.length} 命中`, expected: p.assertKind === 'absent' ? '0 命中' : '>0 命中' }
            : failWith(`${hits.length} 命中`);
        }
        case 'attribute': {
          /**
           * **明确不实现，而不是"读 location.href 判一下"**（我第一版就是这么写的，
           * 那是一个会把人骗过去的假断言：永远在比 URL，而作者以为在比某个元素的属性）。
           * 实现它需要 payload 带定位器，而 IR 的 `UiAssertPayload.target` 是**字符串**
           * （定位器 id 的引用），不是 LocatorSpec —— 适配器手里压根没有可执行的查询。
           * 真要做得先让 IR 在这一档收 LocatorSpec，那是 schema 改动，不在这里凑。
           */
          throw new UnsupportedAssert(p.assertKind,
            '需要目标元素的定位器，而 UiAssertPayload.target 是字符串引用（不是 LocatorSpec）——'
            + '适配器无从查询。要支持得先在 IR 侧给这一档收 LocatorSpec');
        }
        default:
          throw new UnsupportedAssert(p.assertKind, p.assertKind === 'ariaYaml'
            ? '需要 YAML 解析（无第三方依赖可装）。**不用"整段文本 includes"冒充**：'
              + '那样缩进与层级全错也能报绿，而 ARIA 结构断言的价值正在层级上'
            : '属于像素世界或其他端（templateHit/ocrValue/regionDiff 未实现）');
        }
    },
  };

  return {
    ui,
    dialogs: s.dialogs,
    pageErrors: s.pageErrors,
    meta: { viewport: s.viewport, ...(opts.locale ? { locale: opts.locale } : {}), ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}) },
    eval: (expression) => s.evalPage<unknown>(expression),
    responsesSince: (n) => s.responsesSince(n),
    close: () => s.close(),
  };
}
