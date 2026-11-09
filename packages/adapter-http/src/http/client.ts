/**
 * HTTP 客户端 —— 实现 engine 的 HttpExec 端口（docs/04 M2.6）。
 *
 * 这一层是引擎唯一的出网点，所以 docs/05 §4 那"一段过但每条都会咬"的清单
 * 全在这里落地。逐条的实现理由：
 *
 *  - **默认不跟随重定向**：跟随会让"302 到登录页"被判成功 —— API 测试的经典假绿。
 *  - **响应体上限 + truncated**：一个失控的导出接口能撑爆证据盘。
 *  - **只有幂等方法且网络级错误才自动重试**：POST 重试是重复下单级别的事故。
 *  - **大整数不过 Number**：见 bigint.ts。
 *  - **Content-Encoding 交给 undici**：手写 zlib 分支只会和网关行为分叉。
 *
 * 不做的事也写清楚：**不在这里脱敏**。脱敏发生在"序列化到磁盘那一刻"（docs/02 §5），
 * 在本层脱敏等于让用例断言看不到真实值 —— 断言会因此而失效。
 */
import { parseJsonKeepBigInt, stringifyBody } from './bigint.js';
import { compileValidator, isValid, type Validator } from '../openapi/validate.js';
import type { OperationSpec, ParsedDoc } from '../openapi/parse.js';
import type { ExecContext, HttpExec } from '@atest/engine';
// **type-only**：auth/token.ts 反过来 import 本文件（要 new 一个 HttpClient），
// 这里若做值导入就构成模块环。ESM 能跑但初始化顺序会变脆弱（谁先被求值不确定），
// 而这里的用法只需要类型（AuthHook 实例由 CLI 注入，本文件从不构造它）。
import type { AuthHook } from '../auth/hook.js';

/** 默认响应体上限 10MB（docs/05 §4）。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** 默认总时长上限。真超时比"永远挂着"好。 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** 幂等方法。重试只对它们开放（docs/05 §4）。 */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export interface SendRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** 已解析成 JS 值的请求体。序列化时按 bodySchema 决定是否还原大整数字面量 */
  body?: unknown;
  bodySchema?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  followRedirects?: boolean;
  /** 幂等请求网络级失败时的自动重试次数上限。默认 2；POST 一律 0 */
  retries?: number;
  /** 期望的响应 content-type。非 JSON 时不解析（HTML 错误页很常见） */
  expectJson?: boolean;
}

export interface SendResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** 解析后的响应体。非 JSON 时是原始文本 */
  body: unknown;
  /** 原始响应文本（截断后）。extract/正则/断言都读它 */
  bodyText: string;
  /** 截断前的真实字节数 */
  bytes: number;
  truncated: boolean;
  durationMs: number;
  contentType?: string;
  /** 网络层错误（未收到响应）。有它时 status=0 */
  error?: { kind: 'timeout' | 'network' | 'aborted'; message: string };
}

export interface HttpClientOptions {
  defaultTimeoutMs?: number;
  defaultMaxBytes?: number;
  /** 环境里配的自定义 User-Agent；不写就用可识别的默认值，方便后端排查 */
  userAgent?: string;
  /**
   * fetch 注入点。测试里指向 mock server 的 addr 即可，无需改代码；
   * 也是 SSRF 防护的作用点（服务端可以换成带 allowlist 的实现，docs/11 §8）。
   */
  fetchImpl?: typeof fetch;
  /** 每个响应都过它（鉴权头注入、cookie jar）。 */
  onRequest?: (req: { url: string; method: string; headers: Record<string, string> }) => void | Promise<void>;
  onResponse?: (res: { url: string; status: number; headers: Record<string, string> }) => void | Promise<void>;
}

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.timeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.defaultMaxBytes ?? DEFAULT_MAX_BYTES;
    // 注意：globalThis.fetch 必须**间接调用**。直接 `const f = fetch; f()` 在
    // undici 里会 IllegalInvocation（它要 Receiver 是 globalThis）。
    this.doFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input as never, init as never));
  }

  async send(r: SendRequest): Promise<SendResult> {
    const method = r.method.toUpperCase();
    const wantRetry = IDEMPOTENT.has(method);
    const maxAttempts = wantRetry ? 1 + Math.max(0, r.retries ?? 2) : 1;
    let last: SendResult | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      last = await this.sendOnce(r);
      if (!last.error) return last;
    }
    // 重试耗尽：把最后一次的网络错误原样带出，**不伪造成 5xx**。
    // 合成状态码会让人以为"后端返回了 599"，而真相是压根没连上。
    return last!;
  }

  private async sendOnce(r: SendRequest): Promise<SendResult> {
    const t0 = monoNow();
    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5', ...lowerHeaders(r.headers) };
    if (!headers['user-agent']) headers['user-agent'] = this.opts.userAgent ?? 'atest/0.0';

    let payload: string | URLSearchParams | undefined;
    if (r.form) {
      payload = new URLSearchParams(r.form);
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (r.body !== undefined && r.body !== null) {
      payload = typeof r.body === 'string' ? r.body : stringifyBody(r.body, r.bodySchema);
      headers['content-type'] ??= 'application/json';
    }
    // GET/HEAD 带 body 是 RFC 允许但网关普遍不支持的东西：**不自动转 query**。
    // 自动转换会悄悄改变请求语义（后端可能压根不读 body），报出来让人自己决定。
    if (payload !== undefined && (r.method.toUpperCase() === 'GET' || r.method.toUpperCase() === 'HEAD')) {
      return networkFail('GET/HEAD 请求带了请求体，平台不会自动把它转成 query（那会改变请求语义）。请显式写进 queryParams', t0);
    }

    await this.opts.onRequest?.({ url: r.url, method: r.method, headers });

    const timeoutMs = r.timeoutMs ?? this.timeoutMs;
    // 用自建 AbortController 而不是 AbortSignal.timeout：后者是 Node 专属全局，
    // 而本模块要能在 Worker/浏览器形态下复用（docs/01 §8.2 的同一个理由）。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('atest-timeout')), timeoutMs);
    try {
      const res = await this.doFetch(r.url, {
        method: r.method.toUpperCase(),
        headers,
        body: payload,
        redirect: r.followRedirects ? 'follow' : 'manual',
        signal: ctrl.signal,
        // 不自己解 content-encoding：undici 会按 accept-encoding 自动解，
        // 手工 zlib 分支会和真实网关行为分叉（docs/05 §4 提到的 br 流式 bug 就是这么来的）
      });

      await this.opts.onResponse?.({ url: r.url, status: res.status, headers: flattenHeaders(res.headers) });

      const cap = r.maxBytes ?? this.maxBytes;
      const { text, truncated, bytes } = await readCapped(res, cap);
      const ct = res.headers.get('content-type') ?? undefined;
      const parsed = parseBody(text, ct, r.expectJson);
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: flattenHeaders(res.headers),
        body: parsed.body,
        bodyText: text,
        bytes,
        truncated,
        durationMs: monoNow() - t0,
        contentType: ct,
        ...(parsed.error ? { error: parsed.error } : {}),
      };
    } catch (e) {
      const timedOut = ctrl.signal.aborted && String((ctrl.signal.reason as Error | undefined)?.message ?? '').includes('atest-timeout');
      return networkFail(e instanceof Error ? e.message : String(e), t0, timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 文档登记表：`docRef`（IR 里写的字符串）-> 已解析的 spec。服务端从 DB 取，测试里直接闭包一个。 */
export type DocProvider = (docRef: string) => ParsedDoc;

/**
 * validator 编译不便宜（每份 schema 都要 new 一个 Ajv），按**文档对象身份**缓存。
 *
 * 键刻意不用 `docRef` 字符串：重新导入 spec 后 docRef 没变而 schema 变了，
 * 按字符串键会一直拿**旧 schema** 的校验器 —— 校验"通过"而请求体早就不合法了。
 * docs/05 §1.1 整节讲的就是这种漂移；自己先犯一遍说不过去。
 * WeakMap 让废弃文档的 validator 能被回收。
 */
const validatorCache = new WeakMap<object, Map<string, Validator>>();

function validatorFor(doc: ParsedDoc, op: OperationSpec): Validator | undefined {
  if (!op.requestBodySchema || !Object.keys(op.requestBodySchema).length) return undefined;
  let byOp = validatorCache.get(doc);
  if (!byOp) { byOp = new Map(); validatorCache.set(doc, byOp); }
  let v = byOp.get(op.operationId);
  if (!v) { v = compileValidator(op.requestBodySchema); byOp.set(op.operationId, v); }
  return v;
}

/**
 * 把 HttpClient 接到 engine 的 HttpExec 端口上。
 * 传了 docs 就同时提供 operation 解析与请求侧校验；不传则只有 send
 * （纯 `http` 步骤的场景不需要 spec）。
 */
export function asHttpExec(client: HttpClient, docs?: DocProvider, auth?: AuthHook): HttpExec {
  const find = (docRef: string, ref: { operationId?: string; method?: string; path?: string }) => {
    if (!docs) throw new Error('resolveOperation/validateRequest 需要文档登记表（asHttpExec 的第二个参数）');
    const doc = docs(docRef);
    const op = ref.operationId
      ? doc.byId.get(ref.operationId)
      : doc.operations.find((o) => o.method === ref.method?.toUpperCase() && o.path === ref.path);
    if (!op) throw new Error(`spec 里没有这个 operation：${ref.operationId ?? `${ref.method} ${ref.path}`}（docRef=${docRef}）`);
    return { doc, op };
  };
  return {
    async send(req, ctx: ExecContext) {
      // 鉴权在**发出去之前**落地，且在这里而不是 HttpClient 的 onRequest 里：
      // onRequest 只能改 headers，而 `apiKey in: query` 必须改 URL。
      let url = req.url;
      let headers = req.headers;
      const notes: string[] = [];
      if (auth) {
        const a = await auth.apply({
          url, headers,
          docRef: req.auth?.docRef, operationId: req.auth?.operationId,
          method: req.auth?.method ?? req.method, path: req.auth?.path,
          identity: req.auth?.identity, ref: req.auth?.ref,
        });
        url = a.url;
        headers = a.headers;
        notes.push(...a.notes);
        // log.emitted 而不是 lint.reported：这些是"这次带了什么凭证"的说明，
        // 不是静态检查结论。混进 lint 通道会让 lint 计数与看板把它算成问题
        for (const n of notes) ctx.emit({ kind: 'log.emitted', stepId: undefined, data: { level: 'info', message: n } });
        // AuthRequiredError 不 catch：它是"环境没配凭证"，让它冒到解释器变成 error
        // （解释器对未捕获异常给的正是 error + env-unavailable，判得对）
      }
      const r = await client.send({
        method: req.method,
        url,
        headers,
        body: req.body,
        form: req.form,
        timeoutMs: req.timeoutMs,
        maxBytes: req.maxBytes,
        followRedirects: req.followRedirects,
      });
      // 这里**不发事件**。原先发的是 `ctx.emit({ kind: 'http', status: String(r.status) })`，
      // 两个字段都不合法：'http' 不在 TraceEventKind 枚举里，
      // 而 status 是六态机（pass/fail/...）不是 HTTP 状态码。
      // 引擎侧的 emit 有一句 `kind as TraceEvent['kind']` 把它擦掉了，于是
      // trace.jsonl 写得出、读不回（parseTraceJsonl 按 schema 丢掉整行）——
      // 请求耗时与 truncated 就这么从 trace 里消失了，而文件看起来完好。
      // 现在 kind 是封闭枚举，这类事在**这里**编译期就报。
      // 传输细节（bytes/truncated/状态码）由引擎的 step.finished 带进 trace，
      // 那才是它们该在的地方：一次步骤一条记录，而不是两条对不齐的。
      if (r.error) throw new Error(`HTTP 请求失败：${r.error.kind} — ${r.error.message}`);
      return { status: r.status, headers: r.headers, body: r.body, bodyText: r.bodyText, durationMs: r.durationMs, bytes: r.bytes, truncated: r.truncated };
    },
    async resolveOperation(ref) {
      const { op } = find(ref.docRef, ref);
      return {
        operationId: op.operationId,
        method: op.method,
        urlTemplate: op.urlTemplate,
        requiredBodyFields: op.requiredBodyFields,
        deprecated: op.deprecated,
      };
    },
    async validateRequest(ref, body) {
      const { doc, op } = find(ref.docRef, ref);
      const v = validatorFor(doc, op);
      // 该 operation 压根没有 JSON 请求体（GET/DELETE 极常见）：没有可校验的东西，
      // 返回 ok 是诚实的 —— 引擎侧的 validateRequest 只在"实现了但校验不过"时报错。
      if (!v) return { ok: true, violations: [] };
      if (v.schemaIssues.length) {
        // schema 自己编译不过：绝不能返回 ok —— 那等于这条永远通过
        return { ok: false, violations: [`spec 里的请求 schema 有问题：${v.schemaIssues.join('; ')}`] };
      }
      const r = v(body ?? {});
      return { ok: isValid(r), violations: r.violations.filter((x) => x.severity === 'hard').map((x) => `${x.path} ${x.message}`) };
    },
    async validateResponse(ref, status, body) {
      const { doc, op } = find(ref.docRef, ref);
      const spec = op.responses[String(status)];
      // 该状态码 spec 里没声明 schema（比如只写了 description，或压根没列这个码）：
      // **没什么可校验的**。这里必须与"校验通过"区分开 —— 引擎侧是 report-only，
      // 把"没校验"混进"校验通过"会让契约车道的报表看起来比实际覆盖率高。
      if (!spec?.schema || !Object.keys(spec.schema).length) return { ok: true, violations: [] };
      // 与请求侧共用**同一份按文档身份索引的缓存**（键前缀 resp: 不会与请求侧撞名）。
      // 早先这里用 `op.responses as object` 当键 —— 那是个内部子对象，
      // 语义上"同一次导入的所有响应 validator"要同生共死，用文档本体才说得通。
      const key = `resp:${op.operationId}:${status}`;
      let byOp = validatorCache.get(doc);
      if (!byOp) { byOp = new Map(); validatorCache.set(doc, byOp); }
      let v = byOp.get(key);
      if (!v) { v = compileValidator(spec.schema); byOp.set(key, v); }
      if (v.schemaIssues.length) return { ok: false, violations: [`spec 里 ${status} 的响应 schema 有问题：${v.schemaIssues.join('; ')}`] };
      const r = v(body);
      // 响应侧全部按 contract 级上报：format 不符、字段多一个少一个，
      // 都是"文档与实现谁错了"，不是"功能坏了"（docs/05 §1.1）
      return { ok: isValid(r), violations: r.violations.map((x) => `${x.path} ${x.message}`) };
    },
  };
}

/**
 * 头名统一小写。HTTP 头名大小写不敏感（HTTP/2 直接要求全小写）。
 *
 * 导出给鉴权层用，**不要各写一份**：鉴权的"不覆盖用户显式写的头"这条判据
 * 依赖查找与写入用同一个规范化形态，两处各写一份、其中一份忘了 toLowerCase，
 * 结果就是"人手写的头被 spec 声明静默覆盖" —— 而那正是那条判据要防的事。
 */
export function lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

function flattenHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = out[k] ? `${out[k]}, ${v}` : v; });
  return out;
}

/**
 * 读响应体并**截断**。
 * 用 reader 逐块读而不是先 text() 再截：一个 2GB 的导出接口如果先 text()，
 * 进程在截断之前就已经 OOM 了 —— 截断必须发生在内存里之前。
 */
async function readCapped(res: Response, cap: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared === 0) return { text: '', truncated: false, bytes: 0 };
  if (!res.body) {
    const text = await res.text();
    const buf = new TextEncoder().encode(text);
    return { text: buf.byteLength > cap ? decode(buf.slice(0, cap)) : text, truncated: buf.byteLength > cap, bytes: buf.byteLength };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      const room = Math.max(0, cap - (total - value.byteLength));
      if (room > 0) chunks.push(value.slice(0, room));
      truncated = true;
      // 必须 cancel：不关流的连接会一直占着连接池，跑几百个用例后连接耗尽
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  return { text: decode(merged), truncated, bytes: total };
}

const decoder = new TextDecoder('utf-8', { fatal: false });
const decode = (b: Uint8Array): string => decoder.decode(b);

function parseBody(text: string, ct: string | undefined, expectJson?: boolean): { body: unknown; error?: SendResult['error'] } {
  if (text === '') return { body: null };
  const looksJson = ct?.includes('json') ?? false;
  // 只在**声明了 json** 或用户显式要求时解析。HTML 错误页（网关 502 常见）
  // 若被硬塞给 JSON.parse，报错会是一串没用的 "Unexpected token <"。
  if (!looksJson && !(expectJson && text.trimStart().startsWith('{'))) return { body: text };
  try {
    return { body: parseJsonKeepBigInt(text) };
  } catch (e) {
    return {
      body: text,
      error: { kind: 'network', message: `响应声明是 JSON 但解析失败：${e instanceof Error ? e.message : String(e)}（截断或编码问题？）` },
    };
  }
}

function networkFail(message: string, t0: number, kind: 'timeout' | 'network' | 'aborted' = 'network'): SendResult {
  return {
    status: 0, ok: false, headers: {}, body: null, bodyText: '', bytes: 0, truncated: false,
    durationMs: monoNow() - t0, error: { kind, message },
  };
}

/** 单调时钟。墙上时间会因 NTP/时区倒退，测出的时长可能是负数。 */
function monoNow(): number {
  return performance.now();
}
