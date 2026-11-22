// 1E T9 点名的第三份设置页 e2e（计划 2026-11-16-1e §T9：settingsTabs.spec.mjs =
// 「模型卡墙 + 审计双栏 diff + READONLY 看不到审计 Tab 且 API 403」）。
// settings.spec.mjs 已钉「只读写按钮不渲染 / 项目管理员改角色 / 系统管理员审计查得到写操作」，
// 本文件不重复那三条，只补它没盖到的三面。
//
// 假网关下的真实可得分歧（写在前头，别让断言悬空）：
// ① 种子模型 fake://basic_two_tools 的 probe 走 services.model_cfg_probe 的 fake 分支——
//    capabilities 存的是 supports_* 列值（人工/默认位），**不是**真逐能力探测的回执；
//    所以 fake:// 卡片上「✓工具」来自列默认值，不拿它当「网关真回了 tool_calls」的证据。
// ② ?（unknown）在 e2e 后端唯一真实可得的路径：base_url 指不可达真 URL → run_probe
//    GET /models 连接失败 → probe_result.capabilities 全 null（假阴性红线：没测出来 ≠ 不支持）。
// ③ 维度：fake:// 的 probe 分支根本不跑 embeddings → embed_dimensions 恒 null、
//    展开位如实「未测出（坏响应不猜维度）」——所以这里只断「未探/未测出」，不断任何具体维度数。
//
// 诚实口径：本文件编写时 e2e 管线（workers=1，8321 后端）被 scheduleNotify 占用，
// **playwright 未实测**；静态门禁（tsc --noEmit / eslint）实测通过，实跑与数字回填留给
// 领导收敛阶段（与 importWizard.spec.mjs 同批）。
import { expect, test } from "@playwright/test";
import { asUser, seedMember, seedProject } from "./helpers.mjs";

/** 打开设置页并切到某个 Tab（AntD 的 tab 是 div，按类名取；settings.spec 同款）。 */
async function openSettingsTab(page, label) {
  await page.goto("/#/settings");
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await page.locator(".ant-tabs-tab").filter({ hasText: label }).click();
}

test("模型卡墙：✓/✗/? 三态 + 默认★ + 向量隐藏思考/视觉且不猜维度", async ({ page }) => {
  test.setTimeout(120_000);
  const { token } = await seedProject(page, "1e模型卡墙");
  const s = Date.now().toString(36);
  const nameA = "e2e卡墙假网关-" + s; // fake:// 脚本：probe 回显列值（口径①）
  const nameB = "e2e卡墙不可达-" + s; // 不可达端口：probe 失败 → 全 ?（口径②）
  const nameC = "e2e卡墙向量-" + s;   // EMBEDDING：隐藏思考/视觉 + 不猜维度（口径③）
  const mk = async (data) => {
    const r = await asUser(token, "post", "model-cfgs", { data });
    expect(r.ok, JSON.stringify(r.body)).toBeTruthy();
  };
  await mk({ name: nameA, model_type: "CHAT", protocol: "OPENAI_COMPAT",
    base_url: "fake://basic_two_tools", model_name: "e2e-fake-a" });
  await mk({ name: nameB, model_type: "CHAT", protocol: "OPENAI_COMPAT",
    base_url: "http://127.0.0.1:1/v1", model_name: "e2e-dead-b" });
  await mk({ name: nameC, model_type: "EMBEDDING", protocol: "OPENAI_COMPAT",
    base_url: "fake://basic_two_tools", model_name: "e2e-embed-c" });

  await openSettingsTab(page, "模型配置");
  await expect(page.getByTestId("tab-model")).toBeVisible();
  const card = (n) => page.getByTestId("model-card").filter({ hasText: n });

  // 默认★：种子模型（lifespan seed，e2e 库全程无人改默认位）挂金标；
  // 非默认 + 可管理 → 「设为默认」钮在（只断在，不点——点了会翻全局默认位踩别的用例）。
  await expect(card("seed-fake-basic").getByTestId("model-default-star")).toBeVisible();
  await expect(card(nameA).getByTestId("model-set-default")).toBeVisible();

  // —— 卡 A（fake://）：未探测 → 徽标回落 supports_* 列值；[连通性测试] 走 fake 分支如实回显
  const a = card(nameA);
  await expect(a.getByTestId("model-probe-line")).toHaveText("未探测");
  // 列默认值形状：tools 列默认 True、thinking/vision 默认 False（ModelTab 兜底口径，非网关回执）
  await expect(a.getByTestId("model-cap-tools")).toHaveAttribute("data-state", "yes");
  await expect(a.getByTestId("model-cap-thinking")).toHaveAttribute("data-state", "no");
  await expect(a.getByTestId("model-cap-tools")).toContainText("✓工具");
  await a.getByTestId("model-probe-btn").click();
  await expect(a.getByTestId("model-probe-line")).toContainText("●OK", { timeout: 15_000 });
  // probeOne 自动展开逐能力位（§11.4.23 [连通性测试] 逐能力展开）
  await expect(a.getByTestId("model-probe-expanded")).toBeVisible();
  await expect(a.getByTestId("model-probe-expanded").getByTestId("model-cap-vision")).toHaveCount(1);

  // —— 卡 B（不可达）：假阴性红线——探测失败没测出来 → 三个 ? ，一个 ✗ 都不许有。
  // 探测前回落列值（✗ 是「人工位」不是「探测说不支持」）；探测失败后 probe_result
  // .capabilities 落 null（services._apply_probe：out.caps 原样存三态），必须翻成 ?。
  const b = card(nameB);
  await expect(b.getByTestId("model-probe-line")).toHaveText("未探测");
  await b.getByTestId("model-probe-btn").click();
  await expect(b.getByTestId("model-probe-line")).toContainText("●失败", { timeout: 20_000 });
  // 展开区 + 主行各三枚：6 枚全 ?（unknown），[data-state="no"] 必须为 0——
  // 「连接失败落成一堆 ✗」是计划 T8 原文禁的假阴性。
  await expect(b.getByTestId("model-probe-expanded")).toBeVisible();
  await expect(b.locator('[data-testid^="model-cap-"]')).toHaveCount(6);
  await expect(b.locator('[data-testid^="model-cap-"][data-state="unknown"]')).toHaveCount(6);
  await expect(b.locator('[data-testid^="model-cap-"][data-state="no"]')).toHaveCount(0);
  // 主行与展开区各一枚 tools 位：这里必须**同时**断言两枚，不能用 getByTestId 单点——
  // 卡 A 的同名断言在探测前（展开区还不存在）所以单点没事，卡 B 探测后两处都在 DOM，
  // 单点会撞 playwright strict mode（全量 ⑦ 实测就是这么红的，不是产品错）。
  await expect(b.getByTestId("model-cap-tools")).toHaveText(["?工具", "?工具"]);

  // —— 卡 C（EMBEDDING）：思考/视觉位整体不渲染（不是置灰，是不在 DOM）；维度只认回执
  const c = card(nameC);
  await expect(c.getByTestId("model-cap-thinking")).toHaveCount(0);
  await expect(c.getByTestId("model-cap-vision")).toHaveCount(0);
  await expect(c.getByTestId("model-embed-dims")).toHaveText("维度 未探");
  await expect(c.getByTestId("model-probe-btn")).toHaveText("维度探测");
  await c.getByTestId("model-probe-btn").click();
  await expect(c.getByTestId("model-probe-line")).toContainText("●OK", { timeout: 15_000 });
  // fake 分支不跑 embeddings → 如实「未测出」，坏响应/没跑过都不许猜一个维度数
  await expect(c.getByTestId("model-probe-expanded")).toContainText("未测出（坏响应不猜维度）");
  await expect(c.getByTestId("model-embed-dims")).toHaveText("维度 未探");
  await expect(c.getByTestId("model-cap-thinking")).toHaveCount(0);
});

test("审计双栏 diff：覆盖导入落 before/after，[diff] 只在有对照物的行可点且双栏逐键高亮", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "1e审计双栏");
  // 全仓唯一产 before/after diff 的写入口是 api_import_commit 的覆盖分支（import_services.py
  // 覆盖审计，D26）——先造一个真接口，再导入「同 method+归一路径 键」的条目走覆盖。
  const d = await asUser(token, "post", "api-definitions", {
    data: { project_id: projectId, name: "查宠物清单", method: "GET", path: "/pets",
      request: { method: "GET", url: "http://127.0.0.1:9999/pets" } },
  });
  expect(d.ok, JSON.stringify(d.body)).toBeTruthy();
  const commit = await asUser(token, "post", "api-import-commit", {
    data: { project_id: projectId, items: [{
      name: "查宠物清单", method: "GET", path: "/pets", strategy: "overwrite", definition_id: d.body.id,
      request: { method: "GET", url: "http://127.0.0.1:9999/pets?limit=5",
        assertions: [{ type: "status_code", expected: 200 }] },
    }] },
  });
  expect(commit.ok, JSON.stringify(commit.body)).toBeTruthy();
  expect(commit.body.updated).toBe(1);

  await openSettingsTab(page, "审计日志");
  await expect(page.getByTestId("tab-audit")).toBeVisible();
  await page.getByTestId("audit-filter-action").fill("api_import_commit");
  await page.getByTestId("audit-filter-action").press("Enter");
  // 本专属项目里该动作恰好两行：service 自写的覆盖审计（有 before/after）+
  // 路由层成功审计（diff=produced，无对照物）——「[diff] 对没有快照的行诚实置灰」
  // （AuditTab 原文），这两行同屏就是它的现成靶。
  await expect(page.getByTestId("audit-row")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator('[data-testid="audit-diff"]:not([disabled])')).toHaveCount(1);
  await expect(page.locator('[data-testid="audit-diff"][disabled]')).toHaveCount(1);

  await page.locator('[data-testid="audit-diff"]:not([disabled])').first().click();
  // Modal 的 data-testid 落在 ant-modal-root（hidden 壳，见 settings.spec 头注）——
  // 可见性问 .ant-modal-content，内容断言用真实渲染出的 testid。
  const modal = page.locator(".ant-modal-content").last();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("变更对照 · api_import_commit");
  // 杂项摊在表头上方不丢信息：overwrite/name 都在
  await expect(page.getByTestId("audit-diff-meta")).toContainText("查宠物清单");
  // 双栏 = before/after 两个独立列（§11.4.27 画的是并排，不是行内）：version 1 → 2
  await expect(page.getByTestId("audit-diff-before-version")).toHaveText("1");
  await expect(page.getByTestId("audit-diff-after-version")).toHaveText("2");
  // 键级判定：request（URL+断言变了）与 version 变；method/path 原样 → 2 个差异键
  await expect(page.getByTestId("audit-diff-summary")).toContainText("2 个差异键");
  await expect(page.locator('[data-testid="audit-diff-row"][data-changed="true"]')).toHaveCount(2);
  const reqRow = page.getByTestId("audit-diff-before-request").locator("xpath=ancestor::tr[1]");
  await expect(reqRow).toHaveAttribute("data-changed", "true");
  await expect(page.getByTestId("audit-diff-before-request")).toContainText("9999/pets");
  await expect(page.getByTestId("audit-diff-after-request")).toContainText("limit=5");
  await expect(page.getByTestId("audit-diff-before-method")).toContainText('"GET"');
});

test("READONLY：审计/模型 Tab 不在 Tab 栏，直连 GET /audit 403（系统管理员同参 200 对照）", async ({ page }) => {
  // 先拿系统管理员身份（正向对照 + 专属项目），seedMember 的后登记 initScript 会把
  // 浏览器身份覆盖成只读成员——两个 init 都跑，后写的 tp_token/tp_project 生效。
  const { token: adminToken } = await seedProject(page, "1e只读审计对照");
  const { token, projectId, project } = await seedMember(page, "1e只读审计", "READONLY", "ro_tabspec");
  expect(project.my_role).toBe("READONLY");

  await page.goto("/#/settings");
  await expect(page.getByTestId("page-settings")).toBeVisible();
  const tabs = page.locator(".ant-tabs-tab");
  await expect(tabs.filter({ hasText: "审计日志" })).toHaveCount(0);
  // 模型配置同口径（settings.tsx 的 isSysAdmin 门）：只读点了也是恒 403，Tab 不该出现
  await expect(tabs.filter({ hasText: "模型配置" })).toHaveCount(0);

  // 绕过 UI 直打读口：D23 身份硬门（audit_list 开头）先于一切查询——不带 project_id、
  // 带 project_id 都是 403，错误码与前端按钮隐藏用的是同一口径（insufficient_permission）。
  const r1 = await asUser(token, "get", "audit");
  expect(r1.status).toBe(403);
  expect(r1.body.code).toBe("insufficient_permission");
  const r2 = await asUser(token, "get", "audit?project_id=" + projectId);
  expect(r2.status).toBe(403);
  // 反向对照：同一时刻系统管理员同参 200——证明 403 是身份门挡的，不是路由/查询坏了。
  const r3 = await asUser(adminToken, "get", "audit?project_id=" + projectId);
  expect(r3.status).toBe(200);
  expect(Array.isArray(r3.body.items)).toBeTruthy();
});
