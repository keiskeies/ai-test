/**
 * IR 的**值求值**（字面量 / 引用 / 表达式 / 生成器）—— 唯一一份实现。
 * 文件名刻意不叫 values.ts：`@atest/ir` 里已经有个 values.ts 定义值的**形状**，
 * 本文件管的是值的**求值**，重名会让人在 import 时拿错包。
 *
 * 为什么单独成文件：这段逻辑原先长在 interpreter 的闭包里。
 * M0.6 要加第二种执行形态（压测的预编译路径，docs/09 §4.2），
 * 如果把它**抄一份**过去，两条路径就会各自演化 ——
 * 于是出现"功能回归全绿、压测报退化 25%"这种查三天查不出来的东西。
 * 唯一可靠的做法是**共用同一份代码**，而不是"两份写得很像的代码"。
 *
 * 所以：解释器与预编译计划都调本文件的 resolveValue；
 * 谁想优化（比如预编译期把字面量固化），请在**本文件之上**加缓存层，
 * 而不是另起一条求值路径。
 */
import { compileExpr } from './expr.js';
import { VarError, type VarSpace } from './vars.js';
import type { Step } from '@atest/ir';
import type { Clock } from './adapters.js';

export interface ValueScope {
  vars: Pick<VarSpace, 'resolveRef' | 'asExprRoot' | 'visible'>;
  clock: Pick<Clock, 'now' | 'random'>;
}

/**
 * 把一个 IR 值解析成 JS 值。四种形态互斥，按 IR 的约定判定：
 * `{path}` / `{expr}` / `{gen}` 且**只有一个键**才算引用/表达式
 * （否则 `{"path": "src/a.ts"}` 这种普通对象会被误判成引用）。
 */
export function resolveValue(v: unknown, scope: ValueScope): unknown {
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (typeof o.path === 'string' && Object.keys(o).length === 1) {
    const r = scope.vars.resolveRef(o.path);
    // 未定义引用要抛：返回 undefined 会让它一路静默传下去，
    // 最后表现为"某字段是空的"，而真正的错在三步之前。
    if (!r.found) throw new VarError('引用未定义', o.path);
    return r.value;
  }
  if (typeof o.expr === 'string' && Object.keys(o).length === 1) {
    return compileExpr(o.expr).eval({ root: scope.vars.asExprRoot(), vars: scope.vars.visible(), now: scope.clock.now });
  }
  if (typeof o.gen === 'string') return generate(o.gen, (o.with as Record<string, unknown>) ?? {}, scope.clock);
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, scope));
  return Object.fromEntries(Object.entries(o).map(([k, vv]) => [k, resolveValue(vv, scope)]));
}

/**
 * 简易生成器。真实现应接 faker 并由 adapter 注入（引擎不许有 IO 依赖）。
 *
 * 时间类生成器一律走注入的 clock —— 早先它们直接读 Date.now()，
 * 于是"冻结时钟后回放结果逐字一致"在用到 email/oid 的场景上并不成立。
 */
export function generate(kind: string, w: Record<string, unknown>, clock: Pick<Clock, 'now' | 'random'>): unknown {
  const rnd = clock.random;
  switch (kind) {
    case 'int': { const min = Number(w.min ?? 0), max = Number(w.max ?? 1_000_000); return Math.floor(min + rnd() * (max - min + 1)); }
    case 'float': { const min = Number(w.min ?? 0), max = Number(w.max ?? 1); return +(min + rnd() * (max - min)).toFixed(Number(w.precision ?? 2)); }
    case 'string': { const len = Number(w.length ?? 8); const cs = 'abcdefghijklmnopqrstuvwxyz0123456789'; return Array.from({ length: len }, () => cs[Math.floor(rnd() * cs.length)]).join(''); }
    case 'bool': return rnd() > 0.5;
    case 'uuid': return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (rnd() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
    case 'email': return `test${clock.now().toString(36)}@example.com`;
    case 'phone': return `13${String(Math.floor(rnd() * 1e9)).padStart(9, '0')}`;
    case 'idcard': return `110101${1900 + Math.floor(rnd() * 100)}0101${String(Math.floor(rnd() * 10000)).padStart(4, '0')}`;
    case 'oid': return clock.now().toString(16).padStart(12, '0');
    case 'timestamp': return clock.now();
    case 'date': return new Date(clock.now()).toISOString().slice(0, 10);
    case 'datetime': return new Date(clock.now()).toISOString();
    case 'oneOf': { const arr = (w.values as unknown[]) ?? []; return arr[Math.floor(rnd() * arr.length)]; }
    case 'password': return `P@ss${String(Math.floor(rnd() * 1e6)).padStart(6, '0')}`;
    default: return undefined;
  }
}

// ── 两条执行路径共用的三个小语义 ───────────────────────────────────────────
// 放在这里是刻意的：预编译形态（executor.ts）要与解释器**逐字节同语义**，
// 而 toIterable "对象取 values"、looseEq "数字与数字字符串相等"这类细节
// 正是最容易在两份实现之间悄悄分叉的地方 —— 分叉的后果是
// "功能回归全绿、压测报退化"，极难查。

/** 迭代对象的取集合：数组原样，对象取 values，标量包成单元素（null/undefined 是空集） */
export function toIterable(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>);
  return v === undefined || v === null ? [] : [v];
}

/** repeat 的展开。id 加 `#i` 后缀，让 extract/引用能区分是第几轮。 */
export function flattenTimes(times: number, steps: Step[]): Step[] {
  const out: Step[] = [];
  for (let i = 0; i < times; i++) for (const s of steps) out.push({ ...s, id: `${s.id}#${i}` });
  return out;
}

/** switch 的比较。数字与数字字符串视为相等（spec 里 status 有时是 "200" 有时是 200）。 */
export function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
