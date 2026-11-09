/**
 * 凭证表：把"这次运行该用哪个凭证"从 IR 里分离出来。
 *
 * 为什么凭证值不在 IR 里（docs/03 §5、docs/02 §5 的老规矩）：
 * IR 是**要进 git 的**，凭证不是。IR 里只出现不透明引用（`secret:<ref>`），
 * 真值只在发请求那一刻被取出。
 *
 * 但只有 ref 不够 —— 还需要知道"哪个身份用哪个 ref"。
 * 这张表就补这一层：`(docRef?, scheme 名?, 身份?) → secret ref`。
 * 放 env 文件里（`env/staging.json` 的 `auth` 段），因为**同一份用例在不同环境
 * 用的是不同凭证**，而用例本身不该随环境变（变了就没法跨环境复用了）。
 */

/** env 文件里的一段鉴权配置（未校验的原始形态来自 JSON） */
export interface CredentialBinding {
  /** 要用的 secret 引用。必须是 secret: 前缀，**任何真值形态都不进配置文件** */
  secret: string;
  /** 覆盖 spec 声明的方案（少数后端 spec 与实际不一致时用） */
  scheme?: string;
  /** oauth2 clientCredentials 用的 client_id（不是密钥，可以明文） */
  clientId?: string;
  /** 同上，client_secret 的 ref 走 secret 字段 */
  scope?: string;
}

/** 一个 docRef 下的凭证：default 给无名身份，identities 给多身份场景 */
export interface DocCredentials {
  default?: CredentialBinding;
  identities?: Record<string, CredentialBinding>;
}

/** env 文件里 `auth` 段的整体形态：可以是 `{docRef: {...}}`，也可以直接是 `{...}`（单文档时） */
export type AuthConfigRaw = Record<string, unknown>;

/**
 * 一次查找的完整结果。
 *
 * `via` 是**给报告侧用的**：同一个绑定值，`via:'identity'` 意味着"这个身份确实有自己的凭证"，
 * `via:'default'` 意味着"要这个身份，但配的是默认凭证" —— 前者能用来验权限矩阵，后者不能。
 * `where` 说命中的是哪一桶（docRef 名，undefined = 匿名桶），多系统排查时这一句最有用。
 */
export interface CredentialResolution {
  binding?: CredentialBinding;
  via: 'identity' | 'default' | 'none';
  where?: string;
}

export class CredentialTable {
  private readonly byDoc = new Map<string, DocCredentials>();

  /** 匿名桶：spec 没导（纯 http 步骤）或单文档时的默认绑定 */
  private readonly anonymous: DocCredentials = {};

  private constructor() {}

  /**
   * 从 env 的 `auth` 段建表。
   *
   * 两种形状都收，而且**可以混着写**，因为"只导一份 spec"是绝大多数人的第一步：
   *  - `{ "shop": { "default": {...} } }` —— 按 docRef 分桶
   *  - `{ "default": {...} }` —— 不分桶，对任何 docRef 生效
   * 分派规则只有一条，且不猜：**顶层的 `default`/`identities` 归匿名桶，其余键归 docRef 桶**。
   *
   * 这条规则是被一个真 bug 逼出来的。早先的判据是"顶层有没有 default/identities"，
   * 有就**把整个对象**当成匿名桶读 —— 于是
   * `{ "shop": {…}, "identities": {…} }` 里的 shop 那一桶被安静地丢掉。
   * 表现是"配了 shop 的凭证但不生效"，而匿名 default 又存在，
   * 于是请求带着**另一个系统的凭证**打过去：多数后端 401，
   * 权限配得松的后端直接放行 —— 后者是数据串了，比 401 坏得多。
   */
  static fromEnv(raw: AuthConfigRaw | undefined): { table: CredentialTable; notes: string[] } {
    const table = new CredentialTable();
    const notes: string[] = [];
    if (!raw) return { table, notes };
    const keys = Object.keys(raw);
    const shapeKeys = keys.filter((k) => k === 'default' || k === 'identities');
    const docKeys = keys.filter((k) => k !== 'default' && k !== 'identities');

    // 全部顶层键都长得像绑定字段 -> 是"少写了一层 default"，最常见的错法：
    // `{ "auth": { "secret": "secret:x" } }` 看着完全对，实际每个键都会被当成 docRef，
    // 而没人把 docRef 叫 "secret"，于是整段静默失效。
    if (shapeKeys.length === 0 && docKeys.length > 0 && docKeys.every((k) => BINDING_KEYS.includes(k))) {
      notes.push(
        `env 的 auth 段直接写了 ${docKeys.join('/')}，少了一层：要写成 auth.default.${docKeys[0]}`
        + '（或按 docRef 分桶：auth.<docRef>.default.secret）',
      );
      return { table, notes };
    }

    if (shapeKeys.length) {
      const anon: AuthConfigRaw = {};
      for (const k of shapeKeys) anon[k] = raw[k];
      Object.assign(table.anonymous, readCredentials(anon, notes, 'auth'));
      notes.push('env 的 auth 段里的 default/identities 按"不分桶"理解（对任何 docRef 生效）');
    }
    for (const docRef of docKeys) {
      const v = raw[docRef];
      // 桶的值必须是对象。写成字符串（`"auth": { "shop": "secret:x" }`）是另一类
      // "看着对"的写法：不报错的话这一桶等于不存在，人会去查密钥变量名
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        notes.push(`auth.${docRef} 不是一个对象。要写成 auth.${docRef}.default.secret = "secret:<ref>"`);
        continue;
      }
      table.byDoc.set(docRef, readCredentials(v, notes, `auth.${docRef}`));
    }
    if (docKeys.length) notes.push(`env 的 auth 段按 docRef 分桶：${docKeys.join('、')}`);
    return { table, notes };
  }

  /**
   * 查一个凭证绑定。
   *
   * 顺序：**身份精确匹配 > 该 doc 的 default > 匿名 default**。
   * 先查完两桶的身份、再退 default，而不是"第一个桶有 default 就用它" ——
   * 后者会让 `{shop: {default: A}, 匿名: {identities: {admin: B}}}` 里的 admin
   * 永远不生效（shop 的 default 先命中），而"身份没生效"的表现是
   * 权限用例全绿，与"权限真的没问题"完全同形。
   */
  lookup(docRef: string | undefined, identity: string | undefined): CredentialBinding | undefined {
    return this.lookupVia(docRef, identity).binding;
  }

  /**
   * 同上，但额外说明**它是按哪一级命中的**。
   *
   * "命中级别"本身有诊断价值：请求 `admin` 身份而实际命中的是该 doc 的 default 时，
   * 只看绑定值看不出来（值就是 default 那个），于是 auth-check 会报
   * "admin 身份凭证有效" —— 而它验的其实是默认凭证。
   * 这与本仓修过的那批"身份没生效但报告成功"是同一件事，只是发生在**报告侧**。
   */
  lookupVia(docRef: string | undefined, identity: string | undefined): CredentialResolution {
    const buckets: Array<{ where?: string; bucket?: DocCredentials }> = [
      { where: docRef, bucket: docRef ? this.byDoc.get(docRef) : undefined },
      { where: undefined, bucket: this.anonymous },
    ];
    if (identity) {
      for (const b of buckets) {
        const hit = b.bucket?.identities?.[identity];
        if (hit) return { binding: hit, via: 'identity', where: b.where };
      }
    }
    for (const b of buckets) {
      if (b.bucket?.default) return { binding: b.bucket.default, via: 'default', where: b.where };
    }
    return { via: 'none' };
  }

  /**
   * 这个 docRef 上，该身份有没有**自己的**凭证。
   * 给 auth-check 用：没有的话那一行必须标"身份回落到默认"，不能报成"该身份有效"。
   */
  hasIdentityBinding(docRef: string | undefined, identity: string | undefined): boolean {
    if (!identity) return true; // 没要求身份，谈不上回落
    return this.lookupVia(docRef, identity).via === 'identity';
  }

  /** 有没有任何绑定（供 CLI 决定要不要在装配期提示） */
  empty(): boolean {
    return this.byDoc.size === 0 && !this.anonymous.default && !this.anonymous.identities;
  }

  /** 全部 ref（供装配期扫缺失密钥）。不含真值 —— 这张表里压根没有真值 */
  refs(): string[] {
    const out: string[] = [];
    for (const bucket of [...this.byDoc.values(), this.anonymous]) {
      if (bucket.default?.secret) out.push(bucket.default.secret);
      for (const b of Object.values(bucket.identities ?? {})) if (b?.secret) out.push(b.secret);
    }
    return out;
  }

  /** 声明了哪些身份（给 auth-check 列"这个环境配了哪几个身份"） */
  identities(): string[] {
    const out = new Set<string>();
    for (const bucket of [...this.byDoc.values(), this.anonymous]) {
      for (const k of Object.keys(bucket.identities ?? {})) out.add(k);
    }
    return [...out].sort();
  }
}

const BINDING_KEYS = ['secret', 'scheme', 'clientId', 'scope'];

/** 读一层 `{default, identities}`。形状不对就产出一条说明，绝不猜 */
function readCredentials(v: unknown, notes: string[], where: string): DocCredentials {
  const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: DocCredentials = {};
  if (o.default !== undefined) {
    const def = asBinding(o.default);
    if (def) out.default = def;
    else notes.push(`${where}.default 不是一个合法的绑定（必须含 secret: 引用），已忽略`);
  }
  const ids = o.identities;
  if (ids !== null && typeof ids === 'object' && !Array.isArray(ids)) {
    const map: Record<string, CredentialBinding> = {};
    for (const [k, val] of Object.entries(ids as Record<string, unknown>)) {
      const b = asBinding(val);
      // 身份名打错不会有任何现象（查不到就走 default），所以这里必须响
      if (b) map[k] = b;
      else notes.push(`${where}.identities.${k} 缺合法的 secret 引用，该身份已忽略（会退回 default）`);
    }
    if (Object.keys(map).length) out.identities = map;
  }
  // 整段写错形状时最容易被忽略的是"少了一层 default"：
  // `{ "auth": { "secret": "..." } }` 看着对，实际没人读 —— 提示一下
  if (!out.default && !out.identities && BINDING_KEYS.some((k) => k in o)) {
    notes.push(`${where} 里直接写了 ${BINDING_KEYS.filter((k) => k in o).join('/')}，但结构要写成 ${where}.default.secret`);
  }
  return out;
}

function asBinding(v: unknown): CredentialBinding | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  // **只收 secret: 引用**。这里不做"看起来像 ref 就当 ref"的宽容：
  // 配置文件里写明文密码不会报错、照样能跑，直到有人把 env 文件提交上去
  if (typeof o.secret !== 'string' || !/^secret:[A-Za-z0-9_-]+$/.test(o.secret)) return undefined;
  const b: CredentialBinding = { secret: o.secret };
  if (typeof o.scheme === 'string') b.scheme = o.scheme;
  if (typeof o.clientId === 'string') b.clientId = o.clientId;
  if (typeof o.scope === 'string') b.scope = o.scope;
  return b;
}
