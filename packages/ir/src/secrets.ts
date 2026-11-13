/**
 * 密钥引用的**名字**规矩：`secret:<ref>` -> 环境变量名，以及反过来按名字取值。
 *
 * ## 为什么住在 ir 而不是 cli
 * 原来这三样在 `packages/cli/src/wiring.ts`。但压测那条路也需要它，而且是**两个**地方：
 *  - 内置后端发请求那一刻要按 ref 取真值（`adapter-http`）；
 *  - 生成出来的 k6 脚本要从 `__ENV.ATEST_SECRET_*` 取（预lude，打进 bundle）。
 * 而分层规则不许 `adapter-http` import `packages/cli`（cli 是唯一组装 engine+adapter+store
 * 的包，docs/01 §8.2）。这时候只有两条路：把同一段归一**抄第二份**，或者把它挪到
 * 两边都能依赖的最底层。抄一份的坏法是有名字的：`normalizeSecretRef` 那段注释记着
 * 一次真实修正（`$secret.db_pw` 早期被 replace 成 `_secret_db_pw`，于是报错让人去设
 * `ATEST_SECRET__SECRET_DB_PW`，设了也不生效 —— **报错本身是错的比不报错更坏**）。
 * 那种修正只会落进被改的那一份。
 *
 * 本文件只管**名字**，不管值的存放与解密，也不碰 `process.env`（env 由调用方给）——
 * 于是它能进浏览器、能进 k6 的 goja（那条路要同步、要零 node 依赖）。
 *
 * ## 不许在这里发生的事
 *  - 不许打日志、不许把值拼进任何错误文案（值可能进 CI 日志）。取值函数**返回 undefined**
 *    而不是抛，"没配到"这句话由调用方在有上下文的地方说。
 *  - 不许给"命令行传密钥"开后门。argv 会被 `ps aux`、shell history、CI 的
 *    "打印完整命令行"日志全部记录 —— 环境变量至少躲开前三条，这是这条边界的理由本身。
 */

/** 密钥环境变量前缀。真实值只从带这个前缀的环境变量取，永远不出现在命令行里 */
export const SECRET_ENV_PREFIX = 'ATEST_SECRET_';

/**
 * 把 IR 里三种密钥写法归一成同一个 ref。
 *
 * IR 侧确实存在多种形态（不是历史包袱，是两种字段类型）：
 *   `auth: 'secret:db_pw'`          —— SecretRefSchema，纯字符串
 *   `{ path: '$secret.db_pw' }`     —— ValueSchema 的引用形态（引擎按变量根解析）
 *   `{ path: '$.secret.db_pw' }`    —— 同一个根的显式写法
 * 引擎**最终都会**调 secretResolver('secret:db_pw')（见 vars.ts 的 root==='secret' 分支），
 * 所以归一必须与之对齐。早先这里只认 `^secret[:.]`，于是 `$secret.db_pw`
 * 一路 replace 成 `_secret_db_pw` -> 环境变量名变成 ATEST_SECRET__SECRET_DB_PW，
 * 用户照着报错去设变量，设了也不生效 —— **报错本身是错的**，比不报错更坏。
 */
export function normalizeSecretRef(ref: string): string {
  const t = ref.trim().replace(/^\$?\.?/, '');
  // 必须真的带 `secret[:.]` 前缀才归一。不加这个检查的话 `$secret`（写漏了 ref 名）
  // 会变成 secret:secret，而引擎对它的调用是 secretResolver('secret:') ——
  // 两边名字不同，"按报错去设变量"就会设一个永远读不到的变量
  const m = /^secret[:.]([\w.-]+)$/.exec(t);
  return m ? `secret:${m[1]}` : '';
}

/**
 * 密钥 ref -> 环境变量名。**全仓只有这一处**拼这个名字（报错文案与取值都调它，
 * 两处各拼一份迟早不一致，而不一致的方式是"照报错设了变量而没生效"）。
 * 不构成可用引用时返回空串 —— 调用方**不许**拿空串去查 env（那会命中一个空变量名）。
 */
export function secretEnvKey(ref: string): string {
  const name = normalizeSecretRef(ref).replace(/^secret:/, '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return name ? SECRET_ENV_PREFIX + name : '';
}

/**
 * 按 ref 从一份环境里取真值；没配到返回 `undefined`。
 *
 * 分成"取值"与"没配到怎么办"两半是**故意的**：功能回归那条路要交回引擎的占位符
 * （`SECRET_PLACEHOLDER`，磁盘脱敏规则认它），而压测那条路要**抛**（发一个没鉴权的请求
 * 会产出一条"全是 401"而看起来像产品坏了的曲线）。两种下场都不该由这个名字层决定。
 */
export function secretFromEnv(ref: string | undefined, env: Record<string, unknown>): string | undefined {
  if (!ref) return undefined;
  const key = secretEnvKey(ref);
  if (!key) return undefined;
  const v = env[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
