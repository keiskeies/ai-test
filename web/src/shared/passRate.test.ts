// passRate 的纯测试。钉三件事，每件都对应一次真实的「全绿却算错」：
// ① 四舍五入不是截断（0.666→67）——这条若翻脸，界面上会出现「66%」而环是 67%；
// ② null 走「空值」而不是 0 —— 把「没结论」画成 0% 是在编造一个结论；
// ③ pctAttr 与 ratePct **必须同源**：同一个数在 data-percent 上是 "60"、在文案里是 "60%"。
//    这条是 6b V1 变异（外壳与环各算一遍、断言只钉住一份）的直接解药。
import { describe, expect, it } from "vitest";
import { pctAttr, ratePct, ratePctNum } from "./passRate";

describe("ratePctNum", () => {
  it("四舍五入，不是截断", () => {
    expect(ratePctNum(0.666)).toBe(67); // 截断会给 66
    expect(ratePctNum(0.664)).toBe(66);
    expect(ratePctNum(1 / 3)).toBe(33);
  });

  it("端点值", () => {
    expect(ratePctNum(0)).toBe(0);
    expect(ratePctNum(1)).toBe(100);
    expect(ratePctNum(0.5)).toBe(50);
  });
});

describe("ratePct", () => {
  it("带百分号", () => {
    expect(ratePct(0.6)).toBe("60%");
    expect(ratePct(0)).toBe("0%");
  });
});

describe("pctAttr", () => {
  it("null（没结论）画空串，不画 0", () => {
    expect(pctAttr(null)).toBe(""); // 画成 "0" 就是把「无分母」说成「全挂」
  });

  it("和 ratePct 同源：同一个数、同一个十进制值", () => {
    for (const r of [0, 0.5, 0.6, 0.666, 0.999, 1]) {
      expect(pctAttr(r)).toBe(ratePct(r).replace("%", ""));
    }
  });
});
