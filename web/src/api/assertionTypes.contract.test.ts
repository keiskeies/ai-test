// 断言类型表「三处同步」的哨兵（D78）：req.ts 的 ASSERT_TYPES ↔ PropsPanel 的那份
// ↔ 后端 api_test/schemas.py 的 ASSERTION_TYPES（入库校验的闸）。
// 手法照 runVocab.test.ts：readFileSync 后端源码把集合抠出来当场对，读不到就抛、
// 绝不静默跳过——跳过的契约测试等于没有契约。三处任意一处漏改这条必须红。
// PropsPanel 那份已改为从 req.ts import（消灭一处重复）：这里钉的是「它确实 import、
// 没有偷回本地表」；若有人重新加回本地 const 表，抠它的值继续按全集对表。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSERT_TYPES } from "./req";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SCHEMAS = join(HERE, "../../../backend/app/modules/api_test/schemas.py");
const PROPS_PANEL = join(HERE, "../scene/PropsPanel.tsx");

const backendSrc = (() => {
  try {
    return readFileSync(BACKEND_SCHEMAS, "utf8");
  } catch {
    throw new Error("读不到后端 api_test/schemas.py：" + BACKEND_SCHEMAS + "（断言类型契约测试不能跳过）");
  }
})();

const panelSrc = (() => {
  try {
    return readFileSync(PROPS_PANEL, "utf8");
  } catch {
    throw new Error("读不到 web/src/scene/PropsPanel.tsx：" + PROPS_PANEL + "（断言类型契约测试不能跳过）");
  }
})();

/** 抠后端 `ASSERTION_TYPES = {"a", "b", …}` 的字面量集合。 */
function backendAssertionTypes(): string[] {
  const m = backendSrc.match(/ASSERTION_TYPES = \{([^}]*)\}/);
  if (!m) throw new Error("后端 schemas.py 里找不到 ASSERTION_TYPES 字面量集合，测试需跟进");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

const backendTypes = backendAssertionTypes();
const reqTypes = ASSERT_TYPES.map((t) => t.value);

describe("断言类型全集三处同源（D78 哨兵）", () => {
  it("req.ts 的 ASSERT_TYPES 值集 == 后端 ASSERTION_TYPES（入库 422 的闸）", () => {
    expect(reqTypes.slice().sort()).toEqual(backendTypes.slice().sort());
    // 表本身不许有重复 value：下拉出双选项 + 对表失真
    expect(new Set(reqTypes).size).toBe(reqTypes.length);
  });

  it("PropsPanel 不再自带第二份表：要么 import req.ts，要么本地表逐值对表", () => {
    const hasLocalTable = /const ASSERT_TYPES\s*=\s*\[/.test(panelSrc);
    if (hasLocalTable) {
      // 允许的历史形状（若有人恢复本地表）：抠出 value 集合继续对——漏一个值这条红
      const block = panelSrc.match(/const ASSERT_TYPES\s*=\s*\[([\s\S]*?)\];/);
      if (!block) throw new Error("PropsPanel 有 ASSERT_TYPES 声明但抠不出数组体，测试需跟进");
      const vals = [...block[1].matchAll(/value:\s*"([a-z_]+)"/g)].map((x) => x[1]);
      expect(vals.slice().sort(), "PropsPanel 本地表漂出 req.ts 了").toEqual(reqTypes.slice().sort());
    } else {
      // 当前形状：唯一实现点在 req.ts，PropsPanel 必须真的 import 它
      expect(panelSrc, "PropsPanel 既没有本地表也没 import req.ts 的 ASSERT_TYPES？下拉在查什么").toMatch(
        /import \{[^}]*ASSERT_TYPES[^}]*\} from "\.\.\/api\/req"/);
    }
  });

  it("后端执行器 _eval_one 真的认这套类型：入库收得下、执行不报「未知断言类型」", () => {
    // 闸认 ≠ 引擎认：schemas 收得下但 assertions.py 没分支的类型，跑起来是
    // 「未知断言类型」的假红（另一头的假门）。把每个类型对执行器源码点名核一遍。
    const execSrc = (() => {
      try {
        return readFileSync(join(HERE, "../../../backend/app/shared/assertions.py"), "utf8");
      } catch {
        throw new Error("读不到后端 shared/assertions.py（断言类型契约测试不能跳过）");
      }
    })();
    for (const t of backendTypes) {
      expect(execSrc, "schemas 收了 " + t + " 但执行器没有对应分支").toContain('t == "' + t + '"');
    }
  });

  it("regex 在表里且标签是人话（蓝图 :887 点名的类型）", () => {
    const regex = ASSERT_TYPES.find((t) => t.value === "regex");
    expect(regex, "正则断言从下拉里消失了").toBeTruthy();
    expect(regex?.label).toBe("正则");
  });
});
