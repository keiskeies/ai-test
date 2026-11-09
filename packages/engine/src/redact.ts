/**
 * **唯一一份**脱敏策略。
 *
 * 为什么单独成文件而不是长在 vars.ts 里：落盘的报告（M6）、
 * 表达式可见变量（vars.ts 的 redact）、断言的 keyContext 三处都要脱敏，
 * 而它们**必须同一套判据**。分两份的正道后果是：某处加了个 `cookie` 关键词，
 * 另两处继续把 cookie 原样写进磁盘 —— 而"我们做了脱敏"这句话仍然成立，
 * 于是没人会去查第三处。这类分叉在 docs/08 §3 里已经记了好几轮。
 *
 * 脱敏发生的时机是**序列化那一刻**，不是展示层（docs/02 §5）。
 * 放在展示层意味着磁盘上还是明文，任何拿到 artifact 的人就拿到了密钥。
 */

/** 占位值。**保留类型线索**：写成 `«secret:未暴露»` 而不是 `***`，
 *  排查时才知道这里原本是个密钥（该去查过期还是查权限），同时没留下值本身。 */
export const SECRET_PLACEHOLDER = '«secret:未暴露»';

/**
 * 字段名判据（落盘用）。
 *
 * 与 lint.ts 的 CREDENTIAL_FIELD_RE **有意不同**：lint 管"别把密钥写进用例"，
 * 只认能拿来认证的东西；这里管"别把密钥与 PII 写进磁盘"，
 * 所以手机号/身份证也算。合并两份规则的后果是要么误报刷屏（大家把 lint 关掉），
 * 要么漏掉 PII（合规问题）。
 *
 * 不能按"序列化后的文本"扫：`JSON.stringify` 出来是 `"password":"x"`，
 * `password` 后面紧跟引号而不是冒号，`password\s*[:=]` 这种写法永远匹配不上 ——
 * 一条安全规则静默全量放行。所以这里**只对结构化数据的键**判。
 */
export const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|authorization|apikey|api_key|accesskey|access_key|clientsecret|client_secret|credential|privatekey|cookie|set-cookie|session|idcard|id_card|phone|mobile)/i;

/**
 * 值形态判据。
 *
 * **只按字段名脱敏是不够的**：`{"data":"eyJhbGciOiJIUzI1..."}` 里的 JWT 会原样落盘 ——
 * 后端把 token 放在叫 data 的字段里极常见，而按字段名的规则压根看不见它。
 * 这属于最坏的一类漏洞：防护是有的、测试也过了、密钥照抄进磁盘。
 */
export const SECRET_VALUE_RES: ReadonlyArray<{ re: RegExp; name: string }> = [
  // JWT：三段 base64url。真实 access token 绝大多数长这样
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, name: 'JWT' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, name: 'AWS Access Key' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, name: 'API Key（sk-）' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, name: '私钥' },
  // Bearer 值。长度阈值防把 "Bearer" 这个词本身当成密钥
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, name: 'Bearer token' },
];

/**
 * 值形态脱敏。
 *
 * 每次**用 source/flags 重建 RegExp**：模块级正则带 /g 时 .test/.replace 会推进
 * lastIndex，同一份模式在第二个字段上就从中间开始扫 ——
 * 于是"有时脱敏有时不脱敏"，且与字段顺序有关。
 * 按输入顺序变化的安全规则比没有规则更危险，因为它看起来是好的。
 */
export function redactSecretText(s: string): string {
  let out = s;
  for (const { re, name } of SECRET_VALUE_RES) {
    out = out.replace(new RegExp(re.source, re.flags), `«${name}:已脱敏»`);
  }
  return out;
}

/** 截断策略。深结构/自引用响应体不能把报告撑爆（报告生成失败会连累整次运行的证据） */
export interface RedactLimits {
  maxDepth: number;
  maxArray: number;
}

/** 落盘用（trace.jsonl / manifest / JUnit 的 context） */
export const DISK_LIMITS: RedactLimits = { maxDepth: 8, maxArray: 50 };
/** 表达式根与 keyContext 用。刻意比落盘浅：这是给"人看一眼"和"表达式取值"用的，
 *  深对象在那两个场景里没有意义，浅一点还能防住把整个响应体带进表达式作用域 */
export const CONTEXT_LIMITS: RedactLimits = { maxDepth: 6, maxArray: 20 };

/**
 * 结构化数据脱敏。三条规则叠加，缺一不可：
 *  1. 字段名命中 → 整值替换
 *  2. 值形态命中 → 替换命中的那一段（对付 `{"data":"<jwt>"}`）
 *  3. 深度与数组长度有上限
 */
export function redactForDisk(v: unknown, depth = 0, limits: RedactLimits = DISK_LIMITS): unknown {
  if (depth > limits.maxDepth) return '…(已截断)';
  if (typeof v === 'string') return redactSecretText(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'undefined') return String(v);
  if (v instanceof Error) return { name: v.name, message: redactSecretText(v.message), stack: v.stack };
  if (v instanceof Uint8Array) return `«binary ${v.byteLength}B»`;
  if (Array.isArray(v)) return v.slice(0, limits.maxArray).map((x) => redactForDisk(x, depth + 1, limits));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        // 长度留着：排查时"这个字段是空的还是有值"是关键信息，而长度不泄露内容
        out[k] = typeof val === 'string' ? `«字段 ${k} 已脱敏(${val.length} 字符)»` : SECRET_PLACEHOLDER;
        continue;
      }
      out[k] = redactForDisk(val, depth + 1, limits);
    }
    return out;
  }
  return String(v);
}

/**
 * 原始证据文本（响应体 / 页面快照 / logcat）。
 *
 * **这里刻意不做字段名脱敏**：原始体没有结构可言，拿正则猜"这行像不像密码"
 * 会把证据改成无法复现问题的样子。但值形态的密钥照旧替换 ——
 * 那几种模式不会出现在正常业务文本里，误伤概率极低，而漏掉的代价是密钥进磁盘。
 *
 * 需要逐字节原样的场景（调试签名不一致之类）由调用方显式传 keepRaw，
 * 而不是让平台自己决定"我该不该改你的证据"。
 */
export function redactArtifactText(text: string, opts: { keepRaw?: boolean } = {}): string {
  return opts.keepRaw ? text : redactSecretText(text);
}
