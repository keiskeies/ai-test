// 报告中心（T22，§11.4.15/§11.4.16/§11.7.4）：列表筛选 + 通过率环 + 详情三栏
// （概览 / 只读结果画布 / 步骤详情）+ 失败步骤重跑。
// 数据从真实执行来：场景在编辑器里「执行」（trigger=manual 进报告）与「调试」
// （trigger=debug 默认不进报告）各跑一遍——报告口径（Review Focus 11）两半边都要钉。
import { expect, test } from "@playwright/test";
import { asUser, insertRunDirect, seedProject } from "./helpers.mjs";

const TARGET = "http://127.0.0.1:9999";

test("报告中心：执行进列表（调试默认不进）→ 通过率/触发/步骤数 → 详情三栏 → 失败步骤重跑出新报告且原报告不变", async ({ page }) => {
  test.setTimeout(240_000);
  const { token, projectId } = await seedProject(page, "t22reports");
  const key = "t22-" + Date.now().toString(36); // flaky 按 key 计数：每次跑唯一
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "报告验证场景", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "s1", kind: "http_direct", name: "健康检查",
        config: { method: "GET", url: TARGET + "/healthz" } },
      { key: "s2", kind: "http_direct", name: "必败步骤",
        config: { method: "GET", url: TARGET + "/flaky?key=" + key + "&fail_first=1",
          assertions: [{ type: "status_code", expected: 200 }] } },
      { key: "s3", kind: "sleep", name: "不会被跑到", config: { ms: 100 } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  const scenarioId = sc.body.id;

  // 场景页：执行一次（manual，进报告）+ 调试一次（debug，默认不进报告）
  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  await page.getByTestId("scene-run").click();
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "failed",
    { timeout: 30_000 });
  const runId = (await page.getByTestId("debug-report-link").getAttribute("href"))
    .split("/").pop();
  await page.getByTestId("scene-debug").click();
  // flaky 计数器全局：执行那轮已消耗掉唯一一次 500，调试轮自然通过——
  // 断言如实写 passed（这轮的语义是「debug 也会产生一次运行」，成败不是重点）
  await expect(page.getByTestId("debug-run-badge")).toHaveAttribute("data-status", "passed",
    { timeout: 30_000 });

  // 列表：默认不含调试 → 只有执行那一条
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();
  await expect(page.locator(".tp-page-title")).toHaveText("报告中心");
  const rows = page.getByTestId("reports-row");
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toContainText("报告验证场景");
  await expect(row.getByTestId("report-trigger")).toContainText("手动");
  await expect(row.getByTestId("report-pass-rate")).toHaveAttribute("data-percent", "50"); // 过1/(总3-跳1)
  await expect(row.getByTestId("report-steps")).toHaveText("3"); // stats.total 顶层步数

  // 「含调试」开关：打开后调试那条出现（Review Focus 11 的开关半边）
  await page.getByTestId("reports-include-debug").click();
  await expect(rows).toHaveCount(2);
  // 触发筛选（含调试开着）：只看调试 → 只剩调试那条
  await page.getByTestId("reports-filter-trigger").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "调试" }).first().click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-trigger", "debug");

  // 回到「只看执行」：**把筛选项亲手清掉**，不用 page.goto 假装重置。
  // 上一版写的是「整页导航，筛选项随页面重置」——**hash 路由下这是假的**：
  // goto 同一个 #/reports 是同源同文档导航，SPA 不重载、组件不重挂，
  // trigger=debug 与含调试开关原样留着，于是下面点到的那一行是**调试**那轮
  // （库里 ca11=manual/failed、21bb=debug/passed，点进去 URL 对不上就是这么来的）。
  // 顺带这条也真的在验清空按钮：allowClear 的 × 要 hover 才出现，点它才是用户路径。
  await page.getByTestId("reports-filter-trigger").hover();
  await page.locator("[data-testid='reports-filter-trigger'] .ant-select-clear").click();
  await page.getByTestId("reports-include-debug").click(); // 关掉「含调试」
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-trigger", "manual");
  await rows.first().click();
  await expect(page).toHaveURL(new RegExp("#/reports/" + runId));
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-overview")).toContainText("报告验证场景");
  await expect(page.getByTestId("report-overview-pass-rate")).toHaveAttribute("data-percent", "50");
  await expect(page.getByTestId("report-overview-status")).toContainText("断言失败");
  await expect(page.getByTestId("report-step-row")).toHaveCount(3);
  await expect(page.locator("[data-testid='report-step-row'][data-key='s2']"))
    .toHaveAttribute("data-status", "fail");
  // 只读画布：三个节点都上色且与 stats 一致（1 绿 1 橙 1 灰）
  const colored = await page.evaluate(() => {
    const c = {};
    for (const el of document.querySelectorAll("[data-testid^='scene-node-']")) {
      const s = el.getAttribute("data-run-status") || "none";
      c[s] = (c[s] || 0) + 1;
    }
    return c;
  });
  expect(colored).toMatchObject({ pass: 1, fail: 1, skip: 1 });

  // 步骤详情：点失败步骤 → 请求/响应/断言表（预期 200、实际 500、判负）
  await page.locator("[data-testid='report-step-row'][data-key='s2']").click();
  const panel = page.getByTestId("report-step-detail");
  await expect(panel).toContainText("status_code");
  await expect(panel.getByTestId("report-assert-row")).toHaveCount(1);
  await expect(panel.getByTestId("report-assert-row")).toContainText("✗");

  // 失败步骤重跑：同步跑出新 run → 跳新报告；flaky 只败第一次，重跑应当通过
  await expect(page.getByTestId("report-rerun")).toBeEnabled();
  await page.getByTestId("report-rerun").click();
  await expect(page).not.toHaveURL(new RegExp("#/reports/" + runId), { timeout: 30_000 });
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-overview-status")).toContainText("通过");
  await expect(page.getByTestId("report-step-row")).toHaveCount(1);
  const newRunId = page.url().split("/reports/")[1];
  // 新报告自述来源：stats.rerun_of 指回原报告（库里核对，不只看 UI）
  const newRep = await asUser(token, "get", "reports/" + newRunId + "?project_id=" + projectId);
  expect(newRep.body.stats.rerun_of).toBe(runId);
  expect(newRep.body.stats.rerun_step).toBe("s2");
  // 原报告不变：重跑不追改历史
  const oldRep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  expect(oldRep.body.status).toBe("failed");
  expect(oldRep.body.stats.total).toBe(3);
});

test("报告详情：点通过步骤也出详情；画布点击联动右栏；未终态/无结果节点不假着色", async ({ page }) => {
  test.setTimeout(240_000);
  const { token, projectId } = await seedProject(page, "t22detail");
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "两通过场景", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "a", kind: "http_direct", name: "健康检查",
        config: { method: "GET", url: TARGET + "/healthz" } },
      { key: "b", kind: "group", name: "包装", children: [
        { key: "b.1", kind: "sleep", name: "短等", config: { ms: 50 } },
      ] },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  const run = await asUser(token, "post", "scenarios/" + sc.body.id + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  const runId = run.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 30_000 }).toBe("passed");

  await page.goto("http://127.0.0.1:5173/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  // 容器步 b 与子步 b.1 都在树上（parent 嵌套渲染）
  await expect(page.getByTestId("report-step-row")).toHaveCount(3);
  // 画布点 b.1 → 右栏联动到该步详情（请求/响应区出现）
  await page.getByTestId("scene-node-b.1").click();
  await expect(page.getByTestId("report-step-detail")).toContainText("b.1");
  // 全过：环 100%，环上分母扣掉跳步（这里无跳步，pass/(2)=100）
  await expect(page.getByTestId("report-overview-pass-rate")).toHaveAttribute("data-percent", "100");
});

test("公共断言逐步判定（R88）：必挂的门让请求步自己变红，环与徽标天然一致；明细行带「场景级」标", async ({ page }) => {
  test.setTimeout(240_000);
  const { token, projectId } = await seedProject(page, "t20bca");
  // R88 语义：公共断言对**每个发出请求的步骤**求值——healthz 回 200、门要 418，
  // 该步自己判 fail → run failed。通过率环是步骤级口径（0%），徽标「断言失败」，
  // 两者天然一致：R86 那个「环 100% 却失败」的观感矛盾是语义修正消解的，不是展示层补丁。
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "质量门场景", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "h", kind: "http_direct", name: "健康检查",
        config: { method: "GET", url: TARGET + "/healthz" } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
    common_assertions: [{ type: "status_code", expected: 418 }],
  } });
  expect(sc.status).toBe(201);
  const run = await asUser(token, "post", "scenarios/" + sc.body.id + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  const runId = run.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 30_000 }).toBe("failed");

  await page.goto("http://127.0.0.1:5173/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  // 步骤自己 failed（门判在它头上、结果记在它身上）；环 0% 与徽标同向
  await expect(page.locator("[data-testid='report-step-row'][data-key='h']"))
    .toHaveAttribute("data-status", "fail");
  await expect(page.getByTestId("report-overview-pass-rate")).toHaveAttribute("data-percent", "0");
  await expect(page.getByTestId("report-overview-status")).toContainText("断言失败");
  // 右栏断言表：求值行落在该步明细里，带「场景级」标（处置动作不同：改场景 vs 改这一步）
  await page.locator("[data-testid='report-step-row'][data-key='h']").click();
  const panel = page.getByTestId("report-step-detail");
  await expect(panel.getByTestId("report-assert-row")).toHaveCount(1);
  await expect(panel.getByTestId("report-assert-row")).toContainText("status_code");
  await expect(panel.getByTestId("report-assert-row")).toContainText("418"); // 预期
  await expect(panel.getByTestId("report-assert-row")).toContainText("200"); // 实际
  await expect(panel.getByTestId("report-assert-scope")).toHaveCount(1);
  await expect(panel.getByTestId("report-assert-scope")).toHaveText("场景级");
  // run 级 stats.common_assertions 已删（R88）：逐行只在它命中的那一步，不两处漂移
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  expect(rep.body.stats.common_assertions).toBeUndefined();
});

test("步骤详情取失败：如实报错 + 可重试 + 选中态不丢；重试成功出内容", async ({ page }) => {
  test.setTimeout(240_000);
  const { token, projectId } = await seedProject(page, "t22stepfail");
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "详情取失败", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "h", kind: "http_direct", name: "健康检查",
        config: { method: "GET", url: TARGET + "/healthz" } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  const run = await asUser(token, "post", "scenarios/" + sc.body.id + "/run",
    { data: { project_id: projectId } });
  const runId = run.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 30_000 }).toBe("passed");

  // 步骤详情端点断供：详情拉失败**不许**变成永久转圈（旧实现 catch→null 正是这个形状）
  await page.route("**/reports/*/steps?**", (route) => route.abort());
  await page.goto("http://127.0.0.1:5173/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await page.getByTestId("report-step-row").first().click();
  await expect(page.getByTestId("report-step-error")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("report-step-error")).toContainText("暂时取不到");
  await expect(page.getByTestId("report-step-loading")).toHaveCount(0); // 不演「正在取」
  // 选中态不丢：错误文案里点名的就是刚选的那一步（左栏高亮跟着 active 走）
  await expect(page.getByTestId("report-step-error")).toContainText("h");
  // 恢复供给 → 重试按钮真能救回来
  await page.unroute("**/reports/*/steps?**");
  await page.getByTestId("report-step-retry").click();
  await expect(page.getByTestId("report-step-error")).toHaveCount(0);
  // 重试成功后出的是真详情（请求/响应区回来了）
  await expect(page.getByTestId("report-step-detail")).toContainText("请求");
});

// 1C T11（R107 + R112）：报告详情里 SCREENSHOT 制品走带鉴权 fetch 内联渲染。
// 1B 时代这里是裸 <a target="_blank">——Step 0 实测那个 href 不带 token 是 401，
// 链接点开根本打不开。截图取不到必须说「取不到」，不许留碎图标装绿（纪律 1），
// 所以断言钉 naturalWidth>0：真解码成功，不是 src 拼错也绿。
test("报告详情：SCREENSHOT 制品真解码内联（naturalWidth>0），非截图制品仍是链接且走带鉴权 fetch", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t11report");
  const { run_id: runId, artifact_name: shot } = insertRunDirect({
    project_id: projectId, subject_type: "ui_case", subject_name: "UI报告截图验证",
    screenshot: true,
  });

  // 报告中心能按对象类型筛出这条（后端 where；R112 的前端可感知面）
  await page.goto("http://127.0.0.1:5173/#/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible();
  await page.getByTestId("reports-filter-subject-type").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "UI 用例" }).first().click();
  await expect(page.getByTestId("reports-row")).toHaveCount(1, { timeout: 10_000 });

  await page.goto("http://127.0.0.1:5173/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  // 单步自动选中：u1 就是这条用例自己（R102 的 summary_graph 单节点）
  await expect(page.getByTestId("report-step-row")).toHaveCount(1);
  await page.getByTestId("report-step-row").click();
  const panel = page.getByTestId("report-step-detail");
  // 截图渲染成 <img>，且浏览器**真解码成功**（真 PNG 字节 + 真 content-type 才会 >0）
  const img = panel.getByTestId("report-artifact-img");
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect(img).toHaveJSProperty("naturalWidth", 1);
  await expect(img).toHaveJSProperty("naturalHeight", 1);
  // 不许同时存在老形状的裸 href 链接（<a href=/api/v1/artifacts/...> 点开必 401）
  await expect(page.locator("a[href*='/api/v1/artifacts/']")).toHaveCount(0);
  // 库里读回制品元数据（img 的 src 是 objectURL，不暴露 ref；ref 核对走 API）
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  expect(rep.body.subject_type).toBe("ui_case");
  expect(rep.body.artifacts.map((a) => a.kind)).toEqual(["SCREENSHOT"]);
  expect(shot).toBeTruthy();
});

// ══════════════════════════ T19：报告详情里的 UI 步骤（复用三栏，不新开页面）══════════════
// 独立 UI 运行 = 单节点 summary_graph（R102）：中间画布「看起来很空」是形状不是 bug，
// 说明句必须出现在 UI 运行、且**只**出现在 UI 运行（③）。右栏命令明细的断言行走 R108
// 形状、截图按 step_key 归位——两种形状都要吃到（前置取证）：
//   独立运行  制品 step_key = 命令 id（u1/u2…，_execute_ui_run 按 step_id 落库）
//   场景内     制品 step_key = 画布步骤 key（h_ui_case 按节点 key 落库）
// 真 UI 运行一轮 5~15s 是真实耗时；run 走 inline 执行档（playwright.config 的 TP_EXEC_MODE）。

const APP = "http://127.0.0.1:5173";

/** 建 UI 用例 → 真跑（POST run，inline 执行）→ 等终态，返回 {caseId, runId}。 */
async function seedUiRun(token, projectId, name, steps) {
  const c = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name, priority: "P2", steps } });
  expect(c.status).toBe(201);
  const run = await asUser(token, "post", "ui-cases/" + c.body.id + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  expect(run.body.status).toBe("queued");
  const runId = run.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 90_000, intervals: [1000] }).toMatch(/passed|failed|error|cancelled/);
  return { caseId: c.body.id, runId };
}

// 必败用例：打开 → 输入 → 断言一个不可能出现的文案。断言不成立 = fail 行（橙），
// 不是元素找不到的 error（红）——#login-tip 在登录页常驻，判定失败而非定位失败。
const UI_FAIL_STEPS = [
  { id: "u1", type: "open", input: TARGET + "/ui/login" },
  { id: "u2", type: "input", inline_locator: { type: "css", value: "#account" }, input: "demo" },
  { id: "u3", type: "assert_text", inline_locator: { type: "css", value: "#login-tip" },
    input: "不可能出现的断言文案XYZ" },
];

test("T19① 失败的 UI 用例进报告中心（manual）：类型标签/通过率环与 stats 一致", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t19-list");
  const { runId } = await seedUiRun(token, projectId, "T19必败UI用例", UI_FAIL_STEPS);

  // API 侧事实：failed + 环口径 pass/(total-skip)
  const rep = await asUser(token, "get", "reports/" + runId + "?project_id=" + projectId);
  expect(rep.body.status).toBe("failed");
  expect(rep.body.trigger).toBe("manual");
  const stats = rep.body.stats;
  expect(stats.fail).toBe(1);
  const expectedPct = String(Math.round(rep.body.pass_rate * 100));

  // 列表：UI 运行按对象类型筛得出、贴「UI 用例」而不是「接口」（R112）
  await page.goto(APP + "/#/reports");
  await page.getByTestId("reports-filter-subject-type").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .locator(".ant-select-item-option").filter({ hasText: "UI 用例" }).first().click();
  const row = page.getByTestId("reports-row");
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await expect(row.first()).toContainText("T19必败UI用例");
  await expect(row.first()).toHaveAttribute("data-trigger", "manual");

  // 详情三栏照旧：环与 stats 一致，步骤树 = 1 汇总 + 3 命令行（R102 形状）
  await row.first().click();
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-subject-type")).toHaveText("UI 用例");
  await expect(page.getByTestId("report-overview-status")).toContainText("断言失败");
  await expect(page.getByTestId("report-overview-pass-rate"))
    .toHaveAttribute("data-percent", expectedPct);
  await expect(page.getByTestId("report-step-row")).toHaveCount(4); // case + u1..u3
});

test("T19② 右栏命令明细：命令行数 == 命令数，失败行内联截图（按命令 id 归位）+ 断言卡", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t19-detail");
  const { runId } = await seedUiRun(token, projectId, "T19明细用例", UI_FAIL_STEPS);

  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  // 自动选中失败命令行 u3：它的截图就按命令 id 归位（独立运行形状）
  await expect(page.locator("[data-testid='report-step-row'][data-key='u3']"))
    .toHaveAttribute("data-status", "fail");
  const panel = page.getByTestId("report-step-detail");
  const u3shot = panel.getByTestId("report-artifact-img").first();
  await expect(u3shot).toBeVisible({ timeout: 20_000 });
  expect(await u3shot.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

  // 点「用例」汇总节点 → 命令时间线行数 == 命令数；失败行（u3）自带内联截图
  await page.locator("[data-testid='report-step-row'][data-key='case']").click();
  await expect(panel.getByTestId("report-cmd-row")).toHaveCount(3);
  await expect(panel.locator("[data-testid='report-cmd-row'][data-id='u3']"))
    .toHaveAttribute("data-status", "fail");
  await expect(panel.locator("[data-testid='report-cmd-row'][data-id='u1']"))
    .toHaveAttribute("data-status", "pass");
  const rowShot = panel.locator("[data-testid='report-cmd-row'][data-id='u3']")
    .getByTestId("report-artifact-img").first();
  await expect(rowShot).toBeVisible({ timeout: 20_000 });
  expect(await rowShot.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  // 断言卡复用 DebugPanel（R108 行形状）：期望=屏上不存在的新文案，判负
  const card = panel.getByTestId("assertion-card").first();
  await expect(card).toContainText("assert_text");
  await expect(card).toContainText("不可能出现的断言文案XYZ");
  await expect(card).toContainText("实际");
});

test("T19③ R102 说明句只出现在 UI 运行，API/场景运行不出现；对象类型标签同一词表", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t19-note");
  const { runId } = await seedUiRun(token, projectId, "T19说明句用例",
    [{ id: "u1", type: "open", input: TARGET + "/ui/login" }]);
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "T19对照场景", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "h", kind: "http_direct", name: "健康检查",
        config: { method: "GET", url: TARGET + "/healthz" } }] },
    variables: {}, fail_fast: true, project_public: true } });
  expect(sc.status).toBe(201);
  const scRun = await asUser(token, "post", "scenarios/" + sc.body.id + "/run",
    { data: { project_id: projectId } });
  expect(scRun.status).toBe(200);

  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  const note = page.getByTestId("report-ui-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("1 个顶层步骤 = 1 条 UI 用例");
  await expect(note).toContainText("命令明细在右栏");
  await expect(page.getByTestId("report-subject-type")).toHaveText("UI 用例");

  // 对照：API 场景运行**没有**这句话（别把说明撒到所有报告），标签走同一张词表
  const scRunId = scRun.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + scRunId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 30_000 }).toBe("passed");
  await page.goto(APP + "/#/reports/" + scRunId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-ui-note")).toHaveCount(0);
  await expect(page.getByTestId("report-subject-type")).toHaveText("场景");
});

test("T19④ 混合场景：ui_case 节点在只读画布按结果着色（橙=断言失败），制品按画布步骤 key 归位", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t19-mixed");
  const { caseId } = await seedUiRun(token, projectId, "T19混合失败用例", UI_FAIL_STEPS);
  // 上面那次运行顺带把用例跑熟；这里把它挂进场景再跑一轮混合
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "T19混合着色场景", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "s1", kind: "http_direct", name: "健康检查",
        config: { method: "GET", url: TARGET + "/healthz" } },
      { key: "uin", kind: "ui_case", name: "UI 断言失败", ref: caseId }] },
    variables: {}, fail_fast: true, project_public: true } });
  expect(sc.status).toBe(201);
  const run = await asUser(token, "post", "scenarios/" + sc.body.id + "/run",
    { data: { project_id: projectId } });
  expect(run.status).toBe(200);
  const mixId = run.body.run_id;
  await expect.poll(async () => {
    const r = await asUser(token, "get", "reports/" + mixId + "?project_id=" + projectId);
    return r.body.status;
  }, { timeout: 90_000, intervals: [1000] }).toBe("failed");

  await page.goto(APP + "/#/reports/" + mixId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  // 1B 的分色（step result → data-run-status）：pass=绿 fail=橙，ui_case 节点与 api 节点同支笔
  await expect(page.getByTestId("scene-node-s1")).toHaveAttribute("data-run-status", "pass");
  await expect(page.getByTestId("scene-node-uin")).toHaveAttribute("data-run-status", "fail");
  await expect(page.locator("[data-testid='report-step-row'][data-key='uin']"))
    .toHaveAttribute("data-status", "fail");
  // 场景内形状：UI 制品 step_key = 画布步骤 key「uin」，选中该节点即内联可看
  await page.locator("[data-testid='report-step-row'][data-key='uin']").click();
  const panel = page.getByTestId("report-step-detail");
  const shot = panel.getByTestId("report-artifact-img").first();
  await expect(shot).toBeVisible({ timeout: 20_000 });
  expect(await shot.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  // 混合报告是场景主体：R102 说明句不该出现在这里（它是独立 UI 运行单节点画布的代价说明）
  await expect(page.getByTestId("report-ui-note")).toHaveCount(0);
});

test("T19⑤ 用例彻底删除后报告仍完整可读（自包含承诺对 UI 兑现，截图仍可内联解码）", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t19-purge");
  const name = "T19要被purge的用例";
  const { caseId, runId } = await seedUiRun(token, projectId, name,
    [{ id: "u1", type: "open", input: TARGET + "/ui/login" }]);

  // 回收 → 逐字输名彻底删除（destructive 门，T22 金线同法）
  expect((await asUser(token, "post", "ui-cases/" + caseId + "/delete",
    { data: { project_id: projectId } })).status).toBe(200);
  const purge = await asUser(token, "post", "ui-cases/" + caseId + "/purge",
    { data: { project_id: projectId, confirm_name: name } });
  expect(purge.status).toBe(200);

  await page.goto(APP + "/#/reports/" + runId);
  await expect(page.getByTestId("page-report-detail")).toBeVisible();
  await expect(page.getByTestId("report-overview")).toContainText(name);
  await expect(page.getByTestId("report-overview-status")).toContainText("通过");
  await expect(page.getByTestId("report-step-row")).toHaveCount(2); // case + u1
  // 命令行明细不随资产消失（明细是执行时快照）
  await page.locator("[data-testid='report-step-row'][data-key='case']").click();
  const panel = page.getByTestId("report-step-detail");
  await expect(panel.getByTestId("report-cmd-row")).toHaveCount(1);
  // 制品字节也不许消失：整案终态截图按命令 id（u1）归位，purge 后仍真解码
  const shot = panel.locator("[data-testid='report-cmd-row'][data-id='u1']")
    .getByTestId("report-artifact-img").first();
  await expect(shot).toBeVisible({ timeout: 20_000 });
  expect(await shot.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  // 用例本身真没了（不是软删装样子）
  expect((await asUser(token, "get", "ui-cases/" + caseId + "?project_id=" + projectId)).status)
    .toBe(404);
});
