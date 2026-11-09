/**
 * 由 spec 生成 mock server（docs/05 §6「Mock 来源必须是 spec，不是手写脚本」，
 * docs/04 M2 判据「打本地 mock server（mock 由 spec 生成）全绿」）。
 *
 * 价值不在"能起一个 server"，而在**引擎自测不依赖任何真实后端** ——
 * 这条对 CI 稳定性价值极大：跑测试要内网可达的 staging，
 * 等于把 CI 的可用性外包给别人的运维。
 *
 * 响应值的取材优先级（docs/05 §6「按 examples 优先」）：
 *   spec 里的 example/examples  >  schema 的 enum[0]/示例性约束  >  按类型造
 * 造数据一律**确定性**（不用 Math.random）：mock 每次返回不一样的东西，
 * 用它写的用例就成了 flaky 制造机，而 flaky 的锅会扣在平台头上。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isCycleNode } from '../openapi/refs.js';
import { styleParam } from '../openapi/style.js';
import type { OperationSpec, ParsedDoc } from '../openapi/parse.js';

export interface MockOptions {
  /** 未匹配到 operation 时的行为。默认 404 —— **不要**默认 200，
   *  那会让"路径写错的用例"变成通过的用例。 */
  onUnmatched?: 'reject' | 'empty';
  /** 响应结构 vs schema 的自检结果。传数组则收集问题（不阻断），用于暴露 spec 自身的问题 */
  selfCheckIssues?: string[];
  /** 未匹配时的状态码，默认 404 */
  unmatchedStatus?: number;
}

export interface MockServer {
  /** 形如 http://127.0.0.1:54321，直接当环境的 baseUrl 用 */
  addr: string;
  close(): Promise<void>;
  /** 收到的请求，供断言"请求真的按 spec 序列化了" */
  requests: Array<{ method: string; url: string; path: string; query: Record<string, string[]>; headers: Record<string, string>; body: unknown }>;
}

/**
 * 起一个 mock server。默认绑 127.0.0.1 且端口 0（随机）：
 * 绑随机端口才能并行跑多个测试进程；绑 127.0.0.1 才不会被局域网打到。
 */
export async function startMockServer(doc: ParsedDoc, opts: MockOptions = {}): Promise<MockServer> {
  const routes = buildRoutes(doc, opts);
  const requests: MockServer['requests'] = [];

  const server = createServer((req, res) => {
    void handle(req, res, routes, requests, opts);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const info = server.address() as AddressInfo;
  return {
    addr: `http://127.0.0.1:${info.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

interface Route {
  op: OperationSpec;
  /** 段列表，参数段标为 * */
  segs: string[];
  /** 200/201 之类状态码 -> 响应体 */
  responses: Array<{ status: number; body: unknown }>;
}

function buildRoutes(doc: ParsedDoc, opts: MockOptions): Route[] {
  const routes: Route[] = [];
  for (const op of doc.operations) {
    const okCodes = Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c)).sort();
    // 一条 2xx 响应都没有时**不能编一个 200 空对象**：那会让"接口返回空"
    // 这种真实缺陷被 mock 的兜底掩盖掉。这里返回空 body + 原状态码，
    // 并在 selfCheckIssues 里记一条"spec 没给 2xx"。
    const responses: Array<{ status: number; body: unknown }> = [];
    for (const code of okCodes.length ? okCodes : ['200']) {
      const spec = op.responses[code];
      if (!okCodes.length) {
        opts.selfCheckIssues?.push(`${op.method} ${op.path}: spec 未声明任何 2xx 响应，mock 只能返回空体`);
      } else if (!spec?.schema) {
        // 声明了 2xx 却没写 content/schema —— 真实 spec 里极常见（"200 就完事了"）。
        // 这必须记下来：mock 此时只能回空体，用它写的用例**注定断不到任何东西**，
        // 而用户看到的现象是"用例绿了"，这是最容易被忽略的无效覆盖。
        opts.selfCheckIssues?.push(`${op.method} ${op.path} ${code}: spec 声明了 2xx 但没给 schema，mock 只能返回空体（该接口的响应用例不会有实际断言）`);
      }
      const body = pickResponseBody(op, code, spec?.schema, opts);
      responses.push({ status: Number(code), body });
    }
    routes.push({ op, segs: op.path.split('/').filter(Boolean).map((s) => (/^\{[^}]+\}$/.test(s) ? '*' : s)), responses });
  }
  // 静态段优先于参数段：`/users/me` 必须赢过 `/users/{id}`，
  // 否则"查当前用户"会被当成"查 id 为 me 的用户"，用例照样 200，错的却是路由。
  routes.sort((a, b) => score(b) - score(a));
  return routes;
}

const score = (r: Route): number => r.segs.filter((s) => s !== '*').length;

function pickResponseBody(op: OperationSpec, code: string, schema: Record<string, unknown> | undefined, opts: MockOptions): unknown {
  const ex = op.examples[code];
  if (ex !== undefined) return ex;
  if (!schema) return null;
  const v = sampleFromSchema(schema, 0);
  void validateSample(op, code, v, opts);
  return v;
}

/**
 * 按 schema 造一个**确定性**示例值。
 * 深度上限 3 + 环标记处返回 null（docs/05 §1：「循环 schema 在生成测试数据时
 * 深度上限 3 + 环检测，否则栈溢出」）。
 */
export function sampleFromSchema(schema: unknown, depth = 0): unknown {
  if (depth > 3 || schema === null || typeof schema !== 'object') return null;
  if (isCycleNode(schema)) return null;
  const s = schema as Record<string, unknown>;

  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.const)) return s.const[0];
  const def = s.default;
  if (def !== undefined) return def;

  // oneOf/anyOf：取第一个分支。响应侧断言按"匹配任一分支"，所以取哪个都成立
  const branches = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(branches) && branches.length) return sampleFromSchema(branches[0], depth + 1);
  if (Array.isArray(s.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const b of s.allOf) Object.assign(merged, sampleFromSchema(b, depth + 1) ?? {});
    return merged;
  }

  const t = s.type;
  const type = Array.isArray(t) ? t.find((x) => x !== 'null') : t;
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props);
      const out: Record<string, unknown> = {};
      // 只造 required 字段：多造字段会让"响应结构比文档多"这类契约问题看不见
      for (const k of required) if (k in props) out[k] = sampleFromSchema(props[k], depth + 1);
      return out;
    }
    case 'array': {
      const one = sampleFromSchema(s.items, depth + 1);
      return one === null && depth >= 2 ? [] : [one];
    }
    case 'string': return sampleString(s);
    case 'integer':
    case 'number': return sampleNumber(s);
    case 'boolean': return true;
    case 'null': return null;
    default:
      // 没写 type 的 schema 太常见了。返回 {} 而不是 null：
      // 断言 `$.data.id` 时 null 会让整条链路 undefined，排查方向被带偏。
      return Object.keys((s.properties as object | undefined) ?? {}).length ? sampleFromSchema({ ...s, type: 'object' }, depth) : {};
  }
}

function sampleString(s: Record<string, unknown>): string {
  // 优先满足 pattern 之外的显式约束；pattern 不尝试生成（正则造串是另一个量级的工程，
  // 且造出来的串"看着对"其实没验证过 —— 那种情况交给 spec 的 example）
  const min = typeof s.minLength === 'number' ? s.minLength : 0;
  const base = formatSample(s.format as string | undefined) ?? 'sample';
  return base.length >= min ? base : base.padEnd(min, 'x');
}

function formatSample(format?: string): string | undefined {
  switch (format) {
    case 'date': return '2024-01-01';
    case 'date-time': return '2024-01-01T00:00:00Z';
    case 'time': return '00:00:00';
    case 'uuid': return '00000000-0000-4000-8000-000000000000';
    case 'email': return 'user@example.com';
    case 'uri': case 'url': return 'https://example.com/x';
    case 'ipv4': return '127.0.0.1';
    case 'byte': return 'cGF5bG9hZA==';
    case 'int64': return '1700000000000000000';
    default: return undefined;
  }
}

function sampleNumber(s: Record<string, unknown>): number {
  const min = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 0;
  const max = typeof s.maximum === 'number' ? s.maximum : undefined;
  if (s.multipleOf !== undefined && typeof s.multipleOf === 'number') {
    const m = s.multipleOf;
    const k = Math.ceil(min / m);
    return max !== undefined && k * m > max ? m : k * m;
  }
  const v = min;
  return max !== undefined && v > max ? max : v;
}

/** mock 自己也要被校验：spec 写的 example 不符合它自己的 schema 是常见的（docs/05 §1 最后一行）。 */
function validateSample(op: OperationSpec, code: string, value: unknown, opts: MockOptions): void {
  if (!opts.selfCheckIssues) return;
  // 轻量自检：required 字段是否都在。完整的 ajv 自检在 client 侧响应校验里做，
  // 这里只挡"mock 造出来的东西连 required 都不满足"这种一眼可见的坑。
  const schema = op.responses[code]?.schema;
  if (!schema || typeof schema !== 'object') return;
  const required = (schema as Record<string, unknown>).required;
  if (!Array.isArray(required) || value === null || typeof value !== 'object') return;
  for (const k of required) {
    if (!(k in (value as Record<string, unknown>))) {
      opts.selfCheckIssues.push(`mock 为 ${op.method} ${op.path} ${code} 造的值缺 required 字段 "${k}"（多半是 spec 里该字段没 properties 定义）`);
    }
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Route[],
  requests: MockServer['requests'],
  opts: MockOptions,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const qi = rawUrl.indexOf('?');
  const path = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
  const query = parseQuery(qi < 0 ? '' : rawUrl.slice(qi + 1));
  const method = (req.method ?? 'GET').toUpperCase();

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  let body: unknown = text === '' ? null : text;
  if (typeof body === 'string' && (req.headers['content-type'] ?? '').includes('json')) {
    try { body = JSON.parse(text); } catch { /* 保留原文，让用例断言能看见坏 JSON */ }
  }
  const flatHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) flatHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  requests.push({ method, url: rawUrl, path, query, headers: flatHeaders, body });

  const segs = path.split('/').filter(Boolean);
  const hit = routes.find((r) => r.op.method === method && matchPath(r.segs, segs));
  if (!hit) {
    const status = opts.unmatchedStatus ?? 404;
    if (opts.onUnmatched === 'empty') { res.writeHead(status).end(); return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_mock_route', method, path, known: routes.map((r) => `${r.op.method} ${r.op.path}`) }));
    return;
  }
  // 状态码选择：用例可通过 header 指定，默认取第一个 2xx。
  // 这让"404/400 分支的用例"不必为了 mock 而改代码（docs/05 §3 的 notFound 策略要用）。
  const want = req.headers['x-atest-mock-status'];
  const wantCode = typeof want === 'string' && /^\d{3}$/.test(want) ? Number(want) : undefined;
  const declared = hit.op.responses[String(wantCode)];
  const chosen = wantCode !== undefined
    ? { status: wantCode, body: declared?.schema ? sampleFromSchema(declared.schema) : null }
    : hit.responses[0]!;
  const payload = chosen.body === null ? '' : JSON.stringify(chosen.body);
  res.writeHead(chosen.status, payload === '' ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function matchPath(pat: string[], actual: string[]): boolean {
  if (pat.length !== actual.length) return false;
  return pat.every((p, i) => p === '*' || p === actual[i]);
}

/** 保留重复键（`?id=1&id=2` 要能看出是两个值），并解 %XX。 */
function parseQuery(q: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!q) return out;
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
    (out[k] ??= []).push(v);
  }
  return out;
}

/** 把 operation 的参数按 spec 的 style 序列化成 URL（客户端与 mock 共用同一套规则，才不会两边各错一半）。 */
export function buildUrlFor(baseUrl: string, op: OperationSpec, args: { pathParams?: Record<string, unknown>; queryParams?: Record<string, unknown> }): string {
  const path = op.path.replace(/\{([^}/]+)\}/g, (_m, name: string) => {
    const p = op.params.find((x) => x.name === name && x.in === 'path');
    const v = args.pathParams?.[name];
    return styleParam({ name, value: v, in: 'path', style: p?.style as never, explode: p?.explode }).text;
  });
  const qs: Array<{ name: string; value: unknown; style?: never; explode?: boolean }> = [];
  for (const [name, value] of Object.entries(args.queryParams ?? {})) {
    const p = op.params.find((x) => x.name === name && x.in === 'query');
    qs.push({ name, value, style: p?.style as never, explode: p?.explode });
  }
  const base = baseUrl.replace(/\/$/, '');
  if (!qs.length) return base + path;
  const parts = qs.map((it) => {
    const r = styleParam({ name: it.name, value: it.value, in: 'query', style: it.style, explode: it.explode });
    return r.raw ?? r.pairs.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  });
  return `${base}${path}?${parts.join('&')}`;
}
