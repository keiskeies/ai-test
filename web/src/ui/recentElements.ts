// §11.4.13 元素选择器的「最近使用」内核（1C T16）：localStorage 键 tp_ui_recent_elements
// 的解析/更新，纯模块（不 import React/DOM；kv 由调用方注入，组件传 localStorage）。
// 纪律：这个键是**客户端可写的缓存**——坏 JSON、不是数组、元素不是对象、缺字段、超长，
// 一律降级成「忽略该条/清空重来」，绝不让选择器崩（recentElements.test.ts 钉住每条守卫）。
export const RECENT_KEY = "tp_ui_recent_elements";
export const MAX_RECENT = 8; // 计划点名「最近 8 个」

export interface RecentEntry {
  id: string;
  name: string;
}

/** 最小 kv 形态：组件传 localStorage，测试传假对象——模块因此可跑在 node 环境。 */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function validEntry(x: unknown): x is RecentEntry {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const e = x as { id?: unknown; name?: unknown };
  return typeof e.id === "string" && e.id !== "" && typeof e.name === "string" && e.name !== "";
}

/** 解析存储原文：任何畸形输入 → 尽量 salvage、salvage 不动就空表，绝不抛。 */
export function parseRecent(raw: string | null | undefined): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentEntry[] = [];
  for (const item of data) {
    if (!validEntry(item)) continue;
    if (out.some((r) => r.id === item.id)) continue; // 重复 id 保留第一条（已是较近位置）
    out.push({ id: item.id, name: item.name });
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

/** 把 entry 顶到最前（同 id 去重后前移），裁到 MAX_RECENT。entry 本身非法 → 原表返回。 */
export function pushRecent(raw: string | null | undefined, entry: RecentEntry): RecentEntry[] {
  const cur = parseRecent(raw);
  if (!validEntry(entry)) return cur;
  return [{ id: entry.id, name: entry.name }, ...cur.filter((r) => r.id !== entry.id)]
    .slice(0, MAX_RECENT);
}

/** 读 + 解析（getItem 本身也可能抛：禁 cookie 的浏览器），失败都是空表。 */
export function readRecent(store: KV): RecentEntry[] {
  try {
    return parseRecent(store.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

/** 写。隐私模式/配额满时 setItem 会抛：最近使用是锦上添花，写失败静默但不能崩。 */
export function writeRecent(store: KV, list: RecentEntry[]): void {
  try {
    store.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* 忽略：下次读不到就空表 */ }
}
