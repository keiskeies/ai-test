/**
 * 把鉴权方案应用到请求上（docs/05 §2）。
 *
 * **执行侧归 adapter，不归 engine。** 引擎原先自己写
 * `headers.authorization = 'Bearer ' + secret(ref)`，三个后果：
 *  1. 引擎认识了"方案"这件事（Bearer/basic/apiKey-in-query/cookie 是网关语义），
 *     而引擎要能在浏览器里跑只读校验，不该知道这些；
 *  2. apiKey 放 query/cookie 与 basic 压根写不出来（只有 Bearer 一条硬编码路）；
 *  3. **真值进了引擎内存** —— 于是它能通过任何一次 keyContext/summary 流到磁盘，
 *     而脱敏规则只按字段名与值形态补救，`?api_key=abc123` 这种值两个规则都不命中
 *     （值没有 JWT/AKIA/sk- 的形态，字段名在 URL 里不存在）。
 * 现在引擎只传**不透明引用**，值只在这一个文件里、发请求那一刻被取出来。
 */
import { lowerHeaders } from '../http/client.js';
import type { AuthScheme } from './scheme.js';
import type { CredentialBinding } from './credentials.js';

/** 凭证取不到时的错误。**消息里只有 ref，永远没有值**（docs/03 §5） */
export class MissingCredentialError extends Error {
  constructor(public readonly ref: string, hint: string) {
    super(`凭证 ${ref} 解析不到值。${hint}`);
    this.name = 'MissingCredentialError';
  }
}

/** 应用结果：改动后的 url + headers。返回新对象，不改入参（调用方还要拿原始请求做 schema 校验） */
export interface AppliedAuth {
  url: string;
  headers: Record<string, string>;
  /** 本次带上的凭证**值**。调用方用洗掉任何回显它的文本（见 scrubSecrets） */
  secretValues: string[];
  /** 人可读的"这次带了什么"，进 trace 用。**绝不能含值本身** */
  detail: string;
}

export interface ApplyInput {
  url: string;
  headers: Record<string, string>;
  scheme: AuthScheme;
  binding: CredentialBinding;
  /** 把 `secret:<ref>` 换成真值。只有 adapter 拿得到它 */
  resolveSecret: (ref: string) => string | undefined;
  /**
   * oauth2：取一个有效的 access token（内部自带缓存与过期刷新）。
   * **只在方案是 oauth2 时才会被调用** —— bearer/apiKey 场景压根不碰它，
   * 所以"配了 oauth2 但这次请求是公开接口"不会白跑一趟 token 端点。
   */
  accessToken?: (b: CredentialBinding, scopes: readonly string[]) => Promise<string>;
  /** 本次要求的 scope。没声明时退回 binding.scope，再退回 scheme 声明的全部 scope */
  scopes?: readonly string[];
  /** 已解析出的 cookie jar（`in: cookie` 的 apiKey 要合进 Cookie 头，不能互相覆盖） */
  cookieHeader?: string;
}

/**
 * 应用一个方案。四条纪律：
 *  1. **不覆盖用户显式写的头**。`headers: {authorization: {path: '$secret.t'}}` 是
 *     人明写的（IR 里看得见、审校过），声明式的 securityScheme 不该盖掉它 ——
 *     盖掉的后果是"我明明写了 token 为什么没生效"，而那件事在 trace 里看不出来。
 *  2. 值取不到就抛，**不发没鉴权的请求**。发出去会得到 401，而 401 的含义是
 *     "产品坏了"，真相是"环境没配密钥" —— docs/05 §2 说的第一体验杀手，
 *     必须在发送前变成一条指名道姓的报错。
 *  3. detail 里只出现方案名与 ref，不出现值。
 *  4. oauth2 的 token 走回调而不是在这里发请求：本模块要能被直接调用测试，
 *     而"取 token"的缓存/过期/重试逻辑独立成 TokenSource 才测得动。
 */
export async function applyAuth(i: ApplyInput): Promise<AppliedAuth> {
  /**
   * 头统一按**小写键**读写。
   *
   * 两个理由，第二个更要紧：
   *  1. HTTP 头名大小写不敏感（HTTP/2 还要求全小写），发出去前 `client.send` 也会 lower 一遍，
   *     所以这里小写化不改变线上行为。
   *  2. **"不覆盖用户显式写的头"这条判据本身依赖大小写无关的查找。**
   *     如果按原样存、只按 `name.toLowerCase()` 查，用户在 IR 里写
   *     `headers: { "X-Api-Key": "人手写的" }` 就会被无声覆盖成 spec 声明的值 ——
   *     正是这个函数说要防的那件事。所以查找与写入必须用同一个规范化形态。
   */
  const headers = lowerHeaders(i.headers);
  const secretValues: string[] = [];
  const need = (hint = '在 IR 或 env 的 auth 段里引用了它，但环境里没有对应的值。'): string => {
    const v = i.resolveSecret(i.binding.secret);
    // «…» 是占位符的前缀（SECRET_PLACEHOLDER / unresolved）—— 它不是值，
    // 当值用会把一个中文串塞进 Authorization 头，后端返回一个和鉴权无关的 400
    if (!v || v.startsWith('«')) throw new MissingCredentialError(i.binding.secret, hint);
    secretValues.push(v);
    return v;
  };

  switch (i.scheme.kind) {
    case 'http': {
      if (i.scheme.scheme === 'bearer') {
        if (headers.authorization) return { url: i.url, headers, secretValues, detail: 'authorization 已由步骤显式给出，未覆盖' };
        // bearer **不走 token 端点**：值就是 secret 指向的那个 token 本身。
        // （早先这里也调 accessToken，于是"配了 oauth2 凭证 + 一个 bearer 方案"会
        //  为了一个静态 token 去请求 token 端点，拿回来的还是另一个身份的东西。）
        const tok = need();
        headers.authorization = `Bearer ${tok}`;
        return { url: i.url, headers, secretValues, detail: `bearer（${i.binding.secret}）` };
      }
      // basic 的值形如 `user:pass`，一个 ref 装两段 —— 刻意不拆成两个 ref：
      // 拆了就会有人只配一个，另一个静默为空，得到 `Basic OnRhbWluOg==`（空密码），
      // 而后端的报错是"用户名或密码错误"，与真相（少配一个变量）隔了一层
      const v = need('http basic 需要把 "用户名:密码" 两段写在同一个 secret 里。');
      if (!v.includes(':')) {
        throw new MissingCredentialError(i.binding.secret, 'http basic 需要 "用户名:密码" 两段写在同一个 secret 里，实际值里没有冒号。');
      }
      headers.authorization = `Basic ${base64Utf8(v)}`;
      return { url: i.url, headers, secretValues, detail: `basic（${i.binding.secret}）` };
    }
    case 'apiKey': {
      const v = need();
      if (i.scheme.in === 'header') {
        if (headers[i.scheme.name.toLowerCase()]) {
          return { url: i.url, headers, secretValues, detail: `${i.scheme.name} 已由步骤显式给出，未覆盖` };
        }
        headers[i.scheme.name.toLowerCase()] = v;
        return { url: i.url, headers, secretValues, detail: `apiKey in header: ${i.scheme.name}（${i.binding.secret}）` };
      }
      if (i.scheme.in === 'query') {
        // 密钥进 URL 是**已知的泄露面**：访问日志、代理日志、CI 控制台都会记 URL，
        // 而脱敏按字段名走，URL 里压根没有字段名。协议如此，这里拦不住，所以做两件事：
        //  (a) 把值登记进 secretValues，调用方拿它洗掉任何回显 URL 的错误文本；
        //  (b) detail 里说明是 query 型，让人知道该推动后端换成 header。
        const sep = i.url.includes('?') ? '&' : '?';
        return {
          url: `${i.url}${sep}${encodeURIComponent(i.scheme.name)}=${encodeURIComponent(v)}`,
          headers, secretValues,
          detail: `apiKey in query: ${i.scheme.name}（${i.binding.secret}）。⚠ 密钥会进 URL，任何记录 URL 的地方都会留下它`,
        };
      }
      // cookie 型：与 cookie jar 合并。互相覆盖的后果是"会话丢了"，
      // 表现为登录后第二个请求 401，很难联想到是鉴权配置干的
      const jar = headers.cookie ?? i.cookieHeader;
      const piece = `${i.scheme.name}=${v}`;
      headers.cookie = jar ? `${jar.replace(/;+$/, '')}; ${piece}` : piece;
      return { url: i.url, headers, secretValues, detail: `apiKey in cookie: ${i.scheme.name}（${i.binding.secret}）` };
    }
    case 'oauth2': {
      if (headers.authorization) return { url: i.url, headers, secretValues, detail: 'authorization 已由步骤显式给出，未覆盖' };
      if (!i.accessToken) {
        throw new MissingCredentialError(i.binding.secret, 'oauth2 需要 accessToken 回调（由 TokenSource 提供），本次装配没给。');
      }
      const scopes = i.scopes?.length ? i.scopes : i.binding.scope ? i.binding.scope.split(/[\s,]+/) : i.scheme.scopes;
      const tok = await i.accessToken(i.binding, scopes);
      secretValues.push(tok);
      headers.authorization = `Bearer ${tok}`;
      return { url: i.url, headers, secretValues, detail: `oauth2 clientCredentials（${i.binding.secret}，scope=${scopes.join(',') || '-'}）` };
    }
  }
}

/**
 * UTF-8 安全的 base64。
 *
 * **不能直接 `btoa(user:pass)`**：值里有非 Latin1 字符（中文密码极常见）时 btoa 抛，
 * 而抛的位置在鉴权层，报出来的错与"密码错"毫无关系，人会去查密码。
 * 用 Buffer 而不是 globalThis.btoa：本层是 Node 专属（CLI/worker），
 * Buffer 一定在，而 btoa 要 Node 16+ 且在某些 worker 形态下缺席。
 */
export function base64Utf8(s: string): string {
  return Buffer.from(new TextEncoder().encode(s)).toString('base64');
}

/**
 * 把本轮用过的密钥值从任意文本里洗掉。
 *
 * **这不是第二套脱敏策略**，别和 engine/redact.ts 混为一谈（那种分叉的代价
 * 在 docs/08 §3 里记了好几轮）：redact.ts 回答"什么东西**看起来像**密钥"
 * （字段名 + 值形态，通用、无状态），这里回答"**这一轮**实际用过的这几个字符串"
 * （精确、有状态）。两者互补，缺了这层的后果很具体：
 * `?api_key=abc123` 请求失败时 undici 的错误消息带完整 URL，
 * 而值形态规则一个都不命中（abc123 不是 JWT/AKIA/sk- 形态），
 * 密钥就原样进 trace.jsonl 与 CI 日志。
 */
export function scrubSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) {
    // 短值不洗：拿 3 个字符去做全局替换会把正常文本搅烂（"abc" 出现在任何词里）。
    // 阈值 6 是权衡：真实凭证都远长于此，而短到这种程度的值本身也不是可用凭证。
    if (!v || v.length < 6) continue;
    out = out.split(v).join('«凭证已脱敏»');
  }
  return out;
}
