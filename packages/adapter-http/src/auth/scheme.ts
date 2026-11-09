/**
 * OpenAPI securityScheme → 内部鉴权方案（docs/05 §2）。
 *
 * **这层是纯函数**（不碰网络、不碰磁盘），因为鉴权配置的解析错误必须在
 * "第一次跑用例"之前暴露，而不是等 401。判据是"能直接被调用测试"，
 * 所以这里一个 fetch 都没有。
 *
 * 为什么要把 spec 的 securityScheme 归一化一层，而不是直接读 raw：
 * spec 里 `{type:'apiKey'}` 少了 `name`、`{type:'http'}` 少了 `scheme`、
 * `scheme:'Digest'`（本平台不支持）都极常见。直接读的话这些会变成
 * "悄悄不加鉴权"，而"不加鉴权"的表现是 401 ——
 * 人会去查用例，不会去查 spec。所以每一种畸形都要产出一条**指名道姓**的 issue。
 */

/** 归一化后的鉴权方案。`kind` 决定"值往哪儿放"，这就是为什么引擎不该认识它 */
export type AuthScheme =
  | { kind: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
  | { kind: 'http'; scheme: 'bearer' | 'basic'; bearerFormat?: string }
  | {
      kind: 'oauth2';
      flow: 'clientCredentials' | 'authorizationCode' | 'implicit' | 'password';
      tokenUrl?: string;
      authorizationUrl?: string;
      scopes: string[];
    };

/** spec 声明了、但本平台 P0 明确不做的方案（docs/05 §2：直说，别硬做） */
export interface UnsupportedScheme {
  name: string;
  reason: string;
  /** 给用户的那条替代路径。缺它的话报错就只是"不行"，没有下一步 */
  workaround: string;
}

export interface SchemeParseResult {
  schemes: Map<string, AuthScheme>;
  unsupported: UnsupportedScheme[];
  /** spec 自身的问题（少字段、字段值不认识）。这些**不是**用户用例的错 */
  issues: string[];
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 归一化一份 spec 的全部 securitySchemes。
 *
 * 支持的：`apiKey`(header/query/cookie)、`http`(bearer/basic)、`oauth2`(clientCredentials)。
 * 明确不支持并给出替代路径的：oauth2 的 authorizationCode / implicit、openIdConnect。
 * 不支持**不等于忽略**：调用方拿到 unsupported 后必须能让用例明确失败，
 * 而不是发一个没鉴权的请求出去（那会得到一个意义不明的 401）。
 */
export function normalizeSecuritySchemes(raw: Record<string, unknown>): SchemeParseResult {
  const schemes = new Map<string, AuthScheme>();
  const unsupported: UnsupportedScheme[] = [];
  const issues: string[] = [];

  for (const [name, sc] of Object.entries(raw)) {
    const s = asObj(sc);
    const type = asStr(s.type);
    if (!type) {
      issues.push(`securitySchemes.${name} 缺 type 字段，该方案被忽略`);
      continue;
    }
    if (type === 'apiKey') {
      const inField = asStr(s.in);
      const keyName = asStr(s.name);
      if (!inField || !keyName) {
        issues.push(`securitySchemes.${name} 是 apiKey 但缺 ${!inField ? 'in' : 'name'}，该方案被忽略（不加鉴权的请求只会得到 401）`);
        continue;
      }
      if (inField !== 'header' && inField !== 'query' && inField !== 'cookie') {
        issues.push(`securitySchemes.${name} 的 in="${inField}" 不是 header/query/cookie 之一，该方案被忽略`);
        continue;
      }
      schemes.set(name, { kind: 'apiKey', in: inField, name: keyName });
      continue;
    }
    if (type === 'http') {
      const schemeRaw = (asStr(s.scheme) ?? '').toLowerCase();
      if (schemeRaw === 'bearer') {
        schemes.set(name, { kind: 'http', scheme: 'bearer', bearerFormat: asStr(s.bearerFormat) });
        continue;
      }
      if (schemeRaw === 'basic') {
        schemes.set(name, { kind: 'http', scheme: 'basic' });
        continue;
      }
      unsupported.push({
        name,
        reason: `http scheme "${asStr(s.scheme) ?? '(缺)'}" 本平台未实现`,
        workaround: '改用 apiKey 声明，或在 setup 里用 http 步骤自己算 Authorization 头（把值放进 secret）',
      });
      continue;
    }
    if (type === 'oauth2') {
      const flows = asObj(s.flows);
      if (Object.keys(flows).length === 0) {
        issues.push(`securitySchemes.${name} 是 oauth2 但没有 flows，该方案被忽略`);
        continue;
      }
      // clientCredentials 优先：它是唯一一个"机器凭证、可无人值守拿 token"的流程。
      // 一个 scheme 可能同时声明多个 flow，挑能自动化的那个是合理的默认。
      const cc = asObj(flows.clientCredentials);
      if (Object.keys(cc).length) {
        const tokenUrl = asStr(cc.tokenUrl);
        if (!tokenUrl) {
          issues.push(`securitySchemes.${name}.flows.clientCredentials 缺 tokenUrl，该方案被忽略`);
          continue;
        }
        schemes.set(name, {
          kind: 'oauth2', flow: 'clientCredentials', tokenUrl,
          scopes: Array.isArray(cc.scopes) ? cc.scopes.filter((x): x is string => typeof x === 'string') : Object.keys(asObj(cc.scopes)),
        });
        continue;
      }
      const present = Object.keys(flows).filter((f) => Object.keys(asObj(flows[f])).length);
      unsupported.push({
        name,
        reason: `oauth2 只实现了 clientCredentials，${name} 声明的是 ${present.join('/') || '(空 flows)'}`,
        workaround: '手工拿一个 token 放进环境变量（ATEST_SECRET_<ref>），并在 env 的 auth 配置里按 bearer 绑定它',
      });
      continue;
    }
    if (type === 'openIdConnect') {
      unsupported.push({
        name,
        reason: 'openIdConnect 需要先发现 OIDC metadata 再走授权流程，本平台未实现',
        workaround: '从 discovery 文档里抄出 tokenUrl，改成 oauth2.clientCredentials 声明',
      });
      continue;
    }
    issues.push(`securitySchemes.${name} 的 type="${type}" 不认识（OAS3 只定义 apiKey/http/oauth2/openIdConnect），该方案被忽略`);
  }
  return { schemes, unsupported, issues };
}

/**
 * 一次调用该带哪些凭证。
 *
 * OAS 的 `security` 有**两层语义**，弄反就是"发了一半的鉴权然后 401"：
 *  - 数组的每一项之间是 **OR**（任一组满足即可）；
 *  - 每一项内部的多个键是 **AND**（必须全带）。
 * `[{a:[]},{b:[]}]` 是"a 或 b"，`[{a:[],b:[]}]` 是"a 且 b"。
 * 常见的错法是把整个数组拍平 —— 那会把"或"变成"与"，多带一个后端不认的凭证，
 * 有些网关会直接拒（而不是忽略）。
 *
 * 这里返回**第一个能凑齐凭证的组**（OR 的语义就是取第一个可满足的），
 * 并说明落选原因 —— 凑不齐时必须能说清"缺哪个凭证"，
 * 这是 atest auth-check 的全部价值所在。
 */
export interface SecurityRequirement {
  /** 组内每个方案名 → 要求的 scope */
  needs: Array<{ name: string; scopes: string[] }>;
}

export function parseSecurityRequirements(security: unknown): SecurityRequirement[] | undefined {
  if (!Array.isArray(security)) return undefined;
  const out: SecurityRequirement[] = [];
  for (const item of security) {
    const o = asObj(item);
    const needs = Object.entries(o).map(([name, scopes]) => ({
      name,
      scopes: Array.isArray(scopes) ? scopes.filter((x): x is string => typeof x === 'string') : [],
    }));
    // 空对象 `{}` 是一项"无鉴权即可"，needs 为空 —— 调用方据此判公开接口
    out.push({ needs });
  }
  return out;
}

/** 选组结果。`satisfied` 为空数组且 `publicOk` 为 true 表示这接口是公开的 */
export interface SchemeChoice {
  /** 要应用的 (scheme, 要求的 scope)。空 = 不带鉴权 */
  apply: Array<{ name: string; scheme: AuthScheme; scopes: string[] }>;
  publicOk: boolean;
  /** 每个落选组的缺项说明（给 auth-check 用） */
  reasons: string[];
}

/**
 * 在 OR 组里挑第一组"凭证齐了"的。
 *
 * `hasCredential(schemeName)` 由调用方提供（它知道 env 里配了什么）。
 * 这里刻意**不**解析密钥值 —— 选择逻辑与取值分离，
 * 才不会出现"为了判断有没有凭证而把真值读进内存"。
 */
export function chooseSchemeGroup(
  requirements: SecurityRequirement[] | undefined,
  schemes: Map<string, AuthScheme>,
  hasCredential: (schemeName: string) => boolean,
): SchemeChoice {
  // 没声明 security：继承链上没定义过，按"不带鉴权"发（spec 级没写就是公开）
  if (!requirements || requirements.length === 0) return { apply: [], publicOk: true, reasons: [] };
  const reasons: string[] = [];
  for (const group of requirements) {
    if (group.needs.length === 0) return { apply: [], publicOk: true, reasons };
    const missing: string[] = [];
    const unknown: string[] = [];
    const apply: SchemeChoice['apply'] = [];
    for (const n of group.needs) {
      const sc = schemes.get(n.name);
      // spec 里没这个方案名（$ref 写错、components 漏了）：**必须响**。
      // 静默跳过等于把"少带一个鉴权"变成"后端返回 401"，查的人会去查用例。
      if (!sc) { unknown.push(n.name); continue; }
      if (!hasCredential(n.name)) { missing.push(n.name); continue; }
      apply.push({ name: n.name, scheme: sc, scopes: n.scopes });
    }
    if (unknown.length) {
      reasons.push(`组[${group.needs.map((x) => x.name).join(' + ')}]：spec 里没有这些方案：${unknown.join('、')}`);
      continue;
    }
    if (missing.length) {
      reasons.push(`组[${group.needs.map((x) => x.name).join(' + ')}]：缺凭证 ${missing.join('、')}`);
      continue;
    }
    return { apply, publicOk: false, reasons };
  }
  return { apply: [], publicOk: false, reasons };
}
