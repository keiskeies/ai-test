// e2e 前置闸门：先确认 dist/ 是**带夹具页**的那份构建，再开跑。
//
// 为什么要有这个文件：playwright 的 5173 是 `vite preview` 直接吃现成 dist/，而
// probe.html（editor.spec 的靶页）现在只在 `vite build --mode e2e` 里进构建入口
// ——生产构建不带它（否则调试页会跟着发布）。于是「先 pnpm build 再 npx playwright test」
// 这种很自然的顺序会让 editor.spec 挂在一次 page.goto 超时上，看起来像编辑器坏了，
// 实际是构建模式不对。缺文件就当场说人话，比让人猜 60 秒便宜得多。
import { existsSync } from "node:fs";
import path from "node:path";

export default function globalSetup() {
  const dist = path.resolve(import.meta.dirname, "..", "dist");
  const missing = ["index.html", "probe.html"].filter((f) => !existsSync(path.join(dist, f)));
  if (missing.includes("index.html")) {
    throw new Error("e2e 需要先构建前端：cd web && pnpm build:e2e（dist/ 下没有 index.html）");
  }
  if (missing.length) {
    throw new Error("dist/ 里没有 probe.html：编辑器回归需要一个带夹具页的构建。"
      + "请用 pnpm build:e2e（或 pnpm e2e，它已包含这一步），不要用 pnpm build。");
  }
}
