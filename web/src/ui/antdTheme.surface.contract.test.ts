// antd 解析后 token 的深浅对表测试。
//
// 为什么要有这条：本项目刻意不用 antd 的 darkAlgorithm（理由见 antdTheme.ts 文件头），
// 于是**每一个没手写映射的 token 都还按浅色色板推导**。这类 bug 静态检查看不出、
// jsdom 也测不出（没有样式引擎）——只有把 getDesignToken() 解析完再比色才抓得到。
//
// 触发实例（2026-11-22，两处同源）：
//   · colorPrimaryBg 没映射 → antd 从 colorPrimary 反推出深色下的浅米绿，压在近白正文上 1.05:1；
//     同源扩散到 Tree 选中节点 / Table 选中行 / Dropdown 选中项（controlItemBgActive 直接等于它）。
//   · 中性填充族来自 colorTextBase（恒 #000）→ rgba(0,0,0,.15) 在深底上是「更黑」而不是「更亮」。
import { describe, expect, it } from "vitest";
import { theme } from "antd";
import { antdThemeFor } from "./antdTheme";
import { tokensFor } from "../theme";
import type { ThemeMode } from "./themeMode";

type RGB = [number, number, number];

const HEX6 = /^#([0-9a-f\d]{6})$/i;
const HEX3 = /^#([0-9a-f\d]{3})$/i;
const RGBFN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)$/;

/** 解析 token 颜色。解析不了就抛错：静默跳过会让整条测试假绿。 */
function parse(color: unknown): { rgb: RGB; alpha: number } {
  if (typeof color !== "string") throw new Error(`token 不是颜色串：${String(color)}`);
  const s = color.trim();
  const h6 = HEX6.exec(s);
  if (h6) {
    const n = parseInt(h6[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const h3 = HEX3.exec(s);
  if (h3) {
    const [r, g, b] = h3[1].split("").map((c) => parseInt(c + c, 16)) as RGB;
    return { rgb: [r, g, b], alpha: 1 };
  }
  const m = RGBFN.exec(s);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])] as RGB, alpha: m[4] === undefined ? 1 : Number(m[4]) };
  throw new Error(`解析不了的颜色串：${color}`);
}

/** alpha 色要先按它压着的底合成再比色——rgba(0,0,0,.15) 的「名义亮度」没有意义。 */
function over(fg: RGB, alpha: number, bg: RGB): RGB {
  return fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as RGB;
}

/** 把任意 token 落到某个不透明底上，得到它真正呈现的 RGB。 */
function flatten(color: unknown, behind: unknown): RGB {
  const b = parse(behind);
  if (b.alpha !== 1) throw new Error("比色基准必须是不透明底：" + String(behind));
  const f = parse(color);
  return over(f.rgb, f.alpha, b.rgb);
}

function luminance([r, g, b]: RGB): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// 正文会压上去的表面。alpha 项（colorFill 一族）按容器底合成后再比。
const SURFACES = [
  "colorPrimaryBg", "colorPrimaryBgHover", "controlItemBgActive", "controlItemBgActiveHover",
  "controlItemBgHover", "colorFillSecondary", "colorFillTertiary", "colorFillQuaternary",
  "colorFill", "colorFillContent", "colorBgTextActive",
  "colorBgContainer", "colorBgElevated", "colorBgLayout",
];
// 派生链的两个根（值 = 应当亮于中灰）。alpha 填充不在这里列：它合成后的相位由容器底决定，
// 摆进来只会测到容器底本身——那一族由「跟随主题翻相」那条管。
const PHASE: Record<ThemeMode, Record<string, boolean>> = {
  light: { colorBgBase: true, colorTextBase: false },
  dark: { colorBgBase: false, colorTextBase: true },
};

describe.each(["light", "dark"] as ThemeMode[])("antd 表面 token（%s）", (mode) => {
  const tok = theme.getDesignToken(antdThemeFor(mode)) as unknown as Record<string, string>;
  const t = tokensFor(mode);
  const container = parse(tok.colorBgContainer).rgb;

  it("正文压在每个表面色上都过 4.5:1（WCAG AA）", () => {
    const text = parse(tok.colorText);
    for (const key of SURFACES) {
      // 表面先落到容器底上（alpha 表面才有意义），正文再落到该表面上——两层都要合成才算屏幕上的真色。
      const bg = flatten(tok[key], tok.colorBgContainer);
      const r = ratio(over(text.rgb, text.alpha, bg), bg);
      expect(r, `${key} = ${tok[key]} 压正文 ${tok.colorText} 只有 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("每一级正文色压上容器底都过 4.5:1（含禁用态）", () => {
    // 禁用态在这里点名：侧栏「未开放（计划二期）」是诚实口径，走 colorTextDisabled；
    // antd 默认按 colorTextBase 的 25% alpha 推，浅底 1.94:1、深底也才 2.84:1——等于没写。
    const TEXTS = ["colorText", "colorTextHeading", "colorTextSecondary", "colorTextTertiary", "colorTextDescription", "colorTextDisabled"];
    for (const key of TEXTS) {
      const r = ratio(flatten(tok[key], tok.colorBgContainer), container);
      expect(r, `${key} = ${tok[key]} 压容器底 ${tok.colorBgContainer} 只有 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // 占位符允许低一档（3:1 是 antd 与业界对 placeholder 的通行口径），但仍要看得见。
    expect(ratio(flatten(tok.colorTextPlaceholder, tok.colorBgContainer), container),
      `colorTextPlaceholder = ${tok.colorTextPlaceholder} 看不见`).toBeGreaterThanOrEqual(3);
  });

  it("中性填充跟随主题翻相（不得停在 colorTextBase 的黑 alpha）", () => {
    // 未映射时这一族 = rgba(0,0,0,α)：浅底正确，深底等于「更黑」，Empty 插图/列头分隔成黑洞。
    for (const key of ["colorFill", "colorFillContent", "colorBgTextActive"]) {
      const onBg = ratio(flatten(tok[key], tok.colorBgContainer), container);
      expect(onBg, `${key} = ${tok[key]} 相对容器底只有 ${onBg.toFixed(2)}:1，等于看不见`).toBeGreaterThanOrEqual(1.1);
      expect(parse(tok[key]).rgb.every((v) => v === 0), `${key} = ${tok[key]} 仍是纯黑 alpha，没跟随主题`).toBe(false);
    }
  });

  it("选中/悬停底吃 tp 的 bg.selected / bg.hover", () => {
    expect(tok.colorPrimaryBg, "选中底必须是设计选中底，不能由 antd 从主色反推").toBe(t.bg.selected);
    expect(tok.controlItemBgActive, "controlItemBgActive 派生自 colorPrimaryBg，跟着一起钉住").toBe(t.bg.selected);
    expect(tok.controlItemBgActiveHover, "选中行上的 hover 也要是同族深底，否则一 hover 就变浅底看不见").toBe(t.primary[100]);
    expect(tok.controlItemBgHover).toBe(t.bg.hover);
  });

  it("派生链的根在正确的相位上（深色不得留白底根 / 黑字根）", () => {
    for (const [key, shouldLight] of Object.entries(PHASE[mode])) {
      expect(luminance(parse(tok[key]).rgb) > 0.5, `${key} = ${tok[key]} 在 ${mode} 下相位不对`).toBe(shouldLight);
    }
  });

  // ── 状态色的「前景梯子」：常态 → 悬停 → 按下 ────────────────────────────
  // 为什么单独测这一族：不用 darkAlgorithm，凡是没手写映射的 token 都按 antd 的
  // **浅色色板**反推，而状态色的反推值恰好都长得「像装饰不像正文」——
  // colorErrorTextHover 漏映射 = #bd5e55（看着像块脏粉，其实是 danger 链接的悬停字色，
  // 选中底 3.87），colorInfoTextHover = #78aaf5（2.14），深色里 colorLinkHover = primary[200]
  // （梯度深色反向后那是**底相**绿，1.78，链接一悬停就消失）。所以这一族必须逐 token 点名。
  const ROLE_PREFIX = /^(colorPrimary|colorLink|colorError|colorSuccess|colorWarning|colorInfo)/;
  const LADDER_SUFFIX = ["", "Hover", "Active", "Text", "TextHover", "TextActive"];
  // 六张真正会被当底用的表面（tp.bg 全组）：正文/状态字都落在这几块上。
  const SURFACE_BG = Object.values(t.bg);

  function worstOnSurfaces(key: string): number {
    const f = parse(tok[key]);
    return Math.min(...SURFACE_BG.map((bg) => {
      const bgRgb = parse(bg).rgb;
      return ratio(over(f.rgb, f.alpha, bgRgb), bgRgb);
    }));
  }

  it("状态色的前景 token 在每张表面上都过 4.5:1（悬停/按下不是豁免区）", () => {
    const checked: string[] = [];
    for (const key of Object.keys(tok).sort()) {
      if (!ROLE_PREFIX.test(key) || /Bg|Border|Outline|Fill/.test(key)) continue;
      const role = key.replace(/^color/, "");
      const stem = role.replace(/(Hover|Active|TextHover|TextActive|Text)$/, "");
      if (!["Primary", "Link", "Error", "Success", "Warning", "Info"].includes(stem)) continue;
      if (!LADDER_SUFFIX.includes(role.slice(stem.length))) continue;
      // 唯一豁免：裸 colorInfo。它是「信息」身份色，画在 Modal 确认图标 / message 的
      // info 图标 / Badge 圆点上（图标不是文字，3:1 口径），浅底 #4C86E8 = 3.57 是
      // 刻意与 styles.css 呼吸光环同值的身份蓝，不该被 4.5 的正文口径拖走。
      // 它的**文字**角色另有 colorInfoText 一族，那些照常受检。
      if (key === "colorInfo") continue;
      const v = tok[key];
      if (typeof v !== "string" || !/^(#|rgba?\()/.test(v.trim())) continue;
      const r = worstOnSurfaces(key);
      checked.push(key);
      expect(r, `${key} = ${v} 六张 tp.bg 表面最差 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // 防假绿：命名口径一旦和 antd 脱钩，checked 会空掉而整条通过。
    expect(checked.length, "一个前景 token 都没匹配到，本例的正则要跟着 antd 的命名改").toBeGreaterThan(20);
  });

  it("梯子方向对：悬停与按下不得比常态更糊", () => {
    // 方向比阈值更隐蔽。两处实例都在 2026-11-22 修掉：
    //   · 深色 colorErrorTextActive 引 func.errorActive（那是**实心按钮的底**，提亮红），
    //     当字用选中底只有 5.21，而常态是 6.32 —— 按下比常态还看不清；
    //   · 浅色 colorLinkHover 曾引 primary[500]，浅底上比常态更浅。
    // 两套梯度各自反向（浅：越按越深；深：越按越亮），所以只能这样对称地断言。
    for (const fam of ["Primary", "Error", "Success", "Warning", "Info"]) {
      const base = `color${fam}Text`;
      if (typeof tok[base] !== "string") continue;
      const b = worstOnSurfaces(base);
      for (const step of ["TextHover", "TextActive"]) {
        const key = `color${fam}${step}`;
        if (typeof tok[key] !== "string") continue;
        const r = worstOnSurfaces(key);
        expect(r, `${key} = ${tok[key]} 最差 ${r.toFixed(2)}:1，比常态 ${base}=${tok[base]} 的 ${b.toFixed(2)}:1 更糊`)
          .toBeGreaterThanOrEqual(b);
      }
    }
  });
});
