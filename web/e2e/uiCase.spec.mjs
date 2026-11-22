// T16（§11.4.12 展开区 / §11.4.13 元素选择器）的 e2e。
// 靶页是 probe.html?mount=ui-params —— 仓库既有的 e2e-only 夹具机制（probe.html 只在
// build:e2e 出货，globalSetup.mjs 拦错构建）。夹具挂载的是**真实** ElementPicker /
// CommandParams + 真实 api client（token 走 seedProject 注入的 localStorage），
// 打的是真 /ui-elements 与 /ui-cases——不是假用例页：T17 的 uiCaseDetail 才是这两个
// 组件的产品宿主，在它落地前，组件唯一的「可点」去处就是这个 e2e-only 夹具。
import { expect, request, test } from "@playwright/test";
import { BASE, asUser, pickOption, seedProject } from "./helpers.mjs";

const PROBE = "http://127.0.0.1:5173/probe.html?mount=ui-params";

/** 夹具里 CommandParams 的当前命令 JSON（元素/定位器字段真值以它为准）。 */
async function cmdJson(page) {
  return JSON.parse(await page.getByTestId("probe-cmd-json").textContent());
}

test("①③④ 选元素显示名 / 就地新建直接选中并入库 / 最近使用排第一", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t16-picker");
  await page.goto(PROBE);
  await expect(page.getByTestId("cmdp-type")).toBeVisible();

  // ③ 就地新建：picker 底部 [+] 内联展开新建表单（不是跳走、不是弹窗页），
  //    建完直接选中（Select 显示名），并出现在元素库列表（真产品页验证）。
  await page.getByTestId("el-pick-new-toggle").click();
  await page.getByTestId("el-pick-new-name").fill("元素甲");
  await page.getByTestId("el-pick-new-locator").fill("#probe-el-a");
  await page.getByTestId("el-pick-new-ok").click();
  await expect(page.getByTestId("el-pick-select")).toContainText("元素甲");
  const created = await asUser(token, "get", "ui-elements?project_id=" + projectId);
  expect(created.status).toBe(200);
  const elA = created.body.items.find((e) => e.name === "元素甲");
  expect(elA).toBeTruthy();
  expect(elA.locator).toBe("#probe-el-a");
  await page.goto("http://127.0.0.1:5173/#/ui/elements");
  await expect(page.getByRole("row").filter({ hasText: "元素甲" })).toBeVisible();

  // 库里有第二个元素供切换（**先建再挂载**：picker 的列表在挂载时拉一次，
  // 挂载后再建会撞上加载竞态——夹具不做轮询刷新，产品页 T17 有自己的刷新入口）
  const madeB = await asUser(token, "post", "ui-elements", { data: {
    project_id: projectId, name: "元素乙", locator_type: "css", locator: "#probe-el-b",
  } });
  expect(madeB.status).toBe(201);

  // 回到夹具（重新挂载；localStorage 登录态与最近使用都在）
  await page.goto(PROBE);
  await expect(page.getByTestId("cmdp-type")).toBeVisible();

  // ① 选元素 → 行摘要显示元素**名**而不是 id
  await page.getByTestId("el-pick-select").click();
  await pickOption(page, "元素乙");
  await expect(page.getByTestId("probe-summary")).toContainText("点击 元素乙");
  let cmd = await cmdJson(page);
  expect(cmd.element_id).toBe(madeB.body.id);
  expect(cmd.inline_locator).toBeNull();

  // ④ 最近使用：甲已被就地新建用过一次；这里选乙 → 乙排第一；再点最近使用里的甲
  //    （甲的第二次使用）→ 甲顶回第一；重新打开后甲仍排第一（tp_ui_recent_elements 同步钉）
  await expect(page.getByTestId(/^el-pick-recent-/).first()).toContainText("元素乙");
  await page.getByTestId("el-pick-recent-" + elA.id).click(); // 第二次使用甲
  const chips = page.getByTestId(/^el-pick-recent-/);
  await expect(chips.first()).toContainText("元素甲");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("tp_ui_recent_elements")));
  expect(stored[0].id).toBe(elA.id);
  expect(stored.some((r) => r.id === madeB.body.id)).toBe(true);
});

test("② 就地定位：存 inline_locator 且 element_id 为 null，后端往返一次仍是如此", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t16-inline");
  await page.goto(PROBE);
  await expect(page.getByTestId("cmdp-type")).toBeVisible();

  // 切「就地定位」→ 元素选择器收起，互斥给不出两个都给（切一个就清另一个）
  await page.getByTestId("cmdp-locator-mode").getByText("就地定位").click();
  await expect(page.getByTestId("el-pick-select")).toHaveCount(0);
  await page.getByTestId("cmdp-inline-type").click();
  await pickOption(page, "xpath");
  await page.getByTestId("cmdp-inline-value").fill("//div[@id='probe']");
  let cmd = await cmdJson(page);
  expect(cmd.element_id).toBeNull();
  expect(cmd.inline_locator).toEqual({ type: "xpath", value: "//div[@id='probe']" });

  // 后端往返：夹具把这条命令真的 POST 进 ui-cases 再 GET 回来
  await page.getByTestId("probe-roundtrip-save").click();
  const rt = page.getByTestId("probe-roundtrip");
  await expect(rt).not.toHaveText("—");
  const back = JSON.parse(await rt.textContent());
  expect(back.element_id).toBeNull();
  expect(back.inline_locator).toEqual({ type: "xpath", value: "//div[@id='probe']" });

  const cases = await asUser(token, "get", "ui-cases?project_id=" + projectId);
  expect(cases.status).toBe(200);
  const saved = cases.body.items[0];
  const detail = await asUser(token, "get", "ui-cases/" + saved.id + "?project_id=" + projectId);
  expect(detail.status).toBe(200);
  expect(detail.body.steps[0].element_id).toBeNull();
  expect(detail.body.steps[0].inline_locator).toEqual({ type: "xpath", value: "//div[@id='probe']" });
});

test("⑤ 未开放类型在下拉里 disabled 且写明原因，点它不会选中", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t16-blocked");
  await page.goto(PROBE);
  await expect(page.getByTestId("cmdp-type")).toBeVisible();

  await page.getByTestId("cmdp-type").click();
  // 24 个选项是虚拟列表：不在视口里的选项不在 DOM 里，先搜索过滤到「上传」再看它
  await page.getByTestId("cmdp-type").locator("input").type("上传");
  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").last();
  await expect(dropdown).toBeVisible();
  const opt = dropdown.locator(".ant-select-item-option").filter({ hasText: "上传" }).first();
  await expect(opt).toHaveClass(/ant-select-item-option-disabled/);
  // 原因就写在选项里，文案对齐 validateCommands 的「要到 1C+ 批次才开放」
  await expect(opt).toContainText("要到 1C+ 批次才开放");
  await opt.click(); // 点了也不会选中
  await expect(page.getByTestId("cmdp-type")).toContainText("点击");
  await page.keyboard.press("Escape");
  expect((await cmdJson(page)).type).toBe("click");

  // 服务端防线仍在（UI 拦不住的老数据也一样被 422 拒）
  const bad = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name: "老数据模拟", priority: "P2",
    steps: [{ id: "u1", type: "upload", input: "a.txt" }],
  } });
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.body)).toContain("command_not_available");
});

// ══════════════════════════ T17：真页面（列表 + 命令编辑器 + 调试面板）══════════════════════════
// T16 的三条继续走 probe 夹具（组件级回归，不删）。从这里起 ①-⑦ 全部跑真实产品路由：
// 登录态经 seedProject 注入 → #/ui/cases → 详情 #/ui/cases/:id。调试端点真的起无头
// 浏览器打 127.0.0.1:9999 靶场，一轮 5~15s 是真实耗时不是卡死。
//
// 计划 vs 现实的既成差异（写进断言而不是藏起来）：
// 后端 UiCaseDebugIn 只有 {project_id, case_id}（对照 ScenarioDebugIn 带 graph），
// 调试跑的是**库里已保存**的命令序列。③「调试跑未保存草稿」在产品侧落成：
// 有未保存修改时调试先代存草稿再跑（面板 + toast 说出口「本次发起前已代为保存」），
// 结论按屏幕上新改的断言判——用户视角「改了不点保存直接调，按新的算」成立。

const APP = "http://127.0.0.1:5173";
const TARGET = "http://127.0.0.1:9999";

async function addCommand(page, typeName) {
  await page.getByTestId("cmd-add").click();
  await page.getByTestId("cmd-add").locator("input").type(typeName);
  await pickOption(page, typeName);
}

async function rowIds(page) {
  return page.getByTestId("cmd-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-id")));
}

/** HTML5 拖拽（同 sceneList.spec 的取证：dragTo 不带 DataTransfer，落点逻辑全靠载荷）。 */
async function html5Drag(page, sourceIdx, targetIdx) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  const rows = page.getByTestId("cmd-row");
  await rows.nth(sourceIdx).dispatchEvent("dragstart", { dataTransfer: dt });
  await rows.nth(targetIdx).dispatchEvent("dragover", { dataTransfer: dt });
  await rows.nth(targetIdx).dispatchEvent("drop", { dataTransfer: dt });
  await rows.nth(sourceIdx).dispatchEvent("dragend", { dataTransfer: dt });
}

/** 建一条能通过登录链的真用例（打开登录页 → 填账号/口令 → 点登录 → 断言工作台标题）。 */
async function seedLoginCase(token, projectId, name, overrides = {}) {
  const steps = [
    { id: "u1", type: "open", input: TARGET + "/ui/login" },
    { id: "u2", type: "input", inline_locator: { type: "css", value: "#account" }, input: "demo" },
    { id: "u3", type: "input", inline_locator: { type: "css", value: "#password" }, input: "demo123" },
    { id: "u4", type: "click", inline_locator: { type: "css", value: "#submit" } },
    { id: "u5", type: "assert_text", inline_locator: { type: "css", value: "#title" }, input: "订单工作台" },
  ];
  const r = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name, priority: "P2", steps, ...overrides,
  } });
  expect(r.status).toBe(201);
  return r.body;
}

test("① 建用例加 4 条命令 → 保存 → 刷新仍在且顺序不变", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t17-crud");
  // 元素用 API 造：本页要验的是命令编辑器，不是把 T14 元素库再跑一遍
  const elAcc = await asUser(token, "post", "ui-elements", { data: {
    project_id: projectId, name: "账号框", locator_type: "css", locator: "#account" } });
  const elBtn = await asUser(token, "post", "ui-elements", { data: {
    project_id: projectId, name: "登录按钮", locator_type: "css", locator: "#submit" } });
  expect(elAcc.status).toBe(201);
  expect(elBtn.status).toBe(201);

  await page.goto(APP + "/#/ui/cases");
  await expect(page.getByTestId("page-ui-cases")).toBeVisible();
  await page.getByTestId("ui-case-new").click();
  await expect(page).toHaveURL(/#\/ui\/cases\/new$/);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();

  await page.getByTestId("case-name").fill("登录失败提示");
  // 打开
  await addCommand(page, "打开");
  await page.getByTestId("cmdp-0-input").fill(TARGET + "/ui/login");
  // 输入（元素库选「账号框」→ 行摘要必须显示名而不是 id）
  await addCommand(page, "输入");
  await page.getByTestId("el-pick-select").click();
  await page.getByTestId("el-pick-select").locator("input").type("账号框");
  await pickOption(page, "账号框");
  await page.getByTestId("cmdp-1-input").fill("demo");
  // 点击（选「登录按钮」）
  await addCommand(page, "点击");
  await page.getByTestId("el-pick-select").click();
  await page.getByTestId("el-pick-select").locator("input").type("登录按钮");
  await pickOption(page, "登录按钮");
  // 断言文本（就地定位到 #err）
  await addCommand(page, "断言文本");
  await page.getByTestId("cmdp-3-locator-mode").getByText("就地定位").click();
  await page.getByTestId("cmdp-3-inline-value").fill("#err");
  await page.getByTestId("cmdp-3-input").fill("账号或密码错误");

  // 行摘要显示元素名（§11.4.12），不是 id
  await expect(page.getByTestId("cmd-row").nth(1)).toContainText("输入 demo → 账号框");
  await expect(page.getByTestId("cmd-row").nth(2)).toContainText("点击 登录按钮");

  await page.getByTestId("ui-case-save").click();
  // 成功才会导航进真实 id——先等这一步：保存还在飞的时候 reload 会把 POST 掐断
  await expect(page).not.toHaveURL(/\/new$/);
  await expect(page).toHaveURL(/#\/ui\/cases\/[^/]+$/);
  await expect(page.getByTestId("cmd-row")).toHaveCount(4);

  // 刷新仍在、顺序不变
  await page.reload();
  await expect(page.getByTestId("cmd-row")).toHaveCount(4);
  const types = await page.getByTestId("cmd-row").evaluateAll(
    (rows) => rows.map((r) => r.getAttribute("data-type")));
  expect(types).toEqual(["open", "input", "click", "assert_text"]);

  // 库里的事实：4 步、顺序、元素引用
  const m = await page.evaluate(() => location.hash.match(/cases\/([^/?]+)/)[1]);
  const detail = await asUser(token, "get", "ui-cases/" + m + "?project_id=" + projectId);
  expect(detail.status).toBe(200);
  expect(detail.body.steps.map((s) => s.type)).toEqual(["open", "input", "click", "assert_text"]);
  expect(detail.body.steps[1].element_id).toBe(elAcc.body.id);
  expect(detail.body.steps[2].element_id).toBe(elBtn.body.id);
  expect(detail.body.step_count).toBe(4);
});

test("② 拖第 4 行到第 2 位 + 页内剪贴板复制粘贴 → 库里 steps 顺序跟着变", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t17-drag");
  const c = await seedLoginCase(token, projectId, "拖拽用例");
  await page.goto(APP + "/#/ui/cases/" + c.id);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();
  await expect(await rowIds(page)).toEqual(["u1", "u2", "u3", "u4", "u5"]);

  // 搜索/筛选态禁用拖拽（ListMode.tsx:185 的理由：过滤后行序不代表真实顺序）
  await page.getByTestId("cmd-search").fill("断言");
  await expect(page.getByTestId("cmd-row").first()).toHaveAttribute("draggable", "false");
  await page.getByTestId("cmd-search").fill("");
  await expect(page.getByTestId("cmd-row").first()).toHaveAttribute("draggable", "true");

  // 拖 u5（第 5 行）到第 2 位
  await html5Drag(page, 4, 1);
  await expect(await rowIds(page)).toEqual(["u1", "u5", "u2", "u3", "u4"]);

  // 页内剪贴板：复制第 1 行 → 工具条出现「粘贴(1)」→ 粘贴到末尾（新 id 不复用）
  await page.getByTestId("cmd-more-0").click();
  await page.getByRole("menuitem", { name: "复制到剪贴板" }).click();
  await expect(page.getByTestId("cmd-paste")).toContainText("粘贴(1)");
  await page.getByTestId("cmd-paste").click();
  const afterPaste = await rowIds(page);
  expect(afterPaste.slice(0, 5)).toEqual(["u1", "u5", "u2", "u3", "u4"]);
  expect(afterPaste).toHaveLength(6);
  expect(new Set(afterPaste).size).toBe(6);

  await page.getByTestId("ui-case-save").click();
  const detail = await asUser(token, "get", "ui-cases/" + c.id + "?project_id=" + projectId);
  expect(detail.body.steps.map((s) => s.id)).toEqual(afterPaste);
  expect(detail.body.steps.map((s) => s.type)).toEqual(
    ["open", "assert_text", "input", "input", "click", "open"]);
});

test("③ 改了断言文本不点保存直接调试：结论按屏幕上的新值判（调试前代存草稿并说出口）", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t17-draft");
  const c = await seedLoginCase(token, projectId, "草稿调试用例");
  await page.goto(APP + "/#/ui/cases/" + c.id);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();

  // 展开第 5 行，把断言文本改成屏幕上存在不了的文案——**不点保存**
  await page.getByTestId("cmd-row").nth(4).click();
  await page.getByTestId("cmdp-4-input").fill("屏幕上的新断言XYZ");
  await page.getByTestId("ui-case-debug").click();

  // 调试跑的是已保存序列：有未保存修改时先代存草稿，这个动作必须在界面上说出口
  const note = page.getByTestId("ui-debug-note");
  await expect(note).toContainText("已保存的命令序列");
  await expect(note).toContainText("已代为保存");

  // 真浏览器真跑（5~15s）：结论按新断言判 = 断言失败，且失败的是第 5 条命令
  const badge = page.getByTestId("ui-debug-badge");
  await expect(badge).toHaveText("断言失败", { timeout: 60_000 });
  await expect(page.getByTestId("debug-cmd-row").nth(4)).toHaveAttribute("data-status", "fail");
  await expect(page.getByTestId("assertion-card").last()).toContainText("屏幕上的新断言XYZ");
  await expect(page.getByTestId("assertion-card").last()).toContainText("实际");

  // 代存落地：库里那条断言已是新文案（界面说了「已代为保存」，库里就得真是）
  const detail = await asUser(token, "get", "ui-cases/" + c.id + "?project_id=" + projectId);
  expect(detail.body.steps[4].input).toBe("屏幕上的新断言XYZ");
});

test("④ 失败命令行内联出截图（naturalWidth>0，真字节解码）", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t17-shot");
  const c = await seedLoginCase(token, projectId, "坏点击用例", {
    // 直接用坏定位器入库：打开→输入都过，第 3 条点击找不到目标 = error 行 + 自动截图
    steps: [
      { id: "u1", type: "open", input: TARGET + "/ui/login" },
      { id: "u2", type: "input", inline_locator: { type: "css", value: "#account" }, input: "demo" },
      { id: "u3", type: "click", inline_locator: { type: "css", value: "#no-such-button-x" } },
    ],
  });
  await page.goto(APP + "/#/ui/cases/" + c.id);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();

  // 草稿未动 = 干净，调试直接跑，不该出现「已代为保存」的说法
  await page.getByTestId("ui-case-debug").click();
  // error 命令（没跑成）→ run 终态 error（_run_status 两层词表），徽标是「请求失败」不是「断言失败」
  await expect(page.getByTestId("ui-debug-badge")).toHaveText("请求失败", { timeout: 60_000 });
  await expect(page.getByTestId("ui-debug-note")).not.toContainText("已代为保存");

  await expect(page.getByTestId("debug-cmd-row").nth(2)).toHaveAttribute("data-status", "error");
  // 失败命令行的**内联**截图：u3 上有「命令失败自动截图」+（u3 是末条）「整案终态截图」
  const shot = page.getByTestId("debug-shot-u3").first();
  await expect(shot).toBeVisible({ timeout: 30_000 });
  const naturalWidth = await shot.evaluate((el) => el.naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);
});

test("⑤ get_text 存变量 → 下一步输入值里 ${var} 真的渲染", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t17-var");
  const c = await seedLoginCase(token, projectId, "存变量用例", {
    steps: [
      { id: "u1", type: "open", input: TARGET + "/ui/login" },
      { id: "u2", type: "get_text", inline_locator: { type: "css", value: "#login-tip" }, save_var: "tip" },
      { id: "u3", type: "input", inline_locator: { type: "css", value: "#account" }, input: "${tip}" },
    ],
  });
  await page.goto(APP + "/#/ui/cases/" + c.id);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();
  // 行摘要要能看出变量去向（§11.4.12）
  await expect(page.getByTestId("cmd-row").nth(1)).toContainText("$tip");

  await page.getByTestId("ui-case-debug").click();
  await expect(page.getByTestId("ui-debug-badge")).toHaveText("通过", { timeout: 60_000 });
  // u3 的执行回执：填进去的是渲染后的变量值，不是字面 ${tip}
  await expect(page.getByTestId("debug-cmd-message-u3")).toContainText("演示账号");
  await expect(page.getByTestId("debug-vars")).toContainText("tip");
});

test("⑥ 只读成员：保存 / 调试按钮不渲染（不是 disabled）", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t17-readonly");
  const c = await seedLoginCase(token, projectId, "只读可见用例");
  // 在同项目挂一个 READONLY 成员并换成他的身份
  const acct = "ro_" + Date.now().toString(36).slice(-5);
  const u = await asUser(token, "post", "system/users", { data: {
    account: acct, name: "只读成员", password: "Member@123" } });
  expect(u.status).toBe(201);
  expect((await asUser(token, "put", "projects/" + projectId + "/members/" + u.body.id,
    { data: { role_code: "READONLY" } })).ok).toBe(true);
  // 成员登录换 token，并拿该身份视角下的项目（含服务端下发的 my_perms——按钮显隐
  // 必须跟着服务端那份走，不是前端猜的，同 seedMember 的取证口径）
  const ctxLogin = await request.newContext({ baseURL: BASE + "/" });
  const lr = await ctxLogin.post("auth/login", { data: { account: acct, password: "Member@123" } });
  expect(lr.ok()).toBeTruthy();
  const roToken = (await lr.json()).token;
  const pv = await ctxLogin.get("projects/" + projectId, { headers: { Authorization: "Bearer " + roToken } });
  expect(pv.ok()).toBeTruthy();
  const roProject = await pv.json();
  await ctxLogin.dispose();
  await page.addInitScript(([tk, pj]) => {
    localStorage.setItem("tp_token", tk);
    localStorage.setItem("tp_project", JSON.stringify(pj));
  }, [roToken, roProject]);

  await page.goto(APP + "/#/ui/cases");
  await expect(page.getByTestId("page-ui-cases")).toBeVisible();
  await expect(page.getByTestId("ui-case-new")).toHaveCount(0); // 写入口不渲染
  await expect(page.getByRole("row").filter({ hasText: "只读可见用例" })).toBeVisible();

  await page.goto(APP + "/#/ui/cases/" + c.id);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();
  await expect(page.getByTestId("ui-case-save")).toHaveCount(0);
  await expect(page.getByTestId("ui-case-debug")).toHaveCount(0);
  await expect(page.getByTestId("cmd-add")).toHaveCount(0);
  // 但读得到内容（读权限没被顺手拿走）
  await expect(page.getByTestId("cmd-row")).toHaveCount(5);
});

test("⑦ 空命令列表保存被拒，后端 empty_steps 那句原话显示在界面上", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t17-empty");
  const c = await seedLoginCase(token, projectId, "要被清空的用例", {
    steps: [{ id: "u1", type: "open", input: TARGET + "/ui/login" }],
  });
  await page.goto(APP + "/#/ui/cases/" + c.id);
  await expect(page.getByTestId("cmd-toolbar")).toBeVisible();

  await page.getByTestId("cmd-more-0").click();
  await page.getByRole("menuitem", { name: "删除该行" }).click();
  await expect(page.getByTestId("cmd-row")).toHaveCount(0);

  await page.getByTestId("ui-case-save").click();
  // 不许被泛用 toast 吞掉：界面要有专门一块把为什么说不清不楚地列出来
  const alert = page.getByTestId("case-save-issues");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("空用例跑起来「零步全绿」是假绿");
  // 保存被拒 = 库里没被清掉
  const detail = await asUser(token, "get", "ui-cases/" + c.id + "?project_id=" + projectId);
  expect(detail.body.steps).toHaveLength(1);
});
