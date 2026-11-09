/**
 * 大整数保真的 JSON 解析（docs/05 §4「变量类型保真」：
 * 「JSON 大整数（雪花 ID）用 string 存，别过 Number。超过 2^53 精度丢失 →
 *  提取出来的 id 传给下一步是错的，且极难排查。这是 API 测试里最阴的一个 bug」）。
 *
 * 为什么阴：`{"id": 7301894562345678901}` 过一遍 JSON.parse，
 * 再打出来是 7301894562345679000（IEEE754 下最近双精度值的最短表示，
 * 与真值差 147 —— 不是截断，是**静默换成了另一个数**）。
 * 用例 extract 出这个 id、下一步 GET /orders/{id} 发出去、
 * 后端回 404。看到的现象是"接口找不到刚创建的订单"，
 * 于是去查后端事务隔离、查主从延迟，**永远查不到是 JSON.parse 干的**。
 *
 * 为什么不用 reviver：reviver 拿到的是**已经丢完精度**的 Number，来不及了。
 * 必须在文本阶段就把超长整数字面量加引号。
 *
 * 做法：扫一遍原文，跟踪"是否在字符串里"，把不在字符串内的整数字面量加引号。
 * 不用正则一把梭是因为 `{"a":"12345678901234567890123"}` 里的数字在字符串里，
 * 不该被改动（改了就把用户的字符串值变成了…… 其实还是字符串，但
 * `{"a": "x123456789012345678901"}` 这种含引号转义的文本会把朴素正则带偏）。
 */

/** 超过这个位数的整数字面量按字符串返回。17 位起必然超出 2^53 的精确整数范围。 */
export const BIG_INT_DIGITS = 17;

/**
 * 解析 JSON，把超出安全整数范围的**整数字面量**保留为字符串。
 * 小数与指数记法不动（它们本来就不是 ID 的形状）。
 */
export function parseJsonKeepBigInt(text: string, bigIntDigits = BIG_INT_DIGITS): unknown {
  const patched = quoteBigInts(text, bigIntDigits);
  return JSON.parse(patched);
}

/** 只加引号不解析，供测试与调试直接看转换结果。 */
export function quoteBigInts(text: string, bigIntDigits = BIG_INT_DIGITS): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inStr) {
      // 字符串内部：只有反斜杠需要额外前进一格（\" 不是字符串结束）
      if (c === '\\') { out += c + (text[i + 1] ?? ''); i += 2; continue; }
      if (c === '"') inStr = false;
      out += c; i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }

    // 数字：只在「值的位置」开始（前面是 : [ , 或空白起始）。
    // 判定"是整数字面量且超长"才加引号。
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      let j = i;
      if (text[j] === '-') j++;
      while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++;
      let isInt = true;
      if (text[j] === '.') { isInt = false; j++; while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++; }
      if (text[j] === 'e' || text[j] === 'E') {
        isInt = false; j++;
        if (text[j] === '+' || text[j] === '-') j++;
        while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++;
      }
      const digits = text.slice(start === 0 ? 0 : start, j).replace('-', '');
      if (isInt && digits.length >= bigIntDigits && Number.isSafeInteger(Number(digits)) === false) {
        out += `"${text.slice(start, j)}"`;
      } else {
        out += text.slice(start, j);
      }
      i = j;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * 序列化请求体，把「被保真成长整数字符串、但 schema 说是整数」的字段**按字面量**写回。
 *
 * 两个坑，本实现两个都绕开了：
 *
 * 1. **不能在值层面还原**。第一版写的是 `Number(v)`：但「长度 >= 17 位」与
 *    「能被 Number 安全表示」是**互斥**的（2^53 只有 16 位），所以那个分支永远走不到；
 *    放宽到能走到，就等于把我们费力气保住的精度错误再塞回去。
 *    还原只能是**文本层面**的：数字直接进 JSON 文本，全程不过 Number，无损。
 *
 * 2. **不能靠「看着像数字」来判断**。`{ s: "7301894562345678901" }` 里这个字段
 *    可能本来就是字符串（手机号/卡号/单号，真实接口里 number 与 string 两种都有，
 *    且后端行为不同）。平台静默改类型比不改更糟 —— 用户看不出请求体被动过。
 *    实测过：无脑还原会把 `"s":"730..."` 变成 `s:730...`。
 *    唯一能区分两者的信息是 **schema**，所以它当参数；没 schema 时**一律保持字符串**：
 *    多一个引号后端通常照收，而把字符串字段改成数字是必然的语义错误。
 *
 * 手法：先按 schema 把这些值换成带 NUL(U+0000) 前缀的哨兵字符串，让 JSON.stringify
 * 做全部转义，再把哨兵还原成裸字面量。哨兵不会误伤用户数据：真实文本里的 NUL 会被
 * stringify 转义成可见的六字符序列，与本哨兵的裸控制字符不同形。
 */
const SENTINEL = String.fromCharCode(0) + 'atest-bigint:';
/** >= 17 位的纯数字，即可能被保真过的形状。短数字一律不动，见文件头第 2 条。 */
const BIG_LITERAL = /^-?\d{17,}$/;
const SENTINEL_RE = new RegExp(`"${SENTINEL.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(-?\\d+)"`, 'g');

export function stringifyBody(value: unknown, schema?: unknown): string {
  const text = JSON.stringify(markBigInts(value, schema, 0));
  if (text === undefined) return 'undefined';
  return text.replace(SENTINEL_RE, (_m, n: string) => n);
}

function markBigInts(value: unknown, schema: unknown, depth: number): unknown {
  if (depth > 32 || value === null || typeof value !== 'object') {
    return typeof value === 'string' && BIG_LITERAL.test(value) && anyWantsInteger(schema) ? SENTINEL + value : value;
  }
  const sch = (schema ?? {}) as Record<string, unknown>;
  if (Array.isArray(value)) {
    const itemSch = sch.items;
    return value.map((el) => (typeof el === 'string' && BIG_LITERAL.test(el) && anyWantsInteger(itemSch) ? SENTINEL + el : markBigInts(el, itemSch, depth + 1)));
  }
  const props = (sch.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const fieldSch = props[k] ?? (typeof sch.additionalProperties === 'object' ? sch.additionalProperties : undefined);
    if (typeof v === 'string' && BIG_LITERAL.test(v) && anyWantsInteger(fieldSch)) { out[k] = SENTINEL + v; continue; }
    out[k] = markBigInts(v, fieldSch, depth + 1);
  }
  return out;
}

/** oneOf/anyOf/allOf 也算：spec 常把雪花 id 写成「整数或字符串」两分支之一。 */
function anyWantsInteger(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (wantsInteger(schema as Record<string, unknown>)) return true;
  const s = schema as Record<string, unknown>;
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const subs = s[key];
    if (Array.isArray(subs) && subs.some((x) => x !== null && typeof x === 'object' && wantsInteger(x as Record<string, unknown>))) return true;
  }
  return false;
}

/** schema 是否声明该字段为整数。nullable 的 `type: ["integer","null"]` 也算。 */
function wantsInteger(s: Record<string, unknown>): boolean {
  const t = s.type;
  if (t === 'integer') return true;
  if (Array.isArray(t) && t.includes('integer')) return true;
  // 没写 type 但给了 format: int64 —— OAS3 里雪花 ID 的标准写法
  const f = s.format;
  return f === 'int64' || f === 'bigint';
}

