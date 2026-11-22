// 满高链的源码契约。jsdom 没有布局引擎：flex 链断了、表头不钉了、rc-table 的行内
// overflow 把数据挡死了，测试全都照样绿——而这些都是这一轮实测踩到的真缺陷（20 行时
// 第 11–20 行既看不见也滚不到；行内 style="overflow: auto hidden;" 压不过特异性）。
// 所以对着 styles.css 的文本抠选择器，路子同 theme.drift.test.ts：读不到就抛错，不 skip。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = join(dirname(fileURLToPath(import.meta.url)), "styles.css");
const raw = (() => {
  try {
    return readFileSync(CSS, "utf8");
  } catch {
    throw new Error("读不到 styles.css：" + CSS + "（满高链契约测试不能跳过）");
  }
})();
// 注释里写选择器不算声明过（本文件的说明就引用了 .ant-table-content）。
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** 把样式表拆成 [选择器, 规则体]：逗号选择器组拆成一条一个选择器——否则
 *  `.a,\n.b { … }` 只有 .b 能被前缀匹配捞到，.a 会假红（第一版就栽在这）。 */
const rules: Array<[string, string]> = (() => {
  const out: Array<[string, string]> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    for (const sel of m[1].split(",")) {
      const s = sel.replace(/\s+/g, " ").trim();
      if (s && !s.endsWith("*/")) out.push([s, body]);
    }
  }
  return out;
})();

/** 该选择器的所有规则体（同一选择器可能带 !important 单列一条）。 */
function bodiesFor(selector: string): string[] {
  return rules.filter(([s]) => s === selector).map(([, b]) => b);
}

/** 断言某选择器存在且规则体命中 pattern。 */
function assertRule(selector: string, pattern: RegExp, why: string): void {
  const hit = bodiesFor(selector).some((b) => pattern.test(b));
  expect(hit, why + "：styles.css 里 " + selector + " 缺 " + pattern).toBe(true);
}

const FILL_STACK = ".tp-fill-stack";
const FILL_BODY = ".tp-fill-body .tp-tablecard";
const TABLE_CONTENT = FILL_BODY + " .ant-table-content";

describe("满高链：高度必须逐层传递，断一环就整页滚", () => {
  it(".tp-fill-stack 从 metrics 反解视口，不手写像素减法", () => {
    assertRule(FILL_STACK, /height:\s*calc\(100dvh/, "没从视口算高");
    assertRule(FILL_STACK, /var\(--tp-metric-topbar-h\)/, "顶栏高没走 metrics");
    assertRule(FILL_STACK, /var\(--tp-metric-page-pad\)/, "页边距没走 metrics");
  });

  it("stack 的裸子项不吃高，只有 .tp-fill 吃剩下", () => {
    // ProjectGate 把只读横幅作为兄弟节点插进来，不压住就会和正文抢高度。
    assertRule(FILL_STACK + " > *", /flex:\s*0 0 auto/, "兄弟节点（只读横幅/页头）在抢高度");
    assertRule(FILL_STACK + " > .tp-fill", /flex:\s*1 1 auto/, "正文没吃剩余高度");
  });

  it("卡片到表体之间的每一层都声明 grow——漏一层就断链", () => {
    // 实测教训：`.ant-table-wrapper > * { flex: 0 0 auto }` 会把 .ant-spin-nested-loading
    // 一起压平，卡 564 / 表 259，看着「有 flex」却完全不吃高。
    const layers = [
      ".ant-table-wrapper", ".ant-spin-nested-loading", ".ant-spin-container",
      ".ant-pro-card", ".ant-table", ".ant-table-container",
    ];
    const missing = layers
      .map((l) => FILL_BODY + " " + l)
      .filter((sel) => !bodiesFor(sel).some((b) => /flex:\s*1 1 auto/.test(b)));
    expect(missing, "这些中间层没在满高卡里 grow").toEqual([]);
  });

  it("表体自己滚：rc-table 的行内 overflow 只能用 !important 压", () => {
    // rc-table 在给了 scroll.x 时写行内 style="overflow: auto hidden;"，纵向交回页面；
    // 满高页没有「交回页面」这条路，多出的行会被剪到看不见也滚不到。
    assertRule(TABLE_CONTENT, /flex:\s*1 1 auto/, ".ant-table-content 没 grow");
    assertRule(TABLE_CONTENT, /overflow-y:\s*auto\s*!important/, "行内样式压不过，必须 !important");
    // 给了 scroll.y 时 antd 用 .ant-table-body 而不是 .ant-table-content：另一条也要在，
    // 否则以后谁给这页加 scroll.y，满高就静默失效。
    assertRule(FILL_BODY + " .ant-table-body", /flex:\s*1 1 auto/, ".ant-table-body 没 grow");
  });

  it("表头钉在 thead 上，不是 th", () => {
    // th sticky 的 containing block 是它自己那一行，实测滚 528 时表头卷到 −528，等于没钉。
    assertRule(FILL_BODY + " .ant-table-thead", /position:\s*sticky/, "thead 没 sticky");
    const onTh = rules.some(([s, b]) => /ant-table-thead\s*>\s*tr\s*>\s*th/.test(s) && /position:\s*sticky/.test(b));
    expect(onTh, "sticky 挂回 th 就不生效，必须挂 thead").toBe(false);
  });

  it("拉满高的 height:100% 只许出现在空表选择器里", () => {
    // 给有数据的表写 table{height:100%}：3 行 66px 会被撑成 203px 摊满整屏。
    const bad = rules
      .filter(([s, b]) => s.includes(".ant-table") && /height:\s*100%/.test(b) && !s.includes(".ant-table-empty"))
      .map(([s]) => s);
    expect(bad, "这些非空表选择器把 table 拉到满高了").toEqual([]);
  });

  it("左栏卡片封顶在行高内（wrap={false} 后唯一的溢出出口）", () => {
    assertRule(".tp-fill .ant-col > .ant-card", /max-height:\s*100%/, "展开的树会把整页顶滚");
  });

  it("左右两栏是同一种容器：都吃满列高，卡体也是 flex 列", () => {
    // 只有 max-height（封顶）时短树实测左卡 112 / 右卡 677 对列高 765：两条不齐的底边
    // 与「卡里再套一张带框的卡」是这轮被点名的版式缺陷。
    assertRule(".tp-fill-side", /display:\s*flex/, "列不是 flex 列，卡没有可解的确定高度");
    assertRule(".tp-fill-side", /min-height:\s*0/, "列不放开最小高度就吃不到行高");
    assertRule(".tp-fill-side > .ant-card", /flex:\s*1 1 auto/, "卡没吃满列高，底边对不齐另一栏");
    assertRule(".tp-fill-side > .ant-card", /min-height:\s*0/, "内容顶穿列高，整页又竖滚");
    assertRule(".tp-fill-side > .ant-card", /flex-direction:\s*column/, "卡体不是纵向 flex，右侧三段没顺序");
    assertRule(".tp-fill-side > .ant-card > .ant-card-body", /flex:\s*1 1 auto/, "卡体不吃卡高，表就长不满");
    assertRule(".tp-fill-side > .ant-card > .ant-card-body", /min-height:\s*0/, "同上一条：漏一环就断链");
    // 溢出出口在上一轮那条 max-height 规则里（overflow:auto），这里不重复钉。
  });
});
