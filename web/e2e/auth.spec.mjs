import { test, expect } from "@playwright/test";

const uniq = Date.now().toString(36);

test("登录 → 项目列表 → 新建项目 → 切换 → 刷新仍保持", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL("**/login");
  await expect(page.getByRole("heading", { name: /TestPilot/ })).toBeVisible();

  await page.getByTestId("login-account").fill("admin");
  await page.getByTestId("login-password").fill("E2e@Pass123");
  await page.getByTestId("login-submit").click();

  await expect(page).not.toHaveURL(/login/);
  await expect(page.getByTestId("workbench")).toBeVisible();

  const name = "e2e项目-" + uniq;
  await page.getByTestId("project-create").click();
  await page.getByTestId("project-name").fill(name);
  await page.getByTestId("project-name").press("Enter");
  await expect(page.getByTestId("project-list").getByText(name, { exact: true })).toBeVisible();

  const name2 = "e2e项目B-" + uniq;
  await page.getByTestId("project-create").click();
  await page.getByTestId("project-name").fill(name2);
  await page.getByTestId("project-name").press("Enter");
  await page.getByTestId("project-list").getByText(name, { exact: true }).click();

  await expect(page.getByTestId("project-switcher")).toContainText(name);

  await page.reload();
  await expect(page.getByTestId("project-switcher")).toContainText(name);

  await page.getByTestId("user-menu").click();
  await page.getByTestId("logout").click();
  await page.waitForURL("**/login");
});

test("错误口令 → 错误提示，不落工作台", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-account").fill("admin");
  await page.getByTestId("login-password").fill("wrong-password");
  await page.getByTestId("login-submit").click();
  await expect(page.locator(".ant-message")).toContainText(/账号或密码|unauthorized/);
  await expect(page).toHaveURL(/login/);
});
