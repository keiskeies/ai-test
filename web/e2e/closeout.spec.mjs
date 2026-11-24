// D85 收口：1G 批次四个交付物只有 vitest、没有浏览器层覆盖的入口，这里逐个补真 e2e——
//   ① D86：接口/用例被未回收场景引用时回收 409 → 点名引用者的拦截弹窗（api-scenario-block /
//      case-scenario-block），force 才放行；
//   ② D87：断言全部停用（或一条都没有）时调试面板如实标「未校验」，不许冒充「断言全过」
//      （debug-assert-none）；
//   ③ D70/D74：场景列表批量条 执行（选环境→入队）与 导出（落盘真快照）（scene-batch-run /
//      scene-batch-export）；
//   ④ D69：接口详情第三个 Tab「场景引用」列出引用它的场景而不是「暂无引用」（detail-tab-refs）；
//   ⑤ D73：UI 用例回收站——软删列表带 删除人/删除时间 两列，恢复可用（ui-case-del-ok）。
// 每条断言的期望字符串都逐字抄自 web/src 现网渲染（断言上方一行注释给 file:line），不发明文案。
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { asUser, pickOption, seedProject, wallClock } from "./helpers.mjs";

const TARGET = "http://127.0.0.1:9999";

/** 每次运行唯一的后缀：testpilot_e2e 跨运行追加，固定名迟早撞上 antd 虚拟列表的重复选项。 */
const tag = () => Date.now().toString(36);

const REQ = {
  method: "GET", url: TARGET + "/order/1", body: { type: "none" },
  assertions: [{ type: "status_code", expected: 200 }],
};

/** api_case 步骤单节点场景：ref=case_id 就是「谁引用了这条用例」的全部事实。 */
async function seedReferencingScenario(token, projectId, name, caseId, stepKey) {
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name, priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: stepKey, kind: "api_case", name: "引用步", ref: caseId, config: {} },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  return sc.body.id;
}

test("接口被未回收场景引用：回收被 409 拦成点名弹窗，取消什么都不改，force 才进回收站", async ({ page }) => {
  test.setTimeout(150_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d85def拦截");
  const defName = "被引用的接口-" + t;
  const sceneName = "引用它的场景-" + t;
  const def = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: defName, method: "GET", path: "/order/1", request: REQ } });
  expect(def.status).toBe(201);
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: def.body.id, name: "被引用的用例-" + t, priority: "P2" } });
  expect(c.status).toBe(201);
  await seedReferencingScenario(token, projectId, sceneName, c.body.id, "s1");

  await page.goto("/#/api");
  const row = page.getByRole("row").filter({ hasText: defName });
  await expect(row).toBeVisible();
  await row.getByTestId("api-delete").click();
  // api.tsx:279-282 回收确认（Modal.confirm）；last() 防同一测试内第二次弹 confirm 后旧壳留 DOM
  const delConfirm = page.locator(".ant-modal-confirm").last();
  await expect(delConfirm).toContainText("接口放入回收站？");
  await delConfirm.getByRole("button", { name: "放入回收站" }).click();

  // 拦截弹窗的标题与内容在同一个 .ant-modal-content 里（rc-dialog 不透传 testid 到根，
  // 可见性问 .ant-modal-content——settings.spec:64 同款取证）
  const block = page.getByTestId("api-scenario-block"); // CaseList.tsx:67
  const blockModal = page.locator(".ant-modal-content").filter({ has: block });
  await expect(block).toBeVisible();
  await expect(blockModal).toContainText("回收被拦截：还有场景在引用它"); // CaseList.tsx:62
  await expect(block).toContainText("被引用的接口-" + t); // CaseList.tsx:69 「「subject」被 N 个未回收场景引用。」
  const item = page.getByTestId("api-scenario-block-item"); // CaseList.tsx:80
  await expect(item).toContainText(sceneName); // CaseList.tsx:81 —— 回归到裸 toast 时这条必红
  await expect(item).toContainText("步骤 s1"); // CaseList.tsx:83
  await expect(page.getByTestId("api-scenario-block-force")).toBeVisible(); // CaseList.tsx:64

  // 取消 = 什么都没改（先查引用再改状态，409 必须是一条没改过数据的失败）
  await blockModal.getByRole("button", { name: "取 消", exact: true }).click(); // CaseList.tsx:66 cancelText
  await expect(block).toBeHidden();
  await expect(row).toBeVisible();
  // 「什么都没改」的库里证据：单查对已回收定义回 404（services.py:136-137），所以取消后
  // 仍能 200 就是「没被回收」的正证。别在这里断言 status 字面值——定义的 status 是
  // 完整度三态 draft/complete/recycled（models.py:20 注释 + services.py:107），
  // 带 request 的定义创建即 complete；首轮我就是照抄别处的「normal」把它测红的。
  const check = await asUser(token, "get", "api-definitions/" + def.body.id, { params: { project_id: projectId } });
  expect(check.status).toBe(200);
  expect(check.body.status).not.toBe("recycled");

  // force 第二步（明细可见才给的出口，services.py:273 同源）
  await row.getByTestId("api-delete").click();
  await page.locator(".ant-modal-confirm").last()
    .getByRole("button", { name: "放入回收站" }).click();
  await expect(block).toBeVisible();
  await page.getByTestId("api-scenario-block-force").click();
  // api.tsx:264 force 成功的回执原话
  await expect(page.locator(".ant-message")).toContainText("已放入回收站（引用它的场景步骤会当场解析失败）");
  await expect(block).toBeHidden();
  await expect(page.getByTestId("api-row").filter({ hasText: defName })).toHaveCount(0);
  // 单查对已回收定义回 404（services.py:136-137），库里事实走回收站列表核对
  const bin = await asUser(token, "get", "api-definitions",
    { params: { project_id: projectId, recycled: "true" } });
  expect(bin.body.items.map((x) => x.id)).toContain(def.body.id);
});

test("用例被未回收场景引用：回收确认后被拦，case-scenario-block 点名场景，force 后进用例回收站", async ({ page }) => {
  test.setTimeout(150_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d85case拦截");
  const defName = "拦截用接口-" + t;
  const caseName = "被引用的用例-" + t;
  const sceneName = "引用用例的场景-" + t;
  const def = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: defName, method: "GET", path: "/order/1", request: REQ } });
  expect(def.status).toBe(201);
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: def.body.id, name: caseName, priority: "P2" } });
  expect(c.status).toBe(201);
  await seedReferencingScenario(token, projectId, sceneName, c.body.id, "s1");

  await page.goto("/#/api");
  await page.getByTestId("api-row").filter({ hasText: defName }).click();
  const drawer = page.getByTestId("api-detail-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("detail-tab-case").click();
  const caseRow = drawer.getByTestId("case-row").filter({ hasText: caseName });
  await expect(caseRow).toBeVisible();

  // CaseList.tsx:355 Popconfirm「把这个用例放入回收站？」→ 回收
  await drawer.getByLabel("回收" + caseName).click();
  await page.getByRole("button", { name: "回 收", exact: true }).click();

  const block = page.getByTestId("case-scenario-block"); // CaseList.tsx:67 + 438
  await expect(block).toBeVisible();
  await expect(block).toContainText("被引用的用例-" + t); // CaseList.tsx:69
  const item = page.getByTestId("case-scenario-block-item"); // CaseList.tsx:80
  await expect(item).toContainText(sceneName); // CaseList.tsx:81 —— D86 的钉：不许退回裸 toast
  await expect(item).toContainText("步骤 s1"); // CaseList.tsx:83
  await page.getByTestId("case-scenario-block-force").click(); // CaseList.tsx:64
  // CaseList.tsx:252 force 成功的回执原话
  await expect(page.locator(".ant-message")).toContainText("用例已放入回收站（引用它的场景步骤会当场解析失败）");
  await expect(caseRow).toHaveCount(0);
  const bin = await asUser(token, "get", "api-cases", { params: {
    project_id: projectId, definition_id: def.body.id, recycled: "true" } });
  expect(bin.body.items.map((x) => x.id)).toContain(c.body.id);
});

test("接口唯一一条断言被停用后点调试：面板如实标「未校验」而不是「断言全过」，重新启用后又恢复判定", async ({ page }) => {
  test.setTimeout(150_000);
  const t = tag();
  await seedProject(page, "d85停用断言");
  const defName = "停用断言接口-" + t;

  await page.goto("/#/api");
  await page.getByTestId("api-new").click();
  await page.getByTestId("def-name").fill(defName);
  await page.getByTestId("def-path").fill("/healthz");
  // 靶场的 /order/{id} 要 Authorization 头（target_app.py:30-32 无令牌即 401），
  // api.spec.mjs 能用它是因为它先配了带 Bearer 的环境。这两条测的是「断言条数 → 面板措辞」，
  // 与被测接口是谁无关，用免鉴权的 /healthz 才不依赖环境配置。
  await page.getByTestId("req-url").fill(TARGET + "/healthz");
  await page.getByRole("tab", { name: /^断言/ }).click();
  await page.getByTestId("req-assert-add").click(); // status_code 200 一条
  // D78 真闸：Switch 关掉 = 后端不执行、不产结果行（shared/assertions.py:156）
  await page.getByTestId("req-assert-enabled-0").click(); // RequestEditor.tsx:228
  await expect(page.getByTestId("req-assert-enabled-0")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("api-save").click();
  await expect(page.getByTestId("api-row").filter({ hasText: defName })).toBeVisible();

  await page.getByTestId("api-detail").first().click();
  const drawer = page.getByTestId("api-detail-drawer");
  await drawer.getByTestId("detail-run").click();
  await expect(drawer.getByTestId("debug-status")).toHaveText("200", { timeout: 20_000 });
  // DebugPanel.tsx:43-47 零结果行 → 「未校验」；D87 的钉：全停用不得画绿色「断言全过」
  await expect(drawer.getByTestId("debug-assert-none")).toHaveText("未校验");
  await expect(drawer.getByTestId("debug-assert-pass")).toHaveCount(0);
  await expect(drawer.getByTestId("assertion-card")).toHaveCount(0);

  // 重新启用 → 真跑 1 条 → 回到「断言全过」：两半都钉住才测的是「按真跑了几条说话」。
  // detail-edit 在 Drawer 的 extra（api.tsx:513-518）里，而 api-detail-drawer 是正文 div
  // （:658）——按钮在正文之外，按 drawer 作用域找它永远等不到。编辑器与详情并存两帧
  // （def-tab 的只读 RequestEditor 也渲染断言行），编辑器一律按含 def-name 的那张抽屉定位。
  await page.getByTestId("detail-edit").click();
  const editor = page.locator(".ant-drawer-content").filter({ has: page.getByTestId("def-name") });
  await expect(editor).toBeVisible();
  await editor.getByRole("tab", { name: /^断言/ }).click();
  await editor.getByTestId("req-assert-enabled-0").click();
  await page.getByTestId("api-save").click();
  // 等编辑器抽屉退场，只剩详情抽屉一个开着的（close 点击有实点击校验，撞两层会挂）
  await expect(page.locator(".ant-drawer-open")).toHaveCount(1);
  await page.locator(".ant-drawer-open .ant-drawer-close").click();
  await expect(drawer).toBeHidden();
  await page.getByTestId("api-row").filter({ hasText: defName }).click();
  await drawer.getByTestId("detail-run").click();
  await expect(drawer.getByTestId("debug-status")).toHaveText("200", { timeout: 20_000 });
  await expect(drawer.getByTestId("debug-assert-pass")).toHaveText("断言全过"); // DebugPanel.tsx:55
  await expect(drawer.getByTestId("debug-assert-none")).toHaveCount(0);
});

test("用例一条断言都没有时点调试：面板同样如实标「未校验」，不给出「全过」的结论", async ({ page }) => {
  test.setTimeout(120_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d85零断言");
  const defName = "零断言接口-" + t;
  const def = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: defName, method: "GET", path: "/healthz",
    request: { method: "GET", url: TARGET + "/healthz", body: { type: "none" } } } });
  expect(def.status).toBe(201);
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: def.body.id, name: "零断言用例-" + t, priority: "P2" } });
  expect(c.status).toBe(201);

  await page.goto("/#/api");
  await page.getByTestId("api-row").filter({ hasText: defName }).click();
  const drawer = page.getByTestId("api-detail-drawer");
  await drawer.getByTestId("detail-tab-case").click();
  await drawer.getByTestId("case-debug").click();
  // CaseList.tsx:374 用例调试面板 + DebugPanel.tsx:43-47 零结果行分支
  const panel = drawer.getByTestId("case-debug-panel");
  await expect(panel.getByTestId("debug-status")).toHaveText("200", { timeout: 20_000 });
  await expect(panel.getByTestId("debug-assert-none")).toHaveText("未校验");
  await expect(panel.getByTestId("debug-assert-pass")).toHaveCount(0);
});

test("场景列表勾选两条无环境场景：批量执行点名「无环境可跑」，覆写环境后入队回执说清几个；导出落盘是真快照", async ({ page }) => {
  test.setTimeout(180_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d85批量");
  const n1 = "批量场景甲-" + t;
  const n2 = "批量场景乙-" + t;
  const envName = "批量覆写环境-" + t;
  const env = await asUser(token, "post", "envs", { data: {
    project_id: projectId, name: envName, position: 0,
    config: { vars: [["base_url", TARGET]], headers: [] } } });
  expect(env.status).toBe(201);
  for (const name of [n1, n2]) {
    const sc = await asUser(token, "post", "scenarios", { data: {
      project_id: projectId, name, priority: "P2",
      step_graph: { version: 1, nodes: [
        { key: "h", kind: "http_direct", name: "健康检查", config: { method: "GET", url: TARGET + "/healthz" } },
      ] },
      variables: {}, fail_fast: true, project_public: true } });
    expect(sc.status).toBe(201);
  }

  await page.goto("/#/scene");
  await expect(page.getByTestId("page-scene")).toBeVisible();
  for (const n of [n1, n2]) {
    await expect(page.getByTestId("scene-row-name").filter({ hasText: n })).toBeVisible();
  }
  for (const n of [n1, n2]) {
    // scenes.spec.mjs:67 同款：antd 表头全选与行勾选都是 input[type=checkbox]，行作用域点它
    await page.getByRole("row").filter({ hasText: n }).locator("input[type=checkbox]").click();
  }
  // scenes.tsx:364-366 批量条 + 「已选 N 项」
  await expect(page.getByTestId("scene-batch-bar")).toContainText("已选 2 项");

  // —— 批量执行（D70）——两条场景都没配环境且未选覆写 → 发起前点名挡下，不许偷偷跑
  await page.getByTestId("scene-batch-run").click(); // scenes.tsx:371
  const modal = page.locator(".ant-modal-content");
  await expect(modal).toContainText("执行 2 个场景"); // scenes.tsx:545 标题
  await expect(page.getByTestId("scene-run-blocked"))
    .toHaveText("选中的场景都没有配置环境，且未选覆写环境——先在场景里配环境或在这里选一个"); // scenes.tsx:557
  await expect(page.getByTestId("scene-run-ok")).toBeDisabled(); // scenes.tsx:547

  // 覆写环境 → 放行 → 逐个入队
  await page.getByTestId("scene-run-env").click(); // scenes.tsx:550（项目内只有这一条环境，无虚拟列表问题）
  await pickOption(page, envName);
  await expect(page.getByTestId("scene-run-ok")).toBeEnabled();
  await page.getByTestId("scene-run-ok").click();
  // scenes.tsx:306 入队回执原话
  await expect(page.locator(".ant-message")).toContainText("已入队 2 个执行，进度看报告中心");
  await expect(modal).toBeHidden();
  const runs = await asUser(token, "get", "runs", { params: { project_id: projectId, size: 50 } });
  expect(runs.status).toBe(200);
  const mine = runs.body.items.filter((r) => [n1, n2].includes(r.subject_name));
  expect(mine.length).toBe(2);
  expect([...new Set(mine.map((r) => r.trigger))]).toEqual(["manual"]); // scenes.tsx:562 trigger=manual 口径
  for (const r of mine) expect(["queued", "running", "passed"]).toContain(r.status);

  // —— 批量导出（D74）：入队成功后 load() 把勾选清空了（scenes.tsx:100），重新勾上再导。
  // ids 原样带进 /scenario-export，勾 2 条绝不悄悄变全量。
  for (const n of [n1, n2]) {
    await page.getByRole("row").filter({ hasText: n }).locator("input[type=checkbox]").click();
  }
  await expect(page.getByTestId("scene-batch-bar")).toContainText("已选 2 项");
  const dl = page.waitForEvent("download");
  await page.getByTestId("scene-batch-export").click(); // scenes.tsx:380
  const download = await dl;
  expect(download.suggestedFilename()).toBe("testpilot-scenario-export.json"); // scenes.tsx:261
  const out = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  expect(out.exported).toBe(2); // scenes.tsx:263 回执按这个数说话
  expect(out.scenarios.map((s) => s.name).sort()).toEqual([n1, n2].sort());
  // D133 翻案后钉这对：后端场景导出恒带一条固定口径说明（export_services.py 的 notes
  // 追加；D274 起文案改为「本导出是场景快照…可回灌」），notes 非空 ≠ 有问题——干净成功
  // 的导出走 success，不再被固定说明染成 warning（旧断言钉的正是那个染色）。真问题 note
  // （图校验 / 跨域引用指针）才配 warning，两条腿在 scenes.test.tsx 的 D133 describe。
  expect(out.notes.length).toBeGreaterThan(0);
  await expect(page.locator(".ant-message"))
    .toContainText("已导出 2 条（可在本页用「导入」回灌成新场景）");
});

test("接口详情「场景引用」Tab：被引用的接口列出场景名与步骤 key，没人引用的如实说「还没有场景引用这个接口」", async ({ page }) => {
  test.setTimeout(120_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d85refs");
  const refName = "被引用接口-" + t;
  const freeName = "没人引用的接口-" + t;
  const sceneName = "引用场景-" + t;
  const refDef = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: refName, method: "GET", path: "/order/1", request: REQ } });
  expect(refDef.status).toBe(201);
  const freeDef = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: freeName, method: "GET", path: "/order/2" } });
  expect(freeDef.status).toBe(201);
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: refDef.body.id, name: "被引用用例-" + t, priority: "P2" } });
  expect(c.status).toBe(201);
  await seedReferencingScenario(token, projectId, sceneName, c.body.id, "step7");

  await page.goto("/#/api");

  // 空态先验：真空列表才说「还没有场景引用这个接口」（拉失败走错误分支，不是这里）
  await page.getByTestId("api-row").filter({ hasText: freeName }).click();
  let drawer = page.getByTestId("api-detail-drawer");
  await drawer.getByTestId("detail-tab-refs").click(); // api.tsx:676
  await expect(drawer.getByTestId("detail-tab-refs")).toContainText("场景引用(0)"); // api.tsx:677
  await expect(drawer.getByTestId("detail-refs-empty")).toHaveText("还没有场景引用这个接口"); // api.tsx:747-748
  await page.locator(".ant-drawer-open .ant-drawer-close").click();
  await expect(drawer).toBeHidden();

  // 正主：Tab 必须列出引用场景的名字与命中步骤，而不是「暂无引用」（D69 的钉）
  await page.getByTestId("api-row").filter({ hasText: refName }).click();
  drawer = page.getByTestId("api-detail-drawer");
  await drawer.getByTestId("detail-tab-refs").click();
  await expect(drawer.getByTestId("detail-tab-refs")).toContainText("场景引用(1)"); // api.tsx:677
  const ref = drawer.getByTestId("detail-ref"); // api.tsx:753
  await expect(ref).toContainText(sceneName); // api.tsx:754
  await expect(ref).toContainText("step7"); // api.tsx:756 「（步骤 …）」
  await expect(drawer.getByTestId("detail-refs-empty")).toHaveCount(0);
});

test("UI 用例放入回收站后：回收站视图列出删除人/删除时间（与库里回收落点对齐），恢复回正常列表", async ({ page }) => {
  test.setTimeout(120_000);
  const t = tag();
  const { token, projectId } = await seedProject(page, "d73ui回收");
  const caseName = "被回收的UI用例-" + t;
  const c = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name: caseName, priority: "P2",
    steps: [{ id: "u1", type: "open", input: TARGET + "/healthz" }] } });
  expect(c.status).toBe(201);

  await page.goto("/#/ui/cases");
  await expect(page.getByTestId("page-ui-cases")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: caseName });
  await expect(row).toBeVisible();
  await row.getByTestId("ui-case-del").click(); // uiCases.tsx:225
  // uiCases.tsx:110-112 软删确认文案（前缀截断：句式以文件现网为准，只钉到「逐字确认名称」）
  await expect(page.locator(".ant-modal-confirm"))
    .toContainText("软删，可随时恢复；彻底删除需逐字确认名称。");
  await page.getByTestId("ui-case-del-ok").click(); // uiCases.tsx:112
  await expect(page.getByTestId("ui-case-row-name").filter({ hasText: caseName })).toHaveCount(0);

  // 回收站视图：删除人/删除时间两列只在回收站出现（uiCases.tsx:183-190 inRecycled 守卫）
  await page.getByTestId("ui-case-recycled").click(); // uiCases.tsx:153
  await expect(page.getByRole("columnheader", { name: "删除人" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "删除时间" })).toBeVisible();
  const ghost = page.getByTestId("ui-case-row-name").filter({ hasText: caseName });
  await expect(ghost).toBeVisible();
  // uiCases.tsx:172 回收站行名称是纯文本（详情 404，可点不可达就是假门）
  expect(await ghost.evaluate((el) => el.tagName)).toBe("SPAN");
  // 「删除人」= 回收那次写的 updated_by → 引导入成员表的人名（case_services.py:285 + bootstrap.py:34）
  await expect(page.getByTestId("ui-case-recycled-by")).toHaveText("系统管理员"); // uiCases.tsx:186
  const bin = await asUser(token, "get", "ui-cases", { params: { project_id: projectId, recycled: "true" } });
  const row_ = bin.body.items.find((x) => x.id === c.body.id);
  expect(row_).toBeTruthy();
  expect(row_.updated_by_name).toBe("系统管理员");
  // 「删除时间」= 回收落库时刻换东八区墙钟（分钟列，fmtTime seconds:false）；
  // helpers.wallClock 独立换算，退回截断 UTC 的那条守卫同 runs.spec 的 R68 手法。
  const shown = await page.getByTestId("ui-case-recycled-at").innerText(); // uiCases.tsx:189
  expect(shown).toBe(wallClock(row_.updated_at).slice(0, 16));

  // 恢复 → 正常列表回来、库里 status 归 normal
  await page.getByTestId("ui-case-restore").click(); // uiCases.tsx:213
  await expect(page.locator(".ant-message")).toContainText("已恢复"); // uiCases.tsx:120
  await page.getByTestId("ui-case-recycled").click(); // 退出回收站
  await expect(page.getByTestId("ui-case-row-name").filter({ hasText: caseName })).toBeVisible();
  const back = await asUser(token, "get", "ui-cases/" + c.body.id, { params: { project_id: projectId } });
  expect(back.status).toBe(200);
  expect(back.body.status).toBe("normal");
});
