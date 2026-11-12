/**
 * Cookie jar（docs/05 §2「会话」那一行的执行侧）。
 *
 * ## 为什么这一格以前是空的，而空着比没有更坏
 * `auth/apply.ts` 里从前写的是 `headers.cookie ?? i.cookieHeader`，等一个
 * `cookieHeader` 回调，而装配侧（`cli/src/wiring.ts`）**永远传 undefined**。
 * 于是"接口位已留"看起来像"这块快了"，实际是：`Set-Cookie` 在这一层
 * 被 {@link flattenHeaders} 按"重复头用逗号拼"的规则合并 —— 那是 RFC 7230 对
 * 一般头的规则，而 **RFC 6265 明文禁止合并 Set-Cookie**：cookie 自己的属性里
 * 就有分号与逗号（`Expires=Wed, 09 Jun 2031 10:18:14 GMT`）。
 * 实测一个响应三条 cookie 时交出去的是
 * `"sid=abc123; Path=/; HttpOnly, theme=dark; Path=/, JSESSIONID=xyz; … 10:18:14 GMT"`
 * —— 按逗号切会把一条 cookie 的属性劈成三段，按分号切会把三条并成一条。
 * **两种切法都能写出代码，两种都错**，所以这里不切字符串：
 * 走 `Headers.getSetCookie()` 拿原始数组（本仓 Node 上有；没有时**明说没 jar 可用**，
 * 不退回那个必然错的切法）。
 *
 * ## 归属：一次 run 一个 jar
 * 不是进程一个。`packages/server` 是常驻的，两个 job 共用一个 jar 意味着
 * **上一条用例登录的身份会带进下一条用例** —— 那是"看起来通过"的假绿里最难查的一种
 * （它甚至不是偶发，只要顺序不变就一直绿）。所以 jar 由 `assemble()` 建、
 * 跟着那一次 run 走，本模块自己不持有任何全局状态。
 *
 * ## 刻意不做的事
 *  - **不做 per-branch / per-identity 隔离**：`identity` 那套（docs/05 §2 的多身份行）
 *    本身还没有执行侧，先做一个按身份分桶的 jar 等于凭想象设计。今天的语义是
 *    "一次 run 一个浏览器会话"，`parallel` 的分支共用它（与共用一个后端道理相同），
 *    并且**有测试钉住这一点** —— 隐式共享比显式共享危险。
 *  - **不跟随重定向时补中间响应**：`followRedirects: true` 时 fetch 内部就跟完了，
 *    本层只看得见最后一个响应，中间的 `Set-Cookie` 拿不到。默认是不跟随
 *    （docs/05 §4「302 到登录页被判成功」那条假绿），所以这条路今天不通；
 *    真要用带 cookie 的重定向链，得先把重定向拿到自己手里做。已登记 docs/14 §5。
 *  - **不脱敏**：与 client.ts 同一纪律，脱敏在序列化到磁盘那一刻。
 *    但注意 jar 里的值**压根不出这一层**（只有拼出来的 `Cookie` 头进请求），
 *    所以它也就没有进 trace 的路径。
 */

/**
 * 一条已存 cookie。名字/值之外只留**发送时要用的**那几项属性。
 *
 * ⚠ **刻意没有 `httpOnly`**：那一位的语义是"页面上的 JS 读不到"，
 * 而这一层是网络层 —— 它本来就该把 cookie 发出去，标不标 HttpOnly 都一样。
 * 存一个没有任何判据读它的字段，正是 docs/08 §3 的 (a)「schema 有字段、执行侧没人读」，
 * 而它比没这个字段更坏：读代码的人会以为这里做了 XSS 相关的防护。
 * `secure` 留着的理由相反 —— `headerFor` 真的按它决定发不发。
 */
export interface StoredCookie {
  name: string;
  value: string;
  /**
   * 这条 cookie **属于**哪个域（已规范化：小写、去前导点）。
   * 有 `Domain` 属性时是那个值，没有时是设置它那个响应的**主机** —— 不是 undefined。
   * 为什么不能拿 undefined 表示 host-only：那样 host-only 这一档就没有可比对的域，
   * 而它是最常见的一档（理由与实测写在 `domainMatches` 头上）。
   */
  domain: string;
  /**
   * host-only 标志：真 = 只发给 `domain` 这一台主机，假 = 也发给它的子域。
   * 与 `domain` 是**两个正交的事实**（域是哪个 + 匹配多松），不是同一件事的两种写法，
   * 所以这里存两个字段而不是用 `domain === undefined` 挤出一个三态。
   */
  hostOnly: boolean;
  /** 路径前缀。缺省用「设置它那个 URL 的目录」，不是 `/`（RFC 6265 §5.1.4 那套默认值） */
  path: string;
  secure: boolean;
  /**
   * **插入序号**（不是时间戳，值是 `seq++`）：同名字段谁在前时用一次稳定回退。
   *
   * ⚠ 这里从前叫 `createdAt`，那名字**在说谎**：它压根不是时刻，是一个自增计数。
   * 而它撞上了 `ir/scenario.ts` 里 `ScenarioVersionMetaSchema.createdAt` 那个真时间戳 ——
   * 本仓那条「谁读过这个字段」的扫描器按**标识符**判读，于是我这个网络层的计数器
   * 被算成了"IR 那个版本时间戳有人读了"，把一条**本该继续挂着**的豁免就地注销
   * （`npm test` 里那条 baseline 测试实测报"豁免已过期"）。
   * 一个撞名的字段会让**别人的**结论变脏，这比名字不好听严重得多。
   */
  order: number;
  /** 绝对过期毫秒。`undefined` = 会话 cookie（本次 run 结束即失，本层的"结束"= jar 被丢弃） */
  expiresAt?: number;
}

export interface CookieAttr {
  name: string;
  value: string;
  /** 属性名统一小写，值原样（`path`/`domain` 的规范化在 jar 里做） */
  attrs: Record<string, string>;
  /** `true` = 有 `Max-Age`（按 RFC 它**覆盖** `Expires`，包括负数） */
  hasMaxAge: boolean;
}

/**
 * 解析一条 `Set-Cookie`。
 *
 * 只做"够用且不猜"的解析：第一段是 `name=value`，其后每段是一个属性。
 * **值里可能有等号**（base64 的 padding），所以只按**第一个**等号切；
 * 属性值里也可能有分号吗？不能 —— 有分号就是两条属性，RFC 不允许转义，
 * 所以按分号切是对的那一半，按逗号切是错的那一半（`Expires` 里有逗号）。
 *
 * 返回 `undefined` 而不是抛：一条畸形的 Set-Cookie（后端常有）不该让整次 run 炸，
 * RFC 6265 §5.2 也要求忽略而非报错。
 *
 * **已知边界**：带引号的值（`sid="a;b"`）会被当分号切成两段，于是这个值存进来是错的。
 * 那是刻意不做而不是漏做 —— 引号只出现在 cookie 值想装分隔符的时候，
 * 真实会话 cookie 不带引号，而这里每多实现一条边角规则，就多一处"看着像做全了"。
 * 已登记 docs/14 §5 的"没做"那一栏，而不是让这段注释假装它不存在。
 */
export function parseSetCookie(raw: string): CookieAttr | undefined {
  const parts = raw.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  const [nv, ...rest] = parts;
  if (!nv) return undefined;
  const eq = nv.indexOf('=');
  if (eq <= 0) return undefined; // 名字为空（`=v`）按 RFC 忽略
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  if (!name) return undefined;
  const attrs: Record<string, string> = {};
  let hasMaxAge = false;
  for (const a of rest) {
    const i = a.indexOf('=');
    const key = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : a.slice(i + 1).trim();
    if (!key) continue;
    if (key === 'max-age') hasMaxAge = true;
    // 同名属性重复出现时取**第一个**（RFC 6265 §5.2 对多个 Expires 就是这么规定的）
    if (!(key in attrs)) attrs[key] = val;
  }
  return { name, value, attrs, hasMaxAge };
}

/** 域规范化：小写、去前导点（老式 `.example.com` 写法）。**不**做 IP 特判之外的猜测 */
export function normalizeDomain(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const s = d.trim().toLowerCase().replace(/^\./, '');
  return s.length ? s : undefined;
}

/**
 * 域匹配（RFC 6265 §5.1.3）。
 *
 * `stored` **恒有值**，它是"这条 cookie 属于哪个域"：有 `Domain` 属性时是那个值，
 * 没有时是**设置它那个响应的主机**（host-only）。
 * 第二参数 `hostOnly` 选的是**匹配规则**，不是"有没有域"：
 * host-only 只接受完全相同的主机，Domain 型接受它自己与点边界后缀。
 *
 * ⚠ 这里从前写的是 `stored: string | undefined` 且 `undefined` 当 host-only 用，
 * 于是 host-only 那一档**压根没有可比对的域**，`if (!stored) return false`
 * 让每一条 host-only 的 cookie 都匹配不上自己的主机 —— 实测连
 * 「登录后第二个请求带上 sid」都不成立（jar 存了 1 条、`headerFor` 返回 undefined）。
 * **`domainMatches(undefined, 任何主机, true)` 返回 false 就是这个函数的形状不对**：
 * host-only 是**最常见**的那一档（后端绝大多数 Set-Cookie 不写 Domain），
 * 一个把最常见情况判成不匹配的守卫，比没有守卫更坏 —— 它让"没会话"这件事
 * 看起来像是"会话没匹配上，大概是路径或域的问题"。
 *
 * 判据松一档的后果是**跨域泄露会话**：`Domain=example.com` 存在之后
 * 对 `evil-example.com` 也放行，等于把 cookie 发给攻击者域名 ——
 * 所以后缀必须是**点边界**的后缀：`sub.example.com` 对，`notexample.com` 不对。
 */
export function domainMatches(stored: string, host: string, hostOnly: boolean): boolean {
  const s = stored.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!s || !h) return false;
  if (hostOnly) return h === s;
  return h === s || h.endsWith(`.${s}`);
}

/** 路径前缀匹配（RFC 6265 §5.1.4，简化版：不做 RFC 6265bis 的混合匹配） */
export function pathMatches(cookiePath: string, reqPath: string): boolean {
  if (cookiePath === reqPath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  // `/api` 不该匹配 `/apifoo`；但 `/api/` 与 `/api` 互为等价目录
  if (cookiePath === '/') return true;
  const cp = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
  return reqPath.startsWith(cp);
}

/** 从请求 URL 推 cookie 的默认 path（取到最后一个斜杠，`/` 兜底） */
export function defaultPath(reqPath: string): string {
  const p = reqPath || '/';
  if (!p.startsWith('/')) return '/';
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : p.slice(0, cut);
}

/** 解析后的过期时刻。返回 `'session'` 表示不设过期（会话 cookie） */
export function expiryOf(a: CookieAttr, now: number): number | 'session' {
  if (a.hasMaxAge) {
    const n = Number(a.attrs['max-age']);
    // Max-Age 是**相对**秒数，且它覆盖 Expires。负数/0 = 立刻过期（删除的正规写法）
    return Number.isFinite(n) ? now + n * 1000 : 'session';
  }
  const e = a.attrs['expires'];
  if (!e) return 'session';
  const t = Date.parse(e);
  // 解析不出来的 Expires 当"没有这个属性"处理（RFC：无效日期 → 忽略该属性）
  return Number.isNaN(t) ? 'session' : t;
}

export interface CookieJarOptions {
  /** 与引擎同一个时钟，测试里可冻住（不冻的话"过期"这类断言要 sleep 真实时间） */
  now: () => number;
}

/**
 * 一次 run 一个实例。**这里没有任何模块级状态** —— 有的话常驻服务就会串会话。
 */
export class CookieJar {
  /** 名字别叫 `store` —— 它与方法 `store()` 撞名，而 TS 会让它变成两个成员重名（本轮就撞过一次） */
  private readonly items: StoredCookie[] = [];
  private seq = 0;

  constructor(private readonly o: CookieJarOptions) {}

  /**
   * 快照。**只给测试与本地诊断，不许进 trace / 证据包** —— 里面的 value 就是会话凭证，
   * 而脱敏那一套按字段名与值形态走，cookie 值两个都不命中（`sid=abc123` 没有形态）。
   * 之所以留这一个口子而不是全靠"发一个请求看服务端收到什么"：
   * 要区分**没存下来**与**存了而没发**（域/路径/Secure 不匹配），
   * 只看服务端收到的头分不出这两种，而它们的修法完全不同。
   */
  dump(): StoredCookie[] { return [...this.items]; }

  /**
   * 吃进一个响应的 `Set-Cookie`。
   *
   * 覆盖规则按 (name, domain, path) 三元组，与浏览器一致。
   * 少任何一项都会得到"两个子域各有一条同名 cookie，发请求时两条都带"这种形状。
   */
  store(url: string, setCookies: readonly string[]): void {
    const u = safeUrl(url);
    if (!u) return; // 解析不出 URL：宁可不存，也不要把 cookie 存到一个匹配不上任何请求的名字下
    const origin = u.hostname.toLowerCase().replace(/\.$/, '');
    for (const raw of setCookies) {
      const a = parseSetCookie(raw);
      if (!a) continue;
      const dom = normalizeDomain(a.attrs['domain']);
      // 只有 Domain 属性存在时才是"域 cookie"；没写就是 host-only，归属这一台主机
      const hostOnly = dom === undefined;
      const domain = dom ?? origin;
      /*
       * **不能让别人把 cookie 塞到任意域名下。** 服务端回一条 `Domain=evil.org` 时
       * 如果照收，这个值就会在之后每次访问 evil.org 时被带上 ——
       * 那是"一个响应把会话投递给了无关主机"。RFC 6265 §5.2.3 的判据是
       * 请求主机必须能被这个 Domain 匹配到（同主机或点边界后缀），这里直接复用
       * `domainMatches` —— 复用而不是再写一遍，是为了让"存的时候松"与"发的时候松"
       * 永远是同一个判据，两份实现迟早分叉。
       *
       * ⚠ **这一挡是部分的，而知道它挡不住什么比假装它挡全了重要**：
       * 后缀匹配反过来用就是漏洞 —— 实测 `Domain=com` 对 `api.example.com` **匹配成立**
       * （每个 `*.com` 主机都是它的点边界后缀），`Domain=co.uk` 对 `shop.co.uk` 同理。
       * 浏览器靠**公域后缀表**（PSL）挡这一类，而那是几万条数据 + 一条要跟着更新的依赖，
       * 本仓离线、零运行时依赖，**装不上**。
       * 这里只落实**不需要表的那一半**：Domain 至少要含一个点，于是
       * `Domain=com` / `Domain=.com` / `Domain=cn` 这种"接管整条 TLD"的写法被挡在门外 ——
       * 这半条不是我自己加的规矩，RFC 6265 §5.2.3 对不含 `%x2E`（点）的 domain-value
       * 就是**直接忽略这条 cookie**。
       * **挡不住的**：`Domain=co.uk` 这类**两段的公域后缀**（本机测过：对 `shop.co.uk`
       * 匹配成立，于是它会把 cookie 分给所有 `*.co.uk`）。要堵全就得引 PSL，
       * 已登记 docs/14 §5「没做」那一栏（连理由一起）。
       * 不在这里塞一份手抄的二十条后缀清单 —— 半截的清单比没有清单更危险，
       * 它读起来像已经做完了。
       */
      if (dom && !domainMatches(dom, origin, false)) continue;
      if (dom && !dom.includes('.')) continue;
      const path = a.attrs['path']?.startsWith('/') ? a.attrs['path'] : defaultPath(u.pathname);
      const exp = expiryOf(a, this.o.now());
      // 覆盖规则按 (name, domain, hostOnly, path) 四元组。
      // hostOnly 也在里面是有意的：`Domain=example.com` 与 host-only 的两条 `sid`
      // 是**两条不同的 cookie**（浏览器就是这么分开存的），合成一条的话
      // 发往 sub.example.com 时会带上那条本该只发给 api.example.com 的值。
      const same = (c: StoredCookie): boolean =>
        c.name === a.name && c.domain === domain && c.hostOnly === hostOnly && c.path === path;
      // 先摘掉同名的旧值，再按"要不要存"决定
      for (let i = this.items.length - 1; i >= 0; i--) if (same(this.items[i]!)) this.items.splice(i, 1);
      const now = this.o.now();
      const expired = exp !== 'session' && exp <= now;
      // **删除的两种写法都要认**：`Max-Age=0` 与过去时刻的 `Expires`。
      // 只认前者会留下一条"服务端明确说作废了"的会话 cookie，
      // 而后端的语义是登出 —— 带着它继续跑，用例就在测一个已经不该存在的身份
      if (expired) continue;
      if (!a.value) continue; // 空值 = 删除（后端最常见的登出写法），上面已经摘掉了
      this.items.push({
        name: a.name,
        value: a.value,
        domain,
        hostOnly,
        path,
        secure: 'secure' in a.attrs,
        order: this.seq++,
        ...(exp === 'session' ? {} : { expiresAt: exp }),
      });
    }
  }

  /**
   * 这个请求该带哪些 cookie，拼成 `Cookie` 头的值。
   *
   * `existing` 是**已经在这个请求上写好的** `Cookie` 头（人在 IR 里显式写的，
   * 或 `apiKey in: cookie` 刚合进来的）。**同名的时候它赢** ——
   * 与 `applyAuth` 那条"不覆盖用户显式写的头"是同一判据：IR 里看得见的东西
   * 优先级高于运行时攒出来的状态，否则人会写一条"我明明指定了 sid 怎么被盖了"的用例。
   *
   * `Secure` 的 cookie 只在 https 下发（这条不能松：不松的话一次 http 请求
   * 就把会话明文送到网络上，而作者以为标了 Secure 就安全了）。
   *
   * ⚠ **`SameSite` 刻意不实现**，而这件事写在代码里而不是只写在 docs/14：
   * `docs/05` §2 那一行把 `Secure`/`SameSite`/域匹配三件事并列写着，只做两件
   * 就等于默默欠一项。SameSite 的语义是"**跨站发起**的请求带不带"，前提是存在
   * 一个"发起方的站点" —— 那要有 top-level 导航、`<img>`、XHR 才有这个东西。
   * 本层是脚本直连的 HTTP 客户端，每个请求都是用例作者自己发的，压根没有发起方站点；
   * 把它实现成"不发"会挡掉**作者明确要求发**的请求：把浏览器的一条安全策略
   * 套到一个没有该策略前提的宿主上，只会误伤，不会保护。
   * 真要测 SameSite 的行为（"跨站请求不该带上"）是浏览器端的事，载体在 web adapter。
   */
  headerFor(url: string, existing?: string): string | undefined {
    const explicit = (existing ?? '').trim();
    const u = safeUrl(url);
    if (!u) {
      /*
       * URL 解析不出来时，**已写好的 Cookie 头必须原样交回去**。
       *
       * 这里从前是 `if (!u) return undefined`，等于"URL 我不认识，那你手写的
       * `headers: {cookie: "sid=…"} `也不发了" —— 那是**静默丢掉人显式写的东西**。
       * 它和上面 `parseSetCookie` 对畸形 Set-Cookie 的"忽略"看着像，其实不是一回事：
       * 那一条处理的是**陌生服务端**给的坏数据，忽略是唯一安全的选择；
       * 这一条处理的是**用例作者写在 IR 里的**内容，弄丢它的后果是"我明明写了 cookie
       * 怎么没生效"，而报告里一点痕迹都没有。判据分开的地方就在这儿：
       * **对外来的坏数据宽容，对作者写好原样透传。**
       * 自定义 fetchImpl / 相对 URL / 将来的 unix socket 都会走到这一格，
       * 所以这不是理论分支 —— 有测试钉着它。
       */
      return explicit.length ? explicit : undefined;
    }
    const now = this.o.now();
    const parsedExplicit = parseCookieHeader(explicit);
    const host = u.hostname;
    const https = u.protocol === 'https:';
    const out: string[] = [];
    // 显式写的排在前面：它是人写来"就是要这个值"的
    for (const [k, v] of parsedExplicit) out.push(`${k}=${v}`);
    const seen = new Set(parsedExplicit.map(([k]) => k.toLowerCase()));
    const keep: StoredCookie[] = [];
    // 名字相同时按 RFC 是 path 长的在前；这里先按 path 长度降序、再按创建序，
    // 保证"更具体的那条先出现"，后端通常取第一个匹配值
    const sorted = [...this.items].sort((a, b) =>
      b.path.length - a.path.length || a.order - b.order);
    for (const c of sorted) {
      if (c.expiresAt !== undefined && c.expiresAt <= now) continue; // 顺手丢掉过期的
      keep.push(c);
      if (seen.has(c.name.toLowerCase())) continue;
      if (c.secure && !https) continue;
      if (!domainMatches(c.domain, host, c.hostOnly)) continue;
      if (!pathMatches(c.path, u.pathname || '/')) continue;
      seen.add(c.name.toLowerCase());
      out.push(`${c.name}=${c.value}`);
    }
    // 读的时候顺手清过期项：不然"过期"只发生在每次匹配时多算一遍，
    // 而 dump() 里能看到一堆早该没了的东西，查问题的人会以为它们还在发
    if (keep.length !== this.items.length) this.items.splice(0, this.items.length, ...keep);
    return out.length ? out.join('; ') : undefined;
  }
}

/** `Cookie: a=1; b=2` 拆成有序对。畸形段忽略，**不**去重（保留书写顺序给上面用） */
function parseCookieHeader(h: string | undefined): Array<[string, string]> {
  if (!h) return [];
  const out: Array<[string, string]> = [];
  for (const seg of h.split(';')) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    out.push([s.slice(0, i).trim(), s.slice(i + 1).trim()]);
  }
  return out;
}

/** URL 解析失败一律返回 undefined，由调用方决定"不存/不发"（不许在这里编一个默认主机） */
function safeUrl(url: string): URL | undefined {
  try { return new URL(url); } catch { return undefined; }
}

/**
 * 从一个响应里取 `Set-Cookie` 的**原始数组**。
 *
 * 这一格是整个特性里最容易写错的地方，而错法只有一种是"看起来能用"的：
 * 读 `headers['set-cookie']`。那个值是 {@link flattenHeaders} 用逗号拼出来的一整串
 * （多条 cookie + `Expires` 里的逗号混在一起），拆不回去。
 * 所以这里只走 `getSetCookie()` —— 它就是"每条一个元素"的那个 API，
 * 且是 fetch/undici 专门为此加的。
 *
 * **没有 `getSetCookie` 时返回空数组而不是退回拼串**：宁可比今天少存几条
 * （今天是一条都不存，所以是**不回退**而不是"退一档"），
 * 也不要把一个必然错的东西当兜底 —— 错着存下来的会话比没有会话危险，
 * 它会带着半条 cookie 命中后端的鉴权中间件，症状是"偶发 401"。
 */
export function setCookiesOf(h: Headers): string[] {
  const f = (h as { getSetCookie?: () => string[] }).getSetCookie;
  return typeof f === 'function' ? f.call(h) : [];
}
