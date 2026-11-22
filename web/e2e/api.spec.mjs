// 接口管理页（§11.4）：真靶场 :9999，不打假传输——调试真的发 HTTP，徽标才是真的。
import { test, expect } from "@playwright/test";
import { asUser, pickOption, seedProject } from "./helpers.mjs";

test("接口管理页：模块→环境→建接口→真调试→最近结果→回收站往返", async ({ page }) => {
  // 真靶场 + 全量抽屉链路：默认 60s 会卡自己
  test.setTimeout(150_000);
  const { token, projectId } = await seedProject(page, "t14接口");
  await page.goto("/#/api");
  await expect(page.getByTestId("page-api")).toBeVisible();
  // 空态给下一步指引，不是一片空白
  await expect(page.getByText("还没有接口，点右上角新建")).toBeVisible();

  // 1) 模块树建一级模块
  await page.getByTestId("module-create").click();
  await page.getByTestId("module-name").fill("订单模块");
  await page.getByTestId("module-name").press("Enter");
  const tree = page.getByTestId("module-tree");
  await expect(tree.getByText("订单模块", { exact: true })).toBeVisible();

  // 2) 环境下拉里建环境（变量 base_url）；保存后自动选中它
  await page.getByTestId("env-manage").click();
  await page.getByTestId("env-new").click();
  await page.getByTestId("env-name").fill("测试环境");
  await page.getByTestId("env-var-add").click();
  await page.getByTestId("env-var-key-0").fill("base_url");
  await page.getByTestId("env-var-val-0").fill("http://127.0.0.1:9999");
  await page.getByTestId("env-var-add").click();
  await page.getByTestId("env-var-key-1").fill("token");
  await page.getByTestId("env-var-val-1").fill("tk-demo");
  // 公共请求头：靶场要 Bearer，值里再引用 ${token}（环境层变量参与渲染）
  await page.getByRole("tab", { name: /^公共请求头/ }).click();
  await page.getByTestId("env-header-add").click();
  await page.getByTestId("env-header-key-0").fill("Authorization");
  await page.getByTestId("env-header-val-0").fill("Bearer ${token}");
  await page.getByTestId("env-save").click();
  await expect(page.getByTestId("env-item").filter({ hasText: "测试环境" })).toBeVisible();
  await expect(page.getByTestId("env-select")).toContainText("测试环境", { timeout: 10_000 });
  await page.getByTestId("env-close").click();

  // 3) 新建接口：URL 用 ${base_url}，两条断言（状态码 + JSONPath）
  await page.getByTestId("api-new").click();
  await page.getByTestId("def-name").fill("查询订单");
  await page.getByTestId("def-path").fill("/order/{id}");
  await page.getByTestId("req-url").fill("${base_url}/order/1");
  // 断言在独立 Tab（AntD 懒挂载），先切过去
  await page.getByRole("tab", { name: /^断言/ }).click();
  await page.getByTestId("req-assert-add").click();
  await expect(page.getByTestId("req-assert-expected-0")).toHaveValue("200");
  await page.getByTestId("req-assert-add").click();
  await page.getByTestId("req-assert-type-1").click();
  await pickOption(page, "JSON 路径相等");
  await page.getByTestId("req-assert-path-1").fill("$.status");
  await page.getByTestId("req-assert-expected-1").fill("PAID");
  // 变量引用被识别出来：用户不必自己猜哪个变量没配
  await expect(page.getByTestId("def-varref")).toContainText("base_url");

  // 4) 保存 → 列表出现该行，状态「完整」（有请求对象就不再是草稿）
  await page.getByTestId("api-save").click();
  await expect(page.getByTestId("api-row").filter({ hasText: "查询订单" })).toBeVisible();
  await expect(page.getByTestId("api-method").filter({ hasText: "GET" })).toBeVisible();
  await expect(page.getByTestId("api-status").filter({ hasText: "完整" })).toBeVisible();
  await expect(page.getByTestId("run-badge")).toHaveCount(0);

  // 5) 详情抽屉就地调试：真打靶场（环境公共变量参与渲染）
  await page.getByTestId("api-detail").first().click();
  const drawer = page.getByTestId("api-detail-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("detail-run").click();
  await expect(drawer.getByTestId("debug-status")).toHaveText("200", { timeout: 20_000 });
  const cards = drawer.getByTestId("assertion-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("status_code");
  await expect(cards.nth(1)).toContainText("$.status");
  await expect(cards.nth(1)).toContainText("PAID");
  await expect(drawer.getByText("断言全过")).toBeVisible();
  await expect(drawer.getByText("测试环境")).toBeVisible();
  await drawer.getByRole("button", { name: /响应体/ }).click();
  await expect(drawer.getByTestId("debug-body")).toContainText("order_id");

  // 6) 用例 Tab：新建继承用例，数量回填到 Tab 文案
  await drawer.getByTestId("detail-tab-case").click();
  await expect(drawer.getByTestId("case-panel")).toBeVisible();
  await drawer.getByTestId("case-new").click();
  // 用例弹窗挂在 document root 的 portal 上，不在抽屉子树里 → 用 page 定位
  await page.getByTestId("case-name").fill("订单已支付");
  await page.getByRole("button", { name: "创 建" }).click();
  await expect(drawer.getByTestId("case-row").filter({ hasText: "订单已支付" })).toBeVisible();
  await expect(drawer.getByTestId("detail-tab-case")).toContainText("用例(1)", { timeout: 10_000 });
  // 关抽屉走它自己的关闭按钮（Escape 的焦点归属不值得在测试里赌）
  await page.locator(".ant-drawer-open .ant-drawer-close").click();
  await expect(drawer).toBeHidden();

  // 7) 列表「最近结果」= 最近一次状态码
  await page.getByTestId("api-reload").click();
  await expect(page.getByTestId("run-badge").first()).toHaveText("200", { timeout: 15_000 });

  // 8) 回收站往返：进去后正常列表空，恢复后徽标还在
  await page.getByTestId("api-delete").first().click();
  await page.getByRole("button", { name: "放入回收站" }).click();
  await expect(page.getByTestId("api-row")).toHaveCount(0);
  await page.getByTestId("module-recycled-toggle").click();
  await expect(page.getByTestId("api-row").filter({ hasText: "查询订单" })).toBeVisible();
  await page.getByTestId("api-restore").first().click();
  await page.getByTestId("module-recycled-toggle").click();
  await expect(page.getByTestId("api-row").filter({ hasText: "查询订单" })).toBeVisible();
  await expect(page.getByTestId("run-badge").first()).toHaveText("200", { timeout: 15_000 });

  // 9) 后端事实核对：调试记录真的挂在接口名下（徽标的数据来源），且列表不吐大字段
  const defs = await asUser(token, "get", "api-definitions", { params: { project_id: projectId, size: 50 } });
  expect(defs.ok).toBeTruthy();
  const did = defs.body.items[0].id;
  const runs = await asUser(token, "get", "runs", { params: { project_id: projectId, subject_id: did, size: 1 } });
  expect(runs.ok).toBeTruthy();
  expect(runs.body.items.length).toBe(1);
  expect(runs.body.items[0].trigger).toBe("debug");
  expect(runs.body.items[0].status).toBe("passed");
  expect(runs.body.items[0].subject_name).toBe("查询订单");
  expect(runs.body.items[0]).not.toHaveProperty("response_snapshot");
});
