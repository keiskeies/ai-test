/**
 * 运行装配：把「磁盘上的 IR 文件 + 环境 + 密钥 + spec」拼成 runScenario 的入参。
 *
 * 这个文件是 CLI 里唯一碰 node:fs / process.env 的地方（args.ts 保持纯函数）。
 * 之所以单独一层而不是散在各个命令里：`run` 与 `agent` 与将来的 `suite`
 * 必须用**同一套**装配逻辑，否则"本地跑绿、CI 跑红"就有了藏身处 ——
 * 而"本地与 CI 跑同一条代码"是 docs/00 §6.6 里 Apifox/Postman/MeterSphere
 * 全都翻过车的那一条。
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  deterministicClock, liveClock, SECRET_PLACEHOLDER,
  type AdapterRegistry, type Clock, type RunOptions,
} from '@atest/engine';
import {
  parseOpenApi, HttpClient, asHttpExec, startMockServer,
  AuthHook, CredentialTable, TokenSource, normalizeSecuritySchemes,
  type AuthConfigRaw, type ParsedDoc, type MockServer,
} from '@atest/adapter-http';
import { createWebAdapter, type WebAdapter } from '@atest/adapter-web';
import { DiskArtifactStore } from '@atest/store';
import { deriveTargets, parseScenario, type Scenario, type ScenarioDraft } from '@atest/ir';

import { EXIT } from './exit.js';

/** CLI 的密钥前缀。真实值只从环境变量取，永远不出现在命令行里 */
export const SECRET_ENV_PREFIX = 'ATEST_SECRET_';

export class CliError extends Error {
  constructor(message: string, readonly code: number, readonly hint?: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * 密钥解析：**只从环境变量取**。
 *
 * 为什么不给 `--secret token=xxx` 这种写法：argv 会被 `ps aux`、shell history、
 * CI 的"打印完整命令行"日志、以及 core dump 全部记录下来。
 * 用环境变量则至少躲开前三条（这也是为什么这里连报错都不回显值）。
 * 报错只说"哪个 ref 没解析到、去设哪个变量" —— 报错信息本身也可能进日志。
 */
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

/** 密钥 ref → 环境变量名。导出以便报错文案与实现同源（两处各拼一份迟早不一致） */
export function secretEnvKey(ref: string): string {
  const name = normalizeSecretRef(ref).replace(/^secret:/, '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return name ? SECRET_ENV_PREFIX + name : '';
}

export function secretResolverFromEnv(
  env: Record<string, string | undefined> = process.env,
  onMissing?: (ref: string) => void,
): (ref: string) => string {
  return (ref: string): string => {
    const key = secretEnvKey(ref);
    // key 为空说明 ref 本身不构成一个可用引用（比如 `$secret.`），
    // 当成"没配到"处理：交回占位符并记进 onMissing，而不是去查一个空变量名
    const v = key ? env[key] : undefined;
    if (v === undefined) {
      // **交回引擎既有的占位符**，而不是自己造一个：
      // 磁盘脱敏规则里有一条是"看起来像占位符的值不再重复脱敏"，
      // CLI 造一个 `«unresolved»` 会让 trace.jsonl 里出现第三种密钥形态。
      onMissing?.(ref);
      return SECRET_PLACEHOLDER;
    }
    return v;
  };
}

export interface LoadedScenario {
  path: string;
  raw: unknown;
  scenario: Scenario;
}

/**
 * 读一个 IR 文件。`.json` 直读，`.jsonc` 允许注释（人手写时一定会写注释）。
 *
 * **用 parseScenario 而不是 defineScenario**：这是 CLI，文件是人/Agent 写的，
 * 不合法是预期内的事，要拿完整 errors 列表驱动修复，而不是抛异常只看到第一条。
 */
export async function loadScenarioFile(path: string): Promise<LoadedScenario> {
  const text = await readMaybe(path);
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new CliError(
      `${path} 不是合法 JSON：${(e as Error).message}`,
      EXIT.INVALID,
      'IR 是 JSON（.jsonc 可带注释）。想让 TS 写用例请用 SDK，它产出的就是同一份 IR',
    );
  }
  const r = parseScenario(raw);
  if (!r.ok || !r.scenario) {
    const list = r.errors.slice(0, 12).map((x) => `  · ${x.path} → ${x.message}`).join('\n');
    const more = r.errors.length > 12 ? `\n  …另有 ${r.errors.length - 12} 处` : '';
    throw new CliError(`${path} 不是合法场景 IR，共 ${r.errors.length} 处问题：\n${list}${more}`, EXIT.INVALID);
  }
  return { path, raw, scenario: r.scenario };
}

/** 文件读不到时给出**下一步能做什么**的报错，而不是 ENOENT 堆栈 */
async function readMaybe(path: string): Promise<string> {
  // '-' 是"从标准输入读"的惯用记号。走 /dev/stdin 而不是 fd 0：
  // readFile(0, 'utf8') 这个重载在 @types/node 里不存在（返回类型退化成 Buffer），
  // 而 /dev/stdin 在 macOS 与 Linux 上都有
  const target = path === '-' ? '/dev/stdin' : path;
  try {
    return await readFile(target, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new CliError(
      code === 'ENOENT' ? `读不到文件：${path}` : `读 ${path} 失败：${(e as Error).message}`,
      EXIT.ENV,
      code === 'EISDIR' ? '这是个目录。IR 是单个 .json 文件' : undefined,
    );
  }
}

/**
 * 去掉 `//` 与 `/* *\/` 行注释，让 `.jsonc` 能读。
 *
 * 只做**字符串外**的注释剥离（逐字符扫描，认引号与转义）。
 * 不用正则一把梭：`"note": "见 //example.com"` 里的 `//` 会被正则吃掉，
 * 那属于"配置被静默改写"，比报个 JSON 错严重得多。
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new CliError('/* 注释没有闭合', EXIT.INVALID);
      // 保留换行数，让报错行号仍对得上原文
      out += text.slice(i, end).split('\n').slice(1).join('\n');
      i = end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 环境配置：`--env staging.json`（文件）+ `--env-var k=v`（覆盖）。
 *
 * `--env-var` 存在的理由是 CI 里最常见的一个动作：同一个环境文件、
 * 换 baseUrl 或换 revision。没有它就得为每次覆写生成一个临时文件，
 * 而临时文件会进 git status。
 *
 * 值一律按字符串给。IR 里 `$env.someNumber` 参与比较时引擎做宽松相等（looseEq），
 * 所以不猜类型（`--env-var port=8081` 猜成 number 就再也传不出字符串 "8081"）。
 */
export function buildEnv(envFile: string | undefined, overrides: string[]): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  if (envFile) {
    const parsed = readJsonSync(envFile);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError(`${envFile} 必须是 JSON 对象（键值对），实际是 ${Array.isArray(parsed) ? '数组' : typeof parsed}`, EXIT.ENV);
    }
    Object.assign(env, parsed);
  }
  for (const kv of overrides) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new CliError(`--env-var 要写成 k=v，实际是 "${kv}"`, EXIT.USAGE);
    const key = kv.slice(0, eq);
    /**
     * **拒绝带点号的键。** 这不是洁癖，是被一个具体写法逼出来的：
     * `--env-var auth.default.secret=secret:x` 看着完全合理，实际这里会存进一个
     * 名字就叫 `"auth.default.secret"` 的扁平键，而鉴权层读的是 `env.auth` ——
     * **配了而完全没生效**，表现是"我明明传了凭证"。
     *
     * 也不是"暂不支持、将来再说"：引擎侧 `$env.a.b` 走的是 queryOne 路径查询
     * （vars.ts 的 root==='env' 分支），扁平的点号键**在任何用法下都取不到**。
     * 所以这里不存在"现在能用、以后更好用"的中间态，只能当场说清。
     */
    if (key.includes('.')) {
      throw new CliError(
        `--env-var 表达不了嵌套结构（"${key}" 会被存成一个名字里带点号的扁平键，谁也读不到它）。`,
        EXIT.USAGE,
        '把嵌套部分写进环境文件（--env ./myenv.json，形如 {"baseUrl":"…","auth":{"default":{"secret":"secret:<ref>"}}}）；只有 baseUrl 这类扁平值适合用 --env-var',
      );
    }
    env[key] = kv.slice(eq + 1);
  }
  return env;
}

/** 同步读 JSON —— 只在 buildEnv 里用（装配是一次性的，异步化会让每个命令多两层 await）。
 *  单独一个小函数是为了让"这里有同步 IO"这件事在代码里可见，而不是藏在文件顶部的 import 里 */
/** 读一个 JSON/JSONC 文件并解析。名字里的"同步"是刻意的：装配是一次性的，
 *  为它给每个命令加两层 await 不值，但同步 IO 必须在代码里看得见，
 *  所以单独成函数而不是内联在 buildEnv 里。 */
function readJsonSync(path: string): unknown {
  return JSON.parse(stripJsonComments(readFileSyncSafe(path)));
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new CliError(code === 'ENOENT' ? `读不到文件：${path}` : `读 ${path} 失败：${(e as Error).message}`, EXIT.ENV);
  }
}

/**
 * 已导入的 OpenAPI 文档登记表（docRef -> ParsedDoc）。
 *
 * `openapiCall` 步骤**必须**有它：asHttpExec 的第二个参数缺省时，
 * 引擎调 resolveOperation 会抛"需要文档登记表"。CLI 的报错要指到开关名，
 * 否则用户看到的是引擎内部术语。
 */
export class DocRegistry {
  private docs = new Map<string, ParsedDoc>();
  private constructor(private readonly files: Map<string, string>) {}

  static async load(specArgs: string[]): Promise<DocRegistry> {
    const reg = new DocRegistry(new Map());
    for (const item of specArgs) {
      // 形式：`name=path`，或只给 path（docRef 取文件名主干）
      const eq = item.indexOf('=');
      const name = eq > 0 ? item.slice(0, eq) : baseName(item.replace(/\.(ya?ml|json)$/i, ''));
      const path = eq > 0 ? item.slice(eq + 1) : item;
      const text = await readMaybe(path);
      let raw: unknown;
      try {
        raw = JSON.parse(stripJsonComments(text));
      } catch {
        throw new CliError(
          `${path} 暂时只支持 JSON 形态的 OpenAPI 文档（YAML 解析需要一个 YAML 依赖，本机离线装不上）`,
          EXIT.ENV,
          '先用 `npx swagger2openapi` 之类转成 JSON，或在 IR 里用普通 http 步骤',
        );
      }
      let doc: ParsedDoc;
      try {
        doc = parseOpenApi(raw);
      } catch (e) {
        throw new CliError(`${path} 解析失败：${(e as Error).message}`, EXIT.ENV);
      }
      reg.docs.set(name, doc);
      reg.files.set(name, path);
    }
    return reg;
  }

  empty(): boolean { return this.docs.size === 0; }
  names(): string[] { return [...this.docs.keys()]; }
  get(ref: string): ParsedDoc | undefined { return this.docs.get(ref); }
  fileOf(ref: string): string | undefined { return this.files.get(ref); }

  /** 给 asHttpExec 的 provider。找不到时抛**带 docRef 与现有 docRef 列表**的错 */
  provider(): (docRef: string) => ParsedDoc {
    return (docRef: string) => {
      const d = this.docs.get(docRef);
      if (!d) {
        throw new CliError(
          `IR 引用了 docRef="${docRef}"，但本次运行没有导入它（已导入：${this.names().join(', ') || '无'}）`,
          EXIT.ENV,
          `加一个 --doc ${docRef}=<openapi.json>`,
        );
      }
      return d;
    };
  }
}

function baseName(p: string): string {
  const seg = p.split('/').pop() ?? p;
  return seg.replace(/[^A-Za-z0-9_-]/g, '_') || 'doc';
}

/**
 * 建鉴权层（docs/05 §2）。分开成函数是因为 `atest auth-check` 要用**同一套**装配 ——
 * 那条命令的全部价值是"不跑用例也能回答鉴权对不对"，
 * 而它要是自己再拼一遍凭证解析，就会与真正发请求时的那套不一致，
 * 于是"auth-check 说没问题、跑起来还是 401"，那条命令就变成误导。
 */
export function buildAuthHook(o: {
  registry: DocRegistry;
  env: Record<string, unknown>;
  resolveSecret: (ref: string) => string | undefined;
  environmentRef: string;
  /** 确定性时钟的 now。oauth2 的 token 缓存要跟着它，否则 --clock deterministic 下过期判断用墙上时间 */
  now: () => number;
  fetchImpl?: typeof fetch;
}): { hook: AuthHook; table: CredentialTable; notes: string[]; tokenSources: Map<string, TokenSource> } {
  const { table, notes } = CredentialTable.fromEnv(o.env.auth as AuthConfigRaw | undefined);
  const tokenSources = new Map<string, TokenSource>();

  const hook = new AuthHook({
    doc: (docRef) => {
      const doc = o.registry.get(docRef);
      if (!doc) return undefined;
      return {
        securitySchemes: doc.securitySchemes,
        operation: (ref) => {
          const op = ref.operationId
            ? doc.byId.get(ref.operationId)
            : doc.operations.find((x) => x.method === ref.method?.toUpperCase() && x.path === ref.path);
          return op ? { security: op.security } : undefined;
        },
      };
    },
    table,
    resolveSecret: o.resolveSecret,
    tokenSources,
    cookieHeader: undefined, // cookie jar 是 P1（docs/05 §2 的会话那一行）
  });

  // oauth2 的 token 源按 docRef 建。两个容易踩的点都在这段里处理了：
  //  1. spec 里的 tokenUrl **经常是相对的**（`/oauth/token`，甚至只有 host）。
  //     直接拿它发请求会得到"相对 URL"错误或打到 localhost，
  //     而报出来的错与"配置错了"这件事隔了几层。
  //  2. token 端点走**独立的 HttpClient**（不带鉴权 hook）。
  //     带 hook 会递归取 token —— 这不是理论问题，interceptor 会问 TokenSource 要 token。
  const baseUrl = typeof o.env.baseUrl === 'string' ? o.env.baseUrl : undefined;
  for (const docRef of o.registry.names()) {
    const doc = o.registry.get(docRef);
    if (!doc) continue;
    const { schemes } = normalizeSecuritySchemes(doc.securitySchemes);
    for (const sc of schemes.values()) {
      if (sc.kind !== 'oauth2' || !sc.tokenUrl) continue;
      tokenSources.set(docRef, new TokenSource({
        tokenUrl: absoluteUrl(sc.tokenUrl, baseUrl),
        environmentRef: o.environmentRef,
        resolveSecret: o.resolveSecret,
        now: o.now,
        fetchImpl: o.fetchImpl,
      }));
      break; // 一个 docRef 一个源；多 scheme 的 scope 差异已经进了缓存 key
    }
  }
  return { hook, table, notes, tokenSources };
}

/**
 * 建"一次运行所需的鉴权装配"：凭证解析 + hook + 发请求的 client。
 *
 * `assemble` 与 `atest auth-check` **共用这一个函数**。这是有意的：
 * auth-check 的全部价值是"不跑用例也能回答鉴权对不对"，而那份回答必须来自
 * 与真实请求完全相同的装配 —— 自己再拼一遍就会不一致，
 * 于是"auth-check 说没问题、跑起来还是 401"，那比没这条命令更坏。
 *
 * 连 HttpClient 实例都在这里建：SSRF allowlist 之类的选项将来会加在
 * HttpClientOptions 上，两处各 new 一份的话，将来 auth-check 会走一条
 * **没有 allowlist** 的路去打内网地址。
 *
 * `envVars` 默认 process.env；测试里传一个进来 ——
 * 本仓的 CLI 测试一律不碰 process.env（改了要记得还原，忘了就污染同文件后面的用例）
 */
export function buildAuthLayer(o: {
  registry: DocRegistry;
  env: Record<string, unknown>;
  environmentRef: string;
  now: () => number;
  envVars?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): {
  hook: AuthHook; table: CredentialTable; notes: string[]; client: HttpClient;
  resolveSecret: (ref: string) => string; missingSecrets: Set<string>;
} {
  const missingSecrets = new Set<string>();
  const resolveSecret = secretResolverFromEnv(o.envVars ?? process.env, (r) => { void missingSecrets.add(r); });
  const built = buildAuthHook({
    registry: o.registry, env: o.env, resolveSecret,
    environmentRef: o.environmentRef, now: o.now, fetchImpl: o.fetchImpl,
  });
  // 凭证表引用了、环境里没有值的密钥也要扫出来：env 配了 auth 段而 IR 不引用
  // 任何 secret 是完全可能的（鉴权完全由 spec 声明驱动，这正是"生成的用例不该全 401"的目标形态）
  for (const ref of built.table.refs()) resolveSecret(ref);
  return { ...built, client: new HttpClient({ fetchImpl: o.fetchImpl }), resolveSecret, missingSecrets };
}

/** 把 spec 里的 tokenUrl 变成绝对 URL。拼不出来就原样交出去（让 HTTP 层报它自己的错，别在这层编一个） */
export function absoluteUrl(tokenUrl: string, baseUrl: string | undefined): string {
  if (/^https?:\/\//i.test(tokenUrl)) return tokenUrl;
  if (!baseUrl) return tokenUrl;
  try {
    return new URL(tokenUrl.startsWith('/') ? tokenUrl : `/${tokenUrl}`, baseUrl.replace(/\/+$/, '') + '/').toString();
  } catch {
    return tokenUrl;
  }
}

export interface AssembleOptions {
  scenario: Scenario;
  env: Record<string, unknown>;
  registry: DocRegistry;
  /** 证据落盘目录。空 = 仍建包，但证据只存在于内存（会告警） */
  evidenceDir: string;
  clock: Clock;
  envRevision?: number;
  inputs?: Record<string, unknown>;
  runId?: string;
  maxCostUsd?: number;
  /**
   * `call` 步骤的子场景解析器。**由调用方构造后注入**，不在这里造，理由有两条：
   *  1. `paths.ts` 从本文件 import（CliError / stripJsonComments），
   *     这里再 import 回去就是循环依赖；
   *  2. 更重要的是**装配点才知道场景从哪来**：`run --scenario <路径>` 的搜索根是那个
   *     文件所在目录，而 `agent` 生成的场景可能压根没落盘。把"怎么找子场景"
   *     留在调用方，本层只管把它交给引擎。
   *
   * 缺省时 `call` 步骤会报"解析器未注入"（error，不是跳过）—— 引擎侧那条
   * 以前是个 `adapters.callScenario is not a function` 的 TypeError。
   */
  callScenario?: AdapterRegistry['callScenario'];
}

export interface Assembled {
  runOptions: RunOptions;
  store: DiskArtifactStore;
  /** 起了 mock 才有；调用方必须在结束时关掉 */
  mock?: MockServer;
  /** 场景用到 Web 步骤时才建。**调用方必须在结束时 close** ——
   *  不关就是每次 run 留一个 Chrome 进程 + 一个几百 MB 的临时 profile，
   *  而症状（跑到第 N 条变慢/磁盘涨）离原因是两步远 */
  web?: WebAdapter;
  /** 装配期发现的告警（密钥缺失、mock 提示等），统一在 run 后打印 */
  warnings: string[];
  /** 没解析到真实值的密钥 ref。命令侧用它决定"这次失败该不该归因于环境" */
  missingSecrets: Set<string>;
}

/**
 * 装配一次运行。
 *
 * 时钟默认 liveClock，`--clock deterministic` 换确定性时钟（M7 的 20 次一致性
 * 靠它，否则两次运行的 durMs/时间断言必然不同）。
 */
export async function assemble(o: AssembleOptions): Promise<Assembled> {
  const warnings: string[] = [];
  const store = new DiskArtifactStore({ dir: o.evidenceDir });

  const adapters: AdapterRegistry = { artifactStore: store };
  let builtWeb: WebAdapter | undefined;
  if (o.callScenario) adapters.callScenario = o.callScenario;

  /**
   * 鉴权装配（凭证解析 + hook + client）。**建在最前面**，
   * 因为下面扫 IR 用的 secretResolver 必须是**同一个**：
   * 两处各调 secretResolverFromEnv 的话就有两个缺失集合，
   * 而"两处各一份迟早只更新其中一处"正是这个文件反复记的那个毛病。
   */
  const auth = buildAuthLayer({
    registry: o.registry, env: o.env,
    // 环境的 auth 段/凭证都按环境名分桶，token 缓存 key 也用它
    environmentRef: o.scenario.env.environmentRef,
    now: () => o.clock.now(),
  });
  for (const n of auth.notes) warnings.push(`env 的 auth 段：${n}`);
  const missingSecrets = auth.missingSecrets;
  const resolve = auth.resolveSecret;
  // 凭证表引用的密钥已在 buildAuthLayer 里扫过，IR 里引用的在这里扫（同一个集合）

  // 装配期**扫一遍 IR** 而不是等运行期撞上了再说：
  // 一个 $secret 没解析到，登录接口就返回 401，用例于是"失败"，
  // 而真相是环境没配密钥 —— 这是 API 平台的第一体验杀手（docs/05 §2），
  // 报错必须在跑之前直说"缺哪个变量"。
  // 运行期真正解析失败时也记进同一个集合（IR 里有动态 ref 时扫不出来），
  // 所以这里是"提前告警"，不是"唯一来源"。
  for (const ref of scanSecretRefs(o.scenario)) resolve(ref); // 只为填 missingSecrets；返回值这里不用

  // http adapter **无条件注册**。
  // 原来这里写的是 `if (!o.registry.empty())` —— 于是"只用了 http 步骤、没导 spec"的
  // 场景（这是最常见的第一条用例）永远得到 "http adapter 未注册"。
  // spec 只有 openapiCall 才需要（asHttpExec 的第二个参数只服务 resolveOperation），
  // 把"有没有文档"当成"要不要网络"是两件事被一个条件绑走了。
  // 单测里没抓到，是因为 e2e 用例都会传 --doc；而手工写 http 步骤这条路没人走过。
  adapters.http = asHttpExec(auth.client, o.registry.empty() ? undefined : o.registry.provider(), auth.hook);

  /*
   * **Web adapter 按需建**（场景里有 web 档的步骤才建）。
   *
   * 三条理由，都不涉及性能：
   *  1. 起一个 Chrome 要 1~2s 并占几百 MB，纯 API 场景不该付这个钱；
   *  2. 更重要：**没装浏览器的机器上，纯 API 用例必须照跑**。
   *     无条件建的话 ATEST_BROWSER_BIN 缺失会让所有 run 一起失败，
   *     那等于用一个端的配置问题去阻塞另一个端；
   *  3. 判据用 STEP_TARGET 而不是"扫一下有没有 navigate"。后者要认 kinds，
   *     而 kinds 与端的对应关系已经在 IR 里写过一遍 —— 再扫一份就是两份会漂移的表
   *     （这个仓库为这类漂移记过不止一次账）。
   */
  if (needsWeb(o.scenario)) {
    const bin = process.env.ATEST_BROWSER_BIN;
    if (!bin) {
      // **装配期报错，不进 run**。理由与 requireAdapters 同源：浏览器没配是一个
      // 确定的配置缺失，让它以 env-unavailable 的身份进退出码，流水线就会照
      // CI_HINT 重试一次 —— 而配置缺失重试一万次也不会好。
      // 报错里不打印任何 ATEST_SECRET_* 之类的环境值，只说该设哪个变量。
      throw new CliError(
        '本次场景用到 Web 步骤，但没配浏览器：设环境变量 ATEST_BROWSER_BIN=<chrome/chromium 路径>。',
        EXIT.ENV,
        '本工具不自动探测浏览器安装路径：静默挑一个，等于让"用的是哪个浏览器版本"变成不可复现的事',
      );
    }
    try {
      const web = await createWebAdapter({
        bin,
        // 视口/语言/时区全部来自环境配置，并且**记进 meta 供环境指纹用**。
        // docs/06 §1 那条"响应式断点相关的用例今天过明天挂且查不出来"，
        // 治法就是把这三样固定下来并写进 run 指纹，而不是让它们随机器默认值漂
        ...(typeof o.env.viewport === 'string' ? parseViewport(o.env.viewport) : {}),
        ...(typeof o.env.locale === 'string' ? { locale: o.env.locale } : {}),
        ...(typeof o.env.timezoneId === 'string' ? { timezoneId: o.env.timezoneId } : {}),
      });
      adapters.ui = web.ui;
      /*
       * 页面内请求观测口。**起了浏览器就必须接上**：`wait{response}` 与
       * `expectResponse` 只有这一条路能拿到数据（引擎不许碰网络）。
       * 漏接的后果不是"这两个字段不生效"那么安静 —— 它们会抛 NoNetworkObserver，
       * 报成 error + env-unavailable（"平台没接线"），这是**如实**的结论；
       * 但既然浏览器就在手边，让它如实报错不如让它接上。
       * （以前这里的症状是"永远超时 + 摘要说接口没回来"，把接线缺失说成产品问题。）
       */
      adapters.network = { responsesSince: (s) => web.responsesSince(s) };
      builtWeb = web;
    } catch (e) {
      // 浏览器路径写错/起不来同样是**装配期**的配置问题（见上）。
      // adapter 那边已经把 spawn error 收敛成正常异常了，这里只补一句上下文
      throw new CliError(`起浏览器失败：${e instanceof Error ? e.message : String(e)}`, EXIT.ENV);
    }
  }

  const runOptions: RunOptions = {
    scenario: o.scenario,
    adapters,
    clock: o.clock,
    env: o.env,
    envRevision: o.envRevision,
    inputs: o.inputs,
    runId: o.runId,
    maxCostUsd: o.maxCostUsd,
    secretResolver: resolve,
  };

  if (missingSecrets.size) {
    warnings.push(
      `以下密钥没有解析到真实值，运行时会用占位符（大概率导致 401 类失败）：\n` +
      [...missingSecrets].map((r) => `  · ${r} → 设环境变量 ${secretEnvKey(r)}`).join('\n'),
    );
  }

  return { runOptions, store, warnings, missingSecrets, ...(builtWeb ? { web: builtWeb } : {}) };
}

/**
 * 场景是否用到 Web 端的步骤。
 *
 * 直接用 IR 的 **deriveTargets**（那张 kind → 端 的表的唯一权威消费者），
 * 不自己扫 kind 列表，也不自己写递归。三个理由同一个形状：
 *  - 列一份 `['navigate','act','capture','assertPage']` 会一直"对"到某天新增一个
 *    web kind，之后它安静地不再命中，症状是"新 kind 报 ui adapter 未注册"；
 *  - 自己写递归会漏 switch 的 cases（CHILD_KEYS 之外），漏了的表现与清单漂移一样；
 *  - STEP_TARGET 与 CHILD_KEYS 都在 IR，本层重抄一份就是本仓记过多次的
 *    "两处各一份，迟早只更新其中一处"。
 */
export function needsWeb(scenario: Scenario): boolean {
  return deriveTargets(scenario.body).includes('web');
}

/** 环境里的 `viewport: "1440x900@2"` -> adapter 的参数。写错就报错，不猜默认值 */
function parseViewport(v: string): { viewport: { width: number; height: number; deviceScaleFactor?: number } } {
  const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(v.trim());
  if (!m) throw new CliError(`env.viewport 要写成 "宽x高" 或 "宽x高@倍率"，实际是 "${v}"`, EXIT.ENV);
  return { viewport: {
    width: Number(m[1]), height: Number(m[2]),
    ...(m[3] ? { deviceScaleFactor: Number(m[3]) } : {}),
  } };
}

/** `--local` 起的 mock：让"clone 完第一条命令就能跑出证据包"成立。
 *  单独一个函数而不是塞进 assemble —— 只有 --local 这条路需要它 */
export async function startLocalMock(registry: DocRegistry, warnings: string[]): Promise<MockServer> {
  const first = registry.names()[0];
  if (!first) throw new CliError('--local 需要至少一份 spec：--local 要配 --doc shop=<openapi.json>', EXIT.USAGE);
  const doc = registry.get(first)!;
  const issues: string[] = [];
  const mock = await startMockServer(doc, { selfCheckIssues: issues });
  warnings.push(
    `已对本地 mock 运行（${mock.addr}），**这不是真实后端**：本次结果只能证明"用例能跑通"，不能证明产品行为`,
    ...(issues.length ? [`spec 自身有 ${issues.length} 处结构与声明不一致（前 3 条）：`, ...issues.slice(0, 3).map((s) => `  · ${s}`)] : []),
  );
  return mock;
}

/**
 * 扫出场景里所有 `secret:` 引用（用于装配期告警）。
 *
 * 为什么自己扫而不用 lint：lint 报的是"写法问题"，这里是"环境缺不缺东西"，
 * 后者需要 IR 全量遍历但不该产出任何门禁结论。
 */
export function scanSecretRefs(scenario: unknown): string[] {
  const out = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      // 三种形态都认（见 normalizeSecretRef）。原来只认 `^secret[:.]`，
      // 于是 IR 里写 `{path: '$secret.api_token'}` 时**装配期告警整个不触发** ——
      // 用例跑到一半拿占位符去请求，失败原因显示为断言不成立，
      // 而真相是密钥没配：这正是我们声称要防住的"第一体验杀手"
      const n = normalizeSecretRef(v);
      if (n) out.add(n);
      return;
    }
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const [k, x] of Object.entries(v)) {
      // auth 字段整个是密钥引用；其余递归
      if (k === 'auth' && typeof x === 'string') { const n = normalizeSecretRef(x); if (n) out.add(n); continue; }
      walk(x);
    }
  };
  walk(scenario);
  return [...out];
}

/** 证据包与 trace/junit 的落盘位置 */
export function evidencePaths(dir: string, runId: string): { dir: string; storeDir: string } {
  return { dir, storeDir: join(dir, 'artifacts') };
}

export function makeClock(mode: string | undefined, seed: number | undefined): Clock {
  if (mode === undefined || mode === 'live') return liveClock();
  if (mode === 'deterministic') {
    if (seed !== undefined && !Number.isFinite(seed)) throw new CliError(`--seed 要是一个数字，实际是 "${seed}"`, EXIT.USAGE);
    return deterministicClock(seed ?? 1);
  }
  throw new CliError(`--clock 只支持 live | deterministic，实际是 "${mode}"`, EXIT.USAGE);
}

export type { ScenarioDraft };
