// 前端测试债差集（第五道差集）——本仓唯一口径：README / 计划里「孤儿文件」「零引用 testid」
// 这类数字**只能由本脚本产出**。别再在会话里现写一份：两份脚本对不上时，读者分不清
// 是树变了还是尺子变了（同一个坑在 1G 计划「一次假红」那节已经踩过一次）。
//
//   node scripts/audit-test-debt.mjs            # 三个数 + 明细
//   node scripts/audit-test-debt.mjs --top 20
//
// 三条口径，少一条就会得出错的结论：
//  ① 「谁测过这个文件」= 测试/e2e 里任一条**相对 import**（含 `import()` 动态边：
//     lazy 组件在测试里同样能被渲染）。只算一跳，不做传递闭包——传递可达不等于测过。
//  ② 一跳有个盲区：**只 import 了某个具名子件**也算一条边 ⇒ 整板组件被算成「已覆盖」。
//     所以另算「有 `export default`、但没有任何边把默认导出接走」——**这份才是「整块面没测过」**。
//     实测命中过 `scene/PropsPanel.tsx`（34 个静态可匹配的 testid，唯一测试边是
//     `import { AssertionListEditor }`）：只引 ① 就永远找不到它。
//  ③ testid 零引用 = 生产 `data-testid` 字面量在测试/e2e 全文里一次都没出现。
//     这是**候选清单，不是缺陷清单**：纯样式钩子、e2e 用别的方式定位的都会在里面。
//
// ① 的第二个盲区（第一个是上面 ②）：**只被构建配置接走的文件**在这里必然算孤儿。
// 已知实例 `src/probe/*` ——没有测试 import 它，它由 `vite.config.ts` 的 e2e 档位进入口，
// 而 `e2e/globalSetup.mjs` 断言 `dist/probe.html` 在场、不在就抛。**删它 = editor.spec 全挂**。
// 所以「① 命中」只说明「没有测试 import 它」，动手删之前要另外查构建配置与 globalSetup。
//
// 本脚本自己也被证伪过一轮：第一版的 import 正则**匹配不到 `import { X } from "…"`**
// （具名-only 那种），于是孤儿数从真实值虚高到 61。所以「明细里出现的文件要抽查」
// 不是可省的收尾——下面 `--check` 就是把三个已知答案钉成断言。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
process.chdir(ROOT);

const topIdx = process.argv.indexOf("--top");
const TOP = topIdx > 0 ? Number(process.argv[topIdx + 1]) : 15;
const CHECK = process.argv.includes("--check");

const isTest = (p) => /\.test\.(ts|tsx)$/.test(p);
const bs = String.fromCharCode(92);
const rel = (p) => relative(ROOT, p).split(bs).join("/");

const srcFiles = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e)) srcFiles.push(p);
  }
})("src");

const specs = readdirSync("e2e").filter((f) => f.endsWith(".mjs")).map((f) => join("e2e", f));
const tests = [...srcFiles.filter(isTest), ...specs];
const prod = srcFiles.filter((f) => !isTest(f)).map((f) => resolve(ROOT, f));

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];
function resolveSpec(fromAbs, spec) {
  for (const ext of EXTS) {
    const cand = resolve(dirname(fromAbs), spec + ext);
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* 换下一个后缀 */
    }
  }
  return null;
}

// 静态 import 子句：`import <clause> from "spec"`。clause 可能跨行（`import {\n a,\n b\n} from`），
// 所以用非贪婪 + s 允许换行，但禁掉引号防止吃掉下一条语句。
const STATIC = /(?:^|[\r\n;})])\s*import\s+((?:[^'"()]|\([^()]*\))*?)\s*from\s*["']([^"']+)["']/g;
// 副作用 import：`import "./x.css"` —— 没有子句，但确实是一条边。
const SIDE_EFFECT = /(?:^|[\r\n;})])\s*import\s*["'](\.[^"']+)["']/g;
const DYNAMIC = /import\(\s*["'](\.[^"']+)["']\s*\)/g;

/** 子句里有没有把默认导出接走（含 `import D, { a }`、`import * as n`）。 */
function clauseTakesDefault(clause) {
  let c = clause.trim();
  if (c.startsWith("type ")) c = c.slice(5).trim(); // `import type { … }` 是类型边，运行时零覆盖
  if (c === "" || c.startsWith("{")) return false; // 具名-only / 类型-only
  if (c.startsWith("*")) return true; // 命名空间 = 整个模块都在手里
  return /^[A-Za-z_$][\w$]*$/.test(c.split(/\s*,/)[0].trim());
}

const edges = new Map(); // prodAbs -> [{test, default}]
const addEdge = (target, testAbs, isDefault) => {
  if (!edges.has(target)) edges.set(target, []);
  edges.get(target).push({ test: rel(testAbs), default: isDefault });
};

for (const t of tests) {
  const tAbs = resolve(ROOT, t);
  const body = readFileSync(tAbs, "utf8");
  for (const m of body.matchAll(STATIC)) {
    const [, clause, spec] = m;
    if (!spec.startsWith(".")) continue;
    const target = resolveSpec(tAbs, spec);
    if (target) addEdge(target, tAbs, clauseTakesDefault(clause));
  }
  for (const m of body.matchAll(SIDE_EFFECT)) {
    const target = resolveSpec(tAbs, m[1]);
    if (target) addEdge(target, tAbs, false);
  }
  for (const m of body.matchAll(DYNAMIC)) {
    const target = resolveSpec(tAbs, m[1]);
    if (target) addEdge(target, tAbs, true); // `import("./X")` 拿到的就是默认导出
  }
}

/** 生产文件里的静态可匹配 `data-testid`（带 `$` 插值的模板串算不可静态匹配，排除）。 */
function dataTestids(absPath) {
  const body = readFileSync(absPath, "utf8");
  const out = new Set();
  const re = /data-testid=(?:"([^"\s]+)"|\{`([^`$]+)`\}|\{"([^"]+)"\}|'([^']+)')/g;
  for (const m of body.matchAll(re)) {
    const v = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (v && !v.includes("$")) out.add(v);
  }
  return [...out];
}

const orphans = prod.filter((p) => !edges.has(p));
const defaultUntouched = prod.filter((p) => {
  const es = edges.get(p) ?? [];
  return es.length > 0
    && /export default /.test(readFileSync(p, "utf8"))
    && !es.some((e) => e.default);
});

const testBlob = tests.map((t) => readFileSync(resolve(ROOT, t), "utf8")).join("\n");
const zeroRef = [];
for (const p of prod) for (const id of dataTestids(p)) if (!testBlob.includes(id)) zeroRef.push([id, rel(p)]);
const totalIds = prod.reduce((n, p) => n + dataTestids(p).length, 0);

const byIds = (list) => list
  .map((p) => [dataTestids(p).length, rel(p)])
  .sort((a, b) => b[0] - a[0]);

console.log(`生产文件 ${prod.length} ｜ 测试/e2e 文件 ${tests.length}`);
console.log(`① 零测试 import 的生产文件：${orphans.length}`);
console.log(`② 有 export default、但没有测试把默认导出接走：${defaultUntouched.length}`);
console.log(`③ 生产 data-testid ${totalIds} 个 ｜ 测试/e2e 零引用：${zeroRef.length}`);

console.log("\n— ②明细（整块面零单测；先修这份，它才是「没测过」）—");
for (const [n, f] of byIds(defaultUntouched)) console.log(`  ${String(n).padStart(3)}  ${f}`);
console.log(`\n— ①明细 top ${TOP}（按 testid 数）—`);
for (const [n, f] of byIds(orphans).slice(0, TOP)) console.log(`  ${String(n).padStart(3)}  ${f}`);
console.log(`\n— ③零引用 testid top ${TOP}（候选清单，不是缺陷清单）—`);
for (const [id, f] of zeroRef.slice(0, TOP)) console.log(`  ${id.padEnd(30)} ${f}`);

if (CHECK) {
  // 尺子自己的哨兵。**钉的是解析器，不是差集**：拿合成的 import 形状验 `clauseTakesDefault`，
  // 所以哪天债还清了它也不会假红（反过来，钉「PropsPanel 必须在 ② 里」那种哨兵，
  // 一旦有人真补上单测就会红，然后被人整个删掉——哨兵就白装了）。
  // 第一版脚本的具名-only 正则失配就是这类形状没验：孤儿数虚高到 61（真值见上面 ①）。
  const cases = [
    [`import D from "./x"`, true],
    [`import D, { a } from "./x"`, true],
    [`import * as ns from "./x"`, true],
    [`import { a, b } from "./x"`, false],
    [`import type { T } from "./x"`, false], // 类型边：运行时什么都不加载
    [`import D, * as ns from "./x"`, true],
    ["import {\n  a,\n  b,\n} from \"./x\"", false], // 跨行具名
  ];
  let bad = 0;
  for (const [src, want] of cases) {
    const m = STATIC.exec(`\n${src}\n`);
    STATIC.lastIndex = 0;
    const got = m ? clauseTakesDefault(m[1]) : null;
    if (got !== want) {
      console.error(`--check 失败：${JSON.stringify(src)} 期望 default=${want}，量到 ${got}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`\n--check OK：${cases.length} 种 import 形状判定正确（含跨行与类型边）`);
}
