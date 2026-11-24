// 「盈余给谁」的源码契约。jsdom 不排表，所以这条只能抠源码——同 theme.drift.test.ts /
// fillHeight.contract.test.ts 的路子：读不到文件就抛错，不 skip。
//
// 盯住的是一个反直觉的 CSS 事实：给了 scroll.x 之后 rc-table 写 `table{width:998px;
// min-width:100%}`，容器比 998 宽时（1680 视口实测容器 1124）auto 布局把多出的 126px
// **按比例摊给每一列**——实测 8 列各 +12.7%：方法 80→90、最近结果 104→117、操作 158→178。
// 于是「盈余给内容最紧的接口列」这句意图静默失效，空隙长在短列中间（方法右边、类型右边
// 各一大块空白）。改成 table-layout: fixed 后固定列拿声明值、没有 width 的那一列吃剩下。
//
// 两半必须成对：只删「接口」列的 width 而不钉 fixed，auto 布局照样摊给所有人；
// 只加 fixed 而「接口」列还写死 220，盈余无处可去、右侧空出一块。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "api.tsx");
const raw = (() => {
  try {
    return readFileSync(SRC, "utf8");
  } catch {
    throw new Error("读不到 api.tsx：" + SRC + "（列宽契约测试不能跳过）");
  }
})();

/** 表格 props 区：从 tableLayout/scroll 到 columns 数组结束。注释留在里面，靠逐行解析绕开。 */
const from = raw.indexOf("columns={applyColumnPrefs([");
if (from < 0) throw new Error("api.tsx 里找不到 columns={applyColumnPrefs([——本例的抠法得同步改");
const propsRegion = raw.slice(raw.lastIndexOf("<AdminTable", from), from);
const colsRegion = raw.slice(from, raw.indexOf("] }", from) > 0 ? raw.indexOf("] }", from) : raw.length);

/**
 * 逐列取「列声明行」上 render: 之前的 width。
 * 口径：一列的 key/title/width 都写在同一物理行的 render: 之前（现状如此）；
 * 整行注释以 // 开头、不以 { 开头，天然不会被当成列声明行。列数不足会抛错，不假绿。
 */
function colWidths(): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const line of colsRegion.split("\n")) {
    const start = line.replace(/^\s+/, "");
    if (!start.startsWith("{")) continue;
    const key = start.match(/key:\s*"([\w-]+)"/);
    if (!key) continue;
    const head = start.split("render:")[0];
    const w = head.match(/\bwidth:\s*(\d+)/);
    out[key[1]] = w ? Number(w[1]) : null;
  }
  return out;
}

const widths = colWidths();

// 选择列由 rowSelection 生成，不在 columns 里：它的实测宽是 32px，是 998 的组成部分。
const SELECTION_COL = 32;
// 「接口」列不吃声明宽，只在下限之上吃盈余；下限值就是 998 里给它预留的那一份。
const NAME_FLOOR = 220;

describe("api 表列宽：盈余必须落在「接口」列，不许摊给短列", () => {
  it("分母站得住：12 列都抠到了（抠法脱钩时不许变假绿）", () => {
    expect(Object.keys(widths).sort(), "列声明行的抠法失效了").toEqual(
      ["badge", "cases", "created", "method", "mod", "name", "ops", "owner",
        "passrate", "result", "status", "upd"].sort());
  });

  it("tableLayout 必须是 fixed，且 scroll.x 与它同处一个 props 区", () => {
    expect(propsRegion, "tableLayout 没写：auto 布局会把盈余按比例摊给每一列").toMatch(/tableLayout="fixed"/);
    expect(propsRegion, "scroll.x 缺了就进不了 scroll 横滚口径").toMatch(/scroll=\{\{\s*x:\s*(\d+)/);
  });

  it("「接口」列刻意不吃声明宽——它是唯一可伸缩的一列", () => {
    expect(widths.name, "接口列写死 width 后盈余无处可去，右侧会空出一块").toBeNull();
  });

  it("固定列宽 = 回收站/最长内容实测下限，逐个钉住", () => {
    // 每一格的出处都写在该列上方的注释里（折行会把「运行记录没取到」说成半句话）。
    expect(widths).toMatchObject({
      method: 80, mod: 100, status: 88, owner: 96, upd: 120, badge: 104, ops: 158,
      // D276 批量用例规模四列
      cases: 76, result: 96, passrate: 104, created: 120,
    });
  });

  it("998 与列宽算式对齐：固定列 + 选择列 + 接口列下限", () => {
    const x = Number(propsRegion.match(/scroll=\{\{\s*x:\s*(\d+)/)?.[1]);
    const fixedSum = Object.entries(widths)
      .filter(([k]) => k !== "name")
      .reduce((a, [, w]) => a + (w ?? 0), 0);
    expect(fixedSum + SELECTION_COL + NAME_FLOOR, "加/删列或改宽后要同步 scroll.x，否则接口列的下限就不是 220 了")
      .toBe(x);
  });
});
