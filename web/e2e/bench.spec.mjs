// T15 试验台：发消息 → 事件卡按序 → 工具卡展开 → USAGE → 终态；ASK 挂起可中断。
import { test, expect } from "@playwright/test";

const uniq = Date.now().toString(36);

test("Pilot 试验台: fake 模型全流程事件流", async ({ page }) => {
  await page.goto("/#/login");
  await page.getByTestId("login-account").fill("admin");
  await page.getByTestId("login-password").fill("E2e@Pass123");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("workbench")).toBeVisible();

  // 先建一个项目并置为当前（会话需要 project_id）
  await page.getByTestId("project-create").click();
  await page.getByTestId("project-name").fill("bench项目-" + uniq);
  await page.getByTestId("project-name").press("Enter");
  await expect(page.getByTestId("project-list").getByText("bench项目-" + uniq, { exact: true })).toBeVisible();

  await page.goto("/#/bench");
  await expect(page.getByTestId("bench")).toBeVisible();

  // 选择项目 → 建会话
  await page.getByTestId("bench-project-select").click();
  await page.getByText("bench项目-" + uniq, { exact: true }).last().click();
  await page.getByTestId("bench-start").click();

  // 会话就绪：三个选择器 + 输入区出现
  await expect(page.getByTestId("bench-mode-select")).toBeVisible();
  await expect(page.getByTestId("bench-thinking-select")).toBeVisible();
  await expect(page.getByTestId("bench-model-select")).toBeVisible();
  await expect(page.getByTestId("bench-input")).toBeVisible();

  // 发送
  await page.getByTestId("bench-input").fill("帮我建一个查询订单接口");
  await page.getByTestId("bench-send").click();

  // 事件卡按序出现：USER �� 工具 chip（改版：一次工具 = 一条 chip，不再分 TOOL_CALL/TOOL_RESULT 两行）
  const cards = page.getByTestId("event-card");
  await expect(cards.filter({ hasText: "帮我建一个查询订单接口" }).first()).toBeVisible();
  const toolBlock = page.getByTestId("event-card").filter({ has: page.getByTestId("tool-chip") }).first();
  await expect(toolBlock).toBeVisible({ timeout: 15_000 });
  // 徽标下线后口径改由 chip 文案承担：调用动作 + 工具名 + 结果成败在同一行
  await expect(toolBlock).toContainText("调用工具");
  await expect(toolBlock).toContainText(/成功|失败/);

  // 返回结果可展开 JSON（默认折叠，折叠头只写「参数」「返回结果」，不再写事件名）
  await expect(toolBlock).toContainText(/env_list|api_definition_create/);
  await toolBlock.getByTestId("tool-expand").last().click();
  await expect(toolBlock.getByTestId("tool-json")).toBeVisible();

  // USAGE 状态条 + 终态（RUN_END → 回到空闲、中断按钮消失）
  await expect(page.getByTestId("usage-bar").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("bench-status")).toHaveText("空闲", { timeout: 15_000 });
  await expect(page.getByTestId("bench-interrupt")).toHaveCount(0);
});

test("ASK 模式写工具 → 审批卡挂起 → 中断恢复空闲", async ({ page }) => {
  await page.goto("/#/login");
  await page.getByTestId("login-account").fill("admin");
  await page.getByTestId("login-password").fill("E2e@Pass123");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("workbench")).toBeVisible();
  await page.getByTestId("project-create").click();
  await page.getByTestId("project-name").fill("benchASK-" + uniq);
  await page.getByTestId("project-name").press("Enter");
  await expect(page.getByTestId("project-list").getByText("benchASK-" + uniq, { exact: true })).toBeVisible();
  await page.goto("/#/bench");
  await page.getByTestId("bench-project-select").click();
  await page.getByText("benchASK-" + uniq, { exact: true }).last().click();
  await page.getByTestId("bench-start").click();
  // 切 ASK（默认已是 ASK 也无妨）
  await page.getByTestId("bench-mode-select").click();
  await page.getByText("询问（ASK）", { exact: true }).click();
  await page.getByTestId("bench-input").fill("用写工具创建一个接口");
  await page.getByTestId("bench-send").click();
  // fake://basic_two_tools 第二个工具是写类 → ASK 挂起出审批卡
  await expect(page.getByTestId("approval-card").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("bench-status")).toHaveText("等待审批", { timeout: 15_000 });
  // 中断 → 回到空闲
  await page.getByTestId("bench-interrupt").click();
  await expect(page.getByTestId("bench-status")).toHaveText("空闲", { timeout: 15_000 });
});
