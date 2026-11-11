/**
 * 设计 token 与全站样式 —— **唯一的视觉真相源**。
 *
 * ## 为什么 CSS 在一个 `.ts` 里而不是一个 `.css` 文件
 *
 * 这个前端的加载机制只有一个：**模块图**（浏览器靠 import map 直接跑 dist 里的 ESM，
 * 没有打包器 —— 本机 registry 不可达，装不上 vite/tailwind/antd，见 docs/README 那条"无外网"）。
 * 多一个 `.css` 就多一条加载路径，而在服务端那一侧，**每一条能发文件的路径都是一格风险面**
 * （`packages/server/src/files.ts` 整段讲的就是"每个静态根都要显式枚举 + 限扩展名"）。
 * CSS 走模块图 = 不新增根。代价是没有 CSS 语法高亮与 lint，
 * 换来的是"这个页面能发什么文件"这件事只有一份答案。
 *
 * ## token 分两层是硬要求，不是讲究
 *
 * docs/13 §6 那条"AntD v5 token 是唯一源"在这个仓里的等价物就是这两层：
 *  - **第 1 层**：三档密度与明暗两套**原始值**，只在 `[data-density]` / `[data-theme]` 上出现；
 *  - **第 2 层**：语义名（`--text-1`、`--line`、`--st-pass`…），组件**只许读这一层**。
 *
 * 切档与切暗色因此都是"换第 1 层的值"，组件代码一行不改。反过来写（组件里出现
 * `#15803d`）的后果 docs/13 已经写明：**暗色模式永远补不完**。所以下面组件区
 * 里一个 hex 都没有 —— 这不是风格偏好，是这一格存在的全部理由。
 *
 * ## 三档密度的参数化在 D1 就做（U7）
 *
 * docs/13 §7 U7：「三档 token 必须真正参数化，否则切档会破版 —— 这是"三档"这个功能
 * 的唯一成本，且必须 D1 就参数化（事后补 = 全站刷样式）」。
 * 所以这里的每一个 padding / height / font-size 都读 `--space-*` / `--control-h` / `--font-*`，
 * 没有一个写死的 px。
 */

/** 第 1、2 层 token + 组件样式。由 app.ts 注入 <style>，index.html 里不写一行样式 */
export const CSS = /* css */ `
/* ═══ 第 1 层：密度原始值（三档，默认紧凑）═══ */
/* docs/13 §1 那张表逐格抄过来；改这里 = 改设计，改组件区 = 违规。
   后面那几个 --nav-w / --content-max / --modal-max / --stripe-w / --shadow-modal
   不在原表里，但**同样必须在档位里**：它们是顶栏高、侧栏宽、正文限宽、行色条宽、
   浮层阴影。放在组件区写死的话，宽松档下会出现"36px 的控件挤在 56px 顶栏里、
   正文还是 1100px"那种半切状态 —— U7 说的"切档会破版"就是这么破的。
   判据由 packages/web/test/tokens.test.ts 钉住：组件区一个 px 都不许出现（1px 边框除外）。 */
:root, [data-density="compact"] {
  --control-h: 28px; --row-h: 32px;
  --space-1: 2px; --space-2: 4px; --space-3: 6px; --space-4: 8px; --space-5: 12px; --space-6: 16px;
  --font-1: 12px; --font-2: 13px; --font-3: 15px; --font-4: 18px;
  --radius: 4px;
  --topbar-h: 48px; --nav-w: 176px; --content-max: 1000px; --modal-max: 640px;
  --stripe-w: 3px; --shadow-modal: 0 8px 32px;
}
[data-density="standard"] {
  --control-h: 32px; --row-h: 40px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px;
  --font-1: 13px; --font-2: 14px; --font-3: 16px; --font-4: 20px;
  --radius: 6px;
  --topbar-h: 56px; --nav-w: 208px; --content-max: 1100px; --modal-max: 720px;
  --stripe-w: 3px; --shadow-modal: 0 8px 32px;
}
[data-density="relaxed"] {
  --control-h: 36px; --row-h: 48px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --font-1: 14px; --font-2: 16px; --font-3: 18px; --font-4: 24px;
  --radius: 8px;
  --topbar-h: 64px; --nav-w: 240px; --content-max: 1240px; --modal-max: 840px;
  --stripe-w: 4px; --shadow-modal: 0 12px 40px;
}

/* ═══ 第 1 层：明暗原始值 ═══ */
:root, [data-theme="light"] {
  --bg-0: #ffffff; --bg-1: #f8fafc; --bg-2: #f1f5f9; --bg-3: #e2e8f0;
  --line: #e2e8f0; --line-strong: #cbd5e1;
  --text-1: #0f172a; --text-2: #475569; --text-3: #94a3b8;
  --brand: #1d4ed8; --brand-bg: #eff6ff; --on-brand: #ffffff;
  /* 六态语义色（浅底取深值以满足 4.5:1） */
  --st-pass: #15803d; --st-fail: #b91c1c; --st-error: #c2410c;
  --st-healed: #0e7490; --st-skipped: #475569; --st-triaged: #a16207;
  --st-stale: #6d28d9; --st-running: #1d4ed8;
  --st-pass-bg: #f0fdf4; --st-fail-bg: #fef2f2; --st-error-bg: #fff7ed;
  --st-healed-bg: #ecfeff; --st-skipped-bg: #f1f5f9; --st-triaged-bg: #fefce8;
  --st-stale-bg: #f5f3ff; --st-running-bg: #eff6ff;
  --overlay: rgba(15, 23, 42, .45);
}
[data-theme="dark"] {
  --bg-0: #0b1120; --bg-1: #111827; --bg-2: #1f2937; --bg-3: #334155;
  --line: #1f2937; --line-strong: #374151;
  --text-1: #e5e7eb; --text-2: #9ca3af; --text-3: #6b7280;
  --brand: #60a5fa; --brand-bg: #172554; --on-brand: #0b1120;
  /* 暗底取浅值（同一套语义名的另一半） */
  --st-pass: #4ade80; --st-fail: #f87171; --st-error: #fb923c;
  --st-healed: #22d3ee; --st-skipped: #94a3b8; --st-triaged: #fbbf24;
  --st-stale: #a78bfa; --st-running: #60a5fa;
  --st-pass-bg: #052e16; --st-fail-bg: #450a0a; --st-error-bg: #431407;
  --st-healed-bg: #083344; --st-skipped-bg: #1f2937; --st-triaged-bg: #422006;
  --st-stale-bg: #2e1065; --st-running-bg: #172554;
  --overlay: rgba(0, 0, 0, .6);
}

/* ═══ 第 2 层：语义别名。组件只读这一层（+ 第 1 层的 space/font/radius）═══ */
:root {
  --mono: ui-monospace, "JetBrains Mono", Consolas, monospace;
  --sans: ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
}

/* ═══ 基础 ═══ */
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: var(--font-2)/1.5 var(--sans);
  background: var(--bg-1); color: var(--text-1);
  /* 数字一律 tabular-nums：通过率/耗时/状态码不对齐会显得廉价（docs/13 §1） */
  font-variant-numeric: tabular-nums;
}
code, pre, .mono { font-family: var(--mono); }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { margin: 0; font-weight: 600; }
h1 { font-size: var(--font-4); }
h2 { font-size: var(--font-3); }
h3 { font-size: var(--font-2); }

/* ═══ 布局骨架（docs/13 §3 的控制台骨架）═══ */
.shell { display: flex; flex-direction: column; height: 100%; }
.topbar {
  height: var(--topbar-h); flex: none; display: flex; align-items: center; gap: var(--space-5);
  padding: 0 var(--space-6); background: var(--bg-0); border-bottom: 1px solid var(--line);
}
.topbar .brand { font-weight: 600; font-size: var(--font-3); }
.topbar .grow { flex: 1; }
.body { display: flex; flex: 1; min-height: 0; }
.nav {
  width: var(--nav-w); flex: none; background: var(--bg-0); border-right: 1px solid var(--line);
  padding: var(--space-4) var(--space-3); display: flex; flex-direction: column; gap: var(--space-1);
  overflow: auto;
}
.nav a {
  display: flex; align-items: center; gap: var(--space-3);
  height: var(--control-h); padding: 0 var(--space-4); border-radius: var(--radius);
  color: var(--text-2); font-size: var(--font-2);
}
.nav a:hover { background: var(--bg-2); text-decoration: none; }
.nav a[aria-current="page"] { background: var(--brand-bg); color: var(--brand); font-weight: 600; }
/* 图标不是唯一标识：每条导航都带文字（docs/13 §2 的三重编码） */
.nav .ic { width: var(--font-4); text-align: center; color: var(--text-3); }
.main { flex: 1; min-width: 0; overflow: auto; padding: var(--space-6); }
/* 表格页铺满，内容页限宽（docs/13 §3） */
.main.wrapped > * { max-width: var(--content-max); }

/* ═══ 控件 ═══ */
.btn, select, input, textarea {
  height: var(--control-h); font: inherit; font-size: var(--font-2);
  border: 1px solid var(--line-strong); border-radius: var(--radius);
  background: var(--bg-0); color: var(--text-1); padding: 0 var(--space-4);
}
textarea { height: auto; padding: var(--space-3); resize: vertical; }
.btn { cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-2); }
.btn:hover { background: var(--bg-2); }
.btn.primary { background: var(--brand); color: var(--on-brand); border-color: var(--brand); }
.btn.primary:hover { filter: brightness(1.1); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
/* 分段控件（密度切换用） */
.seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--radius); overflow: hidden; }
.seg button {
  height: calc(var(--control-h) - var(--space-1)); padding: 0 var(--space-4); border: 0;
  background: var(--bg-0); color: var(--text-2); font: inherit; font-size: var(--font-1); cursor: pointer;
}
.seg button[aria-pressed="true"] { background: var(--brand); color: var(--on-brand); }

/* ═══ 卡片：描边分层，不用阴影（docs/13 §1 硬约束 2）═══ */
.card { background: var(--bg-0); border: 1px solid var(--line); border-radius: var(--radius); }
.card > .hd {
  display: flex; align-items: center; gap: var(--space-4);
  padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--line);
}
.card > .bd { padding: var(--space-5); }
.stack { display: flex; flex-direction: column; gap: var(--space-5); }
.row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.muted { color: var(--text-2); }
.dim { color: var(--text-3); font-size: var(--font-1); }
.err-text { color: var(--st-fail); }
.spacer { flex: 1; }

/* ═══ 表格：默认紧凑，行高走 token ═══ */
table { width: 100%; border-collapse: collapse; font-size: var(--font-2); }
th, td { height: var(--row-h); padding: 0 var(--space-5); text-align: left; border-bottom: 1px solid var(--line); }
th { color: var(--text-2); font-weight: 500; background: var(--bg-1); white-space: nowrap; }
th.num, td.num { text-align: right; }
tbody tr:hover { background: var(--bg-1); }
/* 表头不超过 6 字（docs/13 §1 中文排版）由写页面的人负责，这里只保证不因换行崩版 */

/* ═══ 状态徽章：色 + 图标 + 文字 三重编码（docs/13 §2）═══ */
/* 色是**附加**信息。色觉障碍、灰度打印、截图转发三种情况下，图标与文字必须各自成立，
   所以这里的 ::before 与文字**都**来自状态本身，不是可选装饰。 */
.badge {
  display: inline-flex; align-items: center; gap: var(--space-2);
  height: calc(var(--control-h) - var(--space-3)); padding: 0 var(--space-3);
  border-radius: var(--radius); font-size: var(--font-1); font-weight: 600;
  border: 1px solid currentColor; background: var(--bg-0); white-space: nowrap;
}
.badge .bi { font-family: var(--mono); }
.badge[data-s="pass"]    { color: var(--st-pass);    background: var(--st-pass-bg); }
.badge[data-s="fail"]    { color: var(--st-fail);    background: var(--st-fail-bg); }
.badge[data-s="error"]   { color: var(--st-error);   background: var(--st-error-bg); }
.badge[data-s="healed"]  { color: var(--st-healed);  background: var(--st-healed-bg); }
.badge[data-s="skipped"] { color: var(--st-skipped); background: var(--st-skipped-bg); }
.badge[data-s="triaged"] { color: var(--st-triaged); background: var(--st-triaged-bg); }
.badge[data-s="stale"]   { color: var(--st-stale);   background: var(--st-stale-bg); }
.badge[data-s="running"] { color: var(--st-running); background: var(--st-running-bg); }
/* fail 行左侧色条（docs/13 §2 的"附加"那一列；宽度走 --stripe-w，宽松档下更粗一档）。
   healed **刻意不给绿**：自愈当通过是这个平台最不能出现的误读（docs/00 §5.6）。 */
tr[data-s="fail"] td:first-child { box-shadow: inset var(--stripe-w) 0 0 var(--st-fail); }
tr[data-s="error"] td:first-child { box-shadow: inset var(--stripe-w) 0 0 var(--st-error); }
tr[data-s="healed"] td:first-child { box-shadow: inset var(--stripe-w) 0 0 var(--st-healed); }

/* ═══ lint / 校验结果 ═══ */
.issue { display: flex; gap: var(--space-4); padding: var(--space-3) 0; border-bottom: 1px solid var(--line); }
.issue:last-child { border-bottom: 0; }
.issue .lv { font-family: var(--mono); font-weight: 700; width: var(--font-2); flex: none; }
.issue[data-l="error"] .lv { color: var(--st-fail); }
.issue[data-l="warning"] .lv { color: var(--st-triaged); }
.issue .code { font-family: var(--mono); font-size: var(--font-1); color: var(--text-2); }
.issue .fix { color: var(--text-2); font-size: var(--font-1); margin-top: var(--space-1); }
.issue .doc { font-size: var(--font-1); color: var(--text-3); }

/* ═══ JSON / IR 视图 ═══ */
pre.code {
  margin: 0; padding: var(--space-5); background: var(--bg-1); border-radius: var(--radius);
  font-size: var(--font-1); line-height: 1.6; overflow: auto; max-height: 60vh;
  border: 1px solid var(--line); white-space: pre;
}
.kv { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-2) var(--space-5); }
.kv dt { color: var(--text-2); }
.kv dd { margin: 0; }

/* ═══ 空态与错误态：不画插画（docs/13 §7.1 明确不做），只说实话 ═══ */
.empty { padding: var(--space-6); color: var(--text-2); text-align: center; }
.banner {
  padding: var(--space-4) var(--space-5); border-radius: var(--radius);
  border: 1px solid var(--line-strong); background: var(--bg-0);
}
.banner[data-k="error"] { border-color: var(--st-error); background: var(--st-error-bg); color: var(--st-error); }
.banner[data-k="info"] { border-color: var(--brand); background: var(--brand-bg); color: var(--brand); }

/* 浮层才用阴影（docs/13 §1 硬约束 2 的另一半） */
.modal-back { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--bg-0); border-radius: var(--radius); box-shadow: var(--shadow-modal) var(--overlay); max-width: var(--modal-max); max-height: 80vh; overflow: auto; }
`;
