/**
 * JSON Schema 校验（docs/04 M2 的「请求/响应双向 schema 校验」）。
 *
 * 为什么用 ajv 而不是自研：校验器是**语义密度极高**的一块（oneOf 的错误报告、
 * $data、format、patternProperties…），自研只会做出一个"看起来能用"的子集，
 * 而它错的方式是**该报错时不报**。ajv 在离线缓存里（8.20.0），无需联网。
 *
 * 三条非显然的设计，都来自 docs/05：
 *
 * 1. **OAS3 的 `nullable` 要预处理**。ajv 走 2020-12，`nullable` 是 OAS3 的私货，
 *    直接喂给 ajv 会被忽略 —— 于是 `nullable: true` 的字段传 null 被判"不合法"，
 *    生成的用例一片红。这里把它翻成 `type: [...]`。
 *
 * 2. **`format` 不符只算"契约发现"，不算失败**（docs/05 §1 最后一行：
 *    「数据生成器优先遵守 schema，但失败时按后端实际接受什么降级，
 *    并把这种不符记成契约发现」）。后端把 `format: date-time` 存成 `"2024/01/01"`
 *    太常见了，判失败只会让人关掉门禁。
 *
 * 3. **报错信息里不回显值**。校验失败的常见对象是登录请求，
 *    把 `password` 的实际值打进 CI 日志就是密钥泄露（docs/02 §5 的同一条约束）。
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsNs from 'ajv-formats';
import { isCycleNode } from './refs.js';

/**
 * ajv-formats 是 CJS 包：它的 .d.ts 写 `export default formatsPlugin`，
 * 而 Node 的 ESM 互操作把**整个 namespace** 交给 default 导入。
 * 于是 TS 认为它不可调用（TS2349），运行时却是可调用的 —— 两边看到的不是同一个东西。
 * 这里做一次**带理由的**收窄，而不是散在各处 as any。
 * （ajv 本身没这问题，它有具名导出 `Ajv2020`，所以 ajv 一律具名导入。）
 */
const addFormats = addFormatsNs as unknown as (ajv: Ajv2020) => void;

export interface Violation {
  /** JSON Path 形式的位置，如 `$.body.items[0].sku` */
  path: string;
  message: string;
  keyword: string;
  /**
   * hard = 结构不符（该失败）；contract = 仅 format/示例层面不符
   * （记成契约发现，不参与失败判定，docs/05 §1）。
   */
  severity: 'hard' | 'contract';
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

/** 只有 hard 违例决定 ok。contract 违例永远不阻断（docs/05 §6.2 的教训）。 */
export function isValid(r: ValidationResult): boolean {
  return r.violations.every((v) => v.severity === 'contract');
}

const FORMAT_KEYWORDS = new Set(['format']);

export interface ValidatorOptions {
  /** 去掉「未声明的属性」。写操作要开：spec 没写的字段后端多半会静默丢弃，
   *  用例照发不误就成了"看着通过其实没测到"。 */
  removeAdditional?: boolean;
  /** 填 schema 里的 default。开了之后请求体可能与手写意图不同，默认关。 */
  useDefaults?: boolean;
  // 注意这里**没有** big-int 相关开关：雪花 ID 的精度问题发生在
  // **JSON 解析那一刻**（docs/05 §4「变量类型保真」），到校验器手里时数字早就丢了精度。
  // 所以保真是 http client 用 string 存大整数的事，校验器插不上手 ——
  // 在这里加个 coerceTypes 开关只会让人以为精度问题被解决了。
}

export interface Validator {
  (data: unknown): ValidationResult;
  /** 编译期发现的问题（schema 本身不合法）。非空时这个校验器**永远返回 ok**，
   *  调用方要把它当 issue 上报，不能把"没报错"理解成"校验通过"。 */
  schemaIssues: string[];
}

let seq = 0;

/**
 * 编译一个 schema。
 *
 * 每份 schema 用**独立的 Ajv 实例**：Ajv 会缓存 $id/`#/$defs`，
 * 多份 spec 复用同一个实例时，第二份里同名 $id 的 schema 会撞车并静默用第一份的
 * —— 那种情况下校验"通过"，但校验的是另一个接口的形状。
 */
export function compileValidator(schema: Record<string, unknown>, opts: ValidatorOptions = {}): Validator {
  const schemaIssues: string[] = [];
  const pre = toJsonSchema(schema, 0, schemaIssues);
  const ajv = new Ajv2020({
    // OAS3 schema 里满是 ajv 不认的键（discriminator/example/xml/discriminatorProperty…），
    // strict 模式会把整份 spec 判死。这里显式放宽，但**保留日志**：strict:false 是
    // "我们接受 OAS 方言"，不是"我们放弃检查"。
    strict: false,
    strictSchema: false,
    // 一次报全部违例：只报第一条会让用户"修一个、再红一个"地来回跑，
    // 而对生成出来的用例，用户需要的是**整份**违例清单才好一次改对
    allErrors: true,
    // 不做 allErrors 之外的隐式转换：改数据的校验器会让"校验"与"发送"看到两个 body
    removeAdditional: opts.removeAdditional ?? false,
    useDefaults: opts.useDefaults ?? false,
    // 报错里带 data 是调试利器，但也是密钥进日志的通道，永远不开
    verbose: false,
    $data: true,
  });
  addFormats(ajv);

  let validate: ValidateFunction | null = null;
  try {
    // 匿名 schema：加唯一 key，避免同一次运行里两份 spec 的同构 schema 互相覆盖
    validate = ajv.compile({ ...pre, ...(pre.$id ? {} : { $id: `https://atest.local/gen/${seq++}` }) });
  } catch (e) {
    schemaIssues.push(`schema 无法编译：${e instanceof Error ? e.message : String(e)}`);
  }

  const fn = ((data: unknown): ValidationResult => {
    if (!validate) return { ok: true, violations: [] };
    const errors: ErrorObject[] = [];
    let passed = false;
    try {
      passed = validate(data);
      errors.push(...(validate.errors ?? []));
    } catch (e) {
      // 校验器自身炸了要**响**，不能吞掉：吞掉等于"这条永远通过"
      return { ok: false, violations: [{ path: '$', message: `校验器异常：${e instanceof Error ? e.message : String(e)}`, keyword: 'validatorError', severity: 'hard' }] };
    }
    if (passed) return { ok: true, violations: [] };
    const violations = errors.map((er) => toViolation(er));
    return { ok: violations.every((v) => v.severity === 'contract'), violations };
  }) as Validator;
  fn.schemaIssues = schemaIssues;
  return fn;
}

function toViolation(er: ErrorObject): Violation {
  const kw = er.keyword ?? 'unknown';
  const path = `$${er.instancePath ?? ''}`.replace(/\//g, '.').replace(/\.(\d+)(?=\.|$)/g, '[$1]');
  const v: Violation = {
    path,
    // **不拼 er.data / 不拼实际值**。params 里只有 schema 侧信息（limit、allowedValues 等）
    // —— 那是 spec 内容不是用户数据，可以出。校验失败最常见的对象是登录请求，
    // 把实际值打进 CI 日志就是密钥进磁盘（docs/02 §5 同一条约束）。
    message: er.message ?? kw,
    keyword: kw,
    severity: FORMAT_KEYWORDS.has(kw) ? 'contract' : 'hard',
  };
  if (kw === 'additionalProperties' && typeof er.params?.additionalProperty === 'string') {
    v.message += `（spec 未声明的字段 "${er.params.additionalProperty}"，后端多半会静默丢弃）`;
  }
  if (kw === 'required' && Array.isArray(er.params?.missingProperty)) {
    v.message += `：${(er.params.missingProperty as string[]).join(', ')}`;
  } else if (kw === 'required' && typeof er.params?.missingProperty === 'string') {
    v.message += `：${er.params.missingProperty}`;
  }
  if (kw === 'enum' && Array.isArray(er.params?.allowedValues)) v.message += `（允许值 ${JSON.stringify(er.params.allowedValues)}）`;
  return v;
}

/**
 * OAS3 schema -> JSON Schema。递归处理，环处停（refs.ts 的 x-cycle 标记）。
 * 只做必需的三条翻译，其余原样透传：
 *   nullable: true      -> type 并入 'null'
 *   x-cycle             -> true（空 schema = 任意值合法，环以下不再校验）
 *   example / discriminator 等 OAS 私货 -> 摘掉，免得 ajv 报错
 */
const OAS_ONLY = ['discriminator', 'example', 'xml', 'externalDocs', 'writeOnly', 'readOnly', 'deprecated'];

function toJsonSchema(node: unknown, depth: number, issues: string[]): Record<string, unknown> {
  if (depth > 40) { issues.push('schema 嵌套过深，深层不再校验'); return {}; }
  if (node === undefined || node === null) return {};
  if (isCycleNode(node)) return {}; // 环以下"任意值合法"：宁可不校验，也不要栈溢出或误报
  if (Array.isArray(node)) return node.length ? { items: node.map((n) => toJsonSchema(n, depth + 1, issues)) } : {};
  if (typeof node !== 'object') return {};

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (OAS_ONLY.includes(k)) continue;
    if (k === 'nullable') {
      if (v === true) {
        const t = src.type;
        if (typeof t === 'string') out.type = t === 'null' ? 'null' : [t, 'null'];
        else if (Array.isArray(t) && !t.includes('null')) out.type = [...t, 'null'];
      }
      continue;
    }
    if (k === 'type' && Array.isArray(v)) { out.type = v; continue; }
    if (k === 'properties' || k === 'patternProperties' || typeof v !== 'object' || v === null) { out[k] = v; continue; }
    if (Array.isArray(v)) { out[k] = v; continue; }
    if (k === 'items' || k === 'additionalProperties' || k === 'not' || k === 'contains' || k === 'propertyNames' || k === 'if' || k === 'then' || k === 'else') {
      out[k] = typeof v === 'boolean' ? v : toJsonSchema(v, depth + 1, issues);
      continue;
    }
    if (k === 'allOf' || k === 'anyOf' || k === 'oneOf' || k === 'prefixItems') {
      out[k] = (v as unknown[]).map((x) => toJsonSchema(x, depth + 1, issues));
      continue;
    }
    if (k === 'required' || k === 'enum' || k === 'const' || k === 'uniqueItems') { out[k] = v; continue; }
    if (k === 'definitions' || k === '$defs') {
      const m: Record<string, unknown> = {};
      for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) m[dk] = toJsonSchema(dv, depth + 1, issues);
      out[k] = m;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * 校验"响应符合 schema"（docs/05 §3 的 `contract` 策略）。
 * 与请求校验的唯一区别：**oneOf/anyOf 降级为"至少匹配一个分支"**，
 * 且整体只出 contract 级违例（文档与实现谁错了不是"功能坏了"，docs/05 §1.1）。
 */
export function validateAgainstSchema(schema: Record<string, unknown> | undefined, data: unknown): ValidationResult {
  if (!schema || !Object.keys(schema).length) return { ok: true, violations: [] };
  const v = compileValidator(schema);
  if (v.schemaIssues.length) return { ok: true, violations: [] };
  const r = v(data);
  return { ok: r.ok, violations: r.violations.map((x) => ({ ...x, severity: 'contract' as const })) };
}
