// 场景列表页（T17）：模块树 + 列表 + 新建下拉 + 批量 + 回收站三件套。
// 造数据走 API，UI 只验 UI；「从用例生成」真调后端建场景并直连核对 step_graph。
import { expect, test } from "@playwright/test";
import { asUser, pickOption, seedProject, wallClock } from "./helpers.mjs";

test("场景列表：模块 → 空白/从用例生成 → 批量移动 → 回收站恢复与彻底删除", async ({ page }) => {
  test.setTimeout(180_000);
  const { token, projectId } = await seedProject(page, "scenes");

  // 用例用 API 造：本页验的是场景，不是接口页
  const def = await asUser(token, "post", "api-definitions", { data: {
    project_id: projectId, name: "查询订单", method: "GET", path: "/order/1",
    request: { method: "GET", url: "http://127.0.0.1:9999/order/1" },
  } });
  expect(def.status).toBe(201);
  const caseIds = [];
  for (const nm of ["登录A", "下单B"]) {
    const c = await asUser(token, "post", "api-cases", { data: {
      project_id: projectId, definition_id: def.body.id, name: nm, priority: "P1",
    } });
    expect(c.status).toBe(201);
    caseIds.push(c.body.id);
  }

  await page.goto("http://127.0.0.1:5173/#/scene");
  await expect(page.getByTestId("page-scene")).toBeVisible();
  await expect(page.getByTestId("scene-new")).toBeVisible();

  // 1) 模块树：新建模块（沿用 1A 交互与 testid 约定）
  await page.getByTestId("module-create").click();
  await page.getByTestId("module-name").fill("履约");
  await page.getByTestId("module-name").press("Enter");
  const modNode = page.locator(".ant-tree-treenode").filter({ hasText: "履约" }).first();
  await expect(modNode).toBeVisible();

  // 2) 选中模块 → 空白新建 → 行出现在列表且带模块归属
  await modNode.locator(".ant-tree-node-content-wrapper").click();
  await page.getByTestId("scene-new").click();
  await page.getByRole("menuitem", { name: "空白场景" }).click();
  await page.getByTestId("scene-blank-name").fill("履约回归");
  await page.getByTestId("scene-blank-ok").click();
  const rowA = page.getByRole("row").filter({ hasText: "履约回归" });
  await expect(rowA).toBeVisible();
  await expect(rowA.getByTestId("scene-steps")).toHaveText("0");
  // 定时列仍是「-」（这次不是「未开放」而是「列表口径给不出每行真相」：后端 ScenarioOut
  // 没有定时字段，真数据只在项目级分页的 GET /schedule-tasks 里，逐行反查不做——
  // 单场景真绑定看场景编辑器右栏，那里才反查真列表）。更新时间吃 ScenarioOut.updated_at（后端带 UTC 偏移）。
  // 这里比**具体钟点**而不是形状：上一版是 `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/`，
  // 页面 slice(0,16) 画 UTC 钟点也照样绿（R68 就是这么漏的）。换算在 e2e 侧独立实现。
  await expect(rowA.getByTestId("scene-cron")).toHaveText("-");
  const scenesAtCreate = await asUser(token, "get", "scenarios?project_id=" + projectId);
  expect(scenesAtCreate.status).toBe(200);
  const madeAt = scenesAtCreate.body.items.find((s) => s.name === "履约回归").updated_at;
  expect(madeAt).toBeTruthy();
  // 列是分钟级（seconds:false），所以取换算结果的前 16 个字符比
  await expect(rowA.getByTestId("scene-updated")).toHaveText(wallClock(madeAt).slice(0, 16));
  // 截断写法的结果（UTC 钟点）必须不等于换算结果——R68 的守卫
  expect(wallClock(madeAt).slice(0, 16)).not.toBe(madeAt.slice(0, 16).replace("T", " "));

  // 3) 从用例生成：勾 2 个用例 → 真建场景。计划的「落地画布」属 T19（尚是占位页），
  //    不造假画布：断言落在列表行（步骤数=2）+ 直连后端核 step_graph 真有 2 个 api_case 节点。
  //    T19 到位后这里追加「跳转 #/scene/{id} 且画布渲染 2 节点」的断言。
  await page.getByTestId("module-all").click(); // 回到全部，生成的场景落未分类，给批量移动留空间
  await page.getByTestId("scene-new").click();
  await page.getByRole("menuitem", { name: "从用例生成" }).click();
  await page.getByTestId("scene-gen-name").fill("登录接口集");
  await page.getByRole("row").filter({ hasText: "登录A" }).locator("input[type=checkbox]").click();
  await page.getByRole("row").filter({ hasText: "下单B" }).locator("input[type=checkbox]").click();
  await page.getByTestId("scene-gen-ok").click();
  const rowB = page.getByRole("row").filter({ hasText: "登录接口集" });
  await expect(rowB.getByTestId("scene-steps")).toHaveText("2");
  await expect(rowB.getByTestId("scene-prio-P2")).toBeVisible();
  await expect(page).toHaveURL(/#\/scene/); // 没跳假地址：留在列表
  const list = await asUser(token, "get", "scenarios?project_id=" + projectId);
  expect(list.status).toBe(200);
  const gen = list.body.items.find((s) => s.name === "登录接口集");
  expect(gen.step_graph.nodes.length).toBe(2);
  expect(gen.step_graph.nodes.map((n) => n.kind)).toEqual(["api_case", "api_case"]);
  expect(gen.step_graph.nodes.map((n) => n.ref).sort()).toEqual([...caseIds].sort());

  // 3.5) T19 交付的入口：行「打开画布」→ #/scene/{id}，画布真渲染出生成的 2 个节点
  await rowB.getByTestId("scene-open-canvas").click();
  await expect(page.getByTestId("page-scene-editor")).toBeVisible();
  await expect(page.getByTestId("scene-node-s1")).toBeVisible();
  await expect(page.getByTestId("scene-node-s2")).toBeVisible();
  await page.goto("http://127.0.0.1:5173/#/scene");
  await expect(page.getByTestId("page-scene")).toBeVisible();

  // 4) 批量移动：全选 → 移到「履约」模块
  await page.getByRole("row").filter({ hasText: "履约回归" }).locator("input[type=checkbox]").click();
  await page.getByRole("row").filter({ hasText: "登录接口集" }).locator("input[type=checkbox]").click();
  await expect(page.getByTestId("scene-batch-bar")).toContainText("已选 2 项");
  await page.getByTestId("scene-batch-move").click();
  await page.getByTestId("scene-move-target").click();
  await pickOption(page, "履约");
  await page.getByTestId("scene-move-ok").click();
  await expect(rowA.getByRole("cell").filter({ hasText: "履约" }).first()).toBeVisible();
  await expect(rowB.getByRole("cell").filter({ hasText: "履约" }).first()).toBeVisible();

  // 5) 回收站三件套：删除 → 恢复 → 再删 → 彻底删除（输名确认）
  await rowA.getByTestId("scene-delete").click();
  await page.getByTestId("scene-del-ok").click();
  await expect(rowA).toHaveCount(0);
  await page.getByTestId("module-recycled-toggle").click();
  await expect(rowA.getByTestId("scene-restore")).toBeVisible();
  await rowA.getByTestId("scene-restore").click();
  await page.getByTestId("module-recycled-toggle").click();
  await expect(rowA.getByTestId("scene-delete")).toBeVisible();

  await rowA.getByTestId("scene-delete").click();
  await page.getByTestId("scene-del-ok").click();
  await page.getByTestId("module-recycled-toggle").click();
  await rowA.getByTestId("scene-purge").click();
  const ok = page.getByTestId("scene-purge-ok");
  await page.getByTestId("scene-purge-confirm").fill("履约");
  await expect(ok).toBeDisabled(); // 名字差一点都不行（与 1A 回收站同款手感）
  await page.getByTestId("scene-purge-confirm").fill("履约回归");
  await ok.click();
  await expect(rowA).toHaveCount(0);
  const gone = await asUser(token, "get",
    "scenarios/" + gen.id + "?project_id=" + projectId); // 另一个场景还在
  expect(gone.status).toBe(200);
  const purged = await asUser(token, "get", "scenarios?project_id=" + projectId + "&recycled=true");
  expect(purged.body.items.find((s) => s.name === "履约回归")).toBeFalsy();

  // 6) 1F T6 哨兵翻真：「让 Pilot 生成」此前点开只说明（Modal.info「1F 开放」），
  //    1F 落地后是真入口——点了真跳 /bench。入口与断言同批改（导航诚实条款）。
  await page.getByTestId("module-recycled-toggle").click(); // 退出回收站；新建入口只在正常视图有
  await page.getByTestId("scene-new").click();
  await page.getByRole("menuitem", { name: /让 Pilot 生成/ }).click();
  await expect(page).toHaveURL(/#\/bench/);
  await expect(page.getByTestId("bench")).toBeVisible();
});
