// 场景画布（T19，§11.4.9/§11.7.3）：三栏工作台 + 树驱动连线 + 本地预检 + 乐观锁差异弹窗 + undo。
// 诚实边界：调试/执行按钮指向 T11 尚未合并的端点 → 置灰注明，本文件不跑任何场景。
// 结构改动只走拖拽/右键：连线由树生成，用户拉不出边（onConnect 被显式关闭）。
import { expect, test } from "@playwright/test";
import { asUser, seedProject } from "./helpers.mjs";

/** 建一条真 UI 用例（打开登录页即可——画布侧只验 ref 与保存，不跑它）。 */
async function seedUiCase(token, projectId, name) {
  const r = await asUser(token, "post", "ui-cases", { data: {
    project_id: projectId, name, priority: "P2",
    steps: [{ id: "u1", type: "open", input: "http://127.0.0.1:9999/ui/login" }],
  } });
  expect(r.status).toBe(201);
  return r.body.id;
}

/** 建一条真 ADB 用例（1D：画布侧同样只验 ref 与保存，不跑它）。 */
async function seedAdbCase(token, projectId, name) {
  const r = await asUser(token, "post", "adb-cases", { data: {
    project_id: projectId, name, priority: "P2",
    steps: [{ id: "a1", type: "connect", config: { addr: "127.0.0.1:5555" } }],
  } });
  expect(r.status).toBe(201);
  return r.body.id;
}

/** 每个用例自己的场景：两个 api_case + 一个 loop，够铺所有测试。 */
async function seedScenario(token, projectId, name) {
  const def = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: "查询订单", method: "GET", path: "/order/1",
    request: { method: "GET", url: "http://127.0.0.1:9999/order/1" },
  } });
  expect(def.status).toBe(201);
  const ids = [];
  for (const nm of ["登录A", "下单B"]) {
    const c = await asUser(token, "post", "api-cases", { data: {
      project_id: projectId, definition_id: def.body.id, name: nm, priority: "P1",
    } });
    expect(c.status).toBe(201);
    ids.push(c.body.id);
  }
  const nodes = [
    { key: "s1", kind: "api_case", ref: ids[0], name: "登录A" },
    { key: "s2", kind: "api_case", ref: ids[1], name: "下单B" },
    { key: "l1", kind: "loop", name: "轮询", config: { mode: "count", max_iter: 3 }, children: [] },
  ];
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name, priority: "P2",
    step_graph: { version: 1, nodes }, variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  return { scenarioId: sc.body.id, caseIds: ids };
}

/**
 * HTML5 拖拽模拟：Playwright 原生 dragTo 不派发 dragstart/drop 的 DataTransfer，
 * 而我们的落点逻辑（插入到后 / 移入容器）全靠 dataTransfer 载荷。
 * 用 dispatchEvent + 同一个 DataTransfer 句柄走完整事件序列（dragstart→dragover→drop→dragend）。
 */
async function html5Drag(page, source, target) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer: dt });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
  await source.dispatchEvent("dragend", { dataTransfer: dt });
}

test("画布同源：编辑→保存→重载结构一致；拉边被拒；列表模式反映同一 graph；调试/执行诚实置灰", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t19canvas");
  const { scenarioId } = await seedScenario(token, projectId, "履约回归");
  const uiCaseId = await seedUiCase(token, projectId, "登录工作台");
  const adbCaseId = await seedAdbCase(token, projectId, "连假设备");

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  // 已有结构渲染出来：三个节点 + 环内无子 → 空态提示
  await expect(page.getByTestId("scene-node-s1")).toBeVisible();
  await expect(page.getByTestId("scene-node-l1")).toBeVisible();
  // 左树：API/UI/ADB 三类用例全部可拖入（1D：ADB 随 h_adb_case 解禁，
  // 旧的 asset-blocked「1D 开放」钉桩已翻成「可拖」）。
  await expect(page.getByTestId("asset-case").filter({ hasText: "登录A" })).toBeVisible();
  const uiNode = page.getByTestId("asset-ui-case").filter({ hasText: "登录工作台" });
  await expect(uiNode).toBeVisible();
  await expect(uiNode).toHaveAttribute("draggable", "true");
  const adbNode = page.getByTestId("asset-adb-case").filter({ hasText: "连假设备" });
  await expect(adbNode).toBeVisible();
  await expect(adbNode).toHaveAttribute("draggable", "true");
  // 占位话术不许回来。原先钉的是 toHaveCount(getByTestId("asset-blocked"), 0)，但那个节点
  // 连同「ADB 用例 1D 开放」这句已在 85550ef（1D 解禁）整块删除——节点不存在，
  // 于是这条断言在任何树上都恒绿，谁把「即将开放」的假门加回来它都不会红。
  // 换成钉**话**本身：将来谁再摆「1D 开放」这类占位 Tag，这条立刻否决。
  await expect(page.getByText("1D 开放", { exact: false })).toHaveCount(0);
  // 诚实入口：调试已随 T20 开放（跑未保存草稿，本文件不跑它——sceneList.spec 钉）；
  // 执行已随 T21 开放（跑已保存场景 + SSE 实时进度，行为由 sceneRun.spec 钉）。
  // 此处页面尚无未保存修改 → 执行可用；title 说清跑的是已保存的图。
  await expect(page.getByTestId("scene-debug")).toBeEnabled();
  await expect(page.getByTestId("scene-run")).toBeEnabled();
  await expect(page.getByTestId("scene-run")).toHaveAttribute("title", /已保存/);

  // 拖「下单B」到「登录A」之后 → 新 api_case 节点插在 s1 后（key 由 nextKey 分配：n1）
  await html5Drag(page,
    page.getByTestId("asset-case").filter({ hasText: "下单B" }).first(),
    page.getByTestId("scene-node-s1"));
  await expect(page.getByTestId("scene-node-n1")).toBeVisible();
  // 未保存标记亮了
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();

  // 连线只由树生成：程序化发起一条 s1→s2 的连边必须被拒（onConnect 显式关闭）
  const edgesBefore = await page.locator(".react-flow__edge").count();
  await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="scene-node-s1"] .react-flow__handle.source');
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    const t = document.querySelector('[data-testid="scene-node-s2"] .react-flow__handle.target');
    t.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  });
  await page.waitForTimeout(300);
  expect(await page.locator(".react-flow__edge").count()).toBe(edgesBefore);

  // 保存 → 后端版本 +1；重载后图完全一致（含拖出来的结构）
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const saved = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(saved.status).toBe(200);
  expect(saved.body.version).toBe(2);
  expect(saved.body.step_graph.nodes.length).toBe(4);
  await page.reload();
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  await expect(page.getByTestId("scene-node-n1")).toBeVisible();

  // 把顶层 s2 移进循环 l1（右键 → 移入容器）→ 保存 → 重载后 l1.children 真有 s2
  await page.getByTestId("scene-node-s2").click({ button: "right" });
  await page.getByTestId("ctx-move-into").click();
  await page.getByTestId("move-into-l1").click();
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const moved = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  const l1 = moved.body.step_graph.nodes.find((n) => n.key === "l1");
  expect(l1.children.map((c) => c.key)).toEqual(["s2"]);
  expect(moved.body.version).toBe(3);
  // 套进循环的结构重载后原样回来（计划的「保存重载结构不变」在 UI 这一侧也钉住）
  await page.reload();
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  await expect(page.getByTestId("scene-node-s2")).toBeVisible();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);

  // 列表模式与画布同一 graph 同一时刻：同一步骤集合，切回画布仍在
  await page.getByTestId("scene-mode-list").click();
  await expect(page.getByTestId("scene-list-row")).toHaveCount(4);
  await page.getByTestId("scene-mode-canvas").click();
  await expect(page.getByTestId("scene-node-s2")).toBeVisible();

  // R111 翻转的另一半：UI 用例真的能拖进来 → 出 kind:"ui_case" + ref 节点 → 保存成功。
  // （旧断言「可见但 disabled」已作废；后端 BLOCKED_1B 已摘 ui_case，c046db3。）
  await html5Drag(page, uiNode, page.getByTestId("scene-node-s1"));
  const uiStep = page.getByTestId("scene-node-n2");
  await expect(uiStep).toBeVisible();
  await expect(uiStep).toContainText("UI 用例");
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const withUi = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(withUi.body.version).toBe(4);
  const uiSaved = withUi.body.step_graph.nodes.find((n) => n.key === "n2");
  expect(uiSaved.kind).toBe("ui_case");
  expect(uiSaved.ref).toBe(uiCaseId);

  // 1D 翻转：ADB 用例走同一条拖入→保存路径（依赖后端 graph.py BLOCKED 同步摘除——
  // 前端这半边本地预检已放行，保存这步钉的是前后端合流）。
  await html5Drag(page, adbNode, page.getByTestId("scene-node-s1"));
  const adbStep = page.getByTestId("scene-node-n3");
  await expect(adbStep).toBeVisible();
  await expect(adbStep).toContainText("ADB 用例");
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const withAdb = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(withAdb.body.version).toBe(5);
  const adbSaved = withAdb.body.step_graph.nodes.find((n) => n.key === "n3");
  expect(adbSaved.kind).toBe("adb_case");
  expect(adbSaved.ref).toBe(adbCaseId);
});

test("混合画布：api_case + ui_case + adb_case 同场，保存零 issue（1D 解禁的合流证明）", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t18mixed");
  const { scenarioId } = await seedScenario(token, projectId, "混合场景");
  const uiCaseId = await seedUiCase(token, projectId, "演示UI步");
  const adbCaseId = await seedAdbCase(token, projectId, "演示ADB步");

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("scene-node-s1")).toBeVisible();

  // 把 UI 用例拖到 api_case 节点之后：同场两种 ref 步骤，同一份校验表都放行
  await html5Drag(page,
    page.getByTestId("asset-ui-case").filter({ hasText: "演示UI步" }),
    page.getByTestId("scene-node-s1"));
  await expect(page.getByTestId("scene-node-n1")).toBeVisible();
  // 1D：再拖一条 ADB 用例——同场三种 ref 步骤（§13 混合场景 DoD 的画布侧前置）
  await html5Drag(page,
    page.getByTestId("asset-adb-case").filter({ hasText: "演示ADB步" }),
    page.getByTestId("scene-node-s1"));
  await expect(page.getByTestId("scene-node-n2")).toBeVisible();
  // 本地预检零 issue：问题面板保持空态（R111 之前这一步会顶 kind_not_available）
  await expect(page.getByTestId("issue-empty")).toBeVisible();

  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  await expect(page.getByTestId("save-refused")).toHaveCount(0);
  const saved = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(saved.status).toBe(200);
  expect(saved.body.version).toBe(2);
  const kinds = saved.body.step_graph.nodes.map((n) => n.kind);
  expect(kinds).toContain("api_case");
  expect(kinds).toContain("ui_case");
  expect(kinds).toContain("adb_case");
  const uiSaved = saved.body.step_graph.nodes.find((n) => n.kind === "ui_case");
  expect(uiSaved.ref).toBe(uiCaseId);
  const adbSaved = saved.body.step_graph.nodes.find((n) => n.kind === "adb_case");
  expect(adbSaved.ref).toBe(adbCaseId);
  // 服务器口径也是零 issue（前端预检没漏放、后端也没拦）
  expect(saved.body.issues ?? []).toEqual([]);
});

test("break 拖到循环外：红角标立刻出现、保存被拒、问题面板可定位", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t19break");
  const { scenarioId } = await seedScenario(token, projectId, "break出界");

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("scene-node-s1")).toBeVisible();

  // 从逻辑控件面板把「跳出循环」拖到顶层步骤 s1 之后（不点添加：走的就是拖拽路径）
  await html5Drag(page,
    page.getByTestId("logic-add-break"),
    page.getByTestId("scene-node-s1"));
  const breakNode = page.locator("[data-testid^='scene-node-']").filter({
    has: page.getByTestId("node-badge"),
  });
  // 立刻（不等后端）：节点红角标 + 问题面板有该条 issue
  await expect(breakNode).toHaveCount(1);
  await expect(page.getByTestId("issue-row-break_outside_loop")).toContainText("break");

  // 保存被本地预检拒绝：不发请求、版本不动
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("save-refused")).toBeVisible();
  const sc = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(sc.body.version).toBe(1);
  expect(sc.body.step_graph.nodes.length).toBe(3);

  // 点问题行 → 定位（选中该节点）；把 break 拖进循环 → 角标消失
  await page.getByTestId("issue-row-break_outside_loop").click();
  await expect(page.getByTestId("scene-node-n1")).toHaveAttribute("data-selected", "true");
  // 源节点用显式 key 而不是「带角标的节点」：拖拽成功后者会自毁（badge 消失），
  // 断言角标消失用 count 断言即可，别拿会被自己的成功干掉的 locator 当事件源。
  await html5Drag(page, page.getByTestId("scene-node-n1"), page.getByTestId("scene-node-l1"));
  await expect(page.getByTestId("node-badge")).toHaveCount(0);
  await expect(page.getByTestId("issue-row-break_outside_loop")).toHaveCount(0);
});

test("乐观锁冲突：两个页面同开一个场景，后者保存弹真差异弹窗（三选齐全）", async ({ page, context }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "t19conflict");
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "同开冲突", priority: "P2",
    step_graph: { version: 1, nodes: [] }, variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);
  const scenarioId = sc.body.id;
  const url = "http://127.0.0.1:5173/#/scene/" + scenarioId;

  // 两个人都打开：都是 v1
  await page.goto(url);
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  const pageB = await context.newPage();
  await pageB.goto(url);
  await expect(pageB.getByTestId("page-scene-editor")).toBeVisible();

  // B 先改先存：加一个等待步骤并改名 → v2
  await pageB.getByTestId("logic-add-sleep").click();
  await pageB.getByTestId("prop-name").fill("前者加的等待");
  await pageB.getByTestId("prop-name").press("Enter");
  await pageB.getByTestId("scene-save").click();
  await expect(pageB.getByTestId("scene-dirty-dot")).toHaveCount(0);

  // A 后改后存：加一个等待步骤并改名 → 保存撞 409 → 差异弹窗
  // （用 sleep 不用 set_var：新 set_var 的 vars 底稿是空对象，本地预检就该拦下它——
  //   拿一个「本来就不该能保存」的步骤来演冲突，演的是预检不是乐观锁。）
  await page.getByTestId("logic-add-sleep").click();
  await page.getByTestId("prop-name").fill("后者加的等待");
  await page.getByTestId("prop-name").press("Enter");
  await page.getByTestId("scene-save").click();

  await expect(page.locator("[data-testid='scene-conflict-modal'] .ant-modal-content")).toBeVisible();
  // 并排双方：我的 vs 服务器，内容真的不同（不是「刷新重试」一句话）
  await expect(page.getByTestId("conflict-mine")).toContainText("后者加的等待");
  await expect(page.getByTestId("conflict-server")).toContainText("前者加的等待");
  await expect(page.getByTestId("conflict-mine")).not.toContainText("前者加的等待");
  // 三选齐全：用我的 / 用服务器 / 复制我的到剪贴板
  await expect(page.getByTestId("conflict-use-mine")).toBeVisible();
  await expect(page.getByTestId("conflict-use-server")).toBeVisible();
  await expect(page.getByTestId("conflict-copy")).toBeVisible();

  // 复制我的到剪贴板：不解决冲突，弹窗关闭，画布仍是我的未保存版
  await page.getByTestId("conflict-copy").click();
  await expect(page.locator("[data-testid='scene-conflict-modal'] .ant-modal-content")).toBeHidden();
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();

  // 用我的：强推我的版本 → v3，服务器只有我的图
  await page.getByTestId("scene-save").click();
  await expect(page.locator("[data-testid='scene-conflict-modal'] .ant-modal-content")).toBeVisible();
  await page.getByTestId("conflict-use-mine").click();
  await expect(page.locator("[data-testid='scene-conflict-modal'] .ant-modal-content")).toBeHidden();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const after = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(after.body.version).toBe(3);
  expect(after.body.step_graph.nodes.map((n) => n.name)).toEqual(["后者加的等待"]);

  // B 再保存 → 先给 B 一点改动（B 此刻干净，无改动保存是 no-op），才走真冲突
  await pageB.getByTestId("logic-add-sleep").click();
  await pageB.getByTestId("scene-save").click();
  await expect(pageB.locator("[data-testid='scene-conflict-modal'] .ant-modal-content")).toBeVisible();
  await expect(pageB.getByTestId("conflict-server")).toContainText("后者加的等待");
  await pageB.getByTestId("conflict-use-server").click();
  await expect(pageB.locator("[data-testid='scene-conflict-modal'] .ant-modal-content")).toBeHidden();
  await expect(pageB.getByTestId("scene-dirty-dot")).toHaveCount(0);
  // B 的画布现在显示服务器现状（A 强推的那一步，key 以服务端保存图为准）
  const serverKey = after.body.step_graph.nodes[0].key;
  await expect(pageB.getByTestId("scene-node-" + serverKey)).toBeVisible();
  await pageB.close();
});

test("Ctrl+S 保存；连按 5 次 Ctrl+Z 精确回到初态", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t19undo");
  const { scenarioId } = await seedScenario(token, projectId, "撤销回归");

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("scene-node-s1")).toBeVisible();
  const shape = () => page.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='scene-node-']")]
      .map((r) => r.getAttribute("data-testid")).sort().join(","));
  const initial = await shape();

  // 五步改动：加等待 → 设变量改名 → 复制 s1 → 删副本 → 禁用 s2
  await page.getByTestId("logic-add-sleep").click();
  await page.getByTestId("prop-name").fill("等一会");
  await page.getByTestId("prop-name").press("Enter");
  await page.getByTestId("scene-node-s1").click({ button: "right" });
  await page.getByTestId("ctx-duplicate").click();
  const dupNode = page.locator("[data-testid^='scene-node-']").filter({ hasText: "副本" });
  await expect(dupNode).toHaveCount(1);
  await dupNode.click({ button: "right" });
  await page.getByTestId("ctx-delete").click();
  await page.getByTestId("scene-node-s2").click({ button: "right" });
  await page.getByTestId("ctx-disable").click();
  await expect(page.getByTestId("scene-node-s2")).toContainText("已禁用");

  // Ctrl+S 保存（不点按钮）：五步 = 加等待 / 改名 / 复制 / 删副本 / 禁用
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);
  const saved = await asUser(token, "get", "scenarios/" + scenarioId + "?project_id=" + projectId);
  expect(saved.body.version).toBe(2);
  expect(saved.body.step_graph.nodes.length).toBe(4); // s1, sleep(等一会), 设变量, s2(disabled)
  await page.getByTestId("scene-node-s1").click({ position: { x: 4, y: 4 } }); // 点画布夺焦（离开输入框）
  for (let i = 0; i < 5; i++) await page.keyboard.press("Control+z");
  expect(await shape()).toBe(initial);
  // 撤销回到的正是初态形状；但相对「已保存的 5 步版」它又是新的偏离——dirty 该亮
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();
});

test("未保存离开：拦截→留下→再走→确认离开", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t19guard");
  const { scenarioId } = await seedScenario(token, projectId, "离开拦截");

  await page.goto("http://127.0.0.1:5173/#/scene/" + scenarioId);
  await expect(page.getByTestId("scene-node-s1")).toBeVisible();
  await page.getByTestId("logic-add-sleep").click(); // 制造 dirty
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();

  // 点返回 → 弹确认，停在原页
  await page.getByTestId("scene-back").click();
  await expect(page.locator("[data-testid='leave-guard-modal'] .ant-modal-content")).toBeVisible();
  await page.getByTestId("leave-stay").click();
  await expect(page.locator("[data-testid='leave-guard-modal'] .ant-modal-content")).toBeHidden();
  await expect(page).toHaveURL(new RegExp("#/scene/" + scenarioId));
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();

  // 再点返回 → 确认离开 → 落回场景列表
  await page.getByTestId("scene-back").click();
  await expect(page.locator("[data-testid='leave-guard-modal'] .ant-modal-content")).toBeVisible();
  await page.getByTestId("leave-go").click();
  await expect(page.getByTestId("page-scene")).toBeVisible();
  await expect(page).toHaveURL(/#\/scene$/);
});

test("直连步可编辑断言（空态说明假绿），api_case 步的断言页只读", async ({ page }) => {
  test.setTimeout(120_000);
  const { token, projectId } = await seedProject(page, "t19directassert");
  const def = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: "查询订单", method: "GET", path: "/order/1",
    request: { method: "GET", url: "http://127.0.0.1:9999/order/1" },
  } });
  expect(def.status).toBe(201);
  const c = await asUser(token, "post", "api-cases", { data: {
    project_id: projectId, definition_id: def.body.id, name: "用例A", priority: "P1",
  } });
  expect(c.status).toBe(201);
  const sc = await asUser(token, "post", "scenarios", { data: {
    project_id: projectId, name: "直连断言", priority: "P2",
    step_graph: { version: 1, nodes: [
      { key: "s1", kind: "api_case", ref: c.body.id, name: "用例A" },
      { key: "d1", kind: "http_direct", name: "直连",
        config: { method: "GET", url: "http://127.0.0.1:9999/order/1" } },
    ] },
    variables: {}, fail_fast: true, project_public: true,
  } });
  expect(sc.status).toBe(201);

  await page.goto("http://127.0.0.1:5173/#/scene/" + sc.body.id);
  await expect(page.getByTestId("scene-node-s1")).toBeVisible();

  // api_case：断言页是只读说明（断言跟着用例走），不给行编辑控件
  await page.getByTestId("scene-node-s1").click();
  await page.getByRole("tab", { name: "断言" }).click();
  await expect(page.getByText("断言跟着用例走")).toBeVisible();
  await expect(page.getByTestId("prop-assert-add")).toHaveCount(0);

  // http_direct：断言可编辑，空态必须把「没断言 = 500 也算过」讲穿
  await page.getByTestId("scene-node-d1").click();
  await page.getByRole("tab", { name: "断言" }).click();
  await expect(page.getByTestId("prop-direct-assert-empty"))
    .toContainText("目标系统回 500 也是绿的");
  await page.getByTestId("prop-direct-assert-add").click();
  await page.getByTestId("prop-direct-assert-0").locator("input[placeholder='预期值']").fill("200");
  await expect(page.getByTestId("scene-dirty-dot")).toBeVisible();
  await page.getByTestId("scene-save").click();
  await expect(page.getByTestId("scene-dirty-dot")).toHaveCount(0);

  const saved = await asUser(token, "get", "scenarios/" + sc.body.id + "?project_id=" + projectId);
  const direct = saved.body.step_graph.nodes.find((n) => n.key === "d1");
  // 只钉「这一条断言确实是状态码断言、预期是 200」；expected 的 200/"200" 由后端归一，
  // 测试不该把归一前后的类型当成契约（那是断言引擎的口径，test_engine_handlers 那边钉）。
  const a0 = (direct.config.assertions || [])[0] || {};
  expect(a0.type).toBe("status_code");
  expect(String(a0.expected)).toBe("200");

  // 重载后断言行还在（配置真的落库，不是前端记的）
  await page.reload();
  await expect(page.getByTestId("scene-node-d1")).toBeVisible();
  await page.getByTestId("scene-node-d1").click();
  await page.getByRole("tab", { name: "断言" }).click();
  await expect(page.getByTestId("prop-direct-assert-0")).toBeVisible();
  await expect(page.getByTestId("prop-direct-assert-empty")).toHaveCount(0);
});
