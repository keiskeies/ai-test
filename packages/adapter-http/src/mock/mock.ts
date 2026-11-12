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
import qs from 'node:querystring';
import { isCycleNode } from '../openapi/refs.js';
import type { OperationSpec, ParsedDoc } from '../openapi/parse.js';

export interface MockOptions {
  /** 未匹配到 operation 时的行为。默认 404 —— **不要**默认 200，
   *  那会让"路径写错的用例"变成通过的用例。 */
  onUnmatched?: 'reject' | 'empty';
  /** 响应结构 vs schema 的自检结果。传数组则收集问题（不阻断），用于暴露 spec 自身的问题 */
  selfCheckIssues?: string[];
  /**
   * 未匹配时的状态码，默认 404。
   *
   * ⚠ 非法值**在起服务时就抛**，而不是留到某一次请求里。理由是这一格是平台侧写的
   * （测试代码/CLI 传的），不是用例作者临场写的：拼错一次会让**每一个**未匹配的请求
   * 都在 `res.writeHead` 里炸掉，而那个 throw 同样落进没人接的 `void handle(...)`，
   * 于是整套测试表现为"每条都挂到超时"，看不出与这个数字有任何关系。
   * 早报错的代价是一句栈，晚失败的代价是一堆 timeout。
   */
  unmatchedStatus?: number;
}

/**
 * 能被 `res.writeHead` 当**最终响应**送出去的状态码范围。
 *
 * 界是逐个量出来的（raw http client，不看 fetch 的脸色），四个点各有各的死法：
 *  - `0` / `99` / `1000` → `writeHead` **直接抛** `ERR_HTTP_INVALID_STATUS_CODE`。
 *    在 mock 里抛等于抛进没人接的 `void handle` → 一个字节都不回 → 客户端挂到超时。
 *  - `100` / `150` / `199` → `writeHead` **不抛**，而客户端**永远等不到响应**
 *    （实测三个都挂满 700ms 无响应）。1xx 是 informational，它不是"这次请求的结果"，
 *    所以比抛错更阴：没有任何一层会报错，只有客户端在等。
 *  - `101` → 实测能把 101 送出去，但那是 switching-protocols 的升级语义，
 *    同样不是用例能断言的一个响应。整个 1xx 一起排除，而不是只排会挂的那几个。
 *  - `200` 与 `999` → 原样送达（实测），所以 999 是上界。
 *
 * ⚠ 上界**不是**因为"1000 会被截断成 200"—— 我一度这么写过，那是错的：
 * 实测 `writeHead(1000)` 与 `writeHead(0)` 一样老实抛。真正会让 1000 变成 200 的是
 * **改前那句 `/^\d{3}$/`**：四位数过不了它，于是 header 被**静默忽略**、
 * mock 回默认的 2xx。同一条假绿，成因在正则而不在 writeHead ——
 * 而这正是"看着像类型问题、其实是判据太宽"的那种形状，值得记着别记错地方。
 */
function isFinalStatusCode(n: number): boolean {
  return Number.isInteger(n) && n >= 200 && n <= 999;
}

/** 用例靠这个 header 指定 mock 回哪个状态码（docs/05 §3 的 notFound 策略要用）。 */
const MOCK_STATUS_HEADER = 'x-atest-mock-status';

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
  if (opts.unmatchedStatus !== undefined && !isFinalStatusCode(opts.unmatchedStatus)) {
    throw new RangeError(
      `mock 的 unmatchedStatus 只能是 200..999 的整数，实际是 ${String(opts.unmatchedStatus)}。`
      + `小于 200 或大于 999 会让 writeHead 直接抛（每个未匹配的请求都变成"挂到超时"），`
      + `而 1xx 更阴：writeHead 不报错，客户端却永远等不到响应。`,
    );
  }
  const routes = buildRoutes(doc, opts);
  const requests: MockServer['requests'] = [];

  const server = createServer((req, res) => {
    /*
     * 这个 `void` 是本轮量出来的第二处"没人接的 throw"的根源：handle 是 async，
     * 它抛出来的是一个**没人的** Promise。实测两种触发方式
     * （URL 里带不合法的百分号转义、`x-atest-mock-status` 写了 000）
     * 的表现完全一样：`unhandledRejection`、**一个字节都不回**，
     * 客户端一直挂到超时，最后报成 `HTTP 请求失败：timeout`。
     * 那两处已经各自修了根因（见 parseQuery 与 chooseStatus）。
     *
     * ⚠ 我原本在这段注释里写的是"**根因修不完** —— `node:http` 把 request line 原样给
     * `req.url`，百分号、控制字符、任意长度的 header 都进得来，它自己不校验"。
     * 本轮实测把这句**打掉了**：拿九种恶意字节打进去（孤立代理项 `%ED%A0%80` 放在
     * 值上/键上/路径上、空键、`&&&`、`%25`、`%00`、CRLF 注入、3000 键的超长 query），
     * **一个都抛不出来了**。唯一没走到 handle 的那格是超长 query，而它是 node 自己在
     * `handle` **之前**回的 431。所以这层兜底此刻真正守得住的入口只有一个，
     * 而且不是字节层面的：**程序内构造的 ParsedDoc**。`handle` 里有两处 `JSON.stringify`，
     * 一个自引用的 `example` 就让它抛（实测 22ms 回 500；去掉兜底则 3000ms 读到 timeout）。
     * 载体是 `mock.test.ts` 的「handle 内部抛异常 -> 500 里带着成因」。
     *
     * 这句更正值得留着而不是悄悄改掉：这层兜底的**理由**不依赖"外面打进来的字节
     * 一定能把 handle 弄崩" —— 那种保证我既给不出也测不出。它的理由是
     * "**handle 以后还会加代码，而它抛出去的东西现在有人接**"。
     *
     * 为什么不 `console.error`：本包 src 里一处 console 都没有（引擎侧连 console
     * 都不存在），而这是测试夹具、它的 stderr 没人看 —— 真正读到的那个值是**步骤摘要**。
     * 于是把真相编码进**状态码 + body**：500 一定不是任何用例期望的状态码，
     * 它必然红，而红出来的那句摘要里带着真正的成因。
     * 写不进去（连接已断、headers 已发）才算罢休，因为那时已经没有人能读到任何东西。
     */
    void handle(req, res, routes, requests, opts).catch((err: unknown) => {
      const text = JSON.stringify({
        error: 'mock_internal_error',
        message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        hint: 'mock 处理这个请求时抛了异常，所以没有产生正常响应。'
          + '若客户端表现为 timeout，成因在这里而不是网络。',
      });
      try {
        res.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      } catch { /* 已经写不出去，只能让它挂 */ }
    });
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
    sendJson(res, status, { error: 'no_mock_route', method, path, known: routes.map((r) => `${r.op.method} ${r.op.path}`) });
    return;
  }
  /*
   * 状态码选择：用例可通过 header 指定，默认取第一个 2xx。
   * 这让"404/400 分支的用例"不必为了 mock 而改代码（docs/05 §3 的 notFound 策略要用）。
   *
   * ⚠ 这个 header 是**用例作者手写的**，所以它不能只过 `/^\d{3}$/` 就当状态码用 ——
   * `000` 完全符合那三条数字，而 `writeHead(0)` 抛 `ERR_HTTP_INVALID_STATUS_CODE`
   * （实测），抛进 `void handle` → 无响应 → 客户端挂死。改前那条路径上，
   * 一个 header 里的三个零会让整条用例变成一条 timeout。
   *
   * 写不出正常响应时**必须回一条 4xx 并说清是哪个值**，理由与 startMockServer 里那层
   * 兜底相同：这一格的真相是"你的 header 写错了"，而它原本的报错是"网络超时"。
   * 选 400 而不是让它红成 500：400 是"你给的东西不对"，与 no_mock_route 同一类；
   * 500 会被读成"mock 自己坏了"，于是人去查平台而不是查那个 header。
   */
  const want = req.headers[MOCK_STATUS_HEADER];
  const wantRaw = typeof want === 'string' ? want : undefined;
  if (wantRaw !== undefined && !(/^\d{3}$/.test(wantRaw) && isFinalStatusCode(Number(wantRaw)))) {
    sendJson(res, 400, {
      error: 'bad_mock_status',
      header: MOCK_STATUS_HEADER,
      value: wantRaw,
      allowed: '200..999 的三位数字',
      hint: `这个 header 是"让 mock 回指定状态码"用的。"${wantRaw}" 不是可用的最终状态码：`
        + `小于 200 或大于 999 会让 writeHead 直接抛，1xx 不抛却让客户端永远等不到响应。`
        + '写不出正常响应时宁可回这一条 400，也不要让用例把它读成一次 timeout 或一次默认 2xx。',
    });
    return;
  }
  const wantCode = wantRaw === undefined ? undefined : Number(wantRaw);
  const declared = wantCode === undefined ? undefined : hit.op.responses[String(wantCode)];
  const chosen = wantCode !== undefined
    ? { status: wantCode, body: declared?.schema ? sampleFromSchema(declared.schema) : null }
    : hit.responses[0]!;
  const payload = chosen.body === null ? '' : JSON.stringify(chosen.body);
  res.writeHead(chosen.status, payload === '' ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** 统一一处 writeHead + end，免得两个分支各自的 content-length 算法漂移。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function matchPath(pat: string[], actual: string[]): boolean {
  if (pat.length !== actual.length) return false;
  return pat.every((p, i) => p === '*' || p === actual[i]);
}

/**
 * 保留重复键（`?id=1&id=2` 要能看出是两个值），并解 %XX。
 *
 * 这里原本是自己 `split('&')` + 逐段 `decodeURIComponent`，而 **decodeURIComponent
 * 对不合法的转义会抛 URIError** —— 一句 `url: '/orders/A1?x=100%'`（`100%` 少两位
 * 十六进制，手写"百分比"这种值时很容易写出来）就够。而 handle() 是被
 * `void handle(...)` 调的，抛出去的东西**没有任何人接**：
 * 实测结果是 `unhandledRejection: URIError`、**一个字节都不回**，
 * 步骤挂满超时后报成 `HTTP 请求失败：timeout`（实测 30044ms）。
 * 真相是"你的 URL 写错了一个百分号"，报出来的是"网络超时" ——
 * 一个错到另一个错的距离是本案的全部代价：人会去查网络和后端，永远不会去查那个 `%`。
 *
 * 换成 `node:querystring` 而不是自己 try/catch 兜一层，有两个理由：
 *  - 它**不抛**（实测 `parse('x=100%')` 给出 `{x:'100%'}`，把不合法的转义按字面留着），
 *    与真实后端一致（Express 底下的 qs、以及 WHATWG 的 URLSearchParams 都不抛）；
 *    自己兜一层只能保证不崩，兜出来的值多半仍是"半个值"，而后端给的是字面量。
 *  - 它把 `+` 解成**空格**，这一点也与所有真实 form 解析器一致。
 *    原来那一份把 `+` 原样留着 —— 而平台自己发的查询串里**永远不会有裸 `+`**
 *    （`style.ts` 的 `encQ` 把它编成 `%2B`），所以裸 `+` 只可能来自手写的 url，
 *    那正是唯一需要跟后端对齐的一格。
 *
 * 代价是它把重复键给成 `string | string[]`，要在上面那一层摊回数组；比原实现多一次分配，
 * 换掉的是"崩与不崩"，值得。
 */
function parseQuery(q: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!q) return out;
  for (const [k, v] of Object.entries(qs.parse(q))) {
    /*
     * `v` 的类型里有 undefined（`ParsedUrlQuery` 允许），而 `querystring.parse`
     * 运行时**不会**产出 undefined —— 那是类型与实现不吻合，不是这里会发生的形状。
     * 所以是 `continue` 而不是 `v ?? ''`：后者会凭空造出一个空值参数，
     * 于是 mock 报告"收到了一个空值的 k"，而那个 k 压根不在请求里。
     * 少记一个键最多是断言拿不到东西，多记一个是**谎报收到了**。
     */
    if (v === undefined) continue;
    /*
     * `out[k] = ...` 看着等价，实际对 `?__proto__=x` 这个键完全不同：
     * 直接赋值走的是 setter，它**改的是 out 的原型**而不是加一个键
     * （实测 `Object.keys` 是空的，而 `getPrototypeOf(out)` 变成一个数组）。
     * 后果不是崩，是**谎报**：请求里明明带了 `__proto__=x`，
     * 而 `requests[].query` 里那个键不存在 —— 用例断"这个参数没收到"就会绿。
     * `Object.create(null)` 也能避开，但那样 `deepEqual(seen.query, {...一个普通字面量})`
     * 会**因为原型不同而红**，把一份好好的判据变成得写 `Object.assign({}, …)`。
     * defineProperty 两样都避开：键照实记，原型不动（实测过这三点）。
     */
    Object.defineProperty(out, k, { value: Array.isArray(v) ? v : [v], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/*
 * 这里**曾经有一个 `buildUrlFor(baseUrl, op, args)`**：把 operation 的参数组成一个完整
 * URL。本轮把它删了，理由不是"没人用"这一句就能定的，而是它**看起来在测东西**：
 * 它带着三条断言（路径编码、非 ASCII、查询分隔符），而 `git log -S` 追到首个提交 ——
 * 它**从第一天起就没有生产侧调用者**。mock server 收到请求后是按路径段匹配的
 * （见上面的 `matchPath`），它**从来不组成 URL**；生产侧的组成在 `openapi/compose.ts`，
 * baseUrl 那一层在 `engine/interpreter.ts` 的 `resolveUrl`。
 * 于是那三条断言断的是**一个没有生产代码会构造的字符串**：它们会红、会绿，
 * 而真实链路上的编码没有任何一条测试看过（实测：e2e 里那条 pathParams 用的是
 * `ORD-77`，纯 ASCII，编不编码看不出来）。
 *
 * 这就是 docs/08 §3(e)「有生产者、没有载体」的镜像形态 —— **有载体、没有生产者**：
 * 判据长得整整齐齐，接的是一根没通电的线。而它比"完全没有测试"更坏，
 * 因为下一个来查"路径编码有没有人守"的人搜到这三条就会走开。
 *
 * 三条断言本身是对的，已经原样搬到真实链路上
 * （`test/engine-e2e.test.ts` 的「路径参数里的斜杠被编码后仍然路由到同一个 operation」等）。
 */
