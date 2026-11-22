// 运行记录页（§11.4.26）：真调试真发请求，记录页只是那三次运行的档案。
// 三种状态各造一条（通过 / 断言失败 / 请求失败），筛选才有东西可验——只有一条通过记录
// 的测试等于什么都没测。
import { test, expect } from "@playwright/test";
import { asUser, insertRunDirect, seedProject, wallClock } from "./helpers.mjs";

// 靶场 /order/{id} 要 Bearer（与 api.spec.mjs 的靶场契约一致）
const AUTH = [["Authorization", "Bearer tk-demo"]];

const TARGET = "http://127.0.0.1:9999";

/** 清掉 AntD Select 的选中值：clear 图标只在 hover 时出现，先 hover 再点。 */
async function clearFilter(page, testid) {
  const box = page.getByTestId(testid);
  await box.hover();
  await box.locator(".ant-select-clear").click();
}

async function debug(token, projectId, body) {
  return asUser(token, "post", "api-debug", { data: { project_id: projectId, ...body } });
}

test("运行记录：三种状态入表 → 筛选 → 详情抽屉与调试页同一套渲染", async ({ page }) => {
  test.setTimeout(150_000);
  const { token, projectId } = await seedProject(page, "t16运行");

  // 1) 通过：真打靶场 + 两条断言全过
  const ok = await debug(token, projectId, {
    request: { method: "GET", url: TARGET + "/order/1", headers: AUTH,
      assertions: [{ type: "status_code", expected: 200 },
        { type: "json_path_equals", path: "$.status", expected: "PAID" }] },
  });
  expect(ok.status).toBe(200);
  expect(ok.body.passed).toBeTruthy();
  const passedRunId = ok.body.run_id;

  // 2) 断言失败：请求成功但期望值对不上
  const bad = await debug(token, projectId, {
    request: { method: "GET", url: TARGET + "/order/1", headers: AUTH,
      assertions: [{ type: "json_path_equals", path: "$.status", expected: "REFUNDED" }] },
  });
  expect(bad.status).toBe(200);
  expect(bad.body.passed).toBeFalsy();

  // 3) 请求失败：端口没人听，立刻 connection refused（不赌外网）
  const err = await debug(token, projectId, {
    request: { method: "GET", url: "http://127.0.0.1:1/nope", assertions: [] },
  });
  expect(err.status).toBe(200);
  expect(err.body.ok).toBeFalsy();

  // 4) 进页面：三条都在，触发来源是「调试」
  await page.goto("/#/runs");
  await expect(page.getByTestId("page-runs")).toBeVisible();
  await expect(page.getByTestId("run-row")).toHaveCount(3, { timeout: 15_000 });
  const rows = page.getByTestId("run-row");
  await expect(page.getByTestId("run-trigger")).toHaveCount(3);
  await expect(page.getByTestId("run-trigger").first()).toContainText("调试");
  // 三种状态各一条：按集合比，别按 sort() 比（JS 默认按 UTF-16 码元排序，跟中文顺序无关）
  const statuses = (await page.getByTestId("run-status").allInnerTexts()).sort();
  expect(new Set(statuses)).toEqual(new Set(["断言失败", "通过", "请求失败"]));
  expect(statuses.length).toBe(3);
  // 时间列必须是**换过算**的时刻，不是截断的 UTC 钟点（R68）。
  // 逐行拿后端那条的 created_at 独立换算成东八区墙钟再比：形状正则测不出早 8 小时，
  // 所以这里比的是具体钟点（helper wallClock 在 e2e 侧独立实现，不复用被测的 timefmt）。
  const apiRuns = await asUser(token, "get", "runs", { params: { project_id: projectId } });
  expect(apiRuns.status).toBe(200);
  const createdById = Object.fromEntries(apiRuns.body.items.map((r) => [r.id, r.created_at]));
  for (let i = 0; i < 3; i += 1) {
    const row = rows.nth(i);
    const runId = await row.getAttribute("data-run-id");
    expect(createdById[runId], "列表里这条在 API 侧找不到: " + runId).toBeTruthy();
    const utc = createdById[runId];
    const shown = await row.getByTestId("run-time").innerText();
    expect(shown).toBe(wallClock(utc));
    // 老写法 `slice(0,19).replace("T"," ")` 画的是 UTC 钟点。加 8 小时永远得到另一个墙钟串，
    // 所以这条不等式恒成立——它才是 R68 的真正守卫：谁退回截断，这里立刻红。
    expect(shown).not.toBe(utc.slice(0, 19).replace("T", " "));
  }

  // 5) 状态筛选：只剩请求失败那条，且带得上失败原因
  await page.getByTestId("runs-filter-status").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "请求失败" }).first().click();
  await expect(page.getByTestId("run-row")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("run-status")).toHaveText("请求失败");
  await expect(page.getByTestId("run-code")).toHaveText("—");

  // 6) 清掉状态筛选，再按触发方式筛：全是 debug → 一条不少；换成 Pilot → 一条不剩
  await clearFilter(page, "runs-filter-status");
  await expect(page.getByTestId("run-row")).toHaveCount(3, { timeout: 10_000 });
  // 筛选项必须与后端 pattern 同源（shared/runVocab + runVocab.test.ts 钉数据源，这里钉页面真用上没）：
  // 「用例」是老页面的本地词表里有的、后端 422 拒绝的取值——用户一选就演成「记录没取到」。
  await page.getByTestId("runs-filter-trigger").click();
  const triggerOpts = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option");
  await expect(triggerOpts).toHaveCount(4);
  await expect(triggerOpts.filter({ hasText: "用例" })).toHaveCount(0);
  // D82：webhook 是 reserved（零写入方，/hook/run/{token} 还不存在）——点了必是空表 = 假门，
  // 所以筛选项里不许出现它，徽标那边才查全表（口径见 shared/runVocab.ts:30 与 reports.tsx TriggerTag）。
  // 业主批准 D82 且 run-hook 真落地那天：删掉这条、个数改回 5（reserved 一撤下拉自动回来）。
  await expect(triggerOpts.filter({ hasText: "Webhook" })).toHaveCount(0);
  await expect(triggerOpts.filter({ hasText: "手动" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByTestId("runs-filter-trigger").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "Pilot" }).first().click();
  await expect(page.getByTestId("run-row")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("runs-empty-hint")).toBeVisible();

  // 7) 清掉触发筛选，打开「通过」那条的详情：请求快照 + 两条断言卡 + 响应体
  await clearFilter(page, "runs-filter-trigger");
  await expect(page.getByTestId("run-row")).toHaveCount(3, { timeout: 10_000 });
  const passRow = page.getByTestId("run-row")
    .filter({ has: page.getByTestId("run-status").filter({ hasText: "通过" }) }).first();
  await passRow.getByTestId("run-detail").click();
  const drawer = page.getByTestId("run-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("run-request")).toContainText("/order/1");
  await expect(drawer.getByTestId("debug-status")).toHaveText("200");
  const cards = drawer.getByTestId("assertion-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toContainText("$.status");
  await drawer.getByRole("button", { name: /响应体/ }).click();
  await expect(drawer.getByTestId("debug-body")).toContainText("order_id");
  await page.locator(".ant-drawer-open .ant-drawer-close").click();
  await expect(drawer).toBeHidden();

  // 8) 后端事实核对：详情里的断言明细来自库里那份快照，不是前端现编的
  const d = await asUser(token, "get", "runs/" + passedRunId, { params: { project_id: projectId } });
  expect(d.ok).toBeTruthy();
  expect(d.body.status).toBe("passed");
  expect(d.body.assertions.length).toBe(2);
  expect(d.body.response_snapshot.status).toBe(200);
  expect(d.body.trigger).toBe("debug");
});

// 1C T11（R112）：UI 运行进列表必须被诚实贴标。
// ui_case 的**执行**（T7-T10）与本页并行开发，这里按后端同款约定直插 run 行
// （helpers.insertRunDirect），测的是列表页的读侧语义，不是执行链。
test("运行记录：ui_case 标签是「UI 用例」不是「接口」；未知类型渲染原文；对象类型筛选可用", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t11ui标签");
  const uiRun = insertRunDirect({ project_id: projectId, subject_type: "ui_case",
    subject_name: "UI登录冒烟" });
  const weirdRun = insertRunDirect({ project_id: projectId, subject_type: "xxx",
    subject_name: "遗留类型xxx" });
  const apiRun = insertRunDirect({ project_id: projectId, subject_type: "api_case",
    subject_name: "下单用例" });

  await page.goto("/#/runs");
  await expect(page.getByTestId("page-runs")).toBeVisible();
  await expect(page.getByTestId("run-row")).toHaveCount(3, { timeout: 15_000 });

  const tagOf = (name) => page.getByTestId("run-row")
    .filter({ has: page.getByTestId("run-subject").filter({ hasText: name }) })
    .getByTestId("run-subject-type");

  // ④ ui_case 必须说「UI 用例」；老二值三元会把它贴成「接口」——那是主动说错
  await expect(tagOf("UI登录冒烟")).toHaveText("UI 用例");
  await expect(tagOf("UI登录冒烟")).not.toHaveText("接口");
  // ⑥ 词表外的值渲染原文：宁可生码，不可回落成「接口」
  await expect(tagOf("遗留类型xxx")).toHaveText("xxx");
  await expect(tagOf("遗留类型xxx")).not.toHaveText("接口");
  // 回归钉：api_case 仍是「用例」（词表替换没把老值弄丢）
  await expect(tagOf("下单用例")).toHaveText("用例");

  // 对象类型筛选：选「UI 用例」只剩那条（后端 where 真生效，不是前端装筛）
  await page.getByTestId("runs-filter-subject-type").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "UI 用例" }).first().click();
  await expect(page.getByTestId("run-row")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("run-subject")).toHaveText("UI登录冒烟");

  // 库里事实：筛选走的是后端 where，不是前端过滤
  const r = await asUser(token, "get", "runs", { params: { project_id: projectId, subject_type: "ui_case" } });
  expect(r.status).toBe(200);
  expect(r.body.items.map((x) => x.id)).toEqual([uiRun.run_id]);
  expect([uiRun.run_id, weirdRun.run_id, apiRun.run_id]).toHaveLength(3);
  // 非法值 422（词表同后端 pattern）。1D T7 起 adb_case 已进词表（R112 的同课重演：
  // 「adb_case」在这个断言里曾经是非法示例，现在它是合法值），示例值换成真野值。
  const bad = await asUser(token, "get", "runs", { params: { project_id: projectId, subject_type: "bogus_type" } });
  expect(bad.status).toBe(422);
  // adb_case 必须收：不收就是「ADB 运行出现在列表里却筛不出来」（后端 pattern 与
  // shared/runVocab 同源，runVocab.test.ts 钉两端，这条钉 HTTP 面真的放行）
  const adb = await asUser(token, "get", "runs", { params: { project_id: projectId, subject_type: "adb_case" } });
  expect(adb.status).toBe(200);
  expect(adb.body.items).toHaveLength(0);
});
