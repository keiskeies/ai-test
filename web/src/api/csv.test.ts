// parseTabular 的封顶口径单测（csv.ts:16 MAX_ROWS）。
// 存在的理由：capped 曾经只在函数内部用来收口行号，不进 PasteResult——5000 行粘进来，
// 页面报「解析出 2000 行」加一条成功 toast，丢掉的 3000 行一个字不提，正撞文件头
// 「静默改数据比报错更糟」。这里钉住 capped 的真实语义：是否真的砍过行。
// 行为口径全部来自 csv.ts 现实现：截断在补/砍行宽之后、行号提示收口只砍尾部。
import { describe, expect, it } from "vitest";
import { parseTabular } from "./csv";

const HEADER = "a\tb";
const dataLine = (i: number) => "v" + i + "\tw" + i;
/** 表头 + n 条等宽数据行（不触发 padded/overflow，只测封顶这一条轴）。 */
const tsv = (n: number) => [HEADER].concat(Array.from({ length: n }, (_, i) => dataLine(i))).join("\n");

describe("parseTabular：2000 行封顶必须可感知（capped）", () => {
  it("空输入早返回：capped=false，且各告警位全空", () => {
    const r = parseTabular("   \n\n");
    expect(r.columns).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.capped).toBe(false);
    expect(r.padded).toEqual([]);
    expect(r.overflow).toEqual([]);
    expect(r.duplicates).toEqual([]);
    // 未定义输入走同一个早返回（text ?? ""）
    expect(parseTabular(undefined as unknown as string).capped).toBe(false);
  });

  it("2000 行（恰在阈值）：capped=false——超过才算砍", () => {
    const r = parseTabular(tsv(2000));
    expect(r.rows).toHaveLength(2000);
    expect(r.capped).toBe(false);
  });

  it("2001 行（阈值+1）：capped=true，rows 截到 2000", () => {
    const r = parseTabular(tsv(2001));
    expect(r.rows).toHaveLength(2000);
    expect(r.capped).toBe(true);
    expect(r.rows[1999]).toEqual(["v1999", "w1999"]);
    expect(r.rows[2000]).toBeUndefined(); // 第 2001 行确实没了
  });

  it("2002 行且告警行号落在 2000 之后：capped=true、rows=2000，padded/overflow 被收口到 ≤2000", () => {
    // 行 1 短、行 2 长（真告警）；行 3..2000 等宽；行 2001 短、2002 长（被砍，告警必须一起消失）。
    // 摘掉 csv.ts:40-42 的收口 while-pop，padded 会带 2001、overflow 带 2002 → 这条红。
    const mid = Array.from({ length: 1998 }, (_, i) => dataLine(i));
    const lines = [HEADER, "1", "2\tX\tY"].concat(mid, ["9", "9\tA\tB"]).join("\n");
    const r = parseTabular(lines);
    expect(r.rows).toHaveLength(2000);
    expect(r.capped).toBe(true);
    expect(r.padded).toEqual([1]);       // 真短行留着，砍掉的行 2001 不许出现在提示里
    expect(r.overflow).toEqual([2]);     // 同上：行 2002 的长行提示一起收口
  });
});
