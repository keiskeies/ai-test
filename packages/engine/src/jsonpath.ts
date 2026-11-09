/**
 * JSONPath 子集求值器（docs/02 §5 的 `$.` 语法）。
 *
 * 为什么自研而不用 jsonpath-plus / jsonata：
 *  1. 本机无外网，这两个包都不在缓存里（已实测）；
 *  2. 我们只需要一个**可静态分析**的子集 —— 静态闸要能从引用里解出
 *     「引用了哪个步骤的哪个字段」来做未定义变量检测与来源跳转（docs/12 §6 VarChip）。
 *     通用库的任意表达式能力恰好是静态分析的敌人。
 *
 * 支持语法（刻意保守）：
 *   $.step.login.resp.data.token      点号路径
 *   $.data.list[0].id                 数组下标
 *   $.data.list[*].id                 通配（返回列表）
 *   $.data["odd-key"]                 中括号字符串键
 *   $..name                           递归后代（仅供 extract 用，lint 不鼓励）
 *
 * 不支持：切片 [1:3]、过滤 [?(@.x)]、函数调用。需要聚合请用 expr（JSONata 风格子集）。
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface PathSegment {
  kind: 'key' | 'index' | 'wildcard' | 'recursive';
  value?: string | number;
}

export class PathError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${message}（路径：${path}）`);
    this.name = 'PathError';
  }
}

/**
 * 解析成段。解析失败抛 PathError —— 静态闸用它做语法校验。
 *
 * 接受 `$.name` 与 `$name` **两种写法**。这不是宽容，是必要性：
 * 表达式引擎里 `$ready` 是合法写法，若引用路径只认 `$.ready`，
 * 同一套引用语言就有了两种互不兼容的方言 —— 用户写 `against: "$x"`
 * 得到「意外字符 x」，而同一份 IR 里 `expr: "$x > 1"` 却能用，
 * 这种不一致比少支持一种写法贵得多。
 */
export function parsePath(path: string): PathSegment[] {
  if (!path.startsWith('$')) throw new PathError('引用必须以 $ 开头', path);
  const segs: PathSegment[] = [];
  let i = 1;
  // `$foo` —— $ 后直接跟标识符（无点号），视作第一个键
  if (i < path.length && path[i] !== '.' && path[i] !== '[') {
    const key = readIdent(path, i, path);
    if (!key) throw new PathError(`$ 后必须是 . 或 [ 或标识符，实得 "${path[i]}"`, path);
    segs.push({ kind: 'key', value: key.text });
    i = key.next;
  }
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      if (path[i + 1] === '.') {
        i += 2;
        const key = readIdent(path, i, path);
        if (!key) throw new PathError('$.. 后必须跟键名', path);
        // 递归段**自带键名**：query 的 recursive 分支直接拿 seg.value 去收集，
        // 早先拆成 recursive + key 两段时 seg.value 是 undefined，
        // 于是 `$..id` 永远返回空 —— 递归搜索在整个引擎里其实没生效过。
        segs.push({ kind: 'recursive', value: key.text });
        i = key.next;
        continue;
      }
      const key = readIdent(path, i + 1, path);
      if (!key) throw new PathError('. 后必须跟键名或 [', path);
      segs.push({ kind: 'key', value: key.text });
      i = key.next;
      continue;
    }
    if (c === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) throw new PathError('中括号未闭合', path);
      const inner = path.slice(i + 1, end).trim();
      if (inner === '*') segs.push({ kind: 'wildcard' });
      else if (/^\d+$/.test(inner)) segs.push({ kind: 'index', value: Number(inner) });
      else if (/^(['"]).*\1$/.test(inner)) segs.push({ kind: 'key', value: inner.slice(1, -1) });
      else throw new PathError(`不支持的下标 "${inner}"（仅支持数字、*、引号键名）`, path);
      i = end + 1;
      continue;
    }
    throw new PathError(`意外字符 "${c}"`, path);
  }
  return segs;
}

function readIdent(path: string, from: number, full: string): { text: string; next: number } | null {
  let j = from;
  while (j < path.length && /[\w$一-龥-]/.test(path[j]!)) j++;
  if (j === from) return null;
  void full;
  return { text: path.slice(from, j), next: j };
}

export interface QueryResult {
  /** 命中值。wildcard/recursive 返回数组（即使只命中一个） */
  values: unknown[];
  /** 命中值的来源路径，用于报错与 UI 溯源 */
  paths: string[];
  /** 是否多命中（多命中时断言必须显式声明，否则 lint 提示） */
  ambiguous: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function query(root: unknown, path: string): QueryResult {
  const segs = parsePath(path);
  let cur: { value: unknown; path: string }[] = [{ value: root, path: '$' }];
  let wild = false;

  for (const seg of segs) {
    const next: { value: unknown; path: string }[] = [];
    for (const node of cur) {
      switch (seg.kind) {
        case 'key': {
          const v = node.value;
          if (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, seg.value as string)) {
            next.push({ value: (v as Record<string, unknown>)[seg.value as string], path: `${node.path}.${seg.value}` });
          }
          break;
        }
        case 'index': {
          const v = node.value;
          if (Array.isArray(v)) {
            const idx = seg.value as number;
            if (idx < v.length) next.push({ value: v[idx], path: `${node.path}[${idx}]` });
          }
          break;
        }
        case 'wildcard': {
          wild = true;
          const v = node.value;
          if (Array.isArray(v)) v.forEach((el, k) => next.push({ value: el, path: `${node.path}[${k}]` }));
          else if (isPlainObject(v)) for (const [k, val] of Object.entries(v)) next.push({ value: val, path: `${node.path}.${k}` });
          break;
        }
        case 'recursive': {
          wild = true;
          collectAll(node.value, node.path, seg.value as string, next, 0);
          break;
        }
      }
    }
    cur = next;
    if (!cur.length) break;
  }

  return { values: cur.map((c) => c.value), paths: cur.map((c) => c.path), ambiguous: wild || cur.length > 1 };
}

const MAX_DEPTH = 24;
function collectAll(v: unknown, p: string, key: string, out: { value: unknown; path: string }[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (k === key) out.push({ value: val, path: `${p}.${k}` });
      collectAll(val, `${p}.${k}`, key, out, depth + 1);
    }
  } else if (Array.isArray(v)) {
    v.forEach((el, i) => collectAll(el, `${p}[${i}]`, key, out, depth + 1));
  }
}

/** 单值取用。未命中返回 undefined；多命中且未显式允许时报错（避免静默取第一个）。 */
export function queryOne(root: unknown, path: string, opts: { allowAmbiguous?: boolean } = {}): unknown {
  const r = query(root, path);
  if (r.values.length === 0) return undefined;
  if (r.values.length > 1 && !opts.allowAmbiguous) {
    throw new PathError(`路径命中 ${r.values.length} 个值，请缩小范围或改用 expr 聚合`, path);
  }
  return r.values[0];
}

/** 路径是否引用了某个步骤的输出（静态闸与 VarChip 用它解析来源）。 */
export interface RefInfo {
  /** step.<id>.<rest> 里的 id */
  stepId?: string;
  /** run.inputs.x 里的 inputs.x */
  scope?: 'step' | 'run' | 'scenario' | 'env' | 'secret' | 'loop' | 'outputs';
  rest?: string;
}

export function parseRef(path: string): RefInfo {
  const segs = parsePath(path);
  if (!segs.length) return {};
  const first = segs[0];
  if (first?.kind !== 'key' || typeof first.value !== 'string') return {};
  const scope = first.value as RefInfo['scope'];
  if (scope === 'step' && segs[1]?.kind === 'key') {
    return { scope: 'step', stepId: segs[1].value as string, rest: segs.slice(2).map(stringifySeg).join('') };
  }
  if (scope === 'run' || scope === 'scenario' || scope === 'env' || scope === 'secret' || scope === 'loop' || scope === 'outputs') {
    return { scope, rest: segs.slice(1).map(stringifySeg).join('').replace(/^\./, '') };
  }
  // 裸变量名（loop 变量等）
  return { scope: undefined, rest: segs.map(stringifySeg).join('').replace(/^\./, '') };
}

function stringifySeg(s: PathSegment): string {
  if (s.kind === 'key') return `.${s.value}`;
  if (s.kind === 'index') return `[${s.value}]`;
  if (s.kind === 'wildcard') return '[*]';
  return '..';
}

/** 把值写回某路径（extract/set 的实现基础）。只支持具体路径，不支持通配。 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = parsePath(path);
  const usable = segs[0]?.kind === 'key' && segs[0].value === '$' ? segs.slice(1) : segs;
  if (!usable.length) throw new PathError('路径太短', path);
  let cur: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < usable.length - 1; i++) {
    const s = usable[i]!;
    if (s.kind === 'wildcard' || s.kind === 'recursive') throw new PathError('赋值路径不支持通配', path);
    const k = s.kind === 'index' ? (s.value as number) : (s.value as string);
    const nxt = (cur as Record<string | number, unknown>)[k];
    if (nxt === undefined || nxt === null || typeof nxt !== 'object') {
      const created: Record<string, unknown> | unknown[] = usable[i + 1]!.kind === 'index' ? [] : {};
      (cur as Record<string | number, unknown>)[k] = created;
      cur = created;
    } else {
      cur = nxt as Record<string, unknown> | unknown[];
    }
  }
  const last = usable[usable.length - 1]!;
  if (last.kind === 'wildcard' || last.kind === 'recursive') throw new PathError('赋值路径不支持通配', path);
  (cur as Record<string | number, unknown>)[last.kind === 'index' ? (last.value as number) : (last.value as string)] = value;
}
