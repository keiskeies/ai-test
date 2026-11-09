/**
 * `$ref` 解析（docs/05 §1 第 3 行：「`$ref` 跨文件 + 循环引用」，出现频率：高）。
 *
 * 两个不寻常的要求，决定了这里不是「一行 JSON Pointer 查找」：
 *
 * 1. **循环 schema 必须能表示，不能栈溢出。** 真实 spec 里
 *    `TreeNode { children: array<TreeNode> }` 遍地都是。这里的做法是：
 *    解析栈上已经出现过的 ref 不再展开，改插一个 `CYCLE` 标记节点。
 *    数据生成器读到标记就停（深度上限另说），而不是无限递归。
 *
 * 2. **部分失败不整体失败。** 大 spec 里 5% 的 operation 坏掉很常见。
 *    坏掉的那条要**记成问题上报**并继续解析其余部分 ——
 *    「导入失败」意味着用户面对一个空平台，而「3 个接口有问题」意味着他能立刻开工。
 *    所以本文件的函数一律返回 `{ value, issues }` 而不是抛异常。
 *    （只有别名冲突是抛的 —— 那个必须阻断，见 alias.ts。）
 */

export interface RefIssue {
  level: 'error' | 'warn';
  code: 'REF_UNRESOLVED' | 'REF_EXTERNAL_MISSING' | 'SPEC_INVALID' | 'OPERATION_SKIPPED';
  message: string;
  /** JSON Pointer 形式的位置，让用户能在原始 spec 里找到它 */
  at: string;
}

/** 环标记节点。正常 schema 里不会出现 `x-cycle` 这个键，所以不会撞名。 */
export interface CycleNode {
  'x-cycle': string;
}
export function isCycleNode(v: unknown): v is CycleNode {
  return typeof v === 'object' && v !== null && 'x-cycle' in v;
}

/** 外部文档解析器。测试里给内存 map，服务端给「读 DB 里的 zip 包」。 */
export type ExternalResolver = (uri: string) => unknown | undefined | Promise<unknown | undefined>;

export interface SpecDoc {
  root: Record<string, unknown>;
  resolveExternal?: ExternalResolver;
}

/** JSON Pointer（RFC 6901）求值，带 `~0`/`~1` 转义。 */
export function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === '' || ptr === '/') return doc;
  let cur: unknown = doc;
  for (const raw of ptr.split('/').slice(ptr.startsWith('/') ? 1 : 0)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!(key in (cur as Record<string, unknown>))) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** `#/components/schemas/Foo` -> 本地指针；`./common.yaml#/Foo` -> 外部。 */
function splitRef(ref: string): { uri: string; ptr: string } {
  const hash = ref.indexOf('#');
  if (hash < 0) return { uri: ref, ptr: '' };
  return { uri: ref.slice(0, hash), ptr: ref.slice(hash + 1) };
}

export interface Dereferenced {
  value: unknown;
  issues: RefIssue[];
}

/**
 * 就地展开 `$ref`，环处插 CYCLE 标记。
 *
 * @param maxDepth 展开的**嵌套层数**上限（不是 schema 深度）。环检测已能防无限递归，
 *   这个上限是防「无环但极深」的 spec（递归定义 + 多层 allOf 展开后是指数级的）。
 */
export function dereference(
  node: unknown,
  doc: SpecDoc,
  opts: { at?: string; maxDepth?: number; externals?: Map<string, unknown> } = {},
): Dereferenced {
  const issues: RefIssue[] = [];
  const maxDepth = opts.maxDepth ?? 12;
  // 外部文档是**异步**拉取的，而 dereference 是同步热路径（每次请求校验都要走一遍）。
  // 所以调用方要先 preloadExternals 再把 cache 传进来（早先这里自己 new 了一个空 Map，
  // 于是 preload 的结果压根没人读 —— 预载变成了纯装饰，每次 deref 仍然同步去取外部文档）。
  const externalCache = opts.externals ?? new Map<string, unknown>();

  const walk = (v: unknown, stack: string[], depth: number, at: string): unknown => {
    if (depth > maxDepth) {
      issues.push({ level: 'warn', code: 'SPEC_INVALID', message: `schema 嵌套超过 ${maxDepth} 层，此处截断`, at });
      return { 'x-cycle': '<maxDepth>' };
    }
    if (Array.isArray(v)) return v.map((el, i) => walk(el, stack, depth + 1, `${at}/${i}`));
    if (v === null || typeof v !== 'object') return v;

    const obj = v as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === 'string') {
      if (stack.includes(ref)) return { 'x-cycle': ref };
      const { uri, ptr } = splitRef(ref);
      let target: unknown;
      if (uri === '') target = pointer(doc.root, ptr);
      else {
        let ext = externalCache.get(uri);
        if (ext === undefined) {
          ext = doc.resolveExternal?.(uri);
          if (ext !== undefined && ext !== null) externalCache.set(uri, ext);
          if (ext === undefined || ext === null) {
            issues.push({
              level: 'error', code: 'REF_EXTERNAL_MISSING',
              message: `外部引用 "${ref}" 无法解析${doc.resolveExternal ? '（解析器返回空）' : '（未提供外部解析器）'}。该 operation 将被跳过，其余接口照常可用`,
              at,
            });
            return undefined;
          }
        }
        target = pointer(ext, ptr);
      }
      if (target === undefined) {
        issues.push({ level: 'error', code: 'REF_UNRESOLVED', message: `引用 "${ref}" 指向不存在的位置`, at });
        return undefined;
      }
      // $ref 的兄弟键在 OpenAPI 3.0 里被忽略（3.1 才允许并列）。这里跟随 3.0 语义，
      // 但把它们**记下来**：`{$ref: ..., description: ...}` 这种写法极常见，
      // 静默丢掉 description 会让生成的用例少掉最有用的语义线索。
      const siblings = Object.keys(obj).filter((k) => k !== '$ref');
      const resolved = walk(target, [...stack, ref], depth + 1, `${at}/$ref -> ${ref}`);
      if (siblings.length && resolved && typeof resolved === 'object' && !isCycleNode(resolved)) {
        const merged = { ...resolved } as Record<string, unknown>;
        for (const k of siblings) if (merged[k] === undefined) merged[k] = obj[k];
        if (siblings.includes('description')) {
          issues.push({ level: 'warn', code: 'SPEC_INVALID', message: `$ref 旁的 ${siblings.join('/')} 在 OpenAPI 3.0 语义下应被忽略，此处保留`, at });
        }
        return merged;
      }
      return resolved;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) out[k] = walk(val, stack, depth + 1, `${at}/${k}`);
    return out;
  };

  return { value: walk(node, [], 0, opts.at ?? '#'), issues };
}

/**
 * 找出 spec 里所有 `$ref`（用于「预载外部文档」与「spec diff 的影响面分析」）。
 * 不解析、不校验，纯遍历 —— 网络请求要先于解析发生。
 */
export function collectRefs(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) { for (const el of node) collectRefs(el, out); return out; }
  if (node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$ref' && typeof v === 'string') out.add(v);
    else collectRefs(v, out);
  }
  return out;
}

/** 把外部 ref 拉进来（服务端导入 spec 时调用）。单个外部文档拉失败不影响其余。 */
export async function preloadExternals(
  doc: SpecDoc,
  fetcher: (uri: string) => Promise<unknown>,
): Promise<{ cache: Map<string, unknown>; issues: RefIssue[] }> {
  const cache = new Map<string, unknown>();
  const issues: RefIssue[] = [];
  const refs = [...collectRefs(doc.root)].map(splitRef).filter((r) => r.uri !== '');
  for (const { uri } of refs) {
    if (cache.has(uri)) continue;
    try {
      cache.set(uri, await fetcher(uri));
    } catch (e) {
      issues.push({
        level: 'error', code: 'REF_EXTERNAL_MISSING',
        message: `外部文档 "${uri}" 拉取失败：${e instanceof Error ? e.message : String(e)}。引用它的接口会被跳过`, at: uri,
      });
    }
  }
  return { cache, issues };
}
