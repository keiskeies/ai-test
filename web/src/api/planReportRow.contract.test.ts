// 报告列表行镜像 `PlanReportListRow` 的编译期替身（D183 债，§五「无编译期护栏」那一格）。
//
// 为什么必须有这条：`plan_report_list` 的返回标注是 `-> ServiceResult` 而不是具体模型，
// 所以 `PlanReportListRowOut` **永远不会进 schema.d.ts**（同族 `plan_get` 标 `-> schemas.PlanOut`
// 就拿到了 $ref —— 差别只在标注，不在 gen:api 跑没跑；gen:api 本仓还禁跑）。
// api.ts 里那份手写 type 因此**没有 tsc 护栏**：后端加字段/改可选性，前端一声不响地漂。
// 手法照 assertionTypes.contract.test.ts / runVocab.test.ts：**从两边源码现抠**，
// 读不到就抛、绝不静默跳过（跳过的契约测试等于没有契约），不比对「我记得的字段表」。
//
// 钉的是三件事，每条都有对应的真实事故形状：
//   ① 字段集合与**可选性**两边一致（后端加字段前端没跟 = 页面读 undefined 画「—」）
//   ② 后端模型每个字段都被 `_report_row` **真的写**（「有 schema 没写入方」= 判据 1 的病）
//   ③ 分页外壳的 `next_cursor` 在后端序列化里**无条件出现** ⟺ 前端声明为必填
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SCHEMAS = join(HERE, "../../../backend/app/modules/testplan/schemas.py");
const BACKEND_SERVICES = join(HERE, "../../../backend/app/modules/testplan/services.py");
const BACKEND_SERVICE_CORE = join(HERE, "../../../backend/app/core/service.py");
const PLAN_TS = join(HERE, "plan.ts");

/** 读不到就抛：静默 skip 的契约测试是最贵的一种假绿。 */
function read(p: string, what: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    throw new Error(`读不到${what}：${p}（契约测试不能跳过）`);
  }
}

const schemasSrc = read(BACKEND_SCHEMAS, "后端 testplan/schemas.py");
const servicesSrc = read(BACKEND_SERVICES, "后端 testplan/services.py");
const coreSrc = read(BACKEND_SERVICE_CORE, "后端 core/service.py");
const planTsSrc = read(PLAN_TS, "web/src/api/plan.ts");

/** Python 注释里的 docstring/`#` 行不参与字段抠取。 */
function stripPyDocstring(body: string): string {
  const out: string[] = [];
  let inDoc = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*"""/.test(line)) {
      // 单行 docstring（`"""..."""` 同行闭合）与多行起始都按「进了就不看」处理
      const closed = (line.match(/"""/g) || []).length >= 2;
      inDoc = !closed;
      continue;
    }
    if (inDoc) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** 抠 `class NAME(BaseModel):` 的类体（到下一个顶格行为止；文件末尾结束也算）。 */
function pyClassBody(src: string, name: string): string {
  const start = src.match(new RegExp(`^class ${name}\\(BaseModel\\):`, "m"));
  if (!start || start.index === undefined) {
    throw new Error(`后端 schemas.py 里找不到 class ${name}——改名了的话这条测试要跟进`);
  }
  const rest = src.slice(start.index + start[0].length);
  const stop = rest.search(/^\S/m); // 下一个顶格（非缩进）行 = 类体结束
  return stripPyDocstring(stop === -1 ? rest : rest.slice(0, stop));
}

/** 后端字段 → 是否可选（`= 默认值` 即可选；纯注解含 `| None` 但无默认值仍是**必填**）。 */
function backendFields(): Map<string, boolean> {
  const body = pyClassBody(schemasSrc, "PlanReportListRowOut");
  const m = new Map<string, boolean>();
  for (const line of body.split(/\r?\n/)) {
    const f = line.match(/^\s{4}([A-Za-z_]\w*)\s*:\s*(.+)$/);
    if (!f) continue;
    if (/^\s*@/.test(line)) continue;
    m.set(f[1], /=/.test(f[2]));
  }
  if (m.size < 12) {
    throw new Error(`只抠到 ${m.size} 个后端字段，解析器失效了（这条测试本身坏了）`);
  }
  return m;
}

/** 抠 `export type NAME = { ... };` 的字段 → 是否可选（`?` 即可选）。块注释先剥掉。 */
function tsFields(name: string): Map<string, boolean> {
  const src = planTsSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = src.match(new RegExp(`export type ${name} = \\{`));
  if (!start || start.index === undefined) {
    throw new Error(`plan.ts 里找不到 export type ${name} = { —— 镜像改名了的话这条测试要跟进`);
  }
  const rest = src.slice(start.index + start[0].length);
  const end = rest.indexOf("\n};");
  if (end === -1) throw new Error(`plan.ts 的 ${name} 找不到结尾 };`);
  const m = new Map<string, boolean>();
  for (const line of rest.slice(0, end).split(/\r?\n/)) {
    const f = line.match(/^\s*([A-Za-z_]\w*)(\?)?\s*:/);
    if (!f) continue;
    m.set(f[1], f[2] === "?");
  }
  if (m.size < 12) {
    throw new Error(`只抠到 ${m.size} 个前端字段，解析器失效了（这条测试本身坏了）`);
  }
  return m;
}

const be = backendFields();
const fe = tsFields("PlanReportListRow");

describe("报告列表行镜像 == 后端 PlanReportListRowOut（D183 债：这份永远进不了 schema.d.ts）", () => {
  it("字段集合逐字相同（后端加/删字段，这份手写镜像必须同步改）", () => {
    expect([...fe.keys()].sort(), "前端多写或漏写字段").toEqual([...be.keys()].sort());
  });

  it("可选性逐字段相同（后端 `= 默认值` ⟺ 前端 `?`）", () => {
    const drift = [...be.keys()]
      .filter((k) => fe.has(k) && be.get(k) !== fe.get(k))
      .map((k) => `${k}: 后端 optional=${be.get(k)} 前端 optional=${fe.get(k)}`);
    expect(drift, "可选性漂了：\n" + drift.join("\n")).toEqual([]);
  });

  it("后端模型的每个字段都被 _report_row 真的写入（「有 schema 没写入方」= 判据 1）", () => {
    const fn = servicesSrc.match(/def _report_row[\s\S]*?\n(?=\ndef |@service|$)/);
    if (!fn) throw new Error("后端 services.py 里找不到 _report_row——改名了这条要跟进");
    const written = new Set([...fn[0].matchAll(/(\w+)\s*=\s*[^=]/g)].map((x) => x[1]));
    const missing = [...be.keys()].filter((k) => !written.has(k));
    expect(missing, "_report_row 没写这些字段，页面永远拿到默认值：\n" + missing.join("\n")).toEqual([]);
  });
});

describe("分页外壳：_dump 的键形状 == api.ts 的 Page<T> 声明", () => {
  // 只钉 `next_cursor` 这一条**双向耦合**：前端把它声明成**必填** `next_cursor: string | null`，
  // 唯一依据是 core/service.py 的 _dump 把它写在无条件的那个 dict 字面量里
  // （`total` 相反——None 时整个键摘掉，所以前端是 `total?:`）。
  // 谁哪天把 next_cursor 挪进 if，这条红——那是响应契约变更，需要评审，不许顺手改。
  const dump = coreSrc.match(/def _dump[\s\S]*?\n(?=\ndef [a-z]|$)/);
  if (!dump) throw new Error("后端 core/service.py 里找不到 _dump——序列化改名了这条要跟进");
  // ⚠ 正则里那个字符类的两层括号别手滑写成 `\[^\]]*`：少了开方括号后 `^` 就变成
  //    **行首锚**，这条永远匹配不上（本项目实测：报的是"解析器失效"，不是"契约不符"——
  //    两种红含义完全不同，前者是我这条测试坏了，后者才是后端真改了）。
  const unconditional = dump[0].match(/out:\s*dict\[[^\]]*\]\s*=\s*\{([^}]*)\}/);
  if (!unconditional) throw new Error("_dump 的初始 dict 字面量抠不出来，解析器失效了");

  it("next_cursor 在 _dump 的**无条件**字面量里（= 前端必填声明的唯一依据）", () => {
    expect(unconditional[1]).toMatch(/next_cursor/);
    expect(unconditional[1], "total 不该在这个字面量里（它按 total is not None 条件写）").not.toMatch(/total/);
  });

  it("api.ts 的 Page<T>：next_cursor 必填、total 可选（与上一条必须同时改）", () => {
    const page = readFileSync(join(HERE, "api.ts"), "utf8").match(
      /export interface Page<T>\s*\{([^}]*)\}/,
    );
    if (!page) throw new Error("api.ts 里找不到 export interface Page<T>");
    expect(page[1], "next_cursor 变可选了？那上一条 _dump 也必须已改成条件写").toMatch(
      /next_cursor:\s*string\s*\|\s*null/);
    expect(page[1]).toMatch(/total\?:/);
  });
});
