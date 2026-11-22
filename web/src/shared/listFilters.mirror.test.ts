// 高级搜索的「前后端两份清单」哨兵（D47-a §11.5.1）。
//
// 手法照 assertionTypes.contract.test.ts / runVocab.test.ts：readFileSync 后端源码把集合
// 抠出来当场对，**读不到就抛、绝不静默跳过**——跳过的契约测试等于没有契约。
//
// 这里刻意只钉**会漂的那两份**：
// ① OPERATOR_LABELS（前端一份、后端一份的人话名表）；
// ② 条件 JSON 的字段名（前端 TS interface 的键 ↔ 后端读的键）。
// 字段清单与每字段可用操作符**不在前端**，来自后端 filter_meta，所以没有可漂的副本——
// 这正是把它们推到后端的原因（第 29 轮「同一枚举多端镜像」那条轴）。
// 列设置要 localStorage，所以本文件走 jsdom（仓库惯例：逐文件 @vitest-environment，
// 不把 jsdom 全局打开——纯模块单测维持 node 环境，见 vitest.config.ts 的注释）。
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { OPERATOR_LABELS, describeFilter, emptyFilter, filterQuery, isFilterEmpty,
  hiddenFromChecked, checkedKeys, loadColumnPrefs, saveColumnPrefs, applyColumnPrefs,
  resetValueFor, valueControlKind, type FilterDoc, type FieldMeta } from "./listFilters";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_FILTERS = join(HERE, "../../../backend/app/shared/filters.py");
const BACKEND_REGISTRY = join(HERE, "../../../backend/app/shared/filter_registry.py");

function read(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`读不到${what}：${path}（清单镜像测试不能跳过）`);
  }
}

const filtersSrc = read(BACKEND_FILTERS, "后端 app/shared/filters.py");
const registrySrc = read(BACKEND_REGISTRY, "后端 app/shared/filter_registry.py");

/** 抠 `OPERATOR_LABELS: dict[str, str] = { "K": "值", … }`。剥掉注释行再抠。 */
function backendLabels(): Record<string, string> {
  const body = filtersSrc.replace(/#[^\n]*/g, "");
  const m = body.match(/OPERATOR_LABELS:\s*dict\[str,\s*str\]\s*=\s*\{([\s\S]*?)\}/);
  if (!m) throw new Error("后端 filters.py 里找不到 OPERATOR_LABELS 字面量，测试需跟进");
  const out: Record<string, string> = {};
  for (const pair of m[1].matchAll(/"([A-Z_]+)"\s*:\s*"([^"]+)"/g)) out[pair[1]] = pair[2];
  if (Object.keys(out).length === 0) throw new Error("OPERATOR_LABELS 抠出来是空的，正则失效了");
  return out;
}

/** 抠 `OPERATORS: frozenset[str] = frozenset({...})`。 */
function backendOperators(): string[] {
  const body = filtersSrc.replace(/#[^\n]*/g, "");
  const m = body.match(/OPERATORS:\s*frozenset\[str\]\s*=\s*frozenset\(\{([\s\S]*?)\}\)/);
  if (!m) throw new Error("后端 filters.py 里找不到 OPERATORS frozenset，测试需跟进");
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

/** 抠 `meta()` 返回的字段字典键名 —— 前端 FieldMeta 接口必须与之同集。
 * 只匹到 `\{...}`（字典自己换行收尾），别指望 `}]` 连着写。 */
function backendMetaKeys(): string[] {
  const body = registrySrc.replace(/#[^\n]*/g, "");
  const m = body.match(/def meta\(self\)[\s\S]*?return\s+\[\{([\s\S]*?)\}/);
  if (!m) throw new Error("后端 filter_registry.py 里找不到 meta() 的返回字面量，测试需跟进");
  return [...m[1].matchAll(/"([a-z_]+)"\s*:/g)].map((x) => x[1]);
}

const beLabels = backendLabels();
const beOps = backendOperators();

describe("操作符人话名两份同源（D47-a 哨兵）", () => {
  it("前端 OPERATOR_LABELS 的键集 == 后端 OPERATORS", () => {
    expect(Object.keys(OPERATOR_LABELS).sort()).toEqual(beOps.slice().sort());
  });

  it("前端 OPERATOR_LABELS 的中文名 == 后端 OPERATOR_LABELS 逐字相等", () => {
    // 逐字比，不比「意思差不多」：界面上「包含」和「包括」是两个不同的词，
    // 而报错文案（后端出的）和下拉选项（前端出的）并排出现在同一个 400 提示里。
    expect(OPERATOR_LABELS).toEqual(beLabels);
  });

  it("MS 的 COUNT_GT/COUNT_LT 前端也不许自己偷偷加上", () => {
    // 后端不落地它们（没有可聚合的子表），前端加了就是摆了个必 400 的选项。
    expect(beOps).not.toContain("COUNT_GT");
    expect(Object.keys(OPERATOR_LABELS)).not.toContain("COUNT_GT");
    expect(Object.keys(OPERATOR_LABELS)).not.toContain("COUNT_LT");
  });
});

describe("条件 JSON 字段名两侧一致（改了后端读取键，前端必须跟着改）", () => {
  // 钉的是**读取点**，不是「文件里出现过这个字符串」。第一版写成 `toContain('"conditions"')`，
  // 自查时把 `if "conditions" not in raw` 改成 `if "items" not in raw` 它照样绿——
  // 因为下一行的报错文案里还有 "conditions" 四个字。 Presence 断言抓不到改错了地方。
  it("后端读的是 search_mode / conditions", () => {
    expect(filtersSrc, '后端不再 raw.get("search_mode")？').toContain('raw.get("search_mode")');
    expect(filtersSrc, '后端不再 raw["conditions"]？').toContain('conds = raw["conditions"]');
    expect(filtersSrc, "后端不再要求 conditions 键在场？").toContain('if "conditions" not in raw');
  });

  it("后端读的是 field / operator / value", () => {
    for (const key of ["field", "operator", "value"]) {
      expect(filtersSrc, `后端不再读 ${key}？`).toContain(`cond.get("${key}")`);
    }
  });

  it("前端 FilterDoc 的键就是那两个（空条件也必须带 conditions 数组）", () => {
    const f = emptyFilter();
    // 「给了对象却没有 conditions」后端判 400，所以空条件必须显式带空数组
    expect(Object.keys(f).sort()).toEqual(["conditions", "search_mode"]);
    expect(f.conditions).toEqual([]);
    expect(isFilterEmpty(f)).toBe(true);
    expect(isFilterEmpty(null)).toBe(true);
    expect(isFilterEmpty({ search_mode: "AND", conditions: [] })).toBe(true);
  });
});

describe("filterQuery：空筛选不拼参数", () => {
  it("空 → 空串（URL 里不留一条骗人的 filter=）", () => {
    expect(filterQuery(emptyFilter())).toBe("");
    expect(filterQuery(null)).toBe("");
  });

  it("非空 → &filter=<urlencode 的 JSON>，后端 parse_filter_json 能还原", () => {
    const doc: FilterDoc = { search_mode: "OR",
      conditions: [{ field: "name", operator: "CONTAINS", value: "订单" }] };
    const q = filterQuery(doc);
    expect(q.startsWith("&filter=")).toBe(true);
    expect(q).not.toContain("订单");   // 非 ASCII 必须被编码，不能裸进 URL
    expect(JSON.parse(decodeURIComponent(q.slice("&filter=".length)))).toEqual(doc);
  });
});

describe("describeFilter：把条件说成人话", () => {
  const fields: FieldMeta[] = [
    { field: "name", label: "接口名称", kind: "text", ops: ["CONTAINS"] },
    { field: "method", label: "请求方法", kind: "enum", ops: ["IN"] },
    { field: "module_id", label: "所属模块", kind: "id", ops: ["EMPTY"] },
  ];

  it("空条件说「全部数据」，不说「无」也不说空串", () => {
    expect(describeFilter(emptyFilter(), fields)).toBe("全部数据");
    expect(describeFilter(null, fields)).toBe("全部数据");
  });

  it("AND 与 OR 用不同的连接词（两者必须看得出区别）", () => {
    const conds = [
      { field: "name", operator: "CONTAINS", value: "订单" },
      { field: "method", operator: "IN", value: ["GET", "POST"] },
    ];
    expect(describeFilter({ search_mode: "AND", conditions: conds }, fields))
      .toBe("接口名称包含 订单 且 请求方法属于 GET/POST");
    expect(describeFilter({ search_mode: "OR", conditions: conds }, fields))
      .toBe("接口名称包含 订单 或 请求方法属于 GET/POST");
  });

  it("为空/不为空不跟值（跟了个 undefined 就是界面脏字）", () => {
    expect(describeFilter({ search_mode: "AND",
      conditions: [{ field: "module_id", operator: "EMPTY" }] }, fields)).toBe("所属模块为空");
  });

  it("字段不在 meta 里退回裸字段名，不编一个中文名", () => {
    expect(describeFilter({ search_mode: "AND",
      conditions: [{ field: "gone", operator: "EQUALS", value: "x" }] }, fields))
      .toBe("gone等于 x");
  });
});

describe("值控件与换操作符后的值重置", () => {
  it("EMPTY 无值、IN 要数组、BETWEEN 要区间", () => {
    expect(valueControlKind("EMPTY")).toBe("none");
    expect(valueControlKind("IN")).toBe("multi");
    expect(valueControlKind("BETWEEN")).toBe("range");
    expect(valueControlKind("EQUALS")).toBe("single");
  });

  it("换操作符必须清空旧值", () => {
    // 留着上一个操作符的值会发出 {operator:"IN", value:"字符串"} 这种必 400 的条件，
    // 而用户在界面上什么都没看见改。
    expect(resetValueFor("EMPTY")).toBeUndefined();
    expect(resetValueFor("IN")).toEqual([]);
    expect(resetValueFor("BETWEEN")).toEqual([undefined, undefined]);
    expect(resetValueFor("EQUALS")).toBeUndefined();
  });
});

describe("列设置本地持久化", () => {
  const all = [{ key: "name", label: "名称" }, { key: "method", label: "方法" },
    { key: "path", label: "路径" }];

  beforeEach(() => localStorage.clear());

  it("没设过 → null（= 用列的默认显隐），不是空隐藏集", () => {
    expect(loadColumnPrefs("api", ["name"])).toBeNull();
  });

  it("存进去读回来一致", () => {
    saveColumnPrefs("api", { hidden: ["path"] });
    expect(loadColumnPrefs("api", ["name", "method", "path"])).toEqual({ hidden: ["path"] });
  });

  it("坏了的配置 → null，不抛也不当成「全显示」", () => {
    localStorage.setItem("tp.listCols.api", "{这不是 JSON");
    expect(loadColumnPrefs("api", ["name"])).toBeNull();
    localStorage.setItem("tp.listCols.api", JSON.stringify({ hidden: "不是数组" }));
    expect(loadColumnPrefs("api", ["name"])).toBeNull();
  });

  it("只认现在还存在的列：删列后残名不毁掉整份设置", () => {
    saveColumnPrefs("api", { hidden: ["method", "早就删掉的列"] });
    expect(loadColumnPrefs("api", ["name", "method", "path"])).toEqual({ hidden: ["method"] });
  });

  it("按 view_type 分键：接口页藏了方法列不该影响报告页", () => {
    saveColumnPrefs("api", { hidden: ["method"] });
    expect(localStorage.getItem("tp.listCols.report")).toBeNull();
  });

  it("勾选态与隐藏集互逆", () => {
    const checked = checkedKeys(all, { hidden: ["path"] });
    expect(checked).toEqual(["name", "method"]);
    expect(hiddenFromChecked(all, checked)).toEqual({ hidden: ["path"] });
    expect(hiddenFromChecked(all, checkedKeys(all, null))).toEqual({ hidden: [] });
  });

  it("applyColumnPrefs 只过滤、不改列对象（render 等原样留着）", () => {
    const render = () => null;
    const cols = [{ key: "name", render }, { key: "method", render }, { key: "path", render }];
    const out = applyColumnPrefs(cols, { hidden: ["method"] });
    expect(out.map((c) => c.key)).toEqual(["name", "path"]);
    expect(out[0].render).toBe(render);      // 列对象是原对象，不是重写出来的副本
    expect(applyColumnPrefs(cols, null)).toBe(cols);   // 没设置时原样返回，不复制
  });

  it("没有 key 的列一律保留（无 key = 选择/操作列，页面上没有它的开关）", () => {
    const render = () => null;
    const cols = [{ render }, { key: "name", render }];
    expect(applyColumnPrefs(cols as never[], { hidden: ["name"] }) as never[]).toHaveLength(1);
  });
});

describe("filter_meta 响应形状与前端接口同集", () => {
  // **不用 `as FieldMeta`**：类型断言不要求键写全，后端 meta() 加一个必填字段而前端
  // FieldMeta 没跟着加时，断言式写法照样编译过。写成带类型标注的常量，tsc 就替我们
  // 钉住「字面量 ⊇ 接口」；再拿这同一份字面量的运行时键去对后端 meta()，
  // 于是「后端多给 / 前端漏接」两头都抓得住（两头各由一次变异证明，见 §变异自证）。
  const FIELD_META_SHAPE: FieldMeta = { field: "", label: "", kind: "", ops: [] };

  it("FieldMeta 的键 == 后端 meta() 返回的键", () => {
    // 后端 meta() 多给一个键而前端接口没写 = 那字段在表单上凭空消失；
    // 少给一个 = 前端 TS 以为有、运行时 undefined，渲染成 `undefined` 脏字。
    expect(Object.keys(FIELD_META_SHAPE).sort()).toEqual(backendMetaKeys().sort());
  });
});
