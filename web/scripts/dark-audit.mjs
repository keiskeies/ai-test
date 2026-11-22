// 深色主题白块巡检：在深色下逐页扫「大面积亮背景元素」，把漏改的硬编码 #fff / 浅色底揪出来。
//
// 为什么单独一个脚本：深色下最刺眼的缺陷不是配色不协调，是**一整块白底**——它一眼就能
// 看出「这个组件没进主题」，但人肉翻 17 个页面容易漏。脚本只报「面积够大且亮度够高」的
// 元素，阈值刻在下面（TAG 类小徽标面积小，不会误报）。
//
// 用法（同 visual-snapshot.mjs：先起后端与 preview）：
//   node scripts/dark-audit.mjs [baseUrl]
// 退出码：0 = 干净；1 = 有白块（CI 可直接接）。
import { chromium, request } from "@playwright/test";

const FRONT = process.argv[2] ?? "http://localhost:5173";
const API = process.env.TP_API ?? "http://127.0.0.1:8321/api/v1";
const PAGES = ["/", "/api", "/scene", "/datasets", "/ui/elements", "/ui/cases",
  "/adb/devices", "/adb/cases", "/runs", "/plans", "/reports", "/schedules", "/bench", "/settings"];

const ctx = await request.newContext({ baseURL: API + "/" });
const lr = await ctx.post("auth/login", {
  data: { account: process.env.TP_ACCOUNT ?? "admin", password: process.env.TP_PASSWORD ?? "E2e@Pass123" },
});
if (!lr.ok()) throw new Error("登录失败：" + lr.status());
const token = (await lr.json()).token;
const pr = await ctx.get("projects?size=200", { headers: { Authorization: "Bearer " + token } });
const project = (await pr.json()).items[0];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(([t, pj]) => {
  localStorage.setItem("tp_token", t);
  localStorage.setItem("tp_project", JSON.stringify(pj));
  localStorage.setItem("tp_theme", "dark");
}, [token, project]);

const findings = [];
for (const path of PAGES) {
  await page.goto(FRONT + "/#" + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const hits = await page.evaluate(() => {
    const lum = (c) => {
      const m = c.match(/rgba?\((\d+),?\s*(\d+),?\s*(\d+)/);
      if (!m) return null;
      return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
    };
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      // 只看「叶子」元素：容器大面积亮底通常是子元素铺出来的，报容器没有可操作性
      if (el.children.length > 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 24) continue;
      const cs = getComputedStyle(el);
      const l = lum(cs.backgroundColor);
      if (l !== null && l > 0.8) {
        out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return out.slice(0, 8);
  });
  if (hits.length) findings.push({ path, hits });
}

await browser.close();
if (findings.length === 0) {
  console.log("深色巡检：0 处亮底");
  process.exit(0);
}
console.log(JSON.stringify(findings, null, 2));
console.error("深色巡检：发现 " + findings.reduce((n, f) => n + f.hits.length, 0) + " 处亮底");
process.exit(1);