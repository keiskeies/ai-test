// styles.css 的 `--tp-*` 与 theme.ts 的 Token 必须同值——否则「改主题」只改到一半：
// React 侧（Canvas 描边、折线色、antd token）跟着新值走，纯 CSS 侧（骨架、Tag 色相、
// 呼吸光环）留在旧值上，同一个「运行中」在画布上出现两种蓝。这类漂移看不见：两处都
// 「有颜色」，只是不同色，e2e 也不看光环的色值。
//
// 不比对「我记得的 hex」，而是把 CSS 文件读进来当场抠值——和 shared/runVocab.test.ts
// 对着后端源码抠 pattern 是同一个路子。读不到文件就抛错，不 skip：跳过的契约测试等于没有契约。
//
// 2026-11-21 设计系统改版后的映射口径（本文件是唯一实现处，别在别处再抄一份）：
//   · tp.<group>.<k>        → --tp-<group>-<k>            （hex/rgba，按值比）
//   · tp.<group>.<sub>.<k>  → --tp-<group>-<sub>-<k>      （tag 组的三段色，按值比）
//   · tp.fontSize.<k>       → --tp-fs-<k>                 （fs 是样式表里的短名，见下）
//   · tp.radius.<k>         → --tp-radius-<k>             （数字 ↔ px，按像素比）
//   · tp.shadow.<k>         → --tp-shadow-<k>             （rgba 串，按值比）
//   · metrics.<camelCase>   → --tp-metric-<kebab-case>    （数字 ↔ px，按像素比）
// fontSize→fs 这条例外**必须有**：样式表里它出现在 .tp-text-* 的每一次字体声明旁，
// 写成 --tp-fontSize-sm 会让属性名比值还长；这里显式登记别名，比在样式表里迁就长名可读。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { metrics, tp } from "./theme";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, "styles.css");

const raw = (() => {
  try {
    return readFileSync(CSS, "utf8");
  } catch {
    throw new Error("读不到 styles.css：" + CSS + "（Token 漂移测试不能跳过）");
  }
})();

// 注释里提到某个 hex 不算「用了这个色」——本文件的历史说明就写着「此前这里是 #1677FF」。
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 抠 `:root { … }`（浅色）块里声明的 CSS var：变量名 → 大写值。
 * 刻意**不**并深色块：深色的值本来就和 theme.ts 的浅色值不同（那正是它的职责），
 * 并进来只会让「同值」比对在每个深色覆盖项上假红。深色块的检查在下面单列一条。
 */
function cssVars(): Record<string, string> {
  // 浅色 var 分布在两个 :root 块里（骨架/色/尺寸一块，Tag 三段色一块）：逐个收、合并。
  const blocks = [...css.matchAll(/(:root(?:\[data-theme="dark"\])?)\s*\{([^}]*)\}/g)]
    .filter((b) => b[1] === ":root");
  if (blocks.length === 0) throw new Error("styles.css 里找不到浅色 `:root` 块——本例的抠法得同步改");
  const out: Record<string, string> = {};
  for (const b of blocks) {
    for (const m of b[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[m[1]] = m[2].trim().toUpperCase();
    }
  }
  return out;
}

const vars = cssVars();

/** theme.ts 的 token 展开成「CSS 变量名 → 期望值」。数字一律折成 px。 */
function expectedVars(): Record<string, string> {
  const out: Record<string, string> = {};
  const px = (v: number) => `${v}PX`;
  const put = (name: string, v: unknown) => {
    if (typeof v === "string") out[name] = v.toUpperCase();
    else if (typeof v === "number") out[name] = px(v);
  };
  const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  for (const [group, val] of Object.entries(tp)) {
    if (typeof val === "string") { put(`--tp-${kebab(group)}`, val); continue; }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") {
        const alias = group === "fontSize" ? `fs` : group;
        // 键名一律转 kebab：borderHover → border-hover。样式表里不写驼峰是 CSS 惯例，
        // 这里做转换而不是让样式表迁就 TypeScript 的命名。
        put(`--tp-${alias}-${kebab(k)}`, v);
      } else if (v && typeof v === "object") {
        for (const [sub, sv] of Object.entries(v as Record<string, unknown>)) put(`--tp-${group}-${k}-${sub}`, sv);
      }
    }
  }
  for (const [k, v] of Object.entries(metrics)) {
    out[`--tp-metric-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`] = px(v);
  }
  return out;
}

const expected = expectedVars();

/** theme.ts 的 hex 转成 `rgb(r g b)` 前缀，用来核对 keyframes 里的分量写法。 */
function rgbTriple(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

describe("--tp-* CSS 变量 ↔ theme.ts Token", () => {
  it("每个在 :root 声明的 --tp-* 都能在 theme.ts 找到同值 Token", () => {
    const unknown = Object.keys(vars).filter((v) => !(v in expected));
    expect(unknown, "styles.css 新增了没进 theme.ts 的 --tp-* 变量").toEqual([]);
    const mismatched = Object.entries(vars)
      .filter(([k, v]) => k in expected && expected[k] !== v)
      .map(([k, v]) => `${k}: css=${v} theme=${expected[k]}`);
    expect(mismatched, "--tp-* 与 theme.ts 不同值").toEqual([]);
  });

  it("分母站得住：浅色变量覆盖到了骨架/色/尺寸三类（防止抠法脱钩后这条变假绿）", () => {
    // 抠法一旦和 styles.css 的写法脱钩，unknown 会是空数组、mismatched 也是空的——
    // 两条都绿而实际一个变量都没比到。这三条分别盯住「尺寸」「色」「圆角字号」。
    expect(vars["--tp-metric-topbar-h"], "尺寸类没抠到").toBe("56PX");
    expect(vars["--tp-text-1"], "中性色没抠到").toBeTruthy();
    expect(vars["--tp-radius-lg"], "圆角没抠到").toBeTruthy();
    expect(vars["--tp-tag-blue-bg"], "Tag 三段色没抠到").toBeTruthy();
  });

  it("深色块把中性色真的换掉了（不是浅色的一份拷贝）", () => {
    const dark = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
    if (!dark) throw new Error("styles.css 里找不到深色 `:root[data-theme=\"dark\"]` 块");
    const v = (name: string) => {
      const m = dark[1].match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      return m ? m[1].trim().toUpperCase() : null;
    };
    expect(v("--tp-text-1")).not.toBe(tp.text[1].toUpperCase());
    expect(v("--tp-bg-layout")).not.toBe(tp.bg.layout.toUpperCase());
    expect(v("--tp-func-processing")).not.toBe(tp.func.processing.toUpperCase());
  });

  it("呼吸光环与 reduced-motion 描边都是 func.processing（同一个「运行中」不能两个蓝）", () => {
    expect(vars["--tp-func-processing"]).toBe(tp.func.processing.toUpperCase());
    // keyframes 不能直接引 var（box-shadow 的 spread + alpha 在旧 Safari 上不吞 var），
    // 所以那里是手写的 rgb() 分量——那就必须与 token 的分量一致。
    const breathe = css.match(/@keyframes tp-breathe\s*\{([\s\S]*?)\n\}/);
    if (!breathe) throw new Error("styles.css 里找不到 @keyframes tp-breathe——本例得同步改");
    const want = rgbTriple(tp.func.processing);
    const found = [...breathe[1].matchAll(/rgb\((\d+ \d+ \d+) \/ /g)].map((m) => m[1]);
    expect(found.length, "tp-breathe 里一个 rgb() 都没抠到").toBeGreaterThan(0);
    for (const triple of found) {
      expect(triple, "tp-breathe 的 rgb() 分量与 tp.func.processing 不一致").toBe(want);
    }
    // 静态描边走 var，改主题自动跟——这条是防止有人把它改回硬编码 hex。
    expect(css).toMatch(/\.tp-node-running\s*\{\s*animation:\s*none;\s*outline:\s*2px solid var\(--tp-func-processing\)/);
  });

  it("样式表里不留 antd 默认蓝 #1677FF（蓝图 §11.6 未批准该色）", () => {
    expect(css.toUpperCase()).not.toContain("#1677FF");
  });
});