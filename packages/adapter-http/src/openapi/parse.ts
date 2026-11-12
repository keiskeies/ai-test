/**
 * OpenAPI 3.x 文档 -> 平台内部 operation 表（M2 主体，docs/05 §1）。
 *
 * 设计约束（都来自 docs/05 那张"真实世界的 spec 有多脏"表）：
 *  - **部分失败不整体失败**：单条 operation 解析炸了记 OPERATION_SKIPPED 继续走。
 *    「导入失败=空平台」，「3 条跳过=能开工」，对用户是质的差别。
 *  - **URL 永远来自环境配置**，spec 的 `servers` 只作为默认值建议（§1 第 5 行）。
 *  - `security` 三层继承 + **空数组=显式公开**（§1 第 6 行，解析错=一堆 401 假用例）。
 *  - `deprecated` 默认不生成用例（§1 第 9 行），但保留在表里供 UI 折叠展示。
 */
import { resolveAliases, type AliasedOp, type RawOp } from './alias.js';
import { dereference, type RefIssue } from './refs.js';
import type { ParamIn } from './style.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
const METHOD_KEYS = [
  ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'],
  ['delete', 'DELETE'], ['head', 'HEAD'], ['options', 'OPTIONS'],
] as const satisfies ReadonlyArray<readonly [string, HttpMethod]>;

export interface ParamSpec {
  name: string;
  in: ParamIn;
  required: boolean;
  /** 已解引用的 schema */
  schema: Record<string, unknown>;
  style?: string;
  explode?: boolean;
  /**
   * 参数级 example（OAS3 两种写法都由 `pickExample` 解出来：`example: <值>` 与
   * `examples: {名: {value: <值>}}`）。
   *
   * ⚠ 这句注释**从前写的是「mock 与 happyPath 优先生成用」，而那两个读者一个都没有**：
   * mock 只读**响应级**的 `examples[状态码]` 与 **schema 级**的 `example`
   * （见 `mock.ts` 的 `pickResponseBody` / `sampleFromSchema`），参数级这一栏它从不看；
   * `gen` 那侧当时也只看 `p.schema`。于是这个字段有生产者、没消费者已经挂了很久，
   * 而两道字段级守卫都看不见它 —— `unread-fields.mjs` 只扫 `packages/ir/src` 的 zod，
   * `dead-iface-fields.mjs` 的判据是"除声明外零提及"，而 `example` 这个**名字**
   * 在 adapter-http 源码里出现几十次，词法层面判不死（实测两个守卫都干净退出）。
   *
   * 现在的消费者是 `cli/src/gen.ts` 的 `sampleParams`（**优先于**按 schema 造，
   * 标量才用），`auth-check` 与 `gen` 共用它，所以"用例打的地址"与
   * "auth-check 探的地址"是同一个。载体：`cli/test/gen.test.ts` 那一条 +
   * 变异集 `tooling/mutate/mock-bad-input.json` 最后一条。
   */
  example?: unknown;
  deprecated?: boolean;
}

export interface OperationSpec {
  operationId: string;
  /** id 是平台生成的（而非作者手写），UI 要标出来（alias.ts 的说明） */
  aliasGenerated: boolean;
  method: HttpMethod;
  path: string;
  /** 含 {param} 的原始模板；baseUrl 由环境提供，这里只有 path */
  urlTemplate: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  params: ParamSpec[];
  /** application/json 请求体的 schema（已解引用）；无 JSON 体则 undefined */
  requestBodySchema?: Record<string, unknown>;
  requestBodyRequired: boolean;
  /** 请求体 required 字段（一层，供 requiredMissing 策略逐个删）。嵌套层由策略自己走 schema */
  requiredBodyFields: string[];
  /** 解析后的 security：undefined=继承链上没定义；[]=显式公开 */
  security?: Array<Record<string, string[]>>;
  /** 响应表：状态码字符串 -> schema。`default` 也在键里 */
  responses: Record<string, { schema?: Record<string, unknown>; description?: string }>;
  /** spec 自带 examples（happyPath 的第一优先数据源，docs/05 §6「按 examples 优先」） */
  examples: Record<string, unknown>;
}

export interface ParsedDoc {
  operations: OperationSpec[];
  byId: Map<string, OperationSpec>;
  /** spec 声明的 securitySchemes（鉴权层用，docs/05 §2） */
  securitySchemes: Record<string, Record<string, unknown>>;
  /** servers[0].url 的原始值 —— 只作为环境配置的**建议默认值**，执行时不读（docs/05 §1） */
  suggestedBaseUrl?: string;
  issues: RefIssue[];
}

export interface ParseOptions {
  /** operation_alias 人工覆盖表（alias.ts） */
  aliasOverrides?: Record<string, string>;
  /** 解引用的最大嵌套层数 */
  maxDepth?: number;
}

/** 宽松取数组：spec 里 `required: null` / 缺键都很常见，不能直接 .map。 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 解析整份文档。
 * 只有「这根本不是一份 OpenAPI 文档」才返回致命 issue；
 * 单条 operation 坏了只是跳过。
 */
export function parseOpenApi(raw: unknown, opts: ParseOptions = {}): ParsedDoc {
  const root = asObj(raw);
  const issues: RefIssue[] = [];
  const openapi = typeof root.openapi === 'string' ? root.openapi : undefined;
  const swagger = typeof root.swagger === 'string' ? root.swagger : undefined;
  if (!openapi && !swagger) {
    issues.push({ level: 'error', code: 'SPEC_INVALID', message: '既没有 openapi 也没有 swagger 字段：这不是 OpenAPI/Swagger 文档', at: '#' });
    return { operations: [], byId: new Map(), securitySchemes: {}, issues };
  }
  if (swagger) {
    issues.push({ level: 'error', code: 'SPEC_INVALID', message: 'Swagger 2.0 暂不支持（body/formData 的模型与 OAS3 差异太大，硬解会静默丢参数）。请先用 converter 转成 3.0', at: '#' });
    return { operations: [], byId: new Map(), securitySchemes: {}, issues };
  }

  const specDoc = { root };
  const docRef = (node: unknown, at: string): { value: unknown; issues: RefIssue[] } =>
    dereference(node, specDoc, { at, maxDepth: opts.maxDepth });

  const specSecurity = asArray<Record<string, string[]>>(root.security);
  const paths = asObj(root.paths);
  const rawOps: RawOp[] = [];
  const perOpCtx = new Map<string, { method: HttpMethod; pathItem: Record<string, unknown>; op: Record<string, unknown>; path: string }>();

  for (const [path, pRaw] of Object.entries(paths)) {
    const pathItem = asObj(pRaw);
    // path 级 parameters 对每条 operation 生效，且 operation 级**同名同 in** 的参数覆盖它
    const pathParams = asArray<unknown>(pathItem.parameters);
    for (const [key, method] of METHOD_KEYS) {
      // 路径下的键是小写 method
      const op = asObj(pathItem[key]);
      // 空对象不算一条 operation（`get: {}` 这类手写残留很常见，
      // 收进来会得到一条"存在但啥都没有"的 operation，然后生成一堆垃圾用例）
      if (Object.keys(op).length === 0) continue;
      rawOps.push({ method, path, operationId: typeof op.operationId === 'string' ? op.operationId : undefined, tags: asArray<string>(op.tags) });
      perOpCtx.set(`${method} ${path}`, { method, pathItem, op, path });
    }
  }

  // 别名解析整批做（跨 operation 才能查出冲突），冲突抛错——这是唯一允许阻断解析的失败
  let aliased: AliasedOp[];
  try {
    aliased = resolveAliases(rawOps, opts.aliasOverrides ?? {});
  } catch (e) {
    if (e instanceof Error && 'alias' in e) {
      issues.push({ level: 'error', code: 'SPEC_INVALID', message: e.message, at: '#/paths' });
      return { operations: [], byId: new Map(), securitySchemes: {}, issues };
    }
    throw e;
  }

  const operations: OperationSpec[] = [];
  for (const a of aliased) {
    const ctx = perOpCtx.get(`${a.method} ${a.path}`)!;
    try {
      operations.push(buildOperation(a, ctx, specSecurity, docRef, issues));
    } catch (e) {
      // 单条炸掉不带走整份文档（docs/05 §1「部分解析失败不整体失败」）
      issues.push({
        level: 'error', code: 'OPERATION_SKIPPED',
        message: `operation ${a.method} ${a.path} 解析失败已跳过：${e instanceof Error ? e.message : String(e)}`,
        at: `#/paths/${a.path}/${a.method}`,
      });
    }
  }

  const schemesRaw = asObj(asObj(root.components).securitySchemes);
  const schemes: Record<string, Record<string, unknown>> = {};
  for (const [name, sc] of Object.entries(schemesRaw)) schemes[name] = asObj(sc);
  return {
    operations,
    byId: new Map(operations.map((o) => [o.operationId, o])),
    securitySchemes: schemes,
    suggestedBaseUrl: typeof asObj(asArray(root.servers)[0]).url === 'string' ? (asObj(asArray(root.servers)[0]).url as string) : undefined,
    issues,
  };
}

/**
 * 取一个 example。OAS3 有两种写法：`example: <值>` 与
 * `examples: { 名字: { value: <值> } }`。
 * 早先这里写的是 `asObj(p.examples).value` —— 在**映射本身**上找 value，
 * 永远是 undefined，于是所有只用 examples（复数）写的 spec 一条 example 也取不到，
 * 生成的用例退回纯 schema 造数（能跑，但白丢了作者手写的高质量样例）。
 */
function pickExample(node: Record<string, unknown>): unknown {
  if (node.example !== undefined) return node.example;
  const map = asObj(node.examples);
  const names = Object.keys(map);
  if (!names.length) return undefined;
  return asObj(map[names[0]!]).value;
}

function buildOperation(
  a: AliasedOp,
  ctx: { method: HttpMethod; pathItem: Record<string, unknown>; op: Record<string, unknown>; path: string },
  specSecurity: Array<Record<string, string[]>>,
  docRef: (n: unknown, at: string) => { value: unknown; issues: RefIssue[] },
  allIssues: RefIssue[],
): OperationSpec {
  const { op, pathItem, path, method } = ctx;
  const at = `#/paths[${path}][${method}]`;

  // 参数合并：path 级在前，operation 级同名同 in 覆盖（OAS3 规定）
  const merged = new Map<string, Record<string, unknown>>();
  for (const list of [asArray<unknown>(pathItem.parameters), asArray<unknown>(op.parameters)]) {
    for (const p of list) {
      const d = docRef(p, at);
      allIssues.push(...d.issues.filter((i) => i.level === 'error'));
      const pp = asObj(d.value);
      if (typeof pp.name === 'string' && typeof pp.in === 'string') merged.set(`${pp.in}:${pp.name}`, pp);
    }
  }
  // OAS3 硬规定：path 模板里的参数必须有 definitions —— 常见 spec 偷懒不写，
  // 这里**补上**而不是报错（缺 definitions 也要能发请求；required 按规范视为 true）
  for (const m of path.matchAll(/\{([^}/]+)\}/g)) {
    const name = m[1]!;
    if (![...merged.values()].some((p) => p.name === name && p.in === 'path')) {
      merged.set(`path:${name}`, { name, in: 'path', required: true, schema: { type: 'string' } });
    }
  }
  const params: ParamSpec[] = [...merged.values()].map((p) => {
    const sch = docRef(p.schema ?? {}, at);
    return {
      name: p.name as string,
      in: p.in as ParamIn,
      required: p.required === true || p.in === 'path', // path 参数按规范必选
      schema: asObj(sch.value),
      style: typeof p.style === 'string' ? p.style : undefined,
      explode: typeof p.explode === 'boolean' ? p.explode : undefined,
      example: pickExample(p),
      deprecated: p.deprecated === true,
    };
  });

  // 请求体：只认 application/json（multipart/binary 走 fixture 文件池，P2 再说，
  // 但**要记 issue 说明为什么这条的 body 校验是空**——静默跳过比报错更坏）
  let requestBodySchema: Record<string, unknown> | undefined;
  let requestBodyRequired = false;
  const rb = docRef(asObj(op.requestBody), at);
  const rbObj = asObj(rb.value);
  const content = asObj(rbObj.content);
  const jsonMedia = asObj(content['application/json']);
  if (Object.keys(jsonMedia).length) requestBodySchema = asObj(docRef(jsonMedia.schema, at).value);
  else if (Object.keys(content).length) {
    allIssues.push({
      level: 'warn', code: 'OPERATION_SKIPPED',
      message: `${method} ${path} 的请求体不是 application/json（${Object.keys(content).join('/')}），M2 暂不做 body 校验与 multipart fixture`,
      at: `${at}/requestBody`,
    });
  }
  requestBodyRequired = rbObj.required === true;
  const requiredBodyFields = requestBodyRequired || requestBodySchema ? asArray<string>(asObj(requestBodySchema).required) : [];

  // security：operation 级 > path 级 > spec 级；**空数组是显式声明"公开"**，
  // 停在空数组上、不再往下继承 —— 解析错这条会给公开接口生成一堆 401 用例
  let security: Array<Record<string, string[]>> | undefined;
  for (const level of [op, pathItem]) {
    if (Array.isArray(level.security)) { security = level.security as Array<Record<string, string[]>>; break; }
  }
  if (security === undefined) security = specSecurity.length ? specSecurity : undefined;

  const responses: OperationSpec['responses'] = {};
  for (const [code, rRaw] of Object.entries(asObj(op.responses))) {
    const r = asObj(rRaw);
    const rContent = asObj(asObj(r.content)['application/json']);
    responses[code] = {
      schema: Object.keys(rContent).length ? asObj(docRef(rContent.schema, at).value) : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
    };
  }

  // 响应 examples：mock server 与 happyPath 的第一优先数据源（docs/05 §6「按 examples 优先」）。
  // 按**状态码**存，一条状态码一个值 —— 同状态码多个 example 时取第一个并记 warn：
  // 挑哪个是语义决定，平台不该替用户挑（挑错了 mock 会一直返回"错误示例"还很像成功）。
  const examples: Record<string, unknown> = {};
  for (const [code, rRaw] of Object.entries(asObj(op.responses))) {
    const media = asObj(asObj(asObj(rRaw).content)['application/json']);
    if (!Object.keys(media).length) continue;
    if (media.example !== undefined) { examples[code] = media.example; continue; }
    const map = asObj(media.examples);
    const names = Object.keys(map);
    if (!names.length) continue;
    examples[code] = asObj(map[names[0]!]).value;
    if (names.length > 1) {
      allIssues.push({
        level: 'warn', code: 'OPERATION_SKIPPED',
        message: `${method} ${path} 的 ${code} 响应有 ${names.length} 个 example（${names.join('/')}），只取第一个 "${names[0]}"。要按不同 example 生成多条用例，请在场景里显式指定`,
        at: `${at}/responses[${code}]`,
      });
    }
  }

  return {
    operationId: a.operationId,
    aliasGenerated: a.aliasGenerated,
    method,
    path,
    urlTemplate: path,
    summary: typeof op.summary === 'string' ? op.summary : undefined,
    description: typeof op.description === 'string' ? op.description : undefined,
    tags: asArray<string>(op.tags),
    deprecated: op.deprecated === true,
    params,
    requestBodySchema,
    requestBodyRequired,
    requiredBodyFields,
    security,
    responses,
    examples,
  };
}
