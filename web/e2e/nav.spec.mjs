import { test, expect } from "@playwright/test";

const uniq = Date.now().toString(36);

test("1A 导航：路由切换 + 诚实禁用项 + 无项目空态", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-account").fill("admin");
  await page.getByTestId("login-password").fill("E2e@Pass123");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("workbench")).toBeVisible();

  // 未选项目 → 接口管理给引导空态（不演假数据）
  await page.getByTestId("nav-api").click();
  await expect(page).toHaveURL(/#\/api/);
  await expect(page.getByTestId("page-api")).toBeVisible();
  await expect(page.getByTestId("no-project")).toContainText("先在工作台选项目");

  // 去工作台建项目并选中 → 空态消失
  await page.getByTestId("no-project-goto").click();
  await expect(page.getByTestId("workbench")).toBeVisible();
  const name = "e2e-IA-" + uniq;
  await page.getByTestId("project-create").click();
  await page.getByTestId("project-name").fill(name);
  await page.getByTestId("project-name").press("Enter");
  await page.getByTestId("nav-api").click();
  await expect(page.getByTestId("no-project")).toHaveCount(0);

  // 其余开放路由
  await page.getByTestId("nav-datasets").click();
  await expect(page).toHaveURL(/#\/datasets/);
  await expect(page.getByTestId("page-datasets")).toBeVisible();
  await page.getByTestId("nav-runs").click();
  await expect(page).toHaveURL(/#\/runs/);
  await expect(page.getByTestId("page-runs")).toBeVisible();
  // D183 步 6a（2026-11-21）：测试计划解禁（/plans 真页面，testplan 服务面已落地），同法钉。
  await page.getByTestId("nav-plans").click();
  await expect(page).toHaveURL(/#\/plans/);
  await expect(page.getByTestId("page-plans")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("测试计划");
  // D191：缺陷管理真页面（测试跟踪一级）。入口、路由、标题三件同批钉。
  await page.getByTestId("nav-defects").click();
  await expect(page).toHaveURL(/#\/defects/);
  await expect(page.getByTestId("page-defects")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("缺陷管理");
  // D193：功能用例本体解禁；D194 用例评审入口同批钉。
  await page.getByTestId("nav-cases").click();
  await expect(page).toHaveURL(/#\/functional\/cases/);
  await expect(page.getByTestId("page-functional-cases")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("功能用例");
  await page.getByTestId("nav-reviews").click();
  await expect(page).toHaveURL(/#\/reviews/);
  await expect(page.getByTestId("page-case-reviews")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("用例评审");
  await page.getByTestId("nav-files").click();
  await expect(page).toHaveURL(/#\/files/);
  await expect(page.getByTestId("page-files")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("文件管理");
  await page.getByTestId("nav-task-center").click();
  await expect(page).toHaveURL(/#\/task-center/);
  await expect(page.getByTestId("page-task-center")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("任务中心");
  await page.getByTestId("nav-mock").click();
  await expect(page).toHaveURL(/#\/mock/);
  await expect(page.getByTestId("page-mock")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("API Mock");
  await page.getByTestId("nav-settings").click();
  await expect(page).toHaveURL(/#\/settings/);
  await expect(page.getByTestId("page-settings")).toBeVisible();

  // 1B 解锁：场景编排 / 报告中心（页面主体由 T17/T22 交付，占位页也钉同样的
  // testid + 标题，替换时断言不放宽；.tp-page-title 即 PageHead 渲染的标题）
  await page.getByTestId("nav-scene").click();
  await expect(page).toHaveURL(/#\/scene/);
  await expect(page.getByTestId("page-scene")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("场景编排");
  await page.getByTestId("nav-reports").click();
  await expect(page).toHaveURL(/#\/reports/);
  await expect(page.getByTestId("page-reports")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("报告中心");

  // 1C 解锁（T13）：元素库 / UI 用例导航解禁，页面主体由 T14/T17 填充，
  // 骨架页也钉同样的 testid + 标题，替换时断言不放宽（与 1B 占位页同一手法）
  await page.getByTestId("nav-ui-elements").click();
  await expect(page).toHaveURL(/#\/ui\/elements/);
  await expect(page.getByTestId("page-ui-elements")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("元素库");
  await page.getByTestId("nav-ui-cases").click();
  await expect(page).toHaveURL(/#\/ui\/cases/);
  await expect(page.getByTestId("page-ui-cases")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("UI 用例");

  // 1D 解锁（T9）：设备管理 / ADB 用例都开真页面。骨架期也钉同样的 testid + 标题，
  // 与 1B/1C 占位页同一手法。
  await page.getByTestId("nav-adb-devices").click();
  await expect(page).toHaveURL(/#\/adb\/devices/);
  await expect(page.getByTestId("page-adb-devices")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("设备管理");

  // T9：ADB 用例页解禁（T7 端点已交付），点了要真跳。
  await page.getByTestId("nav-adb-cases").click();
  await expect(page).toHaveURL(/#\/adb\/cases/);
  await expect(page.getByTestId("page-adb-cases")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("ADB 用例");

  // 1E 补记：通知渠道页解禁（后端 1efaf08 落地），同法钉 testid + 标题。
  await page.getByTestId("nav-notify").click();
  await expect(page).toHaveURL(/#\/notify\/channels/);
  await expect(page.getByTestId("page-notify-channels")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("通知渠道");

  // 1E 补记：定时任务页解禁（§11.4.17，schedule 服务面落地），点了要真跳，同法钉。
  await page.getByTestId("nav-cron").click();
  await expect(page).toHaveURL(/#\/schedules/);
  await expect(page.getByTestId("page-schedules")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("定时任务");
});

// 批次标注对回蓝图 §14（ledger R69）。这批文案是**只有 Tooltip 才看得见**的一句话，
// 改错了没人会点进去发现——所以钉在 e2e 里。曾经错过三处：定时任务写「三期」（蓝图 1E）、
// 通知渠道写「二期」（蓝图 1E）、工作台「让 Pilot 生成」写「1A 起开放」
// （把 1F 的活说成早已交付，比标错批次更严重：那是假承诺）。
// T13 起 UI 测试两项（元素库/UI 用例）已解禁：Tooltip 与 note 一起删了，这里不再断言。
test("诚实标注：禁用项的批次文案与蓝图一致", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-account").fill("admin");
  await page.getByTestId("login-password").fill("E2e@Pass123");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("workbench")).toBeVisible();

  // 1E 补记：定时任务已开真页面（/schedules），note 与 Tooltip 一起删了，同 notify 的处理，不再断言。
  // 1E 补记：通知渠道已开真页面（/notify/channels），note 与 Tooltip 一起删了，不再断言。
  // D183 步 6a（2026-11-21）：测试计划已开真页面（/plans），note 与 Tooltip 一起删了，
  // 同 schedules/notify 的处理，不再断言——入口与断言同批翻（下方 wb-pilot-generate 同款纪律），
  // 真页面的存在性由本文件 test 1 的 page-plans 四步钉住，不在这条断言里换新文案。
  // D265/D266：MCP 与 Skills 都已交付（/settings/mcp、/settings/skills 真入口），
  // 二期哨兵清零——入口与断言同批翻，别让已交付项继续挂「未开放」。
  await expect(page.getByTestId("nav-mcp")).toBeEnabled();
  await expect(page.getByTestId("nav-skills")).toBeEnabled();
  // D193：功能用例已解禁，灰项断言随入口同批摘除（真页面存在性由 test 1 钉住）。
  // T9 起设备管理 / ADB 用例都已解禁（真路由 /adb/devices、/adb/cases），
  // note 与 Tooltip 一起删了，这里不再断言。
  // 1F T6 兑现：工作台「让 Pilot 生成」哨兵翻真——不再 disabled，点了真跳 /bench。
  // 当年钉它是防「1A 起开放」式假承诺（ledger R69）；入口与断言同批翻，不许分两次提交。
  const pilot = page.getByTestId("wb-pilot-generate");
  await expect(pilot).toBeEnabled();
  await pilot.click();
  await expect(page).toHaveURL(/#\/bench/);
  await expect(page.getByTestId("bench")).toBeVisible();
});

