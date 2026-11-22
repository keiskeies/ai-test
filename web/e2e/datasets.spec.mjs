// 数据集页 + 用例编排：CSV 粘贴建数据 → 用例继承接口 → 绑数据集 → 用例调试。
// 数据驱动的真凭据：接口 URL 里的 ${order_id} 只有数据集行能提供，
// 所以「没绑数据集调试报缺变量、绑上就 200」这条对比就是数据驱动生效的铁证。
import { expect, test } from "@playwright/test";
import { asUser, pickOption, seedProject } from "./helpers.mjs";

test("数据集与用例：粘贴两行 → 绑数据 → 调试从缺变量到 200", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "datasets");

  // 环境 + 接口用 API 造：本页要验的是数据集与用例，不是把 T14 的 UI 再跑一遍
  const env = await asUser(token, "post", "envs", { data: {
    project_id: projectId, name: "测试环境", position: 0,
    config: { vars: [["base_url", "http://127.0.0.1:9999"]], headers: [["Authorization", "Bearer tk-demo"]], timeout_ms: 8000 },
  } });
  expect(env.status).toBe(201);
  const def = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: "查询订单", method: "GET", path: "/order/{id}",
    request: {
      method: "GET", url: "${base_url}/order/${order_id}", timeout_ms: 8000,
      assertions: [{ type: "status_code", expected: 200 }],
    },
  } });
  expect(def.status).toBe(201);

  // 1) 数据集页：新建 + 粘贴 2 行（TSV，首行=列头）
  await page.goto("http://127.0.0.1:5173/#/datasets");
  await expect(page.getByTestId("page-datasets")).toBeVisible();
  await expect(page.getByTestId("ds-empty")).toBeVisible();
  await page.getByTestId("ds-new").click();
  await page.getByTestId("ds-name").fill("订单参数");
  await page.getByTestId("ds-paste").click();
  await page.getByTestId("ds-paste-text").fill("order_id\tstatus\n1\tPAID\n2\tNEW");
  await expect(page.getByTestId("ds-paste-preview")).toContainText("2 行");
  await page.getByTestId("ds-paste-confirm").click();
  // 粘贴结果回填到可编辑表格（不是只读预览）：单元格真能改
  await expect(page.getByTestId("ds-cell-0-0")).toHaveValue("1");
  await page.getByTestId("ds-cell-0-1").fill("REFUND");
  await page.getByTestId("ds-save").click();
  await expect(page.getByTestId("ds-row").filter({ hasText: "订单参数" })).toContainText("2 行");

  // 2) 接口抽屉用例 Tab：新建完全继承的用例 + 一条自加断言
  await page.goto("http://127.0.0.1:5173/#/api");
  await page.getByTestId("api-row").filter({ hasText: "查询订单" }).click();
  const drawer = page.getByTestId("api-detail-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("detail-tab-case").click();
  await drawer.getByTestId("case-new").click();
  const modal = page.getByTestId("case-modal");
  await expect(modal).toBeVisible();
  await page.getByTestId("case-name").fill("已支付订单");
  // 继承提示：打开即「完全继承」，改 URL 变「已覆盖」，点恢复继承又回去
  await expect(page.getByTestId("case-hint")).toContainText("完全继承");
  await page.getByTestId("case-url").fill("/tmp/nope");
  await expect(page.getByTestId("case-hint")).toContainText("已覆盖");
  await page.getByTestId("case-unset-url").click();
  await expect(page.getByTestId("case-hint")).toContainText("完全继承");
  await expect(page.getByTestId("case-url")).toHaveValue("${base_url}/order/${order_id}");
  // 自加一条断言（排在接口断言之后 → 调试时共 2 张卡）
  await page.getByRole("tab", { name: /^追加断言/ }).click();
  // 用例自带 0 条断言 → 第一条就是第 0 行；前缀 case- 与接口自己的 req- 编辑器共存
  await page.getByTestId("case-assert-add").click();
  await expect(page.getByTestId("case-assert-expected-0")).toHaveValue("200");
  await page.getByTestId("case-assert-type-0").click();
  await pickOption(page, "JSON 路径相等");
  await page.getByTestId("case-assert-path-0").fill("$.status");
  await page.getByTestId("case-assert-expected-0").fill("PAID");
  await page.getByRole("button", { name: "创 建" }).click();
  const row = drawer.getByTestId("case-row").filter({ hasText: "已支付订单" });
  await expect(row).toBeVisible();

  // 3) 还没绑数据集：${order_id} 无人供给 → 面板里摆着「缺少变量」，不是一闪而过的 toast
  await drawer.getByTestId("case-debug").click();
  const panel = page.getByTestId("case-debug-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("order_id");

  // 4) 编辑用例绑数据集 → 同一行数据把变量补齐 → 200 + 2 张断言卡
  await drawer.getByTestId("case-edit").click();
  await expect(page.getByTestId("case-modal")).toBeVisible();
  await page.getByTestId("case-dataset").click();
  await pickOption(page, "订单参数");
  await page.getByRole("button", { name: "保 存" }).click();
  await expect(drawer.getByTestId("case-dataset-tag")).toContainText("订单参数");
  await drawer.getByTestId("case-debug").click();
  await expect(panel.getByTestId("debug-status")).toHaveText("200");
  await expect(panel.getByTestId("assertion-card")).toHaveCount(2);
  // 响应体默认折叠（一屏先看结论），展开后 PAID 来自靶场真实响应
  await panel.getByRole("button", { name: /响应体/ }).click();
  await expect(panel.getByTestId("debug-body")).toContainText("PAID");

  // 5) 被引用的数据集删不掉：409 文案得指路（先解绑或回收用例）
  await page.goto("http://127.0.0.1:5173/#/datasets");
  const dsRow = page.getByTestId("ds-row").filter({ hasText: "订单参数" });
  await expect(dsRow.getByTestId("ds-usedby")).toContainText("1");
  await dsRow.getByTestId("ds-del").click();
  await page.getByRole("button", { name: "删 除" }).click();
  await expect(page.locator(".ant-message")).toContainText("用例", { timeout: 10_000 });
  await expect(page.getByTestId("ds-row").filter({ hasText: "订单参数" })).toBeVisible();

  // 6) 后端事实：用例最新一次调试 passed，且是数据集首行把变量补齐的
  const cases = await asUser(token, "get", "api-cases?project_id=" + projectId);
  expect(cases.status).toBe(200);
  const c = cases.body.items.find((x) => x.name === "已支付订单");
  expect(c).toBeTruthy();
  expect(c.dataset_id).toBeTruthy();
  // 覆盖层被清空 = 真恢复了继承（request_unset 落库），不是编辑框里看着像
  expect(c.request === null || !c.request.url).toBeTruthy();
  expect(c.assertions.length).toBe(1);
  const runs = await asUser(token, "get",
    "runs?project_id=" + projectId + "&subject_id=" + encodeURIComponent(c.id));
  expect(runs.status).toBe(200);
  expect(runs.body.items.length).toBeGreaterThan(0);
  expect(runs.body.items[0].status).toBe("passed");
  expect(runs.body.items[0].trigger).toBe("debug");
});
