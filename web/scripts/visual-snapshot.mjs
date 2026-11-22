// 设计改版视觉快照：登录 e2e 后端起浏览器，逐页截浅/深两套，并把关键盒子量出来。
//
// 为什么要脚本而不是手工开浏览器：改版验收要靠**同口径对比**——同一个视口、同一套数据、
// 同一批页面。手工截图一换窗口尺寸就失去可比性，而「哪里变丑了」这件事只能靠并排看。
//
// 用法：
//   ① 先起后端（e2e 实例 8321 或 dev 8000）；
//   ② 起前端：构建后 `npx vite preview --port 5173`（本机 dev server 的依赖预构建会被
//      杀软锁 node_modules/.vite，见 README；preview 不走预构建）；
//   ③ `node scripts/visual-snapshot.mjs [baseUrl] [outDir]`
//
// 输出：<outDir>/<page>-<theme>.png + 一行行 JSON 的布局读数（滚动容器高度、页头定位）。
import { chromium, request } from "@playwright/test";
import { mkdirSync } from "node:fs";

const FRONT = process.argv[2] ?? "http://localhost:5173";
const OUT = process.argv[3] ?? ".tmp/snap";
const API = process.env.TP_API ?? "http://127.0.0.1:8321/api/v1";
const ACCOUNT = process.env.TP_ACCOUNT ?? "admin";
const PASSWORD = process.env.TP_PASSWORD ?? "E2e@Pass123";

const PAGES = [
  ["/", "workbench"],
  ["/api", "api"],
  ["/scene", "scenes"],
  ["/datasets", "datasets"],
  ["/ui/elements", "ui-elements"],
  ["/ui/cases", "ui-cases"],
  ["/adb/devices", "adb-devices"],
  ["/adb/cases", "adb-cases"],
  ["/runs", "runs"],
  ["/plans", "plans"],
  ["/reports", "reports"],
  ["/schedules", "schedules"],
  ["/bench", "bench"],
  ["/settings", "settings"],
];

mkdirSync(OUT, { recursive: true });

const ctx = await request.newContext({ baseURL: API + "/" });
const lr = await ctx.post("auth/login", { data: { account: ACCOUNT, password: PASSWORD } });
if (!lr.ok()) throw new Error("登录失败：" + lr.status() + "（先起后端，或用 TP_ACCOUNT/TP_PASSWORD 覆盖）");
const token = (await lr.json()).token;
const pr = await ctx.get("projects?size=200", { headers: { Authorization: "Bearer " + token } });
const project = (await pr.json()).items[0];
if (!project) throw new Error("账号下没有项目：先在工作台建一个再截图");

const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  await page.addInitScript(([t, pj, th]) => {
    localStorage.setItem("tp_token", t);
    localStorage.setItem("tp_project", JSON.stringify(pj));
    localStorage.setItem("tp_theme", th);
  }, [token, project, theme]);
  for (const [path, name] of PAGES) {
    await page.goto(FRONT + "/#" + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
    const m = await page.evaluate(() => {
      const sc = document.querySelector(".tp-main-content");
      const sd = document.querySelector(".tp-sider-scroll");
      const head = document.querySelector(".tp-page-head");
      return {
        docScroll: document.documentElement.scrollHeight,
        winH: innerHeight,
        content: sc ? { sh: sc.scrollHeight, ch: sc.clientHeight } : null,
        sider: sd ? { sh: sd.scrollHeight, ch: sd.clientHeight } : null,
        headPos: head ? getComputedStyle(head).position : null,
      };
    });
    console.log(JSON.stringify({ theme, page: name, ...m, errors: errors.splice(0) }));
  }
  await page.close();
}
await browser.close();