/**
 * 参数序列化（OAS3 `style` × `explode`，docs/05 §1 第 7 行「六种组合都得实现」）。
 *
 * 为什么值得单独写而不是"就用 & 拼"：数组查询参数的序列化方式**各家后端不一样**，
 * 且没有默认共识。用错一种，网关收不到参数、后端把空数组当成"查全部"、
 * 用例断言"返回非空列表"通过 —— 一条永远绿的假用例，而且它绿得很合理：
 * 请求发出去了、200 了、结构也对。
 *
 * 本文件的对照物是 OAS 3.0 规范里的 style/explode 序列化示例表，
 * test/style.test.ts 把那张表**逐格**落成断言 —— 这种纯映射代码，
 * 唯一可信的测试就是照抄规范表，自己跟自己约定没有意义。
 */

export type ParamIn = 'path' | 'query' | 'header' | 'cookie';
export type ParamStyle = 'simple' | 'label' | 'matrix' | 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';

/**
 * 规范规定的默认 style（按参数位置）。
 * 注意 path 的默认是 **simple** 而不是 matrix —— matrix 只是 path 允许的值之一。
 * 这一条记错会让所有未显式写 style 的路径参数凭空多出 `;name=` 前缀。
 */
export function defaultStyle(inPos: ParamIn): ParamStyle {
  return inPos === 'query' || inPos === 'cookie' ? 'form' : 'simple';
}
/** 规范规定 explode 默认 **true**。记成 false 会让所有数组参数静默变成逗号形式。 */
export const DEFAULT_EXPLODE = true;

export interface SerializeInput {
  name: string;
  value: unknown;
  in: ParamIn;
  style?: ParamStyle;
  explode?: boolean;
}

/**
 * 序列化结果。
 * - `pairs`：query 用的键值对（`?id=1&id=2` 要能出多对）。
 * - `text`：path/header/cookie 用的整体片段（已含 `.` / `;name=` 这类前缀）。
 * - `raw`：query 用的**已按规范编码好**的片段。只有 spaceDelimited/pipeDelimited
 *   的非 explode 形式需要它 —— 规范写的是 `id=3%204%205`，而 URLSearchParams
 *   会把空格编成 `+`、把 `|` 编成 `%7C`，交给标准库编码就偏离规范表了。
 */
export interface Serialized {
  pairs: Array<{ key: string; value: string }>;
  text: string;
  raw?: string;
}

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const ent = (v: unknown): Array<[string, unknown]> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : [];

/** 对象在 explode=false 下的扁平形式：`role,admin,firstName,Alex` */
const flatObj = (v: unknown): string => ent(v).flatMap(([k, val]) => [k, asText(val)]).join(',');

const txt = (t: string): Serialized => ({ pairs: [], text: t });
const prs = (...ps: Array<{ key: string; value: string }>): Serialized => ({ pairs: ps, text: '' });

export class StyleError extends Error {
  constructor(message: string, public readonly style: string) {
    super(message);
    this.name = 'StyleError';
  }
}

/**
 * 按 style × explode 序列化一个参数。
 * 非法组合（deepObject 用在数组上、spaceDelimited 用在对象上）**报错而不是猜一个**：
 * 猜一个"看起来能跑的"正是让平台与后端静默分叉的起点，而这正是本文件要避免的东西。
 */
export function styleParam(i: SerializeInput): Serialized {
  const style = i.style ?? defaultStyle(i.in);
  const explode = i.explode ?? DEFAULT_EXPLODE;
  const v = i.value;

  if (v === null || v === undefined || typeof v !== 'object') {
    switch (style) {
      case 'simple': return txt(asText(v));
      case 'label': return txt(`.${asText(v)}`);
      case 'matrix': return txt(`;${i.name}=${asText(v)}`);
      case 'form': return prs({ key: i.name, value: asText(v) });
      default:
        throw new StyleError(`参数 "${i.name}" 用了 style=${style}，它只适用于数组/对象（标量请用 simple/label/matrix/form）`, style);
    }
  }

  if (Array.isArray(v)) {
    switch (style) {
      // 数组在 simple/label 下 explode 不改变结果（规范表里两种取值是同一格）
      case 'simple': return txt(v.map(asText).join(','));
      case 'label': return txt(`.${v.map(asText).join('.')}`);
      case 'matrix':
        return txt(explode ? v.map((el) => `;${i.name}=${asText(el)}`).join('') : `;${i.name}=${v.map(asText).join(',')}`);
      case 'form':
        return explode
          ? prs(...v.map((el) => ({ key: i.name, value: asText(el) })))
          : prs({ key: i.name, value: v.map(asText).join(',') });
      case 'spaceDelimited':
      case 'pipeDelimited':
        // explode=true 退化成重复键；explode=false 才是分隔符单值
        if (explode) return prs(...v.map((el) => ({ key: i.name, value: asText(el) })));
        return { pairs: [], text: '', raw: `${i.name}=${v.map(asText).join(style === 'spaceDelimited' ? '%20' : '|')}` };
      case 'deepObject':
        throw new StyleError(`参数 "${i.name}" 是数组但用了 style=deepObject（deepObject 只适用于对象）`, style);
    }
  }

  switch (style) {
    case 'simple':
      return txt(explode ? ent(v).map(([k, val]) => `${k}=${asText(val)}`).join(',') : flatObj(v));
    case 'label':
      return txt(explode ? `.${ent(v).map(([k, val]) => `${k}=${asText(val)}`).join('.')}` : `.${flatObj(v)}`);
    case 'matrix':
      return txt(explode ? ent(v).map(([k, val]) => `;${k}=${asText(val)}`).join('') : `;${i.name}=${flatObj(v)}`);
    case 'form':
      return explode
        ? prs(...ent(v).map(([k, val]) => ({ key: k, value: asText(val) })))
        : prs({ key: i.name, value: flatObj(v) });
    case 'deepObject':
      return prs(...ent(v).map(([k, val]) => ({ key: `${i.name}[${k}]`, value: asText(val) })));
    case 'spaceDelimited':
    case 'pipeDelimited':
      throw new StyleError(`style=${style} 只适用于数组参数（"${i.name}" 是对象）`, style);
  }
}

/**
 * 百分号编码，但**放过 RFC 3986 的 sub-delims 与 `[]`**。
 *
 * 不能直接用 encodeURIComponent：它会把 `,` `=` `[` `]` `.` 一起编掉，
 * 而 style 序列化的**分隔符本身就是这些字符** —— 编掉之后
 * `id=3,4,5` 变成 `id=3%2C4%2C5`，后端按重复键解析的网关收到的是一个
 * 名叫 id、值为 "3,4,5" 的单参数，行为完全不同却同样返回 200。
 * 这正是本文件开头说的那种"绿得很合理"的假用例。
 *
 * 仍然要编的是真正会破坏结构的字符：空格、`/`、`#`、`?`、`%`、`&`、`<>"`、
 * 控制字符，以及 `{}` `|` `\` `^` 反引号。
 */
const ALLOWED = new Set([
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
  '0','1','2','3','4','5','6','7','8','9',
  '-','_','.','~',            // unreserved
  '!', '$', "'", '(', ')', '*', '+', ',', ';', ':', '@', // 其余 sub-delims
  '[', ']',                   // deepObject 的结构性括号
  '=',                        // 路径片段里的 `;role=admin` / `role=admin,x` 规范要求它是字面量
]);
/**
 * 编码一段**路径/头部片段**。
 * `&` 与 `?` 一律编掉：它们在查询串里是分隔符，留在值里会把一个参数劈成两个。
 */
function enc(v: string): string {
  let out = '';
  for (const ch of v) out += ch === '&' || ch === '?' ? encodeURIComponent(ch) : ALLOWED.has(ch) ? ch : encodeURIComponent(ch);
  return out;
}
/**
 * 编码查询串的**键或值**。比 enc 多编掉 `=`：
 * 路径片段需要字面量 `=`（`;role=admin`），但查询串的键值对里 `=` 是结构字符，
 * 值里出现字面量 `=` 虽然合法可解析（解析器按第一个 `=` 切），
 * 编掉它则在任何解析器下都无歧义 —— 平台发请求不必赌网关的解析习惯。
 */
function encQ(v: string): string {
  return enc(v).replace(/=/g, '%3D');
}

/**
 * 拼查询串。**逐对编码**而不是先拼串再整体编码：
 * 先拼后编会把分隔符一起编掉，先编后拼又会漏掉值里的特殊字符。
 * 顺序按传入顺序保留 —— 同一请求两次生成的字节必须一致，
 * 否则 mock 匹配与 trace diff 会因为键序不同而判成两次不同的请求。
 */
export function buildQuery(items: Array<{ name: string; value: unknown; style?: ParamStyle; explode?: boolean }>): string {
  const parts: string[] = [];
  for (const it of items) {
    const r = styleParam({ name: it.name, value: it.value, in: 'query', style: it.style, explode: it.explode });
    if (r.raw) parts.push(r.raw);
    else for (const p of r.pairs) parts.push(`${encQ(p.key)}=${encQ(p.value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * 把参数填进 path 模板。
 * 缺参数时**保留 `{id}` 原样并把名字返回**，由调用方报错 ——
 * 静默把 `{id}` 留在 URL 里，得到的是一个 404，而报错信息里看不出为什么。
 */
export function fillPath(
  template: string,
  params: Map<string, unknown>,
  styleOf: (name: string) => { style?: ParamStyle; explode?: boolean } = () => ({}),
): { url: string; missing: string[] } {
  const missing: string[] = [];
  const url = template.replace(/\{([^}/]+)\}/g, (_m, name: string) => {
    const v = params.get(name);
    if (v === undefined || v === null) { missing.push(name); return `{${name}}`; }
    // path 段的值必须编码：`a/b` 作为 {id} 不编码会凭空多出一段路径
    return enc(styleParam({ name, value: v, in: 'path', ...styleOf(name) }).text);
  });
  return { url, missing };
}
