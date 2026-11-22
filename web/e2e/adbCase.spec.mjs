// 1D T9：ADB 用例页（列表 + 步骤编辑器 + 调试面板）的 e2e。
// ✅ 本文件**跑过**（T11 门禁轮，CI 形状 79 passed / 2 skipped 里含这四条）。写它时标的是
// 「未跑」，那段时间攒出来的 7 条红就是「写而未跑」的代价（R145 ⑥）：步骤参数一度写在行顶层，
// 而 §7.3/`commands.CFG_SCHEMA` 要 `{id, type, device, config:{…}}`——现在按规范形状走。
//
// 覆盖（对应计划 T9 的两条钉点）：
// ① 步骤编辑器参数随类型切换（§11.4.12「与 UI 用例共用编辑器」的 ADB 侧兑现）：
//    加「连接设备」→ 出 addr 控件；切「点击坐标」→ 参数块换成 x/y（切类型清脏值）；
//    保存 → 库里 steps 就是屏幕上那两条；
// ② 设备策略（§11.5.5）：任一空闲 ⇄ 指定设备；列表「默认设备」列两态同步；
// ③ 调试面板的诚实形状：项目里没有登记设备时点调试 → 后端 422 原话直出
//    （「项目里没有任何启用且未回收的 ADB 设备」），面板说「调试没有发起」，
//    不演半截结论、全页不出现「预计」类估算（D17）。
//    假设备下的真跑（mode=u2/dump、截图内联）归 T10 的混合场景 DoD——那要接
//    fake adb 的 webServer 注入（adbDevice.spec.mjs 头注的同款边界）。
// ④ 回收站：删除 → 回收站视图恢复 → 彻底删除要逐字输名。
import { expect, test } from "@playwright/test";
import { asUser, pickOption, seedProject } from "./helpers.mjs";

const APP = "http://127.0.0.1:5173";

async function addStep(page, typeName) {
  await page.getByTestId("cmd-add").click();
  await page.getByTestId("cmd-add").locator("input").type(typeName);
  await pickOption(page, typeName);
}

test("① 建用例：connect + click_xy 两种参数形态 → 保存 → 库里 steps 是屏幕上这两条", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9case-crud");
  await page.goto(APP + "/#/adb/cases");
  await expect(page.getByTestId("page-adb-cases")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("ADB 用例");
  await page.getByTestId("adb-case-new").click();
  await expect(page).toHaveURL(/#\/adb\/cases\/new$/);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();

  await page.getByTestId("case-name").fill("连机点一下");
  // 「连接设备」：参数 = addr（CFG_SCHEMA 的 text 控件）
  await addStep(page, "连接设备");
  await page.getByTestId("cmdp-0-addr").fill("127.0.0.1:5555");
  // 「坐标点击」：参数块切成 x/y——上一行的 addr 控件必须消失（参数随类型切换）
  await addStep(page, "坐标点击");
  await expect(page.getByTestId("cmdp-1-x")).toBeVisible();
  await expect(page.getByTestId("cmdp-1-addr")).toHaveCount(0);
  await page.getByTestId("cmdp-1-x").fill("300");
  await page.getByTestId("cmdp-1-y").fill("800");
  // 行摘要（summary()）认得这两型
  await expect(page.getByTestId("cmd-row").nth(0)).toContainText("127.0.0.1:5555");

  await page.getByTestId("adb-case-save").click();
  await expect(page).not.toHaveURL(/\/new$/);
  const m = await page.evaluate(() => location.hash.match(/cases\/([^/?]+)/)[1]);
  const detail = await asUser(token, "get", "adb-cases/" + m + "?project_id=" + projectId);
  expect(detail.status).toBe(200);
  expect(detail.body.steps.map((s) => s.type)).toEqual(["connect", "click_xy"]);
  // §7.3 规范形状：参数收在 config 里（`{id, type, device, config:{…}}`），不在行顶层
  expect(detail.body.steps[0].config.addr).toBe("127.0.0.1:5555");
  expect(String(detail.body.steps[1].config.x)).toBe("300");

  // 刷新仍在（库是真相）
  await page.reload();
  await expect(page.getByTestId("cmd-row")).toHaveCount(2);
});

test("② 设备策略：指定设备存 serial、列表列同步；切回任一空闲清引用", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9case-policy");
  // 设备走 API 造不了（先 connect 验证入库，CI 无 adb——adbDevice.spec 头注同款边界），
  // 但 default_device 存期不校验存在性（§4.5）：直接存一个未登记 serial，
  // 界面必须亮「设备未登记」而不是假装它存在。
  await page.goto(APP + "/#/adb/cases");
  await page.getByTestId("adb-case-new").click();
  await page.getByTestId("case-name").fill("指定一台");
  await addStep(page, "连接设备");
  await page.getByTestId("cmdp-0-addr").fill("10.77.0.9:5555");
  await page.getByTestId("case-device-policy").getByText("指定设备").click();
  // 项目里没有登记设备：下拉空态指路设备管理，不假装有机器
  await page.getByTestId("case-device").click();
  await expect(page.locator(".ant-select-dropdown").last())
    .toContainText("设备管理里先添加");
  // 手输不了（Select 无自由输入）——那就走 API 直存 serial，UI 侧验读取与标签
  const c = await asUser(token, "post", "adb-cases", { data: {
    project_id: projectId, name: "指定一台-API", priority: "P2",
    steps: [{ id: "a1", type: "connect", config: { addr: "10.77.0.9:5555" } }],
    default_device: "10.77.0.9:5555",
  } });
  expect(c.status).toBe(201);
  // 再造一条不指定设备的：列表两态要同屏
  const free = await asUser(token, "post", "adb-cases", { data: {
    project_id: projectId, name: "任一空闲-API", priority: "P2",
    steps: [{ id: "a1", type: "connect", config: { addr: "10.77.0.8:5555" } }],
  } });
  expect(free.status).toBe(201);
  await page.goto(APP + "/#/adb/cases/" + c.body.id);
  await expect(page.getByTestId("adb-case-device-unbound")).toBeVisible();
  // 列表页的「默认设备」列：一行「任一空闲」、一行 serial
  await page.goto(APP + "/#/adb/cases");
  await expect(page.getByTestId("adb-case-row-device").filter({ hasText: "任一空闲" })).toBeVisible();
  await expect(page.getByTestId("adb-case-row-device").filter({ hasText: "10.77.0.9:5555" })).toBeVisible();
});

test("③ 没登记设备就调试：422 原话进「调试没有发起」，不演半截结论、无「预计」（D17）", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9case-debug");
  const c = await asUser(token, "post", "adb-cases", { data: {
    project_id: projectId, name: "无设备调试", priority: "P2",
    steps: [{ id: "a1", type: "connect", config: { addr: "127.0.0.1:5555" } }],
  } });
  expect(c.status).toBe(201);
  await page.goto(APP + "/#/adb/cases/" + c.body.id);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();
  await page.getByTestId("adb-case-debug").click();
  const panel = page.getByTestId("adb-debug-panel");
  await expect(panel).toBeVisible();
  // 后端 debug_services.py 的原话（422「项目里没有任何启用且未回收的 ADB 设备」）
  await expect(panel.getByText("调试没有发起")).toBeVisible();
  await expect(panel).toContainText("ADB 设备");
  // 没有结果却画了步骤时间线 = 半截结论，红
  await expect(page.getByTestId("adb-debug-step-row")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("预计");
  // 调试（trigger=debug）不落「最近结果」：回列表仍是「未运行」
  await page.goto(APP + "/#/adb/cases");
  await expect(page.getByRole("row").filter({ hasText: "无设备调试" })).toContainText("未运行");
});

test("④ 回收站三件套：删除 → 恢复 → 彻底删除要逐字输名", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t9case-recycle");
  const c = await asUser(token, "post", "adb-cases", { data: {
    project_id: projectId, name: "回收对象", priority: "P2",
    steps: [{ id: "a1", type: "connect", config: { addr: "127.0.0.1:5555" } }],
  } });
  expect(c.status).toBe(201);

  await page.goto(APP + "/#/adb/cases");
  const row = page.getByRole("row").filter({ hasText: "回收对象" });
  await expect(row).toBeVisible();
  await row.getByTestId("adb-case-del").click();
  await page.getByTestId("adb-case-del-ok").click();
  await expect(row).toHaveCount(0);

  // 回收站视图：恢复 → 主列表回来
  await page.getByTestId("adb-case-recycled").click();
  await expect(page.getByTestId("adb-case-restore-" + c.body.id)).toBeVisible();
  await page.getByTestId("adb-case-restore-" + c.body.id).click();
  await expect(page.getByTestId("adb-case-restore-" + c.body.id)).toHaveCount(0);
  await page.getByTestId("adb-case-recycled").click(); // 退出回收站
  await expect(row).toBeVisible();

  // 彻底删除：名字没输对之前按钮不放行；输对后物理删、列表消失
  await row.getByTestId("adb-case-del").click();
  await page.getByTestId("adb-case-del-ok").click();
  await page.getByTestId("adb-case-recycled").click();
  await page.getByTestId("adb-case-purge-" + c.body.id).click();
  const ok = page.getByTestId("adb-case-purge-ok");
  await expect(ok).toBeDisabled();
  await page.getByTestId("adb-case-purge-confirm").fill("回收对象");
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(page.getByTestId("adb-case-purge-" + c.body.id)).toHaveCount(0);
  const gone = await asUser(token, "get", "adb-cases/" + c.body.id + "?project_id=" + projectId);
  expect(gone.status).toBe(404);
});
