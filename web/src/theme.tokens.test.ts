// 手抄 Token 的棘轮（D48-a 的前置条件）。
//
// 1G 计划 D48-a 说「全站 152 处硬编码 hex 逐域替换」不能顺手做，理由成立：那是静态检查看不出的
// 机械改动，改错一个色只能靠人眼。但它漏了一件事——**不做替换不等于不该停止增长**。这条测试
// 就是那条缺失的前置条件：不许新增手抄，存量按当前测量值钉死，只减不增。
//
// 口径说明（别把它读成「全仓裸 hex 计数」）：只统计**能在 theme.ts 找到同值 Token** 的字面量。
// 未 sanction 的野色（审批橙、老绿红、自造浅色变体——D48-d 待裁那一包）**不计入**：它们没有对应的
// Token，硬要计入就等于把「待业主裁」的那一包偷偷做掉了。所以这个数是「已有 Token 却被绕过的次数」，
// 语义比裸 hex 计数更窄也更准。2026-11-22 日夜间清扫后，野色也只剩 `antdTheme.ts` 里深色底的两枚
// （#08201A / #2A333A，见该处注释）——原先「约 20 个自造浅色变体」那一包已基本离场。
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

/**
 * 剥掉注释，字符串字面量原样保留。
 *
 * 为什么计数前要先剥：本棘轮的口径是「已有 Token 却被**绕过**的次数」，而注释里引一个 hex
 * 不绕过任何东西——它引的正是被引 Token 本身。2026-11-22 双主题适配把计数从 34 推到 48，
 * 逐条查下来 14 处全在 `antdTheme.ts` 的注释里（「浅色底 #B03A33 白字 6.0」「深色下底是提亮红
 * #F08B84 → 白字 2.41」这类实测依据），代码里一个手抄都没新增：`git archive HEAD` 重测证明
 * 剥注释后 HEAD 与当树同为 **29**。也就是说先前那 34 里本就掺着 13 处注释散文。
 * 不剥的后果不是数字难看：写「把实测值写进注释」会被计入，于是要么删掉有用的证据，
 * 要么调大基线——两条都是在教后人别写为什么。
 *
 * 误剥一处就会让计数**虚降**，那才是真假绿，所以三条边界都有断言盯着（见「剥注释只剥注释」）：
 * 引号内不判注释；JSX 裸文本里的 `https://` 靠前一个字符是 `:` 才不截断；正则字面量天然安全——
 * 里面想出现连续两个斜杠必须写成 `\/\/`，那样它们就不相邻，于是「斜杠成对」在真码里只可能是注释。
 */
function stripComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        out += c + (src[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    // 前一个非空字符是 `:` → 这是 URL 的 `://`，不是行注释。
    if (c === "/" && src[i + 1] === "/" && out.endsWith(":")) {
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 1; // 跳过 `*/` 的两字符；for 的 i++ 补上第二个
      continue;
    }
    out += c;
  }
  return out;
}

/** 一个文件里的手抄次数（注释不计，见 stripComments）。hex 比对两边都转大写，rgba 串按原样比。 */
function handCopies(raw: string, vals: { hexes: Set<string>; rgbs: Set<string> }): number {
  const stripped = stripComments(raw);
  const upper = stripped.toUpperCase();
  let n = 0;
  for (const v of vals.hexes) n += upper.split(v).length - 1;
  for (const v of vals.rgbs) n += stripped.split(v).length - 1;
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
 * 2026-11-22 同日把口径改严（见 stripComments）：注释里引的实测值不再计入。按新口径重测
 * HEAD 那棵树是 **29**——先前 34 里掺着 13 处 `antdTheme.ts` 的注释散文，真正的手抄一直是 29。
 * 改口径当轮当树同样实测 **29**（新增的前景色全部走 `t.func.*`，没有一处手抄）。
 * 2026-11-22 深色主题实测抓到同源四处：CommandPalette / reportDetail / DebugDrawer /
 * ListMode 的「选中行」底各自手抄 `#EAF6F1`（= 浅色 `bg.selected`），深色下浅色正文压浅绿底
 * 只有 1.09:1，等于选中项看不见。四处改引 `tpv.bg.selected` 后实测 **25**。
 * 同日报告详情页又抓到第三个形状：统计行「过/败/错」用 `tp.chart` 色板当文字色
 * （#2BA47D/#D48806/#D3564F），浅底 3.13/2.87/4.03 全不过线——theme.ts:22 早就裁定过
 * 「#D48806/#D3564F 做字太浅，字色一并下沉」。改引 `tpv.func.*` 后实测 **22**。
 * 2026-11-22 日夜间全量清扫（最后一批 22 处一次清完）：画布节点「已禁用」徽标与
 * 「保存会被拒」、ADB 参数表单标签与必填星号、两张 Pilot 卡（建议打开 / 提问）整卡的
 * 浅蓝底、三个调试面板的断言卡底与状态图标、小地图、连线与圆点、冲突弹窗两片 diff 底、
 * 资产树悬停底、通过率环、报告断言勾叉……全部改引 `tpv.*` 或 `tokensFor(mode).*`，实测 **0**。
 * 顺带清掉的还有「野色」那一包（`#F7FAFF`/`#1677ff`/`#5B6670`/`#C4565C`/`#F0FBF6` 等）：
 * 它们不在 Token 表里、本来不计入本棘轮，但正是它们让深色主题下整片浅底不翻相。
 * 基线归零不等于 D48 结案：本棘轮的盲区（写一个与 Token 相近但不相同的值）依旧只能靠 §11.6 对表。
 */
const BASELINE = 0;

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

  it("剥注释只剥注释：代码里的 Token 值一个都不能跟着掉", () => {
    // stripComments 若把字符串也吞了（引号配对错、`://` 误判成行注释），计数会虚降成「零新增」。
    // fixture 把 Token 值放在「该留」的三类位置（字符串 / JSX 裸文本里的 URL / 阴影串）
    // 与「该剥」的两类（行注释 / 跨行块注释）里，只有后两处不计。
    const sample = [
      'const a = "#2BA47D"; // 注释里的 #1D7257 不计',
      'const url = "https://example.com/x"; /* 块注释 #2BA47D',
      "   跨行也算注释 #9A6404 */",
      'const b = { color: "#2BA47D", shadow: "0 12px 32px rgba(16,24,40,.14)" };',
      // JSX 裸文本里的 URL：它在引号之外，靠 `:` 前缀那条判断才不会被误剥。
      "return <Text>文档见 https://ant.design/components/alert 与 #1D7257</Text>;",
    ].join("\n");
    expect(handCopies(sample, vals), "fixture 该数到 4：两个 #2BA47D 加 shadow 加 JSX 文本里的 #1D7257；两处注释不计").toBe(4);
    expect(stripComments(sample).includes("https://example.com/x"), "URL 字符串被当成注释吞了").toBe(true);
    expect(stripComments(sample).includes("ant.design/components/alert"), "JSX 裸文本里的 URL 被当成注释吞了").toBe(true);
    // 正则字面量同一条防线（`adb/commands.ts` 的 `/^https?:\/\/\S+$/` 就是这种形状）。
    // 它天然安全：字面量里想出现连续的 `//` 必须写成 `\/\/`，而那样两个斜杠就不相邻了——
    // 所以「斜杠成对」在真码里只可能是注释。这条断言把这条推理钉住，改写解析器时不会静默破。
    expect(
      handCopies('const URL_RE = /^https?:\\/\\/\\S+$/; const c = "#1D7257"; // 注释里的 #2BA47D', vals),
      "正则字面量里的 \\/\\/ 被当成了行注释，后面的真码跟着掉",
    ).toBe(1);
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
