/**
 * 表达式引擎（docs/02 §5 的 `expr`）—— 自研的小型 JSONata 风格子集。
 *
 * 为什么不用 jsonata：本机无外网且不在缓存里。更实际的理由是**压测要求预编译**
 * （docs/09 §4.2）：外部库通常每次解析+求值，测出来的性能天花板是表达式引擎自己的。
 * 这里把「解析」与「求值」彻底分开，编译一次、执行多次、零分配路径可测。
 *
 * 支持：字面量(数字/字符串/true/false/null)、变量路径($.a.b / 裸名 a.b)、
 *  算术 + - * / %、比较 == != > >= < <=、逻辑 and or not、
 *  括号、函数 count/sum/avg/min/max/length/lower/upper/contains/matches/abs/round/floor/ceil/now/toString/toNumber/join
 *  数组字面量 [1,2,3]、成员判断 `x in arr`。
 * 不支持：赋值、函数定义、闭包、正则字面量（用 matches()）、三元（用 if() 代替）。
 */
import { queryOne, PathError } from './jsonpath.js';

export class ExprError extends Error {
  constructor(message: string, public readonly source: string) {
    super(`${message}（表达式：${source}）`);
    this.name = 'ExprError';
  }
}

// ── AST ────────────────────────────────────────────────────────────────────
type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'ref'; path: string }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'un'; op: string; e: Node }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'arr'; items: Node[] };

// ── Tokenizer ──────────────────────────────────────────────────────────────
interface Tok { k: 'num' | 'str' | 'id' | 'op' | 'eof'; v: string; n?: number }

const OPS3 = ['==', '!=', '>=', '<=', '&&', '||'];
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let buf = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') { buf += unescapeChar(src[j + 1] ?? ''); j += 2; continue; }
        buf += src[j]!;
        j++;
      }
      if (j >= src.length) throw new ExprError('字符串未闭合', src);
      out.push({ k: 'str', v: buf });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9._eE+-]/.test(src[j]!)) {
        // 停掉 1e+5 之外的 + -
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1] ?? '')) break;
        if (src[j] === '.' && !/[0-9]/.test(src[j + 1] ?? '') && src[j] !== '.') break;
        j++;
      }
      const text = src.slice(i, j).replace(/_/g, '');
      const n = Number(text);
      if (Number.isNaN(n)) throw new ExprError(`无法解析的数字 "${text}"`, src);
      out.push({ k: 'num', v: text, n });
      i = j;
      continue;
    }
    if (c === '$') {
      // 变量引用：$.a.b[0] 或 $['k'] —— 一直吃到非路径字符
      let j = i;
      while (j < src.length && /[\w.$[\]-]/.test(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_一-龥]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w.$一-龥]/.test(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 2);
    if (OPS3.includes(three)) { out.push({ k: 'op', v: three }); i += 2; continue; }
    if ('+-*/%()<>!,[]'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    if (c === '&') { out.push({ k: 'op', v: '&&' }); i++; continue; }
    if (c === '|') { out.push({ k: 'op', v: '||' }); i++; continue; }
    throw new ExprError(`意外字符 "${c}"`, src);
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

function unescapeChar(c: string): string {
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    default: return c;
  }
}

// ── Parser（递归下降）──────────────────────────────────────────────────────
function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const eat = (v: string) => {
    if (peek().v === v && peek().k === 'op') { p++; return true; }
    return false;
  };
  const expect = (v: string) => {
    if (!eat(v)) throw new ExprError(`期望 ${v}，实际 ${peek().v || '末尾'}`, src);
  };

  function parseExpr(): Node { return parseOr(); }

  function parseOr(): Node {
    let l = parseAnd();
    while (peek().v === '||' || (peek().k === 'id' && peek().v === 'or')) { p++; l = { t: 'bin', op: '||', l, r: parseAnd() }; }
    return l;
  }
  function parseAnd(): Node {
    let l = parseNot();
    while (peek().v === '&&' || (peek().k === 'id' && peek().v === 'and')) { p++; l = { t: 'bin', op: '&&', l, r: parseNot() }; }
    return l;
  }
  function parseNot(): Node {
    if (peek().v === '!' || (peek().k === 'id' && peek().v === 'not')) { p++; return { t: 'un', op: '!', e: parseNot() }; }
    return parseCompare();
  }
  function parseCompare(): Node {
    let l = parseAdd();
    for (;;) {
      const t = peek();
      if (t.k === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(t.v)) { p++; l = { t: 'bin', op: t.v, l, r: parseAdd() }; continue; }
      if (t.k === 'id' && t.v === 'in') { p++; l = { t: 'bin', op: 'in', l, r: parseAdd() }; continue; }
      break;
    }
    return l;
  }
  function parseAdd(): Node {
    let l = parseMul();
    while (peek().v === '+' || peek().v === '-') { const op = peek().v; p++; l = { t: 'bin', op, l, r: parseMul() }; }
    return l;
  }
  function parseMul(): Node {
    let l = parseUnary();
    while (['*', '/', '%'].includes(peek().v)) { const op = peek().v; p++; l = { t: 'bin', op, l, r: parseUnary() }; }
    return l;
  }
  function parseUnary(): Node {
    if (eat('-')) return { t: 'un', op: '-', e: parseUnary() };
    return parsePrimary();
  }
  function parsePrimary(): Node {
    const t = peek();
    if (t.k === 'num') { p++; return { t: 'lit', v: t.n }; }
    if (t.k === 'str') { p++; return { t: 'lit', v: t.v }; }
    if (eat('(')) { const e = parseExpr(); expect(')'); return e; }
    if (eat('[')) {
      const items: Node[] = [];
      if (!peekIs(']')) {
        do { items.push(parseExpr()); } while (eat(','));
      }
      expect(']');
      return { t: 'arr', items };
    }
    if (t.k === 'id') {
      p++;
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (eat('(')) {
        const args: Node[] = [];
        if (!peekIs(')')) { do { args.push(parseExpr()); } while (eat(',')); }
        expect(')');
        return { t: 'call', name: t.v, args };
      }
      return { t: 'ref', path: t.v.startsWith('$') ? t.v : `$.${t.v}` };
    }
    throw new ExprError(`意外记号 "${t.v || '末尾'}"`, src);
  }
  function peekIs(v: string): boolean { return peek().v === v; }

  const ast = parseExpr();
  if (peek().k !== 'eof') throw new ExprError(`尾部有多余内容 "${peek().v}"`, src);
  return ast;
}

// ── 函数库 ─────────────────────────────────────────────────────────────────
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}
function nums(v: unknown): number[] {
  return asArray(v).map((x) => (typeof x === 'number' ? x : Number(x))).filter((x) => Number.isFinite(x));
}

const FUNCS: Record<string, (a: readonly unknown[]) => unknown> = {
  count: (a: readonly unknown[]) => asArray(a[0]).length,
  length: (a: readonly unknown[]) => (typeof a[0] === 'string' ? a[0].length : asArray(a[0]).length),
  /** len 是 length 的别名。两个都想让用户写对：只留 length 会得到一堆「未知函数 len」 */
  len: (a: readonly unknown[]) => (typeof a[0] === 'string' ? a[0].length : asArray(a[0]).length),
  size: (a: readonly unknown[]) => asArray(a[0]).length,
  sum: (a: readonly unknown[]) => nums(a[0]).reduce((x, y) => x + y, 0),
  avg: (a: readonly unknown[]) => { const n = nums(a[0]); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : null; },
  min: (a: readonly unknown[]) => { const n = nums(a[0]); return n.length ? Math.min(...n) : null; },
  max: (a: readonly unknown[]) => { const n = nums(a[0]); return n.length ? Math.max(...n) : null; },
  abs: (a: readonly unknown[]) => Math.abs(Number(a[0])),
  round: (a: readonly unknown[]) => Math.round(Number(a[0])),
  floor: (a: readonly unknown[]) => Math.floor(Number(a[0])),
  ceil: (a: readonly unknown[]) => Math.ceil(Number(a[0])),
  lower: (a: readonly unknown[]) => String(a[0] ?? '').toLowerCase(),
  upper: (a: readonly unknown[]) => String(a[0] ?? '').toUpperCase(),
  trim: (a: readonly unknown[]) => String(a[0] ?? '').trim(),
  toString: (a: readonly unknown[]) => (typeof a[0] === 'string' ? a[0] : JSON.stringify(a[0] ?? null)),
  toNumber: (a: readonly unknown[]) => Number(a[0]),
  contains: (a: readonly unknown[]) => (Array.isArray(a[0]) ? a[0].includes(a[1]) : String(a[0] ?? '').includes(String(a[1] ?? ''))),
  startsWith: (a: readonly unknown[]) => String(a[0] ?? '').startsWith(String(a[1] ?? '')),
  endsWith: (a: readonly unknown[]) => String(a[0] ?? '').endsWith(String(a[1] ?? '')),
  matches: (a: readonly unknown[]) => new RegExp(String(a[1] ?? ''), 's').test(String(a[0] ?? '')),
  join: (a: readonly unknown[]) => asArray(a[0]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(String(a[1] ?? ',')),
  split: (a: readonly unknown[]) => String(a[0] ?? '').split(String(a[1] ?? '')),
  if: (a: readonly unknown[]) => (truthy(a[0]) ? a[1] : a[2]),
  coalesce: (a: readonly unknown[]) => a.find((x) => x !== undefined && x !== null) ?? null,
  /** 占位：真正求值在 evalNode 里拦截（要用注入的 ctx.now）。这里存在只为让
   *  validateExpr 的函数名白名单认得 now()。 */
  now: () => { throw new Error('now() 只能经 evalNode 求值（需要注入时间源 EvalCtx.now）'); },
  /** 取某字段构成数组：map(list, "id") —— 比 $.list[*].id 更适合动态路径 */
  map: (a: readonly unknown[]) => asArray(a[0]).map((el) => queryOne(el, String(a[1] ?? '$'))),
  filter: (a: readonly unknown[]) => asArray(a[0]).filter((el) => truthy(queryOne(el, String(a[1] ?? '$')))),
  pluck: (a: readonly unknown[]) => asArray(a[0]).map((el) => (el as Record<string, unknown>)?.[String(a[1])]),
};

/** 求值上下文。vars 是变量空间，root 供 $. 起始的路径使用。 */
export interface EvalCtx {
  root: unknown;
  vars?: Record<string, unknown>;
  /** 时间注入点：压测/金样测试要冻结时钟（docs/00 §5.9） */
  now?: () => number;
}

/** 编译一次，执行多次。压测形态依赖这个分离（docs/09 §4.2）。 */
export interface Compiled {
  readonly source: string;
  eval(ctx: EvalCtx): unknown;
  /** 表达式里引用到的所有 $. 路径（静态闸/依赖分析用） */
  readonly refs: string[];
  readonly pure: boolean;
}

const cache = new Map<string, Compiled>();

export function compileExpr(src: string): Compiled {
  const hit = cache.get(src);
  if (hit) return hit;
  const ast = parse(src);
  const refs: string[] = [];
  (function collect(n: Node) {
    if (n.t === 'ref') refs.push(n.path);
    else if (n.t === 'bin') { collect(n.l); collect(n.r); }
    else if (n.t === 'un') collect(n.e);
    else if (n.t === 'arr') n.items.forEach(collect);
    else if (n.t === 'call') { n.args.forEach(collect); }
  })(ast);
  const pure = !hasImpure(ast);
  const c: Compiled = { source: src, refs: [...new Set(refs)], pure, eval: (ctx) => evalNode(ast, ctx) };
  cache.set(src, c);
  return c;
}

function hasImpure(n: Node): boolean {
  if (n.t === 'call') return n.name === 'now' || n.args.some(hasImpure);
  if (n.t === 'bin') return hasImpure(n.l) || hasImpure(n.r);
  if (n.t === 'un') return hasImpure(n.e);
  if (n.t === 'arr') return n.items.some(hasImpure);
  return false;
}

function evalNode(n: Node, ctx: EvalCtx): unknown {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'ref': {
      // 裸名优先查变量空间，再落到 root
      const bare = n.path.startsWith('$.') ? n.path.slice(2) : n.path.slice(1);
      if (ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, bare)) return ctx.vars[bare];
      if (ctx.vars && bare.includes('.')) {
        const head = bare.split('.')[0]!;
        if (Object.prototype.hasOwnProperty.call(ctx.vars, head)) {
          const sub = ctx.vars[head];
          try { return queryOne(sub, `$.${bare.slice(head.length + 1)}`); } catch { return undefined; }
        }
      }
      try { return queryOne(ctx.root, n.path); } catch { return undefined; }
    }
    case 'arr':
      return n.items.map((i) => evalNode(i, ctx));
    case 'un': {
      if (n.op === '!') return !truthy(evalNode(n.e, ctx));
      const v = Number(evalNode(n.e, ctx));
      return -v;
    }
    case 'bin':
      return evalBin(n, ctx);
    case 'call': {
      const fn = FUNCS[n.name];
      if (!fn) throw new ExprError(`未知函数 ${n.name}()`, n.name);
      // now() **必须**用注入的时间源。写成 `ctx.now ?? Date.now` 时，忘记传 ctx.now
      // 的调用点会安静地读到墙上时间 —— 冻结时钟失效且不报错，是最难查的一类不确定性。
      if (n.name === 'now') {
        if (!ctx.now) throw new ExprError('now() 需要注入时间源（EvalCtx.now）；引擎不得直接读墙上时间', 'now()');
        return ctx.now();
      }
      return fn(n.args.map((a) => evalNode(a, ctx)));
    }
  }
}

function evalBin(n: { op: string; l: Node; r: Node }, ctx: EvalCtx): unknown {
  const op = n.op;
  // 短路：必须早于求值右值
  if (op === '&&') return truthy(evalNode(n.l, ctx)) ? truthy(evalNode(n.r, ctx)) : false;
  if (op === '||') { const l = evalNode(n.l, ctx); return truthy(l) ? l : evalNode(n.r, ctx); }
  const l = evalNode(n.l, ctx);
  const r = evalNode(n.r, ctx);
  switch (op) {
    case '==': return looseEq(l, r);
    case '!=': return !looseEq(l, r);
    case '>': return cmp(l, r) > 0;
    case '>=': return cmp(l, r) >= 0;
    case '<': return cmp(l, r) < 0;
    case '<=': return cmp(l, r) <= 0;
    case 'in': return Array.isArray(r) ? r.some((x) => looseEq(x, l)) : String(r ?? '').includes(String(l ?? ''));
    case '+':
      if (typeof l === 'string' || typeof r === 'string') return `${fmt(l)}${fmt(r)}`;
      return num(l) + num(r);
    case '-': return num(l) - num(r);
    case '*': return num(l) * num(r);
    case '/': return num(r) === 0 ? null : num(l) / num(r);
    case '%': return num(r) === 0 ? null : num(l) % num(r);
    default: throw new ExprError(`未知运算符 ${op}`, op);
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (Array.isArray(a) || (a && typeof a === 'object')) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}
function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const x = num(a), y = num(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
/** 字符串化时不把字符串再包一层引号（否则 $.name + "!" 会变成 "\"Tom\"!"） */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

/** 求值并断言为布尔（用于 when / if / 条件断言） */
export function evalBool(src: string, ctx: EvalCtx): boolean {
  return truthy(compileExpr(src).eval(ctx));
}

/**
 * 静态校验：只解析不求值。dry-run 用它给出「表达式语法错误」而不是运行时爆炸。
 *
 * 这里额外查一遍**函数名**。拼错函数名（`lenght`/`sums`）在求值前不报错、
 * 求值时才抛，等于把一个纯拼写问题推到执行阶段 —— 而表达式语法是
 * 「生成期就该被抓完」的那类错误（docs/02 §2 生成器三闸）。
 * 报错必须列出可用函数，否则用户只能猜。
 */
export function validateExpr(src: string): string | null {
  try {
    const ast = parse(src);
    const bad: string[] = [];
    (function walk(n: Node) {
      if (n.t === 'call') {
        if (!(n.name in FUNCS)) bad.push(n.name);
        n.args.forEach(walk);
      } else if (n.t === 'bin') { walk(n.l); walk(n.r); }
      else if (n.t === 'un') walk(n.e);
      else if (n.t === 'arr') n.items.forEach(walk);
    })(ast);
    if (bad.length) {
      return `未知函数 ${[...new Set(bad)].map((b) => `${b}()`).join('、')}。可用：${Object.keys(FUNCS).sort().join(', ')}`;
    }
    return null;
  } catch (e) {
    return e instanceof ExprError || e instanceof PathError ? e.message : String(e);
  }
}
