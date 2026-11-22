// 回收站的出口（§11.4.18）：彻底删除必须输名称确认，删完真的把接口名腾出来。
// 没有这一步，同名接口再也建不出来：软删的行永久占着 uq_apidef_project_name。

import { test, expect } from "@playwright/test";
import { asUser, seedProject } from "./helpers.mjs";

const REQ = { method: "GET", url: "http://127.0.0.1:9999/order/1", body: { type: "none" },
  assertions: [{ type: "status_code", expected: 200 }] };

test("回收站彻底删除：输错名字不放行，删完同名可重建", async ({ page }) => {
  const { token, projectId } = await seedProject(page, "t17彻底删除");
  const made = await asUser(token, "post", "api-definitions", {
    data: { project_id: projectId, name: "查询订单", method: "GET", path: "/order/1", request: REQ } });
  expect(made.ok).toBeTruthy();
  const did = made.body.id;

  await page.goto("/#/api");
  await expect(page.getByTestId("api-row").filter({ hasText: "查询订单" })).toBeVisible();

  // 1) 正常视图里只有「放入回收站」，没有彻底删除——不可逆操作必须先走回收站
  await expect(page.getByTestId("api-purge")).toHaveCount(0);
  await page.getByTestId("api-delete").first().click();
  await page.getByRole("button", { name: "放入回收站" }).click();
  await expect(page.getByTestId("api-row")).toHaveCount(0);

  // 2) 回收站视图：恢复 + 彻底删除 并存
  await page.getByTestId("module-recycled-toggle").click();
  await expect(page.getByTestId("api-row").filter({ hasText: "查询订单" })).toBeVisible();
  await expect(page.getByTestId("api-restore")).toHaveCount(1);
  await page.getByTestId("api-purge").first().click();
  const modal = page.locator(".ant-modal-content");
  await expect(modal).toContainText("无法恢复");
  const ok = page.getByTestId("purge-ok");
  await expect(ok).toBeDisabled();

  // 3) 名称差一个空格都不行（服务端同样硬校验，前端只是少让人白跑一趟）
  await page.getByTestId("purge-confirm").fill("查询订单 ");
  await expect(ok).toBeDisabled();
  await page.getByTestId("purge-confirm").fill("查询订单");
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(page.locator(".ant-modal-content")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("api-row")).toHaveCount(0);

  // 4) 后端事实：回收站空了、名字腾出来了
  const rec = await asUser(token, "get", "api-definitions",
    { params: { project_id: projectId, recycled: "true" } });
  expect(rec.body.items).toEqual([]);
  const again = await asUser(token, "post", "api-definitions", {
    data: { project_id: projectId, name: "查询订单", method: "GET", path: "/order/2" } });
  expect(again.ok).toBeTruthy();
  expect(again.body.id).not.toBe(did);
});
// 模块彻底删除：删的是族谱，接口不陪葬（变未分类）——这条差别只能在 UI 上看清，
// 所以断言点放在「接口还在列表里、且不再属于任何模块」。
test("模块彻底删除：子模块一起消失，接口转为未分类", async ({ page }) => {
  const { token, projectId } = await seedProject(page, "t17模块删除");
  const top = await asUser(token, "post", "api-modules", {
    data: { project_id: projectId, name: "交易链路" } });
  expect(top.ok).toBeTruthy();
  const sub = await asUser(token, "post", "api-modules", {
    data: { project_id: projectId, name: "下单", parent_id: top.body.id } });
  const def = await asUser(token, "post", "api-definitions", {
    data: { project_id: projectId, name: "查询订单", method: "GET", path: "/order/1",
      module_id: sub.body.id, request: REQ } });
  expect(def.ok).toBeTruthy();
  const del = await asUser(token, "post", "api-modules/" + top.body.id + "/delete",
    { data: { project_id: projectId } });
  expect(del.ok).toBeTruthy();

  await page.goto("/#/api");
  await page.getByTestId("module-recycled-toggle").click();
  await expect(page.getByTestId("module-purge-交易链路")).toBeVisible();
  await page.getByTestId("module-purge-交易链路").click();
  const ok = page.getByTestId("module-purge-ok");
  await expect(ok).toBeDisabled();
  await page.getByTestId("module-purge-confirm").fill("交易");
  await expect(ok).toBeDisabled();
  await page.getByTestId("module-purge-confirm").fill("交易链路");
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(page.locator(".ant-modal-content")).toHaveCount(0, { timeout: 15_000 });

  // 回收站空了（父子两层的墓碑一起没了）
  const tree = await asUser(token, "get", "api-modules",
    { params: { project_id: projectId, include_recycled: "true" } });
  expect(tree.body.recycled).toEqual([]);
  expect(tree.body.tree).toEqual([]);

  // 接口没被连带删除，只是没了模块归属
  const got = await asUser(token, "get", "api-definitions/" + def.body.id,
    { params: { project_id: projectId } });
  expect(got.ok).toBeTruthy();
  expect(got.body.module_id).toBeNull();
  await page.getByTestId("module-recycled-toggle").click();
  await expect(page.getByTestId("api-row").filter({ hasText: "查询订单" })).toBeVisible();
});
// 用例回收站：回收 → 恢复 → 再回收 → 彻底删除。
// 后端曾只有 delete（没有 restore），手滑回收一条用例就只能改库捞回来；
// 这条用例同时守住接口与界面两端。
test("用例回收站：能回来，也能彻底删掉", async ({ page }) => {
  const { token, projectId } = await seedProject(page, "t17用例回收");
  const def = await asUser(token, "post", "api-definitions", {
    data: { project_id: projectId, name: "查询订单", method: "GET", path: "/order/1", request: REQ } });
  expect(def.ok).toBeTruthy();
  const made = await asUser(token, "post", "api-cases", {
    data: { project_id: projectId, definition_id: def.body.id, name: "已支付订单" } });
  expect(made.ok).toBeTruthy();

  await page.goto("/#/api");
  await page.getByTestId("api-row").filter({ hasText: "查询订单" }).click();
  const drawer = page.getByTestId("api-detail-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("detail-tab-case").click();
  const row = drawer.getByTestId("case-row").filter({ hasText: "已支付订单" });
  await expect(row).toBeVisible();

  // 回收
  await drawer.getByLabel("回收已支付订单").click();
  await page.getByRole("button", { name: "回 收", exact: true }).click();
  await expect(row).toHaveCount(0);

  // 回收站视图：恢复
  await drawer.getByTestId("case-recycled-toggle").click();
  const ghost = drawer.getByTestId("case-row").filter({ hasText: "已支付订单" });
  await expect(ghost).toBeVisible();
  await expect(drawer.getByTestId("case-new")).toHaveCount(0); // 回收站里不给「新建用例」
  await drawer.getByTestId("case-restore").click();
  await drawer.getByTestId("case-recycled-toggle").click();
  await expect(row).toBeVisible();

  // 再回收 → 彻底删除：名字不对不放行
  await drawer.getByLabel("回收已支付订单").click();
  await page.getByRole("button", { name: "回 收", exact: true }).click();
  await drawer.getByTestId("case-recycled-toggle").click();
  await drawer.getByTestId("case-purge").click();
  const ok = page.getByTestId("case-purge-ok");
  await expect(ok).toBeDisabled();
  await page.getByTestId("case-purge-confirm").fill("已支付");
  await expect(ok).toBeDisabled();
  await page.getByTestId("case-purge-confirm").fill("已支付订单");
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(page.locator(".ant-modal-content")).toHaveCount(0, { timeout: 15_000 });
  await expect(drawer.getByTestId("case-row")).toHaveCount(0);

  // 库里真没了：回收站空、用例 404
  const bin = await asUser(token, "get", "api-cases", {
    params: { project_id: projectId, definition_id: def.body.id, recycled: "true" } });
  expect(bin.body.items).toEqual([]);
  const gone = await asUser(token, "get", "api-cases/" + made.body.id, { params: { project_id: projectId } });
  expect(gone.status).toBe(404);
});

