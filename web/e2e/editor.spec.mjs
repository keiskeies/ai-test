// T16 Monaco 探针固化成的长期回归：编辑器离线自托管 + Playwright 可定位可输入。
// 靶页是构建内独立夹具 /probe.html（probe.html + src/probe.tsx，不进产品导航/路由）。
// 存在理由：内网部署禁止任何 CDN——本 spec 拦截全部请求，非本机请求直接 abort 并记名。
import { test, expect } from "@playwright/test";

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

test("Monaco 自托管回归：零 CDN + 可定位 + 可输入 + worker 高亮", async ({ page }) => {
  const external = [];
  const workerUrls = [];
  const pageErrors = [];
  page.on("worker", (w) => workerUrls.push(w.url()));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (!LOCAL.test(url)) {
      external.push(url);
      return route.abort();
    }
    return route.continue();
  });

  await page.goto("/probe.html");

  // ④ 定位手法：外壳用 testid，编辑器主体用 Monaco 固定 DOM 类 .monaco-editor
  const shell = page.getByTestId("code-editor");
  await expect(shell.locator(".monaco-editor")).toBeVisible();

  // ③ worker 来自本包产物（离线语言服务真的在跑，不是静默回退 CDN）
  await expect
    .poll(() => workerUrls.some((u) => /json\.worker-[\w-]+\.js/.test(u)), {
      message: "json worker 应从本地产物拉起",
    })
    .toBe(true);
  for (const u of workerUrls) expect(LOCAL.test(u), `worker 非本机: ${u}`).toBeTruthy();

  // ④ 输入：点进视图 → 全选 → 插入新内容（insertText 绕开 Monaco 自动补全引号/括号，
  // 逐键 type 会把 {" 变成 {"" 这类补全残渣）；onChange 回流 probe-value 证明链路通
  const typed = '{"ok": 42}';
  await shell.locator(".monaco-editor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(typed);
  await expect(page.getByTestId("probe-value")).toHaveText(typed);

  // 高亮：token span 里出现非默认样式类（mtk1 是纯文本），说明 tokenizer 在工作
  await expect(shell.locator(".view-lines span[class*='mtk']:not(.mtk1)").first()).toBeVisible();

  // ③ 零 CDN 硬断言 + 无未捕获异常（worker 创建失败会以 console/pageerror 现形）
  expect(external, `出现非本机请求: ${external.join(", ")}`).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
