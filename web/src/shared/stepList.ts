// 步骤/命令**列表 reducer 的共用内核**（1D T9，§11.4.12「UI 用例 / ADB 用例共用一个组件」）。
// ui/commands.ts 与 adb/commands.ts 的列表操作以前各抄一份（语义逐字相同，只差 id 前缀
// 与 config 合并规则）；抄两份迟早漂（R100/R101 立孪生测试防的就是这个），所以抽到这里。
// 两个 commands.ts 保留各自的原签名导出（孪生测试一行不改），内部改为调这里。
// 纪律不变：全部返回新数组不原地改；下标非法返回等值新数组，绝不抛。

// 内核只碰 id；不写 [key: string]: unknown——那会强迫所有行类型带索引签名，
// 而接口（interface）拿不到隐式索引签名，普通行类型会被白白卡住（tsc 实测）。
export interface StepRowLike {
  id: string;
}

/** 在 index 之后插入 row；index 越界裁到 [0, len]（插到开头/末尾仍是有义操作）。 */
export function insertAfterRow<T extends StepRowLike>(list: readonly T[], index: number, row: T): T[] {
  const copy = list.slice();
  const at = Math.max(0, Math.min(index + 1, copy.length));
  copy.splice(at, 0, row);
  return copy;
}

/** 删除 index 位；越界返回等值新数组。 */
export function removeRowAt<T extends StepRowLike>(list: readonly T[], index: number): T[] {
  if (index < 0 || index >= list.length) return list.slice();
  const copy = list.slice();
  copy.splice(index, 1);
  return copy;
}

/** 同层重排：把 from 移到 toIndex（先删后插，语义同 graphOps.reorder）。 */
export function moveRow<T extends StepRowLike>(list: readonly T[], from: number, toIndex: number): T[] {
  if (from < 0 || from >= list.length) return list.slice();
  const copy = list.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(Math.max(0, Math.min(toIndex, copy.length)), 0, item);
  return copy;
}

/** 下一个行 id：prefix + (已有 prefixN 的最大 N + 1)，空列表给 prefix+"1"。
 *  max+1 而非最小空位：永不复用已删 id（R102 的历史 step_key 唯一性）。 */
export function nextRowId<T extends StepRowLike>(
  prefix: string, existing: Iterable<T | string>,
): string {
  const re = new RegExp("^" + prefix + "(\\d+)$");
  let max = 0;
  for (const item of existing) {
    const id = typeof item === "string" ? item : item.id;
    const m = re.exec(id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix + (max + 1);
}

/** 复制 index 位：换新 id（max+1 口径）插回原位之后。clone 决定怎么脱离原行引用
 *  （UI 浅拷贝就够；ADB 的行带 config 嵌套对象，必须深一层，否则改了副本会写穿原件）。 */
export function duplicateRowAt<T extends StepRowLike>(
  list: readonly T[], index: number, prefix: string,
  clone: (src: T) => T = (src) => ({ ...src }),
): [T[], T | null] {
  if (index < 0 || index >= list.length) return [list.slice(), null];
  const copy = clone(list[index]);
  copy.id = nextRowId(prefix, list);
  const out = list.slice();
  out.splice(index + 1, 0, copy);
  return [out, copy];
}

/** 合并更新 index 位；merge 默认浅合并（ADB 传入 config 深一层的合并器）。 */
export function updateRowAt<T extends StepRowLike>(
  list: readonly T[], index: number, patch: Partial<T>,
  merge: (prev: T, patch: Partial<T>) => T = (prev, p) => ({ ...prev, ...p }),
): T[] {
  if (index < 0 || index >= list.length) return list.slice();
  const copy = list.slice();
  copy[index] = merge(copy[index], patch);
  return copy;
}
