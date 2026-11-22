// 蓝图 docs/2026-11-13-ai-test-platform-design.md:1426 后半句「调试失败 → 让 Pilot 分析
// （带响应体）」的浏览器层收口。pilotDraft.spec.mjs 已把「预填不偷发」这条口径在
// 报告详情 / ADB 设备卡两个入口钉死；那个形状是「点击即导航」的纯前端拼装，
// 本文件补的是这一类入口里唯一**结果来自真 HTTP 往返**的：调试面板。
//   ① 真靶场打出真 500 → 面板画「有断言失败」→ 出口出现 → 草稿里 500、断言行、
//      响应体三样都是靶场当场回的真值（不是 jsdom 里的桩）；请求行是编辑器草稿的
//      method+url 逐字，对象名是接口名逐字。
//   ② 「不偷发」按 pilotDraft.spec.mjs:141 的三条一起钉：草稿原封不动在框里、
//      event-card 零张、点击之后 agent 侧零写零开流。注意不能用「零写请求」当证据：
//      POST /api-debug 自己就是 effect="write" 的写，所以写请求的基线在点击前取。
//   ③ 正对照：同一条接口换成必然 200 的 key 再调一次 → 面板「断言全过」且**没有**出口。
//      只钉 ① 的话，「无条件渲染钮」的构建照样绿。
// 期望字符串逐字抄自 web/src/api/debugPilot.ts 现网渲染（断言上方注释给行号）。
import { expect, test } from "@playwright/test";
import { seedProject } from "./helpers.mjs";

const TARGET = "http://127.0.0.1:9999";
const tag = () => Date.now().toString(36);

/**
 * 建接口（编辑器抽屉）→ 填 URL → 加一条状态码断言 → 点抽屉右上「调试」。
 * 走的是草稿调试（POST /api-debug 带 request），蓝图点名的正是这一处。
 * 不建环境：URL 写绝对地址，env_id=null 时后端只叠全局变量（services.py:419-421），
 * 省掉 api.spec.mjs:21-37 那套环境表单——它验的是变量渲染，与本条无关。
 */
async function debugDraft(page, name, url) {
  await page.goto("/#/api");
  await expect(page.getByTestId("page-api")).toBeVisible();
  await page.getByTestId("api-new").click();
  await page.getByTestId("def-name").fill(name);
  await page.getByTestId("req-url").fill(url);
  await page.getByRole("tab", { name: /^断言/ }).click();
  await page.getByTestId("req-assert-add").click();
  await expect(page.getByTestId("req-assert-expected-0")).toHaveValue("200");
  await page.getByTestId("api-debug").click();
}

test("① 草稿调试真吃 500：出口出现，草稿带真状态码/断言行/靶场响应体，且一个字节都没发出去", async ({ page }) => {
  test.setTimeout(150_000);
  const t = tag();
  await seedProject(page, "调试失败问pilot");
  const key = "dbg-pilot-" + t; // /flaky 计数全局-per-key：每次跑唯一（target_app.py:60 的口径）
  const name = "预填验证接口-" + t;
  const url = TARGET + "/flaky?key=" + key + "&fail_first=1";

  await debugDraft(page, name, url);
  const panel = page.getByTestId("debug-panel");
  await expect(panel).toBeVisible();
  // 面板先自证现场是真的：真 500 + 断言没过（靶场第一次必 500，target_app.py:77）
  await expect(panel.getByTestId("debug-status")).toHaveText("500", { timeout: 20_000 });
  await expect(panel.getByTestId("debug-assert-fail")).toBeVisible();
  await expect(panel.getByTestId("debug-assert-pass")).toHaveCount(0);

  // 写请求基线在点击**前**取：/api-debug 自己就是写（services.py:360 effect="write"），
  // 拿「全程零写」当证据会把调试本身算进去，那种断言只能靠假绿通过。
  const agentWrites = [];
  const streams = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.includes("/api/v1/")) return;
    if (r.method() !== "GET" && (u.includes("/agent/") || u.includes("/agent?"))) agentWrites.push(r.method() + " " + u);
    if (u.includes("/api/v1/events/agent/")) streams.push(u);
  });

  const btn = panel.getByTestId("debug-ask-pilot");
  await expect(btn).toHaveText("让 Pilot 分析"); // DebugPanel.tsx:45
  await btn.click();

  await expect(page).toHaveURL(/#\/bench$/);
  await expect(page.getByTestId("bench-status")).toHaveText("未开始"); // 落地瞬间仍是初值：自动发的构建这里已是「运行中」
  await expect(page.getByTestId("bench")).toBeVisible();
  await page.getByTestId("bench-start").click(); // 未武装时输入区不在 DOM（bench.tsx:291 空态）
  const input = page.getByTestId("bench-input");
  await expect(input).toBeVisible();

  const draft = await input.inputValue();
  expect(draft.split("\n")[0]).toBe("这次调试失败了，帮我分析一下原因。"); // debugPilot.ts:68
  expect(draft).toContain("对象：" + name); // :68 ← 接口名逐字
  expect(draft).toContain("请求发出去了，但有断言没过"); // :70（ok=true 分支）
  expect(draft).toContain("状态码：500"); // :72 ← 靶场真回的码
  expect(draft).toContain("请求：GET " + url); // :75 ← 编辑器草稿的 method+url 逐字
  expect(draft).toContain("断言结果（共 1 条）："); // :80
  expect(draft).toContain("1. [败] status_code · 期望 200 · 实际 500"); // :81 + assertions.py:55
  // 「带响应体」是蓝图点名的那半句：靶场的错误信封逐字进草稿，不压成「返回 500」这种结论
  expect(draft).toContain("响应体：");
  expect(draft).toContain("flaky_upstream");
  expect(draft).toContain("设计为失败");
  expect(draft).not.toContain("截断"); // 现场远未超限，不许凭空挂截断标记

  // 预填不偷发（三条一起，pilotDraft.spec.mjs:141 同口径）
  await expect(page.getByTestId("bench-send")).toBeEnabled(); // 钮开着 ≠ 发过
  await expect(input).toHaveValue(draft); // 真发出去 send() 会清空它（bench.tsx:128）
  await expect(page.getByTestId("event-card")).toHaveCount(0);
  expect(agentWrites).toEqual([]);
  expect(streams).toEqual([]);
});

test("② 正对照：断言全过时没有出口——只钉 ① 会放过「无条件渲染钮」的构建", async ({ page }) => {
  test.setTimeout(150_000);
  const t = tag();
  await seedProject(page, "调试通过不问pilot");
  // fail_first=0 → 第一次就 200（target_app.py:74 attempt=1 > 0 不落入失败分支）
  await debugDraft(page, "必过接口-" + t, TARGET + "/flaky?key=ok-" + t + "&fail_first=0");
  const panel = page.getByTestId("debug-panel");
  await expect(panel.getByTestId("debug-status")).toHaveText("200", { timeout: 20_000 });
  await expect(panel.getByTestId("debug-assert-pass")).toBeVisible();
  await expect(panel.getByTestId("debug-ask-pilot")).toHaveCount(0);
});

test("③ 请求根本没发出去（端口没人听）：出口给，草稿说「没拿到响应」而不是编一个状态码", async ({ page }) => {
  test.setTimeout(150_000);
  const t = tag();
  await seedProject(page, "调试连不上问pilot");
  // 127.0.0.1 随机高位端口：connect 立即 ECONNREFUSED，确定且不依赖外网/DNS
  const dead = "http://127.0.0.1:" + (20000 + Math.floor(Math.random() * 40000)) + "/dead";
  await debugDraft(page, "连不上的接口-" + t, dead);
  const panel = page.getByTestId("debug-panel");
  await expect(panel.getByTestId("debug-status")).toHaveText("请求失败", { timeout: 20_000 });
  const btn = panel.getByTestId("debug-ask-pilot");
  await expect(btn).toBeVisible(); // !ok 也是失败现场：蓝图的主场景
  await btn.click();
  await expect(page).toHaveURL(/#\/bench$/);
  await page.getByTestId("bench-start").click();
  const draft = await page.getByTestId("bench-input").inputValue();
  expect(draft).toContain("请求本身失败（没拿到响应）"); // debugPilot.ts:69
  expect(draft).not.toContain("请求发出去了"); // 不许把「没连上」说成「连上了但错了」
  expect(draft).not.toContain("状态码："); // 没有码就别写一行假的
  expect(draft).toContain("响应体：\n（无响应体）"); // :84 的 null 分支
});
