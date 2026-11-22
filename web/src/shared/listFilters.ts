// 列表高级搜索的前端半边（§11.5.1「视图选择器 + 高级搜索 AND/OR」，D47-a）。
//
// 行为照 MeterSphere v3 的 ms-advance-filter 语义（读语义不抄码，见
// docs/2026-01-20-metersphere-parity-audit.md §2.1.1；我们是 React+AntD，MS 是 Vue+Arco，
// 组件搬不过来了也不该搬）。条件形状与后端 app/shared/filters.py 一字不差：
//
//     {search_mode: "AND" | "OR", conditions: [{field, operator, value}]}
//
// **操作符人话名这份表是后端 OPERATOR_LABELS 的镜像**，由
// listFilters.mirror.test.ts 逐字读后端源码核对（第 29 轮「同一枚举多端镜像」那条轴：
// 两份清单不互相核对就必然漂移，assertionTypes.contract.test.ts 同法）。
// 字段清单与「每个字段能用哪些操作符」**不在这里**——那是后端 filter_meta 给的，
// 前端不列字段名，也就没有可漂的地方。
export type SearchMode = "AND" | "OR";

export interface FilterCondition {
  field: string;
  operator: string;
  /** 值控件按 operator 决定：EMPTY/NOT_EMPTY 无值；IN/NOT_IN 与 BETWEEN 是数组；其余单值。 */
  value?: unknown;
}

export interface FilterDoc {
  search_mode: SearchMode;
  conditions: FilterCondition[];
}

/** 一条空筛选。**「没有筛选条件」只有这一种写法**，不要用 null 表示：
 * 后端把「给了对象却没有 conditions 键」判成坏条件（400），不判成「没筛选」。 */
export function emptyFilter(): FilterDoc {
  return { search_mode: "AND", conditions: [] };
}

export function isFilterEmpty(f: FilterDoc | null | undefined): boolean {
  return !f || !f.conditions || f.conditions.length === 0;
}

/** 操作符人话名（后端 OPERATOR_LABELS 的镜像，测试钉相等）。 */
export const OPERATOR_LABELS: Record<string, string> = {
  CONTAINS: "包含", NOT_CONTAINS: "不包含",
  IN: "属于", NOT_IN: "不属于",
  EQUALS: "等于", NOT_EQUALS: "不等于",
  GT: "大于", LT: "小于", BETWEEN: "介于",
  EMPTY: "为空", NOT_EMPTY: "不为空",
};

/** 后端明确不提供的操作符 → 原因（来自 filter_meta.unavailable，这里只兜底类型）。 */
export type Unavailable = Record<string, string>;

/** filter_meta 的一条字段（后端 filter_registry.ListViewFilter.meta() 的形状）。 */
export interface FieldMeta {
  field: string;
  label: string;
  /** 值控件型：text / enum / number / time / id / bool。 */
  kind: string;
  /** 这一列可用的操作符（后端按 kind + 列可空性算好，前端不再算）。 */
  ops: string[];
}

export interface FilterMeta {
  operators: string[];
  labels: Record<string, string>;
  kinds: Record<string, string[]>;
  unavailable: Unavailable;
  supported_view_types: string[];
  fields: FieldMeta[];
  view_label: string | null;
}

export interface SavedView {
  id: string;
  project_id: string;
  view_type: string;
  name: string;
  conditions: FilterDoc;
  pos: number;
  updated_at: string;
}

/** 筛选 → query 串片段。空筛选**不拼参数**（而不是拼 `filter=`）：
 * 空串后端按「没筛选」处理，但把「没筛选」写成有参数会让 URL 出现一条骗人的参数。 */
export function filterQuery(f: FilterDoc | null | undefined): string {
  if (isFilterEmpty(f)) return "";
  return "&filter=" + encodeURIComponent(JSON.stringify(f));
}

/** 条件 → 人话摘要（视图列表与「当前筛选」提示条都要说清筛的是什么）。 */
export function describeFilter(f: FilterDoc | null | undefined, fields: FieldMeta[]): string {
  if (isFilterEmpty(f)) return "全部数据";
  const label = (c: FilterCondition) =>
    fields.find((x) => x.field === c.field)?.label ?? c.field;
  const joiner = f!.search_mode === "OR" ? " 或 " : " 且 ";
  return f!.conditions.map((c) => {
    const op = OPERATOR_LABELS[c.operator] ?? c.operator;
    if (c.operator === "EMPTY" || c.operator === "NOT_EMPTY") return `${label(c)}${op}`;
    const v = c.value;
    const shown = Array.isArray(v) ? v.map(String).join("/") : String(v ?? "");
    return `${label(c)}${op} ${shown}`;
  }).join(joiner);
}

/** 这一列该摆什么值控件。kind 目前不影响结论（每种 kind 的单值控件都是 Input/Select，
 * 具体用哪个由页面按 kind 自己挑），留着它是为了让调用点不必自己记 operator 的规则。 */
export function valueControlKind(op: string): "none" | "multi" | "range" | "single" {
  if (op === "EMPTY" || op === "NOT_EMPTY") return "none";
  if (op === "IN" || op === "NOT_IN") return "multi";
  if (op === "BETWEEN") return "range";
  return "single";
}

/** 换字段/换操作符后把值清干净。
 * 留着上一个操作符的值会发出 `{operator:"IN", value:"字符串"}` 这种后端必 400 的条件，
 * 而用户看见的界面上什么都没改——所以宁可清掉让他重填。 */
export function resetValueFor(op: string): unknown {
  if (op === "EMPTY" || op === "NOT_EMPTY") return undefined;
  if (op === "IN" || op === "NOT_IN") return [];
  if (op === "BETWEEN") return [undefined, undefined];
  return undefined;
}

/** 一列可选操作符：直接用后端给的 ops（不在前端按 kind 重算一遍，那是第二份真相）。 */
export function opsFor(meta: FilterMeta | null, field: string): string[] {
  return meta?.fields.find((f) => f.field === field)?.ops ?? [];
}

/** 时刻值 ↔ `<input type="datetime-local">` 的本地墙上时间串（"YYYY-MM-DDTHH:mm"）。
 *
 * 为什么不用 AntD 的 DatePicker：它要求 value 是 dayjs 对象，而本仓**没有 dayjs 这个直接依赖**
 * （antd 把它放在自己的依赖树里，没提到根，import 不到；为筛选项加直接依赖要走 §5 评审）。
 * 原生 datetime-local 的值就是纯字符串，我们能完整读写它——这一点很重要：第一版这里图省事
 * 写了 `value={null}`，条件是 UTC 时刻而控件画成空的，用户重开面板会以为时间条件没填上，
 * 点「应用」就把它清掉了。**控件必须能把当前值原样显示出来**，否则它就是骗人的。
 *
 * 时区口径：后端 `_time()` 把「无时区的字面量」按 UTC 解释（filters.py 的 docstring）。
 * datetime-local 给的是浏览器本地墙上时间，直接发出去会被当成 UTC，差一个时区。
 * 所以这里显式换算：出去时带上真实偏移（→ ISO +00:00 形式），进来时把 UTC 换回本地墙上时间。
 */
export function timeFromLocalInput(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);           // 无 Z 的字面量按本地时区解析，正是我们要的
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();              // 带 Z，后端 _time() 认得并换算成 UTC naive
}

export function timeToLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 哪些条件还没填完 → 返回它们的展示名（空数组 = 可以发）。
 *
 * 为什么必须在发之前挡：后端对 `{"operator":"CONTAINS"}`（没有 value）是 **400**
 * （`_one()` 要字符串），而对 `CONTAINS ""` 会编成 `LIKE '%%'` 命中全表——
 * 前者是点了报错误，后者是筛了个寂寞还看着像生效了。两种都比「不让你点」糟。
 * 所以半填的条件在前端就挡住，并点名是哪一条（只说「请填写完整」等于让人猜）。
 */
export function incompleteConds(f: FilterDoc, fields: FieldMeta[]): string[] {
  const name = (field: string) => fields.find((x) => x.field === field)?.label ?? field;
  const blank = (v: unknown) =>
    v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  const bad: string[] = [];
  for (const c of f.conditions) {
    if (c.operator === "EMPTY" || c.operator === "NOT_EMPTY") continue;   // 本来就不要值
    if (c.operator === "BETWEEN") {
      const v = Array.isArray(c.value) ? (c.value as unknown[]) : [];
      if (blank(v[0]) || blank(v[1])) bad.push(name(c.field));
      continue;
    }
    if (c.operator === "IN" || c.operator === "NOT_IN") {
      const v = Array.isArray(c.value) ? (c.value as unknown[]) : [];
      if (v.length === 0 || v.every(blank)) bad.push(name(c.field));      // 后端 _as_list 要非空数组
      continue;
    }
    if (blank(c.value)) bad.push(name(c.field));
  }
  return bad;
}

/** 列设置本地持久化键。带 view_type：接口页藏了「请求方法」不该把报告页也藏了。 */
export function columnPrefsKey(viewType: string): string {
  return `tp.listCols.${viewType}`;
}

export interface ColumnPref { hidden: string[] }

/** 读列设置。**读不到/坏了都返回 null**（= 没设过，用列的默认显隐），不返回空隐藏集：
 * 后者会把「用户从没设过」和「用户的设置坏了」都说成「全都显示」，
 * 而后者其实该提示他去重设。 */
export function loadColumnPrefs(viewType: string, allKeys: string[]): ColumnPref | null {
  try {
    const raw = localStorage.getItem(columnPrefsKey(viewType));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ColumnPref;
    if (!parsed || !Array.isArray(parsed.hidden)) return null;
    // 只认现在真存在的列：删掉一列后，老配置里的残名不该让这份设置整个失效
    return { hidden: parsed.hidden.filter((k) => allKeys.includes(k)) };
  } catch {
    return null;
  }
}

export function saveColumnPrefs(viewType: string, pref: ColumnPref): void {
  try {
    localStorage.setItem(columnPrefsKey(viewType), JSON.stringify(pref));
  } catch {
    // localStorage 可能因配额或隐私模式抛错。列设置是偏好，丢了只是下次进来用默认显隐，
    // 不该把整个列表页变成一个错误页——这里沉默是有意的，但必须写明为什么沉默。
  }
}

/** 列设置面板要的列描述。render 不在这里（那是页面自己的 AntD 列），这里只要名字。 */
export interface ColumnChoice { key: string; label: string }

/** 把 hidden 集翻成 Checkbox 的勾选态（勾 = 显示）。 */
export function checkedKeys(all: ColumnChoice[], pref: ColumnPref | null): string[] {
  const hidden = new Set(pref?.hidden ?? []);
  return all.filter((c) => !hidden.has(c.key)).map((c) => c.key);
}

export function hiddenFromChecked(all: ColumnChoice[], checked: string[]): ColumnPref {
  const on = new Set(checked);
  return { hidden: all.filter((c) => !on.has(c.key)).map((c) => c.key) };
}

/** 按列设置过滤 AntD columns。
 * 只过滤、不改列对象：页面的列里带着 render/onCell 等，重写一遍就等于把页面的
 * 渲染逻辑抄到共享组件里，第二页接进来时两份渲染必然分叉。 */
export function applyColumnPrefs<T extends { key?: React.Key }>(
  columns: T[], pref: ColumnPref | null,
): T[] {
  if (!pref || pref.hidden.length === 0) return columns;
  const hidden = new Set(pref.hidden);
  return columns.filter((c) => !(c.key != null && hidden.has(String(c.key))));
}
