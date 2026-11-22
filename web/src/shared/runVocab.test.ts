// 展示词表 ↔ 后端 Field(pattern=...) 的契约测试。
//
// 这类漂移肉眼看不出来、e2e 也未必走到（要真去点那个筛选项），但它是**用户点一下就报错**
// 的级别：TRIGGERS 里有 `case` 而后端 pattern 不收 → 选「用例」→ 422 → 页面演「记录没取到」。
// 所以这里不比对「我记得的后端词表」，而是**从后端源码把 pattern 抠出来**当场对。
// 后端不在同一仓库层级时直接失败，不静默跳过：跳过的契约测试等于没有契约。
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUSES, SELECTABLE_TRIGGERS, STEP_STATUSES, SUBJECT_TYPES, TRIGGERS, PLAN_DISPLAY, LINK_RESULTS } from "./runVocab";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SVC = join(HERE, "../../../backend/app/modules/execution/services.py");
const BACKEND_PLAN_SCH = join(HERE, "../../../backend/app/modules/testplan/schemas.py");
const PAGES_DIR = join(HERE, "../pages");

const src = (() => {
  try {
    return readFileSync(BACKEND_SVC, "utf8");
  } catch {
    throw new Error("读不到后端 execution/services.py：" + BACKEND_SVC + "（词表契约测试不能跳过）");
  }
})();

/** 从源码里抠 `^(a|b|c)$` 形态的 pattern，取值集合。 */
function patternValues(re: RegExp): string[] {
  const m = src.match(re);
  if (!m) throw new Error("后端源码里找不到预期的 pattern：" + re.source);
  return m[1].split("|");
}

const triggerPattern = patternValues(/trigger: str \| None = Field\(default=None, pattern="\^\(([^)]*)\)\$"/);
const statusPattern = patternValues(/RUN_STATUS_PATTERN = "\^\(([^)]*)\)\$"/);
// 1C T11（R112）：对象类型词表。runs.tsx 的对象标签查这张表——后端会写而表里没有的
// 值必须渲染原文（不是回落成「接口」），但词表内四个值都要有中文名。
const subjectTypePattern = patternValues(/SUBJECT_TYPE_PATTERN = "\^\(([^)]*)\)\$"/);

/** 递归列出目录下的 .py（跳过 __pycache__）。 */
function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...moduleFiles(p));
    else if (e.name.endsWith(".py")) out.push(p);
  }
  return out;
}

describe("运行记录展示词表与后端 pattern 同源", () => {
  it("触发来源：前端能筛的，后端全都收（多一个就是 422）", () => {
    expect(Object.keys(TRIGGERS).sort()).toEqual([...triggerPattern].sort());
  });

  it("触发来源：后端写的每个值前端都有中文名（少了就画生码）", () => {
    for (const t of triggerPattern) expect(TRIGGERS[t], "缺触发来源文案: " + t).toBeTruthy();
  });

  it("状态：六态一一对应（T9 起库里真会写 queued/running/cancelled）", () => {
    expect(Object.keys(STATUSES).sort()).toEqual([...statusPattern].sort());
  });

  it("对象类型：后端 pattern 的每个值都有中文文案（R112；1D 起含 adb_case）", () => {
    expect(Object.keys(SUBJECT_TYPES).sort()).toEqual([...subjectTypePattern].sort());
    for (const [k, v] of Object.entries(SUBJECT_TYPES)) {
      expect(v.label, k).toBeTruthy();
      expect(v.color, k).toBeTruthy();
    }
  });

  it("对象类型：库里会写但词表外的值（inline）渲染原文，词表不偷偷收编", () => {
    // api_debug 裸请求跑出的 run 写 subject_type="inline"（api_test/services.py），
    // 它**故意不在**筛选词表与 SUBJECT_TYPES 里：R112 对它的设计就是渲染原文，
    // 绝不回落成「接口」（老 ternary 的错正是把所有非 api_case 都画成接口）。
    // 这条钉两件事：① inline 确实被后端写入（扫描失效就红）；② 词表没把它收编。
    const written = new Set<string>();
    for (const rel of moduleFiles(join(HERE, "../../../backend/app/modules"))) {
      // api_debug 用元组赋值写 subject_type（`subject_type, subject_id, subject_name = "inline", ...`），
      // [^=\n]* 把逗号尾巴一起吃掉；比较用的 `== "..."` 因为等号后没有引号而不会误伤。
      for (const m of readFileSync(rel, "utf8").matchAll(/subject_type[^=\n]*=\s*"([a-z_]+)"/g)) written.add(m[1]);
    }
    expect(written, "没扫到 inline 写入点，api_debug 语义变了（测试需跟进）").toContain("inline");
    expect(SUBJECT_TYPES["inline"], "inline 被收编进词表——筛选词表也会跟着漂").toBeUndefined();
  });

  it("库里实际会写入的 trigger 值，前端都有文案", () => {
    // 只测 pattern 不够：pattern 允许但代码从不写的值无所谓，代码写了但文案没有的才炸。
    // 写入点不在 execution/services.py（那半边只读），在 scenario / api_test 两处，
    // 所以扫整个 app/modules 目录，别只盯着一个文件——上一版就栽在「以为 pattern 所在文件就是写入点」。
    const written = new Set<string>();
    for (const rel of moduleFiles(join(HERE, "../../../backend/app/modules"))) {
      for (const m of readFileSync(rel, "utf8").matchAll(/trigger="([a-z_]+)"/g)) written.add(m[1]);
    }
    // 至少要真抠到东西，抠不到说明后端改了写法、这条测试已经失效
    expect(written.size, "没抠到任何 trigger= 字面量，测试本身失效了").toBeGreaterThan(0);
    for (const t of written) {
      expect(triggerPattern, "后端写了 " + t + " 但 pattern 不收").toContain(t);
      expect(TRIGGERS[t], "后端写了 " + t + " 但前端没文案").toBeTruthy();
    }
  });

  it("reserved 只裁筛选项：没有页面把 TRIGGERS 全表摊成下拉（D82）", () => {
    // 全仓扫，不靠下一个人的自觉：徽标按 key 查表（TRIGGERS[v]），只有筛选项才
    // `Object.entries(TRIGGERS)` 摊成全表——所以这个写法出现在 pages/ 就是漏闸。
    // 当初就是 D82 只改了 reports.tsx，runs.tsx 的同一个下拉原样留着无人发现。
    const offenders: string[] = [];
    for (const name of readdirSync(PAGES_DIR)) {
      if (!name.endsWith(".tsx") || name.endsWith(".test.tsx")) continue;
      if (readFileSync(join(PAGES_DIR, name), "utf8").includes("Object.entries(TRIGGERS)")) {
        offenders.push(name);
      }
    }
    expect(offenders, "这些页的触发筛选项还摊着全表，reserved 值会露进去").toEqual([]);
    // 正对照：闸确实存在（筛选项确实在查 SELECTABLE_TRIGGERS），不是空扫出来的绿
    expect(Object.keys(SELECTABLE_TRIGGERS)).toEqual(["debug", "manual", "schedule", "agent"]);
    expect(TRIGGERS.webhook.reserved, "webhook 的 reserved 被摘了——那天的事实要写进注释").toBe(true);
  });

  it("每张表都有中文文案与配色，不留空壳", () => {
    for (const [k, v] of Object.entries(TRIGGERS)) {
      expect(v.label, k).toBeTruthy();
      expect(v.icon, k).toBeTruthy();
      expect(v.color, k).toBeTruthy();
    }
    for (const [k, v] of Object.entries(STATUSES)) {
      expect(v.label, k).toBeTruthy();
      expect(v.color, k).toBeTruthy();
    }
    for (const [k, v] of Object.entries(STEP_STATUSES)) {
      expect(v.label, k).toBeTruthy();
      expect(v.color, k).toBeTruthy();
    }
  });
});

describe("计划展示态/关联结果词表与后端 testplan/schemas.py 元组同源（D183 步 6a）", () => {
  // 后端的这两张表是**元组常量**而不是 Field(pattern=...)（testplan/schemas.py:170/173）——
  // 同谋测试防的还是同一件事：后端加一个展示态/结果值，前端词表没有，界面画生码或
  // 悄悄漏一态。这里不比对「我记得的元组」，从源码抠（文件读不到=失败，不静默跳过）。
  const planSrc = (() => {
    try {
      return readFileSync(BACKEND_PLAN_SCH, "utf8");
    } catch {
      throw new Error("读不到后端 testplan/schemas.py：" + BACKEND_PLAN_SCH + "（词表契约测试不能跳过）");
    }
  })();

  /** 从源码里抠 `NAME = ("a", "b", …)` 形态的元组，取值集合。 */
  function tupleValues(name: string): string[] {
    const m = planSrc.match(new RegExp(name + '\\s*=\\s*\\(([^)]*)\\)'));
    if (!m) throw new Error("后端 testplan/schemas.py 里找不到预期元组：" + name);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }

  it("计划展示态：四态一一对应（_plan_display 的产出口只会发这四个值）", () => {
    expect(Object.keys(PLAN_DISPLAY).sort()).toEqual(tupleValues("PLAN_DISPLAY_STATUSES").sort());
    for (const [k, v] of Object.entries(PLAN_DISPLAY)) {
      expect(v.label, k).toBeTruthy();
      expect(v.color, k).toBeTruthy();
    }
  });

  it("关联结果：三值一一对应（queued/running 永远进不了这个枚举——保守口径在 _link_result）", () => {
    expect(Object.keys(LINK_RESULTS).sort()).toEqual(tupleValues("LINK_RESULTS").sort());
    for (const [k, v] of Object.entries(LINK_RESULTS)) {
      expect(v.label, k).toBeTruthy();
      expect(v.color, k).toBeTruthy();
    }
  });

  it("_plan_display 现算的每个返回字面量，PLAN_DISPLAY 都有文案（产出口漂移先红这里）", () => {
    const svcSrc = readFileSync(join(HERE, "../../../backend/app/modules/testplan/services.py"), "utf8");
    const fn = svcSrc.match(/def _plan_display[\s\S]*?\n(?=\ndef |\n# |$)/);
    if (!fn) throw new Error("后端 services.py 里找不到 _plan_display——产出口改名了，测试要跟进");
    const returned = [...fn[0].matchAll(/return "([a-z_]+)"/g)].map((x) => x[1]);
    expect(returned.length, "没抠到 _plan_display 的返回字面量，测试本身失效了").toBeGreaterThanOrEqual(4);
    for (const s of returned) expect(PLAN_DISPLAY[s], "后端现算会发 " + s + " 但前端没文案").toBeTruthy();
  });
});

describe("步骤状态词表与引擎实际发的状态同源（T21）", () => {
  it("引擎构造的每个 StepOutcome 状态，STEP_STATUSES 都有文案", () => {
    // 步骤层是 pass/fail（run 层是 passed/failed）——两套词混用会让抽屉徽标画生码。
    // 写入点 = 引擎里 StepOutcome("<status>") 的全部字面量；running 不在其中
    // （它是 step/running 事件的类型名，不是 StepOutcome 的构造值），也要有文案。
    const constructed = new Set<string>();
    for (const rel of moduleFiles(join(HERE, "../../../backend/app/modules/scenario/engine"))) {
      for (const m of readFileSync(rel, "utf8").matchAll(/StepOutcome\("([a-z_]+)"/g)) constructed.add(m[1]);
    }
    expect(constructed.size, "没抠到任何 StepOutcome 字面量，测试本身失效了").toBeGreaterThanOrEqual(4);
    constructed.add("running"); // step/running 事件驱动画布呼吸态
    for (const s of constructed) {
      expect(STEP_STATUSES[s], "引擎发 " + s + " 但前端没文案").toBeTruthy();
    }
  });
});
