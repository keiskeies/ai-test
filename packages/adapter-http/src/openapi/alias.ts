/**
 * 缺 operationId 时的**确定性别名**（docs/05 §1 第一行，标注"最容易埋进去的定时炸弹"）。
 *
 * 为什么这个纯函数值得单独一个文件：
 * 别名一旦落到场景 IR 里（`openapiCall.operationId`），它就是**持久化标识符**。
 * 算法只要不稳定，下一次重新导入 spec 时所有已生成的用例都会指向错误的接口 ——
 * 而且不会报错，只会静默地测错东西。所以这里的规则是：
 *
 *   1. 纯函数：同输入必同输出，不读环境、不读时间、不用随机数。
 *   2. 与**传入顺序无关**（见 resolveAliases 里的排序）。
 *   3. 冲突**报错**，绝不自动加后缀（静默改 id 会让已有场景指向另一个接口）。
 *
 * ── 与 docs/05 的偏差（同步记在 docs/04 §偏差）──────────────────────
 * 文档写的公式是 `method + path_norm + 排序后的 tag`。这里**故意不把 tag 放进键**：
 * 一份合法 OpenAPI 文档里 `path + method` 本身就已经唯一，所以 tag 对唯一性
 * 没有贡献；而 tag 是**纯展示性**字段 —— 后端把 `订单` 改成 `订单管理` 是一次
 * 无害的文案修改，若 tag 参与键，这次改文案会让该接口下所有已生成用例的
 * operationId 漂移。「一个 cosmetic 修改静默作废全部用例」正是这个函数要防的事故。
 */

/** 整段恰好是一个 `{param}`。带后缀的（`{id}.json`）不算，它有更具体的语义。 */
const PARAM_SEGMENT = /^\{[^}/]+\}$/;

/**
 * 切词：在非「字母/数字」处断开，并在 camelCase 边界处也断开。
 * 目的只是让别名**可读**（`getUsersUserIdPosts` 而不是 `getUserOrders` 糊成一坨），
 * 不承担唯一性 —— 见 normalizePath 末尾关于跨形状碰撞的说明。
 */
function words(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[^0-9A-Za-z]+/)) {
    if (!raw) continue;
    let cur = '';
    for (const ch of raw) {
      const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
      const prevLower = cur.length > 0 && cur[cur.length - 1] === cur[cur.length - 1]!.toLowerCase();
      if (isUpper && prevLower) { out.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out;
}

const cap = (w: string): string => (w ? w[0]!.toUpperCase() + w.slice(1) : w);
const low = (w: string): string => (w ? w[0]!.toLowerCase() + w.slice(1) : w);

/**
 * path -> 归一化词串：`/orders/{id}/items` -> `OrdersIdItems`。
 *
 * 参数段一律归一成 `Id`，**不看参数名**。这是刻意的稳定性取舍：
 * 把 path 参数从 `{orderNo}` 改名成 `{id}` 是常见的重构，若参数名参与别名，
 * 这次改名会作废该接口下所有用例。参数改名本该由 shape diff 报成
 * breaking 变更（docs/05 §1.1），而不是靠别名漂移来"提醒"。
 *
 * 已知会碰撞的形状：`/userOrders` 与 `/user/orders` 归一后相同（都是 `UserOrders`）。
 * 这里**不试图**消解它 —— 任何消解手段（加下划线、加序号）都会让别名变丑或变不稳。
 * 碰撞会被 resolveAliases 报成 AliasConflictError 让人工改名，
 * 也就是说它是**响亮的失败**，而不是静默串接口，这正是我们要的性质。
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const raw of path.split('/')) {
    if (!raw) continue; // 前导 / 与重复 // 都不产生段
    if (PARAM_SEGMENT.test(raw)) { parts.push('Id'); continue; }
    // 段内混排（`v{ver}` 之类）：抠掉参数后剩下的文字照常参与
    for (const w of words(raw.replace(/\{[^}/]+\}/g, ' '))) parts.push(w);
  }
  return parts.map(cap).join('');
}

/**
 * 别名本体：`method` 小写开头 + path 各段首字母大写，如 `getUsersUserIdPosts`。
 * 纯函数，且不含 tag，理由见文件头。
 */
export function aliasFor(method: string, path: string): string {
  const norm = normalizePath(path);
  return low(`${method.toLowerCase()}${norm || 'Root'}`);
}

export class AliasConflictError extends Error {
  constructor(
    message: string,
    public readonly alias: string,
    public readonly ops: string[],
  ) {
    super(message);
    this.name = 'AliasConflictError';
  }
}

export interface RawOp {
  method: string;
  path: string;
  /** spec 里作者手写的 operationId（有则优先，别名只用于缺失时） */
  operationId?: string;
  tags?: string[];
}

export interface AliasedOp extends RawOp {
  operationId: string;
  /** true 表示这个 id 是平台生成的。UI 要能看出来，且它进 `operation_alias`
   *  覆盖表被人工改名后，人工名的优先级最高。 */
  aliasGenerated: boolean;
}

const opKey = (o: { method: string; path: string }): string => `${o.method.toUpperCase()} ${o.path}`;

/**
 * 给一批 operation 分配 operationId。
 * 优先级：人工覆盖表 > spec 自带 operationId > 确定性别名。
 *
 * 冲突一律抛 AliasConflictError（docs/05 §1：「冲突即报错并要求人工改名，
 * **不要自动加后缀** —— 静默改 id 会让已有场景指向错误接口」）。
 * 报错信息里必须给出人工改名的出口，否则用户看到的是一条死路。
 *
 * @param overrides `operation_alias` 表：`"GET /orders/{id}" -> 人工指定的 id`
 */
export function resolveAliases(ops: RawOp[], overrides: Record<string, string> = {}): AliasedOp[] {
  // 排序保证**遍历顺序无关**：调用方数组顺序变了（spec 重解析、JSON 键序变化、
  // 数据库返回顺序变化）时，产出的别名与冲突判定必须完全一致。
  const sorted = [...ops].sort((a, b) => (opKey(a) < opKey(b) ? -1 : opKey(a) > opKey(b) ? 1 : 0));

  const byId = new Map<string, string[]>();
  const out: AliasedOp[] = [];
  for (const op of sorted) {
    const key = opKey(op);
    const override = overrides[key];
    const id = override ?? op.operationId ?? aliasFor(op.method, op.path);
    const list = byId.get(id) ?? [];
    list.push(key);
    byId.set(id, list);
    out.push({ ...op, operationId: id, aliasGenerated: override === undefined && !op.operationId });
  }

  // 报错顺序也要确定：Map 迭代序是插入序，插入序这里已随排序确定；
  // 再按 id 排一次，保证同一份 spec 在任何进程里给出同一条报错。
  for (const [id, keys] of [...byId].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (keys.length > 1) {
      throw new AliasConflictError(
        `operationId "${id}" 被 ${keys.length} 个 operation 同时使用（${keys.join('、')}）。` +
          `平台不会自动加后缀（那会让已有场景静默指向别的接口）。` +
          `请在 operation_alias 覆盖表里为其中一方指定新 id，键形如 ${keys.map((k) => `"${k}"`).join(' 或 ')}`,
        id,
        keys,
      );
    }
  }
  return out;
}
