/**
 * 把 scheme 解析、凭证表、token 源串成一个"这次请求该带什么"的解析器。
 *
 * **为什么它是"返回改过的 url/headers"而不是挂在 HttpClient.onRequest 上**：
 * onRequest 只能改 headers，改不了 URL。而 `apiKey in: query` 必须改 URL
 * （`?api_key=…`）—— 挂在 hook 上等于这类方案永远做不出来。
 * 所以鉴权在 `asHttpExec.send` 里、client.send **之前**完成。
 *
 * 同样重要的一条：这个模块**不发请求**（token 例外，那是 TokenSource 的事）。
 * 保持纯调用，"给定 spec + 给定凭证 → 该带哪些头"才能被直接测试，
 * 而 auth-check 这条命令的全部价值就是"不跑用例也能回答鉴权对不对"。
 */
import { CredentialTable } from './credentials.js';
import type { CredentialBinding } from './credentials.js';
import { applyAuth } from './apply.js';
import type { AppliedAuth } from './apply.js';
import { chooseSchemeGroup, normalizeSecuritySchemes, parseSecurityRequirements } from './scheme.js';
import type { AuthScheme, SchemeParseResult } from './scheme.js';
import type { TokenSource } from './token.js';

export interface AuthResolverOptions {
  /** spec 声明的 securitySchemes（parseOpenApi 的原样输出） */
  securitySchemes: Record<string, unknown>;
  table: CredentialTable;
  /** 当前 docRef。多文档时决定用哪一桶凭证 */
  docRef?: string;
  resolveSecret: (ref: string) => string | undefined;
  /** docRef → token 源。oauth2 才有 */
  tokenSources?: Map<string, TokenSource>;
  /* 从前这里有一个 `cookieHeader` 回调。删它的理由写在 `apply.ts` 里那段（不留第二个写 Cookie 头的人）*/
}

export interface AuthPlan {
  /** 这个 operation 是否声明为公开（spec 里 security: [{}]） */
  isPublic: boolean;
  /** 要应用的方案（已选好 OR 组）。空数组 = 不带鉴权 */
  plan: Array<{ name: string; scheme: AuthScheme; scopes: string[]; binding: CredentialBinding }>;
  /** 凑不齐凭证时的原因（给 auth-check 与运行期报错） */
  reasons: string[];
  /** spec 里声明了但本平台不支持的方案 */
  unsupported: Array<{ name: string; reason: string; workaround: string }>;
  /** spec 自身的解析问题 */
  issues: string[];
}

export class AuthResolver {
  private readonly schemes: SchemeParseResult;

  constructor(private readonly o: AuthResolverOptions) {
    this.schemes = normalizeSecuritySchemes(o.securitySchemes);
  }

  /** 归一化后的方案表（auth-check 要逐条列出） */
  get parsed(): SchemeParseResult {
    return this.schemes;
  }

  /**
   * 为一个 operation 规划鉴权。
   *
   * `operation.security` 是 spec 的原始 security 数组（三层继承已在 parse 期做完）。
   * 返回的 plan 为空且 `isPublic=false` 时，调用方**必须报错**而不是裸发请求：
   * 裸发会得到 401，而 401 会被读成"产品坏了"，真相是环境没配凭证
   * —— 这正是 docs/05 §2 点名的第一体验杀手。
   */
  planFor(operation: { security?: unknown; identity?: string; method?: string; path?: string }, identityOverride?: string): AuthPlan {
    const reqs = parseSecurityRequirements(operation.security);
    const identity = identityOverride ?? (typeof operation.identity === 'string' ? operation.identity : undefined);
    const has = (name: string): boolean => {
      // oauth2 的"有没有凭证"看两件事：client_id（明文）与 secret 引用（密钥）。
      // 只看 secret 会让"配了 clientId 忘了 secret"变成"没配凭证"，
      // 报出的原因是"缺凭证"，而真相是"配了一半"—— 这两种情况的修法不同
      const b = this.o.table.lookup(this.o.docRef, identity);
      if (!b) return false;
      if (this.schemes.schemes.get(name)?.kind === 'oauth2') return !!b.clientId && !this.isPlaceholder(b.secret);
      return true;
    };
    const choice = chooseSchemeGroup(reqs, this.schemes.schemes, has);
    const plan: AuthPlan['plan'] = [];
    for (const a of choice.apply) {
      const binding = this.o.table.lookup(this.o.docRef, identity);
      if (!binding) continue; // chooseSchemeGroup 已经查过 has()，这里只是类型收窄
      plan.push({ name: a.name, scheme: a.scheme, scopes: a.scopes, binding });
    }
    const blocked = this.schemes.unsupported.filter((u) => (reqs ?? []).some((g) => g.needs.some((n) => n.name === u.name)));
    return {
      isPublic: choice.publicOk,
      plan,
      reasons: choice.reasons,
      unsupported: blocked,
      issues: this.schemes.issues,
    };
  }

  /**
   * 把规划落到请求上。多个方案（AND 组）依次叠加。
   *
   * 返回的 `secretValues` 必须交给调用方去洗错误文本（见 apply.ts 的 scrubSecrets）。
   */
  async apply(i: {
    url: string; headers: Record<string, string>;
    op: { security?: unknown; identity?: string };
    identityOverride?: string;
  }): Promise<{
    auth: AppliedAuth; detail: string[]; reasons: string[]; isPublic: boolean;
    /** 实际要应用的方案（已选组）。**空 + isPublic=false 就是"该带凭证但一个都没凑齐"** ——
     *  调用方据此报错，绝不能裸发请求（裸发=401=被读成"产品坏了"） */
    plan: AuthPlan['plan'];
    unsupported: AuthPlan['unsupported'];
  }> {
    const p = this.planFor(i.op, i.identityOverride);
    let url = i.url;
    let headers = { ...i.headers };
    const secretValues: string[] = [];
    const detail: string[] = [];
    for (const item of p.plan) {
      const tokens = this.o.docRef ? this.o.tokenSources?.get(this.o.docRef) : undefined;
      const applied = await applyAuth({
        url, headers,
        scheme: item.scheme,
        binding: item.binding,
        scopes: item.scopes,
        resolveSecret: this.o.resolveSecret,
        // 只有 oauth2 方案会调它。没配 token 源时传 undefined，
        // applyAuth 会明确报"需要 accessToken 回调"而不是发了个没鉴权的请求
        accessToken: item.scheme.kind === 'oauth2'
          ? (b, scopes) => {
              if (!tokens) return Promise.reject(new Error(`oauth2 方案 ${item.name} 需要 token 源，但装配时没建（检查 env 的 auth 段与 spec 的 tokenUrl）`));
              return tokens.accessToken(b, scopes);
            }
          : undefined,
      });
      url = applied.url;
      headers = applied.headers;
      secretValues.push(...applied.secretValues);
      detail.push(applied.detail);
    }
    return {
      auth: { url, headers, secretValues, detail: detail.join('；') || (p.isPublic ? '公开接口，不带凭证' : '未带凭证') },
      detail, reasons: p.reasons, isPublic: p.isPublic, plan: p.plan, unsupported: p.unsupported,
    };
  }

  private isPlaceholder(ref: string): boolean {
    const v = this.o.resolveSecret(ref);
    return !v || v.startsWith('«');
  }
}
