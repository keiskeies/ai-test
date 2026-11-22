// §11.6.6 观感红线：「图标一律 Lucide 1.6px 描边线性风，**禁止 emoji 混入 UI**」
// （design 文档 :1506 逐字）。这一条以前没有任何门禁会因为它变红——§11.6/§11.7 是全蓝图唯一
// 没有批次认领的两节（D58 登记的原始病因），所以台账 :956 才敢写「全站无 emoji 图标，可放心」，
// 而那句是假的：`💭`(U+1F4AD) 在 `EventCard.tsx` 当 THINKING 前缀、`❓`(U+2753) 在
// `QuestionCard.tsx` 写成 `<span role="img">`（`role="img"` 就是自供在当图标），
// 两者文档零处方、测试零钉（第三十二轮实测，本轮清掉）。
//
// 白名单不是「我认得这些符号」，每条都要有**处方或既有契约**撑着：
//   ✎ ▶ ◷ ✦  出自 shared/runVocab.ts 的触发方式词条，被 runs.test.tsx:131 / reports.test.tsx:86
//            逐字钉成 ["✎ 调试","▶ 手动","◷ 定时","✦ Pilot"]——动它们 = 改已钉文案
//   ♻        蓝图 :850/:972 与 §11.4.18（:1061）自绘的「♻回收站」
//   默认★     蓝图 :1110/:1190 的「默认★」（ModelTab.tsx:176 逐字）
//   ✓ ✗ ○ ●  §11.4.33 的绿勾/文本叉与状态点：文本符号，无彩色 presentation，不是「emoji 混进来」这一档
// 尺子只禁**彩色象形 emoji**（含把它们推成彩色的 U+FE0F）：那才是红线在防的东西。
// 白名单是**封闭集**：新增任何符号都得回这里写理由，🚀 之类默认就是红的。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 候选区段：象形 emoji + 杂项符号/装饰符号 + 几何形状（○▶●◷）。
 *  U+FE0F 单独走分支：它是组合用的变体选择符，放进字符类里 lint 会报 no-misleading-character-class，
 *  而且只有 FE0F 该管——FE0E 是把符号**拉回文本呈现**的那个方向，禁它就禁反了。 */
const CAND = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}]|\u{FE0F}/gu;

/** 允许留在界面上的码位 → 凭什么留下（见文件头）。 */
const ALLOWED: Record<string, string> = {
  "270E": "runVocab 词条，runs.test.tsx:131 / reports.test.tsx:86 逐字钉",
  "25B6": "runVocab 词条，同上",
  "25F7": "runVocab 词条，同上",
  "2726": "runVocab 词条，同上；api.test.tsx:727 反向钉旧文案「✦Agent」绝迹",
  "267B": "蓝图 :850/:972 与 §11.4.18 自绘「♻回收站」",
  "2605": "蓝图 :1110/:1190 的「默认★」",
  "2713": "§11.4.33 绿勾语义（蓝图文本符号）",
  "2717": "与 ✓ 成对的文本叉（蓝图文本符号）",
  "25CB": "PlanListCard 状态点 ○（§11.4.33）",
  "25CF": "ModelTab 探测状态点（蓝图 :1190「探测状态点」）",
};

const cpOf = (ch: string) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");

/** 注释里的符号不算「界面上有」：台账 :956 那句假话本身就写在自述里。
 *  行尾 // 只在行首或前面是空白时才算注释，`https://` 前面没空格不会被误剥。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
}

/** 扫一批「路径 + 内容」，返回违规出处的码位列表。纯函数：正对照喂内存假文件，不碰生产码。 */
function scan(files: Array<{ path: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const f of files) {
    stripComments(f.text).split("\n").forEach((line) => {
      for (const m of line.match(CAND) ?? []) {
        if (!ALLOWED[cpOf(m)]) hits.push(`${f.path} U+${cpOf(m)}`);
      }
    });
  }
  return hits;
}

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { productionFiles(p, out); continue; }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(e.name)) continue;
    if (e.name === "schema.d.ts") continue; // 生成物，只由 gen:api 写（D149）
    out.push(p);
  }
  return out;
}

const onDisk = productionFiles(HERE).map((p) => ({
  path: relative(HERE, p).replace(/\\/g, "/"),
  text: readFileSync(p, "utf8"),
}));
const onDiskFlat = onDisk.map((f) => ({ path: f.path, text: f.text }));

describe("§11.6.6 禁止 emoji 混入 UI", () => {
  it("生产码里零彩色 emoji；且分母与白名单都站得住", () => {
    expect(onDiskFlat.length).toBeGreaterThan(80); // 分母：真扫到了整个 src
    expect(scan(onDiskFlat), "违规：" + scan(onDiskFlat).join(" | ")).toEqual([]);
    // 白名单必须**真的命中过**：一个都没命中的条目是纸面豁免，命中不到的码位
    // 说明尺子漏了某个区段（我自己就先把 U+25A0–25FF 漏过一次，○▶●◷ 全在外面）
    const seen = new Set<string>();
    for (const f of onDiskFlat) {
      for (const m of stripComments(f.text).match(CAND) ?? []) seen.add(cpOf(m));
    }
    for (const cp of Object.keys(ALLOWED)) {
      expect(seen.has(cp), `白名单里的 U+${cp}（${ALLOWED[cp]}）已不在生产码里，或尺子扫不到它`).toBe(true);
    }
  });

  it("正对照①：🚀 必须报（没这一步，上面的「零违规」只是对尺子的假设）", () => {
    expect(scan([{ path: "probe.tsx", text: `export const a = "🚀 部署";` }]))
      .toEqual(["probe.tsx U+1F680"]);
  });

  it("正对照②：本轮清掉的 💭/❓ 再出现照样报（D58-N1 不许回流）", () => {
    expect(scan([
      { path: "a.tsx", text: `<span>💭 想</span>` },
      { path: "b.tsx", text: `<span role="img">❓</span>` },
    ])).toEqual(["a.tsx U+1F4AD", "b.tsx U+2753"]);
  });

  it("正对照③：注释里的不算、同行代码里的照样算（注释剥多了会放走真违规）", () => {
    expect(scan([{ path: "c.tsx", text: `// 🚀 说明\n/* 🚀 */\n` }])).toEqual([]);
    expect(scan([{ path: "d.tsx", text: `const a = "🚀"; // 🚀 注释里也有` }]))
      .toEqual(["d.tsx U+1F680"]);
  });

  it("正对照④：白名单符号后面跟 U+FE0F 也报——那个开关正是把符号推成彩色的", () => {
    expect(scan([{ path: "e.tsx", text: `const a = "♻️";` }])).toEqual(["e.tsx U+FE0F"]);
  });
});
