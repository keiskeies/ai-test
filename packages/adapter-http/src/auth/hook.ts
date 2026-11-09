/**
 * 把鉴权层接到 `asHttpExec` 上的那一小段胶水。
 *
 * 单独成文件的原因：`client.ts` 管的是"怎么把请求发出去且不撒谎"
 * （截断、重试、大整数、不跟重定向），已经够挤了；鉴权的正确判据
 * 完全不需要真网络，混在一起会让两边都想跑对方的测试。
 */
import { applyAuth } from './apply.js';
import type { AppliedAuth } from './apply.js';
import type { CredentialTable } from './credentials.js';
import { AuthResolver } from './interceptor.js';
import type { TokenSource } from './token.js';

/** 一个 operation 里鉴权层需要的部分。由调用方从 ParsedDoc 里取，本模块不认 spec 结构 */
export interface OpAuthNeed {
  /** spec 的 security 数组（三层继承已在 parse 期做完） */
  security?: unknown;
}

export interface AuthHookOptions {
  /**
   * docRef → (securitySchemes, 按 operationId 找 operation)。
   * 返回 undefined 表示这个 docRef 没导 spec —— 纯 `http` 步骤就是这种，
   * 它压根没有文档可查，而"手写第一条 GET 结果 401"是所有人的第一步，
   * 所以**没 spec 也必须能走通**。
   */
  doc: (docRef: string) => {
    securitySchemes: Record<string, unknown>;
    operation: (ref: { operationId?: string; method?: string; path?: string }) => OpAuthNeed | undefined;
  } | undefined;
  table: CredentialTable;
  resolveSecret: (ref: string) => string | undefined;
  tokenSources?: Map<string, TokenSource>;
  cookieHeader?: () => string | undefined;
}

export interface AuthApplyInput {
  url: string;
  headers: Record<string, string>;
  docRef?: string;
  operationId?: string;
  method?: string;
  path?: string;
  /** 本次的身份：步骤上的 identity，或 useIdentity 切出来的当前身份 */
  identity?: string;
  /** 步骤上明写的 `secret:<ref>` */
  ref?: string;
}

/** 鉴权没配好。**判 error 而不是 fail**：产品没错，是环境没配。
 *  混起来的直接后果是值班人拿 401 去查产品代码（docs/05 §2） */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class AuthHook {
  private readonly resolvers = new Map<string, AuthResolver>();
  /** 已经报告过 spec 级鉴权问题的 docRef（防刷屏，见 specIssues） */
  private readonly reportedIssues = new Set<string>();

  constructor(private readonly o: AuthHookOptions) {}

  /**
   * 给一个请求加鉴权。两条路径，处理完全不同，**刻意不合并**：
   *
   *  1. **步骤明写了 ref** → 按 bearer 直接落地，不看 spec。
   *     为什么默认 bearer 而不是"猜方案"：显式 ref 这条路压根没有 spec 信息可用，
   *     而按 apiKey-in-query 猜会把密钥写进 URL（访问日志、CI 控制台、代理都留痕）。
   *     猜 bearer 的后果最坏是 401 + 一句"我按 bearer 发的，要换方案请导 spec"。
   *     **显式优先于 spec**：IR 里写得清清楚楚的头，被 spec 声明盖掉的话，
   *     人会对着"我明明写了 token 为什么不生效"查半天，而 trace 里看不出来。
   *
   *  2. **按 spec 声明走** → 交给 AuthResolver 选 OR 组、逐个应用。
   *     凭证该有却没有时**抛错，不发请求**：发出去会得到 401，而 401 在报告里的
   *     意思是"产品坏了"，真相是环境没配密钥 —— 这两件事被混在一起就是
   *     docs/05 §2 点名的第一体验杀手。
   */
  async apply(i: AuthApplyInput): Promise<AppliedAuth & { notes: string[] }> {
    if (i.ref) return this.applyExplicitRef(i);
    if (!i.docRef) {
      // 没导 spec：没有依据可判"要不要鉴权"。原样发出，并在 notes 里说明
      // —— 这里**不报错**，因为纯 http 步骤打公开接口是合法且最常见的起点
      return { url: i.url, headers: { ...i.headers }, secretValues: [], detail: '未导 spec，未附加鉴权', notes: [] };
    }
    const d = this.o.doc(i.docRef);
    if (!d) {
      return {
        url: i.url, headers: { ...i.headers }, secretValues: [], detail: '未附加鉴权',
        notes: [`docRef "${i.docRef}" 没有导入（openapiCall 需要它）。加 --doc ${i.docRef}=<openapi.json>`],
      };
    }

    const r = this.resolver(i.docRef, d.securitySchemes);
    const op = d.operation({ operationId: i.operationId, method: i.method, path: i.path });
    const out = await r.apply({
      url: i.url, headers: i.headers,
      op: { security: op?.security, identity: i.identity },
      identityOverride: i.identity,
    });
    const notes: string[] = [];
    // 需要鉴权却一个方案都没应用上 -> 报错。
    // 判据用 plan.length 而不是"有没有 binding"：spec 可能声明了 OR 组，
    // 其中一组凭证齐了就该发（那是 OR 的语义），全部缺才算缺。
    if (!out.isPublic && out.plan.length === 0) {
      throw new AuthRequiredError(
        `接口需要鉴权，但当前环境没有可用凭证。${out.reasons.join('；') || 'spec 声明了 securityScheme' }。`
        + ' 修法：在 env 文件的 auth 段里配 default.secret（值必须是 secret:<ref>，真值放环境变量）',
      );
    }
    if (out.auth.detail) notes.push(`鉴权：${out.auth.detail}`);
    for (const u of out.unsupported) notes.push(`spec 的 securitySchemes.${u.name}：${u.reason}。${u.workaround}`);
    // spec 自身的问题是**文档级**的，每个请求都拼一遍会把几百条重复消息塞进 warnings。
    // 所以在这里按 docRef 去重一次；不去重的后果不是错，是"告警刷屏->用户关掉整个告警区"，
    // 而那是 lint 那套规则反复踩过的坑
    for (const msg of this.specIssues(i.docRef)) notes.push(`spec 的鉴权声明有问题：${msg}`);
    return { ...out.auth, notes };
  }

  private async applyExplicitRef(i: AuthApplyInput): Promise<AppliedAuth & { notes: string[] }> {
    const ref = i.ref!;
    const v = this.o.resolveSecret(ref);
    if (!v || v.startsWith('«')) {
      // 不回显值，也不猜"可能是名字写错了" —— 只说清缺哪个
      throw new AuthRequiredError(`步骤显式引用的凭证 ${ref} 解析不到值。对应的环境变量设了吗？`);
    }
    const headers = { ...i.headers };
    if (headers.authorization) {
      // 头是人在 headers 里直接写的（比 auth 字段更直白），auth 字段让路
      return { url: i.url, headers, secretValues: [], detail: 'authorization 已在 headers 里给出，未覆盖', notes: [] };
    }
    headers.authorization = `Bearer ${v}`;
    return {
      url: i.url, headers, secretValues: [v],
      detail: `步骤显式 ref，按 bearer 应用（${ref}）`,
      notes: ['这一步显式给了 auth 引用，spec 声明的 securityScheme 未参与（显式优先）。'
        + '要换方案（apiKey / basic / cookie）请导 spec，或直接在 headers 里写。'],
    };
  }

  /** 某个 docRef 的 spec 级鉴权问题，只在第一次用到时取 */
  private specIssues(docRef: string): string[] {
    if (this.reportedIssues.has(docRef)) return [];
    this.reportedIssues.add(docRef);
    return this.resolvers.get(docRef)?.parsed.issues ?? [];
  }

  /** resolver 按 docRef 缓存（scheme 归一化不便宜，而一条 run 会调几百次） */
  private resolver(docRef: string, schemes: Record<string, unknown>): AuthResolver {
    const hit = this.resolvers.get(docRef);
    if (hit) return hit;
    const r = new AuthResolver({
      securitySchemes: schemes,
      table: this.o.table,
      docRef,
      resolveSecret: this.o.resolveSecret,
      tokenSources: this.o.tokenSources,
      cookieHeader: this.o.cookieHeader,
    });
    this.resolvers.set(docRef, r);
    return r;
  }
}
