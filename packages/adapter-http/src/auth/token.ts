/**
 * oauth2 clientCredentials 的 token 获取与缓存（docs/05 §2）。
 *
 * **只在 adapter 层**。engine 不知道 token 端点存在，也永远看不到 token 值 ——
 * `docs/03` §5 的理由：Agent 能读到 token 就能把它 echo 进生成的用例正文里提交上去。
 * token 缓存在**进程内存**里，不进变量空间、不进证据、不进 trace。
 *
 * 与 docs/05 §2 的一处偏离：那份文档写"缓存放 Redis 并带 TTL"。
 * Redis 是服务端化（P1）的事 —— 现在 CLI 是单进程，进程内 Map 就是全部需要的东西。
 * 但 **key 的构成按文档来**（env + clientId + scope 全参与），
 * 因为换 Redis 时 key 不能变：少了 scope 会让"只要 read 的调用"复用"要 read+write 的 token"，
 * 表现为偶发 403，且只在同一个 runner 先后跑过两种 scope 时出现 —— 最难查的那类。
 */
import { HttpClient } from '../http/client.js';
import type { CredentialBinding } from './credentials.js';

export interface TokenCacheEntry {
  accessToken: string;
  /** 绝对到期时刻（毫秒）。已经算好安全余量 */
  expiresAt: number;
  scope: string;
}

export interface TokenSourceOptions {
  /**
   * **不传 HttpClient，只传 fetchImpl** —— 这是刻意的。
   *
   * token 端点自己绝不能再走一遍鉴权拦截（会递归取 token 直到栈溢出，
   * 或给 token 请求带上业务 token 被 IdP 拒）。如果这里收一个 HttpClient 实例，
   * 调用方极可能把**已经挂了 onRequest 鉴权 hook 的那个**传进来，
   * 而"不能这么做"只写在注释里 —— 注释拦不住任何人。
   * 所以本类**自己 new 一个不带任何 hook 的 client**：结构上不可能递归。
   *
   * fetchImpl 必须透传：SSRF 防护（docs/11 §8）是把 fetch 换成带 allowlist 的实现，
   * 服务端形态下 token 端点同样要在 allowlist 内 —— 自建 client 若用裸 fetch
   * 就等于给 SSRF 开了一个绕过口子，而这是安全边界上最坏的那种漏法。
   */
  fetchImpl?: typeof fetch;
  /** token 端点的**绝对** URL（相对 spec 的情形由调用方拼好） */
  tokenUrl: string;
  /** 参与缓存 key。同一进程跑多环境时必须带上，否则 staging 的 token 会被 prod 复用 */
  environmentRef: string;
  resolveSecret: (ref: string) => string | undefined;
  /** 墙上或确定性时钟由调用方给，测试里用确定性时钟 */
  now: () => number;
  /**
   * 提前刷新窗口（毫秒）。默认 60_000，与 docs/05 §2 的 `expires_in - 60s` 一致。
   * 不留余量的后果：token 在用例跑到一半时过期，后半段全 401，
   * 而"重跑一次就好了"会把人引向"后端不稳定"。
   */
  refreshSkewMs?: number;
}

/** 取 token 失败。**消息里只有状态码与 error 枚举词，绝不含 client_secret 或 token** */
export class TokenError extends Error {
  constructor(message: string, public readonly status?: number, public readonly needsAuth?: boolean) {
    super(message);
    this.name = 'TokenError';
  }
}

export class TokenSource {
  private readonly cache = new Map<string, TokenCacheEntry>();
  /**
   * 正在进行中的请求，按缓存 key 合流。
   *
   * 没有它会这样：`parallel` 里 20 个步骤同时发现"没缓存"，20 次 token 请求打出去。
   * 多数 IdP 有并发限流，部分请求失败 → 部分步骤 401；
   * 更糟的是有些 IdP 每次签发**会吊销上一个 token**，并发签发等于互相踢下线 ——
   * 后者不报错，只让"偶发 401"与并发度相关，几乎查不出来。
   */
  private readonly inflight = new Map<string, Promise<string>>();
  /** 不带任何 hook 的专用 client。见 TokenSourceOptions.fetchImpl 的理由 */
  private readonly client: HttpClient;

  constructor(private readonly o: TokenSourceOptions) {
    this.client = new HttpClient({ fetchImpl: o.fetchImpl, defaultTimeoutMs: 15_000 });
  }

  /**
   * 拿一个有效 access token。
   *
   * client_id 与 client_secret 走**请求体**而不是 Basic 头：
   * RFC 6749 两种都允许，而 body 形态对"client_id 明文 + secret 是密钥"这个
   * 常见配置更自然，且不需要把两个值拼成一个字符串
   * （拼接结果同时含两个值，多一处要记着脱敏的地方）。
   */
  async accessToken(binding: CredentialBinding, scopes: readonly string[]): Promise<string> {
    const scope = scopes.join(' ');
    const key = cacheKey(this.o.environmentRef, binding.clientId ?? binding.secret, scope);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.o.now()) return hit.accessToken;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = this.fetch(key, binding, scope).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetch(key: string, binding: CredentialBinding, scope: string): Promise<string> {
    const clientId = binding.clientId;
    if (!clientId) {
      throw new TokenError(`oauth2 需要 client_id。在 env 的 auth 段里给它（client_id 不是密钥，可以明文写）；client_secret 走 ${binding.secret}`);
    }
    const clientSecret = this.o.resolveSecret(binding.secret);
    if (!clientSecret || clientSecret.startsWith('«')) {
      throw new TokenError(`oauth2 的 client_secret（${binding.secret}）解析不到值。设对应的环境变量再跑。`);
    }

    const form: Record<string, string> = {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    };
    if (scope) form.scope = scope;

    const res = await this.client.send({
      method: 'POST',
      url: this.o.tokenUrl,
      headers: { accept: 'application/json' },
      form,
      timeoutMs: 15_000,
      // token 响应很小，但不能因为小就假定是 JSON：IdP 返回 HTML 登录页
      // （被 WAF 拦了、URL 写错指到控制台）比想象的常见，见下面的解析
      maxBytes: 64 * 1024,
      // 不跟重定向：跟随 302 到登录页会把一个 HTML 当成"成功的 token 响应"，
      // 然后报"没有 access_token"，而真相是 URL 配错了
      followRedirects: false,
      // token 请求**一次都不重试**：某些 IdP 每次签发会吊销上一个 token，
      // 网络抖动后重试可能把刚拿到的有效 token 作废，把一次抖动变成永久失效
      retries: 0,
    });

    if (res.error) {
      // 不带 URL：URL 里可能带 client_id，而这条消息会进 CI 日志。
      // 环境名与错误种类足够定位。
      throw new TokenError(`取 oauth2 token 失败：${res.error.kind} — ${res.error.message}（token 端点在环境 ${this.o.environmentRef}）`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new TokenError(
        `取 oauth2 token 被拒（HTTP ${res.status}）。响应里的 error 是 ${describeErrorBody(res.body)}。`
        + ` client_id=${clientId}，环境=${this.o.environmentRef}，scope=${scope || '(未指定)'}`,
        res.status,
        res.status === 401 || res.status === 400,
      );
    }

    const body = (res.body ?? {}) as Record<string, unknown>;
    const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined;
    if (!accessToken) {
      // 只列键名，不 dump 值：这个响应**整体就是密钥**
      throw new TokenError(`token 响应里没有 access_token（返回的字段：${Object.keys(body).join('、') || '无'}）。`
        + ' 大概率是 token 端点 URL 指错了地方（返回了 HTML 或业务响应）');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
    const skew = this.o.refreshSkewMs ?? 60_000;
    // 没给 expires_in：按 5 分钟缓存。**不缓存到永久**是底线 ——
    // IdP 侧提前吊销 token 时，永久缓存会让这个进程永远 401 且只有重启才好
    const ttlMs = expiresIn !== undefined ? Math.max(expiresIn * 1000 - skew, 0) : 300_000;
    this.cache.set(key, { accessToken, expiresAt: this.o.now() + ttlMs, scope });
    return accessToken;
  }

  /** 全部缓存（给 auth-check 展示；只出 scope 与剩余秒数，**绝不出 token**） */
  stats(): Array<{ scope: string; expiresInSeconds: number }> {
    const out: Array<{ scope: string; expiresInSeconds: number }> = [];
    for (const e of this.cache.values()) {
      out.push({ scope: e.scope, expiresInSeconds: Math.max(0, Math.round((e.expiresAt - this.o.now()) / 1000)) });
    }
    return out;
  }

  /** 丢弃全部缓存。切换环境或 `atest auth-check` 强制重取时用 */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * 从错误响应里只取"能说的部分"。
 *
 * 直接把响应体拼进消息是不行的：OAuth 错误响应里常见 `error_description`
 * 会带上 client_id 甚至请求片段，而这条消息会进 CI 日志与 trace。
 * 所以只取 `error` 这个枚举词（invalid_client / invalid_scope / …），
 * 它有诊断价值且本身不含机密。
 */
function describeErrorBody(body: unknown): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === 'string') return `"${e.replace(/[^\w.-]/g, '_').slice(0, 60)}"`;
    if (e !== null && typeof e === 'object' && typeof (e as Record<string, unknown>).code === 'string') {
      return `"${String((e as Record<string, unknown>).code).replace(/[^\w.-]/g, '_').slice(0, 60)}"`;
    }
    return `（响应字段：${Object.keys(body as Record<string, unknown>).join('、') || '无'}）`;
  }
  // HTML 登录页之类。取前 60 个字符能区分"网关拦了"与"端点错了"，
  // 而这两件事的动作完全不同
  const s = typeof body === 'string' ? body : '';
  return s ? `非 JSON 响应，前 60 字符是 ${JSON.stringify(s.slice(0, 60))}` : '空响应';
}

/** 缓存 key。三个成分缺一不可，理由见文件头 */
export function cacheKey(environmentRef: string, clientIdOrRef: string, scope: string): string {
  return `${environmentRef}|${clientIdOrRef}|${scope.split(' ').sort().join(' ')}`;
}
