// 手抄 Token 的棘轮（D48-a 的前置条件）。
//
// 1G 计划 D48-a 说「全站 152 处硬编码 hex 逐域替换」不能顺手做，理由成立：那是静态检查看不出的
// 机械改动，改错一个色只能靠人眼。但它漏了一件事——**不做替换不等于不该停止增长**。这条测试
// 就是那条缺失的前置条件：不许新增手抄，存量按当前测量值钉死，只减不增。
//
// 口径说明（别把它读成「全仓裸 hex 计数」）：只统计**能在 theme.ts 找到同值 Token** 的字面量。
// 未 sanction 的野色（antd 蓝 #1677FF、审批橙、老绿红、约 20 个自造浅色变体——D48-d 待裁那一包）
// **不计入**：它们没有对应的 Token，硬要计入就等于把「待业主裁」的那一包偷偷做掉了。
// 所以这个数是「已有 Token 却被绕过的次数」，语义比裸 hex 计数更窄也更准。
//
// **这条棘轮的盲区，写在最容易误读它的地方**：它抓不到「写了一个和 Token 相近但不相同的值」。
// 实例：`CommandPalette.tsx` 的遮罩一度写 `rgba(16,24,40,.45)`，而 `tp.mask` 是
// `rgba(31,40,51,.45)`（§11.6.4 中性色 `:1492`）——字符串不相等 → 不计入 → 棘轮一路绿，而屏幕上的
// 遮罩色其实一直不对（那条本轮已按 D48-f 顺手改回 `tp.mask`）。同理 `0 12px 48px rgba(16,24,40,.18)`
// 与 `tp.shadow.s3` 的 `0 12px 32px rgba(.14)` 也是「像但不是」，属 D48-e 待裁那一包。
// 所以别把这条绿读成「没有色值漂移」：它只保证**不去新增已经存在的 Token 的副本**，
// 「该用 Token 却写了个别值」得靠 §11.6 的对表审计（D48 那一串）来抓。
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, ".");

/** theme.ts 里所有可被手抄的 Token 值：6 位 hex，与任何含 rgba() 的串（阴影、遮罩）。 */
function tokenValues(): { hexes: Set<string>; rgbs: Set<string> } {
  const theme = readFileSync(join(SRC, "theme.ts"), "utf8");
  const hexes = new Set<string>();
  const rgbs = new Set<string>();
  for (const m of theme.matchAll(/"(#[0-9A-Fa-f]{6})"/g)) hexes.add(m[1].toUpperCase());
  // 注意别写成 `(?:0|[0-9]+)px …` 这种「以长度开头」的形状：shadow 全是
  // `0 1px 2px rgba(…)` 开头，那个正则一个都匹配不上，计数会静默掉一整个类别（第一版就这么假绿过）。
  for (const m of theme.matchAll(/"([^"]*rgba\([^"]*\))"/g)) rgbs.add(m[1]);
  return { hexes, rgbs };
}

/** 一个文件里的手抄次数。hex 比对两边都转大写（`#e2e6e9` 也是手抄），rgba 串按原样比。 */
function handCopies(src: string, vals: { hexes: Set<string>; rgbs: Set<string> }): number {
  const upper = src.toUpperCase();
  let n = 0;
  for (const v of vals.hexes) n += upper.split(v).length - 1;
  for (const v of vals.rgbs) n += src.split(v).length - 1;
  return n;
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      sourceFiles(p, acc);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(e.name)) continue; // 测试里的期望值本来就是字面量
    if (e.name === "schema.d.ts") continue; // openapi-typescript 生成物
    if (e.name === "theme.ts") continue; // 真相文件自己当然写着 hex
    acc.push(p);
  }
  return acc;
}

/**
 * 存量基线。改一处去重就把它调小一格，**不许调大**。
 * 2026-11-17 两次实测：`97eb76e`（D48 三处改引 Token）那棵树 **120** → shadow/背景去重后 **113**
 * （login.tsx 2→0、workbench.tsx 3→2、Canvas.tsx 18→14）。第四十六轮整树合账时全量实测 **111**：
 * 第 24–43 轮散在各工作树文件里的去重（D146/D152/D165 一族改引 Token）随本批合账进树，
 * 棘轮按自家纪律当场调下来——基线只反映「盘上此刻的真数」。
 * 2026-11-21 Pilot 试验台会话流改版：`EventCard.tsx` 的卡片底色/边框/文字色全部改引 Token，
 * 会话页两处 `#EBEEF0`/`#E2E6E9` 与 `.tp-evkind` 的 `#B4BBC2`（该 class 随徽标一起删）
 * 一并离场，全量实测 **102**。
 * 2026-11-22 设计系统改版（双主题/图标/密度）：页面里成片的内联 hex 改引 `tp.*` / CSS var
 * （EventCard、Canvas、bench、planDetail、plans、notifyChannels、workbench、login、
 * CommandPalette、StepListEditor、settings 域…），再把 scene/ 与调试面板的 `#fff`/`#EBEEF0`/
 * `#E2E6E9`/`#F6F8F7`/`#5F6B76`/`#8A949E` 字面量改引 var，全量实测 **39**——棘轮按纪律当场下调。
 * 剩余 39 处集中在画布节点/API 调试面板的深色代码块与少数非 Token 色（画布默认几何色，
 * 归 D48-d 待裁那一包），下一轮继续。
 * 2026-11-22 双主题颜色适配：scenes.tsx 的 RUN_DOT 五个手抄 hex 改引 `tpv.func.*`
 * （顺带修掉一个真 bug：状态点写死浅色 hex，深色主题下深绿点在深底上看不见），实测 **34**。
 */
const BASELINE = 34;

describe("手抄 Token 棘轮（只减不增）", () => {
  const vals = tokenValues();
  const hits: Array<[string, number]> = [];
  for (const f of sourceFiles(SRC)) {
    const n = handCopies(readFileSync(f, "utf8"), vals);
    if (n > 0) hits.push([f.slice(SRC.length + 1).replace(/\\/g, "/"), n]);
  }
  const total = hits.reduce((a, [, n]) => a + n, 0);

  it("theme.ts 至少解析出 30 个 Token 值（解析法没坏，否则这条测试是假绿）", () => {
    // 计数逻辑一旦和 theme.ts 的写法脱钩，total 会悄悄掉到 0 并「通过」。这两条防的就是它自己变假绿：
    // 一条盯 hex 数量，一条盯 rgba/shadow 数量——脱钩通常只发生在其中一类上。
    expect(vals.hexes.size, "hex 抠少了——本例的正则要跟着 theme.ts 的写法一起改").toBeGreaterThanOrEqual(25);
    expect(vals.rgbs.size, "rgba/阴影 抠少了——本例的正则要跟着 theme.ts 的写法一起改").toBeGreaterThanOrEqual(4);
  });

  it(`手抄 Token 不超过基线 ${BASELINE}（当前 ${total}）`, () => {
    const worst = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([f, n]) => `${f}:${n}`).join("  ");
    expect(total, `新增了手抄。当前分布（最多六个）：${worst}`).toBeLessThanOrEqual(BASELINE);
  });

  it("存量若已低于基线，把基线调下来（棘轮不许长期松着）", () => {
    expect(total, `存量已是 ${total}，基线还写着 ${BASELINE}——把 BASELINE 改成 ${total}`).toBe(BASELINE);
  });
});
